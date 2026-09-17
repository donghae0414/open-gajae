[English](README.md) | [한국어](README.ko.md)

# open-gajae

세션에 묶인 `deep-interview`/`ralplan` skill, 여섯 개의 자체 역할, 작은 읽기 전용 코드 조사 도구를 제공하는 OpenCode 플러그인입니다. OMC v5.4.0의 일부 자료를 이식했지만 OMC 전체 이식이나 후속 실행 워크플로는 아닙니다.

## 범위와 상태

- 기준은 OMC v5.4.0 커밋 `5281b19e0d64f8e6dc6767f2130299a88af2dc71`입니다. OMX는 현재 동작의 원천이 아닙니다.
- 구현 범위는 `deep-interview`와 `ralplan`, `open-gajae`/`open-gajae-explore`/`open-gajae-document-specialist`, `open-gajae-planner`/`open-gajae-architect`/`open-gajae-critic` 합의 역할, 세션 상태, native 문서 출력, 읽기 전용 AST/LSP, 선택적 advisory company context입니다.
- `ralplan`은 제공하며 `pending approval` 상태의 plan에서 끝납니다. ultragoal, autopilot, team, ralph, autoresearch, 계획 실행 핸드오프(deep-interview → ralplan 계획 bridge는 제공), 공유 세션 상태, 자동 migration/recovery는 제공하지 않습니다.
- 이 문서는 구현 계약을 설명하며 Phase-1 완료를 입증하지 않습니다.

개발 정책은 [AGENTS.md](AGENTS.md), 결정과 근거는 [이식 가이드](docs/analysis/opencode-porting-guide.md), 출처는 [third-party notices](THIRD-PARTY-NOTICES.md)를 확인하세요.

## 빌드와 로컬 등록

패키지는 `@opencode-ai/plugin` 1.18.30을 사용합니다. 부모가 수행한 host probe는 OpenCode 1.18.31을 사용했지만, 이는 일반 호환성 보장이 아닙니다.

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

`dist/`, `skills/`, `prompts/`, `licenses/`, `THIRD-PARTY-NOTICES.md`를 함께 유지하세요. 배포 플러그인을 갱신하면 다시 빌드하고 OpenCode를 재시작합니다.

로컬 설정 변경을 명시적으로 승인한 뒤에는 기존 OpenCode JSONC를 보존하고 plugin 항목만 변경합니다.

```jsonc
{ "plugin": ["file:///Users/dongwuk/apps/open-gajae/dist/index.js"] }
```

이는 전체 설정 교체 예시가 아닙니다. 플러그인은 host 설정을 자동 편집하지 않습니다. 설치된 surface는 다음으로 확인합니다.

```sh
opencode debug skill
opencode debug agent open-gajae
opencode debug agent open-gajae-explore
opencode debug agent open-gajae-document-specialist
opencode debug agent open-gajae-planner
opencode debug agent open-gajae-architect
opencode debug agent open-gajae-critic
```

## Deep interview와 저장소

`/deep-interview <idea>`는 요구사항 명확화를 시작합니다. 플러그인이 이 커맨드를 명시적으로 등록하므로 host가 skill에서 만든 같은 이름의 커맨드는 가려지고, skill 본문은 메시지로 확장되지 않고 `skill` 도구로 로드됩니다. 일반 텍스트의 `deep interview`/`deep-interview`/`딥인터뷰`/`ディープインタビュー`/`ouroboros` 키워드도 같은 skill로 진입합니다. OMC와 같이 정보성 문맥(질문, 인용·참조 언급, 코드·표·인용 블록 안의 텍스트)만 제외되며, `ouroboros`/`ooo` CLI 형식으로 시작하는 메시지는 무시합니다. 키워드 턴에는 OMC의 `[MAGIC KEYWORD: DEEP-INTERVIEW]` 안내가 주입되고 state는 만들지 않습니다. deep-interview에는 OMC와 같이 idle 연속 주입이 없으며, 질문이 열려 있는 동안은 native `question` 도구가 세션을 붙잡습니다. skill은 native `question`을 한 번에 하나씩 사용합니다. 권한 거부 또는 도구 부재는 보고하며, 일반 문장 질문으로 대체하지 않습니다. 저장된 spec은 구현 승인이 아닙니다.

