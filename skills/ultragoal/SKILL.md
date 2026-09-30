---
name: ultragoal
description: Create and execute durable repo-native multi-goal plans over goal mode artifacts.
---

# Ultragoal Workflow

Use when the user asks for `ultragoal` (including `@ultragoal`), chooses **Approve execution via ultragoal** at the end of ralplan, or asks for durable multi-goal planning or sequential execution over goal mode.

The `ultragoal` keyword and `@ultragoal` only advise loading this skill; a native `skill` call with id `ultragoal` enters it. A missing or inactive ultragoal state (including a completed or handed-off one) is raised to `goal-planning` with its fields kept; an active run keeps its phase. When `skill` `ralplan` was loaded in the same execution and ralplan is active in a terminal phase such as `final`, the load first hands ralplan off to ultragoal, as `ralplan handoff(to="ultragoal")` does; in a live planning phase the load is refused.

## Purpose

`ultragoal` turns a task description and its goals into repo-native durable artifacts and then drives execution through the unified `goal` tool as a UX bridge only. `goals.json` is the canonical source of goal identity and state; `ledger.jsonl` is the canonical proof stream for checkpoints, receipts, blockers, steering, and reviews. The `goal` tool's goal (below, the goal-mode goal; a plain "goal" is an ultragoal goal such as `G001`) exists only to keep the agent's interactive loop focused on the run's objective. Completion is verified purely from durable `goals.json` plus fresh `ledger.jsonl` receipts, never from goal state. The agent, not the `ultragoal` tool or hooks, calls `goal({"op":"complete"})` or `goal({"op":"drop"})` after durable run completion or cleanup; apart from `create` arming the goal-mode goal, `ultragoal` ops and hooks never change goal state.

- `.open-gajae/_session-<created>-<id>/ultragoal/goals.json` (the description, the goals, and their acceptance criteria)
- `.open-gajae/_session-<created>-<id>/ultragoal/ledger.jsonl` (checkpoint and structured steering audit events)
- `.open-gajae/_session-<created>-<id>/ultragoal/progress.txt` (implementation, changed files, learnings, and Codebase Patterns per completed goal)
- `.open-gajae/_session-<created>-<id>/state/goal-state.json` (the goal-mode goal)

The session folder is that of your session lineage's root session. Only the `ultragoal` tool changes the ultragoal files: `write`, `edit`, and `patch` on them are refused, and do not change them through `shell` either. Read them freely.

## Corrupt current-session state recovery

When ultragoal detects its own current-session state is corrupt, tampered, unreadable, or stale on resume, call `ultragoal({"op":"clear","force":true})` before reseeding or restarting. The owner session is resolved from your session lineage; it clears only ultragoal state for that session (`active: false`, `current_phase: "complete"`; `goals.json`, `ledger.jsonl`, and `progress.txt` are kept) and never clears other skills, sessions, or the goal-mode goal. While the goal-mode goal is still open, the result adds `The goal is still <status>; run goal drop to end it.`

`ultragoal({"op":"doctor"})` reports ultragoal state, row, and snapshot problems; `ultragoal({"op":"state","patch":{…}})` merges fields into the ultragoal state (`null` deletes a field; derived fields are refused, and `current_phase` must be an allowed transition).

There is no `start` op. To restart after a completed or cleared run, load `skill` `ultragoal` again and call `create`.

## Always-used command examples

Use these exact `ultragoal` calls before spending tool calls rediscovering syntax:

```json
ultragoal({"op":"status"})
ultragoal({"op":"create","description":"<task description and constraints>","goals":[{"title":"<title>","description":"<objective>","acceptanceCriteria":["<concrete, verifiable criterion>"]}]})
ultragoal({"op":"next"})
ultragoal({"op":"next","retry_failed":true})
ultragoal({"op":"validate_gate","goal_id":"<id>","gate":{…}})
ultragoal({"op":"checkpoint","goal_id":"<id>","status":"complete","evidence":"<evidence>","gate":{…},"implementation":["…"],"files_changed":["…"],"learnings":["…"]})
ultragoal({"op":"checkpoint","goal_id":"<id>","status":"failed","evidence":"<blocker/evidence>"})
ultragoal({"op":"record_review_blockers","goal_id":"<id>","title":"Resolve final review blockers","objective":"<blocker-resolution objective>","evidence":"<review findings>"})
```

Every `ultragoal` result is text lines; a refusal starts with `Error:`. `handoff`, `state`, and `clear` return a one-line JSON receipt. Tool arguments are snake_case, except each goal's `acceptanceCriteria`; the quality gate's JSON fields are camelCase.

Use these exact goal-tool calls for the goal state:

```json
goal({"op":"get"})
goal({"op":"create","objective":"<printed goal-objective>"})
goal({"op":"complete"})
goal({"op":"drop"})
goal({"op":"resume"})
```
`drop` clears the active goal without exiting goal mode; `resume` reactivates a paused goal.

## Create goals

