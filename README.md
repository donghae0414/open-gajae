[English](README.md) | [한국어](README.ko.md)

![open-gajae — Clarify. Plan. Execute.](assets/branding/open-gajae-banner.png)

# open-gajae

**A personal learning and toy project built as a plugin for OpenCode v2.** OpenCode v1 is not supported.

## Background and project status

I enjoyed using [gajae-code](https://github.com/Yeachan-Heo/gajae-code) and [oh-my-claudecode (OMC)](https://github.com/Yeachan-Heo/oh-my-claudecode), and wanted a similar experience in an environment where I could only use OpenCode. I started open-gajae to explore that possibility and learn how to develop coding agents, drawing on both projects as references. I also studied [oh-my-openagent (OMO)](https://github.com/code-yeongyu/oh-my-openagent) as a reference for OpenCode plugin development and host integration. Many thanks to the authors and contributors of all three projects for the inspiration and work shared with the community.

This is an independent, unofficial project. It is not affiliated with or endorsed by gajae-code, OMC, OMO, or OpenCode/Anomaly, and is not an official port or compatibility layer for gajae-code, OMC, or OMO. It does not guarantee the same features, behavior, or compatibility as those projects. Its purpose is personal learning and experimentation.

For retained and adapted third-party material, see [third-party notices](THIRD-PARTY-NOTICES.md). [Banner credits](assets/branding/open-gajae-banner.md).

## License

Original open-gajae contributions are licensed under MIT; third-party material remains under its respective original license. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md) for the applicable terms.

## Overview

An OpenCode plugin with session-bound `deep-interview`, `ralplan`, and `ultragoal` skills, eight owned roles, and a small read-only code-research surface. The main-agent prompt, and the `ralplan` skill with its runtime and its three consensus roles, are adapted from GJC; `deep-interview`, `ultragoal`, and the other roles retain their OMC-derived contracts. It is **not** a full OMC or GJC port; its one execution workflow is `ultragoal`, the port of OMC ralph.

## Scope and status

- Phase 1, the OMC-baseline port, was closed by the maintainer on 2026-09-27. Phase 2 improvements are maintainer decisions with gajae-code as the primary reference; the policy is in [AGENTS.md](AGENTS.md).
- The GJC baseline — the main-agent prompt, and the `ralplan` skill, runtime, and consensus role prompts — is GJC v0.17.7, commit `5c5231418930673e42cc5d08ebe4376e03187533`; the OMC-derived skills and role internals remain based on OMC v5.4.0, commit `5281b19e0d64f8e6dc6767f2130299a88af2dc71`.
- The target host is OpenCode v2. This port targets `@opencode/plugin` 2.0.15 against the local `opencode/` reference pinned to `v2.0.15` (`6f3639d82e`); a v1 host can no longer load this plugin (v1 support is dropped — see the deviations table).
- The package is TS source with no build step: `package.json` `exports["."]` points at `./src/index.ts`, and the root `index.ts` re-exports it. There is no `dist/`.
- Implemented scope: `deep-interview`, `ralplan`, and `ultragoal`; `open-gajae`, `open-gajae-explore`, and `open-gajae-document-specialist`; the `open-gajae-planner`, `open-gajae-architect`, and `open-gajae-critic` consensus roles; the `open-gajae-executor` and `open-gajae-cleaner` ultragoal-execution roles; session state; native document output; and thirteen directly-callable tools (three state tools, the `ralplan` tool, the `ultragoal` tool, and eight read-only AST/LSP tools). Company context (the v1 advisory MCP hook) is removed entirely.
- `ralplan` is implemented and ends at a plan marked `pending approval` (`pending-approval.md`), whose final approval step offers `Refine further`, `Approve execution via ultragoal (Recommended)`, or `Stop here`. `ultragoal` is implemented as a goal-driven persistence loop (a port of OMC's ralph) with per-goal architect verification, a mandatory read-only cleaner pass, and a final critic review; the deep-interview → ralplan → ultragoal handoff chain is provided. Not provided: autopilot, team, a standalone `ralph` skill, autoresearch, shared session state, or automatic migration/recovery. No slash commands exist; explicit natural-language requests and supported mentions or keywords can enter a skill (see Entry, below).
- The v2 host and workflow description originated on `feat/opencode-v2-port` at commit `f4df6e6`; the main-agent prompt baseline above is a separate change. That change did not by itself establish Phase 1 completion, and it does not assert that the verification layers below (typecheck, unit tests, host probes) pass for that change — see the plan for its checks.

See [AGENTS.md](AGENTS.md) for development policy and [third-party notices](THIRD-PARTY-NOTICES.md) for attribution.

## Install (OpenCode v2)

```sh
bun install
bun run typecheck
bun test
```

Add a `plugins` entry pointing at this repository's **directory** (not a built file) to the host config, typically `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["/Users/dongwuk/apps/open-gajae"],
  "default_agent": "open-gajae",
  "experimental": { "subagent_depth": 2 }
}
```

- `plugins` must be a directory path. The v2 host resolves `<dir>/server`, then `<dir>/index`, with extension inference, and skips a configured plugin path that is a file — even though some host docs show file-path examples (a recorded docs/implementation mismatch). This package's root `index.ts` re-exports `./src/index.ts`, so the host loads TypeScript source directly with no build step.
- `experimental.subagent_depth: 2` is required for the `open-gajae-planner` role to delegate research to `open-gajae-explore`/`open-gajae-document-specialist` through the native `subagent` tool. The plugin cannot set this itself — v2's plugin API has no config-mutation domain, unlike v1 — so it is a host setting you add yourself. The GJC-based planner prompt gives no delegation instructions, so delegating is the model's choice; without this setting the host refuses the planner's `subagent` call and the planner researches with `read`/`grep`/`glob` itself.
- `default_agent: "open-gajae"` makes the primary role the default for new sessions. Optional but recommended.
- This is not a full replacement config; keep the rest of the file and add only these keys. The plugin never edits host configuration.

This is a summary; see [`docs/local-install-v2.md`](docs/local-install-v2.md) for a full step-by-step walkthrough with a verification checklist, and [`docs/local-install-v1.md`](docs/local-install-v1.md) for the superseded v1 setup this replaces (kept as history).

Once a first prompt has been sent in this directory (plugin `setup` runs lazily, on the first prompt in a location, not at server start), inspect the installed surface with `GET /api/plugin` (confirms the plugin id and its `index.ts` source path) or `opencode debug agent <id>` / `opencode debug skill`.

## Entry

No slash commands exist in this port; v1's `/deep-interview` and `/ralplan` are gone (a recorded deviation). A direct natural-language request to use `deep-interview`, `ralplan`, or `ultragoal` runs the requested skill, as do supported mentions and invocation-context keywords:

- **Mention:** type `@deep-interview` or `@ralplan` and pick it from the TUI's autocomplete. Selecting it attaches the skill directly; typing the text without selecting the suggestion sends plain text with no attached skill, since the server does not parse `@` mentions itself — the keyword path below is what picks that up instead.
- **Keyword:** the same OMC-derived keyword detection as v1 (English/Korean/Japanese forms, exclusion of questions/quotes/code blocks, and ralplan's invocation-context requirement) recognizes an explicit request from plain text and injects a notice. A heuristic suggestion when no skill was requested instead offers the skill or direct work and follows the user's choice. Ordinary clarification can still happen without starting `deep-interview`. Once a skill starts, its own questions, completion choices, and approval steps still apply.

## Deep interview and storage

A `@deep-interview` mention or one of the keywords `deep interview`, `deep-interview`, `딥인터뷰`, `ディープインタビュー`, `ouroboros` starts requirements clarification. As in OMC, only informational contexts are excluded (questions, quoted or referenced mentions, and text inside code, tables, or block quotes), and a message that starts with the `ouroboros`/`ooo` CLI form is ignored. A turn carrying the keyword, or an explicit `@deep-interview` mention, injects OMC's `[MAGIC KEYWORD: DEEP-INTERVIEW]` guide at most once and seeds no state — an explicit mention now getting the same notice as a bare keyword is OMC parity; v1 suppressed the notice on explicit invocation (a recorded deviation). The skill uses native `question` one question at a time. A denied or unavailable question tool is reported; prose fallback does not substitute for it. A completed spec is not authorization to implement it.

After reaching the ambiguity threshold and saving the spec, the skill asks whether to finish or refine further. Refinement preserves the current session and history, asks an additional requirements question before rechecking the threshold, and updates the same spec file. The choice itself does not consume a round. The cumulative `maxRounds`, explicit early exit, and cancellation still apply; tool failures are never treated as consent to finish. Choosing "Refine with ralplan consensus" saves the spec, then invokes the `ralplan` skill with the saved spec path (`{specsDir}/deep-interview-{slug}.md`) as context, using OMC-style wording that names the skill by content rather than its input field — the v2 `skill` tool's input is `{ id }` only, and naming the wrong field risks one host input-error retry before the model corrects itself. This is a prompt-level interaction contract, not a host-enforced state machine.

State tools are `state_read`, `state_write`, and `state_clear`. They use the trusted current `ToolContext.sessionID`; callers cannot select another session. Each session owns one directory named `_session-<YYYYMMDD-HHMMSS>-<session id>`, where the label is the session's creation time in local time and the ID is the native session ID verbatim (for example `_session-20260918-030958-ses_f4f8651eaffeQnjyo1jEd5zVDu`). The creation time is read once from the host when the directory is first resolved; afterwards the directory is found by its session-ID suffix, and two directories with the same suffix are an error. Generated paths are:

```text
<worktree>/.open-gajae/
  _session-<created>-<session-id>/
    state/deep-interview-state.json
    specs/deep-interview-<slug>.md
