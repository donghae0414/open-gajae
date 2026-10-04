# 수동 점검 기록 (OpenCode v2)

## 5. 수동 테스트 체크리스트

모든 역할을 `openai/gpt-6-luna`(variant로 구분)로 둔 설정으로, 다음을 직접 확인합니다(이식 plan의 매뉴얼 체크리스트):

### 5.1 deep-interview와 ralplan

1. deep-interview 확인은 5.3절입니다(2026-10-02 개정). 여기서는 "Refine with ralplan consensus"를 고른 뒤 `deep-interview handoff(to: "ralplan")`(또는 한 번에 처리하는 `deep-interview spec(…, handoff: "ralplan")`)과 `skill` `ralplan`으로 이어지고, 넘겨받은 ralplan이 `start` 없이 `ralplan write`로 이어 써서 `plans/ralplan/<run-id>/pending-approval.md`가 저장되는지만 확인합니다.
2. 두 skill 모두 키워드로 진입합니다(mention 없이 일반 텍스트로 `deep interview …`, `ralplan …`). 안내가 보이는지 확인합니다. 두 키워드 모두 state를 만들지 않으며, 모델이 `deep-interview start`나 `ralplan start`를 호출한 뒤에야 `state/deep-interview-state.json`이나 `state/ralplan-state.json`이 생기는지 확인합니다.
3. ralplan 루프 도중 Esc로 중단합니다. 이후 continuation이 재개되지 않는지 확인합니다 — background subagent가 그동안 완료되어도 마찬가지입니다. 다음 실제 프롬프트를 보내면 continuation이 다시 동작하는지 확인합니다.
4. planner 위임: GJC 기반 planner 프롬프트에는 위임 지시가 없으므로 위임 여부는 모델이 정합니다(권한은 `open-gajae-explore`/`open-gajae-document-specialist`로 유지). `experimental.subagent_depth: 2`가 설정된 상태에서 planner가 위임하면 호출이 성공하는지, 이 설정 없이 위임을 시도하면 host가 거부하고 planner가 직접 `read`/`grep`/`glob`로 조사해 `ralplan write`로 plan을 기록하는지 확인합니다. 위임하지 않았다면 그 사실만 기록합니다.
5. ralplan 1회 실행: `@ralplan <작업>`을 보냅니다.
   - `.open-gajae/_session-*/plans/ralplan/<ses_…>/`에 `stage-01-planner.md`, `stage-01-intent.md`, architect·critic 단계 파일, `stage-NN-final.md`가 생기고, `index.jsonl`의 각 줄이 JSON으로 읽히며 `stage`, `stage_n`, `path`, `created_at`, `sha256`을 가지는지, `pending-approval.md`가 마지막 `final`과 같은지 확인합니다.
   - planner·architect·critic이 본문을 붙여 넣지 않고 영수증만 돌려주는지 확인합니다.
   - 승인 질문에서 **Stop here**를 고르면 활성 행 `state/active/ralplan.json`이 지워지고 `pending-approval.md`는 남는지 확인합니다.
   - 이어서 "ultragoal로 진행"이라고 요청하면, 모델이 `skill` `ultragoal`을 바로 불러 `goal-planning`으로 진입하는지(Stop here 뒤라 ralplan이 비활성이므로 `ralplan handoff`는 부르면 R-OD18로 거부됨), 그 ultragoal state에 `handoff_from`이 없는지 확인합니다. 이어지는 ultragoal 확인은 5.2절입니다.
6. primary 임시 파일 스테이징: primary가 큰 산출물을 `/tmp` 같은 OS 임시 경로에 host `write`로 먼저 쓰고 `ralplan write`의 `path`로 넘기면, 프로젝트 밖 경로라서 host가 `external_directory` 확인 창을 띄웁니다. 규칙이 맞지 않는 권한은 host 기본값이 `ask`이고(`opencode/packages/core/src/permission.ts:86-95`), 기본 허용은 host 자신의 임시 디렉터리(`$TMPDIR/opencode/*`, `opencode/packages/core/src/agent.ts:62`) 등뿐이기 때문입니다. 확인 창이 뜨는지, 허용 후 `ralplan write`가 성공하는지 확인합니다. 역할(planner·architect·critic)은 `content`만 쓰므로 이 창이 뜨지 않아야 합니다.

