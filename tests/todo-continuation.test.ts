import { expect, test, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdtemp, realpath, rm, readFile, writeFile, readdir, mkdir, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHooks, type HostSession, type ContextEvent } from "../src/hooks";
import { StateStore, assertStatePayload, type WorkflowTx } from "../src/state";
import { TodoStore } from "../src/todo/store";
import { todoTool } from "../src/todo/tool";
import { todoSnapshotSchema } from "../src/todo/state";
import type { TodoSnapshot } from "../src/todo/state";
import { syncActiveRowTx } from "../src/skill-state/rows";
import { RUNTIME_OWNER } from "../src/skill-state/audit";

const ID = "ses_todo";
const PACKAGE = new URL("../", import.meta.url).pathname;
const settings = { enabled: true, continuation: true, stagnationLimit: 3, failureLimit: 5 };
function evidence(scenario: string, snapshot: TodoSnapshot, accepted: number) {
  if (process.env.TODO_CONTINUATION_EVIDENCE !== "1") return;
  console.info(`TODO_EVIDENCE ${JSON.stringify({ scenario, accepted, snapshot })}`);
}
type Synthetic = Parameters<HostSession["synthetic"]>[0];
function deferred() {
  let resolve: () => void = () => { throw new Error("uninitialized barrier"); };
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function event(type: string, seq: number, data: Record<string, unknown> = {}) {
  return { id: `evt_${seq}`, type, durable: { aggregateID: ID, seq, version: 1 }, data: { sessionID: ID, ...data } };
}
async function fixture(body: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  config = settings) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "gajae-todo-continuation-")));
  const f = await setup(dir, config);
  try { await body(f); }
  finally { await f.hooks.dispose(); await rm(dir, { recursive: true, force: true }); }
}
async function setup(dir: string, config: typeof settings) {
  const store = new StateStore(dir, async () => 1_800_000_000_000);
  const todo = new TodoStore(store);
  let agent = "open-gajae";
  let parentID: string | undefined;
  const calls: Synthetic[] = [];
  const messages: Array<{ id: string; type: string }> = [];
  const session: HostSession = {
    async get() { return { agent, parentID, location: { directory: dir } }; },
    async synthetic(input) {
      calls.push(input);
      if (input.id) messages.push({ id: input.id, type: "synthetic" });
      return {};
    },
    async context() { return messages; },
  };
  const makeHooks = (state = store) => createHooks(state, session, PACKAGE, dir, dir, config);
  const hooks = makeHooks();
  const apply = async (input: unknown) => {
    const result = await todo.apply(ID, input);
    expect(["applied", "unchanged", "committed-with-warning"]).toContain(result.disposition);
    return result;
  };
  await apply({ op: "init", list: [{ phase: "Work", items: ["A", "B", "C"] }] });
  const snapshot = async () => todoSnapshotSchema.parse(JSON.parse(
    await readFile(join(await store.resolveSessionDir(ID), "state", "todo.json"), "utf8")));
  return {
    store, todo, hooks, session, calls, messages, makeHooks, apply, snapshot,
    setAgent(value: string) { agent = value; },
    setParent(value: string) { parentID = value; },
    resumes: () => calls.filter((call) => call.resume),
    async emit(type: string, seq: number, data: Record<string, unknown> = {}) {
      await hooks.onEvent(event(type, seq, data));
    },
    async user(seq: number, text = "continue") {
      await hooks.onEvent(event("session.inbox.enqueued", seq, {
        inboxID: `msg_user_${seq}`, item: { type: "user", payload: { text }, delivery: "steer" },
      }));
      await hooks.onEvent(event("session.inbox.delivered", seq + 1, { inboxID: `msg_user_${seq}` }));
    },
  };
}

test("continuation-progress-and-recovery has no total progress cap and preserves terminal history", async () => {
  await fixture(async (f) => {
    for (let n = 0; n < 9; n++) {
      if (n) await f.apply({ op: "append", phase: "Work", items: [`new-${n}`] });
      await f.apply({ op: n % 2 ? "drop" : "done", task: n ? `new-${n}` : "A" });
      await f.emit("session.execution.succeeded", n * 2 + 1);
      expect(f.resumes()).toHaveLength(n + 1);
      await f.emit("session.execution.started", n * 2 + 2);
    }
    const before = await f.snapshot();
    expect(before.controller.closedLabels).toHaveLength(9);
    expect(before.controller.stagnation).toBe(0);
    expect(before.controller.reservation?.status).toBe("accepted");
    expect(f.resumes().every((call) => call.id?.startsWith("msg_") && call.metadata?.source === "open-gajae.todo")).toBe(true);
    const fresh = f.makeHooks();
    try {
      const compact: { sessionID: string; system: Array<{ type: "text"; text: string }> } = { sessionID: ID, system: [] };
      await fresh.compaction(compact);
      expect(compact.system.some((part) => part.text.includes("<open-gajae-todo-context>"))).toBe(true);
      expect((await f.snapshot()).phases).toEqual(before.phases);
      await fresh.onEvent(event("session.execution.succeeded", 17));
      expect(f.resumes()).toHaveLength(9);
    } finally { await fresh.dispose(); }
    evidence("continuation-progress-and-recovery", await f.snapshot(), f.resumes().length);
  });
});

test("the parent's accepted execution start does not abort its own continuation request", async () => {
  await fixture(async (f) => {
    // Given: native acceptance starts the parent before synthetic returns.
    const synthetic = f.session.synthetic;
    f.session.synthetic = async (input, options) => {
      if (input.resume) {
        const start = event("session.execution.started", 2);
        f.hooks.observeEvent(start);
        await f.hooks.onEvent(start);
        expect(options?.signal?.aborted).toBe(false);
      }
      return synthetic(input, options);
    };
    // When: the open board requests one continuation.
    await f.emit("session.execution.succeeded", 1);
    // Then: a legitimate parent start is not a child veto.
    expect(f.resumes()).toHaveLength(1);
    expect((await f.snapshot()).controller.reservation?.status).toBe("accepted");
    expect(await f.todo.read(ID)).toMatchObject({ status: "ready", hold: null });
  });
});

for (const boundary of ["context", "reserved", "receipt"] as const) {
  test(`R4-B1: ordinary admission retains a newer success at ${boundary}`, async () => {
    await fixture(async (f) => {
      // Given: an ordinary (not recovery) admission is suspended at real IO.
      const entered = deferred();
      const release = deferred();
      let armed = true;
      const context = f.session.context;
      const synthetic = f.session.synthetic;
      f.session.context = async (input) => {
        if (boundary === "context" && armed) {
          armed = false; entered.resolve(); await release.promise;
        }
        return context?.(input) ?? [];
      };
      const update = TodoStore.prototype.updateController;
      const spy = spyOn(TodoStore.prototype, "updateController").mockImplementation(
        async function(this: TodoStore, id, expected, change) {
          const result = await update.call(this, id, expected, change);
          if (boundary === "reserved" && armed && result.disposition === "applied") {
            armed = false; entered.resolve(); await release.promise;
          }
          return result;
        });
      f.session.synthetic = async (input, options) => {
        const result = await synthetic(input, options);
        if (boundary === "receipt" && input.resume && armed) {
          armed = false; entered.resolve(); await release.promise;
        }
        return result;
      };
      const admission = f.emit("session.execution.succeeded", 1);
      try {
        await entered.promise;
        // When: a real newer parent turn finishes before the old attempt settles.
        await f.emit("session.execution.started", 2);
        await f.emit("session.execution.succeeded", 3);
      } finally {
        release.resolve();
        await admission;
        spy.mockRestore();
      }
      // Then: superseded work is not dispatched; accepted work is not repeated.
      expect(f.resumes().map((call) => call.metadata?.eventID))
        .toEqual(boundary === "receipt" ? ["evt_1", "evt_3"] : ["evt_3"]);
    });
  });
}

test("R4-B1: a reducer CAS winner rechecks the still eligible source without another event", async () => {
  await fixture(async (f) => {
    const entered = deferred();
    const release = deferred();
    f.session.context = async () => { entered.resolve(); await release.promise; return []; };
    const admission = f.emit("session.execution.succeeded", 1);
    try {
      await entered.promise;
      expect((await f.todo.apply(ID, { op: "done", task: "A" })).disposition).toBe("applied");
    } finally { release.resolve(); await admission; }
    expect(f.resumes().map((call) => call.metadata?.eventID)).toEqual(["evt_1"]);
    expect((await f.snapshot()).controller.reservation?.status).toBe("accepted");
  });
});

test("R4-B1: a transient veto resolved during context does not strand a cancelled source", async () => {
  await fixture(async (f) => {
    const entered = deferred();
    const release = deferred();
    f.session.context = async () => { entered.resolve(); await release.promise; return []; };
    const admission = f.emit("session.execution.succeeded", 1);
    try {
      await entered.promise;
      await f.emit("form.created", 2, { form: { id: "temporary", sessionID: ID } });
      await f.emit("form.replied", 3, { id: "temporary" });
    } finally { release.resolve(); await admission; }
    expect(f.resumes().map((call) => call.metadata?.eventID)).toEqual(["evt_1"]);
    expect((await f.snapshot()).controller.reservation?.status).toBe("accepted");
  });
});

test("R4-B1: cancelled reservation retry is not restored from a replayed source", async () => {
  await fixture(async (f) => {
    const entered = deferred();
    const release = deferred();
    f.session.context = async () => { entered.resolve(); await release.promise; return []; };
    const admission = f.emit("session.execution.succeeded", 1);
    try {
      await entered.promise;
      await f.emit("session.agent.selected", 2, { agent: "open-gajae-executor" });
    } finally { release.resolve(); await admission; }
    expect((await f.snapshot()).controller.reservation?.status).toBe("cancelled");
    const fresh = f.makeHooks();
    try {
      await fresh.onEvent(event("session.execution.succeeded", 1));
      expect(f.resumes()).toHaveLength(0);
    } finally { await fresh.dispose(); }
  });
});

test("R4-B1: definite rejection rechecks a resolved veto without resetting failure budget", async () => {
  await fixture(async (f) => {
    const entered = deferred();
    const release = deferred();
    const attempted: Synthetic[] = [];
    const synthetic = f.session.synthetic;
    f.session.synthetic = async (input, options) => {
      if (!input.resume) return synthetic(input, options);
      attempted.push(input);
      if (attempted.length === 1) {
        entered.resolve();
        await release.promise;
      }
      throw { _tag: "InvalidRequestError", message: "definite rejection" };
    };
    const admission = f.emit("session.execution.succeeded", 1);
    try {
      await entered.promise;
      await f.emit("form.created", 2, { form: { id: "temporary", sessionID: ID } });
      await f.emit("form.replied", 3, { id: "temporary" });
    } finally { release.resolve(); await admission; }
    expect(attempted).toHaveLength(2);
    expect(new Set(attempted.map((call) => call.id)).size).toBe(1);
    expect((await f.snapshot()).controller).toMatchObject({
      failures: 2, reservation: { attempts: 2, status: "failed" }, hold: { reason: "dispatch_failure" },
    });
  }, { ...settings, failureLimit: 2 });
});

