// Ultragoal plan rules: the `goals.json` v2 schema and its fail-closed
// validator, goal and criterion IDs, `after` placement, the allowed-status
// table of plan changes and checkpoints, the run status and next goal, the
// completion view, the run-completion check, the fix-goal (review blocker)
// helpers, the substantive-evidence rule and the text limits. Pure: callers
// read and write files and pass parsed values in.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/ultragoal-runtime.ts:131-138` (the 7 goal statuses),
//   `:320-334` (terminal/schedulable sets, accepted proof statuses, the
//   substantive-evidence minimums), `:626-658` (`chooseReceiptKind`),
//   `:1096-1127` (counts, current goal, run status), `:1278-1307`
//   (`chooseNextGoal`, `getUltragoalRunCompletionState`), `:1333-1352`
//   (`resolveUltragoalCompleteNextAction`), `:3538-3556` (complete-checkpoint
//   start statuses), `:3738-3748` (a fix goal's completion supersedes its
//   `review_blocked` parent), `:3841-3843` (`nextUltragoalGoalId`),
//   `:3869-3877,4030,4086,4126,4192-4198` (steering status checks),
//   `:4218-4274` (`recordUltragoalReviewBlockers`: default title, dedup
//   before cap), `:4629-4690` (`findOpenReviewBlockerGoal`, the cap of 3,
//   `countUnresolvedReviewBlockerDescents`)
// - `gjc-runtime/ultragoal-receipt-freshness.ts:51-53` (`requiredUltragoalGoals`)
// Deviations (plan §7.1):
// - 2: goals carry `acceptanceCriteria[{id, text}]` with IDs `G00x.ACn`; a
//   revised criterion gets a new number and retired numbers are never reused
//   (PQ-22 A). `amendments[]` keep every original (D-AG6).
// - 3, 4: structured `create` input and `add`/`revise`/`supersede` + `after`
//   instead of the gjc brief and the six `steer` kinds.
// - 5 (DR-5): no "another goal holds a fresh final-aggregate receipt" branch;
//   run completion counts a final that breaks only condition 3 as per-goal
//   (PQ-14 (3)-b) and needs a valid final on the last completed goal (C-7).
// - 27, 38 (C-15, PQ-26 A): the allowed-status table below.
// - 29 (E-20): gate kind and receipt kind both come from the completion view,
//   in which a fix goal's `review_blocked` parent is already superseded.
// - 34 (PQ-19 B, 「E6」): `retry_failed` with no active goal takes the first
//   failed goal before any pending one.
// - 40 (PQ-17 C): a fix goal's one criterion is "<objective> is resolved and
//   re-verified", so `objective` is capped at 1972 characters (E-24).
// - 42 (wording): the parent's resolution evidence says "verification
//   blocker goal", where gjc says "story" (stories are goals here).
// `LIMITS` and `isSubstantive` moved here from `src/ultragoal.ts:28-38,99-106`,
// which plan S3 removed.

import { checkReceipt, completionVerificationError, isValidCompletion, type ReceiptCheck, type ReceiptKind } from "./receipt.js";
import type { CompletionVerification } from "./receipt.js";
import type { LedgerRow } from "./ledger.js";

// ---------------------------------------------------------------------------
// Limits and the substantive rule
// ---------------------------------------------------------------------------

/** The fix-goal criterion suffix (DR-6, deviation 40). */
export const FIX_CRITERION_SUFFIX = " is resolved and re-verified";

export const LIMITS = {
  title: 200,
  text: 2000,
  evidence: 4000,
  pattern: 500,
  /** E-24: `LIMITS.text` minus `FIX_CRITERION_SUFFIX` (28 characters). */
  objective: 1972,
} as const;

/** gjc `MIN_SUBSTANTIVE_EVIDENCE_WORDS/CHARS` (decision 9). */
export const MIN_SUBSTANTIVE_WORDS = 5;
export const MIN_SUBSTANTIVE_CHARS = 32;

