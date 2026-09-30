import { test, expect } from "bun:test";
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
import {
  DEEP_INTERVIEW_MODE,
  RALPLAN_MODE,
  StateStore,
  type ExplicitStatePatch,
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

const seed = (store: StateStore, sessionID: string, patch: ExplicitStatePatch) =>
  store.patch(sessionID, patch, RALPLAN_MODE);

const raw = async (store: StateStore, sessionID: string) =>
  readFile(await store.statePath(sessionID, RALPLAN_MODE), "utf8");

async function missing(
  store: StateStore,
  sessionID: string,
  mode: StateMode = RALPLAN_MODE,
) {
  return fs
    .lstat(await store.statePath(sessionID, mode))
    .then(() => false)
    .catch(() => true);
}

/** Neither mode left a state file behind. */
async function noState(store: StateStore, sessionID: string) {
  return (
    (await missing(store, sessionID, RALPLAN_MODE)) &&
    (await missing(store, sessionID, DEEP_INTERVIEW_MODE))
  );
}

/** A ralplan state as the runtime writes it: a known phase and a run. */
const plan = (store: StateStore, sessionID: string, state: Record<string, unknown> = {}) =>
  store.ralplanTransaction(sessionID, (tx) =>
    tx.writeState({ active: true, current_phase: "planner", run_id: "run-1", ...state }, "ralplan_tool"),
  );

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
    const file = await store.statePath(id, RALPLAN_MODE);
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

test("other agents get no notice or seed but still lift the ultragoal pause (R-OD20)", async () => {
  await fixture(async (context) => {
    const { store } = context;
    const id = nextSession("build-agent");
    for (const text of ["랄플랜 정리해줘", "force: ultragoal add auth", "딥인터뷰 하고 싶어"])
      expect(await notices(context, id, text, { agent: "build" })).toHaveLength(0);
    expect(
      await notices(context, id, "plan", { agent: "build", skills: ["ralplan", "ultragoal", "deep-interview"] }),
    ).toHaveLength(0);
    expect(await noState(store, id)).toBe(true);
    expect(await ugState(store, id)).toBeUndefined();

    const paused = nextSession("build-paused");
    await ugSeed(store, paused, { paused_reason: "no_tool_progress", tool_less_turns: 3 });
    expect(await notices(context, paused, "keep going", { agent: "build" })).toHaveLength(0);
    expect(await ugState(store, paused)).toMatchObject({ tool_less_turns: 0 });
    expect((await ugState(store, paused))?.paused_reason).toBeUndefined();

    // A stale awaiting seed is still cleared; an @ultragoal mention runs no entry gate.
    const stale = nextSession("build-stale");
    await ugSeed(store, stale, { awaiting_confirmation: true });
    await notices(context, stale, "hello", { agent: "build" });
    expect(await ugState(store, stale)).toBeUndefined();
    const planned = nextSession("build-final");
    await plan(store, planned, { current_phase: "final" });
    await notices(context, planned, "go", { agent: "build", skills: ["ultragoal"] });
    expect(await store.read(planned, RALPLAN_MODE)).toMatchObject({ active: true, current_phase: "final" });
    expect(await ugState(store, planned)).toBeUndefined();
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
    store.read = failing as StateStore["read"];
    store.patch = failing as StateStore["patch"];
    store.clear = failing as StateStore["clear"];
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
    const state = await store.read(id, RALPLAN_MODE);
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

    const state = await store.read(id, RALPLAN_MODE);
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
    expect(audit[0]).toMatchObject({ owner: "open-gajae-hook", paths: [await store.statePath(id, RALPLAN_MODE)] });

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
      expect((await store.read(id, RALPLAN_MODE))?.active).toBe(true);

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
    const file = await store.statePath(id, RALPLAN_MODE);
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
// Ultragoal (plan §5, §6), then the plan S3 guard, gate and compaction cases.
// ---------------------------------------------------------------------------

import { RALPLAN_RUNNING_REFUSAL } from "../src/ralplan-runtime/store";
import { createTools } from "../src/tools";
import {
  CHAIN_GUARD_REFUSAL,
  isRalplanRunning,
  ralplanMentionNotice,
  ralplanRunningNotice,
  seedUltragoalState,
} from "../src/ultragoal";

const UG = "ultragoal" as const;
const ugState = (store: StateStore, id: string) => store.read(id, UG);
const ugSeed = (store: StateStore, id: string, extra: ExplicitStatePatch = {}) =>
  store.patch(id, { ...seedUltragoalState(undefined, new Date().toISOString(), { awaiting: false })!, ...extra }, UG);

/** Primary-side ultragoal tool calls against the fixture's store. */
function ultragoalTool(store: StateStore, root: string, parents: Record<string, string> = {}) {
  const tool = createTools(store, { locationDir: root, projectDir: root }, {
    async parentSession(id) {
      return parents[id];
    },
  }).find((t) => t.name === "ultragoal")!;
  return async (sessionID: string, args: Record<string, unknown>, agent = "open-gajae") =>
    (await tool.execute(tool.input.parse(args) as never, { agent, sessionID, signal: new AbortController().signal })).content;
}

test("ultragoal keyword seeds awaiting, the skill load confirms, the mention seeds confirmed; ralph does not", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const a = nextSession("ug-kw");
    const [notice] = await notices(context, a, "force: ultragoal add auth");
    expect(notice).toContain("[MODE: ULTRAGOAL]");
    expect(await ugState(store, a)).toMatchObject({ active: true, awaiting_confirmation: true, iteration: 1, max_iterations: 100 });
    await hooks.executeBefore({ tool: "skill", sessionID: a, agent: "open-gajae", id: nextCall(), input: { id: "ultragoal" } });
    expect((await ugState(store, a))?.awaiting_confirmation).toBe(false);
    const b = nextSession("ug-mention");
    await notices(context, b, "fix the flag in src/cli.ts", { skills: ["ultragoal"] });
    expect(await ugState(store, b)).toMatchObject({ active: true, awaiting_confirmation: false });
    const c = nextSession("ug-ralph");
    for (const text of ["ralph fix src/a.ts", "랄프 해줘", "ulw fix src/a.ts"])
      await notices(context, c, text);
    expect(await missing(store, c, UG)).toBe(true);
  });
});

test("with no gate, a vague ultragoal starts ultragoal; a prompt that also asks for ralplan does not", async () => {
  await fixture(async (context) => {
    const { store } = context;
    const cases: [{ skills?: string[] }, boolean][] = [[{}, true], [{ skills: ["ultragoal"] }, false]];
    for (const [options, awaiting] of cases) {
      const id = nextSession("nogate");
      const texts = await notices(context, id, "ultragoal로 계획대로 진행", options);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain("[MODE: ULTRAGOAL]");
      expect(await ugState(store, id)).toMatchObject({ active: true, awaiting_confirmation: awaiting });
      expect(await missing(store, id, RALPLAN_MODE)).toBe(true);
    }
    const both = nextSession("both");
    await notices(context, both, "ralplan then ultragoal add auth");
    expect(await missing(store, both, UG)).toBe(true);
  });
});

test("the ultragoal loop continues, extends, stops at the hard max and stays quiet when not running", async () => {
  await fixture(async (context) => {
    const { store, hooks, synthetics } = context;
    const id = nextSession("loop");
    await ugSeed(store, id);
    await succeeded(hooks, id);
    let last = synthetics.at(-1)!;
    expect(last).toMatchObject({ resume: true, description: "open-gajae: ultragoal continuation 2/100" });
    expect(last.text).toContain("[ULTRAGOAL - ITERATION 2/100]");
    expect(last.text).toContain("call `ultragoal` with op `create`");
    await store.patch(id, { iteration: 100 }, UG);
    await succeeded(hooks, id);
    last = synthetics.at(-1)!;
    expect(last.resume).toBe(true);
    expect(last.text).toContain("[ULTRAGOAL LOOP - EXTENDED] Max iterations reached; extending to 110");
    await store.patch(id, { iteration: 200, max_iterations: 200 }, UG);
    await succeeded(hooks, id);
    last = synthetics.at(-1)!;
    expect(last.resume).toBe(true);
    expect(last.text).toContain("[ULTRAGOAL LOOP - HARD LIMIT] Reached hard max iterations (200)");
    expect(await ugState(store, id)).toMatchObject({ active: false, deactivated_reason: "hard_limit" });
    const count = synthetics.length;
    await succeeded(hooks, id);
    for (const extra of [{ awaiting_confirmation: true }, { active: false, current_phase: "handoff" }, { active: false, current_phase: "complete" }]) {
      const other = nextSession("quiet");
      await ugSeed(store, other, extra);
      await succeeded(hooks, other);
    }
    const stopped = nextSession("stopped");
    await ugSeed(store, stopped);
    await emit(hooks, "session.execution.interrupted", stopped, { reason: "user" });
    await succeeded(hooks, stopped);
    expect(synthetics.length).toBe(count);
  });
});

test("three tool-less turns pause the loop and a user prompt resumes it; a child's tool call keeps the parent waiting", async () => {
  await fixture(
    async (context) => {
      const { store, hooks, synthetics } = context;
      const id = "sess-parent";
      await ugSeed(store, id);
      await emit(hooks, "session.tool.called", "elsewhere");
      for (let turn = 0; turn < 3; turn += 1) {
        await emit(hooks, "session.execution.started", id);
        await succeeded(hooks, id);
      }
      const pause = synthetics.at(-1)!;
      expect(pause).toMatchObject({ resume: false, description: "open-gajae: ultragoal paused (no_tool_progress)" });
      expect(pause.text).toContain("[ULTRAGOAL PAUSED - NO TOOL PROGRESS]");
      const count = synthetics.length;
      await succeeded(hooks, id);
      expect(synthetics.length).toBe(count);
      await notices(context, id, "keep going");
      expect(await ugState(store, id)).toMatchObject({ tool_less_turns: 0 });
      expect((await ugState(store, id))?.paused_reason).toBeUndefined();
      await emit(hooks, "session.execution.started", id);
      await emit(hooks, "session.tool.called", id);
      await succeeded(hooks, id);
      expect(synthetics.at(-1)?.resume).toBe(true);

      // AC19: the child's tool call does not release the parent's wait.
      await emit(hooks, "session.execution.started", "child-1");
      await emit(hooks, "session.tool.called", "child-1");
      const before = synthetics.length;
      await succeeded(hooks, id);
      expect(synthetics.length).toBe(before);
    },
    { parents: { "child-1": "sess-parent" } },
  );
});

test("reject ceiling pauses, a user prompt resets the target; an ultragoal turn still resets a finished ralplan's breaker", async () => {
  await fixture(async (context) => {
    const { store, hooks, synthetics } = context;
    const id = nextSession("ceiling");
    await ugSeed(store, id, { reject_counts: { G001: 3 } });
    await plan(store, id, { current_phase: "handoff" });
    await setCounter(store, id, { run_id: "run-1", breaker_count: 5, breaker_updated_at: new Date().toISOString() });
    await succeeded(hooks, id);
    expect(synthetics.at(-1)!.text).toContain("Goal G001 was rejected 3 times in a row");
    expect((await counter(store, id))?.breaker_count).toBe(0);
    await notices(context, id, "try again");
    const state = await ugState(store, id);
    expect(state?.reject_counts).toBeUndefined();
    expect(state?.paused_reason).toBeUndefined();
  });
});

test("one mode at a time: chain guard, @ralplan notice, silent ralplan keyword, and Q-1 while ralplan runs", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("modes");
    await ugSeed(store, id);
    const call = { tool: "skill", sessionID: id, id: nextCall(), input: { id: "ralplan" } as unknown };
    await hooks.executeBefore(call);
    expect(call.input).toEqual({});
    const after = await failed(hooks, call);
    expect(String((after.error as Error).message)).toBe(CHAIN_GUARD_REFUSAL);
    expect(await notices(context, id, "rethink this", { skills: ["ralplan"] })).toEqual([ralplanMentionNotice()]);
    expect(await notices(context, id, "ralplan this again")).toEqual([]);
    expect(await missing(store, id, RALPLAN_MODE)).toBe(true);
    // After a handoff the skill loads normally.
    await store.patch(id, { active: false, current_phase: "handoff" }, UG);
    const allowed = { tool: "skill", sessionID: id, id: nextCall(), input: { id: "ralplan" } as unknown };
    await hooks.executeBefore(allowed);
    expect(allowed.input).toEqual({ id: "ralplan" });

    const planning = nextSession("q1");
    await plan(store, planning);
    expect(await notices(context, planning, "force: ultragoal fix it")).toEqual([ralplanRunningNotice()]);
    expect(await missing(store, planning, UG)).toBe(true);
  });
});