test("R4-B1: a CAS retry cannot carry its source into a replacement generation", async () => {
  await fixture(async (f) => {
    const entered = deferred();
    const release = deferred();
    f.session.context = async () => { entered.resolve(); await release.promise; return []; };
    const admission = f.emit("session.execution.succeeded", 1);
    try {
      await entered.promise;
      await f.apply({ op: "init", list: [{ phase: "Replacement", items: ["X", "Y"] }] });
    } finally { release.resolve(); await admission; }
    expect(f.resumes()).toHaveLength(0);
    expect((await f.snapshot()).controller.reservation).toBeNull();
  });
});

test("bookkeeping cannot refill stagnation and one passive notice survives restart", async () => {
  await fixture(async (f) => {
    await f.emit("session.execution.succeeded", 1);
    await f.apply({ op: "done", task: "A" });
    await f.emit("session.execution.succeeded", 2);
    for (let n = 0; n < 3; n++) {
      await f.apply({ op: "view" });
      await f.apply({ op: "start", task: "A" });
      await f.apply({ op: "done", task: "A" });
      await f.apply({ op: "init", list: [{ phase: "Work", items: ["A", "B", "C"] }] });
      await f.apply({ op: "done", task: "A" });
      await f.emit("session.execution.succeeded", n + 3);
    }
    const snapshot = await f.snapshot();
    expect(snapshot.controller.stagnation).toBe(3);
    expect(snapshot.controller.hold?.reason).toBe("stagnation");
    expect(snapshot.controller.closedLabels).toEqual(["A"]);
    expect(f.resumes()).toHaveLength(4);
    evidence("bookkeeping-budget-hold", snapshot, f.resumes().length);
    const notices = f.calls.filter((call) => call.text.includes("<open-gajae-todo-notice>"));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.resume).toBe(false);
    expect(notices[0]?.description).toBeTruthy();
    await f.hooks.onEvent(event("session.inbox.enqueued", 8, {
      inboxID: "msg_notice", item: { type: "synthetic", payload: {
        text: notices[0]?.text, metadata: { source: "open-gajae.todo", kind: "notice" },
      } },
    }));
    await f.user(10);
    await f.apply({ op: "start", task: "B" });
    await f.emit("session.execution.succeeded", 12);
    expect(f.resumes()).toHaveLength(5);
  });
});

test("cancel/resume consumes only delivered genuine user activation plus explicit start", async () => {
  await fixture(async (f) => {
    await f.user(1);
    await f.emit("session.execution.interrupted", 3, { reason: "user" });
    await f.apply({ op: "start", task: "B" });
    await f.apply({ op: "view" });
    await f.hooks.compaction({ sessionID: ID, system: [] });
    await f.hooks.prompt({ sessionID: ID, prompt: { text: "<open-gajae-todo-context>continue</open-gajae-todo-context>" } });
    await f.emit("session.execution.succeeded", 4);
    expect(f.resumes()).toHaveLength(0);
    expect((await f.snapshot()).controller.hold?.reason).toBe("user_stop");
    await f.user(5, "status");
    await f.apply({ op: "view" });
    await f.emit("session.execution.succeeded", 7);
    expect(f.resumes()).toHaveLength(0);
    await f.apply({ op: "start", task: "B" });
    await f.emit("session.execution.succeeded", 8);
    expect(f.resumes()).toHaveLength(1);
    expect((await f.snapshot()).controller.workEpoch).toBe(2);
    await f.emit("session.execution.interrupted", 9, { reason: "shutdown" });
    await f.user(10);
    await f.apply({ op: "done", task: "B" });
    await f.emit("session.execution.succeeded", 12);
    expect(f.resumes()).toHaveLength(1);
  });
});

test("repeated interruptions keep one notice and stale stop replay cannot close a new epoch", async () => {
  await fixture(async (f) => {
    await f.emit("session.execution.interrupted", 1, { reason: "user" });
    await f.emit("session.execution.interrupted", 2, { reason: "user" });
    await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
    expect(f.calls.filter((call) => call.text.startsWith("<open-gajae-todo-notice>"))).toHaveLength(1);
    await f.user(3);
    await f.apply({ op: "start", task: "A" });
    await f.emit("session.execution.succeeded", 5);
    await f.emit("session.execution.interrupted", 1, { reason: "user" });
    await f.emit("session.execution.succeeded", 6);
    expect((await f.snapshot()).controller.hold).toBeNull();
    expect(f.resumes()).toHaveLength(2);
    evidence("repeated-interruption-recovery", await f.snapshot(), f.resumes().length);
  });
});

test("concurrent sequential lower-sequence and restarted replay have one accepted effect", async () => {
  await fixture(async (f) => {
    await Promise.all([f.emit("session.execution.succeeded", 20), f.emit("session.execution.succeeded", 20)]);
    await f.emit("session.execution.succeeded", 20);
    await f.emit("session.execution.succeeded", 19);
    const fresh = f.makeHooks();
    try { await fresh.onEvent(event("session.execution.succeeded", 20)); }
    finally { await fresh.dispose(); }
    expect(f.resumes()).toHaveLength(1);
    expect((await f.snapshot()).controller.sourceWatermark).toEqual({ eventID: "evt_20", aggregateID: ID, seq: 20 });
    evidence("durable-replay-identity", await f.snapshot(), f.resumes().length);
  });
});

test("unknown post-accept failure and stale pending_dispatch restart never resend", async () => {
  await fixture(async (f) => {
    const native = f.session.synthetic;
    f.session.synthetic = async (input) => {
      await native(input);
      if (input.resume) throw new Error("connection lost after native accept");
      return {};
    };
    await f.emit("session.execution.succeeded", 1);
    expect((await f.snapshot()).controller.hold?.reason).toBe("ambiguous_delivery");
    const first = await f.snapshot();
    const reservation = first.controller.reservation;
    if (!reservation) throw new Error("reservation missing");
    await f.todo.updateController(ID, first, (controller) => ({
      ...controller, hold: null, reservation: { ...reservation, status: "reserved" },
    }));
    const fresh = f.makeHooks();
    try {
      await fresh.onEvent(event("session.execution.succeeded", 2));
      expect(f.resumes()).toHaveLength(1);
      expect((await f.snapshot()).controller.hold?.reason).toBe("pending_dispatch");
      evidence("ambiguous-and-pending-dispatch-recovery", await f.snapshot(), f.resumes().length);
    } finally { await fresh.dispose(); }
  });
});

test("definite pre-accept failures retry one fixed reservation up to configured failureLimit", async () => {
  await fixture(async (f) => {
    const attempted: Synthetic[] = [];
    const native = f.session.synthetic;
    f.session.synthetic = async (input) => {
      if (!input.resume) return native(input);
      attempted.push(input);
      throw { _tag: "InvalidRequestError", message: "request rejected before enqueue" };
    };
    await f.emit("session.execution.succeeded", 1);
    expect(attempted).toHaveLength(2);
    expect(new Set(attempted.map((call) => call.id)).size).toBe(1);
    expect((await f.snapshot()).controller).toMatchObject({
      failures: 2, reservation: { attempts: 2, status: "failed" }, hold: { reason: "dispatch_failure" },
    });
    await f.emit("session.execution.succeeded", 1);
    expect(attempted).toHaveLength(2);
    expect(f.resumes()).toHaveLength(0);
    evidence("definite-failure-limit", await f.snapshot(), f.resumes().length);
  }, { ...settings, failureLimit: 2 });
});

test("first user delivery before board creation is consumed by its explicit initialization", async () => {
  await fixture(async (f) => {
    const file = join(await f.store.resolveSessionDir(ID), "state", "todo.json");
    await rm(file);
    await f.user(1);
    const input = { op: "init", list: [{ phase: "New", items: ["X", "Y"] }] };
    await f.hooks.executeBefore({ sessionID: ID, agent: "open-gajae", tool: "todo", id: "call_init", input });
    await f.apply(input);
    await f.hooks.executeAfter({ sessionID: ID, agent: "open-gajae", tool: "todo", id: "call_init", status: "success" });
    const snapshot = await f.snapshot();
    expect(snapshot.controller.activationFence?.eventID).toBe("evt_2");
    expect(snapshot.controller.consumedActivationFence).toEqual(snapshot.controller.activationFence);
    const epoch = snapshot.controller.workEpoch;
    await f.apply({ op: "start", task: "Y" });
    expect((await f.snapshot()).controller.workEpoch).toBe(epoch);
  });
});

for (const disabled of ["enabled", "continuation"] as const) {
  test(`${disabled}:false and terminal boards never dispatch`, async () => {
    await fixture(async (f) => {
      await f.emit("session.execution.succeeded", 1);
      expect(f.resumes()).toHaveLength(0);
    }, { ...settings, [disabled]: false });
  });
}

test("terminal invalid foreign-owner and returned child boards never dispatch", async () => {
  await fixture(async (f) => {
    f.setParent("ses_parent");
    await f.emit("session.execution.succeeded", 1);
    expect(f.resumes()).toHaveLength(0);
  });
  await fixture(async (f) => {
    await f.apply({ op: "done", phase: "Work" });
    await f.emit("session.execution.succeeded", 1);
    expect(f.resumes()).toHaveLength(0);
  });
  await fixture(async (f) => {
    const file = join(await f.store.resolveSessionDir(ID), "state", "todo.json");
    await writeFile(file, "{invalid");
    await f.emit("session.execution.succeeded", 1);
    expect(f.resumes()).toHaveLength(0);
    expect(await readFile(file, "utf8")).toBe("{invalid");
    expect(f.calls.filter((call) => !call.resume && call.text.startsWith("<open-gajae-todo-notice>"))).toHaveLength(1);
  });
});

test("restart with accepted stale controller needs a new execution start and rejects pending tool context", async () => {
  await fixture(async (f) => {
    await f.emit("session.execution.succeeded", 1);
    const fresh = f.makeHooks();
    try {
      await fresh.onEvent(event("session.execution.succeeded", 2));
      expect(f.resumes()).toHaveLength(1);
      f.session.context = async () => [{ id: "msg_tool", type: "assistant", content: [
        { type: "tool", state: { status: "running" } },
      ] }];
      await fresh.onEvent(event("session.execution.started", 3));
      await fresh.onEvent(event("session.execution.succeeded", 4));
      expect(f.resumes()).toHaveLength(1);
      f.session.context = async () => f.messages;
      await fresh.onEvent(event("session.execution.started", 5));
      await fresh.onEvent(event("session.execution.succeeded", 6));
      expect(f.resumes()).toHaveLength(2);
    } finally { await fresh.dispose(); }
  });
});

for (const status of ["paused", "complete"] as const) {
  test(`goal-todo-no-dependency: raw goal ${status} permits ordinary todo work`, async () => {
    await fixture(async (f) => {
      await f.store.workflowTransaction(ID, async (tx) => {
        await tx.writeText(tx.paths.goalState, JSON.stringify({
          version: 1, id: "goal-1", objective: "independent", status, source: "user",
          created_at: "2026-10-13", updated_at: "2026-10-13",
        }), { audit: false });
      });
      await f.emit("session.execution.succeeded", 1);
      expect(f.resumes()).toHaveLength(1);
      expect((await f.snapshot()).controller.hold).toBeNull();
    });
  });
}

