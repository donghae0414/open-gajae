import { readFile, realpath, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { Config } from "@opencode-ai/plugin";

export const agentNames = ["open-gajae", "open-gajae-explore"] as const;
type AgentName = (typeof agentNames)[number];
type ModelSettings = { model?: string; variant?: string };
export interface Settings {
  deepInterview: { ambiguityThreshold: number; maxRounds: number };
  agents: Partial<Record<AgentName, ModelSettings>>;
}
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
async function load(path: string): Promise<Partial<Settings>> {
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
  keys(value, ["deepInterview", "agents"], path);
  const result: Partial<Settings> = {};
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
  const [user, project] = await Promise.all([
    load(join(home, ".open-gajae/open-gajae.jsonc")),
    load(join(worktree, ".open-gajae/open-gajae.jsonc")),
  ]);
  const agents: Settings["agents"] = {};
  for (const name of agentNames) {
    if (user.agents?.[name] || project.agents?.[name])
      agents[name] = { ...user.agents?.[name], ...project.agents?.[name] };
  }
  return {
    deepInterview: {
      ambiguityThreshold: 0.2,
      maxRounds: 20,
      ...user.deepInterview,
      ...project.deepInterview,
    },
    agents,
  };
}

// OMO custom AgentConfig registration pattern, adapted: owned names only,
// no model defaults/provider lookup, no late allows that loosen user policy.
export const explorePermissions = {
  edit: "deny",
  bash: "deny",
  task: "deny",
  external_directory: "deny",
  question: "deny",
  state_write: "deny",
  deep_interview_spec: "deny",
} as const;

async function findCollision(root: string, ownSkill: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await findCollision(path, ownSkill);
    else if (
      entry.isFile() &&
      entry.name === "SKILL.md" &&
      (await realpath(path)) !== ownSkill
    ) {
      const text = await readFile(path, "utf8");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
      if (
        frontmatter &&
        /^name:\s*["']?deep-interview["']?\s*$/m.test(frontmatter)
      )
        throw new Error(`deep-interview skill collision: ${path}`);
    }
  }
}
export async function configureAgents(
  config: Config,
  settings: Settings,
  packageRoot: string,
): Promise<void> {
  const target = config as Config & { skills?: { paths?: string[] } };
  for (const name of agentNames)
    if (config.agent?.[name])
      throw new Error(
        `Agent collision: ${name}; remove the duplicate definition`,
      );
  if (config.command?.["deep-interview"])
    throw new Error(
      "Command collision: deep-interview; native skill must own this command",
    );
  const skillRoot = await realpath(join(packageRoot, "skills"));
  const ownSkill = await realpath(join(skillRoot, "deep-interview/SKILL.md"));
  for (const path of target.skills?.paths ?? []) {
    await findCollision(
      path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path),
      ownSkill,
    );
  }
  const [primary, explore] = await Promise.all(
    agentNames.map((name) =>
      readFile(join(packageRoot, "prompts", `${name}.md`), "utf8"),
    ),
  );
  target.skills = {
    ...target.skills,
    paths: [...new Set([...(target.skills?.paths ?? []), skillRoot])],
  };
  config.agent = {
    ...config.agent,
    "open-gajae": {
      mode: "primary",
      description:
        "Own tasks end-to-end; use open-gajae-explore for repository facts.",
      prompt: primary,
      ...settings.agents["open-gajae"],
    },
    "open-gajae-explore": {
      mode: "subagent",
      description:
        "Read-only repository file, symbol, and relationship investigation.",
      prompt: explore,
      permission: { ...explorePermissions },
      ...settings.agents["open-gajae-explore"],
    },
  };
}
