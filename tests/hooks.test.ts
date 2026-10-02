import { test, expect, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import {
  createHooks,
  type HostSession,
  type PromptEvent,
  type RalplanHooks,
} from "../src/hooks";
import { continuationMessage } from "../src/ralplan";
import { RUNTIME_OWNER } from "../src/skill-state/audit";
import { syncActiveRowTx } from "../src/skill-state/rows";
import {
  DEEP_INTERVIEW_MODE,
  RALPLAN_MODE,
  StateStore,
  type StateMode,
} from "../src/state";

type Synthetic = {
  sessionID: string;
  text: string;
  description?: string;
  resume: boolean;
};

const PACKAGE_ROOT = new URL("../", import.meta.url).pathname;

let sessionCounter = 0;
const nextSession = (label: string) => `sess-${label}-${(sessionCounter += 1)}`;

type FakeOptions = {
  /** `parents[id]` is that session's parentID; absent means it is a root. */
  parents?: Record<string, string>;
  sessionGetRejects?: boolean;
  syntheticRejects?: boolean;
  /** `locations[id]` is that session's location; absent means the fixture root. */
  locations?: Record<string, string>;
};

/**
 * A structural `ctx.session`. `agents` is mutable so a test can pin the agent
 * of a session before delivering to it.
 */
function fakeSession(options: FakeOptions, location: string) {
  const synthetics: Synthetic[] = [];
  const sessionGets: string[] = [];
  const agents: Record<string, string> = {};
  const session: HostSession = {
    async get(input) {
      sessionGets.push(input.sessionID);
      if (options.sessionGetRejects) throw new Error("session.get failed");
      const parentID = options.parents?.[input.sessionID];
      return {
        ...(agents[input.sessionID] ? { agent: agents[input.sessionID] } : {}),
        ...(parentID ? { parentID } : {}),
        location: { directory: options.locations?.[input.sessionID] ?? location },
      };
    },
    async synthetic(input) {
      synthetics.push({ ...input });
      if (options.syntheticRejects) throw new Error("synthetic failed");
      return {};
    },
  };
  return { session, synthetics, sessionGets, agents };
}

type Fixture = {
  root: string;
  store: StateStore;
  hooks: RalplanHooks;
} & Omit<ReturnType<typeof fakeSession>, "session">;

async function fixture(
  run: (context: Fixture) => Promise<void>,
  options: FakeOptions = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "open-gajae-hooks-"));
  try {
    const root = await fs.realpath(dir);
    // Fixed creation time; the folder label is irrelevant to hook behavior.
    const store = new StateStore(root, async () =>
      Date.parse("2026-09-18T03:09:58+09:00"),
    );
    const { session, ...fake } = fakeSession(options, root);
    // The real plugin root, so `deepInterviewSkillPath` points at the shipped
    // `skills/deep-interview/SKILL.md` exactly as it does at runtime.
    await run({
      root,
      store,
      // The fixture root is both `location.directory` and the project.
      hooks: createHooks(store, session, PACKAGE_ROOT, root, root),
      ...fake,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Deliver one user prompt and return the notices written during it (each a
 * `resume:false` synthetic) plus the event, whose text the Q3 fallback may grow.
 */
async function deliver(
  context: Fixture,
  sessionID: string,
  text: string,
  options: { agent?: string; skills?: string[] } = {},
): Promise<{ notices: string[]; event: PromptEvent }> {
  if (options.agent) context.agents[sessionID] = options.agent;
  const before = context.synthetics.length;
  const event: PromptEvent = {
    sessionID,
    prompt: {
      text,
      ...(options.skills ? { skills: options.skills.map((id) => ({ id })) } : {}),
    },
  };
  await context.hooks.prompt(event);
  const written = context.synthetics.slice(before);
  for (const call of written) {
    expect(call.sessionID).toBe(sessionID);
    expect(call.resume).toBe(false);
    // The TUI hides a synthetic message without a description.
    expect(call.description).toMatch(/^open-gajae: .+ notice added$/);
  }
  return { notices: written.map((call) => call.text), event };
}

const notices = async (
  context: Fixture,
  sessionID: string,
  text: string,
  options?: { agent?: string; skills?: string[] },
) => (await deliver(context, sessionID, text, options)).notices;

/** One durable event envelope as `ctx.event.subscribe` yields it. */
const emit = (
  hooks: RalplanHooks,
  type: string,
  sessionID: string,
  data: Record<string, unknown> = {},
) =>
  hooks.onEvent({
    id: "evt",
    created: Date.now(),
    type,
    durable: true,
    data: { sessionID, ...data },
  });

const succeeded = (hooks: RalplanHooks, sessionID: string) =>
  emit(hooks, "session.execution.succeeded", sessionID);

/** The continuations written so far: `resume:true` synthetics. */
const continuations = (context: Fixture) =>
  context.synthetics.filter((call) => call.resume).map((call) => call.text);

let callCounter = 0;
const nextCall = () => `call-${(callCounter += 1)}`;

const skillCall = (hooks: RalplanHooks, sessionID: string, input: unknown) =>
  hooks.executeBefore({ tool: "skill", sessionID, id: nextCall(), input });

const raw = async (store: StateStore, sessionID: string) =>
  readFile(join(await store.resolveSessionDir(sessionID), "state", "ralplan-state.json"), "utf8");

async function missing(
  store: StateStore,
  sessionID: string,
  mode: StateMode = RALPLAN_MODE,
) {
  return fs
    .lstat(join(await store.resolveSessionDir(sessionID), "state", `${mode}-state.json`))
    .then(() => false)
    .catch(() => true);
}

/** A mode-state file read straight from disk, or `undefined`. */
const stateOf = async (store: StateStore, sessionID: string, mode: StateMode) =>
  readFile(join(await store.resolveSessionDir(sessionID), "state", `${mode}-state.json`), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => undefined);

/** Neither mode left a state file behind. */
async function noState(store: StateStore, sessionID: string) {
  return (
    (await missing(store, sessionID, RALPLAN_MODE)) &&
    (await missing(store, sessionID, DEEP_INTERVIEW_MODE))
  );
}

/**
 * A ralplan state as the runtime writes it: a known phase and a run, with its
 * active row while it is active (ultragoal revision plan PQ-7 B and D-HE5 key
 * the continuation and the guard on the row).
 */
const plan = (store: StateStore, sessionID: string, state: Record<string, unknown> = {}) =>
  store.ralplanTransaction(sessionID, async (tx) => {
    const written = await tx.writeState(
      { active: true, current_phase: "planner", run_id: "run-1", ...state },
      "ralplan_tool",
    );
    if (written.active === true)
      await syncActiveRowTx(
        tx,
        { skill: "ralplan", active: true, phase: String(written.current_phase), sessionId: sessionID },
        RUNTIME_OWNER,
      );
  });

const GOAL_AT = "2026-09-30T00:00:00.000Z";

/** A goal state at `sessionID` (plan C-9), active and user-made by default. */
const setGoal = (store: StateStore, sessionID: string, fields: Record<string, unknown> = {}) =>
  store.workflowTransaction(sessionID, (tx) =>
    tx.writeText(
      tx.paths.goalState,
      JSON.stringify({
        version: 1,
        id: "g1",
        objective: "ship the feature",
        status: "active",
        source: "user",
        created_at: GOAL_AT,
        updated_at: GOAL_AT,
        ...fields,
      }),
    ),
  );

/** The hook-only goal continuation record (PQ-2 B), or `undefined`. */
const goalRecord = (store: StateStore, sessionID: string) =>
  store.workflowTransaction(sessionID, async (tx) => {
    const text = await tx.readText(tx.paths.goalContinuation);
    return text === undefined ? undefined : JSON.parse(text);
  });

const setGoalRecord = (store: StateStore, sessionID: string, record: Record<string, unknown>) =>
  store.workflowTransaction(sessionID, (tx) => tx.writeText(tx.paths.goalContinuation, JSON.stringify(record)));

/** The hook-only continuation counter (plan R-O3), or `undefined`. */
async function counter(store: StateStore, sessionID: string) {
  const file = join(await store.resolveSessionDir(sessionID), "state", "ralplan-continuation.json");
  return readFile(file, "utf8").then((text) => JSON.parse(text)).catch(() => undefined);
}

const setCounter = (store: StateStore, sessionID: string, value: Record<string, unknown>) =>
  store.ralplanTransaction(sessionID, (tx) => tx.writeText(tx.paths.continuationPath, JSON.stringify(value)));

test("a corrupt state file stays byte-identical; the prompt and skill hooks resolve", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("corrupt");
    const file = join(await store.resolveSessionDir(id), "state", "ralplan-state.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "{", "utf8");

    expect(await notices(context, id, "unrelated question")).toHaveLength(0);
    expect(await notices(context, id, "랄플랜 정리해줘")).toHaveLength(1);
    await notices(context, id, "plan it", { skills: ["ralplan"] });
    await skillCall(hooks, id, { id: "ralplan" });
    expect(await readFile(file, "utf8")).toBe("{");
  });
});

test("the ralplan keyword writes one notice", async () => {
  await fixture(async (context) => {
    for (const text of ["ralplan 계획 세워줘", "랄플랜 <task>"]) {
      const id = nextSession("keyword");
      const written = await notices(context, id, text);
      expect(written).toHaveLength(1);
      expect(written[0]).toContain("[MODE: RALPLAN]");
      expect(written[0].startsWith("<ralplan-notice>")).toBe(true);
    }
  });
});

test("a rejected synthetic appends the marked notice to the prompt", async () => {
  await fixture(
    async (context) => {
      const id = nextSession("synthetic-reject");
      const { event } = await deliver(context, id, "ralplan 계획 세워줘");
      expect(event.prompt.text.startsWith("ralplan 계획 세워줘\n\n")).toBe(true);
      expect(event.prompt.text).toContain("<ralplan-notice>");
      expect(event.prompt.text).toContain("[MODE: RALPLAN]");

      // The grown text fed back in is ignored by G2: no notice.
      const before = context.synthetics.length;
      const again = await deliver(context, id, event.prompt.text);
      expect(again.event.prompt.text).toBe(event.prompt.text);
      expect(context.synthetics.length).toBe(before);
    },
    { syntheticRejects: true },
  );
});

test("a @ralplan mention writes one mention notice", async () => {
  await fixture(async (context) => {
    const id = nextSession("mention");
    const written = await notices(context, id, "tidy the hooks", {
      skills: ["ralplan"],
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("through the `@ralplan` mention");
    expect(written[0]).toContain("already attached");
  });
});

test("a non-ralplan execution request is left unchanged and writes no state", async () => {
  await fixture(async (context) => {
    const id = nextSession("ralph");
    expect(await notices(context, id, "ralph fix this")).toHaveLength(0);
    expect(await missing(context.store, id)).toBe(true);
  });
});

test("the plugin's own continuation text is ignored when it re-enters", async () => {
  await fixture(async (context) => {
    const id = nextSession("self");
    expect(await notices(context, id, continuationMessage(1))).toHaveLength(0);
    expect(await missing(context.store, id)).toBe(true);
  });
});

test("the three role subagents are denied; no agent and the open-gajae primary proceed", async () => {
  await fixture(async (context) => {
    const { store } = context;
    for (const agent of [
      "open-gajae-planner",
      "open-gajae-architect",
      "open-gajae-critic",
    ]) {
      const id = nextSession("role");
      expect(await notices(context, id, "랄플랜 정리해줘", { agent })).toHaveLength(0);
      expect(
        await notices(context, id, "plan", { agent, skills: ["ralplan", "deep-interview"] }),
      ).toHaveLength(0);
      expect(await noState(store, id)).toBe(true);
    }

    // No agent on the session, and the open-gajae primary, proceed.
    const undefinedAgent = nextSession("undefined-agent");
    const written = await notices(context, undefinedAgent, "랄플랜 정리해줘");
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("[MODE: RALPLAN]");

    const primary = nextSession("primary-agent");
    expect(
      await notices(context, primary, "랄플랜 정리해줘", { agent: "open-gajae" }),
    ).toHaveLength(1);
  });
});

test("other agents get no notice but a real prompt still lifts the goal hold (R-OD20)", async () => {
  await fixture(async (context) => {
    const { store } = context;
    const id = nextSession("build-agent");
    for (const text of ["랄플랜 정리해줘", "force: ultragoal add auth", "딥인터뷰 하고 싶어"])
      expect(await notices(context, id, text, { agent: "build" })).toHaveLength(0);
    expect(
      await notices(context, id, "plan", { agent: "build", skills: ["ralplan", "ultragoal", "deep-interview"] }),
    ).toHaveLength(0);
    expect(await noState(store, id)).toBe(true);
    expect(await missing(store, id, "ultragoal")).toBe(true);

    const held = nextSession("build-held");
    await setGoal(store, held);
    await setGoalRecord(store, held, { goal_id: "g1", tool_less_turns: 3, held: { reason: "no_tool_progress", at: GOAL_AT } });
    expect(await notices(context, held, "keep going", { agent: "build" })).toHaveLength(0);
    expect(await goalRecord(store, held)).toEqual({ goal_id: "g1", tool_less_turns: 0 });
  });
});

test("a failed agent lookup proceeds", async () => {
  await fixture(
    async (context) => {
      const id = nextSession("get-reject");
      expect(await notices(context, id, "랄플랜 정리해줘")).toHaveLength(1);
    },
    { sessionGetRejects: true },
  );
});

test("a store error inside the prompt hook or the skill call resolves", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("store-error");
    await plan(store, id);
    const failing = async () => {
      throw new Error("disk full");
    };
    store.workflowTransaction = failing as StateStore["workflowTransaction"];
    store.ralplanTransaction = failing as StateStore["ralplanTransaction"];
    await expect(
      hooks.prompt({ sessionID: id, prompt: { text: "랄플랜 정리해줘" } }),
    ).resolves.toBeUndefined();
    await expect(
      hooks.prompt({
        sessionID: id,
        prompt: { text: "x", skills: [{ id: "ralplan" }] },
      }),
    ).resolves.toBeUndefined();
    await expect(skillCall(hooks, id, { id: "ralplan" })).resolves.toBeUndefined();
  });
});

test("R18 — an expanded deep-interview skill body seeds nothing", async () => {
  await fixture(async (context) => {
    const { store } = context;
    const id = nextSession("deep-interview-expansion");
    const body = await readFile(
      new URL("../skills/deep-interview/SKILL.md", import.meta.url),
      "utf8",
    );
    // A pasted skill body, as the host could deliver it with a base-directory tail.
    const expanded = `${body}\n\nBase directory for this skill: /x/skills/deep-interview\nRelative paths in this skill (e.g., scripts/, references/) are relative to this base directory.`;
    expect(expanded).toContain("ralplan");

    // No ralplan notice and no state. The body does fire the deep-interview
    // keyword — measured against OMC's own detector, which fires on it too (see
    // the matching case in tests/ralplan.test.ts) — so one magic notice is
    // written, and it seeds nothing at all.
    const written = await notices(context, id, expanded);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("[MAGIC KEYWORD: DEEP-INTERVIEW]");
    expect(await noState(store, id)).toBe(true);
  });
});

test("the deep-interview keyword writes the magic notice and no state", async () => {
  await fixture(async (context) => {
    const { store } = context;
    const id = nextSession("di-keyword");
    const written = await notices(context, id, "딥인터뷰 하고 싶어");
    expect(written).toHaveLength(1);
    const text = written[0];
    expect(text.startsWith("<deep-interview-notice>")).toBe(true);
    expect(text).toContain("[MAGIC KEYWORD: DEEP-INTERVIEW]");
    expect(text).toContain("Preferred invocation: @deep-interview");
    // `createHooks` resolves the fallback against the real package root.
    expect(text).toContain("skills/deep-interview/SKILL.md and follow");

    // Unlike ralplan, this keyword seeds nothing in either mode.
    expect(await noState(store, id)).toBe(true);

    // G2: the notice fed back in is ignored, so it cannot re-inject.
    expect(await notices(context, id, text)).toHaveLength(0);
    expect(await noState(store, id)).toBe(true);
  });
});

test("a @deep-interview mention writes exactly one magic notice (Q8)", async () => {
  await fixture(async (context) => {
    const { store } = context;
    const bare = nextSession("di-mention");
    const written = await notices(context, bare, "refactor the settings loader", {
      skills: ["deep-interview"],
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("[MAGIC KEYWORD: DEEP-INTERVIEW]");
    expect(written[0]).toContain("Preferred invocation: @deep-interview");
    expect(await noState(store, bare)).toBe(true);

    const both = nextSession("di-mention-keyword");
    const once = await notices(context, both, "딥인터뷰 하고 싶어", {
      skills: ["deep-interview"],
    });
    expect(once).toHaveLength(1);
    expect(once[0]).toContain("[MAGIC KEYWORD: DEEP-INTERVIEW]");
  });
});

test("the three role subagents are denied for the deep-interview keyword", async () => {
  await fixture(async (context) => {
    for (const agent of [
      "open-gajae-planner",
      "open-gajae-architect",
      "open-gajae-critic",
    ]) {
      const id = nextSession("di-role");
      expect(await notices(context, id, "딥인터뷰 하고 싶어", { agent })).toHaveLength(0);
      expect(await noState(context.store, id)).toBe(true);
    }
  });
});

test("both keywords in one message write ralplan first, then deep-interview", async () => {
  await fixture(async (context) => {
    const { store } = context;
    const id = nextSession("di-both");
    // Cross-checked against OMC's `detectKeywordsWithType`, which returns
    // ["ralplan", "deep-interview"] in that order for this string
    // (KEYWORD_PRIORITY, keyword-detector/index.ts:90-95).
    const written = await notices(context, id, "랄플랜 세워줘, 그 전에 딥인터뷰 해줘");
    expect(written).toHaveLength(2);
    expect(written[0]).toContain("[MODE: RALPLAN]");
    expect(written[1]).toContain("[MAGIC KEYWORD: DEEP-INTERVIEW]");

    // Deep-interview never writes state.
    expect(await missing(store, id, DEEP_INTERVIEW_MODE)).toBe(true);
  });
});

// --- Continuation on durable execution events (Step 5) --------------------
// Plan S3: one ralplan transaction per decision (C-1.5), the counter in the
// hook-only `state/ralplan-continuation.json` (R-O3).

test("a succeeded execution writes one resumed continuation and counts it in the continuation file", async () => {
  await fixture(async (context) => {
    const { store, hooks, synthetics } = context;
    const id = nextSession("continue");
    await plan(store, id);
    await succeeded(hooks, id);

    expect(synthetics).toHaveLength(1);
    expect(synthetics[0].sessionID).toBe(id);
    expect(synthetics[0].resume).toBe(true);
    expect(synthetics[0].text).toContain(
      "[RALPLAN - CONSENSUS PLANNING | REINFORCEMENT 1/30]",
    );
    expect(synthetics[0].text.startsWith("<ralplan-continuation>")).toBe(true);
    expect(synthetics[0].description).toBe(
      "open-gajae: ralplan continuation 1/30",
    );

    // P-AC8: the counter file holds exactly these keys; the state none of them.
    const file = await counter(store, id);
    expect(Object.keys(file).sort()).toEqual(["breaker_count", "breaker_updated_at", "run_id"]);
    expect(file).toMatchObject({ run_id: "run-1", breaker_count: 1 });
    const state = await stateOf(store, id, RALPLAN_MODE);
    expect(state?.active).toBe(true);
    for (const key of ["breaker_count", "breaker_updated_at", "started_at", "restored_at"])
      expect(state).not.toHaveProperty(key);
  });
});

test("terminal, stuck and inactive states produce no continuation; a finished run's breaker resets", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const terminal = nextSession("terminal");
    await plan(store, terminal, { current_phase: "complete" });
    await setCounter(store, terminal, { run_id: "run-1", breaker_count: 7, breaker_updated_at: new Date().toISOString() });
    await succeeded(hooks, terminal);

    const stuck = nextSession("stuck");
    await plan(store, stuck, { current_phase: "critic", planning_stuck: { marker: "PLANNING-STUCK", reason: "r" } });
    await succeeded(hooks, stuck);

    const inactive = nextSession("inactive");
    await plan(store, inactive, { active: false });
    await succeeded(hooks, inactive);

    // No state directory at all is a no-op too.
    const empty = nextSession("no-state");
    await succeeded(hooks, empty);

    expect(continuations(context)).toHaveLength(0);
    expect((await counter(store, terminal))?.breaker_count).toBe(0);
    expect(await counter(store, inactive)).toBeUndefined();
    expect(await missing(store, empty)).toBe(true);
  });
});