test("explicit workflow terminal/approval rows veto todo even without a continuation message", async () => {
  for (const phase of ["complete", "approval", "stuck"]) {
    await fixture(async (f) => {
      await f.store.workflowTransaction(ID, (tx) => syncActiveRowTx(tx, {
        skill: "ralplan", active: true, phase, sessionId: ID,
      }, RUNTIME_OWNER));
      await f.emit("session.execution.succeeded", 1);
      expect(f.resumes()).toHaveLength(0);
    });
  }
});

test("child completion remains pending until native subagent inbox delivery", async () => {
  await fixture(async (f) => {
    await f.hooks.onEvent(event("session.created", 1, {
      sessionID: "ses_child", parentID: ID, location: { directory: f.store.worktree },
    }));
    await f.hooks.onEvent(event("session.execution.started", 2, { sessionID: "ses_child" }));
    await f.hooks.onEvent(event("session.execution.succeeded", 3, { sessionID: "ses_child" }));
    await f.emit("session.execution.succeeded", 4);
    expect(f.resumes()).toHaveLength(0);
    await f.emit("session.inbox.enqueued", 5, {
      inboxID: "msg_child", item: { type: "synthetic", payload: {
        text: "child result", metadata: { source: "subagent", childID: "ses_child", state: "completed" },
      } },
    });
    await f.emit("session.execution.succeeded", 6);
    expect(f.resumes()).toHaveLength(0);
    await f.emit("session.inbox.delivered", 7, { inboxID: "msg_child" });
    await f.emit("session.execution.succeeded", 8);
    expect(f.resumes()).toHaveLength(1);
    expect((await f.snapshot()).controller.activationFence).toBeNull();
  });
});

test("an unconfirmed location lookup cannot erase an observed child parent", async () => {
  await fixture(async (f) => {
    // Given: creation supplies lineage, but not enough data to confirm location.
    await f.emit("session.created", 1, { sessionID: "ses_child", parentID: ID });
    await f.emit("session.execution.started", 2, { sessionID: "ses_child" });
    // When: execution ends before its result is enqueued or delivered.
    await f.emit("session.execution.succeeded", 3, { sessionID: "ses_child" });
    await f.emit("session.execution.succeeded", 4);
    // Then: a negative ownership check is not evidence of a lineage root.
    expect(f.resumes()).toHaveLength(0);
    await f.emit("session.inbox.enqueued", 5, {
      inboxID: "msg_child", item: { type: "synthetic", payload: {
        text: "result", metadata: { source: "subagent", childID: "ses_child", state: "completed" },
      } },
    });
    await f.emit("session.execution.succeeded", 6);
    expect(f.resumes()).toHaveLength(0);
    await f.emit("session.inbox.delivered", 7, { inboxID: "msg_child" });
    await f.emit("session.execution.succeeded", 8);
    expect(f.resumes()).toHaveLength(1);
  });
});

for (const late of [false, true]) {
  test(`F2-B1: ${late ? "late" : "early control"} lineage lookup cannot restore a delivered child wait`, async () => {
    await fixture(async (f) => {
      const childID = "ses_existing_child";
      // This control has no unknown result prefix. Observe creation on the
      // fast lane without resolving the later session.get lineage callback.
      f.hooks.observeEvent({ type: "session.created", data: {
        sessionID: childID, parentID: ID, location: { directory: f.store.worktree },
      } });
      const entered = deferred();
      const release = deferred();
      const get = f.session.get;
      f.session.get = async (input) => {
        if (input.sessionID !== childID) return get(input);
        entered.resolve();
        await release.promise;
        return { agent: "open-gajae-executor", parentID: ID, location: { directory: f.store.worktree } };
      };
      const childEvent = (type: string, seq: number) => ({
        id: `evt_child_${seq}`, type, durable: { aggregateID: childID, seq, version: 1 },
        data: { sessionID: childID },
      });
      const start = childEvent("session.execution.started", 1);
      const end = childEvent("session.execution.succeeded", 2);
      const enqueue = event("session.inbox.enqueued", 1, {
        inboxID: "msg_existing_child", item: { type: "synthetic", payload: {
          text: "child result", metadata: { source: "subagent", childID, state: "completed" },
        } },
      });
      const delivery = event("session.inbox.delivered", 2, { inboxID: "msg_existing_child" });
      f.hooks.observeEvent(start);
      const pending = f.hooks.onEvent(start);
      try {
        await entered.promise;
        if (!late) { release.resolve(); await pending; }
        for (const observed of [end, enqueue, delivery]) f.hooks.observeEvent(observed);
      } finally { release.resolve(); await pending; }
      for (const observed of [end, enqueue, delivery]) await f.hooks.onEvent(observed);
      await f.emit("session.execution.succeeded", 3);
      console.info(`F2_B1 ${JSON.stringify({ late, resumes: f.resumes().length, view: await f.todo.read(ID) })}`);
      expect(f.resumes()).toHaveLength(1);
    });
  });
}

test("F2-B1: pre-existing child still blocks after lookup and execution end until delivery", async () => {
  await fixture(async (f) => {
    const childID = "ses_existing_child";
    f.hooks.observeEvent({ type: "session.created", data: {
      sessionID: childID, parentID: ID, location: { directory: f.store.worktree },
    } });
    const get = f.session.get;
    f.session.get = async (input) => input.sessionID === childID
      ? { agent: "open-gajae-executor", parentID: ID, location: { directory: f.store.worktree } }
      : get(input);
    const childEvent = (type: string, seq: number) => ({
      id: `evt_child_${seq}`, type, durable: { aggregateID: childID, seq, version: 1 },
      data: { sessionID: childID },
    });
    await f.hooks.onEvent(childEvent("session.execution.started", 1));
    await f.emit("session.execution.succeeded", 1);
    expect(f.resumes()).toHaveLength(0);
    await f.hooks.onEvent(childEvent("session.execution.succeeded", 2));
    await f.emit("session.execution.succeeded", 2);
    expect(f.resumes()).toHaveLength(0);
    await f.emit("session.inbox.enqueued", 3, {
      inboxID: "msg_existing_child", item: { type: "synthetic", payload: {
        text: "child result", metadata: { source: "subagent", childID, state: "completed" },
      } },
    });
    await f.emit("session.inbox.delivered", 4, { inboxID: "msg_existing_child" });
    await f.emit("session.execution.succeeded", 5);
    expect(f.resumes()).toHaveLength(1);
  });
});

for (const reused of [false, true]) {
  test(`B10-1: ${reused ? "reused" : "different"} child keeps its newer result obligation after older delivery`, async () => {
    await fixture(async (f) => {
      const first = "ses_first_child";
      const second = reused ? first : "ses_second_child";
      for (const sessionID of new Set([first, second])) f.hooks.observeEvent({
        type: "session.created", data: { sessionID, parentID: ID, location: { directory: f.store.worktree } },
      });
      const entered = deferred();
      const release = deferred();
      const get = f.session.get;
      f.session.get = async (input) => {
        if (input.sessionID !== first && input.sessionID !== second) return get(input);
        entered.resolve();
        await release.promise;
        return { agent: "open-gajae-executor", parentID: ID, location: { directory: f.store.worktree } };
      };
      const childEvent = (sessionID: string, type: string, seq: number) => ({
        id: `evt_${sessionID}_${seq}`, type, durable: { aggregateID: sessionID, seq, version: 1 },
        data: { sessionID },
      });
      const result = (childID: string, seq: number, inboxID: string) => event("session.inbox.enqueued", seq, {
        inboxID, item: { type: "synthetic", payload: {
          text: "child result", metadata: { source: "subagent", childID, state: "completed" },
        } },
      });
      await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
      const start = childEvent(first, "session.execution.started", 1);
      f.hooks.observeEvent(start);
      const pending = f.hooks.onEvent(start);
      const later = [
        childEvent(first, "session.execution.succeeded", 2),
        result(first, 1, "msg_first"),
        childEvent(second, "session.execution.started", reused ? 3 : 1),
        event("session.inbox.delivered", 2, { inboxID: "msg_first" }),
      ];
      try {
        await entered.promise;
        for (const input of later) f.hooks.observeEvent(input);
      } finally { release.resolve(); await pending; }
      for (const input of later) await f.hooks.onEvent(input);
      await f.emit("session.execution.succeeded", 3);
      expect(f.resumes()).toHaveLength(0);
      await f.hooks.onEvent(childEvent(second, "session.execution.succeeded", reused ? 4 : 2));
      await f.emit("session.execution.succeeded", 4);
      console.info(`B10_1 ${JSON.stringify({ reused, beforeSecondDelivery: f.resumes().length })}`);
      expect(f.resumes()).toHaveLength(0);
      await f.hooks.onEvent(result(second, 5, "msg_second"));
      await f.emit("session.inbox.delivered", 6, { inboxID: "msg_second" });
      await f.emit("session.execution.succeeded", 7);
      expect(f.resumes()).toHaveLength(1);
    });
  });
}

async function uncertainActivation(f: Awaited<ReturnType<typeof setup>>) {
  await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
  await f.emit("session.inbox.enqueued", 1, {
    inboxID: "msg_recovery", item: { type: "user", payload: { text: "continue" }, delivery: "steer" },
  });
  const file = join(await f.store.resolveSessionDir(ID), "state", "todo.json");
  const original = fs.rename.bind(fs);
  const rename = spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
    await original(from, to);
    await original(file, file + ".saved");
    await fs.mkdir(file);
    throw new Error("F2 lost activation response and unreadable readback");
  });
  try { await f.emit("session.inbox.delivered", 2, { inboxID: "msg_recovery" }); }
  finally {
    rename.mockRestore();
    await fs.rm(file, { recursive: true });
    await original(file + ".saved", file);
  }
}

test("B10-2: rejected controller write publishes storage_failure at the displayed revision", async () => {
  await fixture(async (f) => {
    const changed: Array<Awaited<ReturnType<TodoStore["read"]>>> = [];
    f.hooks.configureTodo(settings, async (view) => { changed.push(view); });
    await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
    const before = await f.todo.read(ID);
    changed.length = 0;
    await f.emit("session.inbox.enqueued", 1, {
      inboxID: "msg_rejected", item: { type: "user", payload: { text: "continue" } },
    });
    const rename = spyOn(fs, "rename").mockRejectedValueOnce(new Error("B10 before replacement"));
    try { await f.emit("session.inbox.delivered", 2, { inboxID: "msg_rejected" }); }
    finally { rename.mockRestore(); }
    const after = await f.todo.read(ID);
    expect(before.status).toBe("ready");
    expect(after).toMatchObject({ status: "ready", revision: 1, hold: { reason: "storage_failure" } });
    console.info(`B10_2 ${JSON.stringify({ notifications: changed.length, after })}`);
    expect(changed).toContainEqual(after);
    const count = changed.length;
    await f.emit("session.execution.succeeded", 3);
    expect(f.resumes()).toHaveLength(0);
    expect(changed).toHaveLength(count);
  });
});