### 5.2 ultragoal과 goal (2026-09-30 개정)

작은 연습용 저장소에서 한 세션으로 진행합니다. 파일 경로는 모두 그 세션 계보의 루트 세션 폴더 `.open-gajae/_session-<created>-<id>/` 기준입니다. 결과 문구는 `docs/skills/ultragoal/ops.md`의 op 설명과 같아야 합니다.

1. **설정 로드.** 사용자나 프로젝트의 `open-gajae.jsonc`에 `"ultragoal": {}`를 잠깐 넣고 OpenCode를 재시작해 첫 프롬프트를 보냅니다. 설정 로드가 `<파일>.ultragoal: unknown setting`으로 실패하는지 확인합니다(`GET /api/plugin` 응답이나 호스트 로그). key를 지우고 재시작하면 정상 로드되는지 확인합니다.
2. **`build` agent의 도구 숨김.** `build` agent로 새 세션을 열고 `ultragoal`, `goal`, `ralplan` 도구로 상태를 보라고 요청합니다. 모델이 그 도구를 찾지 못하거나, 호출이 호스트에서 `Tool is not available for this request: <도구>`로 거부되는지 확인합니다. 같은 요청을 `open-gajae` 세션에서 하면 세 도구가 동작하는지 확인합니다.
3. **진입과 goal-planning 가드.** `open-gajae` 세션에서 "ultragoal로 <작업>"을 보냅니다. TUI에 `open-gajae: ultragoal keyword notice added`가 보이고, 모델이 `skill` `ultragoal`을 부르기 전에는 `state/ultragoal-state.json`이 없는지 확인합니다. 로드 뒤 `state/active/ultragoal.json`의 phase가 `goal-planning`인지 확인합니다. 이 상태에서 제품 파일 수정을 요청하면 `write`/`edit`/`patch`가 `Ultragoal goal-planning phase boundary: …`로 거부되는지 확인합니다.
4. **`create`, goal 켜기, continuation.** 모델이 `ultragoal create`를 부르면 결과가 `Created ultragoal plan with N goal(s) at <path>.`와 `Goal armed: Complete the durable ultragoal plan in .open-gajae/_session-…/ultragoal/goals.json, …`인지 확인합니다. `goal get`이 같은 objective와 `Status: active`를 돌려주는지, `ultragoal/goals.json`이 `"version": 2`이고 기준 ID가 `G001.AC1` 꼴인지, `ultragoal/ledger.jsonl`에 `plan_created`, `ultragoal/progress.txt`에 `PLAN` 메모가 있는지 확인합니다. 이제 제품 파일 수정이 허용되는지, 턴이 끝나면 TUI에 `open-gajae: goal continuation`이 보이고 작업이 이어지는지 확인합니다.
5. **목표별 architect gate → checkpoint.** `ultragoal next` 결과에 `checkpoint requires=targetedVerification:passed,architectReview:CLEAR+APPROVE,criteriaCoverage:all`과 `criteria=`가 있는지 확인합니다. 모델이 `open-gajae-architect`에 목표 리뷰를 맡기는지 확인합니다. 한 번은 기준 줄이 빠진 gate로 `validate_gate`나 `checkpoint(complete)`를 부르게 해서 `N quality-gate error(s):`와 결함마다 `  path [code]: message` 줄이 나오는지 확인합니다. 올바른 gate로 `Checkpointed G001 as complete.` 다음에 `Next ultragoal goal: G002 — …`와 `Criteria: …`가 나오고 G002가 바로 `active`가 되는지, `progress.txt`에 G001 항목이 붙는지 확인합니다.
6. **재오픈.** 완료한 목표를 `revise`하라고 요청하면 `requires goal G001 status pending; found complete. To change it, reopen it first with ultragoal checkpoint(…status: "pending"…)` 꼴로 거부되는지 확인합니다. `checkpoint(status: "pending")`이 `Reopened G001; revise it, then run ultragoal next and checkpoint it again.`을 돌려주고, 기준을 고치면 새 ID(`G001.AC2` 같은)가 생기고 옛 ID는 `status`에서 사라지는지, `next`와 새 gate로 다시 완료되는지 확인합니다.
7. **경계 cohort → terminal critic → final checkpoint → `goal complete`.** 마지막 필수 목표의 `next`에 `,reviewCohort:joined,criticReview:OKAY`가 붙는지 확인합니다. 모델이 한 변경 집합에 대해 `open-gajae-cleaner`(`AI SLOP CLEANUP REPORT`, `Gate Result: PASS`), `open-gajae-architect`, 지시문에 `[ultragoal-red-team]`이 있는 `open-gajae-executor`를 부르는지, 그 executor 자식 세션의 첫 메시지 끝에 `<ultragoal_red_team_mode>` 조각이 붙는지 확인합니다. terminal `open-gajae-critic`의 `OKAY` 뒤 final checkpoint가 `All ultragoal goals are complete.`를 돌려주고, `ultragoal status`가 `run_complete: yes`인지 확인합니다. final checkpoint 뒤 `state/active/ultragoal.json`이 지워지는지, 모델이 `goal complete`를 부르면 `Status: complete`가 되고 그 뒤 continuation이 멈추는지 확인합니다.
8. **`ultragoal handoff(to: "ralplan")`와 복귀.** 새 실행 도중에 계획을 다시 짜라고 요청합니다. 모델이 먼저 `skill` `ralplan`을 부르면 `open-gajae: refusing to chain from "ultragoal" … into "ralplan"`으로 거부되는지 확인합니다. `ultragoal handoff(to: "ralplan", reason)` 결과가 한 줄 JSON 영수증인지, `state/ultragoal-state.json`이 `active: false`, `current_phase: "handoff"`, `handoff_to: "ralplan"`이고 `state/active/ultragoal.json`이 비활성 `handoff_to` 행으로 남는지, `state/ralplan-state.json`이 옛 `run_id`로 `planner`에 활성이고 `handoff_from: "ultragoal"`인지, ledger에 `workflow_handoff`, `progress.txt`에 `HANDOFF` 메모가 있는지, `state/transactions/`에 남은 저널이 없는지(저널은 인계가 끝나면 지워짐), `goal get`이 여전히 `active`인지 확인합니다. 모델이 `ralplan start` 없이 `ralplan write`로 이어 써서 `final`까지 가는지 확인하고, 옛 run의 `stage_n`과 겹치는지, 예산이 이어지는지 관찰해 기록합니다(`docs/skills/ultragoal/known-limits.md`의 기록된 동작). 승인 뒤 `ralplan handoff(to="ultragoal")`(또는 같은 execution의 `skill ultragoal`)로 ultragoal이 `goal-planning`으로 돌아오고, `create`가 `goals.json`을 새로 쓰며 ledger와 `progress.txt`는 기록을 유지하는지 확인합니다.
9. **도구 없는 턴 3회 보류와 해제.** 실행 중에 모델이 도구 없이 답하는 continuation 턴이 연속 3번 나오도록 유도합니다(예: 도구를 쓰지 말고 요약만 하라고 지시). TUI에 `open-gajae: goal continuation held (no_tool_progress)`가 한 번 보이고, 그 `<goal-notice>`에 `[GOAL CONTINUATION HELD - NO TOOL PROGRESS]`, `Cause: …`, `Send a message to continue: …`가 있는지, 그 뒤 continuation이 없는지, `state/goal-continuation.json`에 `held`가 있는지 확인합니다. 메시지를 보내면 `held`가 사라지고 `tool_less_turns`가 0이 되며, 그 턴이 끝난 뒤 continuation이 다시 들어오는지 확인합니다.
10. **Esc.** 실행 중 Esc로 중단하면 continuation이 없는지, 다음 프롬프트를 보내면 그 턴이 끝난 뒤 continuation이 다시 들어오는지 확인합니다.
11. **압축.** 실행 중 `/compact`를 합니다. 압축 요약에 `[ULTRAGOAL RUN ACTIVE]` 문맥(현재 목표, 다음 행동)이 반영되는지, 다음 요청에 TUI `open-gajae: goal context added`와 함께 goal 문맥이 다시 들어가는지 확인합니다. 9번의 보류 중에 `/compact`를 하면 보류 안내가 전달되고 호스트가 모델을 한두 단계 돌려도 보류는 유지되는지 관찰해 기록합니다(`docs/skills/ultragoal/known-limits.md`의 기록된 동작).
12. **다른 agent로 바꿨을 때(수용 동작).** 실행 중 세션 agent를 `build`로 바꾸고 goal continuation이 계속 들어오는지 관찰합니다. Esc, 또는 `open-gajae`로 돌아가 `goal drop`으로 끝냅니다(`docs/skills/ultragoal/known-limits.md` U27).
13. **수정 목표(가능하면).** cohort에 blocker가 있을 때 `record_review_blockers`가 `Recorded review blockers. blocker-goal-id=<id>`를 돌려주고, 원 목표가 `review_blocked`, 수정 목표의 기준이 `<objective> is resolved and re-verified` 하나인지, 수정 목표가 첫 checkpoint부터 final gate를 요구받고, 그 `next`의 `criteria=`에 원 목표의 기준이 함께 나오며(ultragoal 편차 44), 완료되면 원 목표가 `superseded`가 되어 실행이 완료되는지 확인합니다. 수정의 수정 사슬이 생기면 모델이 사슬 앞 목표를 손으로 supersede하지 않아도 마지막 수정 목표의 완료로 사슬 전체가 `superseded`가 되는지 확인합니다(편차 43).
14. **정리.** `ultragoal doctor`가 텍스트 결과를 내는지, `ultragoal clear`가 한 줄 JSON 영수증과, goal이 열려 있으면 `The goal is still <status>; run goal drop to end it.`를 돌려주는지, `goal drop` 뒤 `goal get`이 `No active goal.`인지 확인합니다.
15. 결과(통과·실패·관찰)를 날짜와 함께 아래 6절에 기록합니다.

