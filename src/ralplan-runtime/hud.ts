// Ralplan HUD chips for `state/active/ralplan.json` (`hud`), recomputed by the
// `ralplan` tool on every state or ledger change (spec D-H5, D-H7). Nothing
// draws them yet: the TUI sidebar is deferred (R-OD17, README follow-up 6).
// Pure: the caller passes the stage, the parsed index and the state fields.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `skill-state/workflow-hud.ts:20-39` (`RalplanHudState`), `:188-248`
//   (`buildRalplanHudSummary`); the chip helpers, the HUD types and
//   `normalizeWorkflowHudSummary` (DR-9) are shared in `../skill-state/hud.ts`
//   and re-exported here
// - `gjc-runtime/ralplan-runtime.ts:1933-1983` (`buildRalplanHud`, after a
//   write or start) and `gjc-runtime/state-runtime.ts:846-866` (the ralplan
//   branch of `buildHudForMode`, after a state change)
// The stage is an explicit input (DR-8, R-OD5, gjc as-is): after a write it is
// the stage just written, after start/state the resulting `current_phase`.
// Deviation 9: the `stages` chip holds full stage words
// (`formatRalplanStagePresence` in `./ledger.ts`). Only the ralplan builder
// is here: the ultragoal one is `../ultragoal-runtime/hud.ts` and the
// deep-interview one `../deep-interview-runtime/hud.ts`.

import {
  chip,
  compactChips,
  gateChips,
  type WorkflowGateHudState,
  type WorkflowHudChip,
  type WorkflowHudSummary,
} from "../skill-state/hud.js";
import {
  formatRalplanStagePresence,
  type RalplanAutoHandoffResolution,
  type RalplanIndexLoad,
  readRalplanFinalAdmission,
  readRalplanPlanningStuck,
  summarizeRalplanIndex,
} from "./ledger.js";

export {
  normalizeWorkflowHudSummary,
  type WorkflowHudChip,
  type WorkflowHudSummary,
} from "../skill-state/hud.js";

export interface RalplanHudState extends WorkflowGateHudState {
  stage?: string;
  waiting?: string;
  iteration?: number;
  iterationFromIndex?: number;
  stages?: string;
  architectPasses?: number;
  criticPasses?: number;
  reviewPassBudget?: number;
  verdict?: string;
  latestSummary?: string;
  pendingApproval?: boolean;
  autoHandoff?: {
    configuredTarget: string;
    effectiveTarget: string;
    degradationReason: string | null;
  };
  planningStuck?: boolean;
  updatedAt?: string;
}

export function buildRalplanHudSummary(state: RalplanHudState): WorkflowHudSummary {
  const verdict = state.verdict?.toUpperCase();
  const verdictSeverity =
    verdict === "BLOCK" || verdict === "REJECT"
      ? "blocked"
      : verdict === "ITERATE" || verdict === "WATCH"
        ? "warning"
        : verdict === "APPROVE" || verdict === "CLEAR" || verdict === "OKAY"
          ? "success"
          : undefined;
  const reviewPassChip = (
    label: "arch" | "crit",
    passes: number | undefined,
    priority: number,
  ): WorkflowHudChip | null => {
    if (
      state.pendingApproval ||
      typeof passes !== "number" ||
      !Number.isFinite(passes) ||
      passes <= 0 ||
      typeof state.reviewPassBudget !== "number" ||
      !Number.isFinite(state.reviewPassBudget) ||
      state.reviewPassBudget <= 0
    ) {
      return null;
    }
    return chip(label, `${passes}/${state.reviewPassBudget}`, priority);
  };
  const handoffValue = state.autoHandoff
    ? `${state.autoHandoff.configuredTarget}→${state.autoHandoff.effectiveTarget}${
        state.autoHandoff.degradationReason
          ? `:${state.autoHandoff.degradationReason}`
          : ""
      }`
    : undefined;
  const handoffSeverity = state.planningStuck
    ? "blocked"
    : state.autoHandoff?.degradationReason
      ? "warning"
      : undefined;
  return {
    version: 1,
    summary: state.latestSummary,
    chips: compactChips([
      state.pendingApproval
        ? { label: "pending", value: "approval", priority: 5, severity: "warning" }
        : null,
      ...gateChips(state, 6),
      chip("stage", state.stage, 10),
      chip("waiting", state.waiting, 20),
      chip(
        "iter",
        (state.iterationFromIndex ?? state.iteration) === undefined
          ? undefined
          : String(state.iterationFromIndex ?? state.iteration),
        30,
      ),
      chip("stages", state.stages, 35),
      reviewPassChip("arch", state.architectPasses, 36),
      reviewPassChip("crit", state.criticPasses, 38),
      chip("verdict", verdict, 40, verdictSeverity),
      chip("handoff", handoffValue, 45, handoffSeverity),
    ]),
    ...(state.updatedAt ? { updated_at: state.updatedAt } : {}),
  };
}

/**
 * gjc `buildRalplanHud` without the reads: after a write (`stage` = the stage
 * just written, `iteration` = its stage_n) or start (`planner`, 1). With
 * `index`, iteration, stages, lane passes, final admission and the stuck flag
 * come from the run ledger; `lastReviewVerdict` comes from the state.
 */
export function buildRalplanHud(options: {
  stage: string;
  pendingApproval: boolean;
  iteration?: number;
  latestSummary?: string;
  reviewPassBudget?: number;
  index?: RalplanIndexLoad;
  lastReviewVerdict?: string;
  updatedAt: string;
}): WorkflowHudSummary {
  let iterationFromIndex: number | undefined;
  let stages: string | undefined;
  let architectPasses: number | undefined;
  let criticPasses: number | undefined;
  let autoHandoff: RalplanAutoHandoffResolution | undefined;
  let planningStuck = false;
  if (options.index) {
    autoHandoff = readRalplanFinalAdmission(options.index.rawText);
    planningStuck = readRalplanPlanningStuck(options.index);
    const rows = options.index.rows;
    if (rows.length > 0) {
      const summary = summarizeRalplanIndex(rows);
      iterationFromIndex = summary.iteration;
      stages = formatRalplanStagePresence(summary.currentStages);
      architectPasses = summary.currentStages.filter((stage) => stage === "architect").length;
      criticPasses = summary.currentStages.filter((stage) => stage === "critic").length;
    }
  }
  return buildRalplanHudSummary({
    stage: options.stage,
    iteration: options.iteration,
    iterationFromIndex,
    stages,
    architectPasses,
    criticPasses,
    reviewPassBudget: options.reviewPassBudget,
    verdict: options.lastReviewVerdict,
    autoHandoff,
    planningStuck,
    pendingApproval: options.pendingApproval,
    latestSummary: options.latestSummary,
    updatedAt: options.updatedAt,
  });
}

/**
 * The ralplan branch of gjc `buildHudForMode`: chips from the state payload
 * alone after a state change (stage = `current_phase`).
 */
export function buildRalplanHudFromState(
  payload: Record<string, unknown>,
  updatedAt: string,
): WorkflowHudSummary {
  const stage =
    typeof payload.current_phase === "string"
      ? payload.current_phase
      : typeof payload.mode === "string"
        ? payload.mode
        : undefined;
  const rawVerdict = payload.last_review_verdict ?? payload.verdict;
  const verdict = typeof rawVerdict === "string" ? rawVerdict : undefined;
  const iteration =
    typeof payload.iteration === "number" ? payload.iteration : undefined;
  const pendingApproval = payload.pending_approval === true || stage === "final";
  return buildRalplanHudSummary({
    stage,
    verdict,
    iteration,
    pendingApproval,
    updatedAt,
  });
}
