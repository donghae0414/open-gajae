// Deep-interview hook decisions (deep-interview revision plan S2, E-2): the
// edit guard's message, the continuation and its per-prompt budget, the
// same-execution skill-load gate, and the compaction context. `src/hooks.ts`
// calls these for the lineage root and does every host call itself; each
// function runs one `workflowTransaction` of that root (C-1), or works inside
// a transaction the caller already holds (`…Tx`).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `skill-state/workflow-mutation-guard.ts:264-268` (deep-interview blocks in
//   every phase but a releasing one)
// - `session/agent-session.ts:21137-21211` (`#checkActiveDeepInterviewCompletion`:
//   continue while `interviewing`, twice per user intent; another
//   deep-interview stop reason skips the goal and todo continuations,
//   `:8138-8157`), `:6044-6064` (`getActiveSkillPhase`: the file's phase,
//   whatever `active`, `undefined` when unreadable)
// - `tools/skill.ts:42` (`TERMINAL_PHASES`), `:203-222` (the chain guard and
//   the handoff on a terminal phase)
// Deviations (README "Deviations from GJC (deep-interview)"):
// - 14: the guard covers `write`/`edit`/`patch` only (the caller).
// - 15: the compaction context is a host addition.
// - 16: the continuation is counted in memory, per real user prompt.
// - 31 (PQ-11 E/B, PQ-35 A, PQ-36 C, U-1 A, A4-6): the gate runs only for
//   `open-gajae` with the deep-interview turn marker (the caller); a missing
//   or unreadable state passes; a finished interview with a verified spec is
//   handed off (inactive too, even onto an active callee) and otherwise
//   passes.

import { HOOK_OWNER } from "../skill-state/audit.js";
import { handoffWorkflowTx } from "../skill-state/handoff.js";
import { readVisiblePrimaryTx } from "../skill-state/rows.js";
import type { StateStore, WorkflowTx } from "../state.js";
import { normalizeForRead } from "./envelope.js";
import { deepInterviewHudFacts } from "./hud.js";
import { DEEP_INTERVIEW_GUARD_PHASES, DEEP_INTERVIEW_RELEASE_PHASES } from "./manifest.js";
import {
  chainRefusal,
  compactionMessage,
  continuationDescription,
  continuationMessage,
  DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE,
} from "./messages.js";
import {
  type DeepInterviewHandoffTarget,
  deepInterviewHandoffTx,
  readDeepInterviewStateTx,
  verifySpecTx,
} from "./store.js";

const SKILL = "deep-interview";
/** gjc: two continuations per user prompt. */
export const DEEP_INTERVIEW_CONTINUATION_MAX = 2;

function trimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The continuation decision of one root `succeeded` (DR-20): `continue` with
 * the message, `hold` to skip the goal and ralplan continuations too, or
 * `none` to let them run.
 */
export type DeepInterviewContinuation =
  | { kind: "continue"; text: string; description: string }
  | { kind: "hold" }
  | { kind: "none" };

/**
 * The skill-load gate's verdict (DR-21): `refuse` with the message, `handed-off`
 * when the load moved deep-interview to the callee (the caller must not seed
 * it again), or `pass`.
 */
export type DeepInterviewGate = { kind: "refuse"; message: string } | { kind: "handed-off" } | { kind: "pass"; reason?: string };

/** Plan I-11: deep-interview is the visible primary, active, on a guard phase. */
async function guardedPhaseTx(tx: WorkflowTx): Promise<{ phase: string; state: Record<string, unknown> } | undefined> {
  const primary = await readVisiblePrimaryTx(tx);
  if (primary?.skill !== SKILL) return undefined;
  const read = await readDeepInterviewStateTx(tx);
  if (read.kind !== "valid" || read.value.active !== true) return undefined;
  const phase = trimmed(read.value.current_phase);
  return phase && DEEP_INTERVIEW_GUARD_PHASES.has(phase) ? { phase, state: read.value } : undefined;
}

