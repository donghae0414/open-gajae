import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHooks, type HostSession } from "../src/hooks";
import { StateStore } from "../src/state";
import { TodoStore } from "../src/todo/store";
import {
  admissionOrders, createPureLifecycle, runPureAdmission, runPureLifecycle, runForgetReplay,
  type Channel, type LifecycleOptions, type LifecycleStep,
} from "./todo-interleavings-model";

const PARENT = "ses_parent";
const PACKAGE = new URL("../", import.meta.url).pathname;
const FULL = process.env.TODO_INTERLEAVINGS_FULL === "1";
const MODE = FULL ? "exhaustive" : "deterministic boundary cover";
test("forget at terminal fences replay without losing new execution debt", () => {
  const naive = runForgetReplay(true);
  const safe = runForgetReplay(process.env.TODO_NAIVE_DELETE === "1");
  console.info("FORGET_REPLAY_MODEL", JSON.stringify({
    schedules: safe.schedules, naive_delete_failures: naive.failures.length, final_failures: safe.failures.length,
  }));
  expect(naive.failures.length).toBeGreaterThan(0);
  expect(safe.failures).toEqual([]);
});
test("foreign ownership excludes a pending idle confirmation in the pure adapter", () => {
  const child = "ses_unlocated";
  const model = createPureLifecycle(PARENT, () => true);
  let seq = 0;
  const emit = (sessionID: string, type: string, data: Record<string, unknown> = {}) => {
    const n = ++seq;
    model.event(type, { sessionID, ...data }, { eventID: `location_${n}`, aggregateID: sessionID, seq: n });
  };
  model.location(child, "unknown");
  emit(child, "session.execution.started");
  emit(PARENT, "session.inbox.enqueued", { inboxID: "user", item: { type: "user", payload: { text: "Continue." } } });
  emit(PARENT, "session.execution.started");
  emit(PARENT, "session.inbox.delivered", { inboxID: "user" });
  emit(PARENT, "session.execution.succeeded");
  expect(model.view()).toMatchObject({ resumes: 0, hold: "child_result_ambiguous" });
  model.location(child, "foreign");
  expect(model.view()).toMatchObject({ resumes: 1, hold: null });
  expect(model.idle(child)).toBe(false);
});
const renameCommitted = new Map<string, Set<() => void>>();
let renameObserver: ReturnType<typeof spyOn> | undefined;
beforeAll(() => {
  if (FULL) return;
  const rename = fs.rename.bind(fs);
  renameObserver = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    for (const listener of renameCommitted.get(String(to)) ?? []) listener();
  });
});
afterAll(() => { renameObserver?.mockRestore(); });
const STEPS = ["start1", "end1", "enqueue1", "deliver1", "lookup1",
  "start2", "end2", "enqueue2", "deliver2", "lookup2"] as const;
type Step = typeof STEPS[number];
const before: Record<Step, readonly Step[]> = {
  start1: [], end1: ["start1"], enqueue1: ["end1"], deliver1: ["enqueue1"],
  lookup1: ["start1"], start2: ["end1"], end2: ["start2"],
  enqueue2: ["end2", "enqueue1"], deliver2: ["enqueue2", "deliver1"], lookup2: ["start2"],
};
function orders(prefix: readonly Step[] = []): Step[][] {
  if (prefix.length === STEPS.length) return [[...prefix]];
  return STEPS.filter((step) => !prefix.includes(step) &&
    before[step].every((prior) => prefix.includes(prior)))
    .flatMap((step) => orders([...prefix, step]));
}
function lookupSteps(order: readonly Step[]): LifecycleStep[] {
  let started = 0;
  let ended = 0;
  let delivered = 0;
  const nodes: LifecycleStep[] = [];
  for (const step of order) {
    const kind = step.startsWith("start") ? "start" : step.startsWith("end") ? "end" :
      step.startsWith("enqueue") ? "enqueue" : step.startsWith("deliver") ? "deliver" : "lookup",
      execution = step.endsWith("1") ? 1 : 2;
    nodes.push({ kind, execution });
    if (kind === "start") started++;
    if (kind === "end") ended++;
    if (kind === "deliver") delivered++;
    // Explicit adversarial parent turns while a child is still outstanding.
    // These are inputs, not events invented by the conservation oracle.
    if (started > delivered || started > ended)
      nodes.push({ kind: "parent-start", execution: -1 }, { kind: "parent-success", execution: -1 });
  }
  nodes.push({ kind: "parent-success", execution: -1 });
  return nodes;
}
function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function parallelOrders<T>(inputs: readonly T[], run: (input: T) => Promise<string[]>): Promise<string[][]> {
  const values: string[][] = [];
  for (let offset = 0; offset < inputs.length; offset += 10) {
    const settled = await Promise.allSettled(inputs.slice(offset, offset + 10).map(run));
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      values.push(result.value);
    }
  }
  return values;
}

