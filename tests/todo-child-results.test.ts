import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHooks, type HostSession } from "../src/hooks";
import { StateStore } from "../src/state";
import { TodoStore } from "../src/todo/store";

const P = "ses_parent";
const C = "ses_child";
const PACKAGE = new URL("../", import.meta.url).pathname;
async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, knownHistory = true) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), `gajae-child-results-${process.pid}-`)));
  const f = await setup(dir, knownHistory);
  try { await body(f); }
  finally { await f.dispose(); await rm(dir, { recursive: true, force: true }); }
}
async function setup(dir: string, knownHistory: boolean) {
  const calls: Parameters<HostSession["synthetic"]>[0][] = [];
  const changes: Array<Awaited<ReturnType<TodoStore["read"]>>> = [];
  const listeners = new Set<(view: Awaited<ReturnType<TodoStore["read"]>>) => void>();
  const session: HostSession = {
    async get({ sessionID }) {
      return { agent: sessionID === P ? "open-gajae" : "open-gajae-executor",
        ...(sessionID === P ? {} : { parentID: P }), location: { directory: dir } };
    },
    async context() { return []; },
    async synthetic(input) { calls.push(input); return {}; },
  };
  const make = () => {
    const current = createHooks(new StateStore(dir, async () => 1_800_000_000_000), session, PACKAGE, dir, dir);
    current.configureTodo({ enabled: true, continuation: true, stagnationLimit: 3, failureLimit: 5 }, async (view) => {
      changes.push(view);
      for (const listener of listeners) listener(view);
    });
    return current;
  };
  let hooks = make();
  if (knownHistory) hooks.observeEvent({ type: "session.created", data: {
    sessionID: C, parentID: P, location: { directory: dir },
  } });
  const todo = new TodoStore(new StateStore(dir, async () => 1_800_000_000_000));
  await todo.apply(P, { op: "init", list: [{ phase: "Work", items: ["A", "B"] }] });
  await hooks.context({ sessionID: P, agent: "open-gajae", messages: [] });
  const seq = new Map<string, number>();
  let userMessages = 0;
  const emit = async (id: string, type: string, data: Record<string, unknown> = {}, directory?: string) => {
    const n = (seq.get(id) ?? 0) + 1;
    seq.set(id, n);
    const event = { id: `evt_${id}_${n}`, type, ...(directory ? { location: { directory } } : {}),
      durable: { aggregateID: id, seq: n, version: 1 }, data: { sessionID: id, ...data } };
    await hooks.onEvent(event);
    return event;
  };
  return {
    dir, session, todo, changes,
    count(sessionID: string) { return calls.filter((call) => call.resume && call.sessionID === sessionID).length; },
    onChanged(listener: (view: Awaited<ReturnType<TodoStore["read"]>>) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit,
    replay(event: Awaited<ReturnType<typeof emit>>) { return hooks.onEvent(event); },
    async prepare(toolID: string, background: boolean, existing = false) {
      await hooks.executeBefore({ tool: "subagent", sessionID: P, agent: "open-gajae",
        id: toolID, input: { agent: "open-gajae-executor", prompt: "work", description: "work", background,
          ...(existing ? { sessionID: C } : {}) } });
      await emit(P, "session.tool.progress", { id: toolID, metadata: { sessionID: C, status: "running" } });
    },
    async start(toolID?: string) {
      if (toolID) {
        await hooks.executeBefore({ tool: "subagent", sessionID: P, agent: "open-gajae",
          id: toolID, input: { agent: "open-gajae-executor", prompt: "work", description: "work" } });
        await emit(P, "session.tool.progress", { id: toolID, metadata: { sessionID: C, status: "running" } });
      }
      await emit(C, "session.execution.started");
    },
    result(inboxID: string, outcome = "completed") {
      return emit(P, "session.inbox.enqueued", { inboxID, item: { type: "synthetic", payload: {
        text: "result", metadata: { source: "subagent", childID: C, state: outcome },
      } } });
    },
    deliver(inboxID: string) { return emit(P, "session.inbox.delivered", { inboxID }); },
    async user() {
      const inboxID = `msg_user_${++userMessages}`;
      await emit(P, "session.inbox.enqueued", { inboxID, item: {
        type: "user", payload: { text: "Continue the current work." },
      } });
      await emit(P, "session.execution.started");
      await emit(P, "session.inbox.delivered", { inboxID });
    },
    async check(expected: number) {
      const event = await emit(P, "session.execution.succeeded");
      expect(calls.filter((call) => call.resume)).toHaveLength(expected);
      return event;
    },
    async restart() {
      await hooks.dispose();
      hooks = make();
      await hooks.context({ sessionID: P, agent: "open-gajae", messages: [] });
      expect(calls.filter((call) => call.resume)).toHaveLength(0);
    },
    async replaceDuringLookup() {
      const disposed = hooks.dispose();
      hooks = make();
      await hooks.context({ sessionID: P, agent: "open-gajae", messages: [] });
      return { disposed };
    },
    async recover() {
      await todo.apply(P, { op: "view" });
      const input = { op: "start", task: "B" };
      await hooks.executeBefore({ tool: "todo", sessionID: P, agent: "open-gajae", id: "recover", input });
      expect((await todo.apply(P, input)).disposition).toBe("applied");
      await hooks.executeAfter({ tool: "todo", sessionID: P, agent: "open-gajae",
        id: "recover", status: "success" });
    },
    dispose() { return hooks.dispose(); },
  };
}

test("replayed forgotten child events cannot hold the parent after backend restart", async () => {
  await fixture(async (f) => {
    const started = await f.emit(C, "session.execution.started");
    const ended = await f.emit(C, "session.execution.succeeded");
    const enqueued = await f.result("settled");
    const delivered = await f.deliver("settled");
    await f.restart();
    for (const event of [started, ended, enqueued, delivered, started])
      await f.replay(structuredClone(event));
    await f.check(1);
    expect(await f.todo.read(P)).toMatchObject({ hold: null });
  });
});

for (const mode of ["no-foreign-event", "explicit-envelope-location", "lookup-only-location"] as const) {
  test(`F2-FINAL-1: unrelated local parent with ${mode}`, async () => {
    await fixture(async (f) => {
      const foreign = "ses_foreign_child";
      const get = f.session.get;
      f.session.get = async (input) => input.sessionID === foreign
        ? { agent: "open-gajae-executor", parentID: "ses_foreign_parent",
          location: { directory: "/foreign" } } : get(input);
      // Given: the same real adapter/store schedule, differing only in
      // whether location isolation is known at observation or lookup.
      if (mode !== "no-foreign-event") {
        const directory = mode === "explicit-envelope-location" ? "/foreign" : undefined;
        await f.emit(foreign, "session.execution.started", {}, directory);
        await f.emit(foreign, "session.execution.succeeded", {}, directory);
      }
      // When: a local terminal, then a genuine local user turn.
      await f.emit(P, "session.execution.succeeded");
      const beforeUser = f.count(P);
      await f.user();
      await f.emit(P, "session.execution.succeeded");
      const afterUser = f.count(P);
      const view = await f.todo.read(P);
      console.info(`TODO_LOCATION_CONTROL ${JSON.stringify({ mode, beforeUser, afterUser,
        hold: view.status === "ready" ? view.hold : view.status })}`);
      // Then: foreign observations never spend or suppress local admission.
      expect(beforeUser).toBe(1);
      expect(afterUser).toBe(2);
      expect(view).toMatchObject({ status: "ready", hold: null });
    }, false);
  });
}

test("F2-FINAL-1: unknown ownership is visibly held and user recoverable", async () => {
  await fixture(async (f) => {
    const get = f.session.get;
    f.session.get = async (input) => input.sessionID === C
      ? { agent: "open-gajae-executor" } : get(input);
    await f.start();
    await f.emit(C, "session.execution.succeeded");
    await f.check(0);
    expect(await f.todo.read(P)).toMatchObject({ hold: { reason: "child_result_ambiguous" } });
    await f.user();
    await f.check(1);
  }, false);
});

for (const resolution of ["unknown", "local", "foreign"] as const) {
  test(`F2-FINAL-1: unresolved sidecar restores as ${resolution}`, async () => {
    await fixture(async (f) => {
      const get = f.session.get;
      let resolved = false;
      f.session.get = async (input) => input.sessionID !== C ? get(input) :
        !resolved || resolution === "unknown" ? { agent: "open-gajae-executor" } :
          resolution === "foreign" ? { location: { directory: "/foreign" }, parentID: "foreign_parent" } : get(input);
      await f.start();
      await f.emit(C, "session.execution.succeeded");
      resolved = true;
      await f.restart();
      await f.check(resolution === "foreign" ? 1 : 0);
      if (resolution !== "foreign") {
        expect(await f.todo.read(P)).toMatchObject({ hold: { reason: "child_result_ambiguous" } });
        await f.user();
        await f.check(1);
      }
    }, false);
  });
}

test("F2-FINAL-1: late foreign lookup releases a deferred terminal without another event", async () => {
  await fixture(async (f) => {
    const get = f.session.get;
    const entered = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<void>();
    const accepted = Promise.withResolvers<void>();
    f.session.get = async (input) => {
      if (input.sessionID !== C) return get(input);
      entered.resolve();
      await lookup.promise;
      return { location: { directory: "/foreign" }, parentID: "foreign_parent" };
    };
    const synthetic = f.session.synthetic;
    f.session.synthetic = async (input, options) => {
      const result = await synthetic(input, options);
      if (input.resume) accepted.resolve();
      return result;
    };
    const started = f.start();
    await entered.promise;
    const ended = f.emit(C, "session.execution.succeeded");
    try {
      await f.check(0);
      expect(await f.todo.read(P)).toMatchObject({ hold: { reason: "child_result_ambiguous" } });
      const timeout = setTimeout(() => accepted.reject(new Error("foreign resolution lost deferred terminal")), 2_000);
      try {
        lookup.resolve();
        await Promise.all([started, ended, accepted.promise]);
        expect(f.count(P)).toBe(1);
        expect(await f.todo.read(P)).toMatchObject({ hold: null });
      } finally { clearTimeout(timeout); }
    } finally {
      lookup.resolve();
      await Promise.all([started, ended]);
    }
  }, false);
});

test("F2-FINAL-1: unknown ownership user waiver is parent and execution scoped", async () => {
  await fixture(async (f) => {
    const other = "ses_other_parent";
    const get = f.session.get;
    f.session.get = async (input) => input.sessionID === C ? { agent: "open-gajae-executor" } :
      input.sessionID === other ? get({ sessionID: P }) : get(input);
    await f.todo.apply(other, { op: "init", list: [{ phase: "Work", items: ["X", "Y"] }] });
    await f.start();
    await f.emit(C, "session.execution.succeeded");
    await f.check(0);
    await f.user();
    await f.check(1);
    await f.emit(other, "session.execution.succeeded");
    expect(f.count(other)).toBe(0);
    expect(await f.todo.read(other)).toMatchObject({ hold: { reason: "child_result_ambiguous" } });
    await f.start();
    await f.emit(C, "session.execution.succeeded");
    await f.emit(P, "session.execution.started");
    await f.emit(P, "session.execution.succeeded");
    expect(f.count(P)).toBe(1);
    expect(await f.todo.read(P)).toMatchObject({ hold: { reason: "child_result_ambiguous" } });
  }, false);
});

test("F2-FINAL-1: foreign exclusion survives later lineage events and replacement", async () => {
  await fixture(async (f) => {
    const get = f.session.get;
    f.session.get = async (input) => input.sessionID === C
      ? { location: { directory: "/foreign" }, parentID: "foreign_parent" } : get(input);
    await f.start();
    await f.emit(C, "session.execution.succeeded");
    await f.emit(C, "session.created", { parentID: P });
    await f.start();
    await f.emit(C, "session.execution.succeeded");
    await f.restart();
    await f.check(1);
    expect(await f.todo.read(P)).toMatchObject({ status: "ready", hold: null });
  }, false);
});

test("F2-FINAL-1: a user can waive unknown ownership while its lookup remains pending", async () => {
  await fixture(async (f) => {
    const get = f.session.get;
    const entered = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<void>();
    f.session.get = async (input) => {
      if (input.sessionID !== C) return get(input);
      entered.resolve();
      await lookup.promise;
      return { agent: "open-gajae-executor" };
    };
    const started = f.start();
    await entered.promise;
    const ended = f.emit(C, "session.execution.succeeded");
    try {
      await f.check(0);
      expect(await f.todo.read(P)).toMatchObject({ hold: { reason: "child_result_ambiguous" } });
      await f.user();
      await f.check(1);
    } finally {
      lookup.resolve();
      await Promise.all([started, ended]);
    }
  }, false);
});

test("F2-FINAL-1: a later foreign envelope excludes an earlier unknown observation", async () => {
  await fixture(async (f) => {
    const get = f.session.get;
    f.session.get = async (input) => input.sessionID === C ? { agent: "open-gajae-executor" } : get(input);
    await f.start();
    await f.emit(C, "session.execution.succeeded", {}, "/foreign");
    await f.check(1);
    expect(await f.todo.read(P)).toMatchObject({ hold: null });
  }, false);
});

test("F2-FINAL-1: disposal cancels an unresolved ownership lookup", async () => {
  await fixture(async (f) => {
    const get = f.session.get;
    const entered = Promise.withResolvers<void>();
    let aborted = false;
    f.session.get = async (input, options) => {
      if (input.sessionID !== C) return get(input, options);
      const signal = options?.signal;
      if (!signal) throw new Error("ownership lookup has no lifetime signal");
      signal.throwIfAborted();
      const stopped = Promise.withResolvers<never>();
      signal.addEventListener("abort", () => {
        aborted = true;
        stopped.reject(signal.reason);
      }, { once: true });
      entered.resolve();
      return stopped.promise;
    };
    const started = f.start();
    await entered.promise;
    await f.dispose();
    await started;
    expect(aborted).toBe(true);
    expect(f.count(P)).toBe(0);
  }, false);
});

test("F2-FINAL-1: foreign resolution cancels an earlier unknown-child idle wait", async () => {
  await fixture(async (f) => {
    const get = f.session.get;
    const lookupEntered = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    const idle = Promise.withResolvers<void>();
    const accepted = Promise.withResolvers<void>();
    let aborted = false;
    f.session.get = async (input) => {
      if (input.sessionID !== C) return get(input);
      lookupEntered.resolve();
      await lookup.promise;
      return { location: { directory: "/foreign" }, parentID: "foreign_parent" };
    };
    f.session.wait = async (_input, options) => {
      const abort = () => { aborted = true; idle.reject(options?.signal?.reason); };
      options?.signal?.addEventListener("abort", abort, { once: true });
      waiting.resolve();
      try { await idle.promise; }
      finally { options?.signal?.removeEventListener("abort", abort); }
    };
    const synthetic = f.session.synthetic;
    f.session.synthetic = async (input, options) => {
      const result = await synthetic(input, options);
      if (input.resume) accepted.resolve();
      return result;
    };
    const started = f.start();
    await lookupEntered.promise;
    try {
      await f.check(0);
      await f.user();
      await waiting.promise;
      await f.check(0);
      const timeout = setTimeout(() => accepted.reject(new Error("foreign child idle wait still vetoes local parent")), 2_000);
      try {
        lookup.resolve();
        await Promise.all([started, accepted.promise]);
        expect(f.count(P)).toBe(1);
        expect(aborted).toBe(true);
        expect(await f.todo.read(P)).toMatchObject({ hold: null });
      } finally { clearTimeout(timeout); }
    } finally {
      lookup.resolve();
      idle.resolve();
      await started;
    }
  }, false);
});

test("F2-FINAL-1: positive lineage survives a local lookup with omitted parent metadata", async () => {
  await fixture(async (f) => {
    const get = f.session.get;
    f.session.get = async (input) => input.sessionID === C
      ? { ...(await get({ sessionID: P })), agent: "open-gajae-executor" } : get(input);
    await f.start();
    await f.emit(C, "session.execution.succeeded");
    await f.restart();
    await f.check(0);
    await f.result("known-result");
    await f.deliver("known-result");
    await f.check(1);
  });
});

test("F2-FINAL-1: locations sharing a project cannot overwrite each other's child debt", async () => {
  await fixture(async (f) => {
    const root = await f.session.get({ sessionID: P });
    if (!root.location) throw new Error("fixture root has no location");
    const dir = root.location.directory;
    const nested = join(dir, "nested");
    const other = "ses_nested_parent";
    const get = f.session.get;
    f.session.get = async (input) => input.sessionID === C || input.sessionID === other
      ? { agent: input.sessionID === C ? "open-gajae-executor" : "open-gajae",
        ...(input.sessionID === C ? { parentID: other } : {}), location: { directory: nested } } : get(input);
    const make = () => createHooks(new StateStore(dir, async () => 1_800_000_000_000),
      f.session, PACKAGE, nested, dir);
    let hooks = make();
    let seq = 0;
    const emit = (id: string, type: string, data: Record<string, unknown> = {}) => hooks.onEvent({
      id: `nested_${++seq}`, type, durable: { aggregateID: id, seq, version: 1 },
      data: { sessionID: id, ...data },
    });
    try {
      await f.todo.apply(other, { op: "init", list: [{ phase: "Work", items: ["X", "Y"] }] });
      await emit(C, "session.created", { parentID: other, location: { directory: nested } });
      await emit(C, "session.execution.started");
      await emit(C, "session.execution.succeeded");
      await f.start();
      await f.emit(C, "session.execution.succeeded");
      await f.check(1);
      await hooks.dispose();
      hooks = make();
      await emit(other, "session.execution.succeeded");
      expect(f.count(other)).toBe(0);
      await emit(other, "session.inbox.enqueued", { inboxID: "nested-result", item: {
        type: "synthetic", payload: { text: "result",
          metadata: { source: "subagent", childID: C, state: "completed" } },
      } });
      await emit(other, "session.inbox.delivered", { inboxID: "nested-result" });
      await emit(other, "session.execution.succeeded");
      expect(f.count(other)).toBe(1);
    } finally { await hooks.dispose(); }
  }, false);
});

test("R2-B1: a late acknowledged result cannot consume newer background debt", async () => {
  await fixture(async (f) => {
    await f.start();
    await f.emit(C, "session.execution.succeeded");
    await f.check(0);
    expect(await f.todo.read(P)).toMatchObject({ hold: { reason: "child_result_ambiguous" } });
    await f.user();
    await f.prepare("new", true, true);
    await f.start();
    await f.emit(P, "session.tool.success", {
      id: "new", metadata: { sessionID: C, status: "running" },
    });
    await f.result("old");
    await f.deliver("old");
    await f.emit(C, "session.execution.succeeded");
    await f.check(0);
  }, false);
});

test("R2-B2: delayed idle confirmation publishes recovery without another parent turn", async () => {
  await fixture(async (f) => {
    const entered = Promise.withResolvers<void>();
    const idle = Promise.withResolvers<void>();
    const published = Promise.withResolvers<void>();
    f.session.wait = async () => { entered.resolve(); await idle.promise; };
    await f.start();
    await f.restart();
    await f.result("old");
    await f.deliver("old");
    await f.check(0);
    await f.user();
    await entered.promise;
    await f.check(0);
    const unsubscribe = f.onChanged((view) => {
      if (view.sessionID === P && view.status === "ready" && view.hold === null) published.resolve();
    });
    // Subscribe before releasing the actual host signal. This deadline bounds
    // a missing notification; it does not sequence the successful test.
    const timeout = setTimeout(() => published.reject(new Error("idle confirmation did not publish recovery")), 2_000);
    try {
      idle.resolve();
      await published.promise;
      expect(await f.todo.read(P)).toMatchObject({ status: "ready", hold: null });
      expect(f.changes.at(-1)).toMatchObject({ status: "ready", hold: null });
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      idle.resolve();
    }
  }, false);
});

for (const replay of [false, true]) {
test(`R3-B1: delayed idle release wakes open work after final success, replay=${replay}`, async () => {
  await fixture(async (f) => {
    const entered = Promise.withResolvers<void>();
    const idle = Promise.withResolvers<void>();
    const published = Promise.withResolvers<void>();
    const accepted = Promise.withResolvers<void>();
    const response = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<void>();
    const synthetic = f.session.synthetic;
    f.session.synthetic = async (input, options) => {
      const result = await synthetic(input, options);
      if (input.resume) {
        accepted.resolve();
        if (replay) await response.promise;
      }
      return result;
    };
    f.session.wait = async () => { entered.resolve(); await idle.promise; };
    // Given: a missed end across replacement and a genuine recovery turn
    // which finishes before the host answers the child's idle subscription.
    await f.start();
    await f.restart();
    await f.result("old");
    await f.deliver("old");
    await f.check(0);
    await f.emit(P, "session.inbox.enqueued", { inboxID: "recover", item: {
      type: "user", payload: { text: "Continue." },
    } });
    await f.emit(P, "session.execution.started");
    await f.deliver("recover");
    await entered.promise;
    const terminal = await f.check(0);
    const unsubscribe = f.onChanged((view) => {
      if (view.sessionID === P && view.status === "ready" && view.hold === null) published.resolve();
      void f.todo.readSnapshot(P).then((snapshot) => {
        if (snapshot.status === "ready" && snapshot.snapshot.controller.reservation?.status === "accepted")
          committed.resolve();
      }, committed.reject);
    });
    const timeout = setTimeout(() => {
      accepted.reject(new Error("ready open work did not resume"));
      committed.reject(new Error("continuation did not commit acceptance"));
    }, 2_000);
    const finished = Promise.all([published.promise, committed.promise, accepted.promise.then(async () => {
      if (replay) await f.replay(terminal);
      response.resolve();
    })]);
    try {
      // When: the final real signal clears the child's hold.
      idle.resolve();
      await finished;
      if (replay) await f.replay(terminal);
      // Then: no additional parent event is needed to admit exactly once.
      expect(f.count(P)).toBe(1);
      expect(await f.todo.read(P)).toMatchObject({ status: "ready", counts: { open: 2 }, hold: null });
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      idle.resolve();
      response.resolve();
    }
  }, false);
});
}

for (const readBoundary of [1, 2, 3, 4, 5]) {
test(`R4-B1: recovery arriving during initial snapshot ${readBoundary} is retained`, async () => {
  await fixture(async (f) => {
    const idleEntered = Promise.withResolvers<void>();
    const idle = Promise.withResolvers<void>();
    const snapshotEntered = Promise.withResolvers<void>();
    const snapshotRelease = Promise.withResolvers<void>();
    const published = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<void>();
    f.session.wait = async () => { idleEntered.resolve(); await idle.promise; };
    await f.start();
    await f.restart();
    await f.result("old");
    await f.deliver("old");
    await f.check(0);
    await f.user();
    await idleEntered.promise;
    const original = TodoStore.prototype.readSnapshot;
    let reads = 0;
    let intercepted = false;
    const spy = spyOn(TodoStore.prototype, "readSnapshot").mockImplementation(async function(this: TodoStore, id) {
      const loaded = await original.call(this, id);
      if (id === P && ++reads === readBoundary) {
        intercepted = true;
        snapshotEntered.resolve();
        await snapshotRelease.promise;
      }
      return loaded;
    });
    const unsubscribe = f.onChanged((view) => {
      if (!intercepted || view.sessionID !== P || view.status !== "ready" || view.hold !== null) return;
      published.resolve();
      void f.todo.readSnapshot(P).then((loaded) => {
        if (loaded.status === "ready" && loaded.snapshot.controller.reservation?.status === "accepted")
          committed.resolve();
      }, committed.reject);
    });
    const admission = f.emit(P, "session.execution.succeeded");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Given: the admission has read a held snapshot but has not retained its source.
      await snapshotEntered.promise;
      // When: recovery publishes readiness before that stale read returns.
      idle.resolve();
      await published.promise;
      const resumed = Promise.race([committed.promise.then(() => true),
        new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 2_000); })]);
      snapshotRelease.resolve();
      await admission;
      // Then: the wake is retained even before deferred child admission exists.
      expect(await resumed).toBe(true);
      expect(f.count(P)).toBe(1);
    } finally {
      clearTimeout(timeout);
      snapshotRelease.resolve();
      idle.resolve();
      await admission;
      spy.mockRestore();
      unsubscribe();
    }
  }, false);
});
}

