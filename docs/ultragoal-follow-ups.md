# ultragoal 후속 개발 목록

작성: 2026-09-29. ralplan GJC 이식 개발(브랜치 `feat/ralplan-gjc-stage-trail`, `c0b5e02..5474971`, 기준 gajae-code `5c5231418930673e42cc5d08ebe4376e03187533`)에서 ultragoal에 해야 하지만 하지 않은 일을 모은 문서입니다. 이 개발은 ultragoal을 넘기기(handoff), 진입 게이트, 계속 실행(continuation)에 필요한 만큼만 고쳤고 나머지는 미뤘습니다.

이 문서는 결정 기록이 아니라 목록입니다. "결정 필요"로 표시한 항목은 AGENTS.md에 따라 구현 전에 관리자가 정해야 합니다.

**참조 표기**
- 결정 ID
  - `R-…`, `DR-…`, `D-…`, `OQ1`: `.omc/plans/ralplan-gjc-stage-trail.md`와 `.omc/specs/deep-interview-ralplan-gjc-stage-trail.md`
  - `PA-…`: `.omc/plans/ultragoal-pa-decisions.md`
- "편차 N": README "Deviations from GJC (ralplan)"의 행 번호
- GJC 경로: `gajae-code/packages/coding-agent/src/` 기준

**조사 범위**: README 두 파일 전체, spec·계획서·draft 4개·리뷰 4개, `src/`·`skills/`·`prompts/`·`tests/`·`docs/`, 브랜치 커밋, 이 개발의 대화 기록 2개(2026-09-27~29), test-app 수동 실행 세션 파일. 파일로 확인할 수 없고 대화 기록에만 있는 근거는 "(대화 기록)"으로 표시했습니다.

## 분류

- **필수 후속**: README "Mandatory follow-up development"에 이미 있는 항목.
- **미기록**: 이번 조사 전까지 README에 없던 항목. 대부분 결정이 필요합니다.
- **기록된 차이**: README 편차·수용 차이로 기록돼 있고 후속 일정은 없는 항목. U1 이후 다시 볼 후보입니다.
- **알려진 한계**
- **이전부터 있던 문제**: 이번 개발과 무관하게 조사 중 발견한 것.

## 요약

| # | 항목 | 분류 |
|---|---|---|
| U1 | ultragoal 활성 행·스냅숏·HUD·doctor·감사 행 | 필수 후속 1 |
| U2 | GJC 방식으로 ultragoal 검증 개정 | 필수 후속 2 (+미기록 보충) |
| U3 | 승인 라벨 정렬 | 필수 후속 3 |
| U4 | 항상 차단 경로의 대소문자 정규화 | 필수 후속 5 |
| U5 | TUI 진행 표시 | 필수 후속 1·6 |
| U6 | 진입 게이트로 넘길 때 계획 경로 유실 | 미기록, 결정 필요 |
| U7 | ultragoal → ralplan → ultragoal 왕복의 안내 오류와 새 계획 경로 | 미기록, 결정 필요 |
| U8 | `@ultragoal` 승인 뒤 `ralplan handoff` 거부 | 미기록, 결정 필요 (`05b7ffd`에서 생김) |
| U9 | ultragoal 쪽 스킬 연쇄 가드 | 미기록, 결정 필요 |
| U10 | 오래된 `pending-approval.md` 전달 | 미기록, 결정 필요 |
| U11 | ultragoal 계약의 출처 기록과 낡은 문구 | 미기록 |
| U12 | ultragoal state의 handoff 필드 | 미기록 |
| U13 | ultragoal handoff 뒤 `ralplan start`의 메타 소실 | 미기록 |
| U14 | PLANNING-STUCK 실행에 대한 게이트 거부 안내 | 미기록 |
| U15 | 넘기기 실패 경로의 테스트와 안내 | 일부만 기록 |
| U16 | 고정 계약의 자동 회귀 검사 | 계획서에만 기록 |
| U17 | 실제 모델 VERDICT 확인 결과 | 미기록 |
| U18 | README의 ultragoal 저장 파일 구성 | 미기록 |
| U19 | executor 프롬프트의 옛 계획 경로 | 미기록 |
| U20 | ultragoal 실행 중 계획 가드 꺼짐 | 기록된 차이 (편차 28) |
| U21 | ultragoal 실행 중 게이트가 ralplan 무시 | 기록된 차이 (편차 29) |
| U22 | ultragoal 실행 중 ralplan write의 영향 | 기록된 차이 (R-AE1) + 미기록 보충 |
| U23 | ultragoal → ralplan 넘기기에 저널 없음 | 기록된 차이 (편차 24) |
| U24 | ralplan 런타임이 ultragoal state를 씀 | 기록된 차이 (편차 25) |
| U25 | Stop here 뒤 `handoff_from` 없이 시작 | 기록된 차이 (편차 34) |
| U26 | 안내·seed·복원 안내는 `open-gajae`에만 | 기록된 차이 (R-OD20) |
| U27 | continuation이 agent를 확인하지 않음 | 기록된 차이 (R-OD21) |
| U28 | ultragoal 도구가 다른 agent 카탈로그에 보임 | 기록된 차이 (DR-22, 이전부터) |
| U29 | 진입 게이트의 phase 처리 | 기록된 차이 (R-CE1, DR-21) |
| U30 | 진입 게이트가 매 턴 지속 state를 읽음 | 기록된 차이 (편차 37) |
| U31 | 여러 프로세스 간 직렬화 없음 | 알려진 한계 |
| U32 | 재시작 안내 문구 | 이전부터 있던 문제 |
| U33 | ultragoal에서 deep-interview로 넘기기 없음 | 이전부터 있던 차이 |