async function runOrder(order: readonly Step[], reused: boolean): Promise<string[]> {
  // Given: actual hooks, stores and disk; only public child get is deferred.
  // The host coalesces concurrent lineage requests for a reused session. Thus
  // releasing either lookup releases that shared request; the second logical
  // resolution is already satisfied. Different children have independent gates.
  const dir = await realpath(await mkdtemp(join(tmpdir(), `gajae-todo-orders-${process.pid}-`)));
  const state = new StateStore(dir, async () => 1_800_000_000_000);
  const todo = new TodoStore(state);
  const children = ["ses_child1", reused ? "ses_child1" : "ses_child2"];
  const gates = new Map([...new Set(children)].map((id) => [id, barrier()]));
  const entered = new Map([...new Set(children)].map((id) => [id, barrier()]));
  const calls: Parameters<HostSession["synthetic"]>[0][] = [];
  const model = createPureLifecycle(PARENT, () => false);
  const session: HostSession = {
    async get({ sessionID }) {
      const gate = gates.get(sessionID);
      if (gate) {
        entered.get(sessionID)?.resolve();
        await gate.promise;
      }
      return { agent: sessionID === PARENT ? "open-gajae" : "open-gajae-executor",
        ...(sessionID === PARENT ? {} : { parentID: PARENT }), location: { directory: dir } };
    },
    async context() { return []; },
    async synthetic(input) { calls.push(input); return {}; },
  };
  const hooks = createHooks(state, session, PACKAGE, dir, dir);
  const sequences = new Map<string, number>();
  const event = (sessionID: string, type: string, data: Record<string, unknown> = {}) => {
    const seq = (sequences.get(sessionID) ?? 0) + 1;
    sequences.set(sessionID, seq);
    return { id: `evt_${sessionID}_${seq}`, type,
      durable: { aggregateID: sessionID, seq, version: 1 }, data: { sessionID, ...data } };
  };
  const modelEvent = (input: ReturnType<typeof event>) => model.event(input.type, input.data, {
    eventID: input.id, aggregateID: input.durable.aggregateID, seq: input.durable.seq,
  });
  const pending: Array<{ child: string; handling: Promise<void> }> = [];
  const failures: string[] = [];
  const released = new Set<string>();
  const launched = new Set<string>();
  let started = 0;
  let ended = 0;
  let delivered = 0;
  try {
    await todo.apply(PARENT, { op: "init", list: [{ phase: "Work", items: ["A", "B"] }] });
    await hooks.context({ sessionID: PARENT, agent: "open-gajae", messages: [] });
    // When: every topological order of starts, ends, inboxes, and lookups.
    for (const step of order) {
      const n = step.endsWith("1") ? 1 : 2;
      const child = children[n - 1];
      if (!child) throw new Error("missing fixture child");
      if (step.startsWith("lookup")) {
        gates.get(child)?.resolve();
        released.add(child);
        model.owner(child);
        // Both callbacks of a coalesced public lookup are drained, not timed.
        await Promise.all(pending.filter((entry) => released.has(entry.child)).map((entry) => entry.handling));
      } else {
        if (step.startsWith("start") && !launched.has(child)) {
          // These original schedules start with a fresh child, not an unknown
          // historical prefix. Native progress proves fresh creation without
          // resolving the deferred session.get lineage callback.
          launched.add(child);
          await hooks.executeBefore({ tool: "subagent", sessionID: PARENT, agent: "open-gajae",
            id: `launch_${child}`, input: { agent: "open-gajae-executor", prompt: "work",
              description: "work", background: true } });
          model.beforeTool(`launch_${child}`, true, true);
          const progress = event(PARENT, "session.tool.progress", {
            id: `launch_${child}`, metadata: { sessionID: child, status: "running" },
          });
          await hooks.onEvent(progress);
          modelEvent(progress);
        }
        const input = step.startsWith("start") ? event(child, "session.execution.started")
          : step.startsWith("end") ? event(child, "session.execution.succeeded")
          : step.startsWith("enqueue") ? event(PARENT, "session.inbox.enqueued", {
            inboxID: `msg_result${n}`, item: { type: "synthetic", payload: {
              text: `result ${n}`, metadata: { source: "subagent", childID: child, state: "completed" },
            } },
          }) : event(PARENT, "session.inbox.delivered", { inboxID: `msg_result${n}` });
        hooks.observeEvent(input);
        modelEvent(input);
        const handling = hooks.onEvent(input);
        if (step.startsWith("start") || step.startsWith("end")) {
          pending.push({ child, handling });
          if (step.startsWith("start")) {
            started++;
            await entered.get(child)?.promise;
          } else ended++;
          if (released.has(child)) await handling;
        } else {
          await handling;
          if (step.startsWith("deliver")) delivered++;
        }
      }
      // Then: independent conservation oracle at every occupied prefix.
      // An empty gap between jobs is legitimately eligible, so do not trigger
      // a parent turn there. Final eligibility is tested once after all events.
      if (started > delivered || started > ended) {
        model.lookupPending([...launched].some((id) => !released.has(id)));
        const start = event(PARENT, "session.execution.started");
        await hooks.onEvent(start);
        modelEvent(start);
        const success = event(PARENT, "session.execution.succeeded");
        await hooks.onEvent(success);
        modelEvent(success);
        if (calls.filter((call) => call.resume).length !== model.view().resumes) failures.push(`model:${step}`);
        if (calls.some((call) => call.resume)) failures.push(step);
      }
    }
    await Promise.all(pending.map((entry) => entry.handling));
    model.lookupPending(false);
    const success = event(PARENT, "session.execution.succeeded");
    await hooks.onEvent(success);
    modelEvent(success);
    if (calls.filter((call) => call.resume).length !== model.view().resumes) failures.push("model:final");
    if (calls.filter((call) => call.resume).length !== 1) failures.push("final");
    return failures;
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await Promise.all(pending.map((entry) => entry.handling));
    await hooks.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

for (const reused of [true, false]) {
  test(`exhaustive result obligations: ${reused ? "reused child" : "different-child control"}`, async () => {
    const schedules = orders();
    const failures: Array<{ order: readonly Step[]; boundaries: string[] }> = [];
    const results = FULL
      ? schedules.map((order) => runPureLifecycle(lookupSteps(order), ["background", "background"], false, -1,
        { reused, unknownHistory: false, terminal: "completed", cancelled: [] }))
      : await parallelOrders(schedules, (order) => runOrder(order, reused));
    for (const [index, boundaries] of results.entries()) {
      const order = schedules[index];
      if (boundaries.length && order) failures.push({ order, boundaries });
    }
    console.info(`TODO_INTERLEAVINGS ${JSON.stringify({
      reused, total: schedules.length, failing: failures.length, examples: failures.slice(0, 3),
      f2r1: failures.find(({ order }) => order.indexOf("start2") < order.indexOf("enqueue1") &&
        order.indexOf("deliver1") < order.indexOf("lookup1")),
    })}`);
    expect(failures).toEqual([]);
  }, 180_000);
}

function lifecycleOrders(channels: readonly Channel[], predecessor: boolean): LifecycleStep[][] {
  const nodes: Array<{ step: LifecycleStep; after: string[] }> = [];
  let previousBackground = predecessor ? 0 : undefined;
  for (const [index, channel] of channels.entries()) {
    const execution = index + 1;
    nodes.push({ step: { kind: "start", execution }, after: index ? [`end${index}`] : [] });
    nodes.push({ step: { kind: "end", execution }, after: [`start${execution}`] });
    if (channel === "background") {
      nodes.push({ step: { kind: "enqueue", execution }, after: [
        `end${execution}`, ...(previousBackground === undefined ? [] : [`enqueue${previousBackground}`]),
      ] });
      nodes.push({ step: { kind: "deliver", execution }, after: [
        `enqueue${execution}`, ...(previousBackground === undefined ? [] : [`deliver${previousBackground}`]),
      ] });
      previousBackground = execution;
    } else nodes.push({ step: { kind: "deliver", execution }, after: [`end${execution}`] });
  }
  if (predecessor) {
    // Its start/end predate observation. Its pending result may arrive at
    // any boundary, including after a newer execution has already ended.
    nodes.push({ step: { kind: "enqueue", execution: 0 }, after: [] });
    nodes.push({ step: { kind: "deliver", execution: 0 }, after: ["enqueue0"] });
  }
  function visit(prefix: LifecycleStep[], seen: Set<string>): LifecycleStep[][] {
    if (prefix.length === nodes.length) return [prefix];
    return nodes.filter(({ step, after }) => !seen.has(`${step.kind}${step.execution}`) &&
      after.every((key) => seen.has(key))).flatMap(({ step }) =>
      visit([...prefix, step], new Set([...seen, `${step.kind}${step.execution}`])));
  }
  return visit([], new Set());
}

async function runLifecycle(
  order: readonly LifecycleStep[], channels: readonly Channel[], predecessor: boolean, restart: number,
  options?: LifecycleOptions,
): Promise<string[]> {
  // Given: fresh real stores and disk. No private ledger state is inspected.
  const dir = await realpath(await mkdtemp(join(tmpdir(), `gajae-todo-lifecycle-${process.pid}-`)));
  const children = ["ses_child", options?.reused === false ? "ses_other" : "ses_child"];
  const running = new Set<number>();
  const model = createPureLifecycle(PARENT, (child) =>
    [...running].some((execution) => children[execution - 1] === child));
  const divergence: string[] = [];
  const idle = new Map<string, Set<ReturnType<typeof Promise.withResolvers<void>>>>();
  const calls: Parameters<HostSession["synthetic"]>[0][] = [];
  const releasedHold = Promise.withResolvers<void>();
  let accepted = Promise.withResolvers<void>();
  let sawHold = false;
  let lastChanged: Awaited<ReturnType<TodoStore["read"]>> | undefined;
  const session: HostSession = {
    async get({ sessionID }) {
      return { agent: sessionID === PARENT ? "open-gajae" : "open-gajae-executor",
        ...(sessionID === PARENT ? {} : { parentID: PARENT }), location: { directory: dir } };
    },
    async context() { return []; },
    async synthetic(input) {
      calls.push(input);
      if (input.resume) { accepted.resolve(); accepted = Promise.withResolvers<void>(); }
      return {};
    },
    async wait({ sessionID }, request) {
      if (![...running].some((execution) => children[execution - 1] === sessionID)) return;
      request?.signal?.throwIfAborted();
      const signal = Promise.withResolvers<void>();
      const waiting = idle.get(sessionID) ?? new Set();
      idle.set(sessionID, waiting);
      waiting.add(signal);
      const abort = () => signal.reject(request?.signal?.reason);
      request?.signal?.addEventListener("abort", abort, { once: true });
      try { await signal.promise; }
      finally { waiting.delete(signal); request?.signal?.removeEventListener("abort", abort); }
    },
  };
  const make = () => {
    const current = createHooks(new StateStore(dir, async () => 1_800_000_000_000), session, PACKAGE, dir, dir);
    current.configureTodo({ enabled: true, continuation: true, stagnationLimit: 3, failureLimit: 5 }, async (view) => {
      if (view.sessionID !== PARENT) return;
      lastChanged = view;
      if (view.status === "ready" && view.hold?.reason.startsWith("child_result")) sawHold = true;
      if (sawHold && view.status === "ready" && view.hold === null) releasedHold.resolve();
    });
    return current;
  };
  let hooks = make();
  const todo = new TodoStore(new StateStore(dir, async () => 1_800_000_000_000));
  const disk = new StateStore(dir, async () => 1_800_000_000_000);
  const sequences = new Map<string, number>();
  const compare = async (boundary: string) => {
    const predicted = model.view();
    if (calls.filter((call) => call.resume).length < predicted.resumes) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([accepted.promise, new Promise<void>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`missing recovery acceptance at ${boundary}`)), 2_000);
        })]);
      } finally { clearTimeout(timeout); }
    }
    const actual = await todo.read(PARENT);
    const count = calls.filter((call) => call.resume).length;
    if (count !== predicted.resumes || actual.status !== "ready" || (actual.hold?.reason ?? null) !== predicted.hold)
      divergence.push(`model:${boundary}:real=${count}/${actual.status === "ready" ? actual.hold?.reason : actual.status}:pure=${predicted.resumes}/${predicted.hold}`);
  };
  const emit = async (sessionID: string, type: string, data: Record<string, unknown> = {}) => {
    const seq = (sequences.get(sessionID) ?? 0) + 1;
    sequences.set(sessionID, seq);
    const eventID = `evt_${sessionID}_${seq}`;
    await hooks.onEvent({ id: eventID, type,
      durable: { aggregateID: sessionID, seq, version: 1 }, data: { sessionID, ...data } });
    model.event(type, { sessionID, ...data }, { eventID, aggregateID: sessionID, seq });
    if (sessionID === PARENT && type === "session.execution.succeeded") {
      await compare(type);
    }
  };
  const outstanding = new Set<number>(predecessor ? [0] : []);
  const waived = new Set<number>();
  const cancelled = new Set<number>();
  const started = new Set<number>();
  const unknownChildren = new Set<string>();
  const failures: string[] = [];
  const count = () => calls.filter((call) => call.resume).length;
  try {
    await todo.apply(PARENT, { op: "init", list: [{ phase: "Work", items: ["A", "B"] }] });
    await hooks.context({ sessionID: PARENT, agent: "open-gajae", messages: [] });
    // When: every linear extension, with no restart or one replacement at
    // each boundary (including before the first and after the last event).
    for (let index = 0; index <= order.length; index++) {
      if (index === restart) {
        const accepted = count();
        await hooks.dispose();
        hooks = make();
        model.restart();
        await hooks.context({ sessionID: PARENT, agent: "open-gajae", messages: [] });
        if (count() !== accepted) failures.push(`restore${index}`);
      }
      const step = order[index];
      if (!step) break;
      const previouslyAccepted = count();
      const child = children[Math.max(step.execution - 1, 0)];
      if (!child) throw new Error("missing lifecycle child");
      const toolID = `tool_${step.execution}`;
      const inboxID = `msg_${step.execution}`;
      switch (step.kind) {
        case "parent-start":
          await emit(PARENT, "session.execution.started");
          break;
        case "parent-success":
          await emit(PARENT, "session.execution.succeeded");
          break;
        case "start":
          {
            if (options?.unknownHistory) unknownChildren.add(child);
            model.beforeTool(toolID, channels[step.execution - 1] === "background",
              !(predecessor || options?.unknownHistory ||
                [...started].some((execution) => children[execution - 1] === child)));
            await hooks.executeBefore({ tool: "subagent", sessionID: PARENT, agent: "open-gajae",
              id: toolID, input: { agent: "open-gajae-executor", prompt: "work", description: "work",
                background: channels[step.execution - 1] === "background",
                ...(predecessor || options?.unknownHistory ||
                  [...started].some((execution) => children[execution - 1] === child) ? { sessionID: child } : {}) } });
            await emit(PARENT, "session.tool.progress", {
              id: toolID, metadata: { sessionID: child, status: "running" },
            });
          }
          await emit(child, "session.execution.started");
          if (channels[step.execution - 1] === "background")
            await emit(PARENT, "session.tool.success", {
              id: toolID, metadata: { sessionID: child, status: "running" },
            });
          running.add(step.execution);
          started.add(step.execution);
          outstanding.add(step.execution);
          break;
        case "end":
          await emit(child, options?.terminal === "error" ? "session.execution.failed" :
            options?.terminal === "cancelled" ? "session.execution.interrupted" : "session.execution.succeeded",
          { reason: "user", error: { type: "test", message: "terminal" } });
          running.delete(step.execution);
          break;
        case "idle":
          {
            const waiting = [...idle.get(child) ?? []];
            const predictedIdle = model.idle(child);
            if (!!waiting.length !== predictedIdle) return ["model:idle-subscription"];
            if (!waiting.length) break;
            // Wait for the actual acknowledgement write before the next native
            // event. Resolving a promise and immediately injecting another event
            // would leave its position to the JS/IO scheduler rather than this order.
            const stateDir = join(await disk.resolveSessionDir(child), "state");
            const committed = Promise.withResolvers<void>();
            const path = join(stateDir, "todo-child-results.json");
            const listeners = renameCommitted.get(path) ?? new Set();
            listeners.add(committed.resolve);
            renameCommitted.set(path, listeners);
            const timeout = setTimeout(() => committed.reject(new Error("idle acknowledgement did not commit")), 2_000);
            try {
              for (const signal of waiting) signal.resolve();
              await committed.promise;
              await disk.workflowTransaction(child, async (tx) => {
                await tx.readBytes(join(tx.paths.sessionDir, "state", "todo-child-results.json"));
              });
            } finally {
              clearTimeout(timeout);
              listeners.delete(committed.resolve);
              if (!listeners.size) renameCommitted.delete(path);
              for (const signal of waiting) signal.resolve();
            }
            if (model.view().hold === null && model.view().changedHold === null) {
              let timeout: ReturnType<typeof setTimeout> | undefined;
              const published = await Promise.race([releasedHold.promise.then(() => true),
                new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 2_000); })]);
              clearTimeout(timeout);
              if (!published) return ["model:idle-publication"];
            }
            const view = await todo.read(PARENT);
            if (view.status !== "ready" || (view.hold?.reason ?? null) !== model.view().hold)
              return ["model:idle-canonical-hold"];
            if (options?.checkIdle) {
              if (view.hold !== null || lastChanged?.status !== "ready" || lastChanged.hold !== null) {
                return ["idle-projection-not-published"];
              }
            }
            await compare("idle");
          }
          break;
        case "enqueue":
          await emit(PARENT, "session.inbox.enqueued", { inboxID, item: { type: "synthetic", payload: {
            text: "result", metadata: { source: "subagent", childID: child, state: options?.terminal ?? "completed" },
          } } });
          break;
        case "deliver":
          if (step.execution === 0 || channels[step.execution - 1] === "background") {
            if (options?.cancelled.includes(step.execution)) {
              await emit(PARENT, "session.inbox.cancelled", { inboxID });
              cancelled.add(step.execution);
            } else {
              await emit(PARENT, "session.inbox.delivered", { inboxID });
              outstanding.delete(step.execution);
            }
          } else {
            await emit(PARENT, options && options.terminal !== "completed" ? "session.tool.failed" : "session.tool.success", {
              id: toolID, metadata: { sessionID: child, status: options && options.terminal !== "completed" ? "running" : "completed" },
              error: { type: "tool.execution", message: "terminal" },
            });
            outstanding.delete(step.execution);
          }
          break;
        case "user-enqueue":
          await emit(PARENT, "session.inbox.enqueued", { inboxID: "msg_user_schedule", item: {
            type: "user", payload: { text: "Continue with the current work." },
          } });
          break;
        case "user-deliver":
          for (const execution of started)
            if (unknownChildren.has(children[execution - 1] ?? "") || cancelled.has(execution)) waived.add(execution);
          await emit(PARENT, "session.execution.started");
          await emit(PARENT, "session.inbox.delivered", { inboxID: "msg_user_schedule" });
          break;
        case "lookup":
          model.owner(child);
          break;
      }
      // Then: the oracle knows only actual executions and delivered outcomes.
      // Observation only: parent successes belong to explicit generated nodes.
      if (running.size || [...outstanding].some((execution) => !waived.has(execution))) {
        if (divergence.length) return divergence;
        if (count() !== previouslyAccepted) return [`premature:${step.kind}${step.execution}`];
        if (options && !running.size && [...cancelled].some((execution) => !waived.has(execution))) {
          const view = await todo.read(PARENT);
          if (view.status !== "ready" || !view.hold?.reason.startsWith("child_result"))
            return [`silent-cancellation:${step.kind}${step.execution}`];
        }
      }
    }
    if (divergence.length) return divergence;
    const final = await todo.read(PARENT);
    if (count() === 0 && (final.status !== "ready" ||
      (final.counts.open > 0 && !final.hold))) failures.push("silent-final");
    if (new Set(calls.filter((call) => call.resume).map((call) => call.metadata?.eventID)).size !== count())
      failures.push("duplicate-final");
    return failures;
  } finally {
    await hooks.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

test("R4-B1: pure admission in flight retains triggers through every settle ordering", () => {
  const failures: unknown[] = [];
  const outcomes = new Set<string>();
  let total = 0;
  for (const recovery of [false, true]) {
    for (const order of admissionOrders()) {
      total++;
      const result = runPureAdmission(order, recovery);
      for (const outcome of result.outcomes) outcomes.add(outcome);
      if (result.failures.length) failures.push({ recovery, order, ...result });
    }
  }
  console.info("TODO_ADMISSION_INTERLEAVINGS", JSON.stringify({
    total, failing: failures.length, outcomes: [...outcomes], examples: failures.slice(0, 4),
  }));
  expect([...outcomes].sort()).toEqual(["cancelled", "cas-lost", "committed"]);
  expect(failures).toEqual([]);
});

function* userOrders(order: readonly LifecycleStep[]): Generator<readonly LifecycleStep[]> {
  for (let enqueue = 0; enqueue <= order.length; enqueue++) {
    for (let deliver = enqueue; deliver <= order.length; deliver++) {
      const admitted: LifecycleStep[] = [
        ...order.slice(0, enqueue), { kind: "user-enqueue", execution: -1 },
        ...order.slice(enqueue, deliver), { kind: "user-deliver", execution: -1 },
        ...order.slice(deliver),
      ];
      const active = new Set<number>();
      for (const step of admitted) {
        if (step.kind === "user-deliver") break;
        if (step.kind === "start") active.add(step.execution);
        if (step.kind === "end") active.delete(step.execution);
      }
      const execution = [...active][0];
      if (execution === undefined) { yield admitted; continue; }
      const ended = admitted.findIndex((step) => step.kind === "end" && step.execution === execution);
      for (let idle = ended + 1; idle <= admitted.length; idle++)
        yield [...admitted.slice(0, idle), { kind: "idle", execution }, ...admitted.slice(idle)];
    }
  }
}

type RecoverySchedule = {
  readonly order: readonly LifecycleStep[];
  readonly restart: number;
  readonly options?: LifecycleOptions;
};
function* terminalOrders(order: readonly LifecycleStep[]): Generator<readonly LifecycleStep[]> {
  // A real parent turn follows its delivered inputs. Deferred idle replies
  // are independent: enumerate success on either side of those trailing replies.
  const lastInput = order.findLastIndex((step) => step.kind !== "idle");
  for (let position = lastInput + 1; position <= order.length; position++)
    yield [...order.slice(0, position), { kind: "parent-success", execution: -1 }, ...order.slice(position)];
}
function* boundaryCover(schedules: Iterable<RecoverySchedule>, channels: readonly Channel[]): Generator<RecoverySchedule> {
  const covered = new Set<string>();
  for (const schedule of schedules) {
    const labels = schedule.order.map((step) => {
      if (step.kind === "end") return `${schedule.options?.terminal ?? "completed"}${step.execution}`;
      if (step.kind === "deliver") return `${step.execution === 0 || channels[step.execution - 1] === "background"
        ? schedule.options?.cancelled.includes(step.execution) ? "inbox-cancelled" : "inbox-delivered"
        : "tool-terminal"}${step.execution}`;
      return `${step.kind}${step.execution}`;
    });
    const acknowledgement = schedule.order.findIndex((step) => step.kind === "user-deliver");
    const features = [
      `options:${schedule.options?.reused}:${schedule.options?.unknownHistory}:${schedule.options?.cancelled.join(",")}`,
      `ownership:${schedule.options?.ownership?.resolution}:${schedule.options?.ownership?.boundary}`,
      `ownership-restart-order:${schedule.options?.ownership?.beforeRestart}`,
      `ownership-restart:${schedule.options?.ownership?.resolution}:${Math.sign(
        (schedule.options?.ownership?.boundary ?? -1) - schedule.restart)}`,
      `restart:${schedule.restart}`,
      `before-restart:${schedule.restart}:${labels[schedule.restart] ?? "end"}`,
      `after-restart:${schedule.restart}:${labels[schedule.restart - 1] ?? "begin"}`,
      ...labels.map((label, index) => `event:${index}:${label}`),
      ...labels.map((label, index) => `ack:${label}:${Math.sign(acknowledgement - index)}`),
    ];
    // Fixed generator order, no randomness or production-state feedback.
    // Select whenever a legal event/boundary or option signature is uncovered.
    if (features.some((feature) => !covered.has(feature))) {
      for (const feature of features) covered.add(feature);
      yield schedule;
    }
  }
}
async function recoveryMatrix(schedules: Iterable<RecoverySchedule>, channels: readonly Channel[], predecessor = false) {
  let total = 0;
  let failing = 0;
  const failuresByKind: Record<string, number> = {};
  const examples: Array<RecoverySchedule & { boundaries: string[] }> = [];
  function recordFailure(input: RecoverySchedule, boundaries: string[]) {
    failing++;
    for (const boundary of new Set(boundaries.map((value) => value.split(":")[0])))
      if (boundary) failuresByKind[boundary] = (failuresByKind[boundary] ?? 0) + 1;
    if (examples.length < 3) examples.push({ ...input, boundaries });
  }
  if (FULL) {
    for (const input of schedules) {
      total++;
      const boundaries = runPureLifecycle(input.order, channels, predecessor, input.restart, input.options);
      if (boundaries.length) recordFailure(input, boundaries);
    }
    return { total, failing, failuresByKind, examples };
  }
  let batch: RecoverySchedule[] = [];
  const drain = async () => {
    // Independent real-filesystem fixtures; bounded to this host's ten cores.
    // Every handler within a fixture remains deterministically ordered.
    const results = await Promise.allSettled(batch.map((input) =>
      runLifecycle(input.order, channels, predecessor, input.restart, input.options)));
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") throw result.reason;
      total++;
      const input = batch[index];
      if (result.value.length && input) recordFailure(input, result.value);
    }
    batch = [];
  };
  for (const schedule of boundaryCover(schedules, channels)) {
    batch.push(schedule);
    if (batch.length === 10) await drain();
  }
  if (batch.length) await drain();
  return { total, failing, failuresByKind, examples };
}

