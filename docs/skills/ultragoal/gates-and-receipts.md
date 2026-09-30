# 검증 gate와 완료 영수증

이 문서는 ultragoal 목표가 `complete`가 될 때 코드가 무엇을 검사하고 무엇을 남기는지 적습니다. 다루는 것은 목표별 gate와 최종 gate, "최종 목표"를 정하는 규칙, gate 검증 규칙과 결함 코드, 완료 영수증(`completionVerification`), 실행 완료 판정, 재오픈, 수정 목표(fix goal), critic 판정의 연속 횟수입니다. 다른 주제는 아래 문서에 있습니다.

- 개요, 전체 흐름, 코드 지도: [README.md](README.md)
- 각 op의 입력, 거부, 쓰기, 결과 문자열: [ops.md](ops.md). 이 문서는 op의 검증 의미만 다룹니다.
- `goal` 도구, continuation 루프, 보류(hold): [goal-loop.md](goal-loop.md). critic 연속 횟수가 5에 닿았을 때의 보류 동작은 그 문서에 있고, 횟수를 세는 규칙은 이 문서에 있습니다.
- 파일 스키마, 쓰기 순서, 행, reconcile, HUD, doctor: [state-and-files.md](state-and-files.md)
- 가드, 도구 숨김, 권한, red-team 조각: [guards.md](guards.md)
- 진입과 인계: [entry-and-handoff.md](entry-and-handoff.md)
- 알려진 한계: [known-limits.md](known-limits.md)

용어는 이렇게 씁니다.

| 용어 | 뜻 |
|---|---|
| gate (검증 제출서) | `checkpoint(status: "complete")`와 `validate_gate`의 `gate` 인자로 넘기는 JSON 객체입니다. 검증과 리뷰 결과를 적습니다. 필드 이름은 camelCase입니다. |
| 목표별 gate (per-goal gate) | `targetedVerification`, `architectReview`, `criteriaCoverage` 세 섹션입니다. |
| 최종 gate (final gate) | 목표별 gate에 `reviewCohort`, `criticReview`를 더한 것입니다. |
| 필수 목표 (required goal) | status가 `superseded`가 아닌 목표입니다 (`src/ultragoal-runtime/plan.ts` `requiredGoals`). |
| 최종 목표 | 완료되는 순간 다른 필수 목표가 모두 `complete`인 목표입니다. 1장에서 정확한 규칙을 봅니다. |
| 영수증 (receipt) | complete checkpoint가 목표에 붙이는 `completionVerification` 객체입니다. 종류는 `per-goal`과 `final-aggregate`입니다. |
| 원장 (ledger) | `ultragoal/ledger.jsonl`. 한 줄에 한 이벤트 행입니다. |
| 고정 행 (anchor row) | 영수증의 `checkpointLedgerEventId`가 가리키는 원장의 `goal_checkpointed` 행입니다. |
| 실행 완료 (run completion) | 파일 상태만이 아니라 영수증까지 따져 run 전체가 끝났는지 보는 판정입니다 (`runCompletion`). |

## 1. 검증 구조

| 구분 | 누가 받나 | gate 섹션 | 영수증 종류 |
|---|---|---|---|
| 목표별 gate | 최종 목표가 아닌 모든 목표 | `targetedVerification`, `architectReview`, `criteriaCoverage` | `per-goal` |
| 최종 gate | 최종 목표 | 위 세 섹션 + `reviewCohort` + `criticReview` | `final-aggregate` |

SKILL의 "Boundary verification (per goal, then once at the end)"은 이것을 "모든 목표가 architect 리뷰를 받고, 무거운 cohort 리뷰는 run의 마지막 필수 목표에서 한 번 돈다"고 설명합니다. 따로 선언할 것은 없습니다. 목표가 하나뿐인 plan에서는 그 목표가 처음부터 최종 목표입니다.

### 1.1 최종 목표 판정: `completionView`

`src/ultragoal-runtime/plan.ts` `completionView(file, goalId, resolution?)`가 판정합니다. 순서는 다음과 같습니다.

1. `goals.json` 내용을 복사합니다 (`structuredClone`). 원본은 바꾸지 않습니다. 대상 목표가 없으면 `No ultragoal goal found for <id>.`를 던집니다.
2. 대상이 수정 목표(`steering.kind === "review_blocker"`)이면 `steering.blockedGoalId`가 가리키는 부모를 찾습니다. 부모 status가 **`review_blocked`일 때만** 복사본에서 부모를 `superseded`로 바꾸고 `supersededParentId`에 기록합니다. `resolution`이 주어지면 부모의 `evidence`를 `Resolved by verification blocker goal <대상 id>: <resolution.evidence>`로 바꿉니다.
   - 부모가 `blocked`, `complete`, `superseded` 등 다른 status면 손대지 않습니다.
   - 한 단계만 봅니다. 부모의 부모는 보지 않습니다 (PQ-23 A).
3. 복사본의 필수 목표 가운데 대상이 아니고 status가 `complete`가 아닌 목표를 모읍니다 (`unfinished`).
4. `unfinished`가 비면 `receiptKind`는 `final-aggregate`, 아니면 `per-goal`입니다.

따라 나오는 성질:

- 대상 목표 자신의 status는 판정에 쓰지 않습니다.
- 다른 목표가 `pending`, `active`, `failed`, `blocked`, `review_blocked` 중 하나라도 있으면 대상은 최종 목표가 아닙니다. 예외는 2단계의 경우입니다: 대상이 수정 목표이면 그 직접 부모인 `review_blocked` 목표는 view에서 superseded로 바뀌므로 끝나지 않은 목표로 세지 않습니다 (8.2의 3단계).
- 이미 끝난 앞 목표를 재오픈하면, 나머지가 모두 `complete`이므로 그 목표가 최종 목표가 됩니다. 예: G001(per-goal), G002(final)로 끝난 run에서 G001을 재오픈하면 `next`는 G001에 최종 gate를 요구합니다.
- 같은 부모에 열린 수정 목표가 둘 이상이면, 먼저 완료되는 수정 목표가 부모를 `superseded`로 바꿉니다. 나머지 수정 목표는 필수 목표로 남습니다.

코드 머리말은 gjc `ultragoal-runtime.ts`의 `chooseReceiptKind`(per-story, batch, fresh-final 분기 제외)와 `:3738-3748`(수정 목표 완료가 부모를 supersede)을 출처로 적고, 편차 29를 답니다. 루트 README의 편차 29 기록에 따르면 gjc는 부모를 supersede하기 전의 plan으로 gate를 검사하고 영수증 종류는 그 뒤에 다시 고릅니다. open-gajae는 두 가지 모두 부모가 이미 superseded인 복사본으로 정합니다. 그래서 run을 닫는 수정 목표는 첫 checkpoint부터 최종 gate를 내야 합니다.

### 1.2 `next`의 `checkpoint requires=`

`next`(`src/ultragoal-runtime/store.ts` `nextTx`)는 실행할 목표를 정한 뒤 `completionView(plan, goal.id).receiptKind`로 어느 gate가 필요한지 출력합니다 (`src/ultragoal-runtime/messages.ts` `renderNext`). 문자열은 두 가지입니다.

```
checkpoint requires=targetedVerification:passed,architectReview:CLEAR+APPROVE,criteriaCoverage:all
checkpoint requires=targetedVerification:passed,architectReview:CLEAR+APPROVE,criteriaCoverage:all,reviewCohort:joined,criticReview:OKAY
```

첫 줄은 목표별 gate(`PER_GOAL_REQUIRES`), 둘째 줄은 최종 gate(`FINAL_REQUIRES`)입니다. 바로 다음 줄 `criteria=`는 그 목표의 활성 기준 ID를 쉼표로 이어 적습니다 (예: `criteria=G001.AC1`). 이 두 줄은 next-action이 `execute-goal`일 때만 나옵니다.

값은 `next`를 부른 그 순간의 plan으로 계산합니다. 그 뒤에 다른 목표를 `supersede`하거나 `add`하면 답이 바뀝니다. `next`는 이미 `active`인 목표를 쓰기 없이 그대로 돌려주면서 이 값을 다시 계산하므로, plan을 바꾼 뒤에는 `next`를 다시 불러 확인할 수 있습니다.

### 1.3 `checkpoint`와 `validate_gate`는 같은 선택을 씁니다

- `checkpoint(status: "complete")`(`checkpointTx`)는 `completionView(file, goal.id, { evidence })`를 만들고, 그 `receiptKind`와 대상의 활성 기준 ID로 `validateGate`를 부릅니다. 통과하면 같은 `receiptKind`로 영수증을 만들고, 복사본(`view.file`, 부모가 superseded된 plan)을 새 `goals.json`으로 씁니다.
- `validate_gate`(`validateGateTx`)는 `completionView(file, goal.id)`를 `resolution` 없이 부릅니다. `resolution`은 부모 evidence 문구만 바꾸므로 gate 종류는 같습니다.