## 필수 후속 (README에 있음)

### U1. ultragoal 활성 행·스냅숏·HUD·doctor·감사 행

- **빠진 것**: 활성 행(`state/active/<skill>.json`)과 `skill-active-state.json` 스냅숏은 ralplan만 씁니다. ultragoal은 행이 없고, HUD 칩 계산기도 ralplan 것만 이식했습니다(`src/ralplan-runtime/hud.ts:19-20`).
- **드러나는 증상**:
  - 스냅숏이 행 파일로만 다시 만들어지므로(`src/ralplan-runtime/store.ts:401-434`), ralplan에서 ultragoal로 넘긴 뒤에는 ultragoal이 실행 중이어도 `active: false, skill: ""`로 보입니다. test-app 세션 `_session-20260928-233638-ses_f178…`에서는 넘기기(14:47:57)에서 스냅숏이 마지막으로 다시 만들어졌고, ultragoal은 15:21까지 실행됐습니다(`state/audit.jsonl`, `state/ultragoal-state.json`).
  - `ralplan doctor`는 한 스킬만 검사합니다(`skills_scanned: 1`, `store.ts:1614`).
  - ultragoal state 쓰기는 `state/audit.jsonl`에 남지 않습니다. ralplan 런타임이 ultragoal state를 쓸 때(편차 25)도 마찬가지입니다.
  - 압축 복구 문맥에 GJC의 ultragoal 전용 필드(`currentGoal`, `progress`)가 없습니다(`src/ralplan-runtime/recovery.ts:15`).
- **해야 할 일**: ultragoal 행(spec D-T8의 필드), 스냅숏 항목, HUD, doctor 검사, 감사 행, 그리고 그에 필요한 도구·설계 재작업(spec D-D2, D-H3). 진행 표시는 U5를 보세요.
- **결정·이유**: 관리자가 ralplan만 먼저 하고, deep-interview·ultragoal은 "이번 개발 후 꼭 개발해야한다고 문서에 남기자"고 정했습니다(대화 기록, 2026-09-27). 편차 14.
- **GJC 참조**: `skill-state/active-state.ts`.
- **기록 위치**: README·README.ko 필수 후속 1, 편차 14. 계획서 §9 Follow-ups 1.
- **연결**: U1이 생기면 U20·U21·U30을 GJC의 행 기반 "현재 스킬" 검사로 바꿀 수 있고, U12의 `handoff_from`도 여기서 쓰입니다(R-OD7은 "후속 개발 때 쓰인다"는 이유로 이 필드를 유지). 이 의존 관계는 README에 없습니다.

### U2. GJC 방식으로 ultragoal 검증 개정

- **빠진 것**: 합의 역할 프롬프트는 GJC 것으로 바뀌었지만, 다음 셋은 OMC 기반 그대로입니다(OQ1).
  - ultragoal 리뷰어 지시문 `verificationBrief`(`src/ultragoal.ts:947`)
  - `record_verdict`(`src/ultragoal-tool.ts:152`는 `approve`/`reject`만 받음)
  - `skills/ultragoal/SKILL.md`
- **해야 할 일**:
  - 각 역할의 고유 판정을 받습니다. Architect `CLEAR`+`APPROVE`와 Critic `OKAY`는 `approve`, 나머지는 `reject`이고, `WATCH`·`COMMENT`·`ITERATE`는 명시적으로 매핑합니다.
  - 테스트 실행을 executor QA 레인으로 옮깁니다. 지금 QA 역할은 없고, `open-gajae-qa-tester`는 유효한 agent 이름이 아닙니다(`docs/local-install-v2.md:88`).
  - 알려진 충돌 5개를 해소합니다.
    1. 판정 어휘: 지시문은 `VERDICT: approve | reject`(`src/ultragoal.ts:1015`).
    2. 제한된 shell 대 "테스트 실행"(`:1010`).
    3. Architect의 9절 출력 대 "under 100 words"(`:1020`).
    4. "Attempt N/3"(`:990`) 대 리뷰어 ratchet의 `review pass N`.
    5. 계획 전용 critic을 최종 구현 검토에 쓰는 문제.
  - SKILL 7·8단계를 고칩니다.
