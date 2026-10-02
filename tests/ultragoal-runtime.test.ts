import { describe, expect, test } from "bun:test";
import { validateGate } from "../src/ultragoal-runtime/gate";
import { buildUltragoalHud } from "../src/ultragoal-runtime/hud";
import {
  criticNonOkayStreak,
  latestLedgerEvent,
  type LedgerEventFields,
  type LedgerRow,
  ledgerRow,
  parseLedger,
  serializeLedgerRow,
} from "../src/ultragoal-runtime/ledger";
import {
  derivedFieldPatchError,
  ULTRAGOAL_TRANSITIONS,
  ultragoalPhasePatchError,
} from "../src/ultragoal-runtime/manifest";
import {
  planChangeStatusRefusal,
  renderCheckpoint,
  renderCreate,
  renderCriticVerdict,
  renderGateDiagnostics,
  renderNext,
  renderStatus,
  ultragoalGoalObjective,
} from "../src/ultragoal-runtime/messages";
import {
  ALLOWED_STATUSES,
  buildGoalsFile,
  chooseNextGoal,
  carriedCriterionIds,
  completionView,
  FIX_CRITERION_SUFFIX,
  type Goal,
  GOAL_STATUSES,
  type GoalsFile,
  goalsFileError,
  insertAfter,
  isOnlyRequiredGoal,
  isStatusAllowed,
  LIMITS,
  moveAfter,
  newGoal,
  nextCriterionId,
  parseGoals,
  resolveNextAction,
  runCompletion,
  serializeGoals,
  type StatusRuleOp,
} from "../src/ultragoal-runtime/plan";
import { progressForCreate, progressForHandoff } from "../src/ultragoal-runtime/progress";
import { buildCompletionVerification, checkReceipt, type ReceiptKind } from "../src/ultragoal-runtime/receipt";
import {
  projectUltragoalRun,
  renderUltragoalRecoveryContext,
  trackZeroProgress,
  ultragoalRecoveryApplies,
  withZeroProgress,
  type ZeroProgressMemory,
} from "../src/ultragoal-runtime/recovery";

const T = "2026-09-30T01:02:03.000Z";
const OBJECTIVE = ultragoalGoalObjective("_session-20260930-ses_1");

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

function goal(file: GoalsFile, id: string): Goal {
  return file.goals.find((item) => item.id === id)!;
}

let seq = 0;
function push(rows: LedgerRow[], fields: LedgerEventFields, eventId = `e${++seq}`): string {
  rows.push(ledgerRow(fields, { eventId, timestamp: T }));
  return eventId;
}

function perGoalGate(target: Goal): Record<string, unknown> {
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
    criteriaCoverage: target.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      status: "covered",
      evidence: "a test covers it",
    })),
  };
}

function finalGate(target: Goal, generation = 1): Record<string, unknown> {
  const lane = (status: string) => ({ status, evidence: "lane ran", blockers: [] });
  return {
    ...perGoalGate(target),
    reviewCohort: {
      reviewGeneration: generation,
      joined: true,
      ...(generation > 1 ? { deltaOnly: true, deltaPaths: ["src/a.ts"] } : {}),
      lanes: {
        cleaner: lane("PASS"),
        architect: lane("CLEAR"),
        qa: { ...lane("passed"), commands: ["bun test"], adversarialCases: ["empty input"] },
      },
    },
    criticReview: { verdict: "OKAY", evidence: "critic read it", blockers: [] },
  };
}

/** Checkpoint `id` complete the way the store will: receipt on the row and the ledger. */
function complete(file: GoalsFile, rows: LedgerRow[], id: string, kind: ReceiptKind): void {
  const target = goal(file, id);
  const gate = kind === "final-aggregate" ? finalGate(target) : perGoalGate(target);
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
  push(
    rows,
    { event: "goal_checkpointed", goalId: id, status: "complete", evidence: "done", qualityGateJson: gate, completionVerification: receipt },
    eventId,
  );
}

const AMENDMENT = { rationale: "the scope changed after review", evidence: "the review found a gap here", timestamp: T };

