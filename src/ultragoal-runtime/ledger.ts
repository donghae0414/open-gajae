// Ultragoal ledger (`ultragoal/ledger.jsonl`) rules: the event and field
// names, the row envelope, the strict parser every judgement reads and the
// lenient latest-event reader the HUD reads, the required-set-change
// judgement (E-7) and the critic non-OKAY streak (PQ-3). Pure: callers read
// and append the file and pass text or parsed rows in.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/ultragoal-runtime.ts:392-410` (`appendLedger`: `{eventId,
//   ...event, timestamp}`), `:412-428` (`readUltragoalLedger`: every line must
//   parse), `:1274` (`plan_created`), `:1402` (`goal_started`), `:3782-3790`
//   (`goal_checkpointed`), `:3993-3999,4207-4214` (`steering_accepted`),
//   `:4272` (`review_blockers_recorded`), `:4295-4300` (`blocker_classified`),
//   `:4353-4366` (`critic_verdict`), `:5698-5716` (the lenient latest-event
//   read), `:5739-5747` (`{type: "reconcile_failed", error}` rows)
// - `gjc-runtime/ultragoal-receipt-freshness.ts:11-14,113-124`
//   (`CRITIC_VERDICT_EVENT`, `TERMINAL_CRITIC_CEILING`, the non-OKAY count)
// Deviations (plan §7.1):
// - 18: the critic count is a streak, not gjc's run-wide total: non-OKAY
//   `critic_verdict` rows after the last OKAY — a `critic_verdict` OKAY or a
//   final `goal_checkpointed` whose gate `criticReview.verdict` is OKAY (I-17,
//   X-6) — after the release marker and after the last `plan_created`
//   (PQ-3 (1) A, (2)-b). Both termini add up. No hard-stop or override rows.
// - 39: fields and events gjc does not write: `plan_created.description`,
//   `steering_accepted.target/criterionId/after/amendment` (with `kind` =
//   `add|revise|supersede`), and `workflow_handoff{to, reason}`.
// - 5 (E-7): condition 3 of a final receipt is judged by ledger order.
// Not written (PQ-16 C): refused ops, `add_pattern`, read ops (gjc
// `steering_rejected` has no counterpart).

import type { CompletionVerification } from "./receipt.js";
import type { Amendment, GoalStatus } from "./plan.js";

export type SteeringKind = "add" | "revise" | "supersede";
export type SteeringTarget = "goal" | "criterion";
export type BlockerClassification = "resolvable" | "human_blocked";
export type CriticTerminus = "completion" | "pause";
export type CriticVerdict = "OKAY" | "ITERATE" | "REJECT";
export type HandoffTarget = "ralplan" | "deep-interview";

/** gjc `CRITIC_VERDICT_EVENT` and `TERMINAL_CRITIC_CEILING` (D-SF7: 5). */
export const CRITIC_VERDICT_EVENT = "critic_verdict";
export const CRITIC_STREAK_HOLD = 5;

/** The event payloads, without the `eventId`/`timestamp` envelope. */
export type LedgerEventFields =
  | { event: "plan_created"; goalIds: string[]; description: string }
  | { event: "goal_started"; goalId: string }
  | {
      event: "goal_checkpointed";
      goalId: string;
      status: GoalStatus;
      evidence: string;
      qualityGateJson?: unknown;
      completionVerification?: CompletionVerification;
    }
  | {
      event: "steering_accepted";
      kind: SteeringKind;
      target: SteeringTarget;
      goalId: string;
      criterionId?: string;
      after?: string;
      rationale: string;
      evidence: string;
      amendment: Amendment;
    }
  | { event: "review_blockers_recorded"; goalId: string; blockerGoalId: string }
  | {
      event: "blocker_classified";
      classification: BlockerClassification;
      goalId?: string;
      evidence: string;
    }
  | {
      event: "critic_verdict";
      terminus: CriticTerminus;
      verdict: CriticVerdict;
      evidence: string;
      blockers: string[];
      classificationEventId?: string;
      goalId?: string;
    }
  | { event: "workflow_handoff"; to: HandoffTarget; reason: string };

export type LedgerEventName = LedgerEventFields["event"];
export const LEDGER_EVENTS: readonly LedgerEventName[] = [
  "plan_created",
  "goal_started",
  "goal_checkpointed",
  "steering_accepted",
  "review_blockers_recorded",
  "blocker_classified",
  "critic_verdict",
  "workflow_handoff",
];

type Envelope = { eventId: string; timestamp: string };
export type LedgerEvent = LedgerEventFields & Envelope;
/** gjc reconcile-failure audit row (DR-20): keyed by `type`, not `event`. */
export type ReconcileFailedRow = Envelope & { type: "reconcile_failed"; error: string };
export type LedgerRow = LedgerEvent | ReconcileFailedRow;

/** gjc `appendLedger` order: `{eventId, ...event, timestamp}`. */
export function ledgerRow<T extends LedgerEventFields | { type: "reconcile_failed"; error: string }>(
  fields: T,
  envelope: Envelope,
): T & Envelope {
  return { eventId: envelope.eventId, ...fields, timestamp: envelope.timestamp } as T & Envelope;
}

/** One JSONL line, without the trailing newline. */
export function serializeLedgerRow(row: LedgerRow): string {
  return JSON.stringify(row);
}