for (const competing of ["none", "same-terminal", "new-turn", "new-user"] as const) {
  test(`R4-B1: recovery admission retains ${competing} during host context`, async () => {
    await fixture(async (f) => {
      const idleEntered = Promise.withResolvers<void>();
      const idle = Promise.withResolvers<void>();
      const contextEntered = Promise.withResolvers<void>();
      const contextRelease = Promise.withResolvers<void>();
      const committed = Promise.withResolvers<void>();
      const calls: Parameters<HostSession["synthetic"]>[0][] = [];
      let armed = false;
      let intercepted = false;
      const synthetic = f.session.synthetic;
      f.session.synthetic = async (input, options) => {
        calls.push(input);
        return synthetic(input, options);
      };
      f.session.wait = async () => { idleEntered.resolve(); await idle.promise; };
      f.session.context = async () => {
        if (armed && !intercepted) {
          intercepted = true;
          contextEntered.resolve();
          await contextRelease.promise;
        }
        return [];
      };
      const unsubscribe = f.onChanged(() => {
        void f.todo.readSnapshot(P).then((loaded) => {
          if (loaded.status === "ready" && loaded.snapshot.controller.reservation?.status === "accepted")
            committed.resolve();
        }, committed.reject);
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // Given: the user's final success is waiting only for child recovery.
        await f.start();
        await f.restart();
        await f.result("old");
        await f.deliver("old");
        await f.check(0);
        await f.user();
        await idleEntered.promise;
        const terminal = await f.check(0);
        armed = true;
        idle.resolve();
        await contextEntered.promise;
        let latest = terminal;
        // When: a competing turn finishes inside that recovery admission.
        if (competing === "same-terminal") await f.replay(structuredClone(terminal));
        if (competing === "new-user") await f.user();
        if (competing === "new-turn") await f.emit(P, "session.execution.started");
        if (competing === "new-turn" || competing === "new-user")
          latest = await f.emit(P, "session.execution.succeeded");
        const settled = Promise.race([committed.promise.then(() => true),
          new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 2_000); })]);
        contextRelease.resolve();
        const didResume = await settled;
        if (competing === "same-terminal" && didResume) await f.replay(structuredClone(terminal));
        const loaded = await f.todo.readSnapshot(P);
        console.info("R4_WAKE_RACE", JSON.stringify({ competing, didResume, latest: latest.id,
          accepted: calls.filter((call) => call.resume).map((call) => call.metadata?.eventID),
          controller: loaded.status === "ready" ? loaded.snapshot.controller : loaded }));
        // Then: only the current source commits; the superseded one stays dead.
        expect(didResume).toBe(true);
        expect(calls.filter((call) => call.resume).map((call) => call.metadata?.eventID)).toEqual([latest.id]);
      } finally {
        clearTimeout(timeout);
        unsubscribe();
        contextRelease.resolve();
        idle.resolve();
      }
    }, false);
  });
}