- **결정·이유**: OQ1(단계적 개정), 편차 15.
- **미기록 보충**:
  - **착수 시점 조건**: 관리자 답은 "ultragoal은 다음에 꼭 이 내용을 고려해서 수정 개발해야한다고 문서에 명시하기.(active skill.json 이거 개발할 때)"였습니다(대화 기록, 2026-09-27). 즉 U1과 함께 하라는 뜻인데, 이 조건은 README와 계획서에 없습니다.
  - **리뷰어가 ralplan 도구를 가짐**: ultragoal 리뷰어로 쓰이는 architect·critic은 `ralplan` 도구를 유지합니다(`src/config.ts:299-301`). 그런데 GJC 프롬프트는 `ralplan write` 저장을 지시합니다(U22).
  - **executor 에스컬레이션**: executor는 3회 실패하면 `open-gajae-architect`를 부릅니다(`prompts/open-gajae-executor.md:33`). 이제 그 대상은 ralplan 저장 지시가 든 GJC 프롬프트입니다. PA-24(`ultragoal-pa-decisions.md:33`)로 복원했던 리뷰어 프롬프트의 executor 문장(`c0b5e02` 기준 critic `:12,:47`, architect `:7`)도 GJC 프롬프트로 바꾸면서 사라졌습니다.
  - **GJC 고정 커밋의 변경**: 고정 커밋을 올리면서 GJC ultragoal SKILL이 한 줄 바뀌었습니다(`859cb5977`, linked worktree 간 goal 승계). 당시 "영향 없음"으로만 판단하고 기록하지 않았습니다(대화 기록, 2026-09-27). GJC 방식 개정 때 참고해야 합니다.
- **기록 위치**: README·README.ko 필수 후속 2, 편차 15. 계획서 OQ1, §9 Follow-ups 2. `prompts/open-gajae-architect.md:115`, `prompts/open-gajae-critic.md:90`.

### U3. 승인 라벨 정렬

- **빠진 것**: `skills/ultragoal/SKILL.md`에 **Execute via ultragoal**이 네 번 남아 있습니다(`:13`, `:72`, `:126`, `:285`). 플러그인 문구는 이미 **Approve execution via ultragoal**입니다(`src/ultragoal.ts:906`, `src/ralplan-runtime/store.ts:152`, `src/ultragoal-tool.ts:860`).
- **해야 할 일**: 네 곳을 바꾸고, `skills/ralplan/SKILL.md:254` 출처 표의 "unchanged ultragoal skill" 문구도 함께 고칩니다. ultragoal SKILL의 라벨을 검사하는 테스트는 없습니다.
- **결정·이유**: R-O5(관리자가 "gjc 문구 + 플러그인 문구만 함께 변경"을 선택). OQ1로 SKILL을 고정했습니다. 편차 27.
- **기록 위치**: README·README.ko 필수 후속 3, 편차 27. 계획서 R-O5, §9 Follow-ups 3.

### U4. 항상 차단 경로의 대소문자 정규화

- **빠진 것**: 항상 차단 검사(`state/**`, `plans/ralplan/**`, ultragoal 파일)가 대소문자를 구분합니다. macOS 기본 파일 시스템에서는 `.OPEN-GAJAE/…` 같은 경로가 빠져나가고, ultragoal 실행 중에는 계획 가드도 꺼져 있습니다(U20).
- **해야 할 일**: 비교 전에 대소문자를 정규화합니다.
- **결정·이유**: R-OD13(계획서에는 이유 없음). 관리자에게 물을 때 "범위 밖의 ultragoal 가드를 건드림"이라는 설명과 함께 후속으로 미뤘습니다(대화 기록).
- **기록 위치**: README·README.ko 필수 후속 5. 계획서 R-OD13, §9 Follow-ups 5.

### U5. TUI 진행 표시

- **빠진 것**: ultragoal TUI 표시는 spec 단계부터 범위 밖이었습니다(D-H3, D-D2, Non-Goals). 여기에 ralplan 사이드바마저 제거되면서(R-OD17) 표시를 붙일 바탕이 없어졌습니다. 제거 이유는 배포된 OpenCode 2.0.15 바이너리가 플러그인 import를 호스트 인스턴스로 연결하지 않기 때문입니다.
- **해야 할 일**: 둘 중 하나가 되면 사이드바를 다시 넣고 ultragoal 칩도 그립니다(U1 필요).
  - 호스트가 플러그인 import를 연결해 준다.
  - 가상 모듈 우회를 호스트 통합 편차로 기록한다.
- **주의**: 사이드바 코드는 브랜치 커밋 `96e9176`·`eb85dde`·`0cbb491`에만 있어서, squash 병합하면 사라집니다.
- **기록 위치**: README·README.ko 필수 후속 1·6. 계획서 R-OD17, §9 Follow-ups 1.
- **계획서 불일치**: 계획서 §9 Follow-ups에는 R-OD17 사이드바 항목이 없고, §9 Consequences(`:499`)는 아직 `tui-plugin/`이 있는 것처럼 적습니다.

