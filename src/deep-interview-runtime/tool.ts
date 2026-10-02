// The `deep-interview` tool (spec D-SR1, plan S2): the only writer of the
// deep-interview state, its specs, spec index and row. Only `open-gajae` may
// call it; every op works on the calling session's lineage root (D-SR5) and
// runs in one `workflowTransaction` (C-1) over `./store.ts`. Results are JSON
// (the gjc `--json` keys), the doctor is gjc's doctor text, and a handoff
// adds its result line before the receipt (PQ-24 A, DR-9); a refusal is
// `Error: <message>`. Registered in `createTools` (plan S3a).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/gjc-runtime/deep-interview-runtime.ts:873-916`
// (`runNativeDeepInterviewCommand`: seed, `--write`), and
// `gjc-runtime/deep-interview-stage.ts:961-1034` (the `write`, `read`,
// `clear`, `handoff` verbs) with `gjc-runtime/state-runtime.ts` (state
// doctor, write, clear). The op-tool shape, actor check and root-session
// resolution follow `src/ultragoal-runtime/tool.ts`.
// Deviations (README "Deviations from GJC (deep-interview)"): 1 (CLI verbs →
// eight ops; the owner is the lineage root), 2 (no stage/check/apply/discard),
// 24 (the tool belongs to `open-gajae` alone), 38 (`spec(…, handoff:
// "ralplan")` stands for `--deliberate`; no `--force`).

import { z } from "zod";
import type { StateStore } from "../state.js";
import { defineTool, type ToolCallContext } from "../tools/define.js";
import {
  clearStateTx,
  DEFAULT_DEEP_INTERVIEW_SETTINGS,
  type DeepInterviewSettings,
  doctorTx,
  handoffTx,
  patchStateTx,
  resolveSpecContent,
  type SeedRalplanTx,
  STATE_FIELD_ALLOWLIST,
  specHandoffTx,
  startTx,
  statusTx,
  writeSpecTx,
  writeTx,
} from "./store.js";

const PRIMARY = "open-gajae";

/** Spec D-SR1, in the spec's order. */
export const DEEP_INTERVIEW_OPS = ["start", "write", "spec", "handoff", "status", "doctor", "state", "clear"] as const;

export type DeepInterviewToolDeps = {
  /** `src/hooks.ts` `rootSession`: the lineage root, throwing on any failure. */
  rootSession(sessionID: string): Promise<string>;
  /** The resolved `deepInterview` setting; the 0.05 default when absent (DR-28). */
  settings?: DeepInterviewSettings;
  /** The base of a relative `spec` path (PQ-6 A). */
  projectDir: string;
  /** The ralplan seed of `spec(…, handoff: "ralplan")` (DR-29, E-7). */
  seedRalplanTx?: SeedRalplanTx;
};

const input = z.object({
  op: z.enum(DEEP_INTERVIEW_OPS).describe("The operation; see the deep-interview skill for each op's fields."),
  idea: z.string().optional().describe("start: the idea to interview about."),
  threshold: z
    .number()
    .optional()
    .describe("start: the ambiguity threshold, 0 < threshold <= 1; overrides the setting."),
  input: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('write: the JSON to merge, e.g. {"state": {"rounds": [<round record>]}}; rounds merge by round_key.'),
  reset: z.boolean().optional().describe("write: rebuild the state from this input alone."),
  content: z.string().optional().describe("spec: the final spec (Markdown)."),
  path: z
    .string()
    .optional()
    .describe("spec: a file holding the spec (relative to the project); a path that does not exist is the spec text."),
  slug: z.string().optional().describe("spec: the file slug (specs/deep-interview-<slug>.md); default UTC time + hex."),
  handoff: z
    .enum(["ralplan"])
    .optional()
    .describe("spec: also seed ralplan (deliberate, the spec as the task) and hand off to it."),
  to: z.enum(["ralplan", "ultragoal"]).optional().describe("handoff: the target skill."),
  fields: z.array(z.enum(STATE_FIELD_ALLOWLIST)).optional().describe("status: project only these fields."),
  patch: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("state: fields to merge; null deletes a field. Rounds, facts, ambiguity and spec fields are refused."),
  force: z.boolean().optional().describe("clear: overwrite a corrupt or stale state."),
});