test("the thirty-first succeeded trips the circuit breaker: active false through the runtime writer, one audit row (R-O3)", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("breaker");
    await plan(store, id);
    for (let turn = 0; turn < 31; turn += 1) await succeeded(hooks, id);

    const texts = continuations(context);
    expect(texts).toHaveLength(31);
    expect(texts[29]).toContain("REINFORCEMENT 30/30");
    expect(texts[30]).toContain("[RALPLAN CIRCUIT BREAKER]");
    expect(texts[30]).not.toContain("REINFORCEMENT");

    const state = await stateOf(store, id, RALPLAN_MODE);
    expect(state).toMatchObject({ active: false, current_phase: "planner" });
    for (const key of ["deactivated_reason", "completed_at", "breaker_count"])
      expect(state).not.toHaveProperty(key);
    expect((await counter(store, id))?.breaker_count).toBe(0);
    const dir = await store.resolveSessionDir(id);
    const audit = (await readFile(join(dir, "state", "audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => String(row.mutation_id).includes("breaker-exhausted"));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ owner: "open-gajae-hook", paths: [join(await store.resolveSessionDir(id), "state", "ralplan-state.json")] });

    // A deactivated state is inert on the next succeeded.
    await succeeded(hooks, id);
    expect(continuations(context)).toHaveLength(31);
  });
});

test("a counter past the TTL or of another run restarts the count at one", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const stale = nextSession("ttl");
    await plan(store, stale);
    await setCounter(store, stale, {
      run_id: "run-1",
      breaker_count: 30,
      breaker_updated_at: new Date(Date.now() - 46 * 60 * 1000).toISOString(),
    });
    await succeeded(hooks, stale);
    const foreign = nextSession("other-run");
    await plan(store, foreign);
    await setCounter(store, foreign, { run_id: "run-0", breaker_count: 30, breaker_updated_at: new Date().toISOString() });
    await succeeded(hooks, foreign);
    const texts = continuations(context);
    expect(texts).toHaveLength(2);
    for (const text of texts) expect(text).toContain("REINFORCEMENT 1/30");
    expect(await counter(store, stale)).toMatchObject({ run_id: "run-1", breaker_count: 1 });
    expect(await counter(store, foreign)).toMatchObject({ run_id: "run-1", breaker_count: 1 });
  });
});

test("two concurrent succeeded events produce a single continuation", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("inflight");
    await plan(store, id);
    await Promise.all([succeeded(hooks, id), succeeded(hooks, id)]);
    expect(continuations(context)).toHaveLength(1);
    expect((await counter(store, id))?.breaker_count).toBe(1);
  });
});

test("a failed execution does not continue", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("failed");
    await plan(store, id);
    await emit(hooks, "session.execution.failed", id, {
      error: { type: "provider.invalid-request", status: 400 },
    });
    expect(context.synthetics).toHaveLength(0);
    expect(await counter(store, id)).toBeUndefined();
  });
});

test("a user or shutdown interrupt stops continuation until a real prompt (Q9)", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    for (const reason of ["user", "shutdown"]) {
      const id = nextSession(`interrupt-${reason}`);
      await plan(store, id);
      await emit(hooks, "session.execution.interrupted", id, { reason });
      // Also a later host resume (subagent completion) that succeeds.
      await succeeded(hooks, id);
      await succeeded(hooks, id);
      expect(continuations(context)).toHaveLength(0);
      expect(await counter(store, id)).toBeUndefined();
      expect((await stateOf(store, id, RALPLAN_MODE))?.active).toBe(true);

      // A marker-only prompt (the Q3 fallback shape) does not lift the mark.
      await notices(context, id, `x\n\n${continuationMessage(1)}`);
      await succeeded(hooks, id);
      expect(continuations(context)).toHaveLength(0);

      // A real prompt lifts it, and the next succeeded continues.
      await notices(context, id, "이어서 해줘");
      await succeeded(hooks, id);
      expect(continuations(context)).toHaveLength(1);
      context.synthetics.length = 0;
    }
  });
});

