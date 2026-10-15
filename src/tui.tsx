// Original open-gajae read-only todo TUI (todo-agent-performance, task 6).
// Host contract inspected: @opencode/plugin 2.0.26 dist/tui/context.d.ts
// (SlotMap, KeymapCommand, UI.panel) and @opencode/client 2.0.26
// RpcClient.events.on; linkage per R20 (official Solid transform, bare runtime
// imports). The TUI only reads the shared protocol's `get` and `changed`,
// keeps one ephemeral projection of the selected session and never writes a
// board, a StateStore or the filesystem.
import { Plugin } from "@opencode/plugin/tui";
import { useTerminalDimensions } from "@opentui/solid";
import { createComputed, createMemo, createSignal, For, onMount, Show } from "solid-js";
import {
  todoChangedSchema,
  todoRpc,
  todoViewSchema,
  type TodoReadyView,
  type TodoView,
} from "./todo/protocol.js";
import type { TodoStatus } from "./todo/state.js";

export const TODO_PANEL = "open-gajae.todo";
export const TODO_VIEW_COMMAND = "open-gajae.todo.view";
// The 2.0.26 host hides its sidebar below this width even with session.sidebar:"show".
export const WIDE_COLUMNS = 200;
// Rows the host and its own sidebar sections need; the full item list only
// unfolds in the sidebar when the rest fits beneath them.
const SIDEBAR_RESERVED_ROWS = 24;
const SIDEBAR_HEADER_ROWS = 4;

export type TodoHostEventType =
  | "server.connected"
  | "session.execution.failed"
  | "session.execution.interrupted"
  | "session.execution.succeeded"
  | "session.tool.failed"
  | "session.tool.success";
const REFRESH_EVENTS: readonly Exclude<TodoHostEventType, "server.connected">[] = [
  "session.execution.failed",
  "session.execution.interrupted",
  "session.execution.succeeded",
  "session.tool.failed",
  "session.tool.success",
];
export interface TodoHostEvent {
  readonly type: TodoHostEventType;
  readonly data: { readonly sessionID?: string };
}
export interface TodoRpcPort {
  get(input: { readonly sessionID: string }): Promise<unknown>;
  readonly events: {
    on(name: "changed", handler: (event: { readonly data: unknown }) => void | Promise<void>): () => void;
  };
}
export interface TodoTuiHost {
  readonly client: { rpc(definition: typeof todoRpc): TodoRpcPort };
  readonly data: { on(type: TodoHostEventType, handler: (event: TodoHostEvent) => void): () => void };
  readonly ui: Pick<Plugin.Context["ui"], "slot" | "panel">;
  readonly keymap: Pick<Plugin.Context["keymap"], "layer">;
  readonly theme: Plugin.Context["theme"];
}

interface TodoProjection {
  readonly enabled: () => boolean | undefined;
  readonly view: () => TodoView | undefined;
  readonly fault: () => string | undefined;
  select(sessionID: string): void;
  dispose(): void;
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message;
  return String(error);
}

