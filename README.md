[English](README.md) | [한국어](README.ko.md)

<div align="center">

# open-gajae

**An OpenCode plugin that takes coding work from a vague idea to verified changes.**

`deep-interview` clarifies · `ralplan` plans · `ultragoal` executes

<img src="assets/branding/open-gajae-banner.png" width="980" alt="open-gajae — Clarify. Plan. Execute.">

<sub><a href="#quick-start">Quick start</a> · <a href="#workflow-clarify--plan--execute">Workflow</a> · <a href="#configuration">Configuration</a> · <a href="#documentation">Documentation</a></sub>

</div>

> [!WARNING]
> open-gajae is an unofficial personal project, built largely with AI for learning and experimentation: much of it is AI slop. Performance issues, bugs, and missing features will be fixed over time.

## Background

I really enjoy using [gajae-code](https://github.com/Yeachan-Heo/gajae-code) and [oh-my-claudecode (OMC)](https://github.com/Yeachan-Heo/oh-my-claudecode). (This project was built with those two harnesses, too.) Unfortunately, company policy currently limits me to OpenCode, so I made my own version that works in a similar way in OpenCode. I learned how to build OpenCode plugins mostly by reading the code of [oh-my-openagent (OMO)](https://github.com/code-yeongyu/oh-my-openagent).

Thanks to everyone who made these great projects.

open-gajae is a personal project with no affiliation to the projects above. It is not an official port, and its features and behavior may differ.

## Quick start

```sh
# 1) Install (Bun or Node.js)
bunx open-gajae install     # or: npx open-gajae install

# 2) Restart OpenCode when the output says so; OpenCode then fetches open-gajae from npm.

# 3) In a new session, try:
#    @deep-interview I want to add rate limiting to our API
```

**Requires OpenCode v2 (built on 2.0.15; v1 is not supported).** If you kept another `default_agent`, switch to the `open-gajae` agent before step 3.

| Install sets | Value | If you already have one |
|---|---|---|
| `plugins` | adds `"open-gajae"` | kept |
| `default_agent` | `"open-gajae"` | kept |
| `experimental.subagent_depth` | `2` | kept; a value below 2 gets a notice |
| `~/.open-gajae/open-gajae.jsonc` | a template with every setting commented out | left untouched |

- **Which file:** `opencode.jsonc` in OpenCode's global config folder (`OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`), or `opencode.json` when there is no `opencode.jsonc`. With neither, it creates `opencode.jsonc`; with both, it edits only `opencode.jsonc` and prints a warning.
- **Safety:** an existing file is backed up as `<file>.bak-<YYYYMMDD-HHMMSS>` before it changes. Invalid JSON or JSONC stops the command before anything is written, and rerunning it changes nothing.

### Manual setup

Add these keys to `opencode.json` or `opencode.jsonc` in the global config folder, keeping the rest of the file:

```json
{
  "plugins": ["open-gajae"],
  "default_agent": "open-gajae",
  "experimental": {
    "subagent_depth": 2
  }
}
```

| Key | Why |
|---|---|
| `plugins` | Loads open-gajae. If the list already exists, append `"open-gajae"` to it. |
| `default_agent` | The skills run only in the `open-gajae` agent; this makes it the agent for new sessions. |
| `experimental.subagent_depth` | OpenCode's default of 1 lets only the main agent start subagents; 2 lets the planner and the executor hand work to other roles. |

If both files exist, OpenCode combines their `plugins` lists and takes `default_agent` and `experimental` from `opencode.jsonc`.

### Uninstall

There is no uninstall command. In the global config, in both files if both exist:

1. Remove `"open-gajae"` from `plugins`, and from the older `plugin` key if you used it.
2. Remove `default_agent` if it is `"open-gajae"`.
3. Keep or remove `experimental.subagent_depth` as you see fit; other agents or plugins may rely on it.
4. Optionally, delete `~/.open-gajae/open-gajae.jsonc`.

Then restart OpenCode. A project's `.open-gajae/` folder, which holds its session records and settings, is not affected.

## Workflow: Clarify → Plan → Execute

The skills run in the main `open-gajae` agent, which delegates to eight subagent roles (see the role table under Configuration). Each session's workflow records, such as specs, plans, and goals, are saved under `.open-gajae/` in your project.

Each skill can run on its own; deep-interview and ralplan offer to hand their result to the next skill when they finish. Start a skill in the `open-gajae` agent in either of two ways:

- Ask for it by name: `use ralplan to plan the API rate limiter`
- Mention it: type `@ralplan` and pick it from the autocomplete list.

```text
your idea
    │
    ▼
deep-interview (Clarify)   one question at a time
    │  spec ready → you choose to refine it with ralplan
    ▼
ralplan (Plan)             planner, architect, critic
    │  plan pending approval → you approve execution via ultragoal
    ▼
ultragoal (Execute)        goal by goal, with reviews
    │
    ▼
verified changes
```

### deep-interview

deep-interview asks one question at a time and scores how ambiguous your request still is after each answer. Once the score is at or below the threshold (0.05 by default), it writes a spec and asks whether to refine it with ralplan, execute it with ultragoal, keep refining, or finish there.

Try: `@deep-interview I want to add rate limiting to our API`

[How deep-interview works](docs/skills/deep-interview/README.md) (Korean)

### ralplan

ralplan has a planner draft a plan, then an architect and a critic review it, and the plan is revised until both approve or the round limit is reached. Each stage is saved as a file. A plan both reviewers approved waits for your choice to refine it further, approve execution via ultragoal, or stop there, while a plan stopped by the round limit is kept for you to read and is never executed.

Try: `@ralplan plan rate limiting for the API`

[How ralplan works](docs/skills/ralplan/README.md) (Korean)

### ultragoal

ultragoal splits the work into goals with acceptance criteria and works through them one at a time. Each goal needs an architect review before it counts as complete, and the last goal also gets a cleanup, architecture, and QA review followed by a final critic check.

Try: `@ultragoal add rate limiting to the API`

[How ultragoal works](docs/skills/ultragoal/README.md) (Korean)

## Configuration

open-gajae reads two optional settings files: `~/.open-gajae/open-gajae.jsonc` for all your projects, and `.open-gajae/open-gajae.jsonc` at a project's root. Project values override user values key by key, and anything left unset keeps its default. Both files are JSONC, so comments and trailing commas are allowed. Settings are checked strictly: a syntax error, an unknown key, or an invalid value is reported as an error, and open-gajae does not load until you fix it. open-gajae reads its settings once when it starts in a project, so restart OpenCode after editing them.

The template that `open-gajae install` creates lists every setting as a comment; to change a setting, remove the `//` in front of it. For example:

```json
{
  "deepInterview": { "ambiguityThreshold": 0.1 },
  "ralplan": { "maxIterations": 3 },
  "agents": {
    "open-gajae": { "model": "provider/model", "variant": "high" },
    "open-gajae-planner": { "model": "provider/model" }
  }
}
```

Replace `provider/model` with a model from one of your OpenCode providers, written as `provider/model`.

| Setting | Default | Allowed values | What it does |
|---|---|---|---|
| `deepInterview.ambiguityThreshold` | `0.05` | Greater than 0, at most 1 | deep-interview writes the spec once ambiguity is at or below this. A threshold you state in your request overrides it for that interview. |
| `ralplan.maxIterations` | `5` | Integer from 1 to 20 | The most planning rounds (a planner draft or a revision) one ralplan run may open. |
| `ralplan.maxReviewPassesPerLane` | `1` | Integer from 1 to 10 | How many reviews the architect and the critic may each write per round. |
| `ralplan.autoHandoff` | `"off"` | `"off"` or `"ultragoal"` | `"ultragoal"` hands a finished plan to ultragoal without asking for approval, unless the plan hit the round limit. |
| `agents.<role>.model`, `agents.<role>.variant` | None | `provider/model`; a variant the model supports | The model for a role. Without a `model`, OpenCode chooses one; a `variant` needs a `model` for the same role, set in either file. |

The roles, by agent name:

| Role | What it does | Edit tool |
|---|---|---|
| `open-gajae` | The main agent: works with you, runs the three skills, and delegates to the roles below. | Allowed |
| `open-gajae-explore` | Looks up files, symbols, and relationships in the repository. | Denied |
| `open-gajae-document-specialist` | Researches documentation and cites its sources. | Denied |
| `open-gajae-planner` | Drafts and revises ralplan's plan. | Denied |
| `open-gajae-architect` | Reviews plans in ralplan and each goal in ultragoal. | Denied |
| `open-gajae-critic` | Gives the final plan review in ralplan and the final check in ultragoal. | Denied |
| `open-gajae-executor` | Makes the code changes ultragoal hands it and runs ultragoal's QA review. | Allowed |
| `open-gajae-cleaner` | Reviews ultragoal's changed files for AI slop and other cleanup issues, and reports them without editing. | Denied |
| `open-gajae-lateral-reviewer` | Plays the reviewer personas of deep-interview's review panel. | Denied |

Every role except `open-gajae` runs as a subagent. Permission rules you set for these agents in OpenCode's config apply after open-gajae's and take precedence.

The read-only code tools search code by syntax with the bundled ast-grep library and look up symbols through language servers already installed on your machine; open-gajae never downloads a language server.

## Documentation

- Skill documentation (Korean): how [deep-interview](docs/skills/deep-interview/README.md), [ralplan](docs/skills/ralplan/README.md), and [ultragoal](docs/skills/ultragoal/README.md) work in the current code, step by step.
- [Development notes](docs/development.md) (Korean, for maintainers): scope and status, pinned reference versions, recorded differences from the reference projects, follow-up work, and verification.
- [Third-party notices](THIRD-PARTY-NOTICES.md): the third-party material open-gajae retains or adapts, and its licenses.
- [Banner credits](assets/branding/open-gajae-banner.md)

## License

- Own code: MIT
- Parts derived from oh-my-openagent (OMO): Sustainable Use License (free, non-commercial distribution only)
- Other third-party material: its original license

Details: [LICENSE](LICENSE) · [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
