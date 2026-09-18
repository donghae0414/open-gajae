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
import { sessionDirName, StateStore } from "../src/state";

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

test("session folders carry the creation time and read does not create directories", async () => {
  await fixture(async (root) => {
    const calls: string[] = [];
    const store = storeAt(root, calls);
    const expectedName = `_session-${label(CREATED)}-ses_abc`;
    expect(sessionDirName(CREATED, "ses_abc")).toBe(expectedName);
    expect(expectedName).toMatch(/^_session-\d{8}-\d{6}-ses_abc$/);
    for (const invalid of ["", "a/b", ".", "..", "가", "x".repeat(300)])
      expect(() => sessionDirName(CREATED, invalid)).toThrow();
    expect(() => sessionDirName(Number.NaN, "ses_abc")).toThrow("finite");
    await expect(store.statePath("")).rejects.toThrow("session ID");
    await expect(store.statePath("a/b")).rejects.toThrow("safe path component");
    await expect(store.statePath("x".repeat(300))).rejects.toThrow(
      "component limit",
    );

    const paths = await store.resolveSessionPaths("ses_abc");
    expect(calls).toEqual(["ses_abc"]);
    expect(paths.sessionDir).toBe(join(root, ".open-gajae", expectedName));
    expect(paths.statePath).toBe(
      join(paths.sessionDir, "state", "deep-interview-state.json"),
    );
    expect(paths.specsDir).toBe(join(paths.sessionDir, "specs"));
    expect(paths.plansDir).toBe(join(paths.sessionDir, "plans"));
    expect(paths.draftsDir).toBe(join(paths.sessionDir, "drafts"));
    expect(await store.read("ses_abc")).toBeUndefined();
    await expect(fs.lstat(paths.sessionDir)).rejects.toMatchObject({
      code: "ENOENT",
    });
    // The cache answers every later resolution, so no second host lookup.
    expect(calls).toEqual(["ses_abc"]);

    await store.write("ses_abc", { created: true });
    expect((await fs.stat(paths.statePath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dirname(paths.statePath))).mode & 0o777).toBe(0o700);
    expect(calls).toEqual(["ses_abc"]);

    // A fresh instance finds the same folder by its ID suffix, with no lookup.
    const scanCalls: string[] = [];
    const scanned = storeAt(root, scanCalls);
    expect((await scanned.resolveSessionPaths("ses_abc")).sessionDir).toBe(
      paths.sessionDir,
    );
    expect((await scanned.read("ses_abc"))?.created).toBe(true);
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
      () => store.resolveSessionPaths("ses_dup"),
      () => store.read("ses_dup"),
      () => store.write("ses_dup", { value: 1 }),
      () => store.patch("ses_dup", { active: true }),
      () => store.clear("ses_dup"),
    ])
      await expect(operation()).rejects.toThrow(ambiguous);
    expect(await readdir(join(base, first))).toEqual([]);
    expect(await readdir(join(base, second))).toEqual([]);
    expect(calls).toEqual([]);

    // D3c: the pre-rename hex folder is not a candidate; a new folder is made.
    const hex = `_session-${Buffer.from("ses_old", "utf8").toString("hex")}`;
    await mkdir(join(base, hex), { recursive: true });
    await store.write("ses_old", { value: "new" });
    const renamed = join(base, `_session-${label(CREATED)}-ses_old`);
    expect(
      await readFile(
        join(renamed, "state", "deep-interview-state.json"),
        "utf8",
      ),
    ).toContain("new");
    expect(await readdir(join(base, hex))).toEqual([]);
    expect(calls).toEqual(["ses_old"]);
  });
});

