// Ralplan record operations: the state envelope and its transition audit, the
// stage files, the run ledger (`index.jsonl`) and `pending-approval.md`, the
// active row `state/active/ralplan.json` and the snapshot
// `state/skill-active-state.json`, with one `state/audit.jsonl` row per file
// change (DR-18). Every `*Tx` function takes the `tx` of one
// `StateStore.ralplanTransaction` (the session's one workflow queue, ultragoal
// revision plan C-1) and never calls a queued StateStore method (C-1.1); the
// exported entry points wrap exactly one transaction each, and the
// cross-skill ones run their transactions one after another, never nested
// (C-1.2, C-1.3). The audit rows, the rows and snapshot, the doctor and the
// cross-skill handoff are shared with the other workflow skills in
// `../skill-state/` (audit.ts, rows.ts, doctor.ts, handoff.ts).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/ralplan-runtime.ts:885-899` (`readActiveRunId`), `:971-1059`
//   (`advanceCurrentPhase`, `persistActiveRunId`), `:1260-1374` (role and lane
//   metadata apply, `recordRalplanPlanningStuck`), `:1437-1468`
//   (`persistRalplanFinalAdmission`), `:1608-1674` (`persistArtifact`),
//   `:1759-1873` (`findOnDiskStageArtifact`, `ensureFinalPendingApproval`,
//   `repairMissingStageArtifactLedger`), `:1908-1931` (`syncRalplanHud`),
//   `:2033-2261` (`handleArtifactWrite`, DR-2 order), `:2263-2310`
//   (`buildDeduplicatedResult`), `:2382-2475` (`seedRalplanState`,
//   `handleConsensusHandoff`)
// - `gjc-runtime/state-runtime.ts:244-270` (`readActivePhaseForSkill`,
//   `describeStaleClearState`), `:826-839`
//   (`mergeWithNullDelete`), `:973-999` (`syncWorkflowSkillState`),
//   `:1156-1222` (`handleRead`), `:1235-1400` (`handleWrite`), `:1402-1490`
//   (`handleClear`), `:1739-1763` (handoff caller state)
// - `gjc-runtime/state-writer.ts:958-1067` (`readPersistedPhase`,
//   `recordInvalidWorkflowTransition`, `writeWorkflowEnvelopeAtomic`),
//   `:1234-1257` (`appendJsonlIdempotent`)
// - `gjc-runtime/state-migrations.ts:62-127` (`migrateWorkflowState` v1→v2)
// - `gjc-runtime/state-renderer.ts:82-190` (`STATE_FIELD_ALLOWLIST`,
//   `projectStateFields`)
// - `skill-state/active-state.ts:886-898` (stale entry replacement, gate ⑤),
//   `:507-546,666-683` (`readModeStatePhase`, `withCanonicalRalplanPhase`,
//   `mergeVisibleEntries`; the clear's stale check, R-OD14)
// - `skill-state/workflow-state-contract.ts:59-84` (state-write receipt on the
//   active row)
// Deviations (plan §7.1):
// - 1: CLI verbs become tool ops; messages name tool inputs (`force`,
//   `ralplan clear`) instead of `--force`/`gjc state …`.
// - 12: the repository binding is recorded, never enforced.
// - 13: doctor has no checksum or orphan-journal checks.
// - 17: no gjc envelope receipt, checksum or `state_revision`; the StateStore
//   `_meta` stays. Rows and the snapshot carry no `source_state_revision` /
//   `state_revision` and there is no stale-skip (R-OD6).
// - `clear` removes the row as gjc does (`syncWorkflowSkillState({active:
//   false})` → `persistActiveEntry` → `removeActiveEntry`,
//   `active-state.ts:849-866`); `handoff` keeps an inactive `handoff_to`
//   row, as gjc does, through `../skill-state/handoff.ts` (PQ-6 A).
// - 35: an unreadable active-row file stops an unforced `clear`, as in gjc,
//   but a forced clear skips reading it; gjc's clear throws on it even with
//   `--force` (`state-writer.ts:425-431` via `readActiveEntries`) (R-OD16).
// - 21: audit `owner` is `open-gajae-runtime` / `open-gajae-hook`.
// - 34: the handoff requires a phase in T (DR-7).
// DR-8 (R-OD5, gjc as-is): after a write the row `phase` and the `stage` chip
// are the stage just written; after start/state they are the resulting
// `current_phase`. The HUD sync is best-effort like gjc's (`:1908-1931`,
// `state-runtime.ts:973-999`); the handoff's row writes are not.

import path from "node:path";
import type { Settings } from "../config.js";
import { type AuditOwner, appendAudit, HOOK_OWNER, RUNTIME_OWNER } from "../skill-state/audit.js";
import {
  activeFlag,
  collectDoctorSummaryTx,
  type DoctorSummary,
  modeStatePhase,
  readRawJsonTx,
  rowPhase,
  workflowEnvelopeError,
} from "../skill-state/doctor.js";
import { syncActiveRowTx } from "../skill-state/rows.js";
import { type HandoffReceipt, handoffWorkflowTx } from "../skill-state/handoff.js";
import { type InterviewState, type StateStore, type WorkflowTx } from "../state.js";
import { captureRepositoryBinding } from "./binding.js";
import { buildRalplanHud, buildRalplanHudFromState } from "./hud.js";
import {
  buildDeduplicatedReceipt,
  buildLaneBudgetStuckResult,
  buildPlanningStuckResult,
  buildWriteReceipt,
  countRalplanOnDiskLaneArtifacts,
  countRalplanOnDiskOpeners,
  evaluateRalplanIterationCap,
  evaluateRalplanReviewLaneBudget,
  type ExistingStageArtifact,
  findExistingStageArtifact,
  findJsonlDuplicate,
  type LaneVerdictUpdate,
  laneVerdictStatePayload,
  loadRalplanIndexForCap,
  normalizeArtifactContent,
  normalizeDispositionArtifact,
  parseRalplanFinalAdmission,
  PLANNING_STUCK_MARKER,
  type PersistedRoleStateUpdate,
  persistedRoleStatePayload,
  RALPLAN_INDEX_FILE,
  RALPLAN_PENDING_APPROVAL_FILE,
  type RalplanAutoHandoffResolution,
  type RalplanIndexLoad,
  ralplanIndexKey,
  ralplanPlanningStuckIndexEntry,
  ralplanPlanningStuckIndexKey,
  ralplanStageFileName,
  ralplanStageIndexEntry,
  readRalplanPlanningStuck,
  resolveRalplanAutoHandoffTarget,
  reviewBudgetWarning,
  sha256Hex,
  stageOverwriteRefusal,
  unavailableRalplanFinalAdmission,
} from "./ledger.js";
import {
  advanceCurrentPhase,
  GUARD_RELEASE_PHASES,
  isValidTransition,
  RALPLAN_INITIAL_STATE,
  RALPLAN_PHASE_LOCK,
  RALPLAN_STATES,
  RALPLAN_TRANSITIONS,
  type RalplanStage,
  TERMINAL_PHASES,
} from "./manifest.js";

