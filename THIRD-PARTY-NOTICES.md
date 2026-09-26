# Third-party notices

open-gajae is independent of the projects below. Attribution does not imply affiliation, endorsement, or official compatibility. Original contributions and third-party exceptions are described in [LICENSE](LICENSE).

Retain this notice, applicable source notices, and the license texts in [licenses/](licenses/) when redistributing included material. This is not an MIT-only distribution.

## Sources and licenses

| Source | Referenced or adapted material in open-gajae | Original terms |
|---|---|---|
| [oh-my-claudecode (OMC)](https://github.com/Yeachan-Heo/oh-my-claudecode) | `prompts/`, `skills/`; state and keyword/continuation logic; `ultragoal` goal tracking and reviews; AST/LSP tools and JSONC utilities in `src/`. | [MIT](licenses/OMC-MIT.txt), Copyright (c) 2025 Yeachan Heo |
| [oh-my-openagent (OMO)](https://github.com/code-yeongyu/oh-my-openagent) | Agent/model/permission integration in `src/config.ts`; continuation, in-flight and session-lineage patterns in `src/hooks.ts`; reviewer integration in `src/ultragoal-hooks.ts` and related portions of `src/ultragoal.ts` and `skills/ultragoal/SKILL.md`. | [Sustainable Use License](licenses/OMO-SUL.txt); incorporated third-party portions retain their original terms. |
| [gajae-code (GJC)](https://github.com/Yeachan-Heo/gajae-code) | Session-directory and ambiguous-match patterns in `src/state.ts`; handoff/resume, leader-recorded verdicts and evidence thresholds in `src/ultragoal.ts` and `src/ultragoal-tool.ts`. | [MIT](licenses/GJC-MIT.txt), Copyright (c) 2025-2026 Yeachan-Heo and Gajae Code Contributors |
| [OpenCode](https://github.com/anomalyco/opencode) | Desktop icon used as a visual reference for `assets/branding/open-gajae-banner.png`; [banner provenance](assets/branding/open-gajae-banner.md). Also the host/API reference; no copied host implementation. | [MIT](licenses/OpenCode-MIT.txt), Copyright (c) 2025 opencode |

Revisions checked against local references:

- OMC v5.4.0: `5281b19e0d64f8e6dc6767f2130299a88af2dc71` (behavioral baseline).
- OMO: `d1557a4b48fdbec06a7144fdc4afa3e65c6523ed`.
- GJC v0.17.2: `07f59defbc691064a126d72e391e46ccd331f970` (user-identified reference checkout, verified 2026-09-27).
- OpenCode v2.0.15: `6f3639d82ed0760091792189b78f8eeb44f699b1`.

These pins identify the sources checked for this notice; they do not reconstruct the exact historical introduction of every adaptation.

## Modifications and scope

**Third-party material has been modified for open-gajae.** Skills, roles, state and lifecycle handling are adapted to OpenCode v2; OMC's ralph becomes `ultragoal`. OMO integration patterns are adapted to this plugin's roles and review flow, with reviewer briefs assembled by a local adapter. File-level source notes describe other adaptations.

The OMO entry applies to the referenced/adapted portions of mixed-source files, not all content in those files. Its Sustainable Use License limits use and modification to internal business, non-commercial or personal purposes, and distribution to free-of-charge, non-commercial purposes. Preserve its terms and modification notices; no commercial-distribution exception is claimed.

Installed package dependencies retain their own licenses and are not vendored in this repository's source package. Attribution and copyright licensing do not grant trademark endorsement or official compatibility.
