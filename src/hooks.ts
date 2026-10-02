// Workflow host hooks, assembled here (ultragoal revision plan S3 3b): the
// continuation on durable execution events (the goal loop first, then
// ralplan), the keyword/mention notices, the goal hold release and the turn
// marker on the v2 `prompt` hook, the mutation guards, the `skill` chain guard
// and turn gate, and the red-team fragment on `execute.before`, the marker
// revert on `execute.after`, the workflow-tool hiding and the goal context on
// `context` (plan C-11, C-9), and the compaction recovery context. The goal
// logic lives in `src/goal/hooks.ts`, the ultragoal seed and texts in
// `src/ultragoal-runtime/`, the ralplan handoff in
// `src/ralplan-runtime/store.ts`. The prompt hook also carries the
// deep-interview keyword and `@deep-interview` mention, which only inject
// OMC's magic-keyword guide and seed no state at all.
//
// Ralplan plan S3 (gajae-code 5c5231418930673e42cc5d08ebe4376e03187533, MIT):
// the ralplan keyword and mention only add a notice (D-F13, R-O6) and the OMC
// restore notice is gone (R-O11); `execute.before` blocks the runtime-owned
// paths for everyone and, while ralplan is the visible primary skill and
// plans, every mutation outside a neutral temp path
// (`skill-state/workflow-mutation-guard.ts:22-29,264-351,1767-1866`;
// deviations 11, 23); continuation keeps OMC's loop over the gjc terminal set
// with a hook-only counter file (deviations 10, 26); compaction adds the gjc
// recovery contract (`session/agent-session.ts:667-710`, deviation 20).
//
// Ultragoal revision plan S3 (same gjc revision):
// - C-9 (PQ-20 A, PQ-7 B, D-TL6): on each root `succeeded`, an active goal
//   takes the goal path only (`session/agent-session.ts:21086-21121`,
//   whatever the agent); otherwise ralplan continues only while it is the
//   visible primary skill (ralplan deviation 10).
// - C-10 (PQ-21 A): the turn marker is the workflow skill loaded in the
//   current execution (`session/agent-session.ts:7448,8038-8046`): set by a
//   `skill` call that passed the plugin guards or by an `@<skill>` mention,
//   reverted when that call fails, and cleared at every execution end before
//   the continuation decision. `skill ultragoal` hands off an active ralplan
//   in T only when the marker is `ralplan` (`tools/skill.ts:170-222`, D-HE6);
//   otherwise it seeds `goal-planning` (DR-21, deviation 35).
// - D-HE3 (deviation 22): while ultragoal is the visible primary skill,
//   `skill ralplan` and `skill deep-interview` are refused
//   (`tools/skill.ts:205-209`).
// - D-HE5 (PQ-13 A): while ultragoal is the visible primary skill on an active
//   `goal-planning` state, mutations outside a neutral temp path are refused
//   (`workflow-mutation-guard.ts:28-29,274`).
// - D-VF11 (deviation 20): `subagent(open-gajae-executor)` with the
//   `[ultragoal-red-team]` marker gets gjc's red-team fragment
//   (`prompts/agents/executor.md:34-46`).
// - PQ-5 (1) B: while ultragoal is the visible primary skill, `@ralplan`,
//   `@deep-interview` and their keywords get the handoff notice; the
//   ultragoal keyword and mention get a notice only (D-HE4).
//
// Deep-interview revision plan S3a (same gjc revision; the decisions live in
// `src/deep-interview-runtime/hooks.ts`):
// - DR-19 (deviation 14): while deep-interview is the visible primary skill,
//   active on `interviewing` or `handoff`, mutations outside a neutral temp
//   path are refused (`workflow-mutation-guard.ts:22-23,265-268`); the
//   deep-interview specs are always refused to the mutation tools (DR-24,
//   deviation 35).
// - DR-20 (deviation 16): on each root `succeeded`, deep-interview decides
//   first: `interviewing` continues up to twice per real user prompt, and
//   while it is `interviewing` or `handoff` the goal and ralplan
//   continuations are skipped (`session/agent-session.ts:21137-21211,
//   8138-8157`; an exception to D-TL6).
// - DR-21 (deviation 31): with the deep-interview turn marker, `skill ralplan`
//   (after the ultragoal chain guard) and `skill ultragoal` (before its turn
//   gate) pass the deep-interview load gate (`tools/skill.ts:203-222`).
// - DR-22 (deviation 15): compaction adds the deep-interview recovery context
//   between ultragoal's and ralplan's.
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
// Source: oh-my-claudecode v5.4.0 (MIT) — `persistent-mode/index.ts`
// checkRalplan — and oh-my-openagent d1557a4b48fdbec06a7144fdc4afa3e65c6523ed
// (Sustainable Use License) for OpenCode-side in-flight, lineage and injection
// patterns, modified for open-gajae. See THIRD-PARTY-NOTICES.md and
// licenses/OMO-SUL.txt.