test("inactivity and superseded interrupts do not set the mark", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    for (const reason of ["inactivity", "superseded"]) {
      const id = nextSession(`interrupt-${reason}`);
      await plan(store, id);
      await emit(hooks, "session.execution.interrupted", id, { reason });
      await succeeded(hooks, id);
    }
    expect(continuations(context)).toHaveLength(2);
  });
});

test("an interrupt of another session does not silence this one", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const stopped = nextSession("interrupt-other");
    const running = nextSession("interrupt-running");
    await plan(store, running);
    await emit(hooks, "session.execution.interrupted", stopped, { reason: "user" });
    await succeeded(hooks, running);
    expect(continuations(context)).toHaveLength(1);
  });
});

test("continuation waits while a child execution runs (Q5)", async () => {
  const parent = nextSession("q5-parent");
  const created = nextSession("q5-created");
  const looked = nextSession("q5-looked-up");
  await fixture(
    async (context) => {
      const { store, hooks } = context;
      await plan(store, parent);
      // A background child announced by `session.created`.
      await emit(hooks, "session.created", created, {
        parentID: parent,
        agent: "explore",
        location: { directory: context.root },
      });
      await emit(hooks, "session.execution.started", created);
      // A child first seen at `started`, resolved through `session.get`.
      await emit(hooks, "session.execution.started", looked);
      await succeeded(hooks, parent);
      expect(continuations(context)).toHaveLength(0);

      await succeeded(hooks, created);
      await succeeded(hooks, parent);
      expect(continuations(context)).toHaveLength(0);

      // An interrupted child ends too; the host's completion resume of the
      // parent then succeeds and is judged normally.
      await emit(hooks, "session.execution.interrupted", looked, {
        reason: "user",
      });
      await succeeded(hooks, parent);
      expect(continuations(context)).toHaveLength(1);
      expect((await counter(store, parent))?.breaker_count).toBe(1);
    },
    { parents: { [looked]: parent } },
  );
});

test("sessions of another location are ignored (Q10)", async () => {
  const foreign = nextSession("q10-foreign");
  const announced = nextSession("q10-announced");
  await fixture(
    async (context) => {
      const { store, hooks, sessionGets } = context;
      await plan(store, foreign);
      await emit(hooks, "session.execution.interrupted", foreign, { reason: "user" });
      await succeeded(hooks, foreign);
      await succeeded(hooks, foreign);
      expect(context.synthetics).toHaveLength(0);
      // One lookup per session, then cached.
      expect(sessionGets).toEqual([foreign]);

      // `session.created` supplies the location without a lookup.
      await plan(store, announced);
      await emit(hooks, "session.created", announced, {
        location: { directory: "/work/project/sub" },
      });
      await succeeded(hooks, announced);
      expect(context.synthetics).toHaveLength(0);
      expect(sessionGets).toEqual([foreign]);
      expect(await counter(store, foreign)).toBeUndefined();
    },
    { locations: { [foreign]: "/work/project/sub" } },
  );
});

test("a rejected synthetic does not escape the event handler", async () => {
  await fixture(
    async (context) => {
      const { store, hooks } = context;
      const id = nextSession("synthetic-reject-event");
      await plan(store, id);
      await expect(succeeded(hooks, id)).resolves.toBeUndefined();
      expect(continuations(context)).toHaveLength(1);
      // The count stays incremented; the next succeeded is the retry.
      expect((await counter(store, id))?.breaker_count).toBe(1);
    },
    { syntheticRejects: true },
  );
});

test("store, lookup and envelope errors never escape the event handler", async () => {
  await fixture(
    async (context) => {
      const { hooks } = context;
      const id = nextSession("event-errors");
      // Lookup rejects.
      await expect(succeeded(hooks, id)).resolves.toBeUndefined();
      // Malformed envelopes.
      for (const event of [undefined, null, "x", { type: 1 }, { type: "session.execution.succeeded" }])
        await expect(hooks.onEvent(event)).resolves.toBeUndefined();
      expect(context.synthetics).toHaveLength(0);
    },
    { sessionGetRejects: true },
  );
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("event-store-error");
    await plan(store, id);
    store.ralplanTransaction = (async () => {
      throw new Error("disk full");
    }) as StateStore["ralplanTransaction"];
    await expect(succeeded(hooks, id)).resolves.toBeUndefined();
    expect(context.synthetics).toHaveLength(0);
  });
});

test("a corrupt state file does not continue and stays byte-identical", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("corrupt-event");
    const file = join(await store.resolveSessionDir(id), "state", "ralplan-state.json");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "{", "utf8");
    await succeeded(hooks, id);
    expect(context.synthetics).toHaveLength(0);
    expect(await readFile(file, "utf8")).toBe("{");
  });
});

// --- D2c session-scoped artifact guard ------------------------------------
// Only this hook can pin a session's plans and drafts to its own folder. A
// block replaces the input with `{}` (the host's decode then fails) and
// `execute.after` rewrites that failure into guidance (Phase 0 P3/P8).

/** The session folder the store resolves for `sessionID`. */
const folderOf = async (store: StateStore, sessionID: string) =>
  basename(await store.resolveSessionDir(sessionID));

/** One artifact tool call through `execute.before`; returns the event. */
async function toolCall(
  hooks: RalplanHooks,
  sessionID: string,
  tool: string,
  input: Record<string, unknown>,
) {
  const event = { tool, sessionID, id: nextCall(), input: input as unknown };
  await hooks.executeBefore(event);
  return event;
}

const writeCall = (hooks: RalplanHooks, sessionID: string, path: string) =>
  toolCall(hooks, sessionID, "write", { path, content: "# plan\n" });

/** The host's `execute.after` for a failed call; returns the event. */
async function failed(
  hooks: RalplanHooks,
  call: { tool: string; sessionID: string; id: string },
  agent = "open-gajae",
  error: unknown = new Error("Invalid arguments for tool"),
) {
  const event = { ...call, agent, status: "error", error };
  await hooks.executeAfter(event);
  return event;
}

const OTHER = "_session-20260101-000000-ses_other";

test("a session may write plans and drafts under its own session folder", async () => {
  await fixture(async ({ root, store, hooks, sessionGets }) => {
    const id = nextSession("guard-own");
    const folder = await folderOf(store, id);
    for (const kind of ["plans", "drafts"]) {
      for (const path of [
        join(root, ".open-gajae", folder, kind, "plan.md"),
        join(".open-gajae", folder, kind, "plan.md"),
      ]) {
        const call = await writeCall(hooks, id, path);
        expect(call.input).toEqual({ path, content: "# plan\n" });
        const edit = await toolCall(hooks, id, "edit", { path });
        expect(edit.input).toEqual({ path });
      }
    }
    const patchText = `*** Begin Patch\n*** Add File: .open-gajae/${folder}/plans/p.md\n+x\n*** End Patch`;
    expect((await toolCall(hooks, id, "patch", { patchText })).input).toEqual({
      patchText,
    });
    // The lineage walk is cached: one lookup covers every later write.
    expect(sessionGets).toEqual([id]);
  });
});

test("a child session writes into its root session's plans, not its own folder", async () => {
  const child = nextSession("guard-child");
  const parent = nextSession("guard-parent");
  const rootSession = nextSession("guard-root");
  await fixture(
    async ({ root, store, hooks, sessionGets }) => {
      const folder = await folderOf(store, rootSession);
      const ok = await writeCall(
        hooks,
        child,
        join(root, ".open-gajae", folder, "plans", "plan.md"),
      );
      expect(ok.input).not.toEqual({});
      expect(sessionGets).toEqual([child, parent, rootSession]);
      const ownFolder = await folderOf(store, child);
      expect(ownFolder).not.toBe(folder);
      const blocked = await writeCall(
        hooks,
        child,
        join(root, ".open-gajae", ownFolder, "plans", "plan.md"),
      );
      expect(blocked.input).toEqual({});
      expect(sessionGets).toEqual([child, parent, rootSession]);
    },
    { parents: { [child]: parent, [parent]: rootSession } },
  );
});

test("another session's write is blocked by input invalidation and rewritten into guidance", async () => {
  await fixture(async ({ root, store, hooks }) => {
    const id = nextSession("guard-foreign");
    const folder = await folderOf(store, id);
    for (const kind of ["plans", "drafts"]) {
      const call = await writeCall(
        hooks,
        id,
        join(root, ".open-gajae", OTHER, kind, "plan.md"),
      );
      expect(call.input).toEqual({});
      const after = await failed(hooks, call);
      expect(after.error).toBeInstanceOf(ToolError);
      const message = (after.error as ToolError).message;
      expect(message).toContain(`.open-gajae/${OTHER}/${kind}/plan.md`);
      expect(message).toContain(
        `write may only write under this session's plans/ or drafts/ (.open-gajae/${folder}/plans|drafts/)`,
      );
      // The recorded block is consumed once.
      const again = await failed(hooks, call);
      expect(again.error).not.toBeInstanceOf(ToolError);
    }
    // `patch` carries its paths inside one string, indented markers included.
    const patchCall = await toolCall(hooks, id, "patch", {
      patchText: `*** Begin Patch\n  *** Update File: .open-gajae/${OTHER}/plans/plan.md\n@@\n-a\n+b\n*** End Patch`,
    });
    expect(patchCall.input).toEqual({});
    expect(((await failed(hooks, patchCall)).error as ToolError).message).toContain(
      "patch may only write under",
    );
  });
});

test("a subdirectory launch cannot reach another session's plans through ../ (A3)", async () => {
  await fixture(async ({ root, store }) => {
    const sub = join(root, "sub");
    await mkdir(sub);
    const { session } = fakeSession({}, sub);
    const hooks = createHooks(store, session, PACKAGE_ROOT, sub, root);
    const id = nextSession("guard-sub");
    const folder = await folderOf(store, id);
    const call = await writeCall(
      hooks,
      id,
      `../.open-gajae/${OTHER}/plans/x.md`,
    );
    expect(call.input).toEqual({});
    expect(((await failed(hooks, call)).error as ToolError).message).toContain(
      `(../.open-gajae/${folder}/plans|drafts/)`,
    );
    const own = await writeCall(hooks, id, `../.open-gajae/${folder}/plans/x.md`);
    expect(own.input).not.toEqual({});
  });
});

test("an unresolvable session lineage blocks the write", async () => {
  await fixture(
    async ({ root, hooks }) => {
      const id = nextSession("guard-lineage");
      const call = await writeCall(
        hooks,
        id,
        join(root, ".open-gajae", OTHER, "plans/p.md"),
      );
      expect(call.input).toEqual({});
      expect(((await failed(hooks, call)).error as ToolError).message).toContain(
        "session lineage",
      );
    },
    { sessionGetRejects: true },
  );
});

test("(m) with the lineage lookup failing, the planning guard lets calls through; runtime-owned and session paths stay refused", async () => {
  await fixture(
    async ({ root, store, hooks }) => {
      const id = nextSession("guard-other-paths");
      // An active planning run that would block these if the root resolved.
      await plan(store, id);
      for (const path of [
        join(root, "src/x.ts"),
        join(root, ".open-gajae/open-gajae.jsonc"),
        join(root, ".open-gajae", OTHER, "specs/spec.md"),
        "src/x.ts",
        "/etc/passwd",
      ])
        expect((await writeCall(hooks, id, path)).input).not.toEqual({});
      for (const path of [
        join(root, ".open-gajae", OTHER, "state/ralplan-state.json"),
        join(root, ".open-gajae", OTHER, "state/ralplan-continuation.json"),
        join(root, ".open-gajae", OTHER, "plans/ralplan/run-1/index.jsonl"),
      ]) {
        const call = await writeCall(hooks, id, path);
        expect(call.input).toEqual({});
        expect(((await failed(hooks, call)).error as ToolError).message).toContain("runtime-owned");
      }
      expect((await writeCall(hooks, id, join(root, ".open-gajae", OTHER, "plans/p.md"))).input).toEqual({});
      // Tools that write no file are not inspected, and their failures are left alone.
      const read = await toolCall(hooks, id, "read", {
        path: join(root, ".open-gajae", OTHER, "plans/p.md"),
      });
      expect(read.input).not.toEqual({});
      const error = new Error("some other failure");
      expect((await failed(hooks, read, "open-gajae", error)).error).toBe(error);
    },
    { sessionGetRejects: true },
  );
});

