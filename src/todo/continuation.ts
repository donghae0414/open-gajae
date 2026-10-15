// Original open-gajae controller (plan task 5), adapted to the public
// @opencode/plugin/client 2.0.26 event and synthetic contracts (R13-R16).
// A reserved message is never blindly resent after restart or an unknown
// error. Bookkeeping is deliberately stricter than OMO R10: only the
// reducer's epoch closure ledger replenishes progress, never revision/time.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { OpenCode } from "@opencode/client";
import { Service, type Endpoint } from "@opencode/client/service";
import type { Settings } from "../config.js";
import type { HostSession } from "../hooks.js";
import { INJECTION_MARKERS } from "../injection.js";
import { RUNTIME_OWNER } from "../skill-state/audit.js";
import { assertStatePayload, type StateStore } from "../state.js";
import { todoContinuation, todoContext, todoNotice } from "./messages.js";
import { todoCounts, todoView, type TodoView } from "./protocol.js";
import { todoSnapshotSchema, todoSourceSchema, TodoStateError, type TodoController, type TodoSnapshot, type TodoSource } from "./state.js";
import { TodoStore, todoProjectionChanged, type TodoWriteResult } from "./store.js";
import { createChildResults } from "./child-results.js";
import {
  createTodoAdmissionFlight, isChildResultHold, projectChildResultHold, todoObservationBlocked,
  type TodoAdmissionRequest,
} from "./continuation-decision.js";

const envelope = z.object({
  id: z.string().optional(), type: z.string(),
  durable: z.unknown().optional(), data: z.record(z.string(), z.unknown()),
});
const hostFormsSchema = z.array(z.object({ id: z.string().min(1), sessionID: z.string().min(1) }))
  .refine((forms) => new Set(forms.map((form) => form.id)).size === forms.length);
export type TodoFormReader = (sessionID: string, signal: AbortSignal) =>
  Promise<ReadonlyArray<{ readonly id: string; readonly sessionID: string }>>;

/** Query only an explicitly supplied host endpoint, never unrelated discovery. */
export async function readTodoHostForms(input: {
  readonly sessionID: string;
  readonly locationDir: string;
  readonly signal: AbortSignal;
  readonly endpoint: Endpoint;
}): Promise<z.infer<typeof hostFormsSchema>> {
  const endpoint = input.endpoint;
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) });
  const session = await client.session.get({ sessionID: input.sessionID }, { signal: input.signal });
  if (session.id !== input.sessionID || session.location.directory !== input.locationDir)
    throw new TodoStateError("stale-state", "form API session belongs to another location");
  const forms = hostFormsSchema.parse(await client.session.form.list(
    { sessionID: input.sessionID }, { signal: input.signal },
  ));
  if (forms.some((form) => form.sessionID !== input.sessionID))
    throw new TodoStateError("stale-state", "form API returned another session's question");
  return forms;
}
// @opencode/client 2.0.26 exposes session.form/inbox queries, but the public
// plugin SessionDomain does not. Keep observed identities in the same guarded
// session queue instead of importing private host services. This sidecar stores
// form observations only, never a second todo board.
const formStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sessionID: z.string().min(1),
  instanceID: z.string().uuid().optional(),
  pending: z.array(z.string().min(1)).refine((ids) => new Set(ids).size === ids.length),
  unknown: z.boolean(),
  episode: z.string().min(1).nullable(),
  noticeSent: z.boolean(),
  recovery: z.strictObject({
    reason: z.literal("backend_instance_changed"),
    previousInstanceID: z.string().uuid().nullable(),
    discarded: z.number().int().min(0),
  }).optional(),
}).refine((state) => (state.pending.length > 0 || state.unknown) === (state.episode !== null));
// StateStore is created once per Plugin.setup. Reconstructing hooks against
// that same store is not a new backend. Remember files seen in this instance
// so damage introduced while a question is live still fails closed.
const formInstances = new WeakMap<StateStore, { id: string; files: Set<string> }>();
type FormChange =
  | { readonly kind: "created" | "resolved"; readonly id: string }
  | { readonly kind: "notice"; readonly episode: string | null }
  | { readonly kind: "reconciled"; readonly pending: readonly string[] };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function todoEventSource(input: unknown): TodoSource | undefined {
  const parsed = envelope.safeParse(input);
  if (!parsed.success || !record(parsed.data.durable)) return;
  const source = todoSourceSchema.safeParse({
    eventID: parsed.data.id, aggregateID: parsed.data.durable.aggregateID, seq: parsed.data.durable.seq,
  });
  return source.success ? source.data : undefined;
}
function newer(previous: TodoSource | null, source: TodoSource): boolean {
  return !previous || (previous.aggregateID === source.aggregateID && source.seq > previous.seq);
}
function committed(result: TodoWriteResult): boolean {
  return result.disposition === "applied" || result.disposition === "committed-with-warning" ||
    result.disposition === "unchanged";
}
/** Answering a question must never release a stop, error or recovery hold. */
function isFormHold(reason: string | undefined): boolean {
  return reason === "unanswered_form" || reason === "form_state_unknown";
}
function persistentHold(controller: TodoController, hold: NonNullable<TodoController["hold"]>) {
  return isFormHold(controller.hold?.reason) || isChildResultHold(controller.hold?.reason)
    ? hold : controller.hold ?? hold;
}
type Inbox = { readonly user: boolean };
// Mutable, process-local observations only. Durable authority is always read
// again under the store queue before admission.
type Observation = {
  version: number;
  inbox: Map<string, Inbox>;
  forms: Set<string>;
  formsRestored: boolean;
  formsPending: number;
  formsUnknown: boolean;
  formEpisode: string | null;
  formsChecked?: boolean;
  formQuery?: Promise<void>;
  formsRecheck?: boolean;
  formNoticeSent?: boolean;
  tools: Set<string>;
  abort?: AbortController;
  agent?: string;
  fence?: TodoSource;
  initialFence?: TodoSource;
  initializing?: boolean;
  stop?: TodoSource | true;
  observedSource?: TodoSource;
  started?: TodoSource;
  executing?: boolean;
  deferred?: { readonly source: TodoSource; readonly generation: number; readonly workEpoch: number };
  admission: ReturnType<typeof createTodoAdmissionFlight>;
  requiresStart?: boolean;
  recovered: boolean;
  view?: TodoView;
};
export type TodoContinuationOptions = {
  readonly state: StateStore;
  readonly settings: Settings["todo"];
  readonly eligible: (sessionID: string) => Promise<boolean>;
  readonly ownsSession: (sessionID: string) => Promise<boolean>;
  readonly observationsPending: (sessionID: string) => boolean;
  readonly locationDir: string;
  readonly changed?: (view: TodoView) => Promise<void>;
  readonly readPendingForms?: TodoFormReader;
};

