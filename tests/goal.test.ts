// `goal` (plan S2): the goal-state transitions and texts (DR-9), the ultragoal
// guards of `complete` and `pause` (DR-10, DR-11), and the tool over a real
// store with a fake lineage (guard-first order, actor, root owner).
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPLETE_BLOCKED_OR_FAILED,
  COMPLETE_REVIEW_BLOCKED,
  completeIncompleteGoals,
  GOAL_ALREADY_COMPLETE,
  GOAL_ALREADY_EXISTS,
  goalContextText,
  goalContinuationText,
  NO_GOAL_TO_COMPLETE,
  NO_PAUSED_GOAL,
  OBJECTIVE_IS_COMMAND,
  OBJECTIVE_REQUIRED,
  PAUSE_NEEDS_CRITIC_OKAY,
  PAUSE_NEEDS_HUMAN_BLOCKED,
  pauseNotActive,
  pauseStateUnverifiable,
  RESUME_COMPLETE_GOAL,
  ULTRAGOAL_PLAN_MISSING,
} from "../src/goal/messages";
import {
  completeGoalState,
  continuationForGoal,
  createGoalState,
  dropGoalState,
  type GoalState,
  parseGoalContinuation,
  parseGoalState,
  pauseGoalState,
  resumeGoalState,
  visibleGoal,
} from "../src/goal/state";
import { goalCompleteGuard, goalPauseGuard, goalTool, type UltragoalGuardInput } from "../src/goal/tool";
import { StateStore } from "../src/state";
import {
  type LedgerEventFields,
  type LedgerRow,
  ledgerRow,
  parseLedger,
  serializeLedgerRow,
} from "../src/ultragoal-runtime/ledger";
import { buildGoalsFile, type GoalsFile, parseGoals, serializeGoals } from "../src/ultragoal-runtime/plan";
import { buildCompletionVerification, type ReceiptKind } from "../src/ultragoal-runtime/receipt";

const T = "2026-09-30T01:02:03.000Z";
const ROOT = "ses_root";
const LINEAGE: Record<string, string> = { [ROOT]: ROOT, ses_child: ROOT };

function plan(count: number): GoalsFile {
  return buildGoalsFile({
    description: "ship the feature",
    goals: Array.from({ length: count }, (_, index) => ({
      title: `Goal ${index + 1}`,
      description: `do part ${index + 1}`,
      acceptanceCriteria: [`part ${index + 1} works`],
    })),
    now: T,
  });
}

let seq = 0;
function push(rows: LedgerRow[], fields: LedgerEventFields): string {
  const eventId = `e${++seq}`;
  rows.push(ledgerRow(fields, { eventId, timestamp: T }));
  return eventId;
}

/** Checkpoint `id` complete with a receipt on the row and the ledger. */
function complete(file: GoalsFile, rows: LedgerRow[], id: string, kind: ReceiptKind): void {
  const target = file.goals.find((goal) => goal.id === id)!;
  const gate = { criticReview: { verdict: "OKAY" } };
  const eventId = `cp-${++seq}`;
  const receipt = buildCompletionVerification({
    receiptKind: kind,
    criteria: target.acceptanceCriteria,
    gate,
    checkpointLedgerEventId: eventId,
    verifiedAt: T,
    receiptId: `r-${eventId}`,
  });
  target.status = "complete";
  target.completionVerification = receipt;
  rows.push(
    ledgerRow(
      { event: "goal_checkpointed", goalId: id, status: "complete", evidence: "done", qualityGateJson: gate, completionVerification: receipt },
      { eventId, timestamp: T },
    ),
  );
}

function guardInput(file: GoalsFile | undefined, rows: LedgerRow[] = []): UltragoalGuardInput {
  return {
    goals: parseGoals(file ? serializeGoals(file) : undefined),
    ledger: parseLedger(rows.map(serializeLedgerRow).join("\n")),
  };
}

function classify(rows: LedgerRow[], classification: "human_blocked" | "resolvable"): string {
  return push(rows, { event: "blocker_classified", classification, evidence: "needs the user's API key" });
}

