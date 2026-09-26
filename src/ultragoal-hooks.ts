// Ultragoal host adapter: the side-effecting half of `src/ultragoal.ts`,
// called from the shared hooks in `src/hooks.ts` (one continuation engine, one
// prompt hook, one `execute.before`). Every ultragoal state change here runs in
// `StateStore.ultragoalTransaction`; host calls run after it (plan §3.5).
//
// Source: oh-my-claudecode v5.4.0 (MIT) — `scripts/persistent-mode.mjs` ralph
// branch (iteration, extension, hard max), `keyword-detector.mjs` activation,
// `bridge.ts` confirmSkillModeStates and session restore. Reviewer integration
// references oh-my-openagent d1557a4b48fdbec06a7144fdc4afa3e65c6523ed
// (Sustainable Use License), modified for open-gajae. The reviewer-brief append
// is a local adapter; see THIRD-PARTY-NOTICES.md and licenses/OMO-SUL.txt.

import { randomUUID } from "node:crypto";
import { RALPLAN_MODE, ULTRAGOAL_MODE, type StateStore } from "./state.js";
import {
  compactionContext,
  continuationMessage,
  decideUltragoal,
  derivePhase,
  extendedMessage,
  goalRequest,
  hardLimitMessage,
  isRequestCurrent,
  isUltragoalRunning,
  mergeState,
  parseGoals,
  pauseMessage,
  requestOf,
  restoreMessage,
  seedUltragoalState,
  type UltragoalStateSnapshot,
  verificationBrief,
} from "./ultragoal.js";

/** The `ctx.session.synthetic` slice these hooks use. */
type Synthetic = (input: {
  sessionID: string;
  text: string;
  description?: string;
  resume: boolean;
}) => Promise<unknown>;

export type Notice = { text: string; description: string };

/** The fields of the host's `compaction` session hook read or written here. */
export type CompactionEvent = {
  readonly sessionID: string;
  system: Array<{ type: "text"; text: string }>;
};

const REVIEWERS = new Set(["open-gajae-architect", "open-gajae-critic"]);

