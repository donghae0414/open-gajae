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
 * of a session before delivering to it; `order` records each state write and
 * each `synthetic` call in sequence.
 */
function fakeSession(store: StateStore, options: FakeOptions, location: string) {
  const synthetics: Synthetic[] = [];
  const sessionGets: string[] = [];
  const agents: Record<string, string> = {};
  const order: string[] = [];
  const patch = store.patch.bind(store);
  store.patch = (async (...args: Parameters<StateStore["patch"]>) => {
    order.push("state");
    return patch(...args);
  }) as StateStore["patch"];
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
      order.push("synthetic");
      synthetics.push({ ...input });
      if (options.syntheticRejects) throw new Error("synthetic failed");
      return {};
    },
  };
  return { session, synthetics, sessionGets, agents, order };
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
    const { session, ...fake } = fakeSession(store, options, root);
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

function strip(state: Record<string, unknown> | undefined) {
  const copy = { ...(state ?? {}) };
  delete copy._meta;
  return copy;
}

test("a corrupt state file leaves every hook inert and the file byte-identical", async () => {
  await fixture(async (context) => {
    const { store, hooks, synthetics } = context;
    const id = nextSession("corrupt");
    const file = await store.statePath(id, RALPLAN_MODE);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "{", "utf8");

    expect(await notices(context, id, "unrelated question")).toHaveLength(0);
    // The keyword path fails at the seed write and resolves without a notice.
    expect(await notices(context, id, "랄플랜 정리해줘")).toHaveLength(0);
    await notices(context, id, "plan it", { skills: ["ralplan"] });
    await skillCall(hooks, id, { id: "ralplan" });

    expect(synthetics).toHaveLength(0);
    expect(await readFile(file, "utf8")).toBe("{");
  });
});

test("the ralplan keyword writes one notice and seeds awaiting state", async () => {
  await fixture(async (context) => {
    const { store } = context;
    for (const text of ["ralplan 계획 세워줘", "랄플랜 <task>"]) {
      const id = nextSession("keyword");
      const written = await notices(context, id, text);
      expect(written).toHaveLength(1);
      expect(written[0]).toContain("[MODE: RALPLAN]");
      expect(written[0].startsWith("<ralplan-notice>")).toBe(true);

      const state = await store.read(id, RALPLAN_MODE);
      expect(state?.active).toBe(true);
      expect(state?.awaiting_confirmation).toBe(true);
      expect(state?.current_phase).toBe("ralplan");
      expect(state?.breaker_count).toBe(0);
      expect(state?.started_at).toBe(state?.restored_at as string);
    }
  });
});

test("the keyword seed is written before the synthetic notice", async () => {
  await fixture(async (context) => {
    const id = nextSession("order");
    await notices(context, id, "ralplan 계획 세워줘");
    expect(context.order).toEqual(["state", "synthetic"]);
  });
});

test("a rejected synthetic appends the marked notice to the prompt and keeps the seed", async () => {
  await fixture(
    async (context) => {
      const { store } = context;
      const id = nextSession("synthetic-reject");
      const { event } = await deliver(context, id, "ralplan 계획 세워줘");
      expect(event.prompt.text.startsWith("ralplan 계획 세워줘\n\n")).toBe(true);
      expect(event.prompt.text).toContain("<ralplan-notice>");
      expect(event.prompt.text).toContain("[MODE: RALPLAN]");
      const seeded = await raw(store, id);
      expect((await store.read(id, RALPLAN_MODE))?.awaiting_confirmation).toBe(true);

      // The grown text fed back in is ignored by G2: no notice, no re-seed.
      const before = context.synthetics.length;
      const again = await deliver(context, id, event.prompt.text);
      expect(again.event.prompt.text).toBe(event.prompt.text);
      expect(context.synthetics.length).toBe(before);
      expect(await raw(store, id)).toBe(seeded);
    },
    { syntheticRejects: true },
  );
});

