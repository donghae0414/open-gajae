import type { Plugin } from "@opencode-ai/plugin";
import { fileURLToPath } from "node:url";
import { loadSettings, configureAgents } from "./config";
import { createHooks } from "./hooks";
import { StateStore } from "./state";
import { createTools } from "./tools";

const plugin: Plugin = async ({ worktree, client }) => {
  const settings = await loadSettings(worktree);
  const store = new StateStore(worktree);
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const hooks = createHooks(store, client);
  return {
    tool: createTools(store),
    config: async (config) => configureAgents(config, settings, packageRoot),
    event: hooks.event,
    "chat.message": hooks["chat.message"],
    "tool.execute.before": hooks["tool.execute.before"],
    "command.execute.before": hooks["command.execute.before"],
  };
};
export default plugin;
