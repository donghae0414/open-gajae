// Shared driver for the v2 host probes (plan Step 8). It runs the installed
// OpenCode host (`~/.opencode/bin/opencode`, 2.0.15) as a private
// `opencode serve` against a deterministic local OpenAI-compatible provider.
//
// Isolation: the host process gets an environment built only from paths under
// a disposable root (HOME, XDG_*, TMPDIR), never the caller's environment.
// `opencode debug paths` must report every global path under that root, and
// the user's real OpenCode and open-gajae directories must hold no file newer
// than the probe's start marker. Both are checks every probe records.
//
// Fake provider protocol. A user message whose last line is
// `#ACTION {"tag": ..., "steps": [...]}` scripts the turn: step k is answered
// on the k-th request after that message (a tool call, several tool calls in
// one assistant message, a text, a delayed text, or an HTTP error). A
// `<ralplan-continuation>` message is answered with
// `ralplan clear` (plan DR-17) once its reinforcement count reaches the
// thread's `clearAfter` (default 1), so a continuation loop always ends. A
// `<goal-continuation>` is answered the same way with `ultragoal clear` and
// then `goal drop` once the number of `<goal-continuation>` messages in the
// thread reaches `clearAfter`. The plugin's `<goal-context>` and
// `<goal-notice>` messages and the host's `<conversation-checkpoint>` (which
// quotes earlier directives) are context, not a new instruction: they never
// count as the last user message. The host's compaction summary request is
// answered with a summary in its template (`core/src/session/compaction.ts:
// 46-77,364-393`), so a compaction completes. A `{{subagent_session:<agent>}}` inside
// scripted tool arguments is replaced with the child `sessionID` of the
// newest `subagent` result whose call named that agent, which is how a
// scripted parent resumes a child it spawned earlier. Title requests (no
// tools) and every other message get a plain text.
// Grown from the Phase 0 spike driver (removed; see commit b08883d).
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "..");
export const HOST =
  process.env.OPEN_GAJAE_TEST_HOST ?? join(homedir(), ".opencode/bin/opencode");
export const HOST_VERSION = "opencode v2.0.15";

export const OUR_TOOLS = [
  "ast_grep_search",
  "deep-interview",
  "goal",
  "lsp_diagnostics",
  "lsp_document_symbols",
  "lsp_find_references",
  "lsp_goto_definition",
  "lsp_hover",
  "lsp_servers",
  "lsp_workspace_symbols",
  "ralplan",
  "ultragoal",
];
export const AGENTS = [
  "open-gajae",
  "open-gajae-architect",
  "open-gajae-cleaner",
  "open-gajae-critic",
  "open-gajae-document-specialist",
  "open-gajae-executor",
  "open-gajae-explore",
  "open-gajae-lateral-reviewer",
  "open-gajae-planner",
];
export const READ_ONLY_AGENTS = AGENTS.filter(
  (id) => id !== "open-gajae" && id !== "open-gajae-executor",
);
export const SKILLS = ["deep-interview", "ralplan", "ultragoal"];

/** The user's real directories this suite must never write. */
const REAL_DIRS = [
  ".config/opencode",
  ".local/share/opencode",
  ".local/state/opencode",
  ".cache/opencode",
  ".open-gajae",
].map((dir) => join(homedir(), dir));

export const sleep = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, ms));

export function fail(message: string): never {
  throw new Error(message);
}

export async function waitFor<T>(
  label: string,
  check: () => T | undefined | false | Promise<T | undefined | false>,
  timeout = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined && value !== false) return value as T;
    await sleep(200);
  }
  return fail(`timed out: ${label}`);
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  return "";
}

// ------------------------------------------------------------ result report
type Check = { name: string; pass: boolean; detail?: unknown };

export class Report {
  readonly checks: Check[] = [];
  constructor(readonly probe: string) {}
  check(name: string, pass: boolean, detail?: unknown) {
    this.checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
    console.log(`${pass ? "PASS" : "FAIL"} ${name}`);
    if (!pass && detail !== undefined)
      console.log(`     ${JSON.stringify(detail).slice(0, 2_000)}`);
  }
  get failed() {
    return this.checks.filter((c) => !c.pass).length;
  }
  summary() {
    const passed = this.checks.length - this.failed;
    console.log(`\n${this.probe}: ${passed} passed, ${this.failed} failed`);
  }
}

/**
 * Run `body` with a report; always print the summary and exit non-zero on any
 * failed check or thrown error. The disposable root is removed on success
 * unless `OPEN_GAJAE_PROBE_KEEP=1`.
 */
