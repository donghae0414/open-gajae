import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isNeutralTempPath,
  readTempArtifact,
} from "../src/ralplan-runtime/temp-paths";
import {
  buildRalplanHud,
  buildRalplanHudFromState,
  buildRalplanHudSummary,
  normalizeWorkflowHudSummary,
  type WorkflowHudChip,
} from "../src/ralplan-runtime/hud";
import {
  buildDeduplicatedReceipt,
  buildLaneBudgetStuckResult,
  buildPlanningStuckResult,
  countRalplanOnDiskLaneArtifacts,
  countRalplanOnDiskOpeners,
  evaluateRalplanIterationCap,
  evaluateRalplanReviewLaneBudget,
  findJsonlDuplicate,
  formatRalplanStagePresence,
  loadRalplanIndexForCap,
  normalizeArtifactContent,
  normalizeDispositionArtifact,
  parseStageN,
  ralplanIndexKey,
  ralplanPlanningStuckIndexEntry,
  ralplanPlanningStuckIndexKey,
  ralplanStageFileName,
  ralplanStageIndexEntry,
  readRalplanPlanningStuck,
  resolveRalplanAutoHandoffTarget,
  reviewBudgetWarning,
  sha256Hex,
  stageOverwriteRefusal,
  type RalplanIndexRow,
} from "../src/ralplan-runtime/ledger";
import {
  advanceCurrentPhase,
  GUARD_RELEASE_PHASES,
  isKnownPhase,
  isValidTransition,
  KNOWN_PHASES,
  RALPLAN_STAGES,
  RALPLAN_STATES,
  RALPLAN_TRANSITIONS,
  TERMINAL_PHASES,
} from "../src/ralplan-runtime/manifest";
import {
  projectRalplanRun,
  ralplanRecoveryRunFromState,
  renderRalplanRecoveryContext,
} from "../src/ralplan-runtime/recovery";

const rows = (...stages: string[]): RalplanIndexRow[] =>
  stages.map((stage, index) => ({ stage, stageN: index + 1 }));
const line = (row: object) => `${JSON.stringify(row)}\n`;

describe("manifest (gjc workflow-manifest.ts ralplan, tools/skill.ts:42)", () => {
  test("stages and states follow gjc order", () => {
    expect([...RALPLAN_STAGES]).toEqual([
      "planner",
      "intent",
      "architect",
      "critic",
      "disposition",
      "revision",
      "post-interview",
      "adr",
      "final",
    ]);
    expect([...RALPLAN_STATES]).toEqual([...RALPLAN_STAGES, "handoff"]);
  });

  test("the transition table is gjc's, and every row is a valid edge", () => {
    const edges = [
      "planner>intent",
      "planner>architect",
      "intent>architect",
      "intent>revision",
      "architect>critic",
      "critic>disposition",
      "architect>disposition",
      "disposition>revision",
      "critic>revision",
      "revision>intent",
      "revision>post-interview",
      "critic>post-interview",
      "disposition>post-interview",
      "post-interview>revision",
      "post-interview>adr",
      "revision>adr",
      "adr>final",
      "planner>handoff",
      "intent>handoff",
      "architect>handoff",
      "critic>handoff",
      "disposition>handoff",
      "revision>handoff",
      "adr>handoff",
      "post-interview>handoff",
    ];
    expect(RALPLAN_TRANSITIONS.map((t) => `${t.from}>${t.to}`)).toEqual(edges);
    for (const t of RALPLAN_TRANSITIONS) expect(isValidTransition(t.from, t.to)).toBe(true);
  });

  test("non-edges are refused; the same phase is always valid", () => {
    for (const [from, to] of [
      ["planner", "final"],
      ["intent", "critic"],
      ["critic", "architect"],
      ["post-interview", "final"],
      ["final", "handoff"],
      ["final", "revision"],
      ["complete", "planner"],
    ])
      expect(isValidTransition(from!, to!)).toBe(false);
    expect(isValidTransition("final", "final")).toBe(true);
  });

  test("T, R and the known phases", () => {
    expect([...TERMINAL_PHASES].sort()).toEqual(
      ["final", "handoff", "complete", "completed", "failed", "cancelled", "canceled", "inactive"].sort(),
    );
    expect([...GUARD_RELEASE_PHASES].sort()).toEqual(
      ["complete", "completed", "failed", "cancelled", "canceled", "inactive"].sort(),
    );
    expect(KNOWN_PHASES.size).toBe(16);
    expect(isKnownPhase("handoff")).toBe(true);
    expect(isKnownPhase("inactive")).toBe(true);
    expect(isKnownPhase("ralplan")).toBe(false); // an old OMC phase (DR-21)
    expect(isKnownPhase(undefined)).toBe(false);
  });

  test("a stage write keeps a locked phase (DR-3)", () => {
    expect(advanceCurrentPhase("final", "revision")).toBe("final");
    expect(advanceCurrentPhase("complete", "planner")).toBe("complete");
    expect(advanceCurrentPhase("critic", "revision")).toBe("revision");
  });
});

