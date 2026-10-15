// Read-only todo TUI (todo-agent-performance, task 6). The host is a
// deterministic fake port of the shared protocol: every `get` is a deferred the
// test settles by hand, `changed` and native events are emitted synchronously,
// and frames come from the OpenTUI test renderer. No timers, polling or sleeps:
// the test awaits the same promise the projection reacted to, so its reaction
// has already run when the await returns.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseThemeDocument, resolveThemeDocument, type HueStep } from "@opencode/theme/tui";
import { testRender, type JSX } from "@opentui/solid";
import { createSignal } from "solid-js";
import { todoRpc, todoView, type TodoChanged, type TodoView } from "../src/todo/protocol.js";
import { reduceTodo, type TodoSnapshot } from "../src/todo/state.js";
import {
  setupTodoTui,
  TODO_PANEL,
  TODO_VIEW_COMMAND,
  WIDE_COLUMNS,
  type TodoHostEvent,
  type TodoHostEventType,
  type TodoTuiHost,
} from "../src/tui.tsx";

// ------------------------------------------------------------ native theme fixtures
// Resolved through the host's own resolver (@opencode/theme 2.0.26), so the
// fixtures have exactly the ResolvedTheme shape the plugin receives as ctx.theme.
function scale(hex: string): Record<HueStep, string> {
  const base = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const steps: HueStep[] = [100, 200, 300, 400, 500, 600, 700, 800, 900];
  const entries = steps.map((step) => {
    const amount = Math.abs(500 - step) / 500;
    const target = step < 500 ? 255 : 0;
    const channel = (value: number) => Math.round(value + (target - value) * amount).toString(16).padStart(2, "0");
    return [step, `#${base.map(channel).join("")}`] as const;
  });
  return Object.fromEntries(entries) as Record<HueStep, string>;
}
const hue = {
  orange: scale("#f97316"),
  blue: scale("#3b82f6"),
  gray: scale("#71717a"),
  red: scale("#ef4444"),
  amber: scale("#f59e0b"),
  green: scale("#22c55e"),
  accent: "$hue.orange",
  interactive: "$hue.blue",
  neutral: "$hue.gray",
};
type Mode = "light" | "dark";
function tokens(mode: Mode) {
  const ref = (name: string, light: HueStep, dark: HueStep) => `$hue.${name}.${mode === "light" ? light : dark}`;
  const feedback = (name: string) => ({ base: ref(name, 600, 400), muted: ref(name, 400, 600) });
  const raised = (name: string) => ({ base: ref(name, 200, 800) });
  return {
    text: {
      base: ref("neutral", 900, 100),
      muted: ref("neutral", 600, 400),
      action: { primary: { base: ref("accent", 700, 300) }, secondary: { base: ref("neutral", 700, 300) }, destructive: { base: ref("red", 700, 300) } },
      formfield: { base: ref("neutral", 900, 100) },
      feedback: { error: feedback("red"), warning: feedback("amber"), success: feedback("green"), info: feedback("blue") },
    },
    background: {
      base: ref("neutral", 100, 900),
      raised: { base: ref("neutral", 200, 800), high: ref("neutral", 300, 700), max: ref("neutral", 400, 600) },
      action: { primary: raised("accent"), secondary: raised("neutral"), destructive: raised("red") },
      formfield: raised("neutral"),
      feedback: { error: raised("red"), warning: raised("amber"), success: raised("green"), info: raised("blue") },
    },
    border: { base: ref("neutral", 300, 700) },
    scrollbar: { base: ref("neutral", 400, 600) },
    diff: {
      text: { added: ref("green", 700, 300), removed: ref("red", 700, 300), context: ref("neutral", 700, 300), hunkHeader: ref("blue", 700, 300) },
      background: { added: ref("green", 100, 900), removed: ref("red", 100, 900), context: ref("neutral", 100, 900) },
      highlight: { added: raised("green").base, removed: raised("red").base },
      lineNumber: { text: ref("neutral", 600, 400), background: { added: raised("green").base, removed: raised("red").base } },
    },
    syntax: {
      comment: ref("neutral", 600, 400), keyword: ref("accent", 700, 300), function: ref("blue", 700, 300),
      variable: ref("neutral", 900, 100), string: ref("green", 700, 300), number: ref("amber", 700, 300),
      type: ref("blue", 700, 300), operator: ref("neutral", 700, 300), punctuation: ref("neutral", 600, 400),
    },
    markdown: {
      text: ref("neutral", 900, 100), heading: ref("accent", 700, 300), link: ref("blue", 700, 300),
      linkText: ref("blue", 600, 400), code: ref("green", 700, 300), blockQuote: ref("neutral", 600, 400),
      emphasis: ref("neutral", 800, 200), strong: ref("neutral", 900, 100), horizontalRule: ref("neutral", 400, 600),
      listItem: ref("neutral", 900, 100), listEnumeration: ref("accent", 700, 300), image: ref("blue", 700, 300),
      imageText: ref("blue", 600, 400), codeBlock: ref("green", 700, 300),
    },
  };
}
const themeDocument = parseThemeDocument(
  {
    base: { hue, categorical: ["orange", "blue", "gray", "red", "amber", "green"], ...tokens("dark") },
    light: { hue, ...tokens("light") },
    dark: { hue },
  },
  "todo-tui-fixture",
);
const themes = {
  light: resolveThemeDocument(themeDocument, "light"),
  dark: resolveThemeDocument(themeDocument, "dark"),
} as const;

