// Original, deterministic child-result state machine. Only `ledger` is durable;
// idle subscriptions belong to one observer instance and are never serialized.
import { z } from "zod";
import { todoSourceSchema, type TodoSource } from "./state.js";

const executionSchema = z.strictObject({
  start: todoSourceSchema.nullable(),
  running: z.boolean(),
  restored: z.boolean(),
  waived: z.boolean(),
  waivedBy: z.array(z.string()).optional(),
  channel: z.enum(["foreground", "background"]),
  inboxID: z.string().nullable(),
  toolID: z.string().nullable(),
});
export const childLedgerSchema = z.strictObject({
  schemaVersion: z.literal(1), sessionID: z.string(),
  parentID: z.string().nullable().optional(),
  ownership: z.enum(["local", "foreign"]).optional(),
  acknowledgedBy: z.array(z.string()).optional(),
  historyKnown: z.boolean(),
  prefixAcknowledged: z.boolean(),
  watermarks: z.array(todoSourceSchema),
  executions: z.array(executionSchema),
  results: z.array(z.strictObject({
    inboxID: z.string(), disposition: z.enum(["pending", "delivered", "cancelled"]), acknowledged: z.boolean(),
  })),
  nextTool: z.strictObject({ id: z.string(), channel: z.enum(["foreground", "background"]) }).nullable(),
});
export type ChildLedger = z.infer<typeof childLedgerSchema>;
export const childFenceSchema = childLedgerSchema.omit({ executions: true, results: true, nextTool: true });
export const childFencesSchema = z.record(z.string(), childFenceSchema);
export function terminalChildFence({ ledger, acknowledgements }: ChildResultState) {
  if (acknowledgements.size || ledger.executions.length || ledger.nextTool ||
    ledger.results.some((entry) => entry.disposition === "pending" ||
      (entry.disposition === "cancelled" && !entry.acknowledged)) ||
    ledger.parentID === undefined ||
    (ledger.parentID !== null && ledger.ownership !== "foreign" && !ledger.historyKnown && !ledger.prefixAcknowledged))
    return undefined;
  const { executions, results, nextTool, ...fence } = ledger;
  return fence;
}
export function restoreChildFence(fence: z.infer<typeof childFenceSchema>): ChildResultState {
  return { ledger: { ...fence, executions: [], results: [], nextTool: null }, acknowledgements: new Map() };
}
export type ChildTool = { readonly channel: "foreground" | "background"; readonly fresh: boolean };
type Acknowledgement = {
  readonly parentID: string;
  readonly unowned: boolean;
  readonly executions: Set<ChildLedger["executions"][number]>;
  readonly results: Set<ChildLedger["results"][number]>;
};
export type ChildResultState = {
  readonly ledger: ChildLedger;
  readonly acknowledgements: Map<number, Acknowledgement>;
};
type Sourced = { readonly source?: TodoSource | undefined };
export type ChildResultAction =
  | ({ readonly kind: "created"; readonly parentID?: string | undefined } & Sourced)
  | ({ readonly kind: "started" | "ended" } & Sourced)
  | ({ readonly kind: "enqueued" | "delivered" | "cancelled"; readonly parentID: string; readonly inboxID: string } & Sourced)
  | ({ readonly kind: "tool"; readonly parentID: string; readonly toolID: string;
      readonly phase: "progress" | "background" | "terminal"; readonly registration?: ChildTool | undefined } & Sourced)
  | { readonly kind: "owner"; readonly parentID: string | null }
  | { readonly kind: "foreign" }
  | { readonly kind: "acknowledge"; readonly id: number; readonly parentID: string; readonly canWait: boolean }
  | { readonly kind: "idle"; readonly id: number };
export type ChildResultTransition = {
  readonly state: ChildResultState;
  readonly keep: boolean;
  readonly write: boolean;
  readonly forgetTool?: boolean;
  readonly wait?: { readonly id: number; readonly running: boolean };
  readonly publishParent?: string;
};

export function initialChildResultState(sessionID: string): ChildResultState {
  return { ledger: { schemaVersion: 1, sessionID, historyKnown: false, prefixAcknowledged: false,
    watermarks: [], executions: [], results: [], nextTool: null }, acknowledgements: new Map() };
}
export function serializeChildResultState(state: ChildResultState): string {
  return JSON.stringify(state.ledger);
}
export function restoreChildResultState(text: string): ChildResultState {
  const ledger = childLedgerSchema.parse(JSON.parse(text));
  for (const execution of ledger.executions) if (execution.running) execution.restored = true;
  return { ledger, acknowledgements: new Map() };
}

