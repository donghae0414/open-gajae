# OpenCode 이식 가이드: 현재 계약, 승인 예외, 검증 경계

> **상태 (2026-09-16):** 이 문서는 현재 source와 승인된 결정의 배포 문서다. OMC 전체 이식, Phase 1 완료, live model 동작, 또는 설치된 언어 서버의 의미적 정확성을 주장하지 않는다. 완료 증명은 이 문서가 아닌 durable delivery ledger에 기록한다.
>
> **기준:** OMC v5.4.0, `5281b19e0d64f8e6dc6767f2130299a88af2dc71`. 개발 정책은 [AGENTS.md](../../AGENTS.md)다. 상세 원문 조사는 [OMC 분석](./oh-my-claudecode-analysis.md)과 [OMX 분석](./oh-my-codex-analysis.md)에 보존한다.

## 1. 현재 제품 범위

현재 제품은 OpenCode 본체를 수정하지 않는 plugin이다. 구현된 범위는 다음으로 한정된다.

- native skill 기반 `deep-interview`와 native `question` 사용
- 자체 역할 `open-gajae` (primary), `open-gajae-explore` (읽기 전용 repository 조사), `open-gajae-document-specialist` (문서/인용 조사)
- trusted current session 기반 `state_read`, `state_write`, `state_clear`
- native Write로 저장하는 세션별 spec 경로와 미래 plan 경로 계약
- 읽기 전용 `ast_grep_search`, `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_servers`
- 두 JSONC 설정과 optional advisory `companyContext`

임계값 도달 후 spec을 저장하면 native `question`으로 인터뷰 종료 또는 추가 구체화를 선택하게 한다. 이는 OMC의 `Refine further` 선택권을 유지하되 후속 실행 메뉴는 제외하는 계약이다. 추가 구체화는 같은 세션·이력·누적 라운드·spec 경로를 유지하고, 기존 낮은 점수만으로 즉시 끝나지 않도록 추가 요구사항 답변 후 점수를 재평가한다. 선택 메뉴는 scoring/round에 포함하지 않는다. `maxRounds` 상한·명시적 조기 종료·취소는 별도로 존중하며, 도구 실패를 완료 동의로 바꾸지 않는다. 이 선택 흐름은 스킬 프롬프트 계약이며 별도 lifecycle hook이나 강제 상태 머신을 추가하지 않는다.

다음은 제품 기능이 아니다: ralplan, ultragoal, autopilot, team, ralph, autoresearch, plan 실행 bridge, shared/latest/aggregate session 선택, broad/orphan/stranded cleanup, receipt/index/ledger, 자동 migration, SQLite/대체 SQL, IPC/PID lock recovery, Node worker, LSP rename/diagnostic/code-action/replace, LSP server 자동 설치, company-context proxy/등록/강제 hook.

OMX의 rhythm, mandatory pressure, four-closure enforcement는 제거된 기능이며 현재 계약이 아니다. OMO는 host 연결 패턴의 역사적 참고일 뿐 제품 정책을 이식한 것이 아니다. GJC의 `_session-…` **디렉터리 패턴만** 참고했으며 GJC의 lock/index/receipt/ledger 코드 전체를 복사하지 않았다.

## 2. 결정 기록 — 구현된 동작과 승인 예외

### M03 — 단일 process 상태 저장

상태 target마다 module-level queue를 두어 같은 canonical state 파일의 read/write/clear를 하나의 plugin process에서 직렬화한다. write는 고유 temporary file을 만든 뒤 rename한다. 실패한 작업은 해당 호출자에게 보이지만 queue의 후속 작업을 poison하지 않는다.

이는 IPC lock, process 간 동시 writer 안전성, transaction, fsync/정전 내구성, PID/liveness recovery가 아니다. native Markdown Write는 queue 밖에 있어 state와 문서의 부분 성공이 가능하다.

### M04 — root 유지, scope 교체

root는 host worktree의 `.open-gajae`다. 상태와 새 산출물은 trusted `ToolContext.sessionID`의 UTF-8 바이트를 소문자 hex로 인코딩한 단일 path component 아래에만 둔다.

```text
<worktree>/.open-gajae/
  _session-<lowercase-utf8-hex-native-session-id>/
    state/deep-interview-state.json
    specs/deep-interview-<slug>.md
    plans/<slug>.md
```

