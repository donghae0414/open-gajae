import { test, expect } from "bun:test";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, ambiguityScore } from "../src/state";

async function fixture(
  run: (store: StateStore, root: string) => Promise<void>,
  maxRounds = 20,
) {
  const root = await mkdtemp(join(tmpdir(), "open-gajae-state-"));
  try {
    await run(
      new StateStore(root, { ambiguityThreshold: 0.2, maxRounds }),
      root,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("isolated sessions replace snapshots and retain host-owned runtime", async () => {
  await fixture(async (store) => {
    expect(await store.read("session1")).toBeUndefined();
    const first = await store.start("session1", "clarify first feature");
    await store.start("session2", "clarify second feature");
    await store.replaceModelState("session1", {
      goal: "A",
      old: true,
      nested: { old: 1 },
    });
    const changed = await store.replaceModelState("session1", {
      goal: "B",
      nested: { new: 2 },
    });
    expect(changed.old).toBeUndefined();
    expect(changed.nested).toEqual({ new: 2 });
    expect(changed._runtime.interviewId).toBe(first._runtime.interviewId);
    expect((await store.read("session2"))?.task_description).toBe(
      "clarify second feature",
    );
    await expect(
      store.replaceModelState("session1", { _runtime: {} }),
    ).rejects.toThrow("reserved");
    await expect(store.start("session1", "overwrite")).rejects.toThrow();
  });
});

test("custom payload boundaries preserve the last valid snapshot on failure", async () => {
  await fixture(async (store) => {
    await store.start("s", "payload boundaries");
    await store.replaceModelState(
      "s",
      Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i])),
    );
    await expect(
      store.replaceModelState(
        "s",
        Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i])),
      ),
    ).rejects.toThrow("100");
    let nested: Record<string, unknown> = { value: 1 };
    for (let i = 1; i < 10; i++) nested = { nested };
    await store.replaceModelState("s", nested);
    await expect(store.replaceModelState("s", { nested })).rejects.toThrow(
      "depth",
    );
    const overhead = Buffer.byteLength(JSON.stringify({ text: "" }));
    const value = "a".repeat(1_048_576 - overhead);
    await store.replaceModelState("s", { text: value });
    await expect(
      store.replaceModelState("s", { text: value + "한" }),
    ).rejects.toThrow("bytes");
    await expect(store.replaceModelState("s", { bigint: 1n })).rejects.toThrow(
      "serializ",
    );
    expect((await store.read("s"))?.text).toBe(value);
  });
});