describe("ledger (gjc ralplan-runtime.ts, ledger-event-renderer.ts)", () => {
  test("file names, stage_n range, body normalization and plain-hex sha256", () => {
    expect(ralplanStageFileName("planner", 1)).toBe("stage-01-planner.md");
    expect(ralplanStageFileName("disposition", 12)).toBe("stage-12-disposition.md");
    expect(parseStageN(999)).toBe(999);
    for (const bad of [0, 1000, 1.5, "1"]) expect(() => parseStageN(bad)).toThrow("Expected integer 1..999");
    expect(normalizeArtifactContent("# plan")).toBe("# plan\n");
    expect(normalizeArtifactContent("# plan\n")).toBe("# plan\n");
    const sha = sha256Hex("# plan\n");
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(sha).toBe(createHash("sha256").update("# plan\n").digest("hex"));
    expect(stageOverwriteRefusal({ stage: "critic", stageN: 2, path: "/p", existingSha256: "a", newSha256: "b" })).toEndWith(
      "Use a new stage_n to record another pass.",
    );
  });

  test("row identity dedupe and the once-per-run stuck row", () => {
    const row = ralplanStageIndexEntry({ stage: "critic", stageN: 1, path: "/r/stage-01-critic.md", createdAt: "t", sha256: "aa" });
    expect(Object.keys(row)).toEqual(["stage", "stage_n", "path", "created_at", "sha256"]);
    const stuck = ralplanPlanningStuckIndexEntry("cap", "t");
    expect(stuck).toEqual({ event: "planning_stuck", planning_stuck: true, marker: "PLANNING-STUCK", reason: "cap", created_at: "t" });
    const text = `not json\n${line(row)}${line(stuck)}`;
    expect(findJsonlDuplicate(text, { ...row, created_at: "later" }, ralplanIndexKey)).toEqual(row);
    expect(findJsonlDuplicate(text, { ...row, sha256: "bb" }, ralplanIndexKey)).toBeUndefined();
    expect(findJsonlDuplicate(text, ralplanPlanningStuckIndexEntry("lane", "t2"), ralplanPlanningStuckIndexKey)).toEqual(stuck);
    const load = loadRalplanIndexForCap(text);
    expect(load.rows).toEqual([{ stage: "critic", stageN: 1 }]); // malformed and stuck rows skipped
    expect(readRalplanPlanningStuck(load)).toBe(true);
    expect(readRalplanPlanningStuck(loadRalplanIndexForCap(line(row)))).toBe(false);
    expect(readRalplanPlanningStuck(loadRalplanIndexForCap(undefined))).toBe(false); // absent
    expect(readRalplanPlanningStuck(loadRalplanIndexForCap(undefined, true))).toBe(true); // unreadable
  });

  test("opener cap: the 5th opener is allowed, the 6th is PLANNING-STUCK", () => {
    const four = rows("planner", "architect", "critic", "revision", "revision", "revision");
    expect(evaluateRalplanIterationCap({ rows: four, stage: "revision" })).toMatchObject({ allowed: true, projectedIterations: 5, maxIterations: 5 });
    const five = [...four, { stage: "revision", stageN: 9 }];
    const stuck = evaluateRalplanIterationCap({ rows: five, stage: "planner" });
    expect(stuck).toMatchObject({ allowed: false, currentIterations: 5, projectedIterations: 6 });
    expect(evaluateRalplanIterationCap({ rows: five, stage: "critic" }).allowed).toBe(true);
    expect(evaluateRalplanIterationCap({ rows: five, stage: "final" }).allowed).toBe(true);
    expect(evaluateRalplanIterationCap({ rows: rows("planner"), stage: "revision", maxIterations: 1 }).allowed).toBe(false);
    if (stuck.allowed) throw new Error("expected a stuck decision");
    const result = buildPlanningStuckResult({ stage: "planner", stageN: 10, runId: "r1", decision: stuck, source: "default" });
    expect(result.payload).toMatchObject({ ok: false, planning_stuck: true, marker: "PLANNING-STUCK", iteration: 5, projected_iteration: 6, max_iterations: 5, max_iterations_source: "default" });
    expect(result.detail).toStartWith("PLANNING-STUCK: ralplan consensus iteration cap exceeded");
    expect(result.detail).toContain("Stop opening planner/revision passes");
  });

  test("opener cap: on-disk openers floor a wiped index (AC8)", () => {
    const names = ["stage-01-planner.md", "stage-02-revision.md", "stage-03-revision.md", "stage-04-revision.md", "stage-05-revision.md", "stage-05-critic.md", "pending-approval.md", "index.jsonl"];
    expect(countRalplanOnDiskOpeners(names)).toBe(5);
    const decision = evaluateRalplanIterationCap({ rows: [], stage: "revision", iterationFloor: countRalplanOnDiskOpeners(names) });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain("ledger under-count: index=0, on-disk openers=5");
  });

  test("lane budget: one critic per iteration, a revision resets it, disk excess counts", () => {
    const first = evaluateRalplanReviewLaneBudget({ rows: rows("planner", "architect"), stage: "critic" });
    expect(first).toMatchObject({ allowed: true, lane: "critic", projectedPasses: 1, finalSlot: true });
    expect(reviewBudgetWarning(first)).toBeUndefined(); // limit 1
    const second = evaluateRalplanReviewLaneBudget({ rows: rows("planner", "architect", "critic"), stage: "critic" });
    expect(second.allowed).toBe(false);
    if (!second.allowed) {
      const result = buildLaneBudgetStuckResult({ stage: "critic", stageN: 4, runId: "r1", decision: second, source: "default" });
      expect(result.payload).toMatchObject({ lane: "critic", passes: 1, projected_passes: 2, max_review_passes_per_lane: 1 });
      expect(result.detail).toContain("Stop re-invoking the critic review lane in this consensus iteration");
    }
    expect(evaluateRalplanReviewLaneBudget({ rows: rows("planner", "critic", "revision"), stage: "critic" }).allowed).toBe(true);
    // A duplicate row for the same (stage, stage_n) counts once.
    const dup = [{ stage: "planner", stageN: 1 }, { stage: "architect", stageN: 1 }, { stage: "architect", stageN: 1 }];
    expect(evaluateRalplanReviewLaneBudget({ rows: dup, stage: "architect", maxReviewPassesPerLane: 2 }).allowed).toBe(true);
    const lanes = countRalplanOnDiskLaneArtifacts(["stage-01-planner.md", "stage-01-critic.md"]);
    expect(lanes).toEqual({ architect: 0, critic: 1 });
    expect(evaluateRalplanReviewLaneBudget({ rows: rows("planner"), stage: "critic", onDiskLaneCounts: lanes }).allowed).toBe(false);
    const lastSlot = evaluateRalplanReviewLaneBudget({ rows: rows("planner", "critic"), stage: "critic", maxReviewPassesPerLane: 2 });
    expect(reviewBudgetWarning(lastSlot)).toEqual({ lane: "critic", passes: 2, max: 2 });
  });

  test("stages display uses words (deviation 9)", () => {
    expect(formatRalplanStagePresence(["revision", "architect", "critic"])).toBe("revision · architect · critic");
    expect(formatRalplanStagePresence(["planner", "a", "b", "c", "d", "e", "f"])).toBe("planner · a · b · c · d · e … 1 more stage");
    expect(formatRalplanStagePresence([])).toBeUndefined();
  });

  test("final admission and the duplicate receipt", () => {
    expect(resolveRalplanAutoHandoffTarget("ultragoal", "/p/open-gajae.jsonc")).toEqual({ configuredTarget: "ultragoal", effectiveTarget: "ultragoal", degradationReason: null, source: "/p/open-gajae.jsonc" });
    const stuck = resolveRalplanAutoHandoffTarget("ultragoal", "default", { planningStuck: true });
    expect(stuck).toMatchObject({ effectiveTarget: "off", degradationReason: "planning_stuck" });
    const receipt = buildDeduplicatedReceipt({
      sessionId: "s",
      runId: "r",
      stage: "final",
      stageN: 3,
      sha256: "aa",
      repositoryBinding: null,
      existing: { path: "/r/stage-03-final.md", sha256: "aa", createdAt: "t", autoHandoff: resolveRalplanAutoHandoffTarget("ultragoal", "default") },
      final: { pendingApprovalPath: "/r/pending-approval.md", planningStuck: true },
    });
    expect(receipt.payload).toMatchObject({ deduplicated: true, created_at: "t", pending_approval_path: "/r/pending-approval.md", auto_handoff: { effectiveTarget: "off", degradationReason: "planning_stuck" } });
  });
});

