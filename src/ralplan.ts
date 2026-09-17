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
