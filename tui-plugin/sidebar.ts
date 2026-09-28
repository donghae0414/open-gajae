// Ralplan progress in the OpenCode v2 TUI sidebar (spec D-H3~D-H7). The server's
// `ralplan` tool computes the HUD chips and writes them to the session's
// `state/skill-active-state.json`; this file only polls that snapshot and draws
// the ralplan row. Files only, no RPC or events (D-H4), so a TUI attached to a
// server on another file system finds nothing and stays hidden.
//
// Source: oh-my-openagent d1557a4b48fdbec06a7144fdc4afa3e65c6523ed (Sustainable
// Use License) `packages/omo-opencode/src/tui.ts:47-68,137-183` and
// `features/tui-sidebar/element-helpers.ts` — a renderer-agnostic view tree
// materialized with `@opentui/solid` `createElement/insert/setProp`, a ~1 s
// `setTimeout` poll that never overlaps, a view-key compare and ignored poll
// errors — modified for open-gajae: one poll per mounted slot, keyed by its
// session, and no heartbeat/stale mirror. Chip data and order: gajae-code
// 5c5231418930673e42cc5d08ebe4376e03187533 (MIT) `skill-state/active-state.ts`
// (`SkillActiveEntry.hud`) and `modes/components/skill-hud/render.ts:35-64`,
// drawn as one gjc `label=value` line per chip in the theme's feedback
// colors, success included (spec D-H5; gjc's renderer leaves success dim).

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Plugin } from "@opencode/plugin/tui";
import { TextAttributes } from "@opentui/core";
import { createElement, insert, setProp, type JSX } from "@opentui/solid";
import { createMemo, createSignal, onCleanup } from "solid-js";

type Severity = "info" | "warning" | "blocked" | "error" | "success";
type Chip = {
  label: string;
  value?: string;
  priority?: number;
  severity?: Severity;
};
/** The ralplan row; `undefined` hides it. */
type View = { chips: Chip[] } | undefined;
type ViewNode = {
  kind: "box" | "text";
  props: Record<string, unknown>;
  text?: string;
  children?: ViewNode[];
};
type Context = Pick<Plugin.Context, "data" | "theme">;

