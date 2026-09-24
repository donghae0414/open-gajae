// Phase 0 host spike driver for the OpenCode v2 port (plan: .omc/plans/ralplan-opencode-v2-port.md,
// Section 2, rows P0-P9). First draft for the Step 8 host probes.
//
// Usage: bun tests/spike-v2/phase0-probe.ts <disposable-root> [A|B]
//   A (default): P0-P3 and P5-P9 plus the zod 4.6 / JSON Schema tools of P4.
//   B: P4 with the zod 4.1.8 schema that ships inside @opencode/plugin (isolated because a
//      schema the host cannot convert may break every request of the run).
//
// Isolation: the host runs with HOME, XDG_* and TMPDIR inside <disposable-root>/env, and the
// only model provider is the deterministic local OpenAI-compatible fixture below. Nothing is
// read from or written to the user's real OpenCode config, data, cache or state.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? fail("usage: phase0-probe.ts <disposable-root> [A|B]"));
const run = (process.argv[3] ?? "A") as "A" | "B";
const host = process.env.OPEN_GAJAE_TEST_HOST ?? join(process.env.HOME ?? "", ".opencode/bin/opencode");
const runDir = join(root, `run-${run}`);
const envDir = join(runDir, "env");
const home = join(envDir, "home");
const project = join(runDir, "project");
const pluginDir = join(root, "plugin");
const pluginLog = join(runDir, "plugin.jsonl");
const providerLog = join(runDir, "provider.jsonl");
const results: Record<string, unknown> = {};
let server: ChildProcess | undefined;
let provider: ReturnType<typeof Bun.serve> | undefined;

function fail(message: string): never {
  throw new Error(message);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Entry = Record<string, any>;
function readJsonl(path: string): Entry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor<T>(label: string, check: () => T | undefined, timeout = 30_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    await sleep(200);
  }
  fail(`timed out: ${label}`);
}

// ---------------------------------------------------------------- fixture provider (P0)
type Action =
  | { tool: string; args?: unknown; rawArgs?: string; tag?: string }
  | { text: string; tag?: string }
  | { sleep: number; text: string; tag?: string }
  | { error: number; tag?: string };
type Directive = { steps: Action[]; tag?: string };

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("");
  return "";
}

function sse(chunks: unknown[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

function textResponse(text: string) {
  const base = { id: "chatcmpl-spike", object: "chat.completion.chunk", created: 1, model: "fixture" };
  return sse([
    { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
}

let callCounter = 0;
// A sleep action sleeps only on its first hit, so a host-resumed retry of the same step answers at once.
const slept = new Set<string>();
function toolResponse(name: string, args: string) {
  const base = { id: "chatcmpl-spike", object: "chat.completion.chunk", created: 1, model: "fixture" };
  const id = `call_spike_${++callCounter}`;
  return sse([
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }],
          },
          finish_reason: null,
        },
      ],
    },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]);
}

/**
 * The turn's directive is the last user message containing `#ACTION <json>` after the last
 * assistant message that ended without tool calls. Step k is the number of assistant tool-call
 * messages after it. Requests without tools (title generation) always get plain text.
 */
function plan(messages: any[]): { directive?: Directive; step: number } {
  let lastFinal = -1;
  messages.forEach((message, index) => {
    if (message.role === "assistant" && !(message.tool_calls?.length > 0)) lastFinal = index;
  });
  let directiveIndex = -1;
  let directive: Directive | undefined;
  for (let index = messages.length - 1; index > lastFinal; index--) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const match = contentText(message.content).match(/#ACTION (\{.*\})\s*$/m);
    if (match) {
      directive = JSON.parse(match[1]!);
      directiveIndex = index;
      break;
    }
  }
  if (!directive) return { step: 0 };
  const step = messages
    .slice(directiveIndex + 1)
    .filter((message) => message.role === "assistant" && message.tool_calls?.length > 0).length;
  return { directive, step };
}

