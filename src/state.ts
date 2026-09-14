import { createHash, randomUUID } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";

// State and payload-boundary behavior draws on OMC/OMX MIT sources; project notices carry attribution.
export const DEEP_INTERVIEW_MODE = "deep-interview" as const;
export type QuestionKind =
  | "requirement"
  | "continuation"
  | "confirmation"
  | "closure";
export type InterviewStatus =
  | "active"
  | "waiting"
  | "interrupted"
  | "error"
  | "completed"
  | "cancelled"
  | "limit-reached";

export type InterviewRuntime = {
  interviewId: string;
  revision: number;
  modelRevision: number;
  status: InterviewStatus;
  round: number;
  maxRounds: number;
  ambiguityThreshold: number;
  confirmationRequested: boolean;
  confirmationAnswered?: boolean;
  continuationApproved?: boolean;
  nextQuestionKind: QuestionKind;
  questionCallId?: string;
  pending?: {
    requestId: string;
    callId?: string;
    kind: QuestionKind;
    askedAt: string;
  };
  reason?: string;
  error?: string;
  spec?: SpecReceipt;
  specGeneration?: number;
  priorSpecs?: SpecReceipt[];
  answers?: Array<{
    requestId: string;
    kind: QuestionKind;
    answers: string[][];
    recordedAt: string;
  }>;
};

export type StateMeta = {
  mode: typeof DEEP_INTERVIEW_MODE;
  sessionId: string;
  updatedAt: string;
  updatedBy: string;
};

/** Model-owned fields are intentionally open-ended; only `_meta` and `_runtime` are reserved. */
export type InterviewState = Record<string, unknown> & {
  _meta: StateMeta;
  _runtime: InterviewRuntime;
};

export type SpecReceipt = {
  path: string;
  sha256: string;
  interviewId: string;
  termination: "normal" | "cancelled" | "limit-reached";
  modelRevision: number;
  writtenAt: string;
};

export type StateStoreOptions = {
  ambiguityThreshold: number;
  maxRounds: number;
};
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

const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_NESTING_DEPTH = 10;
const MAX_TOP_LEVEL_KEYS = 100;
const terminal = new Set<InterviewStatus>([
  "completed",
  "cancelled",
  "limit-reached",
]);
const safeSegment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

type Mutator<T> = (
  state: InterviewState | undefined,
) =>
  | Promise<{ state?: InterviewState; result: T }>
  | { state?: InterviewState; result: T };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function now() {
  return new Date().toISOString();
}

function payloadError(value: unknown): string | undefined {
  if (!isRecord(value)) return "custom state must be a JSON object";
  if (Object.keys(value).length > MAX_TOP_LEVEL_KEYS)
    return `custom state exceeds ${MAX_TOP_LEVEL_KEYS} top-level keys`;
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
  if (depth(value) > MAX_NESTING_DEPTH)
    return `custom state exceeds nesting depth ${MAX_NESTING_DEPTH}`;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PAYLOAD_BYTES)
      return `custom state exceeds ${MAX_PAYLOAD_BYTES} bytes`;
  } catch {
    return "custom state is not JSON serializable";
  }
  return undefined;
}

function requireText(value: unknown, name: string, max: number) {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new Error(
      `${name} must be a non-empty string up to ${max} characters`,
    );
}

function validateState(
  state: unknown,
  sessionId: string,
): asserts state is InterviewState {
  if (!isRecord(state) || !isRecord(state._meta) || !isRecord(state._runtime))
    throw new Error("state is missing required metadata or runtime");
  const meta = state._meta;
  const runtime = state._runtime;
  if (meta.mode !== DEEP_INTERVIEW_MODE || meta.sessionId !== sessionId)
    throw new Error("state scope does not match this session");
  if (
    typeof runtime.interviewId !== "string" ||
    typeof runtime.revision !== "number" ||
    typeof runtime.modelRevision !== "number" ||
    typeof runtime.round !== "number" ||
    typeof runtime.maxRounds !== "number" ||
    typeof runtime.ambiguityThreshold !== "number"
  )
    throw new Error("state runtime is structurally invalid");
  if (
    !safeSegment.test(runtime.interviewId) ||
    !Number.isSafeInteger(runtime.round) ||
    runtime.round < 0 ||
    !Number.isSafeInteger(runtime.maxRounds) ||
    runtime.maxRounds < 1 ||
    runtime.round > runtime.maxRounds ||
    !Number.isSafeInteger(runtime.revision) ||
    !Number.isSafeInteger(runtime.modelRevision) ||
    !Number.isFinite(runtime.ambiguityThreshold) ||
    runtime.ambiguityThreshold < 0 ||
    runtime.ambiguityThreshold > 1
  )
    throw new Error("state runtime has invalid numeric or identity fields");
  if (
    !terminal.has(runtime.status as InterviewStatus) &&
    !["active", "waiting", "interrupted", "error"].includes(
      String(runtime.status),
    )
  )
    throw new Error("state runtime has an invalid status");
}