function steer(rows: LedgerRow[], kind: "add" | "revise" | "supersede", target: "goal" | "criterion", goalId: string) {
  return push(rows, {
    event: "steering_accepted",
    kind,
    target,
    goalId,
    rationale: AMENDMENT.rationale,
    evidence: AMENDMENT.evidence,
    amendment: { target, kind: kind === "add" ? "added" : kind === "revise" ? "revised" : "superseded", ...AMENDMENT },
  });
}

describe("goals.json v2", () => {
  test("round-trips, refuses v1 and empty goals, fails closed on a bad status", () => {
    const file = plan(1);
    expect(file.goals[0].acceptanceCriteria).toEqual([{ id: "G001.AC1", text: "part 1 works" }]);
    expect(parseGoals(serializeGoals(file))).toEqual({ kind: "valid", file });
    expect(parseGoals(undefined)).toEqual({ kind: "missing" });
    expect(goalsFileError({ ...file, version: 1 })).toContain("version 1");
    expect(goalsFileError({ ...file, goals: [] })).toBe("goals must be a non-empty array");
    expect(goalsFileError({ ...file, goals: [{ ...file.goals[0], status: "done" }] })).toContain("status must be one of");
    expect(LIMITS.objective + FIX_CRITERION_SUFFIX.length).toBe(LIMITS.text);
  });

  test("criterion IDs: a revision gets a new number and retired numbers are never reused (PQ-22 A)", () => {
    const g = newGoal("G001", { title: "A", description: "a", acceptanceCriteria: ["x", "y"] });
    expect(nextCriterionId(g)).toBe("G001.AC3");
    // revise AC1 -> AC3, then supersede AC3: the next ID is AC4.
    g.acceptanceCriteria = [{ id: "G001.AC3", text: "x2" }, { id: "G001.AC2", text: "y" }];
    g.amendments.push({ target: "criterion", kind: "revised", criterionId: "G001.AC1", replacementId: "G001.AC3", original: "x", replacement: "x2", ...AMENDMENT });
    g.acceptanceCriteria = [{ id: "G001.AC2", text: "y" }];
    g.amendments.push({ target: "criterion", kind: "superseded", criterionId: "G001.AC3", original: "x2", ...AMENDMENT });
    expect(nextCriterionId(g)).toBe("G001.AC4");
    const file = { ...plan(1), goals: [g] };
    expect(goalsFileError(file)).toBeUndefined();
    const reused = structuredClone(file);
    reused.goals[0].acceptanceCriteria.push({ id: "G001.AC1", text: "x again" });
    expect(goalsFileError(reused)).toContain("retired criterion G001.AC1 is still active");
    const foreign = structuredClone(file);
    foreign.goals[0].acceptanceCriteria[0].id = "G002.AC2";
    expect(goalsFileError(foreign)).toContain("must look like G001.AC1");
  });

  test("after: insert and move by goal id", () => {
    const file = plan(3);
    const ids = (goals: Goal[]) => goals.map((item) => item.id);
    const added = newGoal("G004", { title: "D", description: "d", acceptanceCriteria: ["d"] });
    expect(ids(insertAfter(file.goals, added, "G001"))).toEqual(["G001", "G004", "G002", "G003"]);
    expect(ids(insertAfter(file.goals, added))).toEqual(["G001", "G002", "G003", "G004"]);
    expect(ids(moveAfter(file.goals, "G003", "G001"))).toEqual(["G001", "G003", "G002"]);
    expect(() => insertAfter(file.goals, added, "G009")).toThrow("after references unknown goal id G009");
    expect(() => moveAfter(file.goals, "G002", "G002")).toThrow("cannot name the goal being moved");
  });
});

