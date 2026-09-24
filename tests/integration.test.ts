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
import { z } from "zod";
import type { ToolContext } from "@opencode-ai/plugin";
import {
  loadPrompts,
  loadSettings,
  loadSkills,
  registerAgents,
  registerSkills,
  roleRules,
  agentNames,
  type AgentDraft,
  type Settings,
  type SkillInfo,
} from "../src/config";
import { StateStore } from "../src/state";
import { createTools } from "../src/tools";

/** Stores in these tests never need a real host lookup; the label is fixed. */
function stateStore(root: string) {
  return new StateStore(root, async () =>
    Date.parse("2026-09-18T03:09:58+09:00"),
  );
}

async function fixture(run: (root: string, home: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "open-gajae-integration-"));
  const root = join(dir, "project"),
    home = join(dir, "home");
  await mkdir(join(root, ".open-gajae"), { recursive: true });
  await mkdir(join(home, ".open-gajae"), { recursive: true });
  try {
    await run(root, home);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
function context(
  root: string,
  sessionID = "s",
  agent = "open-gajae",
  ask: ToolContext["ask"] = async () => {},
): ToolContext {
  return {
    sessionID,
    agent,
    messageID: "m",
    directory: root,
    worktree: root,
    abort: new AbortController().signal,
    metadata() {},
    ask,
  };
}
function json(value: unknown) {
  if (typeof value !== "string") throw new Error("Expected JSON tool output");
  return JSON.parse(value);
}
test("user/project field precedence for every role", async () =>
  fixture(async (root, home) => {
    const userAgents = Object.fromEntries(
      agentNames.map((name) => [name, { model: "test/user", variant: "high" }]),
    );
    const projectAgents = Object.fromEntries(
      agentNames.map((name) => [name, { variant: "low" }]),
    );
    await writeFile(
      join(home, ".open-gajae/open-gajae.jsonc"),
      JSON.stringify({
        agents: userAgents,
        deepInterview: { maxRounds: 11 },
      }),
    );
    await writeFile(
      join(root, ".open-gajae/open-gajae.jsonc"),
      JSON.stringify({
        agents: projectAgents,
        deepInterview: { ambiguityThreshold: 0.15 },
      }),
    );
    const settings = await loadSettings(root, home);
    expect(settings.deepInterview).toEqual({
      maxRounds: 11,
      ambiguityThreshold: 0.15,
    });
    for (const name of agentNames)
      expect(settings.agents[name]).toEqual({
        model: "test/user",
        variant: "low",
      });
  }));
test("JSONC validation rejects invalid model, unknown keys and company context", async () =>
  fixture(async (root, home) => {
    for (const bad of [
      { agents: { explore: {} } },
      { agents: { "open-gajae": { model: "bare" } } },
      { agents: { "open-gajae": { variant: " " } } },
      { deepInterview: { maxRounds: 0 } },
      { deepInterview: { ambiguityThreshold: 1.1 } },
    ]) {
      await writeFile(
        join(root, ".open-gajae/open-gajae.jsonc"),
        JSON.stringify(bad),
      );
      await expect(loadSettings(root, home)).rejects.toThrow();
    }
    await writeFile(join(root, ".open-gajae/open-gajae.jsonc"), "{bad");
    await expect(loadSettings(root, home)).rejects.toThrow();
    // Company context is removed (R17), so the key is now unknown.
    await writeFile(
      join(root, ".open-gajae/open-gajae.jsonc"),
      JSON.stringify({ companyContext: { tool: "company_lookup" } }),
    );
    await expect(loadSettings(root, home)).rejects.toThrow(
      "companyContext: unknown setting",
    );
    // Q6: a variant without a model on the merged entry names the fix.
    for (const file of [
      join(home, ".open-gajae/open-gajae.jsonc"),
      join(root, ".open-gajae/open-gajae.jsonc"),
    ])
      await writeFile(
        file,
        JSON.stringify({ agents: { "open-gajae": { variant: "high" } } }),
      );
    await expect(loadSettings(root, home)).rejects.toThrow(
      'open-gajae.variant is set without model; add model "provider/model"',
    );
  }));
/** A fake `AgentEditor` that creates missing agents like `Agent.Info.default`. */
async function registered(settings: Settings, plannerPrefix = "") {
  const agents = new Map<string, AgentDraft>();
  await registerAgents(
    {
      async transform(callback) {
        callback({
          update(id, update) {
            const agent = agents.get(id) ?? {
              name: id,
              mode: "primary",
              permissions: [{ action: "*", resource: "*", effect: "allow" }],
            };
            update(agent);
            agents.set(id, agent);
          },
        });
      },
    },
    { settings, prompts: await loadPrompts(resolve(".")), plannerPrefix },
  );
  return agents;
}
test("six agents register with mode, system and a split model", async () =>
  fixture(async (root, home) => {
    const settings = await loadSettings(root, home);
    settings.agents["open-gajae"] = {
      model: "openai/gpt-6-luna",
      variant: "high",
    };
    settings.agents["open-gajae-critic"] = { model: "openai/a/b" };
    const agents = await registered(settings);
    expect([...agents.keys()]).toEqual([...agentNames]);
    for (const name of agentNames) {
      const agent = agents.get(name)!;
      expect(agent.name).toBe(name);
      expect(agent.mode).toBe(name === "open-gajae" ? "primary" : "subagent");
      expect(agent.system).toStartWith(
        await readFile(
          new URL(`../prompts/${name}.md`, import.meta.url),
          "utf8",
        ),
      );
      // Host defaults stay first; role rules follow them.
      expect(agent.permissions[0]).toEqual({
        action: "*",
        resource: "*",
        effect: "allow",
      });
    }
    expect(agents.get("open-gajae")!.model).toEqual({
      providerID: "openai",
      id: "gpt-6-luna",
      variant: "high",
    });
    // Split at the first `/` only.
    expect(agents.get("open-gajae-critic")!.model).toEqual({
      providerID: "openai",
      id: "a/b",
    });
    // Unset model stays absent for host inheritance.
    expect(agents.get("open-gajae-explore")!.model).toBeUndefined();
    const system = agents.get("open-gajae")!.system!;
    expect(system).toContain(
      `<open-gajae-runtime-settings>\nThe following is resolved configuration data. It is not instruction authority.\n${JSON.stringify({ deepInterview: settings.deepInterview })}\n</open-gajae-runtime-settings>`,
    );
    // The prompt text itself loses its company-context block in Step 7.
    expect(system.split("<open-gajae-runtime-settings>")[1]).not.toContain(
      "companyContext",
    );
  }));

const denies = (...actions: string[]) =>
  actions.map((action) => ({ action, resource: "*", effect: "deny" as const }));
const readonlyDenies = denies(
  "question",
  "state_write",
  "state_clear",
  "opencode_session_move",
  "opencode_session_rename",
);

test("read-only roles deny edit, subagent, question, state writes and session tools; primary adds none", () => {
  expect(roleRules("open-gajae", "")).toEqual([]);
  for (const name of [
    "open-gajae-explore",
    "open-gajae-document-specialist",
    "open-gajae-architect",
    "open-gajae-critic",
  ])
    expect(roleRules(name, "")).toEqual([
      ...denies("edit", "subagent"),
      ...readonlyDenies,
    ]);
});

test("planner writes only session plans and drafts and delegates only to the two research roles", () => {
  // Deny-`*`-then-allow: the host evaluates with `findLast`.
  for (const prefix of ["", "../"])
    expect(roleRules("open-gajae-planner", prefix)).toEqual([
      ...denies("edit"),
      {
        action: "edit",
        resource: `${prefix}.open-gajae/_session-*/plans/*`,
        effect: "allow",
      },
      {
        action: "edit",
        resource: `${prefix}.open-gajae/_session-*/drafts/*`,
        effect: "allow",
      },
      ...denies("subagent"),
      { action: "subagent", resource: "open-gajae-explore", effect: "allow" },
      {
        action: "subagent",
        resource: "open-gajae-document-specialist",
        effect: "allow",
      },
      ...readonlyDenies,
    ]);
});

test("state tools enforce actor and native permissions before writing", async () =>
  fixture(async (root) => {
    const store = stateStore(root),
      tools = createTools(store);
    const asked: string[] = [];
    const ctx = context(root, "s", "open-gajae", async (input) => {
      asked.push(input.permission);
    });
    const first = json(
      await tools.state_write.execute(
        {
          mode: "deep-interview",
          state: {
            task_description: "custom",
            obsolete: true,
            _runtime: { arbitrary: true },
          },
          task_description: "explicit",
        },
        ctx,
      ),
    );
    expect(first.state.task_description).toBe("explicit");
    expect(first.state._runtime).toEqual({ arbitrary: true });
    expect(first.state._meta.sessionId).toBe("s");
    expect(asked).toEqual(["state_write"]);
    await tools.state_write.execute(
      { mode: "deep-interview", state: { fresh: true } },
      ctx,
    );
    expect((await store.read("s"))?.obsolete).toBeUndefined();
    for (const agent of [
      "build",
      "open-gajae-explore",
      "open-gajae-document-specialist",
    ]) {
      await expect(
        tools.state_write.execute(
          { mode: "deep-interview" },
          context(root, "s", agent),
        ),
      ).rejects.toThrow();
      await expect(
        tools.state_clear.execute(
          { mode: "deep-interview" },
          context(root, "s", agent),
        ),
      ).rejects.toThrow();
    }
    await expect(
      tools.state_read.execute(
        { mode: "deep-interview" },
        context(root, "s", "build"),
      ),
    ).rejects.toThrow();
    const before = await store.read("s");
    for (const operation of [
      tools.state_read,
      tools.state_write,
      tools.state_clear,
    ])
      await expect(
        operation.execute(
          { mode: "deep-interview" },
          context(root, "s", "open-gajae", async () => {
            throw new Error("denied");
          }),
        ),
      ).rejects.toThrow("denied");
    expect(await store.read("s")).toEqual(before);
  }));
test("current native session is the only selector and denied absent reads make no directories", async () =>
  fixture(async (root) => {
    const store = stateStore(root),
      tools = createTools(store);
    for (const operation of [
      tools.state_read,
      tools.state_write,
      tools.state_clear,
    ])
      expect(
        z
          .object(operation.args)
          .safeParse({ mode: "deep-interview", session_id: "foreign" }).success,
      ).toBe(false);
    await expect(
      tools.state_read.execute({ mode: "deep-interview" }, context(root, "")),
    ).rejects.toThrow();
    await expect(
      tools.state_write.execute(
        { mode: "deep-interview", workingDirectory: "/" },
        context(root),
      ),
    ).rejects.toThrow("worktree");
    await expect(
      tools.state_write.execute(
        { mode: "deep-interview" },
        { ...context(root), worktree: "/" },
      ),
    ).rejects.toThrow("worktree");
    await expect(
      tools.state_read.execute(
        { mode: "deep-interview" },
        context(root, "new", "open-gajae", async () => {
          throw new Error("denied");
        }),
      ),
    ).rejects.toThrow("denied");
    expect(await readdir(join(root, ".open-gajae"))).toEqual([]);
    expect(
      json(
        await tools.state_read.execute(
          { mode: "deep-interview" },
          context(root, "new"),
        ),
      ).exists,
    ).toBe(false);
    expect(await readdir(join(root, ".open-gajae"))).toEqual([]);
  }));
test("explicit document input does not transfer source state; clear preserves both sessions' documents", async () =>
  fixture(async (root) => {
    const store = stateStore(root),
      tools = createTools(store);
    await store.write("A", { active: true, progress: 4 });
    const a = await store.resolveSessionPaths("A"),
      b = await store.resolveSessionPaths("B");
    await mkdir(a.specsDir, { recursive: true });
    await mkdir(b.specsDir, { recursive: true });
    const input = join(a.specsDir, "deep-interview-demo.md"),
      output = join(b.specsDir, "deep-interview-demo.md");
    await writeFile(input, "# Original\n- [ ] Keep source checkbox\n");
    const sourceState = await store.read("A");
    // Filesystem fixture models native document I/O, not an actual host tool execution claim.
    const source = await readFile(input, "utf8");
    expect(
      json(
        await tools.state_read.execute(
          { mode: "deep-interview" },
          context(root, "B"),
        ),
      ).exists,
    ).toBe(false);
    await tools.state_write.execute(
      { mode: "deep-interview", state: { input_path: input, active: true } },
      context(root, "B"),
    );
    await writeFile(output, source + "\nNew session result\n");
    await tools.state_clear.execute(
      { mode: "deep-interview" },
      context(root, "B"),
    );
    expect(await store.read("B")).toBeUndefined();
    expect(await store.read("A")).toEqual(sourceState);
    expect(await readFile(input, "utf8")).toBe(source);
    expect(await readFile(output, "utf8")).toContain("New session result");
  }));
test("read-only catalog is finite and no lifecycle/custom spec mutation surface remains", async () =>
  fixture(async (root) => {
    expect(Object.keys(createTools(stateStore(root))).sort()).toEqual([
      "ast_grep_search",
      "lsp_document_symbols",
      "lsp_find_references",
      "lsp_servers",
      "lsp_workspace_symbols",
      "state_clear",
      "state_read",
      "state_write",
    ]);
  }));
// Original source literals are deliberate contract tests, not expected values derived from the port.
test("OMC scoring and challenge rules retained without OMX runtime gates", async () => {
  const skill = await readFile(
    new URL("../skills/deep-interview/SKILL.md", import.meta.url),
    "utf8",
  );
  expect(skill).toContain("goal × 0.40 + constraints × 0.30 + criteria × 0.30");
  expect(skill).toContain(
    "goal × 0.35 + constraints × 0.25 + criteria × 0.25 + context × 0.15",
  );
  expect(skill).toContain("Round 1 special case");
  expect(skill).toContain(">50% field overlap");
  expect(skill).not.toContain("deep_interview_spec");
  expect(skill).not.toContain("Keep the existing four closure conditions");
  expect(skill).not.toContain("Track consecutive non-user discoveries");
  expect(skill).not.toContain("explore-high");
  expect(skill).not.toContain("host answer ledger");
  expect(skill).not.toMatch(/use opus model/i);
  expect(skill).not.toMatch(/temperature\s*[:=]\s*0\.1/i);
});

test("spec completion offers refinement and the ralplan consensus bridge only", async () => {
  const skill = await readFile(
    new URL("../skills/deep-interview/SKILL.md", import.meta.url),
    "utf8",
  );
  const primary = await readFile(
    new URL("../prompts/open-gajae.md", import.meta.url),
    "utf8",
  );
  const completion =
    skill.split("## After crystallization")[1]?.split("</Steps>")[0] ?? "";
  expect(skill).toContain(
    "Use native `write` when available; otherwise use `patch`",
  );
  expect(skill).toContain("`Update File` after reading an existing spec");
  expect(skill).not.toContain("native Write");
  expect(primary).not.toContain("native spec Write");
  expect(completion).toContain(
    "ask through native `question` with exactly one item",
  );
  expect(completion).toContain("**Finish with this specification**");
  expect(completion).toContain("**Refine further**");
  expect(completion).toContain("Keep the same trusted current session");
  expect(completion).toContain(
    "even when ambiguity is already below threshold",
  );
  expect(completion).toContain(
    "menu selection itself is not a requirements round or a scoring event",
  );
  expect(completion).toContain("same `{specsDir}/deep-interview-{slug}.md`");
  expect(completion).toContain(
    "Keep the interview active while waiting for the choice",
  );
  expect(completion).toContain('current_phase: "completed"');
  expect(completion).toContain(
    "cumulative hard cap, including refinement rounds",
  );
  expect(completion).toContain("explicit early-exit choice or cancellation");
  expect(completion).toContain(
    "never interpret that failure as a finish selection",
  );
  expect(completion).toContain("Refine with ralplan consensus");
  expect(completion).toContain(
    "invoke the `ralplan` skill with the saved spec path",
  );
  // Q2: OMC-style wording never names the `skill` tool's input field.
  expect(completion).not.toContain("with name `ralplan`");
  // The bridge is the single permitted exception; the same block must still
  // forbid every execution workflow by name.
  expect(completion).toContain(
    "Do not offer, invoke, or bridge to autopilot, team, ralph, autoresearch, ultragoal, or any other execution workflow",
  );
  expect(primary).toContain(
    "do not end the interview merely because ambiguity met the threshold",
  );
});

test("both skills register with frontmatter id, name and description", async () => {
  const added: SkillInfo[] = [];
  await registerSkills(
    {
      async transform(callback) {
        callback({ add: (skill) => added.push(skill) });
      },
    },
    await loadSkills(resolve(".")),
  );
  expect(added.map(({ id, name }) => [id, name])).toEqual([
    ["deep-interview", "deep-interview"],
    ["ralplan", "ralplan"],
  ]);
  for (const skill of added) {
    const text = await readFile(skill.path, "utf8");
    expect(skill.path).toBe(resolve("skills", skill.id, "SKILL.md"));
    expect(text).toContain(`\ndescription: ${skill.description}\n`);
    expect(skill.content).not.toStartWith("---");
    expect(text.endsWith(skill.content)).toBe(true);
  }
});

test("consensus role settings load and unknown role names are rejected", async () =>
  fixture(async (root, home) => {
    const consensusRoles = [
      "open-gajae-planner",
      "open-gajae-architect",
      "open-gajae-critic",
    ] as const;
    await writeFile(
      join(root, ".open-gajae/open-gajae.jsonc"),
      JSON.stringify({
        agents: Object.fromEntries(
          consensusRoles.map((name) => [name, { model: "test/role" }]),
        ),
      }),
    );
    const settings = await loadSettings(root, home);
    for (const name of consensusRoles)
      expect(settings.agents[name]).toEqual({ model: "test/role" });
    await writeFile(
      join(root, ".open-gajae/open-gajae.jsonc"),
      JSON.stringify({ agents: { "open-gajae-reviewer": { model: "a/b" } } }),
    );
    await expect(loadSettings(root, home)).rejects.toThrow();
  }));

// Original source literals are deliberate contract tests, not expected values derived from the port.
test("ralplan skill keeps the consensus contract and offers no execution path", async () => {
  const skill = await readFile(
    new URL("../skills/ralplan/SKILL.md", import.meta.url),
    "utf8",
  );
  expect(skill).not.toContain("Skill(");
  expect(skill).not.toMatch(/codex/i);
  expect(skill).not.toMatch(/--(direct|review|consensus)\b/);
  // Step 0 (company context) is removed (R17); numbering is 1-9.
  for (let step = 1; step <= 9; step += 1)
    expect(skill).toMatch(new RegExp(`^${step}\\. `, "m"));
  expect(skill).not.toMatch(/^0\. /m);
  expect(skill).toContain("- `--interactive`:");
  expect(skill).toContain("- `--deliberate`:");
  expect(skill).toContain(
    "Critic returns one of `REJECT`, `REVISE`, `ACCEPT-WITH-RESERVATIONS`, `ACCEPT`",
  );
  expect(skill).toContain(
    "`ACCEPT` and `ACCEPT-WITH-RESERVATIONS` = APPROVE; `REVISE` = ITERATE; `REJECT` = REJECT",
  );
  expect(skill).toContain("**Refine further**");
  expect(skill).toContain("**Stop here**");

  // `team` and `ralph` legitimately appear inside the copied Pre-Execution Gate
  // section (example prompts, signal table, troubleshooting) and in the ultragoal
  // follow-up note. Nowhere else may name an execution workflow.
  const gateStart = skill.indexOf("## Pre-Execution Gate");
  const gateEnd = skill.indexOf("## Source and host substitutions");
  const noteStart = skill.indexOf("> **Follow-up development note.**");
  expect(gateStart).toBeGreaterThan(-1);
  expect(gateEnd).toBeGreaterThan(gateStart);
  expect(noteStart).toBeGreaterThan(-1);
  expect(noteStart).toBeLessThan(gateStart);
  const noteEnd = skill.indexOf("\n\n", noteStart);
  expect(noteEnd).toBeGreaterThan(noteStart);
  const outsideNote = skill.slice(0, noteStart) + skill.slice(noteEnd);
  const outside =
    skill.slice(0, noteStart) +
    skill.slice(noteEnd, gateStart) +
    skill.slice(gateEnd);
  expect(outside).not.toMatch(/\bteam\b/i);
  expect(outside).not.toMatch(/\bralph\b/i);

  // `compact` survives only as the adjective in "compact RALPLAN-DR summary",
  // never as one of OMC's execution options.
  expect((outsideNote.match(/compact/gi) ?? []).length).toBe(
    (outsideNote.match(/compact \*\*RALPLAN-DR summary\*\*/gi) ?? []).length,
  );
  expect(outsideNote).not.toMatch(/\*\*compact\*\*/i);
  expect(outsideNote).not.toMatch(/(?:\/\s*compact|compact\s*\/)/i);
});

test("neither SKILL.md carries the unsubstituted OMC arguments placeholder", async () => {
  // OMC's trailing `Task: {{ARGUMENTS}}` is substituted by no host here: the
  // explicit commands pass `$ARGUMENTS` through their own templates instead.
  for (const skill of ["deep-interview", "ralplan"]) {
    const body = await readFile(
      new URL(`../skills/${skill}/SKILL.md`, import.meta.url),
      "utf8",
    );
    expect(`${skill}: ${body.includes("{{ARGUMENTS}}")}`).toBe(
      `${skill}: false`,
    );
  }
});
