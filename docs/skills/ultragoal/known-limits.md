# 알려진 한계와 후속

이 문서는 ultragoal에 남아 있는 한계와 후속 작업을 모읍니다.

- **출처**: 옛 `docs/ultragoal-follow-ups.md`(2026-09-29 작성)에서 아직 열린 항목을 옮겼습니다. 해결된 항목은 맨 아래 대응표에 한 줄씩만 남깁니다.
- **번호**: U 번호는 옛 문서의 번호를 그대로 씁니다. 다음 곳이 이 번호를 참조합니다.
  - 루트 `README.md`와 `README.ko.md`: U8(ultragoal 편차 22), U13, U27, 그리고 대응표 범위 U1–U34
  - `docs/local-install-v2.md`: U27
  - `skills/ultragoal/SKILL.md`: U3, U32
- **새 항목**: U35–U38은 2026-09-30~10-01 수동 실행에서, U39–U41은 이 폴더의 문서를 쓰면서 새로 찾은 것입니다.
- **결정 필요**: 이렇게 표시한 항목은 AGENTS.md에 따라 구현 전에 관리자가 정합니다.

기준 코드는 [README.md](README.md) 머리에 적은 커밋입니다.

## 필수 후속 (루트 README "Mandatory follow-up development")

### U34. deep-interview 활성 행 설계 (README 1·7)

- **현재 동작**:
  - 활성 행 `state/active/<skill>.json`과 스냅숏 `state/skill-active-state.json`은 ralplan과 ultragoal만 씁니다.
  - `ultragoal handoff(to: "deep-interview")`의 callee 쪽은 deep-interview state만 병합합니다. phase는 `"deep-interview"`이고, `handoff_from`·`handoff_at`을 더하며 기존 필드는 유지합니다. deep-interview 행은 쓰지 않습니다(PQ-5 (1) B, (2) A, spec 「E5」). caller 쪽인 ultragoal state와 그 비활성 행은 다른 인계와 같이 씁니다.
- **증상**: deep-interview로 넘긴 뒤에는 보이는 주 skill이 없습니다. 스냅숏과 HUD 칩에도 deep-interview가 나타나지 않습니다(ralplan 편차 14, ultragoal 편차 33).
- **해야 할 일**:
  - 다음 deep-interview 개정(gjc 비교)에서 callee 행과 행 수명을 함께 정합니다. GJC는 callee 행을 쓰고, 초기 phase는 `interviewing`입니다.
  - 그때 새로 만드는 deep-interview 도구도 소유하지 않은 agent에게서 숨깁니다(spec D-HE8, README 7).

### U5. TUI 진행 표시 (README 6)

- **현재 동작**: ultragoal HUD 칩은 활성 행에 계산해 기록만 하고 그리지 않습니다([state-and-files.md](state-and-files.md)).
- **이유**: 배포된 OpenCode 2.0.15 바이너리가 TUI 플러그인의 import를 호스트 인스턴스로 연결하지 않습니다. 이는 코드로 확인할 수 없고, 2026-09-29 수동 확인 결과입니다(루트 README 필수 후속 6). 그래서 ralplan 사이드바도 제거됐습니다(R-OD17).
- **해야 할 일**: 호스트가 import를 연결해 주거나, 가상 모듈 우회를 호스트 통합 편차로 기록하면 사이드바와 ultragoal 칩을 함께 그립니다.

### U4. 항상 차단 경로의 대소문자 정규화 (README 5)

- **현재 동작**: 항상 차단 검사는 대소문자를 구분합니다([guards.md](guards.md)). 대상은 `.open-gajae/_session-*/state/**`, `plans/ralplan/**`, ultragoal 파일입니다.
- **증상**: macOS 기본 파일 시스템에서는 `.OPEN-GAJAE/…` 같은 경로가 검사를 빠져나갑니다.
- **해야 할 일**: 비교 전에 대소문자를 정규화합니다(R-OD13).

### U31. 여러 프로세스 간 직렬화 없음 (README 4, 기록만)

- **현재 동작**: 세션마다 쓰기 큐 하나(`src/state.ts`의 `workflowTransaction`)가 한 프로세스 안의 쓰기를 모두 줄 세웁니다.
- **한계**: 같은 worktree를 쓰는 여러 OpenCode 프로세스 사이는 직렬화하지 않습니다. GJC는 파일 잠금을 씁니다.

## 기록된 동작 (루트 README 편차·알려진 동작에 있음)

### U8. 같은 execution의 `skill ultragoal`이 먼저 넘긴 뒤 `ralplan handoff` 거부 (ultragoal 편차 22)