## 미기록 (이번 조사에서 새로 찾음)

### U6. 진입 게이트로 넘길 때 계획 경로 유실 (결정 필요)

- **문제**: `pending_approval_path`를 결과에 넣는 것은 `ralplan handoff` 연산뿐입니다(`src/ralplan-runtime/store.ts:1725-1748`). 진입 게이트로 넘기는 세 경로는 모두 이 경로를 버립니다.
  - 도구 `start`/`resume`/`create`(`src/ultragoal-tool.ts:79,827`)
  - `@ultragoal` 언급 seed(`src/hooks.ts:768`)
  - 스킬 로드 seed(`src/hooks.ts:862-863`)
- **경로를 알려 주는 곳이 달리 없음**: `ultragoal status`, 목표가 없을 때의 continuation 안내(`src/ultragoal.ts:794`), 압축 문맥 어디에도 계획 경로가 없습니다. 넘긴 뒤에는 ralplan 압축 복구도 멈추므로, 압축이 일어나면 모델은 경로를 잃습니다.
- **해야 할 일**: 경로를 `HandoffMeta`와 ultragoal seed로 넘기고, status·continuation·압축 문맥에 보여 줍니다.

### U7. ultragoal → ralplan → ultragoal 왕복 (결정 필요)

- **문제**:
  - ultragoal에서 ralplan으로 넘겼다가 돌아오면 끝나지 않은 `goals.json`이 남아 있어 `create`가 거부됩니다(`src/ultragoal-tool.ts:354-363`). 그런데 `ralplan handoff`의 성공 안내(`store.ts:1748`)와 R-OD18 거부 안내(`store.ts:1684`)는 `create`를 부르라고 합니다.
  - ultragoal SKILL(`:126`)과 ultragoal handoff 안내(`src/ultragoal-tool.ts:860`)는 `resume`을 말하지만, `resume`에는 `source_plan` 입력이 없습니다(`:118`은 `create` 전용). 그래서 다시 짠 계획의 `pending-approval.md`가 기록되지 않습니다.
- **테스트**: `ralplan handoff` 뒤 `ultragoal resume`을 거치는 테스트가 없습니다. 프로브 ⑥은 게이트 경로만 씁니다(`tests/host-session-probe.ts:457-513`).
- **해야 할 일**: 왕복일 때 안내를 `resume`으로 바꾸고, `resume`이 `source_plan`을 받을지 정합니다.

### U8. `@ultragoal` 승인 뒤 `ralplan handoff` 거부 (결정 필요, `05b7ffd`에서 생김)

- **상황**: ralplan이 활성 `final`인 상태에서, 사용자가 새 프롬프트에 `@ultragoal`을 넣어 보냅니다(예: 승인 질문에 답하는 대신 "@ultragoal 진행"). prompt 훅은 사용자 프롬프트만 봅니다(`src/hooks.ts:654,670`).
- **문제**:
  - 이때 prompt 훅의 진입 게이트가 먼저 ralplan을 넘깁니다(`src/hooks.ts:750-770`).
  - ralplan SKILL은 현재 턴에 `@ultragoal`이 있으면 승인으로 보고(`skills/ralplan/SKILL.md:111`), 9단계가 `ralplan handoff`를 부르게 합니다(`:117-125`).
  - R-OD18 커밋 `05b7ffd`부터 이 호출은 거부됩니다. `26fe14b` 이후 문구는 "already handed off"입니다(`store.ts:1680`). 그 전에는 두 번째 넘기기가 성공하면서 계획 경로를 돌려줬습니다.
  - 거부 안내가 ultragoal로 가라고 하고 모델은 final 영수증에서 경로를 알 수 있으므로 멈추지는 않지만, 경로 전달이 약해졌습니다(U6과 겹침).
- **해야 할 일**: 둘 중 하나를 정합니다.
  - SKILL 9단계에 "이미 넘겨졌으면 건너뜀"을 적는다.
  - 같은 run이 방금 넘겨졌으면 성공과 경로를 돌려주도록 연산을 고친다.

### U9. ultragoal 쪽 스킬 연쇄 가드 (결정 필요)

- **GJC**: 스킬 도구가 "ralplan/ultragoal deliberately stay blocked in live phases"라고 적고 있습니다(`tools/skill.ts:44-52`).
  - 실행 중인 ultragoal에서 다른 정식 스킬(예: `deep-interview`)로 넘어가는 것과 활성 스킬 재로드를 거부합니다(`:170-176`).
  - 끝난 ultragoal에서 넘어갈 때는 `state ultragoal handoff`를 실행합니다(`:203-221`).
  - 이 가드는 현재 턴에 불러온 스킬만 봅니다(`session/agent-session.ts:8038-8046`).
- **open-gajae**: ultragoal 실행 중에는 `skill ralplan`만 거부합니다(`src/hooks.ts:871`). 편차 37은 ralplan 쪽만 기록합니다.
- **해야 할 일**: 이식할지 정하고, 이식하지 않으면 편차로 기록합니다.