`validate_gate`의 대상 목표:

| 입력 | 대상 | 검사 |
|---|---|---|
| `goal_id` 있음, 찾음 | 그 목표 (앞뒤 공백 제거) | 그 목표의 completion view로 종류와 활성 기준 결정 |
| `goal_id` 있음, 없음 (plan이 없을 때 포함) | 없음 | 머리 줄 `1 quality-gate error(s):`와 결함 줄 `  goalId [unknown_goal]: Unknown ultragoal goal <id>`, 두 줄을 돌려줌 |
| `goal_id` 없음, plan 있음 | `currentGoal(file)`: `goals.json` 순서에서 처음 나오는 `pending`/`active`/`failed` 목표 | 그 목표의 completion view |
| `goal_id` 없음, plan 없음 또는 해당 목표 없음 | 없음 | 목표별 gate로 모양만 검사, 활성 기준 없이 |

`validate_gate`는 목표 status, 진행 목록(`implementation`, `files_changed`, `learnings`)을 보지 않고 아무것도 쓰지 않으며 reconcile도 하지 않습니다. 결과는 `Error:` 접두어 없이 돌아옵니다. `gate`가 없으면 `Error: gate is required for ultragoal validate_gate`입니다.

`goal_id` 없이 부르면 `currentGoal`은 파일 순서의 첫 `pending`/`active`/`failed` 목표를 고릅니다. `next`와 checkpoint가 다루는 `active` 목표와 다를 수 있습니다. 예를 들어 앞 목표를 재오픈해 `pending`으로 둔 채 뒤 목표가 `active`면, `validate_gate`는 앞 목표를 검사합니다. 목표를 확실히 하려면 `goal_id`를 넘깁니다.

### 1.4 코드가 강제하는 것과 SKILL만 요구하는 것

| 코드가 강제함 | SKILL 문구로만 요구함 (코드가 확인하지 않음) |
|---|---|
| gate JSON의 모양과 값 (2장) | `targetedVerification.commands`, QA lane `commands`를 실제로 실행했는지 |
| 목표별/최종 gate 선택 (1.1) | `open-gajae-architect`, `open-gajae-cleaner`, `[ultragoal-red-team]` 표시가 붙은 `open-gajae-executor` QA lane, `open-gajae-critic`을 실제로 불렀는지. evidence 문자열 내용은 검사하지 않습니다. |
| `criteriaCoverage`가 활성 기준과 정확히 한 행씩 맞는지 | 변경 집합을 고정(freeze)했는지, 세대 안에서 lane을 한 번씩만 돌렸는지. 코드는 lane 자리에 배열이 오면 거부할 뿐입니다. |
| `checkpoint(complete)`는 `active`/`failed` 목표만, 진행 목록 세 개 필수 (ops.md) | lane을 병렬로 돌릴지 순차로 돌릴지, 수리 전에 결과를 합칠지(join before repair). 코드는 `joined: true` 값만 봅니다. |
| 영수증 기록과 유효성, 실행 완료 판정 (3, 4장) | 세대를 checkpoint마다 올렸는지. 코드는 이전 세대를 기억하지 않으므로 1 이상 정수면 받습니다. 수정 목표의 첫 checkpoint에 `reviewGeneration: 1`을 내도 통과합니다. |
| 실행 완료 전 `goal complete` 거부 (4.3) | `deltaPaths`가 실제로 바뀐 경로인지, `scopeExpansion`을 무관한 범위에만 쓰는지 |
| `record_critic_verdict`의 pause 결속, `goal pause` 가드 (7.1, goal-loop.md) | cohort가 clean하지 않을 때 `record_review_blockers`로 한 묶음 기록, 목표별 리뷰가 clean하지 않을 때 `checkpoint(failed)` 후 `next(retry_failed: true)` |
| critic 연속 횟수 계산과 결과 문구 (7.2, 7.3) | completion 쪽 `ITERATE`/`REJECT`를 먼저 `record_critic_verdict`로 기록하기, critic을 terminus마다 한 번 돌리기. gate의 `criticReview`는 원장의 어떤 `critic_verdict` 행과도 연결되지 않습니다. |
| | checkpoint 전에 `validate_gate`로 미리 검사하기 |

### 1.5 최종 목표의 architect 리뷰는 한 번인가 두 번인가

SKILL의 목표별 gate 2단계는 architect 리뷰를 "see step 4 of the cohort gate"로 안내하고, cohort gate 4단계는 architecture/product/code 세 측면을 덮는 `open-gajae-architect` 리뷰를 위임하라고 합니다. SKILL은 최종 목표가 cohort의 architect lane과 **별도로** 목표별 architect 리뷰를 한 번 더 받아야 하는지 말하지 않습니다.

코드는 두 자리를 따로 검사하고 서로 비교하지 않습니다. `checkArchitectReview`는 `architectReview`의 세 status, `recommendation`, `evidence`, `blockers`를 보고, `checkReviewCohort`는 `reviewCohort.lanes.architect`의 `status: "CLEAR"`, `evidence`, `blockers`를 봅니다. evidence가 같은지, 서로 다른 실행에서 왔는지는 보지 않습니다. 따라서 architect 결과 하나를 두 자리에 옮겨 적은 gate도 통과합니다. 두 자리의 모양은 다르므로(`architectReview`는 세 status와 `APPROVE`, lane은 `status` 하나) 옮겨 적을 때 각 모양을 맞춰야 합니다.

## 2. gate 검증: `validateGate`

`src/ultragoal-runtime/gate.ts` `validateGate(gate, { receiptKind, activeCriterionIds? })`는 순수 함수이고, 결함을 `{path, code, message}` 목록으로 한 번에 모아 돌려줍니다. 빈 목록이면 통과입니다.

코드 머리말은 gjc `ultragoal-runtime.ts`의 `validateCompletionQualityGate`, `validateReviewCohort`, `requireNonEmptyString`, `requireEmptyBlockers`, `requireSuccessStatus` 등을 출처로 적고, 편차 14, 15, 16, 28, 41을 답니다. DR-18: gjc는 빠진 섹션을 찾으면 멈추지만, 여기서는 남은 섹션도 계속 검사해 결함을 한 목록에 모읍니다.

### 2.1 `checkpoint(complete)` 안에서 gate 검사의 위치

`checkpointTx`는 이 순서로 검사합니다. 각 거부 문구는 [ops.md](ops.md)에 있습니다.

1. plan 읽기, `goal_id`로 목표 찾기, `status` 필수, `evidence` 비어 있지 않고 4000자 이하, 원장 읽기
2. **재실행(replay) 판정**: 목표 status가 요청 status와 같고, `goals.json`의 evidence가 같고, 같은 goalId·status·evidence의 `goal_checkpointed` 행이 있고, `complete`면 영수증이 유효(`isValidCompletion`)할 때. 그러면 아무것도 쓰지 않고 결과 문구만 돌려줍니다. **새로 낸 gate는 검사하지 않습니다.**
3. 시작 status: `active` 또는 `failed`만 허용 (`completeCheckpointRefusal`)
4. `gate`가 없으면 `complete checkpoints require gate with targetedVerification, architectReview and criteriaCoverage evidence`
5. `completionView` → `validateGate`. 결함이 있으면 `renderGateDiagnostics` 문구를 에러로 던집니다.
6. 그 다음에 `implementation`, `files_changed`, `learnings` 목록 검사

gate 결함이 있으면 진행 목록 결함은 보고되지 않습니다. 둘 다 틀렸다면 gate를 고친 뒤 다시 부를 때 진행 목록 결함이 나옵니다.

### 2.2 검사 순서

1. `gate`가 객체가 아니면(배열, 문자열, null 포함) 결함 하나 `qualityGate [not_an_object]`만 돌려주고 멈춥니다. 도구 입력 스키마(`src/ultragoal-runtime/tool.ts`)는 `gate`를 `z.record(z.string(), z.unknown())`로 선언합니다. 호스트가 호출 전에 이 스키마로 인자를 거르는지는 확인 못 함. 테스트는 이 결함을 `validateGate`를 직접 불러 확인합니다.
2. 최상위 키: 허용 키는 두 종류 모두 `FINAL_GATE_KEYS`(`targetedVerification`, `architectReview`, `criteriaCoverage`, `reviewCohort`, `criticReview`)입니다. 그 밖의 키가 있으면 모두 묶어 `unsupported_keys` 하나.
3. 빠진 섹션: `targetedVerification`, `architectReview`는 객체가 아니면 빠진 것으로, `criteriaCoverage`는 `undefined`일 때만 빠진 것으로 봅니다. 하나라도 빠지면 `missing_required_sections` 하나.
4. `targetedVerification`이 객체면 그 검사
5. `architectReview`가 객체면 그 검사
6. `criteriaCoverage`가 `undefined`가 아니면 그 검사 (그래서 `criteriaCoverage: {}`나 `null`은 "빠짐"이 아니라 `criteria_coverage_invalid`입니다)
7. `receiptKind`가 `final-aggregate`일 때만 `reviewCohort`, `criticReview` 검사

