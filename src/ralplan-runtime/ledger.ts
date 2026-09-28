// Ralplan run ledger (`index.jsonl`) rules: row shapes and parsing, stage file
// naming, body normalization and sha256, idempotence keys, the iteration cap
// and review-lane budget, PLANNING-STUCK results, final auto-handoff
// admission, role metadata, and write/duplicate receipts. Pure: callers read
// and write files and pass text, file names and parsed values in.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/ledger-event-renderer.ts:80-166` (`RalplanIndexRow`,
//   `parseRalplanIndexLine`, `summarizeRalplanIndex`,
//   `formatRalplanStagePresence`)
// - `gjc-runtime/ralplan-runtime.ts:93-126` (limits, marker, targets, identity
//   dedupe), `:128-291` (iteration cap, lane budget), `:299-386` (on-disk
//   opener/lane regexes, `loadRalplanIndexForCap`), `:494-503` (auto-handoff
//   resolution), `:527-612` (stuck results), `:617-626` (subagent id pattern,
//   fallback reasons), `:672-686` (`parseStageN`, `pad2`), `:1041-1253` (role
//   metadata, lane verdicts), `:1344-1348,1359-1365` (stuck row and its key),
//   `:1400-1435` (final admission, stuck read), `:1600-1606,1617-1638`
//   (row key, file name, stage row), `:1677-1747` (final admission parsing,
//   existing artifact lookup), `:1990-2031` (disposition normalization),
//   `:2082-2083` (body normalization, sha256), `:2090-2094` (overwrite
//   refusal), `:2227-2254` (write receipt), `:2263-2310` (duplicate receipt)
// - `gjc-runtime/state-writer.ts:1177-1213` (`readJsonlEntries`,
//   `findJsonlDuplicate`)
// Deviations (plan §7.1):
// - 1: CLI flags become tool inputs, so messages name `stage`, `stage_n`,
//   `lane_verdict`, `resumable`, `fallback_*` instead of `--stage` etc.
//   (e.g. "Use a new stage_n to record another pass."), and results are
//   `{payload, detail|text}` objects instead of stdout/stderr/exit status.
// - 5: the role session id is supplied by the tool (`context.sessionID`), and
//   one `resumable` input replaces the per-role `--<role>-resumable` flags.
// - 6: no `autoresearch` auto-handoff target.
// - 9: the `stages` display uses full stage words, not P/R/A/C codes.
// Directory listing and file reads stay in the caller: the on-disk counters
// take file names, the ledger readers take the raw `index.jsonl` text.

import { createHash } from "node:crypto";
import type { RalplanStage } from "./manifest.js";
import {
  type IndexedReviewArtifact,
  parseReviewConflictDocument,
  reviewArtifactIndexKey,
  serializeReviewConflictDocument,
} from "./review-conflicts.js";

/** Default consensus iterations (planner + revision openers) per run. */
export const RALPLAN_DEFAULT_MAX_ITERATIONS = 5;
/** Inclusive upper bound for `ralplan.maxIterations`. */
export const RALPLAN_MAX_ITERATIONS_LIMIT = 20;
/** Operator-visible stuck signal. */
export const PLANNING_STUCK_MARKER = "PLANNING-STUCK";
/** Default architect/critic review passes per consensus iteration. */
export const RALPLAN_DEFAULT_MAX_REVIEW_PASSES_PER_LANE = 1;
/** Inclusive upper bound for `ralplan.maxReviewPassesPerLane`. */
export const RALPLAN_MAX_REVIEW_PASSES_PER_LANE_LIMIT = 10;

export const RALPLAN_INDEX_FILE = "index.jsonl";
export const RALPLAN_PENDING_APPROVAL_FILE = "pending-approval.md";

/** Deviation 6: gjc also accepts `autoresearch`. */
export type RalplanAutoHandoffTarget = "off" | "ultragoal";

export interface RalplanAutoHandoffResolution {
  configuredTarget: RalplanAutoHandoffTarget;
  effectiveTarget: RalplanAutoHandoffTarget;
  degradationReason: string | null;
  source: string;
}

const RALPLAN_AUTO_HANDOFF_TARGETS = new Set<RalplanAutoHandoffTarget>([
  "off",
  "ultragoal",
]);

const RALPLAN_ITERATION_OPENER_STAGES = new Set<string>(["planner", "revision"]);

export type RalplanReviewLane = "architect" | "critic";

/** Self-reported review verdicts each lane may carry. */
export const LANE_VERDICTS: Record<RalplanReviewLane, ReadonlySet<string>> = {
  architect: new Set(["CLEAR", "WATCH", "BLOCK"]),
  critic: new Set(["OKAY", "ITERATE", "REJECT"]),
};

export const KNOWN_FALLBACK_REASONS: ReadonlySet<string> = new Set([
  "context_unavailable",
  "not_found",
  "no_runner",
  "resume_failed",
  "process_restart",
  "missing_record",
]);

const SUBAGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// ---------------------------------------------------------------------------
// Ledger rows
// ---------------------------------------------------------------------------

/** Minimal projection of a ralplan `index.jsonl` row. */
export interface RalplanIndexRow {
  stage: string;
  stageN?: number;
}

/** A stage row exactly as written to `index.jsonl`. */
export interface RalplanStageIndexEntry {
  stage: RalplanStage;
  stage_n: number;
  path: string;
  created_at: string;
  sha256: string;
  auto_handoff?: RalplanAutoHandoffResolution;
}

/** The once-per-run stuck row exactly as written to `index.jsonl`. */
export interface RalplanPlanningStuckIndexEntry {
  event: "planning_stuck";
  planning_stuck: true;
  marker: typeof PLANNING_STUCK_MARKER;
  reason: string;
  created_at: string;
}

export function ralplanStageIndexEntry(input: {
  stage: RalplanStage;
  stageN: number;
  path: string;
  createdAt: string;
  sha256: string;
  autoHandoff?: RalplanAutoHandoffResolution;
}): RalplanStageIndexEntry {
  return {
    stage: input.stage,
    stage_n: input.stageN,
    path: input.path,
    created_at: input.createdAt,
    sha256: input.sha256,
    ...(input.autoHandoff ? { auto_handoff: input.autoHandoff } : {}),
  };
}

export function ralplanPlanningStuckIndexEntry(
  reason: string,
  createdAt: string,
): RalplanPlanningStuckIndexEntry {
  return {
    event: "planning_stuck",
    planning_stuck: true,
    marker: PLANNING_STUCK_MARKER,
    reason,
    created_at: createdAt,
  };
}

/**
 * Content-addressed identity `(stage, stage_n, sha256)` of a stage row: an
 * identical repeated write must not append a second row. Rows missing these
 * fields opt out of dedup.
 */
export function ralplanIndexKey(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  const { stage, stage_n, sha256 } = record;
  if (
    typeof stage !== "string" ||
    typeof stage_n !== "number" ||
    typeof sha256 !== "string"
  )
    return undefined;
  return `${stage}\u0000${stage_n}\u0000${sha256}`;
}

/** Identity of the stuck row: at most one per run. */
export function ralplanPlanningStuckIndexKey(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  return record.planning_stuck === true ? "planning_stuck" : undefined;
}

/**
 * gjc `readJsonlEntries` + `findJsonlDuplicate`: the first parseable row of
 * `rawText` whose key equals the candidate's, or undefined (append). A corrupt
 * line cannot match, so it never suppresses an append.
 */
export function findJsonlDuplicate(
  rawText: string | undefined,
  candidate: unknown,
  key: (entry: unknown) => string | undefined,
): unknown {
  const candidateKey = key(candidate);
  if (candidateKey === undefined || rawText === undefined) return undefined;
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (key(entry) === candidateKey) return entry;
  }
  return undefined;
}

/** Parse a single ralplan index JSONL line; undefined for blank/malformed lines. */
export function parseRalplanIndexLine(line: string): RalplanIndexRow | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let row: unknown;
  try {
    row = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const record = row as Record<string, unknown>;
  if (typeof record.stage !== "string") return undefined;
  const out: RalplanIndexRow = { stage: record.stage };
  if (typeof record.stage_n === "number") out.stageN = record.stage_n;
  return out;
}

export interface RalplanIndexLoad {
  rows: RalplanIndexRow[];
  indexPresent: boolean;
  parseableLines: number;
  rawLineCount: number;
  rawText?: string;
}

/**
 * gjc `loadRalplanIndexForCap` without the read: `rawText` is the file text,
 * or undefined when the file is absent (`indexPresent` false, the default) or
 * present but unreadable (`indexPresent` true — treated as untrusted).
 */
export function loadRalplanIndexForCap(
  rawText: string | undefined,
  indexPresent: boolean = rawText !== undefined,
): RalplanIndexLoad {
  if (rawText === undefined)
    return { rows: [], indexPresent, parseableLines: 0, rawLineCount: 0 };
  const lines = rawText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows: RalplanIndexRow[] = [];
  for (const line of lines) {
    const row = parseRalplanIndexLine(line);
    if (row) rows.push(row);
  }
  return {
    rows,
    indexPresent: true,
    parseableLines: rows.length,
    rawLineCount: lines.length,
    rawText,
  };
}

export interface RalplanIndexSummary {
  /** Number of consensus iterations (planner/revision boundaries), >= 0. */
  iteration: number;
  /** Stage names present in the current (latest) iteration, in append order. */
  currentStages: string[];
}

/**
 * Iteration count and current-iteration stages. A `planner` or `revision` row
 * opens a new iteration; `stage_n` is not the iteration key.
 */
export function summarizeRalplanIndex(
  rows: readonly RalplanIndexRow[],
): RalplanIndexSummary {
  let iteration = 0;
  let currentStages: string[] = [];
  for (const row of rows) {
    if (RALPLAN_ITERATION_OPENER_STAGES.has(row.stage)) {
      iteration += 1;
      currentStages = [row.stage];
    } else {
      if (iteration === 0) iteration = 1;
      currentStages.push(row.stage);
    }
  }
  return { iteration, currentStages };
}