test("store and lookup errors inside execute.before and execute.after resolve (C10)", async () => {
  await fixture(
    async ({ root, store, hooks }) => {
      const id = nextSession("guard-errors");
      // A host permission block with no recorded block keeps the host's error.
      const permission = { error: { _tag: "Permission.BlockedError" } };
      expect(
        (await failed(hooks, { tool: "edit", sessionID: id, id: nextCall() }, "open-gajae-planner", permission)).error,
      ).toBe(permission);
      // A store failure while guarding blocks the call and resolves.
      store.resolveSessionDir = async () => {
        throw new Error("store failed");
      };
      const call = await writeCall(
        hooks,
        id,
        join(root, ".open-gajae", OTHER, "plans/p.md"),
      );
      expect(call.input).toEqual({});
      // A malformed event resolves too.
      await hooks.executeAfter(
        null as unknown as Parameters<RalplanHooks["executeAfter"]>[0],
      );
    },
    { sessionGetRejects: true },
  );
});

test("each notice carries a one-line TUI description naming its skill", async () => {
  await fixture(async (context) => {
    const ralplan = nextSession("desc-ralplan");
    await deliver(context, ralplan, "ralplan 계획 세워줘");
    const deep = nextSession("desc-deep");
    await deliver(context, deep, "@deep-interview todo 앱", {
      skills: ["deep-interview"],
    });
    const mentioned = nextSession("desc-mention");
    await deliver(context, mentioned, "plan the cache", {
      skills: ["ralplan"],
    });
    expect(context.synthetics.map((call) => call.description)).toEqual([
      "open-gajae: ralplan keyword notice added",
      "open-gajae: deep-interview keyword notice added",
      "open-gajae: ralplan mention notice added",
    ]);
  });
});


// ---------------------------------------------------------------------------
// Ralplan guard, entry and compaction cases, then the ultragoal revision plan
// S3 hooks (3e: A–M).
// ---------------------------------------------------------------------------

import { goalContextText } from "../src/goal/messages";
import { RALPLAN_RUNNING_REFUSAL } from "../src/ralplan-runtime/store";
import { createTools } from "../src/tools";
import {
  type LedgerEventFields,
  type LedgerRow,
  ledgerRow,
  serializeLedgerRow,
} from "../src/ultragoal-runtime/ledger";
import {
  ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE,
  ULTRAGOAL_RED_TEAM_FRAGMENT,
  ultragoalChainRefusal,
  ultragoalHandoffNotice,
  ultragoalKeywordNotice,
  ultragoalMentionNotice,
} from "../src/ultragoal-runtime/messages";
import { buildCompletionVerification } from "../src/ultragoal-runtime/receipt";

const UG = "ultragoal" as const;
const ugState = (store: StateStore, id: string) => stateOf(store, id, UG);

/** The `ralplan`, `ultragoal`, `goal` and `deep-interview` tools as the primary, over the fixture's hook lineage. */
function tools(context: Fixture) {
  const list = createTools(context.store, { locationDir: context.root, projectDir: context.root }, {
    rootSession: context.hooks.rootSession,
  });
  const call = (name: string) => async (sessionID: string, args: Record<string, unknown>) => {
    const tool = list.find((t) => t.name === name)!;
    return (await tool.execute(tool.input.parse(args) as never, { agent: "open-gajae", sessionID, signal: new AbortController().signal })).content;
  };
  return {
    ralplan: call("ralplan"),
    ultragoal: call("ultragoal"),
    goal: call("goal"),
    deepInterview: call("deep-interview"),
  };
}

const skillLoad = (sessionID: string, id = "ultragoal", agent: string | undefined = "open-gajae") => ({
  tool: "skill",
  sessionID,
  ...(agent === undefined ? {} : { agent }),
  id: nextCall(),
  input: { id } as unknown,
});

/** One `skill` call through `execute.before`; returns the event. */
async function load(hooks: RalplanHooks, sessionID: string, id = "ultragoal", agent?: string) {
  const event = skillLoad(sessionID, id, agent ?? "open-gajae");
  await hooks.executeBefore(event);
  return event;
}

/** One active row, or `undefined`. */
const activeRow = async (store: StateStore, sessionID: string, skill: string) =>
  readFile(join(await store.resolveSessionDir(sessionID), "state", "active", `${skill}.json`), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => undefined);

const GOALS = [{ title: "Goal 1", description: "do part 1", acceptanceCriteria: ["part 1 works"] }];

let ledgerSeq = 0;
const ledgerRows = (...fields: LedgerEventFields[]): LedgerRow[] =>
  fields.map((item) => ledgerRow(item, { eventId: `ev-${(ledgerSeq += 1)}`, timestamp: GOAL_AT }));
const PLAN_CREATED: LedgerEventFields = { event: "plan_created", goalIds: ["G001"], description: "ship" };
const ITERATE: LedgerEventFields = {
  event: "critic_verdict",
  terminus: "completion",
  verdict: "ITERATE",
  evidence: "gaps remain",
  blockers: ["a gap"],
};
const iterations = (count: number) => ledgerRows(...Array.from({ length: count }, () => ITERATE));
/** A final checkpoint whose gate carries critic OKAY (plan X-6). */
function finalOkay(): LedgerRow {
  const eventId = `ev-${(ledgerSeq += 1)}`;
  const gate = { criticReview: { verdict: "OKAY", evidence: "clean", blockers: [] } };
  const completionVerification = buildCompletionVerification({
    receiptKind: "final-aggregate",
    criteria: [{ id: "G001.AC1", text: "part 1 works" }],
    gate,
    checkpointLedgerEventId: eventId,
    verifiedAt: GOAL_AT,
  });
  return ledgerRow(
    { event: "goal_checkpointed", goalId: "G001", status: "complete", evidence: "done", qualityGateJson: gate, completionVerification },
    { eventId, timestamp: GOAL_AT },
  );
}
const appendLedger = (store: StateStore, sessionID: string, rows: LedgerRow[]) =>
  store.workflowTransaction(sessionID, async (tx) => {
    for (const row of rows) await tx.appendLine(tx.paths.ultragoal.ledger, serializeLedgerRow(row));
  });

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

test("(c) clear, then a write on the same run, leaves it finished: edits pass, no continuation (DR-3, R-OD9)", async () => {
  await fixture(async (context) => {
    const { root, store, hooks } = context;
    const id = nextSession("c");
    const { ralplan } = tools(context);
    await ralplan(id, { op: "start", task: "t" });
    expect((await toolCall(hooks, id, "edit", { path: join(root, "src/x.ts") })).input).toEqual({});
    await ralplan(id, { op: "clear" });
    expect(await ralplan(id, { op: "write", stage: "planner", stage_n: 1, content: "# p\n" })).not.toStartWith("Error:");
    const state = await stateOf(store, id, RALPLAN_MODE);
    expect(state).toMatchObject({ active: false, current_phase: "complete" });
    expect((await toolCall(hooks, id, "edit", { path: join(root, "src/x.ts") })).input).not.toEqual({});
    await succeeded(hooks, id);
    expect(continuations(context)).toHaveLength(0);
  });
});

test("(d) an active final or handoff keeps blocking edits outside a temp path; an active complete releases (C-2 R)", async () => {
  await fixture(async ({ root, store, hooks }) => {
    for (const phase of ["final", "handoff"]) {
      const id = nextSession(`d-${phase}`);
      await plan(store, id, { current_phase: phase });
      const call = await toolCall(hooks, id, "edit", { path: join(root, "src/x.ts") });
      expect(call.input).toEqual({});
      const message = ((await failed(hooks, call)).error as ToolError).message;
      expect(message).toContain("Ralplan planning phase boundary");
      expect(message).toContain("`ralplan clear`");
      expect((await writeCall(hooks, id, join(tmpdir(), `open-gajae-scratch-${phase}.md`))).input).not.toEqual({});
    }
    const released = nextSession("d-complete");
    await plan(store, released, { current_phase: "complete" });
    expect((await toolCall(hooks, released, "edit", { path: join(root, "src/x.ts") })).input).not.toEqual({});
  });
});

test("(e) a legacy ralplan state is unreadable: no guard, no continuation, `skill ultragoal` enters (DR-21)", async () => {
  await fixture(async (context) => {
    const { root, store, hooks } = context;
    const id = nextSession("e");
    await store.workflowTransaction(id, (tx) =>
      tx.writeModeState("ralplan", { active: true, current_phase: "ralplan" }, "ralplan_hook"),
    );
    const before = await raw(store, id);
    expect((await toolCall(hooks, id, "edit", { path: join(root, "src/x.ts") })).input).not.toEqual({});
    await succeeded(hooks, id);
    expect(continuations(context)).toHaveLength(0);
    expect((await load(hooks, id, "ralplan")).input).toEqual({ id: "ralplan" });
    expect((await load(hooks, id)).input).toEqual({ id: "ultragoal" });
    expect(await raw(store, id)).toBe(before);
    expect(await ugState(store, id)).toMatchObject({ active: true, current_phase: "goal-planning" });
  });
});

test("(f) compaction adds the ralplan recovery contract of an active run only (AC19)", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("f");
    const { ralplan } = tools(context);
    await ralplan(id, { op: "start", task: "t" });
    await ralplan(id, {
      op: "write",
      stage: "final",
      stage_n: 1,
      content: "# Plan\n\nShip the cache layer.\n\n## Scope\n- cache reads\n\n## Non-goals\n- cache writes\n\n## Acceptance criteria\n- hit rate logged\n\n## Intent Reconciliation\n- confirm the TTL\n",
    });
    const compact = async () => {
      const event = { sessionID: id, system: [] as { type: "text"; text: string }[] };
      await hooks.compaction(event);
      return event.system.map((part) => part.text);
    };
    const [text, ...rest] = await compact();
    expect(rest).toHaveLength(0);
    expect(text).toStartWith("<ralplan-compaction-context>");
    for (const line of [
      "Workflow contract (ralplan): Ship the cache layer.",
      "Accepted scope: cache reads",
      "Non-goals: cache writes",
      "Acceptance criteria: hit rate logged",
      "Intent Reconciliation: confirm the TTL",
      "Next action: awaiting-approval",
    ])
      expect(text).toContain(line);
    await ralplan(id, { op: "state", patch: { active: false } });
    expect(await compact()).toEqual([]);
    await ralplan(id, { op: "state", patch: { active: true } });
    expect(await compact()).toHaveLength(1);
    const stage = join(await store.resolveSessionDir(id), "plans", "ralplan", id, "stage-01-final.md");
    await writeFile(stage, "# Plan\n\nSomething else.\n");
    expect(await compact()).toEqual([]);
  });
});

