// v2 host session probe (plan Step 8): prompt-hook entry paths, the
// deep-interview → ralplan bridge's `skill` call, and continuation on durable
// execution events, driven through the installed 2.0.15 host with the
// deterministic fake provider from `host-harness.ts`.
// Run: `bun ./tests/host-session-probe.ts`.
import { join } from "node:path";
import {
  directive,
  REPO,
  runProbe,
  sleep,
  waitFor,
  withHost,
  type Host,
  type ProviderEntry,
  type Report,
} from "./host-harness";
import { ULTRAGOAL_RED_TEAM_FRAGMENT } from "../src/ultragoal-runtime/messages";

const RALPLAN_NOTICE = "[MODE: RALPLAN]";
const MAGIC_NOTICE = "[MAGIC KEYWORD: DEEP-INTERVIEW]";
const mention = (id: string) => ({
  skills: [{ id, mention: { start: 0, end: id.length + 1, text: `@${id}` } }],
});
const occurrences = (entry: ProviderEntry | undefined, needle: string) =>
  (entry?.messages ?? []).reduce((n, m) => n + m.text.split(needle).length - 1, 0);
const parse = (text: string | undefined): any => {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return undefined;
  }
};
const continuations = (host: Host, tag: string) =>
  host.provider.thread(tag).filter((e) => e.kind === "continuation");

async function keywordEntry(report: Report, host: Host) {
  // Keyword → notice only (D-F13); `ralplan start` is the entry; the
  // `succeeded` that follows re-enters through a synthetic resume.
  const s = await host.createSession({ agent: "open-gajae" });
  const since = Date.now();
  await host.prompt(
    s,
    `ralplan the cache layer\n${directive({
      tag: "kw",
      clearAfter: 2,
      steps: [
        { tool: "ralplan", args: { op: "status" } },
        { tool: "skill", args: { id: "ralplan" } },
        { tool: "ralplan", args: { op: "start", task: "the cache layer" } },
      ],
    })}`,
  );
  await waitFor("kw cleared", () => continuations(host, "kw").some((e) => e.count === 2 && e.step >= 1), 90_000);
  await host.settle(s);
  const thread = host.provider.thread("kw");
  const first = thread.find((e) => e.kind === "directive" && e.step === 0);
  const notice = first?.messages.findIndex((m) => m.text.includes(RALPLAN_NOTICE)) ?? -1;
  const user = first?.messages.findIndex((m) => m.text.includes('"tag":"kw"')) ?? -1;
  report.check(
    `keyword: ralplan notice in the same turn (position: ${notice < user ? "before" : "after"} the user message)`,
    notice >= 0 && user >= 0 && occurrences(first, RALPLAN_NOTICE) === 1,
    { notice, user },
  );
  const status = parse(thread.find((e) => e.step === 1 && e.kind === "directive")?.toolResults.at(-1));
  report.check(
    "keyword: notice only, no ralplan state seeded",
    status?.skill === "ralplan" && !!status.state && Object.keys(status.state).length === 0,
    status,
  );
  const skillResult = thread.find((e) => e.step === 2 && e.kind === "directive")?.toolResults.at(-1) ?? "";
  report.check(
    "keyword: skill({ id: \"ralplan\" }) loads the skill",
    !/"error"|Invalid arguments/.test(skillResult) && skillResult.includes("ralplan"),
    skillResult.slice(0, 300),
  );
  const started = parse(thread.find((e) => e.step === 3 && e.kind === "directive")?.toolResults.at(-1));
  report.check("keyword: ralplan start starts the run", started?.ok === true && started?.run_id === s, started);
  const [c1, c2] = [1, 2].map((n) => continuations(host, "kw").find((e) => e.count === n && e.step === 0));
  report.check(
    "continuation re-enters after a synthetic resume on succeeded (1/30, then 2/30)",
    !!c1 && !!c2 && c1.system === first?.system,
    { c1: !!c1, c2: !!c2, sameAgent: c1?.system === first?.system },
  );
  const types = host.sessionEvents(s, since).map((e) => e.type);
  report.check(
    "continuation: each succeeded is followed by a new execution until ralplan clear",
    types.filter((t) => t === "session.execution.started").length >= 3 &&
      !continuations(host, "kw").some((e) => (e.count ?? 0) > 2),
    types,
  );
  // DR-6: clear keeps the state file as {active: false, current_phase: "complete"}.
  const cleared = host.ralplanState(s);
  report.check(
    "continuation: ralplan clear leaves {active: false, current_phase: \"complete\"}",
    cleared?.active === false && cleared?.current_phase === "complete",
    cleared,
  );
}

