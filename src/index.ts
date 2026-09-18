import type { Plugin } from "@opencode-ai/plugin";
import { fileURLToPath } from "node:url";
import { loadSettings, configureAgents } from "./config";
import { createHooks } from "./hooks";
import { StateStore } from "./state";
import { createTools } from "./tools";

const plugin: Plugin = async ({ worktree, client }) => {
  const settings = await loadSettings(worktree);
  // The creation time comes from the host once per session; the folder name
  // carries it so later resolutions need no host call.
  const store = new StateStore(worktree, async (id) => {
    const result = await client.session.get({ path: { id } });
    if (result.error)
      throw new Error(
        `session ${id} lookup failed: ${result.error.data.message}`,
      );
    const created = result.data.time.created;
    if (typeof created !== "number")
      throw new Error(`session ${id} has no creation time`);
    return created;
  });
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const hooks = createHooks(store, client, packageRoot);
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