모델 입력, snapshot의 `session_id`, 또는 tool argument는 다른 세션을 고르지 못한다. missing session ID는 오류다. shared/scoped/latest/aggregate/legacy fallback이나 자동 탐색은 없다. 사용자/프로젝트 JSONC는 이 namespace로 옮기지 않는다.

### M05 — native Write와 문서 경로

현재 session의 spec은 `specs/deep-interview-<slug>.md`, 미래 plan의 위치는 `plans/<slug>.md`다. Native Write의 same-session/same-slug overwrite를 따른다. custom writer, suffix (`-rN` 등), receipt, active pointer, hash/index는 없다. `plans/`는 위치 계약일 뿐 runnable plan 또는 downstream workflow bridge가 아니다.

### M07 — clear 범위

`state_clear`는 현재 session의 `state/deep-interview-state.json` 하나만 삭제한다. 같은 session의 specs/plans, 다른 session, legacy 자료, summary는 보존한다. 파일이 없으면 side effect 없는 `missing` 결과다. corrupt JSON, permission, I/O 오류는 보존한 채 visible error가 된다. lifecycle event, load, install은 state/documents를 자동 생성·clear·resume하지 않는다.

### OMC와의 관계

OMC의 deep-interview snapshot replacement, explicit field precedence, `_meta` regeneration, payload bounds (1 MiB, depth 10, 100 top-level keys), 4/6/8 challenge, 기본 0.2, source pacing/topology/ontology와 역할 계약은 이식 대상이다. 저장 위치, trusted current-session binding, clear scope, queue/durability 범위는 승인된 host 예외다. `_meta`는 일관성 확인 metadata일 뿐 actor 인증, 경로 선택, approval/completion gate가 아니다.

## 3. 다른 세션 문서 입력은 상태 승계가 아니다

세션 A의 spec/plan 경로를 사용자가 명시하면 세션 B는 host native Read 및 적용되는 read/external-directory permission으로 그 문서를 입력으로 읽을 수 있다. 상대 경로는 현재 host directory에서 해석하고 실제 읽은 경로를 보고한다. 누락, 거부, 읽기 실패는 그대로 보고하며 latest/session scan/다른 파일 대체를 하지 않는다.

A의 문서를 읽어도 B의 `state_read`/`state_write`/`state_clear`는 trusted session B에 고정된다. B의 새 산출물도 B 아래에만 생긴다. A의 state, owner, 진행도, approval, checkbox는 이전되지 않고 A 원문은 수정하지 않는다. 원문 속 명령 또는 승인 문구는 실행 권한이 아니다. 이 계약은 deep-interview의 참고 입력에만 적용되며 plan 실행 bridge를 제공하지 않는다.

## 4. 역할, 권한, 모델 및 company context

| 역할 | 허용된 제품 역할 | 중요한 금지/경계 |
|---|---|---|
| `open-gajae` | 수정·통합·결정, state read/write/clear, owned role delegation | host/user permission을 우회하지 않음 |
| `open-gajae-explore` | repository fact, native Read/Glob/Grep, read-only AST/LSP, state read | edit, bash, task, question, state write/clear 금지 |
| `open-gajae-document-specialist` | 문서/공개 reference 조사와 citation synthesis | edit, task, question, state write/clear 금지; 문서화된 `chub` read-only protocol은 arbitrary bash allow가 아님 |

State read는 세 자체 역할에 한정되고 state write/clear는 primary 전용이다. 도구는 trusted actor, current native session, canonical worktree, native permission을 filesystem/backend보다 먼저 검사한다. Role-specific host permission은 유지한다. 두 read-only 역할의 fixed mandatory deny는 host wildcard를 포함한 host rule 뒤에 재삽입되어 순서로 약화되지 않으며, 그 밖의 permission 평가는 host가 수행한다.

설정 파일은 `~/.open-gajae/open-gajae.jsonc`와 `<worktree>/.open-gajae/open-gajae.jsonc`다. JSONC는 알려진 key/type을 검증한다. 모든 자체 역할의 `model`/`variant` field는 **host override > project JSONC > user JSONC**이며, 생략은 host/parent behavior에 맡긴다. 유효한 host override를 artificial collision로 거부하지 않는다. provider fallback, tier, retry, model pinning은 없다.

