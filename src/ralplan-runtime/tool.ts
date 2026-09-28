// The `ralplan` tool: the only writer of the ralplan state, the run's stage
// files, ledger and pending-approval copy, the active row and the audit log
// (spec D-W1). Seven ops mirror the gjc CLI and state verbs (D-W2): `start`
// (`gjc ralplan "<task>"`), `write` (`gjc ralplan --write`), `status`
// (`gjc state read ralplan`, OQ4), `doctor`, `state` (`gjc state ralplan
// write`), `handoff` (to ultragoal) and `clear`. Every op works on the calling
// session's lineage root (DR-1); record operations run in one
// `ralplanTransaction` each (`./store.ts`).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/gjc-runtime/ralplan-runtime.ts:1535-1583`
// (`resolveArtifactArgs`: stage, stage_n, artifact, run-id precedence, empty
// artifact), `:2033-2261` (`handleArtifactWrite`), `:2382-2475` (seed),
// `gjc-runtime/workflow-cli-common.ts:24-30` (`assertSafePathComponent`, via
// `RalplanTx.paths.runDir`), and `gjc-runtime/state-runtime.ts` (read, write,
// clear, doctor). Op-tool shape and actor checks follow `src/ultragoal-tool.ts`.
// Deviations (plan §7.1): 1 (CLI → ops), 2 (roles pass `content` only; the
// primary may pass an OS temp `path`, R-O4), 5 (the role session id is
// recorded from `context.sessionID`; one `resumable` input), 30 (a primary
// `path` must be a neutral temp file, DR-11), 31 (`start{run_id}`, DR-19), 32
// (the owner session is the lineage root, not an argument, DR-1), 34 (the
// handoff needs a phase in T, DR-7). DR-22: agents the plugin does not own
// can see the tool and are refused at run time.

import { z } from "zod";
import { type StateStore, ULTRAGOAL_MODE } from "../state.js";
import { defineTool, type ToolCallContext } from "../tools/define.js";
import { isUltragoalRunning, RALPLAN_ACTIVATION_REFUSAL } from "../ultragoal.js";
import {
  parseLaneVerdict,
  parsePersistedRoleState,
  parseStageN,
  type PersistedRole,
  persistedRoleForStage,
  RALPLAN_DEFAULT_MAX_ITERATIONS,
  RALPLAN_DEFAULT_MAX_REVIEW_PASSES_PER_LANE,
} from "./ledger.js";
import { assertRalplanStage } from "./manifest.js";
import {
  clearStateTx,
  doctorTx,
  patchStateTx,
  ralplanHandoff,
  type RalplanSettings,
  readStatusTx,
  STATE_FIELD_ALLOWLIST,
  startRun,
  writeStageTx,
} from "./store.js";
import { readTempArtifact } from "./temp-paths.js";

const PRIMARY = "open-gajae";
/** D-W3: the three role agents and the ops their gjc prompts may call. */
const ROLES: Record<string, PersistedRole> = {
  "open-gajae-planner": "planner",
  "open-gajae-architect": "architect",
  "open-gajae-critic": "critic",
};
const ROLE_OPS = new Set(["write", "status", "state"]);

/** gjc defaults with `source: "default"` (spec D-S1, DR-13). */
export const DEFAULT_RALPLAN_SETTINGS: RalplanSettings = {
  maxIterations: RALPLAN_DEFAULT_MAX_ITERATIONS,
  maxReviewPassesPerLane: RALPLAN_DEFAULT_MAX_REVIEW_PASSES_PER_LANE,
  autoHandoff: "off",
  source: {
    maxIterations: "default",
    maxReviewPassesPerLane: "default",
    autoHandoff: "default",
  },
};

export type RalplanToolDeps = {
  /** `src/hooks.ts` `rootSession`: the lineage root, throwing on any failure. */
  rootSession(sessionID: string): Promise<string>;
  settings: RalplanSettings;
  /** Resolves a relative temp `path` and records the repository binding. */
  projectDir: string;
};

const input = z.object({
  op: z
    .enum(["start", "write", "status", "doctor", "state", "handoff", "clear"])
    .describe("The operation; see the ralplan skill for each op's fields."),
  task: z.string().optional().describe("start: the planning task."),
  interactive: z.boolean().optional().describe("start: gjc --interactive."),
  deliberate: z.boolean().optional().describe("start: gjc --deliberate."),
  run_id: z
    .string()
    .optional()
    .describe(
      "start/write: the run folder (1-64 of A-Z a-z 0-9 . _ -, no ..); defaults to the state's run_id, then the session id.",
    ),
  stage: z
    .string()
    .optional()
    .describe(
      "write: planner, intent, architect, critic, disposition, revision, post-interview, adr or final.",
    ),
  stage_n: z.number().optional().describe("write: the pass number, 1..999."),
  content: z
    .string()
    .optional()
    .describe("write: the full artifact (Markdown; disposition is JSON)."),
  path: z
    .string()
    .optional()
    .describe("write (primary only): a file under the OS temp directory holding the artifact."),
  lane_verdict: z
    .string()
    .optional()
    .describe("write: architect CLEAR/WATCH/BLOCK or critic OKAY/ITERATE/REJECT."),
  resumable: z
    .boolean()
    .optional()
    .describe("write (planner/revision/architect/critic): whether this role session can be resumed."),
  fallback_reason: z
    .string()
    .optional()
    .describe(
      "write: why a role session was not resumed: context_unavailable, not_found, no_runner, resume_failed, process_restart or missing_record.",
    ),
  fallback_attempted_id: z.string().optional().describe("write: the session id that could not be resumed."),
  fallback_stage_n: z.number().optional().describe("write: the stage_n of the failed resume."),
  fallback_receipt_path: z.string().optional().describe("write: the receipt path of the failed resume."),
  fields: z
    .array(z.enum(STATE_FIELD_ALLOWLIST))
    .optional()
    .describe("status: project only these fields."),
  patch: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('state: fields to merge; null deletes a field. Stop here is {"active": false}.'),
  to: z.enum(["ultragoal"]).optional().describe("handoff: the target skill."),
  force: z.boolean().optional().describe("clear: overwrite a corrupt state."),
});