export { type AuditOwner, HOOK_OWNER, RUNTIME_OWNER } from "../skill-state/audit.js";

export type RalplanSettings = Settings["ralplan"];

/** gjc `WORKFLOW_STATE_VERSION`. */
const WORKFLOW_STATE_VERSION = 2;
/** gjc `WORKFLOW_STATE_RECEIPT_FRESH_MS`. */
const RECEIPT_FRESH_MS = 30 * 60 * 1000;
const SKILL = "ralplan";

/**
 * The `skill ultragoal` turn gate's refusal while this execution loaded an
 * active ralplan outside T (ultragoal revision plan C-10, I-7; R-O5 label).
 */
export const RALPLAN_RUNNING_REFUSAL =
  'ralplan planning is running; finish it first: choose "Approve execution via ultragoal" at its approval step, or stop ralplan (`ralplan state` with {"active": false}) and try again.';

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
function payloadOf(state: InterviewState | Json | undefined): Json {
  const { _meta, ...rest } = state ?? {};
  return rest;
}

function isManifestState(phase: string): boolean {
  return (RALPLAN_STATES as readonly string[]).includes(phase);
}

// ---------------------------------------------------------------------------
// Audit rows and the state envelope
// ---------------------------------------------------------------------------

type StateWriteAudit = {
  owner: AuditOwner;
  verb?: string;
  mutationId?: string;
  fromPhase?: string;
  toPhase?: string;
  forced?: boolean;
};

/**
 * gjc `writeWorkflowEnvelopeAtomic`: an unforced active write must name a
 * manifest state, and an edge the table lacks (from the persisted active
 * phase) leaves an `invalid_transition_detected` row but is written anyway
 * (spec D-T11); then the state is replaced and audited.
 */
async function writeStateTx(
  tx: WorkflowTx,
  prior: Json | undefined,
  next: Json,
  audit: StateWriteAudit,
): Promise<Json> {
  if (audit.forced !== true && next.active === true) {
    const toPhase = trimmed(next.current_phase);
    if (toPhase) {
      if (!isManifestState(toPhase))
        throw new Error(
          `Refusing to write unknown ralplan phase "${toPhase}" to ${tx.paths.statePath}: not a known ralplan manifest state`,
        );
      const fromPhase =
        audit.fromPhase?.trim() ||
        (prior?.active === true ? trimmed(prior.current_phase) : undefined);
      if (
        fromPhase &&
        fromPhase !== toPhase &&
        isManifestState(fromPhase) &&
        !isValidTransition(fromPhase, toPhase)
      ) {
        // Audit-only diagnostic, best-effort as in gjc.
        const at = now();
        await appendAudit(tx, {
          category: "state",
          verb: "invalid_transition_detected",
          owner: audit.owner,
          skill: SKILL,
          mutationId: audit.mutationId ?? `${SKILL}:invalid-transition:${at}`,
          fromPhase,
          toPhase,
          forced: false,
          path: tx.paths.statePath,
        }).catch(() => undefined);
      }
    }
  }
  await tx.writeState(
    next,
    audit.owner === HOOK_OWNER ? "ralplan_hook" : "ralplan_tool",
  );
  await appendAudit(tx, {
    category: "state",
    verb: audit.verb ?? "write",
    owner: audit.owner,
    skill: SKILL,
    mutationId: audit.mutationId,
    fromPhase: audit.fromPhase,
    toPhase: audit.toPhase,
    forced: audit.forced,
    path: tx.paths.statePath,
  });
  return next;
}

/** gjc `readExistingStateForMutation` + corrupt refusal. */
async function readStateForMutation(tx: WorkflowTx): Promise<Json | undefined> {
  try {
    const state = await tx.readState();
    return state === undefined ? undefined : payloadOf(state);
  } catch (error) {
    throw new Error(
      `existing ralplan state is corrupt or tampered (${message(error)}); refusing to overwrite ${tx.paths.statePath}. Reset it with \`ralplan clear\` and force: true.`,
      { cause: error },
    );
  }
}

/** gjc `migrateWorkflowState` (v1 → v2): version, skill and a manifest phase. */
function migrateRalplanState(state: Json): Json {
  const fromVersion = typeof state.version === "number" ? state.version : 1;
  if (fromVersion >= WORKFLOW_STATE_VERSION) return state;
  const source =
    typeof state.current_phase === "string" ? state.current_phase : state.phase;
  const raw = typeof source === "string" ? source.trim() : "";
  const legacy = raw === "planning" ? RALPLAN_INITIAL_STATE : raw;
  const phase = isManifestState(legacy) ? legacy : RALPLAN_INITIAL_STATE;
  const migrated: Json = {
    ...state,
    version: WORKFLOW_STATE_VERSION,
    skill: SKILL,
    current_phase: phase,
  };
  if (typeof migrated.phase === "string") migrated.phase = phase;
  return migrated;
}

// ---------------------------------------------------------------------------
// Active row and snapshot
// ---------------------------------------------------------------------------

/** gjc's HUD sync never changes the command's outcome. */
async function bestEffort(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch {
    // HUD sync is best-effort and must not change command semantics.
  }
}

/** gjc `buildWorkflowStateReceipt`, carried on the row after a `state` op. */
function stateWriteReceipt(
  tx: WorkflowTx,
  owner: AuditOwner,
  at: string,
  mutationId: string,
): Json {
  return {
    version: 1,
    skill: SKILL,
    owner,
    command: "ralplan state",
    state_path: tx.paths.snapshotPath,
    storage_path: tx.paths.statePath,
    mutated_at: at,
    fresh_until: new Date(Date.parse(at) + RECEIPT_FRESH_MS).toISOString(),
    status: "fresh",
    mutation_id: mutationId,
  };
}

