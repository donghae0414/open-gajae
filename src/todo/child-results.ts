// Original execution/result accounting over OpenCode 2.0.26 public events.
// A child's FIFO survives late lineage, hook replacement and backend restart.
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { HostSession } from "../hooks.js";
import { assertStatePayload, type StateStore, type WorkflowTx } from "../state.js";
import { TodoStateError, type TodoSource } from "./state.js";
import {
  childResultDecision, initialChildResultState, restoreChildResultState, serializeChildResultState,
  childFencesSchema, terminalChildFence, restoreChildFence,
  transitionChildResult, type ChildResultAction, type ChildResultState, type ChildTool,
} from "./child-result-state.js";
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const FILE = "todo-child-results.json";

export function createChildResults(
  state: StateStore, session: HostSession, locationDir: string,
  changed: (parentID?: string) => Promise<void>,
) {
  const ledgers = new Map<string, ChildResultState>();
  const tools = new Map<string, ChildTool>();
  const lifetime = new AbortController();
  const confirmations = new Map<Promise<void>, {
    parentID: string; childID: string; waiting: boolean; abort: AbortController;
  }>();
  let pending = 0;
  let failure: unknown;
  let loaded = false;
  let queue = Promise.resolve();
  let disposed = false;
  let confirmationID = 0;
  const deferred: Array<() => Promise<void>> = [];
  // Locations in one project share StateStore's session directory. Their
  // ownership observations must not overwrite each other's result accounting.
  const name = locationDir === state.worktree ? FILE :
    `todo-child-results-${createHash("sha256").update(locationDir).digest("hex")}.json`;
  const file = (dir: string) => join(dir, "state", name);
  const fencesFile = (dir: string) => join(dir, "state", name.replace(".json", "-fences.json"));

  async function persist(current: ChildResultState) {
    assertStatePayload(current.ledger);
    const fence = terminalChildFence(current);
    const rootID = await state.rootSessionID(current.ledger.sessionID);
    await state.workflowTransaction(rootID, async (rootTx) => {
      const write = async (tx: WorkflowTx) => {
        // Hold root then child queues throughout publication/removal. A newer
        // writer cannot publish between our snapshot and its deletion.
        await tx.writeText(file(tx.paths.sessionDir), serializeChildResultState(current), { audit: false });
        const target = fencesFile(rootTx.paths.sessionDir);
        const bytes = await rootTx.readBytes(target);
        const fences = childFencesSchema.parse(bytes === undefined ? {} :
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        if (fence) fences[current.ledger.sessionID] = fence;
        else if (!(current.ledger.sessionID in fences)) return;
        else delete fences[current.ledger.sessionID];
        // Snapshot wins if a crash leaves both files; fence precedes deletion.
        await rootTx.writeBytes(target, new TextEncoder().encode(JSON.stringify(fences)), { audit: false });
        if (fence) await tx.remove(file(tx.paths.sessionDir), { audit: false });
      };
      if (rootID === current.ledger.sessionID) await write(rootTx);
      else await state.workflowTransaction(current.ledger.sessionID, write);
    });
    if (fence) await state.pruneEmptyChild(current.ledger.sessionID);
  }
  async function apply(id: string, action: ChildResultAction) {
    const result = transitionChildResult(ledgers.get(id) ?? initialChildResultState(id), action);
    if (result.keep) ledgers.set(id, result.state);
    if (result.forgetTool && action.kind === "tool") tools.delete(`${action.parentID}\0${action.toolID}`);
    if (result.write) await persist(result.state);
    if (result.state.ledger.ownership === "foreign")
      for (const activity of confirmations.values()) if (activity.childID === id) activity.abort.abort();
    return result;
  }
  async function restore() {
    if (loaded) return;
    const ids = await state.sessionIDs();
    // Load fences first; an extant snapshot is authoritative during either
    // crash boundary (terminal publication or the next real execution).
    for (const id of ids) {
      await state.workflowTransaction(id, async (tx) => {
        const bytes = await tx.readBytes(fencesFile(tx.paths.sessionDir));
        if (!bytes) return;
        const fences = childFencesSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
        for (const [childID, fence] of Object.entries(fences)) {
          if (fence.sessionID !== childID) throw new TodoStateError("stale-state", "child-result fence owner mismatch");
          const current = restoreChildFence(fence);
          if (!terminalChildFence(current)) throw new TodoStateError("stale-state", "nonterminal child-result fence");
          ledgers.set(childID, current);
        }
      });
    }
    for (const id of ids) {
      const current = await state.workflowTransaction(id, async (tx) => {
        const scoped = await tx.readBytes(file(tx.paths.sessionDir));
        const bytes = scoped ?? (name !== FILE
          ? await tx.readBytes(join(tx.paths.sessionDir, "state", FILE)) : undefined);
        if (bytes === undefined) return;
        const parsed = restoreChildResultState(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        // Only pre-ownership snapshots need migration. A modern root-location
        // exclusion is not this nested location's authoritative history.
        if (scoped === undefined && parsed.ledger.ownership !== undefined) return;
        assertStatePayload(parsed.ledger);
        if (parsed.ledger.sessionID !== id) throw new TodoStateError("stale-state", "child-result owner mismatch");
        return parsed;
      });
      if (!current) continue;
      ledgers.set(id, current);
      if (terminalChildFence(current)) await persist(current);
      if (current.ledger.parentID === undefined || current.ledger.ownership === undefined) {
        // Ownership lookup is not storage IO and must not occupy the write
        // queue. An unanswered/failed lookup leaves visible, waivable debt.
        void session.get({ sessionID: id }, { signal: lifetime.signal }).then(async (info) => {
          if (disposed || typeof info.location?.directory !== "string") return;
          await schedule(async () => {
            await apply(id, info.location?.directory === locationDir
              ? { kind: "owner", parentID: info.parentID ?? null } : { kind: "foreign" });
          });
          if (!disposed) await changed();
        }).catch((error: unknown) => {
          if (!disposed) console.warn("[open-gajae:todo] child ownership remains unknown", error);
        });
      }
    }
    loaded = true;
  }
  function schedule(action: () => Promise<void>) {
    if (disposed) return Promise.resolve();
    pending++;
    queue = queue.then(async () => {
      if (failure) { deferred.push(action); return; }
      await restore();
      await action();
    }).catch((error: unknown) => {
      deferred.push(action);
      failure = error;
      console.warn("[open-gajae:todo] child-result storage failed; admission held", error);
    }).finally(() => { pending--; });
    return queue;
  }
  function update(id: string, action: ChildResultAction) {
    schedule(async () => { await apply(id, action); });
  }
  function observe(type: string, data: Record<string, unknown>, source?: TodoSource) {
    const id = data.sessionID;
    if (typeof id !== "string") return;
    if (type === "session.created") {
      update(id, { kind: "created", source, parentID: typeof data.parentID === "string" ? data.parentID : undefined });
    } else if (type === "session.execution.started") {
      update(id, { kind: "started", source });
    } else if (type === "session.execution.succeeded" || type === "session.execution.failed" ||
      type === "session.execution.interrupted") {
      update(id, { kind: "ended", source });
    } else if (type === "session.inbox.enqueued") {
      const payload = record(data.item) && record(data.item.payload) ? data.item.payload : undefined;
      const metadata = record(payload?.metadata) ? payload.metadata : undefined;
      const child = metadata?.source === "subagent" ? metadata.childID : undefined;
      const inboxID = data.inboxID;
      if (typeof child !== "string" || typeof metadata?.state !== "string" || typeof inboxID !== "string") return;
      update(child, { kind: "enqueued", parentID: id, inboxID, source });
    } else if (type === "session.inbox.delivered" || type === "session.inbox.cancelled") {
      const inboxID = data.inboxID;
      if (typeof inboxID !== "string") return;
      schedule(async () => {
        for (const { ledger } of ledgers.values()) {
          if (ledger.parentID !== id) continue;
          const result = ledger.results.find((entry) => entry.inboxID === inboxID);
          if (!result) continue;
          await apply(ledger.sessionID, { kind: type === "session.inbox.delivered" ? "delivered" : "cancelled",
            parentID: id, inboxID, source });
        }
      });
    } else if (type === "session.tool.progress" || type === "session.tool.success" || type === "session.tool.failed") {
      const metadata = record(data.metadata) ? data.metadata : undefined;
      const child = metadata?.sessionID;
      const toolID = data.id;
      if (typeof child !== "string" || typeof toolID !== "string") return;
      const key = `${id}\0${toolID}`;
      schedule(async () => {
        await apply(child, { kind: "tool", parentID: id, toolID, source, registration: tools.get(key),
          phase: type === "session.tool.progress" ? "progress" :
            type === "session.tool.success" && metadata?.status === "running" ? "background" : "terminal" });
      });
    }
  }
  return {
    observe,
    running(id: string) {
      // Failed writes retain observations for recovery. The raw running set
      // must not hide the storage hold that the admission path publishes.
      if (failure) return undefined;
      const current = ledgers.get(id);
      return current && current.ledger.ownership !== "foreign" &&
        current.ledger.executions.some((entry) => entry.running);
    },
    owner(id: string, parentID: string | undefined) {
      update(id, { kind: "owner", parentID: parentID ?? null });
    },
    foreign(id: string) {
      update(id, { kind: "foreign" });
    },
    tool(parentID: string, toolID: string, background: boolean, fresh: boolean) {
      tools.set(`${parentID}\0${toolID}`, { channel: background ? "background" : "foreground", fresh });
    },
    holdReason(parentID: string) {
      return childResultDecision(ledgers.values(), parentID).hold;
    },
    confirm(parentID: string) {
      // A genuine user message acknowledges the uncertain historical prefix,
      // not starts observed after it. A restored running record additionally
      // needs the public host's idle signal; never infer idle from the message.
      schedule(async () => {
        for (const id of ledgers.keys()) {
          const ticket = ++confirmationID;
          const result = await apply(id, { kind: "acknowledge", id: ticket, parentID, canWait: !!session.wait });
          if (!result.wait) continue;
          const abort = new AbortController();
          const idle = result.wait.running && session.wait
            ? session.wait({ sessionID: id }, { signal: AbortSignal.any([lifetime.signal, abort.signal]) })
            : Promise.resolve();
          const activity = { parentID, childID: id, waiting: true, abort };
          const confirmation = idle.then(async () => {
            await schedule(async () => {
              await apply(id, { kind: "idle", id: ticket });
            });
            activity.waiting = false;
            // Publication is outside the child queue: flushing the parent may
            // drain that queue, so awaiting it from inside would deadlock.
            if (!disposed) await changed(parentID);
          }).catch((error: unknown) => {
            if (!lifetime.signal.aborted && !abort.signal.aborted) {
              failure = error;
              console.warn("[open-gajae:todo] child idle confirmation failed; admission held", error);
            }
          });
          confirmations.set(confirmation, activity);
          void confirmation.finally(() => confirmations.delete(confirmation));
        }
      });
    },
    blocked(parentID: string) {
      return pending > 0 || [...confirmations.values()].some((entry) =>
        entry.parentID === parentID && entry.waiting && ledgers.get(entry.childID)?.ledger.ownership !== "foreign") ||
        failure !== undefined || childResultDecision(ledgers.values(), parentID).blocked;
    },
    failed() { return failure !== undefined; },
    async recover() {
      await queue;
      // Only the caller's authoritative view + applied operation may invoke
      // this. Re-read disk, then replay retained observations, not a blind
      // increment: durable source fences and inbox/tool IDs make them idempotent.
      const actions = deferred.splice(0);
      ledgers.clear();
      loaded = false;
      failure = undefined;
      for (const action of actions) schedule(action);
      await queue;
    },
    async flush() {
      if (!loaded) schedule(async () => {});
      while (pending > 0) await queue;
    },
    async dispose() {
      disposed = true;
      lifetime.abort();
      await queue;
      await Promise.all(confirmations.keys());
    },
  };
}
