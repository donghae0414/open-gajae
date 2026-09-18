import path from "node:path";
import { realpathSync } from "node:fs";
import { tool, type ToolContext } from "@opencode-ai/plugin";
import {
  DEEP_INTERVIEW_MODE,
  type ExplicitStatePatch,
  RALPLAN_MODE,
  type StateMode,
  StateStore,
} from "./state.js";
import { astGrepSearchTool } from "./tools/ast-tools.js";
import {
  lspDocumentSymbolsTool,
  lspFindReferencesTool,
  lspServersTool,
  lspWorkspaceSymbolsTool,
} from "./tools/lsp-tools.js";

const readActors = new Set([
  "open-gajae",
  "open-gajae-explore",
  "open-gajae-document-specialist",
]);

function scope(
  store: StateStore,
  context: Pick<ToolContext, "agent" | "sessionID" | "worktree">,
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
  if (realpathSync(path.resolve(context.worktree)) !== store.worktree)
    throw new Error("tool context does not match the plugin worktree");
  if (
    workingDirectory !== undefined &&
    realpathSync(path.resolve(workingDirectory)) !== store.worktree
  )
    throw new Error("workingDirectory does not match the plugin worktree");
}

async function authorize(
  context: Pick<ToolContext, "ask">,
  permission: "state_read" | "state_write" | "state_clear",
  statePath: string,
  sessionID: string,
) {
  await context.ask({
    permission,
    patterns: [statePath],
    always: [],
    metadata: { sessionID, operation: permission },
  });
}

const explicitShape = {
  active: tool.schema.boolean().optional(),
  iteration: tool.schema.number().optional(),
  max_iterations: tool.schema.number().optional(),
  current_phase: tool.schema.string().max(200).optional(),
  task_description: tool.schema.string().max(2000).optional(),
  error: tool.schema.string().max(2000).optional(),
  plan_path: tool.schema.string().max(500).optional(),
  started_at: tool.schema.string().max(100).optional(),
  completed_at: tool.schema.string().max(100).optional(),
  awaiting_confirmation: tool.schema.boolean().optional(),
  breaker_count: tool.schema.number().optional(),
  breaker_updated_at: tool.schema.string().max(100).optional(),
  deactivated_reason: tool.schema.string().max(200).optional(),
  restored_at: tool.schema.string().max(100).optional(),
};

const modeArg = tool.schema
  .enum([DEEP_INTERVIEW_MODE, RALPLAN_MODE])
  .default(DEEP_INTERVIEW_MODE);

/** Direct callers may omit `mode`; only host-parsed args carry the schema default. */
function resolveMode(mode: StateMode | undefined): StateMode {
  return mode ?? DEEP_INTERVIEW_MODE;
}

async function pathResult(
  store: StateStore,
  sessionID: string,
  mode: StateMode,
) {
  const { statePath, specsDir, plansDir, draftsDir } =
    await store.resolveSessionPaths(sessionID, mode);
  return { statePath, specsDir, plansDir, draftsDir };
}

/** Native plugin tools only; all state operations use the current trusted session. */
export function createTools(store: StateStore) {
  return {
    ast_grep_search: astGrepSearchTool,
    lsp_find_references: lspFindReferencesTool,
    lsp_document_symbols: lspDocumentSymbolsTool,
    lsp_workspace_symbols: lspWorkspaceSymbolsTool,
    lsp_servers: lspServersTool,
    state_read: tool({
      description:
        "Read the current session's deep-interview or ralplan state. It never aggregates or inherits another session's state.",
      args: {
        mode: modeArg,
        workingDirectory: tool.schema.string().optional(),
        // Retained only to make stale callers fail validation rather than silently selecting a session.
        session_id: tool.schema.never().optional(),
      },
      async execute(args, context) {
        scope(store, context, args.workingDirectory, "state_read");
        const mode = resolveMode(args.mode);
        const paths = await pathResult(store, context.sessionID, mode);
        await authorize(
          context,
          "state_read",
          paths.statePath,
          context.sessionID,
        );
        const state = await store.read(context.sessionID, mode);
        return JSON.stringify(
          { ...paths, exists: state !== undefined, state },
          null,
          2,
        );
      },
    }),
    state_write: tool({
      description:
        "Replace the current session's deep-interview or ralplan model snapshot. Explicit arguments take priority and every write regenerates metadata.",
      args: {
        mode: modeArg,
        workingDirectory: tool.schema.string().optional(),
        session_id: tool.schema.never().optional(),
        state: tool.schema
          .record(tool.schema.string(), tool.schema.unknown())
          .optional(),
        ...explicitShape,
      },
      async execute(args, context) {
        scope(store, context, args.workingDirectory, "state_write");
        const mode = resolveMode(args.mode);
        const paths = await pathResult(store, context.sessionID, mode);
        await authorize(
          context,
          "state_write",
          paths.statePath,
          context.sessionID,
        );
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
    state_clear: tool({
      description:
        "Delete only the current session's deep-interview or ralplan state file. Session documents are preserved.",
      args: {
        mode: modeArg,
        workingDirectory: tool.schema.string().optional(),
        session_id: tool.schema.never().optional(),
      },
      async execute(args, context) {
        scope(store, context, args.workingDirectory, "state_clear");
        const mode = resolveMode(args.mode);
        const paths = await pathResult(store, context.sessionID, mode);
        await authorize(
          context,
          "state_clear",
          paths.statePath,
          context.sessionID,
        );
        const result = await store.clear(context.sessionID, mode);
        return JSON.stringify({ ...paths, result }, null, 2);
      },
    }),
  };
}
