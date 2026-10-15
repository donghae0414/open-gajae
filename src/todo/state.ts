// Original open-gajae phased todo contract (todo-agent-performance, task 2).
// Labels, controller fences and terminal history are persisted together; the
// reducer has no host dependency and does not dispatch continuation.
import { z } from "zod";

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = counter.min(1);
const label = z.string().min(1).refine((value) => value === value.trim());
const createdLabel = z.string().trim().min(1);
export const todoSourceSchema = z.strictObject({
  eventID: z.string().min(1),
  aggregateID: z.string().min(1),
  seq: counter,
});
export const todoHoldSchema = z.strictObject({
  reason: z.string().min(1),
  eventID: z.string().min(1).optional(),
  noticeSent: z.boolean().optional(),
});
export const todoControllerSchema = z.strictObject({
  sourceWatermark: todoSourceSchema.nullable(),
  reservation: z.strictObject({
    source: todoSourceSchema,
    generation: positive,
    workEpoch: positive,
    syntheticID: z.string().min(1),
    status: z.enum(["reserved", "accepted", "failed", "uncertain", "cancelled"]),
    attempts: counter,
    progress: counter,
  }).nullable(),
  activationFence: todoSourceSchema.nullable(),
  consumedActivationFence: todoSourceSchema.nullable(),
  workEpoch: positive,
  closedLabels: z.array(label).refine((items) => new Set(items).size === items.length),
  stagnation: counter,
  failures: counter,
  hold: todoHoldSchema.nullable(),
});
export const todoPhaseSchema = z.strictObject({
  phase: label,
  items: z.array(z.strictObject({
    task: label,
    status: z.enum(["pending", "in_progress", "completed", "abandoned"]),
  })),
});

function uniquePhases(
  phases: ReadonlyArray<{ phase: string; items: ReadonlyArray<{ task: string }> }>,
): boolean {
  const tasks = phases.flatMap((phase) => phase.items.map((item) => item.task));
  return new Set(phases.map((phase) => phase.phase)).size === phases.length &&
    new Set(tasks).size === tasks.length;
}

export const todoSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionID: z.string().regex(/^[A-Za-z0-9_-]+$/).max(230),
  generation: positive,
  revision: positive,
  phases: z.array(todoPhaseSchema),
  controller: todoControllerSchema,
}).superRefine((state, context) => {
  if (!uniquePhases(state.phases))
    context.addIssue({ code: "custom", message: "phase and task labels must be unique" });
  const items = state.phases.flatMap((phase) => phase.items);
  const open = items.filter((item) => isOpen(item.status));
  if (items.filter((item) => item.status === "in_progress").length !== (open.length ? 1 : 0))
    context.addIssue({ code: "custom", message: "an open board must have exactly one focus" });
  if (state.generation > state.revision || state.controller.workEpoch > state.revision)
    context.addIssue({ code: "custom", message: "generation and work epoch cannot exceed revision" });
  const { activationFence, consumedActivationFence, reservation } = state.controller;
  if (consumedActivationFence && (!activationFence ||
    consumedActivationFence.aggregateID !== activationFence.aggregateID ||
    consumedActivationFence.seq > activationFence.seq ||
    (consumedActivationFence.seq === activationFence.seq &&
      consumedActivationFence.eventID !== activationFence.eventID)))
    context.addIssue({ code: "custom", message: "consumed activation fence exceeds delivery" });
  if (reservation && (reservation.generation > state.generation ||
    reservation.workEpoch > state.controller.workEpoch))
    context.addIssue({ code: "custom", message: "reservation belongs to a future board" });
});
export type TodoSnapshot = z.infer<typeof todoSnapshotSchema>;
export type TodoController = z.infer<typeof todoControllerSchema>;
export type TodoSource = z.infer<typeof todoSourceSchema>;
export type TodoPhase = z.infer<typeof todoPhaseSchema>;
export type TodoStatus = TodoPhase["items"][number]["status"];

const createdItems = z.array(createdLabel).min(1)
  .refine((items) => new Set(items).size === items.length);
export const todoOperationSchema = z.union([
  z.strictObject({ op: z.literal("view") }),
  z.strictObject({
    op: z.literal("init"),
    list: z.array(z.strictObject({ phase: createdLabel, items: createdItems })).min(1)
      .refine((phases) => uniquePhases(phases.map((phase) => ({
        phase: phase.phase, items: phase.items.map((task) => ({ task })),
      })))),
  }),
  z.strictObject({ op: z.literal("append"), phase: createdLabel, items: createdItems }),
  z.strictObject({ op: z.literal("start"), task: label }),
  z.strictObject({ op: z.literal("done"), task: label }),
  z.strictObject({ op: z.literal("done"), phase: label }),
  z.strictObject({ op: z.literal("drop"), task: label }),
  z.strictObject({ op: z.literal("drop"), phase: label }),
  z.strictObject({ op: z.literal("rm"), task: label }),
  z.strictObject({ op: z.literal("rm"), phase: label }),
  z.strictObject({ op: z.literal("rm") }),
]);
export type TodoOperation = z.infer<typeof todoOperationSchema>;
export function parseTodoOperation(input: unknown): TodoOperation {
  return todoOperationSchema.parse(input);
}

