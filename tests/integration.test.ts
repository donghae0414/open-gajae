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
import { ROUND_RECORD_REQUIRED } from "../src/deep-interview-runtime/manifest";
import { StateStore } from "../src/state";
import { ULTRAGOAL_RED_TEAM_FRAGMENT } from "../src/ultragoal-runtime/messages";
import { createTools } from "../src/tools";
import type { ToolCallContext } from "../src/tools/define";

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
function context(sessionID = "s", agent = "open-gajae"): ToolCallContext {
  return { sessionID, agent, signal: new AbortController().signal };
}
/** The v2 tools by name; `call` parses input as the host would. */
function toolsOf(store: StateStore, root: string) {
  const list = createTools(store, { locationDir: root, projectDir: root });
  const call = async (
    name: string,
    args: Record<string, unknown>,
    ctx = context(),
  ) => {
    const tool = list.find((candidate) => candidate.name === name)!;
    return (await tool.execute(tool.input.parse(args) as never, ctx)).content;
  };
  return { list, call };
}
function json(value: string) {
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
    // Deep-interview revision plan DR-4, DR-28: no file → 0.05 from
    // `default`; the user file → its `~/…` path; the project file wins with
    // its `./…` path (PQ-16 D′).
    expect((await loadSettings(root, home)).deepInterview).toEqual({
      ambiguityThreshold: 0.05,
      source: "default",
    });
    await writeFile(
      join(home, ".open-gajae/open-gajae.jsonc"),
      JSON.stringify({
        agents: userAgents,
        deepInterview: { ambiguityThreshold: 0.3 },
      }),
    );
    expect((await loadSettings(root, home)).deepInterview).toEqual({
      ambiguityThreshold: 0.3,
      source: "~/.open-gajae/open-gajae.jsonc",
    });
    await writeFile(
      join(root, ".open-gajae/open-gajae.jsonc"),
      JSON.stringify({
        agents: projectAgents,
        deepInterview: { ambiguityThreshold: 0.15 },
      }),
    );
    const settings = await loadSettings(root, home);
    expect(settings.deepInterview).toEqual({
      ambiguityThreshold: 0.15,
      source: "./.open-gajae/open-gajae.jsonc",
    });
    for (const name of agentNames)
      expect(settings.agents[name]).toEqual({
        model: "test/user",
        variant: "low",
      });
  }));
