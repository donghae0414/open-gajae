// Deep-interview record operations: every `deep-interview` tool op as a
// function over the `tx` of one `StateStore.workflowTransaction` of the
// lineage root (deep-interview revision plan C-1, S2). Each op reads the
// state, builds every next state in memory, runs every check — the C-3
// allowed states, the input caps, the round-record check and the StateStore
// payload limits (DR-31) — and only then writes, with one audit row per file
// change (C-7). A refused op writes nothing; an I/O failure after the first
// write leaves what was written, as nothing rolls back (Principle 2). The
// combined `spec(…, handoff: "ralplan")` is the exception: its three steps
// run one after another and an earlier step's writes stay when a later step
// fails (DR-29, PQ-18 A). Functions never call a queued StateStore method
// (C-1.3), and nothing here imports the ralplan runtime: the combined call
// seeds ralplan through an injected callback (E-7, E-11).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/deep-interview-runtime.ts:151-163` (`resolveSpecContent`),
//   `:498-521` (threshold precedence and range), `:612-716`
//   (`persistDeepInterviewSpec`: file, index, state, row), `:718-778`
//   (`seedDeepInterviewState`), `:780-803` (`syncDeepInterviewHud`),
//   `:805-871` (`handleSpecWrite`: the combined call), `:891-903` (the seed
//   summary)
// - `gjc-runtime/deep-interview-stage.ts:428-474` (`computeMergedEnvelope`),
//   `:830-920` (`handleWrite`: incremental and `--reset`)
// - `gjc-runtime/state-runtime.ts:244-270` (`readActivePhaseForSkill`,
//   `describeStaleClearState`), `:1232-1400` (`handleWrite` for
//   deep-interview: the envelope merge, then the floor), `:1402-1490`
//   (`handleClear`), `:1496-1551` (the handoff's spec check)
// - `gjc-runtime/state-renderer.ts:82-104` (`STATE_FIELD_ALLOWLIST`,
//   `projectStateFields`)
// Deviations (README "Deviations from GJC (deep-interview)"): 1 (tool ops on
// the lineage root), 2 (no receipt, checksum, revision or draft), 4 (the
// floor), 5 (`handoff` needs phase `handoff` and a verified spec), 12 (`start`
// is refused while ralplan or ultragoal is the visible primary), 19 (the
// `state` op refuses runtime-owned fields), 20 (threshold source strings), 25
// (no hoisting; top-level transcript fields refused), 30 (`write`, `spec`,
// `handoff` and `state` need an active state; `state(patch={"active": true})`
// resumes a cancelled interview), 34 (StateStore limits), 36
// (the round-record check), 38 (`spec(…, handoff: "ralplan")` stands for
// `--deliberate`; no `--force`).

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { type AuditOwner, appendAudit, RUNTIME_OWNER } from "../skill-state/audit.js";
import {
  activeFlag,
  collectDoctorSummaryTx,
  readRawJsonTx,
  renderDoctorText,
  rowPhase,
  workflowEnvelopeError,
} from "../skill-state/doctor.js";
import { type HandoffReceipt, handoffWorkflowTx } from "../skill-state/handoff.js";
import { readVisiblePrimaryTx, syncActiveRowTx } from "../skill-state/rows.js";
import { assertStatePayload, type InterviewState, safeComponent, type StateWriter, type WorkflowTx } from "../state.js";
import { applyAmbiguityFloorToEnvelope, deriveRuntimeAmbiguity } from "./ambiguity.js";
import {
  assertEnvelopeInputLimits,
  assertInputWithinLimit,
  assertStructuredResponseWithinLimit,
  type DeepInterviewEnvelope,
  MAX_INITIAL_CONTEXT_LENGTH,
  MAX_STRUCTURED_RESPONSE_LENGTH,
  mergeDeepInterviewEnvelope,
  mergeEstablishedFacts,
  normalizeForRead,
  sanitizeWritePayload,
  topLevelTranscriptError,
} from "./envelope.js";
import { deriveDeepInterviewHud } from "./hud.js";
import {
  DEEP_INTERVIEW_INITIAL_STATE,
  DEEP_INTERVIEW_RELEASE_PHASES,
  DEEP_INTERVIEW_TRANSITIONS,
  deepInterviewPhasePatchError,
  defaultSpecSlug,
  inputRoundKeys,
  roundRecordErrors,
  roundRecordRefusal,
  SPEC_FIELDS,
  SPEC_INDEX_FILE,
  STATE_OP_REFUSED_STATE_FIELDS,
  specFileName,
  statePatchFieldError,
} from "./manifest.js";
import {
  corruptStateRefusal,
  handedOffToRalplan,
  handedOffToUltragoal,
  inactiveStateRefusal,
  noStateRefusal,
  resumeRefusal,
  startRefusal,
} from "./messages.js";

