// Task 7b: real native read-only todo TUI QA. It drives the installed OpenCode
// host (`~/.opencode/bin/opencode`, 2.0.26) inside a PTY, mirrors every byte
// into an xterm emulator, and asserts what the terminal grid shows while the
// plugin's `todo` tool (called by a deterministic local provider) moves one
// session's board through active, held, terminal, empty and invalid states.
//
// Isolation follows tests/host-harness.ts: private HOME/XDG/TMPDIR under a
// disposable root in the OS temporary directory, a project outside the user's
// home, no BUN_CONFIG_VERBOSE_FETCH, no paid models. Two install modes run the
// same matrix: the repository directory (dev-dir) and an `npm pack` tarball
// installed into a separate consumer directory. A separate live registry run
// installs a uniquely named archive using only name@version configuration.
//
// Launch modes of the host ("--launch"): `standalone` (the shipped --standalone
// flag, one private server), `service` (the shipped default, TUI-spawned
// background service) and `attach` (`opencode serve` from the project plus the
// TUI's --server flag, with a service registration file written for the
// plugin's public service discovery). The matrix runs in the launch mode given
// by --launch (default `attach`); the other two shipped modes run a short
// evidence pass, so every observed product behaviour has a capture.
//
// Evidence (--evidence-dir): plain grids (.txt), raw PTY prefixes (.ansi, with
// .ansi.json resize marks) for the primary light/dark captures, the full raw
// stream per run, PNG screenshots rendered by xterm.js inside Bun.WebView from
// those raw bytes (never reconstructed), and report.json mapping every
// acceptance item to captures with PASS/FAIL. Unobserved states are FAIL.
//
// Run: `bun run test:host:todo:tui -- --evidence-dir <dir> [--mode dev,packed]
// [--launch standalone|service|attach] [--registry-only] [--keep] [--no-png]`.
// Task 9 fault control: --disabled-only --disabled-control-enabled runs the
// same disabled assertions with enabled:true and must exit non-zero.
// Quick fault check: `bun ./tests/host-todo-tui-probe.ts
// --self-check-unavailable-lsof --evidence-dir <dir>`; its diagnostics-only
// child has ps available but no lsof in PATH, and must exit non-zero.
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HOST, HOST_VERSION, isSupportedHostVersion, REPO, Report } from "./host-harness";
import { z } from "zod";
import { epochMillis, StateStore } from "../src/state";
import { TodoStore } from "../src/todo/store";
import { todoSnapshotSchema } from "../src/todo/state";

// ------------------------------------------------------------ arguments
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const EVIDENCE = resolve(flag("--evidence-dir") ?? join(REPO, ".omo/evidence/todo-agent-performance/tui"));
const REGISTRY_ONLY = argv.includes("--registry-only");
const DIAGNOSTICS_ONLY = argv.includes("--diagnostics-only");
const DISABLED_ONLY = argv.includes("--disabled-only");
const DISABLED_CONTROL_ENABLED = argv.includes("--disabled-control-enabled");
if (DISABLED_CONTROL_ENABLED && !DISABLED_ONLY)
  throw new Error("--disabled-control-enabled requires --disabled-only");
const MODES = (REGISTRY_ONLY || DIAGNOSTICS_ONLY || DISABLED_ONLY ? [] : (flag("--mode") ?? "dev,packed").split(",")).filter((m): m is InstallMode => m === "dev" || m === "packed");
type LaunchMode = "standalone" | "service" | "attach";
const LAUNCHES = (flag("--launch") ?? "attach,standalone,service").split(",").map((value) => value.trim())
  .filter((value): value is LaunchMode => value === "standalone" || value === "service" || value === "attach");
if (LAUNCHES.length === 0) throw new Error("--launch needs at least one of attach,standalone,service");
// The plan-named {light,dark}-{80x24,200x50} files are copied from the first
// of these runs that captured all four; every run keeps its prefixed copies.
const PRIMARY_RUNS = ["dev-service", "dev-attach", "dev-standalone", "packed-service", "packed-attach", "packed-standalone"];
const KEEP = argv.includes("--keep");
const PNG = !argv.includes("--no-png");
type InstallMode = "dev" | "packed";

mkdirSync(EVIDENCE, { recursive: true });

if (argv.includes("--self-check-unavailable-lsof")) await selfCheckUnavailableLsof();

const PROBE = "open-gajae-todo-tui-probe";
const BOOT_TIMEOUT = 90_000;
const STEP_TIMEOUT = 45_000;
const KEY = {
  ctrlP: "\x10",
  esc: "\x1b",
  enter: "\r",
  shiftTab: "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  pageDown: "\x1b[6~",
  pageUp: "\x1b[5~",
} as const;
const SIZES = { wide: { cols: 200, rows: 50 }, narrow: { cols: 80, rows: 24 } } as const;
const INJECTION_LABEL = "Render \u001b[31mANSI\u001b[0m <b>markup</b> label inert";
const BOARD = [
  { phase: "Investigation", items: ["Read the plan and task block", "Survey the host contracts"] },
  { phase: "Implementation", items: ["Write the PTY driver", "Script the deterministic provider", INJECTION_LABEL] },
  { phase: "Verification", items: ["Capture light and dark grids", "Write report.json"] },
];
const FOCUS = "Write the PTY driver";
const REVISION = /Todo r\d+/;
const HELD = /Todo r\d+ held/;

const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();
const hex6 = (value: number): string => value.toString(16).padStart(6, "0");
// WCAG relative luminance and contrast ratio; 3:1 is the large-text floor and
// catches text painted in the other theme mode's colours.
function luminance(color: string): number {
  const channel = (index: number) => {
    const c = parseInt(color.slice(index, index + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}
function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return Number(((a + 0.05) / (b + 0.05)).toFixed(2));
}
const MIN_CONTRAST = 3;
const BASE_CONTRAST = 4.5;
type Diagnostic = {
  readonly command: readonly string[];
  readonly exit: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string | null;
};
const diagnosticFailures: Omit<Diagnostic, "stdout">[] = [];
function diagnostic(command: readonly string[], emptyExitOne = false): Diagnostic {
  let receipt: Diagnostic;
  try {
    const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "pipe" });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();
    const ok = stderr.trim() === "" && (result.exitCode === 0 || (emptyExitOne && result.exitCode === 1 && stdout.trim() === ""));
    receipt = { command, exit: result.exitCode, stdout, stderr, error: ok ? null : `diagnostic exited ${result.exitCode}: ${stderr.trim()}` };
  } catch (error) {
    receipt = { command, exit: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) };
  }
  if (receipt.error !== null)
    diagnosticFailures.push({ command: receipt.command, exit: receipt.exit, stderr: receipt.stderr, error: receipt.error });
  return receipt;
}
type Token = "base" | "muted" | "info" | "warning" | "success" | "error";
type HostTokens = Record<Token, string> & { mode: string; background?: string };
// Which theme token src/tui.tsx paints each sampled fragment with (group 1 of
// the pattern is the sampled text; its first cell is read). Host reference
// fragments check the dump itself against the host's own rendering.
const SAMPLES: readonly { readonly key: string; readonly find: RegExp; readonly token: Token; readonly host?: true }[] = [
  { key: "title", find: /(Todo)(?: r\d+| history| invalid)/, token: "base" },
  { key: "revision", find: /Todo(?: history)? (r\d+)/, token: "muted" },
  { key: "held word", find: /Todo r\d+ (held)/, token: "warning" },
  { key: "invalid word", find: /Todo (invalid)$/, token: "error" },
  { key: "counts", find: /(\d+\/\d+ done, \d+ dropped, \d+ open)/, token: "base" },
  { key: "now glyph", find: /(now:) \S/, token: "info" },
  { key: "now text", find: /now: (\S+)/, token: "base" },
  { key: "hold glyph", find: /(\[!\]) hold:/, token: "warning" },
  { key: "hold text", find: /\[!\] (hold:)/, token: "base" },
  { key: "invalid glyph", find: /(\[!\]) (?:todo )?invalid:/, token: "error" },
  { key: "invalid text", find: /\[!\] (?:todo )?(invalid:)/, token: "base" },
  { key: "phase", find: /(Investigation|Implementation|Verification) \d+\/\d+/, token: "base" },
  { key: "pending glyph", find: /(\[ \]) \S/, token: "base" },
  { key: "pending text", find: /\[ \] (\S+)/, token: "base" },
  { key: "done glyph", find: /(\[x\]) \S/, token: "success" },
  { key: "done text", find: /\[x\] (\S+)/, token: "base" },
  { key: "focus glyph", find: /(\[>\]) \S/, token: "info" },
  { key: "focus text", find: /\[>\] (\S+)/, token: "base" },
  { key: "dropped glyph", find: /(\[-\]) \S/, token: "muted" },
  { key: "dropped text", find: /\[-\] (\S+)/, token: "muted" },
  { key: "empty list", find: /(empty list)/, token: "muted" },
  { key: "summary", find: /(todo \d+\/\d+ done, \d+ open)/, token: "base" },
  { key: "summary invalid", find: /\[!\] (todo invalid:)/, token: "base" },
  { key: "session", find: /(session ses_)/, token: "muted" },
  { key: "read-only", find: /(read-only view)/, token: "muted" },
  { key: "host session title", find: /(Todo TUI QA)/, token: "base", host: true },
  { key: "host footer hint", find: /ctrl\+p (commands)/, token: "muted", host: true },
];
// The 200-column layout puts the native sidebar right of column 150; a label
// wrapped inside it only reads correctly when that column band is joined alone.
const SIDEBAR_COLUMN = 150;
function regions(grid: string): string[] {
  const lines = grid.split("\n");
  return [
    collapse(lines.join(" ")),
    collapse(lines.map((line) => line.slice(SIDEBAR_COLUMN)).join(" ")),
    collapse(lines.map((line) => line.slice(0, SIDEBAR_COLUMN)).join(" ")),
  ];
}

// ------------------------------------------------------------ xterm packages
interface HeadlessCell {
  getBgColorMode(): number;
  getBgColor(): number;
  getFgColorMode(): number;
  getFgColor(): number;
}
interface HeadlessLine {
  translateToString(trim?: boolean): string;
  getCell(x: number): HeadlessCell | undefined;
}
interface HeadlessTerminal {
  readonly rows: number;
  readonly cols: number;
  readonly buffer: { readonly active: { getLine(y: number): HeadlessLine | undefined } };
  write(data: Uint8Array | string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  onData(handler: (data: string) => void): { dispose(): void };
}
type HeadlessCtor = new (options: Record<string, unknown>) => HeadlessTerminal;
type Xterm = {
  readonly Terminal: HeadlessCtor;
  readonly browserJs: string;
  readonly browserCss: string;
  readonly source: Record<string, string>;
};

const XTERM_PINS = { "@xterm/headless": "6.0.0", "@xterm/xterm": "5.5.0" } as const;

function cacheEntries(root: string, scope: string, name: string): string[] {
  const dir = join(root, scope);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.startsWith(`${name}@`) && existsSync(join(dir, entry, "package.json")))
    .map((entry) => join(dir, entry))
    .sort()
    .reverse();
}

async function fetchPackage(name: string, version: string, into: string): Promise<string> {
  const meta = (await (await fetch(`https://registry.npmjs.org/${name}/${version}`)).json()) as {
    dist: { tarball: string; integrity: string };
  };
  const bytes = new Uint8Array(await (await fetch(meta.dist.tarball)).arrayBuffer());
  const digest = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (digest !== meta.dist.integrity) throw new Error(`${name}@${version}: integrity mismatch`);
  const target = join(into, name.replace("/", "+") + "@" + version);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const tgz = join(target, "package.tgz");
  writeFileSync(tgz, bytes);
  const untar = Bun.spawnSync(["tar", "-xzf", tgz, "-C", target], { stdout: "pipe", stderr: "pipe" });
  if (untar.exitCode !== 0) throw new Error(`${name}: tar failed: ${untar.stderr.toString()}`);
  return join(target, "package");
}

async function locatePackage(name: string, into: string, source: Record<string, string>): Promise<string> {
  const [scope, bare] = name.split("/") as [string, string];
  const local = join(REPO, "node_modules", scope, bare);
  if (existsSync(join(local, "package.json"))) {
    source[name] = `node_modules ${local}`;
    return local;
  }
  const cache = Bun.spawnSync(["bun", "pm", "cache"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  const cached = cache ? cacheEntries(cache, scope, bare)[0] : undefined;
  if (cached) {
    source[name] = `bun cache ${cached}`;
    return cached;
  }
  const version = XTERM_PINS[name as keyof typeof XTERM_PINS];
  const downloaded = await fetchPackage(name, version, into);
  source[name] = `registry.npmjs.org ${name}@${version} (sha512 verified) -> ${downloaded}`;
  return downloaded;
}

async function loadXterm(): Promise<Xterm> {
  const source: Record<string, string> = {};
  const into = join(EVIDENCE, ".cache");
  const headless = await locatePackage("@xterm/headless", into, source);
  const browser = await locatePackage("@xterm/xterm", into, source);
  const main = (JSON.parse(readFileSync(join(headless, "package.json"), "utf8")) as { main: string }).main;
  const mod = (await import(join(headless, main))) as { Terminal?: HeadlessCtor; default?: { Terminal?: HeadlessCtor } };
  const Terminal = mod.Terminal ?? mod.default?.Terminal;
  if (!Terminal) throw new Error("@xterm/headless did not export Terminal");
  return {
    Terminal,
    browserJs: readFileSync(join(browser, "lib/xterm.js"), "utf8"),
    browserCss: readFileSync(join(browser, "css/xterm.css"), "utf8"),
    source,
  };
}

// ------------------------------------------------------------ local provider
type ToolCall = { readonly tool: string; readonly args: unknown };
type Step =
  | { readonly text: string; readonly hold?: Promise<void> }
  | ToolCall;
type ProviderRequest = {
  readonly t: number;
  readonly kind: string;
  readonly step: number;
  readonly tools: readonly string[];
  readonly lastUser: string;
};
const PASSIVE_USER = /^(<open-gajae-todo-(context|notice)>|<goal-(context|notice)>|<conversation-checkpoint>)/;
const SCENARIO_LINE = /^tui:([a-z-]+)/m;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  return "";
}

type Message = { role: string; content?: unknown; tool_calls?: unknown[] };

class Provider {
  readonly requests: ProviderRequest[] = [];
  readonly scenarios = new Map<string, Step[]>();
  private readonly listeners = new Set<(entry: ProviderRequest) => void>();
  private readonly server: ReturnType<typeof Bun.serve>;
  readonly log: string;
  constructor(dir: string) {
    this.log = join(dir, "provider.jsonl");
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 255,
      fetch: (request) => this.handle(request),
    });
  }
  get port(): number {
    return this.server.port ?? 0;
  }
  get baseURL(): string {
    return `http://127.0.0.1:${this.port}/v1`;
  }
  waitRequest(label: string, predicate: (entry: ProviderRequest) => boolean, timeout = STEP_TIMEOUT): Promise<ProviderRequest> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`timed out: provider request ${label}`));
      }, timeout);
      const listener = (entry: ProviderRequest) => {
        if (!predicate(entry)) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(entry);
      };
      this.listeners.add(listener);
    });
  }
  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/models"))
      return Response.json({ object: "list", data: [{ id: "model-a", object: "model" }] });
    const body = (await request.json().catch(() => null)) as { messages?: Message[]; tools?: { function?: { name?: string } }[] } | null;
    const messages = body?.messages ?? [];
    const tools = (body?.tools ?? []).map((tool) => tool.function?.name ?? "");
    let lastUser = -1;
    messages.forEach((message, index) => {
      if (message.role === "user" && !PASSIVE_USER.test(contentText(message.content))) lastUser = index;
    });
    const last = lastUser >= 0 ? contentText(messages[lastUser]!.content) : "";
    const step = messages
      .slice(lastUser + 1)
      .filter((message) => message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0).length;
    let kind = "other";
    let plan: Step | undefined;
    if (tools.length === 0) kind = "title";
    else if (last.startsWith("<open-gajae-todo-continuation>")) kind = "continuation";
    else {
      const match = last.match(SCENARIO_LINE);
      if (match) {
        kind = `scenario:${match[1]}`;
        plan = this.scenarios.get(match[1]!)?.[step];
      }
    }
    const entry: ProviderRequest = { t: Date.now(), kind, step, tools, lastUser: last.slice(0, 200) };
    this.requests.push(entry);
    writeFileSync(this.log, JSON.stringify(entry) + "\n", { flag: "a" });
    for (const listener of [...this.listeners]) listener(entry);
    const headers = { "content-type": "text/event-stream" };
    const chunk = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({ id: "chatcmpl-tui", object: "chat.completion.chunk", created: 1, model: "model-a", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    const text = (content: string) =>
      new Response(chunk({ role: "assistant", content }, null) + chunk({}, "stop") + "data: [DONE]\n\n", { headers });
    if (kind === "title") return text("Todo TUI QA");
    if (!plan) return text(`acknowledged (${kind}, step ${step})`);
    if ("tool" in plan) {
      const call = plan;
      const delta = {
        role: "assistant",
        tool_calls: [{ index: 0, id: `call_${entry.t}_${step}`, type: "function", function: { name: call.tool, arguments: JSON.stringify(call.args ?? {}) } }],
      };
      return new Response(chunk(delta, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n", { headers });
    }
    const reply = plan;
    if (!reply.hold) return text(reply.text);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(chunk({ role: "assistant", content: reply.text.slice(0, 1) }, null)));
          await reply.hold;
          controller.enqueue(encoder.encode(chunk({ content: reply.text.slice(1) }, null) + chunk({}, "stop") + "data: [DONE]\n\n"));
          controller.close();
        } catch {
          // The host cancelled the request (user interrupt) before the gate opened.
        }
      },
    });
    return new Response(stream, { headers });
  }
  stop(): void {
    this.server.stop(true);
  }
}