describe("allowed statuses (C-15, PQ-26 A)", () => {
  test("op x status table", () => {
    // columns: pending active complete failed blocked review_blocked superseded
    const table: Record<StatusRuleOp, string> = {
      "add-goal": "yyyyyyy",
      "revise-goal": "ynnnnnn",
      "move-goal": "ynnnnnn",
      "supersede-goal": "ynnnyyn",
      "add-criterion": "ynnnnnn",
      "revise-criterion": "ynnnnnn",
      "supersede-criterion": "ynnnnnn",
      "checkpoint-complete": "nynynnn",
      "checkpoint-reopen-fail-block": "yyyyyyy",
      "record-review-blockers": "yyyyyyy",
    };
    expect(Object.keys(ALLOWED_STATUSES).sort()).toEqual(Object.keys(table).sort());
    for (const [op, row] of Object.entries(table) as [StatusRuleOp, string][])
      GOAL_STATUSES.forEach((status, index) =>
        expect(`${op} ${status} ${isStatusAllowed(op, status)}`).toBe(`${op} ${status} ${row[index] === "y"}`),
      );
    const file = plan(2);
    goal(file, "G002").status = "superseded";
    expect(isOnlyRequiredGoal(file, "G001")).toBe(true);
    expect(isOnlyRequiredGoal(plan(2), "G001")).toBe(false);
    expect(planChangeStatusRefusal("revise", "criterion", { id: "G001", status: "complete" }, ["pending"])).toBe(
      'ultragoal revise (criterion) requires goal G001 status pending; found complete. To change it, reopen it first with ultragoal checkpoint(goal_id: "G001", status: "pending", evidence), change it, then run ultragoal next and checkpoint it again.',
    );
  });

  test("next goal: gjc order, retry_failed takes a failed goal before pending ones (PQ-19 B)", () => {
    const file = plan(3);
    goal(file, "G001").status = "complete";
    goal(file, "G002").status = "failed";
    expect(chooseNextGoal(file, false)?.id).toBe("G003");
    expect(chooseNextGoal(file, true)?.id).toBe("G002");
    goal(file, "G003").status = "active";
    expect(chooseNextGoal(file, true)?.id).toBe("G003");
    goal(file, "G003").status = "blocked";
    goal(file, "G002").status = "complete";
    expect(resolveNextAction(file, false)).toMatchObject({ kind: "resolve-blockers" });
  });
});