for (const { uncertain, viewFirst } of [
  { uncertain: false, viewFirst: false },
  { uncertain: false, viewFirst: true },
  { uncertain: true, viewFirst: true },
]) {
  test(`F3 reservation write: ${uncertain ? "uncertain" : "rejected"} storage recovery, viewFirst=${viewFirst}`, async () => {
    await fixture(async (f) => {
      // Given: normal form/ownership state and a genuine activation fence.
      const changed: Array<Awaited<ReturnType<TodoStore["read"]>>> = [];
      f.hooks.configureTodo(settings, async (view) => { changed.push(view); });
      await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
      await f.user(1);
      const before = await f.todo.read(ID);
      const file = join(await f.store.resolveSessionDir(ID), "state", "todo.json");
      const original = fs.rename.bind(fs);
      let faults = 0;
      changed.length = 0;
      // When: the reservation's real atomic replacement fails. The uncertain
      // variant commits, loses its response, and makes readback unreadable.
      const rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (String(to) !== file) return original(from, to);
        faults++;
        if (uncertain) {
          await original(from, to);
          await original(file, file + ".saved");
          await fs.mkdir(file);
        }
        throw new Error("F3 reservation storage fault");
      });
      try { await f.emit("session.execution.succeeded", 3); }
      finally {
        rename.mockRestore();
        if (uncertain && faults > 0) {
          await fs.rm(file, { recursive: true });
          await original(file + ".saved", file);
        }
      }
      // Then: reads and event retries release neither hold. Uncertain writes
      // additionally reject blind operations until authoritative reconciliation.
      expect(faults).toBe(1);
      expect(f.resumes()).toHaveLength(0);
      await f.todo.readSnapshot(ID);
      await f.emit("session.execution.succeeded", 3);
      await f.emit("session.execution.succeeded", 4);
      expect(f.resumes()).toHaveLength(0);
      expect(f.todo.storageHold(ID)).toBe(uncertain ? "uncertain_storage" : "storage_failure");
      if (uncertain) {
        expect(changed.some((view) => view.status === "invalid")).toBe(true);
        expect((await f.todo.apply(ID, { op: "done", task: "B" })).disposition).toBe("uncertain");
        expect(f.todo.storageHold(ID)).toBe("uncertain_storage");
        await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
      }
      const held = changed.findLast((view) => view.status === "ready");
      if (!held) throw new Error("reservation failure did not publish a ready held view");
      expect(held).toMatchObject({ status: "ready",
        hold: { reason: uncertain ? "uncertain_storage" : "storage_failure" } });
      if (!uncertain && before.status === "ready")
        expect(held).toMatchObject({ revision: before.revision });
      if (viewFirst) {
        expect(await f.todo.read(ID)).toEqual(held);
        await f.todo.apply(ID, { op: "view" });
      }
      await f.emit("session.execution.succeeded", 5);
      expect(f.resumes()).toHaveLength(0);
      expect(f.todo.storageHold(ID)).toBe(uncertain ? "uncertain_storage" : "storage_failure");
      expect((await f.apply(uncertain ? { op: "start", task: "A" } : { op: "done", task: "B" })).disposition).toBe("applied");
      await f.emit("session.execution.succeeded", 6);
      expect(f.resumes()).toHaveLength(1);
      expect(await f.todo.read(ID)).toMatchObject({ status: "ready", hold: null });
    });
  });
}

test("B10-2: view-only tool call emits a changed hold without claiming a committed mutation", async () => {
  await fixture(async (f) => {
    const changed: unknown[] = [];
    const tool = todoTool(f.todo, async (change) => { changed.push(change); });
    const actor = { sessionID: ID, agent: "open-gajae", signal: new AbortController().signal };
    await tool.execute({ op: "view" }, actor);
    changed.length = 0;
    await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
    await f.emit("session.inbox.enqueued", 1, {
      inboxID: "msg_tool_hold", item: { type: "user", payload: { text: "continue" } },
    });
    const rename = spyOn(fs, "rename").mockRejectedValueOnce(new Error("B10 tool before replacement"));
    try { await f.emit("session.inbox.delivered", 2, { inboxID: "msg_tool_hold" }); }
    finally { rename.mockRestore(); }
    const result = JSON.parse((await tool.execute({ op: "view" }, actor)).content);
    expect(result.disposition).toBe("unchanged");
    expect(changed).toEqual([{ sessionID: ID, view: result.view }]);
    await tool.execute({ op: "view" }, actor);
    expect(changed).toHaveLength(1);
  });
});

test("B10-2: uncertain storage and invalid-to-ready recovery publish effective holds", async () => {
  await fixture(async (f) => {
    const changed: Array<Awaited<ReturnType<TodoStore["read"]>>> = [];
    f.hooks.configureTodo(settings, async (view) => { changed.push(view); });
    await uncertainActivation(f);
    expect(changed.some((view) => view.status === "invalid")).toBe(true);
    const count = changed.length;
    await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
    const recovered = await f.todo.read(ID);
    expect(recovered).toMatchObject({ status: "ready", hold: { reason: "uncertain_storage" } });
    expect(changed.slice(count)).toContainEqual(recovered);
    await f.apply({ op: "start", task: "A" });
    await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
    expect(changed.at(-1)).toMatchObject({ status: "ready", hold: null });
  });
  await fixture(async (f) => {
    const changed: Array<Awaited<ReturnType<TodoStore["read"]>>> = [];
    f.hooks.configureTodo(settings, async (view) => { changed.push(view); });
    await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
    const file = join(await f.store.resolveSessionDir(ID), "state", "todo.json");
    const bytes = await fs.readFile(file);
    await fs.writeFile(file, "{invalid");
    await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
    expect(changed.at(-1)).toMatchObject({ status: "invalid" });
    await fs.writeFile(file, bytes);
    await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
    expect(changed.at(-1)).toMatchObject({ status: "ready", revision: 1, hold: { reason: "invalid_storage" } });
  });
});

for (const fault of [false, true]) {
  test(`F2-B2: ${fault ? "uncertain storage" : "no fault control"} resumes after authoritative view and explicit start`, async () => {
    await fixture(async (f) => {
      if (fault) await uncertainActivation(f);
      else {
        await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
        await f.user(1);
      }
      expect((await f.todo.apply(ID, { op: "view" })).view.status).toBe("ready");
      const input = { op: "start", task: "A" };
      await f.hooks.executeBefore({ sessionID: ID, agent: "open-gajae", tool: "todo", id: "f2_recovery", input });
      expect((await f.todo.apply(ID, input)).disposition).toBe("applied");
      await f.hooks.executeAfter({ sessionID: ID, agent: "open-gajae", tool: "todo", id: "f2_recovery", status: "success" });
      await f.emit("session.execution.succeeded", 3);
      console.info(`F2_B2 ${JSON.stringify({ fault, resumes: f.resumes().length, view: await f.todo.read(ID) })}`);
      expect(f.resumes()).toHaveLength(1);
    });
  });
}

for (const recovery of ["snapshot", "retry", "view"] as const) {
  test(`F2-B2: ${recovery} alone retains the storage veto and exposes its hold`, async () => {
    await fixture(async (f) => {
      await uncertainActivation(f);
      const loaded = await f.todo.readSnapshot(ID);
      expect(loaded.status).toBe("ready");
      if (recovery === "retry") {
        const result = await f.todo.apply(ID, { op: "start", task: "A" });
        expect(result.disposition).toBe("uncertain");
        expect(result.view).toMatchObject({ status: "ready", hold: { reason: "uncertain_storage" } });
      } else if (recovery === "view") {
        expect((await f.todo.apply(ID, { op: "view" })).view)
          .toMatchObject({ status: "ready", hold: { reason: "uncertain_storage" } });
      }
      await f.emit("session.execution.succeeded", 3);
      expect(f.resumes()).toHaveLength(0);
      expect(await f.todo.read(ID)).toMatchObject({ status: "ready", hold: { reason: "uncertain_storage" } });
    });
  });
}

for (const fault of ["invalid", "rejected"] as const) {
  test(`F2-B2: ${fault} storage veto recovers only through an applied explicit operation`, async () => {
    await fixture(async (f) => {
      await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
      const file = join(await f.store.resolveSessionDir(ID), "state", "todo.json");
      if (fault === "invalid") {
        const before = await fs.readFile(file);
        await fs.writeFile(file, "{invalid");
        await f.emit("session.execution.succeeded", 1);
        await fs.writeFile(file, before);
        await f.user(2);
      } else {
        await f.emit("session.inbox.enqueued", 1, {
          inboxID: "msg_rejected", item: { type: "user", payload: { text: "continue" } },
        });
        const rename = spyOn(fs, "rename").mockRejectedValueOnce(new Error("F2 before replacement"));
        try { await f.emit("session.inbox.delivered", 2, { inboxID: "msg_rejected" }); }
        finally { rename.mockRestore(); }
        await f.user(3);
      }
      await f.todo.apply(ID, { op: "view" });
      await f.emit("session.execution.succeeded", 5);
      expect(f.resumes()).toHaveLength(0);
      expect(await f.todo.read(ID)).toMatchObject({
        status: "ready", hold: { reason: fault === "invalid" ? "invalid_storage" : "storage_failure" },
      });
      await f.apply({ op: "start", task: "B" });
      await f.emit("session.execution.succeeded", 6);
      expect(f.resumes()).toHaveLength(1);
    });
  });
}

test("stale continuation context is removed without treating synthetic text as user activation", async () => {
  await fixture(async (f) => {
    await f.emit("session.execution.interrupted", 1, { reason: "user" });
    const context: ContextEvent = { sessionID: ID, agent: "open-gajae", messages: [
      { role: "user", content: [{ type: "text", text: "<open-gajae-todo-continuation>do old work</open-gajae-todo-continuation>" }] },
    ] };
    await f.hooks.context(context);
    expect(context.messages?.some((message) => message.content.some((part) =>
      typeof part.text === "string" && part.text.includes("<open-gajae-todo-continuation>")))).toBe(false);
    expect((await f.snapshot()).controller.activationFence).toBeNull();
    expect((await f.snapshot()).controller.hold?.reason).toBe("user_stop");
  });
});