// ---------------------------------------------------------------------------
// Ledger and artifacts
// ---------------------------------------------------------------------------

function indexPathOf(runDir: string): string {
  return path.join(runDir, RALPLAN_INDEX_FILE);
}

/** gjc `loadRalplanIndexForCap`: an unreadable index is present but untrusted. */
async function loadIndexTx(tx: WorkflowTx, runDir: string): Promise<RalplanIndexLoad> {
  let text: string | undefined;
  try {
    text = await tx.readText(indexPathOf(runDir));
  } catch {
    return loadRalplanIndexForCap(undefined, true);
  }
  return loadRalplanIndexForCap(text);
}

/** gjc `appendJsonlIdempotent`: append unless a row with the same key exists. */
async function appendJsonlIdempotentTx(
  tx: WorkflowTx,
  file: string,
  entry: unknown,
  key: (entry: unknown) => string | undefined,
  owner: AuditOwner,
): Promise<{ appended: boolean; duplicate?: unknown }> {
  const duplicate = findJsonlDuplicate(await tx.readText(file), entry, key);
  if (duplicate !== undefined) return { appended: false, duplicate };
  await tx.appendLine(file, JSON.stringify(entry));
  await appendAudit(tx, {
    category: "ledger",
    verb: "append",
    owner,
    skill: SKILL,
    path: file,
  });
  return { appended: true };
}

async function writeArtifactTx(
  tx: WorkflowTx,
  file: string,
  content: string,
  owner: AuditOwner,
): Promise<void> {
  await tx.writeText(file, content);
  await appendAudit(tx, {
    category: "artifact",
    verb: "write",
    owner,
    skill: SKILL,
    path: file,
  });
}

/** gjc `persistArtifact`: stage file, ledger row, then the final's approval copy. */
async function persistArtifactTx(
  tx: WorkflowTx,
  runDir: string,
  stage: RalplanStage,
  stageN: number,
  content: string,
  sha256: string,
  finalAdmission: RalplanAutoHandoffResolution | undefined,
  owner: AuditOwner,
): Promise<{ path: string; createdAt: string; pendingApprovalPath?: string }> {
  const filePath = path.join(runDir, ralplanStageFileName(stage, stageN));
  await writeArtifactTx(tx, filePath, content, owner);
  const createdAt = now();
  await appendJsonlIdempotentTx(
    tx,
    indexPathOf(runDir),
    ralplanStageIndexEntry({
      stage,
      stageN,
      path: filePath,
      createdAt,
      sha256,
      autoHandoff: finalAdmission,
    }),
    ralplanIndexKey,
    owner,
  );
  let pendingApprovalPath: string | undefined;
  if (stage === "final") {
    pendingApprovalPath = path.join(runDir, RALPLAN_PENDING_APPROVAL_FILE);
    await writeArtifactTx(tx, pendingApprovalPath, content, owner);
  }
  return { path: filePath, createdAt, pendingApprovalPath };
}

/** gjc `ensureFinalPendingApproval`: a deduplicated final keeps its byte-identical copy. */
async function ensureFinalPendingApprovalTx(
  tx: WorkflowTx,
  runDir: string,
  stageN: number,
  artifact: { path: string; sha256: string },
  owner: AuditOwner,
): Promise<string> {
  const pendingApprovalPath = path.join(runDir, RALPLAN_PENDING_APPROVAL_FILE);
  const stageContent = await tx.readText(artifact.path);
  if (stageContent === undefined)
    throw new Error(
      `refusing to deduplicate ralplan final stage ${stageN}: stage artifact missing at ${artifact.path}.`,
    );
  const stageSha256 = sha256Hex(stageContent);
  if (stageSha256 !== artifact.sha256)
    throw new Error(
      `refusing to deduplicate ralplan final stage ${stageN}: stage artifact sha256 mismatch at ${artifact.path} (ledger sha256=${artifact.sha256}, artifact sha256=${stageSha256}).`,
    );
  const pending = await tx.readText(pendingApprovalPath);
  if (pending === undefined) {
    await writeArtifactTx(tx, pendingApprovalPath, stageContent, owner);
    return pendingApprovalPath;
  }
  const pendingSha256 = sha256Hex(pending);
  if (pending !== stageContent || pendingSha256 !== stageSha256)
    throw new Error(
      `refusing to deduplicate ralplan final stage ${stageN}: pending approval content mismatch at ${pendingApprovalPath} (stage sha256=${stageSha256}, pending sha256=${pendingSha256}).`,
    );
  return pendingApprovalPath;
}