function gate(): { readonly hold: Promise<void>; release(): void } {
  let release = () => {};
  const hold = new Promise<void>((done) => {
    release = done;
  });
  return { hold, release };
}

// ------------------------------------------------------------ sandbox
type Sandbox = {
  readonly root: string;
  readonly home: string;
  readonly project: string;
  readonly env: Record<string, string>;
  readonly provider: Provider;
  readonly themeDump: string;
  readonly logFile: string;
  log(): string;
};
const sandboxes: Sandbox[] = [];

// A sandbox-only second plugin: its TUI half writes the host's resolved text
// tokens for the current colour mode (Context.theme/themeMode) to a file, on
// setup and through a palette command, so captures can be checked against the
// host's own token values instead of guessed ones. Nothing of it ships.
function writeThemeProbePlugin(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "open-gajae-tui-theme-probe", version: "0.0.1", type: "module", exports: { ".": "./index.ts", "./tui": "./tui.ts" } }));
  writeFileSync(join(dir, "index.ts"), `import { Plugin } from "@opencode/plugin";\nexport default Plugin.define({ id: "open-gajae-tui-theme-probe", async setup() { return async () => {}; } });\n`);
  writeFileSync(join(dir, "tui.ts"), `import { Plugin } from "@opencode/plugin/tui";
import { writeFileSync } from "node:fs";
const out = process.env.OPEN_GAJAE_THEME_DUMP;
function hex(value: unknown): string {
  const color = value as { toHex?: () => string; r?: number; g?: number; b?: number } | string | undefined;
  if (typeof color === "string") return color.replace("#", "").toLowerCase();
  if (color && typeof color.toHex === "function") return color.toHex().replace("#", "").toLowerCase();
  if (color && typeof color.r === "number") return [color.r, color.g ?? 0, color.b ?? 0].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
  return String(value);
}
function dump(ctx: Plugin.Context): void {
  if (!out) return;
  const text = ctx.theme.text;
  writeFileSync(out, JSON.stringify({
    mode: ctx.themeMode, at: Date.now(),
    base: hex(text.base), muted: hex(text.muted),
    info: hex(text.feedback.info.base), warning: hex(text.feedback.warning.base),
    success: hex(text.feedback.success.base), error: hex(text.feedback.error.base),
    background: hex(ctx.theme.background.base),
  }));
}
export default Plugin.define({
  id: "open-gajae-tui-theme-probe",
  setup(ctx) {
    dump(ctx);
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [{ id: "open-gajae-tui-theme-probe.dump", title: "Theme probe: dump tokens", group: "qa", bind: false, palette: true, run: () => dump(ctx) }],
    }));
    return () => {};
  },
});
`);
  return dir;
}

function readHostTokens(sandbox: Sandbox): HostTokens | undefined {
  if (!existsSync(sandbox.themeDump)) return undefined;
  return JSON.parse(readFileSync(sandbox.themeDump, "utf8")) as HostTokens;
}

function createSandbox(tag: string, pluginDir: string, settings?: Record<string, unknown>, diagnostics = true): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `${tag}-`)));
  const home = join(root, "home");
  const project = join(root, "project");
  const tmp = join(root, "tmp");
  for (const dir of [join(home, ".config/opencode"), join(project, ".open-gajae"), tmp]) mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = {
    PATH: `${join(homedir(), ".bun/bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    TMPDIR: tmp,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    FAKE_API_KEY: "fixture",
  };
  Bun.spawnSync(["git", "init", "-q", project], { env: { ...env, GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(project, "sample.ts"), "export const fixture = true;\n");
  const provider = new Provider(root);
  const themeDump = join(root, "theme-tokens.json");
  env.OPEN_GAJAE_THEME_DUMP = themeDump;
  const diagnosticsPlugin = diagnostics ? writeThemeProbePlugin(join(root, "theme-probe-plugin")) : undefined;
  writeFileSync(
    join(home, ".config/opencode/opencode.jsonc"),
    JSON.stringify(
      {
        model: "fake/model-a",
        providers: {
          fake: {
            name: "Fake",
            env: ["FAKE_API_KEY"],
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: provider.baseURL },
            models: { "model-a": {} },
          },
        },
        plugins: diagnosticsPlugin ? [pluginDir, diagnosticsPlugin] : [pluginDir],
      },
      null,
      2,
    ),
  );
  if (settings) writeFileSync(join(project, ".open-gajae/open-gajae.jsonc"), JSON.stringify(settings, null, 2));
  const logFile = join(home, ".local/share/opencode/log/opencode.log");
  const sandbox: Sandbox = {
    root,
    home,
    project,
    env,
    provider,
    themeDump,
    logFile,
    log: () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : ""),
  };
  sandboxes.push(sandbox);
  return sandbox;
}

function checkIsolation(report: Report, sandbox: Sandbox, label: string): void {
  const version = Bun.spawnSync([HOST, "--version"], { env: sandbox.env, stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  report.check(`${label}: host version is ${HOST_VERSION}`, isSupportedHostVersion(version), version);
  const paths = Bun.spawnSync([HOST, "debug", "paths"], { cwd: sandbox.project, env: sandbox.env, stdout: "pipe", stderr: "pipe" })
    .stdout.toString().trim().split("\n").map((line) => line.trim().split(/\s+/));
  const outside = paths.filter(([, path]) => !path?.startsWith(sandbox.root));
  report.check(`${label}: host paths are all under the disposable root`, paths.length >= 10 && outside.length === 0, { count: paths.length, outside });
  report.check(`${label}: project lives in the OS temporary directory outside the user's home`,
    !sandbox.project.startsWith(homedir()) && sandbox.project.startsWith(realpathSync(tmpdir())), sandbox.project);
}

// ------------------------------------------------------------ host launch
type HostHandle = {
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly description: string;
  stop(): Promise<Record<string, unknown>>;
};

