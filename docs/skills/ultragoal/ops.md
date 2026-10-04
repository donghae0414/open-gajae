# `ultragoal` 도구의 op

이 문서는 `ultragoal` 도구의 op 16개를 코드 그대로 적습니다. op마다 입력, 검사 순서와 거부 문구, 읽는 파일, 쓰는 파일과 필드, 원장 이벤트, reconcile 여부, 결과 문구를 다룹니다. 기준 커밋은 [README.md](README.md) 머리에 있습니다.

다음 주제는 다른 문서가 맡습니다. 여기서는 링크만 겁니다.

- gate(검증 제출서) 검사 규칙, 결함 코드, 목표별/최종 gate 선택, 완료 영수증, 실행 완료 판정, 재오픈, 수정 목표 연쇄, critic 연속 횟수: [gates-and-receipts.md](gates-and-receipts.md)
- 진입, `ralplan handoff`와 `ultragoal handoff`의 저널 인계, 체인 가드: [entry-and-handoff.md](entry-and-handoff.md)
- `goal` 도구, continuation, 보류: [goal-loop.md](goal-loop.md)
- 파일 스키마, 쓰기 큐, 활성 행·스냅숏, 감사 행, 단계 전이와 reconcile, HUD, doctor 검사: [state-and-files.md](state-and-files.md)
- 도구 숨김, 역할 권한, 산출물 가드: [guards.md](guards.md)

용어는 [README.md](README.md)를 따릅니다. **목표**는 `goals.json`의 `G001` 같은 ultragoal 목표이고, **goal**은 `goal` 도구가 다루는 goal 모드의 목표 하나(`state/goal-state.json`)입니다. **원장**은 `ultragoal/ledger.jsonl`, **진행 메모**는 `ultragoal/progress.txt`, **mode-state**는 `state/ultragoal-state.json`입니다.

## 한눈에 보기

| op | 쓰는 파일 | 원장 이벤트 | reconcile | 결과 첫 줄 |
|---|---|---|---|---|
| `status` | 없음 (reconcile만) | 없음 | 예 | `# ultragoal status` |
| `create` | `goals.json`, 원장, 진행 메모, `goal-state.json`(goal을 켤 때) | `plan_created` | 예 | `Created ultragoal plan with N goal(s) at <path>.` |
| `next` | `goals.json`, 원장(목표를 시작할 때만) | `goal_started`(시작할 때) | 예 | `ultragoal next-action=…` 또는 `ultragoal complete all=true` |
| `checkpoint` | `goals.json`, 원장, 진행 메모(`complete`만) | `goal_checkpointed`, 다음 목표를 시작하면 `goal_started` | 예 | `Checkpointed <id> as <status>.` |
| `validate_gate` | 없음 | 없음 | 아니요 | `quality gate is valid.` 또는 `N quality-gate error(s):` |
| `add`, `revise`, `supersede` | `goals.json`, 원장 | `steering_accepted` | 예 | `Accepted <op> steering. target=<id>` |
| `add_pattern` | 진행 메모 | 없음 | 아니요 | `Pattern added to progress.txt.` |
| `record_review_blockers` | `goals.json`, 원장 | `goal_checkpointed`(`review_blocked`), `review_blockers_recorded` | 예 | `Recorded review blockers. blocker-goal-id=<id>` |
| `classify_blocker` | 원장 | `blocker_classified` | 예 | `Recorded blocker classification: <classification> event-id=<id>.` |
| `record_critic_verdict` | 원장 | `critic_verdict` | 예 | `Recorded critic verdict: <verdict> (<terminus>).` |
| `handoff` | 두 skill의 mode-state, 행, 스냅숏, 저널, 원장, 진행 메모 | `workflow_handoff` | 아니요 (행은 직접 씀) | 한 줄 JSON `{"ok":true,"from":"ultragoal",…}` |
| `doctor` | 없음 | 없음 | 아니요 | `ok: true` 또는 `ok: false` |
| `state` | mode-state, 행, 스냅숏 | 없음 | 아니요 (행은 직접 씀) | 한 줄 JSON `{"ok":true,"skill":"ultragoal",…}` |
| `clear` | mode-state, 행 삭제, 스냅숏 | 없음 | 아니요 (행은 직접 지움) | 한 줄 JSON, goal이 열려 있으면 둘째 줄 |

