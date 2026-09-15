import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  readdir,
} from "node:fs/promises";
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

    await store.start("denied", "denied cap");
    const beforeDeniedCap = await store.read("denied");
    const deniedSpecDirectory = join(root, ".open-gajae", "specs", "denied");
    const deniedFilesBefore = await readdir(deniedSpecDirectory).catch(
      () => [],
    );
    await expect(
      tools.deep_interview_spec.execute(
        { markdown: "# Partial", termination: "limit-reached" },
        {
          ...context,
          sessionID: "denied",
          async ask(input) {
            if (input.permission === "deep_interview_spec")
              throw new Error("permission denied");
          },
        },
      ),
    ).rejects.toThrow("permission denied");
    expect(await store.read("denied")).toEqual(beforeDeniedCap);
    expect(await readdir(deniedSpecDirectory).catch(() => [])).toEqual(
      deniedFilesBefore,
    );

    const cap = await tools.deep_interview_spec.execute(
      { markdown: "# Partial", termination: "limit-reached" },
      context,
    );
    expect(JSON.parse(cap).termination).toBe("limit-reached");
    expect((await store.read("s"))?._runtime.status).toBe("limit-reached");
    await expect(
      tools.deep_interview_spec.execute(
        { markdown: "# Different", termination: "limit-reached" },
        context,
      ),
    ).rejects.toThrow("different spec receipt");
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
    expect((await store.read("s"))?._runtime.answers?.[0]).toMatchObject({
      requestId: "q",
      kind: "requirement",
    });
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
    expect((await store.read("s"))?._runtime.answers).toHaveLength(1);
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
    expect((await store.read("aborted"))?._runtime.answers).toBeUndefined();
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
    expect((await store.read("s"))?._runtime.answers).toBeUndefined();
    recorded = true;
    await hooks["command.execute.before"]!(input, { parts: [] });
    expect((await store.read("s"))?._runtime.answers?.[0].answers).toEqual([
      ["restored"],
    ]);
    expect((await store.read("s"))?._runtime.answers).toHaveLength(1);
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