const DEFAULT_STAGE_PRESENCE_CAP = 6;
/** `hud.ts` `HUD_TEXT_LIMIT`: HUD normalization cuts a chip value past it. */
const STAGE_PRESENCE_TEXT_LIMIT = 80;

/**
 * The `stages` chip value. Deviation 9: full stage words joined by ` · `
 * (e.g. `revision · architect · critic`) where gjc prints codes (`R·A·C`).
 * Shows at most `cap` words, fewer when needed so the text with its
 * "… N more" suffix fits the HUD text limit uncut; undefined when empty.
 */
export function formatRalplanStagePresence(
  stages: readonly string[],
  cap = DEFAULT_STAGE_PRESENCE_CAP,
): string | undefined {
  if (stages.length === 0) return undefined;
  const text = (shown: number) => {
    const words = stages.slice(0, shown).join(" · ");
    const remaining = stages.length - shown;
    if (remaining === 0) return words;
    return `${words} … ${remaining} more ${remaining === 1 ? "stage" : "stages"}`;
  };
  let shown = Math.min(cap, stages.length);
  while (shown > 1 && text(shown).length > STAGE_PRESENCE_TEXT_LIMIT) shown -= 1;
  return text(shown);
}

/** Collapse duplicate rows for the same `(stage, stage_n)` before lane accounting. */
function deduplicateRalplanIndexRowsByStageIdentity(
  rows: readonly RalplanIndexRow[],
): RalplanIndexRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (typeof row.stageN !== "number") return true;
    const identity = `${row.stage}\u0000${row.stageN}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Stage files and bodies
// ---------------------------------------------------------------------------

export function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** `stage-<pad2(stage_n)>-<stage>.md` (disposition included). */
export function ralplanStageFileName(stage: RalplanStage, stageN: number): string {
  return `stage-${pad2(stageN)}-${stage}.md`;
}

/** gjc `parseStageN`: an integer 1..999. */
export function parseStageN(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 999
  ) {
    throw new Error(`invalid stage_n: ${String(value)}. Expected integer 1..999.`);
  }
  return value;
}

/** Append one `\n` unless the body already ends with one. */
export function normalizeArtifactContent(body: string): string {
  return body.endsWith("\n") ? body : `${body}\n`;
}

/** Plain lowercase hex sha256 (ledger form, no `sha256:` prefix). */
export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Parse complete path/sha256 rows from an `index.jsonl` snapshot for provenance. */
export function buildIndexedReviewArtifacts(
  indexText: string | undefined,
): Map<string, IndexedReviewArtifact> {
  const map = new Map<string, IndexedReviewArtifact>();
  if (indexText === undefined) return map;
  for (const line of indexText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (typeof record.stage !== "string") continue;
    if (typeof record.stage_n !== "number" || !Number.isInteger(record.stage_n))
      continue;
    if (typeof record.path !== "string" || typeof record.sha256 !== "string")
      continue;
    // Last complete row for an identity wins (matches findExistingStageArtifact).
    map.set(reviewArtifactIndexKey(record.stage, record.stage_n), {
      path: record.path,
      sha256: record.sha256,
    });
  }
  return map;
}

/**
 * Validate a disposition body against the run index (schema, plannerStageN,
 * receipts, open conflicts) and re-serialize it canonically (spec D-F6).
 */
export function normalizeDispositionArtifact(
  raw: string,
  expectedStageN: number,
  indexText: string | undefined,
): string {
  try {
    const indexedArtifacts = buildIndexedReviewArtifacts(indexText);
    const doc = parseReviewConflictDocument(raw, {
      expectedStageN,
      indexedArtifacts,
    });
    return serializeReviewConflictDocument(doc);
  } catch (error) {
    throw new Error(
      `invalid ralplan disposition artifact: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The persisted `(stage, stage_n)` artifact recorded in a run's `index.jsonl`. */
export interface ExistingStageArtifact {
  path: string;
  sha256: string;
  createdAt: string;
  autoHandoff?: RalplanAutoHandoffResolution;
}

/**
 * The most recent complete row for `(stage, stage_n)` in the ledger snapshot.
 * A parseable row missing `path` or `sha256` counts as missing so the on-disk
 * probe can repair the crash gap.
 */
export function findExistingStageArtifact(
  indexText: string | undefined,
  stage: RalplanStage,
  stageN: number,
): ExistingStageArtifact | undefined {
  if (indexText === undefined) return undefined;
  let match: ExistingStageArtifact | undefined;
  for (const line of indexText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (record.stage !== stage || record.stage_n !== stageN) continue;
    if (typeof record.path !== "string" || typeof record.sha256 !== "string")
      continue;
    match = {
      path: record.path,
      sha256: record.sha256,
      createdAt: typeof record.created_at === "string" ? record.created_at : "",
      ...(stage === "final"
        ? { autoHandoff: parseRalplanFinalAdmission(record.auto_handoff) }
        : {}),
    };
  }
  return match;
}

