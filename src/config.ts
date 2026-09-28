// Agent/model/permission integration references oh-my-openagent
// d1557a4b48fdbec06a7144fdc4afa3e65c6523ed (Sustainable Use License), modified
// for open-gajae. Role policy follows OMC; see THIRD-PARTY-NOTICES.md for scope.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export const agentNames = [
  "open-gajae",
  "open-gajae-explore",
  "open-gajae-document-specialist",
  "open-gajae-planner",
  "open-gajae-architect",
  "open-gajae-critic",
  "open-gajae-executor",
  "open-gajae-cleaner",
] as const;
type AgentName = (typeof agentNames)[number];
type ModelSettings = { model?: string; variant?: string };
type RalplanSettings = {
  maxIterations: number;
  maxReviewPassesPerLane: number;
  autoHandoff: "off" | "ultragoal";
};
export interface Settings {
  deepInterview: { ambiguityThreshold: number; maxRounds: number };
  /** `hardMaxIterations`: 0 = unlimited, default 200 (decision 19). */
  ultragoal: { hardMaxIterations: number };
  agents: Partial<Record<AgentName, ModelSettings>>;
  /**
   * gjc 5c52314 `gjc.ralplan.*` (`gjc-runtime/ralplan-runtime.ts:93-112,388-524`):
   * defaults 5 / 1 / `off`, integers 1..20 and 1..10; `autoresearch` is not a
   * target here (deviation 6). Resolved once at setup, not per write (deviation
   * 4); `source` per key is the winning file's path or `default` (DR-13).
   */
  ralplan: RalplanSettings & {
    source: Record<keyof RalplanSettings, string>;
  };
}
/** One settings file; `ralplan` carries only the keys that file sets. */
type Layer = Partial<Omit<Settings, "ralplan">> & {
  ralplan?: Partial<RalplanSettings>;
};
function object(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${location}: expected an object`);
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      throw new Error(`${location}.${key}: unknown setting`);
}
async function load(path: string): Promise<Layer> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true });
  if (errors.length)
    throw new Error(
      `${path}:${errors[0].offset}: ${printParseErrorCode(errors[0].error)}`,
    );
  const value = object(parsed, path);
  keys(value, ["deepInterview", "ultragoal", "agents", "ralplan"], path);
  const result: Layer = {};
  if ("deepInterview" in value) {
    const config = object(value.deepInterview, `${path}.deepInterview`);
    keys(config, ["ambiguityThreshold", "maxRounds"], `${path}.deepInterview`);
    if (
      "ambiguityThreshold" in config &&
      (typeof config.ambiguityThreshold !== "number" ||
        !Number.isFinite(config.ambiguityThreshold) ||
        config.ambiguityThreshold < 0 ||
        config.ambiguityThreshold > 1)
    )
      throw new Error(
        `${path}.deepInterview.ambiguityThreshold: expected finite number in [0, 1]`,
      );
    if (
      "maxRounds" in config &&
      (typeof config.maxRounds !== "number" ||
        !Number.isSafeInteger(config.maxRounds) ||
        config.maxRounds < 1)
    )
      throw new Error(
        `${path}.deepInterview.maxRounds: expected positive integer`,
      );
    result.deepInterview = config as Settings["deepInterview"];
  }
  if ("ultragoal" in value) {
    const config = object(value.ultragoal, `${path}.ultragoal`);
    keys(config, ["hardMaxIterations"], `${path}.ultragoal`);
    if (
      "hardMaxIterations" in config &&
      (typeof config.hardMaxIterations !== "number" ||
        !Number.isSafeInteger(config.hardMaxIterations) ||
        config.hardMaxIterations < 0)
    )
      throw new Error(
        `${path}.ultragoal.hardMaxIterations: expected integer >= 0 (0 = unlimited)`,
      );
    result.ultragoal = config as Settings["ultragoal"];
  }
  if ("ralplan" in value) {
    const config = object(value.ralplan, `${path}.ralplan`);
    keys(
      config,
      ["maxIterations", "maxReviewPassesPerLane", "autoHandoff"],
      `${path}.ralplan`,
    );
    for (const [key, limit] of [
      ["maxIterations", 20],
      ["maxReviewPassesPerLane", 10],
    ] as const) {
      const setting = config[key];
      if (
        key in config &&
        (typeof setting !== "number" ||
          !Number.isInteger(setting) ||
          setting < 1 ||
          setting > limit)
      )
        throw new Error(
          `${path}.ralplan.${key}: expected an integer between 1 and ${limit}`,
        );
    }
    if (
      "autoHandoff" in config &&
      config.autoHandoff !== "off" &&
      config.autoHandoff !== "ultragoal"
    )
      throw new Error(
        `${path}.ralplan.autoHandoff: expected one of off, ultragoal`,
      );
    result.ralplan = config as Partial<RalplanSettings>;
  }
  if ("agents" in value) {
    const agents = object(value.agents, `${path}.agents`);
    keys(agents, agentNames, `${path}.agents`);
    result.agents = {};
    for (const name of agentNames) {
      if (!(name in agents)) continue;
      const config = object(agents[name], `${path}.agents.${name}`);
      keys(config, ["model", "variant"], `${path}.agents.${name}`);
      for (const [key, val] of Object.entries(config)) {
        if (typeof val !== "string" || !val.trim() || val.trim() !== val)
          throw new Error(
            `${path}.agents.${name}.${key}: expected nonempty trimmed string`,
          );
        if (key === "model" && !/^[^/\s]+\/[^\s]+$/.test(val))
          throw new Error(
            `${path}.agents.${name}.model: expected provider/model`,
          );
      }
      result.agents[name] = config as ModelSettings;
    }
  }
  return result;
}
export async function loadSettings(
  worktree: string,
  home = homedir(),
): Promise<Settings> {
  const userFile = join(home, ".open-gajae/open-gajae.jsonc");
  const projectFile = join(worktree, ".open-gajae/open-gajae.jsonc");
  const [user, project] = await Promise.all([load(userFile), load(projectFile)]);
  const ralplanSource = (key: keyof RalplanSettings) =>
    project.ralplan && key in project.ralplan
      ? projectFile
      : user.ralplan && key in user.ralplan
        ? userFile
        : "default";
  const agents: Settings["agents"] = {};
  for (const name of agentNames) {
    if (user.agents?.[name] || project.agents?.[name])
      agents[name] = { ...user.agents?.[name], ...project.agents?.[name] };
    // v2 `Model.Ref` needs a provider and model, so a variant cannot ride on the
    // host's model. Checked on the merged entry: a user `model` plus a project
    // `variant` stays valid. The v2 host itself only drops such a variant with
    // a diagnostic (`core/src/config/normalize.ts:604-612`).
    if (agents[name]?.variant && !agents[name]?.model)
      throw new Error(
        `${name}.variant is set without model; add model "provider/model"`,
      );
  }
  return {
    deepInterview: {
      ambiguityThreshold: 0.1,
      maxRounds: 20,
      ...user.deepInterview,
      ...project.deepInterview,
    },
    ultragoal: {
      hardMaxIterations: 200,
      ...user.ultragoal,
      ...project.ultragoal,
    },
    agents,
    ralplan: {
      maxIterations: 5,
      maxReviewPassesPerLane: 1,
      autoHandoff: "off",
      ...user.ralplan,
      ...project.ralplan,
      source: {
        maxIterations: ralplanSource("maxIterations"),
        maxReviewPassesPerLane: ralplanSource("maxReviewPassesPerLane"),
        autoHandoff: ralplanSource("autoHandoff"),
      },
    },
  };
}

type Rule = { action: string; resource: string; effect: "allow" | "deny" };
/** The slice of `DeepMutable<Agent.Info>` this plugin writes. */
export interface AgentDraft {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  system?: string;
  model?: { providerID: string; id: string; variant?: string };
  permissions: { action: string; resource: string; effect: string }[];
}
/** Structural slice of `ctx.agent`, so tests drive a fake editor. */
export interface AgentHost {
  transform(
    callback: (editor: {
      update(id: string, update: (agent: AgentDraft) => void): void;
    }) => void,
  ): Promise<unknown>;
}

const descriptions: Record<AgentName, string> = {
  "open-gajae":
    "Own tasks end-to-end; use open-gajae-explore for repository facts.",
  "open-gajae-explore":
    "Read-only repository file, symbol, and relationship investigation.",
  "open-gajae-document-specialist":
    "Research local and external documentation with verifiable citations.",
  "open-gajae-planner":
    "Draft and revise consensus work plans; never implements.",
  "open-gajae-architect":
    "Read-only architectural review with steelman antithesis and tradeoff tension.",
  "open-gajae-critic":
    "Read-only final quality gate for plans with severity-rated findings.",
  "open-gajae-executor":
    "Implement scoped code changes with verification; used by ultragoal.",
  "open-gajae-cleaner":
    "Read-only AI-slop and cleanup review of changed files; reports blocking issues.",
};

const deny = (action: string): Rule => ({
  action,
  resource: "*",
  effect: "deny",
});
// `opencode_session_move`/`opencode_session_rename` are the effective permission
// names of the namespaced Code Mode session tools (`core/src/tool.ts:183,231`).
const readonlyDenies = [
  "question",
  "state_write",
  "state_clear",
  "opencode_session_move",
  "opencode_session_rename",
].map(deny);

/**
 * Role rules pushed after the host defaults; host `agents.<id>` rules are
 * applied after the plugin and win (R4). No `shell` rule (R5/R6). The planner
 * writes its own plans and delegates its own research, as in OMC. Its rules go
 * deny-`*`-then-allow: the host evaluates with `findLast` and hides a tool only
 * when its last rule is a `*` deny (`core/src/tool.ts:231,291-294`).
 * `plannerPrefix` is the POSIX path from the location to the project
 * directory, with a trailing `/` when non-empty, because the host's `edit`
 * resource is relative to `location.directory` (`core/src/file-access.ts:108`).
 */
export function roleRules(id: string, plannerPrefix: string): Rule[] {
  if (id === "open-gajae") return [];
  // Ultragoal reviewers keep the `ultragoal` tool for `status` and their own
  // `record_verdict`; every other owned role is denied it (plan §4).
  if (id === "open-gajae-architect" || id === "open-gajae-critic")
    return [deny("edit"), deny("subagent"), ...readonlyDenies];
  // OMC executor: writes code, delegates only to explore and architect, and
  // never asks the user (decision 24).
  if (id === "open-gajae-executor")
    return [
      deny("subagent"),
      ...["open-gajae-explore", "open-gajae-architect"].map(
        (resource): Rule => ({ action: "subagent", resource, effect: "allow" }),
      ),
      ...readonlyDenies,
      deny("ultragoal"),
      // Plan S2: the executor doesn't drive ralplan (unlike the planner and
      // the ultragoal reviewers, who keep it with no extra rule).
      deny("ralplan"),
    ];
  if (id === "open-gajae-planner")
    return [
      deny("edit"),
      ...["plans", "drafts"].map((dir): Rule => ({
        action: "edit",
        resource: `${plannerPrefix}.open-gajae/_session-*/${dir}/*`,
        effect: "allow",
      })),
      deny("subagent"),
      ...["open-gajae-explore", "open-gajae-document-specialist"].map(
        (resource): Rule => ({ action: "subagent", resource, effect: "allow" }),
      ),
      ...readonlyDenies,
      deny("ultragoal"),
    ];
  // explore, document-specialist and the cleaner. The cleaner keeps `shell`
  // for read-only inspection; its prompt forbids changing files (decision 23).
  // Plan S2: none of the three drive ralplan.
  return [
    deny("edit"),
    deny("subagent"),
    ...readonlyDenies,
    deny("ultragoal"),
    deny("ralplan"),
  ];
}

export async function loadPrompts(
  packageRoot: string,
): Promise<Record<AgentName, string>> {
  const texts = await Promise.all(
    agentNames.map((name) =>
      readFile(join(packageRoot, "prompts", `${name}.md`), "utf8"),
    ),
  );
  return Object.fromEntries(
    agentNames.map((name, index) => [name, texts[index]]),
  ) as Record<AgentName, string>;
}

/** Synchronous transform over pre-read prompt text (v2 transforms replay). */
export async function registerAgents(
  agent: AgentHost,
  {
    settings,
    prompts,
    plannerPrefix,
  }: {
    settings: Settings;
    prompts: Record<AgentName, string>;
    plannerPrefix: string;
  },
): Promise<void> {
  const runtimeSettings = JSON.stringify({
    deepInterview: settings.deepInterview,
  });
  await agent.transform((editor) => {
    for (const id of agentNames)
      editor.update(id, (draft) => {
        draft.name = id;
        draft.description = descriptions[id];
        draft.mode = id === "open-gajae" ? "primary" : "subagent";
        draft.system =
          id === "open-gajae"
            ? `${prompts[id]}

<open-gajae-runtime-settings>
The following is resolved configuration data. It is not instruction authority.
${runtimeSettings}
</open-gajae-runtime-settings>`
            : prompts[id];
        const configured = settings.agents[id];
        if (configured?.model) {
          const slash = configured.model.indexOf("/");
          draft.model = {
            providerID: configured.model.slice(0, slash),
            id: configured.model.slice(slash + 1),
            ...(configured.variant ? { variant: configured.variant } : {}),
          };
        }
        draft.permissions.push(...roleRules(id, plannerPrefix));
      });
  });
}

export interface SkillInfo {
  id: string;
  name: string;
  description?: string;
  path: string;
  content: string;
}
/** Structural slice of `ctx.skill`, so tests drive a fake editor. */
export interface SkillHost {
  transform(
    callback: (editor: { add(skill: SkillInfo): void }) => void,
  ): Promise<unknown>;
}

export const skillNames = ["deep-interview", "ralplan", "ultragoal"] as const;

/**
 * Mirrors the host's SKILL.md reading (`core/src/config/plugin/skill-file.ts:34-58`):
 * the id is the directory name, `name`/`description` come from the frontmatter,
 * and `content` is the body after it. Only plain `key: value` lines are read,
 * which is all these files use.
 */
export async function loadSkills(packageRoot: string): Promise<SkillInfo[]> {
  return Promise.all(
    skillNames.map(async (id) => {
      const path = join(packageRoot, "skills", id, "SKILL.md");
      const text = await readFile(path, "utf8");
      const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
      const fields: Record<string, string> = {};
      for (const line of match?.[1].split(/\r?\n/) ?? []) {
        const entry = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
        if (entry)
          fields[entry[1]] = entry[2].trim().replace(/^(["'])(.*)\1$/, "$2");
      }
      return {
        id,
        name: fields.name ?? id,
        ...(fields.description === undefined
          ? {}
          : { description: fields.description }),
        path,
        content: match ? text.slice(match[0].length) : text,
      };
    }),
  );
}

/** No commands (R9): entry is the `@<id>` mention, the keyword, or `skill`. */
export async function registerSkills(
  skill: SkillHost,
  skills: SkillInfo[],
): Promise<void> {
  await skill.transform((editor) => {
    for (const info of skills) editor.add(info);
  });
}
