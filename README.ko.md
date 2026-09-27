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

세션에 묶인 `deep-interview`/`ralplan`/`ultragoal` skill, 여덟 개의 자체 역할, 작은 읽기 전용 코드 조사 도구를 제공하는 OpenCode 플러그인입니다. 메인 에이전트 프롬프트는 GJC를 바탕으로 이식하며, skill과 역할 내부 계약은 OMC 기반을 유지합니다. OMC 전체 이식은 아니며, 실행 워크플로는 OMC ralph를 이식한 `ultragoal` 하나뿐입니다.

## 범위와 상태

- 메인 에이전트 프롬프트의 기준은 GJC 커밋 `07f59defbc691064a126d72e391e46ccd331f970`이며, OMC 기반 skill과 역할 내부 계약의 기준은 OMC v5.4.0 커밋 `5281b19e0d64f8e6dc6767f2130299a88af2dc71` 그대로입니다.
- 대상 호스트는 OpenCode v2입니다. 이번 이식은 `@opencode/plugin` 2.0.15를 대상으로 하며, 로컬 `opencode/` 참조는 `v2.0.15`(`6f3639d82e`)에 고정되어 있습니다. v1 호스트는 더 이상 이 플러그인을 로드할 수 없습니다(v1 지원 중단 — deviations 표 참고).
- 패키지는 빌드 단계가 없는 TS 소스입니다. `package.json`의 `exports["."]`는 `./src/index.ts`를 가리키고, 루트 `index.ts`가 이를 re-export합니다. `dist/`는 없습니다.
- 구현 범위는 `deep-interview`·`ralplan`·`ultragoal`, `open-gajae`/`open-gajae-explore`/`open-gajae-document-specialist`, `open-gajae-planner`/`open-gajae-architect`/`open-gajae-critic` 합의 역할, `open-gajae-executor`/`open-gajae-cleaner` ultragoal 실행 역할, 세션 상태, native 문서 출력, 그리고 바로 호출 가능한 도구 12개(상태 도구 3개 + `ultragoal` 도구 1개 + 읽기 전용 AST/LSP 도구 8개)입니다. company context(v1의 advisory MCP hook)는 완전히 제거되었습니다.
- `ralplan`은 제공하며 `pending approval` 상태의 plan에서 끝나고, 최종 승인 질문은 `Refine further`/`Execute via ultragoal`/`Stop here`를 제공합니다. `ultragoal`은 OMC ralph를 이식한 목표 기반 지속 실행 loop로, goal별 architect 검증·필수 읽기 전용 cleaner pass·최종 critic 리뷰를 제공합니다. deep-interview → ralplan → ultragoal 핸드오프 체인도 제공합니다. autopilot, team, 독립된 ralph skill, autoresearch, 공유 세션 상태, 자동 migration/recovery는 제공하지 않습니다. 슬래시 커맨드는 없으며 명시적인 자연어 요청이나 지원되는 mention·키워드로 skill에 진입할 수 있습니다(아래 "진입" 참고).
- v2 호스트와 워크플로 설명은 `feat/opencode-v2-port` 브랜치 커밋 `f4df6e6`에서 비롯되었으며, 위 메인 에이전트 프롬프트 기준은 별도 변경입니다. Phase 1 완료를 입증하지 않으며, 아래 검증 계층(typecheck, unit test, host probe)이 이 변경에 대해 통과했다는 주장도 아닙니다. 검증 항목은 plan을 참고하세요.

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
- `experimental.subagent_depth: 2`는 `open-gajae-planner` 역할이 native `subagent` 도구로 `open-gajae-explore`/`open-gajae-document-specialist`에 연구를 위임하는 데 필요합니다. 플러그인이 직접 이 값을 올릴 수 없습니다 — v1과 달리 v2 플러그인 API에는 config를 수정하는 domain이 없습니다 — 그래서 이 값은 직접 넣어야 하는 host 설정입니다. 값이 없으면 planner 프롬프트는 직접 `read`/`grep`/`glob`로 조사하고 plan에 그 사실을 남기도록 fallback합니다.
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
    plans/<slug>.md