### 5.3 deep-interview (2026-10-02 개정)

작은 연습용 저장소에서 `open-gajae` 세션 하나로 진행합니다. 파일 경로는 5.2절처럼 루트 세션 폴더 `.open-gajae/_session-<created>-<id>/` 기준이고, 결과 문구는 `docs/skills/deep-interview/ops.md`의 op 설명과 같아야 합니다.

1. **설정 로드.** 사용자 설정의 `deepInterview`에 `ambiguityThreshold: 0.05`만 있을 때 정상 로드되는지 확인합니다. 없앤 라운드 상한 key를 잠깐 넣으면 `unknown setting`으로 로드가 실패하는지 확인하고, key를 지웁니다.
2. **진입.** `@deep-interview <작은 아이디어>`를 보냅니다. magic 안내가 하나 보이고, 이 시점에는 `state/deep-interview-state.json`이 없는지 확인합니다.
3. **Phase 0과 `start`.** 응답 첫 줄이 `Deep Interview threshold: 5% (source: ~/.open-gajae/open-gajae.jsonc)`인지, 적합성 게이트를 지나는지 확인합니다. 모델이 `deep-interview start`를 부르면 `state/deep-interview-state.json`이 `"version": 2` 봉투이고, `state/active/deep-interview.json`의 phase가 `interviewing`이며, `threshold_source`가 첫 줄의 출처와 같은지 확인합니다.
4. **라운드 기록.** Round 0 뒤 `deep-interview write`에 `round-0`, `answered`, `topology`가 들어가는지 확인합니다. 그 뒤 라운드마다 `question` 한 문항과 `deep-interview write` 한 번이 이어지는지 보고, 결과의 `current_ambiguity`와 `ambiguity_floor`를 기록합니다. 형식이 틀린 `write`가 거절되면 그 문구와 모델의 재시도를 기록합니다.
5. **리뷰 패널.** 구간이 바뀔 때 한 메시지에서 `subagent(open-gajae-lateral-reviewer)`가 3개 이상 병렬로 도는지, 프로젝트 밖 파일 읽기 권한 질문 없이 각 호출에 persona와 인터뷰 맥락만 들어가는지 확인합니다(조각은 역할 프롬프트). 페르소나 응답이 JSON인지, 그 결과가 다음 질문에 녹는지, state의 `lateral_reviews`에 기록되는지, 패널 역할에 `edit`과 workflow 도구가 없는지 확인합니다.
6. **이어가기와 편집 가드.** 라운드 사이에 "계속할까요?" 같은 확인 질문이 없는지 확인합니다. 제품 파일 수정을 요청하면 `write`가 `Deep-interview phase boundary: …`로 거부되는지 확인합니다.
7. **spec.** 모호도가 기준치 이하가 되고 closure와 restate 게이트를 지난 뒤에만 `deep-interview spec`을 부르는지(모든 점수가 0.9여도 모호도 10%면 계속 묻는지) 확인합니다. `deep-interview spec`이 `specs/deep-interview-<slug>.md`와 `specs/deep-interview-index.jsonl`을 쓰고, phase가 `handoff`가 되며, 활성 행의 HUD에 `spec` 칩이 붙는지 확인합니다.
8. **Phase 5.** 선택지가 넷(ralplan으로 다듬기, ultragoal로 실행, 더 다듬기, 여기서 마치기)인지 확인합니다. "여기서 마치기"를 고르면 `deep-interview clear`로 `state/active/deep-interview.json`이 지워지고 spec 파일은 남는지 확인합니다. ralplan으로 이어지는 경로는 5.1절 1번입니다.
9. **취소와 재개.** 인터뷰 도중 "그만"이라고 보냅니다. 모델이 `deep-interview state(patch={"active": false})`를 부르고 멈추는지, 그 뒤 `open-gajae: deep-interview continuation`이 들어오지 않는지, `state/deep-interview-state.json`이 `active: false`, phase `interviewing`이고 라운드가 남아 있는지 확인합니다. `skill deep-interview`를 다시 부르면 기준치 첫 줄보다 먼저 재개·새로·지우기를 묻고, 재개를 고르면 `deep-interview state(patch={"active": true})` 뒤 다음 라운드로 이어 가는지 확인합니다. 스펙을 쓴 뒤(Phase 5)에 "그만"이라고 하면 `deep-interview clear`로 끝나고 스펙 파일이 남는지 확인합니다.
10. 날짜, 호스트, 커밋, 모델과 variant, 세션 id와 함께 결과를 아래 7절에 기록합니다.

