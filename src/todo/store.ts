// Original todo storage contract. Reuses the existing session queue, guarded
// paths, atomic replacement and audit; it never resolves a lineage root.
import { join } from "node:path";
import { RUNTIME_OWNER } from "../skill-state/audit.js";
import { assertStatePayload, type StateStore, type WorkflowTx } from "../state.js";
import { todoView, type TodoView } from "./protocol.js";
import {
  incrementTodoCounter,
  parseTodoOperation,
  reduceTodo,
  todoControllerSchema,
  todoSnapshotSchema,
  TodoStateError,
  type TodoController,
  type TodoSnapshot,
  type TodoSource,
} from "./state.js";

// Matches StateStore's payload limit. Compact serialization means accepted
// writes and raw reads have precisely the same UTF-8 byte boundary.
const MAX_TODO_BYTES = 1_048_576;
// Shared across adapters for the same canonical worktree/session. An uncertain
// write must be reconciled by an explicit read, never by another blind mutation.
const uncertain = new Set<string>();
// Admission and DTOs share the same process-local storage veto. Explicit view
// reconciles uncertainty; only an applied explicit operation releases the veto.
const storageHolds = new Map<string, string>();
export type TodoWriteResult = {
  readonly disposition: "applied" | "unchanged" | "rejected" | "committed-with-warning" | "uncertain";
  readonly view: TodoView;
  readonly diagnostic?: string;
};
type Loaded = {
  readonly view: TodoView;
  readonly snapshot?: TodoSnapshot;
  readonly text?: string;
};
export type TodoVersion = Pick<TodoSnapshot, "generation" | "revision">;
export function todoProjectionChanged(previous: TodoView | undefined, next: TodoView): boolean {
  return previous !== undefined && (previous.status !== next.status ||
    (previous.status === "ready" && next.status === "ready" &&
      JSON.stringify(previous.hold) !== JSON.stringify(next.hold)));
}
function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function invalid(sessionID: string, error: unknown): TodoView {
  return { status: "invalid", sessionID, diagnostic: diagnostic(error) };
}
function fileOf(tx: WorkflowTx): string {
  return join(tx.paths.sessionDir, "state", "todo.json");
}
function encode(snapshot: TodoSnapshot): string {
  const valid = todoSnapshotSchema.parse(snapshot);
  assertStatePayload(valid);
  return JSON.stringify(valid);
}
async function load(tx: WorkflowTx, sessionID: string): Promise<Loaded> {
  try {
    const text = await tx.readText(fileOf(tx));
    if (text === undefined) return { view: { status: "missing", sessionID } };
    if (Buffer.byteLength(text, "utf8") > MAX_TODO_BYTES)
      throw new TodoStateError("overflow", "todo state exceeds 1048576 bytes; preserved");
    const snapshot = todoSnapshotSchema.parse(JSON.parse(text));
    assertStatePayload(snapshot);
    if (snapshot.sessionID !== sessionID)
      throw new TodoStateError("stale-state", "todo session owner mismatch; preserved");
    return { snapshot, text, view: todoView(snapshot) };
  } catch (error) {
    return { view: invalid(sessionID, error) };
  }
}
function assertSourceOrder(previous: TodoSource | null, next: TodoSource | null): void {
  if (previous && (!next || previous.aggregateID !== next.aggregateID ||
    next.seq < previous.seq || (next.seq === previous.seq && next.eventID !== previous.eventID)))
    throw new TodoStateError("stale-state", "controller source fence cannot move backwards or change identity");
}

export class TodoStore {
  constructor(private readonly state: StateStore) {}

  private key(sessionID: string): string {
    return `${this.state.worktree}\0${sessionID}`;
  }

  storageHold(sessionID: string): string | undefined {
    return storageHolds.get(this.key(sessionID));
  }

  holdStorage(sessionID: string, reason: "uncertain_storage" | "invalid_storage" | "storage_failure"): void {
    storageHolds.set(this.key(sessionID), uncertain.has(this.key(sessionID)) ? "uncertain_storage" : reason);
  }

  storageView(view: TodoView): TodoView {
    const reason = this.storageHold(view.sessionID);
    return view.status === "ready" && reason ? { ...view, hold: { reason } } : view;
  }

  /** Explicit authoritative view is also the uncertain-write reconciliation. */
  async read(sessionID: string): Promise<TodoView> {
    try {
      return await this.state.workflowTransaction(sessionID, async (tx) => {
        const loaded = await load(tx, sessionID);
        if (loaded.view.status !== "invalid") uncertain.delete(this.key(sessionID));
        return this.storageView(loaded.view);
      });
    } catch (error) {
      return invalid(sessionID, error);
    }
  }

  /** For controller/recovery consumers. Reads never dispatch or reset budgets. */
  async readSnapshot(sessionID: string): Promise<
    { readonly status: "ready"; readonly snapshot: TodoSnapshot } |
    { readonly status: "missing" | "invalid"; readonly view: TodoView }
  > {
    try {
      return await this.state.workflowTransaction(sessionID, async (tx) => {
        const loaded = await load(tx, sessionID);
        if (loaded.snapshot) return { status: "ready", snapshot: loaded.snapshot };
        return {
          status: loaded.view.status === "missing" ? "missing" : "invalid",
          view: loaded.view,
        };
      });
    } catch (error) {
      return { status: "invalid", view: invalid(sessionID, error) };
    }
  }