type Json = Record<string, unknown>;

const SKILL = "deep-interview";
/** gjc `WORKFLOW_STATE_VERSION`. */
const WORKFLOW_STATE_VERSION = 2;
/** gjc `DEFAULT_AMBIGUITY_THRESHOLD` (`deep-interview-runtime.ts:47`, spec D-SR6). */
export const DEFAULT_AMBIGUITY_THRESHOLD = 0.05;
/** Deviation 20 (U-2 C): the source string of a `start(threshold)` value. */
export const START_THRESHOLD_SOURCE = "start(threshold)";

/** The resolved setting and where it came from (plan DR-4, DR-28). */
export type DeepInterviewSettings = { ambiguityThreshold: number; source: string };

export const DEFAULT_DEEP_INTERVIEW_SETTINGS: DeepInterviewSettings = {
  ambiguityThreshold: DEFAULT_AMBIGUITY_THRESHOLD,
  source: "default",
};

/** The handoff targets of a deep-interview (spec D-SH4). */
export type DeepInterviewHandoffTarget = "ralplan" | "ultragoal";

/**
 * The ralplan seed the combined call runs (DR-29, E-11): `startRunTx` behind
 * a callback `src/tools.ts` injects, typed here without a ralplan import.
 */
export type SeedRalplanTx = (
  tx: WorkflowTx,
  root: string,
  input: { task: string; deliberate: boolean },
  owner: AuditOwner,
) => Promise<{ state_path: string; run_id: string }>;

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

/** Spec D-SR9: the fields only `write` and `spec` set. */
const OWNED_FIELDS: ReadonlySet<string> = new Set([...SPEC_FIELDS, ...STATE_OP_REFUSED_STATE_FIELDS]);

const WRITERS: Record<AuditOwner, StateWriter> = {
  "open-gajae-runtime": "deep_interview_tool",
  "open-gajae-hook": "deep_interview_hook",
};

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): string {
  return new Date().toISOString();
}

/** A state copy without the StateStore `_meta` (regenerated on every write). */
function payloadOf(state: InterviewState | undefined): Json | undefined {
  if (state === undefined) return undefined;
  const { _meta, ...rest } = state;
  return rest;
}

type StateRead = { kind: "absent" } | { kind: "corrupt"; error: string } | { kind: "valid"; value: Json };

/** gjc `readExistingStateForMutation`. */
export async function readDeepInterviewStateTx(tx: WorkflowTx): Promise<StateRead> {
  try {
    const value = payloadOf(await tx.readModeState(SKILL));
    return value === undefined ? { kind: "absent" } : { kind: "valid", value };
  } catch (error) {
    return { kind: "corrupt", error: message(error) };
  }
}

/**
 * C-3 (PQ-12 B′): the state of an op that needs an active interview. With
 * `resume`, an interview cancelled on `interviewing` is taken too (deviation
 * 30); a finished or handed-off one is not.
 */
