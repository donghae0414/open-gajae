// Goal state (`state/goal-state.json`) and the hook-only continuation record
// (`state/goal-continuation.json`) of plan C-9 (PQ-2 B): the schema, a
// fail-closed reader, the gjc op transitions and the continuation record's
// reset rule. Pure except the two `WorkflowTx` helpers, which the `goal` tool
// and `ultragoal create` (goal arming) share.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `goals/state.ts:3-16` (`GoalStatus`, `Goal`), `:35-77` (`normalizeGoal`)
// - `goals/runtime.ts:78-85` (`validateGoalObjective`), `:297-310`
//   (`#createGoalState`), `:312-325` (`createGoal`: refused while a goal that
//   is neither dropped nor complete exists), `:342-356` (`resumeGoal`),
//   `:358-375` (`pauseGoal`), `:377-392` (`dropGoal`), `:394-416`
//   (`completeGoalFromTool`)
// Deviations (plan §7.1):
// - 6 (PQ-2 B): the goal lives in `state/goal-state.json` as `{version, id,
//   objective, status, source, created_at, updated_at}`, not in the session
//   transcript; the continuation counter and hold live in the hook-only
//   `state/goal-continuation.json`, which starts over when the goal id changes.
// - 8: no `tokensUsed`/`timeUsedSeconds`.
// - 12: `source` stands for gjc `provenance` (no `runId`/`goalId`).
// - 37 (DR-9): `drop` keeps the file with `status: "dropped"`, and every op
//   treats a dropped goal as no goal (gjc deletes the state).
// Open-gajae rule: a goal-state file that fails the schema is an error (fail
// closed), where gjc `normalizeGoal` reads it as no goal. An unreadable
// continuation record starts over, as the ralplan breaker does (R-O3).

import { appendAudit, RUNTIME_OWNER } from "../skill-state/audit.js";
import type { WorkflowTx } from "../state.js";
import {
  GOAL_ALREADY_COMPLETE,
  GOAL_ALREADY_EXISTS,
  goalStateInvalid,
  NO_GOAL_TO_COMPLETE,
  NO_PAUSED_GOAL,
  OBJECTIVE_IS_COMMAND,
  OBJECTIVE_REQUIRED,
  pauseNotActive,
  RESUME_COMPLETE_GOAL,
} from "./messages.js";