describe("receipts and run completion (C-7)", () => {
  test("the three conditions and the (3)-b per-goal exception", () => {
    const file = plan(2);
    const rows: LedgerRow[] = [];
    push(rows, { event: "plan_created", goalIds: ["G001", "G002"], description: "ship" });
    expect(checkReceipt(goal(file, "G001"), rows)).toEqual({ state: "none" });
    complete(file, rows, "G001", "per-goal");
    complete(file, rows, "G002", "final-aggregate");
    expect(checkReceipt(goal(file, "G002"), rows)).toMatchObject({ state: "valid", kind: "final-aggregate" });
    // 1: the row receipt must equal its ledger row's receipt.
    const tampered = structuredClone(goal(file, "G001"));
    tampered.completionVerification!.receiptId = "forged";
    expect(checkReceipt(tampered, rows)).toEqual({ state: "stale", reason: "ledger_mismatch" });
    expect(checkReceipt(goal(file, "G001"), [])).toEqual({ state: "stale", reason: "ledger_mismatch" });
    // 2: the criteria revision must still match.
    const edited = structuredClone(goal(file, "G001"));
    edited.acceptanceCriteria[0].text = "part 1 works well";
    expect(checkReceipt(edited, rows)).toEqual({ state: "stale", reason: "criteria_changed" });
    // 3: criterion changes and a revived goal are not required-set changes...
    steer(rows, "add", "criterion", "G001");
    push(rows, { event: "goal_checkpointed", goalId: "G001", status: "pending", evidence: "revive" });
    expect(checkReceipt(goal(file, "G002"), rows).state).toBe("valid");
    // ...a goal add is: the final counts as a valid per-goal completion.
    steer(rows, "add", "goal", "G003");
    expect(checkReceipt(goal(file, "G002"), rows).state).toBe("superseded-final");
  });

  test("run completion: final closes; tampered, shrunk and last-pending-superseded runs reopen", () => {
    const file = plan(2);
    const rows: LedgerRow[] = [];
    push(rows, { event: "plan_created", goalIds: ["G001", "G002"], description: "ship" });
    complete(file, rows, "G001", "per-goal");
    complete(file, rows, "G002", "final-aggregate");
    expect(runCompletion(file, rows)).toEqual({ complete: true, lastGoalId: "G002" });

    // AC12: a goal marked complete by hand has no receipt.
    const tampered = structuredClone(file);
    delete goal(tampered, "G002").completionVerification;
    expect(runCompletion(tampered, rows)).toEqual({
      complete: false,
      reason: "G002 has no completion receipt",
      reopenGoalId: "G002",
    });

    // 「E2」: an added goal leaves G002's final as a per-goal completion...
    const grown = structuredClone(file);
    const grownRows = [...rows];
    grown.goals.push(newGoal("G003", { title: "C", description: "c", acceptanceCriteria: ["c"] }));
    steer(grownRows, "add", "goal", "G003");
    expect(runCompletion(grown, grownRows)).toEqual({
      complete: false,
      reason: "required goals not complete: G003 (pending)",
    });
    complete(grown, grownRows, "G003", "final-aggregate");
    expect(runCompletion(grown, grownRows)).toEqual({ complete: true, lastGoalId: "G003" });

    // ...but superseding the added goal again leaves no valid final: reopen G002.
    const shrunk = structuredClone(file);
    const shrunkRows = [...rows];
    shrunk.goals.push({ ...newGoal("G003", { title: "C", description: "c", acceptanceCriteria: ["c"] }), status: "superseded" });
    steer(shrunkRows, "add", "goal", "G003");
    steer(shrunkRows, "supersede", "goal", "G003");
    expect(runCompletion(shrunk, shrunkRows)).toEqual({
      complete: false,
      reason: "last completed goal G002 has no valid final-aggregate receipt",
      reopenGoalId: "G002",
    });

    // (라): every other goal per-goal, the last pending one superseded.
    const lastPending = plan(2);
    const lastRows: LedgerRow[] = [];
    complete(lastPending, lastRows, "G001", "per-goal");
    goal(lastPending, "G002").status = "superseded";
    steer(lastRows, "supersede", "goal", "G002");
    const run = runCompletion(lastPending, lastRows);
    expect(run).toEqual({
      complete: false,
      reason: "last completed goal G001 has no valid final-aggregate receipt",
      reopenGoalId: "G001",
    });
    expect(renderNext({ action: resolveNextAction(lastPending, false), goalObjective: OBJECTIVE, run }).split("\n")).toEqual([
      "ultragoal complete all=true",
      "run-complete=no reason=last completed goal G001 has no valid final-aggregate receipt",
      "hint=reopen G001 with ultragoal checkpoint(status: pending) and re-verify with the final gate",
    ]);
  });

  test("completion view: a fix goal sees its review_blocked parent superseded (C-8)", () => {
    const file = plan(2);
    goal(file, "G001").status = "complete";
    goal(file, "G002").status = "review_blocked";
    file.goals.push({
      ...newGoal("G003", { title: "Fix", description: "fix it", acceptanceCriteria: [`fix it${FIX_CRITERION_SUFFIX}`] }),
      status: "active",
      steering: { kind: "review_blocker", blockedGoalId: "G002" },
    });
    const view = completionView(file, "G003", { evidence: "fixed" });
    expect(view.receiptKind).toBe("final-aggregate");
    expect(view.supersededParentIds).toEqual(["G002"]);
    // Deviation 44: the final gate also covers the superseded parent's criteria.
    expect(view.activeCriterionIds).toEqual(["G003.AC1", "G002.AC1"]);
    expect(goal(view.file, "G002")).toMatchObject({
      status: "superseded",
      evidence: "Resolved by verification blocker goal G003: fixed",
    });
    expect(goal(file, "G002").status).toBe("review_blocked");
    // Only a review_blocked parent is superseded; a blocked one stays required.
    goal(file, "G002").status = "blocked";
    expect(completionView(file, "G003")).toMatchObject({
      receiptKind: "per-goal",
      supersededParentIds: [],
      activeCriterionIds: ["G003.AC1"],
    });
    expect(completionView(plan(2), "G001").receiptKind).toBe("per-goal");
  });

  /** G001 complete; G002 review_blocked, fixed by G003, itself fixed by G004. */
  function fixOfAFix(): GoalsFile {
    const file = plan(2);
    goal(file, "G001").status = "complete";
    goal(file, "G002").status = "review_blocked";
    const fix = (id: string, parent: string, status: Goal["status"]): Goal => ({
      ...newGoal(id, { title: "Fix", description: `fix ${parent}`, acceptanceCriteria: [`fix ${parent}${FIX_CRITERION_SUFFIX}`] }),
      status,
      steering: { kind: "review_blocker", blockedGoalId: parent },
    });
    file.goals.push(fix("G003", "G002", "review_blocked"), fix("G004", "G003", "active"));
    return file;
  }

  test("completion view: the last fix supersedes its whole chain and carries the criteria (deviations 43, 44)", () => {
    const file = fixOfAFix();
    const view = completionView(file, "G004", { evidence: "fixed" });
    expect(view.supersededParentIds).toEqual(["G003", "G002"]);
    expect(view.receiptKind).toBe("final-aggregate");
    expect(view.activeCriterionIds).toEqual(["G004.AC1", "G002.AC1", "G003.AC1"]);
    for (const id of ["G002", "G003"])
      expect(goal(view.file, id)).toMatchObject({
        status: "superseded",
        evidence: "Resolved by verification blocker goal G004: fixed",
      });
    // A goal of the chain superseded by hand earlier is passed, and still carried.
    goal(file, "G002").status = "superseded";
    expect(completionView(file, "G004")).toMatchObject({
      supersededParentIds: ["G003"],
      activeCriterionIds: ["G004.AC1", "G002.AC1", "G003.AC1"],
    });
    // The walk stops at any other status, which stays required.
    goal(file, "G003").status = "blocked";
    expect(completionView(file, "G004")).toMatchObject({
      supersededParentIds: [],
      receiptKind: "per-goal",
      activeCriterionIds: ["G004.AC1"],
    });
  });

  test("carried criteria come only from resolved fix chains (deviation 44)", () => {
    // An earlier chain resolved by a complete fix carries into a later final.
    const resolved = plan(3);
    goal(resolved, "G001").status = "superseded";
    resolved.goals.push({
      ...newGoal("G004", { title: "Fix", description: "fix G001", acceptanceCriteria: ["fix G001 works"] }),
      status: "complete",
      steering: { kind: "review_blocker", blockedGoalId: "G001" },
    });
    expect(carriedCriterionIds(resolved, "G003")).toEqual(["G001.AC1"]);
    // A chain whose fix never completed carries nothing...
    goal(resolved, "G004").status = "superseded";
    expect(carriedCriterionIds(resolved, "G003")).toEqual([]);
    // ...and neither does a goal superseded by a plan change.
    const changed = plan(2);
    goal(changed, "G001").status = "superseded";
    expect(carriedCriterionIds(changed, "G002")).toEqual([]);
  });
});

