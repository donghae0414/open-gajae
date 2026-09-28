// `ralplan` tool (plan S2): ops, actors, the gjc write flow, budgets, rows,
// doctor, handoff and the ultragoal entry gate, over a fake lineage (root +
// role children) and a fake ultragoal state.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "../src/config";
import { createHooks } from "../src/hooks";
import { ultragoalEntryGate } from "../src/ralplan-runtime/store";
import { StateStore } from "../src/state";
import { createTools } from "../src/tools";
import { RALPLAN_ACTIVATION_REFUSAL } from "../src/ultragoal";
import { seedUltragoal } from "../src/ultragoal-hooks";

const T0 = Date.parse("2026-09-28T00:00:00.000Z");
const ROOT = "ses_root";
const PLANNER = "open-gajae-planner";
const ARCHITECT = "open-gajae-architect";
const CRITIC = "open-gajae-critic";
const CHILD: Record<string, string> = {
  [PLANNER]: "ses_planner",
  [ARCHITECT]: "ses_architect",
  [CRITIC]: "ses_critic",
};
const LINEAGE: Record<string, string> = {
  [ROOT]: ROOT,
  ses_planner: ROOT,
  ses_architect: ROOT,
  ses_critic: ROOT,
  ses_exec: ROOT,
};

type Call = (args: Record<string, unknown>, agent?: string, sessionID?: string) => Promise<string>;
type Harness = {
  store: StateStore;
  root: string;
  call: Call;
  /** `write` as `agent` from its own session (roles run in child sessions). */
  write: (stage: string, n: number, content: string, extra?: Record<string, unknown>, agent?: string) => Promise<string>;
  file: (...parts: string[]) => string;
  json: (...parts: string[]) => Promise<any>;
  run: (runId?: string) => string;
  audit: () => Promise<any[]>;
};