```

State writes replace the model snapshot; explicit tool fields win and `_meta` is regenerated. `state_clear` deletes only the current session's state JSON. It preserves session documents, other sessions, and legacy files. Invalid/corrupt state is surfaced and preserved rather than reset.

State operations for the same canonical file are serialized inside one plugin process and publish JSON with temporary-file rename. This is not IPC locking, a transaction across state and document saves, power-loss durability, or multi-process safety. Specs are saved outside that queue using native `write`. Further interview results update the same file, with no suffix, receipt, index, or automatic recovery.

A user may explicitly name another session's spec or plan as an input. Native Read and its normal permissions apply. The current session must report the path actually read; it must not scan for a latest document or substitute another file. Reading A from B transfers no state, owner, approval, or checkbox and does not authorize source edits or plan execution. B writes only its own state/documents.

## Ralplan

`ralplan` is consensus planning rebuilt on GJC's ralplan skill and runtime contract at the GJC pin: `skills/ralplan/SKILL.md`, the `open-gajae-planner`, `open-gajae-architect`, and `open-gajae-critic` prompts, and the `ralplan` tool in `src/ralplan-runtime/`. It is planning only: the plan stays `pending approval` until the user approves execution. Every difference from GJC is recorded in [Deviations from GJC (ralplan)](#deviations-from-gjc-ralplan).

A `@ralplan [--interactive] [--deliberate] <task>` mention, or the `ralplan`/`랄플랜` keyword, starts consensus planning. As in OMC, the keyword only activates in an invocation context: a direct prefix (`$ralplan`, `!ralplan`, `force: ralplan`), an activation verb (`use`, `run`, `start`, `please`, `let's`), or the keyword at the start of the message. Questions, quoted or referenced mentions, and text inside code, tables, or block quotes do not activate it. The keyword works from any primary agent; messages whose agent is `open-gajae-planner`, `open-gajae-architect`, or `open-gajae-critic` are ignored by the keyword hook. When one message carries both the ralplan and the deep-interview keywords, both notices are injected, ralplan first.