이 체크리스트는 실제 LLM 동작을 사람이 보고 판단하는 것으로, `bun test`/`bun run typecheck`나 host probe(`tests/host-probe.ts`, `tests/host-session-probe.ts`, `tests/planner-permission-probe.ts`, `tests/package-probe.ts`, `tests/ralplan-trail-probe.ts`)가 자동으로 대신하지 않습니다. 두 검증은 서로 다른 층을 다루며, [개발 문서](development.md)의 "검증 근거와 한계"를 참고하세요.

## 6. 수동 실행 결과 (Manual run result, AC37)

ultragoal gjc 개정의 실제 호스트 실행 기록입니다(spec AC37). 이 절의 결과는 자동 테스트나 호스트 probe가 대신하지 않습니다.

**부분 실행으로 기록합니다(2026-10-01, 관리자 결정).** 실행 조건이 5.2절의 전제와 두 가지 다릅니다.
- **모델**: 5.2절은 모든 역할을 `openai/gpt-6-luna`로 두고 variant로 구분합니다. 두 실행은 `-fast` 모델이었고, 기록된 variant는 모든 역할이 `default`였습니다. 설정에는 primary가 `high`였는데, 이것이 왜 적용되지 않았는지는 확인하지 못했습니다.
- **방식**: 체크리스트를 항목별로 따라가지 않았습니다. 앱 작업 요청 한 번을 ralplan → ultragoal로 끝까지 돌렸습니다.

