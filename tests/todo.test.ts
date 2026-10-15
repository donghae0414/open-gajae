import { expect, test } from "bun:test";
import {
  parseTodoOperation,
  reduceTodo,
  todoSnapshotSchema,
  type TodoSnapshot,
} from "../src/todo/state";
import { todoRpc, todoView } from "../src/todo/protocol";

const init = { op: "init", list: [{ phase: "Build", items: ["A", "B", "C"] }] };
function board(): TodoSnapshot {
  return reduceTodo(undefined, parseTodoOperation(init), "session");
}
function apply(state: TodoSnapshot, operation: unknown) {
  return reduceTodo(state, parseTodoOperation(operation), "session");
}

test("focus is preserved on nonfocus completion and promotes first pending", () => {
  const original = board();
  const focused = apply(original, { op: "start", task: "C" });
  const otherClosed = apply(focused, { op: "done", task: "B" });
  expect(todoView(otherClosed).focus).toEqual({ phase: "Build", task: "C" });
  const closed = apply(otherClosed, { op: "done", task: "C" });
  expect(todoView(closed).focus).toEqual({ phase: "Build", task: "A" });
  expect(todoView(closed).counts).toEqual({
    pending: 0, in_progress: 1, completed: 2, abandoned: 0, open: 1, total: 3,
  });
  expect(todoView(original).focus?.task).toBe("A");
});

test("creation trims labels but references are exact and case-sensitive", () => {
  const state = reduceTodo(undefined, parseTodoOperation({
    op: "init", list: [{ phase: " Build ", items: [" A ", "a"] }],
  }), "session");
  expect(state.phases[0]).toEqual({
    phase: "Build", items: [{ task: "A", status: "in_progress" }, { task: "a", status: "pending" }],
  });
  for (const task of [" A ", "task-1", "1", "missing"])
    expect(() => apply(state, { op: "start", task })).toThrow();
});

const malformed: unknown[] = [
  null, [], {}, { ops: [{ op: "view" }] }, { op: "unknown" },
  { op: "view", task: "A" }, { op: "view", sessionID: "other" },
  { op: "init", items: ["A"] }, { op: "init", list: [] },
  { op: "init", list: [{ phase: " ", items: ["A"] }] },
  { op: "init", list: [{ phase: "Build", items: [] }] },
  { op: "init", list: [{ phase: "Build", items: ["A"], extra: true }] },
  { op: "init", list: [{ phase: "Build", items: ["A", " A "] }] },
  { op: "init", list: [{ phase: "Build", items: ["A"] }, { phase: "Build ", items: ["B"] }] },
  { op: "init", list: [{ phase: "Build", items: ["A"] }, { phase: "Next", items: ["A"] }] },
  { op: "append", items: ["D"] }, { op: "append", phase: "Build", items: [] },
  { op: "append", phase: "Build", items: ["D", " "] },
  { op: "append", phase: "Build", items: ["D", " D "] },
  { op: "start" }, { op: "start", phase: "Build" }, { op: "start", task: 1 },
  { op: "start", task: "A", phase: "Build" },
  { op: "done" }, { op: "done", task: "A", phase: "Build" },
  { op: "done", task: "" }, { op: "drop" }, { op: "drop", task: "A", id: "x" },
  { op: "drop", task: "A", phase: "Build" },
  { op: "rm", task: "A", phase: "Build" }, { op: "rm", id: "A" },
  { op: "rm", task: undefined },
];
test.each(malformed.map((input, index) => ({ input, index })))(
  "malformed operation $index is rejected without mutation",
  ({ input }) => {
    const state = board();
    const before = structuredClone(state);
    expect(() => apply(state, input)).toThrow();
    expect(state).toEqual(before);
  },
);

test("append rejects the entire batch on an existing label", () => {
  const state = board();
  const before = structuredClone(state);
  expect(() => apply(state, { op: "append", phase: "Next", items: ["D", "A"] })).toThrow();
  expect(state).toEqual(before);
});

test("phase closure retains terminal states and history, with no-op revision stable", () => {
  let state = apply(board(), { op: "drop", task: "B" });
  state = apply(state, { op: "done", phase: "Build" });
  expect(state.phases[0]?.items.map((item) => item.status)).toEqual(["completed", "abandoned", "completed"]);
  expect(todoView(state).focus).toBeNull();
  expect(apply(state, { op: "drop", phase: "Build" })).toBe(state);
  expect(apply(state, { op: "view" })).toBe(state);
  expect(apply(state, { op: "start", task: "B" }).phases[0]?.items[1]?.status).toBe("in_progress");
});

