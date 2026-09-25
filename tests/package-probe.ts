// v2 package probe (plan Step 8, Q4): the packed package loads as TS source
// with no build step.
//   1. `npm pack` the repository; the tarball carries index.ts and src/, no dist/.
//   2. Install the tarball into a disposable directory and point the disposable
//      host config's `plugins` at the installed package directory.
//   3. Name the tarball as a package spec (`open-gajae@file:<tgz>`), so the
//      host installs it with its own installer into the disposable cache.
// Each case must load id `open-gajae` from the installed TS source and
// register the eight agents and twelve tools. npm runs with a disposable HOME
// and cache; the install needs registry access for the dependencies.
// Run: `bun ./tests/package-probe.ts`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  AGENTS,
  directive,
  OUR_TOOLS,
  REPO,
  runProbe,
  waitFor,
  withHost,
  type Host,
  type Report,
} from "./host-harness";

async function loads(report: Report, host: Host, label: string, expectedEntry: (path: string) => boolean | Promise<boolean>) {
  const session = await host.createSession({ agent: "open-gajae" });
  await host.turn(session, directive({ tag: label, steps: [] }), {}, 180_000);
  const plugin = (await host.list("/api/plugin")).find((p) => p.id === "open-gajae");
  report.check(`${label}: plugin open-gajae is active`, plugin?.state?.status === "active", plugin);
  report.check(`${label}: loaded from the installed TS entry`, await expectedEntry(String(plugin?.source?.path ?? "")), plugin?.source);
  const agents = (await host.list("/api/agent")).map((a) => a.id ?? a.name).filter((id) => AGENTS.includes(id));
  report.check(`${label}: eight agents registered`, agents.length === 8, agents);
  const tools = host.provider.thread(label)[0]?.tools ?? [];
  report.check(`${label}: twelve plugin tools offered`, OUR_TOOLS.every((t) => tools.includes(t)), tools);
}

await runProbe("open-gajae-package-probe", async (report, scratch) => {
  const npmHome = join(scratch, "npm-home");
  const npmEnv = {
    ...process.env,
    HOME: npmHome,
    npm_config_cache: join(npmHome, ".npm"),
    npm_config_userconfig: join(npmHome, ".npmrc"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  const packDir = join(scratch, "pack");
  const consumer = join(scratch, "consumer");
  for (const dir of [npmHome, packDir, consumer]) mkdirSync(dir, { recursive: true });

  const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: REPO, env: npmEnv, encoding: "utf8" });
  report.check("npm pack succeeded", pack.status === 0, pack.stderr.slice(-1_000));
  const packed = JSON.parse(pack.stdout)[0];
  const files: string[] = packed.files.map((f: any) => f.path);
  const tarball = join(packDir, packed.filename);
  report.check("tarball has no dist/", !files.some((f) => f.startsWith("dist/")), files.filter((f) => f.startsWith("dist/")));
  report.check(
    "tarball carries the TS entry, sources, skills and prompts",
    ["index.ts", "src/index.ts", "src/ultragoal.ts", "skills/ralplan/SKILL.md", "skills/deep-interview/SKILL.md", "skills/ultragoal/SKILL.md", "prompts/open-gajae.md", "prompts/open-gajae-executor.md", "prompts/open-gajae-cleaner.md", "package.json"].every((f) =>
      files.includes(f),
    ),
    files,
  );

  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true }));
  const install = spawnSync("npm", ["install", tarball], { cwd: consumer, env: npmEnv, encoding: "utf8" });
  report.check("npm install <tarball> succeeded", install.status === 0, install.stderr.slice(-1_000));
  const installed = join(consumer, "node_modules/open-gajae");

  await withHost(report, join(scratch, "host-dir"), { plugins: [installed] }, async (host) => {
    await loads(report, host, "installed-dir", (path) => path === join(installed, "index.ts"));
  });

  await withHost(report, join(scratch, "host-spec"), { plugins: [`open-gajae@file:${tarball}`] }, async (host) => {
    // A package source records no path; the host log names the entrypoint,
    // which for an installed package comes from `package.json` `exports`.
    // The log is flushed asynchronously, so poll it.
    await loads(report, host, "named-spec", () =>
      waitFor(
        "named-spec entrypoint logged",
        () => {
          const log = join(host.home, ".local/share/opencode/log/opencode.log");
          const text = existsSync(log) ? readFileSync(log, "utf8") : "";
          const entry = text.match(/msg="loading plugin" id=open-gajae@file:\S+ entrypoint=file:\/\/(\S+)/)?.[1] ?? "";
          return entry.startsWith(host.root) && entry.endsWith("/node_modules/open-gajae/src/index.ts");
        },
        15_000,
      ).catch(() => false),
    );
  });
});
