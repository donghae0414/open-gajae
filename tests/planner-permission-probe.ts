// v2 planner permission probe (plan Step 8), with
// `experimental.subagent_depth: 2`, all driven from the primary through
// `subagent(open-gajae-planner)` on the installed 2.0.15 host:
//   1. write into the root session's own plans/       → written
//   2. write into another session's plans/            → refused (artifact guard), rewritten guidance
//   3. write outside the planner's pattern            → refused (permission), rewritten guidance
//   4. subagent(open-gajae-explore)                   → runs
//   5. subagent(open-gajae-critic)                    → refused
// and a critic child whose `write` is refused.
// Run: `bun ./tests/planner-permission-probe.ts`.
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { directive, REPO, runProbe, withHost } from "./host-harness";

const FOREIGN = ".open-gajae/_session-20260101-000000-ses_other/plans/foreign.md";

await runProbe("open-gajae-planner-permission-probe", async (report, scratch) => {
  await withHost(
    report,
    join(scratch, "host"),
    { plugins: [REPO], experimental: { subagent_depth: 2 } },
    async (host) => {
      const primary = await host.createSession({ agent: "open-gajae" });
      // Setup runs on the first prompt; this turn also resolves the session's plans/.
      await host.turn(primary, directive({ tag: "paths", steps: [{ tool: "state_read", args: { mode: "ralplan" } }] }));
      const plansDir: string = JSON.parse(host.provider.thread("paths").at(-1)!.toolResults[0]!).plansDir;
      const ownPlan = `${relative(host.project, plansDir)}/planner-own.md`;

      const planner = directive({
        tag: "planner",
        steps: [
          { tool: "write", args: { path: ownPlan, content: "# own plan\n" } },
          { tool: "write", args: { path: FOREIGN, content: "x" } },
          { tool: "write", args: { path: "outside/planner.md", content: "x" } },
          {
            tool: "subagent",
            args: { agent: "open-gajae-explore", description: "explore probe", prompt: directive({ tag: "explore", steps: [{ text: "explored" }] }) },
          },
          {
            tool: "subagent",
            args: { agent: "open-gajae-critic", description: "critic probe", prompt: directive({ tag: "critic-nested", steps: [] }) },
          },
        ],
      });
      const critic = directive({ tag: "critic", steps: [{ tool: "write", args: { path: "outside/critic.md", content: "x" } }] });
      await host.turn(
        primary,
        directive({
          tag: "primary",
          steps: [
            { tool: "subagent", args: { agent: "open-gajae-planner", description: "planner probe", prompt: planner } },
            { tool: "subagent", args: { agent: "open-gajae-critic", description: "critic probe", prompt: critic } },
          ],
        }),
        {},
        120_000,
      );

      const results = host.provider.thread("planner").at(-1)?.toolResults ?? [];
      report.check("planner request carried five tool results", results.length === 5, results);
      const [own, foreign, outside, explore, criticCall] = results.map((r) => r ?? "");
      report.check("1. planner writes its own plans/", existsSync(join(host.project, ownPlan)) && !own.includes('"error"'), own);
      report.check(
        "2. another session's plans/ refused with guidance",
        !existsSync(join(host.project, FOREIGN)) && foreign.includes("belongs to another session's plans/drafts") && foreign.includes("may only write under this session's plans/"),
        foreign,
      );
      report.check(
        "3. out-of-scope write refused with guidance",
        !existsSync(join(host.project, "outside/planner.md")) && outside.includes("refused by the planner's write scope") && outside.includes("may only write under this session's plans/"),
        outside,
      );
      const explored = host.provider.thread("explore").length > 0;
      report.check("4. subagent(open-gajae-explore) runs from the planner", explored && !explore.includes('"error"'), explore);
      report.check(
        "5. subagent(open-gajae-critic) refused for the planner",
        criticCall.includes('"error"') && host.provider.thread("critic-nested").length === 0,
        criticCall,
      );

      const criticRequest = host.provider.thread("critic")[0];
      const criticResult = host.provider.thread("critic").at(-1)?.toolResults.at(-1) ?? "";
      report.check(
        "critic cannot write (write hidden, call fails, nothing written)",
        !!criticRequest && !criticRequest.tools.includes("write") && criticResult.length > 0 && !existsSync(join(host.project, "outside/critic.md")),
        { tools: criticRequest?.tools, result: criticResult.slice(0, 300) },
      );
    },
  );
});
