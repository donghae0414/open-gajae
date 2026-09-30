// The unwired `ultragoal` tool and store (plan S2): the R17 ops over a temp
// worktree and a fake lineage (root + one child), checked on the C-14 text
// lines (PQ-18 B) and the files they write. The `goal complete` guard is
// S2c's (`src/goal/tool.ts`).
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { goalCompleteGuard, readUltragoalGuardInput } from "../src/goal/tool";
import { StateStore } from "../src/state";
import {
  lastCriterionRefusal,
  OBJECTIVE_TOO_LONG,
  reopenHint,
  reviewBlockerCapRefusal,
  ultragoalGoalObjective,
} from "../src/ultragoal-runtime/messages";
import { CHECKPOINT_STATUSES, ULTRAGOAL_OPS, ultragoalTool } from "../src/ultragoal-runtime/tool";

const T0 = Date.parse("2026-09-30T00:00:00.000Z");
const ROOT = "ses_root";
const CHILD = "ses_child";
const LINEAGE: Record<string, string> = { [ROOT]: ROOT, [CHILD]: ROOT };
const RATIONALE = "the reviewed plan needs this change now";
const EVIDENCE = "the architect review found this gap in the plan";
const DONE = { implementation: ["did the work"], files_changed: ["src/x.ts"], learnings: ["a learning"] };
const PER_GOAL_REQUIRES =
  "checkpoint requires=targetedVerification:passed,architectReview:CLEAR+APPROVE,criteriaCoverage:all";
const FINAL_REQUIRES = `${PER_GOAL_REQUIRES},reviewCohort:joined,criticReview:OKAY`;

type Harness = {
  tool: ReturnType<typeof ultragoalTool>;
  call: (args: Record<string, unknown>, agent?: string, sessionID?: string) => Promise<string>;
  dir: string;
  objective: string;
  file: (...parts: string[]) => string;
  text: (...parts: string[]) => Promise<string | undefined>;
  json: (...parts: string[]) => Promise<any>;
  put: (text: string, ...parts: string[]) => Promise<void>;
  ledger: () => Promise<any[]>;
  audit: () => Promise<any[]>;
  guard: () => Promise<string | undefined>;
};

