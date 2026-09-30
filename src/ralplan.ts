// Ralplan pure logic: injected-message builders and the continuation
// decision. No `fs`, no client, no host imports beyond types.
//
// n6/a3: every message this module builds goes through `wrapInjected`, so it
// carries a marker. The markers and the wrapper live in `./injection.ts`
// (ultragoal revision plan C-12).
//
// Source: oh-my-claudecode v5.4.0 (MIT). `<ralplan-continuation>` is OMC's
// own wrapper; `<ralplan-notice>` is a host addition that wraps the keyword
// and breaker notices OMC emitted bare.
// Plan S3 (gajae-code 5c5231418930673e42cc5d08ebe4376e03187533): the ralplan
// keyword and mention seed nothing (D-F13, R-O6) and the OMC ralplan restore
// notice is gone (R-O11); continuation stops on the gjc terminal set T (C-2)
// from `./ralplan-runtime/manifest.ts`, on `PLANNING-STUCK` and on
// `active: false` (deviation 10), with its breaker counter kept in the
// hook-only `state/ralplan-continuation.json` (R-O3, deviation 26).

import { wrapInjected } from "./injection.js";
import { isKnownPhase, TERMINAL_PHASES } from "./ralplan-runtime/manifest.js";

/** A ralplan state snapshot as read from disk; every field is untrusted. */
export type RalplanStateSnapshot = Record<string, unknown> | null | undefined;

export const RALPLAN_KEYWORD = /\b(ralplan)\b|(랄플랜)|(ラルプラン)/i; // OMC keyword-detector/index.ts:51
export const RALPLAN_STOP_BLOCKER_MAX = 30; // OMC persistent-mode/index.ts:1876
export const RALPLAN_STOP_BLOCKER_TTL_MS = 45 * 60 * 1000; // OMC persistent-mode/index.ts:1877
export const RALPLAN_SKILL_NAME = "ralplan"; // skill/command name the host confirms
/** R16: only the product name; `ralph`/`랄프` do not start ultragoal (D-R16). */
export const ULTRAGOAL_KEYWORD = /\b(ultragoal)\b/i;
export const ULTRAGOAL_SKILL_NAME = "ultragoal";

export const DEEP_INTERVIEW_KEYWORD =
  /\b(deep[\s-]interview|ouroboros)\b|(딥인터뷰)|(ディープインタビュー)/i; // OMC keyword-detector/index.ts:58
/**
 * The upstream Ouroboros CLI invocation form at the start of the prompt.
 * OMC keyword-detector/index.ts:71, used as this keyword's skip predicate (:83-85).
 */
export const OUROBOROS_BRAND_AT_START = /^\s*\/?(?:ouroboros|ooo)\b/i;
export const DEEP_INTERVIEW_SKILL_NAME = "deep-interview";

/** OMC scripts/keyword-detector.mjs:37. */
const SKILL_INVOCATION_USER_REQUEST_MAX = 1200;

