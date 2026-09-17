import { test, expect, setSystemTime } from "bun:test";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import { createHooks, type RalplanClient, type RalplanHooks } from "../src/hooks";
import { continuationMessage } from "../src/ralplan";
import { RALPLAN_MODE, StateStore, type ExplicitStatePatch } from "../src/state";

type ChatInput = Parameters<NonNullable<Hooks["chat.message"]>>[0];
type ChatOutput = Parameters<NonNullable<Hooks["chat.message"]>>[1];
type ChatPart = ChatOutput["parts"][number];
type EventInput = Parameters<NonNullable<Hooks["event"]>>[0];
type ToolOutput = Parameters<NonNullable<Hooks["tool.execute.before"]>>[1];
type CommandOutput = Parameters<NonNullable<Hooks["command.execute.before"]>>[1];

type PromptBody = {
  agent?: string;
  model?: { providerID: string; modelID: string };
  parts: Array<{ type: "text"; text: string; synthetic?: boolean }>;
};

const MODEL = { providerID: "openai", modelID: "gpt-5.6-luna" };
const USER = { info: { role: "user", agent: "open-gajae", model: MODEL } };
const ASSISTANT = { info: { role: "assistant" } };

/**
 * `inFlight` in `src/hooks.ts` is module-level and shared by every `createHooks`
 * result, so every test allocates its own session IDs.
 */
let sessionCounter = 0;
const nextSession = (label: string) => `sess-${label}-${(sessionCounter += 1)}`;

function fakeClient(
  options: {
    messages?: unknown;
    promptRejects?: boolean;
    messagesReject?: boolean;
  } = {},
) {
  const calls: PromptBody[] = [];
  const client: RalplanClient = {
    session: {
      async messages() {
        if (options.messagesReject) throw new Error("session.messages failed");
        // A function lets one test script a different transcript per call.
        if (typeof options.messages === "function")
          return (options.messages as () => unknown)();
        return options.messages ?? [USER];
      },
      async promptAsync(input) {
        calls.push(input.body as PromptBody);
        if (options.promptRejects) throw new Error("promptAsync failed");
        return {};
      },
    },
  };
  return { client, calls };
}

