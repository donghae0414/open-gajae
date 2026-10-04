// Deep-interview phase rules, the field lists the runtime owns, and the round
// record check (deep-interview revision plan C-2, C-4, DR-14, DR-34). Pure.
// These sets are deep-interview's own; they are never mixed with ralplan's or
// ultragoal's (`../ralplan-runtime/manifest.ts`, `../ultragoal-runtime/manifest.ts`).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/workflow-manifest.ts:154-161` (default `stopReleasingPhases`),
//   `:168-176` (deep-interview `states`, `terminalStates`, `transitions`),
//   `:512-519` (`isKnownWorkflowState`, `isValidTransition`)
// - `skill-state/initial-phase.ts:13-14` (deep-interview initial phase)
// - `skill-state/workflow-mutation-guard.ts:265-268` (`isBlockingPlanningPhase`:
//   every deep-interview phase but a releasing one blocks)
// - `gjc-runtime/state-runtime.ts:1328-1341` (`state write` phase checks)
// - `gjc-runtime/deep-interview-state.ts:159-169` (`TRANSCRIPT_STATE_FIELDS`),
//   `:200-212` (`ENVELOPE_RESERVED_STATE_KEYS`)
// - `gjc-runtime/deep-interview-stage.ts:168-178`
//   (`RUNTIME_OWNED_ENVELOPE_KEYS`)
// - `gjc-runtime/deep-interview-runtime.ts:136-143` (`defaultSpecSlug`),
//   `:633,648` (the spec file and index names)
// - `defaults/gjc/skills/deep-interview/SKILL.md:530-596` (the scored round
//   record a `write` carries)
// Deviations (docs/development.md "GJC로부터의 deviation (deep-interview)"):
// - 19: the `state` op refuses the runtime-owned fields (spec D-SR9) at both
//   levels and the nine top-level transcript fields (PQ-20 C).
// - 36 (PQ-22 D): `write` checks the round records it touches; gjc passes
//   rounds through as free-form fields (`deep-interview-stage.ts:272-289`).

import { randomBytes } from "node:crypto";

/** gjc deep-interview manifest `states`, in gjc order. */
export const DEEP_INTERVIEW_STATES = ["interviewing", "handoff", "complete"] as const;
export type DeepInterviewPhase = (typeof DEEP_INTERVIEW_STATES)[number];

/** gjc `skill-state/initial-phase.ts`: a seed and a handoff callee start here. */
export const DEEP_INTERVIEW_INITIAL_STATE = "interviewing";

/** gjc deep-interview manifest `terminalStates`. */
export const DEEP_INTERVIEW_TERMINAL_STATES: ReadonlySet<string> = new Set(["handoff", "complete"]);

export type DeepInterviewTransition = { from: DeepInterviewPhase; to: DeepInterviewPhase; verb: string };

/** gjc deep-interview manifest `transitions`, row for row (spec D-SR3). */
export const DEEP_INTERVIEW_TRANSITIONS: readonly DeepInterviewTransition[] = [
  { from: "interviewing", to: "handoff", verb: "write-spec" },
  { from: "handoff", to: "complete", verb: "clear" },
  { from: "interviewing", to: "complete", verb: "clear" },
];

/** gjc default `stopReleasingPhases` (plan C-2 "release phase"). */
export const DEEP_INTERVIEW_RELEASE_PHASES: ReadonlySet<string> = new Set([
  "complete",
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "inactive",
]);

/**
 * The phases the edit guard, the goal skip and the compaction context cover
 * (plan C-2): every manifest phase that is not a releasing one.
 */
export const DEEP_INTERVIEW_GUARD_PHASES: ReadonlySet<string> = new Set(["interviewing", "handoff"]);

export function isDeepInterviewPhase(value: unknown): value is DeepInterviewPhase {
  return typeof value === "string" && (DEEP_INTERVIEW_STATES as readonly string[]).includes(value);
}

/** gjc `isValidTransition("deep-interview", from, to)`: same phase, or a table row. */
export function isValidDeepInterviewTransition(from: string, to: string): boolean {
  if (from === to) return true;
  return DEEP_INTERVIEW_TRANSITIONS.some((row) => row.from === from && row.to === to);
}

/**
 * gjc `state write` phase checks without `--force`: the target phase must be a
 * manifest state, and when the stored phase is one too, the move must be a
 * table edge. Returns the refusal, or undefined.
 */
