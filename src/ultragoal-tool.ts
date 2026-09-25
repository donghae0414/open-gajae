// The `ultragoal` tool: the only writer of goals.json, progress.txt and the
// ultragoal state (plan §4). Every op body runs inside one
// `StateStore.ultragoalTransaction`, so ops and hook patches never interleave;
// parent-session lookups and the ralplan seed after `handoff` run outside it.
//
// Source: oh-my-claudecode v5.4.0 (MIT) `src/hooks/ralph/prd.ts` (story
// completion, criterion amendments) and `verifier.ts` (reviewer approval),
// with approval recorded by the reviewer through `record_verdict` instead of a
// parsed tag (D-R12). gajae-code (reference only) for `handoff`.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { seedState as seedRalplanState } from "./ralplan.js";
import {
  RALPLAN_MODE,
  type InterviewState,
  type StateStore,
  type UltragoalTx,
} from "./state.js";
import { defineTool, type ToolCallContext } from "./tools/define.js";
import {
  addProgressPattern,
  appendProgressEntry,
  appendProgressNote,
  effectivePasses,
  effectiveVerified,
  FINAL_TARGET,
  type Goal,
  goalRequest,
  type GoalsFile,
  goalStatusLabel,
  goalsSummary,
  governingRevision,
  initialProgress,
  isCompleteFile,
  isRalplanRunning,
  isRequestCurrent,
  isSubstantive,
  isUltragoalRunning,
  LIMITS,
  mergeState,
  nextGoalId,
  orderedGoals,
  parseGoals,
  prdRevision,
  derivePhase,
  requestOf,
  seedUltragoalState,
  serializeGoals,
  type VerificationRequest,
} from "./ultragoal.js";

const PRIMARY = "open-gajae";
const NOT_RUNNING =
  "ultragoal is not running in this session; call `ultragoal start(reason)` first";
const ARCHITECT = "open-gajae-architect";
const CRITIC = "open-gajae-critic";

export type UltragoalToolDeps = {
  /** `src/hooks.ts` `parentSession`: fail-closed parent lookup (plan §4). */
  parentSession(sessionID: string): Promise<string | undefined>;
};

const goalInput = z.object({
  title: z.string(),
  description: z.string(),
  priority: z.number(),
  acceptanceCriteria: z.array(z.string()),
});

const input = z.object({
  op: z
    .enum([
      "status",
      "start",
      "create",
      "resume",
      "add",
      "revise",
      "supersede",
      "complete",
      "add_pattern",
      "request_final_review",
      "record_verdict",
      "handoff",
      "cancel",
    ])
    .describe("The operation; see the ultragoal skill for each op's fields."),
  target: z
    .enum(["goal", "criterion"])
    .optional()
    .describe("add/revise/supersede: what the amendment changes."),
  description: z
    .string()
    .optional()
    .describe("create: the original task. add/revise (goal): the goal description."),
  goals: z
    .array(goalInput)
    .optional()
    .describe("create: goals with title, description, priority and acceptanceCriteria."),
  source_plan: z.string().optional().describe("create: approved ralplan plan path."),
  replace: z
    .boolean()
    .optional()
    .describe("create: overwrite an unfinished or invalid goals.json."),
  goal_id: z.string().optional(),
  title: z.string().optional(),
  priority: z.number().optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  criterion: z.string().optional().describe("add (criterion): the new criterion."),
  original: z.string().optional().describe("revise/supersede (criterion): the active criterion, verbatim."),
  replacement: z.string().optional().describe("revise (criterion): the corrected criterion."),
  reason: z.string().optional(),
  evidence: z
    .string()
    .optional()
    .describe("add/revise/supersede: the measurement behind the amendment. record_verdict: the verdict's evidence."),
  implementation: z.array(z.string()).optional(),
  files_changed: z.array(z.string()).optional(),
  learnings: z.array(z.string()).optional(),
  pattern: z.string().optional(),
  cleaner_report: z
    .object({ summary: z.string(), blocking_issues: z.array(z.string()) })
    .optional(),
  regression: z
    .array(
      z.object({
        command: z.string(),
        result: z.enum(["pass", "fail"]),
        summary: z.string(),
      }),
    )
    .optional(),
  request_id: z.string().optional(),
  verdict: z.enum(["approve", "reject"]).optional(),
  issues: z.array(z.string()).optional(),
  target_goal_ids: z.array(z.string()).optional(),
  to: z.enum(["ralplan"]).optional(),
});

