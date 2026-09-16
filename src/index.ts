import type { Plugin } from "@opencode-ai/plugin";
import { fileURLToPath } from "node:url";
import { loadSettings, configureAgents } from "./config";
import { StateStore } from "./state";
import { createTools } from "./tools";

const plugin: Plugin = async ({ worktree }) => {
  const settings = await loadSettings(worktree);
  const store = new StateStore(worktree);
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  return {
    tool: createTools(store),
    config: async (config) => configureAgents(config, settings, packageRoot),
  };
};
export default plugin;