`companyContext`는 `{ tool?: string, onError?: "warn" | "silent" | "fail" }`이고 project field가 user field를 덮으며 기본 `onError`는 `warn`이다. tool이 visible·permitted MCP tool이면 primary prompt가 spec crystallization 전에 `{query}`를 보내 `{context}`를 advisory 인용 자료로 받을 수 있다. 미설정은 skip한다. missing/denied/failing/invalid 결과에서 `warn`은 짧게 알리고 계속, `silent`는 알림 없이 계속, `fail`은 crystallization을 멈춘다. 이는 prompt-level best effort이지 hook/proxy/registry/signing/force-call이 아니다.

## 5. 유한 read-only 도구 surface

### AST

`ast_grep_search`는 `@ast-grep/napi` 0.31.1을 사용한다. AST pattern 검색만 제공하며 replace는 없다. 지원 언어와 결과 수는 tool schema가 정한다. addon이 없으면 오류/복구 안내를 내며 "no matches"로 위장하지 않는다. 직접 recursive traversal과 file read 전에 canonical path·symlink·native read 권한을 확인한다. denial은 parse skip으로 숨기지 않는다.

### LSP

네 도구는 references, document symbols, workspace symbols, known-server status만 제공한다. server는 보고/실행할 뿐 자동 설치하지 않는다. 요청 파일의 canonical/external 경계와 native `lsp` operation permission을 확인한 뒤 backend를 호출한다. `lsp_servers`도 actor와 operation permission을 확인한다.

LSP permission은 요청 operation 경계다. language server가 내부적으로 workspace files를 읽는 것을 매 파일 intercept하는 sandbox도 아니고 agent에게 arbitrary bash 권한을 부여하는 것도 아니다. real server dependency와 semantic correctness는 별도 검증 대상이다.

source에서 실제 도달하는 환경 변수는 `OPEN_GAJAE_LSP_TIMEOUT_MS`, `OPEN_GAJAE_LSP_IDLE_TIMEOUT_MS`, `OPEN_GAJAE_LSP_IDLE_CHECK_INTERVAL_MS`, `OPEN_GAJAE_LSP_CONTAINER_ID`, `OPEN_GAJAE_PYTHON_LSP=basedpyright`뿐이다. 다른 임의 환경 변수를 제품 설정이라고 주장하지 않는다.

## 6. Source → target → exception → test 장부

아래는 stage-05 revision과 stage-13/14 intent의 유한 매핑을 현재 source 계약에 맞게 요약한 것이다. `E`는 원본/host 조사 근거, `F`는 구현 target, `AC`는 acceptance, `T`는 검증 case다. 역사적 원본 사실을 승인 예외와 동일시하지 않는다.

| 근거 → target | 승인된 대응/예외 | AC | T |
|---|---|---|---|
| E01–E04, E12–E13, E17, E20 → F01/F03 | optional selector, shared/aggregate/latest/legacy resolver 대신 trusted current session + deterministic hex path | AC02, AC04 | T01, T04, T07 |
| E05–E07 → F01/F03 | fresh snapshot, explicit precedence, regenerated `_meta`; no `_runtime`/receipt completion gate | AC03 | T02 |
| E08–E09 → F02 | OMC SQLite/IPC/liveness/rollback parity 대신 process-local target queue + temp→rename | AC05 | T03 |
| E10–E11, E15 → F04/F05 | broad/stranded/orphan/cancel-signal/summary lifecycle를 만들지 않고 current state file만 clear | AC06 | T05-a–e |
| E14 → F05/F07 | session-native spec Write, same-slug overwrite; no custom writer/receipt/suffix; plans는 future path only | AC07 | T06, T10-NATIVE |
| E16 → F06 | 모든 자체 역할 field별 host > project > user; host inheritance와 valid override 보존 | AC08 | T08 |
| E18 → F07 | OMC 4/6/8/.2/topology/ontology 유지, OMX enforcement 제거 | AC10 | T09 |
| E19, E21–E25 → F03/F06/F07 | 실제 explorer + document specialist + read-only LSP/AST; native permission 경계, LSP internal sandbox 없음 | AC04, AC09 | T10-LSP, T10-AST, T10-DOC |
| E23–E24 → F06/F07 | optional companyContext의 two-JSONC field merge, `{query}` → advisory `{context}`, no proxy/hook | AC09 | T10-CC |
| stage-14 X01–X06 → F05/F07 | explicit A document Read in B; B-only state/output; no state/approval/checkbox transfer or runnable bridge | AC02, AC06, AC07 | T06, T10-NATIVE |
| E26 → F08 | historical SQLite host load failure는 보존하되 dependency/probe/SQL product contract는 제거 | AC11, AC12 | distribution/source review + host QA |