async function fixture(
  run: (context: {
    root: string;
    store: StateStore;
    hooks: RalplanHooks;
    calls: PromptBody[];
  }) => Promise<void>,
  options: Parameters<typeof fakeClient>[0] = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "open-gajae-hooks-"));
  try {
    const root = await fs.realpath(dir);
    const store = new StateStore(root);
    const { client, calls } = fakeClient(options);
    await run({ root, store, hooks: createHooks(store, client), calls });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Deliver one user message and return only the parts the hook appended. */
async function deliver(
  hooks: RalplanHooks,
  sessionID: string,
  text: string,
  agent?: string,
): Promise<ChatPart[]> {
  const messageID = "msg-1";
  const parts: ChatPart[] = [
    {
      id: "prt-user",
      sessionID,
      messageID,
      type: "text",
      text,
    } as unknown as ChatPart,
  ];
  const output = {
    message: { id: messageID } as unknown as ChatOutput["message"],
    parts,
  } as ChatOutput;
  await hooks["chat.message"](
    { sessionID, agent, messageID } as ChatInput,
    output,
  );
  return parts.slice(1);
}

const idle = (hooks: RalplanHooks, sessionID: string) =>
  hooks.event({
    event: { type: "session.idle", properties: { sessionID } },
  } as unknown as EventInput);

/** A `session.error` event, the shape OpenCode publishes when a turn halts. */
const sessionError = (hooks: RalplanHooks, sessionID: string, name: string) =>
  hooks.event({
    event: {
      type: "session.error",
      properties: { sessionID, error: { name, data: {} } },
    },
  } as unknown as EventInput);

/** An assistant message carrying the host's interrupt marker. */
const abortedAssistant = (name: string) => ({
  info: { role: "assistant", error: { name, data: {} } },
});

const skillCall = (hooks: RalplanHooks, sessionID: string, args: unknown) =>
  hooks["tool.execute.before"](
    { tool: "skill", sessionID, callID: "call-1" },
    { args } as ToolOutput,
  );

const commandCall = (hooks: RalplanHooks, sessionID: string, command: string) =>
  hooks["command.execute.before"](
    { command, sessionID, arguments: "" },
    { parts: [] } as unknown as CommandOutput,
  );

const seed = (store: StateStore, sessionID: string, patch: ExplicitStatePatch) =>
  store.patch(sessionID, patch, RALPLAN_MODE);

const raw = (store: StateStore, sessionID: string) =>
  readFile(store.statePath(sessionID, RALPLAN_MODE), "utf8");

async function missing(store: StateStore, sessionID: string) {
  return fs
    .lstat(store.statePath(sessionID, RALPLAN_MODE))
    .then(() => false)
    .catch(() => true);
}

function strip(state: Record<string, unknown> | undefined) {
  const copy = { ...(state ?? {}) };
  delete copy._meta;
  return copy;
}

const ACTIVE: ExplicitStatePatch = {
  active: true,
  awaiting_confirmation: false,
  current_phase: "ralplan",
};

test("an idle continuation injects one reinforcement and advances the breaker", async () => {
  await fixture(async ({ store, hooks, calls }) => {
    const id = nextSession("continue");
    await seed(store, id, ACTIVE);
    await idle(hooks, id);

    expect(calls).toHaveLength(1);
    expect(calls[0].parts).toHaveLength(1);
    expect(calls[0].parts[0].synthetic).toBe(true);
    expect(calls[0].parts[0].text).toContain(
      "[RALPLAN - CONSENSUS PLANNING | REINFORCEMENT 1/30]",
    );
    expect(calls[0].parts[0].text.startsWith("<ralplan-continuation>")).toBe(true);

    const state = await store.read(id, RALPLAN_MODE);
    expect(state?.breaker_count).toBe(1);
    expect(typeof state?.breaker_updated_at).toBe("string");
    expect(state?.active).toBe(true);
  });
});

test("the fields response shape is accepted as well as a bare array", async () => {
  await fixture(
    async ({ store, hooks, calls }) => {
      const id = nextSession("fields");
      await seed(store, id, ACTIVE);
      await idle(hooks, id);
      expect(calls).toHaveLength(1);
      expect(calls[0].agent).toBe("open-gajae");
      expect(calls[0].model).toEqual(MODEL);
    },
    { messages: { data: [USER], error: undefined, request: {}, response: {} } },
  );
});

test("the injection inherits the last user message's agent and model", async () => {
  const older = { info: { role: "user", agent: "stale", model: MODEL } };
  const newest = {
    info: {
      role: "user",
      agent: "custom-primary",
      model: { providerID: "anthropic", modelID: "claude-opus-5" },
    },
  };
  await fixture(
    async ({ store, hooks, calls }) => {
      const id = nextSession("inherit");
      await seed(store, id, ACTIVE);
      await idle(hooks, id);
      expect(calls[0].agent).toBe("custom-primary");
      expect(calls[0].model).toEqual({
        providerID: "anthropic",
        modelID: "claude-opus-5",
      });
    },
    { messages: [older, newest, ASSISTANT] },
  );
});

test("a user message without agent or model omits both body fields", async () => {
  await fixture(
    async ({ store, hooks, calls }) => {
      const id = nextSession("bare-user");
      await seed(store, id, ACTIVE);
      await idle(hooks, id);
      expect(calls).toHaveLength(1);
      expect("agent" in calls[0]).toBe(false);
      expect("model" in calls[0]).toBe(false);
    },
    { messages: [{ info: { role: "user" } }] },
  );
});

test("awaiting, terminal and inactive states produce no continuation", async () => {
  await fixture(async ({ store, hooks, calls }) => {
    const awaiting = nextSession("awaiting");
    await seed(store, awaiting, {
      active: true,
      awaiting_confirmation: true,
      current_phase: "ralplan",
    });
    await idle(hooks, awaiting);

    const terminal = nextSession("terminal");
    await seed(store, terminal, {
      active: true,
      awaiting_confirmation: false,
      current_phase: "handoff:ralph",
      breaker_count: 7,
    });
    await idle(hooks, terminal);

    const inactive = nextSession("inactive");
    await seed(store, inactive, { active: false, current_phase: "ralplan" });
    await idle(hooks, inactive);

    expect(calls).toHaveLength(0);
    // A terminal phase resets the breaker instead of reinforcing.
    expect((await store.read(terminal, RALPLAN_MODE))?.breaker_count).toBe(0);
    expect((await store.read(awaiting, RALPLAN_MODE))?.breaker_count).toBeUndefined();
  });
});

test("the thirty-first idle trips the circuit breaker and deactivates the state", async () => {
  await fixture(async ({ store, hooks, calls }) => {
    const id = nextSession("breaker");
    await seed(store, id, ACTIVE);
    for (let turn = 0; turn < 31; turn += 1) await idle(hooks, id);

    expect(calls).toHaveLength(31);
    expect(calls[29].parts[0].text).toContain("REINFORCEMENT 30/30");
    expect(calls[30].parts[0].text).toContain("[RALPLAN CIRCUIT BREAKER]");
    expect(calls[30].parts[0].text).not.toContain("REINFORCEMENT");

    const state = await store.read(id, RALPLAN_MODE);
    expect(state?.active).toBe(false);
    expect(state?.deactivated_reason).toBe("stop_breaker_exhausted");
    expect(state?.breaker_count).toBe(0);
    expect(typeof state?.completed_at).toBe("string");

    // A deactivated state is inert on the next idle.
    await idle(hooks, id);
    expect(calls).toHaveLength(31);
  });
});

test("a breaker timestamp past the TTL restarts the count at one", async () => {
  await fixture(async ({ store, hooks, calls }) => {
    const id = nextSession("ttl");
    await seed(store, id, {
      ...ACTIVE,
      breaker_count: 30,
      breaker_updated_at: new Date(Date.now() - 46 * 60 * 1000).toISOString(),
    });
    await idle(hooks, id);
    expect(calls).toHaveLength(1);
    expect(calls[0].parts[0].text).toContain("REINFORCEMENT 1/30");
    expect((await store.read(id, RALPLAN_MODE))?.breaker_count).toBe(1);
  });
});

test("a session with no user message gets no injection", async () => {
  await fixture(
    async ({ store, hooks, calls }) => {
      const id = nextSession("no-user");
      await seed(store, id, ACTIVE);
      await idle(hooks, id);
      expect(calls).toHaveLength(0);
      // The breaker only advances when an injection is actually attempted, so
      // a turn that injects nothing must not spend one of the thirty.
      expect((await store.read(id, RALPLAN_MODE))?.breaker_count).toBeUndefined();
    },
    { messages: [ASSISTANT] },
  );
});

test("two concurrent idles produce a single continuation", async () => {
  await fixture(async ({ store, hooks, calls }) => {
    const id = nextSession("inflight");
    await seed(store, id, ACTIVE);
    await Promise.all([idle(hooks, id), idle(hooks, id)]);
    expect(calls).toHaveLength(1);
    expect((await store.read(id, RALPLAN_MODE))?.breaker_count).toBe(1);
  });
});

test("a rejected promptAsync does not escape the idle hook", async () => {
  await fixture(
    async ({ store, hooks, calls }) => {
      const id = nextSession("prompt-reject");
      await seed(store, id, ACTIVE);
      await idle(hooks, id);
      expect(calls).toHaveLength(1);
      // The count stays incremented; the next idle is the retry.
      expect((await store.read(id, RALPLAN_MODE))?.breaker_count).toBe(1);
    },
    { promptRejects: true },
  );
});

test("a rejected session.messages does not escape the idle hook", async () => {
  await fixture(
    async ({ store, hooks, calls }) => {
      const id = nextSession("messages-reject");
      await seed(store, id, ACTIVE);
      await idle(hooks, id);
      expect(calls).toHaveLength(0);
    },
    { messagesReject: true },
  );
});

test("an idle for a session with no state directory is a no-op", async () => {
  await fixture(async ({ store, hooks, calls }) => {
    const id = nextSession("no-state");
    await idle(hooks, id);
    expect(calls).toHaveLength(0);
    expect(await missing(store, id)).toBe(true);
  });
});

test("a corrupt state file leaves every hook inert and the file byte-identical", async () => {
  await fixture(async ({ store, hooks, calls }) => {
    const id = nextSession("corrupt");
    const file = store.statePath(id, RALPLAN_MODE);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "{", "utf8");

    await idle(hooks, id);
    expect(await deliver(hooks, id, "unrelated question")).toHaveLength(0);
    expect(await deliver(hooks, id, "랄플랜 정리해줘")).toHaveLength(0);
    await skillCall(hooks, id, { name: "ralplan" });
    await commandCall(hooks, id, "ralplan");

    expect(calls).toHaveLength(0);
    expect(await readFile(file, "utf8")).toBe("{");
  });
});