- **흐름**: ralplan을 불러온 execution에서 `skill ultragoal`을 로드하면, `src/hooks.ts`의 `ultragoalGate`가 저널 인계를 먼저 수행합니다. 그 뒤 모델이 ralplan SKILL 9단계대로 `ralplan handoff`를 부르면 거부됩니다.
- **거부 문구**:
  ```
  ralplan was already handed off (inactive, phase handoff); continue in the `ultragoal` skill.
  ```
- **영향**: 거부 문구가 ultragoal로 가라고 하므로 흐름은 멈추지 않습니다. ralplan SKILL도 ultragoal을 불러오기 전에 `ralplan handoff`를 먼저 부르라고 안내합니다.

### U13. 넘겨받은 ralplan에서 `ralplan start`를 부르면 인계 메타가 사라짐 (PQ-4 A)

루트 README 알려진 동작의 "넘겨받은 ralplan은 옛 run을 이어 씁니다" 행이 U13을 가리킵니다. 하지만 그 행은 옛 승인, 예산, `stage_n`이 이어진다는 내용입니다. 아래의 메타 소실은 README에 없고 이 문서에만 있습니다.


- **정상 경로**: ultragoal에서 넘겨받은 ralplan run은 `start` 없이 `ralplan write`로 이어 씁니다.
- **메타가 사라지는 경우**: SKILL 안내를 따르지 않고 `ralplan start`를 부르면 새 seed로 다시 쓰면서 `handoff_from`·`handoff_at`이 사라집니다(`src/ralplan-runtime/store.ts`의 `startRunTx`).
- **영향**: 이 값을 읽는 곳이 status 표시뿐이라 작습니다.

### U22. ultragoal 실행 중 ralplan write의 영향 (README 수용 차이 "One-mode rule partly lifted")

- **현재 동작**:
  - ultragoal 실행 중에는 `ralplan start`만 거부되고, `write`는 ralplan을 활성으로 만들 수 있습니다.
  - ultragoal 행이 활성인 동안은 순위(ultragoal > ralplan > deep-interview)상 ultragoal이 보이는 주 skill입니다. 그래서 ralplan 가드와 ralplan continuation은 적용되지 않습니다.
  - ultragoal 행이 사라지면 ralplan 행이 이어받습니다.
- **정리 방법**: 수동입니다. `ralplan state {active:false}`나 `clear`를 씁니다.

### U25. Stop here 뒤에는 `handoff_from` 없이 시작 (ralplan 편차 34, R-OD18)

- **현재 동작**: `ralplan handoff`는 비활성 ralplan을 거부합니다. 그래서 Stop here 뒤 나중에 ultragoal을 불러오면 ralplan에서 왔다는 기록이 없습니다.
- **GJC와의 관계**: 턴 단위로 인계하는 GJC의 결과와 같습니다.

### U26. 안내는 `open-gajae`에만 (README "Deviations from OMC", R-OD20)

옛 문서의 "복원 안내"는 이제 없습니다. `src/hooks.ts`의 `prompt` 훅은 agent에 따라 셋으로 나뉩니다.

- **역할 subagent**(`ROLE_SUBAGENTS`: planner, architect, critic, executor, cleaner 다섯): 첫 검사(G1)에서 바로 돌아갑니다. 아무것도 하지 않습니다.
- **그 밖의 다른 agent**(예: 루트 세션의 `build`, `open-gajae-explore`, `open-gajae-document-specialist`):
  - 중단 표시를 풀고, 계보 루트 세션이면 goal 보류도 풉니다([goal-loop.md](goal-loop.md)).
  - ralplan·deep-interview·ultragoal 키워드와 멘션 안내는 주지 않습니다.
- **`open-gajae`**: 위의 일에 더해 안내까지 줍니다. agent가 없는 세션이나 agent 조회에 실패한 경우도 안내를 받습니다.

### U27. continuation이 agent를 확인하지 않음 (README 알려진 동작, PQ-20 A)

- **현재 동작**: goal continuation은 GJC 경로 A처럼 agent를 확인하지 않고, 반복 상한도 없습니다.
- **증상**: 세션을 `build` 같은 다른 agent로 바꾸면 continuation이 그 agent의 턴에 계속 들어옵니다.
  - 그 agent에게서는 `goal`·`ultragoal`이 숨겨져 있어 goal을 끝낼 수 없습니다.
  - 그 agent의 다른 도구 호출은 도구 진행으로 셉니다.
- **끝내는 방법**: 다음 셋뿐입니다.
  - Esc(다음 사용자 프롬프트까지)
  - 도구 없는 턴 3회 보류
  - `open-gajae`로 돌아가 `goal drop`
- **테스트**: `tests/hooks.test.ts` (A2)가 이 동작을 확인합니다.

## 이 문서에만 기록된 항목

