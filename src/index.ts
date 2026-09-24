import { Plugin } from "@opencode/plugin";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPrompts,
  loadSettings,
  loadSkills,
  registerAgents,
  registerSkills,
  type AgentHost,
} from "./config";

// v2 is a registration model: transforms are synchronous and replayable, so all
// file I/O finishes before anything is registered. `setup` registers only the
// parts ported so far; the order below is the plan's (Step 1).
export default Plugin.define({
  id: "open-gajae",
  async setup(ctx) {
    // `project.directory` keeps v1 worktree parity for the `_session-*` layout;
    // `location.directory` is the host's base for `edit` resources.
    const projectDir = ctx.location.project.directory;
    const locationDir = ctx.location.directory;
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const rel = relative(locationDir, projectDir).split(sep).join("/");
    const plannerPrefix = rel ? `${rel}/` : "";
    // 1. Settings.
    const settings = await loadSettings(projectDir);
    // 2. StateStore(projectDir, createdAt from ctx.session.get): Steps 4–6.
    // 3. Read prompts and SKILL.md files.
    const prompts = await loadPrompts(packageRoot);
    const skills = await loadSkills(packageRoot);
    // 4. Agent, skill and tool transforms (tools: Step 6).
    // `DeepMutable` turns the schema's branded strings (`Agent.Name`,
    // `Provider.ID`) into objects, so plain strings only fit the structural seam.
    await registerAgents(ctx.agent as unknown as AgentHost, {
      settings,
      prompts,
      plannerPrefix,
    });
    await registerSkills(ctx.skill, skills);
    // 5. Prompt and tool hooks: Steps 4–6.
    // 6. Event loop with an AbortController: Step 5.
    // 7. Cleanup: abort the loop and `lspManager.disconnectAll()`: Steps 5–6.
  },
});