import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import {
  ARTIFACT_TOOLS,
  artifactPathsOf,
  isDeepInterviewOwned,
  isRalplanOwned,
  isSessionState,
  isUltragoalOwned,
  projectPrefix,
  projectRelative,
  sessionArtifactOwner,
} from "./artifact-guard.js";
import { createDeepInterviewHooks } from "./deep-interview-runtime/hooks.js";
import { specGuardRefusal } from "./deep-interview-runtime/messages.js";
import { createGoalHooks } from "./goal/hooks.js";
import { GOAL_CONTEXT_DESCRIPTION } from "./goal/messages.js";
import { INJECTION_MARKERS } from "./injection.js";
import {
  breakerMessage,
  compactionMessage,
  continuationMessage,
  DEEP_INTERVIEW_SKILL_NAME,
  deepInterviewMessage,
  detectDeepInterviewKeyword,
  detectRalplanKeyword,
  detectUltragoalKeyword,
  keywordMessage,
  mentionMessage,
  RALPLAN_SKILL_NAME,
  RALPLAN_STOP_BLOCKER_MAX,
  type RalplanBreaker,
  shouldContinue,
  ULTRAGOAL_SKILL_NAME,
} from "./ralplan.js";
import { RALPLAN_INDEX_FILE } from "./ralplan-runtime/ledger.js";
import { GUARD_RELEASE_PHASES, isKnownPhase, TERMINAL_PHASES } from "./ralplan-runtime/manifest.js";
import {
  projectRalplanRun,
  ralplanRecoveryRunFromState,
  renderRalplanRecoveryContext,
} from "./ralplan-runtime/recovery.js";
import {
  HOOK_OWNER,
  patchStateTx,
  RALPLAN_RUNNING_REFUSAL,
  ralplanHandoffTx,
} from "./ralplan-runtime/store.js";
import { isNeutralTempPath } from "./ralplan-runtime/temp-paths.js";
import { readVisiblePrimaryTx } from "./skill-state/rows.js";
import type { RalplanTx, StateStore } from "./state.js";
import {
  ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE,
  ULTRAGOAL_RED_TEAM_FRAGMENT,
  ULTRAGOAL_RED_TEAM_MARKER,
  ultragoalChainRefusal,
  ultragoalHandoffNotice,
  ultragoalKeywordNotice,
  ultragoalMentionNotice,
} from "./ultragoal-runtime/messages.js";
import { seedUltragoalTx } from "./ultragoal-runtime/store.js";

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

/** The message fields the goal context compare reads (host `plan.ts:115-121`). */
type ContextMessage = {
  readonly role: string;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: unknown }>;
};

/**
 * The fields of the host's `context`, `compaction` and `generate` session hook
 * events (`SessionContext`) the hiding and goal-context hooks read or write.
 */
export type ContextEvent = {
  readonly sessionID?: string;
  readonly agent?: string;
  tools?: Record<string, unknown>;
  messages?: ContextMessage[];
};

/** The fields of the host's `compaction` session hook read or written here. */
export type CompactionEvent = {
  readonly sessionID: string;
  system: Array<{ type: "text"; text: string }>;
};

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
  /** Fail-closed lineage root, shared with the workflow tools (plan DR-1, D-SF6). */
  rootSession(sessionID: string): Promise<string>;
  prompt(event: PromptEvent): Promise<void>;
  /**
   * The `context` session hook: `hideTools`, then the goal context of an
   * active goal on a root `open-gajae` request (C-9).
   */
  context(event: ContextEvent): Promise<void>;
  /**
   * Plan C-11: registered on the `compaction` and `generate` session hooks
   * (and run by `context`); removes each workflow tool the request's agent
   * does not own.
   */
  hideTools(event: ContextEvent): void;
  /**
   * The `compaction` session hook: the root's ultragoal recovery context
   * (DR-17), the root's deep-interview context (deep-interview DR-22), then
   * the active ralplan run's recovery contract (D-H2/AC19).
   */
  compaction(event: CompactionEvent): Promise<void>;
  executeBefore(event: ExecuteBeforeEvent): Promise<void>;
  executeAfter(event: ExecuteAfterEvent): Promise<void>;
  /** One event from `ctx.event.subscribe`: an envelope `{ type, data }`. */
  onEvent(event: unknown): Promise<void>;
};

