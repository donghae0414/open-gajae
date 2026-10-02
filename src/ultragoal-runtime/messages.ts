// Ultragoal tool texts: the goal's fixed objective, the refusals and notices,
// and the gjc human-readable result renderers of plan C-14 (PQ-18 B). Pure.
// Renderers return the text without a trailing newline; a refusal is thrown
// as an `Error` whose message the tool prints after `Error: `.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/goal-mode-request.ts:21-22` (`DEFAULT_ULTRAGOAL_OBJECTIVE`)
// - `gjc-runtime/state-renderer.ts:251-289` (`renderUltragoalStatusMarkdown`)
// - `gjc-runtime/ultragoal-runtime.ts:3538-3556` (complete-checkpoint start
//   refusals), `:3584` (no plan), `:3586,3865` (unknown goal), `:3594`
//   (evidence), `:3869-3877` (`requireGoalStatus`), `:4192-4198` (only
//   remaining required goal), `:4654-4669` (review-blocker cap),
//   `:5143-5183` (`renderCompleteHandoff` text), `:5185-5227`
//   (`renderCheckpointContinuation` text), `:5249` (steering), `:5410`
//   (create), `:5534-5539` (quality-gate list), `:5576` (review blockers),
//   `:5595` (blocker classification), `:5623` (critic verdict)
// - `gjc-runtime/cli-write-receipt.ts:25-31` (`renderCliWriteReceipt`)
// - `tools/skill.ts:205-209` (chain refusal),
//   `skill-state/workflow-mutation-guard.ts:28-29` (goal-planning block),
//   `prompts/agents/executor.md:34-46` (red-team fragment)
// Deviations (plan §7.1):
// - 41: gjc command names become op calls (`ultragoal next`,
//   `ultragoal record_review_blockers` …) and `checkpoint requires=` names the
//   open-gajae gate; open-gajae adds lines gjc has not: `status`'s
//   `run_complete`, `goal` and `## goals` (with receipt states and criterion
//   IDs), `next`'s `criteria=` and reopen hint, checkpoint's `Criteria:`,
//   `Run not complete:` and `Reopened` lines, steering and review-blocker ids,
//   the critic streak, and the reopen hint in plan-change refusals (C-15).
// - 42: the fixed objective names the real session paths and says goals and
//   description for stories and brief (PQ-12 A); "GJC goal"/"story" in the
//   checkpoint text read "goal" likewise.
// - 10: `status` has no nudge line.
// - 12 (D-TL10): `create` says when another open goal keeps the plan's goal
//   from being armed.
// - 20 (D-VF11): the red-team fragment is appended by the `execute.before`
//   hook for the `[ultragoal-red-team]` marker, with the C-12 substitutions.
// - The entry notices are open-gajae text (gjc has no keyword notices).

import { wrapUltragoalInjected } from "../injection.js";
import type { GateDiagnostic } from "./gate.js";
import { CRITIC_STREAK_HOLD, type LedgerRow } from "./ledger.js";
import {
  countGoals,
  currentGoal,
  deriveRunStatus,
  FIX_CRITERION_SUFFIX,
  type Goal,
  type GoalsFile,
  type GoalStatus,
  LIMITS,
  MAX_REVIEW_BLOCKER_DESCENTS,
  type NextAction,
  type RunCompletion,
  runCompletion,
} from "./plan.js";
import { checkReceipt, receiptLabel } from "./receipt.js";
import { oneLine } from "./progress.js";

// ---------------------------------------------------------------------------
// The goal's fixed objective (PQ-12 A)
// ---------------------------------------------------------------------------

