// Session-scoped artifact guard, the dynamic half of the planner's write scope.
// The static permission rules in `src/config.ts` pin writes to
// `.open-gajae/_session-*/(plans|drafts)/`, but no static rule can name the
// current session. These pure helpers say which session folder a write would
// land in; the `execute.before` hook in `src/hooks.ts` compares that with the
// caller's root session.
//
// The rule is applied to every session, not just the planner's: "write only
// into your own session folder" is correct for the leader too.

import { isAbsolute, relative, resolve, sep } from "node:path";

/** The v2 tools that can create, change, move, or delete a file. */
export const ARTIFACT_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "patch",
]);

/**
 * `patch` carries every path inside one string argument. The markers are the
 * ones the host's own parser reads; it trims the whole line before matching and
 * trims the remainder (`opencode/packages/util/src/patch.ts:50-72`).
 */
const PATCH_MARKERS = [
  "*** Add File:",
  "*** Update File:",
  "*** Delete File:",
  "*** Move to:",
] as const;

/** Matches a project-relative POSIX path inside a session's plans or drafts. */
const SESSION_ARTIFACT = /^\.open-gajae\/(_session-[^/]+)\/(?:plans|drafts)\//;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every filesystem path a tool call would touch, as the model wrote them:
 * absolute or relative, unresolved. Tools that write no file return `[]`.
 * v2 `write`/`edit` take `path`; `patch` takes `patchText`.
 */
export function artifactPathsOf(tool: string, input: unknown): string[] {
  if (!ARTIFACT_TOOLS.has(tool) || !isRecord(input)) return [];
  if (tool !== "patch") {
    const path = input.path;
    return typeof path === "string" && path.length > 0 ? [path] : [];
  }
  const patchText = input.patchText;
  if (typeof patchText !== "string") return [];
  const paths: string[] = [];
  for (const raw of patchText.split("\n")) {
    const line = raw.trim();
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
 * The shared path base (plan "Path base"): resolve `p` against the host's
 * `location.directory` — the base its own `edit` resources use
 * (`core/src/file-access.ts:99-110`) — then relativize to the project
 * directory. Returns a POSIX path, `""` for the project directory itself, or
 * `undefined` when `p` lands outside the project.
 */
export function projectRelative(
  locationDir: string,
  projectDir: string,
  p: string,
): string | undefined {
  if (typeof p !== "string" || p.length === 0) return undefined;
  const absolute = isAbsolute(p) ? resolve(p) : resolve(locationDir, p);
  const path = relative(resolve(projectDir), absolute);
  if (path === "..") return undefined;
  if (path.startsWith(`..${sep}`) || isAbsolute(path)) return undefined;
  return path.split(sep).join("/");
}

/**
 * The project directory as the model addresses it from `locationDir`: a POSIX
 * path with a trailing `/`, or `""` when the two are the same directory.
 */
export function projectPrefix(locationDir: string, projectDir: string): string {
  const rel = relative(locationDir, projectDir).split(sep).join("/");
  return rel ? `${rel}/` : "";
}

/**
 * The `_session-…` folder that owns `p`, or `undefined` when the path is not a
 * session plan or draft. Paths outside the project are `undefined` too: the
 * static permission rules already refuse them, and this guard judges only
 * which session a session artifact belongs to.
 */
export function sessionArtifactOwner(
  locationDir: string,
  projectDir: string,
  p: string,
): string | undefined {
  const path = projectRelative(locationDir, projectDir, p);
  if (path === undefined) return undefined;
  return SESSION_ARTIFACT.exec(path)?.[1];
}
