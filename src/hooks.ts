// Ralplan host hooks: continuation on idle, keyword/restore on chat.message,
// the `skill` tool call that replaces OMC's awaiting-confirmation timer, and the
// `/ralplan` command hook that seeds the state the keyword guard no longer does.
//
// The idle continuation carries two layers of user-interrupt detection that OMC
// has no counterpart for, because Claude Code does not run its Stop hook on an
// interrupt while OpenCode still publishes `session.idle`. See `ABORT_WINDOW_MS`
// and `lastAssistantAborted`.
//
// Source: oh-my-claudecode v5.4.0 (MIT) — `persistent-mode/index.ts` checkRalplan,
// `bridge.ts` session restore, keyword seeding and confirmSkillModeStates — and
// oh-my-openagent (MIT) for the OpenCode-side in-flight and injection patterns.

import type { Hooks } from "@opencode-ai/plugin";
import {
  applyRalplanGate,
  breakerMessage,
  continuationMessage,
  detectRalplanKeyword,
  gateMessage,
  INJECTION_MARKERS,
  keywordMessage,
  RALPLAN_SKILL_NAME,
  restoreMessage,
  sanitizeForKeywordDetection,
  seedState,
  shouldContinue,
} from "./ralplan.js";
import { RALPLAN_MODE, type StateStore } from "./state.js";

/**
 * The client surface these hooks use, declared structurally so a fake in a test
 * satisfies it. The host's `ctx.client` satisfies it too.
 */
export type RalplanClient = {
  session: {
    messages(input: { path: { id: string } }): Promise<unknown>;
    promptAsync(input: {
      path: { id: string };
      body: {
        agent?: string;
        model?: { providerID: string; modelID: string };
        parts: Array<{ type: "text"; text: string; synthetic?: boolean }>;
      };
    }): Promise<unknown>;
  };
};

/** The host's `Part` union, taken from the hook signature so the SDK stays an
 * indirect dependency. */
type ChatMessagePart = Parameters<
  NonNullable<Hooks["chat.message"]>
>[1]["parts"][number];

export type RalplanHooks = Required<
  Pick<
    Hooks,
    "event" | "chat.message" | "tool.execute.before" | "command.execute.before"
  >
>;

/**
 * G1's deny-list. These three are the read-only ralplan role subagents from
 * `src/config.ts`; a `task` turn arrives carrying the child's agent name, and
 * these roles have `state_write` denied, so seeding state into their sessions
 * would create a file they could never clear. Every other value — including
 * `undefined` — proceeds, because `agent` is optional on the hook input and the
 * host has more than one primary.
 */
const ROLE_SUBAGENTS = new Set([
  "open-gajae-planner",
  "open-gajae-architect",
  "open-gajae-critic",
]);

const KEYWORD_NOTICE_MARKER = "[MODE: RALPLAN]";

/**
 * One continuation in flight per session. `session.idle` can arrive again while
 * the injected prompt is still being posted; without this the plugin would
 * stack reinforcements. Pattern from oh-my-openagent's ralph-loop event handler.
 */
const inFlight = new Set<string>();

/**
 * How long after a `session.error` carrying `MessageAbortedError` an arriving
 * `session.idle` is still attributed to that user interrupt rather than to a
 * stalled model. Value from oh-my-openagent
 * `packages/omo-opencode/src/hooks/todo-continuation-enforcer/constants.ts:20`
 * (`ABORT_WINDOW_MS = 3000`), where it guards the same event-then-idle race.
 */
const ABORT_WINDOW_MS = 3000;

function log(message: string, error?: unknown) {
  if (error === undefined) console.warn(`[open-gajae:ralplan] ${message}`);
  else console.warn(`[open-gajae:ralplan] ${message}:`, error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The SDK's `"fields"` response style returns `{ data, error, request, response }`;
 * a fake may return the bare array. Accept both, and anything else as empty.
 */
function normalizeMessages(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isRecord(raw) && Array.isArray(raw.data)) return raw.data;
  return [];
}

/**
 * Abort detection, layer 2: the last assistant turn carries the interrupt on
 * `info.error`. OpenCode's `session/processor.ts` `halt(AbortError)` records
 * `MessageAbortedError` there when the user presses Esc; `AbortError` is the
 * other shape the host can leave behind. Port of oh-my-openagent
 * `todo-continuation-enforcer/abort-detection.ts` `isLastAssistantMessageAborted`.
 */
function lastAssistantAborted(messages: unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    const info = isRecord(entry) ? entry.info : undefined;
    if (!isRecord(info) || info.role !== "assistant") continue;
    const error = info.error;
    const name = isRecord(error) ? error.name : undefined;
    return name === "MessageAbortedError" || name === "AbortError";
  }
  return false;
}

