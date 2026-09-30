// Injected-message markers and the one wrapper that produces marked text
// (ultragoal revision plan C-12, E-13), in a module neither skill owns.
// `src/ralplan.ts` re-exports them from their old path.
//
// n6/a3: no bare marker token is added. Every injected message is wrapped in an
// OMC-style tag, and `wrapInjected` is the ONLY way the plugin produces
// injected text: it takes a marker from `INJECTION_MARKERS`, so an injection
// site structurally cannot omit one. The skill modules build their messages
// with it; hooks only pass the built text on.
//
// Source: oh-my-claudecode v5.4.0 (MIT). `<ralplan-continuation>` and
// `<session-restore>` are OMC's own wrappers; the other markers are host
// additions, noted per entry. Moved from `src/ralplan.ts:22-50`; the goal
// markers were added afterwards (ultragoal revision plan S2).

export const INJECTION_MARKERS = [
  "<ralplan-continuation>", // OMC src/hooks/persistent-mode/index.ts:2147
  // OMC src/hooks/bridge.ts:2074; now only the ultragoal restore notice uses it.
  "<session-restore>",
  "<ralplan-notice>", // host addition: wraps the keyword and breaker notices
  // Host addition (plan D-H2/AC19): the ralplan compaction recovery context,
  // rendered by `./ralplan-runtime/recovery.ts`.
  "<ralplan-compaction-context>",
  // Host addition: wraps OMC's `[MAGIC KEYWORD: DEEP-INTERVIEW]` guide, which
  // OMC emitted bare as `additionalContext` (scripts/keyword-detector.mjs:1544).
  "<deep-interview-notice>",
  // Host additions for ultragoal (plan §5.3): the loop message OMC's
  // `<ralph-continuation>` carried, the plugin notices, the reviewer brief the
  // plugin appends to a `subagent` prompt, and the compaction system part.
  "<ultragoal-continuation>",
  "<ultragoal-notice>",
  "<ultragoal-verification-brief>",
  "<ultragoal-compaction-context>",
  // Host additions for the goal loop (ultragoal revision plan C-9, C-12): the
  // continuation, the goal context and the goal notices.
  "<goal-continuation>",
  "<goal-context>",
  "<goal-notice>",
] as const;

export type InjectionMarker = (typeof INJECTION_MARKERS)[number];

/** The markers `src/ultragoal.ts` may wrap its messages in. */
export type UltragoalMarker =
  | "<ultragoal-continuation>"
  | "<ultragoal-notice>"
  | "<ultragoal-verification-brief>"
  | "<ultragoal-compaction-context>"
  | "<session-restore>";

export function wrapInjected(tag: InjectionMarker, body: string): string {
  const name = tag.slice(1, -1);
  return `<${name}>\n\n${body}\n\n</${name}>\n\n---\n\n`;
}

/** The one wrapper `src/ultragoal.ts` builds its messages with. */
export function wrapUltragoalInjected(tag: UltragoalMarker, body: string) {
  return wrapInjected(tag, body);
}
