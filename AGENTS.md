# Project Guide

## Project roles

- **open-gajae:** The implementation target: an OpenCode plugin built against OMC's philosophy and behavioral contracts in Phase 1.
- **omc — `oh-my-claudecode/`:** A Claude Code plugin and the Phase 1 baseline for functionality, workflows, and agent-role contracts.
- **OpenCode — `opencode/`:** The coding agent that hosts this plugin; its API, types, and source define the available extension points.
- **omo — `oh-my-openagent/`:** An OpenCode implementation reference for host integration only, not an independent source of product philosophy or agent-role policy.

## Development phases

- Phase 1 follows OMC as its behavioral baseline. Adapt Claude Code-specific integration to OpenCode's native APIs, tools, permissions, and lifecycle without modifying the host.
- Primary-prompt exception: use the pinned GJC system and project prompts as the source for `prompts/open-gajae.md` only, adapting host-dependent instructions to OpenCode. OMC remains the baseline for existing skills, subagent roles, and other Phase 1 contracts; this exception is not a full GJC port.
- Record each host-required deviation from OMC, its reason, and its behavioral impact. Do not silently fill gaps with policy from other projects.
- Before implementation alignment, define the Phase 1 feature scope, pin the OMC baseline commit, and specify completion checks. The current product contains deep-interview, ralplan, owned primary/explore roles, and the `open-gajae-planner`/`open-gajae-architect`/`open-gajae-critic` consensus roles; this does not imply a full OMC port or settle the Phase 1 scope.
- Begin Phase 2 only after the agreed Phase 1 completion checks pass. Evaluate any future improvements individually against the completed OMC baseline; do not assume wholesale adoption of another project.

## Reference boundaries

- This guide defines the development policy. Existing mixed behavior is implementation history, not permission to continue mixing contracts in Phase 1.
- Before relying on an implementation claim, inspect the relevant source directly in this project and the local reference repositories within the phase boundaries above. Actual source takes precedence over analysis documents; report discrepancies or unavailable evidence rather than assuming a document is correct. Verify the inspected revision against the pinned OMC baseline and the applicable OpenCode host version.
- Distinguish development policy, current implementation behavior, and historical proposals in documentation. Do not describe OMC alignment as complete before the implementation and tests are aligned.
- `prompts/*.md` and `skills/**/SKILL.md` are runtime contracts, not documentation-only cleanup targets. Change them together with affected validation and tests during implementation alignment.
- Do not remove useful storage or safety mechanisms solely because of their source. Evaluate them against the OMC contract and host requirements. Preserve attribution and license notices for retained third-party material; a policy change does not change provenance.
- The reference repositories are study material, not implementation targets. Do not modify them unless explicitly requested.