for (const terminal of ["session.execution.succeeded", "session.execution.interrupted"]) {
  test(`R2-B3: cancelled notification is visible and user-recoverable after ${terminal}`, async () => {
    await fixture(async (f) => {
      await f.start();
      await f.emit(C, terminal, { reason: "user" });
      await f.result("cancelled", terminal.endsWith("interrupted") ? "cancelled" : "completed");
      await f.emit(P, "session.inbox.cancelled", { inboxID: "cancelled" });
      await f.restart();
      await f.check(0);
      const before = await f.todo.read(P);
      expect(before.status === "ready" && before.hold?.reason.startsWith("child_result")).toBe(true);
      await f.user();
      await f.check(1);
    });
  });
}

for (const point of ["ended", "enqueued", "newer-running", "older-delivered"] as const) {
  test(`child obligations survive a new StateStore and hooks after ${point}`, async () => {
    await fixture(async (f) => {
      // Given: two executions share a child, with restart at each boundary.
      await f.start();
      await f.emit(C, "session.execution.succeeded");
      if (point === "ended") await f.restart();
      await f.result("msg_first");
      if (point === "enqueued") await f.restart();
      await f.start();
      if (point === "newer-running") await f.restart();
      await f.deliver("msg_first");
      if (point === "older-delivered") await f.restart();
      // When: the old result is gone, but the new execution/result is not.
      await f.check(0);
      await f.emit(C, "session.execution.succeeded");
      await f.check(0);
      await f.result("msg_second");
      await f.check(0);
      await f.deliver("msg_second");
      // Then: exactly one continuation after both results, none on restore.
      await f.check(1);
    });
  });
}