/** Refusal for a same-`(stage, stage_n)` write with different content. */
export function stageOverwriteRefusal(input: {
  stage: RalplanStage;
  stageN: number;
  path: string;
  existingSha256: string;
  newSha256: string;
}): string {
  return `refusing to overwrite ralplan ${input.stage} stage ${input.stageN} at ${input.path}: an artifact with different content already exists (existing sha256=${input.existingSha256}, new sha256=${input.newSha256}). Use a new stage_n to record another pass.`;
}

// ---------------------------------------------------------------------------
// Iteration cap and review-lane budget
// ---------------------------------------------------------------------------

/** Planner/revision stage files are named `stage-NN-(planner|revision).md`. */
const OPENER_ARTIFACT_RE = /^stage-\d{2,}-(planner|revision)\.md$/;
const LANE_ARTIFACT_RE = /^stage-\d{2,}-(architect|critic)\.md$/;

/**
 * On-disk opener count of a run directory listing: the iteration floor when
 * `index.jsonl` is missing, empty, truncated or under-counts (AC8). gjc counts
 * 0 when the directory cannot be listed.
 */
export function countRalplanOnDiskOpeners(fileNames: readonly string[]): number {
  let count = 0;
  for (const name of fileNames) {
    if (OPENER_ARTIFACT_RE.test(name)) count += 1;
  }
  return count;
}

/**
 * On-disk architect/critic counts of a run directory listing (DR-4 disk
 * excess). gjc counts 0 for a missing directory and fails on other errors.
 */
export function countRalplanOnDiskLaneArtifacts(fileNames: readonly string[]): {
  architect: number;
  critic: number;
} {
  const counts = { architect: 0, critic: 0 };
  for (const name of fileNames) {
    const match = LANE_ARTIFACT_RE.exec(name);
    if (match) counts[match[1] as RalplanReviewLane] += 1;
  }
  return counts;
}

export type RalplanIterationCapDecision =
  | {
      allowed: true;
      currentIterations: number;
      projectedIterations: number;
      maxIterations: number;
    }
  | {
      allowed: false;
      currentIterations: number;
      projectedIterations: number;
      maxIterations: number;
      reason: string;
    };

/**
 * Consensus-iteration cap. A planner or revision write opens an iteration;
 * other stages are always allowed, including final after the cap.
 * `iterationFloor` (on-disk openers) raises the count above the parsed index.
 */
export function evaluateRalplanIterationCap(input: {
  rows: readonly RalplanIndexRow[];
  stage: string;
  maxIterations?: number;
  iterationFloor?: number;
}): RalplanIterationCapDecision {
  const maxIterations =
    typeof input.maxIterations === "number" &&
    Number.isInteger(input.maxIterations) &&
    input.maxIterations >= 1 &&
    input.maxIterations <= RALPLAN_MAX_ITERATIONS_LIMIT
      ? input.maxIterations
      : RALPLAN_DEFAULT_MAX_ITERATIONS;
  const fromIndex = summarizeRalplanIndex(input.rows).iteration;
  const floor =
    typeof input.iterationFloor === "number" &&
    Number.isInteger(input.iterationFloor) &&
    input.iterationFloor > 0
      ? input.iterationFloor
      : 0;
  const currentIterations = Math.max(fromIndex, floor);
  if (!RALPLAN_ITERATION_OPENER_STAGES.has(input.stage)) {
    return {
      allowed: true,
      currentIterations,
      projectedIterations: currentIterations,
      maxIterations,
    };
  }
  const projectedIterations = currentIterations + 1;
  if (projectedIterations > maxIterations) {
    const ledgerNote =
      floor > fromIndex
        ? ` (ledger under-count: index=${fromIndex}, on-disk openers=${floor})`
        : "";
    return {
      allowed: false,
      currentIterations,
      projectedIterations,
      maxIterations,
      reason:
        `ralplan consensus iteration cap exceeded: opening ${input.stage} would start ` +
        `iteration ${projectedIterations} (max ${maxIterations})${ledgerNote}`,
    };
  }
  return {
    allowed: true,
    currentIterations,
    projectedIterations,
    maxIterations,
  };
}

export type RalplanReviewLaneBudgetDecision =
  | {
      allowed: true;
      lane?: RalplanReviewLane;
      currentPasses: number;
      projectedPasses: number;
      maxReviewPassesPerLane: number;
      finalSlot: boolean;
      ledgerNote?: string;
    }
  | {
      allowed: false;
      lane: RalplanReviewLane;
      currentPasses: number;
      projectedPasses: number;
      maxReviewPassesPerLane: number;
      finalSlot: false;
      ledgerNote?: string;
      reason: string;
    };

/**
 * Per-lane review-pass budget within the current consensus iteration. Only
 * architect and critic are limited; on-disk lane files beyond the parsed rows
 * count against the budget (DR-4).
 */
