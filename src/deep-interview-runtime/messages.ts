// Deep-interview texts the runtime and the hooks show the model: the edit
// guard, the skill-load chain refusal, the `start` refusal, the op refusals,
// the continuation, the compaction context, the spec guard and the handoff
// result lines (deep-interview revision plan DR-9, DR-19..DR-22, DR-24, C-3).
// Pure.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `skill-state/workflow-mutation-guard.ts:22-23`
//   (`DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE`)
// - `tools/skill.ts:205-209` (the chain refusal)
// - `session/agent-session.ts:21186-21193` (the deep-interview continuation
//   reminder)
// Deviations: commands are tool ops (1); the guard adds a recovery line, as
// ralplan's does (`src/hooks.ts` `RALPLAN_MUTATION_BLOCK_MESSAGE`); the
// continuation is wrapped in `<deep-interview-continuation>` and names
// `question` and `deep-interview write` (16); the compaction context is a host
// addition (15); the `start` refusal is a host addition (12).

import { wrapInjected } from "../injection.js";

/** gjc `DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE` with the op name, plus recovery. */
export const DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE =
  "Deep-interview phase boundary: continue gathering context/questions/risks and emit a handoff/spec before code edits. Mutation tools and patch execution are blocked while deep-interview is active; finalize specs through `deep-interview spec` or hand off to an execution phase.\nIf this deep-interview is stale or was started by mistake, end it with `deep-interview clear`.";

/** DR-24: a direct write of a deep-interview spec; `shown` is the project-relative path. */
export function specGuardRefusal(shown: string): string {
  return `open-gajae: ${shown} is deep-interview-owned; write specs only through \`deep-interview spec\``;
}

/**
 * gjc `tools/skill.ts:205-209` for the same-execution load gate (DR-21): the
 * interview has not finished, or its phase is unknown.
 */
export function chainRefusal(phase: string, skill: string): string {
  return `open-gajae: refusing to chain from "deep-interview" (phase=${phase}) into "${skill}". Persist the spec with deep-interview spec, then call deep-interview handoff(to: "${skill}"), or clear the interview first.`;
}

/** Spec D-HL2 (deviation 12): `start` while ralplan or ultragoal is the visible primary. */
export function startRefusal(skill: string, phase: string | undefined): string {
  return otherWorkflowRefusal("deep-interview start is refused", skill, phase, "start");
}

/** Deviation 30: resuming a cancelled interview follows `start`'s rule (deviation 12). */
export function resumeRefusal(skill: string, phase: string | undefined): string {
  return otherWorkflowRefusal("deep-interview state: resuming the interview is refused", skill, phase, "resume");
}

function otherWorkflowRefusal(refused: string, skill: string, phase: string | undefined, then: string): string {
  return `${refused} while ${skill} is the active workflow${phase ? ` (phase ${phase})` : ""}. To interview from here: while ultragoal runs, call \`ultragoal handoff(to: "deep-interview", reason)\`; once ralplan has finished (final), call \`ralplan handoff(to: "deep-interview")\`; or stop ralplan first with \`ralplan state {"active": false}\` or \`ralplan clear\`, then ${then}.`;
}

/** C-3: the ops that need an interview when there is none. */
export function noStateRefusal(op: string): string {
  return `deep-interview ${op}: there is no deep-interview state in this session; call \`deep-interview start\` first.`;
}

/** C-3: a corrupt state refuses every op but `start`, `status`, `doctor` and a forced `clear`. */
export function corruptStateRefusal(op: string, error: string): string {
  return `deep-interview ${op}: the deep-interview state is corrupt or tampered (${error}); reset it with \`deep-interview clear\` and force: true.`;
}

/**
 * C-3 (PQ-12 B′, deviation 30): `write`, `spec`, `handoff` and `state` need an
 * active state. An inactive `interviewing` is a cancelled interview, which
 * `state(patch={"active": true})` resumes.
 */
export function inactiveStateRefusal(op: string, phase: string | undefined): string {
  if (phase === "interviewing")
    return `deep-interview ${op}: the interview was cancelled (inactive, phase interviewing). Resume it with \`deep-interview state(patch={"active": true})\`, or start a new interview with \`deep-interview start\`.`;
  return `deep-interview ${op}: the interview is not active (phase ${phase ?? "(none)"}). Start a new interview with \`deep-interview start\`, or reopen it from a finished ralplan with \`ralplan handoff(to: "deep-interview")\`.`;
}

/**
 * gjc's deep-interview continuation reminder (DR-20), wrapped. `count` is the
 * continuation number for this user prompt (1 or 2).
 */
export function continuationMessage(count: number): string {
  return wrapInjected(
    "<deep-interview-continuation>",
    [
      "You stopped while the deep-interview workflow is still active (phase interviewing).",
      "Continue the active round immediately: score and persist the answered round with `deep-interview write`, report progress, then use the `question` tool for the next question.",
      'Only stop after crystallizing the spec, recording a handoff, or explicitly cancelling the workflow (`deep-interview state(patch={"active": false})` when the user stops the interview).',
      `(Continuation ${count}/2 for this prompt)`,
    ].join("\n"),
  );
}

/** The TUI description of a continuation message. */
export function continuationDescription(count: number): string {
  return `open-gajae: deep-interview continuation ${count}/2`;
}

export type CompactionFacts = {
  phase: string;
  rounds: number;
  ambiguity?: number;
  threshold?: number;
  target?: string;
  weakest?: string;
  specPath?: string;
};

function percent(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "unknown";
}

/** DR-22 (deviation 15): the compaction recovery context. */
export function compactionMessage(facts: CompactionFacts): string {
  const lines = [
    `deep-interview is active (phase ${facts.phase}).`,
    `rounds: ${facts.rounds}`,
    `ambiguity: ${percent(facts.ambiguity)} (threshold ${percent(facts.threshold)})`,
  ];
  if (facts.target) lines.push(`target: ${facts.target}`);
  if (facts.weakest) lines.push(`weakest: ${facts.weakest}`);
  if (facts.specPath) lines.push(`spec: ${facts.specPath}`);
  lines.push(
    "Read the full state with `deep-interview status`; ask the next question with `question`, one at a time.",
  );
  return wrapInjected("<deep-interview-compaction-context>", lines.join("\n"));
}

/** DR-9: the first line of a successful handoff to ralplan (and of the combined call). */
export function handedOffToRalplan(specPath: string): string {
  return `Handed off to ralplan: deep-interview is inactive (phase handoff) and ralplan is active in planner. Load the \`ralplan\` skill now; do not call \`ralplan start\` — continue this run with \`ralplan write\` and use the spec as the planning input (spec: ${specPath}).`;
}

/** DR-9: the first line of a successful handoff to ultragoal. */
export function handedOffToUltragoal(specPath: string): string {
  return `Handed off to ultragoal: deep-interview is inactive (phase handoff) and ultragoal is active in goal-planning. Load the \`ultragoal\` skill now and call \`ultragoal create\` with the spec's acceptance criteria as goals (spec: ${specPath}).`;
}