ambiguity 임계값에 도달해 spec을 저장한 뒤에는 인터뷰를 마칠지 더 구체화할지 묻습니다. 추가 인터뷰는 현재 세션과 이력을 유지하며, 임계값을 다시 확인하기 전에 요구사항 질문을 하나 더 하고 같은 spec 파일을 갱신합니다. 선택 메뉴 자체는 라운드에 포함하지 않습니다. 누적 `maxRounds`, 명시적 조기 종료와 취소는 그대로 적용하며, 도구 실패를 종료 동의로 취급하지 않습니다. 이는 프롬프트 수준의 대화 계약이며 호스트가 강제하는 상태 머신은 아닙니다.

상태 도구는 `state_read`, `state_write`, `state_clear`입니다. 신뢰 가능한 현재 `ToolContext.sessionID`만 사용하며 호출자가 다른 세션을 고를 수 없습니다. 세션 ID는 UTF-8 소문자 hex로 인코딩되고 생성 경로는 다음과 같습니다.

```text
<worktree>/.open-gajae/
  _session-<encoded-session-id>/
    state/deep-interview-state.json
    specs/deep-interview-<slug>.md
    plans/<slug>.md
```

상태 쓰기는 model snapshot을 교체합니다. 명시 tool 필드가 우선하며 `_meta`는 매번 다시 만듭니다. `state_clear`는 현재 세션 state JSON 하나만 지우고 같은 세션 문서, 다른 세션, legacy 파일은 보존합니다. 손상/잘못된 상태는 reset하지 않고 보존한 채 오류로 드러냅니다.

동일한 canonical 상태 파일의 연산은 하나의 plugin process 안에서 직렬화되고 temporary file → rename으로 JSON을 게시합니다. IPC lock, state와 문서 저장의 다중 파일 transaction, 전원 손실 내구성, 다중 process 안전성은 아닙니다. 명세는 이 queue 밖에서 native `write`가 있으면 사용하고, 없으면 `apply_patch`로 저장합니다. 추가 인터뷰 결과는 같은 파일에 갱신하며 suffix, receipt, index, 자동 복구는 없습니다.

사용자가 다른 세션의 spec/plan 경로를 명시하면 입력으로 읽을 수 있습니다. Native Read와 그 권한이 적용되고 실제 읽은 경로를 알려야 합니다. latest 탐색이나 다른 파일 대체는 하지 않습니다. B가 A를 읽어도 state/owner/승인/checkbox가 이전되지 않고 A 원문 편집이나 계획 실행 권한도 생기지 않습니다. B는 자기 state/documents에만 새 결과를 씁니다.

## Ralplan

`/ralplan [--interactive] [--deliberate] <task>`는 합의 계획을 시작합니다. 일반 텍스트의 `ralplan`/`랄플랜` 키워드도 같은 skill로 진입하지만, OMC와 같이 호출 문맥에서만 동작합니다: 직접 호출 접두(`$ralplan`, `!ralplan`, `force: ralplan`), 활성화 동사(`use`, `run`, `start`, `please`, `let's`), 또는 메시지 맨 앞의 키워드. 질문, 인용·참조 언급, 코드·표·인용 블록 안의 텍스트는 발화하지 않으며, 슬래시 커맨드가 메시지로 확장한 다른 skill 본문도 발화하지 않습니다. 키워드는 모든 primary agent에서 동작하지만, agent가 `open-gajae-planner`/`open-gajae-architect`/`open-gajae-critic`인 메시지는 키워드 hook이 무시합니다. 한 메시지에 ralplan과 deep-interview 키워드가 함께 있으면 두 안내가 ralplan부터 순서대로 주입되고 ralplan state만 시딩됩니다.

native `question` 세 개는 항상 켜져 있습니다. Planner 초안 직후의 intent 확인, 합의 종료 후 확인, 그리고 `Refine further`/`Stop here`를 제공하는 최종 승인 질문입니다. `--interactive`는 draft review만 추가합니다. `--deliberate`는 pre-mortem과 확장된 test plan을 추가하며, 명시적 고위험 신호에서 자동으로 켜집니다.