function reconcile(ledger: ChildLedger) {
  if (!ledger.historyKnown) {
    // Waiving a wait does not establish the size of an unknown prefix. Its
    // late outcomes may retire waived slots, but never a newer active slot.
    for (const execution of [...ledger.executions]) {
      if (!execution.waived || execution.channel !== "background") continue;
      const result = ledger.results.find((entry) => entry.disposition !== "pending");
      if (!result) break;
      ledger.executions = ledger.executions.filter((entry) => entry !== execution);
      ledger.results = ledger.results.filter((entry) => entry !== result);
    }
    if (ledger.prefixAcknowledged && ledger.executions.every((entry) => entry.waived))
      ledger.results = ledger.results.filter((entry) => entry.disposition === "pending");
    return;
  }
  for (const execution of [...ledger.executions]) {
    if (execution.channel === "foreground" || (execution.running && !execution.restored)) break;
    const result = execution.inboxID === null
      ? ledger.results.find((entry) => !ledger.executions.some((run) => run.inboxID === entry.inboxID))
      : ledger.results.find((entry) => entry.inboxID === execution.inboxID);
    if (!result) break;
    execution.inboxID = result.inboxID;
    execution.running = false;
    if (result.disposition === "delivered" || (result.disposition === "cancelled" && result.acknowledged)) {
      ledger.executions = ledger.executions.filter((entry) => entry !== execution);
      ledger.results = ledger.results.filter((entry) => entry !== result);
    }
  }
}

