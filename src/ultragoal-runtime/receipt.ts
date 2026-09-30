// Ultragoal completion receipts (`completionVerification`): the shape, the
// stable hashes, and the three validity conditions with the PQ-14 (3)-b
// per-goal exception (plan C-7, D-AG7, 「E2」「E3」). Pure: callers pass the goal
// row and the strictly parsed ledger rows.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/ultragoal-runtime.ts:187-205` (`UltragoalReceiptKind`,
//   `UltragoalCompletionVerification`), `:356-373` (`stableStructuredValue`,
//   `hashStructuredValue`), `:660-742` (`buildCompletionReceipt`)
// - `gjc-runtime/ultragoal-receipt-freshness.ts:392-420`
//   (`validateLedgerAnchoredHistoricalReceipt`) and
//   `gjc-runtime/ultragoal-guard.ts:377-398` (a prior final-aggregate receipt
//   staled by plan growth stands as historical evidence for its own goal)
// Deviation 5 (plan §7.1): the receipt keeps gjc's inner names (PQ-27 A) but
// only `receiptId, receiptKind, criteriaRevision, qualityGateHash,
// checkpointLedgerEventId, verifiedAt`; `criteriaRevision` is open-gajae's
// (deviation 2, E-10). There is no planGeneration basis, batch receipt,
// `goalStatusBeforeCheckpoint`, `gjcGoalMode` or `gjcObjective`. Validity is
// the spec's three conditions (PQ-14 (2)-b, no `plan_created` boundary), and
// the only historical-receipt rule is (3)-b: a final receipt that breaks only
// condition 3 counts as a valid per-goal completion.

import { createHash, randomUUID } from "node:crypto";
import { isRequiredSetChange, type LedgerRow } from "./ledger.js";
import type { Criterion } from "./plan.js";

export type ReceiptKind = "per-goal" | "final-aggregate";

export interface CompletionVerification {
  receiptId: string;
  receiptKind: ReceiptKind;
  criteriaRevision: string;
  qualityGateHash: string;
  checkpointLedgerEventId: string;
  verifiedAt: string;
}

function stableStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableStructuredValue(item));
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item !== undefined) sorted[key] = stableStructuredValue(item);
  }
  return sorted;
}

/** gjc `hashStructuredValue`: sha256 hex of the key-sorted JSON. */
export function hashStructuredValue(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableStructuredValue(value)) ?? "undefined")
    .digest("hex");
}

/** E-10: the hash of the goal's active criteria `[{id, text}]`. */
export function criteriaRevision(criteria: readonly Criterion[]): string {
  return hashStructuredValue(criteria.map((criterion) => ({ id: criterion.id, text: criterion.text })));
}

/** gjc `buildCompletionReceipt` without the planGeneration basis and batch fields. */
export function buildCompletionVerification(input: {
  receiptKind: ReceiptKind;
  criteria: readonly Criterion[];
  gate: unknown;
  checkpointLedgerEventId: string;
  verifiedAt: string;
  receiptId?: string;
}): CompletionVerification {
  return {
    receiptId: input.receiptId ?? randomUUID(),
    receiptKind: input.receiptKind,
    criteriaRevision: criteriaRevision(input.criteria),
    qualityGateHash: hashStructuredValue(input.gate),
    checkpointLedgerEventId: input.checkpointLedgerEventId,
    verifiedAt: input.verifiedAt,
  };
}

const RECEIPT_KEYS = [
  "receiptId",
  "receiptKind",
  "criteriaRevision",
  "qualityGateHash",
  "checkpointLedgerEventId",
  "verifiedAt",
] as const;

/** The schema error of a stored receipt, or undefined (goals.json fails closed). */
export function completionVerificationError(value: unknown, at: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return `${at} must be an object`;
  const record = value as Record<string, unknown>;
  for (const key of RECEIPT_KEYS)
    if (typeof record[key] !== "string" || (record[key] as string).length === 0)
      return `${at}.${key} must be a non-empty string`;
  if (record.receiptKind !== "per-goal" && record.receiptKind !== "final-aggregate")
    return `${at}.receiptKind must be "per-goal" or "final-aggregate"`;
  const unknown = Object.keys(record).filter((key) => !(RECEIPT_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) return `${at} has unknown keys: ${unknown.join(", ")}`;
  return undefined;
}

export type ReceiptCheck =
  | { state: "none" }
  | { state: "stale"; reason: "ledger_mismatch" | "criteria_changed" }
  /** All three conditions hold. `ledgerIndex` is the checkpoint row's position. */
  | { state: "valid"; kind: ReceiptKind; ledgerIndex: number }
  /** PQ-14 (3)-b: a final receipt that breaks only condition 3, valid per-goal. */
  | { state: "superseded-final"; ledgerIndex: number };

/**
 * D-AG7 validity of the goal row's receipt against the ledger:
 * 1. the row receipt equals the receipt on its `goal_checkpointed` row;
 * 2. the goal's current `criteriaRevision` equals the receipt's;
 * 3. a final receipt has no required-set change after its row (E-7).
 */
export function checkReceipt(
  goal: { id: string; acceptanceCriteria: readonly Criterion[]; completionVerification?: CompletionVerification },
  rows: readonly LedgerRow[],
): ReceiptCheck {
  const receipt = goal.completionVerification;
  if (!receipt) return { state: "none" };
  const ledgerIndex = rows.findIndex((row) => row.eventId === receipt.checkpointLedgerEventId);
  const row = rows[ledgerIndex];
  if (
    !row ||
    !("event" in row) ||
    row.event !== "goal_checkpointed" ||
    row.goalId !== goal.id ||
    row.status !== "complete" ||
    hashStructuredValue(row.completionVerification) !== hashStructuredValue(receipt)
  )
    return { state: "stale", reason: "ledger_mismatch" };
  if (criteriaRevision(goal.acceptanceCriteria) !== receipt.criteriaRevision)
    return { state: "stale", reason: "criteria_changed" };
  if (
    receipt.receiptKind === "final-aggregate" &&
    rows.slice(ledgerIndex + 1).some(isRequiredSetChange)
  )
    return { state: "superseded-final", ledgerIndex };
  return { state: "valid", kind: receipt.receiptKind, ledgerIndex };
}

/** Whether the receipt counts as a valid completion (including (3)-b). */
export function isValidCompletion(check: ReceiptCheck): boolean {
  return check.state === "valid" || check.state === "superseded-final";
}

/** The `status` label (plan C-14): valid, per-goal(superseded final), stale, none. */
export function receiptLabel(check: ReceiptCheck): string {
  switch (check.state) {
    case "none":
      return "none";
    case "stale":
      return "stale";
    case "superseded-final":
      return "per-goal(superseded final)";
    case "valid":
      return "valid";
  }
}