test("the ralplan keyword appends the notice and seeds state", async () => {
  await fixture(async ({ store, hooks, calls }) => {
    for (const text of ["ralplan 이거 정리해줘", "랄플랜 <task>"]) {
      const id = nextSession("keyword");
      const appended = await deliver(hooks, id, text);
      expect(appended).toHaveLength(1);
      const part = appended[0] as unknown as Record<string, unknown>;
      expect(part.type).toBe("text");
      expect(part.synthetic).toBe(true);
      expect(part.sessionID).toBe(id);
      expect(part.messageID).toBe("msg-1");
      expect(String(part.text)).toContain("[MODE: RALPLAN]");
      expect(String(part.text).startsWith("<ralplan-notice>")).toBe(true);

      const state = await store.read(id, RALPLAN_MODE);
      expect(state?.active).toBe(true);
      expect(state?.awaiting_confirmation).toBe(true);
      expect(state?.current_phase).toBe("ralplan");
      expect(state?.breaker_count).toBe(0);
      expect(state?.started_at).toBe(state?.restored_at as string);
    }
    expect(calls).toHaveLength(0);
  });
});

test("a non-ralplan execution request is left unchanged and writes no state", async () => {
  await fixture(async ({ store, hooks }) => {
    const id = nextSession("ralph");
    expect(await deliver(hooks, id, "ralph fix this")).toHaveLength(0);
    expect(await missing(store, id)).toBe(true);
  });
});

