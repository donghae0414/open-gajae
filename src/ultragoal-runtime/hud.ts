// Ultragoal HUD chips for `state/active/ultragoal.json` (`hud`), rebuilt on
// every reconcile (spec D-SF4, plan DR-16). Nothing draws them: the TUI is
// out of scope. Pure: the caller passes the derived status, the goal rows and
// the lenient latest ledger event; the row writer normalizes the summary.
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `skill-state/workflow-hud.ts:47-54` (`UltragoalHudState`), `:292-316`
//   (`buildUltragoalHudSummary`: blocked, goals, current, status, ledger)
// - `gjc-runtime/state-runtime.ts:873-925` (the ultragoal branch of
//   `buildHudForMode`: counts from the goal rows, current = first active,
//   else first pending)
// The chip helpers are shared in `../skill-state/hud.ts`. No deviation.

import {
  chip,
  compactChips,
  gateChips,
  type WorkflowGateHudState,
  type WorkflowHudSummary,
} from "../skill-state/hud.js";
import type { LatestLedgerEvent } from "./ledger.js";

export type UltragoalHudGoal = { id: string; title: string; status: string };

export interface UltragoalHudState extends WorkflowGateHudState {
  status: string;
  goals: UltragoalHudGoal[];
  latestLedgerEvent?: LatestLedgerEvent;
  updatedAt?: string;
}

/** gjc `buildUltragoalHudSummary` over the `buildHudForMode` inputs. */
export function buildUltragoalHud(state: UltragoalHudState): WorkflowHudSummary {
  const counts: Record<string, number> = {};
  for (const goal of state.goals) counts[goal.status] = (counts[goal.status] ?? 0) + 1;
  const current =
    state.goals.find((goal) => goal.status === "active") ?? state.goals.find((goal) => goal.status === "pending");
  const blockers = (counts.blocked ?? 0) + (counts.review_blocked ?? 0) + (counts.failed ?? 0);
  const ledger = state.latestLedgerEvent;
  return {
    version: 1,
    chips: compactChips([
      blockers > 0 ? { label: "blocked", value: String(blockers), priority: 5, severity: "blocked" } : null,
      chip("goals", `${counts.complete ?? 0}/${state.goals.length}`, 10),
      chip("current", current ? `${current.id}:${current.title}` : state.status, 20),
      chip("status", state.status, 30, state.status === "complete" ? "success" : undefined),
      chip(
        "ledger",
        ledger?.event ? [ledger.event, ledger.kind, ledger.goalId].filter(Boolean).join(":") : undefined,
        35,
      ),
      ...gateChips(state, 40),
    ]),
    ...(state.updatedAt ? { updated_at: state.updatedAt } : {}),
  };
}
