import { randomUUID } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";

// State and payload-boundary behavior draws on OMC MIT sources; project notices carry attribution.
export const DEEP_INTERVIEW_MODE = "deep-interview" as const;

export type StateMeta = {
  mode: typeof DEEP_INTERVIEW_MODE;
  sessionId: string;
  updatedAt: string;
  updatedBy: "state_write_tool";
};

/** Model-owned fields are open-ended. `_meta` is regenerated on every write. */
export type InterviewState = Record<string, unknown> & { _meta?: StateMeta };

export type ExplicitStatePatch = {
  active?: boolean;
  iteration?: number;
  max_iterations?: number;
  current_phase?: string;
  task_description?: string;
  error?: string;
  plan_path?: string;
  started_at?: string;
  completed_at?: string;
};

export type SessionPaths = {
  sessionDir: string;
  statePath: string;
  specsDir: string;
  plansDir: string;
};

const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_NESTING_DEPTH = 10;
const MAX_TOP_LEVEL_KEYS = 100;
const MAX_SESSION_COMPONENT_BYTES = 255;
const targetQueues = new Map<string, Promise<void>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function now() {
  return new Date().toISOString();
}

function payloadError(
  value: unknown,
  excludeMetadata = false,
): string | undefined {
  if (!isRecord(value)) return "state must be a JSON object";
  const keys = Object.keys(value).filter(
    (key) => !excludeMetadata || key !== "_meta",
  );
  if (keys.length > MAX_TOP_LEVEL_KEYS)
    return `state exceeds ${MAX_TOP_LEVEL_KEYS} top-level keys`;
  const measured = excludeMetadata
    ? Object.fromEntries(keys.map((key) => [key, value[key]]))
    : value;

  const depth = (item: unknown, current = 0): number => {
    if (current > MAX_NESTING_DEPTH) return current;
    if (Array.isArray(item) || isRecord(item)) {
      let maximum = current + 1;
      for (const child of Array.isArray(item) ? item : Object.values(item)) {
        maximum = Math.max(maximum, depth(child, current + 1));
        if (maximum > MAX_NESTING_DEPTH) return maximum;
      }
      return maximum;
    }
    return current;
  };

  if (depth(measured) > MAX_NESTING_DEPTH)
    return `state exceeds nesting depth ${MAX_NESTING_DEPTH}`;

  try {
    if (Buffer.byteLength(JSON.stringify(measured), "utf8") > MAX_PAYLOAD_BYTES)
      return `state exceeds ${MAX_PAYLOAD_BYTES} bytes`;
  } catch {
    return "state is not JSON serializable";
  }
  return undefined;
}

function validateExplicitPatch(patch: ExplicitStatePatch) {
  for (const [key, max] of [
    ["current_phase", 200],
    ["task_description", 2000],
    ["error", 2000],
    ["plan_path", 500],
    ["started_at", 100],
    ["completed_at", 100],
  ] as const) {
    const value = patch[key];
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length === 0 || value.length > max)
    )
      throw new Error(
        `${key} must be a non-empty string up to ${max} characters`,
      );
  }
  if (patch.active !== undefined && typeof patch.active !== "boolean")
    throw new Error("active must be a boolean");
  for (const key of ["iteration", "max_iterations"] as const) {
    const value = patch[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value))
    )
      throw new Error(`${key} must be a finite number`);
  }
}

function snapshotState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  let serialized: string;
  try {
    serialized = JSON.stringify(state);
  } catch {
    throw new Error("state is not JSON serializable");
  }
  if (typeof serialized !== "string")
    throw new Error("state is not JSON serializable");
  return JSON.parse(serialized) as Record<string, unknown>;
}

/** Lowercase hexadecimal UTF-8 encoding makes every trusted host ID one path component. */
export function encodeSessionID(sessionID: string): string {
  if (typeof sessionID !== "string" || sessionID.length === 0)
    throw new Error("a non-empty native session ID is required");
  const bytes = Buffer.from(sessionID, "utf8");
  if (bytes.toString("utf8") !== sessionID)
    throw new Error("native session ID contains invalid Unicode");
  const encoded = bytes.toString("hex");
  if (
    encoded.length === 0 ||
    Buffer.byteLength(`_session-${encoded}`, "utf8") >
      MAX_SESSION_COMPONENT_BYTES
  )
    throw new Error("native session ID exceeds the filesystem component limit");
  return encoded;
}

function stateOwner(state: Record<string, unknown>): string | undefined {
  const meta = state._meta;
  if (isRecord(meta) && typeof meta.sessionId === "string")
    return meta.sessionId;
  return typeof state.session_id === "string" ? state.session_id : undefined;
}