for (const first of ["foreground", "background"] as const) {
  for (const second of ["foreground", "background"] as const) {
    test(`${MODE} location ownership: ${first}/${second}`, () => {
      const channels = [first, second];
      function* schedules(): Generator<RecoverySchedule> {
        const backgrounds = channels.flatMap((channel, index) => channel === "background" ? [index + 1] : []);
        for (const terminal of ["completed", "error", "cancelled"] as const)
        for (let mask = 0; mask < 2 ** backgrounds.length; mask++) {
          const cancelled = backgrounds.filter((_execution, index) => (mask & (1 << index)) !== 0);
          for (const core of lifecycleOrders(channels, false))
          for (const admitted of userOrders(core))
          for (const order of terminalOrders(admitted))
          for (let restart = -1; restart <= order.length; restart++)
          for (const resolution of ["unknown", "local", "foreign"] as const)
          for (let boundary = 0; boundary <= (resolution === "unknown" ? 0 : order.length); boundary++)
          for (const beforeRestart of boundary === restart && resolution !== "unknown" ? [false, true] : [false])
            yield { order, restart, options: { reused: true, unknownHistory: false, terminal, cancelled,
              ownership: { resolution, boundary, beforeRestart } } };
        }
      }
      let total = 0;
      let failing = 0;
      const failuresByKind: Record<string, number> = {};
      const examples: unknown[] = [];
      // Ownership extends the production pure core. The default suite keeps
      // a fixed event/boundary cover, alongside real-module ownership traces.
      for (const input of FULL ? schedules() : boundaryCover(schedules(), channels)) {
        total++;
        const failures = runPureLifecycle(input.order, channels, false, input.restart, input.options);
        if (!failures.length) continue;
        failing++;
        for (const failure of failures) failuresByKind[failure] = (failuresByKind[failure] ?? 0) + 1;
        if (examples.length < 3) examples.push({ ...input, failures });
      }
      console.info(`TODO_OWNERSHIP_INTERLEAVINGS ${JSON.stringify({ mode: MODE, channels,
        total, failing, failuresByKind, examples })}`);
      expect(failing).toBe(0);
    }, 900_000);
  }
}

