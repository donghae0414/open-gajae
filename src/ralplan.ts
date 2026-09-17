// Ralplan pure logic: injected-message builders, the execution gate, and the
// continuation/seed decisions. No `fs`, no client, no host imports beyond types.
//
// n6/a3: no bare marker token is added. Every injected message is wrapped in an
// OMC-style tag, and `wrapInjected` is the ONLY way this module produces text,
// so a future injection site structurally cannot omit the marker. `wrapInjected`
// is deliberately not exported: callers outside this module can only obtain text
// through a builder, and therefore only marked text.
//
// Source: oh-my-claudecode v5.4.0 (MIT). `<ralplan-continuation>` and
// `<session-restore>` are OMC's own wrappers; `<ralplan-notice>` is a host
// addition that wraps the keyword, breaker and gate notices OMC emitted bare.

import type { ExplicitStatePatch } from "./state.js";

export const INJECTION_MARKERS = [
  "<ralplan-continuation>", // OMC src/hooks/persistent-mode/index.ts:2147
  "<session-restore>", // OMC src/hooks/bridge.ts:2074
  "<ralplan-notice>", // host addition: wraps the keyword, breaker and gate notices
] as const;

export type InjectionMarker = (typeof INJECTION_MARKERS)[number];

/** A ralplan state snapshot as read from disk; every field is untrusted. */
export type RalplanStateSnapshot = Record<string, unknown> | null | undefined;

export const RALPLAN_KEYWORD = /\b(ralplan)\b|(랄플랜)|(ラルプラン)/i; // OMC keyword-detector/index.ts:51
export const RALPLAN_STOP_BLOCKER_MAX = 30; // OMC persistent-mode/index.ts:1876
export const RALPLAN_STOP_BLOCKER_TTL_MS = 45 * 60 * 1000; // OMC persistent-mode/index.ts:1877
export const RALPLAN_SKILL_NAME = "ralplan"; // skill/command name the host confirms

/**
 * Dormant by design (spec c6). OMC seeds this with `ralph`, `autopilot` and
 * `team`; this port registers none of those workflows, so the gate is wired but
 * never fires. Populating this set is the one-line change that enables it.
 */
export const EXECUTION_GATE_KEYWORDS = new Set<string>();

/** OMC keyword-detector/index.ts:1002. */
export const GATE_BYPASS_PREFIXES = ["force:", "!"];

/**
 * Positive signals that the prompt IS well-specified enough for direct execution.
 * If ANY of these are present, the prompt auto-passes the gate (fast path).
 * Verbatim from OMC keyword-detector/index.ts:1008-1040.
 */
