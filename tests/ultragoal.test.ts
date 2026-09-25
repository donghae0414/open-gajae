import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INJECTION_MARKERS } from "../src/ralplan";
import { StateStore } from "../src/state";
import { createTools } from "../src/tools";
import {
  addProgressPattern,
  appendProgressEntry,
  appendProgressNote,
  compactionContext,
  continuationMessage,
  decideUltragoal,
  derivePhase,
  effectivePasses,
  extendedMessage,
  type GoalsFile,
  governingRevision,
  hardLimitMessage,
  initialProgress,
  isRalplanRunning,
  isSubstantive,
  isUltragoalRunning,
  keywordMessage,
  mentionMessage,
  parseGoals,
  pauseMessage,
  progressContext,
  ralplanMentionNotice,
  ralplanRunningNotice,
  restoreMessage,
  seedUltragoalState,
  verificationBrief,
} from "../src/ultragoal";

const T = "2026-09-25T01:02:03.000Z";
const EVIDENCE = "measured with bun test: seven cases fail today";
const REASON = "the brief count was wrong after enumeration";

function goalsFile(criteria = ["a works", "b works"]): GoalsFile {
  return {
    version: 1,
    description: "task",
    created_at: T,
    goals: [
      {
        id: "G001",
        title: "one",
        description: "first",
        priority: 2,
        status: "active",
        acceptanceCriteria: criteria,
        amendments: [],
        passes: false,
        verified: false,
      },
      {
        id: "G002",
        title: "two",
        description: "second",
        priority: 1,
        status: "active",
        acceptanceCriteria: ["c works"],
        amendments: [],
        passes: false,
        verified: false,
      },
    ],
  };
}

const running = (extra: Record<string, unknown> = {}) => ({
  active: true,
  current_phase: "ultragoal",
  iteration: 1,
  max_iterations: 100,
  ...extra,
});

test("the criteria revision binds passes; a direct criteria edit voids it", () => {
  const file = goalsFile();
  const goal = file.goals[0];
  goal.passes = true;
  goal.completionCriteriaRevision = governingRevision(goal);
  expect(effectivePasses(goal)).toBe(true);
  const edited = parseGoals(
    JSON.stringify(file).replace('"a works"', '"a works fast"'),
  );
  expect(edited.kind).toBe("valid");
  if (edited.kind === "valid") expect(effectivePasses(edited.file.goals[0])).toBe(false);
  // Fail closed: an active amended original, no criteria, a bad ID.
  for (const broken of [
    { ...file, goals: [{ ...goal, acceptanceCriteria: [] }] },
    { ...file, goals: [{ ...goal, id: "US-001" }] },
    {
      ...file,
      goals: [
        {
          ...goal,
          amendments: [
            { target: "criterion", kind: "superseded", original: "a works", reason: REASON, evidence: EVIDENCE, authority: "S", timestamp: T },
          ],
        },
      ],
    },
  ])
    expect(parseGoals(JSON.stringify(broken)).kind).toBe("invalid");
});

test("substantive reason and evidence need five words and 32 characters", () => {
  const table: [string, boolean][] = [
    ["one two three four", false],
    ["a b c d e", false],
    ["four words but quite long enough text", true],
    ["alpha beta gamma delta epsilonz", false],
    ["alpha beta gamma delta epsilonzz", true],
  ];
  for (const [value, ok] of table)
    expect(`${value}: ${isSubstantive(value)}`).toBe(`${value}: ${ok}`);
});

test("phases follow the goals file, the request and priority order", () => {
  const file = goalsFile();
  const valid = { kind: "valid" as const, file };
  expect(derivePhase(running(), { kind: "missing" })).toEqual({ kind: "no_prd", case: "fresh" });
  expect(derivePhase(running(), valid)).toEqual({ kind: "no_prd", case: "resumable" });
  expect(derivePhase(running(), { kind: "invalid", error: "x" })).toMatchObject({ kind: "no_prd", case: "invalid" });
  const started = running({ prd_created_at: T });
  expect(derivePhase(started, { kind: "invalid", error: "x" })).toMatchObject({ kind: "invalid" });
  // G002 has the lower priority number, so it comes first.
  expect(derivePhase(started, valid)).toMatchObject({ kind: "implement", goal: { id: "G002" } });
  const g2 = file.goals[1];
  g2.passes = true;
  g2.completionCriteriaRevision = governingRevision(g2);
  expect(derivePhase(started, valid)).toMatchObject({ kind: "verify_goal", goal: { id: "G002" } });
  for (const goal of file.goals) {
    goal.passes = true;
    goal.completionCriteriaRevision = governingRevision(goal);
    goal.verified = true;
    goal.verificationCriteriaRevision = governingRevision(goal);
  }
  expect(derivePhase(started, valid)).toEqual({ kind: "finalize" });
});

