import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Config, Hooks, ToolContext } from "@opencode-ai/plugin";
import { createOpencodeClient } from "@opencode-ai/sdk";
import {
  loadSettings,
  configureAgents,
  explorePermissions,
} from "../src/config";
import { StateStore } from "../src/state";
import { createHooks } from "../src/hooks";
import { createTools } from "../src/tools";

function ownedCommand() {
  return {
    name: "deep-interview",
    source: "skill",
    template: `content\nBase directory for this skill: ${resolve("skills/deep-interview")}\nRelative paths in this skill (e.g., scripts/, references/) are relative to this base directory.`,
  };
}
async function fixture(run: (root: string, home: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "open-gajae-config-"));
  try {
    const root = join(dir, "project");
    const home = join(dir, "home");
    await Promise.all([
      mkdir(join(root, ".open-gajae"), { recursive: true }),
      mkdir(join(home, ".open-gajae"), { recursive: true }),
    ]);
    await run(root, home);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("field precedence preserves per-role omissions and rejects invalid policy keys", async () => {
  await fixture(async (root, home) => {
    await writeFile(
      join(home, ".open-gajae/open-gajae.jsonc"),
      '{ // user\n "deepInterview":{"maxRounds":11}, "agents":{"open-gajae":{"model":"openai/gpt-5.6-luna","variant":"high"}}}',
    );
    await writeFile(
      join(root, ".open-gajae/open-gajae.jsonc"),
      '{"deepInterview":{"ambiguityThreshold":0.15},"agents":{"open-gajae":{"variant":"low"}}}',
    );
    const result = await loadSettings(root, home);
    expect(result.deepInterview).toEqual({
      maxRounds: 11,
      ambiguityThreshold: 0.15,
    });
    expect(result.agents).toEqual({
      "open-gajae": { model: "openai/gpt-5.6-luna", variant: "low" },
    });
    for (const invalid of [
      '{"agents":{"explore":{}}}',
      '{"deepInterview":{"maxRounds":0}}',
      '{"agents":{"open-gajae":{"model":"luna"}}}',
      '{"agents":{"open-gajae":{"variant":" "}}}',
      '{"deepInterview":null}',
      "{bad",
    ]) {
      await writeFile(join(root, ".open-gajae/open-gajae.jsonc"), invalid);
      await expect(loadSettings(root, home)).rejects.toThrow();
    }
  });
});
test("registers substantive owned roles without broadening user or native configuration", async () => {
  const builtins = {
    build: { model: "test/build" },
    plan: { prompt: "original plan" },
    explore: { model: "test/explore" },
    general: { prompt: "original general" },
  };
  const input = {
    agent: structuredClone(builtins),
    permission: {
      edit: "ask" as const,
      read: "deny" as const,
      task: "deny" as const,
    },
    default_agent: "plan",
  };
  const configured: Config = input;
  await configureAgents(
    configured,
    {
      deepInterview: { ambiguityThreshold: 0.2, maxRounds: 20 },
      agents: { "open-gajae-explore": { model: "openai/gpt-5.6-terra" } },
    },
    resolve("."),
  );
  for (const name of Object.keys(builtins))
    expect(configured.agent?.[name]).toEqual(
      builtins[name as keyof typeof builtins],
    );
  expect(input.permission).toEqual({ edit: "ask", read: "deny", task: "deny" });
  expect(input.default_agent).toBe("plan");
  const primary = configured.agent!["open-gajae"]!;
  const explore = configured.agent!["open-gajae-explore"]!;
  expect(primary.mode).toBe("primary");
  expect(primary.model).toBeUndefined();
  expect<unknown>(primary.permission).toEqual({ question: "allow" });
  expect(primary.prompt).toContain('subagent_type: "open-gajae-explore"');
  expect(explore.mode).toBe("subagent");
  expect(explore.model).toBe("openai/gpt-5.6-terra");
  expect(explore.prompt).toContain("<relationships>");
  expect(explore.prompt).not.toBe(primary.prompt);
  expect(explore.permission).toEqual(explorePermissions);
  expect(
    Object.values(explorePermissions).every((action) => action === "deny"),
  ).toBe(true);
  expect(configured.command).toBeUndefined();
});
test("retains explorer and native command collision protection", async () => {
  const settings = {
    deepInterview: { ambiguityThreshold: 0.2, maxRounds: 20 },
    agents: {},
  };
  await expect(
    configureAgents(
      { agent: { "open-gajae-explore": { prompt: "user" } } },
      settings,
      resolve("."),
    ),
  ).rejects.toThrow("Agent collision");
  await expect(
    configureAgents(
      { command: { "deep-interview": { template: "user" } } },
      settings,
      resolve("."),
    ),
  ).rejects.toThrow("Command collision");
});

test("primary user overrides preserve native permission ordering without late grants", async () => {
  const cases = [
    { global: { question: "deny" }, local: undefined },
    { global: { "*": "deny" }, local: undefined },
    { global: { "ques*": "deny" }, local: undefined },
    { global: { "questio?": "ask" }, local: { edit: "ask" } },
    { global: { question: "deny" }, local: { question: "allow" } },
    { global: { question: "allow" }, local: { question: "deny" } },
    { global: undefined, local: { "*": "deny", question: "allow" } },
    { global: undefined, local: { question: "allow", "*": "deny" } },
    { global: { question: { "*": "deny" } }, local: undefined },
    { global: undefined, local: { question: { "*": "ask" } } },
  ];
  for (const { global, local } of cases) {
    // The installed legacy SDK omits host-supported question/wildcard keys.
    const config = {
      permission: global,
      agent: {
        "open-gajae": {
          permission: local,
          model: "test/user",
          prompt: "user prompt",
        },
      },
    } as Config;
    const before = structuredClone(config);
    await configureAgents(
      config,
      {
        deepInterview: { ambiguityThreshold: 0.2, maxRounds: 20 },
        agents: { "open-gajae": { model: "test/plugin" } },
      },
      resolve("."),
    );
    expect(config.permission).toEqual(before.permission);
    expect<unknown>(config.agent!["open-gajae"]!.permission).toEqual(local);
    expect(Object.keys(config.agent!["open-gajae"]!.permission ?? {})).toEqual(
      Object.keys(local ?? {}),
    );
    expect(config.agent!["open-gajae"]!.model).toBe("test/user");
    expect(config.agent!["open-gajae"]!.prompt).toBe("user prompt");
    expect(config.agent!["open-gajae-explore"]!.permission).toEqual(
      explorePermissions,
    );
  }
  const config: Config = {
    permission: { read: "deny" } as Config["permission"],
    agent: { "open-gajae": { permission: { edit: "ask" } } },
  };
  await configureAgents(
    config,
    { deepInterview: { ambiguityThreshold: 0.2, maxRounds: 20 }, agents: {} },
    resolve("."),
  );
  expect<unknown>(config.agent!["open-gajae"]!.permission).toEqual({
    question: "allow",
    edit: "ask",
  });
});

test("native tools enforce caller scope and permission while combining explicit snapshot writes", async () => {
  await fixture(async (root) => {
    const store = new StateStore(root, {
      ambiguityThreshold: 0.2,
      maxRounds: 20,
    });
    await store.start("s", "tool surface");
    const tools = createTools(store);
    const asks: string[] = [];
    const context: ToolContext = {
      sessionID: "s",
      messageID: "m",
      agent: "open-gajae",
      directory: root,
      worktree: root,
      abort: new AbortController().signal,
      metadata() {},
      async ask(input) {
        asks.push(input.permission);
      },
    };
    await tools.state_write.execute(
      {
        mode: "deep-interview",
        state: { goal: "kept", task_description: "custom" },
        task_description: "explicit",
      },
      context,
    );
    expect((await store.read("s"))?.task_description).toBe("explicit");
    expect(asks).toEqual(["state_write"]);
    await expect(
      tools.state_read.execute(
        { mode: "deep-interview", session_id: "other" },
        context,
      ),
    ).rejects.toThrow("caller");
    await expect(
      tools.state_write.execute(
        { mode: "deep-interview", state: { goal: "denied" } },
        {
          ...context,
          async ask() {
            throw new Error("permission denied");
          },
        },
      ),
    ).rejects.toThrow("denied");
    expect((await store.read("s"))?.goal).toBe("kept");
  });
});

test("native questions wait without injection and progress only on actual replies", async () => {
  await fixture(async (root) => {
    const store = new StateStore(root, {
      ambiguityThreshold: 0.2,
      maxRounds: 20,
    });
    await store.start("s", "hook surface");
    const requests: string[] = [];
    const client = createOpencodeClient({
      baseUrl: "http://fixture.local",
      fetch: (async (request: Request) => {
        requests.push(new URL(request.url).pathname);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const hooks = createHooks(store, client);
    const send = async (event: unknown) =>
      hooks.event!({
        event: event as Parameters<NonNullable<Hooks["event"]>>[0]["event"],
      });
    await expect(
      hooks["tool.execute.before"]!(
        { tool: "question", sessionID: "s", callID: "call" },
        { args: { questions: [{}, {}] } },
      ),
    ).rejects.toThrow("exactly one");
    await hooks["tool.execute.before"]!(
      { tool: "question", sessionID: "s", callID: "call" },
      { args: { questions: [{}] } },
    );
    await send({
      type: "question.asked",
      properties: { id: "q", sessionID: "s", tool: { callID: "call" } },
    });
    const idle = { type: "session.idle", properties: { sessionID: "s" } };
    const waiting = await store.read("s");
    await Promise.all([send(idle), send(idle)]);
    expect(await store.read("s")).toEqual(waiting);
    expect(waiting?._runtime.status).toBe("waiting");
    await expect(
      hooks["tool.execute.before"]!(
        { tool: "question", sessionID: "s", callID: "duplicate" },
        { args: { questions: [{}] } },
      ),
    ).rejects.toThrow("duplicate");
    await Promise.all([
      send({
        type: "question.replied",
        properties: { requestID: "q", sessionID: "s", answers: [["actual"]] },
      }),
      send({
        type: "question.replied",
        properties: { requestID: "q", sessionID: "s", answers: [["actual"]] },
      }),
    ]);
    await send({
      type: "question.rejected",
      properties: { requestID: "stale", sessionID: "s" },
    });
    expect((await store.read("s"))?._runtime.round).toBe(1);
    expect((await store.read("s"))?._runtime.answers?.[0].answers).toEqual([
      ["actual"],
    ]);
    await Promise.all([send(idle), send(idle)]);
    await hooks["tool.execute.before"]!(
      { tool: "question", sessionID: "s", callID: "next" },
      { args: { questions: [{}] } },
    );
    await send({
      type: "question.asked",
      properties: { id: "q2", sessionID: "s", tool: { callID: "next" } },
    });
    await send({
      type: "question.rejected",
      properties: { requestID: "q2", sessionID: "s" },
    });
    expect((await store.read("s"))?._runtime.status).toBe("interrupted");
    expect((await store.read("s"))?._runtime.round).toBe(1);
    await store.cancel("s");
    await send(idle);
    expect(requests).toEqual([]);
    // Finishing an interview must not permanently block ordinary native questions.
    await hooks["tool.execute.before"]!(
      { tool: "question", sessionID: "s", callID: "ordinary" },
      { args: { questions: [{}, {}] } },
    );
  });
});

test("text-only questions and changing assistant IDs never trigger idle reinjection", async () => {
  await fixture(async (root) => {
    const store = new StateStore(root, {
      ambiguityThreshold: 0.2,
      maxRounds: 20,
    });
    const original = await store.start("s", "ask before proceeding");
    const requests: string[] = [];
    let turn = 0;
    const client = createOpencodeClient({
      baseUrl: "http://fixture.local",
      fetch: (async (request: Request) => {
        const path = new URL(request.url).pathname;
        requests.push(path);
        if (path.endsWith("/status")) return Response.json({});
        if (path.endsWith("/message"))
          return Response.json([
            {
              info: {
                id: `user${turn}`,
                role: "user",
                agent: "open-gajae",
                model: { providerID: "openai", modelID: "gpt-5.6-terra" },
              },
              parts: [],
            },
            {
              info: {
                id: `assistant${turn}`,
                parentID: `user${turn}`,
                role: "assistant",
                time: { completed: turn + 1 },
              },
              parts: [{ type: "text", text: "Which scope do you want?" }],
            },
          ]);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const hooks = createHooks(store, client);
    for (; turn < 7; turn++) {
      await hooks.event!({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: `assistant${turn}`,
              sessionID: "s",
              role: "assistant",
              time: { completed: turn + 1 },
            },
          },
        } as Parameters<NonNullable<Hooks["event"]>>[0]["event"],
      });
      await hooks.event!({
        event: {
          type: "session.status",
          properties: { sessionID: "s", status: { type: "idle" } },
        },
      });
      await hooks.event!({
        event: { type: "session.idle", properties: { sessionID: "s" } },
      });
    }
    expect(requests).toEqual([]);
    expect(await store.read("s")).toEqual(original);
  });
});

test("assistant interruption and errors remain recorded without idle polling", async () => {
  await fixture(async (root) => {
    const store = new StateStore(root, {
      ambiguityThreshold: 0.2,
      maxRounds: 20,
    });
    await store.start("aborted", "interruption");
    await store.start("failed", "error");
    const requests: string[] = [];
    const hooks = createHooks(
      store,
      createOpencodeClient({
        baseUrl: "http://fixture.local",
        fetch: (async (request: Request) => {
          requests.push(request.url);
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      }),
    );
    for (const [sessionID, name] of [
      ["aborted", "MessageAbortedError"],
      ["failed", "APIError"],
    ]) {
      await hooks.event!({
        event: {
          type: "message.updated",
          properties: {
            info: { sessionID, role: "assistant", error: { name } },
          },
        } as Parameters<NonNullable<Hooks["event"]>>[0]["event"],
      });
    }
    expect((await store.read("aborted"))?._runtime.status).toBe("interrupted");
    expect((await store.read("failed"))?._runtime.status).toBe("error");
    expect((await store.read("aborted"))?._runtime.round).toBe(0);
    expect(requests).toEqual([]);
  });
});

test("resume reconciles actual tool answers and leaves absent pending evidence unresolved", async () => {
  await fixture(async (root) => {
    const store = new StateStore(root, {
      ambiguityThreshold: 0.2,
      maxRounds: 20,
    });
    await store.start("s", "restart");
    await store.recordQuestionIntent("s", "requirement", "call");
    await store.recordQuestionAsked("s", "q", "call");
    let recorded = false;
    const client = createOpencodeClient({
      baseUrl: "http://fixture.local",
      fetch: (async (request: Request) => {
        if (new URL(request.url).pathname.endsWith("/command"))
          return Response.json([ownedCommand()]);
        if (new URL(request.url).pathname.endsWith("/status"))
          return Response.json({});
        return Response.json(
          recorded
            ? [
                {
                  info: { role: "assistant" },
                  parts: [
                    {
                      type: "tool",
                      tool: "question",
                      callID: "call",
                      state: {
                        status: "completed",
                        metadata: { answers: [["restored"]] },
                      },
                    },
                  ],
                },
              ]
            : [],
        );
      }) as typeof fetch,
    });
    const hooks = createHooks(store, client);
    const input = {
      command: "deep-interview",
      sessionID: "s",
      arguments: "resume",
    };
    await expect(
      hooks["command.execute.before"]!(input, { parts: [] }),
    ).rejects.toThrow("confirmation");
    expect((await store.read("s"))?._runtime.round).toBe(0);
    recorded = true;
    await hooks["command.execute.before"]!(input, { parts: [] });
    expect((await store.read("s"))?._runtime.answers?.[0].answers).toEqual([
      ["restored"],
    ]);
    expect((await store.read("s"))?._runtime.round).toBe(1);
  });
});

test("shadowed native commands cannot start interview state", async () => {
  await fixture(async (root) => {
    const store = new StateStore(root, {
      ambiguityThreshold: 0.2,
      maxRounds: 20,
    });
    let selected = { ...ownedCommand(), source: "mcp" };
    const client = createOpencodeClient({
      baseUrl: "http://fixture.local",
      fetch: (async (_request: Request) =>
        Response.json([selected])) as typeof fetch,
    });
    const hooks = createHooks(store, client);
    const input = {
      command: "deep-interview",
      sessionID: "s",
      arguments: "new idea",
    };
    await expect(
      hooks["command.execute.before"]!(input, { parts: [] }),
    ).rejects.toThrow("ownership");
    expect(await store.read("s")).toBeUndefined();
    selected = { ...ownedCommand(), template: "foreign skill" };
    await expect(
      hooks["command.execute.before"]!(input, { parts: [] }),
    ).rejects.toThrow("ownership");
    selected = ownedCommand();
    await hooks["command.execute.before"]!(input, { parts: [] });
    expect((await store.read("s"))?._runtime.status).toBe("active");
  });
});