A keyword turn injects a `[MODE: RALPLAN]` notice asking the model to load the `ralplan` skill. A `@ralplan` mention injects its own `[MODE: RALPLAN]` notice saying the skill is already attached, so the insertion is visible (the TUI shows `open-gajae: ralplan mention notice added`). Neither writes ralplan state: there is no seed, confirmation step, or stale-seed cleanup. The run starts when the primary calls `ralplan start`, the documented entry (GJC's `gjc ralplan "<task>"`).

Notices — the ralplan notice, the deep-interview magic guide, the ultragoal restore banner, and the breaker message — are written as `ctx.session.synthetic({ resume: false })` messages, after any state write that goes with them. The host places a synthetic message **before** the user's message in the same turn, unlike OMC/v1, which appended it after (a recorded host-placement deviation, not a design choice). If `synthetic` itself fails, the notice is appended, marker-wrapped, to the prompt text instead, so it is never silently lost; the state write is kept either way.

**The `ralplan` tool** is the only writer of the ralplan state, the run's stage files, and the ralplan active row and snapshot; the `state_*` tools no longer accept `mode: "ralplan"` and serve deep-interview only. Its ops mirror GJC's CLI and state verbs:

| Op | Callers | Effect |
|---|---|---|
| `start(task, interactive?, deliberate?, run_id?)` | primary | Writes a fresh state (`active: true`, phase `planner`, `mode` short or deliberate) and returns a receipt with `session_id`, `run_id`, `state_path`, and `repository_binding`. Refused while ultragoal is running. |
| `write(stage, stage_n, content \| path, run_id?, lane_verdict?, resumable?, fallback_*)` | primary, planner, architect, critic | Persists one stage artifact and returns a plain receipt (`path`, `sha256`, `stage`, `stage_n`, …). |
| `status(fields?)` | primary, planner, architect, critic | Returns `{skill, state, storage_path}`; `fields` projects state fields. |
| `doctor` | primary | Reports `schema_violation` and `stale_active_state`; changes nothing. |
| `state(patch)` | primary, planner, architect, critic | Merges a patch (`null` deletes a field); a phase change must follow GJC's transition table. Stop here is `patch={"active": false}`. |
| `handoff(to="ultragoal")` | primary | Hands the approved plan to ultragoal (below). |
| `clear(force?)` | primary | Sets `{active: false, current_phase: "complete"}` and keeps the files and `run_id`. Without `force` it refuses, as GJC does, a corrupt state, a state already in a terminal release phase (such as `complete`), and a state on an unlocked phase whose active-row phase differs from it (on a locked phase such as `final`, GJC reads the row's phase as the state's, so a clear during post-final refinement goes through); an unreadable active-row file also stops it (deviation 35). |

Every op acts on the calling session's lineage root, so a role's child session writes into the root session's folder. The run folder is the explicit `run_id`, then the state's `run_id`, then the root session's native ID (for example `ses_f4b081a27ffe…`); an explicit `run_id` is 1–64 characters of `A-Z a-z 0-9 . _ -`, must not start with `.`, and must not contain `..`. `open-gajae-explore`, `open-gajae-document-specialist`, `open-gajae-executor`, and `open-gajae-cleaner` have the tool denied and hidden. Host agents such as `build` and `general`, and user-defined agents, may see it but are refused when they call it.

```text
<worktree>/.open-gajae/
  _session-<created>-<session-id>/
    plans/ralplan/<run-id>/
      stage-01-planner.md
      stage-01-intent.md
      stage-01-architect.md
      stage-01-critic.md
      stage-02-revision.md
      …
      stage-NN-final.md
      index.jsonl
      pending-approval.md
    state/ralplan-state.json
    state/ralplan-continuation.json
    state/audit.jsonl
    state/active/ralplan.json
    state/skill-active-state.json
```

- **Stage files.** Stages are `planner`, `intent`, `architect`, `critic`, `disposition`, `revision`, `post-interview`, `adr`, and `final`; `stage_n` (1–999) is the pass number. Each write creates an immutable `stage-NN-<stage>.md` and appends one row `{stage, stage_n, path, created_at, sha256}` to the run's `index.jsonl` ledger; the `final` row also carries `auto_handoff`. `final` is copied to `pending-approval.md`, which the next `final` overwrites. There are no link rules, generated index pages, or generated headers.
- **Idempotent writes.** Rewriting the same `(stage, stage_n)` with identical content returns the earlier receipt with `deduplicated: true` (and restores a missing ledger row); different content is refused with "Use a new stage_n to record another pass."
- **Roles write content only.** The planner, architect, and critic pass the whole artifact as `content` and return only the receipt to the primary. The primary may pass `content`, or a `path` to a file under an OS temp root (`os.tmpdir()`, `$TMPDIR`, `/tmp`, `/var/tmp`, and their `/private` aliases) outside the project.
- **Dispositions.** When Architect and Critic findings conflict, a `disposition` stage (JSON, GJC's `ralplan.review_conflicts.v1` schema) must resolve each conflict before revision; the tool checks its source receipts against the run's ledger and refuses open, unknown, or mismatched entries.
- **Bookkeeping.** `state/audit.jsonl` gets one row per file change. `state/active/ralplan.json` and the `state/skill-active-state.json` snapshot hold the active row and its HUD chips; nothing in open-gajae draws them yet (Mandatory follow-up development, item 6). `state/ralplan-continuation.json` holds only the continuation breaker counter.

**Budgets and PLANNING-STUCK.** A run opens at most `ralplan.maxIterations` passes (planner and revision openers, default 5), counted from `index.jsonl` or from the stage files on disk, whichever is larger. Each lane may write `ralplan.maxReviewPassesPerLane` architect or critic passes per opened pass (default 1). A write over either budget returns a `PLANNING-STUCK` result (`ok: false`, `planning_stuck: true`, `marker: "PLANNING-STUCK"`) instead of an error, and the state records `planning_stuck`. Architect and critic writes inside an already opened pass, and `post-interview`, `adr`, and `final`, still go through, so the best plan can be kept as `pending approval`; a stuck run's `final` resolves `auto_handoff` to `off` with reason `planning_stuck` and is never dispatched. A new `run_id` starts a fresh folder and budget.

**Consensus flow.** The skill follows GJC's nine steps. The planner drafts (`planner`, pass 1). The primary reconciles material intent with the user (`intent`), one native `question` at a time, and resumes the planner for a `revision` if the contract changed. The architect and a plan-only critic review pass 1 in parallel (two `subagent` calls in one message) and record `lane_verdict` (`CLEAR`/`WATCH`/`BLOCK`, `OKAY`/`ITERATE`/`REJECT`). Pass 2 and later resume the same planner, architect, and critic sessions (`subagent` with the recorded `sessionID`) and review sequentially, architect then critic. After consensus the primary checks new intent deltas with the user (`post-interview`) and writes `final` with its ADR. `--interactive` adds a draft review; `--deliberate` adds a pre-mortem and an expanded test plan, and it auto-enables on explicit high-risk signals. No continuation fires while a question is open, because the native `question` tool holds execution until it is answered — no `session.execution.succeeded` is published in the meantime.

The tool records each role's own session ID when that role writes (`planner_subagent_id`, `architect_id`, `critic_id`), so the primary can resume it. When a resume fails, the primary starts a fresh role session and records `fallback_reason`, `fallback_attempted_id`, and `fallback_stage_n`.

**Approval, Stop here, and handoff.** If `final` resolves `auto_handoff.effectiveTarget` to `ultragoal` (with `ralplan.autoHandoff: "ultragoal"` set and the run not stuck), the primary hands off without asking. Otherwise it asks one `question` offering **Refine further**, **Approve execution via ultragoal (Recommended)**, and **Stop here**, plus free text. The plan stays `pending approval` unless the user approves or has already named ultragoal in the same turn.

- **Refine further** returns to the re-review loop.
- **Stop here** is `ralplan state(patch={"active": false})`: the phase stays `final`, `pending-approval.md` is kept, and the active row is removed. Asking for ultragoal later still works.
- **Approve execution via ultragoal**: the primary calls `ralplan handoff(to="ultragoal")`, loads the `ultragoal` skill, and calls `create` with `source_plan` set to the `pending-approval.md` path (or `resume` when an unfinished goal list already exists). The handoff op requires a terminal phase (`final`, `handoff`, `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`). It sets ralplan to `{active: false, current_phase: "handoff", handoff_to: "ultragoal"}`, removes the active row, and writes a confirmed ultragoal state with `handoff_from: "ralplan"`.
- **Ultragoal entry gate.** While ultragoal is not running in the root session, loading the `ultragoal` skill, an `@ultragoal` mention, and `ultragoal start`, `resume`, or `create` are refused when ralplan is active in a non-terminal phase, and perform the same handoff first when ralplan is active in a terminal phase (for example the active `final` while the approval question is open).
- **The reverse.** `ultragoal handoff(to="ralplan", reason)` pauses ultragoal (goals and progress are kept, not deleted) and starts ralplan in the same call with the reason as its task, reusing the existing `run_id`. Call `ralplan start` with a new `run_id` for a fresh run folder and budget. Approving again calls `ultragoal resume`, which merges the new plan into the kept goals with `add`, `revise`, and `supersede`.

**Write semantics (as in GJC).** A `write` without a prior `start` creates the state (`active: true`, phase = the stage written, no `mode`, `interactive`, or repository binding). A `write` with a new explicit `run_id` switches the run and resets the verdict, stuck, and auto-handoff fields. On the same run, a write sets `active: true` and advances the phase to the stage written, unless the phase is locked (`final`, `handoff`, `complete`, …): then the state is left untouched, so refinement writes after Stop here or `clear` do not reactivate the run. A write still rewrites the active row, which stays until the next Stop here, handoff, or clear. `write` is not refused while ultragoal runs: a role's or the primary's write during an ultragoal run can activate ralplan, and after ultragoal finishes the planning guard then blocks edits and the entry gate refuses a new ultragoal. Recover with `ralplan state(patch={"active": false})` or `ralplan clear`; the guard's block message names both.

**Planning guard.** While the root session's ralplan state is `active: true` in a phase other than `complete`, `completed`, `failed`, `cancelled`, `canceled`, or `inactive` — so `final` and `handoff` still block while active — `write`, `edit`, and `patch` are refused for every agent in that session lineage unless every target is under an OS temp root outside the project. The guard does not apply while ultragoal is running in the root session, and it does not inspect `shell` commands. A deep-interview spec save during planning is blocked too; the deep-interview bridge saves the spec before `ralplan start`, so the normal flow is unaffected. Independently of the guard, every agent is always refused `write`, `edit`, and `patch` on a session folder's `plans/ralplan/**` and `state/**`, and on ultragoal-owned files; only the tools change them.

Continuation re-prompts the session on the durable `session.execution.succeeded` event (v2 does not publish `session.idle`) via `ctx.session.synthetic({ resume: true })`, while ralplan state is active, not in a terminal phase, and not `planning_stuck`. A circuit breaker stops reinforcement after 30 injections, and the breaker counter, kept in `state/ralplan-continuation.json`, expires after 45 minutes, unchanged from v1's constants; exhaustion sets ralplan `active: false` and writes one audit row. When the user interrupts a turn — `session.execution.interrupted` with reason `user` (Esc, or the interrupt API) or `shutdown` (a dismissed `question` form, and the host's default reason-less interrupt) — a stop mark is set; only the next real user prompt clears it. Reasons `inactivity` and `superseded` do not set the mark. Continuation also skips while an owned background subagent session (launched with `background: true`) is still running under the current session, tracked from `session.created`/`session.execution.started`/terminal events by `parentID` (OMC/OMO parity; v1 had no background-subagent case). When such a child finishes, the host's own subagent-completion synthetic resumes the parent, and that later `succeeded` is judged like any other, bounded by the same breaker. Because a v2 plugin instance is created per location on a shared server and every instance receives every server event, this plugin only acts on sessions whose location matches its own — a fact new to v2, not a change to any of the decisions above.

When the host compacts a session whose ralplan state is active, the plugin adds one `<ralplan-compaction-context>` block to the compaction prompt with the current plan's goal, scope, non-goals, acceptance criteria, Intent Reconciliation, and next action. Nothing is added when the state is inactive or corrupt or the artifact's sha256 no longer matches its ledger row. State is per-session; there is no cross-session resume and no ralplan restore notice.

**Known behavior (as in GJC).** After a write on a locked phase — refinement after `final`, or a write after Stop here or `clear` — the active row's phase is the stage just written while the state's phase stays `final` or `complete`. `ralplan doctor`, which reads the raw row files, then reports `stale_active_state` with `ralplan clear` as its fix command, as GJC does; after refinement on `final` that unforced `ralplan clear` succeeds, also as in GJC, because `clear` reads a locked state's phase in place of the row's (after a `clear` the state is already terminal, so an unforced clear is refused). This is expected: do not call `ralplan clear` on that report alone, because clearing ends the run.

**Known behavior (as in GJC): transition audit rows.** A write whose stage is not a table edge from the current phase still succeeds; it only appends an `invalid_transition_detected` row to `state/audit.jsonl` (spec D-T11). The skill's own order produces such rows routinely, because the table lacks these edges: parallel pass-1 reviews land in either order (`critic→architect`, `revision→critic`), a revision follows the last review lane (`architect→revision`), pass 2 goes from the revision straight to the Architect (`revision→architect`), and step 7 writes `final` right after `post-interview` (`post-interview→final`, since the table routes `final` through `adr`). GJC's table and skill are the same, so GJC writes the same rows for the same order.

**No progress display.** The TUI sidebar the spec planned for ralplan (D-H3–D-H7) is deferred (R-OD17): the distributed OpenCode 2.0.15 binary does not give a TUI plugin the host's `solid-js` and `@opentui/*` instances, so a plugin cannot draw with ordinary imports (Mandatory follow-up development, item 6). The ralplan active row and snapshot still carry GJC's HUD chips.

## Owned roles and settings

- **`open-gajae`** is the primary. It owns edits, decisions, integration, and state write/clear. No rules are added beyond the host defaults.
- **`open-gajae-explore`** investigates repository facts read-only. It cannot edit, delegate (`subagent`), ask questions (`question`), or write/clear state. It keeps full `shell` access (OMC parity — no `shell`/Bash rule is added for any role).
- **`open-gajae-document-specialist`** researches documentation and citations. It cannot edit, delegate, ask questions, or write/clear state. Its `chub` protocol is documented as read-only in its prompt; the host permission rules do not restrict `shell` to only `chub` commands.
- **`open-gajae-planner`**, **`open-gajae-architect`**, and **`open-gajae-critic`** are the ralplan consensus roles. All three run as `mode: subagent` and carry no default model; set one through the settings `agents` map. Their prompts are GJC's planner, architect, and critic roles with host substitutions. None of the three can edit: each records its stage artifact with `ralplan write` (`content` only) and may use `ralplan status` and `ralplan state`; `edit` is denied, as are `question`, `state_write`, and `state_clear`. Architect and critic also have `subagent` denied. The planner delegates research: its `subagent` permission allows only `open-gajae-explore` and `open-gajae-document-specialist`. `question`, `state_write`, `state_clear`, and both Code Mode session tools (`opencode_session_move`, `opencode_session_rename`) stay denied for all seven subagent roles. `subagent_depth` is not raised by the plugin; set `experimental.subagent_depth: 2` in host config yourself (see Install).
- **`open-gajae-executor`** (ported from OMC's `agents/executor.md`) implements the code changes for one `ultragoal` goal at a time. It cannot ask questions (`question` denied) and cannot use the `ultragoal` tool itself; its only delegation is `subagent` to `open-gajae-explore` for codebase lookups and `open-gajae-architect` after repeated failures on the same issue. It keeps `edit` and `shell`.
- **`open-gajae-cleaner`** (ported from OMC's `ai-slop-cleaner` skill, reworked as a read-only reviewer) is `ultragoal`'s mandatory cleanup review, run once every goal is verified and before the final critic review. It cannot edit, write, patch, delegate, ask questions, write/clear state, or use the `ultragoal` tool; it keeps `shell` for inspection and reports `BLOCKING`/`NON-BLOCKING` findings by file and line without changing anything.
- Within `ultragoal`, `open-gajae-architect` and `open-gajae-critic` additionally keep the `ultragoal` tool, restricted to `status`; they return their verdict in their response and the primary records it with `record_verdict` (as gajae-code's leader-recorded review). Every other owned role has `ultragoal` denied.

Role rules are pushed onto each agent's `permissions` array after the host's own defaults, but **host `agents.<id>` permission rules from your config apply after the plugin's and win** — unlike v1, which reordered rules to keep a mandatory denial in force, a host override can loosen a role's default deny (a recorded deviation: "user config wins"). Settings are read from `~/.open-gajae/open-gajae.jsonc` and `<worktree>/.open-gajae/open-gajae.jsonc`. Fields merge project → user → defaults; unknown keys, invalid JSONC, or invalid values fail with diagnostics.

The default ambiguity threshold is `0.1` (10%). This user-requested stricter clarity gate differs from the pinned OMC default of `0.2` (20%); it is a product choice, not a host-required deviation. Explicit settings still override the default.

```jsonc
{
  "deepInterview": { "ambiguityThreshold": 0.1, "maxRounds": 20 },
  "ultragoal": {
    // 0 = unlimited, default 200
    "hardMaxIterations": 200
  },
  "agents": {
    "open-gajae": { "model": "provider/model", "variant": "variant-name" },
    "open-gajae-planner": { "model": "openai/gpt-6-luna" },
    "open-gajae-architect": { "model": "openai/gpt-6-luna", "variant": "high" },
    "open-gajae-critic": { "model": "openai/gpt-6-luna", "variant": "high" },
    "open-gajae-executor": { "model": "openai/gpt-6-luna", "variant": "medium" },
    "open-gajae-cleaner": { "model": "openai/gpt-6-luna", "variant": "medium" }
  },
  "ralplan": { "maxIterations": 5, "maxReviewPassesPerLane": 1, "autoHandoff": "off" }
}
```

`ultragoal.hardMaxIterations` is an integer `>= 0`; `0` means unlimited and the default is `200` (a hard ceiling on continuation iterations: when `max_iterations` has been extended up to it, the loop stops and reports; independent of the per-goal and final reviews below).

| Setting | Default | Meaning |
|---|---|---|
| `ralplan.maxIterations` | `5` | Planner and revision passes one run may open, integer `1..20`. |
| `ralplan.maxReviewPassesPerLane` | `1` | Architect or critic passes per opened pass, integer `1..10`. |
| `ralplan.autoHandoff` | `"off"` | `"ultragoal"` hands a non-stuck `final` to ultragoal without the approval question. |

The `ralplan` keys merge per key like the other fields and are resolved once, when the plugin sets up in a location; restart the host after changing them. The `final` receipt's `auto_handoff.source` names the file whose `autoHandoff` value won, or `default`.

`variant` requires `model` on the same, already-merged entry: a user-level `model` plus a project-level `variant` is valid, but `variant` alone — in one file or split across both with no `model` anywhere — is rejected with an error naming the agent and asking to add `model "provider/model"`. This is stricter than the v2 host itself, which silently drops such a variant with a diagnostic. There is no provider fallback, tier mapping, or artificial collision rejection. The v1 `companyContext` setting is gone; supplying it now fails as `unknown setting`.

`ultragoal` layers its verification instead of trusting a single completion claim. Each goal is checked against its own acceptance criteria by a fresh `open-gajae-architect` session, whose `approve` or `reject` verdict the primary records with `record_verdict`; once every goal is verified, a mandatory read-only `open-gajae-cleaner` pass reviews the run's changed files and any blocking finding is fixed before continuing; and only after that cleanup and a passing regression re-run does a fresh `open-gajae-critic` session review the whole run; the primary records its final verdict. The loop only completes on that final critic approval — a rejection at any layer reopens the goal(s) it names instead of ending the run. `ultragoal cancel(reason)` abandons the run (its state is removed, but `goals.json`/`progress.txt` are kept for a later `resume`), and `ultragoal.hardMaxIterations` is the hard ceiling behind all of it.

## Read-only code tools

The plugin registers eight read-only code tools (plus the three state tools, the `ralplan` tool, and the `ultragoal` tool above, thirteen in total):

- `ast_grep_search` (`@ast-grep/napi` 0.31.1): AST search only; no replace.
- `lsp_goto_definition`, `lsp_hover`, `lsp_diagnostics`, `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, and `lsp_servers`.

LSP servers are detected and reported, never downloaded. There is no LSP rename, code-action, or replacement suite. The actor set is all eight owned roles — `open-gajae`, `open-gajae-explore`, `open-gajae-document-specialist`, `open-gajae-planner`, `open-gajae-architect`, `open-gajae-critic`, `open-gajae-executor`, and `open-gajae-cleaner` — matching OMC, where every agent can use the read-only LSP/AST tools. The project boundary replaces v1's per-call host permission ask: an input path is resolved against the host's current location directory, symlinks are followed, and the real target must stay inside the real project directory; `.env` and `.env.*` files are refused by both the requested and the resolved name, and `ast_grep_search` skips them during traversal too. Neither tool expands the explorer's permissions or grants arbitrary shell execution.

The only product environment knobs reached by source are `OPEN_GAJAE_LSP_TIMEOUT_MS`, `OPEN_GAJAE_LSP_IDLE_TIMEOUT_MS`, `OPEN_GAJAE_LSP_IDLE_CHECK_INTERVAL_MS`, `OPEN_GAJAE_LSP_CONTAINER_ID`, and `OPEN_GAJAE_PYTHON_LSP=basedpyright`. They are LSP implementation settings, not general configuration.

## Deviations from OMC and the v1 plugin

The table records host-required changes to the OMC-derived workflows and roles, or to the v1 implementation they replaced (AGENTS.md policy). Those changes trace to the port's spec/plan (`.omc/specs/deep-interview-opencode-v2-port.md`, `.omc/plans/ralplan-opencode-v2-port.md`). The GJC-based main-agent prompt is a separate adaptation (see [third-party notices](THIRD-PARTY-NOTICES.md)), and so is the GJC-based `ralplan`, which replaced the OMC-derived ralplan skill, its role prompts, and its state seeding (see [Deviations from GJC (ralplan)](#deviations-from-gjc-ralplan)).

| Deviation | Detail |
|---|---|
| No slash commands | v1's `/deep-interview` and `/ralplan` are gone. An explicit natural-language request or a supported skill mention/keyword enters the requested skill; heuristic suggestions require a user choice. |
| Company context removed | The `companyContext` setting, the runtime-settings block entry, the deep-interview/ralplan step-0 instructions, and `tests/company-context-probe.ts` are gone entirely, not merely undocumented. |
| `subagent_depth` is a host setting | v2's plugin API has no config-mutation domain, so the plugin cannot raise it as v1 did. Set `experimental.subagent_depth: 2` yourself; the planner falls back to direct research when refused. |
| User config wins over role rules | Host `agents.<id>` permission rules apply after the plugin's and can loosen a role's default deny, unlike v1's rule-reordering trick. |
| Explore and document-specialist keep full shell access | OMC parity: no `shell`/Bash permission rule is added for any role. |
| "Bash" renamed to `shell` | Every prompt and skill uses the v2 tool name `shell` instead of "Bash". |
| The deep-interview → ralplan bridge names the skill, not the input field | OMC-style wording ("invoke the `ralplan` skill … as context"); the v2 `skill` tool's input is `{ id }` only, and a wrong first guess costs one host input-error retry. |
| Notices fall back to appended prompt text only on failure | Notices are `synthetic` messages, state-first; if `synthetic` itself rejects, the (marker-wrapped) notice is appended to the prompt text instead of being lost. |
| Notices land before the user's message | The host places a `synthetic` notice before the user message in the same turn; OMC/v1 appended it after. A host placement fact, not a design choice. |
| TUI line for inserted messages | The TUI hides a `synthetic` message that has no `description`. Every notice and continuation the plugin inserts carries a one-line description (for example `open-gajae: ralplan keyword notice added`, `open-gajae: ralplan continuation 1/30`) so the user sees each insertion; the full text reaches only the model, as in OMC. |
| TS-source packaging, no build step | Root `index.ts` and `package.json` `exports["."]` point at `./src/index.ts`. `dist/` and the build script are gone. |
| `variant` without `model` is a settings error | Rejected after the user+project merge, with a message naming the agent — stricter than the v2 host, which just drops the variant with a diagnostic. |
| Continuation runs on durable execution events | `session.execution.succeeded` replaces `session.idle`, which v2 does not publish. |
| Continuation waits on background subagents | Skipped while an owned `background: true` child session is still running, tracked via `parentID` and execution events (OMC/OMO parity; v1 had no equivalent). |
| Interrupt handling is reason-based | `user` and `shutdown` set a stop mark cleared only by the next real prompt; `inactivity`/`superseded` do not; a host-triggered resume after a background child completes is judged like any other `succeeded`, bounded by the breaker. |
| Per-location event filtering | A v2 plugin instance is created per location, but a shared server delivers every event to every instance; this plugin acts only on sessions whose location matches its own. New to v2, not an R-decision change. |
| The artifact guard blocks by input invalidation, not a throw | `execute.before` replaces a blocked call's input with `{}` so the host's own decode fails; `execute.after` then rewrites that error into model-facing guidance. The same mechanism carries the ralplan planning guard, the always-blocked `plans/ralplan/**` and `state/**` paths, and the ultragoal entry gate's refusal of a `skill` load. A Promise-hook throw would surface as a host defect instead. |
| The code-tool boundary is realpath containment, not a host ask | Resolves against the host's current location, follows symlinks, requires containment in the real project directory, and excludes `.env`/`.env.*`, replacing v1's per-call permission `ask`. |
| The LSP surface grew from four tools to seven | `lsp_goto_definition`, `lsp_hover`, and `lsp_diagnostics` were added to `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, and `lsp_servers`. |
| `@deep-interview` mentions get the magic notice too | OMC parity; v1 suppressed the notice on an explicit invocation. |
| `@ralplan` mentions get a notice too | The mention notice states that the skill is already attached. Like the keyword notice, it writes no ralplan state; the run starts at `ralplan start`. OMC notices an explicit invocation as well; the wording is a host addition. Added so users see every insertion. |
| The ralplan restore notice is removed | OMC's `[RALPLAN MODE RESTORED]` notice, its prompt-hook branch, and the `restored_at` record are gone. The seed wrote `started_at` and `restored_at` equal, so the notice never fired in the normal flow; GJC has no such notice, and compaction recovery (`<ralplan-compaction-context>`) covers lost context. A resumed session gets no ralplan notice; the ultragoal restore banner stays. |
| Install docs show only the directory plugin form | Some host docs show a file-path `plugins` example, but the v2 host actually skips a configured plugin path that is a file. |

## Deviations from GJC (ralplan)

Source: GJC v0.17.7, commit `5c5231418930673e42cc5d08ebe4376e03187533` (MIT). The ralplan skill, the three consensus role prompts, and `src/ralplan-runtime/` follow GJC's ralplan contract except where a row below says otherwise (AGENTS.md policy: source, deviation, reason, impact). GJC paths are relative to `gajae-code/packages/coding-agent/src/`, where `SKILL.md` means `defaults/gjc/skills/ralplan/SKILL.md`; OpenCode paths are relative to `opencode/packages/`. Decision IDs (`D-…`, `DR-…`, `R-…`) refer to the port's spec and plan (`.omc/specs/deep-interview-ralplan-gjc-stage-trail.md`, `.omc/plans/ralplan-gjc-stage-trail.md`). Rows keep their plan numbers, which the skill's and prompts' source sections cite; row 18 was withdrawn because the `stage` chip follows GJC (the row records the stage just written, and a locked state phase replaces it on display), and row 16 (the sidebar as a separate `tui-plugin/` directory registered in `cli.json`) was withdrawn with the sidebar (R-OD17); neither number is reused.

| # | Deviation | GJC source | Reason | Impact |
|---|---|---|---|---|
| 1 | CLI commands (`gjc ralplan`, `gjc state ralplan`) become `ralplan` tool ops; flags become inputs; exit codes 3 and 2 become a `PLANNING-STUCK` result and an error. | `gjc-runtime/ralplan-runtime.ts:2483-2496`, `gjc-runtime/state-runtime.ts` | OpenCode plugin host; no GJC CLI. | Verbs map 1:1. |
| 2 | The artifact body no longer travels in a bash environment variable: roles pass `content`; the primary passes `content` or an OS temp `path`. | `SKILL.md:44-51`, `gjc-runtime/restricted-role-agent-bash.ts`, `tools/bash.ts:1331-1351` | OpenCode's shell has no GJC `env` artifact feature. | No restricted role shell is needed; roles have no file-path input, as in GJC. |
| 3 | Storage root `.gjc/_session-<id>` becomes `.open-gajae/_session-<created>-<id>`. | `gjc-runtime/session-layout.ts:71-78` | Existing session-folder rule (`src/state.ts`). | Paths only. |
| 4 | Settings move from `.gjc/config.yml` to `open-gajae.jsonc` `ralplan.*` and are resolved once at plugin setup (DR-13), not on every write. | `SKILL.md:134-161`, `gjc-runtime/ralplan-runtime.ts:414-437` | Existing settings files and loader (`src/index.ts`). | Same keys, ranges, and project-over-user precedence; a change applies after a host restart. `source` names the winning file path as loaded, where GJC reports its canonical (realpath) path. |
| 5 | Role session-ID flags (`--planner-id` and so on) are replaced by automatic recording; one `resumable` input replaces the per-role `--*-resumable` flags. | `SKILL.md:201-209`, `gjc-runtime/ralplan-runtime.ts:1113-1208` | The host supplies `context.sessionID`. | No ID-passing mistakes. |
| 6 | No `autoresearch` auto-handoff target. | `gjc-runtime/ralplan-runtime.ts:103-112` | No autoresearch skill here. | `autoHandoff` is `off` or `ultragoal`. |
| 7 | No `--architect/--critic openai-code`. | `gjc-runtime/ralplan-runtime.ts:614-615` | Role models come from the `agents` settings. | The reviewer model cannot change per run. |
| 8 | No `workflowGate` marker on the approval question. | `SKILL.md:110` | OpenCode `question` has no such field (`core/src/tool/plugin/question.ts:23-25`) and no timed auto-select. | No remote workflow-gate event. |
| 9 | The HUD chips are written to the active row and snapshot but not drawn; the `stages` chip uses full stage words. | `skill-state/workflow-hud.ts:188-245`, `gjc-runtime/ledger-event-renderer.ts:156-166`, `modes/components/skill-hud/render.ts:43-64` | Host UI differs: the TUI sidebar is deferred (R-OD17); stage words are the maintainer's choice. | No ralplan progress display in the TUI. The `stages` chip shows fewer than six words when six would pass the 80-character chip-value limit, and never cuts a word. |
| 10 | OMC continuation is kept; it stops on a terminal phase, `PLANNING-STUCK`, or `active: false`. | GJC's own TUI session has no ralplan continuation; its Stop-hook check auto-continues only deep-interview (`session/agent-session.ts:21140-21168`). GJC's Codex native Stop hook instead blocks stopping while ralplan is active, including in `final` and `handoff`, until ralplan is demoted or cleared (`hooks/skill-state.ts:663-691,878-977`, `hooks/native-skill-hook.ts:385-395`). | Maintainer choice. | A stalled planning turn resumes automatically, bounded by the breaker. Unlike GJC's native Stop hook, continuation does not hold `final` or `handoff`: a model that writes `final` and ends its turn without the approval question goes idle. |
| 11 | The planning guard does not classify `shell` mutation commands. | `skill-state/workflow-mutation-guard.ts:1475-1610` | Cost and accuracy of command classification. | Edits made through `shell` during planning are held back by prompts only. |
| 12 | `repository_binding` is recorded best-effort and never enforced. | `gjc-runtime/ralplan-runtime.ts:905-978` | The plugin resolves paths itself. | Writes from another worktree are not refused. |
| 13 | `doctor` has no checksum or orphan-journal checks. | `gjc-runtime/state-runtime.ts:317,466-500` | No checksums or handoff journal. | Fewer checks. |
| 14 | Only ralplan writes an active-skill row. | `skill-state/active-state.ts` | The other skills need a redesign. | Mandatory follow-up. |
| 15 | Role prompts are GJC's, while the ultragoal reviewer brief stays OMC-based (OQ1). | `prompts/agents/*.md` | Maintainer decision: revise in stages. | Five known conflicts (see Mandatory follow-up development). |
| 17 | The state envelope has no GJC `receipt`, checksum, or `state_revision` and keeps the StateStore `_meta`; the active row's `source_state_revision`, the snapshot's `state_revision`, and GJC's revision and stale-skip logic are omitted (R-OD6). | `gjc-runtime/state-writer.ts:1003-1067`, `skill-state/workflow-state-contract.ts:23-40`; revisions `gjc-runtime/state-writer.ts:446-472,852-857,1354-1360`, `skill-state/active-state.ts:85,858,943` | Same as 13, plus the StateStore owner check; all ralplan writes go through one owner-session queue in one process, so writes cannot be reordered (several processes are a known limit). | Some state, row, and snapshot keys differ (outside the format-compatibility scope). `doctor`'s `stale_active_state` compares phase and active flags, not revisions, so it is unaffected. |
| 19 | `ralplan handoff` removes the ralplan active row (`clear` removes it too, as in GJC). | `skill-state/active-state.ts:868,969-1014` (GJC's handoff keeps an inactive caller row with `handoff_to`) | Spec AC14. | No active row remains after the handoff; the handoff target is recorded in the ralplan state (`handoff_to`) rather than in a row. |
| 20 | The compaction recovery text adds an `Intent Reconciliation:` line (DR-14) and is injected as one `<ralplan-compaction-context>` block with a one-line header, like the ultragoal compaction context. | `session/agent-session.ts:667-710` | Spec AC19; the host's compaction hook takes marker-wrapped system text. | Slightly longer recovery context. |
| 21 | Audit `owner` values are `open-gajae-runtime` and `open-gajae-hook`. | `gjc-runtime/state-writer.ts:517-532` | Host name. | Same fields, different values. |
| 22 | SKILL step 9's state write plus skill-tool handoff becomes one `ralplan handoff` op (DR-12). | `SKILL.md:118-124`, `tools/skill.ts:200-218` | GJC's own transition table refuses that state write from `final` (`gjc-runtime/workflow-manifest.ts:241-265`, `gjc-runtime/state-runtime.ts:1335-1341`). | The handoff is one op call. |
| 23 | The planning guard covers the whole owner-session lineage (DR-10). | `skill-state/workflow-mutation-guard.ts:325-351` | Roles are child sessions in the same host process. | The executor and other agents are blocked during planning too. |
| 24 | `ultragoal handoff(to="ralplan")` runs ralplan `start` in the same tool call: a new start state that keeps the existing `run_id` (task = the handoff reason, `handoff_from: "ultragoal"`), written as two sequential transactions without a journal (R-O1). | `gjc-runtime/state-runtime.ts:1739-1763` (field-preserving merge, journal `:1765,1847`) | OpenCode has no cross-skill CLI; maintainer decision. | Earlier role IDs and verdicts are not carried over; the run folder and budget are reused; a failure between the two steps leaves a partial handoff whose result says to call `ralplan start` or `ultragoal resume`. |
| 25 | The ralplan runtime writes ultragoal state on handoff, with no consumption marker (R-O2). | `gjc-runtime/state-runtime.ts:1739-1763`, `tools/skill.ts:200-218`, `skill-state/active-state.ts:886-898` | Counterpart of GJC's atomic handoff; maintainer accepted. | An exception to the ultragoal tool being ultragoal's only writer (it still goes through ultragoal's queue and validation). If the ultragoal write fails, ralplan is already `handoff` and the result says to call `ultragoal start`. |
| 26 | The OMC continuation counter lives in the hook-only `state/ralplan-continuation.json` (R-O3). | (none in GJC) | Keeps lifecycle fields out of the GJC state envelope. | One extra file; only breaker exhaustion shows in the state and audit log. |
| 27 | The ralplan skill and plugin messages use GJC's approval label; `skills/ultragoal/SKILL.md` still says "Execute via ultragoal" (R-O5). | `SKILL.md:112` | The ultragoal skill is unchanged in this round (OQ1). | The two skills' wording differs (known; mandatory follow-up). |
| 28 | The guard's "current skill" check is approximated by "ultragoal is running in the root session" (R-O7). | `skill-state/workflow-mutation-guard.ts:294-310` | Ultragoal writes no active row. | No planning-edit protection while ultragoal runs; always-blocked paths stay. |
| 29 | The ultragoal entry gate checks ralplan only while ultragoal is not running (R-O9). | `tools/skill.ts:192-220` | GJC's behavior preferred over the spec's AC16 wording; maintainer decision. | A running ultragoal's `create` or skill reload ignores ralplan. |
| 30 | The primary's `path` input is limited to OS temp roots (DR-11). | `SKILL.md:49` (an artifact path prepared outside `.gjc/`); the runtime accepts only a file inside the bound worktree (`gjc-runtime/ralplan-runtime.ts:2053-2070` → `gjc-runtime/repository-binding.ts:187-201`), or inside the invoking cwd when `--worktree-root` is given (`gjc-runtime/ralplan-runtime.ts:811-846`) | Spec D-W4. | A repository file cannot be passed as `path`; use `content`. |
| 31 | `start(run_id)` is an open-gajae addition (DR-19). | `gjc-runtime/ralplan-runtime.ts:2382-2391` (seed has no run ID), `:1565-1570` (`--write` only) | Spec D-T3. | `start` can pick a new run folder and budget. |
| 32 | The owner session comes from the session lineage, not from a `session_id` in the assignment (DR-1). | `prompts/agent-fragments/ralplan-persistence.md:2,7` | The host's `context.sessionID` lineage is trustworthy. | A role cannot write into another session's run; assignments need no `session_id`. |
| 33 | Role prompt host substitutions: the planner's "Ask only about …" becomes the headless rule; the architect's forkContext sentence and `report_finding` paragraph, and `irc`, are removed; `yield.result.data` becomes the final response; `{{restrictedBash}}` becomes a read-only `shell` sentence; frontmatter is removed. | `prompts/agents/{planner,architect,critic}.md`, `prompts/agent-fragments/restricted-bash.md` | OpenCode has no such tools or fields; roles cannot use `question`. | Wording only; each prompt's source section lists them. |
| 34 | The `ralplan handoff` op requires a terminal phase (DR-7). | `gjc-runtime/state-runtime.ts:1572-1640` (the verb checks no phase); the check lives in `tools/skill.ts:42-61,203-208` | The skill tool's chain guard is folded into the op (D-F12). | A direct handoff in the middle of planning is refused. |
| 35 | An unreadable active-row file (`state/active/ralplan.json`) stops an unforced `clear`, as in GJC, but `clear(force: true)` skips reading it and clears (R-OD16). | `gjc-runtime/state-runtime.ts:244-270,1425` → `readActiveEntries` (`gjc-runtime/state-writer.ts:425-431`), which throws before `--force` is consulted | The always-block keeps `state/**` out of reach of the edit tools, so the GJC behavior would leave no way to end the run short of deleting the file from `shell`. | A forced clear works even with a corrupt row file; unforced clears behave as in GJC. |
| 36 | Loading the ralplan skill writes no state; the run, and with it the planning guard and continuation, starts at `ralplan start` (or the first `write`). | `session/agent-session.ts:13582-13597` → `hooks/skill-state.ts:387-496,641` (`ensureWorkflowSkillActivationState` writes the mode state in phase `planner` with the repository binding, the active row, and the snapshot on `/skill:ralplan`, so GJC's mutation guard and Stop hook apply from the load) | Spec D-F13 and R-O6: hooks and keywords seed nothing, and `start` is the documented entry. Recorded after the 2026-09-29 review. | Between the skill load and `ralplan start`, planning edits are not blocked and a stalled turn is not continued; the skill's first instruction is to call `start`. |
| 37 | Chaining out of ralplan is guarded only toward ultragoal: the ultragoal entry gate (deviations 29, 34) and the refusal to load `ralplan` while ultragoal runs. Reloading `ralplan`, or loading another skill such as `deep-interview`, during a live planning phase is not refused. | `tools/skill.ts:170-176` (refuses chaining into the currently active skill), `:54-61,200-221` (`phasePermitsChain`: refuses any chain out of a live ralplan phase; from a terminal phase it runs `gjc state handoff` to whichever skill is loaded) | The port specified only the ralplan → ultragoal gate (spec C-4, D-F12). Recorded after the 2026-09-29 review. | During planning, such a load goes through and leaves the ralplan state as it is; the skill text, not a refusal, keeps the leader in the planning loop. |

### Accepted behavior differences

These differ from the port's spec or from earlier open-gajae decisions, and the maintainer accepted them; most keep GJC's behavior.

| Item | Behavior | Basis | Impact |
|---|---|---|---|
| Roles pass `content` only (spec D-W4, partly replaced) | A role's `path` input is refused; the OS temp `path` is for the primary only (R-O4). | GJC `gjc-runtime/ralplan-runtime.ts:852`, `SKILL.md:51` | No file-permission prompt for roles; large artifacts (tens to over a hundred KB) travel as inline tool arguments. |
| No seeding; `write` creates state (spec D-F13) | Hooks and keywords seed nothing and `start` is the documented entry; `write` creates the state and switches runs as in GJC (R-O6). | GJC `gjc-runtime/ralplan-runtime.ts:986-1059`; GJC does seed on skill load (deviation 36) | A run created by `write` may lack `mode`, `interactive`, and the repository binding. |
| One-mode rule partly lifted | Only `start` is refused while ultragoal runs; role and primary `write` calls are not (R-O6, R-AE1). | Maintainer decision (GJC as-is) | ralplan can become active during an ultragoal run; recover with `ralplan state(patch={"active": false})` or `ralplan clear`. |
| Guard off while ultragoal runs (spec D-F15 exception) | While ultragoal is running in the root session, the planning guard does not apply (R-O7). | Approximates GJC `skill-state/workflow-mutation-guard.ts:294-310` | An exception to AC18; always-blocked paths stay. |
| Gate ignores ralplan while ultragoal runs (spec AC16 exception) | While ultragoal is running, the entry gate does not read ralplan (R-O9). | GJC `tools/skill.ts:192-220` | A running ultragoal's `create` or skill reload never depends on ralplan state. |
| Terminal phases follow GJC (spec D-F14, AC16) | The terminal set is GJC's eight phases (`final`, `handoff`, `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`) instead of the spec's `final` and `handoff`; the guard releases only on GJC's six release phases (R-CE1). | GJC `tools/skill.ts:42`, `gjc-runtime/workflow-manifest.ts:154-160,229` | An active run in a terminal phase, such as the active `final` during the approval question, is not running: no continuation, and the entry gate hands off instead of refusing. |
| Old-format state | A state with an unknown phase (for example OMC's `current_phase: "ralplan"`) is unreadable: guard off, no continuation, gate passes, `doctor` reports `schema_violation`; there is no migration code (DR-21). | Spec D-T10 | Old sessions do not lock edits; delete their state by hand. |
| Guard release set (spec D-F15, clarified) | The guard releases only on `complete`, `completed`, `failed`, `cancelled`, `canceled`, and `inactive`; `final` and `handoff` keep blocking while active (R-O10). | GJC `skill-state/workflow-mutation-guard.ts:264-276`, `gjc-runtime/workflow-manifest.ts:154-160` | No change; corrects a wrong implication in an earlier review question. |
| Where `ralplan` is hidden (spec AC1) | Owned agents that may not use the tool have it hidden; host `build`/`general` and user-defined agents get only a run-time refusal (DR-22). | `core/src/plugin/agent.ts:84-100`; the `ultragoal` and `state_*` tools behave the same | The tool can appear in those agents' catalogs. |
| Stop here removes the active row (spec D-H6, part withdrawn) | The spec kept the ralplan display while the latest `final` awaited approval "including after Stop here". Stop here removes the active row as in GJC (R-OD10); during the approval question (active `final`) the row carries a `pending` chip. | GJC `skill-state/active-state.ts:849-866` | After Stop here the active row no longer shows that a plan awaits approval, so a future sidebar (follow-up item 6) cannot either; `pending-approval.md` is kept. |
| No revision numbers (spec D-T8) | The active row and snapshot carry no revision number (R-OD6, deviation 17). | All ralplan writes are sequential in one owner-session queue | Each carries one key fewer than D-T8 lists. |

## Mandatory follow-up development

These items are required future work, recorded here as policy; none of them is implemented yet.

1. **Active rows and tools for deep-interview and ultragoal.** Only ralplan writes an active row and the `skill-active-state.json` snapshot (deviation 14). deep-interview and ultragoal need their own active rows and a TUI progress display (item 6), and the tool and design rework that requires (spec D-D2, D-H3).
2. **Revise ultragoal the GJC way.** The consensus role prompts are now GJC's, but ultragoal's reviewer brief (`verificationBrief` in `src/ultragoal.ts`), `record_verdict` (`src/ultragoal-tool.ts`), and `skills/ultragoal/SKILL.md` stay OMC-based (OQ1, deviation 15). Revise ultragoal to consume each role's own verdict — Architect `CLEAR` with `APPROVE`, or Critic `OKAY`, maps to `approve`; everything else maps to `reject`, with an explicit mapping for `WATCH`, `COMMENT`, and `ITERATE` — and move test execution to an executor QA lane. The revision must resolve five known conflicts between the GJC role prompts and the ultragoal brief:
   1. **Verdict vocabulary:** the roles end with `CLEAR`/`WATCH`/`BLOCK` plus `APPROVE`/`COMMENT`/`REQUEST CHANGES`, or `OKAY`/`ITERATE`/`REJECT`; the brief asks for `VERDICT: approve | reject`.
   2. **Restricted shell vs "run tests":** the role prompts limit `shell` to read-only inspection; the brief tells the reviewer to run the relevant tests and builds.
   3. **Nine-section output vs "under 100 words":** the GJC architect's output has nine sections; the brief asks for a review summary under 100 words.
   4. **"Attempt N/3" vs ratchet pass numbers:** the brief counts attempts up to the reject ceiling; the GJC reviewers key their five-rule ratchet on `review pass N`.
   5. **Plan-only critic identity:** the GJC critic decides whether a plan is actionable before execution; ultragoal uses it for the final review of the implemented run.
3. **Align the approval label.** `skills/ultragoal/SKILL.md` still names ralplan's approval option **Execute via ultragoal**; change it to GJC's **Approve execution via ultragoal** (R-O5, deviation 27).
4. **Known limits (recorded, not scheduled).** Several OpenCode processes working on one worktree are not serialized against each other: the plugin queues writes only within one process, while GJC uses file locks.
5. **Case-insensitive always-blocked paths.** The always-blocked path checks (`.open-gajae/_session-*/state/**`, `plans/ralplan/**`, and the ultragoal files) compare paths case-sensitively, so on a case-insensitive file system (the macOS default) a differently cased path such as `.OPEN-GAJAE/…` escapes them when the planning guard does not apply. Normalize case in these checks (maintainer decision R-OD13).
6. **TUI progress sidebar (deferred, R-OD17).** The ralplan sidebar the spec planned (D-H3–D-H7) was built on the port branch `feat/ralplan-gjc-stage-trail` (`tui-plugin/`, commit `96e9176`, fixed in `eb85dde` and `0cbb491`) and removed before the merge. In the distributed OpenCode 2.0.15 binary (compiled with Bun 1.4.2) the host does not map a TUI plugin's bare imports (`solid-js`, `@opentui/solid`, `@opentui/core`, `@opencode/plugin/tui`) to its own instances: without local packages the plugin fails to load, and with them it loads separate copies, so creating an element throws `No renderer found` and nothing is drawn. OpenCode's own test expects that mapping (`tui/test/plugin-source.test.ts`, "shared runtime and ordinary package identities survive plugin generations"), but it runs uncompiled. A manual check on 2026-09-29 drew the block when the plugin took the host instances from the host's virtual modules `opentui:runtime-module:<specifier>` (`@opentui/core` 0.5.10 `runtime-plugin.js`, an internal naming scheme). Re-add the sidebar once the host maps plugin imports, or with that workaround recorded as a host-integration deviation. It reads local files, so a TUI attached to a remote server stays unsupported.

## Validation evidence and limits

The verification layers this port defines are: `bun run typecheck` and `bun test` on `@opencode/plugin` 2.0.15; unit tests for the prompt hook, permission-rule generation, continuation, the artifact guard, the state/code tools, the `ralplan` tool and runtime (including key-set comparisons against GJC fixtures in `tests/fixtures/gjc-ralplan/`); host probes against a local OpenCode 2.0.15 binary (`tests/host-probe.ts`, `tests/host-session-probe.ts`, `tests/planner-permission-probe.ts`, `tests/package-probe.ts`, `tests/ralplan-trail-probe.ts`); and a manual checklist with `openai/gpt-6-luna` covering the deep-interview → ralplan bridge, keyword entry, an Esc interrupt during ralplan, planner delegation with and without `experimental.subagent_depth`, and one ralplan run through the stage files, Stop here, and the ultragoal start. Their current pass/fail status is tracked by the port's plan and ledger, not asserted by this document.

These layers are deterministic transport and source-contract checks using a fake provider where a host probe needs one; they are not actual-model behavior verification or proof of LLM obedience, prompt-branch guarantees, injection resistance, semantic model quality, external credentials, or installed language-server semantic correctness. Actual-model conversation checks for the GJC main prompt belong to the user, as specified in the GJC prompt plan's user-only checklist; they have not been performed here. LSP servers are never downloaded automatically. This guide records behavior and evidence scope; independent completion proof belongs in the durable delivery ledger.
