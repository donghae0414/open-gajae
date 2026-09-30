// The workflow doctor (ultragoal revision plan DR-15, ralplan D-T13): a
// read-only scan of the registered skills' mode-states, the active rows and
// the snapshot, returned as a summary object; `renderDoctorText` is gjc's text
// form of it (C-14). The ralplan tool keeps returning the object as JSON.
// Nothing is fixed. Every `*Tx` function takes the `tx` of one
// `StateStore.workflowTransaction` (C-1). Moved from
// `src/ralplan-runtime/store.ts` (plan S1).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/state-runtime.ts:317-604` (`DoctorProblem`, `DoctorSummary`,
//   `readRawJson`, `activeFlag`, `phaseFromActiveValue`, `modeStatePhase`,
//   `pushPhaseDriftProblem`, `collectDoctorSummary`), `:606-624`
//   (`renderDoctorText`)
// - `gjc-runtime/state-validation.ts` (`validateWorkflowStateEnvelope`)
// Deviations:
// - ralplan 13 (DR-15, I-19): no checksum or orphan-journal checks, so the
//   summary has no `journals_scanned` and the text no `journals_scanned` line.
// - ralplan 14: rows of skills that are not registered here are counted but
//   not checked (gjc checks a non-workflow row against `<skill>-state.json`).
// - ralplan 1: fix commands name tool ops (`<skill> clear (force: true)`)
//   instead of `gjc state <skill> migrate|clear`; there is no migrate op.
// - DR-21 (ralplan): an unknown phase in a readable envelope is a
//   `schema_violation`.
// - Envelope messages drop gjc's `, got <type>` suffix.

import path from "node:path";
import { isKnownPhase, RALPLAN_PHASE_LOCK } from "../ralplan-runtime/manifest.js";
import type { StateMode, WorkflowTx } from "../state.js";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * A skill the doctor scans: its name (the mode-state `<skill>-state.json` and
 * the row `active/<skill>.json`) and the phases its mode-state may hold.
 */
type DoctorSkill = {
  skill: StateMode;
  isKnownPhase(phase: string): boolean;
};

/** The registered skills, in scan order. */
const DOCTOR_SKILLS: readonly DoctorSkill[] = [{ skill: "ralplan", isKnownPhase }];

/** gjc `validateWorkflowStateEnvelope`; an error string or `undefined`. */
export function workflowEnvelopeError(skill: string, state: unknown): string | undefined {
  if (!isRecord(state)) return `state for ${skill} must be a JSON object`;
  if ("skill" in state && state.skill !== skill)
    return `state skill must match selected mode ${skill}`;
  if ("active" in state && typeof state.active !== "boolean")
    return "state.active must be a boolean when present";
  if ("current_phase" in state && typeof state.current_phase !== "string")
    return "state.current_phase must be a string when present";
  if ("version" in state && typeof state.version !== "number")
    return "state.version must be a number when present";
  if ("updated_at" in state && typeof state.updated_at !== "string")
    return "state.updated_at must be a string when present";
  if ("receipt" in state && state.receipt !== undefined && !isRecord(state.receipt))
    return "state.receipt must be an object when present";
  return undefined;
}

/** gjc `readRawJson`: a missing file, a parsed value, or the read/parse error. */
export async function readRawJsonTx(
  tx: WorkflowTx,
  file: string,
): Promise<{ exists: boolean; value?: unknown; error?: string }> {
  try {
    const text = await tx.readText(file);
    if (text === undefined) return { exists: false };
    return { exists: true, value: JSON.parse(text) };
  } catch (error) {
    return { exists: true, error: error instanceof Error ? error.message : String(error) };
  }
}

export function activeFlag(value: unknown): boolean {
  return isRecord(value) && value.active !== false;
}

/** gjc `phaseFromActiveValue`. */
export function rowPhase(value: unknown): string | undefined {
  return isRecord(value) ? trimmed(value.phase) : undefined;
}

/**
 * gjc `modeStatePhase`: an inactive state's phase counts only when it is in
 * the ralplan phase lock (gjc uses ralplan's `canonicalOverrides` for every
 * skill).
 */
export function modeStatePhase(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const phase = trimmed(value.current_phase);
  if (!phase) return undefined;
  if (
    value.active === false &&
    !(RALPLAN_PHASE_LOCK as readonly string[]).includes(phase)
  )
    return undefined;
  return phase;
}

type DoctorProblemType = "schema_violation" | "stale_active_state";

type DoctorProblem = {
  type: DoctorProblemType;
  skill: string;
  path: string;
  message: string;
  fixCommand: string;
};

export type DoctorSummary = {
  ok: boolean;
  root: string;
  summary: {
    skills_scanned: number;
    files_scanned: number;
    findings_total: number;
    by_kind: Record<DoctorProblemType, number>;
  };
  problems: DoctorProblem[];
};

/**
 * gjc `collectDoctorSummary` over the registered skills, or `skill` alone:
 * `schema_violation` for an unreadable or invalid envelope or an unknown
 * phase, and `stale_active_state` for a row or snapshot entry that is active
 * without a live active state, has no row behind it, or names another phase.
 */
