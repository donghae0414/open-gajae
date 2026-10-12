# Project Guide

## Project roles

- **open-gajae:** An independent OpenCode plugin. Its requirements, user experience, and maintainer decisions guide development; parity with a reference project is not a goal or constraint.
- **gjc — `gajae-code/`:** A reference for behavior, workflows, and agent-role contracts, and the recorded source of existing GJC-derived material. It is its own agent host, so adopted runtime, CLI, and host-coupled mechanisms must be adapted to OpenCode.
- **omc — `oh-my-claudecode/`:** A Claude Code plugin, the Phase 1 baseline, and the recorded source of existing OMC-derived material. It remains available for selective reference.
- **OpenCode — `opencode/`:** The coding agent that hosts this plugin; its API, types, and source define the available extension points.
- **omo — `oh-my-openagent/`:** An OpenCode plugin reference for host integration, workflows, and agent design. It remains available for selective reference.

## Development phases

- **Phase 1 (closed 2026-09-27):** followed OMC v5.4.0 as the behavioral baseline, adapting Claude Code-specific integration to OpenCode's native APIs, tools, permissions, and lifecycle without modifying the host, with one exception: `prompts/open-gajae.md` was sourced from the pinned GJC system and project prompts. Closure was a maintainer decision, not the outcome of a formal completion check; the delivered Phase 1 scope is what the repository, its recorded deviations, and its tests contain.
- **Phase 2 (current):** the maintainer declared the initial porting goal complete on 2026-10-12. Development now follows open-gajae's own needs, with GJC, OMC, and OMO as optional references rather than a required order of preference. This is a development-policy decision, not a claim that every historical proposal or verification item is complete.
- Evaluate each change against this project's requirements and OpenCode's host contracts. Implement requested work and routine in-scope decisions without blanket design reconfirmation; ask about unresolved choices that change product direction or public contracts beyond the request.
- For adopted or changed third-party contracts, record the source project and exact commit, deviations, reasons, and behavioral impact in the affected skill or prompt's source section and `docs/development.md`. For original contracts, record the purpose, design rationale, and behavioral impact without inventing a third-party source or deviation. Preserve provenance and attribution for retained derived material.
- Source revisions recorded in `docs/development.md` and THIRD-PARTY-NOTICES.md identify existing adaptations. Research may use newer checkouts; record the exact inspected commit for any adopted behavior. Do not replace historical source pins merely because a checkout is newer; update an adaptation's pin deliberately when its source changes and record why.

## Reference boundaries

- This guide defines the development policy. Original and derived behavior may coexist; distinguish original decisions from third-party provenance. Existing mixed behavior is implementation history, not evidence of a recorded decision.
- Before relying on an implementation claim, inspect the relevant source directly in this project and, when citing a reference, in that repository. Actual source takes precedence over analysis documents; report discrepancies or unavailable evidence rather than assuming a document is correct. Identify the inspected revision and applicable OpenCode host version; use the recorded source revision when checking a historical adaptation.
- Distinguish development policy, current implementation behavior, and historical proposals in documentation. Do not describe an adaptation as complete before the implementation and tests are aligned.
- `prompts/*.md` and `skills/**/SKILL.md` are runtime contracts, not documentation-only cleanup targets. Change them together with affected validation and tests.
- Do not remove useful storage or safety mechanisms solely because of their source. Evaluate them against the adopted contract and host requirements. Preserve attribution and license notices for retained third-party material; a policy change does not change provenance.
- The reference repositories are study material, not implementation targets. Do not modify them unless explicitly requested.

## Releases

- A release is an annotated tag `vX.Y.Z` matching the `package.json` version. Pushing it runs `.github/workflows/release.yml`, which tests, publishes to npm, and creates the GitHub Release. Never run `npm publish` locally.
- The tag message becomes the release notes.
- "Push" means commits only. Create and push a tag only when the maintainer asks for a release; a pushed tag publishes at once.
