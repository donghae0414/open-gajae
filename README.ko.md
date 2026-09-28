[English](README.md) | [한국어](README.ko.md)

![open-gajae — Clarify. Plan. Execute.](assets/branding/open-gajae-banner.png)

# open-gajae

**OpenCode v2용 플러그인으로 개발한 개인 학습 및 토이 프로젝트입니다.** OpenCode v1은 지원하지 않습니다.

## 개발 배경과 프로젝트 성격

[gajae-code](https://github.com/Yeachan-Heo/gajae-code)와 [oh-my-claudecode (OMC)](https://github.com/Yeachan-Heo/oh-my-claudecode)를 사용하며 좋은 경험을 했습니다. 다만 OpenCode만 사용할 수 있는 환경적 제약이 있어, OpenCode에서도 비슷한 경험을 만들어 보고 싶었습니다. 코딩 에이전트 개발을 공부하려는 목적을 겸해 두 프로젝트를 참고하며 open-gajae를 개발하게 되었습니다. OpenCode 플러그인 개발과 호스트 연동 방식을 공부하는 데에는 [oh-my-openagent (OMO)](https://github.com/code-yeongyu/oh-my-openagent)도 참고했습니다. 영감과 배움의 바탕이 된 세 프로젝트의 제작자와 기여자분들께 감사드립니다.

이 프로젝트는 독립적으로 개발한 비공식 프로젝트입니다. gajae-code, OMC, OMO, OpenCode/Anomaly와 제휴하거나 공식 승인을 받은 프로젝트가 아니며, gajae-code, OMC, OMO의 공식 이식판 또는 호환 플러그인이 아닙니다. 원본 프로젝트와 동일한 기능·동작이나 호환성을 보장하지 않으며, 개인 학습과 실험을 목적으로 합니다.

실제로 포함하거나 수정해 사용한 외부 자료의 출처와 라이선스는 [third-party notices](THIRD-PARTY-NOTICES.md)에 기록되어 있습니다. [배너 출처](assets/branding/open-gajae-banner.md).

## 라이선스

open-gajae의 자체 작성 부분은 MIT, 외부 자료는 각 원본 라이선스를 따릅니다. 자세한 조건은 [LICENSE](LICENSE)와 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md)를 확인하세요.

## 개요

세션에 묶인 `deep-interview`/`ralplan`/`ultragoal` skill, 여덟 개의 자체 역할, 작은 읽기 전용 코드 조사 도구를 제공하는 OpenCode 플러그인입니다. 메인 에이전트 프롬프트와 `ralplan` skill(런타임과 세 합의 역할 포함)은 GJC를 바탕으로 이식하며, `deep-interview`·`ultragoal`과 나머지 역할은 OMC 기반 계약을 유지합니다. OMC나 GJC의 전체 이식은 아니며, 실행 워크플로는 OMC ralph를 이식한 `ultragoal` 하나뿐입니다.

## 범위와 상태

- OMC 기준선 이식인 Phase 1은 2026-09-27 관리자 결정으로 종료되었습니다. Phase 2 개선은 gajae-code를 주 참조로 관리자가 결정합니다. 정책은 [AGENTS.md](AGENTS.md)에 있습니다.
- GJC 기준(메인 에이전트 프롬프트, 그리고 `ralplan` skill·런타임·합의 역할 프롬프트)은 GJC v0.17.7 커밋 `5c5231418930673e42cc5d08ebe4376e03187533`이며, OMC 기반 skill과 역할 내부 계약의 기준은 OMC v5.4.0 커밋 `5281b19e0d64f8e6dc6767f2130299a88af2dc71` 그대로입니다.
- 대상 호스트는 OpenCode v2입니다. 이번 이식은 `@opencode/plugin` 2.0.15를 대상으로 하며, 로컬 `opencode/` 참조는 `v2.0.15`(`6f3639d82e`)에 고정되어 있습니다. v1 호스트는 더 이상 이 플러그인을 로드할 수 없습니다(v1 지원 중단 — deviations 표 참고).
- 패키지는 빌드 단계가 없는 TS 소스입니다. `package.json`의 `exports["."]`는 `./src/index.ts`를 가리키고, 루트 `index.ts`가 이를 re-export합니다. `dist/`는 없습니다.
- 구현 범위는 `deep-interview`·`ralplan`·`ultragoal`, `open-gajae`/`open-gajae-explore`/`open-gajae-document-specialist`, `open-gajae-planner`/`open-gajae-architect`/`open-gajae-critic` 합의 역할, `open-gajae-executor`/`open-gajae-cleaner` ultragoal 실행 역할, 세션 상태, native 문서 출력, 바로 호출 가능한 도구 13개(상태 도구 3개 + `ralplan` 도구 1개 + `ultragoal` 도구 1개 + 읽기 전용 AST/LSP 도구 8개), 그리고 ralplan 진행을 보여주는 선택 사항인 TUI 사이드바 플러그인 `tui-plugin/`입니다. company context(v1의 advisory MCP hook)는 완전히 제거되었습니다.
- `ralplan`은 제공하며 `pending approval` 상태의 plan(`pending-approval.md`)에서 끝나고, 최종 승인 질문은 `Refine further`/`Approve execution via ultragoal (Recommended)`/`Stop here`를 제공합니다. `ultragoal`은 OMC ralph를 이식한 목표 기반 지속 실행 loop로, goal별 architect 검증·필수 읽기 전용 cleaner pass·최종 critic 리뷰를 제공합니다. deep-interview → ralplan → ultragoal 핸드오프 체인도 제공합니다. autopilot, team, 독립된 ralph skill, autoresearch, 공유 세션 상태, 자동 migration/recovery는 제공하지 않습니다. 슬래시 커맨드는 없으며 명시적인 자연어 요청이나 지원되는 mention·키워드로 skill에 진입할 수 있습니다(아래 "진입" 참고).
- v2 호스트와 워크플로 설명은 `feat/opencode-v2-port` 브랜치 커밋 `f4df6e6`에서 비롯되었으며, 위 메인 에이전트 프롬프트 기준은 별도 변경입니다. 그 변경 자체가 Phase 1 완료를 입증한 것은 아니며, 아래 검증 계층(typecheck, unit test, host probe)이 이 변경에 대해 통과했다는 주장도 아닙니다. 검증 항목은 plan을 참고하세요.

개발 정책은 [AGENTS.md](AGENTS.md), 출처는 [third-party notices](THIRD-PARTY-NOTICES.md)를 확인하세요.

## 설치 (OpenCode v2)

```sh
bun install
bun run typecheck
bun test
```

호스트 설정(보통 `~/.config/opencode/opencode.jsonc`)에 이 저장소의 **디렉터리**(빌드된 파일이 아님)를 가리키는 `plugins` 항목을 추가합니다.

```jsonc
{
  "plugins": ["/Users/dongwuk/apps/open-gajae"],
  "default_agent": "open-gajae",
  "experimental": { "subagent_depth": 2 }
}
```

- `plugins`는 디렉터리 경로여야 합니다. v2 호스트는 `<dir>/server`, 그다음 `<dir>/index`를 확장자 추론과 함께 찾으며, 파일 경로로 설정된 plugin 항목은 건너뜁니다(일부 host 문서는 파일 경로 예시를 보여주는데, 이는 기록된 문서-구현 불일치입니다). 이 패키지의 루트 `index.ts`가 `./src/index.ts`를 re-export하므로 호스트는 빌드 없이 TypeScript 소스를 바로 로드합니다.
- `experimental.subagent_depth: 2`는 `open-gajae-planner` 역할이 native `subagent` 도구로 `open-gajae-explore`/`open-gajae-document-specialist`에 연구를 위임하는 데 필요합니다. 플러그인이 직접 이 값을 올릴 수 없습니다 — v1과 달리 v2 플러그인 API에는 config를 수정하는 domain이 없습니다 — 그래서 이 값은 직접 넣어야 하는 host 설정입니다. GJC 기반 planner 프롬프트에는 위임 지시가 없어 위임 여부는 모델이 정합니다. 이 값이 없으면 host가 planner의 `subagent` 호출을 거부하고 planner는 `read`/`grep`/`glob`로 직접 조사합니다.
- `default_agent: "open-gajae"`는 새 세션의 기본 역할을 primary로 정합니다. 필수는 아니지만 권장합니다.
- 이는 전체 설정 교체 예시가 아닙니다. 파일의 나머지는 그대로 두고 이 key만 추가하세요. 플러그인은 host 설정을 스스로 편집하지 않습니다.

이는 요약이며, 검증 체크리스트를 포함한 단계별 설치는 [`docs/local-install-v2.md`](docs/local-install-v2.md)를, 이번에 대체되는 이전 v1 설정은 [`docs/local-install-v1.md`](docs/local-install-v1.md)(역사 기록으로 보존)를 참고하세요.

이 디렉터리에서 첫 프롬프트를 보낸 뒤(플러그인 `setup`은 서버 시작이 아니라 위치별 첫 프롬프트에서 지연 실행됩니다), `GET /api/plugin`(플러그인 id와 `index.ts` source 경로 확인) 또는 `opencode debug agent <id>` / `opencode debug skill`로 설치된 surface를 확인하세요.

## 진입

이 이식에는 슬래시 커맨드가 없습니다. v1의 `/deep-interview`와 `/ralplan`은 사라졌습니다(기록된 deviation). `deep-interview`, `ralplan`, `ultragoal`을 사용하라는 명시적 자연어 요청이나 지원되는 mention·호출 문맥의 키워드로 요청한 skill에 진입합니다.