describe("HUD chips (gjc workflow-hud.ts, active-state.ts)", () => {
  const index = (...entries: object[]) => loadRalplanIndexForCap(entries.map(line).join(""));
  const view = (chips: WorkflowHudChip[] | undefined) =>
    (chips ?? []).map((c) => `${c.label}=${c.value}${c.severity ? `:${c.severity}` : ""}`);

  test("after a write: stage, iter, stages words, arch/crit passes, verdict colour", () => {
    const hud = buildRalplanHud({
      stage: "critic",
      pendingApproval: false,
      iteration: 3,
      reviewPassBudget: 1,
      index: index({ stage: "planner", stage_n: 1 }, { stage: "architect", stage_n: 1 }, { stage: "critic", stage_n: 1 }),
      lastReviewVerdict: "iterate",
      updatedAt: "t",
    });
    expect(view(hud.chips)).toEqual(["stage=critic", "iter=1", "stages=planner · architect · critic", "arch=1/1", "crit=1/1", "verdict=ITERATE:warning"]);
  });

  test("final: pending approval, no lane chips, handoff configured→effective[:reason]", () => {
    const final = { stage: "final", stage_n: 2, path: "/r/stage-02-final.md", sha256: "aa", auto_handoff: resolveRalplanAutoHandoffTarget("ultragoal", "default") };
    const ok = buildRalplanHud({ stage: "final", pendingApproval: true, reviewPassBudget: 1, index: index({ stage: "planner", stage_n: 1 }, { stage: "critic", stage_n: 1 }, final), lastReviewVerdict: "OKAY", updatedAt: "t" });
    expect(view(ok.chips)).toEqual(["pending=approval:warning", "stage=final", "iter=1", "stages=planner · critic · final", "verdict=OKAY:success", "handoff=ultragoal→ultragoal"]);
    const stuckFinal = { ...final, auto_handoff: resolveRalplanAutoHandoffTarget("ultragoal", "default", { planningStuck: true }) };
    const stuck = buildRalplanHud({ stage: "final", pendingApproval: true, index: index(stuckFinal, ralplanPlanningStuckIndexEntry("cap", "t")), updatedAt: "t" });
    expect(view(stuck.chips)).toContain("handoff=ultragoal→off:planning_stuck:blocked");
  });

  test("verdict severities and the state-change HUD", () => {
    const severity = (verdict: string) => buildRalplanHudSummary({ verdict }).chips?.[0]?.severity;
    expect(["BLOCK", "REJECT"].map(severity)).toEqual(["blocked", "blocked"]);
    expect(["WATCH", "ITERATE"].map(severity)).toEqual(["warning", "warning"]);
    expect(["CLEAR", "OKAY", "APPROVE"].map(severity)).toEqual(["success", "success", "success"]);
    const fromState = buildRalplanHudFromState({ current_phase: "final", last_review_verdict: "REJECT" }, "t");
    expect(view(fromState.chips)).toEqual(["pending=approval:warning", "stage=final", "verdict=REJECT:blocked"]);
  });

  test("normalization keeps the first 6 chips in array order and 80-char values (DR-9)", () => {
    const raw = buildRalplanHudSummary({
      pendingApproval: true,
      approvalStatus: "pending",
      blockedReason: "x",
      nextAction: "y",
      stage: "final",
      iteration: 1,
      stages: "post-interview · ".repeat(8),
      verdict: "OKAY",
    });
    expect(raw.chips).toHaveLength(8);
    const normalized = normalizeWorkflowHudSummary(raw);
    expect(normalized?.chips?.map((c) => c.label)).toEqual(["pending", "gate", "blocked", "next", "stage", "iter"]);
    const long = normalizeWorkflowHudSummary(buildRalplanHudSummary({ stages: "post-interview · ".repeat(8) }));
    expect(long?.chips?.[0]?.value).toHaveLength(80);
  });
});

