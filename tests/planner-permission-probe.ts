// v2 planner permission probe (plan Step 8, updated by plan S3), with
// `experimental.subagent_depth: 2`, all driven from the primary through
// `subagent(open-gajae-planner)` on the installed 2.0.15 host. The planner has
// no `write` tool (D-T4); it records through `ralplan write` with `content`:
//   1. ralplan write (content)                        → recorded under the root session's plans/ralplan/
//   2. write into another session's plans/            → write hidden, nothing written
//   3. write outside the session folder               → write hidden, nothing written
//   4. subagent(open-gajae-explore)                   → runs
//   5. subagent(open-gajae-critic)                    → refused
//   6. write into another session's plans/, input sent as stringified JSON →
//      write hidden, nothing written
// and a critic child whose `write` is refused.
// Run: `bun ./tests/planner-permission-probe.ts`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { directive, REPO, runProbe, withHost } from "./host-harness";

const FOREIGN = ".open-gajae/_session-20260101-000000-ses_other/plans/foreign.md";
const OWN_PLAN = "# own plan\n";
/** The host's answer to a call of a tool the agent is not offered (JSON-encoded). */
const writeHidden = (result: string) => result.includes('No tool named \\"write\\" is currently available');

await runProbe("open-gajae-planner-permission-probe", async (report, scratch) => {
  await withHost(
    report,
    join(scratch, "host"),
    { plugins: [REPO], experimental: { subagent_depth: 2 } },
    async (host) => {
      const primary = await host.createSession({ agent: "open-gajae" });
      // Plugin setup runs on the first prompt in a location (Phase 0 P5).
      await host.turn(primary, directive({ tag: "warmup", steps: [] }));

      const planner = directive({
        tag: "planner",
        steps: [
          { tool: "ralplan", args: { op: "write", stage: "planner", stage_n: 1, content: OWN_PLAN } },
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
          {
            tool: "write",
            rawArgs: JSON.stringify(JSON.stringify({ path: FOREIGN, content: "x" })),
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
      // The planner's write made ralplan active; its continuation ends with `ralplan clear`.
      await host.settle(primary);

      const plannerRequest = host.provider.thread("planner")[0];
      report.check(
        "planner: write hidden, ralplan offered",
        !!plannerRequest && !plannerRequest.tools.includes("write") && plannerRequest.tools.includes("ralplan"),
        plannerRequest?.tools,
      );
      const results = host.provider.thread("planner").at(-1)?.toolResults ?? [];
      report.check("planner request carried six tool results", results.length === 6, results);
      const [own, foreign, outside, explore, criticCall, stringified] = results.map((r) => r ?? "");
      // DR-1: the owner is the lineage root; the run id defaults to its session id.
      const recorded = host.sessionFile(primary, `plans/ralplan/${primary}/stage-01-planner.md`);
      report.check(
        "1. planner ralplan write (content) records under the root session's plans/ralplan/",
        recorded === OWN_PLAN && !own.includes('"error"'),
        { recorded, own: own.slice(0, 600) },
      );
      report.check("2. another session's plans/: write hidden, nothing written", !existsSync(join(host.project, FOREIGN)) && writeHidden(foreign), foreign);
      report.check(
        "3. write outside the session folder: write hidden, nothing written",
        !existsSync(join(host.project, "outside/planner.md")) && writeHidden(outside),
        outside,
      );
      const explored = host.provider.thread("explore").length > 0;
      report.check("4. subagent(open-gajae-explore) runs from the planner", explored && !explore.includes('"error"'), explore);
      report.check(
        "5. subagent(open-gajae-critic) refused for the planner",
        criticCall.includes('"error"') && host.provider.thread("critic-nested").length === 0,
        criticCall,
      );
      report.check(
        "6. stringified-JSON write into another session's plans/: write hidden, nothing written",
        !existsSync(join(host.project, FOREIGN)) && writeHidden(stringified),
        stringified,
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