// Freshness rules: a response is applied only for the selection it was issued
// for; a ready board never carries a lower revision than the highest one
// accepted for that selection, even when a missing/invalid/disabled view was
// shown in between; a board with the same revision accepts a changed hold or
// re-establishes a non-ready display only when observed after it; any other view must have
// been issued after the latest accepted update.
function createTodoProjection(host: TodoTuiHost): TodoProjection {
  const rpc = host.client.rpc(todoRpc);
  const [enabled, setEnabled] = createSignal<boolean | undefined>(undefined);
  const [view, setView] = createSignal<TodoView | undefined>(undefined);
  const [fault, setFault] = createSignal<string | undefined>(undefined);
  let selected: string | undefined;
  let token = 0;
  let stamp = 0;
  let accepted = 0;
  let revision = 0;
  let inflight = false;
  let dirty = false;
  let disposed = false;

  const accept = (issueToken: number, issueStamp: number, next: TodoView): void => {
    if (disposed || issueToken !== token || next.sessionID !== selected) return;
    if (next.status === "ready") {
      if (next.revision < revision) return;
      const current = view();
      if (next.revision === revision) {
        if (issueStamp < accepted) return;
        if (current?.status === "ready" && JSON.stringify(current.hold) === JSON.stringify(next.hold)) {
          // A duplicate does not repaint, but still fences an older response
          // that could carry a different process-local hold at this revision.
          accepted = issueStamp;
          return;
        }
      }
      revision = next.revision;
    } else if (issueStamp < accepted) return;
    accepted = Math.max(accepted, issueStamp);
    setFault(undefined);
    setEnabled(next.status !== "disabled");
    setView(next);
  };

  const read = (): void => {
    if (disposed || selected === undefined) return;
    if (inflight) {
      dirty = true;
      return;
    }
    inflight = true;
    dirty = false;
    const issueToken = token;
    const issueStamp = ++stamp;
    const finish = (outcome: () => void) => {
      try {
        outcome();
      } finally {
        if (!disposed && issueToken === token) {
          inflight = false;
          if (dirty) read();
        }
      }
    };
    rpc.get({ sessionID: selected }).then(
      (output) => finish(() => {
        const parsed = todoViewSchema.safeParse(output);
        if (parsed.success) accept(issueToken, issueStamp, parsed.data);
        else if (issueToken === token) setFault("unexpected todo view payload");
      }),
      (error) => finish(() => {
        if (issueToken === token) setFault(describeFailure(error));
      }),
    );
  };

  const onChanged = (event: { readonly data: unknown }): void => {
    if (disposed) return;
    const parsed = todoChangedSchema.safeParse(event.data);
    if (!parsed.success || parsed.data.sessionID !== selected) return;
    accept(token, ++stamp, parsed.data.view);
  };
  let unsubscribeChanged = rpc.events.on("changed", onChanged);
  const unsubscribeRefresh = REFRESH_EVENTS.map((type) => host.data.on(type, (event) => {
    if (event.data.sessionID === selected) read();
  }));
  const unsubscribeConnected = host.data.on("server.connected", () => {
    if (disposed) return;
    unsubscribeChanged();
    unsubscribeChanged = rpc.events.on("changed", onChanged);
    read();
  });

  return {
    enabled,
    view,
    fault,
    select(sessionID) {
      if (disposed || sessionID === selected) return;
      selected = sessionID;
      token++;
      inflight = false;
      dirty = false;
      accepted = 0;
      revision = 0;
      setView(undefined);
      setFault(undefined);
      read();
    },
    dispose() {
      disposed = true;
      token++;
      unsubscribeChanged();
      for (const unsubscribe of unsubscribeRefresh) unsubscribe();
      unsubscribeConnected();
    },
  };
}

// Renderers read `host.theme` inside their render expressions: the 2.0.26
// Context exposes theme as a reactive getter, so a live Color mode switch
// recolours every text only when the tokens are read where Solid tracks them,
// never through a value captured at setup.
interface Scope {
  readonly projection: TodoProjection;
  readonly host: TodoTuiHost;
}
type Theme = Plugin.Context["theme"];
type PanelInput = Parameters<Extract<Parameters<Plugin.Context["ui"]["slot"]>[0], { append: "session.panel" }>["render"]>[0];

// Semantic hues colour only short markers (these glyphs and the `now:` label);
// label text stays in the theme's base text colour so it is readable in both
// colour modes. The hold/invalid lines use a glyph because the warning hue
// alone falls below 3:1 on the host's light background.
const GLYPH: Readonly<Record<TodoStatus, string>> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
  abandoned: "[-]",
};
const ALERT_GLYPH = "[!]";

// Labels are shown verbatim as text; only control characters are neutralised
// so a label can never emit terminal control sequences.
function plain(text: string): string {
  return text.replace(/[\t\n\r]/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "\uFFFD");
}
function ready(view: TodoView | undefined): TodoReadyView | undefined {
  return view?.status === "ready" ? view : undefined;
}
function invalid(view: TodoView | undefined): Extract<TodoView, { status: "invalid" }> | undefined {
  return view?.status === "invalid" ? view : undefined;
}
function countsLine(board: TodoReadyView): string {
  const { completed, abandoned, open, total } = board.counts;
  return `${completed}/${total} done, ${abandoned} dropped, ${open} open`;
}
function summaryLine(board: TodoReadyView): string {
  const { completed, abandoned, open, total } = board.counts;
  if (total === 0) return "todo empty list";
  const dropped = abandoned > 0 ? `, ${abandoned} dropped` : "";
  return `todo ${completed}/${total} done, ${open} open${dropped}`;
}
function phaseLine(phase: TodoReadyView["phases"][number]): string {
  const completed = phase.items.filter((item) => item.status === "completed").length;
  const abandoned = phase.items.filter((item) => item.status === "abandoned").length;
  const dropped = abandoned > 0 ? `, ${abandoned} dropped` : "";
  return `${plain(phase.phase)} ${completed}/${phase.items.length}${dropped}`;
}
function statusColor(theme: Theme, status: TodoStatus) {
  switch (status) {
    case "in_progress": return theme.text.feedback.info.base;
    case "completed": return theme.text.feedback.success.base;
    case "abandoned": return theme.text.muted;
    case "pending": return theme.text.base;
  }
}

