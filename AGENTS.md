# Project Guide

## Project roles

- **open-gajae:** The implementation target: an OpenCode plugin. Phase 1 built it against OMC's behavioral contracts; Phase 2 improves it at the maintainer's discretion, with gajae-code as the primary reference.
- **gjc — `gajae-code/`:** The primary reference for Phase 2 behavior, workflows, and agent-role contracts. It is its own agent host, so its runtime, CLI, and host-coupled mechanisms are adapted to OpenCode, never copied as-is.
- **omc — `oh-my-claudecode/`:** A Claude Code plugin and the Phase 1 baseline. In Phase 2 it is a secondary reference and the recorded provenance of the existing OMC-derived skills and roles.
- **OpenCode — `opencode/`:** The coding agent that hosts this plugin; its API, types, and source define the available extension points.
- **omo — `oh-my-openagent/`:** An OpenCode implementation reference for host integration only, not an independent source of product philosophy or agent-role policy.

## Development phases

- **Phase 1 (closed 2026-09-27):** followed OMC v5.4.0 as the behavioral baseline, adapting Claude Code-specific integration to OpenCode's native APIs, tools, permissions, and lifecycle without modifying the host, with one exception: `prompts/open-gajae.md` was sourced from the pinned GJC system and project prompts. Closure was a maintainer decision, not the outcome of a formal completion check; the delivered Phase 1 scope is what the repository, its recorded deviations, and its tests contain.
- **Phase 2 (current):** improvements are the maintainer's call, decided feature by feature. OMC parity is no longer a goal or a constraint. gajae-code at its pinned commit is the primary reference for new or changed behavior; OMC and OMO remain secondary references. Do not assume wholesale adoption of any project; evaluate each change on its own and confirm design decisions with the maintainer before implementing them.
- For every adopted or changed contract, record its source (project and pinned commit), each deviation from that source, the reason, and the behavioral impact, in the affected skill or prompt's source section and in the README deviations record. Existing OMC-derived contracts keep their recorded provenance until they are changed.
- Pinned reference revisions are recorded in README.md and THIRD-PARTY-NOTICES.md. Update a pin deliberately and record the change; do not verify against an unpinned checkout.

## Reference boundaries

- This guide defines the development policy. Mixed provenance is expected in Phase 2 and acceptable only while every piece records its source. Existing mixed behavior is implementation history, not evidence of a recorded decision.
- Before relying on an implementation claim, inspect the relevant source directly in this project and the local reference repositories. Actual source takes precedence over analysis documents; report discrepancies or unavailable evidence rather than assuming a document is correct. Verify the inspected revision against the pinned reference revisions and the applicable OpenCode host version.
- Distinguish development policy, current implementation behavior, and historical proposals in documentation. Do not describe an adaptation as complete before the implementation and tests are aligned.
- `prompts/*.md` and `skills/**/SKILL.md` are runtime contracts, not documentation-only cleanup targets. Change them together with affected validation and tests.
- Do not remove useful storage or safety mechanisms solely because of their source. Evaluate them against the adopted contract and host requirements. Preserve attribution and license notices for retained third-party material; a policy change does not change provenance.
- The reference repositories are study material, not implementation targets. Do not modify them unless explicitly requested.
