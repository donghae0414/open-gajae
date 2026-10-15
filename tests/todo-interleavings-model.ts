// In-memory driver for the production reducer, not a second implementation of
// child accounting. The independent oracle below knows producing executions.
import {
  childResultDecision, initialChildResultState, restoreChildResultState,
  terminalChildFence, restoreChildFence,
  serializeChildResultState, transitionChildResult,
  type ChildResultAction, type ChildResultState, type ChildTool,
} from "../src/todo/child-result-state";
import {
  createTodoAdmissionFlight, projectChildResultHold, todoObservationBlocked,
  type TodoAdmissionRequest,
} from "../src/todo/continuation-decision";
import { reduceTodo, type TodoSource } from "../src/todo/state";

export type Channel = "foreground" | "background";
export type LifecycleStep = {
  readonly kind: "start" | "end" | "enqueue" | "deliver" | "user-enqueue" | "user-deliver" | "lookup" | "idle" | "parent-start" | "parent-success";
  readonly execution: number;
};

export type AdmissionStep = "start" | "success" | "wake" | "write" | "settle" | "replay";
export function admissionOrders(prefix: readonly AdmissionStep[] = []): AdmissionStep[][] {
  const steps: readonly AdmissionStep[] = ["start", "success", "wake", "write", "settle", "replay"];
  if (prefix.length === steps.length) return [[...prefix]];
  return steps.filter((step) => !prefix.includes(step) &&
    (step !== "success" || prefix.includes("start")) &&
    (step !== "replay" || prefix.includes("success")))
    .flatMap((step) => admissionOrders([...prefix, step]));
}

/** A suspended admission, not a synchronous parent-success shortcut.
 * The production flight scheduler is the subject; revision/version and the
 * accepted-source oracle are independent, bounded host/storage inputs.
 */