test("(A) an active goal takes the goal path only; otherwise ralplan continues; only the root continues (D-TL6, C-2)", async () => {
  const id = nextSession("A-root");
  const child = nextSession("A-child");
  await fixture(
    async (context) => {
      const { store, hooks, synthetics } = context;
      await plan(store, id);
      await setGoal(store, id);
      await succeeded(hooks, id);
      expect(synthetics).toHaveLength(1);
      expect(synthetics[0]).toMatchObject({ sessionID: id, resume: true, description: "open-gajae: goal continuation" });
      expect(synthetics[0].text).toStartWith("<goal-continuation>\n\n<system-reminder>\nYou stopped while a goal is still active and uncleared.");
      expect(synthetics[0].text).toContain("<objective>\nship the feature\n</objective>");
      // No ralplan decision ran: its counter was never written.
      expect(await counter(store, id)).toBeUndefined();
      expect(await goalRecord(store, id)).toEqual({ goal_id: "g1", tool_less_turns: 0 });

      // A child's succeeded never continues, even with the root's goal active.
      await succeeded(hooks, child);
      expect(synthetics).toHaveLength(1);

      // Paused, complete, dropped or a corrupt goal state: the ralplan path.
      let count = 0;
      for (const goal of [{ status: "paused" }, { status: "complete" }, { status: "dropped" }, undefined]) {
        if (goal) await setGoal(store, id, goal);
        else await store.workflowTransaction(id, (tx) => tx.writeText(tx.paths.goalState, "{"));
        await succeeded(hooks, id);
        count += 1;
        expect(continuations(context).at(-1)).toContain(`[RALPLAN - CONSENSUS PLANNING | REINFORCEMENT ${count}/30]`);
      }
    },
    { parents: { [child]: id } },
  );
});

test("(A2) the goal continuation ignores the root request's agent (PQ-20 A)", async () => {
  await fixture(async (context) => {
    const { store, hooks, synthetics, agents } = context;
    const id = nextSession("A2");
    agents[id] = "build";
    await setGoal(store, id);
    await succeeded(hooks, id);
    expect(synthetics).toHaveLength(1);
    expect(synthetics[0]).toMatchObject({ resume: true, description: "open-gajae: goal continuation" });
  });
});

test("(B) three tool-less turns hold the goal loop, a real prompt releases it, and there is no iteration cap (D-TL5)", async () => {
  await fixture(async (context) => {
    const { store, hooks, synthetics } = context;
    const id = nextSession("B");
    await setGoal(store, id);
    // The host delivers `session.tool.called`, so tool-less turns count.
    await emit(hooks, "session.tool.called", "elsewhere");
    const turn = async (tools: number) => {
      await emit(hooks, "session.execution.started", id);
      for (let call = 0; call < tools; call += 1) await emit(hooks, "session.tool.called", id);
      await succeeded(hooks, id);
    };
    await turn(0);
    await turn(0);
    expect(continuations(context)).toHaveLength(2);
    expect(await goalRecord(store, id)).toEqual({ goal_id: "g1", tool_less_turns: 2 });
    await turn(0);
    const hold = synthetics.at(-1)!;
    expect(hold).toMatchObject({ resume: false, description: "open-gajae: goal continuation held (no_tool_progress)" });
    expect(hold.text).toStartWith("<goal-notice>");
    expect(hold.text).toContain("[GOAL CONTINUATION HELD - NO TOOL PROGRESS]");
    expect(hold.text).toContain("\nCause: no tool calls in the last 3 continuation turns.\n");
    expect(hold.text).toContain("Send a message to continue: any user message releases the hold.");
    expect(await goalRecord(store, id)).toMatchObject({ tool_less_turns: 3, held: { reason: "no_tool_progress" } });
    const count = synthetics.length;
    await turn(1);
    expect(synthetics.length).toBe(count);

    // A marker-only prompt does not release; a real prompt does.
    await notices(context, id, `x\n\n${hold.text}`);
    expect((await goalRecord(store, id)).held).toBeDefined();
    await notices(context, id, "keep going");
    expect(await goalRecord(store, id)).toEqual({ goal_id: "g1", tool_less_turns: 0 });
    for (let index = 0; index < 40; index += 1) await turn(1);
    expect(synthetics.length).toBe(count + 40);
    expect(synthetics.slice(count).every((call) => call.resume && call.description === "open-gajae: goal continuation")).toBe(true);
  });
});

test("(C) Esc stops the goal loop until a real prompt, and that turn's end resumes it (D-TL5)", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("C");
    await setGoal(store, id);
    await emit(hooks, "session.execution.interrupted", id, { reason: "user" });
    await succeeded(hooks, id);
    await succeeded(hooks, id);
    expect(continuations(context)).toHaveLength(0);
    await notices(context, id, `x\n\n${goalContextText("ship the feature")}`);
    await succeeded(hooks, id);
    expect(continuations(context)).toHaveLength(0);
    await notices(context, id, "이어서 해줘");
    await succeeded(hooks, id);
    expect(continuations(context)).toHaveLength(1);
    expect(await store.workflowTransaction(id, async (tx) => JSON.parse((await tx.readText(tx.paths.goalState))!).status)).toBe("active");
  });
});

test("(D) five non-OKAY critic verdicts hold the loop; only a hold is released and resets the count (PQ-3 A, (2)-b)", async () => {
  await fixture(async (context) => {
    const { store, hooks, synthetics } = context;
    const heldNotice = () => synthetics.at(-1)!;

    const s1 = nextSession("D-hold");
    await setGoal(store, s1);
    const first = [...ledgerRows(PLAN_CREATED), ...iterations(5)];
    await appendLedger(store, s1, first);
    await succeeded(hooks, s1);
    expect(heldNotice()).toMatchObject({ resume: false, description: "open-gajae: goal continuation held (critic_streak)" });
    expect(heldNotice().text).toContain("[GOAL CONTINUATION HELD - CRITIC STREAK]");
    expect(heldNotice().text).toContain("\nCause: 5 consecutive non-OKAY critic verdicts.\n");
    expect(heldNotice().text).toContain(
      "Send a message to continue: any user message releases the hold and resets the critic count.",
    );
    let count = synthetics.length;
    await succeeded(hooks, s1);
    expect(synthetics.length).toBe(count);
    await notices(context, s1, "keep going");
    expect(await goalRecord(store, s1)).toEqual({ goal_id: "g1", tool_less_turns: 0, critic_reset_after: first.at(-1)!.eventId });
    await succeeded(hooks, s1);
    expect(synthetics.at(-1)).toMatchObject({ resume: true, description: "open-gajae: goal continuation" });
    // The count restarts after the release marker: four more continue, five hold.
    await appendLedger(store, s1, iterations(4));
    await succeeded(hooks, s1);
    expect(synthetics.at(-1)?.resume).toBe(true);
    await appendLedger(store, s1, iterations(1));
    await succeeded(hooks, s1);
    expect(heldNotice().description).toBe("open-gajae: goal continuation held (critic_streak)");

    // Without a hold, a prompt leaves the count alone.
    const s2 = nextSession("D-no-hold");
    await setGoal(store, s2);
    await appendLedger(store, s2, [...ledgerRows(PLAN_CREATED), ...iterations(4)]);
    await notices(context, s2, "keep going");
    expect(await goalRecord(store, s2)).toBeUndefined();
    await appendLedger(store, s2, iterations(1));
    await succeeded(hooks, s2);
    expect(heldNotice()).toMatchObject({ sessionID: s2, description: "open-gajae: goal continuation held (critic_streak)" });

    // A final gate's critic OKAY breaks the streak, and so does a new plan.
    for (const breaker of [() => [finalOkay()], () => ledgerRows(PLAN_CREATED)]) {
      const id = nextSession("D-break");
      await setGoal(store, id);
      await appendLedger(store, id, [...ledgerRows(PLAN_CREATED), ...iterations(3), ...breaker(), ...iterations(4)]);
      count = synthetics.length;
      await succeeded(hooks, id);
      expect(synthetics.length).toBe(count + 1);
      expect(synthetics.at(-1)).toMatchObject({ sessionID: id, resume: true });
    }
  });
});

test("(E) the goal context goes in once per goal, again after a compaction drops it, on an exact single-part compare (D-TL4)", async () => {
  const child = nextSession("E-child");
  const id = nextSession("E-root");
  await fixture(
    async (context) => {
      const { store, hooks, synthetics } = context;
      const text = goalContextText("ship the feature");
      const request = async (messages: ReturnType<typeof user>[], agent = "open-gajae", sessionID = id) => {
        const event = { sessionID, agent, tools: { ralplan: {}, ultragoal: {}, goal: {}, read: {} }, messages };
        await hooks.context(event);
        return event;
      };
      // No goal yet: nothing.
      expect((await request([user("hi")])).messages).toHaveLength(1);
      await setGoal(store, id);
      const first = await request([user("hi")]);
      expect(first.messages).toEqual([user(text), user("hi")]);
      expect(synthetics).toEqual([
        { sessionID: id, text, description: "open-gajae: goal context added", resume: false },
      ]);
      // The next request already carries it: no second copy.
      const next = await request([user(text), { role: "assistant", content: [{ type: "text", text: "ok" }] }, user("go")]);
      expect(next.messages).toHaveLength(3);
      expect(synthetics).toHaveLength(1);
      // After a compaction the summary replaced it: in again, before the prompt.
      const compacted = await request([user("summary of earlier work"), user("go on")]);
      expect(compacted.messages.map((message) => message.content[0].text)).toEqual(["summary of earlier work", text, "go on"]);
      expect(synthetics).toHaveLength(2);
      // Only an exact single-part user text counts.
      const merged = { role: "user", content: [{ type: "text", text }, { type: "text", text: "and more" }] };
      expect((await request([merged, user("q")])).messages).toHaveLength(3);
      expect(synthetics).toHaveLength(3);
      // Another agent, a child session or a paused goal gets none.
      const build = await request([user("hi")], "build");
      expect(build.messages).toHaveLength(1);
      expect(Object.keys(build.tools)).toEqual(["read"]);
      await setGoal(store, child);
      expect((await request([user("hi")], "open-gajae", child)).messages).toHaveLength(1);
      await setGoal(store, id, { status: "paused" });
      expect((await request([user("hi")])).messages).toHaveLength(1);
      expect(synthetics).toHaveLength(3);
    },
    { parents: { [child]: id } },
  );
});

test("(F) while ultragoal is the visible primary, `skill ralplan` and `skill deep-interview` are refused until a handoff (D-HE3)", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("F");
    const { ultragoal } = tools(context);
    expect((await load(hooks, id)).input).toEqual({ id: "ultragoal" });
    for (const skill of ["ralplan", "deep-interview"]) {
      const call = await load(hooks, id, skill, "build");
      expect(call.input).toEqual({});
      expect(((await failed(hooks, call)).error as ToolError).message).toBe(ultragoalChainRefusal("goal-planning", skill));
    }
    await ultragoal(id, { op: "create", description: "ship", goals: GOALS });
    const refused = await load(hooks, id, "ralplan");
    expect(refused.input).toEqual({});
    expect(((await failed(hooks, refused)).error as ToolError).message).toBe(ultragoalChainRefusal("pending", "ralplan"));
    await ultragoal(id, { op: "handoff", to: "ralplan", reason: "the plan needs a new design" });
    expect((await load(hooks, id, "ralplan")).input).toEqual({ id: "ralplan" });
    expect(await stateOf(store, id, RALPLAN_MODE)).toMatchObject({ active: true, current_phase: "planner", handoff_from: "ultragoal" });
  });
});

test("(G) goal-planning refuses product edits outside a temp path; the ralplan guard follows the primary (D-HE5, PQ-13 A)", async () => {
  const id = nextSession("G-root");
  const child = nextSession("G-executor");
  await fixture(
    async (context) => {
      const { root, store, hooks } = context;
      const { ultragoal } = tools(context);
      await plan(store, id);
      const ralplanBlocked = await writeCall(hooks, id, join(root, "src/x.ts"));
      expect(((await failed(hooks, ralplanBlocked)).error as ToolError).message).toContain("Ralplan planning phase boundary");
      // A `skill ultragoal` load in another execution: ultragoal is primary.
      await load(hooks, id);
      for (const session of [id, child]) {
        const call = await writeCall(hooks, session, join(root, "src/x.ts"));
        expect(call.input).toEqual({});
        expect(((await failed(hooks, call)).error as ToolError).message).toBe(ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE);
        expect((await toolCall(hooks, session, "patch", { patchText: "*** Begin Patch\n*** Add File: src/y.ts\n+x\n*** End Patch" })).input).toEqual({});
        expect((await writeCall(hooks, session, join(tmpdir(), "open-gajae-goal-planning-scratch.md"))).input).not.toEqual({});
      }
      await ultragoal(id, { op: "create", description: "ship", goals: GOALS });
      // Ralplan is still active on planner, but not the primary: no guard.
      expect(await stateOf(store, id, RALPLAN_MODE)).toMatchObject({ active: true, current_phase: "planner" });
      for (const session of [id, child])
        expect((await writeCall(hooks, session, join(root, "src/x.ts"))).input).not.toEqual({});
    },
    { parents: { [child]: id } },
  );
});