function pauseVerdict(
  rows: LedgerRow[],
  classificationEventId: string,
  extra: Partial<{ verdict: "OKAY" | "ITERATE"; terminus: "pause" | "completion"; blockers: string[] }> = {},
) {
  push(rows, {
    event: "critic_verdict",
    terminus: extra.terminus ?? "pause",
    verdict: extra.verdict ?? "OKAY",
    evidence: "the critic confirmed the blocker is human-only",
    blockers: extra.blockers ?? [],
    classificationEventId,
  });
}

describe("goal state (pure)", () => {
  test("transitions follow gjc GoalRuntime, and a dropped goal is no goal (DR-9)", () => {
    const create = (existing: GoalState | undefined, objective = "Ship X") =>
      createGoalState(existing, { id: "g1", objective, source: "user", now: T });
    const goal = create(undefined, "  Ship X  ");
    expect(goal).toEqual({
      version: 1,
      id: "g1",
      objective: "Ship X",
      status: "active",
      source: "user",
      created_at: T,
      updated_at: T,
    });
    expect(() => create(undefined, " ")).toThrow(OBJECTIVE_REQUIRED);
    expect(() => create(undefined, "/goal")).toThrow(OBJECTIVE_IS_COMMAND);

    // Open (active or paused) goals refuse create.
    expect(() => create(goal)).toThrow(GOAL_ALREADY_EXISTS);
    const paused = pauseGoalState(goal, T)!;
    expect(paused.status).toBe("paused");
    expect(() => create(paused)).toThrow(GOAL_ALREADY_EXISTS);
    expect(() => pauseGoalState(paused, T)).toThrow(pauseNotActive("paused"));
    expect(resumeGoalState(paused, T).status).toBe("active");
    expect(completeGoalState(paused, T).status).toBe("complete");

    const done = completeGoalState(goal, T);
    expect(() => resumeGoalState(done, T)).toThrow(RESUME_COMPLETE_GOAL);
    expect(() => completeGoalState(done, T)).toThrow(GOAL_ALREADY_COMPLETE);
    expect(create(done).status).toBe("active");

    const dropped = dropGoalState(goal, T)!;
    expect(dropped.status).toBe("dropped");
    expect(visibleGoal(dropped)).toBeUndefined();
    expect(dropGoalState(dropped, T)).toBeUndefined();
    expect(pauseGoalState(dropped, T)).toBeUndefined();
    expect(() => resumeGoalState(dropped, T)).toThrow(NO_PAUSED_GOAL);
    expect(() => completeGoalState(dropped, T)).toThrow(NO_GOAL_TO_COMPLETE);
    expect(create(dropped).status).toBe("active");
  });

  test("goal-state.json outside the schema parses as invalid; the continuation record starts over for a new goal", () => {
    expect(parseGoalState(undefined)).toEqual({ kind: "missing" });
    expect(parseGoalState("{").kind).toBe("invalid");
    const goal = createGoalState(undefined, { id: "g1", objective: "Ship X", source: "user", now: T });
    expect(parseGoalState(JSON.stringify(goal))).toEqual({ kind: "valid", goal });
    expect(parseGoalState(JSON.stringify({ ...goal, tokensUsed: 0 })).kind).toBe("invalid");
    expect(parseGoalState(JSON.stringify({ ...goal, status: "budget-limited" })).kind).toBe("invalid");

    const record = parseGoalContinuation(
      JSON.stringify({ goal_id: "g1", tool_less_turns: 2, held: { reason: "no_tool_progress", at: T }, critic_reset_after: "e9" }),
    )!;
    expect(continuationForGoal(record, "g1")).toBe(record);
    expect(continuationForGoal(record, "g2")).toEqual({ goal_id: "g2", tool_less_turns: 0 });
    expect(parseGoalContinuation("{")).toBeUndefined();
    expect(parseGoalContinuation(JSON.stringify({ goal_id: "g1", tool_less_turns: -1 }))).toBeUndefined();
  });

  test("the context and continuation are gjc text inside the goal markers", () => {
    const context = goalContextText("ship <b> & c");
    expect(context.startsWith("<goal-context>\n\n<goal_context>\n")).toBe(true);
    expect(context).toContain("<objective>\nship &lt;b&gt; &amp; c\n</objective>");
    const continuation = goalContinuationText("ship it");
    expect(continuation.startsWith("<goal-continuation>\n\n<system-reminder>\nYou stopped while a goal is still active and uncleared.\n")).toBe(true);
    // Host substitution: gjc's hidden-steer HTML comment is gone.
    expect(continuation).toContain(
      "until it is verified complete, paused, or dropped.\n\nContinue work on the active goal.\n\n<objective>\nship it\n</objective>",
    );
    expect(continuation).not.toContain("<!--");
    expect(continuation).toContain("Write them down (in your reasoning).");
    expect(continuation).not.toContain("todo_write");
    expect(continuation).toContain("</system-reminder>\n\n</goal-continuation>");
  });
});