test("a @ralplan mention seeds confirmed state without a notice", async () => {
  await fixture(async (context) => {
    const { store } = context;
    const id = nextSession("mention");
    expect(
      await notices(context, id, "tidy the hooks", { skills: ["ralplan"] }),
    ).toHaveLength(0);
    const state = await store.read(id, RALPLAN_MODE);
    expect(state?.active).toBe(true);
    expect(state?.awaiting_confirmation).toBe(false);
    expect(state?.started_at).toBe(state?.restored_at as string);

    // An inactive leftover is re-armed, confirmed.
    const inactive = nextSession("mention-inactive");
    await seed(store, inactive, { active: false, current_phase: "ralplan" });
    await notices(context, inactive, "again", { skills: ["ralplan"] });
    const rearmed = await store.read(inactive, RALPLAN_MODE);
    expect(rearmed?.active).toBe(true);
    expect(rearmed?.awaiting_confirmation).toBe(false);

    // An active confirmed state is left exactly as it was.
    const confirmed = nextSession("mention-confirmed");
    await seed(store, confirmed, { active: true, awaiting_confirmation: false });
    const kept = await raw(store, confirmed);
    await notices(context, confirmed, "go on", { skills: ["ralplan"] });
    expect(await raw(store, confirmed)).toBe(kept);
  });
});

test("a stale awaiting seed followed by a @ralplan mention is confirmed, not cleared", async () => {
  await fixture(async (context) => {
    const { store } = context;
    const id = nextSession("mention-stale");
    await notices(context, id, "랄플랜 정리해줘");
    const before = await store.read(id, RALPLAN_MODE);
    expect(before?.awaiting_confirmation).toBe(true);

    expect(
      await notices(context, id, "this one", { skills: ["ralplan"] }),
    ).toHaveLength(0);
    const after = await store.read(id, RALPLAN_MODE);
    expect(strip(after)).toEqual({ ...strip(before), awaiting_confirmation: false });
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

test("the three role subagents are denied and everything else proceeds", async () => {
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

    // No agent on the session, and every other agent name, proceed.
    const undefinedAgent = nextSession("undefined-agent");
    const written = await notices(context, undefinedAgent, "랄플랜 정리해줘");
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("[MODE: RALPLAN]");
    expect((await store.read(undefinedAgent, RALPLAN_MODE))?.active).toBe(true);

    const otherAgent = nextSession("other-agent");
    expect(
      await notices(context, otherAgent, "랄플랜 정리해줘", { agent: "build" }),
    ).toHaveLength(1);
    expect((await store.read(otherAgent, RALPLAN_MODE))?.active).toBe(true);
  });
});

test("a failed agent lookup proceeds", async () => {
  await fixture(
    async (context) => {
      const id = nextSession("get-reject");
      expect(await notices(context, id, "랄플랜 정리해줘")).toHaveLength(1);
      expect((await context.store.read(id, RALPLAN_MODE))?.active).toBe(true);
    },
    { sessionGetRejects: true },
  );
});

test("restore fires on a real resume only, never on the turn after seeding", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const seeded = nextSession("post-seed");
    await notices(context, seeded, "랄플랜 정리해줘");
    await skillCall(hooks, seeded, { id: "ralplan" });
    // `restored_at` equals `started_at`, so this turn is not a resume.
    expect(await notices(context, seeded, "그럼 다음 단계로 가자")).toHaveLength(0);

    const resumed = nextSession("resume");
    // `started_at` strictly newer than `restored_at` is the definition of a resume.
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    await seed(store, resumed, {
      active: true,
      awaiting_confirmation: false,
      current_phase: "ralplan",
      started_at: startedAt,
      restored_at: new Date(Date.now() - 120_000).toISOString(),
    });
    context.order.length = 0;
    const first = await notices(context, resumed, "이어서 진행해줘");
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("[RALPLAN MODE RESTORED]");
    expect(first[0].startsWith("<session-restore>")).toBe(true);
    expect(first[0]).toContain(startedAt);
    // `restored_at` is written before the banner (Q3).
    expect(context.order).toEqual(["state", "synthetic"]);

    const advanced = await store.read(resumed, RALPLAN_MODE);
    expect(String(advanced?.restored_at) > startedAt).toBe(true);

    // Once per resume: the following message writes nothing.
    expect(await notices(context, resumed, "한 가지 더")).toHaveLength(0);
  });
});

