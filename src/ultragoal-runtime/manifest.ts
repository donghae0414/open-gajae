// Ultragoal phase rules: the gjc manifest states, terminal states and
// transition table, the guard-release phases, the `state` op phase check, and
// the derived fields the open `state` patch refuses (plan C-3, PQ-1 A). Pure.
// These sets are ultragoal's own; they are never mixed with ralplan's T and R
// (`../ralplan-runtime/manifest.ts`).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/workflow-manifest.ts:154-161` (default `stopReleasingPhases`),
//   `:293-309` (ultragoal `states`, `terminalStates`, `transitions`; no
//   `phaseLock`), `:512-519` (`isKnownWorkflowState`, `isValidTransition`)
// - `skill-state/initial-phase.ts:13-19` (ultragoal initial phase)
// - `gjc-runtime/state-runtime.ts:1328-1341` (`state write` phase checks)
// Deviation 25 (plan §7.1): the `state` op is gjc's open patch, but it refuses
// the derived fields below (the next reconcile rewrites them anyway) and has
// no `--force` bypass, so the messages drop "use --force to bypass".

/** gjc ultragoal manifest `states`, in gjc order. */
export const ULTRAGOAL_STATES = [
  "missing",
  "goal-planning",
  "pending",
  "active",
  "blocked",
  "failed",
  "complete",
  "handoff",
] as const;
export type UltragoalPhase = (typeof ULTRAGOAL_STATES)[number];

/** gjc `skill-state/initial-phase.ts`: skill load seeds this phase. */
export const ULTRAGOAL_INITIAL_STATE = "goal-planning";

/** gjc ultragoal manifest `terminalStates` (plan C-3). */
export const ULTRAGOAL_TERMINAL_STATES: ReadonlySet<string> = new Set([
  "missing",
  "failed",
  "complete",
  "handoff",
]);

export type UltragoalTransition = { from: UltragoalPhase; to: UltragoalPhase; verb: string };

/** gjc ultragoal manifest `transitions`, row for row (11 rows). */
export const ULTRAGOAL_TRANSITIONS: readonly UltragoalTransition[] = [
  { from: "goal-planning", to: "pending", verb: "create-goals" },
  { from: "pending", to: "active", verb: "complete-goals" },
  { from: "active", to: "blocked", verb: "checkpoint" },
  { from: "active", to: "failed", verb: "checkpoint" },
  { from: "active", to: "complete", verb: "checkpoint" },
  { from: "blocked", to: "active", verb: "checkpoint" },
  { from: "failed", to: "active", verb: "complete-goals" },
  { from: "goal-planning", to: "handoff", verb: "handoff" },
  { from: "pending", to: "handoff", verb: "handoff" },
  { from: "active", to: "handoff", verb: "handoff" },
  { from: "blocked", to: "handoff", verb: "handoff" },
];

/** gjc default `stopReleasingPhases`: ultragoal sets none of its own. */
export const ULTRAGOAL_GUARD_RELEASE_PHASES: ReadonlySet<string> = new Set([
  "complete",
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "inactive",
]);

export function isUltragoalPhase(value: unknown): value is UltragoalPhase {
  return typeof value === "string" && (ULTRAGOAL_STATES as readonly string[]).includes(value);
}

/** gjc `isValidTransition("ultragoal", from, to)`: same phase, or a table row. */
export function isValidUltragoalTransition(from: string, to: string): boolean {
  if (from === to) return true;
  return ULTRAGOAL_TRANSITIONS.some((row) => row.from === from && row.to === to);
}

/**
 * gjc `state write` phase checks without `--force`: the target phase must be a
 * manifest state, and when the stored phase is one too, the move must be a
 * table edge. Returns the refusal, or undefined.
 */
export function ultragoalPhasePatchError(
  fromPhase: string | undefined,
  toPhase: string,
): string | undefined {
  if (!isUltragoalPhase(toPhase)) return `unknown ultragoal phase "${toPhase}"`;
  if (fromPhase && isUltragoalPhase(fromPhase) && !isValidUltragoalTransition(fromPhase, toPhase))
    return `invalid ultragoal phase transition from ${fromPhase} to ${toPhase}`;
  return undefined;
}

/**
 * PQ-1 A: fields every reconcile derives from `goals.json` and the ledger
 * (plan C-4), refused by the `state` patch. `current_phase` and `active` stay
 * patchable (checked by the table), as in gjc.
 */
export const ULTRAGOAL_DERIVED_FIELDS = [
  "goals",
  "counts",
  "status",
  "active_goal_id",
  "goals_path",
  "ledger_path",
  "progress_path",
  "latestLedgerEvent",
  "skill",
  "version",
  "session_id",
] as const;

/** The refusal for a `state` patch that names derived fields, or undefined. */
export function derivedFieldPatchError(patch: Record<string, unknown>): string | undefined {
  const keys = ULTRAGOAL_DERIVED_FIELDS.filter((key) => Object.hasOwn(patch, key));
  if (keys.length === 0) return undefined;
  return `state patch cannot set derived ultragoal field(s): ${keys.join(", ")}; the next ultragoal op rewrites them from goals.json and the ledger`;
}