function TodoTitle(props: { readonly scope: Scope; readonly view: TodoView; readonly label: string }) {
  const theme = () => props.scope.host.theme;
  const board = () => ready(props.view);
  return (
    <text wrapMode="word" fg={theme().text.base}>
      <b>{props.label}</b>
      <span style={{ fg: theme().text.muted }}>{board() ? ` r${board()?.revision}` : ""}</span>
      <span style={{ fg: theme().text.feedback.warning.base }}>{board()?.hold ? " held" : ""}</span>
      <span style={{ fg: theme().text.feedback.error.base }}>{props.view.status === "invalid" ? " invalid" : ""}</span>
    </text>
  );
}

function TodoStatusLines(props: { readonly scope: Scope; readonly view: TodoView }) {
  const theme = () => props.scope.host.theme;
  const board = () => ready(props.view);
  return (
    <>
      <Show when={props.view.status === "missing"}>
        <text fg={theme().text.muted}>no todo list yet</text>
      </Show>
      <Show when={invalid(props.view)}>
        {(view) => (
          <text fg={theme().text.base} wrapMode="word">
            <span style={{ fg: theme().text.feedback.error.base }}>{ALERT_GLYPH}</span> invalid: {plain(view().diagnostic)}
          </text>
        )}
      </Show>
      <Show when={board()}>
        {(current) => (
          <>
            <Show when={current().counts.total === 0}>
              <text fg={theme().text.muted}>empty list</text>
            </Show>
            <Show when={current().counts.total > 0}>
              <text fg={theme().text.base} wrapMode="word">{countsLine(current())}</text>
            </Show>
            <Show when={current().focus}>
              {(focus) => (
                <text fg={theme().text.base} wrapMode="word">
                  <span style={{ fg: theme().text.feedback.info.base }}>now:</span> {plain(focus().task)}
                </text>
              )}
            </Show>
            <Show when={current().hold}>
              {(hold) => (
                <text fg={theme().text.base} wrapMode="word">
                  <span style={{ fg: theme().text.feedback.warning.base }}>{ALERT_GLYPH}</span> hold: {plain(hold().reason)}
                </text>
              )}
            </Show>
          </>
        )}
      </Show>
    </>
  );
}

function TodoFault(props: { readonly scope: Scope }) {
  return (
    <Show when={props.scope.projection.fault()}>
      {(fault) => <text fg={props.scope.host.theme.text.muted} wrapMode="word">todo unavailable: {plain(fault())}</text>}
    </Show>
  );
}

function TodoPhaseList(props: { readonly scope: Scope; readonly board: TodoReadyView; readonly expanded: boolean }) {
  const theme = () => props.scope.host.theme;
  return (
    <For each={props.board.phases}>
      {(phase) => (
        <box flexDirection="column">
          <text fg={theme().text.base} wrapMode="word">{phaseLine(phase)}</text>
          <Show when={props.expanded}>
            <For each={phase.items}>
              {(item) => (
                <text fg={item.status === "abandoned" ? theme().text.muted : theme().text.base} wrapMode="word">
                  <span style={{ fg: statusColor(theme(), item.status) }}>{GLYPH[item.status]}</span> {plain(item.task)}
                </text>
              )}
            </For>
          </Show>
        </box>
      )}
    </For>
  );
}

function TodoSidebar(props: { readonly scope: Scope; readonly sessionID: string }) {
  const dimensions = useTerminalDimensions();
  createComputed(() => props.scope.projection.select(props.sessionID));
  const visible = () => props.scope.projection.enabled() === true && props.scope.projection.view();
  const expanded = createMemo(() => {
    const board = ready(props.scope.projection.view());
    if (!board) return false;
    const needed = SIDEBAR_HEADER_ROWS + board.phases.length + board.counts.total;
    return needed <= dimensions().height - SIDEBAR_RESERVED_ROWS;
  });
  return (
    <Show when={visible()}>
      {(view) => (
        <box flexDirection="column" marginTop={1}>
          <TodoTitle scope={props.scope} view={view()} label="Todo" />
          <TodoStatusLines scope={props.scope} view={view()} />
          <Show when={ready(view())}>
            {(board) => <TodoPhaseList scope={props.scope} board={board()} expanded={expanded()} />}
          </Show>
          <TodoFault scope={props.scope} />
        </box>
      )}
    </Show>
  );
}

