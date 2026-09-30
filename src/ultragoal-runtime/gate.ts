// Ultragoal quality-gate validation (plan C-8, D-VF3~6, D-VF12, DR-18): the
// per-goal gate and the final gate, with gjc camelCase field names (PQ-8 A),
// the strict pass vocabulary (D-VF6), and every defect collected as
// `{path, code, message}` in one pass. Pure: `checkpoint(complete)` and
// `validate_gate` share it; the caller picks the kind from the completion
// view (`./plan.ts` `completionView`) and passes the goal's active criteria.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/ultragoal-runtime.ts:320-326` (`CLEAR`, `APPROVE`, `passed`,
//   accepted proof statuses), `:1424-1510` (`qualityGateObject`,
//   `nonEmptyStringArray`, the diagnostic type, `QualityGateDiagnostics`,
//   `requireNonEmptyString`, `requireEmptyBlockers`), `:1548-1553`
//   (`requireSuccessStatus`), `:1584-1598` (duplicate and unknown ids),
//   `:2508-2511` (targeted verification), `:2641-2725` (`validateReviewCohort`),
//   `:2727-2981` (`validateCompletionQualityGate`: unsupported keys, missing
//   sections, final critic, architect review), `:3422-3446` (validate target
//   and its `unknown_goal` / `not_an_object` diagnostics)
// Deviations (plan §7.1):
// - 14, 15, 16, 28: the per-goal gate is `targetedVerification`,
//   `architectReview` (three statuses + recommendation, no `commands`) and
//   `criteriaCoverage` (exactly one row per active criterion); the final gate
//   adds top-level `reviewCohort` (lanes cleaner `PASS`, architect `CLEAR`, qa
//   `passed` with commands and adversarial cases; no `sourceHash`, generation
//   2+ needs `deltaOnly` and `deltaPaths`) and `criticReview`. No
//   `executorQa`, `iteration`, batch or lane-selection sections.
// - 41: messages name the op call `checkpoint(status: complete)`, not
//   `checkpoint --status complete`.
// DR-18 (D-VF4): gjc stops after missing sections; here the remaining
// sections are still checked so one list holds every defect. The known
// top-level keys are the same for both kinds (as in gjc); a per-goal gate's
// `reviewCohort` and `criticReview` are not checked, as gjc checks the critic
// only when final. Cohort defects all carry gjc's `review_cohort_invalid`.

import type { ReceiptKind } from "./receipt.js";

export interface GateDiagnostic {
  path: string;
  code: string;
  message: string;
}

export const PER_GOAL_GATE_KEYS = ["targetedVerification", "architectReview", "criteriaCoverage"] as const;
export const FINAL_GATE_KEYS = [...PER_GOAL_GATE_KEYS, "reviewCohort", "criticReview"] as const;
/** gjc `ACCEPTED_PROOF_STATUSES` without `not_applicable` (`requireSuccessStatus`). */
export const COVERED_STATUSES = ["covered", "passed", "verified"] as const;
const COHORT_LANES = ["cleaner", "architect", "qa"] as const;
const LANE_PASS: Record<(typeof COHORT_LANES)[number], string> = {
  cleaner: "PASS",
  architect: "CLEAR",
  qa: "passed",
};

type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** gjc `nonEmptyStringArray`. */
function nonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

class Diagnostics {
  readonly found: GateDiagnostic[] = [];
  add(path: string, code: string, message: string): void {
    this.found.push({ path, code, message });
  }
  /** gjc `requireNonEmptyString`. */
  evidence(section: Json, path: string): void {
    if (!nonEmptyString(section.evidence))
      this.add(`${path}.evidence`, "missing_evidence", `qualityGate ${path}.evidence must be a non-empty string`);
  }
  /** gjc `requireEmptyBlockers`. */
  blockers(section: Json, path: string): void {
    if (!Array.isArray(section.blockers) || section.blockers.length !== 0)
      this.add(`${path}.blockers`, "non_empty_blockers", `qualityGate ${path}.blockers must be an empty blockers array`);
  }
  commands(section: Json, path: string, key: string, code = "missing_command_array"): void {
    if (!nonEmptyStringArray(section[key]))
      this.add(`${path}.${key}`, code, `qualityGate ${path}.${key} must be a non-empty string array`);
  }
}