export function evaluateRalplanReviewLaneBudget(input: {
  rows: readonly RalplanIndexRow[];
  stage: string;
  maxReviewPassesPerLane?: unknown;
  onDiskLaneCounts?: { architect: number; critic: number };
}): RalplanReviewLaneBudgetDecision {
  const maxReviewPassesPerLane =
    typeof input.maxReviewPassesPerLane === "number" &&
    Number.isInteger(input.maxReviewPassesPerLane) &&
    input.maxReviewPassesPerLane >= 1 &&
    input.maxReviewPassesPerLane <= RALPLAN_MAX_REVIEW_PASSES_PER_LANE_LIMIT
      ? input.maxReviewPassesPerLane
      : RALPLAN_DEFAULT_MAX_REVIEW_PASSES_PER_LANE;
  if (input.stage !== "architect" && input.stage !== "critic") {
    return {
      allowed: true,
      currentPasses: 0,
      projectedPasses: 0,
      maxReviewPassesPerLane,
      finalSlot: false,
    };
  }

  const lane = input.stage as RalplanReviewLane;
  const rows = deduplicateRalplanIndexRowsByStageIdentity(input.rows);
  const summary = summarizeRalplanIndex(rows);
  const indexCurrent = summary.currentStages.filter((stage) => stage === lane).length;
  const parsedTotal = rows.filter((row) => row.stage === lane).length;
  const onDiskRaw = input.onDiskLaneCounts?.[lane];
  const onDiskTotal =
    typeof onDiskRaw === "number" && Number.isInteger(onDiskRaw) && onDiskRaw > 0
      ? onDiskRaw
      : 0;
  const diskExcess = Math.max(0, onDiskTotal - parsedTotal);
  const currentPasses = indexCurrent + diskExcess;
  const projectedPasses = currentPasses + 1;
  const ledgerNote =
    diskExcess > 0
      ? ` (ledger under-count: parsed ${lane} rows=${parsedTotal}, on-disk ${lane} artifacts=${onDiskTotal})`
      : undefined;
  const finalSlot = projectedPasses === maxReviewPassesPerLane;
  if (projectedPasses > maxReviewPassesPerLane) {
    return {
      allowed: false,
      lane,
      currentPasses,
      projectedPasses,
      maxReviewPassesPerLane,
      finalSlot: false,
      ledgerNote,
      reason:
        `ralplan review lane budget exceeded: ${lane} pass ${projectedPasses} of max ${maxReviewPassesPerLane} ` +
        `in consensus iteration ${Math.max(1, summary.iteration)}${ledgerNote ?? ""}`,
    };
  }
  return {
    allowed: true,
    lane,
    currentPasses,
    projectedPasses,
    maxReviewPassesPerLane,
    finalSlot,
    ledgerNote,
  };
}

export interface RalplanReviewBudgetWarning {
  lane: RalplanReviewLane;
  passes: number;
  max: number;
}

/** `review_budget_warning`: the lane's last slot was used and the limit is > 1. */
export function reviewBudgetWarning(
  decision: RalplanReviewLaneBudgetDecision,
): RalplanReviewBudgetWarning | undefined {
  return decision.lane &&
    decision.finalSlot &&
    decision.maxReviewPassesPerLane > 1
    ? {
        lane: decision.lane,
        passes: decision.projectedPasses,
        max: decision.maxReviewPassesPerLane,
      }
    : undefined;
}

/** A PLANNING-STUCK tool result: gjc's `--json` stdout object and its stderr line. */
export interface RalplanStuckResult {
  payload: Record<string, unknown>;
  detail: string;
}

export function buildPlanningStuckResult(input: {
  stage: RalplanStage;
  stageN: number;
  runId: string;
  decision: Extract<RalplanIterationCapDecision, { allowed: false }>;
  source: string;
}): RalplanStuckResult {
  const detail =
    `${PLANNING_STUCK_MARKER}: ${input.decision.reason} ` +
    `(run_id=${input.runId}, stage=${input.stage}, stage_n=${input.stageN}, source=${input.source}). ` +
    `Stop opening planner/revision passes; escalate the best existing plan via final/pending-approval without auto-implementation.`;
  return {
    payload: {
      ok: false,
      planning_stuck: true,
      marker: PLANNING_STUCK_MARKER,
      run_id: input.runId,
      stage: input.stage,
      stage_n: input.stageN,
      iteration: input.decision.currentIterations,
      projected_iteration: input.decision.projectedIterations,
      max_iterations: input.decision.maxIterations,
      max_iterations_source: input.source,
      reason: input.decision.reason,
    },
    detail,
  };
}