async function ralplanMention(report: Report, host: Host) {
  const s = await host.createSession({ agent: "open-gajae" });
  await host.prompt(
    s,
    `@ralplan plan the cache layer\n${directive({
      tag: "mention",
      steps: [
        { tool: "ralplan", args: { op: "status" } },
        { tool: "ralplan", args: { op: "start", task: "plan the cache layer" } },
      ],
    })}`,
    mention("ralplan"),
  );
  await waitFor("mention continuation", () => continuations(host, "mention").some((e) => e.step >= 1), 60_000);
  await host.settle(s);
  const thread = host.provider.thread("mention");
  const first = thread.find((e) => e.kind === "directive" && e.step === 0);
  const status = parse(thread.find((e) => e.kind === "directive" && e.step === 1)?.toolResults.at(-1));
  report.check(
    "@ralplan mention: host attached the ralplan skill",
    (first?.messages ?? []).some((m) => m.text.includes('<skill_content name="ralplan"')),
  );
  report.check(
    "@ralplan mention: notice only (no ralplan state seeded) with exactly one mention notice",
    status?.skill === "ralplan" &&
      !!status.state &&
      Object.keys(status.state).length === 0 &&
      occurrences(first, RALPLAN_NOTICE) === 1 &&
      (first?.messages ?? []).some((m) => m.text.includes("through the `@ralplan` mention")),
    { status, notices: occurrences(first, RALPLAN_NOTICE) },
  );
  report.check("@ralplan mention: continuation runs after ralplan start, without a skill call", continuations(host, "mention").length >= 1);
}

async function deepInterviewEntries(report: Report, host: Host) {
  const s = await host.createSession({ agent: "open-gajae" });
  await host.turn(s, `@deep-interview build a todo app\n${directive({ tag: "di-mention", steps: [] })}`, mention("deep-interview"));
  const first = host.provider.thread("di-mention")[0];
  report.check(
    "@deep-interview mention: exactly one magic notice (Q8)",
    occurrences(first, MAGIC_NOTICE) === 1,
    occurrences(first, MAGIC_NOTICE),
  );
  report.check("@deep-interview mention: no ralplan state", host.ralplanState(s) === undefined);

  const k = await host.createSession({ agent: "open-gajae" });
  await host.turn(k, `deep-interview a todo app\n${directive({ tag: "di-keyword", steps: [] })}`);
  const keyword = host.provider.thread("di-keyword")[0];
  report.check("deep-interview keyword: exactly one magic notice", occurrences(keyword, MAGIC_NOTICE) === 1, occurrences(keyword, MAGIC_NOTICE));
}

async function bridge(report: Report, host: Host) {
  // The fake provider plays the model after the "Refine with ralplan" choice.
  // A real model's choice of the `skill` input field (Q2 wording) is only
  // observable with a real model: manual checklist item 1.
  const s = await host.createSession({ agent: "open-gajae" });
  const since = Date.now();
  await host.prompt(
    s,
    `@deep-interview build a todo app\n${directive({
      tag: "bridge",
      steps: [
        {
          tool: "question",
          args: {
            questions: [
              {
                question: "The spec is ready. What next?",
                header: "Next",
                options: [
                  { label: "Refine with ralplan consensus", description: "plan it" },
                  { label: "Finish", description: "stop" },
                ],
              },
            ],
          },
        },
        { tool: "skill", args: { id: "ralplan" } },
        { tool: "ralplan", args: { op: "start", task: "build a todo app" } },
        { tool: "ralplan", args: { op: "status" } },
      ],
    })}`,
    mention("deep-interview"),
  );
  const form = await waitFor(
    "bridge question form",
    async () => (await host.list(`/api/session/${s}/form`))[0],
    30_000,
  );
  await host.api("POST", `/api/session/${s}/form/${form.id}/reply`, { answer: { q0: "Refine with ralplan consensus" } });
  await waitFor("bridge continuation", () => continuations(host, "bridge").some((e) => e.step >= 1), 60_000);
  await host.settle(s);
  const thread = host.provider.thread("bridge");
  const skillCalls = thread
    .flatMap((e) => e.body.messages)
    .filter((m: any) => m.role === "assistant")
    .flatMap((m: any) => m.tool_calls ?? [])
    .filter((call: any) => call.function?.name === "skill");
  const uniqueSkillCalls = new Set(skillCalls.map((call: any) => call.id)).size;
  const skillResult = thread.find((e) => e.kind === "directive" && e.step === 2)?.toolResults.at(-1) ?? "";
  report.check(
    "bridge: one skill({ id: \"ralplan\" }) call, accepted on the first attempt",
    uniqueSkillCalls === 1 && !/"error"|Invalid arguments/.test(skillResult) && skillResult.includes("ralplan"),
    { uniqueSkillCalls, skillResult: skillResult.slice(0, 300) },
  );
  const started = parse(thread.find((e) => e.kind === "directive" && e.step === 4)?.toolResults.at(-1))?.state;
  report.check(
    "bridge: ralplan start activates the run (active, planner) and continuation follows",
    started?.active === true && started?.current_phase === "planner" && continuations(host, "bridge").length >= 1,
    started,
  );
  report.check(
    "bridge: the answered question ended in succeeded, not interrupted",
    !host.sessionEvents(s, since).some((e) => e.type === "session.execution.interrupted"),
  );
}

