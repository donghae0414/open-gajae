// OpenCode v2 TUI entry for the ralplan sidebar. The host resolves `<dir>/tui`
// in a plugin directory (`plugin/src/host.ts:17-44`), which is why this
// directory is `tui-plugin/` and is registered by path in `cli.json` rather
// than bound to the server plugin at the repository root. No build step: the
// host loads this `.ts` file and maps `@opencode/plugin/tui`, `solid-js` and
// `@opentui/*` to its own instances (`tui/src/plugin/runtime-plugin-support.bun.ts`).
//
// Source: oh-my-openagent d1557a4b48fdbec06a7144fdc4afa3e65c6523ed (Sustainable
// Use License) `packages/omo-opencode/src/tui.ts` sidebar registration, modified
// for open-gajae: v2 `Plugin.define` + `ui.slot` instead of the v1 module's
// `slots.register`. The drawn HUD comes from gajae-code
// 5c5231418930673e42cc5d08ebe4376e03187533 (MIT); see `sidebar.ts`,
// THIRD-PARTY-NOTICES.md and licenses/OMO-SUL.txt.

import { Plugin } from "@opencode/plugin/tui";
import { createSidebar } from "./sidebar";

export default Plugin.define({
  id: "open-gajae.sidebar.ralplan",
  setup(ctx) {
    ctx.ui.slot({ append: "sidebar.content", render: createSidebar({ ctx }) });
  },
});