- **Mention**: `@deep-interview` 또는 `@ralplan`을 입력하고 TUI 자동완성에서 선택합니다. 선택하면 skill이 바로 붙습니다. 자동완성을 선택하지 않고 텍스트만 입력하면 skill이 붙지 않은 일반 텍스트로 전송됩니다 — 서버가 `@` mention을 자체적으로 파싱하지 않기 때문이며, 이 경우 아래 키워드 경로가 대신 감지합니다.
- **키워드**: v1과 같은 OMC 기반 키워드 감지(영/한/일 표기, 질문·인용·코드 블록 제외, ralplan의 호출 문맥 요구)가 일반 텍스트의 명시적 요청을 감지하고 안내를 주입합니다. 사용자가 요청하지 않은 heuristic 추천은 skill 또는 직접 진행을 제시하고 사용자의 선택을 따릅니다. `deep-interview`를 시작하지 않고도 일반적인 확인 질문을 할 수 있습니다. skill 시작 후에는 내부 질문·완료 선택·승인 절차가 그대로 적용됩니다.

## Deep interview와 저장소

`@deep-interview` mention 또는 `deep interview`/`deep-interview`/`딥인터뷰`/`ディープインタビュー`/`ouroboros` 키워드가 요구사항 명확화를 시작합니다. OMC와 같이 정보성 문맥(질문, 인용·참조 언급, 코드·표·인용 블록 안의 텍스트)만 제외되며, `ouroboros`/`ooo` CLI 형식으로 시작하는 메시지는 무시합니다. 키워드가 있는 턴, 또는 명시적 `@deep-interview` mention은 OMC의 `[MAGIC KEYWORD: DEEP-INTERVIEW]` 안내를 최대 한 번 주입하고 state는 만들지 않습니다 — 명시적 mention도 같은 안내를 받는 것은 OMC와 동일한 동작이며, v1은 명시적 호출에서 안내를 억제했습니다(기록된 deviation). skill은 native `question`을 한 번에 하나씩 사용합니다. 권한 거부 또는 도구 부재는 보고하며, 일반 문장 질문으로 대체하지 않습니다. 저장된 spec은 구현 승인이 아닙니다.

ambiguity 임계값에 도달해 spec을 저장한 뒤에는 인터뷰를 마칠지 더 구체화할지 묻습니다. 추가 인터뷰는 현재 세션과 이력을 유지하며, 임계값을 다시 확인하기 전에 요구사항 질문을 하나 더 하고 같은 spec 파일을 갱신합니다. 선택 메뉴 자체는 라운드에 포함하지 않습니다. 누적 `maxRounds`, 명시적 조기 종료와 취소는 그대로 적용하며, 도구 실패를 종료 동의로 취급하지 않습니다. "Refine with ralplan consensus"를 선택하면 spec을 저장한 뒤 저장된 spec 경로(`{specsDir}/deep-interview-{slug}.md`)를 context로 `ralplan` skill을 호출합니다. 이때 input field 이름 대신 OMC 스타일 문장으로 skill을 지칭합니다 — v2 `skill` 도구의 input은 `{ id }`뿐이므로, 모델이 첫 시도에 다른 field 이름을 추측하면 host input error로 한 번 재시도할 위험이 있습니다. 이는 프롬프트 수준의 대화 계약이며 host가 강제하는 상태 머신은 아닙니다.

상태 도구는 `state_read`, `state_write`, `state_clear`입니다. 신뢰 가능한 현재 `ToolContext.sessionID`만 사용하며 호출자가 다른 세션을 고를 수 없습니다. 세션마다 `_session-<YYYYMMDD-HHMMSS>-<세션 ID>` 디렉터리를 하나 가집니다. 라벨은 세션 생성 시각(로컬 시간)이고 ID는 native 세션 ID 원문입니다(예: `_session-20260918-030958-ses_f4f8651eaffeQnjyo1jEd5zVDu`). 생성 시각은 디렉터리를 처음 해석할 때 host에서 한 번 읽고, 이후에는 세션 ID 접미로 디렉터리를 찾으며, 같은 접미의 디렉터리가 둘이면 오류입니다. 생성 경로는 다음과 같습니다.

```text
<worktree>/.open-gajae/
  _session-<created>-<session-id>/
    state/deep-interview-state.json
    specs/deep-interview-<slug>.md
```

상태 쓰기는 model snapshot을 교체합니다. 명시 tool 필드가 우선하며 `_meta`는 매번 다시 만듭니다. `state_clear`는 현재 세션 state JSON 하나만 지우고 같은 세션 문서, 다른 세션, legacy 파일은 보존합니다. 손상/잘못된 상태는 reset하지 않고 보존한 채 오류로 드러냅니다.

동일한 canonical 상태 파일의 연산은 하나의 plugin process 안에서 직렬화되고 temporary file → rename으로 JSON을 게시합니다. IPC lock, state와 문서 저장의 다중 파일 transaction, 전원 손실 내구성, 다중 process 안전성은 아닙니다. 명세는 이 queue 밖에서 native `write`로 저장합니다. 추가 인터뷰 결과는 같은 파일에 갱신하며 suffix, receipt, index, 자동 복구는 없습니다.

사용자가 다른 세션의 spec/plan 경로를 명시하면 입력으로 읽을 수 있습니다. Native Read와 그 권한이 적용되고 실제 읽은 경로를 알려야 합니다. latest 탐색이나 다른 파일 대체는 하지 않습니다. B가 A를 읽어도 state/owner/승인/checkbox가 이전되지 않고 A 원문 편집이나 계획 실행 권한도 생기지 않습니다. B는 자기 state/documents에만 새 결과를 씁니다.

## Ralplan