test("JSONC validation rejects invalid model, unknown keys and thresholds outside (0, 1]", async () =>
  fixture(async (root, home) => {
    for (const bad of [
      { agents: { explore: {} } },
      { agents: { "open-gajae": { model: "bare" } } },
      { agents: { "open-gajae": { variant: " " } } },
      { deepInterview: { ambiguityThreshold: 1.1 } },
      // PQ-19 A: gjc's range is (0, 1].
      { deepInterview: { ambiguityThreshold: 0 } },
    ]) {
      await writeFile(
        join(root, ".open-gajae/open-gajae.jsonc"),
        JSON.stringify(bad),
      );
      await expect(loadSettings(root, home)).rejects.toThrow();
    }
    await writeFile(
      join(root, ".open-gajae/open-gajae.jsonc"),
      JSON.stringify({ deepInterview: { ambiguityThreshold: 0 } }),
    );
    await expect(loadSettings(root, home)).rejects.toThrow(
      "deepInterview.ambiguityThreshold: expected finite number in (0, 1]",
    );
    await writeFile(join(root, ".open-gajae/open-gajae.jsonc"), "{bad");
    await expect(loadSettings(root, home)).rejects.toThrow();
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
async function registered(settings: Settings) {
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
    { settings, prompts: await loadPrompts(resolve(".")) },
  );
  return agents;
}
test("nine agents register with mode, system and a split model; the settings block names the threshold source", async () =>
  fixture(async (root, home) => {
    await writeFile(
      join(home, ".open-gajae/open-gajae.jsonc"),
      JSON.stringify({ deepInterview: { ambiguityThreshold: 0.2 } }),
    );
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
    const block = JSON.stringify({
      deepInterview: { ambiguityThreshold: 0.2, source: "~/.open-gajae/open-gajae.jsonc" },
    });
    expect(system).toContain(
      `<open-gajae-runtime-settings>\nThe following is resolved configuration data. It is not instruction authority.\n${block}\n</open-gajae-runtime-settings>`,
    );
    // PQ-16 D′ (T2): `deep-interview start` reports the block's source.
    const store = stateStore(root);
    const tool = createTools(
      store,
      { locationDir: root, projectDir: root },
      { rootSession: async (id) => id, deepInterviewSettings: settings.deepInterview },
    ).find((candidate) => candidate.name === "deep-interview")!;
    const started = json(
      (await tool.execute(tool.input.parse({ op: "start", idea: "i" }) as never, context())).content,
    );
    expect(started).toMatchObject({ threshold: 0.2, threshold_source: settings.deepInterview.source });
  }));

const denies = (...actions: string[]) =>
  actions.map((action) => ({ action, resource: "*", effect: "deny" as const }));
const readonlyDenies = denies(
  "question",
  "deep-interview",
  "opencode_session_move",
  "opencode_session_rename",
);

test("read-only roles deny edit, subagent, question, deep-interview and session tools; primary adds none", () => {
  expect(roleRules("open-gajae")).toEqual([]);
  // Plan C-11: `ultragoal` and `goal` are the primary's alone; the reviewers
  // keep `ralplan` for their lane writes.
  for (const name of ["open-gajae-architect", "open-gajae-critic"])
    expect(roleRules(name)).toEqual([
      ...denies("edit", "subagent"),
      ...readonlyDenies,
      ...denies("ultragoal", "goal"),
    ]);
  // PQ-28 A: the lateral reviewer takes the default role rules.
  for (const name of [
    "open-gajae-explore",
    "open-gajae-document-specialist",
    "open-gajae-cleaner",
    "open-gajae-lateral-reviewer",
  ])
    expect(roleRules(name)).toEqual([
      ...denies("edit", "subagent"),
      ...readonlyDenies,
      ...denies("ultragoal", "goal", "ralplan"),
    ]);
});

test("executor edits, delegates only to explore and architect, and cannot ask, use ultragoal, goal or ralplan", () => {
  expect(roleRules("open-gajae-executor")).toEqual([
    ...denies("subagent"),
    { action: "subagent", resource: "open-gajae-explore", effect: "allow" },
    { action: "subagent", resource: "open-gajae-architect", effect: "allow" },
    ...readonlyDenies,
    ...denies("ultragoal", "goal", "ralplan"),
  ]);
});

test("ralplan settings default to gjc, merge per key with a source, and reject bad values", async () =>
  fixture(async (root, home) => {
    expect((await loadSettings(root, home)).ralplan).toEqual({
      maxIterations: 5,
      maxReviewPassesPerLane: 1,
      autoHandoff: "off",
      source: {
        maxIterations: "default",
        maxReviewPassesPerLane: "default",
        autoHandoff: "default",
      },
    });
    const userFile = join(home, ".open-gajae/open-gajae.jsonc");
    const projectFile = join(root, ".open-gajae/open-gajae.jsonc");
    await writeFile(
      userFile,
      JSON.stringify({ ralplan: { maxIterations: 20, autoHandoff: "ultragoal" } }),
    );
    await writeFile(projectFile, JSON.stringify({ ralplan: { maxIterations: 3 } }));
    expect((await loadSettings(root, home)).ralplan).toEqual({
      maxIterations: 3,
      maxReviewPassesPerLane: 1,
      autoHandoff: "ultragoal",
      source: {
        maxIterations: projectFile,
        maxReviewPassesPerLane: "default",
        autoHandoff: userFile,
      },
    });
    for (const [bad, message] of [
      [{ maxIterations: 21 }, "ralplan.maxIterations"],
      [{ maxReviewPassesPerLane: 0 }, "ralplan.maxReviewPassesPerLane"],
      [{ autoHandoff: "autoresearch" }, "ralplan.autoHandoff"],
      [{ receipts: true }, "ralplan.receipts: unknown setting"],
    ] as const) {
      await writeFile(projectFile, JSON.stringify({ ralplan: bad }));
      await expect(loadSettings(root, home)).rejects.toThrow(message);
    }
  }));

test("planner edits no path and delegates only to the two research roles", () => {
  // Deny-`*`-then-allow: the host evaluates with `findLast`. Plans go through
  // the `ralplan` tool, so no plans, drafts or temp-directory `edit` allow.
  expect(roleRules("open-gajae-planner")).toEqual([
    ...denies("edit", "subagent"),
    { action: "subagent", resource: "open-gajae-explore", effect: "allow" },
    {
      action: "subagent",
      resource: "open-gajae-document-specialist",
      effect: "allow",
    },
    ...readonlyDenies,
    ...denies("ultragoal", "goal"),
  ]);
});

test("the catalog is twelve direct tools with visibility permissions", async () =>
  fixture(async (root) => {
    const { list } = toolsOf(stateStore(root), root);
    expect(list.map((tool) => tool.name).sort()).toEqual([
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
    ]);
    for (const tool of list) {
      expect(tool.options.codemode).toBe(false);
      expect(tool.options.permission).toBe(
        tool.name.startsWith("lsp_") ? "lsp" : tool.name,
      );
      // Zod 4.6 carries Standard JSON Schema, which the host requires (P4).
      expect("jsonSchema" in tool.input["~standard"]).toBe(true);
    }
  }));
// Deep-interview revision plan S3b (§3.6): the gjc skill with the host
// substitutions and the marked deviations; runtime-contract literals.
test("the deep-interview skill follows the gjc skill with its deviations marked", async () => {
  const skill = await readFile(
    new URL("../skills/deep-interview/SKILL.md", import.meta.url),
    "utf8",
  );
  const heading = "\n## Source and host substitutions\n";
  expect(skill).toContain(heading);
  const body = skill.slice(0, skill.indexOf(heading));
  const source = skill.slice(skill.indexOf(heading));
  // Frontmatter (A2-5): no trace or resolution flags, host paths, the gjc pin.
  const frontmatter = skill.slice(0, skill.indexOf("\n---\n", 4));
  expect(frontmatter).toContain('argument-hint: "<idea or vague description>"');
  expect(frontmatter).not.toContain("--trace");
  expect(frontmatter).toContain("\nhandoff: .open-gajae/_session-<created>-<id>/specs/deep-interview-<slug>.md\n");
  expect(frontmatter).toMatch(/\nsource: .*5c5231418930673e42cc5d08ebe4376e03187533/);
  for (const required of [
    "`question`",
    "`deep-interview write",
    "deep-interview handoff(to",
    '"lifecycle": "scored"',
    "round_key",
    '"round_key": "round-<n>"',
    "**A direct contradiction**",
    "**B internal inconsistency**",
    "**C low-quality/evasive**",
    "**D scope expansion**",
    "established_facts",
    "**4a. Closure / Acceptance Guard.**",
    "**4b. Restate gate.**",
    "`code_context`",
    "`web_context`",
    "`ambiguity_contrarian`",
    "`answer_simplifier`",
    "`architecture_implications`",
    "subagent(open-gajae-lateral-reviewer)",
    "lateral-review-panel.md",
    "**Refine with ralplan consensus (Recommended",
    "**Execute with ultragoal",
    "**Refine further**",
    "**Finish here**",
    // I-23: hand off first; a same-execution load hands off by itself.
    "first call `deep-interview handoff(to: \"ralplan\")` or `deep-interview handoff(to: \"ultragoal\")`, then load",
    "If this skill was loaded in the same execution, loading the chosen skill performs the handoff itself (deviation 31).",
    // K11: the combined call's later step failing leaves the earlier ones.
    "a failure in a later step leaves the earlier steps' results in place",
    "**Hard cap at 100 rounds**",
    // D-RS6: a clarification answer is re-asked, not recorded.
    "then call `question` again with the exact original question and options",
    // Phase 0 (A-10).
    "Never `start` over an active state",
    // Deviation 30 (review of 2026-10-03): cancel and resume.
    'call `deep-interview state(patch={"active": false})`, which keeps the rounds for a later resume',
    'To resume, call `deep-interview state(patch={"active": true})`',
    "after the spec (phase `handoff`), call `deep-interview clear`, as Finish here does",
    // Deviation 39: the threshold and the gates are the only exit.
    "**Ambiguity at or below the resolved threshold**: Go to the Phase 4 closure and restate gates",
  ])
    expect(`${required}: ${body.includes(required)}`).toBe(`${required}: true`);
  // PQ-22 D (C4-16): the Required line is the runtime's list.
  const requiredLine = body.split("\n").find((line) => line.startsWith("Required: "));
  expect(requiredLine?.slice("Required: ".length).split(", ").sort()).toEqual([...ROUND_RECORD_REQUIRED].sort());
  for (const forbidden of [
    "auto-answer",
    "intent_contract",
    "Ask about these choices",
    "rhythm guard",
    "Round 10",
    ".gjc",
    "gjc deep-interview",
    "the `ask` tool",
    "{{",
    "subagent(open-gajae-architect)",
    "autoresearch",
    "--trace",
    "trace_summary",
    "Phase 0.75",
    "Refine Free-Text",
    "2b″",
    "Native Plugin Invocation Guard",
    // Deviation 39: the fixed 0.9/10% exits conflicted with the threshold.
    "All dimensions at 0.9+",
    "| 0.0 - 0.1 |",
    // Deviation 30: resume is an explicit call, not a side effect.
    "saves state for resume",
  ])
    expect(`${forbidden}: ${body.includes(forbidden)}`).toBe(`${forbidden}: false`);
  expect(source).toContain("5c5231418930673e42cc5d08ebe4376e03187533");
  expect(source).toContain('"Deviations from GJC (deep-interview)"');
  const fragment = await readFile(
    new URL("../skills/deep-interview/lateral-review-panel.md", import.meta.url),
    "utf8",
  );
  expect(fragment).toStartWith("# Deep Interview Lateral Review Panel");
  expect(fragment).toContain("5c5231418930673e42cc5d08ebe4376e03187533");
  // The text the personas follow (before the source note) is gjc's with host
  // paths and no added output-contract line (PQ-7 N).
  const persona = fragment.slice(0, fragment.indexOf("<!-- Source:"));
  expect(persona).not.toContain(".gjc");
  expect(persona).not.toContain("output contract");
});

test("every deviation the deep-interview skill and fragment cite has a row in both README tables (P-AC9)", async () => {
  const cited = new Set<number>();
  for (const file of ["SKILL.md", "lateral-review-panel.md"]) {
    const text = await readFile(new URL(`../skills/deep-interview/${file}`, import.meta.url), "utf8");
    // "ralplan deviation N" and "ultragoal deviation N" point at other tables.
    for (const match of text.matchAll(/(ralplan |ultragoal )?deviations? (\d+(?:(?:, | and )\d+)*)/gi))
      if (!match[1]) for (const n of match[2].match(/\d+/g) ?? []) cited.add(Number(n));
  }
  expect(cited.size).toBeGreaterThan(0);
  for (const [file, heading] of [
    ["README.md", "## Deviations from GJC (deep-interview)"],
    ["README.ko.md", "## GJC로부터의 deviation (deep-interview)"],
  ] as const) {
    const lines = (await readFile(new URL(`../${file}`, import.meta.url), "utf8")).split("\n");
    const start = lines.indexOf(heading);
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
    const rows = new Set(
      lines
        .slice(start + 1, end)
        .map((line) => /^\| (\d+) \|/.exec(line)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number),
    );
    expect(`${file}: ${[...cited].filter((n) => !rows.has(n)).sort((a, b) => a - b)}`).toBe(`${file}: `);
  }
});

test("the three skills register with frontmatter id, name and description", async () => {
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
    ["ultragoal", "ultragoal"],
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
test("ralplan skill keeps the consensus contract and offers ultragoal as its only execution path", async () => {
  const skill = await readFile(
    new URL("../skills/ralplan/SKILL.md", import.meta.url),
    "utf8",
  );
  expect(skill).not.toContain("Skill(");
  expect(skill).not.toMatch(/codex/i);
  expect(skill).not.toMatch(/--(direct|review|consensus)\b/);
  // The gjc consensus steps are numbered 1-9.
  for (let step = 1; step <= 9; step += 1)
    expect(skill).toMatch(new RegExp(`^${step}\\. `, "m"));
  expect(skill).not.toMatch(/^0\. /m);
  expect(skill).toContain("- `--interactive`:");
  expect(skill).toContain("- `--deliberate`:");
  expect(skill).toContain("`OKAY`/`ITERATE`/`REJECT`");
  expect(skill).toContain("**Refine further**");
  expect(skill).toContain("**Stop here**");
  // AC3: the one execution path and its handoff procedure.
  expect(skill).toContain("**Approve execution via ultragoal (Recommended)**");
  for (const step of [
    'ralplan handoff(to="ultragoal")',
    "load `skill` `ultragoal`",
    "call `ultragoal create` with the plan's description and goals as structured arguments",
    'ultragoal handoff(to="ralplan", reason)',
    // PQ-4 A: a run handed over by ultragoal continues without `start`.
    "do not call `ralplan start`; continue that run with `ralplan write`",
    "pass a new `run_id` on the first `write`",
    // PQ-6 A: the common handoff keeps the row as an inactive handoff row.
    "its active row stays as an inactive `handoff_to` row",
    // PQ-21 A: the turn gate hands off only within the same execution.
    "performs this handoff itself",
    // Deep-interview revision plan DR-39 (ralplan deviation 39).
    "When no ralplan run is active, `run_id` defaults to the existing state's `run_id`",
    "A ralplan run that is already active (including one handed over to you) refuses `start`: continue it with `ralplan write`, or stop it first",
    "39 (the active-run refusal)",
    // Deep-interview revision plan D-SH5 and PQ-35 A.
    'ralplan handoff(to="deep-interview")',
    "If the ralplan state shows `handoff_from: \"deep-interview\"` and you did not see the handoff's result line, read the spec at `deep-interview status`'s `spec_path`",
  ])
    expect(skill).toContain(step);
  // I-11: no status call or plan-path argument on the way into ultragoal, and
  // the earlier re-start wording is gone.
  for (const gone of [
    "source_plan",
    "`ultragoal status`",
    "which starts ralplan in the same call",
    "rewrites the run state as a fresh seed",
  ])
    expect(`${gone}: ${skill.includes(gone)}`).toBe(`${gone}: false`);

  // No execution workflow other than ultragoal is named; the gjc
  // Pre-Execution Gate section is kept as text (D-F16).
  expect(skill).toContain("## Pre-Execution Gate");
  expect(skill).not.toMatch(/\bteam\b/i);
  expect(skill).not.toMatch(/\bralph\b/i);
  // `compact` is never one of OMC's execution options.
  expect(skill).not.toMatch(/\*\*compact\*\*/i);
});

// Runtime-contract literals of the gjc-based ultragoal skill (ultragoal gjc
// revision plan S3 3d/3e, AC26, AC34).
test("ultragoal skill follows the gjc skill with host substitutions", async () => {
  const skill = await readFile(
    new URL("../skills/ultragoal/SKILL.md", import.meta.url),
    "utf8",
  );
  const lines = skill.split("\n");
  for (const heading of [
    "## Purpose",
    "## Corrupt current-session state recovery",
    "## Always-used command examples",
    "## Create goals",
    "## Complete goals",
    "### Reopening a goal",
    "## Blocker triage and pause discipline",
    "## Dynamic steering",
    "## Role-agent delegation guidance",
    "## Boundary verification (per goal, then once at the end)",
    "## Internal ultragoal cleaner",
    "## Boundary completion cohort gate",
    "### Fix goals",
    "## Terminal critic gate",
    "## Handoff back to planning",
    "## Constraints",
    "## Source and host substitutions",
  ])
    expect(`${heading}: ${lines.includes(heading)}`).toBe(`${heading}: true`);
  for (const required of [
    "**Approve execution via ultragoal**",
    // C-15, PQ-14 (1) B': completed goals change only after a reopen.
    'The path to change and re-verify one is reopening it with `checkpoint(status: "pending")`',
    // C-7 (d), PQ-23 A: the fix-of-a-fix chain.
    "Before you complete the last fix goal of the chain, `supersede` every other `review_blocked` goal of the chain",
    // R3: reconciling ops end goal-planning.
    "do not call `status` or `classify_blocker`",
    // I-17: gjc SKILL.md:425-427.
    "the leader MUST first record the terminal verdict",
    "every call carries `rationale`",
    "`[ultragoal-red-team]`",
    "6. **QA lane contract.**",
    "5c5231418930673e42cc5d08ebe4376e03187533",
    // Deep-interview revision plan PQ-36 C (C4-2), PQ-3 A and the way back.
    "an active run keeps its phase, except when a finished deep-interview with a valid spec was loaded in the same execution",
    "call `create` with the spec's acceptance criteria as goals",
    'deep-interview handoff(to="ultragoal")',
  ])
    expect(`${required}: ${skill.includes(required)}`).toBe(`${required}: true`);
  // The source table names the gjc CLI and hash surfaces it substitutes; the
  // body before it must not.
  const heading = "\n## Source and host substitutions\n";
  const body = skill.slice(0, skill.indexOf(heading));
  expect(body.length).toBeGreaterThan(0);
  for (const forbidden of [
    ".gjc",
    "gjc ultragoal",
    "sourceHash",
    "source_plan",
    "brief.md",
    "deferredToBatch",
    "executorQa",
    "<PRD_Mode>",
    "{{",
    "run_in_background",
    "/oh-my-claudecode:",
    "TodoWrite",
    "prd.json",
  ])
    expect(`${forbidden}: ${body.includes(forbidden)}`).toBe(
      `${forbidden}: false`,
    );
  // The red-team fragment points at the SKILL's real section.
  expect(ULTRAGOAL_RED_TEAM_FRAGMENT).toContain(
    '"Boundary completion cohort gate" section',
  );
});

test("prompts name the executor, the cleaner, ultragoal and the review lanes' ralplan writes", async () => {
  const read = (name: string) =>
    readFile(new URL(`../prompts/${name}.md`, import.meta.url), "utf8");
  const primary = await read("open-gajae");
  expect(primary).not.toContain("ultragoal remain unavailable");
  // Deep-interview revision plan 3a-5: the tool and the block's source.
  expect(primary).toContain("The `deep-interview` tool is the only writer of deep-interview state");
  expect(primary).toContain("the source it came from (`~/…` or `./…` settings file, or `default`)");
  expect(primary).toContain("`open-gajae-executor`");
  expect(primary).toContain("`open-gajae-cleaner`");
  expect(await read("open-gajae-architect")).toContain(
    'ralplan write(stage="architect"',
  );
  expect(await read("open-gajae-critic")).toContain(
    'ralplan write(stage="critic"',
  );
  const cleaner = await read("open-gajae-cleaner");
  expect(cleaner).toContain("Do not modify any file, including through shell.");
  // A stable sentence of the gjc cleaner fragment (ultragoal deviation 19).
  expect(cleaner).toContain("AI SLOP CLEANUP REPORT");
});

test("neither SKILL.md carries the unsubstituted OMC arguments placeholder", async () => {
  // OMC's trailing `Task: {{ARGUMENTS}}` is substituted by no host here: the
  // explicit commands pass `$ARGUMENTS` through their own templates instead.
  for (const skill of ["deep-interview", "ralplan", "ultragoal"]) {
    const body = await readFile(
      new URL(`../skills/${skill}/SKILL.md`, import.meta.url),
      "utf8",
    );
    expect(`${skill}: ${body.includes("{{ARGUMENTS}}")}`).toBe(
      `${skill}: false`,
    );
  }
});

test("both READMEs carry the GJC deep-interview, ralplan and ultragoal deviations and the mandatory follow-up sections", async () => {
  // Plan S5 (D-D1, D-D2): the one doc test; exact heading lines, so a renamed
  // or demoted section fails.
  for (const [file, headings] of [
    [
      "README.md",
      ["## Deviations from GJC (ralplan)", "## Deviations from GJC (ultragoal)", "## Deviations from GJC (deep-interview)", "## Mandatory follow-up development"],
    ],
    [
      "README.ko.md",
      ["## GJC로부터의 deviation (ralplan)", "## GJC로부터의 deviation (ultragoal)", "## GJC로부터의 deviation (deep-interview)", "## 필수 후속 개발"],
    ],
  ] as const) {
    const lines = (
      await readFile(new URL(`../${file}`, import.meta.url), "utf8")
    ).split("\n");
    for (const heading of headings)
      expect(`${file}: ${heading}: ${lines.includes(heading)}`).toBe(
        `${file}: ${heading}: true`,
      );
  }
});