test("(H) the keyword and mention only notify; `skill ultragoal` seeds goal-planning, its row, and removes upstream rows (D-HE4, DR-21)", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const { ultragoal } = tools(context);
    const id = nextSession("H");
    expect(await notices(context, id, "force: ultragoal add auth")).toEqual([ultragoalKeywordNotice()]);
    expect(await notices(context, id, "fix the flag", { skills: ["ultragoal"] })).toEqual([ultragoalMentionNotice()]);
    for (const text of ["ralph fix src/a.ts", "랄프 해줘", "ulw fix src/a.ts"]) expect(await notices(context, id, text)).toEqual([]);
    expect(await missing(store, id, UG)).toBe(true);
    // Only the primary's load seeds.
    await load(hooks, id, "ultragoal", "build");
    expect(await missing(store, id, UG)).toBe(true);

    // The load removes the ralplan and deep-interview rows and leaves ralplan's state.
    await plan(store, id);
    await store.workflowTransaction(id, (tx) =>
      syncActiveRowTx(tx, { skill: "deep-interview", active: true, phase: "interviewing", sessionId: id }, RUNTIME_OWNER),
    );
    expect((await load(hooks, id)).input).toEqual({ id: "ultragoal" });
    expect(await ugState(store, id)).toMatchObject({ skill: "ultragoal", active: true, current_phase: "goal-planning", version: 2 });
    expect(await activeRow(store, id, UG)).toMatchObject({ active: true, phase: "goal-planning", hud: { version: 1 } });
    expect(await activeRow(store, id, "ralplan")).toBeUndefined();
    expect(await activeRow(store, id, "deep-interview")).toBeUndefined();
    expect(await stateOf(store, id, RALPLAN_MODE)).toMatchObject({ active: true, current_phase: "planner" });
    const snapshot = JSON.parse(await readFile(join(await store.resolveSessionDir(id), "state", "skill-active-state.json"), "utf8"));
    expect(snapshot).toMatchObject({ skill: "ultragoal", phase: "goal-planning" });

    // PQ-5 (1) B: while ultragoal is primary, ralplan and deep-interview get the handoff notice.
    expect(await notices(context, id, "plan it", { skills: ["ralplan"] })).toEqual([ultragoalHandoffNotice("ralplan")]);
    expect(await notices(context, id, "ralplan 계획 세워줘")).toEqual([ultragoalHandoffNotice("ralplan")]);
    expect(await notices(context, id, "ask me", { skills: ["deep-interview"] })).toEqual([ultragoalHandoffNotice("deep-interview")]);
    expect(await notices(context, id, "딥인터뷰 하고 싶어")).toEqual([ultragoalHandoffNotice("deep-interview")]);

    // An active state keeps its phase; an inactive one is raised with its fields kept (deviation 35).
    await ultragoal(id, { op: "create", description: "ship", goals: GOALS });
    await load(hooks, id);
    expect(await ugState(store, id)).toMatchObject({ active: true, current_phase: "pending" });
    expect(await activeRow(store, id, UG)).toMatchObject({ phase: "pending" });
    await ultragoal(id, { op: "clear" });
    await load(hooks, id);
    expect(await ugState(store, id)).toMatchObject({ active: true, current_phase: "goal-planning", goals: [{ id: "G001" }] });
  });
});

test("(I) the turn gate hands off only within the execution that loaded ralplan (D-HE6, PQ-21 A)", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const { ralplan, ultragoal } = tools(context);
    const finished = async (id: string) => {
      await ralplan(id, { op: "start", task: "t" });
      await ralplan(id, { op: "write", stage: "final", stage_n: 1, content: "# f\n" });
    };

    // Same execution: `skill ralplan`, then `skill ultragoal` hands off (PQ-6 A).
    const same = nextSession("I-same");
    await finished(same);
    expect((await load(hooks, same, "ralplan")).input).toEqual({ id: "ralplan" });
    expect((await load(hooks, same)).input).toEqual({ id: "ultragoal" });
    expect(await stateOf(store, same, RALPLAN_MODE)).toMatchObject({ active: false, current_phase: "handoff", handoff_to: "ultragoal" });
    expect(await activeRow(store, same, "ralplan")).toMatchObject({ active: false, handoff_to: "ultragoal" });
    expect(await ugState(store, same)).toMatchObject({ active: true, current_phase: "goal-planning", handoff_from: "ralplan" });

    // The `@ralplan` mention marks the turn as well.
    const mentioned = nextSession("I-mention");
    await finished(mentioned);
    await notices(context, mentioned, "run it", { skills: ["ralplan"] });
    await load(hooks, mentioned);
    expect(await stateOf(store, mentioned, RALPLAN_MODE)).toMatchObject({ active: false, current_phase: "handoff" });

    // Any execution end clears the marker first: the next load enters directly.
    for (const [type, data] of [
      ["session.execution.succeeded", {}],
      ["session.execution.failed", { error: { type: "provider.invalid-request" } }],
      ["session.execution.interrupted", { reason: "user" }],
    ] as const) {
      const id = nextSession("I-next");
      await finished(id);
      await load(hooks, id, "ralplan");
      await emit(hooks, type, id, data);
      await load(hooks, id);
      expect(await stateOf(store, id, RALPLAN_MODE)).toMatchObject({ active: true, current_phase: "final" });
      expect(await activeRow(store, id, "ralplan")).toBeUndefined();
      const state = await ugState(store, id);
      expect(state).toMatchObject({ active: true, current_phase: "goal-planning" });
      expect(state).not.toHaveProperty("handoff_from");
    }

    // Outside T the load is refused, and a refused load sets no marker: once
    // ralplan finishes in the same execution, the next load hands off.
    const planning = nextSession("I-planning");
    await ralplan(planning, { op: "start", task: "t" });
    await load(hooks, planning, "ralplan");
    const refused = await load(hooks, planning);
    expect(refused.input).toEqual({});
    expect(((await failed(hooks, refused)).error as ToolError).message).toBe(RALPLAN_RUNNING_REFUSAL);
    expect(await missing(store, planning, UG)).toBe(true);
    await ralplan(planning, { op: "write", stage: "final", stage_n: 1, content: "# f\n" });
    await load(hooks, planning);
    expect(await stateOf(store, planning, RALPLAN_MODE)).toMatchObject({ active: false, current_phase: "handoff" });

    // A failed `skill ralplan` call reverts the marker.
    const reverted = nextSession("I-revert");
    await finished(reverted);
    await failed(hooks, await load(hooks, reverted, "ralplan"));
    await load(hooks, reverted);
    expect(await stateOf(store, reverted, RALPLAN_MODE)).toMatchObject({ active: true, current_phase: "final" });

    // An inactive `handoff` ralplan is not handed off again: the load enters (I-15).
    const inactive = nextSession("I-inactive");
    await finished(inactive);
    await ralplan(inactive, { op: "handoff", to: "ultragoal" });
    await ultragoal(inactive, { op: "clear" });
    expect((await load(hooks, inactive, "ralplan")).input).toEqual({ id: "ralplan" });
    expect((await load(hooks, inactive)).input).toEqual({ id: "ultragoal" });
    expect(await stateOf(store, inactive, RALPLAN_MODE)).toMatchObject({ active: false, current_phase: "handoff" });
    expect(await ugState(store, inactive)).toMatchObject({ active: true, current_phase: "goal-planning" });
  });
});

test("(I2) ralplan continues only while it is the visible primary skill (PQ-7 B)", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("I2");
    await plan(store, id);
    await succeeded(hooks, id);
    expect(continuations(context)).toHaveLength(1);
    // An ultragoal load in a later execution removes the ralplan row; ralplan stays active.
    await load(hooks, id);
    expect(await stateOf(store, id, RALPLAN_MODE)).toMatchObject({ active: true, current_phase: "planner" });
    await succeeded(hooks, id);
    await succeeded(hooks, id);
    expect(continuations(context)).toHaveLength(1);
    expect((await counter(store, id))?.breaker_count).toBe(1);
  });
});

test("(J) the red-team fragment rides only a marked executor assignment, once; no reviewer brief is appended (D-VF11)", async () => {
  await fixture(async (context) => {
    const { hooks } = context;
    const { ultragoal } = tools(context);
    const id = nextSession("J");
    await ultragoal(id, { op: "create", description: "ship", goals: GOALS });
    const subagent = (agent: string, prompt: string) => ({
      tool: "subagent",
      sessionID: id,
      id: nextCall(),
      input: { agent, description: "qa", prompt } as Record<string, unknown>,
    });
    const marked = subagent("open-gajae-executor", "[ultragoal-red-team] verify G001");
    await hooks.executeBefore(marked);
    expect(marked.input.prompt).toBe(`[ultragoal-red-team] verify G001\n\n${ULTRAGOAL_RED_TEAM_FRAGMENT}`);
    expect(ULTRAGOAL_RED_TEAM_FRAGMENT).toContain("Do not call `question`; report unresolved decisions and findings to the leader as blockers.");
    expect(ULTRAGOAL_RED_TEAM_FRAGMENT).not.toContain("record-review-blockers");
    expect(ULTRAGOAL_RED_TEAM_FRAGMENT).not.toContain("missing artifact refs");
    await hooks.executeBefore(marked);
    expect(marked.input.prompt).toBe(`[ultragoal-red-team] verify G001\n\n${ULTRAGOAL_RED_TEAM_FRAGMENT}`);
    for (const other of [
      subagent("open-gajae-executor", "implement G001"),
      subagent("open-gajae-architect", "[ultragoal-red-team] review G001"),
      subagent("open-gajae-critic", "please approve"),
    ]) {
      const before = other.input.prompt;
      await hooks.executeBefore(other);
      expect(other.input.prompt).toBe(before);
    }
  });
});

test("(K2, H5) C-11: goal, ultragoal and deep-interview belong to the primary alone; ralplan to the primary and its three roles", async () => {
  await fixture(async ({ hooks }) => {
    const offered = async (agent?: string, hook: "context" | "hideTools" = "hideTools") => {
      const event = {
        ...(agent === undefined ? {} : { agent }),
        tools: { ralplan: {}, ultragoal: {}, goal: {}, "deep-interview": {}, read: {} },
      };
      await hooks[hook](event);
      return Object.keys(event.tools).sort();
    };
    for (const hook of ["hideTools", "context"] as const) {
      for (const agent of ["build", "general", "plan", "my-agent", "open-gajae-executor", "open-gajae-cleaner", "open-gajae-lateral-reviewer", undefined])
        expect(await offered(agent, hook)).toEqual(["read"]);
      expect(await offered("open-gajae", hook)).toEqual(["deep-interview", "goal", "ralplan", "read", "ultragoal"]);
      for (const agent of ["open-gajae-planner", "open-gajae-architect", "open-gajae-critic"])
        expect(await offered(agent, hook)).toEqual(["ralplan", "read"]);
    }
    expect(() => hooks.hideTools({ agent: "build" })).not.toThrow();
  });
});