test("writes always replace the snapshot, prioritize explicit fields, and regenerate metadata", async () => {
  await fixture(async (root) => {
    const store = storeAt(root);
    const modeOnly = await store.write("mode-only");
    expect(modeOnly).toEqual({
      _meta: expect.objectContaining({
        mode: "deep-interview",
        sessionId: "mode-only",
        updatedBy: "state_write_tool",
      }),
    });
    const first = await store.write("s", {
      retained: false,
      _meta: { sessionId: "other" },
      _runtime: { opaque: true },
      session_id: "other",
    });
    const second = await store.write(
      "s",
      { goal: "model", current_phase: "model", _runtime: { value: 2 } },
      { current_phase: "explicit", iteration: 1.5 },
    );
    expect(first._meta).toMatchObject({
      mode: "deep-interview",
      sessionId: "s",
      updatedBy: "state_write_tool",
    });
    expect(second).toMatchObject({
      goal: "model",
      current_phase: "explicit",
      iteration: 1.5,
      _runtime: { value: 2 },
      _meta: { sessionId: "s" },
    });
    expect(second.retained).toBeUndefined();
    expect(second.session_id).toBeUndefined();
    expect((await store.read("s"))?.goal).toBe("model");
  });
});

test("payload limits preserve the last valid state", async () => {
  await fixture(async (root) => {
    const store = storeAt(root);
    const valid = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`k${index}`, index]),
    );
    await store.write("s", valid);
    await expect(
      store.write(
        "s",
        Object.fromEntries(
          Array.from({ length: 101 }, (_, index) => [`k${index}`, index]),
        ),
      ),
    ).rejects.toThrow("100");
    let nested: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 9; index++) nested = { nested };
    await store.write("s", nested);
    await expect(store.write("s", { nested })).rejects.toThrow("depth");
    await expect(store.write("s", { bigint: 1n })).rejects.toThrow("serializ");
    const persisted = await store.read("s");
    const { _meta: _meta, ...model } = persisted ?? {};
    expect(model).toEqual(nested);
  });
});

test("UTF-8 payload byte boundaries accept 1 MiB and reject the next byte without replacing state", async () => {
  await fixture(async (root) => {
    const store = storeAt(root);
    const limit = 1_048_576;
    const overhead = Buffer.byteLength(JSON.stringify({ text: "" }), "utf8");
    for (const size of [limit - 1, limit]) {
      const available = size - overhead;
      const text =
        "가".repeat(Math.floor(available / 3)) + "x".repeat(available % 3);
      const payload = { text };
      expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBe(size);
      await store.write("bytes", payload);
      expect((await store.read("bytes"))?.text).toBe(text);
    }
    const statePath = await store.statePath("bytes");
    const before = await fs.readFile(statePath, "utf8");
    const previous = (await store.read("bytes"))?.text as string;
    const tooLarge = { text: previous + "x" };
    expect(Buffer.byteLength(JSON.stringify(tooLarge), "utf8")).toBe(limit + 1);
    await expect(store.write("bytes", tooLarge)).rejects.toThrow(
      "1048576 bytes",
    );
    expect(await fs.readFile(statePath, "utf8")).toBe(before);
    // Character count alone must not authorize a multi-byte payload.
    const multibyte = { text: "가".repeat(Math.floor(limit / 3) + 1) };
    expect(multibyte.text.length).toBeLessThan(limit);
    await expect(store.write("bytes", multibyte)).rejects.toThrow(
      "1048576 bytes",
    );
    expect(await fs.readFile(statePath, "utf8")).toBe(before);
  });
});

