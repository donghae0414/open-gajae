---
name: ralplan
description: Consensus planning with Planner, Architect, and Critic until agreement, using RALPLAN-DR structured deliberation
argument-hint: "[--interactive] [--deliberate] <task description>"
---

Before step 1, call `state_read(mode="ralplan")` once. Use the returned `plansDir` and `draftsDir` values wherever this document writes `{plansDir}` or `{draftsDir}`. Do not construct these paths yourself and do not read any configuration file directly.

<Purpose>
Ralplan triggers iterative planning with Planner, Architect, and Critic agents until consensus is reached, with **RALPLAN-DR structured deliberation** (short mode by default, deliberate mode for high-risk work). It produces a plan artifact marked `pending approval`; it never implements.
</Purpose>

<Use_When>

- User wants to plan before implementing -- "plan this", "plan the", "let's plan"
- User says "ralplan"
- User wants multi-perspective consensus on a plan
- Task is broad or vague and needs scoping before any code is written
- User supplies a deep-interview specification and wants an implementation plan built from it
  </Use_When>

## Usage

```
@ralplan "task description"
```

```
@ralplan --interactive "task description"
```

## Flags

- `--interactive`: Adds one extra user prompt — the draft review in step 3 (Proceed to review / Request changes / Skip review). It does **not** control the intent check (step 2), the post-consensus check (step 8), or the final approval question (step 9); those always run. Without this flag the Planner → Architect → Critic loop runs without the draft-review pause.
- `--deliberate`: Forces deliberate mode for high-risk work. Adds pre-mortem (3 scenarios) and expanded test planning (unit/integration/e2e/observability). Without this flag, deliberate mode can still auto-enable when the request explicitly signals high risk (auth/security, migrations, destructive changes, production incidents, compliance/PII, public API breakage).

<Execution_Policy>

- Ask one question at a time -- never batch multiple questions
- Gather codebase facts via `open-gajae-explore` before asking the user about them
- Plans must meet quality standards: 80%+ claims cite file/line, 90%+ criteria are testable
- The intent check (step 2), the post-consensus check (step 8), and the final approval question (step 9) always run, with or without `--interactive`
- Uses RALPLAN-DR short mode by default; switch to deliberate mode with `--deliberate` or when the request explicitly signals high risk (auth/security, data migration, destructive/irreversible changes, production incident, compliance/PII, public API breakage)
- Ralplan is a planning module. It may inspect context and draft or update plan/spec/proposal artifacts, but it MUST mark those artifacts as `pending approval` unless the user has explicitly opted into execution in the current turn or via the structured approval UI. Before explicit execution approval, it MUST NOT run mutation-oriented shell commands, edit source files, commit, push, open PRs, invoke execution skills, or delegate implementation tasks.
  </Execution_Policy>

<Steps>

### Consensus Workflow

1. **Planner** creates initial plan and a compact **RALPLAN-DR summary** before any Architect review. The summary **MUST** include:
   - **Principles** (3-5)
   - **Decision Drivers** (top 3)
   - **Viable Options** (>=2) with bounded pros/cons for each option
   - If only one viable option remains, an explicit **invalidation rationale** for the alternatives that were rejected
   - In **deliberate mode**: a **pre-mortem** (3 failure scenarios) and an **expanded test plan** covering **unit / integration / e2e / observability**
2. **Intent check** (always, independent of `--interactive`). Before any review, use native `question` to raise only **material open items** from the Planner draft: an undecided question or assumption that would change the architecture, the scope, or the acceptance criteria, or a conflict with a stated non-goal. Ask one item at a time. If there are none, ask nothing and go straight to step 3. When the argument to this skill is a path to a deep-interview specification, read that specification first and use it as the Planner's input; its decisions are already settled, so this check normally yields zero questions.
3. **User feedback** _(--interactive only)_: If running with `--interactive`, **MUST** use native `question` to present the draft plan **plus the RALPLAN-DR Principles / Decision Drivers / Options summary for early direction alignment** with these options:
   - **Proceed to review** — send to Architect and Critic for evaluation
   - **Request changes** — return to step 1 with user feedback incorporated
   - **Skip review** — go directly to final approval (step 9)
     If NOT running with `--interactive`, automatically proceed to review (step 4).