목표별 gate에 `reviewCohort`나 `criticReview`가 있어도 거부하지 않고 내용도 검사하지 않습니다. 그래도 그 값은 원장의 `qualityGateJson`에 저장되고 `qualityGateHash`에 들어갑니다.

### 2.3 섹션별 규칙

값 비교는 모두 정확한 문자열 비교입니다. `"clear"`, `"Passed"`는 통과하지 못합니다. "비어 있지 않은 문자열"은 앞뒤 공백을 뺀 길이가 1 이상인 문자열입니다.

**`targetedVerification`**

| 필드 | 받는 값 | 아니면 |
|---|---|---|
| `status` | `"passed"` | `targeted_verification_not_passed` |
| `commands` | 원소가 모두 비어 있지 않은 문자열인, 비어 있지 않은 배열 | `missing_command_array` |
| `evidence` | 비어 있지 않은 문자열 | `missing_evidence` |

**`architectReview`**

| 필드 | 받는 값 | 아니면 |
|---|---|---|
| `architectureStatus`, `productStatus`, `codeStatus` | 모두 `"CLEAR"` | 네 필드 중 하나라도 어긋나면 `architect_not_clear` 하나 (경로 `architectReview`) |
| `recommendation` | `"APPROVE"` | 위와 같음 |
| `evidence` | 비어 있지 않은 문자열 | `missing_evidence` |
| `blockers` | 길이 0인 배열 (없으면 결함) | `non_empty_blockers` |

`commands` 필드는 없습니다 (편차 14). SKILL이 비청정으로 드는 `WATCH`, `BLOCK`, `COMMENT`, `REQUEST CHANGES`는 모두 `"CLEAR"`/`"APPROVE"`가 아니므로 `architect_not_clear`가 됩니다.

**`criteriaCoverage`** (편차 15: 활성 기준마다 정확히 한 행)

1. 배열이 아니거나 비어 있으면 `criteria_coverage_invalid` 하나를 남기고 이 섹션 검사를 끝냅니다. 이 경우 `missing_criterion`은 나오지 않습니다.
2. 행마다(`criteriaCoverage[i]`):
   - 객체가 아니면 `criteria_coverage_invalid`, 다음 행으로
   - `criterionId`가 비어 있지 않은 문자열이 아니면 `criteria_coverage_invalid`
   - 아니면 공백을 뺀 ID로: 앞 행에 이미 있으면 `duplicate_criterion`, 없고 활성 기준 목록이 주어졌는데 거기에 없으면 `unknown_criterion`
   - `status`가 `covered`, `passed`, `verified` 중 하나가 아니면 `criterion_not_covered` (gjc 허용 목록에서 `not_applicable`을 뺀 `COVERED_STATUSES`)
   - `evidence`가 비어 있으면 `missing_evidence`
3. 행을 다 본 뒤, 활성 기준 ID 중 어느 행에도 없는 것마다 `missing_criterion` (경로 `criteriaCoverage`)

결과적으로 중복, 없는 ID, 빠진 ID가 모두 거부됩니다. 개정(revise)이나 대체(supersede)로 물러난 기준 ID는 활성 목록에 없으므로 `unknown_criterion`입니다. 활성 기준 목록 없이 부르면(1.3의 마지막 줄) 행 모양과 중복만 검사합니다.

**`reviewCohort`** (최종 gate만. 결함 코드는 모두 `review_cohort_invalid`, 편차 16, 28)

1. 객체가 아니면 결함 하나(`qualityGate reviewCohort is required at the review boundary`)를 남기고 이 섹션 검사를 끝냅니다.
2. `reviewGeneration`: 숫자이고 정수이며 1 이상
3. `joined`: `true`
4. `lanes`: 객체여야 합니다. 객체면:
   - `cleaner`, `architect`, `qa` 외의 키가 있으면 모두 묶어 결함 하나
   - 세 lane 각각: 배열이면 "one lane per generation, not a list" 결함을 남기고 그 lane의 나머지는 건너뜀. 객체가 아니면(없음 포함) "is required". 객체면:
     - `status`: `cleaner`는 `"PASS"`, `architect`는 `"CLEAR"`, `qa`는 `"passed"`
     - `qa`만: `commands`, `adversarialCases`가 각각 비어 있지 않은 문자열 배열
     - `evidence`: 비어 있지 않은 문자열
     - `blockers`: 길이 0인 배열
5. 세대 규칙은 `reviewGeneration`이 유효할 때만 봅니다.
   - 2 이상: `deltaOnly`가 `true`여야 합니다. `deltaPaths`는 배열에서 비어 있지 않은 문자열만 세어 1개 이상이어야 합니다 (문자열이 아닌 원소는 조용히 빠집니다). `scopeExpansion`이 객체일 때만 `severity`, `novelty`, `justification`이 각각 비어 있지 않은 문자열이어야 합니다. `scopeExpansion`이 객체가 아니면 검사하지 않습니다.
   - 1: `deltaOnly`가 `true`면 결함. `deltaPaths`와 `scopeExpansion`은 보지 않습니다.

gjc의 `sourceHash`는 없습니다. `reviewCohort` 안의 모르는 키(예: `sourceHash`)는 거부하지 않습니다.

**`criticReview`** (최종 gate만)

| 필드 | 받는 값 | 아니면 |
|---|---|---|
| `verdict` | `"OKAY"` | `critic_verdict_not_okay` (경로 `criticReview.verdict`). `criticReview`가 없거나 객체가 아니어도 이 결함 하나입니다. |
| `evidence` | 비어 있지 않은 문자열 (객체일 때만 검사) | `missing_evidence` |
| `blockers` | 길이 0인 배열 (객체일 때만 검사) | `non_empty_blockers` |

### 2.4 결함 목록 형식

`src/ultragoal-runtime/messages.ts` `renderGateDiagnostics`가 만듭니다. 통과면:

```
quality gate is valid.
```

결함이 있으면 첫 줄에 개수, 결함마다 두 칸 들여 쓴 한 줄입니다. 순서는 2.2의 검사 순서입니다.

```
N quality-gate error(s):
  <path> [<code>]: <message>
```

`checkpoint`는 이 문구를 에러로 던지므로 도구 결과는 `Error: `로 시작합니다. `validate_gate`는 돌려주기만 하므로 접두어가 없습니다. 테스트(`tests/ultragoal-tool.test.ts` "checkpoint refusals write nothing; a bad gate is the diagnostic list")의 예:

```
Error: 4 quality-gate error(s):
  qualityGate [missing_required_sections]: qualityGate requires architectReview objects
  targetedVerification.status [targeted_verification_not_passed]: qualityGate targetedVerification.status must be passed
  targetedVerification.commands [missing_command_array]: qualityGate targetedVerification.commands must be a non-empty string array
  criteriaCoverage [criteria_coverage_invalid]: qualityGate criteriaCoverage must be a non-empty object array
```

### 2.5 결함 코드와 문구

`<i>`는 행 번호, `<id>`는 기준 ID, `<lane>`은 `cleaner`/`architect`/`qa`, `<key>`는 `severity`/`novelty`/`justification`입니다. 문구는 코드 그대로입니다.

