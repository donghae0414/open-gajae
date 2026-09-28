// gjc format compatibility (spec D-V3, AC26): the key sets, value types and
// naming of our ledger rows, stage file names, receipts and disposition JSON
// against real gjc 5c52314 output in `tests/fixtures/gjc-ralplan/` (see its
// SOURCE.md). Values differ by design; shapes must not, except for the
// intended deviations listed in INTENDED_EXCEPTIONS.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RALPLAN_STAGES } from "../src/ralplan-runtime/manifest";
import { StateStore } from "../src/state";
import { createTools } from "../src/tools";

const FIXTURES = join(import.meta.dir, "fixtures", "gjc-ralplan");
const ROOT = "ses_root";

/**
 * Intended deviations from the gjc shapes (plan §7.1); everything else must
 * match key for key and type for type.
 * - repository_binding: best effort and record-only (deviation 12, D-T9). In a
 *   non-git project `commonDir` is null and `head`/`branch` are omitted; the
 *   whole value may be null. Checked separately, then removed.
 * - Values only: role ids are OpenCode session ids (`ses_…`, deviation 5),
 *   run_id defaults to the native root session id (OQ3), and paths live under
 *   `.open-gajae/_session-<created>-<id>/` instead of `.gjc/_session-<id>/`
 *   (deviation 3). Types and the `plans/ralplan/<run>/<file>` tail match.
 * - `.omc` in a gjc run folder is not produced by the gjc ralplan runtime.
 */
const INTENDED_EXCEPTIONS = { bindingKeys: ["schema", "worktreeRoot", "commonDir", "displayPath", "head", "branch"], foreignRunEntries: [".omc"] };

/** Sorted key → type tree; arrays by their first element. */
function shape(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length > 0 ? [shape(value[0])] : [];
  if (typeof value === "object")
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((key) => [key, shape((value as Record<string, unknown>)[key])]),
    );
  return typeof value;
}

function withoutBinding(receipt: Record<string, unknown>): Record<string, unknown> {
  const { repository_binding, ...rest } = receipt;
  const binding = repository_binding as Record<string, unknown> | null;
  if (binding !== null) {
    expect(binding.schema).toBe("gjc.repository_binding.v1");
    for (const key of Object.keys(binding)) expect(INTENDED_EXCEPTIONS.bindingKeys).toContain(key);
  }
  return rest;
}

const STAGE_FILE = new RegExp(`^stage-\\d{2}-(${RALPLAN_STAGES.join("|")})\\.md$`);
const STAGE_PATH = new RegExp(`/_session-[^/]+/plans/ralplan/[^/]+/stage-\\d{2}-(${RALPLAN_STAGES.join("|")})\\.md$`);
const fixture = async (name: string) => JSON.parse(await readFile(join(FIXTURES, name), "utf8"));
const fixtureLedger = async () =>
  (
    await Promise.all(
      ["01a0ba1a-c9c1-7188-8020-24474005f3f9", "ultragoal-gjc-parity-20260921"].map((run) =>
        readFile(join(FIXTURES, "ledger", `${run}.index.jsonl`), "utf8"),
      ),
    )
  )
    .join("")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

test("ledger rows, file names, receipts and disposition match the gjc shapes (AC26)", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-gajae-compat-"));
  try {
    const store = new StateStore(root, async () => 0);
    const tool = createTools(store, { locationDir: root, projectDir: root }, {
      async parentSession() {
        return undefined;
      },
      async rootSession() {
        return ROOT;
      },
    }).find((t) => t.name === "ralplan")!;
    const write = async (stage: string, n: number, content: string, agent = "open-gajae", extra: Record<string, unknown> = {}) => {
      const out = (await tool.execute(tool.input.parse({ op: "write", stage, stage_n: n, content, ...extra }) as never, { agent, sessionID: `ses_${stage}`, signal: new AbortController().signal })).content;
      return JSON.parse(out.slice(out.indexOf("\n{") + 1));
    };
    const planner = await write("planner", 1, "# Plan", "open-gajae-planner");
    await write("intent", 1, "# Intent");
    const architect = await write("architect", 1, "# Architect", "open-gajae-architect", { resumable: true, lane_verdict: "BLOCK" });
    const critic = await write("critic", 1, "# Critic");
    const receiptOf = (r: any) => ({ stage: r.stage, stageN: 1, path: r.path, sha256: r.sha256 });
    const gjcDisposition = await fixture("disposition.json");
    const ours = {
      ...gjcDisposition,
      findings: gjcDisposition.findings.map((f: any) => ({ ...f, sourceReceipt: receiptOf(f.sourceRole === "architect" ? architect : critic) })),
    };
    const disposition = await write("disposition", 1, JSON.stringify(ours));
    await write("revision", 2, "# Revision");
    await write("post-interview", 2, "# Post");
    await write("adr", 2, "# ADR");
    const final = await write("final", 2, "# Final");
    const deduplicated = await write("final", 2, "# Final");

    // Receipts: gjc `--json` payloads, key for key.
    for (const [ours, gjc] of [
      [planner, "planner.json"],
      [architect, "architect.json"],
      [final, "final.json"],
      [deduplicated, "final-deduplicated.json"],
    ] as const) {
      expect(shape(withoutBinding(ours))).toEqual(shape(withoutBinding(await fixture(join("receipts", gjc)))));
      expect(ours.path).toMatch(STAGE_PATH);
    }

    // Ledger rows: the gjc row for the same stage (final carries auto_handoff).
    const gjcRows = await fixtureLedger();
    const runDir = join(await store.resolveSessionDir(ROOT), "plans", "ralplan", ROOT);
    const ourRows = (await readFile(join(runDir, "index.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    for (const row of ourRows) {
      const gjc = gjcRows.find((candidate) => candidate.stage === row.stage);
      if (gjc) expect(shape(row)).toEqual(shape(gjc));
      else expect(shape(row)).toEqual(shape(gjcRows.find((candidate) => candidate.stage === "planner")));
      expect(row.path).toMatch(STAGE_PATH);
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const gjc of gjcRows) expect(gjc.path).toMatch(STAGE_PATH);

    // File names: the same `stage-NN-<stage>.md`, `index.jsonl`, `pending-approval.md`.
    const named = (name: string) => STAGE_FILE.test(name) || name === "index.jsonl" || name === "pending-approval.md";
    const gjcNames = Object.entries(await fixture("filenames.json"))
      .filter(([run]) => !INTENDED_EXCEPTIONS.foreignRunEntries.includes(run))
      .flatMap(([, names]) => names as string[])
      .filter((name) => !INTENDED_EXCEPTIONS.foreignRunEntries.includes(name));
    expect(gjcNames.every(named)).toBe(true);
    const ourNames = await readdir(runDir);
    expect(ourNames.every(named)).toBe(true);
    expect(ourNames).toContain("stage-01-disposition.md");

    // Disposition: gjc's document plus the derived `conflicts` its serializer adds.
    const persisted = JSON.parse(await readFile(disposition.path, "utf8"));
    const { conflicts, ...rest } = persisted;
    expect(shape(rest)).toEqual(shape(gjcDisposition));
    expect(Object.keys(conflicts[0]).sort()).toEqual(["actions", "conflictId", "findingIds", "sourceRoles", "status", "targetId"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