// ------------------------------------------------------------ board fixtures
function snapshot(
  sessionID: string,
  revision: number,
  phases: TodoSnapshot["phases"],
  hold: TodoSnapshot["controller"]["hold"] = null,
): TodoSnapshot {
  return {
    schemaVersion: 1, sessionID, generation: 1, revision, phases,
    controller: {
      sourceWatermark: null, reservation: null, activationFence: null,
      consumedActivationFence: null, workEpoch: 1, closedLabels: [],
      stagnation: 0, failures: 0, hold,
    },
  };
}
const ACTIVE_PHASES: TodoSnapshot["phases"] = [
  { phase: "Investigation", items: [
    { task: "Read plan and ledger", status: "completed" },
    { task: "Inspect public host types", status: "completed" },
  ] },
  { phase: "Implementation", items: [
    { task: "Write failing sidebar tests", status: "in_progress" },
    { task: "Implement projection and slots", status: "pending" },
  ] },
  { phase: "Verification", items: [
    { task: "Run typecheck and build", status: "pending" },
    { task: "Capture 80x24 and 200x50 frames", status: "pending" },
  ] },
];
const HOLD_REASON = "stagnation limit reached after 3 stops without progress; start a task to resume";
const active = (sessionID: string, revision = 1): TodoView => todoView(snapshot(sessionID, revision, ACTIVE_PHASES));
const held = (sessionID: string, revision = 2): TodoView =>
  todoView(snapshot(sessionID, revision, ACTIVE_PHASES, { reason: HOLD_REASON }));
const terminal = (sessionID: string, revision = 3): TodoView => todoView(snapshot(sessionID, revision, [
  { phase: "Investigation", items: [
    { task: "Read plan and ledger", status: "completed" },
    { task: "Inspect public host types", status: "completed" },
  ] },
  { phase: "Implementation", items: [
    { task: "Write failing sidebar tests", status: "completed" },
    { task: "Implement projection and slots", status: "abandoned" },
  ] },
]));
const empty = (sessionID: string, revision = 4): TodoView => todoView(snapshot(sessionID, revision, []));
const EMPTY_HOLD_REASON = "manual stop";
const emptyHeld = (sessionID: string): TodoView =>
  todoView(reduceTodo(snapshot(sessionID, 6, ACTIVE_PHASES, { reason: EMPTY_HOLD_REASON }), { op: "rm" }, sessionID));
const invalid = (sessionID: string): TodoView =>
  ({ status: "invalid", sessionID, diagnostic: "state/todo.json: unsupported schemaVersion 2" });
const missing = (sessionID: string): TodoView => ({ status: "missing", sessionID });
const disabled = (sessionID: string): TodoView => ({ status: "disabled", sessionID });
const INJECTED = "**bold** <b>html</b> [link](http://example.invalid) `code` $(touch pwned) \u001b[31mred\u001b[0m";
const injected = (sessionID: string): TodoView => todoView(snapshot(sessionID, 7, [
  { phase: "# Heading phase", items: [{ task: INJECTED, status: "in_progress" }] },
]));

// ------------------------------------------------------------ fake host
interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
type Claim = Parameters<TodoTuiHost["ui"]["slot"]>[0];
type Layer = ReturnType<Parameters<TodoTuiHost["keymap"]["layer"]>[0]>;
type ChangedHandler = Parameters<ReturnType<TodoTuiHost["client"]["rpc"]>["events"]["on"]>[1];
type NativeHandler = (event: TodoHostEvent) => void;
type PendingGet = Deferred<TodoView> & { readonly sessionID: string };