export function createHooks(
  store: StateStore,
  client: RalplanClient,
): RalplanHooks {
  /**
   * Where a continuation would be posted: the agent and model inherited from the
   * last real user message. `undefined` means "do not inject at all", and is the
   * single answer for every reason not to — the messages call failed, the last
   * assistant turn was aborted, or there is no user message to inherit from.
   *
   * This runs before any breaker write, so the breaker only advances when an
   * injection is actually attempted. Never throws.
   */
  async function resolveTarget(
    sessionID: string,
  ): Promise<
    | { agent?: string; model?: { providerID: string; modelID: string } }
    | undefined
  > {
    let raw: unknown;
    try {
      raw = await client.session.messages({ path: { id: sessionID } });
    } catch (error) {
      log("could not list session messages; skipping injection", error);
      return undefined;
    }

    const messages = normalizeMessages(raw);

    if (lastAssistantAborted(messages)) {
      log("last assistant turn was aborted; skipping continuation");
      return undefined;
    }

    let agent: string | undefined;
    let model: { providerID: string; modelID: string } | undefined;
    let found = false;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index];
      const info = isRecord(entry) ? entry.info : undefined;
      if (!isRecord(info) || info.role !== "user") continue;
      found = true;
      if (typeof info.agent === "string" && info.agent.length > 0)
        agent = info.agent;
      const candidate = info.model;
      if (
        isRecord(candidate) &&
        typeof candidate.providerID === "string" &&
        typeof candidate.modelID === "string"
      )
        model = {
          providerID: candidate.providerID,
          modelID: candidate.modelID,
        };
      break;
    }
    // Without a user message there is no agent to inherit, and omitting `agent`
    // would silently switch the session to the default agent.
    if (!found) {
      log("no user message in session; skipping injection");
      return undefined;
    }

    return { agent, model };
  }

  /**
   * Post `text` into the session as a synthetic user prompt. Never throws.
   */
  async function inject(
    sessionID: string,
    text: string,
    target: {
      agent?: string;
      model?: { providerID: string; modelID: string };
    },
  ): Promise<void> {
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: {
          ...(target.agent ? { agent: target.agent } : {}),
          ...(target.model ? { model: target.model } : {}),
          parts: [{ type: "text", text, synthetic: true }],
        },
      });
    } catch (error) {
      // No retry: the breaker count stays incremented, so the next idle retries.
      log("continuation prompt failed", error);
    }
  }

  /**
   * Read ralplan state, treating any store error as "no active ralplan".
   * The store preserves a corrupt or foreign state file; this never deletes or
   * rewrites one, it just goes inert for the turn.
   */
  async function readState(
    sessionID: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      return await store.read(sessionID, RALPLAN_MODE);
    } catch (error) {
      log("ralplan state unreadable; treating session as inactive", error);
      return undefined;
    }
  }

  /**
   * The port of OMC's PreToolUse `Skill` branch (`confirmSkillModeStates`):
   * clear `awaiting_confirmation` once the host observes the skill being loaded.
   */
  async function confirmRalplan(sessionID: string): Promise<void> {
    try {
      const state = await readState(sessionID);
      if (!state || state.awaiting_confirmation !== true) return;
      await store.patch(
        sessionID,
        { awaiting_confirmation: false },
        RALPLAN_MODE,
      );
    } catch (error) {
      log("could not confirm ralplan skill load", error);
    }
  }

  /**
   * Abort detection, layer 1. When the user presses Esc, OpenCode's
   * `session/processor.ts` halts the turn, publishes `session.error` with a
   * `MessageAbortedError`, and only then goes idle. Claude Code never runs OMC's
   * Stop hook on an interrupt, so OMC has no equivalent; this is the
   * oh-my-openagent pattern (`ralph-loop/event-handler-impl.ts` `session.error`
   * plus `isAbortError`). The mark is consumed by the next idle, whatever that
   * idle decides, so a non-ralplan session cannot leave an entry behind.
   */
  const abortedAt = new Map<string, number>();

  /**
   * Sessions whose `/ralplan` command hook has just seeded, awaiting the
   * `chat.message` of that same turn. The expanded command template is quiet
   * under the keyword guard, so without this mark step 2 would read the seed
   * the command hook wrote microseconds earlier as a stale one and clear it,
   * undoing the only seeding path `/ralplan` has left. Step 2 means "a seed a
   * previous turn left unacted on"; a seed from this turn is not that. The mark
   * is consumed by the next `chat.message`, whatever that message decides, so a
   * command turn that never produces one cannot leave an entry behind.
   */
  const commandSeeded = new Set<string>();

  const event: RalplanHooks["event"] = async ({ event }) => {
    if (event.type === "session.error") {
      const sessionID = event.properties.sessionID;
      if (typeof sessionID !== "string" || sessionID.length === 0) return;
      const error: unknown = event.properties.error;
      if (isRecord(error) && error.name === "MessageAbortedError") {
        abortedAt.set(sessionID, Date.now());
        log(`recorded user interrupt for ${sessionID}`);
      }
      return;
    }

    if (event.type !== "session.idle") return;
    const sessionID = event.properties.sessionID;
    if (typeof sessionID !== "string" || sessionID.length === 0) return;

    if (inFlight.has(sessionID)) {
      log(`continuation already in flight for ${sessionID}`);
      return;
    }
    inFlight.add(sessionID);
    try {
      // A subagent runs in its own session with its own directory, so this read
      // returns undefined and the decision is `skip` at the first clause.
      const state = await readState(sessionID);

      // Layer 1, ahead of every state write: an idle the user caused must
      // neither inject nor advance the breaker. The ralplan state is left
      // `active`, so the next real user turn resumes continuation normally.
      const interruptedAt = abortedAt.get(sessionID);
      if (interruptedAt !== undefined) {
        abortedAt.delete(sessionID);
        if (Date.now() - interruptedAt < ABORT_WINDOW_MS) {
          log("user interrupt; skipping continuation");
          return;
        }
      }

      const decision = shouldContinue(state, Date.now());

      if (decision.kind === "skip") {
        if (decision.resetBreaker)
          await store.patch(sessionID, { breaker_count: 0 }, RALPLAN_MODE);
        return;
      }

      // Layer 2, and the agent/model lookup, both before the breaker write.
      const target = await resolveTarget(sessionID);
      if (!target) return;

      if (decision.kind === "breaker") {
        await store.patch(
          sessionID,
          {
            active: false,
            breaker_count: 0,
            deactivated_reason: "stop_breaker_exhausted",
            completed_at: new Date().toISOString(),
          },
          RALPLAN_MODE,
        );
        await inject(sessionID, breakerMessage(), target);
        return;
      }

      await store.patch(
        sessionID,
        {
          breaker_count: decision.count,
          breaker_updated_at: new Date().toISOString(),
        },
        RALPLAN_MODE,
      );
      await inject(sessionID, continuationMessage(decision.count), target);
    } catch (error) {
      log("session.idle handler failed", error);
    } finally {
      inFlight.delete(sessionID);
    }
  };

  const chatMessage: RalplanHooks["chat.message"] = async (input, output) => {
    try {
      // G1 — role-subagent deny-list. `undefined` proceeds.
      if (typeof input.agent === "string" && ROLE_SUBAGENTS.has(input.agent))
        return;

      const texts: string[] = [];
      for (const part of output.parts) {
        if (part.type !== "text") continue;
        texts.push(typeof part.text === "string" ? part.text : "");
      }

      // G2 — this plugin's own injected prompts re-enter here, and the
      // continuation text contains the word "ralplan". Matching on the marker
      // tags also ignores a message a user hand-pastes from an earlier turn.
      for (const text of texts) {
        if (INJECTION_MARKERS.some((marker) => text.includes(marker))) {
          log("ignoring plugin-injected message");
          return;
        }
      }

      const text = texts.join("\n");
      const sessionID = input.sessionID;
      // OMC's guard, computed once and used by both step 2 and step 4: a mention,
      // a question, a quoted example or a pasted skill body is not an invocation.
      const cleaned = sanitizeForKeywordDetection(text);
      const detected = detectRalplanKeyword(text) !== null ? ["ralplan"] : [];
      let state = await readState(sessionID);
      const appended: string[] = [];

      // Step 2 — stale-seed cleanup, the sole replacement for the deleted TTL.
      // A keyword the model never acted on cannot leave a permanently
      // active-but-silent state. Clearing here, before the restore check, also
      // means such a seed can never raise a restore banner on a later turn.
      const seededThisTurn = commandSeeded.delete(sessionID);
      if (
        state?.active === true &&
        state.awaiting_confirmation === true &&
        detected.length === 0 &&
        !seededThisTurn
      ) {
        try {
          await store.clear(sessionID, RALPLAN_MODE);
        } catch (error) {
          log("could not clear stale ralplan seed", error);
        }
        state = undefined;
      }

      // Step 3 — restore, once per resume. The `started_at`-present clause is
      // load-bearing: a state re-created after step 2 cleared a stale seed must
      // not read as a resume.
      if (state?.active === true && typeof state.started_at === "string") {
        const restoredAt = state.restored_at;
        const isResume =
          typeof restoredAt !== "string" || restoredAt < state.started_at;
        if (isResume) {
          appended.push(restoreMessage(state));
          await store.patch(
            sessionID,
            { restored_at: new Date().toISOString() },
            RALPLAN_MODE,
          );
        }
      }

      // Step 4 — keyword.
      if (detected.length > 0 && !text.includes(KEYWORD_NOTICE_MARKER)) {
        appended.push(keywordMessage());
        const patch = seedState(state, new Date().toISOString());
        if (patch) await store.patch(sessionID, patch, RALPLAN_MODE);
        else log("ralplan state already active; skipped re-seed");
      }

      // Step 5 — gate. Dormant while EXECUTION_GATE_KEYWORDS is empty; the call
      // site stays so enabling it is a one-line change.
      const gate = applyRalplanGate(detected, cleaned);
      if (gate.gateApplied) appended.push(gateMessage(gate.gatedKeywords));

      if (appended.length === 0) return;
      const messageID = input.messageID ?? output.message.id;
      for (const appendedText of appended) {
        const part: ChatMessagePart = {
          id: `prt_${crypto.randomUUID()}`,
          sessionID,
          messageID,
          type: "text",
          text: appendedText,
          synthetic: true,
        };
        output.parts.push(part);
      }
    } catch (error) {
      log("chat.message handler failed", error);
    }
  };

  const toolExecuteBefore: RalplanHooks["tool.execute.before"] = async (
    input,
    output,
  ) => {
    try {
      if (input.tool !== "skill") return;
      const name: unknown = output.args?.name;
      if (typeof name !== "string" || name !== RALPLAN_SKILL_NAME) return;
      await confirmRalplan(input.sessionID);
    } catch (error) {
      log("tool.execute.before handler failed", error);
    }
  };

  // The explicit-slash seeding path, and the only one left for `/ralplan`: the
  // command expands to a template whose only `ralplan` sits inside backticks, so
  // the `chat.message` guard reads it as quiet and never seeds. This mirrors
  // OMC's `[RALPLAN INIT]` branch (`bridge.ts:1539-1550`,
  // `seedRalplanStartupState`), which seeds off the raw slash invocation rather
  // than off keyword detection. It never clears: `tool.execute.before` with
  // `skill(name="ralplan")` is the sole confirmation path.
  const commandExecuteBefore: RalplanHooks["command.execute.before"] = async (
    input,
  ) => {
    try {
      if (input.command !== RALPLAN_SKILL_NAME) return;
      const sessionID = input.sessionID;
      // Set before the read, so the mark is in place even if the write below
      // throws on a corrupt state file: the template message that follows must
      // never be the thing that clears an awaiting seed.
      commandSeeded.add(sessionID);
      const state = await readState(sessionID);
      // `seedState` returns undefined for an already-active state, so an
      // in-progress session is left exactly as it was.
      const patch = seedState(state, new Date().toISOString());
      if (patch) await store.patch(sessionID, patch, RALPLAN_MODE);
      else log("ralplan state already active; /ralplan skipped re-seed");
    } catch (error) {
      log("command.execute.before handler failed", error);
    }
  };

  return {
    event,
    "chat.message": chatMessage,
    "tool.execute.before": toolExecuteBefore,
    "command.execute.before": commandExecuteBefore,
  };
}
