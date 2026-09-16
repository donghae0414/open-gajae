[English](README.md) | [한국어](README.ko.md)

# open-gajae

An OpenCode plugin with a session-bound `deep-interview` skill, three owned roles, and a small read-only code-research surface. It adapts selected OMC v5.4.0 material; it is **not** a full OMC port and does not add downstream execution workflows.

## Scope and status

- The baseline is OMC v5.4.0, commit `5281b19e0d64f8e6dc6767f2130299a88af2dc71`. OMX is not a current behavior source.
- Implemented scope: `deep-interview`; `open-gajae`, `open-gajae-explore`, and `open-gajae-document-specialist`; session state; native document output; read-only AST/LSP tools; and optional advisory company context.
- Not provided: ralplan, ultragoal, autopilot, team, ralph, autoresearch, plan execution/bridges, shared session state, or automatic migration/recovery.
- This documentation describes the implemented contract; it does not establish Phase-1 completion.

See [AGENTS.md](AGENTS.md) for development policy, the [porting guide](docs/analysis/opencode-porting-guide.md) for decisions and evidence, and [third-party notices](THIRD-PARTY-NOTICES.md) for attribution.

## Build and local registration

The package uses `@opencode-ai/plugin` 1.18.30. Host probes used OpenCode 1.18.31; that observation is not a general compatibility guarantee.

```sh
bun install
bun run typecheck
bun run test
bun run build
bun run test:host
bun tests/host-session-probe.ts
bun tests/package-probe.ts
bun tests/company-context-probe.ts
```

Keep `dist/`, `skills/`, `prompts/`, `licenses/`, and `THIRD-PARTY-NOTICES.md` together. Rebuild and restart OpenCode after updating a deployed plugin.

After explicitly approving a local configuration change, preserve the existing OpenCode JSONC file and change only the relevant plugin entry:

```jsonc
{ "plugin": ["file:///Users/dongwuk/apps/open-gajae/dist/index.js"] }
```

This is not a replacement configuration. The plugin never edits host configuration. Inspect the installed surface with:

```sh
opencode debug skill
opencode debug agent open-gajae
opencode debug agent open-gajae-explore
opencode debug agent open-gajae-document-specialist
```

## Deep interview and storage

`/deep-interview <idea>` starts requirements clarification. It uses native `question` one question at a time. A denied or unavailable question tool is reported; prose fallback does not substitute for it. A completed spec is not authorization to implement it.

After reaching the ambiguity threshold and saving the spec, the skill asks whether to finish or refine further. Refinement preserves the current session and history, asks an additional requirements question before rechecking the threshold, and updates the same spec file. The choice itself does not consume a round. The cumulative `maxRounds`, explicit early exit, and cancellation still apply; tool failures are never treated as consent to finish. This is a prompt-level interaction contract, not a host-enforced state machine.

State tools are `state_read`, `state_write`, and `state_clear`. They use the trusted current `ToolContext.sessionID`; callers cannot select another session. The session ID is UTF-8 lowercase-hex encoded, and generated paths are:

```text
<worktree>/.open-gajae/
  _session-<encoded-session-id>/
    state/deep-interview-state.json
    specs/deep-interview-<slug>.md
    plans/<slug>.md
```

State writes replace the model snapshot; explicit tool fields win and `_meta` is regenerated. `state_clear` deletes only the current session's state JSON. It preserves session documents, other sessions, and legacy files. Invalid/corrupt state is surfaced and preserved rather than reset.

State operations for the same canonical file are serialized inside one plugin process and publish JSON with temporary-file rename. This is not IPC locking, a transaction across state and document saves, power-loss durability, or multi-process safety. Specs are saved outside that queue using native `write` when available, otherwise `apply_patch`. Further interview results update the same file, with no suffix, receipt, index, or automatic recovery.

A user may explicitly name another session's spec or plan as an input. Native Read and its normal permissions apply. The current session must report the path actually read; it must not scan for a latest document or substitute another file. Reading A from B transfers no state, owner, approval, or checkbox and does not authorize source edits or plan execution. B writes only its own state/documents.

## Owned roles and settings

