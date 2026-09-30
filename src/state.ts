import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs, realpathSync } from "node:fs";
import path from "node:path";

// State and payload-boundary behavior draws on OMC MIT sources; project notices carry attribution.
export const DEEP_INTERVIEW_MODE = "deep-interview" as const;
export const RALPLAN_MODE = "ralplan" as const;
/** Plugin-owned: no `state_*` tool accepts it (plan §7, decision 21). */
export const ULTRAGOAL_MODE = "ultragoal" as const;

export type StateMode =
  | typeof DEEP_INTERVIEW_MODE
  | typeof RALPLAN_MODE
  | typeof ULTRAGOAL_MODE;

export type StateWriter =
  | "state_write_tool"
  | "ralplan_hook"
  | "ultragoal_hook"
  | "ultragoal_tool"
  | "ralplan_tool";

export type StateMeta = {
  mode: StateMode;
  sessionId: string;
  updatedAt: string;
  updatedBy: StateWriter;
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
  awaiting_confirmation?: boolean;
  breaker_count?: number;
  breaker_updated_at?: string;
  deactivated_reason?: string;
  restored_at?: string;
};

/**
 * The operations `ralplanTransaction` hands its body; none of them queue. Every
 * file argument must resolve inside the owner's session directory.
 */
export type RalplanTx = {
  readonly paths: {
    sessionDir: string;
    /** `state/ralplan-state.json` */
    statePath: string;
    /** `state/ralplan-continuation.json` */
    continuationPath: string;
    /** `state/audit.jsonl` */
    auditPath: string;
    /** `state/active/ralplan.json` */
    activeRowPath: string;
    /** `state/skill-active-state.json` */
    snapshotPath: string;
    /** `plans/ralplan/<runId>`; `runId` must be one safe path component. */
    runDir(runId: string): string;
  };
  readState(): Promise<InterviewState | undefined>;
  /**
   * Replaces the whole state (not a merge); `_meta` is regenerated. The gjc
   * envelope is open, so only the payload limits apply, not the explicit-field
   * checks the `state_*` tools use.
   */
  writeState(
    state: Record<string, unknown>,
    updatedBy: StateWriter,
  ): Promise<InterviewState>;
  readText(file: string): Promise<string | undefined>;
  writeText(file: string, text: string): Promise<void>;
  /** Appends `line` plus a newline; `line` must not contain one (JSONL). */
  appendLine(file: string, line: string): Promise<void>;
  /** Sorted entry names; `[]` when the directory is missing. */
  list(dir: string): Promise<string[]>;
  remove(file: string): Promise<"deleted" | "missing">;
};

/**
 * Plan C-1 (E-1): the operations `workflowTransaction` hands its body; none
 * of them queue. A superset of `RalplanTx`, whose ralplan paths it keeps, with
 * every other workflow file of the session reachable by name.
 */
export type WorkflowTx = RalplanTx & {
  readonly paths: RalplanTx["paths"] & {
    /** `state/active/<skill>.json`; `skill` must be one safe path component. */
    activeRow(skill: string): string;
    /** `state/transactions` (handoff journals). */
    transactionsDir: string;
    /** `state/<mode>-state.json` */
    modeState(mode: StateMode): string;
    /** `ultragoal/` and its `goals.json`, `progress.txt`, `ledger.jsonl`. */
    ultragoal: { dir: string; goals: string; progress: string; ledger: string };
    /** `state/goal-state.json` */
    goalState: string;
    /** `state/goal-continuation.json` (hook-only, PQ-2 B) */
    goalContinuation: string;
  };
  readModeState(mode: StateMode): Promise<InterviewState | undefined>;
  /** Replaces the whole state (not a merge); `_meta` is regenerated. */
  writeModeState(
    mode: StateMode,
    state: Record<string, unknown>,
    updatedBy: StateWriter,
  ): Promise<InterviewState>;
};

export type SessionPaths = {
  sessionDir: string;
  statePath: string;
  specsDir: string;
  plansDir: string;
  draftsDir: string;
};