describe("gate (C-8)", () => {
  const target = plan(1).goals[0];
  const ids = [target.acceptanceCriteria[0].id];
  const codes = (gate: unknown, receiptKind: ReceiptKind = "per-goal") =>
    validateGate(gate, { receiptKind, activeCriterionIds: ids }).map((item) => `${item.path} [${item.code}]`);

  test("per-goal: every defect in one list", () => {
    expect(codes(perGoalGate(target))).toEqual([]);
    expect(codes("text")).toEqual(["qualityGate [not_an_object]"]);
    expect(validateGate({}, { receiptKind: "per-goal" })[0].message).toBe(
      "qualityGate requires targetedVerification, architectReview, and criteriaCoverage objects",
    );
    const gate = perGoalGate(target) as Record<string, any>;
    gate.extra = true;
    gate.targetedVerification = { status: "failed", commands: [], evidence: "" };
    gate.architectReview = { ...gate.architectReview, codeStatus: "WATCH", blockers: ["nit"] };
    gate.criteriaCoverage = [
      { criterionId: "G001.AC9", status: "covered", evidence: "e" },
      { criterionId: "G001.AC9", status: "todo", evidence: "e" },
    ];
    expect(codes(gate)).toEqual([
      "qualityGate [unsupported_keys]",
      "targetedVerification.status [targeted_verification_not_passed]",
      "targetedVerification.commands [missing_command_array]",
      "targetedVerification.evidence [missing_evidence]",
      "architectReview [architect_not_clear]",
      "architectReview.blockers [non_empty_blockers]",
      "criteriaCoverage[0].criterionId [unknown_criterion]",
      "criteriaCoverage[1].criterionId [duplicate_criterion]",
      "criteriaCoverage[1].status [criterion_not_covered]",
      "criteriaCoverage [missing_criterion]",
    ]);
  });

  test("final: cohort lanes, critic and the generation rules", () => {
    expect(codes(finalGate(target), "final-aggregate")).toEqual([]);
    expect(codes(finalGate(target, 2), "final-aggregate")).toEqual([]);
    expect(codes(perGoalGate(target), "final-aggregate")).toEqual([
      "reviewCohort [review_cohort_invalid]",
      "criticReview.verdict [critic_verdict_not_okay]",
    ]);
    const gate = finalGate(target) as Record<string, any>;
    gate.reviewCohort.deltaOnly = true;
    gate.reviewCohort.joined = false;
    gate.reviewCohort.lanes.cleaner.status = "CLEAR";
    gate.reviewCohort.lanes.qa.adversarialCases = [];
    gate.reviewCohort.lanes.extra = {};
    gate.criticReview = { verdict: "ITERATE", evidence: "e", blockers: ["gap"] };
    expect(codes(gate, "final-aggregate")).toEqual([
      "reviewCohort.joined [review_cohort_invalid]",
      "reviewCohort.lanes [review_cohort_invalid]",
      "reviewCohort.lanes.cleaner.status [review_cohort_invalid]",
      "reviewCohort.lanes.qa.adversarialCases [review_cohort_invalid]",
      "reviewCohort.deltaOnly [review_cohort_invalid]",
      "criticReview.verdict [critic_verdict_not_okay]",
      "criticReview.blockers [non_empty_blockers]",
    ]);
    const second = finalGate(target) as Record<string, any>;
    second.reviewCohort.reviewGeneration = 2;
    expect(codes(second, "final-aggregate")).toEqual([
      "reviewCohort.deltaOnly [review_cohort_invalid]",
      "reviewCohort.deltaPaths [review_cohort_invalid]",
    ]);
  });
});

