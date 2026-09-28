// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT)
// `packages/coding-agent/src/gjc-runtime/repository-binding.ts:13-30,207-215`
// (`RepositoryBinding`, `captureRepositoryBinding`, `publicRepositoryBinding`),
// captured the way `gjc-runtime/ralplan-runtime.ts:930,2398` seeds a run
// (`displayPath` = the invoking directory). Deviation 12: the binding is
// record-only and best effort. gjc reads `.git` itself (`utils/git.ts`
// `repo.resolve`/`head.resolve`) and fails closed on a worktree mismatch; here
// `git` runs with a short timeout, a missing value is omitted, and nothing
// throws (D-T9).
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

export const REPOSITORY_BINDING_SCHEMA = "gjc.repository_binding.v1" as const;

export interface RepositoryBinding {
  schema: typeof REPOSITORY_BINDING_SCHEMA;
  /** Canonical realpath of the git worktree root (or resolved cwd root). */
  worktreeRoot: string;
  /** Git common dir realpath when available; null outside a git checkout. */
  commonDir: string | null;
  /** Optional display path (may be non-canonical); never used for authority. */
  displayPath?: string;
  /** Optional baseline HEAD at capture time. */
  head?: string;
  /** Optional branch name at capture time (when not detached). */
  branch?: string;
}

const GIT_TIMEOUT_MS = 2_000;

/** Trimmed stdout, or `undefined` on any failure (not a repo, no git, timeout). */
function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        args,
        { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
        (error, stdout) =>
          resolve(error ? undefined : String(stdout).trim() || undefined),
      );
    } catch {
      resolve(undefined);
    }
  });
}

async function realpathOrResolve(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * `gjc.repository_binding.v1` for `projectDir`. Outside a git checkout the
 * root is the project's realpath and `commonDir` is null; `head` is omitted
 * on an unborn branch and `branch` when HEAD is detached, as in gjc. Returns
 * `null` only when even the project directory cannot be resolved.
 */
export async function captureRepositoryBinding(
  projectDir: string,
): Promise<RepositoryBinding | null> {
  try {
    const cwd = await realpath(projectDir);
    const [root, commonDir, head, ref] = await Promise.all([
      git(cwd, ["rev-parse", "--show-toplevel"]),
      git(cwd, ["rev-parse", "--git-common-dir"]),
      git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]),
      git(cwd, ["symbolic-ref", "--quiet", "HEAD"]),
    ]);
    const inRepo = root !== undefined && commonDir !== undefined;
    // gjc keeps only a local branch (`utils/git.ts` `parseHeadState`).
    const branch = ref?.startsWith("refs/heads/")
      ? ref.slice("refs/heads/".length)
      : undefined;
    return {
      schema: REPOSITORY_BINDING_SCHEMA,
      worktreeRoot: inRepo ? await realpathOrResolve(root) : cwd,
      // `--git-common-dir` may print a path relative to the cwd.
      commonDir: inRepo
        ? await realpathOrResolve(path.resolve(cwd, commonDir))
        : null,
      displayPath: projectDir,
      ...(inRepo && head ? { head } : {}),
      ...(inRepo && branch ? { branch } : {}),
    };
  } catch {
    return null;
  }
}