4. **Architect** reviews for architectural soundness using `subagent(agent="open-gajae-architect", ...)`. Architect review **MUST** include: strongest steelman counterargument (antithesis) against the favored option, at least one meaningful tradeoff tension, and (when possible) a synthesis path. In deliberate mode, Architect should explicitly flag principle violations. **Wait for this step to complete before proceeding to step 5.** Do NOT run steps 4 and 5 in parallel. Architect MUST evaluate the same fixed plan snapshot produced by Planner in step 1 without mutating it; Architect output MUST NOT be passed to Critic.
5. **Critic** evaluates against quality criteria using `subagent(agent="open-gajae-critic", ...)`. Critic **MUST** verify principle-option consistency, fair alternative exploration, risk mitigation clarity, testable acceptance criteria, and concrete verification steps. Critic **MUST** explicitly reject shallow alternatives, driver contradictions, vague risks, or weak verification. In deliberate mode, Critic **MUST** reject missing/weak pre-mortem or missing/weak expanded test plan. Run only after step 4 is complete. Critic MUST evaluate the same fixed plan snapshot independently, as a separate, individually awaited task call; Critic MUST NOT consume or receive the Architect review.

   > **Independent sequential reviews of one fixed plan snapshot.** Architect and Critic each review the same fixed plan snapshot produced by Planner in step 1, and neither review mutates it. Architect output MUST NOT be passed to Critic. Architect and Critic MUST run sequentially as separate, individually awaited task calls — never in parallel — and the Critic task MUST NOT be issued until the Architect task has completed and its result has been awaited. Critic MUST NOT consume or receive the Architect review. Architect and Critic results MUST be combined only by Planner during revision or improvement synthesis, and only after both reviews have completed.

   Critic returns one of `REJECT`, `REVISE`, `ACCEPT-WITH-RESERVATIONS`, `ACCEPT`. Map them to this workflow's gate as: `ACCEPT` and `ACCEPT-WITH-RESERVATIONS` = APPROVE; `REVISE` = ITERATE; `REJECT` = REJECT.

   > **Important:** Steps 4 and 5 MUST run sequentially. Do NOT issue both agent task calls in the same parallel batch. Always await the Architect result before issuing the Critic task. Both reviews consume the same fixed plan snapshot; no Architect output passes to Critic; results combine only during Planner synthesis after both reviews complete.

6. **Re-review loop** (max 5 iterations): If Critic rejects, execute this closed loop:
   a. Collect all rejection feedback from Architect + Critic (Planner-only synthesis: Architect and Critic results MUST be combined only by Planner, and only after both reviews have completed).
   b. Pass feedback to Planner to produce a revised plan
   c. **Return to Step 4** — Architect reviews the revised plan
   d. **Return to Step 5** — Critic evaluates the revised plan
   e. Repeat until Critic approves OR max 5 iterations reached
   f. If max iterations reached without approval, present the best version to user via native `question` with note that expert consensus was not reached
7. **Apply improvements**: When reviewers approve with improvement suggestions, merge all accepted improvements into the plan file before proceeding. Final consensus output **MUST** include an **ADR** section with: **Decision**, **Drivers**, **Alternatives considered**, **Why chosen**, **Consequences**, **Follow-ups**. Specifically:
   a. Collect all improvement suggestions from Architect and Critic responses
   b. Deduplicate and categorize the suggestions
   c. Update the plan file in `{plansDir}` with the accepted improvements (add missing details, refine steps, strengthen acceptance criteria, ADR updates, etc.)
   d. Note which improvements were applied in a brief changelog section at the end of the plan
