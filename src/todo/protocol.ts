// Portable public DTO and RPC v1. Only Zod is a runtime dependency: this module
// is shared by the server and TUI, with no filesystem or host service imports.
// OpenCode contract inspected: @opencode/plugin and @opencode/schema 2.0.26,
// dist/promise/rpc.d.ts and dist/rpc.d.ts. Registration belongs to the adapter.
import type { Rpc } from "@opencode/plugin";
import { z } from "zod";
import { todoHoldSchema, todoPhaseSchema, type TodoSnapshot } from "./state.js";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sessionID = z.string().regex(/^[A-Za-z0-9_-]+$/).max(230);
export const todoCountsSchema = z.strictObject({
  pending: count,
  in_progress: count,
  completed: count,
  abandoned: count,
  open: count,
  total: count,
});
export type TodoCounts = z.infer<typeof todoCountsSchema>;
export const todoViewSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("disabled"), sessionID }),
  z.strictObject({ status: z.literal("missing"), sessionID }),
  z.strictObject({ status: z.literal("invalid"), sessionID, diagnostic: z.string() }),
  z.strictObject({
    status: z.literal("ready"), sessionID,
    schemaVersion: z.literal(1),
    generation: count.min(1),
    revision: count.min(1),
    phases: z.array(todoPhaseSchema),
    counts: todoCountsSchema,
    focus: z.strictObject({ phase: z.string().min(1), task: z.string().min(1) }).nullable(),
    hold: todoHoldSchema.nullable(),
  }),
]);
export type TodoView = z.infer<typeof todoViewSchema>;
export type TodoReadyView = Extract<TodoView, { status: "ready" }>;
export const todoChangedSchema = z.strictObject({
  sessionID, view: todoViewSchema,
}).refine((event) => event.sessionID === event.view.sessionID);
export type TodoChanged = z.infer<typeof todoChangedSchema>;

export const todoRpc = {
  id: "open-gajae.todo",
  version: 1,
  methods: {
    get: { input: z.strictObject({ sessionID }), output: todoViewSchema },
  },
  events: { changed: { schema: todoChangedSchema } },
} as const satisfies Rpc.PortableDefinition & { readonly version: 1 };

export function todoCounts(phases: TodoSnapshot["phases"]): TodoCounts {
  const counts: TodoCounts = {
    pending: 0, in_progress: 0, completed: 0, abandoned: 0, open: 0, total: 0,
  };
  for (const phase of phases) for (const item of phase.items) {
    counts[item.status]++;
    counts.total++;
  }
  counts.open = counts.pending + counts.in_progress;
  return counts;
}

export function todoView(snapshot: TodoSnapshot): TodoReadyView {
  let focus: TodoReadyView["focus"] = null;
  for (const phase of snapshot.phases) {
    const item = phase.items.find((item) => item.status === "in_progress");
    if (item) focus = { phase: phase.phase, task: item.task };
  }
  return {
    status: "ready", schemaVersion: 1, sessionID: snapshot.sessionID,
    generation: snapshot.generation, revision: snapshot.revision,
    phases: structuredClone(snapshot.phases),
    counts: todoCounts(snapshot.phases), focus,
    hold: structuredClone(snapshot.controller.hold),
  };
}