export async function runProbe(
  probe: string,
  body: (report: Report, scratch: string) => Promise<void>,
) {
  const report = new Report(probe);
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `${probe}-`)));
  const marker = join(scratch, "start-marker");
  writeFileSync(marker, "");
  console.log(`${probe}: disposable root ${scratch}`);
  try {
    await body(report, scratch);
  } catch (error) {
    report.check("probe ran to completion", false, String(error));
  }
  const touched = REAL_DIRS.filter(existsSync).flatMap((dir) => {
    const found = spawnSync("find", [dir, "-newer", marker], {
      encoding: "utf8",
    });
    return found.stdout.split("\n").filter(Boolean);
  });
  report.check("user's real OpenCode/open-gajae directories untouched", touched.length === 0, touched.slice(0, 20));
  report.summary();
  if (report.failed === 0 && process.env.OPEN_GAJAE_PROBE_KEEP !== "1")
    rmSync(scratch, { recursive: true, force: true });
  else console.log(`artifacts kept at ${scratch}`);
  process.exit(report.failed === 0 ? 0 : 1);
}

// ------------------------------------------------------------ fake provider
export type ToolAction = { tool: string; args?: unknown; rawArgs?: string };
export type Action =
  | ToolAction
  /** Several tool calls in one assistant message; the host runs them in parallel. */
  | { parallel: ToolAction[] }
  | { text: string }
  | { sleep: number; text: string }
  | { error: number };
export type Directive = { tag: string; steps: Action[]; clearAfter?: number };

export const directive = (value: Directive) =>
  `#ACTION ${JSON.stringify(value)}`;

const DIRECTIVE_LINE = /#ACTION (\{.*\})\s*$/m;
const CONTINUATION = /<ralplan-continuation>[\s\S]*?REINFORCEMENT (\d+)\//;
const GOAL_CONTINUATION = "<goal-continuation>";
/** Plugin messages a model reads as context, never as its next instruction. */
const PASSIVE_USER = /^(<goal-(context|notice)>|<conversation-checkpoint>)/;
/** The host's compaction prompts (`core/src/session/compaction.ts:364-390`). */
const COMPACTION_PROMPT = /^(You MUST summarize the conversation above|Update the existing checkpoint in the conversation above)/;
const COMPACTION_SUMMARY = "## Objective\n- Probe the plugin's hooks.\n\n## Next Move\n1. (none)\n";

export type ProviderEntry = {
  t: number;
  /** The tag of the newest `#ACTION` anywhere in the thread. */
  thread?: string;
  /** What the last user message was: a directive, a continuation, or other. */
  kind: "directive" | "continuation" | "other" | "title";
  step: number;
  count?: number;
  tools: string[];
  system: string;
  messages: { role: string; text: string }[];
  toolResults: string[];
  body: any;
};