/** The primary this plugin drives; the only agent its workflow tools serve. */
const PRIMARY_AGENT = "open-gajae";

/** D-VF11: the role whose `subagent` prompt may carry the red-team marker. */
const RED_TEAM_AGENT = "open-gajae-executor";

/**
 * G1's deny-list: the six owned role subagents from `src/config.ts`. A
 * `subagent` turn runs in a child session carrying the child's agent, and a
 * role's brief can quote a workflow keyword, so the prompt hook skips these
 * roles: no keyword or mention notices in a session whose agent has
 * `deep-interview` denied. Any other agent except `open-gajae` gets no notice
 * either (R-OD20) but still lifts the stop mark and the goal hold;
 * `undefined` or a failed lookup proceeds.
 */
const ROLE_SUBAGENTS = new Set([
  "open-gajae-planner",
  "open-gajae-architect",
  "open-gajae-critic",
  "open-gajae-executor",
  "open-gajae-cleaner",
  "open-gajae-lateral-reviewer",
]);

/**
 * Plan C-11 (D-HE8, E-2): each workflow tool and the agents that own it,
 * matching the tools' own actor checks — `ralplan` D-W3
 * (`src/ralplan-runtime/tool.ts`), `ultragoal`, `goal` and `deep-interview`
 * the primary alone (`src/ultragoal-runtime/tool.ts`, `src/goal/tool.ts`,
 * I-12, `src/deep-interview-runtime/tool.ts`, deep-interview D-HL7). The `context`
 * hook deletes a tool from any other agent's request, host and user-defined
 * agents included, so the host neither offers it nor runs a call to it
 * (`core/src/session/model-request.ts:225-255`, `core/src/tool.ts:272-275`),
 * as the host's patch plugin removes its tools
 * (`core/src/tool/plugin/patch.ts:296-309`). The owners' `roleRules` denies
 * stay.
 */
const TOOL_OWNERS: Record<string, ReadonlySet<string>> = {
  ralplan: new Set([
    PRIMARY_AGENT,
    "open-gajae-planner",
    "open-gajae-architect",
    "open-gajae-critic",
  ]),
  ultragoal: new Set([PRIMARY_AGENT]),
  goal: new Set([PRIMARY_AGENT]),
  "deep-interview": new Set([PRIMARY_AGENT]),
};

/**
 * Interrupt reasons that mean "stop" (Q9): `user` is Esc or the interrupt API,
 * and `shutdown` is a dismissed `question` form and the host default for a
 * reason-less interrupt (`core/src/session/execution.ts:53`).
 */
const STOP_REASONS = new Set(["user", "shutdown"]);

/** PQ-21 A: every execution end clears the turn marker first. */
const EXECUTION_ENDS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

/** The workflow skills whose load sets the turn marker (C-10). */
const WORKFLOW_SKILLS: ReadonlySet<unknown> = new Set([
  RALPLAN_SKILL_NAME,
  ULTRAGOAL_SKILL_NAME,
  DEEP_INTERVIEW_SKILL_NAME,
]);

/**
 * gajae-code 5c52314 `skill-state/workflow-mutation-guard.ts:24-25`
 * (`WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE` + `Use:` line) with the host's
 * runtime-owned paths and tools substituted (plan S3, AC18).
 */
const WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE =
  ".open-gajae workflow state and ralplan artifacts are runtime-owned. Agent mutation tools cannot edit `.open-gajae/_session-*/state/**` or `.open-gajae/_session-*/plans/ralplan/**`; use the sanctioned tool instead.\nUse: `ralplan` for ralplan state and plans, `ultragoal` for ultragoal state, `goal` for the goal, `deep-interview` for deep-interview state and specs.";

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
/** gjc `executor.md` fragment tag: its presence means it is attached. */
const RED_TEAM_FRAGMENT_TAG = "<ultragoal_red_team_mode>";

