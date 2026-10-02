import { Plugin } from "@opencode/plugin";
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
import { createTools } from "./tools";
import { lspManager } from "./tools/lsp/client";

// v2 is a registration model: transforms are synchronous and replayable, so all
// file I/O finishes before anything is registered; the order below is the
// plan's (Step 1). The host runs `setup` lazily, on the first prompt in a
// location, once per location.
export default Plugin.define({
  id: "open-gajae",
  async setup(ctx) {
    // `project.directory` keeps v1 worktree parity for the `_session-*` layout;
    // `location.directory` is the host's base for `edit` resources.
    const projectDir = ctx.location.project.directory;
    const locationDir = ctx.location.directory;
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    // 1. Settings.
    const settings = await loadSettings(projectDir);
    // 2. State store; the session folder label comes from `time.created`.
    const store = new StateStore(projectDir, async (sessionID) =>
      epochMillis((await ctx.session.get({ sessionID })).time.created),
    );
    // 3. Read prompts and SKILL.md files.
    const prompts = await loadPrompts(packageRoot);
    const skills = await loadSkills(packageRoot);
    // 4. Agent, skill and tool transforms.
    // `DeepMutable` turns the schema's branded strings (`Agent.Name`,
    // `Provider.ID`) into objects, so plain strings only fit the structural seam.
    await registerAgents(ctx.agent as unknown as AgentHost, {
      settings,
      prompts,
    });
    await registerSkills(ctx.skill, skills);
    // The hooks come first: the `ralplan`, `ultragoal`, `goal` and
    // `deep-interview` tools resolve their owner through the hooks'
    // fail-closed `rootSession` (plan DR-1, D-SF6). The ralplan and
    // deep-interview settings are resolved once here (DR-13, deep-interview
    // DR-28); `projectDir` rides `paths`.
    const hooks = createHooks(
      store,
      ctx.session,
      packageRoot,
      locationDir,
      projectDir,
    );
    const tools = createTools(
      store,
      { locationDir, projectDir },
      {
        rootSession: hooks.rootSession,
        ralplanSettings: settings.ralplan,
        deepInterviewSettings: settings.deepInterview,
      },
    );
    await ctx.tool.transform((editor) => {
      for (const tool of tools) editor.add(tool);
    });
    // 5. Prompt and tool hooks.
    await ctx.session.hook("prompt", hooks.prompt);
    // Plan C-11: tool hiding on every request that carries an agent's tools,
    // as the host's patch plugin registers its own; the `context` request
    // also carries the goal context (C-9).
    await ctx.session.hook("context", hooks.context);
    await ctx.session.hook("compaction", hooks.hideTools);
    await ctx.session.hook("generate", hooks.hideTools);
    await ctx.session.hook("compaction", hooks.compaction);
    await ctx.tool.hook("execute.before", hooks.executeBefore);
    await ctx.tool.hook("execute.after", hooks.executeAfter);
    // 6. Event loop. Events are handled one at a time, in order, so a child's
    // `started` is recorded before its parent's `succeeded` is judged.
    const controller = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      }))
        await hooks.onEvent(event);
      if (!controller.signal.aborted)
        console.warn("[open-gajae] event loop ended: subscription closed");
    })().catch((error) => {
      if (!controller.signal.aborted)
        console.warn("[open-gajae] event loop ended:", error);
    });
    // 7. Cleanup.
    return async () => {
      controller.abort();
      await lspManager.disconnectAll();
    };
  },
});
