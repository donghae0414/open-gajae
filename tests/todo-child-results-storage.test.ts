import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state";
import { createChildResults } from "../src/todo/child-results";

test("terminal child ledger is forgotten from disk", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "gajae-child-forget-")));
  const store = new StateStore(dir, async () => 1_800_000_000_000);
  const child = createChildResults(store, {
    async get() { return { parentID: "parent", location: { directory: dir } }; },
    async context() { return []; },
    async synthetic() { return {}; },
  }, dir, async () => {});
  try {
    let seq = 0;
    const event = async (sessionID: string, type: string, extra: Record<string, unknown> = {}) => {
      child.observe(type, { sessionID, ...extra }, { aggregateID: sessionID, seq: ++seq, eventID: `evt_${seq}` });
      await child.flush();
    };
    await event("child", "session.created", { parentID: "parent" });
    await event("child", "session.execution.started");
    await event("child", "session.execution.succeeded");
    await event("parent", "session.inbox.enqueued", { inboxID: "result", item: { payload: {
      metadata: { source: "subagent", childID: "child", state: "completed" },
    } } });
    await event("parent", "session.inbox.delivered", { inboxID: "result" });
    expect(child.blocked("parent")).toBe(false);
    await expect(stat(join(await store.resolveSessionDir("child"), "state/todo-child-results.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await child.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const board of [false, true]) {
test(`terminal nested child cleanup preserves other files, board=${board}`, async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "gajae-child-nested-")));
  const store = new StateStore(dir, async (id) => ({
    created: 1_800_000_000_000, parentID: id === "child" ? "parent" : undefined,
  }));
  const host = {
    async get() { return { parentID: "parent", location: { directory: dir } }; },
    async context() { return []; },
    async synthetic() { return {}; },
  };
  let child = createChildResults(store, host, dir, async () => {});
  const events: Array<{ type: string; data: Record<string, unknown>; source: { aggregateID: string; seq: number; eventID: string } }> = [];
  const emit = async (sessionID: string, type: string, extra: Record<string, unknown> = {}) => {
    const seq = events.length + 1;
    const event = { type, data: { sessionID, ...extra }, source: { aggregateID: sessionID, seq, eventID: `event_${seq}` } };
    events.push(event);
    child.observe(event.type, event.data, event.source);
    await child.flush();
  };
  try {
    if (board) await store.workflowTransaction("child", (tx) =>
      tx.writeText(join(tx.paths.sessionDir, "state/todo.json"), "executor board", { audit: false }));
    await emit("child", "session.created", { parentID: "parent" });
    await emit("child", "session.execution.started");
    await emit("child", "session.execution.succeeded");
    await emit("parent", "session.inbox.enqueued", { inboxID: "result", item: { payload: {
      metadata: { source: "subagent", childID: "child", state: "completed" },
    } } });
    await emit("parent", "session.inbox.delivered", { inboxID: "result" });
    const childDir = await store.resolveSessionDir("child");
    if (board) expect(await readdir(join(childDir, "state"))).toEqual(["todo.json"]);
    else await expect(stat(childDir)).rejects.toMatchObject({ code: "ENOENT" });
    await child.dispose();
    child = createChildResults(new StateStore(dir, async (id) => ({
      created: 1_800_000_000_000, parentID: id === "child" ? "parent" : undefined,
    })), host, dir, async () => {});
    for (const event of events) {
      child.observe(event.type, event.data, event.source);
      await child.flush();
      expect(child.blocked("parent")).toBe(false);
    }
    await emit("child", "session.execution.started");
    expect(child.blocked("parent")).toBe(true);
    // An old result cannot settle this newly observed obligation.
    for (const event of events.slice(0, 5)) child.observe(event.type, event.data, event.source);
    await child.flush();
    expect(child.blocked("parent")).toBe(true);
  } finally {
    await child.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
}