test("multiple StateStore instances share a target queue and ordered read-clear observes it", async () => {
  await fixture(async (root) => {
    const first = storeAt(root);
    const second = storeAt(root);
    // Two instances opening the same new session compute the same folder name.
    expect(await first.resolveSessionDir("same")).toBe(
      await second.resolveSessionDir("same"),
    );
    const writeOne = first.write("same", { sequence: "one", obsolete: true });
    const writeTwo = second.write("same", { sequence: "two" });
    await Promise.all([writeOne, writeTwo]);
    expect(await first.read("same")).toMatchObject({ sequence: "two" });
    expect((await first.read("same"))?.obsolete).toBeUndefined();

    const queuedWrite = first.write("ordered", { sequence: "write" });
    const queuedClear = second.clear("ordered");
    const queuedRead = first.read("ordered");
    await expect(queuedWrite).resolves.toMatchObject({ sequence: "write" });
    await expect(queuedClear).resolves.toBe("deleted");
    await expect(queuedRead).resolves.toBeUndefined();

    await Promise.all([
      first.write("left", { value: "left" }),
      second.write("right", { value: "right" }),
    ]);
    expect((await first.read("left"))?.value).toBe("left");
    expect((await first.read("right"))?.value).toBe("right");

    const submitted = { nested: { value: "submitted" } };
    const explicit = { current_phase: "submitted" };
    const blocking = first.write("captured", { value: "first" });
    const captured = second.write("captured", submitted, explicit);
    submitted.nested.value = "mutated";
    explicit.current_phase = "mutated";
    await Promise.all([blocking, captured]);
    expect(await first.read("captured")).toMatchObject({
      nested: { value: "submitted" },
      current_phase: "submitted",
    });
  });
});