/** gjc `DEFAULT_ULTRAGOAL_OBJECTIVE` with the session folder's real paths. */
export function ultragoalGoalObjective(sessionDirName: string): string {
  const dir = `.open-gajae/${sessionDirName}/ultragoal`;
  return `Complete the durable ultragoal plan in ${dir}/goals.json, including later accepted/appended goals, under the original description constraints; use ${dir}/ledger.jsonl as the audit trail.`;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** gjc "No ultragoal plan found" with the op name. */
export const NO_PLAN = "No ultragoal plan found. Run `ultragoal create` first.";

export function unknownGoal(goalId: string): string {
  return `No ultragoal goal found for ${goalId}.`;
}

export const CHECKPOINT_EVIDENCE_REQUIRED = "checkpoint evidence is required";

/** The reopen path every plan-change refusal names (C-15, R21). */
export function reopenHint(goalId: string): string {
  return `To change it, reopen it first with ultragoal checkpoint(goal_id: "${goalId}", status: "pending", evidence), change it, then run ultragoal next and checkpoint it again.`;
}

/** gjc `requireGoalStatus` for `add`/`revise`/`supersede`, plus the reopen path. */
export function planChangeStatusRefusal(
  op: "add" | "revise" | "supersede",
  target: "goal" | "criterion",
  goal: Pick<Goal, "id" | "status">,
  allowed: readonly GoalStatus[],
): string {
  return `ultragoal ${op} (${target}) requires goal ${goal.id} status ${allowed.join(" or ")}; found ${goal.status}. ${reopenHint(goal.id)}`;
}

/** gjc `mark_blocked_superseded` last-goal refusal. */
export function onlyRequiredGoalRefusal(goalId: string): string {
  return `ultragoal supersede cannot supersede ${goalId} because it is the only remaining required goal`;
}

/** The current rule for a goal's last criterion. */
export function lastCriterionRefusal(goalId: string): string {
  return `cannot supersede the last active criterion of ${goalId}; use revise to replace it, or supersede the goal if it is no longer needed`;
}

/** gjc `validateCompleteCheckpointTargetGoal` messages. */
export function completeCheckpointRefusal(goal: Pick<Goal, "id" | "status">): string {
  if (goal.status === "pending")
    return `Cannot checkpoint ${goal.id} as complete while its durable goals.json status is pending; start the goal before completing it.`;
  if (goal.status === "complete")
    return `Cannot checkpoint ${goal.id} as complete with different evidence because its durable goals.json status is already complete.`;
  if (goal.status === "superseded")
    return `Cannot checkpoint ${goal.id} as complete because its durable goals.json status is superseded.`;
  return `Cannot checkpoint ${goal.id} as complete while its durable goals.json status is ${goal.status}; only active or retryable failed goals can be completed.`;
}

/** gjc `UltragoalReviewBlockerRecursionCapError` message. */
export function reviewBlockerCapRefusal(goalId: string, unresolvedDescents: number): string {
  return (
    `review_blocker_recursion_cap: goal ${goalId} already has ${unresolvedDescents} unresolved review_blocker descents (cap=${MAX_REVIEW_BLOCKER_DESCENTS}). ` +
    "Record a human pause/escalation or resolve existing blockers before recording more. " +
    "Unresolved technical findings are never auto-completed."
  );
}

/** E-24: the fix goal's criterion must fit `LIMITS.text`. */
export const OBJECTIVE_TOO_LONG = `objective exceeds ${LIMITS.objective} characters; the fix goal's criterion "<objective>${FIX_CRITERION_SUFFIX}" must fit ${LIMITS.text}`;

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

export type GoalArming =
  | { kind: "created"; objective: string }
  | { kind: "kept"; status: string }
  | { kind: "not-armed"; status: string; source: string };

/** D-TL10: the `create` line on the goal. */
export function goalArmingLine(arming: GoalArming): string {
  switch (arming.kind) {
    case "created":
      return `Goal armed: ${arming.objective}`;
    case "kept":
      return `Goal armed: the open ultragoal goal (${arming.status}) already tracks this plan.`;
    case "not-armed":
      return `Goal not armed: another goal is open (${arming.status}, source ${arming.source}). Run goal drop, then ultragoal create again to arm this plan's goal.`;
  }
}

/** I-10: `clear` leaves the goal; the result says how to end it. */
export function goalDropNotice(status: string): string {
  return `The goal is still ${status}; run goal drop to end it.`;
}

export const PATTERN_ADDED = "Pattern added to progress.txt.";

// ---------------------------------------------------------------------------
// Entry, guards and red-team (plan C-10, D-HE3~6, D-VF11)
// ---------------------------------------------------------------------------

/** D-HE4: the keyword gets a notice only; loading the skill seeds the state. */
export function ultragoalKeywordNotice(): string {
  return wrapUltragoalInjected(
    "<ultragoal-notice>",
    "[MODE: ULTRAGOAL] Persistent goal execution requested. Load the `ultragoal` skill and follow it for this request.",
  );
}

/**
 * D-HE4: the `@ultragoal` mention attaches the skill text but makes no `skill`
 * call, so its notice asks for the load that starts goal planning.
 */
export function ultragoalMentionNotice(): string {
  return wrapUltragoalInjected(
    "<ultragoal-notice>",
    "[MODE: ULTRAGOAL] Persistent goal execution requested through the `@ultragoal` mention. Load the `ultragoal` skill with the `skill` tool, which starts its goal-planning phase, and follow it for this request.",
  );
}

/**
 * PQ-5 (1) B: `@ralplan`, `@deep-interview` and their keywords while
 * ultragoal is the visible primary skill.
 */
export function ultragoalHandoffNotice(skill: "ralplan" | "deep-interview"): string {
  return wrapUltragoalInjected(
    "<ultragoal-notice>",
    `[ULTRAGOAL ACTIVE] ${skill} was not started because an ultragoal run is active. To switch, call ultragoal handoff(to="${skill}", reason); the goals and progress are kept and can be resumed later.`,
  );
}

/**
 * DR-23: gjc `tools/skill.ts:205-209` chain refusal with the op call for the
 * `gjc state … handoff` command. Its "finalize the current skill first" route
 * (`gjc state ultragoal write current_phase=handoff`) becomes finishing or
 * clearing the run, because the guard here follows the active row (D-HE3).
 */
export function ultragoalChainRefusal(phase: string, skill: string): string {
  return `open-gajae: refusing to chain from "ultragoal" (phase=${phase}) into "${skill}". Run ultragoal handoff(to: "${skill}", reason) directly, or finish or clear the ultragoal run first.`;
}

/**
 * DR-22: gjc `skill-state/workflow-mutation-guard.ts:28-29`
 * (`ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE`), `gjc ultragoal` →
 * `ultragoal create`.
 */
export const ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE =
  "Ultragoal goal-planning phase boundary: finish goal planning and record goals through `ultragoal create` before editing code. Product-code mutation tools and patch execution are blocked until goal planning completes and execution begins.";

/** D-VF11: the marker a `subagent(open-gajae-executor)` prompt carries. */
export const ULTRAGOAL_RED_TEAM_MARKER = "[ultragoal-red-team]";

/**
 * D-VF11 (deviation 20): gjc `prompts/agents/executor.md:34-46`, the
 * `ultragoal_red_team_mode` fragment, with the host substitutions of plan
 * C-12: the marker activates it, the lightweight QA lane contract replaces
 * the `executorQa` matrix/artifact/replay sentence, a prose claim without a
 * command is not evidence (for `inlineEvidence`), `ask` → `question` with
 * findings reported to the leader (for `gjc ultragoal
 * record-review-blockers`), and "missing artifact refs" is gone.
 */
export const ULTRAGOAL_RED_TEAM_FRAGMENT = [
  "<ultragoal_red_team_mode>",
  `This mode is active because the assignment carries the \`${ULTRAGOAL_RED_TEAM_MARKER}\` marker: you are the Ultragoal completion QA/red-team lane. Without the marker, preserve ordinary Executor behavior.`,
  "",
  "When active:",
  "- Report the QA lane in the contract the assignment gives: `status` (`passed` only when every case passed), `commands` (each command you ran), `adversarialCases` (each adversarial case you tried, with its result), `evidence` and `blockers`. If the assignment omits the contract, read the QA lane contract step of the ultragoal SKILL's \"Boundary completion cohort gate\" section before producing evidence.",
  "- Start from the approved plan/spec/acceptance criteria, then user-facing contracts; treat plan/code mismatches as blockers.",
  "- Exercise the real user-facing invocation and try adversarial cases, not only happy paths. A prose claim without a command you ran is not evidence.",
  "- Do not call `question`; report unresolved decisions and findings to the leader as blockers.",
  "- Report blockers for missing plan/spec/acceptance source, contract ambiguity, plan/code mismatch, untestable surface, failed adversarial case, or shallow evidence.",
  "</ultragoal_red_team_mode>",
].join("\n");

/** The system part the compaction hook adds (marker kept, plan C-12). */
export function ultragoalCompactionMessage(lines: readonly string[]): string {
  return wrapUltragoalInjected(
    "<ultragoal-compaction-context>",
    `[ULTRAGOAL RUN ACTIVE] Keep this workflow contract in the summary; the durable ultragoal goals.json, ledger.jsonl and progress.txt are authoritative over summary prose.

${lines.join("\n")}`,
  );
}

// ---------------------------------------------------------------------------
// C-14 result renderers
// ---------------------------------------------------------------------------

/** gjc `renderCliWriteReceipt`: one JSON line, undefined fields dropped. */
export function renderWriteReceipt(receipt: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(receipt)) if (receipt[key] !== undefined) out[key] = receipt[key];
  return JSON.stringify(out);
}

