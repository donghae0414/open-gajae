import path from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import {
  DEEP_INTERVIEW_MODE,
  type ExplicitStatePatch,
  StateStore,
} from "./state.js";
import { goalTool } from "./goal/tool.js";
import { ultragoalTool } from "./ultragoal-runtime/tool.js";
import {
  DEFAULT_RALPLAN_SETTINGS,
  ralplanTool,
  type RalplanToolDeps,
} from "./ralplan-runtime/tool.js";
import { astGrepSearchTool } from "./tools/ast-tools.js";
import { defineTool, type ToolCallContext } from "./tools/define.js";
import { lspTools } from "./tools/lsp-tools.js";
import type { CodeToolPaths } from "./tools/permissions.js";

const readActors = new Set([
  "open-gajae",
  "open-gajae-explore",
  "open-gajae-document-specialist",
  "open-gajae-planner",
  "open-gajae-architect",
  "open-gajae-critic",
  "open-gajae-executor",
  "open-gajae-cleaner",
]);

function scope(
  store: StateStore,
  context: Pick<ToolCallContext, "agent" | "sessionID">,
  workingDirectory: string | undefined,
  operation: "state_read" | "state_write" | "state_clear",
) {
  if (!readActors.has(context.agent))
    throw new Error("state tools are restricted to owned agents");
  if (
    (operation === "state_write" || operation === "state_clear") &&
    context.agent !== "open-gajae"
  )
    throw new Error(`${operation} is restricted to the primary agent`);
  if (typeof context.sessionID !== "string" || context.sessionID.length === 0)
    throw new Error("a native session is required");
  if (
    workingDirectory !== undefined &&
    realpathSync(path.resolve(workingDirectory)) !== store.worktree
  )
    throw new Error("workingDirectory does not match the plugin worktree");
}

const explicitShape = {
  active: z.boolean().optional(),
  iteration: z.number().optional(),
  max_iterations: z.number().optional(),
  current_phase: z.string().max(200).optional(),
  task_description: z.string().max(2000).optional(),
  error: z.string().max(2000).optional(),
  plan_path: z.string().max(500).optional(),
  started_at: z.string().max(100).optional(),
  completed_at: z.string().max(100).optional(),
  awaiting_confirmation: z.boolean().optional(),
  breaker_count: z.number().optional(),
  breaker_updated_at: z.string().max(100).optional(),
  deactivated_reason: z.string().max(200).optional(),
  restored_at: z.string().max(100).optional(),
};

// Ultragoal state is reached only through the `ultragoal` tool (decision 21),
// and ralplan state only through the `ralplan` tool (plan S3, D-W1/AC15).
const modeArg = z.enum([DEEP_INTERVIEW_MODE]).default(DEEP_INTERVIEW_MODE);

type ToolMode = typeof DEEP_INTERVIEW_MODE;

/** Direct callers may omit `mode`; only host-parsed args carry the schema default. */
function resolveMode(mode: ToolMode | undefined): ToolMode {
  return mode ?? DEEP_INTERVIEW_MODE;
}

/** Plan DR-16 (D-T4): no `plansDir`/`draftsDir`; ralplan plans are the tool's. */
async function pathResult(store: StateStore, sessionID: string, mode: ToolMode) {
  const { statePath, specsDir } = await store.resolveSessionPaths(sessionID, mode);
  return { statePath, specsDir };
}

/**
 * Host lookups and setup-time settings only. Both are optional so harnesses
 * build without a host: a missing `rootSession` fails closed, and the
 * `ralplan`, `ultragoal` and `goal` tools refuse (their owner is the lineage
 * root, D-SF6).
 */
export type ToolDeps = Partial<Pick<RalplanToolDeps, "rootSession">> & {
  ralplanSettings?: RalplanToolDeps["settings"];
};

async function noHostLookup(): Promise<never> {
  throw new Error("no host session lookup is available");
}

/**
 * Every tool this plugin adds, in v2 shape, for one `ctx.tool.transform`. State
 * operations use the current trusted session; failures come back as content.
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
    defineTool({
      name: "state_read",
      permission: "state_read",
      description:
        "Read the current session's deep-interview state. It never aggregates or inherits another session's state; ralplan state is read with the `ralplan` tool.",
      input: z.object({
        mode: modeArg,
        workingDirectory: z.string().optional(),
        // Retained only to make stale callers fail validation rather than silently selecting a session.
        session_id: z.never().optional(),
      }),
      async execute(args, context) {
        scope(store, context, args.workingDirectory, "state_read");
        const mode = resolveMode(args.mode);
        const paths = await pathResult(store, context.sessionID, mode);
        const state = await store.read(context.sessionID, mode);
        return JSON.stringify(
          { ...paths, exists: state !== undefined, state },
          null,
          2,
        );
      },
    }),
    defineTool({
      name: "state_write",
      permission: "state_write",
      description:
        "Replace the current session's deep-interview model snapshot. Explicit arguments take priority and every write regenerates metadata. Ralplan state is changed only with the `ralplan` tool.",
      input: z.object({
        mode: modeArg,
        workingDirectory: z.string().optional(),
        session_id: z.never().optional(),
        state: z.record(z.string(), z.unknown()).optional(),
        ...explicitShape,
      }),
      async execute(args, context) {
        scope(store, context, args.workingDirectory, "state_write");
        const mode = resolveMode(args.mode);
        const paths = await pathResult(store, context.sessionID, mode);
        const {
          mode: _mode,
          workingDirectory: _directory,
          session_id: _session,
          state,
          ...explicit
        } = args;
        const written = await store.write(
          context.sessionID,
          state,
          explicit as ExplicitStatePatch,
          mode,
        );
        return JSON.stringify({ ...paths, state: written }, null, 2);
      },
    }),
    defineTool({
      name: "state_clear",
      permission: "state_clear",
      description:
        "Delete only the current session's deep-interview state file. Session documents are preserved. Ralplan state is cleared with `ralplan clear`.",
      input: z.object({
        mode: modeArg,
        workingDirectory: z.string().optional(),
        session_id: z.never().optional(),
      }),
      async execute(args, context) {
        scope(store, context, args.workingDirectory, "state_clear");
        const mode = resolveMode(args.mode);
        const paths = await pathResult(store, context.sessionID, mode);
        const result = await store.clear(context.sessionID, mode);
        return JSON.stringify({ ...paths, result }, null, 2);
      },
    }),
  ];
}
