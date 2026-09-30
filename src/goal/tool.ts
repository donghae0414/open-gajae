// The `goal` tool (plan S2, DR-9, D-TL1~3): gjc's goal ops `get`, `create`,
// `complete`, `resume`, `drop` and `pause` over the lineage root's
// `state/goal-state.json` (D-SF6), with gjc's ultragoal guards in front of
// `pause` and `complete`. Each op runs in one `workflowTransaction`.
// Registered in `createTools` (plan S3).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `goals/tools/goal-tool.ts:22-29` (input), `:79-138`
//   (`executeGoalOperation`: `pause` and `complete` run their guard before the
//   goal is looked up, `:100-111,126-137`)
// - `gjc-runtime/ultragoal-guard.ts:532-644`
//   (`verifyUltragoalDurableCompletionState`: no `goals.json` is no run),
//   `:646-771` (`isUltragoalAskBlocked`: a run is active until it is verified
//   complete, and an ultragoal directory without `goals.json` fails closed),
//   `:866-886` (`assertCanCompleteCurrentGoal`), `:908-991`
//   (`isUltragoalPauseBlocked`, `assertUltragoalPauseAllowed`)
// - `gjc-runtime/ultragoal-receipt-freshness.ts:66-111`
//   (`findCleanPauseCriticVerdict`: the newest pause verdict bound to the
//   classification decides)
// Deviations (plan §7.1):
// - 8 (D-TL3): only `open-gajae` may call the tool; other agents are refused
//   at run time as the ralplan and ultragoal tools refuse them. No usage.
// - 10 (D-TL9): no nudge, and `drop` has no guard (gjc
//   `assertUltragoalDropAllowed` only nudges or fails closed on unreadable
//   state).
// - 32 (DR-11): the pause verdict is not bound to a plan generation, and the
//   terminal-critic ceiling does not block a pause.
// - 37 (DR-9): a dropped goal is no goal for every op after the guards.
// - 41 (DR-10): "complete" is the run completion of plan C-7
//   (`runCompletion`), and a refusal over a receipt names the goal to reopen.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StateStore, WorkflowTx } from "../state.js";
import { defineTool, type ToolCallContext } from "../tools/define.js";
import { type LedgerRead, parseLedger } from "../ultragoal-runtime/ledger.js";
import { type GoalsRead, parseGoals, requiredGoals, runCompletion } from "../ultragoal-runtime/plan.js";
import {
  COMPLETE_BLOCKED_OR_FAILED,
  COMPLETE_REVIEW_BLOCKED,
  completeIncompleteGoals,
  completeMissingFinalReceipt,
  GOAL_OBJECTIVE_DESCRIPTION,
  GOAL_OP_DESCRIPTION,
  GOAL_TOOL_DESCRIPTION,
  goalCompleteRefusal,
  goalPauseRefusal,
  goalToolNotAvailable,
  PAUSE_NEEDS_CRITIC_OKAY,
  PAUSE_NEEDS_HUMAN_BLOCKED,
  pauseStateUnverifiable,
  renderGoal,
  ULTRAGOAL_PLAN_MISSING,
  ultragoalStateUnreadable,
} from "./messages.js";
import {
  completeGoalState,
  createGoalState,
  dropGoalState,
  type GoalState,
  pauseGoalState,
  readGoalStateTx,
  resumeGoalState,
  validateGoalObjective,
  visibleGoal,
  writeGoalStateTx,
} from "./state.js";

const PRIMARY = "open-gajae";

// ---------------------------------------------------------------------------
// Guards (pure over the parsed ultragoal files)
// ---------------------------------------------------------------------------

export type UltragoalGuardInput = {
  goals: GoalsRead;
  ledger: LedgerRead;
  /** gjc `fs.stat(paths.dir)`: whether the `ultragoal/` directory exists. */
  dirExists?: boolean;
};

/**
 * The root session's `goals.json` and `ledger.jsonl`, strictly parsed, and
 * whether the `ultragoal/` directory exists. The store creates that
 * directory only by writing a file into it, so a listing with an entry
 * stands for gjc's `stat`.
 */
export async function readUltragoalGuardInput(tx: WorkflowTx): Promise<UltragoalGuardInput> {
  return {
    goals: parseGoals(await tx.readText(tx.paths.ultragoal.goals)),
    ledger: parseLedger(await tx.readText(tx.paths.ultragoal.ledger)),
    dirExists: (await tx.list(tx.paths.ultragoal.dir)).length > 0,
  };
}

/** The read failure the guards fail closed on, if any. */
function unreadable(input: UltragoalGuardInput): string | undefined {
  if (input.goals.kind === "invalid") return ultragoalStateUnreadable(input.goals.error);
  if (input.ledger.kind === "invalid") return ultragoalStateUnreadable(input.ledger.error);
  return undefined;
}

/**
 * DR-10: the refusal of `goal complete`, or undefined. Any goal is refused
 * while a plan exists that is not run-complete (C-7), whatever its source.
 * No `goals.json` is no run, even when the directory exists (gjc
 * `verifyUltragoalDurableCompletionState` reads a missing plan as inactive).
 */
