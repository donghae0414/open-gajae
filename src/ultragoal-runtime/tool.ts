// The `ultragoal` tool (spec R17, plan S2): the only writer of the ultragoal
// plan, ledger, progress log, mode-state and row. Only `open-gajae` may call
// it; every op works on the calling session's lineage root (D-SF6) and runs in
// one `workflowTransaction` (C-1) over `./store.ts`. Results are the gjc
// human-readable text (C-14); a refusal is `Error: <message>`. Registered in
// `createTools` by plan S3; until then the old `src/ultragoal-tool.ts` serves.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/gjc-runtime/ultragoal-runtime.ts:5368-5647`
// (`dispatchUltragoalCommand`: `status`, `create-goals`, `complete-goals`,
// `checkpoint`, `quality-gate validate`, `steer`, `record-review-blockers`,
// `classify-blocker`, `record-critic-verdict`) and
// `gjc-runtime/state-runtime.ts` (`state` doctor, write, clear, handoff).
// The op-tool shape, actor check and root-session resolution follow
// `src/ralplan-runtime/tool.ts`.
// Deviations (plan §7.1): 3, 4 and 27 (structured `create`, the plan-change
// ops, `checkpoint` statuses `complete|failed|blocked|pending`), 25 (the state
// verbs are ops of this tool), 41 (op calls for gjc commands); D-TL3/R17: the
// tool belongs to `open-gajae` alone (I-12).

import { z } from "zod";
import type { StateStore } from "../state.js";
import { defineTool, type ToolCallContext } from "../tools/define.js";
import {
  addPatternTx,
  checkpointTx,
  classifyBlockerTx,
  clearStateTx,
  createTx,
  doctorTx,
  handoffTx,
  nextTx,
  patchStateTx,
  recordCriticVerdictTx,
  recordReviewBlockersTx,
  statusTx,
  steerTx,
  validateGateTx,
} from "./store.js";

const PRIMARY = "open-gajae";

/** R17, in the spec's order. */
export const ULTRAGOAL_OPS = [
  "status",
  "create",
  "next",
  "checkpoint",
  "validate_gate",
  "add",
  "revise",
  "supersede",
  "add_pattern",
  "record_review_blockers",
  "classify_blocker",
  "record_critic_verdict",
  "handoff",
  "doctor",
  "state",
  "clear",
] as const;

/** R17 plus `pending` (「E1」, deviation 27). */
export const CHECKPOINT_STATUSES = ["complete", "failed", "blocked", "pending"] as const;

export type UltragoalToolDeps = {
  /** `src/hooks.ts` `rootSession`: the lineage root, throwing on any failure. */
  rootSession(sessionID: string): Promise<string>;
};

const goalInput = z.object({
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
});