test("the skill tool call confirms a seeded ralplan state and nothing else does", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("confirm");
    await notices(context, id, "랄플랜 정리해줘");
    const before = await store.read(id, RALPLAN_MODE);
    expect(before?.awaiting_confirmation).toBe(true);

    await skillCall(hooks, id, { id: "ralplan" });
    const after = await store.read(id, RALPLAN_MODE);
    expect(strip(after)).toEqual({ ...strip(before), awaiting_confirmation: false });

    // Every other shape leaves the file byte-identical, including the v1
    // `name` field.
    const untouched = await raw(store, id);
    await seed(store, id, { awaiting_confirmation: true });
    const reseeded = await raw(store, id);
    await skillCall(hooks, id, { id: "deep-interview" });
    await skillCall(hooks, id, { name: "ralplan" });
    await skillCall(hooks, id, undefined);
    await hooks.executeBefore({
      tool: "read",
      sessionID: id,
      id: nextCall(),
      input: { id: "ralplan" },
    });
    expect(await raw(store, id)).toBe(reseeded);
    expect(untouched).not.toBe(reseeded);

    // A session with no ralplan state neither throws nor creates a file.
    const empty = nextSession("confirm-empty");
    await skillCall(hooks, empty, { id: "ralplan" });
    expect(await missing(store, empty)).toBe(true);
  });
});

test("a store error inside the prompt hook or the skill confirm resolves", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("store-error");
    await seed(store, id, { active: true, awaiting_confirmation: true });
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

test("a stale seed is cleared by the next non-keyword message without a restore banner", async () => {
  await fixture(async (context) => {
    const { store } = context;
    const stale = nextSession("stale");
    await seed(store, stale, { active: true, awaiting_confirmation: true });
    expect(await notices(context, stale, "그건 됐고 다른 걸 해줘")).toHaveLength(0);
    expect(await missing(store, stale)).toBe(true);

    // Repeating the keyword keeps the seed and re-seeds idempotently.
    const repeated = nextSession("stale-keyword");
    await seed(store, repeated, { active: true, awaiting_confirmation: true });
    const untouched = await raw(store, repeated);
    const written = await notices(context, repeated, "랄플랜 계속");
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("[MODE: RALPLAN]");
    expect(await raw(store, repeated)).toBe(untouched);
    expect((await store.read(repeated, RALPLAN_MODE))?.active).toBe(true);

    // A confirmed session survives an ordinary message untouched.
    const confirmed = nextSession("confirmed");
    await seed(store, confirmed, { active: true, awaiting_confirmation: false });
    const kept = await raw(store, confirmed);
    expect(await notices(context, confirmed, "다른 파일도 봐줘")).toHaveLength(0);
    expect(await raw(store, confirmed)).toBe(kept);
  });
});

test("F1 — a stale seed then a real entry write never raises a restore banner", async () => {
  await fixture(async (context) => {
    const { store } = context;
    const id = nextSession("f1");
    // 1. Keyword seeds.
    expect(await notices(context, id, "랄플랜 정리해줘")).toHaveLength(1);
    expect((await store.read(id, RALPLAN_MODE))?.awaiting_confirmation).toBe(true);

    // 2. An unrelated message clears the stale seed.
    expect(await notices(context, id, "아니 그거 말고 빌드 로그 좀 봐줘")).toHaveLength(0);
    expect(await missing(store, id)).toBe(true);

    // 3. The skill's entry write re-creates the state.
    const stamp = new Date().toISOString();
    await store.write(
      id,
      {},
      {
        active: true,
        current_phase: "ralplan",
        awaiting_confirmation: false,
        started_at: stamp,
        restored_at: stamp,
      },
      RALPLAN_MODE,
    );

    // 4. The next real user message writes nothing.
    expect(await notices(context, id, "다음 단계 알려줘")).toHaveLength(0);

    // The same, with an entry write that omits both timestamps.
    const bare = nextSession("f1-bare");
    await store.write(
      bare,
      {},
      { active: true, current_phase: "ralplan", awaiting_confirmation: false },
      RALPLAN_MODE,
    );
    expect(await notices(context, bare, "다음 단계 알려줘")).toHaveLength(0);
    expect((await store.read(bare, RALPLAN_MODE))?.restored_at).toBeUndefined();
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

test("both keywords in one message write ralplan first, then deep-interview, and seed ralplan only", async () => {
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

    // Only ralplan seeds; deep-interview never writes state.
    expect((await store.read(id, RALPLAN_MODE))?.active).toBe(true);
    expect(await missing(store, id, DEEP_INTERVIEW_MODE)).toBe(true);
  });
});

// --- Continuation on durable execution events (Step 5) --------------------

const ACTIVE: ExplicitStatePatch = {
  active: true,
  awaiting_confirmation: false,
  current_phase: "ralplan",
};

test("a succeeded execution writes one resumed continuation and advances the breaker", async () => {
  await fixture(async (context) => {
    const { store, hooks, synthetics } = context;
    const id = nextSession("continue");
    await seed(store, id, ACTIVE);
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

    const state = await store.read(id, RALPLAN_MODE);
    expect(state?.breaker_count).toBe(1);
    expect(typeof state?.breaker_updated_at).toBe("string");
    expect(state?.active).toBe(true);
  });
});

test("awaiting, terminal and inactive states produce no continuation", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const awaiting = nextSession("awaiting");
    await seed(store, awaiting, {
      active: true,
      awaiting_confirmation: true,
      current_phase: "ralplan",
    });
    await succeeded(hooks, awaiting);

    const terminal = nextSession("terminal");
    await seed(store, terminal, {
      active: true,
      awaiting_confirmation: false,
      current_phase: "handoff:ralph",
      breaker_count: 7,
    });
    await succeeded(hooks, terminal);

    const inactive = nextSession("inactive");
    await seed(store, inactive, { active: false, current_phase: "ralplan" });
    await succeeded(hooks, inactive);

    // No state directory at all is a no-op too.
    const empty = nextSession("no-state");
    await succeeded(hooks, empty);

    expect(continuations(context)).toHaveLength(0);
    // A terminal phase resets the breaker instead of reinforcing.
    expect((await store.read(terminal, RALPLAN_MODE))?.breaker_count).toBe(0);
    expect((await store.read(awaiting, RALPLAN_MODE))?.breaker_count).toBeUndefined();
    expect(await missing(store, empty)).toBe(true);
  });
});

