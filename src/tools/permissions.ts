import { realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { projectRelative } from "../artifact-guard.js";

/**
 * The fields of the v2 tool context the code tools read. The host's
 * `ToolContext` satisfies it structurally, and so does a test fake.
 */
export type CodeToolContext = {
  readonly agent: string;
  readonly signal: AbortSignal;
};

/**
 * The host directories the code tools resolve against, fixed at setup:
 * `locationDir` is `ctx.location.directory` (the base for relative input) and
 * `projectDir` is `ctx.location.project.directory` (the containment root).
 */
export type CodeToolPaths = {
  readonly locationDir: string;
  readonly projectDir: string;
};

const CODE_ACTORS = new Set([
  "open-gajae",
  "open-gajae-explore",
  "open-gajae-architect",
  "open-gajae-critic",
  "open-gajae-planner",
  "open-gajae-document-specialist",
]);

/** The actor check shared by every code tool; also honors cancellation. */
export function assertCodeReader(context: CodeToolContext): void {
  if (!CODE_ACTORS.has(context.agent))
    throw new Error(`Agent ${context.agent} cannot use open-gajae code tools`);
  context.signal.throwIfAborted();
}

/** `.env` and `.env.*` files are never read by the code tools. */
export function isEnvFile(path: string): boolean {
  const name = basename(path);
  return name === ".env" || name.startsWith(".env.");
}

/**
 * The project boundary that replaces v1's host permission asks: resolve the
 * input against `locationDir`, follow symlinks, and require the real target to
 * stay inside the real project directory. `.env*` files are refused by both
 * the requested and the real name. Returns the real path.
 */
export async function resolveProjectPath(
  paths: CodeToolPaths,
  input: string,
): Promise<string> {
  const requested = resolve(paths.locationDir, input);
  if (isEnvFile(requested))
    throw new Error(`${input} is an environment file; code tools do not read it`);
  const root = await realpath(paths.projectDir);
  const canonical = await realpath(requested);
  if (projectRelative(root, root, canonical) === undefined)
    throw new Error(`${input} resolves outside the project directory`);
  if (isEnvFile(canonical))
    throw new Error(`${input} is an environment file; code tools do not read it`);
  return canonical;
}

/** Turn any failure into the content string a tool returns (R14/R16). */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
