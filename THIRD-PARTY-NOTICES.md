# Third-party notices

This package includes adapted material under different licenses. It is not offered as an unrestricted MIT-only package. Preserve this notice, the original license texts in `licenses/`, and applicable modification notices when copying or distributing material. No independent permissive exception is claimed for selected OMO-derived material.

| Source | Revision | Retained/adapted material | Terms |
|---|---|---|---|
| oh-my-claudecode (OMC) | `5281b19e0d64f8e6dc6767f2130299a88af2dc71` (v5.4.0 baseline) | deep-interview skill/prompt structure and scoring/ontology/challenge material; state snapshot/payload boundary; explorer and document-specialist role material; read-only AST/LSP tool and server-catalogue adaptations | MIT, Copyright 2025 Yeachan Heo; full text: `licenses/OMC-MIT.txt` |
| oh-my-codex (OMX) | `cb955b0d5becbef76d2c1f0096b6e1f238e1e7f7` | retained historical analysis and any remaining derived attribution/material from earlier comparison work | MIT, Copyright 2026 Yeachan-Heo; full text: `licenses/OMX-MIT.txt` |
| oh-my-openagent (OMO) | `d1557a4b48fdbec06a7144fdc4afa3e65c6523ed` | selected custom AgentConfig/model/permission registration pattern and retained agent guidance lineage | Sustainable Use License, full text: `licenses/OMO-SUL.txt`; applicable third-party portions retain their own terms |
| OpenCode | SDK dependency 1.18.30; host probe observed 1.18.31 | host API/source reference and native tool/permission/lifecycle integration; no copied host implementation | Dependency retains its distributed license |

Modifications: Claude-specific entry points are replaced with OpenCode native skill, question, task, Read/Write, permissions, and plugin tools. The product is limited to deep-interview, the three owned roles, current-session state tools, native session document paths, optional advisory company context, and a finite read-only AST/LSP surface. State is a current trusted-session JSON snapshot using a same-process target queue and temporary-file rename; it is not the OMC SQLite/IPC/liveness/recovery design. Native document Write is outside that queue and uses same-slug overwrite without a receipt, suffix, index, or transaction guarantee.

OMX rhythm, mandatory pressure, four-closure enforcement, and downstream workflow functionality are not retained as runtime product behavior. OMX attribution remains for actual retained derived historical analysis/material; removal of functionality does not erase provenance. OMO boulder/registry, fallback policy, and full storage/lock/receipt systems are not included. The GJC session-directory pattern is referenced for path layout only; GJC code is not copied wholesale.

The former SQLite host-load investigation is historical evidence only. The current package claims no SQLite dependency, SQL backend, or SQLite probe. LSP servers are not downloaded automatically; their internal filesystem reads are not represented as a per-file sandbox. The document specialist's documented `chub` protocol is read-only and does not grant arbitrary bash.

OMO's Sustainable Use License limits use/distribution, including its conditions for internal business/personal/non-commercial use and non-commercial free distribution. The user accepted applicable conditions for the selected reuse. Reassess applicable conditions when distribution purpose changes; this notice is not a legal guarantee or relicensing grant. The package is private by default to avoid accidental publication.
