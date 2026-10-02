// Ultragoal record operations: every `ultragoal` tool op as a function over the
// `tx` of one `StateStore.workflowTransaction` (plan C-1, S2). Each op parses
// its input and reads `goals.json`, the ledger and the states, builds the new
// plan and ledger rows in memory and runs every check, and only then writes,
// in gjc order — plan, ledger, progress, goal state — with one audit row per
// write (C-6, C-7a). The reconciling ops end by rewriting the ultragoal
// mode-state, active row, snapshot and HUD from `goals.json` and the ledger
// (C-4); `add_pattern`, `validate_gate` and `doctor` do not, and `handoff`,
// `state` and `clear` write the rows themselves. Functions never call a queued
// StateStore method (C-1.3). The result of each op is the C-14 text.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/ultragoal-runtime.ts:392-410` (`appendLedger`), `:568-590`
//   (`writePlan`: goals.json audited as a state write), `:1108-1127`
//   (`getUltragoalStatus`), `:1223-1276` (`createUltragoalPlan`), `:1354-1411`
//   (`startNextUltragoalGoal`), `:3422-3485`
//   (`validateUltragoalQualityGateReadOnly`: the target goal defaults to the
//   first schedulable one, `unknown_goal`), `:3487-3500` (missing gate),
//   `:3579-3790` (`checkpointUltragoalGoalForSession`: evidence, idempotent
//   replay, start statuses, parent supersede, receipt, write order),
//   `:3802-3838` (`checkpointAndContinueUltragoalGoal`: advance to the next
//   goal after a complete checkpoint), `:3845-3877` (steering text and status
//   checks), `:3959-4216` (steering ops), `:4218-4274`
//   (`recordUltragoalReviewBlockers`), `:4284-4301`
//   (`recordUltragoalBlockerClassification`), `:4303-4366`
//   (`recordUltragoalCriticVerdict`), `:5650-5662` (`RECONCILE_COMMANDS`),
//   `:5674-5752` (`reconcileUltragoalState`: the derived payload, the
//   `{type: "reconcile_failed", error}` ledger row)
// - `gjc-runtime/state-runtime.ts:244-270` (`readActivePhaseForSkill`,
//   `describeStaleClearState`), `:826-839` (`mergeWithNullDelete`), `:873-925`
//   (`buildHudForMode` for ultragoal), `:1036-1141`
//   (`reconcileWorkflowSkillStateUnlocked`: a corrupt state is replaced, the
//   write is forced and audited as `reconcile`), `:1232-1400` (`handleWrite`),
//   `:1402-1490` (`handleClear`), `:1572-1881` (handoff, via
//   `../skill-state/handoff.ts`)
// - `gjc-runtime/goal-mode-request.ts:145-162,195` (arming: the same run's
//   goal, or a trimmed objective match, is kept)
// - `hooks/skill-state.ts:429-470` (the skill-load seed: an active
//   `goal-planning` state, then `syncSkillActiveState`)
// Deviations (plan §7.1; the pure rules live in the S2a modules):
// - 1 (PQ-10 A, PQ-15 A, PQ-25 B): `create` appends a `PLAN` note to
//   `progress.txt`, `checkpoint(complete)` requires `implementation`,
//   `files_changed` and `learnings` and appends an entry, and `add_pattern`
//   writes the Codebase Patterns without a reconcile.
// - 4, 38 (C-15, PQ-26 A): `add`/`revise`/`supersede` with `target` and
//   `after` stand for gjc's six `steer` kinds; `rationale` and `evidence`
//   must be substantive (5 words, 32 characters).
// - 12 (D-TL10): `create` arms the goal unless another goal is open.
// - 25 (PQ-1 A): `state` is gjc's open patch without derived fields or
//   `--force`.
// - 27 (「E1」): `checkpoint` takes `complete|failed|blocked|pending`; `pending`
//   reopens a goal and keeps its receipt.
// - 29 (E-20): a fix goal's gate kind and receipt kind both come from the
//   completion view.
// - 35 (DR-21): the skill-load seed raises a missing or inactive state to
//   `goal-planning` over its kept fields (`seedUltragoalTx`).
// - 36: `checkpoint(complete)` with its advance and `record_review_blockers`
//   write `goals.json` once.
// - 39: the `workflow_handoff` ledger row and the progress `HANDOFF` note of an
//   ultragoal handoff (C-5 ⑥).
// - 40 (PQ-17 C): the fix goal gets one criterion.
// - 41: messages name op calls instead of gjc CLI flags.
// - C-7a 5 (E-15): an idempotent replay needs the same status and evidence, a
//   matching `goal_checkpointed` row and, for complete, a valid receipt; it
//   writes nothing (not even gjc's advance). A complete goal is re-verified
//   only after `checkpoint(status: pending)`: there is no stale-receipt replay.
// - `validate_gate` without a goal and with no schedulable goal checks the
//   gate's shape only (per-goal kind), as gjc does without a target.