const vetoes = ["stop", "directive", "form", "parent-wake", "agent"] as const;
const stages = ["before-reservation", "after-reservation", "accepted", "running"] as const;
for (const stage of stages) for (const veto of vetoes) {
  test(`continuation-race-matrix: ${veto} at ${stage}`, async () => {
    await fixture(async (f) => {
      const reached = deferred();
      const release = deferred();
      const native = f.session.synthetic;
      let dispatchSignal: AbortSignal | undefined;
      const update = TodoStore.prototype.updateController;
      let armed = true;
      const spy = spyOn(TodoStore.prototype, "updateController").mockImplementation(async function(this: TodoStore, sessionID, expected, change) {
        if (armed && stage === "before-reservation") {
          armed = false; reached.resolve(); await release.promise;
        }
        const result = await update.call(this, sessionID, expected, change);
        if (armed && stage === "after-reservation" && result.view.status === "ready") {
          armed = false; reached.resolve(); await release.promise;
        }
        return result;
      });
      f.session.synthetic = async (input, options) => {
        if (input.resume) dispatchSignal = options?.signal;
        const result = await native(input, options);
        if (input.resume && (stage === "accepted" || stage === "running")) {
          if (stage === "running") f.hooks.observeEvent(event("session.execution.started", 2));
          reached.resolve(); await release.promise;
        }
        return result;
      };
      const pending = f.emit("session.execution.succeeded", 1);
      try {
        await reached.promise;
        switch (veto) {
          case "stop": f.hooks.observeEvent(event("session.execution.interrupted", 3, { reason: "user" })); break;
          case "directive": f.hooks.observeEvent(event("session.inbox.enqueued", 3, {
            inboxID: "msg_next", item: { type: "user", payload: { text: "new task" } },
          })); break;
          case "form": f.hooks.observeEvent({ type: "form.created", data: { form: { id: "form_1", sessionID: ID } } }); break;
          case "parent-wake": f.hooks.observeEvent(event("session.inbox.enqueued", 3, {
            inboxID: "msg_child", item: { type: "synthetic", payload: {
              text: "result", metadata: { source: "subagent", childID: "ses_child", state: "completed" },
            } },
          })); break;
          case "agent":
            f.setAgent("open-gajae-executor");
            f.hooks.observeEvent(event("session.agent.selected", 3, { agent: "open-gajae-executor" }));
            break;
        }
        if (stage === "accepted" || stage === "running") expect(dispatchSignal?.aborted).toBe(true);
      } finally { release.resolve(); await pending; spy.mockRestore(); }
      const accepted = stage === "accepted" || stage === "running" ? 1 : 0;
      expect(f.resumes()).toHaveLength(accepted);
      await f.emit("session.execution.succeeded", 4);
      expect(f.resumes()).toHaveLength(accepted);
      if (veto === "stop") expect((await f.snapshot()).controller.hold?.reason).toBe("user_stop");
      evidence(`continuation-race-matrix/${stage}/${veto}`, await f.snapshot(), f.resumes().length);
    });
  });
}

test("cleanup aborts pending dispatch and queued observation cannot resurrect continuation", async () => {
  await fixture(async (f) => {
    const entered = deferred();
    f.session.synthetic = async (input, options) => {
      if (!input.resume) throw new Error("cleanup must not send another synthetic");
      const signal = options?.signal;
      if (!signal) throw new Error("dispatch signal missing");
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("native request aborted")), { once: true });
        entered.resolve();
      });
    };
    const dispatch = f.emit("session.execution.succeeded", 1);
    await entered.promise;
    await f.hooks.dispose();
    await dispatch;
    await f.emit("session.execution.succeeded", 2);
    expect((await f.snapshot()).controller.reservation?.status).toBe("uncertain");
    expect(f.resumes()).toHaveLength(0);
  });
});

test("gate B1: approval committed during the final snapshot await vetoes dispatch", async () => {
  await fixture(async (f) => {
    const reached = deferred();
    const release = deferred();
    const original = TodoStore.prototype.readSnapshot;
    let armed = true;
    const spy = spyOn(TodoStore.prototype, "readSnapshot").mockImplementation(async function(this: TodoStore, id) {
      const result = await original.call(this, id);
      if (armed && result.status === "ready" && result.snapshot.controller.reservation?.status === "reserved") {
        armed = false;
        reached.resolve();
        await release.promise;
      }
      return result;
    });
    const pending = f.emit("session.execution.succeeded", 1);
    try {
      await reached.promise;
      await f.store.workflowTransaction(ID, (tx) => syncActiveRowTx(tx, {
        skill: "ralplan", active: true, phase: "approval", sessionId: ID,
      }, RUNTIME_OWNER));
    } finally { release.resolve(); await pending; spy.mockRestore(); }
    expect(f.resumes()).toHaveLength(0);
    expect((await f.snapshot()).controller.reservation?.status).toBe("cancelled");
    evidence("gate-repair/B1-final-snapshot-approval", await f.snapshot(), f.resumes().length);
  });
});

for (const status of ["active", "paused", "complete"] as const) {
  test(`gate B2: explicit ${status} goal hold committed after reservation vetoes dispatch`, async () => {
    await fixture(async (f) => {
      const reached = deferred();
      const release = deferred();
      const original = TodoStore.prototype.updateController;
      let armed = true;
      const spy = spyOn(TodoStore.prototype, "updateController").mockImplementation(async function(this: TodoStore, id, expected, update) {
        const result = await original.call(this, id, expected, update);
        if (armed) {
          armed = false;
          reached.resolve();
          await release.promise;
        }
        return result;
      });
      const pending = f.emit("session.execution.succeeded", 1);
      try {
        await reached.promise;
        await f.store.workflowTransaction(ID, async (tx) => {
          await tx.writeText(tx.paths.goalState, JSON.stringify({
            version: 1, id: "goal_gate", objective: "owned", status, source: "user",
            created_at: "2026-10-13", updated_at: "2026-10-13",
          }), { audit: false });
          await tx.writeText(tx.paths.goalContinuation, JSON.stringify({
            goal_id: "goal_gate", tool_less_turns: 3,
            held: { reason: "no_tool_progress", at: "2026-10-13" },
          }), { audit: false });
        });
      } finally { release.resolve(); await pending; spy.mockRestore(); }
      expect(f.resumes()).toHaveLength(0);
      expect((await f.snapshot()).controller.reservation?.status).toBe("cancelled");
      evidence(`gate-repair/B2-${status}-goal-hold`, await f.snapshot(), f.resumes().length);
    });
  });
}

for (const cached of [false, true]) {
  test(`cross-location RPC notifications preserve local question holds with ownership cached=${cached}`, async () => {
    await fixture(async (f) => {
      // Given: the process-wide RPC emitter belongs to another plugin location,
      // but its changed payload describes this location's session.
      if (cached) await f.emit("session.execution.started", 1);
      await f.hooks.onEvent({
        type: "rpc.open-gajae.todo.changed",
        location: { directory: "/other-plugin-location" },
        data: { sessionID: ID, view: await f.todo.read(ID) },
      });
      // When: the local session asks a question after that notification.
      await f.hooks.onEvent({
        type: "form.created",
        data: { form: { id: "form_local", sessionID: ID } },
      });
      // Then: notification placement cannot suppress the local form hold.
      expect(await f.todo.read(ID)).toMatchObject({
        status: "ready", hold: { reason: "unanswered_form" },
      });
      expect(f.resumes()).toHaveLength(0);
    });
  });
}

test("gate B3: unanswered forms publish a transient hold and one passive notice per episode", async () => {
  await fixture(async (f) => {
    const notices = () => f.calls.filter((call) => !call.resume &&
      call.text.startsWith("<open-gajae-todo-notice>"));
    const create = (id: string) => f.hooks.onEvent({
      type: "form.created", data: { form: { id, sessionID: ID } },
    });
    const before = await f.snapshot();
    await create("form_a");
    await create("form_b");
    await f.emit("session.execution.succeeded", 1);
    const held = await f.todo.read(ID);
    expect(held.status).toBe("ready");
    if (held.status !== "ready") throw new Error("expected ready board");
    expect(held.hold?.reason).toBe("unanswered_form");
    expect(held.hold?.noticeSent).toBe(true);
    expect(notices()).toHaveLength(1);
    expect(f.resumes()).toHaveLength(0);
    evidence("gate-repair/B3-form-held", await f.snapshot(), f.resumes().length);
    await create("form_a");
    await f.emit("session.execution.succeeded", 2);
    await f.emit("form.replied", 3, { id: "form_a" });
    await f.emit("form.cancelled", 4, { id: "form_unknown" });
    await f.emit("session.execution.succeeded", 5);
    expect((await f.snapshot()).controller.hold?.reason).toBe("unanswered_form");
    expect(notices()).toHaveLength(1);
    await f.emit("form.cancelled", 6, { id: "form_b" });
    const cleared = await f.snapshot();
    expect(cleared.controller).toEqual({ ...before.controller, hold: null });
    const passive = notices()[0];
    if (!passive) throw new Error("passive notice missing");
    await f.emit("session.inbox.enqueued", 7, {
      inboxID: passive.id, item: { type: "synthetic", payload: {
        text: passive.text, metadata: passive.metadata,
      } },
    });
    await f.emit("session.execution.succeeded", 8);
    expect(f.resumes()).toHaveLength(1);
    await create("form_c");
    await f.emit("session.execution.succeeded", 9);
    expect(notices()).toHaveLength(2);
    await f.emit("form.replied", 10, { id: "form_c" });
    await f.emit("session.execution.succeeded", 11);
    expect(f.resumes()).toHaveLength(2);
    expect((await f.snapshot()).controller).toMatchObject({ hold: null, stagnation: 1, workEpoch: 1 });
    evidence("gate-repair/B3-form-cleared", await f.snapshot(), f.resumes().length);
  });
});

test("gate B3: answering a form never releases an overlapping manual user stop", async () => {
  await fixture(async (f) => {
    await f.hooks.onEvent({ type: "form.created", data: { form: { id: "form_stop", sessionID: ID } } });
    await f.emit("session.execution.succeeded", 1);
    expect((await f.snapshot()).controller.hold?.reason).toBe("unanswered_form");
    await f.emit("session.execution.interrupted", 2, { reason: "user" });
    await f.emit("form.replied", 3, { id: "form_stop" });
    await f.emit("session.execution.succeeded", 4);
    expect((await f.snapshot()).controller.hold?.reason).toBe("user_stop");
    expect(f.resumes()).toHaveLength(0);
    await f.user(5);
    await f.apply({ op: "start", task: "A" });
    await f.emit("session.execution.succeeded", 7);
    expect(f.resumes()).toHaveLength(1);
    evidence("gate-repair/B3-manual-stop-independent", await f.snapshot(), f.resumes().length);
  });
});

test("gate B3: explicit start cannot duplicate a pending form notice or mask an execution error", async () => {
  await fixture(async (f) => {
    await f.hooks.onEvent({ type: "form.created", data: { form: { id: "form_active", sessionID: ID } } });
    await f.emit("session.execution.succeeded", 1);
    await f.user(2);
    const input = { op: "start", task: "A" };
    await f.hooks.executeBefore({ sessionID: ID, agent: "open-gajae", tool: "todo", id: "start_with_form", input });
    await f.apply(input);
    await f.hooks.executeAfter({ sessionID: ID, agent: "open-gajae", tool: "todo", id: "start_with_form", status: "success" });
    await f.emit("session.execution.succeeded", 4);
    expect((await f.snapshot()).controller.hold?.reason).toBe("unanswered_form");
    expect(f.calls.filter((call) => !call.resume &&
      call.text.startsWith("<open-gajae-todo-notice>"))).toHaveLength(1);
    await f.emit("session.execution.failed", 5, { error: { message: "unrecoverable" } });
    await f.emit("form.replied", 6, { id: "form_active" });
    await f.emit("session.execution.succeeded", 7);
    expect((await f.snapshot()).controller.hold?.reason).toBe("execution_error");
    expect(f.resumes()).toHaveLength(0);
    evidence("gate-repair/B3-execution-error-independent", await f.snapshot(), f.resumes().length);
  });
});