function validateCompletionFields(state: InterviewState) {
  const runtime = state._runtime;
  if (
    runtime.status !== "active" ||
    runtime.pending ||
    runtime.questionCallId ||
    runtime.error
  )
    throw new Error(
      "normal completion requires an active, error-free interview without a pending question",
    );
  requireText(state.goal, "goal", 10_000);
  if (
    !Array.isArray(state.decisions) ||
    state.decisions.length === 0 ||
    !Array.isArray(state.acceptance_criteria) ||
    state.acceptance_criteria.length === 0
  )
    throw new Error(
      "completion requires non-empty decisions and acceptance_criteria",
    );
  if (
    !Array.isArray(state.non_goals) ||
    !Array.isArray(state.decision_boundaries)
  )
    throw new Error("completion requires non_goals and decision_boundaries");
  if (
    !isRecord(state.topology) ||
    state.topology.status !== "confirmed" ||
    !Array.isArray(state.topology.components) ||
    state.topology.components.length === 0 ||
    !Array.isArray(state.topology.deferrals)
  )
    throw new Error(
      "completion requires confirmed topology with components and deferrals",
    );
  if (
    !Array.isArray(state.ontology_snapshots) ||
    state.ontology_snapshots.length === 0 ||
    !state.ontology_snapshots.every(
      (snapshot) =>
        isRecord(snapshot) &&
        Array.isArray(snapshot.entities) &&
        (snapshot.stability_ratio === "N/A" ||
          (typeof snapshot.stability_ratio === "number" &&
            Number.isFinite(snapshot.stability_ratio) &&
            snapshot.stability_ratio >= 0 &&
            snapshot.stability_ratio <= 1)) &&
        typeof snapshot.matching_reasoning === "string" &&
        snapshot.matching_reasoning.length > 0,
    )
  )
    throw new Error(
      "completion requires structurally valid ontology_snapshots",
    );
  if (
    !isRecord(state.closure) ||
    state.closure.non_goals !== true ||
    state.closure.decision_boundaries !== true ||
    state.closure.pressure_pass !== true ||
    state.closure.closure_audit !== true
  )
    throw new Error("completion requires a completed closure audit");
  if (
    typeof state.current_ambiguity !== "number" ||
    !Number.isFinite(state.current_ambiguity) ||
    state.current_ambiguity < 0 ||
    state.current_ambiguity > runtime.ambiguityThreshold
  )
    throw new Error("completion ambiguity is outside the configured threshold");
}

function validateCompletion(state: InterviewState) {
  validateCompletionFields(state);
  const runtime = state._runtime;
  if (
    !runtime.spec ||
    runtime.spec.interviewId !== runtime.interviewId ||
    runtime.spec.termination !== "normal"
  )
    throw new Error(
      "interview completion requires a current normal spec receipt",
    );
}

function cloneModel(model: Record<string, unknown>): Record<string, unknown> {
  const error = payloadError(model);
  if (error) throw new Error(error);
  if ("_runtime" in model || "_meta" in model)
    throw new Error(
      "custom state cannot set reserved _meta or _runtime fields",
    );
  return JSON.parse(JSON.stringify(model)) as Record<string, unknown>;
}

function modelContent(state: Record<string, unknown>) {
  const {
    _meta: _meta,
    _runtime: _runtime,
    completion_requested: _completion,
    ...content
  } = state;
  return JSON.stringify(content);
}