for (const restart of [false, true]) {
  test(`a result predating the observer cannot consume a newer running start, restart=${restart}`, async () => {
    await fixture(async (f) => {
      // Given: only the second start was observed, including B11-1 replacement.
      await f.start();
      if (restart) await f.restart();
      // When: the pre-existing execution's delayed result arrives.
      await f.result("msg_old");
      await f.deliver("msg_old");
      await f.check(0);
      await f.emit(C, "session.execution.succeeded");
      // Then: the observed execution still owes its own result.
      await f.check(0);
      await f.result("msg_new");
      await f.deliver("msg_new");
      await f.check(0);
      expect(await f.todo.read(P)).toMatchObject({ hold: { reason: "child_result_ambiguous" } });
      await f.user();
      await f.check(1);
    }, false);
  });
}

test("restart restores an observed start whose lineage had not resolved", async () => {
  await fixture(async (f) => {
    // Given: get(child) is suspended after the start has reached actual disk.
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const written = Promise.withResolvers<void>();
    const get = f.session.get;
    let first = true;
    f.session.get = async (input) => {
      if (input.sessionID === C && first) {
        first = false;
        entered.resolve();
        await release.promise;
      }
      return get(input);
    };
    const original = fs.rename.bind(fs);
    const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await original(from, to);
      if (String(to).includes(`-${C}/state/todo-child-results.json`)) written.resolve();
    });
    const started = f.start();
    let replacement: { disposed: Promise<void> } | undefined;
    try {
      await entered.promise;
      await written.promise;
      rename.mockRestore();
      // When: a new backend instance reads the unresolved durable observation.
      replacement = await f.replaceDuringLookup();
      await f.check(0);
    } finally {
      rename.mockRestore();
      release.resolve();
      await started;
      await replacement?.disposed;
    }
    // Then: the old callback cannot recreate debt; the real result settles it.
    await f.emit(C, "session.execution.succeeded");
    await f.check(0);
    await f.result("msg_recovered");
    await f.deliver("msg_recovered");
    await f.check(1);
  });
});