type Args = z.output<typeof input>;

function now() {
  return new Date().toISOString();
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required for this op`);
  return value;
}

function checkText(value: string | undefined, name: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${name} must be a non-empty string`);
  if (value.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return value;
}

function checkList(value: string[] | undefined, name: string, max: number): string[] {
  if (!value || value.length === 0) throw new Error(`${name} needs at least one item`);
  value.forEach((item, i) => checkText(item, `${name}[${i}]`, max));
  return value;
}

/** Amendment reason and evidence (decision 9). */
function checkSubstantive(value: string | undefined, name: string, max: number) {
  const checked = checkText(value, name, max);
  if (!isSubstantive(checked))
    throw new Error(
      `${name} must be substantive: at least 5 words and 32 characters`,
    );
  return checked;
}

/** handoff/resume/cancel: required, no length rule (Q-4). */
function checkReason(value: string | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error("reason is required (a non-empty string)");
  return value.trim();
}

function checkPriority(value: number | undefined): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1)
    throw new Error("priority must be an integer >= 1");
  return value;
}

function checkCriteria(value: string[] | undefined, name: string): string[] {
  const criteria = checkList(value, name, LIMITS.text);
  if (new Set(criteria).size !== criteria.length)
    throw new Error(`${name} has duplicate criteria`);
  return criteria;
}

function goalOf(file: GoalsFile, id: string | undefined): Goal {
  const goal = file.goals.find((candidate) => candidate.id === id);
  if (!goal) throw new Error(`unknown goal_id ${String(id)}`);
  if (goal.status !== "active") throw new Error(`${goal.id} is superseded`);
  return goal;
}

function goalDefinition(goal: Pick<Goal, "title" | "description" | "priority">) {
  return JSON.stringify({
    title: goal.title,
    description: goal.description,
    priority: goal.priority,
  });
}

/** Criteria text once amended away cannot come back (ledger invariant). */
function checkNewCriterion(goal: Goal, criterion: string) {
  if (goal.acceptanceCriteria.includes(criterion))
    throw new Error(`${goal.id} already has this criterion`);
  if (
    goal.amendments.some(
      (a) => a.target === "criterion" && a.kind !== "added" && a.original === criterion,
    )
  )
    throw new Error(`${goal.id} already amended this criterion away; word it differently`);
}

async function readGoals(tx: UltragoalTx) {
  return parseGoals(await tx.readFile("goals.json"));
}

async function readValidGoals(tx: UltragoalTx): Promise<GoalsFile> {
  const goals = await readGoals(tx);
  if (goals.kind === "missing")
    throw new Error("no goals.json yet; call create first");
  if (goals.kind === "invalid")
    throw new Error(
      `goals.json is invalid (${goals.error}); recreate it with create and replace: true`,
    );
  return goals.file;
}

async function appendNote(
  tx: UltragoalTx,
  label: "START" | "HANDOFF" | "RESUME" | "CANCEL",
  reason: string,
  at: string,
) {
  const progress = (await tx.readFile("progress.txt")) ?? initialProgress(at);
  await tx.writeFile("progress.txt", appendProgressNote(progress, label, reason, at));
}

