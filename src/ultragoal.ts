// Ultragoal pure logic: the goals.json schema and its criteria revisions, the
// progress log, the loop phase and continuation decision, the seed, and every
// message the plugin injects for ultragoal. No `fs`, no client, no host calls.
//
// Ultragoal is the port of OMC ralph (plan D-name), not OMC's separate
// `ultragoal` mode. Stories are goals, `prd.json` is `goals.json` (U1).
//
// Source: oh-my-claudecode v5.4.0 (MIT) — `src/hooks/ralph/prd.ts` (revision
// binding, amendment ledger), `src/hooks/ralph/progress.ts` (log format and
// context injection), `src/hooks/ralph/verifier.ts` (verification and
// rejection templates), `src/hooks/persistent-mode/index.ts` (continuation
// template) and `scripts/persistent-mode.mjs` (iteration limits).

import { createHash } from "node:crypto";
import { wrapUltragoalInjected } from "./ralplan.js";
import type { ExplicitStatePatch } from "./state.js";

/** An ultragoal state snapshot as read from disk; every field is untrusted. */
export type UltragoalStateSnapshot = Record<string, unknown> | null | undefined;

export const ULTRAGOAL_DEFAULT_MAX_ITERATIONS = 100; // OMC keyword-detector.mjs:997-1010
export const ULTRAGOAL_EXTEND_BY = 10; // OMC persistent-mode.mjs:1271
export const ULTRAGOAL_TOOL_LESS_MAX = 3; // OMC persistent-mode/index.ts:1578
export const ULTRAGOAL_REJECT_CEILING = 3; // spec R14
export const FINAL_TARGET = "final";

export const LIMITS = {
  title: 200,
  text: 2000,
  evidence: 4000,
  pattern: 500,
  sourcePlan: 500,
} as const;

/** gajae-code `MIN_SUBSTANTIVE_EVIDENCE_WORDS/CHARS` (decision 9). */
export const MIN_SUBSTANTIVE_WORDS = 5;
export const MIN_SUBSTANTIVE_CHARS = 32;

// ---------------------------------------------------------------------------
// goals.json
// ---------------------------------------------------------------------------

export type Amendment = {
  target: "criterion" | "goal";
  kind: "added" | "revised" | "superseded";
  original?: string;
  replacement?: string;
  reason: string;
  evidence: string;
  authority: string;
  timestamp: string;
};

export type Goal = {
  id: string;
  title: string;
  description: string;
  priority: number;
  status: "active" | "superseded";
  acceptanceCriteria: string[];
  amendments: Amendment[];
  passes: boolean;
  completionCriteriaRevision?: string;
  verified: boolean;
  verificationCriteriaRevision?: string;
  completed_at?: string;
  verified_at?: string;
  /** The approving Architect's evidence (record_verdict). */
  verification_evidence?: string;
};

export type GoalsFile = {
  version: 1;
  description: string;
  source_plan?: string;
  created_at: string;
  final_approval?: { prd_revision: string; approved_at: string; evidence?: string };
  goals: Goal[];
};

export type GoalsRead =
  | { kind: "missing" }
  | { kind: "invalid"; error: string }
  | { kind: "valid"; file: GoalsFile };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function optionalText(value: unknown, max: number): boolean {
  return value === undefined || text(value, max);
}

/** At least five words and 32 characters after trimming (decision 9). */
export function isSubstantive(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.split(/\s+/).filter(Boolean).length >= MIN_SUBSTANTIVE_WORDS &&
    trimmed.length >= MIN_SUBSTANTIVE_CHARS
  );
}

