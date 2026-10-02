// The pure deep-interview runtime modules (deep-interview revision plan S1,
// §3.6 RT1-RT13): the manifest, the read boundary, the gjc merges, the
// sanitizer, the floor and the derived ambiguity, the input caps, the HUD,
// the messages, the spec slug and the round-record check.
import { expect, test } from "bun:test";
import {
  applyAmbiguityFloorToEnvelope,
  computeAmbiguityFloor,
  deriveRuntimeAmbiguity,
} from "../src/deep-interview-runtime/ambiguity";
import {
  assertEnvelopeInputLimits,
  assertInputWithinLimit,
  assertStructuredResponseWithinLimit,
  MAX_INITIAL_CONTEXT_LENGTH,
  MAX_STRUCTURED_RESPONSE_LENGTH,
  MAX_USER_RESPONSE_LENGTH,
  mergeDeepInterviewEnvelope,
  mergeDeepInterviewRounds,
  mergeEstablishedFacts,
  normalizeForRead,
  sanitizeWritePayload,
  topLevelTranscriptError,
} from "../src/deep-interview-runtime/envelope";
import { buildDeepInterviewHudFromState, deriveDeepInterviewHud } from "../src/deep-interview-runtime/hud";
import {
  DEEP_INTERVIEW_STATES,
  deepInterviewPhasePatchError,
  defaultSpecSlug,
  inputRoundKeys,
  isValidDeepInterviewTransition,
  ROUND_RECORD_REQUIRED,
  roundRecordErrors,
  roundRecordRefusal,
  statePatchFieldError,
} from "../src/deep-interview-runtime/manifest";
import {
  chainRefusal,
  compactionMessage,
  continuationDescription,
  continuationMessage,
  DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE,
  startRefusal,
} from "../src/deep-interview-runtime/messages";
import { INJECTION_MARKERS } from "../src/injection";
import { safeComponent } from "../src/state";

const scored = (round: number, extra: Record<string, unknown> = {}) => ({
  round,
  round_key: `round-${round}`,
  lifecycle: "scored",
  question_text: `q${round}`,
  answer: `a${round}`,
  ambiguity: 0.5,
  scores: { goal: 0.5, constraints: 0.5, criteria: 0.5 },
  ...extra,
});

test("RT1 manifest: three states, three edges plus the same phase; handoff→interviewing and unknown phases refused", () => {
  expect([...DEEP_INTERVIEW_STATES]).toEqual(["interviewing", "handoff", "complete"]);
  for (const [from, to] of [
    ["interviewing", "handoff"],
    ["handoff", "complete"],
    ["interviewing", "complete"],
    ["handoff", "handoff"],
  ])
    expect(isValidDeepInterviewTransition(from!, to!)).toBe(true);
  expect(isValidDeepInterviewTransition("handoff", "interviewing")).toBe(false);
  expect(isValidDeepInterviewTransition("complete", "interviewing")).toBe(false);
  expect(deepInterviewPhasePatchError("handoff", "interviewing")).toBe(
    "invalid deep-interview phase transition from handoff to interviewing",
  );
  expect(deepInterviewPhasePatchError("interviewing", "bogus")).toBe('unknown deep-interview phase "bogus"');
  expect(deepInterviewPhasePatchError("bogus", "complete")).toBeUndefined();
  expect(deepInterviewPhasePatchError("interviewing", "handoff")).toBeUndefined();
});

test("RT2 read boundary: arrays fixed, reserved keys stripped from state, nothing hoisted (PQ-20 C, D-SR8)", () => {
  const read = normalizeForRead({
    current_phase: "interviewing",
    rounds: [{ round_key: "round-1" }],
    threshold: 0.2,
    state: { rounds: "x", skill: "deep-interview", current_phase: "handoff", state: { nested: true }, note: 1 },
  });
  expect(read).toEqual({
    current_phase: "interviewing",
    rounds: [{ round_key: "round-1" }],
    threshold: 0.2,
    state: { rounds: [], established_facts: [], note: 1 },
  });
  // A handed-over file without `state` reads the same way (A2-4).
  expect(normalizeForRead({ skill: "deep-interview", current_phase: "interviewing" })).toEqual({
    skill: "deep-interview",
    current_phase: "interviewing",
    state: { rounds: [], established_facts: [] },
  });
  expect(normalizeForRead(undefined)).toEqual({ state: { rounds: [], established_facts: [] } });
});