async function activeStateTx(tx: WorkflowTx, op: string, resume = false): Promise<Json> {
  const read = await readDeepInterviewStateTx(tx);
  if (read.kind === "absent") throw new Error(noStateRefusal(op));
  if (read.kind === "corrupt") throw new Error(corruptStateRefusal(op, read.error));
  const phase = trimmed(read.value.current_phase);
  if (read.value.active !== true && !(resume && phase === DEEP_INTERVIEW_INITIAL_STATE))
    throw new Error(inactiveStateRefusal(op, phase));
  return read.value;
}

/** D-HL2: the other workflow that is the visible primary; an unreadable row file does not count. */
async function otherPrimaryTx(tx: WorkflowTx): Promise<{ skill: string; phase?: string } | undefined> {
  const primary = await readVisiblePrimaryTx(tx).catch(() => undefined);
  return primary?.skill === "ralplan" || primary?.skill === "ultragoal"
    ? { skill: String(primary.skill), phase: trimmed(primary.phase) }
    : undefined;
}

/**
 * gjc `syncDeepInterviewHud` (an active row unless the phase is `complete`)
 * and, for the `state` op, `syncWorkflowSkillState` (the state's `active`):
 * the row and the snapshot, best-effort.
 */
async function syncRowTx(
  tx: WorkflowTx,
  sessionId: string,
  envelope: Json,
  owner: AuditOwner,
  options: { active?: boolean; specStatus?: string } = {},
): Promise<void> {
  const phase = trimmed(envelope.current_phase) ?? DEEP_INTERVIEW_INITIAL_STATE;
  const specStatus = options.specStatus;
  try {
    await syncActiveRowTx(
      tx,
      {
        skill: SKILL,
        active: options.active ?? phase !== "complete",
        phase,
        sessionId,
        hud: deriveDeepInterviewHud(envelope, { phase, specStatus }),
      },
      owner,
    );
  } catch {
    // gjc's HUD sync is best-effort and must not change command semantics.
  }
}