test("the reviewer brief is appended only to the pending reviewer's call from the ultragoal session", async () => {
  await fixture(async (context) => {
    const { store, hooks, root } = context;
    const id = nextSession("brief");
    const call = ultragoalTool(store, root);
    await ugSeed(store, id);
    await call(id, { op: "create", description: "task", goals: [{ title: "g", description: "d", priority: 1, acceptanceCriteria: ["works"] }] });
    const subagent = (agent: string, sessionID = id) => ({ tool: "subagent", sessionID, id: nextCall(), input: { agent, description: "review", prompt: "please approve" } as Record<string, unknown> });
    const early = subagent("open-gajae-architect");
    await hooks.executeBefore(early);
    expect(early.input.prompt).toBe("please approve");
    await call(id, { op: "complete", goal_id: "G001", implementation: ["x"], files_changed: ["y"], learnings: ["z"] });
    const review = subagent("open-gajae-architect");
    await hooks.executeBefore(review);
    const prompt = String(review.input.prompt);
    expect(prompt).toStartWith("please approve\n\n<ultragoal-verification-brief>");
    for (const part of ["1. works", 'goal_id "G001"', "Use a new subagent session for each review.", "verify independently and skeptically"])
      expect(prompt).toContain(part);
    for (const other of [subagent("open-gajae-critic"), subagent("open-gajae-architect", "some-child")]) {
      await hooks.executeBefore(other);
      expect(other.input.prompt).toBe("please approve");
    }
  });
});