test("a failed atomic publish rejects only its call, cleans its temp, and does not poison later work", async () => {
  await fixture(async (root) => {
    const first = storeAt(root);
    const second = storeAt(root);
    const rename = spyOn(fs, "rename").mockRejectedValueOnce(
      new Error("rename failed"),
    );
    try {
      const failed = first.write("s", { value: "failed" });
      const recovered = second.write("s", { value: "recovered" });
      await expect(failed).rejects.toThrow("rename failed");
      await expect(recovered).resolves.toMatchObject({ value: "recovered" });
    } finally {
      rename.mockRestore();
    }
    const statePath = await first.statePath("s");
    expect(await readFile(statePath, "utf8")).toContain("recovered");
    const entries = await readdir(dirname(statePath));
    expect(entries.filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});

test("clear removes only current valid state and preserves all documents and siblings", async () => {
  await fixture(async (root) => {
    const store = storeAt(root);
    await store.write("A", { owner: "A" });
    await store.write("B", { owner: "B" });
    const a = await store.resolveSessionPaths("A");
    const b = await store.resolveSessionPaths("B");
    const legacy = join(root, ".open-gajae", "state", "legacy.json");
    await mkdir(a.specsDir, { recursive: true });
    await mkdir(a.plansDir, { recursive: true });
    await mkdir(b.specsDir, { recursive: true });
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(join(a.specsDir, "same.md"), "A spec");
    await writeFile(join(a.plansDir, "same.md"), "A plan");
    await writeFile(join(b.specsDir, "same.md"), "B spec");
    await writeFile(legacy, "legacy");

    expect(await store.clear("A")).toBe("deleted");
    expect(await store.clear("A")).toBe("missing");
    await expect(readFile(a.statePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(a.specsDir, "same.md"), "utf8")).toBe("A spec");
    expect(await readFile(join(a.plansDir, "same.md"), "utf8")).toBe("A plan");
    expect(await readFile(b.statePath, "utf8")).toContain("B");
    expect(await readFile(join(b.specsDir, "same.md"), "utf8")).toBe("B spec");
    expect(await readFile(legacy, "utf8")).toBe("legacy");
  });
});

test("corrupt and mismatched owner state remains visible and is never reset or cleared", async () => {
  await fixture(async (root) => {
    const store = storeAt(root);
    const corrupt = await store.statePath("corrupt");
    await mkdir(dirname(corrupt), { recursive: true });
    await writeFile(corrupt, "{broken");
    await expect(store.read("corrupt")).rejects.toThrow("corrupted");
    await expect(store.write("corrupt", { replacement: true })).rejects.toThrow(
      "corrupted",
    );
    await expect(store.clear("corrupt")).rejects.toThrow("corrupted");
    expect(await readFile(corrupt, "utf8")).toBe("{broken");

    const mismatched = await store.statePath("A");
    await mkdir(dirname(mismatched), { recursive: true });
    const foreign = JSON.stringify({
      _meta: { sessionId: "B" },
      value: "keep",
    });
    await writeFile(mismatched, foreign);
    await expect(store.read("A")).rejects.toThrow("scope");
    await expect(store.write("A", { replacement: true })).rejects.toThrow(
      "scope",
    );
    await expect(store.clear("A")).rejects.toThrow("scope");
    expect(await readFile(mismatched, "utf8")).toBe(foreign);

    const unowned = await store.statePath("unowned");
    await mkdir(dirname(unowned), { recursive: true });
    await writeFile(unowned, JSON.stringify({ _runtime: { data: true } }));
    expect((await store.read("unowned"))?._runtime).toEqual({ data: true });
    const replaced = await store.write("unowned", { value: "new" });
    expect(replaced._meta?.sessionId).toBe("unowned");

    const outside = await mkdtemp(join(tmpdir(), "open-gajae-outside-"));
    try {
      await mkdir(join(root, ".open-gajae"), { recursive: true });
      await symlink(
        outside,
        join(root, ".open-gajae", sessionDirName(CREATED, "link")),
      );
      await expect(store.write("link", { escaped: true })).rejects.toThrow(
        "symlink",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("ralplan mode writes a sibling state file and never touches deep-interview state", async () => {
  await fixture(async (root) => {
    const store = storeAt(root);
    const deep = await store.resolveSessionPaths("s");
    const ralplan = await store.resolveSessionPaths("s", "ralplan");
    expect(ralplan.statePath).toBe(
      join(ralplan.sessionDir, "state", "ralplan-state.json"),
    );
    expect(ralplan.sessionDir).toBe(deep.sessionDir);
    expect(ralplan.draftsDir).toBe(deep.draftsDir);
    expect(await store.statePath("s", "ralplan")).toBe(ralplan.statePath);

    await store.write("s", { owner: "deep-interview" });
    const untouched = await readFile(deep.statePath, "utf8");
    const written = await store.write(
      "s",
      { owner: "ralplan" },
      { active: true },
      "ralplan",
    );
    expect(written._meta).toMatchObject({
      mode: "ralplan",
      sessionId: "s",
      updatedBy: "state_write_tool",
    });
    expect(await readFile(deep.statePath, "utf8")).toBe(untouched);
    expect((await store.read("s"))?.owner).toBe("deep-interview");
    expect((await store.read("s", "ralplan"))?.owner).toBe("ralplan");

    expect(await store.clear("s", "ralplan")).toBe("deleted");
    expect(await store.clear("s", "ralplan")).toBe("missing");
    await expect(readFile(ralplan.statePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(deep.statePath, "utf8")).toBe(untouched);
    expect((await store.read("s"))?.owner).toBe("deep-interview");
  });
});

test("patch merges explicit fields into the stored snapshot and validates their types", async () => {
  await fixture(async (root) => {
    const store = storeAt(root);
    await store.write(
      "s",
      { goal: "retained" },
      { active: true, started_at: "2026-01-01T00:00:00.000Z" },
      "ralplan",
    );
    const patched = await store.patch(
      "s",
      { breaker_count: 1, awaiting_confirmation: false },
      "ralplan",
    );
    expect(patched).toMatchObject({
      goal: "retained",
      active: true,
      started_at: "2026-01-01T00:00:00.000Z",
      breaker_count: 1,
      awaiting_confirmation: false,
      _meta: { mode: "ralplan", sessionId: "s", updatedBy: "ralplan_hook" },
    });
    expect(await store.read("s", "ralplan")).toMatchObject({
      goal: "retained",
      breaker_count: 1,
    });
    expect(await store.read("s")).toBeUndefined();

    await expect(
      store.patch("s", { breaker_count: "3" } as never, "ralplan"),
    ).rejects.toThrow("breaker_count must be a finite number");
    await expect(
      store.patch("s", { awaiting_confirmation: "yes" } as never, "ralplan"),
    ).rejects.toThrow("awaiting_confirmation must be a boolean");
    expect((await store.read("s", "ralplan"))?.breaker_count).toBe(1);

    const created = await store.patch("s", { restored_at: "now" }, "ralplan");
    expect(created.goal).toBe("retained");
  });
});
