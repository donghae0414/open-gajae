// Ultragoal compaction recovery: gjc's structured projection of `goals.json`
// + the ledger, its zero-progress fingerprint and STALLED bound, the
// applicability rule, and the compaction-context lines (spec D-SF5, plan
// DR-17). Pure: the caller reads the files, keeps the zero-progress memory in
// process memory (E-12) and wraps the lines (`./messages.ts`).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/workflow-recovery-projection.ts:25-99` (projection and
//   memory types), `:100-114` (`ZERO_PROGRESS_STALL_THRESHOLD`,
//   `trackWorkflowRecoveryZeroProgress`, `isWorkflowRecoveryStalled`),
//   `:116-128` (bounds, `boundText`), `:465-616` (`projectUltragoalRun`,
//   `withZeroProgress`, `readCohortFromLedgerEvent`,
//   `hashWorkflowRecoveryProjection`)
// - `session/agent-session.ts:667-705` (`renderWorkflowRecoveryContext`),
//   `:736-739` (the STALLED line), `:745-753` (`sanitizeCompactionStateText`),
//   `:16132-16133` (no projection while the goal is paused)
// - `skill-state/active-state.ts:353-373` (`isWorkflowContinuationInert`:
//   terminal or unknown phases are inert)
// Deviations (plan §7.1):
// - 26: the lines add the progress log's Codebase Patterns and recent
//   learnings, and the STALLED line goes into the compaction context (gjc
//   puts it in the post-compaction continuation prompt; the host has no
//   such hook).
// - 16, 28: no source hash; the cohort generation is read from the top-level
//   gate `reviewCohort`, and the fingerprint basis has no
//   `latestCohortSourceHash`.

import { createHash } from "node:crypto";
import type { LedgerRow } from "./ledger.js";
import { isUltragoalPhase, ULTRAGOAL_TERMINAL_STATES } from "./manifest.js";
import type { GoalsFile } from "./plan.js";
import { LIMITS } from "./plan.js";
import { parseProgress } from "./progress.js";

export interface UltragoalRecoveryProjection {
  skill: "ultragoal";
  source: "ultragoal-plan";
  /** Bounded accepted objective (the goal's fixed objective). */
  objective: string;
  /** The objective and up to 11 goals. */
  scope: Array<{ kind: "accepted"; text: string }>;
  /** Completion evidence of the complete goals. */
  acceptanceCriteria: string[];
  unresolved: string[];
  provenance: { planPath: string };
  currentGoal?: { goalId: string; status: string; objective: string };
  progress: {
    totalGoals: number;
    completedGoals: number;
    outstandingGoals: number;
    latestReviewGeneration?: number;
    latestLedgerEventId?: string;
  };
  nextAction: {
    actionClass:
      | "continue-current-goal"
      | "start-next-goal"
      | "resolve-review-blockers"
      | "final-aggregate-checkpoint"
      | "unknown";
    goalId?: string;
    detail?: string;
  };
  zeroProgress: { fingerprint: string; unchangedObservations: number; stalled: boolean };
}

export interface ZeroProgressMemory {
  lastFingerprint?: string;
  unchangedObservations: number;
}

/** gjc `ZERO_PROGRESS_STALL_THRESHOLD`: STALLED after 2 unchanged observations. */
export const ZERO_PROGRESS_STALL_THRESHOLD = 2;

const MAX_OBJECTIVE_CHARS = 600;
const MAX_ITEM_CHARS = 240;
const MAX_SCOPE_ITEMS = 12;
const MAX_CRITERIA_ITEMS = 12;
const MAX_UNRESOLVED_ITEMS = 8;

function boundText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed;
}

/**
 * DR-17: project only while the visible ultragoal row is active, its phase is
 * a manifest state outside ultragoal's terminal states (gjc
 * `isWorkflowContinuationInert`), and the goal is not paused.
 */
export function ultragoalRecoveryApplies(input: {
  rowActive: boolean;
  phase: string | undefined;
  goalStatus: string | undefined;
}): boolean {
  if (!input.rowActive || input.goalStatus === "paused") return false;
  const phase = input.phase?.trim().toLowerCase();
  return isUltragoalPhase(phase) && !ULTRAGOAL_TERMINAL_STATES.has(phase);
}