export function goalCompleteGuard(input: UltragoalGuardInput): string | undefined {
  const failure = unreadable(input);
  if (failure) return goalCompleteRefusal(failure);
  if (input.goals.kind !== "valid" || input.ledger.kind !== "valid") return undefined;
  const file = input.goals.file;
  if (file.goals.some((goal) => goal.status === "review_blocked"))
    return goalCompleteRefusal(COMPLETE_REVIEW_BLOCKED);
  const incomplete = requiredGoals(file).filter((goal) => goal.status !== "complete");
  if (incomplete.some((goal) => goal.status === "blocked" || goal.status === "failed"))
    return goalCompleteRefusal(COMPLETE_BLOCKED_OR_FAILED);
  if (incomplete.length > 0)
    return goalCompleteRefusal(completeIncompleteGoals(incomplete.map((goal) => goal.id)));
  const run = runCompletion(file, input.ledger.rows);
  if (run.complete) return undefined;
  return goalCompleteRefusal(completeMissingFinalReceipt(run.reason), run.reopenGoalId);
}

/**
 * DR-11: the refusal of `goal pause`, or undefined. An ultragoal directory
 * without `goals.json` is unverifiable (gjc `isUltragoalAskBlocked`). While a
 * plan exists that is not run-complete, the latest `blocker_classified` must
 * be `human_blocked`, and the newest later pause `critic_verdict` bound to it
 * must be a clean OKAY (non-empty evidence, no blockers).
 */
export function goalPauseGuard(input: UltragoalGuardInput): string | undefined {
  const failure = unreadable(input);
  if (failure) return goalPauseRefusal(pauseStateUnverifiable(failure));
  if (input.goals.kind === "missing" && input.dirExists)
    return goalPauseRefusal(pauseStateUnverifiable(ULTRAGOAL_PLAN_MISSING));
  if (input.goals.kind !== "valid" || input.ledger.kind !== "valid") return undefined;
  const rows = input.ledger.rows;
  if (runCompletion(input.goals.file, rows).complete) return undefined;
  let classificationIndex = -1;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if ("event" in row && row.event === "blocker_classified") {
      classificationIndex = index;
      break;
    }
  }
  const classification = rows[classificationIndex];
  if (
    !classification ||
    !("event" in classification) ||
    classification.event !== "blocker_classified" ||
    classification.classification !== "human_blocked"
  )
    return goalPauseRefusal(PAUSE_NEEDS_HUMAN_BLOCKED);
  for (let index = rows.length - 1; index > classificationIndex; index--) {
    const row = rows[index];
    if (
      !("event" in row) ||
      row.event !== "critic_verdict" ||
      row.terminus !== "pause" ||
      row.classificationEventId !== classification.eventId
    )
      continue;
    const clean = row.verdict === "OKAY" && row.evidence.trim().length > 0 && row.blockers.length === 0;
    return clean ? undefined : goalPauseRefusal(PAUSE_NEEDS_CRITIC_OKAY);
  }
  return goalPauseRefusal(PAUSE_NEEDS_CRITIC_OKAY);
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export type GoalToolDeps = {
  /** `src/hooks.ts` `rootSession`: the lineage root, throwing on any failure. */
  rootSession(sessionID: string): Promise<string>;
  /** Test seams: the ISO time and the new goal id. */
  now?: () => string;
  newId?: () => string;
};

const input = z.object({
  op: z.enum(["create", "get", "complete", "resume", "drop", "pause"]).describe(GOAL_OP_DESCRIPTION),
  objective: z.string().describe(GOAL_OBJECTIVE_DESCRIPTION).optional(),
});

export function goalTool(store: StateStore, deps: GoalToolDeps) {
  const now = deps.now ?? (() => new Date().toISOString());
  const newId = deps.newId ?? randomUUID;

  /** D-TL3 actor, then the lineage root as owner (D-SF6). */
  async function ownerSession(context: Pick<ToolCallContext, "agent" | "sessionID">): Promise<string> {
    if (typeof context.sessionID !== "string" || context.sessionID.length === 0)
      throw new Error("a native session is required");
    if (context.agent !== PRIMARY) throw new Error(goalToolNotAvailable(context.agent));
    try {
      return await deps.rootSession(context.sessionID);
    } catch (error) {
      throw new Error("could not resolve the session lineage for goal", { cause: error });
    }
  }

  return defineTool({
    name: "goal",
    permission: "goal",
    description: GOAL_TOOL_DESCRIPTION,
    input,
    async execute(args, context) {
      const owner = await ownerSession(context);
      // gjc validates the create objective before it reaches the runtime.
      const objective = args.op === "create" ? validateGoalObjective(args.objective ?? "") : "";
      return store.workflowTransaction(owner, async (tx) => {
        // DR-9: the pause and complete guards run before the goal is looked up.
        if (args.op === "pause" || args.op === "complete") {
          const guardInput = await readUltragoalGuardInput(tx);
          const refusal = args.op === "pause" ? goalPauseGuard(guardInput) : goalCompleteGuard(guardInput);
          if (refusal) throw new Error(refusal);
        }
        const goal = await readGoalStateTx(tx);
        const at = now();
        let next: GoalState | undefined;
        switch (args.op) {
          case "get":
            return renderGoal(visibleGoal(goal));
          case "create":
            next = createGoalState(goal, { id: newId(), objective, source: "user", now: at });
            break;
          case "resume":
            next = resumeGoalState(goal, at);
            break;
          case "pause":
            next = pauseGoalState(goal, at);
            break;
          case "drop":
            next = dropGoalState(goal, at);
            break;
          case "complete":
            next = completeGoalState(goal, at);
            break;
        }
        if (next) await writeGoalStateTx(tx, next, "goal");
        return renderGoal(next);
      });
    },
  });
}