function createFakeHost(mode: Mode) {
  const [themeMode, setThemeMode] = createSignal<Mode>(mode);
  const order: string[] = [];
  const methods: string[] = [];
  const gets: PendingGet[] = [];
  const changedHandlers = new Set<ChangedHandler>();
  const nativeHandlers = new Map<TodoHostEventType, Set<NativeHandler>>();
  const claims: Claim[] = [];
  const layers: Array<() => Layer> = [];
  const panelOpens: Array<{ name: string; presentation: string | undefined }> = [];
  const host: TodoTuiHost = {
    client: {
      rpc(definition) {
        if (definition.id !== todoRpc.id || definition.version !== 1) throw new Error("unexpected RPC definition");
        return {
          get(input) {
            methods.push("get");
            order.push(`get:${input.sessionID}`);
            const pending = { ...deferred<TodoView>(), sessionID: input.sessionID };
            gets.push(pending);
            return pending.promise;
          },
          events: {
            on(name, handler) {
              order.push(`subscribe:${name}`);
              changedHandlers.add(handler);
              return () => {
                order.push(`unsubscribe:${name}`);
                changedHandlers.delete(handler);
              };
            },
          },
        };
      },
    },
    data: {
      on(type, handler) {
        const set = nativeHandlers.get(type) ?? new Set<NativeHandler>();
        nativeHandlers.set(type, set);
        set.add(handler);
        return () => { set.delete(handler); };
      },
    },
    ui: {
      slot(claim) {
        claims.push(claim);
        return () => {
          const index = claims.indexOf(claim);
          if (index >= 0) claims.splice(index, 1);
        };
      },
      panel: {
        open(name, options) {
          panelOpens.push({ name, presentation: options?.presentation });
          return true;
        },
        close() {},
        current() { return undefined; },
      },
    },
    keymap: { layer(factory) { layers.push(factory); } },
    get theme() { return themes[themeMode()]; },
  };
  const emitNative = (type: TodoHostEventType, sessionID?: string) => {
    const event: TodoHostEvent = { type, data: sessionID === undefined ? {} : { sessionID } };
    for (const handler of [...(nativeHandlers.get(type) ?? [])]) handler(event);
  };
  return {
    host, order, methods, gets, claims, layers, panelOpens, setThemeMode,
    emitChanged(view: TodoView) {
      const data: TodoChanged = { sessionID: view.sessionID, view };
      for (const handler of [...changedHandlers]) void handler({ data });
    },
    emitNative,
    listenerCount: () =>
      changedHandlers.size + [...nativeHandlers.values()].reduce((sum, set) => sum + set.size, 0),
    nativeTypes: () => [...nativeHandlers.keys()].filter((type) => (nativeHandlers.get(type)?.size ?? 0) > 0).sort(),
  };
}
type Fake = ReturnType<typeof createFakeHost>;

function sidebar(fake: Fake) {
  const claim = fake.claims.find((c): c is Extract<Claim, { append: "sidebar.content" }> => c.append === "sidebar.content");
  if (!claim) throw new Error("sidebar.content claim missing");
  return claim.render;
}
function composer(fake: Fake) {
  const claim = fake.claims.find((c): c is Extract<Claim, { append: "session.composer.top" }> => c.append === "session.composer.top");
  if (!claim) throw new Error("session.composer.top claim missing");
  return claim.render;
}
function panel(fake: Fake) {
  const claim = fake.claims.find((c): c is Extract<Claim, { append: "session.panel" }> => c.append === "session.panel");
  if (!claim) throw new Error("session.panel claim missing");
  return claim.render;
}
type PanelInput = Parameters<ReturnType<typeof panel>>[0];
function panelInput(name: string, sessionID: string, width: number, focused = true) {
  const calls = { focus: 0, close: 0, toggleFullscreen: 0 };
  const input: PanelInput = {
    name, sessionID, width, presentation: "fullscreen", focused,
    focus() { calls.focus++; }, close() { calls.close++; }, toggleFullscreen() { calls.toggleFullscreen++; },
  };
  return { input, calls };
}
async function layer(fake: Fake): Promise<Layer> {
  expect(fake.layers).toHaveLength(1);
  const factory = fake.layers[0];
  if (!factory) throw new Error("keymap layer missing");
  return factory();
}
function flag(value: boolean | (() => boolean) | undefined): boolean {
  return typeof value === "function" ? value() : value !== false;
}

// ------------------------------------------------------------ rendering helpers
const SNAPSHOT_DIR = process.env.TODO_TUI_SNAPSHOT_DIR;
const renderers: Array<{ renderer: { destroy(): void } }> = [];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const setup of renderers.splice(0)) setup.renderer.destroy();
});
async function mount(node: () => JSX.Element, width: number, height: number) {
  const setup = await testRender(node, { width, height });
  renderers.push(setup);
  await setup.renderOnce();
  return setup;
}
type Setup = Awaited<ReturnType<typeof mount>>;
async function frame(setup: Setup, name?: string): Promise<string> {
  await setup.renderOnce();
  const text = setup.captureCharFrame();
  if (name && SNAPSHOT_DIR) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(join(SNAPSHOT_DIR, `${name}.txt`), text);
  }
  return text;
}
function snapshotIf(setup: Setup, name: string): void {
  if (!SNAPSHOT_DIR) return;
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  writeFileSync(join(SNAPSHOT_DIR, `${name}.txt`), setup.captureCharFrame());
}
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const lines = (text: string) => text.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
function start(mode: Mode = "dark") {
  const fake = createFakeHost(mode);
  const cleanup = setupTodoTui(fake.host);
  cleanups.push(cleanup);
  return { fake, cleanup };
}
async function settle(pending: PendingGet, view: TodoView) {
  pending.resolve(view);
  await pending.promise;
}
async function fail(pending: PendingGet, error: unknown) {
  pending.reject(error);
  await pending.promise.catch(() => undefined);
}

