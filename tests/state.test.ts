import { test, expect, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertStatePayload,
  epochMillis,
  safeComponent,
  sessionDirName,
  StateStore,
} from "../src/state";

// A fixed instant; the expected label is derived with the same local getters the
// implementation uses, so these tests do not depend on the machine's timezone.
const CREATED = Date.parse("2026-09-18T03:09:58+09:00");

function label(createdMs: number) {
  const at = new Date(createdMs);
  const pad = (value: number, width: number) =>
    String(value).padStart(width, "0");
  return (
    `${pad(at.getFullYear(), 4)}${pad(at.getMonth() + 1, 2)}${pad(at.getDate(), 2)}` +
    `-${pad(at.getHours(), 2)}${pad(at.getMinutes(), 2)}${pad(at.getSeconds(), 2)}`
  );
}

/** Every store gets a stub resolver; `calls` records each host lookup. */
function storeAt(root: string, calls: string[] = []) {
  return new StateStore(root, async (sessionID) => {
    calls.push(sessionID);
    return CREATED;
  });
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "open-gajae-state-"));
  try {
    await run(await fs.realpath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("session folders carry the creation time and a read does not create directories", async () => {
  await fixture(async (root) => {
    const calls: string[] = [];
    const store = storeAt(root, calls);
    const expectedName = `_session-${label(CREATED)}-ses_abc`;
    expect(sessionDirName(CREATED, "ses_abc")).toBe(expectedName);
    expect(expectedName).toMatch(/^_session-\d{8}-\d{6}-ses_abc$/);
    for (const invalid of ["", "a/b", ".", "..", "가", "x".repeat(300)])
      expect(() => sessionDirName(CREATED, invalid)).toThrow();
    expect(() => sessionDirName(Number.NaN, "ses_abc")).toThrow("finite");
    await expect(store.resolveSessionDir("")).rejects.toThrow("session ID");
    await expect(store.resolveSessionDir("a/b")).rejects.toThrow("safe path component");
    await expect(store.resolveSessionDir("x".repeat(300))).rejects.toThrow(
      "component limit",
    );

    const sessionDir = await store.resolveSessionDir("ses_abc");
    expect(calls).toEqual(["ses_abc"]);
    expect(sessionDir).toBe(join(root, ".open-gajae", expectedName));
    const statePath = join(sessionDir, "state", "deep-interview-state.json");
    expect(
      await store.workflowTransaction("ses_abc", (tx) => tx.readModeState("deep-interview")),
    ).toBeUndefined();
    await expect(fs.lstat(sessionDir)).rejects.toMatchObject({ code: "ENOENT" });
    // The cache answers every later resolution, so no second host lookup.
    expect(calls).toEqual(["ses_abc"]);

    await store.workflowTransaction("ses_abc", (tx) =>
      tx.writeModeState("deep-interview", { created: true }, "deep_interview_tool"),
    );
    expect((await fs.stat(statePath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dirname(statePath))).mode & 0o777).toBe(0o700);
    expect(calls).toEqual(["ses_abc"]);

    // A fresh instance finds the same folder by its ID suffix, with no lookup.
    const scanCalls: string[] = [];
    const scanned = storeAt(root, scanCalls);
    expect(await scanned.resolveSessionDir("ses_abc")).toBe(sessionDir);
    expect(
      (await scanned.workflowTransaction("ses_abc", (tx) => tx.readModeState("deep-interview")))?.created,
    ).toBe(true);
    expect(scanCalls).toEqual([]);
  });
});

test("two folders for one session fail closed and an old hex folder is ignored", async () => {
  await fixture(async (root) => {
    const base = join(root, ".open-gajae");
    const calls: string[] = [];
    const store = storeAt(root, calls);
    const first = "_session-20260101-000000-ses_dup";
    const second = "_session-20260202-111111-ses_dup";
    await mkdir(join(base, first), { recursive: true });
    await mkdir(join(base, second), { recursive: true });
    const ambiguous = `ambiguous session directories for ses_dup: ${first}, ${second}`;
    for (const operation of [
      () => store.resolveSessionDir("ses_dup"),
      () => store.workflowTransaction("ses_dup", (tx) => tx.readModeState("deep-interview")),
      () =>
        store.workflowTransaction("ses_dup", (tx) =>
          tx.writeModeState("deep-interview", { value: 1 }, "deep_interview_tool"),
        ),
    ])
      await expect(operation()).rejects.toThrow(ambiguous);
    expect(await readdir(join(base, first))).toEqual([]);
    expect(await readdir(join(base, second))).toEqual([]);
    expect(calls).toEqual([]);

    // D3c: the pre-rename hex folder is not a candidate; a new folder is made.
    const hex = `_session-${Buffer.from("ses_old", "utf8").toString("hex")}`;
    await mkdir(join(base, hex), { recursive: true });
    await store.workflowTransaction("ses_old", (tx) =>
      tx.writeModeState("deep-interview", { value: "new" }, "deep_interview_tool"),
    );
    const renamed = join(base, `_session-${label(CREATED)}-ses_old`);
    expect(
      await readFile(join(renamed, "state", "deep-interview-state.json"), "utf8"),
    ).toContain("new");
    expect(await readdir(join(base, hex))).toEqual([]);
    expect(calls).toEqual(["ses_old"]);
  });
});

test("a write replaces the state and regenerates _meta", async () => {
  await fixture(async (root) => {
    const store = storeAt(root);
    const statePath = join(await store.resolveSessionDir("s"), "state", "ralplan-state.json");
    await store.workflowTransaction("s", (tx) =>
      tx.writeModeState("ralplan", { retained: false, _meta: { sessionId: "other" } }, "ralplan_tool"),
    );
    const written = await store.workflowTransaction("s", (tx) =>
      tx.writeModeState("ralplan", { goal: "model", _runtime: { value: 2 } }, "ralplan_hook"),
    );
    expect(written).toMatchObject({
      goal: "model",
      _runtime: { value: 2 },
      _meta: { mode: "ralplan", sessionId: "s", updatedBy: "ralplan_hook" },
    });
    const stored = JSON.parse(await readFile(statePath, "utf8"));
    expect(stored.retained).toBeUndefined();
    const { _meta, ...model } = stored;
    expect(model).toEqual({ goal: "model", _runtime: { value: 2 } });
  });
});

test("payload limits preserve the last valid state", async () => {
  await fixture(async (root) => {
    const store = storeAt(root);
    const write = (state: Record<string, unknown>) =>
      store.workflowTransaction("s", (tx) => tx.writeModeState("deep-interview", state, "deep_interview_tool"));
    const valid = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`k${index}`, index]),
    );
    await write(valid);
    await expect(
      write(
        Object.fromEntries(
          Array.from({ length: 101 }, (_, index) => [`k${index}`, index]),
        ),
      ),
    ).rejects.toThrow("100");
    let nested: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 9; index++) nested = { nested };
    await write(nested);
    await expect(write({ nested })).rejects.toThrow("depth");
    await expect(write({ bigint: 1n })).rejects.toThrow("serializ");
    const statePath = join(await store.resolveSessionDir("s"), "state", "deep-interview-state.json");
    const { _meta, ...model } = JSON.parse(await readFile(statePath, "utf8"));
    expect(model).toEqual(nested);
  });
});

