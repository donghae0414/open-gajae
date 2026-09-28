// Ralplan host hooks: continuation on durable execution events, keyword/mention
// notices on the v2 `prompt` hook, the mutation guards and the ultragoal entry
// gate on `execute.before`, and the compaction recovery context. Ultragoal
// shares this one engine and these hooks through `src/ultragoal-hooks.ts`, one
// mode at a time (plan §5). The prompt hook also carries the deep-interview
// keyword and `@deep-interview` mention, which only inject OMC's magic-keyword
// guide and seed no state at all.
//
// Plan S3 (gajae-code 5c5231418930673e42cc5d08ebe4376e03187533, MIT): the
// ralplan keyword and mention only add a notice (D-F13, R-O6) and the OMC
// restore notice is gone (R-O11); `execute.before` blocks the runtime-owned
// paths for everyone and, while a ralplan run plans, every mutation outside a
// neutral temp path (`skill-state/workflow-mutation-guard.ts:22-27,264-351,
// 1767-1866`; deviations 11, 23, 28), and runs the ultragoal entry gate for
// `skill ultragoal` and the `@ultragoal` mention (C-4; `tools/skill.ts:
// 192-220`, deviation 29); continuation keeps OMC's loop over the gjc terminal
// set with a hook-only counter file (deviations 10, 26); compaction adds the
// gjc recovery contract (`session/agent-session.ts:667-710`, deviation 20).
//
// Notices are `session.synthetic({ resume: false })` messages. The host places
// them before the user message of the same turn, while OMC and v1 appended after
// it (Phase 0 P7); this is a recorded deviation. If `synthetic` rejects, the
// marker-wrapped notice is appended to the prompt text instead (Q3). Every
// synthetic message (notice or continuation) carries a one-line `description`:
// the TUI hides a synthetic message without one (`tui/src/routes/session/
// rows.ts:314`), and the user must see that the plugin inserted it.
//
// Continuation runs on `session.execution.succeeded`, OMC's Stop-hook point. A
// user interrupt is its own `interrupted` event in v2, so v1's abort window and
// transcript sniffing are gone; the mark it sets lasts until the next real user
// prompt, because a host subagent-completion resume can still end in a later
// `succeeded` (Phase 0 Q9).
//
// Source: oh-my-claudecode v5.4.0 (MIT) — `persistent-mode/index.ts` checkRalplan,
// `bridge.ts` session restore, keyword seeding and confirmSkillModeStates (for
// ultragoal only since plan S3) — and
// oh-my-openagent d1557a4b48fdbec06a7144fdc4afa3e65c6523ed (Sustainable Use
// License) for OpenCode-side in-flight, lineage and injection patterns, modified
// for open-gajae. See THIRD-PARTY-NOTICES.md and licenses/OMO-SUL.txt.

import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import {
  ARTIFACT_TOOLS,
  artifactPathsOf,
  isRalplanOwned,
  isSessionState,
  isUltragoalOwned,
  projectPrefix,
  projectRelative,
  sessionArtifactOwner,
} from "./artifact-guard.js";
import {
  breakerMessage,
  compactionMessage,
  continuationMessage,
  DEEP_INTERVIEW_SKILL_NAME,
  deepInterviewMessage,
  detectDeepInterviewKeyword,
  detectRalplanKeyword,
  INJECTION_MARKERS,
  keywordMessage,
  mentionMessage,
  RALPLAN_SKILL_NAME,
  RALPLAN_STOP_BLOCKER_MAX,
  type RalplanBreaker,
  shouldContinue,
  detectUltragoalKeyword,
  ULTRAGOAL_SKILL_NAME,
} from "./ralplan.js";
import { RALPLAN_INDEX_FILE } from "./ralplan-runtime/ledger.js";
import { GUARD_RELEASE_PHASES, isKnownPhase } from "./ralplan-runtime/manifest.js";
import {
  projectRalplanRun,
  ralplanRecoveryRunFromState,
  renderRalplanRecoveryContext,
} from "./ralplan-runtime/recovery.js";
import {
  HOOK_OWNER,
  patchStateTx,
  ultragoalEntryGate,
} from "./ralplan-runtime/store.js";
import { isNeutralTempPath } from "./ralplan-runtime/temp-paths.js";
import { RALPLAN_MODE, type RalplanTx, type StateStore } from "./state.js";
import {
  CHAIN_GUARD_REFUSAL,
  isRalplanRunning,
  isUltragoalRunning,
  keywordMessage as ultragoalKeywordMessage,
  mentionMessage as ultragoalMentionMessage,
  ralplanMentionNotice,
  ralplanRunningNotice,
} from "./ultragoal.js";
import {
  type CompactionEvent,
  createUltragoalHooks,
} from "./ultragoal-hooks.js";

