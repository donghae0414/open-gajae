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
  // Keyword → awaiting seed + notice; the `skill` call confirms it; the
  // `succeeded` that follows re-enters through a synthetic resume.
  const s = await host.createSession({ agent: "open-gajae" });
  const since = Date.now();
  await host.prompt(
    s,
    `ralplan the cache layer\n${directive({
      tag: "kw",
      clearAfter: 2,
      steps: [
        { tool: "state_read", args: { mode: "ralplan" } },
        { tool: "skill", args: { id: "ralplan" } },
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
  const seeded = parse(thread.find((e) => e.step === 1 && e.kind === "directive")?.toolResults.at(-1))?.state;
  report.check(
    "keyword: seed is active and awaiting the skill call",
    seeded?.active === true && seeded?.awaiting_confirmation === true,
    seeded,
  );
  const skillResult = thread.find((e) => e.step === 2 && e.kind === "directive")?.toolResults.at(-1) ?? "";
  report.check(
    "keyword: skill({ id: \"ralplan\" }) loads the skill",
    !/"error"|Invalid arguments/.test(skillResult) && skillResult.includes("ralplan"),
    skillResult.slice(0, 300),
  );
  const [c1, c2] = [1, 2].map((n) => continuations(host, "kw").find((e) => e.count === n && e.step === 0));
  report.check(
    "continuation re-enters after a synthetic resume on succeeded (1/30, then 2/30)",
    !!c1 && !!c2 && c1.system === first?.system,
    { c1: !!c1, c2: !!c2, sameAgent: c1?.system === first?.system },
  );
  const types = host.sessionEvents(s, since).map((e) => e.type);
  report.check(
    "continuation: each succeeded is followed by a new execution until state_clear",
    types.filter((t) => t === "session.execution.started").length >= 3 &&
      !continuations(host, "kw").some((e) => (e.count ?? 0) > 2),
    types,
  );
  report.check("continuation: ralplan state cleared by state_clear", host.ralplanState(s) === undefined, host.ralplanState(s));
}

async function ralplanMention(report: Report, host: Host) {
  const s = await host.createSession({ agent: "open-gajae" });
  await host.prompt(
    s,
    `@ralplan plan the cache layer\n${directive({ tag: "mention", steps: [{ tool: "state_read", args: { mode: "ralplan" } }] })}`,
    mention("ralplan"),
  );
  await waitFor("mention continuation", () => continuations(host, "mention").some((e) => e.step >= 1), 60_000);
  await host.settle(s);
  const thread = host.provider.thread("mention");
  const first = thread.find((e) => e.kind === "directive" && e.step === 0);
  const seeded = parse(thread.find((e) => e.kind === "directive" && e.step === 1)?.toolResults.at(-1))?.state;
  report.check(
    "@ralplan mention: host attached the ralplan skill",
    (first?.messages ?? []).some((m) => m.text.includes('<skill_content name="ralplan"')),
  );
  report.check(
    "@ralplan mention: seed is confirmed (active, not awaiting) with exactly one mention notice",
    seeded?.active === true &&
      seeded?.awaiting_confirmation === false &&
      occurrences(first, RALPLAN_NOTICE) === 1 &&
      (first?.messages ?? []).some((m) => m.text.includes("through the `@ralplan` mention")),
    { seeded, notices: occurrences(first, RALPLAN_NOTICE) },
  );
  report.check("@ralplan mention: continuation runs without a skill call", continuations(host, "mention").length >= 1);
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
        { tool: "state_read", args: { mode: "ralplan" } },
        {
          tool: "state_write",
          args: {
            mode: "ralplan",
            active: true,
            current_phase: "ralplan",
            awaiting_confirmation: false,
            started_at: new Date().toISOString(),
            restored_at: new Date().toISOString(),
          },
        },
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
  const written = parse(thread.find((e) => e.kind === "directive" && e.step === 4)?.toolResults.at(-1))?.state;
  report.check(
    "bridge: ralplan entry write confirmed (active, not awaiting) and continuation follows",
    written?.active === true && written?.awaiting_confirmation === false && continuations(host, "bridge").length >= 1,
    written,
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
    `@ralplan plan the queue\n${directive({ tag: "int", steps: [background("int-child", 6_000), { sleep: 30_000, text: "parent-late" }] })}`,
    mention("ralplan"),
  );
  await waitFor("int step 1 in flight", () => host.provider.thread("int").find((e) => e.step === 1), 30_000);
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
  await host.prompt(s, `@ralplan plan the cache\n${directive({ tag: "q5", steps: [background("q5-child", 6_000)] })}`, mention("ralplan"));
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
// Plan Step 6 probes ①–⑦. Prompts carry a file path so the execution gate
// (decision 3) lets `@ultragoal` through.

const UG_GOAL = { title: "flag", description: "parse the flag", priority: 1, acceptanceCriteria: ["flag parsed"] };
const ug = (args: Record<string, unknown>) => ({ tool: "ultragoal", args });
const lastUserText = (entry: ProviderEntry | undefined) =>
  [...(entry?.messages ?? [])].reverse().find((m) => m.role === "user")?.text ?? "";
const resultOf = (host: Host, tag: string, step: number) =>
  host.provider.thread(tag).find((e) => e.kind === "directive" && e.step === step)?.toolResults.at(-1) ?? "";

async function ultragoalNoPrd(report: Report, host: Host) {
  // ② `@ultragoal` seeds confirmed; the first continuation asks for `create`.
  const s = await host.createSession({ agent: "open-gajae" });
  await host.prompt(s, `@ultragoal add a --dry-run flag to scripts/x.ts\n${directive({ tag: "ug-noprd", steps: [] })}`, mention("ultragoal"));
  await waitFor("ug-noprd continuation", () => continuations(host, "ug-noprd").some((e) => e.step >= 1), 60_000);
  await host.settle(s);
  const text = lastUserText(continuations(host, "ug-noprd")[0]);
  report.check(
    "② @ultragoal: no_prd continuation (ITERATION 2/100) asks for create",
    text.includes("[ULTRAGOAL - ITERATION 2/100]") && text.includes("op `create`"),
    text.slice(0, 600),
  );
  report.check("② @ultragoal: cancel removed the state", host.ultragoalState(s) === undefined, host.ultragoalState(s));
}

async function ultragoalVerification(report: Report, host: Host) {
  // ③ create → complete → a new architect child: its first message carries the
  // plugin brief; the child cannot record (status only) and returns its
  // verdict; the leader records it with record_verdict (decision P-5).
  const s = await host.createSession({ agent: "open-gajae" });
  const verdict = {
    op: "record_verdict",
    request_id: "{{request_id}}",
    goal_id: "G001",
    verdict: "approve",
    evidence: "checked the parser against flag parsed",
    issues: [],
  };
  await host.prompt(
    s,
    `@ultragoal add a flag to scripts/x.ts\n${directive({
      tag: "ug-verify",
      steps: [
        ug({ op: "create", description: "probe task", goals: [UG_GOAL] }),
        ug({ op: "complete", goal_id: "G001", implementation: ["parsed it"], files_changed: ["sample.ts"], learnings: ["none"] }),
        {
          tool: "subagent",
          args: {
            agent: "open-gajae-architect",
            description: "verify G001",
            prompt: `Verify G001.\n${directive({
              tag: "ug-arch",
              steps: [ug(verdict), { text: "VERDICT: approve\nEVIDENCE: checked the parser\nISSUES: none" }],
            })}`,
          },
        },
        ug(verdict),
      ],
    })}`,
    mention("ultragoal"),
  );
  await waitFor("ug-verify continuation", () => continuations(host, "ug-verify").some((e) => e.step >= 1), 90_000);
  await host.settle(s);
  const child = host.provider.thread("ug-arch").find((e) => e.step === 0);
  const brief = lastUserText(child);
  report.check(
    "③ brief: the architect child's first message carries <ultragoal-verification-brief>, the request_id and the VERDICT format",
    brief.includes("Verify G001.") &&
      brief.includes("<ultragoal-verification-brief>") &&
      /request_id "[0-9a-f-]{36}"/.test(brief) &&
      brief.includes("VERDICT: approve | reject"),
    brief.slice(0, 400),
  );
  const refused = host.provider.thread("ug-arch").find((e) => e.step === 1)?.toolResults.at(-1) ?? "";
  report.check("③ the architect child cannot record a verdict (status only)", refused.includes("may only use status"), refused);
  report.check(
    "③ the leader's record_verdict approves G001",
    resultOf(host, "ug-verify", 4).includes("Verdict recorded: approve for G001"),
    resultOf(host, "ug-verify", 4),
  );
  const goals = parse(host.sessionFile(s, "ultragoal/goals.json"));
  report.check("③ goals.json: G001 verified", goals?.goals?.[0]?.verified === true, goals?.goals?.[0]);
  const next = lastUserText(continuations(host, "ug-verify")[0]);
  report.check("③ the next continuation moves to the cleaner pass", next.includes("open-gajae-cleaner"), next.slice(0, 600));
}

async function ultragoalStartWithoutGate(report: Report, host: Host) {
  // P-6/P-8: a vague ultragoal request starts ultragoal (no gate), and start
  // brings a handed-off run back up.
  const s = await host.createSession({ agent: "open-gajae" });
  await host.prompt(
    s,
    `ultragoal로 계획대로 진행\n${directive({
      tag: "ug-start",
      steps: [
        { tool: "skill", args: { id: "ultragoal" } },
        ug({ op: "handoff", to: "ralplan", reason: "probe" }),
        { tool: "state_write", args: { mode: "ralplan", active: false, current_phase: "complete" } },
        ug({ op: "start", reason: "probe restart" }),
      ],
    })}`,
  );
  await waitFor("ug-start continuation", () => continuations(host, "ug-start").some((e) => e.step >= 1), 90_000);
  await host.settle(s);
  const first = host.provider.thread("ug-start").find((e) => e.kind === "directive" && e.step === 0);
  report.check(
    "P-8: a vague ultragoal prompt gets the ultragoal notice and no ralplan gate",
    occurrences(first, "[MODE: ULTRAGOAL]") === 1 && occurrences(first, "[RALPLAN GATE]") === 0,
    { ultragoal: occurrences(first, "[MODE: ULTRAGOAL]"), gate: occurrences(first, "[RALPLAN GATE]") },
  );
  report.check("P-6: start brings a handed-off run back up", resultOf(host, "ug-start", 4).includes("Ultragoal started"), resultOf(host, "ug-start", 4));
}

async function ultragoalIdleAndCompaction(report: Report, host: Host) {
  // ① tool.called reaches subscribers; ④ three tool-less turns pause the loop
  // (only if the plugin receives tool.called); ⑤ compaction carries context.
  const s = await host.createSession({ agent: "open-gajae" });
  await host.prompt(
    s,
    `@ultragoal add a flag to scripts/x.ts\n${directive({ tag: "ug-idle", clearAfter: 10, steps: [ug({ op: "status" })] })}`,
    mention("ultragoal"),
  );
  const paused = await waitFor(
    "ug-idle paused or cancelled",
    () => {
      const state = host.ultragoalState(s);
      return state?.paused_reason ?? (continuations(host, "ug-idle").some((e) => (e.count ?? 0) >= 10) ? "none" : undefined);
    },
    120_000,
  ).catch(() => undefined);
  await host.settle(s);
  report.check(
    "① session.tool.called is published with the session ID",
    host.sessionEvents(s).some((e) => e.type === "session.tool.called"),
    [...new Set(host.sessionEvents(s).map((e) => e.type))],
  );
  const iterations = continuations(host, "ug-idle").map((e) => e.count);
  report.check("④ three tool-less turns pause the loop (no_tool_progress)", paused === "no_tool_progress", { paused, iterations });
  if (paused === "no_tool_progress") {
    const since = Date.now();
    const response = await host.api("POST", `/api/session/${s}/compact`, {});
    const compaction = await waitFor(
      "compaction request",
      () =>
        host.provider
          .entries()
          .filter((e) => e.t >= since)
          .find((e) => JSON.stringify(e.body?.messages ?? []).includes("ultragoal-compaction-context")),
      60_000,
    ).catch(() => undefined);
    report.check("⑤ the compaction request carries <ultragoal-compaction-context>", !!compaction, { status: response.status });
    await host.settle(s);
  }
  await host.turn(s, `stop\n${directive({ tag: "ug-idle-stop", steps: [ug({ op: "cancel", reason: "probe done" })] })}`);
  await host.settle(s);
}

async function ultragoalHandoff(report: Report, host: Host) {
  // ⑥ chain guard → handoff → ralplan → Execute via ultragoal → resume.
  const s = await host.createSession({ agent: "open-gajae" });
  await host.prompt(
    s,
    `@ultragoal add a flag to scripts/x.ts\n${directive({
      tag: "ug-handoff",
      steps: [
        ug({ op: "create", description: "probe task", goals: [UG_GOAL] }),
        { tool: "skill", args: { id: "ralplan" } },
        ug({ op: "handoff", to: "ralplan", reason: "user asked to replan" }),
        { tool: "skill", args: { id: "ralplan" } },
        { tool: "state_write", args: { mode: "ralplan", active: false, current_phase: "handoff", plan_path: "plan.md" } },
        { tool: "skill", args: { id: "ultragoal" } },
        ug({ op: "resume", reason: "plan approved" }),
        ug({ op: "status" }),
      ],
    })}`,
    mention("ultragoal"),
  );
  await waitFor("ug-handoff continuation", () => continuations(host, "ug-handoff").some((e) => e.step >= 1), 90_000);
  await host.settle(s);
  report.check(
    "⑥ skill ralplan is refused while ultragoal runs, naming handoff",
    // The refusal arrives JSON-encoded inside the tool result.
    resultOf(host, "ug-handoff", 2).includes("ultragoal is running in this session; call ultragoal handoff(") &&
      resultOf(host, "ug-handoff", 2).includes("before loading ralplan"),
    resultOf(host, "ug-handoff", 2).slice(0, 300),
  );
  report.check("⑥ handoff activates ralplan", resultOf(host, "ug-handoff", 3).includes("Handed off to ralplan"), resultOf(host, "ug-handoff", 3));
  report.check(
    "⑥ skill ralplan loads after the handoff",
    !/"error"|Invalid arguments/.test(resultOf(host, "ug-handoff", 4)) && resultOf(host, "ug-handoff", 4).includes('<skill_content name="ralplan">'),
    resultOf(host, "ug-handoff", 4).slice(0, 300),
  );
  report.check("⑥ resume keeps G001", resultOf(host, "ug-handoff", 7).includes("Resumed") && resultOf(host, "ug-handoff", 7).includes("G001"), resultOf(host, "ug-handoff", 7));
  report.check("⑥ the ralplan handoff is consumed", host.ralplanState(s)?.current_phase === "handoff-consumed", host.ralplanState(s));
  const progress = host.sessionFile(s, "ultragoal/progress.txt") ?? "";
  report.check("⑥ progress records HANDOFF and RESUME with reasons", ["- HANDOFF", "user asked to replan", "- RESUME", "plan approved"].every((p) => progress.includes(p)), progress.slice(-600));
}

async function ultragoalBackgroundShell(report: Report, host: Host) {
  // ⑦ observation: a background shell's completion notice and the loop.
  const s = await host.createSession({ agent: "open-gajae" });
  const since = Date.now();
  await host.prompt(
    s,
    `@ultragoal add a flag to scripts/x.ts\n${directive({
      tag: "ug-bg",
      clearAfter: 3,
      steps: [
        ug({ op: "create", description: "probe task", goals: [UG_GOAL] }),
        { tool: "shell", args: { command: "sleep 4; echo bg-done", background: true, description: "background probe" } },
      ],
    })}`,
    mention("ultragoal"),
  );
  await waitFor("ug-bg cancelled", () => host.ultragoalState(s) === undefined && continuations(host, "ug-bg").length > 0, 90_000).catch(() => undefined);
  await host.settle(s, 6_000);
  const iterations = continuations(host, "ug-bg").filter((e) => e.step === 0).map((e) => e.count);
  const notified = host.provider.thread("ug-bg").some((e) => e.messages.some((m) => m.text.includes("bg-done")));
  const starts = host.sessionEvents(s, since).filter((e) => e.type === "session.execution.started").length;
  report.check(
    "⑦ background shell: no duplicate continuation iteration and the loop ended",
    new Set(iterations).size === iterations.length && host.ultragoalState(s) === undefined,
    { iterations, notified, starts },
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
      ultragoalNoPrd,
      ultragoalVerification,
      ultragoalStartWithoutGate,
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