test("UTF-8 payload byte boundaries accept 1 MiB and reject the next byte without replacing state", async () => {
  await fixture(async (root) => {
    const store = storeAt(root);
    const write = (state: Record<string, unknown>) =>
      store.workflowTransaction("bytes", (tx) => tx.writeModeState("deep-interview", state, "deep_interview_tool"));
    const statePath = join(await store.resolveSessionDir("bytes"), "state", "deep-interview-state.json");
    const limit = 1_048_576;
    const overhead = Buffer.byteLength(JSON.stringify({ text: "" }), "utf8");
    for (const size of [limit - 1, limit]) {
      const available = size - overhead;
      const text =
        "가".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
      const payload = { text };
      expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBe(size);
      await write(payload);
      expect(JSON.parse(await readFile(statePath, "utf8")).text).toBe(text);
    }
    const before = await fs.readFile(statePath, "utf8");
    const previous = JSON.parse(before).text as string;
    const tooLarge = { text: previous + "x" };
    expect(Buffer.byteLength(JSON.stringify(tooLarge), "utf8")).toBe(limit + 1);
    await expect(write(tooLarge)).rejects.toThrow("1048576 bytes");
    expect(await fs.readFile(statePath, "utf8")).toBe(before);
    // Character count alone must not authorize a multi-byte payload.
    const multibyte = { text: "가".repeat(Math.floor(limit / 3) + 1) };
    expect(multibyte.text.length).toBeLessThan(limit);
    await expect(write(multibyte)).rejects.toThrow("1048576 bytes");
    expect(await fs.readFile(statePath, "utf8")).toBe(before);
  });
});