function log(message: string, error?: unknown) {
  if (error === undefined) console.warn(`[open-gajae:hooks] ${message}`);
  else console.warn(`[open-gajae:hooks] ${message}:`, error);
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
): RalplanHooks {
  const goal = createGoalHooks(store);
  const deepInterview = createDeepInterviewHooks(store);

  // The absolute `Read fallback:` path OMC resolved through `resolveSkillPath`;
  // here it is always this package's own copy, so no existence probe is needed.
  const deepInterviewSkillPath = join(
    packageRoot,
    "skills",
    DEEP_INTERVIEW_SKILL_NAME,
    "SKILL.md",
  );

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
   * PQ-21 A (C-10): the workflow skill loaded in each session's current
   * execution, and per `skill` call id the marker it replaced, so a failed
   * call can put it back.
   */
  const turnSkill = new Map<string, string>();
  const markerUndo = new Map<string, { sessionID: string; previous: string | undefined }>();

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

  /** Write one synthetic message. Never throws. */
  async function inject(
    sessionID: string,
    text: string,
    description: string,
    resume = true,
  ): Promise<void> {
    try {
      await session.synthetic({ sessionID, text, description, resume });
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
   * Plan C-1.5: one transaction reads the rows, the state and the counter,
   * decides, and writes the counter `{run_id, breaker_count,
   * breaker_updated_at}`. PQ-7 B: nothing happens unless ralplan is the
   * visible primary skill (row). Breaker exhaustion writes only `active:
   * false` to the state, through the runtime writer with one audit row whose
   * `mutation_id` carries `breaker-exhausted` (R-O3). Returns the message to
   * inject after the transaction.
   */
  async function decideRalplan(sessionID: string): Promise<Notice | undefined> {
    return store.ralplanTransaction(sessionID, async (tx) => {
      let primary: Record<string, unknown> | undefined;
      try {
        primary = await readVisiblePrimaryTx(tx);
      } catch (error) {
        log("active rows unreadable; no ralplan continuation", error);
        return undefined;
      }
      if (primary?.skill !== RALPLAN_SKILL_NAME) return undefined;
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

  /** Plan C-9 for a lineage root's `succeeded`, after the marker is cleared. */
  async function continueSession(sessionID: string): Promise<void> {
    if (inFlight.has(sessionID)) {
      log(`continuation already in flight for ${sessionID}`);
      return;
    }
    inFlight.add(sessionID);
    try {
      // Ahead of every state write: a stop the user asked for must neither
      // inject nor count. The goal and ralplan states are left as they are,
      // so the next real user turn resumes continuation normally.
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

      // Deep-interview DR-20: deep-interview decides first; a decision that
      // fails counts as none, so the goal path still runs.
      let interview: Awaited<ReturnType<typeof deepInterview.decideContinuation>> = { kind: "none" };
      try {
        interview = await deepInterview.decideContinuation(sessionID);
      } catch (error) {
        log("deep-interview continuation could not decide; trying the goal", error);
      }
      if (interview.kind === "continue") {
        await inject(sessionID, interview.text, interview.description);
        return;
      }
      if (interview.kind === "hold") return;

      // D-TL6, I-6: an active goal takes the goal path only, held or not.
      let decision: Awaited<ReturnType<typeof goal.decideContinuation>>;
      try {
        decision = await goal.decideContinuation(sessionID, toolCallsOf(sessionID));
      } catch (error) {
        log("goal continuation failed", error);
        return;
      }
      if (decision.kind === "message") {
        const { text, description, resume } = decision.message;
        await inject(sessionID, text, description, resume);
        return;
      }
      if (decision.kind === "held") return;

      let action: Notice | undefined;
      try {
        action = await decideRalplan(sessionID);
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

  /** C-3: the visible primary skill's row at `sessionID`'s lineage root. */
  async function visiblePrimary(
    sessionID: string,
  ): Promise<Record<string, unknown> | undefined> {
    const root = await rootSession(sessionID);
    return store.workflowTransaction(root, (tx) => readVisiblePrimaryTx(tx));
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
   * paths — ultragoal files, the deep-interview specs, the ralplan run
   * folders and the session `state/` tree — are refused for every agent and
   * session (plan S3 ①, AC18; deep-interview DR-24). Returns
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
      if (isDeepInterviewOwned(locationDir, projectDir, path))
        return specGuardRefusal(projectRelative(locationDir, projectDir, path) ?? path);
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
   * Plan D-HE5 (gjc `getActivePlanningSkill`, `isBlockingPlanningPhase`,
   * `planningBlockedTargets`): the lineage root's visible primary skill
   * decides. Ralplan blocks while its state is readable, active and on a
   * phase outside R — final and handoff keep blocking (DR-10); ultragoal
   * blocks while its state is active on `goal-planning` (DR-22);
   * deep-interview blocks while active on `interviewing` or `handoff`
   * (deep-interview DR-19). A
   * `write`/`edit`/`patch` from any agent of the lineage is then refused
   * unless every target is a neutral temp path (DR-11, PQ-13 A). A call
   * without a target is refused, as gjc refuses an unknown target. Returns
   * the message, or `undefined`. Fails open on its own errors: missing or
   * unreadable rows or states, an unknown ralplan phase (DR-21) or a failed
   * lineage lookup release the guard (gjc `:320`), unlike the fail-closed
   * artifact guard.
   */
  async function guardPlanning(
    tool: string,
    sessionID: string,
    input: unknown,
  ): Promise<string | undefined> {
    if (!ARTIFACT_TOOLS.has(tool)) return undefined;
    try {
      const root = await rootSession(sessionID);
      const message = await store.workflowTransaction(root, async (tx) => {
        const primary = await readVisiblePrimaryTx(tx);
        if (primary?.skill === RALPLAN_SKILL_NAME) {
          const state = await tx.readModeState("ralplan");
          const phase = state?.current_phase;
          return state?.active === true &&
            isKnownPhase(phase) &&
            !GUARD_RELEASE_PHASES.has(phase)
            ? RALPLAN_MUTATION_BLOCK_MESSAGE
            : undefined;
        }
        if (primary?.skill === ULTRAGOAL_SKILL_NAME) {
          const state = await tx.readModeState("ultragoal");
          const phase = String(state?.current_phase ?? "").trim().toLowerCase();
          return state?.active === true && phase === "goal-planning"
            ? ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE
            : undefined;
        }
        if (primary?.skill === DEEP_INTERVIEW_SKILL_NAME) return deepInterview.guardMessageTx(tx);
        return undefined;
      });
      if (message === undefined) return undefined;
      const paths = artifactPathsOf(tool, input);
      if (paths.length === 0) return message;
      for (const path of paths)
        if (!(await isNeutralTempPath(resolve(locationDir, path), projectDir)))
          return message;
      return undefined;
    } catch (error) {
      log("planning guard could not decide; allowing the call", error);
      return undefined;
    }
  }

  /**
   * Plan C-10 (D-HE6, I-7, I-15): `skill ultragoal` at the lineage root. When
   * this execution loaded deep-interview (the turn marker), the deep-interview
   * load gate decides first (deep-interview DR-21): a refusal refuses the
   * load, a handoff makes ultragoal active on `goal-planning` already, and a
   * pass goes on. When this execution loaded ralplan and ralplan is active, a
   * phase in T is handed off through the shared journaled handoff (PQ-6 A)
   * and a phase outside T refuses the load. Otherwise — no marker, an
   * inactive, missing, unreadable or unknown-phase ralplan (DR-21) — the
   * load seeds `goal-planning` (DR-21) and ralplan is left alone. Returns the
   * refusal, or `undefined` when the load may run.
   */
  async function ultragoalGate(sessionID: string): Promise<string | undefined> {
    const root = await rootSession(sessionID);
    const marker = turnSkill.get(sessionID);
    return store.workflowTransaction(root, async (tx) => {
      if (marker === DEEP_INTERVIEW_SKILL_NAME) {
        const gate = await deepInterview.gateTx(tx, root, "ultragoal");
        if (gate.kind === "refuse") return gate.message;
        if (gate.kind === "handed-off") return undefined;
      }
      if (marker === RALPLAN_SKILL_NAME) {
        const ralplan = await tx.readState().catch(() => undefined);
        const phase = ralplan?.current_phase;
        if (ralplan?.active === true && isKnownPhase(phase)) {
          if (!TERMINAL_PHASES.has(phase)) return RALPLAN_RUNNING_REFUSAL;
          await ralplanHandoffTx(tx, root, HOOK_OWNER, "skill ultragoal loaded after ralplan");
          return undefined;
        }
      }
      await seedUltragoalTx(tx, root, HOOK_OWNER);
      return undefined;
    });
  }

  /** C-10: set the turn marker for a call that passed the guards. */
  function markTurn(sessionID: string, callID: string | undefined, skill: string) {
    if (callID !== undefined)
      markerUndo.set(callID, { sessionID, previous: turnSkill.get(sessionID) });
    turnSkill.set(sessionID, skill);
  }

  /** D-VF11: append the red-team fragment to a marked executor assignment. */
  function attachRedTeam(input: unknown) {
    if (!isRecord(input) || input.agent !== RED_TEAM_AGENT) return;
    const prompt = input.prompt;
    if (typeof prompt !== "string" || !prompt.includes(ULTRAGOAL_RED_TEAM_MARKER)) return;
    if (prompt.includes(RED_TEAM_FRAGMENT_TAG)) return;
    input.prompt = `${prompt}\n\n${ULTRAGOAL_RED_TEAM_FRAGMENT}`;
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
      // fallback notice can never clear it. At the lineage root it also
      // releases the goal hold (plan C-9), whatever the agent.
      interrupted.delete(sessionID);
      let root: string | undefined;
      try {
        root = await rootSession(sessionID);
      } catch (error) {
        log("could not resolve the session lineage for the prompt", error);
      }
      if (root === sessionID) {
        // Deep-interview DR-20: a real user prompt gives a fresh budget.
        deepInterview.resetContinuation(sessionID);
        try {
          await goal.releaseHold(sessionID);
        } catch (error) {
          log("could not release the goal hold", error);
        }
      }

      // R-OD20: notices go only to the primary this plugin drives; the
      // workflow and state tools refuse every other agent (DR-22), so a
      // notice would lead it to a refusal. A session without an agent, or a
      // failed lookup, proceeds (G1).
      if (typeof agent === "string" && agent !== PRIMARY_AGENT) return;

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
      const ultragoalDetected =
        ultragoalMention || detectUltragoalKeyword(text) !== null;
      const deepInterviewDetected =
        deepInterviewMention || detectDeepInterviewKeyword(text) !== null;

      // PQ-5 (1) B: while ultragoal is the visible primary skill, ralplan and
      // deep-interview requests get the handoff notice instead.
      let ultragoalPrimary = false;
      if ((ralplanDetected || deepInterviewDetected) && root !== undefined) {
        try {
          ultragoalPrimary =
            (await visiblePrimary(root))?.skill === ULTRAGOAL_SKILL_NAME;
        } catch (error) {
          log("active rows unreadable; treating ultragoal as not primary", error);
        }
      }
      const notices: Notice[] = [];
      // C-10: an `@<skill>` mention attaches the skill in this turn.
      let mentioned: string | undefined;

      // Ralplan: a notice only, no state (plan S3, D-F13, R-O6); `ralplan
      // start` is the documented entry. Both carry a notice so the user sees
      // the insertion (user decision, 2026-09-24).
      if (ralplanDetected && ultragoalPrimary) {
        notices.push({
          text: ultragoalHandoffNotice(RALPLAN_SKILL_NAME),
          description: "open-gajae: ultragoal handoff notice added",
        });
      } else if (ralplanMention) {
        notices.push({
          text: mentionMessage(),
          description: "open-gajae: ralplan mention notice added",
        });
        mentioned = RALPLAN_SKILL_NAME;
      } else if (keyword && !text.includes(KEYWORD_NOTICE_MARKER)) {
        notices.push({
          text: keywordMessage(),
          description: "open-gajae: ralplan keyword notice added",
        });
      }

      // Ultragoal (D-HE4): a notice only, unless the same prompt asks for
      // ralplan; the `skill ultragoal` load seeds its state.
      if (ultragoalDetected && !ralplanDetected) {
        if (ultragoalMention) {
          notices.push({
            text: ultragoalMentionNotice(),
            description: "open-gajae: ultragoal mention notice added",
          });
          mentioned ??= ULTRAGOAL_SKILL_NAME;
        } else if (!text.includes(ULTRAGOAL_NOTICE_MARKER)) {
          notices.push({
            text: ultragoalKeywordNotice(),
            description: "open-gajae: ultragoal keyword notice added",
          });
        }
      }

      // Deep-interview. OMC injects its magic-keyword guide and seeds nothing
      // for this skill (bridge.ts:1449, keyword-detector.mjs:1793), and treats
      // an explicit invocation as the keyword (keyword-detector/index.ts:814-830),
      // so the `@deep-interview` mention gets the same single notice (Q8).
      if (deepInterviewDetected && ultragoalPrimary) {
        notices.push({
          text: ultragoalHandoffNotice(DEEP_INTERVIEW_SKILL_NAME),
          description: "open-gajae: ultragoal handoff notice added",
        });
      } else if (deepInterviewDetected) {
        if (deepInterviewMention) mentioned ??= DEEP_INTERVIEW_SKILL_NAME;
        if (!text.includes(DEEP_INTERVIEW_MAGIC_MARKER))
          notices.push({
            text: deepInterviewMessage({
              skillPath: deepInterviewSkillPath,
              originalPrompt: text,
            }),
            description: "open-gajae: deep-interview keyword notice added",
          });
      }

      if (mentioned !== undefined) markTurn(sessionID, undefined, mentioned);
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
    // ② The planning guard fails open inside itself (plan D-HE5).
    const planning = await guardPlanning(event.tool, event.sessionID, event.input);
    if (planning !== undefined) {
      blocked.set(event.id, planning);
      event.input = {};
      return;
    }
    try {
      if (event.tool === "subagent") {
        attachRedTeam(event.input);
        return;
      }
      if (event.tool !== "skill" || !isRecord(event.input)) return;
      // v2 `skill` input is `{ id }` (core/src/tool/plugin/skill.ts:12-14).
      const skill = event.input.id;
      if (typeof skill !== "string" || !WORKFLOW_SKILLS.has(skill)) return;
      if (skill === ULTRAGOAL_SKILL_NAME) {
        if (event.agent !== PRIMARY_AGENT) return;
        // ③ The turn gate (D-HE6): a refusal invalidates the input like every
        // block here (a throw would be swallowed and fail open).
        const gate = await ultragoalGate(event.sessionID);
        if (gate !== undefined) {
          blocked.set(event.id, gate);
          event.input = {};
          return;
        }
        markTurn(event.sessionID, event.id, skill);
        return;
      }
      // ④ Chain guard (D-HE3): leaving ultragoal needs `ultragoal handoff`.
      let primary: Record<string, unknown> | undefined;
      try {
        primary = await visiblePrimary(event.sessionID);
      } catch (error) {
        log("active rows unreadable; the chain guard lets the call through", error);
      }
      if (primary?.skill === ULTRAGOAL_SKILL_NAME) {
        blocked.set(
          event.id,
          ultragoalChainRefusal(String(primary.phase ?? "unknown"), skill),
        );
        event.input = {};
        return;
      }
      // ⑤ Deep-interview DR-21: `skill ralplan` after this execution loaded
      // deep-interview passes the deep-interview load gate.
      if (
        skill === RALPLAN_SKILL_NAME &&
        event.agent === PRIMARY_AGENT &&
        turnSkill.get(event.sessionID) === DEEP_INTERVIEW_SKILL_NAME
      ) {
        const root = await rootSession(event.sessionID);
        const gate = await store.workflowTransaction(root, (tx) =>
          deepInterview.gateTx(tx, root, "ralplan"),
        );
        if (gate.kind === "refuse") {
          blocked.set(event.id, gate.message);
          event.input = {};
          return;
        }
      }
      markTurn(event.sessionID, event.id, skill);
    } catch (error) {
      log("execute.before handler failed", error);
    }
  };

  /**
   * Rewrite a failed call into model-facing guidance when it failed because
   * of a block recorded by `execute.before`, and put back the turn marker a
   * failed `skill` call set (C-10). Since plan S3 no role has a static
   * `edit` allow to explain, so a host permission block is left as it is.
   */
  const executeAfter: RalplanHooks["executeAfter"] = async (event) => {
    try {
      const undo = markerUndo.get(event.id);
      if (undo !== undefined) {
        markerUndo.delete(event.id);
        if (event.status === "error") {
          if (undo.previous === undefined) turnSkill.delete(undo.sessionID);
          else turnSkill.set(undo.sessionID, undo.previous);
        }
      }
      const recorded = blocked.get(event.id);
      if (recorded !== undefined) blocked.delete(event.id);
      if (event.status !== "error" || recorded === undefined) return;
      event.error = new ToolError({ message: recorded });
    } catch (error) {
      log("execute.after handler failed", error);
    }
  };

  /**
   * Plan C-11: hide each workflow tool from an agent that does not own it
   * (`TOOL_OWNERS`). Only the listed tools are touched; a missing `tools` is
   * left alone, and a missing `agent` owns nothing.
   */
  const hideTools: RalplanHooks["hideTools"] = (event) => {
    const tools = event.tools;
    if (!isRecord(tools)) return;
    for (const [tool, owners] of Object.entries(TOOL_OWNERS))
      if (typeof event.agent !== "string" || !owners.has(event.agent))
        delete tools[tool];
  };

  /**
   * Plan C-9 (D-TL4, E-3): on a root `open-gajae` request while the goal is
   * active, the goal context is added unless the request already carries it
   * as a single-part user text, compared exactly as the host's Plan reminder
   * does (`core/src/plugin/plan.ts:55-75,115-121`): once per goal, and again
   * after a compaction drops it. It goes before the user's prompt and is kept
   * as a `synthetic({ resume: false })` message (R12: the default `steer`
   * delivery may run one more model step).
   */
  const context: RalplanHooks["context"] = async (event) => {
    hideTools(event);
    try {
      const sessionID = event.sessionID;
      const messages = event.messages;
      if (event.agent !== PRIMARY_AGENT) return;
      if (typeof sessionID !== "string" || !Array.isArray(messages)) return;
      if ((await rootSession(sessionID)) !== sessionID) return;
      const text = await goal.contextText(sessionID);
      if (text === undefined) return;
      const present = messages.some((message) => {
        const part =
          message.role === "user" && message.content.length === 1
            ? message.content[0]
            : undefined;
        return part?.type === "text" && part.text === text;
      });
      if (present) return;
      const at =
        messages.at(-1)?.role === "user" ? messages.length - 1 : messages.length;
      messages.splice(at, 0, { role: "user", content: [{ type: "text", text }] });
      try {
        await session.synthetic({
          sessionID,
          text,
          description: GOAL_CONTEXT_DESCRIPTION,
          resume: false,
        });
      } catch (error) {
        log("goal context synthetic failed", error);
      }
    } catch (error) {
      log("goal context injection failed", error);
    }
  };

  /**
   * DR-17: the root's ultragoal recovery context (`src/goal/hooks.ts`), then
   * the root's deep-interview context while it is the visible primary skill,
   * active on `interviewing` or `handoff` (deep-interview DR-22, E-6), then
   * (D-H2/AC19) the active ralplan run's recovery contract — gjc's
   * projection of the newest final (else planner/revision) stage file,
   * verified against its ledger sha256, and render
   * (`./ralplan-runtime/recovery.ts`). Nothing is added for a missing,
   * unreadable, inactive or unknown-phase ralplan state (DR-21) or a failed
   * projection. Stage files are read through the transaction, confined to
   * the run folder.
   */
  const compaction: RalplanHooks["compaction"] = async (event) => {
    try {
      if ((await rootSession(event.sessionID)) === event.sessionID) {
        const text = await goal.ultragoalCompaction(event.sessionID);
        if (text !== undefined) event.system.push({ type: "text", text });
      }
    } catch (error) {
      log("ultragoal compaction context failed", error);
    }
    try {
      if ((await rootSession(event.sessionID)) === event.sessionID) {
        const text = await deepInterview.compactionText(event.sessionID);
        if (text !== undefined) event.system.push({ type: "text", text });
      }
    } catch (error) {
      log("deep-interview compaction context failed", error);
    }
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
      // PQ-21 A: every execution end clears the turn marker before anything
      // decides on it; the next execution is a new turn.
      if (EXECUTION_ENDS.has(type)) turnSkill.delete(sessionID);
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
      // `failed` does not continue; only a lineage root continues (C-2, E-4).
      if (type === "session.execution.succeeded" && info.parentID === undefined)
        await continueSession(sessionID);
      // The next `started` counts afresh; a finished session keeps no entry.
      if (type !== "session.execution.started") toolCalls.delete(sessionID);
    } catch (error) {
      log("execution event handler failed", error);
    }
  };

  return {
    rootSession,
    prompt,
    context,
    hideTools,
    compaction,
    executeBefore,
    executeAfter,
    onEvent,
  };
}
