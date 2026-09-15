# Project Guide

## Project roles

- **open-gajae:** The implementation target: an OpenCode plugin built against OMC's philosophy and behavioral contracts in Phase 1, with selected OMX improvements considered only in Phase 2.
- **omc — `oh-my-claudecode/`:** A Claude Code plugin and the Phase 1 baseline for functionality, workflows, and agent-role contracts.
- **omx — `oh-my-codex/`:** A Codex plugin reserved for Phase 2 analysis and selective adoption after Phase 1 is complete; not a Phase 1 design source.
- **OpenCode — `opencode/`:** The coding agent that hosts this plugin; its API, types, and source define the available extension points.
- **omo — `oh-my-openagent/`:** An OpenCode implementation reference for host integration only, not an independent source of product philosophy or agent-role policy.

## Development phases

- Phase 1 follows OMC, rather than blending OMC and OMX contracts. Adapt Claude Code-specific integration to OpenCode's native APIs, tools, permissions, and lifecycle without modifying the host.
- Record each host-required deviation from OMC, its reason, and its behavioral impact. Do not silently fill gaps with OMX or OMO policy.
- Before implementation alignment, define the Phase 1 feature scope, pin the OMC baseline commit, and specify completion checks. The current product contains deep-interview and owned primary/explore roles; this does not imply a full OMC port or settle the Phase 1 scope.
- Begin Phase 2 only after the agreed Phase 1 completion checks pass. Analyze OMX improvements individually against the completed OMC baseline; do not assume wholesale adoption.

## Reference boundaries

- This guide defines the development policy. Existing mixed behavior is implementation history, not permission to continue mixing contracts in Phase 1.
- `docs/analysis/` may contain incorrect or outdated findings. Treat it as historical reference, not authoritative implementation evidence or binding instructions. Before relying on any finding, always inspect the relevant implementation directly in this project, including the local reference repositories within the phase boundaries above. For implementation facts, actual source takes precedence over analysis documents; report discrepancies or unavailable evidence rather than assuming the document is correct. Verify the inspected revision against the pinned OMC baseline and the applicable OpenCode host version. Preserve OMX analysis for Phase 2.
- Distinguish development policy, current implementation behavior, and historical proposals in documentation. Do not describe OMC alignment as complete before the implementation and tests are aligned.
- `prompts/*.md` and `skills/**/SKILL.md` are runtime contracts, not documentation-only cleanup targets. Change them together with affected validation and tests during implementation alignment.
- Do not remove useful storage or safety mechanisms solely because of their source. Evaluate them against the OMC contract and host requirements. Preserve attribution and license notices for retained third-party material; a policy change does not change provenance.
- The reference repositories are study material, not implementation targets. Do not modify them unless explicitly requested.