describe("ledger", () => {
  test("strict and lenient readers", () => {
    const rows: LedgerRow[] = [];
    push(rows, { event: "goal_started", goalId: "G001" }, "a1");
    const text = [
      ...rows.map(serializeLedgerRow),
      JSON.stringify({ eventId: "a2", type: "reconcile_failed", error: "disk full", timestamp: T }),
    ].join("\n");
    expect(parseLedger(text)).toMatchObject({ kind: "valid", rows: [{ event: "goal_started" }, { type: "reconcile_failed" }] });
    expect(parseLedger(undefined)).toEqual({ kind: "valid", rows: [] });
    expect(parseLedger(`${text}\n{"eventId":"a3","timestamp":"t","event":"nudge"}`)).toEqual({
      kind: "invalid",
      error: 'ledger.jsonl line 3: unknown event "nudge"',
    });
    expect(parseLedger(`${text}\n${text}`).kind).toBe("invalid");
    expect(latestLedgerEvent(`${text}\nnot json`)).toEqual({ event: "reconcile_failed", timestamp: T });
  });

  test("critic streak: OKAY, a final gate OKAY, the release marker and a new plan end it (PQ-3)", () => {
    const rows: LedgerRow[] = [];
    const file = plan(2);
    const verdict = (value: "OKAY" | "ITERATE" | "REJECT", terminus: "completion" | "pause" = "completion") =>
      push(rows, { event: "critic_verdict", terminus, verdict: value, evidence: "read it", blockers: [] });
    push(rows, { event: "plan_created", goalIds: ["G001", "G002"], description: "ship" });
    verdict("ITERATE");
    verdict("REJECT", "pause");
    expect(criticNonOkayStreak(rows)).toBe(2);
    verdict("OKAY");
    verdict("ITERATE");
    complete(file, rows, "G001", "per-goal");
    expect(criticNonOkayStreak(rows)).toBe(1);
    complete(file, rows, "G002", "final-aggregate");
    expect(criticNonOkayStreak(rows)).toBe(0);
    const marker = verdict("ITERATE");
    verdict("ITERATE");
    expect(criticNonOkayStreak(rows)).toBe(2);
    expect(criticNonOkayStreak(rows, marker)).toBe(1);
    push(rows, { event: "plan_created", goalIds: ["G001"], description: "again" });
    expect(criticNonOkayStreak(rows)).toBe(0);
  });
});

