// Shared driver for the v2 host probes (plan Step 8). It runs the installed
// OpenCode host (`~/.opencode/bin/opencode`, 2.0.26) as a private
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
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";

export const REPO = resolve(import.meta.dir, "..");
export const HOST =
  process.env.OPEN_GAJAE_TEST_HOST ?? join(homedir(), ".opencode/bin/opencode");
export const HOST_VERSION = "opencode v2.0.26";

export function isSupportedHostVersion(version: string): boolean {
  return version === HOST_VERSION;
}

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
  "todo",
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

/** Register before the triggering action. Timeouts bound failure, never signal progress. */
export function waitForEvent<T>(
  label: string,
  subscribe: (listener: (value: T) => void) => () => void,
  predicate: (value: T) => boolean = () => true,
  timeout = 60_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out: ${label}`));
    }, timeout);
    const unsubscribe = subscribe((value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    });
  });
}

export function barrier() {
  let release: () => void = () => fail("barrier not initialized");
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
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
  readonly cleanup: unknown[] = [];
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
      timeout: 30_000,
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
export type Directive = {
  tag: string; steps: Action[]; clearAfter?: number;
  todo?: "active" | "stagnant" | "failure" | "status-only";
};

export const directive = (value: Directive) =>
  `#ACTION ${JSON.stringify(value)}`;

const DIRECTIVE_LINE = /#ACTION (\{.*\})\s*$/m;
const CONTINUATION = /<ralplan-continuation>[\s\S]*?REINFORCEMENT (\d+)\//;
const GOAL_CONTINUATION = "<goal-continuation>";
/** Plugin messages a model reads as context, never as its next instruction. */
const PASSIVE_USER = /^(<goal-(context|notice)>|<open-gajae-todo-(context|notice)>|<conversation-checkpoint>)/;
/** The host's compaction prompts (`core/src/session/compaction.ts:364-390`). */
const COMPACTION_PROMPT = /^(You MUST summarize the conversation above|Update the existing checkpoint in the conversation above)/;
const COMPACTION_SUMMARY = "## Objective\n- Probe the plugin's hooks.\n\n## Next Move\n1. (none)\n";

export type ProviderEntry = {
  t: number;
  /** The tag of the newest `#ACTION` anywhere in the thread. */
  thread?: string;
  /** What the last user message was: a directive, a continuation, or other. */
  kind: "directive" | "continuation" | "todo-continuation" | "other" | "title";
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
  if (own) {
    // The context hook deliberately replaces stale synthetic directives. Detect
    // re-entry from the assistant's previous tool-less yield, not passive notices.
    const yielded = messages.slice(lastUser + 1).some((m) =>
      m.role === "assistant" && !m.tool_calls?.length && contentText(m.content).length > 0);
    const context = [...messages].reverse().find((m) =>
      m.role === "user" && contentText(m.content).startsWith("<open-gajae-todo-context>"));
    if (own.todo && yielded && context) {
      const text = contentText(context.content);
      const data = text.match(/\n(\{"generation".*)/)?.[1];
      const board = data ? JSON.parse(data) : undefined;
      const task = board?.focus?.task;
      const action: Action = own.todo === "active" && typeof task === "string"
        ? { tool: "todo", args: { op: "done", task } }
        : own.todo === "failure" ? { error: 400 }
        : own.todo === "status-only" ? { tool: "todo", args: { op: "view" } }
        : { text: "premature yield without progress" };
      // One real operation per resumed execution, then yield again.
      const previous = [...messages].reverse().find((m) =>
        m.role !== "user" || !PASSIVE_USER.test(contentText(m.content)));
      const afterTool = previous?.role === "tool";
      return { kind: "todo-continuation" as const, step: 0, thread: own,
        steps: [afterTool ? { text: "resumed operation finished" } : action] };
    }
    return { kind: "directive" as const, step, thread: own, steps: own.steps };
  }
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
  private callbacks = new EventEmitter();
  private gates = new Set<{
    predicate: (entry: ProviderEntry) => boolean;
    reached: (entry: ProviderEntry) => void;
    gate: ReturnType<typeof barrier>;
  }>();
  constructor(dir: string) {
    this.log = join(dir, "provider.jsonl");
  }

  get port() { return this.server?.port; }

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
        this.callbacks.emit("request", entry);
        for (const gate of this.gates) {
          if (!gate.predicate(entry)) continue;
          gate.reached(entry);
          await gate.gate.promise;
          this.gates.delete(gate);
        }
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

  waitForEvent(predicate: (entry: ProviderEntry) => boolean, timeout = 60_000) {
    return waitForEvent("provider request", (listener) => {
      this.callbacks.on("request", listener);
      return () => { this.callbacks.off("request", listener); };
    }, predicate, timeout);
  }

  /** Install before prompting; response remains blocked until explicit release. */
  hold(predicate: (entry: ProviderEntry) => boolean, timeout = 60_000) {
    const gate = barrier();
    const reached = this.waitForEvent(predicate, timeout);
    this.gates.add({ predicate, reached: () => {}, gate });
    return { reached, release: gate.release };
  }

  stop() {
    for (const gate of this.gates) gate.gate.release();
    this.gates.clear();
    this.server?.stop(true);
  }
}

// ------------------------------------------------------------ disposable host
export type HostEvent = { t: number; type: string; data: any; id?: string; durable?: unknown };

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
  private callbacks = new EventEmitter();
  readonly cleanup: Array<Record<string, unknown>> = [];

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
      timeout: 30_000,
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
    const version = spawnSync(HOST, ["--version"], { cwd: this.project, env: this.env,
      encoding: "utf8", timeout: 30_000 }).stdout.trim();
    report.check(`host version is ${HOST_VERSION}`, isSupportedHostVersion(version), version);
    const paths = spawnSync(HOST, ["debug", "paths"], { cwd: this.project, env: this.env,
      encoding: "utf8", timeout: 30_000 })
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
    this.eventAbort = new AbortController();
    const out = { text: "" };
    this.server = spawn(HOST, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: this.project,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const server = this.server;
    await waitForEvent<string>("server listening", (listener) => {
      const stdout = (d: Buffer) => {
        out.text += d;
        appendFileSync(join(this.root, "server.out"), d);
        listener(out.text);
      };
      const stderr = (d: Buffer) => {
        out.text += d;
        appendFileSync(join(this.root, "server.err"), d);
        listener(out.text);
      };
      server.stdout?.on("data", stdout);
      server.stderr?.on("data", stderr);
      return () => {
        server.stdout?.off("data", stdout);
        server.stderr?.off("data", stderr);
        server.stderr?.on("data", (d) => appendFileSync(join(this.root, "server.err"), d));
      };
    }, (text) => /listening on (http:\/\/\S+)/.test(text) && /server password (\S+)/.test(text));
    this.baseUrl = out.text.match(/listening on (http:\/\/\S+)/)![1]!;
    const password = out.text.match(/server password (\S+)/)![1]!;
    this.auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const subscribed = this.waitForEvent(() => true);
    void this.subscribe();
    await subscribed;
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
            const event: HostEvent = {
              t: Date.now(), type: parsed.type, data: parsed.data ?? parsed.properties,
              id: parsed.id, durable: parsed.durable,
            };
            this.events.push(event);
            this.callbacks.emit("event", event);
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

  waitForEvent(predicate: (event: HostEvent) => boolean, timeout = 60_000) {
    return waitForEvent("host SSE event", (listener) => {
      this.callbacks.on("event", listener);
      return () => { this.callbacks.off("event", listener); };
    }, predicate, timeout);
  }

  async terminal(sessionID: string, since: number, timeout = 60_000) {
    const predicate = (e: HostEvent) => e.t >= since && e.data?.sessionID === sessionID &&
      ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(e.type);
    return this.events.find(predicate) ?? await this.waitForEvent(predicate, timeout);
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
      signal: AbortSignal.timeout(180_000),
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
    const terminal = this.terminal(sessionID, since, timeout);
    await this.prompt(sessionID, text, extra);
    return await terminal;
  }

  /** A file under the session's `_session-*` folder, or undefined. */
  sessionFile(sessionID: string, relative: string): string | undefined {
    const root = join(this.project, ".open-gajae");
    if (!existsSync(root)) return undefined;
    const folders = readdirSync(root).filter((name) => name.startsWith("_session-"));
    const legacy = folders.filter((name) => name.endsWith(`-${sessionID}`)).map((name) => join(root, name));
    const matches = legacy.length ? legacy : folders.map((name) => join(root, name, "children", sessionID))
      .filter((directory) => existsSync(directory));
    if (matches.length > 1) throw new Error(`ambiguous probe session directories for ${sessionID}`);
    const folder = matches[0];
    const file = folder && join(folder, relative);
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

  async stopBackend() {
    this.eventAbort.abort();
    const server = this.server;
    if (server && server.exitCode === null) {
      const closed = waitForEvent("host close", (listener) => {
        server.once("close", listener);
        return () => { server.off("close", listener); };
      });
      const force = setTimeout(() => server.kill("SIGKILL"), 5_000);
      server.kill("SIGTERM");
      try { await closed; } finally { clearTimeout(force); }
    }
    const port = this.baseUrl ? Number(new URL(this.baseUrl).port) : undefined;
    this.cleanup.push({
      kind: "backend", pid: server?.pid, exit: server?.exitCode, signal: server?.signalCode,
      closed: !server || server.exitCode !== null || server.signalCode !== null,
      port, portReleased: port === undefined || releasedPort(port),
    });
  }

  async stop() {
    const port = this.provider.port;
    try { await this.stopBackend(); }
    finally {
      this.provider.stop();
      this.cleanup.push({ kind: "provider", port, portReleased: port === undefined || releasedPort(port) });
      writeFileSync(join(this.root, "cleanup.json"), JSON.stringify(this.cleanup, null, 2) + "\n");
    }
  }
}

/** Rebinding proves no listener remains; this is a one-shot check, not polling. */
export function releasedPort(port: number): boolean {
  try {
    const server = Bun.serve({ hostname: "127.0.0.1", port,
      fetch: () => new Response("cleanup check") });
    server.stop(true);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") return false;
    throw error;
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
    report.cleanup.push({ root, receipts: host.cleanup });
    report.check("host/provider closed and ports released",
      host.cleanup.every((receipt) => receipt.portReleased === true && receipt.closed !== false), host.cleanup);
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