const background = (tag: string, ms: number) => ({
  tool: "subagent",
  args: {
    agent: "open-gajae-explore",
    description: "background probe",
    background: true,
    prompt: directive({ tag, steps: [{ sleep: ms, text: "child-done" }] }),
  },
});

async function interruptDuringBackground(report: Report, host: Host) {
  const s = await host.createSession({ agent: "open-gajae" });
  const since = Date.now();
  await host.prompt(
    s,
    `@ralplan plan the queue\n${directive({
      tag: "int",
      steps: [
        { tool: "ralplan", args: { op: "start", task: "plan the queue" } },
        background("int-child", 6_000),
        { sleep: 30_000, text: "parent-late" },
      ],
    })}`,
    mention("ralplan"),
  );
  await waitFor("int step 2 in flight", () => host.provider.thread("int").find((e) => e.step === 2), 30_000);
  const interrupt = await host.api("POST", `/api/session/${s}/interrupt?resume=true`);
  await waitFor(
    "host resumes the parent after the child completes",
    () => host.provider.thread("int").find((e) => e.kind === "other" && e.messages.at(-1)?.text.includes("<subagent")),
    40_000,
  ).catch(() => undefined);
  await host.settle(s, 5_000);
  const events = host.sessionEvents(s, since);
  const interrupted = events.find((e) => e.type === "session.execution.interrupted");
  report.check("interrupt: session.execution.interrupted with reason user", interrupted?.data?.reason === "user", {
    interrupt: interrupt.json,
    interrupted: interrupted?.data,
  });
  const resumed = host.provider.thread("int").some((e) => e.kind === "other" && e.messages.at(-1)?.text.includes("<subagent"));
  const laterSucceeded = events.some((e) => e.type === "session.execution.succeeded" && e.t > (interrupted?.t ?? Infinity));
  report.check("interrupt: the background child's completion resumed the parent (later succeeded)", resumed && laterSucceeded, {
    resumed,
    laterSucceeded,
  });
  report.check("interrupt: no continuation after the user interrupt", continuations(host, "int").length === 0, continuations(host, "int").length);
  report.check("interrupt: ralplan state left active", host.ralplanState(s)?.active === true, host.ralplanState(s));

  // The next real user prompt lifts the mark.
  await host.prompt(s, `go on\n${directive({ tag: "int-next", steps: [] })}`);
  await waitFor("continuation after the next real prompt", () => continuations(host, "int-next").some((e) => e.step >= 1), 60_000).catch(
    () => undefined,
  );
  await host.settle(s);
  report.check("interrupt: the next real prompt re-enables continuation", continuations(host, "int-next").length >= 1);
}

async function backgroundChildPending(report: Report, host: Host) {
  // Q5: skip while the parent has a running child; the host's completion
  // resume produces a later succeeded, which continues.
  const s = await host.createSession({ agent: "open-gajae" });
  const since = Date.now();
  await host.prompt(
    s,
    `@ralplan plan the cache\n${directive({
      tag: "q5",
      steps: [{ tool: "ralplan", args: { op: "start", task: "plan the cache" } }, background("q5-child", 6_000)],
    })}`,
    mention("ralplan"),
  );
  await waitFor("q5 continuation", () => continuations(host, "q5").some((e) => e.step >= 1), 60_000).catch(() => undefined);
  await host.settle(s);
  const thread = host.provider.thread("q5");
  const resume = thread.find((e) => e.kind === "other" && e.messages.at(-1)?.text.includes("<subagent"));
  const first = continuations(host, "q5")[0];
  const succeeded = host.sessionEvents(s, since).filter((e) => e.type === "session.execution.succeeded");
  report.check(
    "Q5: parent succeeded while the child ran, and no continuation before the completion resume",
    succeeded.length >= 2 && !!resume && !!first && first.t > resume.t,
    { succeeded: succeeded.length, resume: resume?.t, continuation: first?.t },
  );
}