describe("state rules and progress", () => {
  test("manifest phase patch and derived fields (C-3)", () => {
    expect(ULTRAGOAL_TRANSITIONS).toHaveLength(11);
    expect(ultragoalPhasePatchError("goal-planning", "pending")).toBeUndefined();
    expect(ultragoalPhasePatchError("pending", "complete")).toBe("invalid ultragoal phase transition from pending to complete");
    expect(ultragoalPhasePatchError("pending", "done")).toBe('unknown ultragoal phase "done"');
    expect(derivedFieldPatchError({ note: 1, current_phase: "active" })).toBeUndefined();
    expect(derivedFieldPatchError({ goals: [], counts: {} })).toContain("goals, counts");
  });

  test("create appends a PLAN note; handoff a HANDOFF note (PQ-15 A)", () => {
    const first = progressForCreate(undefined, "ship the feature", T);
    expect(first.startsWith("# Ultragoal Progress Log")).toBe(true);
    const second = progressForCreate(`${first}KEEP\n`, "replan", T);
    expect(second.startsWith(`${first}KEEP\n`)).toBe(true);
    expect(second.match(/# Ultragoal Progress Log/g)).toHaveLength(1);
    expect(second).toContain("## [2026-09-30 01:02] - PLAN\n\n**Description:**\n- replan");
    expect(progressForHandoff(second, "ralplan", "needs a plan", T)).toContain("- HANDOFF\n\n**Reason:**\n- to ralplan: needs a plan");
  });
});

describe("hud and recovery", () => {
  test("hud: the five gjc chips", () => {
    const hud = buildUltragoalHud({
      status: "active",
      goals: [
        { id: "G001", title: "A", status: "complete" },
        { id: "G002", title: "B", status: "active" },
        { id: "G003", title: "C", status: "failed" },
        { id: "G004", title: "D", status: "review_blocked" },
      ],
      latestLedgerEvent: { event: "steering_accepted", kind: "add", goalId: "G004" },
      updatedAt: T,
    });
    expect(hud.chips?.map((item) => `${item.label}=${item.value}`)).toEqual([
      "blocked=2",
      "goals=1/4",
      "current=G002:B",
      "status=active",
      "ledger=steering_accepted:add:G004",
    ]);
  });

  test("projection, applicability and STALLED after 2 unchanged observations", () => {
    const file = plan(2);
    const rows: LedgerRow[] = [];
    complete(file, rows, "G001", "per-goal");
    goal(file, "G001").evidence = "tests pass";
    goal(file, "G002").status = "active";
    const projection = projectUltragoalRun({ file, rows, goalsPath: "goals.json", objective: OBJECTIVE })!;
    expect(projection.nextAction).toMatchObject({ actionClass: "continue-current-goal", goalId: "G002" });
    let memory: ZeroProgressMemory | undefined;
    const stalled: boolean[] = [];
    for (let index = 0; index < 3; index++) {
      memory = trackZeroProgress(memory, projection);
      stalled.push(withZeroProgress(projection, memory).zeroProgress.stalled);
    }
    expect(stalled).toEqual([false, false, true]);
    const progress = `${progressForCreate(undefined, "ship", T)}`.replace("(No patterns discovered yet)", "- use bun test");
    const lines = renderUltragoalRecoveryContext(withZeroProgress(projection, memory!), progress);
    expect(lines).toContain("Current goal: G002 status=active do part 2");
    expect(lines).toContain("Progress: goals 1/2, outstanding 1");
    expect(lines).toContain("Codebase patterns:");
    expect(lines.at(-1)).toStartWith("STALLED: durable progress has not changed across 3 compaction recoveries.");
    expect(ultragoalRecoveryApplies({ rowActive: true, phase: "active", goalStatus: "active" })).toBe(true);
    expect(ultragoalRecoveryApplies({ rowActive: true, phase: "active", goalStatus: "paused" })).toBe(false);
    expect(ultragoalRecoveryApplies({ rowActive: true, phase: "complete", goalStatus: "active" })).toBe(false);
    expect(ultragoalRecoveryApplies({ rowActive: true, phase: "planner", goalStatus: "active" })).toBe(false);
  });
});

describe("C-14 renderers", () => {
  test("status: gjc lines, then run_complete, goal and the goals section", () => {
    const file = plan(2);
    const rows: LedgerRow[] = [];
    complete(file, rows, "G001", "per-goal");
    goal(file, "G002").status = "active";
    expect(
      renderStatus({ goalsPath: "g.json", ledgerPath: "l.jsonl", file, rows, objective: OBJECTIVE, goal: { status: "active", source: "ultragoal" } }),
    ).toBe(
      [
        "# ultragoal status",
        "",
        "- status: active",
        "- goals: 2 (pending=0 active=1 complete=1 failed=0 blocked=0 review_blocked=0 superseded=0)",
        `- objective: ${OBJECTIVE}`,
        "- current: G002 (active)",
        "- goals_path: g.json",
        "- ledger_path: l.jsonl",
        "- run_complete: no (required goals not complete: G002 (active))",
        "- goal: active (ultragoal)",
        "",
        "## goals",
        "- G001 [complete] Goal 1 — receipt: valid",
        "  - G001.AC1: part 1 works",
        "- G002 [active] Goal 2 — receipt: none",
        "  - G002.AC1: part 2 works",
      ].join("\n"),
    );
    expect(renderStatus({ goalsPath: "g.json", ledgerPath: "l.jsonl" })).toBe(
      "# ultragoal status\n\n- status: missing\n- No ultragoal plan found at g.json. Run `ultragoal create` first.",
    );
    expect(OBJECTIVE).toBe(
      "Complete the durable ultragoal plan in .open-gajae/_session-20260930-ses_1/ultragoal/goals.json, including later accepted/appended goals, under the original description constraints; use .open-gajae/_session-20260930-ses_1/ultragoal/ledger.jsonl as the audit trail.",
    );
  });

  test("gate list, next, checkpoint, create and critic lines", () => {
    const target = plan(1).goals[0];
    expect(renderGateDiagnostics(validateGate(perGoalGate(target), { receiptKind: "final-aggregate" })).split("\n")).toEqual([
      "2 quality-gate error(s):",
      "  reviewCohort [review_cohort_invalid]: qualityGate reviewCohort is required at the review boundary",
      "  criticReview.verdict [critic_verdict_not_okay]: checkpoint(status: complete) (final aggregate) requires criticReview with verdict OKAY, non-empty evidence, and empty blockers",
    ]);
    expect(renderGateDiagnostics([])).toBe("quality gate is valid.");
    expect(renderNext({ action: { kind: "execute-goal", goal: target }, goalObjective: OBJECTIVE, finalGate: true }).split("\n")).toEqual([
      "ultragoal next-action=execute-goal goal-id=G001",
      "objective=do part 1",
      `goal-objective=${OBJECTIVE}`,
      "checkpoint requires=targetedVerification:passed,architectReview:CLEAR+APPROVE,criteriaCoverage:all,reviewCohort:joined,criticReview:OKAY",
      "criteria=G001.AC1",
    ]);
    const next = plan(2).goals[1];
    expect(
      renderCheckpoint({ goalId: "G001", status: "complete", allComplete: false, nextGoal: next, startedNext: true, goalObjective: OBJECTIVE }).split("\n"),
    ).toEqual([
      "Checkpointed G001 as complete.",
      "Next ultragoal goal: G002 — Goal 2",
      "Objective: do part 2",
      `Goal objective: ${OBJECTIVE}`,
      "Criteria: G002.AC1",
      "The next ultragoal goal is active; continue the current aggregate goal and checkpoint this goal when verified.",
    ]);
    expect(
      renderCheckpoint({
        goalId: "G002",
        status: "complete",
        allComplete: true,
        startedNext: false,
        goalObjective: OBJECTIVE,
        run: { complete: false, reason: "G001 has no completion receipt", reopenGoalId: "G001" },
      }),
    ).toBe("Checkpointed G002 as complete.\nAll ultragoal goals are complete.\nRun not complete: G001 has no completion receipt");
    expect(renderCheckpoint({ goalId: "G001", status: "pending", allComplete: false, startedNext: false, goalObjective: OBJECTIVE })).toBe(
      "Checkpointed G001 as pending.\nReopened G001; revise it, then run ultragoal next and checkpoint it again.",
    );
    expect(renderCreate({ goalCount: 1, goalsPath: "g.json", arming: { kind: "not-armed", status: "active", source: "user" } })).toBe(
      "Created ultragoal plan with 1 goal at g.json.\nGoal not armed: another goal is open (active, source user). Run goal drop, then ultragoal create again to arm this plan's goal.",
    );
    expect(renderCriticVerdict("REJECT", "completion", 5)).toBe(
      "Recorded critic verdict: REJECT (completion).\ncritic non-OKAY streak: 5/5 — continuation held",
    );
  });
});