for (const replayedStart of [1, 2]) {
  test(`gate N1: replayed start seq ${replayedStart} cannot reconcile persisted watermark seq 2`, async () => {
    await fixture(async (f) => {
      await f.emit("session.execution.started", 1);
      await f.emit("session.execution.succeeded", 2);
      const before = await f.snapshot();
      const fresh = f.makeHooks();
      try {
        await fresh.onEvent(event("session.execution.started", replayedStart));
        await fresh.onEvent(event("session.execution.succeeded", 3));
        expect(f.resumes()).toHaveLength(1);
        expect(await f.snapshot()).toEqual(before);
        evidence(`gate-repair/N1-rejected-start-${replayedStart}`, await f.snapshot(), f.resumes().length);
        await fresh.onEvent(event("session.execution.started", 4));
        await fresh.onEvent(event("session.execution.succeeded", 5));
        expect(f.resumes()).toHaveLength(2);
        expect((await f.snapshot()).controller).toMatchObject({
          sourceWatermark: { eventID: "evt_5", seq: 5 }, stagnation: 1,
        });
      } finally { await fresh.dispose(); }
    });
  });
}

test("gate B4: restart with two forms keeps the second form held after a partial answer", async () => {
  await fixture(async (f) => {
    for (const id of ["form_a", "form_b"])
      await f.hooks.onEvent({ type: "form.created", data: { form: { id, sessionID: ID } } });
    await f.emit("session.execution.succeeded", 1);
    await f.hooks.dispose();
    const fresh = f.makeHooks();
    try {
      await fresh.onEvent(event("form.replied", 2, { id: "form_a" }));
      await fresh.onEvent(event("session.execution.succeeded", 3));
      expect(f.resumes()).toHaveLength(0);
      expect((await f.snapshot()).controller.hold?.reason).toBe("unanswered_form");
      expect(f.calls.filter((call) => !call.resume)).toHaveLength(1);
      const forms = JSON.parse(await readFile(join(await f.store.resolveSessionDir(ID), "state", "todo-forms.json"), "utf8"));
      expect(forms.pending).toEqual(["form_b"]);
      evidence("gate-B4/partial-answer", await f.snapshot(), f.resumes().length);
      if (process.env.TODO_CONTINUATION_EVIDENCE === "1") console.info("TODO_FORM_EVIDENCE", JSON.stringify(forms));
    } finally { await fresh.dispose(); }
  });
});

test("gate B4: restart then user fence and explicit start cannot answer a pending form", async () => {
  await fixture(async (f) => {
    await f.hooks.onEvent({ type: "form.created", data: { form: { id: "form_a", sessionID: ID } } });
    await f.emit("session.execution.succeeded", 1);
    await f.hooks.dispose();
    const fresh = f.makeHooks();
    try {
      await fresh.onEvent(event("session.inbox.enqueued", 2, {
        inboxID: "msg_new_user", item: { type: "user", payload: { text: "continue" }, delivery: "steer" },
      }));
      await fresh.onEvent(event("session.inbox.delivered", 3, { inboxID: "msg_new_user" }));
      const input = { op: "start", task: "A" };
      await fresh.executeBefore({ sessionID: ID, agent: "open-gajae", tool: "todo", id: "start_after_restart", input });
      await f.apply(input);
      await fresh.executeAfter({ sessionID: ID, agent: "open-gajae", tool: "todo", id: "start_after_restart", status: "success" });
      await fresh.onEvent(event("session.execution.succeeded", 4));
      expect(f.resumes()).toHaveLength(0);
      expect((await f.snapshot()).controller.hold?.reason).toBe("unanswered_form");
      expect(f.calls.filter((call) => !call.resume)).toHaveLength(1);
      evidence("gate-B4/start-without-answer", await f.snapshot(), f.resumes().length);
    } finally { await fresh.dispose(); }
  });
});

test("gate B4: restart releases only after all forms resolve and dispatches exactly once", async () => {
  await fixture(async (f) => {
    for (const id of ["form_a", "form_b"])
      await f.hooks.onEvent({ type: "form.created", data: { form: { id, sessionID: ID } } });
    await f.emit("session.execution.succeeded", 1);
    const held = await f.snapshot();
    await f.hooks.dispose();
    const fresh = f.makeHooks();
    try {
      await fresh.onEvent(event("form.replied", 2, { id: "form_a" }));
      expect((await f.snapshot()).controller.hold?.reason).toBe("unanswered_form");
      await fresh.onEvent(event("form.cancelled", 3, { id: "form_unrelated" }));
      expect((await f.snapshot()).controller.hold?.reason).toBe("unanswered_form");
      await fresh.onEvent(event("form.cancelled", 4, { id: "form_b" }));
      expect((await f.snapshot()).controller).toEqual({ ...held.controller, hold: null });
      await fresh.onEvent(event("session.execution.succeeded", 5));
      await fresh.onEvent(event("session.execution.succeeded", 5));
      expect(f.resumes()).toHaveLength(1);
      expect(f.calls.filter((call) => !call.resume)).toHaveLength(1);
      const forms = JSON.parse(await readFile(join(await f.store.resolveSessionDir(ID), "state", "todo-forms.json"), "utf8"));
      expect(forms.pending).toEqual([]);
      expect(forms.unknown).toBe(false);
      evidence("gate-B4/all-answered", await f.snapshot(), f.resumes().length);
      if (process.env.TODO_CONTINUATION_EVIDENCE === "1") console.info("TODO_FORM_EVIDENCE", JSON.stringify(forms));
    } finally { await fresh.dispose(); }
  });
});

for (const failure of ["missing", "corrupt", "foreign-owner", "future-schema"] as const) {
  test(`gate B4: ${failure} form identity storage cannot release a restored hold`, async () => {
    await fixture(async (f) => {
      await f.hooks.onEvent({ type: "form.created", data: { form: { id: "form_a", sessionID: ID } } });
      await f.emit("session.execution.succeeded", 1);
      await f.hooks.dispose();
      const file = join(await f.store.resolveSessionDir(ID), "state", "todo-forms.json");
      const bytes = failure === "corrupt" ? "{" : JSON.stringify({
        schemaVersion: failure === "future-schema" ? 2 : 1,
        sessionID: failure === "foreign-owner" ? "ses_other" : ID,
        pending: ["form_a"], unknown: false, episode: "episode_fixture", noticeSent: true,
      });
      if (failure === "missing") await rm(file, { force: true });
      else await writeFile(file, bytes);
      const fresh = f.makeHooks();
      try {
        await fresh.onEvent(event("form.replied", 2, { id: "form_a" }));
        await fresh.onEvent(event("session.inbox.enqueued", 3, {
          inboxID: "msg_user", item: { type: "user", payload: { text: "continue" }, delivery: "steer" },
        }));
        await fresh.onEvent(event("session.inbox.delivered", 4, { inboxID: "msg_user" }));
        const input = { op: "start", task: "A" };
        await fresh.executeBefore({ sessionID: ID, agent: "open-gajae", tool: "todo", id: "unknown_forms_start", input });
        await f.apply(input);
        await fresh.executeAfter({ sessionID: ID, agent: "open-gajae", tool: "todo", id: "unknown_forms_start", status: "success" });
        await fresh.onEvent(event("session.execution.succeeded", 5));
        expect(f.resumes()).toHaveLength(0);
        expect((await f.snapshot()).controller.hold?.reason).toBe("form_state_unknown");
        if (failure !== "missing") expect(await readFile(file, "utf8")).toBe(bytes);
        evidence(`gate-B4/${failure}`, await f.snapshot(), f.resumes().length);
      } finally { await fresh.dispose(); }
    });
  });
}

async function restoredUserOperation(
  f: Awaited<ReturnType<typeof setup>>, hooks: ReturnType<typeof createHooks>,
  seq: number, input: Record<string, unknown>,
) {
  await hooks.onEvent(event("session.inbox.enqueued", seq, {
    inboxID: `msg_recovery_${seq}`, item: { type: "user", payload: { text: "continue" }, delivery: "steer" },
  }));
  await hooks.onEvent(event("session.inbox.delivered", seq + 1, { inboxID: `msg_recovery_${seq}` }));
  await hooks.executeBefore({ sessionID: ID, agent: "open-gajae", tool: "todo", id: `recovery_${seq}`, input });
  await f.apply(input);
  await hooks.executeAfter({ sessionID: ID, agent: "open-gajae", tool: "todo", id: `recovery_${seq}`, status: "success" });
}

test("backend instance: a new setup releases the previous instance's vanished question", async () => {
  await fixture(async (f) => {
    await f.hooks.onEvent({ type: "form.created", data: { form: { id: "form_old", sessionID: ID } } });
    await f.emit("session.execution.succeeded", 1);
    const file = join(await f.store.resolveSessionDir(ID), "state", "todo-forms.json");
    const before = JSON.parse(await readFile(file, "utf8"));
    await f.hooks.dispose();
    const next = f.makeHooks(new StateStore(f.store.worktree, async () => 1_800_000_000_000));
    try {
      await next.context({ sessionID: ID, agent: "open-gajae", messages: [] });
      expect((await f.todo.read(ID))).toMatchObject({ status: "ready", hold: null });
      await next.onEvent(event("session.execution.started", 2));
      await next.onEvent(event("session.execution.succeeded", 3));
      expect(f.resumes()).toHaveLength(1);
      const after = JSON.parse(await readFile(file, "utf8"));
      expect(before.instanceID).toEqual(expect.any(String));
      expect(after.instanceID).not.toBe(before.instanceID);
      expect(after).toMatchObject({ pending: [], unknown: false, recovery: {
        reason: "backend_instance_changed", previousInstanceID: before.instanceID, discarded: 1,
      } });
    } finally { await next.dispose(); }
  });
});

test("backend instance: hook reconstruction in the current setup still requires the actual answer", async () => {
  await fixture(async (f) => {
    await f.hooks.onEvent({ type: "form.created", data: { form: { id: "form_current", sessionID: ID } } });
    await f.emit("session.execution.succeeded", 1);
    await f.hooks.dispose();
    const same = f.makeHooks();
    try {
      await restoredUserOperation(f, same, 2, { op: "start", task: "A" });
      await same.onEvent(event("session.execution.succeeded", 4));
      expect(f.resumes()).toHaveLength(0);
      expect((await f.snapshot()).controller.hold?.reason).toBe("unanswered_form");
      await same.onEvent(event("form.replied", 5, { id: "form_current" }));
      await same.onEvent(event("session.execution.succeeded", 6));
      expect(f.resumes()).toHaveLength(1);
      expect((await f.snapshot()).controller.hold).toBeNull();
    } finally { await same.dispose(); }
  });
});

