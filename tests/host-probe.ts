// v2 host probe (plan Step 8): the repository loads as a directory plugin on
// the installed 2.0.15 host, registers six agents, two skills and eleven tools,
// and the read-only roles do not see `opencode_session_move`/`_rename`.
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
    report.check("six open-gajae agents registered", JSON.stringify(agents) === JSON.stringify(AGENTS), agents);

    const skills = (await host.list("/api/skill"))
      .map((s) => s.id ?? s.name)
      .filter((id) => SKILLS.includes(id))
      .sort();
    report.check("two skills registered", JSON.stringify(skills) === JSON.stringify(SKILLS), skills);

    const load = host.provider.thread("load")[0];
    const primaryTools = OUR_TOOLS.filter((t) => load?.tools.includes(t));
    report.check("eleven plugin tools offered to the primary as direct tools", primaryTools.length === 11, primaryTools);
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
    }
  });
});