export function deepInterviewPhasePatchError(
  fromPhase: string | undefined,
  toPhase: string,
): string | undefined {
  if (!isDeepInterviewPhase(toPhase)) return `unknown deep-interview phase "${toPhase}"`;
  if (fromPhase && isDeepInterviewPhase(fromPhase) && !isValidDeepInterviewTransition(fromPhase, toPhase))
    return `invalid deep-interview phase transition from ${fromPhase} to ${toPhase}`;
  return undefined;
}

/**
 * gjc `RUNTIME_OWNED_ENVELOPE_KEYS`: the envelope lifecycle keys a `write`
 * drops and reports as `ignored_runtime_owned_keys` (PQ-14 A: these nine only).
 */
export const RUNTIME_OWNED_ENVELOPE_KEYS = [
  "current_phase",
  "active",
  "skill",
  "version",
  "state_revision",
  "source_state_revision",
  "receipt",
  "updated_at",
  "last_applied_draft_id",
] as const;

/**
 * gjc `TRANSCRIPT_STATE_FIELDS`: the interview transcript fields that live
 * under `state`. gjc hoists them from the top level; here a `write` or `state`
 * input that carries one at the top level is refused (PQ-20 C, deviation 25).
 */
export const TRANSCRIPT_STATE_FIELDS = [
  "rounds",
  "established_facts",
  "current_ambiguity",
  "ambiguity_floor",
  "topology",
  "ontology_snapshots",
  "auto_researched_rounds",
  "auto_answered_rounds",
  "architect_failures",
] as const;

/**
 * gjc `ENVELOPE_RESERVED_STATE_KEYS`: envelope keys that never belong inside
 * `state`; the read boundary strips them there.
 */
export const ENVELOPE_RESERVED_STATE_KEYS = [
  "state",
  "receipt",
  "skill",
  "version",
  "updated_at",
  "active",
  "current_phase",
  "state_revision",
  "source_state_revision",
  "last_applied_draft_id",
  "session_id",
] as const;

/** Spec D-SR9: the spec fields only the `spec` op writes (top level). */
export const SPEC_FIELDS = [
  "spec_slug",
  "spec_path",
  "spec_sha256",
  "spec_stage",
  "spec_persisted_at",
] as const;

/** Spec D-SR9: the transcript fields only `write` writes (under `state`). */
export const STATE_OP_REFUSED_STATE_FIELDS = [
  "rounds",
  "established_facts",
  "current_ambiguity",
  "ambiguity_floor",
] as const;

/**
 * The `state` op's refusal of the runtime-owned fields (spec D-SR9,
 * deviation 19), at either level. Returns the refusal, or undefined. The
 * other top-level transcript fields get `write`'s refusal (PQ-20 C).
 */
export function statePatchFieldError(patch: Record<string, unknown>): string | undefined {
  const nested =
    typeof patch.state === "object" && patch.state !== null && !Array.isArray(patch.state)
      ? (patch.state as Record<string, unknown>)
      : {};
  const owned = new Set<string>([...SPEC_FIELDS, ...STATE_OP_REFUSED_STATE_FIELDS]);
  const named = [
    ...Object.keys(patch).filter((key) => owned.has(key)),
    ...Object.keys(nested)
      .filter((key) => owned.has(key))
      .map((key) => `state.${key}`),
  ];
  if (named.length === 0) return undefined;
  return `deep-interview state cannot set ${named.join(", ")}: rounds, facts and ambiguity are written by \`deep-interview write\` (inside "state"), and the spec fields by \`deep-interview spec\`.`;
}

/**
 * PQ-22 D (deviation 36): the fields every scored round record (round 1 and
 * later) must carry, as the SKILL's `Required:` line names them. A brownfield
 * interview also needs `scores.context` (PQ-32 A).
 */
export const ROUND_RECORD_REQUIRED = [
  "round",
  "round_key",
  "lifecycle",
  "question_text",
  "answer",
  "ambiguity",
  "scores.goal",
  "scores.constraints",
  "scores.criteria",
] as const;