test("anonymous missed-end recovery exposes a user-recoverable pending child result hold", async () => {
  await fixture(async (f) => {
    // Given: the last persisted native event is the child's start.
    await f.start();
    await f.restart();
    // When: the host recovers its notification without replaying the old end.
    await f.result("msg_recovered");
    await f.check(0);
    await f.deliver("msg_recovered");
    // Then: this anonymous result might predate the observed execution.
    await f.check(0);
    expect(await f.todo.read(P)).toMatchObject({ hold: { reason: "child_result_ambiguous" } });
    // The host confirms the missed end on the user's acknowledgement. No
    // wait result is invented from an inbox ID or from elapsed time.
    let confirmations = 0;
    f.session.wait = async () => { confirmations++; };
    await f.user();
    await f.check(1);
    expect(confirmations).toBe(1);
  }, false);
});

test("known fresh history recovers a missed end with exactly one continuation", async () => {
  await fixture(async (f) => {
    await f.start();
    await f.restart();
    await f.result("msg_recovered");
    await f.check(0);
    await f.deliver("msg_recovered");
    await f.check(1);
  });
});

test("user acknowledgement cannot consume an execution started during idle confirmation", async () => {
  await fixture(async (f) => {
    const entered = Promise.withResolvers<void>();
    const idle = Promise.withResolvers<void>();
    f.session.wait = async () => { entered.resolve(); await idle.promise; };
    await f.start();
    await f.restart();
    await f.result("old_result");
    await f.deliver("old_result");
    await f.check(0);
    await f.user();
    await entered.promise;
    try {
      // The idle response for the acknowledged prefix is delayed past a new
      // start. Its completion cannot erase the new execution/result debt.
      await f.start();
    } finally { idle.resolve(); }
    await f.check(0);
    await f.emit(C, "session.execution.succeeded");
    await f.check(0);
    await f.result("new_result");
    await f.deliver("new_result");
    // The user acknowledged the older prefix, not this later work. Its
    // anonymous result remains ambiguous under the accepted safety contract.
    await f.check(0);
    expect(await f.todo.read(P)).toMatchObject({ hold: { reason: "child_result_ambiguous" } });
    await f.user();
    await f.check(1);
  }, false);
});

