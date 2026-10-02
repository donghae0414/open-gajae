// The deep-interview envelope: the one read boundary every deep-interview
// reader uses, gjc's lossless round, fact and envelope merges, the `write`
// payload sanitizer, and the input caps (deep-interview revision plan C-2,
// C-4, DR-5, DR-7). Pure.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/deep-interview-state.ts:111-113`
//   (`canonicalizeDeepInterviewText`), `:200-244`
//   (`normalizeDeepInterviewEnvelope`, without the hoisting), `:250-341`
//   (`durableRoundKey`, `deepEqual`, `mergeRoundPair`,
//   `mergeDeepInterviewRounds`), `:353-410` (`mergeDeepInterviewEnvelope`,
//   without the intent-contract branch and the unused `replace` option),
//   `:450-547` (input caps: `deepInterviewCharacterCount`,
//   `assertDeepInterviewStructuredResponseWithinLimit`,
//   `assertDeepInterviewInputWithinLimit`,
//   `assertDeepInterviewEnvelopeInputLimits`)
// - `gjc-runtime/deep-interview-stage.ts:202-231` (`sanitizeStagedPayload`,
//   without the recorder-owned intent keys), `:394-416`
//   (`mergeEstablishedFacts`)
// Deviation 25 (D-SR8, PQ-20 C): there is no legacy hoisting. The read
// boundary only fixes the arrays and strips envelope keys from `state`, and a
// payload with a top-level transcript field is refused instead of moved.

import {
  ENVELOPE_RESERVED_STATE_KEYS,
  RUNTIME_OWNED_ENVELOPE_KEYS,
  TRANSCRIPT_STATE_FIELDS,
} from "./manifest.js";

type Json = Record<string, unknown>;

/** A deep-interview mode-state: the envelope with the interview under `state`. */
export type DeepInterviewEnvelope = Json & { state: Json };

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Plan C-2 `normalizeForRead`: `state` is an object with array `rounds` and
 * `established_facts`, and carries no envelope-reserved key. Nothing moves
 * from the top level (D-SR8). Never mutates its input.
 */
export function normalizeForRead(value: unknown): DeepInterviewEnvelope {
  const envelope: Json = isRecord(value) ? { ...value } : {};
  const inner: Json = isRecord(envelope.state) ? { ...envelope.state } : {};
  for (const field of ENVELOPE_RESERVED_STATE_KEYS) if (field in inner) delete inner[field];
  if (!Array.isArray(inner.rounds)) inner.rounds = [];
  if (!Array.isArray(inner.established_facts)) inner.established_facts = [];
  envelope.state = inner;
  return envelope as DeepInterviewEnvelope;
}

/** gjc `deriveRoundKey` without an interview id. */
function derivedRoundKey(input: { round_id?: string; round: number; questionId?: string }): string {
  if (input.round_id && input.round_id.trim() !== "") return `nointerview::rid:${input.round_id}`;
  return `nointerview::r:${input.round}::q:${input.questionId ?? "noqid"}`;
}