import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  continuationForGoal,
  createGoalState,
  isOpenGoal,
  parseGoalContinuation,
  readGoalStateTx,
  visibleGoal,
  writeGoalStateTx,
} from "../goal/state.js";
import { type AuditOwner, appendAudit, HOOK_OWNER, RUNTIME_OWNER } from "../skill-state/audit.js";
import {
  activeFlag,
  collectDoctorSummaryTx,
  readRawJsonTx,
  renderDoctorText,
  rowPhase,
  workflowEnvelopeError,
} from "../skill-state/doctor.js";
import { handoffWorkflowTx } from "../skill-state/handoff.js";
import { syncActiveRowTx } from "../skill-state/rows.js";
import type { InterviewState, StateWriter, WorkflowTx } from "../state.js";
import { validateGate } from "./gate.js";
import { buildUltragoalHudFromState } from "./hud.js";
import {
  type BlockerClassification,
  CRITIC_VERDICT_EVENT,
  type CriticTerminus,
  type CriticVerdict,
  criticNonOkayStreak,
  type HandoffTarget,
  latestLedgerEvent,
  type LedgerEventFields,
  type LedgerRow,
  ledgerRow,
  parseLedger,
  serializeLedgerRow,
  type SteeringKind,
} from "./ledger.js";
import {
  derivedFieldPatchError,
  ULTRAGOAL_GUARD_RELEASE_PHASES,
  ULTRAGOAL_INITIAL_STATE,
  type UltragoalPhase,
  ultragoalPhasePatchError,
} from "./manifest.js";
import {
  CHECKPOINT_EVIDENCE_REQUIRED,
  completeCheckpointRefusal,
  type GoalArming,
  lastCriterionRefusal,
  NO_PLAN,
  OBJECTIVE_TOO_LONG,
  onlyRequiredGoalRefusal,
  PATTERN_ADDED,
  planChangeStatusRefusal,
  renderBlockerClassification,
  renderCheckpoint,
  renderClear,
  renderCreate,
  renderCriticVerdict,
  renderGateDiagnostics,
  renderNext,
  renderReviewBlockers,
  renderStatus,
  renderSteering,
  renderWriteReceipt,
  reviewBlockerCapRefusal,
  ultragoalGoalObjective,
  unknownGoal,
} from "./messages.js";
import {
  allRequiredComplete,
  type Amendment,
  buildGoalsFile,
  chooseNextGoal,
  completionView,
  countGoals,
  countUnresolvedReviewBlockerDescents,
  currentGoal,
  deriveRunStatus,
  FIX_GOAL_DEFAULT_TITLE,
  findOpenReviewBlockerGoal,
  fixCriterionText,
  type Goal,
  type GoalInput,
  type GoalsFile,
  insertAfter,
  isOnlyRequiredGoal,
  isStatusAllowed,
  isSubstantive,
  LIMITS,
  MAX_REVIEW_BLOCKER_DESCENTS,
  moveAfter,
  newGoal,
  nextCriterionId,
  nextGoalId,
  parseGoals,
  resolveNextAction,
  runCompletion,
  serializeGoals,
  type StatusRuleOp,
} from "./plan.js";
import {
  addProgressPattern,
  appendProgressEntry,
  initialProgress,
  progressForCreate,
  progressForHandoff,
} from "./progress.js";
import { buildCompletionVerification, checkReceipt, isValidCompletion } from "./receipt.js";

const SKILL = "ultragoal";
/** gjc `WORKFLOW_STATE_VERSION`. */
const WORKFLOW_STATE_VERSION = 2;
/** gjc caps a plan at 999 goals (`G999`). */
const MAX_GOALS = 999;

export type CheckpointStatus = "complete" | "failed" | "blocked" | "pending";

/** The op inputs the `ultragoal` tool passes through (snake_case, PQ-8 A). */
export type UltragoalArgs = {
  description?: string;
  goals?: GoalInput[];
  retry_failed?: boolean;
  goal_id?: string;
  status?: CheckpointStatus;
  evidence?: string;
  gate?: unknown;
  implementation?: string[];
  files_changed?: string[];
  learnings?: string[];
  target?: "goal" | "criterion";
  title?: string;
  acceptanceCriteria?: string[];
  after?: string;
  criterion_id?: string;
  criterion?: string;
  rationale?: string;
  /** `handoff` only; the plan-change ops take `rationale` (「E3」). */
  reason?: string;
  pattern?: string;
  objective?: string;
  classification?: BlockerClassification;
  terminus?: CriticTerminus;
  verdict?: CriticVerdict;
  blockers?: string[];
  classification_event_id?: string;
  to?: HandoffTarget;
  patch?: Record<string, unknown>;
  force?: boolean;
};

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function now(): string {
  return new Date().toISOString();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A state copy without the StateStore `_meta` (regenerated on every write). */
function payloadOf(state: InterviewState | undefined): Json {
  const { _meta, ...rest } = state ?? {};
  return rest;
}

function writerOf(owner: AuditOwner): StateWriter {
  return owner === HOOK_OWNER ? "ultragoal_hook" : "ultragoal_tool";
}

/** gjc `mergeWithNullDelete`: a `null` value removes the key. */
function mergeWithNullDelete(target: Json, source: Json): Json {
  const result: Json = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === null) delete result[key];
    else result[key] = value;
  }
  return result;
}

function goalObjectiveOf(tx: WorkflowTx): string {
  return ultragoalGoalObjective(path.basename(tx.paths.sessionDir));
}

// ---------------------------------------------------------------------------
// Input checks (C-7a: all before the first write)
// ---------------------------------------------------------------------------