- **`open-gajae`** is the primary. It owns edits, decisions, integration, and state write/clear.
- **`open-gajae-explore`** investigates repository facts read-only. It cannot edit, run bash, delegate, ask questions, or write/clear state.
- **`open-gajae-document-specialist`** researches documentation and citations. It cannot edit, delegate, ask questions, or write/clear state. Its documented `chub` protocol is read-only; it does not grant arbitrary bash.

Role-specific host permissions are retained. For the two read-only roles, the fixed deny rules are appended after host permission rules (including wildcards), so their mandatory denials cannot be loosened by ordering; all remaining permission evaluation stays native. Settings are read from `~/.open-gajae/open-gajae.jsonc` and `<worktree>/.open-gajae/open-gajae.jsonc`. Fields merge project → user → defaults; unknown keys, invalid JSONC, or invalid values fail with diagnostics. For every owned role, a valid host override takes precedence over project then user `model`/`variant`; omitted fields remain host-owned. There is no provider fallback, tier mapping, or artificial collision rejection.

```jsonc
{
  "deepInterview": { "ambiguityThreshold": 0.2, "maxRounds": 20 },
  "agents": {
    "open-gajae": { "model": "provider/model", "variant": "variant-name" }
  },
  "companyContext": { "tool": "company_context", "onError": "warn" }
}
```

`companyContext` is optional. When `tool` names a visible, permitted MCP tool, the primary prompt may call it with `{ "query": "…" }` before crystallizing a spec and treats `{ "context": "…" }` as advisory quoted material. It is no hook, proxy, registration mechanism, or guaranteed call. Unset skips it; `onError` is `warn` by default, or `silent`/`fail`.

## Read-only code tools

The plugin registers five read-only tools:

- `ast_grep_search` (`@ast-grep/napi` 0.31.1): AST search only; no replace.
- `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, and `lsp_servers`.

LSP servers are detected and reported, never downloaded. The product has no LSP rename, diagnostics, code-action, or replacement suite. LSP authorization covers the requested file/operation; it is not a sandbox over files a language server may read internally. The AST tool performs its own guarded traversal/read checks. Neither tool expands the explorer's permissions or grants arbitrary shell execution.

The only product environment knobs reached by source are `OPEN_GAJAE_LSP_TIMEOUT_MS`, `OPEN_GAJAE_LSP_IDLE_TIMEOUT_MS`, `OPEN_GAJAE_LSP_IDLE_CHECK_INTERVAL_MS`, `OPEN_GAJAE_LSP_CONTAINER_ID`, and `OPEN_GAJAE_PYTHON_LSP=basedpyright`. They are LSP implementation settings, not general configuration.

## Validation evidence and limits

Completed checks include typecheck, unit tests, and build, plus the stable commands above. `bun run test:host` exercises installed OpenCode 1.18.31 plugin load, state/AST/native Write, permission denials (question, Read, edit, state, LSP, and read-only directory Write), native formatter failure after Write publication, and owned-role model/variant precedence. A formatter failure is best-effort post-processing: it does not roll back an already published native Write.

`bun tests/host-session-probe.ts` uses actual A/B OpenCode sessions and a loopback deterministic OpenAI-compatible provider. It covers state write, native question and `/questionreply`, explicit absolute and relative A-document Read from B, B native Write and clear, same-slug behavior, current-session isolation, denied terminal state write after successful document Write, missing-file handling, and denied targeted external-symlink Read without automatic alternatives. It verifies that A's state/source/checkbox/approval bytes remain unchanged.

`bun tests/package-probe.ts` packs the package, installs it into an isolated consumer, and verifies packaged default/config/prompts/skills/state API/AST addon loading and document preservation on clear. `bun tests/company-context-probe.ts` runs a local stdio MCP fake peer through the actual host and deterministic provider, covering unset/absent/denied/valid/invalid/error/hostile responses and all `onError` modes; it also checks the specialist's controlled missing-`chub` behavior.

These are transport and source-contract checks, not proof of LLM obedience, prompt-branch guarantees, injection resistance, semantic model quality, external credentials, or installed language-server semantic correctness. The LSP fixture also covers pooled concurrent leases and recovery, but no LSP server is downloaded. This guide records behavior and evidence scope; independent completion proof belongs in the durable delivery ledger.