// Fixed approved literals; expectations never derive from SKILL.md.
// T1 / blocks 01-05: OMC 5281b19e0d64f8e6dc6767f2130299a88af2dc71,
// blob bd1dfcee3a4bf28d76f0eefa4d706e0fa7189ba5, Phase 2 / Step 2a-2b.
test("deep-interview source contract: complete OMC question blocks", async () => {
  const skill = await readFile(new URL("../skills/deep-interview/SKILL.md", import.meta.url), "utf8");
  expect(skill).toContain("Build the question generation prompt with:\n- The prompt-safe initial-context summary (if one was created), otherwise the user's original idea\n- Prior Q&A rounds trimmed or summarized to fit the prompt budget while preserving decisions, constraints, unresolved gaps, and ontology changes\n- Current clarity scores per dimension (which is weakest?)\n- Challenge agent mode (if activated -- see Challenge perspectives, not new agents)\n- Brownfield codebase context (if applicable), summarized to cited paths/symbols/patterns instead of raw dumps\n- Locked topology from Round 0, including active components, deferred components, prior per-component scores, and last_targeted_component_id\n\nIf any prompt input is too large, summarize it first and then continue from the summary. Do not ask the next question, score ambiguity, or hand off to execution from an over-budget raw transcript.\n\nQuestion targeting strategy:\n- Identify the active component + dimension pair with the LOWEST clarity score across the locked topology\n- When N > 1 active components are tied or similarly weak, rotate targeting across active components rather than asking repeatedly about the last targeted component; update topology.last_targeted_component_id after each question\n- Generate a question that specifically improves that component's weakest dimension\n- State, in one sentence before the question, why this component/dimension pair is now the bottleneck to reducing ambiguity\n- Questions should expose ASSUMPTIONS, not gather feature lists\n- If the scope is still conceptually fuzzy (entities keep shifting, the user is naming symptoms, or the core noun is unstable), switch to an ontology-style question that asks what the thing fundamentally IS before returning to feature/detail questions");
  expect(skill).toContain("| Dimension | Question Style | Example |\n|-----------|---------------|---------|\n| Goal Clarity | \"What exactly happens when...?\" | \"When you say 'manage tasks', what specific action does a user take first?\" |\n| Constraint Clarity | \"What are the boundaries?\" | \"Should this work offline, or is internet connectivity assumed?\" |\n| Success Criteria | \"How do we know it works?\" | \"If I showed you the finished product, what would make you say 'yes, that's it'?\" |\n| Context Clarity (brownfield) | \"How does this fit?\" | \"I found JWT auth middleware in `src/auth/` (pattern: passport + JWT). Should this feature extend that path or intentionally diverge from it?\" |\n| Scope-fuzzy / ontology stress | \"What IS the core thing here?\" | \"You have named Tasks, Projects, and Workspaces across the last rounds. Which one is the core entity, and which are supporting views or containers?\" |");
  expect(skill).toContain("Round {n} | Component: {target_component_name} | Targeting: {weakest_dimension} | Why now: {one_sentence_targeting_rationale} | Ambiguity: {score}%\n\n{question}");
  expect(skill).toContain("Options should include contextually relevant choices plus free-text.");
});
// T2 / blocks 06-10: OMX cb955b0d5becbef76d2c1f0096b6e1f238e1e7f7,
// blob a9f0242789f2f23c6ce6e3441f579602cd3d1c4a, Execution_Policy and Phase 2 / 2a.
test("deep-interview source contract: complete OMX pressure and terminology blocks", async () => {
  const skill = await readFile(new URL("../skills/deep-interview/SKILL.md", import.meta.url), "utf8");
  expect(skill).toContain("- Treat every answer as a claim to pressure-test before moving on: the next question should usually demand evidence or examples, expose a hidden assumption, force a tradeoff or boundary, or reframe root cause vs symptom\n- Do not rotate to a new clarity dimension just for coverage when the current answer is still vague; stay on the same thread until one layer deeper, one assumption clearer, or one boundary tighter\n- Before crystallizing, complete at least one explicit pressure pass that revisits an earlier answer with a deeper, assumption-focused, or tradeoff-focused follow-up\n- Use scenario-based edge-case grilling when relationships, boundaries, or handoff behavior are unclear: invent one concrete scenario that stresses the ambiguous boundary, then ask one focused question about the expected outcome.\n- Durable docs, glossary, ADR, or memory updates are opt-in and public-safe only. Deep-interview may recommend such updates in the handoff summary, but must not automatically create or dump public docs from interview transcripts unless the user explicitly chooses that as in-scope.");
  expect(skill).toContain("Follow-up pressure ladder after each answer:\n1. Ask for a concrete example, counterexample, or evidence signal behind the latest claim\n2. Probe the hidden assumption, dependency, or belief that makes the claim true\n3. Force a boundary or tradeoff: what would you explicitly not do, defer, or reject?\n4. Challenge fuzzy or conflicting terms against the repo's documented language and current code behavior\n5. Stress-test the boundary with one concrete scenario or edge case when a relationship or handoff remains ambiguous\n6. If the answer still describes symptoms, reframe toward essence / root cause before moving on\n\nPrefer staying on the same thread for multiple rounds when it has the highest leverage. Breadth without pressure is not progress.\n\nMaintain a Docs/Terminology Ledger for brownfield interviews:\n- repo docs/rules/context sources inspected, with path references\n- canonical terms already used by the repo and terms to avoid or disambiguate\n- user terms that conflict with docs or current code behavior\n- doc/code mismatches that require a human decision before implementation\n- optional durable-doc follow-ups that are safe to propose but not auto-apply\n\n`Non-goals` and `Decision Boundaries` are mandatory readiness gates. Ask about them early and keep revisiting them until they are explicit.");
});
// T3 / blocks 11-13: OMC 5281b19e0d64f8e6dc6767f2130299a88af2dc71,
// blob bd1dfcee3a4bf28d76f0eefa4d706e0fa7189ba5, Phase 2 / Step 2c.
test("deep-interview source contract: complete OMC scoring and ontology blocks", async () => {
  const skill = await readFile(new URL("../skills/deep-interview/SKILL.md", import.meta.url), "utf8");
  expect(skill).toContain("For this selected calculation, `total_entities` means the current ontology snapshot's entity count. Use one canonical ontology-convergence record: Round 1 and zero-entity snapshots remain `N/A`; exactly 50% field overlap is not a rename; a renamed entity is changed rather than both removed and new; and show named/renamed matches plus unmatched new/removed entities before counts. Do not introduce an overlap formula or matcher beyond the selected prompt.");
  expect(skill).not.toContain("## Ontology after each requirements round");
  expect(skill).toContain("Given the following interview transcript for a {greenfield|brownfield} project, score clarity on each dimension from 0.0 to 1.0. If the initial context or transcript was summarized for prompt safety, score from that summary plus the preserved round decisions/gaps; do not re-expand raw oversized context. Honor the locked Round 0 topology: score every active component independently and never drop confirmed sibling components just because one component is already clear.\n\nOriginal idea or prompt-safe initial-context summary: {idea_or_initial_context_summary}\n\nTranscript or prompt-safe transcript summary:\n{all rounds Q&A or summarized transcript}\n\nLocked topology:\n{state.topology.components and state.topology.deferrals}\n\nScore each active component on each dimension, then provide the overall dimension scores as the minimum or coverage-weighted weakest score across active components. Deferred components are excluded from ambiguity math but must remain listed in topology and the final spec.\n\nScore each dimension:\n1. Goal Clarity (0.0-1.0): Is the primary objective unambiguous? Can you state it in one sentence without qualifiers? Can you name the key entities (nouns) and their relationships (verbs) without ambiguity?\n2. Constraint Clarity (0.0-1.0): Are the boundaries, limitations, and non-goals clear?\n3. Success Criteria Clarity (0.0-1.0): Could you write a test that verifies success? Are acceptance criteria concrete?\n{4. Context Clarity (0.0-1.0): [brownfield only] Do we understand the existing system well enough to modify it safely? Do the identified entities map cleanly to existing codebase structures?}\n\nFor each dimension provide:\n- score: float (0.0-1.0)\n- justification: one sentence explaining the score\n- gap: what's still unclear (if score < 0.9)\n\nAlso identify:\n- weakest_component_id: the active component with the lowest clarity after applying rotation across components when N > 1\n- weakest_dimension: the single lowest-confidence dimension for that component this round\n- weakest_dimension_rationale: one sentence explaining why this component/dimension pair is the highest-leverage target for the next question\n- component_scores: object keyed by component id, with per-dimension scores and gaps\n\n5. Ontology Extraction: Identify all key entities (nouns) discussed in the transcript.\n\n{If round > 1, inject: \"Previous round's entities: {prior_entities_json from state.ontology_snapshots[-1]}. REUSE these entity names where the concept is the same. Only introduce new names for genuinely new concepts.\"}\n\nFor each entity provide:\n- name: string (the entity name, e.g., \"User\", \"Order\", \"PaymentMethod\")\n- type: string (e.g., \"core domain\", \"supporting\", \"external system\")\n- fields: string[] (key attributes mentioned)\n- relationships: string[] (e.g., \"User has many Orders\")\n\nRespond as JSON. Include an additional \"ontology\" key containing the entities array alongside the dimension scores.");
  expect(skill).toContain("Greenfield: ambiguity = 1 - (goal × 0.40 + constraints × 0.30 + criteria × 0.30)\nBrownfield: ambiguity = 1 - (goal × 0.35 + constraints × 0.25 + criteria × 0.25 + context × 0.15)\n\nRound 1 special case: For the first round, skip stability comparison. All entities are \"new\". Set stability_ratio = N/A. If any round produces zero entities, set stability_ratio = N/A (avoids division by zero).\n\nFor rounds 2+, compare with the previous round's entity list:\n- stable_entities: entities present in both rounds with the same name\n- changed_entities: entities with different names but the same type AND >50% field overlap (treated as renamed, not new+removed)\n- new_entities: entities in this round not matched by name or fuzzy-match to any previous entity\n- removed_entities: entities in the previous round not matched to any current entity\n- stability_ratio: (stable + changed) / total_entities (0.0 to 1.0, where 1.0 = fully converged)\n\nThis formula counts renamed entities (changed) toward stability. Renamed entities indicate the concept persists even if the name shifted — this is convergence, not instability. Two entities with different names but the same type and >50% field overlap should be classified as \"changed\" (renamed), not as one removed and one added.\n\nShow your work: Before reporting stability numbers, briefly list which entities were matched (by name or fuzzy) and which are new/removed. This lets the user sanity-check the matching.\n\nStore the ontology snapshot (entities + stability_ratio + matching_reasoning) in state.ontology_snapshots[].");
});
// T4 / blocks 14-16 and M1: OMC 5281b19e0d64f8e6dc6767f2130299a88af2dc71,
// blob bd1dfcee3a4bf28d76f0eefa4d706e0fa7189ba5, Phase 2 / Step 2d;
// OMX cb955b0d5becbef76d2c1f0096b6e1f238e1e7f7,
// blob a9f0242789f2f23c6ce6e3441f579602cd3d1c4a, Phase 2 / 2d;
// M1 is the approved host adaptation, not upstream source.
test("deep-interview source contract: scored-QA report and model ownership", async () => {
  const skill = await readFile(new URL("../skills/deep-interview/SKILL.md", import.meta.url), "utf8");
  expect(skill).not.toContain('kind === "requirement"');
  expect(skill).toContain("Show the full report only after an actual requirements answer has been scored, beginning with Round 1 in the model's rounds[] records. Substantive confirmations may be scored requirements Q&A; do not filter eligibility by the native question kind. Round 0 and unscored control, continuation, or closure acknowledgements retain their existing format, with no new N/A table or one-line status requirement. The host answer ledger provides evidence, not a separate policy round counter.");
  expect(skill).toContain("Round {n} complete.\n\n| Dimension | Score | Weight | Weighted | Gap |\n|-----------|-------|--------|----------|-----|\n| Goal | {s} | {w} | {s*w} | {gap or \"Clear\"} |\n| Constraints | {s} | {w} | {s*w} | {gap or \"Clear\"} |\n| Success Criteria | {s} | {w} | {s*w} | {gap or \"Clear\"} |\n| Context (brownfield) | {s} | {w} | {s*w} | {gap or \"Clear\"} |\n| **Ambiguity** | | | **{score}%** | |\n\n**Topology:** Targeted {target_component_name} | Active: {active_component_count} | Deferred: {deferred_component_count} | Next rotation after: {last_targeted_component_id}\n\n**Ontology:** {entity_count} entities | Stability: {stability_ratio} | New: {new} | Changed: {changed} | Stable: {stable}\n\n**Next target:** {target_component_name} / {weakest_dimension} — {weakest_dimension_rationale}\n\n{score <= threshold ? \"Clarity threshold met! Ready to proceed.\" : \"Focusing next question on: {weakest_dimension}\"}");
  expect(skill).toContain("Show weighted breakdown table, readiness-gate status (`Non-goals`, `Decision Boundaries`), and the next focus dimension.");
  expect(skill).toContain("**Non-goals:** {explicit|unresolved} — {evidence or remaining gap}\n**Decision Boundaries:** {explicit|unresolved} — {evidence or remaining gap}");
  expect(skill).toContain("The model owns rounds[] and the interview round policy. Initialize and preserve rounds[] in the complete model-owned snapshot. Record actual scored requirements Q&A in order, starting with Round 1. Ground each recorded answer in the actual native question result and preserve available evidence references. A substantive confirmation may be a scored requirements answer; do not include or exclude a round solely because next_question_kind or the native answer kind is \"requirement\" or \"confirmation\".\n\nRound 0 topology confirmation and unscored control, continuation, or closure acknowledgements keep their existing format and are not scored requirements rounds. Do not add a full report, N/A table, or one-line status requirement to them. Do not invent an answer, a scoring pass, or a round to fill a gap in history.\n\nUse the model's actual rounds[] records for the displayed ordinal, the tenth-round guidance, and the configured maximum-round policy. Read the effective ambiguityThreshold and maxRounds from the existing runtime configuration. After the tenth scored requirements answer, ask whether to continue only if further material work is needed and the configured maximum still permits it. Keep the existing Continue and Stop choices and their meanings. The maximum takes precedence, including maxima at or below ten; a cap is not a quota.\n\nThe host records real native answers, cancellation, pending requests, errors, permissions, and explicit recovery. It does not count policy rounds, enforce a tenth-round prompt, validate the model's round count, or derive rounds[] from answer kinds. Preserve the native answer evidence separately from the model transcript. A state_write snapshot cannot author _runtime or _meta.\n\nWhen the model determines that the configured maximum is reached, stop requirements questioning and use the existing deep_interview_spec tool with termination:\"limit-reached\" for a clearly partial artifact. The host checks lifecycle and storage safety, not the model's numeric round judgment. A failed save is not a saved receipt or terminal success; do not ask more requirements questions merely because storage failed. User Stop, cancellation, permission denial, and unresolved pending recovery still take precedence. Do not auto-resume to finish an artifact after Stop.\n\nOn resume or compaction, read the current state and real answer evidence, preserve the model's existing rounds[] and decisions, and reconcile only from available facts. An old host counter is not a substitute transcript and must not be used to fabricate missing rounds. Normal completion still requires the existing four closure conditions, effective threshold, current spec receipt, and unchanged final snapshot before completion_requested:true.");
});
// T5 / blocks 17-18: OMX cb955b0d5becbef76d2c1f0096b6e1f238e1e7f7,
// blob a9f0242789f2f23c6ce6e3441f579602cd3d1c4a, Phase 2 / 2c before the fixed 10% sentence;
// the closure-audit direction is the approved local clarification.
test("deep-interview source contract: complete four-condition closure blocks", async () => {
  const skill = await readFile(new URL("../skills/deep-interview/SKILL.md", import.meta.url), "utf8");
  expect(skill).not.toContain("If ambiguity is `<= 0.10`, another user-facing question is allowed only as that final closure question; otherwise crystallize immediately.");
  expect(skill).not.toContain("fifth readiness gate");
  expect(skill).not.toContain("Ask a final product-approval question");
  expect(skill).not.toContain("Round 4+: allow explicit early exit with risk warning");
  expect(skill).toContain("Readiness gate:\n- `Non-goals` must be explicit\n- `Decision Boundaries` must be explicit\n- A pressure pass must be complete: at least one earlier answer has been revisited with an evidence, assumption, or tradeoff follow-up\n- A practical closure audit must pass: another question would change execution materially, not merely polish wording or chase a narrow edge case\n- If either gate is unresolved, or the pressure pass is incomplete, continue below threshold only with a final closure question that names the unresolved gate and would materially change execution.\n- Treat a low ambiguity score as permission to audit closure, not permission to keep drilling indefinitely. If remaining uncertainty would not change implementation, crystallize the spec instead of opening a new branch.");
  expect(skill).toContain("The closure audit asks: \"Would another question materially change implementation?\" If yes, the audit has not passed; ask only the remaining material question while lifecycle and round limits permit it. If no, the audit passes; do not ask another question merely to polish wording or chase a narrow edge case. This clarifies the audit direction, not a new closure condition.\n\nKeep the existing four closure conditions: explicit Non-goals, explicit Decision Boundaries, a completed Pressure Pass, and a passed Closure Audit. Do not re-ask fulfilled conditions. Record the evidence and rationale rather than setting booleans merely to satisfy validation. The effective threshold comes from the existing runtime; there is no separate fixed 10% rule and no added final product-approval question.");
});
// T6 / block 19: OMC 5281b19e0d64f8e6dc6767f2130299a88af2dc71,
// blob bd1dfcee3a4bf28d76f0eefa4d706e0fa7189ba5, Phase 4 / Spec structure;
// OMX cb955b0d5becbef76d2c1f0096b6e1f238e1e7f7,
// blob a9f0242789f2f23c6ce6e3441f579602cd3d1c4a, Phase 4.
// Retained host boundaries use local baseline 5a64b97962d9e8f652e582af4a803b6f3d82f57c,
// blob d27d2ca8abd7637172dbc0c5f9fcb3a123d9be64: persistence, native questions,
// source labels/rhythm, challenge limits, Stop/recovery, and receipt completion.
test("deep-interview source contract: complete combined spec and preserved host contracts", async () => {
  const skill = await readFile(new URL("../skills/deep-interview/SKILL.md", import.meta.url), "utf8");
  expect(skill).toContain("`state_write` REPLACES the model-owned snapshot, rather than merging it. Start from the latest read, retain the model fields still needed, and submit the complete next model snapshot. Explicit tool arguments take precedence over the custom `state` object. Never submit `_runtime` or `_meta`: host records, question IDs, received answers, cancellation, and native answer evidence are not model-authored facts. Observe the tool's validation errors and correct the request instead of treating an error string as success.");
  expect(skill).toContain("Every user-facing interview question, including topology, confirmation, and closure questions, MUST call OpenCode's native `question` tool with exactly one item in `questions`. Do not substitute an assistant-prose question or a printed list of choices.");
  expect(skill).toContain("If the native tool is unavailable or denied, report the limitation and stop. Do not bypass permissions, invent another question transport, or count ordinary chat text as a native question reply.");
  expect(skill).toContain("The plugin never injects a continuation or corrective prompt on idle. While a native question is pending, wait for its real tool result; do not poll state or ask again.");
  expect(skill).toContain("| `[from-code][auto-confirmed]` | Exact, high-confidence descriptive facts from direct source/config evidence. Record context only; no question, pending obligation, or user-facing round increment. |\n| `[from-code]` | Inferred, pattern-based, or lower-confidence code finding. A confirmation-style user-facing round is needed before treating it as settled. |\n| `[from-research]` | Externally sourced facts such as API limits or official compatibility documentation. Facts are not decisions. |\n| `[from-user]` | Goals, preferences, business logic, scope, non-goals, acceptance criteria, tradeoffs, and decision-bearing interpretation. Ask the user rather than choosing on their behalf. |");
  expect(skill).toContain("These are DOCUMENT labels, not native question metadata, event types, or runtime `source` values. Do not put them in a question `source` field. The OMX-specific `source:\"deep-interview\"` CLI transport is not an OpenCode question schema and must not be invented here.");
  expect(skill).toContain("Track consecutive non-user discoveries and confirmation-style answers. After three in a row, the next material user-facing round must request direct human judgment, unless the closure audit already says the interview is ready to crystallize.");
  expect(skill).toContain("Use each applicable perspective at most once; record when and why it was used. Do not launch a panel or another specialist.\n\n- Contrarian: from round 2, or an untested assumption warrants it; challenge one assumption with a concrete alternative.\n- Simplifier: from round 4, or excess scope warrants it; test the smallest outcome without silently dropping requirements.\n- Ontologist: from round 5 when ambiguity remains above 25% or answers remain symptom-focused; question the underlying entities and framing.\n- Brownfield terminology check: reconcile conflicting terms in docs/code/user intent and record the explicit mapping/decision.");
  expect(skill).toContain("For the continuation control, use single-select options with stable labels `Continue` and `Stop`, with descriptions in the user's language. The host recognizes explicit affirmative/negative selections; free text that does not clearly match is left interrupted for clarification, never assumed to approve continuation. `Stop` records cancellation.");
  expect(skill).toContain("Save using `deep_interview_spec({markdown,termination:\"normal\"|\"cancelled\"|\"limit-reached\"})`. Normal completion requires current structural closure/score records and the actual current spec receipt. Do not mark completed before storage succeeds.");
  expect(skill).toContain("# Deep Interview Spec: {title}\n\n## Metadata\n- Interview ID: {actual recorded interview or current-session identifier; not recorded if absent}\n- Rounds: {actual scored requirements Q&A count recorded by the model in rounds[], grounded in real native answer evidence; not a host counter or question-kind filter}\n- Final Ambiguity Score: {actual latest score}% {or not scored yet}\n- Type: greenfield | brownfield\n- Generated: {actual timestamp}\n- Threshold: {effective runtime threshold}\n- Threshold Source: {recorded source or not recorded}\n- Initial Context Summarized: {yes|no; based on actual record}\n- Status: {normal|cancelled|limit-reached; actual host/tool termination}\n- Completeness: {complete|partial; supported by actual evidence}\n- Maximum Rounds: {effective runtime maximum}\n\n## Context and Prompt-safe Initial Summary\n{Existing context/source references with file/symbol/record locations. Do not invent an OMX-style context file or create a new storage path.}\n{Prompt-safe initial-context summary when needed, preserving intent, decisions, constraints, success criteria, non-goals, boundaries, unknowns, and full-source references. Otherwise state that summarization was not needed.}\n\n## Clarity Breakdown\n| Dimension | Score | Weight | Weighted |\n|-----------|-------|--------|----------|\n| Goal Clarity | {s} | {w} | {s*w} |\n| Constraint Clarity | {s} | {w} | {s*w} |\n| Success Criteria | {s} | {w} | {s*w} |\n| Context Clarity | {s or N/A} | {w or N/A} | {s*w or N/A} |\n| **Total Clarity** | | | **{total or not scored yet}** |\n| **Ambiguity** | | | **{1-total or not scored yet}** |\n\n## Topology\n{List every Round 0 confirmed top-level component. Active components must have coverage notes; deferred components must include the user-confirmed deferral reason and timestamp.}\n{If topology was never confirmed, say so. Proposed components must not be presented as confirmed.}\n\n| Component | Status | Description | Coverage / Deferral Note |\n|-----------|--------|-------------|--------------------------|\n| {component.name} | {active|deferred} | {component.description} | {covered acceptance criteria or user-confirmed deferral reason and timestamp} |\n\n## Goal\n{crystal-clear goal statement derived from interview, covering every active topology component}\n\n## Intent\n{why the user wants this; preserve the user's stated reason and distinguish unconfirmed hypotheses}\n\n## Desired Outcome\n{what end state the user wants; do not substitute implementation tasks for outcomes}\n\n## In-Scope\n{explicitly included scope and its relationship to the confirmed topology}\n\n## Constraints\n- {constraint 1}\n- {constraint 2}\n- ...\n\n## Non-Goals\n- {explicitly excluded scope 1}\n- {explicitly excluded scope 2}\n{State unresolved exclusions honestly. Absence of a recorded answer is not explicit agreement.}\n\n## Decision Boundaries\n{what the agent may decide without confirmation, what remains user-owned, and any unresolved boundary with supporting answer/evidence}\n\n## Acceptance Criteria\n- [ ] {testable criterion 1}\n- [ ] {testable criterion 2}\n- [ ] {testable criterion 3}\n- ...\n\n## Decisions and Evidence\n{Preserve actual decisions and their source labels: [from-user], [from-code][auto-confirmed], [from-code], [from-research]. Descriptive facts and inference are not user decisions.}\n\n## Assumptions Exposed & Resolved\n| Assumption | Challenge | Resolution |\n|------------|-----------|------------|\n| {assumption} | {how it was questioned} | {what was decided or remains unresolved} |\n\n## Pressure-pass Findings\n{which earlier answer was revisited, the evidence/assumption/tradeoff follow-up, the actual user answer, and what changed or was confirmed}\n{If incomplete, record the missing pressure pass rather than claiming it occurred.}\n\n## Closure Audit\n- Non-goals: {explicit|unresolved} — {evidence/gap}\n- Decision Boundaries: {explicit|unresolved} — {evidence/gap}\n- Pressure Pass: {complete|incomplete} — {findings reference}\n- Closure Audit: {passed|not passed} — {whether another question would materially change implementation, and why}\n{No additional final approval gate. Record unresolved conditions at cancellation or the cap.}\n\n## Brownfield Evidence vs Inference\n{repository-grounded confirmation questions with exact source references, code/doc findings, inference, and the user's decision; not applicable for greenfield}\n\n## Docs/Terminology Ledger\n- Inspected repo docs/rules/context: {paths and relevant findings}\n- Canonical repo terms: {terms and source references}\n- Terms to avoid or disambiguate: {terms and ambiguity}\n- User terms conflicting with docs/code: {conflicting meanings and actual decisions or unresolved status}\n- Doc/code mismatches: {both sources, confirmation, and governing decision or unresolved status}\n- Optional durable-doc follow-ups: {safe proposals only; opt-in status}\n\n## Scenario/Edge-case Pressure Findings\n{concrete boundary/relationship/handoff scenario, focused question, actual answer, and material effect on scope or acceptance criteria; record not used when no such finding exists}\n\n## Optional Durable Documentation Recommendations\n{Opt-in and public-safe recommendations only. No automatic docs/glossary/ADR/memory updates and no raw private transcript dumps. Record none when there is no recommendation.}\n\n## Technical Context\n{brownfield: relevant codebase findings from the owned open-gajae-explore agent or permitted read-only inspection}\n{greenfield: technology choices and constraints; distinguish confirmed choices from assumptions}\n\n## Ontology (Key Entities)\n{Fill from the FINAL round's ontology extraction, not just crystallization-time generation}\n{Show matching_reasoning before stability counts: named matches, renamed matches, and unmatched new/removed entities. Do not invent an ontology if no scoring round occurred.}\n\n| Entity | Type | Fields | Relationships |\n|--------|------|--------|---------------|\n| {entity.name} | {entity.type} | {entity.fields} | {entity.relationships} |\n\n## Ontology Convergence\n{Show how entities stabilized across interview rounds using data from ontology_snapshots in state}\n\n| Round | Entity Count | New | Changed | Stable | Stability Ratio |\n|-------|-------------|-----|---------|--------|----------------|\n| 1 | {n} | {n} | - | - | - |\n| 2 | {n} | {new} | {changed} | {stable} | {ratio}% |\n| ... | ... | ... | ... | ... | ... |\n| {final} | {n} | {new} | {changed} | {stable} | {ratio}% |\n\n{Round 1 and zero-entity rounds have N/A stability. The first-row dash represents N/A, not zero. A rename is changed, not both removed and new.}\n\n## Unresolved Questions and Residual Risks\n{assumptions, missing answers, incomplete topology/coverage/closure, evidence limitations, and residual risk from cancellation or the round limit; do not silently shrink scope}\n\n## Interview Transcript\n<details>\n<summary>Full or condensed Q&A ({n} actual requirements rounds)</summary>\n\n### Round 1\n**Q:** {actual question}\n**A:** {actual answer}\n**Source:** {actual transcript/spec labels and citations}\n**Ambiguity:** {score}% (Goal: {g}, Constraints: {c}, Criteria: {cr}{, Context: {ctx} for brownfield})\n\n{Repeat actual rounds only. Preserve actual control confirmations separately without counting them as requirements answers. Condense oversized history without losing decisions/gaps/ontology changes.}\n</details>\n\n## Termination Reason\n{actual normal|cancelled|limit-reached reason, missing evidence when partial, and latest actual state; no invented receipt or automatic resume}\n\n## Separate Implementation Boundary and Verification Limits\n{This interview/spec is requirements clarification, not implementation approval. Implementation requires a separate user request; this product does not expose downstream execution/planning skills. Do not ask for an added final product approval or advertise unavailable callable workflows.}\n{Record checks actually performed and their limits. Do not claim actual OpenCode scenario validation from a source-contract test.}");
});