`ralplan`은 GJC 고정 커밋의 ralplan skill과 런타임 계약을 바탕으로 다시 만든 합의 계획입니다. 구성은 `skills/ralplan/SKILL.md`, `open-gajae-planner`/`open-gajae-architect`/`open-gajae-critic` 프롬프트, 그리고 `src/ralplan-runtime/`의 `ralplan` 도구입니다. 계획만 하며, 사용자가 실행을 승인하기 전까지 plan은 `pending approval`로 남습니다. GJC와 다른 점은 모두 [GJC로부터의 deviation (ralplan)](#gjc로부터의-deviation-ralplan)에 기록되어 있습니다.

`@ralplan [--interactive] [--deliberate] <task>` mention, 또는 `ralplan`/`랄플랜` 키워드가 합의 계획을 시작합니다. OMC와 같이 키워드는 호출 문맥에서만 발화합니다: 직접 호출 접두(`$ralplan`, `!ralplan`, `force: ralplan`), 활성화 동사(`use`, `run`, `start`, `please`, `let's`), 또는 메시지 맨 앞의 키워드. 질문, 인용·참조 언급, 코드·표·인용 블록 안의 텍스트는 발화하지 않습니다. 키워드는 모든 primary agent에서 동작하지만, agent가 `open-gajae-planner`/`open-gajae-architect`/`open-gajae-critic`인 메시지는 키워드 hook이 무시합니다. 한 메시지에 ralplan과 deep-interview 키워드가 함께 있으면 두 안내가 ralplan부터 순서대로 주입됩니다.

키워드 턴은 `[MODE: RALPLAN]` 안내를 주입해 모델에게 `ralplan` skill을 열도록 요청합니다. `@ralplan` mention은 skill이 이미 붙었다는 자체 `[MODE: RALPLAN]` 안내를 넣어 삽입 사실이 보이게 합니다(TUI에 `open-gajae: ralplan mention notice added`가 표시됨). 어느 쪽도 ralplan state를 쓰지 않습니다 — 시딩, 확인 단계, 남은 seed 정리가 없습니다. run은 primary가 문서화된 진입인 `ralplan start`를 호출할 때 시작합니다(GJC의 `gjc ralplan "<task>"`).

안내(ralplan 안내, deep-interview magic guide, ultragoal restore banner, breaker 메시지)는 함께 일어나는 state 쓰기가 있으면 그 뒤에 `ctx.session.synthetic({ resume: false })` 메시지로 기록됩니다. host는 synthetic 메시지를 같은 턴의 user 메시지 **앞**에 배치합니다. OMC/v1은 뒤에 덧붙였으므로 이는 기록된 host 배치 차이이며, 설계 선택이 아닙니다. `synthetic` 자체가 실패하면 안내가 사라지지 않도록 marker로 감싼 채 prompt 텍스트에 덧붙입니다. state 쓰기는 어느 쪽이든 유지됩니다.

**`ralplan` 도구**는 ralplan state, run의 단계 파일, 사이드바가 읽는 파일의 유일한 기록자입니다. `state_*` 도구는 더 이상 `mode: "ralplan"`을 받지 않으며 deep-interview 전용입니다. op는 GJC의 CLI·state 동사에 대응합니다.

| Op | 호출자 | 동작 |
|---|---|---|
| `start(task, interactive?, deliberate?, run_id?)` | primary | 새 state(`active: true`, phase `planner`, `mode` short 또는 deliberate)를 쓰고 `session_id`, `run_id`, `state_path`, `repository_binding`이 담긴 영수증을 돌려줍니다. ultragoal 실행 중에는 거부됩니다. |
| `write(stage, stage_n, content \| path, run_id?, lane_verdict?, resumable?, fallback_*)` | primary, planner, architect, critic | 단계 산출물 하나를 저장하고 평문 영수증(`path`, `sha256`, `stage`, `stage_n` 등)을 돌려줍니다. |
| `status(fields?)` | primary, planner, architect, critic | `{skill, state, storage_path}`를 돌려줍니다. `fields`는 state 필드를 골라 보여줍니다. |
| `doctor` | primary | `schema_violation`과 `stale_active_state`를 보고하며 아무것도 고치지 않습니다. |
| `state(patch)` | primary, planner, architect, critic | patch를 병합합니다(`null`은 필드 삭제). phase 변경은 GJC 전환 규칙표를 따라야 합니다. Stop here는 `patch={"active": false}`입니다. |
| `handoff(to="ultragoal")` | primary | 승인된 plan을 ultragoal에 넘깁니다(아래). |
| `clear(force?)` | primary | `{active: false, current_phase: "complete"}`로 두고 파일과 `run_id`는 유지합니다. `force` 없이는 GJC처럼 손상된 state, 이미 종료 해제 phase(`complete` 등)인 state, 잠기지 않은 phase에서 활성 행 phase가 그와 다른 state를 거부합니다(`final` 같은 잠긴 phase에서는 GJC가 행의 phase를 state의 phase로 읽으므로 final 이후 다듬기 중의 clear는 통과). 활성 행 파일을 읽을 수 없어도 멈춥니다(deviation 35). |

모든 op는 호출 세션의 계보 루트를 대상으로 하므로, 역할의 하위 세션도 루트 세션 폴더에 기록합니다. run 폴더는 명시한 `run_id`, 그다음 state의 `run_id`, 그다음 루트 세션의 native ID(예: `ses_f4b081a27ffe…`)입니다. 명시하는 `run_id`는 `A-Z a-z 0-9 . _ -` 1~64자이고, `.`으로 시작하거나 `..`을 포함할 수 없습니다. `open-gajae-explore`, `open-gajae-document-specialist`, `open-gajae-executor`, `open-gajae-cleaner`에서는 이 도구가 거부되고 숨겨집니다. `build`/`general` 같은 host agent와 사용자 정의 agent에는 보일 수 있지만 호출하면 거부됩니다.

```text
<worktree>/.open-gajae/
  _session-<created>-<session-id>/
    plans/ralplan/<run-id>/
      stage-01-planner.md
      stage-01-intent.md
      stage-01-architect.md
      stage-01-critic.md
      stage-02-revision.md
      …
      stage-NN-final.md
      index.jsonl
      pending-approval.md
    state/ralplan-state.json
    state/ralplan-continuation.json
    state/audit.jsonl
    state/active/ralplan.json
    state/skill-active-state.json
```

- **단계 파일.** 단계는 `planner`, `intent`, `architect`, `critic`, `disposition`, `revision`, `post-interview`, `adr`, `final`이고 `stage_n`(1~999)은 회차 번호입니다. write마다 불변 파일 `stage-NN-<stage>.md`를 만들고 run의 원장 `index.jsonl`에 `{stage, stage_n, path, created_at, sha256}` 한 줄을 추가합니다. `final` 줄에는 `auto_handoff`도 들어갑니다. `final`은 `pending-approval.md`로 복사되며 다음 `final`이 이를 덮어씁니다. 링크 규칙, 자동 목차, 자동 머리말은 없습니다.
- **멱등 기록.** 같은 `(stage, stage_n)`에 같은 내용을 다시 쓰면 앞의 영수증을 `deduplicated: true`와 함께 돌려주고(빠진 원장 줄은 복구), 다른 내용은 "Use a new stage_n to record another pass."로 거부합니다.
- **역할은 content로만 기록.** planner, architect, critic은 산출물 전체를 `content`로 넘기고 primary에게는 영수증만 돌려줍니다. primary는 `content`를 넘기거나, 프로젝트 밖 OS 임시 루트(`os.tmpdir()`, `$TMPDIR`, `/tmp`, `/var/tmp`와 그 `/private` 별칭) 아래 파일의 `path`를 넘길 수 있습니다.
- **Disposition.** Architect와 Critic의 지적이 충돌하면 revision 전에 `disposition` 단계(JSON, GJC `ralplan.review_conflicts.v1` 스키마)가 충돌마다 처리를 정해야 합니다. 도구는 근거 영수증을 run 원장과 대조해, 미처리·알 수 없는·불일치 항목을 거부합니다.
- **기록 관리.** `state/audit.jsonl`에는 파일 변경 1건당 한 줄이 남습니다. `state/active/ralplan.json`과 스냅숏 `state/skill-active-state.json`은 사이드바용 활성 행과 칩을 담습니다. `state/ralplan-continuation.json`은 continuation breaker 카운터만 담습니다.

**예산과 PLANNING-STUCK.** 한 run이 여는 회차(planner·revision opener)는 최대 `ralplan.maxIterations`(기본 5)이며, `index.jsonl`과 디스크의 단계 파일 중 큰 쪽으로 셉니다. 레인마다 열린 회차당 architect 또는 critic 기록은 `ralplan.maxReviewPassesPerLane`(기본 1)까지입니다. 어느 예산이든 넘는 write는 오류 대신 `PLANNING-STUCK` 결과(`ok: false`, `planning_stuck: true`, `marker: "PLANNING-STUCK"`)를 돌려주고 state에 `planning_stuck`을 기록합니다. 이미 열린 회차 안의 architect·critic 기록과 `post-interview`, `adr`, `final`은 계속 허용되어 가장 나은 plan을 `pending approval`로 남길 수 있습니다. 막힌 run의 `final`은 `auto_handoff`를 사유 `planning_stuck`과 함께 `off`로 해석하며 절대 인계되지 않습니다. 새 `run_id`는 새 폴더와 새 예산으로 시작합니다.

**합의 흐름.** skill은 GJC의 9단계를 따릅니다. planner가 초안을 씁니다(`planner`, 1회차). primary가 중요한 의도를 사용자와 맞추고(`intent`, native `question` 한 번에 하나씩), 계약이 바뀌었으면 planner를 재개해 `revision`을 씁니다. architect와 plan-only critic은 1회차를 병렬로 검토하고(한 메시지 안의 `subagent` 호출 두 개) `lane_verdict`(`CLEAR`/`WATCH`/`BLOCK`, `OKAY`/`ITERATE`/`REJECT`)를 기록합니다. 2회차부터는 같은 planner·architect·critic 세션을 재개하고(기록된 `sessionID`로 `subagent`) architect → critic 순서로 검토합니다. 합의 뒤 primary는 새로 생긴 의도 차이를 사용자와 확인하고(`post-interview`) ADR을 포함한 `final`을 씁니다. `--interactive`는 초안 검토를 추가합니다. `--deliberate`는 pre-mortem과 확장된 test plan을 추가하며, 명시적 고위험 신호에서 자동으로 켜집니다. 질문이 열려 있는 동안은 continuation이 발화하지 않습니다 — native `question` 도구가 답이 올 때까지 실행을 붙잡고 있어서 그동안 `session.execution.succeeded`가 발행되지 않기 때문입니다.

도구는 역할이 write할 때 그 역할 자신의 세션 ID(`planner_subagent_id`, `architect_id`, `critic_id`)를 기록해 primary가 재개할 수 있게 합니다. 재개가 실패하면 primary는 새 역할 세션을 띄우고 `fallback_reason`, `fallback_attempted_id`, `fallback_stage_n`을 기록합니다.

**승인, Stop here, 인계.** `final`이 `auto_handoff.effectiveTarget`을 `ultragoal`로 해석하면(`ralplan.autoHandoff: "ultragoal"` 설정, 막히지 않은 run) primary는 묻지 않고 인계합니다. 그 밖에는 **Refine further**, **Approve execution via ultragoal (Recommended)**, **Stop here**와 자유 입력을 담은 `question` 하나를 엽니다. 사용자가 승인하거나 같은 턴에서 이미 ultragoal을 지목하지 않으면 plan은 `pending approval`로 남습니다.

- **Refine further**는 재검토 루프로 돌아갑니다.
- **Stop here**는 `ralplan state(patch={"active": false})`입니다. phase는 `final` 그대로, `pending-approval.md`는 보존되고, 활성 행이 제거되어 사이드바가 숨습니다. 나중에 ultragoal을 요청해도 진행됩니다.
- **Approve execution via ultragoal**: primary가 `ralplan handoff(to="ultragoal")`를 호출하고 `ultragoal` skill을 불러와 `source_plan`을 `pending-approval.md` 경로로 넣어 `create`를 호출합니다(미완료 goal list가 이미 있으면 `resume`). handoff op는 종료 phase(`final`, `handoff`, `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`)를 요구합니다. ralplan을 `{active: false, current_phase: "handoff", handoff_to: "ultragoal"}`로 두고, 활성 행을 제거하며, `handoff_from: "ralplan"`이 담긴 확인된 ultragoal state를 씁니다.
- **ultragoal 진입 게이트.** 루트 세션에서 ultragoal이 실행 중이 아닐 때, `ultragoal` skill 로드, `@ultragoal` mention, `ultragoal start`/`resume`/`create`는 ralplan이 종료가 아닌 phase에서 active이면 거부되고, 종료 phase에서 active이면(예: 승인 질문이 열려 있는 동안의 active `final`) 같은 인계를 먼저 수행합니다.
- **반대 방향.** `ultragoal handoff(to="ralplan", reason)`은 ultragoal을 멈추고(goal과 progress는 삭제되지 않고 유지) 같은 호출에서 reason을 task로 ralplan을 시작하며, 기존 `run_id`를 재사용합니다. 새 run 폴더와 예산이 필요하면 새 `run_id`로 `ralplan start`를 호출하세요. 다시 승인하면 `ultragoal resume`을 호출해 새 plan을 `add`/`revise`/`supersede`로 기존 goal에 병합합니다.

**write 의미(GJC와 같음).** `start` 없이 `write`하면 state를 만듭니다(`active: true`, phase = 기록한 단계, `mode`·`interactive`·repository binding 없음). 새 `run_id`를 명시한 `write`는 run을 전환하며 verdict·stuck·auto-handoff 필드를 초기화합니다. 같은 run에서는 write가 `active: true`로 두고 phase를 기록한 단계로 전진시키지만, phase가 잠겨 있으면(`final`, `handoff`, `complete` 등) state를 전혀 바꾸지 않습니다 — 그래서 Stop here나 `clear` 뒤의 다듬기 write는 run을 다시 활성화하지 않습니다. 다만 write는 활성 행을 다시 쓰므로 다음 Stop here, handoff, clear까지 사이드바에 행이 다시 보입니다. `write`는 ultragoal 실행 중에도 거부되지 않습니다: ultragoal 실행 중 역할이나 primary의 write가 ralplan을 활성화할 수 있고, 그러면 ultragoal이 끝난 뒤 계획 가드가 편집을 막고 진입 게이트가 새 ultragoal을 거부합니다. `ralplan state(patch={"active": false})` 또는 `ralplan clear`로 복구하세요. 가드의 차단 메시지도 이 둘을 안내합니다.

**계획 가드.** 루트 세션의 ralplan state가 `active: true`이고 phase가 `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`가 아니면 — 즉 `final`과 `handoff`도 active인 동안은 막습니다 — 그 세션 계보의 모든 agent의 `write`, `edit`, `patch`를 거부합니다. 대상이 모두 프로젝트 밖 OS 임시 루트 아래일 때만 통과합니다. 루트 세션에서 ultragoal이 실행 중이면 가드는 적용되지 않으며, `shell` 명령은 검사하지 않습니다. 계획 중 deep-interview spec 저장도 막히지만, deep-interview bridge는 `ralplan start` 전에 spec을 저장하므로 정상 흐름에는 영향이 없습니다. 가드와 별개로, 세션 폴더의 `plans/ralplan/**`와 `state/**`, 그리고 ultragoal 소유 파일에 대한 `write`, `edit`, `patch`는 모든 agent에게 항상 거부되며 도구만 이들을 바꿉니다.

continuation은 ralplan state가 active이고 종료 phase가 아니며 `planning_stuck`이 아닌 동안 durable `session.execution.succeeded` 이벤트(v2는 `session.idle`을 발행하지 않습니다)에서 `ctx.session.synthetic({ resume: true })`로 세션에 다시 프롬프트를 넣습니다. circuit breaker는 30회 주입에서 멈추고, `state/ralplan-continuation.json`에 두는 breaker 카운터는 45분이 지나면 만료됩니다 — v1과 같은 상수입니다. 소진되면 ralplan을 `active: false`로 두고 감사 로그에 한 줄을 남깁니다. 사용자가 턴을 중단하면 — `session.execution.interrupted`의 reason이 `user`(Esc 또는 interrupt API) 또는 `shutdown`(취소된 `question` form, 그리고 reason 없는 interrupt의 host 기본값)이면 — stop mark가 설정되고, 다음 실제 user 프롬프트만 이를 지웁니다. `inactivity`와 `superseded`는 mark를 설정하지 않습니다. continuation은 현재 세션 아래에서 실행 중인 background subagent 세션(`background: true`로 실행됨)이 있으면 `session.created`/`session.execution.started`/terminal 이벤트를 `parentID`로 추적해 건너뜁니다(OMC/OMO parity; v1에는 대응 사례가 없었습니다). 그런 child가 끝나면 host 자체의 subagent-completion synthetic이 parent를 재개하고, 그 뒤의 `succeeded`는 같은 breaker로 다른 succeeded와 동일하게 판단됩니다. v2 플러그인 인스턴스는 location마다 하나씩 만들어지지만 공유 서버는 모든 인스턴스에 모든 이벤트를 전달하므로, 이 플러그인은 자기 location과 일치하는 세션에만 동작합니다 — v2에서 새로 생긴 사실이며 위 결정들을 바꾸지는 않습니다.

host가 ralplan state가 active인 세션을 압축하면, 플러그인은 현재 plan의 목표, 범위, 비목표, 수용 기준, Intent Reconciliation, 다음 행동을 담은 `<ralplan-compaction-context>` 블록 하나를 압축 프롬프트에 추가합니다. state가 비활성이거나 손상되었거나 산출물의 sha256이 원장 줄과 맞지 않으면 추가하지 않습니다. state는 세션별이므로 세션 간 복원은 없고, ralplan restore 안내도 없습니다.

**알려진 동작(GJC와 같음).** 잠긴 phase에서 write하면 — `final` 이후의 다듬기, 또는 Stop here나 `clear` 뒤의 write — 활성 행의 phase는 방금 쓴 단계가 되고 state의 phase는 `final` 또는 `complete`로 남습니다. 이때 원본 행 파일을 읽는 `ralplan doctor`는 GJC처럼 `stale_active_state`를 보고하고 해결 명령으로 `ralplan clear`를 제시합니다. `clear`는 잠긴 state의 phase를 행의 phase 대신 읽으므로 그 `force` 없는 `ralplan clear`는 GJC처럼 성공합니다. 예상된 동작이므로 이 보고만으로 `ralplan clear`를 호출하지 마세요. clear는 run을 끝냅니다.

**알려진 동작(GJC와 같음): 전환 감사 행.** 현재 phase에서 표의 간선이 아닌 단계를 write해도 성공하며, `state/audit.jsonl`에 `invalid_transition_detected` 행 하나만 추가됩니다(spec D-T11). 표에 `planner→critic`, `critic→architect` 간선이 없고 두 리뷰 레인은 어느 순서로든 기록되므로, 1회차 병렬 리뷰에서도 이런 행이 흔히 생깁니다.

**사이드바.** 별도 TUI 플러그인 `tui-plugin/`이 `state/skill-active-state.json`을 약 1초마다 폴링해 세션 사이드바(`sidebar.content`)에 `ralplan` 블록을 그립니다. `~/.config/opencode/cli.json`에 `{"plugins": ["/Users/dongwuk/apps/open-gajae/tui-plugin"]}`처럼 디렉터리를 등록하세요. 자세한 내용은 [`docs/local-install-v2.md`](docs/local-install-v2.md)를 참고하세요. state의 phase가 잠겨 있는 동안(`final`, `handoff`, `complete` 등) `stage` 칩은 GJC HUD처럼 방금 쓴 단계 대신 그 phase를 보여줍니다(GJC `skill-state/active-state.ts:507-545`). 행 파일 자체에는 방금 쓴 단계가 남습니다. 블록은 행의 칩을 한 줄에 하나씩 `label=value`로 보여줍니다 — `pending=approval`, `stage`, `iter`, `stages`(`revision · architect · critic`처럼 단계 전체 이름), `arch=n/max`, `crit=n/max`, `verdict`, `handoff`, 최대 6개. 오류와 차단은 테마의 error 색, 경고는 warning 색, `CLEAR`/`OKAY`/`APPROVE` verdict는 success 색입니다. ralplan 행이 active이거나 `pending` 칩이 있는 동안 보이고, Stop here, handoff, clear에서 숨습니다. 로컬 파일만 읽으므로 원격 서버에 attach한 TUI에서는 아무것도 보이지 않습니다.

## 자체 역할과 설정

- **`open-gajae`**: primary입니다. 수정, 결정, 통합, state write/clear를 소유합니다. host 기본값 외에 추가 rule은 없습니다.
- **`open-gajae-explore`**: repository 사실을 읽기 전용으로 조사합니다. edit, delegation(`subagent`), question, state write/clear를 할 수 없습니다. `shell`은 전체 허용됩니다(OMC parity — 어떤 역할에도 `shell`/Bash rule을 추가하지 않습니다).
- **`open-gajae-document-specialist`**: 문서와 인용 근거를 조사합니다. edit, delegation, question, state write/clear를 할 수 없습니다. `chub` 절차는 프롬프트에서 읽기 전용으로 문서화되어 있으며, host permission rule이 `shell`을 `chub` 명령으로 제한하지는 않습니다.
- **`open-gajae-planner`**, **`open-gajae-architect`**, **`open-gajae-critic`**: ralplan 합의 역할입니다. 세 역할 모두 `mode: subagent`이고 기본 모델은 없으며 설정의 `agents` 맵으로만 지정합니다. 프롬프트는 GJC의 planner·architect·critic 역할에 host 치환을 적용한 것입니다. 세 역할 모두 편집할 수 없습니다: 각자 단계 산출물을 `ralplan write`(`content`만)로 기록하고 `ralplan status`와 `ralplan state`를 쓸 수 있으며, `edit`와 `question`, `state_write`, `state_clear`는 거부됩니다. architect와 critic은 `subagent`도 거부됩니다. planner는 조사를 위임합니다: `subagent` 권한은 `open-gajae-explore`와 `open-gajae-document-specialist`만 허용합니다. `question`, `state_write`, `state_clear`, 그리고 Code Mode의 두 세션 도구(`opencode_session_move`, `opencode_session_rename`)는 일곱 subagent 역할 모두에서 거부됩니다. `subagent_depth`는 플러그인이 올리지 않습니다. host 설정에 `experimental.subagent_depth: 2`를 직접 넣으세요(설치 참고).
- **`open-gajae-executor`**(OMC `agents/executor.md` 이식): `ultragoal`의 goal 하나씩을 구현합니다. `question`이 거부되어 사용자에게 물을 수 없고 `ultragoal` 도구도 쓸 수 없습니다. delegation은 코드베이스 조사용 `open-gajae-explore`와, 같은 문제를 반복 실패했을 때의 `open-gajae-architect`로만 제한됩니다. `edit`과 `shell`은 유지합니다.
- **`open-gajae-cleaner`**(OMC `ai-slop-cleaner` skill을 읽기 전용 리뷰어로 재구성): `ultragoal`의 필수 정리 검토로, 모든 goal이 검증된 뒤 최종 critic 리뷰 전에 한 번 실행됩니다. edit·write·patch·delegation·question·state write/clear·`ultragoal` 도구가 모두 거부됩니다. `shell`은 점검용으로 유지하며 파일과 줄 번호를 붙여 `BLOCKING`/`NON-BLOCKING` 항목을 보고할 뿐 아무것도 바꾸지 않습니다.
- `ultragoal` 안에서는 `open-gajae-architect`와 `open-gajae-critic`만 `ultragoal` 도구를 추가로 가지며 `status`로 제한됩니다. 판정은 응답으로 돌려주고, primary가 `record_verdict`로 기록합니다(gajae-code처럼 리더가 기록). 그 외 모든 자체 역할은 `ultragoal`이 거부됩니다.

역할 rule은 각 agent의 `permissions` 배열에 host 기본값 뒤에 추가되지만, **여러분의 host `agents.<id>` permission rule은 플러그인 것보다 뒤에 적용되어 우선합니다** — v1이 순서를 바꿔 mandatory deny를 지켰던 것과 달리, host override가 역할의 기본 deny를 완화할 수 있습니다(기록된 deviation: "user config wins"). 설정은 `~/.open-gajae/open-gajae.jsonc`와 `<worktree>/.open-gajae/open-gajae.jsonc`에서 읽습니다. field는 project → user → defaults 순으로 병합됩니다. 알 수 없는 key, 잘못된 JSONC, 잘못된 값은 진단과 함께 실패합니다.

모호성 임계값의 기본값은 `0.1`(10%)입니다. 사용자 요청으로 명확성 기준을 강화한 것으로, 고정된 OMC 기준 버전의 기본값 `0.2`(20%)와 다릅니다. 이는 호스트 제약에 따른 차이가 아닌 제품 선택이며, 명시적인 설정값은 기본값보다 우선합니다.

```jsonc
{
  "deepInterview": { "ambiguityThreshold": 0.1, "maxRounds": 20 },
  "ultragoal": {
    // 0이면 무제한, 기본 200
    "hardMaxIterations": 200
  },
  "agents": {
    "open-gajae": { "model": "provider/model", "variant": "variant-name" },
    "open-gajae-planner": { "model": "openai/gpt-6-luna" },
    "open-gajae-architect": { "model": "openai/gpt-6-luna", "variant": "high" },
    "open-gajae-critic": { "model": "openai/gpt-6-luna", "variant": "high" },
    "open-gajae-executor": { "model": "openai/gpt-6-luna", "variant": "medium" },
    "open-gajae-cleaner": { "model": "openai/gpt-6-luna", "variant": "medium" }
  },
  "ralplan": { "maxIterations": 5, "maxReviewPassesPerLane": 1, "autoHandoff": "off" }
}
```

`ultragoal.hardMaxIterations`는 `0` 이상의 정수입니다. `0`이면 무제한이고 기본값은 `200`입니다(continuation iteration의 hard ceiling입니다. `max_iterations`가 이 값까지 연장되면 loop가 멈추고 보고합니다. 아래 goal별·최종 리뷰와는 별개입니다).

| 설정 | 기본값 | 의미 |
|---|---|---|
| `ralplan.maxIterations` | `5` | 한 run이 열 수 있는 planner·revision 회차, `1..20` 정수 |
| `ralplan.maxReviewPassesPerLane` | `1` | 열린 회차당 architect 또는 critic 기록 수, `1..10` 정수 |
| `ralplan.autoHandoff` | `"off"` | `"ultragoal"`이면 막히지 않은 `final`을 승인 질문 없이 ultragoal에 인계 |

`ralplan` key도 다른 field처럼 key별로 병합되며, 플러그인이 location에서 setup될 때 한 번만 해석됩니다. 바꾼 뒤에는 host를 재시작하세요. `final` 영수증의 `auto_handoff.source`는 `autoHandoff` 값이 이긴 파일 경로 또는 `default`입니다.

`variant`는 같은(이미 병합된) entry에 `model`이 있어야 합니다: user 레벨 `model` + project 레벨 `variant`는 유효하지만, `variant`만 있거나(한 파일에서든 양쪽에 나뉘어서든) 어디에도 `model`이 없으면 agent 이름과 `model "provider/model"` 추가 요청을 담은 오류로 거부됩니다. 이는 그런 variant를 진단만 남기고 조용히 버리는 v2 host보다 더 엄격합니다. provider fallback, tier mapping, 인위적 collision 거부는 없습니다. v1의 `companyContext` 설정은 사라졌습니다 — 지금 넣으면 `unknown setting`으로 실패합니다.

`ultragoal`은 완료 주장 하나를 그대로 믿지 않고 검증을 여러 층으로 쌓습니다. 각 goal은 새 `open-gajae-architect` 세션이 그 goal의 acceptance criteria만 보고 검증하고, primary가 그 `approve`/`reject` 판정을 `record_verdict`로 기록합니다. 모든 goal이 검증되면 필수 읽기 전용 `open-gajae-cleaner` pass가 이번 실행에서 바뀐 파일을 검토하고, blocking finding은 계속 진행하기 전에 고칩니다. 그 정리와 회귀 재검증이 끝난 뒤에야 새 `open-gajae-critic` 세션이 전체 실행을 검토하고, primary가 그 최종 verdict를 기록합니다. loop는 그 최종 critic 승인에서만 끝나며, 어느 층에서든 거부되면 실행을 끝내는 대신 해당 goal을 다시 엽니다. `ultragoal cancel(reason)`은 실행을 포기합니다(state는 삭제되지만 `goals.json`/`progress.txt`는 남아 나중에 `resume`할 수 있습니다). `ultragoal.hardMaxIterations`는 이 전체를 떠받치는 hard ceiling입니다.

## 읽기 전용 코드 도구

플러그인은 읽기 전용 코드 도구 8개를 등록합니다(위의 상태 도구 3개, `ralplan` 도구, `ultragoal` 도구를 더하면 총 13개).

- `ast_grep_search` (`@ast-grep/napi` 0.31.1): AST 검색만 하며 replace는 없습니다.
- `lsp_goto_definition`, `lsp_hover`, `lsp_diagnostics`, `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_servers`.

LSP server는 감지·보고만 하며 자동 다운로드하지 않습니다. LSP rename, code action, replacement suite는 없습니다. 사용 가능한 actor는 여덟 개 자체 역할 전체입니다 — `open-gajae`, `open-gajae-explore`, `open-gajae-document-specialist`, `open-gajae-planner`, `open-gajae-architect`, `open-gajae-critic`, `open-gajae-executor`, `open-gajae-cleaner` — OMC와 동일하게 모든 agent가 읽기 전용 LSP/AST 도구를 사용할 수 있습니다. project 경계는 v1의 call마다 host permission을 묻던 방식을 대체합니다: input 경로를 host의 현재 location 디렉터리 기준으로 해석하고, symlink를 따라가며, 실제 대상이 실제 project 디렉터리 안에 있어야 합니다. `.env`와 `.env.*` 파일은 요청한 이름과 해석된 이름 양쪽에서 거부되며, `ast_grep_search`는 traversal 중에도 건너뜁니다. 두 도구 모두 explorer 권한을 넓히거나 arbitrary shell 실행을 허용하지 않습니다.

source에서 실제 도달하는 제품 환경 변수는 `OPEN_GAJAE_LSP_TIMEOUT_MS`, `OPEN_GAJAE_LSP_IDLE_TIMEOUT_MS`, `OPEN_GAJAE_LSP_IDLE_CHECK_INTERVAL_MS`, `OPEN_GAJAE_LSP_CONTAINER_ID`, `OPEN_GAJAE_PYTHON_LSP=basedpyright`뿐입니다. 일반 설정이 아니라 LSP 구현 설정입니다.

## OMC와 v1 플러그인으로부터의 deviation

아래 표는 OMC 기반 워크플로·역할 또는 그 이전 v1 구현에서 호스트 요구로 바뀐 항목을 기록합니다(AGENTS.md 정책). 이 항목들은 이식의 spec/plan(`.omc/specs/deep-interview-opencode-v2-port.md`, `.omc/plans/ralplan-opencode-v2-port.md`)의 결정으로 추적됩니다. GJC 기반 메인 에이전트 프롬프트는 별도 이식이며([third-party notices](THIRD-PARTY-NOTICES.md) 참고), OMC 기반 ralplan skill·역할 프롬프트·state 시딩을 대체한 GJC 기반 `ralplan`도 별도 이식입니다([GJC로부터의 deviation (ralplan)](#gjc로부터의-deviation-ralplan) 참고).

| Deviation | 내용 |
|---|---|
| 슬래시 커맨드 없음 | v1의 `/deep-interview`와 `/ralplan`이 사라졌습니다. 명시적 자연어 요청 또는 지원되는 skill mention·키워드로 요청한 skill에 진입하며, heuristic 추천은 사용자의 선택이 필요합니다. |
| company context 제거 | `companyContext` 설정, runtime-settings block 항목, deep-interview/ralplan의 step-0 지시, `tests/company-context-probe.ts`가 문서화 누락이 아니라 완전히 사라졌습니다. |
| `subagent_depth`는 host 설정 | v2 플러그인 API에는 config를 수정하는 domain이 없어 v1처럼 플러그인이 직접 올릴 수 없습니다. `experimental.subagent_depth: 2`를 직접 넣으세요. 값이 없으면 planner가 직접 조사로 fallback합니다. |
| host 설정이 역할 rule보다 우선 | host `agents.<id>` permission rule이 플러그인 것보다 뒤에 적용되어, v1의 rule 재정렬 트릭과 달리 역할의 기본 deny를 완화할 수 있습니다. |
| explore·document-specialist는 shell 전체 허용 | OMC parity: 어떤 역할에도 `shell`/Bash permission rule을 추가하지 않습니다. |
| "Bash"를 `shell`로 표기 | 모든 prompt와 skill이 "Bash" 대신 v2 도구 이름 `shell`을 씁니다. |
| deep-interview → ralplan bridge가 input field 대신 skill을 이름으로 지칭 | OMC 스타일 문장("`ralplan` skill을 … context로 호출")을 씁니다. v2 `skill` 도구의 input은 `{ id }`뿐이라, 첫 추측이 틀리면 host input error로 한 번 재시도가 발생할 수 있습니다. |
| 안내는 실패했을 때만 prompt 텍스트에 덧붙임 | 안내는 state 우선으로 쓴 뒤 `synthetic` 메시지로 보냅니다. `synthetic` 자체가 거부되면 (marker로 감싼) 안내를 prompt 텍스트에 덧붙여 사라지지 않게 합니다. |
| 안내가 user 메시지 앞에 옴 | host는 `synthetic` 안내를 같은 턴의 user 메시지 앞에 배치합니다. OMC/v1은 뒤에 덧붙였습니다. 설계 선택이 아니라 host 배치 사실입니다. |
| 삽입 메시지의 TUI 표시 | TUI는 `description`이 없는 `synthetic` 메시지를 표시하지 않습니다. 플러그인이 넣는 모든 안내와 continuation에 한 줄 설명(예: `open-gajae: ralplan keyword notice added`, `open-gajae: ralplan continuation 1/30`)을 붙여 사용자가 삽입 사실을 볼 수 있게 합니다. 본문은 OMC처럼 모델에게만 전달됩니다. |
| 빌드 없는 TS 소스 패키징 | 루트 `index.ts`와 `package.json`의 `exports["."]`가 `./src/index.ts`를 가리킵니다. `dist/`와 build script는 사라졌습니다. |
| `model` 없는 `variant`는 설정 오류 | user+project 병합 뒤 agent 이름을 담은 오류로 거부됩니다 — variant를 진단만 남기고 조용히 버리는 v2 host보다 엄격합니다. |
| continuation이 durable execution 이벤트에서 동작 | `session.execution.succeeded`가 v2에서 발행하지 않는 `session.idle`을 대체합니다. |
| continuation이 background subagent를 기다림 | `background: true`로 실행 중인 child 세션이 있으면 `parentID`와 execution 이벤트로 추적해 건너뜁니다(OMC/OMO parity; v1에는 대응 사례가 없었습니다). |
| interrupt 처리가 reason 기반 | `user`와 `shutdown`은 다음 실제 프롬프트만 지우는 stop mark를 설정하고, `inactivity`/`superseded`는 설정하지 않습니다. background child 완료 뒤 host가 유발한 재개는 같은 breaker로 다른 `succeeded`와 동일하게 판단됩니다. |
| location별 이벤트 필터링 | v2 플러그인 인스턴스는 location마다 만들어지지만 공유 서버가 모든 인스턴스에 모든 이벤트를 전달하므로, 이 플러그인은 자기 location과 일치하는 세션에만 동작합니다. v2에서 새로 생긴 사실이며 R-decision을 바꾸지 않습니다. |
| artifact guard가 throw 대신 input 무효화로 차단 | `execute.before`가 차단할 호출의 input을 `{}`로 바꿔 host의 decode 자체를 실패시키고, `execute.after`가 그 오류를 모델이 이해할 안내로 다시 씁니다. ralplan 계획 가드, 항상 차단되는 `plans/ralplan/**`·`state/**` 경로, `skill` 로드에 대한 ultragoal 진입 게이트의 거부도 같은 방식입니다. Promise-hook throw는 대신 host defect로 나타났을 것입니다. |
| code-tool 경계가 host ask 대신 realpath containment | host의 현재 location 기준으로 해석하고, symlink를 따라가며, 실제 project 디렉터리 안에 있어야 하고, `.env`/`.env.*`를 제외합니다 — v1의 call마다 permission을 묻던 방식을 대체합니다. |
| LSP surface가 도구 4개에서 7개로 확장 | `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_servers`에 `lsp_goto_definition`, `lsp_hover`, `lsp_diagnostics`가 추가되었습니다. |
| `@deep-interview` mention도 magic notice를 받음 | OMC parity입니다. v1은 명시적 호출에서 안내를 억제했습니다. |
| `@ralplan` mention도 안내를 받음 | mention 안내는 skill이 이미 붙었음을 알립니다. 키워드 안내처럼 ralplan state를 쓰지 않으며, run은 `ralplan start`에서 시작합니다. OMC도 명시적 호출에 안내를 붙이며, 문구는 host 추가분입니다. 사용자가 모든 삽입을 볼 수 있도록 추가했습니다. |
| ralplan restore 안내 제거 | OMC 유래 `[RALPLAN MODE RESTORED]` 안내, 그 prompt hook 분기, `restored_at` 기록을 삭제했습니다. seed가 `started_at`과 `restored_at`을 같게 기록해 정상 흐름에서는 발동하지 않았고, GJC에는 이런 안내가 없으며, 문맥 손실은 압축 복구(`<ralplan-compaction-context>`)가 담당합니다. 재개한 세션에 ralplan 안내는 없고, ultragoal restore banner는 유지됩니다. |
| 설치 문서가 디렉터리 plugin 형태만 보여줌 | 일부 host 문서는 파일 경로 `plugins` 예시를 보여주지만, v2 host는 실제로는 파일 경로로 설정된 plugin 항목을 건너뜁니다. |

## GJC로부터의 deviation (ralplan)

출처: GJC v0.17.7 커밋 `5c5231418930673e42cc5d08ebe4376e03187533`(MIT). ralplan skill, 세 합의 역할 프롬프트, `src/ralplan-runtime/`은 아래 행이 달리 적지 않는 한 GJC ralplan 계약을 따릅니다(AGENTS.md 정책: 출처, deviation, 이유, 영향). GJC 경로는 `gajae-code/packages/coding-agent/src/` 기준이며 `SKILL.md`는 `defaults/gjc/skills/ralplan/SKILL.md`입니다. OpenCode 경로는 `opencode/packages/` 기준입니다. 결정 ID(`D-…`, `DR-…`, `R-…`)는 이식의 spec과 plan(`.omc/specs/deep-interview-ralplan-gjc-stage-trail.md`, `.omc/plans/ralplan-gjc-stage-trail.md`)을 가리킵니다. 행 번호는 skill과 프롬프트의 source 섹션이 인용하는 plan 번호를 그대로 씁니다. 18행은 `stage` 칩이 GJC를 따르게 되어(행에는 방금 쓴 단계를 기록하고, 잠긴 state phase가 있으면 표시할 때 그것으로 바꿈) 철회했으며 번호는 다시 쓰지 않습니다.

| # | Deviation | GJC 출처 | 이유 | 영향 |
|---|---|---|---|---|
| 1 | CLI 명령(`gjc ralplan`, `gjc state ralplan`)이 `ralplan` 도구 op가 되고, flag는 입력이 되며, exit code 3과 2는 `PLANNING-STUCK` 결과와 오류가 됩니다. | `gjc-runtime/ralplan-runtime.ts:2483-2496`, `gjc-runtime/state-runtime.ts` | OpenCode 플러그인 host이며 GJC CLI가 없음 | 동사는 1:1로 대응 |
| 2 | 산출물 본문을 bash 환경 변수로 넘기지 않습니다: 역할은 `content`, primary는 `content` 또는 OS 임시 `path`. | `SKILL.md:44-51`, `gjc-runtime/restricted-role-agent-bash.ts`, `tools/bash.ts:1331-1351` | OpenCode shell에는 GJC의 `env` 산출물 기능이 없음 | 역할용 제한 shell이 필요 없음. 역할에는 GJC처럼 파일 경로 입력이 없음 |
| 3 | 저장 루트 `.gjc/_session-<id>` → `.open-gajae/_session-<created>-<id>`. | `gjc-runtime/session-layout.ts:71-78` | 기존 세션 폴더 규칙(`src/state.ts`) | 경로만 다름 |
| 4 | 설정이 `.gjc/config.yml`에서 `open-gajae.jsonc` `ralplan.*`로 옮겨지고, write마다가 아니라 플러그인 setup 때 한 번 해석됩니다(DR-13). | `SKILL.md:134-161`, `gjc-runtime/ralplan-runtime.ts:414-437` | 기존 설정 파일과 로더(`src/index.ts`) | key·범위·project 우선 순위는 같음. 변경은 host 재시작 후 반영. `source`는 이긴 파일 경로를 읽은 그대로 보여주며, GJC는 정규(realpath) 경로를 보고함 |
| 5 | 역할 세션 ID flag(`--planner-id` 등)를 자동 기록으로 대체하고, 역할별 `--*-resumable` flag를 `resumable` 입력 하나로 대체합니다. | `SKILL.md:201-209`, `gjc-runtime/ralplan-runtime.ts:1113-1208` | host가 `context.sessionID`를 제공 | ID 전달 실수가 없어짐 |
| 6 | `autoresearch` 자동 인계 대상 없음. | `gjc-runtime/ralplan-runtime.ts:103-112` | autoresearch skill이 없음 | `autoHandoff`는 `off` 또는 `ultragoal` |
| 7 | `--architect/--critic openai-code` 없음. | `gjc-runtime/ralplan-runtime.ts:614-615` | 역할 모델은 `agents` 설정으로 지정 | run별로 리뷰어 모델을 바꿀 수 없음 |
| 8 | 승인 질문에 `workflowGate` 표식 없음. | `SKILL.md:110` | OpenCode `question`에 해당 필드가 없고(`core/src/tool/plugin/question.ts:23-25`) 시간초과 자동 선택도 없음 | 원격 workflow-gate 이벤트 없음 |
| 9 | HUD가 파일 폴링으로 그리는 TUI `sidebar.content` 블록이 되고, `stages` 칩은 단계 전체 이름을 씁니다. | `skill-state/workflow-hud.ts:188-245`, `gjc-runtime/ledger-event-renderer.ts:156-166`, `modes/components/skill-hud/render.ts:43-64` | host UI 차이, 관리자 선택 | 최대 약 1초 지연, 원격 attach 미지원. `stages` 칩은 여섯 단어가 칩 값 80자 제한을 넘으면 더 적은 단어를 보이며 단어를 자르지 않음. 칩은 한 줄에 하나씩 그리며, `success` severity(`CLEAR`/`OKAY`/`APPROVE`)는 success 색으로 그림(GJC renderer는 dim으로 둠) |
| 10 | OMC continuation을 유지하며, 종료 phase·`PLANNING-STUCK`·`active: false`에서 멈춥니다. | (GJC에 없음) | 관리자 선택 | 멈춘 계획 턴이 breaker 한도 안에서 자동 재개 |
| 11 | 계획 가드가 `shell`의 변경 명령을 판별하지 않습니다. | `skill-state/workflow-mutation-guard.ts:1475-1610` | 명령 판별의 비용과 정확도 | 계획 중 `shell`을 통한 수정은 프롬프트로만 억제 |
| 12 | `repository_binding`은 가능한 값만 기록하고 강제하지 않습니다. | `gjc-runtime/ralplan-runtime.ts:905-978` | 플러그인이 경로를 직접 해석 | 다른 worktree에서의 쓰기를 거부하지 않음 |
| 13 | `doctor`에 checksum·orphan journal 점검이 없습니다. | `gjc-runtime/state-runtime.ts:317,466-500` | checksum과 인계 저널이 없음 | 점검 항목 축소 |
| 14 | 활성 스킬 행은 ralplan만 기록합니다. | `skill-state/active-state.ts` | 다른 skill은 재설계가 필요 | 필수 후속 개발 |
| 15 | 역할 프롬프트는 GJC, ultragoal 리뷰어 brief는 OMC 기반 유지(OQ1). | `prompts/agents/*.md` | 관리자 결정: 단계적 개정 | 알려진 충돌 5개(필수 후속 개발 참고) |
| 16 | 사이드바는 `cli.json`에 등록하는 별도 `tui-plugin/` 디렉터리입니다: 자동 결합 없음, 빌드 없음, OMO 폴링 패턴(OQ2). | GJC 내장 TUI | host는 서버 플러그인 디렉터리 안의 `tui` 진입을 자동 결합함(`plugin/src/host.ts:17-44`). 관리자가 별도 등록을 선택 | 사용자 등록 1단계 |
| 17 | state 봉투에 GJC `receipt`·checksum·`state_revision`이 없고 StateStore `_meta`를 유지합니다. 활성 행의 `source_state_revision`, 스냅숏의 `state_revision`, GJC revision·stale-skip 로직도 생략합니다(R-OD6). | `gjc-runtime/state-writer.ts:1003-1067`, `skill-state/workflow-state-contract.ts:23-40`; revision `gjc-runtime/state-writer.ts:446-472,852-857,1354-1360`, `skill-state/active-state.ts:85,858,943` | 13과 같은 이유와 StateStore 소유자 검사. ralplan 쓰기는 모두 한 프로세스의 소유 세션 큐 하나를 거치므로 순서가 뒤바뀌지 않음(여러 프로세스는 알려진 한계) | state·행·스냅숏 key 일부가 다름(형식 호환 범위 밖). `doctor`의 `stale_active_state`는 revision이 아니라 phase와 active 플래그를 비교하므로 영향 없음 |
| 19 | `ralplan handoff`가 ralplan 활성 행을 제거합니다(`clear`도 GJC처럼 제거). | `skill-state/active-state.ts:868,969-1014`(GJC handoff는 `handoff_to`를 담은 비활성 호출자 행을 남김) | spec AC14 | handoff에서 사이드바가 숨고, 인계 대상은 행이 아니라 ralplan state(`handoff_to`)에 남음 |
| 20 | 압축 복구 텍스트에 `Intent Reconciliation:` 줄을 추가하고(DR-14), ultragoal 압축 문맥처럼 한 줄 머리말을 붙인 `<ralplan-compaction-context>` 블록 하나로 넣습니다. | `session/agent-session.ts:667-710` | spec AC19; host 압축 hook은 marker로 감싼 system 텍스트를 받음 | 복구 문맥이 약간 길어짐 |
| 21 | 감사 `owner` 값은 `open-gajae-runtime`과 `open-gajae-hook`입니다. | `gjc-runtime/state-writer.ts:517-532` | host 이름 | 필드는 같고 값만 다름 |
| 22 | SKILL 9단계의 state 쓰기 + skill 도구 인계가 `ralplan handoff` op 하나가 됩니다(DR-12). | `SKILL.md:118-124`, `tools/skill.ts:200-218` | GJC 자신의 전환 규칙표가 `final`에서의 그 state 쓰기를 거부함(`gjc-runtime/workflow-manifest.ts:241-265`, `gjc-runtime/state-runtime.ts:1335-1341`) | 인계가 op 호출 1회 |
| 23 | 계획 가드가 소유 세션 계보 전체에 적용됩니다(DR-10). | `skill-state/workflow-mutation-guard.ts:325-351` | 역할이 같은 host 프로세스의 하위 세션 | 계획 중에는 executor 등 다른 agent도 차단 |
| 24 | `ultragoal handoff(to="ralplan")`가 같은 도구 호출 안에서 ralplan `start`를 실행합니다: 기존 `run_id`를 유지한 새 start state(task = 인계 사유, `handoff_from: "ultragoal"`)를 저널 없이 순차 트랜잭션 두 개로 씁니다(R-O1). | `gjc-runtime/state-runtime.ts:1739-1763`(필드 보존 병합, 저널 `:1765,1847`) | OpenCode에 교차 skill CLI가 없음, 관리자 결정 | 이전 역할 ID와 verdict는 이어받지 않음. run 폴더와 예산은 재사용. 두 단계 사이에서 실패하면 부분 인계로 남고 결과가 `ralplan start` 또는 `ultragoal resume`을 안내 |
| 25 | 인계 시 ralplan 런타임이 ultragoal state를 기록하며, 소비 표식이 없습니다(R-O2). | `gjc-runtime/state-runtime.ts:1739-1763`, `tools/skill.ts:200-218`, `skill-state/active-state.ts:886-898` | GJC 원자적 인계에 대응, 관리자 수용 | ultragoal 도구만 ultragoal을 기록한다는 원칙의 예외(ultragoal 큐와 검증은 거침). ultragoal 기록이 실패하면 ralplan은 이미 `handoff`이고 결과가 `ultragoal start`를 안내 |
| 26 | OMC continuation 카운터를 훅 전용 `state/ralplan-continuation.json`에 둡니다(R-O3). | (GJC에 없음) | GJC state 봉투에 생명주기 필드를 넣지 않음 | 파일 1개 추가. breaker 소진만 state와 감사 로그에 남음 |
| 27 | ralplan skill과 플러그인 문구는 GJC 승인 라벨을 쓰지만, `skills/ultragoal/SKILL.md`는 여전히 "Execute via ultragoal"입니다(R-O5). | `SKILL.md:112` | 이번에는 ultragoal skill을 바꾸지 않음(OQ1) | 두 skill의 문구 불일치(알려진 문제, 필수 후속 개발) |
| 28 | 가드의 "현재 skill" 판정을 "루트 세션에서 ultragoal 실행 중"으로 근사합니다(R-O7). | `skill-state/workflow-mutation-guard.ts:294-310` | ultragoal은 활성 행을 쓰지 않음 | ultragoal 실행 중에는 계획 편집 보호 없음. 항상 차단 경로는 유지 |
| 29 | ultragoal 진입 게이트는 ultragoal이 실행 중이 아닐 때만 ralplan을 확인합니다(R-O9). | `tools/skill.ts:192-220` | spec AC16 문구보다 GJC 동작을 우선, 관리자 결정 | 실행 중인 ultragoal의 `create`·skill 재로드는 ralplan과 무관 |
| 30 | primary의 `path` 입력은 OS 임시 루트로 한정합니다(DR-11). | `gjc-runtime/ralplan-runtime.ts:847-858`(`.gjc/` 밖 아무 파일), `SKILL.md:49` | spec D-W4 | 저장소 파일을 `path`로 넘길 수 없음. `content`를 사용 |
| 31 | `start(run_id)`는 open-gajae 추가분입니다(DR-19). | `gjc-runtime/ralplan-runtime.ts:2382-2391`(seed에 run ID 없음), `:1565-1570`(`--write`에만) | spec D-T3 | `start`에서 새 run 폴더와 예산을 지정할 수 있음 |
| 32 | owner 세션을 할당문의 `session_id`가 아니라 세션 계보에서 정합니다(DR-1). | `prompts/agent-fragments/ralplan-persistence.md:2,7` | host의 `context.sessionID` 계보를 신뢰할 수 있음 | 역할은 다른 세션의 run에 쓸 수 없음. 할당문에 `session_id`가 필요 없음 |
| 33 | 역할 프롬프트 host 치환: planner의 "Ask only about …"은 headless 규칙으로, architect의 forkContext 문장·`report_finding` 문단과 `irc`는 제거, `yield.result.data`는 최종 응답으로, `{{restrictedBash}}`는 읽기 전용 `shell` 문장으로 바꾸고 frontmatter는 제거합니다. | `prompts/agents/{planner,architect,critic}.md`, `prompts/agent-fragments/restricted-bash.md` | OpenCode에 해당 도구·필드가 없고 역할은 `question`을 쓸 수 없음 | 문구만 다름. 목록은 각 프롬프트의 source 섹션 |
| 34 | `ralplan handoff` op는 종료 phase를 요구합니다(DR-7). | `gjc-runtime/state-runtime.ts:1572-1640`(동사는 phase를 검사하지 않음), 검사는 `tools/skill.ts:42-61,203-208` | skill 도구의 체인 가드를 op에 합침(D-F12) | 계획 도중의 직접 인계는 거부 |
| 35 | 활성 행 파일(`state/active/ralplan.json`)을 읽을 수 없으면 `force` 없는 `clear`는 GJC처럼 멈추지만, `clear(force: true)`는 그 파일을 읽지 않고 정리합니다(R-OD16). | `gjc-runtime/state-runtime.ts:244-270,1425` → `readActiveEntries`(`gjc-runtime/state-writer.ts:425-431`)가 `--force` 확인 전에 예외를 던짐 | 항상 차단 때문에 `state/**`를 편집 도구로 고칠 수 없어, GJC 동작이면 `shell`로 파일을 지우지 않고는 run을 끝낼 방법이 없음 | 손상된 행 파일이 있어도 강제 clear는 동작, force 없는 clear는 GJC와 같음 |

### 수용한 동작 차이

아래 항목은 이식 spec이나 이전 open-gajae 결정과 다르며, 관리자가 수용했습니다. 대부분 GJC 동작을 그대로 따릅니다.

| 항목 | 동작 | 근거 | 영향 |
|---|---|---|---|
| 역할은 `content`만(spec D-W4 일부 대체) | 역할의 `path` 입력은 거부되고, OS 임시 `path`는 primary 전용입니다(R-O4). | GJC `gjc-runtime/ralplan-runtime.ts:852`, `SKILL.md:51` | 역할에는 파일 권한 확인 창이 없음. 큰 산출물(수십~100 KB 이상)이 도구 인자로 인라인 전달됨 |
| 시딩 없음, `write`가 state 생성(spec D-F13) | 훅·키워드는 아무것도 시딩하지 않고 `start`가 문서화된 진입입니다. `write`는 GJC처럼 state를 만들고 run을 전환합니다(R-O6). | GJC `gjc-runtime/ralplan-runtime.ts:986-1059` | `write`로 만든 run에는 `mode`·`interactive`·repository binding이 없을 수 있음 |
| 한 모드 원칙 일부 해제 | ultragoal 실행 중에는 `start`만 거부하고, 역할·primary의 `write`는 거부하지 않습니다(R-O6, R-AE1). | 관리자 결정(GJC 그대로) | ultragoal 실행 중 ralplan이 활성화될 수 있음. `ralplan state(patch={"active": false})` 또는 `ralplan clear`로 복구 |
| ultragoal 실행 중 가드 미적용(spec D-F15 예외) | 루트 세션에서 ultragoal이 실행 중이면 계획 가드를 적용하지 않습니다(R-O7). | GJC `skill-state/workflow-mutation-guard.ts:294-310` 근사 | AC18의 예외. 항상 차단 경로는 유지 |
| ultragoal 실행 중 게이트가 ralplan을 보지 않음(spec AC16 예외) | ultragoal이 실행 중이면 진입 게이트가 ralplan을 읽지 않습니다(R-O9). | GJC `tools/skill.ts:192-220` | 실행 중인 ultragoal의 `create`·skill 재로드는 ralplan state에 좌우되지 않음 |
| 종료 phase는 GJC 기준(spec D-F14, AC16) | 종료 집합은 spec의 `final`·`handoff`가 아니라 GJC의 8개 phase(`final`, `handoff`, `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`)이고, 가드는 GJC의 해제 phase 6개에서만 풀립니다(R-CE1). | GJC `tools/skill.ts:42`, `gjc-runtime/workflow-manifest.ts:154-160,229` | 승인 질문 중의 active `final`처럼 종료 phase에서 active인 run은 실행 중이 아님: continuation 없음, 진입 게이트는 거부 대신 인계 |
| 이전 형식 state | 알 수 없는 phase(예: OMC의 `current_phase: "ralplan"`)의 state는 판독 불가로 봅니다: 가드 해제, continuation 없음, 게이트 통과, `doctor`는 `schema_violation` 보고. 이동 코드는 없습니다(DR-21). | spec D-T10 | 이전 세션이 편집을 잠그지 않음. 그 state는 직접 삭제 |
| 가드 해제 집합(spec D-F15, 명확화) | 가드는 `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`에서만 풀리고, `final`과 `handoff`는 active인 동안 계속 막습니다(R-O10). | GJC `skill-state/workflow-mutation-guard.ts:264-276`, `gjc-runtime/workflow-manifest.ts:154-160` | 변화 없음. 이전 리뷰 질문의 잘못된 암시를 바로잡음 |
| `ralplan`이 숨겨지는 범위(spec AC1) | 이 도구를 쓸 수 없는 자체 agent에서는 숨기고, host `build`/`general`과 사용자 정의 agent는 실행 시 거부만 합니다(DR-22). | `core/src/plugin/agent.ts:84-100`; `ultragoal`·`state_*` 도구도 같음 | 그 agent들의 도구 목록에 보일 수 있음 |
| Stop here 뒤 사이드바 없음(spec D-H6 일부 철회) | spec은 최신 `final`이 승인 대기인 동안 "Stop here 이후 포함" 사이드바를 보이게 했습니다. Stop here는 GJC처럼 활성 행을 제거하므로 사이드바가 숨습니다(R-OD10). 승인 질문 중(active `final`)에는 `pending` 칩이 보입니다. | GJC `skill-state/active-state.ts:849-866` | Stop here 뒤에는 사이드바로 승인 대기를 알 수 없음. `pending-approval.md`는 보존 |
| revision 번호 없음(spec D-T8) | 활성 행과 스냅숏에 revision 번호를 두지 않습니다(R-OD6, deviation 17). | ralplan 쓰기는 모두 소유 세션 큐 하나에서 순차 기록 | 각각 D-T8 목록보다 key가 하나 적음 |

## 필수 후속 개발

아래 항목은 정책으로 기록한 필수 후속 작업이며, 아직 어느 것도 구현되지 않았습니다.

1. **deep-interview와 ultragoal의 활성 행, 사이드바, 도구.** 활성 행, `skill-active-state.json` 스냅숏, 사이드바 블록은 ralplan만 씁니다(deviation 14). deep-interview와 ultragoal에도 활성 행과 TUI 진행 표시가 필요하며, 이를 위한 도구·설계 재작업이 필요합니다(spec D-D2, D-H3).
2. **ultragoal을 GJC 방식으로 개정.** 합의 역할 프롬프트는 이제 GJC 것이지만, ultragoal의 리뷰어 brief(`src/ultragoal.ts`의 `verificationBrief`), `record_verdict`(`src/ultragoal-tool.ts`), `skills/ultragoal/SKILL.md`는 OMC 기반 그대로입니다(OQ1, deviation 15). ultragoal이 각 역할 고유의 판정을 소비하도록 개정합니다 — Architect `CLEAR`와 `APPROVE`, 또는 Critic `OKAY`는 `approve`, 그 밖은 `reject`로 매핑하고 `WATCH`, `COMMENT`, `ITERATE`의 매핑을 명시합니다 — 그리고 테스트 실행을 executor QA 레인으로 옮깁니다. 이 개정은 GJC 역할 프롬프트와 ultragoal brief 사이의 알려진 충돌 5개를 해소해야 합니다.
   1. **판정 어휘:** 역할은 `CLEAR`/`WATCH`/`BLOCK`과 `APPROVE`/`COMMENT`/`REQUEST CHANGES`, 또는 `OKAY`/`ITERATE`/`REJECT`로 끝나지만, brief는 `VERDICT: approve | reject`를 요구합니다.
   2. **제한 shell vs "run tests":** 역할 프롬프트는 `shell`을 읽기 전용 점검으로 제한하지만, brief는 리뷰어에게 관련 테스트와 빌드를 실행하라고 합니다.
   3. **9절 출력 vs "under 100 words":** GJC architect의 출력은 9개 절이지만, brief는 100단어 미만의 리뷰 요약을 요구합니다.
   4. **"Attempt N/3" vs ratchet pass 번호:** brief는 거부 한도까지 시도 횟수를 세지만, GJC 리뷰어는 5규칙 ratchet을 `review pass N`에 맞춥니다.
   5. **plan-only critic 정체성:** GJC critic은 실행 전에 plan이 실행 가능한지 판정하는 역할인데, ultragoal은 구현된 run의 최종 리뷰에 이를 씁니다.
3. **승인 라벨 정렬.** `skills/ultragoal/SKILL.md`는 ralplan 승인 선택지를 여전히 **Execute via ultragoal**로 부릅니다. GJC의 **Approve execution via ultragoal**로 바꿉니다(R-O5, deviation 27).
4. **알려진 한계(기록만, 일정 없음).** 한 worktree에서 여러 OpenCode 프로세스가 동시에 작업하면 서로 직렬화되지 않습니다: 플러그인은 한 프로세스 안에서만 쓰기를 큐에 넣고, GJC는 파일 잠금을 씁니다. 사이드바는 로컬 파일을 읽으므로 원격 서버에 attach한 TUI는 지원하지 않습니다.
5. **항상 차단 경로의 대소문자.** 항상 차단 경로 검사(`.open-gajae/_session-*/state/**`, `plans/ralplan/**`, ultragoal 파일)는 대소문자를 구분해 비교하므로, 대소문자를 구분하지 않는 파일 시스템(macOS 기본)에서는 `.OPEN-GAJAE/…`처럼 대소문자만 다른 경로가 계획 가드가 없는 때 이 검사를 빠져나갑니다. 이 검사들의 대소문자를 정규화합니다(관리자 결정 R-OD13).

## 검증 근거와 한계

이 이식이 정의하는 검증 계층은 `@opencode/plugin` 2.0.15에서의 `bun run typecheck`/`bun test`, prompt hook·permission rule 생성·continuation·artifact guard·state/code tool·`ralplan` 도구와 런타임(`tests/fixtures/gjc-ralplan/`의 GJC 픽스처와의 key 집합 비교 포함)에 대한 unit test와 사이드바 headless render 1개, 로컬 OpenCode 2.0.15 바이너리를 대상으로 한 host probe(`tests/host-probe.ts`, `tests/host-session-probe.ts`, `tests/planner-permission-probe.ts`, `tests/package-probe.ts`, `tests/ralplan-trail-probe.ts`), 그리고 `openai/gpt-6-luna`로 deep-interview → ralplan bridge, 키워드 진입, ralplan 중 Esc interrupt, `experimental.subagent_depth` 유무에 따른 planner delegation, 단계 파일·사이드바 칩·Stop here·ultragoal 시작까지의 ralplan 1회 실행을 다루는 manual checklist입니다. 이들의 현재 pass/fail 상태는 이식의 plan과 ledger가 관리하며 이 문서가 주장하지 않습니다.

이 계층들은 호스트 probe에 필요할 때 가짜 provider를 쓰는 결정적 transport·source-contract 검사입니다. 실제 모델 행동 검증이나 LLM obedience, prompt branch 보장, injection resistance, model 의미적 품질, external credential, 설치된 language server의 의미적 정확성 증거는 아닙니다. GJC 메인 프롬프트의 실제 모델 대화 확인은 GJC 프롬프트 plan의 사용자 전용 체크리스트에 따라 사용자가 맡으며, 여기서는 수행하지 않았습니다. LSP server는 자동 다운로드되지 않습니다. 이 가이드는 동작과 evidence scope를 기록하며 독립 completion proof는 durable delivery ledger에 둡니다.
