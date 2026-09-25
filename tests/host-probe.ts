// v2 host probe (plan Step 8): the repository loads as a directory plugin on
// the installed 2.0.15 host, registers eight agents, three skills and twelve
// tools, the read-only roles do not see `opencode_session_move`/`_rename`, and
// only the primary and the two ultragoal reviewers see the `ultragoal` tool.
// Run: `bun run test:host` (or `bun ./tests/host-probe.ts`).
import { join } from "node:path";
import {
  AGENTS,
  directive,
  OUR_TOOLS,
  READ_ONLY_AGENTS,
  REPO,
  runProbe,
  SKILLS,
  opencodeCatalog,
  withHost,
} from "./host-harness";

await runProbe("open-gajae-host-probe", async (report, scratch) => {
  await withHost(report, join(scratch, "host"), { plugins: [REPO] }, async (host) => {
    // Plugin setup runs on the first prompt in a location (Phase 0 P5).
    const primary = await host.createSession({ agent: "open-gajae" });
    await host.turn(primary, directive({ tag: "load", steps: [] }));

    const plugin = (await host.list("/api/plugin")).find((p) => p.id === "open-gajae");
    report.check("plugin open-gajae is active", plugin?.state?.status === "active", plugin);
    report.check(
      "loaded from the directory entry index.ts as TS source",
      plugin?.source?.type === "local" && plugin?.source?.path === join(REPO, "index.ts"),
      plugin?.source,
    );

    const agents = (await host.list("/api/agent"))
      .map((a) => a.id ?? a.name)
      .filter((id) => typeof id === "string" && id.startsWith("open-gajae"))
      .sort();
    report.check("eight open-gajae agents registered", JSON.stringify(agents) === JSON.stringify(AGENTS), agents);

    const skills = (await host.list("/api/skill"))
      .map((s) => s.id ?? s.name)
      .filter((id) => SKILLS.includes(id))
      .sort();
    report.check("three skills registered", JSON.stringify(skills) === JSON.stringify(SKILLS), skills);

    const load = host.provider.thread("load")[0];
    const primaryTools = OUR_TOOLS.filter((t) => load?.tools.includes(t));
    report.check("twelve plugin tools offered to the primary as direct tools", primaryTools.length === 12, primaryTools);
    const primaryCatalog = opencodeCatalog(load);
    report.check(
      "primary keeps opencode.session_move/session_rename",
      ["session_move", "session_rename"].every((t) => primaryCatalog.entries.includes(t)),
      primaryCatalog,
    );

    for (const agent of READ_ONLY_AGENTS) {
      const session = await host.createSession({ agent });
      const tag = `role-${agent}`;
      await host.turn(session, directive({ tag, steps: [] }));
      const request = host.provider.thread(tag)[0];
      const catalog = opencodeCatalog(request);
      report.check(
        `${agent}: opencode.session_move/session_rename hidden`,
        !!catalog.namespaceLine &&
          catalog.entries.includes("models") &&
          !catalog.entries.some((t) => t === "session_move" || t === "session_rename"),
        catalog,
      );
      const hidden = ["question", "state_write", "state_clear"].filter((t) => request?.tools.includes(t));
      report.check(`${agent}: question/state_write/state_clear hidden`, !!request && hidden.length === 0, hidden);
      report.check(
        `${agent}: ${agent === "open-gajae-planner" ? "write offered (own plans only)" : "write/edit hidden"}`,
        agent === "open-gajae-planner"
          ? !!request?.tools.includes("write")
          : !!request && !request.tools.includes("write") && !request.tools.includes("edit"),
        request?.tools,
      );
      const reviewer = agent === "open-gajae-architect" || agent === "open-gajae-critic";
      report.check(
        `${agent}: ultragoal ${reviewer ? "offered (status, record_verdict)" : "hidden"}`,
        !!request && request.tools.includes("ultragoal") === reviewer,
        request?.tools,
      );
      if (agent === "open-gajae-cleaner")
        report.check("open-gajae-cleaner: shell offered for read-only inspection", !!request?.tools.includes("shell"), request?.tools);
    }

    // The executor writes code and delegates, but never asks or drives ultragoal.
    const executor = await host.createSession({ agent: "open-gajae-executor" });
    await host.turn(executor, directive({ tag: "role-executor", steps: [] }));
    const exec = host.provider.thread("role-executor")[0];
    report.check(
      "open-gajae-executor: write, edit, shell and subagent offered",
      ["write", "edit", "shell", "subagent"].every((t) => exec?.tools.includes(t)),
      exec?.tools,
    );
    report.check(
      "open-gajae-executor: ultragoal, question, state_write and state_clear hidden",
      !!exec && !["ultragoal", "question", "state_write", "state_clear"].some((t) => exec.tools.includes(t)),
      exec?.tools,
    );
  });
});