function validateExplicitPatch(patch: ExplicitStatePatch) {
  for (const [key, max] of [
    ["current_phase", 200],
    ["task_description", 2000],
    ["error", 2000],
    ["plan_path", 500],
    ["started_at", 100],
    ["completed_at", 100],
  ] as const)
    if (patch[key] !== undefined) requireText(patch[key], key, max);
  if (
    patch.iteration !== undefined &&
    (!Number.isInteger(patch.iteration) || patch.iteration < 0)
  )
    throw new Error("iteration must be a non-negative integer");
  if (
    patch.max_iterations !== undefined &&
    (!Number.isInteger(patch.max_iterations) || patch.max_iterations < 1)
  )
    throw new Error("max_iterations must be a positive integer");
}

export class StateStore {
  readonly worktree: string;
  readonly options: StateStoreOptions;
  private readonly root: string;
  private queue = new Map<string, Promise<unknown>>();

  constructor(worktree: string, options: StateStoreOptions) {
    if (
      !Number.isFinite(options.ambiguityThreshold) ||
      options.ambiguityThreshold < 0 ||
      options.ambiguityThreshold > 1
    )
      throw new Error("ambiguityThreshold must be between 0 and 1");
    if (!Number.isInteger(options.maxRounds) || options.maxRounds < 1)
      throw new Error("maxRounds must be a positive integer");
    this.worktree = realpathSync(path.resolve(worktree));
    this.root = path.join(this.worktree, ".open-gajae");
    this.options = { ...options };
  }

  statePath(sessionId: string) {
    return path.join(
      this.root,
      "state",
      "sessions",
      this.segment(sessionId),
      "deep-interview-state.json",
    );
  }
  private specPath(sessionId: string, interviewId: string, generation = 0) {
    if (!Number.isSafeInteger(generation) || generation < 0)
      throw new Error("invalid spec generation");
    return path.join(
      this.root,
      "specs",
      this.segment(sessionId),
      `${this.segment(interviewId)}${generation ? `-r${generation}` : ""}.md`,
    );
  }
  private segment(value: string) {
    if (!safeSegment.test(value))
      throw new Error("unsafe session or interview identifier");
    return value;
  }

  private async inspectParent(file: string, create: boolean) {
    const canonicalWorktree = await fs.realpath(this.worktree).catch(() => {
      throw new Error("worktree does not exist");
    });
    const relative = path.relative(canonicalWorktree, file);
    if (
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    )
      throw new Error("path escapes worktree");
    let current = canonicalWorktree;
    for (const part of path.dirname(relative).split(path.sep)) {
      current = path.join(current, part);
      const stat = await fs
        .lstat(current)
        .catch((error: NodeJS.ErrnoException) =>
          error.code === "ENOENT" ? undefined : Promise.reject(error),
        );
      if (!stat) {
        if (!create) return false;
        try {
          await fs.mkdir(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const created = await fs.lstat(current);
        if (created.isSymbolicLink() || !created.isDirectory())
          throw new Error("state path contains a symlink or non-directory");
      } else if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("state path contains a symlink or non-directory");
    }
    return true;
  }

  private async ensureParent(file: string) {
    await this.inspectParent(file, true);
  }

  private async readFile(
    sessionId: string,
  ): Promise<InterviewState | undefined> {
    const file = this.statePath(sessionId);
    if (!(await this.inspectParent(file, false))) return undefined;
    const stat = await fs
      .lstat(file)
      .catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? undefined : Promise.reject(error),
      );
    if (!stat) return undefined;
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error("state file is not a regular file");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      throw new Error("state file is corrupted; it was preserved");
    }
    validateState(parsed, sessionId);
    return parsed;
  }