8. **Post-consensus check** (always). After the loop ends, use native `question` for assumptions or conflicts that surfaced during the Architect and Critic reviews and are still unsettled. One at a time; if there are none, ask nothing.
9. Mark the plan `pending approval` and save it to `{plansDir}/<slug>.md`. Then, always and via native `question` (never plain text), ask exactly one question:

   **Question:** "The consensus plan is ready and marked `pending approval`. Refine it further, execute it via ultragoal, or stop here?"

   **Options:**
   - **Refine further** — Return to step 1 with your feedback and run the consensus loop again.
   - **Execute via ultragoal** — Explicit opt-in to proceed via ultragoal persistence with per-goal architect verification and a final critic review.
   - **Stop here** — Keep the plan as a `pending approval` artifact. This is not approval to implement.

   A free-form answer is honored; treat anything that is not a clear stop or a clear request to execute as `Refine further`. On **Refine further**, call `state_write(mode="ralplan", current_phase="ralplan", awaiting_confirmation=false, breaker_count=0)` before re-entering step 1 — resetting the breaker is required, or a second pass inherits the first pass's reinforcement count. On **Stop here**, report the plan path and call `state_clear(mode="ralplan")`.

   On **Execute via ultragoal**: mark the plan `approved` in the plan file, then call `state_write(mode="ralplan", active=false, current_phase="handoff", plan_path="<absolute plan path>")` — **not** `state_clear` — **before** loading the execution skill, so the handoff is visible to the plugin. Then load `skill` `ultragoal` and call `ultragoal status`. If a valid unfinished `goals.json` exists (for example after an ultragoal `handoff` to ralplan), call `resume(reason)` and merge the new plan into it with `add`, `revise`, and `supersede`, keeping completed and verified goals; otherwise call `create` with `source_plan` set to the plan path. Do NOT implement directly from this skill; ultragoal owns persistent execution and verification.

### Plan Output Format

Every plan includes:

- Requirements Summary
- Acceptance Criteria (testable)
- Implementation Steps (with file references)
- Risks and Mitigations
- Verification Steps
- For consensus/ralplan: **RALPLAN-DR summary** (Principles, Decision Drivers, Options)
- For consensus/ralplan final output: **ADR** (Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups)
- For deliberate consensus mode: **Pre-mortem (3 scenarios)** and **Expanded Test Plan** (unit/integration/e2e/observability)

Plans are saved to `{plansDir}`. Drafts go to `{draftsDir}`.

</Steps>

<Tool_Usage>

- Use native `question` for preference questions (scope, priority, timeline, risk tolerance) -- provides a structured choice UI
- Call `question` with `questions: [{ question, header, options, multiple? }]`; the host adds a free-text answer automatically, so do not add an "Other" option
- Use plain text for questions needing specific values (port numbers, names, follow-up clarifications)
- Use `subagent(agent="open-gajae-explore")` to gather codebase facts before asking the user
- Use `subagent(agent="open-gajae-planner", ...)` for planning validation on large-scope plans
- Use `subagent(agent="open-gajae-critic", ...)` for plan review in the consensus loop
- **CRITICAL — Consensus agent calls MUST be sequential, never parallel.** Always await the Architect task result before issuing the Critic task. Both reviews consume the same fixed plan snapshot; no Architect output passes to Critic; results combine only during Planner synthesis after both reviews complete.
- Default to RALPLAN-DR short mode; enable deliberate mode on `--deliberate` or explicit high-risk signals (auth/security, migrations, destructive changes, production incidents, compliance/PII, public API breakage)
- Use native `question` — never plain text — for the intent check (step 2), the post-consensus check (step 8), and the final approval (step 9); all three run with or without `--interactive`. With `--interactive`, also use it for the draft review (step 3).
- Before explicit execution approval, planning mode MUST NOT run mutation-oriented shell commands, edit files, commit, push, open PRs, invoke execution skills, or delegate implementation tasks; it may only inspect context and draft/update plan/spec/proposal artifacts.
- Record the saved plan path with `state_write(mode="ralplan", plan_path="<absolute path>")` on first save.
- **CRITICAL — state lifecycle**: on entry, before step 1, call `state_read(mode="ralplan")` first (you already do this to resolve `{plansDir}`/`{draftsDir}`), then `state_write(mode="ralplan", active=true, current_phase="ralplan", awaiting_confirmation=false)`. **If that read returned no ralplan state, the entry write must also stamp `started_at="<current ISO-8601 timestamp>"` and `restored_at` equal to it. If state already exists, do not re-stamp either field** — carry the stored values through unchanged. `started_at` is written exactly once per activation and is the origin the session-restore check reads; re-stamping it would raise a spurious `[RALPLAN MODE RESTORED]` banner. Do **not** write `awaiting_confirmation` around questions; it is not a question flag. On the `Stop here` choice, on rejection, and on any error or abort, call `state_clear(mode="ralplan")`. On **Execute via ultragoal**, call `state_write(mode="ralplan", active=false, current_phase="handoff", plan_path=<plan>)` instead of `state_clear`, as step 9 describes. If an ultragoal run is active in this session, the entry `state_write(active=true)` is refused; follow the refusal and call `ultragoal handoff(to="ralplan", reason)` first. Unlike OMC, `state_clear` here only unlinks this session's one state file — it writes no global cancel signal, so OMC's warning about a 30-second enforcement gap does not apply and is removed.