// ---------------------------------------------------------------- ultragoal
// Ultragoal revision plan S3 3e probes ①–⑦ and P-6/P-8: the gjc ops, their
// text results and the goal loop. Every run loads `skill ultragoal` first, as
// the skill's entry (D-HE4).

const UG_GOAL = { title: "flag", description: "parse the flag", acceptanceCriteria: ["flag parsed"] };
const ug = (args: Record<string, unknown>) => ({ tool: "ultragoal", args });
const goalOp = (op: string) => ({ tool: "goal", args: { op } });
const loadUltragoal = { tool: "skill", args: { id: "ultragoal" } };
const ULTRAGOAL_NOTICE = "[MODE: ULTRAGOAL]";
/** The goal's fixed objective (PQ-12 A) over the session folder's real paths. */
const FIXED_OBJECTIVE =
  /Complete the durable ultragoal plan in \.open-gajae\/_session-[^/\s]+\/ultragoal\/goals\.json, including later accepted\/appended goals, under the original description constraints; use \.open-gajae\/_session-[^/\s]+\/ultragoal\/ledger\.jsonl as the audit trail\./;
const EVIDENCE = "probe evidence: the flag parser accepts the fixture";
/** A clean final gate for the one-goal plan (plan C-8). */
const FINAL_GATE = {
  targetedVerification: { status: "passed", commands: ["bun test probe"], evidence: EVIDENCE },
  architectReview: {
    architectureStatus: "CLEAR",
    productStatus: "CLEAR",
    codeStatus: "CLEAR",
    recommendation: "APPROVE",
    evidence: EVIDENCE,
    blockers: [],
  },
  criteriaCoverage: [{ criterionId: "G001.AC1", status: "verified", evidence: EVIDENCE }],
  reviewCohort: {
    reviewGeneration: 1,
    joined: true,
    lanes: {
      cleaner: { status: "PASS", evidence: EVIDENCE, blockers: [] },
      architect: { status: "CLEAR", evidence: EVIDENCE, blockers: [] },
      qa: {
        status: "passed",
        commands: ["bun test probe"],
        adversarialCases: ["the flag given twice -> refused"],
        evidence: EVIDENCE,
        blockers: [],
      },
    },
  },
  criticReview: { verdict: "OKAY", evidence: EVIDENCE, blockers: [] },
};
const lastUserText = (entry: ProviderEntry | undefined) =>
  [...(entry?.messages ?? [])].reverse().find((m) => m.role === "user")?.text ?? "";
const resultOf = (host: Host, tag: string, step: number) =>
  host.provider.thread(tag).find((e) => e.kind === "directive" && e.step === step)?.toolResults.at(-1) ?? "";
/** The request's user messages that start with a plugin marker. */
const marked = (entry: ProviderEntry | undefined, marker: string) =>
  (entry?.messages ?? []).filter((m) => m.role === "user" && m.text.startsWith(marker));