test("ultragoal files are blocked for write tools and compaction carries the running loop", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("owned");
    const folder = await folderOf(store, id);
    for (const path of [`.open-gajae/${folder}/ultragoal/goals.json`, `.open-gajae/${folder}/state/ultragoal-state.json`]) {
      const call = await writeCall(hooks, id, path);
      expect(call.input).toEqual({});
      const after = await failed(hooks, call);
      expect(String((after.error as Error).message)).toContain("is ultragoal-owned; change it only through the ultragoal tool");
    }
    const event = { sessionID: id, system: [] as { type: "text"; text: string }[] };
    await hooks.compaction(event);
    expect(event.system).toHaveLength(0);
    await ugSeed(store, id);
    await hooks.compaction(event);
    expect(event.system).toHaveLength(1);
    expect(event.system[0].text).toStartWith("<ultragoal-compaction-context>");
  });
});

/** `ralplan` tool calls as the primary, over the fixture's hook lineage. */
function ralplanCalls(context: Fixture) {
  const tool = createTools(context.store, { locationDir: context.root, projectDir: context.root }, {
    parentSession: context.hooks.parentSession,
    rootSession: context.hooks.rootSession,
  }).find((t) => t.name === "ralplan")!;
  return async (sessionID: string, args: Record<string, unknown>) =>
    (await tool.execute(tool.input.parse(args) as never, { agent: "open-gajae", sessionID, signal: new AbortController().signal })).content;
}