export function buildLaneBudgetStuckResult(input: {
  stage: RalplanStage;
  stageN: number;
  runId: string;
  decision: Extract<RalplanReviewLaneBudgetDecision, { allowed: false }>;
  source: string;
}): RalplanStuckResult {
  const detail =
    `${PLANNING_STUCK_MARKER}: ${input.decision.reason} ` +
    `(run_id=${input.runId}, stage=${input.stage}, stage_n=${input.stageN}, source=${input.source}). ` +
    `Stop re-invoking the ${input.decision.lane} review lane in this consensus iteration; ` +
    "route a rule-2-justified blocker through a Planner revision opener (fresh lane budget) while opener budget remains, " +
    "or escalate the best existing plan via post-interview/adr/final without auto-implementation.";
  return {
    payload: {
      ok: false,
      planning_stuck: true,
      marker: PLANNING_STUCK_MARKER,
      run_id: input.runId,
      stage: input.stage,
      stage_n: input.stageN,
      lane: input.decision.lane,
      passes: input.decision.currentPasses,
      projected_passes: input.decision.projectedPasses,
      max_review_passes_per_lane: input.decision.maxReviewPassesPerLane,
      max_review_passes_source: input.source,
      reason: input.decision.reason,
    },
    detail,
  };
}

// ---------------------------------------------------------------------------
// Final auto-handoff admission
// ---------------------------------------------------------------------------

/** Configured target → effective target; planning stuck forces `off`. */
export function resolveRalplanAutoHandoffTarget(
  configuredTarget: RalplanAutoHandoffTarget,
  source: string,
  options: { planningStuck?: boolean } = {},
): RalplanAutoHandoffResolution {
  if (options.planningStuck) {
    return {
      configuredTarget,
      effectiveTarget: "off",
      degradationReason: "planning_stuck",
      source,
    };
  }
  return {
    configuredTarget,
    effectiveTarget: configuredTarget,
    degradationReason: null,
    source,
  };
}

export function parseRalplanFinalAdmission(
  value: unknown,
): RalplanAutoHandoffResolution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const admission = value as Record<string, unknown>;
  if (
    !RALPLAN_AUTO_HANDOFF_TARGETS.has(
      admission.configuredTarget as RalplanAutoHandoffTarget,
    ) ||
    !RALPLAN_AUTO_HANDOFF_TARGETS.has(
      admission.effectiveTarget as RalplanAutoHandoffTarget,
    ) ||
    (typeof admission.degradationReason !== "string" &&
      admission.degradationReason !== null) ||
    typeof admission.source !== "string"
  ) {
    return undefined;
  }
  return {
    configuredTarget: admission.configuredTarget as RalplanAutoHandoffTarget,
    effectiveTarget: admission.effectiveTarget as RalplanAutoHandoffTarget,
    degradationReason:
      typeof admission.degradationReason === "string"
        ? admission.degradationReason
        : null,
    source: admission.source,
  };
}

/** Admission recorded for a final row whose own admission is missing. */
export function unavailableRalplanFinalAdmission(): RalplanAutoHandoffResolution {
  return {
    configuredTarget: "off",
    effectiveTarget: "off",
    degradationReason: "admission_unavailable",
    source: "ledger",
  };
}

export function applyRalplanPlanningStuckOverride(
  admission: RalplanAutoHandoffResolution,
  planningStuck: boolean,
): RalplanAutoHandoffResolution {
  return planningStuck
    ? { ...admission, effectiveTarget: "off", degradationReason: "planning_stuck" }
    : admission;
}

/**
 * gjc `readRalplanFinalAdmission` over already-read text: the admission of
 * the last complete final row, unparseable admissions as unavailable.
 */
export function readRalplanFinalAdmission(
  rawText: string | undefined,
): RalplanAutoHandoffResolution | undefined {
  if (rawText === undefined) return undefined;
  let finalAdmission: RalplanAutoHandoffResolution | undefined;
  for (const line of rawText.split(/\r?\n/)) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (
        row.stage === "final" &&
        typeof row.path === "string" &&
        typeof row.sha256 === "string"
      ) {
        finalAdmission =
          parseRalplanFinalAdmission(row.auto_handoff) ??
          unavailableRalplanFinalAdmission();
      }
    } catch {
      // The artifact dedupe guard handles malformed ledger records separately.
    }
  }
  return finalAdmission;
}

/**
 * gjc `readRalplanPlanningStuck` over an index load: a stuck row, an
 * unreadable index, or any malformed line counts as stuck (fail closed).
 */
