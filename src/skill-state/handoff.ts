// The one cross-skill handoff (ultragoal revision plan C-5, PQ-6 A): `ralplan
// handoff`, `ultragoal handoff` and the `skill ultragoal` turn gate all move
// control with `handoffWorkflowTx`. A journal wraps the callee and caller
// state merges and the row writes; nothing replays or rolls it back (I-19).
// Callers run their own checks first (ralplan DR-7 phase ∈ T and R-OD18
// `active`). The goal state is never touched (D-HE2). The function takes the
// `tx` of one `StateStore.workflowTransaction` (C-1).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/state-runtime.ts:1572-1881` (`handleHandoffUnlocked`: the
//   caller and callee reads, the merges, the journal steps, the receipt)
// - `gjc-runtime/state-writer.ts:1009-1068` (`writeWorkflowEnvelopeAtomic`:
//   the audit-only `invalid_transition_detected` row of an active write)
// - `skill-state/initial-phase.ts:13-19` (`initialPhaseForSkill`)
// - `skill-state/active-state.ts:969-1015` (`applyHandoffToActiveState`, via
//   `./rows.ts`); both rows carry gjc `buildHudForMode` of their merged
//   state (`state-runtime.ts:1824,1838`), ralplan's and ultragoal's alike
// Deviations:
// - ultragoal 33 (PQ-5 (1) B, (2) A): a deep-interview callee gets the phase
//   `"deep-interview"` (gjc `interviewing`) and no row.
// - ralplan 17: no envelope receipt, checksum or `state_revision`; the
//   StateStore `_meta` stays. There is no `--force`: a corrupt state is
//   refused.
// - C-5 ⑥ (ultragoal 39): an ultragoal caller also records the handoff in its
//   ledger and `progress.txt` through `recordCaller`, which gjc does not do.
// - The receipt carries the handoff's `mutation_id` instead of gjc's
//   per-state receipts.

import { buildRalplanHudFromState } from "../ralplan-runtime/hud.js";
import {
  isValidTransition,
  RALPLAN_INITIAL_STATE,
  RALPLAN_STATES,
} from "../ralplan-runtime/manifest.js";
import type { InterviewState, StateWriter, WorkflowTx } from "../state.js";
import { buildUltragoalHudFromState } from "../ultragoal-runtime/hud.js";
import { type AuditOwner, appendAudit, HOOK_OWNER, RUNTIME_OWNER } from "./audit.js";
import type { WorkflowHudSummary } from "./hud.js";
import {
  beginWorkflowTransactionJournalTx,
  completeWorkflowTransactionJournalTx,
  updateWorkflowTransactionJournalTx,
} from "./journal.js";
import { writeHandoffRowsTx } from "./rows.js";

type Json = Record<string, unknown>;

/** gjc `WORKFLOW_STATE_VERSION`. */
const WORKFLOW_STATE_VERSION = 2;

export type HandoffCaller = "ralplan" | "ultragoal";
export type HandoffCallee = HandoffCaller | "deep-interview";

type HandoffSkill = {
  /** gjc `initialPhaseForSkill`, but deep-interview's (deviation 33). */
  initialPhase: string;
  /** The manifest behind gjc's audit-only transition diagnostic. */
  manifest?: {
    isState(phase: string): boolean;
    isValidTransition(from: string, to: string): boolean;
  };
  /** gjc `buildHudForMode`: the row's HUD from the merged state. */
  hud?(state: Json, at: string): WorkflowHudSummary;
  /** PQ-5 (2) A: a deep-interview callee writes no row. */
  row: boolean;
};

const HANDOFF_SKILLS: Record<HandoffCallee, HandoffSkill> = {
  ralplan: {
    initialPhase: RALPLAN_INITIAL_STATE,
    manifest: {
      isState: (phase) => (RALPLAN_STATES as readonly string[]).includes(phase),
      isValidTransition,
    },
    hud: buildRalplanHudFromState,
    row: true,
  },
  ultragoal: { initialPhase: "goal-planning", hud: buildUltragoalHudFromState, row: true },
  "deep-interview": { initialPhase: "deep-interview", row: false },
};