test("append and removal preserve order, empty phases and a single focus", () => {
  let state = apply(board(), { op: "append", phase: " Next ", items: [" D ", "E"] });
  state = apply(state, { op: "rm", phase: "Build" });
  expect(todoView(state).focus).toEqual({ phase: "Next", task: "D" });
  state = apply(state, { op: "rm", task: "D" });
  state = apply(state, { op: "rm", task: "E" });
  expect(state.phases).toEqual([{ phase: "Next", items: [] }]);
  const empty = apply(state, { op: "rm" });
  expect(empty.phases).toEqual([]);
  expect(todoView(empty).status).toBe("ready");
  expect(apply(empty, { op: "rm" })).toBe(empty);
  expect(() => apply(empty, { op: "done", phase: "missing" })).toThrow();
});

test("init increments generation and revision but not work epoch or progress ledger", () => {
  const closed = apply(board(), { op: "done", task: "A" });
  const reset = apply(closed, init);
  expect(reset.generation).toBe(closed.generation + 1);
  expect(reset.revision).toBe(closed.revision + 1);
  expect(reset.controller.workEpoch).toBe(closed.controller.workEpoch);
  expect(reset.controller.closedLabels).toEqual(["A"]);
  const reclosed = apply(reset, { op: "done", task: "A" });
  expect(reclosed.controller.closedLabels).toEqual(["A"]);
});

test("only an eligible explicit operation consumes a fresh user activation fence", () => {
  const state = board();
  state.controller.hold = { reason: "user-stop" };
  state.controller.stagnation = 3;
  state.controller.failures = 5;
  state.controller.activationFence = { eventID: "user-1", aggregateID: "session", seq: 3 };
  for (const op of [{ op: "view" }, { op: "done", task: "B" }, { op: "drop", task: "B" }, { op: "rm", task: "B" }]) {
    const next = apply(state, op);
    expect(next.controller.hold).toEqual({ reason: "user-stop" });
    expect(next.controller.workEpoch).toBe(1);
  }
  const next = apply(state, { op: "start", task: "A" });
  expect(next.controller).toMatchObject({
    hold: null, workEpoch: 2, stagnation: 0, failures: 0,
    consumedActivationFence: state.controller.activationFence,
  });
  expect(apply(next, init).controller.workEpoch).toBe(2);
});

test("snapshot validation rejects impossible focus, duplicates and malformed counters", () => {
  const state = board();
  for (const bad of [
    { ...state, schemaVersion: 2 }, { ...state, generation: 0 },
    { ...state, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...state, phases: [{ phase: "Build", items: [{ task: "A", status: "pending" }] }] },
    { ...state, phases: [...state.phases, ...state.phases] },
    { ...state, controller: { ...state.controller, closedLabels: ["A", "A"] } },
  ]) expect(todoSnapshotSchema.safeParse(bad).success).toBe(false);
  expect(todoSnapshotSchema.safeParse(state).success).toBe(true);
});

test("a consumed activation fence cannot name a different event at the delivered sequence", () => {
  const state = board();
  const conflicting = {
    ...state,
    controller: {
      ...state.controller,
      activationFence: { eventID: "delivered", aggregateID: "session", seq: 7 },
      consumedActivationFence: { eventID: "different", aggregateID: "session", seq: 7 },
    },
  };
  expect(todoSnapshotSchema.safeParse(conflicting).success).toBe(false);
});

test("portable RPC has a read-only method and validates full changed views", () => {
  expect(todoRpc.id).toBe("open-gajae.todo");
  expect(todoRpc.version).toBe(1);
  expect(Object.keys(todoRpc.methods)).toEqual(["get"]);
  expect(todoRpc.methods.get.input.safeParse({ sessionID: "session" }).success).toBe(true);
  expect(todoRpc.methods.get.input.safeParse({ sessionID: "session", op: "rm" }).success).toBe(false);
  const view = todoView(board());
  expect(todoRpc.events.changed.schema.parse({ sessionID: "session", view })).toEqual({ sessionID: "session", view });
  expect(todoRpc.events.changed.schema.safeParse({ sessionID: "other", view }).success).toBe(false);
});
