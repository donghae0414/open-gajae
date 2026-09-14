# Third-party notices

This package includes adapted material under different licenses. It is not offered as an unrestricted MIT-only package. Preserve this notice, the original license texts in `licenses/`, and modification notices when copying or distributing applicable material. No independent permissive exception for the selected OMO material is claimed.

| Source | Revision | Included/adapted material | Terms |
|---|---|---|---|
| oh-my-claudecode (OMC) | `5281b19e0d64f8e6dc6767f2130299a88af2dc71` | deep-interview prompt (topology, scoring, ontology); state snapshot/payload contract; explore prompt; operating principles | MIT, Copyright 2025 Yeachan Heo; full text `licenses/OMC-MIT.txt` |
| oh-my-codex (OMX) | `cb955b0d5becbef76d2c1f0096b6e1f238e1e7f7` | deep-interview fact/judgment, rhythm/probing/closure; explore prompt; operating guidance; atomic state pattern | MIT, Copyright 2026 Yeachan-Heo; full text `licenses/OMX-MIT.txt` |
| oh-my-openagent (OMO) | `d1557a4b48fdbec06a7144fdc4afa3e65c6523ed` | custom AgentConfig/model/permission registration pattern; selected Sisyphus task ownership and result integration guidance; post-idle Stop adapter reference | Sustainable Use License, full text `licenses/OMO-SUL.txt`; applicable third-party portions retain their own terms |
| OpenCode | `95daf90670b7c039c436c85537da5fbfe2205b41` | Host API/source reference (plugin/SDK 1.18.30), not copied host implementation | Dependency retains its distributed license |

Modifications: host-specific tool names and paths replaced with OpenCode native question/task and the three plugin tools; OMC and OMX prompt blocks combined; only owned primary/explore definitions retained; native defaults and user permissions preserved; unavailable specialists/CLI helpers and downstream workflows removed; no inherited provider/model fallback engine. OMC model snapshots replace rather than merge; runtime event records remain host-owned. The post-idle adapter is not equivalent to a pre-stop blocking hook.

OMO's Sustainable Use License limits use/distribution, including the conditions for internal business/personal/non-commercial use and non-commercial free distribution. The user accepted applicable conditions for the selected reuse. Reassess applicable conditions when distribution purpose changes; this notice is not a legal guarantee or a relicensing grant. The package is private by default to avoid accidental publication.