async function ultragoalEntry(report: Report, host: Host) {
  // ② `@ultragoal` is a notice only; `skill ultragoal` seeds the goal-planning
  // row; `create` prints its text lines and arms the goal, whose first
  // continuation carries the fixed objective.
  const s = await host.createSession({ agent: "open-gajae" });
  await host.turn(s, `@ultragoal add a --dry-run flag to scripts/x.ts\n${directive({ tag: "ug-entry", steps: [] })}`, mention("ultragoal"));
  await host.settle(s);
  const first = host.provider.thread("ug-entry")[0];
  report.check(
    "② @ultragoal: one mention notice and no ultragoal state or row",
    occurrences(first, ULTRAGOAL_NOTICE) === 1 &&
      host.ultragoalState(s) === undefined &&
      host.sessionFile(s, "state/active/ultragoal.json") === undefined,
    { notices: occurrences(first, ULTRAGOAL_NOTICE), state: host.ultragoalState(s) },
  );

  await host.turn(s, `load the skill\n${directive({ tag: "ug-entry-load", steps: [loadUltragoal] })}`);
  await host.settle(s);
  const row = parse(host.sessionFile(s, "state/active/ultragoal.json"));
  const seeded = host.ultragoalState(s);
  report.check(
    "② skill ultragoal: an active goal-planning row and state",
    row?.active === true &&
      row?.phase === "goal-planning" &&
      seeded?.active === true &&
      seeded?.current_phase === "goal-planning",
    { row, state: seeded },
  );

  await host.prompt(
    s,
    `record the goals\n${directive({ tag: "ug-entry-create", steps: [ug({ op: "create", description: "probe task", goals: [UG_GOAL] })] })}`,
  );
  await waitFor("ug-entry-create goal dropped", () => continuations(host, "ug-entry-create").some((e) => e.step >= 2), 60_000);
  await host.settle(s);
  const created = resultOf(host, "ug-entry-create", 1);
  report.check(
    "② create: `Created ultragoal plan with 1 goal at …goals.json.` and the goal armed with the fixed objective",
    /^Created ultragoal plan with 1 goal at \S+\/ultragoal\/goals\.json\.\nGoal armed: /.test(created) && FIXED_OBJECTIVE.test(created),
    created,
  );
  const continuation = marked(continuations(host, "ug-entry-create")[0], "<goal-continuation>")[0]?.text ?? "";
  report.check(
    "② the first <goal-continuation> carries the fixed objective",
    continuation.includes("Continue work on the active goal.") && FIXED_OBJECTIVE.test(continuation),
    continuation.slice(0, 800),
  );
  const ultragoal = host.ultragoalState(s);
  report.check(
    "② ultragoal clear and goal drop end the loop",
    ultragoal?.active === false &&
      ultragoal?.current_phase === "complete" &&
      host.goalState(s)?.status === "dropped" &&
      continuations(host, "ug-entry-create").every((e) => e.count === 1),
    { ultragoal, goal: host.goalState(s), counts: continuations(host, "ug-entry-create").map((e) => e.count) },
  );
}

async function ultragoalFinalGate(report: Report, host: Host) {
  // ③ the `[ultragoal-red-team]` executor child gets the fragment;
  // `validate_gate` lists every defect; the final checkpoint and
  // `goal complete` close the run, and no continuation follows.
  const s = await host.createSession({ agent: "open-gajae" });
  await host.prompt(
    s,
    `ultragoal add a flag to scripts/x.ts\n${directive({
      tag: "ug-final",
      steps: [
        loadUltragoal,
        ug({ op: "create", description: "probe task", goals: [UG_GOAL] }),
        ug({ op: "next" }),
        {
          tool: "subagent",
          args: {
            agent: "open-gajae-executor",
            description: "red-team G001",
            prompt: `[ultragoal-red-team] Try to break the flag parser.\n${directive({ tag: "ug-qa", steps: [{ text: "status: passed" }] })}`,
          },
        },
        ug({ op: "validate_gate", goal_id: "G001", gate: { targetedVerification: { status: "passed" } } }),
        ug({
          op: "checkpoint",
          goal_id: "G001",
          status: "complete",
          evidence: EVIDENCE,
          gate: FINAL_GATE,
          implementation: ["parsed the flag"],
          files_changed: ["sample.ts"],
          learnings: ["the probe fixture is enough"],
        }),
        goalOp("complete"),
      ],
    })}`,
  );
  await waitFor("ug-final done", () => host.provider.thread("ug-final").some((e) => e.kind === "directive" && e.step >= 7), 90_000);
  await host.settle(s);
  const child = lastUserText(host.provider.thread("ug-qa").find((e) => e.step === 0));
  report.check(
    "③ the [ultragoal-red-team] executor child's first message carries the red-team fragment",
    child.includes("[ultragoal-red-team] Try to break the flag parser.") && child.includes(ULTRAGOAL_RED_TEAM_FRAGMENT),
    child.slice(-800),
  );
  const diagnostics = resultOf(host, "ug-final", 5);
  report.check(
    "③ validate_gate prints the quality-gate defect list",
    /^\d+ quality-gate error\(s\):$/m.test(diagnostics) && /^ {2}\S+ \[\w+\]: /m.test(diagnostics),
    diagnostics.slice(0, 600),
  );
  const checkpoint = resultOf(host, "ug-final", 6);
  report.check(
    "③ the final checkpoint completes G001 and the run",
    checkpoint.startsWith("Checkpointed G001 as complete.\nAll ultragoal goals are complete.") && !checkpoint.includes("Run not complete"),
    checkpoint,
  );
  const completed = resultOf(host, "ug-final", 7);
  report.check(
    "③ goal complete closes the goal",
    completed.endsWith("Status: complete") && host.goalState(s)?.status === "complete",
    { completed, goal: host.goalState(s) },
  );
  report.check("③ no goal continuation after goal complete", continuations(host, "ug-final").length === 0, continuations(host, "ug-final").length);
}