### U10. 오래된 `pending-approval.md` 전달 (결정 필요)

- **문제**: `final` 뒤(또는 Stop here 뒤) 수정 단계를 쓰고 새 `final`을 쓰지 않으면, `pending-approval.md`는 이전 계획으로 남고 ultragoal은 그 계획으로 시작될 수 있습니다.
- **실제 사례**: test-app 세션 `_session-20260928-225638-ses_f17b…`의 `plans/ralplan/<run>/index.jsonl`에서는 `final` 10 뒤에 `revision` 11·`intent` 12만 있고 새 `final`이 없습니다.
- **결정 경위**: R-OD18 결정 때 "넘기기 유지 + 오래된 계획 검사" 안이 있었지만, 관리자는 GJC 방식을 골랐습니다. GJC 방식으로도 이 문제가 풀리지 않는다는 점은 당시 설명했지만 기록하지 않았습니다(대화 기록).
- **해야 할 일**: 기록만 할지, 아니면 마지막 `final` 뒤에 planner/revision 행이 있을 때 경고하거나 거부할지 정합니다.

### U11. ultragoal 계약의 출처 기록과 낡은 문구

이 브랜치는 ultragoal 계약 세 가지를 바꿨습니다: 넘기기(이제 ralplan을 시작함), 진입 게이트, ralplan 런타임의 ultragoal seed. 출처 기록과 문구가 이를 따라가지 못했습니다.

- **출처 기록**:
  - `skills/ultragoal/SKILL.md:279-298` 출처 절은 gajae-code를 한 번(`:291`, leader-recorded review)만 인용하고, 넘기기와 진입 게이트의 GJC 출처는 적지 않습니다.
  - `src/ultragoal.ts:8-12` 파일 머리 주석은 OMC만 적습니다. GJC 출처는 함수 주석(`:545`)과 `THIRD-PARTY-NOTICES.md:13`에만 있습니다.
  - `src/ultragoal-tool.ts:1-2`는 아직 "the only writer of … the ultragoal state"라고 합니다. 실제로는 훅과 ralplan 런타임(편차 25)도 씁니다.
  - `src/ultragoal.ts:535`의 "Every one-mode-at-a-time check uses this and `isRalplanRunning`"도 지금 게이트 구성과 맞지 않습니다.
  - AGENTS.md는 바뀐 계약마다 출처를 적으라고 합니다.
- **낡거나 빠진 SKILL 문구** (`skills/ultragoal/SKILL.md`):
  - `:73`: `source_plan`이 `pending-approval.md`(`pending_approval_path`)라고 말하지 않습니다.
  - `:126`, `:294`: `handoff(to="ralplan")`가 같은 호출에서 ralplan을 시작한다는 점(편차 24)을 적지 않습니다.
  - `:13`: `ralplan.autoHandoff: "ultragoal"` 자동 진입이 빠졌습니다.
  - `:37`: 세션 폴더를 `_session-<label>-<sessionID>`로 적는데, ralplan SKILL과 편차 3은 `_session-<created>-<id>`로 적습니다.
  - 진입 게이트의 거부, `open-gajae`에서만 동작한다는 점(R-OD20), continuation이 agent를 확인하지 않는다는 점(R-OD21)이 없습니다.
- **ralplan SKILL의 관련 문구**: `skills/ralplan/SKILL.md:125`는 넘기기가 스냅숏을 동기화한다고 하지만, 스냅숏에는 ultragoal이 나타나지 않습니다(U1).
- **해야 할 일**: 출처 절·머리 주석·SKILL 문구를 갱신하고, 영향받는 테스트를 함께 고칩니다. U2·U3와 같은 변경으로 묶는 것이 자연스럽습니다.

### U12. ultragoal state의 handoff 필드

- **문제**:
  - `handoff_from`·`handoff_at`은 쓰기만 하고 읽는 코드가 없습니다(status·continuation·압축·복원 어디에도 없음).
  - 게이트 넘기기 없이 `resume`하면 `handoff_at`은 지우지만 옛 `handoff_from`은 남습니다(`src/ultragoal-tool.ts:463-474`).
  - `handoff(to="ralplan")`는 이전 `handoff_from: "ralplan"`을 `handoff_to: "ralplan"` 옆에 남깁니다(`:790-797`).
  - `seedUltragoal`은 ralplan 연산이나 도구의 게이트가 불러도 기록자를 `ultragoal_hook`으로 남깁니다(`src/ultragoal-hooks.ts:96,106`).
- **결정·이유**: R-OD7은 `handoff_from`을 "후속 개발 때 쓰인다"는 이유로 유지했습니다.
- **해야 할 일**: U1에서 쓸 곳을 정하고, 낡은 값 처리와 기록자 표기를 바로잡습니다.

### U13. ultragoal handoff 뒤 `ralplan start`의 메타 소실

