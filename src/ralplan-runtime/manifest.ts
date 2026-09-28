// Ralplan phase rules: the nine stages, the ralplan state and transition table,
// the phase lock, and the terminal (T), guard-release (R) and known-phase
// (C-3) sets. Pure. These constants are defined here and nowhere else (plan
// P-AC15); every consumer imports them.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/ralplan-runtime.ts:81-91` (`KNOWN_STAGES`), `:666-670`
//   (`assertKnownStage`), `:971-984` (`advanceCurrentPhase`)
// - `gjc-runtime/workflow-manifest.ts:154-160` (default
//   `stopReleasingPhases`), `:215-292` (ralplan `states`, `terminalStates`,
//   `transitions`, `phaseLock`), `:516-519` (`isValidTransition`)
// - `tools/skill.ts:42` (`TERMINAL_PHASES`)
// Plan C-2 names T = `TERMINAL_PHASES` ∪ ralplan `terminalStates` and
// R = `stopReleasingPhases`; C-3 names the known phases = ralplan states ∪ R.
// Deviation 1 (CLI → tool op): the unknown-stage message names `stage`, not
// `--stage`.

/** gjc `KNOWN_STAGES`, in gjc order (spec D-T2). */
export const RALPLAN_STAGES = [
  "planner",
  "intent",
  "architect",
  "critic",
  "disposition",
  "revision",
  "post-interview",
  "adr",
  "final",
] as const;
export type RalplanStage = (typeof RALPLAN_STAGES)[number];

/** gjc ralplan manifest `states`: the nine stages plus `handoff`. */
export const RALPLAN_STATES = [...RALPLAN_STAGES, "handoff"] as const;
export const RALPLAN_INITIAL_STATE = "planner";
/** gjc ralplan manifest `terminalStates`. */
export const RALPLAN_TERMINAL_STATES = ["final", "handoff"] as const;

export type RalplanTransition = { from: string; to: string; verb: string };

/** gjc ralplan manifest `transitions`, row for row. */
export const RALPLAN_TRANSITIONS: readonly RalplanTransition[] = [
  { from: "planner", to: "intent", verb: "write-artifact" },
  // Legacy in-flight runs may have persisted planner before the intent stage existed.
  { from: "planner", to: "architect", verb: "write-artifact" },
  { from: "intent", to: "architect", verb: "write-artifact" },
  { from: "intent", to: "revision", verb: "write-artifact" },
  { from: "architect", to: "critic", verb: "write-artifact" },
  { from: "critic", to: "disposition", verb: "write-artifact" },
  { from: "architect", to: "disposition", verb: "write-artifact" },
  { from: "disposition", to: "revision", verb: "write-artifact" },
  { from: "critic", to: "revision", verb: "write-artifact" },
  { from: "revision", to: "intent", verb: "write-artifact" },
  { from: "revision", to: "post-interview", verb: "write-artifact" },
  { from: "critic", to: "post-interview", verb: "write-artifact" },
  { from: "disposition", to: "post-interview", verb: "write-artifact" },
  { from: "post-interview", to: "revision", verb: "write-artifact" },
  { from: "post-interview", to: "adr", verb: "write-artifact" },
  { from: "revision", to: "adr", verb: "write-artifact" },
  { from: "adr", to: "final", verb: "write-artifact" },
  { from: "planner", to: "handoff", verb: "handoff" },
  { from: "intent", to: "handoff", verb: "handoff" },
  { from: "architect", to: "handoff", verb: "handoff" },
  { from: "critic", to: "handoff", verb: "handoff" },
  { from: "disposition", to: "handoff", verb: "handoff" },
  { from: "revision", to: "handoff", verb: "handoff" },
  { from: "adr", to: "handoff", verb: "handoff" },
  { from: "post-interview", to: "handoff", verb: "handoff" },
];

/** gjc ralplan manifest `phaseLock`: phases a stage write never leaves (DR-3). */
export const RALPLAN_PHASE_LOCK = [
  "final",
  "handoff",
  "complete",
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "inactive",
] as const;

/** gjc `tools/skill.ts` `TERMINAL_PHASES` (generic chain-permitting phases). */
const SKILL_TOOL_TERMINAL_PHASES = [
  "complete",
  "completed",
  "handoff",
  "failed",
  "cancelled",
  "canceled",
  "inactive",
] as const;

/**
 * T (plan C-2): gjc `TERMINAL_PHASES` ∪ ralplan `terminalStates` =
 * final, handoff, complete, completed, failed, cancelled, canceled, inactive.
 * Used by running, continuation, the ultragoal entry gate and the handoff op.
 */
export const TERMINAL_PHASES: ReadonlySet<string> = new Set<string>([
  ...RALPLAN_TERMINAL_STATES,
  ...SKILL_TOOL_TERMINAL_PHASES,
]);

/**
 * R (plan C-2): gjc default `stopReleasingPhases` = complete, completed,
 * failed, cancelled, canceled, inactive. The mutation guard releases only on
 * these, so final and handoff keep blocking while active.
 */
export const GUARD_RELEASE_PHASES: ReadonlySet<string> = new Set<string>([
  "complete",
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "inactive",
]);

/** Plan C-3: ralplan manifest states ∪ R. A phase outside it is DR-21. */
export const KNOWN_PHASES: ReadonlySet<string> = new Set<string>([
  ...RALPLAN_STATES,
  ...GUARD_RELEASE_PHASES,
]);

export function isKnownPhase(phase: unknown): phase is string {
  return typeof phase === "string" && KNOWN_PHASES.has(phase);
}

export function isRalplanStage(value: unknown): value is RalplanStage {
  return (
    typeof value === "string" &&
    (RALPLAN_STAGES as readonly string[]).includes(value)
  );
}

/** gjc `assertKnownStage`: an unknown stage is refused. */
export function assertRalplanStage(
  stage: string,
): asserts stage is RalplanStage {
  if (!isRalplanStage(stage)) {
    throw new Error(
      `unknown stage: ${stage}. Expected one of: ${RALPLAN_STAGES.join(", ")}.`,
    );
  }
}

/** gjc `isValidTransition("ralplan", from, to)`: same phase, or a table row. */
export function isValidTransition(from: string, to: string): boolean {
  if (from === to) return true;
  return RALPLAN_TRANSITIONS.some(
    (transition) => transition.from === from && transition.to === to,
  );
}

/**
 * gjc `advanceCurrentPhase`: a stage write moves the phase to the stage just
 * written unless the current phase is locked (DR-3).
 */
export function advanceCurrentPhase(
  existingPhase: unknown,
  stage: RalplanStage,
): string {
  const current = typeof existingPhase === "string" ? existingPhase.trim() : "";
  if (current && (RALPLAN_PHASE_LOCK as readonly string[]).includes(current))
    return current;
  return stage;
}