test("the continuation decision: limits, extension, hard max, tool-less turns and rejections", () => {
  const opts = { toolCalls: 1, hardMax: 200, countToolLess: true };
  const table: [Record<string, unknown> | undefined, Partial<typeof opts>, unknown][] = [
    [undefined, {}, { kind: "skip" }],
    [running({ awaiting_confirmation: true }), {}, { kind: "skip" }],
    [running({ current_phase: "handoff", active: false }), {}, { kind: "skip" }],
    [running({ paused_reason: "reject_ceiling" }), {}, { kind: "skip" }],
    [running(), {}, { kind: "continue", iteration: 2, max: 100, toolLessTurns: 0 }],
    [running({ iteration: 100 }), {}, { kind: "extend", max: 110, toolLessTurns: 0 }],
    [running({ iteration: 110, max_iterations: 110 }), { hardMax: 110 }, { kind: "hard_limit", hardMax: 110 }],
    [running({ iteration: 200, max_iterations: 200 }), {}, { kind: "hard_limit", hardMax: 200 }],
    [running({ iteration: 200, max_iterations: 200 }), { hardMax: 0 }, { kind: "extend", max: 210, toolLessTurns: 0 }],
    [running({ tool_less_turns: 2 }), { toolCalls: 0 }, { kind: "pause", reason: "no_tool_progress", toolLessTurns: 3 }],
    [running({ tool_less_turns: 2 }), { toolCalls: 0, countToolLess: false }, { kind: "continue", iteration: 2, max: 100, toolLessTurns: 2 }],
    [running({ tool_less_turns: 2 }), { toolCalls: undefined }, { kind: "continue", iteration: 2, max: 100, toolLessTurns: 2 }],
    [running({ reject_counts: { G001: 3 } }), {}, { kind: "pause", reason: "reject_ceiling", target: "G001", toolLessTurns: 0 }],
  ];
  for (const [state, override, expected] of table)
    expect(decideUltragoal(state, { ...opts, ...override })).toEqual(expected as never);
});

test("running predicates treat awaiting seeds and handed-off states as not running", () => {
  expect(isUltragoalRunning(running())).toBe(true);
  expect(isUltragoalRunning(running({ awaiting_confirmation: true }))).toBe(false);
  expect(isUltragoalRunning({ active: false, current_phase: "handoff" })).toBe(false);
  expect(isUltragoalRunning({ active: false, current_phase: "complete" })).toBe(false);
  expect(isRalplanRunning({ active: true })).toBe(true);
  expect(isRalplanRunning({ active: true, awaiting_confirmation: true })).toBe(false);
  expect(seedUltragoalState(running(), T, { awaiting: true })).toBeUndefined();
  expect(seedUltragoalState({ active: false, current_phase: "complete" }, T, { awaiting: true })).toMatchObject({
    active: true,
    awaiting_confirmation: true,
    iteration: 1,
    max_iterations: 100,
    current_phase: "ultragoal",
  });
});

test("progress reinjection carries every pattern, 10 entries of learnings and the last 2 entries", () => {
  let log = initialProgress(T);
  for (let i = 1; i <= 12; i += 1)
    log = appendProgressEntry(
      log,
      { goalId: `G${String(i).padStart(3, "0")}`, implementation: [`did ${i}`], filesChanged: ["x.ts"], learnings: [`learned ${i}`, "shared"] },
      T,
    );
  log = appendProgressNote(log, "HANDOFF", "replan the API", T);
  log = addProgressPattern(log, "use bun test");
  log = addProgressPattern(log, "keep tests minimal");
  const context = progressContext(log);
  expect(context).toContain("- use bun test\n- keep tests minimal");
  expect(context).not.toContain("learned 3\n");
  expect(context).toContain("learned 4");
  expect(context.match(/- shared/g)?.length).toBe(1);
  expect(context).toContain("### G012");
  expect(context).toContain("### HANDOFF");
  expect(context).toContain("- replan the API");
  expect(context).not.toContain("### G011");
  expect(context).not.toContain("What was implemented");
});

