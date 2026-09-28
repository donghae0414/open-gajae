// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT)
// `packages/coding-agent/src/skill-state/workflow-mutation-guard.ts:1698-1766`
// (`neutralTempRoots`, `isPathWithin`, `realpathOrSelf`,
// `canonicalizeForContainment`, `isNeutralTempPath`) and
// `gjc-runtime/ralplan-runtime.ts:811-858` (`readConfinedArtifactFile`: open
// with `O_NOFOLLOW`, require a regular file).
// DR-11 / deviation 30: the primary's `write{path}` accepts only a neutral temp
// file. gjc's SKILL allows an artifact path outside `.gjc/`, but its runtime
// accepts only a file inside the bound worktree
// (`ralplan-runtime.ts:2053-2070`) or, with `--worktree-root`, inside the
// invoking cwd (`:811-846`). gjc's post-open identity check reads
// `/proc/self/fd`, which macOS lacks; it is not carried over, so containment
// rests on the canonical check made just before the open.
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function neutralTempRoots(): string[] {
  const roots = new Set<string>();
  const add = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed) roots.add(path.resolve(trimmed));
  };
  add(os.tmpdir());
  add(process.env.TMPDIR);
  for (const fixed of ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"])
    add(fixed);
  return [...roots];
}

function isPathWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function realpathOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

/**
 * Realpath the nearest existing ancestor and re-append the missing suffix, so
 * a symlinked ancestor or the macOS `/tmp` → `/private/tmp` alias resolves.
 */
async function canonicalizeForContainment(absolutePath: string): Promise<string> {
  const suffix: string[] = [];
  let current = absolutePath;
  for (let depth = 0; depth < 64; depth++) {
    try {
      const real = await fs.realpath(current);
      return suffix.length > 0 ? path.join(real, ...suffix.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) break;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
  return absolutePath;
}

/**
 * A neutral scratch path: under a system temp root and outside `projectDir`,
 * both lexically and after resolving symlinks and aliases, so a temp symlink
 * back into the project is not neutral. A relative `target` resolves against
 * `projectDir`. Async because the recheck needs `realpath`.
 */
export async function isNeutralTempPath(
  target: string,
  projectDir: string,
): Promise<boolean> {
  const raw = target.trim();
  if (!raw) return false;
  const resolvedProject = path.resolve(projectDir);
  const absolutePath = path.resolve(resolvedProject, raw);
  if (isPathWithin(resolvedProject, absolutePath)) return false;
  if (!neutralTempRoots().some((root) => isPathWithin(root, absolutePath)))
    return false;
  const realTarget = await canonicalizeForContainment(absolutePath);
  if (isPathWithin(await realpathOrSelf(resolvedProject), realTarget))
    return false;
  const realRoots = await Promise.all(neutralTempRoots().map(realpathOrSelf));
  return realRoots.some((root) => isPathWithin(root, realTarget));
}

/**
 * The text of a neutral temp file for the primary's `write{path}`. The final
 * component must not be a symlink (`O_NOFOLLOW`) and the opened file must be
 * a regular file.
 */
export async function readTempArtifact(
  file: string,
  projectDir: string,
): Promise<string> {
  if (!(await isNeutralTempPath(file, projectDir)))
    throw new Error(
      `ralplan write path must be a file under an OS temp directory outside the project: ${file}`,
    );
  const candidate = path.resolve(projectDir, file.trim());
  let handle: fs.FileHandle;
  try {
    // `O_NONBLOCK` so a FIFO is refused below instead of hanging the open.
    handle = await fs.open(
      candidate,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    throw new Error(
      `failed to read ralplan write path ${candidate}: ${(error as Error).message}`,
    );
  }
  try {
    if (!(await handle.stat()).isFile())
      throw new Error(`ralplan write path is not a regular file: ${candidate}`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}