async function launchHost(sandbox: Sandbox, mode: LaunchMode): Promise<HostHandle> {
  if (mode === "standalone")
    return { args: ["--standalone"], env: sandbox.env, description: "opencode --standalone (private in-process server)", stop: async () => ({}) };
  const registration = join(sandbox.home, ".local/state/opencode/service.json");
  if (mode === "service") {
    return {
      args: [],
      env: sandbox.env,
      description: "opencode (default; the TUI spawns `opencode serve --service`)",
      stop: async () => {
        const info = existsSync(registration) ? (JSON.parse(readFileSync(registration, "utf8")) as { pid?: number; url?: string }) : {};
        const stop = Bun.spawnSync([HOST, "service", "stop"], { cwd: sandbox.project, env: sandbox.env, stdout: "pipe", stderr: "pipe" });
        if (info.pid && isAlive(info.pid)) process.kill(info.pid, "SIGKILL");
        return { servicePid: info.pid ?? null, serviceUrl: info.url ?? null, serviceStopExit: stop.exitCode, alive: info.pid ? isAlive(info.pid) : false };
      },
    };
  }
  const server = Bun.spawn([HOST, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: sandbox.project,
    env: sandbox.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const banner = await readUntil([server.stdout, server.stderr], /server password (\S+)/, BOOT_TIMEOUT, "serve banner");
  const url = banner.match(/listening on (http:\/\/\S+)/)?.[1];
  const password = banner.match(/server password (\S+)/)?.[1];
  if (!url || !password) throw new Error(`serve banner unreadable: ${banner.slice(0, 300)}`);
  mkdirSync(dirname(registration), { recursive: true });
  writeFileSync(registration, JSON.stringify({ id: "open-gajae-tui-probe", version: "2.0.26", url, pid: server.pid, password }));
  return {
    args: ["--server", url],
    env: { ...sandbox.env, OPENCODE_PASSWORD: password },
    description: "opencode serve (project cwd) + opencode --server; registration file written for public service discovery",
    stop: async () => {
      if (server.exitCode === null) server.kill("SIGTERM");
      const exit = await Promise.race([server.exited, new Promise<string>((done) => setTimeout(() => done("timeout"), 5_000))]);
      if (server.exitCode === null) server.kill("SIGKILL");
      return { servePid: server.pid, serveUrl: url, serveExit: exit, alive: isAlive(server.pid) };
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readUntil(streams: ReadableStream<Uint8Array>[], pattern: RegExp, timeout: number, label: string): Promise<string> {
  let text = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out: ${label}\n${text.slice(-500)}`)), timeout);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(text);
    };
    for (const stream of streams) {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      void (async () => {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (pattern.test(text)) {
            finish();
            // Keep draining so the child never blocks on a full pipe.
          }
        }
      })();
    }
  });
}

// ------------------------------------------------------------ PTY terminal
type Mark = { readonly offset: number; readonly cols: number; readonly rows: number };
type Waiter = { readonly test: (grid: string) => boolean; readonly resolve: () => void };

class Tui {
  readonly chunks: Buffer[] = [];
  readonly marks: Mark[] = [];
  offset = 0;
  /** Bytes the emulator has parsed; a capture records this so a replay to it reproduces the grid exactly. */
  parsed = 0;
  frames = 0;
  private inFrame = false;
  private frameBuffer = "";
  private frameBufferOffset = 0;
  private frameStart = 0;
  private readonly repaints: { start: number; end: number; maxRow: number }[] = [];
  readonly resizeAcknowledgments: { offset: number; cols: number; rows: number; start: number; end: number; maxRow: number }[] = [];
  private readonly waiters = new Set<Waiter>();
  private readonly idle: (() => void)[] = [];
  private readonly term: HeadlessTerminal;
  private proc?: ReturnType<typeof Bun.spawn>;
  cols: number;
  rows: number;

  constructor(private readonly Terminal: HeadlessCtor, cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
    this.marks.push({ offset: 0, cols, rows });
  }

  start(args: readonly string[], cwd: string, env: Record<string, string>): void {
    this.proc = Bun.spawn([HOST, ...args], {
      cwd,
      env,
      terminal: {
        cols: this.cols,
        rows: this.rows,
        data: (_terminal, data) => this.onData(data),
      },
    });
    this.term.onData((reply) => {
      try {
        this.proc?.terminal?.write(reply);
      } catch {
        // The host exited; late terminal replies have nowhere to go.
      }
    });
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }
  get exitCode(): number | null {
    return this.proc?.exitCode ?? null;
  }

  private onData(data: Uint8Array): void {
    const buffer = Buffer.from(data);
    this.chunks.push(buffer);
    const end = this.offset + buffer.length;
    this.offset = end;
    // Keep synchronization markers intact even when the PTY splits one across
    // reads. A repaint is acknowledged only after its closing marker is parsed.
    this.frameBuffer += buffer.toString("latin1");
    for (;;) {
      const marker = this.inFrame ? "\x1b[?2026l" : "\x1b[?2026h";
      const index = this.frameBuffer.indexOf(marker);
      if (index < 0) {
        if (!this.inFrame && this.frameBuffer.length > marker.length - 1) {
          const dropped = this.frameBuffer.length - (marker.length - 1);
          this.frameBuffer = this.frameBuffer.slice(dropped);
          this.frameBufferOffset += dropped;
        }
        break;
      }
      if (this.inFrame) {
        const rows = [...this.frameBuffer.slice(0, index).matchAll(/\x1b\[(\d+)(?:;\d+)?[Hf]/g)].map((match) => Number(match[1]));
        this.repaints.push({ start: this.frameStart, end: this.frameBufferOffset + index + marker.length, maxRow: Math.max(0, ...rows) });
        this.frames++;
      } else this.frameStart = this.frameBufferOffset + index;
      this.inFrame = !this.inFrame;
      this.frameBuffer = this.frameBuffer.slice(index + marker.length);
      this.frameBufferOffset += index + marker.length;
    }
    this.term.write(data, () => {
      this.parsed = end;
      this.evaluate();
    });
  }

  private evaluate(): void {
    const grid = this.grid().join("\n");
    for (const waiter of [...this.waiters]) {
      if (!waiter.test(grid)) continue;
      this.waiters.delete(waiter);
      waiter.resolve();
    }
    if (!this.inFrame && this.parsed === this.offset) for (const done of this.idle.splice(0)) done();
  }

  grid(): string[] {
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++) lines.push(this.term.buffer.active.getLine(y)?.translateToString(true) ?? "");
    return lines;
  }
  flat(): string {
    return collapse(this.grid().join(" "));
  }
  cell(y: number, x: number): { fg: string; bg: string } | undefined {
    const cell = this.term.buffer.active.getLine(y)?.getCell(x);
    if (!cell) return undefined;
    return {
      fg: cell.getFgColorMode() === 0 ? "default" : hex6(cell.getFgColor()),
      bg: cell.getBgColorMode() === 0 ? "default" : hex6(cell.getBgColor()),
    };
  }
  /** The most common background of the first rows, as rrggbb or a palette index. */
  background(): string {
    const counts = new Map<string, number>();
    for (let y = 0; y < Math.min(3, this.term.rows); y++) {
      const line = this.term.buffer.active.getLine(y);
      for (let x = 0; x < this.term.cols; x += 7) {
        const cell = line?.getCell(x);
        if (!cell) continue;
        const key = cell.getBgColorMode() === 0 ? "default" : cell.getBgColor().toString(16).padStart(6, "0");
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "default";
  }

  private wait(label: string, test: (grid: string) => boolean, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (test(this.grid().join("\n"))) return resolve();
      const waiter: Waiter = {
        test,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`timed out: ${label}\n--- grid ---\n${this.grid().map((l) => l.trimEnd()).filter(Boolean).join("\n")}`));
      }, timeout);
      this.waiters.add(waiter);
    });
  }
  /** Resolves once every pattern is on screen (each one is an event barrier). */
  async expect(label: string, patterns: readonly (RegExp | string)[], timeout = STEP_TIMEOUT): Promise<void> {
    for (const pattern of patterns) {
      const test = typeof pattern === "string" ? (grid: string) => regions(grid).some((region) => region.includes(pattern)) : (grid: string) => pattern.test(grid);
      await this.wait(`${label}: ${String(pattern)}`, test, timeout);
    }
    await this.frameEnd();
  }
  until(label: string, test: () => boolean, timeout = STEP_TIMEOUT): Promise<void> {
    return this.wait(label, test, timeout);
  }
  absent(label: string, pattern: RegExp, timeout = STEP_TIMEOUT): Promise<void> {
    return this.wait(`${label}: gone ${pattern}`, (grid) => !pattern.test(grid), timeout);
  }
  /** Resolves at the next synchronized-output frame boundary, or at once outside a frame. */
  frameEnd(): Promise<void> {
    if (!this.inFrame && this.parsed === this.offset) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out: synchronized PTY frame end")), STEP_TIMEOUT);
      this.idle.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  /** Resolves once every byte received so far has been parsed into the grid. */
  flush(): Promise<void> {
    return new Promise((resolve) => this.term.write("", () => resolve()));
  }
  send(text: string): void {
    this.proc?.terminal?.write(text);
  }
  async type(text: string, label: string): Promise<void> {
    this.send(text);
    await this.expect(label, [text]);
  }
  async resize(cols: number, rows: number): Promise<void> {
    if (cols === this.cols && rows === this.rows) return;
    await this.frameEnd();
    await this.flush();
    const mark = { offset: this.offset, cols, rows };
    // These two test geometries have different bottom rows. The host's full
    // post-resize repaint positions its footer on that row; an old-size frame
    // cannot acknowledge it. Subscribe before sending SIGWINCH through the PTY.
    const acknowledged = this.wait(`host repaint after resize ${cols}x${rows}`, () =>
      this.repaints.some((frame) => frame.start >= mark.offset && frame.maxRow === rows && this.parsed >= frame.end), STEP_TIMEOUT);
    this.cols = cols;
    this.rows = rows;
    this.marks.push(mark);
    this.term.resize(cols, rows);
    this.proc?.terminal?.resize(cols, rows);
    await acknowledged;
    const repaint = this.repaints.find((frame) => frame.start >= mark.offset && frame.maxRow === rows && this.parsed >= frame.end);
    if (!repaint) throw new Error("acknowledged resize has no matching repaint receipt");
    this.resizeAcknowledgments.push({ ...mark, ...repaint });
  }
  stream(): Buffer {
    return Buffer.concat(this.chunks);
  }
  async kill(): Promise<number | null> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return proc?.exitCode ?? null;
    proc.kill("SIGTERM");
    await Promise.race([proc.exited, new Promise((done) => setTimeout(done, 5_000))]);
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await Promise.race([proc.exited, new Promise((done) => setTimeout(done, 2_000))]);
    return proc.exitCode;
  }
}

// ------------------------------------------------------------ captures
type Capture = {
  readonly id: string;
  readonly run: string;
  readonly state: string;
  readonly theme: string;
  readonly cols: number;
  readonly rows: number;
  readonly offset: number;
  readonly marks: readonly Mark[];
  readonly background: string;
  readonly colors: Record<string, { fg: string; bg: string; token: Token; host: boolean; contrast: number | null }>;
  readonly files: { txt: string; ansi?: string; png?: string };
  textMatch?: boolean;
};

/** Foreground/background of the first cell of each sampled label on screen. */
function sampleColors(tui: Tui): Capture["colors"] {
  const lines = tui.grid();
  const colors: Capture["colors"] = {};
  for (const sample of SAMPLES) {
    let found: { y: number; x: number } | undefined;
    for (let y = 0; y < lines.length && !found; y++) {
      const match = sample.find.exec(lines[y]!);
      if (match && match[1] !== undefined) found = { y, x: match.index + match[0].indexOf(match[1]) };
    }
    if (!found) continue;
    const cell = tui.cell(found.y, found.x);
    if (!cell) continue;
    colors[sample.key] = { ...cell, token: sample.token, host: sample.host === true, contrast: cell.fg === "default" || cell.bg === "default" ? null : contrast(cell.fg, cell.bg) };
  }
  return colors;
}

class Run {
  readonly captures: Capture[] = [];
  readonly events: string[] = [];
  readonly receipts: Record<string, unknown> = {};
  readonly tokens: Partial<Record<string, HostTokens>> = {};
  constructor(readonly name: string, readonly kind: "matrix" | "evidence" | "registry" | "disabled", readonly tui: Tui, readonly report: Report) {}

  note(event: string): void {
    this.events.push(`${new Date().toISOString()} ${event}`);
  }

  async capture(state: string, theme: string, options: { primary?: string } = {}): Promise<Capture> {
    const tui = this.tui;
    await tui.frameEnd();
    await tui.flush();
    const offset = tui.parsed;
    const size = `${tui.cols}x${tui.rows}`;
    const id = options.primary ? `${this.name}-${options.primary}` : `${this.name}-${state}-${theme}-${size}`;
    const txt = join(EVIDENCE, `${id}.txt`);
    writeFileSync(txt, tui.grid().map((line) => line.trimEnd()).join("\n") + "\n");
    const capture: Capture = {
      id,
      run: this.name,
      state,
      theme,
      cols: tui.cols,
      rows: tui.rows,
      offset,
      marks: tui.marks.filter((mark) => mark.offset <= offset),
      background: tui.background(),
      colors: sampleColors(tui),
      files: { txt },
    };
    if (options.primary) {
      const ansi = join(EVIDENCE, `${id}.ansi`);
      writeFileSync(ansi, tui.stream().subarray(0, offset));
      writeFileSync(`${ansi}.json`, JSON.stringify({ bytes: offset, marks: capture.marks, note: "raw PTY bytes from host start to this capture; apply marks (resize) at the given byte offsets when replaying" }, null, 2));
      capture.files.ansi = ansi;
    }
    this.captures.push(capture);
    this.note(`capture ${id} at byte ${offset}`);
    return capture;
  }

  /** Grid assertions on a capture: every expected fragment present, none of the forbidden ones. */
  assert(capture: Capture, expected: readonly (RegExp | string)[], forbidden: readonly (RegExp | string)[] = []): void {
    const grid = readFileSync(capture.files.txt, "utf8");
    const bands = regions(grid);
    for (const fragment of expected)
      this.report.check(`${capture.id}: shows ${typeof fragment === "string" ? `"${fragment}"` : String(fragment)}`,
        typeof fragment === "string" ? bands.some((band) => band.includes(fragment)) : fragment.test(grid), { missing: String(fragment) });
    for (const pattern of forbidden) {
      const hit = typeof pattern === "string" ? bands.some((band) => band.includes(pattern)) : pattern.test(grid);
      this.report.check(`${capture.id}: never shows ${String(pattern)}`, !hit);
    }
    // Accent glyphs are judged by token equality (same contrast as the host's
    // own use of that token); the plain floors apply to text tokens only.
    const samples = Object.entries(capture.colors).filter(([, color]) => !color.host);
    const unreadable = samples.filter(([, color]) => color.token === "muted" && color.contrast !== null && color.contrast < MIN_CONTRAST);
    if (samples.some(([, color]) => color.token === "muted"))
      this.report.check(`${capture.id}: muted labels readable against their background (contrast >= ${MIN_CONTRAST}:1)`, unreadable.length === 0,
        Object.fromEntries(unreadable.map(([label, color]) => [label, color])));
    const tokens = this.tokens[capture.theme];
    if (samples.length > 0) {
      const mismatched = samples.filter(([, color]) => !tokens || color.fg !== tokens[color.token]).map(([label, color]) => [label, { fg: color.fg, expected: tokens?.[color.token] ?? "host tokens not captured", token: color.token }]);
      this.report.check(`${capture.id}: every sampled label uses the host's own ${capture.theme} theme token`, tokens !== undefined && mismatched.length === 0, Object.fromEntries(mismatched));
    }
    const weakBase = samples.filter(([, color]) => color.token === "base" && color.contrast !== null && color.contrast < BASE_CONTRAST).map(([label, color]) => [label, color.contrast]);
    if (samples.some(([, color]) => color.token === "base"))
      this.report.check(`${capture.id}: host-primary-text labels reach ${BASE_CONTRAST}:1`, weakBase.length === 0, Object.fromEntries(weakBase));
  }

  /** Each label sits on its own row and is never split against another label on the same row. */
  rows(capture: Capture, labels: readonly string[]): void {
    const lines = readFileSync(capture.files.txt, "utf8").split("\n");
    const rows = labels.map((label) => lines.findIndex((line) => collapse(line).includes(label)));
    const distinct = new Set(rows.filter((row) => row >= 0)).size === rows.filter((row) => row >= 0).length;
    this.report.check(`${capture.id}: ${labels.length} labels on separate rows (no overlap)`, rows.every((row) => row >= 0) && distinct, Object.fromEntries(labels.map((label, i) => [label, rows[i]])));
  }
}

// ------------------------------------------------------------ TUI driving
async function cycleAgent(tui: Tui, target: RegExp): Promise<number> {
  const agentLine = () => tui.grid().find((line) => /· model-a/.test(line))?.trim() ?? "";
  for (let presses = 1; presses <= 12; presses++) {
    const before = agentLine();
    tui.send(KEY.shiftTab);
    await tui.until(`agent cycle press ${presses}`, () => agentLine() !== before, 4_000).catch(() => undefined);
    if (target.test(agentLine())) return presses;
  }
  throw new Error(`agent cycling never reached ${target}: ${agentLine()}`);
}

async function palette(tui: Tui, command: string, opened: RegExp): Promise<void> {
  tui.send(KEY.ctrlP);
  await tui.expect("palette open", [/Commands/]);
  await tui.type(command, `palette filter ${command}`);
  tui.send(KEY.enter);
  await tui.expect(`palette ran ${command}`, [opened]);
}

async function setColorMode(tui: Tui, mode: "light" | "dark"): Promise<string> {
  await palette(tui, "Color mode", /●\s*Color mode\s+\w+/);
  const value = () => tui.grid().join("\n").match(/●\s*Color mode\s+(\w+)/)?.[1] ?? "";
  for (let presses = 0; presses < 4 && value() !== mode; presses++) {
    const before = value();
    tui.send(KEY.right);
    await tui.until(`color mode change from ${before}`, () => value() !== "" && value() !== before, 10_000);
  }
  const reached = value();
  tui.send(KEY.esc);
  await tui.absent("settings closed", /Appearance/);
  await tui.frameEnd();
  return reached;
}

function stateFile(project: string): string | undefined {
  const root = join(project, ".open-gajae");
  if (!existsSync(root)) return undefined;
  for (const folder of readdirSync(root)) {
    const file = join(root, folder, "state/todo.json");
    if (existsSync(file)) return file;
  }
  return undefined;
}

function hostLogFindings(log: string): { warnError: string[]; singletonRenderer: string[]; pluginFailures: string[]; pluginLoads: number; locations: string[] } {
  const lines = log.split("\n");
  const trim = (line: string) => line.replace(/^timestamp=\S+ /, "").slice(0, 300);
  return {
    warnError: lines.filter((line) => /level=(WARN|ERROR)/.test(line)).map(trim),
    singletonRenderer: lines.filter((line) => /singleton|Keymap\.Provider|renderer error|RangeError|TypeError/i.test(line)).map(trim),
    pluginFailures: lines.filter((line) => /plugin operation failed|\[open-gajae[^\]]*\].*(error|failed)/i.test(line)).map(trim),
    pluginLoads: lines.filter((line) => /loading plugin/.test(line) && !/theme-probe-plugin/.test(line)).length,
    locations: lines.filter((line) => /location services booted/.test(line)).map((line) => line.match(/directory=(\S+)/)?.[1] ?? "?"),
  };
}

// ------------------------------------------------------------ the matrix
async function runDisabled(report: Report, xterm: Xterm): Promise<Run> {
  const sandbox = createSandbox("og-tui-disabled", REPO, { todo: { enabled: DISABLED_CONTROL_ENABLED } });
  const run = new Run("dev-standalone-disabled", "disabled",
    new Tui(xterm.Terminal, SIZES.wide.cols, SIZES.wide.rows), report);
  runs.push(run);
  run.receipts.sandbox = sandbox.root;
  run.receipts.pluginDir = REPO;
  run.receipts.launch = "standalone";
  run.receipts.settings = { todo: { enabled: DISABLED_CONTROL_ENABLED } };
  run.receipts.providerPort = sandbox.provider.port;
  checkIsolation(report, sandbox, run.name);
  const { tui } = run;
  let host: HostHandle | undefined;
  try {
    // Create a native session without a model turn, stop that bootstrap
    // backend, then seed at the store's exact native timestamp/path.
    const bootstrap = await launchHost(sandbox, "attach");
    let session: { id: string; time: { created: unknown } };
    try {
      const registration = z.object({ url: z.string(), password: z.string() }).parse(
        JSON.parse(readFileSync(join(sandbox.home, ".local/state/opencode/service.json"), "utf8")));
      const response = await fetch(`${registration.url}/api/session`, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString("base64")}`,
          "content-type": "application/json" },
        body: JSON.stringify({ agent: "open-gajae", title: "Disabled feature QA" }),
        signal: AbortSignal.timeout(BOOT_TIMEOUT),
      });
      if (!response.ok) throw new Error(`disabled session create: HTTP ${response.status}`);
      session = z.object({ data: z.object({ id: z.string(), time: z.object({ created: z.unknown() }) }) })
        .parse(await response.json()).data;
    } finally {
      run.receipts.bootstrapStop = await bootstrap.stop();
      rmSync(join(sandbox.home, ".local/state/opencode/service.json"), { force: true });
    }
    const state = new StateStore(sandbox.project, async () => epochMillis(session.time.created));
    const seeded = await new TodoStore(state).apply(session.id, { op: "init", list: BOARD });
    if (seeded.disposition !== "applied") throw new Error(`disabled seed: ${JSON.stringify(seeded)}`);
    const file = join(await state.resolveSessionDir(session.id), "state/todo.json");
    const before = readFileSync(file, "utf8");
    run.receipts.seed = { sessionID: session.id, file, bytes: before, revision: todoSnapshotSchema.parse(JSON.parse(before)).revision };
    host = await launchHost(sandbox, "standalone");
    run.receipts.host = host.description;
    sandbox.provider.scenarios.set("disabled", [{ text: "Disabled fixture turn complete." }]);
    tui.start([...host.args, "--session", session.id], sandbox.project, host.env);
    run.receipts.tuiPid = tui.pid;
    await tui.expect("disabled selected session", [/ctrl\+p commands/], BOOT_TIMEOUT);
    const request = sandbox.provider.waitRequest("disabled full turn", (entry) => entry.kind === "scenario:disabled");
    await tui.type("tui:disabled", "disabled turn input");
    tui.send(KEY.enter);
    await request;
    await tui.expect("disabled full reply painted", ["Disabled fixture turn complete."]);
    await tui.absent("disabled full turn idle", /esc (again to )?interrupt/);
    if (DISABLED_CONTROL_ENABLED) await tui.expect("enabled fault control sidebar", [REVISION]);
    // Each resize subscribes before SIGWINCH and resolves only after the
    // requested host geometry has been parsed. Negative captures cannot pass
    // on a blank/bootstrap grid.
    await tui.resize(SIZES.narrow.cols, SIZES.narrow.rows);
    const narrow = await run.capture("disabled-narrow", "dark", { primary: "disabled-narrow" });
    const narrowGrid = readFileSync(narrow.files.txt, "utf8");
    report.check(`${run.name}: no narrow todo summary after parsed repaint`,
      !/\btodo (?:\d+\/\d+ done|empty list|invalid:|unavailable:)/.test(narrowGrid), { capture: narrow.id });
    await tui.resize(SIZES.wide.cols, SIZES.wide.rows);
    const wide = await run.capture("disabled-wide", "dark", { primary: "disabled-wide" });
    const sidebar = tui.grid().map((line) => line.slice(SIDEBAR_COLUMN)).join("\n");
    report.check(`${run.name}: no Todo sidebar cells after parsed repaint`,
      !/\bTodo\b/.test(sidebar), { capture: wide.id, sidebar });
    tui.send(KEY.ctrlP);
    await tui.expect("disabled palette painted", [/Commands/]);
    await tui.type("Todo: view history", "disabled history palette query");
    const paletteCapture = await run.capture("disabled-palette", "dark", { primary: "disabled-palette" });
    // The query itself occupies one row. A registered command adds another.
    const commandRows = tui.grid().filter((line) => line.includes("Todo: view history"));
    report.check(`${run.name}: Todo view history palette command absent`,
      commandRows.length === 1, { capture: paletteCapture.id, commandRows });
    tui.send(KEY.esc);
    await tui.absent("disabled palette closed", /Commands\s+esc/);
    const after = readFileSync(file, "utf8");
    report.check(`${run.name}: seeded board bytes and revision unchanged`,
      after === before && todoSnapshotSchema.parse(JSON.parse(after)).revision ===
        todoSnapshotSchema.parse(JSON.parse(before)).revision, { before, after });
    run.receipts.afterBytes = after;
    run.receipts.providerRequests = sandbox.provider.requests;
  } catch (error) {
    report.check(`${run.name}: disabled launch ran to completion`, false, String(error));
  } finally {
    run.receipts.tuiExit = await tui.kill();
    run.receipts.hostStop = await host?.stop();
    sandbox.provider.stop();
    run.receipts.resizeAcknowledgments = tui.resizeAcknowledgments;
    report.check(`${run.name}: parsed repaint receipts at both geometries`,
      tui.resizeAcknowledgments.length === 2 &&
      tui.resizeAcknowledgments.every((ack) => ack.end > ack.offset && ack.maxRow === ack.rows),
      tui.resizeAcknowledgments);
    writeFileSync(join(EVIDENCE, `${run.name}-host.log`), sandbox.log());
    writeFileSync(join(EVIDENCE, `${run.name}-stream.ansi`), tui.stream());
    cleanupSandbox(run, sandbox);
  }
  return run;
}

// The matrix observes board states, not the controller loop (task 7a):
// automatic resumes would race the captures with stagnation holds.
const MATRIX_SETTINGS = { todo: { continuation: false } };

async function runMatrix(report: Report, xterm: Xterm, mode: InstallMode, launch: LaunchMode, pluginDir: string): Promise<Run> {
  const sandbox = createSandbox(`og-tui-${mode}-${launch}`, pluginDir, MATRIX_SETTINGS);
  const run = new Run(`${mode}-${launch}`, "matrix", new Tui(xterm.Terminal, SIZES.wide.cols, SIZES.wide.rows), report);
  runs.push(run);
  run.receipts.sandbox = sandbox.root;
  run.receipts.pluginDir = pluginDir;
  run.receipts.launch = launch;
  checkIsolation(report, sandbox, run.name);
  const host = await launchHost(sandbox, launch);
  const tokens = async (expected: "light" | "dark") => {
    tui.send(KEY.ctrlP);
    await tui.expect("palette for theme dump", [/Commands/]);
    await tui.type("Theme probe: dump tokens", "palette filter theme dump");
    tui.send(KEY.enter);
    await tui.absent("palette closed after theme dump", /Commands\s+esc/);
    const dumped = readHostTokens(sandbox);
    report.check(`${run.name}: host theme tokens captured for ${expected} mode`, dumped?.mode === expected, dumped);
    if (dumped?.mode === expected) run.tokens[expected] = dumped;
    run.receipts.hostTokens = run.tokens;
  };
  run.receipts.host = host.description;
  const { tui } = run;
  const provider = sandbox.provider;
  const activeGate = gate();
  const stopGate = gate();
  provider.scenarios.set("active", [
    { tool: "todo", args: { op: "init", list: BOARD } },
    { tool: "todo", args: { op: "done", task: "Read the plan and task block" } },
    { tool: "todo", args: { op: "start", task: FOCUS } },
    { text: "Board is active while this reply streams.", hold: activeGate.hold },
  ]);
  provider.scenarios.set("question", [
    { tool: "question", args: { questions: [{ question: "Which capture should be primary?", header: "Primary capture", options: [{ label: "Held board (Recommended)", description: "focus, hold and counts together" }, { label: "Active board", description: "no hold line" }] }] } },
    { text: "Continuing after the answer." },
  ]);
  provider.scenarios.set("stop", [{ text: "This reply is interrupted by the user.", hold: stopGate.hold }]);
  provider.scenarios.set("terminal", [
    { tool: "todo", args: { op: "start", task: FOCUS } },
    { tool: "todo", args: { op: "done", phase: "Investigation" } },
    { tool: "todo", args: { op: "done", phase: "Implementation" } },
    { tool: "todo", args: { op: "drop", phase: "Verification" } },
    { text: "Every item is terminal now." },
  ]);
  provider.scenarios.set("empty", [{ tool: "todo", args: { op: "rm" } }, { text: "The board was cleared." }]);
  provider.scenarios.set("invalid", [{ text: "Reading the board after corruption." }]);

  const counts = "1/7 done, 0 dropped, 6 open";
  const summary = `todo 1/7 done, 6 open | now: ${FOCUS}`;
  const injectionText = "Render \uFFFD[31mANSI\uFFFD[0m <b>markup</b> label inert";
  // The 40-column sidebar word-wraps the literal label (the host breaks after
  // "</"), so the inert rendering is checked fragment by fragment there and as
  // one line in the fullscreen panel.
  const injectionFragments = ["Render \uFFFD[31mANSI\uFFFD[0m", "<b>markup", "label inert"];
  const COMPLETE = /\d+\/7 done, 0 dropped, 0 open/;
  const COUNTS = /\d+\/\d+ done, \d+ dropped, \d+ open/;
  const prompt = async (scenario: string) => {
    await tui.absent(`idle before tui:${scenario}`, /esc (again to )?interrupt/);
    await tui.type(`tui:${scenario}`, `type tui:${scenario}`);
    tui.send(KEY.enter);
  };
  let hashBefore = "";
  try {
    tui.start(host.args, sandbox.project, host.env);
    run.receipts.tuiPid = tui.pid ?? null;
    await tui.expect("home screen", [/ctrl\+p commands/], BOOT_TIMEOUT);
    console.log(`TODO_TUI_READY ${run.name} pid=${tui.pid}`);
    run.receipts.agentPresses = await cycleAgent(tui, /Open-Gajae · model-a/);
    await tokens("dark");

    // --- active: focus, counts, phases, injection label, both sizes/themes.
    const activeRequest = provider.waitRequest("active text step", (e) => e.kind === "scenario:active" && e.step === 3, 90_000);
    await prompt("active");
    await activeRequest;
    await tui.expect("active sidebar", [REVISION, counts, `now: ${FOCUS}`, "Investigation 1/2", "Implementation 0/3", "Verification 0/2", `[>] ${FOCUS}`, "[x] Read the plan and task block"]);
    const activeWide = await run.capture("active", "dark");
    run.assert(activeWide, [REVISION, counts, `now: ${FOCUS}`, "Investigation 1/2", "Implementation 0/3", "Verification 0/2", `[>] ${FOCUS}`, "[x] Read the plan and task block", "[ ] Survey the host contracts", ...injectionFragments], [HELD, /hold:/, /Todo invalid/]);
    run.rows(activeWide, ["Todo r", counts, `now: ${FOCUS}`, "Investigation 1/2", "Implementation 0/3", "Verification 0/2"]);
    report.check(`${activeWide.id}: injected ESC/markup label is rendered inert (ESC shown as U+FFFD, markup literal)`, injectionFragments.every((fragment) => regions(readFileSync(activeWide.files.txt, "utf8"))[1]!.includes(fragment)));
    await tui.resize(SIZES.narrow.cols, SIZES.narrow.rows);
    await tui.expect("active narrow summary", [summary]);
    const activeNarrow = await run.capture("active", "dark");
    run.assert(activeNarrow, [summary], [/hold:/, REVISION]);
    run.receipts.colorModeLight = await setColorMode(tui, "light");
    await tui.expect("active narrow light", [summary]);
    await tokens("light");
    const activeNarrowLight = await run.capture("active", "light");
    run.assert(activeNarrowLight, [summary]);
    await tui.resize(SIZES.wide.cols, SIZES.wide.rows);
    await tui.expect("active wide light", [REVISION, counts, `now: ${FOCUS}`]);
    const activeWideLight = await run.capture("active", "light");
    run.assert(activeWideLight, [REVISION, counts, `now: ${FOCUS}`, "Investigation 1/2"], [HELD]);
    report.check(`${run.name}: light and dark backgrounds differ`, activeWideLight.background !== activeWide.background, { dark: activeWide.background, light: activeWideLight.background });
    await palette(tui, "Todo: view history", /Todo history/);
    await tui.expect("light panel", ["read-only view; esc closes", counts]);
    const panelLight = await run.capture("panel", "light");
    run.assert(panelLight, ["Todo history", counts, `now: ${FOCUS}`, injectionText, "read-only view; esc closes; the todo tool is the only writer"]);
    tui.send(KEY.esc);
    await tui.absent("light panel closed", /Todo history/);
    run.receipts.colorModeDark = await setColorMode(tui, "dark");
    await tui.expect("active wide dark again", [REVISION, counts]);
    report.check(`${run.name}: live dark->light switch recoloured the sidebar (base text differs between modes)`,
      activeWide.colors.counts?.fg !== undefined && activeWideLight.colors.counts?.fg !== undefined && activeWide.colors.counts.fg !== activeWideLight.colors.counts.fg,
      { dark: activeWide.colors.counts, light: activeWideLight.colors.counts });

    // --- history panel via the palette; Esc closes; keys never write.
    const file = stateFile(sandbox.project);
    hashBefore = file ? sha256(readFileSync(file)) : "";
    report.check(`${run.name}: session state file exists`, Boolean(file), file);
    await palette(tui, "Todo: view history", /Todo history/);
    await tui.expect("panel content", ["Todo history", "read-only view; esc closes; the todo tool is the only writer", counts, `now: ${FOCUS}`, "[x] Read the plan and task block", `[>] ${FOCUS}`]);
    const panelWide = await run.capture("panel", "dark");
    run.assert(panelWide, ["Todo history", "session ses_", counts, `now: ${FOCUS}`, "Investigation 1/2", "Implementation 0/3", "Verification 0/2", "[x] Read the plan and task block", "[ ] Survey the host contracts", `[>] ${FOCUS}`, injectionText, "read-only view; esc closes; the todo tool is the only writer"]);
    report.check(`${panelWide.id}: injected label is one intact literal line in the fullscreen panel`, readFileSync(panelWide.files.txt, "utf8").split("\n").some((line) => line.includes(`[ ] ${injectionText}`)));
    for (const key of [KEY.down, KEY.down, KEY.down, KEY.pageDown, KEY.up, KEY.pageUp, "j", "k"]) tui.send(key);
    await tui.expect("panel after navigation keys", ["Todo history", "read-only view; esc closes"]);
    const panelNav = await run.capture("panel-after-keys", "dark");
    run.assert(panelNav, ["Todo history", "read-only view; esc closes; the todo tool is the only writer"]);
    tui.send(KEY.esc);
    await tui.absent("panel closed", /Todo history/);
    await tui.expect("sidebar back after panel", [REVISION, counts]);
    const hashAfter = file ? sha256(readFileSync(file)) : "";
    report.check(`${run.name}: key navigation and panel open/close left state bytes unchanged`, hashBefore !== "" && hashBefore === hashAfter, { before: hashBefore, after: hashAfter });
    await tui.resize(SIZES.narrow.cols, SIZES.narrow.rows);
    await tui.expect("narrow before panel", [summary]);
    await palette(tui, "Todo: view history", /Todo history/);
    await tui.expect("narrow panel", ["read-only view; esc closes"]);
    const panelNarrow = await run.capture("panel", "dark");
    run.assert(panelNarrow, ["Todo history", counts, `now: ${FOCUS}`, "read-only view; esc closes; the todo tool is the only writer"]);
    tui.send(KEY.esc);
    await tui.absent("narrow panel closed", /Todo history/);
    report.check(`${run.name}: narrow panel left state bytes unchanged`, file !== undefined && sha256(readFileSync(file)) === hashBefore);

    // --- repeated interruptions: each resize is acknowledged while streaming.
    await tui.resize(SIZES.wide.cols, SIZES.wide.rows);
    await tui.resize(SIZES.narrow.cols, SIZES.narrow.rows);
    await tui.resize(SIZES.wide.cols, SIZES.wide.rows);
    await tui.resize(SIZES.narrow.cols, SIZES.narrow.rows);
    await tui.resize(SIZES.wide.cols, SIZES.wide.rows);
    await tui.expect("after resize burst", [REVISION, counts, `now: ${FOCUS}`, "Verification 0/2"]);
    const burst = await run.capture("active-after-resize-burst", "dark");
    run.assert(burst, [REVISION, counts, `now: ${FOCUS}`, "Investigation 1/2", "Implementation 0/3", "Verification 0/2"], [/hold:/, HELD]);
    activeGate.release();
    await tui.expect("active reply finished", ["Board is active while this reply streams."]);

    // --- held by an unanswered question (form hold).
    await prompt("question");
    await tui.expect("question hold", [/hold: (unanswered_form|form_state_unknown)/, HELD, "Which capture should be primary?", "Held board (Recommended)", "enter submit"]);
    const questionWide = await run.capture("held-question", "dark");
    const questionHold = readFileSync(questionWide.files.txt, "utf8").match(/hold: (\w+)/)?.[1] ?? "";
    run.receipts.questionHold = questionHold;
    report.check(`${questionWide.id}: question hold reason is unanswered_form`, questionHold === "unanswered_form", questionHold);
    run.assert(questionWide, [HELD, counts, `now: ${FOCUS}`, "Which capture should be primary?", "Held board (Recommended)"], [COMPLETE, /Todo invalid/]);
    await tui.resize(SIZES.narrow.cols, SIZES.narrow.rows);
    await tui.expect("question narrow", [/hold: \w+/]);
    const questionNarrow = await run.capture("held-question", "dark");
    run.assert(questionNarrow, [`hold: ${questionHold}`]);
    await tui.resize(SIZES.wide.cols, SIZES.wide.rows);
    await tui.expect("question wide again", ["Which capture should be primary?"]);
    tui.send(KEY.enter);
    await tui.expect("question answered", ["Continuing after the answer."], 60_000);
    await tui.absent("form hold released", /hold: (unanswered_form|form_state_unknown)/, 30_000).catch((error: unknown) => {
      report.check(`${run.name}: answering the question released the form hold`, false, String(error).slice(0, 200));
    });

    // --- held by a manual stop: the primary light/dark captures.
    const stopRequest = provider.waitRequest("stop reply started", (e) => e.kind === "scenario:stop");
    await prompt("stop");
    await stopRequest;
    await tui.expect("streaming hint", [/esc interrupt/]);
    tui.send(KEY.esc);
    await tui.expect("interrupt confirmation hint", [/esc again to interrupt/], 10_000);
    tui.send(KEY.esc);
    await tui.expect("user stop hold", ["hold: user_stop", HELD]);
    stopGate.release();
    const heldChecks: (RegExp | string)[] = [counts, `now: ${FOCUS}`, "hold: user_stop", HELD, "Investigation 1/2", "Implementation 0/3", "Verification 0/2"];
    const darkWide = await run.capture("held-stop", "dark", { primary: "dark-200x50" });
    run.assert(darkWide, heldChecks, [COMPLETE, /Todo invalid/]);
    run.rows(darkWide, [counts, `now: ${FOCUS}`, "hold: user_stop"]);
    await tui.resize(SIZES.narrow.cols, SIZES.narrow.rows);
    await tui.expect("held narrow", [summary, "hold: user_stop"]);
    const darkNarrow = await run.capture("held-stop", "dark", { primary: "dark-80x24" });
    run.assert(darkNarrow, [summary, "hold: user_stop"]);
    run.rows(darkNarrow, ["todo 1/7 done, 6 open", "hold: user_stop"]);
    await setColorMode(tui, "light");
    await tui.expect("held narrow light", [summary, "hold: user_stop"]);
    const lightNarrow = await run.capture("held-stop", "light", { primary: "light-80x24" });
    run.assert(lightNarrow, [summary, "hold: user_stop"]);
    await tui.resize(SIZES.wide.cols, SIZES.wide.rows);
    await tui.expect("held wide light", heldChecks);
    const lightWide = await run.capture("held-stop", "light", { primary: "light-200x50" });
    run.assert(lightWide, heldChecks, [COMPLETE, /Todo invalid/]);
    run.rows(lightWide, [counts, `now: ${FOCUS}`, "hold: user_stop"]);
    report.check(`${run.name}: primary light/dark backgrounds differ`, lightWide.background !== darkWide.background, { dark: darkWide.background, light: lightWide.background });
    await setColorMode(tui, "dark");
    await tui.expect("held wide dark again", heldChecks);

    // --- terminal: every item completed or abandoned, no focus, no hold.
    await prompt("terminal");
    await tui.expect("terminal board", ["5/7 done, 2 dropped, 0 open", "Investigation 2/2", "Implementation 3/3", "Verification 0/2, 2 dropped", "Every item is terminal now."], 90_000);
    const terminalWide = await run.capture("terminal", "dark");
    run.assert(terminalWide, [REVISION, "5/7 done, 2 dropped, 0 open", "Investigation 2/2", "Implementation 3/3", "Verification 0/2, 2 dropped", "[-] Capture light and dark grids", "[-] Write report.json", "[x] Survey the host contracts"], [/now:/, /hold:/, HELD, /Todo invalid/]);
    await tui.resize(SIZES.narrow.cols, SIZES.narrow.rows);
    await tui.expect("terminal narrow", ["todo 5/7 done, 0 open, 2 dropped"]);
    const terminalNarrow = await run.capture("terminal", "dark");
    run.assert(terminalNarrow, ["todo 5/7 done, 0 open, 2 dropped"], [/now:/, /hold:/]);
    await tui.resize(SIZES.wide.cols, SIZES.wide.rows);

    // --- empty: explicit rm leaves a valid empty board.
    await prompt("empty");
    await tui.expect("empty board", ["empty list", "The board was cleared."], 90_000);
    const emptyWide = await run.capture("empty", "dark");
    run.assert(emptyWide, [REVISION, "empty list"], [COUNTS, /now:/, /hold:/, /\[[ x>-]\] /, HELD, /Todo invalid/]);
    await tui.resize(SIZES.narrow.cols, SIZES.narrow.rows);
    await tui.expect("empty narrow", ["The board was cleared."]);
    const emptyNarrow = await run.capture("empty", "dark");
    run.assert(emptyNarrow, [], [/todo \d+\/\d+ done/, /hold:/]);
    await tui.resize(SIZES.wide.cols, SIZES.wide.rows);

    // --- invalid: corrupted bytes are preserved and diagnosed, never read as a board.
    const corrupt = stateFile(sandbox.project);
    report.check(`${run.name}: state file present before corruption`, Boolean(corrupt), corrupt);
    if (corrupt) writeFileSync(corrupt, '{"schemaVersion":1,"sessionID":"ses_corrupt","generation":1,"revision":"broken"');
    const corruptHash = corrupt ? sha256(readFileSync(corrupt)) : "";
    await prompt("invalid");
    await tui.expect("invalid board diagnostic", [/invalid: /, "Reading the board after corruption."], 90_000);
    const invalidWide = await run.capture("invalid", "dark");
    run.assert(invalidWide, ["Todo invalid", "invalid: "], [COUNTS, /\[x\] /, /now:/, REVISION, /empty list/]);
    await tui.resize(SIZES.narrow.cols, SIZES.narrow.rows);
    await tui.expect("invalid narrow", ["todo invalid: "]);
    const invalidNarrow = await run.capture("invalid", "dark");
    run.assert(invalidNarrow, ["todo invalid: "], [/todo \d+\/\d+ done/, /now:/]);
    report.check(`${run.name}: corrupted bytes were preserved (never rewritten)`, corrupt !== undefined && sha256(readFileSync(corrupt)) === corruptHash);
    await tui.resize(SIZES.wide.cols, SIZES.wide.rows);
    // The narrow composer already contains "invalid:". Wait for the diagnostic
    // in the wide sidebar band, not a stale narrow frame after PTY resize.
    await tui.until("final wide sidebar diagnostic", () => {
      const sidebar = regions(tui.grid().join("\n"))[1];
      return sidebar?.includes("Todo invalid") === true && sidebar.includes("[!] invalid:");
    });
    const invalidResized = await run.capture("invalid-after-resize", "dark");
    run.assert(invalidResized, ["Todo invalid", "invalid: "], [COUNTS, REVISION]);
  } catch (error) {
    report.check(`${run.name}: matrix ran to completion`, false, String(error).slice(0, 2_000));
    run.note(`error ${String(error).slice(0, 500)}`);
  } finally {
    run.receipts.tuiExit = await tui.kill();
    run.receipts.hostStop = await host.stop();
    run.receipts.providerPort = provider.port;
    provider.stop();
    run.receipts.frames = tui.frames;
    run.receipts.resizeAcknowledgments = tui.resizeAcknowledgments;
    report.check(`${run.name}: every resize has a parsed post-resize host repaint receipt`,
      tui.resizeAcknowledgments.length === tui.marks.length - 1 && tui.resizeAcknowledgments.every((ack) => ack.end > ack.offset && ack.maxRow === ack.rows),
      tui.resizeAcknowledgments);
    const log = sandbox.log();
    const logCopy = join(EVIDENCE, `${run.name}-host.log`);
    writeFileSync(logCopy, log);
    const streamFile = join(EVIDENCE, `${run.name}-stream.ansi`);
    writeFileSync(streamFile, tui.stream());
    writeFileSync(join(EVIDENCE, `${run.name}-captures.json`), JSON.stringify({ stream: streamFile, captures: run.captures }, null, 2));
    const findings = hostLogFindings(log);
    run.receipts.hostLog = { file: logCopy, ...findings, pluginEntrypoints: [...new Set(log.match(/entrypoint=\S+/g) ?? [])] };
    report.check(`${run.name}: host log has no singleton/renderer/plugin failures`, findings.singletonRenderer.length === 0 && findings.pluginFailures.length === 0, { singletonRenderer: findings.singletonRenderer.slice(0, 5), pluginFailures: findings.pluginFailures.slice(0, 5) });
    report.check(`${run.name}: host log has no WARN/ERROR lines`, findings.warnError.length === 0, findings.warnError.slice(0, 5));
    const entrypoints = (log.match(/entrypoint=\S+/g) ?? []).filter((entry) => !entry.includes("theme-probe-plugin"));
    report.check(`${run.name}: plugin loaded from ${mode === "dev" ? "the repository" : "the installed consumer copy"}`, entrypoints.length > 0 && entrypoints.every((entry) => entry.includes(pluginDir)), run.receipts.hostLog);
    run.receipts.providerRequests = provider.requests.map((entry) => `${entry.kind}/${entry.step}`);
    cleanupSandbox(run, sandbox);
  }
  return run;
}

function cleanupSandbox(run: Run, sandbox: Sandbox): void {
  const processReceipt = diagnostic(["pgrep", "-f", sandbox.root], true);
  const leftovers = processReceipt.stdout.trim().split("\n").filter(Boolean);
  for (const pid of leftovers) {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  const providerPort = typeof run.receipts.providerPort === "number" ? run.receipts.providerPort : sandbox.provider.port;
  const portReceipt = diagnostic(["lsof", "-nP", `-iTCP:${providerPort}`, "-sTCP:LISTEN"], true);
  run.receipts.cleanup = { leftoverPidsKilled: leftovers, providerPortListening: portReceipt.error === null ? portReceipt.stdout.trim().length > 0 : null, diagnosticErrors: [processReceipt.error, portReceipt.error].filter((error) => error !== null), removed: !KEEP };
  if (!KEEP) rmSync(sandbox.root, { recursive: true, force: true });
}

// ------------------------------------------------------------ evidence passes for the other launch modes
type Observation = { readonly hold: string | null; readonly invalid: boolean; readonly diagnostic: string | null; readonly sidebar: string[] };
function observe(grid: string): Observation {
  const band = regions(grid)[1]!;
  return {
    hold: band.match(/hold: (\w+)/)?.[1] ?? null,
    invalid: /Todo invalid/.test(band),
    diagnostic: band.match(/invalid: (.+?)(?= ▀| \/…| Investigation| \[|$)/)?.[1]?.trim().slice(0, 120) ?? null,
    sidebar: grid.split("\n").map((line) => line.slice(SIDEBAR_COLUMN).trimEnd()).filter((line) => /Todo|invalid|hold|done|now:/.test(line)),
  };
}

async function runEvidence(report: Report, xterm: Xterm, launch: LaunchMode, pluginDir: string, attempt = 1): Promise<Run> {
  const sandbox = createSandbox(`og-tui-evidence-${launch}`, pluginDir);
  const run = new Run(`dev-${launch}-defaults${attempt > 1 ? `-${attempt}` : ""}`, "evidence", new Tui(xterm.Terminal, SIZES.wide.cols, SIZES.wide.rows), report);
  runs.push(run);
  run.receipts.sandbox = sandbox.root;
  run.receipts.launch = launch;
  const host = await launchHost(sandbox, launch);
  run.receipts.host = host.description;
  const { tui } = run;
  const provider = sandbox.provider;
  const activeGate = gate();
  provider.scenarios.set("active", [
    { tool: "todo", args: { op: "init", list: BOARD } },
    { tool: "todo", args: { op: "done", task: "Read the plan and task block" } },
    { text: "Board initialised.", hold: activeGate.hold },
  ]);
  try {
    tui.start(host.args, sandbox.project, host.env);
    run.receipts.tuiPid = tui.pid;
    run.receipts.providerPort = provider.port;
    await tui.expect("home screen", [/ctrl\+p commands/], BOOT_TIMEOUT);
    console.log(`TODO_TUI_READY ${run.name} pid=${tui.pid}`);
    await cycleAgent(tui, /Open-Gajae · model-a/);
    tui.send(KEY.ctrlP);
    await tui.expect("palette for theme dump", [/Commands/]);
    await tui.type("Theme probe: dump tokens", "palette filter theme dump");
    tui.send(KEY.enter);
    await tui.absent("palette closed after theme dump", /Commands\s+esc/);
    const dumped = readHostTokens(sandbox);
    report.check(`${run.name}: host theme tokens captured for dark mode`, dumped?.mode === "dark", dumped);
    if (dumped?.mode === "dark") run.tokens.dark = dumped;
    run.receipts.hostTokens = run.tokens;
    await tui.absent("idle before tui:active", /esc (again to )?interrupt/);
    await tui.type("tui:active", "type tui:active");
    const activeRequest = provider.waitRequest("active text step", (e) => e.kind === "scenario:active" && e.step === 2, 90_000);
    tui.send(KEY.enter);
    await activeRequest;
    await tui.expect("sidebar outcome", [/Todo (r\d+|invalid)/]);
    // Default settings keep continuation on. A hold recorded by the tool-call
    // path shows while the reply is still held; the resume path only runs after
    // the turn ends, so both moments get a bounded wait and a capture.
    await tui.expect("hold during the held reply", [/hold: \w+|Todo invalid/], 15_000).catch(() => undefined);
    const during = await run.capture("after-init", "dark");
    const duringSeen = observe(readFileSync(during.files.txt, "utf8"));
    activeGate.release();
    await tui.expect("reply finished", ["Board initialised."]);
    await tui.expect("post-turn hold", [/hold: \w+|Todo invalid/], 30_000).catch(() => undefined);
    const after = await run.capture("after-turn", "dark");
    const afterSeen = observe(readFileSync(after.files.txt, "utf8"));
    const file = stateFile(sandbox.project);
    const snapshot = file ? (JSON.parse(readFileSync(file, "utf8")) as { controller?: { hold?: { reason?: string } | null } }) : undefined;
    run.receipts.observed = { duringTurn: duringSeen, afterTurn: afterSeen, stateHold: snapshot?.controller?.hold ?? null, invalid: duringSeen.invalid || afterSeen.invalid, formStateUnknown: duringSeen.hold === "form_state_unknown" || afterSeen.hold === "form_state_unknown" };
    run.assert(during, [/Todo (r\d+|invalid)/, /1\/7 done, 0 dropped, 6 open|Todo invalid/]);
    report.check(`${run.name}: shipped launch keeps the board readable (no "session belongs to another location")`, !duringSeen.invalid && !afterSeen.invalid, { during: duringSeen.diagnostic, after: afterSeen.diagnostic });
    report.check(`${run.name}: no form_state_unknown hold (public form API reachable from the plugin)`, duringSeen.hold !== "form_state_unknown" && afterSeen.hold !== "form_state_unknown", { during: duringSeen.hold, after: afterSeen.hold });
  } catch (error) {
    report.check(`${run.name}: evidence pass ran to completion`, false, String(error).slice(0, 2_000));
  } finally {
    run.receipts.tuiExit = await tui.kill();
    run.receipts.hostStop = await host.stop();
    provider.stop();
    const log = sandbox.log();
    const logCopy = join(EVIDENCE, `${run.name}-host.log`);
    writeFileSync(logCopy, log);
    writeFileSync(join(EVIDENCE, `${run.name}-stream.ansi`), tui.stream());
    writeFileSync(join(EVIDENCE, `${run.name}-captures.json`), JSON.stringify({ stream: join(EVIDENCE, `${run.name}-stream.ansi`), captures: run.captures }, null, 2));
    const findings = hostLogFindings(log);
    run.receipts.hostLog = { file: logCopy, ...findings, http4xx: log.split("\n").filter((line) => /Sent HTTP response/.test(line) && /status=4/.test(line)).map((line) => line.replace(/^.*http\.method=/, "")).slice(0, 10) };
    cleanupSandbox(run, sandbox);
  }
  return run;
}

// ------------------------------------------------------------ packed install
type Receipt = { command: string[]; cwd: string; exit: number; stdout: string; stderr: string };
async function command(args: string[], cwd: string, env: Record<string, string | undefined>, keepStdout = false): Promise<Receipt> {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => child.kill("SIGKILL"), 300_000);
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { command: args, cwd, exit, stdout: keepStdout ? stdout : stdout.slice(-4_000), stderr: stderr.slice(-4_000) };
  } finally {
    clearTimeout(deadline);
  }
}

async function selfCheckUnavailableLsof(): Promise<never> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "og-tui-diagnostic-shim-")));
  let passed = false;
  try {
    const ps = Bun.which("ps");
    if (!ps) throw new Error("self-check requires a working ps command");
    symlinkSync(ps, join(root, "ps"));
    const file = join(EVIDENCE, "report.json");
    const checkpointRun = "checkpoint-sentinel";
    writeFileSync(file, JSON.stringify({
      task: "diagnostic checkpoint merge self-check",
      started: new Date().toISOString(),
      runs: { [checkpointRun]: { receipts: { checkpoint: true }, events: [], captures: [] } },
      acceptance: [{ item: "checkpointed run survives diagnostic exit", status: "PASS", evidence: [checkpointRun] }],
      checks: [{ name: "checkpoint sentinel", pass: true }],
    }, null, 2));
    const args = [process.execPath, import.meta.path, "--diagnostics-only", "--evidence-dir", EVIDENCE];
    const child = Bun.spawn(args, { cwd: REPO, env: { ...process.env, PATH: root, BUN_CONFIG_VERBOSE_FETCH: undefined }, stdout: "pipe", stderr: "pipe" });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
    let exit: number;
    let stdout: string;
    let stderr: string;
    try {
      [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    const data: {
      complete?: boolean;
      cleanup?: { diagnostics?: { lsof?: { error?: string | null; exit?: number | null } }; diagnosticErrors?: { command: string[]; error: string | null }[]; sandboxesLeft?: string[] };
      checks?: { pass: boolean }[];
      runs?: Record<string, unknown>;
    } | undefined = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    const diagnosticFailed = data?.cleanup?.diagnostics?.lsof?.error != null &&
      data.cleanup.diagnostics.lsof.exit === null &&
      data.cleanup.diagnosticErrors?.some((entry) => entry.command[0] === "lsof" && entry.error !== null) === true;
    const checkpointMerged = data?.runs?.[checkpointRun] !== undefined;
    passed = exit !== 0 && data?.complete === true && diagnosticFailed &&
      checkpointMerged && data.checks?.some((check) => !check.pass) === true && data.cleanup?.sandboxesLeft?.length === 0;
    writeFileSync(join(EVIDENCE, "self-check.json"), JSON.stringify({
      pass: passed, command: args, injectedPath: root, childExit: exit, childPid: child.pid,
      report: file, reportExists: existsSync(file), diagnosticFailed, checkpointMerged, stdout, stderr,
      childSandboxRemoved: data?.cleanup?.sandboxesLeft?.length === 0,
    }, null, 2));
    console.log(`INJECTED_LSOF_EXIT=${exit}`);
    console.log(`INJECTED_LSOF_REPORT=${file}`);
    console.log(passed ? "UNAVAILABLE_LSOF_SELF_CHECK_OK" : "UNAVAILABLE_LSOF_SELF_CHECK_FAIL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(passed ? 0 : 1);
}

async function packAndInstall(report: Report, scratch: string): Promise<{ pluginDir?: string; tarball?: string; receipts: Record<string, unknown> }> {
  const npmHome = join(scratch, "npm-home");
  const packDir = join(scratch, "pack");
  const consumer = join(scratch, "consumer");
  for (const dir of [npmHome, packDir, consumer]) mkdirSync(dir, { recursive: true });
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: npmHome,
    npm_config_cache: join(npmHome, ".npm"),
    npm_config_userconfig: join(npmHome, ".npmrc"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  delete env.BUN_CONFIG_VERBOSE_FETCH;
  const receipts: Record<string, unknown> = {};
  const build = await command(["bun", "run", "build:tui"], REPO, env);
  receipts.build = build;
  const freshDist = sha256(readFileSync(join(REPO, "dist/tui.js")));
  report.check("packed: fresh dist/tui.js built before packing", build.exit === 0, build);
  const pack = await command(["npm", "pack", "--json", "--pack-destination", packDir], REPO, env, true);
  receipts.pack = { ...pack, stdout: pack.stdout.slice(-4_000) };
  report.check("packed: npm pack succeeded (prepack rebuilds dist)", pack.exit === 0, receipts.pack);
  if (pack.exit !== 0) return { receipts };
  const [packed] = JSON.parse(pack.stdout.slice(pack.stdout.indexOf("["))) as { filename: string; integrity?: string; shasum?: string; files: { path: string }[] }[];
  if (!packed) throw new Error("npm pack produced no tarball");
  const tarball = join(packDir, packed.filename);
  const archivedTarball = join(EVIDENCE, packed.filename);
  writeFileSync(archivedTarball, readFileSync(tarball));
  const tarDist = Bun.spawnSync(["tar", "-xOzf", tarball, "package/dist/tui.js"], { stdout: "pipe", stderr: "pipe" }).stdout;
  const packedDist = sha256(tarDist);
  const rebuiltDist = sha256(readFileSync(join(REPO, "dist/tui.js")));
  receipts.tarball = { file: archivedTarball, sha256: sha256(readFileSync(tarball)), integrity: packed.integrity, files: packed.files.length };
  receipts.dist = { fresh: freshDist, afterPrepack: rebuiltDist, inTarball: packedDist };
  report.check("packed: tarball dist/tui.js is the freshly built one (no stale dist)", packedDist === rebuiltDist && packedDist === freshDist, receipts.dist);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "open-gajae-tui-consumer", private: true }));
  const install = await command(["npm", "install", tarball], consumer, env);
  receipts.install = install;
  report.check("packed: npm install of the tarball succeeded in a separate consumer", install.exit === 0, install);
  if (install.exit !== 0) return { receipts };
  const pluginDir = join(consumer, "node_modules/open-gajae");
  const installedDist = sha256(readFileSync(join(pluginDir, "dist/tui.js")));
  report.check("packed: installed dist/tui.js matches the tarball", installedDist === packedDist, { installedDist, packedDist });
  report.check("packed: installed copy carries tui.ts facade and src/todo/protocol.ts", ["tui.ts", "src/todo/protocol.ts", "index.ts", "src/index.ts"].every((f) => existsSync(join(pluginDir, f))));
  receipts.pluginDir = pluginDir;
  return { pluginDir, tarball: archivedTarball, receipts };
}

// The normal directory matrices cannot prove registry resolution. Give a fresh
// archive a unique identity and let the host install it through name@version.
async function runRegistry(report: Report, xterm: Xterm, scratch: string, tarball: string): Promise<Run> {
  const packRoot = join(scratch, "registry-package");
  const packDir = join(scratch, "registry-pack");
  const npmHome = join(scratch, "registry-npm-home");
  for (const dir of [packRoot, packDir, npmHome]) mkdirSync(dir, { recursive: true });
  const env = { ...process.env, HOME: npmHome, npm_config_cache: join(npmHome, ".npm"), BUN_CONFIG_VERBOSE_FETCH: undefined };
  const unpack = await command(["tar", "-xzf", tarball, "-C", packRoot], scratch, env);
  report.check("registry: unpack freshly built archive", unpack.exit === 0, unpack);
  if (unpack.exit !== 0) throw new Error("registry archive unpack failed");
  const packageDir = join(packRoot, "package");
  const nonce = randomUUID().replaceAll("-", "");
  const name = `open-gajae-tui-qa-${nonce}`;
  const version = `0.0.0-qa.r${nonce}`;
  const specifier = `${name}@${version}`;
  const original: Record<string, unknown> = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const manifest = { ...original, name, version };
  writeFileSync(join(packageDir, "package.json"), JSON.stringify(manifest, null, 2));
  // The original prepack already built this archive. Its published files do
  // not contain the build script; preserve the verified dist byte-for-byte.
  const pack = await command(["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", packDir], packageDir, env, true);
  report.check("registry: uniquely named archive packed", pack.exit === 0, pack);
  if (pack.exit !== 0) throw new Error("registry identity pack failed");
  const packed: { filename: string }[] = JSON.parse(pack.stdout);
  const filename = packed[0]?.filename;
  if (!filename) throw new Error("registry pack produced no archive");
  const archive = readFileSync(join(packDir, filename));
  const archived = join(EVIDENCE, filename);
  writeFileSync(archived, archive);
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const requests: string[] = [];
  const registry = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (request.method !== "GET") return new Response("read only", { status: 405 });
      if (url.pathname === `/${name}/-/probe.tgz`) return new Response(archive);
      if (url.pathname === `/${name}`) return Response.json({
        name, "dist-tags": { latest: version },
        versions: { [version]: { ...manifest, dist: { tarball: new URL(`/${name}/-/probe.tgz`, request.url).href, integrity } } },
      });
      const upstream = await fetch(`https://registry.npmjs.org${url.pathname}${url.search}`, { signal: AbortSignal.timeout(60_000) });
      const headers = new Headers(upstream.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers });
    },
  });
  const registryPort = registry.port;
  let sandbox: Sandbox | undefined;
  let host: HostHandle | undefined;
  let run: Run | undefined;
  const reply = gate();
  try {
    sandbox = createSandbox("og-tui-registry", specifier, MATRIX_SETTINGS, false);
    sandbox.env.npm_config_registry = registry.url.href;
    writeFileSync(join(sandbox.home, ".npmrc"), `registry=${registry.url.href}\n`);
    run = new Run("registry-name-version", "registry", new Tui(xterm.Terminal, SIZES.wide.cols, SIZES.wide.rows), report);
    runs.push(run);
    run.receipts.sandbox = sandbox.root;
    run.receipts.registryPort = registryPort;
    run.receipts.registry = { name, version, specifier, url: registry.url.href, archive: archived, integrity, pack, unpack };
    const config = JSON.parse(readFileSync(join(sandbox.home, ".config/opencode/opencode.jsonc"), "utf8"));
    run.receipts.plugins = config.plugins;
    report.check("registry: config plugins contain name@version only and HOME is outside the package",
      config.plugins.length === 1 && config.plugins[0] === specifier && !sandbox.home.startsWith(packageDir), { plugins: config.plugins, home: sandbox.home, packageDir });
    checkIsolation(report, sandbox, run.name);
    const provider = sandbox.provider;
    provider.scenarios.set("active", [
      { tool: "todo", args: { op: "init", list: BOARD } },
      { tool: "todo", args: { op: "done", task: "Read the plan and task block" } },
      { tool: "todo", args: { op: "start", task: FOCUS } },
      { text: "Registry board is active.", hold: reply.hold },
    ]);
    host = await launchHost(sandbox, "attach");
    const { tui } = run;
    // Logs are buffered until process close, so they are evidence, not a live
    // readiness channel. Subscribe to the public SSE endpoint before the TUI
    // triggers installation. Read the agent snapshot only on agent.updated.
    const serverURL = host.args[1];
    if (!serverURL) throw new Error("registry run requires an attached host URL");
    const eventAbort = new AbortController();
    const eventTimeout = setTimeout(() => eventAbort.abort(new Error("timed out: registry agent registration")), BOOT_TIMEOUT);
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${host.env.OPENCODE_PASSWORD}`).toString("base64")}` };
    const events = await fetch(`${serverURL}/api/event`, { headers: { ...headers, accept: "text/event-stream" }, signal: eventAbort.signal });
    if (!events.ok || !events.body) {
      clearTimeout(eventTimeout);
      eventAbort.abort();
      throw new Error(`registry event subscription failed: ${events.status}`);
    }
    const reader = events.body.getReader();
    const installed = (async () => {
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("registry event stream closed before agent registration");
        pending += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          const block = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
          if (!data) continue;
          const event: { type?: string; id?: string } = JSON.parse(data);
          if (event.type !== "agent.updated") continue;
          const snapshot = await fetch(`${serverURL}/api/agent`, { headers, signal: eventAbort.signal });
          if (!snapshot.ok) throw new Error(`registry agent snapshot failed: ${snapshot.status}`);
          const agents = await snapshot.json();
          const list = Array.isArray(agents) ? agents : Array.isArray(agents?.data) ? agents.data : [];
          if (list.some((agent: { id?: string; name?: string }) => (agent.id ?? agent.name) === "open-gajae"))
            return { event, agent: "open-gajae", source: "public SSE agent.updated + GET /api/agent" };
        }
      }
    })().finally(() => {
      clearTimeout(eventTimeout);
      eventAbort.abort();
    });
    tui.start(host.args, sandbox.project, host.env);
    run.receipts.tuiPid = tui.pid;
    run.receipts.providerPort = provider.port;
    const [, registered] = await Promise.all([
      tui.expect("registry home screen", [/ctrl\+p commands/], BOOT_TIMEOUT),
      installed,
    ]);
    console.log(`TODO_TUI_READY ${run.name} pid=${tui.pid}`);
    run.receipts.registrationEvent = registered;
    await cycleAgent(tui, /Open-Gajae · model-a/);
    await tui.type("tui:active", "registry active prompt");
    const requested = provider.waitRequest("registry active tools", (entry) => entry.kind === "scenario:active" && entry.step === 3, BOOT_TIMEOUT);
    tui.send(KEY.enter);
    await requested;
    await tui.expect("registry live active sidebar", [REVISION, "1/7 done, 0 dropped, 6 open", `now: ${FOCUS}`, "Implementation 0/3"]);
    const active = await run.capture("active", "dark");
    report.check(`${active.id}: active board rendered in the native 200x50 sidebar`, active.cols === 200 && active.rows === 50 &&
      regions(readFileSync(active.files.txt, "utf8"))[1]?.includes(`now: ${FOCUS}`), active.files);
    tui.send(KEY.esc);
    await tui.expect("registry interrupt confirmation", [/esc again to interrupt/], 10_000);
    tui.send(KEY.esc);
    await tui.expect("registry held sidebar", [HELD, "hold: user_stop"]);
    const held = await run.capture("held-stop", "dark");
    report.check(`${held.id}: held board rendered in the native 200x50 sidebar`,
      regions(readFileSync(held.files.txt, "utf8"))[1]?.includes("hold: user_stop"), held.files);
  } finally {
    reply.release();
    if (run) run.receipts.tuiExit = await run.tui.kill();
    const stopped = host ? await host.stop() : {};
    registry.stop(true);
    if (sandbox) {
      sandbox.provider.stop();
      if (run) {
        run.receipts.hostStop = stopped;
        run.receipts.registryRequests = requests;
        const log = sandbox.log();
        const logCopy = join(EVIDENCE, `${run.name}-host.log`);
        writeFileSync(logCopy, log);
        writeFileSync(join(EVIDENCE, `${run.name}-stream.ansi`), run.tui.stream());
        writeFileSync(join(EVIDENCE, `${run.name}-captures.json`), JSON.stringify({ captures: run.captures }, null, 2));
        const entrypoints = [...new Set(log.match(/entrypoint=\S+/g) ?? [])];
        run.receipts.hostLog = { file: logCopy, ...hostLogFindings(log), entrypoints };
        const home = sandbox.home;
        report.check("registry: host entrypoint loaded from its isolated npm cache",
          entrypoints.some((entry) => entry.includes(home) && entry.includes("/npm/") && entry.includes(`/node_modules/${name}/`)), entrypoints);
        report.check("registry: metadata and tarball requests observed",
          requests.includes(`GET /${name}`) && requests.includes(`GET /${name}/-/probe.tgz`), requests);
        const findings = hostLogFindings(log);
        report.check("registry: no singleton/renderer/plugin failures", findings.singletonRenderer.length === 0 && findings.pluginFailures.length === 0, findings);
        cleanupSandbox(run, sandbox);
      }
    }
  }
  if (!run) throw new Error("registry native run was not created");
  return run;
}

