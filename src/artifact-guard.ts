// Session-scoped artifact guard, the dynamic half of the planner's write scope.
// The static permission rules in `src/config.ts` pin writes to
// `.open-gajae/_session-*/(plans|drafts)/`, but a `config` hook runs once,
// before any session exists, so no static rule can name the current session.
// These pure helpers say which session folder a write would land in; the hook
// in `src/hooks.ts` compares that with the caller's root session.
//
// The rule is applied to every session, not just the planner's: the hook input
// carries no agent, and "write only into your own session folder" is correct
// for the leader too.

import { isAbsolute, relative, resolve, sep } from "node:path";

/** The tools that can create, change, move, or delete a file. */
const ARTIFACT_TOOLS = new Set(["write", "edit", "apply_patch"]);

/**
 * `apply_patch` carries every path inside one string argument. The markers are
 * the ones the host's own parser reads, and it trims the remainder of the line
 * exactly this way (`opencode/packages/opencode/src/patch/index.ts:76-93`).
 */
const PATCH_MARKERS = [
  "*** Add File:",
  "*** Update File:",
  "*** Delete File:",
  "*** Move to:",
] as const;

/** Matches a worktree-relative POSIX path inside a session's plans or drafts. */
const SESSION_ARTIFACT = /^\.open-gajae\/(_session-[^/]+)\/(?:plans|drafts)\//;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every filesystem path a tool call would touch, as the model wrote them:
 * absolute or relative, unresolved. Tools that write no file return `[]`.
 */
export function artifactPathsOf(tool: string, args: unknown): string[] {
  if (!ARTIFACT_TOOLS.has(tool) || !isRecord(args)) return [];
  if (tool !== "apply_patch") {
    const filePath = args.filePath;
    return typeof filePath === "string" && filePath.length > 0
      ? [filePath]
      : [];
  }
  const patchText = args.patchText;
  if (typeof patchText !== "string") return [];
  const paths: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    for (const marker of PATCH_MARKERS) {
      if (!line.startsWith(marker)) continue;
      const path = line.slice(marker.length).trim();
      if (path.length > 0) paths.push(path);
      break;
    }
  }
  return paths;
}

/**
 * `filePath` as a worktree-relative POSIX path, or `undefined` when it escapes
 * the worktree or is the worktree itself. A relative path is resolved against
 * the worktree.
 */
export function worktreeRelativePath(
  worktree: string,
  filePath: string,
): string | undefined {
  if (typeof filePath !== "string" || filePath.length === 0) return undefined;
  const root = resolve(worktree);
  const absolute = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  const path = relative(root, absolute);
  if (path.length === 0 || path.startsWith("..") || isAbsolute(path))
    return undefined;
  return path.split(sep).join("/");
}

/**
 * The `_session-…` folder that owns `filePath`, or `undefined` when the path is
 * not a session plan or draft. Paths outside the worktree are `undefined` too:
 * the static permission rules already refuse them, and this guard judges only
 * which session a session artifact belongs to.
 */
export function sessionArtifactOwner(
  worktree: string,
  filePath: string,
): string | undefined {
  const path = worktreeRelativePath(worktree, filePath);
  if (path === undefined) return undefined;
  return SESSION_ARTIFACT.exec(path)?.[1];
}