for (const first of ["foreground", "background"] as const) {
  for (const second of ["foreground", "background"] as const) {
    for (const terminal of ["completed", "error", "cancelled"] as const) {
      test(`${MODE} recovery boundaries: ${first}/${second}, terminal=${terminal}`, async () => {
        const channels = [first, second];
        function* schedules(): Generator<RecoverySchedule> {
          for (const reused of [false, true]) {
            for (const unknownHistory of [false, true]) {
              const backgrounds = channels.flatMap((channel, index) => channel === "background" ? [index + 1] : []);
              for (let mask = 0; mask < 2 ** backgrounds.length; mask++) {
                const cancelled = backgrounds.filter((_execution, index) => (mask & (1 << index)) !== 0);
                for (const core of lifecycleOrders(channels, false)) {
                  for (const admitted of userOrders(core)) {
                    for (const order of terminalOrders(admitted)) {
                    for (let restart = -1; restart <= order.length; restart++)
                      yield { order, restart, options: { reused, unknownHistory, terminal, cancelled } };
                    }
                  }
                }
              }
            }
          }
        }
        const summary = await recoveryMatrix(schedules(), channels);
        console.info(`TODO_RECOVERY_INTERLEAVINGS ${JSON.stringify({ mode: MODE, channels, terminal, ...summary })}`);
        expect(summary.failing).toBe(0);
      }, 900_000);
    }
  }
}

