---
name: ralplan
description: Consensus planning with Planner, Architect, and Critic until agreement, using RALPLAN-DR structured deliberation
argument-hint: "[--interactive] [--deliberate] <task description>"
---

# Ralplan (Consensus Planning Alias)

Ralplan is the consensus planning workflow. It triggers iterative planning with Planner, Architect, and Critic agents until consensus is reached, with **RALPLAN-DR structured deliberation** (short mode by default, deliberate mode for high-risk work).

## Usage

```
@ralplan "task description"
```

A native `skill` call with id `ralplan` loads the same instructions. Loading the skill does not start a run: call `ralplan start(task, interactive?, deliberate?, run_id?)` before step 1. If the ralplan state shows `handoff_from: "deep-interview"` and you did not see the handoff's result line, read the spec at `deep-interview status`'s `spec_path` and use it as the planning input. `ralplan start` seeds the run state (`active: true`, `current_phase: "planner"`) and returns a receipt with the owner `session_id`, `run_id`, `state_path`, and `repository_binding`. When no ralplan run is active, `run_id` defaults to the existing state's `run_id`, then the owner session id; pass a new `run_id` to plan in a fresh run folder with a fresh budget. A ralplan run that is already active (including one handed over to you) refuses `start`: continue it with `ralplan write`, or stop it first with `ralplan state(patch={"active": false})` or `ralplan clear`. `ralplan start` is refused while an ultragoal run is active in this session; follow the refusal and call `ultragoal handoff(to="ralplan", reason)`. The run handed over by `ultragoal handoff` is already active in `planner` and keeps its recorded `run_id`: do not call `ralplan start`; continue that run with `ralplan write`. For a fresh budget or run folder, pass a new `run_id` on the first `write` (a new run id starts a fresh budget). On the old run, use the next unused `stage_n`; the old final approval and iteration budget carry over.

## Flags

- `--interactive`: Adds draft-review prompts and one-at-a-time reconciliation. When the final receipt resolves `auto_handoff.effectiveTarget` to `off` without `degradationReason: "planning_stuck"`, final approval uses a `question` approval gate; a configured automatic admission is handled by step 8. Pass it as `ralplan start` `interactive: true`.
- `--deliberate`: Forces high-risk deliberation: pre-mortem plus expanded test planning. It may also auto-enable for explicit auth/security, migration, destructive, incident, compliance/PII, or public-API-breakage risk. Pass it as `ralplan start` `deliberate: true`.
- `ralplan.autoHandoff` (setting): Selects final-plan admission: `off` (default) or `ultragoal`. `PLANNING-STUCK` also resolves every target to `off`. Invalid settings fail the `open-gajae.jsonc` load, so no final write runs with them. The final receipt's ledger-backed runtime-owned `auto_handoff.effectiveTarget` is authoritative across state loss and run switching.
- `ralplan write(stage, stage_n, content | path, run_id?)`: Native writer for Planner/Architect/Critic/revision/ADR/final pending-approval markdown under `.open-gajae/_session-<created>-<id>/plans/ralplan/<run-id>/`; do not edit `.open-gajae/` directly.

## Corrupt current-session state recovery

For corrupt, tampered, unreadable, or stale current-session ralplan state, call `ralplan clear(force=true)`; the owner session is resolved from your session lineage, and it clears only ralplan state for that session (`active: false`, `current_phase: "complete"`; stage files are kept).

`ralplan write` does not check for a running ultragoal: a write while an ultragoal run is active can create ralplan state, or re-activate it for a new `run_id` or an unlocked phase. Clean it up with `ralplan state(patch={"active": false})` or `ralplan clear`. A same-run write keeps a locked phase (such as `final`, `handoff`, or `complete`) and does not re-activate the state, so after **Stop here**, `ralplan clear`, or `ralplan handoff` the state stays inactive.

During post-final refinement (a write after `final`) or a write after `ralplan clear`, `ralplan doctor` may report `stale_active_state`: the active row's `phase` is the stage just written while the state's `current_phase` stays locked (`final` or `complete`). This is known behavior, the same as gjc; after refinement on `final` an unforced `ralplan clear` would succeed and end the run (after `ralplan clear` the state is already terminal and an unforced clear is refused), so do not call `ralplan clear` on that report alone.

## Behavior

## Planning/Execution Boundary

Ralplan is planning only. It may inspect context and draft plan/spec/proposal artifacts, but those remain `pending approval` until explicit current-turn or structured-UI execution approval, or a valid non-off final receipt's runtime-owned `auto_handoff.effectiveTarget` admits the existing handoff chain. Before either admission, do not mutate product source, run mutation-oriented shell, commit, push, open PRs, invoke execution skills, or delegate implementation.

Except for a terminal `planning_stuck` final receipt, explicitly naming `ultragoal` (including the `@ultragoal` and native `skill` id forms) counts as opting into execution for that skill — do not re-ask for the same consent.

