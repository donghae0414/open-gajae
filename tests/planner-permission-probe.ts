// Planner write and delegation scope, against the installed OpenCode server and
// the real plugin (`dist/index.js`), with a local deterministic provider.
//
// Five steps, all driven through `task(open-gajae-planner)` from the primary:
//   1. write into the ROOT session's own `plans/`            → succeeds
//   2. write into another session's `plans/`                 → the D2c hook refuses
//   3. write outside the plugin's session artifacts          → host permission denies
//   4. `task(open-gajae-explore)`                            → completes (depth floor + task allow)
//   5. `task(open-gajae-critic)`                             → host permission denies
//
// Run with `bun ./tests/planner-permission-probe.ts` after `bun run build`.
// It exits non-zero on the first step that does not behave as stated.

import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sessionDirName } from "../src/state";

const host =
  process.env.OPEN_GAJAE_TEST_HOST ??
  join(process.env.HOME ?? "", ".opencode/bin/opencode");
const packageRoot = resolve(import.meta.dir, "..");
const base = await realpath(
  await mkdtemp(join(tmpdir(), "open-gajae-planner-permission-")),
);
const root = join(base, "project");
const home = join(base, "home");
const hostLogs = { stdout: "", stderr: "" };
/** A session folder that exists in no lineage of this run. */
const FOREIGN_FOLDER = "_session-20260101-000000-ses_other";
let child: ChildProcess | undefined;
let provider: ReturnType<typeof Bun.serve> | undefined;

type Step = {
  step: string;
  expected: string;
  observed: string;
  passed: boolean;
};
const steps: Step[] = [];

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(
  step: string,
  expected: string,
  observed: string,
  passed: boolean,
) {
  steps.push({ step, expected, observed, passed });
}

async function delay(milliseconds: number) {
  await new Promise<void>((done) => setTimeout(done, milliseconds));
}

async function waitFor<T>(
  name: string,
  action: () => Promise<T | undefined>,
  timeout = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await action();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  fail(`${name} timed out${lastError ? `: ${String(lastError)}` : ""}`);
}

function sse(chunks: unknown[]) {
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    },
  );
}

function chunk() {
  return {
    id: "chatcmpl-open-gajae-planner-probe",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fixture-model",
  };
}