type Args = z.output<typeof input>;

export function deepInterviewTool(store: StateStore, deps: DeepInterviewToolDeps) {
  const settings = deps.settings ?? DEFAULT_DEEP_INTERVIEW_SETTINGS;

  /** D-HL7: `open-gajae` only; the lineage root owns the interview (D-SR5). */
  async function ownerSession(context: Pick<ToolCallContext, "agent" | "sessionID">): Promise<string> {
    if (typeof context.sessionID !== "string" || context.sessionID.length === 0)
      throw new Error("a native session is required");
    if (context.agent !== PRIMARY) throw new Error(`the deep-interview tool is not available to ${context.agent}`);
    try {
      return await deps.rootSession(context.sessionID);
    } catch (error) {
      throw new Error("could not resolve the session lineage for deep-interview", { cause: error });
    }
  }

  /** `spec`: the body from `content`, or from `path` by gjc's rule. */
  async function specContent(args: Args): Promise<string> {
    if (args.content !== undefined && args.path !== undefined)
      throw new Error("content and path are mutually exclusive");
    if (args.content !== undefined && args.content !== "") return args.content;
    if (args.path !== undefined && args.path !== "") return resolveSpecContent(args.path, deps.projectDir);
    throw new Error("content or path is required for deep-interview spec");
  }

  return defineTool({
    name: "deep-interview",
    permission: "deep-interview",
    description:
      "This is the deep-interview state tool, not the skill: load the `deep-interview` skill to run an interview. Ops: start (seed this session's interview), write (merge rounds, facts and context; ambiguity is derived), spec (persist the final spec; handoff: ralplan also seeds ralplan and hands off), handoff (to ralplan or ultragoal after the spec), status, doctor, state (merge patch; phases follow the table), clear. The only way to change deep-interview state and specs.",
    input,
    async execute(args: Args, context) {
      const owner = await ownerSession(context);
      switch (args.op) {
        case "start":
          return store.workflowTransaction(owner, (tx) =>
            startTx(tx, owner, { idea: args.idea, threshold: args.threshold }, settings),
          );
        case "write":
          return store.workflowTransaction(owner, (tx) =>
            writeTx(tx, owner, { input: args.input, reset: args.reset }),
          );
        case "spec": {
          const seed = deps.seedRalplanTx;
          if (args.handoff === "ralplan" && seed === undefined)
            throw new Error(
              'spec(handoff: "ralplan") is not available here; call deep-interview spec, then deep-interview handoff(to: "ralplan")',
            );
          const content = await specContent(args);
          const spec = { content, slug: args.slug };
          return store.workflowTransaction(owner, (tx) =>
            args.handoff === "ralplan" && seed !== undefined
              ? specHandoffTx(tx, owner, spec, seed)
              : writeSpecTx(tx, owner, spec),
          );
        }
        case "handoff": {
          const to = args.to;
          if (to === undefined) throw new Error('to is required for deep-interview handoff ("ralplan" or "ultragoal")');
          return store.workflowTransaction(owner, (tx) => handoffTx(tx, owner, to));
        }
        case "status":
          return store.workflowTransaction(owner, (tx) => statusTx(tx, args.fields));
        case "doctor":
          return store.workflowTransaction(owner, (tx) => doctorTx(tx));
        case "state": {
          const patch = args.patch;
          if (patch === undefined) throw new Error("patch is required for deep-interview state");
          return store.workflowTransaction(owner, (tx) => patchStateTx(tx, owner, patch));
        }
        case "clear":
          return store.workflowTransaction(owner, (tx) => clearStateTx(tx, owner, args.force === true));
      }
      throw new Error(`unknown op ${String(args.op)}`);
    },
  });
}