function startProvider() {
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      const body: any = await request.json().catch(() => null);
      const messages: any[] = body?.messages ?? [];
      const tools: string[] = (body?.tools ?? []).map((tool: any) => tool.function?.name);
      const { directive, step } = tools.length ? plan(messages) : { step: 0 };
      const action = directive?.steps[step];
      appendFileSync(
        providerLog,
        JSON.stringify({
          t: Date.now(),
          path: url.pathname,
          model: body?.model,
          tag: directive?.tag,
          step,
          action,
          tools,
          last: messages.at(-1) && { role: messages.at(-1).role, text: contentText(messages.at(-1).content).slice(0, 400) },
          body,
        }) + "\n",
      );
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      if (!tools.length) return textResponse("Spike title");
      if (!action) return textResponse(directive ? `done:${directive.tag ?? ""}` : "ack");
      if ("error" in action)
        return new Response(JSON.stringify({ error: { message: "spike provider error", type: "invalid_request_error" } }), {
          status: action.error,
          headers: { "content-type": "application/json" },
        });
      if ("sleep" in action) {
        const key = `${directive?.tag}:${step}`;
        if (!slept.has(key)) {
          slept.add(key);
          await sleep(action.sleep);
        }
        return textResponse(action.text);
      }
      if ("tool" in action) return toolResponse(action.tool, action.rawArgs ?? JSON.stringify(action.args ?? {}));
      return textResponse(action.text);
    },
  });
  return `http://127.0.0.1:${provider.port}/v1`;
}

const directive = (value: Directive) => `#ACTION ${JSON.stringify(value)}`;

