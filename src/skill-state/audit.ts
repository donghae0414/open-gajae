// The workflow audit log `state/audit.jsonl`: one row per workflow file change
// (ultragoal revision plan C-6, ralplan DR-18). The write layer of `WorkflowTx`
// (`src/state.ts`) writes it after each audited write; this module only builds
// the row (`auditLine`), names the owners and maps an owner to
// `_meta.updatedBy` (`writerFor`, one table for every skill). Moved from
// `src/ralplan-runtime/store.ts` (plan S1).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/gjc-runtime/state-writer.ts:63-74`
// (`StateWriterAuditContext`), `:517-532` (`maybeAudit`).
// Deviations (docs/development.md):
// - ralplan 21: audit `owner` is `open-gajae-runtime` / `open-gajae-hook`,
//   where gjc writes `gjc-runtime` / `gjc-hook`.
// - write-layer 1: a mode-state write's audit names `category: "state"` and
//   the mode as `skill`, checked by the type (`ModeStateAudit`).
// - write-layer 2: `fromPhase` and `forced` are write options, not audit
//   fields; the row copies them.

import { randomUUID } from "node:crypto";
import type { StateMode, StateWriter } from "../state.js";

/** Deviation 21: gjc `gjc-runtime` / `gjc-hook`. */
export const RUNTIME_OWNER = "open-gajae-runtime" as const;
export const HOOK_OWNER = "open-gajae-hook" as const;
export type AuditOwner = typeof RUNTIME_OWNER | typeof HOOK_OWNER;

/**
 * gjc `StateWriterAuditContext` without `cwd` and `sessionId`; `fromPhase`
 * and `forced` are write options (write-layer 2).
 */
export type WriteAudit = {
  category: "state" | "artifact" | "ledger";
  verb: string;
  owner: AuditOwner;
  /** gjc sets it for mode-state, artifact and ledger rows, not active rows. */
  skill?: string;
  mutationId?: string;
  toPhase?: string;
};

/** A mode-state write's audit (write-layer 1): `category` and `skill` bound to the mode. */
export type ModeStateAudit<M extends StateMode> = WriteAudit & { category: "state"; skill: M };

/**
 * gjc `maybeAudit`: `{ts, skill, category, verb, owner, mutation_id,
 * from_phase, to_phase, forced, paths}`; absent optional keys are omitted.
 */
export function auditLine(
  audit: WriteAudit,
  file: string,
  write: { fromPhase?: string; forced?: boolean } = {},
): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    skill: audit.skill,
    category: audit.category,
    verb: audit.verb,
    owner: audit.owner,
    mutation_id: audit.mutationId ?? randomUUID(),
    from_phase: write.fromPhase,
    to_phase: audit.toPhase,
    forced: write.forced ?? false,
    paths: [file],
  });
}

const UPDATED_BY: Record<StateMode, Record<AuditOwner, StateWriter>> = {
  ralplan: { [RUNTIME_OWNER]: "ralplan_tool", [HOOK_OWNER]: "ralplan_hook" },
  ultragoal: { [RUNTIME_OWNER]: "ultragoal_tool", [HOOK_OWNER]: "ultragoal_hook" },
  "deep-interview": { [RUNTIME_OWNER]: "deep_interview_tool", [HOOK_OWNER]: "deep_interview_hook" },
};

/** `_meta.updatedBy` of a `skill` mode-state write by `owner`. */
export function writerFor(skill: StateMode, owner: AuditOwner): StateWriter {
  return UPDATED_BY[skill][owner];
}