test("acknowledging one cancellation cannot authorize a later cancellation", async () => {
  await fixture(async (f) => {
    await f.start();
    await f.emit(C, "session.execution.succeeded");
    await f.result("first");
    await f.emit(P, "session.inbox.cancelled", { inboxID: "first" });
    await f.start();
    await f.emit(C, "session.execution.succeeded");
    await f.result("second");
    await f.user();
    await f.emit(P, "session.inbox.cancelled", { inboxID: "second" });
    await f.check(0);
    expect(await f.todo.read(P)).toMatchObject({ hold: { reason: "child_result_cancelled" } });
    await f.user();
    await f.check(1);
  });
});

test("three mixed executions and another parent retain independent result obligations", async () => {
  await fixture(async (f) => {
    const get = f.session.get;
    const root = await get({ sessionID: P });
    f.session.get = async (input) => input.sessionID === "other_parent" ? root :
      input.sessionID === "other_child" ? { ...root, agent: "open-gajae-executor", parentID: "other_parent" } : get(input);
    await f.start();
    await f.emit(C, "session.execution.succeeded");
    await f.prepare("middle", false, true);
    await f.start();
    await f.emit(C, "session.execution.interrupted", { reason: "user" });
    await f.prepare("last", true, true);
    await f.start();
    await f.emit(P, "session.tool.success", {
      id: "last", metadata: { sessionID: C, status: "running" },
    });
    await f.emit(C, "session.execution.succeeded");
    await f.todo.apply("other_parent", { op: "init", list: [{ phase: "Other", items: ["X", "Y"] }] });
    await f.emit("other_parent", "session.created", { location: root.location });
    await f.emit("other_child", "session.created", { parentID: "other_parent", location: root.location });
    await f.emit("other_child", "session.execution.started");
    await f.emit("other_child", "session.execution.succeeded");
    await f.emit("other_parent", "session.inbox.enqueued", { inboxID: "other_result", item: {
      type: "synthetic", payload: { text: "result", metadata: { source: "subagent", childID: "other_child", state: "completed" } },
    } });
    await f.emit("other_parent", "session.inbox.delivered", { inboxID: "other_result" });
    await f.emit("other_parent", "session.execution.succeeded");
    expect(f.count("other_parent")).toBe(1);
    await f.result("first");
    await f.deliver("first");
    await f.emit(P, "session.tool.failed", {
      id: "middle", metadata: { sessionID: C, status: "running" },
      error: { type: "tool.execution", message: "interrupted" },
    });
    await f.emit(P, "session.execution.succeeded");
    expect(f.count(P)).toBe(0);
    await f.result("last");
    await f.deliver("last");
    await f.emit(P, "session.execution.succeeded");
    expect(f.count(P)).toBe(1);
    expect(f.count("other_parent")).toBe(1);
    expect(f.count(C) + f.count("other_child")).toBe(0);
  });
});