test("the thirty-first succeeded trips the circuit breaker and deactivates the state", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("breaker");
    await seed(store, id, ACTIVE);
    for (let turn = 0; turn < 31; turn += 1) await succeeded(hooks, id);

    const texts = continuations(context);
    expect(texts).toHaveLength(31);
    expect(texts[29]).toContain("REINFORCEMENT 30/30");
    expect(texts[30]).toContain("[RALPLAN CIRCUIT BREAKER]");
    expect(texts[30]).not.toContain("REINFORCEMENT");

    const state = await store.read(id, RALPLAN_MODE);
    expect(state?.active).toBe(false);
    expect(state?.deactivated_reason).toBe("stop_breaker_exhausted");
    expect(state?.breaker_count).toBe(0);
    expect(typeof state?.completed_at).toBe("string");

    // A deactivated state is inert on the next succeeded.
    await succeeded(hooks, id);
    expect(continuations(context)).toHaveLength(31);
  });
});

test("a breaker timestamp past the TTL restarts the count at one", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("ttl");
    await seed(store, id, {
      ...ACTIVE,
      breaker_count: 30,
      breaker_updated_at: new Date(Date.now() - 46 * 60 * 1000).toISOString(),
    });
    await succeeded(hooks, id);
    const texts = continuations(context);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("REINFORCEMENT 1/30");
    expect((await store.read(id, RALPLAN_MODE))?.breaker_count).toBe(1);
  });
});

test("two concurrent succeeded events produce a single continuation", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("inflight");
    await seed(store, id, ACTIVE);
    await Promise.all([succeeded(hooks, id), succeeded(hooks, id)]);
    expect(continuations(context)).toHaveLength(1);
    expect((await store.read(id, RALPLAN_MODE))?.breaker_count).toBe(1);
  });
});