function sse(chunks: unknown[]) {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}
const chunkBase = {
  id: "chatcmpl-probe",
  object: "chat.completion.chunk",
  created: 1,
  model: "fixture",
};
const textResponse = (text: string) =>
  sse([
    { ...chunkBase, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
let callCounter = 0;
const toolResponse = (calls: { name: string; args: string }[]) =>
  sse([
    {
      ...chunkBase,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: calls.map((call, index) => ({
              index,
              id: `call_probe_${++callCounter}`,
              type: "function",
              function: { name: call.name, arguments: call.args },
            })),
          },
          finish_reason: null,
        },
      ],
    },
    { ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);

function parseDirective(text: string): Directive | undefined {
  const match = text.match(DIRECTIVE_LINE);
  return match ? JSON.parse(match[1]!) : undefined;
}

/**
 * The completed `subagent` results in a request's raw messages, oldest first:
 * the agent the call named, the child `sessionID` and the result text
 * (`<subagent sessionID="…" state="completed">`, `core/src/tool/plugin/subagent.ts`).
 */
export function subagentResults(messages: any[]) {
  const agents = new Map<string, string>();
  for (const m of messages)
    for (const call of m.role === "assistant" ? (m.tool_calls ?? []) : [])
      if (call.function?.name === "subagent")
        agents.set(call.id, JSON.parse(call.function.arguments || "{}").agent);
  return messages.flatMap((m) => {
    const agent = m.role === "tool" ? agents.get(m.tool_call_id) : undefined;
    const text = contentText(m.content);
    const sessionID = text.match(/^<subagent sessionID="([^"]+)"/)?.[1];
    return agent && sessionID ? [{ agent, sessionID, text }] : [];
  });
}

/** Scripted tool arguments with the `{{…}}` placeholders filled in. */
function scriptedArgs(action: ToolAction, messages: any[]): string {
  const args = action.rawArgs ?? JSON.stringify(action.args ?? {});
  return args.replace(
    /\{\{subagent_session:([\w-]+)\}\}/g,
    (placeholder, agent) =>
      subagentResults(messages).filter((r) => r.agent === agent).at(-1)?.sessionID ?? placeholder,
  );
}

function classify(messages: any[]) {
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.role === "user" && !PASSIVE_USER.test(contentText(m.content))) lastUser = i;
  });
  const step = messages
    .slice(lastUser + 1)
    .filter((m) => m.role === "assistant" && m.tool_calls?.length > 0).length;
  let thread: Directive | undefined;
  for (const m of messages) {
    if (m.role !== "user") continue;
    thread = parseDirective(contentText(m.content)) ?? thread;
  }
  const last = lastUser >= 0 ? contentText(messages[lastUser].content) : "";
  if (COMPACTION_PROMPT.test(last))
    return { kind: "other" as const, step, thread, steps: [{ text: COMPACTION_SUMMARY }] as Action[] };
  if (last.startsWith(GOAL_CONTINUATION)) {
    // The thread's goal continuations so far, this one included.
    const count = messages.filter(
      (m) => m.role === "user" && contentText(m.content).startsWith(GOAL_CONTINUATION),
    ).length;
    const clear = count >= (thread?.clearAfter ?? 1);
    const steps: Action[] = clear
      ? [{ tool: "ultragoal", args: { op: "clear" } }, { tool: "goal", args: { op: "drop" } }, { text: "dropped" }]
      : [{ text: `continuing ${count}` }];
    return { kind: "continuation" as const, step, thread, steps, count };
  }
  const own = parseDirective(last);
  if (own) return { kind: "directive" as const, step, thread: own, steps: own.steps };
  const continuation = last.match(CONTINUATION);
  if (continuation) {
    const count = Number(continuation[1]);
    const clear = count >= (thread?.clearAfter ?? 1);
    const steps: Action[] = clear
      ? [{ tool: "ralplan", args: { op: "clear" } }, { text: "cleared" }]
      : [{ text: `continuing ${count}` }];
    return { kind: "continuation" as const, step, thread, steps, count };
  }
  return { kind: "other" as const, step, thread, steps: [] as Action[] };
}

export class FakeProvider {
  readonly log: string;
  private server?: ReturnType<typeof Bun.serve>;
  private slept = new Set<string>();
  constructor(dir: string) {
    this.log = join(dir, "provider.jsonl");
  }