| code | path | message |
|---|---|---|
| `not_an_object` | `qualityGate` | `qualityGate must be a JSON object` |
| `unsupported_keys` | `qualityGate` | `qualityGate contains unsupported keys: <키, 쉼표+공백으로 이음>` |
| `missing_required_sections` | `qualityGate` | `qualityGate requires <목록> objects`. 목록은 하나면 `A`, 둘이면 `A and B`, 셋이면 `targetedVerification, architectReview, and criteriaCoverage` |
| `targeted_verification_not_passed` | `targetedVerification.status` | `qualityGate targetedVerification.status must be passed` |
| `missing_command_array` | `targetedVerification.commands` | `qualityGate targetedVerification.commands must be a non-empty string array` |
| `missing_evidence` | `targetedVerification.evidence`, `architectReview.evidence`, `criteriaCoverage[<i>].evidence`, `criticReview.evidence` | `qualityGate <path> must be a non-empty string` (예: `qualityGate architectReview.evidence must be a non-empty string`) |
| `architect_not_clear` | `architectReview` | `checkpoint(status: complete) requires architect review approval: architectReview architecture/product/code must be CLEAR and recommendation must be APPROVE` |
| `non_empty_blockers` | `architectReview.blockers`, `criticReview.blockers` | `qualityGate <path> must be an empty blockers array` |
| `criteria_coverage_invalid` | `criteriaCoverage` | `qualityGate criteriaCoverage must be a non-empty object array` |
| `criteria_coverage_invalid` | `criteriaCoverage[<i>]` | `qualityGate criteriaCoverage[<i>] must be an object` |
| `criteria_coverage_invalid` | `criteriaCoverage[<i>].criterionId` | `qualityGate criteriaCoverage[<i>].criterionId must be a non-empty string` |
| `duplicate_criterion` | `criteriaCoverage[<i>].criterionId` | `qualityGate criteriaCoverage contains duplicate id <id>` |
| `unknown_criterion` | `criteriaCoverage[<i>].criterionId` | `qualityGate criteriaCoverage references unknown id <id>` |
| `criterion_not_covered` | `criteriaCoverage[<i>].status` | `qualityGate criteriaCoverage[<i>].status must be covered, passed, or verified` |
| `missing_criterion` | `criteriaCoverage` | `qualityGate criteriaCoverage is missing active criterion <id>` |
| `review_cohort_invalid` | `reviewCohort` | `qualityGate reviewCohort is required at the review boundary` |
| `review_cohort_invalid` | `reviewCohort.reviewGeneration` | `reviewCohort.reviewGeneration must be an integer >= 1` |
| `review_cohort_invalid` | `reviewCohort.joined` | `reviewCohort.joined must be true: all lane findings must join before checkpoint` |
| `review_cohort_invalid` | `reviewCohort.lanes` | `reviewCohort.lanes is required` |
| `review_cohort_invalid` | `reviewCohort.lanes` | `reviewCohort.lanes contains unsupported lanes: <이름, 쉼표+공백으로 이음>` |
| `review_cohort_invalid` | `reviewCohort.lanes.<lane>` | `reviewCohort.lanes.<lane> must be one lane per generation, not a list` |
| `review_cohort_invalid` | `reviewCohort.lanes.<lane>` | `reviewCohort.lanes.<lane> is required` |
| `review_cohort_invalid` | `reviewCohort.lanes.<lane>.status` | `reviewCohort.lanes.<lane>.status must be <값>` (`<값>`은 cleaner `PASS`, architect `CLEAR`, qa `passed`) |
| `review_cohort_invalid` | `reviewCohort.lanes.qa.commands` | `qualityGate reviewCohort.lanes.qa.commands must be a non-empty string array` |
| `review_cohort_invalid` | `reviewCohort.lanes.qa.adversarialCases` | `qualityGate reviewCohort.lanes.qa.adversarialCases must be a non-empty string array` |
| `review_cohort_invalid` | `reviewCohort.lanes.<lane>.evidence` | `qualityGate reviewCohort.lanes.<lane>.evidence must be a non-empty string` |
| `review_cohort_invalid` | `reviewCohort.lanes.<lane>.blockers` | `qualityGate reviewCohort.lanes.<lane>.blockers must be an empty blockers array` |
| `review_cohort_invalid` | `reviewCohort.deltaOnly` | `reviewCohort.deltaOnly must be true for reviewGeneration > 1` |
| `review_cohort_invalid` | `reviewCohort.deltaPaths` | `reviewCohort.deltaPaths must be non-empty for reviewGeneration > 1` |
| `review_cohort_invalid` | `reviewCohort.scopeExpansion.<key>` | `qualityGate reviewCohort.scopeExpansion.<key> must be a non-empty string` |
| `review_cohort_invalid` | `reviewCohort.deltaOnly` | `reviewCohort.deltaOnly cannot be true for the first reviewGeneration` |
| `critic_verdict_not_okay` | `criticReview.verdict` | `checkpoint(status: complete) (final aggregate) requires criticReview with verdict OKAY, non-empty evidence, and empty blockers` |
| `unknown_goal` | `goalId` | `Unknown ultragoal goal <id>` (`validate_gate`에서만, `store.ts` `validateGateTx`가 만듦) |

cohort 문구 가운데 일부는 `qualityGate ` 접두어가 있고 일부는 없습니다. 위 표가 코드 그대로입니다.

### 2.6 검사하지 않는 것

- 섹션 안, 기준 행 안, lane 안, `reviewCohort` 안, `criticReview` 안의 모르는 키
- 목표별 gate에 들어 있는 `reviewCohort`, `criticReview`
- 명령과 evidence의 내용, 길이 하한 (비어 있지 않으면 됨)
- 이전 checkpoint와의 세대 연속성

## 3. 완료 영수증: `completionVerification`

`src/ultragoal-runtime/receipt.ts`가 모양, 해시, 유효성 판정을 맡습니다. 머리말은 gjc `ultragoal-runtime.ts`의 `UltragoalCompletionVerification`, `stableStructuredValue`, `hashStructuredValue`, `buildCompletionReceipt`와 `ultragoal-receipt-freshness.ts` `validateLedgerAnchoredHistoricalReceipt`, `ultragoal-guard.ts`(plan이 커져 밀려난 final은 자기 목표의 과거 증거로 남음)를 출처로 적습니다. 편차 5: gjc의 안쪽 이름을 쓰되 필드를 여섯 개로 줄였습니다 (planGeneration 기준, batch 영수증, `goalStatusBeforeCheckpoint`, `gjcGoalMode`, `gjcObjective` 없음). `criteriaRevision`은 open-gajae가 더한 필드입니다 (편차 2, E-10).

### 3.1 필드와 계산

`buildCompletionVerification`이 `checkpointTx`에서 만듭니다.

| 필드 | 값 |
|---|---|
| `receiptId` | `randomUUID()` |
| `receiptKind` | `completionView`의 `receiptKind`: `per-goal` 또는 `final-aggregate` |
| `criteriaRevision` | 그 순간 목표의 활성 기준을 `[{id, text}]` 배열(순서 그대로)로 만든 값의 해시 (`criteriaRevision`) |
| `qualityGateHash` | 제출한 `gate` 전체의 해시. 검사하지 않은 키도 포함합니다. |
| `checkpointLedgerEventId` | 같은 checkpoint가 쓰는 `goal_checkpointed` 행의 `eventId` (`randomUUID()`) |
| `verifiedAt` | checkpoint 시각 (ISO 문자열). 목표의 `completed_at`과 같은 값입니다. |

해시(`hashStructuredValue`)는 값을 `stableStructuredValue`로 정리한 뒤 `JSON.stringify`한 문자열의 sha256 16진수입니다. 정리 규칙은 객체 키를 모든 깊이에서 정렬하고, 값이 `undefined`인 키를 빼고, 배열 순서는 그대로 두는 것입니다. 그래서 같은 gate라면 키 순서가 달라도 해시가 같고, 기준 순서가 바뀌면 `criteriaRevision`이 바뀝니다.

### 3.2 어디에 쓰나

- `goals.json`의 대상 목표: `completionVerification`, `status: "complete"`, `evidence`, `completed_at`
- 원장: `{eventId, event: "goal_checkpointed", goalId, status: "complete", evidence, qualityGateJson: <gate>, completionVerification: <영수증>, timestamp}`. 이 행이 영수증의 고정 행입니다.

`goals.json`을 읽을 때 `completionVerificationError`가 영수증 모양을 검사합니다: 객체일 것, 여섯 필드가 모두 길이 0이 아닌 문자열일 것 (길이만 보므로 공백만 있는 문자열은 통과합니다), `receiptKind`가 두 값 중 하나일 것, 다른 키가 없을 것. 어긋나면 `goals.json` 전체가 무효가 됩니다. 그러면 plan을 읽는 op(`status`, `next`, `checkpoint`, `validate_gate`, `add`/`revise`/`supersede`, `record_review_blockers`, `record_critic_verdict`)가 `goals.json is invalid: …`로 멈춥니다. plan을 읽지 않는 `add_pattern`, `classify_blocker`, `handoff`, `doctor`, `state`, `clear`는 멈추지 않습니다. `classify_blocker`는 행을 그대로 붙이고, 뒤따르는 reconcile이 plan을 읽다 실패해 원장에 `reconcile_failed` 행을 남깁니다. `goal` 도구의 `complete`/`pause` 가드도 읽기 실패로 거부합니다 ([goal-loop.md](goal-loop.md)). 자세한 스키마는 [state-and-files.md](state-and-files.md)에 있습니다.

`checkpoint(status: "pending"|"failed"|"blocked")`와 `record_review_blockers`는 목표의 영수증을 지우지 않고, 목표에 영수증이 있을 때만 자기가 쓰는 `goal_checkpointed` 행에 그 사본을 `completionVerification`으로 붙입니다 (영수증이 없으면 이 필드가 없습니다). 유효성 판정은 `checkpointLedgerEventId`로 원래의 complete 행을 찾으므로 이 사본은 고정 행이 되지 않습니다.

### 3.3 유효성 판정: `checkReceipt`

`checkReceipt(goal, rows)`는 목표 행의 영수증을 원장과 대조합니다. 순서대로 보고 처음 걸리는 결과를 돌려줍니다.