export type LedgerRead = { kind: "valid"; rows: LedgerRow[] } | { kind: "invalid"; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function oneOf(value: unknown, allowed: readonly string[]): boolean {
  return isString(value) && allowed.includes(value);
}

/** The shape error of one known event row, or undefined. */
function eventError(row: Record<string, unknown>): string | undefined {
  switch (row.event) {
    case "plan_created":
      return isStringArray(row.goalIds) ? undefined : "goalIds must be a string array";
    case "goal_started":
      return isString(row.goalId) ? undefined : "goalId must be a string";
    case "goal_checkpointed":
      return isString(row.goalId) && isString(row.status) && isString(row.evidence)
        ? undefined
        : "goalId, status and evidence must be strings";
    case "steering_accepted":
      return oneOf(row.kind, ["add", "revise", "supersede"]) &&
        oneOf(row.target, ["goal", "criterion"]) &&
        isString(row.goalId)
        ? undefined
        : "kind, target and goalId are invalid";
    case "review_blockers_recorded":
      return isString(row.goalId) && isString(row.blockerGoalId)
        ? undefined
        : "goalId and blockerGoalId must be strings";
    case "blocker_classified":
      return oneOf(row.classification, ["resolvable", "human_blocked"]) && isString(row.evidence)
        ? undefined
        : "classification and evidence are invalid";
    case "critic_verdict":
      return oneOf(row.terminus, ["completion", "pause"]) &&
        oneOf(row.verdict, ["OKAY", "ITERATE", "REJECT"]) &&
        isString(row.evidence) &&
        isStringArray(row.blockers)
        ? undefined
        : "terminus, verdict, evidence and blockers are invalid";
    case "workflow_handoff":
      return oneOf(row.to, ["ralplan", "deep-interview"]) && isString(row.reason)
        ? undefined
        : "to and reason are invalid";
    default:
      return `unknown event ${JSON.stringify(row.event)}`;
  }
}

/**
 * The strict reader (DR-19): every non-empty line must be a known event row or
 * a gjc `{type: "reconcile_failed"}` row with a unique `eventId`. Missing text
 * is an empty ledger.
 */
export function parseLedger(text: string | undefined): LedgerRead {
  const rows: LedgerRow[] = [];
  const ids = new Set<string>();
  const lines = (text ?? "").split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const at = `ledger.jsonl line ${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return { kind: "invalid", error: `${at} is not valid JSON` };
    }
    if (!isRecord(value)) return { kind: "invalid", error: `${at} is not a JSON object` };
    if (!isString(value.eventId) || value.eventId.length === 0 || !isString(value.timestamp))
      return { kind: "invalid", error: `${at} needs a string eventId and timestamp` };
    if (ids.has(value.eventId))
      return { kind: "invalid", error: `${at} repeats eventId ${value.eventId}` };
    ids.add(value.eventId);
    if (value.type === "reconcile_failed" && value.event === undefined) {
      if (!isString(value.error)) return { kind: "invalid", error: `${at}: error must be a string` };
      rows.push(value as ReconcileFailedRow);
      continue;
    }
    const error = eventError(value);
    if (error) return { kind: "invalid", error: `${at}: ${error}` };
    rows.push(value as LedgerEvent);
  }
  return { kind: "valid", rows };
}

export type LatestLedgerEvent = {
  event: string;
  goalId?: string;
  timestamp?: string;
  kind?: string;
  evidence?: string;
};

/**
 * gjc reconcile's lenient read: the newest line that parses and names an
 * `event` (or a `type`), unparseable lines skipped.
 */
export function latestLedgerEvent(text: string | undefined): LatestLedgerEvent | undefined {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row)) continue;
    const event = isString(row.event) ? row.event : isString(row.type) ? row.type : undefined;
    if (!event) continue;
    return {
      event,
      ...(row.goalId ? { goalId: String(row.goalId) } : {}),
      ...(row.timestamp ? { timestamp: String(row.timestamp) } : {}),
      ...(isString(row.kind) ? { kind: row.kind } : {}),
      ...(isString(row.evidence) ? { evidence: row.evidence } : {}),
    };
  }
  return undefined;
}

/**
 * E-7: a row that changes the required-goal set — `plan_created`, a goal
 * `add` or `supersede`, or `review_blockers_recorded`. Reviving a superseded
 * goal with `checkpoint(pending)` is not one (PQ-26 A).
 */
export function isRequiredSetChange(row: LedgerRow): boolean {
  if (!("event" in row)) return false;
  if (row.event === "plan_created" || row.event === "review_blockers_recorded") return true;
  return (
    row.event === "steering_accepted" &&
    row.target === "goal" &&
    (row.kind === "add" || row.kind === "supersede")
  );
}

/** X-6: a critic OKAY, or a final checkpoint whose gate carries critic OKAY. */
export function isCriticOkay(row: LedgerRow): boolean {
  if (!("event" in row)) return false;
  if (row.event === "critic_verdict") return row.verdict === "OKAY";
  if (row.event !== "goal_checkpointed" || row.status !== "complete") return false;
  if (row.completionVerification?.receiptKind !== "final-aggregate") return false;
  const gate = row.qualityGateJson;
  if (!isRecord(gate) || !isRecord(gate.criticReview)) return false;
  return gate.criticReview.verdict === "OKAY";
}

/**
 * PQ-3 (1) A, (2)-b: non-OKAY `critic_verdict` rows counted back from the end
 * until the last OKAY (X-6), the release marker `resetAfter` (an eventId,
 * itself not counted) or the last `plan_created`.
 */
export function criticNonOkayStreak(rows: readonly LedgerRow[], resetAfter?: string): number {
  let count = 0;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (resetAfter !== undefined && row.eventId === resetAfter) break;
    if (!("event" in row)) continue;
    if (row.event === "plan_created" || isCriticOkay(row)) break;
    if (row.event === CRITIC_VERDICT_EVENT) count += 1;
  }
  return count;
}

/** The id the release marker records: the newest `critic_verdict` row (plan C-9). */
export function lastCriticVerdictId(rows: readonly LedgerRow[]): string | undefined {
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if ("event" in row && row.event === CRITIC_VERDICT_EVENT) return row.eventId;
  }
  return undefined;
}