/** `_meta.updatedBy` for both states: the caller's tool or hook writer. */
const WRITERS: Record<HandoffCaller, Record<AuditOwner, StateWriter>> = {
  ralplan: { [RUNTIME_OWNER]: "ralplan_tool", [HOOK_OWNER]: "ralplan_hook" },
  ultragoal: { [RUNTIME_OWNER]: "ultragoal_tool", [HOOK_OWNER]: "ultragoal_hook" },
};

export type HandoffInput = {
  caller: HandoffCaller;
  callee: HandoffCallee;
  /** The owner (lineage root) session. */
  sessionId: string;
  owner: AuditOwner;
  /** The handoff's reason (the current `handoff` input); gjc has none (F4). */
  reason: string;
  /**
   * C-5 ⑥ (PQ-15 A): the ultragoal caller's ledger `workflow_handoff{to,
   * reason}` and `progress.txt` `HANDOFF` note, written by the ultragoal
   * runtime after the rows and before the journal is committed.
   */
  recordCaller?: (handoff: { to: HandoffCallee; reason: string; at: string }) => Promise<void>;
};

/** gjc's handoff receipt (`state-runtime.ts:1853-1879`) with the mutation id. */
export type HandoffReceipt = {
  ok: true;
  from: HandoffCaller;
  to: HandoffCallee;
  handoff_at: string;
  mutation_id: string;
  phases: { from: "handoff"; to: string };
  paths: { from: string; to: string; active_state: string };
};

/** A state copy without the StateStore `_meta` (regenerated on every write). */
function payloadOf(state: InterviewState): Json {
  const { _meta, ...rest } = state;
  return rest;
}

function phaseOf(state: Json | undefined): string | undefined {
  const phase = state?.current_phase;
  return typeof phase === "string" && phase.trim() ? phase.trim() : undefined;
}

/** gjc `readExistingStateForMutation`; a corrupt state is refused. */
async function readForHandoff(tx: WorkflowTx, skill: HandoffCallee): Promise<Json | undefined> {
  try {
    const state = await tx.readModeState(skill);
    return state === undefined ? undefined : payloadOf(state);
  } catch (error) {
    throw new Error(
      `existing state for ${skill} is corrupt or tampered (${error instanceof Error ? error.message : String(error)}); refusing to hand off`,
      { cause: error },
    );
  }
}

/**
 * One merged state, as gjc's `writeJsonAtomic(…, "handoff", …)`: an active
 * write whose manifest lacks the edge leaves an `invalid_transition_detected`
 * row first (best-effort), then the state and its `handoff` audit row.
 */
async function writeHandoffStateTx(
  tx: WorkflowTx,
  skill: HandoffCallee,
  next: Json,
  write: {
    writer: StateWriter;
    owner: AuditOwner;
    mutationId: string;
    fromPhase?: string;
    toPhase: string;
  },
): Promise<void> {
  const file = tx.paths.modeState(skill);
  const manifest = HANDOFF_SKILLS[skill].manifest;
  const { fromPhase, toPhase } = write;
  if (
    next.active === true &&
    manifest &&
    fromPhase &&
    fromPhase !== toPhase &&
    manifest.isState(fromPhase) &&
    !manifest.isValidTransition(fromPhase, toPhase)
  )
    await appendAudit(tx, {
      category: "state",
      verb: "invalid_transition_detected",
      owner: write.owner,
      skill,
      mutationId: write.mutationId,
      fromPhase,
      toPhase,
      path: file,
    }).catch(() => undefined);
  await tx.writeModeState(skill, next, write.writer);
  await appendAudit(tx, {
    category: "state",
    verb: "handoff",
    owner: write.owner,
    skill,
    mutationId: write.mutationId,
    fromPhase,
    toPhase,
    path: file,
  });
}