```

상태 쓰기는 model snapshot을 교체합니다. 명시 tool 필드가 우선하며 `_meta`는 매번 다시 만듭니다. `state_clear`는 현재 세션 state JSON 하나만 지우고 같은 세션 문서, 다른 세션, legacy 파일은 보존합니다. 손상/잘못된 상태는 reset하지 않고 보존한 채 오류로 드러냅니다.

동일한 canonical 상태 파일의 연산은 하나의 plugin process 안에서 직렬화되고 temporary file → rename으로 JSON을 게시합니다. IPC lock, state와 문서 저장의 다중 파일 transaction, 전원 손실 내구성, 다중 process 안전성은 아닙니다. 명세는 이 queue 밖에서 native `write`로 저장합니다. 추가 인터뷰 결과는 같은 파일에 갱신하며 suffix, receipt, index, 자동 복구는 없습니다.

사용자가 다른 세션의 spec/plan 경로를 명시하면 입력으로 읽을 수 있습니다. Native Read와 그 권한이 적용되고 실제 읽은 경로를 알려야 합니다. latest 탐색이나 다른 파일 대체는 하지 않습니다. B가 A를 읽어도 state/owner/승인/checkbox가 이전되지 않고 A 원문 편집이나 계획 실행 권한도 생기지 않습니다. B는 자기 state/documents에만 새 결과를 씁니다.

## Ralplan

`@ralplan [--interactive] [--deliberate] <task>` mention, 또는 `ralplan`/`랄플랜` 키워드가 합의 계획을 시작합니다. OMC와 같이 키워드는 호출 문맥에서만 발화합니다: 직접 호출 접두(`$ralplan`, `!ralplan`, `force: ralplan`), 활성화 동사(`use`, `run`, `start`, `please`, `let's`), 또는 메시지 맨 앞의 키워드. 질문, 인용·참조 언급, 코드·표·인용 블록 안의 텍스트는 발화하지 않습니다. 키워드는 모든 primary agent에서 동작하지만, agent가 `open-gajae-planner`/`open-gajae-architect`/`open-gajae-critic`인 메시지는 키워드 hook이 무시합니다. 한 메시지에 ralplan과 deep-interview 키워드가 함께 있으면 두 안내가 ralplan부터 순서대로 주입되고 ralplan state만 시딩됩니다.

키워드 턴은 `awaiting_confirmation: true`로 시딩하고 `[MODE: RALPLAN]` 안내를 주입해 모델에게 `ralplan` skill을 열도록 요청합니다. `@ralplan` mention은 이미 확정된 상태(`awaiting_confirmation: false`)로 시딩합니다 — host가 그 턴에 이미 skill을 붙였기 때문입니다. 그리고 skill이 이미 붙었다는 자체 `[MODE: RALPLAN]` 안내를 넣어 삽입 사실이 보이게 합니다(TUI에 `open-gajae: ralplan mention notice added`가 표시됨). host의 `id: "ralplan"` `skill` 도구 호출도 `awaiting_confirmation`을 지우며, OMC가 skill load를 관찰해 지우는 것과 같습니다. 확정되지 않은 seed가 남아 있으면 ralplan 키워드나 mention이 없는 다음 사용자 메시지가 지웁니다.

안내(ralplan 안내, deep-interview magic guide, restore banner, breaker 메시지)는 그 안내를 시딩·갱신한 state 쓰기 뒤에 `ctx.session.synthetic({ resume: false })` 메시지로 기록됩니다. host는 synthetic 메시지를 같은 턴의 user 메시지 **앞**에 배치합니다. OMC/v1은 뒤에 덧붙였으므로 이는 기록된 host 배치 차이이며, 설계 선택이 아닙니다. `synthetic` 자체가 실패하면 안내가 사라지지 않도록 marker로 감싼 채 prompt 텍스트에 덧붙입니다. state 쓰기는 어느 쪽이든 유지됩니다.

native `question` 세 개는 항상 켜져 있습니다. Planner 초안 직후의 intent 확인, 합의 종료 후 확인, 그리고 `Refine further`/`Stop here`를 제공하는 최종 승인 질문입니다. `--interactive`는 draft review만 추가합니다. `--deliberate`는 pre-mortem과 확장된 test plan을 추가하며, 명시적 고위험 신호에서 자동으로 켜집니다. 질문이 열려 있는 동안은 continuation이 발화하지 않습니다 — native `question` 도구가 답이 올 때까지 실행을 붙잡고 있어서 그동안 `session.execution.succeeded`가 발행되지 않기 때문입니다.

세션 산출물은 기존 세션 계약을 확장합니다.

```text
<worktree>/.open-gajae/
  _session-<created>-<session-id>/
    plans/<slug>.md
    drafts/<slug>.md
    state/ralplan-state.json
```

