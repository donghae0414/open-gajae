// Ralplan compaction recovery: project the active run's newest final (else
// newest planner/revision) stage file into a bounded contract, verified
// against its ledger sha256, and render it as compaction-context lines (spec
// D-H2, AC19). Pure: the caller reads the state and `index.jsonl` and supplies
// a confined artifact reader.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/workflow-recovery-projection.ts:25-90` (projection type),
//   `:116-389` (bounds, markdown sections, objective, `projectRalplanRun*`),
//   `:391-400` (`isSafeRunId`), `:408-440` (the state half of
//   `projectLatestRalplanRun`)
// - `session/agent-session.ts:667-703` (`renderWorkflowRecoveryContext`),
//   `:745-753` (`sanitizeCompactionStateText`)
// Not ported: ultragoal-only fields (`currentGoal`, `progress`, whose render
// lines never appear for ralplan), the zero-progress fingerprint (read only by
// gjc's continuation prompt), and the legacy directory scan for a state
// without `run_id` (`:441-462`) — the `ralplan` tool always writes `run_id`,
// and pre-port states are unreadable (DR-21). `readArtifact` replaces
// `resolveRalplanArtifactPath` + `readArtifactWithDigest`; `provenance.planPath`
// is the recorded path resolved against the run directory (gjc: its realpath),
// which the render does not print.
// Deviation 20 (DR-14): the render adds an `Intent Reconciliation:` line from
// `unresolved`, which gjc projects but does not print.
// The caller wraps the lines in `<ralplan-compaction-context>` with the
// injection-marker wrapper in `src/ralplan.ts`, as `<ultragoal-compaction-context>`
// is, so the marker has one home.

import { createHash } from "node:crypto";
import path from "node:path";

export interface RalplanRecoveryScopeItem {
  kind: "accepted" | "non_goal";
  text: string;
}

export interface RalplanRecoveryProjection {
  skill: "ralplan";
  /** Canonical durable state that produced this projection. */
  source: "ralplan-final" | "ralplan-run";
  /** Bounded accepted objective for the current work contract. */
  objective: string;
  /** Bounded accepted scope + explicit non-goals. */
  scope: RalplanRecoveryScopeItem[];
  /** Bounded acceptance criteria / verification obligations. */
  acceptanceCriteria: string[];
  /** Unresolved decisions (Intent Reconciliation), bounded. */
  unresolved: string[];
  /** Durable identity + integrity digest (`sha256:<hex>`) of the source. */
  provenance: { planPath?: string; runId?: string; stage?: string; sha256?: string };
  /** Exact next bounded action class for resumption. */
  nextAction: {
    actionClass: "awaiting-approval" | "reconcile-intent" | "revise-plan" | "run-plan-review";
    detail?: string;
  };
}

/**
 * Reads one artifact exactly once. Must return undefined unless `candidatePath`
 * is a regular file inside `runDir` with no symlinked component (gjc opens it
 * with `O_NOFOLLOW` after a realpath containment check).
 */
export type RalplanArtifactReader = (
  candidatePath: string,
  runDir: string,
) => Promise<Uint8Array | undefined>;

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

interface ParsedHeadingSection {
  title: string;
  lines: string[];
}

/** Split a markdown artifact into bounded `## `-level sections. */
function parseMarkdownSections(markdown: string): ParsedHeadingSection[] {
  const sections: ParsedHeadingSection[] = [];
  let current: ParsedHeadingSection | undefined;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.*)$/.exec(rawLine);
    if (heading) {
      current = { title: (heading[1] ?? "").trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(rawLine);
    }
  }
  return sections.slice(0, 24);
}

/** Extract bounded list items from a section body (normalizes nested bullets). */
function sectionListItems(
  section: ParsedHeadingSection | undefined,
  maxItems: number,
): string[] {
  if (!section) return [];
  const items: string[] = [];
  for (const line of section.lines) {
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    const text = boundText(
      bullet ? bullet[1] : line.trim().length > 0 ? line : undefined,
      MAX_ITEM_CHARS,
    );
    if (text) items.push(text);
    if (items.length >= maxItems) break;
  }
  return items;
}

