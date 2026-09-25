---
name: ultragoal
description: Goal-driven persistence loop that keeps working until every goal is verified by an architect and the final run is approved by a critic
---

<Purpose>
Ultragoal is a goal-driven persistence loop that keeps working on a task until ALL goals in `goals.json` have passes: true and are reviewer-verified. It combines session persistence, automatic retry on failure, structured goal tracking, per-goal architect verification, and a mandatory final critic review before completion.
</Purpose>

<Use_When>

- Task requires guaranteed completion with verification (not just "do your best")
- User says "ultragoal", mentions `@ultragoal`, or chooses **Execute via ultragoal** at the end of ralplan
- Work may span multiple iterations and needs persistence across retries
- Task benefits from structured goal-driven execution with reviewer sign-off
  </Use_When>

<Do_Not_Use_When>

- User wants to explore or plan before committing -- use `ralplan` instead
- User wants a quick one-shot fix -- delegate directly to `open-gajae-executor`
- User wants manual control over completion -- delegate directly to `open-gajae-executor`
  </Do_Not_Use_When>

<Why_This_Exists>
Complex tasks often fail silently: partial implementations get declared "done", tests get skipped, edge cases get forgotten. Ultragoal prevents this by:

1. Structuring work into discrete goals with testable acceptance criteria (`goals.json`)
2. Iterating goal-by-goal until each one passes
3. Tracking progress and learnings across iterations (`progress.txt`)
4. Requiring fresh architect verification of each goal against its specific acceptance criteria, and a fresh critic review of the whole run before completion
   </Why_This_Exists>

<PRD_Mode>
Ultragoal always operates in PRD mode. There is no scaffold: the goal list is written by the `ultragoal` tool's `create` op, and each goal carries a `priority` (integer, 1 first) and task-specific acceptance criteria. Goals are numbered `G001`, `G002`, … and are worked in priority order, ascending, then by ID.

Files live in this session's artifact directory: `.open-gajae/_session-<label>-<sessionID>/ultragoal/goals.json` and `.open-gajae/_session-<label>-<sessionID>/ultragoal/progress.txt`. The `ultragoal status` result gives the exact paths.

**Tool-only writes.** Only the `ultragoal` tool may change ultragoal files. `write`, `edit`, and `patch` on them are blocked by a guard. Do not change ultragoal files through shell either. Read them freely.

**Revision binding.** Each goal's acceptance criteria and amendment ledger form a revision fingerprint. A completion claim and an architect approval count only while that fingerprint is unchanged: changing a goal or any of its criteria, including by editing the file directly, makes the goal's effective passes and verified false again until it is completed and verified anew. `ultragoal status` reports the effective values.
</PRD_Mode>

<PRD_Criterion_Amendments>
Acceptance criteria are the goal list's completion authority: Step 4 verifies EACH active criterion and Step 7 reviews against them. A criterion can stop governing ONLY through the evidence-preserving amendment path — never by silent deletion or by "satisfying" a criterion measurement has refuted.

When implementation proves a criterion empirically false (e.g. a count in the dispatching brief is wrong), amend it:

1. **Replace** the refuted criterion with the measured correction (`ultragoal` `revise` with `target:"criterion"`, `goal_id`, `original`, `replacement`), or **supersede** it when no replacement governs (`supersede` with `target:"criterion"`, `goal_id`, `original`). Use `add` with `target:"criterion"` for a newly discovered criterion.
2. Every amendment carries `reason` (why the original no longer governs) and `evidence` (the bounded measurement that refuted it, e.g. "enumerated 12 setters, not 16: ..."). The tool records the amendment in the goal's `amendments` ledger, keeps the original text verbatim, and fills in `authority` and `timestamp` itself.
3. The completion check then verifies only the ACTIVE criteria; the ledger keeps the audit trail so reviewers see why the original no longer governs.

Goals themselves are amended the same way: `add` with `target:"goal"` (title, description, priority, acceptanceCriteria, reason, evidence), `revise` with `target:"goal"` (goal_id and any of title, description, priority, plus reason and evidence), and `supersede` with `target:"goal"` (goal_id, reason, evidence).

Rules:
- `reason` and `evidence` must each be at least 5 whitespace-separated words and at least 32 characters. Shorter input is rejected rather than silently weakening the goal list.
- `original` must match an active criterion exactly; an original that is no longer active cannot be amended again.
- Superseding the last active criterion of a goal is refused: use `revise` when a replacement criterion governs, or supersede the goal when the goal itself is unnecessary. Superseding the last active goal is refused.
- This is not a goal-weakening tool: it exists so that "the measurement disagrees with the plan" resolves toward the measurement without the loop losing its grip.
</PRD_Criterion_Amendments>