test("an ambiguous child-result hold cannot mask a genuine user stop", async () => {
  await fixture(async (f) => {
    await f.start();
    await f.emit(C, "session.execution.succeeded");
    await f.check(0);
    expect(await f.todo.read(P)).toMatchObject({ hold: { reason: "child_result_ambiguous" } });
    await f.emit(P, "session.execution.interrupted", { reason: "user" });
    expect(await f.todo.read(P)).toMatchObject({ hold: { reason: "user_stop" } });
    await f.user();
    await f.check(0);
    expect(await f.todo.read(P)).toMatchObject({ hold: { reason: "user_stop" } });
  }, false);
});

test("disposing ambiguity recovery aborts the host idle subscription", async () => {
  await fixture(async (f) => {
    const entered = Promise.withResolvers<void>();
    let aborted = false;
    f.session.wait = async (_input, options) => {
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(options.signal?.reason);
        }, { once: true });
        entered.resolve();
      });
    };
    await f.start();
    await f.restart();
    await f.user();
    await entered.promise;
    await f.restart();
    expect(aborted).toBe(true);
    await f.check(0);
    expect(await f.todo.read(P)).toMatchObject({ hold: { reason: "child_result_ambiguous" } });
  }, false);
});

for (const terminal of ["session.execution.failed", "session.execution.interrupted"]) {
  test(`${terminal} retains background result debt until actual delivery`, async () => {
    await fixture(async (f) => {
      // Given: a failed/cancelled background execution with a later reuse.
      await f.start();
      await f.emit(C, terminal, { reason: "user", error: { type: "test", message: "failed" } });
      await f.start();
      // When: the error/cancelled result is enqueued after the newer start.
      await f.result("msg_error", terminal.endsWith("failed") ? "error" : "cancelled");
      await f.deliver("msg_error");
      await f.emit(C, "session.execution.succeeded");
      // Then: neither execution end nor older delivery clears the new debt.
      await f.check(0);
      await f.result("msg_new");
      await f.deliver("msg_new");
      await f.check(1);
    });
  });
}