/** `clear`: the receipt, then the `goal drop` notice while a goal is open. */
export function renderClear(receipt: Record<string, unknown>, openGoalStatus?: string): string {
  const text = renderWriteReceipt(receipt);
  return openGoalStatus ? `${text}\n${goalDropNotice(openGoalStatus)}` : text;
}

/** gjc `quality-gate validate` text: valid, or the diagnostic list. */
export function renderGateDiagnostics(diagnostics: readonly GateDiagnostic[]): string {
  if (diagnostics.length === 0) return "quality gate is valid.";
  return [
    `${diagnostics.length} quality-gate error(s):`,
    ...diagnostics.map((item) => `  ${item.path} [${item.code}]: ${item.message}`),
  ].join("\n");
}

function runCompleteText(run: RunCompletion): string {
  return run.complete ? "yes" : `no (${run.reason})`;
}

/**
 * gjc `renderUltragoalStatusMarkdown` over DR-1 (no nudge line), then the
 * open-gajae lines: `run_complete`, `goal`, and `## goals` with each goal's
 * receipt state and active criteria.
 */
export function renderStatus(input: {
  goalsPath: string;
  ledgerPath: string;
  file?: GoalsFile;
  rows?: readonly LedgerRow[];
  objective?: string;
  goal?: { status: string; source: string };
}): string {
  const file = input.file;
  if (!file)
    return `# ultragoal status\n\n- status: missing\n- No ultragoal plan found at ${input.goalsPath}. Run \`ultragoal create\` first.`;
  const rows = input.rows ?? [];
  const counts = Object.entries(countGoals(file))
    .map(([status, count]) => `${status}=${count}`)
    .join(" ");
  const lines = [
    "# ultragoal status",
    "",
    `- status: ${deriveRunStatus(file)}`,
    `- goals: ${file.goals.length} (${counts})`,
  ];
  if (input.objective) lines.push(`- objective: ${input.objective}`);
  const current = currentGoal(file);
  if (current) lines.push(`- current: ${current.id} (${current.status})`);
  lines.push(`- goals_path: ${input.goalsPath}`, `- ledger_path: ${input.ledgerPath}`);
  lines.push(`- run_complete: ${runCompleteText(runCompletion(file, rows))}`);
  lines.push(`- goal: ${input.goal ? `${input.goal.status} (${input.goal.source})` : "none"}`);
  lines.push("", "## goals");
  for (const goal of file.goals) {
    lines.push(`- ${goal.id} [${goal.status}] ${oneLine(goal.title)} — receipt: ${receiptLabel(checkReceipt(goal, rows))}`);
    for (const criterion of goal.acceptanceCriteria) lines.push(`  - ${criterion.id}: ${oneLine(criterion.text)}`);
  }
  return lines.join("\n");
}