test("the plugin's own continuation text is ignored when it re-enters", async () => {
  await fixture(async ({ store, hooks }) => {
    const id = nextSession("self");
    expect(await deliver(hooks, id, continuationMessage(1))).toHaveLength(0);
    expect(await missing(store, id)).toBe(true);
  });
});

test("the three role subagents are denied and everything else proceeds", async () => {
  await fixture(async ({ store, hooks }) => {
    for (const agent of [
      "open-gajae-planner",
      "open-gajae-architect",
      "open-gajae-critic",
    ]) {
      const id = nextSession("role");
      expect(await deliver(hooks, id, "랄플랜 정리해줘", agent)).toHaveLength(0);
      expect(await missing(store, id)).toBe(true);
    }

    // N1: `undefined` and every other agent name proceed.
    const undefinedAgent = nextSession("undefined-agent");
    const appended = await deliver(hooks, undefinedAgent, "랄플랜 정리해줘", undefined);
    expect(appended).toHaveLength(1);
    expect(String((appended[0] as unknown as { text: string }).text)).toContain(
      "[MODE: RALPLAN]",
    );
    expect((await store.read(undefinedAgent, RALPLAN_MODE))?.active).toBe(true);

    const otherAgent = nextSession("other-agent");
    expect(await deliver(hooks, otherAgent, "랄플랜 정리해줘", "build")).toHaveLength(1);
    expect((await store.read(otherAgent, RALPLAN_MODE))?.active).toBe(true);
  });
});