test("every ultragoal message is wrapped in a registered injection marker", () => {
  const file = goalsFile();
  const paths = { goals: "g", progress: "p" };
  const request = { request_id: "r", goal_id: "G001", reviewer: "open-gajae-architect" as const, criteria_revision: "x", attempt: 1, created_at: T };
  for (const text of [
    continuationMessage({ iteration: 2, max: 100, phase: { kind: "finalize" }, state: running(), file, paths, progress: undefined }),
    extendedMessage(110),
    hardLimitMessage(200),
    pauseMessage("no_tool_progress"),
    pauseMessage("reject_ceiling", "G001"),
    keywordMessage(),
    mentionMessage(),
    ralplanMentionNotice(),
    ralplanRunningNotice(),
    restoreMessage(running()),
    verificationBrief({ request, file, progress: undefined, state: running() }),
    compactionContext({ state: running(), phase: { kind: "finalize" }, file, paths, progress: undefined }),
  ])
    expect(INJECTION_MARKERS.some((marker) => text.startsWith(marker))).toBe(true);
  expect(
    continuationMessage({ iteration: 2, max: 100, phase: { kind: "finalize" }, state: running(), file, paths, progress: undefined }),
  ).toContain("[ULTRAGOAL - ITERATION 2/100]");
  const brief = verificationBrief({ request, file, progress: undefined, state: running() });
  for (const part of ['request_id "r"', 'goal_id "G001"', "1. a works", "2. b works", "Use a new subagent session for each review.", "verify independently and skeptically"])
    expect(brief).toContain(part);
});

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

