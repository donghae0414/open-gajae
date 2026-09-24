import { Plugin } from "@opencode/plugin";
import { loadSettings } from "./config";

// v2 is a registration model: transforms are synchronous and replayable, so all
// file I/O finishes before anything is registered. `setup` registers only the
// parts ported so far; the order below is the plan's (Step 1).
export default Plugin.define({
  id: "open-gajae",
  async setup(ctx) {
    // `project.directory` keeps v1 worktree parity for the `_session-*` layout.
    const projectDir = ctx.location.project.directory;
    // 1. Settings.
    await loadSettings(projectDir);
    // 2. StateStore(projectDir, createdAt from ctx.session.get): Steps 4–6.
    // 3. Read prompts and SKILL.md files.
    // 4. Agent, skill and tool transforms.
    // 5. Prompt and tool hooks: Steps 4–6.
    // 6. Event loop with an AbortController: Step 5.
    // 7. Cleanup: abort the loop and `lspManager.disconnectAll()`: Steps 5–6.
  },
});