test("exhaustive delayed idle publication after acknowledgement and parent success", async () => {
  let total = 0;
  let failing = 0;
  const examples: unknown[] = [];
  for (const first of ["foreground", "background"] as const) {
    for (const second of ["foreground", "background"] as const) {
      const channels = [first, second];
      const core = lifecycleOrders(channels, false)[0];
      if (!core) throw new Error("missing idle-confirmation schedule");
      const firstEnd = core.findIndex((step) => step.kind === "end" && step.execution === 1);
      const ended = core[firstEnd];
      if (!ended) throw new Error("missing first execution end");
      const order: LifecycleStep[] = [
        ...core.slice(0, firstEnd), { kind: "user-enqueue", execution: -1 },
        { kind: "user-deliver", execution: -1 }, ended,
        { kind: "idle", execution: 1 }, ...core.slice(firstEnd + 1),
      ];
      const schedules: RecoverySchedule[] = [];
      for (const reused of [false, true]) {
        for (const terminal of ["completed", "error", "cancelled"] as const)
          for (const terminalOrder of terminalOrders(order)) schedules.push({ order: terminalOrder, restart: 1,
            options: { reused, unknownHistory: true, terminal, cancelled: [], checkIdle: true } });
      }
      const summary = await recoveryMatrix(schedules, channels);
      total += summary.total;
      failing += summary.failing;
      examples.push(...summary.examples);
    }
  }
  console.info(`TODO_IDLE_INTERLEAVINGS ${JSON.stringify({ total, failing, examples })}`);
  expect(failing).toBe(0);
}, 30_000);

for (const first of ["foreground", "background"] as const) {
  for (const second of ["foreground", "background"] as const) {
    for (const predecessor of [false, true]) {
      test(`${MODE} replacement and channels: ${first}/${second}, predecessor=${predecessor}`, async () => {
        const channels = [first, second];
        const schedules = lifecycleOrders(channels, predecessor);
        function* replacements(): Generator<RecoverySchedule> {
          for (const core of schedules)
            for (const order of terminalOrders(core))
            for (let restart = -1; restart <= order.length; restart++) yield { order, restart };
        }
        const summary = await recoveryMatrix(replacements(), channels, predecessor);
        console.info(`TODO_LIFECYCLE_INTERLEAVINGS ${JSON.stringify({ mode: MODE, channels, predecessor, ...summary })}`);
        expect(summary.failing).toBe(0);
      }, 180_000);
    }
  }
}