function cohortGeneration(row: LedgerRow): number | undefined {
  if (!("event" in row) || row.event !== "goal_checkpointed" || row.status !== "complete") return undefined;
  const gate = row.qualityGateJson;
  if (typeof gate !== "object" || gate === null || Array.isArray(gate)) return undefined;
  const cohort = (gate as { reviewCohort?: unknown }).reviewCohort;
  if (typeof cohort !== "object" || cohort === null || Array.isArray(cohort)) return undefined;
  const generation = (cohort as { reviewGeneration?: unknown }).reviewGeneration;
  return typeof generation === "number" ? generation : undefined;
}

/** gjc `projectUltragoalRun` over parsed state; undefined for an empty plan. */
export function projectUltragoalRun(input: {
  file: GoalsFile;
  rows: readonly LedgerRow[];
  goalsPath: string;
  objective: string;
}): UltragoalRecoveryProjection | undefined {
  const { file, rows } = input;
  if (file.goals.length === 0) return undefined;
  const schedulable = file.goals.filter((goal) => goal.status !== "complete" && goal.status !== "superseded");
  const current = file.goals.find((goal) => goal.status === "active" || goal.status === "failed") ?? schedulable[0];
  const reviewBlocked = file.goals.find((goal) => goal.status === "review_blocked");
  const lastCheckpoint = [...rows]
    .reverse()
    .find((row) => "event" in row && row.event === "goal_checkpointed" && row.status === "complete");
  let latestReviewGeneration: number | undefined;
  for (const row of rows) {
    const generation = cohortGeneration(row);
    if (generation !== undefined && (latestReviewGeneration === undefined || generation >= latestReviewGeneration))
      latestReviewGeneration = generation;
  }
  const objective = boundText(input.objective, MAX_OBJECTIVE_CHARS) ?? "Ultragoal aggregate run";
  const scope: UltragoalRecoveryProjection["scope"] = [{ kind: "accepted", text: objective }];
  for (const goal of file.goals.slice(0, MAX_SCOPE_ITEMS - 1)) {
    const text = boundText(goal.title || goal.description, MAX_ITEM_CHARS);
    if (text) scope.push({ kind: "accepted", text: `goal ${goal.id}: ${text}` });
  }
  const acceptance: string[] = [];
  for (const goal of file.goals.slice(0, MAX_CRITERIA_ITEMS)) {
    const evidence = boundText(goal.evidence, MAX_ITEM_CHARS);
    if (goal.status === "complete" && evidence) acceptance.push(`${goal.id} complete: ${evidence}`);
  }
  let nextAction: UltragoalRecoveryProjection["nextAction"] = { actionClass: "unknown" };
  if (reviewBlocked)
    nextAction = {
      actionClass: "resolve-review-blockers",
      goalId: reviewBlocked.id,
      detail: boundText(reviewBlocked.description, MAX_ITEM_CHARS),
    };
  else if (schedulable.length === 0) nextAction = { actionClass: "final-aggregate-checkpoint" };
  else if (current)
    nextAction = {
      actionClass: current.status === "active" ? "continue-current-goal" : "start-next-goal",
      goalId: current.id,
      detail: boundText(current.description, MAX_ITEM_CHARS),
    };
  const projection: Omit<UltragoalRecoveryProjection, "zeroProgress"> = {
    skill: "ultragoal",
    source: "ultragoal-plan",
    objective,
    scope,
    acceptanceCriteria: acceptance,
    unresolved: reviewBlocked
      ? [`review blockers open on ${reviewBlocked.id}`]
      : schedulable
          .filter((goal) => goal.status === "blocked" || goal.status === "failed")
          .slice(0, MAX_UNRESOLVED_ITEMS)
          .map((goal) => `${goal.id} ${goal.status}: ${boundText(goal.evidence ?? "", MAX_ITEM_CHARS) ?? ""}`.trim()),
    provenance: { planPath: input.goalsPath },
    currentGoal: current
      ? {
          goalId: current.id,
          status: current.status,
          objective: boundText(current.description, MAX_OBJECTIVE_CHARS) ?? "",
        }
      : undefined,
    progress: {
      totalGoals: file.goals.length,
      completedGoals: file.goals.filter((goal) => goal.status === "complete").length,
      outstandingGoals: schedulable.length,
      latestReviewGeneration,
      latestLedgerEventId: lastCheckpoint?.eventId ?? rows.at(-1)?.eventId,
    },
    nextAction,
  };
  return {
    ...projection,
    zeroProgress: { fingerprint: hashUltragoalRecoveryProjection(projection), unchangedObservations: 0, stalled: false },
  };
}