for (const damaged of [
  { name: "JSON", bytes: Buffer.from("{invalid") },
  { name: "UTF8", bytes: Buffer.from("fffe7b227d", "hex") },
  { name: "oversized", bytes: Buffer.alloc(1_048_577, 0xff) },
]) {
  test(`backend instance: new setup archives ${damaged.name} damage and releases without a form API`, async () => {
    await fixture(async (f) => {
      await f.hooks.onEvent({ type: "form.created", data: { form: { id: "form_old", sessionID: ID } } });
      await f.emit("session.execution.succeeded", 1);
      await f.hooks.dispose();
      const dir = join(await f.store.resolveSessionDir(ID), "state");
      const file = join(dir, "todo-forms.json");
      await writeFile(file, damaged.bytes);
      const next = f.makeHooks(new StateStore(f.store.worktree, async () => 1_800_000_000_000));
      try {
        await next.context({ sessionID: ID, agent: "open-gajae", messages: [] });
        expect((await f.snapshot()).controller.hold).toBeNull();
        const archives = (await readdir(dir)).filter((name) => name.startsWith("todo-forms.invalid-"));
        expect(archives).toHaveLength(1);
        const archive = archives[0];
        if (!archive) throw new Error("damaged prior-instance archive missing");
        expect(await readFile(join(dir, archive))).toEqual(damaged.bytes);
        expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
          pending: [], unknown: false, recovery: { reason: "backend_instance_changed" },
        });
        await next.onEvent(event("session.execution.succeeded", 2));
        expect(f.resumes()).toHaveLength(1);
      } finally { await next.dispose(); }
    });
  });
}

test("standalone: fresh session without form evidence remains eligible when host queries are unavailable", async () => {
  await fixture(async (f) => {
    let queries = 0;
    f.hooks.configureTodo(settings, async () => {}, async () => {
      queries++;
      throw new Error("standalone host has no discoverable endpoint");
    });
    await f.user(1);
    await f.emit("session.execution.started", 3);
    await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
    await f.emit("session.execution.succeeded", 4);
    expect(f.resumes()).toHaveLength(1);
    expect((await f.snapshot()).controller.hold).toBeNull();
    expect(queries).toBe(0);
  });
});

test("standalone: stored identity stays held with unreachable host until its actual answer", async () => {
  await fixture(async (f) => {
    await f.hooks.onEvent({ type: "form.created", data: { form: { id: "form_a", sessionID: ID } } });
    await f.emit("session.execution.succeeded", 1);
    await f.hooks.dispose();
    const fresh = f.makeHooks();
    let queries = 0;
    fresh.configureTodo(settings, async () => {}, async () => {
      queries++;
      throw new Error("standalone host has no discoverable endpoint");
    });
    try {
      await fresh.context({ sessionID: ID, agent: "open-gajae", messages: [] });
      await restoredUserOperation(f, fresh, 2, { op: "start", task: "A" });
      await fresh.onEvent(event("session.execution.succeeded", 4));
      expect(queries).toBeGreaterThan(0);
      expect(f.resumes()).toHaveLength(0);
      expect((await f.snapshot()).controller.hold?.reason).toBe("unanswered_form");
      const file = join(await f.store.resolveSessionDir(ID), "state", "todo-forms.json");
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ pending: ["form_a"], unknown: false });
      await fresh.onEvent(event("form.replied", 5, { id: "form_a" }));
      await fresh.onEvent(event("session.execution.succeeded", 6));
      expect(f.resumes()).toHaveLength(1);
      expect((await f.snapshot()).controller.hold).toBeNull();
    } finally { await fresh.dispose(); }
  });
});

test("gate B5: offline answer is reconciled from host pending forms on restore", async () => {
  await fixture(async (f) => {
    await f.hooks.onEvent({ type: "form.created", data: { form: { id: "form_a", sessionID: ID } } });
    await f.emit("session.execution.succeeded", 1);
    await f.hooks.dispose();
    const fresh = f.makeHooks();
    let queries = 0;
    fresh.configureTodo(settings, async () => {}, async () => { queries++; return []; });
    try {
      await fresh.context({ sessionID: ID, agent: "open-gajae", messages: [] });
      expect(queries).toBe(1);
      expect((await f.snapshot()).controller.hold).toBeNull();
      await fresh.onEvent(event("session.execution.started", 2));
      await fresh.onEvent(event("session.execution.succeeded", 3));
      await fresh.onEvent(event("session.execution.succeeded", 3));
      expect(f.resumes()).toHaveLength(1);
      expect((await f.snapshot()).controller.activationFence).toBeNull();
      evidence("gate-B5/offline-answer", await f.snapshot(), f.resumes().length);
    } finally { await fresh.dispose(); }
  });
});

for (const operation of ["start", "init", "append"] as const) {
  test(`gate B5: genuine ${operation} cannot bypass a question the host still reports pending`, async () => {
    await fixture(async (f) => {
      await f.hooks.onEvent({ type: "form.created", data: { form: { id: "form_a", sessionID: ID } } });
      await f.emit("session.execution.succeeded", 1);
      await f.hooks.dispose();
      const fresh = f.makeHooks();
      const hostPending = new Set(["form_a"]);
      let queries = 0;
      fresh.configureTodo(settings, async () => {}, async (sessionID) => {
        queries++;
        return [...hostPending].map((id) => ({ id, sessionID }));
      });
      try {
        await fresh.compaction({ sessionID: ID, system: [] });
        expect((await f.snapshot()).controller.hold?.reason).toBe("unanswered_form");
        expect((await f.snapshot()).controller.activationFence).toBeNull();
        const input = operation === "start" ? { op: operation, task: "A" } :
          operation === "init" ? { op: operation, list: [{ phase: "New", items: ["X"] }] } :
            { op: operation, phase: "Work", items: ["New requirement"] };
        await restoredUserOperation(f, fresh, 2, input);
        await fresh.onEvent(event("session.execution.succeeded", 4));
        expect(queries).toBeGreaterThan(0);
        expect(f.resumes()).toHaveLength(0);
        expect((await f.snapshot()).controller.hold?.reason).toBe("unanswered_form");
        hostPending.delete("form_a");
        await fresh.onEvent(event("form.replied", 5, { id: "form_a" }));
        await fresh.onEvent(event("session.execution.succeeded", 6));
        await fresh.onEvent(event("session.execution.succeeded", 6));
        expect(f.resumes()).toHaveLength(1);
        evidence(`gate-B5/pending-${operation}-then-answer`, await f.snapshot(), f.resumes().length);
      } finally { await fresh.dispose(); }
    });
  });
}

for (const trigger of ["user", "form", "restore"] as const) {
  test(`gate B5: failed host reconciliation retries on the next ${trigger} event without polling`, async () => {
    await fixture(async (f) => {
      await f.hooks.onEvent({ type: "form.created", data: { form: { id: "form_a", sessionID: ID } } });
      await f.emit("session.execution.succeeded", 1);
      await f.hooks.dispose();
      const file = join(await f.store.resolveSessionDir(ID), "state", "todo-forms.json");
      await writeFile(file, "{unreadable");
      const fresh = f.makeHooks();
      let unavailable = true;
      let queries = 0;
      fresh.configureTodo(settings, async () => {}, async () => {
        queries++;
        if (unavailable) throw new Error("host temporarily unavailable");
        return [];
      });
      try {
        await fresh.context({ sessionID: ID, agent: "open-gajae", messages: [] });
        expect(queries).toBe(1);
        expect((await f.snapshot()).controller.hold).not.toBeNull();
        const heldQueries = queries;
        await fresh.prompt({ sessionID: ID, prompt: { text: "<open-gajae-todo-notice>continue</open-gajae-todo-notice>" } });
        await fresh.onEvent(event("session.inbox.enqueued", 2, {
          inboxID: "msg_synthetic", item: { type: "synthetic", payload: {
            text: "continue", metadata: { source: "open-gajae.todo", kind: "notice" },
          } },
        }));
        await fresh.onEvent(event("session.inbox.delivered", 3, { inboxID: "msg_synthetic" }));
        await fresh.onEvent(event("session.execution.succeeded", 4));
        expect(queries).toBe(heldQueries);
        expect(f.resumes()).toHaveLength(0);
        unavailable = false;
        if (trigger === "user") {
          await fresh.onEvent(event("session.inbox.enqueued", 5, {
            inboxID: "msg_actual", item: { type: "user", payload: { text: "status" }, delivery: "steer" },
          }));
          await fresh.onEvent(event("session.inbox.delivered", 6, { inboxID: "msg_actual" }));
        } else if (trigger === "form") {
          await fresh.onEvent(event("form.cancelled", 6, { id: "form_a" }));
        } else {
          await fresh.onEvent(event("session.viewed", 6));
        }
        expect(queries).toBe(heldQueries + 1);
        expect((await f.snapshot()).controller.hold).toBeNull();
        await fresh.onEvent(event("session.execution.succeeded", 7));
        expect(f.resumes()).toHaveLength(1);
        const stateDir = join(await f.store.resolveSessionDir(ID), "state");
        const archived = (await readdir(stateDir)).filter((name) => name.startsWith("todo-forms.invalid-"));
        expect(archived).toHaveLength(1);
        const name = archived[0];
        if (!name) throw new Error("invalid form state archive missing");
        expect(await readFile(join(stateDir, name), "utf8")).toBe("{unreadable");
        expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ pending: [], unknown: false });
        evidence(`gate-B5/retry-${trigger}`, await f.snapshot(), f.resumes().length);
      } finally { await fresh.dispose(); }
    });
  });
}

test("gate B6: legacy user_stop without a sidecar is not unknown question state", async () => {
  await fixture(async (f) => {
    await f.emit("session.execution.interrupted", 1, { reason: "user" });
    await f.hooks.dispose();
    await rm(join(await f.store.resolveSessionDir(ID), "state", "todo-forms.json"));
    const fresh = f.makeHooks();
    fresh.configureTodo(settings, async () => {}, async () => []);
    try {
      await fresh.context({ sessionID: ID, agent: "open-gajae", messages: [] });
      expect((await f.snapshot()).controller.hold?.reason).toBe("user_stop");
      await restoredUserOperation(f, fresh, 2, { op: "start", task: "A" });
      await fresh.onEvent(event("session.execution.succeeded", 4));
      expect(f.resumes()).toHaveLength(1);
      expect((await f.snapshot()).controller.hold).toBeNull();
      evidence("gate-B6/legacy-user-stop", await f.snapshot(), f.resumes().length);
    } finally { await fresh.dispose(); }
  });
});