상태 도구는 `mode: "deep-interview" | "ralplan"`을 받습니다. 기본값은 `deep-interview`이므로 기존 deep-interview 동작은 바뀌지 않습니다.

continuation은 ralplan state가 active인 동안 durable `session.execution.succeeded` 이벤트(v2는 `session.idle`을 발행하지 않습니다)에서 `ctx.session.synthetic({ resume: true })`로 세션에 다시 프롬프트를 넣습니다. circuit breaker는 30회 주입에서 멈추고 breaker 카운터는 45분이 지나면 만료됩니다 — v1과 같은 상수입니다. 사용자가 턴을 중단하면 — `session.execution.interrupted`의 reason이 `user`(Esc 또는 interrupt API) 또는 `shutdown`(취소된 `question` form, 그리고 reason 없는 interrupt의 host 기본값)이면 — stop mark가 설정되고, 다음 실제 user 프롬프트만 이를 지웁니다. `inactivity`와 `superseded`는 mark를 설정하지 않습니다. continuation은 현재 세션 아래에서 실행 중인 background subagent 세션(`background: true`로 실행됨)이 있으면 `session.created`/`session.execution.started`/terminal 이벤트를 `parentID`로 추적해 건너뜁니다(OMC/OMO parity; v1에는 대응 사례가 없었습니다). 그런 child가 끝나면 host 자체의 subagent-completion synthetic이 parent를 재개하고, 그 뒤의 `succeeded`는 같은 breaker로 다른 succeeded와 동일하게 판단됩니다. v2 플러그인 인스턴스는 location마다 하나씩 만들어지지만 공유 서버는 모든 인스턴스에 모든 이벤트를 전달하므로, 이 플러그인은 자기 location과 일치하는 세션에만 동작합니다 — v2에서 새로 생긴 사실이며 위 결정들을 바꾸지는 않습니다.

`[RALPLAN MODE RESTORED]`는 같은 세션 안에서 재개당 최대 한 번만 나타납니다. state는 세션별이므로 세션 간 복원은 없습니다.

사용자가 **Execute via ultragoal**을 고르지 않으면 plan은 `pending approval` 상태로 남습니다.

실제 핸드오프: **Execute via ultragoal**을 선택하면 ralplan은 plan을 `approved`로 표시하고 `state_clear` 대신 `state_write(mode="ralplan", active=false, current_phase="handoff", plan_path="<plan 절대 경로>")`를 호출한 뒤 `ultragoal` skill을 불러와 plan 경로를 `source_plan`으로 넣어 `create`를 호출합니다(미완료 goal list가 이미 있으면 `resume`). 반대 방향도 있습니다: `ultragoal handoff(to="ralplan", reason)`은 실행을 멈추고(goal과 progress는 삭제되지 않고 유지) ralplan state를 다시 시딩합니다. 이후 다시 **Execute via ultragoal**을 선택하면 `resume`을 호출해 새 plan을 `add`/`revise`/`supersede`로 기존 goal에 병합합니다.

## 자체 역할과 설정