describe("disposition (gjc ralplan-review-conflicts.ts, verbatim)", () => {
  const arch = { stage: "architect", stage_n: 1, path: "/r/stage-01-architect.md", created_at: "t", sha256: "a".repeat(64) };
  const crit = { stage: "critic", stage_n: 1, path: "/r/stage-01-critic.md", created_at: "t", sha256: "c".repeat(64) };
  const indexText = line({ stage: "planner", stage_n: 1, path: "/r/stage-01-planner.md", created_at: "t", sha256: "p".repeat(64) }) + line(arch) + line(crit);
  const receipt = (row: typeof arch) => ({ stage: row.stage, stageN: 1, path: row.path, sha256: row.sha256 });
  const findings = [
    { findingId: "arch-1", targetId: "contract.field", action: "remove", severity: "block", evidence: "duplicate", sourceRole: "architect", sourceReceipt: receipt(arch) },
    { findingId: "crit-1", targetId: "contract.field", action: "add", severity: "watch", evidence: "needed", sourceRole: "critic", sourceReceipt: receipt(crit) },
  ];
  const disposition = { conflictId: "conflict:contract.field:arch-1:crit-1", choice: "accept_architect", rationale: "ok", decisionOwner: "ralplan-leader", affectedSections: ["## Contracts"] };
  const doc = (over: Record<string, unknown>) => JSON.stringify({ schema: "ralplan.review_conflicts.v1", plannerStageN: 1, findings, dispositions: [disposition], ...over });

  test("a dispositioned conflict is re-serialized canonically", () => {
    const body = normalizeDispositionArtifact(doc({}), 1, indexText);
    expect(body.endsWith("}\n")).toBe(true);
    expect(JSON.parse(body).conflicts[0].status).toBe("dispositioned");
  });

  test("plannerStageN mismatch, forged receipt, open conflict and orphan disposition are refused", () => {
    expect(() => normalizeDispositionArtifact(doc({}), 2, indexText)).toThrow(
      /^invalid ralplan disposition artifact: .*plannerStageN=1 does not match CLI --stage_n=2/,
    );
    const forged = [{ ...findings[0], sourceReceipt: { ...receipt(arch), path: "/tmp/spoofed-architect.md" } }, findings[1]];
    expect(() => normalizeDispositionArtifact(doc({ findings: forged }), 1, indexText)).toThrow(/does not match indexed architect stage 1/);
    expect(() => normalizeDispositionArtifact(doc({ dispositions: [] }), 1, indexText)).toThrow(/Join blocked: 1 open conflict/);
    const noConflict = [findings[0], { ...findings[1], action: "clarify" }];
    expect(() => normalizeDispositionArtifact(doc({ findings: noConflict }), 1, indexText)).toThrow(/unknown conflict id/);
  });
});