export const WELL_SPECIFIED_SIGNALS: RegExp[] = [
  // References specific files by extension
  /\b[\w/.-]+\.(?:ts|js|py|go|rs|java|tsx|jsx|vue|svelte|rb|c|cpp|h|css|scss|html|json|yaml|yml|toml)\b/,
  // References specific paths with directory separators
  /(?:src|lib|test|spec|app|pages|components|hooks|utils|services|api|dist|build|scripts)\/\w+/,
  // References specific functions/classes/methods by keyword
  /\b(?:function|class|method|interface|type|const|let|var|def|fn|struct|enum)\s+\w{2,}/i,
  // CamelCase identifiers (likely symbol names: processKeyword, getUserById)
  /\b[a-z]+(?:[A-Z][a-z]+)+\b/,
  // PascalCase identifiers (likely class/type names: KeywordDetector, UserModel)
  /\b[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+\b/,
  // snake_case identifiers with 2+ segments (likely symbol names: user_model, get_user)
  /\b[a-z]+(?:_[a-z]+)+\b/,
  // Bare issue/PR number (#123, #42)
  /(?:^|\s)#\d+\b/,
  // Has numbered steps or bullet list (structured request)
  /(?:^|\n)\s*(?:\d+[.)]\s|-\s+\S|\*\s+\S)/m,
  // Has acceptance criteria or test spec keywords
  /\b(?:acceptance\s+criteria|test\s+(?:spec|plan|case)|should\s+(?:return|throw|render|display|create|delete|update))\b/i,
  // Has specific error or issue reference
  /\b(?:error:|bug\s*#?\d+|issue\s*#\d+|stack\s*trace|exception|TypeError|ReferenceError|SyntaxError)\b/i,
  // Has a code block with substantial content.
  /```[\s\S]{20,}?```/,
  // PR or commit reference
  /\b(?:PR\s*#\d+|commit\s+[0-9a-f]{7}|pull\s+request)\b/i,
  // "in <specific-path>" pattern
  /\bin\s+[\w/.-]+\.(?:ts|js|py|go|rs|java|tsx|jsx)\b/,
  // Test runner commands (explicit test target)
  /\b(?:npm\s+test|npx\s+(?:vitest|jest)|pytest|cargo\s+test|go\s+test|make\s+test)\b/i,
];

/**
 * The full terminal-phase set from OMC persistent-mode/index.ts:806-824.
 * A ralplan session in any of these phases is finished: the continuation hook
 * stops reinforcing and resets the breaker instead.
 */
export const RALPLAN_TERMINAL_PHASES = new Set([
  "completed",
  "complete",
  "failed",
  "cancelled",
  "canceled",
  "aborted",
  "terminated",
  "done",
  "handoff",
  "pending approval",
  "pending-approval",
  "pending_approval",
  "awaiting approval",
  "awaiting-approval",
  "awaiting_approval",
  "approval-required",
  "approval_required",
]);

function wrapInjected(tag: InjectionMarker, body: string): string {
  const name = tag.slice(1, -1);
  return `<${name}>\n\n${body}\n\n</${name}>\n\n---\n\n`;
}

/**
 * Check if a prompt is underspecified for direct execution.
 * Returns true if the prompt lacks enough specificity for heavy execution modes.
 * Verbatim from OMC keyword-detector/index.ts:1048-1070.
 */
export function isUnderspecifiedForExecution(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;

  // Escape hatch: force: or ! prefix bypasses the gate
  for (const prefix of GATE_BYPASS_PREFIXES) {
    if (trimmed.startsWith(prefix)) return false;
  }

  // If any well-specified signal is present, pass through
  if (WELL_SPECIFIED_SIGNALS.some((p) => p.test(trimmed))) return false;

  // Strip mode keywords for effective word counting
  const stripped = trimmed.replace(/\b(?:ralph|autopilot|team)\b/gi, "").trim();
  const effectiveWords = stripped
    .split(/\s+/)
    .filter((w) => w.length > 0).length;

  // Short prompts without well-specified signals are underspecified
  if (effectiveWords <= 15) return true;

  return false;
}

/**
 * Apply the ralplan-first gate: if execution keywords are present but the
 * prompt is underspecified, redirect to ralplan. Verbatim from OMC
 * keyword-detector/index.ts:1078-1114, typed on plain string keywords.
 *
 * Reachability: with `EXECUTION_GATE_KEYWORDS` empty the executable-keyword
 * check is never reached. Nothing detected returns at the `length === 0`
 * clause; a detected `ralplan` returns at the `includes("ralplan")` clause.
 */
export function applyRalplanGate(
  keywords: string[],
  text: string,
): { keywords: string[]; gateApplied: boolean; gatedKeywords: string[] } {
  if (keywords.length === 0) {
    return { keywords, gateApplied: false, gatedKeywords: [] };
  }

  // Don't gate if cancel is present (cancel always wins)
  if (keywords.includes("cancel")) {
    return { keywords, gateApplied: false, gatedKeywords: [] };
  }

  // Don't gate if ralplan is already in the list
  if (keywords.includes("ralplan")) {
    return { keywords, gateApplied: false, gatedKeywords: [] };
  }

  // Check if any execution keywords are present
  const executionKeywords = keywords.filter((k) =>
    EXECUTION_GATE_KEYWORDS.has(k),
  );
  if (executionKeywords.length === 0) {
    return { keywords, gateApplied: false, gatedKeywords: [] };
  }

  // Check if prompt is underspecified
  if (!isUnderspecifiedForExecution(text)) {
    return { keywords, gateApplied: false, gatedKeywords: [] };
  }

  // Gate: replace execution keywords with ralplan
  const filtered = keywords.filter((k) => !EXECUTION_GATE_KEYWORDS.has(k));
  if (!filtered.includes("ralplan")) {
    filtered.push("ralplan");
  }

  return {
    keywords: filtered,
    gateApplied: true,
    gatedKeywords: executionKeywords,
  };
}

/**
 * OMC persistent-mode/index.ts:2030-2050. `current_phase ?? phase ?? status`,
 * trimmed and lowercased, with every `handoff`, `handoff:*` and `handoff-*`
 * variant collapsed to `"handoff"`.
 */
export function normalizeRalplanPhase(
  state: RalplanStateSnapshot,
): string | null {
  if (!state || typeof state !== "object") return null;
  const rawPhase = state.current_phase ?? state.phase ?? state.status;
  if (typeof rawPhase !== "string") return null;
  const phase = rawPhase.trim().toLowerCase();
  if (!phase) return null;
  if (
    phase === "handoff" ||
    phase.startsWith("handoff:") ||
    phase.startsWith("handoff-")
  )
    return "handoff";
  return phase;
}

// OMC persistent-mode/index.ts:2147-2160, with the final sentence replaced:
// this port exits through `state_clear(mode="ralplan")`, not an OMC command.
export function continuationMessage(count: number): string {
  return wrapInjected(
    "<ralplan-continuation>",
    `[RALPLAN - CONSENSUS PLANNING | REINFORCEMENT ${count}/${RALPLAN_STOP_BLOCKER_MAX}]

The ralplan consensus workflow is active. Continue the Planner/Architect/Critic planning loop only.
Ralplan is read-only/planning mode: do not implement, invoke execution skills, edit source, commit, push, or open PRs from this continuation.
When consensus is reached, stop at a pending-approval handoff and require explicit user approval before execution.
When done, call \`state_clear(mode="ralplan")\` to cleanly exit.`,
  );
}

// OMC persistent-mode/index.ts:2140, which emitted it unwrapped.
export function breakerMessage(): string {
  return wrapInjected(
    "<ralplan-notice>",
    `[RALPLAN CIRCUIT BREAKER] Stop enforcement exceeded ${RALPLAN_STOP_BLOCKER_MAX} reinforcements. Allowing stop and deactivating stale ralplan state to prevent infinite restart loops.`,
  );
}

export function keywordMessage(): string {
  return wrapInjected(
    "<ralplan-notice>",
    "[MODE: RALPLAN] Consensus planning requested. Load the `ralplan` skill and run its Planner/Architect/Critic workflow for this request.",
  );
}

// OMC bridge.ts:2074-2086, with the session_id comparison dropped: session
// isolation is structural here, since each session owns its state directory.
export function restoreMessage(state: RalplanStateSnapshot): string {
  const startedAt =
    typeof state?.started_at === "string" && state.started_at
      ? state.started_at
      : "an earlier turn";
  const phase = normalizeRalplanPhase(state) ?? "ralplan";
  const status =
    state?.awaiting_confirmation === true
      ? "awaiting skill confirmation"
      : "active";
  return wrapInjected(
    "<session-restore>",
    `[RALPLAN MODE RESTORED]

You have an active ralplan consensus planning session from ${startedAt}.
Current phase: ${phase}
Status: ${status}

Treat this as prior-session context only. Prioritize the user's newest request, and resume ralplan only if the user explicitly asks to continue it.`,
  );
}

// OMC bridge.ts:1597-1606. Dormant while the execution-gate keyword set is
// empty (spec c6); present so enabling the gate is a one-line change.
export function gateMessage(gatedKeywords: readonly string[]): string {
  const gated = gatedKeywords.join(", ");
  return wrapInjected(
    "<ralplan-notice>",
    `[RALPLAN GATE] Redirecting ${gated} → ralplan for scoping.
Tip: add a concrete anchor to run directly next time:
  • "ralph fix the bug in src/auth.ts"  (file path)
  • "ralph implement #42"               (issue number)
  • "ralph fix processKeyword"           (symbol name)
Or prefix with \`force:\` / \`!\` to bypass.`,
  );
}

/**
 * The continuation decision, in OMC `checkRalplan` order
 * (persistent-mode/index.ts:2057-2160).
 *
 * Deliberately not ported (spec c3): stale-timestamp suppression, the
 * cancel-in-progress bypass, the active-subagent recency window, and the
 * `session_id` comparison — session isolation is structural here, since each
 * session owns its own state directory.
 */
export type RalplanDecision =
  | { kind: "skip"; resetBreaker?: boolean }
  | { kind: "continue"; count: number }
  | { kind: "breaker" };

export function shouldContinue(
  state: RalplanStateSnapshot,
  now: number,
): RalplanDecision {
  if (!state || state.active !== true) return { kind: "skip" };

  // A plain boolean, with no clock and no fallback: OMC clears this on an
  // observed skill load, not on a timer, and this port reproduces that with
  // the `tool.execute.before` / `command.execute.before` hooks.
  if (state.awaiting_confirmation === true) return { kind: "skip" };

  const phase = normalizeRalplanPhase(state);
  if (phase !== null && RALPLAN_TERMINAL_PHASES.has(phase))
    return { kind: "skip", resetBreaker: true };

  const fresh =
    typeof state.breaker_updated_at === "string" &&
    now - Date.parse(state.breaker_updated_at) <= RALPLAN_STOP_BLOCKER_TTL_MS;
  const count = (fresh ? Number(state.breaker_count) || 0 : 0) + 1;
  if (count > RALPLAN_STOP_BLOCKER_MAX) return { kind: "breaker" };
  return { kind: "continue", count };
}

/**
 * OMC bridge.ts:700-712 and 754-765. Returns the patch that activates ralplan,
 * or `undefined` when the state is already active and there is nothing to write.
 *
 * n2: `restored_at` is stamped together with `started_at` so the turn this
 * plugin just seeded cannot immediately raise a restore banner.
 * n4: `started_at` is written exactly once, at activation; re-stamping it would
 * re-arm the restore predicate.
 */
export function seedState(
  existing: RalplanStateSnapshot,
  now: string,
): ExplicitStatePatch | undefined {
  if (existing?.active === true) return undefined;
  return {
    active: true,
    current_phase: "ralplan",
    started_at: now,
    awaiting_confirmation: true,
    restored_at: now,
    breaker_count: 0,
  };
}

// ---------------------------------------------------------------------------
// Keyword guard, ported verbatim from OMC `src/hooks/keyword-detector/index.ts`
// (HEAD 5281b19): `removeCodeBlocks` (184-194), the pasted-payload stripper
// (195-325), `sanitizeForKeywordDetection` and its path matcher (326-391), the
// informational/reference context constants (392-421), the span helpers
// (422-492), the explicit-invocation checks (494-562),
// `hasDiagnosticIntentNearKeyword` (564-578),
// `hasActionableCommandAfterSeparator` (612-618),
// `isInformationalKeywordContext` (620-731) and `findActionableRalplanMatch`
// (758-787). Comments are OMC's.
//
// Two OMC functions are deliberately NOT ported, because they only ever fire for
// the `ralph` and `autopilot` keywords this plugin does not register:
// `isRalphMetaOrBanterContext` (580-605) and `isAutopilotCreationAlias`
// (607-610). Their two call sites inside `isInformationalKeywordContext` are
// removed and marked with a comment at the removal point.
//
// This whole section is pure: no `fs`, no client, no host imports.
/**
 * Remove code blocks from text to prevent false positives
 * Handles both fenced code blocks and inline code
 */
export function removeCodeBlocks(text: string): string {
  // Remove fenced code blocks (``` or ~~~)
  let result = text.replace(/```[\s\S]*?```/g, '');
  result = result.replace(/~~~[\s\S]*?~~~/g, '');

  // Remove inline code (single backticks)
  result = result.replace(/`[^`]+`/g, '');

  return result;
}

const PASTED_MAGIC_KEYWORD_HEADER_PATTERN =
  /^\s*\[MAGIC KEYWORDS?(?: DETECTED)?:.*$/i;
const ROLE_BOUNDARY_PATTERN =
  /^<\s*\/?\s*(system|human|assistant|user|tool_use|tool_result)\b[^>]*>/i;
const SKILL_TRANSCRIPT_LINE_PATTERN =
  /^\s*Skill:\s+oh-my-(?:claudecode|codex):/i;
const USER_REQUEST_LINE_PATTERN = /^\s*User request(?:\s*\([^)]*\))?:\s*$/i;
const SHELL_TRANSCRIPT_LINE_PATTERN = /^\s*[$%❯]\s+/;
const GIT_DIFF_START_PATTERNS: RegExp[] = [
  /^diff\s+--git\s+a\//,
  /^index\s+[0-9a-f]+\.\.[0-9a-f]+(?:\s+\d+)?$/i,
  /^(?:---|\+\+\+)\s+[ab]\//,
  /^@@\s+-\d+/,
];
const GIT_DIFF_CONTINUATION_PATTERNS: RegExp[] = [
  /^new file mode\s+\d+$/i,
  /^deleted file mode\s+\d+$/i,
  /^similarity index\s+\d+%$/i,
  /^rename (?:from|to)\s+/i,
  /^Binary files .+ differ$/i,
  /^(?:diff\s+--git\s+a\/|index\s+[0-9a-f]+\.\.[0-9a-f]+|(?:---|\+\+\+)\s+[ab]\/|@@\s+-\d+)/i,
  /^[ +\-].*/,
];

function stripPastedCommandPayloads(text: string): string {
  const lines = text.split('\n');
  const sanitized: string[] = [];
  let insideRoleBlock = false;
  let insideDiffBlock = false;
  let insideMagicKeywordBlock = false;
  let magicBlockSawUserRequest = false;
  let magicBlockSawRequestPayload = false;
  let previousLineWasUserRequest = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (insideMagicKeywordBlock) {
      if (ROLE_BOUNDARY_PATTERN.test(trimmed)) {
        insideRoleBlock = !/^<\s*\//.test(trimmed);
        insideMagicKeywordBlock = false;
        magicBlockSawUserRequest = false;
        magicBlockSawRequestPayload = false;
        continue;
      }

      if (USER_REQUEST_LINE_PATTERN.test(line)) {
        magicBlockSawUserRequest = true;
        magicBlockSawRequestPayload = false;
        continue;
      }

      if (magicBlockSawUserRequest) {
        if (trimmed) {
          magicBlockSawRequestPayload = true;
          continue;
        }

        if (magicBlockSawRequestPayload) {
          insideMagicKeywordBlock = false;
          magicBlockSawUserRequest = false;
          magicBlockSawRequestPayload = false;
          sanitized.push(line);
          continue;
        }
      }

      continue;
    }

    if (PASTED_MAGIC_KEYWORD_HEADER_PATTERN.test(line)) {
      insideMagicKeywordBlock = true;
      magicBlockSawUserRequest = false;
      magicBlockSawRequestPayload = false;
      continue;
    }

    if (ROLE_BOUNDARY_PATTERN.test(trimmed)) {
      insideRoleBlock = !/^<\s*\//.test(trimmed);
      continue;
    }

    if (insideRoleBlock) {
      continue;
    }

    if (!trimmed) {
      sanitized.push(line);
      insideDiffBlock = false;
      previousLineWasUserRequest = false;
      continue;
    }

    if (previousLineWasUserRequest) {
      previousLineWasUserRequest = false;
      continue;
    }

    if (USER_REQUEST_LINE_PATTERN.test(line) || SKILL_TRANSCRIPT_LINE_PATTERN.test(line)) {
      previousLineWasUserRequest = USER_REQUEST_LINE_PATTERN.test(line);
      continue;
    }

    if (SHELL_TRANSCRIPT_LINE_PATTERN.test(line) && !/^\s*\$\w/.test(line)) {
      continue;
    }

    if (insideDiffBlock) {
      if (GIT_DIFF_CONTINUATION_PATTERNS.some((pattern) => pattern.test(trimmed))) {
        continue;
      }
      insideDiffBlock = false;
    }

    if (GIT_DIFF_START_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      insideDiffBlock = true;
      continue;
    }

    sanitized.push(line);
  }

  return sanitized.join('\n');
}


/**
 * Regex matching non-Latin script characters for prompt translation detection.
 * Uses Unicode script ranges (not raw non-ASCII) to avoid false positives on emoji and accented Latin.
 * Covers: CJK (Japanese/Chinese), Korean, Cyrillic, Arabic, Devanagari, Thai, Myanmar.
 */
const NON_LATIN_SCRIPT_PATTERN =
  // eslint-disable-next-line no-misleading-character-class -- Intentional: detecting script presence, not matching grapheme clusters
  /[\u3000-\u9FFF\uAC00-\uD7AF\u0400-\u04FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u1000-\u109F]/u;

/**
 * Character class for a single file-path segment. Includes `\w.-` plus the same
 * non-Latin script ranges as NON_LATIN_SCRIPT_PATTERN, so CJK/etc. file names
 * (e.g. `docs/\u30B3\u30FC\u30C9\u30EC\u30D3\u30E5\u30FC.md`) are recognized as paths and stripped before
 * keyword detection. Without this, a CJK alias embedded in a path survives
 * sanitization and falsely activates its mode (path detection is ASCII-only
 * with a bare `[\w.-]`). Building the path regex from this shared constant
 * avoids the class drifting across its repeated uses below.
 */
const PATH_SEGMENT_CHARS =
  '[\\w.\\-\\u3000-\\u9FFF\\uAC00-\\uD7AF\\u0400-\\u04FF\\u0600-\\u06FF\\u0900-\\u097F\\u0E00-\\u0E7F\\u1000-\\u109F]';

/**
 * File-path matcher used by sanitizeForKeywordDetection. Requires at least one
 * slash-terminated directory segment `(?:SEG+/)+` (optionally preceded by a `/`;
 * a leading `./` is absorbed by the first segment since SEG includes `.`), then a
 * final segment bounded as a (CJK-capable) stem ending in an ASCII `.ext` OR an
 * ASCII-only extensionless name. Directory/stem segments are Unicode-aware
 * (PATH_SEGMENT_CHARS) so CJK file names strip too, while a no-space CJK directive
 * after a path is NOT consumed by a greedy tail. Structurally identical to the
 * runtime `.mjs` path stripper, so index.ts and the .mjs produce the same keyword
 * outcome for every path input — no detector/bundle divergence. Bare slash-commands
 * like `/ralph` lack an internal slash so they are not stripped here (and are
 * detected pre-sanitization via parseExplicitWorkflowSlashInvocation anyway).
 */
/* eslint-disable no-misleading-character-class -- Same script ranges as NON_LATIN_SCRIPT_PATTERN: intentional range set, not grapheme clusters */
const FILE_PATH_PATTERN = new RegExp(
  '(^|[\\s"\'`(])(?:\\/)?(?:' +
    PATH_SEGMENT_CHARS +
    '+\\/)+(?:' +
    PATH_SEGMENT_CHARS +
    '*\\.\\w+|[\\w.\\-]+)',
  'gm',
);
/* eslint-enable no-misleading-character-class */

/**
* Sanitize text for keyword detection by removing structural noise.
 * Strips XML tags, URLs, file paths, and code blocks.
 */
export function sanitizeForKeywordDetection(text: string): string {
  let result = stripPastedCommandPayloads(text);
  // Remove HTML/markdown comments first so keywords inside comments cannot trigger modes
  result = result.replace(/<!--[\s\S]*?-->/g, '');
  // Remove XML tag blocks (opening + content + closing; tag names must match)
  result = result.replace(/<(\w[\w-]*)[\s>][\s\S]*?<\/\1>/g, '');
  // Remove self-closing XML tags
  result = result.replace(/<\w[\w-]*(?:\s[^>]*)?\s*\/>/g, '');
  // Remove URLs
  result = result.replace(/https?:\/\/\S+/g, '');
  // Remove block quotes and markdown table rows - they are typically reference content
  result = result.replace(/^\s*>\s.*$/gm, '');
  result = result.replace(/^\s*\|(?:[^|\n]*\|){2,}\s*$/gm, '');
  result = result.replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|){1,}\s*$/gm, '');
  // Remove file paths — requires leading / or ./ or multi-segment dir/file.ext.
  // Unicode-aware segments (FILE_PATH_PATTERN) so CJK file names are stripped too.
  result = result.replace(FILE_PATH_PATTERN, '$1');
  // Remove code blocks (fenced and inline)
  result = removeCodeBlocks(result);
  return result;
}