export function runPureAdmission(order: readonly AdmissionStep[], recovery: boolean) {
  const flight = createTodoAdmissionFlight();
  const source = (seq: number): TodoSource => ({ eventID: `evt_P_${seq}`, aggregateID: "P", seq });
  let latest = source(1);
  let version = 0;
  let revision = 0;
  let executing = false;
  let suspended = true;
  let active: { request: TodoAdmissionRequest; version: number; revision: number } | undefined;
  const accepted: string[] = [];
  const outcomes: string[] = [];
  function enter(request: TodoAdmissionRequest) {
    if (!flight.enter(request)) return;
    active = { request, version, revision };
    if (!suspended) settle();
  }
  function settle() {
    if (!active) return;
    const attempt = active;
    active = undefined;
    if (attempt.revision !== revision) outcomes.push("cas-lost");
    else if (attempt.version !== version || executing) outcomes.push("cancelled");
    else if (!accepted.includes(attempt.request.source.eventID) &&
      attempt.request.source.seq === latest.seq) {
      accepted.push(attempt.request.source.eventID);
      outcomes.push("committed");
    }
    const next = flight.settle();
    if (next) enter(next);
  }
  enter({ source: latest, recovery });
  for (const step of order) {
    switch (step) {
      case "start": version++; executing = true; break;
      case "success":
        latest = source(3);
        executing = false;
        enter({ source: latest, recovery: false });
        break;
      case "wake": enter({ source: latest, recovery: true }); break;
      case "write": revision++; break;
      case "replay": enter({ source: latest, recovery: false }); break;
      case "settle": suspended = false; settle(); break;
    }
  }
  return { accepted, outcomes, failures: [
    ...(!accepted.includes(latest.eventID) ? ["lost-latest-success"] : []),
    ...(new Set(accepted).size !== accepted.length ? ["duplicate"] : []),
  ] };
}
export type LifecycleOptions = {
  readonly reused: boolean;
  readonly unknownHistory: boolean;
  readonly terminal: "completed" | "error" | "cancelled";
  readonly cancelled: readonly number[];
  readonly checkIdle?: boolean;
  readonly ownership?: {
    readonly resolution: "unknown" | "local" | "foreign";
    readonly boundary: number;
    readonly beforeRestart?: boolean;
  };
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Explicit forget/restart/replay schedules; the oracle never forgets real debt. */
export function runForgetReplay(naive: boolean) {
  let schedules = 0;
  const failures: string[] = [];
  const source = (aggregateID: string, seq: number): TodoSource =>
    ({ aggregateID, seq, eventID: `${aggregateID}_${seq}` });
  const history: ChildResultAction[] = [
    { kind: "created", parentID: "P", source: source("C", 1) },
    { kind: "tool", parentID: "P", toolID: "old", phase: "progress",
      registration: { channel: "background", fresh: true }, source: source("P", 1) },
    { kind: "started", source: source("C", 2) },
    { kind: "ended", source: source("C", 3) },
    { kind: "enqueued", parentID: "P", inboxID: "old", source: source("P", 2) },
    { kind: "delivered", parentID: "P", inboxID: "old", source: source("P", 3) },
  ];
  for (const replay of history) for (const restart of [false, true]) for (const newer of [false, true]) {
    schedules++;
    let state = initialChildResultState("C");
    for (const action of history) state = transitionChildResult(state, action).state;
    // Forget at terminal: a naive implementation loses all fences. The safe
    // implementation retains the empty ledger's history/ownership/watermarks.
    const fence = naive ? undefined : terminalChildFence(state);
    state = fence ? restoreChildFence(structuredClone(fence)) : initialChildResultState("C");
    if (restart) state = restoreChildResultState(serializeChildResultState(state));
    if (newer) {
      state = transitionChildResult(state, { kind: "owner", parentID: "P" }).state;
      state = transitionChildResult(state, { kind: "started", source: source("C", 4) }).state;
    }
    state = transitionChildResult(state, replay).state;
    const decision = childResultDecision([state], "P");
    if (decision.blocked !== newer || (!newer && decision.hold))
      failures.push(`${replay.kind}:restart=${restart}:newer=${newer}:${JSON.stringify(decision)}`);
  }
  return { schedules, failures };
}

export function createPureLifecycle(parent: string, physicallyRunning: (child: string) => boolean) {
  let states = new Map<string, ChildResultState>();
  const durable = new Map<string, string>();
  const fences = new Map<string, string>();
  const tools = new Map<string, ChildTool>();
  const inbox = new Map<string, boolean>();
  const running = new Set<string>();
  const waits = new Map<number, string>();
  const locations = new Map<string, "unknown" | "local" | "foreign">();
  let nextConfirmation = 0;
  let observationsPending = false;
  let resumes = 0;
  const acceptedSources: string[] = [];
  let executing = false;
  let deferred: TodoSource | undefined;
  let controller = reduceTodo(undefined, { op: "init", list: [{ phase: "Work", items: ["A", "B"] }] }, parent).controller;
  let changedHold: string | null | undefined;

  function sync() {
    const next = projectChildResultHold(controller, childResultDecision(states.values(), parent).hold);
    if (next.hold !== controller.hold) changedHold = next.hold?.reason ?? null;
    controller = next;
  }
  function apply(id: string, action: ChildResultAction) {
    const result = transitionChildResult(states.get(id) ?? initialChildResultState(id), action);
    if (result.keep) states.set(id, result.state);
    if (result.write) {
      const fence = terminalChildFence(result.state);
      if (fence) {
        fences.set(id, serializeChildResultState(restoreChildFence(fence)));
        durable.delete(id);
      } else {
        durable.set(id, serializeChildResultState(result.state));
        fences.delete(id);
      }
    }
    if (result.forgetTool && action.kind === "tool") tools.delete(action.toolID);
    if (result.publishParent === parent) sync();
    return result;
  }
  function acknowledge() {
    for (const id of states.keys()) {
      const ticket = ++nextConfirmation;
      const result = apply(id, { kind: "acknowledge", id: ticket, parentID: parent, canWait: true });
      if (!result.wait) continue;
      if (result.wait.running && physicallyRunning(id)) waits.set(ticket, id);
      else apply(id, { kind: "idle", id: ticket });
    }
    if (deferred && waits.size === 0) resume(deferred);
  }
  function resume(source: TodoSource) {
    sync();
    if (running.size > 0 || executing) return;
    const childrenBlocked = childResultDecision(states.values(), parent).blocked || waits.size > 0;
    if (childrenBlocked) deferred = source;
    if (controller.hold || (controller.sourceWatermark &&
      source.seq <= controller.sourceWatermark.seq) ||
      todoObservationBlocked({ disposed: false, observationsPending, storageHeld: false,
        inbox: inbox.size, formsPending: 0, formsUnknown: false, forms: 0, tools: 0,
        childrenBlocked, agent: "open-gajae" })) return;
    resumes++;
    acceptedSources.push(source.eventID);
    deferred = undefined;
    controller = { ...controller, sourceWatermark: source };
    changedHold = controller.hold?.reason ?? null;
  }
  return {
    beforeTool(toolID: string, background: boolean, fresh: boolean) {
      tools.set(toolID, { channel: background ? "background" : "foreground", fresh });
    },
    lookupPending(value: boolean) { observationsPending = value; },
    owner(child: string) { apply(child, { kind: "owner", parentID: parent }); },
    location(child: string, ownership: "unknown" | "local" | "foreign") {
      locations.set(child, ownership);
      if (ownership === "local") apply(child, { kind: "owner", parentID: parent });
      if (ownership === "foreign") {
        apply(child, { kind: "foreign" });
        for (const [ticket, waiting] of waits) if (waiting === child) waits.delete(ticket);
      }
      sync();
      if (deferred) resume(deferred);
    },
    event(type: string, data: Record<string, unknown>, source: TodoSource) {
      const id = data.sessionID;
      if (typeof id !== "string") throw new Error("model event has no session");
      switch (type) {
        case "session.created":
          apply(id, { kind: "created", source, parentID: typeof data.parentID === "string" ? data.parentID : undefined });
          break;
        case "session.execution.started":
          if (id === parent) { deferred = undefined; executing = true; }
          if (id !== parent) {
            apply(id, { kind: "started", source });
            if (!locations.has(id) || locations.get(id) === "local") {
              apply(id, { kind: "owner", parentID: parent });
              running.add(id);
            }
          }
          break;
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          if (id === parent) executing = false;
          if (id !== parent) {
            apply(id, { kind: "ended", source });
            running.delete(id);
          }
          break;
        case "session.tool.progress":
        case "session.tool.success":
        case "session.tool.failed": {
          const metadata = record(data.metadata) ? data.metadata : undefined;
          if (typeof metadata?.sessionID !== "string" || typeof data.id !== "string") break;
          apply(metadata.sessionID, { kind: "tool", parentID: id, toolID: data.id, source,
            registration: tools.get(data.id), phase: type === "session.tool.progress" ? "progress" :
              type === "session.tool.success" && metadata.status === "running" ? "background" : "terminal" });
          break;
        }
        case "session.inbox.enqueued": {
          if (typeof data.inboxID !== "string" || !record(data.item) || !record(data.item.payload)) break;
          const metadata = record(data.item.payload.metadata) ? data.item.payload.metadata : undefined;
          if (id === parent) inbox.set(data.inboxID, data.item.type === "user" && !metadata?.source);
          if (metadata?.source === "subagent" && typeof metadata.childID === "string")
            apply(metadata.childID, { kind: "enqueued", parentID: id, inboxID: data.inboxID, source });
          break;
        }
        case "session.inbox.delivered":
        case "session.inbox.cancelled": {
          if (typeof data.inboxID !== "string") break;
          for (const [child, state] of states)
            if (state.ledger.parentID === id)
              apply(child, { kind: type === "session.inbox.delivered" ? "delivered" : "cancelled",
                parentID: id, inboxID: data.inboxID, source });
          const user = inbox.get(data.inboxID);
          inbox.delete(data.inboxID);
          if (id === parent && user && type === "session.inbox.delivered") acknowledge();
          break;
        }
      }
      if (id === parent) {
        sync();
        if (type === "session.execution.succeeded") resume(source);
      }
    },
    idle(child: string) {
      let completed = false;
      for (const [ticket, waiting] of waits) if (waiting === child) {
        waits.delete(ticket);
        apply(child, { kind: "idle", id: ticket });
        completed = true;
      }
      if (completed && deferred && waits.size === 0) resume(deferred);
      return completed;
    },
    restart() {
      // Exactly the strings the production adapter writes, not a reconstruction
      // from counters. Ephemeral tools, inbox observations and waits are lost.
      states = new Map([...fences, ...durable].map(([id, text]) => [id, restoreChildResultState(text)]));
      tools.clear(); inbox.clear(); running.clear(); waits.clear();
      nextConfirmation = 0;
      deferred = undefined;
      executing = false;
      sync();
    },
    view() { return { resumes, hold: controller.hold?.reason ?? null, changedHold, acceptedSources }; },
  };
}

export function runPureLifecycle(
  order: readonly LifecycleStep[], channels: readonly Channel[], predecessor: boolean, restart: number,
  options?: LifecycleOptions,
): string[] {
  const parent = "ses_parent";
  const children = ["ses_child", options?.reused === false ? "ses_other" : "ses_child"];
  const physical = new Set<number>();
  const outstanding = new Set<number>(predecessor ? [0] : []);
  const waived = new Set<number>();
  const cancelled = new Set<number>();
  const started = new Set<number>();
  const unknown = new Set<string>();
  const released = new Set<string>();
  const hasLookups = order.some((step) => step.kind === "lookup");
  const model = createPureLifecycle(parent, (child) =>
    [...physical].some((execution) => children[execution - 1] === child));
  const sequences = new Map<string, number>();
  const emit = (sessionID: string, type: string, data: Record<string, unknown> = {}) => {
    const seq = (sequences.get(sessionID) ?? 0) + 1;
    sequences.set(sessionID, seq);
    model.event(type, { sessionID, ...data }, { eventID: `evt_${sessionID}_${seq}`, aggregateID: sessionID, seq });
  };
  const observed = "ses_location_observation";
  let locationWaived = false;
  let locationResolved = false;
  let userObserved = false;
  if (options?.ownership) {
    model.location(observed, "unknown");
    emit(observed, "session.execution.started");
    emit(observed, "session.execution.succeeded");
  }
  for (let index = 0; index <= order.length; index++) {
    if (options?.ownership?.beforeRestart && index === options.ownership.boundary) {
      locationResolved = options.ownership.resolution !== "unknown";
      model.location(observed, options.ownership.resolution);
    }
    if (index === restart) {
      const accepted = model.view().resumes;
      model.restart();
      userObserved = false;
      if (model.view().resumes !== accepted) return [`restore${index}`];
    }
    if (options?.ownership && !options.ownership.beforeRestart && index === options.ownership.boundary) {
      locationResolved = options.ownership.resolution !== "unknown";
      model.location(observed, options.ownership.resolution);
    }
    const step = order[index];
    if (!step) break;
    const accepted = model.view().resumes;
    const child = children[Math.max(step.execution - 1, 0)];
    if (!child) throw new Error("missing pure fixture child");
    const toolID = `tool_${step.execution}`;
    const inboxID = `msg_${step.execution}`;
    switch (step.kind) {
      case "parent-start":
        emit(parent, "session.execution.started");
        break;
      case "parent-success":
        emit(parent, "session.execution.succeeded");
        break;
      case "start": {
        if (options?.unknownHistory) unknown.add(child);
        const background = channels[step.execution - 1] === "background";
        model.beforeTool(toolID, background, !(predecessor || options?.unknownHistory ||
          [...started].some((execution) => children[execution - 1] === child)));
        emit(parent, "session.tool.progress", { id: toolID, metadata: { sessionID: child, status: "running" } });
        emit(child, "session.execution.started");
        if (background) emit(parent, "session.tool.success", {
          id: toolID, metadata: { sessionID: child, status: "running" },
        });
        physical.add(step.execution); started.add(step.execution); outstanding.add(step.execution);
        break;
      }
      case "end": {
        emit(child, options?.terminal === "error" ? "session.execution.failed" :
          options?.terminal === "cancelled" ? "session.execution.interrupted" : "session.execution.succeeded");
        physical.delete(step.execution);
        break;
      }
      case "idle": {
        const idle = model.idle(child);
        if (options?.checkIdle && idle && (model.view().hold !== null || model.view().changedHold !== null))
          return ["idle-projection-not-published"];
        break;
      }
      case "enqueue":
        emit(parent, "session.inbox.enqueued", { inboxID, item: { type: "synthetic", payload: {
          text: "result", metadata: { source: "subagent", childID: child, state: options?.terminal ?? "completed" },
        } } });
        break;
      case "deliver":
        if (step.execution === 0 || channels[step.execution - 1] === "background") {
          if (options?.cancelled.includes(step.execution)) {
            emit(parent, "session.inbox.cancelled", { inboxID }); cancelled.add(step.execution);
          } else {
            emit(parent, "session.inbox.delivered", { inboxID }); outstanding.delete(step.execution);
          }
        } else {
          emit(parent, options && options.terminal !== "completed" ? "session.tool.failed" : "session.tool.success", {
            id: toolID, metadata: { sessionID: child, status: options && options.terminal !== "completed" ? "running" : "completed" },
          });
          outstanding.delete(step.execution);
        }
        break;
      case "user-enqueue":
        userObserved = true;
        emit(parent, "session.inbox.enqueued", { inboxID: "msg_user_schedule", item: {
          type: "user", payload: { text: "Continue." },
        } });
        break;
      case "user-deliver":
        if (userObserved) locationWaived = true;
        for (const execution of started)
          if (unknown.has(children[execution - 1] ?? "") || cancelled.has(execution)) waived.add(execution);
        emit(parent, "session.execution.started");
        emit(parent, "session.inbox.delivered", { inboxID: "msg_user_schedule" });
        break;
      case "lookup":
        released.add(child);
        model.owner(child);
        break;
    }
    model.lookupPending(hasLookups && [...started].some((execution) => !released.has(children[execution - 1] ?? "")));
    if (physical.size || [...outstanding].some((execution) => !waived.has(execution))) {
      if (model.view().resumes !== accepted) return [`premature:${step.kind}${step.execution}`];
      if (options && !physical.size && [...cancelled].some((execution) => !waived.has(execution)) &&
        !model.view().hold?.startsWith("child_result")) return [`silent-cancellation:${step.kind}${step.execution}`];
    }
    if (options?.ownership && !locationWaived &&
      !(locationResolved && options.ownership.resolution === "foreign") &&
      model.view().resumes !== accepted) return [`premature-location:${step.kind}`];
  }
  // Observe the natural end, without manufacturing a parent terminal or a
  // fallback user message. Recovery itself must wake idle, unheld open work.
  if (model.view().resumes === 0 && !model.view().hold?.startsWith("child_result")) return ["silent-final"];
  if (options?.ownership && !locationWaived && options.ownership.resolution !== "foreign" &&
    model.view().hold !== "child_result_ambiguous") return ["silent-location"];
  if (options?.ownership && locationWaived && outstanding.size === 0 && physical.size === 0 &&
    model.view().resumes === 0 && !options.unknownHistory &&
    options.cancelled.length === 0) return ["location-user-not-released"];
  if (new Set(model.view().acceptedSources).size !== model.view().resumes) return ["duplicate-final"];
  return [];
}