test("corrupted files and symlink escapes fail without overwriting evidence", async () => {
  await fixture(async (store, root) => {
    await store.start("s", "corruption preservation");
    const file = store.statePath("s");
    await writeFile(file, "{broken");
    await expect(store.read("s")).rejects.toThrow("corrupt");
    await expect(store.start("s", "reset")).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("{broken");
    expect(() => store.statePath("../escape")).toThrow();
    const outside = await mkdtemp(join(tmpdir(), "open-gajae-outside-"));
    try {
      await mkdir(join(root, ".open-gajae/state/sessions/link"), {
        recursive: true,
      });
      await symlink(
        join(outside, "target.json"),
        join(root, ".open-gajae/state/sessions/link/deep-interview-state.json"),
      );
      await expect(store.start("link", "bad path")).rejects.toThrow("regular");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("weighted scoring differs for brownfield context gaps", () => {
  expect(
    ambiguityScore({ goal: 1, constraints: 0.5, criteria: 0.5 }),
  ).toBeCloseTo(0.3);
  expect(
    ambiguityScore(
      { goal: 1, constraints: 0.5, criteria: 0.5, context: 0 },
      true,
    ),
  ).toBeCloseTo(0.4);
  expect(() =>
    ambiguityScore({ goal: NaN, constraints: 1, criteria: 1 }),
  ).toThrow();
});

test("confirmed recovery preserves the partial artifact and uses a fresh receipt path", async () => {
  await fixture(async (store) => {
    const initial = await store.start("recover", "cancel with partial result");
    await store.replaceModelState("recover", readyModel());
    await store.cancel("recover");
    await expect(
      store.writeSpec("recover", "# Not normal", "normal"),
    ).rejects.toThrow("active");
    const partial = await store.writeSpec("recover", "# Partial", "cancelled");
    const resumed = await store.resume("recover", true);
    expect(resumed._runtime.interviewId).toBe(initial._runtime.interviewId);
    await store.recordQuestionIntent("recover", "requirement");
    await store.recordQuestionAsked("recover", "after-resume");
    await store.recordQuestionReply("recover", "after-resume", [["confirmed"]]);
    await store.replaceModelState("recover", readyModel());
    const normal = await store.writeSpec("recover", "# Complete", "normal");
    expect(normal.path).not.toBe(partial.path);
    expect(await readFile(partial.path, "utf8")).toBe("# Partial");
    expect((await store.complete("recover"))._runtime.status).toBe("completed");
  });
});

function readyModel() {
  return {
    goal: "Ship a bounded example",
    decisions: ["Keep the existing interface"],
    acceptance_criteria: ["A real observable outcome"],
    non_goals: ["No migration"],
    decision_boundaries: ["User owns schema changes"],
    topology: {
      status: "confirmed",
      components: [{ id: "api" }],
      deferrals: [],
    },
    ontology_snapshots: [
      {
        entities: [],
        stability_ratio: "N/A",
        matching_reasoning: "No domain entities",
      },
    ],
    current_ambiguity: 0.1,
    closure: {
      non_goals: true,
      decision_boundaries: true,
      pressure_pass: true,
      closure_audit: true,
    },
    next_question_kind: "requirement",
  };
}
test("raw spec receipt and completion reject stale files, models and incomplete closure", async () => {
  await fixture(async (store) => {
    await store.start("s", "normal completion");
    await expect(
      store.writeSpec("s", "# premature", "normal"),
    ).rejects.toThrow();
    await store.replaceModelState("s", readyModel());
    const receipt = await store.writeSpec(
      "s",
      "# Actual specification\n",
      "normal",
    );
    expect(await readFile(receipt.path, "utf8")).toBe(
      "# Actual specification\n",
    );
    await writeFile(receipt.path, "# changed");
    await expect(store.complete("s")).rejects.toThrow("hash");
    await writeFile(receipt.path, "# Actual specification\n");
    await expect(
      store.replaceModelState(
        "s",
        { ...readyModel(), completion_requested: true },
        "state_write",
        { task_description: "different" },
      ),
    ).rejects.toThrow();
    const done = await store.replaceModelState("s", {
      ...readyModel(),
      completion_requested: true,
    });
    expect(done._runtime.status).toBe("completed");
    expect(await store.claimContinuation("s", "assistant1")).toBeUndefined();
    const fresh = await store.start("s", "new interview");
    expect(fresh._runtime.interviewId).not.toBe(receipt.interviewId);
  });
});

test("actual answers are recorded once, and cancellation cannot be reversed by late events", async () => {
  await fixture(async (store) => {
    await store.start("s", "question lifecycle");
    await store.recordQuestionIntent("s", "requirement", "call1");
    await expect(
      store.recordQuestionIntent("s", "requirement", "call2"),
    ).rejects.toThrow();
    await store.recordQuestionAsked("s", "q1", "call1");
    await store.recordQuestionReply("s", "q1");
    expect((await store.read("s"))?._runtime.status).toBe("waiting");
    await Promise.all([
      store.recordQuestionReply("s", "q1", [["real answer"]]),
      store.recordQuestionReply("s", "q1", [["real answer"]]),
    ]);
    expect((await store.read("s"))?._runtime.round).toBe(1);
    expect((await store.read("s"))?._runtime.answers).toHaveLength(1);
    await store.recordQuestionAsked("s", "q1", "call1");
    expect((await store.read("s"))?._runtime.status).toBe("active");
    await store.cancel("s");
    await store.recordQuestionReply("s", "q1", [["late"]]);
    await expect(store.resume("s")).rejects.toThrow("confirmation");
    expect((await store.read("s"))?._runtime.status).toBe("cancelled");
  });
});

test("tenth-round control does not count and a negative response stops further questions", async () => {
  await fixture(async (store) => {
    await store.start("s", "round control");
    for (let i = 0; i < 10; i++) {
      await store.recordQuestionIntent(
        "s",
        i === 0 ? "confirmation" : "requirement",
      );
      await store.recordQuestionAsked("s", `q${i}`);
      await store.recordQuestionReply("s", `q${i}`, [["answer"]]);
    }
    await expect(
      store.recordQuestionIntent("s", "requirement"),
    ).rejects.toThrow("tenth");
    await store.recordQuestionIntent("s", "continuation");
    await store.recordQuestionAsked("s", "continue");
    await store.recordQuestionReply("s", "continue", [["Stop"]]);
    const state = await store.read("s");
    expect(state?._runtime.round).toBe(10);
    expect(state?._runtime.status).toBe("cancelled");
    expect(await store.claimContinuation("s", "assistant")).toBeUndefined();
  }, 11);
  await fixture(async (store) => {
    await store.start("cap", "hard cap");
    await store.recordQuestionIntent("cap", "requirement");
    await store.recordQuestionAsked("cap", "q");
    await store.recordQuestionReply("cap", "q", [["answer"]]);
    expect((await store.read("cap"))?._runtime.status).toBe("limit-reached");
    await expect(
      store.recordQuestionIntent("cap", "continuation"),
    ).rejects.toThrow();
    await store.writeSpec("cap", "# Partial at cap", "limit-reached");
  }, 1);
});