### U6. 계획 경로는 텍스트로만 넘어감 (GJC 한계로 기록)

- **경로를 알리는 곳**: `src/ralplan-runtime/store.ts`에서 두 곳입니다. 모두 `(the approved plan: <path>)` 꼴로 `pending-approval.md` 경로를 적습니다.
  - `ralplanHandoff`의 결과 문구
  - ralplan이 비활성일 때의 거부 문구. 다만 이미 인계된 경우의 거부(`ralplan was already handed off …`)는 경로를 적지 않습니다.
- **경로를 알리지 않는 곳**: 같은 execution의 `skill ultragoal` 게이트(`src/hooks.ts`의 `ultragoalGate`)는 경로를 알리지 않습니다. 이때 모델은 final 영수증의 `pending_approval_path`에서 경로를 읽습니다.
- **저장되지 않음**:
  - ultragoal state에는 계획 경로 필드가 없습니다(`source_plan` 없음, spec D-HE1).
  - `status`, continuation, 압축 복구 문맥도 경로를 보여 주지 않습니다.
  - 모델이 `create`의 `description`에 경로를 적으면 `goals.json`에 남습니다.
- **결정**: GJC도 계획을 텍스트로만 넘기므로 기록만 합니다.

### U10. 오래된 `pending-approval.md` 전달 (결정 필요, spec D-HE7)

- **원인**:
  - ralplan의 `final`은 phase가 잠깁니다(`src/ralplan-runtime/manifest.ts`의 `RALPLAN_PHASE_LOCK`). 그래서 `final` 뒤에 `revision`이나 `intent`를 써도 phase는 `final`에 남습니다.
  - `pending-approval.md`는 `final`을 쓸 때만 새로 복사됩니다.
- **증상**: 새 `final` 없이 인계하면 ultragoal은 이전 계획으로 시작할 수 있습니다.
- **실제 사례**: test-app 세션 `_session-20260928-225638-ses_f17b…`의 `index.jsonl`에서는 `final` 10 뒤에 `revision` 11과 `intent` 12만 있습니다.
- **선택지**:
  - 기록만 둡니다.
  - 마지막 `final` 뒤에 planner/revision 행이 있으면 인계를 경고하거나 거부합니다.

### U14. 막힌(PLANNING-STUCK) run에 대한 거부 안내 (결정 필요)

- **거부가 나는 때**: `src/hooks.ts`의 `ultragoalGate`는 다음 조건이 모두 맞으면 `RALPLAN_RUNNING_REFUSAL`로 거부합니다. 알 수 없는 phase면 거부하지 않고 시드로 넘어갑니다.
  - 같은 execution에 ralplan을 불러왔습니다.
  - ralplan이 활성입니다.
  - phase가 알려진 phase입니다.
  - phase가 종료 집합 밖입니다.
  ```
  ralplan planning is running; finish it first: choose "Approve execution via ultragoal" at its approval step, or stop ralplan (`ralplan state` with {"active": false}) and try again.
  ```
- **문제**:
  - 예산을 넘겨 `PLANNING-STUCK`이 된 run은 진행 중 phase에 활성으로 남습니다. 그래서 승인 단계로 갈 수 없는데도 안내는 승인 단계를 고르라고 합니다. 뒤쪽 "ralplan 멈추기" 안내는 동작합니다.
  - `final`에서 막힌 run은 게이트와 `ralplan handoff`를 막힘 검사 없이 통과합니다. GJC의 `phasePermitsChain`도 막힘을 보지 않습니다.
- **결정할 것**: 안내 문구를 고칠지 정합니다.

### U15. 중단된 인계의 저널을 감지하지 않음 (나머지 부분, ralplan 편차 13)

- **저널의 성격**: 인계 저널 `state/transactions/<mutation id>.json`은 증거용입니다(`src/skill-state/journal.ts`, plan I-19). 다시 실행하거나 되돌리는 코드가 없고, doctor도 읽지 않습니다.
- **증상**: 인계 도중 프로세스가 멈추면 `pending` 저널이 남습니다. 이를 알리는 곳이 없습니다.
- **해결된 쪽**: 두 방향 인계 모두 한 트랜잭션이라, 옛 코드의 "두 트랜잭션 사이 부분 인계"는 없어졌습니다.

### U16. 리뷰 체크리스트로만 남은 계약 검사 (나머지 부분)

- **자동 테스트가 확인하는 것**:
  - `tests/integration.test.ts`는 SKILL·프롬프트 문자열을 확인합니다.
  - `tests/ultragoal-tool.test.ts`는 입력 스키마와 결과 문구를 확인합니다.