const skillLoad = (sessionID: string, id = "ultragoal") => ({
  tool: "skill",
  sessionID,
  agent: "open-gajae",
  id: nextCall(),
  input: { id } as unknown,
});

const GOAL = { title: "g", description: "d", priority: 1, acceptanceCriteria: ["works"] };

test("(a) R-O7: while ultragoal runs at the root the planning guard steps aside; runtime-owned paths stay refused", async () => {
  const id = nextSession("a-root");
  const child = nextSession("a-executor");
  await fixture(
    async ({ root, store, hooks }) => {
      const folder = await folderOf(store, id);
      await plan(store, id);
      await ugSeed(store, id);
      for (const session of [id, child]) {
        expect((await writeCall(hooks, session, join(root, "src/x.ts"))).input).not.toEqual({});
        for (const path of [
          `.open-gajae/${folder}/plans/ralplan/run-1/stage-01-planner.md`,
          `.open-gajae/${folder}/state/ralplan-state.json`,
          `.open-gajae/${folder}/ultragoal/goals.json`,
        ])
          expect((await writeCall(hooks, session, path)).input).toEqual({});
      }
      await store.patch(id, { active: false, current_phase: "handoff" }, UG);
      for (const session of [id, child])
        expect((await writeCall(hooks, session, join(root, "src/x.ts"))).input).toEqual({});
    },
    { parents: { [child]: id } },
  );
});