세션 산출물은 기존 세션 계약을 확장합니다.

```text
<worktree>/.open-gajae/
  _session-<encoded-session-id>/
    plans/<slug>.md
    drafts/<slug>.md
    state/ralplan-state.json
```

상태 도구는 `mode: "deep-interview" | "ralplan"`을 받습니다. 기본값은 `deep-interview`이므로 기존 deep-interview 동작은 바뀌지 않습니다.

continuation hook은 ralplan state가 active인 동안 `session.idle`마다 세션에 다시 프롬프트를 넣습니다. agent와 model은 마지막 user 메시지에서 상속합니다. circuit breaker는 30회 주입에서 멈추고, breaker 카운터는 45분이 지나면 만료됩니다. 사용자가 Esc로 턴을 중단한 경우(`session.error`의 `MessageAbortedError`, 또는 마지막 assistant 메시지에 남은 abort 오류)에는 그 idle을 건너뛰고 breaker도 올리지 않습니다. state는 active로 남아 있으므로 다음 사용자 턴이 끝나면 continuation이 다시 동작합니다.

`awaiting_confirmation`은 키워드 또는 `/ralplan` 커맨드가 state를 시딩했지만 모델이 아직 skill을 열지 않은 상태를 뜻합니다. host가 `skill` 호출을 관찰하면 지워지며, 타이머로는 지워지지 않습니다. 남겨진 seed는 ralplan 키워드가 없는 다음 사용자 메시지가 지웁니다.

`[RALPLAN MODE RESTORED]`는 같은 세션 안에서 재개당 최대 한 번만 나타납니다. state는 세션별이므로 세션 간 복원은 없습니다.

실행 skill은 없습니다. plan은 `pending approval` 상태로 남습니다.

후속 개발 노트: ultragoal 또는 autopilot을 구현하면 최종 승인 선택지에 `Approve execution via ultragoal`(또는 OMC 원본의 `team`/`ralph`/`compact`/`Request changes`/`Reject`)을 추가하고, 핸드오프 전에 `state_write(mode="ralplan", active=false)`를 호출해야 합니다.

## 자체 역할과 설정

- **`open-gajae`**: primary입니다. 수정, 결정, 통합, state write/clear를 소유합니다.
- **`open-gajae-explore`**: repository 사실을 읽기 전용으로 조사합니다. edit, bash, delegation, question, state write/clear를 할 수 없습니다.
- **`open-gajae-document-specialist`**: 문서와 인용 근거를 조사합니다. edit, delegation, question, state write/clear를 할 수 없습니다. 문서화된 `chub` 절차는 읽기 전용이며 arbitrary bash 권한을 주지 않습니다.
- **`open-gajae-planner`**, **`open-gajae-architect`**, **`open-gajae-critic`**: ralplan 합의 역할입니다. 세 역할 모두 `mode: subagent`이며 읽기 전용입니다. edit, task, question, state write/clear가 모두 거부됩니다. 기본 모델은 없으며 설정의 `agents` 맵으로만 지정합니다.

역할별 host permission은 보존합니다. 다섯 읽기 전용 역할의 고정 deny rule은 host wildcard를 포함한 host rule 뒤에 추가되므로 순서로 mandatory deny를 완화할 수 없고, 나머지 permission 평가는 native입니다. 설정은 `~/.open-gajae/open-gajae.jsonc`와 `<worktree>/.open-gajae/open-gajae.jsonc`에서 읽습니다. field는 project → user → defaults 순으로 병합됩니다. 알 수 없는 key, 잘못된 JSONC, 잘못된 값은 진단과 함께 실패합니다. 모든 자체 역할의 유효한 host override는 project, user `model`/`variant`보다 우선하고, 생략한 field는 host가 소유합니다. provider fallback, tier mapping, 인위적 collision 거부는 없습니다.