const input = z.object({
  op: z.enum(ULTRAGOAL_OPS).describe("The operation; see the ultragoal skill for each op's fields."),
  description: z
    .string()
    .optional()
    .describe("create: the task description. add/revise (goal): the goal description."),
  goals: z
    .array(goalInput)
    .optional()
    .describe("create: the goals in order, each with title, description and acceptanceCriteria."),
  retry_failed: z.boolean().optional().describe("next: take the first failed goal before pending ones."),
  goal_id: z
    .string()
    .optional()
    .describe(
      "checkpoint, validate_gate, revise/supersede, add (criterion), record_review_blockers, classify_blocker, record_critic_verdict: the goal (G001).",
    ),
  status: z.enum(CHECKPOINT_STATUSES).optional().describe("checkpoint: the new goal status; pending reopens a goal."),
  evidence: z.string().optional(),
  gate: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "checkpoint (complete), validate_gate: the quality gate (targetedVerification, architectReview, criteriaCoverage; the final goal adds reviewCohort and criticReview).",
    ),
  implementation: z.array(z.string()).optional().describe("checkpoint (complete): what was implemented."),
  files_changed: z.array(z.string()).optional().describe("checkpoint (complete): the files changed."),
  learnings: z.array(z.string()).optional().describe("checkpoint (complete): learnings for later goals."),
  target: z.enum(["goal", "criterion"]).optional().describe("add/revise/supersede: what the change is to."),
  title: z.string().optional().describe("add/revise (goal), record_review_blockers: the goal title."),
  acceptanceCriteria: z.array(z.string()).optional().describe("add (goal): the new goal's criteria."),
  after: z.string().optional().describe("add/revise (goal): place the goal right after this goal id."),
  criterion_id: z.string().optional().describe("revise/supersede (criterion): the criterion (G001.AC1)."),
  criterion: z.string().optional().describe("add/revise (criterion): the criterion text."),
  rationale: z.string().optional().describe("add/revise/supersede: why the plan changes."),
  reason: z.string().optional().describe("handoff: why control moves."),
  pattern: z.string().optional().describe("add_pattern: one codebase pattern line."),
  objective: z.string().optional().describe("record_review_blockers: the fix goal's objective."),
  classification: z.enum(["resolvable", "human_blocked"]).optional().describe("classify_blocker."),
  terminus: z.enum(["completion", "pause"]).optional().describe("record_critic_verdict."),
  verdict: z.enum(["OKAY", "ITERATE", "REJECT"]).optional().describe("record_critic_verdict."),
  blockers: z.array(z.string()).optional().describe("record_critic_verdict: the critic's blockers."),
  classification_event_id: z
    .string()
    .optional()
    .describe("record_critic_verdict (pause): the latest human_blocked classification's event id."),
  to: z.enum(["ralplan", "deep-interview"]).optional().describe("handoff: the target skill."),
  patch: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("state: fields to merge; null deletes a field. Derived fields are refused."),
  force: z.boolean().optional().describe("clear: overwrite a corrupt or stale state."),
});

type Args = z.output<typeof input>;

export function ultragoalTool(store: StateStore, deps: UltragoalToolDeps) {
  /** D-TL3: `open-gajae` only; the lineage root owns the run (D-SF6). */
  async function ownerSession(context: Pick<ToolCallContext, "agent" | "sessionID">): Promise<string> {
    if (typeof context.sessionID !== "string" || context.sessionID.length === 0)
      throw new Error("a native session is required");
    if (context.agent !== PRIMARY) throw new Error(`the ultragoal tool is not available to ${context.agent}`);
    try {
      return await deps.rootSession(context.sessionID);
    } catch (error) {
      throw new Error("could not resolve the session lineage for ultragoal", { cause: error });
    }
  }

  return defineTool({
    name: "ultragoal",
    permission: "ultragoal",
    description:
      "Operate this session's ultragoal run (gjc ultragoal): status, create the goals, next, checkpoint a goal (complete with its quality gate, failed, blocked, or pending to reopen), validate_gate, add/revise/supersede a goal or criterion, add_pattern, record_review_blockers, classify_blocker, record_critic_verdict, handoff to ralplan or deep-interview, doctor, state, clear. The only way to change ultragoal files and state.",
    input,
    async execute(args: Args, context) {
      const owner = await ownerSession(context);
      return store.workflowTransaction(owner, (tx) => {
        switch (args.op) {
          case "status":
            return statusTx(tx, owner);
          case "create":
            return createTx(tx, owner, args);
          case "next":
            return nextTx(tx, owner, args);
          case "checkpoint":
            return checkpointTx(tx, owner, args);
          case "validate_gate":
            return validateGateTx(tx, args);
          case "add":
          case "revise":
          case "supersede":
            return steerTx(tx, owner, args.op, args);
          case "add_pattern":
            return addPatternTx(tx, args);
          case "record_review_blockers":
            return recordReviewBlockersTx(tx, owner, args);
          case "classify_blocker":
            return classifyBlockerTx(tx, owner, args);
          case "record_critic_verdict":
            return recordCriticVerdictTx(tx, owner, args);
          case "handoff":
            return handoffTx(tx, owner, args);
          case "doctor":
            return doctorTx(tx);
          case "state":
            return patchStateTx(tx, owner, args);
          case "clear":
            return clearStateTx(tx, owner, args);
        }
        throw new Error(`unknown op ${String(args.op)}`);
      });
    },
  });
}