- **문제**: ultragoal handoff가 시작한 run에서 `ralplan start`를 다시 부르면 "새 seed로 다시 쓴다"는 점은 ralplan SKILL이 적고 있습니다(`skills/ralplan/SKILL.md:17,230`). 적혀 있지 않은 것은 그때 state와 활성 행(`src/ralplan-runtime/store.ts:385-386`)의 `handoff_from`/`handoff_at`이 사라진다는 점입니다(`startRunTx`, `store.ts:1062`).
- **영향**: 읽는 곳이 status 허용 목록뿐이라 작습니다.
- **해야 할 일**: 기록하거나 메타를 보존합니다.

### U14. PLANNING-STUCK 실행에 대한 게이트 거부 안내

- **문제**: 막힌 run은 진행 중 phase에서 active로 남습니다. 진입 게이트는 이 run을 거부하면서 "승인 단계에서 Approve execution via ultragoal을 고르라"고 안내하는데(`src/ralplan-runtime/store.ts:151-152`), 막힌 run은 그 단계에 가지 못합니다. 같은 안내의 "ralplan 멈추기"는 동작합니다.
- **GJC와 같은 부분**: `final`에서 막힌 run은 게이트와 `ralplan handoff`를 막힘 검사 없이 통과합니다. SKILL은 "never dispatch"라고 하지만, GJC의 `phasePermitsChain`도 막힘을 보지 않습니다.
- **해야 할 일**: 안내 문구를 바로잡을지 정합니다.

### U15. 넘기기 실패 경로의 테스트와 안내

- **README에 있는 것**: 부분 실패 시 결과 문구가 `ralplan start`/`ultragoal resume`을 안내한다는 점(편차 24), doctor에 고아 저널 검사가 없다는 점(편차 13).
- **빠진 것**:
  - ultragoal → ralplan의 "ralplan could not be started" 분기(`src/ultragoal-tool.ts:853-858`, 계획 위험 R-10)에 테스트가 없습니다. R-OD3이 반대 방향(R-O2) 실패 테스트만 남겼기 때문이며, 이는 계획서에만 적혀 있습니다.
  - 두 트랜잭션 사이에서 멈추면 ultragoal은 `handoff`, ralplan은 run이 없는 상태로 남고, 이를 감지하는 곳이 없습니다.
  - ralplan → ultragoal 쪽은 게이트가 ralplan을 강등한 뒤 ultragoal seed가 실패해도, `ralplan handoff` 연산 외의 경로에는 안내와 테스트가 없습니다. R-19와 P-AC7은 연산만 다룹니다.
    - 스킬 로드: 로그만 남깁니다(`src/hooks.ts:859-866`, catch `:874-876`).
    - `@ultragoal` 언급: 로그만 남고 안내가 사라집니다(`:764-770`, catch `:802-804`).
    - 도구 `create`: "`ultragoal start`를 부르라"는 안내 없이 오류만 냅니다(`src/ultragoal-tool.ts:835`).

### U16. 고정 계약의 자동 회귀 검사

- **문제**: 다음 검사는 리뷰 체크리스트로만 남았습니다(R-OD1, R-OD2).
  - P-AC1: ultragoal SKILL·지시문·`record_verdict`를 그대로 둔다.
  - P-AC13: 입력 스키마.
  - P-AC6/7/10: 소스 검색.
- 같은 이유로 훅 테스트 (g)·(h)와 P-AC13 스키마 테스트도 만들지 않았습니다. U2·U3·U11을 할 때 새 테스트가 필요합니다.
- **기록 위치**: 계획서 R-OD1, R-OD2, R-24. README에는 없습니다.

### U17. 실제 모델 VERDICT 확인 결과

- **문제**: 계획서 §6 6단계와 `docs/local-install-v2.md:134`는 ultragoal 목표 검증이 `VERDICT: approve`/`reject`로 끝나는지 사람이 확인하라고 합니다. OQ1 동안의 완화책(R-6)입니다. 확인 결과는 어디에도 기록되지 않았습니다. 프로브 ③은 스크립트라 실제 모델 동작을 보여 주지 못합니다.
- **해야 할 일**: 수동 실행 결과를 기록합니다.

### U18. README의 ultragoal 저장 파일 구성

- **문제**: README에는 ralplan 저장 구성은 있지만 ultragoal 파일 구성은 없습니다.
  - 실제 파일은 `ultragoal/goals.json`, `ultragoal/progress.txt`(`src/state.ts:662-663`), `state/ultragoal-state.json`입니다.
  - `README.md:215`가 `goals.json`·`progress.txt`를 언급할 뿐입니다.
- **경위**: 2026-09-27에 조사 보고로 지적됐지만 따로 다루지 않았습니다(대화 기록).

### U19. executor 프롬프트의 옛 계획 경로