- **체크리스트로만 남은 것**:
  - 옛 계약이 남았는지 보는 grep(계획 P-AC1, `.omc/plans/ralplan-ultragoal-gjc-revision.md` 4.2절)은 계획에 적힌 수동 명령이고, 테스트가 돌리지 않습니다.
  - 모든 workflow 쓰기가 세션 쓰기 큐 하나를 거친다는 규율(계획 P-AC2)도 리뷰 체크리스트입니다.

## 수동 실행에서 새로 찾은 항목 (2026-09-30 ~ 10-01)

근거로 삼은 실행은 두 번입니다.

- test-app `_session-20260930-202416-ses_f0df11fc…`: 모든 역할 `openai/gpt-6-luna-fast`
- test-app `_session-20260930-234931-ses_f0d35376…`: 모든 역할 `openai/gpt-6-sol-fast`

플러그인 동작 자체의 오류는 두 실행 모두 없었습니다. 두 세션 폴더와 OpenCode 세션 기록은 저장소 밖에 있습니다. 실행 조건과 체크리스트별 결과는 `docs/local-install-v2.md` 6절에 부분 실행으로 기록했습니다.

### U35. 마지막 목표에서 architect를 몇 번 돌릴지 정해져 있지 않음 (결정 필요)

- **SKILL이 말하는 것**:
  - "Every goal gets its own architect review"
  - 최종 gate는 "the per-goal gate plus the `reviewCohort` and `criticReview` sections"
  - 마지막 목표에서 목표별 architect를 cohort architect lane과 **따로** 돌려야 하는지는 말하지 않습니다.
- **코드가 하는 것**: `src/ultragoal-runtime/gate.ts`는 `architectReview`와 `reviewCohort.lanes.architect`를 따로 검사할 뿐, 둘이 다른 리뷰인지는 보지 않습니다. 그래서 architect 결과 하나로 두 칸을 채울 수 있습니다.
- **실제 실행**: 첫 실행은 architect를 두 번(목표별, cohort) 돌렸고, 두 번째 실행은 한 번만 돌렸습니다.
- **인터뷰 선택**: R15-1에서 "C. 목표마다 + 경계"를 골랐고, "E. 목표마다 + 경계(중복 없음)"은 고르지 않았습니다. 결과는 spec D-VF1에 있고, 선택지 E는 인터뷰 대화 기록에만 있습니다.
- **선택지**:
  - SKILL에 "마지막 목표는 cohort architect 하나로 충분"을 적습니다.
  - SKILL에 "따로 한 번 더"를 적습니다.
  - 그대로 둡니다.

### U36. cohort blocker 기록과 세대당 lane 1회는 SKILL만 요구함 (결정 필요)

- **런타임이 검사하는 것**: `validate_gate`와 `checkpoint(complete)`는 제출된 `reviewCohort`의 모양만 봅니다.
  - 확인하는 것: `reviewGeneration`, `joined`, 세 lane의 판정·증거·blockers, QA의 `commands`·`adversarialCases`, 1세대의 `deltaOnly` 금지, 2세대부터 필요한 `deltaOnly`·`deltaPaths`, `scopeExpansion`의 키([gates-and-receipts.md](gates-and-receipts.md))
  - 확인하지 않는 것: 이전 세대의 blocker가 `record_review_blockers`로 원장에 기록됐는지
- **GJC와의 관계**: GJC의 `validateReviewCohort`도 이를 보지 않습니다. 다만 GJC는 lane마다 같은 `sourceHash`를 요구하는데, open-gajae는 이를 뺐습니다(D-VF5).
- **실제 실행**:
  - 첫 실행은 blocker가 세 번 나왔는데 `record_review_blockers` 없이 바로 고쳤고, 같은 세대에서 lane을 다시 돌렸습니다. 그래서 원장에는 이벤트가 3줄뿐이고, 제출서의 `reviewGeneration: 3`은 그대로 통과했습니다.
  - 두 번째 실행은 절차를 지켰습니다.
- **선택지**:
  - SKILL 문구로만 둡니다.
  - 런타임 검사를 더합니다. 예: 2세대 이상이면 create 이후 `review_blockers_recorded`가 있어야 함.

### U37. cleaner가 테스트를 돌려 병렬 lane과 충돌할 수 있음 (결정 필요)

- **원인**: `prompts/open-gajae-cleaner.md`는 read-only cleaner에게 "running existing tests, lint, or typecheck without write flags"를 허용합니다. 이 문장은 gjc 원문이 아니라 예전 open-gajae 프롬프트에서 가져왔습니다.
- **증상**: cohort lane은 병렬로 돕니다. 첫 실행에서 cleaner와 QA lane이 동시에 `npm run test:e2e`를 돌렸고, 같은 Playwright `test-results/`를 써서 `ENOENT`가 났습니다. 이것이 가짜 blocker가 되어 리뷰가 한 바퀴 더 돌았습니다.
- **선택지**:
  - cleaner의 테스트 실행을 금지합니다.
  - 그대로 둡니다.