export async function collectDoctorSummaryTx(
  tx: WorkflowTx,
  skill?: string,
): Promise<DoctorSummary> {
  const skills = DOCTOR_SKILLS.filter((entry) => skill === undefined || entry.skill === skill);
  const selected = new Set<string>(skills.map((entry) => entry.skill));
  const problems: DoctorProblem[] = [];
  const problem = (
    type: DoctorProblemType,
    owner: string,
    file: string,
    text: string,
  ): DoctorProblem => ({
    type,
    skill: owner,
    path: file,
    message: text,
    fixCommand:
      type === "schema_violation" ? `${owner} clear (force: true)` : `${owner} clear`,
  });
  let filesScanned = 0;
  const invalidStates = new Set<string>();
  const states = new Map<string, Awaited<ReturnType<typeof readRawJsonTx>>>();

  for (const { skill: current, isKnownPhase: known } of skills) {
    const statePath = tx.paths.modeState(current);
    const state = await readRawJsonTx(tx, statePath);
    states.set(current, state);
    if (!state.exists) continue;
    filesScanned += 1;
    if (state.error) {
      problems.push(
        problem("schema_violation", current, statePath, `mode-state JSON is unreadable: ${state.error}`),
      );
      invalidStates.add(current);
      continue;
    }
    const error = workflowEnvelopeError(current, state.value);
    const phase = isRecord(state.value) ? state.value.current_phase : undefined;
    if (error) problems.push(problem("schema_violation", current, statePath, error));
    else if (typeof phase === "string" && !known(phase))
      problems.push(
        problem("schema_violation", current, statePath, `unknown ${current} phase "${phase}"`),
      );
    else continue;
    invalidStates.add(current);
  }

  const drift = (owner: string, file: string, kind: string, entry: unknown) => {
    const entryPhase = rowPhase(entry);
    const statePhase = modeStatePhase(states.get(owner)?.value);
    if (!entryPhase || !statePhase || entryPhase === statePhase) return;
    problems.push(
      problem(
        "stale_active_state",
        owner,
        file,
        `${kind} for ${owner} phase ${entryPhase} differs from canonical mode-state phase ${statePhase}`,
      ),
    );
  };

  const activeDir = path.dirname(tx.paths.activeRowPath);
  const rowSkills = new Set<string>();
  for (const name of (await tx.list(activeDir)).filter((n) => n.endsWith(".json"))) {
    filesScanned += 1;
    const file = path.join(activeDir, name);
    const entry = await readRawJsonTx(tx, file);
    const owner =
      (isRecord(entry.value) && typeof entry.value.skill === "string"
        ? entry.value.skill
        : undefined) ?? path.basename(name, ".json");
    rowSkills.add(owner);
    if (!selected.has(owner)) continue;
    const state = states.get(owner);
    if (activeFlag(entry.value) && (!state?.exists || !activeFlag(state.value)))
      problems.push(
        problem(
          "stale_active_state",
          owner,
          file,
          `active entry for ${owner} does not match a live active mode-state`,
        ),
      );
    if (activeFlag(entry.value) && !invalidStates.has(owner))
      drift(owner, file, "active entry", entry.value);
  }

  const snapshotPath = tx.paths.snapshotPath;
  const snapshot = await readRawJsonTx(tx, snapshotPath);
  if (snapshot.exists) filesScanned += 1;
  if (isRecord(snapshot.value) && Array.isArray(snapshot.value.active_skills)) {
    for (const entry of snapshot.value.active_skills as unknown[]) {
      if (!isRecord(entry) || typeof entry.skill !== "string") continue;
      const owner = entry.skill;
      if (!selected.has(owner)) continue;
      if (activeFlag(entry) && !rowSkills.has(owner))
        problems.push(
          problem(
            "stale_active_state",
            owner,
            snapshotPath,
            `active snapshot lists ${owner} but no raw per-skill active entry exists`,
          ),
        );
      if (activeFlag(entry) && !invalidStates.has(owner))
        drift(owner, snapshotPath, "active snapshot", entry);
    }
  }

  problems.sort(
    (a, b) =>
      a.type.localeCompare(b.type) || a.skill.localeCompare(b.skill) || a.path.localeCompare(b.path),
  );
  const byKind: Record<DoctorProblemType, number> = {
    schema_violation: 0,
    stale_active_state: 0,
  };
  for (const found of problems) byKind[found.type] += 1;
  return {
    ok: problems.length === 0,
    root: path.dirname(tx.paths.snapshotPath),
    summary: {
      skills_scanned: skills.length,
      files_scanned: filesScanned,
      findings_total: problems.length,
      by_kind: byKind,
    },
    problems,
  };
}

/** gjc `renderDoctorText`, without the `journals_scanned` line (deviation 13). */
export function renderDoctorText(summary: DoctorSummary): string {
  const lines = [
    `ok: ${summary.ok}`,
    `root: ${summary.root}`,
    `skills_scanned: ${summary.summary.skills_scanned}`,
    `files_scanned: ${summary.summary.files_scanned}`,
    `findings_total: ${summary.summary.findings_total}`,
    `counts: ${Object.entries(summary.summary.by_kind)
      .map(([kind, count]) => `${kind}=${count}`)
      .join(", ")}`,
  ];
  for (const problem of summary.problems)
    lines.push(
      `finding: kind=${problem.type} skill=${problem.skill} path=${problem.path} message=${problem.message} fix=${problem.fixCommand}`,
    );
  return `${lines.join("\n")}\n`;
}
