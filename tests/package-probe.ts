// Task 7a: actual npm pack, locked consumer installation, directory loading,
// and the supported registry name@version path. No publish or archive-spec path.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  AGENTS, directive, OUR_TOOLS, REPO, runProbe, withHost,
  releasedPort, type Host, type Report,
} from "./host-harness";

const manifest = z.object({
  name: z.string(), version: z.string(), type: z.string(),
  exports: z.record(z.string(), z.string()),
  dependencies: z.record(z.string(), z.string()),
  files: z.array(z.string()),
}).passthrough().parse(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")));
const arg = process.argv.indexOf("--evidence-dir");
const evidenceDir = resolve(process.env.OPEN_GAJAE_PACKAGE_EVIDENCE_DIR ??
  (arg >= 0 ? process.argv[arg + 1] : undefined) ??
  join(REPO, ".omo/evidence/todo-agent-performance/package"));
mkdirSync(evidenceDir, { recursive: true });
type CommandReceipt = {
  readonly command: readonly string[]; readonly cwd: string;
  readonly exit: number; readonly stdout: string; readonly stderr: string;
};

async function command(args: string[], cwd: string, env: Record<string, string | undefined>): Promise<CommandReceipt> {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 180_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    return { command: args, cwd, exit, stdout, stderr };
  } finally { clearTimeout(deadline); }
}

async function loads(report: Report, host: Host, label: string,
  expectedEntry: (source: Record<string, unknown>) => boolean) {
  const session = await host.createSession({ agent: "open-gajae" });
  await host.turn(session, directive({ tag: label, steps: [] }), {}, 180_000);
  const plugin = (await host.list("/api/plugin")).find((p) => p.id === "open-gajae");
  report.check(`${label}: plugin open-gajae is active`, plugin?.state?.status === "active", plugin);
  report.check(`${label}: loaded from supported installed source`,
    expectedEntry(plugin?.source ?? {}), plugin?.source);
  const agents = (await host.list("/api/agent")).map((a) => a.id ?? a.name).filter((id) => AGENTS.includes(id));
  report.check(`${label}: nine agents registered`, agents.length === 9, agents);
  const tools = host.provider.thread(label)[0]?.tools ?? [];
  report.check(`${label}: thirteen plugin tools offered`,
    OUR_TOOLS.length === 13 && OUR_TOOLS.every((t) => tools.includes(t)), tools);
  return { plugin, agents, tools, events: host.sessionEvents(session) };
}