// OMC persistent-mode/index.ts:2147-2160, with the final sentence replaced:
// this port exits through `ralplan clear` (plan DR-17), not an OMC command.
export function continuationMessage(count: number): string {
  return wrapInjected(
    "<ralplan-continuation>",
    `[RALPLAN - CONSENSUS PLANNING | REINFORCEMENT ${count}/${RALPLAN_STOP_BLOCKER_MAX}]

The ralplan consensus workflow is active. Continue the Planner/Architect/Critic planning loop only.
Ralplan is read-only/planning mode: do not implement, invoke execution skills, edit source, commit, push, or open PRs from this continuation.
When consensus is reached, stop at a pending-approval handoff and require explicit user approval before execution.
When done, call \`ralplan clear\` to cleanly exit.`,
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

// Host addition for the `@ralplan` mention. OMC also notices an explicit
// invocation (keyword-detector/index.ts:814-830); here the skill body is
// already attached, so the notice says so instead of asking for a skill load.
export function mentionMessage(): string {
  return wrapInjected(
    "<ralplan-notice>",
    "[MODE: RALPLAN] Consensus planning requested through the `@ralplan` mention. The `ralplan` skill is already attached to this message; run its Planner/Architect/Critic workflow for this request.",
  );
}

// Host addition (plan D-H2/AC19): the gjc recovery lines
// (`renderRalplanRecoveryContext`) the `compaction` hook adds while a ralplan
// run is active, as ultragoal adds its `<ultragoal-compaction-context>`.
export function compactionMessage(lines: readonly string[]): string {
  return wrapInjected(
    "<ralplan-compaction-context>",
    `[RALPLAN RUN ACTIVE] Keep this workflow contract in the summary; the durable ralplan state and plan files are authoritative over summary prose.

${lines.join("\n")}`,
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

/** The breaker fields of `state/ralplan-continuation.json` (plan R-O3). */
export type RalplanBreaker = {
  breaker_count?: unknown;
  breaker_updated_at?: unknown;
};

/**
 * Plan AC17: `active: false`, a phase in T (C-2) and `planning_stuck` skip;
 * the last two also reset the breaker. A phase outside the known set is an
 * unreadable state (DR-21) and skips too. `breaker` is the current run's
 * counter, or `undefined` when the file is missing or names another run.
 */
export function shouldContinue(
  state: RalplanStateSnapshot,
  breaker: RalplanBreaker | undefined,
  now: number,
): RalplanDecision {
  if (!state || state.active !== true) return { kind: "skip" };
  const phase = state.current_phase;
  if (!isKnownPhase(phase)) return { kind: "skip" };
  if (TERMINAL_PHASES.has(phase) || state.planning_stuck)
    return { kind: "skip", resetBreaker: true };

  const fresh =
    typeof breaker?.breaker_updated_at === "string" &&
    now - Date.parse(breaker.breaker_updated_at) <= RALPLAN_STOP_BLOCKER_TTL_MS;
  const count = (fresh ? Number(breaker?.breaker_count) || 0 : 0) + 1;
  if (count > RALPLAN_STOP_BLOCKER_MAX) return { kind: "breaker" };
  return { kind: "continue", count };
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


// OMC keyword-detector/index.ts:733-757. The generic guard every keyword except
// `ralplan` uses: only `isInformationalKeywordContext` filters a match, with no
// explicit-invocation requirement on top.
function findActionableKeywordMatch(
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

    return {
      keyword,
      position: match.index,
    };
  }

  return null;
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

/**
 * `ultragoal` uses the same explicit-invocation guard as `ralplan` (plan §6.1).
 */
export function detectUltragoalKeyword(
  text: string,
): { keyword: string; position: number } | null {
  return findActionableRalplanMatch(
    sanitizeForKeywordDetection(text),
    ULTRAGOAL_KEYWORD,
  );
}

/**
 * `deep-interview` fires where OMC's detector would fire it. Unlike `ralplan`
 * this uses OMC's generic guard (`findActionableKeywordMatch`), which only
 * excludes informational context — an explicit invocation context is not
 * required, exactly as in OMC (`keyword-detector/index.ts:853-856`).
 *
 * The `ouroboros`/`ooo` CLI skip is OMC's `KEYWORD_SKIP_PREDICATES` entry
 * (`index.ts:83-85`). Verified against OMC: the predicate is applied to the
 * SANITIZED text, not the raw prompt (`index.ts:848-851` calls it with
 * `cleanedText`), so this port sanitizes first and tests the result.
 */
export function detectDeepInterviewKeyword(
  text: string,
): { keyword: string; position: number } | null {
  const cleaned = sanitizeForKeywordDetection(text);
  if (OUROBOROS_BRAND_AT_START.test(cleaned)) return null;
  return findActionableKeywordMatch(cleaned, DEEP_INTERVIEW_KEYWORD);
}

/** OMC scripts/keyword-detector.mjs:90-95, verbatim. */
export function compactHookText(
  text: string,
  maxChars = SKILL_INVOCATION_USER_REQUEST_MAX,
): string {
  const notice =
    '\n...[truncated; original user prompt remains available in the conversation]';
  if (!text || text.length <= maxChars) return text || '';
  if (maxChars <= notice.length) return notice.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - notice.length).trimEnd()}${notice}`;
}

/**
 * OMC's `createSkillInvocation` body (`scripts/keyword-detector.mjs:1544-1568`)
 * for the `deep-interview` skill, with three host substitutions:
 *
 * - `Preferred invocation: /oh-my-claudecode:deep-interview` → `@deep-interview`,
 *   the mention of the skill `src/config.ts` registers (v2 has no commands, R9).
 * - OMC's `existsSync(skillPath)` branch is dropped. `skillPath` here is computed
 *   from this package's own root, so the "locate skills/<name>/SKILL.md in the
 *   active install" fallback OMC emitted for a missing path has no case to cover.
 * - OMC's ralph-loop notice is omitted: it is `skillName === 'ralph'` only.
 *
 * `args` mirrors OMC's `createSkillInvocation` signature, but the keyword path
 * always passes `''` (OMC `scripts/keyword-detector.mjs:1793` pushes
 * `{ name: 'deep-interview', args: '' }`), so the hook never supplies one.
 */
export function deepInterviewMessage({
  skillPath,
  originalPrompt,
  args = "",
}: {
  skillPath: string;
  originalPrompt: string;
  args?: string;
}): string {
  const argsSection = args ? `\nArguments: ${args}` : "";
  return wrapInjected(
    "<deep-interview-notice>",
    `[MAGIC KEYWORD: ${DEEP_INTERVIEW_SKILL_NAME.toUpperCase()}]

Skill routing detected: ${DEEP_INTERVIEW_SKILL_NAME}
Preferred invocation: @${DEEP_INTERVIEW_SKILL_NAME}${args ? ` ${args}` : ""}
Read fallback: open ${skillPath} and follow its SKILL.md instructions.${argsSection}

User request (compact echo; original prompt remains authoritative):
${compactHookText(originalPrompt)}

IMPORTANT: Start the ${DEEP_INTERVIEW_SKILL_NAME} workflow immediately. If the \`@${DEEP_INTERVIEW_SKILL_NAME}\` mention is unavailable, read the SKILL.md at the fallback path instead of relying on this compact guide.`,
  );
}
