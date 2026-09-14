[English](README.md) | [한국어](README.ko.md)

# open-gajae

An OpenCode plugin combining OMC/OMX deep-interview contracts with an owned primary and read-only exploration role. OpenCode is the host, not an implementation target. OMC and OMX are equal sources; repository-local OMO supplies selected adapter/agent patterns.

## Build and local registration

Requires Bun and OpenCode compatible with the pinned plugin/SDK **1.18.30**.

```sh
bun install
bun run typecheck
bun test tests/state.test.ts tests/integration.test.ts
bun run build
```

Keep `dist/`, `skills/`, `prompts/`, `licenses/`, and `THIRD-PARTY-NOTICES.md` together. The built entry resolves assets relative to the package root. A lone copied `index.js` is not an installation.

After explicitly approving a local configuration change, back up the existing OpenCode JSONC file and edit only its plugin registration, preserving every other field/plugin:

```jsonc
{ "plugin": ["file:///Users/dongwuk/apps/open-gajae/dist/index.js"] }
```

This is an entry example, not an instruction to replace the whole config. A prior local URI used `apps/opengajae` (missing hyphen); replace that entry only after the new bundle exists. On failure restore the original config (and any dedicated settings changed) and restart OpenCode. This repository does not automatically edit your host configuration.

```sh
opencode debug skill
opencode debug agent open-gajae
opencode debug agent open-gajae-explore
opencode --model openai/gpt-5.6-luna
opencode --model openai/gpt-5.6-terra
```

Check the skill's actual source and `/deep-interview` exposure in the UI. Conflicting explicit commands/owned agent definitions and duplicate names in configured skill paths are rejected. Also inspect host-discovered/global/remote skill sources: the plugin does not replace the host discovery engine. Choose the primary in the UI; the default agent is not changed.

## Usage

- `/deep-interview <idea>`: start a session-bound requirements interview.
- `/deep-interview resume`: reconcile existing state before resuming; unresolved/cancelled work requires explicit confirmation, never silent resurrection.
- `/deep-interview cancel`: record cancellation and stop automatic continuation.
- The same explicit command works from build/plan without changing their agent definitions.

The native question tool presents one question at a time. OMC topology/weighted scoring/ontology combines with OMX same-topic probing, Fact/Judgment labels, rhythm and closure. `[from-code][auto-confirmed]`, `[from-code]`, `[from-research]`, and `[from-user]` are transcript/spec labels, not runtime question `source` values. Descriptive high-confidence facts do not create user rounds; scope/tradeoff decisions remain user-owned.

`state_read`, `state_write`, and `deep_interview_spec` are the only public plugin tools. Model state is a replacement snapshot; explicit fields win and host `_runtime`/`_meta` cannot be submitted. State lives under `.open-gajae/state/sessions/<session>/`; specs under `.open-gajae/specs/<session>/<interview>.md`. Keep these local artifacts private. A saved spec does not authorize implementation or invoke nonexistent downstream workflows.

## Owned agents and settings

Settings files: `~/.open-gajae/open-gajae.jsonc` and `<project>/.open-gajae/open-gajae.jsonc`. Per-field precedence is project → user → defaults. Invalid JSONC/unknown keys/types fail with file/key diagnostics rather than silently falling back.

```jsonc
{
  "deepInterview": { "ambiguityThreshold": 0.20, "maxRounds": 20 },
  "agents": {
    "open-gajae": { "model": "openai/gpt-5.6-luna" },
    "open-gajae-explore": { "model": "openai/gpt-5.6-terra" }
  }
}
```

The model allocation is an example, not a default or performance recommendation. Each owned role also accepts an optional `variant`. Missing model/variant properties remain omitted so native current/parent behavior applies. Runtime TUI selection is respected; no per-call normalization, model fallback engine, or semantic variant validator is installed. Native behavior can omit an unavailable configured variant instead of reporting an error. Observe that behavior rather than assuming the setting was enforced.

`open-gajae` handles general work directly and delegates repository facts only to `open-gajae-explore`. The latter has its own OMC/OMX-derived prompt; it is not an alias of built-in explore. Built-in build/plan/explore/general settings, user permissions, and default agent are unchanged. The leaf adds only seven denials (edit/bash/task/external_directory/question/state_write/deep_interview_spec), never late read/task allows that loosen user restrictions. Inaccessible evidence is reported, not bypassed.

## Limits and verification

- Interview implementation prohibition is an instruction plus existing host permissions, not a universal product-file guard, descendant isolation engine, or OS sandbox. Unknown MCP tools are not universally isolated.
- The seven leaf denies are contributed agent rules, not final host policy. OpenCode adds tool-output-directory access and composes parent session `external_directory` rules afterward; those host exceptions can allow external reads. The explorer's repo-local prompt remains binding guidance, not a plugin-enforced final-directory sandbox.
- Before slash lifecycle mutation, the hook checks the public command's observed `source: skill` and bundled base directory. MCP/foreign skill shadowing fails closed. This detects ownership, not arbitrary malicious template forgery, and cannot undo command-template shell work that the host executes before the hook.
- Stop continuation runs **after idle**, not before termination. It uses durable state and actual tool/assistant evidence; waiting, interrupted, cancelled, completed, errored or uncertain states must not auto-resume.
- Same-process session mutations serialize and use atomic rename. Multiple plugin processes writing the same session concurrently are unsupported. Do not run concurrent writers against those files.
- Confirmed recovery after a saved partial spec retains the interview ID and the original artifact, using a new `-rN.md` receipt path rather than overwriting it.
- Custom state has the original 1 MiB UTF-8 / depth 10 / 100 top-level-key bounds. These are not whole-runtime/spec resource quotas.
- Package tests/fixtures do not prove live model behavior. M0: registration/assets/collision/rollback; M1: interview/topology/labels/ontology/normal or capped spec; M2: pending/dismissal/Stop/cancel/restart/resume; M3: owned exploration/model inheritance/explicit model/TUI/denied permissions. Run M0–M3 with ordinary luna and terra and record results separately from automated checks. Authentication and live host inference are not implied by a model appearing in the list.

FOLLOWUP-01: add real downstream handoff only when those skills exist. FOLLOWUP-02: future specialists require matching primary routing, model settings, permissions and verification updates; the first owned explorer is already in scope.

See [porting analysis](docs/analysis/opencode-porting-guide.md) and [third-party notices](THIRD-PARTY-NOTICES.md). OMC/OMX MIT and OMO Sustainable Use License conditions are preserved; this is not an unrestricted MIT-only distribution. Reassess terms when distribution purpose changes.
