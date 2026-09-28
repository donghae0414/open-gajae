# Third-party notices

open-gajae is independent of the projects below. Attribution does not imply affiliation, endorsement, or official compatibility. Original contributions and third-party exceptions are described in [LICENSE](LICENSE).

Retain this notice, applicable source notices, and the license texts in [licenses/](licenses/) when redistributing included material. This is not an MIT-only distribution.

## Sources and licenses

| Source | Referenced or adapted material in open-gajae | Original terms |
|---|---|---|
| [oh-my-claudecode (OMC)](https://github.com/Yeachan-Heo/oh-my-claudecode) | OMC-derived roles and retained workflow guidance in `prompts/`, `skills/`; state and keyword/continuation logic; `ultragoal` goal tracking and reviews; AST/LSP tools and JSONC utilities in `src/`. | [MIT](licenses/OMC-MIT.txt), Copyright (c) 2025 Yeachan Heo |
| [oh-my-openagent (OMO)](https://github.com/code-yeongyu/oh-my-openagent) | Agent/model/permission integration in `src/config.ts`; continuation, in-flight and session-lineage patterns in `src/hooks.ts`; reviewer integration in `src/ultragoal-hooks.ts` and related portions of `src/ultragoal.ts` and `skills/ultragoal/SKILL.md`; the ralplan sidebar's view tree, materialization and polling pattern in `tui-plugin/`. | [Sustainable Use License](licenses/OMO-SUL.txt); incorporated third-party portions retain their original terms. |
| [gajae-code (GJC)](https://github.com/Yeachan-Heo/gajae-code) | Main-agent prompt in `prompts/open-gajae.md`; the ralplan skill in `skills/ralplan/SKILL.md`, the consensus role prompts in `prompts/open-gajae-planner.md`, `prompts/open-gajae-architect.md` and `prompts/open-gajae-critic.md`, the ralplan runtime in `src/ralplan-runtime/*`, and the shape fixtures in `tests/fixtures/gjc-ralplan/*`; the ralplan planning guard, always-blocked paths, continuation stop set, compaction recovery and ultragoal entry gate in related portions of `src/hooks.ts`, `src/artifact-guard.ts`, `src/ralplan.ts`, `src/ultragoal.ts`, `src/ultragoal-hooks.ts` and `src/ultragoal-tool.ts`; session-directory and ambiguous-match patterns in `src/state.ts`; handoff/resume, leader-recorded verdicts and evidence thresholds in `src/ultragoal.ts` and `src/ultragoal-tool.ts`. | [MIT](licenses/GJC-MIT.txt), Copyright (c) 2025-2026 Yeachan-Heo and Gajae Code Contributors |
| [OpenCode](https://github.com/anomalyco/opencode) | Desktop icon used as a visual reference for `assets/branding/open-gajae-banner.png`; [banner provenance](assets/branding/open-gajae-banner.md). Also the host/API reference; no copied host implementation. | [MIT](licenses/OpenCode-MIT.txt), Copyright (c) 2025 opencode |

Revisions checked against local references:

- OMC v5.4.0: `5281b19e0d64f8e6dc6767f2130299a88af2dc71` (behavioral baseline).
- OMO: `d1557a4b48fdbec06a7144fdc4afa3e65c6523ed`.
- GJC v0.17.7: `5c5231418930673e42cc5d08ebe4376e03187533` (local `gajae-code/` reference checkout; the main-agent prompt sources are identical at v0.17.2 `07f59defbc691064a126d72e391e46ccd331f970`, where the prompt was first derived).
- OpenCode v2.0.15: `6f3639d82ed0760091792189b78f8eeb44f699b1`.

These pins identify the sources checked for this notice; they do not reconstruct the exact historical introduction of every adaptation.

## Modifications and scope

**Third-party material has been modified for open-gajae.** Skills, roles, state and lifecycle handling are adapted to OpenCode v2; OMC's ralph becomes `ultragoal`. OMO integration patterns are adapted to this plugin's roles and review flow, with reviewer briefs assembled by a local adapter. File-level source notes describe other adaptations.

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
and in the README's "Deviations from GJC (ralplan)". The fixtures in
`tests/fixtures/gjc-ralplan/` hold ledger rows, file names, receipts and one
disposition document from GJC ralplan runs and tests, with absolute paths
replaced and no stage bodies. The deep-interview and ultragoal
skills, the other role prompts, and ultragoal's reviewer brief and approval
boundaries remain on their own OMC-derived contracts; this is not a full GJC
port.

The OMO entry applies to the referenced/adapted portions of mixed-source files, not all content in those files. Its Sustainable Use License limits use and modification to internal business, non-commercial or personal purposes, and distribution to free-of-charge, non-commercial purposes. Preserve its terms and modification notices; no commercial-distribution exception is claimed.

Installed package dependencies retain their own licenses and are not vendored in this repository's source package. Attribution and copyright licensing do not grant trademark endorsement or official compatibility.
