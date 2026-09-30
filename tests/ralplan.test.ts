import { test, expect } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import * as ralplan from "../src/ralplan";
import {
  breakerMessage,
  compactHookText,
  compactionMessage,
  continuationMessage,
  deepInterviewMessage,
  detectDeepInterviewKeyword,
  detectRalplanKeyword,
  detectUltragoalKeyword,
  keywordMessage,
  mentionMessage,
  RALPLAN_KEYWORD,
  RALPLAN_STOP_BLOCKER_MAX,
  RALPLAN_STOP_BLOCKER_TTL_MS,
  removeCodeBlocks,
  sanitizeForKeywordDetection,
  shouldContinue,
} from "../src/ralplan";
import { INJECTION_MARKERS } from "../src/injection";

const NOW = Date.parse("2026-09-18T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

test("the ralplan keyword matches the three spellings and not a longer word", () => {
  expect(RALPLAN_KEYWORD.test("ralplan 계획 세워줘")).toBe(true);
  expect(RALPLAN_KEYWORD.test("랄플랜 <task>")).toBe(true);
  expect(RALPLAN_KEYWORD.test("ラルプラン")).toBe(true);
  expect(RALPLAN_KEYWORD.test("ralplanner")).toBe(false);
  // The regex carries no `g` flag, so `test` is stateless and repeatable.
  expect(RALPLAN_KEYWORD.test("RALPLAN this")).toBe(true);
  expect(RALPLAN_KEYWORD.test("RALPLAN this")).toBe(true);
  expect(RALPLAN_KEYWORD.test("ralph fix this")).toBe(false);
});

test("ultragoal is detected only on an explicit invocation, and ralph is not ultragoal", () => {
  const table: [string, boolean][] = [
    ["ultragoal add auth", true],
    ["force: ultragoal improve the app", true],
    ["please ultragoal this refactor", true],
    ["what is ultragoal?", false],
    ["`ultragoal` in code", false],
    ["ralph fix this", false],
  ];
  for (const [text, detected] of table)
    expect(`${text}: ${detectUltragoalKeyword(text) !== null}`).toBe(
      `${text}: ${detected}`,
    );
});

test("shouldContinue truth table (AC17)", () => {
  // T (8), `planning_stuck` and `active: false` skip; T and stuck reset.
  for (const phase of ["final", "handoff", "complete", "completed", "failed", "cancelled", "canceled", "inactive"])
    expect(shouldContinue({ active: true, current_phase: phase }, undefined, NOW)).toEqual({ kind: "skip", resetBreaker: true });
  const stuck = { marker: "PLANNING-STUCK", reason: "r" };
  expect(shouldContinue({ active: true, current_phase: "critic", planning_stuck: stuck }, undefined, NOW)).toEqual({ kind: "skip", resetBreaker: true });
  expect(shouldContinue({ active: false, current_phase: "planner" }, undefined, NOW)).toEqual({ kind: "skip" });
  expect(shouldContinue(undefined, undefined, NOW)).toEqual({ kind: "skip" });
  // DR-21: a phase outside the known set is an unreadable state.
  expect(shouldContinue({ active: true, current_phase: "ralplan" }, undefined, NOW)).toEqual({ kind: "skip" });
  for (const phase of ["planner", "intent", "architect", "critic", "disposition", "revision", "post-interview", "adr"])
    expect(shouldContinue({ active: true, current_phase: phase }, undefined, NOW)).toEqual({ kind: "continue", count: 1 });

  // The breaker comes from the continuation file (R-O3).
  const base = { active: true, current_phase: "planner" };
  expect(shouldContinue(base, { breaker_count: 4, breaker_updated_at: iso(-1000) }, NOW)).toEqual({ kind: "continue", count: 5 });
  expect(shouldContinue(base, { breaker_count: RALPLAN_STOP_BLOCKER_MAX, breaker_updated_at: iso(0) }, NOW)).toEqual({ kind: "breaker" });
  // 46 minutes is past the 45-minute TTL, so the count restarts at one.
  expect(shouldContinue(base, { breaker_count: RALPLAN_STOP_BLOCKER_MAX, breaker_updated_at: iso(-46 * 60 * 1000) }, NOW)).toEqual({ kind: "continue", count: 1 });
  expect(RALPLAN_STOP_BLOCKER_TTL_MS).toBe(45 * 60 * 1000);
  expect(RALPLAN_STOP_BLOCKER_MAX).toBe(30);
});

test("the continuation message carries the reinforcement header and no OMC exit", () => {
  const message = continuationMessage(1);
  expect(message).toContain("[RALPLAN - CONSENSUS PLANNING | REINFORCEMENT 1/30]");
  expect(message.startsWith("<ralplan-continuation>")).toBe(true);
  expect(message).not.toContain("/oh-my-claudecode:cancel");
  expect(message).toContain("`ralplan clear`");
  expect(continuationMessage(30)).toContain("REINFORCEMENT 30/30");
});

// Iterating the exported builders means a new, unmarked builder fails here.
const BUILDERS: Record<string, () => string> = {
  continuationMessage: () => continuationMessage(1),
  breakerMessage: () => breakerMessage(),
  keywordMessage: () => keywordMessage(),
  mentionMessage: () => mentionMessage(),
  compactionMessage: () => compactionMessage(["Workflow contract (ralplan): x"]),
  deepInterviewMessage: () =>
    deepInterviewMessage({
      skillPath: "/x/skills/deep-interview/SKILL.md",
      originalPrompt: "딥인터뷰 하고 싶어",
    }),
};

test("every exported message builder emits a marked block", () => {
  const exported = Object.keys(ralplan).filter((name) => name.endsWith("Message"));
  expect(new Set(exported)).toEqual(new Set(Object.keys(BUILDERS)));
  for (const [name, build] of Object.entries(BUILDERS)) {
    const text = build();
    const marker = INJECTION_MARKERS.find((candidate) => text.startsWith(candidate));
    // The builder name rides along so a failure names the offending builder.
    expect(`${name} is unmarked: ${marker === undefined}`).toBe(
      `${name} is unmarked: false`,
    );
    expect(text.endsWith("---\n\n")).toBe(true);
  }
  expect(breakerMessage()).toContain("[RALPLAN CIRCUIT BREAKER]");
  expect(keywordMessage()).toContain("[MODE: RALPLAN]");
  expect(mentionMessage()).toContain("[MODE: RALPLAN]");
  expect(BUILDERS.deepInterviewMessage!()).toContain(
    "[MAGIC KEYWORD: DEEP-INTERVIEW]",
  );
});

test("no awaiting-confirmation timer survives anywhere in src", async () => {
  const dir = new URL("../src/", import.meta.url).pathname;
  const files = (await readdir(dir, { recursive: true })).filter((name) =>
    name.endsWith(".ts"),
  );
  expect(files.length).toBeGreaterThan(0);
  expect(files.some((name) => name.includes("/"))).toBe(true);
  for (const name of files) {
    const source = await readFile(join(dir, name), "utf8");
    for (const banned of [
      "AWAITING_CONFIRMATION_TTL",
      "awaiting_confirmation_since",
      "isAwaitingConfirmation",
    ])
      expect(`${name}:${source.includes(banned)}`).toBe(`${name}:false`);
  }
});

// --- the ported keyword guard ---------------------------------------------
//
// The quiet/fires corpus below is OMC's own, from
// `src/hooks/__tests__/index.test.ts` (ralplan cases at 1828-1858), so a
// divergence from OMC's detector shows up here as a failing case.

const fired = (text: string) => detectRalplanKeyword(text) !== null;

test("a ralplan mention, question or documentation request never fires", () => {
  const quiet = [
    // OMC __tests__/index.test.ts:1828-1835.
    "does ralplan stop after planning?",
    "When does ralplan activate?",
    "Is ralplan a planning mode?",
    "I am asking about the ralplan keyword, not invoking it.",
    "What happens if someone mentions ralplan in a question?",
    "Please document ralplan in the README.",
    // Non-Latin informational phrasings.
    "ralph 와 ralplan 은 뭐야?",
    "ralplan とは？ 使い方を教えて",
  ];
  for (const text of quiet) expect(`${text} → ${fired(text)}`).toBe(`${text} → false`);
});

test("an explicit ralplan invocation fires in every spelling", () => {
  const fires = [
    // OMC __tests__/index.test.ts:1837-1858.
    "ralplan fix issue #2053",
    "please ralplan this issue",
    "let's ralplan the auth redesign",
    "I want a ralplan for this issue",
    "please use ralplan to plan issue #2053",
    "$ralplan fix issue #2053",
    // The Korean and Japanese aliases.
    "랄플랜 <task>",
    "ラルプラン で計画を立てて",
  ];
  for (const text of fires) expect(`${text} → ${fired(text)}`).toBe(`${text} → true`);
});

test("R18 — an expanded deep-interview skill body does not fire", async () => {
  // The bug this guard exists for: OpenCode registers a skill as a slash
  // command and expands SKILL.md into the user message parts, tail included
  // (`opencode/packages/opencode/src/command/index.ts:140-149`). The real file
  // is read so a future edit that adds another `ralplan` sentence is covered.
  const body = await readFile(
    new URL("../skills/deep-interview/SKILL.md", import.meta.url),
    "utf8",
  );
  expect(body).toContain("ralplan");
  const expanded = `${body}\n\nBase directory for this skill: /x/skills/deep-interview\nRelative paths in this skill (e.g., scripts/, references/) are relative to this base directory.`;
  expect(fired(expanded)).toBe(false);
});

test("R18 — a backticked skill name and this plugin's own text are quiet", () => {
  // The only `ralplan` is inside backticks, which `removeCodeBlocks` strips, so
  // an instruction that merely names the skill does not seed.
  expect(
    fired(
      "Load the `ralplan` skill and run its consensus planning workflow for: fix auth",
    ),
  ).toBe(false);

  // Every injected builder, so a re-entering injection can never re-seed even
  // if the marker guard in `src/hooks.ts` were removed.
  for (const [name, build] of Object.entries(BUILDERS))
    expect(`${name} → ${fired(build())}`).toBe(`${name} → false`);
});

test("sanitizeForKeywordDetection removes the structural noise", () => {
  expect(sanitizeForKeywordDetection("run ```ralplan now``` please")).not.toContain(
    "ralplan",
  );
  expect(sanitizeForKeywordDetection("run `ralplan` now")).not.toContain("ralplan");
  expect(sanitizeForKeywordDetection("> ralplan fix this\nok")).not.toContain(
    "ralplan",
  );
  expect(
    sanitizeForKeywordDetection("| mode | note |\n| ralplan | planning |\n"),
  ).not.toContain("ralplan");
  expect(sanitizeForKeywordDetection("look at src/foo/bar.ts today")).not.toContain(
    "src/foo/bar.ts",
  );
  expect(sanitizeForKeywordDetection("<note>ralplan</note> ok")).not.toContain(
    "ralplan",
  );
  // Plain prose survives untouched.
  expect(sanitizeForKeywordDetection("ralplan fix issue #2053")).toContain("ralplan");

  expect(removeCodeBlocks("a `b` c")).toBe("a  c");
  expect(removeCodeBlocks("a\n~~~\nralplan\n~~~\nb")).not.toContain("ralplan");
});

test("the OMC ASCII/Korean asymmetry is ported verbatim", () => {
  // OMC measurement, reproduced here: `MODE_REFERENCE_PATTERN` counts ASCII
  // aliases only, and Korean `정리` is in `REFERENCE_META_PATTERNS`, so
  // `looksLikeReferenceContent` is true for the ASCII spelling and false for
  // the Korean one. Ported verbatim by user decision (plan §6) rather than
  // symmetrized, because the guard is a contract with OMC.
  expect(fired("랄플랜 이거 정리해줘")).toBe(true);
  expect(fired("ralplan 이거 정리해줘")).toBe(false);
});

// --- deep-interview keyword and magic-keyword guide -------------------------
//
// The corpus is OMC's own, from
// `oh-my-claudecode/src/hooks/keyword-detector/__tests__/index.test.ts`
// (deep-interview cases at 2073-2131 and 2212-2215), and every string below was
// cross-checked against OMC's live `detectKeywordsWithType` so a divergence
// shows up here as a failing case.

const interviewed = (text: string) => detectDeepInterviewKeyword(text) !== null;

test("the deep-interview keyword fires on OMC's actionable phrasings", () => {
  const fires = [
    "딥인터뷰", // OMC index.test.ts:2074
    "딥인터뷰 좀 해줘", // OMC index.test.ts:2129
    "ディープインタビュー",
    "ディープインタビューしたい", // OMC index.test.ts:2213
    "please use ouroboros to clarify my requirements", // OMC index.test.ts:2122
    "deep interview 하고 싶어",
    "deep-interview this idea",
  ];
  for (const text of fires)
    expect(`${text} → ${interviewed(text)}`).toBe(`${text} → true`);
});

test("the deep-interview keyword is quiet in OMC's informational and CLI cases", () => {
  const quiet = [
    "딥 인터뷰", // OMC index.test.ts:2080 — spaced, so the regex never matches
    "고객 딥 인터뷰 질문지를 만들어줘", // OMC index.test.ts:2086
    "딥인터뷰 방법 소개해줘", // OMC index.test.ts:397
    // The `ouroboros`/`ooo` CLI skip predicate, OMC index.test.ts:2096-2117.
    'ouroboros auto "Add /healthz endpoint"',
    'ooo auto "Add /healthz endpoint"',
    '/ouroboros:auto "Add /healthz endpoint"',
    "ouroboros run",
    // An instruction whose only `deep-interview` sits inside backticks, which
    // `removeCodeBlocks` strips.
    "Load the `deep-interview` skill and run its Socratic interview for: refactor this",
  ];
  for (const text of quiet)
    expect(`${text} → ${interviewed(text)}`).toBe(`${text} → false`);

  // Every injected builder, so a re-entering injection can never re-fire even
  // if the marker guard in `src/hooks.ts` were removed.
  for (const [name, build] of Object.entries(BUILDERS))
    expect(`${name} → ${interviewed(build())}`).toBe(`${name} → false`);
});

test("the raw deep-interview SKILL.md body fires, and the host never hands it to the prompt hook", async () => {
  // Measured, not assumed: OMC's own detector fires `deep-interview` on this
  // body too (cross-checked with `detectKeywordsWithType`), because the generic
  // guard has no explicit-invocation requirement and the body names the skill
  // in actionable prose. The guard is NOT weakened to hide this. The v2 host
  // runs the `prompt` hook on the typed text only and attaches a mentioned
  // skill's body afterwards (`core/src/session/prompt.ts:40-77`); the host
  // session probe observes one magic notice for an `@deep-interview` mention.
  const body = await readFile(
    new URL("../skills/deep-interview/SKILL.md", import.meta.url),
    "utf8",
  );
  expect(body).toContain("deep-interview");
  expect(interviewed(body)).toBe(true);
});

test("deepInterviewMessage reproduces OMC's magic-keyword guide", () => {
  const message = deepInterviewMessage({
    skillPath: "/x/skills/deep-interview/SKILL.md",
    originalPrompt: "딥인터뷰 하고 싶어",
  });
  expect(message.startsWith("<deep-interview-notice>")).toBe(true);
  expect(message).toContain("[MAGIC KEYWORD: DEEP-INTERVIEW]");
  expect(message).toContain("Skill routing detected: deep-interview");
  // The keyword path always passes no args (OMC keyword-detector.mjs:1793).
  expect(message).toContain("Preferred invocation: @deep-interview\n");
  expect(message).toContain("If the `@deep-interview` mention is unavailable");
  expect(message).toContain(
    "Read fallback: open /x/skills/deep-interview/SKILL.md and follow its SKILL.md instructions.",
  );
  expect(message).not.toContain("Arguments:");
  expect(message).toContain(
    "User request (compact echo; original prompt remains authoritative):\n딥인터뷰 하고 싶어",
  );
  expect(message).toContain(
    "IMPORTANT: Start the deep-interview workflow immediately.",
  );

  // `args` mirrors OMC's `createSkillInvocation` signature even though the hook
  // never supplies one.
  const withArgs = deepInterviewMessage({
    skillPath: "/x/skills/deep-interview/SKILL.md",
    originalPrompt: "x",
    args: "foo",
  });
  expect(withArgs).toContain("Preferred invocation: @deep-interview foo");
  expect(withArgs).toContain("Arguments: foo");
});

test("the echoed prompt is compacted at OMC's 1200-character budget", () => {
  // OMC's notice starts with a newline (`keyword-detector.mjs:91`).
  const truncation =
    "\n...[truncated; original user prompt remains available in the conversation]";
  const long = "딥인터뷰 ".repeat(300).slice(0, 1500);
  expect(long).toHaveLength(1500);
  const echo = compactHookText(long);
  expect(echo.length).toBeLessThanOrEqual(1200);
  expect(echo.endsWith(truncation)).toBe(true);
  expect(
    deepInterviewMessage({ skillPath: "/x/SKILL.md", originalPrompt: long }),
  ).toContain(truncation);

  // Verbatim OMC edge cases (`scripts/keyword-detector.mjs:90-95`).
  expect(compactHookText("")).toBe("");
  expect(compactHookText("", 10)).toBe("");
  expect(compactHookText("short")).toBe("short");
  // A budget no larger than the notice yields a bare prefix of the notice.
  expect(compactHookText("x".repeat(200), 10)).toBe(truncation.slice(0, 10));
});