test("restore fires on a real resume only, never on the turn after seeding", async () => {
  await fixture(async ({ store, hooks }) => {
    const seeded = nextSession("post-seed");
    await deliver(hooks, seeded, "랄플랜 정리해줘");
    await skillCall(hooks, seeded, { name: "ralplan" });
    // `restored_at` equals `started_at`, so this turn is not a resume.
    expect(await deliver(hooks, seeded, "그럼 다음 단계로 가자")).toHaveLength(0);

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
    const first = await deliver(hooks, resumed, "이어서 진행해줘");
    expect(first).toHaveLength(1);
    const text = String((first[0] as unknown as { text: string }).text);
    expect(text).toContain("[RALPLAN MODE RESTORED]");
    expect(text.startsWith("<session-restore>")).toBe(true);
    expect(text).toContain(startedAt);

    const advanced = await store.read(resumed, RALPLAN_MODE);
    expect(String(advanced?.restored_at) > startedAt).toBe(true);

    // Once per resume: the following message appends nothing.
    expect(await deliver(hooks, resumed, "한 가지 더")).toHaveLength(0);
  });
});

test("started_at is written once and survives later hook writes", async () => {
  await fixture(async ({ store, hooks }) => {
    const id = nextSession("started-at");
    await deliver(hooks, id, "ralplan 정리해줘");
    const seeded = await store.read(id, RALPLAN_MODE);
    await skillCall(hooks, id, { name: "ralplan" });
    await idle(hooks, id);
    await deliver(hooks, id, "ralplan 계속 진행");

    const after = await store.read(id, RALPLAN_MODE);
    expect(after?.started_at).toBe(seeded?.started_at as string);
    expect(after?.breaker_count).toBe(1);
  });
});

test("the skill tool call confirms a seeded ralplan state and nothing else does", async () => {
  await fixture(async ({ store, hooks }) => {
    const id = nextSession("confirm");
    await deliver(hooks, id, "랄플랜 정리해줘");
    const before = await store.read(id, RALPLAN_MODE);
    expect(before?.awaiting_confirmation).toBe(true);

    await skillCall(hooks, id, { name: "ralplan" });
    const after = await store.read(id, RALPLAN_MODE);
    expect(strip(after)).toEqual({ ...strip(before), awaiting_confirmation: false });

    // Every other shape leaves the file byte-identical.
    const untouched = await raw(store, id);
    await skillCall(hooks, id, { name: "deep-interview" });
    await skillCall(hooks, id, undefined);
    await hooks["tool.execute.before"](
      { tool: "read", sessionID: id, callID: "call-2" },
      { args: { name: "ralplan" } } as ToolOutput,
    );
    expect(await raw(store, id)).toBe(untouched);

    // A session with no ralplan state neither throws nor creates a file.
    const empty = nextSession("confirm-empty");
    await skillCall(hooks, empty, { name: "ralplan" });
    expect(await missing(store, empty)).toBe(true);
  });
});

test("the ralplan command clears the flag and other commands do not", async () => {
  await fixture(async ({ store, hooks }) => {
    const cleared = nextSession("cmd-clear");
    await seed(store, cleared, {
      active: true,
      awaiting_confirmation: true,
      current_phase: "ralplan",
    });
    await commandCall(hooks, cleared, "ralplan");
    expect((await store.read(cleared, RALPLAN_MODE))?.awaiting_confirmation).toBe(
      false,
    );

    const kept = nextSession("cmd-keep");
    await seed(store, kept, {
      active: true,
      awaiting_confirmation: true,
      current_phase: "ralplan",
    });
    const untouched = await raw(store, kept);
    await commandCall(hooks, kept, "deep-interview");
    expect(await raw(store, kept)).toBe(untouched);

    const empty = nextSession("cmd-empty");
    await commandCall(hooks, empty, "ralplan");
    expect(await missing(store, empty)).toBe(true);
  });
});