  async apply(sessionID: string, input: unknown): Promise<TodoWriteResult> {
    return this.transaction(sessionID, async (tx, loaded) => {
      const operation = parseTodoOperation(input);
      if (operation.op === "view") {
        if (loaded.view.status !== "invalid") uncertain.delete(this.key(sessionID));
        return { disposition: "unchanged", view: loaded.view };
      }
      if (uncertain.has(this.key(sessionID)))
        return { disposition: "uncertain", view: loaded.view, diagnostic: "read an authoritative view before another mutation" };
      if (loaded.view.status === "invalid")
        return { disposition: "rejected", view: loaded.view, diagnostic: loaded.view.diagnostic };
      const next = reduceTodo(loaded.snapshot, operation, sessionID);
      if (next === loaded.snapshot) return { disposition: "unchanged", view: loaded.view };
      const result = await this.persist(tx, sessionID, loaded, next, operation.op);
      if (result.disposition === "applied" || result.disposition === "committed-with-warning")
        storageHolds.delete(this.key(sessionID));
      return result;
    });
  }

  /**
   * Compare-and-set for task 5's controller. The synchronous updater runs in the
   * existing session queue; host dispatch must occur outside this transaction.
   * Board identity, epoch and closure ledger remain reducer-owned.
   */
  async updateController(
    sessionID: string,
    expected: TodoVersion,
    update: (controller: TodoController) => TodoController,
  ): Promise<TodoWriteResult> {
    return this.transaction(sessionID, async (tx, loaded) => {
      if (uncertain.has(this.key(sessionID)))
        return { disposition: "uncertain", view: loaded.view, diagnostic: "read an authoritative view before another mutation" };
      const snapshot = loaded.snapshot;
      if (!snapshot || snapshot.generation !== expected.generation || snapshot.revision !== expected.revision)
        throw new TodoStateError("stale-state", "controller generation/revision no longer matches");
      // Decode into schema field order, just as load() does for the snapshot.
      // JSON then compares persisted values, ignoring object insertion order,
      // absent versus undefined optionals, and signed zero.
      const controller = todoControllerSchema.parse(update(structuredClone(snapshot.controller)));
      for (const field of ["sourceWatermark", "activationFence", "consumedActivationFence"] as const)
        assertSourceOrder(snapshot.controller[field], controller[field]);
      if (controller.workEpoch !== snapshot.controller.workEpoch ||
        JSON.stringify(controller.closedLabels) !== JSON.stringify(snapshot.controller.closedLabels))
        throw new TodoStateError("stale-state", "controller cannot reset reducer-owned epoch or closed-label ledger");
      if (JSON.stringify(controller) === JSON.stringify(snapshot.controller))
        return { disposition: "unchanged", view: loaded.view };
      return this.persist(tx, sessionID, loaded, {
        ...snapshot, controller, revision: incrementTodoCounter(snapshot.revision),
      }, "controller");
    });
  }

  private async transaction(
    sessionID: string,
    operation: (tx: WorkflowTx, loaded: Loaded) => Promise<TodoWriteResult>,
  ): Promise<TodoWriteResult> {
    try {
      return await this.state.workflowTransaction(sessionID, async (tx) => {
        const loaded = await load(tx, sessionID);
        try {
          const result = await operation(tx, loaded);
          return { ...result, view: this.storageView(result.view) };
        } catch (error) {
          return { disposition: "rejected", view: this.storageView(loaded.view), diagnostic: diagnostic(error) };
        }
      });
    } catch (error) {
      return { disposition: "rejected", view: invalid(sessionID, error), diagnostic: diagnostic(error) };
    }
  }

  private async persist(
    tx: WorkflowTx,
    sessionID: string,
    before: Loaded,
    next: TodoSnapshot,
    verb: string,
  ): Promise<TodoWriteResult> {
    const text = encode(next);
    try {
      await tx.writeText(fileOf(tx), text, {
        audit: {
          category: "state", owner: RUNTIME_OWNER, skill: "todo", verb,
          mutationId: `todo:${sessionID}:${next.generation}:${next.revision}`,
        },
      });
      return { disposition: "applied", view: todoView(next) };
    } catch (error) {
      // StateStore writes before it audits. Compare bytes under the SAME queue
      // before reporting failure; a rejected audit is not a rejected mutation.
      try {
        const observed = await tx.readText(fileOf(tx));
        if (observed === text)
          return { disposition: "committed-with-warning", view: todoView(next), diagnostic: diagnostic(error) };
        if (observed === before.text)
          return { disposition: "rejected", view: before.view, diagnostic: diagnostic(error) };
      } catch (readError) {
        uncertain.add(this.key(sessionID));
        this.holdStorage(sessionID, "uncertain_storage");
        return { disposition: "uncertain", view: invalid(sessionID, readError), diagnostic: diagnostic(error) };
      }
      uncertain.add(this.key(sessionID));
      this.holdStorage(sessionID, "uncertain_storage");
      return {
        disposition: "uncertain",
        view: invalid(sessionID, "write outcome differs from both snapshots; explicit view required"),
        diagnostic: diagnostic(error),
      };
    }
  }
}
