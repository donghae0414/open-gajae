// The workflow audit log `state/audit.jsonl`: one row per workflow file change
// (ultragoal revision plan C-6, ralplan DR-18). Every workflow skill writes it
// inside a `StateStore.workflowTransaction`. Moved from
// `src/ralplan-runtime/store.ts` (plan S1).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/gjc-runtime/state-writer.ts:517-532`
// (`maybeAudit`).
// Deviation (ralplan 21): audit `owner` is `open-gajae-runtime` /
// `open-gajae-hook`, where gjc writes `gjc-runtime` / `gjc-hook`.

import { randomUUID } from "node:crypto";
import type { WorkflowTx } from "../state.js";

/** Deviation 21: gjc `gjc-runtime` / `gjc-hook`. */
export const RUNTIME_OWNER = "open-gajae-runtime" as const;
export const HOOK_OWNER = "open-gajae-hook" as const;
export type AuditOwner = typeof RUNTIME_OWNER | typeof HOOK_OWNER;

export type AuditInput = {
  category: "state" | "artifact" | "ledger";
  verb: string;
  owner: AuditOwner;
  /** gjc sets it for mode-state, artifact and ledger rows, not active rows. */
  skill?: string;
  mutationId?: string;
  fromPhase?: string;
  toPhase?: string;
  forced?: boolean;
  path: string;
};

/**
 * gjc `maybeAudit`: `{ts, skill, category, verb, owner, mutation_id,
 * from_phase, to_phase, forced, paths}`; absent optional keys are omitted.
 */
export async function appendAudit(tx: WorkflowTx, row: AuditInput): Promise<void> {
  await tx.appendLine(
    tx.paths.auditPath,
    JSON.stringify({
      ts: new Date().toISOString(),
      skill: row.skill,
      category: row.category,
      verb: row.verb,
      owner: row.owner,
      mutation_id: row.mutationId ?? randomUUID(),
      from_phase: row.fromPhase,
      to_phase: row.toPhase,
      forced: row.forced ?? false,
      paths: [row.path],
    }),
  );
}