await runProbe("open-gajae-package-probe", async (report, scratch) => {
  console.log("WORKING: task7a - tarball and registry package checks");
  const npmHome = join(scratch, "npm-home");
  const npmEnv: Record<string, string | undefined> = {
    ...process.env, HOME: npmHome,
    npm_config_cache: join(npmHome, ".npm"),
    npm_config_userconfig: join(npmHome, ".npmrc"),
    npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
  };
  delete npmEnv.BUN_CONFIG_VERBOSE_FETCH;
  const packDir = join(scratch, "pack");
  const consumer = join(scratch, "consumer");
  for (const dir of [npmHome, packDir, consumer]) mkdirSync(dir, { recursive: true });
  const receipts: CommandReceipt[] = [];
  const lockBefore = readFileSync(join(REPO, "bun.lock"));
  const frozen = await command(["bun", "install", "--frozen-lockfile"], REPO, npmEnv);
  receipts.push(frozen);
  report.check("bun frozen lockfile install succeeded without changing lock",
    frozen.exit === 0 && readFileSync(join(REPO, "bun.lock")).equals(lockBefore), frozen);
  // Seed only the probe's disposable copy, never the user's build directory.
  const packageCopy = join(scratch, "package-source");
  mkdirSync(packageCopy);
  for (const file of new Set([...manifest.files.filter((file) => !file.startsWith("dist")),
    "package.json", "bun.lock", "scripts", "README.md"])) {
    cpSync(join(REPO, file), join(packageCopy, file), { recursive: true });
  }
  symlinkSync(join(REPO, "node_modules"), join(packageCopy, "node_modules"), "dir");
  mkdirSync(join(packageCopy, "dist"));
  writeFileSync(join(packageCopy, "dist/index.js"), "export const stale = true;\n");
  const pack = await command(["npm", "pack", "--json", "--pack-destination", packDir], packageCopy, npmEnv);
  receipts.push(pack);
  report.check("npm pack succeeded (prepack builds TUI)", pack.exit === 0, pack);
  if (pack.exit !== 0) throw new Error("npm pack failed");
  const [packed] = z.array(z.object({
    filename: z.string(), files: z.array(z.object({ path: z.string() })),
  }).passthrough()).parse(JSON.parse(pack.stdout));
  if (!packed) throw new Error("npm pack returned no tarball");
  const files = packed.files.map((f) => f.path);
  const tarball = join(packDir, packed.filename);
  copyFileSync(tarball, join(evidenceDir, packed.filename));
  report.check("tarball dist contains only dist/tui.js despite stale dist/index.js",
    files.filter((f) => f.startsWith("dist/")).join() === "dist/tui.js", files);
  report.check("tarball carries root tui.ts facade", files.includes("tui.ts"), files);
  report.check("tarball carries src/todo/protocol.ts RPC source", files.includes("src/todo/protocol.ts"), files);
  report.check("tarball carries TS entry sources skills prompts and licenses",
    ["index.ts", "src/index.ts", "src/todo/tool.ts", "src/todo/continuation.ts",
      "src/ultragoal-runtime/tool.ts", "src/goal/tool.ts", "src/deep-interview-runtime/tool.ts",
      "skills/ralplan/SKILL.md", "skills/deep-interview/SKILL.md", "skills/ultragoal/SKILL.md",
      "prompts/open-gajae.md", "prompts/open-gajae-executor.md",
      "LICENSE", "THIRD-PARTY-NOTICES.md", "package.json"].every((f) => files.includes(f)), files);
  report.check("package exports align server TUI and RPC",
    manifest.exports["."] === "./src/index.ts" && manifest.exports["./tui"] === "./dist/tui.js" &&
    manifest.exports["./rpc"] === "./src/todo/protocol.ts", manifest.exports);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true }));
  const install = await command(["npm", "install", tarball], consumer, npmEnv);
  receipts.push(install);
  report.check("actual tarball installed in separate consumer", install.exit === 0, install);
  const consumerLock = readFileSync(join(consumer, "package-lock.json"));
  const ci = await command(["npm", "ci"], consumer, npmEnv);
  receipts.push(ci);
  report.check("npm ci restores consumer with frozen package-lock",
    ci.exit === 0 && consumerLock.equals(readFileSync(join(consumer, "package-lock.json"))), ci);
  const installed = join(consumer, "node_modules/open-gajae");
  const installations: unknown[] = [];
  await withHost(report, join(scratch, "host-dir"), { plugins: [installed] }, async (host) => {
    installations.push(await loads(report, host, "installed-dir", (source) => source.path === join(installed, "index.ts")));
  });
  const requests: string[] = [];
  const archive = readFileSync(tarball);
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const registry = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method !== "GET") return new Response("read only", { status: 405 });
      if (url.pathname === `/${manifest.name}/-/probe.tgz`) return new Response(archive);
      if (url.pathname === `/${manifest.name}`) return Response.json({
        name: manifest.name, "dist-tags": { latest: manifest.version },
        versions: { [manifest.version]: { ...manifest, dist: {
          tarball: new URL(`/${manifest.name}/-/probe.tgz`, request.url).href, integrity,
        } } },
      });
      const upstream = await fetch(`https://registry.npmjs.org${url.pathname}${url.search}`,
        { signal: AbortSignal.timeout(60_000) });
      const headers = new Headers(upstream.headers);
      // fetch decompressed the body. Forwarding these headers corrupts installs.
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
    },
  });
  const registryPort = registry.port;
  let registryLog = "";
  const registryRoot = join(scratch, "host-registry");
  try {
    await withHost(report, registryRoot,
      { plugins: [`${manifest.name}@${manifest.version}`] }, async (host) => {
        // HOME and cwd are outside package/real-user discovery ancestors.
        writeFileSync(join(host.home, ".npmrc"), `registry=${registry.url}\n`);
        host.env.npm_config_registry = registry.url.href;
        installations.push(await loads(report, host, "registry-name-version",
          (source) => source.type === "npm" || source.type === "package"));
        report.check("registry name@version fetched actual metadata and tarball",
          requests.includes(`GET /${manifest.name}`) && requests.includes(`GET /${manifest.name}/-/probe.tgz`), requests);
        registryLog = join(host.home, ".local/share/opencode/log/opencode.log");
      });
    // Process close is the flush barrier for the asynchronously buffered host log.
    const log = existsSync(registryLog) ? readFileSync(registryLog, "utf8") : "";
    report.check("registry server source loaded from isolated npm cache",
      log.includes("/node_modules/open-gajae/src/index.ts") && log.includes(registryRoot), log.slice(-4_000));
  } finally { registry.stop(true); }
  writeFileSync(join(evidenceDir, "install-receipts.json"), JSON.stringify({
    host: "opencode v2.0.26", tarball: packed.filename, integrity, files, receipts, installations,
    requests, checks: report.checks,
    cleanup: { registryStopped: true, registryPort, registryPortReleased: registryPort !== undefined && releasedPort(registryPort),
      hosts: report.cleanup },
    peerRecommendation: "Declare OpenTUI/Solid as peers consistent with @opencode/plugin; do not bundle singleton runtimes. No manifest change required by observed server loading. TUI loading evidence belongs to task 7b.",
  }, null, 2) + "\n");
});