function log(message: string, error?: unknown) {
  if (error === undefined) console.warn(`[open-gajae:ultragoal] ${message}`);
  else console.warn(`[open-gajae:ultragoal] ${message}:`, error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createUltragoalHooks(
  store: StateStore,
  synthetic: Synthetic,
  { hardMax }: { hardMax: number },
) {
  /**
   * Any store error reads as "no ultragoal": the file is preserved, never
   * rewritten, and ultragoal is inert everywhere (continuation, chain guard,
   * Q-2) until it is readable again, as ralplan treats its own corrupt state.
   */
  async function read(sessionID: string): Promise<UltragoalStateSnapshot> {
    try {
      return await store.read(sessionID, ULTRAGOAL_MODE);
    } catch (error) {
      log("ultragoal state unreadable; treating session as inactive", error);
      return undefined;
    }
  }

  /** Plan §5.5: a real user prompt lifts a pause and its counters. */
  async function releasePause(sessionID: string): Promise<void> {
    await store.ultragoalTransaction(sessionID, async (tx) => {
      const state = await tx.readState();
      if (!state || (typeof state.paused_reason !== "string" && !state.tool_less_turns))
        return;
      const counts = isRecord(state.reject_counts) ? { ...state.reject_counts } : {};
      if (typeof state.paused_target === "string") delete counts[state.paused_target];
      await tx.writeState(
        mergeState(state, {
          paused_reason: undefined,
          paused_target: undefined,
          tool_less_turns: 0,
          reject_counts: Object.keys(counts).length ? counts : undefined,
        }),
        "ultragoal_hook",
      );
    });
  }

  /** Stale awaiting seed, cleared on a turn that did not ask for ultragoal. */
  async function clearStaleSeed(sessionID: string): Promise<void> {
    await store.ultragoalTransaction(sessionID, async (tx) => {
      const state = await tx.readState();
      if (state?.active === true && state.awaiting_confirmation === true)
        await tx.deleteState();
    });
  }

  /** Restore, once per resume (`src/hooks.ts` ralplan rule). */
  async function restore(
    sessionID: string,
    state: UltragoalStateSnapshot,
  ): Promise<Notice | undefined> {
    if (state?.active !== true || typeof state.started_at !== "string") return;
    const restoredAt = state.restored_at;
    if (typeof restoredAt === "string" && restoredAt >= state.started_at) return;
    // Re-read inside the transaction: a `cancel` in between must not leave a
    // stub state holding only `restored_at`.
    const stamped = await store.ultragoalTransaction(sessionID, async (tx) => {
      const current = await tx.readState();
      if (current?.active !== true || current.started_at !== state.started_at)
        return false;
      await tx.writeState(
        mergeState(current, { restored_at: new Date().toISOString() }),
        "ultragoal_hook",
      );
      return true;
    });
    if (!stamped) return;
    return {
      text: restoreMessage(state),
      description: "open-gajae: ultragoal restore notice added",
    };
  }

  /**
   * Seed (plan §6.4): a whole new state unless one is already active; an
   * awaiting seed is confirmed when `awaiting` is false.
   */
  async function seed(
    sessionID: string,
    { awaiting, task }: { awaiting: boolean; task?: string },
  ): Promise<void> {
    await store.ultragoalTransaction(sessionID, async (tx) => {
      const state = await tx.readState();
      if (state?.active === true) {
        if (!awaiting && state.awaiting_confirmation === true)
          await tx.writeState(
            mergeState(state, { awaiting_confirmation: false }),
            "ultragoal_hook",
          );
        return;
      }
      await tx.writeState(
        seedUltragoalState(state, new Date().toISOString(), { awaiting, task })!,
        "ultragoal_hook",
      );
    });
  }

  /**
   * `skill` id `ultragoal` loaded by the primary (plan §6.5, Architect D1): it
   * confirms an awaiting seed, or seeds from ralplan's `Execute via ultragoal`
   * handoff and consumes that handoff. Nothing else seeds, so a gated turn
   * cannot be bypassed by loading the skill.
   */
  async function onSkillLoad(sessionID: string): Promise<void> {
    const ralplan = await store.read(sessionID, RALPLAN_MODE).catch(() => undefined);
    const fromHandoff =
      ralplan?.active !== true && ralplan?.current_phase === "handoff";
    const seeded = await store.ultragoalTransaction(sessionID, async (tx) => {
      const state = await tx.readState();
      if (state?.active === true) {
        if (state.awaiting_confirmation === true)
          await tx.writeState(
            mergeState(state, { awaiting_confirmation: false }),
            "ultragoal_hook",
          );
        return false;
      }
      if (!fromHandoff) return false;
      await tx.writeState(
        seedUltragoalState(state, new Date().toISOString(), { awaiting: false })!,
        "ultragoal_hook",
      );
      return true;
    });
    if (seeded)
      await store.patch(sessionID, { current_phase: "handoff-consumed" }, RALPLAN_MODE);
  }

  /**
   * Plan §5.7: append the plugin's brief to the reviewer `subagent` call the
   * pending request names. The request is not changed; its ID is reused.
   */
  async function attachBrief(event: {
    tool: string;
    sessionID: string;
    input: unknown;
  }): Promise<void> {
    if (event.tool !== "subagent" || !isRecord(event.input)) return;
    const input = event.input;
    if (typeof input.agent !== "string" || !REVIEWERS.has(input.agent)) return;
    if (typeof input.prompt !== "string") return;
    const brief = await store.ultragoalTransaction(event.sessionID, async (tx) => {
      const state = await tx.readState();
      const request = requestOf(state);
      if (!isUltragoalRunning(state) || !request || request.reviewer !== input.agent)
        return undefined;
      const goals = parseGoals(await tx.readFile("goals.json"));
      if (goals.kind !== "valid" || !isRequestCurrent(request, goals.file)) return undefined;
      return verificationBrief({
        request,
        file: goals.file,
        progress: await tx.readFile("progress.txt"),
        state,
      });
    });
    if (brief !== undefined) input.prompt = `${input.prompt}\n\n${brief}`;
  }

  /**
   * Plan §5.1: decide and patch in the transaction, inject after it. Returns
   * whether ultragoal handled this turn (the ralplan path then does not run).
   */
  async function continueLoop(
    sessionID: string,
    toolCalls: number | undefined,
  ): Promise<boolean> {
    let action:
      | { text: string; description: string; resume: boolean }
      | undefined;
    try {
      action = await store.ultragoalTransaction(sessionID, async (tx) => {
        let state: UltragoalStateSnapshot;
        try {
          state = await tx.readState();
        } catch (error) {
          log("ultragoal state unreadable; treating session as inactive", error);
          return undefined;
        }
        const decision = decideUltragoal(state, {
          toolCalls,
          hardMax,
          countToolLess: true,
        });
        switch (decision.kind) {
          case "skip":
            return undefined;
          case "pause":
            await tx.writeState(
              mergeState(state!, {
                paused_reason: decision.reason,
                paused_target: decision.target,
                tool_less_turns: decision.toolLessTurns,
              }),
              "ultragoal_hook",
            );
            return {
              text: pauseMessage(decision.reason, decision.target),
              description: `open-gajae: ultragoal paused (${decision.reason})`,
              resume: false,
            };
          case "hard_limit":
            await tx.writeState(
              mergeState(state!, { active: false, deactivated_reason: "hard_limit" }),
              "ultragoal_hook",
            );
            return {
              text: hardLimitMessage(decision.hardMax),
              description: `open-gajae: ultragoal hard limit reached (${decision.hardMax})`,
              resume: true,
            };
          case "extend":
            await tx.writeState(
              mergeState(state!, {
                max_iterations: decision.max,
                tool_less_turns: decision.toolLessTurns,
              }),
              "ultragoal_hook",
            );
            return {
              text: extendedMessage(decision.max),
              description: `open-gajae: ultragoal loop extended to ${decision.max}`,
              resume: true,
            };
          case "continue": {
            const goals = parseGoals(await tx.readFile("goals.json"));
            const phase = derivePhase(state, goals);
            const pending = requestOf(state);
            const at = new Date().toISOString();
            // Self-healing (plan §5.2): drop a request the file no longer
            // matches, and create the one a completed goal is missing.
            let request = pending;
            if (
              pending &&
              (goals.kind !== "valid" || !isRequestCurrent(pending, goals.file))
            )
              request = undefined;
            if (phase.kind === "verify_goal" && !phase.request)
              request = goalRequest(phase.goal, state, at, randomUUID());
            const next = mergeState(state!, {
              iteration: decision.iteration,
              tool_less_turns: decision.toolLessTurns,
              verification_request: request,
            });
            await tx.writeState(next, "ultragoal_hook");
            const progress = await tx.readFile("progress.txt");
            return {
              text: continuationMessage({
                iteration: decision.iteration,
                max: decision.max,
                phase:
                  phase.kind === "verify_goal" && request
                    ? { ...phase, request: request as typeof phase.request }
                    : phase,
                state: next,
                file: goals.kind === "valid" ? goals.file : undefined,
                paths: { goals: tx.paths.goalsPath, progress: tx.paths.progressPath },
                progress,
              }),
              description: `open-gajae: ultragoal continuation ${decision.iteration}/${decision.max}`,
              resume: true,
            };
          }
        }
      });
    } catch (error) {
      log("ultragoal continuation failed", error);
      return false;
    }
    if (!action) return false;
    try {
      await synthetic({
        sessionID,
        text: action.text,
        description: action.description,
        resume: action.resume,
      });
    } catch (error) {
      log("ultragoal synthetic failed", error);
    }
    return true;
  }

  /** Plan §7: the running loop's context rides along with a compaction. */
  async function compaction(event: CompactionEvent): Promise<void> {
    try {
      const text = await store.ultragoalTransaction(event.sessionID, async (tx) => {
        const state = await tx.readState();
        if (!isUltragoalRunning(state)) return undefined;
        const goals = parseGoals(await tx.readFile("goals.json"));
        return compactionContext({
          state,
          phase: derivePhase(state, goals),
          file: goals.kind === "valid" ? goals.file : undefined,
          paths: { goals: tx.paths.goalsPath, progress: tx.paths.progressPath },
          progress: await tx.readFile("progress.txt"),
        });
      });
      if (text !== undefined) event.system.push({ type: "text", text });
    } catch (error) {
      log("compaction hook failed", error);
    }
  }

  return {
    read,
    releasePause,
    clearStaleSeed,
    restore,
    seed,
    onSkillLoad,
    attachBrief,
    continueLoop,
    compaction,
  };
}

export type UltragoalHooks = ReturnType<typeof createUltragoalHooks>;
