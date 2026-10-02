// Deep-interview HUD chips for `state/active/deep-interview.json` (`hud`),
// rebuilt on every state change and on both sides of a handoff (spec D-HL1,
// plan DR-17). Nothing draws them: the TUI is out of scope (deviation 23).
// Pure; the row writer normalizes the summary.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/skill-state/workflow-hud.ts:9-18`
// (`DeepInterviewHudState`), `:83-97` (`buildDeepInterviewHudSummary`, gate
// chips included), `:99-186` (`deriveDeepInterviewHud`,
// `latestScoredAmbiguity`, `weakestDimensionFromTopology`). The chip helpers
// are shared in `../skill-state/hud.ts`. The envelope passes the read
// boundary first (plan C-2); otherwise no deviation.

import {
  chip,
  compactChips,
  gateChips,
  type WorkflowGateHudState,
  type WorkflowHudSummary,
} from "../skill-state/hud.js";
import { normalizeForRead } from "./envelope.js";

type Json = Record<string, unknown>;

export interface DeepInterviewHudState extends WorkflowGateHudState {
  phase?: string;
  ambiguity?: number;
  threshold?: number;
  roundCount?: number;
  targetComponent?: string;
  weakestDimension?: string;
  specStatus?: string;
  updatedAt?: string;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function percent(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return `${Math.round(value * 100)}%`;
}

/** gjc `buildDeepInterviewHudSummary`. */
export function buildDeepInterviewHudSummary(state: DeepInterviewHudState): WorkflowHudSummary {
  return {
    version: 1,
    chips: compactChips([
      ...gateChips(state, 5),
      chip("phase", state.phase, 10),
      chip("ambiguity", [percent(state.ambiguity), percent(state.threshold)].filter(Boolean).join("/"), 20),
      chip("round", state.roundCount === undefined ? undefined : String(state.roundCount), 30),
      chip("target", state.targetComponent, 40),
      chip("weakest", state.weakestDimension, 50),
      chip("spec", state.specStatus, 60),
    ]),
    ...(state.updatedAt ? { updated_at: state.updatedAt } : {}),
  };
}

export interface DeepInterviewHudDeriveOptions {
  phase?: string;
  specStatus?: string;
  updatedAt?: string;
}

function latestScoredAmbiguity(rounds: unknown): number | undefined {
  if (!Array.isArray(rounds)) return undefined;
  for (let index = rounds.length - 1; index >= 0; index--) {
    const round = rounds[index];
    if (isRecord(round) && round.lifecycle === "scored" && typeof round.ambiguity === "number")
      return round.ambiguity;
  }
  return undefined;
}

function weakestDimensionFromTopology(topology: Json, targetComponent: string | undefined): string | undefined {
  if (!Array.isArray(topology.components)) return undefined;
  const components = topology.components.filter(isRecord);
  const dimensionOf = (component: Json): string | undefined =>
    typeof component.weakest_dimension === "string" && component.weakest_dimension.trim()
      ? component.weakest_dimension
      : undefined;
  if (targetComponent) {
    const targeted = components.find((component) => component.id === targetComponent && dimensionOf(component));
    if (targeted) return dimensionOf(targeted);
  }
  const active = components.find((component) => component.status !== "deferred" && dimensionOf(component));
  if (active) return dimensionOf(active);
  const any = components.find((component) => dimensionOf(component));
  return any ? dimensionOf(any) : undefined;
}

/**
 * The facts gjc `deriveDeepInterviewHud` reads from a whole mode-state
 * envelope; the compaction context reads the same ones (plan DR-22).
 * `target`/`weakest` come from `state.topology` (none for `legacy_missing`);
 * a field missing under `state` falls back to the top level, as in gjc.
 */
export function deepInterviewHudFacts(
  value: unknown,
): Pick<
  DeepInterviewHudState,
  "phase" | "ambiguity" | "threshold" | "roundCount" | "targetComponent" | "weakestDimension"
> {
  const payload = normalizeForRead(value);
  const stateField = payload.state;
  const isNumber = (item: unknown): item is number => typeof item === "number" && Number.isFinite(item);
  const isArray = (item: unknown): item is unknown[] => Array.isArray(item);
  const pick = <T>(key: string, guard: (item: unknown) => item is T): T | undefined => {
    const item = stateField[key] ?? payload[key];
    return guard(item) ? item : undefined;
  };

  const phase = typeof payload.current_phase === "string" ? payload.current_phase : undefined;
  const rounds = pick("rounds", isArray);
  const ambiguity = pick("current_ambiguity", isNumber) ?? latestScoredAmbiguity(rounds);
  const threshold = pick("threshold", isNumber);
  const rawTopology = isRecord(stateField.topology)
    ? stateField.topology
    : isRecord(payload.topology)
      ? payload.topology
      : undefined;
  const topology = rawTopology && rawTopology.status !== "legacy_missing" ? rawTopology : undefined;
  const targetComponent =
    topology && typeof topology.last_targeted_component_id === "string"
      ? topology.last_targeted_component_id
      : undefined;
  const weakestDimension = topology ? weakestDimensionFromTopology(topology, targetComponent) : undefined;
  return { phase, ambiguity, threshold, roundCount: rounds?.length, targetComponent, weakestDimension };
}

/** gjc `deriveDeepInterviewHud`: the chips of a whole mode-state envelope. */
export function deriveDeepInterviewHud(
  value: unknown,
  options: DeepInterviewHudDeriveOptions = {},
): WorkflowHudSummary {
  const facts = deepInterviewHudFacts(value);
  const specStatus =
    options.specStatus ?? (isRecord(value) && typeof value.spec_status === "string" ? value.spec_status : undefined);
  return buildDeepInterviewHudSummary({
    ...facts,
    phase: options.phase ?? facts.phase,
    specStatus,
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  });
}

/** gjc `buildHudForMode("deep-interview", state)`: the row HUD of a handoff side. */
export function buildDeepInterviewHudFromState(state: Json, at: string): WorkflowHudSummary {
  return deriveDeepInterviewHud(state, { updatedAt: at });
}