for (const outcome of ["completed", "failed", "cancelled"] as const) {
  test(`foreground ${outcome} without inbox settles only its associated execution`, async () => {
    await fixture(async (f) => {
      // Given: progress associates each real subagent tool with its child run.
      await f.start("tool_old");
      await f.emit(C, outcome === "completed" ? "session.execution.succeeded" :
        outcome === "failed" ? "session.execution.failed" : "session.execution.interrupted",
      { reason: "user", error: { type: "test", message: "failed" } });
      await f.start("tool_new");
      // When: an older terminal foreground tool outcome arrives without inbox.
      await f.emit(P, outcome === "completed" ? "session.tool.success" : "session.tool.failed", {
        id: "tool_old", metadata: { sessionID: C, status: outcome },
        error: { type: "test", message: "foreground terminal outcome" },
      });
      await f.emit(C, "session.execution.succeeded");
      await f.check(0);
      await f.emit(P, "session.tool.success", {
        id: "tool_new", metadata: { sessionID: C, status: "completed" },
      });
      // Then: no phantom inbox is required and the newer result is not lost.
      await f.check(1);
    });
  });
}

test("background handoff and cancelled inbox do not settle an execution", async () => {
  await fixture(async (f) => {
    // Given: a real tool hands off instead of returning a final result.
    await f.start("tool_background");
    await f.emit(P, "session.tool.success", {
      id: "tool_background", metadata: { sessionID: C, status: "running" },
    });
    await f.emit(C, "session.execution.succeeded");
    await f.check(0);
    await f.result("msg_cancelled");
    // When: the inbox is cancelled, not delivered.
    await f.emit(P, "session.inbox.cancelled", { inboxID: "msg_cancelled" });
    await f.restart();
    // Then: cancellation is not falsely treated as parent consumption.
    await f.check(0);
  });
});

for (const point of ["progress", "handoff", "started"] as const) {
  test(`background handoff before start retains its channel across replacement after ${point}`, async () => {
    await fixture(async (f) => {
      // Given: an older foreground run still awaits its tool outcome.
      await f.start("foreground");
      await f.emit(C, "session.execution.succeeded");
      await f.prepare("background", true);
      if (point === "progress") await f.restart();
      await f.emit(P, "session.tool.success", {
        id: "background", metadata: { sessionID: C, status: "running" },
      });
      if (point === "handoff") await f.restart();
      await f.start();
      if (point === "started") await f.restart();
      await f.emit(C, "session.execution.succeeded");
      // When: background inbox delivery precedes the foreground tool result.
      await f.result("background_result");
      await f.deliver("background_result");
      await f.check(0);
      await f.emit(P, "session.tool.success", {
        id: "foreground", metadata: { sessionID: C, status: "completed" },
      });
      // Then: only the matching channels settle; there is no stranded debt.
      await f.check(1);
    });
  });
}

test("notifications delivered before background handoff cannot settle a later execution", async () => {
  await fixture(async (f) => {
    // A blocked foreground tool can be backgrounded. The host forks its
    // notification before publishing the tool's status-running success.
    await f.start("converted");
    await f.emit(C, "session.execution.succeeded");
    await f.prepare("background", true);
    await f.start();
    await f.emit(P, "session.tool.success", {
      id: "background", metadata: { sessionID: C, status: "running" },
    });
    await f.emit(C, "session.execution.succeeded");
    await f.result("converted_result");
    await f.deliver("converted_result");
    await f.check(0);
    await f.restart();
    await f.emit(P, "session.tool.success", {
      id: "converted", metadata: { sessionID: C, status: "running" },
    });
    await f.check(0);
    await f.result("background_result");
    await f.deliver("background_result");
    await f.check(1);
  });
});

for (const terminal of ["session.execution.failed", "session.execution.interrupted"]) {
  test(`foreground ${terminal} settles with retained running progress metadata after restart`, async () => {
    await fixture(async (f) => {
      await f.start("foreground");
      await f.emit(C, terminal, { reason: "user", error: { type: "test", message: "failed" } });
      await f.restart();
      await f.emit(P, "session.tool.failed", {
        id: "foreground", metadata: { sessionID: C, status: "running" },
        error: { type: "tool.execution", message: "terminal" },
      });
      await f.check(1);
    });
  });
}

test("failed child accounting recovers without losing observations received during the hold", async () => {
  await fixture(async (f) => {
    // Given: a real child-ledger atomic replacement is rejected once.
    const original = fs.rename.bind(fs);
    let faults = 0;
    const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (faults === 0 && String(to).includes(`-${C}/state/todo-child-results.json`)) {
        faults++;
        throw new Error("child accounting replacement failed");
      }
      return original(from, to);
    });
    try { await f.start(); }
    finally { rename.mockRestore(); }
    // When: more native events arrive before explicit recovery.
    await f.emit(C, "session.execution.succeeded");
    await f.result("msg_first");
    await f.deliver("msg_first");
    await f.start();
    await f.emit(C, "session.execution.succeeded");
    await f.check(0);
    expect(faults).toBe(1);
    expect(await f.todo.read(P)).toMatchObject({ status: "ready", hold: { reason: "invalid_storage" } });
    await f.recover();
    // Then: recovery replays debt, not the old write's incremental mutation.
    await f.check(0);
    await f.result("msg_second");
    await f.deliver("msg_second");
    await f.check(1);
    expect(await f.todo.read(P)).toMatchObject({ status: "ready", hold: null });
  });
});