// ============================================================ tui-live-and-layout
describe("tui-live-and-layout", () => {
  test("subscribes to changed before the first get and renders the first enabled snapshot", async () => {
    const { fake } = start();
    expect(fake.order).toEqual(["subscribe:changed"]);
    const setup = await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 50);
    expect(fake.order).toEqual(["subscribe:changed", "get:s1"]);
    expect(squash(await frame(setup))).toBe("");
    await settle(fake.gets[0]!, active("s1"));
    const text = await frame(setup, "sidebar-active-40x50-dark");
    expect(squash(text)).toContain("Todo r1");
    expect(lines(text)).toContain("2/6 done, 0 dropped, 4 open");
    expect(squash(text)).toContain("now: Write failing sidebar tests");
    expect(squash(text)).toContain("[x] Read plan and ledger");
    expect(squash(text)).toContain("[>] Write failing sidebar tests");
    expect(squash(text)).toContain("[ ] Capture 80x24 and 200x50 frames");
    expect(fake.methods).toEqual(["get"]);
  });

  test("sidebar collapses to phase counts when the terminal is short", async () => {
    const { fake } = start();
    const setup = await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 24);
    await settle(fake.gets[0]!, active("s1"));
    const text = await frame(setup, "sidebar-active-40x24-dark");
    expect(lines(text)).toContain("2/6 done, 0 dropped, 4 open");
    expect(squash(text)).toContain("now: Write failing sidebar tests");
    expect(squash(text)).toContain("Investigation 2/2");
    expect(squash(text)).toContain("Implementation 0/2");
    expect(squash(text)).not.toContain("[x]");
    setup.resize(40, 50);
    expect(squash(await frame(setup))).toContain("[x] Read plan and ledger");
  });

  test("composer summary appears below 200 columns, wraps, and disappears at 200", async () => {
    for (const mode of ["light", "dark"] as const) {
      const { fake } = start(mode);
      const narrow = await mount(() => composer(fake)({ sessionID: "s1" }), 80, 24);
      await settle(fake.gets[0]!, held("s1"));
      const text = await frame(narrow, `composer-held-80x24-${mode}`);
      expect(squash(text)).toContain("todo 2/6 done, 4 open | now: Write failing sidebar tests");
      expect(squash(text)).toContain(`[!] hold: ${HOLD_REASON}`);
      expect(lines(text).length).toBeGreaterThanOrEqual(3);
      for (const line of lines(text)) expect(line.length).toBeLessThanOrEqual(80);
      const spans = narrow.captureSpans().lines.flatMap((line) => line.spans);
      const theme = themes[mode];
      expect(spans.some((span) => span.text.includes("now:") && span.fg.equals(theme.text.feedback.info.base))).toBe(true);
      expect(spans.some((span) => span.text.includes("Write failing") && span.fg.equals(theme.text.base))).toBe(true);
      expect(spans.some((span) => span.text.includes("[!]") && span.fg.equals(theme.text.feedback.warning.base))).toBe(true);
      expect(spans.some((span) => span.text.includes("hold:") && span.fg.equals(theme.text.base))).toBe(true);
      expect(spans.some((span) => span.text.includes("todo 2/6") && span.fg.equals(theme.text.base))).toBe(true);
      const wide = await mount(() => composer(fake)({ sessionID: "s1" }), WIDE_COLUMNS, 50);
      expect(squash(await frame(wide, `composer-held-200x50-${mode}`))).toBe("");
    }
    expect(themes.light.text.base.equals(themes.dark.text.base)).toBe(false);
  });

  test("terminal, empty, held and invalid boards are never shown as complete", async () => {
    const { fake } = start("light");
    const setup = await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 50);
    await settle(fake.gets[0]!, terminal("s1"));
    let text = await frame(setup, "sidebar-terminal-40x50-light");
    expect(lines(text)).toContain("3/4 done, 1 dropped, 0 open");
    expect(squash(text)).not.toContain("now:");
    expect(squash(text)).toContain("[-] Implement projection and slots");
    fake.emitChanged(empty("s1"));
    text = await frame(setup, "sidebar-empty-40x50-light");
    expect(squash(text)).toContain("Todo r4");
    expect(squash(text)).toContain("empty list");
    fake.emitChanged(held("s1", 5));
    text = await frame(setup, "sidebar-held-40x50-light");
    expect(squash(text)).toContain("Todo r5 held");
    expect(squash(text)).toContain(`hold: ${HOLD_REASON}`);
    expect(lines(text)).toContain("2/6 done, 0 dropped, 4 open");
    expect(squash(text).toLowerCase()).not.toContain("complete");
    fake.emitChanged(invalid("s1"));
    text = await frame(setup, "sidebar-invalid-40x50-light");
    expect(squash(text)).toContain("invalid: state/todo.json: unsupported schemaVersion 2");
    expect(squash(text)).not.toContain("done");
    expect(squash(text)).not.toContain("[x]");
    const summary = await mount(() => composer(fake)({ sessionID: "s1" }), 80, 24);
    expect(squash(await frame(summary, "composer-invalid-80x24-light"))).toContain("todo invalid: state/todo.json: unsupported schemaVersion 2");
  });

  test("fullscreen panel renders the full history only for its own name", async () => {
    const { fake } = start();
    const owned = panelInput(TODO_PANEL, "s1", 200);
    const own = await mount(() => panel(fake)(owned.input), 200, 50);
    expect(owned.calls.focus).toBe(1);
    expect(fake.layers).toHaveLength(2);
    const panelLayer = fake.layers[1]!();
    expect((panelLayer.commands ?? []).map((command) => [command.bind, command.id])).toEqual([["escape", undefined]]);
    await panelLayer.commands![0]!.run();
    expect(owned.calls).toEqual({ focus: 1, close: 1, toggleFullscreen: 0 });
    await settle(fake.gets[0]!, held("s1"));
    const wide = await frame(own, "panel-held-200x50-dark");
    expect(lines(wide).map((line) => line.trim())).toEqual(expect.arrayContaining([
      "Todo history r2 held",
      "session s1",
      "2/6 done, 0 dropped, 4 open",
    ]));
    for (const phase of ACTIVE_PHASES) {
      expect(squash(wide)).toContain(phase.phase);
      for (const item of phase.items) expect(squash(wide)).toContain(item.task);
    }
    expect(squash(wide)).toContain("[>] Write failing sidebar tests");
    expect(squash(wide)).toContain(`hold: ${HOLD_REASON}`);
    expect(squash(wide)).toContain("read-only");
    const small = await mount(() => panel(fake)(panelInput(TODO_PANEL, "s1", 80).input), 80, 24);
    const narrow = await frame(small, "panel-held-80x24-dark");
    expect(lines(narrow).map((line) => line.trim())).toEqual(expect.arrayContaining(["Todo history r2 held", "session s1"]));
    expect(squash(narrow)).toContain("[>] Write failing sidebar tests");
    expect(squash(narrow)).toContain(`hold: ${HOLD_REASON}`);
    for (const line of lines(narrow)) expect(line.length).toBeLessThanOrEqual(80);
    const stranger = panelInput("other-plugin.panel", "s1", 200);
    const foreign = await mount(() => panel(fake)(stranger.input), 200, 50);
    expect(squash(await frame(foreign))).toBe("");
    expect(stranger.calls.focus).toBe(0);
    expect(fake.layers[fake.layers.length - 1]!().commands ?? []).toHaveLength(0);
  });

  test("a live theme switch recolours every rendered text, including the title", async () => {
    const { fake } = start("dark");
    const side = await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 50);
    await settle(fake.gets[0]!, held("s1"));
    const summary = await mount(() => composer(fake)({ sessionID: "s1" }), 80, 24);
    const own = await mount(() => panel(fake)(panelInput(TODO_PANEL, "s1", 80).input), 80, 24);
    const spansOf = async (setup: Setup) => {
      await setup.renderOnce();
      return setup.captureSpans().lines.flatMap((line) => line.spans);
    };
    const colored = (spans: Awaited<ReturnType<typeof spansOf>>, text: string, color: { equals(other: unknown): boolean }) =>
      spans.some((span) => span.text.includes(text) && color.equals(span.fg));
    const expectTheme = async (mode: Mode, name: string) => {
      const theme = themes[mode];
      const sideSpans = await spansOf(side);
      snapshotIf(side, `sidebar-held-40x50-${name}`);
      expect(colored(sideSpans, "Todo", theme.text.base)).toBe(true);
      expect(colored(sideSpans, " r2", theme.text.muted)).toBe(true);
      expect(colored(sideSpans, " held", theme.text.feedback.warning.base)).toBe(true);
      expect(colored(sideSpans, "2/6 done", theme.text.base)).toBe(true);
      expect(colored(sideSpans, "now:", theme.text.feedback.info.base)).toBe(true);
      expect(colored(sideSpans, "hold:", theme.text.base)).toBe(true);
      expect(colored(sideSpans, "[!]", theme.text.feedback.warning.base)).toBe(true);
      expect(colored(sideSpans, "Investigation", theme.text.base)).toBe(true);
      expect(colored(sideSpans, "[x]", theme.text.feedback.success.base)).toBe(true);
      expect(colored(sideSpans, "Read plan", theme.text.base)).toBe(true);
      expect(colored(sideSpans, "[ ]", theme.text.base)).toBe(true);
      expect(colored(sideSpans, "[>]", theme.text.feedback.info.base)).toBe(true);
      expect(colored(sideSpans, "Write failing", theme.text.base)).toBe(true);
      const summarySpans = await spansOf(summary);
      expect(colored(summarySpans, "todo 2/6", theme.text.base)).toBe(true);
      expect(colored(summarySpans, "now:", theme.text.feedback.info.base)).toBe(true);
      expect(colored(summarySpans, "[!]", theme.text.feedback.warning.base)).toBe(true);
      expect(colored(summarySpans, "hold:", theme.text.base)).toBe(true);
      const panelSpans = await spansOf(own);
      expect(colored(panelSpans, "Todo history", theme.text.base)).toBe(true);
      expect(colored(panelSpans, "session", theme.text.muted)).toBe(true);
      expect(colored(panelSpans, "[>]", theme.text.feedback.info.base)).toBe(true);
      expect(colored(panelSpans, "read-only", theme.text.muted)).toBe(true);
    };
    await expectTheme("dark", "dark-before-switch");
    fake.setThemeMode("light");
    await expectTheme("light", "light-after-switch");
    expect(colored(await spansOf(side), "2/6 done", themes.dark.text.base)).toBe(false);
    fake.setThemeMode("dark");
    await expectTheme("dark", "dark-after-switch");
  });

  test("task text is rendered as plain text, never as markup or terminal control", async () => {
    const { fake } = start();
    const setup = await mount(() => panel(fake)(panelInput(TODO_PANEL, "s1", 200).input), 200, 50);
    await settle(fake.gets[0]!, injected("s1"));
    const text = await frame(setup, "panel-injection-200x50-dark");
    expect(text).not.toContain("\u001b");
    expect(squash(text)).toContain("**bold** <b>html</b> [link](http://example.invalid) `code` $(touch pwned)");
    expect(squash(text)).toContain("# Heading phase");
    expect(squash(text)).toContain("[31mred");
  });
});