1. 영수증이 없으면 `none`
2. **조건 1 (원장 일치)**: `eventId`가 `checkpointLedgerEventId`인 행이 있고, 그 행이 `goal_checkpointed`이고, `goalId`가 같고, `status`가 `complete`이고, 그 행의 `completionVerification` 해시가 목표 행 영수증의 해시와 같아야 합니다. 아니면 `stale` (`ledger_mismatch`)
3. **조건 2 (기준 불변)**: 지금 목표의 활성 기준으로 계산한 `criteriaRevision`이 영수증 값과 같아야 합니다. 아니면 `stale` (`criteria_changed`)
4. **조건 3 (final만)**: `receiptKind`가 `final-aggregate`이고 고정 행 **뒤**에 필수 목표 집합을 바꾸는 행이 하나라도 있으면 `superseded-final`
5. 모두 통과하면 `valid` (종류와 고정 행 위치 포함)

`isValidCompletion`은 `valid`와 `superseded-final`을 모두 유효한 완료로 셉니다 (PQ-14 (3)-b: 조건 3만 깨진 final은 per-goal 완료로 인정).

`checkReceipt`는 목표의 status를 보지 않습니다. 재오픈해 `pending`이 된 목표의 옛 영수증도 조건을 만족하면 `valid`로 보입니다. `qualityGateHash`를 원장의 `qualityGateJson`으로 다시 계산해 비교하는 코드는 없습니다. 조건 1은 영수증 객체 전체의 해시를 비교할 뿐입니다.

**필수 목표 집합을 바꾸는 행** (`src/ultragoal-runtime/ledger.ts` `isRequiredSetChange`, E-7, 편차 5: 원장 순서로 판정):

| 행 | 해당 |
|---|---|
| `plan_created` | 예 |
| `review_blockers_recorded` | 예 |
| `steering_accepted`, `target: "goal"`, `kind: "add"` 또는 `"supersede"` | 예 |
| `steering_accepted`의 goal `revise`, 기준(`criterion`) 변경 전부 | 아니오 |
| `goal_started`, `goal_checkpointed` (superseded 목표를 `checkpoint(pending)`으로 되살리는 것 포함, PQ-26 A) | 아니오 |
| `blocker_classified`, `critic_verdict`, `workflow_handoff`, `reconcile_failed` | 아니오 |

**`status`의 표시** (`receiptLabel`): `status` 결과의 `## goals` 목록은 목표마다 `- <id> [<status>] <title> — receipt: <표시>`를 씁니다.

| 판정 | 표시 |
|---|---|
| `none` | `none` |
| `stale` (두 사유 모두) | `stale` |
| `superseded-final` | `per-goal(superseded final)` |
| `valid` | `valid` |

### 3.4 기준 개정과 영수증

기준을 추가, 개정, 대체하는 op는 `pending` 목표에만 허용됩니다 ([ops.md](ops.md)). 그래서 끝난 목표의 기준을 바꾸려면 먼저 재오픈해야 하고, 바꾸는 순간 옛 영수증은 `criteria_changed`로 `stale`이 됩니다. 개정된 기준은 새 번호를 받으므로(예: `G001.AC1` → `G001.AC2`) 다시 낼 gate의 `criteriaCoverage`는 새 ID를 덮어야 합니다. 테스트 "completed goal refuses revise and supersede; reopen with checkpoint(pending), revise, re-verify"가 이 흐름을 확인합니다.

## 4. 실행 완료: `runCompletion`

`src/ultragoal-runtime/plan.ts` `runCompletion(file, rows)`가 판정합니다 (C-7). 머리말의 편차 5: gjc의 "다른 목표가 fresh final을 이미 들고 있으면 per-goal" 분기는 없고, 조건 3만 깨진 final은 per-goal로 치며, 마지막으로 끝난 목표에 유효한 final이 있어야 합니다.

### 4.1 판정 순서와 사유 문자열

| 순서 | 조건 | 사유 (`reason`) | 재오픈 대상 (`reopenGoalId`) |
|---|---|---|---|
| 1 | 필수 목표가 없음 | `no required goals` | 없음 |
| 2 | `complete`가 아닌 필수 목표가 있음 | `required goals not complete: <id> (<status>), …` | 없음 |
| 3 | 필수 목표를 `goals.json` 순서로 보며 영수증이 없음 | `<id> has no completion receipt` | 그 목표 |
| 3 | 영수증이 `stale` (`criteria_changed`) | `<id> completion receipt is stale: criteria changed after verification` | 그 목표 |
| 3 | 영수증이 `stale` (`ledger_mismatch`) | `<id> completion receipt is stale: it does not match the ledger` | 그 목표 |
| 4 | 고정 행 위치가 가장 뒤인 목표(원장 순서, 파일 순서 아님)의 영수증이 `valid`한 `final-aggregate`가 아님 (per-goal이거나 `superseded-final`) | `last completed goal <id> has no valid final-aggregate receipt` | 그 목표 |
| 5 | 모두 통과 | 완료 (`complete: true`, `lastGoalId`) | — |

3단계 사유는 도구 op만으로는 생기지 않습니다. 목표를 `complete`로 쓰는 곳은 `checkpointTx`의 complete 분기뿐이고, 그 분기는 항상 영수증과 고정 행을 함께 씁니다. 파일이 op 밖에서 바뀐 경우에 나옵니다 (테스트 "tampered complete is not run-complete").

run 상태(`deriveRunStatus`, mode-state의 phase와 HUD가 따름)는 파일 status만 봅니다. 그래서 `status: complete`와 `run_complete: no`가 함께 보일 수 있습니다. 자세한 것은 [state-and-files.md](state-and-files.md)에 있습니다.

### 4.2 출력

**`status`**: 한 줄로 보여 줍니다. 재오픈 힌트는 없습니다.

```
- run_complete: yes
- run_complete: no (<reason>)
```

**`next`**: 필수 목표가 모두 `complete`여서 next-action이 없을 때(`none`)만 실행 완료를 봅니다. 완료면 첫 줄만, 아니면 두 줄이 더 붙습니다. `renderNext`는 `reopenGoalId`가 있을 때만 `hint=` 줄을 쓰지만, `none`은 필수 목표가 하나 이상 있고 모두 `complete`일 때만 나오므로 이 자리에서 가능한 사유는 4.1의 3, 4단계뿐이고 모두 재오픈 대상을 가집니다. 그래서 `next`에서 `run-complete=no` 줄에는 항상 `hint=` 줄이 따라옵니다.

```
ultragoal complete all=true
run-complete=no reason=<reason>
hint=reopen <id> with ultragoal checkpoint(status: pending) and re-verify with the final gate
```

**`checkpoint(status: "complete")`**: 이 checkpoint 뒤 필수 목표가 모두 `complete`면 `All ultragoal goals are complete.`를 쓰고, 실행이 완료되지 않았으면 이어서 한 줄을 씁니다. 재오픈 힌트 줄은 없습니다. 재실행(2.1의 2단계) 결과에도 같은 줄이 붙습니다.

```
Checkpointed <id> as complete.
All ultragoal goals are complete.
Run not complete: <reason>
```

### 4.3 `goal complete`와 영수증 조건

`goal` 도구의 `complete`는 목표를 찾기 전에 `src/goal/tool.ts` `goalCompleteGuard`를 거칩니다. 전체 순서와 다른 거부 문구는 [goal-loop.md](goal-loop.md)에 있습니다. 영수증과 관련된 부분만 적으면, `goals.json`과 원장을 읽을 수 있고, `review_blocked` 목표가 없고, 필수 목표가 모두 `complete`인데 `runCompletion`이 완료가 아니면 이렇게 거부합니다 (`completeMissingFinalReceipt`, `goalCompleteRefusal`).

```
Error: Ultragoal aggregate completion requires a fresh final aggregate receipt: <reason>. Run `ultragoal checkpoint(status: "complete", gate)` first, or record review blockers and rerun verification.
Reopen <id> with ultragoal checkpoint(goal_id: "<id>", status: "pending", evidence), then run ultragoal next and re-verify it with the final gate.
```

둘째 줄은 재오픈 대상이 있을 때만 붙습니다. 가드는 필수 목표가 모두 `complete`일 때만 `runCompletion`에 이르므로, 둘째 줄이 빠지는 것은 사유가 `no required goals`(모든 목표가 `superseded`)일 때뿐입니다. 도구 op는 남은 마지막 필수 목표의 `supersede`를 거부하므로 이 상태는 파일이 op 밖에서 바뀐 경우에만 생깁니다. `src/goal/tool.ts` 머리말은 이것을 편차 41(DR-10)로 적습니다: "complete"는 C-7의 실행 완료이고, 영수증 때문에 거부할 때는 재오픈할 목표를 이름으로 댑니다.

### 4.4 재오픈이 필요한 경우

재오픈 대상이 나오는 경우는 4.1의 3, 4단계입니다. 도구 op로 생기는 대표적인 경우:

- 다른 목표가 모두 per-goal로 끝난 뒤 남은 마지막 목표를 `supersede`했을 때. 마지막으로 끝난 목표가 per-goal 영수증만 가지고 있습니다. 다만 per-goal `checkpoint(complete)`는 남은 `pending` 목표를 바로 `active`로 바꾸고(`checkpointTx`의 `chooseNextGoal` 진행), `supersede`는 `active` 목표를 `... found active`로 거부합니다. `supersede`가 받는 status는 `pending`, `blocked`, `review_blocked`이므로, 이 경우는 그 목표를 `checkpoint(status: "blocked")`로 막았거나 `checkpoint(status: "pending")`로 되돌린 뒤에만 생깁니다. `review_blocked` 목표는 `record_review_blockers`가 붙인 수정 목표가 필수 목표로 남으므로, 그 수정 목표까지 정리되지 않는 한 "남은 마지막 목표"가 아닙니다. SKILL의 "Reopening a goal"과 steering invariants는 이 경우를 "the last remaining pending goal is superseded"로 적습니다.
- final 뒤에 목표를 `add`했다가 그 목표를 다시 `supersede`했을 때. 옛 final은 `superseded-final`이라 run을 닫지 못합니다.
- 수정 목표 사슬에서 뿌리 목표를 마지막 수정 목표 완료 **뒤에** `supersede`했을 때 (6.4)

final 뒤에 목표를 `add`만 하면 재오픈할 필요가 없습니다. 새 목표가 최종 목표가 되어 새 final을 받습니다 (6.5).

## 5. 재오픈: `checkpoint(status: "pending")`

`checkpoint(goal_id, status: "pending", evidence)`는 목표를 다시 엽니다. `store.ts` 머리말의 편차 27(「E1」): `checkpoint`는 `complete|failed|blocked|pending`을 받고, `pending`은 목표를 다시 열며 영수증을 남깁니다.

- **허용 status**: 모든 status (`ALLOWED_STATUSES["checkpoint-reopen-fail-block"]`)
- **입력**: `evidence`는 비어 있지 않고 4000자 이하. `gate`를 넘기면 검사 없이 원장 행의 `qualityGateJson`에 들어갑니다.
- **바뀌는 것**: `status: "pending"`, `evidence`는 새 값
- **남는 것**: `completionVerification`, `completed_at`, `started_at`, 기준, `amendments`
- **원장**: `goal_checkpointed {goalId, status: "pending", evidence, qualityGateJson?, completionVerification?(사본)}` 한 행. 진행 기록(progress) 항목도, 다음 목표 활성화도 없습니다.
- **결과**:

```
Checkpointed <id> as pending.
Reopened <id>; revise it, then run ultragoal next and checkpoint it again.
```

영수증에 미치는 영향 (IQ-2 A: 재오픈한 목표는 옛 영수증을 그대로 보여 줌):

- `status`의 표시는 기준을 바꾸기 전까지 옛 영수증 그대로 `valid`(또는 `per-goal(superseded final)`)입니다. 기준을 바꾸면 `stale`입니다.
- 목표가 `pending`인 동안 `runCompletion`은 4.1의 2단계에서 멈추므로 이 영수증은 실행 완료에 쓰이지 않습니다.
- 재오픈 행은 필수 목표 집합 변경이 아니므로 다른 목표의 final을 밀어내지 않습니다.

다시 검증하는 순서:

1. 필요하면 plan을 바꿉니다 (`pending`이어야 허용되는 op들).
2. `next`: `active` 목표가 있으면 그것, 없으면 `goals.json` 순서의 첫 `pending` 목표를 엽니다. 재오픈한 목표보다 앞에 다른 `pending` 목표가 있으면 그 목표가 먼저 열립니다.
3. 현재 활성 기준을 덮는 새 gate로 `checkpoint(status: "complete")`. 종류는 1.1 규칙대로 정해집니다. 나머지가 모두 `complete`면 앞 목표라도 최종 gate가 필요합니다.
4. 완료되면 영수증은 새 것(`receiptId`, 고정 행 모두 새 값)으로 바뀝니다. 옛 영수증은 원장의 옛 행에만 남습니다.

재오픈 없이 끝난 목표를 다시 checkpoint하는 경우:

- 같은 evidence로 부르고 영수증이 유효하면 재실행입니다. 아무것도 쓰지 않고 새 gate도 검사하지 않습니다. 결과 문구는 원래 결과를 되풀이하는 것이 아니라, 지금 파일로 `renderCheckpoint`를 다시 계산하되 `startedNext: false`로 만듭니다. 그래서 필수 목표가 모두 `complete`면 `All ultragoal goals are complete.`(와 실행이 완료되지 않았으면 `Run not complete: <reason>`)가, 아니고 다음 목표(`active` 또는 첫 `pending`)가 있으면 다음 목표 줄들 뒤에 원래의 `The next ultragoal goal is active; …` 대신 ``Run `ultragoal next` to activate the next ultragoal goal.``가 붙습니다 (테스트 "E-15: a same-status, same-evidence replay writes nothing; a status mismatch is not a replay"). 같은 이유로 per-goal 영수증을 가진 목표에 최종 gate를 같은 evidence로 다시 내도 영수증은 바뀌지 않습니다.
- 그 밖에는 `Cannot checkpoint <id> as complete with different evidence because its durable goals.json status is already complete.`로 거부됩니다. evidence가 같아도 재실행 조건(일치하는 원장 행, 유효한 영수증)이 깨지면 같은 문구가 나옵니다.

`store.ts` 머리말(C-7a 5, E-15)은 이를 "A complete goal is re-verified only after `checkpoint(status: pending)`: there is no stale-receipt replay."로 적습니다.

## 6. 수정 목표 (fix goal)

수정 목표는 리뷰 blocker를 해결하려고 `record_review_blockers`가 덧붙이는 목표입니다. `plan.ts` 머리말은 gjc `recordUltragoalReviewBlockers`(기본 제목, 상한 전 중복 제거), `findOpenReviewBlockerGoal`, 상한 3, `countUnresolvedReviewBlockerDescents`를 출처로 적고, 편차 29, 40, 42를 답니다. `store.ts` 머리말은 편차 36(`goals.json` 한 번 쓰기)을 답니다. op 입력과 거부 문구 전체는 [ops.md](ops.md)에 있습니다.

### 6.1 `record_review_blockers`가 검증 흐름에 주는 효과

`record_review_blockers(goal_id, title?, objective, evidence)`가 성공하면:

- 대상(부모) 목표: status `review_blocked`, `evidence`는 넘긴 evidence. 영수증은 남습니다.
- 수정 목표를 plan 끝에 덧붙입니다. ID는 다음 번호, `title`은 넘긴 값 또는 기본값 `Resolve final code-review blockers`, `description`은 공백을 뺀 `objective`, 기준은 하나 `<objective> is resolved and re-verified`(`<id>.AC1`), `steering: {kind: "review_blocker", blockedGoalId: <부모>}`, status `pending`. `objective`는 1972자까지입니다 (편차 40: 기준 문구가 2000자 안에 들도록).
- 원장: 부모의 `goal_checkpointed`(status `review_blocked`, 부모에 영수증이 있을 때만 그 사본 `completionVerification`) 다음에 `review_blockers_recorded {goalId: <부모>, blockerGoalId: <수정 목표>}`. 뒤 행은 필수 목표 집합 변경이므로 그 앞의 final 영수증은 `superseded-final`이 됩니다.
- 결과: `Recorded review blockers. blocker-goal-id=<id>`

검증에 미치는 효과:

- 부모는 끝나지 않은 필수 목표이고 `next`가 고르지 않습니다.
- 수정 목표의 completion view에서는 부모가 superseded로 보입니다. 다른 끝나지 않은 필수 목표가 없으면 수정 목표가 최종 목표이고, `next`는 첫 실행부터 `FINAL_REQUIRES`를 출력합니다 (편차 29).
- `review_blocked` 목표가 하나라도 있으면 `goal complete`는 거부됩니다 ([goal-loop.md](goal-loop.md)).

SKILL은 새 수정 목표의 최종 gate를 "a new cohort generation"으로, README 편차 29는 "a second cohort generation"으로 적습니다. 코드는 세대를 기억하지 않으므로 이 세대 번호는 강제하지 않습니다 (1.4).

### 6.2 수정 목표를 완료하면

`checkpoint(status: "complete")`가 통과하면 completion view의 복사본이 새 plan이 됩니다. 부모가 `review_blocked`였다면:

- 부모 status `superseded`, `evidence`는 `Resolved by verification blocker goal <수정 목표 id>: <checkpoint evidence>` (편차 42: gjc의 "story" 대신 "verification blocker goal")
- 부모에는 `amendments` 항목이 붙지 않고, 부모를 위한 원장 행도 따로 없습니다. 원장에는 수정 목표의 `goal_checkpointed` 한 행만 붙고, `pending`이던 다음 목표를 이 checkpoint가 `active`로 바꿨을 때(`startedNext`)만 `goal_started`가 더 붙습니다. 다른 목표가 이미 `active`면 더 붙는 행은 없습니다.
- 부모의 옛 영수증은 남지만 부모가 필수 목표가 아니므로 실행 완료에 쓰이지 않습니다.