The skill's entry write — `state_write(mode="ralplan", active=true, current_phase="ralplan", awaiting_confirmation=false)` — is the **only** place this skill touches `awaiting_confirmation`. The flag means "the keyword hook seeded this state and the model has not yet loaded this skill", exactly as in OMC; by the time you are reading this document the host has already cleared it, and the explicit `false` on entry is belt-and-braces. Never write `awaiting_confirmation` with a true value. Do **not** set or clear it around native `question` calls. Every `state_write` must still carry the full prior snapshot, because the state store replaces rather than merges; never re-send a stale `awaiting_confirmation: true` from an earlier snapshot.
  </Tool_Usage>

<Examples>
<Good>
Gathering facts before asking:
```
Planner: [spawns open-gajae-explore: "find authentication implementation"]
Planner: [receives: "Auth is in src/auth/ using JWT with passport.js"]
Planner: "I see you're using JWT authentication with passport.js in src/auth/.
         For this new feature, should we extend the existing auth or add a separate auth flow?"
```
Why good: Answers its own codebase question first, then asks an informed preference question.
</Good>

<Good>
Single question at a time:
```
Q1: "What's the main goal?"
A1: "Improve performance"
Q2: "For performance, what matters more -- latency or throughput?"
A2: "Latency"
Q3: "For latency, are we optimizing for p50 or p99?"
```
Why good: Each question builds on the previous answer. Focused and progressive.
</Good>

<Bad>
Asking about things you could look up:
```
Planner: "Where is authentication implemented in your codebase?"
User: "Uh, somewhere in src/auth I think?"
```
Why bad: The planner should spawn an `open-gajae-explore` agent to find this, not ask the user.
</Bad>

<Bad>
Batching multiple questions:
```
"What's the scope? And the timeline? And who's the audience?"
```
Why bad: Three questions at once causes shallow answers. Ask one at a time.
</Bad>

<Bad>
Presenting all design options at once:
```
"Here are 4 approaches: Option A... Option B... Option C... Option D... Which do you prefer?"
```
Why bad: Decision fatigue. Present one option with trade-offs, get reaction, then present the next.
</Bad>
</Examples>

<Escalation_And_Stop_Conditions>

- Stop asking intent-check questions when requirements are clear enough to plan -- do not over-ask
- Stop after 5 Planner/Architect/Critic iterations and present the best version. Do NOT clear ralplan state here — the user may still select **Refine further** at step 9. State is cleared only on the user's final choice at step 9, or on rejection, error, or abort.
- The workflow always ends at a plan marked `pending approval`, and step 9 runs with or without `--interactive`. On **Stop here**, **always** call `state_clear(mode="ralplan")` before stopping.
- If the user says "just do it" or "skip planning" without explicitly naming an execution path, treat it as a request to end planning: output the current plan/spec/proposal as `pending approval` and stop at the step 9 question. Do NOT mutate files, delegate implementation, commit, push, or open a PR from the planning module. The only execution path is **Execute via ultragoal** at step 9.
- Escalate to the user when there are irreconcilable trade-offs that require a business decision
  </Escalation_And_Stop_Conditions>