describe("compaction recovery (gjc workflow-recovery-projection.ts, agent-session.ts)", () => {
  const runDir = "/s/plans/ralplan/r1";
  const plan = "# Plan\n\nShip the ralplan tool.\n\n## Scope\n- ledger\n\n## Non-goals\n- TUI\n\n## Acceptance Criteria\n- tests pass\n\n## Intent Reconciliation\n- confirm cap\n";
  const draft = "# Draft\n\nFirst draft.\n";
  const files = new Map<string, string>([
    [`${runDir}/stage-01-planner.md`, draft],
    [`${runDir}/stage-02-revision.md`, draft.replace("First", "Second")],
    [`${runDir}/stage-03-final.md`, plan],
  ]);
  const readArtifact = async (p: string) => {
    const text = files.get(p);
    return text === undefined ? undefined : new TextEncoder().encode(text);
  };
  const stageRow = (stage: string, n: number, body: string) =>
    line({ stage, stage_n: n, path: `${runDir}/stage-0${n}-${stage}.md`, created_at: "t", sha256: sha256Hex(body) });
  const planning = stageRow("planner", 1, draft) + stageRow("revision", 2, draft.replace("First", "Second"));
  const run = ralplanRecoveryRunFromState({ run_id: "r1", last_review_verdict: "OKAY", last_review_verdict_lane: "critic" })!;

  test("a valid final projects and renders the contract with Intent Reconciliation", async () => {
    const projection = await projectRalplanRun({ ...run, runDir, indexText: planning + stageRow("final", 3, plan), readArtifact });
    expect(projection).toMatchObject({ source: "ralplan-final", objective: "Ship the ralplan tool.", unresolved: ["confirm cap"], nextAction: { actionClass: "awaiting-approval" } });
    expect(renderRalplanRecoveryContext(projection!)).toEqual([
      "Workflow contract (ralplan): Ship the ralplan tool.",
      "Accepted scope: ledger",
      "Non-goals: TUI",
      "Acceptance criteria: tests pass",
      "Intent Reconciliation: confirm cap",
      "Next action: awaiting-approval",
      `Contract digest: sha256:${sha256Hex(plan)}`,
    ]);
  });

  test("a tampered artifact, a malformed index or an unsafe run id projects nothing", async () => {
    const tampered = stageRow("final", 3, `${plan}extra\n`);
    expect(await projectRalplanRun({ ...run, runDir, indexText: planning + tampered, readArtifact })).toBeUndefined();
    expect(await projectRalplanRun({ ...run, runDir, indexText: `${planning}{oops\n`, readArtifact })).toBeUndefined();
    expect(ralplanRecoveryRunFromState({ run_id: "../r1" })).toBeUndefined();
    expect(ralplanRecoveryRunFromState(undefined)).toBeUndefined();
  });

  test("without a final the newest planner/revision is used", async () => {
    const projection = await projectRalplanRun({ ...run, runDir, indexText: planning, readArtifact });
    expect(projection).toMatchObject({
      source: "ralplan-run",
      objective: "Second draft.",
      provenance: { stage: "revision" },
      nextAction: { actionClass: "reconcile-intent", detail: "revision-without-intent-receipt" },
    });
    expect(await projectRalplanRun({ ...run, runDir, indexText: planning, readArtifact }, true)).toBeUndefined();
  });
});