test("multiple StateStore instances share a session queue, in call order", async () => {
  await fixture(async (root) => {
    const first = storeAt(root);
    const second = storeAt(root);
    // Two instances opening the same new session compute the same folder name.
    expect(await first.resolveSessionDir("same")).toBe(
      await second.resolveSessionDir("same"),
    );
    const write = (store: StateStore, session: string, state: Record<string, unknown>) =>
      store.workflowTransaction(session, (tx) => tx.writeModeState("deep-interview", state, "deep_interview_tool"));
    const read = (store: StateStore, session: string) =>
      store.workflowTransaction(session, (tx) => tx.readModeState("deep-interview"));
    await Promise.all([
      write(first, "same", { sequence: "one", obsolete: true }),
      write(second, "same", { sequence: "two" }),
    ]);
    expect(await read(first, "same")).toMatchObject({ sequence: "two" });
    expect((await read(first, "same"))?.obsolete).toBeUndefined();

    const queuedWrite = write(first, "ordered", { sequence: "write" });
    const queuedRemove = second.workflowTransaction("ordered", (tx) =>
      tx.remove(tx.paths.modeState("deep-interview")),
    );
    const queuedRead = read(first, "ordered");
    await expect(queuedWrite).resolves.toMatchObject({ sequence: "write" });
    await expect(queuedRemove).resolves.toBe("deleted");
    await expect(queuedRead).resolves.toBeUndefined();

    await Promise.all([
      write(first, "left", { value: "left" }),
      write(second, "right", { value: "right" }),
    ]);
    expect((await read(first, "left"))?.value).toBe("left");
    expect((await read(first, "right"))?.value).toBe("right");
  });
});

