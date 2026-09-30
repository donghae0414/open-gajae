// The shared workflow state modules (ultragoal revision plan S1): the rank
// snapshot and the visible primary, upstream row removal, the handoff journal,
// the common handoff (C-5) and the doctor.
import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorTx } from "../src/ralplan-runtime/store";
import { RUNTIME_OWNER } from "../src/skill-state/audit";
import { collectDoctorSummaryTx, renderDoctorText } from "../src/skill-state/doctor";
import { handoffWorkflowTx } from "../src/skill-state/handoff";
import {
  beginWorkflowTransactionJournalTx,
  completeWorkflowTransactionJournalTx,
  journalPath,
  updateWorkflowTransactionJournalTx,
} from "../src/skill-state/journal";
import { readVisiblePrimaryTx, rebuildSnapshotTx, syncActiveRowTx } from "../src/skill-state/rows";
import { StateStore, type WorkflowTx } from "../src/state";

const S = "ses_skill";

type Harness = {
  run: <T>(fn: (tx: WorkflowTx) => Promise<T>) => Promise<T>;
  file: (...parts: string[]) => string;
  json: (...parts: string[]) => Promise<any>;
  exists: (...parts: string[]) => Promise<boolean>;
  audit: () => Promise<any[]>;
};

async function fixture(body: (h: Harness) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "open-gajae-skill-state-")));
  try {
    const store = new StateStore(root, async () => Date.parse("2026-09-30T00:00:00Z"));
    const dir = await store.resolveSessionDir(S);
    const file = (...parts: string[]) => join(dir, ...parts);
    await body({
      run: (fn) => store.workflowTransaction(S, fn),
      file,
      json: async (...parts) => JSON.parse(await readFile(file(...parts), "utf8")),
      exists: (...parts) => Bun.file(file(...parts)).exists(),
      audit: async () =>
        (await readFile(file("state", "audit.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const row = (tx: WorkflowTx, entry: Record<string, unknown>) =>
  tx.writeText(tx.paths.activeRow(String(entry.skill)), JSON.stringify(entry));

test("rows: the snapshot primary follows the pipeline rank, as does the visible primary (DR-13, C-3)", async () => {
  await fixture(async ({ run, json }) => {
    await run(async (tx) => {
      await row(tx, { skill: "ultragoal", active: true, phase: "active", updated_at: "2026-09-30T01:00:00Z" });
      await row(tx, { skill: "ralplan", active: true, phase: "revision", updated_at: "2026-09-30T02:00:00Z" });
      await row(tx, { skill: "other", active: true, phase: "x", updated_at: "2026-09-30T03:00:00Z" });
      await rebuildSnapshotTx(tx, RUNTIME_OWNER);
    });
    const snapshot = await json("state", "skill-active-state.json");
    expect(snapshot).toMatchObject({ active: true, skill: "ultragoal", phase: "active" });
    expect(snapshot.active_skills.map((entry: any) => entry.skill)).toEqual(["other", "ralplan", "ultragoal"]);
    expect((await run(readVisiblePrimaryTx))?.skill).toBe("ultragoal");

    // Without ultragoal, ralplan outranks the newer non-pipeline row, and its
    // visible phase is the locked mode-state phase (`withCanonicalRalplanPhase`).
    await run(async (tx) => {
      await row(tx, { skill: "ultragoal", active: false, phase: "handoff", updated_at: "2026-09-30T04:00:00Z" });
      await tx.writeState({ skill: "ralplan", active: true, current_phase: "final" }, "ralplan_tool");
      await rebuildSnapshotTx(tx, RUNTIME_OWNER);
    });
    expect(await json("state", "skill-active-state.json")).toMatchObject({ skill: "ralplan", phase: "revision" });
    expect(await run(readVisiblePrimaryTx)).toMatchObject({ skill: "ralplan", phase: "final" });
  });
});

test("rows: an active row removes the upstream pipeline rows, never a downstream one", async () => {
  await fixture(async ({ run, json, exists, audit }) => {
    await run(async (tx) => {
      await row(tx, { skill: "deep-interview", active: true, phase: "deep-interview" });
      await row(tx, { skill: "ralplan", active: true, phase: "planner" });
      await syncActiveRowTx(tx, { skill: "ultragoal", active: true, phase: "goal-planning", sessionId: S }, RUNTIME_OWNER);
    });
    expect(await exists("state", "active", "deep-interview.json")).toBe(false);
    expect(await exists("state", "active", "ralplan.json")).toBe(false);
    expect(await json("state", "active", "ultragoal.json")).toMatchObject({ skill: "ultragoal", active: true, phase: "goal-planning", session_id: S });
    expect((await audit()).map((r) => r.verb)).toEqual([
      "remove-superseded-pipeline-entry",
      "remove-superseded-pipeline-entry",
      "write-active-entry",
      "rebuild-active-snapshot",
    ]);

    await run((tx) => syncActiveRowTx(tx, { skill: "ralplan", active: true, phase: "planner", sessionId: S }, RUNTIME_OWNER));
    expect(await exists("state", "active", "ultragoal.json")).toBe(true);
    expect((await json("state", "skill-active-state.json")).skill).toBe("ultragoal");
  });
});

test("journal: pending, then committed and removed; a failed removal leaves it committed", async () => {
  await fixture(async ({ run, file, exists, audit }) => {
    const id = "ultragoal:handoff:ralplan:2026-09-30T00:00:00.000Z";
    const name = await run(async (tx) => {
      const path = await beginWorkflowTransactionJournalTx(tx, { mutationId: id, caller: "ultragoal", callee: "ralplan", paths: ["a"] }, RUNTIME_OWNER);
      await updateWorkflowTransactionJournalTx(tx, id, { steps: ["callee-mode-state"] }, RUNTIME_OWNER);
      // No clobber: a second begin keeps the journal as it is.
      expect(await beginWorkflowTransactionJournalTx(tx, { mutationId: id, paths: [] }, RUNTIME_OWNER)).toBe(path);
      expect(JSON.parse((await tx.readText(path))!)).toMatchObject({
        version: 1,
        mutation_id: id,
        status: "pending",
        caller: "ultragoal",
        callee: "ralplan",
        paths: ["a"],
        steps: ["callee-mode-state"],
      });
      await completeWorkflowTransactionJournalTx(tx, id, RUNTIME_OWNER);
      return path;
    });
    expect(name).toBe(file("state", "transactions", "ultragoal%3Ahandoff%3Aralplan%3A2026-09-30T00%3A00%3A00%2E000Z.json"));
    expect(await Bun.file(name).exists()).toBe(false);
    expect((await audit()).map((r) => [r.verb, r.mutation_id])).toEqual([
      ["write-transaction-journal", id],
      ["write-transaction-journal", id],
      ["write-transaction-journal", id],
      ["remove-transaction-journal", id],
    ]);

    await run(async (tx) => {
      const stuck: WorkflowTx = { ...tx, remove: async () => Promise.reject(new Error("busy")) };
      await beginWorkflowTransactionJournalTx(stuck, { mutationId: "m2", paths: [] }, RUNTIME_OWNER);
      await completeWorkflowTransactionJournalTx(stuck, "m2", RUNTIME_OWNER);
      expect(JSON.parse((await tx.readText(journalPath(tx, "m2")))!).status).toBe("committed");
    });
    expect(await exists("state", "transactions", "m2.json")).toBe(true);
  });
});

test("handoff ultragoal → ralplan: fields kept, ralplan planner on its run, rows, journal gone, caller records last", async () => {
  await fixture(async ({ run, json, exists, audit, file }) => {
    await run(async (tx) => {
      await tx.writeModeState("ultragoal", { skill: "ultragoal", active: true, current_phase: "active", kept: "u" }, "ultragoal_tool");
      await tx.writeModeState("ralplan", { skill: "ralplan", active: false, current_phase: "handoff", run_id: "r1" }, "ralplan_tool");
    });
    const recorded: unknown[] = [];
    const receipt = await run((tx) =>
      handoffWorkflowTx(tx, {
        caller: "ultragoal",
        callee: "ralplan",
        sessionId: S,
        owner: RUNTIME_OWNER,
        reason: "replan",
        recordCaller: async (handoff) => {
          // ⑥ runs after the rows (⑤) and before the journal is committed (⑦).
          recorded.push(handoff, await exists("state", "active", "ralplan.json"), (await readdir(file("state", "transactions"))).length);
        },
      }),
    );
    const at = receipt.handoff_at;
    expect(receipt).toMatchObject({ ok: true, from: "ultragoal", to: "ralplan", phases: { from: "handoff", to: "planner" } });
    expect(recorded).toEqual([{ to: "ralplan", reason: "replan", at }, true, 1]);
    expect(await json("state", "ralplan-state.json")).toMatchObject({
      skill: "ralplan",
      version: 2,
      active: true,
      current_phase: "planner",
      run_id: "r1",
      handoff_from: "ultragoal",
      handoff_at: at,
      session_id: S,
      _meta: { updatedBy: "ultragoal_tool" },
    });
    expect(await json("state", "ultragoal-state.json")).toMatchObject({ active: false, current_phase: "handoff", handoff_to: "ralplan", handoff_at: at, kept: "u" });
    expect(await json("state", "active", "ultragoal.json")).toMatchObject({ active: false, phase: "handoff", handoff_to: "ralplan", handoff_at: at });
    const ralplanRow = await json("state", "active", "ralplan.json");
    expect(ralplanRow).toMatchObject({ active: true, phase: "planner", handoff_from: "ultragoal", handoff_at: at });
    expect(ralplanRow.hud.chips).toContainEqual({ label: "stage", value: "planner", priority: 10 });
    expect((await json("state", "skill-active-state.json")).skill).toBe("ralplan");
    expect(await readdir(file("state", "transactions"))).toEqual([]);
    const rows = await audit();
    expect(rows.filter((r) => r.verb === "handoff").map((r) => [r.skill, r.from_phase, r.to_phase, r.mutation_id])).toEqual([
      ["ralplan", "handoff", "planner", receipt.mutation_id],
      ["ultragoal", "active", "handoff", receipt.mutation_id],
    ]);
    // gjc's audit-only diagnostic: ralplan has no handoff → planner edge.
    expect(rows.filter((r) => r.verb === "invalid_transition_detected").map((r) => [r.skill, r.from_phase, r.to_phase])).toEqual([
      ["ralplan", "handoff", "planner"],
    ]);
  });
});

test("handoff ultragoal → deep-interview: phase deep-interview, fields kept, no callee row (PQ-5)", async () => {
  await fixture(async ({ run, json, exists }) => {
    await run(async (tx) => {
      await tx.writeModeState("ultragoal", { skill: "ultragoal", active: true, current_phase: "active" }, "ultragoal_tool");
      await tx.writeModeState("deep-interview", { active: false, current_phase: "complete", state: { rounds: [1] } }, "state_write_tool");
    });
    await run((tx) => handoffWorkflowTx(tx, { caller: "ultragoal", callee: "deep-interview", sessionId: S, owner: RUNTIME_OWNER, reason: "clarify" }));
    expect(await json("state", "deep-interview-state.json")).toMatchObject({
      active: true,
      current_phase: "deep-interview",
      handoff_from: "ultragoal",
      state: { rounds: [1] },
    });
    expect(await exists("state", "active", "deep-interview.json")).toBe(false);
    expect(await json("state", "active", "ultragoal.json")).toMatchObject({ active: false, handoff_to: "deep-interview" });
    expect(await json("state", "skill-active-state.json")).toMatchObject({ active: false, skill: "" });
  });
});

test("handoff ralplan → ultragoal: ultragoal goal-planning, the ralplan row stays inactive with its handoff_from", async () => {
  await fixture(async ({ run, json }) => {
    await run(async (tx) => {
      await tx.writeModeState("ralplan", { skill: "ralplan", active: true, current_phase: "final", run_id: "r1" }, "ralplan_tool");
      await row(tx, { skill: "ralplan", active: true, phase: "final", handoff_from: "ultragoal" });
    });
    await run((tx) => handoffWorkflowTx(tx, { caller: "ralplan", callee: "ultragoal", sessionId: S, owner: RUNTIME_OWNER, reason: "approved" }));
    expect(await json("state", "ultragoal-state.json")).toMatchObject({
      skill: "ultragoal",
      version: 2,
      active: true,
      current_phase: "goal-planning",
      handoff_from: "ralplan",
      session_id: S,
      _meta: { updatedBy: "ralplan_tool" },
    });
    expect(await json("state", "ralplan-state.json")).toMatchObject({ active: false, current_phase: "handoff", handoff_to: "ultragoal", run_id: "r1" });
    expect(await json("state", "active", "ralplan.json")).toMatchObject({ active: false, phase: "handoff", handoff_to: "ultragoal", handoff_from: "ultragoal" });
    expect(await json("state", "active", "ultragoal.json")).toMatchObject({ active: true, phase: "goal-planning", handoff_from: "ralplan" });
    expect(await run(readVisiblePrimaryTx)).toMatchObject({ skill: "ultragoal", phase: "goal-planning" });
  });
});

test("handoff: a corrupt callee is refused before the journal; a throw mid-way leaves the journal pending", async () => {
  await fixture(async ({ run, json, file }) => {
    await run((tx) => tx.writeModeState("ultragoal", { skill: "ultragoal", active: true, current_phase: "active" }, "ultragoal_tool"));
    await writeFile(file("state", "ralplan-state.json"), "{");
    const input = { caller: "ultragoal", callee: "ralplan", sessionId: S, owner: RUNTIME_OWNER, reason: "r" } as const;
    await expect(run((tx) => handoffWorkflowTx(tx, input))).rejects.toThrow("existing state for ralplan is corrupt or tampered");
    expect(await readdir(file("state"))).not.toContain("transactions");

    await rm(file("state", "ralplan-state.json"));
    const failing = { ...input, recordCaller: async () => Promise.reject(new Error("ledger write failed")) };
    await expect(run((tx) => handoffWorkflowTx(tx, failing))).rejects.toThrow("ledger write failed");
    const [name] = await readdir(file("state", "transactions"));
    expect(await json("state", "transactions", name!)).toMatchObject({
      status: "pending",
      caller: "ultragoal",
      callee: "ralplan",
      steps: ["callee-mode-state", "caller-mode-state", "active-state"],
    });
  });
});

test("doctor: the ralplan summary is unchanged and renders as gjc's doctor text", async () => {
  await fixture(async ({ run, file }) => {
    await run(async (tx) => {
      await tx.writeState({ skill: "ralplan", active: true, current_phase: "intent" }, "ralplan_tool");
      await row(tx, { skill: "ralplan", active: true, phase: "planner" });
      // A skill outside the filter: its row is counted, not checked.
      await row(tx, { skill: "ultragoal", active: true, phase: "active" });
      await tx.writeText(
        tx.paths.snapshotPath,
        JSON.stringify({ active_skills: [{ skill: "ralplan", active: true, phase: "planner" }] }),
      );
    });
    const stateDir = file("state");
    const rowPath = file("state", "active", "ralplan.json");
    const snapshotPath = file("state", "skill-active-state.json");
    const expected = {
      ok: false,
      root: stateDir,
      summary: {
        skills_scanned: 1,
        files_scanned: 4,
        findings_total: 2,
        by_kind: { schema_violation: 0, stale_active_state: 2 },
      },
      problems: [
        {
          type: "stale_active_state",
          skill: "ralplan",
          path: rowPath,
          message: "active entry for ralplan phase planner differs from canonical mode-state phase intent",
          fixCommand: "ralplan clear",
        },
        {
          type: "stale_active_state",
          skill: "ralplan",
          path: snapshotPath,
          message: "active snapshot for ralplan phase planner differs from canonical mode-state phase intent",
          fixCommand: "ralplan clear",
        },
      ],
    };
    const summary = await run(doctorTx);
    expect(summary).toEqual(expected as never);
    // Unfiltered, the doctor also checks the registered ultragoal skill (plan
    // S2): its active row has no live mode-state.
    expect(await run((tx) => collectDoctorSummaryTx(tx))).toEqual({
      ...summary,
      summary: {
        skills_scanned: 2,
        files_scanned: 4,
        findings_total: 3,
        by_kind: { schema_violation: 0, stale_active_state: 3 },
      },
      problems: [
        ...summary.problems,
        {
          type: "stale_active_state",
          skill: "ultragoal",
          path: file("state", "active", "ultragoal.json"),
          message: "active entry for ultragoal does not match a live active mode-state",
          fixCommand: "ultragoal clear",
        },
      ],
    } as never);
    expect(renderDoctorText(summary)).toBe(
      [
        "ok: false",
        `root: ${stateDir}`,
        "skills_scanned: 1",
        "files_scanned: 4",
        "findings_total: 2",
        "counts: schema_violation=0, stale_active_state=2",
        `finding: kind=stale_active_state skill=ralplan path=${rowPath} message=active entry for ralplan phase planner differs from canonical mode-state phase intent fix=ralplan clear`,
        `finding: kind=stale_active_state skill=ralplan path=${snapshotPath} message=active snapshot for ralplan phase planner differs from canonical mode-state phase intent fix=ralplan clear`,
        "",
      ].join("\n"),
    );
  });
});