### U38. ralplan 감사 로그의 `invalid_transition_detected` (기록만)

- **현재 동작**: 두 실행 모두 ralplan 쓰기에서 `invalid_transition_detected` 감사 행이 4~5개 남았습니다. 예: intent→critic, critic→architect, architect→revision, revision→architect, architect→post-interview, post-interview→final.
- **원인**:
  - `src/ralplan-runtime/manifest.ts`의 `RALPLAN_TRANSITIONS`는 gjc 전이 표와 행 단위로 같습니다.
  - 그런데 SKILL이 시키는 흐름은 이 표에 맞지 않습니다. 1차 병렬 리뷰, revision 뒤 architect 재검토, `adr` 단계 없는 `final`이 그렇습니다. GJC에서도 같습니다.
- **영향**: 기록만 남고 쓰기는 진행됩니다(spec D-T11). ralplan을 다시 개정할 때 볼 후보입니다.

## 문서화 중 확인한 불일치 (2026-10-01, 결정 필요)

이 폴더의 문서를 쓰면서 찾은 것들입니다. 각 항목은 검토자가 코드를 읽고 실제로 실행해 확인했습니다. 모두 코드나 문구를 고칠지, 기록만 할지 관리자가 정해야 합니다. 자세한 동작은 괄호 안 문서에 있습니다.

### U39. 결과 문구·SKILL·README가 실제 동작과 다름

**런타임 문구** (`src/goal/messages.ts`, `src/ultragoal-runtime/messages.ts`)
- **보류 안내의 원인 줄**: `Cause:` 줄은 "continuation turns"라고 합니다. 하지만 코드는 무엇이 턴을 시작했는지 보지 않고 루트의 성공한 execution을 모두 셉니다. 그래서 사용자 프롬프트로 시작한 턴도 들어가고, 호스트가 백그라운드 자식이 끝난 뒤 루트를 다시 돌리는 경우 그 턴도 들어갑니다(호스트 동작은 확인 못 함; `goalHoldNotice`, `decideContinuation`; [goal-loop.md](goal-loop.md)).
- **보류 안내의 해제 조건**: 안내는 "any user message releases the hold"라고 합니다. 하지만 다음 경우에는 풀리지 않습니다.
  - 역할 subagent의 프롬프트
  - 플러그인 표식이 들어간 프롬프트
  - 루트가 아닌 세션의 프롬프트
- **goal 도구 설명**: `GOAL_TOOL_DESCRIPTION`과 `goalContextText`는 `get`이 "usage state"를 돌려준다고 합니다. 하지만 사용량 기록은 없어졌고(ultragoal 편차 8), `get`은 `Goal:`·`Status:`만 돌려줍니다.
- **`ULTRAGOAL_PLAN_MISSING`**: "missing or empty"라고 하지만, 비어 있거나 `{}`·`goals: []`인 `goals.json`은 읽을 수 없는 상태 문구로 갑니다.
- **완료된 목표의 checkpoint 거부**: 거부 문구는 증거가 같아도 "with different evidence"라고 합니다. 이 경우는 파일을 도구 밖에서 고쳤을 때만 생깁니다(`completeCheckpointRefusal`).
- **다음 목표 안내**: checkpoint는 다음 목표가 이미 active여도 ``Run `ultragoal next` to activate the next ultragoal goal.``을 출력합니다. 같은 요청을 다시 보낸 replay이거나, 다른 목표가 active인 동안 `failed` 목표를 완료할 때입니다([ops.md](ops.md)).
- **`record_review_blockers`의 증거 누락 거부**: `checkpoint evidence is required` 문구를 그대로 씁니다.
- **`record_critic_verdict`의 거부 문구**: "requires an active ultragoal plan"이라고 하지만, 실제로는 완료된 계획도 받습니다.
- **critic 연속 횟수**: `6/5`처럼 5를 넘겨 표시될 수 있습니다. 보이는 goal이 없으면 초기화 표식도 무시합니다([gates-and-receipts.md](gates-and-receipts.md)).