function checkText(value: string | undefined, name: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${name} must be a non-empty string`);
  if (value.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return value.trim();
}

function checkList(value: string[] | undefined, name: string, max: number): string[] {
  if (!value || value.length === 0) throw new Error(`${name} needs at least one item`);
  return value.map((item, index) => checkText(item, `${name}[${index}]`, max));
}

function checkCriteria(value: string[] | undefined, name: string): string[] {
  const criteria = checkList(value, name, LIMITS.text);
  if (new Set(criteria).size !== criteria.length) throw new Error(`${name} has duplicate criteria`);
  return criteria;
}

/** The plan-change rationale and evidence rule (decision 9). */
function checkSubstantive(value: string | undefined, name: string, max: number): string {
  const checked = checkText(value, name, max);
  if (!isSubstantive(checked))
    throw new Error(`${name} must be substantive: at least 5 words and 32 characters`);
  return checked;
}

function required<T>(value: T | undefined, name: string, op: string): T {
  if (value === undefined) throw new Error(`${name} is required for ultragoal ${op}`);
  return value;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function readPlanTx(tx: WorkflowTx): Promise<GoalsFile | undefined> {
  const read = parseGoals(await tx.readText(tx.paths.ultragoal.goals));
  if (read.kind === "invalid") throw new Error(`goals.json is invalid: ${read.error}`);
  return read.kind === "valid" ? read.file : undefined;
}

async function requirePlanTx(tx: WorkflowTx): Promise<GoalsFile> {
  const file = await readPlanTx(tx);
  if (!file) throw new Error(NO_PLAN);
  return file;
}

async function readLedgerTx(tx: WorkflowTx): Promise<LedgerRow[]> {
  const read = parseLedger(await tx.readText(tx.paths.ultragoal.ledger));
  if (read.kind === "invalid") throw new Error(`ledger.jsonl is invalid: ${read.error}`);
  return read.rows;
}

function goalOf(file: GoalsFile, goalId: string | undefined, op: string): Goal {
  const id = required(goalId, "goal_id", op).trim();
  const goal = file.goals.find((item) => item.id === id);
  if (!goal) throw new Error(unknownGoal(id));
  return goal;
}

// ---------------------------------------------------------------------------
// Writes, each with its audit row (C-6)
// ---------------------------------------------------------------------------

function newRow(
  fields: LedgerEventFields | { type: "reconcile_failed"; error: string },
  eventId: string = randomUUID(),
): LedgerRow {
  return ledgerRow(fields, { eventId, timestamp: now() }) as LedgerRow;
}

async function writePlanTx(tx: WorkflowTx, file: GoalsFile, owner: AuditOwner): Promise<void> {
  await tx.writeText(tx.paths.ultragoal.goals, serializeGoals(file));
  await appendAudit(tx, { category: "state", verb: "write", owner, skill: SKILL, path: tx.paths.ultragoal.goals });
}

async function appendLedgerTx(tx: WorkflowTx, rows: readonly LedgerRow[], owner: AuditOwner): Promise<void> {
  for (const row of rows) {
    await tx.appendLine(tx.paths.ultragoal.ledger, serializeLedgerRow(row));
    await appendAudit(tx, { category: "ledger", verb: "append", owner, skill: SKILL, path: tx.paths.ultragoal.ledger });
  }
}

async function writeProgressTx(tx: WorkflowTx, text: string, owner: AuditOwner): Promise<void> {
  await tx.writeText(tx.paths.ultragoal.progress, text);
  await appendAudit(tx, {
    category: "artifact",
    verb: "write",
    owner,
    skill: SKILL,
    path: tx.paths.ultragoal.progress,
  });
}

// ---------------------------------------------------------------------------
// Reconcile (C-4, DR-20)
// ---------------------------------------------------------------------------

/**
 * gjc `reconcileUltragoalState`: the run status of `goals.json` (DR-1) is
 * forced onto the ultragoal mode-state (audit `reconcile`, `forced: true`),
 * then the row, snapshot and HUD. A missing plan reconciles to an inactive
 * `missing`. A corrupt state is replaced, as gjc's reconcile does. A failure
 * never changes the op's result: it appends gjc's `{type:
 * "reconcile_failed", error}` ledger row (best-effort).
 */
export async function reconcileUltragoalTx(
  tx: WorkflowTx,
  sessionId: string,
  owner: AuditOwner = RUNTIME_OWNER,
): Promise<void> {
  try {
    const file = await readPlanTx(tx);
    const status: UltragoalPhase = file ? deriveRunStatus(file) : "missing";
    const active = file !== undefined && status !== "complete";
    const latest = latestLedgerEvent(await tx.readText(tx.paths.ultragoal.ledger));
    const payload: Json = {
      skill: SKILL,
      status,
      current_phase: status,
      active,
      goals: (file?.goals ?? []).map((goal) => ({ id: goal.id, title: goal.title, status: goal.status })),
      counts: countGoals(file ?? { goals: [] }),
      active_goal_id: (file && currentGoal(file)?.id) ?? null,
      goals_path: tx.paths.ultragoal.goals,
      ledger_path: tx.paths.ultragoal.ledger,
      progress_path: tx.paths.ultragoal.progress,
      ...(latest ? { latestLedgerEvent: latest } : {}),
    };
    let existing: Json = {};
    try {
      existing = payloadOf(await tx.readModeState(SKILL));
    } catch {
      // A corrupt state is replaced, as gjc's reconcile does.
    }
    const at = now();
    const merged = mergeWithNullDelete(existing, payload);
    merged.skill = SKILL;
    merged.current_phase = status;
    merged.active = active;
    merged.version = WORKFLOW_STATE_VERSION;
    merged.updated_at = at;
    if (typeof merged.session_id !== "string") merged.session_id = sessionId;
    const envelopeError = workflowEnvelopeError(SKILL, merged);
    if (envelopeError) throw new Error(envelopeError);
    await tx.writeModeState(SKILL, merged, writerOf(owner));
    await appendAudit(tx, {
      category: "state",
      verb: "reconcile",
      owner,
      skill: SKILL,
      mutationId: `${SKILL}:reconcile:${at}`,
      fromPhase: trimmed(existing.current_phase),
      toPhase: status,
      forced: true,
      path: tx.paths.modeState(SKILL),
    });
    await syncActiveRowTx(
      tx,
      { skill: SKILL, active, phase: status, sessionId, hud: buildUltragoalHudFromState(merged, at) },
      owner,
    );
  } catch (error) {
    try {
      await appendLedgerTx(tx, [newRow({ type: "reconcile_failed", error: message(error) })], owner);
    } catch {
      // Best-effort audit; a secondary failure never changes the op's result.
    }
  }
}

/**
 * DR-21 (deviation 35): the `skill ultragoal` load seed (gjc
 * `hooks/skill-state.ts:429-470`). A missing or inactive ultragoal state is
 * merged over its kept fields into an active `goal-planning` state, where gjc
 * writes a new file only (`expectedRevision: 0`); an active one keeps its
 * phase. Either way the row is written active, which removes the upstream
 * ralplan and deep-interview rows (D-SF2, `syncSkillActiveState`), and the
 * snapshot is rebuilt. A corrupt state is left in place and nothing is
 * written. Returns what happened.
 */
export async function seedUltragoalTx(
  tx: WorkflowTx,
  sessionId: string,
  owner: AuditOwner = HOOK_OWNER,
): Promise<"seeded" | "kept" | "corrupt"> {
  let existing: Json | undefined;
  try {
    const stored = await tx.readModeState(SKILL);
    existing = stored === undefined ? undefined : payloadOf(stored);
  } catch {
    return "corrupt";
  }
  const at = now();
  const kept = existing?.active === true;
  let state: Json;
  if (kept) {
    state = existing!;
  } else {
    state = {
      ...existing,
      skill: SKILL,
      version: WORKFLOW_STATE_VERSION,
      active: true,
      current_phase: ULTRAGOAL_INITIAL_STATE,
      updated_at: at,
    };
    if (typeof state.session_id !== "string") state.session_id = sessionId;
    await tx.writeModeState(SKILL, state, writerOf(owner));
    await appendAudit(tx, {
      category: "state",
      verb: "write",
      owner,
      skill: SKILL,
      mutationId: `${SKILL}:seed:${at}`,
      fromPhase: trimmed(existing?.current_phase),
      toPhase: ULTRAGOAL_INITIAL_STATE,
      path: tx.paths.modeState(SKILL),
    });
  }
  await syncActiveRowTx(
    tx,
    {
      skill: SKILL,
      active: true,
      phase: trimmed(state.current_phase) ?? ULTRAGOAL_INITIAL_STATE,
      sessionId,
      hud: buildUltragoalHudFromState(state, at),
    },
    owner,
  );
  return kept ? "kept" : "seeded";
}

// ---------------------------------------------------------------------------
// status, create, next
// ---------------------------------------------------------------------------

/** `status`: the C-14 summary, then the reconcile. */
export async function statusTx(tx: WorkflowTx, sessionId: string): Promise<string> {
  const file = await readPlanTx(tx);
  let text: string;
  if (!file) {
    text = renderStatus({ goalsPath: tx.paths.ultragoal.goals, ledgerPath: tx.paths.ultragoal.ledger });
  } else {
    const rows = await readLedgerTx(tx);
    const goal = visibleGoal(await readGoalStateTx(tx));
    text = renderStatus({
      goalsPath: tx.paths.ultragoal.goals,
      ledgerPath: tx.paths.ultragoal.ledger,
      file,
      rows,
      objective: goalObjectiveOf(tx),
      goal: goal ? { status: goal.status, source: goal.source } : undefined,
    });
  }
  await reconcileUltragoalTx(tx, sessionId);
  return text;
}

/**
 * `create` (DR-25, D-TL10): overwrite `goals.json` (every goal pending),
 * append `plan_created`, append the `PLAN` note, arm the goal, reconcile.
 */
export async function createTx(tx: WorkflowTx, sessionId: string, args: UltragoalArgs): Promise<string> {
  const description = checkText(args.description, "description", LIMITS.text);
  const inputs = args.goals ?? [];
  if (inputs.length === 0) throw new Error("goals needs at least one goal");
  if (inputs.length > MAX_GOALS) throw new Error(`at most ${MAX_GOALS} goals`);
  const goals: GoalInput[] = inputs.map((goal, index) => ({
    title: checkText(goal.title, `goals[${index}].title`, LIMITS.title),
    description: checkText(goal.description, `goals[${index}].description`, LIMITS.text),
    acceptanceCriteria: checkCriteria(goal.acceptanceCriteria, `goals[${index}].acceptanceCriteria`),
  }));
  const at = now();
  const file = buildGoalsFile({ description, goals, now: at });
  const progress = progressForCreate(await tx.readText(tx.paths.ultragoal.progress), description, at);

  // C-9: the goal this plan runs under.
  const objective = goalObjectiveOf(tx);
  const existingGoal = await readGoalStateTx(tx);
  let arming: GoalArming;
  let armed: ReturnType<typeof createGoalState> | undefined;
  if (!isOpenGoal(existingGoal)) {
    armed = createGoalState(existingGoal, { id: randomUUID(), objective, source: "ultragoal", now: at });
    arming = { kind: "created", objective };
  } else if (existingGoal.source === "ultragoal" || existingGoal.objective.trim() === objective) {
    arming = { kind: "kept", status: existingGoal.status };
  } else {
    arming = { kind: "not-armed", status: existingGoal.status, source: existingGoal.source };
  }

  await writePlanTx(tx, file, RUNTIME_OWNER);
  await appendLedgerTx(
    tx,
    [newRow({ event: "plan_created", goalIds: file.goals.map((goal) => goal.id), description })],
    RUNTIME_OWNER,
  );
  await writeProgressTx(tx, progress, RUNTIME_OWNER);
  if (armed) await writeGoalStateTx(tx, armed, "ultragoal");
  await reconcileUltragoalTx(tx, sessionId);
  return renderCreate({ goalCount: file.goals.length, goalsPath: tx.paths.ultragoal.goals, arming });
}

/** `next` (DR-2, DR-3): the next goal becomes active; an active one is returned as is. */
export async function nextTx(tx: WorkflowTx, sessionId: string, args: UltragoalArgs): Promise<string> {
  const file = await requirePlanTx(tx);
  const rows = await readLedgerTx(tx);
  let action = resolveNextAction(file, args.retry_failed === true);
  let plan = file;
  if (action.kind === "execute-goal" && action.goal.status !== "active") {
    const at = now();
    plan = structuredClone(file);
    const goal = plan.goals.find((item) => item.id === (action as { goal: Goal }).goal.id)!;
    goal.status = "active";
    goal.started_at = goal.started_at ?? at;
    plan.updated_at = at;
    await writePlanTx(tx, plan, RUNTIME_OWNER);
    await appendLedgerTx(tx, [newRow({ event: "goal_started", goalId: goal.id })], RUNTIME_OWNER);
    action = { kind: "execute-goal", goal };
  }
  const view = action.kind === "execute-goal" ? completionView(plan, action.goal.id) : undefined;
  const text = renderNext({
    action,
    goalObjective: goalObjectiveOf(tx),
    finalGate: view?.receiptKind === "final-aggregate",
    criteria: view?.activeCriterionIds,
    run: action.kind === "none" ? runCompletion(plan, rows) : undefined,
  });
  await reconcileUltragoalTx(tx, sessionId);
  return text;
}

// ---------------------------------------------------------------------------
// checkpoint and validate_gate (DR-4, C-8)
// ---------------------------------------------------------------------------

/** gjc's missing-gate refusal with the op's input name (deviation 41). */
const GATE_REQUIRED =
  "complete checkpoints require gate with targetedVerification, architectReview and criteriaCoverage evidence";

/**
 * `checkpoint` (DR-4): evidence, the idempotent replay (E-15), the start
 * status (C-15), then for `complete` the completion view, its gate and the
 * progress fields; then `goals.json` (the goal, the superseded parent, the
 * next goal made active), `goal_checkpointed` (+ `goal_started`), the
 * progress entry, and the reconcile.
 */
export async function checkpointTx(tx: WorkflowTx, sessionId: string, args: UltragoalArgs): Promise<string> {
  const file = await requirePlanTx(tx);
  const goal = goalOf(file, args.goal_id, "checkpoint");
  const status = required(args.status, "status", "checkpoint");
  const evidence = (args.evidence ?? "").trim();
  if (!evidence) throw new Error(CHECKPOINT_EVIDENCE_REQUIRED);
  if (evidence.length > LIMITS.evidence) throw new Error(`evidence exceeds ${LIMITS.evidence} characters`);
  const rows = await readLedgerTx(tx);
  const goalObjective = goalObjectiveOf(tx);

  const replay =
    goal.status === status &&
    goal.evidence === evidence &&
    rows.some(
      (row) =>
        "event" in row &&
        row.event === "goal_checkpointed" &&
        row.goalId === goal.id &&
        row.status === status &&
        row.evidence === evidence,
    ) &&
    (status !== "complete" || isValidCompletion(checkReceipt(goal, rows)));
  if (replay) {
    const next = status === "complete" ? chooseNextGoal(file, false) : undefined;
    const text = renderCheckpoint({
      goalId: goal.id,
      status,
      allComplete: allRequiredComplete(file),
      nextGoal: next,
      nextCriteria: next && completionView(file, next.id).activeCriterionIds,
      startedNext: false,
      goalObjective,
      run: runCompletion(file, rows),
    });
    await reconcileUltragoalTx(tx, sessionId);
    return text;
  }

  const at = now();
  const eventId = randomUUID();
  let plan: GoalsFile;
  const added: LedgerRow[] = [];
  let progress: string | undefined;
  let nextGoal: Goal | undefined;
  let startedNext = false;
  if (status === "complete") {
    if (!isStatusAllowed("checkpoint-complete", goal.status)) throw new Error(completeCheckpointRefusal(goal));
    if (args.gate === undefined) throw new Error(GATE_REQUIRED);
    const view = completionView(file, goal.id, { evidence });
    const diagnostics = validateGate(args.gate, {
      receiptKind: view.receiptKind,
      activeCriterionIds: view.activeCriterionIds,
    });
    if (diagnostics.length > 0) throw new Error(renderGateDiagnostics(diagnostics));
    const implementation = checkList(args.implementation, "implementation", LIMITS.text);
    const filesChanged = checkList(args.files_changed, "files_changed", LIMITS.text);
    const learnings = checkList(args.learnings, "learnings", LIMITS.text);

    plan = view.file;
    const target = view.goal;
    target.completionVerification = buildCompletionVerification({
      receiptKind: view.receiptKind,
      criteria: target.acceptanceCriteria,
      gate: args.gate,
      checkpointLedgerEventId: eventId,
      verifiedAt: at,
    });
    target.status = "complete";
    target.evidence = evidence;
    target.completed_at = at;
    // PQ-9 A (gjc `advanceNext`): a pending next goal becomes active.
    nextGoal = chooseNextGoal(plan, false);
    if (nextGoal && nextGoal.status !== "active") {
      nextGoal.status = "active";
      nextGoal.started_at = nextGoal.started_at ?? at;
      startedNext = true;
    }
    added.push(
      newRow(
        {
          event: "goal_checkpointed",
          goalId: goal.id,
          status,
          evidence,
          qualityGateJson: args.gate,
          completionVerification: target.completionVerification,
        },
        eventId,
      ),
    );
    if (startedNext) added.push(newRow({ event: "goal_started", goalId: nextGoal!.id }));
    progress = appendProgressEntry(
      (await tx.readText(tx.paths.ultragoal.progress)) ?? initialProgress(at),
      { goalId: goal.id, implementation, filesChanged, learnings },
      at,
    );
  } else {
    // C-15: `pending` (reopen), `failed` and `blocked` from any status; the
    // receipt stays (gjc `rt:3752-3767`).
    plan = structuredClone(file);
    const target = plan.goals.find((item) => item.id === goal.id)!;
    target.status = status;
    target.evidence = evidence;
    added.push(
      newRow(
        {
          event: "goal_checkpointed",
          goalId: goal.id,
          status,
          evidence,
          ...(args.gate !== undefined ? { qualityGateJson: args.gate } : {}),
          ...(target.completionVerification ? { completionVerification: target.completionVerification } : {}),
        },
        eventId,
      ),
    );
  }
  plan.updated_at = at;

  await writePlanTx(tx, plan, RUNTIME_OWNER);
  await appendLedgerTx(tx, added, RUNTIME_OWNER);
  if (progress !== undefined) await writeProgressTx(tx, progress, RUNTIME_OWNER);
  const text = renderCheckpoint({
    goalId: goal.id,
    status,
    allComplete: allRequiredComplete(plan),
    nextGoal,
    nextCriteria: nextGoal && completionView(plan, nextGoal.id).activeCriterionIds,
    startedNext,
    goalObjective,
    run: runCompletion(plan, [...rows, ...added]),
  });
  await reconcileUltragoalTx(tx, sessionId);
  return text;
}

/**
 * `validate_gate` (D-VF12): the `checkpoint(complete)` judgement of the named
 * goal, or else the first schedulable one, in its completion view; no goal
 * checks the shape only. Nothing is written and nothing reconciles.
 */
export async function validateGateTx(tx: WorkflowTx, args: UltragoalArgs): Promise<string> {
  const gate = required(args.gate, "gate", "validate_gate");
  const file = await readPlanTx(tx);
  let goal: Goal | undefined;
  if (args.goal_id !== undefined) {
    const id = args.goal_id.trim();
    goal = file?.goals.find((item) => item.id === id);
    if (!goal)
      return renderGateDiagnostics([
        { path: "goalId", code: "unknown_goal", message: `Unknown ultragoal goal ${id}` },
      ]);
  } else if (file) {
    goal = currentGoal(file);
  }
  if (!file || !goal) return renderGateDiagnostics(validateGate(gate, { receiptKind: "per-goal" }));
  const view = completionView(file, goal.id);
  return renderGateDiagnostics(
    validateGate(gate, { receiptKind: view.receiptKind, activeCriterionIds: view.activeCriterionIds }),
  );
}

// ---------------------------------------------------------------------------
// add / revise / supersede (D-AG6, C-15)
// ---------------------------------------------------------------------------

function goalDefinition(goal: Pick<Goal, "title" | "description">): string {
  return JSON.stringify({ title: goal.title, description: goal.description });
}

function requireStatus(
  op: SteeringKind,
  target: "goal" | "criterion",
  rule: StatusRuleOp,
  goal: Goal,
  allowed: readonly Goal["status"][],
): void {
  if (!isStatusAllowed(rule, goal.status)) throw new Error(planChangeStatusRefusal(op, target, goal, allowed));
}

/**
 * `add`/`revise`/`supersede` of a goal or a criterion: the change, the
 * amendment on the goal it touched, `steering_accepted`, the reconcile. The
 * result names the new or changed goal or criterion id (C-14).
 */
export async function steerTx(
  tx: WorkflowTx,
  sessionId: string,
  op: SteeringKind,
  args: UltragoalArgs,
): Promise<string> {
  if (args.reason !== undefined)
    throw new Error(`ultragoal ${op} takes rationale, not reason (reason is for handoff)`);
  const file = await requirePlanTx(tx);
  const target = required(args.target, "target", op);
  const rationale = checkSubstantive(args.rationale, "rationale", LIMITS.text);
  const evidence = checkSubstantive(args.evidence, "evidence", LIMITS.evidence);
  const at = now();
  const plan = structuredClone(file);
  const entry = { rationale, evidence, timestamp: at };
  let goalId: string;
  let criterionId: string | undefined;
  let resultId: string;
  let amendment: Amendment;
  let after: string | undefined;

  if (target === "goal" && op === "add") {
    if (plan.goals.length >= MAX_GOALS) throw new Error(`at most ${MAX_GOALS} goals`);
    after = args.after?.trim();
    const goal = newGoal(nextGoalId(plan), {
      title: checkText(args.title, "title", LIMITS.title),
      description: checkText(args.description, "description", LIMITS.text),
      acceptanceCriteria: checkCriteria(args.acceptanceCriteria, "acceptanceCriteria"),
    });
    amendment = {
      target,
      kind: "added",
      replacement: goalDefinition(goal),
      ...(after ? { after } : {}),
      ...entry,
    };
    goal.amendments.push(amendment);
    plan.goals = insertAfter(plan.goals, goal, after);
    goalId = resultId = goal.id;
  } else {
    const goal = goalOf(plan, args.goal_id, op);
    goalId = resultId = goal.id;
    if (target === "goal" && op === "revise") {
      if (args.title === undefined && args.description === undefined && args.after === undefined)
        throw new Error("ultragoal revise (goal) needs title, description or after");
      if (args.title !== undefined || args.description !== undefined)
        requireStatus(op, target, "revise-goal", goal, ["pending"]);
      after = args.after?.trim();
      if (after !== undefined) requireStatus(op, target, "move-goal", goal, ["pending"]);
      const original = goalDefinition(goal);
      if (args.title !== undefined) goal.title = checkText(args.title, "title", LIMITS.title);
      if (args.description !== undefined)
        goal.description = checkText(args.description, "description", LIMITS.text);
      amendment = {
        target,
        kind: "revised",
        original,
        replacement: goalDefinition(goal),
        ...(after ? { after } : {}),
        ...entry,
      };
      goal.amendments.push(amendment);
      if (after !== undefined) plan.goals = moveAfter(plan.goals, goal.id, after);
    } else if (target === "goal") {
      requireStatus(op, target, "supersede-goal", goal, ["pending", "blocked", "review_blocked"]);
      if (isOnlyRequiredGoal(plan, goal.id)) throw new Error(onlyRequiredGoalRefusal(goal.id));
      amendment = { target, kind: "superseded", original: goalDefinition(goal), ...entry };
      goal.status = "superseded";
      goal.evidence = evidence;
      goal.amendments.push(amendment);
    } else {
      const rule: StatusRuleOp = `${op}-criterion`;
      requireStatus(op, target, rule, goal, ["pending"]);
      if (op === "add") {
        const text = checkText(args.criterion, "criterion", LIMITS.text);
        if (goal.acceptanceCriteria.some((criterion) => criterion.text === text))
          throw new Error(`${goal.id} already has this criterion`);
        criterionId = resultId = nextCriterionId(goal);
        goal.acceptanceCriteria.push({ id: criterionId, text });
        amendment = { target, kind: "added", criterionId, replacement: text, ...entry };
      } else {
        criterionId = required(args.criterion_id, "criterion_id", op).trim();
        const index = goal.acceptanceCriteria.findIndex((criterion) => criterion.id === criterionId);
        if (index === -1) throw new Error(`${criterionId} is not an active criterion of ${goal.id}`);
        const original = goal.acceptanceCriteria[index].text;
        if (op === "revise") {
          const text = checkText(args.criterion, "criterion", LIMITS.text);
          if (goal.acceptanceCriteria.some((criterion, other) => other !== index && criterion.text === text))
            throw new Error(`${goal.id} already has this criterion`);
          // PQ-22 A: the revised criterion gets a new number; the old one retires.
          const replacementId = nextCriterionId(goal);
          goal.acceptanceCriteria[index] = { id: replacementId, text };
          amendment = { target, kind: "revised", criterionId, replacementId, original, replacement: text, ...entry };
          resultId = replacementId;
        } else {
          if (goal.acceptanceCriteria.length === 1) throw new Error(lastCriterionRefusal(goal.id));
          goal.acceptanceCriteria.splice(index, 1);
          amendment = { target, kind: "superseded", criterionId, original, ...entry };
          resultId = criterionId;
        }
      }
      goal.amendments.push(amendment);
    }
  }
  plan.updated_at = at;

  await writePlanTx(tx, plan, RUNTIME_OWNER);
  await appendLedgerTx(
    tx,
    [
      newRow({
        event: "steering_accepted",
        kind: op,
        target,
        goalId,
        ...(criterionId ? { criterionId } : {}),
        ...(after ? { after } : {}),
        rationale,
        evidence,
        amendment,
      }),
    ],
    RUNTIME_OWNER,
  );
  await reconcileUltragoalTx(tx, sessionId);
  return renderSteering(op, resultId);
}

// ---------------------------------------------------------------------------
// add_pattern, record_review_blockers, classify_blocker, record_critic_verdict
// ---------------------------------------------------------------------------

/** `add_pattern`: one Codebase Patterns line; no reconcile (PQ-25 B). */
export async function addPatternTx(tx: WorkflowTx, args: UltragoalArgs): Promise<string> {
  const pattern = checkText(args.pattern, "pattern", LIMITS.pattern);
  if (/[\r\n]/.test(pattern)) throw new Error("pattern must be a single line");
  const progress = await tx.readText(tx.paths.ultragoal.progress);
  if (progress === undefined) throw new Error("no progress.txt yet; call ultragoal create first");
  await writeProgressTx(tx, addProgressPattern(progress, pattern), RUNTIME_OWNER);
  return PATTERN_ADDED;
}

/**
 * `record_review_blockers` (DR-6): dedup and the cap on `goals.json` before
 * any write; then one `goals.json` write (the parent `review_blocked`, the
 * fix goal appended), `goal_checkpointed`, `review_blockers_recorded`, the
 * reconcile. A dedup hit returns the open fix goal without writing.
 */
export async function recordReviewBlockersTx(
  tx: WorkflowTx,
  sessionId: string,
  args: UltragoalArgs,
): Promise<string> {
  const objective = (args.objective ?? "").trim();
  if (!objective) throw new Error("record_review_blockers objective is required");
  if (objective.length > LIMITS.objective) throw new Error(OBJECTIVE_TOO_LONG);
  const file = await requirePlanTx(tx);
  const blockedId = required(args.goal_id, "goal_id", "record_review_blockers").trim();
  const existing = findOpenReviewBlockerGoal(file, objective);
  if (existing?.steering?.blockedGoalId === blockedId) {
    await reconcileUltragoalTx(tx, sessionId);
    return renderReviewBlockers(existing.id);
  }
  const descents = countUnresolvedReviewBlockerDescents(file, blockedId);
  if (descents >= MAX_REVIEW_BLOCKER_DESCENTS) throw new Error(reviewBlockerCapRefusal(blockedId, descents));
  const blocked = goalOf(file, blockedId, "record_review_blockers");
  const evidence = (args.evidence ?? "").trim();
  if (!evidence) throw new Error(CHECKPOINT_EVIDENCE_REQUIRED);
  if (evidence.length > LIMITS.evidence) throw new Error(`evidence exceeds ${LIMITS.evidence} characters`);
  const title =
    args.title === undefined || args.title.trim() === ""
      ? FIX_GOAL_DEFAULT_TITLE
      : checkText(args.title, "title", LIMITS.title);

  const at = now();
  const plan = structuredClone(file);
  const parent = plan.goals.find((item) => item.id === blocked.id)!;
  parent.status = "review_blocked";
  parent.evidence = evidence;
  const fix: Goal = {
    ...newGoal(nextGoalId(plan), {
      title,
      description: objective,
      acceptanceCriteria: [fixCriterionText(objective)],
    }),
    steering: { kind: "review_blocker", blockedGoalId: blocked.id },
  };
  plan.goals.push(fix);
  plan.updated_at = at;

  await writePlanTx(tx, plan, RUNTIME_OWNER);
  await appendLedgerTx(
    tx,
    [
      newRow({
        event: "goal_checkpointed",
        goalId: blocked.id,
        status: "review_blocked",
        evidence,
        ...(parent.completionVerification ? { completionVerification: parent.completionVerification } : {}),
      }),
      newRow({ event: "review_blockers_recorded", goalId: blocked.id, blockerGoalId: fix.id }),
    ],
    RUNTIME_OWNER,
  );
  await reconcileUltragoalTx(tx, sessionId);
  return renderReviewBlockers(fix.id);
}

/** `classify_blocker` (DR-7): one `blocker_classified` row; its id is the result. */
export async function classifyBlockerTx(tx: WorkflowTx, sessionId: string, args: UltragoalArgs): Promise<string> {
  const evidence = (args.evidence ?? "").trim();
  if (!evidence) throw new Error("classify_blocker evidence is required");
  if (evidence.length > LIMITS.evidence) throw new Error(`evidence exceeds ${LIMITS.evidence} characters`);
  const classification = required(args.classification, "classification", "classify_blocker");
  const goalId = args.goal_id?.trim();
  const row = newRow({
    event: "blocker_classified",
    classification,
    ...(goalId ? { goalId } : {}),
    evidence,
  });
  await appendLedgerTx(tx, [row], RUNTIME_OWNER);
  await reconcileUltragoalTx(tx, sessionId);
  return renderBlockerClassification(classification, row.eventId);
}

/**
 * `record_critic_verdict` (DR-8): gjc's checks, one `critic_verdict` row (no
 * hard stop, D-VF9), and the PQ-3 streak counted after the continuation
 * record's release marker, as the goal hook counts it.
 */
export async function recordCriticVerdictTx(
  tx: WorkflowTx,
  sessionId: string,
  args: UltragoalArgs,
): Promise<string> {
  const evidence = (args.evidence ?? "").trim();
  if (!evidence) throw new Error("record_critic_verdict evidence is required");
  if (evidence.length > LIMITS.evidence) throw new Error(`evidence exceeds ${LIMITS.evidence} characters`);
  const terminus = required(args.terminus, "terminus", "record_critic_verdict");
  const verdict = required(args.verdict, "verdict", "record_critic_verdict");
  const blockers = (args.blockers ?? []).map((blocker, index) => checkText(blocker, `blockers[${index}]`, LIMITS.text));
  if (verdict === "OKAY" && blockers.length > 0) throw new Error("OKAY critic verdict must have empty blockers");
  const classificationEventId = args.classification_event_id?.trim();
  if (terminus === "pause" && !classificationEventId)
    throw new Error("record_critic_verdict classification_event_id is required for pause verdicts");
  if (!(await readPlanTx(tx))) throw new Error("record_critic_verdict requires an active ultragoal plan");
  const rows = await readLedgerTx(tx);
  if (terminus === "pause") {
    const latest = [...rows]
      .reverse()
      .find((row) => "event" in row && row.event === "blocker_classified");
    if (
      !latest ||
      !("event" in latest) ||
      latest.event !== "blocker_classified" ||
      latest.classification !== "human_blocked" ||
      latest.eventId !== classificationEventId
    )
      throw new Error(
        "record_critic_verdict pause requires classification_event_id to name the latest human_blocked classification",
      );
  }
  const goalId = args.goal_id?.trim();
  const row = newRow({
    event: CRITIC_VERDICT_EVENT,
    terminus,
    verdict,
    evidence,
    blockers,
    ...(classificationEventId ? { classificationEventId } : {}),
    ...(goalId ? { goalId } : {}),
  });
  const goal = visibleGoal(await readGoalStateTx(tx));
  const record = parseGoalContinuation(await tx.readText(tx.paths.goalContinuation));
  const resetAfter = goal ? continuationForGoal(record, goal.id).critic_reset_after : undefined;

  await appendLedgerTx(tx, [row], RUNTIME_OWNER);
  await reconcileUltragoalTx(tx, sessionId);
  return renderCriticVerdict(verdict, terminus, criticNonOkayStreak([...rows, row], resetAfter));
}

// ---------------------------------------------------------------------------
// handoff, doctor, state, clear (C-3, C-5, DR-12, DR-14, DR-15)
// ---------------------------------------------------------------------------

/**
 * `handoff` (C-5): the shared journaled handoff with ultragoal as the caller;
 * the goal is left alone. Its `recordCaller` step appends the ledger
 * `workflow_handoff` row and the progress `HANDOFF` note. The result is the
 * gjc state-verb JSON receipt.
 */
export async function handoffTx(tx: WorkflowTx, sessionId: string, args: UltragoalArgs): Promise<string> {
  const to = required(args.to, "to", "handoff");
  const reason = trimmed(args.reason);
  if (!reason) throw new Error("reason is required (a non-empty string)");
  const receipt = await handoffWorkflowTx(tx, {
    caller: SKILL,
    callee: to,
    sessionId,
    owner: RUNTIME_OWNER,
    reason,
    recordCaller: async ({ at }) => {
      await appendLedgerTx(tx, [newRow({ event: "workflow_handoff", to, reason })], RUNTIME_OWNER);
      await writeProgressTx(
        tx,
        progressForHandoff(await tx.readText(tx.paths.ultragoal.progress), to, reason, at),
        RUNTIME_OWNER,
      );
    },
  });
  return renderWriteReceipt(receipt);
}

/** `doctor` (DR-15): the ultragoal scan as gjc's doctor text. */
export async function doctorTx(tx: WorkflowTx): Promise<string> {
  return renderDoctorText(await collectDoctorSummaryTx(tx, SKILL));
}

/**
 * `state` (PQ-1 A): gjc's open merge patch (`null` deletes) without the
 * derived fields; `current_phase` must be a manifest phase and an edge from
 * the stored one. The state is written and audited, then the row
 * (best-effort, as gjc's state verbs).
 */
export async function patchStateTx(tx: WorkflowTx, sessionId: string, args: UltragoalArgs): Promise<string> {
  const patch = required(args.patch, "patch", "state");
  let existing: Json;
  try {
    existing = payloadOf(await tx.readModeState(SKILL));
  } catch (error) {
    throw new Error(
      `existing state for ultragoal is corrupt or tampered (${message(error)}); reset it with \`ultragoal clear\` and force: true`,
      { cause: error },
    );
  }
  const { _meta, ...payload } = patch;
  const derivedError = derivedFieldPatchError(payload);
  if (derivedError) throw new Error(derivedError);
  const at = now();
  const mutationId = `${SKILL}:${at}`;
  const incomingPhase = trimmed(payload.current_phase) ?? trimmed(payload.phase);
  const merged = mergeWithNullDelete(existing, payload);
  const preError = workflowEnvelopeError(SKILL, merged);
  if (preError) throw new Error(preError);
  merged.skill = SKILL;
  const fromPhase = trimmed(existing.current_phase);
  const toPhase = incomingPhase ?? trimmed(merged.current_phase) ?? fromPhase ?? ULTRAGOAL_INITIAL_STATE;
  merged.current_phase = toPhase;
  merged.version = WORKFLOW_STATE_VERSION;
  if (typeof merged.active !== "boolean") merged.active = true;
  merged.updated_at = at;
  if (typeof merged.session_id !== "string") merged.session_id = sessionId;
  const phaseError = ultragoalPhasePatchError(fromPhase, toPhase);
  if (phaseError) throw new Error(phaseError);
  const postError = workflowEnvelopeError(SKILL, merged);
  if (postError) throw new Error(postError);

  await tx.writeModeState(SKILL, merged, "ultragoal_tool");
  await appendAudit(tx, {
    category: "state",
    verb: "write",
    owner: RUNTIME_OWNER,
    skill: SKILL,
    mutationId,
    fromPhase,
    toPhase,
    path: tx.paths.modeState(SKILL),
  });
  const active = merged.active !== false;
  try {
    await syncActiveRowTx(
      tx,
      { skill: SKILL, active, phase: toPhase, sessionId, hud: buildUltragoalHudFromState(merged, at) },
      RUNTIME_OWNER,
    );
  } catch {
    // gjc's state-verb HUD sync is best-effort.
  }
  return renderWriteReceipt({
    ok: true,
    skill: SKILL,
    state_path: tx.paths.modeState(SKILL),
    current_phase: toPhase,
    active,
    mutation_id: mutationId,
  });
}