function TodoComposerSummary(props: { readonly scope: Scope; readonly sessionID: string }) {
  const theme = () => props.scope.host.theme;
  const dimensions = useTerminalDimensions();
  createComputed(() => props.scope.projection.select(props.sessionID));
  const summary = () => {
    if (dimensions().width >= WIDE_COLUMNS || props.scope.projection.enabled() !== true) return undefined;
    const view = props.scope.projection.view();
    if (view?.status === "invalid") return view;
    const board = ready(view);
    return board && (board.counts.total > 0 || board.hold) ? board : undefined;
  };
  return (
    <Show when={summary()}>
      {(view) => (
        <box flexDirection="column">
          <Show when={invalid(view())}>
            {(broken) => (
              <text fg={theme().text.base} wrapMode="word">
                <span style={{ fg: theme().text.feedback.error.base }}>{ALERT_GLYPH}</span> todo invalid: {plain(broken().diagnostic)}
              </text>
            )}
          </Show>
          <Show when={ready(view())}>
            {(board) => (
              <>
                <text fg={theme().text.base} wrapMode="word">
                  <span>{summaryLine(board())}</span>
                  <span style={{ fg: theme().text.muted }}>{board().focus ? " | " : ""}</span>
                  <span style={{ fg: theme().text.feedback.info.base }}>{board().focus ? "now:" : ""}</span>
                  <span>{board().focus ? ` ${plain(board().focus?.task ?? "")}` : ""}</span>
                </text>
                <Show when={board().hold}>
                  {(hold) => (
                    <text fg={theme().text.base} wrapMode="word">
                      <span style={{ fg: theme().text.feedback.warning.base }}>{ALERT_GLYPH}</span> hold: {plain(hold().reason)}
                    </text>
                  )}
                </Show>
              </>
            )}
          </Show>
          <TodoFault scope={props.scope} />
        </box>
      )}
    </Show>
  );
}

// The host owns the panel but offers no close command of its own; the layer
// below lives inside the panel contribution, so the host keeps it active only
// while the panel owns input, and its single command calls the host's close.
function TodoPanel(props: { readonly scope: Scope; readonly input: PanelInput }) {
  const theme = () => props.scope.host.theme;
  const own = () => props.input.name === TODO_PANEL;
  createComputed(() => props.scope.projection.select(props.input.sessionID));
  props.scope.host.keymap.layer(() => ({
    commands: own() ? [{
      bind: "escape",
      title: "Close todo history",
      group: "open-gajae",
      run: () => {
        props.input.close();
      },
    }] : [],
  }));
  onMount(() => {
    if (own() && props.input.presentation === "fullscreen") props.input.focus();
  });
  const visible = () => own() && props.scope.projection.enabled() === true && props.scope.projection.view();
  return (
    <Show when={visible()}>
      {(view) => (
        <box flexDirection="column" flexGrow={1} paddingX={1}>
          <TodoTitle scope={props.scope} view={view()} label="Todo history" />
          <text fg={theme().text.muted} wrapMode="word">session {plain(view().sessionID)}</text>
          <TodoStatusLines scope={props.scope} view={view()} />
          <TodoFault scope={props.scope} />
          <Show when={ready(view())}>
            {(board) => (
              <scrollbox flexGrow={1} flexBasis={0} marginTop={1} focused={props.input.focused}>
                <TodoPhaseList scope={props.scope} board={board()} expanded={true} />
              </scrollbox>
            )}
          </Show>
          <text fg={theme().text.muted} wrapMode="word">read-only view; esc closes; the todo tool is the only writer</text>
        </box>
      )}
    </Show>
  );
}

// Setup must not install its own Solid owner: the 2.0.26 host roots
// keymap.layer under the current owner when one exists, and only the host's
// plugin owner carries the Keymap context. The layer is `mode: "global"`
// because the palette dialog leaves the base input mode, so a base-mode layer
// is never listed there (the official v2 plugin docs register palette commands
// the same way). The factory is tracked by the host, so the enabled signal is
// read inside it and emitted as plain values.
function registerTodoCommand(host: TodoTuiHost, scope: Scope): void {
  host.keymap.layer(() => {
    const enabled = scope.projection.enabled() === true;
    return {
      mode: "global",
      enabled,
      commands: enabled ? [{
        id: TODO_VIEW_COMMAND,
        title: "Todo: view history",
        description: "Open the read-only todo history of this session",
        group: "open-gajae",
        bind: false,
        palette: true,
        run: () => {
          host.ui.panel.open(TODO_PANEL, { presentation: "fullscreen" });
        },
      }] : [],
    };
  });
}

export function setupTodoTui(host: TodoTuiHost): Plugin.Cleanup {
  const scope: Scope = { projection: createTodoProjection(host), host };
  registerTodoCommand(host, scope);
  const slots = [
    host.ui.slot({
      append: "sidebar.content",
      render: (input) => <TodoSidebar scope={scope} sessionID={input.sessionID} />,
    }),
    host.ui.slot({
      append: "session.composer.top",
      render: (input) => <TodoComposerSummary scope={scope} sessionID={input.sessionID} />,
    }),
    host.ui.slot({
      append: "session.panel",
      render: (input) => <TodoPanel scope={scope} input={input} />,
    }),
  ];
  return () => {
    for (const dispose of slots) dispose();
    scope.projection.dispose();
  };
}

export default Plugin.define({
  id: "open-gajae",
  setup: (context) => setupTodoTui(context),
});