const INFORMATIONAL_INTENT_PATTERNS: RegExp[] = [
  /\b(?:what(?:'s|\s+is)|what\s+are|how\s+(?:to|do\s+i)\s+use|explain|explanation|tell\s+me\s+about|describe)\b/i,
  /(?:뭐야|뭔데|무엇(?:이야|인가요)?|어떻게|설명(?!서\s*(?:작성|만들|생성|추가|업데이트|수정|편집|쓰))|사용법|알려\s?줘|알려줄래|소개해?\s?줘|소개\s*부탁|설명해\s?줘|뭐가\s*달라|어떤\s*기능|기능\s*(?:알려|설명|뭐)|방법\s*(?:알려|설명|뭐))/u,
  /(?:とは|って何|使い方|説明|(?:について|に関して|違い)[^\n]{0,24}(?:教えて|説明|知りたい)|(?:どう|何が|どこが)違う)/u,
  /(?:什么是|怎(?:么|樣)用|如何使用|解释|說明|说明)/u,
  /(?:ทำไม|อะไร|ยังไง|อย่างไร|คืออะไร|หมายถึง|แปลว่า|อธิบาย|มั้ย|ไหม|เหรอ|หรอ|หรือไม่|หรือเปล่า|ใช่ไหม|ถูกมั้ย|เกี่ยวกับ|เหมือน)/u,
];
const INFORMATIONAL_CONTEXT_WINDOW = 80;
const QUOTED_SPAN_PATTERN =
  /"[^"\n]{1,400}"|'[^'\n]{1,400}'|“[^”\n]{1,400}”|‘[^’\n]{1,400}’/g;
const REFERENCE_META_PATTERNS: RegExp[] = [
  /\b(?:vs\.?|versus|compared\s+to|comparison|compare|article|blog\s+post|documentation|docs?|reference)\b/i,
  /(?:비교|차이|설명|정리|문서|자료|가이드|이\s*(?:글|비교|문서)는|블로그)/u,
  /\b(?:this\s+(?:article|comparison|guide|documentation|doc)|quoted|quote(?:d)?)\b/i,
  /(?:เปรียบเทียบ|ต่างกัน|ความต่าง|เอกสาร|บทความ|ไกด์|คู่มือ|เกี่ยวกับ|เหมือน)/u,
];
const REFERENCE_EXPLANATION_PATTERNS: RegExp[] = [
  /(?:^|\n)\s*(?:결론|특징|예시|요약|장점|단점|설명)\s*[:：]/u,
  /\b(?:summary|conclusion|key\s+points?|example|examples|pros|cons|overview)\s*:/i,
  /[^\n]{1,80}=\s*["“]/,
  /[→⇒]/,
];
const QUESTION_FOLLOWUP_PATTERNS: RegExp[] = [
  /\b(?:how\s+many|how\s+much|why|what\s+happened|what\s+went\s+wrong|token\s+budget|cost|pricing)\b/i,
  /(?:왜|얼마|몇\s*번|몇번|토큰|가격|비용|질문)/u,
  /(?:ทำไม|อะไร|ยังไง|อย่างไร|เท่าไหร่|กี่|มั้ย|ไหม|เหรอ|หรอ|หรือไม่|หรือเปล่า|ใช่ไหม|ถูกมั้ย)/u,
];
const MODE_REFERENCE_PATTERN =
  /\b(?:ralph|autopilot|auto[\s-]?pilot|ralplan|ultrathink|deepsearch|deep[\s-]?analyze|deepanalyze|deep[\s-]interview|ouroboros|deerflow)\b/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getLineBounds(text: string, position: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  const nextNewline = text.indexOf('\n', position);
  const end = nextNewline === -1 ? text.length : nextNewline;
  return { start, end };
}

function isWithinQuotedSpan(text: string, position: number): boolean {
  for (const match of text.matchAll(QUOTED_SPAN_PATTERN)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (position >= start && position < end) {
      return true;
    }
  }
  return false;
}

/**
 * Bounds of the specific quoted span containing `position`, or null if none.
 * Used to scope the execution-directive check for the quote exemption to
 * this keyword's own quote — not the generic ±80-char context window, which
 * can otherwise pick up an unrelated genuine command elsewhere in the same
 * message (e.g. a second keyword issued as a real directive) and wrongly
 * neutralize the exemption for a keyword that is purely quoted as an
 * example.
 */
function findQuotedSpanBounds(text: string, position: number): { start: number; end: number } | null {
  for (const match of text.matchAll(QUOTED_SPAN_PATTERN)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (position >= start && position < end) {
      return { start, end };
    }
  }
  return null;
}

function stripQuotedSpans(text: string): string {
  return text.replace(QUOTED_SPAN_PATTERN, ' ');
}

function countDistinctModeReferences(text: string): number {
  const matches = text.match(MODE_REFERENCE_PATTERN) ?? [];
  const normalized = new Set(
    matches.map((match) => match.toLowerCase().replace(/\s+/g, '').replace(/-/g, '')),
  );
  return normalized.size;
}

function looksLikeReferenceContent(text: string): boolean {
  const hasReferenceMeta = REFERENCE_META_PATTERNS.some((pattern) => pattern.test(text));
  const hasExplanationShape = REFERENCE_EXPLANATION_PATTERNS.some((pattern) => pattern.test(text));
  const hasAnyModeMention = countDistinctModeReferences(text) >= 1;
  const hasMultipleModeMentions = countDistinctModeReferences(text) >= 2;
  const hasQuestionOutsideQuotes = QUESTION_FOLLOWUP_PATTERNS.some((pattern) =>
    pattern.test(stripQuotedSpans(text)),
  );

  return (
    (hasReferenceMeta && (hasExplanationShape || hasAnyModeMention || hasQuestionOutsideQuotes)) ||
    (hasExplanationShape && (hasMultipleModeMentions || hasQuestionOutsideQuotes)) ||
    (hasMultipleModeMentions && hasQuestionOutsideQuotes)
  );
}

function hasActivationIntentNearKeyword(context: string, keyword: string): boolean {
  const escaped = escapeRegExp(keyword.trim());
  if (!escaped) return false;

  // Help-question phrasing like "How do I use autopilot?" should not be
  // treated as activation intent.
  const helpQuestionPatterns = [
    new RegExp(`\\bhow\\s+do\\s+i\\s+use\\b[^\\n]{0,40}\\b${escaped}\\b`, 'i'),
    new RegExp(`\\bwhat(?:'s|\\s+is)\\b[^\\n]{0,40}\\b${escaped}\\b[^\\n]{0,40}\\bhow\\s+to\\s+use\\b`, 'i'),
  ];
  if (helpQuestionPatterns.some((pattern) => pattern.test(context))) {
    return false;
  }

  const patterns = [
    new RegExp(`\\b(?:use|run|start|enable|activate|invoke|trigger|launch)\\b[^\\n]{0,28}\\b${escaped}\\b`, 'i'),
    new RegExp(`\\b(?:fix|debug|investigate|resolve|handle|patch|address)\\b[^\\n]{0,28}\\b(?:issue|bug|problem|error)\\b[^\\n]{0,12}\\b(?:with|in)\\s+\\b${escaped}\\b`, 'i'),

  ];

  return patterns.some((pattern) => pattern.test(context));
}

function hasDirectInvocationPrefix(text: string, position: number): boolean {
  const prefix = text.slice(0, position);
  return /^\s*(?:[$/!]\s*|force:\s*|oh-my-(?:claudecode|codex):\s*)?$/i.test(prefix);
}

function hasConversationalInvocationNearKeyword(
  text: string,
  position: number,
  _keywordLength: number,
  _keywordText: string,
): boolean {
  if (isWithinQuotedSpan(text, position)) {
    return false;
  }

  const start = Math.max(0, position - INFORMATIONAL_CONTEXT_WINDOW);
  const prefix = stripQuotedSpans(text.slice(start, position));
  const conversationalInvocationPatterns = [
    /\bplease\s+$/i,
    /\blet['’]?s\s+$/i,
    /\bi\s+(?:want|need|would\s+like)\s+(?:a|an)\s+$/i,
    /\b(?:can|could|would|will)\s+you\s+$/i,
  ];

  return conversationalInvocationPatterns.some((pattern) => pattern.test(prefix));
}

function hasExplicitInvocationContext(
  text: string,
  position: number,
  keywordLength: number,
  keywordText: string,
): boolean {
  if (hasDirectInvocationPrefix(text, position)) {
    return true;
  }

  const start = Math.max(0, position - INFORMATIONAL_CONTEXT_WINDOW);
  const end = Math.min(text.length, position + keywordLength + INFORMATIONAL_CONTEXT_WINDOW);
  const context = text.slice(start, end);
  if (hasActivationIntentNearKeyword(context, keywordText)) {
    return true;
  }

  return hasConversationalInvocationNearKeyword(text, position, keywordLength, keywordText);
}

function hasDiagnosticIntentNearKeyword(context: string, keyword: string): boolean {
  const escaped = escapeRegExp(keyword.trim());
  if (!escaped) return false;

  const patterns = [
    new RegExp(`\\b${escaped}\\b[^\\n]{0,48}\\b(?:keeps?\\s+(?:looping|re-?running)|has\\s+(?:a\\s+)?(?:bug|issue|problem|error)|is\\s+(?:stuck|broken|failing)|loop(?:ing)?)\\b`, 'i'),
    new RegExp(`\\b(?:bug|issue|problem|error)\\b[^\\n]{0,16}\\b(?:with|in)\\s+\\b${escaped}\\b`, 'i'),
    new RegExp(`${escaped}.{0,14}(?:자꾸|계속).{0,14}(?:재실행|반복|루프|멈추)`, 'u'),
    // Japanese: repeated-failure complaint — direct mirror of the Korean 자꾸/계속 line above
    // (frequency adverb + problem verb). No P2 subject-particle pattern / no work-request escape: Korean parity.
    new RegExp(`${escaped}[^\\n]{0,16}(?:また|何度も|ずっと|頻繁|繰り返|いつも)[^\\n]{0,16}(?:失敗|エラー|ループ|止ま|落ち|再実行|動かな|フリーズ|壊れ|クラッシュ|こけ|暴走|無限)`, 'u'),
  ];

  return patterns.some((pattern) => pattern.test(context));
}

function hasActionableCommandAfterSeparator(text: string, position: number, keywordLength: number): boolean {
  const suffix = text.slice(position + keywordLength).match(/^\s*[:：]\s*([^\n]{0,80})/u)?.[1] ?? '';
  if (/\?|？|\b(?:what(?:'s|\s+is)|how\s+(?:to|do\s+i)\s+use|explain|describe|tell\s+me\s+about)\b/iu.test(suffix)) {
    return false;
  }
  return /\b(?:fix|debug|investigate|resolve|handle|patch|address|implement|build|create|make|run|start|enable|activate|invoke|trigger|launch)\b|(?:ทำ|ทํา|สร้าง|แก้|เปิด|รัน|เรียก|เริ่ม)/iu.test(suffix);
}

function isInformationalKeywordContext(text: string, position: number, keywordLength: number, keywordText?: string): boolean {
  const start = Math.max(0, position - INFORMATIONAL_CONTEXT_WINDOW);
  const end = Math.min(text.length, position + keywordLength + INFORMATIONAL_CONTEXT_WINDOW);
  const context = text.slice(start, end);
  const hasInformationalIntent = INFORMATIONAL_INTENT_PATTERNS.some((pattern) => pattern.test(context));
  const hasStrongHelpQueryIntent = /\?|？|\b(?:how\s+(?:to|do\s+i)\s+use|what(?:'s|\s+is)|explain|describe|tell\s+me\s+about)\b|(?:사용법|使い方|什么是|怎么用|如何使用)/iu.test(context);
  const lineBounds = getLineBounds(text, position);
  const line = text.slice(lineBounds.start, lineBounds.end);
  const questionOutsideQuotes = stripQuotedSpans(text);
  const keywordInsideQuotes = isWithinQuotedSpan(text, position);
  const hasExecutionDirective = /\b(?:fix|debug|investigate|resolve|handle|patch|address|implement|build)\b/i.test(context);
  const hasCommandSeparatorInvocation =
    hasDirectInvocationPrefix(text, position) && /^\s*[:：]/.test(text.slice(position + keywordLength));
  const hasActionableCommandSeparatorInvocation =
    hasCommandSeparatorInvocation && hasActionableCommandAfterSeparator(text, position, keywordLength);

  // A keyword occurrence inside a quoted span is usually reported/example
  // text, not a command directed at the assistant — e.g. an example sentence
  // like `"use autopilot"` inside a paragraph discussing that exact phrasing.
  // But a quoted keyword paired with a nearby execution directive OR
  // activation verb (e.g. `"ralph" fix the auth bug`, or `run "ralph" on
  // this issue`) is still a genuine request stylistically wrapped in quotes,
  // so the exemption only applies when neither is present — checked before
  // any other activation-intent logic so quoting wins for reported speech
  // but not for real commands.
  //
  // This check is scoped to text immediately OUTSIDE this keyword's own
  // quoted span (±28 chars before/after the span's bounds), not the generic
  // ±80-char context window used elsewhere in this function, and NOT the
  // quote's own interior. Three failure modes this avoids:
  // - Scoping to the wide window: an unrelated genuine command elsewhere in
  //   the same message (e.g. a second keyword issued as a real directive)
  //   could sit inside it and wrongly neutralize the exemption for a keyword
  //   that is purely quoted as an example.
  // - Scoping to (or including) the quote's own interior: a directive or
  //   activation word used INSIDE the quoted text itself — extremely common
  //   in narrated examples and bug reports, e.g. `"please fix autopilot"
  //   they said` or `"...told it to use autopilot..."` — would make the
  //   quote self-report as command-bearing and defeat the exemption for
  //   exactly the reported-speech case it exists to catch.
  // - Checking only execution-directive verbs (fix/debug/...) and not
  //   activation verbs (use/run/start/...): genuine commands stylistically
  //   quoting just the mode name, e.g. `run "ralph" on this issue` or
  //   `use "autopilot" on this task`, would be wrongly suppressed even
  //   though they activated before this exemption existed.
  if (keywordInsideQuotes) {
    const span = findQuotedSpanBounds(text, position);
    const hasGenuineCommandNearQuote = span
      ? /\b(?:fix|debug|investigate|resolve|handle|patch|address|implement|build|use|run|start|enable|activate|invoke|trigger|launch)\b/i.test(
          text.slice(Math.max(0, span.start - 28), span.start) +
            ' ' +
            text.slice(span.end, Math.min(text.length, span.end + 28)),
        )
      : hasExecutionDirective;
    if (!hasGenuineCommandNearQuote) {
      return true;
    }
  }

  if (keywordText) {
    const hasActivationIntent = hasActivationIntentNearKeyword(context, keywordText);
    if (hasActionableCommandSeparatorInvocation) {
      return false;
    }

    // Omitted from this port: OMC's `isAutopilotCreationAlias` branch (autopilot-only).

    // Explicit command + execution intent should remain actionable even if the
    // surrounding message also contains a help question.
    if (hasActivationIntent && hasExecutionDirective) {
      return false;
    }

    // Help-style informational queries must not activate execution modes,
    // even when they contain phrases like "use <keyword>".
    if (hasInformationalIntent && hasStrongHelpQueryIntent) {
      return true;
    }

    if (hasActivationIntent) {
      return false;
    }

    if (hasConversationalInvocationNearKeyword(text, position, keywordLength, keywordText)) {
      return false;
    }

    // Omitted from this port: OMC's `isRalphMetaOrBanterContext` branch (ralph-only).
    if (hasDiagnosticIntentNearKeyword(context, keywordText)) {
      return true;
    }
  }

  if (/^\s*>\s/.test(line) || /^\s*\|(?:[^|\n]*\|){2,}\s*$/.test(line)) {
    return true;
  }

  if (keywordInsideQuotes && QUESTION_FOLLOWUP_PATTERNS.some((pattern) => pattern.test(questionOutsideQuotes))) {
    return true;
  }

  if (looksLikeReferenceContent(text)) {
    return true;
  }

  return hasInformationalIntent;
}


function findActionableRalplanMatch(
  text: string,
  pattern: RegExp,
): { keyword: string; position: number } | null {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const globalPattern = new RegExp(pattern.source, flags);

  for (const match of text.matchAll(globalPattern)) {
    if (match.index === undefined) {
      continue;
    }

    const keyword = match[0];
    if (isInformationalKeywordContext(text, match.index, keyword.length, keyword)) {
      continue;
    }

    if (!hasExplicitInvocationContext(text, match.index, keyword.length, keyword)) {
      continue;
    }

    return {
      keyword,
      position: match.index,
    };
  }

  return null;
}

/**
 * The one entry point: `ralplan` fires only where OMC's detector would fire it.
 * `sanitizeForKeywordDetection` strips the structural noise (code, quotes,
 * tables, paths, XML) and `findActionableRalplanMatch` then demands an explicit
 * invocation context, so a mention, a question or a pasted skill body is quiet.
 */
export function detectRalplanKeyword(
  text: string,
): { keyword: string; position: number } | null {
  return findActionableRalplanMatch(
    sanitizeForKeywordDetection(text),
    RALPLAN_KEYWORD,
  );
}