### 6.3 중복 제거와 상한

`recordReviewBlockersTx`의 순서는 `objective` 검사 → plan 읽기 → `goal_id` 필수 → **중복 제거** → **상한** → 대상 목표 존재 → `evidence` 검사 → `title` 검사입니다.

- **중복 제거**: `findOpenReviewBlockerGoal`은 `goals.json` 순서에서 처음 나오는, `steering.kind`가 `review_blocker`이고 공백을 뺀 `description`이 공백을 뺀 `objective`와 같고 status가 `complete`/`superseded`가 아닌 목표를 찾습니다. 그 목표의 `blockedGoalId`가 `goal_id`와 같으면 아무것도 쓰지 않고(reconcile만) `Recorded review blockers. blocker-goal-id=<기존 id>`를 돌려줍니다.
  - 이 경로는 `evidence` 검사 전에 돌아가므로, evidence 없이 불러도 성공 문구가 나옵니다.
  - 처음 찾은 목표가 다른 부모의 것이면 중복으로 보지 않습니다. 뒤에 같은 부모의 같은 objective가 있어도 마찬가지입니다.
- **상한**: `countUnresolvedReviewBlockerDescents(file, goal_id)`는 `blockedGoalId`가 그 목표이고 status가 `complete`/`superseded`가 아닌 수정 목표 수입니다. 3 이상이면 거부합니다.

```
review_blocker_recursion_cap: goal <id> already has <n> unresolved review_blocker descents (cap=3). Record a human pause/escalation or resolve existing blockers before recording more. Unresolved technical findings are never auto-completed.
```

상한은 막힌 목표마다 따로 셉니다. 수정 목표의 수정 목표(사슬)는 단계마다 부모가 다르므로 상한이 사슬을 멈추지 않습니다.

### 6.4 수정 목표의 사슬 (fix-of-a-fix)

수정 목표의 최종 gate도 통과하지 못하면 SKILL은 그 수정 목표에 다시 `record_review_blockers`를 부르라고 합니다. 그러면 그 수정 목표가 `review_blocked`가 되고 또 하나의 수정 목표가 붙습니다. 마지막 수정 목표의 completion view는 **직접 부모만** superseded로 보므로, 사슬 뿌리의 `review_blocked` 목표는 끝나지 않은 필수 목표로 남고 마지막 수정 목표는 최종 목표가 아닙니다. `next`는 목표별 gate를 출력합니다.

그래서 SKILL은 마지막 수정 목표를 완료하기 **전에** 사슬의 다른 `review_blocked` 목표(마지막 수정 목표의 직접 부모만 빼고)를 모두 `supersede`하라고 합니다. `supersede`는 `review_blocked` 목표에 허용되고, 남은 필수 목표가 그것 하나일 때만 거부됩니다. 그 뒤 `next`는 최종 gate를 출력합니다.

순서를 거꾸로 하면(마지막 수정 목표를 목표별 gate로 먼저 완료):

1. 결과는 `Checkpointed <id> as complete.` 한 줄입니다. 뿌리가 아직 `review_blocked`라 다음 목표도, 완료 줄도 없습니다.
2. `status`는 `run_complete: no (required goals not complete: <뿌리> (review_blocked))`, `next`는 `resolve-blockers`입니다.
3. 뿌리를 `supersede`하면 `run_complete: no (last completed goal <마지막 수정 목표> has no valid final-aggregate receipt)`가 됩니다.
4. 마지막 수정 목표를 재오픈하고 `next`를 부르면 최종 gate가 출력되고, 최종 gate로 다시 완료하면 run이 닫힙니다 (테스트 "late root supersede: reopen the last completed goal").

### 6.5 final 영수증 뒤에 목표 추가

`add`(`target: "goal"`)는 `steering_accepted` add 행을 쓰고, 이는 필수 목표 집합 변경입니다.

- 옛 final은 `superseded-final`이 되어 `status`에 `per-goal(superseded final)`로 보이고, 유효한 per-goal 완료로 셉니다.
- 새 목표는 다른 목표가 모두 `complete`이므로 최종 목표입니다. `next`는 최종 gate를 출력합니다.
- 새 목표를 최종 gate로 완료하면 그 목표가 원장상 마지막이 되어 run이 닫힙니다. 옛 목표의 표시는 계속 `per-goal(superseded final)`입니다.
- 새 목표를 완료하지 않고 `supersede`하면 유효한 final이 없어져 옛 마지막 목표를 재오픈해야 합니다 (4.4).

## 7. critic 판정: `record_critic_verdict`

`record_critic_verdict(terminus, verdict, evidence, blockers?, classification_event_id?, goal_id?)`는 원장에 `critic_verdict` 행 하나를 씁니다. 출처는 gjc `recordUltragoalCriticVerdict`(`store.ts` 머리말)와 `ultragoal-receipt-freshness.ts`의 `CRITIC_VERDICT_EVENT`, `TERMINAL_CRITIC_CEILING`(`ledger.ts` 머리말)이고, 편차 18(연속 횟수)을 답니다. 입력 검사 전체와 거부 문구는 [ops.md](ops.md)에 있고, 여기서는 판정의 의미만 적습니다.

### 7.1 terminus와 판정 규칙

| terminus | 쓰임 | 코드가 보는 것 |
|---|---|---|
| `completion` | 최종 gate 직전의 terminal critic. SKILL은 `ITERATE`/`REJECT`를 먼저 이 op로 기록하고, 그 다음 `record_review_blockers`로 findings를 기록하고 run을 다시 열라고(reopen the run) 합니다. | `verdict`가 `OKAY`면 `blockers`가 비어 있어야 함 (`OKAY critic verdict must have empty blockers`). 그 밖의 결속은 없습니다. |
| `pause` | `goal pause` 전의 terminal critic | 위 규칙 + `classification_event_id` 필수 (`record_critic_verdict classification_event_id is required for pause verdicts`), 원장의 가장 최근 `blocker_classified` 행이 `human_blocked`이고 그 `eventId`가 이 값과 같아야 함 (`record_critic_verdict pause requires classification_event_id to name the latest human_blocked classification`) |

`verdict`는 `OKAY`, `ITERATE`, `REJECT` 중 하나입니다. `goal_id`는 기록만 하고 존재를 확인하지 않습니다. `completion` 판정에 `classification_event_id`를 넘기면 검사 없이 기록합니다.

completion 쪽 `OKAY`는 최종 gate의 `criticReview`로 들어갑니다. 코드는 completion `OKAY`를 `critic_verdict` 행으로 기록하라고 요구하지 않고, gate의 `criticReview`를 원장의 어떤 판정 행과도 대조하지 않습니다.

pause 판정을 실제로 쓰는 곳은 `goal pause` 가드(`src/goal/tool.ts` `goalPauseGuard`)입니다. 실행이 완료되지 않았으면 가장 최근 `blocker_classified`가 `human_blocked`여야 하고, 그 뒤에 그 분류에 결속된 pause 판정 가운데 가장 새로운 것이 clean `OKAY`(비어 있지 않은 evidence, 빈 blockers)여야 합니다. 더 새로운 분류가 기록되면 이전 판정은 쓸모가 없어집니다. 거부 문구와 전체 순서는 [goal-loop.md](goal-loop.md)에 있습니다.

### 7.2 연속 횟수 (streak)

`src/ultragoal-runtime/ledger.ts` `criticNonOkayStreak(rows, resetAfter?)`가 셉니다. 원장을 끝에서부터 거꾸로 봅니다.

1. `eventId`가 `resetAfter`인 행을 만나면 멈춥니다 (그 행은 세지 않음).
2. `event`가 없는 행(`reconcile_failed`)은 건너뜁니다.
3. `plan_created`를 만나면 멈춥니다. 새 `create`가 횟수를 0으로 되돌립니다.
4. critic OKAY 행을 만나면 멈춥니다 (`isCriticOkay`, X-6):
   - `critic_verdict`이고 `verdict`가 `OKAY` (terminus 무관)
   - 또는 `goal_checkpointed`이고 `status`가 `complete`이고 영수증 `receiptKind`가 `final-aggregate`이고 `qualityGateJson.criticReview.verdict`가 `OKAY`
5. 그 밖의 `critic_verdict` 행(곧 `ITERATE`/`REJECT`)마다 1을 더합니다. 두 terminus를 합쳐 셉니다.

목표별 checkpoint의 gate에 `criticReview: {verdict: "OKAY"}`가 들어 있어도 영수증이 per-goal이므로 횟수를 멈추지 않습니다.