test("(L) compaction projects an active ultragoal run, not a paused goal or a terminal row; STALLED after unchanged recoveries (DR-17)", async () => {
  const id = nextSession("L-root");
  const child = nextSession("L-child");
  await fixture(
    async (context) => {
      const { store, hooks } = context;
      const { ultragoal } = tools(context);
      const compact = async (sessionID = id) => {
        const event = { sessionID, system: [] as { type: "text"; text: string }[] };
        await hooks.compaction(event);
        return event.system.map((part) => part.text);
      };
      expect(await compact()).toEqual([]);
      await ultragoal(id, { op: "create", description: "ship", goals: GOALS });
      await ultragoal(id, { op: "next" });
      const [first, ...rest] = await compact();
      expect(rest).toEqual([]);
      expect(first).toStartWith("<ultragoal-compaction-context>");
      for (const line of ["Workflow contract (ultragoal): Complete the durable ultragoal plan", "Current goal: G001 status=active do part 1", "Next action: continue-current-goal (G001)"])
        expect(first).toContain(line);
      expect(first).not.toContain("STALLED");
      await compact();
      expect((await compact())[0]).toContain("STALLED: durable progress has not changed across 3 compaction recoveries.");
      // Only the root's own compaction carries it.
      expect(await compact(child)).toEqual([]);
      // A paused goal omits it.
      const goal = await store.workflowTransaction(id, async (tx) => JSON.parse((await tx.readText(tx.paths.goalState))!));
      await setGoal(store, id, { ...goal, status: "paused" });
      expect(await compact()).toEqual([]);
      await setGoal(store, id, goal);
      expect(await compact()).toHaveLength(1);
      // A handed-off (inactive) row omits it, and so does a cleared one.
      await ultragoal(id, { op: "handoff", to: "ralplan", reason: "the plan needs a new design" });
      expect((await compact()).filter((text) => text.startsWith("<ultragoal-compaction-context>"))).toEqual([]);
      await ultragoal(id, { op: "status" });
      expect(await compact()).toHaveLength(1);
      await ultragoal(id, { op: "clear" });
      expect((await compact()).filter((text) => text.startsWith("<ultragoal-compaction-context>"))).toEqual([]);
    },
    { parents: { [child]: id } },
  );
});

test("(M, H8) handoff, create, goal, deep-interview ops, the turn gates, a continuation, a prompt, context, compaction and a state write all settle (C-1, P-AC6, P-AC7)", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const { ralplan, ultragoal, goal, deepInterview } = tools(context);
    const id = nextSession("M");
    await ralplan(id, { op: "start", task: "t" });
    await ralplan(id, { op: "write", stage: "final", stage_n: 1, content: "# f\n" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      Promise.allSettled([
        ralplan(id, { op: "handoff", to: "ultragoal" }),
        ultragoal(id, { op: "create", description: "ship", goals: GOALS }),
        goal(id, { op: "get" }),
        load(hooks, id),
        succeeded(hooks, id),
        hooks.prompt({ sessionID: id, prompt: { text: "keep going" } }),
        hooks.context({ sessionID: id, agent: "open-gajae", tools: {}, messages: [user("hi")] }),
        hooks.compaction({ sessionID: id, system: [] }),
        store.workflowTransaction(id, (tx) => tx.writeModeState("deep-interview", { note: "n" }, "deep_interview_tool")),
        deepInterview(id, { op: "status" }),
        deepInterview(id, { op: "doctor" }),
        load(hooks, id, "deep-interview"),
        load(hooks, id, "ralplan"),
      ]),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 5000);
      }),
    ]);
    clearTimeout(timer);
    expect(settled).not.toBe("timeout");
    expect((settled as PromiseSettledResult<unknown>[]).every((result) => result.status === "fulfilled")).toBe(true);
    expect(await stateOf(store, id, RALPLAN_MODE)).toMatchObject({ active: false, current_phase: "handoff" });
    expect(await ugState(store, id)).toMatchObject({ active: true });
  });
});

// ---------------------------------------------------------------------------
// Deep-interview revision plan S3a (§3.6 H1-H8): the edit guard, the
// continuation before the goal loop, the same-execution load gate, the
// compaction context, the entry and the spec guard.
// ---------------------------------------------------------------------------

import { chainRefusal, DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE, specGuardRefusal } from "../src/deep-interview-runtime/messages";
import { rebuildSnapshotTx } from "../src/skill-state/rows";

const diRound = (round: number) => ({
  round,
  round_key: `round-${round}`,
  lifecycle: "scored",
  question_text: `q${round}`,
  answer: `a${round}`,
  ambiguity: 0.4,
  scores: { goal: 0.6, constraints: 0.6, criteria: 0.6 },
});

/** An interview on `handoff` with a spec, through the tool. */
async function specced(context: Fixture, id: string) {
  const { deepInterview } = tools(context);
  await deepInterview(id, { op: "start", idea: "build a cli" });
  await deepInterview(id, { op: "write", input: { state: { rounds: [diRound(1)] } } });
  await deepInterview(id, { op: "spec", content: "# Spec\n", slug: "s" });
}

/** A fresh execution: clear the turn marker without a continuation. */
const newExecution = (hooks: RalplanHooks, sessionID: string) => emit(hooks, "session.execution.failed", sessionID);

const refusal = async (hooks: RalplanHooks, call: { tool: string; sessionID: string; id: string }) =>
  ((await failed(hooks, call)).error as ToolError).message;

test("(H1) the deep-interview edit guard blocks write/edit/patch outside a temp path on interviewing and handoff (DR-19, AC28)", async () => {
  const id = nextSession("H1-root");
  const child = nextSession("H1-child");
  await fixture(
    async (context) => {
      const { root, store, hooks } = context;
      const { deepInterview, ralplan } = tools(context);
      // No state: no guard.
      expect((await writeCall(hooks, id, join(root, "src/x.ts"))).input).not.toEqual({});
      await deepInterview(id, { op: "start", idea: "i" });
      for (const session of [id, child]) {
        const call = await writeCall(hooks, session, join(root, "src/x.ts"));
        expect(call.input).toEqual({});
        expect(await refusal(hooks, call)).toBe(DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE);
        expect((await toolCall(hooks, session, "edit", { path: join(root, "src/x.ts"), oldString: "a", newString: "b" })).input).toEqual({});
        expect((await toolCall(hooks, session, "patch", { patchText: "*** Begin Patch\n*** Add File: src/y.ts\n+x\n*** End Patch" })).input).toEqual({});
        expect((await writeCall(hooks, session, join(tmpdir(), "open-gajae-di-scratch.md"))).input).not.toEqual({});
      }
      // `handoff` keeps blocking (E1, K2).
      await deepInterview(id, { op: "spec", content: "# s", slug: "s" });
      expect((await writeCall(hooks, id, join(root, "src/x.ts"))).input).toEqual({});
      // An inactive interview or a corrupt state releases it.
      await deepInterview(id, { op: "state", patch: { active: false } });
      expect((await writeCall(hooks, id, join(root, "src/x.ts"))).input).not.toEqual({});
      await deepInterview(id, { op: "start", idea: "i" });
      await writeFile(join(await store.resolveSessionDir(id), "state", "deep-interview-state.json"), "{");
      expect((await writeCall(hooks, id, join(root, "src/x.ts"))).input).not.toEqual({});
      // A ralplan row outranks it: the ralplan guard decides (no deep-interview branch).
      await deepInterview(id, { op: "start", idea: "i" });
      await ralplan(id, { op: "start", task: "t" });
      await ralplan(id, { op: "state", patch: { active: false } });
      await store.workflowTransaction(id, (tx) =>
        syncActiveRowTx(tx, { skill: "ralplan", active: true, phase: "planner", sessionId: id }, RUNTIME_OWNER),
      );
      expect((await writeCall(hooks, id, join(root, "src/x.ts"))).input).not.toEqual({});
    },
    { parents: { [child]: id } },
  );
});

test("(H2) continuation: interviewing twice per prompt and before the goal; handoff holds both; a failed decision falls to the goal (DR-20, AC29)", async () => {
  await fixture(async (context) => {
    const { store, hooks, synthetics } = context;
    const { deepInterview } = tools(context);
    const id = nextSession("H2");
    await setGoal(store, id);
    await deepInterview(id, { op: "start", idea: "i" });
    await succeeded(hooks, id);
    await succeeded(hooks, id);
    await succeeded(hooks, id);
    expect(synthetics.map((s) => s.description)).toEqual([
      "open-gajae: deep-interview continuation 1/2",
      "open-gajae: deep-interview continuation 2/2",
    ]);
    expect(synthetics[0]).toMatchObject({ resume: true });
    expect(synthetics[0].text).toStartWith("<deep-interview-continuation>");
    expect(synthetics[1].text).toContain("(Continuation 2/2 for this prompt)");
    // The goal path never ran while deep-interview held it.
    expect(await goalRecord(store, id)).toBeUndefined();
    // A real prompt gives a fresh budget.
    await deliver(context, id, "my answer");
    await succeeded(hooks, id);
    expect(synthetics.at(-1)!.description).toBe("open-gajae: deep-interview continuation 1/2");
    // Esc stops it until the next real prompt.
    await emit(hooks, "session.execution.interrupted", id, { reason: "user" });
    const before = synthetics.length;
    await succeeded(hooks, id);
    expect(synthetics).toHaveLength(before);
    await deliver(context, id, "go on");
    // `handoff` (spec saved): neither deep-interview nor the goal continues.
    await deepInterview(id, { op: "spec", content: "# s", slug: "s" });
    const held = synthetics.length;
    await succeeded(hooks, id);
    expect(synthetics).toHaveLength(held);
    // After the handoff the goal resumes.
    await deepInterview(id, { op: "handoff", to: "ralplan" });
    await succeeded(hooks, id);
    expect(synthetics.at(-1)!.description).toBe("open-gajae: goal continuation");
    // An unreadable row makes the deep-interview decision fail: the goal path still runs.
    await deepInterview(id, { op: "clear" });
    await store.workflowTransaction(id, (tx) => tx.writeText(tx.paths.activeRow("deep-interview"), "{"));
    const count = synthetics.length;
    await succeeded(hooks, id);
    expect(synthetics).toHaveLength(count + 1);
    expect(synthetics.at(-1)!.description).toBe("open-gajae: goal continuation");
  });
});