/** PQ-32 A: the extra score of a brownfield interview. */
export const BROWNFIELD_ROUND_REQUIRED = "scores.context";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function unitScore(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * PQ-33 A: a Round 0 record is `round_key: "round-0"` or `round: 0`; it needs
 * `round_key: "round-0"`, `question_text` and `answer`, and may be `answered`.
 */
function round0Problems(record: Record<string, unknown>): string[] {
  const problems: string[] = [];
  if (record.round_key !== "round-0") problems.push("round_key");
  if (record.round !== undefined && record.round !== 0) problems.push("round");
  if (!nonEmptyString(record.question_text)) problems.push("question_text");
  if (!nonEmptyString(record.answer)) problems.push("answer");
  return problems;
}

function scoredRoundProblems(record: Record<string, unknown>, brownfield: boolean): string[] {
  const problems: string[] = [];
  const round = record.round;
  const validRound = typeof round === "number" && Number.isInteger(round) && round >= 1;
  if (!validRound) problems.push("round");
  if (!validRound || record.round_key !== `round-${round}`) problems.push("round_key");
  if (record.lifecycle !== "scored") problems.push("lifecycle");
  if (!nonEmptyString(record.question_text)) problems.push("question_text");
  if (!nonEmptyString(record.answer)) problems.push("answer");
  if (!unitScore(record.ambiguity)) problems.push("ambiguity");
  const scores = isRecord(record.scores) ? record.scores : {};
  for (const dimension of ["goal", "constraints", "criteria"])
    if (!unitScore(scores[dimension])) problems.push(`scores.${dimension}`);
  if (brownfield && !unitScore(scores.context)) problems.push(BROWNFIELD_ROUND_REQUIRED);
  return problems;
}

/**
 * The `round_key` of every `state.rounds[i]` a `write` input carries, or the
 * positional errors for entries without one (C4-6): with no key there is
 * nothing to merge by, so the touched record cannot be named.
 */
export function inputRoundKeys(input: Record<string, unknown>): { keys: string[]; errors: string[] } {
  const state = isRecord(input.state) ? input.state : undefined;
  if (state === undefined || !Object.hasOwn(state, "rounds")) return { keys: [], errors: [] };
  if (!Array.isArray(state.rounds))
    return { keys: [], errors: ["state.rounds: must be an array of round records"] };
  const keys: string[] = [];
  const errors: string[] = [];
  state.rounds.forEach((entry: unknown, index: number) => {
    if (isRecord(entry) && nonEmptyString(entry.round_key)) keys.push(entry.round_key);
    else errors.push(`state.rounds[${index}]: round_key (a string such as "round-1") is required`);
  });
  return { keys, errors };
}

/**
 * PQ-22 D, PQ-31 B, PQ-34 A: check the merged record of every `round_key`
 * this write touched. Returns one line per record that misses fields (all of
 * them at once), or `[]`.
 */
export function roundRecordErrors(
  mergedRounds: readonly unknown[],
  touchedKeys: readonly string[],
  brownfield: boolean,
): string[] {
  const errors: string[] = [];
  for (const key of new Set(touchedKeys)) {
    const record = mergedRounds.find(
      (item): item is Record<string, unknown> => isRecord(item) && item.round_key === key,
    );
    if (record === undefined) continue;
    const isRound0 = record.round_key === "round-0" || record.round === 0;
    const problems = isRound0 ? round0Problems(record) : scoredRoundProblems(record, brownfield);
    if (problems.length === 0) continue;
    const label = isRound0
      ? "round 0"
      : typeof record.round === "number"
        ? `round ${record.round}`
        : `round_key "${key}"`;
    errors.push(`${label} (${key}): ${problems.join(", ")}`);
  }
  return errors;
}

/** The refusal text for round-record errors (PQ-34 A). */
export function roundRecordRefusal(errors: readonly string[]): string {
  return [
    "deep-interview write: round records do not match the required shape, so nothing was written:",
    ...errors.map((line) => `- ${line}`),
    `Each scored round needs ${ROUND_RECORD_REQUIRED.join(", ")} (round_key "round-<round>", lifecycle "scored", scores in 0..1; a brownfield interview also needs ${BROWNFIELD_ROUND_REQUIRED}); Round 0 needs round_key "round-0", question_text and answer. See the round record shape in the deep-interview skill, Phase 2.`,
  ].join("\n");
}

/** The spec file name: `specs/deep-interview-<slug>.md` (spec D-SH1). */
export function specFileName(slug: string): string {
  return `deep-interview-${slug}.md`;
}

/** The spec index in the session's `specs/` (spec D-SH1). */
export const SPEC_INDEX_FILE = "deep-interview-index.jsonl";

/** gjc `defaultSpecSlug`: UTC `YYYY-MM-DD-HHMM-<4 hex>`. */
export function defaultSpecSlug(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear().toString().padStart(4, "0");
  const mm = (now.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = now.getUTCDate().toString().padStart(2, "0");
  const hh = now.getUTCHours().toString().padStart(2, "0");
  const min = now.getUTCMinutes().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${hh}${min}-${randomBytes(2).toString("hex")}`;
}