async function ultragoalVagueRequest(report: Report, host: Host) {
  // P-6/P-8: a vague ultragoal request gets the ultragoal notice only (no
  // state, no row, no loop) and no ralplan gate notice.
  const s = await host.createSession({ agent: "open-gajae" });
  await host.turn(s, `ultragoal로 계획대로 진행\n${directive({ tag: "ug-vague", steps: [] })}`);
  await host.settle(s);
  const first = host.provider.thread("ug-vague").find((e) => e.kind === "directive" && e.step === 0);
  report.check(
    "P-8: a vague ultragoal prompt gets the ultragoal notice and no ralplan gate",
    occurrences(first, ULTRAGOAL_NOTICE) === 1 && occurrences(first, "[RALPLAN GATE]") === 0,
    { ultragoal: occurrences(first, ULTRAGOAL_NOTICE), gate: occurrences(first, "[RALPLAN GATE]") },
  );
  report.check(
    "P-6: the notice seeds no ultragoal state, row or goal",
    host.ultragoalState(s) === undefined &&
      host.sessionFile(s, "state/active/ultragoal.json") === undefined &&
      host.goalState(s) === undefined &&
      continuations(host, "ug-vague").length === 0,
    { state: host.ultragoalState(s), goal: host.goalState(s) },
  );
}

async function ultragoalIdleAndCompaction(report: Report, host: Host) {
  // ① tool.called reaches subscribers; ④ three tool-less turns hold the goal
  // continuation (only if the plugin receives tool.called); ⑤ compaction
  // carries the ultragoal context, and the first request after it gets the
  // goal context again: the hook enqueues it once more (plan E-3). That
  // request is the host's own step for the pending hold notice, or the next
  // prompt.
  const s = await host.createSession({ agent: "open-gajae" });
  await host.prompt(
    s,
    `ultragoal add a flag to scripts/x.ts\n${directive({
      tag: "ug-idle",
      clearAfter: 10,
      steps: [loadUltragoal, ug({ op: "create", description: "probe task", goals: [UG_GOAL] })],
    })}`,
  );
  const held = await waitFor(
    "ug-idle held or cleared",
    () => {
      const record = parse(host.sessionFile(s, "state/goal-continuation.json"));
      return record?.held?.reason ?? (continuations(host, "ug-idle").some((e) => (e.count ?? 0) >= 10) ? "none" : undefined);
    },
    120_000,
  ).catch(() => undefined);
  await host.settle(s);
  report.check(
    "① session.tool.called is published with the session ID",
    host.sessionEvents(s).some((e) => e.type === "session.tool.called"),
    [...new Set(host.sessionEvents(s).map((e) => e.type))],
  );
  const counts = continuations(host, "ug-idle").map((e) => e.count ?? 0);
  report.check(
    "④ three tool-less turns hold the goal continuation (no_tool_progress) after three continuations",
    held === "no_tool_progress" && Math.max(0, ...counts) === 3,
    { held, counts },
  );
  const contextAdded = (since: number) =>
    host
      .sessionEvents(s, since)
      .filter((e) => e.type === "session.inbox.enqueued" && JSON.stringify(e.data ?? {}).includes("open-gajae: goal context added")).length;
  const injectedBefore = contextAdded(0);
  const compactedAt = Date.now();
  if (held === "no_tool_progress") {
    const since = compactedAt;
    const response = await host.api("POST", `/api/session/${s}/compact`, {});
    const compaction = await waitFor(
      "compaction request",
      () =>
        host.provider
          .entries()
          .filter((e) => e.t >= since)
          .find((e) => JSON.stringify(e.body?.messages ?? []).includes("<ultragoal-compaction-context>")),
      60_000,
    ).catch(() => undefined);
    report.check("⑤ the compaction request carries <ultragoal-compaction-context>", !!compaction, { status: response.status });
    await host.settle(s);
  }
  await host.prompt(s, `stop\n${directive({ tag: "ug-idle-stop", steps: [ug({ op: "clear" }), goalOp("drop")] })}`);
  await waitFor("ug-idle-stop done", () => host.provider.thread("ug-idle-stop").some((e) => e.step >= 2), 60_000).catch(() => undefined);
  await host.settle(s);
  const next = host.provider.thread("ug-idle-stop").find((e) => e.kind === "directive" && e.step === 0);
  const compacted = !(next?.messages ?? []).some((m) => m.role === "assistant" && m.text.startsWith("continuing "));
  const holdNotices = marked(next, "<goal-notice>").map((m) => m.text);
  report.check(
    "④ the hold posts one <goal-notice> with its cause and \"Send a message to continue\"",
    holdNotices.length === 1 &&
      holdNotices[0]!.includes("Cause: no tool calls in the last 3 continuation turns.") &&
      holdNotices[0]!.includes("Send a message to continue"),
    holdNotices,
  );
  const reinjected = contextAdded(compactedAt);
  report.check(
    "⑤ the goal context is added once, and once again on the first request after the compaction",
    injectedBefore === 1 && compacted && reinjected === 1 && marked(next, "<goal-context>").length === 1,
    { injectedBefore, compacted, reinjected, goalContexts: marked(next, "<goal-context>").length },
  );
}