- **`open-gajae`**: primary입니다. 수정, 결정, 통합, state write/clear를 소유합니다. host 기본값 외에 추가 rule은 없습니다.
- **`open-gajae-explore`**: repository 사실을 읽기 전용으로 조사합니다. edit, delegation(`subagent`), question, state write/clear를 할 수 없습니다. `shell`은 전체 허용됩니다(OMC parity — 어떤 역할에도 `shell`/Bash rule을 추가하지 않습니다).
- **`open-gajae-document-specialist`**: 문서와 인용 근거를 조사합니다. edit, delegation, question, state write/clear를 할 수 없습니다. `chub` 절차는 프롬프트에서 읽기 전용으로 문서화되어 있으며, host permission rule이 `shell`을 `chub` 명령으로 제한하지는 않습니다.
- **`open-gajae-planner`**, **`open-gajae-architect`**, **`open-gajae-critic`**: ralplan 합의 역할입니다. 세 역할 모두 `mode: subagent`이고 기본 모델은 없으며 설정의 `agents` 맵으로만 지정합니다. architect와 critic은 읽기 전용으로 `edit`, `subagent`가 거부되고, `question`, `state_write`, `state_clear`도 거부됩니다. planner는 OMC와 같이 plan을 직접 저장하고 조사를 위임합니다. `edit` 권한은 `.open-gajae/_session-*/plans/*`와 `.open-gajae/_session-*/drafts/*`만 허용하고, `execute.before`(`ctx.tool.hook` 경유) guard가 그 쓰기를 현재 루트 세션의 디렉터리로 다시 한정합니다 — 범위 밖 호출은 input을 무효화해 host의 decode 자체를 실패시키고, `execute.after`가 그 오류(그리고 정적 `edit` rule이 만든 다른 거부)를 모델이 이해할 안내로 다시 씁니다. `subagent` 권한은 `open-gajae-explore`와 `open-gajae-document-specialist`만 허용합니다. `question`, `state_write`, `state_clear`, 그리고 Code Mode의 두 세션 도구(`opencode_session_move`, `opencode_session_rename`)는 일곱 subagent 역할 모두에서 거부됩니다. `subagent_depth`는 플러그인이 올리지 않습니다. host 설정에 `experimental.subagent_depth: 2`를 직접 넣으세요(설치 참고).
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
  }
}
```

`ultragoal.hardMaxIterations`는 `0` 이상의 정수입니다. `0`이면 무제한이고 기본값은 `200`입니다(continuation iteration의 hard ceiling입니다. `max_iterations`가 이 값까지 연장되면 loop가 멈추고 보고합니다. 아래 goal별·최종 리뷰와는 별개입니다).

`variant`는 같은(이미 병합된) entry에 `model`이 있어야 합니다: user 레벨 `model` + project 레벨 `variant`는 유효하지만, `variant`만 있거나(한 파일에서든 양쪽에 나뉘어서든) 어디에도 `model`이 없으면 agent 이름과 `model "provider/model"` 추가 요청을 담은 오류로 거부됩니다. 이는 그런 variant를 진단만 남기고 조용히 버리는 v2 host보다 더 엄격합니다. provider fallback, tier mapping, 인위적 collision 거부는 없습니다. v1의 `companyContext` 설정은 사라졌습니다 — 지금 넣으면 `unknown setting`으로 실패합니다.

`ultragoal`은 완료 주장 하나를 그대로 믿지 않고 검증을 여러 층으로 쌓습니다. 각 goal은 새 `open-gajae-architect` 세션이 그 goal의 acceptance criteria만 보고 검증하고, primary가 그 `approve`/`reject` 판정을 `record_verdict`로 기록합니다. 모든 goal이 검증되면 필수 읽기 전용 `open-gajae-cleaner` pass가 이번 실행에서 바뀐 파일을 검토하고, blocking finding은 계속 진행하기 전에 고칩니다. 그 정리와 회귀 재검증이 끝난 뒤에야 새 `open-gajae-critic` 세션이 전체 실행을 검토하고, primary가 그 최종 verdict를 기록합니다. loop는 그 최종 critic 승인에서만 끝나며, 어느 층에서든 거부되면 실행을 끝내는 대신 해당 goal을 다시 엽니다. `ultragoal cancel(reason)`은 실행을 포기합니다(state는 삭제되지만 `goals.json`/`progress.txt`는 남아 나중에 `resume`할 수 있습니다). `ultragoal.hardMaxIterations`는 이 전체를 떠받치는 hard ceiling입니다.

## 읽기 전용 코드 도구

플러그인은 읽기 전용 코드 도구 8개를 등록합니다(위의 상태 도구 3개와 `ultragoal` 도구를 더하면 총 12개).

- `ast_grep_search` (`@ast-grep/napi` 0.31.1): AST 검색만 하며 replace는 없습니다.
- `lsp_goto_definition`, `lsp_hover`, `lsp_diagnostics`, `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_servers`.

LSP server는 감지·보고만 하며 자동 다운로드하지 않습니다. LSP rename, code action, replacement suite는 없습니다. 사용 가능한 actor는 여덟 개 자체 역할 전체입니다 — `open-gajae`, `open-gajae-explore`, `open-gajae-document-specialist`, `open-gajae-planner`, `open-gajae-architect`, `open-gajae-critic`, `open-gajae-executor`, `open-gajae-cleaner` — OMC와 동일하게 모든 agent가 읽기 전용 LSP/AST 도구를 사용할 수 있습니다. project 경계는 v1의 call마다 host permission을 묻던 방식을 대체합니다: input 경로를 host의 현재 location 디렉터리 기준으로 해석하고, symlink를 따라가며, 실제 대상이 실제 project 디렉터리 안에 있어야 합니다. `.env`와 `.env.*` 파일은 요청한 이름과 해석된 이름 양쪽에서 거부되며, `ast_grep_search`는 traversal 중에도 건너뜁니다. 두 도구 모두 explorer 권한을 넓히거나 arbitrary shell 실행을 허용하지 않습니다.

source에서 실제 도달하는 제품 환경 변수는 `OPEN_GAJAE_LSP_TIMEOUT_MS`, `OPEN_GAJAE_LSP_IDLE_TIMEOUT_MS`, `OPEN_GAJAE_LSP_IDLE_CHECK_INTERVAL_MS`, `OPEN_GAJAE_LSP_CONTAINER_ID`, `OPEN_GAJAE_PYTHON_LSP=basedpyright`뿐입니다. 일반 설정이 아니라 LSP 구현 설정입니다.

## OMC와 v1 플러그인으로부터의 deviation

아래 표는 OMC 기반 워크플로·역할 또는 그 이전 v1 구현에서 호스트 요구로 바뀐 항목을 기록합니다(AGENTS.md 정책). 이 항목들은 이식의 spec/plan(`.omc/specs/deep-interview-opencode-v2-port.md`, `.omc/plans/ralplan-opencode-v2-port.md`)의 결정으로 추적됩니다. GJC 기반 메인 에이전트 프롬프트는 별도 이식입니다([third-party notices](THIRD-PARTY-NOTICES.md) 참고).

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
| artifact guard가 throw 대신 input 무효화로 차단 | `execute.before`가 차단할 호출의 input을 `{}`로 바꿔 host의 decode 자체를 실패시키고, `execute.after`가 그 오류(그리고 planner의 permission 범위 거부)를 모델이 이해할 안내로 다시 씁니다. Promise-hook throw는 대신 host defect로 나타났을 것입니다. |
| code-tool 경계가 host ask 대신 realpath containment | host의 현재 location 기준으로 해석하고, symlink를 따라가며, 실제 project 디렉터리 안에 있어야 하고, `.env`/`.env.*`를 제외합니다 — v1의 call마다 permission을 묻던 방식을 대체합니다. |
| LSP surface가 도구 4개에서 7개로 확장 | `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_servers`에 `lsp_goto_definition`, `lsp_hover`, `lsp_diagnostics`가 추가되었습니다. |
| `@deep-interview` mention도 magic notice를 받음 | OMC parity입니다. v1은 명시적 호출에서 안내를 억제했습니다. |
| `@ralplan` mention도 안내를 받음 | mention 안내는 skill이 이미 붙었음을 알립니다. OMC도 명시적 호출에 안내를 붙이며, 문구는 host 추가분입니다. 사용자가 모든 삽입을 볼 수 있도록 추가했습니다. |
| 설치 문서가 디렉터리 plugin 형태만 보여줌 | 일부 host 문서는 파일 경로 `plugins` 예시를 보여주지만, v2 host는 실제로는 파일 경로로 설정된 plugin 항목을 건너뜁니다. |

## 검증 근거와 한계

이 이식이 정의하는 검증 계층은 `@opencode/plugin` 2.0.15에서의 `bun run typecheck`/`bun test`, prompt hook·permission rule 생성·continuation·artifact guard·state/code tool에 대한 unit test, 로컬 OpenCode 2.0.15 바이너리를 대상으로 한 host probe(`tests/host-probe.ts`, `tests/host-session-probe.ts`, `tests/planner-permission-probe.ts`, `tests/package-probe.ts`), 그리고 `openai/gpt-6-luna`로 deep-interview → ralplan bridge, 키워드 진입, ralplan 중 Esc interrupt, `experimental.subagent_depth` 유무에 따른 planner delegation을 다루는 manual checklist입니다. 이들의 현재 pass/fail 상태는 이식의 plan과 ledger가 관리하며 이 문서가 주장하지 않습니다.

이 계층들은 호스트 probe에 필요할 때 가짜 provider를 쓰는 결정적 transport·source-contract 검사입니다. 실제 모델 행동 검증이나 LLM obedience, prompt branch 보장, injection resistance, model 의미적 품질, external credential, 설치된 language server의 의미적 정확성 증거는 아닙니다. GJC 메인 프롬프트의 실제 모델 대화 확인은 GJC 프롬프트 plan의 사용자 전용 체크리스트에 따라 사용자가 맡으며, 여기서는 수행하지 않았습니다. LSP server는 자동 다운로드되지 않습니다. 이 가이드는 동작과 evidence scope를 기록하며 독립 completion proof는 durable delivery ledger에 둡니다.
