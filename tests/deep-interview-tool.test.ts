// The `deep-interview` tool (deep-interview revision plan S2, §3.6 T1-T9):
// ops, actors, the lineage root, start, the gjc write merge with the round
// check, spec and the combined call, handoff, status/doctor/state, clear, and
// refused ops writing nothing. Built directly (registered in S3a), over a
// fake lineage and the real StateStore; the combined call seeds ralplan
// through the real `startRunTx` unless a test swaps the seed.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createDeepInterviewHooks } from "../src/deep-interview-runtime/hooks";
import {
  alreadyCancelledRefusal,
  inactiveStateRefusal,
  noStateRefusal,
  handedOffToRalplan,
  handedOffToUltragoal,
  resumeRefusal,
} from "../src/deep-interview-runtime/messages";
import type { DeepInterviewSettings, SeedRalplanTx } from "../src/deep-interview-runtime/store";
import { DEEP_INTERVIEW_OPS, deepInterviewTool } from "../src/deep-interview-runtime/tool";
import { startRunTx } from "../src/ralplan-runtime/store";
import { readVisiblePrimaryTx } from "../src/skill-state/rows";
import { StateStore, type WorkflowTx } from "../src/state";
import { createTools } from "../src/tools";

const T0 = Date.parse("2026-10-02T00:00:00.000Z");
const ROOT = "ses_root";
const LINEAGE: Record<string, string> = { [ROOT]: ROOT, ses_child: ROOT };
const DI = "deep-interview-state.json";

type Call = (args: Record<string, unknown>, agent?: string, sessionID?: string) => Promise<string>;
type Harness = {
  store: StateStore;
  root: string;
  call: Call;
  run: <T>(fn: (tx: WorkflowTx) => Promise<T>) => Promise<T>;
  file: (...parts: string[]) => string;
  json: (...parts: string[]) => Promise<any>;
  exists: (...parts: string[]) => Promise<boolean>;
  audit: () => Promise<any[]>;
  /** Every file under the session folder, path → content. */
  tree: () => Promise<Record<string, string>>;
};