test("a stale seed is cleared by the next non-keyword message without a restore banner", async () => {
  await fixture(async ({ store, hooks }) => {
    const stale = nextSession("stale");
    await seed(store, stale, { active: true, awaiting_confirmation: true });
    expect(await deliver(hooks, stale, "그건 됐고 다른 걸 해줘")).toHaveLength(0);
    expect(await missing(store, stale)).toBe(true);

    // Repeating the keyword keeps the seed and re-seeds idempotently.
    const repeated = nextSession("stale-keyword");
    await seed(store, repeated, { active: true, awaiting_confirmation: true });
    const untouched = await raw(store, repeated);
    const appended = await deliver(hooks, repeated, "랄플랜 계속");
    expect(appended).toHaveLength(1);
    expect(String((appended[0] as unknown as { text: string }).text)).toContain(
      "[MODE: RALPLAN]",
    );
    expect(await raw(store, repeated)).toBe(untouched);
    expect((await store.read(repeated, RALPLAN_MODE))?.active).toBe(true);

    // A confirmed session survives an ordinary message untouched.
    const confirmed = nextSession("confirmed");
    await seed(store, confirmed, { active: true, awaiting_confirmation: false });
    const kept = await raw(store, confirmed);
    expect(await deliver(hooks, confirmed, "다른 파일도 봐줘")).toHaveLength(0);
    expect(await raw(store, confirmed)).toBe(kept);
  });
});

test("F1 — a stale seed then a real entry write never raises a restore banner", async () => {
  await fixture(async ({ store, hooks }) => {
    const id = nextSession("f1");
    // 1. Keyword seeds.
    expect(await deliver(hooks, id, "랄플랜 정리해줘")).toHaveLength(1);
    expect((await store.read(id, RALPLAN_MODE))?.awaiting_confirmation).toBe(true);

    // 2. An unrelated message clears the stale seed (step 2).
    expect(await deliver(hooks, id, "아니 그거 말고 빌드 로그 좀 봐줘")).toHaveLength(0);
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

    // 4. The next real user message appends nothing.
    expect(await deliver(hooks, id, "다음 단계 알려줘")).toHaveLength(0);

    // The same, with an entry write that omits both timestamps.
    const bare = nextSession("f1-bare");
    await store.write(
      bare,
      {},
      { active: true, current_phase: "ralplan", awaiting_confirmation: false },
      RALPLAN_MODE,
    );
    expect(await deliver(hooks, bare, "다음 단계 알려줘")).toHaveLength(0);
    expect((await store.read(bare, RALPLAN_MODE))?.restored_at).toBeUndefined();
  });
});

test("F7 — a /ralplan command turn ends with the confirmation flag cleared", async () => {
  await fixture(async ({ store, hooks, calls }) => {
    const id = nextSession("f7");

    // 1. `command.execute.before` runs first and no-ops: there is no state yet.
    await commandCall(hooks, id, "ralplan");
    expect(await missing(store, id)).toBe(true);

    // 2. The expanded template reaches `chat.message` and re-seeds the flag.
    const appended = await deliver(
      hooks,
      id,
      "Run the ralplan consensus planning workflow on: tidy up the hooks",
    );
    expect(appended).toHaveLength(1);
    expect((await store.read(id, RALPLAN_MODE))?.awaiting_confirmation).toBe(true);

    // An idle between events 2 and 3 is silenced by the seed.
    await idle(hooks, id);
    expect(calls).toHaveLength(0);

    // 3. The `skill` call is the authority and clears the flag.
    await skillCall(hooks, id, { name: "ralplan" });
    expect((await store.read(id, RALPLAN_MODE))?.awaiting_confirmation).not.toBe(true);

    // An idle after event 3 reinforces.
    await idle(hooks, id);
    expect(calls).toHaveLength(1);
    expect(calls[0].parts[0].text).toContain("REINFORCEMENT 1/30");
  });
});