describe("temp paths (gjc workflow-mutation-guard.ts:1698-1766, DR-11)", () => {
  async function fixture(run: (dir: string, project: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "open-gajae-temp-"));
    const project = join(dir, "project");
    await mkdir(project);
    try {
      await run(dir, project);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("temp paths: /tmp and os.tmpdir() files are neutral; project paths and temp symlinks into the project are not", async () =>
    fixture(async (dir, project) => {
      const fixed = await mkdtemp("/tmp/open-gajae-temp-");
      try {
        await writeFile(join(fixed, "plan.md"), "fixed");
        expect(await isNeutralTempPath(join(fixed, "plan.md"), project)).toBe(true);
      } finally {
        await rm(fixed, { recursive: true, force: true });
      }
      await writeFile(join(dir, "plan.md"), "scratch");
      expect(await isNeutralTempPath(join(dir, "plan.md"), project)).toBe(true);
      // The project itself sits under the temp root, yet its files never count.
      await writeFile(join(project, "plan.md"), "product");
      expect(await isNeutralTempPath(join(project, "plan.md"), project)).toBe(false);
      expect(await isNeutralTempPath("plan.md", project)).toBe(false);
      await symlink(join(project, "plan.md"), join(dir, "link.md"));
      expect(await isNeutralTempPath(join(dir, "link.md"), project)).toBe(false);
      await symlink(project, join(dir, "linkdir"));
      expect(await isNeutralTempPath(join(dir, "linkdir", "new.md"), project)).toBe(
        false,
      );
    }));

  test("readTempArtifact reads a regular temp file and refuses symlinks and project paths", async () =>
    fixture(async (dir, project) => {
      await writeFile(join(dir, "plan.md"), "# Plan\n");
      expect(await readTempArtifact(join(dir, "plan.md"), project)).toBe("# Plan\n");
      await symlink(join(dir, "plan.md"), join(dir, "alias.md"));
      await expect(readTempArtifact(join(dir, "alias.md"), project)).rejects.toThrow(
        "failed to read ralplan write path",
      );
      await writeFile(join(project, "plan.md"), "product");
      await expect(readTempArtifact(join(project, "plan.md"), project)).rejects.toThrow(
        "ralplan write path must be a file under an OS temp directory outside the project",
      );
    }));
});
