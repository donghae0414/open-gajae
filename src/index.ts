import type { Plugin } from "@opencode-ai/plugin";
import { fileURLToPath } from "node:url";
import { loadSettings, configureAgents } from "./config";
import { StateStore } from "./state";
import { createTools } from "./tools";
import { createHooks } from "./hooks";

const plugin: Plugin = async ({ worktree, client }) => {
  const settings = await loadSettings(worktree);
  const store = new StateStore(worktree, settings.deepInterview);
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  return {
    ...createHooks(store, client),
    tool: createTools(store),
    config: async (config) => configureAgents(config, settings, packageRoot),
  };
};
export default plugin;