아래 표에서 "미확인"인 항목은 실제 모델로 아직 확인하지 않은 것입니다.

| 구분 | 1차 | 2차 |
|---|---|---|
| 실행 시각 | 2026-09-30 20:24–20:51 (KST) | 2026-09-30 23:49 – 10-01 00:36 (KST) |
| 호스트 | OpenCode v2.0.15 | OpenCode v2.0.15 |
| 플러그인 | 브랜치 `feat/ultragoal-gjc-revision`, 커밋 `9b5d4f9` | 같음 |
| 모델 | 모든 역할 `openai/gpt-6-luna-fast` (variant `default`) | 모든 역할 `openai/gpt-6-sol-fast` (variant `default`) |
| 요청 | `@ralplan --interactive`: 단일 HTML 앱을 Next.js·React·TypeScript로 옮기고 상세 페이지 분리 | `@ralplan`: 교실 스타일을 우주정거장·우주선 스타일로 바꾸고 인터랙션 강화 |
| 세션 | `ses_f0df11fc9ffeWwrUZVfzxHw4FA` (자식 8) | `ses_f0d35376effec0XrVLC70z6Bfr` (자식 7) |
| 목표 | G001 하나 | G001 → 수정 목표 G002 → 수정 목표 G003 |

| 5.2 항목 | 결과 | 메모 |
|---|---|---|
| 1. 설정 로드 | 미확인 | |
| 2. `build` agent의 도구 숨김 | 미확인 | 호스트 probe(`tests/host-probe.ts`)는 `build`·`general`에서 숨김을 확인합니다. |
| 3. 진입과 goal-planning 가드 | 일부 통과 | 두 실행 모두 ralplan 승인 뒤 `ralplan handoff`에서 `skill ultragoal`로 이어져 `goal-planning`으로 들어갔습니다. 인계 저널은 생겼다가 지워졌습니다. 키워드 안내와 편집 거부는 이 흐름에 없어 미확인입니다. |
| 4. `create`, goal 켜기, continuation | 통과 (continuation 제외) | `Created ultragoal plan with 1 goal at …`, `Goal armed: …`, `goal get`의 `Status: active`, `goals.json`의 `"version": 2`와 `G001.AC1` 꼴 기준, ledger `plan_created`, progress `PLAN`, `open-gajae: goal context added`를 확인했습니다. 두 실행 모두 첫 execution 하나로 `goal complete`까지 가서 continuation이 들어갈 일이 없었습니다(`goal-continuation.json` 없음). |
| 5. 목표별 architect gate → checkpoint | 일부 통과 | `next`가 `checkpoint requires=`와 `criteria=`를 출력했습니다. 목표마다 마지막 목표여서 목표별 checkpoint, gate 오류 문구, 다음 목표 전환은 미확인입니다. |
| 6. 재오픈 | 미확인 | |
| 7. 경계 cohort → terminal critic → final checkpoint → `goal complete` | 통과 | 아래를 모두 확인했습니다. 1차 모델의 절차 위반은 이 표 아래 관찰에 적었습니다. |
| 8. `ultragoal handoff(to: "ralplan")`와 복귀 | 미확인 | 반대 방향(ralplan → ultragoal) 인계는 두 실행 모두 정상이었습니다. |
| 9. 도구 없는 턴 3회 보류와 해제 | 미확인 | |
| 10. Esc | 미확인 | |
| 11. 압축 | 미확인 | |
| 12. 다른 agent로 바꿨을 때 | 미확인 | |
| 13. 수정 목표 | 통과 (2차) | 아래를 모두 확인했습니다. 1차는 blocker가 있었지만 모델이 이 op를 부르지 않았습니다. |
| 14. 정리 | 미확인 | |