test("(H3) the load gate in the deep-interview execution: refuse, hand off, link a finished interview, pass (DR-21, AC22)", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const { deepInterview, ralplan, ultragoal } = tools(context);
    const DI_FILE = "deep-interview";

    // interviewing refuses `skill ralplan` and `skill ultragoal` (no seed).
    const a = nextSession("H3-a");
    await deepInterview(a, { op: "start", idea: "i" });
    await load(hooks, a, "deep-interview");
    for (const skill of ["ralplan", "ultragoal"]) {
      const call = await load(hooks, a, skill);
      expect(call.input).toEqual({});
      expect(await refusal(hooks, call)).toBe(chainRefusal("interviewing", skill));
    }
    expect(await stateOf(store, a, "ultragoal")).toBeUndefined();
    // A later execution has no gate (K1); a non-primary agent never does.
    await newExecution(hooks, a);
    expect((await load(hooks, a, "ralplan")).input).toEqual({ id: "ralplan" });
    await newExecution(hooks, a);
    await load(hooks, a, "deep-interview", "build");
    expect((await load(hooks, a, "ralplan", "build")).input).toEqual({ id: "ralplan" });

    // U-1 A: an inactive interviewing, an unknown phase and no phase refuse.
    const u = nextSession("H3-u");
    await deepInterview(u, { op: "start", idea: "i" });
    await deepInterview(u, { op: "state", patch: { active: false } });
    await load(hooks, u, "deep-interview");
    // A cancelled interview's refusal points to clear or resume (deviation 30).
    const cancelled = await refusal(hooks, await load(hooks, u, "ralplan"));
    expect(cancelled).toBe(chainRefusal("interviewing", "ralplan", true));
    expect(cancelled).toContain("clear it with deep-interview clear first");
    for (const [phase, shown] of [["bogus", "bogus"], [undefined, "running"]] as const) {
      await store.workflowTransaction(u, (tx) =>
        tx.writeModeState(DI_FILE, { skill: DI_FILE, active: true, ...(phase ? { current_phase: phase } : {}) }, "deep_interview_tool"),
      );
      expect(await refusal(hooks, await load(hooks, u, "ralplan"))).toBe(chainRefusal(shown, "ralplan"));
    }

    // No state or a corrupt state passes (PQ-11 b=B).
    const n = nextSession("H3-n");
    await load(hooks, n, "deep-interview");
    expect((await load(hooks, n, "ralplan")).input).toEqual({ id: "ralplan" });
    await newExecution(hooks, n);
    await deepInterview(n, { op: "start", idea: "i" });
    await writeFile(join(await store.resolveSessionDir(n), "state", "deep-interview-state.json"), "{");
    await load(hooks, n, "deep-interview");
    expect((await load(hooks, n, "ralplan")).input).toEqual({ id: "ralplan" });

    // An active handoff with its spec hands off; with the spec gone it refuses.
    const h = nextSession("H3-h");
    await specced(context, h);
    await load(hooks, h, "deep-interview");
    expect((await load(hooks, h, "ralplan")).input).toEqual({ id: "ralplan" });
    expect(await stateOf(store, h, "ralplan")).toMatchObject({ active: true, current_phase: "planner", handoff_from: "deep-interview" });
    expect(await stateOf(store, h, DEEP_INTERVIEW_MODE)).toMatchObject({ active: false, current_phase: "handoff", handoff_to: "ralplan" });
    // Already handed off (inactive handoff): passes without a second handoff.
    await newExecution(hooks, h);
    await load(hooks, h, "deep-interview");
    expect((await load(hooks, h, "ralplan")).input).toEqual({ id: "ralplan" });
    const g = nextSession("H3-g");
    await specced(context, g);
    await rm(join(await store.resolveSessionDir(g), "specs", "deep-interview-s.md"));
    await load(hooks, g, "deep-interview");
    expect(await refusal(hooks, await load(hooks, g, "ralplan"))).toStartWith("open-gajae: deep-interview spec ");
    // `skill ultragoal` hands off too, without a goal-planning seed of its own.
    const ug = nextSession("H3-ug");
    await specced(context, ug);
    await load(hooks, ug, "deep-interview");
    expect((await load(hooks, ug, "ultragoal")).input).toEqual({ id: "ultragoal" });
    expect(await stateOf(store, ug, "ultragoal")).toMatchObject({ active: true, current_phase: "goal-planning", handoff_from: "deep-interview" });

    // PQ-11 E: a finished interview with a verified spec is linked, inactive or active.
    for (const finish of ["clear", "complete"] as const) {
      const f = nextSession(`H3-${finish}`);
      await specced(context, f);
      if (finish === "clear") await deepInterview(f, { op: "clear" });
      else await deepInterview(f, { op: "state", patch: { current_phase: "complete" } });
      await load(hooks, f, "deep-interview");
      expect((await load(hooks, f, "ralplan")).input).toEqual({ id: "ralplan" });
      expect(await stateOf(store, f, "ralplan")).toMatchObject({ active: true, current_phase: "planner", handoff_from: "deep-interview" });
      expect(await stateOf(store, f, DEEP_INTERVIEW_MODE)).toMatchObject({ active: false, current_phase: "handoff", handoff_to: "ralplan" });
      const rows = (await readFile(join(await store.resolveSessionDir(f), "state", "audit.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((row) => row.skill === "deep-interview" && ["handoff", "invalid_transition_detected"].includes(row.verb));
      // The caller is written inactive: one handoff row, no diagnostic (C4-11).
      expect(rows.map((row) => row.verb)).toEqual(["handoff"]);
    }
    // A4-6: every releasing phase links.
    for (const phase of ["completed", "failed", "cancelled", "canceled", "inactive"]) {
      const r = nextSession(`H3-${phase}`);
      await specced(context, r);
      const spec = await stateOf(store, r, DEEP_INTERVIEW_MODE);
      const { _meta, ...rest } = spec;
      await store.workflowTransaction(r, (tx) =>
        tx.writeModeState(DI_FILE, { ...rest, active: false, current_phase: phase }, "deep_interview_tool"),
      );
      await load(hooks, r, "deep-interview");
      expect((await load(hooks, r, "ralplan")).input).toEqual({ id: "ralplan" });
      expect(await stateOf(store, r, "ralplan")).toMatchObject({ handoff_from: "deep-interview" });
    }
    // A finished interview without a valid spec passes and changes nothing; for ultragoal the seed follows (A4-7).
    const m = nextSession("H3-m");
    await specced(context, m);
    await deepInterview(m, { op: "clear" });
    await writeFile(join(await store.resolveSessionDir(m), "specs", "deep-interview-s.md"), "edited\n");
    const before = await stateOf(store, m, DEEP_INTERVIEW_MODE);
    await load(hooks, m, "deep-interview");
    // DR-21: the failed link is logged, not refused.
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await load(hooks, m, "ralplan")).input).toEqual({ id: "ralplan" });
      expect(warn.mock.calls.map((call) => String(call[0]))).toContainEqual(
        expect.stringContaining("finished deep-interview not linked to ralplan: "),
      );
    } finally {
      warn.mockRestore();
    }
    expect(await stateOf(store, m, "ralplan")).toBeUndefined();
    expect(await stateOf(store, m, DEEP_INTERVIEW_MODE)).toEqual(before);
    expect((await load(hooks, m, "ultragoal")).input).toEqual({ id: "ultragoal" });
    expect(await stateOf(store, m, "ultragoal")).toMatchObject({ active: true, current_phase: "goal-planning" });
    expect((await stateOf(store, m, "ultragoal")).handoff_from).toBeUndefined();

    // PQ-36 C (K15): an active callee is linked anyway and returns to its start phase.
    const k = nextSession("H3-k");
    await specced(context, k);
    await deepInterview(k, { op: "clear" });
    await ralplan(k, { op: "start", task: "t" });
    await ralplan(k, { op: "write", stage: "planner", stage_n: 1, content: "# p\n" });
    await ralplan(k, { op: "state", patch: { current_phase: "architect" } });
    await load(hooks, k, "deep-interview");
    expect((await load(hooks, k, "ralplan")).input).toEqual({ id: "ralplan" });
    expect(await stateOf(store, k, "ralplan")).toMatchObject({ active: true, current_phase: "planner", run_id: k, handoff_from: "deep-interview" });
    expect(await Bun.file(join(await store.resolveSessionDir(k), "plans", "ralplan", k, "stage-01-planner.md")).exists()).toBe(true);
    const audit = (await readFile(join(await store.resolveSessionDir(k), "state", "audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.skill === "ralplan");
    expect(audit.slice(-2).map((row) => [row.verb, row.from_phase, row.to_phase])).toEqual([
      ["invalid_transition_detected", "architect", "planner"],
      ["handoff", "architect", "planner"],
    ]);
    // An active ultragoal returns to goal-planning: goals.json stays, product edits are refused (C4-1).
    const v = nextSession("H3-v");
    await specced(context, v);
    await deepInterview(v, { op: "clear" });
    await ultragoal(v, { op: "create", description: "ship", goals: GOALS });
    await ultragoal(v, { op: "next" });
    const goals = await readFile(join(await store.resolveSessionDir(v), "ultragoal", "goals.json"), "utf8");
    // While ultragoal is the visible primary, the chain guard refuses the
    // deep-interview load, so the gate meets an active ultragoal only when its
    // row is gone (here removed by hand).
    await newExecution(hooks, v);
    expect((await load(hooks, v, "deep-interview")).input).toEqual({});
    await store.workflowTransaction(v, async (tx) => {
      await tx.remove(tx.paths.activeRow("ultragoal"));
      await rebuildSnapshotTx(tx, RUNTIME_OWNER);
    });
    await newExecution(hooks, v);
    expect((await load(hooks, v, "deep-interview")).input).toEqual({ id: "deep-interview" });
    expect((await load(hooks, v, "ultragoal")).input).toEqual({ id: "ultragoal" });
    expect(await stateOf(store, v, "ultragoal")).toMatchObject({ active: true, current_phase: "goal-planning", handoff_from: "deep-interview" });
    expect(await readFile(join(await store.resolveSessionDir(v), "ultragoal", "goals.json"), "utf8")).toBe(goals);
    const blocked = await writeCall(hooks, v, join(context.root, "src/x.ts"));
    expect(blocked.input).toEqual({});
  });
});

test("(H4) compaction adds the deep-interview context while it is the active primary on a guard phase (DR-22, AC30)", async () => {
  const id = nextSession("H4-root");
  const child = nextSession("H4-child");
  await fixture(
    async (context) => {
      const { hooks } = context;
      const { deepInterview, ultragoal } = tools(context);
      const compact = async (sessionID = id) => {
        const event = { sessionID, system: [] as { type: "text"; text: string }[] };
        await hooks.compaction(event);
        return event.system.map((part) => part.text).filter((text) => text.startsWith("<deep-interview-compaction-context>"));
      };
      expect(await compact()).toEqual([]);
      await deepInterview(id, { op: "start", idea: "i" });
      await deepInterview(id, { op: "write", input: { state: { rounds: [diRound(1), diRound(2)] } } });
      const [text] = await compact();
      for (const line of ["phase interviewing", "rounds: 2", "ambiguity: 40% (threshold 5%)", "`deep-interview status`"])
        expect(text).toContain(line);
      expect(await compact(child)).toEqual([]);
      await deepInterview(id, { op: "spec", content: "# s", slug: "s" });
      expect((await compact())[0]).toContain("spec: ");
      await deepInterview(id, { op: "state", patch: { active: false } });
      expect(await compact()).toEqual([]);
      // A handed-over file without `state` reads as 0 rounds (A2-4).
      const h = nextSession("H4-h");
      await ultragoal(h, { op: "create", description: "ship", goals: GOALS });
      await ultragoal(h, { op: "handoff", to: "deep-interview", reason: "clarify the goal" });
      expect((await compact(h))[0]).toContain("rounds: 0");
    },
    { parents: { [child]: id } },
  );
});

test("(H6, H7) entry seeds nothing; the panel role gets no notice; deep-interview specs refuse direct writes (AC27, AC19)", async () => {
  await fixture(async (context) => {
    const { root, store, hooks } = context;
    const id = nextSession("H6");
    await notices(context, id, "deep interview me about the cli");
    await notices(context, id, "about the cli", { skills: ["deep-interview"] });
    await load(hooks, id, "deep-interview");
    expect(await stateOf(store, id, DEEP_INTERVIEW_MODE)).toBeUndefined();
    expect(await activeRow(store, id, "deep-interview")).toBeUndefined();
    const reviewer = nextSession("H6-reviewer");
    expect(await notices(context, reviewer, "ralplan this, then deep interview", { agent: "open-gajae-lateral-reviewer" })).toEqual([]);
    // H7: the spec files are the deep-interview tool's.
    const folder = basename(await store.resolveSessionDir(id));
    const spec = `.open-gajae/${folder}/specs/deep-interview-x.md`;
    const call = await writeCall(hooks, id, join(root, spec));
    expect(call.input).toEqual({});
    expect(await refusal(hooks, call)).toBe(specGuardRefusal(spec));
    expect((await writeCall(hooks, id, join(root, `.open-gajae/${folder}/specs/notes.md`))).input).not.toEqual({});
  });
});

test("(H9) cancel and resume: the guard and the continuation stop and come back; an open goal takes the turn after a cancel, as in GJC (deviation 30, K18)", async () => {
  await fixture(async (context) => {
    const { root, hooks, store, synthetics } = context;
    const { deepInterview } = tools(context);
    const id = nextSession("H9");
    await setGoal(store, id);
    await deepInterview(id, { op: "start", idea: "i" });
    expect((await writeCall(hooks, id, join(root, "src/x.ts"))).input).toEqual({});
    // Cancel: the edit guard is released and the goal continuation takes the turn.
    await deliver(context, id, "stop");
    await deepInterview(id, { op: "state", patch: { active: false } });
    expect((await writeCall(hooks, id, join(root, "src/x.ts"))).input).not.toEqual({});
    await succeeded(hooks, id);
    expect(synthetics.at(-1)!.description).toBe("open-gajae: goal continuation");
    // Resume: the guard and the deep-interview continuation are back.
    await deliver(context, id, "resume the interview");
    await deepInterview(id, { op: "state", patch: { active: true } });
    expect((await writeCall(hooks, id, join(root, "src/x.ts"))).input).toEqual({});
    await succeeded(hooks, id);
    expect(synthetics.at(-1)!.description).toBe("open-gajae: deep-interview continuation 1/2");
  });
});