async function fixture(body: (h: Harness) => Promise<void>, settings?: Partial<Settings["ralplan"]>) {
  const root = await mkdtemp(join(tmpdir(), "open-gajae-ralplan-"));
  try {
    const store = new StateStore(root, async () => T0);
    const ralplanSettings: Settings["ralplan"] = {
      maxIterations: 5,
      maxReviewPassesPerLane: 1,
      autoHandoff: "off",
      source: { maxIterations: "default", maxReviewPassesPerLane: "default", autoHandoff: "default" },
      ...settings,
    };
    const tool = createTools(store, { locationDir: root, projectDir: root }, {
      async parentSession() {
        return undefined;
      },
      async rootSession(id) {
        if (!(id in LINEAGE)) throw new Error("unknown session");
        return LINEAGE[id];
      },
      ralplanSettings,
    }).find((t) => t.name === "ralplan")!;
    const call: Call = async (args, agent = "open-gajae", sessionID = ROOT) =>
      (await tool.execute(tool.input.parse(args) as never, { agent, sessionID, signal: new AbortController().signal })).content;
    const dir = await store.resolveSessionDir(ROOT);
    const file = (...parts: string[]) => join(dir, ...parts);
    await body({
      store,
      root,
      call,
      write: (stage, n, content, extra = {}, agent = "open-gajae") =>
        call({ op: "write", stage, stage_n: n, content, ...extra }, agent, CHILD[agent] ?? ROOT),
      file,
      json: async (...parts) => JSON.parse(await readFile(file(...parts), "utf8")),
      run: (runId = ROOT) => file("plans", "ralplan", runId),
      audit: async () =>
        (await readFile(file("state", "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The JSON receipt after a write's text line(s). */
function receipt(content: string): any {
  return JSON.parse(content.slice(content.indexOf("\n{") + 1));
}

const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const lines = async (path: string) => (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
const runningUltragoal = (store: StateStore) =>
  store.ultragoalTransaction(ROOT, (tx) =>
    tx.writeState({ active: true, current_phase: "ultragoal", awaiting_confirmation: false, iteration: 1, max_iterations: 100 }, "ultragoal_tool"),
  );

test("AC1: seven ops; primary all, roles write/status/state, everyone else and a failed lineage refused", async () => {
  await fixture(async ({ root, store, call }) => {
    const tool = createTools(store, { locationDir: root, projectDir: root }).find((t) => t.name === "ralplan")!;
    expect((tool.input as any).shape.op.options).toEqual(["start", "write", "status", "doctor", "state", "handoff", "clear"]);
    // No `rootSession` in deps: only this tool refuses (fail closed).
    expect((await tool.execute({ op: "status" } as never, { agent: "open-gajae", sessionID: ROOT, signal: new AbortController().signal })).content).toContain("could not resolve the session lineage");
    for (const agent of [PLANNER, ARCHITECT, CRITIC]) {
      expect(await call({ op: "status" }, agent, CHILD[agent])).toStartWith("{");
      for (const op of ["start", "doctor", "handoff", "clear"])
        expect(await call({ op, task: "t", to: "ultragoal" }, agent, CHILD[agent])).toBe(`Error: ${agent} may only use write, status and state`);
    }
    for (const agent of ["open-gajae-executor", "open-gajae-explore", "build"])
      expect(await call({ op: "status" }, agent, "ses_exec")).toBe(`Error: the ralplan tool is not available to ${agent}`);
    expect(await call({ op: "status" }, "open-gajae", "ses_unknown")).toContain("could not resolve the session lineage");
  });
});

test("start: gjc seed on the root session's run, row and snapshot; run_id checks, empty task, running ultragoal (P-AC3, AC6, AC14)", async () => {
  await fixture(async ({ store, call, file, json, root }) => {
    for (const run_id of ["a/b", "..", "x".repeat(65)])
      expect(await call({ op: "start", task: "t", run_id })).toContain(`invalid path component for run_id: ${run_id}`);
    expect(await call({ op: "start", task: "  " })).toContain("requires a task description");
    const summary = JSON.parse(await call({ op: "start", task: "ship it", deliberate: true }));
    expect(Object.keys(summary).sort()).toEqual(["handoff", "mode", "ok", "repository_binding", "run_id", "session_id", "skill", "state_path"]);
    expect(summary).toMatchObject({ run_id: ROOT, session_id: ROOT, skill: "ralplan", mode: "deliberate", handoff: "ralplan", state_path: file("state", "ralplan-state.json") });
    // A non-git project records what it can (AC6).
    expect(summary.repository_binding).toMatchObject({ schema: "gjc.repository_binding.v1", commonDir: null, displayPath: root });
    const { _meta, updated_at, ...state } = await json("state", "ralplan-state.json");
    expect(state).toEqual({ active: true, current_phase: "planner", skill: "ralplan", version: 2, mode: "deliberate", interactive: false, task: "ship it", run_id: ROOT, session_id: ROOT, repository_binding: summary.repository_binding });
    const row = await json("state", "active", "ralplan.json");
    expect(row).toMatchObject({ skill: "ralplan", phase: "planner", active: true, session_id: ROOT });
    expect(row.hud.chips).toContainEqual({ label: "stage", value: "planner", priority: 10 });
    const snapshot = await json("state", "skill-active-state.json");
    expect(snapshot).toMatchObject({ version: 1, active: true, skill: "ralplan", phase: "planner", session_id: ROOT, active_subskills: [] });
    for (const doc of [row, snapshot]) expect(JSON.stringify(doc)).not.toMatch(/state_revision/);
    await runningUltragoal(store);
    expect(await call({ op: "start", task: "again" })).toBe(`Error: ${RALPLAN_ACTIVATION_REFUSAL}`);
  });
});

test("write: stage files, ledger rows, receipts, role ids, verdicts, dedupe, repair and pending approval (AC2-AC7, DR-20, P-AC9)", async () => {
  await fixture(async ({ call, write, file, json, run, root }) => {
    await call({ op: "start", task: "t" });
    // Roles write into the root's run; the role's own session is recorded (AC7, DR-1).
    const planner = receipt(await write("planner", 1, "# Plan\n\ndraft", {}, PLANNER));
    expect(planner.path).toBe(join(run(), "stage-01-planner.md"));
    expect(planner.path).toMatch(/\/\.open-gajae\/_session-[^/]+\/plans\/ralplan\/ses_root\/stage-01-planner\.md$/);
    expect(planner.planner_state).toEqual({ planner_subagent_id: "ses_planner" });
    expect(await readFile(planner.path, "utf8")).toBe("# Plan\n\ndraft\n");
    expect(planner.sha256).toBe(sha(await readFile(planner.path)));
    const [row] = await lines(join(run(), "index.jsonl"));
    expect(row).toEqual({ stage: "planner", stage_n: 1, path: planner.path, created_at: planner.created_at, sha256: planner.sha256 });
    // P-AC9: a role's path is refused before any path check, and nothing is written.
    expect(await write("planner", 9, "x", { content: undefined, path: "/tmp/x.md" }, PLANNER)).toContain("must pass the artifact as content");
    expect(await readdir(run())).not.toContain("stage-09-planner.md");
    // AC5: the primary's temp path is read; a project path is refused.
    const temp = await mkdtemp(join(tmpdir(), "open-gajae-artifact-"));
    await writeFile(join(temp, "intent.md"), "intent body");
    await writeFile(join(root, "intent.md"), "intent body");
    expect(await call({ op: "write", stage: "intent", stage_n: 1, path: join(root, "intent.md") })).toContain("under an OS temp directory");
    expect(receipt(await call({ op: "write", stage: "intent", stage_n: 1, path: join(temp, "intent.md") })).stage).toBe("intent");
    await rm(temp, { recursive: true, force: true });
    // AC3: identical → deduplicated without any change; different → refused; bad stage/stage_n.
    const stateBefore = await readFile(file("state", "ralplan-state.json"), "utf8");
    const again = receipt(await write("planner", 1, "# Plan\n\ndraft\n", {}, PLANNER));
    expect(again).toMatchObject({ deduplicated: true, path: planner.path, created_at: planner.created_at });
    expect(await readFile(file("state", "ralplan-state.json"), "utf8")).toBe(stateBefore);
    expect(await lines(join(run(), "index.jsonl"))).toHaveLength(2);
    expect(await write("planner", 1, "other")).toContain("Use a new stage_n to record another pass.");
    expect(await write("verdict", 1, "x")).toContain("unknown stage: verdict");
    for (const n of [0, 1000]) expect(await write("planner", n, "x")).toContain(`invalid stage_n: ${n}`);
    // Architect: its id, `resumable` only when given, and the lane verdict.
    const architect = receipt(await write("architect", 1, "arch", { resumable: true, lane_verdict: "clear" }, ARCHITECT));
    expect(architect).toMatchObject({ architect_state: { architect_id: "ses_architect", architect_resumable: true }, lane_verdict: { lane: "architect", verdict: "CLEAR" } });
    expect(await json("state", "ralplan-state.json")).toMatchObject({ architect_id: "ses_architect", last_review_verdict: "CLEAR", last_review_verdict_lane: "architect", last_review_verdict_stage_n: 1 });
    // Critic fallback metadata: all three or refused.
    expect(await write("critic", 1, "crit", { fallback_reason: "not_found" }, CRITIC)).toContain("fallback_attempted_id is required");
    await write("critic", 1, "crit", { fallback_reason: "not_found", fallback_attempted_id: "ses_old", fallback_stage_n: 1 }, CRITIC);
    const afterCritic = await json("state", "ralplan-state.json");
    expect(afterCritic).toMatchObject({ critic_id: "ses_critic", critic_fallback_reason: "not_found", critic_fallback_attempted_id: "ses_old", critic_fallback_stage_n: 1 });
    expect(afterCritic).not.toHaveProperty("critic_resumable");
    // Crash-gap repair: the row comes back and the role metadata rides it (DR-20) ...
    const index = join(run(), "index.jsonl");
    await writeFile(index, (await readFile(index, "utf8")).split("\n").filter((l) => !l.includes('"stage":"architect"')).join("\n"));
    await call({ op: "state", patch: { architect_id: null, last_review_verdict: null } });
    expect(receipt(await write("architect", 1, "arch", { lane_verdict: "watch" }, ARCHITECT))).toMatchObject({ deduplicated: true, lane_verdict: { verdict: "WATCH" } });
    expect((await lines(index)).filter((r) => r.stage === "architect")).toHaveLength(1);
    expect(await json("state", "ralplan-state.json")).toMatchObject({ architect_id: "ses_architect", last_review_verdict: "WATCH" });
    // ... while a ledger duplicate changes nothing.
    await write("architect", 1, "arch", { lane_verdict: "block" }, ARCHITECT);
    expect((await json("state", "ralplan-state.json")).last_review_verdict).toBe("WATCH");
    // AC4: final copies to pending-approval; the next final overwrites it; stage files stay.
    const final1 = receipt(await write("final", 1, "# Final one"));
    expect(final1).toMatchObject({ pending_approval_path: join(run(), "pending-approval.md"), auto_handoff: { configuredTarget: "off", effectiveTarget: "off", degradationReason: null, source: "default" } });
    expect(await readFile(final1.pending_approval_path, "utf8")).toBe(await readFile(final1.path, "utf8"));
    await write("final", 2, "# Final two");
    expect(await readFile(final1.pending_approval_path, "utf8")).toBe("# Final two\n");
    expect(sha(await readFile(final1.path))).toBe(final1.sha256);
  });
});

test("budgets: opener cap and lane budget stop with PLANNING-STUCK; final degrades; disk floor; new run resets (AC8, AC9)", async () => {
  await fixture(
    async ({ write, json, run }) => {
      await write("planner", 1, "p1");
      const stuck = await write("revision", 2, "r2");
      expect(stuck).toStartWith("PLANNING-STUCK: ralplan consensus iteration cap exceeded");
      expect(receipt(stuck)).toMatchObject({ ok: false, planning_stuck: true, marker: "PLANNING-STUCK", max_iterations: 1, max_iterations_source: "/cfg/open-gajae.jsonc" });
      await write("revision", 3, "r3");
      expect((await lines(join(run(), "index.jsonl"))).filter((r) => r.planning_stuck === true)).toHaveLength(1);
      expect((await json("state", "ralplan-state.json")).planning_stuck).toMatchObject({ marker: "PLANNING-STUCK" });
      // The open iteration still takes its reviews and the closing stages.
      await write("architect", 1, "a1");
      const lane = await write("architect", 2, "a2");
      expect(receipt(lane)).toMatchObject({ planning_stuck: true, lane: "architect", passes: 1, max_review_passes_per_lane: 1 });
      expect(receipt(await write("architect", 1, "a1")).deduplicated).toBe(true);
      for (const [stage, n] of [["post-interview", 1], ["adr", 1]] as const) expect(receipt(await write(stage, n, stage)).stage).toBe(stage);
      expect(receipt(await write("final", 1, "f1")).auto_handoff).toMatchObject({ effectiveTarget: "off", degradationReason: "planning_stuck" });
      // A lost index still counts the openers on disk.
      await rm(join(run(), "index.jsonl"));
      expect(await write("planner", 4, "p4")).toContain("ledger under-count: index=0, on-disk openers=1");
      // A new run has a fresh budget.
      expect(receipt(await write("architect", 1, "a1", { run_id: "run-2" })).path).toBe(join(run("run-2"), "stage-01-architect.md"));
    },
    { maxIterations: 1, source: { maxIterations: "/cfg/open-gajae.jsonc", maxReviewPassesPerLane: "default", autoHandoff: "default" } },
  );
  await fixture(
    async ({ write }) => {
      await write("planner", 1, "p1");
      await write("critic", 1, "c1");
      const second = await write("critic", 2, "c2");
      expect(second).toStartWith("Warning: ralplan critic review budget final slot used (2/2).");
      expect(receipt(second).review_budget_warning).toEqual({ lane: "critic", passes: 2, max: 2 });
      expect(await write("critic", 3, "c3")).toStartWith("PLANNING-STUCK");
    },
    { maxReviewPassesPerLane: 2 },
  );
});

test("disposition is validated against the ledger; auto handoff to ultragoal (AC10, AC11)", async () => {
  await fixture(
    async ({ write, json, run }) => {
      await write("planner", 1, "p");
      const arch = receipt(await write("architect", 1, "a"));
      const crit = receipt(await write("critic", 1, "c"));
      const receiptOf = (r: any) => ({ stage: r.stage, stageN: 1, path: r.path, sha256: r.sha256 });
      const findings = [
        { findingId: "arch-1", targetId: "contract.field", action: "remove", severity: "block", evidence: "dup", sourceRole: "architect", sourceReceipt: receiptOf(arch) },
        { findingId: "crit-1", targetId: "contract.field", action: "add", severity: "watch", evidence: "need", sourceRole: "critic", sourceReceipt: receiptOf(crit) },
      ];
      const doc = (f: unknown[]) =>
        JSON.stringify({ schema: "ralplan.review_conflicts.v1", plannerStageN: 1, findings: f, dispositions: [{ conflictId: "conflict:contract.field:arch-1:crit-1", choice: "accept_architect", rationale: "ok", decisionOwner: "ralplan-leader", affectedSections: ["## Contracts"] }] });
      const forged = [{ ...findings[0], sourceReceipt: { ...receiptOf(arch), path: "/tmp/spoofed.md" } }, findings[1]];
      expect(await write("disposition", 1, doc(forged))).toContain("invalid ralplan disposition artifact");
      const written = receipt(await write("disposition", 1, doc(findings)));
      expect(written.path).toBe(join(run(), "stage-01-disposition.md"));
      expect(JSON.parse(await readFile(written.path, "utf8")).conflicts[0].status).toBe("dispositioned");
      const final = receipt(await write("final", 1, "f"));
      const admission = { configuredTarget: "ultragoal", effectiveTarget: "ultragoal", degradationReason: null, source: "/cfg/open-gajae.jsonc" };
      expect(final.auto_handoff).toEqual(admission);
      expect((await lines(join(run(), "index.jsonl"))).at(-1).auto_handoff).toEqual(admission);
      expect((await json("state", "ralplan-state.json")).auto_handoff).toEqual(admission);
    },
    { autoHandoff: "ultragoal", source: { maxIterations: "default", maxReviewPassesPerLane: "default", autoHandoff: "/cfg/open-gajae.jsonc" } },
  );
});

test("state op checks the table, write only audits a skipped edge, a locked phase stays; audit rows (AC12, AC13)", async () => {
  await fixture(async ({ call, write, json, audit }) => {
    await call({ op: "start", task: "t" });
    expect(await call({ op: "state", patch: { current_phase: "final" } })).toBe("Error: invalid ralplan phase transition from planner to final");
    expect(await call({ op: "state", patch: { current_phase: "bogus" } })).toBe('Error: unknown ralplan phase "bogus"');
    await write("intent", 1, "i");
    await write("critic", 1, "c");
    expect((await json("state", "ralplan-state.json")).current_phase).toBe("critic");
    const invalid = (await audit()).filter((r) => r.verb === "invalid_transition_detected");
    expect(invalid.map((r) => [r.from_phase, r.to_phase])).toEqual([["intent", "critic"]]);
    await write("revision", 2, "r");
    await write("final", 2, "f");
    await write("revision", 3, "r3");
    expect((await json("state", "ralplan-state.json")).current_phase).toBe("final");
    await call({ op: "clear", force: true });
    const allowed = ["ts", "skill", "category", "verb", "owner", "mutation_id", "from_phase", "to_phase", "forced", "paths"];
    const rows = await audit();
    const kinds = new Set(rows.map((r) => `${r.category}:${r.verb}`));
    for (const row of rows) {
      expect(Object.keys(row).every((k) => allowed.includes(k))).toBe(true);
      expect(row).toMatchObject({ ts: expect.any(String), category: expect.any(String), verb: expect.any(String), owner: "open-gajae-runtime", mutation_id: expect.any(String), forced: expect.any(Boolean), paths: [expect.any(String)] });
    }
    expect(kinds).toEqual(
      new Set(["state:write", "state:write-active-entry", "state:rebuild-active-snapshot", "artifact:write", "ledger:append", "state:invalid_transition_detected", "state:clear", "state:remove-active-entry"]),
    );
  });
});

test("rows follow the stage just written, doctor reports drift, Stop here, clear, stale and corrupt states (AC14, AC24, DR-6, R-OD11)", async () => {
  await fixture(async ({ call, write, json, file, run, store }) => {
    await call({ op: "start", task: "t" });
    await write("planner", 1, "p");
    await write("intent", 1, "i");
    const row = await json("state", "active", "ralplan.json");
    expect(row.phase).toBe("intent");
    expect(row.hud.chips).toContainEqual({ label: "stages", value: "planner · intent", priority: 35 });
    expect(JSON.parse(await call({ op: "doctor" })).ok).toBe(true);
    await write("final", 1, "f");
    await write("revision", 2, "r");
    // R-OD8: after a post-final write the row and snapshot name `revision`, the state `final`.
    expect((await json("state", "active", "ralplan.json")).phase).toBe("revision");
    const drift = JSON.parse(await call({ op: "doctor" }));
    expect(drift.problems.filter((p: any) => p.type === "stale_active_state").map((p: any) => p.path).sort()).toEqual(
      [file("state", "active", "ralplan.json"), file("state", "skill-active-state.json")].sort(),
    );
    // R-OD11: an unforced clear refuses a stale state (row phase differs, then a terminal phase in R).
    expect(await call({ op: "clear" })).toBe(
      "Error: existing state for ralplan is stale (active-state phase revision differs from mode-state phase final); use force: true to clear",
    );
    // Stop here removes the row; a later refine write leaves the state inactive (phase locked).
    expect(JSON.parse(await call({ op: "state", patch: { active: false } }))).toMatchObject({ active: false, current_phase: "final" });
    expect(await Bun.file(file("state", "active", "ralplan.json")).exists()).toBe(false);
    expect((await json("state", "skill-active-state.json")).active).toBe(false);
    // Clear keeps the run and its files and drops the row.
    expect(JSON.parse(await call({ op: "clear" }))).toMatchObject({ active: false, current_phase: "complete" });
    expect(await json("state", "ralplan-state.json")).toMatchObject({ active: false, current_phase: "complete", run_id: ROOT });
    expect(await readdir(run())).toContain("stage-01-final.md");
    expect(await call({ op: "clear" })).toBe(
      "Error: existing state for ralplan is stale (mode-state is already terminal (complete)); use force: true to clear",
    );
    expect(JSON.parse(await call({ op: "clear", force: true })).current_phase).toBe("complete");
    // Corrupt and legacy states are schema violations; clear needs force.
    await writeFile(file("state", "ralplan-state.json"), "{");
    expect(JSON.parse(await call({ op: "doctor" })).summary.by_kind).toEqual({ schema_violation: 1, stale_active_state: 0 });
    expect(await call({ op: "clear" })).toContain("use force: true to overwrite");
    expect(JSON.parse(await call({ op: "clear", force: true })).current_phase).toBe("complete");
    await store.ralplanTransaction(ROOT, (tx) => tx.writeState({ active: true, current_phase: "ralplan" }, "ralplan_tool"));
    expect(JSON.parse(await call({ op: "doctor" })).problems[0]).toMatchObject({ type: "schema_violation", message: 'unknown ralplan phase "ralplan"' });
  });
});

test("status is gjc state read; write without start creates the run, a new run_id resets it, and runs beside ultragoal (P-AC4, P-AC11)", async () => {
  await fixture(async ({ call, write, json, file, store }) => {
    const empty = JSON.parse(await call({ op: "status" }));
    expect(Object.keys(empty).sort()).toEqual(["skill", "state", "storage_path"]);
    expect(empty).toEqual({ skill: "ralplan", state: {}, storage_path: file("state", "ralplan-state.json") });
    await runningUltragoal(store);
    await write("planner", 1, "p", {}, PLANNER);
    const { _meta, updated_at, ...created } = await json("state", "ralplan-state.json");
    expect(created).toEqual({ run_id: ROOT, skill: "ralplan", active: true, current_phase: "planner", version: 2, planner_subagent_id: "ses_planner" });
    expect(JSON.parse(await call({ op: "status", fields: ["current_phase", "run_id", "next"] }))).toEqual({ current_phase: "planner", run_id: ROOT, next: ["intent", "architect", "handoff"] });
    await call({ op: "state", patch: { last_review_verdict: "OKAY", last_review_verdict_lane: "critic", planning_stuck: { marker: "PLANNING-STUCK", reason: "r" }, auto_handoff: { configuredTarget: "off" } } });
    await write("planner", 1, "p2", { run_id: "run-2" });
    const switched = await json("state", "ralplan-state.json");
    expect(switched).toMatchObject({ run_id: "run-2", current_phase: "planner", active: true });
    for (const key of ["last_review_verdict", "last_review_verdict_lane", "planning_stuck", "auto_handoff"]) expect(switched).not.toHaveProperty(key);
  });
});

test("handoff needs a finished phase, demotes ralplan and confirms ultragoal with the meta; a failed seed leaves handoff (DR-7, P-AC7, R-O2)", async () => {
  await fixture(async ({ call, write, json, file, store }) => {
    await call({ op: "start", task: "t" });
    expect(await call({ op: "handoff", to: "ultragoal" })).toContain("only from a finished phase");
    await write("final", 1, "f");
    // A keyword's awaiting seed first: the handoff confirms it and merges the meta.
    await seedUltragoal(store, ROOT, { awaiting: true, task: "t" });
    expect(await call({ op: "handoff", to: "ultragoal" })).toContain("source_plan");
    const ralplan = await json("state", "ralplan-state.json");
    expect(ralplan).toMatchObject({ active: false, current_phase: "handoff", handoff_to: "ultragoal", handoff_at: expect.any(String) });
    expect(await Bun.file(file("state", "active", "ralplan.json")).exists()).toBe(false);
    expect(await store.read(ROOT, "ultragoal")).toMatchObject({ active: true, awaiting_confirmation: false, handoff_from: "ralplan", handoff_at: ralplan.handoff_at });
  });
  await fixture(async ({ call, write, json, file }) => {
    await call({ op: "start", task: "t" });
    await write("final", 1, "f");
    await mkdir(file("state"), { recursive: true });
    await writeFile(file("state", "ultragoal-state.json"), "{");
    expect(await call({ op: "handoff", to: "ultragoal" })).toContain("Call `ultragoal start`");
    expect(await json("state", "ralplan-state.json")).toMatchObject({ active: false, current_phase: "handoff" });
  });
});

test("ultragoal entry gate: running ultragoal ①, refusal ③, handoff ④, stale row ⑤, legacy state ② (C-4)", async () => {
  await fixture(async ({ call, write, file, json, store }) => {
    await call({ op: "start", task: "t" });
    await runningUltragoal(store);
    const before = await readFile(file("state", "ralplan-state.json"), "utf8");
    expect(await ultragoalEntryGate(store, ROOT)).toEqual({ status: "pass" });
    expect(await readFile(file("state", "ralplan-state.json"), "utf8")).toBe(before);
    await store.ultragoalTransaction(ROOT, (tx) => tx.deleteState());
    const refused = await ultragoalEntryGate(store, ROOT);
    expect(refused).toMatchObject({ status: "refused", message: expect.stringContaining('"Approve execution via ultragoal"') });
    await write("final", 1, "f");
    expect(await ultragoalEntryGate(store, ROOT)).toMatchObject({ status: "handoff", handoff_from: "ralplan", handoff_at: expect.any(String) });
    expect(await json("state", "ralplan-state.json")).toMatchObject({ active: false, current_phase: "handoff" });
    // ⑤: an inactive state with a row left by a refine write.
    await write("revision", 2, "r");
    expect(await json("state", "active", "ralplan.json")).toMatchObject({ active: true, phase: "revision" });
    expect(await ultragoalEntryGate(store, ROOT)).toEqual({ status: "pass" });
    expect(await Bun.file(file("state", "active", "ralplan.json")).exists()).toBe(false);
    await store.ralplanTransaction(ROOT, (tx) => tx.writeState({ active: true, current_phase: "ralplan" }, "ralplan_tool"));
    expect(await ultragoalEntryGate(store, ROOT)).toEqual({ status: "pass" });
  });
});

test("C-1.6: ralplan handoff, a gated ultragoal create and one continuation run together all settle (no deadlock)", async () => {
  await fixture(async ({ call, write, json, store, root }) => {
    await call({ op: "start", task: "t" });
    await write("final", 1, "f");
    const ultragoal = createTools(store, { locationDir: root, projectDir: root }, {
      async parentSession() {
        return undefined;
      },
    }).find((t) => t.name === "ultragoal")!;
    const hooks = createHooks(
      store,
      { get: async () => ({ location: { directory: root } }), synthetic: async () => ({}) },
      root,
      root,
      root,
    );
    const create = { op: "create", description: "task", goals: [{ title: "g", description: "d", priority: 1, acceptanceCriteria: ["works"] }] };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      Promise.allSettled([
        call({ op: "handoff", to: "ultragoal" }),
        ultragoal.execute(ultragoal.input.parse(create) as never, { agent: "open-gajae", sessionID: ROOT, signal: new AbortController().signal }),
        hooks.onEvent({ type: "session.execution.succeeded", data: { sessionID: ROOT } }),
      ]),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 5000);
      }),
    ]);
    clearTimeout(timer);
    expect(settled).not.toBe("timeout");
    expect(await json("state", "ralplan-state.json")).toMatchObject({ active: false, current_phase: "handoff" });
    expect(await store.read(ROOT, "ultragoal")).toMatchObject({ active: true, handoff_from: "ralplan" });
  });
});