// ---------------------------------------------------------------- disposable host
function hostEnv() {
  return {
    PATH: `${join(process.env.HOME ?? "", ".bun/bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    TMPDIR: join(envDir, "tmp"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    FAKE_API_KEY: "fixture",
  };
}

function preparePlugin() {
  mkdirSync(join(pluginDir, "src"), { recursive: true });
  if (!existsSync(join(pluginDir, "node_modules/@opencode/plugin"))) {
    writeFileSync(
      join(pluginDir, "package.json"),
      JSON.stringify({ name: "open-gajae", version: "0.0.0-spike", type: "module", private: true, exports: { ".": "./src/index.ts" } }, null, 2),
    );
    const add = spawnSync("bun", ["add", "@opencode/plugin@2.0.15", "zod"], { cwd: pluginDir, stdio: "inherit" });
    if (add.status !== 0) fail("bun add failed");
  }
  // P5: root index.ts re-exporting ./src/index.ts, loaded as TS source with no build step.
  writeFileSync(join(pluginDir, "index.ts"), 'export { default } from "./src/index.ts"\n');
  copyFileSync(join(import.meta.dir, "spike-plugin.mts"), join(pluginDir, "src/index.ts"));
  writeFileSync(
    join(pluginDir, "spike-config.json"),
    JSON.stringify({ log: pluginLog, tools: run === "A" ? ["zod_new", "json"] : ["zod_old"], skillRoot: join(pluginDir, "skills") }),
  );
}

function prepareHost(baseURL: string) {
  for (const dir of [join(home, ".config/opencode"), join(envDir, "tmp"), join(project, "sub"), join(project, "hostallowed")])
    mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q", project], { env: { ...hostEnv(), GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(project, "sample.ts"), "export const fixture = true;\n");
  writeFileSync(
    join(home, ".config/opencode/opencode.jsonc"),
    JSON.stringify(
      {
        model: "fake/model-a",
        plugins: [pluginDir],
        providers: {
          fake: {
            name: "Fake",
            env: ["FAKE_API_KEY"],
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL },
            models: { "model-a": {}, "model-b": {} },
          },
        },
        agents: {
          "spike-override": {
            model: "fake/model-b",
            system: "SPIKE-HOST-SYSTEM override",
            permissions: [{ action: "edit", resource: "hostallowed/*", effect: "allow" }],
          },
        },
      },
      null,
      2,
    ),
  );
}

let baseUrl = "";
let authHeader = "";
async function startServer() {
  const out = { text: "" };
  server = spawn(host, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: project,
    env: hostEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout!.on("data", (d) => (out.text += d));
  server.stderr!.on("data", (d) => {
    out.text += d;
    appendFileSync(join(runDir, "server.err"), d);
  });
  await waitFor("server listening", () => (/server password (\S+)/.test(out.text) ? true : undefined), 60_000);
  baseUrl = out.text.match(/listening on (http:\/\/\S+)/)![1]!;
  const password = out.text.match(/server password (\S+)/)![1]!;
  authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: authHeader, ...(body === undefined ? {} : { "content-type": "application/json" }) },
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

async function createSession(input: Record<string, unknown> = {}) {
  const response = await api("POST", "/api/session", input);
  const id = response.json?.data?.id;
  if (!id) fail(`session create failed: ${JSON.stringify(response)}`);
  return id as string;
}

async function prompt(sessionID: string, text: string, extra: Record<string, unknown> = {}) {
  return await api("POST", `/api/session/${sessionID}/prompt`, { text, ...extra });
}

const plugin = () => readJsonl(pluginLog);
const providerEntries = () => readJsonl(providerLog);
// Every plugin instance (one per location) receives the whole server event stream; count one.
const events = (sessionID: string, since = 0) =>
  plugin().filter((e) => e.kind === "event" && e.instance === project && e.data?.sessionID === sessionID && e.t >= since);
const terminal = (sessionID: string, since = 0) =>
  events(sessionID, since).find((e) =>
    ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(e.type),
  );
const brief = (e: Entry | undefined) => e && { t: e.t, type: e.type, data: e.data };

async function scenario(name: string, body: () => Promise<unknown>) {
  const started = Date.now();
  try {
    results[name] = await body();
  } catch (error) {
    results[name] = { error: String(error) };
  }
  console.error(`[phase0] ${name} ${Date.now() - started}ms`);
}

// The Code Mode catalog is in the system prompt: "- opencode (N tools)" and "  - tools.opencode.<name>(" entries.
function catalog(request: Entry | undefined) {
  const system = String(request?.body.messages[0]?.content ?? "");
  return {
    namespaceLine: system.match(/^- opencode \([^)]*\)/m)?.[0],
    entries: [...system.matchAll(/^  - tools\.opencode\.(\w+)\(/gm)].map((m) => m[1]),
    proseMentionsSessionMove: system.includes("call `tools.opencode.session_move`"),
    directTools: request?.tools,
  };
}

// ---------------------------------------------------------------- scenarios
async function runA() {
  await scenario("P5-load", async () => {
    const beforeSession = plugin().filter((e) => e.kind === "setup").length;
    const s = await createSession();
    await sleep(2_000);
    const afterCreate = plugin().filter((e) => e.kind === "setup").length;
    await prompt(s, "hello P5");
    const setup = await waitFor("plugin setup", () => plugin().find((e) => e.kind === "setup"));
    const plugins = await api("GET", "/api/plugin");
    return { setupEntriesBeforeFirstSession: beforeSession, setupEntriesAfterCreateBeforePrompt: afterCreate, triggeredBy: s, rootEntry: readFileSync(join(pluginDir, "index.ts"), "utf8"), hasServerEntry: existsSync(join(pluginDir, "server.ts")), setup, plugin: (plugins.json?.data ?? []).find((p: any) => p.id === "open-gajae"), agentTransform: plugin().find((e) => e.kind === "agent-transform"), toolList: plugin().find((e) => e.kind === "tool-list") };
  });

  await scenario("P0-P2-turn", async () => {
    const s = await createSession();
    const since = Date.now();
    const prompted = await prompt(s, "hello P0");
    const end = await waitFor("P0 terminal", () => terminal(s, since));
    const request = providerEntries().find((e) => e.t >= since && e.last?.text?.includes("hello P0") && e.tools.length);
    return {
      sessionID: s,
      prompted: prompted.status,
      providerSawPrompt: !!request,
      model: request?.model,
      events: events(s, since).map(brief),
      envelope: end && { envelopeKeys: end.envelopeKeys, type: end.type, data: end.data },
      terminal: end?.type,
    };
  });

  await scenario("P2-interrupt", async () => {
    const s = await createSession();
    const since = Date.now();
    await prompt(s, directive({ tag: "p2-int", steps: [{ sleep: 20_000, text: "late" }] }));
    await waitFor("p2 provider in flight", () => providerEntries().find((e) => e.t >= since && e.tag === "p2-int"));
    const interrupted = await api("POST", `/api/session/${s}/interrupt?resume=true`);
    const end = await waitFor("p2 interrupt terminal", () => terminal(s, since));
    return { sessionID: s, interruptCall: interrupted, terminal: brief(end), events: events(s, since).map(brief) };
  });

  await scenario("P2-provider-error", async () => {
    const s = await createSession();
    const since = Date.now();
    await prompt(s, directive({ tag: "p2-err", steps: [{ error: 400 }] }));
    const end = await waitFor("p2 error terminal", () => terminal(s, since), 60_000);
    return {
      sessionID: s,
      terminal: brief(end),
      providerCalls: providerEntries().filter((e) => e.t >= since && e.tag === "p2-err").length,
    };
  });

  await scenario("P2-pending-question", async () => {
    const s = await createSession();
    const since = Date.now();
    await prompt(
      s,
      directive({
        tag: "p2-q",
        steps: [
          {
            tool: "question",
            args: { questions: [{ question: "Pick one?", header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] },
          },
        ],
      }),
    );
    let formList: any;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      formList = (await api("GET", `/api/session/${s}/form`)).json;
      if (Array.isArray(formList?.data) && formList.data.length) break;
      await sleep(300);
    }
    await sleep(5_000);
    const whilePending = events(s, since).map(brief);
    const formID = formList?.data?.[0]?.id;
    const cancel = formID ? await api("DELETE", `/api/session/${s}/form/${formID}`) : undefined;
    const end = await waitFor("p2 question terminal", () => terminal(s, since));
    // Second case: answer the question instead of dismissing it.
    const s2 = await createSession();
    const since2 = Date.now();
    await prompt(
      s2,
      directive({
        tag: "p2-q2",
        steps: [
          {
            tool: "question",
            args: { questions: [{ question: "Pick one?", header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] },
          },
        ],
      }),
    );
    let form2: any;
    const deadline2 = Date.now() + 30_000;
    while (Date.now() < deadline2) {
      form2 = (await api("GET", `/api/session/${s2}/form`)).json?.data?.[0];
      if (form2) break;
      await sleep(300);
    }
    await sleep(3_000);
    const whilePending2 = events(s2, since2).map((e) => e.type);
    const reply = form2 ? await api("POST", `/api/session/${s2}/form/${form2.id}/reply`, { answer: { q0: "A" } }) : undefined;
    const end2 = await waitFor("p2 question reply terminal", () => terminal(s2, since2));
    return {
      dismissed: { sessionID: s, form: formList?.data?.[0], eventsWhilePending: whilePending, cancel: cancel?.status, terminal: brief(end) },
      answered: { sessionID: s2, eventsWhilePending: whilePending2, reply: reply?.status, terminal: brief(end2) },
    };
  });

  await scenario("P1-synthetic", async () => {
    const s = await createSession({ agent: "spike-planner" });
    const since = Date.now();
    await prompt(s, "SPIKE_P1 first turn");
    await waitFor("p1 resume:true synthetic", () => plugin().find((e) => e.kind === "p1-synthetic" && e.sessionID === s && (e.resume === true || e.ok === false)), 40_000);
    const waitOver = plugin().find((e) => e.kind === "p1-wait-over" && e.sessionID === s);
    await sleep(4_000);
    const requests = providerEntries().filter((e) => e.t >= since && e.tools.length);
    const withFalse = requests.filter((e) => JSON.stringify(e.body.messages).includes("P1-RESUME-FALSE-TEXT"));
    const withTrue = requests.filter((e) => JSON.stringify(e.body.messages).includes("P1-RESUME-TRUE-TEXT"));
    const resumed = withTrue[0];
    return {
      sessionID: s,
      synthetic: plugin().filter((e) => e.kind === "p1-synthetic" && e.sessionID === s),
      requestsWithFalseBeforeWaitOver: withFalse.filter((e) => waitOver && e.t < waitOver.t).length,
      requestsWithTrue: withTrue.length,
      resumedRequest: resumed && {
        model: resumed.model,
        systemHasPlannerSystem: JSON.stringify(resumed.body.messages[0]).includes("SPIKE-PLUGIN-SYSTEM planner"),
        messages: resumed.body.messages.slice(1).map((m: any) => [m.role, contentText(m.content).slice(0, 80)]),
      },
      promptHookForSynthetic: plugin().filter((e) => e.kind === "prompt-hook" && String(e.text).includes("P1-RESUME")).length,
      events: events(s, since).map(brief),
    };
  });

  await scenario("P3-P8-guard", async () => {
    const s = await createSession();
    const since = Date.now();
    const other = ".open-gajae/_session-OTHER/plans";
    await prompt(
      s,
      directive({
        tag: "p3",
        steps: [
          { tool: "write", args: { path: `${other}/BLOCKME-mode-i.md`, content: "x" } },
          { tool: "write", args: { path: `${other}/BLOCKME-mode-ii.md`, content: "x" } },
          { tool: "write", rawArgs: JSON.stringify(JSON.stringify({ path: `${other}/BLOCKME-string-mode-i.md`, content: "x" })) },
        ],
      }),
    );
    const end = await waitFor("p3 terminal", () => terminal(s, since), 60_000);
    const requests = providerEntries().filter((e) => e.t >= since && e.tag === "p3");
    const toolMessages = requests.at(-1)?.body.messages.filter((m: any) => m.role === "tool").map((m: any) => contentText(m.content));
    return {
      sessionID: s,
      terminal: brief(end),
      before: plugin().filter((e) => e.kind === "execute.before" && e.sessionID === s).map((e) => ({ tool: e.tool, inputType: e.inputType, input: e.input })),
      blocks: plugin().filter((e) => e.kind === "guard-block" && e.t >= since),
      after: plugin().filter((e) => e.kind === "execute.after" && e.sessionID === s),
      rewrites: plugin().filter((e) => e.kind === "rewrite" && e.t >= since),
      modelVisibleToolResults: toolMessages,
      toolCalledEvents: plugin().filter((e) => e.kind === "event-other" && e.type === "session.tool.called" && e.sessionID === s && e.instance === project).map((e) => e.data),
      filesWritten: ["BLOCKME-mode-i.md", "BLOCKME-mode-ii.md", "BLOCKME-string-mode-i.md"].map((f) => existsSync(join(project, other, f))),
    };
  });

  await scenario("P6c-P8-planner", async () => {
    const s = await createSession({ agent: "spike-planner" });
    const since = Date.now();
    await prompt(
      s,
      directive({
        tag: "p6c",
        steps: [
          { tool: "write", args: { path: ".open-gajae/_session-X/plans/ok.md", content: "ok" } },
          { tool: "write", args: { path: join(project, ".open-gajae/_session-X/plans/abs-ok.md"), content: "ok" } },
          { tool: "write", args: { path: "outside/PERM-mode-i.md", content: "x" } },
          { tool: "write", args: { path: "outside/PERM-mode-ii.md", content: "x" } },
        ],
      }),
    );
    const end = await waitFor("p6c terminal", () => terminal(s, since), 60_000);
    const requests = providerEntries().filter((e) => e.t >= since && e.tag === "p6c");
    const last = requests.at(-1);
    return {
      sessionID: s,
      terminal: brief(end),
      evaluate: plugin().filter((e) => e.kind === "permission-evaluate" && e.sessionID === s),
      after: plugin().filter((e) => e.kind === "execute.after" && e.sessionID === s),
      rewrites: plugin().filter((e) => e.kind === "rewrite" && e.t >= since),
      modelVisibleToolResults: last?.body.messages.filter((m: any) => m.role === "tool").map((m: any) => contentText(m.content)),
      written: { ok: existsSync(join(project, ".open-gajae/_session-X/plans/ok.md")), absOk: existsSync(join(project, ".open-gajae/_session-X/plans/abs-ok.md")), outside: existsSync(join(project, "outside")) },
      // P6(d): the Code Mode catalog lives in the system prompt.
      catalog: catalog(last),
    };
  });

  await scenario("P6c-subdir", async () => {
    const s = await createSession({ agent: "spike-planner", location: { directory: join(project, "sub") } });
    const since = Date.now();
    await prompt(
      s,
      directive({ tag: "p6c-sub", steps: [{ tool: "write", args: { path: "../.open-gajae/_session-Y/plans/sub-ok.md", content: "ok" } }] }),
    );
    const end = await waitFor("p6c-sub terminal", () => terminal(s, since), 60_000);
    return {
      sessionID: s,
      terminal: brief(end),
      setups: plugin().filter((e) => e.kind === "setup").map((e) => ({ location: e.location, plannerPrefix: e.plannerPrefix })),
      evaluate: plugin().filter((e) => e.kind === "permission-evaluate" && e.sessionID === s),
      after: plugin().filter((e) => e.kind === "execute.after" && e.sessionID === s),
      written: existsSync(join(project, ".open-gajae/_session-Y/plans/sub-ok.md")),
    };
  });

  await scenario("P6d-build-catalog", async () => {
    const request = providerEntries().find((e) => e.tag === undefined && e.last?.text?.includes("hello P0") && e.tools.length);
    return catalog(request);
  });

  await scenario("P6b-override", async () => {
    const agent = await api("GET", "/api/agent/spike-override");
    const planner = await api("GET", "/api/agent/spike-planner");
    const s = await createSession();
    const since = Date.now();
    const child = directive({ tag: "p6b-child", steps: [{ tool: "write", args: { path: "hostallowed/x.md", content: "x" } }] });
    await prompt(
      s,
      directive({ tag: "p6b", steps: [{ tool: "subagent", args: { agent: "spike-override", description: "override probe", prompt: child } }] }),
    );
    const end = await waitFor("p6b terminal", () => terminal(s, since), 60_000);
    const childRequest = providerEntries().find((e) => e.t >= since && e.tag === "p6b-child");
    return {
      agent: agent.json?.data ?? agent.json,
      planner: planner.json?.data ?? planner.json,
      terminal: brief(end),
      childModel: childRequest?.model,
      childSystemHost: String(childRequest?.body.messages[0]?.content ?? "").includes("SPIKE-HOST-SYSTEM"),
      childSystemPlugin: String(childRequest?.body.messages[0]?.content ?? "").includes("SPIKE-PLUGIN-SYSTEM override"),
      childWrite: plugin().filter((e) => e.kind === "execute.after" && e.agent === "spike-override" && e.t >= since),
      hostAllowedWritten: existsSync(join(project, "hostallowed/x.md")),
      childPromptHooks: plugin().filter((e) => e.kind === "prompt-hook" && e.t >= since && e.sessionID !== s),
    };
  });

  await scenario("P7-prompt-hook", async () => {
    const skills = await api("GET", "/api/skill");
    const s = await createSession();
    const out: Record<string, unknown> = { sessionID: s, skills: (skills.json?.data ?? []).map((k: any) => k.id) };
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["notice", "SPIKE_NOTICE please plan", {}],
      ["mention-ralplan", "@ralplan plan this", { skills: [{ id: "ralplan", mention: { start: 0, end: 8, text: "@ralplan" } }] }],
      ["mention-deep-interview", "@deep-interview start", { skills: [{ id: "deep-interview", mention: { start: 0, end: 15, text: "@deep-interview" } }] }],
      ["plain-at-text", "@ralplan typed without attachment", {}],
      ["append", "SPIKE_APPEND check", {}],
    ];
    for (const [name, text, extra] of cases) {
      const since = Date.now();
      await prompt(s, text, extra);
      await waitFor(`p7 ${name} terminal`, () => terminal(s, since), 30_000);
      const hook = plugin().find((e) => e.kind === "prompt-hook" && e.sessionID === s && e.t >= since);
      const request = providerEntries().find((e) => e.t >= since && e.tools.length);
      out[name] = {
        hook: hook && { text: hook.text, skills: hook.skills, session: hook.session },
        synthetic: plugin().find((e) => e.kind === "prompt-hook-synthetic" && e.t >= since),
        requestTail: request?.body.messages.slice(-4).map((m: any) => [m.role, contentText(m.content).slice(0, 160)]),
      };
    }
    return out;
  });

  await scenario("P9-background", async () => {
    const s = await createSession();
    const since = Date.now();
    const child = directive({ tag: "p9-child", steps: [{ sleep: 8_000, text: "child-done" }] });
    await prompt(
      s,
      directive({ tag: "p9", steps: [{ tool: "subagent", args: { agent: "explore", description: "bg probe", prompt: child, background: true } }] }),
    );
    await waitFor("p9 second parent succeeded", () => {
      const done = events(s, since).filter((e) => e.type === "session.execution.succeeded");
      return done.length >= 2 ? true : undefined;
    }, 60_000).catch(() => undefined);
    await sleep(1_000);
    const all = plugin().filter((e) => e.kind === "event" && e.instance === project && e.t >= since);
    return {
      parentID: s,
      instancesSeeingParentSucceeded: [...new Set(plugin().filter((e) => e.kind === "event" && e.type === "session.execution.succeeded" && e.data?.sessionID === s).map((e) => e.instance))],
      promptHookForSubagentSynthetic: plugin().filter((e) => e.kind === "prompt-hook" && e.t >= since && String(e.text).includes("<subagent")).length,
      timeline: all.map((e) => ({ t: e.t - since, type: e.type, sessionID: e.data?.sessionID, parentID: e.session?.parentID, agent: e.session?.agent, reason: e.data?.reason })),
      parentRequests: providerEntries().filter((e) => e.t >= since && e.tag !== "p9-child" && e.tools.length).map((e) => ({ t: e.t - since, tag: e.tag, step: e.step, last: e.last })),
    };
  });

  await scenario("Q9-esc-during-background", async () => {
    const s = await createSession();
    const since = Date.now();
    const child = directive({ tag: "q9-child", steps: [{ sleep: 10_000, text: "child-done" }] });
    await prompt(
      s,
      directive({
        tag: "q9",
        steps: [
          { tool: "subagent", args: { agent: "explore", description: "bg probe", prompt: child, background: true } },
          { sleep: 30_000, text: "parent-late" },
        ],
      }),
    );
    await waitFor("q9 parent step 1 in flight", () => providerEntries().find((e) => e.t >= since && e.tag === "q9" && e.step === 1), 30_000);
    const interrupted = await api("POST", `/api/session/${s}/interrupt?resume=true`);
    const tInterrupt = Date.now() - since;
    await waitFor("q9 parent resumed and settled", () => {
      const parent = events(s, since).map((e) => e.type);
      return parent.filter((t) => t === "session.execution.started").length >= 2 && parent.at(-1) !== "session.execution.started" ? true : undefined;
    }, 40_000).catch(() => undefined);
    await sleep(1_000);
    const all = plugin().filter((e) => e.kind === "event" && e.instance === project && e.t >= since);
    return {
      parentID: s,
      interruptAt: tInterrupt,
      interruptCall: interrupted,
      timeline: all.map((e) => ({ t: e.t - since, type: e.type, sessionID: e.data?.sessionID, parentID: e.session?.parentID, reason: e.data?.reason })),
      parentRequests: providerEntries().filter((e) => e.t >= since && e.tag !== "q9-child" && e.tools.length).map((e) => ({ t: e.t - since, tag: e.tag, step: e.step, last: e.last })),
    };
  });

  await scenario("Q9-esc-idle-parent", async () => {
    const s = await createSession();
    const since = Date.now();
    const child = directive({ tag: "q9b-child", steps: [{ sleep: 8_000, text: "child-done" }] });
    await prompt(
      s,
      directive({ tag: "q9b", steps: [{ tool: "subagent", args: { agent: "explore", description: "bg probe", prompt: child, background: true } }] }),
    );
    await waitFor("q9b parent succeeded", () => events(s, since).find((e) => e.type === "session.execution.succeeded"), 30_000);
    const interrupted = await api("POST", `/api/session/${s}/interrupt?resume=true`);
    const tInterrupt = Date.now() - since;
    await sleep(15_000);
    const all = plugin().filter((e) => e.kind === "event" && e.instance === project && e.t >= since);
    return {
      parentID: s,
      interruptAt: tInterrupt,
      interruptCall: interrupted,
      timeline: all.map((e) => ({ t: e.t - since, type: e.type, sessionID: e.data?.sessionID, parentID: e.session?.parentID, reason: e.data?.reason })),
    };
  });

  await scenario("P4-tools", async () => {
    const s = await createSession();
    const since = Date.now();
    await prompt(
      s,
      directive({
        tag: "p4",
        steps: [
          { tool: "spike_zod_new", args: { value: "a" } },
          { tool: "spike_json", args: { value: "b" } },
          { tool: "spike_json", args: { value: 5 } },
          { tool: "spike_zod_new", args: { value: 5 } },
        ],
      }),
    );
    const end = await waitFor("p4 terminal", () => terminal(s, since), 60_000);
    const requests = providerEntries().filter((e) => e.t >= since && e.tag === "p4");
    const first = requests[0];
    return {
      terminal: brief(end),
      definitions: first?.body.tools.filter((t: any) => t.function.name.startsWith("spike")).map((t: any) => t.function),
      toolResults: requests.at(-1)?.body.messages.filter((m: any) => m.role === "tool").map((m: any) => contentText(m.content)),
    };
  });
}

async function runB() {
  await scenario("P4-zod-old", async () => {
    // Plugin instances load lazily on the first prompt of a location, so no setup wait here.
    const s = await createSession();
    const since = Date.now();
    await prompt(s, directive({ tag: "p4b", steps: [{ tool: "spike_zod_old", args: { value: "c" } }] }));
    const end = await waitFor("p4b terminal", () => terminal(s, since), 60_000).catch((e) => ({ timeout: String(e) }));
    const requests = providerEntries().filter((e) => e.t >= since && e.tag === "p4b");
    return {
      toolList: plugin().find((e) => e.kind === "tool-list"),
      terminal: (end as Entry).type ? brief(end as Entry) : end,
      providerCalls: requests.length,
      definition: requests[0]?.body.tools.find((t: any) => t.function.name === "spike_zod_old")?.function,
      toolResults: requests.at(-1)?.body.messages.filter((m: any) => m.role === "tool").map((m: any) => contentText(m.content)),
      serverErrTail: existsSync(join(runDir, "server.err")) ? readFileSync(join(runDir, "server.err"), "utf8").split("\n").filter((l) => /spike|zod|JSON Schema|invalid/i.test(l)).slice(-10) : [],
    };
  });
}

async function main() {
  mkdirSync(runDir, { recursive: true });
  preparePlugin();
  const providerURL = startProvider();
  prepareHost(providerURL);
  const paths = spawnSync(host, ["debug", "paths"], { cwd: project, env: hostEnv(), encoding: "utf8" });
  results.paths = paths.stdout.trim().split("\n");
  results.version = spawnSync(host, ["--version"], { env: hostEnv(), encoding: "utf8" }).stdout.trim();
  await startServer();
  results.server = baseUrl;
  if (run === "A") await runA();
  else await runB();
}

try {
  await main();
} catch (error) {
  results.fatal = String(error);
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((r) => server!.once("close", r)), sleep(5_000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  provider?.stop(true);
  writeFileSync(join(runDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(join(runDir, "results.json"));
}