7번에서 확인한 것:
- `next`의 `checkpoint requires=`에 `,reviewCohort:joined,criticReview:OKAY`가 붙었습니다.
- cleaner(`AI SLOP CLEANUP REPORT`, `Gate Result: PASS`), architect, `[ultragoal-red-team]` executor가 돌았습니다.
- red-team 조각은 executor 메시지에만 붙었습니다.
- terminal critic `OKAY` → `validate_gate`의 `quality gate is valid.` → `All ultragoal goals are complete.` 순서였습니다.
- `run_complete: yes`, 영수증은 `receiptKind: final-aggregate`입니다.
- `state/active/ultragoal.json`이 지워졌습니다.
- `goal complete` 뒤 `Status: complete`이고, 그 뒤 continuation이 없었습니다.

13번에서 확인한 것(2차):
- 1세대 cohort 불통과 → `Recorded review blockers. blocker-goal-id=G002`
- G001이 `review_blocked`, G002 기준은 `… is resolved and re-verified` 하나입니다.
- G002의 첫 `next`부터 최종 gate를 요구했습니다.
- 2세대 불통과 → G003 → 뿌리 G001 `supersede`
- G003 완료 → G002 `superseded`(증거 `Resolved by verification blocker goal G003: …`), `run_complete: yes`