/**
 * gjc `describeStaleClearState` for ultragoal: a terminal mode-state phase
 * (the default guard-release set, `inactive` aside), or an active visible
 * entry (the row, else the snapshot entry) on another phase. An unreadable
 * row stops an unforced clear (ralplan deviation 35).
 */
async function describeStaleClearTx(tx: WorkflowTx, existing: Json): Promise<string | undefined> {
  const phase = trimmed(existing.current_phase);
  if (phase && ULTRAGOAL_GUARD_RELEASE_PHASES.has(phase) && phase !== "inactive")
    return `mode-state is already terminal (${phase})`;
  const rowPath = tx.paths.activeRow(SKILL);
  const { value: row, error } = await readRawJsonTx(tx, rowPath);
  if (error !== undefined) throw new Error(`active row ${rowPath} is unreadable (${error}); use force: true to clear`);
  let entry: unknown = isRecord(row) && row.skill === SKILL ? row : undefined;
  if (entry === undefined) {
    const { value: snapshot } = await readRawJsonTx(tx, tx.paths.snapshotPath);
    entry =
      isRecord(snapshot) && Array.isArray(snapshot.active_skills)
        ? (snapshot.active_skills as unknown[]).find((item) => isRecord(item) && item.skill === SKILL)
        : undefined;
  }
  if (!activeFlag(entry)) return undefined;
  const activePhase = rowPhase(entry);
  if (activePhase && phase && activePhase !== phase)
    return `active-state phase ${activePhase} differs from mode-state phase ${phase}`;
  return undefined;
}

