import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// This is an integration fixture: it drives the installed OpenCode server and a local
// OpenAI-compatible provider. It does not emulate OpenCode tools or plugin contexts.
const host =
  process.env.OPEN_GAJAE_TEST_HOST ??
  join(process.env.HOME ?? "", ".opencode/bin/opencode");
const packageRoot = resolve(import.meta.dir, "..");
const base = await realpath(
  await mkdtemp(join(tmpdir(), "open-gajae-host-session-")),
);
const root = join(base, "project");
const home = join(base, "home");
const events: Array<Record<string, unknown>> = [];
const providerRequests: Array<Record<string, unknown>> = [];
const hostLogs: { stdout: string; stderr: string } = { stdout: "", stderr: "" };
let child: ChildProcess | undefined;
let provider: ReturnType<typeof Bun.serve> | undefined;
let failed = false;

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeSessionID(sessionID: string) {
  return Buffer.from(sessionID, "utf8").toString("hex");
}

async function delay(milliseconds: number) {
  await new Promise<void>((resolveDelay) =>
    setTimeout(resolveDelay, milliseconds),
  );
}

async function waitFor<T>(
  name: string,
  action: () => Promise<T | undefined>,
  timeout = 20_000,
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

async function runVersion(environment: NodeJS.ProcessEnv) {
  return await new Promise<string>((resolveVersion, reject) => {
    const process = spawn(host, ["--version"], {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errorOutput = "";
    const timer = setTimeout(() => process.kill("SIGKILL"), 15_000);
    process.stdout.on("data", (data) => {
      output += data;
    });
    process.stderr.on("data", (data) => {
      errorOutput += data;
    });
    process.on("error", reject);
    process.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        reject(
          new Error(`OpenCode --version failed (${code}): ${errorOutput}`),
        );
      else resolveVersion(output.trim());
    });
  });
}

async function startHost(environment: NodeJS.ProcessEnv) {
  child = spawn(host, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // `pipe` above guarantees these streams; Node's generic ChildProcess type
  // still marks them nullable because it also represents inherited stdio.
  child.stdout!.on("data", (data) => {
    hostLogs.stdout += data;
  });
  child.stderr!.on("data", (data) => {
    hostLogs.stderr += data;
  });
  return await waitFor("OpenCode serve", async () => {
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
}

async function stopHost() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGKILL");
  await Promise.race([once(child, "close"), delay(5_000)]);
}

function textResponse(text: string) {
  const chunk = {
    id: "chatcmpl-open-gajae-fixture",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fixture-model",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: text },
        finish_reason: null,
      },
    ],
  };
  const done = {
    ...chunk,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return new Response(
    `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    },
  );
}

function toolResponse(name: string, id: string, args: Record<string, unknown>) {
  // The installed AI SDK provider requests streaming chat completions. Emit the
  // native OpenAI SSE tool-call shape rather than shortcutting a host tool result.
  events.push({ kind: "provider-tool-call", name, id, args });
  const created = Math.floor(Date.now() / 1000);
  const call = {
    id: "chatcmpl-open-gajae-fixture",
    object: "chat.completion.chunk",
    created,
    model: "fixture-model",
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
  };
  const done = {
    id: "chatcmpl-open-gajae-fixture",
    object: "chat.completion.chunk",
    created,
    model: "fixture-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  };
  return new Response(
    `data: ${JSON.stringify(call)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    },
  );
}

function findStatePaths(
  value: unknown,
): { statePath: string; specsDir: string } | undefined {
  if (isRecord(value)) {
    if (
      typeof value.statePath === "string" &&
      typeof value.specsDir === "string"
    )
      return { statePath: value.statePath, specsDir: value.specsDir };
    for (const nested of Object.values(value)) {
      const result = findStatePaths(nested);
      if (result) return result;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const nested of value) {
      const result = findStatePaths(nested);
      if (result) return result;
    }
    return undefined;
  }
  if (typeof value === "string") {
    try {
      return findStatePaths(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function findStatePathsForSession(value: unknown, sessionID: string) {
  const encodedID = encodeSessionID(sessionID);
  const expected = `_session-${encodedID}`;
  const visit = (
    candidate: unknown,
  ): { statePath: string; specsDir: string } | undefined => {
    if (isRecord(candidate)) {
      if (
        typeof candidate.statePath === "string" &&
        typeof candidate.specsDir === "string" &&
        candidate.statePath.includes(expected) &&
        candidate.specsDir.includes(expected)
      )
        return { statePath: candidate.statePath, specsDir: candidate.specsDir };
      for (const nested of Object.values(candidate)) {
        const result = visit(nested);
        if (result) return result;
      }
      return undefined;
    }
    if (Array.isArray(candidate)) {
      for (const nested of candidate) {
        const result = visit(nested);
        if (result) return result;
      }
      return undefined;
    }
    if (typeof candidate === "string") {
      try {
        return visit(JSON.parse(candidate));
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
  return visit(value);
}

function toolNames(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.tools)) return [];
  return payload.tools.flatMap((tool) => {
    if (
      !isRecord(tool) ||
      !isRecord(tool.function) ||
      typeof tool.function.name !== "string"
    )
      return [];
    return [tool.function.name];
  });
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
  await writeFile(join(root, "sample.ts"), "export const fixture = true;\n");

  let stage:
    | "initial"
    | "question"
    | "write"
    | "complete"
    | "done"
    | "b-read-absolute"
    | "b-read-relative"
    | "b-state-write"
    | "b-write"
    | "b-state-clear"
    | "b-done"
    | "b-denied-state-write"
    | "b-denied-done"
    | "b-denied-write"
    | "b-denied-write-done"
    | "missing-read"
    | "missing-done"
    | "symlink-read"
    | "symlink-done" = "initial";
  let statePaths: { statePath: string; specsDir: string } | undefined;
  let secondStatePaths: { statePath: string; specsDir: string } | undefined;
  let expectedDocument: string | undefined;
  let secondDocument: string | undefined;
  let firstAbsoluteDocument: string | undefined;
  let firstRelativeDocument: string | undefined;
  let missingPath: string | undefined;
  let symlinkPath: string | undefined;
  let secondSessionIDForProvider: string | undefined;
  provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/chat/completions"))
        return new Response("fixture provider route not found", {
          status: 404,
        });
      return request
        .json()
        .then((payload: unknown) => {
          providerRequests.push({ path: url.pathname, payload });
          statePaths ??= findStatePaths(payload);
          if (stage === "b-write" && secondSessionIDForProvider)
            secondStatePaths ??= findStatePathsForSession(
              payload,
              secondSessionIDForProvider,
            );
          const available = toolNames(payload);
          events.push({
            kind: "provider-request",
            stage,
            availableTools: available,
          });
          if (stage === "initial") {
            if (!available.includes("state_write"))
              return new Response("state_write was not exposed to provider", {
                status: 400,
              });
            stage = "question";
            return toolResponse("state_write", "call_fixture_state_initial", {
              mode: "deep-interview",
              state: {
                current_phase: "awaiting_human_reply",
                task_description: "native host session fixture",
                approval: "A-only approval",
                checklist: ["[ ] A-only checkbox"],
              },
            });
          }
          if (stage === "question") {
            if (!statePaths)
              return new Response(
                "state_write result did not contain current-session paths",
                { status: 400 },
              );
            if (!available.includes("question"))
              return new Response(
                "native question was not exposed to provider",
                { status: 400 },
              );
            stage = "write";
            return toolResponse("question", "call_fixture_question", {
              questions: [
                {
                  header: "Fixture decision",
                  question:
                    "Which deterministic answer should the host deliver?",
                  options: [
                    {
                      label: "Fixture answer",
                      description: "Exercise the real question reply endpoint.",
                    },
                  ],
                },
              ],
            });
          }
          if (stage === "write") {
            if (!statePaths)
              return new Response(
                "missing captured state paths before native Write",
                { status: 400 },
              );
            if (!available.includes("write"))
              return new Response("native Write was not exposed to provider", {
                status: 400,
              });
            expectedDocument = join(
              statePaths.specsDir,
              "deep-interview-fixture.md",
            );
            stage = "complete";
            return toolResponse("write", "call_fixture_write", {
              filePath: expectedDocument,
              content:
                "# Native host-session fixture\n\nAnswer: Fixture answer\n\n- [ ] A-only checkbox\n\nApproval: A-only approval\n",
            });
          }
          if (stage === "complete") {
            if (!available.includes("state_write"))
              return new Response(
                "final state_write was not exposed to provider",
                { status: 400 },
              );
            stage = "done";
            return toolResponse("state_write", "call_fixture_state_complete", {
              mode: "deep-interview",
              state: {
                current_phase: "completed",
                task_description: "native host session fixture",
                answer: "Fixture answer",
                approval: "A-only approval",
                checklist: ["[ ] A-only checkbox"],
              },
            });
          }
          if (stage === "b-read-absolute") {
            if (!firstAbsoluteDocument || !available.includes("read"))
              return new Response("B absolute native Read was not available", {
                status: 400,
              });
            stage = "b-read-relative";
            return toolResponse("read", "call_fixture_b_read_absolute", {
              filePath: firstAbsoluteDocument,
            });
          }
          if (stage === "b-read-relative") {
            if (!firstRelativeDocument || !available.includes("read"))
              return new Response("B relative native Read was not available", {
                status: 400,
              });
            stage = "b-state-write";
            return toolResponse("read", "call_fixture_b_read_relative", {
              filePath: firstRelativeDocument,
            });
          }
          if (stage === "b-state-write") {
            if (!available.includes("state_write"))
              return new Response("B state_write was not exposed to provider", {
                status: 400,
              });
            stage = "b-write";
            return toolResponse("state_write", "call_fixture_b_state_write", {
              mode: "deep-interview",
              state: {
                current_phase: "current-session-only",
                task_description: "second native host session fixture",
              },
            });
          }
          if (stage === "b-write") {
            if (!secondStatePaths || !available.includes("write"))
              return new Response("B native Write was not available", {
                status: 400,
              });
            secondDocument = join(
              secondStatePaths.specsDir,
              "deep-interview-fixture.md",
            );
            stage = "b-state-clear";
            return toolResponse("write", "call_fixture_b_write", {
              filePath: secondDocument,
              content:
                "# Native host-session fixture\n\nAnswer: B session only\n\n- [ ] approval does not transfer\n",
            });
          }
          if (stage === "b-state-clear") {
            if (!available.includes("state_clear"))
              return new Response("B state_clear was not exposed to provider", {
                status: 400,
              });
            stage = "b-done";
            return toolResponse("state_clear", "call_fixture_b_state_clear", {
              mode: "deep-interview",
            });
          }
          if (stage === "b-denied-state-write") {
            if (!available.includes("state_write")) {
              stage = "b-denied-done";
              events.push({
                kind: "native-tool-filtered",
                tool: "state_write",
                reason: "session permission deny",
              });
              return textResponse(
                "state_write denied by native permission filtering; the previously written document remains a separate result.",
              );
            }
            stage = "b-denied-done";
            return toolResponse(
              "state_write",
              "call_fixture_b_denied_state_write",
              {
                mode: "deep-interview",
                state: {
                  current_phase: "must-not-persist",
                  task_description: "configured state_write denial",
                },
              },
            );
          }
          if (stage === "b-denied-write") {
            if (!available.includes("write")) {
              stage = "b-denied-write-done";
              events.push({
                kind: "native-tool-filtered",
                tool: "write",
                reason: "session edit deny",
              });
              return textResponse(
                "Forbidden replacement was not attempted: write denied by native permission filtering.",
              );
            }
            if (!secondDocument)
              return new Response(
                "B denied-write native Write was not exposed to provider",
                { status: 400 },
              );
            stage = "b-denied-write-done";
            return toolResponse("write", "call_fixture_b_denied_write", {
              filePath: secondDocument,
              content: "# Forbidden replacement\n",
            });
          }
          if (stage === "missing-read") {
            if (!missingPath || !available.includes("read"))
              return new Response(
                "missing-path native Read was not available",
                {
                  status: 400,
                },
              );
            stage = "missing-done";
            return toolResponse("read", "call_fixture_missing_read", {
              filePath: missingPath,
            });
          }
          if (stage === "symlink-read") {
            if (!symlinkPath || !available.includes("read"))
              return new Response("symlink native Read was not available", {
                status: 400,
              });
            stage = "symlink-done";
            return toolResponse("read", "call_fixture_symlink_read", {
              filePath: symlinkPath,
            });
          }
          if (
            stage === "b-done" ||
            stage === "b-denied-done" ||
            stage === "b-denied-write-done" ||
            stage === "missing-done" ||
            stage === "symlink-done"
          )
            return textResponse("Fixture sequence complete.");
          return textResponse("Fixture sequence complete.");
        })
        .catch(
          (error) =>
            new Response(`invalid fixture provider request: ${String(error)}`, {
              status: 400,
            }),
        );
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

  const version = await runVersion(environment);
  if (!version.includes("1.18.31"))
    fail(`Expected OpenCode 1.18.31, got ${version}`);
  const server = await startHost(environment);
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
  async function waitForIdle(sessionID: string, name: string) {
    await waitFor(
      name,
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
      15_000,
    );
  }

  const session = await api("/session", { method: "POST", body: "{}" });
  if (!isRecord(session) || typeof session.id !== "string")
    fail(`Session create did not return an id: ${JSON.stringify(session)}`);
  const sessionID = session.id;
  const encodedSessionID = encodeSessionID(sessionID);
  const expectedStatePath = join(
    root,
    ".open-gajae",
    `_session-${encodedSessionID}`,
    "state",
    "deep-interview-state.json",
  );
  const expectedSpecsDir = join(
    root,
    ".open-gajae",
    `_session-${encodedSessionID}`,
    "specs",
  );
  events.push({ kind: "session-created", sessionID, encodedSessionID });

  await api(`/session/${encodeURIComponent(sessionID)}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      agent: "open-gajae",
      model: { providerID: "fixture", modelID: "fixture-model" },
      parts: [
        {
          type: "text",
          text: "Run the deterministic native host-session fixture.",
        },
      ],
    }),
  });

  const question = await waitFor("native question request", async () => {
    const pending = await api("/question");
    if (
      !Array.isArray(pending) ||
      pending.length !== 1 ||
      !isRecord(pending[0]) ||
      typeof pending[0].id !== "string"
    )
      return undefined;
    return pending[0];
  });
  const questionID = question.id as string;
  const questionText = JSON.stringify(question);
  if (!questionText.includes("Fixture decision"))
    fail(`Unexpected native question payload: ${questionText}`);
  await api(`/question/${encodeURIComponent(questionID)}/reply`, {
    method: "POST",
    body: JSON.stringify({ answers: [["Fixture answer"]] }),
  });
  events.push({
    kind: "question-replied",
    questionID,
    answers: [["Fixture answer"]],
  });

  await waitFor(
    "provider completion",
    async () => (stage === "done" ? true : undefined),
    30_000,
  );
  if (
    !statePaths ||
    statePaths.statePath !== expectedStatePath ||
    statePaths.specsDir !== expectedSpecsDir
  )
    fail(
      `state_write did not return trusted current-session paths: ${JSON.stringify(statePaths)}`,
    );
  if (!expectedDocument)
    fail("provider never derived native Write path from state_write output");
  const state = await waitFor(
    "completed current-session state",
    async () => {
      const text = await readFile(expectedStatePath, "utf8").catch(
        () => undefined,
      );
      if (!text) return undefined;
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return parsed.current_phase === "completed" ? parsed : undefined;
    },
    30_000,
  );
  const document = await waitFor(
    "native Write document",
    async () => {
      const text = await readFile(expectedDocument!, "utf8").catch(
        () => undefined,
      );
      return text ===
        "# Native host-session fixture\n\nAnswer: Fixture answer\n\n- [ ] A-only checkbox\n\nApproval: A-only approval\n"
        ? text
        : undefined;
    },
    15_000,
  );
  if (expectedDocument !== join(expectedSpecsDir, "deep-interview-fixture.md"))
    fail("native Write escaped the returned specsDir");
  // The last state_write occurs after native Write; checking both files now proves the
  // current-session state update preserved the document rather than replacing its directory.
  if (!document.includes("Fixture answer") || state.answer !== "Fixture answer")
    fail("final state or document lost the native reply");
  if (
    state.approval !== "A-only approval" ||
    !Array.isArray(state.checklist) ||
    !state.checklist.includes("[ ] A-only checkbox") ||
    !document.includes("[ ] A-only checkbox") ||
    !document.includes("Approval: A-only approval")
  )
    fail("A session did not retain its checkbox and approval evidence");
  const aStateBytes = await readFile(expectedStatePath);
  const aDocumentBytes = await readFile(expectedDocument);

  const messages = await api(
    `/session/${encodeURIComponent(sessionID)}/message`,
  );
  const transcript = JSON.stringify(messages);
  if (!transcript.includes("Fixture answer"))
    fail("host session messages do not retain the native question answer");
  if ((transcript.match(/Fixture decision/g) ?? []).length !== 1)
    fail("host recorded duplicate native question requests");
  if (transcript.includes("Idle injection"))
    fail("unexpected idle injection appeared in host messages");
  if (providerRequests.length < 5)
    fail(
      `Expected provider tool pipeline, saw ${providerRequests.length} requests`,
    );
  if (!statePaths || !expectedDocument)
    fail("A session did not expose trusted paths for B's explicit reads");

  // The final state tool can finish before A's final model response. Do not
  // advance the shared scripted provider while A is still consuming it.
  await waitForIdle(sessionID, "A completed workflow idle");
  firstAbsoluteDocument = expectedDocument;
  firstRelativeDocument = join(
    ".open-gajae",
    `_session-${encodedSessionID}`,
    "specs",
    "deep-interview-fixture.md",
  );
  stage = "b-read-absolute";
  const secondSession = await api("/session", { method: "POST", body: "{}" });
  if (!isRecord(secondSession) || typeof secondSession.id !== "string")
    fail(
      `Second session create did not return an id: ${JSON.stringify(secondSession)}`,
    );
  const secondSessionID = secondSession.id;
  secondSessionIDForProvider = secondSessionID;
  const secondEncodedID = encodeSessionID(secondSessionID);
  const expectedSecondStatePath = join(
    root,
    ".open-gajae",
    `_session-${secondEncodedID}`,
    "state",
    "deep-interview-state.json",
  );
  const expectedSecondSpecsDir = join(
    root,
    ".open-gajae",
    `_session-${secondEncodedID}`,
    "specs",
  );
  await api(`/session/${encodeURIComponent(secondSessionID)}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      agent: "open-gajae",
      model: { providerID: "fixture", modelID: "fixture-model" },
      parts: [
        {
          type: "text",
          text: "Read A by the two explicit paths, then use B current-session state and document paths only.",
        },
      ],
    }),
  });
  await waitFor(
    "second-session provider completion",
    async () => (stage === "b-done" ? true : undefined),
    30_000,
  );
  await waitForIdle(secondSessionID, "B first workflow idle");
  if (
    !secondStatePaths ||
    secondStatePaths.statePath !== expectedSecondStatePath ||
    secondStatePaths.specsDir !== expectedSecondSpecsDir ||
    !secondDocument
  )
    fail(
      `B state_write did not return trusted current-session paths: ${JSON.stringify(secondStatePaths)}`,
    );
  const secondDocumentBytes = await waitFor(
    "B native Write document",
    async () => {
      const text = await readFile(secondDocument!, "utf8").catch(
        () => undefined,
      );
      return text?.includes("B session only") ? Buffer.from(text) : undefined;
    },
    15_000,
  );
  const clearedSecondState = await waitFor(
    "B current-session state clear",
    async () =>
      (await readFile(expectedSecondStatePath, "utf8").then(
        () => false,
        () => true,
      ))
        ? true
        : undefined,
    15_000,
  );
  if (!clearedSecondState)
    fail("B state_clear left a current-session state file behind");
  if (
    secondDocument !==
      join(expectedSecondSpecsDir, "deep-interview-fixture.md") ||
    !secondDocumentBytes.includes("approval does not transfer") ||
    secondDocumentBytes.includes("A-only approval")
  )
    fail("B native Write did not use its returned specsDir and same slug");
  if (
    !Buffer.from(await readFile(expectedStatePath)).equals(aStateBytes) ||
    !Buffer.from(await readFile(expectedDocument)).equals(aDocumentBytes)
  )
    fail("B workflow modified A state or approval/checklist document");
  const secondMessages = await api(
    `/session/${encodeURIComponent(secondSessionID)}/message`,
  );
  const secondTranscript = JSON.stringify(secondMessages);
  if (
    !secondTranscript.includes(firstAbsoluteDocument) ||
    !secondTranscript.includes(firstRelativeDocument)
  )
    fail("B actual tool trace did not retain the two explicit A reads");
  await api(`/session/${encodeURIComponent(secondSessionID)}`, {
    method: "PATCH",
    body: JSON.stringify({
      permission: [
        {
          permission: "state_write",
          pattern: expectedSecondStatePath,
          action: "deny",
        },
      ],
    }),
  });
  stage = "b-denied-state-write";
  await api(`/session/${encodeURIComponent(secondSessionID)}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      agent: "open-gajae",
      model: { providerID: "fixture", modelID: "fixture-model" },
      parts: [
        {
          type: "text",
          text: "Attempt the configured denied state write without changing B's document.",
        },
      ],
    }),
  });
  await waitFor(
    "B denied state_write provider completion",
    async () => (stage === "b-denied-done" ? true : undefined),
    20_000,
  );
  await waitForIdle(secondSessionID, "B denied state_write workflow idle");
  const deniedStateTranscript = await waitFor(
    "B configured state_write denial",
    async () => {
      const messages = await api(
        `/session/${encodeURIComponent(secondSessionID)}/message`,
      );
      const transcript = JSON.stringify(messages);
      return /state_write/.test(transcript) &&
        /denied|permission/i.test(transcript)
        ? transcript
        : undefined;
    },
    15_000,
  );
  if (
    !(await readFile(secondDocument, "utf8")).includes("B session only") ||
    (await readFile(expectedSecondStatePath, "utf8").then(
      () => true,
      () => false,
    ))
  )
    fail(
      "B native document did not survive its separately denied state persistence",
    );
  await api(`/session/${encodeURIComponent(secondSessionID)}`, {
    method: "PATCH",
    body: JSON.stringify({
      permission: [{ permission: "edit", pattern: "*", action: "deny" }],
    }),
  });
  stage = "b-denied-write";
  await api(`/session/${encodeURIComponent(secondSessionID)}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      agent: "open-gajae",
      model: { providerID: "fixture", modelID: "fixture-model" },
      parts: [
        {
          type: "text",
          text: "Attempt the configured denied replacement Write.",
        },
      ],
    }),
  });
  await waitFor(
    "B denied native Write provider completion",
    async () => (stage === "b-denied-write-done" ? true : undefined),
    20_000,
  );
  await waitForIdle(secondSessionID, "B denied native Write workflow idle");
  const deniedWriteTranscript = await waitFor(
    "B configured native Write denial",
    async () => {
      const messages = await api(
        `/session/${encodeURIComponent(secondSessionID)}/message`,
      );
      const transcript = JSON.stringify(messages);
      return transcript.includes("Forbidden replacement") &&
        /denied|permission/i.test(transcript)
        ? transcript
        : undefined;
    },
    15_000,
  );
  if (
    (await readFile(secondDocument, "utf8")) !== secondDocumentBytes.toString()
  )
    fail("Configured native Write denial modified the existing B document");

  missingPath = `${firstAbsoluteDocument}.missing`;
  stage = "missing-read";
  const missingSession = await api("/session", { method: "POST", body: "{}" });
  if (!isRecord(missingSession) || typeof missingSession.id !== "string")
    fail("Missing-path session create did not return an id");
  const missingSessionID = missingSession.id;
  await api(`/session/${encodeURIComponent(missingSession.id)}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      agent: "open-gajae",
      model: { providerID: "fixture", modelID: "fixture-model" },
      parts: [{ type: "text", text: "Attempt only the missing A path." }],
    }),
  });
  await waitFor(
    "missing-path provider completion",
    async () => (stage === "missing-done" ? true : undefined),
    20_000,
  );
  const missingTranscript = await waitFor(
    "missing-path native Read failure",
    async () => {
      const messages = await api(
        `/session/${encodeURIComponent(missingSessionID)}/message`,
      );
      const transcript = JSON.stringify(messages);
      return transcript.includes(missingPath!) &&
        /not found|enoent|does not exist|error/i.test(transcript)
        ? transcript
        : undefined;
    },
    15_000,
  );

  const outsideFile = join(base, "outside.txt");
  await writeFile(outsideFile, "external fixture source\n");
  symlinkPath = join(root, "external-link.txt");
  await symlink(outsideFile, symlinkPath);
  stage = "symlink-read";
  const deniedSession = await api("/session", {
    method: "POST",
    body: JSON.stringify({
      permission: [
        { permission: "read", pattern: "*external-link.txt", action: "deny" },
      ],
    }),
  });
  if (!isRecord(deniedSession) || typeof deniedSession.id !== "string")
    fail("Denied-read session create did not return an id");
  const deniedSessionID = deniedSession.id;
  await api(`/session/${encodeURIComponent(deniedSession.id)}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      agent: "open-gajae",
      model: { providerID: "fixture", modelID: "fixture-model" },
      parts: [
        { type: "text", text: "Attempt only the denied external symlink." },
      ],
    }),
  });
  await waitFor(
    "denied-symlink provider completion",
    async () => (stage === "symlink-done" ? true : undefined),
    20_000,
  );
  const deniedTranscript = await waitFor(
    "configured external-symlink read denial",
    async () => {
      const messages = await api(
        `/session/${encodeURIComponent(deniedSessionID)}/message`,
      );
      const transcript = JSON.stringify(messages);
      return transcript.includes(symlinkPath!) &&
        !transcript.includes(outsideFile) &&
        /denied|permission/i.test(transcript)
        ? transcript
        : undefined;
    },
    15_000,
  );
  const providerToolCalls = events.filter(
    (event) => event.kind === "provider-tool-call",
  );
  const callsFor = (prefix: string) =>
    providerToolCalls.filter(
      (event) => typeof event.id === "string" && event.id.startsWith(prefix),
    );
  const missingCalls = callsFor("call_fixture_missing");
  const symlinkCalls = callsFor("call_fixture_symlink");
  if (
    missingCalls.length !== 1 ||
    missingCalls[0]?.name !== "read" ||
    JSON.stringify(missingCalls[0]?.args) !==
      JSON.stringify({ filePath: missingPath })
  )
    fail("Missing-path fixture emitted an alternative file or selector");
  if (
    symlinkCalls.length !== 1 ||
    symlinkCalls[0]?.name !== "read" ||
    JSON.stringify(symlinkCalls[0]?.args) !==
      JSON.stringify({ filePath: symlinkPath })
  )
    fail("Denied-symlink fixture emitted an alternative file or selector");

  console.log(
    JSON.stringify(
      {
        kind: "api-package-test-report",
        status: "passed",
        hostVersion: version,
        runtime: {
          host,
          provider: "@ai-sdk/openai-compatible",
          baseURL: `http://127.0.0.1:${provider.port}/v1`,
          externalNetwork: false,
        },
        session: {
          id: sessionID,
          encodedID: encodedSessionID,
          statePath: expectedStatePath,
          specsDir: expectedSpecsDir,
        },
        toolSequence: [
          "state_write",
          "question",
          "question.reply",
          "write",
          "state_write",
          "B: read(A absolute)",
          "B: read(A relative)",
          "B: state_write",
          "B: write(same slug)",
          "B: state_clear",
          "B: configured state_write denial after successful Write",
          "B: configured native Write denial preserves prior document",
          "adversarial: read(missing A path)",
          "adversarial: read(denied external symlink)",
        ],
        evidence: {
          state,
          documentPath: expectedDocument,
          aStateBytes: aStateBytes.length,
          aDocumentBytes: aDocumentBytes.length,
          secondSession: {
            id: secondSessionID,
            encodedID: secondEncodedID,
            stateCleared: clearedSecondState,
            documentPath: secondDocument,
            deniedStateWriteObserved: /denied|permission/i.test(
              deniedStateTranscript,
            ),
            deniedWriteObserved: /denied|permission/i.test(
              deniedWriteTranscript,
            ),
          },
          adversarial: {
            missingPath,
            symlinkPath,
            configuredReadDeny: true,
            missingReadFailureObserved:
              /not found|enoent|does not exist|error/i.test(missingTranscript),
            deniedSymlinkReadObserved: /denied|permission/i.test(
              deniedTranscript,
            ),
            providerToolCalls,
          },
          providerRequests: providerRequests.length,
          events,
        },
        limitations: [
          "The deterministic provider validates OpenCode protocol and plugin integration only; it does not measure model intelligence quality.",
          "The B workflow proves current-session disk isolation and explicit host tool routing. It does not establish model resistance to hostile document content; the deterministic provider does not interpret that content.",
          "The adversarial reads prove this fixture sent no automatic alternative file path or selector after an actual host read failure or configured session denial.",
        ],
      },
      null,
      2,
    ),
  );
}

try {
  const deadline = setTimeout(() => {
    void stopHost();
    provider?.stop(true);
  }, 115_000);
  try {
    await main();
  } finally {
    clearTimeout(deadline);
  }
} catch (error) {
  failed = true;
  const report = {
    kind: "api-package-test-report",
    status: "failed",
    error: String(error),
    host,
    hostLogs,
    providerRequests,
    events,
  };
  await writeFile(join(base, "report.json"), JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await stopHost();
  provider?.stop(true);
  const preserveDirectory = process.env.OPEN_GAJAE_TEST_PRESERVE_FAILURE_DIR;
  if (failed && preserveDirectory) {
    await mkdir(preserveDirectory, { recursive: true });
    const retainedFixture = join(preserveDirectory, basename(base));
    await rename(base, retainedFixture);
    console.error(
      JSON.stringify(
        { kind: "api-package-test-report", retainedFixture },
        null,
        2,
      ),
    );
  } else {
    await rm(base, { recursive: true, force: true });
  }
}
