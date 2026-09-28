// v2 ralplan stage-trail probe (plan S5, AC25) on the installed 2.0.15 host,
// driven by the deterministic fake provider from `host-harness.ts`. One
// primary turn walks the gjc role trail through `subagent`:
//   1. ralplan start → a planner child writes `planner` 1 with a ≥64 KiB
//      `content` and returns only the plain receipt → the stage file keeps
//      every byte (tool-output truncation, `core/src/tool-output.ts:13-14`,
//      bounds results, not inputs), the parent sees the receipt, and
//      `planner_subagent_id` is the child (R-7)
//   2. pass-1 architect and critic `subagent` calls in one assistant message,
//      which the host runs in parallel (`core/src/session/runner/step.ts:117-128`)
//      → both writes land: ledger rows, stage files, `architect_id` and
//      `critic_id`; every `index.jsonl` line parses (R-5, R-OD3)
//   3. subagent(open-gajae-planner, sessionID: <the planner child>) resumes the
//      same child → it writes `revision` 2; `planner_subagent_id` unchanged
// The continuation then ends with `ralplan clear`.
// Run: `bun ./tests/ralplan-trail-probe.ts`.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { directive, fail, REPO, runProbe, subagentResults, withHost } from "./host-harness";

const PLANNER = "open-gajae-planner";
/** Over both tool-output limits: 50 KiB and 2,000 lines. */
const PLAN = `# Planner draft\n${Array.from({ length: 2_400 }, (_, i) => `- planner line ${String(i).padStart(4, "0")} ${"x".repeat(12)}`).join("\n")}\n`;
const REVIEWS = { architect: "# Architect pass 1\n", critic: "# Critic pass 1\n", revision: "# Revision 2\n" };
const parse = (text: string | undefined): any => {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return undefined;
  }
};
/** A write result is the receipt line, then its JSON payload. */
const receiptOf = (result: string) => ({ line: result.split("\n")[0], payload: parse(result.slice(result.indexOf("\n") + 1)) });