function checkTargetedVerification(found: Diagnostics, section: Json): void {
  if (section.status !== "passed")
    found.add(
      "targetedVerification.status",
      "targeted_verification_not_passed",
      "qualityGate targetedVerification.status must be passed",
    );
  found.commands(section, "targetedVerification", "commands");
  found.evidence(section, "targetedVerification");
}

function checkArchitectReview(found: Diagnostics, section: Json): void {
  if (
    section.architectureStatus !== "CLEAR" ||
    section.productStatus !== "CLEAR" ||
    section.codeStatus !== "CLEAR" ||
    section.recommendation !== "APPROVE"
  )
    found.add(
      "architectReview",
      "architect_not_clear",
      "checkpoint(status: complete) requires architect review approval: architectReview architecture/product/code must be CLEAR and recommendation must be APPROVE",
    );
  found.evidence(section, "architectReview");
  found.blockers(section, "architectReview");
}

function checkCriteriaCoverage(
  found: Diagnostics,
  value: unknown,
  activeCriterionIds: readonly string[] | undefined,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    found.add(
      "criteriaCoverage",
      "criteria_coverage_invalid",
      "qualityGate criteriaCoverage must be a non-empty object array",
    );
    return;
  }
  const seen = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const path = `criteriaCoverage[${index}]`;
    const row = object(raw);
    if (!row) {
      found.add(path, "criteria_coverage_invalid", `qualityGate ${path} must be an object`);
      continue;
    }
    if (!nonEmptyString(row.criterionId)) {
      found.add(`${path}.criterionId`, "criteria_coverage_invalid", `qualityGate ${path}.criterionId must be a non-empty string`);
    } else {
      const id = (row.criterionId as string).trim();
      if (seen.has(id))
        found.add(`${path}.criterionId`, "duplicate_criterion", `qualityGate criteriaCoverage contains duplicate id ${id}`);
      else if (activeCriterionIds && !activeCriterionIds.includes(id))
        found.add(`${path}.criterionId`, "unknown_criterion", `qualityGate criteriaCoverage references unknown id ${id}`);
      seen.add(id);
    }
    if (!(COVERED_STATUSES as readonly unknown[]).includes(row.status))
      found.add(
        `${path}.status`,
        "criterion_not_covered",
        `qualityGate ${path}.status must be covered, passed, or verified`,
      );
    found.evidence(row, path);
  }
  for (const id of activeCriterionIds ?? [])
    if (!seen.has(id))
      found.add("criteriaCoverage", "missing_criterion", `qualityGate criteriaCoverage is missing active criterion ${id}`);
}

const COHORT = "review_cohort_invalid";