// ------------------------------------------------------------ PNG rendering through xterm.js in a browser
function renderPage(xterm: Xterm): string {
  const script = `
window.setup = (cols, rows) => {
  if (window.term) window.term.dispose();
  window.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0, fontFamily: "Menlo, Monaco, monospace", fontSize: 14, lineHeight: 1.0, theme: { background: "#000000" } });
  window.term.open(document.getElementById("terminal"));
  return window.size();
};
window.size = () => {
  const dims = window.term._core._renderService.dimensions.css.canvas;
  return { width: Math.ceil(dims.width), height: Math.ceil(dims.height) };
};
window.feed = (b64) => new Promise((done) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  window.term.write(bytes, () => done(true));
});
window.resizeTerm = (cols, rows) => { window.term.resize(cols, rows); return window.size(); };
window.lines = () => { const out = []; for (let y = 0; y < window.term.rows; y++) out.push((window.term.buffer.active.getLine(y) || { translateToString: () => "" }).translateToString(true)); return out; };
`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${xterm.browserCss}
html,body{margin:0;padding:0;background:#000}#terminal{display:inline-block}</style></head><body><div id="terminal"></div><script>${xterm.browserJs}</script><script>${script}</script></body></html>`;
}

interface WebViewLike {
  navigate(url: string): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  resize(width: number, height: number): Promise<void>;
  screenshot(options: { encoding: "buffer" }): Promise<Buffer>;
  close(): void;
}

async function renderPngs(report: Report, xterm: Xterm, runs: Run[]): Promise<Record<string, unknown>> {
  const page = join(EVIDENCE, ".render/terminal.html");
  mkdirSync(dirname(page), { recursive: true });
  writeFileSync(page, renderPage(xterm));
  const WebViewCtor = (Bun as unknown as { WebView?: new (options: { width: number; height: number }) => WebViewLike }).WebView;
  if (!WebViewCtor) {
    report.check("png: Bun.WebView is available for xterm.js rendering", false);
    return { available: false };
  }
  const view = new WebViewCtor({ width: 1900, height: 900 });
  const rendered: Record<string, unknown> = { page, pngs: 0 };
  try {
    await view.navigate(`file://${page}`);
    for (const run of runs) {
      const stream = readFileSync(join(EVIDENCE, `${run.name}-stream.ansi`));
      const ordered = [...run.captures].sort((a, b) => a.offset - b.offset || a.marks.length - b.marks.length);
      const marks = run.tui.marks;
      let fed = 0;
      let markIndex = 1;
      await view.evaluate(`window.setup(${marks[0]!.cols}, ${marks[0]!.rows})`);
      const feedTo = async (end: number) => {
        for (let at = fed; at < end; at += 262_144) {
          const slice = stream.subarray(at, Math.min(end, at + 262_144));
          await view.evaluate(`window.feed(${JSON.stringify(slice.toString("base64"))})`);
        }
        fed = Math.max(fed, end);
      };
      for (const capture of ordered) {
        while (markIndex < capture.marks.length) {
          const mark = marks[markIndex]!;
          await feedTo(mark.offset);
          await view.evaluate(`window.resizeTerm(${mark.cols}, ${mark.rows})`);
          markIndex++;
        }
        await feedTo(capture.offset);
        const size = (await view.evaluate("window.size()")) as { width: number; height: number };
        await view.resize(Math.max(1, size.width), Math.max(1, size.height));
        // xterm.js paints on the next animation frame; screenshot the painted one.
        await view.evaluate("new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))");
        const lines = (await view.evaluate("window.lines()")) as string[];
        const expected = readFileSync(capture.files.txt, "utf8").split("\n").slice(0, capture.rows).map((line) => line.trimEnd());
        capture.textMatch = lines.map((line) => line.trimEnd()).join("\n") === expected.join("\n");
        const png = join(EVIDENCE, `${capture.id}.png`);
        writeFileSync(png, await view.screenshot({ encoding: "buffer" }));
        capture.files.png = png;
        rendered.pngs = (rendered.pngs as number) + 1;
        report.check(`${capture.id}: xterm.js browser grid equals the headless grid (PNG shows the same frame)`, capture.textMatch === true);
      }
    }
  } finally {
    view.close();
    (Bun as unknown as { WebView?: { closeAll?: () => void } }).WebView?.closeAll?.();
  }
  return rendered;
}

// ------------------------------------------------------------ main
type SerializedAcceptance = {
  readonly item: string;
  readonly status: string;
  readonly blockedBy?: readonly string[];
  readonly evidence?: readonly string[];
};
type SerializedReport = {
  readonly task?: string;
  readonly started?: string;
  readonly launches?: { readonly matrix?: readonly string[]; readonly defaultSettingsPasses?: readonly string[] };
  readonly twoLocationRuns?: readonly unknown[];
  readonly primary?: { readonly sourceRun?: string | null; readonly files?: readonly string[] };
  readonly installModes?: readonly string[];
  readonly xterm?: unknown;
  readonly runs?: Record<string, unknown>;
  readonly acceptance?: readonly SerializedAcceptance[];
  readonly product_defects?: readonly unknown[];
  readonly accepted_host_status_markers?: readonly unknown[];
  readonly receipts?: Record<string, unknown>;
  readonly checks?: readonly { readonly name: string; readonly pass: boolean; readonly detail?: unknown }[];
};
const reportFile = join(EVIDENCE, "report.json");
const checkpointReport = existsSync(reportFile)
  ? JSON.parse(readFileSync(reportFile, "utf8")) as SerializedReport
  : undefined;
const report = new Report(PROBE);
const started = new Date().toISOString();
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "og-tui-probe-")));
const runs: Run[] = [];
const receipts: Record<string, unknown> = { scratch };
let xterm: Xterm | undefined;
// ------------------------------------------------------------ plan-named primaries and global cleanup receipts
function writeReport(final: boolean): void {
const PRIMARY_IDS = ["dark-200x50", "dark-80x24", "light-80x24", "light-200x50"];
const primaryRun = PRIMARY_RUNS.map((name) => runs.find((run) => run.name === name)).find((run) => run && PRIMARY_IDS.every((id) => run.captures.some((capture) => capture.id === `${run.name}-${id}`)));
const primaryFiles: string[] = [];
if (primaryRun) {
  for (const id of PRIMARY_IDS) {
    const capture = primaryRun.captures.find((candidate) => candidate.id === `${primaryRun.name}-${id}`)!;
    for (const file of [capture.files.txt, capture.files.ansi, capture.files.ansi ? `${capture.files.ansi}.json` : undefined, capture.files.png]) {
      if (!file || !existsSync(file)) continue;
      const target = join(EVIDENCE, file.slice(file.lastIndexOf("/") + 1).replace(`${primaryRun.name}-`, ""));
      writeFileSync(target, readFileSync(file));
      primaryFiles.push(target);
    }
  }
}
if (MODES.length > 0)
  report.check("plan-named {light,dark}-{80x24,200x50} files written from a complete matrix run", primaryRun !== undefined && primaryFiles.length === (PNG ? 16 : 12), { source: primaryRun?.name, files: primaryFiles.length });
const hostStopOf = (run: Run) => run.receipts.hostStop as { servePid?: number; servicePid?: number; serveUrl?: string; serviceUrl?: string } | undefined;
const bootstrapStopOf = (run: Run) => run.receipts.bootstrapStop as { servePid?: number; serveUrl?: string } | undefined;
const spawnedPids = runs.flatMap((run) => [run.receipts.tuiPid, hostStopOf(run)?.servePid, hostStopOf(run)?.servicePid, bootstrapStopOf(run)?.servePid]).filter((pid): pid is number => typeof pid === "number");
const usedPorts = runs.flatMap((run) => [run.receipts.providerPort, run.receipts.registryPort, ...[hostStopOf(run)?.serveUrl, hostStopOf(run)?.serviceUrl, bootstrapStopOf(run)?.serveUrl].map((url) => (url ? Number(new URL(url).port) : undefined))]).filter((port): port is number => typeof port === "number" && port > 0);
const psReceipt = diagnostic(["ps", "-axo", "pid,ppid,command"]);
const psLines = psReceipt.stdout.split("\n");
const hostProcesses = psLines.filter((line) => /\.opencode\/bin\/opencode|opencode (serve|--standalone|--server)/.test(line) && !/grep/.test(line));
const spawnedAlive = psLines.filter((line) => spawnedPids.some((pid) => new RegExp(`^\\s*${pid}\\s`).test(line)));
const lsofReceipt = diagnostic(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"], true);
const listening = lsofReceipt.stdout.split("\n");
const portsStillOpen = listening.filter((line) => usedPorts.some((port) => line.includes(`:${port} `)));
const sandboxesLeft = [...sandboxes.map((sandbox) => sandbox.root), scratch].filter((path) => existsSync(path));
const globalCleanup = { spawnedPids, spawnedAlive, hostProcessesAlive: hostProcesses, usedPorts, portsStillOpen, sandboxesLeft, webviewClosed: true,
  diagnostics: {
    ps: { command: psReceipt.command, exit: psReceipt.exit, stderr: psReceipt.stderr, error: psReceipt.error },
    lsof: { command: lsofReceipt.command, exit: lsofReceipt.exit, stderr: lsofReceipt.stderr, error: lsofReceipt.error },
  },
  diagnosticErrors: diagnosticFailures,
};
report.check("cleanup: no spawned host/serve/service process alive (ps receipt)", spawnedAlive.length === 0 && !diagnosticFailures.some((failure) => failure.command[0] === "ps" || failure.command[0] === "pgrep"), globalCleanup);
report.check("cleanup: no used provider/serve/service port still listening (lsof receipt)", portsStillOpen.length === 0 && !diagnosticFailures.some((failure) => failure.command[0] === "lsof"), { portsStillOpen, diagnostic: globalCleanup.diagnostics.lsof });
report.check("cleanup: no sandbox directory left in the OS temporary directory", KEEP || sandboxesLeft.length === 0, sandboxesLeft);

// ------------------------------------------------------------ report.json
const captureIds = (predicate: (capture: Capture) => boolean) => runs.flatMap((run) => run.captures.filter(predicate).map((capture) => capture.id));
const passed = (prefix: string | RegExp) => report.checks.filter((check) => (typeof prefix === "string" ? check.name.startsWith(prefix) : prefix.test(check.name)));
const PRIMARY_CAPTURE_CHECK = /^(dev|packed)-(attach|standalone|service)-(dark|light)-(80x24|200x50):/;
const verdict = (checks: { pass: boolean }[], observed: boolean) => (observed && checks.length > 0 && checks.every((check) => check.pass) ? "PASS" : "FAIL");
// Names the product defect behind a failing check so a FAIL verdict is never mistaken for an unobserved state.
const blockedBy = (checks: { name: string; pass: boolean; detail?: unknown }[]) => [...new Set(checks.filter((check) => !check.pass).map((check) => {
  if (/contrast >= |theme token|4\.5:1|recoloured/.test(check.name)) return "D3-stale-theme-colours";
  if (/session belongs to another location|keeps the board readable/.test(check.name)) return "D2-rpc-registration-per-location";
  if (/form_state_unknown/.test(check.name)) return "D1-form-reader-discovery";
  return `check: ${check.name}`;
}))];
const matrixRuns = runs.filter((run) => run.kind === "matrix");
const evidenceRuns = runs.filter((run) => run.kind === "evidence");
const PRIMARY_CAPTURE = /^(dev|packed)-(attach|standalone|service)-(dark|light)-(80x24|200x50)$/;
const disabledAcceptance = {
  item: "enabled:false hides the seeded board sidebar, narrow summary and history palette command in standalone dev-dir",
  status: verdict(passed("dev-standalone-disabled:"), runs.some((run) => run.kind === "disabled")),
  evidence: ["report.json runs.dev-standalone-disabled", ...captureIds((capture) => capture.run === "dev-standalone-disabled")],
};
const acceptance = DISABLED_ONLY ? [
  disabledAcceptance,
  { item: "cleanup: every spawned process gone, used ports closed, sandboxes removed (ps/lsof receipts)", status: verdict(passed("cleanup:"), true), evidence: ["report.json cleanup"] },
] : [
  disabledAcceptance,
  ...MODES.flatMap((mode) => LAUNCHES.flatMap((launch) => ["active", "held-question", "held-stop", "terminal", "empty", "invalid", "panel"].map((state) => {
    const ids = captureIds((capture) => capture.run === `${mode}-${launch}` && capture.state === state);
    const checks = report.checks.filter((check) => ids.some((id) => check.name.startsWith(id)));
    return { item: `${mode}/${launch}: ${state} state rendered live in the native TUI`, status: verdict(checks, ids.length > 0), blockedBy: blockedBy(checks), evidence: ids };
  }))),
  { item: "light/dark x 80x24/200x50 primary captures show focus, hold reason and counters without clipping or overlap", status: verdict(passed(PRIMARY_CAPTURE_CHECK), captureIds((c) => PRIMARY_CAPTURE.test(c.id)).length === 4 * matrixRuns.length), blockedBy: blockedBy(passed(PRIMARY_CAPTURE_CHECK)), evidence: captureIds((c) => PRIMARY_CAPTURE.test(c.id)) },
  { item: "light captures: host-primary-text labels >= 4.5:1 and every label equals the host's own theme token", status: verdict(passed(/theme token|4\.5:1|host theme tokens captured/), matrixRuns.length > 0), blockedBy: blockedBy(passed(/theme token|4\.5:1|host theme tokens captured/)), evidence: matrixRuns.map((run) => `${run.name}: ${JSON.stringify(run.tokens)}`) },
  { item: "live dark->light switch through the native Color mode command recolours the plugin surfaces immediately", status: verdict(passed(/recoloured the sidebar/), matrixRuns.length > 0), blockedBy: blockedBy(passed(/recoloured the sidebar/)), evidence: captureIds((c) => c.state === "active" && c.theme === "light") },
  { item: "light and dark toggled through the native Color mode command (backgrounds differ)", status: verdict(passed(/backgrounds differ/), matrixRuns.length > 0), evidence: matrixRuns.map((run) => `${run.name}: ${JSON.stringify({ light: run.receipts.colorModeLight, dark: run.receipts.colorModeDark })}`) },
  { item: "fullscreen history panel opens from the palette, closes with Esc, key navigation never changes state bytes", status: verdict(passed(/state bytes unchanged|panel/), captureIds((c) => c.state.startsWith("panel")).length > 0), blockedBy: blockedBy(passed(/state bytes unchanged|panel/)), evidence: captureIds((c) => c.state.startsWith("panel")) },
  { item: "held and invalid boards are never shown as complete", status: verdict(passed(/never shows/), captureIds((c) => c.state === "held-stop" || c.state === "invalid" || c.state === "held-question").length > 0), evidence: captureIds((c) => c.state === "held-stop" || c.state === "invalid" || c.state === "held-question") },
  { item: "invalid title retains Todo cells after 80x24 -> 200x50 resize", status: verdict(passed(/invalid-after-resize.*shows "Todo invalid"/), captureIds((c) => c.state === "invalid-after-resize").length === MODES.length * LAUNCHES.length), evidence: captureIds((c) => c.state === "invalid-after-resize") },
  { item: "every PTY resize waits for a parsed host repaint at the requested geometry", status: verdict(passed(/every resize has a parsed/), matrixRuns.length === MODES.length * LAUNCHES.length), evidence: matrixRuns.map((run) => `report.json runs.${run.name}.receipts.resizeAcknowledgments`) },
  { item: "task label with ANSI/control and markup text renders inert", status: verdict(passed(/rendered inert/), passed(/rendered inert/).length > 0), evidence: captureIds((c) => c.state === "active" && c.theme === "dark" && c.cols === 200) },
  { item: "resize/theme interruptions mid-update leave a consistent board", status: verdict(passed(/after-resize-burst/), captureIds((c) => c.state === "active-after-resize-burst").length > 0), evidence: captureIds((c) => c.state === "active-after-resize-burst") },
  { item: "host logs carry no runtime singleton/renderer errors", status: verdict(passed(/singleton\/renderer/), matrixRuns.length > 0), evidence: runs.map((run) => `${run.name}-host.log`) },
  { item: "shipped launch modes with default settings (standalone, service with two locations) keep the board readable and never hold on an unreachable form API", status: verdict(passed(/keeps the board readable|no form_state_unknown hold/), evidenceRuns.length > 0), blockedBy: blockedBy(passed(/keeps the board readable|no form_state_unknown hold/)), evidence: evidenceRuns.flatMap((run) => run.captures.map((c) => c.id)) },
  { item: "cleanup: every spawned process gone, used ports closed, sandboxes removed (ps/lsof receipts)", status: verdict(passed("cleanup:"), true), blockedBy: blockedBy(passed("cleanup:")), evidence: ["report.json cleanup"] },
  { item: "packed tarball installs the freshly built dist (no stale state)", status: verdict(passed("packed:"), MODES.includes("packed")), evidence: ["report.json receipts.packed"] },
  { item: "registry: isolated configuration contains only a unique name@version plugin", status: verdict(passed("registry: config plugins"), runs.some((run) => run.kind === "registry")), evidence: ["report.json runs.registry-name-version.receipts.plugins", "report.json runs.registry-name-version.receipts.registry"] },
  { item: "registry: host entrypoint loads from the isolated host npm cache", status: verdict(passed("registry: host entrypoint"), runs.some((run) => run.kind === "registry")), evidence: ["registry-name-version-host.log"] },
  { item: "registry: local npm-compatible registry receives metadata and tarball requests", status: verdict(passed("registry: metadata and tarball"), runs.some((run) => run.kind === "registry")), evidence: ["report.json runs.registry-name-version.receipts.registryRequests"] },
  { item: "registry: active and held boards render live in the native 200x50 sidebar", status: verdict(passed(/^registry-name-version-(active|held-stop)-/), captureIds((capture) => capture.run === "registry-name-version").length === 2), evidence: captureIds((capture) => capture.run === "registry-name-version") },
  { item: "PNG screenshots rendered by xterm.js in Bun.WebView from the raw PTY bytes", status: verdict(passed(/xterm\.js browser grid/), PNG && runs.some((run) => run.captures.some((c) => c.files.png))), blockedBy: blockedBy(passed(/xterm\.js browser grid/)), evidence: captureIds((c) => Boolean(c.files.png)) },
];
const themeMismatches = runs.flatMap((run) => run.captures.flatMap((capture) => {
  const tokens = run.tokens[capture.theme];
  return Object.entries(capture.colors).filter(([, color]) => !color.host && ((tokens && color.fg !== tokens[color.token]) || (color.token === "base" && color.contrast !== null && color.contrast < BASE_CONTRAST)))
    .map(([label, color]) => ({ run: run.name, capture: capture.id, label, ...color, expected: tokens?.[color.token] ?? null }));
}));
const themeDefect: Record<string, unknown>[] = themeMismatches.length === 0 ? [] : [{
  id: "D3-stale-theme-colours",
  runs: [...new Set(themeMismatches.map((entry) => entry.run))],
  symptom: "plugin text is not painted with the host's current theme token (or host-primary text falls below 4.5:1) after the native Color mode switch",
  where: "src/tui.tsx renderers must read host.theme inside tracked render expressions; see TodoTitle/TodoStatusLines/TodoPhaseList/TodoComposerSummary/TodoPanel",
  evidence: themeMismatches.slice(0, 12),
}];
const productDefects = themeDefect.concat(evidenceRuns.flatMap((run) => {
  const observed = run.receipts.observed as { invalid?: boolean; formStateUnknown?: boolean; duringTurn?: Observation; afterTurn?: Observation } | undefined;
  const hostLog = run.receipts.hostLog as { locations?: string[]; pluginLoads?: number; http4xx?: string[] } | undefined;
  const defects: Record<string, unknown>[] = [];
  const diagnostic = observed?.duringTurn?.diagnostic ?? observed?.afterTurn?.diagnostic;
  if (observed?.invalid)
    defects.push({
      id: "D2-rpc-registration-per-location",
      run: run.name,
      launch: run.receipts.launch,
      symptom: `native sidebar shows "Todo invalid / invalid: ${diagnostic}" for the session that just wrote the board`,
      where: "src/todo/tool.ts registerTodoRpc get(): ownsSession compares session.location.directory with ctx.location.directory; src/index.ts setup registers the same RPC id once per location instance",
      cause: `the host booted ${hostLog?.locations?.length ?? "?"} locations (${(hostLog?.locations ?? []).join(", ")}) and loaded the plugin ${hostLog?.pluginLoads ?? "?"} times; whichever instance registered open-gajae.todo last answers every get and rejects the other location's sessions`,
      capture: run.captures.map((c) => c.files.txt),
      hostLog: `${run.name}-host.log`,
    });

  if (observed?.formStateUnknown)
    defects.push({
      id: "D1-form-reader-discovery",
      run: run.name,
      launch: run.receipts.launch,
      symptom: `the board is held right after the first todo write: sidebar "held" + "hold: form_state_unknown" and an <open-gajae-todo-notice>`,
      where: "src/todo/continuation.ts readTodoHostForms(): Service.discover() + an OpenCode client without a location/directory; recordFormHold() marks the state unknown when the reader throws",
      cause: `no service registration exists for a --standalone private server, and a directory-less request lands in the service's default location; host log 4xx: ${JSON.stringify(hostLog?.http4xx ?? [])}`,
      capture: run.captures.map((c) => c.files.txt),
      hostLog: `${run.name}-host.log`,
    });
  return defects;
}));
const invalidTitleFailures = runs.flatMap((run) => run.captures
  .filter((capture) => capture.state.startsWith("invalid") && capture.cols === 200)
  .filter((capture) => {
    const grid = readFileSync(capture.files.txt, "utf8");
    return /invalid:/.test(grid) && !regions(grid).some((band) => band.includes("Todo invalid"));
  })
  .map((capture) => ({ run: run.name, capture: capture.files, state: capture.state, offset: capture.offset })));
if (invalidTitleFailures.length > 0) productDefects.push({
  id: "D4-invalid-title-cells",
  where: "src/tui.tsx:244-255 (TodoTitle)",
  symptom: "The invalid diagnostic remains visible but the title loses its Todo cells at 200x50.",
  sequence: "active -> held-question -> held-stop -> live dark/light switch -> terminal -> empty -> 80x24/200x50 resize -> corrupt state bytes -> todo view -> invalid diagnostic -> resize 80x24 -> 200x50",
  evidence: invalidTitleFailures,
  reproduction: `${new Set(invalidTitleFailures.map((entry) => entry.run)).size}/${matrixRuns.length} matrix runs observed the missing title; this records frequency, not a deterministic claim.`,
});
const currentRuns = Object.fromEntries(runs.map((run) => [run.name, { receipts: run.receipts, events: run.events, captures: run.captures }]));
const mergedRuns = { ...(checkpointReport?.runs ?? {}), ...currentRuns };
const currentChecks = report.checks;
const mergedChecks = [...new Map([...(checkpointReport?.checks ?? []), ...currentChecks].map((check) => [check.name, check])).values()];
const previousAcceptance = new Map((checkpointReport?.acceptance ?? []).map((entry) => [entry.item, entry]));
const mergedAcceptance = DIAGNOSTICS_ONLY && checkpointReport
  ? acceptance.map((entry) => entry.item.startsWith("cleanup:")
    ? entry
    : previousAcceptance.get(entry.item) ?? entry)
  : acceptance;
const reportJson = {
  complete: final,
  task: "7b - real native read-only todo TUI QA (plan checkbox 7, visual scenario native-read-only-sidebar)",
  started: checkpointReport?.started ?? started,
  finished: new Date().toISOString(),
  host: { binary: HOST, version: HOST_VERSION },
  launches: {
    matrix: REGISTRY_ONLY ? [] : LAUNCHES.length > 0 ? LAUNCHES : checkpointReport?.launches?.matrix ?? [],
    defaultSettingsPasses: [...new Set([...(checkpointReport?.launches?.defaultSettingsPasses ?? []), ...evidenceRuns.map((run) => run.name)])],
  },
  registryOnly: REGISTRY_ONLY,
  disabledOnly: DISABLED_ONLY,
  disabledControlEnabled: DISABLED_CONTROL_ENABLED,
  twoLocationRuns: [...(checkpointReport?.twoLocationRuns ?? []), ...runs.filter((run) => ((run.receipts.hostLog as { locations?: string[] } | undefined)?.locations?.length ?? 0) > 1).map((run) => ({
    run: run.name, locations: (run.receipts.hostLog as { locations?: string[] }).locations, pluginLoads: (run.receipts.hostLog as { pluginLoads?: number }).pluginLoads,
    boardReadable: run.captures.filter((capture) => !capture.state.startsWith("invalid")).every((capture) => !/Todo invalid/.test(readFileSync(capture.files.txt, "utf8"))),
  }))],
  primary: primaryRun
    ? { sourceRun: primaryRun.name, files: primaryFiles }
    : checkpointReport?.primary ?? { sourceRun: null, files: [] },
  cleanup: globalCleanup,
  settings: { todo: { continuation: false }, reason: "visual states must stay stable; the continuation loop is task 7a's host probe" },
  installModes: MODES.length > 0 ? MODES : checkpointReport?.installModes ?? [],
  xterm: receipts.xterm ?? checkpointReport?.xterm,
  runs: mergedRuns,
  acceptance: mergedAcceptance,
  adversarial: {
    stale_state: { status: verdict(passed("packed:"), MODES.includes("packed")), detail: "dist rebuilt before the dev run and by prepack; tarball/installed dist hashes compared with the fresh build" },
    misleading_success_output: { status: "PASS", detail: "every assertion reads the rendered terminal grid or state-file bytes; logs are only scanned for failures" },
    hung_commands: { status: "PASS", detail: "every wait is an event barrier with a bounded timeout; hosts are SIGTERM/SIGKILL'd and leftover pids under the sandbox root are killed" },
    repeated_interruptions: { status: verdict(passed(/after-resize-burst|backgrounds differ/), matrixRuns.length > 0), detail: "five sequential acknowledged PTY resizes while the reply streams, theme toggles between captures" },
    prompt_injection: { status: verdict(passed(/rendered inert/), passed(/rendered inert/).length > 0), detail: "task label carrying ESC[31m and <b> markup is shown as text; its control bytes become U+FFFD" },
    paid_model_variance: { status: "N/A", reason: "deterministic local provider only" },
    storage_races: { status: "N/A", reason: "the TUI never writes; the single writer is the todo tool in one session" },
    flaky_tests: { status: verdict(passed(/every resize has a parsed/), matrixRuns.length === MODES.length * LAUNCHES.length), detail: "bounded synchronized-frame/geometry barriers; repeatability receipts are recorded by separate consecutive full-matrix runs" },
  },
  product_defects: [...(checkpointReport?.product_defects ?? []), ...productDefects],
  accepted_host_status_markers: [...(checkpointReport?.accepted_host_status_markers ?? []), ...runs.flatMap((run) => run.captures.flatMap((capture) =>
    Object.entries(capture.colors).filter(([, color]) => !color.host && run.tokens[capture.theme] !== undefined && ["info", "success", "warning"].includes(color.token))
      .map(([label, color]) => {
        const hostToken = run.tokens[capture.theme]?.[color.token];
        const hostContrast = hostToken && color.bg !== "default" ? contrast(hostToken, color.bg) : null;
        return { capture: capture.id, label, token: color.token, foreground: color.fg, hostToken, contrast: color.contrast, hostContrast, accepted: color.fg === hostToken && color.contrast === hostContrast };
      })))],
  receipts: { ...(checkpointReport?.receipts ?? {}), ...receipts },
  checks: mergedChecks,
};
writeFileSync(reportFile, JSON.stringify(reportJson, null, 2));
}

// Write a checkpoint before acquiring resources and after every run. An early
// exit or an exception during teardown must leave explicit FAILs, not no report.
let finalized = false;
function emergencyCleanup(): void {
  for (const sandbox of sandboxes) {
    sandbox.provider.stop();
    const owned = diagnostic(["ps", "eww", "-axo", "pid,command"]).stdout.split("\n")
      .filter((line) => line.includes(HOST) && line.includes(`HOME=${sandbox.home} `));
    for (const line of owned) {
      const pid = Number(line.trim().split(/\s+/)[0]);
      if (isAlive(pid)) process.kill(pid, "SIGKILL");
    }
    receipts.emergencyCleanup = [...(Array.isArray(receipts.emergencyCleanup) ? receipts.emergencyCleanup : []), { root: sandbox.root, owned }];
    if (!KEEP) rmSync(sandbox.root, { recursive: true, force: true });
  }
  if (!KEEP) rmSync(scratch, { recursive: true, force: true });
}
process.on("exit", () => {
  if (finalized) return;
  emergencyCleanup();
  writeReport(false);
});
for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const)
  process.on(signal, () => {
    if (finalized) return;
    emergencyCleanup();
    writeReport(false);
    finalized = true;
    process.exit(exitCode);
  });