Persist planning artifacts and handoffs through the `ralplan` tool, never direct `.open-gajae/` edits:
Direct `write`, `edit`, or `patch` calls against `.open-gajae/_session-<created>-<id>/specs`, `.open-gajae/_session-<created>-<id>/plans`, `.open-gajae/_session-<created>-<id>/state`, or any other `.open-gajae/` path are forbidden.

```
ralplan write(stage="<type>", stage_n=<N>, run_id="<run-id>", content="<markdown>")    # or path="<OS temp file>"
# role agents (planner, architect, critic) use:
ralplan write(stage="<type>", stage_n=<N>, run_id="<run-id>", content="<markdown>")
```

Use stages `planner`, `intent`, `architect`, `critic`, `disposition`, `revision`, `post-interview`, `adr`, or `final`; increment `stage_n` each consensus pass. The writer accepts inline markdown (or JSON for `disposition`) as `content`, or, from the primary agent only, an artifact `path` prepared in an OS temp directory; it persists `stage-<NN>-<stage>.md` plus `index.jsonl` under `.open-gajae/_session-<created>-<id>/plans/ralplan/<run-id>/`, and copies `final` to `pending-approval.md`. Ralplan mutation blocking is enforced in code for `write`, `edit`, and `patch`; use temp directories (`os.tmpdir()`/`$TMPDIR`, `/tmp`, `/var/tmp`) only for oversized scratch artifacts, never the repo or `.open-gajae/`. Staging via the `write` tool or a quoted-delimiter `shell` heredoc (`cat > /tmp/plan.md <<'EOF' … EOF`) into those temp roots is tolerated by the planning-phase guard.

Read-only role agents (`open-gajae-planner`, `open-gajae-architect`, `open-gajae-critic`) must pass markdown inline as `content`; the `ralplan` tool rejects `path` from role agents.

RECEIPT-ONLY guideline: role agents (`planner`, `architect`, and `critic`) persist durable outputs via `ralplan write` and return ONLY the receipt fields (`session_id`, `run_id`, `path`, `sha256`) plus verdict/status routing fields; include `stage` and `stage_n` when available, and never return the full persisted body.

The ralplan start/write receipt's `session_id` is the immutable workflow owner session and `run_id` is the run identity. The `ralplan` tool resolves the owner session from the calling session's lineage, so role writes land in the owner's run; include `run_id` in every Planner/Architect/Critic assignment and every parent-side revision/post-interview/ADR/final write. A role subagent's own session id is transcript/resume identity only and MUST NOT own ralplan state or artifacts. Never scan the filesystem for runs or merge artifact trees by hand.

This skill runs open-gajae planning in consensus mode for the provided arguments.

The consensus workflow:
1. **Planner** creates the initial plan and a compact **RALPLAN-DR summary** before review. Launch the Planner (`subagent` agent `open-gajae-planner`) ONCE per run as a resumable subagent (await it before the Architect) and keep its returned `sessionID` as the run's persisted Planner id; the Planner persists the stage with `ralplan write(stage="planner", stage_n=1, run_id, content)`, plus `resumable` when known, and the tool records the Planner's session id automatically (see **Persisted role agents** below):
   - After persistence, return only the receipt/path plus compact planning status; do not paste the full plan markdown back to the caller unless explicitly requested.
   - Principles (3-5)
   - Decision Drivers (top 3)
   - Viable Options (>=2) with bounded pros/cons
   - If only one viable option remains, explicit invalidation rationale for alternatives
   - Deliberate mode only: pre-mortem (3 scenarios) + expanded test plan (unit/integration/e2e/observability)
2. **Pre-consensus material-intent reconciliation** *(always before Architect/Critic)*: Reconcile material scope and intent before paying for consensus review. This is a bounded contract check, not a second planning loop.
   a. Read the persisted Planner artifact plus relevant `.open-gajae/_session-<created>-<id>/specs/deep-interview-*.md`, prior plans, and current user constraints. Extract only material unresolved decisions, assumptions that could change architecture/scope/acceptance criteria, and conflicts with an explicit prior non-goal. Cosmetic wording and implementation details that do not alter the contract are not material.
   b. When material open items exist, use the `question` tool one at a time, highest-impact first, with concrete options. When none exist, proceed without an empty ceremony or user prompt.
   c. Persist the check with `ralplan write(stage="intent", stage_n=<N>, run_id, content)`. The artifact must list evidence inspected, resolved material decisions, retained non-goals, and either `material-open-items: none` or the still-open items.
   d. If reconciliation changes objective, scope, non-goals, acceptance criteria, or verification obligations, resume the persisted Planner and persist a `revision` before review. Architect and Critic receive the reconciled Planner/revision receipt plus the `intent` receipt; they never review the superseded pre-reconciliation draft.
   e. With `--interactive`, also present the reconciled draft plus Principles / Drivers / Options summary (Proceed to review / Request changes / Skip review). Without `--interactive`, proceed automatically once material intent is resolved.