/** gjc `durableRoundKey`: the merge key, or `undefined` when the record has none. */
function durableRoundKey(record: Json): string | undefined {
  if (nonEmptyString(record.round_key)) return record.round_key;
  const hasId = nonEmptyString(record.round_id) || nonEmptyString(record.question_id);
  if (!hasId) return undefined;
  return derivedRoundKey({
    round_id: nonEmptyString(record.round_id) ? record.round_id : undefined,
    round: typeof record.round === "number" ? record.round : 0,
    questionId: nonEmptyString(record.question_id) ? record.question_id : undefined,
  });
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

/** gjc `mergeRoundPair`: later fields win; `scored` never goes back. */
function mergeRoundPair(existing: Json, incoming: Json): Json {
  const merged: Json = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  if (existing.lifecycle === "scored" && incoming.lifecycle !== "scored") merged.lifecycle = "scored";
  for (const field of ["question_hash", "answer_hash", "question_text"])
    if (!nonEmptyString(incoming[field]) && nonEmptyString(existing[field])) merged[field] = existing[field];
  return merged;
}

/**
 * gjc `mergeDeepInterviewRounds`: records sharing a durable key merge into
 * one; records without one are kept verbatim, exact duplicates skipped.
 */
export function mergeDeepInterviewRounds(existing: readonly Json[], incoming: readonly Json[]): Json[] {
  const result: Json[] = [];
  const indexByKey = new Map<string, number>();
  const add = (record: Json): void => {
    const key = durableRoundKey(record);
    if (key !== undefined) {
      const existingIndex = indexByKey.get(key);
      if (existingIndex === undefined) {
        indexByKey.set(key, result.length);
        result.push(nonEmptyString(record.round_key) ? { ...record } : { ...record, round_key: key });
      } else {
        result[existingIndex] = mergeRoundPair(result[existingIndex] as Json, record);
      }
      return;
    }
    if (result.some((item) => deepEqual(item, record))) return;
    result.push({ ...record });
  };
  for (const record of existing) if (isRecord(record)) add(record);
  for (const record of incoming) if (isRecord(record)) add(record);
  return result;
}

function asRecordArray(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * gjc `mergeDeepInterviewEnvelope`: top-level keys merge with `null`
 * deleting; `state` is never deleted and merges shallowly (`null` deletes a
 * key); `rounds` merge by durable key; `established_facts` are replaced only
 * when the input names them. Both sides pass the read boundary first.
 */
export function mergeDeepInterviewEnvelope(existing: unknown, incoming: unknown): DeepInterviewEnvelope {
  const incomingEnvelope = isRecord(incoming) ? incoming : {};
  const incomingNestedState = isRecord(incomingEnvelope.state) ? incomingEnvelope.state : {};
  const incomingHasEstablishedFacts = Object.hasOwn(incomingNestedState, "established_facts");
  const normalizedIncoming = normalizeForRead(incoming);
  const normalizedExisting = normalizeForRead(existing);
  const existingState = normalizedExisting.state;
  const incomingState = { ...normalizedIncoming.state };

  const merged: Json = {};
  for (const [key, value] of Object.entries(normalizedExisting)) if (key !== "state") merged[key] = value;
  for (const [key, value] of Object.entries(normalizedIncoming)) {
    if (key === "state") continue;
    if (value === null) delete merged[key];
    else merged[key] = value;
  }

  const mergedState: Json = { ...existingState };
  for (const [key, value] of Object.entries(incomingState)) {
    if (key === "rounds") continue;
    if (key === "established_facts" && !incomingHasEstablishedFacts) continue;
    if (value === null) delete mergedState[key];
    else mergedState[key] = value;
  }
  mergedState.rounds = mergeDeepInterviewRounds(
    asRecordArray(existingState.rounds),
    asRecordArray(incomingState.rounds),
  );
  merged.state = mergedState;
  return merged as DeepInterviewEnvelope;
}

/**
 * gjc `mergeEstablishedFacts`: facts with an `id` merge field-wise by id;
 * facts without one are appended, exact duplicates skipped. A delta never
 * deletes a fact: dispute or supersede it instead.
 */
export function mergeEstablishedFacts(existing: readonly unknown[], incoming: readonly unknown[]): Json[] {
  const result: Json[] = [];
  const indexById = new Map<string, number>();
  const add = (value: unknown): void => {
    if (!isRecord(value)) return;
    const id = typeof value.id === "string" && value.id.trim() !== "" ? value.id : undefined;
    if (id !== undefined) {
      const existingIndex = indexById.get(id);
      if (existingIndex === undefined) {
        indexById.set(id, result.length);
        result.push({ ...value });
      } else {
        result[existingIndex] = { ...result[existingIndex], ...value };
      }
      return;
    }
    if (result.some((item) => JSON.stringify(item) === JSON.stringify(value))) return;
    result.push({ ...value });
  };
  for (const fact of existing) add(fact);
  for (const fact of incoming) add(fact);
  return result;
}

/**
 * The refusal for a payload with top-level transcript fields (PQ-20 C);
 * `skip` leaves out fields another refusal names.
 */
export function topLevelTranscriptError(
  op: "write" | "state",
  payload: Json,
  skip: ReadonlySet<string> = new Set(),
): string | undefined {
  const named = TRANSCRIPT_STATE_FIELDS.filter((field) => Object.hasOwn(payload, field) && !skip.has(field));
  if (named.length === 0) return undefined;
  return `deep-interview ${op}: ${named.join(", ")} belong inside "state"; resend them as {"state": {…}} (top-level transcript fields are rejected, not moved).`;
}

/**
 * gjc `sanitizeStagedPayload` for `write`: the nine runtime-owned envelope
 * keys are dropped and reported (PQ-14 A), envelope keys inside `state` are
 * reported by name and left for the read boundary, and a top-level
 * transcript field refuses the whole payload (PQ-20 C).
 */
export function sanitizeWritePayload(payload: Json): { payload: Json; ignoredKeys: string[] } {
  const transcriptError = topLevelTranscriptError("write", payload);
  if (transcriptError) throw new Error(transcriptError);
  const next: Json = { ...payload };
  const ignoredKeys: string[] = [];
  for (const key of RUNTIME_OWNED_ENVELOPE_KEYS) {
    if (key in next) {
      delete next[key];
      ignoredKeys.push(key);
    }
  }
  if (isRecord(next.state))
    for (const key of ENVELOPE_RESERVED_STATE_KEYS) if (key in next.state) ignoredKeys.push(`state.${key}`);
  return { payload: next, ignoredKeys };
}

// ---------------------------------------------------------------------------
// Input caps (spec D-SR11, plan DR-7)
// ---------------------------------------------------------------------------

export const MAX_INITIAL_CONTEXT_LENGTH = 50_000;
export const MAX_USER_RESPONSE_LENGTH = 10_000;
/** One structured response: a `write` input, a `state` patch, a spec body. */
export const MAX_STRUCTURED_RESPONSE_LENGTH = 100_000;

/** gjc `canonicalizeDeepInterviewText`: NFC, so decomposed Hangul counts fairly. */
export function canonicalizeText(value: string): string {
  return value.normalize("NFC");
}

/** gjc `deepInterviewCharacterCount`: Unicode code points. */
export function characterCount(value: string): number {
  let count = 0;
  for (const _character of value) count++;
  return count;
}

/**
 * gjc `assertDeepInterviewStructuredResponseWithinLimit`: JSON-serializable,
 * at most 100k code points of serialized JSON (no NFC).
 */
export function assertStructuredResponseWithinLimit(value: unknown, fieldName: string): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (
        typeof nestedValue === "bigint" ||
        typeof nestedValue === "function" ||
        typeof nestedValue === "symbol" ||
        (typeof nestedValue === "number" && !Number.isFinite(nestedValue))
      )
        throw new Error("invalid structured deep-interview response");
      return nestedValue;
    });
  } catch {
    throw new Error(`${fieldName} is not a valid structured deep-interview response`);
  }
  if (typeof serialized !== "string")
    throw new Error(`${fieldName} is not a valid structured deep-interview response`);
  if (characterCount(serialized) > MAX_STRUCTURED_RESPONSE_LENGTH)
    throw new Error(`${fieldName} exceeds max length ${MAX_STRUCTURED_RESPONSE_LENGTH}`);
}