async function ultragoalHandoff(report: Report, host: Host) {
  // ⑥ chain guard → ultragoal handoff(ralplan) → ralplan write on the
  // handed-over run without `start`, ending in final → `skill ultragoal` in
  // the same execution hands ralplan back (PQ-21 A) → create overwrites.
  const s = await host.createSession({ agent: "open-gajae" });
  const replanned = { title: "flag and alias", description: "parse the flag and its alias", acceptanceCriteria: ["flag and alias parsed"] };
  await host.prompt(
    s,
    `ultragoal add a flag to scripts/x.ts\n${directive({
      tag: "ug-handoff",
      steps: [
        loadUltragoal,
        ug({ op: "create", description: "probe task", goals: [UG_GOAL] }),
        { tool: "skill", args: { id: "ralplan" } },
        ug({ op: "handoff", to: "ralplan", reason: "user asked to replan" }),
        { tool: "skill", args: { id: "ralplan" } },
        { tool: "ralplan", args: { op: "write", stage: "final", stage_n: 1, content: "# Final plan\n\nParse the flag and its alias.\n" } },
        loadUltragoal,
        ug({ op: "create", description: "replanned task", goals: [replanned] }),
      ],
    })}`,
  );
  await waitFor("ug-handoff continuation", () => continuations(host, "ug-handoff").some((e) => e.step >= 2), 90_000);
  await host.settle(s);
  const refusal = resultOf(host, "ug-handoff", 3);
  report.check(
    "⑥ skill ralplan is refused while ultragoal is the primary skill, naming ultragoal handoff",
    // The refusal arrives JSON-encoded inside the tool result.
    refusal.includes("refusing to chain from") && refusal.includes("Run ultragoal handoff(to:"),
    refusal.slice(0, 300),
  );
  const receipt = parse(resultOf(host, "ug-handoff", 4));
  report.check(
    "⑥ ultragoal handoff hands over to ralplan in planner",
    receipt?.ok === true && receipt?.from === "ultragoal" && receipt?.to === "ralplan" && receipt?.phases?.to === "planner",
    resultOf(host, "ug-handoff", 4),
  );
  report.check(
    "⑥ skill ralplan loads after the handoff",
    !/"error"|Invalid arguments/.test(resultOf(host, "ug-handoff", 5)) && resultOf(host, "ug-handoff", 5).includes('<skill_content name="ralplan">'),
    resultOf(host, "ug-handoff", 5).slice(0, 300),
  );
  const written = resultOf(host, "ug-handoff", 6);
  report.check(
    "⑥ ralplan write final on the handed-over run (no start) records the plan for approval",
    written.includes("pending-approval.md") && !written.includes('"error"'),
    written.slice(0, 600),
  );
  report.check(
    "⑥ skill ultragoal loads in the same execution",
    !/"error"|Invalid arguments/.test(resultOf(host, "ug-handoff", 7)) && resultOf(host, "ug-handoff", 7).includes('<skill_content name="ultragoal">'),
    resultOf(host, "ug-handoff", 7).slice(0, 300),
  );
  // PQ-6 A: the hook hands off through the shared journaled handoff; the
  // ralplan row it leaves inactive is removed once `create` activates the
  // ultragoal row (AC3), so the audit shows the handoff.
  const ralplan = host.ralplanState(s);
  const handoff = (host.sessionFile(s, "state/audit.jsonl") ?? "")
    .split("\n")
    .map(parse)
    .find(
      (row) =>
        row?.skill === "ralplan" &&
        row?.verb === "handoff" &&
        row?.owner === "open-gajae-hook" &&
        row?.from_phase === "final" &&
        row?.to_phase === "handoff",
    );
  report.check(
    "⑥ the same-execution load handed ralplan off through the shared handoff (inactive, phase handoff)",
    ralplan?.active === false && ralplan?.current_phase === "handoff" && ralplan?.handoff_to === "ultragoal" && !!handoff,
    { ralplan, handoff },
  );
  const created = resultOf(host, "ug-handoff", 8);
  const goals = parse(host.sessionFile(s, "ultragoal/goals.json"));
  const plans = (host.sessionFile(s, "ultragoal/ledger.jsonl") ?? "")
    .split("\n")
    .filter((line) => parse(line)?.event === "plan_created").length;
  report.check(
    "⑥ create overwrites goals.json and keeps the open goal",
    created.startsWith("Created ultragoal plan with 1 goal at ") &&
      created.includes("Goal armed: the open ultragoal goal") &&
      goals?.description === "replanned task" &&
      goals?.goals?.length === 1 &&
      goals?.goals?.[0]?.title === "flag and alias" &&
      plans === 2,
    { created, goals, plans },
  );
  const progress = host.sessionFile(s, "ultragoal/progress.txt") ?? "";
  report.check("⑥ progress records the HANDOFF with its reason", progress.includes("HANDOFF") && progress.includes("to ralplan: user asked to replan"), progress.slice(-600));
}