async function attempt(name: string, work: () => Promise<Run>): Promise<void> {
  try {
    await work();
  } catch (error) {
    report.check(`${name}: launch or cleanup completed`, false, String(error));
  } finally {
    writeReport(false);
  }
}
try {
  writeReport(false);
  if (!DIAGNOSTICS_ONLY) {
  console.log(`WORKING: task7b - resolving xterm packages`);
  xterm = await loadXterm();
  receipts.xterm = xterm.source;
  const terminal = xterm;
  if (!REGISTRY_ONLY) {
    const build = await command(["bun", "run", "build:tui"], REPO, { ...process.env, BUN_CONFIG_VERBOSE_FETCH: undefined });
    report.check("dev: dist/tui.js rebuilt from the current sources before the run", build.exit === 0, build);
    receipts.devDist = sha256(readFileSync(join(REPO, "dist/tui.js")));
    console.log("WORKING: task9 - disabled dev-dir standalone");
    await attempt("dev-standalone-disabled", () => runDisabled(report, terminal));
  }
  if (MODES.includes("dev")) {
    for (const launch of LAUNCHES) {
      console.log(`WORKING: task7b - dev-dir matrix (${launch})`);
      await attempt(`dev-${launch}`, () => runMatrix(report, terminal, "dev", launch, REPO));
    }
    for (const launch of (["standalone", "service"] as const).filter((candidate) => LAUNCHES.includes(candidate))) {
      const attempts = launch === "service" ? 3 : 1;
      for (let attemptIndex = 1; attemptIndex <= attempts; attemptIndex++) {
        console.log(`WORKING: task7b - dev-dir default-settings pass (${launch}, attempt ${attemptIndex})`);
        await attempt(`dev-${launch}-defaults-${attemptIndex}`, () => runEvidence(report, terminal, launch, REPO, attemptIndex));
      }
    }
  }
  if (MODES.includes("packed") || REGISTRY_ONLY) {
    console.log(`WORKING: task7b - npm pack and consumer install`);
    const packed = await packAndInstall(report, scratch);
    receipts.packed = packed.receipts;
    const pluginDir = packed.pluginDir;
    if (pluginDir) {
      for (const launch of REGISTRY_ONLY ? [] : LAUNCHES) {
        console.log(`WORKING: task7b - packed matrix (${launch})`);
        await attempt(`packed-${launch}`, () => runMatrix(report, terminal, "packed", launch, pluginDir));
      }
      if (packed.tarball) {
        const tarball = packed.tarball;
        console.log("WORKING: task7b - registry name@version native TUI");
        await attempt("registry-name-version", () => runRegistry(report, terminal, scratch, tarball));
      }
    } else report.check("packed matrix observed", false, "install failed");
  }
  if (PNG) {
    console.log(`WORKING: task7b - rendering PNG screenshots with xterm.js in Bun.WebView`);
    receipts.png = await renderPngs(report, terminal, runs);
  }
  }
} catch (error) {
  report.check("probe ran to completion", false, String(error).slice(0, 2_000));
} finally {
  // Only processes whose environment names one of this probe's sandboxes are
  // ours. Never kill another OpenCode instance merely because its name matches.
  emergencyCleanup();
  // Checkpoint-only assertions are not final acceptance results.
  for (let index = report.checks.length - 1; index >= 0; index--)
    if (/^(plan-named |cleanup:)/.test(report.checks[index]?.name ?? "")) report.checks.splice(index, 1);
  writeReport(true);
  finalized = true;
}
console.log(`report: ${join(EVIDENCE, "report.json")}`);
report.summary();
if (report.failed === 0) console.log("TODO_TUI_QA_OK");
process.exit(report.failed === 0 ? 0 : 1);