describe("ultragoal guards (pure)", () => {
  test("goal complete is refused until the plan is run-complete (DR-10)", () => {
    expect(goalCompleteGuard(guardInput(undefined))).toBeUndefined();

    const pending = plan(2);
    const incomplete = goalCompleteGuard(guardInput(pending))!;
    expect(incomplete).toBe(
      `${completeIncompleteGoals(["G001", "G002"])} Run \`ultragoal checkpoint(status: "complete", gate)\` first, or record review blockers and rerun verification.`,
    );

    const blocked = plan(2);
    blocked.goals[1].status = "failed";
    expect(goalCompleteGuard(guardInput(blocked))!.startsWith(COMPLETE_BLOCKED_OR_FAILED)).toBe(true);
    blocked.goals[0].status = "review_blocked";
    expect(goalCompleteGuard(guardInput(blocked))!.startsWith(COMPLETE_REVIEW_BLOCKED)).toBe(true);

    const unreadable = goalCompleteGuard({ goals: parseGoals("{"), ledger: parseLedger(undefined) })!;
    expect(unreadable.startsWith("Unable to read durable Ultragoal state: goals.json is not valid JSON")).toBe(true);

    // Every goal complete, but only per-goal receipts: reopen the last one.
    const perGoal = plan(2);
    const perGoalRows: LedgerRow[] = [];
    complete(perGoal, perGoalRows, "G001", "per-goal");
    complete(perGoal, perGoalRows, "G002", "per-goal");
    const reopen = goalCompleteGuard(guardInput(perGoal, perGoalRows))!.split("\n");
    expect(reopen[0].startsWith("Ultragoal aggregate completion requires a fresh final aggregate receipt: ")).toBe(true);
    expect(reopen[1]).toBe(
      'Reopen G002 with ultragoal checkpoint(goal_id: "G002", status: "pending", evidence), then run ultragoal next and re-verify it with the final gate.',
    );

    const closed = plan(2);
    const closedRows: LedgerRow[] = [];
    complete(closed, closedRows, "G001", "per-goal");
    complete(closed, closedRows, "G002", "final-aggregate");
    expect(goalCompleteGuard(guardInput(closed, closedRows))).toBeUndefined();
  });

  test("goal pause needs the latest human_blocked plus a later bound clean pause OKAY (DR-11)", () => {
    const file = plan(1);
    const refusedFor = (rows: LedgerRow[]) => goalPauseGuard(guardInput(file, rows))?.split("\n")[0];
    expect(goalPauseGuard(guardInput(undefined))).toBeUndefined();
    expect(refusedFor([])).toBe(PAUSE_NEEDS_HUMAN_BLOCKED);

    let rows: LedgerRow[] = [];
    const human = classify(rows, "human_blocked");
    expect(refusedFor(rows)).toBe(PAUSE_NEEDS_CRITIC_OKAY);
    pauseVerdict(rows, human);
    expect(refusedFor(rows)).toBeUndefined();
    // The newest bound pause verdict decides.
    pauseVerdict(rows, human, { verdict: "ITERATE" });
    expect(refusedFor(rows)).toBe(PAUSE_NEEDS_CRITIC_OKAY);
    // A later resolvable classification replaces the human_blocked one.
    rows = [];
    pauseVerdict(rows, classify(rows, "human_blocked"));
    classify(rows, "resolvable");
    expect(refusedFor(rows)).toBe(PAUSE_NEEDS_HUMAN_BLOCKED);

    // Not clean, or not bound to the latest classification.
    for (const build of [
      (r: LedgerRow[]) => pauseVerdict(r, classify(r, "human_blocked"), { blockers: ["open question"] }),
      (r: LedgerRow[]) => pauseVerdict(r, classify(r, "human_blocked"), { terminus: "completion" }),
      (r: LedgerRow[]) => {
        const older = classify(r, "human_blocked");
        classify(r, "human_blocked");
        pauseVerdict(r, older);
      },
    ]) {
      const built: LedgerRow[] = [];
      build(built);
      expect(refusedFor(built)).toBe(PAUSE_NEEDS_CRITIC_OKAY);
    }

    // gjc `isUltragoalAskBlocked`: the ultragoal directory without goals.json
    // is unverifiable for pause; complete reads it as no run.
    const orphan: UltragoalGuardInput = { ...guardInput(undefined), dirExists: true };
    expect(goalPauseGuard(orphan)?.split("\n")[0]).toBe(pauseStateUnverifiable(ULTRAGOAL_PLAN_MISSING));
    expect(goalCompleteGuard(orphan)).toBeUndefined();

    // A run-complete plan has no active run to guard.
    const closed = plan(1);
    const closedRows: LedgerRow[] = [];
    complete(closed, closedRows, "G001", "final-aggregate");
    expect(goalPauseGuard(guardInput(closed, closedRows))).toBeUndefined();
  });
});