async function auditStateTx(
  tx: WorkflowTx,
  verb: string,
  owner: AuditOwner,
  mutationId: string,
  fromPhase: string | undefined,
  toPhase: string | undefined,
  forced?: boolean,
): Promise<void> {
  await appendAudit(tx, {
    category: "state",
    verb,
    owner,
    skill: SKILL,
    mutationId,
    fromPhase,
    toPhase,
    forced,
    path: tx.paths.modeState(SKILL),
  });
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------
// start (DR-2, DR-3, DR-4, D-HL2)
// ---------------------------------------------------------------------------

export type StartInput = { idea?: string; threshold?: number };

/**
 * gjc `seedDeepInterviewState`: a whole new envelope on `interviewing` over
 * whatever was there, a corrupt state included (the old phase is read only
 * for the audit row); the threshold is the `start` argument, else the
 * setting (project, user, 0.05). Refused while ralplan or ultragoal is the
 * visible primary skill.
 */
export async function startTx(
  tx: WorkflowTx,
  root: string,
  input: StartInput,
  settings: DeepInterviewSettings,
): Promise<string> {
  const idea = (input.idea ?? "").trim();
  if (!idea) throw new Error('deep-interview start requires an idea, e.g. idea: "<idea>".');
  assertInputWithinLimit(idea, MAX_INITIAL_CONTEXT_LENGTH, "initial_idea");
  let threshold = settings.ambiguityThreshold;
  let thresholdSource = settings.source;
  if (input.threshold !== undefined) {
    if (!Number.isFinite(input.threshold) || input.threshold <= 0 || input.threshold > 1)
      throw new Error(`invalid threshold: ${input.threshold}. Expected 0 < threshold <= 1.`);
    threshold = input.threshold;
    thresholdSource = START_THRESHOLD_SOURCE;
  }
  // D-HL2: only the rows decide; an unreadable row file does not refuse.
  const other = await otherPrimaryTx(tx);
  if (other) throw new Error(startRefusal(other.skill, other.phase));

  const previous = await readDeepInterviewStateTx(tx);
  const at = now();
  const envelope: Json = {
    skill: SKILL,
    version: WORKFLOW_STATE_VERSION,
    active: true,
    current_phase: DEEP_INTERVIEW_INITIAL_STATE,
    threshold,
    threshold_source: thresholdSource,
    session_id: root,
    updated_at: at,
    state: {
      initial_idea: idea,
      rounds: [],
      established_facts: [],
      current_ambiguity: 1.0,
      threshold,
      threshold_source: thresholdSource,
    },
  };
  assertStatePayload(envelope);
  await tx.writeModeState(SKILL, envelope, WRITERS[RUNTIME_OWNER]);
  await auditStateTx(
    tx,
    "write",
    RUNTIME_OWNER,
    `${SKILL}:start:${at}`,
    previous.kind === "valid" ? trimmed(previous.value.current_phase) : undefined,
    DEEP_INTERVIEW_INITIAL_STATE,
  );
  await syncRowTx(tx, root, envelope, RUNTIME_OWNER);
  return json({
    ok: true,
    skill: SKILL,
    threshold,
    threshold_source: thresholdSource,
    idea,
    state_path: tx.paths.modeState(SKILL),
    // gjc `/skill:deep-interview`, as the host's skill id.
    handoff: SKILL,
  });
}

// ---------------------------------------------------------------------------
// write (DR-5, C-4, DR-34)
// ---------------------------------------------------------------------------

export type WriteInput = { input?: Json; reset?: boolean };

/**
 * gjc `deep-interview write`: the input merged into the state (or, with
 * `reset`, into an empty base), the round records it touched checked, the
 * facts re-merged, `current_ambiguity` derived and floored, every limit
 * checked, then one write. The phase stays (`reset` → `interviewing`).
 */
export async function writeTx(tx: WorkflowTx, root: string, input: WriteInput): Promise<string> {
  if (!isRecord(input.input)) throw new Error('deep-interview write requires input, e.g. input: {"state": {…}}.');
  const current = await activeStateTx(tx, "write");
  const reset = input.reset === true;
  const { payload, ignoredKeys } = sanitizeWritePayload(input.input);
  assertStructuredResponseWithinLimit(payload, "deep-interview write input");
  assertEnvelopeInputLimits(normalizeForRead(payload));
  const { keys, errors: keyErrors } = inputRoundKeys(payload);

  const base: Json = reset ? {} : current;
  const at = now();
  const merged: DeepInterviewEnvelope = mergeDeepInterviewEnvelope(base, payload);
  const roundErrors = roundRecordErrors(
    merged.state.rounds as unknown[],
    keys,
    merged.state.type === "brownfield",
  );
  if (keyErrors.length > 0 || roundErrors.length > 0)
    throw new Error(roundRecordRefusal([...keyErrors, ...roundErrors]));
  merged.skill = SKILL;
  merged.active = true;
  merged.updated_at = at;
  merged.version = WORKFLOW_STATE_VERSION;
  if (typeof merged.current_phase !== "string" || !merged.current_phase)
    merged.current_phase = DEEP_INTERVIEW_INITIAL_STATE;
  merged.session_id = root;
  // gjc: staged facts are deltas, re-merged against the base's facts.
  const priorState = isRecord(base.state) ? base.state : undefined;
  if (priorState && Array.isArray(priorState.established_facts))
    merged.state.established_facts = mergeEstablishedFacts(
      priorState.established_facts,
      merged.state.established_facts as unknown[],
    );
  const next = deriveRuntimeAmbiguity(merged, base);
  assertEnvelopeInputLimits(next);
  assertStatePayload(next);

  await tx.writeModeState(SKILL, next, WRITERS[RUNTIME_OWNER]);
  await auditStateTx(
    tx,
    reset ? "write-reset" : "write-incremental",
    RUNTIME_OWNER,
    `${SKILL}:write:${at}`,
    trimmed(current.current_phase),
    trimmed(next.current_phase),
  );
  await syncRowTx(tx, root, next, RUNTIME_OWNER);
  return json({
    ok: true,
    verb: "write",
    mode: reset ? "reset" : "incremental",
    session_id: root,
    state_path: tx.paths.modeState(SKILL),
    ...(typeof next.state.current_ambiguity === "number" ? { current_ambiguity: next.state.current_ambiguity } : {}),
    ambiguity_floor: next.state.ambiguity_floor,
    ...(ignoredKeys.length > 0 ? { ignored_runtime_owned_keys: ignoredKeys } : {}),
  });
}

// ---------------------------------------------------------------------------
// spec (DR-8) and the combined call (DR-29)
// ---------------------------------------------------------------------------

/**
 * gjc `resolveSpecContent` (PQ-6 A): `value` as a path from `projectDir`
 * (absolute as is) names a regular file to read; a missing path is the spec
 * body itself; any other read error refuses.
 */
export async function resolveSpecContent(value: string, projectDir: string): Promise<string> {
  const candidate = path.isAbsolute(value) ? value : path.resolve(projectDir, value);
  try {
    const stat = await fs.stat(candidate);
    if (stat.isFile()) return await fs.readFile(candidate, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR" && code !== "ENAMETOOLONG")
      throw new Error(`failed to read path ${candidate}: ${message(error)}`);
  }
  return value;
}

export type SpecInput = { content: string; slug?: string };

export type SpecSummary = {
  skill: typeof SKILL;
  stage: "final";
  slug: string;
  path: string;
  sha256: string;
  spec_path: string;
  sha: string;
  created_at: string;
  state_path: string;
};

/**
 * gjc `persistDeepInterviewSpec`: the next state is built and checked first,
 * then the spec file, the index line, the state on `handoff` with its
 * `spec_*` fields, and the row with the `spec` chip, in gjc order.
 */
export async function specTx(tx: WorkflowTx, root: string, input: SpecInput): Promise<SpecSummary> {
  const existing = await activeStateTx(tx, "spec");
  assertInputWithinLimit(input.content, MAX_STRUCTURED_RESPONSE_LENGTH, "spec content");
  const slug = trimmed(input.slug) ?? defaultSpecSlug();
  safeComponent(slug, "slug");
  const content = input.content.endsWith("\n") ? input.content : `${input.content}\n`;
  const specsDir = path.join(tx.paths.sessionDir, "specs");
  const specPath = path.join(specsDir, specFileName(slug));
  const sha256 = createHash("sha256").update(content).digest("hex");
  const createdAt = now();
  const next = normalizeForRead({
    ...existing,
    active: true,
    current_phase: "handoff",
    skill: SKILL,
    version: WORKFLOW_STATE_VERSION,
    spec_slug: slug,
    spec_path: specPath,
    spec_sha256: sha256,
    spec_stage: "final",
    spec_persisted_at: createdAt,
    updated_at: createdAt,
    session_id: root,
  });
  assertStatePayload(next);

  const mutationId = `${SKILL}:spec:${createdAt}`;
  await tx.writeText(specPath, content);
  await appendAudit(tx, {
    category: "artifact",
    verb: "write",
    owner: RUNTIME_OWNER,
    skill: SKILL,
    mutationId,
    path: specPath,
  });
  const indexPath = path.join(specsDir, SPEC_INDEX_FILE);
  await tx.appendLine(
    indexPath,
    JSON.stringify({ slug, stage: "final", path: specPath, created_at: createdAt, sha256 }),
  );
  await appendAudit(tx, {
    category: "ledger",
    verb: "append",
    owner: RUNTIME_OWNER,
    skill: SKILL,
    mutationId,
    path: indexPath,
  });
  await tx.writeModeState(SKILL, next, WRITERS[RUNTIME_OWNER]);
  await auditStateTx(tx, "write", RUNTIME_OWNER, mutationId, trimmed(existing.current_phase), "handoff");
  await syncRowTx(tx, root, next, RUNTIME_OWNER, { specStatus: "persisted" });
  return {
    skill: SKILL,
    stage: "final",
    slug,
    path: specPath,
    sha256,
    spec_path: specPath,
    sha: sha256,
    created_at: createdAt,
    state_path: tx.paths.modeState(SKILL),
  };
}

/** `spec` without a handoff: the gjc `--json` summary. */
export async function writeSpecTx(tx: WorkflowTx, root: string, input: SpecInput): Promise<string> {
  return json(await specTx(tx, root, input));
}

/**
 * gjc `handleSpecWrite` with `--deliberate` (PQ-18 A, PQ-23 A): ① the spec
 * (its own checks; nothing is written when they fail), ② the ralplan seed on
 * `deliberate` with the spec path as the task (the existing ralplan `run_id`,
 * else the session id; no ultragoal check), ③ the deep-interview → ralplan
 * handoff. A later step's failure leaves the earlier steps' writes (K11).
 */
export async function specHandoffTx(
  tx: WorkflowTx,
  root: string,
  input: SpecInput,
  seedRalplanTx: SeedRalplanTx,
): Promise<string> {
  const summary = await specTx(tx, root, input);
  const seeded = await seedRalplanTx(tx, root, { task: summary.spec_path, deliberate: true }, RUNTIME_OWNER);
  await deepInterviewHandoffTx(tx, root, RUNTIME_OWNER, "ralplan", "deep-interview spec handoff to ralplan");
  return `${handedOffToRalplan(summary.spec_path)}\n${json({
    ...summary,
    handoff: { to: "ralplan", mode: "deliberate", state_path: seeded.state_path, run_id: seeded.run_id },
  })}`;
}

// ---------------------------------------------------------------------------
// handoff (DR-9, DR-35) and the spec check the load gate shares (DR-21)
// ---------------------------------------------------------------------------

/**
 * The persisted spec behind a state: `spec_path` inside the root session's
 * `specs/`, readable, and matching `spec_sha256`. Returns the path or throws
 * the reason.
 */
export async function verifySpecTx(tx: WorkflowTx, state: Json): Promise<string> {
  const specPath = trimmed(state.spec_path);
  if (!specPath) throw new Error("deep-interview has no persisted spec; write it with `deep-interview spec` first");
  const specsDir = path.join(tx.paths.sessionDir, "specs");
  const inside = path.relative(specsDir, path.resolve(specPath));
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside))
    throw new Error(`deep-interview spec_path ${specPath} is not in this session's specs/`);
  let content: string | undefined;
  try {
    content = await tx.readText(specPath);
  } catch (error) {
    throw new Error(`deep-interview spec ${specPath} is unreadable (${message(error)})`);
  }
  if (content === undefined) throw new Error(`deep-interview spec ${specPath} is missing`);
  const sha256 = createHash("sha256").update(content).digest("hex");
  if (sha256 !== state.spec_sha256)
    throw new Error(
      `deep-interview spec ${specPath} does not match spec_sha256; persist it again with \`deep-interview spec\``,
    );
  return specPath;
}