test("(b) R-O9: a running ultragoal passes the entry gate without touching ralplan; otherwise ralplan planning refuses it", async () => {
  await fixture(async ({ root, store, hooks }) => {
    const id = nextSession("b");
    const call = ultragoalTool(store, root);
    await plan(store, id);
    await ugSeed(store, id);
    const before = await raw(store, id);
    const load = skillLoad(id);
    await hooks.executeBefore(load);
    expect(load.input).toEqual({ id: "ultragoal" });
    expect(await call(id, { op: "create", description: "task", goals: [GOAL] })).toStartWith("Created");
    expect(await raw(store, id)).toBe(before);
    await store.patch(id, { active: false, current_phase: "handoff" }, UG);
    const refused = skillLoad(id);
    await hooks.executeBefore(refused);
    expect(refused.input).toEqual({});
    expect(await call(id, { op: "create", description: "task", goals: [GOAL], replace: true })).toBe(`Error: ${RALPLAN_RUNNING_REFUSAL}`);
    expect(await raw(store, id)).toBe(before);
  });
});

test("(c) clear, then a write on the same run, leaves it finished: edits pass, no continuation (DR-3, R-OD9)", async () => {
  await fixture(async (context) => {
    const { root, store, hooks } = context;
    const id = nextSession("c");
    const ralplan = ralplanCalls(context);
    await ralplan(id, { op: "start", task: "t" });
    expect((await toolCall(hooks, id, "edit", { path: join(root, "src/x.ts") })).input).toEqual({});
    await ralplan(id, { op: "clear" });
    expect(await ralplan(id, { op: "write", stage: "planner", stage_n: 1, content: "# p\n" })).not.toStartWith("Error:");
    const state = await store.read(id, RALPLAN_MODE);
    expect(state).toMatchObject({ active: false, current_phase: "complete" });
    expect(isRalplanRunning(state)).toBe(false);
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

test("(e) a legacy ralplan state is unreadable: no guard, no continuation, the gate passes (DR-21)", async () => {
  await fixture(async (context) => {
    const { root, store, hooks } = context;
    const id = nextSession("e");
    await seed(store, id, { active: true, current_phase: "ralplan" });
    const before = await raw(store, id);
    expect((await toolCall(hooks, id, "edit", { path: join(root, "src/x.ts") })).input).not.toEqual({});
    await succeeded(hooks, id);
    expect(continuations(context)).toHaveLength(0);
    const load = skillLoad(id);
    await hooks.executeBefore(load);
    expect(load.input).toEqual({ id: "ultragoal" });
    expect(await raw(store, id)).toBe(before);
  });
});

test("(f) compaction adds the ralplan recovery contract of an active run only (AC19)", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("f");
    const ralplan = ralplanCalls(context);
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

test("(i) an @ultragoal mention hands off a finished ralplan, and gets only the notice while it plans (C-4)", async () => {
  await fixture(async (context) => {
    const { store } = context;
    const id = nextSession("i");
    const ralplan = ralplanCalls(context);
    await ralplan(id, { op: "start", task: "t" });
    expect(await notices(context, id, "run it", { skills: ["ultragoal"] })).toEqual([ralplanRunningNotice()]);
    expect(await missing(store, id, UG)).toBe(true);
    await ralplan(id, { op: "write", stage: "final", stage_n: 1, content: "# f\n" });
    const [notice] = await notices(context, id, "run it", { skills: ["ultragoal"] });
    expect(notice).toContain("[MODE: ULTRAGOAL]");
    const state = await store.read(id, RALPLAN_MODE);
    expect(state).toMatchObject({ active: false, current_phase: "handoff", handoff_to: "ultragoal" });
    expect(await Bun.file(join(await store.resolveSessionDir(id), "state", "active", "ralplan.json")).exists()).toBe(false);
    expect(await ugState(store, id)).toMatchObject({ active: true, awaiting_confirmation: false, handoff_from: "ralplan", handoff_at: state?.handoff_at });
  });
});

test("(j) a keyword's awaiting seed, then `skill ultragoal` over a finished ralplan: handed off, confirmed, meta merged", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("j");
    const ralplan = ralplanCalls(context);
    await ralplan(id, { op: "start", task: "t" });
    await ralplan(id, { op: "write", stage: "final", stage_n: 1, content: "# f\n" });
    expect(await notices(context, id, "force: ultragoal fix it")).toHaveLength(1);
    expect(await ugState(store, id)).toMatchObject({ active: true, awaiting_confirmation: true });
    expect(await store.read(id, RALPLAN_MODE)).toMatchObject({ active: true, current_phase: "final" });
    const load = skillLoad(id);
    await hooks.executeBefore(load);
    expect(load.input).toEqual({ id: "ultragoal" });
    expect(await store.read(id, RALPLAN_MODE)).toMatchObject({ active: false, current_phase: "handoff" });
    expect(await ugState(store, id)).toMatchObject({ active: true, awaiting_confirmation: false, handoff_from: "ralplan" });
  });
});

test("(k) through gate ④, `ultragoal start` logs START and starts, and `resume` logs RESUME", async () => {
  await fixture(async (context) => {
    const { root, store } = context;
    const ralplan = ralplanCalls(context);
    const call = ultragoalTool(store, root);
    const progress = async (id: string) =>
      readFile(join(await store.resolveSessionDir(id), "ultragoal", "progress.txt"), "utf8");
    const a = nextSession("k-start");
    await ralplan(a, { op: "start", task: "t" });
    await ralplan(a, { op: "write", stage: "final", stage_n: 1, content: "# f\n" });
    expect(await call(a, { op: "start", reason: "run the plan" })).toContain("Ultragoal started");
    expect(await store.read(a, RALPLAN_MODE)).toMatchObject({ active: false, current_phase: "handoff" });
    expect(await ugState(store, a)).toMatchObject({ active: true, handoff_from: "ralplan" });
    expect(await progress(a)).toContain("- START");

    const b = nextSession("k-resume");
    await ugSeed(store, b);
    await call(b, { op: "create", description: "task", goals: [GOAL] });
    expect(await call(b, { op: "handoff", to: "ralplan", reason: "replan" })).toContain("ralplan started");
    await ralplan(b, { op: "write", stage: "final", stage_n: 1, content: "# f\n" });
    expect(await call(b, { op: "resume", reason: "back" })).toContain("Resumed");
    expect(await store.read(b, RALPLAN_MODE)).toMatchObject({ active: false, current_phase: "handoff" });
    expect(await progress(b)).toContain("- RESUME");
  });
});

test("(l) the C-4 refusal blocks `skill ultragoal` by invalidating its input, and the failure is rewritten", async () => {
  await fixture(async ({ store, hooks }) => {
    const id = nextSession("l");
    await plan(store, id);
    const load = skillLoad(id);
    await hooks.executeBefore(load);
    expect(load.input).toEqual({});
    expect(((await failed(hooks, load)).error as ToolError).message).toBe(RALPLAN_RUNNING_REFUSAL);
    expect(await missing(store, id, UG)).toBe(true);
  });
});

test("K1 — C-11: other agents lose ralplan and ultragoal; owners keep the ones they own", async () => {
  await fixture(async ({ hooks }) => {
    const offered = (agent?: string) => {
      const event = {
        ...(agent === undefined ? {} : { agent }),
        tools: { ralplan: {}, ultragoal: {}, read: {} },
      };
      hooks.context(event);
      return Object.keys(event.tools).sort();
    };
    for (const agent of ["build", "general", "plan", "my-agent", "open-gajae-executor", undefined])
      expect(offered(agent)).toEqual(["read"]);
    expect(offered("open-gajae")).toEqual(["ralplan", "read", "ultragoal"]);
    expect(offered("open-gajae-planner")).toEqual(["ralplan", "read"]);
    expect(offered("open-gajae-architect")).toEqual(["ralplan", "read", "ultragoal"]);
    expect(offered("open-gajae-critic")).toEqual(["ralplan", "read", "ultragoal"]);
    expect(() => hooks.context({ agent: "build" })).not.toThrow();
  });
});