- **문제**: ultragoal의 구현 역할인 executor의 프롬프트가 옛 계획 경로를 가리킵니다.
  - `prompts/open-gajae-executor.md:30`은 "Plan files (`.open-gajae/_session-*/plans/*.md`) are READ-ONLY"라고 합니다. 그런데 spec D-T4 이후 계획은 `plans/ralplan/<run>/…`에 있어서 이 glob에 맞는 계획 파일이 없습니다.
  - 출처 절(`:115`)도 `.omc/plans`를 `plans/`로 대응시킵니다.
  - 이 브랜치는 executor 프롬프트를 건드리지 않았습니다.
- **해야 할 일**: 경로를 `plans/ralplan/**`로 바꿉니다. 프롬프트는 런타임 계약이므로 테스트도 함께 고칩니다.

## 기록된 차이 (U1 이후 다시 볼 후보)

### U20. ultragoal 실행 중 계획 가드 꺼짐 (편차 28, R-O7)

GJC의 "현재 스킬" 검사를 "루트 세션에서 ultragoal이 실행 중인가"로 근사했습니다. ultragoal에 행이 없기 때문입니다. 그래서 ultragoal 실행 중에는 계획 편집 보호가 없고, 항상 차단 경로만 남습니다(`src/hooks.ts:573-601`). U1이 생기면 GJC 방식(`skill-state/workflow-mutation-guard.ts:294-310`)으로 바꿀 수 있습니다.

### U21. ultragoal 실행 중 진입 게이트가 ralplan 무시 (편차 29, R-O9)

실행 중인 ultragoal의 `create`와 스킬 재로드는 ralplan을 보지 않습니다. GJC `tools/skill.ts:192-220`에 가장 가까운 선택이었습니다. U1 이후 행 기반 판단으로 다시 볼 수 있습니다.

### U22. ultragoal 실행 중 ralplan write의 영향 (R-AE1, R-O6)

- **기록된 것**:
  - ultragoal 실행 중에는 `start`만 거부됩니다.
  - 역할이나 primary의 `write`는 ralplan을 활성으로 만들 수 있습니다. 특히 ultragoal 리뷰어로 쓰인 architect·critic의 write가 그렇습니다(U2).
  - ultragoal이 끝나면 가드가 편집을 막고 게이트가 새 ultragoal을 거부합니다.
  - 정리는 수동입니다(`ralplan state {active:false}` 또는 `clear`). README 수용 차이 "One-mode rule partly lifted", 계획서 R-AE1·R-13.
- **미룬 선택지**: 리뷰(`.omc/drafts/reviews/iter1-architect.md:13`)에는 "ultragoal 완료·취소 때 final 없는 ralplan을 끄는" 선택지 (c)가 있었습니다. 관리자에게 물을 때 이 안은 "후속 범위"로 설명됐고(대화 기록), (a)가 채택됐습니다(계획서 `:437`).
- **미기록 보충**:
  - **넘긴 뒤의 리뷰어 write**: ralplan → ultragoal 넘기기 뒤라면 같은 run의 `handoff` phase는 잠겨 있어 state는 그대로입니다(`src/ralplan-runtime/store.ts:681-689`). 하지만 승인된 run에 단계 파일과 원장 행이 더해지고, 예산을 쓰고, 활성 행을 다시 씁니다(`README.md:156`). 그래서 ultragoal 실행 중에 스냅숏에는 ralplan이 보입니다.
  - **continuation 재개**: 이렇게 켜진 ralplan은 ultragoal이 턴을 처리하지 않게 되면 ralplan continuation도 다시 받습니다(`src/hooks.ts:441-448`). README에는 가드와 게이트만 적혀 있습니다.

### U23. ultragoal → ralplan 넘기기에 저널 없음 (편차 24, R-O1, R-O8)

두 트랜잭션으로 순서대로 쓰고, 중간에 실패하면 결과 문구가 `ralplan start`나 `ultragoal resume`을 안내합니다. 역할 ID와 판정은 넘어가지 않고, run 폴더와 예산은 재사용되며, `run_id` 입력은 없습니다. GJC는 필드를 보존하는 병합과 저널을 씁니다(`gjc-runtime/state-runtime.ts:1739-1763`, 저널 `:1765,1847`).

### U24. ralplan 런타임이 ultragoal state를 씀 (편차 25, R-O2)

ultragoal 도구가 ultragoal state의 유일한 작성자라는 원칙의 예외이고, 소비 표시(consumption marker)가 없습니다. ultragoal 쓰기가 실패하면 결과가 `ultragoal start`를 안내합니다.

### U25. Stop here 뒤 `handoff_from` 없이 시작 (편차 34, R-OD18)

`ralplan handoff`가 비활성 ralplan을 거부하므로, 나중에 ultragoal을 불러오면 ralplan에서 왔다는 기록이 없습니다. 턴 단위로 인계하는 GJC의 결과와 같습니다.

### U26. 안내·seed·복원 안내는 `open-gajae`에만 (R-OD20)

- **동작**: 다른 agent에게는 ultragoal 키워드·언급 안내, seed, 복원 안내를 주지 않습니다. 그 agent의 프롬프트도 일시정지 해제와 오래된 seed 정리는 합니다. 기록 위치는 README "Deviations from OMC" 표입니다.
- **문서 틈**: `README.md:153`은 스킬 로드 게이트를 조건 없이 설명하지만, 실제로는 primary에만 적용됩니다(`src/hooks.ts:848`).