/** gjc `assertDeepInterviewInputWithinLimit`: NFC code points. */
export function assertInputWithinLimit(value: unknown, max: number, fieldName: string): void {
  if (typeof value !== "string") throw new Error(`${fieldName} must be a string`);
  if (characterCount(canonicalizeText(value)) > max) throw new Error(`${fieldName} exceeds max length ${max}`);
}

/**
 * gjc `assertDeepInterviewEnvelopeInputLimits`: the prose fields of an
 * envelope (the idea and context at 50k, the answers at 10k).
 */
export function assertEnvelopeInputLimits(envelope: Json): void {
  const state = isRecord(envelope.state) ? envelope.state : {};
  for (const field of ["initial_idea", "initial_context", "initial_context_summary"] as const) {
    const nestedValue = state[field];
    if (nestedValue !== undefined && nestedValue !== null)
      assertInputWithinLimit(nestedValue, MAX_INITIAL_CONTEXT_LENGTH, `state.${field}`);
    const topLevelValue = envelope[field];
    if (topLevelValue !== undefined && topLevelValue !== null)
      assertInputWithinLimit(topLevelValue, MAX_INITIAL_CONTEXT_LENGTH, field);
  }
  for (const field of ["user_response", "answer"] as const) {
    const nestedValue = state[field];
    if (nestedValue !== undefined && nestedValue !== null)
      assertInputWithinLimit(nestedValue, MAX_USER_RESPONSE_LENGTH, `state.${field}`);
    const topLevelValue = envelope[field];
    if (topLevelValue !== undefined && topLevelValue !== null)
      assertInputWithinLimit(topLevelValue, MAX_USER_RESPONSE_LENGTH, field);
  }
  if (!Array.isArray(state.rounds)) return;
  for (const [index, round] of state.rounds.entries()) {
    if (!isRecord(round)) continue;
    for (const field of ["custom_input", "customInput", "user_response", "answer"] as const) {
      const value = round[field];
      if (value === undefined || value === null || (field === "answer" && typeof value !== "string")) continue;
      assertInputWithinLimit(value, MAX_USER_RESPONSE_LENGTH, `state.rounds[${index}].${field}`);
    }
  }
}