/**
 * The `ctx.session` slice these hooks use, declared structurally so a fake in a
 * test satisfies it. The host's `ctx.session` satisfies it too.
 */
export type HostSession = {
  get(input: { sessionID: string }): Promise<{
    agent?: string;
    parentID?: string;
    location?: { directory: string };
  }>;
  synthetic(input: {
    sessionID: string;
    text: string;
    /** One visible TUI line; the TUI hides a synthetic message without one. */
    description?: string;
    resume: boolean;
  }): Promise<unknown>;
};

/** A synthetic notice and the one line the TUI shows for it. */
type Notice = { text: string; description: string };

/** The fields of the host's `prompt` hook event these hooks read or write. */
export type PromptEvent = {
  readonly sessionID: string;
  prompt: { text: string; skills?: ReadonlyArray<{ readonly id: string }> };
};

/** The fields of the host's `execute.before` tool hook event read here. */
export type ExecuteBeforeEvent = {
  readonly tool: string;
  readonly sessionID: string;
  readonly agent?: string;
  readonly id: string;
  input: unknown;
};

/**
 * The fields of the host's `execute.after` tool hook event read or written
 * here. On `status: "error"` the hook replaces `error` with a new `Tool.Error`
 * (Phase 0 P8: assigning a new error is the one mechanism that changes the
 * model-visible text of both a decode failure and a permission block).
 */
export type ExecuteAfterEvent = {
  readonly tool: string;
  readonly sessionID: string;
  readonly agent: string;
  readonly id: string;
  readonly status: string;
  error?: unknown;
};

export type RalplanHooks = {
  /** Fail-closed parent lookup, shared with the `ultragoal` tool (plan §2 A1″). */
  parentSession(sessionID: string): Promise<string | undefined>;
  /** Fail-closed lineage root, shared with the `ralplan` tool (plan DR-1). */
  rootSession(sessionID: string): Promise<string>;
  prompt(event: PromptEvent): Promise<void>;
  /**
   * The `compaction` session hook: ultragoal context while it runs (plan §7),
   * then the active ralplan run's recovery contract (plan D-H2/AC19).
   */
  compaction(event: CompactionEvent): Promise<void>;
  executeBefore(event: ExecuteBeforeEvent): Promise<void>;
  executeAfter(event: ExecuteAfterEvent): Promise<void>;
  /** One event from `ctx.event.subscribe`: an envelope `{ type, data }`. */
  onEvent(event: unknown): Promise<void>;
};

/**
 * G1's deny-list. These three are the read-only ralplan role subagents from
 * `src/config.ts`; a `subagent` turn runs in a child session carrying the
 * child's agent, and these roles have `state_write` denied, so seeding state
 * into their sessions would create a file they could never clear. Every other
 * value — including `undefined` or a failed lookup — proceeds.
 */
const ROLE_SUBAGENTS = new Set([
  "open-gajae-planner",
  "open-gajae-architect",
  "open-gajae-critic",
  "open-gajae-executor",
  "open-gajae-cleaner",
]);

/**
 * Interrupt reasons that mean "stop" (Q9): `user` is Esc or the interrupt API,
 * and `shutdown` is a dismissed `question` form and the host default for a
 * reason-less interrupt (`core/src/session/execution.ts:53`).
 */
const STOP_REASONS = new Set(["user", "shutdown"]);

/**
 * gajae-code 5c52314 `skill-state/workflow-mutation-guard.ts:24-25`
 * (`WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE` + `Use:` line) with the host's
 * runtime-owned paths and tools substituted (plan S3, AC18).
 */
const WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE =
  ".open-gajae workflow state and ralplan artifacts are runtime-owned. Agent mutation tools cannot edit `.open-gajae/_session-*/state/**` or `.open-gajae/_session-*/plans/ralplan/**`; use the sanctioned tool instead.\nUse: `ralplan` for ralplan state and plans, `state_write`/`state_clear` for deep-interview state.";

/**
 * gajae-code 5c52314 `skill-state/workflow-mutation-guard.ts:26-27`
 * (`RALPLAN_MUTATION_BLOCK_MESSAGE`), `gjc ralplan --write` → `ralplan write`,
 * plus the recovery line for a stale or accidental run (plan R-AE1).
 */
const RALPLAN_MUTATION_BLOCK_MESSAGE =
  'Ralplan planning phase boundary: keep refining the consensus plan and persist plan artifacts through `ralplan write` (stage scratch files under a temp dir if needed). Product-code mutation tools and patch execution are blocked while ralplan is active; mutate only after the plan is approved and execution begins.\nIf this ralplan run is stale or was started by mistake, stop it with `ralplan state` {"active": false} or `ralplan clear`.';