관찰(자세한 내용은 [`docs/skills/ultragoal/known-limits.md`](skills/ultragoal/known-limits.md)):
- **1차 모델의 절차 위반**: cohort blocker를 `record_review_blockers` 없이 바로 고쳤고, 같은 세대에서 lane을 다시 돌렸고(U36), 요청 없이 `git commit`을 했습니다. 2차 모델은 SKILL 절차를 그대로 따랐습니다.
- **lane 충돌**: 1차에서 cleaner와 QA lane이 동시에 e2e를 돌려 Playwright 산출물이 충돌했고, 이것이 가짜 blocker가 됐습니다(U37).
- **감사 로그**: 두 실행 모두 ralplan 감사 로그에 `invalid_transition_detected`가 4~5행 남았습니다. gjc 전이 표와 SKILL 흐름이 원래 어긋나서 생기는 것이고, 기록만 남습니다(U38).
- **서브에이전트 사용**: ralplan에서 `open-gajae-explore`는 쓰이지 않았고, ultragoal 구현은 leader가 직접 했습니다. SKILL 기본값("Direct inline implementation by the leader is the default")과 작은 앱 규모에 맞는 결과입니다.

## 7. deep-interview 수동 실행 결과 (Manual run result, AC34)

deep-interview gjc 개정(브랜치 `feat/deep-interview-gjc-revision`)의 실제 호스트 실행 기록입니다. 이 절의 결과는 자동 테스트나 호스트 probe가 대신하지 않습니다. main 병합은 이 실행 뒤에 관리자가 정합니다.

| 5.3 항목 | 결과 | 메모 |
|---|---|---|
| 1. 설정 로드 | 부분 (플러그인 설정 로더만) | 2026-10-02, 구현 중 확인. 로컬 `~/.open-gajae/open-gajae.jsonc`는 `ambiguityThreshold: 0.05`, 출처 `~/.open-gajae/open-gajae.jsonc`로 로드됩니다. 없앤 라운드 상한 key를 넣은 임시 파일은 `unknown setting`으로 실패했습니다. 호스트를 재시작한 확인은 아직 하지 않았습니다. |
| 2. 진입 | 미확인 | |
| 3. Phase 0과 `start` | 미확인 | |
| 4. 라운드 기록 | 미확인 | |
| 5. 리뷰 패널 | 미확인 | |
| 6. 이어가기와 편집 가드 | 미확인 | |
| 7. spec | 미확인 | |
| 8. Phase 5 | 미확인 | |
| 9. 취소와 재개 | 미확인 | |