test("RT3 round merge: by round_key, scored kept, blank shell fields kept, keyless records verbatim and deduped", () => {
  const merged = mergeDeepInterviewRounds(
    [
      { round_key: "round-1", lifecycle: "scored", question_text: "q1", ambiguity: 0.6 },
      { note: "legacy" },
    ],
    [
      { round_key: "round-1", lifecycle: "answered", question_text: "", ambiguity: 0.4 },
      { note: "legacy" },
      { note: "other" },
      { round: 2, question_id: "qid" },
    ],
  );
  expect(merged).toEqual([
    { round_key: "round-1", lifecycle: "scored", question_text: "q1", ambiguity: 0.4 },
    { note: "legacy" },
    { note: "other" },
    { round: 2, question_id: "qid", round_key: "nointerview::r:2::q:qid" },
  ]);
});

test("RT4 fact merge: field-wise by id, never deleted, disputed and superseded_by kept", () => {
  const facts = mergeEstablishedFacts(
    [
      { id: "f1", statement: "uses bun", round: 1, disputed: false },
      { id: "f2", statement: "web only", round: 2, disputed: false },
    ],
    [
      { id: "f2", disputed: true, superseded_by: "f3" },
      { id: "f3", statement: "web and cli", round: 4, disputed: false },
      { statement: "no id" },
      { statement: "no id" },
    ],
  );
  expect(facts).toEqual([
    { id: "f1", statement: "uses bun", round: 1, disputed: false },
    { id: "f2", statement: "web only", round: 2, disputed: true, superseded_by: "f3" },
    { id: "f3", statement: "web and cli", round: 4, disputed: false },
    { statement: "no id" },
  ]);
});

test("RT5 envelope merge: null deletes, state is never deleted, facts kept unless named, no hoisting inside", () => {
  const existing = {
    skill: "deep-interview",
    threshold: 0.05,
    note: "x",
    state: { initial_idea: "i", rounds: [scored(1)], established_facts: [{ id: "f1" }], type: "greenfield" },
  };
  const merged = mergeDeepInterviewEnvelope(existing, {
    note: null,
    state: { type: null, rounds: [{ round_key: "round-2", round: 2 }] },
  });
  expect(merged.note).toBeUndefined();
  expect(merged.threshold).toBe(0.05);
  expect(merged.state.type).toBeUndefined();
  expect(merged.state.established_facts).toEqual([{ id: "f1" }]);
  expect((merged.state.rounds as unknown[]).length).toBe(2);
  expect(mergeDeepInterviewEnvelope(existing, { state: null }).state.initial_idea).toBe("i");
  // A top-level transcript field is not moved into `state` (the callers refuse it).
  const unmoved = mergeDeepInterviewEnvelope(existing, { current_ambiguity: 0.01 });
  expect(unmoved.state.current_ambiguity).toBeUndefined();
  expect(unmoved.current_ambiguity).toBe(0.01);
  expect(mergeDeepInterviewEnvelope(existing, { state: { established_facts: [] } }).state.established_facts).toEqual([]);
});

test("RT6 write sanitizer: the nine gjc lifecycle keys only (PQ-14 A); top-level transcript fields refused (PQ-20 C)", () => {
  const { payload, ignoredKeys } = sanitizeWritePayload({
    current_phase: "complete",
    active: false,
    skill: "x",
    version: 9,
    state_revision: 1,
    source_state_revision: 1,
    receipt: {},
    updated_at: "t",
    last_applied_draft_id: "d",
    session_id: "s",
    _meta: {},
    spec_path: "p",
    state: { current_phase: "handoff", note: 1 },
  });
  expect(ignoredKeys).toEqual([
    "current_phase",
    "active",
    "skill",
    "version",
    "state_revision",
    "source_state_revision",
    "receipt",
    "updated_at",
    "last_applied_draft_id",
    "state.current_phase",
  ]);
  expect(payload).toEqual({ session_id: "s", _meta: {}, spec_path: "p", state: { current_phase: "handoff", note: 1 } });
  for (const field of [
    "rounds",
    "established_facts",
    "current_ambiguity",
    "ambiguity_floor",
    "topology",
    "ontology_snapshots",
    "auto_researched_rounds",
    "auto_answered_rounds",
    "architect_failures",
  ])
    expect(() => sanitizeWritePayload({ [field]: [] })).toThrow(
      `deep-interview write: ${field} belong inside "state"; resend them as {"state": {…}} (top-level transcript fields are rejected, not moved).`,
    );
  // The `state` op refusal: D-SR9 at both levels; the other top-level
  // transcript fields get write's refusal (DR-14).
  expect(statePatchFieldError({ spec_path: "p", rounds: [], state: { current_ambiguity: 0, topology: {} } })).toBe(
    'deep-interview state cannot set spec_path, rounds, state.current_ambiguity: rounds, facts and ambiguity are written by `deep-interview write` (inside "state"), and the spec fields by `deep-interview spec`.',
  );
  expect(statePatchFieldError({ topology: {} })).toBeUndefined();
  expect(topLevelTranscriptError("state", { topology: {}, rounds: [] }, new Set(["rounds"]))).toBe(
    'deep-interview state: topology belong inside "state"; resend them as {"state": {…}} (top-level transcript fields are rejected, not moved).',
  );
  expect(statePatchFieldError({ state: { topology: {} }, note: 1 })).toBeUndefined();
});