/** gjc `hashWorkflowRecoveryProjection` without the cohort source hash. */
export function hashUltragoalRecoveryProjection(
  projection: Omit<UltragoalRecoveryProjection, "zeroProgress">,
): string {
  const basis = {
    skill: projection.skill,
    source: projection.source,
    objective: projection.objective,
    scope: projection.scope,
    acceptanceCriteria: projection.acceptanceCriteria,
    unresolved: projection.unresolved,
    provenance: projection.provenance,
    currentGoal: projection.currentGoal,
    progressBasis: {
      totalGoals: projection.progress.totalGoals,
      completedGoals: projection.progress.completedGoals,
      outstandingGoals: projection.progress.outstandingGoals,
    },
    nextAction: projection.nextAction,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(basis)).digest("hex")}`;
}

/** gjc `trackWorkflowRecoveryZeroProgress`: one compaction observation. */
export function trackZeroProgress(
  memory: ZeroProgressMemory | undefined,
  projection: UltragoalRecoveryProjection,
): ZeroProgressMemory {
  const fingerprint = projection.zeroProgress.fingerprint;
  if (!memory) return { lastFingerprint: fingerprint, unchangedObservations: 0 };
  const unchanged = memory.lastFingerprint === fingerprint ? memory.unchangedObservations + 1 : 0;
  return { lastFingerprint: fingerprint, unchangedObservations: unchanged };
}

/** The projection with the memory's count and gjc `isWorkflowRecoveryStalled`. */
export function withZeroProgress(
  projection: UltragoalRecoveryProjection,
  memory: ZeroProgressMemory,
): UltragoalRecoveryProjection {
  return {
    ...projection,
    zeroProgress: {
      ...projection.zeroProgress,
      unchangedObservations: memory.unchangedObservations,
      stalled: memory.unchangedObservations >= ZERO_PROGRESS_STALL_THRESHOLD,
    },
  };
}

/** gjc `sanitizeCompactionStateText`. */
function sanitize(value: string, maxLength: number): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n/g, " ")
    .replace(/[\r\n]/g, " ")
    .slice(0, maxLength);
}

/**
 * gjc `renderWorkflowRecoveryContext` for ultragoal, then (deviation 26) the
 * progress log's patterns and the deduplicated learnings of its last 10
 * entries (as OMC `getProgressContext` picks them), then the STALLED line.
 */
export function renderUltragoalRecoveryContext(
  recovery: UltragoalRecoveryProjection,
  progressText?: string,
): string[] {
  const lines: string[] = [];
  lines.push(`Workflow contract (${recovery.skill}): ${sanitize(recovery.objective, 200)}`);
  const accepted = recovery.scope.slice(0, 8);
  if (accepted.length > 0)
    lines.push(`Accepted scope: ${accepted.map((item) => sanitize(item.text, 120)).join("; ")}`);
  if (recovery.acceptanceCriteria.length > 0)
    lines.push(`Acceptance criteria: ${recovery.acceptanceCriteria.map((item) => sanitize(item, 120)).join("; ")}`);
  if (recovery.currentGoal) {
    const goal = recovery.currentGoal;
    lines.push(
      `Current goal: ${sanitize(goal.goalId, 40)} status=${sanitize(goal.status, 40)} ${sanitize(goal.objective, 120)}`,
    );
  }
  const progress = recovery.progress;
  lines.push(`Progress: goals ${progress.completedGoals}/${progress.totalGoals}, outstanding ${progress.outstandingGoals}`);
  lines.push(
    `Next action: ${recovery.nextAction.actionClass}${recovery.nextAction.goalId ? ` (${recovery.nextAction.goalId})` : ""}`,
  );
  if (progressText) {
    const { patterns, entries } = parseProgress(progressText);
    if (patterns.length > 0)
      lines.push("Codebase patterns:", ...patterns.map((pattern) => `- ${sanitize(pattern, LIMITS.pattern)}`));
    const learnings = [...new Set(entries.slice(-10).flatMap((entry) => entry.learnings))];
    if (learnings.length > 0)
      lines.push("Recent learnings:", ...learnings.map((learning) => `- ${sanitize(learning, LIMITS.text)}`));
  }
  if (recovery.zeroProgress.stalled)
    lines.push(
      `STALLED: durable progress has not changed across ${recovery.zeroProgress.unchangedObservations + 1} compaction recoveries. Do not repeat the same next action again. Record a durable blocker or escalate to the operator now.`,
    );
  return lines;
}