export function ultragoalTool(store: StateStore, deps: UltragoalToolDeps) {
  /**
   * The ultragoal session an actor works on: the primary's own session, or a
   * reviewer's parent (fail closed). Every other role is refused (plan §4).
   */
  async function targetSession(
    context: Pick<ToolCallContext, "agent" | "sessionID">,
    op: Args["op"],
  ): Promise<string> {
    if (typeof context.sessionID !== "string" || context.sessionID.length === 0)
      throw new Error("a native session is required");
    if (context.agent === PRIMARY) return context.sessionID;
    // Reviewers only read; the leader records their verdict (decision P-5).
    if (context.agent === ARCHITECT || context.agent === CRITIC) {
      if (op !== "status")
        throw new Error(
          `${context.agent} may only use status; return your verdict in your final response and the leader records it`,
        );
      let parent: string | undefined;
      try {
        parent = await deps.parentSession(context.sessionID);
      } catch (error) {
        throw new Error("could not resolve the reviewer's parent session", {
          cause: error,
        });
      }
      if (parent === undefined)
        throw new Error("the reviewer must run as a subagent of the ultragoal session");
      return parent;
    }
    throw new Error(`the ultragoal tool is not available to ${context.agent}`);
  }

  async function status(tx: UltragoalTx): Promise<string> {
    const state = await tx.readState();
    const goals = await readGoals(tx);
    const file = goals.kind === "valid" ? goals.file : undefined;
    const request = requestOf(state);
    return JSON.stringify(
      {
        paths: { goals: tx.paths.goalsPath, progress: tx.paths.progressPath },
        state: state
          ? {
              active: state.active,
              awaiting_confirmation: state.awaiting_confirmation,
              current_phase: state.current_phase,
              iteration: state.iteration,
              max_iterations: state.max_iterations,
              prd_created_at: state.prd_created_at,
              paused_reason: state.paused_reason,
              deactivated_reason: state.deactivated_reason,
              reject_counts: state.reject_counts,
            }
          : null,
        phase: state ? derivePhase(state, goals).kind : null,
        goals_file:
          goals.kind === "valid"
            ? { valid: true, complete: isCompleteFile(goals.file), prd_revision: prdRevision(goals.file) }
            : { valid: false, ...(goals.kind === "invalid" ? { error: goals.error } : { missing: true }) },
        goals: file
          ? orderedGoals(file).map((goal) => ({
              id: goal.id,
              title: goal.title,
              priority: goal.priority,
              status: goalStatusLabel(goal),
              passes: effectivePasses(goal),
              verified: effectiveVerified(goal),
              criteria_revision: governingRevision(goal),
              acceptanceCriteria: goal.acceptanceCriteria,
            }))
          : [],
        pending_request:
          request && file && isRequestCurrent(request, file)
            ? { request_id: request.request_id, goal_id: request.goal_id, reviewer: request.reviewer }
            : null,
      },
      null,
      2,
    );
  }

  async function create(tx: UltragoalTx, args: Args): Promise<string> {
    const state = await tx.readState();
    if (state?.active === true && state.awaiting_confirmation === true)
      throw new Error("the ultragoal seed is not confirmed yet; call `ultragoal start(reason)` first");
    if (!isUltragoalRunning(state))
      throw new Error(NOT_RUNNING);
    const existing = await readGoals(tx);
    if (typeof state!.prd_created_at === "string" && existing.kind === "valid")
      throw new Error("this run already has goals; use add/revise/supersede");
    if (
      (existing.kind === "invalid" ||
        (existing.kind === "valid" && !isCompleteFile(existing.file))) &&
      args.replace !== true
    )
      throw new Error(
        existing.kind === "invalid"
          ? "the existing goals.json is invalid; pass replace: true to recreate it"
          : "an unfinished goals.json exists; call resume to continue it, or create with replace: true to start over",
      );
    const description = checkText(args.description, "description", LIMITS.text);
    if (args.source_plan !== undefined)
      checkText(args.source_plan, "source_plan", LIMITS.sourcePlan);
    const inputs = args.goals ?? [];
    if (inputs.length === 0) throw new Error("goals needs at least one goal");
    if (inputs.length > 999) throw new Error("at most 999 goals");
    const at = now();
    const goals: Goal[] = inputs.map((goal, i) => ({
      id: `G${String(i + 1).padStart(3, "0")}`,
      title: checkText(goal.title, `goals[${i}].title`, LIMITS.title),
      description: checkText(goal.description, `goals[${i}].description`, LIMITS.text),
      priority: checkPriority(goal.priority),
      status: "active",
      acceptanceCriteria: checkCriteria(goal.acceptanceCriteria, `goals[${i}].acceptanceCriteria`),
      amendments: [],
      passes: false,
      verified: false,
    }));
    const file: GoalsFile = {
      version: 1,
      description,
      ...(args.source_plan ? { source_plan: args.source_plan } : {}),
      created_at: at,
      goals,
    };
    await tx.writeFile("goals.json", serializeGoals(file));
    await tx.writeFile("progress.txt", initialProgress(at));
    await tx.writeState(
      mergeState(state, {
        prd_created_at: at,
        verification_request: undefined,
        reject_counts: undefined,
        last_rejections: undefined,
      }),
      "ultragoal_tool",
    );
    const replaced =
      existing.kind === "valid" ? ` Replaced the previous goals.json (${existing.file.goals.length} goals).` : "";
    return `Created goals.json with ${goals.length} goal(s).${replaced}\n${goalsSummary(file)}\nNext: implement ${orderedGoals(file)[0].id}, then call complete.`;
  }

  /**
   * The model's own way in (decision P-6), as OMC's ralph starts from a model
   * `state_write`: a confirmed seed, or the confirmation of a pending one.
   */
  async function start(
    tx: UltragoalTx,
    args: Args,
    ralplan: InterviewState | undefined,
  ): Promise<string> {
    const reason = checkReason(args.reason);
    if (isRalplanRunning(ralplan))
      throw new Error(
        'ralplan planning is running; finish it first: choose "Execute via ultragoal" at its approval step, or stop ralplan and call start again',
      );
    const state = await tx.readState();
    if (isUltragoalRunning(state))
      throw new Error("ultragoal is already running in this session");
    const at = now();
    await appendNote(tx, "START", reason, at);
    await tx.writeState(
      state?.active === true
        ? mergeState(state, { awaiting_confirmation: false })
        : seedUltragoalState(undefined, at, { awaiting: false, task: reason })!,
      "ultragoal_tool",
    );
    return "Ultragoal started. Next: call `ultragoal status`, then `create` the goals (or `resume` an unfinished goals.json).";
  }

  async function resume(
    tx: UltragoalTx,
    args: Args,
    ralplan: InterviewState | undefined,
  ): Promise<string> {
    const reason = checkReason(args.reason);
    if (isRalplanRunning(ralplan))
      throw new Error(
        'ralplan planning is running; finish it first: choose "Execute via ultragoal" at its approval step, or stop ralplan and call resume again',
      );
    const goals = await readGoals(tx);
    if (goals.kind !== "valid")
      throw new Error(
        goals.kind === "missing"
          ? "there is no goals.json to resume; call create"
          : `goals.json is invalid (${goals.error}); recreate it with create and replace: true`,
      );
    if (isCompleteFile(goals.file))
      throw new Error("the previous run is complete; call create to start a new run");
    const state = await tx.readState();
    const resumable =
      state === undefined ||
      state.current_phase === "handoff" ||
      (state.active === true && typeof state.prd_created_at !== "string");
    if (!resumable)
      throw new Error(
        state.active === true
          ? "this run already has goals; continue it"
          : "this ultragoal state cannot be resumed; start ultragoal again with the keyword or @ultragoal",
      );
    const at = now();
    await appendNote(tx, "RESUME", reason, at);
    const base =
      state === undefined
        ? seedUltragoalState(undefined, at, { awaiting: false })!
        : { active: true, current_phase: "ultragoal", awaiting_confirmation: false };
    await tx.writeState(
      mergeState(state, {
        ...base,
        prd_created_at: at,
        handoff_to: undefined,
        handoff_at: undefined,
        verification_request: undefined,
        paused_reason: undefined,
        paused_target: undefined,
        deactivated_reason: undefined,
      }),
      "ultragoal_tool",
    );
    return `Resumed the unfinished goals.json.\n${goalsSummary(goals.file)}\nIf there is a new plan, merge it with add/revise/supersede (reason and evidence); keep completed and verified goals as they are.`;
  }

  async function amend(
    tx: UltragoalTx,
    args: Args,
    authority: string,
  ): Promise<string> {
    const state = await tx.readState();
    if (typeof state?.prd_created_at !== "string")
      throw new Error("no goals for this run yet; call create or resume first");
    const file = await readValidGoals(tx);
    const target = required(args.target, "target");
    const reason = checkSubstantive(args.reason, "reason", LIMITS.text);
    const evidence = checkSubstantive(args.evidence, "evidence", LIMITS.evidence);
    const at = now();
    const entry = { reason, evidence, authority, timestamp: at };
    let touched: string;
    let summary: string;

    if (args.op === "add" && target === "goal") {
      const goal: Goal = {
        id: nextGoalId(file),
        title: checkText(args.title, "title", LIMITS.title),
        description: checkText(args.description, "description", LIMITS.text),
        priority: checkPriority(args.priority),
        status: "active",
        acceptanceCriteria: checkCriteria(args.acceptanceCriteria, "acceptanceCriteria"),
        amendments: [],
        passes: false,
        verified: false,
      };
      goal.amendments.push({
        target: "goal",
        kind: "added",
        replacement: goalDefinition(goal),
        ...entry,
      });
      file.goals.push(goal);
      touched = goal.id;
      summary = `Added ${goal.id}.`;
    } else {
      const goal = goalOf(file, args.goal_id);
      touched = goal.id;
      if (args.op === "add") {
        const criterion = checkText(args.criterion, "criterion", LIMITS.text);
        checkNewCriterion(goal, criterion);
        goal.acceptanceCriteria.push(criterion);
        goal.amendments.push({ target: "criterion", kind: "added", replacement: criterion, ...entry });
        summary = `Added a criterion to ${goal.id}.`;
      } else if (args.op === "revise" && target === "goal") {
        if (args.title === undefined && args.description === undefined && args.priority === undefined)
          throw new Error("revise (goal) needs title, description or priority");
        const original = goalDefinition(goal);
        if (args.title !== undefined) goal.title = checkText(args.title, "title", LIMITS.title);
        if (args.description !== undefined)
          goal.description = checkText(args.description, "description", LIMITS.text);
        if (args.priority !== undefined) goal.priority = checkPriority(args.priority);
        goal.amendments.push({
          target: "goal",
          kind: "revised",
          original,
          replacement: goalDefinition(goal),
          ...entry,
        });
        summary = `Revised ${goal.id}.`;
      } else if (args.op === "revise") {
        const original = required(args.original, "original");
        const index = goal.acceptanceCriteria.indexOf(original);
        if (index === -1)
          throw new Error(`original must match an active criterion of ${goal.id} exactly`);
        const replacement = checkText(args.replacement, "replacement", LIMITS.text);
        checkNewCriterion(goal, replacement);
        goal.acceptanceCriteria[index] = replacement;
        goal.amendments.push({ target: "criterion", kind: "revised", original, replacement, ...entry });
        summary = `Revised a criterion of ${goal.id}.`;
      } else if (target === "goal") {
        if (orderedGoals(file).length === 1)
          throw new Error("cannot supersede the last active goal");
        goal.status = "superseded";
        goal.amendments.push({ target: "goal", kind: "superseded", original: goalDefinition(goal), ...entry });
        summary = `Superseded ${goal.id}.`;
      } else {
        const original = required(args.original, "original");
        const index = goal.acceptanceCriteria.indexOf(original);
        if (index === -1)
          throw new Error(`original must match an active criterion of ${goal.id} exactly`);
        if (goal.acceptanceCriteria.length === 1)
          throw new Error(
            `cannot supersede the last active criterion of ${goal.id}; use revise to replace it, or supersede the goal if it is no longer needed`,
          );
        goal.acceptanceCriteria.splice(index, 1);
        goal.amendments.push({ target: "criterion", kind: "superseded", original, ...entry });
        summary = `Superseded a criterion of ${goal.id}.`;
      }
    }
    await tx.writeFile("goals.json", serializeGoals(file));
    const request = requestOf(state);
    const drop =
      request !== undefined &&
      (request.goal_id === touched || request.goal_id === FINAL_TARGET);
    if (drop)
      await tx.writeState(mergeState(state, { verification_request: undefined }), "ultragoal_tool");
    return `${summary} The ledger keeps the original.${drop ? ` The pending ${request!.goal_id} verification request was withdrawn.` : ""}`;
  }

  async function complete(tx: UltragoalTx, args: Args): Promise<string> {
    const state = await tx.readState();
    if (typeof state?.prd_created_at !== "string")
      throw new Error("no goals for this run yet; call create or resume first");
    const file = await readValidGoals(tx);
    const goal = goalOf(file, args.goal_id);
    if (effectivePasses(goal)) throw new Error(`${goal.id} is already complete`);
    const pending = requestOf(state);
    if (pending && isRequestCurrent(pending, file))
      throw new Error(
        `finish the pending ${pending.goal_id} verification first (request_id ${pending.request_id})`,
      );
    const implementation = checkList(args.implementation, "implementation", LIMITS.text);
    const files = checkList(args.files_changed, "files_changed", LIMITS.text);
    const learnings = checkList(args.learnings, "learnings", LIMITS.text);
    const at = now();
    goal.passes = true;
    goal.completionCriteriaRevision = governingRevision(goal);
    goal.completed_at = at;
    goal.verified = false;
    delete goal.verificationCriteriaRevision;
    delete goal.verified_at;
    delete goal.verification_evidence;
    await tx.writeFile("goals.json", serializeGoals(file));
    const progress = (await tx.readFile("progress.txt")) ?? initialProgress(at);
    await tx.writeFile(
      "progress.txt",
      appendProgressEntry(
        progress,
        { goalId: goal.id, implementation, filesChanged: files, learnings },
        at,
      ),
    );
    const request = goalRequest(goal, state, at, randomUUID());
    await tx.writeState(mergeState(state, { verification_request: request }), "ultragoal_tool");
    return `${goal.id} marked complete; verification request_id "${request.request_id}" created. Now that this complete result has returned, call \`subagent\` with agent \`open-gajae-architect\` in a NEW session; do not call it in parallel with complete in the same step. The plugin appends the verification brief. When the Architect returns, record its verdict with \`ultragoal\` \`record_verdict\` (request_id, goal_id, verdict, evidence, issues).`;
  }

  async function addPattern(tx: UltragoalTx, args: Args): Promise<string> {
    const pattern = checkText(args.pattern, "pattern", LIMITS.pattern);
    if (/[\r\n]/.test(pattern)) throw new Error("pattern must be a single line");
    const progress = await tx.readFile("progress.txt");
    if (progress === undefined) throw new Error("no progress.txt yet; call create first");
    await tx.writeFile("progress.txt", addProgressPattern(progress, pattern.trim()));
    return "Pattern added to progress.txt.";
  }

  async function requestFinalReview(tx: UltragoalTx, args: Args): Promise<string> {
    const state = await tx.readState();
    if (typeof state?.prd_created_at !== "string")
      throw new Error("no goals for this run yet; call create or resume first");
    const file = await readValidGoals(tx);
    const pending = requestOf(state);
    if (pending && isRequestCurrent(pending, file))
      throw new Error(`a ${pending.goal_id} verification request is already pending`);
    const unverified = orderedGoals(file).filter((goal) => !effectiveVerified(goal));
    if (unverified.length > 0)
      throw new Error(
        `every goal must be verified first; not yet: ${unverified.map((g) => g.id).join(", ")}`,
      );
    const report = required(args.cleaner_report, "cleaner_report");
    checkText(report.summary, "cleaner_report.summary", LIMITS.text);
    if (report.blocking_issues.length > 0)
      throw new Error("fix the cleaner's blocking issues and re-run it before the final review");
    const regression = required(args.regression, "regression");
    if (regression.length === 0) throw new Error("regression needs at least one command");
    regression.forEach((r, i) => {
      checkText(r.command, `regression[${i}].command`, LIMITS.text);
      checkText(r.summary, `regression[${i}].summary`, LIMITS.text);
    });
    const failed = regression.filter((r) => r.result !== "pass");
    if (failed.length > 0)
      throw new Error(`regression must pass first: ${failed.map((r) => r.command).join(", ")}`);
    const counts = (state!.reject_counts as Record<string, number> | undefined) ?? {};
    const request: VerificationRequest = {
      request_id: randomUUID(),
      goal_id: FINAL_TARGET,
      reviewer: CRITIC,
      criteria_revision: prdRevision(file),
      attempt: (counts[FINAL_TARGET] ?? 0) + 1,
      created_at: now(),
      cleaner_report: report,
      regression,
    };
    await tx.writeState(mergeState(state, { verification_request: request }), "ultragoal_tool");
    return `Final review request_id "${request.request_id}" created. Now call \`subagent\` with agent \`open-gajae-critic\` in a NEW session; the plugin appends the verification brief. When the Critic returns, record its verdict with \`ultragoal\` \`record_verdict\` (request_id, goal_id "final", verdict, evidence, issues, target_goal_ids on a reject).`;
  }

  /**
   * The leader transcribes the reviewer's verdict, as OMC's approval tag and
   * gajae-code's `architectReview`/`criticReview` do (decision P-5).
   */
  async function recordVerdict(tx: UltragoalTx, args: Args): Promise<string> {
    const state = await tx.readState();
    if (!isUltragoalRunning(state)) throw new Error(NOT_RUNNING);
    const request = requestOf(state);
    if (!request) throw new Error("no verification request is pending");
    const reviewer = request.reviewer;
    // ③ the one pending request.
    if (args.request_id !== request.request_id || args.goal_id !== request.goal_id)
      throw new Error("request_id and goal_id must match the pending request");
    const file = await readValidGoals(tx);
    const final = request.goal_id === FINAL_TARGET;
    // ④ the criteria revision has not changed since the request.
    const current = final ? prdRevision(file) : governingRevision(goalOf(file, request.goal_id));
    if (current !== request.criteria_revision || !isRequestCurrent(request, file))
      throw new Error("the criteria changed since this request; the leader must request verification again");
    // ⑤ one verdict with its evidence, as OMC's approval tag and gajae-code's
    // `architectReview`/`criticReview` record it: no per-criterion list.
    const verdict = required(args.verdict, "verdict");
    const evidence = checkText(args.evidence, "evidence", LIMITS.evidence);
    const issues = args.issues ?? [];
    // ⑥ approve carries no issues; reject names at least one.
    if (verdict === "approve" && issues.length > 0)
      throw new Error("approve requires no issues; reject instead");
    if (verdict === "reject" && issues.length === 0)
      throw new Error("reject requires at least one issue");
    issues.forEach((issue, i) => checkText(issue, `issues[${i}]`, LIMITS.text));

    const at = now();
    const target = request.goal_id;
    const counts = { ...((state!.reject_counts as Record<string, number> | undefined) ?? {}) };
    const rejections = {
      ...((state!.last_rejections as Record<string, Record<string, unknown>> | undefined) ?? {}),
    };
    const reopen = (goal: Goal) => {
      goal.passes = false;
      goal.verified = false;
      delete goal.completionCriteriaRevision;
      delete goal.verificationCriteriaRevision;
      delete goal.completed_at;
      delete goal.verified_at;
      delete goal.verification_evidence;
    };

    if (verdict === "approve" && final) {
      file.final_approval = { prd_revision: current, approved_at: at, evidence };
      await tx.writeFile("goals.json", serializeGoals(file));
      await tx.writeState(
        mergeState(state, {
          active: false,
          current_phase: "complete",
          completed_at: at,
          verification_request: undefined,
          reject_counts: undefined,
          last_rejections: undefined,
        }),
        "ultragoal_tool",
      );
      return "Final approval recorded. The ultragoal run is complete.";
    }
    if (verdict === "approve") {
      const goal = goalOf(file, target);
      goal.verified = true;
      goal.verificationCriteriaRevision = current;
      goal.verified_at = at;
      goal.verification_evidence = evidence;
      delete counts[target];
      delete rejections[target];
    } else {
      const reopened: string[] = [];
      if (final) {
        for (const id of args.target_goal_ids ?? []) {
          const goal = goalOf(file, id);
          reopen(goal);
          reopened.push(goal.id);
          rejections[goal.id] = { issues, reviewer, at };
        }
      } else {
        reopen(goalOf(file, target));
        reopened.push(target);
      }
      counts[target] = (counts[target] ?? 0) + 1;
      rejections[target] = {
        issues,
        reviewer,
        at,
        ...(final ? { target_goal_ids: reopened } : {}),
      };
    }
    await tx.writeFile("goals.json", serializeGoals(file));
    await tx.writeState(
      mergeState(state, {
        verification_request: undefined,
        reject_counts: Object.keys(counts).length ? counts : undefined,
        last_rejections: Object.keys(rejections).length ? rejections : undefined,
      }),
      "ultragoal_tool",
    );
    return `Verdict recorded: ${verdict} for ${target}.`;
  }

  async function handoff(tx: UltragoalTx, args: Args): Promise<string> {
    if (args.to !== "ralplan") throw new Error('to must be "ralplan"');
    const reason = checkReason(args.reason);
    const state = await tx.readState();
    if (state?.active !== true || state.current_phase !== "ultragoal")
      throw new Error("ultragoal is not active in this session");
    const at = now();
    await appendNote(tx, "HANDOFF", reason, at);
    await tx.writeState(
      mergeState(state, {
        active: false,
        current_phase: "handoff",
        handoff_to: "ralplan",
        handoff_at: at,
        verification_request: undefined,
      }),
      "ultragoal_tool",
    );
    return at;
  }

  async function cancel(tx: UltragoalTx, args: Args): Promise<string> {
    const reason = checkReason(args.reason);
    const state = await tx.readState();
    if (!state) throw new Error("there is no ultragoal state in this session");
    await appendNote(tx, "CANCEL", reason, now());
    await tx.deleteState();
    return "Ultragoal cancelled. The state was removed; goals.json and progress.txt are kept, so a later run can resume them.";
  }

  return defineTool({
    name: "ultragoal",
    permission: "ultragoal",
    description:
      "Operate this session's ultragoal run (the OMC ralph port): status, start, create, resume, add/revise/supersede goals or criteria, complete, add_pattern, request_final_review, record_verdict (the leader records the reviewer's verdict), handoff to ralplan, cancel. The only way to change ultragoal files and state.",
    input,
    async execute(args, context) {
      const session = await targetSession(context, args.op);
      if (args.op === "resume" || args.op === "start") {
        const ralplan = await store.read(session, RALPLAN_MODE).catch(() => undefined);
        const op = args.op === "start" ? start : resume;
        return store.ultragoalTransaction(session, (tx) => op(tx, args, ralplan));
      }
      if (args.op === "handoff") {
        const at = await store.ultragoalTransaction(session, (tx) => handoff(tx, args));
        // After the transaction: the ralplan queue is a different key. Seeded
        // confirmed, as gajae-code's handoff raises the callee's state.
        await store.patch(
          session,
          seedRalplanState(undefined, at, { awaiting: false })!,
          RALPLAN_MODE,
        );
        return "Handed off to ralplan: ultragoal is paused (goals and progress kept) and ralplan is active. Load the `ralplan` skill now. When the plan is approved, choose Execute via ultragoal and call resume.";
      }
      return store.ultragoalTransaction(session, async (tx) => {
        switch (args.op) {
          case "status":
            return status(tx);
          case "record_verdict":
            return recordVerdict(tx, args);
          case "cancel":
            return cancel(tx, args);
        }
        // Every remaining op needs a running loop (plan §4 common rule), except
        // `create`, which checks it itself.
        if (args.op !== "create" && !isUltragoalRunning(await tx.readState()))
          throw new Error(NOT_RUNNING);
        switch (args.op) {
          case "create":
            return create(tx, args);
          case "add":
          case "revise":
          case "supersede":
            return amend(tx, args, session);
          case "complete":
            return complete(tx, args);
          case "add_pattern":
            return addPattern(tx, args);
          case "request_final_review":
            return requestFinalReview(tx, args);
        }
        throw new Error(`unknown op ${String(args.op)}`);
      });
    },
  });
}