test("RT7 floor: 0.10 per unresolved disputed fact, 0.05 per unscored active component of a confirmed topology, no auto-answer term", () => {
  const state = {
    established_facts: [
      { id: "f1", disputed: true },
      { id: "f2", disputed: true, superseded_by: "f3" },
      { id: "f4", disputed: true, superseded_by: " " },
    ],
    topology: {
      status: "confirmed",
      components: [
        { id: "a", clarity_scores: { goal: 0.5, constraints: 0.5, criteria: 0.5 } },
        { id: "b", clarity_scores: { goal: 0.5 } },
        { id: "c", status: "deferred" },
      ],
    },
    auto_answered_rounds: [1, 2, 3],
    rounds: [scored(1)],
  };
  expect(computeAmbiguityFloor(state)).toEqual({ floor: 0.25, disputed_fact_count: 2, unscored_active_component_count: 1 });
  expect(computeAmbiguityFloor({ ...state, topology: { ...state.topology, status: "proposed" } }).floor).toBe(0.2);
  const many = { established_facts: Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, disputed: true })) };
  expect(computeAmbiguityFloor(many).floor).toBe(1);
  // The latest scored round and the current value are clamped; the reported value is kept.
  const applied = applyAmbiguityFloorToEnvelope({ state: { ...state, current_ambiguity: 0.1, rounds: [scored(1, { ambiguity: 0.1 })] } });
  expect(applied.clamped).toBe(true);
  expect(applied.envelope.state.current_ambiguity).toBe(0.25);
  expect((applied.envelope.state.rounds as any[])[0]).toMatchObject({ ambiguity: 0.25, reported_ambiguity: 0.1, ambiguity_floor: 0.25 });
  expect(applied.envelope.state.ambiguity_floor).toEqual({ floor: 0.25, disputed_fact_count: 2, unscored_active_component_count: 1 });
});

test("RT8 derived ambiguity: latest scored round (a later record wins a tie), else the previous value; the model value never survives", () => {
  const derived = deriveRuntimeAmbiguity(
    { state: { current_ambiguity: 0.01, rounds: [scored(1, { ambiguity: 0.7 }), scored(2, { ambiguity: 0.4 }), scored(2, { round_key: "x", ambiguity: 0.3 })] } },
    { state: { current_ambiguity: 1 } },
  );
  expect(derived.state.current_ambiguity).toBe(0.3);
  const unscored = { state: { current_ambiguity: 0.01, rounds: [{ round_key: "round-0", round: 0, lifecycle: "answered" }] } };
  expect(deriveRuntimeAmbiguity(unscored, { state: { current_ambiguity: 1 } }).state.current_ambiguity).toBe(1);
  expect(deriveRuntimeAmbiguity(unscored, {}).state.current_ambiguity).toBeUndefined();
  // A non-finite round or ambiguity is not evidence.
  const invalid = { state: { rounds: [{ ...scored(3), ambiguity: "0.1" }] } };
  expect(deriveRuntimeAmbiguity(invalid, { state: { current_ambiguity: 0.8 } }).state.current_ambiguity).toBe(0.8);
});