### U27. continuation이 agent를 확인하지 않음 (R-OD21)

세션을 다른 agent로 바꾸면 ultragoal continuation도 그 agent의 턴에 주입되고, 도구는 그 agent를 거부합니다. 거부된 호출도 도구 호출로 세므로(`src/hooks.ts:950-952`, `src/ultragoal.ts:683-713`), 이 "자체 한도"는 `ultragoal.hardMaxIterations`(기본 200)까지일 수 있습니다. 코드에서 추론한 것이고 테스트는 없습니다. 관리자 결정으로 기록만 했습니다.

### U28. ultragoal 도구가 다른 agent 카탈로그에 보임 (DR-22, 이전부터)

- **동작**: 호스트 `build`·`general`과 사용자 정의 agent에게 도구가 보이고, 실행할 때만 거부됩니다. 이 브랜치 이전부터 그랬습니다.
- **기록**: DR-22는 ralplan 결정이고, ultragoal의 이 동작을 선례로 인용합니다(계획서 `:50`). README 수용 차이 "Where `ralplan` is hidden"은 ultragoal 도구도 같다고 적습니다.
- **경위**: 숨기는 안은 관리자에게 물을 때 "ultragoal 쪽까지 바뀌어 이번 범위가 늘어난다"는 설명과 함께 채택되지 않았습니다(대화 기록).

### U29. 진입 게이트의 phase 처리 (R-CE1, DR-21)

- **동작**:
  - GJC의 종료 phase 8개 중 하나에 있는 활성 ralplan은 거부하지 않고 넘깁니다.
  - OMC 형식의 옛 state는 읽을 수 없는 것으로 보고 통과시키며, 변환 코드는 없습니다.
  - 키워드 seed는 스킬을 불러올 때까지 게이트를 거치지 않습니다.
- **기록 위치**: 앞의 둘은 README 수용 차이(`README.md:313-314`)에 있습니다. 키워드 seed는 계획서 C-4(`:114`)와 `src/hooks.ts:744-749` 주석에만 있습니다.

### U30. 진입 게이트가 매 턴 지속 state를 읽음 (편차 37)

open-gajae의 ultragoal 게이트는 매 턴 지속 state를 읽습니다. 반면 GJC 가드는 ralplan을 불러온 턴이 끝나면 더는 적용되지 않습니다. 그래서 앞 턴에서 계획 phase로 남은 활성 ralplan이 있으면 open-gajae는 ultragoal을 거부하지만, GJC는 거부하지 않습니다. 편차 37 영향 칸(`README.md:299`)에 적혀 있습니다. U1 이후 행 기반 판단과 함께 다시 볼 수 있습니다.

## 알려진 한계

### U31. 여러 프로세스 간 직렬화 없음

같은 worktree를 쓰는 여러 OpenCode 프로세스의 쓰기는 서로 직렬화되지 않습니다. 플러그인은 한 프로세스 안에서만 쓰기를 줄 세우고, GJC는 파일 잠금을 씁니다. ultragoal state와 두 방향 넘기기에도 해당합니다. 기록 위치는 README 필수 후속 4입니다(기록만, 일정 없음).

## 이전부터 있던 문제 (이번 개발과 무관)

### U32. 재시작 안내 문구

`src/ultragoal-tool.ts:455`와 `src/ultragoal.ts:861`은 "키워드나 `@ultragoal`로 다시 시작하라"고 안내합니다. 이 문구는 `9e05eaf`에서 들어왔고, 이후 `87a6b1a`(2026-09-26)에서 `start` 연산이 추가됐지만 문구는 바뀌지 않았습니다.

### U33. ultragoal에서 deep-interview로 넘기기 없음

GJC ultragoal은 deep-interview로도 넘길 수 있습니다(`defaults/gjc/skills/ultragoal/SKILL.md:475`). open-gajae의 `handoff`는 `to: "ralplan"`만 받습니다(`src/ultragoal-tool.ts:155`). 이 브랜치 이전부터의 차이입니다.

## 묶음 제안

결정은 관리자 몫이고, 아래는 함께 하면 자연스러운 묶음입니다.

1. **ultragoal GJC 개정**: U1, U2, U3, U11, U12, U16, U19.
   - 관리자 조건("active skill.json 개발할 때")에 따라 U1과 U2를 함께 합니다.
   - 끝나면 U20·U21·U27·U30을 다시 봅니다.
   - U5가 풀리면 진행 표시도 붙입니다.
2. **ralplan ↔ ultragoal 넘기기 정리**: U6, U7, U8, U10, U13, U15. 계획 경로 전달, 안내 문구, 왕복 흐름을 한 번에 설계합니다.
3. **독립 항목**: U4, U9, U14, U17, U18, U22 보충, U26 문서 틈, U32, U33.