검증 이름의 의미는 다음과 같다: T01 session encoding/current-only; T02 snapshot/payload/corruption; T03 queue/rename/failure continuation; T04 actor/permission; T05 clear isolation; T06 native Write/partial success; T07 worktree/path containment; T08 model/variant precedence; T09 skill contract; T10 finite native/LSP/AST/document/company-context surface. T03은 다른 process 경쟁 성공을 요구하지 않는다.

## 7. 검증 현황과 한계

다음은 완료된 검증 command와 그 evidence scope다. 이 문서는 실행 횟수나 assertion 수를 completion ledger로 사용하지 않는다.

| 명령 | 보고된 결과 | 무엇을 의미하지 않는가 |
|---|---|---|
| `bun run typecheck`, `bun run test`, `bun run build` | source type, unit, build surface 확인 | live host/model behavior 또는 deployment compatibility |
| `bun run test:host` | installed OpenCode 1.18.31에서 load/state/AST/native Write, question·Read·edit·state·LSP 및 read-only directory Write deny, native formatter failure-after-publication, 세 역할 model/variant precedence 확인 | broad Phase-1 completion |
| `bun tests/host-session-probe.ts` | actual A/B sessions + loopback deterministic OpenAI-compatible provider에서 question/`/questionreply`, explicit absolute/relative A-document Read in B, B write/clear/same slug, B terminal state-write deny after document success, missing/external-symlink failure without fallback, A bytes preservation 확인 | semantic model quality, LLM obedience, external credential coverage |
| `bun tests/package-probe.ts` | packed tarball을 isolated consumer에 설치해 packaged default/config/prompts/skills/state API/AST addon과 clear-document preservation 확인 | registry publication 또는 deployed-host compatibility |
| `bun tests/company-context-probe.ts` | local stdio MCP fake peer를 actual host + deterministic provider로 호출해 unset/absent/denied/valid/invalid/error/hostile response, 모든 `onError`, controlled missing-`chub` 확인 | guaranteed prompt branch, injection resistance, proxy/hook behavior |

host-session probe는 SSE text response를 stream하고 idle을 기다린 뒤 stage를 전환해 actual integration completion을 관찰한다. Company-context probe는 local test transport와 source/runtime policy 계약만 검증하며 hook을 추가하지 않는다. LSP fixture는 real child initialize/didOpen/symbols/references/server error/exit/force-kill과 pooled concurrent lease/recovery를 다루지만, installed language server의 semantic correctness를 검증하지 않는다. 모든 server 설치는 여전히 사용자 책임이다.

## 8. 역사적 분석과 비채택 제안

이전 문서의 OMC/OMX 3-workflow 비교, `session.finish` core patch, TODO/goal 대체, disk ledger, consensus/Stop gate, shared artifact path, SQLite/IPC 선택지는 **역사적 분석 또는 비채택 제안**이다. 현재 구현의 요구사항, acceptance, 또는 실행 승인으로 읽지 않는다. 원본 source line/commit 사실은 상세 분석 문서에서 보존하지만, 실제 제품 동작은 이 문서와 source를 우선해 재확인한다.

특히 OpenCode에 core stop hook을 추가하는 제안은 본체 무수정 정책과 현재 범위 밖이다. 다른 session 문서를 읽는 기능도 future plan execution, owner transfer, approval transfer, or cross-session resume를 의미하지 않는다.

## 9. 출처와 배포

OMC 및 OMO/OMX 관련 파생물의 출처와 조건은 [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md)에 따른다. OMX runtime functionality가 제거되었어도 실제 보존된 파생 분석/material의 attribution은 유지한다. historical better-sqlite3 host load 실패는 선택 배경으로 보존하지만 현재 제품이 SQLite dependency 또는 probe를 제공한다는 뜻은 아니다.

배포 시 `dist`, `skills`, `prompts`, `licenses`, notices를 함께 유지한다. 사용자 host JSONC, legacy data, 또는 reference repository를 자동 변경·이동·삭제하지 않는다.
