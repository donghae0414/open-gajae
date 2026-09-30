// Ultragoal progress log (`ultragoal/progress.txt`): the OMC ralph format —
// Codebase Patterns, per-checkpoint entries (implementation, files changed,
// learnings) and PLAN/HANDOFF notes — plus the parser the compaction
// recovery reads it with. Pure: callers read and write the file and pass text
// in.
//
// Source: oh-my-claudecode v5.4.0 (MIT) — `src/hooks/ralph/progress.ts` (log
// format, `appendProgress`, `addPattern`, `parseProgress`). Moved from the
// OMC-ralph `src/ultragoal.ts:310-509` (removed in plan S3), unchanged except
// the `PLAN` and `HANDOFF` note labels and the two helpers at the end; OMC
// `getProgressContext` is not kept (the recovery picks its own lines in
// `./recovery.ts`). This file is the only OMC-derived part of the ultragoal
// runtime (plan §2 option (2)A).
// gjc deviation 1 (plan §7.1): gjc keeps no progress log (`brief.md` instead);
// open-gajae keeps this one, and `create` appends to it instead of replacing
// it (PQ-15 A): the header only when the file is missing, then a `PLAN` note.
// `handoff` adds a `HANDOFF` note (plan C-5).

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

/**
 * Notes carry the op's reason (plan §3.3); a `PLAN` note carries the plan
 * description (PQ-15 A).
 */
export function appendProgressNote(
  progress: string,
  label: "PLAN" | "HANDOFF",
  reason: string,
  now: string,
): string {
  const title = label === "PLAN" ? "**Description:**" : "**Reason:**";
  return (
    progress +
    ["", `## [${stamp(now)}] - ${label}`, "", title, `- ${oneLine(reason)}`, "", ENTRY_SEPARATOR, ""].join("\n")
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

/** PQ-15 A: `create` keeps the log; the header only when the file is missing. */
export function progressForCreate(existing: string | undefined, description: string, now: string): string {
  return appendProgressNote(existing ?? initialProgress(now), "PLAN", description, now);
}

/** Plan C-5 ⑥: the `HANDOFF` note an ultragoal handoff appends. */
export function progressForHandoff(
  existing: string | undefined,
  to: string,
  reason: string,
  now: string,
): string {
  return appendProgressNote(existing ?? initialProgress(now), "HANDOFF", `to ${to}: ${reason}`, now);
}