test("a session.error abort silences the idle that follows it", async () => {
  await fixture(async ({ store, hooks, calls }) => {
    const id = nextSession("abort-event");
    await seed(store, id, ACTIVE);

    await sessionError(hooks, id, "MessageAbortedError");
    await idle(hooks, id);

    expect(calls).toHaveLength(0);
    const state = await store.read(id, RALPLAN_MODE);
    // Skip only: the breaker is untouched and ralplan stays active, so the next
    // real user turn resumes continuation.
    expect(state?.breaker_count).toBeUndefined();
    expect(state?.breaker_updated_at).toBeUndefined();
    expect(state?.active).toBe(true);
  });
});

test("an aborted last assistant message silences the idle", async () => {
  for (const name of ["MessageAbortedError", "AbortError"]) {
    await fixture(
      async ({ store, hooks, calls }) => {
        const id = nextSession("abort-message");
        await seed(store, id, ACTIVE);
        await idle(hooks, id);

        expect(calls).toHaveLength(0);
        const state = await store.read(id, RALPLAN_MODE);
        expect(state?.breaker_count).toBeUndefined();
        expect(state?.active).toBe(true);
      },
      { messages: [USER, abortedAssistant(name)] },
    );
  }
});

test("continuation resumes on the idle after an abort was skipped", async () => {
  await fixture(
    async ({ store, hooks, calls }) => {
      const id = nextSession("abort-recover");
      await seed(store, id, ACTIVE);

      await sessionError(hooks, id, "MessageAbortedError");
      await idle(hooks, id);
      expect(calls).toHaveLength(0);

      // The mark is consumed by that one idle; the next is an ordinary stall.
      await idle(hooks, id);
      expect(calls).toHaveLength(1);
      expect(calls[0].parts[0].text).toContain("REINFORCEMENT 1/30");
      expect((await store.read(id, RALPLAN_MODE))?.breaker_count).toBe(1);
    },
    { messages: [USER, ASSISTANT] },
  );
});

test("a session.error that is not an abort leaves the continuation alone", async () => {
  await fixture(async ({ store, hooks, calls }) => {
    const id = nextSession("provider-error");
    await seed(store, id, ACTIVE);

    await sessionError(hooks, id, "ProviderError");
    await idle(hooks, id);

    expect(calls).toHaveLength(1);
    expect(calls[0].parts[0].text).toContain("REINFORCEMENT 1/30");
    expect((await store.read(id, RALPLAN_MODE))?.breaker_count).toBe(1);
  });
});

test("an abort mark older than the window does not silence the idle", async () => {
  await fixture(async ({ store, hooks, calls }) => {
    const id = nextSession("abort-stale");
    await seed(store, id, ACTIVE);

    const base = Date.now();
    try {
      setSystemTime(base);
      await sessionError(hooks, id, "MessageAbortedError");
      // ABORT_WINDOW_MS is 3000; 4s later the idle is an ordinary stall.
      setSystemTime(base + 4000);
      await idle(hooks, id);
    } finally {
      setSystemTime();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].parts[0].text).toContain("REINFORCEMENT 1/30");
    expect((await store.read(id, RALPLAN_MODE))?.breaker_count).toBe(1);
  });
});

test("a session.error for another session does not silence this one", async () => {
  await fixture(async ({ store, hooks, calls }) => {
    const aborted = nextSession("abort-other");
    const running = nextSession("abort-running");
    await seed(store, running, ACTIVE);

    await sessionError(hooks, aborted, "MessageAbortedError");
    await idle(hooks, running);

    expect(calls).toHaveLength(1);
    expect((await store.read(running, RALPLAN_MODE))?.breaker_count).toBe(1);
  });
});

test("event types other than idle and error are ignored", async () => {
  await fixture(async ({ store, hooks, calls }) => {
    const id = nextSession("other-event");
    await seed(store, id, ACTIVE);
    await hooks.event({
      event: { type: "message.updated", properties: { sessionID: id } },
    } as unknown as EventInput);
    expect(calls).toHaveLength(0);
    expect((await store.read(id, RALPLAN_MODE))?.breaker_count).toBeUndefined();
  });
});
