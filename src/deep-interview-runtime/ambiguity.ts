// The runtime-owned ambiguity of a deep-interview (spec D-RS2, plan DR-5 step
// 7, DR-6): `current_ambiguity` derives from the latest scored round, and a
// deterministic floor from the persisted evidence clamps it. Pure.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/deep-interview-ambiguity.ts:32-121` (weights,
//   `isUnresolvedDisputedFact`, `countUnscoredActiveComponents`,
//   `computeAmbiguityFloor`), `:123-128` (`clampReportedAmbiguity`),
//   `:165-206` (`applyAmbiguityFloorToEnvelope`; its normalize call is the
//   read boundary here)
// - `gjc-runtime/deep-interview-stage.ts:485-512` (`deriveRuntimeAmbiguity`)
// Deviation 4 (D-RS2, D-RS4): the floor has no auto-answer term, so the
// breakdown has no `auto_answer_ratio`.

import { type DeepInterviewEnvelope, normalizeForRead } from "./envelope.js";

type Json = Record<string, unknown>;

const DISPUTED_FACT_WEIGHT = 0.1;
const UNSCORED_COMPONENT_WEIGHT = 0.05;
const CORE_CLARITY_DIMENSIONS = ["goal", "constraints", "criteria"] as const;

export interface AmbiguityFloorBreakdown {
  floor: number;
  disputed_fact_count: number;
  unscored_active_component_count: number;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A disputed fact presses until `superseded_by` resolves it. */
function isUnresolvedDisputedFact(value: unknown): boolean {
  if (!isRecord(value) || value.disputed !== true) return false;
  return typeof value.superseded_by !== "string" || value.superseded_by.trim() === "";
}

/**
 * An active component of a confirmed topology is unscored while a core clarity
 * dimension lacks a finite score; deferred components are left out.
 */
function countUnscoredActiveComponents(topology: unknown): number {
  if (!isRecord(topology) || topology.status !== "confirmed") return 0;
  let unscored = 0;
  for (const component of asArray(topology.components)) {
    if (!isRecord(component) || component.status === "deferred") continue;
    const clarity = isRecord(component.clarity_scores) ? component.clarity_scores : {};
    const incomplete = CORE_CLARITY_DIMENSIONS.some((dimension) => {
      const score = clarity[dimension];
      return typeof score !== "number" || !Number.isFinite(score);
    });
    if (incomplete) unscored += 1;
  }
  return unscored;
}

/** gjc `computeAmbiguityFloor` without the auto-answer term (deviation 4). */
export function computeAmbiguityFloor(inner: unknown): AmbiguityFloorBreakdown {
  const state = isRecord(inner) ? inner : {};
  const disputedFactCount = asArray(state.established_facts).filter(isUnresolvedDisputedFact).length;
  const unscoredActiveComponentCount = countUnscoredActiveComponents(state.topology);
  const floor =
    DISPUTED_FACT_WEIGHT * disputedFactCount + UNSCORED_COMPONENT_WEIGHT * unscoredActiveComponentCount;
  return {
    floor: round2(Math.min(1, Math.max(0, floor))),
    disputed_fact_count: disputedFactCount,
    unscored_active_component_count: unscoredActiveComponentCount,
  };
}

/** gjc `clampReportedAmbiguity`: `max(reported, floor)`, within [0, 1]. */
export function clampReportedAmbiguity(
  reported: number,
  floor: number,
): { effective: number; clamped: boolean } {
  const bounded = Math.min(1, Math.max(0, reported));
  if (floor > bounded) return { effective: Math.min(1, floor), clamped: true };
  return { effective: bounded, clamped: false };
}

/**
 * gjc `applyAmbiguityFloorToEnvelope`: recompute the floor, clamp
 * `state.current_ambiguity` and the latest scored round (keeping the reported
 * value as `reported_ambiguity`), and record `state.ambiguity_floor`. Earlier
 * rounds are never rewritten. Non-mutating.
 */
export function applyAmbiguityFloorToEnvelope(value: unknown): {
  envelope: DeepInterviewEnvelope;
  breakdown: AmbiguityFloorBreakdown;
  clamped: boolean;
} {
  const envelope = normalizeForRead(value);
  const inner: Json = { ...envelope.state };
  const breakdown = computeAmbiguityFloor(inner);
  let clamped = false;

  const rounds = asArray(inner.rounds).filter(isRecord);
  let latestScoredIndex = -1;
  for (let index = 0; index < rounds.length; index += 1) {
    const candidate = rounds[index] as Json;
    if (candidate.lifecycle !== "scored" || !Number.isFinite(candidate.round)) continue;
    if (latestScoredIndex < 0 || (candidate.round as number) >= ((rounds[latestScoredIndex] as Json).round as number))
      latestScoredIndex = index;
  }
  if (latestScoredIndex >= 0) {
    const latest = rounds[latestScoredIndex] as Json;
    if (typeof latest.ambiguity === "number") {
      const clampedRound = clampReportedAmbiguity(latest.ambiguity, breakdown.floor);
      if (clampedRound.clamped) {
        const nextRounds = [...rounds];
        nextRounds[latestScoredIndex] = {
          ...latest,
          reported_ambiguity: latest.reported_ambiguity ?? latest.ambiguity,
          ambiguity: clampedRound.effective,
          ambiguity_floor: breakdown.floor,
        };
        inner.rounds = nextRounds;
        clamped = true;
      }
    }
  }

  if (typeof inner.current_ambiguity === "number") {
    const clampedCurrent = clampReportedAmbiguity(inner.current_ambiguity, breakdown.floor);
    if (clampedCurrent.clamped) {
      inner.current_ambiguity = clampedCurrent.effective;
      clamped = true;
    }
  }

  inner.ambiguity_floor = breakdown;
  return { envelope: { ...envelope, state: inner }, breakdown, clamped };
}

/**
 * gjc `deriveRuntimeAmbiguity`: `state.current_ambiguity` is the latest valid
 * scored round's (finite `round` and `ambiguity`; a later record wins a tie),
 * else the previous state's value, else absent; a model-written value never
 * survives. Then the floor clamps it.
 */
export function deriveRuntimeAmbiguity(merged: unknown, previous: unknown): DeepInterviewEnvelope {
  const envelope = normalizeForRead(merged);
  const state: Json = { ...envelope.state };
  let latestScored: Json | undefined;
  for (const round of asArray(state.rounds).filter(isRecord)) {
    if (round.lifecycle !== "scored") continue;
    if (typeof round.ambiguity !== "number" || !Number.isFinite(round.ambiguity)) continue;
    if (typeof round.round !== "number" || !Number.isFinite(round.round)) continue;
    if (!latestScored || round.round >= (latestScored.round as number)) latestScored = round;
  }
  if (latestScored) {
    state.current_ambiguity = latestScored.ambiguity;
  } else {
    const prior = isRecord(previous) && isRecord(previous.state) ? previous.state.current_ambiguity : undefined;
    if (typeof prior === "number" && Number.isFinite(prior)) state.current_ambiguity = prior;
    else delete state.current_ambiguity;
  }
  return applyAmbiguityFloorToEnvelope({ ...envelope, state }).envelope;
}
