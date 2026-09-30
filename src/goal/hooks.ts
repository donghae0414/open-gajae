// Goal-loop hook logic (ultragoal revision plan C-9, S3): the continuation
// decision over `state/goal-state.json` and the hook-only
// `state/goal-continuation.json` (PQ-2 B), the hold release of a real user
// prompt, the goal context text, and the ultragoal compaction recovery with
// its zero-progress memory (E-12, DR-17). `src/hooks.ts` calls these for the
// lineage root only (C-2, E-4) and does every host call itself; each function
// here runs one `workflowTransaction` of that root (C-1).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `session/agent-session.ts:21086-21121` (`#checkGoalCompletion`, path A:
//   an active goal gets the continuation reminder, whatever the agent,
//   PQ-20 A), `:13147-13168` (`#buildAutomaticGoalModeMessage`: the context
//   while the goal is active), `:16132-16133` (no recovery projection while
//   the goal is paused)
// - `gjc-runtime/workflow-recovery-projection.ts:100-114` (the zero-progress
//   memory, kept per process here)
// Deviations (plan §7.1):
// - 9 (D-TL5): three tool-less turns hold the continuation, and the Esc stop
//   is the caller's (`src/hooks.ts`); gjc path A has neither.
// - 18 (D-VF9, PQ-3 A): five non-OKAY critic verdicts in a row hold it; a
//   real user prompt releases a hold, and only a critic hold moves the
//   critic count's release marker.
// - 6 (PQ-2 B): the counter and the hold live in the hook-only file, which
//   starts over when the goal id changes.
// - 26: the recovery lines add the progress patterns, learnings and the
//   STALLED line (`../ultragoal-runtime/recovery.ts`).

import path from "node:path";
import { readRawJsonTx, rowPhase } from "../skill-state/doctor.js";
import type { StateStore, WorkflowTx } from "../state.js";
import {
  CRITIC_STREAK_HOLD,
  criticNonOkayStreak,
  type LedgerRow,
  lastCriticVerdictId,
  parseLedger,
} from "../ultragoal-runtime/ledger.js";
import { ultragoalCompactionMessage, ultragoalGoalObjective } from "../ultragoal-runtime/messages.js";
import { parseGoals } from "../ultragoal-runtime/plan.js";
import {
  projectUltragoalRun,
  renderUltragoalRecoveryContext,
  trackZeroProgress,
  ultragoalRecoveryApplies,
  withZeroProgress,
  type ZeroProgressMemory,
} from "../ultragoal-runtime/recovery.js";
import {
  GOAL_CONTINUATION_DESCRIPTION,
  GOAL_TOOL_LESS_HOLD,
  goalContextText,
  goalContinuationText,
  goalHoldDescription,
  goalHoldNotice,
} from "./messages.js";
import {
  continuationForGoal,
  type GoalContinuation,
  type GoalContinuationHoldReason,
  parseGoalContinuation,
  readGoalStateTx,
  serializeGoalContinuation,
  visibleGoal,
} from "./state.js";

/** A synthetic message for `src/hooks.ts` to write. */
export type GoalMessage = { text: string; description: string; resume: boolean };

/**
 * The goal path of one `succeeded` (C-9 step 2): `inactive` when no goal is
 * active (the ralplan path may run), `held` while a hold stands (no
 * continuation at all, I-6), `message` for the continuation or a new hold's
 * notice.
 */
export type GoalContinuationDecision =
  | { kind: "inactive" }
  | { kind: "held" }
  | { kind: "message"; message: GoalMessage };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The ledger rows, or none when the ledger is missing or unreadable. */
async function ledgerRowsTx(tx: WorkflowTx): Promise<LedgerRow[]> {
  const read = parseLedger(await tx.readText(tx.paths.ultragoal.ledger));
  return read.kind === "valid" ? read.rows : [];
}

/** Write the record when it differs from the stored text (not audited, C-6). */
async function writeContinuationTx(
  tx: WorkflowTx,
  stored: string | undefined,
  record: GoalContinuation,
): Promise<void> {
  const text = serializeGoalContinuation(record);
  if (text !== stored) await tx.writeText(tx.paths.goalContinuation, text);
}