  private async atomicWrite(file: string, body: string) {
    await this.ensureParent(file);
    const existing = await fs
      .lstat(file)
      .catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? undefined : Promise.reject(error),
      );
    if (existing && (existing.isSymbolicLink() || !existing.isFile()))
      throw new Error(
        "refusing to replace a symlink or non-regular state file",
      );
    const temp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(temp, body, { encoding: "utf8", flag: "wx" });
      await fs.rename(temp, file);
    } catch (error) {
      await fs.unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  private async verifyReceipt(sessionId: string, state: InterviewState) {
    const receipt = state._runtime.spec;
    if (
      !receipt ||
      receipt.interviewId !== state._runtime.interviewId ||
      receipt.modelRevision !== state._runtime.modelRevision ||
      receipt.path !==
        this.specPath(
          sessionId,
          state._runtime.interviewId,
          state._runtime.specGeneration,
        )
    )
      throw new Error("interview completion requires the current spec receipt");
    if (!(await this.inspectParent(receipt.path, false)))
      throw new Error("interview spec receipt path is missing");
    const stat = await fs.lstat(receipt.path).catch(() => undefined);
    if (!stat || stat.isSymbolicLink() || !stat.isFile())
      throw new Error(
        "interview spec receipt no longer references a regular file",
      );
    const markdown = await fs.readFile(receipt.path, "utf8");
    if (createHash("sha256").update(markdown).digest("hex") !== receipt.sha256)
      throw new Error("interview spec receipt hash does not match its file");
  }

  private mutate<T>(sessionId: string, mutate: Mutator<T>): Promise<T> {
    this.segment(sessionId);
    const previous = this.queue.get(sessionId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const current = await this.readFile(sessionId);
        const next = await mutate(current);
        if (next.state)
          await this.atomicWrite(
            this.statePath(sessionId),
            JSON.stringify(next.state, null, 2) + "\n",
          );
        return next.result;
      });
    this.queue.set(sessionId, run);
    void run
      .finally(() => {
        if (this.queue.get(sessionId) === run) this.queue.delete(sessionId);
      })
      .catch(() => undefined);
    return run;
  }

  async read(sessionId: string) {
    return this.mutate(sessionId, (state) => ({ result: state }));
  }

  async replaceModelState(
    sessionId: string,
    model: Record<string, unknown>,
    updatedBy = "state_write",
    patch: ExplicitStatePatch = {},
  ) {
    const snapshot = cloneModel(model);
    validateExplicitPatch(patch);
    return this.mutate(sessionId, async (existing) => {
      if (!existing)
        throw new Error("no deep-interview state exists for this session");
      const proposedKind = snapshot.next_question_kind;
      if (
        proposedKind !== undefined &&
        !["requirement", "continuation", "confirmation", "closure"].includes(
          String(proposedKind),
        )
      )
        throw new Error("next_question_kind is invalid");
      const kind = (proposedKind ??
        existing._runtime.nextQuestionKind) as QuestionKind;
      const completionRequested = snapshot.completion_requested === true;
      if (
        completionRequested &&
        modelContent({ ...snapshot, ...patch }) !== modelContent(existing)
      )
        throw new Error(
          "completion_requested cannot change model fields after the spec receipt",
        );
      const next: InterviewState = {
        ...snapshot,
        ...patch,
        next_question_kind: kind,
        _meta: {
          mode: DEEP_INTERVIEW_MODE,
          sessionId,
          updatedAt: now(),
          updatedBy,
        },
        _runtime: {
          ...existing._runtime,
          nextQuestionKind: kind,
          modelRevision:
            existing._runtime.modelRevision + (completionRequested ? 0 : 1),
        },
      };
      if (patch.active === true && terminal.has(next._runtime.status))
        throw new Error(
          "terminal interviews require an explicit resume or new start",
        );
      if (patch.active === false && next._runtime.status === "active")
        next._runtime.status = "interrupted";
      if (next.completion_requested === true) {
        validateCompletion(next);
        await this.verifyReceipt(sessionId, next);
        next._runtime.status = "completed";
      }
      const written = this.bump(next);
      return { state: written, result: written };
    });
  }

  async applyExplicitPatch(sessionId: string, patch: ExplicitStatePatch) {
    validateExplicitPatch(patch);
    return this.mutate(sessionId, (state) => {
      if (!state)
        throw new Error("no deep-interview state exists for this session");
      const next = {
        ...state,
        ...patch,
        _meta: { ...state._meta, updatedAt: now(), updatedBy: "state_write" },
        _runtime: {
          ...state._runtime,
          modelRevision: state._runtime.modelRevision + 1,
        },
      };
      if (patch.active === true && terminal.has(next._runtime.status))
        throw new Error(
          "terminal interviews require an explicit resume or new start",
        );
      if (patch.active === false && next._runtime.status === "active")
        next._runtime.status = "interrupted";
      return { state: this.bump(next), result: next };
    });
  }

  async start(sessionId: string, taskDescription: string) {
    requireText(taskDescription, "task description", 2000);
    return this.mutate(sessionId, (existing) => {
      if (existing && !terminal.has(existing._runtime.status))
        throw new Error(
          "an interview is already active or recoverable; use resume or cancel",
        );
      const startedAt = now();
      const state: InterviewState = {
        task_description: taskDescription,
        started_at: startedAt,
        next_question_kind: "requirement",
        _meta: {
          mode: DEEP_INTERVIEW_MODE,
          sessionId,
          updatedAt: startedAt,
          updatedBy: "command",
        },
        _runtime: {
          interviewId: randomUUID(),
          revision: 1,
          modelRevision: 0,
          status: "active",
          round: 0,
          maxRounds: this.options.maxRounds,
          ambiguityThreshold: this.options.ambiguityThreshold,
          confirmationRequested: false,
          nextQuestionKind: "requirement",
        },
      };
      return { state, result: state };
    });
  }

  async resume(
    sessionId: string,
    confirmCancelled = false,
    confirmPending = false,
  ) {
    return this.mutate(sessionId, (state) => {
      if (!state) throw new Error("no interview exists to resume");
      const runtime = state._runtime;
      if (runtime.status === "completed" || runtime.status === "limit-reached")
        throw new Error("terminal interview cannot be resumed");
      if (runtime.status === "cancelled" && !confirmCancelled)
        throw new Error(
          "cancelled interview requires explicit confirmation to resume",
        );
      if (runtime.status === "active")
        throw new Error("interview is already running");
      if (runtime.status === "waiting" && !confirmPending)
        throw new Error(
          "unresolved pending question requires explicit confirmation to resume",
        );
      const next = {
        ...state,
        _meta: { ...state._meta, updatedAt: now(), updatedBy: "command" },
        _runtime: {
          ...runtime,
          ...(runtime.spec
            ? {
                spec: undefined,
                specGeneration: (runtime.specGeneration ?? 0) + 1,
                priorSpecs: [...(runtime.priorSpecs ?? []), runtime.spec],
              }
            : {}),
          status: "active" as const,
          pending: undefined,
          questionCallId: undefined,
          reason: undefined,
          error: undefined,
        },
      };
      return { state: this.bump(next), result: next };
    });
  }

  async cancel(sessionId: string, reason = "cancelled by user") {
    return this.mutate(sessionId, (state) => {
      if (!state) throw new Error("no interview exists to cancel");
      if (terminal.has(state._runtime.status)) return { result: state };
      const next = {
        ...state,
        _meta: { ...state._meta, updatedAt: now(), updatedBy: "command" },
        _runtime: {
          ...state._runtime,
          status: "cancelled" as const,
          pending: undefined,
          questionCallId: undefined,
          reason,
          completedAt: now(),
        },
      };
      return { state: this.bump(next), result: next };
    });
  }

  async recordQuestionIntent(
    sessionId: string,
    kind: QuestionKind,
    callId?: string,
  ) {
    return this.mutate(sessionId, (state) => {
      if (
        !state ||
        state._runtime.status !== "active" ||
        state._runtime.pending ||
        state._runtime.questionCallId
      )
        throw new Error("interview is not able to ask a question");
      if (state._runtime.spec)
        throw new Error(
          "a finalized specification must be completed before starting another interview",
        );
      if (state._runtime.round >= state._runtime.maxRounds)
        throw new Error("maximum requirement rounds reached");
      if (
        state._runtime.round >= 10 &&
        !state._runtime.confirmationAnswered &&
        kind !== "continuation"
      )
        throw new Error(
          "a tenth-round continuation decision is required before another requirement question",
        );
      if (
        kind === "continuation" &&
        (state._runtime.round !== 10 || state._runtime.confirmationAnswered)
      )
        throw new Error(
          "continuation control is only available after ten requirements answers",
        );
      const next = {
        ...state,
        next_question_kind: kind,
        _meta: {
          ...state._meta,
          updatedAt: now(),
          updatedBy: "question-before",
        },
        _runtime: {
          ...state._runtime,
          nextQuestionKind: kind,
          questionCallId: callId,
        },
      };
      return { state: this.bump(next), result: next };
    });
  }

  async recordQuestionAsked(
    sessionId: string,
    requestId: string,
    callId?: string,
  ) {
    return this.mutate(sessionId, (state) => {
      if (
        !state ||
        state._runtime.status !== "active" ||
        state._runtime.pending
      )
        return { result: state };
      if (
        state._runtime.answers?.some((answer) => answer.requestId === requestId)
      )
        return { result: state };
      if (
        state._runtime.questionCallId &&
        state._runtime.questionCallId !== callId
      )
        return { result: state };
      const runtime = {
        ...state._runtime,
        status: "waiting" as const,
        pending: {
          requestId,
          callId,
          kind: state._runtime.nextQuestionKind,
          askedAt: now(),
        },
      };
      const next = {
        ...state,
        _meta: {
          ...state._meta,
          updatedAt: now(),
          updatedBy: "question-event",
        },
        _runtime: runtime,
      };
      return { state: this.bump(next), result: next };
    });
  }

  async recordQuestionReply(
    sessionId: string,
    requestId: string,
    answers?: string[][],
  ) {
    return this.mutate(sessionId, (state) => {
      if (
        !state ||
        state._runtime.status !== "waiting" ||
        state._runtime.pending?.requestId !== requestId
      )
        return { result: state };
      const pending = state._runtime.pending;
      if (
        !answers ||
        answers.length !== 1 ||
        !answers.every(
          (group) =>
            Array.isArray(group) &&
            group.length > 0 &&
            group.every((item) => typeof item === "string"),
        )
      )
        return { result: state };
      const actualAnswers = answers;
      const answerHistory = actualAnswers
        ? [
            ...(state._runtime.answers ?? []),
            {
              requestId,
              kind: pending.kind,
              answers: actualAnswers,
              recordedAt: now(),
            },
          ]
        : state._runtime.answers;
      const nextRound =
        pending.kind === "requirement" || pending.kind === "confirmation"
          ? state._runtime.round + 1
          : state._runtime.round;
      const limit = nextRound >= state._runtime.maxRounds;
      const continuationText =
        actualAnswers?.flat().map((answer) => answer.trim().toLowerCase()) ??
        [];
      const continuationApproved =
        pending.kind === "continuation"
          ? continuationText.some((answer) =>
              ["yes", "y", "continue", "proceed", "more"].includes(answer),
            )
          : state._runtime.continuationApproved;
      const continuationRejected =
        pending.kind === "continuation"
          ? continuationText.some((answer) =>
              ["no", "n", "stop", "finish", "close"].includes(answer),
            )
          : false;
      const ambiguousContinuation =
        pending.kind === "continuation" &&
        (!actualAnswers || continuationApproved === continuationRejected);
      const tenthContinuation =
        !limit && nextRound >= 10 && !state._runtime.confirmationAnswered;
      const confirmationAnswered =
        state._runtime.confirmationAnswered ||
        (pending.kind === "continuation" && !ambiguousContinuation);
      const nextKind: QuestionKind =
        limit || continuationRejected
          ? "closure"
          : tenthContinuation && !confirmationAnswered
            ? "continuation"
            : "requirement";
      const next = {
        ...state,
        next_question_kind: nextKind,
        _meta: {
          ...state._meta,
          updatedAt: now(),
          updatedBy: "question-event",
        },
        _runtime: {
          ...state._runtime,
          round: nextRound,
          status: limit
            ? ("limit-reached" as const)
            : continuationRejected
              ? ("cancelled" as const)
              : ambiguousContinuation
                ? ("interrupted" as const)
                : ("active" as const),
          pending: undefined,
          questionCallId: undefined,
          answers: answerHistory,
          confirmationRequested:
            state._runtime.confirmationRequested || tenthContinuation,
          confirmationAnswered,
          continuationApproved,
          nextQuestionKind: nextKind,
          reason: limit
            ? "maximum requirement rounds reached"
            : continuationRejected
              ? "user declined further questions"
              : ambiguousContinuation
                ? "continuation response was not an explicit affirmative or negative selection"
                : undefined,
        },
      };
      return { state: this.bump(next), result: next };
    });
  }

  async interrupt(
    sessionId: string,
    reason: string,
    error = false,
    requestId?: string,
  ) {
    return this.mutate(sessionId, (state) => {
      if (!state || terminal.has(state._runtime.status))
        return { result: state };
      if (requestId && state._runtime.pending?.requestId !== requestId)
        return { result: state };
      const next = {
        ...state,
        _meta: { ...state._meta, updatedAt: now(), updatedBy: "event" },
        _runtime: {
          ...state._runtime,
          status: error ? ("error" as const) : ("interrupted" as const),
          pending: undefined,
          questionCallId: undefined,
          reason,
          error: error ? reason : undefined,
        },
      };
      return { state: this.bump(next), result: next };
    });
  }

  async writeSpec(
    sessionId: string,
    markdown: string,
    termination: SpecReceipt["termination"],
  ) {
    if (typeof markdown !== "string" || markdown.length === 0)
      throw new Error("markdown must be a non-empty string");
    return this.mutate(sessionId, async (state) => {
      if (!state) throw new Error("no interview exists");
      const runtime = state._runtime;
      if (termination === "normal") validateCompletionFields(state);
      if (termination === "cancelled" && runtime.status !== "cancelled")
        throw new Error("cancelled specs require a cancelled interview");
      if (termination === "limit-reached" && runtime.status !== "limit-reached")
        throw new Error(
          "limit-reached specs require a round-limited interview",
        );
      const file = this.specPath(
        sessionId,
        runtime.interviewId,
        runtime.specGeneration,
      );
      const hash = createHash("sha256").update(markdown).digest("hex");
      if (runtime.spec) {
        if (
          runtime.spec.path === file &&
          runtime.spec.sha256 === hash &&
          runtime.spec.termination === termination
        ) {
          await this.verifyReceipt(sessionId, state);
          return { result: runtime.spec };
        }
        throw new Error(
          "the current interview already has a different spec receipt",
        );
      }
      await this.atomicWrite(file, markdown);
      const receipt: SpecReceipt = {
        path: file,
        sha256: hash,
        interviewId: runtime.interviewId,
        termination,
        modelRevision: runtime.modelRevision,
        writtenAt: now(),
      };
      const next = {
        ...state,
        _meta: {
          ...state._meta,
          updatedAt: now(),
          updatedBy: "deep_interview_spec",
        },
        _runtime: { ...runtime, spec: receipt },
      };
      return { state: this.bump(next), result: receipt };
    });
  }

  async complete(sessionId: string) {
    return this.mutate(sessionId, async (state) => {
      if (!state) throw new Error("no interview exists");
      const { _runtime: runtime } = state;
      validateCompletion(state);
      await this.verifyReceipt(sessionId, state);
      const next = {
        ...state,
        _meta: { ...state._meta, updatedAt: now(), updatedBy: "completion" },
        _runtime: {
          ...runtime,
          status: "completed" as const,
          completedAt: now(),
        },
      };
      return { state: this.bump(next), result: next };
    });
  }

  private bump(state: InterviewState): InterviewState {
    return {
      ...state,
      _runtime: { ...state._runtime, revision: state._runtime.revision + 1 },
    };
  }
}

/** Weighted ambiguity used by prompts and receipts; no ontology matching engine is implied. */
export function ambiguityScore(
  scores: {
    goal: number;
    constraints: number;
    criteria: number;
    context?: number;
  },
  brownfield = false,
) {
  const dimensions = [
    scores.goal,
    scores.constraints,
    scores.criteria,
    ...(brownfield ? [scores.context] : []),
  ];
  if (
    dimensions.some(
      (score) =>
        typeof score !== "number" ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 1,
    )
  )
    throw new Error("clarity scores must be finite numbers in [0, 1]");
  const raw = brownfield
    ? 1 -
      (scores.goal * 0.35 +
        scores.constraints * 0.25 +
        scores.criteria * 0.25 +
        (scores.context ?? 0) * 0.15)
    : 1 -
      (scores.goal * 0.4 + scores.constraints * 0.3 + scores.criteria * 0.3);
  return Math.max(0, Math.min(1, raw));
}