<Final_Checklist>

- [ ] Plan has testable acceptance criteria (90%+ concrete)
- [ ] Plan references specific files/lines where applicable (80%+ claims)
- [ ] All risks have mitigations identified
- [ ] No vague terms without metrics ("fast" -> "p99 < 200ms")
- [ ] Plan saved to `{plansDir}`
- [ ] RALPLAN-DR summary includes 3-5 principles, top 3 drivers, and >=2 viable options (or explicit invalidation rationale)
- [ ] Final output: ADR section included (Decision / Drivers / Alternatives considered / Why chosen / Consequences / Follow-ups)
- [ ] In deliberate mode: pre-mortem (3 scenarios) + expanded test plan (unit/integration/e2e/observability) included
- [ ] The intent check (step 2), post-consensus check (step 8), and final approval (step 9) each ran through native `question`; the plan is marked `pending approval` only, with no auto-execution
- [ ] `plan_path` recorded on first save, and ralplan state cleared with `state_clear(mode="ralplan")` on **Stop here**, rejection, error, or abort
      </Final_Checklist>

## Pre-Execution Gate

The gate applies to the `ultragoal` keyword and the `@ultragoal` mention.

### Why the Gate Exists

Execution modes (ultragoal, autopilot, team, ultrapilot) spin up heavy multi-agent orchestration. When launched on a vague request like "ultragoal improve the app", agents have no clear target — they waste cycles on scope discovery that should happen during planning, often delivering partial or misaligned work that requires rework.

The ralplan-first gate intercepts underspecified execution requests and redirects them through the ralplan consensus planning workflow. This ensures:
- **Explicit scope**: A PRD defines exactly what will be built
- **Test specification**: Acceptance criteria are testable before code is written
- **Consensus**: Planner, Architect, and Critic agree on the approach
- **No wasted execution**: Agents start with a clear, bounded task

### Good vs Bad Prompts

**Passes the gate** (specific enough for direct execution):
- `ultragoal fix the null check in src/hooks/bridge.ts:326`
- `autopilot implement issue #42`
- `team add validation to function processKeywordDetector`
- `ultragoal do:\n1. Add input validation\n2. Write tests\n3. Update README`

**Gated — redirected to ralplan** (needs scoping first):
- `ultragoal fix this`
- `autopilot build the app`
- `team improve performance`
- `ultragoal add authentication`

**Bypass the gate** (when you know what you want):
- `force: ultragoal refactor the auth module`
- `! autopilot optimize everything`

### When the Gate Does NOT Trigger

The gate auto-passes when it detects **any** concrete signal. You do not need all of them — one is enough:

| Signal Type | Example prompt | Why it passes |
|---|---|---|
| File path | `ultragoal fix src/hooks/bridge.ts` | References a specific file |
| Issue/PR number | `ultragoal implement #42` | Has a concrete work item |
| camelCase symbol | `ultragoal fix processKeywordDetector` | Names a specific function |
| PascalCase symbol | `ultragoal update UserModel` | Names a specific class |
| snake_case symbol | `team fix user_model` | Names a specific identifier |
| Test runner | `ultragoal npm test && fix failures` | Has an explicit test target |
| Numbered steps | `ultragoal do:\n1. Add X\n2. Test Y` | Structured deliverables |
| Acceptance criteria | `ultragoal add login - acceptance criteria: ...` | Explicit success definition |
| Error reference | `ultragoal fix TypeError in auth` | Specific error to address |
| Code block | `ultragoal add: \`\`\`ts ... \`\`\`` | Concrete code provided |
| Escape prefix | `force: ultragoal do it` or `! ultragoal do it` | Explicit user override |

### End-to-End Flow Example