export const GOAL_STATE_VERSION = 1;
export const GOAL_STATUSES = ["active", "paused", "complete", "dropped"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type GoalSource = "ultragoal" | "user";

export type GoalState = {
  version: typeof GOAL_STATE_VERSION;
  id: string;
  objective: string;
  status: GoalStatus;
  source: GoalSource;
  created_at: string;
  updated_at: string;
};

export type GoalStateRead =
  | { kind: "missing" }
  | { kind: "invalid"; error: string }
  | { kind: "valid"; goal: GoalState };

const GOAL_STATE_KEYS = ["version", "id", "objective", "status", "source", "created_at", "updated_at"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** The schema error of a goal state, or undefined. */
export function goalStateError(value: unknown): string | undefined {
  if (!isRecord(value)) return "goal-state.json must be a JSON object";
  const unknown = Object.keys(value).filter((key) => !GOAL_STATE_KEYS.includes(key));
  if (unknown.length > 0) return `goal-state.json has unknown keys: ${unknown.join(", ")}`;
  if (value.version !== GOAL_STATE_VERSION) return `goal-state.json version must be ${GOAL_STATE_VERSION}`;
  for (const key of ["id", "objective", "created_at", "updated_at"])
    if (!nonEmpty(value[key])) return `goal-state.json ${key} must be a non-empty string`;
  if (!(GOAL_STATUSES as readonly unknown[]).includes(value.status))
    return `goal-state.json status must be one of ${GOAL_STATUSES.join(", ")}`;
  if (value.source !== "ultragoal" && value.source !== "user")
    return 'goal-state.json source must be "ultragoal" or "user"';
  return undefined;
}

/** Missing text is no goal; anything the schema does not allow is invalid. */
export function parseGoalState(text: string | undefined): GoalStateRead {
  if (text === undefined) return { kind: "missing" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "invalid", error: "goal-state.json is not valid JSON" };
  }
  const error = goalStateError(value);
  return error ? { kind: "invalid", error } : { kind: "valid", goal: value as GoalState };
}

export function serializeGoalState(goal: GoalState): string {
  const error = goalStateError(goal);
  if (error) throw new Error(`refusing to write an invalid goal-state.json: ${error}`);
  return `${JSON.stringify(goal, null, 2)}\n`;
}

/** DR-9: the goal every op sees; a dropped goal counts as none. */
export function visibleGoal(goal: GoalState | undefined): GoalState | undefined {
  return goal?.status === "dropped" ? undefined : goal;
}

/** gjc `createGoal`'s refusal test: an active or paused goal is still open. */
export function isOpenGoal(goal: GoalState | undefined): goal is GoalState {
  return goal?.status === "active" || goal?.status === "paused";
}

// ---------------------------------------------------------------------------
// Op transitions (gjc `GoalRuntime`); refusals throw the gjc message
// ---------------------------------------------------------------------------

/** gjc `validateGoalObjective(objective, "create")`: the trimmed objective. */
export function validateGoalObjective(objective: string): string {
  const trimmed = objective.trim();
  if (!trimmed) throw new Error(OBJECTIVE_REQUIRED);
  if (trimmed === "/goal") throw new Error(OBJECTIVE_IS_COMMAND);
  return trimmed;
}

/** gjc `createGoal`: a new active goal, refused while one is open. */
export function createGoalState(
  existing: GoalState | undefined,
  input: { id: string; objective: string; source: GoalSource; now: string },
): GoalState {
  const objective = validateGoalObjective(input.objective);
  if (isOpenGoal(existing)) throw new Error(GOAL_ALREADY_EXISTS);
  return {
    version: GOAL_STATE_VERSION,
    id: input.id,
    objective,
    status: "active",
    source: input.source,
    created_at: input.now,
    updated_at: input.now,
  };
}

/** gjc `resumeGoal`: any visible goal but a complete one becomes active. */
export function resumeGoalState(goal: GoalState | undefined, now: string): GoalState {
  const current = visibleGoal(goal);
  if (!current) throw new Error(NO_PAUSED_GOAL);
  if (current.status === "complete") throw new Error(RESUME_COMPLETE_GOAL);
  return { ...current, status: "active", updated_at: now };
}

/** gjc `pauseGoal`: undefined when there is no goal. */
export function pauseGoalState(goal: GoalState | undefined, now: string): GoalState | undefined {
  const current = visibleGoal(goal);
  if (!current) return undefined;
  if (current.status !== "active") throw new Error(pauseNotActive(current.status));
  return { ...current, status: "paused", updated_at: now };
}

/** gjc `dropGoal`: undefined when there is no goal (DR-9: already dropped too). */
export function dropGoalState(goal: GoalState | undefined, now: string): GoalState | undefined {
  const current = visibleGoal(goal);
  if (!current) return undefined;
  return { ...current, status: "dropped", updated_at: now };
}

/** gjc `completeGoalFromTool` (a paused goal may be completed, as in gjc). */
export function completeGoalState(goal: GoalState | undefined, now: string): GoalState {
  const current = visibleGoal(goal);
  if (!current) throw new Error(NO_GOAL_TO_COMPLETE);
  if (current.status === "complete") throw new Error(GOAL_ALREADY_COMPLETE);
  return { ...current, status: "complete", updated_at: now };
}

// ---------------------------------------------------------------------------
// Goal state I/O inside a workflow transaction
// ---------------------------------------------------------------------------

/** The stored goal (a dropped one included), failing closed on a bad file. */
export async function readGoalStateTx(tx: WorkflowTx): Promise<GoalState | undefined> {
  const read = parseGoalState(await tx.readText(tx.paths.goalState));
  if (read.kind === "invalid") throw new Error(goalStateInvalid(read.error));
  return read.kind === "valid" ? read.goal : undefined;
}

/**
 * Write the goal state and its audit row (plan C-6): `skill` is `goal` for the
 * goal tool and `ultragoal` when `ultragoal create` arms the goal.
 */
export async function writeGoalStateTx(
  tx: WorkflowTx,
  goal: GoalState,
  skill: "goal" | "ultragoal",
): Promise<void> {
  await tx.writeText(tx.paths.goalState, serializeGoalState(goal));
  await appendAudit(tx, {
    category: "state",
    verb: "write",
    owner: RUNTIME_OWNER,
    skill,
    path: tx.paths.goalState,
  });
}

// ---------------------------------------------------------------------------
// The hook-only continuation record (PQ-2 B; not audited, plan C-6)
// ---------------------------------------------------------------------------

export type GoalContinuationHoldReason = "no_tool_progress" | "critic_streak";

export type GoalContinuation = {
  goal_id: string;
  tool_less_turns: number;
  held?: { reason: GoalContinuationHoldReason; at: string };
  /** PQ-3 (1) A: the `critic_verdict` eventId the critic count restarts after. */
  critic_reset_after?: string;
};

/** The stored record, or undefined when it is missing or unreadable. */
export function parseGoalContinuation(text: string | undefined): GoalContinuation | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !nonEmpty(value.goal_id)) return undefined;
  const turns = value.tool_less_turns;
  if (typeof turns !== "number" || !Number.isInteger(turns) || turns < 0) return undefined;
  const record: GoalContinuation = { goal_id: value.goal_id, tool_less_turns: turns };
  if (value.held !== undefined) {
    const held = value.held;
    if (
      !isRecord(held) ||
      (held.reason !== "no_tool_progress" && held.reason !== "critic_streak") ||
      !nonEmpty(held.at)
    )
      return undefined;
    record.held = { reason: held.reason, at: held.at };
  }
  if (value.critic_reset_after !== undefined) {
    if (!nonEmpty(value.critic_reset_after)) return undefined;
    record.critic_reset_after = value.critic_reset_after;
  }
  return record;
}

/** PQ-2 B: the record for `goalId`; one for another goal, or none, starts over. */
export function continuationForGoal(
  record: GoalContinuation | undefined,
  goalId: string,
): GoalContinuation {
  return record?.goal_id === goalId ? record : { goal_id: goalId, tool_less_turns: 0 };
}

export function serializeGoalContinuation(record: GoalContinuation): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
