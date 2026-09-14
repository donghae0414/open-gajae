import path from "node:path";
import { realpathSync } from "node:fs";
import { tool, type ToolContext } from "@opencode-ai/plugin";
import { type ExplicitStatePatch, StateStore } from "./state.js";

function scope(
  store: StateStore,
  sessionID: string,
  workingDirectory: string | undefined,
  contextWorktree: string,
) {
  if (
    workingDirectory &&
    realpathSync(path.resolve(workingDirectory)) !== store.worktree
  )
    throw new Error("workingDirectory does not match the plugin worktree");
  if (realpathSync(path.resolve(contextWorktree)) !== store.worktree)
    throw new Error("tool context does not match the plugin worktree");
  if (!sessionID) throw new Error("a native session is required");
}

async function authorizeWrite(
  context: Pick<ToolContext, "ask">,
  permission: "state_write" | "deep_interview_spec",
  sessionID: string,
) {
  // Plugin tools do not receive an automatic permission gate from the host registry.
  // This preserves the owned explore profile's deny rules rather than bypassing them.
  await context.ask({
    permission,
    patterns: [sessionID],
    always: [],
    metadata: { sessionID, operation: permission },
  });
}

const explicitShape = {
  active: tool.schema.boolean().optional(),
  iteration: tool.schema.number().int().nonnegative().optional(),
  max_iterations: tool.schema.number().int().positive().optional(),
  current_phase: tool.schema.string().max(200).optional(),
  task_description: tool.schema.string().max(2000).optional(),
  error: tool.schema.string().max(2000).optional(),
  plan_path: tool.schema.string().max(500).optional(),
  started_at: tool.schema.string().max(100).optional(),
  completed_at: tool.schema.string().max(100).optional(),
};

/** Native plugin tools only; all persistence is delegated to the shared StateStore queue. */
export function createTools(store: StateStore) {
  return {
    state_read: tool({
      description:
        "Read the current session's deep-interview state. It never aggregates or inherits another session's state.",
      args: {
        mode: tool.schema.literal("deep-interview"),
        workingDirectory: tool.schema.string().optional(),
        session_id: tool.schema.string().optional(),
      },
      async execute(args, context) {
        const sessionID = args.session_id ?? context.sessionID;
        if (args.session_id && args.session_id !== context.sessionID)
          throw new Error("session_id must be the native caller session");
        scope(store, sessionID, args.workingDirectory, context.worktree);
        const state = await store.read(sessionID);
        return state
          ? JSON.stringify(
              { path: store.statePath(sessionID), exists: true, state },
              null,
              2,
            )
          : JSON.stringify({ path: store.statePath(sessionID), exists: false });
      },
    }),
    state_write: tool({
      description:
        "Replace the model-owned deep-interview state snapshot or apply explicit lifecycle metadata to the current native session. Reserved runtime fields cannot be supplied.",
      args: {
        mode: tool.schema.literal("deep-interview"),
        workingDirectory: tool.schema.string().optional(),
        session_id: tool.schema.string().optional(),
        state: tool.schema
          .record(tool.schema.string(), tool.schema.unknown())
          .optional(),
        ...explicitShape,
      },
      async execute(args, context) {
        const sessionID = args.session_id ?? context.sessionID;
        if (args.session_id && args.session_id !== context.sessionID)
          throw new Error("session_id must be the native caller session");
        scope(store, sessionID, args.workingDirectory, context.worktree);
        await authorizeWrite(context, "state_write", sessionID);
        const {
          mode: _mode,
          workingDirectory: _directory,
          session_id: _session,
          state: custom,
          ...explicit
        } = args;
        let written;
        // Explicit fields intentionally win over colliding snapshot keys.
        if (custom)
          written = await store.replaceModelState(
            sessionID,
            custom,
            "state_write",
            explicit as ExplicitStatePatch,
          );
        else if (Object.keys(explicit).length > 0)
          written = await store.applyExplicitPatch(
            sessionID,
            explicit as ExplicitStatePatch,
          );
        if (!written)
          throw new Error("state_write requires state or an explicit field");
        return JSON.stringify(
          { path: store.statePath(sessionID), state: written },
          null,
          2,
        );
      },
    }),
    deep_interview_spec: tool({
      description:
        "Persist the current interview's independent Markdown specification and return its immutable receipt.",
      args: {
        markdown: tool.schema.string().min(1),
        termination: tool.schema.enum(["normal", "cancelled", "limit-reached"]),
      },
      async execute(args, context) {
        scope(store, context.sessionID, undefined, context.worktree);
        await authorizeWrite(context, "deep_interview_spec", context.sessionID);
        const receipt = await store.writeSpec(
          context.sessionID,
          args.markdown,
          args.termination,
        );
        return JSON.stringify(receipt, null, 2);
      },
    }),
  };
}
