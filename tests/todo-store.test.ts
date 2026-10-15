import { expect, test, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { StateStore } from "../src/state";
import { TodoStore } from "../src/todo/store";
import { todoSnapshotSchema } from "../src/todo/state";

const init = { op: "init", list: [{ phase: "Build", items: ["A", "B", "C"] }] };
async function fixture(run: (store: TodoStore, state: StateStore, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(join(import.meta.dir, ".todo-state-"));
  try {
    const state = new StateStore(root, async () => 0);
    await run(new TodoStore(state), state, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    expect(await fs.stat(root).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT")).toBe(true);
  }
}
async function snapshot(state: StateStore, sessionID = "s") {
  const file = join(await state.resolveSessionDir(sessionID), "state", "todo.json");
  return todoSnapshotSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
}

test("state-focus-and-isolation: restart retains terminals and distinguishes missing from empty", async () => {
  await fixture(async (store, state, root) => {
    expect(await store.read("missing")).toEqual({ status: "missing", sessionID: "missing" });
    await store.apply("s", init);
    await store.apply("s", { op: "start", task: "C" });
    await store.apply("s", { op: "done", task: "B" });
    expect(await store.read("s")).toMatchObject({ focus: { task: "C" }, revision: 3 });
    await store.apply("s", { op: "drop", task: "C" });
    await store.apply("child", { op: "rm" });
    const fresh = new TodoStore(new StateStore(root, async () => 0));
    expect(await fresh.read("s")).toMatchObject({
      status: "ready", focus: { task: "A" },
      counts: { completed: 1, abandoned: 1, open: 1 },
    });
    expect(await fresh.read("child")).toMatchObject({ status: "ready", phases: [], focus: null });
    expect(await fresh.read("missing")).toMatchObject({ status: "missing" });
    expect((await snapshot(state)).sessionID).toBe("s");
  });
});

test("read and semantic no-ops do not create writes or reset controller", async () => {
  await fixture(async (store, state) => {
    await store.apply("s", init);
    const before = await snapshot(state);
    expect((await store.apply("s", { op: "view" })).disposition).toBe("unchanged");
    expect((await store.apply("s", { op: "start", task: "A" })).disposition).toBe("unchanged");
    expect(await snapshot(state)).toEqual(before);
  });
});

test("controller key reordering is an unchanged no-op across repeated updates and restart", async () => {
  await fixture(async (store, state, root) => {
    await store.apply("s", init);
    const before = await snapshot(state);
    const directory = join(await state.resolveSessionDir("s"), "state");
    const bytes = await fs.readFile(join(directory, "todo.json"), "utf8");
    const audit = await fs.readFile(join(directory, "audit.jsonl"), "utf8");
    const fresh = new TodoStore(new StateStore(root, async () => 0));
    for (const adapter of [store, fresh]) {
      const result = await adapter.updateController("s", before, (controller) => {
        const { hold, ...rest } = controller;
        return { hold, ...rest };
      });
      expect(result.disposition).toBe("unchanged");
      expect(result.view).toMatchObject({ revision: 1 });
      expect(await snapshot(state)).toEqual(before);
      expect(await fs.readFile(join(directory, "todo.json"), "utf8")).toBe(bytes);
      expect(await fs.readFile(join(directory, "audit.jsonl"), "utf8")).toBe(audit);
    }
  });
});

test("controller nested key order and JSON-equivalent optional values do not cause writes", async () => {
  await fixture(async (store, state) => {
    await store.apply("s", init);
    const initial = await snapshot(state);
    await store.updateController("s", initial, (controller) => ({
      ...controller,
      hold: { reason: "user-stop", eventID: "event" },
      sourceWatermark: { eventID: "event", aggregateID: "s", seq: 0 },
      activationFence: { eventID: "event", aggregateID: "s", seq: 0 },
      consumedActivationFence: { eventID: "event", aggregateID: "s", seq: 0 },
      reservation: {
        source: { eventID: "event", aggregateID: "s", seq: 0 },
        generation: 1, workEpoch: 1, syntheticID: "synthetic",
        status: "reserved", attempts: 0, progress: 0,
      },
    }));
    const before = await snapshot(state);
    const result = await store.updateController("s", before, (controller) => ({
      ...controller,
      hold: { eventID: "event", noticeSent: undefined, reason: "user-stop" },
      sourceWatermark: { seq: -0, aggregateID: "s", eventID: "event" },
      activationFence: { seq: 0, aggregateID: "s", eventID: "event" },
      consumedActivationFence: { seq: 0, aggregateID: "s", eventID: "event" },
      reservation: {
        progress: 0, attempts: -0, status: "reserved", syntheticID: "synthetic",
        workEpoch: 1, generation: 1,
        source: { seq: 0, aggregateID: "s", eventID: "event" },
      },
    }));
    expect(result.disposition).toBe("unchanged");
    expect(result.view).toMatchObject({ revision: before.revision });
    expect(await snapshot(state)).toEqual(before);
  });
});

test("concurrent stores serialize read/reduce/write inside the existing session queue", async () => {
  await fixture(async (store, state, root) => {
    await store.apply("s", init);
    const second = new TodoStore(new StateStore(root, async () => 0));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = state.workflowTransaction("s", async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const firstWrite = store.apply("s", { op: "append", phase: "Build", items: ["D"] });
    const secondWrite = second.apply("s", { op: "append", phase: "Build", items: ["E"] });
    try {
      expect((await second.apply("other", init)).disposition).toBe("applied");
      release.resolve();
      await held;
      const [firstResult, secondResult] = await Promise.all([firstWrite, secondWrite]);
      expect(firstResult.view).toMatchObject({ revision: 2 });
      expect(secondResult.view).toMatchObject({ revision: 3 });
      expect((await snapshot(state)).phases[0]?.items.map((item) => item.task)).toEqual(["A", "B", "C", "D", "E"]);
    } finally {
      release.resolve();
      await Promise.allSettled([held, firstWrite, secondWrite]);
    }
  });
});

test("invalid input and oversize payload leave exact persisted bytes unchanged", async () => {
  await fixture(async (store, state) => {
    await store.apply("s", init);
    const file = join(await state.resolveSessionDir("s"), "state", "todo.json");
    const before = await fs.readFile(file, "utf8");
    for (const input of [
      { op: "append", phase: "Build", items: ["D", " A "] },
      { op: "append", phase: "Build", items: ["D", ""] },
      { op: "append", phase: "Build", items: ["x".repeat(1_048_576)] },
      { op: "done", task: "A", phase: "Build" },
    ]) {
      expect((await store.apply("s", input)).disposition).toBe("rejected");
      expect(await fs.readFile(file, "utf8")).toBe(before);
    }
  });
});

test("corrupt, foreign, future and oversized storage are preserved across restart and mutations", async () => {
  await fixture(async (store, state, root) => {
    await store.apply("s", init);
    const valid = await snapshot(state);
    const file = join(await state.resolveSessionDir("s"), "state", "todo.json");
    for (const bytes of [
      "{broken", JSON.stringify({ ...valid, sessionID: "other" }),
      JSON.stringify({ ...valid, schemaVersion: 2 }), " ".repeat(1_048_577),
      JSON.stringify({ ...valid, controller: null }),
    ]) {
      await fs.writeFile(file, bytes);
      const fresh = new TodoStore(new StateStore(root, async () => 0));
      expect(await fresh.read("s")).toMatchObject({ status: "invalid", sessionID: "s" });
      expect((await fresh.apply("s", init)).disposition).toBe("rejected");
      expect((await fresh.apply("s", { op: "rm" })).disposition).toBe("rejected");
      expect(await fs.readFile(file, "utf8")).toBe(bytes);
    }
  });
});

test("failure before replacement is rejected and removes atomic temp files", async () => {
  await fixture(async (store, state) => {
    await store.apply("s", init);
    const before = await snapshot(state);
    const rename = spyOn(fs, "rename").mockRejectedValueOnce(new Error("before replacement"));
    try {
      expect((await store.apply("s", { op: "done", task: "A" })).disposition).toBe("rejected");
    } finally {
      rename.mockRestore();
    }
    expect(await snapshot(state)).toEqual(before);
    expect((await fs.readdir(join(await state.resolveSessionDir("s"), "state"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

test("audit failure after replacement is committed-with-warning and restart sees committed bytes", async () => {
  await fixture(async (store, state, root) => {
    await store.apply("s", init);
    const audit = join(await state.resolveSessionDir("s"), "state", "audit.jsonl");
    await fs.rm(audit);
    await fs.mkdir(audit);
    const result = await store.apply("s", { op: "append", phase: "Build", items: ["D"] });
    expect(result.disposition).toBe("committed-with-warning");
    expect(result.view).toMatchObject({ revision: 2, counts: { total: 4 } });
    const fresh = new TodoStore(new StateStore(root, async () => 0));
    expect(await fresh.read("s")).toEqual(result.view);
    expect((await fresh.apply("s", { op: "append", phase: "Build", items: ["D"] })).disposition).toBe("rejected");
    expect((await snapshot(state)).revision).toBe(2);
  });
});

test("lost replacement response reconciles bytes without repeating the mutation", async () => {
  await fixture(async (store, state) => {
    await store.apply("s", init);
    const renamed = Promise.withResolvers<void>();
    const response = Promise.withResolvers<void>();
    const original = fs.rename.bind(fs);
    const rename = spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      await original(from, to);
      renamed.resolve();
      await response.promise;
      throw new Error("lost write response");
    });
    const pending = store.apply("s", { op: "append", phase: "Build", items: ["D"] });
    try {
      await renamed.promise;
      expect((await snapshot(state)).revision).toBe(2);
    } finally {
      response.resolve();
    }
    try {
      expect((await pending).disposition).toBe("committed-with-warning");
    } finally {
      rename.mockRestore();
    }
    expect((await store.apply("s", { op: "append", phase: "Build", items: ["D"] })).disposition).toBe("rejected");
  });
});

test("unreadable post-write outcome fences mutation until authoritative view reconciles", async () => {
  await fixture(async (store, state, root) => {
    await store.apply("s", init);
    const file = join(await state.resolveSessionDir("s"), "state", "todo.json");
    const original = fs.rename.bind(fs);
    const rename = spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      await original(from, to);
      await fs.rename(file, file + ".saved");
      await fs.mkdir(file);
      throw new Error("cannot observe outcome");
    });
    try {
      expect((await store.apply("s", { op: "done", task: "A" })).disposition).toBe("uncertain");
    } finally {
      rename.mockRestore();
    }
    await fs.rm(file, { recursive: true });
    await fs.rename(file + ".saved", file);
    const second = new TodoStore(new StateStore(root, async () => 0));
    const loaded = await second.readSnapshot("s");
    expect(loaded.status).toBe("ready");
    const retry = await second.apply("s", { op: "done", task: "B" });
    expect(retry.disposition).toBe("uncertain");
    expect(retry.view).toMatchObject({ hold: { reason: "uncertain_storage" } });
    expect(await second.read("s")).toMatchObject({ revision: 2, hold: { reason: "uncertain_storage" } });
    if (loaded.status !== "ready") throw new Error("restored snapshot missing");
    expect((await second.updateController("s", loaded.snapshot, (controller) => ({
      ...controller, failures: 1,
    }))).disposition).toBe("applied");
    expect(await second.read("s")).toMatchObject({ hold: { reason: "uncertain_storage" } });
    expect((await second.apply("s", { op: "start", task: "B" })).disposition).toBe("unchanged");
    expect(await second.read("s")).toMatchObject({ hold: { reason: "uncertain_storage" } });
    expect((await second.apply("s", { op: "done", task: "B" })).disposition).toBe("applied");
    expect(await second.read("s")).toMatchObject({ hold: null });
  });
});

test("controller compare-and-set rejects stale generation/revision and retains restart fences", async () => {
  await fixture(async (store, state, root) => {
    await store.apply("s", init);
    const before = await snapshot(state);
    const controller = {
      ...before.controller,
      hold: { reason: "user-stop" },
      sourceWatermark: { eventID: "stop-1", aggregateID: "s", seq: 10 },
      activationFence: { eventID: "user-1", aggregateID: "s", seq: 9 },
      consumedActivationFence: { eventID: "user-1", aggregateID: "s", seq: 9 },
    };
    expect((await store.updateController("s", before, () => controller)).disposition).toBe("applied");
    expect((await store.updateController("s", before, () => before.controller)).disposition).toBe("rejected");
    const fresh = new TodoStore(new StateStore(root, async () => 0));
    expect(await fresh.read("s")).toMatchObject({ hold: { reason: "user-stop" }, revision: 2 });
    await fresh.apply("s", { op: "start", task: "A" });
    expect((await snapshot(state)).controller).toEqual(controller);
    const current = await snapshot(state);
    expect((await store.updateController("s", current, (value) => ({
      ...value, sourceWatermark: { eventID: "older", aggregateID: "s", seq: 8 },
    }))).disposition).toBe("rejected");
    await store.apply("s", init);
    expect((await store.updateController("s", { revision: 3, generation: 1 }, () => controller)).disposition).toBe("rejected");
  });
});