test("gate B5: unknown identities reconcile without rm or init bypassing a host question", async () => {
  await fixture(async (f) => {
    await f.hooks.onEvent({ type: "form.created", data: { form: { id: "form_old", sessionID: ID } } });
    await f.emit("session.execution.succeeded", 1);
    await f.hooks.dispose();
    const file = join(await f.store.resolveSessionDir(ID), "state", "todo-forms.json");
    await rm(file);
    const fresh = f.makeHooks();
    const hostPending = new Set(["form_current"]);
    fresh.configureTodo(settings, async () => {}, async (sessionID) =>
      [...hostPending].map((id) => ({ id, sessionID })));
    try {
      await fresh.context({ sessionID: ID, agent: "open-gajae", messages: [] });
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ pending: ["form_current"], unknown: false });
      await restoredUserOperation(f, fresh, 2, { op: "rm" });
      await restoredUserOperation(f, fresh, 4, { op: "init", list: [{ phase: "New", items: ["X"] }] });
      await fresh.onEvent(event("session.execution.succeeded", 6));
      expect(f.resumes()).toHaveLength(0);
      expect((await f.snapshot()).controller.hold?.reason).toBe("unanswered_form");
      hostPending.clear();
      await fresh.onEvent(event("form.cancelled", 7, { id: "form_current" }));
      await fresh.onEvent(event("session.execution.succeeded", 8));
      expect(f.resumes()).toHaveLength(1);
      evidence("gate-B5/unknown-rm-init", await f.snapshot(), f.resumes().length);
    } finally { await fresh.dispose(); }
  });
});

test("gate B5: public form reader uses authenticated session APIs and rejects foreign ownership", async () => {
  const { readTodoHostForms } = await import("../src/todo/continuation");
  const requests: string[] = [];
  let foreign = false;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:test-password").toString("base64")}`);
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path.endsWith("/form"))
        return Response.json({ data: [{ id: "form_host", sessionID: ID, title: "Question", fields: [] }] });
      return Response.json({ data: { id: ID, location: { directory: foreign ? "/other" : "/test-location" } } });
    },
  });
  try {
    const input = {
      sessionID: ID, locationDir: "/test-location", signal: new AbortController().signal,
      endpoint: { url: server.url.toString(), auth: { type: "basic" as const, username: "opencode", password: "test-password" } },
    };
    expect(await readTodoHostForms(input)).toEqual([{ id: "form_host", sessionID: ID }]);
    expect(requests).toEqual([`/api/session/${ID}`, `/api/session/${ID}/form`]);
    foreign = true;
    await expect(readTodoHostForms(input)).rejects.toThrow();
    expect(requests).toHaveLength(3);
  } finally { await server.stop(true); }
});

for (const damaged of [
  { name: "fffe7b227d", bytes: Buffer.from("fffe7b227d", "hex") },
  {
    name: "non-UTF8 inside otherwise valid JSON",
    bytes: Buffer.concat([
      Buffer.from(`{"schemaVersion":1,"sessionID":"${ID}","pending":["`),
      Buffer.from([0xff]),
      Buffer.from('"],"unknown":false,"episode":"form_episode","noticeSent":false}'),
    ]),
  },
]) {
  test(`gate B7: recovery archives original bytes for ${damaged.name}`, async () => {
    await fixture(async (f) => {
      const stateDir = join(await f.store.resolveSessionDir(ID), "state");
      const file = join(stateDir, "todo-forms.json");
      await writeFile(file, damaged.bytes);
      f.hooks.configureTodo(settings, async () => {}, async () => []);
      await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
      expect((await f.snapshot()).controller.hold).toBeNull();
      const names = (await readdir(stateDir)).filter((name) => name.startsWith("todo-forms.invalid-"));
      expect(names).toHaveLength(1);
      const name = names[0];
      if (!name) throw new Error("raw form archive missing");
      const archived = await readFile(join(stateDir, name));
      expect(archived).toEqual(damaged.bytes);
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ pending: [], unknown: false });
      await f.emit("session.execution.succeeded", 1);
      expect(f.resumes()).toHaveLength(1);
      if (process.env.TODO_CONTINUATION_EVIDENCE === "1")
        console.info("TODO_BYTE_EVIDENCE", JSON.stringify({
          scenario: damaged.name, beforeHex: damaged.bytes.toString("hex"),
          archivedHex: archived.toString("hex"), accepted: f.resumes().length,
        }));
    });
  });
}

test("gate B7: invalid board bytes remain byte-identical in place", async () => {
  await fixture(async (f) => {
    const file = join(await f.store.resolveSessionDir(ID), "state", "todo.json");
    const bytes = Buffer.from("fffe7b227d", "hex");
    await writeFile(file, bytes);
    await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
    await f.emit("session.execution.succeeded", 1);
    expect((await f.todo.read(ID)).status).toBe("invalid");
    const after = await readFile(file);
    expect(after).toEqual(bytes);
    expect(f.resumes()).toHaveLength(0);
    if (process.env.TODO_CONTINUATION_EVIDENCE === "1")
      console.info("TODO_BYTE_EVIDENCE", JSON.stringify({
        scenario: "invalid-board-in-place", beforeHex: bytes.toString("hex"),
        afterHex: after.toString("hex"), accepted: f.resumes().length,
      }));
  });
});

const BYTE_LIMIT = 1_048_576;
test("gate B8: byte writes reject above-limit data without replacing the prior file", async () => {
  await fixture(async (f) => {
    const payload = { value: "x".repeat(BYTE_LIMIT + 1 - Buffer.byteLength(JSON.stringify({ value: "" }))) };
    const bytes = Buffer.from(JSON.stringify(payload));
    expect(bytes.byteLength).toBe(BYTE_LIMIT + 1);
    expect(() => assertStatePayload(payload)).toThrow(new Error("state exceeds 1048576 bytes"));
    await f.store.workflowTransaction(ID, async (tx) => {
      const file = join(tx.paths.sessionDir, "state", "byte-write.bin");
      await tx.writeBytes(file, Buffer.from("keep"), { audit: false });
      await expect(tx.writeBytes(file, bytes, { audit: false })).rejects.toEqual(new Error("state exceeds 1048576 bytes"));
      expect(await readFile(file)).toEqual(Buffer.from("keep"));
    });
  });
});

test("gate B8: byte reads reject above-limit files with the payload-limit error", async () => {
  await fixture(async (f) => {
    const file = join(await f.store.resolveSessionDir(ID), "state", "byte-read.bin");
    const bytes = Buffer.alloc(BYTE_LIMIT + 1, 0x61);
    await writeFile(file, bytes);
    await f.store.workflowTransaction(ID, async (tx) => {
      await expect(tx.readBytes(file).then(() => undefined)).rejects.toEqual(new Error("state exceeds 1048576 bytes"));
    });
    expect(await readFile(file)).toEqual(bytes);
  });
});

test("gate B8: exact byte limit and existing unbounded text behavior remain intact", async () => {
  await fixture(async (f) => {
    await f.store.workflowTransaction(ID, async (tx) => {
      const file = join(tx.paths.sessionDir, "state", "byte-boundary.bin");
      const bytes = Buffer.alloc(BYTE_LIMIT, 0x61);
      await tx.writeBytes(file, bytes, { audit: false });
      expect(await tx.readBytes(file)).toEqual(bytes);
      const text = "x".repeat(BYTE_LIMIT + 1);
      await tx.writeText(file, text, { audit: false });
      expect(await tx.readText(file)).toBe(text);
    });
  });
});

test("gate B8: oversized damaged recovery archives without oversized byte I/O", async () => {
  await fixture(async (f) => {
    const stateDir = join(await f.store.resolveSessionDir(ID), "state");
    const file = join(stateDir, "todo-forms.json");
    const bytes = Buffer.alloc(BYTE_LIMIT + 1, 0xff);
    await writeFile(file, bytes);
    let oversizedReads = 0;
    let oversizedWrites = 0;
    const transaction = f.store.workflowTransaction.bind(f.store);
    const spy = spyOn(f.store, "workflowTransaction").mockImplementation(
      async function<T>(owner: string, operation: (tx: WorkflowTx) => Promise<T>): Promise<T> {
        return transaction(owner, async (tx) => {
          const read = tx.readBytes;
          const write = tx.writeBytes;
          tx.readBytes = async (path) => {
            const result = await read(path);
            if (result && result.byteLength > BYTE_LIMIT) oversizedReads++;
            return result;
          };
          tx.writeBytes = async (path, value, options) => {
            if (value.byteLength > BYTE_LIMIT) oversizedWrites++;
            return write(path, value, options);
          };
          return operation(tx);
        });
      },
    );
    f.hooks.configureTodo(settings, async () => {}, async () => []);
    try {
      await f.hooks.context({ sessionID: ID, agent: "open-gajae", messages: [] });
      expect((await f.snapshot()).controller.hold).toBeNull();
      const names = (await readdir(stateDir)).filter((name) => name.startsWith("todo-forms.invalid-"));
      expect(names).toHaveLength(1);
      const name = names[0];
      if (!name) throw new Error("oversized archive missing");
      expect(await readFile(join(stateDir, name))).toEqual(bytes);
      expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ pending: [], unknown: false });
      expect(oversizedReads).toBe(0);
      expect(oversizedWrites).toBe(0);
      await f.emit("session.execution.succeeded", 1);
      expect(f.resumes()).toHaveLength(1);
      if (process.env.TODO_CONTINUATION_EVIDENCE === "1")
        console.info("TODO_BOUNDARY_EVIDENCE", JSON.stringify({
          originalBytes: bytes.byteLength, archivedBytes: (await stat(join(stateDir, name))).size,
          oversizedReads, oversizedWrites, accepted: f.resumes().length,
        }));
    } finally { spy.mockRestore(); }
  });
});

test("gate B8: archival rejects escapes cross-directory moves and symlinks without overwriting evidence", async () => {
  await fixture(async (f) => {
    const outsideDir = join(f.store.worktree, "outside");
    await mkdir(outsideDir);
    const outside = join(outsideDir, "keep.bin");
    await writeFile(outside, "outside");
    await f.store.workflowTransaction(ID, async (tx) => {
      const dir = join(tx.paths.sessionDir, "state");
      const source = join(dir, "source.bin");
      const archive = join(dir, "archive.bin");
      await tx.writeBytes(source, Buffer.from("source"), { audit: false });
      await tx.archiveFile(source, archive, { audit: false });
      expect(await readFile(source)).toEqual(Buffer.from("source"));
      expect(await readFile(archive)).toEqual(Buffer.from("source"));
      await expect(tx.archiveFile(source, archive, { audit: false })).rejects.toThrow();
      const leaf = join(dir, "leaf-link");
      const parent = join(dir, "parent-link");
      await symlink(outside, leaf);
      await symlink(outsideDir, parent);
      const targets = [
        [outside, join(dir, "escaped.bin")],
        [leaf, join(dir, "linked.bin")],
        [join(parent, "keep.bin"), join(dir, "linked-parent.bin")],
        [source, outside],
        [source, leaf],
        [source, join(parent, "new.bin")],
        [source, join(tx.paths.sessionDir, "other", "cross.bin")],
        [dir, join(dir, "directory.bin")],
      ];
      for (const [from, to] of targets) {
        if (!from || !to) throw new Error("archive test pair missing");
        await expect((async () => tx.archiveFile(from, to, { audit: false }))()).rejects.toThrow();
      }
      expect(await readFile(archive)).toEqual(Buffer.from("source"));
    });
    expect(await readFile(outside, "utf8")).toBe("outside");
    expect(await readdir(outsideDir)).toEqual(["keep.bin"]);
  });
});