export function createTodoContinuation(store: TodoStore, session: HostSession, options: TodoContinuationOptions) {
  const instance = formInstances.get(options.state) ?? { id: randomUUID(), files: new Set<string>() };
  formInstances.set(options.state, instance);
  const observations = new Map<string, Observation>();
  const parents = new Map<string, string>();
  const children = createChildResults(options.state, session, options.locationDir, childChanged);
  const writes = new Map<string, Promise<void>>();
  const notices = new Set<Promise<void>>();
  const formQueries = new Set<Promise<void>>();
  const storageNotices = new Set<string>();
  const childStorageHolds = new Set<string>();
  const seen = new WeakSet<object>();
  const lifetime = new AbortController();
  let disposed = false;
  function of(id: string): Observation {
    let state = observations.get(id);
    if (!state) {
      state = {
        version: 0, inbox: new Map(), forms: new Set(), formsRestored: false,
        formsPending: 0, formsUnknown: false, formEpisode: null,
        tools: new Set(), recovered: false, admission: createTodoAdmissionFlight(),
      };
      observations.set(id, state);
    }
    return state;
  }
  function veto(state: Observation) {
    state.version++;
    state.abort?.abort();
  }
  function blocked(id: string, state: Observation): boolean {
    return state.executing === true || todoObservationBlocked({
      disposed, observationsPending: options.observationsPending(id), storageHeld: !!store.storageHold(id),
      inbox: state.inbox.size, formsPending: state.formsPending, formsUnknown: state.formsUnknown,
      forms: state.forms.size, tools: state.tools.size, childrenBlocked: children.blocked(id), agent: state.agent,
    });
  }
  async function publish(result: TodoWriteResult) {
    const state = of(result.view.sessionID);
    const previous = state.view;
    state.view = result.view;
    const changed = todoProjectionChanged(previous, result.view) ||
      (!previous && (result.view.status === "invalid" ||
        (result.view.status === "ready" && result.view.hold !== null)));
    if (result.disposition !== "applied" && result.disposition !== "committed-with-warning" &&
      !changed) return;
    try { await options.changed?.(result.view); }
    catch (error) { console.warn("[open-gajae:todo] controller notification failed", error); }
  }
  async function readSnapshot(id: string) {
    const loaded = await store.readSnapshot(id);
    await publish({
      disposition: "unchanged",
      view: loaded.status === "ready" ? store.storageView(todoView(loaded.snapshot)) : loaded.view,
    });
    return loaded;
  }
  async function syncForms(id: string, change?: FormChange): Promise<boolean> {
    if (!(await options.ownsSession(id))) return false;
    const state = of(id);
    try {
      const restored = await options.state.workflowTransaction(id, async (tx) => {
        const boardText = await tx.readText(join(tx.paths.sessionDir, "state", "todo.json"));
        const board = boardText === undefined ? undefined : todoSnapshotSchema.parse(JSON.parse(boardText));
        const held = board?.controller.hold;
        const question = isFormHold(held?.reason);
        if (question && held?.noticeSent) state.formNoticeSent = true;
        const file = join(tx.paths.sessionDir, "state", "todo-forms.json");
        const authoritative = change?.kind === "reconciled";
        const seenHere = instance.files.has(file);
        const recoverable = authoritative || !seenHere;
        let beforeBytes: Uint8Array | undefined;
        let unreadable = false;
        try { beforeBytes = await tx.readBytes(file); }
        catch (error) {
          if (!recoverable) throw error;
          // Host/instance-confirmed recovery can archive a rejected file without
          // reading it, including when the bounded byte reader refuses it.
          unreadable = true;
        }
        let before: string | undefined;
        let stored: unknown;
        try {
          // Strict decoding is only for parsing; archival links the original
          // file. Preserve BOM handling of prior JSON reads.
          before = beforeBytes === undefined ? undefined :
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(beforeBytes);
          stored = before === undefined ? undefined : JSON.parse(before);
        }
        catch (error) { if (!recoverable) throw error; }
        const parsed = formStateSchema.safeParse(stored);
        const validStored = !unreadable && parsed.success && parsed.data.sessionID === id &&
          beforeBytes !== undefined;
        // OpenCode 2.0.26 loses pending forms on backend restart: the native
        // B7A-1 crash probe returned [] and 404 for both answer and dismiss.
        // See .omo/evidence/todo-agent-performance-task-7a-gate-review.md
        // and host/question-crash-restart.json.
        // Old identities (including unreadable old state) cannot still be
        // answered; current-instance identities still need actual resolution.
        const previousInstance = validStored && parsed.data.instanceID !== undefined
          ? parsed.data.instanceID !== instance.id
          : !seenHere && (unreadable || beforeBytes !== undefined || question);
        if ((authoritative || previousInstance) && (unreadable || beforeBytes !== undefined) && !validStored) {
          // Keep rejected bytes as evidence, then rebuild from the host's
          // complete pending set. Recovery never requires manual file repair.
          const archive = join(tx.paths.sessionDir, "state", `todo-forms.invalid-${randomUUID()}.json`);
          const archived = await tx.archiveFile(file, archive, {
            audit: { category: "state", owner: RUNTIME_OWNER, skill: "todo", verb: "archive-forms" },
          });
          if (archived.warning)
            console.warn("[open-gajae:todo] rejected form state archived with audit warning", archived.warning);
        }
        const forms = beforeBytes === undefined || ((authoritative || previousInstance) && !validStored) ? formStateSchema.parse({
          schemaVersion: 1, sessionID: id, instanceID: instance.id, pending: [],
          // A legacy hold without its identities is not evidence of an empty
          // host form set. Persist uncertainty before a start can erase it.
          unknown: question && !previousInstance,
          episode: question && !previousInstance ? randomUUID() : null,
          noticeSent: question && !previousInstance && held?.noticeSent === true,
        }) : formStateSchema.parse(stored);
        if (forms.sessionID !== id)
          throw new TodoStateError("stale-state", "todo form state owner mismatch; preserved");
        if (previousInstance) {
          forms.recovery = {
            reason: "backend_instance_changed",
            previousInstanceID: parsed.success ? parsed.data.instanceID ?? null : null,
            discarded: validStored ? parsed.data.pending.length : 0,
          };
          forms.pending = [];
          forms.unknown = false;
          forms.episode = null;
          forms.noticeSent = false;
          state.formNoticeSent = false;
        }
        forms.instanceID = instance.id;
        if (question || forms.episode === state.formEpisode)
          forms.noticeSent ||= state.formNoticeSent === true;
        if (change?.kind === "created" && !forms.pending.includes(change.id)) {
          if (forms.pending.length === 0 && !forms.unknown) {
            forms.episode = randomUUID();
            forms.noticeSent = false;
          }
          forms.pending.push(change.id);
        }
        if (change?.kind === "resolved") forms.pending = forms.pending.filter((form) => form !== change.id);
        if (change?.kind === "notice" && forms.episode === change.episode)
          forms.noticeSent = true;
        if (change?.kind === "reconciled") {
          forms.pending = [...change.pending];
          forms.unknown = false;
          if (forms.pending.length > 0) forms.episode ??= randomUUID();
        }
        if (forms.pending.length === 0 && !forms.unknown) {
          forms.episode = null;
          forms.noticeSent = false;
        }
        const valid = formStateSchema.parse(forms);
        assertStatePayload(valid);
        const text = JSON.stringify(valid);
        if (text !== before && (board || change)) {
          const bytes = Buffer.from(text, "utf8");
          try {
            await tx.writeBytes(file, bytes, {
              audit: {
                category: "state", owner: RUNTIME_OWNER, skill: "todo",
                verb: previousInstance ? "forms-instance-reset" : "forms",
              },
            });
          } catch (error) {
            // Replacement precedes audit. A matching readback proves the form
            // identity change committed; otherwise recovery must stay held.
            const written = await tx.readBytes(file);
            if (!written || !bytes.equals(written)) throw error;
            console.warn("[open-gajae:todo] form state committed with audit warning", error);
          }
        }
        instance.files.add(file);
        return { forms: valid, question, previousInstance };
      });
      state.forms = new Set(restored.forms.pending);
      state.formsUnknown = restored.forms.unknown;
      state.formEpisode = restored.forms.episode;
      state.formNoticeSent = restored.forms.noticeSent;
      state.formsRestored = true;
      if (restored.previousInstance) {
        // Publish the cleared canonical view even when the first restoration
        // was triggered by inbox delivery rather than a context/tool hook.
        await mutate(id, (controller) =>
          isFormHold(controller.hold?.reason) && !state.formsUnknown && state.forms.size === 0
            ? { ...controller, hold: null } : controller);
      }
      return restored.question;
    } catch (error) {
      // Preserve corrupt/foreign/future bytes, and do not let an answer or a
      // user-authorized start turn an incomplete identity set into approval.
      state.formsUnknown = true;
      state.formsRestored = true;
      console.warn("[open-gajae:todo] form identities unavailable; continuation held", error);
      return true;
    }
  }
  async function restoreForms(id: string, retry = false) {
    const state = of(id);
    if (!state.formsRestored) {
      const question = await syncForms(id);
      if (question || state.formsUnknown || state.forms.size > 0) await recordFormHold(id);
    }
    if (retry || !state.formsChecked) await reconcileForms(id);
    else await state.formQuery;
  }
  function reconcileForms(id: string): Promise<void> | undefined {
    const read = options.readPendingForms;
    if (disposed || !read) return;
    const state = of(id);
    if (state.formQuery) {
      state.formsRecheck = true;
      return state.formQuery;
    }
    state.formsChecked = true;
    state.formsPending++;
    const version = state.version;
    const query = (async () => {
      try {
        // No storage/local mutation queue is held across the host request.
        await flush(id);
        if (!state.formsRestored) await syncForms(id);
        // No stored/observed question is not an uncertain host response.
        // Only unresolved identities or damaged state require reconciliation.
        if (!state.formsUnknown && state.forms.size === 0) return;
        const forms = hostFormsSchema.parse(await read(id, lifetime.signal));
        if (forms.some((form) => form.sessionID !== id))
          throw new TodoStateError("stale-state", "form reconciliation owner mismatch");
        if (!disposed && state.version === version)
          await recordFormHold(id, { kind: "reconciled", pending: forms.map((form) => form.id) });
      } catch (error) {
        if (!disposed) {
          console.warn("[open-gajae:todo] public form reconciliation unavailable", error);
          // Unreachability cannot invent missing identities. Preserve the
          // existing known/unknown hold so an actual answer can still clear
          // its known identity without requiring a discoverable server.
          await recordFormHold(id);
        }
      } finally {
        state.formsPending--;
        state.formQuery = undefined;
      }
      if (state.formsRecheck && !disposed) {
        state.formsRecheck = false;
        await reconcileForms(id);
      }
    })();
    state.formQuery = query;
    formQueries.add(query);
    void query.finally(() => formQueries.delete(query));
    return query;
  }
  async function invalidStorage(id: string, view: TodoView) {
    if (disposed) return;
    store.holdStorage(id, "invalid_storage");
    await publish({ disposition: "unchanged", view });
    if (storageNotices.has(id)) return;
    storageNotices.add(id);
    // Corrupt bytes are preserved, so they cannot carry a canonical hold.
    // The invalid DTO is authoritative; a fixed native message ID deduplicates
    // its passive diagnostic across recovery without creating a second file.
    const messageID = `msg_todo_invalid_${id}`;
    try {
      const messages = await session.context?.({ sessionID: id });
      if (messages?.some((message) => message.id === messageID)) return;
      await session.synthetic({
        sessionID: id, id: messageID, text: todoNotice("invalid_storage"),
        description: "open-gajae: todo held (invalid storage)", resume: false,
        metadata: { source: "open-gajae.todo", kind: "notice" },
      }, { signal: lifetime.signal });
    } catch (error) {
      console.warn("[open-gajae:todo] invalid storage diagnostic delivery failed", error);
    }
  }
  async function mutate(id: string, change: (controller: TodoController) => TodoController) {
    if (!(await options.ownsSession(id))) return;
    if (!of(id).formsRestored) await syncForms(id);
    for (;;) {
      const loaded = await readSnapshot(id);
      if (loaded.status !== "ready") {
        if (loaded.status === "invalid") await invalidStorage(id, loaded.view);
        return;
      }
      const result = await store.updateController(id, loaded.snapshot, change);
      if (committed(result)) { await publish(result); return result; }
      // A real concurrent reducer mutation may win the CAS. Re-read that
      // snapshot, never retry a storage failure or an uncertain write.
      if (result.disposition === "rejected" && result.view.status === "ready" &&
        result.view.revision !== loaded.snapshot.revision) continue;
      store.holdStorage(id, result.disposition === "uncertain" ? "uncertain_storage" : "storage_failure");
      await publish({ ...result, view: store.storageView(result.view) });
      return result;
    }
  }
  function enqueue(id: string, change: (controller: TodoController) => TodoController, before?: () => Promise<void>) {
    const pending = (writes.get(id) ?? Promise.resolve()).then(async () => {
      await before?.();
      await mutate(id, change);
    });
    writes.set(id, pending);
    void pending.finally(() => { if (writes.get(id) === pending) writes.delete(id); });
    return pending;
  }
  async function flush(id: string) {
    if (options.settings.enabled) await children.flush();
    while (writes.has(id)) await writes.get(id);
    const reason = children.holdReason(id);
    const view = of(id).view;
    if (!reason && !(view?.status === "ready" && isChildResultHold(view.hold?.reason))) return;
    await mutate(id, (controller) => projectChildResultHold(controller, children.holdReason(id)));
  }
  async function childChanged(id?: string): Promise<void> {
    if (disposed) return;
    if (id === undefined) {
      for (const [parentID, state] of observations)
        if (state.view?.status === "ready" && isChildResultHold(state.view.hold?.reason))
          await childChanged(parentID);
      return;
    }
    const state = of(id);
    // Remember the signal on both sides of publication. An admission can
    // start or settle during flush, or publish an older held snapshot.
    state.admission.wake();
    if (children.failed()) {
      store.holdStorage(id, "invalid_storage");
      childStorageHolds.add(id);
      await readSnapshot(id);
      return;
    }
    await flush(id);
    state.admission.wake();
    if (state.view?.status === "ready" && state.view.hold === null && !children.blocked(id)) {
      if (state.deferred) await resume(id, state.deferred.source, true);
    }
  }
  async function notice(id: string) {
    if (disposed) return;
    let reason: string | undefined;
    let formEpisode: string | null = null;
    const result = await mutate(id, (controller) => {
      reason = undefined;
      if (!controller.hold || controller.hold.noticeSent) return controller;
      reason = controller.hold.reason;
      // Reserve the episode's notice alongside the durable noticeSent claim.
      // A user-authorized start may clear the record while the form stays open.
      if (reason === "unanswered_form" || reason === "form_state_unknown") {
        of(id).formNoticeSent = true;
        formEpisode = of(id).formEpisode;
      }
      return { ...controller, hold: { ...controller.hold, noticeSent: true } };
    });
    if (!result || !committed(result) || !reason) return;
    if (reason === "unanswered_form" || reason === "form_state_unknown")
      await syncForms(id, { kind: "notice", episode: formEpisode });
    try {
      await session.synthetic({
        sessionID: id, id: `msg_${randomUUID()}`, text: todoNotice(reason),
        description: `open-gajae: todo held (${reason})`, resume: false,
        metadata: { source: "open-gajae.todo", kind: "notice" },
      }, { signal: lifetime.signal });
    } catch (error) {
      // The attempt is persisted before dispatch: an ambiguous notice response
      // cannot create a second notice or release the hold.
      console.warn("[open-gajae:todo] passive notice delivery failed", error);
    }
  }
  function notify(id: string) {
    const pending = flush(id).then(() => notice(id));
    notices.add(pending);
    void pending.finally(() => notices.delete(pending));
  }
  function recordFormHold(id: string, change?: FormChange) {
    const state = of(id);
    state.formsPending++;
    const pending = enqueue(id, (controller) => {
      if (controller.hold && !isFormHold(controller.hold.reason)) return controller;
      if (state.formsUnknown || state.forms.size > 0) {
        if (controller.hold?.reason === "unanswered_form" && controller.hold.noticeSent)
          state.formNoticeSent = true;
        return { ...controller, hold: {
          reason: state.formsUnknown ? "form_state_unknown" : "unanswered_form",
          ...(state.formNoticeSent ? { noticeSent: true } : {}),
        } };
      }
      return isFormHold(controller.hold?.reason) ? { ...controller, hold: null } : controller;
    }, async () => { await syncForms(id, change); });
    void pending.finally(() => { state.formsPending--; });
    if (state.formsUnknown || state.forms.size > 0 || change?.kind === "created") notify(id);
    return pending;
  }
  async function hold(id: string, reason: string, source?: TodoSource) {
    await mutate(id, (controller) => ({
      ...controller,
      hold: persistentHold(controller, { reason, ...(source ? { eventID: source.eventID } : {}) }),
    }));
    await notice(id);
  }
  function observe(input: unknown) {
    if (disposed || !options.settings.enabled || !record(input) || seen.has(input)) return;
    seen.add(input);
    const parsed = envelope.safeParse(input);
    if (!parsed.success) return;
    const { type, data } = parsed.data;
    const form = record(data.form) ? data.form : undefined;
    const id = typeof data.sessionID === "string" ? data.sessionID : form?.sessionID;
    if (typeof id !== "string") return;
    const state = of(id);
    const source = todoEventSource(input);
    if (source) {
      if (state.observedSource && !newer(state.observedSource, source)) return;
      state.observedSource = source;
    }
    children.observe(type, data, source);
    if (type === "session.created" && typeof data.parentID === "string") {
      parents.set(id, data.parentID);
    }
    const parent = parents.get(id);
    if (parent && type === "session.execution.started") veto(of(parent));
    // An execution end alone deliberately does not remove a pending child.
    switch (type) {
      case "session.execution.started":
        state.started = source;
        state.executing = true;
        state.deferred = undefined;
        state.version++;
        if (!state.formsRestored || state.formsUnknown || state.forms.size > 0) void reconcileForms(id);
        break;
      case "session.execution.succeeded":
        state.executing = false;
        break;
      case "session.viewed":
        void reconcileForms(id);
        break;
      case "session.agent.selected":
        if (typeof data.agent === "string") state.agent = data.agent;
        veto(state);
        break;
      case "session.execution.interrupted":
        state.executing = false;
        state.deferred = undefined;
        veto(state);
        if (data.reason === "user" || data.reason === "shutdown") {
          state.stop = source ?? true;
          enqueue(id, (controller) => {
            if (source && (!newer(controller.sourceWatermark, source) ||
              (controller.activationFence && !newer(controller.activationFence, source)))) return controller;
            return {
              ...controller, consumedActivationFence: controller.activationFence,
              sourceWatermark: source ?? controller.sourceWatermark,
              hold: controller.hold?.reason === "user_stop" ? controller.hold :
                { reason: "user_stop", ...(source ? { eventID: source.eventID } : {}) },
            };
          });
          notify(id);
        }
        break;
      case "session.execution.failed":
        state.executing = false;
        state.deferred = undefined;
        veto(state);
        enqueue(id, (controller) => source && !newer(controller.sourceWatermark, source) ? controller : ({
          ...controller, sourceWatermark: source ?? controller.sourceWatermark,
          hold: persistentHold(controller, { reason: "execution_error" }),
        }));
        notify(id);
        break;
      case "form.created":
        if (typeof form?.id !== "string") break;
        if (state.forms.size === 0) state.formNoticeSent = false;
        state.forms.add(form.id);
        veto(state);
        recordFormHold(id, { kind: "created", id: form.id });
        void reconcileForms(id);
        break;
      case "form.replied":
      case "form.cancelled":
        if (typeof data.id !== "string") break;
        state.version++;
        state.forms.delete(data.id);
        recordFormHold(id, { kind: "resolved", id: data.id });
        void reconcileForms(id);
        break;
      case "session.tool.input.started":
      case "session.tool.called":
        if (typeof data.id === "string") state.tools.add(data.id);
        veto(state);
        break;
      case "session.tool.success":
      case "session.tool.failed":
        if (typeof data.id === "string") state.tools.delete(data.id);
        break;
      case "session.inbox.enqueued": {
        const item = data.item;
        if (typeof data.inboxID !== "string" || !record(item) || !record(item.payload)) break;
        const payload = item.payload;
        const metadata = record(payload.metadata) ? payload.metadata : undefined;
        if (item.type === "synthetic" && metadata?.source === "open-gajae.todo") break;
        const text = payload.text;
        const user = item.type === "user" && !metadata?.source && typeof text === "string" &&
          !INJECTION_MARKERS.some((marker) => text.includes(marker));
        state.inbox.set(data.inboxID, { user });
        veto(state);
        break;
      }
      case "session.inbox.delivered":
      case "session.inbox.cancelled": {
        if (typeof data.inboxID !== "string") break;
        const item = state.inbox.get(data.inboxID);
        state.inbox.delete(data.inboxID);
        if (item?.user && source && type === "session.inbox.delivered") {
          children.confirm(id);
          if (!state.fence || newer(state.fence, source)) state.fence = source;
          enqueue(id, (controller) => newer(controller.activationFence, source)
            ? { ...controller, activationFence: source } : controller);
          void reconcileForms(id);
        }
        break;
      }
    }
  }
  async function recover(id: string, snapshot: TodoSnapshot) {
    const state = of(id);
    if (state.recovered) return;
    state.recovered = true;
    const reservation = snapshot.controller.reservation;
    if (reservation?.status === "accepted") state.requiresStart = true;
    if (reservation?.status !== "reserved" && reservation?.status !== "uncertain") return;
    // Public context is used only for reconciliation, never to manufacture a
    // user fence. Compacted/absent messages are NOT proof of non-acceptance.
    const messages = await session.context?.({ sessionID: id });
    const exists = messages?.some((message) => message.id === reservation.syntheticID);
    await mutate(id, (controller) => ({
      ...controller,
      reservation: controller.reservation?.syntheticID === reservation.syntheticID
        ? { ...controller.reservation, status: exists ? "accepted" : "uncertain" } : controller.reservation,
      hold: persistentHold(controller, { reason: "pending_dispatch", eventID: reservation.source.eventID }),
    }));
    await notice(id);
  }
  async function resume(id: string, source: TodoSource, recovery = false, scope?: TodoAdmissionRequest["scope"]) {
    if (disposed || !options.settings.enabled || !options.settings.continuation) return;
    const state = of(id);
    if (!state.admission.enter({ source, recovery, scope })) return;
    const deferred = recovery ? state.deferred : undefined;
    const version = state.version;
    const abort = new AbortController();
    let retry: TodoAdmissionRequest | undefined;
    state.abort = abort;
    try {
      await flush(id);
      if (children.failed()) {
        store.holdStorage(id, "invalid_storage");
        childStorageHolds.add(id);
        await readSnapshot(id);
        return;
      }
      await restoreForms(id);
      let loaded = await readSnapshot(id);
      if (loaded.status !== "ready") {
        if (loaded.status === "invalid") await invalidStorage(id, loaded.view);
        return;
      }
      await recover(id, loaded.snapshot);
      loaded = await readSnapshot(id);
      if (loaded.status !== "ready") return;
      const snapshot = loaded.snapshot;
      const controller = snapshot.controller;
      if (scope && (snapshot.generation !== scope.generation || controller.workEpoch !== scope.workEpoch)) return;
      // A newer start supersedes the old terminal even if its CAS never wrote.
      if (state.started && !newer(state.started, source)) return;
      if (recovery && (!deferred || state.deferred !== deferred ||
        deferred.source.eventID !== source.eventID ||
        snapshot.generation !== deferred.generation || controller.workEpoch !== deferred.workEpoch)) return;
      const reconsider: TodoAdmissionRequest = {
        source, recovery: false, scope: { generation: snapshot.generation, workEpoch: controller.workEpoch },
      };
      if (!recovery && children.blocked(id)) state.deferred = {
        source, generation: snapshot.generation, workEpoch: controller.workEpoch,
      };
      // A restored accepted controller is not evidence that this plugin saw
      // the current execution. Reconcile via a new native start and context,
      // never by replaying a terminal event that happened before restoration.
      if (state.requiresStart && (!state.started ||
        !newer(controller.sourceWatermark, state.started) ||
        !newer(state.started, source))) return;
      if (controller.hold) { await notice(id); return; }
      const retryable = scope !== undefined &&
        (controller.reservation?.status === "cancelled" || controller.reservation?.status === "failed") &&
        controller.reservation.source.eventID === source.eventID &&
        controller.sourceWatermark?.eventID === source.eventID &&
        controller.reservation.generation === snapshot.generation &&
        controller.reservation.workEpoch === controller.workEpoch;
      if ((!newer(controller.sourceWatermark, source) && !retryable) ||
        !todoCounts(snapshot.phases).open || blocked(id, state) || abort.signal.aborted) {
        if (state.version !== version) retry = reconsider;
        return;
      }
      if (!(await options.eligible(id)) || state.version !== version) {
        if (state.version !== version) retry = reconsider;
        return;
      }
      // Context can expose a still-running tool after a plugin restart.
      const messages = await session.context?.({ sessionID: id });
      if (messages?.some((message) => message.content?.some((part) =>
        part.type === "tool" && record(part.state) &&
        (part.state.status === "running" || part.state.status === "streaming")))) return;
      const previous = controller.reservation;
      const progressed = previous && controller.closedLabels.length > previous.progress;
      const stagnation = previous?.status === "accepted" && previous.workEpoch === controller.workEpoch
        ? progressed ? 0 : controller.stagnation + 1
        : controller.stagnation;
      if (stagnation >= options.settings.stagnationLimit) {
        await mutate(id, (current) => ({
          ...current, sourceWatermark: source, stagnation,
          hold: persistentHold(current, { reason: "stagnation", eventID: source.eventID }),
        }));
        await notice(id);
        return;
      }
      const reservation = {
        source, generation: snapshot.generation, workEpoch: controller.workEpoch,
        syntheticID: retryable && previous ? previous.syntheticID : `msg_${randomUUID()}`, status: "reserved" as const,
        attempts: retryable && previous ? previous.attempts + (previous.status === "failed" ? 1 : 0) : 1,
        progress: controller.closedLabels.length,
      };
      const reserved = await store.updateController(id, snapshot, (current) => ({
        ...current, sourceWatermark: source, reservation, stagnation,
        failures: progressed ? 0 : current.failures,
      }));
      if (!committed(reserved)) {
        // A reducer winning the CAS is not a storage fault. Every actual
        // reservation write failure shares mutate's visible recovery fence.
        if (reserved.disposition === "rejected" && reserved.view.status === "ready" &&
          reserved.view.revision !== snapshot.revision) {
          retry = reconsider;
          return;
        }
        store.holdStorage(id, reserved.disposition === "uncertain" ? "uncertain_storage" : "storage_failure");
        await publish({ ...reserved, view: store.storageView(reserved.view) });
        return;
      }
      await publish(reserved);
      if (state.deferred === deferred) state.deferred = undefined;
      // The only dispatch path. No transaction is held across a host call.
      // Workflow/goal eligibility is the LAST await before dispatch: a workflow
      // committed during the snapshot read must veto this reservation too.
      // Fast observations are checked synchronously after that final await.
      for (;;) {
        const latest = await readSnapshot(id);
        const eligible = await options.eligible(id);
        if (latest.status !== "ready" || latest.snapshot.generation !== reservation.generation ||
          latest.snapshot.controller.workEpoch !== reservation.workEpoch ||
          latest.snapshot.controller.reservation?.syntheticID !== reservation.syntheticID ||
          latest.snapshot.controller.hold || !todoCounts(latest.snapshot.phases).open ||
          !eligible || blocked(id, state) || abort.signal.aborted || state.version !== version) {
          await mutate(id, (current) => ({
            ...current, reservation: current.reservation?.syntheticID === reservation.syntheticID
              ? { ...current.reservation, status: "cancelled" } : current.reservation,
          }));
          retry = reconsider;
          return;
        }
        try {
          await session.synthetic({
            sessionID: id, id: reservation.syntheticID,
            text: todoContinuation(latest.snapshot), description: "open-gajae: todo continuation",
            metadata: { source: "open-gajae.todo", generation: reservation.generation,
              workEpoch: reservation.workEpoch, eventID: source.eventID },
            resume: true,
          }, { signal: abort.signal });
        } catch (error) {
          // These declared 2.0.26 endpoint errors reject before enqueue. A
          // ConflictError is intentionally excluded: its fixed ID may already
          // exist. Transport/unexpected status errors are never safe to retry.
          const rejection = z.object({ _tag: z.enum([
            "InvalidRequestError", "UnauthorizedError", "SessionNotFoundError", "LocationNotFoundError",
          ]) }).safeParse(error);
          if (rejection.success) {
            const failed = await mutate(id, (current) => {
              if (current.reservation?.syntheticID !== reservation.syntheticID) return current;
              const failures = current.failures + 1;
              return {
                ...current, failures,
                reservation: { ...current.reservation, status: "failed" },
                hold: failures >= options.settings.failureLimit
                  ? persistentHold(current, { reason: "dispatch_failure", eventID: source.eventID }) : current.hold,
              };
            });
            if (!failed || !committed(failed) || failed.view.status !== "ready") return;
            if (failed.view.hold) { await notice(id); return; }
            if (blocked(id, state) || abort.signal.aborted || state.version !== version) {
              retry = reconsider;
              return;
            }
            const retried = await mutate(id, (current) => ({
              ...current, reservation: current.reservation?.syntheticID === reservation.syntheticID
                ? { ...current.reservation, status: "reserved", attempts: current.reservation.attempts + 1 }
                : current.reservation,
            }));
            if (!retried || !committed(retried)) return;
            continue;
          }
          // An unknown rejection can arrive after native acceptance, including an
          // abort racing the response. Never infer non-delivery from a throw.
          console.warn("[open-gajae:todo] ambiguous continuation delivery", error);
          await mutate(id, (current) => ({
            ...current, reservation: current.reservation?.syntheticID === reservation.syntheticID
              ? { ...current.reservation, status: "uncertain" } : current.reservation,
            hold: persistentHold(current, { reason: "ambiguous_delivery", eventID: source.eventID }),
          }));
          await notice(id);
          return;
        }
        await mutate(id, (current) => ({
          ...current, reservation: current.reservation?.syntheticID === reservation.syntheticID
            ? { ...current.reservation, status: "accepted" } : current.reservation,
        }));
        return;
      }
    } catch (error) {
      console.warn("[open-gajae:todo] recovery/admission failed", error);
      await hold(id, "recovery_error", source);
    } finally {
      if (state.abort === abort) state.abort = undefined;
      const next = state.admission.settle(retry);
      if (next) await resume(id, next.source, next.recovery, next.scope);
    }
  }
  async function contextText(id: string): Promise<string | undefined> {
    if (!options.settings.enabled) return;
    await flush(id);
    await restoreForms(id, true);
    const loaded = await readSnapshot(id);
    if (loaded.status !== "ready") {
      if (loaded.status === "invalid") await invalidStorage(id, loaded.view);
      return;
    }
    await recover(id, loaded.snapshot);
    const current = await readSnapshot(id);
    if (current.status !== "ready") return;
    const reason = store.storageHold(id);
    return todoContext(reason ? {
      ...current.snapshot, controller: { ...current.snapshot.controller, hold: { reason } },
    } : current.snapshot);
  }
  return {
    observe, resume, contextText,
    executionRunning(id: string) {
      return options.settings.enabled ? children.running(id) : undefined;
    },
    async flush(id: string) {
      await flush(id);
      await of(id).formQuery;
      await flush(id);
    },
    async executionOwner(childID: string, parentID: string | undefined) {
      if (disposed || !options.settings.enabled) return;
      if (parentID) parents.set(childID, parentID);
      children.owner(childID, parentID);
      await children.flush();
      if (!disposed && parentID && children.blocked(parentID)) veto(of(parentID));
    },
    async executionForeign(childID: string) {
      if (disposed || !options.settings.enabled) return;
      parents.delete(childID);
      children.foreign(childID);
      await children.flush();
    },
    ownershipChanged: childChanged,
    subagentTool(parentID: string, toolID: string, background: boolean, fresh: boolean) {
      if (options.settings.enabled) children.tool(parentID, toolID, background, fresh);
    },
    async beforeTool(id: string) {
      await flush(id);
      await restoreForms(id);
      if ((await readSnapshot(id)).status === "missing") {
        of(id).initializing = true;
        of(id).initialFence = of(id).fence;
      }
    },
    async afterTool(id: string) {
      const state = of(id);
      if (childStorageHolds.has(id) && !store.storageHold(id)) {
        await children.recover();
        if (!children.failed()) childStorageHolds.delete(id);
      }
      await flush(id);
      await syncForms(id);
      // An explicit start can release a persistent hold, but it cannot answer
      // a still-open form. Re-anchor that transient reason without a budget reset.
      if (state.formsUnknown || state.formsPending > 0 || state.forms.size > 0) {
        recordFormHold(id);
        await flush(id);
      }
      if (!state.initializing) return;
      const initial = state.initialFence;
      state.initializing = false;
      state.initialFence = undefined;
      // The initial board already has its first budget. Consume its creating
      // delivery without giving the next start a second budget for that user.
      await mutate(id, (controller) => {
        const stopped = state.stop && (state.stop === true || !initial || newer(initial, state.stop));
        return {
          ...controller,
          activationFence: controller.activationFence ?? initial ?? null,
          consumedActivationFence: controller.activationFence ? controller.consumedActivationFence : initial ?? null,
          sourceWatermark: stopped && state.stop !== true && state.stop ? state.stop : controller.sourceWatermark,
          hold: stopped ? persistentHold(controller, { reason: "user_stop" }) : controller.hold,
        };
      });
      await notice(id);
    },
    genuineDelivery(id: string, source: TodoSource | undefined) {
      return source !== undefined && of(id).fence?.eventID === source.eventID;
    },
    staleEvent(id: string, source: TodoSource | undefined) {
      const observed = of(id).observedSource;
      return !!source && !!observed && observed.aggregateID === source.aggregateID && observed.seq > source.seq;
    },
    async dispose() {
      disposed = true;
      lifetime.abort();
      for (const state of observations.values()) state.abort?.abort();
      await Promise.all(writes.values());
      await Promise.all(formQueries);
      await Promise.all(notices);
      await children.dispose();
      observations.clear(); parents.clear();
    },
  };
}