```jsonc
{
  "deepInterview": { "ambiguityThreshold": 0.2, "maxRounds": 20 },
  "agents": {
    "open-gajae": { "model": "provider/model", "variant": "variant-name" },
    "open-gajae-planner": { "model": "openai/gpt-5.6-luna" },
    "open-gajae-architect": { "model": "openai/gpt-5.6-terra" },
    "open-gajae-critic": { "model": "openai/gpt-5.6-terra" }
  },
  "companyContext": { "tool": "company_context", "onError": "warn" }
}
```

`companyContext`는 선택 사항입니다. `tool`이 visible·permitted MCP 도구 이름이면 primary prompt가 spec 확정 직전에 `{ "query": "…" }`로 호출하고 `{ "context": "…" }`를 advisory 인용 자료로 다룰 수 있습니다. hook, proxy, registration, 강제 호출이 아닙니다. 미설정이면 건너뛰고 `onError` 기본값은 `warn`이며 `silent`/`fail`도 가능합니다.

## 읽기 전용 코드 도구

등록 도구는 다섯 개입니다.

- `ast_grep_search` (`@ast-grep/napi` 0.31.1): AST 검색만 하며 replace는 없습니다.
- `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_servers`.

LSP server는 감지·보고만 하며 자동 다운로드하지 않습니다. LSP rename, diagnostics, code action, replacement suite는 없습니다. LSP 권한은 요청 파일/operation을 다루지만 language server 내부 파일 읽기의 sandbox는 아닙니다. AST는 자체 guarded traversal/read 검사를 수행합니다. 두 도구 모두 explorer 권한을 넓히거나 arbitrary shell 실행을 허용하지 않습니다.

source에서 실제 도달하는 제품 환경 변수는 `OPEN_GAJAE_LSP_TIMEOUT_MS`, `OPEN_GAJAE_LSP_IDLE_TIMEOUT_MS`, `OPEN_GAJAE_LSP_IDLE_CHECK_INTERVAL_MS`, `OPEN_GAJAE_LSP_CONTAINER_ID`, `OPEN_GAJAE_PYTHON_LSP=basedpyright`뿐입니다. 일반 설정이 아니라 LSP 구현 설정입니다.

## 검증 근거와 한계

완료한 검사는 typecheck, unit test, build 및 위의 stable command입니다. `bun run test:host`는 설치된 OpenCode 1.18.31의 plugin load, state/AST/native Write, question·Read·edit·state·LSP 및 읽기 전용 directory Write의 permission denial, Write 게시 뒤 native formatter 실패, 자체 역할 model/variant 우선순위를 다룹니다. Formatter 실패는 best-effort post-processing이므로 이미 게시된 native Write를 rollback하지 않습니다.

`bun tests/host-session-probe.ts`는 실제 A/B OpenCode session과 loopback deterministic OpenAI-compatible provider를 사용합니다. state write, native question과 `/questionreply`, B에서 A 문서를 명시 absolute/relative path로 Read, B native Write/clear, same-slug 동작, current-session 격리, 문서 Write 성공 뒤 terminal state write 거부, missing file, targeted external-symlink Read 거부와 자동 대체 없음을 확인합니다. A의 state/source/checkbox/approval bytes가 변하지 않는지도 검증합니다. ralplan continuation 재진입 probe도 포함합니다.

`bun tests/package-probe.ts`는 패키지를 pack한 뒤 isolated consumer에 설치하고 packaged default/config/prompts/skills/state API/AST addon load 및 clear의 문서 보존을 확인합니다. `bun tests/company-context-probe.ts`는 local stdio MCP fake peer를 실제 host와 deterministic provider를 통해 실행해 unset/absent/denied/valid/invalid/error/hostile response 및 모든 `onError` mode를 확인하고 specialist의 controlled missing-`chub` 동작도 검사합니다.

이는 transport와 source-contract 검사이지 LLM obedience, prompt branch 보장, injection resistance, model 의미적 품질, external credential, 설치된 language server의 의미적 정확성 증거가 아닙니다. LSP fixture는 pooled concurrent lease와 recovery도 다루며 server를 자동 다운로드하지 않습니다. 이 가이드는 동작과 evidence scope를 기록하며 독립 completion proof는 durable delivery ledger에 둡니다.