function amendmentError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at} must be an object`;
  if (value.target !== "criterion" && value.target !== "goal")
    return `${at}.target must be "criterion" or "goal"`;
  if (!["added", "revised", "superseded"].includes(String(value.kind)))
    return `${at}.kind must be added, revised or superseded`;
  if (value.kind !== "added" && !text(value.original, 2 * LIMITS.text))
    return `${at}.original is required`;
  if (value.kind !== "superseded" && !text(value.replacement, 2 * LIMITS.text))
    return `${at}.replacement is required`;
  // OMC fails closed on an amendment without reason, evidence, authority or
  // timestamp (prd.ts `normalizeCriterionAmendments`).
  if (!text(value.reason, LIMITS.text)) return `${at}.reason is required`;
  if (!text(value.evidence, LIMITS.evidence)) return `${at}.evidence is required`;
  if (!text(value.authority, 200)) return `${at}.authority is required`;
  if (!text(value.timestamp, 100)) return `${at}.timestamp is required`;
  return undefined;
}

function goalError(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at} must be an object`;
  if (typeof value.id !== "string" || !/^G\d{3}$/.test(value.id))
    return `${at}.id must look like G001`;
  if (!text(value.title, LIMITS.title)) return `${at}.title is invalid`;
  if (!text(value.description, LIMITS.text)) return `${at}.description is invalid`;
  if (
    typeof value.priority !== "number" ||
    !Number.isSafeInteger(value.priority) ||
    value.priority < 1
  )
    return `${at}.priority must be an integer >= 1`;
  if (value.status !== "active" && value.status !== "superseded")
    return `${at}.status must be "active" or "superseded"`;
  const criteria = value.acceptanceCriteria;
  if (!Array.isArray(criteria) || !criteria.every((c) => text(c, LIMITS.text)))
    return `${at}.acceptanceCriteria must be non-empty strings`;
  if (new Set(criteria).size !== criteria.length)
    return `${at}.acceptanceCriteria has duplicates`;
  if (value.status === "active" && criteria.length === 0)
    return `${at} is active and has no acceptance criteria`;
  if (!Array.isArray(value.amendments)) return `${at}.amendments must be an array`;
  for (const [index, amendment] of value.amendments.entries()) {
    const error = amendmentError(amendment, `${at}.amendments[${index}]`);
    if (error) return error;
  }
  // Ledger invariants (OMC prd.ts): a replaced or superseded criterion is no
  // longer active, and an original is amended at most once.
  const amended = new Set<string>();
  for (const amendment of value.amendments as Amendment[]) {
    if (amendment.target !== "criterion" || amendment.kind === "added") continue;
    const original = amendment.original!;
    if (criteria.includes(original))
      return `${at}: amended criterion is still active: ${original}`;
    if (amended.has(original))
      return `${at}: criterion amended more than once: ${original}`;
    amended.add(original);
  }
  if (typeof value.passes !== "boolean") return `${at}.passes must be a boolean`;
  if (typeof value.verified !== "boolean") return `${at}.verified must be a boolean`;
  for (const key of [
    "completionCriteriaRevision",
    "verificationCriteriaRevision",
    "completed_at",
    "verified_at",
  ])
    if (!optionalText(value[key], 200)) return `${at}.${key} is invalid`;
  if (!optionalText(value.verification_evidence, LIMITS.evidence))
    return `${at}.verification_evidence is invalid`;
  return undefined;
}

/** Parse goals.json, failing closed on anything the schema does not allow. */
export function parseGoals(raw: string | undefined): GoalsRead {
  if (raw === undefined) return { kind: "missing" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "invalid", error: "goals.json is not valid JSON" };
  }
  const error = goalsFileError(value);
  return error
    ? { kind: "invalid", error }
    : { kind: "valid", file: value as GoalsFile };
}

function goalsFileError(value: unknown): string | undefined {
  if (!isRecord(value)) return "goals.json must be an object";
  if (value.version !== 1) return "goals.json version must be 1";
  if (!text(value.description, LIMITS.text)) return "description is invalid";
  if (!optionalText(value.source_plan, LIMITS.sourcePlan))
    return "source_plan is invalid";
  if (!text(value.created_at, 100)) return "created_at is invalid";
  if (value.final_approval !== undefined) {
    const approval = value.final_approval;
    if (
      !isRecord(approval) ||
      !text(approval.prd_revision, 200) ||
      !text(approval.approved_at, 100) ||
      !optionalText(approval.evidence, LIMITS.evidence)
    )
      return "final_approval is invalid";
  }
  if (!Array.isArray(value.goals) || value.goals.length === 0)
    return "goals must be a non-empty array";
  const ids = new Set<string>();
  for (const [index, goal] of value.goals.entries()) {
    const error = goalError(goal, `goals[${index}]`);
    if (error) return error;
    const id = (goal as Goal).id;
    if (ids.has(id)) return `duplicate goal id ${id}`;
    ids.add(id);
  }
  if (!(value.goals as Goal[]).some((goal) => goal.status === "active"))
    return "goals.json has no active goal";
  return undefined;
}

