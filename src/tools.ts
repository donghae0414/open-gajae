import { deepInterviewTool } from "./deep-interview-runtime/tool.js";
import type { DeepInterviewSettings } from "./deep-interview-runtime/store.js";
import { goalTool } from "./goal/tool.js";
import {
  DEFAULT_RALPLAN_SETTINGS,
  ralplanTool,
  type RalplanToolDeps,
} from "./ralplan-runtime/tool.js";
import { startRunTx } from "./ralplan-runtime/store.js";
import type { StateStore } from "./state.js";
import { astGrepSearchTool } from "./tools/ast-tools.js";
import { lspTools } from "./tools/lsp-tools.js";
import type { CodeToolPaths } from "./tools/permissions.js";
import { ultragoalTool } from "./ultragoal-runtime/tool.js";

/**
 * Host lookups and setup-time settings only. All are optional so harnesses
 * build without a host: a missing `rootSession` fails closed, and the
 * `ralplan`, `ultragoal`, `goal` and `deep-interview` tools refuse (their
 * owner is the lineage root, D-SF6, deep-interview D-SR5).
 */
export type ToolDeps = Partial<Pick<RalplanToolDeps, "rootSession">> & {
  ralplanSettings?: RalplanToolDeps["settings"];
  /** Deep-interview revision plan DR-28: the 0.05 default when absent. */
  deepInterviewSettings?: DeepInterviewSettings;
};

async function noHostLookup(): Promise<never> {
  throw new Error("no host session lookup is available");
}

/**
 * Every tool this plugin adds, in v2 shape, for one `ctx.tool.transform`.
 * Failures come back as content.
 */
export function createTools(
  store: StateStore,
  paths: CodeToolPaths,
  deps: ToolDeps = {},
) {
  const rootSession = deps.rootSession ?? noHostLookup;
  return [
    astGrepSearchTool(paths),
    ...lspTools(paths),
    // Ultragoal revision plan S3: the gjc-based `ultragoal` and `goal` tools.
    ultragoalTool(store, { rootSession }),
    goalTool(store, { rootSession }),
    ralplanTool(store, {
      rootSession,
      settings: deps.ralplanSettings ?? DEFAULT_RALPLAN_SETTINGS,
      projectDir: paths.projectDir,
    }),
    // Deep-interview revision plan S3a: the gjc-based `deep-interview` tool
    // replaces the former `state_*` tools. Its combined `spec(…, handoff:
    // "ralplan")` seeds ralplan through `startRunTx`, wired here so neither
    // runtime imports the other (E-7).
    deepInterviewTool(store, {
      rootSession,
      settings: deps.deepInterviewSettings,
      projectDir: paths.projectDir,
      seedRalplanTx: (tx, root, input, owner) =>
        startRunTx(tx, root, input, paths.projectDir, owner),
    }),
  ];
}