/**
 * `clear` (DR-14): without `force`, a corrupt and then a stale state are
 * refused; then `{active: false, current_phase: "complete"}` over the kept
 * fields (the minimal envelope over a corrupt state), files kept, the row
 * removed. The goal is left alone; an open one gets the `goal drop` line (I-10).
 */
export async function clearStateTx(tx: WorkflowTx, sessionId: string, args: UltragoalArgs): Promise<string> {
  const force = args.force === true;
  let existing: Json = {};
  try {
    existing = payloadOf(await tx.readModeState(SKILL));
  } catch (error) {
    if (!force)
      throw new Error(
        `existing state for ultragoal is corrupt or tampered (${message(error)}); use force: true to overwrite`,
        { cause: error },
      );
  }
  const staleReason = force ? undefined : await describeStaleClearTx(tx, existing);
  if (staleReason) throw new Error(`existing state for ultragoal is stale (${staleReason}); use force: true to clear`);
  const goal = await readGoalStateTx(tx).catch(() => undefined);
  const at = now();
  const mutationId = `${SKILL}:clear:${at}`;
  const cleared: Json = {
    skill: SKILL,
    ...existing,
    active: false,
    current_phase: "complete",
    updated_at: at,
    version: WORKFLOW_STATE_VERSION,
  };
  cleared.skill = SKILL;
  await tx.writeModeState(SKILL, cleared, "ultragoal_tool");
  await appendAudit(tx, {
    category: "state",
    verb: "clear",
    owner: RUNTIME_OWNER,
    skill: SKILL,
    mutationId,
    fromPhase: trimmed(existing.current_phase),
    toPhase: "complete",
    forced: force,
    path: tx.paths.modeState(SKILL),
  });
  try {
    await syncActiveRowTx(tx, { skill: SKILL, active: false, sessionId }, RUNTIME_OWNER);
  } catch {
    // gjc's state-verb HUD sync is best-effort.
  }
  return renderClear(
    {
      ok: true,
      skill: SKILL,
      state_path: tx.paths.modeState(SKILL),
      active: false,
      current_phase: "complete",
      mutation_id: mutationId,
    },
    isOpenGoal(goal) ? goal.status : undefined,
  );
}