function textResponse(text: string) {
  return sse([
    {
      ...chunk(),
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    },
    { ...chunk(), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ]);
}

function toolResponse(name: string, id: string, args: Record<string, unknown>) {
  return sse([
    {
      ...chunk(),
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...chunk(),
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ]);
}

async function stopHost() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([once(child, "close"), delay(5_000)]);
}

async function main() {
  await mkdir(root);
  await mkdir(home);
  const git = Bun.spawnSync(["git", "init", "--quiet", root], {
    env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (git.exitCode !== 0)
    fail(`Fixture git init failed: ${git.stderr.toString()}`);

  // Each role is recognized by the heading of its own shipped prompt, read from
  // the repository so a prompt rewrite cannot silently misroute this fixture.
  const heading = async (name: string) => {
    const text = await readFile(join(packageRoot, "prompts", name), "utf8");
    const line = text.split("\n")[0]?.trim();
    if (!line || !line.startsWith("# "))
      fail(`prompts/${name} does not begin with a heading`);
    return line;
  };
  const PLANNER = await heading("open-gajae-planner.md");
  const EXPLORE = await heading("open-gajae-explore.md");
  const CRITIC = await heading("open-gajae-critic.md");
  if (new Set([PLANNER, EXPLORE, CRITIC]).size !== 3)
    fail("Role prompt headings are not distinct; the fixture cannot route");

  // Filled in once the root session exists; the planner writes into its folder.
  let ownPlan: string | undefined;
  const foreignPlan = join(
    root,
    ".open-gajae",
    FOREIGN_FOLDER,
    "plans/probe.md",
  );
  const outsideFile = join(root, "src/probe.ts");
  const stage: Record<string, number> = {
    primary: 0,
    planner: 0,
    explore: 0,
    critic: 0,
    other: 0,
  };

  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/chat/completions"))
        return new Response("fixture provider route not found", {
          status: 404,
        });
      const payload = (await request.json()) as {
        messages?: Array<{ role: string; content: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const system = (payload.messages ?? [])
        .filter((message) => message.role === "system")
        .map((message) => String(message.content))
        .join("\n");
      const role = system.includes(PLANNER)
        ? "planner"
        : system.includes(EXPLORE)
          ? "explore"
          : system.includes(CRITIC)
            ? "critic"
            : "primary";
      // Title generation calls the model with no tools; answer without
      // consuming a step.
      if ((payload.tools ?? []).length === 0) return textResponse("probe title");
      const turn = stage[role]!++;

      if (role === "primary") {
        if (turn === 0)
          return toolResponse("task", "call_primary_task", {
            description: "planner permission probe",
            prompt: "Run the planner permission probe.",
            subagent_type: "open-gajae-planner",
          });
        return textResponse("primary done");
      }
      if (role === "planner") {
        if (turn === 0)
          return toolResponse("write", "call_planner_own_plan", {
            filePath: ownPlan!,
            content: "# own-session plan\n",
          });
        if (turn === 1)
          return toolResponse("write", "call_planner_foreign_plan", {
            filePath: foreignPlan,
            content: "# foreign-session plan\n",
          });
        if (turn === 2)
          return toolResponse("write", "call_planner_outside", {
            filePath: outsideFile,
            content: "export const probe = 1;\n",
          });
        if (turn === 3)
          return toolResponse("task", "call_planner_explore", {
            description: "explore probe",
            prompt: "Report one repository fact for the planner probe.",
            subagent_type: "open-gajae-explore",
          });
        if (turn === 4)
          return toolResponse("task", "call_planner_critic", {
            description: "critic probe",
            prompt: "Review the planner probe plan.",
            subagent_type: "open-gajae-critic",
          });
        return textResponse("planner done");
      }
      return textResponse(`${role} done`);
    },
  });

  const environment = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    // No `subagent_depth` here on purpose: step 4 proves the plugin's own floor.
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      plugin: [pathToFileURL(join(packageRoot, "dist/index.js")).href],
      permission: { "*": "allow" },
      model: "fixture/fixture-model",
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local deterministic fixture provider",
          options: {
            baseURL: `http://127.0.0.1:${provider.port}/v1`,
            apiKey: "fixture-no-network-key",
            timeout: 15_000,
            headerTimeout: 15_000,
            chunkTimeout: 15_000,
          },
          models: {
            "fixture-model": {
              name: "Fixture model",
              tool_call: true,
              limit: { context: 32_768, output: 4_096 },
            },
          },
        },
      },
      agent: { "open-gajae": { model: "fixture/fixture-model" } },
    }),
  };

  child = spawn(host, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (data) => {
    hostLogs.stdout += data;
  });
  child.stderr!.on("data", (data) => {
    hostLogs.stderr += data;
  });
  const server = await waitFor("OpenCode serve", async () => {
    const match = hostLogs.stdout.match(
      /opencode server listening on (http:\/\/[^\s]+)/,
    );
    if (match?.[1]) return match[1];
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      fail(
        `OpenCode serve exited (${child.exitCode}): ${hostLogs.stderr || hostLogs.stdout}`,
      );
    return undefined;
  });

  const headers = {
    "content-type": "application/json",
    "x-opencode-directory": root,
  };
  async function api(path: string, init: RequestInit = {}) {
    const response = await fetch(`${server}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
    });
    const body = await response.text();
    if (!response.ok)
      fail(
        `${init.method ?? "GET"} ${path} failed (${response.status}): ${body}`,
      );
    return body.length ? JSON.parse(body) : undefined;
  }

  const session = await api("/session", { method: "POST", body: "{}" });
  const created =
    isRecord(session) && isRecord(session.time)
      ? session.time.created
      : undefined;
  if (
    !isRecord(session) ||
    typeof session.id !== "string" ||
    typeof created !== "number"
  )
    fail(
      `Session create did not return id and time.created: ${JSON.stringify(session)}`,
    );
  const sessionID = session.id;
  // The same folder name the plugin derives, computed the same way from the
  // host's creation time (`src/state.ts` `sessionDirName`).
  const sessionFolder = sessionDirName(created, sessionID);
  ownPlan = join(root, ".open-gajae", sessionFolder, "plans/probe.md");

  await api(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      agent: "open-gajae",
      model: { providerID: "fixture", modelID: "fixture-model" },
      parts: [{ type: "text", text: "Run the planner permission probe." }],
    }),
  });
  await waitFor(
    "planner probe turns",
    async () => (stage.planner! >= 6 && stage.primary! >= 2 ? true : undefined),
    90_000,
  );
  await waitFor(
    "session idle",
    async () => {
      const status = await api("/session/status");
      if (
        isRecord(status) &&
        isRecord(status[sessionID]) &&
        status[sessionID].type !== "idle"
      )
        return undefined;
      return true;
    },
    30_000,
  );
  // The subagent's own tool parts land slightly after its turn completes.
  await delay(1_500);

  type ToolPart = {
    callID?: string;
    tool?: string;
    state?: Record<string, unknown>;
  };
  const toolParts = new Map<string, ToolPart>();
  async function collect(id: string) {
    const messages = (await api(
      `/session/${encodeURIComponent(id)}/message`,
    )) as Array<{ parts?: Array<Record<string, unknown>> }>;
    for (const message of messages ?? [])
      for (const part of message.parts ?? []) {
        if (part.type !== "tool") continue;
        const callID = typeof part.callID === "string" ? part.callID : undefined;
        if (callID) toolParts.set(callID, part as ToolPart);
      }
    const children = (await api(
      `/session/${encodeURIComponent(id)}/children`,
    )) as Array<{ id?: string }>;
    for (const each of children ?? [])
      if (typeof each.id === "string") await collect(each.id);
  }
  await collect(sessionID);

  function describe(callID: string) {
    const part = toolParts.get(callID);
    if (!part) return { status: "missing", text: "" };
    const state = part.state ?? {};
    const text = [state.error, state.output, state.title]
      .map((value) => (typeof value === "string" ? value : ""))
      .join(" | ");
    return { status: String(state.status ?? "unknown"), text };
  }
  const exists = async (path: string) =>
    readFile(path, "utf8").then(
      () => true,
      () => false,
    );

  const own = describe("call_planner_own_plan");
  record(
    "1. write into the root session's own plans/",
    "completed, file on disk",
    `${own.status}; file ${(await exists(ownPlan)) ? "present" : "absent"}`,
    own.status === "completed" && (await exists(ownPlan)),
  );

  const foreign = describe("call_planner_foreign_plan");
  record(
    "2. write into another session's plans/",
    'error naming "another session", nothing written',
    `${foreign.status}: ${foreign.text.slice(0, 200)}; file ${(await exists(foreignPlan)) ? "present" : "absent"}`,
    foreign.status === "error" &&
      foreign.text.includes("another session") &&
      !(await exists(foreignPlan)),
  );

  const outside = describe("call_planner_outside");
  record(
    "3. write outside the session artifacts",
    "permission denial, nothing written",
    `${outside.status}: ${outside.text.slice(0, 200)}; file ${(await exists(outsideFile)) ? "present" : "absent"}`,
    outside.status === "error" &&
      /denied|permission|not allow|prevent/i.test(outside.text) &&
      !(await exists(outsideFile)),
  );

  const explore = describe("call_planner_explore");
  record(
    "4. task(open-gajae-explore) from the planner",
    "completed, proving subagent_depth 2 and the task allow rule",
    `${explore.status}: ${explore.text.slice(0, 200)}`,
    explore.status === "completed" && stage.explore! >= 1,
  );

  const critic = describe("call_planner_critic");
  record(
    "5. task(open-gajae-critic) from the planner",
    "permission denial, the critic never runs",
    `${critic.status}: ${critic.text.slice(0, 200)}; critic turns ${stage.critic}`,
    critic.status === "error" &&
      /denied|permission|not allow|prevent/i.test(critic.text) &&
      stage.critic === 0,
  );

  const passed = steps.every((step) => step.passed);
  console.log(
    JSON.stringify(
      {
        kind: "planner-permission-probe-report",
        status: passed ? "passed" : "failed",
        runtime: {
          host,
          plugin: join(packageRoot, "dist/index.js"),
          provider: "@ai-sdk/openai-compatible",
          externalNetwork: false,
          subagentDepthInFixtureConfig: null,
        },
        session: { id: sessionID, folder: sessionFolder, ownPlan },
        steps,
        providerTurns: stage,
        limitations: [
          "The deterministic provider validates permission and hook behavior only; it does not measure model judgment.",
          "Step 2 exercises the plugin's `tool.execute.before` guard; steps 3 and 5 exercise host permission rules.",
        ],
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(
    JSON.stringify(
      {
        kind: "planner-permission-probe-report",
        status: "failed",
        error: String(error),
        steps,
        hostStderrTail: hostLogs.stderr.slice(-3000),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await stopHost();
  provider?.stop(true);
  await rm(base, { recursive: true, force: true });
}