**`skills/ultragoal/SKILL.md`**
- **`validate_gate`**: SKILL은 `checkpoint(complete)`와 "exactly the same rules"라고 합니다. 하지만 `validate_gate`는 목표 시작 상태, `evidence`, 진행 목록을 보지 않고, 없는 목표는 오류가 아닌 결과(`unknown_goal`)로 돌려줍니다.
- **다시 열 목표**: SKILL은 "the last completed one"을 다시 열라고 합니다. 하지만 "영수증 없음"과 "낡은 영수증" 사유에서는 코드가 영수증이 없거나 낡은 목표 중 파일 순서상 첫 목표를 가리킵니다(`runCompletion`).
- **마지막 남은 목표를 supersede하는 예**: SKILL("when the last remaining pending goal is superseded after every other goal completed")과 [gates-and-receipts.md](gates-and-receipts.md)는 `pending` 목표를 예로 듭니다. 하지만 마지막 per-goal checkpoint가 남은 목표를 곧바로 `active`로 만들고, `supersede`는 `active` 목표를 거부합니다. 실제로는 `blocked`·`review_blocked`이거나 `checkpoint(status: "pending")`으로 되돌린 목표여야 합니다.
- **`goal-planning`을 끝내는 op**: SKILL은 `create` 전에 `status`·`classify_blocker`만 조심하라고 합니다. 하지만 이전 `goals.json`이 있으면 `next`, `checkpoint`, 계획 변경 op, `record_*`도 reconcile로 `goal-planning`을 끝냅니다([entry-and-handoff.md](entry-and-handoff.md)).
- **수정 목표의 cohort 세대**: SKILL은 수정 목표에 "a new cohort generation"이 필요하다고 합니다. README ultragoal 편차 29도 비슷하게 적습니다. 하지만 코드는 세대를 기억하지 않아, 수정 목표의 첫 checkpoint에서 `reviewGeneration: 1`도 통과합니다(U36과 관련).

**프롬프트와 SKILL 사이**
- **architect 세 상태를 채우는 법**: SKILL(목표별 gate 2단계)은 architect의 각 측면 지적에서 `architectureStatus`·`productStatus`·`codeStatus`를 기록하라고 합니다. `prompts/open-gajae-architect.md`의 출처 주석은 "this prompt's single architectural status"에서 채운다고 하며 ultragoal 편차 13을 인용하지만, 편차 13 행은 이 내용을 다루지 않습니다. 코드는 세 값이 모두 `"CLEAR"`인지만 봅니다([guards.md](guards.md)).
- **cleaner BLOCKED 뒤의 처리**: cleaner 프롬프트의 `Leader Action`은 executor에게 blocking 지적만 고치게 하고 cleaner를 다시 돌리라고 합니다. SKILL cohort 3단계는 cleaner의 BLOCKING 지적이 따로 수정 루프를 시작하지 않고 cohort 지적에 합쳐진다고 합니다.

**루트 README**
- `state/ultragoal-state.json`이 "rewritten from `goals.json` and the ledger"라고 합니다. 실제 reconcile은 기존 필드 위에 병합하므로 `handoff_*` 같은 필드가 남습니다.
- **보류 기록이 새 goal에서 새로 시작한다는 문장**: 보류 항목은 `goal-continuation.json`이 "starts over for a new goal"이라고 합니다. 파일 기록은 맞지만, critic 연속 횟수는 원장에서 마지막 OKAY나 `plan_created`까지 거슬러 셉니다.
  - `critic_streak` 보류 중에 `goal drop` 뒤 `goal create`로 새 goal을 만들거나 기록 파일이 깨지면, 기록은 새로 시작해도 다음 판단에서 다시 보류됩니다.
  - 같은 goal이 보류 중이면 `held`를 푸는 것은 루트의 실제 사용자 프롬프트뿐입니다. 그 사이 `ultragoal create`나 critic OKAY가 기록돼도 연속 횟수만 끊기고 `held`는 남습니다.
  - 새 goal id와 함께 새 `plan_created`가 생긴 경우(`goal drop` 뒤 `ultragoal create`)에만 다시 보류되지 않습니다.

  자세한 동작은 [goal-loop.md](goal-loop.md)에 있습니다.

### U40. 검사 순서와 누락

- **checkpoint replay**: 같은 상태와 같은 증거로 `checkpoint(complete)`를 다시 부르면, gate와 진행 목록 없이도 성공합니다. replay 검사가 gate 검사보다 먼저이기 때문입니다(`checkpointTx`).
- **`record_review_blockers` 중복 판정**:
  - 중복이면 `evidence` 검사 전에 성공으로 돌아갑니다.
  - 찾는 방식: 목표 문장(objective)이 같은 **첫** 열린 수정 목표를 부모와 상관없이 찾고(`findOpenReviewBlockerGoal`), 그 목표의 부모가 이번 `goal_id`일 때만 중복으로 봅니다(`recordReviewBlockersTx`). 그래서 첫 일치 목표의 부모가 다르면, 같은 부모의 열린 수정 목표가 뒤에 있어도 새 수정 목표를 또 만듭니다.