// ============================================================ tui-stale-unregistered-and-disposed
describe("tui-stale-unregistered-and-disposed", () => {
  test("unregistered RPC keeps the area and the command hidden", async () => {
    const { fake } = start();
    const setup = await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 50);
    expect(flag((await layer(fake)).enabled)).toBe(false);
    await fail(fake.gets[0]!, { type: "rpc.unavailable", message: "open-gajae.todo is not registered" });
    expect(squash(await frame(setup))).toBe("");
    const summary = await mount(() => composer(fake)({ sessionID: "s1" }), 80, 24);
    expect(squash(await frame(summary))).toBe("");
    expect(flag((await layer(fake)).enabled)).toBe(false);
    expect((await layer(fake)).commands ?? []).toHaveLength(0);
    expect(fake.gets).toHaveLength(1);
  });

  test("a disabled snapshot renders no area and disables the command; a later enabled snapshot restores both", async () => {
    const { fake } = start();
    const setup = await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 50);
    await settle(fake.gets[0]!, disabled("s1"));
    expect(squash(await frame(setup))).toBe("");
    expect(flag((await layer(fake)).enabled)).toBe(false);
    expect((await layer(fake)).commands ?? []).toHaveLength(0);
    fake.emitChanged(missing("s1"));
    expect(squash(await frame(setup, "sidebar-missing-40x50-dark"))).toContain("no todo list yet");
    const current = await layer(fake);
    expect(flag(current.enabled)).toBe(true);
    const commands = current.commands ?? [];
    expect(commands.map((command) => command.id)).toEqual([TODO_VIEW_COMMAND]);
    expect(commands.every((command) => flag(command.enabled))).toBe(true);
  });

  test("the only command is palette-only, unbound, slash-free and opens its own fullscreen panel", async () => {
    const { fake } = start();
    await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 50);
    await settle(fake.gets[0]!, active("s1"));
    const current = await layer(fake);
    expect(current.mode).toBe("global");
    const commands = current.commands ?? [];
    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command.id).toBe(TODO_VIEW_COMMAND);
    expect(command.bind).toBe(false);
    expect(command.palette).toBe(true);
    expect(command.slash).toBeUndefined();
    const before = fake.methods.length;
    await command.run();
    expect(fake.panelOpens).toEqual([{ name: TODO_PANEL, presentation: "fullscreen" }]);
    expect(fake.methods.length).toBe(before);
    expect(fake.methods.every((method) => method === "get")).toBe(true);
  });

  test("a late response for a previously selected session is discarded", async () => {
    const { fake } = start();
    const [sessionID, setSessionID] = createSignal("s1");
    const input = { get sessionID() { return sessionID(); } };
    const setup = await mount(() => sidebar(fake)(input), 40, 50);
    expect(fake.gets.map((get) => get.sessionID)).toEqual(["s1"]);
    setSessionID("s2");
    await frame(setup);
    expect(fake.gets.map((get) => get.sessionID)).toEqual(["s1", "s2"]);
    await settle(fake.gets[0]!, active("s1", 9));
    expect(squash(await frame(setup))).toBe("");
    fake.emitChanged(active("s1", 10));
    expect(squash(await frame(setup))).toBe("");
    await settle(fake.gets[1]!, terminal("s2"));
    const text = await frame(setup);
    expect(squash(text)).toContain("Todo r3");
    expect(lines(text)).toContain("3/4 done, 1 dropped, 0 open");
  });

  test("reverse revisions keep the newest board: 3 then 2 stays 3", async () => {
    const { fake } = start();
    const setup = await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 50);
    fake.emitChanged(active("s1", 3));
    expect(squash(await frame(setup))).toContain("Todo r3");
    fake.emitChanged(terminal("s1", 2));
    expect(squash(await frame(setup))).toContain("Todo r3");
    expect(squash(await frame(setup))).not.toContain("dropped, 0 open");
    await settle(fake.gets[0]!, terminal("s1", 2));
    const text = await frame(setup, "sidebar-reverse-revision-40x50-dark");
    expect(squash(text)).toContain("Todo r3");
    expect(lines(text)).toContain("2/6 done, 0 dropped, 4 open");
    expect(squash(text)).not.toContain("3/4 done");
  });

  for (const reason of ["storage_failure", "uncertain_storage", "invalid_storage", "child_result_ambiguous", "child_result_cancelled"]) {
    test(`B10-2: same-revision ${reason} reaches an already-ready TUI`, async () => {
      const { fake } = start();
      const setup = await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 50);
      await settle(fake.gets[0]!, active("s1", 1));
      fake.emitChanged(todoView(snapshot("s1", 1, ACTIVE_PHASES, { reason })));
      expect(squash(await frame(setup, `same-revision-${reason}`))).toContain(`hold: ${reason}`);
      fake.emitNative("session.tool.success", "s1");
      await settle(fake.gets[1]!, active("s1", 1));
      expect(squash(await frame(setup))).not.toContain(`hold: ${reason}`);
    });
  }

  test("B10-2: stale same-revision responses and lower revisions cannot clear a new hold", async () => {
    const { fake } = start();
    const setup = await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 50);
    fake.emitChanged(todoView(snapshot("s1", 1, ACTIVE_PHASES, { reason: "storage_failure" })));
    await settle(fake.gets[0]!, active("s1", 1));
    expect(squash(await frame(setup))).toContain("hold: storage_failure");
    fake.emitChanged(active("s1", 2));
    fake.emitChanged(todoView(snapshot("s1", 1, ACTIVE_PHASES, { reason: "uncertain_storage" })));
    expect(squash(await frame(setup))).toContain("Todo r2");
    expect(squash(await frame(setup))).not.toContain("hold:");
    fake.emitChanged(terminal("s1", 2));
    expect(lines(await frame(setup))).toContain("2/6 done, 0 dropped, 4 open");
  });

  test("B10-2: a duplicate hold event fences an older same-revision refresh", async () => {
    const { fake } = start();
    const setup = await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 50);
    const held = todoView(snapshot("s1", 1, ACTIVE_PHASES, { reason: "storage_failure" }));
    await settle(fake.gets[0]!, held);
    fake.emitNative("session.tool.success", "s1");
    fake.emitChanged(held);
    await settle(fake.gets[1]!, active("s1", 1));
    expect(squash(await frame(setup))).toContain("hold: storage_failure");
    fake.emitChanged(todoView(snapshot("s1", 1, ACTIVE_PHASES, { reason: "uncertain_storage" })));
    const text = squash(await frame(setup));
    expect(text).toContain("hold: uncertain_storage");
    expect(text).not.toContain("hold: storage_failure");
  });

  test("a lower revision never replaces or resurrects over a newer one across an invalid view", async () => {
    const { fake } = start();
    const setup = await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 50);
    await settle(fake.gets[0]!, active("s1", 3));
    expect(squash(await frame(setup))).toContain("Todo r3");
    fake.emitChanged(invalid("s1"));
    expect(squash(await frame(setup))).toContain("invalid: state/todo.json: unsupported schemaVersion 2");
    fake.emitChanged(terminal("s1", 2));
    let text = await frame(setup, "sidebar-invalid-after-reverse-40x50-dark");
    expect(squash(text)).toContain("Todo invalid");
    expect(squash(text)).toContain("invalid: state/todo.json: unsupported schemaVersion 2");
    expect(squash(text)).not.toContain("Todo r2");
    expect(squash(text)).not.toContain("3/4 done");
    fake.emitNative("session.tool.success", "s1");
    await settle(fake.gets[1]!, terminal("s1", 2));
    expect(squash(await frame(setup))).toContain("Todo invalid");
    fake.emitNative("session.tool.success", "s1");
    await settle(fake.gets[2]!, active("s1", 3));
    text = await frame(setup);
    expect(squash(text)).toContain("Todo r3");
    expect(lines(text)).toContain("2/6 done, 0 dropped, 4 open");
    fake.emitChanged(terminal("s1", 4));
    text = await frame(setup);
    expect(squash(text)).toContain("Todo r4");
    expect(lines(text)).toContain("3/4 done, 1 dropped, 0 open");
  });

  test("an emptied board keeps showing its hold in the summary, sidebar and panel", async () => {
    const { fake } = start("light");
    const held = emptyHeld("s1");
    expect(held.status === "ready" && held.counts.total === 0 && held.hold?.reason === EMPTY_HOLD_REASON).toBe(true);
    const summary = await mount(() => composer(fake)({ sessionID: "s1" }), 80, 24);
    await settle(fake.gets[0]!, held);
    const narrow = await frame(summary, "composer-empty-held-80x24-light");
    expect(squash(narrow)).toContain(`hold: ${EMPTY_HOLD_REASON}`);
    expect(squash(narrow)).toContain("todo empty list");
    expect(squash(narrow)).not.toContain("done");
    const spans = summary.captureSpans().lines.flatMap((line) => line.spans);
    expect(spans.some((span) => span.text.includes("[!]") && span.fg.equals(themes.light.text.feedback.warning.base))).toBe(true);
    expect(spans.some((span) => span.text.includes("hold:") && span.fg.equals(themes.light.text.base))).toBe(true);
    const side = await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 50);
    const sidebarText = await frame(side, "sidebar-empty-held-40x50-light");
    expect(squash(sidebarText)).toContain("Todo r7 held");
    expect(squash(sidebarText)).toContain("empty list");
    expect(squash(sidebarText)).toContain(`hold: ${EMPTY_HOLD_REASON}`);
    const own = await mount(() => panel(fake)(panelInput(TODO_PANEL, "s1", 80).input), 80, 24);
    const panelText = await frame(own, "panel-empty-held-80x24-light");
    expect(squash(panelText)).toContain("Todo history r7 held");
    expect(squash(panelText)).toContain(`hold: ${EMPTY_HOLD_REASON}`);
    fake.emitChanged(invalid("s1"));
    expect(squash(await frame(summary, "composer-invalid-after-empty-80x24-light"))).toContain("todo invalid: state/todo.json: unsupported schemaVersion 2");
  });

  test("reconnect resubscribes before refetching and drops the stale subscription", async () => {
    const { fake } = start();
    const setup = await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 50);
    await settle(fake.gets[0]!, active("s1", 1));
    const before = fake.order.length;
    fake.emitNative("server.connected");
    expect(fake.order.slice(before)).toEqual(["unsubscribe:changed", "subscribe:changed", "get:s1"]);
    expect(fake.listenerCount()).toBe(fake.nativeTypes().length + 1);
    await settle(fake.gets[1]!, active("s1", 5));
    expect(squash(await frame(setup))).toContain("Todo r5");
    await settle(fake.gets[1]!, active("s1", 5));
    expect(fake.gets).toHaveLength(2);
  });

  test("native tool and execution events refetch only the selected session, coalesced", async () => {
    const { fake } = start();
    const setup = await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 50);
    await settle(fake.gets[0]!, active("s1", 1));
    expect(fake.nativeTypes()).toEqual([
      "server.connected",
      "session.execution.failed",
      "session.execution.interrupted",
      "session.execution.succeeded",
      "session.tool.failed",
      "session.tool.success",
    ]);
    fake.emitNative("session.tool.success", "s2");
    expect(fake.gets).toHaveLength(1);
    fake.emitNative("session.tool.success", "s1");
    fake.emitNative("session.execution.succeeded", "s1");
    expect(fake.gets).toHaveLength(2);
    await settle(fake.gets[1]!, active("s1", 2));
    expect(fake.gets).toHaveLength(3);
    await settle(fake.gets[2]!, active("s1", 3));
    expect(fake.gets).toHaveLength(3);
    expect(squash(await frame(setup))).toContain("Todo r3");
  });

  test("unmount removes every subscription and ignores late responses and events", async () => {
    const { fake, cleanup } = start();
    const setup = await mount(() => sidebar(fake)({ sessionID: "s1" }), 40, 50);
    await settle(fake.gets[0]!, active("s1", 1));
    fake.emitNative("session.tool.success", "s1");
    expect(fake.gets).toHaveLength(2);
    expect(fake.claims).toHaveLength(3);
    await cleanup();
    expect(fake.listenerCount()).toBe(0);
    expect(fake.claims).toHaveLength(0);
    await settle(fake.gets[1]!, active("s1", 8));
    fake.emitChanged(active("s1", 9));
    fake.emitNative("server.connected");
    fake.emitNative("session.execution.succeeded", "s1");
    expect(fake.gets).toHaveLength(2);
    expect(fake.order.filter((entry) => entry.startsWith("subscribe:"))).toHaveLength(1);
    expect(squash(await frame(setup))).not.toContain("Todo r8");
  });
});