/** `create`: gjc's line, then the goal-arming line (D-TL10). */
export function renderCreate(input: { goalCount: number; goalsPath: string; arming: GoalArming }): string {
  const plural = input.goalCount === 1 ? "" : "s";
  return [
    `Created ultragoal plan with ${input.goalCount} goal${plural} at ${input.goalsPath}.`,
    goalArmingLine(input.arming),
  ].join("\n");
}

const PER_GOAL_REQUIRES = "targetedVerification:passed,architectReview:CLEAR+APPROVE,criteriaCoverage:all";
const FINAL_REQUIRES = `${PER_GOAL_REQUIRES},reviewCohort:joined,criticReview:OKAY`;

function reopenLines(run: RunCompletion | undefined): string[] {
  if (!run || run.complete) return [];
  return [
    `run-complete=no reason=${run.reason}`,
    ...(run.reopenGoalId
      ? [`hint=reopen ${run.reopenGoalId} with ultragoal checkpoint(status: pending) and re-verify with the final gate`]
      : []),
  ];
}

/**
 * gjc `renderCompleteHandoff` text for `next`. `finalGate` says whether the
 * goal to execute needs the final gate (its completion view is final), and
 * `criteria` lists the IDs its gate covers (default: the goal's own); `run`
 * adds the reopen hint when every file status is complete but the run is not.
 */