test("a failed atomic publish rejects only its call, cleans its temp, and does not poison later work", async () => {
  await fixture(async (root) => {
    const first = storeAt(root);
    const second = storeAt(root);
    const write = (store: StateStore, value: string) =>
      store.workflowTransaction("s", (tx) => tx.writeModeState("deep-interview", { value }, "deep_interview_tool"));
    const rename = spyOn(fs, "rename").mockRejectedValueOnce(
      new Error("rename failed"),
    );
    try {
      const failed = write(first, "failed");
      const recovered = write(second, "recovered");
      await expect(failed).rejects.toThrow("rename failed");
      await expect(recovered).resolves.toMatchObject({ value: "recovered" });
    } finally {
      rename.mockRestore();
    }
    const statePath = join(await first.resolveSessionDir("s"), "state", "deep-interview-state.json");
    expect(await readFile(statePath, "utf8")).toContain("recovered");
    const entries = await readdir(dirname(statePath));
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});

test("corrupt and mismatched owner state stays visible; symlinked folders are refused", async () => {
  await fixture(async (root) => {
    const store = storeAt(root);
    const read = (session: string) =>
      store.workflowTransaction(session, (tx) => tx.readModeState("deep-interview"));
    const corrupt = join(await store.resolveSessionDir("corrupt"), "state", "deep-interview-state.json");
    await mkdir(dirname(corrupt), { recursive: true });
    await writeFile(corrupt, "{broken");
    await expect(read("corrupt")).rejects.toThrow("corrupted");
    expect(await readFile(corrupt, "utf8")).toBe("{broken");

    const mismatched = join(await store.resolveSessionDir("A"), "state", "deep-interview-state.json");
    await mkdir(dirname(mismatched), { recursive: true });
    const foreign = JSON.stringify({ _meta: { sessionId: "B" }, value: "keep" });
    await writeFile(mismatched, foreign);
    await expect(read("A")).rejects.toThrow("scope");
    expect(await readFile(mismatched, "utf8")).toBe(foreign);

    const unowned = join(await store.resolveSessionDir("unowned"), "state", "deep-interview-state.json");
    await mkdir(dirname(unowned), { recursive: true });
    await writeFile(unowned, JSON.stringify({ _runtime: { data: true } }));
    expect((await read("unowned"))?._runtime).toEqual({ data: true });
    const replaced = await store.workflowTransaction("unowned", (tx) =>
      tx.writeModeState("deep-interview", { value: "new" }, "deep_interview_tool"),
    );
    expect(replaced._meta?.sessionId).toBe("unowned");

    const outside = await mkdtemp(join(tmpdir(), "open-gajae-outside-"));
    try {
      await mkdir(join(root, ".open-gajae"), { recursive: true });
      await symlink(outside, join(root, ".open-gajae", sessionDirName(CREATED, "link")));
      await expect(
        store.workflowTransaction("link", (tx) =>
          tx.writeModeState("deep-interview", { escaped: true }, "deep_interview_tool"),
        ),
      ).rejects.toThrow("symlink");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("each mode writes its own state file in the session folder", async () => {
  await fixture(async (root) => {
    const store = storeAt(root);
    const sessionDir = await store.resolveSessionDir("s");
    const deepPath = join(sessionDir, "state", "deep-interview-state.json");
    const ralplanPath = join(sessionDir, "state", "ralplan-state.json");
    await store.workflowTransaction("s", async (tx) => {
      expect(tx.paths.modeState("ralplan")).toBe(ralplanPath);
      expect(tx.paths.statePath).toBe(ralplanPath);
      await tx.writeModeState("deep-interview", { owner: "deep-interview" }, "deep_interview_tool");
    });
    const untouched = await readFile(deepPath, "utf8");
    const written = await store.workflowTransaction("s", (tx) =>
      tx.writeState({ owner: "ralplan", active: true }, "ralplan_tool"),
    );
    expect(written._meta).toMatchObject({ mode: "ralplan", sessionId: "s", updatedBy: "ralplan_tool" });
    expect(await readFile(deepPath, "utf8")).toBe(untouched);
    expect(JSON.parse(await readFile(ralplanPath, "utf8")).owner).toBe("ralplan");
  });
});

test("a v2 session creation time is read as a number or a DateTime", () => {
  const ms = Date.parse("2026-09-18T03:09:58+09:00");
  expect(epochMillis(ms)).toBe(ms);
  expect(epochMillis({ epochMillis: ms })).toBe(ms);
  expect(epochMillis(new Date(ms))).toBe(ms);
  expect(epochMillis("2026-09-18")).toBeNaN();
});

test("C-1: one workflow queue per session serializes every mode and transaction", async () => {
  await fixture(async (root) => {
    const store = storeAt(root);
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const tx = store.workflowTransaction("ses_u", async (t) => {
      order.push("workflow tx start");
      await t.writeModeState("ultragoal", { active: true, iteration: 1 }, "ultragoal_tool");
      await held;
      order.push("workflow tx end");
    });
    // Queued behind the transaction, whatever the mode or transaction kind.
    const queued = [
      store
        .workflowTransaction("ses_u", (t) => t.writeText(t.paths.ultragoal.goals, '{"version":1}\n'))
        .then(() => order.push("ultragoal tx")),
      store
        .ralplanTransaction("ses_u", (t) => t.writeState({ active: true }, "ralplan_tool"))
        .then(() => order.push("ralplan tx")),
      store
        .workflowTransaction("ses_u", (t) =>
          t.writeModeState("ultragoal", { active: true, iteration: 2 }, "ultragoal_hook"),
        )
        .then(() => order.push("ultragoal write")),
      store
        .workflowTransaction("ses_u", (t) => t.writeModeState("deep-interview", { note: "n" }, "deep_interview_tool"))
        .then(() => order.push("deep-interview write")),
    ];
    // Another session has its own queue.
    await store.workflowTransaction("ses_other", (t) =>
      t.writeModeState("deep-interview", { note: "free" }, "deep_interview_tool"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["workflow tx start"]);
    release();
    await Promise.all([tx, ...queued]);
    expect(order).toEqual([
      "workflow tx start",
      "workflow tx end",
      "ultragoal tx",
      "ralplan tx",
      "ultragoal write",
      "deep-interview write",
    ]);
    const sessionDir = await store.resolveSessionDir("ses_u");
    const state = JSON.parse(await readFile(join(sessionDir, "state", "ultragoal-state.json"), "utf8"));
    expect(state).toMatchObject({ active: true, iteration: 2 });
    expect(state._meta).toMatchObject({ mode: "ultragoal", updatedBy: "ultragoal_hook" });
    expect(await readFile(join(sessionDir, "ultragoal/goals.json"), "utf8")).toBe('{"version":1}\n');
    await store.workflowTransaction("ses_u", async (t) => {
      expect(t.paths.modeState("deep-interview")).toBe(join(sessionDir, "state/deep-interview-state.json"));
      expect(t.paths.activeRow("ultragoal")).toBe(join(sessionDir, "state/active/ultragoal.json"));
      expect(t.paths.ultragoal.ledger).toBe(join(sessionDir, "ultragoal/ledger.jsonl"));
      expect(() => t.paths.activeRow("../x")).toThrow("invalid path component for skill");
      expect(await t.readModeState("ralplan")).toMatchObject({ active: true });
    });
  });
});

test("DR-31, DR-32: assertStatePayload checks the write limits up front; safeComponent is exported", () => {
  const limit = 1_048_576;
  const overhead = Buffer.byteLength(JSON.stringify({ text: "" }), "utf8");
  const text = "x".repeat(limit - overhead);
  expect(() => assertStatePayload({ text })).not.toThrow();
  expect(() => assertStatePayload({ text: `${text}x` })).toThrow("1048576 bytes");
  // `_meta` is regenerated on write, so it does not count.
  expect(() => assertStatePayload({ text, _meta: { big: "y".repeat(1000) } })).not.toThrow();
  let nested: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < 9; index++) nested = { nested };
  expect(() => assertStatePayload(nested)).not.toThrow();
  expect(() => assertStatePayload({ nested })).toThrow("depth 10");
  const keys = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, index]));
  expect(() => assertStatePayload(keys(100))).not.toThrow();
  expect(() => assertStatePayload(keys(101))).toThrow("100 top-level keys");
  expect(safeComponent("2026-10-02-0101-abcd", "slug")).toBe("2026-10-02-0101-abcd");
  expect(() => safeComponent("../x", "slug")).toThrow("invalid path component for slug");
});
