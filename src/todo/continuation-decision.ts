// Pure admission/projection decisions shared by the runtime and state-space tests.
import type { TodoController, TodoSource } from "./state.js";

export type TodoAdmissionRequest = {
  readonly source: TodoSource;
  readonly recovery: boolean;
  readonly scope?: { readonly generation: number; readonly workEpoch: number };
};
/** Process-local single-flight scheduling, shared with the interleaving model. */
export function createTodoAdmissionFlight() {
  let active: TodoAdmissionRequest | undefined;
  let pending: TodoAdmissionRequest | undefined;
  function retain(request: TodoAdmissionRequest) {
    if (!pending || (pending.source.aggregateID === request.source.aggregateID &&
      (request.source.seq > pending.source.seq ||
        (request.source.eventID === pending.source.eventID && !request.recovery))))
      pending = request;
  }
  return {
    enter(request: TodoAdmissionRequest): boolean {
      if (active) {
        retain(request);
        return false;
      }
      active = request;
      return true;
    },
    wake() {
      if (active) retain(active);
    },
    settle(retry?: TodoAdmissionRequest): TodoAdmissionRequest | undefined {
      if (retry) retain(retry);
      active = undefined;
      const next = pending;
      pending = undefined;
      return next;
    },
  };
}

export type TodoVetoes = {
  readonly disposed: boolean;
  readonly observationsPending: boolean;
  readonly storageHeld: boolean;
  readonly inbox: number;
  readonly formsPending: number;
  readonly formsUnknown: boolean;
  readonly forms: number;
  readonly tools: number;
  readonly childrenBlocked: boolean;
  readonly agent: string | undefined;
};
export function todoObservationBlocked(vetoes: TodoVetoes): boolean {
  return vetoes.disposed || vetoes.observationsPending || vetoes.storageHeld || vetoes.inbox > 0 ||
    vetoes.formsPending > 0 || vetoes.formsUnknown || vetoes.forms > 0 || vetoes.tools > 0 ||
    vetoes.childrenBlocked || (vetoes.agent !== undefined && vetoes.agent !== "open-gajae");
}
export function isChildResultHold(reason: string | undefined): boolean {
  return reason === "child_result_ambiguous" || reason === "child_result_cancelled";
}
export function projectChildResultHold(controller: TodoController, reason: string | undefined): TodoController {
  const childHold = isChildResultHold(controller.hold?.reason);
  if (reason) {
    if (controller.hold && !childHold) return controller;
    return controller.hold?.reason === reason ? controller : { ...controller, hold: { reason } };
  }
  return childHold ? { ...controller, hold: null } : controller;
}