  start(): string {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 120,
      fetch: async (request) => {
        const body: any = await request.json().catch(() => null);
        const messages: any[] = body?.messages ?? [];
        const tools: string[] = (body?.tools ?? []).map((t: any) => t.function?.name);
        const c = tools.length ? classify(messages) : undefined;
        const entry: ProviderEntry = {
          t: Date.now(),
          thread: c?.thread?.tag,
          kind: c?.kind ?? "title",
          step: c?.step ?? 0,
          ...(c && "count" in c ? { count: c.count } : {}),
          tools,
          system: messages[0]?.role === "system" ? contentText(messages[0].content) : "",
          messages: messages.map((m) => ({ role: m.role, text: contentText(m.content) })),
          toolResults: messages.filter((m) => m.role === "tool").map((m) => contentText(m.content)),
          body,
        };
        appendFileSync(this.log, JSON.stringify(entry) + "\n");
        if (!c) return textResponse("Probe title");
        const action = c.steps[c.step];
        if (!action) return textResponse(c.thread ? `done:${c.thread.tag}` : "ack");
        if ("error" in action)
          return new Response(JSON.stringify({ error: { message: "probe provider error", type: "invalid_request_error" } }), {
            status: action.error,
            headers: { "content-type": "application/json" },
          });
        if ("sleep" in action) {
          const key = `${c.thread?.tag}:${c.step}`;
          if (!this.slept.has(key)) {
            this.slept.add(key);
            await sleep(action.sleep);
          }
          return textResponse(action.text);
        }
        if ("tool" in action || "parallel" in action)
          return toolResponse(
            ("parallel" in action ? action.parallel : [action]).map((call) => ({
              name: call.tool,
              args: scriptedArgs(call, messages),
            })),
          );
        return textResponse(action.text);
      },
    });
    return `http://127.0.0.1:${this.server.port}/v1`;
  }

  entries(): ProviderEntry[] {
    if (!existsSync(this.log)) return [];
    return readFileSync(this.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  /** Model requests (not title requests) of one thread tag. */
  thread(tag: string): ProviderEntry[] {
    return this.entries().filter((e) => e.kind !== "title" && e.thread === tag);
  }

  stop() {
    this.server?.stop(true);
  }
}

// ------------------------------------------------------------ disposable host
export type HostEvent = { t: number; type: string; data: any };

export class Host {
  readonly env: Record<string, string>;
  readonly home: string;
  readonly project: string;
  readonly provider: FakeProvider;
  private server?: ChildProcess;
  private baseUrl = "";
  private auth = "";
  private events: HostEvent[] = [];
  private eventAbort = new AbortController();

  constructor(readonly root: string) {
    this.home = join(root, "env/home");
    this.project = join(root, "project");
    this.provider = new FakeProvider(root);
    this.env = {
      PATH: `${join(homedir(), ".bun/bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: this.home,
      XDG_CONFIG_HOME: join(this.home, ".config"),
      XDG_DATA_HOME: join(this.home, ".local/share"),
      XDG_CACHE_HOME: join(this.home, ".cache"),
      XDG_STATE_HOME: join(this.home, ".local/state"),
      TMPDIR: join(root, "env/tmp"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      FAKE_API_KEY: "fixture",
    };
  }

  /**
   * Write the disposable host config (the P0 provider block plus `extra`),
   * a git project, then check the version and the path isolation.
   */
  prepare(report: Report, extra: Record<string, unknown>) {
    const baseURL = this.provider.start();
    for (const dir of [join(this.home, ".config/opencode"), this.env.TMPDIR!, this.project])
      mkdirSync(dir, { recursive: true });
    spawnSync("git", ["init", "-q", this.project], {
      env: { ...this.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    writeFileSync(join(this.project, "sample.ts"), "export const fixture = true;\n");
    writeFileSync(
      join(this.home, ".config/opencode/opencode.jsonc"),
      JSON.stringify(
        {
          model: "fake/model-a",
          providers: {
            fake: {
              name: "Fake",
              env: ["FAKE_API_KEY"],
              package: "@opencode/ai/providers/openai-compatible",
              settings: { baseURL },
              models: { "model-a": {} },
            },
          },
          ...extra,
        },
        null,
        2,
      ),
    );
    const version = spawnSync(HOST, ["--version"], { env: this.env, encoding: "utf8" }).stdout.trim();
    report.check(`host version is ${HOST_VERSION}`, version === HOST_VERSION, version);
    const paths = spawnSync(HOST, ["debug", "paths"], { cwd: this.project, env: this.env, encoding: "utf8" })
      .stdout.trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/));
    const outside = paths.filter(([, path]) => !path?.startsWith(this.root));
    report.check(
      "`opencode debug paths` are all under the disposable root",
      paths.length >= 10 && outside.length === 0,
      { count: paths.length, outside },
    );
  }

  async start() {
    const out = { text: "" };
    this.server = spawn(HOST, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: this.project,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.server.stdout!.on("data", (d) => (out.text += d));
    this.server.stderr!.on("data", (d) => {
      out.text += d;
      appendFileSync(join(this.root, "server.err"), d);
    });
    await waitFor("server listening", () => /server password (\S+)/.test(out.text), 60_000);
    this.baseUrl = out.text.match(/listening on (http:\/\/\S+)/)![1]!;
    const password = out.text.match(/server password (\S+)/)![1]!;
    this.auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    void this.subscribe();
  }

  /** Record the server event stream (`GET /api/event`). */
  private async subscribe() {
    try {
      const response = await fetch(`${this.baseUrl}/api/event`, {
        headers: { authorization: this.auth, accept: "text/event-stream" },
        signal: this.eventAbort.signal,
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            this.events.push({ t: Date.now(), type: parsed.type, data: parsed.data ?? parsed.properties });
          } catch {
            // Non-JSON keep-alive.
          }
        }
      }
    } catch {
      // Aborted at stop.
    }
  }

  sessionEvents(sessionID: string, since = 0): HostEvent[] {
    return this.events.filter((e) => e.t >= since && e.data?.sessionID === sessionID);
  }

  allEvents(since = 0): HostEvent[] {
    return this.events.filter((e) => e.t >= since);
  }

  async terminal(sessionID: string, since: number, timeout = 60_000) {
    return await waitFor(
      `terminal event for ${sessionID}`,
      () =>
        this.sessionEvents(sessionID, since).find((e) =>
          ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(e.type),
        ),
      timeout,
    );
  }

  /** Wait until the session has been quiet (no event) for `quietMs`. */
  async settle(sessionID: string, quietMs = 3_000, timeout = 90_000) {
    await waitFor(
      `session ${sessionID} settled`,
      () => {
        const last = this.sessionEvents(sessionID).at(-1);
        const types = this.sessionEvents(sessionID).map((e) => e.type);
        const running =
          types.lastIndexOf("session.execution.started") >
          Math.max(
            types.lastIndexOf("session.execution.succeeded"),
            types.lastIndexOf("session.execution.failed"),
            types.lastIndexOf("session.execution.interrupted"),
          );
        return !running && (!last || Date.now() - last.t >= quietMs);
      },
      timeout,
    );
  }

  async api(method: string, path: string, body?: unknown) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: this.auth,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: response.status, json };
  }

  /** `data` of a list response, or the response itself when it is a list. */
  async list(path: string): Promise<any[]> {
    const { json } = await this.api("GET", path);
    return Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  }

  async createSession(input: Record<string, unknown> = {}): Promise<string> {
    const response = await this.api("POST", "/api/session", input);
    return response.json?.data?.id ?? fail(`session create failed: ${JSON.stringify(response)}`);
  }

  async prompt(sessionID: string, text: string, extra: Record<string, unknown> = {}) {
    const response = await this.api("POST", `/api/session/${sessionID}/prompt`, { text, ...extra });
    if (response.status >= 400) fail(`prompt failed: ${JSON.stringify(response)}`);
    return response;
  }

  /** Prompt, wait for the first terminal event, and return it. */
  async turn(sessionID: string, text: string, extra: Record<string, unknown> = {}, timeout = 60_000) {
    const since = Date.now();
    await this.prompt(sessionID, text, extra);
    return await this.terminal(sessionID, since, timeout);
  }

  /** A file under the session's `_session-*` folder, or undefined. */
  sessionFile(sessionID: string, relative: string): string | undefined {
    const root = join(this.project, ".open-gajae");
    if (!existsSync(root)) return undefined;
    const folder = spawnSync("ls", [root], { encoding: "utf8" })
      .stdout.split("\n")
      .find((name) => name.endsWith(`-${sessionID}`));
    const file = folder && join(root, folder, relative);
    return file && existsSync(file) ? readFileSync(file, "utf8") : undefined;
  }

  /** The ralplan state file of a session, or undefined. */
  ralplanState(sessionID: string): Record<string, unknown> | undefined {
    const text = this.sessionFile(sessionID, "state/ralplan-state.json");
    return text === undefined ? undefined : JSON.parse(text);
  }

  /** The ultragoal state file of a session, or undefined. */
  ultragoalState(sessionID: string): Record<string, unknown> | undefined {
    const text = this.sessionFile(sessionID, "state/ultragoal-state.json");
    return text === undefined ? undefined : JSON.parse(text);
  }

  /** The goal state file of a session, or undefined. */
  goalState(sessionID: string): Record<string, unknown> | undefined {
    const text = this.sessionFile(sessionID, "state/goal-state.json");
    return text === undefined ? undefined : JSON.parse(text);
  }

  async stop() {
    this.eventAbort.abort();
    if (this.server && this.server.exitCode === null) {
      this.server.kill("SIGTERM");
      await Promise.race([new Promise((done) => this.server!.once("close", done)), sleep(5_000)]);
      if (this.server.exitCode === null) this.server.kill("SIGKILL");
    }
    this.provider.stop();
  }
}

/** Create, prepare and start a host; stop it after `body`, even on failure. */
export async function withHost(
  report: Report,
  root: string,
  config: Record<string, unknown>,
  body: (host: Host) => Promise<void>,
) {
  mkdirSync(root, { recursive: true });
  const host = new Host(root);
  try {
    host.prepare(report, config);
    await host.start();
    await body(host);
  } finally {
    await host.stop();
  }
}

/**
 * The Code Mode catalog in a request's system prompt: the `- opencode (N tools)`
 * namespace line and its `tools.opencode.<name>(` entries (Phase 0 P6d).
 */
export function opencodeCatalog(entry: ProviderEntry | undefined) {
  const system = entry?.system ?? "";
  return {
    namespaceLine: system.match(/^- opencode \([^)]*\)/m)?.[0],
    entries: [...system.matchAll(/^\s*- tools\.opencode\.(\w+)\(/gm)].map((m) => m[1]!),
  };
}