export function createDeepInterviewHooks(store: StateStore) {
  /** DR-20 (E-3): continuations sent per root since its last real user prompt. */
  const continuations = new Map<string, number>();

  /**
   * DR-19: the edit guard's message while deep-interview is active on a guard
   * phase, for a caller that already found it the visible primary skill. A
   * missing or unreadable state does not block.
   */
  async function guardMessageTx(tx: WorkflowTx): Promise<string | undefined> {
    const read = await readDeepInterviewStateTx(tx);
    if (read.kind !== "valid" || read.value.active !== true) return undefined;
    const phase = trimmed(read.value.current_phase);
    return phase && DEEP_INTERVIEW_GUARD_PHASES.has(phase) ? DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE : undefined;
  }

  /**
   * DR-20: while deep-interview is the visible primary skill and active,
   * `interviewing` continues up to twice per user prompt; a spent budget or
   * `handoff` holds (no goal or ralplan continuation either). Otherwise none.
   */
  async function decideContinuation(root: string): Promise<DeepInterviewContinuation> {
    return store.workflowTransaction(root, async (tx) => {
      const guarded = await guardedPhaseTx(tx);
      if (guarded === undefined) return { kind: "none" };
      if (guarded.phase !== "interviewing") return { kind: "hold" };
      const sent = continuations.get(root) ?? 0;
      if (sent >= DEEP_INTERVIEW_CONTINUATION_MAX) return { kind: "hold" };
      const count = sent + 1;
      continuations.set(root, count);
      return { kind: "continue", text: continuationMessage(count), description: continuationDescription(count) };
    });
  }

  /** DR-20: a real user prompt at the root starts a fresh budget. */
  function resetContinuation(root: string): void {
    continuations.delete(root);
  }

  /**
   * DR-21: `skill <callee>` loaded in the execution that loaded
   * deep-interview, decided inside the caller's root transaction. A missing
   * or unreadable state passes; `interviewing` (active or not) and a readable
   * unknown phase refuse; an active `handoff` hands off (its check's message
   * refuses); an inactive `handoff` passes; a finished interview (a releasing
   * phase, active or not) with a verified spec is handed off, else passes.
   */
  async function gateTx(tx: WorkflowTx, root: string, callee: DeepInterviewHandoffTarget): Promise<DeepInterviewGate> {
    const read = await readDeepInterviewStateTx(tx);
    if (read.kind !== "valid") return { kind: "pass" };
    const state = read.value;
    // gjc `getActiveSkillPhase` → `(phase ?? "running").trim().toLowerCase()`.
    const phase = (trimmed(state.current_phase) ?? "running").toLowerCase();
    if (phase === "handoff") {
      if (state.active !== true) return { kind: "pass" };
      try {
        await deepInterviewHandoffTx(tx, root, HOOK_OWNER, callee, `skill ${callee} loaded after deep-interview`);
        return { kind: "handed-off" };
      } catch (error) {
        return { kind: "refuse", message: `open-gajae: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    if (DEEP_INTERVIEW_RELEASE_PHASES.has(phase)) {
      try {
        await verifySpecTx(tx, state);
        await handoffWorkflowTx(tx, {
          caller: SKILL,
          callee,
          sessionId: root,
          owner: HOOK_OWNER,
          reason: `skill ${callee} loaded after a finished deep-interview`,
        });
        return { kind: "handed-off" };
      } catch (error) {
        // PQ-11 E: no valid spec, or the handoff failed — the load passes; the caller logs why (DR-21).
        return { kind: "pass", reason: error instanceof Error ? error.message : String(error) };
      }
    }
    // U-1 A: `interviewing`, active or not, and any phase the manifest and
    // the releasing set do not know.
    return { kind: "refuse", message: chainRefusal(phase, callee) };
  }

  /**
   * DR-22 (deviation 15): the compaction context while deep-interview is the
   * visible primary skill, active on a guard phase.
   */
  async function compactionText(root: string): Promise<string | undefined> {
    return store.workflowTransaction(root, async (tx) => {
      const guarded = await guardedPhaseTx(tx);
      if (guarded === undefined) return undefined;
      const envelope = normalizeForRead(guarded.state);
      const facts = deepInterviewHudFacts(envelope);
      return compactionMessage({
        phase: guarded.phase,
        rounds: (envelope.state.rounds as unknown[]).length,
        ambiguity: facts.ambiguity,
        threshold: facts.threshold,
        target: facts.targetComponent,
        weakest: facts.weakestDimension,
        specPath: trimmed(envelope.spec_path),
      });
    });
  }

  return { guardMessageTx, decideContinuation, resetContinuation, gateTx, compactionText };
}