/**
 * gjc `gjc state <caller> handoff --to <callee>` for a workflow callee:
 * ① read both states (a corrupt one, or a missing caller, is refused); ② a
 * `pending` journal; ③ the callee merged over its kept fields, active on its
 * initial phase with `handoff_from`/`handoff_at`; ④ the caller merged over
 * its kept fields, inactive on `handoff` with `handoff_to`/`handoff_at`; ⑤
 * the caller's inactive row, the callee's active row (none for
 * deep-interview) and the snapshot; ⑥ `recordCaller`; ⑦ the journal
 * committed, then removed. A throw leaves the journal `pending`.
 */
export async function handoffWorkflowTx(
  tx: WorkflowTx,
  input: HandoffInput,
): Promise<HandoffReceipt> {
  const { caller, callee, sessionId, owner } = input;
  if (callee === caller)
    throw new Error(`handoff: the callee must differ from the caller (both are "${caller}")`);
  const callerPath = tx.paths.modeState(caller);
  const calleePath = tx.paths.modeState(callee);
  const existingCaller = await readForHandoff(tx, caller);
  if (existingCaller === undefined)
    throw new Error(`${caller} handoff: caller is not active (no mode-state file at ${callerPath})`);
  const existingCallee = (await readForHandoff(tx, callee)) ?? {};

  const at = new Date().toISOString();
  const mutationId = `${caller}:handoff:${callee}:${at}`;
  const writer = WRITERS[caller][owner];
  const calleeSkill = HANDOFF_SKILLS[callee];
  const calleeState: Json = {
    ...existingCallee,
    skill: callee,
    version: WORKFLOW_STATE_VERSION,
    active: true,
    current_phase: calleeSkill.initialPhase,
    handoff_from: caller,
    handoff_at: at,
    updated_at: at,
  };
  if (typeof calleeState.session_id !== "string") calleeState.session_id = sessionId;
  const callerState: Json = {
    ...existingCaller,
    skill: caller,
    version: WORKFLOW_STATE_VERSION,
    active: false,
    current_phase: "handoff",
    handoff_to: callee,
    handoff_at: at,
    updated_at: at,
  };

  await beginWorkflowTransactionJournalTx(
    tx,
    { mutationId, caller, callee, paths: [calleePath, callerPath, tx.paths.snapshotPath] },
    owner,
  );
  const steps: string[] = [];
  const step = async (name: string) => {
    steps.push(name);
    await updateWorkflowTransactionJournalTx(tx, mutationId, { steps: [...steps] }, owner);
  };
  await writeHandoffStateTx(tx, callee, calleeState, {
    writer,
    owner,
    mutationId,
    fromPhase: phaseOf(existingCallee),
    toPhase: calleeSkill.initialPhase,
  });
  await step("callee-mode-state");
  await writeHandoffStateTx(tx, caller, callerState, {
    writer,
    owner,
    mutationId,
    fromPhase: phaseOf(existingCaller),
    toPhase: "handoff",
  });
  await step("caller-mode-state");
  await writeHandoffRowsTx(
    tx,
    {
      at,
      caller: {
        skill: caller,
        active: false,
        phase: "handoff",
        sessionId,
        hud: HANDOFF_SKILLS[caller].hud?.(callerState, at),
        handoff_to: callee,
        handoff_at: at,
      },
      callee: calleeSkill.row
        ? {
            skill: callee,
            active: true,
            phase: calleeSkill.initialPhase,
            sessionId,
            hud: calleeSkill.hud?.(calleeState, at),
            handoff_from: caller,
            handoff_at: at,
          }
        : undefined,
    },
    owner,
  );
  await step("active-state");
  if (input.recordCaller) {
    await input.recordCaller({ to: callee, reason: input.reason, at });
    await step("caller-records");
  }
  await completeWorkflowTransactionJournalTx(tx, mutationId, owner);
  return {
    ok: true,
    from: caller,
    to: callee,
    handoff_at: at,
    mutation_id: mutationId,
    phases: { from: "handoff", to: calleeSkill.initialPhase },
    paths: { from: callerPath, to: calleePath, active_state: tx.paths.snapshotPath },
  };
}