async function ultragoalBackgroundShell(report: Report, host: Host) {
  // ⑦ observation: a background shell's completion notice and the loop, which
  // the auto-responder ends with ultragoal clear and goal drop.
  const s = await host.createSession({ agent: "open-gajae" });
  const since = Date.now();
  await host.prompt(
    s,
    `ultragoal add a flag to scripts/x.ts\n${directive({
      tag: "ug-bg",
      clearAfter: 3,
      steps: [
        loadUltragoal,
        ug({ op: "create", description: "probe task", goals: [UG_GOAL] }),
        { tool: "shell", args: { command: "sleep 4; echo bg-done", background: true, description: "background probe" } },
      ],
    })}`,
  );
  await waitFor("ug-bg goal dropped", () => host.goalState(s)?.status === "dropped", 90_000).catch(() => undefined);
  await host.settle(s, 6_000);
  const iterations = continuations(host, "ug-bg").filter((e) => e.step === 0).map((e) => e.count);
  const notified = host.provider.thread("ug-bg").some((e) => e.messages.some((m) => m.text.includes("bg-done")));
  const starts = host.sessionEvents(s, since).filter((e) => e.type === "session.execution.started").length;
  const ultragoal = host.ultragoalState(s);
  report.check(
    "⑦ background shell: no duplicate continuation, and ultragoal clear and goal drop ended the loop",
    new Set(iterations).size === iterations.length &&
      ultragoal?.active === false &&
      ultragoal?.current_phase === "complete" &&
      host.goalState(s)?.status === "dropped",
    { iterations, notified, starts, ultragoal, goal: host.goalState(s) },
  );
  console.log(`     ⑦ observation: iterations=${JSON.stringify(iterations)} completion-notice-seen=${notified} executions=${starts}`);
}

await runProbe("open-gajae-host-session-probe", async (report, scratch) => {
  await withHost(report, join(scratch, "host"), { plugins: [REPO] }, async (host) => {
    // Plugin setup runs on the first prompt in a location (Phase 0 P5).
    await host.turn(await host.createSession({ agent: "open-gajae" }), directive({ tag: "warmup", steps: [] }));
    await sleep(500);
    for (const scenario of [
      keywordEntry,
      ralplanMention,
      deepInterviewEntries,
      bridge,
      interruptDuringBackground,
      backgroundChildPending,
      ultragoalEntry,
      ultragoalFinalGate,
      ultragoalVagueRequest,
      ultragoalIdleAndCompaction,
      ultragoalHandoff,
      ultragoalBackgroundShell,
    ]) {
      try {
        await scenario(report, host);
      } catch (error) {
        report.check(`${scenario.name} ran to completion`, false, String(error));
      }
    }
  });
});