export function renderNext(input: {
  action: NextAction;
  goalObjective: string;
  finalGate?: boolean;
  criteria?: readonly string[];
  run?: RunCompletion;
}): string {
  const { action } = input;
  if (action.kind === "none") return ["ultragoal complete all=true", ...reopenLines(input.run)].join("\n");
  if (action.kind === "execute-goal")
    return [
      `ultragoal next-action=execute-goal goal-id=${action.goal.id}`,
      `objective=${action.goal.description}`,
      `goal-objective=${input.goalObjective}`,
      `checkpoint requires=${input.finalGate ? FINAL_REQUIRES : PER_GOAL_REQUIRES}`,
      `criteria=${(input.criteria ?? action.goal.acceptanceCriteria.map((criterion) => criterion.id)).join(",")}`,
    ].join("\n");
  if (action.kind === "resolve-blockers" && action.blockedGoals.length > 0)
    return [
      "ultragoal next-action=resolve-blockers",
      `blocked-goal-ids=${action.blockedGoals.map((goal) => goal.id).join(",")}`,
      `blocked-statuses=${action.blockedGoals.map((goal) => `${goal.id}:${goal.status}`).join(",")}`,
      "hint=resolve blockers via ultragoal classify_blocker / ultragoal record_review_blockers / ultragoal add (or audited ultragoal supersede); blocked goals stay unschedulable",
    ].join("\n");
  if (action.kind === "retry-failed" && action.failedGoals.length > 0)
    return [
      "ultragoal next-action=retry-failed",
      `failed-goal-ids=${action.failedGoals.map((goal) => goal.id).join(",")}`,
      "hint=run `ultragoal next(retry_failed: true)` after the failure is addressed",
    ].join("\n");
  return "ultragoal next-action=resolve-blockers\nhint=no schedulable goal; inspect goals.json and ledger";
}

/** gjc `renderCheckpointContinuation` text, plus the C-14 lines. */
export function renderCheckpoint(input: {
  goalId: string;
  status: "complete" | "failed" | "blocked" | "pending";
  allComplete: boolean;
  nextGoal?: Goal;
  startedNext: boolean;
  goalObjective: string;
  run?: RunCompletion;
}): string {
  const lines = [`Checkpointed ${input.goalId} as ${input.status}.`];
  if (input.status === "complete") {
    if (input.allComplete) {
      lines.push("All ultragoal goals are complete.");
      if (input.run && !input.run.complete) lines.push(`Run not complete: ${input.run.reason}`);
    } else if (input.nextGoal) {
      lines.push(`Next ultragoal goal: ${input.nextGoal.id} — ${input.nextGoal.title}`);
      lines.push(`Objective: ${input.nextGoal.description}`);
      lines.push(`Goal objective: ${input.goalObjective}`);
      lines.push(`Criteria: ${input.nextGoal.acceptanceCriteria.map((criterion) => criterion.id).join(" ")}`);
      lines.push(
        input.startedNext
          ? "The next ultragoal goal is active; continue the current aggregate goal and checkpoint this goal when verified."
          : "Run `ultragoal next` to activate the next ultragoal goal.",
      );
    }
  } else if (input.status === "failed") {
    lines.push("Resume failed goals with `ultragoal next(retry_failed: true)` after the blocker is fixed.");
  } else if (input.status === "blocked") {
    lines.push("Blocked ultragoal work must be resolved with explicit blocker work or steering before final completion.");
  } else {
    lines.push(`Reopened ${input.goalId}; revise it, then run ultragoal next and checkpoint it again.`);
  }
  return lines.join("\n");
}

/** gjc `Accepted <kind> steering.`, plus the new or changed goal/criterion id. */
export function renderSteering(op: "add" | "revise" | "supersede", targetId: string): string {
  return `Accepted ${op} steering. target=${targetId}`;
}

/** gjc `Recorded review blockers.`, plus the fix goal's id. */
export function renderReviewBlockers(blockerGoalId: string): string {
  return `Recorded review blockers. blocker-goal-id=${blockerGoalId}`;
}

export function renderBlockerClassification(classification: string, eventId: string): string {
  return `Recorded blocker classification: ${classification} event-id=${eventId}.`;
}

/** gjc `Recorded critic verdict: …`, plus the PQ-3 streak (held at 5). */
export function renderCriticVerdict(verdict: string, terminus: string, streak: number): string {
  const held = streak >= CRITIC_STREAK_HOLD ? " — continuation held" : "";
  return `Recorded critic verdict: ${verdict} (${terminus}).\ncritic non-OKAY streak: ${streak}/${CRITIC_STREAK_HOLD}${held}`;
}