test("a failed execution does not continue", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("failed");
    await seed(store, id, ACTIVE);
    await emit(hooks, "session.execution.failed", id, {
      error: { type: "provider.invalid-request", status: 400 },
    });
    expect(context.synthetics).toHaveLength(0);
    expect((await store.read(id, RALPLAN_MODE))?.breaker_count).toBeUndefined();
  });
});

test("a user or shutdown interrupt stops continuation until a real prompt (Q9)", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    for (const reason of ["user", "shutdown"]) {
      const id = nextSession(`interrupt-${reason}`);
      await seed(store, id, ACTIVE);
      await emit(hooks, "session.execution.interrupted", id, { reason });
      // Also a later host resume (subagent completion) that succeeds.
      await succeeded(hooks, id);
      await succeeded(hooks, id);
      expect(continuations(context)).toHaveLength(0);
      const state = await store.read(id, RALPLAN_MODE);
      expect(state?.breaker_count).toBeUndefined();
      expect(state?.active).toBe(true);

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
      await seed(store, id, ACTIVE);
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
    await seed(store, running, ACTIVE);
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
      await seed(store, parent, ACTIVE);
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
      expect((await store.read(parent, RALPLAN_MODE))?.breaker_count).toBe(1);
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
      await seed(store, foreign, ACTIVE);
      await emit(hooks, "session.execution.interrupted", foreign, { reason: "user" });
      await succeeded(hooks, foreign);
      await succeeded(hooks, foreign);
      expect(context.synthetics).toHaveLength(0);
      // One lookup per session, then cached.
      expect(sessionGets).toEqual([foreign]);

      // `session.created` supplies the location without a lookup.
      await seed(store, announced, ACTIVE);
      await emit(hooks, "session.created", announced, {
        location: { directory: "/work/project/sub" },
      });
      await succeeded(hooks, announced);
      expect(context.synthetics).toHaveLength(0);
      expect(sessionGets).toEqual([foreign]);
      expect((await store.read(foreign, RALPLAN_MODE))?.breaker_count).toBeUndefined();
    },
    { locations: { [foreign]: "/work/project/sub" } },
  );
});