/** gjc `validateReviewCohort` without source hashes; every defect collected. */
function checkReviewCohort(found: Diagnostics, value: unknown): void {
  const cohort = object(value);
  if (!cohort) {
    found.add("reviewCohort", COHORT, "qualityGate reviewCohort is required at the review boundary");
    return;
  }
  const generation = cohort.reviewGeneration;
  const validGeneration = typeof generation === "number" && Number.isInteger(generation) && generation >= 1;
  if (!validGeneration)
    found.add("reviewCohort.reviewGeneration", COHORT, "reviewCohort.reviewGeneration must be an integer >= 1");
  if (cohort.joined !== true)
    found.add(
      "reviewCohort.joined",
      COHORT,
      "reviewCohort.joined must be true: all lane findings must join before checkpoint",
    );
  const lanes = object(cohort.lanes);
  if (!lanes) {
    found.add("reviewCohort.lanes", COHORT, "reviewCohort.lanes is required");
  } else {
    const unsupported = Object.keys(lanes).filter((key) => !(COHORT_LANES as readonly string[]).includes(key));
    if (unsupported.length > 0)
      found.add("reviewCohort.lanes", COHORT, `reviewCohort.lanes contains unsupported lanes: ${unsupported.join(", ")}`);
    for (const lane of COHORT_LANES) {
      const path = `reviewCohort.lanes.${lane}`;
      if (Array.isArray(lanes[lane])) {
        found.add(path, COHORT, `${path} must be one lane per generation, not a list`);
        continue;
      }
      const record = object(lanes[lane]);
      if (!record) {
        found.add(path, COHORT, `${path} is required`);
        continue;
      }
      if (record.status !== LANE_PASS[lane])
        found.add(`${path}.status`, COHORT, `${path}.status must be ${LANE_PASS[lane]}`);
      if (lane === "qa") {
        found.commands(record, path, "commands", COHORT);
        found.commands(record, path, "adversarialCases", COHORT);
      }
      if (!nonEmptyString(record.evidence))
        found.add(`${path}.evidence`, COHORT, `qualityGate ${path}.evidence must be a non-empty string`);
      if (!Array.isArray(record.blockers) || record.blockers.length !== 0)
        found.add(`${path}.blockers`, COHORT, `qualityGate ${path}.blockers must be an empty blockers array`);
    }
  }
  if (!validGeneration) return;
  if ((generation as number) > 1) {
    if (cohort.deltaOnly !== true)
      found.add("reviewCohort.deltaOnly", COHORT, "reviewCohort.deltaOnly must be true for reviewGeneration > 1");
    const deltaPaths = Array.isArray(cohort.deltaPaths)
      ? cohort.deltaPaths.filter((path) => nonEmptyString(path))
      : [];
    if (deltaPaths.length === 0)
      found.add("reviewCohort.deltaPaths", COHORT, "reviewCohort.deltaPaths must be non-empty for reviewGeneration > 1");
    const expansion = object(cohort.scopeExpansion);
    if (expansion)
      for (const key of ["severity", "novelty", "justification"])
        if (!nonEmptyString(expansion[key]))
          found.add(
            `reviewCohort.scopeExpansion.${key}`,
            COHORT,
            `qualityGate reviewCohort.scopeExpansion.${key} must be a non-empty string`,
          );
  } else if (cohort.deltaOnly === true) {
    found.add("reviewCohort.deltaOnly", COHORT, "reviewCohort.deltaOnly cannot be true for the first reviewGeneration");
  }
}

function checkCriticReview(found: Diagnostics, value: unknown): void {
  const critic = object(value);
  if (critic?.verdict !== "OKAY")
    found.add(
      "criticReview.verdict",
      "critic_verdict_not_okay",
      "checkpoint(status: complete) (final aggregate) requires criticReview with verdict OKAY, non-empty evidence, and empty blockers",
    );
  if (critic) {
    found.evidence(critic, "criticReview");
    found.blockers(critic, "criticReview");
  }
}

/**
 * Every defect of `gate` for a `receiptKind` checkpoint. `activeCriterionIds`
 * are the goal's active criteria; without them only the row shapes and
 * duplicates of `criteriaCoverage` are checked. An empty list means valid.
 */
export function validateGate(
  gate: unknown,
  options: { receiptKind: ReceiptKind; activeCriterionIds?: readonly string[] },
): GateDiagnostic[] {
  const record = object(gate);
  if (!record) return [{ path: "qualityGate", code: "not_an_object", message: "qualityGate must be a JSON object" }];
  const found = new Diagnostics();
  const unsupported = Object.keys(record).filter((key) => !(FINAL_GATE_KEYS as readonly string[]).includes(key));
  if (unsupported.length > 0)
    found.add("qualityGate", "unsupported_keys", `qualityGate contains unsupported keys: ${unsupported.join(", ")}`);
  const missing = PER_GOAL_GATE_KEYS.filter((key) =>
    key === "criteriaCoverage" ? record[key] === undefined : !object(record[key]),
  );
  if (missing.length > 0)
    found.add("qualityGate", "missing_required_sections", `qualityGate requires ${listPhrase(missing)} objects`);
  const targeted = object(record.targetedVerification);
  if (targeted) checkTargetedVerification(found, targeted);
  const architect = object(record.architectReview);
  if (architect) checkArchitectReview(found, architect);
  if (record.criteriaCoverage !== undefined)
    checkCriteriaCoverage(found, record.criteriaCoverage, options.activeCriterionIds);
  if (options.receiptKind === "final-aggregate") {
    checkReviewCohort(found, record.reviewCohort);
    checkCriticReview(found, record.criticReview);
  }
  return found.found;
}