const KEYWORD_NOTICE_MARKER = "[MODE: RALPLAN]";
const ULTRAGOAL_NOTICE_MARKER = "[MODE: ULTRAGOAL]";
const DEEP_INTERVIEW_MAGIC_MARKER = "[MAGIC KEYWORD: DEEP-INTERVIEW]";

function log(message: string, error?: unknown) {
  if (error === undefined) console.warn(`[open-gajae:ralplan] ${message}`);
  else console.warn(`[open-gajae:ralplan] ${message}:`, error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createHooks(
  store: StateStore,
  session: HostSession,
  packageRoot: string,
  locationDir: string,
  projectDir: string,
  { hardMax = 200 }: { hardMax?: number } = {},
): RalplanHooks {
  const ultragoal = createUltragoalHooks(
    store,
    (input) => session.synthetic(input),
    { hardMax },
  );

  // The absolute `Read fallback:` path OMC resolved through `resolveSkillPath`;
  // here it is always this package's own copy, so no existence probe is needed.
  const deepInterviewSkillPath = join(
    packageRoot,
    "skills",
    DEEP_INTERVIEW_SKILL_NAME,
    "SKILL.md",
  );

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
   * One continuation in flight per session, so a repeated `succeeded` cannot
   * stack reinforcements. Pattern from oh-my-openagent's ralph-loop handler.
   */
  const inFlight = new Set<string>();

  /**
   * Sessions the user stopped (Q9). Set by an `interrupted` event, cleared only
   * by the next real user prompt after the G2 marker check.
   */
  const interrupted = new Set<string>();

  /**
   * Whether a session belongs to this instance's location, and its parent.
   * Every plugin instance on a shared server receives every event, so an
   * instance handles only sessions whose location is its own (Q10).
   */
  const sessions = new Map<string, { own: boolean; parentID?: string }>();

  /** Running child executions per parent session (Q5). */
  const running = new Map<string, Set<string>>();

  /**
   * Tool calls per session since its last `started` (R10). Unknown until this
   * instance has seen one `session.tool.called`, so a host that never
   * delivers the event cannot make every turn look tool-less (decision 20).
   */
  const toolCalls = new Map<string, number>();
  let toolCalledSeen = false;
  const toolCallsOf = (sessionID: string) =>
    toolCalledSeen ? toolCalls.get(sessionID) : undefined;

  async function sessionOf(
    sessionID: string,
    created?: Record<string, unknown>,
  ): Promise<{ own: boolean; parentID?: string }> {
    const cached = sessions.get(sessionID);
    if (cached) return cached;
    // `session.created` carries `location` and `parentID` itself.
    const info: Record<string, unknown> =
      created ?? (await session.get({ sessionID }));
    const location = info.location;
    const entry = {
      own: isRecord(location) && location.directory === locationDir,
      ...(typeof info.parentID === "string" ? { parentID: info.parentID } : {}),
    };
    sessions.set(sessionID, entry);
    return entry;
  }

  /** Start a run with `text` as a synthetic message. Never throws. */
  async function inject(
    sessionID: string,
    text: string,
    description: string,
  ): Promise<void> {
    try {
      await session.synthetic({ sessionID, text, description, resume: true });
    } catch (error) {
      // No retry: the breaker count stays incremented, so the next run retries.
      log("continuation synthetic failed", error);
    }
  }

  /**
   * The current run's breaker counter from the hook-only
   * `state/ralplan-continuation.json` (plan R-O3), or `undefined` when the file
   * is missing, unreadable or names another run, which resets the count.
   */
  async function readBreaker(
    tx: RalplanTx,
    runId: string | undefined,
  ): Promise<RalplanBreaker | undefined> {
    let parsed: unknown;
    try {
      const text = await tx.readText(tx.paths.continuationPath);
      if (text === undefined) return undefined;
      parsed = JSON.parse(text);
    } catch (error) {
      log("ralplan continuation counter unreadable; starting over", error);
      return undefined;
    }
    return isRecord(parsed) && parsed.run_id === runId ? parsed : undefined;
  }

  /**
   * Plan C-1.5: one ralplan transaction reads the state and the counter,
   * decides, and writes the counter `{run_id, breaker_count,
   * breaker_updated_at}`. Breaker exhaustion writes only `active: false` to
   * the state, through the runtime writer with one audit row whose
   * `mutation_id` carries `breaker-exhausted` (R-O3). A turn ultragoal handled
   * only resets a finished run's breaker. A subagent's own session holds no
   * ralplan state, so it skips at the first clause. Returns the message to
   * inject after the transaction.
   */
  async function decideRalplan(
    sessionID: string,
    ultragoalHandled: boolean,
  ): Promise<Notice | undefined> {
    return store.ralplanTransaction(sessionID, async (tx) => {
      let state: Record<string, unknown> | undefined;
      try {
        state = await tx.readState();
      } catch (error) {
        log("ralplan state unreadable; treating session as inactive", error);
        return undefined;
      }
      const runId = typeof state?.run_id === "string" ? state.run_id : undefined;
      const breaker = await readBreaker(tx, runId);
      const decision = shouldContinue(state, breaker, Date.now());
      const writeBreaker = (count: number) =>
        tx.writeText(
          tx.paths.continuationPath,
          `${JSON.stringify(
            {
              run_id: runId,
              breaker_count: count,
              breaker_updated_at: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
        );
      if (decision.kind === "skip") {
        if (decision.resetBreaker && (Number(breaker?.breaker_count) || 0) !== 0)
          await writeBreaker(0);
        return undefined;
      }
      if (ultragoalHandled) return undefined;
      if (decision.kind === "breaker") {
        await patchStateTx(
          tx,
          sessionID,
          { active: false },
          HOOK_OWNER,
          "breaker-exhausted",
        );
        await writeBreaker(0);
        return {
          text: breakerMessage(),
          description:
            "open-gajae: ralplan continuation stopped (breaker limit reached)",
        };
      }
      await writeBreaker(decision.count);
      return {
        text: continuationMessage(decision.count),
        description: `open-gajae: ralplan continuation ${decision.count}/${RALPLAN_STOP_BLOCKER_MAX}`,
      };
    });
  }

  async function continueSession(sessionID: string): Promise<void> {
    if (inFlight.has(sessionID)) {
      log(`continuation already in flight for ${sessionID}`);
      return;
    }
    inFlight.add(sessionID);
    try {
      // Ahead of every state write: a stop the user asked for must neither
      // inject nor advance the breaker. The ralplan state is left `active`, so
      // the next real user turn resumes continuation normally.
      if (interrupted.has(sessionID)) {
        log("user interrupt; skipping continuation");
        return;
      }
      // OMC skips while owned background work is pending
      // (persistent-mode/index.ts:529-537); the host resumes the parent when
      // the child completes, and that later `succeeded` is judged normally.
      if ((running.get(sessionID)?.size ?? 0) > 0) {
        log("child executions running; skipping continuation");
        return;
      }

      // One engine, one mode per turn: ultragoal first (OMC ralph priority,
      // persistent-mode/index.ts:2471-2477), in its own transaction; the
      // ralplan transaction starts only after it (plan C-1.2, C-1.5).
      const handled = await ultragoal.continueLoop(
        sessionID,
        toolCallsOf(sessionID),
      );
      let action: Notice | undefined;
      try {
        action = await decideRalplan(sessionID, handled);
      } catch (error) {
        log("ralplan continuation failed", error);
      }
      if (action) await inject(sessionID, action.text, action.description);
    } finally {
      inFlight.delete(sessionID);
    }
  }

  /**
   * Root session per session ID. A subagent runs in a child session, and its
   * artifacts belong to the session folder of the lineage's root, so the chain
   * is walked once per session and then cached.
   */
  const rootSessions = new Map<string, string>();

  /**
   * The `parentID` of one session, or `undefined` when it has none. Throws for
   * any response this cannot read, so the caller fails closed.
   */
  async function parentSession(sessionID: string): Promise<string | undefined> {
    const info: unknown = await session.get({ sessionID });
    if (!isRecord(info)) throw new Error("session lookup returned no object");
    const parentID = info.parentID;
    if (parentID === undefined || parentID === null) return undefined;
    if (typeof parentID !== "string" || parentID.length === 0)
      throw new Error("session lookup returned an unusable parentID");
    return parentID;
  }

  /**
   * The root of `sessionID`'s lineage. Any failure — a rejected lookup, an
   * unreadable payload, a cycle — throws, and the guard refuses the write
   * rather than guessing: the same fail-closed rule oh-my-openagent's spawn
   * guards use.
   */
  async function rootSession(sessionID: string): Promise<string> {
    const cached = rootSessions.get(sessionID);
    if (cached !== undefined) return cached;
    const walked: string[] = [];
    const seen = new Set<string>();
    let current = sessionID;
    let root: string | undefined;
    try {
      for (;;) {
        const known = rootSessions.get(current);
        if (known !== undefined) {
          root = known;
          break;
        }
        if (seen.has(current)) throw new Error("session parent chain loops");
        seen.add(current);
        walked.push(current);
        const parent = await parentSession(current);
        if (parent === undefined) {
          root = current;
          break;
        }
        current = parent;
      }
    } catch (error) {
      throw new Error(
        `could not resolve the session lineage for ${sessionID}`,
        { cause: error },
      );
    }
    for (const id of walked) rootSessions.set(id, root);
    return root;
  }

  /** The project root as the model addresses it from this location. */
  const prefix = projectPrefix(locationDir, projectDir);

  function guidance(tool: string, folder: string): string {
    return `${tool} may only write under this session's plans/ or drafts/ (${prefix}.open-gajae/${folder}/plans|drafts/)`;
  }

  /** The session folder of `sessionID`'s lineage root. */
  async function ownFolder(sessionID: string): Promise<string> {
    return basename(await store.resolveSessionDir(await rootSession(sessionID)));
  }

  /**
   * D2c: a session may only write plans and drafts under its own session
   * folder; only this can pin the session. Ahead of it, the runtime-owned
   * paths — ultragoal files, the ralplan run folders and the session `state/`
   * tree — are refused for every agent and session (plan S3 ①, AC18). Returns
   * the model-facing guidance when the call must be blocked, `undefined` when
   * it may run. Any failure to decide blocks (fail closed).
   */
  async function guardSessionArtifacts(
    tool: string,
    sessionID: string,
    input: unknown,
  ): Promise<string | undefined> {
    const paths = artifactPathsOf(tool, input);
    for (const path of paths) {
      if (isUltragoalOwned(locationDir, projectDir, path)) {
        const shown = projectRelative(locationDir, projectDir, path) ?? path;
        return `open-gajae: ${shown} is ultragoal-owned; change it only through the ultragoal tool`;
      }
      if (
        isRalplanOwned(locationDir, projectDir, path) ||
        isSessionState(locationDir, projectDir, path)
      ) {
        const shown = projectRelative(locationDir, projectDir, path) ?? path;
        return `open-gajae: ${shown}: ${WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE}`;
      }
      const owner = sessionArtifactOwner(locationDir, projectDir, path);
      // Not a session plan or draft: the static permission rules decide.
      if (owner === undefined) continue;
      let allowed: string;
      try {
        allowed = await ownFolder(sessionID);
      } catch (error) {
        log(`could not resolve the session lineage for ${sessionID}`, error);
        return `open-gajae: could not resolve the session lineage for ${sessionID}; refusing to write a session artifact. ${guidance(tool, "_session-*")}`;
      }
      if (owner === allowed) continue;
      const shown = projectRelative(locationDir, projectDir, path) ?? path;
      return `open-gajae: ${shown} belongs to another session's plans/drafts. ${guidance(tool, allowed)}`;
    }
    return undefined;
  }

  /**
   * Plan DR-10 (gjc `getActivePlanningSkill`, `isBlockingPlanningPhase`,
   * `planningBlockedTargets`): while the lineage root's ralplan state is
   * readable, active and on a phase outside R — final and handoff keep
   * blocking — and ultragoal is not running at that root (R-O7), a
   * `write`/`edit`/`patch` from any agent of the lineage is refused unless
   * every target is a neutral temp path (DR-11). A call without a target is
   * refused, as gjc refuses an unknown target. Returns the message, or
   * `undefined`. Fails open on its own errors: a missing, unreadable or
   * unknown-phase state (DR-21) or a failed lineage lookup releases the guard
   * (gjc `:320`), unlike the fail-closed artifact guard.
   */
  async function guardPlanning(
    tool: string,
    sessionID: string,
    input: unknown,
  ): Promise<string | undefined> {
    if (!ARTIFACT_TOOLS.has(tool)) return undefined;
    try {
      const root = await rootSession(sessionID);
      const state = await store.read(root, RALPLAN_MODE);
      const phase = state?.current_phase;
      if (
        state?.active !== true ||
        !isKnownPhase(phase) ||
        GUARD_RELEASE_PHASES.has(phase)
      )
        return undefined;
      if (isUltragoalRunning(await ultragoal.read(root))) return undefined;
      const paths = artifactPathsOf(tool, input);
      if (paths.length === 0) return RALPLAN_MUTATION_BLOCK_MESSAGE;
      for (const path of paths)
        if (!(await isNeutralTempPath(resolve(locationDir, path), projectDir)))
          return RALPLAN_MUTATION_BLOCK_MESSAGE;
      return undefined;
    } catch (error) {
      log("ralplan planning guard could not decide; allowing the call", error);
      return undefined;
    }
  }

  /** Guidance per blocked tool call id, consumed by `execute.after`. */
  const blocked = new Map<string, string>();

  /**
   * Write each notice as a `synthetic` message without starting a run. On a
   * rejection the notice is appended to the prompt text instead (Q3): it is
   * marker-wrapped, so G2 ignores it if it ever re-enters this hook.
   */
  async function emitNotices(event: PromptEvent, notices: Notice[]) {
    for (const { text, description } of notices) {
      try {
        await session.synthetic({
          sessionID: event.sessionID,
          text,
          description,
          resume: false,
        });
      } catch (error) {
        log("synthetic notice failed; appending it to the prompt", error);
        event.prompt.text += `\n\n${text}`;
      }
    }
  }

  const prompt: RalplanHooks["prompt"] = async (event) => {
    try {
      const sessionID = event.sessionID;
      // G1 — role-subagent deny-list. A failed lookup proceeds.
      let agent: string | undefined;
      try {
        agent = (await session.get({ sessionID })).agent;
      } catch (error) {
        log("session lookup failed; treating the agent as unknown", error);
      }
      if (typeof agent === "string" && ROLE_SUBAGENTS.has(agent)) return;

      // G2 — this plugin's own notices can re-enter here (the Q3 fallback puts
      // one in the prompt text), and the continuation text contains the word
      // "ralplan". Matching on the marker tags also ignores a message a user
      // hand-pastes from an earlier turn.
      const text = event.prompt.text;
      if (INJECTION_MARKERS.some((marker) => text.includes(marker))) {
        log("ignoring plugin-injected message");
        return;
      }

      // A real user prompt lifts the stop mark. After G2, so a marker-wrapped
      // fallback notice can never clear it. It also lifts an ultragoal pause
      // (plan §5.5).
      interrupted.delete(sessionID);
      try {
        await ultragoal.releasePause(sessionID);
      } catch (error) {
        log("could not release the ultragoal pause", error);
      }

      const skills = event.prompt.skills ?? [];
      const ralplanMention = skills.some((s) => s.id === RALPLAN_SKILL_NAME);
      const deepInterviewMention = skills.some(
        (s) => s.id === DEEP_INTERVIEW_SKILL_NAME,
      );
      const ultragoalMention = skills.some((s) => s.id === ULTRAGOAL_SKILL_NAME);
      // OMC's guard (inside the detectors): a mention in prose, a question, a
      // quoted example or a pasted skill body is not an invocation.
      const keyword = detectRalplanKeyword(text) !== null;
      const ralplanDetected = ralplanMention || keyword;
      const ultragoalKeyword =
        !ultragoalMention && detectUltragoalKeyword(text) !== null;
      const ultragoalDetected = ultragoalMention || ultragoalKeyword;
      let ultragoalState = await ultragoal.read(sessionID);
      const notices: Notice[] = [];

      // Stale-seed cleanup, the sole replacement for the deleted TTL. A keyword
      // the model never acted on cannot leave a permanently active-but-silent
      // state, and such a seed can never raise a restore banner.
      if (
        ultragoalState?.active === true &&
        ultragoalState.awaiting_confirmation === true &&
        !ultragoalDetected
      ) {
        try {
          await ultragoal.clearStaleSeed(sessionID);
        } catch (error) {
          log("could not clear stale ultragoal seed", error);
        }
        ultragoalState = undefined;
      }

      const restored = await ultragoal.restore(sessionID, ultragoalState);
      if (restored) notices.push(restored);

      // No ralplan-first gate (decision P-8, as gajae-code): an `ultragoal`
      // request always starts ultragoal; ultragoal's no_prd phase scopes a
      // vague one into goals.
      const ultragoalRunning = isUltragoalRunning(ultragoalState);

      // Ralplan: a notice only, no state (plan S3, D-F13, R-O6); `ralplan
      // start` is the documented entry. Both carry a notice so the user sees
      // the insertion (user decision, 2026-09-24). While ultragoal runs (plan
      // §5.6), `@ralplan` only gets the handoff notice (decision 1b) and the
      // keyword gets nothing (Q-3).
      if (ralplanMention && ultragoalRunning) {
        notices.push({
          text: ralplanMentionNotice(),
          description: "open-gajae: ultragoal handoff notice added",
        });
      } else if (ralplanMention) {
        notices.push({
          text: mentionMessage(),
          description: "open-gajae: ralplan mention notice added",
        });
      } else if (
        keyword &&
        !ultragoalRunning &&
        !text.includes(KEYWORD_NOTICE_MARKER)
      ) {
        notices.push({
          text: keywordMessage(),
          description: "open-gajae: ralplan keyword notice added",
        });
      }

      // Ultragoal seed (R16), unless the same prompt asks for ralplan. The
      // mention attaches the skill without a `skill` call, so the ralplan
      // entry gate runs here before its seed (plan C-4, Architect 2nd-round
      // MINOR-1): refused → the notice only; a finished ralplan is handed off
      // and its meta rides the seed. The keyword's awaiting seed changes no
      // ralplan state; the later `skill ultragoal` load passes the gate, and
      // until then running planning keeps it from starting (Q-1).
      if (ultragoalDetected && !ralplanDetected) {
        const gate = ultragoalMention
          ? await ultragoalEntryGate(store, sessionID, HOOK_OWNER)
          : undefined;
        if (
          gate
            ? gate.status === "refused"
            : isRalplanRunning(await readState(sessionID))
        ) {
          notices.push({
            text: ralplanRunningNotice(),
            description: "open-gajae: ralplan-running notice added",
          });
        } else if (ultragoalMention) {
          await ultragoal.seed(sessionID, {
            awaiting: false,
            task: text,
            ...(gate?.status === "handoff"
              ? { handoff_from: gate.handoff_from, handoff_at: gate.handoff_at }
              : {}),
          });
          notices.push({
            text: ultragoalMentionMessage(),
            description: "open-gajae: ultragoal mention notice added",
          });
        } else if (!text.includes(ULTRAGOAL_NOTICE_MARKER)) {
          await ultragoal.seed(sessionID, { awaiting: true, task: text });
          notices.push({
            text: ultragoalKeywordMessage(),
            description: "open-gajae: ultragoal keyword notice added",
          });
        }
      }

      // Deep-interview. OMC injects its magic-keyword guide and seeds nothing
      // for this skill (bridge.ts:1449, keyword-detector.mjs:1793), and treats
      // an explicit invocation as the keyword (keyword-detector/index.ts:814-830),
      // so the `@deep-interview` mention gets the same single notice (Q8).
      if (
        (deepInterviewMention || detectDeepInterviewKeyword(text) !== null) &&
        !text.includes(DEEP_INTERVIEW_MAGIC_MARKER)
      )
        notices.push({
          text: deepInterviewMessage({
            skillPath: deepInterviewSkillPath,
            originalPrompt: text,
          }),
          description: "open-gajae: deep-interview keyword notice added",
        });

      // State first, then the notices (Q3, OMC/v1 order).
      await emitNotices(event, notices);
    } catch (error) {
      log("prompt handler failed", error);
    }
  };

  const executeBefore: RalplanHooks["executeBefore"] = async (event) => {
    // The guard blocks by invalidating the input, never by throwing: a
    // Promise-hook throw becomes a host defect. `{}` fails the host's input
    // decode with a `Tool.Error`, `execute.after` then runs with
    // `status: "error"` and rewrites it (Phase 0 P3). The host's tool-input
    // repair runs before this hook, so a stringified-JSON input arrives here
    // already parsed.
    try {
      const refusal = await guardSessionArtifacts(
        event.tool,
        event.sessionID,
        event.input,
      );
      if (refusal !== undefined) {
        blocked.set(event.id, refusal);
        event.input = {};
        return;
      }
    } catch (error) {
      log("artifact guard failed; blocking the call", error);
      if (artifactPathsOf(event.tool, event.input).length > 0) {
        blocked.set(event.id, guidance(event.tool, "_session-*"));
        event.input = {};
        return;
      }
    }
    // ② The planning guard fails open inside itself (plan DR-10).
    const planning = await guardPlanning(event.tool, event.sessionID, event.input);
    if (planning !== undefined) {
      blocked.set(event.id, planning);
      event.input = {};
      return;
    }
    try {
      if (event.tool === "subagent") {
        await ultragoal.attachBrief(event);
        return;
      }
      if (event.tool !== "skill" || !isRecord(event.input)) return;
      // v2 `skill` input is `{ id }` (core/src/tool/plugin/skill.ts:12-14).
      if (event.input.id === ULTRAGOAL_SKILL_NAME) {
        if (event.agent !== "open-gajae") return;
        // ③ The ultragoal entry gate (plan C-4) before the skill's confirm: a
        // refusal invalidates the input like every block here (a throw would
        // be swallowed and fail open); a finished ralplan is handed off and
        // ultragoal seeded with its meta (R-O2).
        const gate = await ultragoalEntryGate(store, event.sessionID, HOOK_OWNER);
        if (gate.status === "refused") {
          blocked.set(event.id, gate.message);
          event.input = {};
          return;
        }
        if (gate.status === "handoff")
          await ultragoal.seed(event.sessionID, {
            awaiting: false,
            handoff_from: gate.handoff_from,
            handoff_at: gate.handoff_at,
          });
        await ultragoal.onSkillLoad(event.sessionID);
        return;
      }
      if (event.input.id !== RALPLAN_SKILL_NAME) return;
      // ④ Chain guard (decision 1a): ralplan only after an explicit handoff.
      if (isUltragoalRunning(await ultragoal.read(event.sessionID))) {
        blocked.set(event.id, CHAIN_GUARD_REFUSAL);
        event.input = {};
      }
    } catch (error) {
      log("execute.before handler failed", error);
    }
  };

  /**
   * Rewrite a failed call into model-facing guidance when it failed because
   * of a block recorded by `execute.before`. Since plan S3 no role has a static
   * `edit` allow to explain, so a host permission block is left as it is.
   */
  const executeAfter: RalplanHooks["executeAfter"] = async (event) => {
    try {
      const recorded = blocked.get(event.id);
      if (recorded !== undefined) blocked.delete(event.id);
      if (event.status !== "error" || recorded === undefined) return;
      event.error = new ToolError({ message: recorded });
    } catch (error) {
      log("execute.after handler failed", error);
    }
  };

  /**
   * Plan D-H2/AC19: after ultragoal's context, the active ralplan run's
   * recovery contract — gjc's projection of the newest final (else
   * planner/revision) stage file, verified against its ledger sha256, and
   * render (`./ralplan-runtime/recovery.ts`). Nothing is added for a missing,
   * unreadable, inactive or unknown-phase state (DR-21) or a failed
   * projection. Stage files are read through the transaction, confined to
   * the run folder.
   */
  const compaction: RalplanHooks["compaction"] = async (event) => {
    await ultragoal.compaction(event);
    try {
      const text = await store.ralplanTransaction(event.sessionID, async (tx) => {
        const state = await tx.readState().catch(() => undefined);
        if (state?.active !== true || !isKnownPhase(state.current_phase))
          return undefined;
        const run = ralplanRecoveryRunFromState(state);
        if (!run) return undefined;
        const runDir = tx.paths.runDir(run.runId);
        const projection = await projectRalplanRun({
          ...run,
          runDir,
          indexText: await tx.readText(join(runDir, RALPLAN_INDEX_FILE)),
          readArtifact: async (candidate, dir) => {
            const inside = relative(dir, candidate);
            if (!inside || inside.startsWith("..") || isAbsolute(inside))
              return undefined;
            const artifact = await tx.readText(candidate).catch(() => undefined);
            return artifact === undefined
              ? undefined
              : new TextEncoder().encode(artifact);
          },
        });
        return projection
          ? compactionMessage(renderRalplanRecoveryContext(projection))
          : undefined;
      });
      if (text !== undefined) event.system.push({ type: "text", text });
    } catch (error) {
      log("ralplan compaction context failed", error);
    }
  };

  const onEvent: RalplanHooks["onEvent"] = async (event) => {
    try {
      if (!isRecord(event) || !isRecord(event.data)) return;
      const { type, data } = event;
      const sessionID = data.sessionID;
      if (typeof sessionID !== "string" || sessionID.length === 0) return;
      if (type === "session.created") {
        await sessionOf(sessionID, data);
        return;
      }
      // Counted before the execution branch, so a child's tool call never
      // touches its parent's `running` set (AC19).
      if (type === "session.tool.called") {
        toolCalledSeen = true;
        toolCalls.set(sessionID, (toolCalls.get(sessionID) ?? 0) + 1);
        return;
      }
      if (typeof type !== "string" || !type.startsWith("session.execution."))
        return;
      const info = await sessionOf(sessionID);
      if (!info.own) return;
      if (type === "session.execution.started") toolCalls.set(sessionID, 0);

      if (info.parentID !== undefined) {
        const children = running.get(info.parentID) ?? new Set<string>();
        if (type === "session.execution.started") children.add(sessionID);
        else children.delete(sessionID);
        if (children.size > 0) running.set(info.parentID, children);
        else running.delete(info.parentID);
      }

      if (type === "session.execution.interrupted") {
        if (STOP_REASONS.has(String(data.reason))) {
          interrupted.add(sessionID);
          log(`recorded user interrupt for ${sessionID}`);
        }
        return;
      }
      // `failed` does not continue.
      if (type === "session.execution.succeeded")
        await continueSession(sessionID);
      // The next `started` counts afresh; a finished session keeps no entry.
      if (type !== "session.execution.started") toolCalls.delete(sessionID);
    } catch (error) {
      log("execution event handler failed", error);
    }
  };

  return {
    parentSession,
    rootSession,
    prompt,
    compaction,
    executeBefore,
    executeAfter,
    onEvent,
  };
}