function validateStoredState(
  value: unknown,
  sessionID: string,
): asserts value is InterviewState {
  const error = payloadError(value, true);
  if (error)
    throw new Error(`state file is invalid; it was preserved: ${error}`);
  const owner = stateOwner(value as Record<string, unknown>);
  if (owner !== undefined && owner !== sessionID)
    throw new Error(
      "state scope does not match this session; it was preserved",
    );
}

function enqueue<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const previous = targetQueues.get(target) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  targetQueues.set(target, tail);
  void tail.finally(() => {
    if (targetQueues.get(target) === tail) targetQueues.delete(target);
  });
  return run;
}

export class StateStore {
  readonly worktree: string;
  private readonly root: string;

  constructor(worktree: string) {
    const resolved = path.resolve(worktree);
    try {
      this.worktree = realpathSync(resolved);
    } catch {
      throw new Error("worktree does not exist");
    }
    this.root = path.join(this.worktree, ".open-gajae");
  }

  sessionPaths(sessionID: string): SessionPaths {
    const sessionDir = path.join(
      this.root,
      `_session-${encodeSessionID(sessionID)}`,
    );
    return {
      sessionDir,
      statePath: path.join(sessionDir, "state", "deep-interview-state.json"),
      specsDir: path.join(sessionDir, "specs"),
      plansDir: path.join(sessionDir, "plans"),
    };
  }

  statePath(sessionID: string) {
    return this.sessionPaths(sessionID).statePath;
  }

  private async inspectParent(file: string, create: boolean): Promise<boolean> {
    const canonicalWorktree = await fs.realpath(this.worktree).catch(() => {
      throw new Error("worktree does not exist");
    });
    if (canonicalWorktree !== this.worktree)
      throw new Error("worktree path changed after StateStore initialization");
    const relative = path.relative(canonicalWorktree, file);
    if (
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    )
      throw new Error("state path escapes worktree");

    let current = canonicalWorktree;
    for (const part of path.dirname(relative).split(path.sep)) {
      current = path.join(current, part);
      const stat = await fs
        .lstat(current)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
      if (!stat) {
        if (!create) return false;
        await fs
          .mkdir(current, { mode: 0o700 })
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
        const created = await fs.lstat(current);
        if (created.isSymbolicLink() || !created.isDirectory())
          throw new Error("state path contains a symlink or non-directory");
      } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("state path contains a symlink or non-directory");
      }
    }
    return true;
  }

  private async readFile(
    sessionID: string,
  ): Promise<InterviewState | undefined> {
    const file = this.statePath(sessionID);
    if (!(await this.inspectParent(file, false))) return undefined;
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return undefined;
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error("state file is not a regular file");

    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new Error("state file is corrupted; it was preserved");
      throw error;
    }
    validateStoredState(parsed, sessionID);
    return parsed;
  }

  private async atomicWrite(file: string, state: InterviewState) {
    const serialized = JSON.stringify(state, null, 2) + "\n";
    await this.inspectParent(file, true);
    const existing = await fs
      .lstat(file)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
    if (existing && (existing.isSymbolicLink() || !existing.isFile()))
      throw new Error(
        "refusing to replace a symlink or non-regular state file",
      );

    const temp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(temp, serialized, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temp, file);
    } catch (error) {
      await fs.unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  async read(sessionID: string): Promise<InterviewState | undefined> {
    const target = this.statePath(sessionID);
    return enqueue(target, () => this.readFile(sessionID));
  }

  async write(
    sessionID: string,
    state: Record<string, unknown> = {},
    explicit: ExplicitStatePatch = {},
  ): Promise<InterviewState> {
    const target = this.statePath(sessionID);
    const stateSnapshot = snapshotState(state);
    const explicitSnapshot = { ...explicit };
    const payload = payloadError(stateSnapshot);
    if (payload) throw new Error(payload);
    validateExplicitPatch(explicitSnapshot);

    return enqueue(target, async () => {
      await this.readFile(sessionID);
      const next: InterviewState = {
        ...stateSnapshot,
        ...explicitSnapshot,
        _meta: {
          mode: DEEP_INTERVIEW_MODE,
          sessionId: sessionID,
          updatedAt: now(),
          updatedBy: "state_write_tool",
        },
      };
      const error = payloadError(next, true);
      if (error) throw new Error(error);
      await this.atomicWrite(target, next);
      return next;
    });
  }

  async clear(sessionID: string): Promise<"deleted" | "missing"> {
    const target = this.statePath(sessionID);
    return enqueue(target, async () => {
      const current = await this.readFile(sessionID);
      if (!current) return "missing";
      await fs.unlink(target);
      return "deleted";
    });
  }
}
