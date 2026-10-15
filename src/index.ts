import { Plugin } from "@opencode/plugin";
import type { Info as HostTool } from "@opencode/plugin/promise/tool";
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
import { TodoStore } from "./todo/store";
import { registerTodoRpc } from "./todo/tool";

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
    const store = new StateStore(projectDir, async (sessionID) => {
      const info = await ctx.session.get({ sessionID });
      return { created: epochMillis(info.time.created), parentID: info.parentID };
    });
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
    const todoStore = new TodoStore(store);
    const todoRegistration = await registerTodoRpc(todoStore, {
      rpc: ctx.rpc,
      enabled: settings.todo.enabled,
      ownsSession: async (sessionID) => {
        const session = await ctx.session.get({ sessionID });
        return session.location.directory === ctx.location.directory;
      },
    });
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
        todoEnabled: settings.todo.enabled,
        todoStore,
        todoChanged: (event) => todoRegistration.events.emit("changed", event),
      },
    );
    await ctx.tool.transform((editor) => {
      for (const tool of tools) {
        // The heterogeneous catalog crosses the SDK's schema-generic boundary.
        const registered: HostTool = tool;
        editor.add(registered);
      }
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
    // 6. Observe vetoes immediately, before the ordered arbiter queue. A host
    // synthetic promise must not hide a stop, form or parent inbox wake.
    // Public Plugin.Context 2.0.26 has no client/server URL or session.form.
    // The setup-scoped StateStore gives form observations their instance ID.
    // Within this instance only answer/dismiss events release identities;
    // on restart the host drops forms (B7A-1: empty list and reply/dismiss 404),
    // so the controller invalidates prior-instance observations.
    hooks.configureTodo(settings.todo,
      (view) => todoRegistration.events.emit("changed", { sessionID: view.sessionID, view }));
    const controller = new AbortController();
    let events = Promise.resolve();
    void (async () => {
      for await (const event of ctx.event.subscribe({
        signal: controller.signal,
      })) {
        hooks.observeEvent(event);
        events = events.then(() => hooks.onEvent(event));
      }
      if (!controller.signal.aborted)
        console.warn("[open-gajae] event loop ended: subscription closed");
    })().catch((error) => {
      if (!controller.signal.aborted)
        console.warn("[open-gajae] event loop ended:", error);
    });
    // 7. Cleanup.
    return async () => {
      controller.abort();
      await hooks.dispose();
      await events;
      await todoRegistration.dispose();
      await lspManager.disconnectAll();
    };
  },
});