test("a rejected synthetic does not escape the event handler", async () => {
  await fixture(
    async (context) => {
      const { store, hooks } = context;
      const id = nextSession("synthetic-reject-event");
      await seed(store, id, ACTIVE);
      await expect(succeeded(hooks, id)).resolves.toBeUndefined();
      expect(continuations(context)).toHaveLength(1);
      // The count stays incremented; the next succeeded is the retry.
      expect((await store.read(id, RALPLAN_MODE))?.breaker_count).toBe(1);
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
    await seed(store, id, { ...ACTIVE, current_phase: "handoff:ralph" });
    store.patch = (async () => {
      throw new Error("disk full");
    }) as StateStore["patch"];
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

test("started_at is written once and survives later hook writes", async () => {
  await fixture(async (context) => {
    const { store, hooks } = context;
    const id = nextSession("started-at");
    await notices(context, id, "ralplan 계획 세워줘");
    const seeded = await store.read(id, RALPLAN_MODE);
    // Awaiting: no continuation before the skill loads.
    await succeeded(hooks, id);
    expect(continuations(context)).toHaveLength(0);
    await skillCall(hooks, id, { id: "ralplan" });
    await succeeded(hooks, id);
    await notices(context, id, "ralplan 계속 진행");

    const after = await store.read(id, RALPLAN_MODE);
    expect(after?.started_at).toBe(seeded?.started_at as string);
    expect(after?.breaker_count).toBe(1);
    expect(continuations(context)).toHaveLength(1);
  });
});


// --- D2c session-scoped artifact guard ------------------------------------
// The static `edit` rules in src/config.ts pin planner writes to
// `.open-gajae/_session-*/(plans|drafts)/`; only this hook can pin the session.
// A block replaces the input with `{}` (the host's decode then fails) and
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
    const { session } = fakeSession(store, {}, sub);
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

test("the guard judges only session plans and drafts", async () => {
  await fixture(
    async ({ root, hooks, sessionGets }) => {
      const id = nextSession("guard-other-paths");
      // `session.get` rejects here, so any lookup at all would block.
      for (const path of [
        join(root, "src/x.ts"),
        join(root, ".open-gajae/open-gajae.jsonc"),
        join(root, ".open-gajae", OTHER, "specs/spec.md"),
        join(root, ".open-gajae", OTHER, "state/ralplan-state.json"),
        "src/x.ts",
        "/etc/passwd",
      ])
        expect((await writeCall(hooks, id, path)).input).not.toEqual({});
      // Tools that write no file are not inspected either.
      const read = await toolCall(hooks, id, "read", {
        path: join(root, ".open-gajae", OTHER, "plans/p.md"),
      });
      expect(read.input).not.toEqual({});
      expect(sessionGets).toHaveLength(0);
      // And their failures are left alone.
      const error = new Error("some other failure");
      expect((await failed(hooks, read, "open-gajae", error)).error).toBe(error);
    },
    { sessionGetRejects: true },
  );
});

test("a planner permission block is rewritten; other failures are left alone (C11)", async () => {
  await fixture(async ({ store, hooks }) => {
    const id = nextSession("guard-planner");
    const folder = await folderOf(store, id);
    const blockedError = () => ({
      _tag: "Tool.Error",
      message: "Unable to write outside/x.md",
      error: { _tag: "Permission.BlockedError", message: "Permission denied: edit" },
    });
    const call = { tool: "write", sessionID: id, id: nextCall() };
    const rewritten = await failed(
      hooks,
      call,
      "open-gajae-planner",
      blockedError(),
    );
    expect(rewritten.error).toBeInstanceOf(ToolError);
    expect((rewritten.error as ToolError).message).toContain(
      `(.open-gajae/${folder}/plans|drafts/)`,
    );
    // Another agent's permission block, a planner error of another kind, and a
    // non-artifact tool keep the host's error.
    const other = blockedError();
    expect((await failed(hooks, call, "open-gajae-critic", other)).error).toBe(
      other,
    );
    const plain = { _tag: "Tool.Error", message: "File not found" };
    expect((await failed(hooks, call, "open-gajae-planner", plain)).error).toBe(
      plain,
    );
    const shell = blockedError();
    expect(
      (
        await failed(
          hooks,
          { ...call, tool: "shell" },
          "open-gajae-planner",
          shell,
        )
      ).error,
    ).toBe(shell);
  });
});

test("store and lookup errors inside execute.before and execute.after resolve (C10)", async () => {
  await fixture(
    async ({ root, store, hooks }) => {
      const id = nextSession("guard-errors");
      // Lookup failure: the planner rewrite still happens, with a generic folder.
      const after = await failed(
        hooks,
        { tool: "edit", sessionID: id, id: nextCall() },
        "open-gajae-planner",
        { error: { _tag: "Permission.BlockedError" } },
      );
      expect((after.error as ToolError).message).toContain(
        "(.open-gajae/_session-*/plans|drafts/)",
      );
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

test("the guard leaves the ralplan skill confirmation path intact", async () => {
  await fixture(async (context) => {
    const { root, store, hooks } = context;
    const id = nextSession("guard-skill");
    await notices(context, id, "랄플랜 정리해줘");
    expect((await store.read(id, RALPLAN_MODE))?.awaiting_confirmation).toBe(
      true,
    );
    const folder = await folderOf(store, id);
    await writeCall(hooks, id, join(root, ".open-gajae", folder, "plans/p.md"));
    await skillCall(hooks, id, { id: "ralplan" });
    expect((await store.read(id, RALPLAN_MODE))?.awaiting_confirmation).toBe(
      false,
    );
  });
});

test("each notice carries a one-line TUI description naming its skill", async () => {
  await fixture(async (context) => {
    const ralplan = nextSession("desc-ralplan");
    await deliver(context, ralplan, "ralplan 계획 세워줘");
    const deep = nextSession("desc-deep");
    await deliver(context, deep, "@deep-interview todo 앱", {
      skills: ["deep-interview"],
    });
    expect(context.synthetics.map((call) => call.description)).toEqual([
      "open-gajae: ralplan keyword notice added",
      "open-gajae: deep-interview keyword notice added",
    ]);
  });
});
