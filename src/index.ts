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
import { createHooks } from "./hooks";
import { epochMillis, StateStore } from "./state";

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
    // 2. State store; the session folder label comes from `time.created`.
    const store = new StateStore(projectDir, async (sessionID) =>
      epochMillis((await ctx.session.get({ sessionID })).time.created),
    );
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
    // 5. Prompt and tool hooks (execute.after: Step 6).
    const hooks = createHooks(store, ctx.session, packageRoot, locationDir);
    await ctx.session.hook("prompt", hooks.prompt);
    await ctx.tool.hook("execute.before", hooks.executeBefore);
    // 6. Event loop. Events are handled one at a time, in order, so a child's
    // `started` is recorded before its parent's `succeeded` is judged.
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      }))
        await hooks.onEvent(event);
    })().catch((error) => {
      if (!controller.signal.aborted)
        console.warn("[open-gajae] event loop ended:", error);
    });
    // 7. Cleanup (`lspManager.disconnectAll()`: Step 6).
    return () => controller.abort();
  },
});