const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_NESTING_DEPTH = 10;
const MAX_TOP_LEVEL_KEYS = 100;
const MAX_SESSION_COMPONENT_BYTES = 255;
/** `_session-` + `YYYYMMDD-HHMMSS` + the separator before the ID. */
const SESSION_DIR_FIXED_BYTES = 25;
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
    ["breaker_updated_at", 100],
    ["restored_at", 100],
    ["deactivated_reason", 200],
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
  for (const key of ["active", "awaiting_confirmation"] as const) {
    const value = patch[key];
    if (value !== undefined && typeof value !== "boolean")
      throw new Error(`${key} must be a boolean`);
  }
  for (const key of [
    "iteration",
    "max_iterations",
    "breaker_count",
  ] as const) {
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

export const SESSION_DIR_PREFIX = "_session-";

/**
 * Native OpenCode session IDs are already single safe path components
 * (`[A-Za-z0-9_-]`), so they are validated rather than encoded.
 */
export function validateSessionID(sessionID: string): string {
  if (typeof sessionID !== "string" || sessionID.length === 0)
    throw new Error("a non-empty native session ID is required");
  if (
    !/^[A-Za-z0-9_-]+$/.test(sessionID) ||
    sessionID === "." ||
    sessionID === ".."
  )
    throw new Error("native session ID is not a safe path component");
  // Checked before any scan or host lookup: an unusable ID costs nothing.
  if (sessionID.length > MAX_SESSION_COMPONENT_BYTES - SESSION_DIR_FIXED_BYTES)
    throw new Error("native session ID exceeds the filesystem component limit");
  return sessionID;
}

/** gjc `assertSafePathComponent` (`gjc-runtime/workflow-cli-common.ts:24-30`). */
function safeComponent(value: string, name: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(value) || value.includes(".."))
    throw new Error(`invalid path component for ${name}: ${value}`);
  return value;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * Local time, so a folder name lines up with the creation time the host prints
 * in `opencode session list`.
 */
export function formatCreatedLabel(createdMs: number): string {
  if (typeof createdMs !== "number" || !Number.isFinite(createdMs))
    throw new Error("session creation time must be a finite number");
  const at = new Date(createdMs);
  return (
    `${pad(at.getFullYear(), 4)}${pad(at.getMonth() + 1, 2)}${pad(at.getDate(), 2)}` +
    `-${pad(at.getHours(), 2)}${pad(at.getMinutes(), 2)}${pad(at.getSeconds(), 2)}`
  );
}

/**
 * A v2 session `time.created` as epoch ms. The promise client returns a number
 * (Phase 0 P7); an Effect `DateTime` carries `epochMillis`, and a `Date` is
 * accepted too. Anything else is not a time, and `formatCreatedLabel` rejects it.
 */
export function epochMillis(value: unknown): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (isRecord(value) && typeof value.epochMillis === "number")
    return value.epochMillis;
  return Number.NaN;
}