1. User types: `ultragoal add user authentication`
2. Gate detects: execution keyword (`ultragoal`) + underspecified prompt (no files, functions, or test spec)
3. Gate redirects to **ralplan** with message explaining the redirect
4. Ralplan consensus runs:
   - **Planner** creates initial plan (which files, what auth method, what tests)
   - **Architect** reviews for soundness
   - **Critic** validates quality and testability
5. On consensus approval, the plan is saved and marked `pending approval`; the final question offers `Refine further`, `Execute via ultragoal`, or `Stop here`.
6. On `Execute via ultragoal`, ultragoal starts from the approved plan (`create` with `source_plan`).

### Troubleshooting

| Issue | Solution |
|-------|----------|
| Gate fires on a well-specified prompt | Add a file reference, function name, or issue number to anchor the request |
| Want to bypass the gate | Prefix with `force:` or `!` (e.g., `force: ultragoal fix it`) |
| Gate does not fire on a vague prompt | The gate only catches prompts with <=15 effective words and no concrete anchors; add more detail or use `@ralplan` explicitly |
| Redirected to ralplan but want execution | Finish ralplan and choose `Execute via ultragoal` at step 9, or prefix the request with `force:` or `!`. |

## Source and host substitutions

Adapted from OMC v5.4.0 `skills/plan/SKILL.md` and `skills/ralplan/SKILL.md` (MIT). Retained material is the RALPLAN-DR consensus workflow (Planner draft and summary, draft review, Architect review, Critic evaluation, the independent-sequential-review blockquote, the re-review loop, improvement merge and ADR), the planning/execution boundary, the plan output format, the tool-usage and escalation rules, the final checklist, and the entire pre-execution gate section. The consensus steps are renumbered 1–9 to make room for three unconditional native `question` gates: the intent check (step 2), the post-consensus check (step 8), and the final approval (step 9). Host substitutions are OpenCode native `question`, `subagent`, and `state_read`/`state_write`/`state_clear`; `open-gajae-architect`, `open-gajae-critic`, `open-gajae-planner`, and `open-gajae-explore` in place of the OMC subagents; resolved Open-gajae runtime settings in place of configuration-file reads; the `{plansDir}` and `{draftsDir}` placeholders in place of OMC state paths; the `@ralplan` mention in place of the OMC command path; continuation on `session.execution.succeeded` in place of the persistent-mode Stop hook; and a `state_clear` that unlinks only this session's state file, so OMC's 30-second cancel-signal warning is removed. `companyContext` is removed entirely; this is a recorded OMC deviation. Removed are the mode-selection table and the interview, direct, and plan-critique modes; the separate requirements-analysis role; the external-CLI reviewer substitutions and the advisor command they invoked; the merged-skill deprecation note; every host session selector; and OMC's other execution options, leaving **Execute via ultragoal** (the port of OMC's persistence-loop handoff, with `current_phase="handoff"` and a resume-and-merge path for an unfinished goal list) as the only execution path.

**Why there is no question flag.** The `question` tool awaits inside its own tool execution instead of returning immediately (`core/src/tool/plugin/question.ts`): `execute` calls `forms.ask(...)` and does not resolve until the user answers or dismisses the form, so the session's turn never reaches a terminal execution state while a question is open. Continuation here listens for `session.execution.succeeded` (Step 5), and the Phase 0 host probe P2 confirmed that no `succeeded` is published while a `question` is pending — only `created`/`started` events, with `succeeded` following the form's answer. Question-wait versus a genuinely completed turn is therefore distinguished by the host's own durable execution-event stream, and the plugin needs no flag of its own.

OMC's `ARGUMENTS` placeholder (its closing `Task:` line) is not substituted by any host (Claude Code appends an `ARGUMENTS:` line instead), so each occurrence is replaced by a line describing where the arguments arrive. See THIRD-PARTY-NOTICES.md and licenses/.

Task: the user's request is the message that invoked this skill — the `@ralplan` mention arguments, or the text that carried the keyword. No placeholder is substituted here.