/** gjc `repairMissingStageArtifactLedger`: the row a crash left unwritten. */
async function repairLedgerTx(
  tx: WorkflowTx,
  runDir: string,
  stage: RalplanStage,
  stageN: number,
  onDisk: { path: string; sha256: string },
  finalAdmission: RalplanAutoHandoffResolution | undefined,
  owner: AuditOwner,
): Promise<ExistingStageArtifact> {
  const createdAt = now();
  const result = await appendJsonlIdempotentTx(
    tx,
    indexPathOf(runDir),
    ralplanStageIndexEntry({
      stage,
      stageN,
      path: onDisk.path,
      createdAt,
      sha256: onDisk.sha256,
      autoHandoff: finalAdmission,
    }),
    ralplanIndexKey,
    owner,
  );
  const duplicate = result.duplicate;
  if (
    isRecord(duplicate) &&
    typeof duplicate.path === "string" &&
    typeof duplicate.sha256 === "string"
  )
    return {
      path: duplicate.path,
      sha256: duplicate.sha256,
      createdAt:
        typeof duplicate.created_at === "string" ? duplicate.created_at : createdAt,
      ...(stage === "final"
        ? {
            autoHandoff:
              parseRalplanFinalAdmission(duplicate.auto_handoff) ??
              unavailableRalplanFinalAdmission(),
          }
        : {}),
    };
  return {
    path: onDisk.path,
    sha256: onDisk.sha256,
    createdAt,
    ...(stage === "final"
      ? { autoHandoff: finalAdmission ?? unavailableRalplanFinalAdmission() }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// State updates on write (gjc `persistActiveRunId` and the metadata writers)
// ---------------------------------------------------------------------------

/** The state's `run_id`, checked as a path component (gjc `readActiveRunId`). */
function activeRunId(tx: WorkflowTx, state: Json | undefined): string | undefined {
  const candidate = trimmed(state?.run_id);
  if (!candidate) return undefined;
  tx.paths.runDir(candidate);
  return candidate;
}

/**
 * gjc `persistActiveRunId` (DR-3): create or re-activate the state and move
 * the phase to the stage just written, except a locked phase; a new run_id
 * starts a fresh run and drops the previous verdict, stuck flag and final
 * admission. Unchanged when the same run already sits on that phase and is
 * active or locked (`:1014-1021`), so a write after Stop here or `clear`
 * leaves the state inactive on `final` / `complete`, as in gjc.
 */
async function persistActiveRunIdTx(
  tx: WorkflowTx,
  state: Json | undefined,
  runId: string,
  stage: RalplanStage,
  owner: AuditOwner,
): Promise<Json> {
  let existing: Json = payloadOf(state);
  const isNewRun = existing.run_id !== runId;
  const nextPhase = isNewRun ? stage : advanceCurrentPhase(existing.current_phase, stage);
  if (isNewRun) {
    delete existing.verdict;
    for (const key of Object.keys(existing))
      if (key.startsWith("last_review_verdict")) delete existing[key];
    delete existing.planning_stuck;
    delete existing.auto_handoff;
  }
  if (
    !isNewRun &&
    existing.version === WORKFLOW_STATE_VERSION &&
    existing.current_phase === nextPhase &&
    (existing.active === true ||
      (RALPLAN_PHASE_LOCK as readonly string[]).includes(nextPhase))
  )
    return existing;
  existing.run_id = runId;
  if (typeof existing.skill !== "string") existing.skill = SKILL;
  existing.active = true;
  existing.current_phase = nextPhase;
  existing = migrateRalplanState(existing);
  existing.updated_at = now();
  return writeStateTx(tx, state, existing, { owner });
}

/** gjc `applyPersistedRoleStateUpdate` / `applyLaneVerdictUpdate` (shared body). */
async function mergeRunStateTx(
  tx: WorkflowTx,
  state: Json | undefined,
  fields: Json,
  expectedRunId: string | undefined,
  owner: AuditOwner,
): Promise<Json | undefined> {
  let existing: Json = payloadOf(state);
  if (expectedRunId !== undefined && existing.run_id !== expectedRunId) return undefined;
  Object.assign(existing, fields);
  if (typeof existing.skill !== "string") existing.skill = SKILL;
  if (typeof existing.active !== "boolean") existing.active = true;
  if (typeof existing.current_phase !== "string")
    existing.current_phase = RALPLAN_INITIAL_STATE;
  existing = migrateRalplanState(existing);
  existing.updated_at = now();
  return writeStateTx(tx, state, existing, { owner });
}

/** gjc `recordRalplanPlanningStuck`: one stuck row per run, then the state flag. */
async function recordPlanningStuckTx(
  tx: WorkflowTx,
  state: Json | undefined,
  runDir: string,
  runId: string,
  reason: string,
  owner: AuditOwner,
): Promise<void> {
  await appendJsonlIdempotentTx(
    tx,
    indexPathOf(runDir),
    ralplanPlanningStuckIndexEntry(reason, now()),
    ralplanPlanningStuckIndexKey,
    owner,
  );
  if (state === undefined || state.run_id !== runId) return;
  let next: Json = {
    ...payloadOf(state),
    planning_stuck: { marker: PLANNING_STUCK_MARKER, reason },
  };
  next = migrateRalplanState(next);
  next.updated_at = now();
  await writeStateTx(tx, state, next, { owner });
}

/** gjc `persistRalplanFinalAdmission`: only onto the same run. */
async function persistFinalAdmissionTx(
  tx: WorkflowTx,
  state: Json,
  runId: string,
  admission: RalplanAutoHandoffResolution,
  owner: AuditOwner,
): Promise<Json> {
  if (state.run_id !== runId) return state;
  let next: Json = { ...payloadOf(state), auto_handoff: admission };
  next = migrateRalplanState(next);
  next.updated_at = now();
  return writeStateTx(tx, state, next, { owner });
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

export type StageWriteInput = {
  /** The owner (lineage root) session: receipts and the default run_id. */
  sessionId: string;
  stage: RalplanStage;
  stageN: number;
  /** The explicit `run_id` input, if any. */
  runId?: string;
  artifact: string;
  persistedRoleState?: PersistedRoleStateUpdate;
  laneVerdict?: LaneVerdictUpdate;
  settings: RalplanSettings;
  projectDir: string;
};

export type StageWriteResult =
  | { kind: "receipt"; payload: Record<string, unknown>; text: string }
  | { kind: "stuck"; payload: Record<string, unknown>; detail: string };

/**
 * gjc `handleArtifactWrite` in its order (DR-2), minus the repository-binding
 * enforcement (deviation 12). Ledger duplicates change nothing (DR-5, DR-20);
 * a PLANNING-STUCK outcome is a result, not an error.
 */
export async function writeStageTx(
  tx: WorkflowTx,
  input: StageWriteInput,
  owner: AuditOwner = RUNTIME_OWNER,
): Promise<StageWriteResult> {
  const { stage, stageN, sessionId, settings } = input;
  // Run id (`:1565-1570`): explicit → state `run_id` → owner session.
  const state = await readStateForMutation(tx);
  const runId = input.runId?.trim() || activeRunId(tx, state) || sessionId;
  const runDir = tx.paths.runDir(runId);
  // `enforceRalplanRepositoryBinding` without the enforcement: the state's
  // binding, else a live capture for the receipt.
  const repositoryBinding =
    state?.repository_binding ?? (await captureRepositoryBinding(input.projectDir));

  // One ledger snapshot for dedupe, both gates and disposition provenance (`:2075`).
  const indexLoad = await loadIndexTx(tx, runDir);
  const normalizedArtifact =
    stage === "disposition"
      ? normalizeDispositionArtifact(input.artifact, stageN, indexLoad.rawText)
      : input.artifact;
  const content = normalizeArtifactContent(normalizedArtifact);
  const sha256 = sha256Hex(content);
  const receiptBase = { sessionId, runId, stage, stageN, sha256, repositoryBinding };
  const finalReceipt = async (pendingApprovalPath: string) =>
    stage === "final"
      ? {
          pendingApprovalPath,
          planningStuck: readRalplanPlanningStuck(await loadIndexTx(tx, runDir)),
        }
      : undefined;

  // Ledger duplicate (`:2088-2101`): no state, row or file change.
  const existing = findExistingStageArtifact(indexLoad.rawText, stage, stageN);
  if (existing) {
    if (existing.sha256 !== sha256)
      throw new Error(
        stageOverwriteRefusal({
          stage,
          stageN,
          path: existing.path,
          existingSha256: existing.sha256,
          newSha256: sha256,
        }),
      );
    const pending =
      stage === "final"
        ? await ensureFinalPendingApprovalTx(tx, runDir, stageN, existing, owner)
        : "";
    return {
      kind: "receipt",
      ...buildDeduplicatedReceipt({
        ...receiptBase,
        existing,
        final: await finalReceipt(pending),
      }),
    };
  }

  // Crash-gap repair (`:2103-2135`): the stage file exists but its row does not.
  const stagePath = path.join(runDir, ralplanStageFileName(stage, stageN));
  const onDiskText = await tx.readText(stagePath);
  if (onDiskText !== undefined) {
    const onDisk = { path: stagePath, sha256: sha256Hex(onDiskText) };
    if (onDisk.sha256 !== sha256)
      throw new Error(
        stageOverwriteRefusal({
          stage,
          stageN,
          path: onDisk.path,
          existingSha256: onDisk.sha256,
          newSha256: sha256,
        }),
      );
    const pending =
      stage === "final"
        ? await ensureFinalPendingApprovalTx(tx, runDir, stageN, onDisk, owner)
        : "";
    const repaired = await repairLedgerTx(
      tx,
      runDir,
      stage,
      stageN,
      onDisk,
      stage === "final" ? unavailableRalplanFinalAdmission() : undefined,
      owner,
    );
    // Role metadata and the lane verdict ride the repair only onto the active run (DR-20).
    let current = state;
    let appliedRole: PersistedRoleStateUpdate | undefined;
    if (input.persistedRoleState) {
      const next = await mergeRunStateTx(
        tx,
        current,
        persistedRoleStatePayload(input.persistedRoleState),
        runId,
        owner,
      );
      if (next) {
        current = next;
        appliedRole = input.persistedRoleState;
      }
    }
    let appliedLane: LaneVerdictUpdate | undefined;
    if (input.laneVerdict) {
      const next = await mergeRunStateTx(
        tx,
        current,
        laneVerdictStatePayload(input.laneVerdict),
        runId,
        owner,
      );
      if (next) appliedLane = input.laneVerdict;
    }
    return {
      kind: "receipt",
      ...buildDeduplicatedReceipt({
        ...receiptBase,
        existing: repaired,
        laneVerdict: appliedLane,
        persistedRoleState: appliedRole,
        final: await finalReceipt(pending),
      }),
    };
  }

  // Opener cap, then the review-lane budget (DR-4), with on-disk floors.
  const names = await tx.list(runDir);
  const capDecision = evaluateRalplanIterationCap({
    rows: indexLoad.rows,
    stage,
    maxIterations: settings.maxIterations,
    iterationFloor: countRalplanOnDiskOpeners(names),
  });
  if (!capDecision.allowed) {
    await recordPlanningStuckTx(tx, state, runDir, runId, capDecision.reason, owner);
    return {
      kind: "stuck",
      ...buildPlanningStuckResult({
        stage,
        stageN,
        runId,
        decision: capDecision,
        source: settings.source.maxIterations,
      }),
    };
  }
  const laneDecision = evaluateRalplanReviewLaneBudget({
    rows: indexLoad.rows,
    stage,
    maxReviewPassesPerLane: settings.maxReviewPassesPerLane,
    onDiskLaneCounts: countRalplanOnDiskLaneArtifacts(names),
  });
  if (!laneDecision.allowed) {
    await recordPlanningStuckTx(tx, state, runDir, runId, laneDecision.reason, owner);
    return {
      kind: "stuck",
      ...buildLaneBudgetStuckResult({
        stage,
        stageN,
        runId,
        decision: laneDecision,
        source: settings.source.maxReviewPassesPerLane,
      }),
    };
  }

  // Final admission before any final write (`:2191-2203`).
  const autoHandoff =
    stage === "final"
      ? resolveRalplanAutoHandoffTarget(
          settings.autoHandoff,
          settings.source.autoHandoff,
          { planningStuck: readRalplanPlanningStuck(indexLoad) },
        )
      : undefined;
  // State → file → ledger → pending-approval → role → verdict → admission.
  let current = await persistActiveRunIdTx(tx, state, runId, stage, owner);
  const persisted = await persistArtifactTx(
    tx,
    runDir,
    stage,
    stageN,
    content,
    sha256,
    autoHandoff,
    owner,
  );
  if (input.persistedRoleState)
    current = (await mergeRunStateTx(
      tx,
      current,
      persistedRoleStatePayload(input.persistedRoleState),
      undefined,
      owner,
    ))!;
  if (input.laneVerdict)
    current = (await mergeRunStateTx(
      tx,
      current,
      laneVerdictStatePayload(input.laneVerdict),
      undefined,
      owner,
    ))!;
  if (autoHandoff)
    current = await persistFinalAdmissionTx(tx, current, runId, autoHandoff, owner);
  // Active row (`:2217-2226`): the stage just written (DR-8).
  await bestEffort(async () =>
    syncActiveRowTx(
      tx,
      {
        skill: SKILL,
        active: true,
        phase: stage,
        sessionId,
        hud: buildRalplanHud({
          stage,
          pendingApproval: stage === "final",
          iteration: stageN,
          reviewPassBudget: settings.maxReviewPassesPerLane,
          index: await loadIndexTx(tx, runDir),
          lastReviewVerdict:
            typeof current.last_review_verdict === "string"
              ? current.last_review_verdict
              : undefined,
          latestSummary: `persisted ${stage} stage ${stageN}`,
          updatedAt: now(),
        }),
      },
      owner,
    ),
  );
  return {
    kind: "receipt",
    ...buildWriteReceipt({
      ...receiptBase,
      path: persisted.path,
      createdAt: persisted.createdAt,
      pendingApprovalPath: persisted.pendingApprovalPath,
      persistedRoleState: input.persistedRoleState,
      reviewBudgetWarning: reviewBudgetWarning(laneDecision),
      laneVerdict: input.laneVerdict,
      autoHandoff,
    }),
  };
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

export type StartRunInput = {
  task: string;
  interactive?: boolean;
  deliberate?: boolean;
  run_id?: string;
  /** Internal callers only (R-O1): the skill this run was handed off from. */
  handoff_from?: string;
  handoff_at?: string;
};

export type StartRunSummary = {
  session_id: string;
  skill: "ralplan";
  mode: "short" | "deliberate";
  state_path: string;
  run_id: string;
  handoff: string;
  repository_binding: unknown;
};

/**
 * gjc `seedRalplanState` + `handleConsensusHandoff`: a whole new state on
 * `planner`, the run id per DR-19, the binding of the same run or a fresh
 * capture, and the active row. `ralplan start` checks, in the same
 * transaction, a running ultragoal, an already active run and the task before
 * this (`./tool.ts`, deep-interview revision plan DR-37, DR-39); the
 * deep-interview combined call `spec(…, handoff: "ralplan")` seeds through it
 * without those checks, like `gjc ralplan --deliberate` (DR-29).
 */
export async function startRunTx(
  tx: WorkflowTx,
  sessionId: string,
  input: StartRunInput,
  projectDir: string,
  owner: AuditOwner,
): Promise<StartRunSummary> {
  const state = await readStateForMutation(tx);
  const existingRunId = activeRunId(tx, state);
  // DR-19 (deviation 31): explicit → state `run_id` → owner session.
  const runId = input.run_id?.trim() || existingRunId || sessionId;
  const runDir = tx.paths.runDir(runId);
  const repositoryBinding =
    runId === existingRunId && state?.repository_binding !== undefined
      ? state.repository_binding
      : await captureRepositoryBinding(projectDir);
  const mode = input.deliberate === true ? "deliberate" : "short";
  const interactive = input.interactive === true;
  const at = now();
  const handoff =
    input.handoff_from !== undefined
      ? { handoff_from: input.handoff_from, handoff_at: input.handoff_at ?? at }
      : {};
  await writeStateTx(
    tx,
    state,
    {
      active: true,
      current_phase: RALPLAN_INITIAL_STATE,
      skill: SKILL,
      version: WORKFLOW_STATE_VERSION,
      mode,
      interactive,
      task: input.task,
      run_id: runId,
      updated_at: at,
      repository_binding: repositoryBinding,
      session_id: sessionId,
      ...handoff,
    },
    { owner },
  );
  await bestEffort(async () =>
    syncActiveRowTx(
      tx,
      {
        skill: SKILL,
        active: true,
        phase: RALPLAN_INITIAL_STATE,
        sessionId,
        hud: buildRalplanHud({
          stage: RALPLAN_INITIAL_STATE,
          pendingApproval: false,
          iteration: 1,
          index: await loadIndexTx(tx, runDir),
          latestSummary: `${mode} run · ${interactive ? "interactive" : "automated"}`,
          updatedAt: at,
        }),
        ...handoff,
      },
      owner,
    ),
  );
  return {
    session_id: sessionId,
    skill: SKILL,
    mode,
    state_path: tx.paths.statePath,
    run_id: runId,
    // gjc `/skill:ralplan`, as the host's skill id.
    handoff: SKILL,
    repository_binding: repositoryBinding,
  };
}

// ---------------------------------------------------------------------------
// state, clear, status, doctor
// ---------------------------------------------------------------------------

/**
 * gjc `gjc state ralplan write`: a merge patch (`null` deletes), a phase
 * change checked against the table (AC12), the row refreshed from the
 * resulting state. `{active: false}` is Stop here. `mutationTag` marks the
 * audit row's `mutation_id` (the continuation breaker's `breaker-exhausted`,
 * plan R-O3).
 */
export async function patchStateTx(
  tx: WorkflowTx,
  sessionId: string,
  patch: Record<string, unknown>,
  owner: AuditOwner = RUNTIME_OWNER,
  mutationTag?: string,
): Promise<Json> {
  let existing: Json;
  try {
    existing = payloadOf(await tx.readState());
  } catch (error) {
    throw new Error(
      `existing state for ralplan is corrupt or tampered (${message(error)}); reset it with \`ralplan clear\` and force: true`,
      { cause: error },
    );
  }
  const at = now();
  const mutationId = mutationTag ? `${SKILL}:${mutationTag}:${at}` : `${SKILL}:${at}`;
  const { _meta, ...payload } = patch;
  const incomingPhase = trimmed(payload.current_phase) ?? trimmed(payload.phase);
  const merged: Json = { ...existing };
  for (const [key, value] of Object.entries(payload)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  const preError = workflowEnvelopeError(SKILL, merged);
  if (preError) throw new Error(preError);
  merged.skill = SKILL;
  if (incomingPhase) merged.current_phase = incomingPhase;
  else if (!trimmed(merged.current_phase))
    merged.current_phase = trimmed(existing.current_phase) ?? RALPLAN_INITIAL_STATE;
  else merged.current_phase = (merged.current_phase as string).trim();
  merged.version = WORKFLOW_STATE_VERSION;
  if (typeof merged.active !== "boolean") merged.active = true;
  merged.updated_at = at;
  if (typeof merged.session_id !== "string") merged.session_id = sessionId;
  const fromPhase = trimmed(existing.current_phase);
  const toPhase = merged.current_phase as string;
  if (!isManifestState(toPhase))
    throw new Error(`unknown ralplan phase "${toPhase}"`);
  if (
    fromPhase &&
    isManifestState(fromPhase) &&
    !isValidTransition(fromPhase, toPhase)
  )
    throw new Error(`invalid ralplan phase transition from ${fromPhase} to ${toPhase}`);
  const postError = workflowEnvelopeError(SKILL, merged);
  if (postError) throw new Error(postError);
  await writeStateTx(tx, existing, merged, {
    owner,
    verb: "write",
    mutationId,
    fromPhase,
    toPhase,
  });
  const active = merged.active !== false;
  await bestEffort(() =>
    syncActiveRowTx(
      tx,
      {
        skill: SKILL,
        active,
        phase: toPhase,
        sessionId,
        hud: buildRalplanHudFromState(merged, at),
        receipt: stateWriteReceipt(tx, owner, at, mutationId),
      },
      owner,
    ),
  );
  return {
    ok: true,
    skill: SKILL,
    state_path: tx.paths.statePath,
    current_phase: toPhase,
    active,
    mutation_id: mutationId,
  };
}

/**
 * gjc `describeStaleClearState` (`state-runtime.ts:255-270`): a mode-state
 * phase in R other than `inactive`, or a visible active ralplan phase that
 * differs from it. The visible phase is gjc `readActivePhaseForSkill`
 * (`:244-253`) over `readVisibleSkillActiveState` (R-OD14, gjc exactly):
 * `mergeVisibleEntries` (`active-state.ts:666-683`) takes the row file over
 * the snapshot entry and keeps it only while active, and
 * `readModeStatePhase` + `withCanonicalRalplanPhase` (`:507-546`) replace its
 * phase with a mode-state phase in the phase lock. So a row left on the stage
 * written after `final` is not stale here; the doctor, which reads the raw
 * files as gjc's does, still reports it.
 */
async function describeStaleClearTx(
  tx: WorkflowTx,
  existing: Json,
): Promise<string | undefined> {
  const phase = trimmed(existing.current_phase);
  if (phase && GUARD_RELEASE_PHASES.has(phase) && phase !== "inactive")
    return `mode-state is already terminal (${phase})`;
  const { value: row, error: rowError } = await readRawJsonTx(
    tx,
    tx.paths.activeRowPath,
  );
  // gjc `readActiveEntries` throws on an unreadable row file, so gjc's clear
  // stops here even with `--force`. Deviation 35 (R-OD16): only an unforced
  // clear stops; `clearStateTx` skips this read when `force` is set.
  if (rowError !== undefined)
    throw new Error(
      `active row ${tx.paths.activeRowPath} is unreadable (${rowError}); use force: true to clear`,
    );
  let entry: unknown = isRecord(row) && row.skill === SKILL ? row : undefined;
  if (entry === undefined) {
    const { value: snapshot } = await readRawJsonTx(tx, tx.paths.snapshotPath);
    entry =
      isRecord(snapshot) && Array.isArray(snapshot.active_skills)
        ? (snapshot.active_skills as unknown[]).find(
            (item) => isRecord(item) && item.skill === SKILL,
          )
        : undefined;
  }
  if (!activeFlag(entry)) return undefined;
  const canonical = modeStatePhase(existing);
  const activePhase =
    canonical && (RALPLAN_PHASE_LOCK as readonly string[]).includes(canonical)
      ? canonical
      : rowPhase(entry);
  if (activePhase && phase && activePhase !== phase)
    return `active-state phase ${activePhase} differs from mode-state phase ${phase}`;
  return undefined;
}

/**
 * gjc `gjc state ralplan clear` (`handleClear`, `state-runtime.ts:1402-1490`;
 * R-OD11, gjc as-is, replacing the DR-6 reading that only a corrupt state
 * needs `force`): without `force`, a corrupt state and then a stale one
 * (R-OD14, read as gjc's visible path does) are refused. Then `{active:
 * false, current_phase: "complete"}` over the kept fields (run_id stays),
 * files kept, and the row removed as in gjc.
 */
export async function clearStateTx(
  tx: WorkflowTx,
  sessionId: string,
  force: boolean,
  owner: AuditOwner = RUNTIME_OWNER,
): Promise<Json> {
  let existing: Json = {};
  try {
    existing = payloadOf(await tx.readState());
  } catch (error) {
    if (!force)
      throw new Error(
        `existing state for ralplan is corrupt or tampered (${message(error)}); use force: true to overwrite`,
        { cause: error },
      );
  }
  const staleReason = force ? undefined : await describeStaleClearTx(tx, existing);
  if (staleReason)
    throw new Error(
      `existing state for ralplan is stale (${staleReason}); use force: true to clear`,
    );
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
  await writeStateTx(tx, existing, cleared, {
    owner,
    verb: "clear",
    mutationId,
    fromPhase: trimmed(existing.current_phase),
    toPhase: "complete",
    forced: force,
  });
  await bestEffort(() => syncActiveRowTx(tx, { skill: SKILL, active: false, sessionId }, owner));
  return {
    ok: true,
    skill: SKILL,
    state_path: tx.paths.statePath,
    active: false,
    current_phase: "complete",
    mutation_id: mutationId,
  };
}

/** gjc `STATE_FIELD_ALLOWLIST` (`state-renderer.ts:82-102`). */
export const STATE_FIELD_ALLOWLIST = [
  "skill",
  "phase",
  "current_phase",
  "next",
  "active",
  "status",
  "fresh",
  "fresh_until",
  "receipt",
  "artifact_path",
  "plan_path",
  "spec_path",
  "run_id",
  "stage",
  "stage_n",
  "session_id",
  "updated_at",
  "handoff_to",
  "handoff_from",
  "counts",
  "hud",
] as const;
export type StateProjectionField = (typeof STATE_FIELD_ALLOWLIST)[number];

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** gjc `projectStateFields` for ralplan. */
function projectStateFields(
  state: Json,
  fields: readonly StateProjectionField[],
): Json {
  const phase =
    scalar(state.current_phase) ?? scalar(state.phase) ?? RALPLAN_INITIAL_STATE;
  const receipt = isRecord(state.receipt) ? state.receipt : undefined;
  const freshUntil = receipt ? scalar(receipt.fresh_until) : undefined;
  const projected: Json = {};
  for (const field of fields) {
    switch (field) {
      case "skill":
        projected.skill = SKILL;
        break;
      case "phase":
      case "current_phase":
        projected[field] = phase;
        break;
      case "next":
        projected.next = RALPLAN_TRANSITIONS.filter((t) => t.from === phase).map(
          (t) => t.to,
        );
        break;
      case "fresh":
        projected.fresh = freshUntil ? Date.parse(freshUntil) > Date.now() : false;
        break;
      case "fresh_until":
        projected.fresh_until = freshUntil;
        break;
      case "receipt":
        projected.receipt = receipt;
        break;
      default:
        projected[field] = state[field];
    }
  }
  return projected;
}

/**
 * gjc `gjc state read ralplan` (OQ4): `{skill, state, storage_path}`, or the
 * projection of `fields`. An unreadable state reads as `{}` with a warning.
 */
export async function readStatusTx(
  tx: WorkflowTx,
  fields?: readonly StateProjectionField[],
): Promise<{ result: Json; warning?: string }> {
  let state: Json = {};
  let warning: string | undefined;
  try {
    state = (await tx.readState()) ?? {};
  } catch (error) {
    warning = `WARNING: failed to read ${tx.paths.statePath}; ignoring corrupt state: ${message(error)}`;
  }
  const envelope = { skill: SKILL, state, storage_path: tx.paths.statePath };
  return {
    result: fields ? projectStateFields(state, fields) : envelope,
    ...(warning ? { warning } : {}),
  };
}

/** gjc `collectDoctorSummary` for ralplan (D-T13), in `../skill-state/doctor.ts`. */
export function doctorTx(tx: WorkflowTx): Promise<DoctorSummary> {
  return collectDoctorSummaryTx(tx, SKILL);
}

// ---------------------------------------------------------------------------
// Cross-skill handoff (ultragoal revision plan C-5, PQ-6 A)
// ---------------------------------------------------------------------------

/** The `ralplan handoff` op's refusal of an inactive ralplan (R-OD18). */
export class RalplanNotActiveError extends Error {}

/** The run's `pending-approval.md`, when it exists. */
async function pendingApprovalPathTx(tx: WorkflowTx, state: Json): Promise<string | undefined> {
  const runId = activeRunId(tx, state);
  const runDir = runId ? tx.paths.runDir(runId) : undefined;
  return runDir && (await tx.list(runDir)).includes(RALPLAN_PENDING_APPROVAL_FILE)
    ? path.join(runDir, RALPLAN_PENDING_APPROVAL_FILE)
    : undefined;
}

export type RalplanHandoffResult = {
  receipt: HandoffReceipt;
  /** The run's `pending-approval.md`, when it exists (the approved plan). */
  pendingApprovalPath?: string;
};

/** The skills a ralplan handoff may target (deep-interview revision plan DR-11). */
export type RalplanHandoffTarget = "ultragoal" | "deep-interview";

/**
 * The ralplan → ultragoal (or → deep-interview, D-SH5) handoff in one
 * transaction, shared by the `ralplan handoff` op and the `skill ultragoal`
 * turn gate (PQ-6 A). The phase must be in T (DR-7, deviation 34); then an
 * inactive ralplan — after Stop here, `clear` or an earlier handoff — is
 * refused with a `RalplanNotActiveError` (R-OD18), as gjc's Stop here ends
 * the turn and a later turn's load finds no active skill to hand off
 * (`tools/skill.ts:170-171,203-221`). gjc's `state handoff` verb checks
 * neither. Then the common journaled handoff (`handoffWorkflowTx`): the
 * callee active on its initial phase over its kept fields, ralplan inactive
 * on `handoff` over its kept fields, an inactive ralplan `handoff_to` row and
 * the callee's active row.
 */
export async function ralplanHandoffTx(
  tx: WorkflowTx,
  sessionId: string,
  owner: AuditOwner,
  reason: string,
  to: RalplanHandoffTarget = "ultragoal",
): Promise<RalplanHandoffResult> {
  const state = await readStateForMutation(tx);
  if (state === undefined)
    throw new Error("there is no ralplan state in this session to hand off");
  const phase = trimmed(state.current_phase) ?? "";
  if (!TERMINAL_PHASES.has(phase))
    throw new Error(
      `ralplan can hand off to ${to} only from a finished phase (${[...TERMINAL_PHASES].join(", ")}); the current phase is ${phase || "(none)"}. Record the final plan first.`,
    );
  const pendingApprovalPath = await pendingApprovalPathTx(tx, state);
  if (state.active !== true) {
    if (to === "deep-interview") {
      // DR-11 (C2-4): name the skill that took over, and no ultragoal command.
      if (phase === "handoff")
        throw new RalplanNotActiveError(
          `ralplan was already handed off (inactive, phase handoff); continue in the \`${trimmed(state.handoff_to) ?? "ultragoal"}\` skill.`,
        );
      throw new RalplanNotActiveError(
        `ralplan is not active (phase ${phase}), so there is nothing to hand off: Stop here or \`clear\` ended the run. To interview again, load the \`deep-interview\` skill and call \`deep-interview start\`; to continue an existing interview, call \`deep-interview status\`.`,
      );
    }
    if (phase === "handoff")
      throw new RalplanNotActiveError(
        "ralplan was already handed off (inactive, phase handoff); continue in the `ultragoal` skill.",
      );
    throw new RalplanNotActiveError(
      `ralplan is not active (phase ${phase}), so there is nothing to hand off: Stop here or \`clear\` ended the run. To execute the plan, load the \`ultragoal\` skill, then call \`ultragoal create\` with the plan's goals${pendingApprovalPath ? ` (the approved plan: ${pendingApprovalPath})` : ""}.`,
    );
  }
  const receipt = await handoffWorkflowTx(tx, {
    caller: SKILL,
    callee: to,
    sessionId,
    owner,
    reason,
  });
  return { receipt, ...(pendingApprovalPath ? { pendingApprovalPath } : {}) };
}

/**
 * `ralplan handoff {to}`: `ralplanHandoffTx` in one transaction. The result
 * names the next step and, for ultragoal, the approved plan (D-HE1: the path
 * rides the text only), then gjc's handoff receipt.
 */
export async function ralplanHandoff(
  store: StateStore,
  sessionId: string,
  to: RalplanHandoffTarget = "ultragoal",
  owner: AuditOwner = RUNTIME_OWNER,
): Promise<string> {
  const { receipt, pendingApprovalPath } = await store.ralplanTransaction(sessionId, (tx) =>
    ralplanHandoffTx(tx, sessionId, owner, `ralplan handoff to ${to}`, to),
  );
  const plan = pendingApprovalPath ? ` (the approved plan: ${pendingApprovalPath})` : "";
  const line =
    to === "deep-interview"
      ? // Deep-interview revision plan D-SH5: the interview reopens over its rounds and spec fields.
        `Handed off to deep-interview: ralplan is inactive (phase handoff) and deep-interview is active in interviewing. Load the \`deep-interview\` skill now and continue the existing interview with \`deep-interview write\`; do not call \`deep-interview start\`, which would reseed it${plan}.`
      : `Handed off to ultragoal: ralplan is inactive (phase handoff) and ultragoal is active in goal-planning. Load the \`ultragoal\` skill now and call \`ultragoal create\` with the approved plan's goals${plan}.`;
  return `${line}\n${JSON.stringify(receipt, null, 2)}`;
}