- **한 부모에 열린 수정 목표가 여럿**: 가장 먼저 끝난 것이 부모를 대체하고, 나머지는 필수 목표로 남습니다(`completionView`).
- **gate가 받아들이는 입력**: 섹션 안의 모르는 키(예: `sourceHash`), 문자열이 아닌 `deltaPaths` 항목(걸러짐), 객체가 아닌 `scopeExpansion`을 결함 없이 받습니다(`gate.ts`).
- **`qualityGateHash`**: 원장의 `qualityGateJson`과 다시 대조하지 않습니다. 원장의 gate JSON을 고쳐도 영수증은 `valid`로 남습니다(`checkReceipt`).
- **깨진 원장**: `create`, 계획 변경 op, `record_review_blockers`, `classify_blocker`, `handoff`는 원장을 엄격하게 읽지 않고 덧붙입니다. 그래서 깨진 `ledger.jsonl`에도 씁니다.
- **"현재 목표"**: `status`의 `- current:`, 목표를 지정하지 않은 `validate_gate`, mode-state의 `active_goal_id`는 파일 순서상 첫 `pending`/`active`/`failed` 목표를 고릅니다. 앞쪽 목표를 다시 열면 active 목표와 달라집니다(`currentGoal`).
- **`failed` 단계로 남은 실행**: 활성(`active: true`) 상태로 남습니다. 그런데 `failed`는 종료·해제 단계 집합에도 들어 있어 두 가지가 멈춥니다. 둘 다 루트 README에 적혀 있습니다(`clear`는 알려진 동작, 압축은 "outside `missing`, `failed`, `complete`, and `handoff`" 문장). 결정할 것은 "활성인데 종료 단계"인 이 상태를 그대로 둘지입니다.
  - `force` 없는 `clear`는 거부합니다.
  - 압축 복구 문맥을 넣지 않습니다.
- **`ultragoal handoff`의 검사 누락**: ultragoal이 활성인지, 어느 단계인지 보지 않습니다.
  - 그래서 `clear` 뒤나 두 번째 호출도 성공합니다.
  - 이미 활성인 callee도 되돌립니다. 예: ralplan `architect` → `planner`, 이때 `invalid_transition_detected` 감사 행이 남습니다.
  - `ralplan handoff`는 비활성 ralplan을 거부하므로(R-OD18) 두 방향이 다릅니다. 이 차이를 적은 README 행이 없습니다([entry-and-handoff.md](entry-and-handoff.md)).
- **인계 뒤 SKILL만 막는 호출**: 코드는 둘 다 허용합니다.
  - `ralplan start`
  - 아직 끝나지 않은 `goals.json`이 있을 때의 ultragoal op. 이 op가 ultragoal을 다시 활성으로 만듭니다.

### U41. 오류 처리와 복구

- **주입 실패가 조용함**: continuation이나 보류 안내의 `synthetic` 주입이 실패해도, 셈과 `held`는 이미 저장된 뒤라 다시 시도하지 않습니다.
  - continuation이 실패하면 다음 사용자 프롬프트까지 루프가 멈춥니다.
  - 보류 안내가 실패하면 사용자는 멈춘 이유를 보지 못합니다([goal-loop.md](goal-loop.md)).
- **`skill ultragoal` 게이트는 오류를 로그만 남기고 통과시킵니다**(`console.warn`). 막지도 않고 턴 표식도 두지 않습니다. 저널을 시작한 뒤 저장소 오류가 나면 일부만 쓰이고 `pending` 저널이 남을 수 있습니다(U15와 관련).
- **파이프라인 밖 이름의 깨진 행 파일**: `state/active/other.json` 같은 파일이 깨지면 이후 reconcile이 모두 실패합니다.
  - 원장에는 `reconcile_failed`만 남고, 스냅숏이 옛 값으로 남습니다.
  - 이 파일을 지우는 op가 없고, 가드가 `state/**` 편집을 막습니다([state-and-files.md](state-and-files.md)).
- **doctor**: 깨진 행 파일과 깨진 스냅숏을 `files_scanned`에만 세고 보고하지 않습니다.
- **병합이 옛 필드를 남김**:
  - 한 번 왕복하면 ultragoal state에 `handoff_to: "ralplan"`과 `handoff_from: "ralplan"`이 함께 남습니다.
  - 다시 진입하면 시드가 옛 `status`·`goals`·`counts`를 두므로, `goal-planning` 행의 HUD가 `status=complete`로 보일 수 있습니다.
