import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readdir,
  readFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

// Actual installed OpenCode, disposable HOME/project only; no model provider or credentials.
const host =
  process.env.OPEN_GAJAE_TEST_HOST ??
  join(process.env.HOME ?? "", ".opencode/bin/opencode");
const base = await mkdtemp(join(tmpdir(), "open-gajae-host-"));
const root = join(base, "project"),
  home = join(base, "home");
const packageRoot = resolve(import.meta.dir, "..");
const results: {
  name: string;
  command: string[];
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}[] = [];
try {
  await mkdir(root);
  await mkdir(home);
  const init = Bun.spawnSync(["git", "init", "--quiet", root], {
    env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (init.exitCode !== 0)
    throw new Error(`Fixture git init failed: ${init.stderr.toString()}`);
  await writeFile(
    join(root, "sample.ts"),
    "const answer = 42;\nconsole.log(answer);\n",
  );
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
    }),
  };
  async function run(
    name: string,
    args: string[],
    extra: Record<string, string> = {},
  ) {
    const result = await new Promise<(typeof results)[number]>(
      (resolveResult, reject) => {
        const child = spawn(host, args, {
          cwd: root,
          env: { ...environment, ...extra },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "",
          timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, 45000);
        child.stdout.on("data", (data) => {
          stdout += data;
        });
        child.stderr.on("data", (data) => {
          stderr += data;
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolveResult({
            name,
            command: [host, ...args],
            code,
            stdout,
            stderr,
            timedOut,
          });
        });
      },
    );
    results.push(result);
    if (result.timedOut) throw new Error(`${name}: host timed out`);
    return result;
  }
  function requireOutput(result: (typeof results)[number], expected: string) {
    if (result.code !== 0 || !result.stdout.includes(expected))
      throw new Error(
        `${result.name}: missing ${JSON.stringify(expected)}\n${result.stdout}\n${result.stderr}`,
      );
  }
  // `debug agent --tool` prints `{ tool, input, result: { title, output } }`,
  // where `output` is the tool's own JSON string.
  function toolOutput(result: (typeof results)[number]) {
    if (result.code !== 0)
      throw new Error(
        `${result.name}: exited ${result.code}\n${result.stdout}\n${result.stderr}`,
      );
    const payload = JSON.parse(result.stdout) as {
      result?: { output?: unknown };
    };
    const output = payload.result?.output;
    if (typeof output !== "string")
      throw new Error(
        `${result.name}: no tool output string\n${result.stdout}`,
      );
    return JSON.parse(output) as Record<string, unknown>;
  }
  function requireStatePath(result: (typeof results)[number], mode: string) {
    const parsed = toolOutput(result);
    const statePath = parsed.statePath;
    const suffix = `/state/${mode}-state.json`;
    if (typeof statePath !== "string" || !statePath.endsWith(suffix))
      throw new Error(
        `${result.name}: reported statePath ${JSON.stringify(statePath)}, expected one ending in ${suffix}`,
      );
    return statePath;
  }
  const version = await run("host-version", ["--version"]);
  requireOutput(version, "1.18.31");
  const config = await run("owned-agent-config", [
    "debug",
    "agent",
    "open-gajae",
  ]);
  requireOutput(config, "open-gajae");
  for (const role of [
    "open-gajae-planner",
    "open-gajae-architect",
    "open-gajae-critic",
  ]) {
    const roleConfig = await run(`owned-agent-config-${role}`, [
      "debug",
      "agent",
      role,
    ]);
    requireOutput(roleConfig, role);
    requireOutput(roleConfig, '"mode": "subagent"');
  }
  const state = await run("native-state-write", [
    "debug",
    "agent",
    "open-gajae",
    "--tool",
    "state_write",
    "--params",
    JSON.stringify({
      mode: "deep-interview",
      state: { hostProbe: true },
      task_description: "host snapshot",
    }),
  ]);
  requireOutput(state, "hostProbe");
  const sessions = (await readdir(join(root, ".open-gajae"))).filter((name) =>
    name.startsWith("_session-"),
  );
  if (sessions.length !== 1)
    throw new Error(
      `Expected one host-created session namespace, got ${sessions.length}`,
    );
  const saved = JSON.parse(
    await readFile(
      join(
        root,
        ".open-gajae",
        sessions[0]!,
        "state/deep-interview-state.json",
      ),
      "utf8",
    ),
  );
  if (saved.hostProbe !== true || !saved._meta?.sessionId)
    throw new Error("Actual host failed to persist native-session snapshot");
  function denyConfig(permission: string) {
    return {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        plugin: [pathToFileURL(join(packageRoot, "dist/index.js")).href],
        permission: { "*": "allow", [permission]: "deny" },
      }),
    };
  }
  const stateDenied = await run(
    "native-state-permission-denied",
    [
      "debug",
      "agent",
      "open-gajae",
      "--tool",
      "state_write",
      "--params",
      JSON.stringify({ mode: "deep-interview", state: { denied: true } }),
    ],
    denyConfig("state_write"),
  );
  if (stateDenied.code === 0)
    throw new Error("Host state_write deny was ignored");
  if (
    (await readdir(join(root, ".open-gajae"))).filter((name) =>
      name.startsWith("_session-"),
    ).length !== 1
  )
    throw new Error("Denied state write created a session namespace");
  const ast = await run("native-ast-addon", [
    "debug",
    "agent",
    "open-gajae-explore",
    "--tool",
    "ast_grep_search",
    "--params",
    JSON.stringify({
      pattern: "console.log($X)",
      language: "typescript",
      path: "sample.ts",
    }),
  ]);
  requireOutput(ast, "Found 1 match");
  const denied = await run("unrelated-actor-denied", [
    "debug",
    "agent",
    "build",
    "--tool",
    "state_write",
    "--params",
    JSON.stringify({ mode: "deep-interview", state: { unauthorized: true } }),
  ]);
  if (
    !`${denied.stdout}\n${denied.stderr}`.includes("restricted to owned agents")
  )
    throw new Error("Unrelated actor was not rejected by actual tool context");
  const document = join(
    root,
    ".open-gajae",
    sessions[0]!,
    "specs/deep-interview-host.md",
  );
  const write = await run("native-document-write", [
    "debug",
    "agent",
    "open-gajae",
    "--tool",
    "write",
    "--params",
    JSON.stringify({ filePath: document, content: "# Host spec\n" }),
  ]);
  if (
    write.code !== 0 ||
    (await readFile(document, "utf8")) !== "# Host spec\n"
  )
    throw new Error("Native Write did not publish document");
  const overwrite = await run("native-same-slug-overwrite", [
    "debug",
    "agent",
    "open-gajae",
    "--tool",
    "write",
    "--params",
    JSON.stringify({ filePath: document, content: "# Updated host spec\n" }),
  ]);
  if (
    overwrite.code !== 0 ||
    (await readFile(document, "utf8")) !== "# Updated host spec\n"
  )
    throw new Error("Native same-slug overwrite failed");
  const readOnlyDir = join(root, "read-only");
  await mkdir(readOnlyDir, { mode: 0o500 });
  try {
    const readOnlyWrite = await run("native-write-read-only-directory", [
      "debug",
      "agent",
      "open-gajae",
      "--tool",
      "write",
      "--params",
      JSON.stringify({
        filePath: join(readOnlyDir, "blocked.md"),
        content: "# Must not publish\n",
      }),
    ]);
    if (readOnlyWrite.code === 0 || (await readdir(readOnlyDir)).length !== 0)
      throw new Error(
        "Read-only filesystem target unexpectedly accepted native Write",
      );
  } finally {
    await chmod(readOnlyDir, 0o700);
  }
  const formatterMarker = join(root, "formatter-attempted");
  const formatterDocument = join(root, "formatter-failure.md");
  const formatter = await run(
    "native-write-formatter-failure",
    [
      "debug",
      "agent",
      "open-gajae",
      "--tool",
      "write",
      "--params",
      JSON.stringify({
        filePath: formatterDocument,
        content: "# Saved before formatter\n",
      }),
    ],
    {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        plugin: [pathToFileURL(join(packageRoot, "dist/index.js")).href],
        permission: { "*": "allow" },
        formatter: {
          "fixture-failure": {
            extensions: [".md"],
            command: [
              process.execPath,
              "-e",
              `require("node:fs").writeFileSync(${JSON.stringify(formatterMarker)}, "attempted"); process.exit(7);`,
            ],
          },
        },
      }),
    },
  );
  if ((await readFile(formatterMarker, "utf8")) !== "attempted")
    throw new Error(
      "Formatter failure scenario did not execute the configured formatter",
    );
  if (
    (await readFile(formatterDocument, "utf8")) !== "# Saved before formatter\n"
  )
    throw new Error(
      "Native formatter failure unexpectedly rolled back or changed the published document",
    );
  // Native formatting is best-effort after publication. Record its actual
  // exit/result rather than claiming a transaction or a guaranteed tool error.
  if (formatter.timedOut)
    throw new Error("Native formatter failure stalled Write");
  const read = await run("native-explicit-other-session-document", [
    "debug",
    "agent",
    "open-gajae",
    "--tool",
    "read",
    "--params",
    JSON.stringify({ filePath: document }),
  ]);
  requireOutput(read, "Updated host spec");
  const readDenied = await run(
    "native-document-read-denied",
    [
      "debug",
      "agent",
      "open-gajae",
      "--tool",
      "read",
      "--params",
      JSON.stringify({ filePath: document }),
    ],
    denyConfig("read"),
  );
  if (readDenied.code === 0) throw new Error("Host read deny was ignored");
  const writeDenied = await run(
    "native-document-write-denied",
    [
      "debug",
      "agent",
      "open-gajae",
      "--tool",
      "write",
      "--params",
      JSON.stringify({ filePath: document, content: "# Forbidden\n" }),
    ],
    denyConfig("edit"),
  );
  if (
    writeDenied.code === 0 ||
    (await readFile(document, "utf8")) !== "# Updated host spec\n"
  )
    throw new Error("Host edit deny did not preserve source");
  const lspDenied = await run(
    "native-lsp-permission-denied",
    [
      "debug",
      "agent",
      "open-gajae-explore",
      "--tool",
      "lsp_document_symbols",
      "--params",
      JSON.stringify({ file: "sample.ts" }),
    ],
    denyConfig("lsp"),
  );
  if (lspDenied.code === 0) throw new Error("Host lsp deny was ignored");
  const questionDenied = await run(
    "native-question-permission-denied",
    [
      "debug",
      "agent",
      "open-gajae",
      "--tool",
      "question",
      "--params",
      JSON.stringify({
        questions: [
          {
            header: "Scope",
            question: "Which scope?",
            options: [
              { label: "Small", description: "Small scope" },
              { label: "Large", description: "Large scope" },
            ],
          },
        ],
      }),
    ],
    denyConfig("question"),
  );
  if (questionDenied.code === 0)
    throw new Error("Host question deny was ignored");
  // Ralplan state round trip. Each `debug agent --tool` invocation opens its own
  // native session, so read and clear land in fresh session directories: they
  // prove mode routing and path resolution, and they prove cross-session
  // isolation, not same-session persistence.
  const ralplanWrite = await run("native-ralplan-state-write", [
    "debug",
    "agent",
    "open-gajae",
    "--tool",
    "state_write",
    "--params",
    JSON.stringify({
      mode: "ralplan",
      state: {
        mode: "ralplan",
        active: true,
        current_phase: "ralplan",
        awaiting_confirmation: true,
      },
    }),
  ]);
  const ralplanStatePath = requireStatePath(ralplanWrite, "ralplan");
  const ralplanSaved = JSON.parse(await readFile(ralplanStatePath, "utf8"));
  if (
    ralplanSaved.active !== true ||
    ralplanSaved.awaiting_confirmation !== true ||
    ralplanSaved.current_phase !== "ralplan" ||
    !ralplanSaved._meta?.sessionId
  )
    throw new Error("Actual host failed to persist the ralplan snapshot");
  const ralplanRead = await run("native-ralplan-state-read", [
    "debug",
    "agent",
    "open-gajae",
    "--tool",
    "state_read",
    "--params",
    JSON.stringify({ mode: "ralplan" }),
  ]);
  requireStatePath(ralplanRead, "ralplan");
  const ralplanClear = await run("native-ralplan-state-clear", [
    "debug",
    "agent",
    "open-gajae",
    "--tool",
    "state_clear",
    "--params",
    JSON.stringify({ mode: "ralplan" }),
  ]);
  requireStatePath(ralplanClear, "ralplan");
  if ((await readFile(ralplanStatePath, "utf8").catch(() => "")) === "")
    throw new Error(
      "Ralplan state_clear reached into another native session's state file",
    );
  const deepInterviewAfter = await readFile(
    join(root, ".open-gajae", sessions[0]!, "state/deep-interview-state.json"),
    "utf8",
  );
  if (JSON.stringify(JSON.parse(deepInterviewAfter)) !== JSON.stringify(saved))
    throw new Error(
      "Ralplan state round trip modified the deep-interview snapshot",
    );
  const debugConfig = await run("native-ralplan-command", ["debug", "config"]);
  if (debugConfig.code !== 0)
    throw new Error(
      `native-ralplan-command: exited ${debugConfig.code}\n${debugConfig.stderr}`,
    );
  let resolvedConfig: { command?: Record<string, { template?: unknown }> };
  try {
    resolvedConfig = JSON.parse(debugConfig.stdout);
  } catch (error) {
    throw new Error(
      `native-ralplan-command: debug config output is not JSON: ${String(error)}`,
    );
  }
  // Assert the parsed field, not a raw substring: the skill path in the resolved
  // config also contains "ralplan".
  const ralplanTemplate = resolvedConfig.command?.ralplan?.template;
  if (
    typeof ralplanTemplate !== "string" ||
    !ralplanTemplate.includes("ralplan")
  )
    throw new Error(
      `native-ralplan-command: command.ralplan.template is ${JSON.stringify(ralplanTemplate)}`,
    );
  // The resolved config is ~60KB; keep only the asserted slice in the report.
  debugConfig.stdout = JSON.stringify({ command: resolvedConfig.command });
  const roles = [
    "open-gajae",
    "open-gajae-explore",
    "open-gajae-document-specialist",
    "open-gajae-planner",
    "open-gajae-architect",
    "open-gajae-critic",
  ];
  await mkdir(join(home, ".open-gajae"), { recursive: true });
  await writeFile(
    join(home, ".open-gajae/open-gajae.jsonc"),
    JSON.stringify({
      agents: Object.fromEntries(
        roles.map((name) => [
          name,
          { model: "openai/user-model", variant: "user-variant" },
        ]),
      ),
    }),
  );
  await writeFile(
    join(root, ".open-gajae/open-gajae.jsonc"),
    JSON.stringify({
      agents: Object.fromEntries(
        roles.map((name) => [name, { variant: "project-variant" }]),
      ),
    }),
  );
  for (const name of roles) {
    const projectResult = await run(`${name}-project-over-user`, [
      "debug",
      "agent",
      name,
    ]);
    requireOutput(projectResult, "user-model");
    requireOutput(projectResult, "project-variant");
    const hostResult = await run(
      `${name}-host-over-project`,
      ["debug", "agent", name],
      {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          plugin: [pathToFileURL(join(packageRoot, "dist/index.js")).href],
          agent: {
            [name]: { model: "openai/host-model", variant: "host-variant" },
          },
          permission: { "*": "allow" },
        }),
      },
    );
    requireOutput(hostResult, "host-model");
    requireOutput(hostResult, "host-variant");
  }
  console.log(
    JSON.stringify(
      {
        kind: "api-package-test-report",
        surface: "actual OpenCode debug agent tool execution",
        results,
        savedSession: saved._meta.sessionId,
        limitations: [
          "No provider-backed model turn or native question reply was exercised.",
          "Each debug invocation has its own native session; same-session state ordering is covered by integration tests. The ralplan state_read and state_clear therefore assert mode routing and cross-session isolation, not same-session persistence.",
          "The four returned hook keys are asserted in tests/integration.test.ts; this probe only shells out to `opencode debug ...` and never sees the object createHooks returns.",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        kind: "api-package-test-report",
        status: "failed",
        error: String(error),
        results,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await rm(base, { recursive: true, force: true });
}