test("RT9 caps: idea 50k, answer 10k and a spec body 100k in NFC code points; structured input 100k serialized code points", () => {
  const decomposed = "한".normalize("NFD");
  expect(decomposed.length).toBe(3);
  // 50k decomposed syllables are 50k NFC code points: within the cap.
  expect(() => assertInputWithinLimit(decomposed.repeat(MAX_INITIAL_CONTEXT_LENGTH), MAX_INITIAL_CONTEXT_LENGTH, "initial_idea")).not.toThrow();
  expect(() => assertInputWithinLimit("a".repeat(MAX_INITIAL_CONTEXT_LENGTH + 1), MAX_INITIAL_CONTEXT_LENGTH, "initial_idea")).toThrow(
    "initial_idea exceeds max length 50000",
  );
  expect(() => assertInputWithinLimit(decomposed.repeat(MAX_STRUCTURED_RESPONSE_LENGTH), MAX_STRUCTURED_RESPONSE_LENGTH, "spec")).not.toThrow();
  expect(() =>
    assertEnvelopeInputLimits({ state: { rounds: [{ answer: "a".repeat(MAX_USER_RESPONSE_LENGTH + 1) }] } }),
  ).toThrow("state.rounds[0].answer exceeds max length 10000");
  expect(() => assertEnvelopeInputLimits({ state: { rounds: [{ answer: { structured: true } }] } })).not.toThrow();
  // Serialized JSON is counted without NFC: decomposed text costs more here.
  expect(() => assertStructuredResponseWithinLimit({ x: "a".repeat(MAX_STRUCTURED_RESPONSE_LENGTH) }, "input")).toThrow(
    "input exceeds max length 100000",
  );
  expect(() => assertStructuredResponseWithinLimit({ x: decomposed.repeat(40_000) }, "input")).toThrow("exceeds max length");
  expect(() => assertStructuredResponseWithinLimit({ x: Number.NaN }, "input")).toThrow("not a valid structured");
});

test("RT10 HUD: six chips plus empty gate chips, cur%/thr%, legacy_missing topology omits target and weakest", () => {
  const envelope = {
    current_phase: "interviewing",
    threshold: 0.05,
    state: {
      current_ambiguity: 0.42,
      rounds: [scored(1), scored(2)],
      topology: {
        status: "confirmed",
        last_targeted_component_id: "api",
        components: [
          { id: "ui", weakest_dimension: "criteria" },
          { id: "api", weakest_dimension: "constraints" },
        ],
      },
    },
  };
  const hud = deriveDeepInterviewHud(envelope, { specStatus: "persisted", updatedAt: "2026-10-02T00:00:00.000Z" });
  expect(hud).toEqual({
    version: 1,
    chips: [
      { label: "phase", value: "interviewing", priority: 10 },
      { label: "ambiguity", value: "42%/5%", priority: 20 },
      { label: "round", value: "2", priority: 30 },
      { label: "target", value: "api", priority: 40 },
      { label: "weakest", value: "constraints", priority: 50 },
      { label: "spec", value: "persisted", priority: 60 },
    ],
    updated_at: "2026-10-02T00:00:00.000Z",
  });
  const legacy = deriveDeepInterviewHud({ ...envelope, state: { ...envelope.state, topology: { ...envelope.state.topology, status: "legacy_missing" } } });
  expect(legacy.chips!.map((c) => c.label)).toEqual(["phase", "ambiguity", "round"]);
  // A handed-over file without `state`: phase and round 0 (the read boundary).
  expect(buildDeepInterviewHudFromState({ current_phase: "interviewing" }, "t").chips).toEqual([
    { label: "phase", value: "interviewing", priority: 10 },
    { label: "round", value: "0", priority: 30 },
  ]);
});

test("RT11 messages: guard, chain refusal, start refusal's three ways, continuation (N/2), compaction", () => {
  expect(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE).toStartWith("Deep-interview phase boundary:");
  expect(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE).toContain("`deep-interview spec`");
  expect(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE).toContain("`deep-interview clear`");
  expect(chainRefusal("interviewing", "ralplan")).toBe(
    'open-gajae: refusing to chain from "deep-interview" (phase=interviewing) into "ralplan". Persist the spec with deep-interview spec, then call deep-interview handoff(to: "ralplan"), or clear the interview first.',
  );
  const refusal = startRefusal("ralplan", "architect");
  expect(refusal).toContain("ralplan is the active workflow (phase architect)");
  for (const way of ['ultragoal handoff(to: "deep-interview", reason)', 'ralplan handoff(to: "deep-interview")', "ralplan clear"])
    expect(refusal).toContain(way);
  for (const count of [1, 2]) {
    const text = continuationMessage(count);
    expect(text).toStartWith("<deep-interview-continuation>");
    expect(text).toContain(`(Continuation ${count}/2 for this prompt)`);
    expect(text).toContain("`question`");
    expect(text).toContain("`deep-interview write`");
    expect(continuationDescription(count)).toBe(`open-gajae: deep-interview continuation ${count}/2`);
  }
  const compaction = compactionMessage({ phase: "interviewing", rounds: 3, ambiguity: 0.31, threshold: 0.05, target: "api", weakest: "criteria", specPath: "/s.md" });
  expect(compaction).toStartWith("<deep-interview-compaction-context>");
  for (const line of ["phase interviewing", "rounds: 3", "ambiguity: 31% (threshold 5%)", "target: api", "weakest: criteria", "spec: /s.md", "`deep-interview status`"])
    expect(compaction).toContain(line);
  for (const marker of ["<deep-interview-continuation>", "<deep-interview-compaction-context>"])
    expect(INJECTION_MARKERS as readonly string[]).toContain(marker);
});