/**
 * DR-9: an active interview on `handoff` with a verified spec hands off
 * through the shared journaled handoff (caller deep-interview). Shared by
 * the `handoff` op, the combined call and the load gate's active `handoff`.
 */
export async function deepInterviewHandoffTx(
  tx: WorkflowTx,
  root: string,
  owner: AuditOwner,
  to: DeepInterviewHandoffTarget,
  reason: string,
): Promise<{ receipt: HandoffReceipt; specPath: string }> {
  const state = await activeStateTx(tx, "handoff");
  const phase = trimmed(state.current_phase);
  if (phase !== "handoff")
    throw new Error(
      `deep-interview handoff needs phase handoff (persist the spec with \`deep-interview spec\` first); the current phase is ${phase ?? "(none)"}.`,
    );
  const specPath = await verifySpecTx(tx, state);
  const receipt = await handoffWorkflowTx(tx, { caller: SKILL, callee: to, sessionId: root, owner, reason });
  return { receipt, specPath };
}

/** The `handoff` op: the result line DR-9 names, then gjc's receipt. */
export async function handoffTx(tx: WorkflowTx, root: string, to: DeepInterviewHandoffTarget): Promise<string> {
  const { receipt, specPath } = await deepInterviewHandoffTx(
    tx,
    root,
    RUNTIME_OWNER,
    to,
    `deep-interview handoff to ${to}`,
  );
  const line = to === "ralplan" ? handedOffToRalplan(specPath) : handedOffToUltragoal(specPath);
  return `${line}\n${json(receipt)}`;
}