await runProbe("open-gajae-ralplan-trail-probe", async (report, scratch) => {
  await withHost(report, join(scratch, "host"), { plugins: [REPO] }, async (host) => {
    const primary = await host.createSession({ agent: "open-gajae" });
    // Plugin setup runs on the first prompt (Phase 0 P5); `ralplan status`
    // names the session folder without starting a run.
    await host.turn(primary, directive({ tag: "warmup", steps: [{ tool: "ralplan", args: { op: "status" } }] }));
    const storage = parse(host.provider.thread("warmup").at(-1)?.toolResults.at(-1))?.storage_path;
    if (typeof storage !== "string") fail("warmup: ralplan status returned no storage_path");
    const runDir = join(dirname(dirname(storage)), "plans/ralplan", primary);
    const receipt = `Persisted ralplan planner stage 1 at ${join(runDir, "stage-01-planner.md")}.`;

    const role = (tag: string, stage: string, stageN: number, content: string, reply: string) =>
      directive({
        tag,
        steps: [{ tool: "ralplan", args: { op: "write", stage, stage_n: stageN, run_id: primary, content } }, { text: reply }],
      });
    const subagent = (agent: string, prompt: string, extra: Record<string, unknown> = {}) => ({
      tool: "subagent",
      args: { agent, description: `${agent.slice("open-gajae-".length)} probe`, prompt, ...extra },
    });
    await host.turn(
      primary,
      directive({
        tag: "trail",
        steps: [
          { tool: "ralplan", args: { op: "start", task: "plan the probe" } },
          subagent(PLANNER, role("planner-1", "planner", 1, PLAN, receipt)),
          {
            parallel: [
              subagent("open-gajae-architect", role("architect-1", "architect", 1, REVIEWS.architect, "architect receipt")),
              subagent("open-gajae-critic", role("critic-1", "critic", 1, REVIEWS.critic, "critic receipt")),
            ],
          },
          subagent(PLANNER, role("planner-2", "revision", 2, REVIEWS.revision, "revision receipt"), {
            sessionID: `{{subagent_session:${PLANNER}}}`,
          }),
        ],
      }),
      {},
      180_000,
    );
    // The run is active; its continuation ends with `ralplan clear`, which keeps the role ids.
    await host.settle(primary);

    const trail = host.provider.thread("trail").filter((e) => e.kind === "directive").at(-1);
    const messages: any[] = trail?.body?.messages ?? [];
    const results = subagentResults(messages);
    const [planner1, planner2] = results.filter((r) => r.agent === PLANNER);
    const architect = results.find((r) => r.agent === "open-gajae-architect");
    const critic = results.find((r) => r.agent === "open-gajae-critic");
    const state = host.ralplanState(primary);
    const started = parse(host.provider.thread("trail").find((e) => e.kind === "directive" && e.step === 1)?.toolResults.at(-1));
    report.check("ralplan start started the run", started?.ok === true && started?.run_id === primary, started);
    report.check(
      "four subagent results (planner, architect, critic, resumed planner)",
      results.length === 4 && !!planner1 && !!planner2 && !!architect && !!critic,
      results.map(({ agent, sessionID, text }) => ({ agent, sessionID, text: text.slice(0, 300) })),
    );

    // 1. Large planner write and its receipt.
    const plannerWrite = host.provider.thread("planner-1").at(-1)?.toolResults.at(-1) ?? "";
    const written = receiptOf(plannerWrite);
    const plannerFile = join(runDir, "stage-01-planner.md");
    const size = statSync(plannerFile, { throwIfNoEntry: false })?.size;
    report.check(
      "1. input is at least 64 KiB and over 2,000 lines",
      Buffer.byteLength(PLAN) >= 64 * 1024 && PLAN.split("\n").length > 2_000,
      { bytes: Buffer.byteLength(PLAN) },
    );
    report.check(
      "1. planner stage file size equals the input size (bytes identical)",
      size === Buffer.byteLength(PLAN) && readFileSync(plannerFile, "utf8") === PLAN,
      { size, input: Buffer.byteLength(PLAN) },
    );
    report.check("1. the planner child's write returned the receipt it replied with", written.line === receipt, plannerWrite.slice(0, 600));
    report.check(
      "1. the parent's subagent result carries only the plain receipt",
      !!planner1 && planner1.text.includes(receipt) && !planner1.text.includes("planner line 0000"),
      planner1?.text.slice(0, 600),
    );
    report.check(
      "1. the planner receipt records planner_subagent_id = the child (state: check 3)",
      !!planner1 && written.payload?.planner_state?.planner_subagent_id === planner1.sessionID,
      { child: planner1?.sessionID, receipt: written.payload?.planner_state },
    );

    // 2. Parallel architect and critic writes.
    const calls = messages.filter((m) => m.role === "assistant" && m.tool_calls?.length > 0).map((m) => m.tool_calls);
    const fanOut = calls.find((c: any[]) => c.length > 1) ?? [];
    report.check(
      "2. architect and critic subagent calls share one assistant message",
      fanOut.length === 2 && fanOut.every((c: any) => c.function?.name === "subagent"),
      calls.map((c: any[]) => c.map((call) => call.function?.name)),
    );
    for (const lane of ["architect", "critic"] as const) {
      const result = host.provider.thread(`${lane}-1`).at(-1)?.toolResults.at(-1) ?? "";
      const child = lane === "architect" ? architect : critic;
      report.check(
        `2. ${lane} write landed (receipt, stage file, state ${lane}_id = the child)`,
        receiptOf(result).line.startsWith(`Persisted ralplan ${lane} stage 1 at `) &&
          host.sessionFile(primary, `plans/ralplan/${primary}/stage-01-${lane}.md`) === REVIEWS[lane] &&
          !!child &&
          state?.[`${lane}_id`] === child.sessionID,
        { result: result.slice(0, 400), child: child?.sessionID, state: state?.[`${lane}_id`] },
      );
    }
    const ledger = (host.sessionFile(primary, `plans/ralplan/${primary}/index.jsonl`) ?? "").split("\n").filter(Boolean);
    const rows = ledger.map(parse);
    const stages = rows.map((row) => `${row?.stage}:${row?.stage_n}`).sort();
    report.check(
      "2. every index.jsonl line parses; one row per written stage",
      rows.every((row) => row !== undefined) &&
        JSON.stringify(stages) === JSON.stringify(["architect:1", "critic:1", "planner:1", "revision:2"]),
      ledger,
    );

    // 3. Resumed planner.
    const revisionWrite = receiptOf(host.provider.thread("planner-2").at(-1)?.toolResults.at(-1) ?? "");
    report.check(
      "3. the resume went to the recorded planner child, which kept its history",
      !!planner1 &&
        planner2?.sessionID === planner1.sessionID &&
        !!host.provider.thread("planner-2")[0]?.messages.some((m) => m.text.includes('"tag":"planner-1"')),
      { first: planner1?.sessionID, resumed: planner2?.sessionID },
    );
    report.check(
      "3. the resumed child wrote revision 2",
      revisionWrite.line.startsWith("Persisted ralplan revision stage 2 at ") &&
        host.sessionFile(primary, `plans/ralplan/${primary}/stage-02-revision.md`) === REVIEWS.revision &&
        revisionWrite.payload?.planner_state?.planner_subagent_id === planner1?.sessionID,
      revisionWrite,
    );
    report.check(
      "3. state planner_subagent_id unchanged; the continuation ended with ralplan clear",
      !!planner1 && state?.planner_subagent_id === planner1.sessionID && state?.active === false,
      state,
    );
  });
});
