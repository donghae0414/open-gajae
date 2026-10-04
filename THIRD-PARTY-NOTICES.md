# Third-party notices

open-gajae is independent of the projects below. Attribution does not imply affiliation, endorsement, or official compatibility. Original contributions and third-party exceptions are described in [LICENSE](LICENSE).

Retain this notice, applicable source notices, and the license texts in [licenses/](licenses/) when redistributing included material. This is not an MIT-only distribution.

## Sources and licenses

| Source | Referenced or adapted material in open-gajae | Original terms |
|---|---|---|
| [oh-my-claudecode (OMC)](https://github.com/Yeachan-Heo/oh-my-claudecode) | OMC-derived roles and retained workflow guidance in `prompts/`, `skills/`; the state payload limits in `src/state.ts` and keyword/continuation logic; the `ultragoal` progress log format (`src/ultragoal-runtime/progress.ts`); AST/LSP tools and JSONC utilities in `src/`. | [MIT](licenses/OMC-MIT.txt), Copyright (c) 2025 Yeachan Heo |
| [oh-my-openagent (OMO)](https://github.com/code-yeongyu/oh-my-openagent) | Agent/model/permission integration in `src/config.ts`; continuation, in-flight, session-lineage and injection patterns in `src/hooks.ts`. | [Sustainable Use License](licenses/OMO-SUL.txt); incorporated third-party portions retain their original terms. |
| [gajae-code (GJC)](https://github.com/Yeachan-Heo/gajae-code) | Main-agent prompt in `prompts/open-gajae.md`; the ralplan skill in `skills/ralplan/SKILL.md`, the consensus role prompts in `prompts/open-gajae-planner.md`, `prompts/open-gajae-architect.md` and `prompts/open-gajae-critic.md`, the ralplan runtime in `src/ralplan-runtime/*`, and the shape fixtures in `tests/fixtures/gjc-ralplan/*`; the ultragoal skill in `skills/ultragoal/SKILL.md`, the cleaner prompt in `prompts/open-gajae-cleaner.md`, the ultragoal runtime in `src/ultragoal-runtime/*` (except the OMC progress log format in `progress.ts`), the goal tool, state and loop in `src/goal/*`, and the shared active-row, snapshot, audit, journal, handoff, HUD and doctor modules in `src/skill-state/*`; the deep-interview skill in `skills/deep-interview/SKILL.md`, the lateral-reviewer prompt in `prompts/open-gajae-lateral-reviewer.md` (the deep-interview panel fragment), and the deep-interview runtime in `src/deep-interview-runtime/*`; the planning, goal-planning and deep-interview guards, the deep-interview load gate and continuation, always-blocked paths, continuation stop set, `skill` turn gate and chain guard, and compaction recovery in related portions of `src/hooks.ts`, `src/artifact-guard.ts` and `src/ralplan.ts`; session-directory and ambiguous-match patterns in `src/state.ts`. The ultragoal and goal adaptation draws on these GJC files under `packages/coding-agent/src/`: `gjc-runtime/{ultragoal-runtime,ultragoal-guard,ultragoal-receipt-freshness,workflow-recovery-projection,state-runtime,state-writer,state-renderer,state-validation,workflow-manifest,goal-mode-request,cli-write-receipt,session-layout}.ts`; `goals/{runtime,state}.ts`, `goals/tools/goal-tool.ts`, `prompts/goals/{goal-mode-active,goal-continuation}.md`, `prompts/tools/goal.md`; `session/agent-session.ts` (the path-A continuation wrapper and the recovery rendering and rules); `hooks/skill-state.ts` (the skill-load seed); `skill-state/{active-state,workflow-hud,workflow-mutation-guard,initial-phase}.ts`, `tools/skill.ts`; `defaults/gjc/skills/ultragoal/{SKILL.md,ai-slop-cleaner.md}`; and `prompts/agents/executor.md` (the red-team fragment). The deep-interview adaptation draws on `gjc-runtime/{deep-interview-runtime,deep-interview-stage,deep-interview-state,deep-interview-ambiguity,state-runtime,state-renderer,workflow-manifest}.ts`; `skill-state/{initial-phase,workflow-hud,workflow-mutation-guard}.ts`, `tools/skill.ts`; `session/agent-session.ts` (the deep-interview continuation); and `defaults/gjc/skills/deep-interview/{SKILL.md,lateral-review-panel.md}`. | [MIT](licenses/GJC-MIT.txt), Copyright (c) 2025-2026 Yeachan-Heo and Gajae Code Contributors |
| [OpenCode](https://github.com/anomalyco/opencode) | Host/API reference; no copied host implementation. | [MIT](licenses/OpenCode-MIT.txt), Copyright (c) 2025 opencode |

Revisions checked against local references:

- OMC v5.4.0: `5281b19e0d64f8e6dc6767f2130299a88af2dc71` (behavioral baseline).
- OMO: `d1557a4b48fdbec06a7144fdc4afa3e65c6523ed`.
- GJC v0.17.7: `5c5231418930673e42cc5d08ebe4376e03187533` (local `gajae-code/` reference checkout; the main-agent prompt sources are identical at v0.17.2 `07f59defbc691064a126d72e391e46ccd331f970`, where the prompt was first derived).
- OpenCode v2.0.15: `6f3639d82ed0760091792189b78f8eeb44f699b1`.

These pins identify the sources checked for this notice; they do not reconstruct the exact historical introduction of every adaptation.

## Modifications and scope

**Third-party material has been modified for open-gajae.** Skills, roles, state and lifecycle handling are adapted to OpenCode v2. `ultragoal` and `goal` are rebuilt on GJC's ultragoal runtime and goal mode; of the earlier port of OMC's ralph only the progress log format remains. `deep-interview` is rebuilt on GJC's deep-interview skill and runtime, replacing the earlier OMC-derived skill and state tools. OMO integration patterns are adapted to this plugin's roles and hooks. The `execute.before` append of the `[ultragoal-red-team]` fragment to an executor assignment is a local adapter carrying GJC text, as the removed reviewer-brief append was. File-level source notes describe other adaptations.

The main-agent prompt alone derives from GJC's
`packages/coding-agent/src/prompts/system/system-prompt.md` and the three
`<critical>` instructions in
`packages/coding-agent/src/prompts/system/project-prompt.md` at the GJC pin above.
OpenCode substitutions group GJC's skill/routing, role and delegation names into
native `skill`, `question`, `subagent`, and `open-gajae-*` contracts; tool names
and capabilities follow the host's `grep`, `glob`, `shell`, read, LSP and AST
surfaces. Template controls are flattened where applicable; optional GJC-only
insertion slots and duplicated host project context are excluded. GJC-only tool
discovery, execution receipts, isolation and lifecycle APIs, and unsupported tools
or workflows are excluded because this host does not provide those contracts.
The ralplan skill, the planner, architect and critic prompts, and
`src/ralplan-runtime/` derive from GJC's
`packages/coding-agent/src/defaults/gjc/skills/ralplan/SKILL.md`,
`packages/coding-agent/src/prompts/agents/{planner,architect,critic}.md` with
`prompts/agent-fragments/ralplan-persistence.md`, and the ralplan, state and
active-skill runtime modules under `packages/coding-agent/src/gjc-runtime/` and
`packages/coding-agent/src/skill-state/` at the GJC pin above;
`src/ralplan-runtime/review-conflicts.ts` is copied verbatim apart from its
header. Host substitutions and deviations are listed in each file's source notes
and in `docs/development.md`'s "GJC로부터의 deviation (ralplan)". The fixtures in
`tests/fixtures/gjc-ralplan/` hold ledger rows, file names, receipts and one
disposition document from GJC ralplan runs and tests, with absolute paths
replaced and no stage bodies. The ultragoal skill, the cleaner prompt,
`src/ultragoal-runtime/` (except `progress.ts`), `src/goal/` and
`src/skill-state/` derive from GJC's
`packages/coding-agent/src/defaults/gjc/skills/ultragoal/SKILL.md` and
`ai-slop-cleaner.md`, the ultragoal, goal and state runtime modules, the goal
prompts and tool, and the executor red-team fragment listed in the GJC row
above, at the same pin; their host substitutions and deviations are listed in
each file's source notes and in `docs/development.md`'s
"GJC로부터의 deviation (ultragoal)".
The ultragoal skill keeps two sentences of the earlier OMC-derived skill, and
the cleaner prompt keeps its read-only sentences from the earlier OMC-based
cleaner prompt. The deep-interview skill, the lateral-reviewer prompt and
`src/deep-interview-runtime/` derive from GJC's
`packages/coding-agent/src/defaults/gjc/skills/deep-interview/SKILL.md` and
`lateral-review-panel.md` and the deep-interview, state and active-skill runtime
modules listed in the GJC row above, at the same pin; the lateral-reviewer
prompt is the panel fragment `lateral-review-panel.md`. Their host
substitutions and deviations are listed in each file's source notes and in
`docs/development.md`'s "GJC로부터의 deviation (deep-interview)". The explore,
document-specialist and executor role prompts remain on their own OMC-derived
contracts; this is not a full GJC port.

The OMO entry applies to the referenced/adapted portions of mixed-source files, not all content in those files. Its Sustainable Use License limits use and modification to internal business, non-commercial or personal purposes, and distribution to free-of-charge, non-commercial purposes. Preserve its terms and modification notices; no commercial-distribution exception is claimed.

Installed package dependencies retain their own licenses and are not vendored in this repository's source package. Attribution and copyright licensing do not grant trademark endorsement or official compatibility.