type Args = z.output<typeof input>;

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function ralplanTool(store: StateStore, deps: RalplanToolDeps) {
  /** D-W3 actors (DR-22), then the lineage root as owner (DR-1). */
  async function ownerSession(
    context: Pick<ToolCallContext, "agent" | "sessionID">,
    op: Args["op"],
  ): Promise<string> {
    if (typeof context.sessionID !== "string" || context.sessionID.length === 0)
      throw new Error("a native session is required");
    if (context.agent !== PRIMARY) {
      if (!(context.agent in ROLES))
        throw new Error(`the ralplan tool is not available to ${context.agent}`);
      if (!ROLE_OPS.has(op))
        throw new Error(`${context.agent} may only use write, status and state`);
    }
    try {
      return await deps.rootSession(context.sessionID);
    } catch (error) {
      throw new Error("could not resolve the session lineage for ralplan", {
        cause: error,
      });
    }
  }

  async function start(args: Args, owner: string): Promise<string> {
    // Read before the ralplan transaction (C-1.2); only a running ultragoal refuses.
    const ultragoal = await store.read(owner, ULTRAGOAL_MODE).catch(() => undefined);
    if (isUltragoalRunning(ultragoal)) throw new Error(RALPLAN_ACTIVATION_REFUSAL);
    const summary = await startRun(
      store,
      owner,
      {
        task: args.task ?? "",
        interactive: args.interactive,
        deliberate: args.deliberate,
        run_id: args.run_id,
      },
      { projectDir: deps.projectDir },
    );
    return json({ ok: true, ...summary });
  }

  async function write(
    args: Args,
    context: Pick<ToolCallContext, "agent" | "sessionID">,
    owner: string,
  ): Promise<string> {
    const role = ROLES[context.agent];
    // R-O4: a role passes content only; refused before any path judgement.
    if (role && args.path !== undefined)
      throw new Error(
        `${context.agent} must pass the artifact as content; path is for the primary agent only`,
      );
    if (args.stage === undefined) throw new Error("stage is required for ralplan write");
    const stage = args.stage;
    assertRalplanStage(stage);
    const stageN = parseStageN(args.stage_n);
    if (args.content === undefined && args.path === undefined)
      throw new Error("content or path is required for ralplan write");
    if (args.content !== undefined && args.path !== undefined)
      throw new Error("content and path are mutually exclusive");
    const artifact =
      args.content ?? (await readTempArtifact(args.path!, deps.projectDir));
    if (artifact === "") throw new Error("artifact content is empty");
    // Deviation 5: the calling role's own session, on its own lane only.
    const subagent =
      role && persistedRoleForStage(stage) === role
        ? { role, id: context.sessionID }
        : undefined;
    const persistedRoleState = parsePersistedRoleState(stage, {
      subagent,
      resumable: args.resumable,
      fallbackReason: args.fallback_reason,
      fallbackAttemptedId: args.fallback_attempted_id,
      fallbackStageN: args.fallback_stage_n,
      fallbackReceiptPath: args.fallback_receipt_path,
    });
    const laneVerdict = parseLaneVerdict(stage, stageN, args.lane_verdict);
    // R-AE1: no refusal while ultragoal runs.
    const result = await store.ralplanTransaction(owner, (tx) =>
      writeStageTx(tx, {
        sessionId: owner,
        stage,
        stageN,
        runId: args.run_id,
        artifact,
        persistedRoleState,
        laneVerdict,
        settings: deps.settings,
        projectDir: deps.projectDir,
      }),
    );
    return result.kind === "stuck"
      ? `${result.detail}\n${json(result.payload)}`
      : `${result.text}\n${json(result.payload)}`;
  }

  return defineTool({
    name: "ralplan",
    permission: "ralplan",
    description:
      "Operate this session's ralplan run (gjc ralplan): start a run, write a stage artifact (planner, intent, architect, critic, disposition, revision, post-interview, adr, final) and get its receipt, status, doctor, state (merge patch; Stop here is {active:false}), handoff to ultragoal after final, clear. The only way to change ralplan files and state.",
    input,
    async execute(args, context) {
      const owner = await ownerSession(context, args.op);
      switch (args.op) {
        case "start":
          return start(args, owner);
        case "write":
          return write(args, context, owner);
        case "status": {
          const { result, warning } = await store.ralplanTransaction(owner, (tx) =>
            readStatusTx(tx, args.fields),
          );
          return warning ? `${json(result)}\n${warning}` : json(result);
        }
        case "doctor":
          return json(await store.ralplanTransaction(owner, (tx) => doctorTx(tx)));
        case "state": {
          if (args.patch === undefined) throw new Error("patch is required for ralplan state");
          const patch = args.patch;
          return json(
            await store.ralplanTransaction(owner, (tx) => patchStateTx(tx, owner, patch)),
          );
        }
        case "handoff":
          if (args.to !== "ultragoal") throw new Error('to must be "ultragoal"');
          return ralplanHandoff(store, owner);
        case "clear":
          return json(
            await store.ralplanTransaction(owner, (tx) =>
              clearStateTx(tx, owner, args.force === true),
            ),
          );
      }
      throw new Error(`unknown op ${String(args.op)}`);
    },
  });
}