// ---------------------------------------------------------------------------
// status, doctor (DR-12, DR-13)
// ---------------------------------------------------------------------------

/** gjc `projectStateFields` for deep-interview (E-4). */
function projectStateFields(state: Json, fields: readonly StateProjectionField[]): Json {
  const phase = trimmed(state.current_phase) ?? trimmed(state.phase) ?? DEEP_INTERVIEW_INITIAL_STATE;
  const receipt = isRecord(state.receipt) ? state.receipt : undefined;
  const freshUntil = receipt ? trimmed(receipt.fresh_until) : undefined;
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
        projected.next = DEEP_INTERVIEW_TRANSITIONS.filter((t) => t.from === phase).map((t) => t.to);
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
 * gjc `gjc state read deep-interview`: `{skill, state, storage_path}`, or the
 * projection of `fields`. A missing state reads as `{}`; an unreadable one
 * too, with a warning line.
 */
export async function statusTx(tx: WorkflowTx, fields?: readonly StateProjectionField[]): Promise<string> {
  const read = await readDeepInterviewStateTx(tx);
  const state = read.kind === "valid" ? normalizeForRead(read.value) : {};
  const result = fields
    ? projectStateFields(state, fields)
    : { skill: SKILL, state, storage_path: tx.paths.modeState(SKILL) };
  return read.kind === "corrupt"
    ? `${json(result)}\nWARNING: failed to read ${tx.paths.modeState(SKILL)}; ignoring corrupt state: ${read.error}`
    : json(result);
}

/** gjc `collectDoctorSummary` for deep-interview as gjc's doctor text (PQ-24 A). */
export async function doctorTx(tx: WorkflowTx): Promise<string> {
  return renderDoctorText(await collectDoctorSummaryTx(tx, SKILL));
}

// ---------------------------------------------------------------------------
// state (DR-14), clear (DR-15)
// ---------------------------------------------------------------------------

/**
 * gjc `gjc state deep-interview write` (deviation 19): the envelope merge
 * (`null` deletes; `state` is never deleted and a non-object `state` is
 * ignored), the runtime-owned fields refused, the phase checked against the
 * table, the floor reapplied, then one write and the row. An active state is
 * required (deviation 30).
 */
export async function patchStateTx(tx: WorkflowTx, root: string, patch: Json): Promise<string> {
  const { _meta, ...payload } = patch;
  const refusals = [
    statePatchFieldError(payload),
    topLevelTranscriptError("state", payload, OWNED_FIELDS),
  ].filter((text): text is string => text !== undefined);
  if (refusals.length > 0) throw new Error(refusals.join("\n"));
  const existing = await activeStateTx(tx, "state", payload.active === true);
  if (existing.active !== true) {
    // Resuming a cancelled interview follows `start`'s D-HL2 rule (deviations 12, 30).
    const other = await otherPrimaryTx(tx);
    if (other) throw new Error(resumeRefusal(other.skill, other.phase));
  }
  assertStructuredResponseWithinLimit(payload, "deep-interview state patch");
  const at = now();
  const mutationId = `${SKILL}:${at}`;
  const merged: Json = mergeDeepInterviewEnvelope(existing, payload);
  const preError = workflowEnvelopeError(SKILL, merged);
  if (preError) throw new Error(preError);
  const fromPhase = trimmed(existing.current_phase);
  const incomingPhase =
    trimmed(payload.current_phase) ??
    trimmed(payload.phase) ??
    (isRecord(payload.state) ? trimmed(payload.state.current_phase) : undefined);
  const toPhase = incomingPhase ?? trimmed(merged.current_phase) ?? fromPhase ?? DEEP_INTERVIEW_INITIAL_STATE;
  const phaseError = deepInterviewPhasePatchError(fromPhase, toPhase);
  if (phaseError) throw new Error(phaseError);
  merged.skill = SKILL;
  merged.current_phase = toPhase;
  merged.version = WORKFLOW_STATE_VERSION;
  if (typeof merged.active !== "boolean") merged.active = true;
  merged.updated_at = at;
  merged.session_id = root;
  const next = applyAmbiguityFloorToEnvelope(merged).envelope;
  const postError = workflowEnvelopeError(SKILL, next);
  if (postError) throw new Error(postError);
  assertEnvelopeInputLimits(next);
  assertStatePayload(next);

  await tx.writeModeState(SKILL, next, WRITERS[RUNTIME_OWNER]);
  await auditStateTx(tx, "write", RUNTIME_OWNER, mutationId, fromPhase, toPhase);
  await syncRowTx(tx, root, next, RUNTIME_OWNER, { active: next.active !== false });
  return json({
    ok: true,
    skill: SKILL,
    state_path: tx.paths.modeState(SKILL),
    current_phase: toPhase,
    active: next.active,
    mutation_id: mutationId,
  });
}

/**
 * gjc `describeStaleClearState` for deep-interview: a releasing phase other
 * than `inactive`, or an active visible entry (the row, else the snapshot
 * entry) on another phase. An unreadable row stops an unforced clear.
 */
async function describeStaleClearTx(tx: WorkflowTx, existing: Json): Promise<string | undefined> {
  const phase = trimmed(existing.current_phase);
  if (phase && DEEP_INTERVIEW_RELEASE_PHASES.has(phase) && phase !== "inactive")
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
 * gjc `handleClear` (DR-15): without `force`, a corrupt and then a stale
 * state are refused; then `{active: false, current_phase: "complete"}` over
 * the kept fields — or alone when there is no state — the spec files kept,
 * the row removed. The goal is left alone (D-HL8).
 */
export async function clearStateTx(tx: WorkflowTx, root: string, force: boolean): Promise<string> {
  const read = await readDeepInterviewStateTx(tx);
  if (read.kind === "corrupt" && !force)
    throw new Error(
      `existing state for deep-interview is corrupt or tampered (${read.error}); use force: true to overwrite`,
    );
  const existing = read.kind === "valid" ? read.value : {};
  const staleReason = force ? undefined : await describeStaleClearTx(tx, existing);
  if (staleReason) throw new Error(`existing state for deep-interview is stale (${staleReason}); use force: true to clear`);
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
  await tx.writeModeState(SKILL, cleared, WRITERS[RUNTIME_OWNER]);
  await auditStateTx(tx, "clear", RUNTIME_OWNER, mutationId, trimmed(existing.current_phase), "complete", force);
  try {
    await syncActiveRowTx(tx, { skill: SKILL, active: false, sessionId: root }, RUNTIME_OWNER);
  } catch {
    // gjc's state-verb HUD sync is best-effort.
  }
  return json({
    ok: true,
    skill: SKILL,
    state_path: tx.paths.modeState(SKILL),
    active: false,
    current_phase: "complete",
    mutation_id: mutationId,
  });
}
