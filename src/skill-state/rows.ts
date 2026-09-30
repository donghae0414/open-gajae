// Active rows `state/active/<skill>.json` and the snapshot
// `state/skill-active-state.json` (ultragoal revision plan DR-13, C-3), shared
// by the workflow skills. Every `*Tx` function takes the `tx` of one
// `StateStore.workflowTransaction` and never calls a queued StateStore method
// (C-1). Moved from `src/ralplan-runtime/store.ts` and generalized (plan S1).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `skill-state/active-state.ts:630-664` (planning pipeline rank,
//   `upstreamPlanningPipelineSkills`, `collapsePlanningPipeline`), `:666-683`
//   (`mergeVisibleEntries`), `:507-546` (`readModeStatePhase`,
//   `withCanonicalRalplanPhase`), `:849-866` (`persistActiveEntry`), `:886-898`
//   (`removeSupersededPlanningPipelineEntries`), `:914-952`
//   (`syncSkillActiveState`), `:969-1015` (`applyHandoffToActiveState`)
// - `gjc-runtime/state-writer.ts:376-411` (`compareActiveEntryPrimary`,
//   `buildActiveSnapshot`), `:1322-1413` (active entry write and removal,
//   `readActiveEntries`, `rebuildActiveSnapshot`)
// Deviations:
// - ralplan 17: rows and the snapshot carry no `source_state_revision` /
//   `state_revision` and there is no stale-skip; no `thread_id`/`turn_id` and
//   no active subskills (`active_subskills` is always `[]`).
// - The handoff writes the caller and callee rows only. gjc rewrites every
//   row the snapshot lists as well (`active-state.ts:1005-1011`); here the
//   snapshot is always rebuilt from the row files inside the same queue, so
//   those rewrites would change nothing.
// - The visible read keys rows by skill alone: every row of a session folder
//   belongs to that session, so gjc's per-session ranking
//   (`active-state.ts:563-621`) has one candidate per skill.

import path from "node:path";
import { RALPLAN_PHASE_LOCK } from "../ralplan-runtime/manifest.js";
import type { WorkflowTx } from "../state.js";
import { type AuditOwner, appendAudit } from "./audit.js";
import { normalizeWorkflowHudSummary, type WorkflowHudSummary } from "./hud.js";

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * gjc `PLANNING_PIPELINE_RANK`: `deep-interview → ralplan → ultragoal`. A
 * downstream stage supersedes the upstream ones.
 */
const PIPELINE_RANK: ReadonlyMap<string, number> = new Map([
  ["deep-interview", 0],
  ["ralplan", 1],
  ["ultragoal", 2],
]);

/** gjc `upstreamPlanningPipelineSkills`. */
function upstreamSkills(skill: string): string[] {
  const rank = PIPELINE_RANK.get(skill);
  if (rank === undefined) return [];
  return [...PIPELINE_RANK.entries()]
    .filter(([, candidate]) => candidate < rank)
    .map(([candidate]) => candidate);
}

function parsedTime(value: unknown): number {
  return Date.parse(typeof value === "string" ? value : "");
}

/**
 * gjc `compareActiveEntryPrimary` (snapshot, `updated_at`) and
 * `comparePipelineEntry` (visible read, handoff/updated/activated time): a
 * pipeline skill ranks above any other, the higher pipeline rank first, then
 * the newer entry.
 */
function comparePrimary(
  a: Json,
  b: Json,
  time: (entry: Json) => number,
): number {
  const aRank = PIPELINE_RANK.get(String(a.skill));
  const bRank = PIPELINE_RANK.get(String(b.skill));
  if (aRank !== undefined || bRank !== undefined) return (bRank ?? -1) - (aRank ?? -1);
  const aTime = time(a);
  const bTime = time(b);
  if (Number.isFinite(aTime) || Number.isFinite(bTime)) return (bTime || 0) - (aTime || 0);
  return 0;
}

export type ActiveRowInput = {
  skill: string;
  active: boolean;
  phase?: string;
  /** The owner (lineage root) session. */
  sessionId: string;
  hud?: WorkflowHudSummary;
  receipt?: Json;
  handoff_from?: string;
  handoff_to?: string;
  handoff_at?: string;
};