test("RT12 spec slug: UTC YYYY-MM-DD-HHMM-<4hex>, a safe path component", () => {
  const slug = defaultSpecSlug(new Date("2026-10-02T23:59:00.000Z"));
  expect(slug).toMatch(/^2026-10-02-2359-[0-9a-f]{4}$/);
  expect(safeComponent(slug, "slug")).toBe(slug);
  for (const bad of ["a/b", "..", "x".repeat(65), ".hidden"])
    expect(() => safeComponent(bad, "slug")).toThrow(`invalid path component for slug: ${bad}`);
});

test("RT13 round records: required fields, round_key, lifecycle, ranges, brownfield context, Round 0, delta, all errors at once", () => {
  expect([...ROUND_RECORD_REQUIRED]).toEqual([
    "round",
    "round_key",
    "lifecycle",
    "question_text",
    "answer",
    "ambiguity",
    "scores.goal",
    "scores.constraints",
    "scores.criteria",
  ]);
  expect(roundRecordErrors([scored(1)], ["round-1"], false)).toEqual([]);
  const bad = [
    { round: 3, round_key: "round-2", lifecycle: "scored", question_text: "q", answer: "a", ambiguity: 0.5, scores: { goal: 0.5, constraints: 0.5, criteria: 0.5 } },
    { round_key: "round-4", round: 4, question_text: "q", answer: "a", ambiguity: 1.5, scores: { goal: -1, constraints: 0.5 } },
    { round_key: "round-5", round: 5, lifecycle: "answered", answer: "", ambiguity: 0.5, scores: { goal: 0.5, constraints: 0.5, criteria: 0.5 } },
  ];
  expect(roundRecordErrors(bad, ["round-2", "round-4", "round-5"], false)).toEqual([
    "round 3 (round-2): round_key",
    "round 4 (round-4): lifecycle, ambiguity, scores.goal, scores.criteria",
    "round 5 (round-5): lifecycle, question_text, answer",
  ]);
  // Brownfield (PQ-32 A) needs scores.context; greenfield or no type does not.
  expect(roundRecordErrors([scored(1)], ["round-1"], true)).toEqual(["round 1 (round-1): scores.context"]);
  expect(roundRecordErrors([scored(1, { scores: { goal: 0, constraints: 0, criteria: 0, context: 1 } })], ["round-1"], true)).toEqual([]);
  // Round 0 (PQ-33 A): round_key "round-0" or round 0, answered is fine.
  expect(roundRecordErrors([{ round_key: "round-0", round: 0, lifecycle: "answered", question_text: "q", answer: "a" }], ["round-0"], true)).toEqual([]);
  expect(roundRecordErrors([{ round_key: "zero", round: 0, answer: "a" }], ["zero"], false)).toEqual(["round 0 (zero): round_key, question_text"]);
  // Only the touched records are checked, after the merge (PQ-31 B).
  const merged = mergeDeepInterviewRounds([scored(1), { round_key: "round-2", round: 2 }], [{ round_key: "round-1", ambiguity: 0.2 }]);
  expect(roundRecordErrors(merged, ["round-1"], false)).toEqual([]);
  // Input entries without a string round_key are named by position (C4-6).
  expect(inputRoundKeys({ state: { rounds: [{ round_key: "round-1" }, { round: 2 }, "x", { round_key: "  " }] } })).toEqual({
    keys: ["round-1"],
    errors: [
      'state.rounds[1]: round_key (a string such as "round-1") is required',
      'state.rounds[2]: round_key (a string such as "round-1") is required',
      'state.rounds[3]: round_key (a string such as "round-1") is required',
    ],
  });
  expect(inputRoundKeys({ state: { rounds: {} } }).errors).toEqual(["state.rounds: must be an array of round records"]);
  expect(inputRoundKeys({ state: { note: 1 } })).toEqual({ keys: [], errors: [] });
  const text = roundRecordRefusal(["round 3 (round-2): round_key"]);
  expect(text).toStartWith("deep-interview write: round records do not match the required shape, so nothing was written:");
  expect(text).toContain("- round 3 (round-2): round_key");
  expect(text.split("\n").at(-1)).toContain("deep-interview skill, Phase 2");
});
