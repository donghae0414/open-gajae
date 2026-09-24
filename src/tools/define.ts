import type { z } from "zod";
import { errorText } from "./permissions.js";

/**
 * The fields of the v2 tool context these tools read. The host's `ToolContext`
 * satisfies it structurally (`schema/src/tool.ts:14-20` plus `signal`), and so
 * does a test fake.
 */
export type ToolCallContext = {
  readonly agent: string;
  readonly sessionID: string;
  readonly signal: AbortSignal;
};

/** A v2 promise-API tool as `ctx.tool.transform(e => e.add(tool))` takes it. */
export type PluginTool<S extends z.ZodType = z.ZodType> = {
  readonly name: string;
  readonly description: string;
  readonly input: S;
  readonly options: { readonly codemode: false; readonly permission: string };
  readonly execute: (
    input: z.output<S>,
    context: ToolCallContext,
  ) => Promise<{ content: string }>;
};

/**
 * Build one tool: direct (not Code Mode) with its visibility permission, and a
 * body whose failures come back as `content` instead of a throw (R14/R16).
 */
export function defineTool<S extends z.ZodType>(tool: {
  name: string;
  description: string;
  input: S;
  permission: string;
  execute(input: z.output<S>, context: ToolCallContext): Promise<string>;
}): PluginTool<S> {
  return {
    name: tool.name,
    description: tool.description,
    input: tool.input,
    options: { codemode: false, permission: tool.permission },
    async execute(input, context) {
      try {
        return { content: await tool.execute(input, context) };
      } catch (error) {
        return { content: `Error: ${errorText(error)}` };
      }
    },
  };
}