export function createGoalHooks(store: StateStore) {
  /** E-12: the zero-progress memory of the compaction recovery, per root. */
  const stall = new Map<string, ZeroProgressMemory>();

  /**
   * C-9 step 2, after the caller's marker, Esc and child checks. `toolCalls`
   * is the turn's tool-call count, `undefined` while the host has not shown
   * it delivers `session.tool.called` (a tool-less turn is not counted then).
   */
  async function decideContinuation(
    root: string,
    toolCalls: number | undefined,
  ): Promise<GoalContinuationDecision> {
    return store.workflowTransaction(root, async (tx) => {
      const goal = visibleGoal(await readGoalStateTx(tx));
      if (goal?.status !== "active") return { kind: "inactive" };
      const stored = await tx.readText(tx.paths.goalContinuation);
      const record = continuationForGoal(parseGoalContinuation(stored), goal.id);
      if (record.held) return { kind: "held" };
      const turns =
        toolCalls === undefined ? record.tool_less_turns : toolCalls === 0 ? record.tool_less_turns + 1 : 0;
      const hold = async (reason: GoalContinuationHoldReason): Promise<GoalContinuationDecision> => {
        await writeContinuationTx(tx, stored, {
          ...record,
          tool_less_turns: turns,
          held: { reason, at: new Date().toISOString() },
        });
        return {
          kind: "message",
          message: {
            text: goalHoldNotice(reason, CRITIC_STREAK_HOLD),
            description: goalHoldDescription(reason),
            resume: false,
          },
        };
      };
      if (turns >= GOAL_TOOL_LESS_HOLD) return hold("no_tool_progress");
      if (criticNonOkayStreak(await ledgerRowsTx(tx), record.critic_reset_after) >= CRITIC_STREAK_HOLD)
        return hold("critic_streak");
      await writeContinuationTx(tx, stored, { ...record, tool_less_turns: turns });
      return {
        kind: "message",
        message: {
          text: goalContinuationText(goal.objective),
          description: GOAL_CONTINUATION_DESCRIPTION,
          resume: true,
        },
      };
    });
  }

  /**
   * C-9 hold release, on a real user prompt at the root: the tool-less count
   * goes to 0 and a hold is lifted; only a critic hold moves
   * `critic_reset_after` to the newest `critic_verdict` (PQ-3 (1) A: without
   * a hold, a prompt leaves the critic count alone).
   */
  async function releaseHold(root: string): Promise<void> {
    await store.workflowTransaction(root, async (tx) => {
      const goal = visibleGoal(await readGoalStateTx(tx));
      if (!goal) return;
      const stored = await tx.readText(tx.paths.goalContinuation);
      const parsed = parseGoalContinuation(stored);
      if (parsed?.goal_id !== goal.id) return;
      if (!parsed.held && parsed.tool_less_turns === 0) return;
      const resetAfter =
        parsed.held?.reason === "critic_streak"
          ? (lastCriticVerdictId(await ledgerRowsTx(tx)) ?? parsed.critic_reset_after)
          : parsed.critic_reset_after;
      await writeContinuationTx(tx, stored, {
        goal_id: goal.id,
        tool_less_turns: 0,
        ...(resetAfter ? { critic_reset_after: resetAfter } : {}),
      });
    });
  }

  /** D-TL4: the goal context text while the root's goal is active. */
  async function contextText(root: string): Promise<string | undefined> {
    return store.workflowTransaction(root, async (tx) => {
      const goal = visibleGoal(await readGoalStateTx(tx));
      return goal?.status === "active" ? goalContextText(goal.objective) : undefined;
    });
  }

  /**
   * DR-17: the ultragoal recovery context of a compaction, while the
   * ultragoal row is active on a phase outside ultragoal's terminal states
   * `{missing, failed, complete, handoff}` and the goal is not paused. Each
   * observation updates the root's zero-progress memory (E-12).
   */
  async function ultragoalCompaction(root: string): Promise<string | undefined> {
    return store.workflowTransaction(root, async (tx) => {
      const { value: row } = await readRawJsonTx(tx, tx.paths.activeRow("ultragoal"));
      const goal = visibleGoal(await readGoalStateTx(tx));
      if (
        !ultragoalRecoveryApplies({
          rowActive: isRecord(row) && row.active !== false,
          phase: rowPhase(row),
          goalStatus: goal?.status,
        })
      )
        return undefined;
      const read = parseGoals(await tx.readText(tx.paths.ultragoal.goals));
      if (read.kind !== "valid") return undefined;
      const projection = projectUltragoalRun({
        file: read.file,
        rows: await ledgerRowsTx(tx),
        goalsPath: tx.paths.ultragoal.goals,
        objective: ultragoalGoalObjective(path.basename(tx.paths.sessionDir)),
      });
      if (!projection) return undefined;
      const memory = trackZeroProgress(stall.get(root), projection);
      stall.set(root, memory);
      return ultragoalCompactionMessage(
        renderUltragoalRecoveryContext(
          withZeroProgress(projection, memory),
          await tx.readText(tx.paths.ultragoal.progress),
        ),
      );
    });
  }

  return { decideContinuation, releaseHold, contextText, ultragoalCompaction };
}

export type GoalHooks = ReturnType<typeof createGoalHooks>;