describe("goal tool", () => {
  async function fixture(
    body: (h: {
      call: (args: Record<string, unknown>, agent?: string, sessionID?: string) => Promise<string>;
      file: (...parts: string[]) => string;
    }) => Promise<void>,
  ) {
    const root = await mkdtemp(join(tmpdir(), "open-gajae-goal-"));
    try {
      const store = new StateStore(root, async () => Date.parse(T));
      let ids = 0;
      const tool = goalTool(store, {
        async rootSession(id) {
          if (!(id in LINEAGE)) throw new Error("unknown session");
          return LINEAGE[id];
        },
        now: () => T,
        newId: () => `goal-${++ids}`,
      });
      const dir = await store.resolveSessionDir(ROOT);
      await body({
        call: async (args, agent = "open-gajae", sessionID = ROOT) =>
          (await tool.execute(tool.input.parse(args), { agent, sessionID, signal: new AbortController().signal })).content,
        file: (...parts) => join(dir, ...parts),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("gjc texts, and a dropped goal is no goal for every op (DR-9)", async () => {
    await fixture(async ({ call, file }) => {
      expect(await call({ op: "get" })).toBe("No active goal.");
      expect(await call({ op: "create", objective: "Ship X" })).toBe("Goal: Ship X\nStatus: active");
      expect(await call({ op: "create", objective: "Other" })).toBe(`Error: ${GOAL_ALREADY_EXISTS}`);
      expect(await call({ op: "pause" })).toBe("Goal: Ship X\nStatus: paused");
      expect(await call({ op: "create", objective: "Other" })).toBe(`Error: ${GOAL_ALREADY_EXISTS}`);
      expect(await call({ op: "resume" })).toBe("Goal: Ship X\nStatus: active");
      expect(await call({ op: "drop" })).toBe("Goal: Ship X\nStatus: dropped");

      const stored = JSON.parse(await readFile(file("state", "goal-state.json"), "utf8"));
      expect(stored).toMatchObject({ id: "goal-1", status: "dropped", source: "user" });
      expect(await call({ op: "get" })).toBe("No active goal.");
      expect(await call({ op: "drop" })).toBe("No active goal.");
      expect(await call({ op: "resume" })).toBe(`Error: ${NO_PAUSED_GOAL}`);
      expect(await call({ op: "pause" })).toBe("No active goal.");
      expect(await call({ op: "complete" })).toBe(`Error: ${NO_GOAL_TO_COMPLETE}`);

      expect(await call({ op: "create", objective: "Next" })).toBe("Goal: Next\nStatus: active");
      expect(await call({ op: "complete" })).toBe("Goal: Next\nStatus: complete");
      expect(await call({ op: "resume" })).toBe(`Error: ${RESUME_COMPLETE_GOAL}`);

      const audit = (await readFile(file("state", "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      expect(audit.length).toBe(6);
      expect(audit.every((row) => row.skill === "goal" && row.paths[0] === file("state", "goal-state.json"))).toBe(true);

      // R6 (gjc `normalizeGoal`): a corrupt goal state is no goal for every
      // op, and the next create overwrites it.
      await writeFile(file("state", "goal-state.json"), "{");
      expect(await call({ op: "get" })).toBe("No active goal.");
      expect(await call({ op: "drop" })).toBe("No active goal.");
      expect(await call({ op: "pause" })).toBe("No active goal.");
      expect(await call({ op: "resume" })).toBe(`Error: ${NO_PAUSED_GOAL}`);
      expect(await call({ op: "complete" })).toBe(`Error: ${NO_GOAL_TO_COMPLETE}`);
      expect(await readFile(file("state", "goal-state.json"), "utf8")).toBe("{");
      expect(await call({ op: "create", objective: "Again" })).toBe("Goal: Again\nStatus: active");
      expect(JSON.parse(await readFile(file("state", "goal-state.json"), "utf8"))).toMatchObject({ objective: "Again" });
    });
  });

  test("pause and complete run their guard before the goal lookup; drop is never guarded", async () => {
    await fixture(async ({ call, file }) => {
      await mkdir(file("ultragoal"), { recursive: true });
      await writeFile(file("ultragoal", "goals.json"), serializeGoals(plan(1)));
      const incomplete = `Error: ${completeIncompleteGoals(["G001"])}`;

      // No goal at all: the guard answers first.
      expect((await call({ op: "pause" })).startsWith(`Error: ${PAUSE_NEEDS_HUMAN_BLOCKED}\n`)).toBe(true);
      expect((await call({ op: "complete" })).startsWith(incomplete)).toBe(true);

      // A user goal is guarded too; drop is not.
      await call({ op: "create", objective: "Unrelated user goal" });
      expect((await call({ op: "complete" })).startsWith(incomplete)).toBe(true);
      expect((await call({ op: "pause" })).startsWith(`Error: ${PAUSE_NEEDS_HUMAN_BLOCKED}\n`)).toBe(true);
      expect(await call({ op: "drop" })).toBe("Goal: Unrelated user goal\nStatus: dropped");

      // Unreadable ultragoal state fails closed.
      await writeFile(file("ultragoal", "goals.json"), "{");
      expect((await call({ op: "complete" })).startsWith("Error: Unable to read durable Ultragoal state:")).toBe(true);

      // The ultragoal directory without goals.json (a handoff before create):
      // pause is refused as unverifiable, complete sees no run (gjc).
      await rm(file("ultragoal", "goals.json"));
      await writeFile(file("ultragoal", "progress.txt"), "# Ultragoal Progress Log\n");
      await call({ op: "create", objective: "Another user goal" });
      expect(
        (await call({ op: "pause" })).startsWith(`Error: ${pauseStateUnverifiable(ULTRAGOAL_PLAN_MISSING)}\n`),
      ).toBe(true);
      expect(await call({ op: "complete" })).toBe("Goal: Another user goal\nStatus: complete");
    });
  });

  test("only open-gajae may call it, and it works on the lineage root", async () => {
    await fixture(async ({ call, file }) => {
      expect(await call({ op: "get" }, "open-gajae-executor")).toBe(
        "Error: the goal tool is not available to open-gajae-executor",
      );
      expect(await call({ op: "create", objective: "Ship X" }, "open-gajae-critic", "ses_child")).toBe(
        "Error: the goal tool is not available to open-gajae-critic",
      );
      expect(await call({ op: "create", objective: "Ship X" }, "open-gajae", "ses_child")).toBe(
        "Goal: Ship X\nStatus: active",
      );
      expect(JSON.parse(await readFile(file("state", "goal-state.json"), "utf8")).objective).toBe("Ship X");
      expect(await call({ op: "get" }, "open-gajae", "ses_other")).toBe(
        "Error: could not resolve the session lineage for goal",
      );
    });
  });
});