/** gjc `syncSkillActiveState` / `buildSyncEntry`: the row as written. */
function rowEntry(input: ActiveRowInput, at: string): Json {
  const hud = normalizeWorkflowHudSummary(input.hud);
  return {
    skill: input.skill,
    phase: input.phase,
    active: input.active,
    activated_at: at,
    updated_at: at,
    session_id: input.sessionId,
    ...(input.handoff_from ? { handoff_from: input.handoff_from } : {}),
    ...(input.handoff_to ? { handoff_to: input.handoff_to } : {}),
    ...(input.handoff_at ? { handoff_at: input.handoff_at } : {}),
    ...(hud ? { hud } : {}),
    ...(input.receipt ? { receipt: input.receipt } : {}),
  };
}

async function writeRowTx(tx: WorkflowTx, entry: Json, owner: AuditOwner): Promise<void> {
  const rowPath = tx.paths.activeRow(String(entry.skill));
  await tx.writeText(rowPath, `${JSON.stringify(entry, null, 2)}\n`);
  await appendAudit(tx, {
    category: "state",
    verb: "write-active-entry",
    owner,
    path: rowPath,
  });
}

async function removeRowTx(
  tx: WorkflowTx,
  skill: string,
  verb: "remove-active-entry" | "remove-superseded-pipeline-entry",
  owner: AuditOwner,
): Promise<void> {
  const rowPath = tx.paths.activeRow(skill);
  if ((await tx.remove(rowPath)) === "deleted")
    await appendAudit(tx, { category: "state", verb, owner, path: rowPath });
}

/**
 * gjc `syncSkillActiveState`: an active entry first removes the upstream
 * pipeline rows (`removeSupersededPlanningPipelineEntries`), then is written;
 * an inactive one is removed (`persistActiveEntry`). Then the snapshot is
 * rebuilt. `activated_at` is the sync time, as in gjc.
 */
export async function syncActiveRowTx(
  tx: WorkflowTx,
  input: ActiveRowInput,
  owner: AuditOwner,
): Promise<void> {
  if (input.active) {
    for (const skill of upstreamSkills(input.skill))
      await removeRowTx(tx, skill, "remove-superseded-pipeline-entry", owner);
    await writeRowTx(tx, rowEntry(input, new Date().toISOString()), owner);
  } else {
    await removeRowTx(tx, input.skill, "remove-active-entry", owner);
  }
  await rebuildSnapshotTx(tx, owner);
}

/**
 * gjc `applyHandoffToActiveState`: the caller's row stays as an inactive
 * `handoff_to` row, keeping a `handoff_from` its prior row had, and the
 * callee, when it has a row, gets an active one; both at the handoff time.
 * No upstream row is removed. Then the snapshot is rebuilt.
 */
export async function writeHandoffRowsTx(
  tx: WorkflowTx,
  rows: { caller: ActiveRowInput; callee?: ActiveRowInput; at: string },
  owner: AuditOwner,
): Promise<void> {
  const caller = rowEntry(rows.caller, rows.at);
  if (!caller.handoff_from) {
    const prior = await readRowTx(tx, rows.caller.skill);
    const from = isRecord(prior) ? trimmed(prior.handoff_from) : undefined;
    if (from) caller.handoff_from = from;
  }
  await writeRowTx(tx, caller, owner);
  if (rows.callee) await writeRowTx(tx, rowEntry(rows.callee, rows.at), owner);
  await rebuildSnapshotTx(tx, owner);
}

/** One row file, parsed; `undefined` when it is missing. Corrupt JSON throws. */
async function readRowTx(tx: WorkflowTx, skill: string): Promise<unknown> {
  const text = await tx.readText(tx.paths.activeRow(skill));
  return text === undefined ? undefined : JSON.parse(text);
}

/** gjc `readActiveEntries`: every row file naming a skill, in name order. */
async function readRowsTx(tx: WorkflowTx): Promise<Json[]> {
  const dir = path.dirname(tx.paths.activeRowPath);
  const entries: Json[] = [];
  for (const name of await tx.list(dir)) {
    if (!name.endsWith(".json")) continue;
    const text = await tx.readText(path.join(dir, name));
    if (text === undefined) continue;
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || !trimmed(raw.skill)) continue;
    entries.push(raw);
  }
  return entries;
}