function findSection(
  sections: ParsedHeadingSection[],
  needles: readonly string[],
): ParsedHeadingSection | undefined {
  const normalized = needles.map((needle) => needle.toLowerCase());
  return sections.find((section) =>
    normalized.some((needle) => section.title.toLowerCase().includes(needle)),
  );
}

function findSectionExact(
  sections: ParsedHeadingSection[],
  titles: readonly string[],
): ParsedHeadingSection | undefined {
  const normalized = new Set(titles.map((title) => title.toLowerCase()));
  return sections.find((section) => normalized.has(section.title.toLowerCase()));
}

/** The first non-empty prose line before or between headings. */
function objectiveFromMarkdown(markdown: string): string | undefined {
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    if (line.length === 0) continue;
    return boundText(line, MAX_OBJECTIVE_CHARS);
  }
  return undefined;
}

function isSafeRunId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value === value.trim() &&
    path.basename(value) === value &&
    value !== "." &&
    value !== ".."
  );
}

export interface RalplanRecoveryRun {
  runId: string;
  lastReviewVerdict?: string;
  lastReviewVerdictLane?: string;
}

/**
 * The state half of gjc `projectLatestRalplanRun`: the run to project from a
 * parsed ralplan state payload, or undefined (non-object, unsafe or missing
 * `run_id`). The caller skips projection when the state is absent or corrupt.
 */
export function ralplanRecoveryRunFromState(state: unknown): RalplanRecoveryRun | undefined {
  if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
  const record = state as Record<string, unknown>;
  if (!isSafeRunId(record.run_id)) return undefined;
  return {
    runId: record.run_id,
    lastReviewVerdict:
      typeof record.last_review_verdict === "string" ? record.last_review_verdict : undefined,
    lastReviewVerdictLane:
      typeof record.last_review_verdict_lane === "string"
        ? record.last_review_verdict_lane
        : undefined,
  };
}

interface RalplanProjectionRow {
  stage?: unknown;
  stage_n?: unknown;
  path?: unknown;
  sha256?: unknown;
  event?: unknown;
  planning_stuck?: unknown;
}

/**
 * gjc `projectRalplanRunInternal`. Undefined when `indexText` is missing or has
 * any malformed line, no complete final (or, unless `finalOnly`, planner/
 * revision) row exists, the artifact is unreadable or has no objective, or its
 * sha256 differs from the ledger row.
 */
