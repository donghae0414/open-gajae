import { test, expect } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import * as ralplan from "../src/ralplan";
import {
  applyRalplanGate,
  breakerMessage,
  continuationMessage,
  EXECUTION_GATE_KEYWORDS,
  gateMessage,
  INJECTION_MARKERS,
  isUnderspecifiedForExecution,
  keywordMessage,
  normalizeRalplanPhase,
  RALPLAN_KEYWORD,
  RALPLAN_STOP_BLOCKER_MAX,
  RALPLAN_STOP_BLOCKER_TTL_MS,
  RALPLAN_TERMINAL_PHASES,
  restoreMessage,
  seedState,
  shouldContinue,
} from "../src/ralplan";

const NOW = Date.parse("2026-09-18T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

test("the ralplan keyword matches the three spellings and not a longer word", () => {
  expect(RALPLAN_KEYWORD.test("ralplan 이거 정리해줘")).toBe(true);
  expect(RALPLAN_KEYWORD.test("랄플랜 <task>")).toBe(true);
  expect(RALPLAN_KEYWORD.test("ラルプラン")).toBe(true);
  expect(RALPLAN_KEYWORD.test("ralplanner")).toBe(false);
  // The regex carries no `g` flag, so `test` is stateless and repeatable.
  expect(RALPLAN_KEYWORD.test("RALPLAN this")).toBe(true);
  expect(RALPLAN_KEYWORD.test("RALPLAN this")).toBe(true);
  expect(RALPLAN_KEYWORD.test("ralph fix this")).toBe(false);
});

test("well-specified execution prompts pass the gate and vague ones do not", () => {
  const passes = [
    "ralph fix the null check in src/hooks/bridge.ts:326",
    "autopilot implement issue #42",
    "ralph fix processKeywordDetector",
    "ralph do:\n1. Add input validation\n2. Write tests",
    "force: ralph refactor the auth module",
  ];
  for (const text of passes) expect(isUnderspecifiedForExecution(text)).toBe(false);

  for (const text of ["fix this", "build the app"])
    expect(isUnderspecifiedForExecution(text)).toBe(true);

  expect(isUnderspecifiedForExecution("   ")).toBe(true);
  expect(isUnderspecifiedForExecution("! ralph refactor the auth module")).toBe(
    false,
  );
});

test("the execution gate is wired but dormant", () => {
  // Spec c6: the keyword set is intentionally empty, so the gate never fires.
  expect(EXECUTION_GATE_KEYWORDS.size).toBe(0);

  // Reachability, per 4a: nothing detected returns at the `length === 0` clause.
  expect(applyRalplanGate([], "fix this")).toEqual({
    keywords: [],
    gateApplied: false,
    gatedKeywords: [],
  });

  // A detected `ralplan` returns at the `includes("ralplan")` clause.
  expect(applyRalplanGate(["ralplan"], "fix this")).toEqual({
    keywords: ["ralplan"],
    gateApplied: false,
    gatedKeywords: [],
  });

  // Anything else falls through the empty execution-keyword filter.
  expect(applyRalplanGate(["ralph"], "fix this").gateApplied).toBe(false);
  expect(applyRalplanGate(["cancel"], "fix this").gateApplied).toBe(false);
});

test("phase normalization collapses every handoff variant", () => {
  expect(normalizeRalplanPhase({ current_phase: "handoff:ralph" })).toBe("handoff");
  expect(normalizeRalplanPhase({ current_phase: "Handoff-Team" })).toBe("handoff");
  expect(normalizeRalplanPhase({ current_phase: "HANDOFF" })).toBe("handoff");
  expect(normalizeRalplanPhase({ phase: "  Completed  " })).toBe("completed");
  expect(normalizeRalplanPhase({ status: "pending approval" })).toBe(
    "pending approval",
  );
  // `current_phase ?? phase ?? status`, in that order.
  expect(
    normalizeRalplanPhase({ current_phase: "ralplan", phase: "completed" }),
  ).toBe("ralplan");
  expect(normalizeRalplanPhase(null)).toBeNull();
  expect(normalizeRalplanPhase(undefined)).toBeNull();
  expect(normalizeRalplanPhase({})).toBeNull();
  expect(normalizeRalplanPhase({ current_phase: 7 })).toBeNull();
  expect(normalizeRalplanPhase({ current_phase: "   " })).toBeNull();
});

test("the terminal phase set names the resting states", () => {
  for (const phase of ["completed", "handoff", "pending approval"])
    expect(RALPLAN_TERMINAL_PHASES.has(phase)).toBe(true);
  expect(RALPLAN_TERMINAL_PHASES.has("ralplan")).toBe(false);
});

test("shouldContinue truth table", () => {
  const base = { active: true, current_phase: "ralplan" };

  expect(shouldContinue({ ...base, awaiting_confirmation: false }, NOW)).toEqual({
    kind: "continue",
    count: 1,
  });
  expect(shouldContinue(base, NOW)).toEqual({ kind: "continue", count: 1 });

  // `awaiting_confirmation` is a plain boolean: no clock, no TTL, no fallback.
  expect(shouldContinue({ ...base, awaiting_confirmation: true }, NOW)).toEqual({
    kind: "skip",
  });
  for (const stamp of [
    "started_at",
    "restored_at",
    "breaker_updated_at",
    "completed_at",
  ])
    expect(
      shouldContinue(
        { ...base, awaiting_confirmation: true, [stamp]: iso(-10 * 60 * 1000) },
        NOW,
      ),
    ).toEqual({ kind: "skip" });

  expect(shouldContinue({ active: true, current_phase: "completed" }, NOW)).toEqual(
    { kind: "skip", resetBreaker: true },
  );
  expect(
    shouldContinue({ active: true, current_phase: "handoff:ralph" }, NOW),
  ).toEqual({ kind: "skip", resetBreaker: true });

  expect(shouldContinue({ active: false, current_phase: "ralplan" }, NOW)).toEqual({
    kind: "skip",
  });
  expect(shouldContinue(null, NOW)).toEqual({ kind: "skip" });
  expect(shouldContinue(undefined, NOW)).toEqual({ kind: "skip" });

  expect(
    shouldContinue(
      { ...base, breaker_count: RALPLAN_STOP_BLOCKER_MAX, breaker_updated_at: iso(0) },
      NOW,
    ),
  ).toEqual({ kind: "breaker" });

  // 46 minutes is past the 45-minute TTL, so the count restarts at one.
  expect(
    shouldContinue(
      {
        ...base,
        breaker_count: RALPLAN_STOP_BLOCKER_MAX,
        breaker_updated_at: iso(-46 * 60 * 1000),
      },
      NOW,
    ),
  ).toEqual({ kind: "continue", count: 1 });
  expect(RALPLAN_STOP_BLOCKER_TTL_MS).toBe(45 * 60 * 1000);
  expect(RALPLAN_STOP_BLOCKER_MAX).toBe(30);

  // A fresh, non-exhausted count advances by one.
  expect(
    shouldContinue({ ...base, breaker_count: 4, breaker_updated_at: iso(-1000) }, NOW),
  ).toEqual({ kind: "continue", count: 5 });
});

test("the continuation message carries the reinforcement header and no OMC exit", () => {
  const message = continuationMessage(1);
  expect(message).toContain("[RALPLAN - CONSENSUS PLANNING | REINFORCEMENT 1/30]");
  expect(message.startsWith("<ralplan-continuation>")).toBe(true);
  expect(message).not.toContain("/oh-my-claudecode:cancel");
  expect(message).toContain('state_clear(mode="ralplan")');
  expect(continuationMessage(30)).toContain("REINFORCEMENT 30/30");
});

// Iterating the exported builders means a new, unmarked builder fails here.
const BUILDERS: Record<string, () => string> = {
  continuationMessage: () => continuationMessage(1),
  breakerMessage: () => breakerMessage(),
  keywordMessage: () => keywordMessage(),
  restoreMessage: () => restoreMessage({ active: true, started_at: iso(0) }),
  gateMessage: () => gateMessage(["ralph"]),
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
  expect(restoreMessage({ active: true })).toContain("[RALPLAN MODE RESTORED]");
  expect(gateMessage(["ralph", "team"])).toContain("Redirecting ralph, team");
});

test("restoreMessage reports the stored origin, phase and confirmation status", () => {
  const restored = restoreMessage({
    started_at: "2026-09-18T09:00:00.000Z",
    current_phase: "handoff:ralph",
    awaiting_confirmation: true,
  });
  expect(restored).toContain("2026-09-18T09:00:00.000Z");
  expect(restored).toContain("Current phase: handoff");
  expect(restored).toContain("Status: awaiting skill confirmation");
  const bare = restoreMessage({ active: true });
  expect(bare).toContain("an earlier turn");
  expect(bare).toContain("Current phase: ralplan");
  expect(bare).toContain("Status: active");
});

test("seedState activates once and never re-seeds an active state", () => {
  const now = iso(0);
  expect(seedState(undefined, now)).toEqual({
    active: true,
    current_phase: "ralplan",
    started_at: now,
    awaiting_confirmation: true,
    restored_at: now,
    breaker_count: 0,
  });
  // n2: equal timestamps mean the turn after seeding cannot read as a resume.
  const patch = seedState(null, now);
  expect(patch?.started_at).toBe(patch?.restored_at);
  expect(seedState({ active: true }, now)).toBeUndefined();
  expect(seedState({ active: false }, now)).toBeDefined();
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