<Execution_Policy>

- Fire independent agent calls simultaneously -- never wait sequentially for independent work
- Use shell `background: true` for long operations (installs, builds, test suites)
- Deliver the full implementation: no scope reduction, no partial completion, no deleting tests to make them pass
- Change ultragoal files only through the `ultragoal` tool
  </Execution_Policy>

<Steps>
1. **PRD Setup** (first iteration only):
   a. If ultragoal is not running in this session (for example, you are starting it yourself rather than through the `ultragoal` keyword, `@ultragoal`, or ralplan's **Execute via ultragoal**), call `ultragoal start(reason)`. Then call `ultragoal status`.
   b. If an unfinished `goals.json` exists from an earlier run (cancelled, handed off, or interrupted), call `resume(reason)` to continue it, or `create` with `replace: true` to start over. Otherwise call `create` with `description` and `goals`; when the run comes from an approved ralplan plan, also pass `source_plan` with the plan path.
   c. **CRITICAL: Write task-specific criteria.** Every goal needs concrete acceptance criteria before any code is written:
      - Analyze the original task (or the approved plan) and break it into right-sized goals (each completable in one iteration)
      - Write concrete, verifiable acceptance criteria for each goal (e.g., "Function X returns Y when given Z", "Test file exists at path P and passes")
      - Never write generic criteria (e.g., "Implementation is complete"); replace them with task-specific criteria before proceeding
      - Order goals by priority (foundational work first, dependent work later)
   d. `create` initializes `progress.txt`; there is nothing else to set up.

2. **Pick next goal**: Read `ultragoal status` or the continuation context and select the first goal in priority order without effective passes. This is your current focus. If a verification request is pending, finish that verification first (Step 7).

3. **Implement the current goal**:
   - Delegate implementation to `subagent` with agent `open-gajae-executor`, and codebase lookups to `open-gajae-explore`
   - If during implementation you discover sub-tasks, add them as new goals with `ultragoal` `add` (`target:"goal"`)
   - Run long operations in background: Builds, installs, test suites use shell `background: true`

4. **Verify the current goal's acceptance criteria**:
   a. For EACH active acceptance criterion in the goal, verify it is met with fresh evidence
   b. Run relevant checks (test, build, lint, typecheck) and read the output
   c. If implementation proves a criterion empirically FALSE (the measurement refutes it), do NOT mark the goal complete and do NOT silently delete or weaken the criterion. Instead amend it through the evidence-preserving path described in `<PRD_Criterion_Amendments>`: `revise` or `supersede` it with `reason` and `evidence`. Then continue verifying the remaining ACTIVE criteria
   d. If any active criterion is NOT met and NOT amended, continue working -- do NOT mark the goal as complete

5. **Mark goal complete**:
   a. When ALL active acceptance criteria are verified, call `ultragoal` `complete` with `goal_id`, `implementation` (what was implemented), `files_changed`, and `learnings` for future iterations. This one call creates the revision-bound completion claim, records the progress entry in `progress.txt`, and opens the goal's verification request. `complete` is refused while another goal's verification is pending.
   b. Add any discovered codebase patterns with `add_pattern`

6. **Check goal list completion**:
   a. Every completed goal is verified before the next goal is completed: go to Step 7 after each `complete`
   b. If goals without effective passes remain after verification, loop back to Step 2 (pick next goal)
   c. If ALL goals are verified, proceed to Step 7.5

7. **Architect verification** (per goal, against acceptance criteria):
   - Call the reviewer only after `complete` has returned; never call `complete` and the reviewer in parallel in the same step.
   - Call `subagent` with agent `open-gajae-architect` in a NEW session for each review, using the `request_id` that `complete` returned. The plugin appends a verification brief with the goal's criteria and the request; the architect returns its verdict (`VERDICT`, `EVIDENCE`, `ISSUES`) at the end of its response, and you record it with `ultragoal` `record_verdict` (request_id, goal_id, verdict, evidence, issues).
   - The architect verifies against the SPECIFIC acceptance criteria of the goal, not vague "is it done?"
   - **On APPROVAL: immediately continue in the same turn — to Step 2 when goals remain, or to Step 7.5 when all goals are verified. Do NOT pause to report the verdict to the user — reporting happens only at Step 8 (final approval) or on rejection (Step 9). Treating an approved verdict as a reporting checkpoint is a polite-stop anti-pattern.**

7.5 **Mandatory Cleaner Pass** (runs unconditionally after every goal is verified):

- Call `subagent` with agent `open-gajae-cleaner` on the files changed during the current ultragoal run only. The cleaner is read-only: it reports `BLOCKING` and `NON-BLOCKING` findings with file and line, and changes nothing.
- Keep the scope bounded to the ultragoal changed-file set; do not broaden the cleanup pass to unrelated files.
- Fix every blocking finding yourself or through `open-gajae-executor`, inside the same changed-file scope, then run the cleaner again until it reports no blocking issues.

  7.6 **Regression Re-verification**:

- After the cleaner pass, re-run all relevant tests, build, and lint checks for the ultragoal run.
- Read the output and confirm the post-cleanup regression run actually passes.
- If regression fails, roll back the cleanup fixes or fix the regression, then rerun the verification loop until it passes.
- Only proceed to completion after the post-cleanup regression run passes.

8. **Final review**: After Step 7.6 passes, call `ultragoal` `request_final_review` with `cleaner_report` (`summary`, `blocking_issues` — empty) and `regression` (each `command`, `result: "pass"`, `summary`). After it returns, call `subagent` with agent `open-gajae-critic` in a NEW session; the plugin appends the final brief, the critic returns its verdict, and you record it with `record_verdict` (goal_id `"final"`, plus `target_goal_ids` on a reject). On final approval the loop ends by itself: the state becomes complete and you report the result.

9. **On rejection**: The rejected goal loses its passes and verified marks and the reviewer's issues are shown to you. Fix the issues raised, `complete` the goal again, and re-verify with a new reviewer session. A final rejection reopens the goals it names; if it names none, `add` a goal for the fix. After 3 consecutive rejections of the same target the loop pauses until the next user prompt; report the recurring issue.

**Changing the plan mid-run**: Make small adjustments in place — adding, rewording, reprioritizing, or superseding goals and criteria — with `add`, `revise`, and `supersede` (reason and evidence). Hand off to planning only for a re-plan that changes the scope or approach, or when the user explicitly asks for ralplan: call `ultragoal` `handoff(to="ralplan", reason)`, then load `skill` `ralplan`. If the user merely mentions the word ralplan, ignore it. When ralplan returns through **Execute via ultragoal**, call `resume` and merge the new plan with `add`, `revise`, and `supersede`, keeping completed and verified goals.
   </Steps>

<Tool_Usage>

- Use `subagent` with agent `open-gajae-architect` for per-goal verification, `open-gajae-critic` for the final review, `open-gajae-cleaner` for the read-only cleaner pass, `open-gajae-executor` for implementation, and `open-gajae-explore` for codebase lookups
- Use a new subagent session for every review; the plugin attaches the verification brief to the reviewer call
- Proceed with the available reviewer alone -- never block on unavailable tools
- Use the `ultragoal` tool for all ultragoal state and files: `status`, `start`, `create`, `resume`, `add`, `revise`, `supersede`, `complete`, `add_pattern`, `request_final_review`, `record_verdict`, `handoff`, and `cancel`. Reviewers only read (`status`); you record their verdict with `record_verdict`
- Never use `state_read`, `state_write`, or `state_clear` for ultragoal; they do not accept it
  </Tool_Usage>

<Examples>
<Good>
Criteria writing in Step 1:
```
Generic criteria (never pass these to create):
  acceptanceCriteria: ["Implementation is complete", "Code compiles without errors"]

Task-specific criteria:
acceptanceCriteria: [
"scripts/x.ts accepts --dry-run and prints the planned changes without writing files",
"tests/x.test.ts covers --dry-run and passes (bun test ./tests)",
"TypeScript compiles with no errors (bun run typecheck)"
]

```
Why good: Generic criteria replaced with specific, testable criteria.
</Good>

<Good>
Correct parallel delegation:
```

subagent(agent="open-gajae-executor", prompt="Add type export for UserConfig")
subagent(agent="open-gajae-executor", prompt="Implement the caching layer for API responses")
subagent(agent="open-gajae-executor", prompt="Refactor auth module to support OAuth2 flow")

```
Why good: Three independent tasks fired simultaneously.
</Good>

<Good>
Goal-by-goal verification:
```

1. Goal G001: "Add flag detection helpers"
   - Criterion: "--dry-run is parsed from argv" → Run test → PASS
   - Criterion: "TypeScript compiles" → Run build → PASS
   - ultragoal complete(goal_id="G001", implementation=[...], files_changed=[...], learnings=[...]) → returns request_id
   - Then subagent(agent="open-gajae-architect") in a new session → architect returns VERDICT: approve
   - ultragoal record_verdict(request_id, goal_id="G001", verdict="approve", evidence="...", issues=[])
2. Goal G002: "Wire dry-run into the writer"
   - Continue to next goal...

```
Why good: Each goal verified against its own acceptance criteria, and the reviewer is called only after `complete` returned.
</Good>

<Bad>
Claiming completion without goal verification:
"All the changes look good, the implementation should work correctly. Task complete."
Why bad: Uses "should" and "look good" -- no fresh evidence, no goal-by-goal verification, no architect review.
</Bad>

<Bad>
Sequential execution of independent tasks:
```

subagent(executor, "Add type export") → wait →
subagent(executor, "Implement caching") → wait →
subagent(executor, "Refactor auth")

```
Why bad: These are independent tasks that should run in parallel, not sequentially.
</Bad>

<Bad>
Calling the reviewer in the same step as `complete`:
```

ultragoal complete(goal_id="G001", ...)  ┐ same parallel batch
subagent(agent="open-gajae-architect")    ┘

```
Why bad: The verification request does not exist yet when the reviewer starts, so no brief is attached and the verdict cannot be recorded.
</Bad>

<Bad>
Keeping generic acceptance criteria:
"goals.json created with criteria: Implementation is complete, Code compiles. Moving on to coding."
Why bad: Did not write task-specific criteria. This is PRD theater.
</Bad>
<Good>
Evidence-preserving criterion amendment:
```
Criterion: "All 16 files that set FDFT_WHALE_STREAM=1 are classified affected/not-affected WITH EVIDENCE"

Implementation enumerated the setters: 12 exist, not 16 (7 listed names are readers/asserters/doc-recipes).
Two of those mis-classified readers are the ONLY affected files — the wrong count was hiding the answer.

ultragoal revise(
  target="criterion",
  goal_id="G003",
  original="All 16 files that set FDFT_WHALE_STREAM=1 are classified affected/not-affected WITH EVIDENCE",
  replacement="All 12 files that set FDFT_WHALE_STREAM=1 are classified affected/not-affected WITH EVIDENCE",
  reason="The brief count was wrong: 7 listed names are readers/asserters/doc-recipes, not setters",
  evidence="Enumerated setters via grep FDFT_WHALE_STREAM=1: 12 setters, 16 total matches"
)
```
Why good: The falsified criterion stops governing, the measurement is preserved verbatim with reason and evidence, the tool stamps authority and timestamp, and the loop keeps verifying the corrected criterion.
</Good>
</Examples>

<Escalation_And_Stop_Conditions>
- Stop and report when a fundamental blocker requires user input (missing credentials, unclear requirements, external service down)
- Stop when the user says "stop", "cancel", or "abort" -- call `ultragoal cancel(reason)`. Cancel only to abandon the run; the goals and progress are kept and a later run can `resume` them
- Continue working when the plugin sends an `<ultragoal-continuation>` message headed `[ULTRAGOAL - ITERATION n/max]` -- this means the iteration continues
- If the reviewer rejects verification, fix the issues and re-verify (do not stop)
- If the same issue recurs across 3+ iterations, report it as a potential fundamental problem. Three consecutive rejections of the same target, or three turns in a row without any tool call, pause the loop until the next user prompt
- **Do NOT stop after Step 7 approval.** The loop continues through 7 → 7.5 → 7.6 → 8 in the same turn as a single chain. Step 7 is a checkpoint inside the loop, not a reporting moment. Treating an architect/critic APPROVED verdict as "time to summarise and wait for user acknowledgment" is a polite-stop anti-pattern — the only reporting moments in ultragoal are Step 8 (final approval) or Step 9 (rejection).
</Escalation_And_Stop_Conditions>

<Final_Checklist>
- [ ] All goals.json goals have effective `passes: true` (no incomplete goals)
- [ ] Any refuted acceptance criterion was amended through the evidence ledger (original retained), not silently deleted
- [ ] goals.json acceptance criteria are task-specific (not generic boilerplate)
- [ ] All requirements from the original task are met (no scope reduction)
- [ ] Fresh test run output shows all tests pass
- [ ] Fresh build output shows success
- [ ] lsp_diagnostics shows 0 errors on affected files
- [ ] progress.txt records implementation details and learnings
- [ ] Every goal was approved by an architect against its specific acceptance criteria
- [ ] open-gajae-cleaner pass completed on changed files with no blocking issues left
- [ ] Post-cleanup regression tests pass
- [ ] Critic final approval recorded, so the loop ended by itself
</Final_Checklist>

<Advanced>
## Background Execution Rules

**Run in background** (shell `background: true`):
- Package installation (npm install, pip install, cargo build)
- Build processes (make, project build commands)
- Test suites
- Docker operations (docker build, docker pull)

**Run blocking** (foreground):
- Quick status checks (git status, ls, pwd)
- File reads and edits
- Simple commands
</Advanced>

## Source and host substitutions

Adapted from OMC v5.4.0 `skills/ralph/SKILL.md` (MIT, baseline `5281b19e0`). This `ultragoal` is the port of OMC **ralph**, not of OMC's separate ultragoal mode. Retained material is the Purpose, usage criteria, reasons, criterion-amendment contract, execution policy, the step sequence 1–9 with 7.5 and 7.6, the polite-stop rule, examples, escalation rules, final checklist, and the background execution rules. The original task reaches the model through the invoking message and the `Original task:` line of each continuation message, so no placeholder is substituted here. See THIRD-PARTY-NOTICES.md and licenses/.

| OMC | open-gajae | Reason |
|---|---|---|
| `ralph` keyword and command, iteration header and completion-promise text in the skill body | `ultragoal` keyword, `@ultragoal` mention, or ralplan's **Execute via ultragoal**; the plugin's `<ultragoal-continuation>` message carries `[ULTRAGOAL - ITERATION n/max]` | Host entry points and plugin-owned continuation |
| Scaffold PRD file with user stories `US-001`, edited by the model | `goals.json` with goals `G001…` and `priority`, written only through the `ultragoal` tool (`create`, `resume`, `add`, `revise`, `supersede`, `complete`, `add_pattern`); write/edit/patch are blocked | Tool-owned artifacts |
| Criterion-only amendment ledger, 10-character evidence, programmatic amendment helpers | Per-goal ledger for goals and criteria through `add`/`revise`/`supersede`; reason and evidence need 5 words and 32 characters; the tool stamps authority and timestamp | Recorded deviation |
| Legacy no-PRD flag, deslop opt-out flag, reviewer-selection flag, external-CLI reviewer | Removed; the cleaner pass and the critic final review always run | Recorded deviation |
| Stale-state detection and reconciliation block | Removed; an unfinished `goals.json` is offered for `resume` or `create replace: true` | Recorded deviation |
| Single reviewer pass after all stories, tiered by change size | Architect review after each `complete`, one pending request at a time, then a final critic review; three consecutive rejections pause the loop | Recorded deviation |
| Reviewer prompt written by the leader; the leader emits the approval tag | The plugin appends a verification brief to the reviewer `subagent` call; the leader records the returned verdict with `record_verdict` (as gajae-code's leader-recorded review) | Recorded deviation |
| `ai-slop-cleaner` skill that edits files | Read-only `open-gajae-cleaner` subagent; the leader fixes blocking findings | Recorded deviation |
| OMC cancel command and `state_*` for ralph state | `ultragoal cancel(reason)`; `state_*` does not accept ultragoal; final critic approval completes the loop by itself | Recorded deviation |
| No planning return while ralph runs; ralph starts from the model's own state write | `start(reason)`; small plan changes in place with `add`/`revise`/`supersede`, larger re-plans through `handoff(to="ralplan", reason)` followed by `resume` and a merge | Recorded deviation |
| Agent tiers, `model` parameter, tier guide, todo checklist item, company-context step, native goal-loop handoff, parallel-session caveats | Removed; roles and models come from Open-gajae settings, and the host has no todo tool | Host substitution |
| `Task(subagent_type=…)` | `subagent` with `open-gajae-executor`, `open-gajae-explore`, `open-gajae-architect`, `open-gajae-critic`, `open-gajae-cleaner` | Host substitution |
| Claude Code's background parameter for shell commands | shell `background: true` | Host substitution |
| "The boulder never stops" continuation text from the Stop hook | `<ultragoal-continuation>` synthetic message on `session.execution.succeeded` | Host substitution |
