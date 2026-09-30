// The workflow transaction journal `state/transactions/<mutation id>.json`
// that wraps a cross-skill handoff (ultragoal revision plan C-5). It is
// evidence only: nothing replays or rolls it back, and the doctor does not
// read it (I-19). Every `*Tx` function takes the `tx` of one
// `StateStore.workflowTransaction` (C-1).
//
// Source: gajae-code 5c5231418930673e42cc5d08ebe4376e03187533 (MIT),
// `packages/coding-agent/src/`:
// - `gjc-runtime/state-writer.ts:82-92` (`WorkflowTransactionJournal`),
//   `:1590-1640` (`beginWorkflowTransactionJournal`,
//   `updateWorkflowTransactionJournal`, `completeWorkflowTransactionJournal`)
// - `gjc-runtime/session-layout.ts:36-38,177-179` (`encodeSessionSegment`,
//   `transactionJournalPath`)
// Deviations:
// - Every journal write and its removal leave an audit row (C-6), with the
//   journal's mutation id; gjc does not audit journals.
// - The no-clobber create is a check and a write inside the session's one
//   queue (C-1), where gjc opens the file with `wx`: an existing journal is
//   kept and its path returned in both.

import path from "node:path";
import type { WorkflowTx } from "../state.js";
import { type AuditOwner, appendAudit } from "./audit.js";

export type WorkflowTransactionJournal = {
  version: 1;
  mutation_id: string;
  status: "pending" | "committed";
  created_at: string;
  updated_at: string;
  caller?: string;
  callee?: string;
  paths: string[];
  steps: string[];
};

/** gjc `transactionJournalPath`: one encoded path component per mutation id. */
export function journalPath(tx: WorkflowTx, mutationId: string): string {
  const name = encodeURIComponent(mutationId).replaceAll(".", "%2E");
  return path.join(tx.paths.transactionsDir, `${name}.json`);
}

async function writeJournalTx(
  tx: WorkflowTx,
  file: string,
  journal: Record<string, unknown>,
  mutationId: string,
  owner: AuditOwner,
): Promise<void> {
  await tx.writeText(file, `${JSON.stringify(journal, null, 2)}\n`);
  await appendAudit(tx, {
    category: "state",
    verb: "write-transaction-journal",
    owner,
    mutationId,
    path: file,
  });
}

/** gjc `beginWorkflowTransactionJournal`: a `pending` journal, never clobbered. */
export async function beginWorkflowTransactionJournalTx(
  tx: WorkflowTx,
  input: {
    mutationId: string;
    caller?: string;
    callee?: string;
    paths: string[];
  },
  owner: AuditOwner,
): Promise<string> {
  const file = journalPath(tx, input.mutationId);
  if ((await tx.readText(file)) !== undefined) return file;
  const at = new Date().toISOString();
  const journal: WorkflowTransactionJournal = {
    version: 1,
    mutation_id: input.mutationId,
    status: "pending",
    created_at: at,
    updated_at: at,
    caller: input.caller,
    callee: input.callee,
    paths: input.paths,
    steps: [],
  };
  await writeJournalTx(tx, file, journal, input.mutationId, owner);
  return file;
}

/** gjc `updateWorkflowTransactionJournal`: a merge patch and a new `updated_at`. */
export async function updateWorkflowTransactionJournalTx(
  tx: WorkflowTx,
  mutationId: string,
  patch: Partial<WorkflowTransactionJournal>,
  owner: AuditOwner,
): Promise<string> {
  const file = journalPath(tx, mutationId);
  const text = await tx.readText(file);
  const current = text === undefined ? {} : (JSON.parse(text) as Record<string, unknown>);
  await writeJournalTx(
    tx,
    file,
    { ...current, ...patch, updated_at: new Date().toISOString() },
    mutationId,
    owner,
  );
  return file;
}

/**
 * gjc `completeWorkflowTransactionJournal`: `committed`, then removed; a
 * failed removal leaves the committed journal and is not an error.
 */
export async function completeWorkflowTransactionJournalTx(
  tx: WorkflowTx,
  mutationId: string,
  owner: AuditOwner,
): Promise<void> {
  const file = await updateWorkflowTransactionJournalTx(
    tx,
    mutationId,
    { status: "committed" },
    owner,
  );
  // gjc `atomicRemove(...).catch(() => false)`: the handoff already happened.
  const removed = await tx.remove(file).catch(() => "failed" as const);
  if (removed === "deleted")
    await appendAudit(tx, {
      category: "state",
      verb: "remove-transaction-journal",
      owner,
      mutationId,
      path: file,
    });
}