async function fixture(run: (h: Harness) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "open-gajae-ultragoal-"));
  try {
    const store = new StateStore(root, async () => Date.parse(T));
    // Child sessions: C (architect/critic) and E (executor-spawned) → parents.
    const parents: Record<string, string | undefined> = { C: "S", C2: "S", G: "E", E: "S", S: undefined };
    const tools = createTools(store, { locationDir: root, projectDir: root }, {
      async parentSession(id) {
        if (!(id in parents)) throw new Error("unknown");
        return parents[id];
      },
    });
    const tool = tools.find((t) => t.name === "ultragoal")!;
    const call = async (args: Record<string, unknown>, agent = "open-gajae", sessionID = "S") =>
      (await tool.execute(tool.input.parse(args) as never, { agent, sessionID, signal: new AbortController().signal })).content;
    await run({ store, call, root, tools });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
type Harness = {
  store: StateStore;
  root: string;
  tools: ReturnType<typeof createTools>;
  call(args: Record<string, unknown>, agent?: string, sessionID?: string): Promise<string>;
};

const createArgs = {
  op: "create",
  description: "add a flag",
  goals: [
    { title: "flag", description: "parse flag", priority: 1, acceptanceCriteria: ["flag parsed", "help text"] },
    { title: "test", description: "test it", priority: 2, acceptanceCriteria: ["test passes"] },
  ],
};
const completeArgs = (goal_id: string) => ({
  op: "complete",
  goal_id,
  implementation: ["did it"],
  files_changed: ["src/x.ts"],
  learnings: ["learned it"],
});

async function start(h: Harness) {
  await h.store.patch("S", seedUltragoalState(undefined, T, { awaiting: false })!, "ultragoal");
  expect(await h.call(createArgs)).toStartWith("Created goals.json with 2 goal(s).");
}

function requestIdOf(text: string) {
  return text.match(/request_id "([0-9a-f-]{36})"/)![1];
}

test("create refuses empty goals and an unfinished file without replace; overwrites a complete one", async () =>
  fixture(async (h) => {
    expect(await h.call(createArgs)).toContain("not running");
    await h.store.patch("S", seedUltragoalState(undefined, T, { awaiting: false })!, "ultragoal");
    expect(await h.call({ ...createArgs, goals: [] })).toStartWith("Error:");
    expect(
      await h.call({ ...createArgs, goals: [{ title: "x", description: "y", priority: 1, acceptanceCriteria: [] }] }),
    ).toStartWith("Error:");
    const { sessionDir } = await h.store.resolveSessionPaths("S");
    await expect(readFile(join(sessionDir, "ultragoal/goals.json"))).rejects.toThrow();
    expect(await h.call(createArgs)).toStartWith("Created");
    expect(await h.call(createArgs)).toContain("already has goals");
    // A new activation over an unfinished file needs resume or replace.
    await h.store.clear("S", "ultragoal");
    await h.store.patch("S", seedUltragoalState(undefined, T, { awaiting: false })!, "ultragoal");
    expect(await h.call(createArgs)).toContain("call resume");
    expect(await h.call({ ...createArgs, replace: true })).toContain("Replaced the previous goals.json (2 goals)");
  }));

test("amendments: substantive rules, ledger, last criterion and last goal", async () =>
  fixture(async (h) => {
    await start(h);
    const table: [Record<string, unknown>, string][] = [
      [{ op: "add", target: "criterion", goal_id: "G001", criterion: "c", reason: "too short", evidence: EVIDENCE }, "substantive"],
      [{ op: "add", target: "criterion", goal_id: "G001", criterion: "c", reason: REASON, evidence: "one two three four" }, "substantive"],
      [{ op: "revise", target: "criterion", goal_id: "G001", original: "nope", replacement: "x", reason: REASON, evidence: EVIDENCE }, "exactly"],
      [{ op: "supersede", target: "criterion", goal_id: "G002", original: "test passes", reason: REASON, evidence: EVIDENCE }, "use revise to replace it, or supersede the goal"],
    ];
    for (const [args, error] of table) {
      const out = await h.call(args);
      expect(out).toStartWith("Error:");
      expect(out).toContain(error);
    }
    expect(await h.call({ op: "revise", target: "criterion", goal_id: "G001", original: "help text", replacement: "help text lists --dry-run", reason: REASON, evidence: EVIDENCE })).toContain("Revised");
    expect(await h.call({ op: "supersede", target: "goal", goal_id: "G002", reason: REASON, evidence: EVIDENCE })).toContain("Superseded G002");
    expect(await h.call({ op: "supersede", target: "goal", goal_id: "G001", reason: REASON, evidence: EVIDENCE })).toContain("last active goal");
    expect(await h.call({ op: "add", target: "goal", title: "docs", description: "document it", priority: 1, acceptanceCriteria: ["readme"], reason: REASON, evidence: EVIDENCE })).toContain("Added G003");
    let status = JSON.parse(await h.call({ op: "status" }));
    // Same priority: ID order. A revised priority reorders.
    expect(status.goals.map((g: { id: string }) => g.id)).toEqual(["G001", "G003"]);
    expect(await h.call({ op: "revise", target: "goal", goal_id: "G001", priority: 5, reason: REASON, evidence: EVIDENCE })).toContain("Revised G001");
    status = JSON.parse(await h.call({ op: "status" }));
    expect(status.goals.map((g: { id: string }) => g.id)).toEqual(["G003", "G001"]);
    const { sessionDir } = await h.store.resolveSessionPaths("S");
    const goals = JSON.parse(await readFile(join(sessionDir, "ultragoal/goals.json"), "utf8"));
    expect(goals.goals[0].amendments[0]).toMatchObject({ kind: "revised", original: "help text", authority: "S" });
  }));

test("complete creates one request; only the leader records a verdict, and reviewers only read", async () =>
  fixture(async (h) => {
    await start(h);
    expect(await h.call({ ...completeArgs("G001"), learnings: [] })).toStartWith("Error:");
    const out = await h.call(completeArgs("G001"));
    expect(out).toContain("Now that this complete result has returned");
    const request_id = requestIdOf(out);
    expect(await h.call(completeArgs("G002"))).toContain("finish the pending G001 verification first");
    const approve = { op: "record_verdict", request_id, goal_id: "G001", verdict: "approve", evidence: "ran the parser and read the help text", issues: [] };
    const before = await h.store.read("S", "ultragoal");
    const refusals: [Record<string, unknown>, string, string][] = [
      [approve, "open-gajae-architect", "C"],
      [approve, "open-gajae-critic", "C"],
      [approve, "open-gajae-executor", "C"],
      [approve, "open-gajae-cleaner", "C"],
      [{ ...approve, request_id: "other" }, "open-gajae", "S"],
      [{ ...approve, goal_id: "G002" }, "open-gajae", "S"],
      [{ ...approve, evidence: "  " }, "open-gajae", "S"],
      [{ ...approve, issues: ["help text missing"] }, "open-gajae", "S"],
      [{ ...approve, verdict: "reject" }, "open-gajae", "S"],
    ].map(([a, agent, s]) => [a as Record<string, unknown>, agent as string, s as string]);
    for (const [args, agent, sessionID] of refusals)
      expect(`${agent}@${sessionID}: ${(await h.call(args, agent, sessionID)).slice(0, 6)}`).toBe(`${agent}@${sessionID}: Error:`);
    expect(await h.store.read("S", "ultragoal")).toEqual(before);
    // Reviewers read the parent's status.
    expect(JSON.parse(await h.call({ op: "status" }, "open-gajae-architect", "C")).pending_request.request_id).toBe(request_id);
    // A criteria change voids the request (④).
    expect(await h.call({ op: "add", target: "criterion", goal_id: "G001", criterion: "exit code 0", reason: REASON, evidence: EVIDENCE })).toContain("withdrawn");
    expect(await h.call(approve)).toStartWith("Error:");
  }));

test("reject reverts, approve verifies, and the final critic completes the run", async () =>
  fixture(async (h) => {
    await start(h);
    const evidence = "checked each criterion";
    let id = requestIdOf(await h.call(completeArgs("G001")));
    expect(await h.call({ op: "record_verdict", request_id: id, goal_id: "G001", verdict: "reject", evidence, issues: ["help text missing"] })).toContain("reject");
    let state = await h.store.read("S", "ultragoal");
    expect(state?.reject_counts).toEqual({ G001: 1 });
    expect(state?.verification_request).toBeUndefined();
    id = requestIdOf(await h.call(completeArgs("G001")));
    expect((await h.store.read("S", "ultragoal"))?.verification_request).toMatchObject({ attempt: 2 });
    await h.call({ op: "record_verdict", request_id: id, goal_id: "G001", verdict: "approve", evidence, issues: [] });
    id = requestIdOf(await h.call(completeArgs("G002")));
    await h.call({ op: "record_verdict", request_id: id, goal_id: "G002", verdict: "approve", evidence, issues: [] });
    const report = { summary: "clean", blocking_issues: [] as string[] };
    const regression = [{ command: "bun test", result: "pass", summary: "all green" }];
    expect(await h.call({ op: "request_final_review", cleaner_report: { summary: "x", blocking_issues: ["dead code"] }, regression })).toContain("blocking issues");
    expect(await h.call({ op: "request_final_review", cleaner_report: report, regression: [{ ...regression[0], result: "fail" }] })).toContain("must pass");
    id = requestIdOf(await h.call({ op: "request_final_review", cleaner_report: report, regression }));
    const final = { op: "record_verdict", request_id: id, goal_id: "final", verdict: "approve", evidence: "whole run reviewed", issues: [] };
    expect(await h.call(final, "open-gajae-critic", "C")).toStartWith("Error:");
    expect(await h.call(final)).toContain("complete");
    state = await h.store.read("S", "ultragoal");
    expect(state).toMatchObject({ active: false, current_phase: "complete" });
    const { sessionDir } = await h.store.resolveSessionPaths("S");
    const goals = JSON.parse(await readFile(join(sessionDir, "ultragoal/goals.json"), "utf8"));
    expect(goals.final_approval.evidence).toBe("whole run reviewed");
    expect(goals.goals[0].verification_evidence).toBe(evidence);
    expect(await readFile(join(sessionDir, "ultragoal/progress.txt"), "utf8")).toContain("## [2");
  }));

test("handoff seeds ralplan, resume needs ralplan finished, cancel keeps the files", async () =>
  fixture(async (h) => {
    await start(h);
    for (const op of ["handoff", "resume", "cancel"])
      expect(await h.call({ op, to: "ralplan", reason: "  " })).toContain("reason is required");
    expect(await h.call({ op: "handoff", to: "ralplan", reason: "replan" })).toContain("Load the `ralplan` skill");
    expect(await h.store.read("S", "ultragoal")).toMatchObject({ active: false, current_phase: "handoff", handoff_to: "ralplan" });
    expect(await h.store.read("S", "ralplan")).toMatchObject({ active: true, current_phase: "ralplan", awaiting_confirmation: false });
    expect(await h.call(completeArgs("G001"))).toContain("not running");
    expect(await h.call({ op: "resume", reason: "back" })).toContain("ralplan planning is running");
    await h.store.patch("S", { active: false, current_phase: "handoff" }, "ralplan");
    expect(await h.call({ op: "resume", reason: "back" })).toContain("Resumed");
    expect(await h.store.read("S", "ultragoal")).toMatchObject({ active: true, current_phase: "ultragoal", awaiting_confirmation: false });
    expect(await h.call({ op: "cancel", reason: "user stop" })).toContain("cancelled");
    expect(await h.store.read("S", "ultragoal")).toBeUndefined();
    const { sessionDir } = await h.store.resolveSessionPaths("S");
    const progress = await readFile(join(sessionDir, "ultragoal/progress.txt"), "utf8");
    for (const part of ["- HANDOFF", "- replan", "- RESUME", "- CANCEL", "- user stop"]) expect(progress).toContain(part);
    // With no state at all, resume re-seeds and keeps the goals.
    expect(await h.call({ op: "resume", reason: "again" })).toContain("G001");
    expect(await h.store.read("S", "ultragoal")).toMatchObject({ active: true, iteration: 1 });
  }));

test("an op and a hook patch in parallel both land", async () =>
  fixture(async (h) => {
    await start(h);
    await Promise.all([
      h.call(completeArgs("G001")),
      h.store.patch("S", { iteration: 7 }, "ultragoal", "ultragoal_hook"),
    ]);
    const state = await h.store.read("S", "ultragoal");
    expect(state?.iteration).toBe(7);
    expect(state?.verification_request).toBeDefined();
  }));

test("state_write refuses to activate ralplan only while ultragoal runs", async () =>
  fixture(async (h) => {
    const stateWrite = h.tools.find((t) => t.name === "state_write")!;
    const write = async () =>
      (await stateWrite.execute(stateWrite.input.parse({ mode: "ralplan", active: true }) as never, { agent: "open-gajae", sessionID: "S", signal: new AbortController().signal })).content;
    await h.store.patch("S", seedUltragoalState(undefined, T, { awaiting: true })!, "ultragoal");
    expect(await write()).not.toStartWith("Error:");
    await h.store.patch("S", { awaiting_confirmation: false }, "ultragoal");
    expect(await write()).toBe(
      'Error: ralplan cannot be activated while ultragoal is running; call ultragoal handoff(to="ralplan", reason) first.',
    );
    // A corrupt goals.json keeps ops failing closed without throwing.
    const { sessionDir } = await h.store.resolveSessionPaths("S");
    await h.call(createArgs);
    await writeFile(join(sessionDir, "ultragoal/goals.json"), "{bad");
    expect(await h.call(completeArgs("G001"))).toContain("replace: true");
  }));

test("start seeds or confirms ultragoal, refuses while ralplan or ultragoal runs, and logs START", async () =>
  fixture(async (h) => {
    expect(await h.call(createArgs)).toContain("call `ultragoal start(reason)` first");
    expect(await h.call({ op: "start", reason: " " })).toContain("reason is required");
    await h.store.patch("S", { active: true, current_phase: "ralplan", awaiting_confirmation: false }, "ralplan");
    expect(await h.call({ op: "start", reason: "run the plan" })).toContain("ralplan planning is running");
    await h.store.clear("S", "ralplan");
    expect(await h.call({ op: "start", reason: "run the plan" })).toContain("Ultragoal started");
    expect(await h.store.read("S", "ultragoal")).toMatchObject({ active: true, awaiting_confirmation: false, current_phase: "ultragoal", iteration: 1 });
    expect(await h.call({ op: "start", reason: "again" })).toContain("already running");
    expect(await h.call(createArgs)).toStartWith("Created");
    // An awaiting keyword seed is confirmed, and a handed-off run restarts.
    await h.store.patch("S", { awaiting_confirmation: true }, "ultragoal");
    expect(await h.call({ op: "start", reason: "confirm" })).toContain("Ultragoal started");
    expect((await h.store.read("S", "ultragoal"))?.awaiting_confirmation).toBe(false);
    const { sessionDir } = await h.store.resolveSessionPaths("S");
    expect(await readFile(join(sessionDir, "ultragoal/progress.txt"), "utf8")).toContain("- START");
  }));