async function fixture(body: (h: Harness) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "open-gajae-ultragoal-tool-")));
  try {
    const store = new StateStore(root, async () => T0);
    const tool = ultragoalTool(store, {
      async rootSession(id) {
        if (!(id in LINEAGE)) throw new Error("unknown session");
        return LINEAGE[id];
      },
    });
    const dir = await store.resolveSessionDir(ROOT);
    const file = (...parts: string[]) => join(dir, ...parts);
    const text = async (...parts: string[]) => readFile(file(...parts), "utf8").catch(() => undefined);
    const lines = async (...parts: string[]) =>
      ((await text(...parts)) ?? "").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    await body({
      tool,
      call: async (args, agent = "open-gajae", sessionID = ROOT) =>
        (await tool.execute(tool.input.parse(args), { agent, sessionID, signal: new AbortController().signal }))
          .content,
      dir,
      objective: ultragoalGoalObjective(basename(dir)),
      file,
      text,
      json: async (...parts) => JSON.parse((await text(...parts))!),
      put: async (content, ...parts) => {
        await mkdir(dirname(file(...parts)), { recursive: true });
        await writeFile(file(...parts), content);
      },
      ledger: () => lines("ultragoal", "ledger.jsonl"),
      audit: () => lines("state", "audit.jsonl"),
      guard: () => store.workflowTransaction(ROOT, async (tx) => goalCompleteGuard(await readUltragoalGuardInput(tx))),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function goals(count: number, first = 1) {
  return Array.from({ length: count }, (_, index) => ({
    title: `Goal ${first + index}`,
    description: `do part ${first + index}`,
    acceptanceCriteria: [`part ${first + index} works`],
  }));
}

const create = (h: Harness, count: number) => h.call({ op: "create", description: "ship the feature", goals: goals(count) });

function perGoal(criterionIds: string[]): Record<string, unknown> {
  return {
    targetedVerification: { status: "passed", commands: ["bun test"], evidence: "all green" },
    architectReview: {
      architectureStatus: "CLEAR",
      productStatus: "CLEAR",
      codeStatus: "CLEAR",
      recommendation: "APPROVE",
      evidence: "reviewed the diff",
      blockers: [],
    },
    criteriaCoverage: criterionIds.map((criterionId) => ({ criterionId, status: "covered", evidence: "a test" })),
  };
}

function finalGate(criterionIds: string[], generation = 1): Record<string, unknown> {
  const lane = (status: string) => ({ status, evidence: "lane ran", blockers: [] });
  return {
    ...perGoal(criterionIds),
    reviewCohort: {
      reviewGeneration: generation,
      joined: true,
      ...(generation > 1 ? { deltaOnly: true, deltaPaths: ["src/x.ts"] } : {}),
      lanes: {
        cleaner: lane("PASS"),
        architect: lane("CLEAR"),
        qa: { ...lane("passed"), commands: ["bun test"], adversarialCases: ["empty input"] },
      },
    },
    criticReview: { verdict: "OKAY", evidence: "critic read it", blockers: [] },
  };
}

const complete = (h: Harness, goalId: string, gate: unknown, evidence = `verified ${goalId}`) =>
  h.call({ op: "checkpoint", goal_id: goalId, status: "complete", evidence, gate, ...DONE });

const steer = (h: Harness, args: Record<string, unknown>) => h.call({ rationale: RATIONALE, evidence: EVIDENCE, ...args });

const goalIds = async (h: Harness) => (await h.json("ultragoal", "goals.json")).goals.map((goal: any) => goal.id);
const goalRow = async (h: Harness, id: string) =>
  (await h.json("ultragoal", "goals.json")).goals.find((goal: any) => goal.id === id);

test("the op list is R17's, and checkpoint takes complete|failed|blocked|pending", async () => {
  await fixture(async ({ tool }) => {
    expect([...ULTRAGOAL_OPS]).toEqual([
      "status",
      "create",
      "next",
      "checkpoint",
      "validate_gate",
      "add",
      "revise",
      "supersede",
      "add_pattern",
      "record_review_blockers",
      "classify_blocker",
      "record_critic_verdict",
      "handoff",
      "doctor",
      "state",
      "clear",
    ]);
    for (const op of ULTRAGOAL_OPS) expect(tool.input.safeParse({ op }).success).toBe(true);
    for (const op of ["start", "resume", "cancel", "complete", "request_final_review", "record_verdict"])
      expect(tool.input.safeParse({ op }).success).toBe(false);
    expect([...CHECKPOINT_STATUSES]).toEqual(["complete", "failed", "blocked", "pending"]);
    for (const status of ["active", "review_blocked", "superseded"])
      expect(tool.input.safeParse({ op: "checkpoint", status }).success).toBe(false);
  });
});

test("the tool is open-gajae's alone and works on the lineage root", async () => {
  await fixture(async (h) => {
    expect(await h.call({ op: "status" }, "open-gajae-architect")).toBe(
      "Error: the ultragoal tool is not available to open-gajae-architect",
    );
    expect(await h.call({ op: "status" }, "open-gajae", "ses_unknown")).toBe(
      "Error: could not resolve the session lineage for ultragoal",
    );
    // A child session's op writes the root's run.
    expect(await h.call({ op: "create", description: "ship it", goals: goals(1) }, "open-gajae", CHILD)).toStartWith(
      "Created ultragoal plan with 1 goal at ",
    );
    expect(await goalIds(h)).toEqual(["G001"]);
    const sessions = await readdir(dirname(h.dir));
    expect(sessions.filter((name) => name.endsWith(CHILD))).toEqual([]);
  });
});

test("create: overwrites goals.json, appends plan_created and a PLAN note, arms the goal once, in C-7a order with audit rows", async () => {
  await fixture(async (h) => {
    const goalsPath = h.file("ultragoal", "goals.json");
    expect(await h.call({ op: "create", description: "ship v1", goals: goals(2) })).toBe(
      `Created ultragoal plan with 2 goals at ${goalsPath}.\nGoal armed: ${h.objective}`,
    );
    const armed = await h.json("state", "goal-state.json");
    expect(armed).toMatchObject({ version: 1, objective: h.objective, status: "active", source: "ultragoal" });
    // C-6/C-7a: goals.json → ledger → progress → goal state → reconcile (state, row, snapshot).
    const audit = await h.audit();
    expect(audit.map((row) => [row.category, row.verb, row.skill, basename(row.paths[0])])).toEqual([
      ["state", "write", "ultragoal", "goals.json"],
      ["ledger", "append", "ultragoal", "ledger.jsonl"],
      ["artifact", "write", "ultragoal", "progress.txt"],
      ["state", "write", "ultragoal", "goal-state.json"],
      ["state", "reconcile", "ultragoal", "ultragoal-state.json"],
      ["state", "write-active-entry", undefined, "ultragoal.json"],
      ["state", "rebuild-active-snapshot", undefined, "skill-active-state.json"],
    ]);
    expect(audit.every((row) => row.owner === "open-gajae-runtime")).toBe(true);
    expect(audit[4]).toMatchObject({ forced: true, to_phase: "pending" });
    expect(await h.json("state", "ultragoal-state.json")).toMatchObject({
      skill: "ultragoal",
      version: 2,
      active: true,
      current_phase: "pending",
      status: "pending",
      active_goal_id: "G001",
    });
    expect(await h.json("state", "active", "ultragoal.json")).toMatchObject({ active: true, phase: "pending" });

    // A second create overwrites the plan, appends to the ledger and log, keeps the goal.
    expect(await h.call({ op: "create", description: "ship v2", goals: goals(1, 3) })).toBe(
      `Created ultragoal plan with 1 goal at ${goalsPath}.\nGoal armed: the open ultragoal goal (active) already tracks this plan.`,
    );
    const plan = await h.json("ultragoal", "goals.json");
    expect([plan.description, plan.goals.map((goal: any) => goal.title)]).toEqual(["ship v2", ["Goal 3"]]);
    expect((await h.ledger()).map((row) => [row.event, row.goalIds, row.description])).toEqual([
      ["plan_created", ["G001", "G002"], "ship v1"],
      ["plan_created", ["G001"], "ship v2"],
    ]);
    const progress = (await h.text("ultragoal", "progress.txt"))!;
    expect(progress.match(/# Ultragoal Progress Log/g)?.length).toBe(1);
    expect(progress.match(/ - PLAN\n/g)?.length).toBe(2);
    expect(progress).toContain("- ship v1\n");
    expect(progress).toContain("- ship v2\n");
    expect(await h.json("state", "goal-state.json")).toEqual(armed);
  });
});

test("create does not arm over another open goal and says why (D-TL10); an exact-objective goal is kept", async () => {
  await fixture(async (h) => {
    const userGoal = (objective: string, status: string) =>
      JSON.stringify({
        version: 1,
        id: "g-user",
        objective,
        status,
        source: "user",
        created_at: "2026-09-30T00:00:00.000Z",
        updated_at: "2026-09-30T00:00:00.000Z",
      });
    await h.put(userGoal("a goal of the user", "paused"), "state", "goal-state.json");
    expect(await create(h, 1)).toEndWith(
      "\nGoal not armed: another goal is open (paused, source user). Run goal drop, then ultragoal create again to arm this plan's goal.",
    );
    expect(await h.json("state", "goal-state.json")).toMatchObject({ id: "g-user", source: "user" });
    expect(await goalIds(h)).toEqual(["G001"]);

    await h.put(userGoal(`  ${h.objective} `, "active"), "state", "goal-state.json");
    expect(await create(h, 1)).toEndWith("\nGoal armed: the open ultragoal goal (active) already tracks this plan.");

    await h.put(userGoal("a goal of the user", "dropped"), "state", "goal-state.json");
    expect(await create(h, 1)).toEndWith(`\nGoal armed: ${h.objective}`);
    expect(await h.json("state", "goal-state.json")).toMatchObject({ source: "ultragoal", status: "active" });
  });
});

test("plan changes take rationale, not reason; handoff keeps reason", async () => {
  await fixture(async (h) => {
    await create(h, 2);
    expect(
      await h.call({
        op: "add",
        target: "goal",
        title: "Goal 3",
        description: "do part 3",
        acceptanceCriteria: ["part 3 works"],
        reason: RATIONALE,
        evidence: EVIDENCE,
      }),
    ).toBe("Error: ultragoal add takes rationale, not reason (reason is for handoff)");
    expect(await h.call({ op: "revise", target: "goal", goal_id: "G002", title: "x", evidence: EVIDENCE })).toBe(
      "Error: rationale must be a non-empty string",
    );
    expect(await steer(h, { op: "supersede", target: "goal", goal_id: "G002", rationale: "too short" })).toBe(
      "Error: rationale must be substantive: at least 5 words and 32 characters",
    );
  });
});

test("add(after) inserts a goal; revise(after) moves only a pending goal", async () => {
  await fixture(async (h) => {
    await create(h, 3);
    expect(
      await steer(h, {
        op: "add",
        target: "goal",
        title: "Goal 4",
        description: "do part 4",
        acceptanceCriteria: ["part 4 works"],
        after: "G001",
      }),
    ).toBe("Accepted add steering. target=G004");
    expect(await goalIds(h)).toEqual(["G001", "G004", "G002", "G003"]);
    expect(await steer(h, { op: "revise", target: "goal", goal_id: "G003", after: "G001" })).toBe(
      "Accepted revise steering. target=G003",
    );
    expect(await goalIds(h)).toEqual(["G001", "G003", "G004", "G002"]);
    const steering = (await h.ledger()).filter((row) => row.event === "steering_accepted");
    expect(steering.map((row) => [row.kind, row.target, row.goalId, row.after, row.rationale, row.evidence])).toEqual([
      ["add", "goal", "G004", "G001", RATIONALE, EVIDENCE],
      ["revise", "goal", "G003", "G001", RATIONALE, EVIDENCE],
    ]);
    expect((await goalRow(h, "G004")).amendments).toEqual([steering[0].amendment]);
    expect(steering[0].amendment).toMatchObject({ target: "goal", kind: "added", after: "G001" });

    await h.call({ op: "next" });
    expect(await steer(h, { op: "revise", target: "goal", goal_id: "G001", after: "G002" })).toBe(
      `Error: ultragoal revise (goal) requires goal G001 status pending; found active. ${reopenHint("G001")}`,
    );
  });
});

test("criteria are named by criterion_id; a revision gets a new ID and retired IDs are never reused (PQ-22 A)", async () => {
  await fixture(async (h) => {
    await h.call({
      op: "create",
      description: "ship it",
      goals: [{ title: "Goal 1", description: "do part 1", acceptanceCriteria: ["part 1 works", "part 1 is fast"] }],
    });
    expect(
      await steer(h, {
        op: "revise",
        target: "criterion",
        goal_id: "G001",
        criterion_id: "G001.AC1",
        criterion: "part 1 works on empty input",
      }),
    ).toBe("Accepted revise steering. target=G001.AC3");
    const goal = await goalRow(h, "G001");
    expect(goal.acceptanceCriteria).toEqual([
      { id: "G001.AC3", text: "part 1 works on empty input" },
      { id: "G001.AC2", text: "part 1 is fast" },
    ]);
    expect(goal.amendments[0]).toMatchObject({
      target: "criterion",
      kind: "revised",
      criterionId: "G001.AC1",
      replacementId: "G001.AC3",
      original: "part 1 works",
    });
    expect(
      await steer(h, { op: "revise", target: "criterion", goal_id: "G001", criterion_id: "G001.AC1", criterion: "x" }),
    ).toBe("Error: G001.AC1 is not an active criterion of G001");
    expect(await steer(h, { op: "supersede", target: "criterion", goal_id: "G001", criterion_id: "G001.AC2" })).toBe(
      "Accepted supersede steering. target=G001.AC2",
    );
    expect(await steer(h, { op: "supersede", target: "criterion", goal_id: "G001", criterion_id: "G001.AC3" })).toBe(
      `Error: ${lastCriterionRefusal("G001")}`,
    );
    expect(await steer(h, { op: "add", target: "criterion", goal_id: "G001", criterion: "part 1 has docs" })).toBe(
      "Accepted add steering. target=G001.AC4",
    );
  });
});

test("completed goal refuses revise and supersede; reopen with checkpoint(pending), revise, re-verify", async () => {
  await fixture(async (h) => {
    await create(h, 1);
    await h.call({ op: "next" });
    expect(await complete(h, "G001", finalGate(["G001.AC1"]))).toBe(
      "Checkpointed G001 as complete.\nAll ultragoal goals are complete.",
    );
    const first = (await goalRow(h, "G001")).completionVerification;
    const plan = await h.text("ultragoal", "goals.json");
    const refused = (op: string, target: string, allowed: string) =>
      `Error: ultragoal ${op} (${target}) requires goal G001 status ${allowed}; found complete. ${reopenHint("G001")}`;
    expect(await steer(h, { op: "revise", target: "goal", goal_id: "G001", title: "Goal one" })).toBe(
      refused("revise", "goal", "pending"),
    );
    expect(await steer(h, { op: "supersede", target: "goal", goal_id: "G001" })).toBe(
      refused("supersede", "goal", "pending or blocked or review_blocked"),
    );
    expect(
      await steer(h, { op: "revise", target: "criterion", goal_id: "G001", criterion_id: "G001.AC1", criterion: "x y" }),
    ).toBe(refused("revise", "criterion", "pending"));
    expect(await steer(h, { op: "supersede", target: "criterion", goal_id: "G001", criterion_id: "G001.AC1" })).toBe(
      refused("supersede", "criterion", "pending"),
    );
    expect(await steer(h, { op: "add", target: "criterion", goal_id: "G001", criterion: "part 1 has docs" })).toBe(
      refused("add", "criterion", "pending"),
    );
    expect(await h.text("ultragoal", "goals.json")).toBe(plan);

    expect(
      await h.call({ op: "checkpoint", goal_id: "G001", status: "pending", evidence: "empty input must be handled" }),
    ).toBe("Checkpointed G001 as pending.\nReopened G001; revise it, then run ultragoal next and checkpoint it again.");
    const reopened = await h.call({ op: "status" });
    expect(reopened).toContain("- run_complete: no (required goals not complete: G001 (pending))");
    expect(reopened).toContain("- G001 [pending] Goal 1 — receipt: valid"); // IQ-2 A: the old receipt as is
    expect(
      await steer(h, {
        op: "revise",
        target: "criterion",
        goal_id: "G001",
        criterion_id: "G001.AC1",
        criterion: "part 1 works on empty input",
      }),
    ).toBe("Accepted revise steering. target=G001.AC2");
    expect(await h.call({ op: "status" })).toContain("- G001 [pending] Goal 1 — receipt: stale");
    expect(await h.call({ op: "next" })).toBe(
      [
        "ultragoal next-action=execute-goal goal-id=G001",
        "objective=do part 1",
        `goal-objective=${h.objective}`,
        FINAL_REQUIRES,
        "criteria=G001.AC2",
      ].join("\n"),
    );
    expect(await complete(h, "G001", finalGate(["G001.AC2"]), "verified G001 again")).toBe(
      "Checkpointed G001 as complete.\nAll ultragoal goals are complete.",
    );
    const second = (await goalRow(h, "G001")).completionVerification;
    expect(second.receiptKind).toBe("final-aggregate");
    expect(second.receiptId).not.toBe(first.receiptId);
    expect(second.criteriaRevision).not.toBe(first.criteriaRevision);
    const done = await h.call({ op: "status" });
    expect(done).toContain("- run_complete: yes");
    expect(done).toContain("- G001 [complete] Goal 1 — receipt: valid");
  });
});

test("tampered complete is not run-complete", async () => {
  await fixture(async (h) => {
    await create(h, 2);
    await h.call({ op: "next" });
    const plan = await h.json("ultragoal", "goals.json");
    for (const goal of plan.goals) goal.status = "complete";
    await h.put(JSON.stringify(plan), "ultragoal", "goals.json");
    const status = await h.call({ op: "status" });
    expect(status).toContain("- status: complete");
    expect(status).toContain("- run_complete: no (G001 has no completion receipt)");
    // DR-1: the phase and row follow the file statuses; the guard does not.
    expect(await h.json("state", "ultragoal-state.json")).toMatchObject({ active: false, current_phase: "complete" });
    expect(await h.text("state", "active", "ultragoal.json")).toBeUndefined();
    expect(await h.guard()).toContain("Reopen G001");
    expect(await h.call({ op: "checkpoint", goal_id: "G001", status: "pending", evidence: "tampered status" })).toBe(
      "Checkpointed G001 as pending.\nReopened G001; revise it, then run ultragoal next and checkpoint it again.",
    );
    expect(await h.json("state", "active", "ultragoal.json")).toMatchObject({ active: true, phase: "pending" });
  });
});

test("next starts the next goal once; retry_failed takes a failed goal before pending ones (PQ-19 B)", async () => {
  await fixture(async (h) => {
    await create(h, 3);
    const g1 = [
      "ultragoal next-action=execute-goal goal-id=G001",
      "objective=do part 1",
      `goal-objective=${h.objective}`,
      PER_GOAL_REQUIRES,
      "criteria=G001.AC1",
    ].join("\n");
    expect(await h.call({ op: "next" })).toBe(g1);
    expect(await h.call({ op: "next" })).toBe(g1);
    expect((await h.ledger()).filter((row) => row.event === "goal_started")).toHaveLength(1);
    expect(await h.call({ op: "checkpoint", goal_id: "G001", status: "failed", evidence: "the architect found a bug" })).toBe(
      "Checkpointed G001 as failed.\nResume failed goals with `ultragoal next(retry_failed: true)` after the blocker is fixed.",
    );
    expect(await h.call({ op: "next", retry_failed: true })).toStartWith(
      "ultragoal next-action=execute-goal goal-id=G001\n",
    );
    await h.call({ op: "checkpoint", goal_id: "G001", status: "failed", evidence: "still broken after the retry" });
    expect(await h.call({ op: "next" })).toStartWith("ultragoal next-action=execute-goal goal-id=G002\n");
  });
});

test("checkpoint refusals write nothing; a bad gate is the diagnostic list", async () => {
  await fixture(async (h) => {
    await create(h, 2);
    await h.call({ op: "next" });
    const before = [await h.text("ultragoal", "goals.json"), await h.text("ultragoal", "ledger.jsonl")];
    const gate = perGoal(["G001.AC1"]);
    expect(await complete(h, "G009", gate)).toBe("Error: No ultragoal goal found for G009.");
    expect(await complete(h, "G001", gate, "  ")).toBe("Error: checkpoint evidence is required");
    expect(await complete(h, "G002", gate)).toBe(
      "Error: Cannot checkpoint G002 as complete while its durable goals.json status is pending; start the goal before completing it.",
    );
    expect(
      await complete(h, "G001", {
        targetedVerification: { status: "failed", commands: [], evidence: "x" },
        criteriaCoverage: [],
      }),
    ).toBe(
      [
        "Error: 4 quality-gate error(s):",
        "  qualityGate [missing_required_sections]: qualityGate requires architectReview objects",
        "  targetedVerification.status [targeted_verification_not_passed]: qualityGate targetedVerification.status must be passed",
        "  targetedVerification.commands [missing_command_array]: qualityGate targetedVerification.commands must be a non-empty string array",
        "  criteriaCoverage [criteria_coverage_invalid]: qualityGate criteriaCoverage must be a non-empty object array",
      ].join("\n"),
    );
    expect(await h.call({ op: "checkpoint", goal_id: "G001", status: "complete", evidence: "done", ...DONE })).toBe(
      "Error: complete checkpoints require gate with targetedVerification, architectReview and criteriaCoverage evidence",
    );
    expect(
      await h.call({ op: "checkpoint", goal_id: "G001", status: "complete", evidence: "done", gate, learnings: ["x"] }),
    ).toBe("Error: implementation needs at least one item");
    expect([await h.text("ultragoal", "goals.json"), await h.text("ultragoal", "ledger.jsonl")]).toEqual(before);
  });
});

test("validate_gate judges like checkpoint and writes nothing", async () => {
  await fixture(async (h) => {
    await create(h, 2);
    await h.call({ op: "next" });
    const files = async () =>
      Promise.all(
        [
          ["ultragoal", "goals.json"],
          ["ultragoal", "ledger.jsonl"],
          ["state", "ultragoal-state.json"],
          ["state", "active", "ultragoal.json"],
          ["state", "audit.jsonl"],
        ].map((parts) => h.text(...parts)),
      );
    const before = await files();
    const gate = perGoal(["G001.AC1"]);
    expect(await h.call({ op: "validate_gate", gate, goal_id: "G001" })).toBe("quality gate is valid.");
    expect(await h.call({ op: "validate_gate", gate })).toBe("quality gate is valid."); // the first schedulable goal
    expect(await h.call({ op: "validate_gate", gate, goal_id: "G009" })).toBe(
      "1 quality-gate error(s):\n  goalId [unknown_goal]: Unknown ultragoal goal G009",
    );
    expect(await h.call({ op: "validate_gate", gate, goal_id: "G002" })).toBe(
      [
        "2 quality-gate error(s):",
        "  criteriaCoverage[0].criterionId [unknown_criterion]: qualityGate criteriaCoverage references unknown id G001.AC1",
        "  criteriaCoverage [missing_criterion]: qualityGate criteriaCoverage is missing active criterion G002.AC1",
      ].join("\n"),
    );
    expect(await files()).toEqual(before);
  });
});

test("record_review_blockers: one auto criterion, default title, dedup on trimmed objective + blockedGoalId, length and cap", async () => {
  await fixture(async (h) => {
    await create(h, 1);
    await h.call({ op: "next" });
    const record = (objective: string) =>
      h.call({ op: "record_review_blockers", goal_id: "G001", objective, evidence: "the cohort found a crash" });
    expect(await record("  handle the empty input  ")).toBe("Recorded review blockers. blocker-goal-id=G002");
    expect(await goalRow(h, "G001")).toMatchObject({ status: "review_blocked", evidence: "the cohort found a crash" });
    expect(await goalRow(h, "G002")).toMatchObject({
      title: "Resolve final code-review blockers",
      description: "handle the empty input",
      status: "pending",
      acceptanceCriteria: [{ id: "G002.AC1", text: "handle the empty input is resolved and re-verified" }],
      steering: { kind: "review_blocker", blockedGoalId: "G001" },
    });
    const ledger = await h.ledger();
    expect(ledger.slice(-2).map((row) => [row.event, row.goalId, row.status, row.blockerGoalId])).toEqual([
      ["goal_checkpointed", "G001", "review_blocked", undefined],
      ["review_blockers_recorded", "G001", undefined, "G002"],
    ]);
    expect(await record("handle the empty input")).toBe("Recorded review blockers. blocker-goal-id=G002");
    expect(await h.ledger()).toHaveLength(ledger.length);
    expect(await goalIds(h)).toEqual(["G001", "G002"]);
    expect(await record("x".repeat(1973))).toBe(`Error: ${OBJECTIVE_TOO_LONG}`);
    expect(await record("fix B")).toBe("Recorded review blockers. blocker-goal-id=G003");
    expect(await record("fix C")).toBe("Recorded review blockers. blocker-goal-id=G004");
    expect(await record("fix D")).toBe(`Error: ${reviewBlockerCapRefusal("G001", 3)}`);
  });
});

test("record_critic_verdict reports the non-OKAY streak and the hold; classify_blocker returns its event id", async () => {
  await fixture(async (h) => {
    await create(h, 1);
    const iterate = { op: "record_critic_verdict", terminus: "completion", verdict: "ITERATE", evidence: "gaps remain" };
    for (let count = 1; count <= 5; count++)
      expect(await h.call({ ...iterate, blockers: ["a gap"] })).toBe(
        `Recorded critic verdict: ITERATE (completion).\ncritic non-OKAY streak: ${count}/5${count === 5 ? " — continuation held" : ""}`,
      );
    expect(await h.call({ ...iterate, verdict: "OKAY", blockers: ["a gap"] })).toBe(
      "Error: OKAY critic verdict must have empty blockers",
    );
    expect(await h.call({ ...iterate, terminus: "pause", verdict: "OKAY" })).toBe(
      "Error: record_critic_verdict classification_event_id is required for pause verdicts",
    );
    const classified = await h.call({ op: "classify_blocker", classification: "human_blocked", evidence: "needs a key" });
    const eventId = /^Recorded blocker classification: human_blocked event-id=(\S+)\.$/.exec(classified)?.[1];
    expect(eventId).toBe((await h.ledger()).at(-1).eventId);
    expect(
      await h.call({ ...iterate, terminus: "pause", verdict: "OKAY", classification_event_id: eventId }),
    ).toBe("Recorded critic verdict: OKAY (pause).\ncritic non-OKAY streak: 0/5");
  });
});

for (const to of ["ralplan", "deep-interview"] as const)
  test(`handoff to ${to}: journaled merge, goal untouched, HANDOFF note, JSON receipt (AC28)`, async () => {
    await fixture(async (h) => {
      await create(h, 1);
      await h.call({ op: "next" });
      const goal = await h.text("state", "goal-state.json");
      const initial = to === "ralplan" ? "planner" : "deep-interview";
      const receipt = JSON.parse(await h.call({ op: "handoff", to, reason: "the plan needs a new design" }));
      expect(receipt).toMatchObject({ ok: true, from: "ultragoal", to, phases: { from: "handoff", to: initial } });
      expect(await h.json("state", "ultragoal-state.json")).toMatchObject({
        active: false,
        current_phase: "handoff",
        handoff_to: to,
        goals_path: h.file("ultragoal", "goals.json"),
      });
      expect(await h.json("state", `${to}-state.json`)).toMatchObject({
        active: true,
        current_phase: initial,
        handoff_from: "ultragoal",
      });
      expect(await h.json("state", "active", "ultragoal.json")).toMatchObject({
        active: false,
        phase: "handoff",
        handoff_to: to,
      });
      const calleeRow = await h.text("state", "active", `${to}.json`);
      if (to === "ralplan") expect(JSON.parse(calleeRow!)).toMatchObject({ active: true, phase: "planner" });
      else expect(calleeRow).toBeUndefined();
      expect(await h.text("state", "goal-state.json")).toBe(goal);
      expect((await h.ledger()).at(-1)).toMatchObject({
        event: "workflow_handoff",
        to,
        reason: "the plan needs a new design",
      });
      const progress = (await h.text("ultragoal", "progress.txt"))!;
      expect(progress).toContain(" - HANDOFF\n");
      expect(progress).toContain(`- to ${to}: the plan needs a new design\n`);
      expect(await readdir(h.file("state", "transactions")).catch(() => [])).toEqual([]);
    });
  });

test("doctor, state (open patch) and clear(force)", async () => {
  await fixture(async (h) => {
    await create(h, 1);
    await h.call({ op: "next" });
    const stateDir = h.file("state");
    expect(await h.call({ op: "doctor" })).toBe(
      [
        "ok: true",
        `root: ${stateDir}`,
        "skills_scanned: 1",
        "files_scanned: 3",
        "findings_total: 0",
        "counts: schema_violation=0, stale_active_state=0",
        "",
      ].join("\n"),
    );
    const patched = JSON.parse(await h.call({ op: "state", patch: { note: "keep this", current_phase: "blocked" } }));
    expect(patched).toMatchObject({ ok: true, skill: "ultragoal", current_phase: "blocked", active: true });
    expect(await h.json("state", "ultragoal-state.json")).toMatchObject({ note: "keep this", current_phase: "blocked" });
    expect(await h.json("state", "active", "ultragoal.json")).toMatchObject({ phase: "blocked" });
    expect(await h.call({ op: "state", patch: { goals: [] } })).toBe(
      "Error: state patch cannot set derived ultragoal field(s): goals; the next ultragoal op rewrites them from goals.json and the ledger",
    );
    expect(await h.call({ op: "state", patch: { current_phase: "goal-planning" } })).toBe(
      "Error: invalid ultragoal phase transition from blocked to goal-planning",
    );
    expect(await h.call({ op: "state", patch: { current_phase: "bogus" } })).toBe(
      'Error: unknown ultragoal phase "bogus"',
    );
    await h.call({ op: "state", patch: { note: null } });
    expect((await h.json("state", "ultragoal-state.json")).note).toBeUndefined();

    await h.put("{", "state", "ultragoal-state.json");
    const doctor = await h.call({ op: "doctor" });
    expect(doctor).toStartWith("ok: false\n");
    expect(doctor).toContain("finding: kind=schema_violation skill=ultragoal");
    expect(doctor).toContain("fix=ultragoal clear (force: true)");
    expect(await h.call({ op: "clear" })).toStartWith("Error: existing state for ultragoal is corrupt or tampered (");
    const [receipt, notice] = (await h.call({ op: "clear", force: true })).split("\n");
    expect(JSON.parse(receipt)).toMatchObject({ ok: true, skill: "ultragoal", active: false, current_phase: "complete" });
    expect(notice).toBe("The goal is still active; run goal drop to end it.");
    expect(await h.json("state", "ultragoal-state.json")).toMatchObject({
      skill: "ultragoal",
      active: false,
      current_phase: "complete",
      version: 2,
    });
    expect(await h.text("state", "active", "ultragoal.json")).toBeUndefined();
    expect(await h.json("state", "goal-state.json")).toMatchObject({ status: "active" });
    expect(await h.call({ op: "clear" })).toBe(
      "Error: existing state for ultragoal is stale (mode-state is already terminal (complete)); use force: true to clear",
    );
    expect(await h.call({ op: "doctor" })).toStartWith("ok: true\n");
  });
});

test("add_pattern leaves the row", async () => {
  await fixture(async (h) => {
    await create(h, 1);
    await h.call({ op: "next" });
    const before = [await h.text("state", "ultragoal-state.json"), await h.text("state", "active", "ultragoal.json")];
    expect(await h.call({ op: "add_pattern", pattern: "tests live under tests/" })).toBe(
      "Pattern added to progress.txt.",
    );
    expect([await h.text("state", "ultragoal-state.json"), await h.text("state", "active", "ultragoal.json")]).toEqual(
      before,
    );
    expect(await h.text("ultragoal", "progress.txt")).toContain("## Codebase Patterns\n\n- tests live under tests/\n");
    expect((await h.audit()).at(-1)).toMatchObject({ category: "artifact", verb: "write" });
  });
});

test("E-15: a same-status, same-evidence replay writes nothing; a status mismatch is not a replay", async () => {
  await fixture(async (h) => {
    await create(h, 2);
    await h.call({ op: "next" });
    const next = [
      "Next ultragoal goal: G002 — Goal 2",
      "Objective: do part 2",
      `Goal objective: ${h.objective}`,
      "Criteria: G002.AC1",
    ];
    expect(await complete(h, "G001", perGoal(["G001.AC1"]))).toBe(
      [
        "Checkpointed G001 as complete.",
        ...next,
        "The next ultragoal goal is active; continue the current aggregate goal and checkpoint this goal when verified.",
      ].join("\n"),
    );
    const plan = await h.text("ultragoal", "goals.json");
    const rows = (await h.ledger()).length;
    expect(await complete(h, "G001", perGoal(["G001.AC1"]))).toBe(
      ["Checkpointed G001 as complete.", ...next, "Run `ultragoal next` to activate the next ultragoal goal."].join("\n"),
    );
    expect([await h.text("ultragoal", "goals.json"), (await h.ledger()).length]).toEqual([plan, rows]);
    expect(await complete(h, "G001", perGoal(["G001.AC1"]), "other evidence")).toBe(
      "Error: Cannot checkpoint G001 as complete with different evidence because its durable goals.json status is already complete.",
    );

    const fail = () => h.call({ op: "checkpoint", goal_id: "G002", status: "failed", evidence: "the qa lane failed" });
    await fail();
    await fail();
    expect(await h.ledger()).toHaveLength(rows + 1);
    await h.call({ op: "next", retry_failed: true });
    await fail();
    expect(await h.ledger()).toHaveLength(rows + 3);
  });
});

test("fix goal closes the run through the final gate", async () => {
  await fixture(async (h) => {
    // 1. G1 per-goal
    await create(h, 2);
    await h.call({ op: "next" });
    await complete(h, "G001", perGoal(["G001.AC1"]));
    expect((await goalRow(h, "G001")).completionVerification.receiptKind).toBe("per-goal");
    // 2. G2's final cohort does not pass
    const failing = finalGate(["G002.AC1"]) as any;
    failing.reviewCohort.lanes.qa.status = "failed";
    expect(await complete(h, "G002", failing)).toStartWith("Error: 1 quality-gate error(s):\n");
    // 3.
    expect(
      await h.call({
        op: "record_review_blockers",
        goal_id: "G002",
        objective: "fix the empty-input crash",
        evidence: "the qa lane crashed on empty input",
      }),
    ).toBe("Recorded review blockers. blocker-goal-id=G003");
    // 4. the fix goal has one criterion and needs the final gate
    expect(await h.call({ op: "next" })).toBe(
      [
        "ultragoal next-action=execute-goal goal-id=G003",
        "objective=fix the empty-input crash",
        `goal-objective=${h.objective}`,
        FINAL_REQUIRES,
        "criteria=G003.AC1",
      ].join("\n"),
    );
    // 5. a per-goal gate is refused
    const cohortErrors = [
      "2 quality-gate error(s):",
      "  reviewCohort [review_cohort_invalid]: qualityGate reviewCohort is required at the review boundary",
      "  criticReview.verdict [critic_verdict_not_okay]: checkpoint(status: complete) (final aggregate) requires criticReview with verdict OKAY, non-empty evidence, and empty blockers",
    ].join("\n");
    expect(await complete(h, "G003", perGoal(["G003.AC1"]))).toBe(`Error: ${cohortErrors}`);
    // 6. validate_gate judges it final too
    expect(await h.call({ op: "validate_gate", gate: perGoal(["G003.AC1"]), goal_id: "G003" })).toBe(cohortErrors);
    // 7. the second-generation final gate passes
    expect(await complete(h, "G003", finalGate(["G003.AC1"], 2))).toBe(
      "Checkpointed G003 as complete.\nAll ultragoal goals are complete.",
    );
    // 8. G2 superseded, G3 final, run complete, row gone
    expect(await goalRow(h, "G002")).toMatchObject({
      status: "superseded",
      evidence: "Resolved by verification blocker goal G003: verified G003",
    });
    expect((await goalRow(h, "G003")).completionVerification.receiptKind).toBe("final-aggregate");
    expect(await h.call({ op: "status" })).toContain("- run_complete: yes");
    expect(await h.text("state", "active", "ultragoal.json")).toBeUndefined();
    // 9. goal complete is allowed
    expect(await h.guard()).toBeUndefined();
  });
});

/** G1 complete (per-goal); G2 review-blocked by fix goal G3, itself review-blocked by fix goal G4. */
async function fixOfAFix(h: Harness) {
  await create(h, 2);
  await h.call({ op: "next" });
  await complete(h, "G001", perGoal(["G001.AC1"]));
  const block = (goalId: string, objective: string) =>
    h.call({ op: "record_review_blockers", goal_id: goalId, objective, evidence: `review of ${goalId} failed` });
  expect(await block("G002", "fix the first finding")).toBe("Recorded review blockers. blocker-goal-id=G003");
  await h.call({ op: "next" });
  expect(await block("G003", "fix the finding of the fix")).toBe("Recorded review blockers. blocker-goal-id=G004");
}

test("fix-of-a-fix chain: supersede the root before the last fix completes", async () => {
  await fixture(async (h) => {
    await fixOfAFix(h);
    expect(await steer(h, { op: "supersede", target: "goal", goal_id: "G002" })).toBe(
      "Accepted supersede steering. target=G002",
    );
    expect(await h.call({ op: "next" })).toContain(`\n${FINAL_REQUIRES}\n`);
    expect(await complete(h, "G004", finalGate(["G004.AC1"], 2))).toBe(
      "Checkpointed G004 as complete.\nAll ultragoal goals are complete.",
    );
    expect((await goalRow(h, "G003")).status).toBe("superseded");
    expect((await goalRow(h, "G004")).completionVerification.receiptKind).toBe("final-aggregate");
    expect(await h.call({ op: "status" })).toContain("- run_complete: yes");
    expect(await h.guard()).toBeUndefined();
  });
});

test("late root supersede: reopen the last completed goal", async () => {
  await fixture(async (h) => {
    await fixOfAFix(h);
    expect(await h.call({ op: "next" })).toContain(`\n${PER_GOAL_REQUIRES}\n`);
    expect(await complete(h, "G004", perGoal(["G004.AC1"]))).toBe("Checkpointed G004 as complete.");
    await steer(h, { op: "supersede", target: "goal", goal_id: "G002" });
    const reason = "last completed goal G004 has no valid final-aggregate receipt";
    expect(await h.call({ op: "status" })).toContain(`- run_complete: no (${reason})`);
    expect(await h.guard()).toContain("Reopen G004");
    expect(await h.call({ op: "next" })).toBe(
      [
        "ultragoal complete all=true",
        `run-complete=no reason=${reason}`,
        "hint=reopen G004 with ultragoal checkpoint(status: pending) and re-verify with the final gate",
      ].join("\n"),
    );
    await h.call({ op: "checkpoint", goal_id: "G004", status: "pending", evidence: "the run needs a final receipt" });
    expect(await h.call({ op: "next" })).toContain(`\n${FINAL_REQUIRES}\n`);
    expect(await complete(h, "G004", finalGate(["G004.AC1"], 2), "re-verified G004")).toBe(
      "Checkpointed G004 as complete.\nAll ultragoal goals are complete.",
    );
    expect(await h.call({ op: "status" })).toContain("- run_complete: yes");
    expect(await h.guard()).toBeUndefined();
  });
});

test("add after final keeps the old final as a per-goal completion", async () => {
  await fixture(async (h) => {
    await create(h, 3);
    await h.call({ op: "next" });
    await complete(h, "G001", perGoal(["G001.AC1"]));
    await complete(h, "G002", perGoal(["G002.AC1"]));
    await complete(h, "G003", finalGate(["G003.AC1"]));
    expect(await h.call({ op: "status" })).toContain("- run_complete: yes");
    await steer(h, {
      op: "add",
      target: "goal",
      title: "Goal 4",
      description: "do part 4",
      acceptanceCriteria: ["part 4 works"],
    });
    const grown = await h.call({ op: "status" });
    expect(grown).toContain("- G003 [complete] Goal 3 — receipt: per-goal(superseded final)");
    expect(grown).toContain("- run_complete: no (required goals not complete: G004 (pending))");
    expect(await h.call({ op: "next" })).toContain(`\n${FINAL_REQUIRES}\n`);
    await complete(h, "G004", finalGate(["G004.AC1"]));
    const done = await h.call({ op: "status" });
    expect(done).toContain("- G003 [complete] Goal 3 — receipt: per-goal(superseded final)");
    expect(done).toContain("- G004 [complete] Goal 4 — receipt: valid");
    expect(done).toContain("- run_complete: yes");
  });
});

test("a reconcile failure keeps the op's result and appends gjc's reconcile_failed ledger row", async () => {
  await fixture(async (h) => {
    await create(h, 1);
    await h.put("{not json", "state", "active", "other.json");
    expect(await h.call({ op: "status" })).toStartWith("# ultragoal status\n");
    const last = (await h.ledger()).at(-1);
    expect(last).toMatchObject({ type: "reconcile_failed" });
    expect(typeof last.error).toBe("string");
    expect((await h.audit()).at(-1)).toMatchObject({ category: "ledger", verb: "append" });
  });
});