- **인계 이유**: ralplan 쪽 인계 이유(`ralplan handoff`, 같은 execution의 `skill ultragoal`)는 어디에도 저장되지 않습니다.
- **deep-interview에서 돌아오는 길**: ultragoal SKILL의 "Handoff back to planning"은 돌아올 때 `ralplan handoff(to="ultragoal")`을 쓰라고만 합니다. deep-interview에서 곧장 ultragoal로 돌아오는 단계는 없고, deep-interview SKILL의 Refine → ralplan → `ralplan handoff(to="ultragoal")`을 거쳐야 합니다(U34와 관련).

## 옛 번호 대응표

| # | 항목 | 상태 | 지금 어디 |
|---|---|---|---|
| U1 | ultragoal 활성 행·스냅숏·HUD·doctor·감사 행 | 해결 | [state-and-files.md](state-and-files.md) |
| U2 | GJC 방식 검증 | 해결 | [gates-and-receipts.md](gates-and-receipts.md) |
| U3 | 승인 라벨 정렬 | 해결 | `skills/ultragoal/SKILL.md` |
| U4 | 항상 차단 경로 대소문자 | 열림 | 위 |
| U5 | TUI 진행 표시 | 열림 | 위 |
| U6 | 계획 경로 전달 | 기록 | 위 |
| U7 | ultragoal → ralplan → ultragoal 왕복 | 해결 | [entry-and-handoff.md](entry-and-handoff.md) |
| U8 | `ralplan handoff` 중복 거부 | 기록 | 위 |
| U9 | ultragoal 쪽 스킬 연쇄 가드 | 해결 | [entry-and-handoff.md](entry-and-handoff.md) |
| U10 | 오래된 `pending-approval.md` | 열림 | 위 |
| U11 | 출처 기록과 낡은 문구 | 해결 | SKILL 출처 표, 소스 머리 주석 |
| U12 | handoff 필드 | 해결 | [entry-and-handoff.md](entry-and-handoff.md) |
| U13 | `ralplan start`의 메타 소실 | 기록 | 위 |
| U14 | PLANNING-STUCK 거부 안내 | 열림 | 위 |
| U15 | 인계 실패 경로 | 일부 해결 | 위 |
| U16 | 계약 자동 회귀 검사 | 일부 해결 | 위 |
| U17 | 실제 모델 VERDICT 확인 | 해결(대상 없음) | 수동 실행 결과는 `docs/local-install-v2.md` 6절(2026-10-01 부분 실행 기록) |
| U18 | ultragoal 저장 구성 | 해결 | [state-and-files.md](state-and-files.md) |
| U19 | executor 프롬프트의 계획 경로 | 해결 | `prompts/open-gajae-executor.md` |
| U20 | ultragoal 실행 중 계획 가드 | 해결 | [guards.md](guards.md) |
| U21 | 진입 게이트와 ralplan | 해결 | [entry-and-handoff.md](entry-and-handoff.md) |
| U22 | 실행 중 ralplan write | 기록 | 위 |
| U23 | ultragoal → ralplan 저널 | 해결 | [entry-and-handoff.md](entry-and-handoff.md) |
| U24 | ralplan 런타임의 ultragoal state 쓰기 | 해결 | [entry-and-handoff.md](entry-and-handoff.md) |
| U25 | Stop here 뒤 `handoff_from` 없음 | 기록 | 위 |
| U26 | 안내는 `open-gajae`에만 | 기록 | 위 |
| U27 | continuation이 agent를 확인하지 않음 | 기록 | 위 |
| U28 | 다른 agent에게 도구가 보임 | 해결 | [guards.md](guards.md) |
| U29 | 진입 게이트의 phase 처리 | 해결 | [entry-and-handoff.md](entry-and-handoff.md) |
| U30 | 진입 게이트가 매 턴 state를 읽음 | 해결 | [entry-and-handoff.md](entry-and-handoff.md) |
| U31 | 여러 프로세스 간 직렬화 | 열림(기록만) | 위 |
| U32 | 재시작 안내 문구 | 해결: `start` op 없음, skill을 다시 불러와 `create` | [ops.md](ops.md) |
| U33 | deep-interview로 인계 | 해결 | [entry-and-handoff.md](entry-and-handoff.md) |
| U34 | deep-interview 활성 행 | 열림 | 위 |
| U35 | 마지막 목표의 architect 횟수 | 결정 필요 | 위 |
| U36 | blocker 기록·세대당 lane 1회 | 결정 필요 | 위 |
| U37 | cleaner의 테스트 실행 | 결정 필요 | 위 |
| U38 | ralplan `invalid_transition_detected` | 기록 | 위 |
| U39 | 문구·SKILL·README 불일치 | 결정 필요 | 위 |
| U40 | 검사 순서와 누락 | 결정 필요 | 위 |
| U41 | 오류 처리와 복구 | 결정 필요 | 위 |
