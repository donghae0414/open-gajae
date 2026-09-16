import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ToolContext } from "@opencode-ai/plugin";

/** Native operation authorization, not a sandbox for language-server internal I/O. */
export function assertCodeReader(context: ToolContext): void {
  if (!["open-gajae", "open-gajae-explore"].includes(context.agent))
    throw new Error(`Agent ${context.agent} cannot use open-gajae code tools`);
  context.abort.throwIfAborted();
}

export class ReadPermissionError extends Error {
  constructor(cause: unknown) {
    super("Native read or external-directory permission was denied", { cause });
    this.name = "ReadPermissionError";
  }
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function external(
  context: ToolContext,
  target: string,
  directory: boolean,
): Promise<void> {
  const roots = [
    path.resolve(context.worktree),
    path.resolve(context.directory),
    ...(await Promise.all([
      realpath(context.worktree),
      realpath(context.directory),
    ])),
  ];
  if (roots.some((root) => contains(root, target))) return;
  const parentDir = directory ? target : path.dirname(target);
  const pattern = path.join(parentDir, "*").replaceAll("\\", "/");
  await context.ask({
    permission: "external_directory",
    patterns: [pattern],
    always: [pattern],
    metadata: { filepath: target, parentDir },
  });
}

/** Check both the requested path and its real target before reading any contents. */
export async function authorizePath(
  context: ToolContext,
  input: string,
  options: { directory?: boolean; read?: boolean } = {},
): Promise<string> {
  assertCodeReader(context);
  const requested = path.resolve(context.directory, input);
  // realpath is metadata resolution only. External permission precedes content I/O.
  try {
    await external(context, requested, options.directory ?? false);
  } catch (error) {
    throw new ReadPermissionError(error);
  }
  const canonical = await realpath(requested);
  try {
    if (canonical !== requested)
      await external(context, canonical, options.directory ?? false);
    if (options.read) {
      const targets = [...new Set([requested, canonical])];
      await context.ask({
        permission: "read",
        patterns: targets,
        always: [],
        metadata: {
          filepath: canonical,
          requested,
          directory: options.directory ?? false,
        },
      });
    }
  } catch (error) {
    throw new ReadPermissionError(error);
  }
  context.abort.throwIfAborted();
  return canonical;
}

export async function authorizeOperation(
  context: ToolContext,
  permission: "lsp" | "ast_grep_search",
): Promise<void> {
  assertCodeReader(context);
  await context.ask({
    permission,
    patterns: ["*"],
    always: ["*"],
    metadata: { operation: permission },
  });
  context.abort.throwIfAborted();
}