/** At least five words and 32 characters after trimming (decision 9). */
export function isSubstantive(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.split(/\s+/).filter(Boolean).length >= MIN_SUBSTANTIVE_WORDS &&
    trimmed.length >= MIN_SUBSTANTIVE_CHARS
  );
}

// ---------------------------------------------------------------------------
// goals.json v2
// ---------------------------------------------------------------------------

/** gjc `UltragoalGoalStatus`, in gjc count order (`emptyCounts`). */
export const GOAL_STATUSES = [
  "pending",
  "active",
  "complete",
  "failed",
  "blocked",
  "review_blocked",
  "superseded",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export type Criterion = { id: string; text: string };

/**
 * One plan change, kept on the goal it touched (D-AG6). For a criterion,
 * `criterionId` is the ID acted on (added: the new one; revised or
 * superseded: the one retired) and a revision names its `replacementId`.
 * `original`/`replacement` hold the criterion text or, for a goal, its
 * definition as JSON.
 */
export type Amendment = {
  target: "goal" | "criterion";
  kind: "added" | "revised" | "superseded";
  criterionId?: string;
  replacementId?: string;
  original?: string;
  replacement?: string;
  after?: string;
  rationale: string;
  evidence: string;
  timestamp: string;
};

/** A fix goal made by `record_review_blockers` (gjc `steering`). */
export type GoalSteering = { kind: "review_blocker"; blockedGoalId: string };

export type Goal = {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  acceptanceCriteria: Criterion[];
  amendments: Amendment[];
  steering?: GoalSteering;
  evidence?: string;
  started_at?: string;
  completed_at?: string;
  completionVerification?: CompletionVerification;
};

export type GoalsFile = {
  version: 2;
  description: string;
  created_at: string;
  updated_at: string;
  goals: Goal[];
};

export type GoalsRead =
  | { kind: "missing" }
  | { kind: "invalid"; error: string }
  | { kind: "valid"; file: GoalsFile };

const GOAL_ID = /^G\d{3}$/;
const CRITERION_ID = /^(G\d{3})\.AC([1-9]\d*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function optionalText(value: unknown, max: number): boolean {
  return value === undefined || text(value, max);
}

function criterionNumber(id: string): number {
  return Number(CRITERION_ID.exec(id)?.[2] ?? 0);
}

function criterionIdError(value: unknown, goalId: string, at: string): string | undefined {
  if (typeof value !== "string") return `${at} must be a string`;
  const match = CRITERION_ID.exec(value);
  if (!match || match[1] !== goalId) return `${at} must look like ${goalId}.AC1`;
  return undefined;
}

function amendmentError(value: unknown, goalId: string, at: string): string | undefined {
  if (!isRecord(value)) return `${at} must be an object`;
  if (value.target !== "criterion" && value.target !== "goal")
    return `${at}.target must be "criterion" or "goal"`;
  if (!["added", "revised", "superseded"].includes(String(value.kind)))
    return `${at}.kind must be added, revised or superseded`;
  if (value.target === "criterion") {
    const error = criterionIdError(value.criterionId, goalId, `${at}.criterionId`);
    if (error) return error;
    if (value.kind === "revised") {
      const replacement = criterionIdError(value.replacementId, goalId, `${at}.replacementId`);
      if (replacement) return replacement;
    }
  }
  for (const key of ["original", "replacement"])
    if (value[key] !== undefined && typeof value[key] !== "string") return `${at}.${key} must be a string`;
  if (value.after !== undefined && !(typeof value.after === "string" && GOAL_ID.test(value.after)))
    return `${at}.after must look like G001`;
  if (!text(value.rationale, LIMITS.text)) return `${at}.rationale is required`;
  if (!text(value.evidence, LIMITS.evidence)) return `${at}.evidence is required`;
  if (!text(value.timestamp, 100)) return `${at}.timestamp is required`;
  return undefined;
}

function goalError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at} must be an object`;
  if (typeof value.id !== "string" || !GOAL_ID.test(value.id)) return `${at}.id must look like G001`;
  const id = value.id;
  if (!text(value.title, LIMITS.title)) return `${at}.title is invalid`;
  if (!text(value.description, LIMITS.text)) return `${at}.description is invalid`;
  if (!(GOAL_STATUSES as readonly unknown[]).includes(value.status))
    return `${at}.status must be one of ${GOAL_STATUSES.join(", ")}`;
  const criteria = value.acceptanceCriteria;
  if (!Array.isArray(criteria) || criteria.length === 0)
    return `${at}.acceptanceCriteria must be a non-empty array`;
  const active = new Set<string>();
  const texts = new Set<string>();
  for (const [index, criterion] of criteria.entries()) {
    const cat = `${at}.acceptanceCriteria[${index}]`;
    if (!isRecord(criterion)) return `${cat} must be an object`;
    const idError = criterionIdError(criterion.id, id, `${cat}.id`);
    if (idError) return idError;
    if (!text(criterion.text, LIMITS.text)) return `${cat}.text is invalid`;
    if (active.has(criterion.id as string)) return `${at} repeats criterion ${String(criterion.id)}`;
    if (texts.has(criterion.text)) return `${at}.acceptanceCriteria has duplicate text`;
    active.add(criterion.id as string);
    texts.add(criterion.text);
  }
  if (!Array.isArray(value.amendments)) return `${at}.amendments must be an array`;
  const retired = new Set<string>();
  for (const [index, amendment] of value.amendments.entries()) {
    const error = amendmentError(amendment, id, `${at}.amendments[${index}]`);
    if (error) return error;
    const entry = amendment as Amendment;
    if (entry.target !== "criterion" || entry.kind === "added") continue;
    // PQ-22 A: a retired ID is never active again and is retired only once.
    const retiredId = entry.criterionId as string;
    if (active.has(retiredId)) return `${at}: retired criterion ${retiredId} is still active`;
    if (retired.has(retiredId)) return `${at}: criterion ${retiredId} is retired more than once`;
    retired.add(retiredId);
  }
  if (value.steering !== undefined) {
    const steering = value.steering;
    if (
      !isRecord(steering) ||
      steering.kind !== "review_blocker" ||
      typeof steering.blockedGoalId !== "string" ||
      !GOAL_ID.test(steering.blockedGoalId) ||
      steering.blockedGoalId === id
    )
      return `${at}.steering must be {kind: "review_blocker", blockedGoalId} naming another goal`;
  }
  if (value.evidence !== undefined && typeof value.evidence !== "string")
    return `${at}.evidence must be a string`;
  for (const key of ["started_at", "completed_at"])
    if (!optionalText(value[key], 100)) return `${at}.${key} is invalid`;
  if (value.completionVerification !== undefined)
    return completionVerificationError(value.completionVerification, `${at}.completionVerification`);
  return undefined;
}

/** The first schema error of a parsed `goals.json`, or undefined. */
export function goalsFileError(value: unknown): string | undefined {
  if (!isRecord(value)) return "goals.json must be an object";
  if (value.version === 1)
    return "goals.json version 1 (the retired OMC ralph format) is not supported; replace it with ultragoal create";
  if (value.version !== 2) return "goals.json version must be 2";
  if (!text(value.description, LIMITS.text)) return "description is invalid";
  if (!text(value.created_at, 100)) return "created_at is invalid";
  if (!text(value.updated_at, 100)) return "updated_at is invalid";
  // I-16: a plan has at least one goal (gjc create always makes one).
  if (!Array.isArray(value.goals) || value.goals.length === 0) return "goals must be a non-empty array";
  const ids = new Set<string>();
  for (const [index, goal] of value.goals.entries()) {
    const error = goalError(goal, `goals[${index}]`);
    if (error) return error;
    const id = (goal as Goal).id;
    if (ids.has(id)) return `duplicate goal id ${id}`;
    ids.add(id);
  }
  for (const goal of value.goals as Goal[])
    if (goal.steering && !ids.has(goal.steering.blockedGoalId))
      return `${goal.id}.steering.blockedGoalId names unknown goal ${goal.steering.blockedGoalId}`;
  return undefined;
}

/** Parse `goals.json`, failing closed on anything the schema does not allow. */
export function parseGoals(raw: string | undefined): GoalsRead {
  if (raw === undefined) return { kind: "missing" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "invalid", error: "goals.json is not valid JSON" };
  }
  const error = goalsFileError(value);
  return error ? { kind: "invalid", error } : { kind: "valid", file: value as GoalsFile };
}

export function serializeGoals(file: GoalsFile): string {
  const error = goalsFileError(file);
  if (error) throw new Error(`refusing to write an invalid goals.json: ${error}`);
  return `${JSON.stringify(file, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// IDs and create
// ---------------------------------------------------------------------------

/**
 * The next goal ID. gjc numbers `goals.length + 1` (`rt:3841-3843`); the
 * largest ID + 1 is the same for every tool-written file, since goals are
 * never removed.
 */
export function nextGoalId(file: Pick<GoalsFile, "goals">): string {
  const max = Math.max(0, ...file.goals.map((goal) => Number(goal.id.slice(1))));
  if (max >= 999) throw new Error("goal IDs are exhausted (G999)");
  return `G${String(max + 1).padStart(3, "0")}`;
}

/**
 * PQ-22 A: the next criterion ID of a goal, above every number the goal ever
 * used — active criteria and the retired or replacement IDs in its amendments.
 */
export function nextCriterionId(goal: Pick<Goal, "id" | "acceptanceCriteria" | "amendments">): string {
  const used = [
    ...goal.acceptanceCriteria.map((criterion) => criterion.id),
    ...goal.amendments.flatMap((amendment) => [amendment.criterionId, amendment.replacementId]),
  ].filter((id): id is string => typeof id === "string");
  const max = Math.max(0, ...used.map(criterionNumber));
  return `${goal.id}.AC${max + 1}`;
}

export type GoalInput = { title: string; description: string; acceptanceCriteria: string[] };

/** A new pending goal with criteria `<id>.AC1..n`. */
export function newGoal(id: string, input: GoalInput): Goal {
  return {
    id,
    title: input.title,
    description: input.description,
    status: "pending",
    acceptanceCriteria: input.acceptanceCriteria.map((criterion, index) => ({
      id: `${id}.AC${index + 1}`,
      text: criterion,
    })),
    amendments: [],
  };
}

/** DR-25: the file `create` writes (G001.., every goal pending). */
export function buildGoalsFile(input: { description: string; goals: GoalInput[]; now: string }): GoalsFile {
  return {
    version: 2,
    description: input.description,
    created_at: input.now,
    updated_at: input.now,
    goals: input.goals.map((goal, index) => newGoal(`G${String(index + 1).padStart(3, "0")}`, goal)),
  };
}

// ---------------------------------------------------------------------------
// `after` placement (D-AG6)
// ---------------------------------------------------------------------------

function afterIndex(goals: readonly Goal[], after: string): number {
  const index = goals.findIndex((goal) => goal.id === after);
  if (index === -1) throw new Error(`after references unknown goal id ${after}`);
  return index;
}

/** `add(after)`: insert right after `after` (any status), else at the end. */
export function insertAfter(goals: readonly Goal[], goal: Goal, after?: string): Goal[] {
  if (after === undefined) return [...goals, goal];
  const index = afterIndex(goals, after);
  return [...goals.slice(0, index + 1), goal, ...goals.slice(index + 1)];
}

/** `revise(after)`: move `goalId` to right after `after`. */
export function moveAfter(goals: readonly Goal[], goalId: string, after: string): Goal[] {
  if (goalId === after) throw new Error(`after cannot name the goal being moved (${goalId})`);
  const moving = goals.find((goal) => goal.id === goalId);
  if (!moving) throw new Error(`No ultragoal goal found for ${goalId}.`);
  const rest = goals.filter((goal) => goal.id !== goalId);
  const index = afterIndex(rest, after);
  return [...rest.slice(0, index + 1), moving, ...rest.slice(index + 1)];
}

// ---------------------------------------------------------------------------
// Allowed statuses (C-15, PQ-26 A)
// ---------------------------------------------------------------------------

export type StatusRuleOp =
  | "add-goal"
  | "revise-goal"
  | "move-goal"
  | "supersede-goal"
  | "add-criterion"
  | "revise-criterion"
  | "supersede-criterion"
  | "checkpoint-complete"
  | "checkpoint-reopen-fail-block"
  | "record-review-blockers";

/**
 * The goal statuses each op accepts (for `add-goal`, the `after` target):
 * - wording, moves and every criterion op: `pending` only (gjc
 *   `revise_pending_wording` `rt:4126`, `reorder_pending` `rt:4086`);
 * - goal `supersede`: `pending` (gjc `split_subgoal` `rt:4030`) or
 *   `blocked`/`review_blocked` (gjc `mark_blocked_superseded` `rt:4192`);
 * - `checkpoint(complete)`: `active`/`failed` (`rt:3538-3556`);
 * - `add`, `checkpoint(pending|failed|blocked)` and `record_review_blockers`:
 *   any status (`rt:3703-3767,3964-4001,4251-4256`).
 */
export const ALLOWED_STATUSES: Readonly<Record<StatusRuleOp, readonly GoalStatus[]>> = {
  "add-goal": GOAL_STATUSES,
  "revise-goal": ["pending"],
  "move-goal": ["pending"],
  "supersede-goal": ["pending", "blocked", "review_blocked"],
  "add-criterion": ["pending"],
  "revise-criterion": ["pending"],
  "supersede-criterion": ["pending"],
  "checkpoint-complete": ["active", "failed"],
  "checkpoint-reopen-fail-block": GOAL_STATUSES,
  "record-review-blockers": GOAL_STATUSES,
};

export function isStatusAllowed(op: StatusRuleOp, status: GoalStatus): boolean {
  return ALLOWED_STATUSES[op].includes(status);
}

/** gjc `mark_blocked_superseded` guard (`rt:4192-4198`). */
export function isOnlyRequiredGoal(file: Pick<GoalsFile, "goals">, goalId: string): boolean {
  return requiredGoals(file).filter((goal) => goal.id !== goalId).length === 0;
}

// ---------------------------------------------------------------------------
// Run status, counts and the next goal
// ---------------------------------------------------------------------------

/** gjc `requiredUltragoalGoals`: every goal that is not superseded. */
export function requiredGoals(file: Pick<GoalsFile, "goals">): Goal[] {
  return file.goals.filter((goal) => goal.status !== "superseded");
}

export type GoalCounts = Record<GoalStatus, number>;

export function countGoals(file: Pick<GoalsFile, "goals">): GoalCounts {
  const counts = Object.fromEntries(GOAL_STATUSES.map((status) => [status, 0])) as GoalCounts;
  for (const goal of file.goals) counts[goal.status] += 1;
  return counts;
}

export type RunStatus = "pending" | "active" | "complete" | "blocked" | "failed";

/** DR-1 = gjc `getUltragoalStatus` (`rt:1122-1127`): from file statuses only. */
export function deriveRunStatus(file: Pick<GoalsFile, "goals">): RunStatus {
  const counts = countGoals(file);
  if (file.goals.length > 0 && file.goals.every((goal) => goal.status === "complete" || goal.status === "superseded"))
    return "complete";
  if (counts.active > 0) return "active";
  if (counts.failed > 0) return "failed";
  if (counts.blocked > 0 || counts.review_blocked > 0) return "blocked";
  return "pending";
}

/** gjc `rt:1121`: the first pending, active or failed goal. */
export function currentGoal(file: Pick<GoalsFile, "goals">): Goal | undefined {
  return file.goals.find((goal) => goal.status === "pending" || goal.status === "active" || goal.status === "failed");
}

/**
 * DR-2: gjc `chooseNextGoal` (first active, then first pending, then with
 * `retryFailed` first failed), except that `retryFailed` with no active goal
 * takes the first failed goal before any pending one (PQ-19 B).
 */
export function chooseNextGoal(file: Pick<GoalsFile, "goals">, retryFailed: boolean): Goal | undefined {
  const active = file.goals.find((goal) => goal.status === "active");
  if (active) return active;
  const failed = retryFailed ? file.goals.find((goal) => goal.status === "failed") : undefined;
  return failed ?? file.goals.find((goal) => goal.status === "pending");
}

/** gjc `getUltragoalRunCompletionState().allComplete`: by file status only. */
export function allRequiredComplete(file: Pick<GoalsFile, "goals">): boolean {
  const required = requiredGoals(file);
  return required.length > 0 && required.every((goal) => goal.status === "complete");
}

export type NextAction =
  | { kind: "none" }
  | { kind: "execute-goal"; goal: Goal }
  | { kind: "resolve-blockers"; blockedGoals: Goal[] }
  | { kind: "retry-failed"; failedGoals: Goal[] };

/** gjc `resolveUltragoalCompleteNextAction` with the DR-2 next goal. */
export function resolveNextAction(file: Pick<GoalsFile, "goals">, retryFailed: boolean): NextAction {
  if (allRequiredComplete(file)) return { kind: "none" };
  const goal = chooseNextGoal(file, retryFailed);
  if (goal) return { kind: "execute-goal", goal };
  const incomplete = requiredGoals(file).filter((item) => item.status !== "complete");
  const blockedGoals = incomplete.filter((item) => item.status === "blocked" || item.status === "review_blocked");
  if (blockedGoals.length > 0) return { kind: "resolve-blockers", blockedGoals };
  const failedGoals = incomplete.filter((item) => item.status === "failed");
  if (failedGoals.length > 0) return { kind: "retry-failed", failedGoals };
  return { kind: "resolve-blockers", blockedGoals: incomplete };
}

// ---------------------------------------------------------------------------
// Completion view (C-8) and receipt kind (DR-5)
// ---------------------------------------------------------------------------

export type CompletionView = {
  /** A copy of the plan; the fix goal's `review_blocked` parent is superseded. */
  file: GoalsFile;
  goal: Goal;
  supersededParentId?: string;
  /** DR-5 in this view; a final receipt needs the final gate. */
  receiptKind: ReceiptKind;
};

/**
 * C-8: the plan `checkpoint(complete)` and `validate_gate` judge. When the
 * goal is a fix goal whose `blockedGoalId` is `review_blocked`, that parent is
 * superseded in the copy, as gjc does at write time (`rt:3738-3748`); any other
 * parent status is left alone, and only one level is looked at (PQ-23 A).
 * With `resolution`, the parent's evidence is set as gjc writes it.
 */
export function completionView(
  file: GoalsFile,
  goalId: string,
  resolution?: { evidence: string },
): CompletionView {
  const copy = structuredClone(file);
  const goal = copy.goals.find((item) => item.id === goalId);
  if (!goal) throw new Error(`No ultragoal goal found for ${goalId}.`);
  let supersededParentId: string | undefined;
  if (goal.steering?.kind === "review_blocker") {
    const parent = copy.goals.find((item) => item.id === goal.steering?.blockedGoalId);
    if (parent?.status === "review_blocked") {
      parent.status = "superseded";
      if (resolution)
        parent.evidence = `Resolved by verification blocker goal ${goal.id}: ${resolution.evidence}`;
      supersededParentId = parent.id;
    }
  }
  // DR-5 (`rt:626-658` minus per-story, batch and fresh-final branches).
  const unfinished = requiredGoals(copy).filter((item) => item.id !== goal.id && item.status !== "complete");
  return {
    file: copy,
    goal,
    supersededParentId,
    receiptKind: unfinished.length === 0 ? "final-aggregate" : "per-goal",
  };
}

// ---------------------------------------------------------------------------
// Run completion (C-7)
// ---------------------------------------------------------------------------

export type RunCompletion =
  | { complete: true; lastGoalId: string }
  | { complete: false; reason: string; reopenGoalId?: string };

function staleReason(check: ReceiptCheck): string {
  return check.state === "stale" && check.reason === "criteria_changed"
    ? "criteria changed after verification"
    : "it does not match the ledger";
}

/**
 * C-7: the run is complete when every required goal is `complete`, each
 * receipt is valid (a final that breaks only condition 3 counts as per-goal),
 * and the most recently completed required goal — by ledger order — holds a
 * valid final receipt. A failure names the goal to reopen, when there is one.
 */
export function runCompletion(file: Pick<GoalsFile, "goals">, rows: readonly LedgerRow[]): RunCompletion {
  const required = requiredGoals(file);
  if (required.length === 0) return { complete: false, reason: "no required goals" };
  const incomplete = required.filter((goal) => goal.status !== "complete");
  if (incomplete.length > 0)
    return {
      complete: false,
      reason: `required goals not complete: ${incomplete.map((goal) => `${goal.id} (${goal.status})`).join(", ")}`,
    };
  let last: { goal: Goal; check: ReceiptCheck; index: number } | undefined;
  for (const goal of required) {
    const check = checkReceipt(goal, rows);
    if (check.state === "none")
      return { complete: false, reason: `${goal.id} has no completion receipt`, reopenGoalId: goal.id };
    if (!isValidCompletion(check))
      return {
        complete: false,
        reason: `${goal.id} completion receipt is stale: ${staleReason(check)}`,
        reopenGoalId: goal.id,
      };
    const index = check.state === "valid" || check.state === "superseded-final" ? check.ledgerIndex : -1;
    if (!last || index > last.index) last = { goal, check, index };
  }
  if (!last || last.check.state !== "valid" || last.check.kind !== "final-aggregate")
    return {
      complete: false,
      reason: `last completed goal ${last?.goal.id} has no valid final-aggregate receipt`,
      reopenGoalId: last?.goal.id,
    };
  return { complete: true, lastGoalId: last.goal.id };
}

// ---------------------------------------------------------------------------
// Fix goals (DR-6, PQ-17 C, PQ-23 A)
// ---------------------------------------------------------------------------

/** gjc record-review-blockers default `--title`. */
export const FIX_GOAL_DEFAULT_TITLE = "Resolve final code-review blockers";

/** gjc `MAX_REVIEW_BLOCKER_DESCENTS` (D-SF7). */
export const MAX_REVIEW_BLOCKER_DESCENTS = 3;

/** PQ-17 C: the fix goal's one criterion. */
export function fixCriterionText(objective: string): string {
  return `${objective.trim()}${FIX_CRITERION_SUFFIX}`;
}

const RESOLVED_REVIEW_BLOCKER_STATUSES: readonly GoalStatus[] = ["complete", "superseded"];

/**
 * gjc `findOpenReviewBlockerGoal`: the first unresolved fix goal with the same
 * trimmed objective (the caller then requires the same `blockedGoalId`).
 */
export function findOpenReviewBlockerGoal(file: Pick<GoalsFile, "goals">, objective: string): Goal | undefined {
  const trimmed = objective.trim();
  return file.goals.find(
    (goal) =>
      goal.steering?.kind === "review_blocker" &&
      goal.description.trim() === trimmed &&
      !RESOLVED_REVIEW_BLOCKER_STATUSES.includes(goal.status),
  );
}

/** gjc `countUnresolvedReviewBlockerDescents`, counted from `goals.json`. */
export function countUnresolvedReviewBlockerDescents(file: Pick<GoalsFile, "goals">, goalId: string): number {
  return file.goals.filter(
    (goal) =>
      goal.steering?.kind === "review_blocker" &&
      goal.steering.blockedGoalId === goalId &&
      !RESOLVED_REVIEW_BLOCKER_STATUSES.includes(goal.status),
  ).length;
}