/**
 * gjc `readActiveEntries` + `buildActiveSnapshot` + `rebuildActiveSnapshot`:
 * the primary is the highest-ranked visible row (planning pipeline rank, then
 * the newest `updated_at`); `active_skills` lists every row.
 */
export async function rebuildSnapshotTx(tx: WorkflowTx, owner: AuditOwner): Promise<void> {
  const entries = await readRowsTx(tx);
  const visible = entries
    .filter((entry) => entry.active !== false)
    .toSorted((a, b) => comparePrimary(a, b, (entry) => parsedTime(entry.updated_at)));
  const primary = visible[0];
  const snapshot = {
    version: 1,
    active: visible.length > 0,
    skill: primary?.skill ?? "",
    phase: primary?.phase ?? "",
    updated_at: primary?.updated_at ?? "",
    session_id: primary?.session_id,
    active_skills: entries,
    active_subskills: [],
  };
  await tx.writeText(tx.paths.snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await appendAudit(tx, {
    category: "state",
    verb: "rebuild-active-snapshot",
    owner,
    path: tx.paths.snapshotPath,
  });
}

/** gjc `readModeStatePhase`: an inactive state's phase counts only when locked. */
function lockedPhase(state: unknown): string | undefined {
  if (!isRecord(state)) return undefined;
  const phase = trimmed(state.current_phase);
  if (!phase) return undefined;
  if (state.active === false && !(RALPLAN_PHASE_LOCK as readonly string[]).includes(phase))
    return undefined;
  return phase;
}

/**
 * gjc `readVisibleSkillActiveState`'s primary (C-3 "the visible primary
 * skill"): the snapshot's entries under the row files (which win), the
 * active ones, a ralplan row's phase replaced by a locked mode-state phase
 * (`withCanonicalRalplanPhase`), the planning pipeline collapsed to its
 * highest stage, then the first by rank. `undefined` when nothing is active.
 * An unreadable snapshot or ralplan state reads as absent; an unreadable row
 * file throws, as gjc's `readActiveEntries` does.
 */
export async function readVisiblePrimaryTx(tx: WorkflowTx): Promise<Json | undefined> {
  const merged = new Map<string, Json>();
  let snapshot: unknown;
  try {
    const text = await tx.readText(tx.paths.snapshotPath);
    snapshot = text === undefined ? undefined : JSON.parse(text);
  } catch {
    snapshot = undefined;
  }
  if (isRecord(snapshot) && Array.isArray(snapshot.active_skills))
    for (const entry of snapshot.active_skills as unknown[])
      if (isRecord(entry) && trimmed(entry.skill)) merged.set(String(entry.skill).trim(), entry);
  for (const entry of await readRowsTx(tx)) merged.set(String(entry.skill).trim(), entry);

  const ralplanPhase = lockedPhase(await tx.readModeState("ralplan").catch(() => undefined));
  const visible = [...merged.values()]
    .filter((entry) => entry.active !== false)
    .map((entry) => {
      if (
        entry.skill !== "ralplan" ||
        !ralplanPhase ||
        !(RALPLAN_PHASE_LOCK as readonly string[]).includes(ralplanPhase) ||
        entry.phase === ralplanPhase
      )
        return entry;
      const hud = isRecord(entry.hud) ? entry.hud : undefined;
      return {
        ...entry,
        phase: ralplanPhase,
        ...(hud
          ? {
              hud: {
                ...hud,
                chips: Array.isArray(hud.chips)
                  ? hud.chips.map((item: unknown) =>
                      isRecord(item) && item.label === "stage" ? { ...item, value: ralplanPhase } : item,
                    )
                  : hud.chips,
              },
            }
          : {}),
      };
    });
  const recency = (entry: Json) =>
    parsedTime(entry.handoff_at || entry.updated_at || entry.activated_at);
  const pipeline = visible.filter((entry) => PIPELINE_RANK.has(String(entry.skill)));
  const current =
    pipeline.length > 1 ? pipeline.toSorted((a, b) => comparePrimary(a, b, recency))[0] : undefined;
  return visible
    .filter((entry) => !current || !PIPELINE_RANK.has(String(entry.skill)) || entry === current)
    .toSorted((a, b) => comparePrimary(a, b, recency))[0];
}