export class TodoStateError extends Error {
  constructor(readonly code: "missing" | "not-found" | "duplicate" | "overflow" | "stale-state", message: string) {
    super(message);
    this.name = "TodoStateError";
  }
}
export function isOpen(status: TodoStatus): boolean {
  return status === "pending" || status === "in_progress";
}
export function incrementTodoCounter(value: number): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER)
    throw new TodoStateError("overflow", "todo counter exhausted");
  return value + 1;
}
function initialController(): TodoController {
  return {
    sourceWatermark: null, reservation: null, activationFence: null,
    consumedActivationFence: null, workEpoch: 1, closedLabels: [],
    stagnation: 0, failures: 0, hold: null,
  };
}
function unreachable(value: never): never {
  throw new TodoStateError("not-found", `unknown operation: ${String(value)}`);
}

/** Mutates only a private clone; failures cannot alter the supplied snapshot. */
export function reduceTodo(
  current: TodoSnapshot | undefined,
  operation: TodoOperation,
  sessionID: string,
): TodoSnapshot {
  if (current && current.sessionID !== sessionID)
    throw new TodoStateError("stale-state", "todo belongs to another session");
  if (operation.op === "view") {
    if (!current) throw new TodoStateError("missing", "todo board is missing");
    return current;
  }
  const next: TodoSnapshot = current ? structuredClone(current) : {
    schemaVersion: 1, sessionID, generation: 1, revision: 1,
    phases: [], controller: initialController(),
  };
  const previousItems = next.phases.flatMap((phase) => phase.items);
  const select = (selector: { task: string } | { phase: string }) => {
    if ("task" in selector) {
      const found = previousItems.find((item) => item.task === selector.task);
      if (!found) throw new TodoStateError("not-found", "exact task label not found");
      return [found];
    }
    const found = next.phases.find((phase) => phase.phase === selector.phase);
    if (!found) throw new TodoStateError("not-found", "exact phase label not found");
    return found.items;
  };
  switch (operation.op) {
    case "init":
      next.phases = operation.list.map(({ phase, items }) => ({
        phase, items: items.map((task) => ({ task, status: "pending" })),
      }));
      if (current) next.generation = incrementTodoCounter(current.generation);
      break;
    case "append": {
      if (operation.items.some((task) => previousItems.some((item) => item.task === task)))
        throw new TodoStateError("duplicate", "task labels must be globally unique");
      let phase = next.phases.find((phase) => phase.phase === operation.phase);
      if (!phase) {
        phase = { phase: operation.phase, items: [] };
        next.phases.push(phase);
      }
      phase.items.push(...operation.items.map((task) => ({ task, status: "pending" as const })));
      break;
    }
    case "start": {
      const selected = select(operation);
      for (const item of previousItems)
        if (item.status === "in_progress") item.status = "pending";
      for (const item of selected) item.status = "in_progress";
      break;
    }
    case "done":
    case "drop":
      for (const item of select(operation))
        if (isOpen(item.status)) item.status = operation.op === "done" ? "completed" : "abandoned";
      break;
    case "rm":
      if ("task" in operation) {
        select(operation);
        for (const phase of next.phases)
          phase.items = phase.items.filter((item) => item.task !== operation.task);
      } else if ("phase" in operation) {
        select(operation);
        next.phases = next.phases.filter((phase) => phase.phase !== operation.phase);
      } else next.phases = [];
      break;
    default:
      return unreachable(operation);
  }
  const controller = next.controller;
  const fence = controller.activationFence;
  const consumed = controller.consumedActivationFence;
  if (["init", "append", "start"].includes(operation.op) && fence &&
    (!consumed || fence.aggregateID !== consumed.aggregateID || fence.seq > consumed.seq)) {
    controller.consumedActivationFence = { ...fence };
    controller.workEpoch = incrementTodoCounter(controller.workEpoch);
    controller.closedLabels = [];
    controller.stagnation = 0;
    controller.failures = 0;
    controller.hold = null;
    // A previous epoch reservation must never be dispatched in the new epoch.
    controller.reservation = null;
  }
  const items = next.phases.flatMap((phase) => phase.items);
  if (!items.some((item) => item.status === "in_progress")) {
    const pending = items.find((item) => item.status === "pending");
    if (pending) pending.status = "in_progress";
  }
  const labels = new Set(controller.closedLabels);
  for (const item of current?.phases.flatMap((phase) => phase.items) ?? []) {
    const after = items.find((candidate) => candidate.task === item.task);
    if (isOpen(item.status) && (!after || !isOpen(after.status))) labels.add(item.task);
  }
  controller.closedLabels = [...labels];
  if (current && JSON.stringify(next) === JSON.stringify(current)) return current;
  if (current) next.revision = incrementTodoCounter(current.revision);
  return next;
}