export function readRalplanPlanningStuck(index: RalplanIndexLoad): boolean {
  if (index.rawText === undefined) return index.indexPresent;
  if (index.indexPresent && index.rawLineCount > 0 && index.parseableLines === 0)
    return true;
  for (const line of index.rawText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.planning_stuck === true) return true;
    } catch {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Role metadata and lane verdicts
// ---------------------------------------------------------------------------

export type PersistedRole = "planner" | RalplanReviewLane;

export interface PersistedRoleStateUpdate {
  role: PersistedRole;
  subagentId?: string;
  resumable?: boolean;
  fallbackReason?: string;
  fallbackAttemptedId?: string;
  fallbackStageN?: number;
  fallbackReceiptPath?: string;
}

export interface LaneVerdictUpdate {
  lane: RalplanReviewLane;
  verdict: string;
  stageN: number;
}

export function persistedRoleForStage(stage: RalplanStage): PersistedRole | undefined {
  if (stage === "planner" || stage === "revision") return "planner";
  if (stage === "architect" || stage === "critic") return stage;
  return undefined;
}

function roleIdKey(role: PersistedRole): string {
  return role === "planner" ? "planner_subagent_id" : `${role}_id`;
}

function assertSubagentId(value: string, label: string): void {
  if (!SUBAGENT_ID_RE.test(value)) {
    throw new Error(`invalid ${label}: ${value}`);
  }
}

/**
 * gjc `parsePersistedRoleStateArgs` over tool inputs. Planner metadata rides
 * planner/revision, architect/critic metadata their own lane: a `subagent`
 * of another role is refused like gjc's cross-role `--<role>-id` flag.
 * Fallback metadata needs reason, attempted id and stage_n together; the
 * receipt path is optional. Returns undefined when nothing was supplied.
 */
export function parsePersistedRoleState(
  stage: RalplanStage,
  input: {
    subagent?: { role: PersistedRole; id: string };
    resumable?: boolean;
    fallbackReason?: string;
    fallbackAttemptedId?: string;
    fallbackStageN?: number;
    fallbackReceiptPath?: string;
  },
): PersistedRoleStateUpdate | undefined {
  const role = persistedRoleForStage(stage);
  if (input.subagent && input.subagent.role !== role) {
    const expectedStages =
      input.subagent.role === "planner" ? "planner or revision" : input.subagent.role;
    throw new Error(
      `${roleIdKey(input.subagent.role)} is only valid with stage ${expectedStages} (received ${stage}).`,
    );
  }
  const anyFallback = [
    input.fallbackReason,
    input.fallbackAttemptedId,
    input.fallbackStageN,
    input.fallbackReceiptPath,
  ].some((value) => value !== undefined);
  if (!role) {
    if (input.resumable !== undefined) {
      throw new Error(
        `resumable is only valid with stage planner, revision, architect, or critic (received ${stage}).`,
      );
    }
    if (anyFallback) {
      throw new Error(
        `fallback_reason is only valid with stage planner, revision, architect, or critic (received ${stage}).`,
      );
    }
    return undefined;
  }
  if (input.subagent === undefined && input.resumable === undefined && !anyFallback)
    return undefined;

  const update: PersistedRoleStateUpdate = { role };
  if (input.subagent !== undefined) {
    assertSubagentId(input.subagent.id, roleIdKey(role));
    update.subagentId = input.subagent.id;
  }
  if (input.resumable !== undefined) update.resumable = input.resumable;

  if (anyFallback) {
    const reason = input.fallbackReason;
    if (!reason) {
      throw new Error(
        `fallback_reason is required when recording ${role} fallback metadata.`,
      );
    }
    if (!KNOWN_FALLBACK_REASONS.has(reason)) {
      throw new Error(
        `invalid fallback_reason: ${reason}. Expected one of: ${[...KNOWN_FALLBACK_REASONS].join(", ")}.`,
      );
    }
    update.fallbackReason = reason;
    if (input.fallbackAttemptedId === undefined) {
      throw new Error(
        `fallback_attempted_id is required when recording ${role} fallback metadata.`,
      );
    }
    assertSubagentId(input.fallbackAttemptedId, "fallback_attempted_id");
    update.fallbackAttemptedId = input.fallbackAttemptedId;
    if (input.fallbackStageN === undefined) {
      throw new Error(
        `fallback_stage_n is required when recording ${role} fallback metadata.`,
      );
    }
    update.fallbackStageN = parseStageN(input.fallbackStageN);
    if (input.fallbackReceiptPath !== undefined) {
      if (input.fallbackReceiptPath.trim() === "") {
        throw new Error("fallback_receipt_path must not be empty.");
      }
      update.fallbackReceiptPath = input.fallbackReceiptPath;
    }
  }
  return update;
}

/** Snake-case projection for state JSON and receipts; omitted fields stay absent. */
export function persistedRoleStatePayload(
  update: PersistedRoleStateUpdate,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const prefix = update.role;
  if (update.subagentId !== undefined) payload[roleIdKey(prefix)] = update.subagentId;
  if (update.resumable !== undefined) payload[`${prefix}_resumable`] = update.resumable;
  if (update.fallbackReason !== undefined)
    payload[`${prefix}_fallback_reason`] = update.fallbackReason;
  if (update.fallbackAttemptedId !== undefined)
    payload[`${prefix}_fallback_attempted_id`] = update.fallbackAttemptedId;
  if (update.fallbackStageN !== undefined)
    payload[`${prefix}_fallback_stage_n`] = update.fallbackStageN;
  if (update.fallbackReceiptPath !== undefined)
    payload[`${prefix}_fallback_receipt_path`] = update.fallbackReceiptPath;
  return payload;
}

/** gjc `parseLaneVerdictArgs`: architect CLEAR/WATCH/BLOCK, critic OKAY/ITERATE/REJECT. */
export function parseLaneVerdict(
  stage: RalplanStage,
  stageN: number,
  rawVerdict: string | undefined,
): LaneVerdictUpdate | undefined {
  if (rawVerdict === undefined) return undefined;
  if (stage !== "architect" && stage !== "critic") {
    throw new Error(
      `lane_verdict is only valid with stage architect or critic (received ${stage}).`,
    );
  }
  const verdict = rawVerdict.trim().toUpperCase();
  if (!LANE_VERDICTS[stage].has(verdict)) {
    throw new Error(
      `invalid lane_verdict for ${stage}: ${rawVerdict}. Expected one of: ${[...LANE_VERDICTS[stage]].join(", ")}.`,
    );
  }
  return { lane: stage, verdict, stageN };
}

/** State fields a lane verdict writes (`last_review_verdict*`). */
export function laneVerdictStatePayload(
  update: LaneVerdictUpdate,
): Record<string, unknown> {
  return {
    last_review_verdict: update.verdict,
    last_review_verdict_lane: update.lane,
    last_review_verdict_stage_n: update.stageN,
  };
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export interface RalplanWriteReceipt {
  payload: Record<string, unknown>;
  text: string;
}

/** Receipt of a newly persisted stage (gjc `handleArtifactWrite` tail). */
export function buildWriteReceipt(input: {
  sessionId: string;
  runId: string;
  path: string;
  stage: RalplanStage;
  stageN: number;
  sha256: string;
  repositoryBinding: unknown;
  createdAt: string;
  pendingApprovalPath?: string;
  persistedRoleState?: PersistedRoleStateUpdate;
  reviewBudgetWarning?: RalplanReviewBudgetWarning;
  laneVerdict?: LaneVerdictUpdate;
  autoHandoff?: RalplanAutoHandoffResolution;
}): RalplanWriteReceipt {
  const payload: Record<string, unknown> = {
    session_id: input.sessionId,
    run_id: input.runId,
    path: input.path,
    stage: input.stage,
    stage_n: input.stageN,
    sha256: input.sha256,
    repository_binding: input.repositoryBinding,
    created_at: input.createdAt,
  };
  if (input.pendingApprovalPath)
    payload.pending_approval_path = input.pendingApprovalPath;
  if (input.persistedRoleState)
    payload[`${input.persistedRoleState.role}_state`] = persistedRoleStatePayload(
      input.persistedRoleState,
    );
  if (input.reviewBudgetWarning)
    payload.review_budget_warning = input.reviewBudgetWarning;
  if (input.laneVerdict)
    payload.lane_verdict = {
      lane: input.laneVerdict.lane,
      verdict: input.laneVerdict.verdict,
    };
  if (input.autoHandoff) payload.auto_handoff = input.autoHandoff;
  const warning = input.reviewBudgetWarning
    ? `Warning: ralplan ${input.reviewBudgetWarning.lane} review budget final slot used (${input.reviewBudgetWarning.passes}/${input.reviewBudgetWarning.max}).\n`
    : "";
  return {
    payload,
    text: `${warning}Persisted ralplan ${input.stage} stage ${input.stageN} at ${input.path}.`,
  };
}

/**
 * Receipt of an identical repeated write (DR-5). For final, pass the
 * pending-approval path, the row's admission and the run's stuck flag.
 */
export function buildDeduplicatedReceipt(input: {
  sessionId: string;
  runId: string;
  stage: RalplanStage;
  stageN: number;
  sha256: string;
  repositoryBinding: unknown;
  existing: ExistingStageArtifact;
  laneVerdict?: LaneVerdictUpdate;
  persistedRoleState?: PersistedRoleStateUpdate;
  final?: { pendingApprovalPath: string; planningStuck: boolean };
}): RalplanWriteReceipt {
  const payload: Record<string, unknown> = {
    session_id: input.sessionId,
    run_id: input.runId,
    path: input.existing.path,
    stage: input.stage,
    stage_n: input.stageN,
    sha256: input.sha256,
    repository_binding: input.repositoryBinding,
    created_at: input.existing.createdAt,
    deduplicated: true,
  };
  if (input.laneVerdict)
    payload.lane_verdict = {
      lane: input.laneVerdict.lane,
      verdict: input.laneVerdict.verdict,
    };
  if (input.persistedRoleState)
    payload[`${input.persistedRoleState.role}_state`] = persistedRoleStatePayload(
      input.persistedRoleState,
    );
  if (input.stage === "final" && input.final) {
    payload.pending_approval_path = input.final.pendingApprovalPath;
    payload.auto_handoff = applyRalplanPlanningStuckOverride(
      input.existing.autoHandoff ?? unavailableRalplanFinalAdmission(),
      input.final.planningStuck,
    );
  }
  return {
    payload,
    text: `ralplan ${input.stage} stage ${input.stageN} already persisted at ${input.existing.path} (identical content; no changes written).`,
  };
}