async function fixture(
  body: (h: Harness) => Promise<void>,
  options: { settings?: DeepInterviewSettings; seed?: (projectDir: string) => SeedRalplanTx } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "open-gajae-di-tool-")));
  try {
    const store = new StateStore(root, async () => T0);
    const seed: SeedRalplanTx =
      options.seed?.(root) ?? ((tx, owner, input, auditOwner) => startRunTx(tx, owner, input, root, auditOwner));
    const tool = deepInterviewTool(store, {
      async rootSession(id) {
        if (!(id in LINEAGE)) throw new Error("unknown session");
        return LINEAGE[id];
      },
      settings: options.settings,
      projectDir: root,
      seedRalplanTx: seed,
    });
    const call: Call = async (args, agent = "open-gajae", sessionID = ROOT) =>
      (await tool.execute(tool.input.parse(args) as never, { agent, sessionID, signal: new AbortController().signal }))
        .content;
    const dir = await store.resolveSessionDir(ROOT);
    const file = (...parts: string[]) => join(dir, ...parts);
    const walk = async (at: string, out: Record<string, string>) => {
      const entries = await readdir(at, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = join(at, entry.name);
        if (entry.isDirectory()) await walk(full, out);
        else out[relative(dir, full)] = await readFile(full, "utf8");
      }
      return out;
    };
    await body({
      store,
      root,
      call,
      run: (fn) => store.workflowTransaction(ROOT, fn),
      file,
      json: async (...parts) => JSON.parse(await readFile(file(...parts), "utf8")),
      exists: (...parts) => Bun.file(file(...parts)).exists(),
      audit: async () =>
        (await readFile(file("state", "audit.jsonl"), "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      tree: () => walk(dir, {}),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ok = (text: string) => JSON.parse(text);
/** The JSON after a handoff result's first line. */
const receiptOf = (text: string) => JSON.parse(text.slice(text.indexOf("\n") + 1));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

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
const writeRounds = (call: Call, ...rounds: Record<string, unknown>[]) =>
  call({ op: "write", input: { state: { rounds } } });
const seedState = (run: Harness["run"], state: Record<string, unknown>, mode: "deep-interview" | "ralplan" | "ultragoal" = "deep-interview") =>
  run((tx) => tx.writeModeState(mode, state, mode === "deep-interview" ? "deep_interview_tool" : mode === "ralplan" ? "ralplan_tool" : "ultragoal_tool"));
const row = (tx: WorkflowTx, entry: Record<string, unknown>) =>
  tx.writeText(tx.paths.activeRow(String(entry.skill)), JSON.stringify(entry));

test("T1: eight ops; open-gajae only; a child session writes the root's state; no settings means 0.05 (AC1, AC31)", async () => {
  await fixture(async ({ store, call, json, root }) => {
    expect([...DEEP_INTERVIEW_OPS]).toEqual(["start", "write", "spec", "handoff", "status", "doctor", "state", "clear"]);
    for (const agent of ["open-gajae-architect", "open-gajae-lateral-reviewer", "build"])
      expect(await call({ op: "status" }, agent)).toBe(`Error: the deep-interview tool is not available to ${agent}`);
    expect(await call({ op: "status" }, "open-gajae", "ses_unknown")).toContain("could not resolve the session lineage");
    expect(ok(await call({ op: "start", idea: "from a child" }, "open-gajae", "ses_child"))).toMatchObject({
      threshold: 0.05,
      threshold_source: "default",
    });
    expect(await json("state", DI)).toMatchObject({ session_id: ROOT, state: { initial_idea: "from a child" } });
    const bare = deepInterviewTool(store, { rootSession: async () => ROOT, projectDir: root });
    const text = (await bare.execute({ op: "start", idea: "i" } as never, { agent: "open-gajae", sessionID: ROOT, signal: new AbortController().signal })).content;
    expect(ok(text)).toMatchObject({ threshold: 0.05, threshold_source: "default" });
  });
});

test("T2: start seeds the envelope, overwrites, takes threshold/source precedence, caps, row, and the D-HL2 refusal", async () => {
  await fixture(
    async ({ call, json, run, file, audit }) => {
      for (const [idea, error] of [
        ["   ", "deep-interview start requires an idea"],
        ["x".repeat(50_001), "initial_idea exceeds max length 50000"],
      ] as const)
        expect(await call({ op: "start", idea })).toContain(error);
      for (const threshold of [0, -0.1, 1.5])
        expect(await call({ op: "start", idea: "i", threshold })).toContain(`invalid threshold: ${threshold}. Expected 0 < threshold <= 1.`);
      const summary = ok(await call({ op: "start", idea: "  build a cli  " }));
      expect(summary).toEqual({
        ok: true,
        skill: "deep-interview",
        threshold: 0.2,
        threshold_source: "~/.open-gajae/open-gajae.jsonc",
        idea: "build a cli",
        state_path: file("state", DI),
        handoff: "deep-interview",
      });
      const { _meta, updated_at, ...state } = await json("state", DI);
      expect(state).toEqual({
        skill: "deep-interview",
        version: 2,
        active: true,
        current_phase: "interviewing",
        threshold: 0.2,
        threshold_source: "~/.open-gajae/open-gajae.jsonc",
        session_id: ROOT,
        state: {
          initial_idea: "build a cli",
          rounds: [],
          established_facts: [],
          current_ambiguity: 1,
          threshold: 0.2,
          threshold_source: "~/.open-gajae/open-gajae.jsonc",
        },
      });
      expect(_meta).toMatchObject({ mode: "deep-interview", updatedBy: "deep_interview_tool" });
      const r = await json("state", "active", "deep-interview.json");
      expect(r).toMatchObject({ skill: "deep-interview", active: true, phase: "interviewing", session_id: ROOT });
      expect(r.hud.chips).toEqual([
        { label: "phase", value: "interviewing", priority: 10 },
        { label: "ambiguity", value: "100%/20%", priority: 20 },
        { label: "round", value: "0", priority: 30 },
      ]);
      expect((await audit()).filter((a) => a.skill === "deep-interview").map((a) => [a.verb, a.to_phase])).toEqual([["write", "interviewing"]]);
      // start(threshold) wins and names its source (U-2 C); a running interview is overwritten.
      await writeRounds(call, scored(1));
      expect(ok(await call({ op: "start", idea: "again", threshold: 1 }))).toMatchObject({ threshold: 1, threshold_source: "start(threshold)" });
      expect(ok(await call({ op: "start", idea: "again", threshold: 0.3 }))).toMatchObject({ threshold: 0.3, threshold_source: "start(threshold)" });
      expect(await json("state", DI)).toMatchObject({ threshold_source: "start(threshold)", state: { rounds: [], initial_idea: "again" } });
      // A corrupt state is overwritten without reading it (DR-3).
      await writeFile(file("state", DI), "{");
      expect(ok(await call({ op: "start", idea: "fresh" }))).toMatchObject({ ok: true });
      // D-HL2: ralplan or ultragoal as the visible primary refuses with three ways.
      await run((tx) => row(tx, { skill: "ralplan", active: true, phase: "architect" }));
      const refused = await call({ op: "start", idea: "x" });
      expect(refused).toStartWith("Error: deep-interview start is refused while ralplan is the active workflow (phase architect).");
      for (const way of ['ultragoal handoff(to: "deep-interview", reason)', 'ralplan handoff(to: "deep-interview")', 'ralplan state {"active": false}'])
        expect(refused).toContain(way);
      await run((tx) => row(tx, { skill: "ultragoal", active: true, phase: "active" }));
      expect(await call({ op: "start", idea: "x" })).toContain("while ultragoal is the active workflow (phase active)");
    },
    { settings: { ambiguityThreshold: 0.2, source: "~/.open-gajae/open-gajae.jsonc" } },
  );
});

test("T3: write merges by round_key, reports the nine lifecycle keys, derives and floors ambiguity, keeps handoff, and resets", async () => {
  await fixture(async ({ call, json, run, file, audit, tree }) => {
    expect(await writeRounds(call, scored(1))).toBe(`Error: ${noStateRefusal("write")}`);
    await call({ op: "start", idea: "i" });
    const first = ok(await call({ op: "write", input: { current_phase: "complete", active: false, session_id: "other", state: { type: "greenfield", current_ambiguity: 0.01, rounds: [scored(1, { ambiguity: 0.6 })] } } }));
    expect(first).toMatchObject({ ok: true, verb: "write", mode: "incremental", session_id: ROOT, current_ambiguity: 0.6 });
    expect(first.ignored_runtime_owned_keys).toEqual(["current_phase", "active"]);
    expect(first.ambiguity_floor).toEqual({ floor: 0, disputed_fact_count: 0, unscored_active_component_count: 0 });
    let state = await json("state", DI);
    expect(state).toMatchObject({ active: true, current_phase: "interviewing", session_id: ROOT });
    // A delta for the same round_key keeps the record; `scored` is not downgraded.
    ok(await writeRounds(call, { round_key: "round-1", lifecycle: "answered", ambiguity: 0.4 }, scored(2, { ambiguity: 0.35 })));
    state = await json("state", DI);
    expect(state.state.rounds).toEqual([scored(1, { ambiguity: 0.4, lifecycle: "scored" }), scored(2, { ambiguity: 0.35 })]);
    expect(state.state.current_ambiguity).toBe(0.35);
    // A disputed fact floors the ambiguity; facts merge by id.
    const floored = ok(await call({ op: "write", input: { state: { established_facts: [{ id: "f1", disputed: true }], rounds: [scored(3, { ambiguity: 0.02 })] } } }));
    expect(floored.current_ambiguity).toBe(0.1);
    ok(await call({ op: "write", input: { state: { established_facts: [{ id: "f2", statement: "s" }] } } }));
    state = await json("state", DI);
    expect(state.state.established_facts).toEqual([{ id: "f1", disputed: true }, { id: "f2", statement: "s" }]);
    expect(state.state.rounds[2]).toMatchObject({ ambiguity: 0.1, reported_ambiguity: 0.02, ambiguity_floor: 0.1 });
    expect((await json("state", "active", "deep-interview.json")).hud.chips).toContainEqual({ label: "round", value: "3", priority: 30 });
    // Caps: an answer over 10k.
    expect(await writeRounds(call, scored(4, { answer: "x".repeat(10_001) }))).toContain("state.rounds[0].answer exceeds max length 10000");

    // PQ-20 C: a top-level transcript field refuses the write; nothing changes.
    let before = await tree();
    expect(await call({ op: "write", input: { rounds: [scored(4)] } })).toBe(
      'Error: deep-interview write: rounds belong inside "state"; resend them as {"state": {…}} (top-level transcript fields are rejected, not moved).',
    );
    expect(await call({ op: "write", input: { current_ambiguity: 0 } })).toContain("current_ambiguity belong inside");
    expect(await tree()).toEqual(before);
    // PQ-22 D: a missing field or a mismatched round_key refuses the whole write.
    const { scores: _scores, ...noScores } = scored(4);
    const refusal = await writeRounds(call, noScores, scored(5, { round_key: "round-6" }));
    expect(refusal).toStartWith("Error: deep-interview write: round records do not match the required shape, so nothing was written:");
    expect(refusal).toContain("- round 4 (round-4): scores.goal, scores.constraints, scores.criteria");
    expect(refusal).toContain("- round 5 (round-6): round_key");
    expect(await tree()).toEqual(before);
    // Round 0 (answered, topology alongside) passes.
    ok(await call({ op: "write", input: { state: { rounds: [{ round: 0, round_key: "round-0", lifecycle: "answered", question_text: "components?", answer: "one" }], topology: { status: "confirmed", components: [] } } } }));

    // A spec, then a write keeps phase handoff; session_id is the runtime's and spec_path moves (PQ-14 A).
    await call({ op: "spec", content: "# spec", slug: "s1" });
    ok(await call({ op: "write", input: { session_id: "x", spec_path: "/elsewhere.md", state: { note: "refine" } } }));
    state = await json("state", DI);
    expect(state).toMatchObject({ current_phase: "handoff", active: true, session_id: ROOT, spec_path: "/elsewhere.md", state: { note: "refine" } });
    expect((await json("state", "active", "deep-interview.json")).phase).toBe("handoff");

    // reset (PQ-13 A): an empty base, phase interviewing, threshold and spec/handoff fields gone.
    await run((tx) => tx.readModeState("deep-interview").then((s) => tx.writeModeState("deep-interview", { ...s, handoff_from: "ralplan", handoff_at: "t" }, "deep_interview_tool")));
    const reset = ok(await call({ op: "write", reset: true, input: { state: { initial_idea: "again", rounds: [scored(1, { ambiguity: 0.7 })] } } }));
    expect(reset).toMatchObject({ mode: "reset", current_ambiguity: 0.7 });
    const { _meta, updated_at, ...afterReset } = await json("state", DI);
    expect(afterReset).toEqual({
      skill: "deep-interview",
      active: true,
      version: 2,
      current_phase: "interviewing",
      session_id: ROOT,
      state: {
        initial_idea: "again",
        rounds: [scored(1, { ambiguity: 0.7 })],
        established_facts: [],
        current_ambiguity: 0.7,
        ambiguity_floor: { floor: 0, disputed_fact_count: 0, unscored_active_component_count: 0 },
      },
    });
    expect((await audit()).filter((a) => a.verb === "write-reset").map((a) => [a.from_phase, a.to_phase])).toEqual([["handoff", "interviewing"]]);
    expect((await json("state", "active", "deep-interview.json")).phase).toBe("interviewing");
    expect(await exists(file("specs", "deep-interview-s1.md"))).toBe(true);

    // An inactive interview refuses (PQ-12 B′).
    await call({ op: "state", patch: { active: false } });
    expect(await writeRounds(call, scored(2))).toBe(`Error: ${inactiveStateRefusal("write", "interviewing")}`);
  });
});

async function exists(path: string) {
  return Bun.file(path).exists();
}

test("T4: spec writes the file, index, spec fields, phase and row; same slug overwrites; path rule; caps; no state", async () => {
  await fixture(async ({ call, json, file, root }) => {
    expect(await call({ op: "spec", content: "x" })).toBe(`Error: ${noStateRefusal("spec")}`);
    await call({ op: "start", idea: "i" });
    expect(await call({ op: "spec" })).toBe("Error: content or path is required for deep-interview spec");
    expect(await call({ op: "spec", content: "a", path: "b" })).toBe("Error: content and path are mutually exclusive");
    expect(await call({ op: "spec", content: "a", slug: "../x" })).toBe("Error: invalid path component for slug: ../x");
    const summary = ok(await call({ op: "spec", content: "# Spec\nbody", slug: "first" }));
    const specPath = file("specs", "deep-interview-first.md");
    expect(summary).toEqual({
      skill: "deep-interview",
      stage: "final",
      slug: "first",
      path: specPath,
      sha256: sha("# Spec\nbody\n"),
      spec_path: specPath,
      sha: sha("# Spec\nbody\n"),
      created_at: summary.created_at,
      state_path: file("state", DI),
    });
    expect(await readFile(specPath, "utf8")).toBe("# Spec\nbody\n");
    expect(await json("state", DI)).toMatchObject({
      active: true,
      current_phase: "handoff",
      spec_slug: "first",
      spec_path: specPath,
      spec_sha256: sha("# Spec\nbody\n"),
      spec_stage: "final",
      spec_persisted_at: summary.created_at,
    });
    const r = await json("state", "active", "deep-interview.json");
    expect(r).toMatchObject({ active: true, phase: "handoff" });
    expect(r.hud.chips).toContainEqual({ label: "spec", value: "persisted", priority: 60 });
    // The same slug overwrites; the index gets a second line.
    ok(await call({ op: "spec", content: "v2", slug: "first" }));
    expect(await readFile(specPath, "utf8")).toBe("v2\n");
    const index = (await readFile(file("specs", "deep-interview-index.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(index.map((line) => [line.slug, line.stage, line.path, line.sha256])).toEqual([
      ["first", "final", specPath, sha("# Spec\nbody\n")],
      ["first", "final", specPath, sha("v2\n")],
    ]);
    // PQ-6 A: a relative or absolute existing file is read; a missing path is the text.
    await writeFile(join(root, "draft.md"), "from file\n");
    ok(await call({ op: "spec", path: "draft.md", slug: "rel" }));
    expect(await readFile(file("specs", "deep-interview-rel.md"), "utf8")).toBe("from file\n");
    ok(await call({ op: "spec", path: join(root, "draft.md"), slug: "abs" }));
    expect(await readFile(file("specs", "deep-interview-abs.md"), "utf8")).toBe("from file\n");
    ok(await call({ op: "spec", path: "no/such/file.md", slug: "typo" }));
    expect(await readFile(file("specs", "deep-interview-typo.md"), "utf8")).toBe("no/such/file.md\n");
    // 100k NFC code points: decomposed Hangul counts as composed (C2-9).
    ok(await call({ op: "spec", content: "한".normalize("NFD").repeat(100_000), slug: "big" }));
    expect(await call({ op: "spec", content: "x".repeat(100_001), slug: "toobig" })).toBe("Error: spec content exceeds max length 100000");
    // A default slug is UTC time + hex.
    expect(ok(await call({ op: "spec", content: "d" })).slug).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}-[0-9a-f]{4}$/);
  });
});

test("T5: the combined call seeds ralplan deliberate on the spec, hands off, reuses the run, and leaves earlier steps on failure", async () => {
  await fixture(async ({ call, json, file, run, exists, tree }) => {
    // ① No state: nothing is written.
    expect(await call({ op: "spec", content: "s", handoff: "ralplan" })).toBe(`Error: ${noStateRefusal("spec")}`);
    expect(await tree()).toEqual({});
    await call({ op: "start", idea: "i" });
    const text = await call({ op: "spec", content: "# spec", slug: "c", handoff: "ralplan" });
    const specPath = file("specs", "deep-interview-c.md");
    expect(text.split("\n")[0]).toBe(handedOffToRalplan(specPath));
    const summary = receiptOf(text);
    expect(summary).toMatchObject({
      skill: "deep-interview",
      spec_path: specPath,
      handoff: { to: "ralplan", mode: "deliberate", state_path: file("state", "ralplan-state.json"), run_id: ROOT },
    });
    expect(await json("state", "ralplan-state.json")).toMatchObject({ active: true, current_phase: "planner", mode: "deliberate", task: specPath, run_id: ROOT, handoff_from: "deep-interview" });
    expect(await json("state", DI)).toMatchObject({ active: false, current_phase: "handoff", handoff_to: "ralplan" });
    expect(await json("state", "active", "ralplan.json")).toMatchObject({ active: true, phase: "planner", handoff_from: "deep-interview" });
    expect(await json("state", "active", "deep-interview.json")).toMatchObject({ active: false, phase: "handoff", handoff_to: "ralplan" });
    expect(await readdir(file("state", "transactions"))).toEqual([]);
  });

  // An existing ralplan run (here mid-review) is reseeded under its run_id (PQ-23 A, A4-4).
  await fixture(async ({ call, json, run }) => {
    await call({ op: "start", idea: "i" });
    await seedState(run, { skill: "ralplan", active: true, current_phase: "architect", run_id: "r-old", version: 2 }, "ralplan");
    const summary = receiptOf(await call({ op: "spec", content: "s", slug: "c", handoff: "ralplan" }));
    expect(summary.handoff.run_id).toBe("r-old");
    expect(await json("state", "ralplan-state.json")).toMatchObject({ active: true, current_phase: "planner", run_id: "r-old", handoff_from: "deep-interview" });
  });

  // An active ultragoal is not checked (K12); it stays the visible primary (F40).
  await fixture(async ({ call, run }) => {
    await call({ op: "start", idea: "i" });
    await seedState(run, { skill: "ultragoal", active: true, current_phase: "active", version: 2 }, "ultragoal");
    await run((tx) => row(tx, { skill: "ultragoal", active: true, phase: "active" }));
    expect(await call({ op: "spec", content: "s", slug: "c", handoff: "ralplan" })).toStartWith("Handed off to ralplan");
    expect(await run(readVisiblePrimaryTx)).toMatchObject({ skill: "ultragoal" });
  });

  // ② A corrupt ralplan state: the spec, index, active handoff state and its row stay; ralplan is untouched.
  await fixture(async ({ call, json, file, exists }) => {
    await call({ op: "start", idea: "i" });
    await writeFile(file("state", "ralplan-state.json"), "{");
    expect(await call({ op: "spec", content: "s", slug: "c", handoff: "ralplan" })).toContain("existing ralplan state is corrupt or tampered");
    expect(await exists("specs", "deep-interview-c.md")).toBe(true);
    expect(await exists("specs", "deep-interview-index.jsonl")).toBe(true);
    expect(await json("state", DI)).toMatchObject({ active: true, current_phase: "handoff" });
    expect(await json("state", "active", "deep-interview.json")).toMatchObject({ active: true, phase: "handoff" });
    expect(await readFile(file("state", "ralplan-state.json"), "utf8")).toBe("{");
  });

  // ③ The handoff's pre-journal check refuses: spec, index and the active handoff state stay, its row is
  // gone (the ralplan seed removed it), ralplan is seeded without handoff_from, and no journal exists.
  await fixture(
    async ({ call, json, file, exists }) => {
      await call({ op: "start", idea: "i" });
      expect(await call({ op: "spec", content: "s", slug: "c", handoff: "ralplan" })).toContain("100 top-level keys");
      expect(await exists("specs", "deep-interview-c.md")).toBe(true);
      expect(await json("state", DI)).toMatchObject({ active: true, current_phase: "handoff" });
      expect(await exists("state", "active", "deep-interview.json")).toBe(false);
      const ralplan = await json("state", "ralplan-state.json");
      expect(ralplan).toMatchObject({ active: true, current_phase: "planner" });
      expect(ralplan.handoff_from).toBeUndefined();
      expect(await exists("state", "active", "ralplan.json")).toBe(true);
      expect(await readdir(file("state"))).not.toContain("transactions");
    },
    {
      seed: (projectDir) => async (tx, owner, input, auditOwner) => {
        const seeded = await startRunTx(tx, owner, input, projectDir, auditOwner);
        const state = (await tx.readState())!;
        const { _meta, ...rest } = state;
        const filler = Object.fromEntries(Array.from({ length: 99 - Object.keys(rest).length }, (_, i) => [`f${i}`, i]));
        await tx.writeState({ ...rest, ...filler }, "ralplan_tool");
        return seeded;
      },
    },
  );
});

test("T6: handoff needs phase handoff and a verified spec; results name the next step; goal untouched (AC21)", async () => {
  await fixture(async ({ call, json, file, run }) => {
    expect(await call({ op: "handoff", to: "ralplan" })).toBe(`Error: ${noStateRefusal("handoff")}`);
    await call({ op: "start", idea: "i" });
    expect(await call({ op: "handoff", to: "ralplan" })).toContain("deep-interview handoff needs phase handoff");
    // phase handoff without a spec (state patch): refused.
    ok(await call({ op: "state", patch: { current_phase: "handoff" } }));
    expect(await call({ op: "handoff", to: "ralplan" })).toContain("no persisted spec");
    await call({ op: "spec", content: "# s", slug: "h" });
    const specPath = file("specs", "deep-interview-h.md");
    // A changed spec file and a rewritten spec_sha256 both fail the check (K13).
    await writeFile(specPath, "edited\n");
    expect(await call({ op: "handoff", to: "ralplan" })).toContain("does not match spec_sha256");
    await call({ op: "spec", content: "# s", slug: "h" });
    ok(await call({ op: "write", input: { spec_sha256: "0".repeat(64) } }));
    expect(await call({ op: "handoff", to: "ralplan" })).toContain("does not match spec_sha256");
    ok(await call({ op: "write", input: { spec_path: "/tmp/outside.md" } }));
    expect(await call({ op: "handoff", to: "ralplan" })).toContain("is not in this session's specs/");
    await call({ op: "spec", content: "# s", slug: "h" });
    await run((tx) => tx.writeText(tx.paths.goalState, '{"goal":1}\n'));
    const text = await call({ op: "handoff", to: "ralplan" });
    expect(text.split("\n")[0]).toBe(handedOffToRalplan(specPath));
    expect(text).toContain("Load the `ralplan` skill now; do not call `ralplan start`");
    expect(text).toContain("`ralplan write`");
    expect(receiptOf(text)).toMatchObject({ ok: true, from: "deep-interview", to: "ralplan", phases: { from: "handoff", to: "planner" } });
    const callerRow = await json("state", "active", "deep-interview.json");
    expect(callerRow).toMatchObject({ active: false, phase: "handoff", handoff_to: "ralplan" });
    expect(callerRow.hud.chips[0]).toEqual({ label: "phase", value: "handoff", priority: 10 });
    expect(await readFile(file("state", "goal-state.json"), "utf8")).toBe('{"goal":1}\n');
    // Handed off: the interview is inactive now.
    expect(await call({ op: "handoff", to: "ultragoal" })).toBe(`Error: ${inactiveStateRefusal("handoff", "handoff")}`);
  });
  await fixture(async ({ call, json, file }) => {
    await call({ op: "start", idea: "i" });
    await call({ op: "spec", content: "# s", slug: "u" });
    const text = await call({ op: "handoff", to: "ultragoal" });
    expect(text.split("\n")[0]).toBe(handedOffToUltragoal(file("specs", "deep-interview-u.md")));
    expect(await json("state", "ultragoal-state.json")).toMatchObject({ active: true, current_phase: "goal-planning", handoff_from: "deep-interview" });
  });
});

test("T7: status projects fields, doctor is text, state merges with the table and refuses runtime-owned fields (AC6-AC8)", async () => {
  await fixture(async ({ call, json, file, run }) => {
    expect(ok(await call({ op: "status" }))).toEqual({ skill: "deep-interview", state: {}, storage_path: file("state", DI) });
    expect(await call({ op: "state", patch: { note: 1 } })).toBe(`Error: ${noStateRefusal("state")}`);
    await call({ op: "start", idea: "i" });
    await writeRounds(call, scored(1));
    expect(ok(await call({ op: "status", fields: ["skill", "phase", "next", "active", "spec_path"] }))).toEqual({
      skill: "deep-interview",
      phase: "interviewing",
      next: ["handoff", "complete"],
      active: true,
    });
    expect(await call({ op: "doctor" })).toStartWith("ok: true\n");
    // D-SR9 at both levels and the other top-level transcript fields (PQ-20 C).
    expect(await call({ op: "state", patch: { spec_path: "p", state: { rounds: [] } } })).toContain("deep-interview state cannot set spec_path, state.rounds");
    for (const field of ["topology", "ontology_snapshots", "auto_researched_rounds", "auto_answered_rounds", "architect_failures"])
      expect(await call({ op: "state", patch: { [field]: {} } })).toContain(`deep-interview state: ${field} belong inside "state"`);
    for (const field of ["rounds", "established_facts", "current_ambiguity", "ambiguity_floor"])
      expect(await call({ op: "state", patch: { [field]: [] } })).toContain(`deep-interview state cannot set ${field}`);
    // null deletes; a non-object state is ignored (PQ-25 A); topology recomputes the floor.
    ok(await call({ op: "state", patch: { note: "n" } }));
    ok(await call({ op: "state", patch: { note: null, state: null } }));
    let state = await json("state", DI);
    expect(state.note).toBeUndefined();
    expect(state.state.rounds).toEqual([scored(1)]);
    ok(await call({ op: "state", patch: { state: { topology: { status: "confirmed", components: [{ id: "a" }, { id: "b" }] } } } }));
    state = await json("state", DI);
    expect(state.state.ambiguity_floor).toEqual({ floor: 0.1, disputed_fact_count: 0, unscored_active_component_count: 2 });
    expect(state.state.current_ambiguity).toBe(0.5);
    // Phase edges: interviewing → handoff, never back; unknown phases refused.
    expect(await call({ op: "state", patch: { current_phase: "bogus" } })).toBe('Error: unknown deep-interview phase "bogus"');
    expect(ok(await call({ op: "state", patch: { current_phase: "handoff" } }))).toMatchObject({ current_phase: "handoff", active: true });
    expect(await call({ op: "state", patch: { current_phase: "interviewing" } })).toBe("Error: invalid deep-interview phase transition from handoff to interviewing");
    // Stopping the interview removes its row; an inactive state refuses later patches.
    expect(ok(await call({ op: "state", patch: { active: false } }))).toMatchObject({ active: false });
    expect(await Bun.file(file("state", "active", "deep-interview.json")).exists()).toBe(false);
    expect(await call({ op: "state", patch: { note: 1 } })).toBe(`Error: ${inactiveStateRefusal("state", "handoff")}`);
    // A corrupt state: status warns, state refuses.
    await writeFile(file("state", DI), "{");
    const status = await call({ op: "status" });
    expect(status).toContain('"state": {}');
    expect(status).toContain(`WARNING: failed to read ${file("state", DI)}; ignoring corrupt state:`);
    expect(await call({ op: "state", patch: { note: 1 } })).toContain("reset it with `deep-interview clear` and force: true");
    expect(await call({ op: "doctor" })).toContain("fix=deep-interview clear (force: true)");
  });
});

test("T8: clear completes, keeps specs, removes the row, needs force when corrupt or stale, and works without a state", async () => {
  await fixture(async ({ call, json, file, run, exists, audit }) => {
    // No state, no row: the complete file is created and audited (PQ-12 B′).
    const cleared = ok(await call({ op: "clear" }));
    expect(Object.keys(cleared).sort()).toEqual(["active", "current_phase", "mutation_id", "ok", "skill", "state_path"]);
    expect(cleared).toMatchObject({ ok: true, skill: "deep-interview", state_path: file("state", DI), active: false, current_phase: "complete" });
    const { _meta, updated_at, ...bare } = await json("state", DI);
    expect(bare).toEqual({ skill: "deep-interview", active: false, current_phase: "complete", version: 2 });
    expect((await audit()).filter((a) => a.verb === "clear").map((a) => [a.skill, a.to_phase, a.forced])).toEqual([["deep-interview", "complete", false]]);
    // A second clear is stale (already complete).
    expect(await call({ op: "clear" })).toBe("Error: existing state for deep-interview is stale (mode-state is already terminal (complete)); use force: true to clear");
    expect(ok(await call({ op: "clear", force: true }))).toMatchObject({ ok: true });
  });
  await fixture(async ({ call, json, file, run, exists }) => {
    // A row without a state: the row goes, a complete state appears.
    await run((tx) => row(tx, { skill: "deep-interview", active: true, phase: "interviewing" }));
    ok(await call({ op: "clear" }));
    expect(await exists("state", "active", "deep-interview.json")).toBe(false);
    expect(await json("state", DI)).toMatchObject({ active: false, current_phase: "complete" });
  });
  await fixture(async ({ call, json, file, run, exists }) => {
    await call({ op: "start", idea: "i" });
    await call({ op: "spec", content: "s", slug: "k" });
    ok(await call({ op: "clear" }));
    expect(await json("state", DI)).toMatchObject({ active: false, current_phase: "complete", spec_slug: "k" });
    expect(await exists("specs", "deep-interview-k.md")).toBe(true);
    expect(await exists("specs", "deep-interview-index.jsonl")).toBe(true);
    expect(await exists("state", "active", "deep-interview.json")).toBe(false);
  });
  await fixture(async ({ call, json, file, run, exists }) => {
    // K1: an active state without a row clears without force.
    await call({ op: "start", idea: "i" });
    await run((tx) => tx.remove(tx.paths.activeRow("deep-interview")));
    ok(await call({ op: "clear" }));
    // A stale row phase needs force; a corrupt state needs force.
    await call({ op: "start", idea: "i" });
    await run((tx) => row(tx, { skill: "deep-interview", active: true, phase: "handoff" }));
    expect(await call({ op: "clear" })).toContain("active-state phase handoff differs from mode-state phase interviewing");
    await writeFile(file("state", DI), "{");
    expect(await call({ op: "clear" })).toContain("existing state for deep-interview is corrupt or tampered");
    expect(ok(await call({ op: "clear", force: true }))).toMatchObject({ ok: true, current_phase: "complete" });
    // A handed-over interview (inactive handoff) clears without force.
    await call({ op: "start", idea: "i" });
    await call({ op: "spec", content: "s", slug: "z" });
    await call({ op: "handoff", to: "ralplan" });
    expect(ok(await call({ op: "clear" }))).toMatchObject({ ok: true });
  });
});

test("T9: refused ops leave every file and the audit log byte for byte (P-AC6)", async () => {
  await fixture(async ({ call, run, tree }) => {
    await call({ op: "start", idea: "i" });
    await writeRounds(call, scored(1));
    const before = await tree();
    for (const args of [
      { op: "start", idea: "" },
      { op: "write", input: { rounds: [] } },
      { op: "write", input: { state: { rounds: [{ round: 2 }] } } },
      { op: "write", input: { state: { rounds: [scored(2, { answer: "x".repeat(10_001) })] } } },
      { op: "spec", content: "x".repeat(100_001) },
      { op: "spec", content: "s", slug: "a/b" },
      { op: "handoff", to: "ralplan" },
      { op: "state", patch: { current_phase: "bogus" } },
      { op: "state", patch: { rounds: [] } },
    ])
      expect(await call(args)).toStartWith("Error:");
    expect(await tree()).toEqual(before);
  });
  // A spec whose next state is over the StateStore limits writes neither the spec nor the index (DR-8).
  await fixture(async ({ call, run, tree }) => {
    await call({ op: "start", idea: "i" });
    await run(async (tx) => {
      const state = (await tx.readModeState("deep-interview"))!;
      const { _meta, ...rest } = state;
      const filler = Object.fromEntries(Array.from({ length: 97 - Object.keys(rest).length }, (_, i) => [`f${i}`, i]));
      await tx.writeModeState("deep-interview", { ...rest, ...filler }, "deep_interview_tool");
    });
    const before = await tree();
    expect(await call({ op: "spec", content: "s", slug: "big" })).toContain("100 top-level keys");
    expect(await tree()).toEqual(before);
  });
});

// T10 (AC23). The ultragoal → deep-interview side is covered in
// tests/ultragoal-tool.test.ts ("handoff to deep-interview").
test("T10: ralplan final → ralplan handoff(to: deep-interview) reopens the interview on interviewing with a row (AC23)", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "open-gajae-di-t10-")));
  try {
    const store = new StateStore(root, async () => T0);
    const tools = createTools(store, { locationDir: root, projectDir: root }, { rootSession: async (id) => id });
    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((t) => t.name === name)!;
      return (await tool.execute(tool.input.parse(args) as never, { agent: "open-gajae", sessionID: ROOT, signal: new AbortController().signal })).content;
    };
    const dir = await store.resolveSessionDir(ROOT);
    const json = async (...parts: string[]) => JSON.parse(await readFile(join(dir, ...parts), "utf8"));
    // An interview with a spec hands off to ralplan, which plans to final and hands back.
    await call("deep-interview", { op: "start", idea: "i" });
    await call("deep-interview", { op: "write", input: { state: { rounds: [scored(1)] } } });
    await call("deep-interview", { op: "spec", content: "# s", slug: "t10" });
    expect(await call("deep-interview", { op: "handoff", to: "ralplan" })).toStartWith("Handed off to ralplan");
    await call("ralplan", { op: "write", stage: "final", stage_n: 1, content: "final" });
    expect(await call("ralplan", { op: "handoff", to: "deep-interview" })).toStartWith("Handed off to deep-interview");
    expect(await json("state", DI)).toMatchObject({
      active: true,
      current_phase: "interviewing",
      handoff_from: "ralplan",
      spec_slug: "t10",
      state: { rounds: [scored(1)] },
    });
    expect(await json("state", "active", "deep-interview.json")).toMatchObject({ active: true, phase: "interviewing", handoff_from: "ralplan" });
    // The reopened interview continues with write (no start).
    expect(JSON.parse(await call("deep-interview", { op: "write", input: { state: { rounds: [scored(2)] } } }))).toMatchObject({ ok: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("T11: state {active:false} cancels and keeps the rounds; state {active:true} resumes only a cancelled interviewing (deviation 30)", async () => {
  await fixture(async ({ store, call, run, json, exists, audit }) => {
    const hooks = createDeepInterviewHooks(store);
    await call({ op: "start", idea: "i" });
    await writeRounds(call, scored(1), scored(2));
    // Cancel: the rounds stay, the row goes, and the continuation stops.
    expect(ok(await call({ op: "state", patch: { active: false } }))).toMatchObject({ active: false, current_phase: "interviewing" });
    expect(await json("state", DI)).toMatchObject({ active: false, current_phase: "interviewing", state: { rounds: [scored(1), scored(2)] } });
    expect(await exists("state", "active", "deep-interview.json")).toBe(false);
    hooks.resetContinuation(ROOT);
    expect((await hooks.decideContinuation(ROOT)).kind).toBe("none");
    // While cancelled, write and any other patch are refused with the resume hint.
    const hint = inactiveStateRefusal("write", "interviewing");
    expect(hint).toContain('Resume it with `deep-interview state(patch={"active": true})`');
    expect(await writeRounds(call, scored(3))).toBe(`Error: ${hint}`);
    expect(await call({ op: "state", patch: { note: 1 } })).toBe(`Error: ${inactiveStateRefusal("state", "interviewing")}`);
    // Resume is refused like start while ralplan is the visible primary (deviation 12).
    await run((tx) => row(tx, { skill: "ralplan", active: true, phase: "planner" }));
    expect(await call({ op: "state", patch: { active: true } })).toBe(`Error: ${resumeRefusal("ralplan", "planner")}`);
    await run((tx) => tx.remove(tx.paths.activeRow("ralplan")));
    // Resume: active again with its rounds, the row back, one audit row, and writes continue.
    const before = (await audit()).length;
    expect(ok(await call({ op: "state", patch: { active: true } }))).toMatchObject({ active: true, current_phase: "interviewing" });
    expect(await json("state", "active", "deep-interview.json")).toMatchObject({ active: true, phase: "interviewing" });
    expect((await audit()).slice(before).filter((a) => a.skill === "deep-interview" && a.category === "state" && a.verb === "write")).toHaveLength(1);
    expect(ok(await writeRounds(call, scored(3)))).toMatchObject({ ok: true });
    expect((await json("state", DI)).state.rounds.map((r: { round_key: string }) => r.round_key)).toEqual(["round-1", "round-2", "round-3"]);
    expect((await hooks.decideContinuation(ROOT)).kind).toBe("continue");
    // A finished interview is not resumed (E7).
    await call({ op: "clear" });
    expect(await call({ op: "state", patch: { active: true } })).toBe(`Error: ${inactiveStateRefusal("state", "complete")}`);
  });
  // A handed-off interview (inactive handoff) is not resumed either.
  await fixture(async ({ call }) => {
    await call({ op: "start", idea: "i" });
    await writeRounds(call, scored(1));
    await call({ op: "spec", content: "# s", slug: "t11" });
    expect(await call({ op: "handoff", to: "ultragoal" })).toStartWith("Handed off to ultragoal");
    expect(await call({ op: "state", patch: { active: true } })).toBe(`Error: ${inactiveStateRefusal("state", "handoff")}`);
  });
});

test("T12: cancel/resume edges: a refused resume writes nothing; ultragoal refuses it; snapshot; extra fields; a second cancel; after the spec clear ends it", async () => {
  await fixture(async ({ call, run, json, tree }) => {
    await call({ op: "start", idea: "i" });
    await writeRounds(call, scored(1));
    await call({ op: "state", patch: { active: false } });
    const skills = async () =>
      ((await json("state", "skill-active-state.json")).active_skills as { skill: string }[]).map((entry) => entry.skill);
    expect(await skills()).not.toContain("deep-interview");
    // A second cancel is refused as already cancelled.
    expect(await call({ op: "state", patch: { active: false } })).toBe(`Error: ${alreadyCancelledRefusal()}`);
    // A refused resume (ultragoal is the visible primary) leaves every file and the audit log as they were.
    await run((tx) => row(tx, { skill: "ultragoal", active: true, phase: "active" }));
    const before = await tree();
    expect(await call({ op: "state", patch: { active: true } })).toBe(`Error: ${resumeRefusal("ultragoal", "active")}`);
    expect(await tree()).toEqual(before);
    await run((tx) => tx.remove(tx.paths.activeRow("ultragoal")));
    // Resume merges the other fields of the same patch and rebuilds the snapshot.
    expect(ok(await call({ op: "state", patch: { active: true, note: "back" } }))).toMatchObject({ active: true, current_phase: "interviewing" });
    expect(await json("state", DI)).toMatchObject({ active: true, note: "back", state: { rounds: [scored(1)] } });
    expect(await skills()).toContain("deep-interview");
  });
  // A phase in the same resume patch follows the transition table, as on an active interview.
  await fixture(async ({ call }) => {
    await call({ op: "start", idea: "i" });
    await call({ op: "state", patch: { active: false } });
    expect(ok(await call({ op: "state", patch: { active: true, current_phase: "complete" } }))).toMatchObject({ active: true, current_phase: "complete" });
  });
  // After the spec the skill's hard cancellation is clear: the spec stays and nothing resumes.
  await fixture(async ({ call, exists }) => {
    await call({ op: "start", idea: "i" });
    await writeRounds(call, scored(1));
    await call({ op: "spec", content: "# s", slug: "t12" });
    expect(ok(await call({ op: "clear" }))).toMatchObject({ active: false, current_phase: "complete" });
    expect(await exists("specs", "deep-interview-t12.md")).toBe(true);
    expect(await call({ op: "state", patch: { active: true } })).toBe(`Error: ${inactiveStateRefusal("state", "complete")}`);
  });
});