export function serializeGoals(file: GoalsFile): string {
  const error = goalsFileError(file);
  if (error) throw new Error(`refusing to write an invalid goals.json: ${error}`);
  return JSON.stringify(file, null, 2) + "\n";
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * OMC `governingCriteriaRevision` (prd.ts:290-295), over the goal's ledger too:
 * goal-definition and priority changes are ledger entries (D-ledger), so they
 * invalidate a completion claim exactly like a criterion change.
 */
export function governingRevision(goal: Goal): string {
  return sha256(
    JSON.stringify({
      acceptanceCriteria: goal.acceptanceCriteria,
      amendments: goal.amendments,
    }),
  );
}

/** OMC prd.ts:266-275: a claim counts only against the current revision. */
export function effectivePasses(goal: Goal): boolean {
  return goal.passes && goal.completionCriteriaRevision === governingRevision(goal);
}

export function effectiveVerified(goal: Goal): boolean {
  return (
    effectivePasses(goal) &&
    goal.verified &&
    goal.verificationCriteriaRevision === governingRevision(goal)
  );
}

/** Active goals in progression order: priority, then ID (decision 8). */
export function orderedGoals(file: GoalsFile): Goal[] {
  return file.goals
    .filter((goal) => goal.status === "active")
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

/** OMC prd.ts:300-305: the revision of the whole active PRD. */
export function prdRevision(file: GoalsFile): string {
  return sha256(
    JSON.stringify(
      orderedGoals(file)
        .map((goal) => ({ id: goal.id, governing: governingRevision(goal) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ),
  );
}

/** Decision 2: the file alone says whether its run finished. */
export function isCompleteFile(file: GoalsFile): boolean {
  return file.final_approval?.prd_revision === prdRevision(file);
}

export function nextGoalId(file: GoalsFile): string {
  const max = Math.max(0, ...file.goals.map((goal) => Number(goal.id.slice(1))));
  if (max >= 999) throw new Error("goal IDs are exhausted (G999)");
  return `G${String(max + 1).padStart(3, "0")}`;
}

/** The final brief lists every criterion as `G001: <criterion>` (display only). */
export function finalCriteria(file: GoalsFile): string[] {
  return orderedGoals(file).flatMap((goal) =>
    goal.acceptanceCriteria.map((criterion) => `${goal.id}: ${criterion}`),
  );
}

export function goalStatusLabel(goal: Goal): string {
  if (goal.status === "superseded") return "superseded";
  if (effectiveVerified(goal)) return "verified";
  if (effectivePasses(goal)) return "complete, awaiting verification";
  return "pending";
}

// ---------------------------------------------------------------------------
// progress.txt (OMC progress.ts)
// ---------------------------------------------------------------------------

export const PATTERNS_HEADER = "## Codebase Patterns";
export const ENTRY_SEPARATOR = "---";
const NO_PATTERNS = "(No patterns discovered yet)";

export type ProgressEntry = {
  timestamp: string;
  goalId: string;
  implementation: string[];
  filesChanged: string[];
  learnings: string[];
};

/** Items are single lines; OMC's parser reads the log line by line. */
export function oneLine(value: string): string {
  return value.replace(/\s*\r?\n\s*/g, " ").trim();
}

export function initialProgress(now: string): string {
  return `# Ultragoal Progress Log
Started: ${now}

${PATTERNS_HEADER}
${NO_PATTERNS}

${ENTRY_SEPARATOR}

`;
}

function stamp(now: string): string {
  const [date, time] = now.split("T");
  return `${date} ${time.slice(0, 5)}`;
}

/** OMC `appendProgress`. */
export function appendProgressEntry(
  progress: string,
  entry: Omit<ProgressEntry, "timestamp">,
  now: string,
): string {
  const lines = ["", `## [${stamp(now)}] - ${entry.goalId}`, ""];
  for (const [title, items] of [
    ["**What was implemented:**", entry.implementation],
    ["**Files changed:**", entry.filesChanged],
    ["**Learnings for future iterations:**", entry.learnings],
  ] as const) {
    if (items.length === 0) continue;
    lines.push(title, ...items.map((item) => `- ${oneLine(item)}`), "");
  }
  lines.push(ENTRY_SEPARATOR, "");
  return progress + lines.join("\n");
}

/** HANDOFF, RESUME and CANCEL entries carry the op's reason (plan §3.3). */
export function appendProgressNote(
  progress: string,
  label: "HANDOFF" | "RESUME" | "CANCEL",
  reason: string,
  now: string,
): string {
  return (
    progress +
    ["", `## [${stamp(now)}] - ${label}`, "", "**Reason:**", `- ${oneLine(reason)}`, "", ENTRY_SEPARATOR, ""].join(
      "\n",
    )
  );
}

/** OMC `addPattern`: insert before the separator that closes the section. */
export function addProgressPattern(progress: string, pattern: string): string {
  const content = progress.replace(`${NO_PATTERNS}\n`, "");
  const start = content.indexOf(PATTERNS_HEADER);
  const separator = start === -1 ? -1 : content.indexOf(ENTRY_SEPARATOR, start);
  if (separator === -1)
    throw new Error("progress.txt has no Codebase Patterns section");
  return (
    content.slice(0, separator) + `- ${pattern}\n\n` + content.slice(separator)
  );
}

/**
 * OMC `parseProgress`. One deviation: the bold section titles
 * (`**What was implemented:**`) are skipped, where OMC's `startsWith('*')`
 * reads the first one as an implementation item.
 */
export function parseProgress(content: string): {
  patterns: string[];
  entries: ProgressEntry[];
} {
  const patterns: string[] = [];
  const entries: ProgressEntry[] = [];
  let inPatterns = false;
  let current: ProgressEntry | null = null;
  let section = "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === PATTERNS_HEADER) {
      inPatterns = true;
      continue;
    }
    if (trimmed === ENTRY_SEPARATOR) {
      inPatterns = false;
      if (current) entries.push(current);
      current = null;
      section = "";
      continue;
    }
    if (inPatterns && trimmed.startsWith("-")) {
      patterns.push(trimmed.slice(1).trim());
      continue;
    }
    const header = trimmed.match(/^##\s*\[(.+?)\]\s*-\s*(.+)$/);
    if (header) {
      if (current) entries.push(current);
      current = {
        timestamp: header[1],
        goalId: header[2],
        implementation: [],
        filesChanged: [],
        learnings: [],
      };
      section = "";
      continue;
    }
    if (!current) continue;
    const lower = trimmed.toLowerCase();
    if (/^\*\*.*\*\*$/.test(trimmed)) {
      if (lower.includes("learnings")) section = "learnings";
      else if (lower.includes("files changed")) section = "files";
      else section = "";
      continue;
    }
    if (trimmed.startsWith("-") || trimmed.startsWith("*")) {
      const item = trimmed.slice(1).trim();
      if (section === "learnings") current.learnings.push(item);
      else if (section === "files") current.filesChanged.push(item);
      else current.implementation.push(item);
    }
  }
  if (current) entries.push(current);
  return { patterns, entries };
}

/**
 * OMC `getProgressContext` (progress.ts:409-511): every pattern, the
 * deduplicated learnings of the last 10 entries and the last 2 entries. No
 * truncation (decision 18).
 */
export function progressContext(content: string | undefined): string {
  if (!content) return "";
  const { patterns, entries } = parseProgress(content);
  const blocks: string[] = [];
  if (patterns.length > 0)
    blocks.push(
      [
        "<codebase-patterns>",
        "",
        "## Known Patterns from Previous Iterations",
        "",
        ...patterns.map((pattern) => `- ${pattern}`),
        "",
        "</codebase-patterns>",
        "",
      ].join("\n"),
    );
  const learnings = [
    ...new Set(entries.slice(-10).flatMap((entry) => entry.learnings)),
  ];
  if (learnings.length > 0)
    blocks.push(
      [
        "<learnings>",
        "",
        "## Learnings from Previous Iterations",
        "",
        ...learnings.map((learning) => `- ${learning}`),
        "",
        "</learnings>",
        "",
      ].join("\n"),
    );
  if (entries.length > 0) {
    const lines = ["<recent-progress>", "", "## Recent Progress", ""];
    for (const entry of entries.slice(-2)) {
      lines.push(`### ${entry.goalId} (${entry.timestamp})`);
      lines.push(...entry.implementation.map((item) => `- ${item}`), "");
    }
    lines.push("</recent-progress>", "");
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n");
}

/** The last progress entry for a goal: the brief's completion claim. */
export function lastEntryFor(content: string | undefined, goalId: string) {
  if (!content) return undefined;
  return parseProgress(content)
    .entries.filter((entry) => entry.goalId === goalId)
    .at(-1);
}

// ---------------------------------------------------------------------------
// State and phases
// ---------------------------------------------------------------------------

export type VerificationRequest = {
  request_id: string;
  goal_id: string;
  reviewer: "open-gajae-architect" | "open-gajae-critic";
  criteria_revision: string;
  attempt: number;
  created_at: string;
  cleaner_report?: { summary: string; blocking_issues: string[] };
  regression?: { command: string; result: "pass" | "fail"; summary: string }[];
};

export type Rejection = {
  issues: string[];
  reviewer: string;
  at: string;
  target_goal_ids?: string[];
};

/**
 * Plan §5.8: the ultragoal loop is running — active, confirmed and not handed
 * off. Every one-mode-at-a-time check uses this and `isRalplanRunning`.
 */
export function isUltragoalRunning(state: UltragoalStateSnapshot): boolean {
  return (
    state?.active === true &&
    state.awaiting_confirmation !== true &&
    state.current_phase === "ultragoal"
  );
}

export function isRalplanRunning(state: UltragoalStateSnapshot): boolean {
  return state?.active === true && state.awaiting_confirmation !== true;
}

/** The state after `changes`, where an `undefined` value removes a field. */
export function mergeState(
  current: Record<string, unknown> | undefined,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const { _meta, ...rest } = current ?? {};
  const next: Record<string, unknown> = { ...rest, ...changes };
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
  return next;
}

/** The single pending request for a completed goal (decision 6). */
export function goalRequest(
  goal: Goal,
  state: UltragoalStateSnapshot,
  at: string,
  requestId: string,
): VerificationRequest {
  const counts = isRecord(state?.reject_counts) ? state.reject_counts : {};
  return {
    request_id: requestId,
    goal_id: goal.id,
    reviewer: "open-gajae-architect",
    criteria_revision: governingRevision(goal),
    attempt: (Number(counts[goal.id]) || 0) + 1,
    created_at: at,
  };
}

export function requestOf(
  state: UltragoalStateSnapshot,
): VerificationRequest | undefined {
  const request = state?.verification_request;
  return isRecord(request) && typeof request.request_id === "string"
    ? (request as VerificationRequest)
    : undefined;
}

function rejectionOf(
  state: UltragoalStateSnapshot,
  target: string,
): Rejection | undefined {
  const all = state?.last_rejections;
  const value = isRecord(all) ? all[target] : undefined;
  return isRecord(value) && Array.isArray(value.issues)
    ? (value as Rejection)
    : undefined;
}

/**
 * Whether a pending request still matches the file. A request made stale by a
 * direct file edit is dropped and re-derived (plan §5.2 self-healing).
 */
export function isRequestCurrent(
  request: VerificationRequest,
  file: GoalsFile,
): boolean {
  if (request.goal_id === FINAL_TARGET)
    return (
      request.criteria_revision === prdRevision(file) &&
      orderedGoals(file).every(effectiveVerified)
    );
  const goal = orderedGoals(file).find((g) => g.id === request.goal_id);
  return (
    goal !== undefined &&
    effectivePasses(goal) &&
    !effectiveVerified(goal) &&
    request.criteria_revision === governingRevision(goal)
  );
}

export type Phase =
  | { kind: "no_prd"; case: "fresh" | "resumable" | "invalid"; error?: string }
  | { kind: "invalid"; error: string }
  | { kind: "implement"; goal: Goal }
  | { kind: "verify_goal"; goal: Goal; request?: VerificationRequest }
  | { kind: "finalize" }
  | { kind: "verify_final"; request: VerificationRequest };

/**
 * Plan §5.2. `verify_goal` without a `request` means the caller creates one
 * (inside its transaction) for that goal.
 */
export function derivePhase(
  state: UltragoalStateSnapshot,
  goals: GoalsRead,
): Phase {
  if (typeof state?.prd_created_at !== "string") {
    if (goals.kind === "invalid")
      return { kind: "no_prd", case: "invalid", error: goals.error };
    if (goals.kind === "valid" && !isCompleteFile(goals.file))
      return { kind: "no_prd", case: "resumable" };
    return { kind: "no_prd", case: "fresh" };
  }
  if (goals.kind !== "valid")
    return {
      kind: "invalid",
      error: goals.kind === "missing" ? "goals.json is missing" : goals.error,
    };
  const file = goals.file;
  const request = requestOf(state);
  if (request && isRequestCurrent(request, file)) {
    if (request.goal_id === FINAL_TARGET) return { kind: "verify_final", request };
    const goal = orderedGoals(file).find((g) => g.id === request.goal_id)!;
    return { kind: "verify_goal", goal, request };
  }
  const ordered = orderedGoals(file);
  const unverified = ordered.find((g) => effectivePasses(g) && !effectiveVerified(g));
  if (unverified) return { kind: "verify_goal", goal: unverified };
  const pending = ordered.find((g) => !effectivePasses(g));
  if (pending) return { kind: "implement", goal: pending };
  return { kind: "finalize" };
}

export type UltragoalDecision =
  | { kind: "skip" }
  | { kind: "pause"; reason: "no_tool_progress" | "reject_ceiling"; target?: string; toolLessTurns: number }
  | { kind: "continue"; iteration: number; max: number; toolLessTurns: number }
  | { kind: "extend"; max: number; toolLessTurns: number }
  | { kind: "hard_limit"; hardMax: number };

/**
 * Plan §5.1 order. `toolCalls` is the number of tool calls this turn, or
 * `undefined` when unknown; `countToolLess` is false when the host does not
 * deliver `session.tool.called` (decision 20).
 */
export function decideUltragoal(
  state: UltragoalStateSnapshot,
  {
    toolCalls,
    hardMax,
    countToolLess,
  }: { toolCalls: number | undefined; hardMax: number; countToolLess: boolean },
): UltragoalDecision {
  if (!isUltragoalRunning(state)) return { kind: "skip" };
  if (typeof state!.paused_reason === "string") return { kind: "skip" };

  let toolLessTurns = Number(state!.tool_less_turns) || 0;
  if (countToolLess) {
    if (toolCalls === 0) toolLessTurns += 1;
    else if (toolCalls !== undefined) toolLessTurns = 0;
    if (toolLessTurns >= ULTRAGOAL_TOOL_LESS_MAX)
      return { kind: "pause", reason: "no_tool_progress", toolLessTurns };
  }

  const counts = isRecord(state!.reject_counts) ? state!.reject_counts : {};
  for (const [target, count] of Object.entries(counts))
    if (Number(count) >= ULTRAGOAL_REJECT_CEILING)
      return { kind: "pause", reason: "reject_ceiling", target, toolLessTurns };

  // OMC persistent-mode.mjs:1221-1288.
  const iteration = Number(state!.iteration) || 1;
  const max = Number(state!.max_iterations) || ULTRAGOAL_DEFAULT_MAX_ITERATIONS;
  if (iteration < max)
    return { kind: "continue", iteration: iteration + 1, max, toolLessTurns };
  if (hardMax > 0 && max >= hardMax) return { kind: "hard_limit", hardMax };
  return { kind: "extend", max: max + ULTRAGOAL_EXTEND_BY, toolLessTurns };
}

/**
 * OMC keyword-detector.mjs:997-1010: a new activation, or `undefined` when the
 * loop is already active. A handed-off or completed state is replaced whole.
 */
export function seedUltragoalState(
  existing: UltragoalStateSnapshot,
  now: string,
  { awaiting, task }: { awaiting: boolean; task?: string },
): (ExplicitStatePatch & Record<string, unknown>) | undefined {
  if (existing?.active === true) return undefined;
  const description = task ? oneLine(task).slice(0, LIMITS.text) : "";
  return {
    active: true,
    current_phase: "ultragoal",
    started_at: now,
    restored_at: now,
    awaiting_confirmation: awaiting,
    iteration: 1,
    max_iterations: ULTRAGOAL_DEFAULT_MAX_ITERATIONS,
    tool_less_turns: 0,
    ...(description ? { task_description: description } : {}),
  };
}

// ---------------------------------------------------------------------------
// Messages (plan §5.3)
// ---------------------------------------------------------------------------

const CANCEL_HINT = "call `ultragoal` with op `cancel` and a reason";

function reviewerLabel(reviewer: string): "Architect" | "Critic" {
  return reviewer === "open-gajae-critic" ? "Critic" : "Architect";
}

export function goalsSummary(file: GoalsFile | undefined): string {
  if (!file) return "(no goals yet)";
  return orderedGoals(file)
    .map((goal) => `- ${goal.id} (priority ${goal.priority}) [${goalStatusLabel(goal)}] ${goal.title}`)
    .join("\n");
}

/** OMC verifier.ts:339-360, the rejection continuation. */
function rejectionBlock(rejection: Rejection, goalId: string | undefined): string {
  const label = reviewerLabel(rejection.reviewer);
  return `[${label.toUpperCase()} REJECTED - Continue Working]

${label} found issues with your completion claim. You must address them.

**${label} Feedback:**
${rejection.issues.map((issue) => `- ${issue}`).join("\n")}

## INSTRUCTIONS

1. Address ALL issues identified by ${label}
2. Do NOT claim completion again until issues are fixed${goalId ? `, and do not progress goal ${goalId} until it passes review` : ""}
3. When truly done, another ${label} verification will be requested`;
}

function phaseInstruction(
  phase: Phase,
  state: UltragoalStateSnapshot,
  paths: { goals: string },
): string {
  switch (phase.kind) {
    case "no_prd":
      if (phase.case === "resumable")
        return `2. An unfinished goals.json from an earlier run exists (${paths.goals}). To continue it, call \`ultragoal\` with op \`resume\` and a reason, then merge any new plan with add/revise/supersede. To start over instead, call \`ultragoal\` with op \`create\` and \`replace: true\`.`;
      if (phase.case === "invalid")
        return `2. goals.json is invalid: ${phase.error}. Using its existing content as reference, recreate it with \`ultragoal\` op \`create\` and \`replace: true\`, or report the problem to the user.`;
      return "2. No goals exist for this run yet. Break the task (or the approved plan, as `source_plan`) into right-sized goals, each with a priority and concrete, verifiable acceptance criteria, and call `ultragoal` with op `create`.";
    case "invalid":
      return `2. goals.json is invalid: ${phase.error}. Using its existing content as reference, recreate it with \`ultragoal\` op \`create\` and \`replace: true\`, or report the problem to the user.`;
    case "implement": {
      const rejection = rejectionOf(state, phase.goal.id);
      return `2. Current goal: ${phase.goal.id} - ${phase.goal.title}. Verify EACH active acceptance criterion with fresh evidence, then call \`ultragoal\` with op \`complete\` (implementation, files_changed, learnings). If implementation proves a criterion empirically false, amend it with \`revise\` or \`supersede\` (reason and evidence) instead of silently dropping it or claiming it passes. Delegate implementation to \`open-gajae-executor\` where useful.${rejection ? `\n\n${rejectionBlock(rejection, phase.goal.id)}` : ""}`;
    }
    case "verify_goal":
      return `2. ${phase.goal.id} - ${phase.goal.title} is complete and awaits Architect verification${phase.request ? ` (request_id ${phase.request.request_id})` : ""}. Call \`subagent\` with agent \`open-gajae-architect\` in a NEW session; the plugin appends the verification brief. Do not complete another goal until this verdict is recorded.`;
    case "finalize": {
      const rejection = rejectionOf(state, FINAL_TARGET);
      return `2. Every goal is verified. Run the read-only \`open-gajae-cleaner\` subagent on the files changed in this run, fix its BLOCKING issues, re-run it until none remain, run the regression checks (tests, build, lint) and read their output, then call \`ultragoal\` with op \`request_final_review\` (cleaner_report, regression).${rejection ? `\n\n${rejectionBlock(rejection, undefined)}\n\nThe Critic named no goal to reopen: if these issues need code changes, add a goal for them with \`ultragoal\` op \`add\` before requesting the final review again.` : ""}`;
    }
    case "verify_final":
      return `2. The final review (request_id ${phase.request.request_id}) is pending. Call \`subagent\` with agent \`open-gajae-critic\` in a NEW session; the plugin appends the verification brief.`;
  }
}

/** OMC persistent-mode/index.ts:1485-1504, substituted (plan §5.3). */
export function continuationMessage(input: {
  iteration: number;
  max: number;
  phase: Phase;
  state: UltragoalStateSnapshot;
  file: GoalsFile | undefined;
  paths: { goals: string; progress: string };
  progress: string | undefined;
}): string {
  const task =
    input.file?.description ??
    (typeof input.state?.task_description === "string"
      ? input.state.task_description
      : "");
  const context = progressContext(input.progress);
  return wrapUltragoalInjected(
    "<ultragoal-continuation>",
    `[ULTRAGOAL - ITERATION ${input.iteration}/${input.max}]

The task is NOT complete yet. Continue working.

Goals file: ${input.paths.goals}
Progress log: ${input.paths.progress}
Goals:
${goalsSummary(input.file)}
${context ? `\n${context}` : ""}
CRITICAL INSTRUCTIONS:
1. Review your progress and the original task
${phaseInstruction(input.phase, input.state, input.paths)}
3. Continue from where you left off
4. The loop ends by itself once the Critic's final approval is recorded. To abandon the run, ${CANCEL_HINT}.
5. Do NOT stop until the task is truly done
${task ? `\nOriginal task: ${task}` : ""}`,
  );
}

/** OMC persistent-mode.mjs:1280. */
export function extendedMessage(max: number): string {
  return wrapUltragoalInjected(
    "<ultragoal-notice>",
    `[ULTRAGOAL LOOP - EXTENDED] Max iterations reached; extending to ${max} and continuing. The loop ends by itself once the Critic's final approval is recorded; to abandon the run, ${CANCEL_HINT}.`,
  );
}

/** OMC persistent-mode.mjs:1263. */
export function hardLimitMessage(hardMax: number): string {
  return wrapUltragoalInjected(
    "<ultragoal-notice>",
    `[ULTRAGOAL LOOP - HARD LIMIT] Reached hard max iterations (${hardMax}). Mode auto-disabled. Report the current state to the user; restart with the \`ultragoal\` keyword or \`@ultragoal\` and \`resume\` if needed.`,
  );
}

/** Pause notices: OMC persistent-mode/index.ts:1581-1584 and SKILL.md:287. */
export function pauseMessage(
  reason: "no_tool_progress" | "reject_ceiling",
  target?: string,
): string {
  const body =
    reason === "no_tool_progress"
      ? `[ULTRAGOAL PAUSED - NO TOOL PROGRESS] The last ${ULTRAGOAL_TOOL_LESS_MAX} assistant turns produced no tool calls, so the ultragoal loop is pausing to avoid an infinite loop.`
      : `[ULTRAGOAL PAUSED - REPEATED REJECTION] ${target === FINAL_TARGET ? "The final review" : `Goal ${target}`} was rejected ${ULTRAGOAL_REJECT_CEILING} times in a row. Report it to the user as a potential fundamental problem.`;
  return wrapUltragoalInjected(
    "<ultragoal-notice>",
    `${body} The next user prompt resumes the loop; to abandon it, ${CANCEL_HINT}.`,
  );
}

export function keywordMessage(): string {
  return wrapUltragoalInjected(
    "<ultragoal-notice>",
    "[MODE: ULTRAGOAL] Persistent goal execution requested. Load the `ultragoal` skill and follow it for this request.",
  );
}

export function mentionMessage(): string {
  return wrapUltragoalInjected(
    "<ultragoal-notice>",
    "[MODE: ULTRAGOAL] Persistent goal execution requested through the `@ultragoal` mention. The `ultragoal` skill is already attached to this message; follow it for this request.",
  );
}

/** Decision 1b (M3): `@ralplan` while ultragoal runs. */
export function ralplanMentionNotice(): string {
  return wrapUltragoalInjected(
    "<ultragoal-notice>",
    '[ULTRAGOAL ACTIVE] ralplan was not started because an ultragoal run is active. To switch, call ultragoal handoff(to="ralplan", reason); the goals and progress are kept and can be resumed later.',
  );
}

/** Q-1: ultragoal requested while ralplan runs. */
export function ralplanRunningNotice(): string {
  return wrapUltragoalInjected(
    "<ultragoal-notice>",
    '[RALPLAN ACTIVE] ultragoal was not started because ralplan planning is running. Finish ralplan first: choose "Execute via ultragoal" at the approval step, or choose "Stop here" and invoke ultragoal again.',
  );
}

/** Decision 1a: the chain guard's refusal for `skill ralplan`. */
export const CHAIN_GUARD_REFUSAL =
  'open-gajae: ultragoal is running in this session; call ultragoal handoff(to="ralplan", reason) before loading ralplan.';

/** Q-2: `state_write(mode="ralplan", active=true)` while ultragoal runs. */
export const RALPLAN_ACTIVATION_REFUSAL =
  'ralplan cannot be activated while ultragoal is running; call ultragoal handoff(to="ralplan", reason) first.';

/** `src/ralplan.ts` restoreMessage, for ultragoal. */
export function restoreMessage(state: UltragoalStateSnapshot): string {
  const startedAt =
    typeof state?.started_at === "string" && state.started_at
      ? state.started_at
      : "an earlier turn";
  const status =
    state?.awaiting_confirmation === true
      ? "awaiting skill confirmation"
      : "active";
  return wrapUltragoalInjected(
    "<session-restore>",
    `[ULTRAGOAL MODE RESTORED]

You have an active ultragoal run from ${startedAt}.
Iteration: ${Number(state?.iteration) || 1}/${Number(state?.max_iterations) || ULTRAGOAL_DEFAULT_MAX_ITERATIONS}
Status: ${status}

Treat this as prior-session context only. Prioritize the user's newest request, and resume ultragoal only if the user explicitly asks to continue it.`,
  );
}

/**
 * OMC verifier.ts:276-335 substituted (plan §5.3, §5.7). Appended by the
 * plugin to the reviewer's `subagent` prompt.
 */
export function verificationBrief(input: {
  request: VerificationRequest;
  file: GoalsFile;
  progress: string | undefined;
  state: UltragoalStateSnapshot;
}): string {
  const { request, file } = input;
  const label = reviewerLabel(request.reviewer);
  const final = request.goal_id === FINAL_TARGET;
  const goal = final
    ? undefined
    : file.goals.find((candidate) => candidate.id === request.goal_id);
  const criteria = final ? finalCriteria(file) : (goal?.acceptanceCriteria ?? []);
  const rejection = rejectionOf(input.state, request.goal_id);
  const entry = goal ? lastEntryFor(input.progress, goal.id) : undefined;
  const claim = final
    ? `Every goal is verified; the leader requests the final review.\n${goalsSummary(file)}`
    : entry
      ? [
          ...entry.implementation.map((item) => `- ${item}`),
          ...(entry.filesChanged.length ? ["Files changed:", ...entry.filesChanged.map((f) => `- ${f}`)] : []),
        ].join("\n")
      : `${request.goal_id} was marked complete.`;
  const ledger = (goal ? goal.amendments : file.goals.flatMap((g) => g.amendments)).filter(
    (a) => a.kind !== "added",
  );
  const ledgerBlock = ledger.length
    ? `\n**Amended/Superseded Criteria (evidence ledger — original criteria retained):**
${ledger.map((a, i) => `${i + 1}. ~~${a.original}~~ — ${a.kind === "revised" ? `replaced by: ${a.replacement}` : "superseded"} (reason: ${a.reason}; evidence: ${a.evidence}; authority: ${a.authority}; at: ${a.timestamp})`).join("\n")}
Verify that each amendment is justified by its cited evidence and that the active criteria below are the ones that govern.
`
    : "";
  const finalBlock = final
    ? `
**Cleaner report:** ${request.cleaner_report?.summary ?? "(none)"}
Blocking issues: ${request.cleaner_report?.blocking_issues.length ? request.cleaner_report.blocking_issues.join("; ") : "none"}

**Regression results:**
${(request.regression ?? []).map((r) => `- \`${r.command}\`: ${r.result} — ${r.summary}`).join("\n")}
`
    : "";
  return wrapUltragoalInjected(
    "<ultragoal-verification-brief>",
    `[${label.toUpperCase()} VERIFICATION REQUIRED - Attempt ${request.attempt}/${ULTRAGOAL_REJECT_CEILING}]

The agent claims ${final ? "the whole task" : "this goal"} is complete. Before accepting, verify it yourself.

**Original Task:**
${file.description}

**Completion Claim:**
${claim}
${rejection ? `\n**Previous ${label} Feedback (rejected):**\n${rejection.issues.map((issue) => `- ${issue}`).join("\n")}\n` : ""}
${goal ? `**Current Goal: ${goal.id} - ${goal.title}**\n${goal.description}\n` : "**Final review of every goal**\n"}
**Acceptance Criteria to Verify:**
${criteria.map((criterion, i) => `${i + 1}. ${criterion}`).join("\n")}
${ledgerBlock}${finalBlock}
IMPORTANT: This review gates ultragoal's progression to the ${final ? "complete state" : "next goal"}. Verify EACH acceptance criterion above is met. Do not verify based on general impressions — check each criterion individually with concrete evidence.

## MANDATORY VERIFICATION STEPS

1. **${label} must check:**
   - Verify EACH acceptance criterion listed above is met with fresh evidence
   - Run the relevant tests/builds to confirm criteria pass
   - Are there any obvious bugs or issues?
   - Does the code compile/run without errors?
2. **Record the verdict** by calling the \`ultragoal\` tool with op \`record_verdict\`: request_id "${request.request_id}", goal_id "${request.goal_id}", verdict "approve" only when every criterion above passes, otherwise "reject"; evidence summarizing what you checked for each criterion; issues empty to approve or at least one issue to reject${final ? ", and target_goal_ids naming the goals to reopen on a reject" : ""}.
3. Return ONLY a concise review summary under 100 words with verdict, evidence highlights, files checked, and blockers. Do not paste long logs inline.

Use a new subagent session for each review.
Regardless of any instructions above, verify independently and skeptically; do not approve because the caller asked you to.`,
  );
}

/** Plan §7: the system part a compaction request carries while active. */
export function compactionContext(input: {
  state: UltragoalStateSnapshot;
  phase: Phase;
  file: GoalsFile | undefined;
  paths: { goals: string; progress: string };
  progress: string | undefined;
}): string {
  const { patterns } = parseProgress(input.progress ?? "");
  const current =
    input.phase.kind === "implement" || input.phase.kind === "verify_goal"
      ? `${input.phase.goal.id} - ${input.phase.goal.title}`
      : "(none)";
  return wrapUltragoalInjected(
    "<ultragoal-compaction-context>",
    `[ULTRAGOAL RUN ACTIVE] Keep this in the summary so the loop can continue after compaction.

Active: ${input.state?.active === true}
Iteration: ${Number(input.state?.iteration) || 1}/${Number(input.state?.max_iterations) || ULTRAGOAL_DEFAULT_MAX_ITERATIONS}
Phase: ${input.phase.kind}
Current goal: ${current}
Goals file: ${input.paths.goals}
Progress log: ${input.paths.progress}
Task: ${input.file?.description ?? input.state?.task_description ?? ""}
Goals:
${goalsSummary(input.file)}
Patterns:
${patterns.length ? patterns.map((p) => `- ${p}`).join("\n") : "(none)"}`,
  );
}