3. **Review fan-out after Planner persistence**: launch the Architect (`open-gajae-architect`) and Critic (`open-gajae-critic`) ONCE per run as resumable review lanes against the same immutable Planner receipt/path/sha/stage_n. Their pass-1 fan-out remains parallel — two `subagent` calls in the same message, which the host runs in parallel — when Critic is **plan-only** and does not consume Architect output (see **Persisted role agents** below).
   - **Architect lane**: challenge architecture, surface tradeoff tensions, and enrich thin plans with synthesis or missed sub-scope. Persist with `ralplan write(stage="architect", stage_n=<N>, run_id, content, lane_verdict=<token>)`, plus `resumable` when known (the tool records the Architect's session id), then return receipt/path plus `CLEAR`/`WATCH`/`BLOCK` and `APPROVE`/`COMMENT`/`REQUEST CHANGES`.
   - **Plan-only Critic lane**: independently check quality, principle-option consistency, alternatives, risks, acceptance criteria, and verification; when the plan is thin, request concrete expansion rather than only defects. Persist with `ralplan write(stage="critic", stage_n=<N>, run_id, content, lane_verdict=<token>)`, plus `resumable` when known (the tool records the Critic's session id), then return receipt/path plus `OKAY`/`ITERATE`/`REJECT`.
   - **Sequential fallback**: if Critic must evaluate Architect findings, verdict, antithesis, tradeoffs, synthesis, status, or any Architect-produced artifact, await the Architect result before issuing that Architect-dependent Critic pass.
   - Every Architect/Critic assignment, including each pass-2+ re-review assignment in step 5, MUST instruct the reviewer to include `lane_verdict` on its existing `ralplan write`: Architect passes its Architectural Status token (`CLEAR`/`WATCH`/`BLOCK`), and Critic passes its verdict token (`OKAY`/`ITERATE`/`REJECT`). The field is optional so writes without it stay valid.
4. **Review join gate**: before consensus, revision, reconciliation, finalization, or approval, verify both Architect and Critic receipts/verdicts exist for the same Planner artifact/pass (`path`, `sha256`, `stage_n`). A non-`CLEAR` Architect verdict, non-`APPROVE` Architect decision, or any non-`OKAY` Critic verdict routes back to Planner revision; do not finalize from only one review lane.
   - **Typed conflict gate**: when Architect and Critic findings prescribe incompatible actions (`add` vs `remove`, or `remove` vs `change`) against the same stable plan target id, do **not** treat the join as clean and do **not** start revision until a `disposition` stage is persisted for that pass. Collect typed findings (stable `findingId`, `targetId`, `action`, `severity`, `evidence`, `sourceRole`, source receipt) from both review artifacts, derive conflicts, and require one explicit disposition per conflict (`accept_architect` | `accept_critic` | `synthesize` | `defer_user` | `reject_both`) with `rationale`, `decisionOwner`, and `affectedSections`. Persist via `ralplan write(stage="disposition", stage_n=<N>, run_id, content=<JSON>)` using schema `ralplan.review_conflicts.v1`. Source receipts must be authoritative same-pass attestations: `plannerStageN` equals the write's `stage_n`, each finding's `sourceReceipt.stage` equals `sourceRole`, `sourceReceipt.stageN` equals `plannerStageN`, and path/sha256 resolve against the run's persisted Architect/Critic `index.jsonl` rows. The writer fails closed (an `Error:` result) if any conflict remains open, a disposition references an unknown conflict, or provenance is mismatched/spoofed. Product intent/scope remains owned by the user + approval gate; the ralplan leader owns reconciliation; reviewers advise and block.
5. **Re-review loop** (max 5 iterations; **runtime-enforced**): Any non-`OKAY` Critic verdict (`ITERATE` or `REJECT`) or Architect result that is not `CLEAR`/`APPROVE` MUST run the same full closed loop. Pass 2+ resumes the SAME persisted Architect and Critic lane subagents with the mandatory re-review context bundle and runs sequentially Architect -> Critic: await the Architect result and its receipt/path before assigning Critic; Critic receives the current-pass Architect receipt/path and performs the rule-5 counter-review before consolidated feedback routes to Planner revision. From pass 2, both reviewers are bound by the five-rule ratchet: delta-only review, novelty justification, verdict monotonicity, severity scoping, and Critic counter-review of Architect scope inflation; unjustified inflation does not force a revision.
   a. Collect Architect + Critic feedback
   b. When typed conflicts exist, persist dispositions (step 4 typed conflict gate) before revision so the Planner receives a machine-checkable conflict set, not prose alone
   c. Revise the plan by resuming the SAME persisted Planner subagent with consolidated Architect + Critic feedback **and** any disposition receipts (see **Persisted role agents** below); fall back to a fresh Planner spawn only per the fallback routing table

   **Re-review context bundle (pass 2+; mandatory):** Every pass-2+ Architect or Critic assignment MUST include:
   1. the explicit review pass number `N` for that lane, stated literally as `review pass N` in the assignment text, where **N is the ordinal review pass for that lane across the entire ralplan run/re-review loop** (equivalently the opener-iteration ordinal): the review of the initial Planner artifact is `review pass 1`, the review of the first revised Planner artifact is `review pass 2`, and so on; **N never resets within an opener iteration and never resets when a new `revision` opener begins in the same run** — it increments monotonically with every review the lane performs in the run. This ordinal is a workflow counter distinct from the runtime lane budget (which counts lane writes per opener iteration): at the default budget the two coincide numerically, but the ratchet ("from pass 2") always keys off the run-level N so normal post-revision re-reviews activate delta-only review, monotonicity, and the sequential cadence;
   2. the current revision receipt under review (`path`, `sha256`, `stage_n`);
   3. the prior Planner/revision artifact path that the previous pass reviewed;
   4. the prior same-lane review artifact path (`stage-NN-architect.md` / `stage-NN-critic.md`) with its receipt fields;
   5. the consolidated prior blockers and the revision's claimed resolutions, as orchestrator-collected pointers into those artifacts (never pasted bodies);
   6. Critic pass-2+ only: the current-pass Architect receipt/path, awaited first per the sequential cadence, so the rule-5 counter-review is evaluable.

   **The re-review context bundle remains mandatory regardless of whether a reviewer is resumed or uses a fresh-spawn fallback.** A fresh-spawn fallback always receives everything required to apply delta-only review (rule 1), novelty justification (rule 2), monotonicity (rule 3), severity scoping (rule 4), and counter-review (rule 5).
   d. For pass 2+, resume (or fresh-spawn only per the routing table) Architect -> Critic sequentially: await the Architect result and receipt/path, then issue Critic with the mandatory context bundle, including the current-pass Architect receipt/path. Critic performs the rule-5 counter-review before consolidated feedback routes to Planner revision.
      - Persist each Planner revision with `ralplan write(stage="revision", stage_n=<N>, run_id, content)` before re-review, then pass the receipt/path forward instead of duplicating the full revision markdown in the parent conversation.
   e. Re-join Architect and Critic verdicts for the same revised Planner artifact/pass (including a fresh disposition stage if new conflicts appear)
   f. Repeat this loop until Critic returns `OKAY` **and** Architect is `CLEAR`/`APPROVE` for the same Planner artifact/pass, or 5 iterations are reached
   g. If 5 iterations are reached without Critic `OKAY` plus Architect `CLEAR`/`APPROVE`, **stop opening further planner/revision passes**. Preserve the best version as a terminal `PLANNING-STUCK` result; do not route it to automatic or explicit execution.
   h. **Runtime budget:** `ralplan write` refuses a new `planner`/`revision` that would open consensus iteration **> max** (default **5**, overridable via `ralplan.maxIterations`, integer 1..20, using the workflow-settings precedence below). Cap uses the same iteration definition as the `iter` chip in the active row and snapshot (`planner`/`revision` openers in `index.jsonl`). Overflow returns a **`PLANNING-STUCK`** result instead of a receipt (`ok: false`, `planning_stuck: true`, `marker: "PLANNING-STUCK"`, plus the detail lines), and still allows `architect`/`critic` within an already-opened pass plus `post-interview`/`adr`/`final` so the best plan can be escalated to `pending approval` without dispatch. A new `run_id` starts a fresh budget.
6. **Final intent verification** (post-consensus delta gate): After the review join gate has both Critic `OKAY` and Architect `CLEAR`/`APPROVE` for the same Planner artifact/pass, verify only intent deltas introduced or newly exposed by consensus. The pre-consensus `intent` receipt is the baseline; do not re-ask decisions already settled there.
   a. **Collect new open items** from the run: assumptions or conflicts introduced after the latest `intent` receipt, plus any material ambiguity first exposed by Architect/Critic. Source these from persisted artifacts, not memory.
   b. **Cross-check prior context for conflicts**: glob `.open-gajae/_session-<created>-<id>/specs/deep-interview-*.md` and other prior specs/plans/context relevant by topic. For each, list points where the consensus plan contradicts, weakens, or expands beyond a previously crystallized decision, constraint, or non-goal. Cite the conflicting artifact and line/section.
   c. **Reconcile with the user via the `question` tool (always, regardless of `--interactive`)**: Never stop idle with plain-text prose after the consensus loop. Every reconciliation question MUST go through the `question` tool with contextual options; the host adds the free-text answer.
      - If open items exist, confirm the open assumptions and conflicts **one at a time** with the `question` tool, weakest/highest-impact first, polishing intent. If any confirmation reveals that the plan diverges from user intent, route the consolidated correction back into the re-review loop (step 5b Planner revision) and re-run Architect + Critic before returning here. Cap at the same 5-iteration ceiling.
      - If the plan is crystal clear (no open assumptions or prior-context conflicts), continue to final persistence in step 7; do not choose an approval or handoff path before its final receipt exists.
      - For every confirmed open item, embed the resolved outcome into the final plan under an **## Intent Reconciliation** section so the `pending approval` artifact records each decision; record any item the user explicitly defers as an open confirmation under that same section.
   d. Persist the reconciliation with `ralplan write(stage="post-interview", stage_n=<N>, run_id, content)`, then return the receipt/path plus a compact status (reconciled-clean / reconciled-with-revision / open-confirmations-pending) instead of pasting the full body.
7. On reconciliation completion, re-check the review join gate (Critic `OKAY` plus Architect `CLEAR`/`APPROVE` for the same Planner artifact/pass), mark the plan `pending approval` unless execution is already authorized by the resolved handoff admission, then persist the ADR/final plan via `ralplan write(stage="final", stage_n=<N>, run_id, content)`. Read the successful receipt's `auto_handoff` object; its ledger-backed `effectiveTarget` is runtime-owned and is the only automatic-routing decision; do not directly edit `.open-gajae/_session-<created>-<id>/plans`. Final plan must include ADR (Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups) and, when present, the **## Intent Reconciliation** section.
8. **Final admission and approval gate:** Reconciliation must first reach the successful final receipt from step 7. If that receipt has `auto_handoff.degradationReason: "planning_stuck"`, it is terminal: retain the `pending approval` artifact and **never dispatch**, including for an explicitly named execution skill; do not issue an approval `question`. Otherwise, if its runtime-owned `auto_handoff.effectiveTarget` is `ultragoal`, that valid non-off receipt is explicit operator admission for same-turn execution through that target; proceed to step 9 without a `question`. If it is `off`, including ordinary `off`, preserve the ordinary approval flow: if the user already explicitly named an execution skill in the current turn or via the structured approval UI (`ultragoal`, `@ultragoal`, a native `skill` call with id `ultragoal`, or "Approve execution via ultragoal"), that is execution approval — skip the re-ask and proceed to step 9 with that skill. Otherwise, present the finalized plan via the `question` tool (regardless of `--interactive`). Use these options:
   - **Refine further** — re-run the consensus loop / request changes, then return here
   - **Approve execution via ultragoal (Recommended)** — goal-tracked autonomous execution
   - **Stop here** — keep the plan as `pending approval` and make no further changes

   The host adds a free-text answer to every `question`; do not add one yourself. Do not stop with plain text and no `question` in the ordinary `off` approval flow; its terminal action is this `question`.
9. On valid automatic admission or explicit approval, invoke the admitted/approved `ultragoal` skill by default. On **Refine further**, return to the step 5 re-review loop. On **Stop here**, call `ralplan state(patch={"active": false})` (the phase stays `final`), leave the `pending approval` artifact, and stop. A `planning_stuck` final receipt never reaches this step. Never implement directly.

   Before loading the `ultragoal` skill, hand ralplan off:

   ```
   ralplan handoff(to="ultragoal")
   ```

   The handoff requires an active ralplan in a terminal phase (`final` once the final receipt exists). After **Stop here** it is refused, so a later request to execute loads `skill` `ultragoal` directly. In one call it journals the handoff, demotes ralplan (`active: false`, `current_phase: "handoff"`, `handoff_to: "ultragoal"`; its active row stays as an inactive `handoff_to` row), promotes ultragoal to `goal-planning` (`handoff_from: "ralplan"`), and syncs `.open-gajae/_session-<created>-<id>/state/skill-active-state.json`. Then load `skill` `ultragoal`, read the final plan (the final receipt's `pending_approval_path`), and call `ultragoal create` with the plan's description and goals as structured arguments, as the ultragoal skill describes.

   Loading `skill` `ultragoal` in the same execution in which this skill was loaded performs this handoff itself; loaded in a later execution, it enters without one, so after `final` call `ralplan handoff(to="ultragoal")` first.

   To go back to the interview instead — the plan exposed requirements only the user can settle — call `ralplan handoff(to="deep-interview")` from the same terminal phase, then load `skill` `deep-interview`. The interview reopens on `interviewing` (`handoff_from: "ralplan"`) with its rounds and spec fields kept; continue it with `deep-interview write`, not `deep-interview start`.

> **Important:** Architect and Critic MAY run in the same parallel batch only for the plan-only Critic lane after Planner persistence (review pass 1). Pass 2+ re-reviews MUST run sequentially Architect -> Critic: await Architect before issuing Critic, pass the current-pass Architect receipt/path to Critic for the rule-5 counter-review, then apply the same review join gate before consensus.

## Consensus iteration cap (operator contract)

- Default max consensus iterations: **5** (`ralplan.maxIterations`).
- On cap: `ralplan write` returns the **`PLANNING-STUCK`** marker (`planning_stuck: true`) instead of a receipt, no silent re-loop, no automatic or explicit ultragoal dispatch. Opener budget is `max(index.jsonl openers, on-disk stage-*-{planner,revision}.md count)` so a missing/empty/malformed ledger cannot fail open after prior openers.
- Headless/CI: treat `PLANNING-STUCK` as terminal planning failure for orchestration/watchdogs.
- Interactive: retain the best existing plan as a terminal planning result; residual critic findings stay as caveats.
- **Workflow settings precedence** — ralplan reads all of its settings
  (`ralplan.maxIterations`, `ralplan.maxReviewPassesPerLane`,
  `ralplan.autoHandoff`) through one shared resolver in this exact order
  (first valid value wins):
  1. project `<worktree>/.open-gajae/open-gajae.jsonc`
  2. user `~/.open-gajae/open-gajae.jsonc`
  3. built-in default

  Project configuration beats user configuration. The reported `source` is the
  path of the winning file, or `default`. Settings are resolved once when the
  plugin loads; restart OpenCode after changing them. **Unknown keys or invalid
  values in any layer fail the settings load** with a diagnostic
  (`<path>.ralplan.<key>: <reason>`).
- Override example (project `.open-gajae/open-gajae.jsonc`):

```jsonc
{
  "ralplan": {
    "maxIterations": 3
  }
}
```

## Per-lane review budget (operator contract)

- Default: **1** Architect pass and **1** Critic pass per opener iteration.
- Override via `ralplan.maxReviewPassesPerLane` (integer **1..10**) using the workflow-settings precedence above; project overrides user.
- On overflow: `ralplan write` returns the **`PLANNING-STUCK`** marker with lane-specific detail.
- `post-interview`, `adr`, and `final` are always allowed.
- Identical re-writes dedupe without stuck-signaling — including after a crash between artifact write and ledger append: the identical retry repairs the missing ledger row and returns the dedupe receipt.
- A new `run_id` starts a fresh budget.
- A rule-2-justified blocker routes through a Planner `revision` opener (new iteration, fresh lane budget), never a second same-iteration review pass.
- Override example (project `.open-gajae/open-gajae.jsonc`):

```jsonc
{
  "ralplan": {
    "maxIterations": 3,
    "maxReviewPassesPerLane": 2
  }
}
```


Follow this ralplan-internal consensus workflow for consensus mode details.

### Persisted role agents (consensus loop)

The Planner, Architect, and Critic are **same-session persisted subagents**. Launch the Planner once and await it before review fan-out; Architect and Critic are also launched once per run as resumable subagents in the pass-1 fan-out (parallel only for the plan-only Critic lane tied to the same Planner receipt/path/sha/stage_n). On pass 2+, resume the SAME persisted Planner with consolidated feedback and resume the SAME persisted Architect and Critic lane subagents with the mandatory re-review context bundle instead of fresh-spawning. Do NOT modify the subagent control surface; use the existing `subagent` tool only (`sessionID` resumes an idle child and steers a running one).

**Persistence boundary:** same-parent continuity only. `subagent(sessionID)` continues only a child session of the calling session that the host still holds; `.open-gajae` run-state alone does not make a role resumable. A child whose last call completed can still resume. After an OpenCode restart where resume fails (`process_restart`), a missing recorded id (`missing_record`), or a failed/unavailable resume, use the fresh role/lane fallback.

**Resume routing table (for every persisted role: Planner, Architect, and Critic)** (per re-review pass, when calling `subagent` with that role's persisted `sessionID`):

| Resume outcome | Action |
|---|---|
| `status: "running"` (the child is still working, for example after `background: true`) | call `subagent` with the same `sessionID` and that role's follow-up context, which steers the running child, then await — do NOT fresh-spawn |
| error `Subagent session not found: <id>` (`not_found`), `Session <id> is not a child of the current session` (`context_unavailable`), or another failure to prompt or switch the child (`resume_failed`) | fresh-spawn fallback for that role/lane on that pass; record the fallback metadata. |
| terminal (`status: "completed"`, or an earlier `Subagent failed`/`Subagent cancelled` error) + follow-up message | resume the same id with `subagent(sessionID)`; if that call fails, use the fresh-spawn fallback above |

**Ratchet synergy:** a resumed Architect or Critic natively retains prior-pass context, but the re-review context bundle remains mandatory regardless so the fresh-spawn fallback remains fully functional and applies all five rules.

**Recording persisted-role-agent metadata** (audit/routing only — a recorded id in `ralplan status` does not prove resumability). The `ralplan` tool records the calling role's session id on the role's normal `ralplan write` for the pass; ride the matching optional fields on that same write:

| Role | Normal write stage | Recorded automatically | Optional field |
|---|---|---|---|
| Planner | `planner` or `revision` | `planner_subagent_id` | `resumable` |
| Architect | `architect` | `architect_id` | `resumable` |
| Critic | `critic` | `critic_id` | `resumable` |

The fallback fields ride the same role's normal write: `fallback_reason` (`context_unavailable|not_found|no_runner|resume_failed|process_restart|missing_record`), `fallback_attempted_id`, `fallback_stage_n`, and optional `fallback_receipt_path` (the fresh role's stage artifact path). A planner/revision write records Planner fallback metadata, an Architect write records Architect fallback metadata, and a Critic write records Critic fallback metadata. Set `resumable` to `true` only when the parent session is provably persistent; set/record `false` after an observed `context_unavailable`; otherwise omit it (unknown). Fallback fields are recorded only when a fresh-spawn fallback actually occurs: a fallback record requires `fallback_reason` **together with** `fallback_attempted_id` and `fallback_stage_n` (the failed id and the pass it failed on), while `fallback_receipt_path` is optional.

## Pre-Execution Gate

Execution skills (`ultragoal`) implement bounded work; they are not scope-discovery lanes. Vague execution requests are routed through ralplan so scope, acceptance criteria, consensus, and verification exist before code changes.

**Passes the gate** (specific enough for direct execution): file paths, issue/PR numbers, named symbols, explicit tests, numbered steps, acceptance criteria, error references, code blocks, or escape prefixes (`force:` / `!`). Examples: `fix src/hooks/bridge.ts`, `implement #42`, `add validation to processKeywordDetector`, `do:\n1. Add input validation\n2. Write tests`.

**Gated — redirected to ralplan**: `fix this`, `build the app`, `improve performance`, `add authentication`, `make it better`.

Gate auto-pass signals: file path, issue/PR number, camelCase/PascalCase/snake_case symbol, test runner, numbered steps, acceptance criteria, error reference, code block, or escape prefix. If it fires on a well-specified prompt, add one concrete anchor; if you intentionally bypass, prefix `force:` or `!`.

On consensus approval, choose:
- **ultragoal**: goal-tracked autonomous execution with verification (recommended default)

A redirected request proceeds only through the structured approval option or an explicit execution-skill choice; `just do it` / `skip planning` alone leaves the plan `pending approval`.

## Source and host substitutions

Source: Gajae Code `packages/coding-agent/src/defaults/gjc/skills/ralplan/SKILL.md` at `5c5231418930673e42cc5d08ebe4376e03187533` (MIT). The body keeps its Flags (the applicable ones), Planning/Execution Boundary, stage list with the RECEIPT-ONLY and owner/run rules, consensus steps 1–9, Important block, iteration-cap and per-lane-budget operator contracts, Persisted role agents, and the Pre-Execution Gate section word for word. The document-link rules that gjc does not have are not added. No text from the previous OMC-derived open-gajae skill is retained; the frontmatter `description` value is kept from that skill because the gjc value describes a keyword gate this plugin does not implement. Deviation numbers refer to "GJC로부터의 deviation (ralplan)" in docs/development.md, which records the reason and impact of each one.

| gjc 5c52314 | open-gajae | Record |
|---|---|---|
| Frontmatter `name`, `description`, `argument-hint`, `level`, `source` | `name`, `description`, `argument-hint` as the plugin's skill loader reads them | Host format; no behavior change |
| `/skill:ralplan "task description"` | `@ralplan "task description"` or a native `skill` call with id `ralplan`; loading writes no state, and chaining out of a live phase is refused only toward ultragoal | Host invocation; deviations 36, 37 |
| `gjc ralplan [--interactive] [--deliberate] "<task>"` seed | `ralplan start(task, interactive?, deliberate?, run_id?)`; `ralplan start` is the documented entry, except for a run handed over by `ultragoal handoff`, which is already active in `planner` with its `run_id` and continues through `ralplan write` without `start` (a new `run_id` on the first `write` starts a fresh budget; on the old run the next unused `stage_n`, and the old final approval and budget carry over); `start` refuses while a ralplan run is active (gjc's skill-load seed writes nothing for an active skill, its CLI seed reseeds) | Deviations 1, 31 (`run_id` on start is an open-gajae addition), 39 (the active-run refusal); the handed-over run is gjc behavior (`persistActiveRunId`) |
| `--architect openai-code` / `--critic openai-code` | Removed; role models come from settings | Deviation 7 |
| `gjc.ralplan.autoHandoff` `off`/`ultragoal`/`autoresearch` | `ralplan.autoHandoff` `off`/`ultragoal` | Deviation 6 |
| `.gjc/config.yml` project → user → default, legacy `settings.json` migration, public settings schema, invalid settings exit 2 | `open-gajae.jsonc` project → user → default, resolved once at plugin setup; unknown keys or invalid values fail the settings load | Deviation 4 |
| `gjc ralplan --write … --artifact <path or markdown>` | Primary `ralplan write` with `content`, or a `path` in an OS temp root staged with the host `write` tool or a quoted `shell` heredoc | Deviations 1, 2, 30 |
| `--artifact-env GJC_RALPLAN_ARTIFACT` for restricted roles | Roles pass `content` only; the tool rejects role `path` | Deviation 2 |
| `--session-id <owner-session-id>`; owner `session_id` in every assignment | The tool resolves the owner session from the caller's lineage; assignments carry `run_id` | Deviation 32 |
| `--worktree-root <repository_binding.worktreeRoot>` and the explicit-target paragraph | Removed; `repository_binding` is recorded only. The closing "never scan the filesystem for runs" sentence is kept | Deviation 12 |
| `--json` | Removed; the tool always returns the structured receipt | Deviation 1 |
| `--planner-id` / `--architect-id` / `--critic-id` | Recorded automatically from the calling role's session (`planner_subagent_id`, `architect_id`, `critic_id`) | Deviation 5 |
| `--planner-resumable` / `--architect-resumable` / `--critic-resumable` | `resumable` | Deviation 5 |
| `--fallback-reason`, `--fallback-attempted-id`, `--fallback-stage-n`, `--fallback-receipt-path` | `fallback_reason`, `fallback_attempted_id`, `fallback_stage_n`, `fallback_receipt_path` | Deviation 1 |
| `--lane-verdict <token>`; "so legacy invocations stay valid" | `lane_verdict`; "so writes without it stay valid" | Deviation 1 |
| `.gjc/_session-{sessionid}` | `.open-gajae/_session-<created>-<id>` | Deviation 3 |
| `ask` tool; `workflowGate: { stage: "ralplan", kind: "approval" }` | Native `question`; no gate marker | Deviation 8 |
| "Always include a free-text option" | The host adds the free-text answer to every `question` (`core/src/tool/plugin/question.ts`) | Host behavior |
| `/skill:ultragoal`, `gjc ultragoal` | `@ultragoal`, a native `skill` call with id `ultragoal` | Host invocation |
| `write`/`edit`/`ast_edit` against `.gjc/` "unless an explicit force override is active" | `write`/`edit`/`patch` against `.open-gajae/`; there is no force override | Host tools |
| "Ralplan mutation blocking is enforced in code" | Enforced for `write`, `edit`, and `patch`; `shell` commands are not inspected | Deviation 11 |
| bash heredoc | `shell` heredoc | Host tool name |
| Exit code 3 with stdout `PLANNING-STUCK`; exit 2 errors | A `PLANNING-STUCK` result (`ok: false`, `planning_stuck: true`); other refusals return `Error: …` | Deviation 1 |
| HUD iteration | `iter` chip in the active row and snapshot (not drawn; the TUI sidebar is deferred) | Deviation 9 |
| `gjc state clear --force --mode ralplan` scoped by `--session-id` or `GJC_SESSION_ID` | `ralplan clear(force=true)`, owner from lineage; the state keeps its files and becomes `active: false`, `complete` | Deviation 1 |
| Step 9: `gjc state ralplan write --input '{"current_phase":"handoff"}'` then the skill tool's in-process `gjc state ralplan handoff --to ultragoal` | `ralplan handoff(to="ultragoal")` (an active ralplan in a terminal phase required; after Stop here a later request loads `ultragoal` directly, as a later gjc turn finds no active skill to hand off), then `skill` `ultragoal` and `create` with structured arguments built from the final plan; loading `skill` `ultragoal` in the same execution as this skill hands off by itself, as gjc's skill tool does for the skill loaded in the current turn | Deviations 22, 34 |
| `gjc state ralplan handoff --to deep-interview` (the generic state verb) | `ralplan handoff(to="deep-interview")` from a terminal phase; the interview reopens on `interviewing` over its kept fields (deep-interview revision plan D-SH5) | Deviations 34, 37 |
| Approval label "Approve execution via ultragoal (Recommended)" | Kept as is; the ultragoal skill names the same label | No deviation |
| On **Stop here**, keep `pending approval` | Also `ralplan state(patch={"active": false})`, phase stays `final`, so the planning guard releases (spec D-F12, the gjc flow observed in a real gjc session) | Documents gjc behavior; no deviation |
| Detached, resumable subagents; `steer`/inject; parallel pass-1 fan-out | `subagent` with `sessionID` to resume or steer; two `subagent` calls in the same message run in parallel (`core/src/session/runner/step.ts:117-128`) | Host tool |
| Resume outcomes `running`, `queued`, `context_unavailable`, `not_found`, `no_runner`, `resume_failed`, terminal | OpenCode `subagent` observations: `status: "running"`/`"completed"`, "Subagent session not found", "is not a child of the current session" (`core/src/tool/plugin/subagent.ts:29-57,150-166`); OpenCode has no `queued` outcome, so that row is dropped, and the `not_found` job-eviction caveat does not apply; `no_runner` stays an accepted `fallback_reason`; `process_restart` and `missing_record` are named in the persistence boundary | Host tool |
| "in-memory parent yields `resumable:false`"; "never claim `subagent list` proves resumability" | Removed; the host has neither; a recorded id in `ralplan status` does not prove resumability | Host tool |
| Role agents `planner`, `architect`, `critic` | `open-gajae-planner`, `open-gajae-architect`, `open-gajae-critic` | Host role names |
| gjc tracker references `#2902`, `#3165`, `WI-5` | Removed | They point at the gjc tracker |
| "This skill runs GJC planning" | "This skill runs open-gajae planning" | Host name |
| (none) | `ralplan write` during a running ultragoal can activate ralplan; clean up with `ralplan state(patch={"active": false})` or `ralplan clear`; a same-run write in a locked phase leaves the state inactive | Documents gjc behavior (R-AE1, R-OD9); no deviation |
| (none) | `ralplan doctor` `stale_active_state` after a write in a locked phase is known behavior; do not clear on that report alone | Documents gjc behavior (R-OD8); no deviation |

See THIRD-PARTY-NOTICES.md and licenses/.