/** `_session-<YYYYMMDD-HHMMSS>-<native session ID>`, one path component. */
export function sessionDirName(createdMs: number, sessionID: string): string {
  const name = `${SESSION_DIR_PREFIX}${formatCreatedLabel(createdMs)}-${validateSessionID(sessionID)}`;
  if (Buffer.byteLength(name, "utf8") > MAX_SESSION_COMPONENT_BYTES)
    throw new Error("native session ID exceeds the filesystem component limit");
  return name;
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
  private readonly resolveCreated: (sessionID: string) => Promise<number>;
  /** Per-instance: one host call per session covers later resolutions. */
  private readonly directories = new Map<string, string>();

  constructor(
    worktree: string,
    resolveCreated: (sessionID: string) => Promise<number>,
  ) {
    const resolved = path.resolve(worktree);
    try {
      this.worktree = realpathSync(resolved);
    } catch {
      throw new Error("worktree does not exist");
    }
    this.root = path.join(this.worktree, ".open-gajae");
    this.resolveCreated = resolveCreated;
  }

  /**
   * An existing folder is found by its exact `-<session ID>` suffix, so a label
   * written under another timezone still resolves. Two matches are ambiguous
   * and fail closed. Nothing here creates a directory; only the write path's
   * `inspectParent(create = true)` does.
   */
  async resolveSessionDir(sessionID: string): Promise<string> {
    validateSessionID(sessionID);
    const cached = this.directories.get(sessionID);
    if (cached !== undefined) return cached;

    const entries = await fs
      .readdir(this.root)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [] as string[];
        throw error;
      });
    const suffix = `-${sessionID}`;
    const matches = entries
      .filter(
        (entry) =>
          entry.startsWith(SESSION_DIR_PREFIX) && entry.endsWith(suffix),
      )
      .sort();
    if (matches.length > 1)
      throw new Error(
        `ambiguous session directories for ${sessionID}: ${matches.join(", ")}`,
      );

    const name =
      matches[0] ??
      sessionDirName(await this.resolveCreated(sessionID), sessionID);
    const directory = path.join(this.root, name);
    this.directories.set(sessionID, directory);
    return directory;
  }

  async resolveSessionPaths(
    sessionID: string,
    mode: StateMode = DEEP_INTERVIEW_MODE,
  ): Promise<SessionPaths> {
    const sessionDir = await this.resolveSessionDir(sessionID);
    return {
      sessionDir,
      statePath: path.join(sessionDir, "state", `${mode}-state.json`),
      specsDir: path.join(sessionDir, "specs"),
      plansDir: path.join(sessionDir, "plans"),
      draftsDir: path.join(sessionDir, "drafts"),
    };
  }

  async statePath(
    sessionID: string,
    mode: StateMode = DEEP_INTERVIEW_MODE,
  ): Promise<string> {
    return (await this.resolveSessionPaths(sessionID, mode)).statePath;
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
    file: string,
    sessionID: string,
  ): Promise<InterviewState | undefined> {
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
    await this.atomicWriteText(file, JSON.stringify(state, null, 2) + "\n");
  }

  private async atomicWriteText(file: string, serialized: string) {
    await this.inspectParent(file, true);
    const existing = await fs
      .lstat(file)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
    if (existing && (existing.isSymbolicLink() || !existing.isFile()))
      throw new Error(
        "refusing to replace a symlink or non-regular file",
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

  /**
   * Synchronous, so calls enter the queue in call order even when the first
   * resolution of a session still has to await the directory scan. The root is
   * part of the key, so two stores on one worktree share the queue.
   */
  private queueKey(sessionID: string): string {
    // Plan C-1 (E-1): every mode's state access and every transaction of a
    // session share one queue, so no workflow file of the session changes
    // outside it and a cross-skill write never interleaves.
    return `${this.root}\u0000${sessionID}\u0000workflow`;
  }

  async read(
    sessionID: string,
    mode: StateMode = DEEP_INTERVIEW_MODE,
  ): Promise<InterviewState | undefined> {
    return enqueue(this.queueKey(sessionID), async () =>
      this.readFile(await this.statePath(sessionID, mode), sessionID),
    );
  }

  async write(
    sessionID: string,
    state: Record<string, unknown> = {},
    explicit: ExplicitStatePatch = {},
    mode: StateMode = DEEP_INTERVIEW_MODE,
  ): Promise<InterviewState> {
    const stateSnapshot = snapshotState(state);
    const explicitSnapshot = { ...explicit };
    const payload = payloadError(stateSnapshot);
    if (payload) throw new Error(payload);
    validateExplicitPatch(explicitSnapshot);

    return enqueue(this.queueKey(sessionID), async () => {
      const target = await this.statePath(sessionID, mode);
      await this.readFile(target, sessionID);
      const next: InterviewState = {
        ...stateSnapshot,
        ...explicitSnapshot,
        _meta: {
          mode,
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

  /**
   * Read-modify-write for trusted hook callers. Explicit fields are validated
   * exactly as `write` validates them, so no unvalidated key can reach the file.
   */
  async patch(
    sessionID: string,
    explicit: ExplicitStatePatch,
    mode: StateMode = DEEP_INTERVIEW_MODE,
    updatedBy: StateWriter = "ralplan_hook",
  ): Promise<InterviewState> {
    // Shallow on purpose: a key set to `undefined` removes that field.
    const explicitSnapshot = { ...explicit };
    validateExplicitPatch(explicitSnapshot);

    return enqueue(this.queueKey(sessionID), async () => {
      const target = await this.statePath(sessionID, mode);
      const current = (await this.readFile(target, sessionID)) ?? {};
      return this.writeMerged(target, sessionID, mode, updatedBy, {
        ...current,
        ...explicitSnapshot,
      });
    });
  }

  private async writeMerged(
    target: string,
    sessionID: string,
    mode: StateMode,
    updatedBy: StateWriter,
    merged: Record<string, unknown>,
  ): Promise<InterviewState> {
    const next: InterviewState = {
      ...merged,
      _meta: { mode, sessionId: sessionID, updatedAt: now(), updatedBy },
    };
    const error = payloadError(next, true);
    if (error) throw new Error(error);
    await this.atomicWrite(target, next);
    return next;
  }

  /**
   * Plan C-1 (E-1): run `fn` holding the session's one workflow queue, the
   * one every `read`/`write`/`patch`/`clear` and transaction of `owner` uses.
   * `fn` must only use `tx`: calling a queued StateStore method inside it
   * waits on its own queue forever (C-1.3). Host calls belong outside it.
   */
  async workflowTransaction<T>(
    owner: string,
    fn: (tx: WorkflowTx) => Promise<T>,
  ): Promise<T> {
    return enqueue(this.queueKey(owner), async () => {
      const sessionDir = await this.resolveSessionDir(owner);
      const stateDir = path.join(sessionDir, "state");
      const ultragoalDir = path.join(sessionDir, "ultragoal");
      const modeState = (mode: StateMode) =>
        path.join(stateDir, `${mode}-state.json`);
      const statePath = modeState(RALPLAN_MODE);
      const inside = (file: string) => {
        const resolved = path.resolve(file);
        const relative = path.relative(sessionDir, resolved);
        if (
          relative === "" ||
          relative.startsWith("..") ||
          path.isAbsolute(relative)
        )
          throw new Error("workflow path escapes the session directory");
        return resolved;
      };
      const tx: WorkflowTx = {
        paths: {
          sessionDir,
          statePath,
          continuationPath: path.join(stateDir, "ralplan-continuation.json"),
          auditPath: path.join(stateDir, "audit.jsonl"),
          activeRowPath: path.join(stateDir, "active", "ralplan.json"),
          snapshotPath: path.join(stateDir, "skill-active-state.json"),
          runDir: (runId) =>
            path.join(sessionDir, "plans", "ralplan", safeComponent(runId, "run_id")),
          activeRow: (skill) =>
            path.join(stateDir, "active", `${safeComponent(skill, "skill")}.json`),
          transactionsDir: path.join(stateDir, "transactions"),
          modeState,
          ultragoal: {
            dir: ultragoalDir,
            goals: path.join(ultragoalDir, "goals.json"),
            progress: path.join(ultragoalDir, "progress.txt"),
            ledger: path.join(ultragoalDir, "ledger.jsonl"),
          },
          goalState: path.join(stateDir, "goal-state.json"),
          goalContinuation: path.join(stateDir, "goal-continuation.json"),
        },
        readState: () => this.readFile(statePath, owner),
        writeState: (state, updatedBy) =>
          this.writeMerged(
            statePath,
            owner,
            RALPLAN_MODE,
            updatedBy,
            snapshotState(state),
          ),
        readModeState: (mode) => this.readFile(modeState(mode), owner),
        writeModeState: (mode, state, updatedBy) =>
          this.writeMerged(
            modeState(mode),
            owner,
            mode,
            updatedBy,
            snapshotState(state),
          ),
        readText: (file) => this.readText(inside(file)),
        writeText: (file, text) => this.atomicWriteText(inside(file), text),
        appendLine: (file, line) => {
          if (line.includes("\n"))
            throw new Error("a JSONL line must not contain a newline");
          return this.appendText(inside(file), `${line}\n`);
        },
        list: async (dir) => {
          const target = inside(dir);
          if (!(await this.inspectParent(target, false))) return [];
          const stat = await fs
            .lstat(target)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            });
          if (!stat) return [];
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error("state path contains a symlink or non-directory");
          return (await fs.readdir(target)).sort();
        },
        remove: async (file) => {
          const target = inside(file);
          if (!(await this.inspectParent(target, false))) return "missing";
          const stat = await fs
            .lstat(target)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            });
          if (!stat) return "missing";
          if (stat.isSymbolicLink() || !stat.isFile())
            throw new Error(`${path.basename(target)} is not a regular file`);
          await fs.unlink(target);
          return "deleted";
        },
      };
      return fn(tx);
    });
  }

  /** The ralplan name of `workflowTransaction` (plan C-1.2). */
  async ralplanTransaction<T>(
    owner: string,
    fn: (tx: WorkflowTx) => Promise<T>,
  ): Promise<T> {
    return this.workflowTransaction(owner, fn);
  }

  /** `O_NOFOLLOW` closes the gap between the check and the open. */
  private async appendText(file: string, text: string) {
    await this.inspectParent(file, true);
    const refuse = () =>
      new Error("refusing to append to a symlink or non-regular file");
    const existing = await fs
      .lstat(file)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
    if (existing && (existing.isSymbolicLink() || !existing.isFile()))
      throw refuse();
    const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW } = fsConstants;
    const handle = await fs
      .open(file, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0o600)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ELOOP") throw refuse();
        throw error;
      });
    try {
      if (!(await handle.stat()).isFile()) throw refuse();
      await handle.appendFile(text, "utf8");
    } finally {
      await handle.close();
    }
  }

  private async readText(file: string): Promise<string | undefined> {
    if (!(await this.inspectParent(file, false))) return undefined;
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return undefined;
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(`${path.basename(file)} is not a regular file`);
    return fs.readFile(file, "utf8");
  }

  async clear(
    sessionID: string,
    mode: StateMode = DEEP_INTERVIEW_MODE,
  ): Promise<"deleted" | "missing"> {
    return enqueue(this.queueKey(sessionID), async () => {
      const target = await this.statePath(sessionID, mode);
      const current = await this.readFile(target, sessionID);
      if (!current) return "missing";
      await fs.unlink(target);
      return "deleted";
    });
  }
}
