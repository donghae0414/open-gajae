# Project Guide

## Project roles

- **open-gajae:** The implementation target: an OpenCode plugin that combines useful capabilities from omc and omx.
- **omc — `oh-my-claudecode/`:** A Claude Code plugin and a primary analysis source for skills such as deep-interview.
- **omx — `oh-my-codex/`:** A Codex plugin and an equally important primary analysis source for those skills.
- **OpenCode — `opencode/`:** The coding agent that hosts this plugin; its API, types, and source define the available extension points.
- **omo — `oh-my-openagent/`:** An existing OpenCode harness and plugin implementation to consult when implementation references are needed.

## Reference boundaries

- Analyze omc and omx together as peer sources. Identify the strengths and weaknesses of both and combine their useful approaches; neither is the default baseline or a secondary reference.
- Use `docs/analysis/` as existing analysis material, but revalidate any findings that conflict with the current source code.
- The reference repositories are study material, not implementation targets. Do not modify them unless explicitly requested.