reconcile하는 op는 reconcile이 실패하면 원장에 `{type: "reconcile_failed", error}` 행을 하나 더 씁니다([아래](#reconcile)).

## 도구 정의

`src/ultragoal-runtime/tool.ts`의 `ultragoalTool`이 도구를 만들고, `src/tools.ts`의 `createTools`가 `ultragoalTool(store, { rootSession })`으로 등록합니다.

- **이름과 권한**: 이름은 `ultragoal`, 권한 이름도 `ultragoal`입니다. `src/tools/define.ts`의 `defineTool`이 `options: { codemode: false, permission: "ultragoal" }`로 감쌉니다. 이 권한으로 다른 agent에게서 도구를 숨기는 방법은 [guards.md](guards.md)에 있습니다.
- **모델이 보는 설명**:
  ```
  Operate this session's ultragoal run (gjc ultragoal): status, create the goals, next, checkpoint a goal (complete with its quality gate, failed, blocked, or pending to reopen), validate_gate, add/revise/supersede a goal or criterion, add_pattern, record_review_blockers, classify_blocker, record_critic_verdict, handoff to ralplan or deep-interview, doctor, state, clear. The only way to change ultragoal files and state.
  ```
- **op 목록**: `ULTRAGOAL_OPS`가 위 표의 순서대로 16개를 정합니다(spec R17). 입력 스키마는 다른 op 이름을 거부합니다. 스키마를 거치지 않고 들어온 이름은 `execute`의 `switch` 끝에서 `unknown op <op>`로 거부됩니다.
- **gjc 출처** (헤더 주석 기준): `gjc-runtime/ultragoal-runtime.ts`의 `dispatchUltragoalCommand`(`status`, `create-goals`, `complete-goals`, `checkpoint`, `quality-gate validate`, `steer`, `record-review-blockers`, `classify-blocker`, `record-critic-verdict`)와 `gjc-runtime/state-runtime.ts`(`state` doctor, write, clear, handoff). ultragoal 편차 3, 4, 27(구조화된 `create`, 계획 변경 op, `checkpoint` 상태 4개), 25(state 동사를 이 도구의 op로), 41(gjc 명령 대신 op 호출). op 도구 모양, 호출자 검사, 루트 세션 해석은 `src/ralplan-runtime/tool.ts`를 따릅니다.

### 입력 스키마

입력은 zod 객체 하나입니다. `op`만 필수이고 나머지는 모두 선택입니다. 어떤 필드가 필요한지는 op가 실행 중에 검사합니다.

| 필드 | 타입 | 쓰는 op |
|---|---|---|
| `op` | `ULTRAGOAL_OPS` 중 하나 | 전부 |
| `description` | string | `create`(실행 설명), `add`/`revise`(goal 대상: 목표 설명) |
| `goals` | `{title: string, description: string, acceptanceCriteria: string[]}[]` | `create` |
| `retry_failed` | boolean | `next` |
| `goal_id` | string | `checkpoint`, `validate_gate`, `revise`/`supersede`, `add`(criterion 대상), `record_review_blockers`, `classify_blocker`, `record_critic_verdict` |
| `status` | `complete` \| `failed` \| `blocked` \| `pending` (`CHECKPOINT_STATUSES`) | `checkpoint` |
| `evidence` | string | `checkpoint`, `add`/`revise`/`supersede`, `record_review_blockers`, `classify_blocker`, `record_critic_verdict` |
| `gate` | 문자열 키 객체(`record<string, unknown>`) | `checkpoint`, `validate_gate` |
| `implementation`, `files_changed`, `learnings` | string[] | `checkpoint`(`complete`) |
| `target` | `goal` \| `criterion` | `add`/`revise`/`supersede` |
| `title` | string | `add`/`revise`(goal 대상), `record_review_blockers` |
| `acceptanceCriteria` | string[] | `add`(goal 대상) |
| `after` | string | `add`/`revise`(goal 대상) |
| `criterion_id` | string | `revise`/`supersede`(criterion 대상) |
| `criterion` | string | `add`/`revise`(criterion 대상) |
| `rationale` | string | `add`/`revise`/`supersede` |
| `reason` | string | `handoff` (계획 변경 op는 거부) |
| `pattern` | string | `add_pattern` |
| `objective` | string | `record_review_blockers` |
| `classification` | `resolvable` \| `human_blocked` | `classify_blocker` |
| `terminus` | `completion` \| `pause` | `record_critic_verdict` |
| `verdict` | `OKAY` \| `ITERATE` \| `REJECT` | `record_critic_verdict` |
| `blockers` | string[] | `record_critic_verdict` |
| `classification_event_id` | string | `record_critic_verdict` |
| `to` | `ralplan` \| `deep-interview` | `handoff` |
| `patch` | 문자열 키 객체 | `state` |
| `force` | boolean | `clear` |

스키마 수준의 동작:

- **스키마가 거부하는 모양**: 스키마(`tool.input`)는 enum 밖의 값, 배열·문자열·`null`인 `gate`·`patch`, `acceptanceCriteria`가 빠진 `goals` 항목을 거부합니다. `tests/ultragoal-tool.test.ts`의 "P-AC8: refused ops change no files"가 `tool.input.safeParse`로 `classification: "bogus"`와 `to: "ultragoal"`을 이렇게 확인합니다.
- **모르는 키**: `z.object`는 모르는 키를 버립니다(zod 4.6.5 `safeParse`로 확인).
- **호스트의 검사**: `src/tools/define.ts`의 `defineTool`이 만든 `execute`는 입력을 다시 파싱하지 않고 그대로 op에 넘깁니다. 그래서 위 거부와 키 버리기가 실제 도구 호출에서 일어나는지는 호스트가 호출 전에 이 스키마로 인자를 거르는지에 달려 있고, 이는 확인 못 함. 거부할 때 호스트가 어떤 문구를 내는지도 확인 못 함. 같은 이유로 gate 검사기의 `not_an_object` 결함이 도구 경로에서 나올 수 있는지도 확인 못 함. 테스트는 모두 `tool.input.parse`를 직접 부른 뒤 `execute`를 부릅니다.
- **쓰지 않는 필드**: op가 쓰지 않는 필드는 조용히 무시합니다. 예외는 하나로, `add`/`revise`/`supersede`에 `reason`을 주면 거부합니다([아래](#add--revise--supersede)).

### 길이 제한과 공통 검사

길이 제한은 `src/ultragoal-runtime/plan.ts`의 `LIMITS`에 있습니다.

| 이름 | 값 | 적용 대상 |
|---|---|---|
| `title` | 200 | 목표 제목 |
| `text` | 2000 | 실행 설명, 목표 설명, 기준, `rationale`, `implementation`/`files_changed`/`learnings`·`blockers` 항목 |
| `evidence` | 4000 | 모든 `evidence` |
| `pattern` | 500 | `add_pattern`의 `pattern` |
| `objective` | 1972 | `record_review_blockers`의 `objective` (2000에서 `" is resolved and re-verified"` 28자를 뺀 값) |

`src/ultragoal-runtime/store.ts`의 검사 도우미가 거부 문구를 만듭니다. 아래 `<name>`은 필드 이름이고, 목록 항목은 `implementation[0]`처럼 번호가 붙습니다.

| 도우미 | 거부 문구 | 비고 |
|---|---|---|
| `checkText` | `<name> must be a non-empty string`, `<name> exceeds <max> characters` | 길이는 trim **전** 값으로 잽니다. 돌려주는 값은 trim한 값입니다. |
| `checkList` | `<name> needs at least one item`, 그 뒤 항목마다 `checkText` | |
| `checkCriteria` | `checkList`(최대 2000), 그 뒤 `<name> has duplicate criteria` | 중복은 trim한 뒤 비교합니다. |
| `checkSubstantive` | `checkText`, 그 뒤 `<name> must be substantive: at least 5 words and 32 characters` | `isSubstantive`: 공백으로 나눈 단어 5개 이상, trim한 길이 32자 이상(gjc `MIN_SUBSTANTIVE_EVIDENCE_WORDS/CHARS`) |
| `required` | `<name> is required for ultragoal <op>` | 값이 `undefined`일 때만 거부합니다. |

`checkpoint`, `record_review_blockers`, `classify_blocker`, `record_critic_verdict`의 `evidence`는 이 도우미를 쓰지 않습니다. 이 op들은 trim한 뒤 비었는지와 4000자를 넘는지(`evidence exceeds 4000 characters`)를 직접 검사합니다.

### 결과와 거부의 형식

- **정상 결과**: op 함수가 돌려준 문자열이 그대로 `content`가 됩니다. 결과는 gjc의 사람이 읽는 텍스트입니다(계획 C-14). `handoff`, `state`, `clear`만 한 줄 JSON 영수증입니다(`src/ultragoal-runtime/messages.ts`의 `renderWriteReceipt`: 값이 `undefined`인 키를 뺀 `JSON.stringify`).
- **거부**: op가 던진 `Error`는 `defineTool`이 잡아 `Error: <message>`로 돌려줍니다. 도구 호출 자체는 실패하지 않습니다. `cause`는 문구에 나오지 않습니다.
- **gate 결함의 두 경로**: `checkpoint(complete)`의 gate 결함은 던져지므로 `Error: N quality-gate error(s):`로 시작합니다. `validate_gate`는 같은 목록을 **돌려주므로** `Error: ` 접두어가 없습니다.

## 소유 세션과 트랜잭션

### 소유 세션 해석

`ultragoalTool` 안의 `ownerSession`이 모든 op 앞에서 다음을 차례로 검사합니다.

1. `context.sessionID`가 비어 있지 않은 문자열인지 봅니다. 아니면 `a native session is required`로 거부합니다.
2. `context.agent`가 `open-gajae`인지 봅니다. 아니면 `the ultragoal tool is not available to <agent>`로 거부합니다(D-TL3, I-12).
3. `deps.rootSession(sessionID)`로 계보 루트(lineage root) 세션을 찾습니다(D-SF6). 계보 루트는 `parentID`를 따라 올라가서 만나는 부모 없는 세션입니다. 실제 구현은 `src/hooks.ts`의 `rootSession`이고, 조회 실패·순환·읽을 수 없는 응답은 모두 예외입니다. 예외가 나면 `could not resolve the session lineage for ultragoal`로 거부합니다.

그 결과 자식 세션에서 부른 op도 루트 세션 폴더의 run을 씁니다. 테스트 "the tool is open-gajae's alone and works on the lineage root"가 이를 확인합니다.

### workflow 트랜잭션

찾은 루트 세션 ID(owner)로 `store.workflowTransaction(owner, tx => …)` 하나를 열고, 그 안에서 op 함수를 부릅니다. op 함수는 모두 `src/ultragoal-runtime/store.ts`에 있습니다.

- **직렬화**: `src/state.ts`의 `workflowTransaction`은 owner 세션의 workflow 큐 하나를 잡고 본문을 실행합니다. 같은 세션의 다른 workflow op와 state 읽기·쓰기는 이 큐에서 기다립니다(계획 C-1). 큐의 성질은 [state-and-files.md](state-and-files.md)에 있습니다.
- **되돌리기 없음**: 트랜잭션은 줄 세우기일 뿐, 쓰다가 실패해도 앞서 쓴 파일을 되돌리지 않습니다.
- **검사 먼저**: 그래서 각 op는 입력과 파일 검사를 첫 쓰기 전에 끝내도록 짜여 있습니다(계획 C-7a). 테스트 "P-AC8: refused ops change no files"가 거부된 op는 파일 7개(`goals.json`, 원장, 진행 메모, `audit.jsonl`, mode-state, 활성 행, `goal-state.json`)를 바꾸지 않음을 확인합니다.
- **예외 (`handoff`)**: `handoff`는 저널과 두 mode-state를 쓴 **뒤에** 활성 행 파일을 읽습니다. 그래서 행 파일이 깨져 있으면 일부만 쓴 채로 실패합니다([아래](#handoff), [entry-and-handoff.md](entry-and-handoff.md)).
- **마지막 안전장치**: `goals.json`을 쓰는 op에서는 그 파일이 첫 쓰기입니다. `writePlanTx`가 부르는 `serializeGoals`는 스키마를 다시 검사하고, 어긋나면 `refusing to write an invalid goals.json: <error>`로 거부합니다.
- **쓰기 순서**: gjc 순서대로 `goals.json` → 원장 → 진행 메모 → `goal-state.json` → reconcile입니다. 파일을 쓸 때마다 감사 행(audit row)을 하나씩 `state/audit.jsonl`에 남깁니다(계획 C-6).

| 쓰기 | 함수 | 감사 행 (`category`/`verb`) |
|---|---|---|
| `goals.json` | `writePlanTx` | `state`/`write` |
| 원장 한 행 | `appendLedgerTx` | 행마다 `ledger`/`append` |
| 진행 메모 | `writeProgressTx` | `artifact`/`write` |
| `goal-state.json` | `src/goal/state.ts`의 `writeGoalStateTx` | `state`/`write` (`skill: "ultragoal"`) |

도구가 남기는 감사 행의 `owner`는 `open-gajae-runtime`(`RUNTIME_OWNER`)입니다. 감사 행 스키마는 [state-and-files.md](state-and-files.md)에 있습니다.

### 읽는 파일과 필요 조건

공통 읽기 함수는 넷입니다.

- **`readPlanTx`**: `goals.json`을 `src/ultragoal-runtime/plan.ts`의 `parseGoals`로 읽습니다. 파일이 없으면 "계획 없음", 스키마에 어긋나면 `goals.json is invalid: <error>`로 거부합니다. 예: `goals.json is invalid: goals.json is not valid JSON`, `goals.json is invalid: goals.json version 1 (the retired OMC ralph format) is not supported; replace it with ultragoal create`.
- **`requirePlanTx`**: 계획이 없으면 ``No ultragoal plan found. Run `ultragoal create` first.``(`NO_PLAN`)로 거부합니다.
- **`readLedgerTx`**: 원장을 엄격 파서 `parseLedger`로 읽습니다. 모든 줄이 알려진 이벤트나 `reconcile_failed` 행이어야 하고, 아니면 `ledger.jsonl is invalid: <error>`로 거부합니다. 예: `ledger.jsonl is invalid: ledger.jsonl line 3 is not valid JSON`.
- **`goalOf`**: `goal_id`를 trim해 목표를 찾습니다. 없으면 `No ultragoal goal found for <id>.`로 거부합니다.

op마다 읽는 파일은 다음과 같습니다. 원장을 엄격 파싱하지 않는 op는 원장이 깨져 있어도 행을 덧붙입니다.

| op | `goals.json` | 원장 엄격 파싱 | 그 밖에 읽는 것 |
|---|---|---|---|
| `status` | 있으면 읽음, 깨졌으면 거부 | 계획이 있을 때 | `goal-state.json`(계획이 있을 때) |
| `create` | 읽지 않음 (덮어씀) | 아니요 | 진행 메모, `goal-state.json` |
| `next` | 필수 | 예 | — |
| `checkpoint` | 필수 | 예 | 진행 메모(`complete`) |
| `validate_gate` | 있으면 읽음, 깨졌으면 거부 | 아니요 | — |
| `add`/`revise`/`supersede` | 필수 | 아니요 | — |
| `add_pattern` | 읽지 않음 | 아니요 | 진행 메모 (필수) |
| `record_review_blockers` | 필수 | 아니요 | — |
| `classify_blocker` | 읽지 않음 | 아니요 | — |
| `record_critic_verdict` | 필수 (있고 유효한지만) | 예 | `goal-state.json`, `goal-continuation.json` |
| `handoff` | 읽지 않음 | 아니요 | 두 skill의 mode-state, 진행 메모, ultragoal 이전 행 |
| `doctor` | 읽지 않음 | 아니요 | mode-state, 활성 행, 스냅숏 |
| `state` | 읽지 않음 | 아니요 | mode-state |
| `clear` | 읽지 않음 | 아니요 | mode-state, `force`가 없으면 활성 행과 스냅숏, `goal-state.json` |

`goal-state.json`이 스키마에 어긋나면 `readGoalStateTx`는 goal이 없는 것으로 봅니다(gjc `normalizeGoal`).

### reconcile

reconcile은 `goals.json`과 원장에서 실행 상태를 다시 계산해 mode-state와 활성 행에 강제로 쓰는 단계입니다. `reconcileUltragoalTx`가 맡습니다(gjc `reconcileUltragoalState`, 계획 C-4). 자세한 필드와 규칙은 [state-and-files.md](state-and-files.md)에 있습니다. 이 문서에 필요한 부분만 적습니다.

- **reconcile하는 op**: `status`, `create`, `next`, `checkpoint`, `add`, `revise`, `supersede`, `record_review_blockers`, `classify_blocker`, `record_critic_verdict`. 모두 op의 마지막 단계에서 부릅니다.
- **쓰지 않는 경로도 포함**: `checkpoint`의 같은 호출 반복, `record_review_blockers`의 중복 적중, 이미 `active`인 목표를 돌려주는 `next`, `status`처럼 계획 파일을 쓰지 않는 경로도 reconcile은 합니다.
- **reconcile하지 않는 op**: `add_pattern`, `validate_gate`, `doctor`는 하지 않습니다. `handoff`, `state`, `clear`는 행을 직접 쓰거나 지웁니다.
- **쓰는 것**:
  - mode-state의 `current_phase`와 `status`에 실행 상태를 넣습니다. `goals.json`이 없으면 `missing`이고, 있으면 `deriveRunStatus`의 `pending`, `active`, `complete`, `blocked`, `failed` 중 하나입니다.
  - `active`는 계획이 있고 상태가 `complete`가 아닐 때 `true`입니다.
  - 감사 행 `state`/`reconcile`에 `forced: true`를 답니다.
  - 활성이면 행을 쓰고, 비활성이면 행을 지웁니다. 그 뒤 스냅숏을 다시 만듭니다.
- **계획이 없을 때**: 계획 없이 reconcile하는 op(`status`, `classify_blocker`)는 mode-state를 비활성 `missing`으로 씁니다. 이 경우 `goal-planning`이 끝나고 행도 지워집니다. 임시 폴더에서 계획 없이 `status`를 불러 `current_phase: "missing"`, `active: false`가 쓰이는 것을 확인했습니다.
- **실패**: reconcile은 op 결과를 바꾸지 않습니다. 예를 들어 `goals.json`이 깨진 채로 `classify_blocker`를 부르면 reconcile 안의 `readPlanTx`가 실패합니다. 실패하면 원장에 `{eventId, type: "reconcile_failed", error, timestamp}` 행을 덧붙이려 시도하고, 그것도 실패하면 조용히 넘어갑니다. 테스트 "a reconcile failure keeps the op's result and appends gjc's reconcile_failed ledger row"는 다른 경로로 실패를 일으킵니다. `create` 뒤 `state/active/other.json`을 깨진 JSON으로 만들고 `status`를 부르면, reconcile이 스냅숏을 다시 만들며 활성 행들을 읽다가(`src/skill-state/rows.ts`의 `readRowsTx`) 실패합니다. 테스트는 결과가 `# ultragoal status`로 시작하고 원장 마지막 행이 `reconcile_failed`임을 확인합니다.
- **알려진 동작**: `ultragoal handoff` 뒤 ralplan을 진행하는 중에 reconcile하는 op를 부르면 ultragoal이 `goals.json`에서 다시 활성이 되고 ralplan 행이 지워집니다([known-limits.md](known-limits.md)의 기록된 동작, spec D-SF1). 행 규칙은 [state-and-files.md](state-and-files.md)에 있습니다.

### 원장 행의 모양

원장 한 행은 `{eventId, ...이벤트 필드, timestamp}`입니다(`src/ultragoal-runtime/ledger.ts`의 `ledgerRow`, gjc `appendLedger` 순서). `eventId`는 `randomUUID()`, `timestamp`는 ISO 시각입니다. 이벤트별 필드는 op 절에 적습니다. 파서 규칙은 [state-and-files.md](state-and-files.md)에 있습니다. `plan_created.description`, `steering_accepted`의 `target`·`criterionId`·`after`·`amendment`, `workflow_handoff`는 gjc에 없는 필드와 이벤트입니다(ultragoal 편차 39).

## `status`

실행 요약을 보여 주고 reconcile합니다. `statusTx`가 맡습니다. gjc 출처는 `getUltragoalStatus`와 `gjc-runtime/state-renderer.ts`의 `renderUltragoalStatusMarkdown`입니다. 넛지 줄은 없고(편차 10), `run_complete`, `goal`, `## goals` 줄은 open-gajae가 더했습니다(편차 41).

- **입력**: 없음.
- **검사 순서**:
  1. `readPlanTx`: `goals.json`이 깨졌으면 `goals.json is invalid: <error>`.
  2. 계획이 있으면 `readLedgerTx`: 원장이 깨졌으면 `ledger.jsonl is invalid: <error>`.

  두 거부 모두 reconcile 전에 일어나므로 아무것도 쓰지 않습니다.
- **읽는 것**: `goals.json`. 계획이 있을 때만 원장과 `goal-state.json`도 읽습니다(`visibleGoal`: `dropped`는 없는 것으로 봅니다). reconcile이 따로 읽는 것은 [reconcile](#reconcile)을 봅니다.
- **쓰는 것**: reconcile만 합니다.
- **결과 (계획 없음)**:
  ```
  # ultragoal status

  - status: missing
  - No ultragoal plan found at <goals.json 절대 경로>. Run `ultragoal create` first.
  ```
- **결과 (계획 있음)**: `src/ultragoal-runtime/messages.ts`의 `renderStatus`가 만듭니다.
  ```
  # ultragoal status

  - status: <pending|active|complete|blocked|failed>
  - goals: <개수> (pending=<n> active=<n> complete=<n> failed=<n> blocked=<n> review_blocked=<n> superseded=<n>)
  - objective: <goal의 고정 objective>
  - current: <id> (<status>)
  - goals_path: <goals.json 절대 경로>
  - ledger_path: <ledger.jsonl 절대 경로>
  - run_complete: <yes | no (<reason>)>
  - goal: <<status> (<source>) | none>

  ## goals
  - G001 [<status>] <title> — receipt: <valid|per-goal(superseded final)|stale|none>
    - G001.AC1: <기준 문장>
  ```
  - `- status:`는 `deriveRunStatus`입니다. 모든 목표가 `complete`나 `superseded`면 `complete`입니다. 아니면 `active` 목표가 하나라도 있으면 `active`, 없으면 `failed`, `blocked`(`review_blocked` 포함), `pending` 순서로 봅니다. 파일 상태만 보므로 영수증이 모자라도 `complete`가 나올 수 있습니다.
  - `- current:`는 파일 순서에서 첫 `pending`, `active`, `failed` 목표입니다(`currentGoal`, gjc `getUltragoalStatus`와 같음). 없으면 줄이 빠집니다. **active 목표와 다를 수 있습니다.** 예: `G001`을 `checkpoint(pending)`로 다시 연 동안 `G002`가 active면 `current`는 `G001 (pending)`입니다.
  - `- run_complete:`의 판정은 [gates-and-receipts.md](gates-and-receipts.md)에 있습니다.
  - `- goal:`은 보이는 goal이 없으면 `none`입니다.
  - 제목과 기준 문장은 줄바꿈을 공백으로 바꿔 한 줄로 찍습니다(`oneLine`).

**SKILL만 요구하는 것**: SKILL은 "`create` 전에 `status`를 부르지 말라"고 합니다. 코드는 막지 않고, 계획 없이 부르면 reconcile이 `goal-planning`을 `missing`으로 끝냅니다.

## `create`

`goals.json`을 새로 쓰고 goal을 켭니다. `createTx`가 맡습니다(DR-25, D-TL10). gjc 출처는 `createUltragoalPlan`과 `gjc-runtime/goal-mode-request.ts`(goal 켜기)입니다. 관련 편차는 셋입니다. 3(구조화 입력), 1(진행 메모에 `PLAN` 메모), 12(다른 goal이 열려 있으면 켜지 않음).

- **입력**: `description`, `goals[]`(각각 `title`, `description`, `acceptanceCriteria[]`).
- **검사 순서**:
  1. `description`: `description must be a non-empty string`, `description exceeds 2000 characters`.
  2. `goals`가 없거나 비었으면 `goals needs at least one goal`.
  3. 999개를 넘으면 `at most 999 goals`.
  4. 목표마다 순서대로 셋을 검사합니다. 목표 번호는 0부터 셉니다.
     - `goals[i].title` (200자)
     - `goals[i].description` (2000자)
     - `goals[i].acceptanceCriteria` (`checkCriteria`): `goals[i].acceptanceCriteria needs at least one item`, `goals[i].acceptanceCriteria[j] must be a non-empty string`, `goals[i].acceptanceCriteria[j] exceeds 2000 characters`, `goals[i].acceptanceCriteria has duplicate criteria`
- **읽는 것**: 진행 메모, `goal-state.json`.
- **읽지 않는 것**: `goals.json`과 원장. 그래서 깨진 `goals.json`(v1 포함)도 거부하지 않고 덮어씁니다. 깨진 원장에도 행을 덧붙이지만, 이후 엄격 파싱하는 op는 계속 거부합니다.
- **상태 검사 없음**: 현재 ultragoal 단계나 `active`도 보지 않습니다. 실행 도중에 불러도 계획을 덮어씁니다.
- **만드는 계획**: `buildGoalsFile`이 만듭니다.
  ```json
  {
    "version": 2,
    "description": "<trim한 description>",
    "created_at": "<now>",
    "updated_at": "<now>",
    "goals": [
      {
        "id": "G001",
        "title": "…",
        "description": "…",
        "status": "pending",
        "acceptanceCriteria": [{ "id": "G001.AC1", "text": "…" }],
        "amendments": []
      }
    ]
  }
  ```
- **goal 켜기 판단** (계획 C-9). objective는 고정 문장입니다(`ultragoalGoalObjective`, 편차 42). `<dir>`은 루트 세션 폴더 이름입니다.
  ```
  Complete the durable ultragoal plan in .open-gajae/<dir>/ultragoal/goals.json, including later accepted/appended goals, under the original description constraints; use .open-gajae/<dir>/ultragoal/ledger.jsonl as the audit trail.
  ```
  열린 goal은 `active`나 `paused`인 goal입니다(`isOpenGoal`).

  | 기존 goal | 동작 | 켜기 결과(`GoalArming`) |
  |---|---|---|
  | 없음, `complete`, `dropped`, 스키마에 어긋난 파일 | `createGoalState`로 새 goal을 만듭니다: 새 `id`, 위 objective, `status: "active"`, `source: "ultragoal"` | `created` |
  | 열린 goal인데 `source`가 `ultragoal`이거나 trim한 objective가 위 문장과 같음 | 그대로 둡니다 | `kept` |
  | 그 밖의 열린 goal | 그대로 둡니다 | `not-armed` |
- **쓰는 것** (순서대로):
  1. `goals.json`: 위 계획으로 덮어씁니다.
  2. 원장 `plan_created`: `{eventId, event: "plan_created", goalIds: ["G001", …], description, timestamp}`
  3. 진행 메모: `progressForCreate`가 씁니다. 파일이 없으면 머리글(`# Ultragoal Progress Log`, `Started:`, `## Codebase Patterns`, `(No patterns discovered yet)`, `---`)을 먼저 만듭니다. 있으면 기존 내용 뒤에 `PLAN` 메모를 덧붙입니다(PQ-15 A). 시각은 UTC의 `YYYY-MM-DD HH:MM`입니다.
     ```

     ## [2026-09-30 00:00] - PLAN

     **Description:**
     - <description>

     ---
     ```
  4. `goal-state.json`: `created`일 때만 씁니다.
  5. reconcile. 첫 `create` 뒤 mode-state는 `current_phase: "pending"`, `active: true`, `active_goal_id: "G001"`이 됩니다.
- **테스트로 확인된 감사 행 순서**: `goals.json` `state`/`write` → 원장 `ledger`/`append` → 진행 메모 `artifact`/`write` → `goal-state.json` `state`/`write` → mode-state `state`/`reconcile` → 행 `write-active-entry` → 스냅숏 `rebuild-active-snapshot`(테스트 "create: overwrites goals.json …").
- **다시 부를 때**: `goals.json`은 새 계획으로 바뀝니다. 원장과 진행 메모에는 덧붙기만 합니다. 새 `plan_created`는 필수 목표 집합의 변화이고, critic 연속 횟수의 경계이기도 합니다([gates-and-receipts.md](gates-and-receipts.md)).
- **결과**: `renderCreate`가 만듭니다. 목표가 하나면 `goal`, 여럿이면 `goals`입니다.
  ```
  Created ultragoal plan with <N> goal(s) at <goals.json 절대 경로>.
  <켜기 줄>
  ```
  켜기 줄은 `goalArmingLine`이 만듭니다.
  ```
  Goal armed: <objective>
  Goal armed: the open ultragoal goal (<status>) already tracks this plan.
  Goal not armed: another goal is open (<status>, source <source>). Run goal drop, then ultragoal create again to arm this plan's goal.
  ```

**SKILL만 요구하는 것**:

- "Implementation is complete" 같은 막연한 기준을 쓰지 말 것. 코드는 비었는지와 중복만 검사합니다.
- 검증이 묶인 목표는 합칠 것.
- ralplan에서 돌아온 뒤 이전 계획의 남은 일을 새 목표에 옮길 것.

## `next`

다음 목표를 `active`로 만들고 실행 안내를 찍습니다. `nextTx`가 맡습니다(DR-2, DR-3). gjc 출처는 `startNextUltragoalGoal`, 결과 문구는 `renderCompleteHandoff`입니다. `retry_failed`는 편차 34(PQ-19 B)입니다.

- **입력**: `retry_failed`(선택). `true`일 때만 켜집니다.
- **검사 순서**:
  1. `requirePlanTx`: `NO_PLAN`이나 `goals.json is invalid: …`.
  2. `readLedgerTx`: `ledger.jsonl is invalid: …`. 원장 내용은 결과가 `none`일 때 실행 완료 판정에만 쓰이지만, 원장은 항상 읽고 검사합니다.
- **다음 행동 판단**: `resolveNextAction`이 정합니다.
  1. 필수 목표(`superseded`가 아닌 목표)가 모두 `complete`면(`allRequiredComplete`) `none`.
  2. 아니면 `chooseNextGoal`: 첫 `active` 목표, 없으면 첫 `pending` 목표. `retry_failed: true`면 active가 없을 때 첫 `failed` 목표를 `pending`보다 먼저 봅니다. 찾으면 `execute-goal`.
  3. 못 찾으면 끝나지 않은 필수 목표 가운데 `blocked`/`review_blocked`가 있으면 `resolve-blockers`.
  4. 그것도 없고 `failed`가 있으면 `retry-failed`.
  5. 그 밖에는 빈 목록의 `resolve-blockers`. 필수 목표가 하나도 없을 때만 여기에 옵니다.
- **쓰는 것**: `execute-goal`의 목표가 아직 `active`가 아닐 때만 씁니다.
  - `goals.json`: 그 목표의 `status: "active"`, `started_at`(이미 있으면 유지), 파일의 `updated_at`.
  - 원장 `goal_started`: `{eventId, event: "goal_started", goalId, timestamp}`.
  - 이미 `active`인 목표를 돌려줄 때는 쓰지 않습니다. 테스트 "next starts the next goal once"가 두 번 불러도 `goal_started`가 하나임을 확인합니다.
- **재시도 목표**: `retry_failed`로 다시 시작한 `failed` 목표는 처음 `started_at`을 그대로 둡니다.
- 마지막에 reconcile합니다.
- **결과**: `renderNext`가 만듭니다. 행동마다 모양이 다릅니다.
  - `execute-goal`:
    ```
    ultragoal next-action=execute-goal goal-id=<id>
    objective=<목표 description>
    goal-objective=<goal의 고정 objective>
    checkpoint requires=<요구 목록>
    criteria=<기준 ID들, 쉼표로 구분>
    ```
    요구 목록은 목표의 완료 판정 view(`completionView`)가 `final-aggregate`인지로 정합니다. `criteria=`는 그 view의 `activeCriterionIds`입니다. 최종 gate면 목표 자신의 ID 뒤에 해결된 수정 사슬에서 이월된 ID가 붙습니다(편차 44). 목표별 gate와 최종 gate의 선택 규칙은 [gates-and-receipts.md](gates-and-receipts.md)에 있습니다.
    ```
    targetedVerification:passed,architectReview:CLEAR+APPROVE,criteriaCoverage:all
    targetedVerification:passed,architectReview:CLEAR+APPROVE,criteriaCoverage:all,reviewCohort:joined,criticReview:OKAY
    ```
  - `none`: 첫 줄은 `ultragoal complete all=true`입니다. 실행 완료 판정(`runCompletion`)이 `no`면 두 줄이 더 붙습니다. `none`이면 필수 목표가 하나 이상 있고 모두 `complete`이므로, 여기서 나올 수 있는 `no` 이유(영수증 없음, 영수증 stale, 마지막 목표에 유효한 final 없음)에는 모두 다시 열 목표(`reopenGoalId`)가 있습니다. 그래서 `run-complete=no` 줄이 나오면 `hint=` 줄도 늘 함께 나옵니다.
    ```
    ultragoal complete all=true
    run-complete=no reason=<reason>
    hint=reopen <id> with ultragoal checkpoint(status: pending) and re-verify with the final gate
    ```
  - `resolve-blockers`:
    ```
    ultragoal next-action=resolve-blockers
    blocked-goal-ids=G002,G004
    blocked-statuses=G002:blocked,G004:review_blocked
    hint=resolve blockers via ultragoal classify_blocker / ultragoal record_review_blockers / ultragoal add (or audited ultragoal supersede); blocked goals stay unschedulable
    ```
  - `retry-failed`:
    ```
    ultragoal next-action=retry-failed
    failed-goal-ids=G001
    hint=run `ultragoal next(retry_failed: true)` after the failure is addressed
    ```
  - 빈 목록의 `resolve-blockers`:
    ```
    ultragoal next-action=resolve-blockers
    hint=no schedulable goal; inspect goals.json and ledger
    ```
  - `criteria=`, 재오픈 `hint=`, `run-complete=` 줄은 open-gajae가 더했습니다(편차 41).

**SKILL만 요구하는 것**: 찍힌 `goal-objective=` 문장으로 goal을 만들 것(`goal get` 뒤 `goal create`). 현재 목표 하나만 끝낼 것.

## `checkpoint`

목표 하나의 상태를 기록합니다. `checkpointTx`가 맡습니다(DR-4). gjc 출처는 `checkpointUltragoalGoalForSession`(증거, 같은 호출 반복, 시작 상태, 부모 대체, 영수증, 쓰기 순서)과 `checkpointAndContinueUltragoalGoal`(완료 뒤 다음 목표로 넘어가기)이고, 결과 문구는 `renderCheckpointContinuation`입니다.

관련 편차:

- 27: 상태 4개와 `pending` 재오픈
- 1: `complete`에 진행 목록 3개 필요
- 36: 완료와 넘어가기를 `goals.json` 한 번에 씀
- 29: gate 종류를 완료 판정 view에서 정함
- C-7a 5 (E-15): 같은 호출 반복

### 입력

| 필드 | 필요 |
|---|---|
| `goal_id` | 항상 |
| `status` | 항상. `complete`, `failed`, `blocked`, `pending` |
| `evidence` | 항상. trim한 뒤 비어 있지 않고 4000자 이하 |
| `gate` | `complete`에서 필수. 다른 상태에서는 선택이고 검사 없이 기록 |
| `implementation`, `files_changed`, `learnings` | `complete`에서 필수(각 1개 이상, 항목마다 2000자 이하). 다른 상태에서는 무시 |

### 공통 앞부분

모든 상태가 다음을 차례로 거칩니다.

1. `requirePlanTx`: `NO_PLAN`이나 `goals.json is invalid: …`.
2. `goalOf`: `goal_id is required for ultragoal checkpoint`, `No ultragoal goal found for <id>.`.
3. `status`: `status is required for ultragoal checkpoint`.
4. `evidence`: `checkpoint evidence is required`, `evidence exceeds 4000 characters`.
5. `readLedgerTx`: `ledger.jsonl is invalid: …`.
6. **같은 호출 반복(idempotent replay)** 판정. 다음이 모두 맞으면 아무것도 쓰지 않고 결과 문구만 만든 뒤 reconcile합니다.
   - 목표의 현재 `status`가 입력 `status`와 같습니다.
   - 저장된 `evidence`가 trim한 입력 `evidence`와 같습니다.
   - 원장에 같은 `goalId`, `status`, `evidence`의 `goal_checkpointed` 행이 있습니다.
   - `complete`면 목표의 영수증이 유효합니다(`isValidCompletion(checkReceipt(…))`: `valid`나 `per-goal(superseded final)`).

   이 판정은 시작 상태 검사, gate 검사, 진행 목록 검사보다 **먼저** 합니다. 그래서 같은 `evidence`로 `complete`를 다시 부르면 `gate`와 진행 목록이 없어도 성공 문구가 나옵니다. 반복 경로의 결과 문구는 저장된 결과를 다시 보여 주는 것이 아니라 **지금 파일에서 새로 계산**합니다. `allComplete`는 `allRequiredComplete(file)`, 다음 목표는 `chooseNextGoal(file, false)`(`complete`일 때만), 실행 완료 판정은 `runCompletion(file, rows)`로 구하고, `startedNext`는 항상 `false`입니다. 그래서 처음 호출이 다음 목표를 이미 active로 만들었어도 반복 결과는 ``Run `ultragoal next` to activate the next ultragoal goal.``로 끝납니다(테스트 "E-15"). 반복 경로는 gjc가 하는 넘어가기도 쓰지 않습니다. 완료된 목표를 다시 검증하려면 먼저 `checkpoint(status: pending)`로 다시 열어야 합니다.

### `status: "complete"`

순서는 **검증 → 영수증 → 쓰기 → 다음 목표 문구**입니다. 검증 규칙은 [gates-and-receipts.md](gates-and-receipts.md)에 있습니다.

1. **시작 상태**: 목표가 `active`나 `failed`여야 합니다(`ALLOWED_STATUSES["checkpoint-complete"]`). `failed` 목표는 `next(retry_failed: true)` 없이도 바로 완료할 수 있습니다. 아니면 `completeCheckpointRefusal`로 거부합니다.
   ```
   Cannot checkpoint <id> as complete while its durable goals.json status is pending; start the goal before completing it.
   Cannot checkpoint <id> as complete with different evidence because its durable goals.json status is already complete.
   Cannot checkpoint <id> as complete because its durable goals.json status is superseded.
   Cannot checkpoint <id> as complete while its durable goals.json status is <status>; only active or retryable failed goals can be completed.
   ```
   마지막 문구는 `blocked`와 `review_blocked`에 씁니다.
2. **gate 존재**: `gate`가 없으면 거부합니다.
   ```
   complete checkpoints require gate with targetedVerification, architectReview and criteriaCoverage evidence
   ```
3. **gate 검사**: `completionView(file, goal.id, { evidence })`로 완료 판정 view를 만듭니다.
   - 이 view에서는 수정 목표의 `review_blocked` 부모가 이미 `superseded`입니다.
   - `validateGate`에 view가 정한 영수증 종류(`per-goal`/`final-aggregate`)와 view의 `activeCriterionIds`(목표의 현재 기준 ID들, 최종이면 이월된 기준 ID도, 편차 44)를 넘깁니다.
   - 결함이 하나라도 있으면 전체 목록을 던집니다.
     ```
     Error: <N> quality-gate error(s):
       <path> [<code>]: <message>
     ```
4. **진행 목록**: `implementation`, `files_changed`, `learnings`를 이 순서로 `checkList`합니다. 예: `implementation needs at least one item`.
5. **영수증과 목표**: `buildCompletionVerification`이 영수증(`completionVerification`)을 만들어 목표에 넣습니다.
   - 영수증 필드는 `receiptId`, `receiptKind`, `criteriaRevision`, `qualityGateHash`, `checkpointLedgerEventId`, `verifiedAt`입니다. 뜻은 [gates-and-receipts.md](gates-and-receipts.md)에 있습니다.
   - `checkpointLedgerEventId`는 이 호출이 미리 만든 `eventId`입니다. 이 값이 원장 행의 `eventId`가 됩니다.
   - 목표에는 `status: "complete"`, `evidence`, `completed_at`도 씁니다.
6. **사슬 대체**: 목표가 수정 목표면, view에서 이미 사슬 위쪽의 `review_blocked` 목표가 바뀌어 있습니다(편차 43). 바뀐 목표마다 `status: "superseded"`이고 `evidence`는 다음 문장입니다.
   ```
   Resolved by verification blocker goal <fix id>: <evidence>
   ```
   바뀐 목표 쪽에는 원장 행이나 `amendments` 항목이 따로 생기지 않습니다. 이미 superseded인 목표는 지나가고, 다른 status를 만나면 멈춥니다. gjc는 한 단계 위 부모만 바꿉니다.
7. **다음 목표** (gjc `advanceNext`, PQ-9 A): `chooseNextGoal(plan, false)`로 첫 `active`, 없으면 첫 `pending` 목표를 고릅니다. `pending`이면 `active`로 바꾸고 `started_at`을 채웁니다(`startedNext`). 이미 active인 목표면 그대로 둡니다.
8. **진행 메모 항목**: 기존 진행 메모에 덧붙입니다. 파일이 없으면 머리글부터 만듭니다(`appendProgressEntry`, `initialProgress`). 항목은 한 줄로 바꿔 적습니다.
   ```

   ## [2026-09-30 00:00] - G001

   **What was implemented:**
   - …

   **Files changed:**
   - …

   **Learnings for future iterations:**
   - …

   ---
   ```
9. **쓰기**:
   - `goals.json`을 한 번 씁니다. 목표, 대체된 부모, 새로 active가 된 다음 목표, `updated_at`이 함께 들어갑니다.
   - 원장:
     - `{eventId, event: "goal_checkpointed", goalId, status: "complete", evidence, qualityGateJson: <입력 gate 그대로>, completionVerification, timestamp}`
     - `startedNext`면 `{eventId, event: "goal_started", goalId: <다음 목표>, timestamp}`
   - 진행 메모를 쓰고, reconcile합니다.

### `status: "failed" | "blocked" | "pending"`

- **시작 상태**: 어느 상태에서든 받습니다(`checkpoint-reopen-fail-block`, C-15). `complete` 목표를 `failed`/`blocked`로 바꾸거나, `superseded` 목표를 `pending`으로 되살리는 것도 됩니다.
- **목표에 쓰는 것**: `status`와 `evidence`만 바꿉니다. `completionVerification`(영수증), `started_at`, `completed_at`은 그대로 둡니다. 그래서 다시 연 목표도 이전 영수증을 보여 줍니다(IQ-2 A). 영수증이 언제 효력을 갖는지는 [gates-and-receipts.md](gates-and-receipts.md)에 있습니다.
- **gate**: 주어져도 검사하지 않고 원장 행의 `qualityGateJson`에 그대로 적습니다.
- **진행 목록**: 무시합니다. 진행 메모도 쓰지 않습니다.
- **쓰기**:
  - `goals.json`
  - 원장 `{eventId, event: "goal_checkpointed", goalId, status, evidence, qualityGateJson?, completionVerification?, timestamp}`. `completionVerification`은 목표에 영수증이 있을 때만 붙습니다.
  - reconcile

### 결과 문구

`renderCheckpoint`가 만듭니다. 첫 줄은 항상 `Checkpointed <id> as <status>.`입니다.

- **`complete`, 필수 목표가 모두 `complete`** (`allRequiredComplete`):
  ```
  All ultragoal goals are complete.
  Run not complete: <reason>
  ```
  둘째 줄은 실행 완료 판정이 `no`일 때만 붙습니다.
- **`complete`, 다음 목표가 있을 때**:
  ```
  Next ultragoal goal: <id> — <title>
  Objective: <description>
  Goal objective: <goal의 고정 objective>
  Criteria: <다음 목표의 gate가 덮을 기준 ID들, 공백으로 구분. 최종이면 이월된 ID 포함(편차 44)>
  ```
  마지막 줄은 둘 중 하나입니다. 다음 목표가 원래 active였을 때도 아래 줄이 나옵니다(임시 폴더에서 확인).
  ```
  The next ultragoal goal is active; continue the current aggregate goal and checkpoint this goal when verified.
  Run `ultragoal next` to activate the next ultragoal goal.
  ```
  위 줄은 이 호출이 다음 목표를 시작했을 때, 아래 줄은 시작하지 않았을 때 나옵니다.
- **`complete`, 다음 목표도 없고 모두 끝나지도 않았을 때**: 예를 들어 남은 목표가 모두 `failed`나 `blocked`인 경우입니다. 첫 줄만 나옵니다.
- **`failed`**:
  ```
  Resume failed goals with `ultragoal next(retry_failed: true)` after the blocker is fixed.
  ```
- **`blocked`**:
  ```
  Blocked ultragoal work must be resolved with explicit blocker work or steering before final completion.
  ```
- **`pending`**:
  ```
  Reopened <id>; revise it, then run ultragoal next and checkpoint it again.
  ```

`Criteria:`, `Run not complete:`, `Reopened` 줄은 open-gajae가 더했습니다(편차 41).

**코드와 SKILL의 경계**:

- **코드가 보는 것**: 제출된 gate의 모양과 값만 봅니다. architect, cohort lane, critic을 실제로 돌렸는지는 모릅니다([gates-and-receipts.md](gates-and-receipts.md)).
- **SKILL만 요구하는 것**:
  - 불통과 리뷰는 `failed`로 기록할 것
  - 성공이든 실패든 매번 checkpoint할 것
  - 중간 목표에서 `goal complete`를 부르지 말 것. `goal complete`의 거부는 `goal` 도구가 합니다([goal-loop.md](goal-loop.md)).

## `validate_gate`

`checkpoint(complete)`의 gate 판정을 읽기 전용으로 돌립니다. `validateGateTx`가 맡습니다(D-VF12). gjc 출처는 `validateUltragoalQualityGateReadOnly`와 누락 gate 처리입니다. 목표도 없고 일정에 올릴 목표도 없을 때 모양만 보는 동작은 gjc가 대상 없이 하는 동작을 따릅니다(`store.ts` 헤더).

- **입력**: `gate`(필수), `goal_id`(선택).
- **검사와 판정 순서**:
  1. `gate`가 없으면 `gate is required for ultragoal validate_gate`로 거부합니다.
  2. `readPlanTx`: `goals.json`이 깨졌으면 `goals.json is invalid: …`로 거부합니다.
  3. `goal_id`가 있으면 trim해서 찾습니다. 없거나 계획이 없으면 다음 결함 하나를 **돌려줍니다**(거부가 아님).
     ```
     1 quality-gate error(s):
       goalId [unknown_goal]: Unknown ultragoal goal <id>
     ```
  4. `goal_id`가 없으면 `currentGoal`, 곧 파일 순서의 첫 `pending`/`active`/`failed` 목표를 씁니다. active 목표보다 앞에 `pending` 목표가 있으면 그 목표를 판정합니다.
  5. 계획이나 목표가 없으면 목표별 gate로, 기준 ID 없이 모양만 검사합니다.
  6. 그 밖에는 `completionView(file, goal.id)`의 영수증 종류와 `activeCriterionIds`로 `validateGate`를 돌립니다. `checkpoint(complete)`와 같은 함수와 같은 종류 선택입니다.
- **보지 않는 것**: 목표의 시작 상태(`pending` 목표도 판정합니다), `evidence`, 진행 목록.
- **읽는 것**: `goals.json`.
- **쓰는 것**: 없음. reconcile도 없습니다. 테스트 "validate_gate judges like checkpoint and writes nothing"이 `goals.json`, 원장, mode-state, 행, 감사 로그가 그대로임을 확인합니다.
- **결과**: `renderGateDiagnostics`가 만듭니다. `Error: ` 접두어는 없습니다.
  ```
  quality gate is valid.
  ```
  ```
  <N> quality-gate error(s):
    <path> [<code>]: <message>
  ```

**SKILL과의 차이**: SKILL은 `validate_gate`가 `checkpoint(status: "complete")`와 "exactly the same rules"를 쓴다고 합니다. 코드에서 같은 것은 gate 규칙과 목표별/최종 선택까지입니다. 시작 상태, `evidence`, 진행 목록 검사는 `checkpoint`에만 있습니다.

## `add` / `revise` / `supersede`

계획을 바꿉니다. 대상은 목표나 기준 하나입니다. 세 op 모두 `steerTx(tx, owner, op, args)`가 맡습니다(D-AG6, C-15). gjc의 `steer` 여섯 종류를 `target`과 `after`로 대신합니다(편차 4, 38). gjc 출처는 steering 문구와 상태 검사, steering op들입니다. gjc의 `steering_rejected`는 옮기지 않았으므로 거부된 변경은 아무것도 쓰지 않습니다(PQ-16 C).

### 공통 앞부분

1. `reason`이 있으면 거부합니다(「E3」).
   ```
   ultragoal <op> takes rationale, not reason (reason is for handoff)
   ```
2. `requirePlanTx`: `NO_PLAN`이나 `goals.json is invalid: …`.
3. `target`: `target is required for ultragoal <op>`.
4. `rationale`: `checkSubstantive`, 최대 2000자. 예: `rationale must be a non-empty string`, `rationale must be substantive: at least 5 words and 32 characters`.
5. `evidence`: `checkSubstantive`, 최대 4000자.

이후 계획 사본을 바꾸고, 바꾼 목표의 `amendments`에 변경 기록(amendment) 하나를 더합니다. amendment는 `{target, kind, criterionId?, replacementId?, original?, replacement?, after?, rationale, evidence, timestamp}`입니다. 목표 대상이면 `original`/`replacement`에 목표 정의 `{"title":…,"description":…}`의 JSON 문자열이, 기준 대상이면 기준 문장이 들어갑니다.

### 허용 상태

`src/ultragoal-runtime/plan.ts`의 `ALLOWED_STATUSES`가 정합니다(편차 27, 38, PQ-26 A).

| 변경 | 규칙 이름 | 허용되는 목표 상태 |
|---|---|---|
| 목표 `add` | `add-goal` | 검사 없음 (`after` 대상은 어떤 상태든) |
| 목표 `revise`(title/description) | `revise-goal` | `pending` |
| 목표 `revise`(`after`로 이동) | `move-goal` | `pending` |
| 목표 `supersede` | `supersede-goal` | `pending`, `blocked`, `review_blocked` |
| 기준 `add`/`revise`/`supersede` | `add-criterion` 등 | `pending` |

상태가 맞지 않으면 `planChangeStatusRefusal`로 거부합니다. 문구 끝에 다시 여는 방법이 붙습니다.

```
ultragoal <op> (<target>) requires goal <id> status <허용 상태를 " or "로 이음>; found <현재 상태>. To change it, reopen it first with ultragoal checkpoint(goal_id: "<id>", status: "pending", evidence), change it, then run ultragoal next and checkpoint it again.
```

그래서 `complete` 목표는 `revise`, `supersede`, 기준 `add`/`revise`/`supersede`를 모두 거부합니다(테스트 "completed goal refuses revise and supersede"). 예:

```
Error: ultragoal supersede (goal) requires goal G001 status pending or blocked or review_blocked; found complete. To change it, reopen it first with ultragoal checkpoint(goal_id: "G001", status: "pending", evidence), change it, then run ultragoal next and checkpoint it again.
```

### `add`, `target: "goal"`

새 목표를 넣습니다.

- **입력**: `title`, `description`, `acceptanceCriteria[]`, `after`(선택), `rationale`, `evidence`. `goal_id`는 쓰지 않습니다.
- **검사 순서**:
  1. 목표가 이미 999개면 `at most 999 goals`.
  2. `after`를 trim합니다.
  3. 새 ID는 `nextGoalId`로 정합니다. 기존 최대 번호 + 1입니다. `G999`를 넘으면 `goal IDs are exhausted (G999)`로 거부합니다.
  4. 새 목표를 만들며 `title`(200자), `description`(2000자), `acceptanceCriteria`(`checkCriteria`)를 검사합니다. 새 목표는 `pending`이고 기준은 `<id>.AC1…`입니다.
  5. amendment `{target: "goal", kind: "added", replacement: <목표 정의 JSON>, after?, rationale, evidence, timestamp}`를 새 목표에 넣습니다.
  6. `insertAfter`: `after`가 있으면 그 목표 바로 뒤에, 없으면 끝에 넣습니다. `after`가 없는 ID면 `after references unknown goal id <after>`로 거부합니다. 빈 문자열 `after`도 이 문구로 거부됩니다.
- **맨 앞에는 못 넣음**: 어떤 호출도 목표를 맨 앞에 넣지 못합니다(IQ-1 B). `G001` 앞에 두려면 넣은 뒤 `G001`을 그 뒤로 옮깁니다.
- **결과 ID**: 새 목표 ID.

### `revise`, `target: "goal"`

목표의 제목·설명을 바꾸거나 위치를 옮깁니다.

- **입력**: `goal_id`, `title`/`description`/`after` 중 하나 이상, `rationale`, `evidence`.
- **검사 순서**:
  1. `goalOf`: `goal_id is required for ultragoal revise`, `No ultragoal goal found for <id>.`.
  2. `title`, `description`, `after`가 모두 없으면 `ultragoal revise (goal) needs title, description or after`.
  3. `title`이나 `description`이 있으면 `revise-goal` 상태 검사(`pending`).
  4. `after`가 있으면(trim) `move-goal` 상태 검사(`pending`).
  5. 바꾸기 전 정의를 `original`로 잡은 뒤 `title`(200자), `description`(2000자)을 검사하고 바꿉니다.
  6. amendment `{target: "goal", kind: "revised", original, replacement, after?, rationale, evidence, timestamp}`를 넣습니다.
  7. `after`가 있으면 `moveAfter`로 옮깁니다. 거부 문구는 `after cannot name the goal being moved (<id>)`, `after references unknown goal id <after>`입니다.
- **결과 ID**: 그 목표 ID.

### `supersede`, `target: "goal"`

목표를 더 이상 필요 없는 것으로 표시합니다.

- **입력**: `goal_id`, `rationale`, `evidence`.
- **검사 순서**:
  1. `goalOf`.
  2. `supersede-goal` 상태 검사(`pending`, `blocked`, `review_blocked`).
  3. 이 목표를 빼면 필수 목표가 하나도 안 남으면(`isOnlyRequiredGoal`, gjc `mark_blocked_superseded`) 거부합니다.
     ```
     ultragoal supersede cannot supersede <id> because it is the only remaining required goal
     ```
- **바뀌는 것**: 목표의 `status: "superseded"`, `evidence: <입력 evidence>`. amendment `{target: "goal", kind: "superseded", original, rationale, evidence, timestamp}`를 넣습니다.
- **남는 것**: 목표는 `goals.json`에 남고, 일정에서만 빠집니다.
- **결과 ID**: 그 목표 ID.

### `target: "criterion"`

세 op 모두 `goal_id`가 필요하고, 목표는 `pending`이어야 합니다. 상태 검사가 `criterion_id` 검사보다 먼저입니다.

- **`add`**:
  - **입력**: `goal_id`, `criterion`, `rationale`, `evidence`.
  - **검사**: `criterion`(2000자)을 검사합니다. 같은 문장이 이미 있으면 `<goal id> already has this criterion`으로 거부합니다.
  - **바뀌는 것**: 새 ID `nextCriterionId(goal)`로 기준을 끝에 더합니다. amendment는 `{target: "criterion", kind: "added", criterionId: <새 ID>, replacement: <문장>, …}`입니다.
  - **결과 ID**: 새 기준 ID.
- **`revise`**:
  - **입력**: `goal_id`, `criterion_id`, `criterion`, `rationale`, `evidence`.
  - **검사**: `criterion_id`를 검사합니다(`criterion_id is required for ultragoal revise`). 현재 기준에 없으면 `<criterion id> is not an active criterion of <goal id>`로 거부합니다. 이어서 `criterion`을 검사하고, **다른** 기준과 문장이 같으면 `<goal id> already has this criterion`으로 거부합니다.
  - **바뀌는 것**: 같은 자리의 기준을 새 ID `nextCriterionId(goal)`와 새 문장으로 바꿉니다. 옛 ID는 은퇴하고 다시 쓰지 않습니다(PQ-22 A, 편차 2). amendment는 `{target: "criterion", kind: "revised", criterionId: <옛 ID>, replacementId: <새 ID>, original, replacement, …}`입니다.
  - **결과 ID**: 새 기준 ID.
  - **예**: 기준이 `G001.AC1`, `G001.AC2`인 목표에서 `G001.AC1`을 고치면 새 ID는 `G001.AC3`입니다(테스트 "criteria are named by criterion_id …"). 새 번호는 이 목표가 쓴 가장 큰 번호 + 1이므로, 기준이 `G001.AC1` 하나뿐이었다면 `G001.AC2`가 됩니다.
- **`supersede`**:
  - **입력**: `goal_id`, `criterion_id`, `rationale`, `evidence`.
  - **검사**: `criterion_id`를 검사합니다(`criterion_id is required for ultragoal supersede`). 현재 기준에 없으면 `<criterion id> is not an active criterion of <goal id>`로 거부합니다. 그다음 기준이 하나뿐이면 거부합니다.
    ```
    cannot supersede the last active criterion of <goal id>; use revise to replace it, or supersede the goal if it is no longer needed
    ```
  - **바뀌는 것**: 그 기준을 목록에서 뺍니다. amendment는 `{target: "criterion", kind: "superseded", criterionId, original, …}`입니다.
  - **결과 ID**: 뺀 기준 ID.

새 기준 번호는 활성 기준과 amendment의 `criterionId`·`replacementId`에 나온 모든 번호보다 큽니다(`nextCriterionId`).

### 쓰는 것과 결과

- **쓰기**:
  - `goals.json`: 바뀐 계획과 `updated_at`.
  - 원장 `steering_accepted`:
    ```json
    {"eventId": "…", "event": "steering_accepted", "kind": "add|revise|supersede", "target": "goal|criterion", "goalId": "G00x", "criterionId": "…", "after": "…", "rationale": "…", "evidence": "…", "amendment": {…}, "timestamp": "…"}
    ```
    `criterionId`는 기준 대상일 때만 있습니다. `add`는 새 ID, `revise`와 `supersede`는 옛 ID입니다. `after`는 값이 있을 때만 있습니다.
  - reconcile.
- **영향**:
  - 기준을 바꾸면 그 목표의 기준 해시(`criteriaRevision`)가 달라집니다. 다시 연 목표의 이전 영수증은 `stale`이 됩니다.
  - 목표 `add`와 `supersede`는 필수 목표 집합의 변화입니다. 이전 final 영수증을 per-goal 완료로 낮춥니다.
  - 자세한 규칙은 [gates-and-receipts.md](gates-and-receipts.md)에 있습니다.
- **결과**: `renderSteering`이 만듭니다.
  ```
  Accepted <op> steering. target=<결과 ID>
  ```

**코드와 SKILL의 경계**:

- **코드가 강제하는 것**: `rationale`/`evidence`의 5단어·32자 규칙, 허용 상태, 마지막 필수 목표와 마지막 기준 보호.
- **SKILL만 요구하는 것**: 실제 발견이 계획 변경을 증명할 때만 쓸 것, 실행 목표와 원래 제약을 바꾸지 말 것.

## `add_pattern`

진행 메모의 Codebase Patterns 절에 한 줄을 더합니다. `addPatternTx`가 맡습니다. 형식은 OMC `addPattern`(`src/hooks/ralph/progress.ts`, v5.4.0)을 따릅니다. reconcile하지 않는 것은 편차 1(PQ-25 B)입니다.

- **입력**: `pattern`.
- **검사 순서**:
  1. `pattern`: `pattern must be a non-empty string`, `pattern exceeds 500 characters`.
  2. trim한 값에 `\r`이나 `\n`이 있으면 `pattern must be a single line`. 앞뒤 줄바꿈은 trim에서 사라지므로 통과합니다.
  3. 진행 메모가 없으면 `no progress.txt yet; call ultragoal create first`.
  4. `addProgressPattern`: 자리표시 `(No patterns discovered yet)` 줄을 지웁니다. `## Codebase Patterns` 뒤 첫 `---` 앞에 `- <pattern>`과 빈 줄을 넣습니다. 절이 없으면 `progress.txt has no Codebase Patterns section`으로 거부합니다.
- **읽는 것**: 진행 메모. `goals.json`은 보지 않습니다.
- **쓰는 것**: 진행 메모(감사 `artifact`/`write`). 원장 행은 없고 reconcile도 없습니다. 테스트 "add_pattern leaves the row"가 mode-state와 행이 그대로임을 확인합니다.
- **결과**:
  ```
  Pattern added to progress.txt.
  ```

**SKILL만 요구하는 것**: 남길 가치가 있는 패턴을 기록할 것.

## `record_review_blockers`

리뷰 blocker를 기록합니다. 리뷰된 목표를 `review_blocked`로 바꾸고, 그 blocker를 고칠 수정 목표(fix goal)를 하나 더합니다. `recordReviewBlockersTx`가 맡습니다(DR-6). gjc 출처는 `recordUltragoalReviewBlockers`(기본 제목, 상한보다 먼저 하는 중복 검사), `findOpenReviewBlockerGoal`, `countUnresolvedReviewBlockerDescents`입니다. `goals.json`을 한 번에 쓰는 것은 편차 36, 기준을 하나 자동으로 만드는 것은 편차 40(PQ-17 C)입니다.

- **입력**: `goal_id`(막힌 목표), `objective`, `evidence`, `title`(선택).
- **검사 순서**:
  1. `objective`를 trim합니다. 비었으면 `record_review_blockers objective is required`로 거부합니다.
  2. 1972자를 넘으면 거부합니다(E-24).
     ```
     objective exceeds 1972 characters; the fix goal's criterion "<objective> is resolved and re-verified" must fit 2000
     ```
  3. `requirePlanTx`: `NO_PLAN`이나 `goals.json is invalid: …`.
  4. `goal_id`: `goal_id is required for ultragoal record_review_blockers`. 값은 trim합니다.
  5. **중복 검사**: `findOpenReviewBlockerGoal(file, objective)`가 먼저 조건에 맞는 수정 목표를 찾습니다. 조건은 셋입니다: `steering.kind`가 `review_blocker`이고, 끝나지 않았고(`complete`/`superseded`가 아님), trim한 `description`이 `objective`와 같아야 합니다.
     - 찾은 첫 목표의 `steering.blockedGoalId`가 이번 `goal_id`와 같으면 아무것도 쓰지 않고 reconcile한 뒤 그 목표 ID로 성공 문구를 돌려줍니다.
     - 이 경로는 `evidence`와 `title`을 검사하지 않습니다. `evidence` 없이 불러도 성공합니다(임시 폴더에서 확인).
     - 같은 objective의 첫 목표가 다른 목표를 막고 있으면 중복으로 보지 않습니다.
  6. **상한**: `goal_id`를 막는 끝나지 않은 수정 목표가 이미 3개(`MAX_REVIEW_BLOCKER_DESCENTS`) 이상이면 거부합니다. 개수는 `goals.json`에서 셉니다.
     ```
     review_blocker_recursion_cap: goal <id> already has <n> unresolved review_blocker descents (cap=3). Record a human pause/escalation or resolve existing blockers before recording more. Unresolved technical findings are never auto-completed.
     ```
  7. `goalOf`: `No ultragoal goal found for <id>.`. 상한 검사 뒤에 합니다.
  8. `evidence`: 비었으면 `checkpoint evidence is required`(이 op에서도 같은 문구), 4000자를 넘으면 `evidence exceeds 4000 characters`.
  9. `title`: 없거나 공백뿐이면 기본값 `Resolve final code-review blockers`(`FIX_GOAL_DEFAULT_TITLE`). 아니면 200자 검사.
  10. 새 ID `nextGoalId`. `goal IDs are exhausted (G999)`가 날 수 있습니다.
- **상태 검사 없음**: 막힌 목표의 상태는 검사하지 않습니다(`record-review-blockers` 규칙은 모든 상태). `complete`나 `superseded` 목표도 받고, 수정 목표도 막힌 목표가 될 수 있습니다(수정 목표의 수정 목표).
- **바뀌는 것** (`goals.json` 한 번 쓰기):
  - 막힌 목표: `status: "review_blocked"`, `evidence`. 영수증은 그대로 둡니다.
  - 수정 목표를 **목록 끝에** 더합니다.
    ```json
    {
      "id": "G00x",
      "title": "<title 또는 Resolve final code-review blockers>",
      "description": "<trim한 objective>",
      "status": "pending",
      "acceptanceCriteria": [{ "id": "G00x.AC1", "text": "<objective> is resolved and re-verified" }],
      "amendments": [],
      "steering": { "kind": "review_blocker", "blockedGoalId": "<goal_id>" }
    }
    ```
  - 파일의 `updated_at`.
- **원장** (두 행):
  - `{eventId, event: "goal_checkpointed", goalId: <막힌 목표>, status: "review_blocked", evidence, completionVerification?, timestamp}`. 막힌 목표에 영수증이 있을 때만 `completionVerification`이 붙습니다. `qualityGateJson`은 없습니다.
  - `{eventId, event: "review_blockers_recorded", goalId: <막힌 목표>, blockerGoalId: <수정 목표>, timestamp}`
- 마지막에 reconcile합니다.
- **결과**:
  ```
  Recorded review blockers. blocker-goal-id=<수정 목표 id>
  ```
- **이후**: 수정 목표를 완료하면 `checkpoint`가 부모를 `superseded`로 바꿉니다([위](#status-complete)). 수정 목표 연쇄와 상한이 연쇄를 멈추지 않는 이유는 [gates-and-receipts.md](gates-and-receipts.md)에 있습니다.

**SKILL만 요구하는 것**: cohort 전체의 발견을 한 번에 모아 기록할 것. 완료 쪽 `ITERATE`/`REJECT`는 먼저 `record_critic_verdict`로 기록할 것.

## `classify_blocker`

blocker의 분류를 원장에 한 줄 남깁니다. `classifyBlockerTx`가 맡습니다(DR-7). gjc 출처는 `recordUltragoalBlockerClassification`입니다.

- **입력**: `classification`(`resolvable` 또는 `human_blocked`), `evidence`, `goal_id`(선택).
- **검사 순서**:
  1. `evidence`를 trim합니다. 비었으면 `classify_blocker evidence is required`, 4000자를 넘으면 `evidence exceeds 4000 characters`.
  2. `classification`: `classification is required for ultragoal classify_blocker`.
- **검사하지 않는 것**: `goal_id`가 `goals.json`에 있는지 보지 않습니다. 계획이 있어야 한다는 검사도 없습니다.
- **읽는 것**: 없음. reconcile에서만 읽습니다.
- **쓰는 것**:
  - 원장 `{eventId, event: "blocker_classified", classification, goalId?, evidence, timestamp}`. `goalId`는 trim한 값이 있을 때만 붙습니다.
  - reconcile. 계획이 없으면 reconcile이 mode-state를 `missing`으로 씁니다.
- **결과**: event-id는 방금 쓴 행의 `eventId`입니다.
  ```
  Recorded blocker classification: <classification> event-id=<eventId>.
  ```
- **이 행을 읽는 곳**: `record_critic_verdict`의 pause 결합 검사(아래)와 `goal pause`의 관문([goal-loop.md](goal-loop.md))이 이 행을 읽습니다. `resolvable`은 기록일 뿐 pause를 허락하지 않습니다.

**SKILL만 요구하는 것**:

- blocker마다 먼저 분류할 것
- 모르면 `resolvable`로 할 것
- `create` 전에는 부르지 말 것. 코드는 막지 않고, 부르면 reconcile이 `goal-planning`을 `missing`으로 끝냅니다.

## `record_critic_verdict`

terminal critic의 판정을 원장에 한 줄 남깁니다. `recordCriticVerdictTx`가 맡습니다(DR-8). gjc 출처는 `recordUltragoalCriticVerdict`입니다. 연속 횟수는 편차 18(PQ-3)로, gjc의 실행 전체 누적이 아니라 연속으로 셉니다. 멈추게 하는 행(hard stop)이나 무시 행(override)은 없습니다(D-VF9).

- **입력**: `terminus`, `verdict`, `evidence`, `blockers[]`(선택, 기본 `[]`), `classification_event_id`(`pause`에서 필수), `goal_id`(선택).
- **검사 순서**:
  1. `evidence`를 trim합니다. 비었으면 `record_critic_verdict evidence is required`, 4000자를 넘으면 `evidence exceeds 4000 characters`.
  2. `terminus`: `terminus is required for ultragoal record_critic_verdict`.
  3. `verdict`: `verdict is required for ultragoal record_critic_verdict`.
  4. `blockers`의 항목마다 `checkText`(2000자). 예: `blockers[0] must be a non-empty string`.
  5. `verdict`가 `OKAY`인데 `blockers`가 있으면 `OKAY critic verdict must have empty blockers`.
  6. `terminus`가 `pause`인데 `classification_event_id`가 없으면(trim) `record_critic_verdict classification_event_id is required for pause verdicts`. `verdict`와 상관없이 검사합니다.
  7. `readPlanTx`: 계획이 없으면 `record_critic_verdict requires an active ultragoal plan`. 문구와 달리 계획이 있고 유효한지만 보고, 실행 상태는 보지 않습니다. 깨진 파일은 `goals.json is invalid: …`로 거부합니다.
  8. `readLedgerTx`: `ledger.jsonl is invalid: …`.
  9. **pause 결합 검사**: `pause`면 원장 전체에서 가장 최근의 `blocker_classified` 행을 찾습니다. 그 행이 `human_blocked`이고 `eventId`가 `classification_event_id`와 같아야 합니다. 아니면 거부합니다.
     ```
     record_critic_verdict pause requires classification_event_id to name the latest human_blocked classification
     ```
- **검사하지 않는 것**:
  - `completion`에 준 `classification_event_id`는 결합 검사 없이 행에 적힙니다.
  - `goal_id`가 있는지 보지 않습니다.
  - `ITERATE`/`REJECT`에 `blockers`가 비어 있어도 받습니다.
- **읽는 것**: `goals.json`, 원장, `goal-state.json`, `state/goal-continuation.json`. 뒤의 둘은 연속 횟수를 계산하는 데만 씁니다.
- **쓰는 것**:
  - 원장 `{eventId, event: "critic_verdict", terminus, verdict, evidence, blockers, classificationEventId?, goalId?, timestamp}`
  - reconcile
- **결과**: `renderCriticVerdict`가 만듭니다.
  ```
  Recorded critic verdict: <verdict> (<terminus>).
  critic non-OKAY streak: <n>/5
  ```
  `n`이 5 이상이면 둘째 줄 끝에 ` — continuation held`가 붙습니다.
- **연속 횟수 계산**: `criticNonOkayStreak([...기존 행, 새 행], resetAfter)`로 셉니다.
  - `resetAfter`는 보이는 goal이 있고 continuation 기록의 `goal_id`가 그 goal의 `id`와 같을 때만 그 기록의 `critic_reset_after`입니다(`continuationForGoal`). `goal_id`가 다르거나 기록이 없거나 읽을 수 없으면, 해제 표식이 없는 새 기록으로 보고 `resetAfter`는 없습니다. 보이는 goal이 없을 때도 없습니다.
  - 세는 규칙은 [gates-and-receipts.md](gates-and-receipts.md)에 있습니다. 보류를 실제로 거는 곳은 goal 훅입니다([goal-loop.md](goal-loop.md)). 이 op는 기록과 문구만 맡습니다.

**SKILL만 요구하는 것**:

- 완료 쪽 `ITERATE`/`REJECT`는 `record_review_blockers`보다 먼저 기록할 것("the leader MUST first record the terminal verdict")
- critic을 실제로 read-only로 돌릴 것

## `handoff`

ultragoal을 ralplan이나 deep-interview로 넘깁니다. `handoffTx`가 맡고, 실제 인계는 두 방향이 함께 쓰는 `src/skill-state/handoff.ts`의 `handoffWorkflowTx`가 합니다(계획 C-5). 저널, 병합, 행, 체인 가드는 [entry-and-handoff.md](entry-and-handoff.md)에 있습니다. gjc 출처는 `gjc-runtime/state-runtime.ts`의 handoff입니다. 원장 행과 `HANDOFF` 메모는 편차 39입니다.

- **입력**: `to`(`ralplan` 또는 `deep-interview`), `reason`.
- **검사 순서**:
  1. `to`: `to is required for ultragoal handoff`.
  2. `reason`을 trim합니다. 비었으면 `reason is required (a non-empty string)`.
  3. `handoffWorkflowTx`의 검사:
     - ultragoal mode-state 파일이 없으면 `ultragoal handoff: caller is not active (no mode-state file at <path>)`.
     - 두 mode-state 중 하나가 깨졌으면 `existing state for <skill> is corrupt or tampered (<error>); refusing to hand off`.

  여기까지의 거부는 아무것도 쓰기 전에 일어납니다.
- **쓰기 도중의 실패 (행 파일)**: 행 단계(`src/skill-state/rows.ts`의 `writeHandoffRowsTx`)는 저널과 두 mode-state를 쓴 뒤에 행 파일을 읽고, 깨진 JSON이면 예외를 그대로 던집니다.
  - **어디서 던지나**: 호출자의 이전 행(`state/active/ultragoal.json`)은 `readRowTx`가 읽습니다. 이 행이 깨졌으면 행을 쓰기 전에 던집니다. 스냅숏 재생성의 `readRowsTx`는 `state/active/`의 모든 `.json`을 읽습니다. 다른 행이 깨졌으면 두 행을 쓴 뒤에 던집니다.
  - **결과 문구**: JSON 파서의 메시지가 그대로 나옵니다. 예: `Error: JSON Parse error: Expected '}'`.
  - **남는 것**: `pending` 저널이 `state/transactions/`에 남습니다. ultragoal은 이미 `active: false`, `current_phase: "handoff"`이고 callee state도 쓰여 있습니다. `workflow_handoff` 원장 행과 `HANDOFF` 메모는 없습니다.
  - 임시 폴더에서 `state/active/other.json`을 깨뜨려 재현했습니다. 이때 ultragoal 행(`active: false`, `phase: "handoff"`)과 ralplan 행도 이미 쓰여 있었습니다. 저널을 되돌리는 코드는 없습니다([entry-and-handoff.md](entry-and-handoff.md)).
- **검사하지 않는 것**: ultragoal의 `active`, 단계, 계획 유무. 코드에 이 검사가 없으므로 mode-state 파일만 있으면 비활성 state(예: `missing`, `complete`)에서도 인계합니다. 임시 폴더에서는 비활성 `missing` 상태에서 ralplan 인계가 되는 것을 확인했습니다. `ralplan handoff`가 비활성 ralplan을 거부하는 것(R-OD18)과 다릅니다.
- **쓰는 것**: `handoffWorkflowTx`가 순서대로 씁니다.
  1. 저널
  2. callee mode-state: 활성, 첫 단계, `handoff_from`
  3. ultragoal mode-state: `active: false`, `current_phase: "handoff"`, `handoff_to`
  4. 행과 스냅숏
  5. `recordCaller` 단계로 원장 `{eventId, event: "workflow_handoff", to, reason, timestamp}`과 진행 메모의 `HANDOFF` 메모. 진행 메모가 없으면 머리글부터 만듭니다.
     ```

     ## [2026-09-30 00:00] - HANDOFF

     **Reason:**
     - to <to>: <reason>

     ---
     ```
  6. 저널 완료

  goal은 건드리지 않습니다. reconcile도 하지 않습니다.
- **결과**: 한 줄 JSON입니다. `phases.to`는 ralplan이면 `planner`, deep-interview면 `interviewing`입니다.
  ```json
  {"ok":true,"from":"ultragoal","to":"<to>","handoff_at":"<at>","mutation_id":"ultragoal:handoff:<to>:<at>","phases":{"from":"handoff","to":"<callee 첫 단계>"},"paths":{"from":"<ultragoal-state.json>","to":"<callee state 파일>","active_state":"<skill-active-state.json>"}}
  ```

**SKILL만 요구하는 것**: 인계 뒤 `skill ralplan`(또는 `deep-interview`)을 로드할 것. 계획하는 동안 ultragoal op를 부르지 말 것([reconcile](#reconcile)의 알려진 동작).

## `doctor`

ultragoal의 mode-state, 활성 행, 스냅숏을 검사해 gjc doctor 문구로 돌려줍니다. `doctorTx`가 `src/skill-state/doctor.ts`의 `collectDoctorSummaryTx(tx, "ultragoal")`와 `renderDoctorText`를 부릅니다(DR-15). 검사 종류와 `fix=` 명령은 [state-and-files.md](state-and-files.md)에 있습니다.

- **입력**: 없음.
- **거부**: 없습니다. 발견한 문제는 결과로 알립니다(테스트 "P-AC8"의 주석).
- **읽는 것**: mode-state, 활성 행, 스냅숏. `goals.json`과 원장은 보지 않습니다.
- **쓰는 것**: 없음. reconcile도 없습니다.
- **결과**: 끝에 줄바꿈이 있습니다.
  ```
  ok: <true|false>
  root: <state 폴더 절대 경로>
  skills_scanned: 1
  files_scanned: <n>
  findings_total: <n>
  counts: schema_violation=<n>, stale_active_state=<n>
  finding: kind=<kind> skill=ultragoal path=<path> message=<message> fix=<ultragoal clear | ultragoal clear (force: true)>
  ```
  `finding:` 줄은 문제마다 하나씩 붙습니다.

## `state`

ultragoal mode-state에 필드를 병합합니다. `patchStateTx`가 맡습니다(PQ-1 A). gjc의 열린 병합(`handleWrite`, `mergeWithNullDelete`)이지만, 파생 필드를 거부하고 `--force`가 없습니다(편차 25).

- **입력**: `patch`(객체). 값이 `null`인 키는 지웁니다.
- **검사 순서**:
  1. `patch`: `patch is required for ultragoal state`.
  2. mode-state가 깨졌으면 거부합니다.
     ```
     existing state for ultragoal is corrupt or tampered (<error>); reset it with `ultragoal clear` and force: true
     ```
  3. `patch`의 `_meta`는 조용히 버립니다.
  4. 파생 필드가 있으면 거부합니다(`derivedFieldPatchError`). 대상은 `goals`, `counts`, `status`, `active_goal_id`, `goals_path`, `ledger_path`, `progress_path`, `latestLedgerEvent`, `skill`, `version`, `session_id`입니다.
     ```
     state patch cannot set derived ultragoal field(s): <keys>; the next ultragoal op rewrites them from goals.json and the ledger
     ```
  5. 기존 state 위에 `patch`를 병합한 결과를 `workflowEnvelopeError`로 검사합니다. 예: `state.active must be a boolean when present`, `state.current_phase must be a string when present`.
  6. 목표 단계를 정합니다.
     - `patch.current_phase`, 없으면 `patch.phase`(trim)
     - 없으면 병합 결과의 `current_phase`, 저장된 단계, `goal-planning` 순서
     - `patch.phase`를 쓰면 `phase` 키도 state에 그대로 남습니다.
  7. 단계 검사(`ultragoalPhasePatchError`):
     - 목표 단계가 manifest 단계가 아니면 `unknown ultragoal phase "<phase>"`
     - 저장된 단계가 manifest 단계이고 전이 표에 없는 이동이면 `invalid ultragoal phase transition from <from> to <to>`
     - 전이 표는 [state-and-files.md](state-and-files.md)에 있습니다.
  8. 채운 값으로 envelope을 다시 검사합니다.
  9. 크기 검사: `tx.writeModeState`가 부르는 `src/state.ts`의 `writeMerged`가 쓰기 전에 `payloadError`로 검사합니다. 아래 경우 아무것도 쓰지 않고 거부합니다. 한도는 [state-and-files.md](state-and-files.md)에 있습니다.
     - `_meta`를 뺀 최상위 키가 100개 초과: `state exceeds 100 top-level keys`
     - 중첩 깊이가 10 초과: `state exceeds nesting depth 10`
     - JSON 크기가 1 MiB 초과: `state exceeds 1048576 bytes`
     - JSON으로 바꿀 수 없음: `state is not JSON serializable`
- **채우는 값**: `skill: "ultragoal"`, `current_phase`, `version: 2`, `updated_at`. `active`가 boolean이 아니면 `true`, `session_id`가 문자열이 아니면 owner 세션 ID를 넣습니다. state 파일이 없던 경우에도 이렇게 새로 만듭니다.
- **쓰는 것**:
  - mode-state: 작성자 `ultragoal_tool`, 감사 `state`/`write`, `mutationId: "ultragoal:<at>"`, `fromPhase`/`toPhase`
  - 행과 스냅숏: `syncActiveRowTx`로 씁니다. `active`가 `false`가 아니면 행을 쓰고, `false`면 지웁니다. 이 단계의 실패는 무시합니다(gjc state 동사의 HUD 동기화와 같음).
  - reconcile은 하지 않습니다. 다음 reconcile하는 op가 `current_phase`와 `active`를 `goals.json`에서 다시 씁니다.
- **결과**:
  ```json
  {"ok":true,"skill":"ultragoal","state_path":"<ultragoal-state.json>","current_phase":"<phase>","active":<bool>,"mutation_id":"ultragoal:<at>"}
  ```

## `clear`

ultragoal state를 끝난 상태로 바꿉니다. `clearStateTx`가 맡습니다(DR-14). gjc 출처는 `handleClear`와 `describeStaleClearState`입니다. gjc `state clear --force --mode ultragoal`을 op로 옮긴 것이 편차 25입니다.

- **입력**: `force`(선택, `true`일 때만 켜짐).
- **검사 순서** (`force`가 없을 때):
  1. mode-state가 깨졌으면 거부합니다. `force`면 빈 state로 보고 계속합니다.
     ```
     existing state for ultragoal is corrupt or tampered (<error>); use force: true to overwrite
     ```
  2. 오래된 state 검사(`describeStaleClearTx`):
     - **종료 단계**: 저장된 단계가 `complete`, `completed`, `failed`, `cancelled`, `canceled`면 이유는 `mode-state is already terminal (<phase>)`입니다. `inactive`는 여기서 빠집니다.
     - **행을 못 읽음**: 활성 행 파일을 읽을 수 없으면 바로 `active row <path> is unreadable (<error>); use force: true to clear`로 거부합니다.
     - **단계 불일치**: 비교할 항목을 먼저 고릅니다. 활성 행 `state/active/ultragoal.json`이 객체이고 `skill`이 `ultragoal`이면 그 행 자체를 씁니다. 행이 없거나 ultragoal 행이 아니면 스냅숏 `active_skills`의 ultragoal 항목을 씁니다. 그 항목이 활성(`active !== false`)이고, 그 `phase`와 저장된 단계가 둘 다 있는데 서로 다르면 이유는 `active-state phase <항목 phase> differs from mode-state phase <phase>`입니다.
     - 이유가 있으면 다음 문구로 거부합니다.
       ```
       existing state for ultragoal is stale (<reason>); use force: true to clear
       ```
- **`failed` 단계의 경우**: reconcile은 active 목표 없이 `failed` 목표가 있으면 실행 상태를 `failed`, `active: true`로 씁니다. 그래서 진행 중인 run도 `force` 없이는 지울 수 없습니다(임시 폴더에서 확인).
- **state 파일이 없을 때**: 거부하지 않고 새 state를 만듭니다.
- **읽는 것**: mode-state. `force`가 없으면 활성 행과 스냅숏도 읽습니다. `goal-state.json`은 읽기 오류가 나도 goal이 없는 것으로 봅니다.
- **쓰는 것**:
  - mode-state: `{skill: "ultragoal", ...기존 필드, active: false, current_phase: "complete", updated_at, version: 2}`. 작성자는 `ultragoal_tool`입니다. 감사 `state`/`clear`에는 `mutationId: "ultragoal:clear:<at>"`, `fromPhase`, `toPhase: "complete"`, `forced: <force>`가 들어갑니다.
  - 행 삭제와 스냅숏 재생성: `syncActiveRowTx`에 `active: false`를 넘깁니다. 실패는 무시합니다.
- **남는 것**: `goals.json`, 원장, 진행 메모는 그대로 둡니다. goal도 그대로입니다(I-10).
- **결과**:
  ```json
  {"ok":true,"skill":"ultragoal","state_path":"<ultragoal-state.json>","active":false,"current_phase":"complete","mutation_id":"ultragoal:clear:<at>"}
  ```
  goal이 열려 있으면(`active`/`paused`) 둘째 줄이 붙습니다.
  ```
  The goal is still <status>; run goal drop to end it.
  ```
- **다시 시작하기**: `start` op는 없습니다. `skill ultragoal`을 다시 로드해 `goal-planning`으로 올린 뒤 `create`를 부릅니다([entry-and-handoff.md](entry-and-handoff.md)).

**SKILL만 요구하는 것**: 현재 세션의 state가 깨졌거나 오래됐으면 다시 시작하기 전에 `clear(force: true)`를 부를 것.