1. Decide on the description and the goals. `description` holds the shared task description and constraints; it is kept in `goals.json` (and in the ledger's `plan_created` event) but is **not** turned into a goal. Every executable goal needs its own entry in `goals` with a `title`, a `description` (its objective), and at least one concrete, verifiable `acceptanceCriteria` entry — never a generic one such as "Implementation is complete".

   Goals become `G001`, `G002`, … in order, and their criteria `G001.AC1`, `G001.AC2`, ….

2. Call `ultragoal({"op":"create","description":…,"goals":[…]})`. `create` overwrites `goals.json` with every goal `pending`, appends `plan_created` to the ledger, appends a `PLAN` note to `progress.txt`, and arms the goal-mode goal. Read the result: `Created ultragoal plan with N goal(s) at <path>.`, then `Goal armed: …`, or `Goal not armed: …` when another goal-mode goal is open (run `goal({"op":"drop"})`, then `create` again).
3. Inspect `.open-gajae/_session-<created>-<id>/ultragoal/goals.json` (or `ultragoal status`) and refine if needed with `add`, `revise`, and `supersede` (Dynamic steering below).

While ultragoal is in `goal-planning` (from the skill load until `create` succeeds), product-source `write`, `edit`, and `patch` are refused; only OS temp paths are allowed. Call `create` first: before it, do not call `status` or `classify_blocker`. Both reconcile the ultragoal state from `goals.json`, which ends `goal-planning` (to `missing`, or to the status of an earlier plan).

### Create-goals granularity: merge validation-coupled goals

Before splitting the work into many thin goals, check whether the candidate goals are **validation-coupled**. Merge validation-coupled goals into one goal and fan out executor slices inside that goal instead of creating one goal per slice. Two goals are validation-coupled when they share any of:

- the same feature stack (one goal's code cannot be meaningfully verified without the other's),
- the same acceptance surface,
- the same red-team surface, or
- the same final review boundary (they can only be signed off as a unit).

Fanning out executor slices inside a single merged goal keeps one review/QA boundary while preserving parallel implementation.

## Complete goals

Loop until `ultragoal status` reports every goal complete and `run_complete: yes`:

1. Call `ultragoal({"op":"next"})`. It makes the next goal `active` (or returns the goal that is already active) and prints `ultragoal next-action=execute-goal goal-id=<id>`, `objective=`, `goal-objective=`, `checkpoint requires=`, and `criteria=`.
2. Read the printed handoff.
3. Call `goal({"op":"get"})`.
4. If no active goal-mode goal exists, call `goal({"op":"create","objective":"<printed goal-objective>"})` with the printed `goal-objective=` text exactly; never create the goal-mode goal with an objective of your own. If the same objective is already active, continue under it without creating a new one. After `goal({"op":"drop"})`, `get` reports `No active goal.` and `goal({"op":"create"})` succeeds directly. If a different goal-mode goal is still active and you genuinely need a fresh start in the same session, call `goal({"op":"drop"})` first, then `goal({"op":"create"})`.
5. Complete the current ultragoal goal only.
6. Run a completion audit against the goal's objective, its acceptance criteria, and real artifacts/tests.
7. Before any `status: "complete"` checkpoint, run the goal's review gate below: the architect review for every goal, plus the boundary cohort and the terminal critic on the run's final required goal. Do **not** call `goal({"op":"complete"})` for intermediate goals; checkpoint each goal while the goal-mode goal stays `active`. On the final goal, create the final aggregate receipt first; only after that receipt exists may `goal({"op":"complete"})` run.
8. Checkpoint the durable ledger. Complete checkpoints require `gate`, plus `implementation`, `files_changed`, and `learnings` with at least one item each (they are appended to `progress.txt`):
   `ultragoal({"op":"checkpoint","goal_id":"<id>","status":"complete","evidence":"<evidence>","gate":{…},"implementation":["…"],"files_changed":["…"],"learnings":["…"]})`
   A successful complete checkpoint is goal completion, not automatic run completion. Read the checkpoint output: when it prints `Next ultragoal goal: <id>`, continue that active goal under the same goal-mode goal (its `Criteria:` line names the criterion IDs the next gate must cover); when it prints `All ultragoal goals are complete.`, the durable goals are terminal. A following `Run not complete: <reason>` line means the receipts do not close the run yet: see Reopening a goal below. `ultragoal next` remains the supported manual next-goal command if continuation output was missed. Record a codebase pattern worth keeping with `ultragoal({"op":"add_pattern","pattern":"<one line>"})`.
9. If blocked or failed, checkpoint failure:
   `ultragoal({"op":"checkpoint","goal_id":"<id>","status":"failed","evidence":"<blocker/evidence>"})`
10. Resume failed goals with `ultragoal({"op":"next","retry_failed":true})`. With no active goal it takes the first failed goal before any pending one.

### Reopening a goal

`ultragoal({"op":"checkpoint","goal_id":"<id>","status":"pending","evidence":"<why>"})` reopens a goal from any status. Its receipt stays in `goals.json` but counts only once the goal is complete again; the result says `Reopened <id>; revise it, then run ultragoal next and checkpoint it again.` Then change the goal if needed, call `next`, and checkpoint it `complete` with a fresh gate.

Every goal can be `complete` while the run is still not complete: the run also needs a valid final aggregate receipt on the most recently completed goal. When `ultragoal status` shows `run_complete: no (<reason>)`, `ultragoal next` prints `run-complete=no reason=…` with `hint=reopen <id> …`, a checkpoint prints `Run not complete: <reason>`, or `goal({"op":"complete"})` is refused over a completion receipt (the refusal names the goal to reopen), reopen that goal — the last completed one — with `checkpoint(status: "pending")`, run `next`, and re-verify it with the final gate (cohort and terminal critic) before `checkpoint(status: "complete")`. This happens, for example, when the last remaining pending goal is superseded after every other goal completed with a per-goal receipt, or at the end of a fix-of-a-fix chain (see Fix goals below).

### Receipts

A complete checkpoint writes the goal's `completionVerification` receipt to `goals.json` and to its ledger `goal_checkpointed` event. Receipts are freshness-scoped:

- A receipt stays valid while the goal's receipt matches its ledger event and its active acceptance criteria are unchanged. Later `goal_started` or complete checkpoints of other goals do not stale it.
- Adding or superseding required goals (goal `add` or `supersede`, `record_review_blockers`) after a final aggregate receipt stales that final. Its goal still counts as completed per-goal, and the goal that completes last must earn a new final aggregate receipt — by reopening the last completed goal when no unfinished goal remains.
- `ultragoal status` lists each goal with `receipt: valid`, `per-goal(superseded final)`, `stale`, or `none`. A reopened goal keeps showing its earlier receipt.

## Blocker triage and pause discipline

An active ultragoal run must not give up on a blocker by pausing the goal-mode goal and asking the user. Classify every blocker before deciding what to do, and default to `resolvable` when unsure:

- **`resolvable`** — anything the agent can act on: failing tests, missing implementation, a dependency to install, an ambiguous-but-inferable detail, investigation. **Never pause.** Exhaust autonomous resolution first: investigate, `ultragoal({"op":"add","target":"goal","title":"Investigate blocker","description":"…","acceptanceCriteria":["…"],"evidence":"…","rationale":"…"})`, delegate an `open-gajae-executor`, or preserve the blocker durably with `ultragoal checkpoint(status: "blocked")` / `ultragoal record_review_blockers` and keep scheduling the next goal.
- **`human_blocked`** — only the user can act: credentials/secrets, a manual or physical step, an external approval/decision, access the agent lacks. Pause is the last resort and is gated.

`goal({"op":"pause"})` is **refused at runtime** while an ultragoal plan exists and its run is not complete, unless the latest `blocker_classified` ledger event is `human_blocked` and a later bound clean pause terminal critic verdict is recorded for it (see [Terminal critic gate](#terminal-critic-gate)). To pause, first record the human-only classification and capture its event id (`Recorded blocker classification: human_blocked event-id=<id>.`), then record the terminal critic's clean bound pause verdict, and only then pause:

```json
ultragoal({"op":"classify_blocker","classification":"human_blocked","evidence":"<the specific human-only dependency>","goal_id":"<id, optional>"})
ultragoal({"op":"record_critic_verdict","terminus":"pause","classification_event_id":"<event-id>","verdict":"OKAY","evidence":"<terminal critic evidence>","blockers":[]})
goal({"op":"pause"})
```

Recording `classification: "resolvable"` is an audit note only; it never authorizes a pause.

## Dynamic steering

Use `ultragoal` `add`, `revise`, and `supersede` when real findings or blockers prove the current goal decomposition should change while the run's objective and constraints stay fixed. Steering is explicit-only and evidence-backed: every call carries `rationale` (why the plan changes) and `evidence` (the finding that proves it), each at least 5 words and 32 characters; shorter input is refused instead of guessed.

Allowed changes are:

- `add` with `target: "goal"` — a new goal (`title`, `description`, `acceptanceCriteria`), placed right after the goal named by `after`, or at the end.
- `revise` with `target: "goal"` — a pending goal's `title` or `description`, or its position (`after`).
- `supersede` with `target: "goal"` — a `pending`, `blocked`, or `review_blocked` goal that is no longer required; refused for the only remaining required goal.
- `add` with `target: "criterion"` — a new criterion (`criterion`) on a pending goal; it gets the goal's next criterion ID.
- `revise` with `target: "criterion"` — the criterion `criterion_id` of a pending goal gets the text `criterion` under a new ID; the old ID is retired and never reused.
- `supersede` with `target: "criterion"` — the criterion `criterion_id` of a pending goal stops governing; refused for its last active criterion.

A split is `supersede` plus `add` with `after`; a reorder is `revise` with `after`. The result names the new or changed goal or criterion: `Accepted <op> steering. target=<id>`.

Examples:

```json
ultragoal({"op":"add","target":"goal","title":"Investigate blocker","description":"Validate the blocker and report evidence.","acceptanceCriteria":["The blocker is reproduced or refuted with command output"],"evidence":"The integration test log shows a timeout in the parser stage","rationale":"The blocker changes the safe execution order of the remaining goals."})
ultragoal({"op":"supersede","target":"goal","goal_id":"G002","evidence":"Implementation split found two separable risks in the parser goal","rationale":"Splitting keeps each sub-goal independently verifiable."})
ultragoal({"op":"add","target":"goal","after":"G002","title":"Fix parser","description":"Resolve parser blocker.","acceptanceCriteria":["The parser accepts the failing fixture"],"evidence":"Implementation split found two separable risks in the parser goal","rationale":"Splitting keeps each sub-goal independently verifiable."})
ultragoal({"op":"revise","target":"goal","goal_id":"G003","after":"G001","evidence":"Dependency order changed after the investigation of G002","rationale":"G003 must land before G002 can proceed safely."})
ultragoal({"op":"revise","target":"goal","goal_id":"G002","title":"Clarify blocker goal","evidence":"The current title hides the actual blocker from reviewers","rationale":"Clear wording keeps the ledger auditable for reviewers."})
ultragoal({"op":"revise","target":"criterion","goal_id":"G003","criterion_id":"G003.AC2","criterion":"All 12 setters are classified with evidence","evidence":"Enumerated the setters with grep: 12 setters, not 16","rationale":"The original count in the description was measured wrong."})
ultragoal({"op":"supersede","target":"goal","goal_id":"G004","evidence":"The blocked work is no longer required because replacement evidence covers it","rationale":"No replacement goal is needed; superseding only the blocked goal unblocks final completion without changing the run objective."})
```

Steering invariants:

- Completed goals cannot be changed: `revise` and `supersede` of a `complete` goal or of its criteria, and a criterion `add` on it, are refused. The path to change and re-verify one is reopening it with `checkpoint(status: "pending")` (see Reopening a goal), changing it, then `next` and a new complete checkpoint.
- An `active` or `failed` goal is first moved back to `pending` with `checkpoint(status: "pending")` before its wording, position, or criteria can change; the refusal names this path.
- `checkpoint(status: "failed")`, `checkpoint(status: "blocked")`, and `record_review_blockers` also move a goal out of `complete`, as they move any goal; use the reopen path when you fix and re-verify a completed goal.
- `after` places a goal right after another goal; no call places a goal first. To put a new goal ahead of `G001`, add it, then move `G001` after it (two calls).
- Superseding the last remaining pending goal can leave the run without a final aggregate receipt; reopen the last completed goal as described in Reopening a goal.
- Do not edit the run's goal objective, original description constraints, quality gates, or completion status. The goal objective is a stable pointer to `.open-gajae/_session-<created>-<id>/ultragoal/goals.json` and `.open-gajae/_session-<created>-<id>/ultragoal/ledger.jsonl`, not an enumeration of initial goal ids.
- Do not hard-delete goals, auto-complete work, weaken verification, or silently mutate `.open-gajae/_session-<created>-<id>/ultragoal`.
- Accepted changes append a structured `steering_accepted` entry to `.open-gajae/_session-<created>-<id>/ultragoal/ledger.jsonl` and keep the original text in the goal's `amendments`; refused attempts write nothing.
- Superseded goals remain in `goals.json` with their amendments and are skipped for scheduling.
- Blocked goals without replacements are skipped for scheduling but still block final completion until later explicit steering replaces or supersedes them.

Normal prose does not mutate state.

## Role-agent delegation guidance

Ultragoal execution should use open-gajae's role agents when a durable goal is large enough to benefit from delegation:

- Use `open-gajae-executor` for bounded implementation, refactoring, and fix slices.
- Use `open-gajae-planner` for goal sequencing or handoff refinement when execution uncovers a missing plan branch.
- Use `open-gajae-architect` for read-only architecture and code-review lanes, including `CLEAR` / `WATCH` / `BLOCK` status.
- Use `open-gajae-critic` for read-only plan or handoff critique before execution proceeds.

### Implementation delegation guidance

Direct inline implementation by the leader is the default. Delegate to `open-gajae-executor` subagents only when the expected diffs land in **genuinely different sub-domains, modules, or systems** — separable surfaces with independent acceptance criteria and no shared-file contention. File count or line count alone does not force delegation; a large change confined to one domain/subsystem is usually better done inline or by a single sequenced `open-gajae-executor`.

Delegation is worth it when:

- The goal spans **multiple distinct sub-domains / modules / systems** (e.g. a CLI surface plus an unrelated runtime subsystem plus docs tooling) whose slices can proceed in parallel without coordinating on the same files.
- Each slice can be bounded with explicit targets and acceptance criteria that are verifiable independently of the other slices.
- The leader's checkpoint/verification duties would otherwise be crowded out by juggling unrelated domains inline.

When delegating:

- Give each `open-gajae-executor` bounded targets and explicit acceptance criteria, and keep checkpoint/goal-state ownership in the leader.
- Parallelize only across genuinely different sub-domains/modules/systems; sequence anything with a real dependency or shared-surface overlap.
- Work within a single domain/subsystem stays with the leader as direct edits — do not split one cohesive change across subagents, and do not over-delegate trivial work.
- After integrating delegated slices, you MAY run `open-gajae-architect` / `open-gajae-critic` review lanes for early signal, but treat them as **advisory**: the canonical reviews are the goal's architect review and the boundary cohort gate below, and a slice-level lane never substitutes for them or their verdicts. Skip slice review entirely when the goal's review will cover the same change set shortly. Worker agents never mutate `.open-gajae/_session-<created>-<id>/ultragoal` or call goal tools.

A `subagent` call that returns `status: "running"` (a `background: true` child) only means the leader is not waiting. It is not subagent failure evidence and must not be used as a cancellation reason; continue independent work until the completion notice arrives, and treat the child as failed only when it has actually failed, gone off-track, or become unrecoverably wrong.

### Subagent reuse and resumption (token efficiency)

Fresh spawns re-pay the full context ramp-up (file reads, domain orientation, contract restatement) on every delegation. When a later slice or lane targets the **same sub-domain/module/system** as a prior subagent of the same role, **resume the prior subagent instead of freshly spawning**:

- Track the subagent `sessionID` per role + domain as it is created; on the next same-domain `open-gajae-executor` slice or same-scope `open-gajae-architect` review lane, resume that id and inject only the delta (new targets, new acceptance criteria, the updated frozen change set) rather than re-briefing from scratch.
- Reuse is domain-scoped: resume only when the prior context is an asset. A slice in a genuinely different sub-domain/module/system gets a fresh spawn — stale cross-domain context is a liability, not a saving.
- Resume with `subagent` and the prior `sessionID`. Route per attempt: `status: "running"` → call `subagent` with the same `sessionID`, which steers the running child, then await; terminal (`status: "completed"`, or an earlier `Subagent failed`/`Subagent cancelled` error) → resume the same id; `Subagent session not found: <id>`, `Session <id> is not a child of the current session`, or another failure to prompt or switch the child → fresh spawn fallback for that slice.
- **Persistence boundary:** same-parent continuity only. `subagent(sessionID)` continues only a child session of the calling session that the host still holds; `.open-gajae` run-state alone does not make a role resumable. A child whose last call completed can still resume. After an OpenCode restart where resume fails, or a failed/unavailable resume, use the fresh spawn fallback.
- A resumed subagent is still the same worker under the same contract: it must not mutate `.open-gajae/_session-<created>-<id>/ultragoal`, call goal tools, or absorb checkpoint/goal-state ownership, and review lanes (`open-gajae-architect`, `open-gajae-critic`) stay read-only when resumed.
- Resumption never weakens gates: a resumed `open-gajae-architect` review or `open-gajae-executor` QA lane must still evaluate the current frozen change set on its own evidence, not rubber-stamp its earlier verdict.

If an ultragoal request has no approved plan or consensus artifact **and** the scope genuinely needs one, run `ralplan` first (from a running ultragoal, through `ultragoal handoff`; see Handoff back to planning) and carry its PRD, test spec, role roster, and verification guidance into `create`'s description, goals, and acceptance criteria. Skip `ralplan` for small scope: work that fits a single reviewable PR and is tied to a single domain/subsystem can proceed directly from the description — record that judgment in `create`'s `description` (the ledger's `plan_created` event keeps it) instead of running a planning round. Reach for `ralplan` when the scope spans multiple domains/subsystems, needs cross-cutting sequencing, or would not fit a single PR.

The ultragoal leader owns `.open-gajae/_session-<created>-<id>/ultragoal/goals.json`, `ledger.jsonl`, and `progress.txt`. Role agents return implementation/review evidence; they do not checkpoint ultragoal or mutate goal state. The `ultragoal` and `goal` tools are hidden from, and refused to, every agent but `open-gajae`.

### Native executor parallelism contract

Native subagent parallelism is a contract for bounded `open-gajae-executor` delegation, not a runtime scheduler:

- **Use native `open-gajae-executor` parallelism only** when a goal's expected diffs fall in genuinely different sub-domains/modules/systems, each boundable by a per-slice coordination contract.
- **Default to direct leader edits** otherwise; sequence any work with real dependencies, shared-file overlap, or a single-domain footprint, and never parallelize work that lacks a safe contract.
- Worker agents **MUST NOT mutate `.open-gajae/_session-<created>-<id>/ultragoal`**, call goal tools, make checkpoint decisions, own integration, or own final verification. The ultragoal leader keeps those responsibilities.
- Workers never call `ultragoal checkpoint`: checkpoint authority stays with the leader after worker tasks are terminal. The leader checkpoints from worker evidence plus the current `goal({"op":"get"})` state, and performs no hidden goal mutation.

Before workers start, each per-slice coordination contract MUST name the target files/surfaces, independence assumptions, allowed coordination channel, conflict-escalation rule, expected evidence, and terminal status. Conflict or assignment changes remain leader-owned and must be auditable through durable ledger evidence.

For failed or contract-violating slices, record durable ledger evidence; preserve successful terminal slices only when safe; and reassign, retry, or collapse the invalid work to serial execution under an updated contract. Completion after parallel work still requires terminal worker evidence, leader integration, targeted verification, and the goal's review gate (the architect review, plus on the run's final required goal the cleaner + architect + executor QA/red-team cohort and the terminal critic) before `checkpoint(status: "complete")`.

## Boundary verification (per goal, then once at the end)

Every goal gets its own architect review before it is checkpointed `complete`; the heavyweight cohort review runs **once**, at the run's final required goal. There is no deferred gate and there are no validation batches. Nothing needs to be declared to get this — it is the default.

The per-goal gate is the proof of the goal's own review:

1. Run targeted verification for the goal's change.
2. Delegate an `open-gajae-architect` review of the goal against its active acceptance criteria, covering the architecture side, the product side, and the code side (see step 4 of the cohort gate). The architect returns one architectural status and a recommendation; record `architectureStatus`, `productStatus`, and `codeStatus` from its findings on each side.
3. Fill `criteriaCoverage` with exactly one row per active criterion — the IDs `next` printed in `criteria=` — each with `status` `covered`, `passed`, or `verified` and its evidence.

```json
{
  "targetedVerification": {
    "status": "passed",
    "commands": ["bun test <targeted suite>"],
    "evidence": "what was verified and how it passed"
  },
  "architectReview": {
    "architectureStatus": "CLEAR",
    "productStatus": "CLEAR",
    "codeStatus": "CLEAR",
    "recommendation": "APPROVE",
    "evidence": "architect review synthesis across architecture/product/code",
    "blockers": []
  },
  "criteriaCoverage": [
    { "criterionId": "G001.AC1", "status": "covered", "evidence": "how this criterion was verified" }
  ]
}
```

Clean means all three architect statuses are `"CLEAR"`, the recommendation is `"APPROVE"`, targeted verification is `"passed"`, every active criterion is covered, every evidence field is non-empty, and every blockers array is empty. `WATCH`, `BLOCK`, `COMMENT`, and `REQUEST CHANGES` are non-clean. If the review is not clean, do not checkpoint `complete`: checkpoint the goal `failed` with the findings as evidence, fix, then `next` with `retry_failed: true` and review again. There is no retry cap.

`next` prints which gate the goal needs in `checkpoint requires=`: `targetedVerification:passed,architectReview:CLEAR+APPROVE,criteriaCoverage:all` for a per-goal checkpoint, with `,reviewCohort:joined,criticReview:OKAY` added when the goal is the run's final required goal. A goal is final when every other required (not superseded) goal is complete; for a fix goal, its `review_blocked` parent already counts as superseded. The final gate is the per-goal gate plus the `reviewCohort` and `criticReview` sections below.

### Intra-goal validation-lane parallelism

Cohort lanes are parallel by construction: the boundary gate freezes the change set first, so `cleaner`, `architect`, and `qa` can run concurrently against the same code state and then join. Fall back to **sequential** lanes only when code is still changing (nothing can be frozen yet), when the red-team lane depends on architect fixes, or when architect findings gate the QA scope. Either way the lanes must **join before checkpoint** — no lane checkpoints independently, and repair work starts only after the join.

## Internal ultragoal cleaner

The completion-gate cleanup sweep is the `open-gajae-cleaner` role: a read-only subagent whose prompt is gjc's ultragoal `ai-slop-cleaner` fragment. Call it with `subagent` and agent `open-gajae-cleaner`, naming the changed files to inspect.

- It is a read-only detector+reporter over the changed files it is given only: it never edits code, writes files, mutates `.open-gajae/`, checkpoints, calls goal tools, or spawns workflows.
- It classifies every finding as blocking or advisory across the full taxonomy (fallback-like masking vs. grounded, duplication, dead code, needless abstraction, boundary violations, UI/design slop, missing tests), and its `AI SLOP CLEANUP REPORT` states `Gate Result: PASS` or `BLOCKED`.
- The leader and a leader-spawned `open-gajae-executor` own all fixes; the cleaner reruns until zero blocking findings remain. Advisory findings live in the gate report only.
- Recursion guard: it must not spawn nested `ralplan`/`deep-interview`/`ultragoal`; broad or architectural findings are handed back to the leader as review blockers.

## Boundary completion cohort gate

The heavyweight gate runs **once per boundary generation**, not once per goal and not once per review pass. Earlier goals use the per-goal gate above; this section applies at the boundary, the run's final required goal.

One generation freezes the change set and reviews it exactly once:

1. Run implementation verification for the run's cumulative change set.
2. **Freeze the change set.** Stop changing source; every lane in this generation inspects that same code state. Any later source change starts a new generation.
3. **Run the cohort lanes on the frozen change set** — at most one `cleaner`, one `architect`, and one `qa` lane per generation. They may run in parallel because they share the frozen source; a second architect or QA lane in the same generation is not allowed. The `cleaner` lane is `open-gajae-cleaner` run over the frozen change set: a read-only detector that emits an `AI SLOP CLEANUP REPORT`, and it still runs and reports a passed/no-op result when there are no relevant edits. Its BLOCKING findings join the cohort findings rather than starting their own fix loop; advisory findings are included in the gate report only and are not written to the ultragoal ledger.
4. Delegate an `open-gajae-architect` review covering all three lanes:
   - architecture-side: system boundaries, layering, data/control flow, operational risks.
   - product-side: user-visible behavior, acceptance criteria, edge cases, regressions.
   - code-side: maintainability, tests, integration points, and unsafe shortcuts.
5. Delegate an `open-gajae-executor` QA/red-team lane whose assignment text contains `[ultragoal-red-team]`; the plugin then appends the executor red-team fragment to that executor's instructions. Without the marker the executor works as usual. This lane must try to break the change, not just confirm the happy path. It must start from the approved plan/spec/acceptance criteria, then user-facing contracts, and only then implementation code as supporting evidence. Plan/code mismatches are blockers, not items to paper over with implementation intent.
6. **QA lane contract.** The executor QA/red-team lane reports `status` (`passed` only when clean), the `commands` it ran, the `adversarialCases` it tried, `evidence` (what each command showed), and `blockers`; state this contract in the lane's assignment. A prose claim without a command that was run is not evidence.
7. **Join before repairing.** Fold all three lane verdicts and the final code review into the final gate under the top-level `reviewCohort` (`reviewGeneration`, `joined: true`, and the three `lanes`). No lane may checkpoint on its own, and no fix work starts until the findings are joined. Clean means the per-goal gate is clean, the cohort is joined with the cleaner `"PASS"`, the architect lane `"CLEAR"`, and the QA lane `"passed"` with its commands and adversarial cases, every evidence field is non-empty, and every blockers array is empty. `COMMENT`, `WATCH`, `REQUEST CHANGES`, `BLOCK`, `BLOCKED`, missing evidence, plan/code mismatches, or non-empty blockers are non-clean.
8. If the joined findings contain any blocker, do **not** checkpoint `complete` and do **not** call `goal({"op":"complete"})`. Record **one consolidated blocker batch** for all findings from the whole cohort instead of one goal per lane:
   ```json
   ultragoal({"op":"record_review_blockers","goal_id":"<id>","title":"Resolve verification blockers","objective":"<blocker-resolution objective>","evidence":"<joined cohort findings>"})
   ```

   Review-blocker recursion cap (#3613): `record_review_blockers` dedups identical-objective blockers (same trimmed objective + same blocked goal + open status) and bounds the number of unresolved review_blocker descents per blocked goal to **3**. Descents 1..3 may exist; an attempt to create a 4th is refused with a `review_blocker_recursion_cap` error — never silently auto-completing findings. When the cap fires, record a human pause/escalation or resolve existing blockers before recording more.
9. One consolidated fix batch produces exactly **one new generation**. Freeze the fixed source again, bump `reviewGeneration`, and set `deltaOnly: true` with the `deltaPaths` actually changed. Generation 2+ reviews are **delta-only**: they may not pull in unrelated scope without an explicit `scopeExpansion` carrying `severity`, `novelty`, and `justification`. Repeat until a generation joins clean.
10. Only after a generation joins clean, checkpoint the goal as complete with the final gate. The terminal critic runs **once** on that final joined generation. The checkpoint creates a receipt in `ledger.jsonl`; `goals.json` status alone is not proof. The final aggregate receipt must exist before the agent calls `goal({"op":"complete"})` to reconcile the goal state.

`checkpoint(status: "complete")` rejects missing or shallow gates, and reports **all** structural, evidence, criteria, cohort, and critic errors in one run rather than one per attempt: `Error: N quality-gate error(s):`, then one `  path [code]: message` line per defect. Each diagnostic carries a stable `path`, a stable machine-readable `code`, and a human `message`.

Validate before you checkpoint. `ultragoal({"op":"validate_gate","goal_id":"<id>","gate":{…}})` applies exactly the same rules as `checkpoint(status: "complete")` (including the per-goal vs final gate selection) but is strictly read-only: it never touches `goals.json`, `ledger.jsonl`, or goal state. It prints `quality gate is valid.` or the full diagnostics list, so authoring a gate is one pass instead of an edit/retry loop. Without `goal_id` it checks the first pending, active, or failed goal. The final gate must include:

```json
{
  "targetedVerification": {
    "status": "passed",
    "commands": ["bun test <targeted suite>"],
    "evidence": "what was verified and how it passed"
  },
  "architectReview": {
    "architectureStatus": "CLEAR",
    "productStatus": "CLEAR",
    "codeStatus": "CLEAR",
    "recommendation": "APPROVE",
    "evidence": "architect review synthesis across architecture/product/code",
    "blockers": []
  },
  "criteriaCoverage": [
    { "criterionId": "G003.AC1", "status": "verified", "evidence": "how this criterion was verified" }
  ],
  "reviewCohort": {
    "reviewGeneration": 1,
    "joined": true,
    "lanes": {
      "cleaner": { "status": "PASS", "evidence": "AI SLOP CLEANUP REPORT: zero blocking findings", "blockers": [] },
      "architect": { "status": "CLEAR", "evidence": "architecture/product/code review of the frozen set", "blockers": [] },
      "qa": {
        "status": "passed",
        "commands": ["bun test <e2e suite>"],
        "adversarialCases": ["<boundary/adversarial input> -> <required handling observed>"],
        "evidence": "e2e + red-team run against the frozen set",
        "blockers": []
      }
    }
  },
  "criticReview": {
    "verdict": "OKAY",
    "evidence": "terminal critic review of the final required-goal state",
    "blockers": []
  }
}
```

A generation 2+ cohort adds `"deltaOnly": true` and `"deltaPaths": ["<changed path>"]`; generation 1 must not set `deltaOnly: true`. Unknown top-level keys are rejected.

### Fix goals

`record_review_blockers` sets the reviewed goal to `review_blocked` and appends a fix goal whose `description` is `objective`, with one acceptance criterion `<objective> is resolved and re-verified` (`G00x.AC1`); `title` defaults to `Resolve final code-review blockers`, and `objective` is at most 1972 characters. The result prints `Recorded review blockers. blocker-goal-id=<id>`. When the fix goal is completed, its `review_blocked` parent becomes `superseded`; if no other required goal is unfinished, the fix goal is the run's final goal and needs the final gate (a new cohort generation) from its first checkpoint.

A fix goal supersedes only its direct parent. When a fix goal's own final gate is not clean, `record_review_blockers` on the fix goal adds another fix goal, and the original `review_blocked` goal at the root of this fix-of-a-fix chain stays unfinished — the cap of 3 counts each blocked goal separately and does not stop the chain. Before you complete the last fix goal of the chain, `supersede` every other `review_blocked` goal of the chain — all but the last fix goal's direct parent, which its completion supersedes (`ultragoal({"op":"supersede","target":"goal","goal_id":"<root id>","rationale":"…","evidence":"…"})`) — so the last fix goal is the final goal and gets the final aggregate receipt. If you completed it first, reopen that last completed goal with `checkpoint(status: "pending")` and re-verify it with the final gate (see Reopening a goal).

## Terminal critic gate

The terminal critic gate is a fail-closed, once-per-run-terminus review. It guards both terminal exits with a read-only `open-gajae-critic` role agent's `OKAY` verdict; it does not run per goal. It is additive to, and does not change, the per-goal `open-gajae-architect` review and the cohort lanes.

### Completion terminus

Before assembling the final gate, the leader delegates the terminal critic. Only the final completion checkpoint requires the additional top-level `criticReview` key; `criticReview` is tolerated but ignored on per-goal checkpoints. A clean final gate requires `verdict: "OKAY"`, non-empty `evidence`, and an empty `blockers` array:

```json
{
  "criticReview": {
    "verdict": "OKAY",
    "evidence": "terminal critic review of the final required-goal state",
    "blockers": []
  }
}
```

### Pause/blocked terminus

At a `human_blocked` terminus, the leader first calls `ultragoal classify_blocker` with `classification: "human_blocked"` (capturing that classification's ledger `event-id`), then delegates the terminal critic and records its verdict with `ultragoal record_critic_verdict` (`terminus: "pause"`, `classification_event_id: "<event-id>"`) before calling `goal({"op":"pause"})`. The pause is allowed only when a later `critic_verdict` ledger entry exists with `terminus: "pause"`, `verdict: "OKAY"`, non-empty evidence, an empty blockers array, and a `classificationEventId` bound to the latest `blocker_classified` event, which must be `human_blocked`. A newer classification supersedes an older verdict.

The critic must verify that the `human_blocked` classification is genuine, including catching false pauses where needed resources exist locally or the asserted blocker is resolvable. A `REJECT` (or `ITERATE`) verdict refuses the terminal pause; the run keeps executing. The pause (`goal({"op":"pause"})`) is the gated terminal park-and-wait exit — a per-goal `ultragoal checkpoint(status: "blocked")` remains available as non-terminal blocker bookkeeping that never signals run completion and keeps the blocker outstanding until resolved.

### Invocation and containment

At each terminus, the leader gives the read-only `open-gajae-critic` role agent `goals.json` (with the run's description), `ledger.jsonl`, `progress.txt`, and the cumulative change set. For completion, invoke it before assembling the final gate JSON. For pause, invoke it after the `human_blocked` classification and before `goal({"op":"pause"})`. The terminal critic must not spawn nested `ralplan`, `deep-interview`, or `ultragoal` workflows.

On repeat terminus attempts within the same run (after an `ITERATE`/`REJECT` reopen cycle or a superseded pause classification), **resume the prior terminal-critic subagent when resumable** instead of freshly spawning one: the critic already holds the description, `goals.json`, the ledger history, and its own prior findings, so re-invocation only needs the delta (new ledger events, the updated cumulative change set, and evidence addressing the prior blockers). Resume with `subagent` and its `sessionID`; when the session is not found, is not a child of the current session, or cannot be resumed — or after an OpenCode restart — fall back to a fresh `open-gajae-critic` spawn with the full context bundle. A resumed terminal critic remains read-only, keeps the same containment rules, and must issue a fresh verdict against the current state — a prior `ITERATE` is never carried forward as pre-judged, and each verdict is still recorded through `ultragoal record_critic_verdict`.

### Non-OKAY loop and ceiling

For completion-side `ITERATE` or `REJECT`, the leader MUST first record the terminal verdict so the run-level counter observes it: `ultragoal({"op":"record_critic_verdict","terminus":"completion","verdict":"<ITERATE|REJECT>","evidence":"<critic findings>","blockers":["…"]})`; then record the findings with `ultragoal record_review_blockers` and reopen the run. The counter ceiling is 5 and counts both termini together: the result prints `critic non-OKAY streak: n/5`. It counts the non-OKAY verdicts since the last OKAY (an OKAY `critic_verdict`, or a final complete checkpoint whose gate carries `criticReview` OKAY) and since the latest `create`. On reaching the ceiling, the plugin holds goal continuation (the result adds `— continuation held`) until the next user prompt, which releases the hold and resets the count. The gates do not change, and there is no override op.

This gate is always fail-closed and has no grandfathering: in-flight runs must obtain a terminal verdict when they reach a terminus.

## Handoff back to planning

When the run's scope or approach must be re-planned, or the user requests return to planning/clarification, hand ultragoal off and load the planning skill:

```json
ultragoal({"op":"handoff","to":"ralplan","reason":"<why control moves>"})
ultragoal({"op":"handoff","to":"deep-interview","reason":"<why control moves>"})
```

Then load `skill` `ralplan` (or `skill` `deep-interview`). In one call the handoff journals the transition, demotes ultragoal (`active: false`, `current_phase: "handoff"`, `handoff_to`), promotes the callee (`handoff_from: "ultragoal"`; ralplan becomes active in `planner` and keeps its `run_id`, so do not call `ralplan start`), syncs `.open-gajae/_session-<created>-<id>/state/skill-active-state.json`, appends a `workflow_handoff` ledger event, and appends a `HANDOFF` note to `progress.txt`. It leaves the goal-mode goal unchanged, so goal continuation keeps prompting while you plan. While ultragoal is the active primary skill, loading `ralplan` or `deep-interview` directly is refused; hand off first.

When ralplan's final plan is approved, ralplan hands back to ultragoal, which returns to `goal-planning`. Read the final plan and call `create` with its description and goals as structured arguments: `create` overwrites `goals.json` (the ledger and `progress.txt` keep the history), so carry the unfinished work of the earlier plan into the new goals. A goal-mode goal that is still open with this plan's objective is kept.

## Constraints

- `ultragoal` results are model-facing text for the active agent; nothing invokes a `/goal` slash command and the agent loop must not depend on one.
- Use only the unified goal-tool surface from the agent loop: `goal({"op":"get"})`, `goal({"op":"create"})`, `goal({"op":"complete"})`, `goal({"op":"drop"})`, `goal({"op":"resume"})`, and the gated `goal({"op":"pause"})`. `drop` clears the active goal without exiting goal mode so the next `goal({"op":"create"})` works in-session.
- For back-to-back ultragoal runs in the same session, `ultragoal create` arms a new goal-mode goal when none is open and keeps an open one that already tracks the plan; when another goal-mode goal is active it arms nothing (`Goal not armed: …`), so call `goal({"op":"drop"})` and `create` again.
- Never call `goal({"op":"create"})` when `goal({"op":"get"})` reports a different active goal-mode goal.
- Never call `goal({"op":"complete"})` unless the run is actually complete (`ultragoal status` shows `run_complete: yes`); it is refused otherwise, whatever the goal-mode goal's origin.
- Intermediate and final goal checkpoints update durable `goals.json` state and append receipt proof to `ledger.jsonl`; the final goal checkpoint creates the final aggregate receipt before the agent may call `goal({"op":"complete"})`.
- Complete checkpoints require `gate`, `implementation`, `files_changed`, and `learnings`. Ultragoal ops and hooks do not complete, pause, resume, or drop the goal-mode goal; the agent reconciles goal state after durable completion.
- Final completion additionally requires a `criticReview` `OKAY`; a `human_blocked` pause additionally requires a clean bound `OKAY` pause `critic_verdict`.
- While the goal-mode goal is active, the plugin continues the session after each turn with a `<goal-continuation>` message. Three turns in a row without a tool call, or a critic non-OKAY streak of 5, hold it until the next user prompt; after Esc it waits for the next user prompt.
- `state_read`, `state_write`, and `state_clear` do not accept ultragoal; use the `ultragoal` tool's ops.
- Treat `ledger.jsonl` as the durable audit trail; checkpoint after every success or failure.

## Source and host substitutions

Source: Gajae Code `packages/coding-agent/src/defaults/gjc/skills/ultragoal/SKILL.md` at `5c5231418930673e42cc5d08ebe4376e03187533` (MIT). The body keeps its Purpose, corrupt-state recovery, always-used commands, Create goals with the granularity rule, Complete goals, blocker triage, dynamic steering invariants, role-agent delegation with the implementation delegation guidance, subagent reuse and the native executor parallelism contract, lane parallelism, the cleaner-fragment rules, the boundary completion cohort gate, the terminal critic gate (including "the leader MUST first record the terminal verdict"), handoff back to planning, and the Constraints, with the substitutions below. The gjc sections on the nudge setting, the legacy objective migration, per-story mode, the deferred gate and validation batches, review mode, cross-repository succession, the computer-use suite, CLI replay and `sourceHash`, and the `ask` block are removed (deviation 24). This skill replaces the earlier open-gajae `ultragoal` skill, a port of OMC v5.4.0 `skills/ralph/SKILL.md` (MIT); of its text only the tool-only-writes note under Purpose and the rule against generic acceptance criteria in Create goals are kept. Deviation numbers refer to "Deviations from GJC (ultragoal)" in README.md, which records the reason and impact of each one.

| gjc 5c52314 | open-gajae | Record |
|---|---|---|
| Frontmatter `name`, `description`, `source` | `name`, and `description` without "GJC", as the plugin's skill loader reads them | Host format; no behavior change |
| "Use when the user asks for `ultragoal`, `create-goals`, `complete-goals`" | `ultragoal`, `@ultragoal`, or ralplan's **Approve execution via ultragoal**; the keyword and mention only advise the load; a native `skill` call enters and raises the state to `goal-planning`, keeping its fields; a same-execution ralplan load in a terminal phase is handed off first | Deviations 22, 35; the label matches the ralplan skill (U3) |
| `gjc ultragoal <verb> --flag …` | `ultragoal({"op":"…", …})`; arguments are snake_case (except `acceptanceCriteria`), the gate JSON is camelCase | Deviations 25, 41 |
| `status --json`, CLI text | Text results only; refusals are `Error: …`; `handoff`, `state`, and `clear` return gjc's one-line JSON write receipt | Deviation 41 |
| `.gjc/_session-{sessionid}` | `.open-gajae/_session-<created>-<id>` of the session lineage's root | Paths only (as ralplan deviation 3) |
| `brief.md`; `create-goals --brief`/`--brief-file`/`--from-stdin`; the `@goal:` delimiter contract; "Stories become `G001`…" | `create(description, goals[{title, description, acceptanceCriteria[]}])`; criteria `G00x.ACn`; `progress.txt` with a `PLAN` note instead of `brief.md` | Deviations 1, 2, 3 |
| Legacy objective migration sentence; nudge budget setting paragraph | Removed | Deviations 10, 24 |
| `gjc state clear --force --mode ultragoal`, scoped by `--session-id` or `GJC_SESSION_ID` | `ultragoal clear(force: true)`, owner from lineage; files kept; an open goal-mode goal is left with a `goal drop` line; `doctor` and `state` are ops too; a restart loads the skill and calls `create` (there is no `start` op, U32) | Deviation 25 |
| `quality-gate source-hash`, `sourceHash`, `priorGenerationSourceHash`, change-set binding; freezing by hash | Removed; freezing means no source change during a generation; generation 2+ needs `deltaOnly` and `deltaPaths` | Deviation 16 |
| `quality-gate validate --quality-gate-json [--goal-id] [--json]` | `validate_gate(gate, goal_id?)`; text `quality gate is valid.` or the diagnostics list; no `goal_id` checks the first pending, active, or failed goal | Deviation 41 |
| `checkpoint --status complete --quality-gate-json`; statuses `complete`/`failed`/`blocked` | `checkpoint(goal_id, status, evidence, gate, implementation, files_changed, learnings)`; `status` is `complete`, `failed`, `blocked`, or `pending` (reopen); the three progress lists are required for `complete` | Deviations 1, 27 |
| `complete-goals [--retry-failed]` | `next(retry_failed?)`; with `retry_failed` and no active goal the first failed goal comes before pending ones | Deviations 17, 34 |
| Complete-goals step 4 "a stale dropped goal (status `"dropped"`)"; per-story mode (`--gjc-goal-mode per-story`, step 10's legacy per-story blocker) | `get` reports `No active goal.` for a dropped goal; per-story mode removed | Deviations 24, 37 |
| goal-mode-request create bridge; "CLI commands and hooks never mutate goal state" | `create` arms the goal-mode goal with the fixed objective, or reports `Goal not armed`; nothing else in ultragoal changes goal state | Deviations 12, 42 |
| "Loop until status reports all goals complete"; "All ultragoal goals are complete" as terminal | The loop also needs `run_complete: yes`; `Run not complete`, `run-complete=no`, and a `goal complete` refusal lead to Reopening a goal (added) | Deviation 41; plan C-7 (d), PQ-14 (1) B′ |
| `steer --kind` with six kinds, `--replacements-json`, `--order-json`, `annotate_ledger`, `--directive-json`, UserPromptSubmit steering | `add`/`revise`/`supersede` with `target`, `after`, `criterion_id`, `rationale`, `evidence`; no annotation or directive surface; `after` cannot place a goal first (IQ-1 B) | Deviations 4, 38 |
| Steering statuses (`requireGoalStatus`, `mark_blocked_superseded`) | Completed goals refused, reopen with `checkpoint(status: "pending")`; wording, moves, and criterion ops on `pending` goals only; goal `supersede` on `pending`/`blocked`/`review_blocked` | Deviations 27, 38 |
| "Accepted and rejected attempts append structured audit entries" | Accepted changes append `steering_accepted`; refused ones write nothing | PQ-16 C (gjc `steering_rejected` is not ported) |
| Role agents `executor`, `planner`, `architect`, `critic` | `open-gajae-executor`, `open-gajae-planner`, `open-gajae-architect`, `open-gajae-critic` | Host role names |
| Native subagent "await timeout"; resume outcomes `running`, `queued`, `context_unavailable`, `not_found`, `no_runner`, `resume_failed` | `status: "running"` of a `background: true` child; `subagent` with `sessionID` per the ralplan skill's routing and persistence boundary; OpenCode has no `queued` outcome | Host tool |
| "preserve its PRD … in the Ultragoal ledger"; "record that judgment in the ledger" | Carried into `create`'s description, goals, and criteria; the ledger's `plan_created` keeps the description | Deviations 4, 39 |
| "Workers must not run `gjc ultragoal checkpoint`"; "current-session GJC goal snapshot" | Workers never call `ultragoal` (hidden from and refused to them); the leader reads `goal({"op":"get"})` | Deviations 8, 23 |
| Aggregate deferred gate (`deferredToBatch`) on every goal but the last; validation batches and the `validation-batch-contracts` fragment | Every goal gets an architect review and the per-goal gate; the cohort runs once at the final goal; no batches | Deviations 13, 21, 24 |
| `ai-slop-cleaner` skill fragment (`kind: "skill-fragment"`, `skill://`) | The `open-gajae-cleaner` subagent, whose prompt is that fragment | Deviation 19 |
| `executionMode: "ultragoal-red-team"` or assignment text naming Ultragoal red-team QA | `[ultragoal-red-team]` in the `open-gajae-executor` assignment; the plugin appends the red-team fragment | Deviation 20 |
| `executorQa` matrix, `artifactRefs`, surface rules, CLI replay, the computer-use suite, `iteration`, architect `commands`, `inlineEvidence` | QA lane `status`, `commands`, `adversarialCases`, `evidence`, `blockers`; a prose claim without a command run is not evidence | Deviations 14, 24 |
| `iteration.reviewCohort` with `sourceHash` and lane statuses `passed`/`CLEAR`/`passed` | Top-level `reviewCohort`, lane statuses cleaner `PASS`, architect `CLEAR`, qa `passed`; `criteriaCoverage` with one row per active criterion | Deviations 15, 28 |
| `record-review-blockers --goal-id --title --objective --evidence` | `record_review_blockers(goal_id, title?, objective, evidence)`; one automatic criterion; `objective` at most 1972 characters; one `goals.json` write | Deviations 36, 40 |
| A fix goal's gate judged before its parent is superseded | Judged with the parent already superseded, so a run-closing fix goal needs the final gate at once | Deviation 29 |
| (none) | Fix goals and the fix-of-a-fix chain: supersede the remaining `review_blocked` root before the last fix completes, else reopen | Documents gjc's one-level supersede (PQ-23 A); no deviation |
| "While an Ultragoal run is active, the `ask` tool is blocked…"; "`ask` remains blocked" | Removed; `question` is not blocked | Deviations 11, 24 |
| `record-critic-verdict --terminus --verdict --evidence [--classification-event-id]` | `record_critic_verdict(terminus, verdict, evidence, blockers, classification_event_id?)` | Deviation 41 |
| Run-level ceiling 5 blocking pause and completion; `record-critic-gate-override`; the nudge-exhaustion `drop` follow-up | A streak of 5 (both termini, after the last OKAY and the latest `create`) holds goal continuation until the next user prompt; gates unchanged; no override op | Deviations 10, 18 |
| Pause receipt bound to the current `planGeneration` and stale after required-goal or steer changes | No plan-generation binding | Deviation 32 |
| Terminal critic context `brief.md` | `goals.json` with its description, and `progress.txt` | Deviation 1 |
| "Receipts are freshness-scoped" (under Review mode) | Kept as Receipts: a final staled by a later required-set change counts per-goal; `status` receipt labels; a reopened goal keeps its receipt (IQ-2 A) | Deviations 2, 5 |
| Review mode (`gjc ultragoal review`); cross-repository succession | Removed | Deviation 24 |
| `gjc state ultragoal write --input '{"current_phase":"handoff"}'`, then the skill tool's same-turn `gjc state ultragoal handoff --to …` | `ultragoal handoff(to, reason)`, then `skill` `ralplan` or `deep-interview`; `workflow_handoff` ledger event and `HANDOFF` note; deep-interview in phase `"deep-interview"`; a direct planning-skill load is refused while ultragoal is the primary skill | Deviations 22, 25, 33, 39 |
| (none) | Returning from ralplan: `create` from the final plan's structured content; `goals.json` overwritten | Documents gjc behavior (the plan passes as text, spec D-HE1); no deviation |
| (none) | The `goal-planning` edit guard and "do not call `status` or `classify_blocker` before `create`" | Documents gjc's mutation guard (temp paths only, PQ-13 A) and reconcile; no deviation |
| (none) | The `<goal-continuation>` loop, its holds, and Esc | Deviations 9, 18, 30 |
| `/goal` slash-command sentences | Kept as "nothing invokes a `/goal` slash command" | Deviation 7 |

See THIRD-PARTY-NOTICES.md and licenses/.