export async function projectRalplanRun(
  input: RalplanRecoveryRun & {
    runDir: string;
    indexText: string | undefined;
    readArtifact: RalplanArtifactReader;
  },
  finalOnly = false,
): Promise<RalplanRecoveryProjection | undefined> {
  if (input.indexText === undefined) return undefined;
  const rows: RalplanProjectionRow[] = [];
  for (const line of input.indexText.split(/\r?\n/).map((value) => value.trim())) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return undefined;
    rows.push(parsed as RalplanProjectionRow);
  }
  const finalRow = [...rows].reverse().find((row) => row.stage === "final");
  const planRow = [...rows]
    .reverse()
    .find((row) => row.stage === "revision" || row.stage === "planner");
  const artifactRow = finalOnly ? finalRow : (finalRow ?? planRow);
  if (
    typeof artifactRow?.path !== "string" ||
    artifactRow.path.trim().length === 0 ||
    typeof artifactRow.sha256 !== "string"
  )
    return undefined;
  const artifactPath = path.isAbsolute(artifactRow.path)
    ? artifactRow.path
    : path.resolve(input.runDir, artifactRow.path);
  const bytes = await input.readArtifact(artifactPath, input.runDir);
  if (!bytes) return undefined;
  const markdown = new TextDecoder().decode(bytes);
  const objective = objectiveFromMarkdown(markdown);
  if (!objective) return undefined;
  const sections = parseMarkdownSections(markdown);
  const primaryAcceptance = sectionListItems(
    findSection(sections, ["acceptance criteria", "verification", "test plan"]),
    MAX_CRITERIA_ITEMS,
  );
  const acceptance =
    primaryAcceptance.length > 0
      ? primaryAcceptance
      : sectionListItems(findSectionExact(sections, ["acceptance"]), MAX_CRITERIA_ITEMS);
  const nonGoals = sectionListItems(
    findSectionExact(sections, ["non-goals", "non goals", "non-goal", "out of scope"]),
    MAX_SCOPE_ITEMS,
  );
  const unresolved = sectionListItems(
    findSection(sections, ["intent reconciliation", "open confirmation", "unresolved"]),
    MAX_UNRESOLVED_ITEMS,
  );
  const scope: RalplanRecoveryScopeItem[] = sectionListItems(
    findSectionExact(sections, ["scope", "accepted scope"]),
    MAX_SCOPE_ITEMS,
  ).map((text) => ({ kind: "accepted" as const, text }));
  for (const text of nonGoals) scope.push({ kind: "non_goal" as const, text });
  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const recorded = artifactRow.sha256.startsWith("sha256:")
    ? artifactRow.sha256
    : `sha256:${artifactRow.sha256}`;
  if (!/^sha256:[0-9a-f]{64}$/.test(recorded) || recorded !== sha256) return undefined;
  const stage = typeof artifactRow.stage === "string" ? artifactRow.stage : "unknown";
  const lastStage = rows.at(-1)?.stage;
  const latestStage = typeof lastStage === "string" ? lastStage : undefined;
  const planningStuck = rows.some(
    (row) => row.event === "planning_stuck" && row.planning_stuck === true,
  );
  let nextAction: RalplanRecoveryProjection["nextAction"];
  if (planningStuck) {
    nextAction = { actionClass: "awaiting-approval", detail: "planning-stuck" };
  } else if (stage === "final") {
    nextAction = { actionClass: "awaiting-approval" };
  } else if (latestStage === "critic") {
    nextAction =
      input.lastReviewVerdictLane === "critic" && input.lastReviewVerdict === "OKAY"
        ? { actionClass: "reconcile-intent" }
        : { actionClass: "revise-plan" };
  } else if (latestStage === "planner" || latestStage === "revision") {
    // The manifest requires planner -> intent before Architect/Critic consensus.
    nextAction = {
      actionClass: "reconcile-intent",
      detail: `${latestStage}-without-intent-receipt`,
    };
  } else {
    nextAction = { actionClass: "run-plan-review" };
  }
  return {
    skill: "ralplan",
    source: stage === "final" ? "ralplan-final" : "ralplan-run",
    objective,
    scope,
    acceptanceCriteria: acceptance,
    unresolved,
    provenance: { planPath: artifactPath, runId: input.runId, stage, sha256 },
    nextAction,
  };
}

/** Escape XML-ish metacharacters and flatten newlines so text cannot break framing. */
function sanitizeCompactionStateText(value: string, maxLength: number): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n/g, " ")
    .replace(/[\r\n]/g, " ")
    .slice(0, maxLength);
}

/** gjc `renderWorkflowRecoveryContext` plus the Intent Reconciliation line. */
export function renderRalplanRecoveryContext(recovery: RalplanRecoveryProjection): string[] {
  const lines: string[] = [];
  const objective = sanitizeCompactionStateText(recovery.objective, 200);
  lines.push(`Workflow contract (${recovery.skill}): ${objective}`);
  const accepted = recovery.scope.filter((item) => item.kind === "accepted").slice(0, 8);
  if (accepted.length > 0) {
    lines.push(
      `Accepted scope: ${accepted.map((item) => sanitizeCompactionStateText(item.text, 120)).join("; ")}`,
    );
  }
  const nonGoals = recovery.scope.filter((item) => item.kind === "non_goal").slice(0, 6);
  if (nonGoals.length > 0) {
    lines.push(
      `Non-goals: ${nonGoals.map((item) => sanitizeCompactionStateText(item.text, 120)).join("; ")}`,
    );
  }
  if (recovery.acceptanceCriteria.length > 0) {
    lines.push(
      `Acceptance criteria: ${recovery.acceptanceCriteria.map((item) => sanitizeCompactionStateText(item, 120)).join("; ")}`,
    );
  }
  // Deviation 20 (DR-14): gjc projects `unresolved` but does not print it.
  if (recovery.unresolved.length > 0) {
    lines.push(
      `Intent Reconciliation: ${recovery.unresolved.map((item) => sanitizeCompactionStateText(item, 120)).join("; ")}`,
    );
  }
  lines.push(`Next action: ${recovery.nextAction.actionClass}`);
  if (recovery.provenance.sha256) lines.push(`Contract digest: ${recovery.provenance.sha256}`);
  return lines;
}
