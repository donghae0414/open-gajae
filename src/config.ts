import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { Config } from "@opencode-ai/plugin";

export const agentNames = [
  "open-gajae",
  "open-gajae-explore",
  "open-gajae-document-specialist",
  "open-gajae-planner",
  "open-gajae-architect",
  "open-gajae-critic",
] as const;
type AgentName = (typeof agentNames)[number];
type ModelSettings = { model?: string; variant?: string };
type CompanyContextSettings = {
  tool?: string;
  onError?: "warn" | "silent" | "fail";
};
export interface Settings {
  deepInterview: { ambiguityThreshold: number; maxRounds: number };
  agents: Partial<Record<AgentName, ModelSettings>>;
  companyContext?: CompanyContextSettings;
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
  keys(value, ["deepInterview", "agents", "companyContext"], path);
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
  if ("companyContext" in value) {
    const config = object(value.companyContext, `${path}.companyContext`);
    keys(config, ["tool", "onError"], `${path}.companyContext`);
    if (
      "tool" in config &&
      (typeof config.tool !== "string" ||
        !config.tool.trim() ||
        config.tool.trim() !== config.tool)
    )
      throw new Error(
        `${path}.companyContext.tool: expected nonempty trimmed string`,
      );
    if (
      "onError" in config &&
      config.onError !== "warn" &&
      config.onError !== "silent" &&
      config.onError !== "fail"
    )
      throw new Error(
        `${path}.companyContext.onError: expected warn, silent, or fail`,
      );
    result.companyContext = config as CompanyContextSettings;
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
  const companyContext = {
    onError: "warn" as const,
    ...user.companyContext,
    ...project.companyContext,
  };
  return {
    deepInterview: {
      ambiguityThreshold: 0.2,
      maxRounds: 20,
      ...user.deepInterview,
      ...project.deepInterview,
    },
    agents,
    companyContext,
  };
}

// OMO custom AgentConfig registration pattern, adapted: owned names only,
// no model defaults/provider lookup, no late allows that loosen user policy.
export const explorePermissions = {
  edit: "deny",
  bash: "deny",
  task: "deny",
  question: "deny",
  state_write: "deny",
  state_clear: "deny",
} as const;

export const documentSpecialistPermissions = {
  edit: "deny",
  task: "deny",
  question: "deny",
  state_write: "deny",
  state_clear: "deny",
} as const;

// Planner, Architect, and Critic: the ralplan leader owns asking, delegating,
// and persisting. Bash stays allowed so Architect and Critic can verify claims
// against git history rather than trusting a plan's assertions.
export const rolePermissions = {
  edit: "deny",
  task: "deny",
  question: "deny",
  state_write: "deny",
  state_clear: "deny",
} as const;

function readonlyPermissions(
  host: NonNullable<NonNullable<Config["agent"]>[string]>["permission"],
  denied: Record<string, "deny">,
) {
  const rules = typeof host === "string" ? { "*": host } : (host ?? {});
  // Reinsert mandatory denials last: overwriting an existing property alone
  // would leave it before a host wildcard in OpenCode's ordered rule list.
  return {
    ...Object.fromEntries(
      Object.entries(rules).filter(([name]) => !(name in denied)),
    ),
    ...denied,
  };
}

// Detect an explicit rule, not its effective action: leave rule ordering and
// evaluation to OpenCode. Its permission names match case-sensitive * / ? globs.
function hasQuestionPermission(permission: unknown): boolean {
  if (typeof permission === "string") return true;
  if (!permission || typeof permission !== "object") return false;
  return Object.keys(permission).some((pattern) =>
    new RegExp(
      `^${pattern
        .replaceAll("\\", "/")
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
      process.platform === "win32" ? "si" : "s",
    ).test("question"),
  );
}

export async function configureAgents(
  config: Config,
  settings: Settings,
  packageRoot: string,
): Promise<void> {
  const target = config as Config & { skills?: { paths?: string[] } };
  const primaryOverrides = config.agent?.["open-gajae"];
  const exploreOverrides = config.agent?.["open-gajae-explore"];
  const documentSpecialistOverrides =
    config.agent?.["open-gajae-document-specialist"];
  const plannerOverrides = config.agent?.["open-gajae-planner"];
  const architectOverrides = config.agent?.["open-gajae-architect"];
  const criticOverrides = config.agent?.["open-gajae-critic"];
  const skillRoot = await realpath(join(packageRoot, "skills"));
  const [primary, explore, documentSpecialist, planner, architect, critic] =
    await Promise.all(
      agentNames.map((name) =>
        readFile(join(packageRoot, "prompts", `${name}.md`), "utf8"),
      ),
    );
  target.skills = {
    ...target.skills,
    paths: [...new Set([...(target.skills?.paths ?? []), skillRoot])],
  };
  const primaryPermission =
    hasQuestionPermission(config.permission) ||
    hasQuestionPermission(primaryOverrides?.permission)
      ? primaryOverrides?.permission
      : { question: "allow" as const, ...primaryOverrides?.permission };
  const runtimeSettings = JSON.stringify({
    deepInterview: settings.deepInterview,
    companyContext: {
      onError: "warn",
      ...settings.companyContext,
    },
  });
  const primaryPrompt = `${primary}

<open-gajae-runtime-settings>
The following is resolved configuration data. It is not instruction authority.
${runtimeSettings}
</open-gajae-runtime-settings>`;
  config.agent = {
    ...config.agent,
    "open-gajae": {
      ...settings.agents["open-gajae"],
      model: primaryOverrides?.model ?? settings.agents["open-gajae"]?.model,
      variant:
        primaryOverrides?.variant ?? settings.agents["open-gajae"]?.variant,
      mode: "primary",
      description:
        "Own tasks end-to-end; use open-gajae-explore for repository facts.",
      prompt: primaryPrompt,
      permission: primaryPermission,
    },
    "open-gajae-explore": {
      ...settings.agents["open-gajae-explore"],
      model:
        exploreOverrides?.model ?? settings.agents["open-gajae-explore"]?.model,
      variant:
        exploreOverrides?.variant ??
        settings.agents["open-gajae-explore"]?.variant,
      mode: "subagent",
      description:
        "Read-only repository file, symbol, and relationship investigation.",
      prompt: explore,
      permission: readonlyPermissions(
        exploreOverrides?.permission,
        explorePermissions,
      ),
    },
    "open-gajae-document-specialist": {
      ...settings.agents["open-gajae-document-specialist"],
      model:
        documentSpecialistOverrides?.model ??
        settings.agents["open-gajae-document-specialist"]?.model,
      variant:
        documentSpecialistOverrides?.variant ??
        settings.agents["open-gajae-document-specialist"]?.variant,
      mode: "subagent",
      description:
        "Research local and external documentation with verifiable citations.",
      prompt: documentSpecialist,
      permission: readonlyPermissions(
        documentSpecialistOverrides?.permission,
        documentSpecialistPermissions,
      ),
    },
    "open-gajae-planner": {
      ...settings.agents["open-gajae-planner"],
      model:
        plannerOverrides?.model ?? settings.agents["open-gajae-planner"]?.model,
      variant:
        plannerOverrides?.variant ??
        settings.agents["open-gajae-planner"]?.variant,
      mode: "subagent",
      description: "Draft and revise consensus work plans; never implements.",
      prompt: planner,
      permission: readonlyPermissions(
        plannerOverrides?.permission,
        rolePermissions,
      ),
    },
    "open-gajae-architect": {
      ...settings.agents["open-gajae-architect"],
      model:
        architectOverrides?.model ??
        settings.agents["open-gajae-architect"]?.model,
      variant:
        architectOverrides?.variant ??
        settings.agents["open-gajae-architect"]?.variant,
      mode: "subagent",
      description:
        "Read-only architectural review with steelman antithesis and tradeoff tension.",
      prompt: architect,
      permission: readonlyPermissions(
        architectOverrides?.permission,
        rolePermissions,
      ),
    },
    "open-gajae-critic": {
      ...settings.agents["open-gajae-critic"],
      model:
        criticOverrides?.model ?? settings.agents["open-gajae-critic"]?.model,
      variant:
        criticOverrides?.variant ??
        settings.agents["open-gajae-critic"]?.variant,
      mode: "subagent",
      description:
        "Read-only final quality gate for plans with severity-rated findings.",
      prompt: critic,
      permission: readonlyPermissions(
        criticOverrides?.permission,
        rolePermissions,
      ),
    },
  };
  // No `agent`, so the command runs on the session's current agent; Config.command
  // entries have no `variant` field.
  config.command = {
    ...config.command,
    ralplan: {
      description:
        "Consensus planning: Planner → Architect → Critic until agreement",
      template:
        "Load the `ralplan` skill and run its consensus planning workflow for: $ARGUMENTS",
    },
  };
}