export interface SidebarOptions {
  ctx: Context;
  /** About one second, as OMO; tests pass a short interval. */
  pollMs?: number;
  readFile?: (file: string) => Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChip(value: unknown): value is Chip {
  return (
    isRecord(value) &&
    typeof value.label === "string" &&
    (value.value === undefined || typeof value.value === "string")
  );
}

/** gjc `compareChips`: priority (default 50), then label. */
function byPriority(a: Chip, b: Chip): number {
  return (
    (a.priority ?? 50) - (b.priority ?? 50) || a.label.localeCompare(b.label)
  );
}

/**
 * The ralplan row of a snapshot: shown while its entry is active or carries a
 * `pending` (approval) chip, hidden when there is no entry (D-H6).
 */
function ralplanView(raw: string): View {
  const snapshot: unknown = JSON.parse(raw);
  const entries =
    isRecord(snapshot) && Array.isArray(snapshot.active_skills)
      ? snapshot.active_skills
      : [];
  const entry = entries.find(
    (item) => isRecord(item) && item.skill === "ralplan",
  );
  if (!isRecord(entry)) return undefined;
  const hud = isRecord(entry.hud) ? entry.hud : {};
  const chips = (Array.isArray(hud.chips) ? hud.chips : [])
    .filter(isChip)
    .sort(byPriority);
  if (entry.active !== true && !chips.some((chip) => chip.label === "pending"))
    return undefined;
  return { chips };
}

function viewKey(view: View): string {
  return JSON.stringify(view ?? null);
}

function chipColor(
  severity: Chip["severity"],
  theme: Context["theme"],
): unknown {
  if (severity === "blocked" || severity === "error")
    return theme.text.feedback.error.base;
  if (severity === "warning") return theme.text.feedback.warning.base;
  if (severity === "success") return theme.text.feedback.success.base;
  return theme.text.muted;
}

function viewNodes(view: NonNullable<View>, theme: Context["theme"]): ViewNode {
  const title: ViewNode = {
    kind: "text",
    props: { fg: theme.text.base, attributes: TextAttributes.BOLD },
    text: "ralplan",
  };
  const chips = view.chips.map((chip): ViewNode => ({
    kind: "text",
    props: { fg: chipColor(chip.severity, theme) },
    // gjc `formatChip` (`modes/components/skill-hud/render.ts:56-63`).
    text: chip.value ? `${chip.label}=${chip.value}` : chip.label,
  }));
  return { kind: "box", props: {}, children: [title, ...chips] };
}

function materialize(node: ViewNode): ReturnType<typeof createElement> {
  const element = createElement(node.kind);
  for (const [name, value] of Object.entries(node.props))
    setProp(element, name, value);
  if (node.text !== undefined) insert(element, node.text);
  for (const child of node.children ?? []) insert(element, materialize(child));
  return element;
}

/** A missing file or folder means "nothing to show"; other errors reach the poll. */
function missing(error: NodeJS.ErrnoException): undefined {
  if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
  throw error;
}

/**
 * The server's `.open-gajae` parent is `ctx.location.project.directory`
 * (`src/index.ts`), which the host's `Project.resolve` derives by taking the
 * realpath and walking up to the first folder holding `.git` (file or folder)
 * or `.hg`, else keeping the location (`core/src/project.ts:341-381`). The TUI
 * does not get that value: `ctx.location` may be absent and `Project.canonical`
 * is the main checkout, not a linked worktree, so the walk is repeated here.
 */
async function projectRoot(location: string): Promise<string> {
  const start = await fs.realpath(location).catch(() => location);
  for (let dir = start; ; dir = path.dirname(dir)) {
    for (const marker of [".git", ".hg"]) {
      const found = await fs.access(path.join(dir, marker)).then(
        () => true,
        () => false,
      );
      if (found) return dir;
    }
    if (path.dirname(dir) === dir) return start;
  }
}

/** The `sidebar.content` render: one poll loop per mounted slot. */
export function createSidebar({
  ctx,
  pollMs = 1000,
  readFile = (file) => fs.readFile(file, "utf8"),
}: SidebarOptions) {
  async function readView(
    sessionID: string,
    requested: Set<string>,
  ): Promise<View> {
    // The server keys the session folder by the lineage root.
    const root = ctx.data.session.root(sessionID);
    // Not in the TUI cache yet (`client/src/solid/data.ts:1340-1342`): ask the
    // host to load it once per poll loop (`session.sync`, `:1585-1609`; errors
    // ignored), hide for this poll, and retry on the next one.
    const location = ctx.data.session.get(root)?.location.directory;
    if (location === undefined) {
      if (!requested.has(root)) {
        requested.add(root);
        void ctx.data.session.sync(root).catch(() => undefined);
      }
      return undefined;
    }
    const base = path.join(await projectRoot(location), ".open-gajae");
    const suffix = `-${root}`;
    const names = (await fs.readdir(base).catch(missing)) ?? [];
    const matches = names.filter(
      (name) => name.startsWith("_session-") && name.endsWith(suffix),
    );
    // None yet, or ambiguous (`src/state.ts` fails closed on two matches too).
    if (matches.length !== 1) return undefined;
    const file = path.join(
      base,
      matches[0],
      "state",
      "skill-active-state.json",
    );
    const raw = await readFile(file).catch(missing);
    return raw === undefined ? undefined : ralplanView(raw);
  }

  return (input: { readonly sessionID: string }): JSX.Element => {
    const [view, setView] = createSignal<View>(undefined, {
      equals: (a, b) => viewKey(a) === viewKey(b),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const requested = new Set<string>();
    // Each poll arms the next only after it settles, so reads never overlap
    // (the in-flight guard). An error keeps the last view; the next poll retries.
    const poll = async () => {
      try {
        const next = await readView(input.sessionID, requested);
        if (!disposed) setView(next);
      } catch {
        // Ignored, as OMO: a torn read or a transient fs error is not shown.
      }
      if (!disposed) timer = setTimeout(poll, pollMs);
    };
    void poll();
    onCleanup(() => {
      disposed = true;
      clearTimeout(timer);
    });
    // A memo rather than a wrapper box, so a hidden row leaves no gap in the
    // sidebar column. Reading `ctx.theme` here follows theme switches.
    const row = createMemo(() => {
      const current = view();
      return current && materialize(viewNodes(current, ctx.theme));
    });
    return row as unknown as JSX.Element;
  };
}