`resetAfter`는 continuation 기록(`state/goal-continuation.json`)의 `critic_reset_after`입니다. `record_critic_verdict`는 보이는(`dropped`가 아닌) goal이 있고 그 기록이 같은 goal id의 것일 때만 이 값을 씁니다 (`continuationForGoal`). 이 값은 critic 보류가 사용자 프롬프트로 풀릴 때 가장 새로운 `critic_verdict` 행으로 옮겨집니다. 그 동작은 [goal-loop.md](goal-loop.md)에 있습니다. 상한은 `CRITIC_STREAK_HOLD = 5`입니다.

gjc는 run 전체 합계를 세지만, 여기서는 마지막 OKAY 뒤의 연속 횟수입니다 (편차 18, PQ-3 (1) A, (2)-b). 하드 스톱 행이나 override op는 없습니다.

### 7.3 결과 문구

op는 방금 쓴 행을 포함해 횟수를 세고 이렇게 출력합니다 (`renderCriticVerdict`).

```
Recorded critic verdict: <verdict> (<terminus>).
critic non-OKAY streak: <n>/5
```

`n`이 5 이상이면 둘째 줄 끝에 ` — continuation held`가 붙습니다. `n`은 5를 넘을 수 있습니다 (예: `critic non-OKAY streak: 6/5 — continuation held`). `OKAY`를 기록하면 그 행에서 멈추므로 `0/5`입니다.

이 문구는 알림일 뿐이고, op 자신은 아무것도 보류하지 않습니다. 보류는 goal 루프가 다음 continuation 결정 때 같은 계산으로 겁니다 ([goal-loop.md](goal-loop.md)). 판정 행은 gate나 checkpoint를 막지 않습니다.

## 8. 예시

아래 출력은 코드와 테스트(`tests/ultragoal-tool.test.ts`)에서 옮겼습니다. `goal-objective=`, `Goal objective:` 줄과 `status`의 경로 줄은 줄였습니다.

### 8.1 두 목표 run: G001 목표별, G002 최종

`create`로 G001, G002를 만든 뒤:

**1. `next`** → G001이 `active`가 되고 원장에 `goal_started G001`. G002가 아직 `pending`이므로 목표별 gate입니다.

```
ultragoal next-action=execute-goal goal-id=G001
objective=do part 1
goal-objective=…
checkpoint requires=targetedVerification:passed,architectReview:CLEAR+APPROVE,criteriaCoverage:all
criteria=G001.AC1
```

**2. `checkpoint(G001, complete, 목표별 gate)`** → 통과. G001에 per-goal 영수증, G002가 `active`로 바뀌고 `goal_started G002`.

```
Checkpointed G001 as complete.
Next ultragoal goal: G002 — Goal 2
Objective: do part 2
Goal objective: …
Criteria: G002.AC1
The next ultragoal goal is active; continue the current aggregate goal and checkpoint this goal when verified.
```

**3. `next`** → G002는 이미 `active`라 쓰기 없음. G001이 `complete`이므로 G002는 최종 목표입니다.

```
ultragoal next-action=execute-goal goal-id=G002
objective=do part 2
goal-objective=…
checkpoint requires=targetedVerification:passed,architectReview:CLEAR+APPROVE,criteriaCoverage:all,reviewCohort:joined,criticReview:OKAY
criteria=G002.AC1
```

**4. G002에 목표별 gate만 내면** → 거부. 아무것도 쓰지 않습니다.

```
Error: 2 quality-gate error(s):
  reviewCohort [review_cohort_invalid]: qualityGate reviewCohort is required at the review boundary
  criticReview.verdict [critic_verdict_not_okay]: checkpoint(status: complete) (final aggregate) requires criticReview with verdict OKAY, non-empty evidence, and empty blockers
```

**5. `checkpoint(G002, complete, 최종 gate)`** → 통과. G002에 final-aggregate 영수증.

```
Checkpointed G002 as complete.
All ultragoal goals are complete.
```

**6. `status`**

```
- status: complete
…
- run_complete: yes
- goal: active (ultragoal)

## goals
- G001 [complete] Goal 1 — receipt: valid
  - G001.AC1: part 1 works
- G002 [complete] Goal 2 — receipt: valid
  - G002.AC1: part 2 works
```

이제 `goal complete`가 허용됩니다.

단계별 상태:

| 단계 | G001 | G002 | 원장에 붙은 행 |
|---|---|---|---|
| create | `pending`, 영수증 없음 | `pending` | `plan_created` |
| 1 next | `active` | `pending` | `goal_started G001` |
| 2 checkpoint G001 | `complete`, per-goal | `active` | `goal_checkpointed G001 complete`(영수증 per-goal), `goal_started G002` |
| 3 next | 같음 | 같음 | 없음 |
| 4 거부 | 같음 | 같음 | 없음 |
| 5 checkpoint G002 | `complete`, per-goal | `complete`, final-aggregate | `goal_checkpointed G002 complete`(영수증 final-aggregate) |

G001의 영수증 모양 (해시와 UUID는 값 대신 설명):

```json
{
  "receiptId": "<UUID>",
  "receiptKind": "per-goal",
  "criteriaRevision": "<sha256: [{\"id\":\"G001.AC1\",\"text\":\"part 1 works\"}]>",
  "qualityGateHash": "<sha256: 제출한 gate>",
  "checkpointLedgerEventId": "<goal_checkpointed G001 행의 eventId>",
  "verifiedAt": "<checkpoint 시각>"
}
```

이 뒤에 G003을 `add`하면 G002의 표시가 `per-goal(superseded final)`로 바뀌고 `run_complete: no (required goals not complete: G003 (pending))`가 되며, G003이 최종 gate를 받습니다 (6.5).

### 8.2 수정 목표 사슬: G001 → G002(수정) → G003(수정), 뿌리 supersede

목표 하나(G001, 제목 `Goal 1`)로 `create`한 run입니다. 세대 번호는 SKILL의 절차를 따른 값이고, 코드는 세대 번호를 강제하지 않습니다.

| 단계 | 호출과 결과 | G001 | G002 | G003 | `checkpoint requires=` |
|---|---|---|---|---|---|
| 1 | `next` | `active` | — | — | 최종 (유일한 목표) |
| 2 | 1세대 cohort에 blocker. `record_review_blockers(G001, objective: "fix it", evidence)` → `Recorded review blockers. blocker-goal-id=G002` | `review_blocked` | `pending`, `blockedGoalId: G001` | — | |
| 3 | `next` | `review_blocked` | `active` | — | 최종 (G001을 superseded로 봄) |
| 4 | 2세대 cohort에 blocker. `record_review_blockers(G002, objective: "fix fix", evidence)` → `blocker-goal-id=G003` | `review_blocked` | `review_blocked` | `pending`, `blockedGoalId: G002` | |
| 5 | `next` | `review_blocked` | `review_blocked` | `active` | **목표별** (G002만 superseded로 보고 G001은 끝나지 않음) |
| 6 | `supersede(target: "goal", goal_id: "G001", rationale, evidence)` → `Accepted supersede steering. target=G001` | `superseded` | `review_blocked` | `active` | |
| 7 | `next` (쓰기 없음, 다시 계산) | `superseded` | `review_blocked` | `active` | **최종** |
| 8 | `checkpoint(G003, complete, evidence: "fixed", 최종 gate 3세대)` → `Checkpointed G003 as complete.` / `All ultragoal goals are complete.` | `superseded` | `superseded`, evidence `Resolved by verification blocker goal G003: fixed` | `complete`, final-aggregate | |

8단계 뒤 `status`:

```
- status: complete
- goals: 3 (pending=0 active=0 complete=1 failed=0 blocked=0 review_blocked=0 superseded=2)
…
- run_complete: yes
- goal: active (ultragoal)

## goals
- G001 [superseded] Goal 1 — receipt: none
- G002 [superseded] Resolve final code-review blockers — receipt: none
- G003 [complete] Resolve final code-review blockers — receipt: valid
```

(`## goals`의 기준 줄은 생략했습니다. G002의 기준은 `G002.AC1: fix it is resolved and re-verified`입니다.)

원장에 붙는 행 순서: `plan_created`, `goal_started G001`, `goal_checkpointed G001 review_blocked`, `review_blockers_recorded G001→G002`, `goal_started G002`, `goal_checkpointed G002 review_blocked`, `review_blockers_recorded G002→G003`, `goal_started G003`, `steering_accepted supersede G001`, `goal_checkpointed G003 complete`(final-aggregate). G002를 superseded로 바꾼 것은 마지막 행과 같은 checkpoint에서 `goals.json`에만 반영됩니다.

6단계(뿌리 supersede)를 건너뛰고 5단계에서 G003을 목표별 gate로 완료하면 6.4의 "순서를 거꾸로 하면" 흐름이 됩니다: 뿌리를 나중에 supersede한 뒤 `next`가 `hint=reopen G003 with ultragoal checkpoint(status: pending) and re-verify with the final gate`를 출력하고, G003을 재오픈해 최종 gate로 다시 완료해야 합니다.