export function transitionChildResult(
  previous: ChildResultState, action: ChildResultAction,
): ChildResultTransition {
  // Clone the whole in-memory graph, including acknowledgement references.
  // Shared references remain shared, so an idle reply cannot capture new starts.
  const state = structuredClone(previous);
  const ledger = state.ledger;
  const unchanged = (): ChildResultTransition => ({ state: previous,
    keep: previous.ledger.parentID !== undefined || previous.ledger.executions.length > 0 ||
      previous.ledger.nextTool !== null, write: false });
  // A confirmed foreign session is a durable exclusion, not a local root.
  // Late start, lineage, inbox or tool observations cannot recreate its debt.
  if (ledger.ownership === "foreign") return unchanged();
  if (action.kind === "tool" && !action.registration && ledger.nextTool?.id !== action.toolID &&
    !ledger.executions.some((entry) => entry.toolID === action.toolID)) return unchanged();
  if ((action.kind === "delivered" || action.kind === "cancelled") && (ledger.parentID !== action.parentID ||
    !ledger.results.some((entry) => entry.inboxID === action.inboxID))) return unchanged();
  const source = "source" in action ? action.source : undefined;
  if (source) {
    const prior = ledger.watermarks.find((entry) => entry.aggregateID === source.aggregateID);
    if (action.kind !== "delivered" && prior && prior.seq >= source.seq) return unchanged();
    ledger.watermarks = [...ledger.watermarks.filter((entry) => entry.aggregateID !== source.aggregateID), source];
  }
  let forgetTool = false;
  let publishParent: string | undefined;
  switch (action.kind) {
    case "created":
      ledger.historyKnown = true;
      if (action.parentID !== undefined) ledger.parentID = action.parentID;
      break;
    case "owner":
      ledger.ownership = "local";
      // Omitted lineage is not evidence against an already observed parent.
      ledger.parentID = action.parentID ?? ledger.parentID ?? null;
      break;
    case "foreign":
      ledger.ownership = "foreign";
      ledger.parentID = null;
      ledger.executions = [];
      ledger.results = [];
      ledger.nextTool = null;
      state.acknowledgements.clear();
      break;
    case "started":
      ledger.executions.push({ start: source ?? null, running: true, restored: false, waived: false,
        channel: ledger.nextTool?.channel ?? "background", inboxID: null, toolID: ledger.nextTool?.id ?? null });
      ledger.nextTool = null;
      break;
    case "ended": {
      const execution = ledger.executions.findLast((entry) => entry.running);
      if (execution) execution.running = false;
      break;
    }
    case "enqueued":
      ledger.parentID = action.parentID;
      if (!ledger.results.some((entry) => entry.inboxID === action.inboxID))
        ledger.results.push({ inboxID: action.inboxID, disposition: "pending",
          acknowledged: !ledger.historyKnown && ledger.prefixAcknowledged && ledger.executions.every((entry) => entry.waived) });
      if (ledger.executions.length === 0 && ledger.historyKnown) {
        ledger.historyKnown = false;
        ledger.prefixAcknowledged = false;
      }
      break;
    case "delivered":
    case "cancelled": {
      const result = ledger.results.find((entry) => entry.inboxID === action.inboxID);
      if (result) result.disposition = action.kind;
      break;
    }
    case "tool":
      ledger.parentID = action.parentID;
      if (action.phase === "progress") {
        if (action.registration?.fresh) ledger.historyKnown = true;
        ledger.nextTool = { id: action.toolID,
          channel: action.registration?.channel ?? ledger.nextTool?.channel ?? "foreground" };
      } else {
        forgetTool = true;
        if (action.phase === "background") {
          for (const execution of ledger.executions)
            if (execution.toolID === action.toolID) execution.channel = "background";
          if (ledger.nextTool?.id === action.toolID) ledger.nextTool.channel = "background";
        } else {
          ledger.executions = ledger.executions.filter((entry) =>
            entry.channel !== "foreground" || entry.toolID !== action.toolID);
          if (ledger.nextTool?.id === action.toolID) ledger.nextTool = null;
        }
      }
      break;
    case "acknowledge": {
      const unowned = ledger.parentID === undefined;
      if (!unowned && ledger.parentID !== action.parentID) return unchanged();
      if (unowned && ledger.acknowledgedBy?.includes(action.parentID) &&
        ledger.executions.every((entry) => entry.waivedBy?.includes(action.parentID))) return unchanged();
      const cancelled = ledger.results.some((entry) => entry.disposition === "cancelled" && !entry.acknowledged);
      if (!unowned && ledger.historyKnown && !cancelled) return unchanged();
      if (!unowned && !ledger.historyKnown && ledger.prefixAcknowledged &&
        ledger.executions.every((entry) => entry.waived) && !cancelled) return unchanged();
      const running = ledger.executions.some((entry) => entry.running);
      if (running && !action.canWait) return unchanged();
      state.acknowledgements.set(action.id, {
        parentID: action.parentID, unowned,
        executions: new Set(ledger.executions),
        results: new Set(ledger.historyKnown
          ? ledger.results.filter((entry) => entry.disposition === "cancelled")
          : ledger.results),
      });
      return { state, keep: true, write: false, wait: { id: action.id, running } };
    }
    case "idle": {
      const acknowledged = state.acknowledgements.get(action.id);
      if (!acknowledged) return unchanged();
      if (acknowledged.unowned) {
        ledger.acknowledgedBy = [...new Set([...(ledger.acknowledgedBy ?? []), acknowledged.parentID])];
      }
      const applies = !acknowledged.unowned || ledger.parentID === acknowledged.parentID;
      if (applies && !ledger.historyKnown) ledger.prefixAcknowledged = true;
      for (const execution of ledger.executions) if (acknowledged.executions.has(execution)) {
        execution.running = false; // The owned idle response proves this captured prefix ended.
        if (acknowledged.unowned)
          execution.waivedBy = [...new Set([...(execution.waivedBy ?? []), acknowledged.parentID])];
        if (applies && (!ledger.historyKnown || acknowledged.unowned)) execution.waived = true;
      }
      for (const result of ledger.results) if (acknowledged.results.has(result))
        result.acknowledged = true;
      state.acknowledgements.delete(action.id);
      publishParent = acknowledged.parentID;
      break;
    }
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
  if (typeof ledger.parentID === "string") {
    if (ledger.acknowledgedBy?.includes(ledger.parentID)) ledger.prefixAcknowledged = true;
    for (const execution of ledger.executions)
      if (execution.waivedBy?.includes(ledger.parentID)) execution.waived = true;
  }
  reconcile(ledger);
  if (ledger.parentID === undefined && ledger.executions.length === 0 && ledger.nextTool === null)
    return { state, keep: false, write: false };
  if (ledger.parentID === null) ledger.executions = [];
  return { state, keep: true, write: !!source || action.kind === "tool" ||
    serializeChildResultState(state) !== serializeChildResultState(previous), forgetTool, publishParent };
}

export function childResultDecision(
  states: Iterable<ChildResultState>, parentID: string,
): { readonly blocked: boolean; readonly hold: "child_result_ambiguous" | "child_result_cancelled" | undefined } {
  let blocked = false;
  let hold: "child_result_ambiguous" | "child_result_cancelled" | undefined;
  for (const { ledger, acknowledgements } of states) {
    if (ledger.ownership === "foreign") continue;
    if (ledger.parentID === undefined) {
      // Unknown lineage is a visible, parent-scoped wait. A user's waiver
      // captures only this prefix, never another parent's or a later start.
      if (!ledger.acknowledgedBy?.includes(parentID) ||
        ledger.executions.some((entry) => !entry.waivedBy?.includes(parentID)) ||
        [...acknowledgements.values()].some((entry) => entry.parentID === parentID)) {
        blocked = true;
        hold = "child_result_ambiguous";
      }
      continue;
    }
    const ambiguous = !ledger.historyKnown &&
      (!ledger.prefixAcknowledged || ledger.executions.some((entry) => !entry.waived));
    const cancelled = ledger.results.some((entry) => entry.disposition === "cancelled" && !entry.acknowledged);
    if (ledger.parentID === parentID) {
      if (ambiguous) hold = "child_result_ambiguous";
      else if (cancelled && !hold) hold = "child_result_cancelled";
    }
    if ((ledger.parentID === undefined || ledger.parentID === parentID) &&
      (ledger.executions.some((entry) => !entry.waived) ||
        ledger.results.some((entry) => entry.disposition === "pending") || ambiguous || cancelled || acknowledgements.size > 0))
      blocked = true;
  }
  return { blocked, hold };
}
