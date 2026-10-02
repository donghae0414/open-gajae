# `deep-interview` 도구의 op

이 문서는 `deep-interview` 도구의 op 8개를 코드 그대로 적습니다. op마다 입력, 검사 순서와 거부 문구, 쓰는 파일과 순서, 감사 행, 결과 모양을 다룹니다. 기준 코드는 [README.md](README.md) 머리에 있습니다. 예시 출력은 기준 코드를 임시 폴더의 `StateStore` 위에서 bun으로 실제로 불러 얻은 것입니다(`tests/deep-interview-tool.test.ts`와 같은 방식). 세션 폴더 절대 경로는 `<session>`, 시각과 해시는 실행마다 다릅니다.

다음 주제는 다른 문서가 맡습니다.

- 봉투의 필드, 병합 규칙, 라운드 검사, 모호도와 하한, 입력 상한, StateStore 한도, 행·스냅숏·감사 행·저널의 모양, HUD 칩, doctor 검사 항목: [state-and-files.md](state-and-files.md)
- 진입, 기준치 결정, 같은 execution의 skill 로드 게이트, ralplan·ultragoal에서 돌아오는 넘기기, 공통 저널 인계의 단계: [entry-and-handoff.md](entry-and-handoff.md)
- 도구 숨김과 역할 권한: [guards-and-continuation.md](guards-and-continuation.md)

## 한눈에 보기

| op | 필요한 상태 | 쓰는 것 (순서대로) | 감사 행 `category/verb` | 결과 |
|---|---|---|---|---|
| `start` | 없음. ralplan·ultragoal이 보이는 주 skill이면 거부 | 상태 → 행 → 스냅숏 | `state/write` | JSON |
| `write` | 활성 | 상태 → 행 → 스냅숏 | `state/write-incremental` 또는 `state/write-reset` | JSON |
| `spec` | 활성 | 스펙 파일 → index 한 줄 → 상태 → 행 → 스냅숏 | `artifact/write`, `ledger/append`, `state/write` | JSON |
| `spec(…, handoff:"ralplan")` | 활성 | `spec`의 것 → ralplan 시드 → 저널 인계 | 위 + ralplan `state/write` + 인계 행들 | 결과 줄 + JSON |
| `handoff` | 활성, phase `handoff`, 확인된 스펙 | 저널 → callee 상태 → deep-interview 상태 → 두 행 → 스냅숏 → 저널 정리 | `state/handoff` 둘 + 저널 행 | 결과 줄 + JSON |
| `status` | 없음 | 없음 | 없음 | JSON (손상이면 경고 줄 하나 더) |
| `doctor` | 없음 | 없음 | 없음 | gjc doctor 텍스트 |
| `state` | 활성 | 상태 → 행 → 스냅숏 | `state/write` | JSON |
| `clear` | 없음 (손상·낡음이면 `force`) | 상태 → 행 삭제 → 스냅숏 | `state/clear` | JSON |

행과 스냅숏을 바꿀 때마다 감사 행이 하나씩 더 남습니다(`state/write-active-entry`, `state/remove-active-entry`, `state/remove-superseded-pipeline-entry`, `state/rebuild-active-snapshot`). 감사 행의 모양은 [state-and-files.md](state-and-files.md)에 있습니다.

## 도구 정의

`src/deep-interview-runtime/tool.ts:90-165`의 `deepInterviewTool`이 도구를 만들고, `src/tools.ts:57-63`의 `createTools`가 등록합니다. 등록할 때 넘기는 것은 넷입니다.

- `rootSession`: `src/hooks.ts:626-658`의 `rootSession`(계보 루트, 실패하면 예외)
- `settings`: `src/config.ts`의 `loadSettings`가 setup 때 한 번 정한 `{ambiguityThreshold, source}`. 없으면 `{0.05, "default"}`(`src/deep-interview-runtime/tool.ts:91`, `store.ts:111-114`)
- `projectDir`: 상대 `spec(path)`의 기준 디렉터리
- `seedRalplanTx`: 결합 호출의 ralplan 시드. `startRunTx(tx, root, input, projectDir, owner)`를 감싼 콜백입니다. 두 런타임이 서로 import하지 않게 여기서 주입합니다(계획 E-7).

**이름과 권한**: 이름도 권한 이름도 `deep-interview`입니다(`tool.ts:115-116`). `src/tools/define.ts`의 `defineTool`이 `options: {codemode: false, permission: "deep-interview"}`로 감쌉니다. 이 권한으로 다른 agent에게서 도구를 숨기는 방법은 [guards-and-continuation.md](guards-and-continuation.md)에 있습니다.

**모델이 보는 설명** (`tool.ts:117-118`):

```
This is the deep-interview state tool, not the skill: load the `deep-interview` skill to run an interview. Ops: start (seed this session's interview), write (merge rounds, facts and context; ambiguity is derived), spec (persist the final spec; handoff: ralplan also seeds ralplan and hands off), handoff (to ralplan or ultragoal after the spec), status, doctor, state (merge patch; phases follow the table; {"active": false} cancels the interview and {"active": true} resumes a cancelled one), clear. The only way to change deep-interview state and specs.
```

**op 목록**: `DEEP_INTERVIEW_OPS`(`tool.ts:44`)가 spec 순서대로 8개를 정합니다. 스키마를 거치지 않고 들어온 다른 이름은 `switch` 끝에서 `unknown op <op>`로 거부됩니다(`tool.ts:162`).

**gjc 출처** (머리말 기준): `gjc-runtime/deep-interview-runtime.ts:873-916`(`runNativeDeepInterviewCommand`: 시드, `--write`), `gjc-runtime/deep-interview-stage.ts:961-1034`(`write`, `read`, `clear`, `handoff` 동사), `gjc-runtime/state-runtime.ts`(state doctor, write, clear). op 도구 모양, 호출자 검사, 루트 세션 해석은 `src/ultragoal-runtime/tool.ts`를 따릅니다. 편차: deep-interview 편차 1(CLI 동사 → op 8개, 소유자는 계보 루트), 2(stage/check/apply/discard 없음), 24(도구는 `open-gajae`만), 38(`spec(…, handoff:"ralplan")`이 `--deliberate`를 대신함, `--force` 없음).

### 입력 스키마

입력은 zod 객체 하나입니다(`tool.ts:57-86`). `op`만 필수이고, 어떤 필드가 필요한지는 op가 실행 중에 검사합니다.

| 필드 | 타입 | 쓰는 op |
|---|---|---|
| `op` | `DEEP_INTERVIEW_OPS` 중 하나 | 전부 |
| `idea` | string | `start` |
| `threshold` | number | `start` (0 < 값 ≤ 1) |
| `input` | 문자열 키 객체 | `write` |
| `reset` | boolean | `write` |
| `content` | string | `spec` |
| `path` | string | `spec` |
| `slug` | string | `spec` |
| `handoff` | `"ralplan"` | `spec` |
| `to` | `"ralplan"` \| `"ultragoal"` | `handoff` |
| `fields` | `STATE_FIELD_ALLOWLIST` 값의 배열 | `status` |
| `patch` | 문자열 키 객체 | `state` |
| `force` | boolean | `clear` |

- op가 쓰지 않는 필드는 조용히 무시합니다.
- `defineTool`이 만든 `execute`는 입력을 다시 파싱하지 않습니다(`src/tools/define.ts`). 그래서 enum 밖의 값이나 객체가 아닌 `input`·`patch`를 스키마가 거르는지는 호스트가 호출 전에 이 스키마를 쓰는지에 달려 있고, 이 문서를 쓰며 호스트로 확인하지 않았습니다. 런타임은 `write`의 `input`(`store.ts:372`)과 `state`의 `patch`(`tool.ts:156`)를 따로 검사합니다. 테스트는 모두 `tool.input.parse`를 먼저 부릅니다.

## 소유 세션과 트랜잭션

### 소유 세션 해석

`tool.ts:94-103`의 `ownerSession`이 모든 op 앞에서 차례로 검사합니다.

1. `context.sessionID`가 비어 있지 않은 문자열인지 봅니다. 아니면 `a native session is required`.
2. `context.agent`가 `open-gajae`인지 봅니다. 아니면 `the deep-interview tool is not available to <agent>`(계획 D-HL7). 패널 역할 `open-gajae-lateral-reviewer`도 여기서 거부됩니다(테스트 T1).
3. `deps.rootSession(sessionID)`로 계보 루트를 찾습니다. 예외가 나면 `could not resolve the session lineage for deep-interview`.

그 결과 자식 세션에서 부른 op도 루트 세션 폴더의 상태를 씁니다. 상태의 `session_id`도 루트 id입니다(테스트 T1).

### 트랜잭션 하나

op마다 `store.workflowTransaction(owner, tx => …)` 하나를 열고, 그 안에서 `store.ts`의 op 함수를 부릅니다. `workflowTransaction`(`src/state.ts:476-578`)은 루트 세션의 쓰기 큐 하나를 잡습니다. ralplan·ultragoal·goal의 op와 훅 판단도 같은 큐에서 기다립니다(계획 C-1).

- **검사 먼저**: op 함수는 다음 상태를 메모리에서 끝까지 만들고, 모든 검사(C-3 허용 상태, 입력 상한, 라운드 검사, StateStore 한도)를 마친 뒤 첫 쓰기를 합니다(`store.ts:1-13` 머리말, 계획 C-7, DR-31). 그래서 거부된 op는 파일과 감사 로그를 한 바이트도 바꾸지 않습니다(테스트 T9).
- **되돌리기 없음**: 트랜잭션은 줄 세우기일 뿐입니다. 첫 쓰기 뒤의 I/O 실패는 이미 쓴 파일을 남깁니다.
- **예외 하나**: 결합 호출 `spec(…, handoff:"ralplan")`은 세 단계를 차례로 돌고, 뒤 단계가 실패해도 앞 단계의 쓰기가 남습니다([아래](#결합-호출-spec-handoffralplan)).
- **트랜잭션 밖의 일**: `spec(path)`의 파일 읽기는 트랜잭션을 열기 전에 합니다(`tool.ts:137`).

### 결과와 거부의 형식

- **정상 결과**: 대부분 2칸 들여쓰기 JSON입니다(`store.ts:278-280`의 `json`). 키는 gjc `--json` 키를 따릅니다(계획 PQ-24 A, DR-27).
- **doctor**: gjc의 사람용 텍스트입니다.
- **handoff와 결합 호출**: 결과 줄 하나, 줄바꿈, 그다음 JSON입니다. 결과 줄은 다음에 할 일을 알립니다(계획 DR-9).
- **status의 손상 경고**: JSON 뒤에 `WARNING:` 줄 하나가 붙습니다.
- **거부**: op가 던진 `Error`를 `defineTool`이 잡아 `Error: <message>`로 돌려줍니다. 도구 호출 자체는 실패하지 않습니다.

## 상태별로 동작하는 op (C-3)

계획 C-3(PQ-12 B′, spec Errata E7)을 코드에 맞춰 적은 표입니다. "활성"은 상태를 읽을 수 있고 `active === true`인 것입니다.

| op | 상태 없음 | 손상 | 활성 `interviewing` | 활성 `handoff` | 비활성 |
|---|---|---|---|---|---|
| `start` | 시드 | 덮어씀 | 덮어씀 | 덮어씀 | 덮어씀 |
| `write` | 거부(`start` 먼저) | 거부(`clear` + `force`) | 병합, phase 유지 | 병합, phase 유지(`reset`이면 `interviewing`) | 거부(취소된 `interviewing`이면 재개 안내, 그 밖은 `start` 또는 `ralplan handoff`) |
| `spec` | 거부 | 거부 | 스펙 저장 → `handoff` | 새 스펙 저장, `handoff` 유지 | 거부 |
| `handoff` | 거부 | 거부 | 거부(phase) | 넘김 | 거부 |
| `status` | `state: {}` | `state: {}` + 경고 줄 | 읽기 | 읽기 | 읽기 |
| `doctor` | 읽기 전용 검사 | `schema_violation` 보고 | 검사 | 검사 | 검사 |
| `state` | 거부 | 거부(`clear` + `force`) | 패치 | 패치 | 취소된 `interviewing`에 `{active: true}`가 든 패치면 재개, `{active: false}`면 "이미 취소됨" 거부, 그 밖은 거부 |
| `clear` | 파일 생성 `{active:false, current_phase:"complete"}` + 행 삭제 | `force` 필요 | `complete` | `complete` | phase가 `inactive`가 아닌 release phase(예: `complete`)면 `force` 필요, 그 밖(넘긴 `handoff`, 비활성 `interviewing`)은 `force` 없이 `complete` |

표 밖의 조건:

- `start`는 상태와 상관없이, ralplan이나 ultragoal이 보이는 주 skill이면 거부합니다([start](#start)).
- `clear`는 phase와 별도로, 보이는 행(행 파일, 없으면 스냅숏 항목)이 활성인데 phase가 상태와 다르면 낡은 것으로 보고 `force`를 요구합니다. 행 파일을 읽을 수 없어도 `force`를 요구합니다([clear](#clear)).
- `state {current_phase:"complete"}`로 만든 **활성 `complete`** 상태는 `write`·`spec`·`state`가 받고(활성이므로), `handoff`는 phase로 거부하며, `clear`는 `force`를 요구합니다(release phase).
- 같은 execution의 skill 로드 게이트는 op가 아니므로 이 표를 따르지 않습니다. 비활성 `complete` 인터뷰도 유효한 스펙이 있으면 넘깁니다([entry-and-handoff.md](entry-and-handoff.md)).

## 공통 도우미

### 상태 읽기 (`readDeepInterviewStateTx`, `store.ts:191-198`)

gjc `readExistingStateForMutation`입니다. `tx.readModeState("deep-interview")`의 결과를 셋으로 나눕니다. `_meta`는 떼어 냅니다(`payloadOf`, `store.ts:182-186`).

- `absent`: 파일이 없음
- `corrupt`: 읽기가 예외를 던짐. 문구는 StateStore가 정합니다([state-and-files.md](state-and-files.md)). 예: `state file is corrupted; it was preserved`(JSON 아님), `state file is invalid; it was preserved: <한도 오류>`, `state scope does not match this session; it was preserved`(`_meta.sessionId` 또는 `session_id`가 루트와 다름)
- `valid`: 그 밖

### 활성 요구 (`activeStateTx`, `store.ts:200-215`)

`write`, `spec`, `handoff`, `state`가 씁니다(deep-interview 편차 30). 차례로 셋을 봅니다. `state`는 패치에 `active: true`가 있으면 비활성 `interviewing`(취소된 인터뷰)도 받습니다([state](#state)). 문구는 `src/deep-interview-runtime/messages.ts:59-82`에 있고, `<op>`는 op 이름입니다.

| 경우 | 문구 |
|---|---|
| 상태 없음 | ``deep-interview <op>: there is no deep-interview state in this session; call `deep-interview start` first.`` |
| 손상 | ``deep-interview <op>: the deep-interview state is corrupt or tampered (<error>); reset it with `deep-interview clear` and force: true.`` |
| 비활성 `interviewing`에 `state(patch={"active": false})` (다시 취소) | ``deep-interview state: the interview is already cancelled (inactive, phase interviewing). Resume it with `deep-interview state(patch={"active": true})`, or end it with `deep-interview clear`.`` |
| 비활성 `interviewing` (취소됨) | ``deep-interview <op>: the interview was cancelled (inactive, phase interviewing). Resume it with `deep-interview state(patch={"active": true})`, or start a new interview with `deep-interview start`.`` |
| 그 밖의 비활성 | ``deep-interview <op>: the interview is not active (phase <phase \| (none)>). Start a new interview with `deep-interview start`, or reopen it from a finished ralplan with `ralplan handoff(to: "deep-interview")`.`` |

### 행 동기화 (`syncRowTx`, `store.ts:230-254`)

gjc `syncDeepInterviewHud`입니다. `start`, `write`, `spec`, `state`가 상태를 쓴 뒤 부릅니다.

- phase는 상태의 `current_phase`, 없으면 `interviewing`입니다.
- 행의 `active`는 `state` op에서는 상태의 `active`(`false`가 아니면 참), 나머지 op에서는 "phase가 `complete`가 아님"입니다. 그래서 활성 `complete` 상태에 `write`하면 행이 지워집니다.
- HUD 칩은 `deriveDeepInterviewHud(봉투, {phase, specStatus})`로 만듭니다. `spec`만 `specStatus: "persisted"`를 넘깁니다.
- 실제 쓰기는 공통 `syncActiveRowTx`(`src/skill-state/rows.ts:149-162`)입니다. 활성이면 행을 쓰고, 비활성이면 지우고, 스냅숏을 다시 만듭니다.
- **best-effort**: 행 쓰기의 예외는 삼킵니다. op 결과는 바뀌지 않습니다.

### 상태 감사 행 (`auditStateTx`, `store.ts:256-276`)

`{category: "state", verb, owner: "open-gajae-runtime", skill: "deep-interview", mutation_id, from_phase, to_phase, forced, paths: [상태 경로]}`를 한 줄 남깁니다.

## `start`

새 인터뷰를 시드합니다. `startTx`(`store.ts:295-357`)가 맡습니다. gjc 출처는 `seedDeepInterviewState`(`deep-interview-runtime.ts:718-778`)와 시드 요약(`:891-903`)이고, 기준치 우선순위와 범위는 `:498-521`입니다(머리말 기준).

- **입력**: `idea`, `threshold?`
- **검사 순서**:
  1. `idea`를 trim해서 비었으면 `deep-interview start requires an idea, e.g. idea: "<idea>".`
  2. trim한 `idea`가 NFC 코드 포인트 50,000자를 넘으면 `initial_idea exceeds max length 50000`
  3. `threshold`를 줬으면 유한한 수이고 `0 < threshold ≤ 1`이어야 합니다. 아니면 `invalid threshold: <값>. Expected 0 < threshold <= 1.`
  4. 보이는 주 skill(`readVisiblePrimaryTx`)이 `ralplan`이나 `ultragoal`이면 거부합니다(계획 D-HL2, deep-interview 편차 12). 행 파일을 읽을 수 없으면 주 skill이 없는 것으로 보고 지나갑니다(`otherPrimaryTx`, `store.ts:217-223`; 재개도 같은 함수를 씀).
     ```
     deep-interview start is refused while <skill> is the active workflow (phase <phase>). To interview from here: while ultragoal runs, call `ultragoal handoff(to: "deep-interview", reason)`; once ralplan has finished (final), call `ralplan handoff(to: "deep-interview")`; or stop ralplan first with `ralplan state {"active": false}` or `ralplan clear`, then start.
     ```
     행에 phase가 없으면 ` (phase …)` 부분이 빠집니다(`messages.ts:45-56`).
- **기준치**: `threshold`를 줬으면 그 값과 출처 `start(threshold)`(`START_THRESHOLD_SOURCE`, `store.ts:106`), 아니면 설정의 값과 출처(`~/.open-gajae/open-gajae.jsonc`, `./.open-gajae/open-gajae.jsonc`, `default`). 정하는 순서는 [entry-and-handoff.md](entry-and-handoff.md)에 있습니다.
- **이전 상태**: 읽기만 합니다. 손상이어도 거부하지 않고, 유효하면 그 phase를 감사 행의 `from_phase`에 적습니다(계획 DR-3). 활성 인터뷰가 있어도 덮어씁니다. "활성 상태 위에서 `start`하지 말라"는 SKILL Phase 0의 규칙이고 코드는 막지 않습니다.
- **만드는 봉투** (`store.ts:318-335`): `skill`, `version: 2`, `active: true`, `current_phase: "interviewing"`, `threshold`, `threshold_source`, `session_id`(루트), `updated_at`, 그리고 `state: {initial_idea, rounds: [], established_facts: [], current_ambiguity: 1.0, threshold, threshold_source}`. 이전 상태의 필드는 하나도 남지 않습니다. 스펙 파일과 index는 지우지 않습니다.
- **쓰기**: `assertStatePayload`로 한도를 확인한 뒤 상태, 감사 행 `state/write`(`mutation_id` `deep-interview:start:<at>`, `to_phase` `interviewing`), 활성 행과 스냅숏.
- **결과**:
  ```json
  {
    "ok": true,
    "skill": "deep-interview",
    "threshold": 0.05,
    "threshold_source": "default",
    "idea": "build a cli",
    "state_path": "<session>/state/deep-interview-state.json",
    "handoff": "deep-interview"
  }
  ```
  `idea`는 trim한 값입니다(입력 `"  build a cli  "`). `handoff`는 gjc의 `/skill:deep-interview`를 호스트 skill id로 바꾼 것입니다.

**편차**: deep-interview 편차 13(시드는 `start`만 하고 키워드·멘션·`skill` 로드는 상태를 쓰지 않음), 8(gjc 시드의 해상도 플래그, trace, 언어 감지 없음), 20(출처 문자열).

## `write`

인터뷰 내용(라운드, 사실, 그 밖의 필드)을 병합합니다. `writeTx`(`store.ts:371-428`)가 맡습니다. gjc 출처는 `deep-interview-stage.ts:428-474`(`computeMergedEnvelope`), `:830-920`(`handleWrite`), `state-runtime.ts:1232-1400`(deep-interview 쪽 병합 뒤 하한)입니다.

- **입력**: `input`(객체), `reset?`
- **검사와 계산 순서** (모두 메모리에서, 첫 쓰기 전):
  1. `input`이 객체가 아니면 `deep-interview write requires input, e.g. input: {"state": {…}}.`
  2. 활성 요구(`activeStateTx`).
  3. 정리기 `sanitizeWritePayload`(`envelope.ts:222-236`): 최상위에 전사 필드 9개 중 하나라도 있으면 전체를 거부합니다. 런타임 소유 키 9개는 지우고 보고 목록에 넣습니다. `state` 안의 봉투 예약 키는 이름만 보고합니다. 규칙은 [state-and-files.md](state-and-files.md)에 있습니다.
     ```
     deep-interview write: rounds, topology belong inside "state"; resend them as {"state": {…}} (top-level transcript fields are rejected, not moved).
     ```
  4. 정리된 입력의 직렬화 JSON이 코드 포인트 100,000자 이하인지 봅니다(`assertStructuredResponseWithinLimit`). 넘으면 `deep-interview write input exceeds max length 100000`, 직렬화할 수 없는 값(bigint, 함수, symbol, 유한하지 않은 수)이면 `deep-interview write input is not a valid structured deep-interview response`.
  5. 입력 자체의 prose 필드 상한(`assertEnvelopeInputLimits`): 예 `state.rounds[0].answer exceeds max length 10000`.
  6. 입력 `state.rounds[]` 항목마다 `round_key`를 모읍니다(`inputRoundKeys`). 문자열 `round_key`가 없는 항목은 오류가 됩니다.
  7. 기준 봉투를 정합니다. `reset`이면 빈 객체 `{}`, 아니면 현재 상태입니다.
  8. `mergeDeepInterviewEnvelope(기준, 입력)`으로 병합합니다.
  9. 이번 입력이 건드린 `round_key`의 **병합 뒤** 레코드를 검사합니다(`roundRecordErrors`; brownfield 판단은 병합 뒤 `state.type === "brownfield"`). 6과 9의 오류를 모두 모아 한 번에 거부합니다(아래 예).
  10. 런타임 필드를 씁니다: `skill`, `active: true`, `updated_at`, `version: 2`, `session_id`(루트). `current_phase`는 문자열이 아니거나 비었을 때만 `interviewing`으로 채웁니다. 그래서 phase는 그대로이고, `reset`이면 기준이 비어 `interviewing`이 됩니다.
  11. 기준 봉투의 `state.established_facts`가 배열이면 사실을 `id`로 다시 병합합니다(`mergeEstablishedFacts`, gjc는 staged 사실을 델타로 봄).
  12. `deriveRuntimeAmbiguity(병합, 기준)`으로 `current_ambiguity`를 정하고 하한을 적용합니다. 모델이 넣은 `state.current_ambiguity`는 남지 않습니다.
  13. 결과 봉투의 prose 상한을 다시 봅니다.
  14. `assertStatePayload`(1 MiB, 깊이 10, 최상위 키 100). 예: `state exceeds 100 top-level keys`, `state exceeds nesting depth 10`.
- **라운드 검사 거부의 예** (`state.type`이 `brownfield`, 첫 항목은 `round: 2`·`round_key: "round-3"`·`lifecycle: "answered"`·`answer: ""`, 둘째 항목은 `round_key` 없음):
  ```
  deep-interview write: round records do not match the required shape, so nothing was written:
  - state.rounds[1]: round_key (a string such as "round-1") is required
  - round 2 (round-3): round_key, lifecycle, question_text, answer, ambiguity, scores.goal, scores.constraints, scores.criteria, scores.context
  Each scored round needs round, round_key, lifecycle, question_text, answer, ambiguity, scores.goal, scores.constraints, scores.criteria (round_key "round-<round>", lifecycle "scored", scores in 0..1; a brownfield interview also needs scores.context); Round 0 needs round_key "round-0", question_text and answer. See the round record shape in the deep-interview skill, Phase 2.
  ```
- **쓰기**: 상태, 감사 행 `state/write-incremental`(또는 `reset`이면 `state/write-reset`, `mutation_id` `deep-interview:write:<at>`, `from_phase`는 현재, `to_phase`는 결과), 활성 행과 스냅숏.
- **결과** (`store.ts:418-427`): 키는 `ok`, `verb: "write"`, `mode`(`incremental`·`reset`), `session_id`, `state_path`, `current_ambiguity`(수일 때만), `ambiguity_floor`, `ignored_runtime_owned_keys`(비어 있지 않을 때만). 최상위 `current_phase`·`active`와 `state.skill`을 넣은 입력의 결과:
  ```json
  {
    "ok": true,
    "verb": "write",
    "mode": "incremental",
    "session_id": "ses_root",
    "state_path": "<session>/state/deep-interview-state.json",
    "current_ambiguity": 0.4,
    "ambiguity_floor": {
      "floor": 0.2,
      "disputed_fact_count": 1,
      "unscored_active_component_count": 2
    },
    "ignored_runtime_owned_keys": [
      "current_phase",
      "active",
      "state.skill"
    ]
  }
  ```
- **`reset`**: 빈 기준에서 다시 만들므로 `threshold`, `threshold_source`, `spec_*`, `handoff_*`가 사라지고 phase는 `interviewing`이 됩니다(계획 C-4, PQ-13 A). 기준이 비어 이전 `current_ambiguity`도 이어지지 않습니다. 입력에 기준치가 없으면 HUD와 압축 문맥에서 기준치가 빠집니다(K17). 결과에 `current_ambiguity`가 없을 수 있습니다.

**SKILL만 요구하는 것**: 한 번에 델타만 보낼 것(라운드 하나, 바뀐 사실, 바뀐 필드), 처음 `write`에 `interview_id`·`type`·`topology` 등을 넣을 것, `reset` 입력에 `threshold`·`threshold_source`를 넣을 것. 코드는 이를 검사하지 않습니다. 라운드 레코드가 실제 질문·답과 같은지도 모릅니다(K3, K8). **편차**: deep-interview 편차 2(초안 없이 한 번에 병합), 3(기록기 없이 모델이 라운드를 씀), 4(하한), 25(끌어올리기 없음, 최상위 전사 필드 거부), 36(라운드 검사).

## `spec`

최종 스펙을 저장하고 phase를 `handoff`로 옮깁니다. 도구 쪽 검사(`tool.ts:131-144`) 뒤 `specTx`(`store.ts:471-534`)가 맡고, 결과는 `writeSpecTx`(`store.ts:537-539`)가 JSON으로 바꿉니다. gjc 출처는 `persistDeepInterviewSpec`(`deep-interview-runtime.ts:612-716`)과 `resolveSpecContent`(`:151-163`)입니다.

- **입력**: `content` 또는 `path`, `slug?`, `handoff?`
- **도구 쪽 검사 순서** (트랜잭션 밖):
  1. `handoff: "ralplan"`인데 시드 콜백이 없으면 `spec(handoff: "ralplan") is not available here; call deep-interview spec, then deep-interview handoff(to: "ralplan")`. 플러그인은 늘 콜백을 넣으므로(`src/tools.ts:61-62`) 콜백 없이 만든 시험용 도구에서만 납니다.
  2. 본문 고르기(`specContent`, `tool.ts:106-112`):
     - `content`와 `path`가 둘 다 있으면 `content and path are mutually exclusive`
     - 빈 문자열이 아닌 `content`면 그대로
     - 빈 문자열이 아닌 `path`면 `resolveSpecContent(path, projectDir)`
     - 그 밖은 `content or path is required for deep-interview spec`
  3. `resolveSpecContent`(`store.ts:439-450`, 계획 PQ-6 A): 상대 경로는 `projectDir` 기준, 절대 경로는 그대로 `stat`합니다.
     - 일반 파일이면 UTF-8로 읽어 본문으로 씁니다.
     - `ENOENT`, `ENOTDIR`, `ENAMETOOLONG`이면 **값 자체**를 본문으로 씁니다. 디렉터리처럼 일반 파일이 아닌 경로도 값 자체가 본문입니다.
     - 그 밖의 오류는 `failed to read path <절대 경로>: <오류>`.
     - 프로젝트 밖 파일도 읽습니다. 호스트 권한을 거치지 않습니다(K10).
- **`specTx` 검사 순서**:
  1. 활성 요구(`activeStateTx`). phase는 보지 않습니다. 활성 `interviewing`, `handoff`, `complete`가 모두 받습니다.
  2. 본문이 NFC 코드 포인트 100,000자를 넘으면 `spec content exceeds max length 100000`.
  3. slug: trim한 `slug`, 없으면 `defaultSpecSlug()`(UTC `YYYY-MM-DD-HHMM-<4 hex>`, `manifest.ts:308-315`). `safeComponent`(`src/state.ts:204-208`) 규칙(첫 글자 `[A-Za-z0-9_-]`, 그 뒤 `[A-Za-z0-9._-]` 63자까지, `..` 없음)에 어긋나면 `invalid path component for slug: <slug>`.
  4. 본문 끝에 줄바꿈이 없으면 붙입니다. sha256은 붙인 뒤의 본문으로 계산합니다.
  5. 다음 상태를 만듭니다: 현재 상태 위에 `active: true`, `current_phase: "handoff"`, `skill`, `version: 2`, `spec_slug`, `spec_path`(절대 경로), `spec_sha256`, `spec_stage: "final"`, `spec_persisted_at`, `updated_at`, `session_id`. 읽기 경계를 거칩니다.
  6. `assertStatePayload`.
- **쓰기** (gjc 순서, 감사 행은 모두 `mutation_id` `deep-interview:spec:<at>`):
  1. `specs/deep-interview-<slug>.md` + `artifact/write`
  2. `specs/deep-interview-index.jsonl`에 한 줄 `{slug, stage:"final", path, created_at, sha256}` + `ledger/append`
  3. 상태 + `state/write`(`to_phase` `handoff`)
  4. 활성 행(phase `handoff`, `spec` 칩 `persisted`)과 스냅숏
- **같은 slug**: 파일을 덮어쓰고 index에 줄을 하나 더 붙입니다. 다른 slug면 이전 파일은 남습니다.
- **결과** (`SpecSummary`, gjc `RT:813-854` 키):
  ```json
  {
    "skill": "deep-interview",
    "stage": "final",
    "slug": "demo",
    "path": "<session>/specs/deep-interview-demo.md",
    "sha256": "c3d6867b86637ae245a62f5d8e93e904dd4a88a699305a44a18bb2930f5c925d",
    "spec_path": "<session>/specs/deep-interview-demo.md",
    "sha": "c3d6867b86637ae245a62f5d8e93e904dd4a88a699305a44a18bb2930f5c925d",
    "created_at": "2026-10-02T10:06:02.189Z",
    "state_path": "<session>/state/deep-interview-state.json"
  }
  ```
  `path`와 `spec_path`, `sha256`과 `sha`는 같은 값입니다(gjc 키를 둘 다 둠).
- **경로 오타의 예**: `path: "spec-sorc.md"`(없는 파일)는 거부되지 않고, 스펙 파일 내용이 `spec-sorc.md` 한 줄이 됩니다.

**SKILL만 요구하는 것**: 모호도가 기준치 아래이고 closure·restate gate를 지났을 때만 `spec`을 부를 것. 코드는 기준치를 보지 않습니다([known-limits.md](known-limits.md)의 "그 밖의 한계"). "더 다듬기" 뒤 다시 `spec`할 것도 SKILL의 규칙입니다.

### 결합 호출 `spec(…, handoff:"ralplan")`

`specHandoffTx`(`store.ts:548-561`)가 한 트랜잭션 안에서 세 단계를 **차례로** 돕니다. gjc `handleSpecWrite`(`deep-interview-runtime.ts:805-871`)를 `--deliberate`로 부른 것과 같습니다(계획 DR-29, PQ-18 A, PQ-23 A, deep-interview 편차 38). 단계마다 자기 검사만 합니다.

| 단계 | 함수 | 자기 검사 | 쓰는 것 |
|---|---|---|---|
| ① 스펙 저장 | `specTx` | 위 `spec`과 같음 | 스펙 파일, index, deep-interview 상태(`handoff`, `spec_*`), 행 |
| ② ralplan 시드 | `seedRalplanTx` → `startRunTx`(`src/ralplan-runtime/store.ts:915-988`) | `startRunTx`의 것만: 손상된 ralplan 상태 거부, `run_id` 경로 성분 | ralplan 상태(새로 씀), ralplan 행, 스냅숏 |
| ③ 넘기기 | `deepInterviewHandoffTx`(caller deep-interview → ralplan) | 활성, phase `handoff`, 스펙 확인, 저널 전 한도 검사 | 저널, 두 상태, 두 행, 스냅숏 |

②의 세부:

- 입력은 `{task: <spec_path 절대 경로>, deliberate: true}`입니다. `run_id`를 넘기지 않으므로 기존 ralplan 상태의 `run_id`, 없으면 루트 세션 id를 씁니다(K7).
- `ralplan start` op의 두 거부(활성 ultragoal, 활성 ralplan run)를 거치지 않습니다(`src/ralplan-runtime/tool.ts:189-211`은 도구 쪽에만 있음). 그래서 활성 ultragoal이 있어도 시드하고(K12), 진행 중인 ralplan run도 같은 `run_id`로 새로 씁니다.
- 새 ralplan 상태는 병합이 아니라 통째로 씁니다: `active: true`, `current_phase: "planner"`, `mode: "deliberate"`, `interactive: false`, `task`, `run_id`, `repository_binding`, `session_id` 등.
- ralplan 활성 행을 쓰면서 위쪽 파이프라인 행인 deep-interview 행을 지웁니다(`state/remove-superseded-pipeline-entry`).

③은 그 ralplan 상태 위에 `handoff_from: "deep-interview"`를 더하고, deep-interview를 비활성 `handoff`로 만들며, 두 행을 다시 씁니다([entry-and-handoff.md](entry-and-handoff.md)).

**결과** (세 단계가 모두 성공했을 때): 첫 줄은 `handoff(to:"ralplan")`과 같은 결과 줄이고, 그다음 `spec` 요약 JSON에 `handoff` 객체가 붙습니다.

```
Handed off to ralplan: deep-interview is inactive (phase handoff) and ralplan is active in planner. Load the `ralplan` skill now; do not call `ralplan start` — continue this run with `ralplan write` and use the spec as the planning input (spec: <session>/specs/deep-interview-s.md).
{
  "skill": "deep-interview",
  "stage": "final",
  "slug": "s",
  …,
  "handoff": {
    "to": "ralplan",
    "mode": "deliberate",
    "state_path": "<session>/state/ralplan-state.json",
    "run_id": "ses_root"
  }
}
```

**실패하면 남는 것** (K11, 계획 C4-10). 결과는 실패한 단계의 오류 하나입니다.

| 실패한 단계 | 남는 것 | 다음에 할 일 |
|---|---|---|
| ① | 아무것도 쓰지 않음 | 오류대로 고쳐 다시 부름 |
| ② (예: ``existing ralplan state is corrupt or tampered (…); refusing to overwrite … Reset it with `ralplan clear` and force: true.``) | 스펙 파일, index 줄, deep-interview 활성 `handoff` 상태와 그 행 | ralplan 쪽 원인을 고친 뒤(예: `ralplan clear(force:true)`) `deep-interview handoff(to:"ralplan")` |
| ③ | ①의 스펙 파일·index·deep-interview 활성 `handoff` 상태(행은 ②가 지움), ②의 ralplan `planner` 상태(`handoff_from` 없음)와 그 활성 행. 저널을 시작한 뒤의 I/O 실패면 `pending` 저널과 이미 쓴 상태도 남음 | `deep-interview status`·`ralplan status`로 확인하고 `deep-interview handoff(to:"ralplan")` |

SKILL Phase 5b도 같은 복구를 안내합니다("read `deep-interview status` and `ralplan status`, then continue with `deep-interview handoff(to: "ralplan")`"). ② 실패 뒤 ralplan 상태가 손상된 채면 그 넘기기도 callee 읽기에서 거부되므로, ralplan 쪽을 먼저 고쳐야 합니다.

## `handoff`

스펙을 저장한 인터뷰를 ralplan이나 ultragoal로 넘깁니다. `handoffTx`(`store.ts:618-628`)가 결과를 만들고, 실제 일은 `deepInterviewHandoffTx`(`store.ts:599-615`)가 합니다. 같은 함수를 결합 호출 ③과 로드 게이트의 활성 `handoff` 분기도 씁니다. gjc 출처는 `state-runtime.ts:1496-1551`(넘기기 전 스펙 확인)과 공통 인계 `:1572-1881`입니다.

- **입력**: `to`(`ralplan` \| `ultragoal`). 없으면 도구가 `to is required for deep-interview handoff ("ralplan" or "ultragoal")`로 거부합니다(`tool.ts:147`).
- **검사 순서**:
  1. 활성 요구(`activeStateTx("handoff")`).
  2. phase가 `handoff`인지(trim 뒤 정확히 비교). 아니면
     ```
     deep-interview handoff needs phase handoff (persist the spec with `deep-interview spec` first); the current phase is <phase | (none)>.
     ```
  3. 스펙 확인 `verifySpecTx`(`store.ts:572-592`). 하나라도 실패하면 그 문구로 거부합니다.

     | 조건 | 문구 |
     |---|---|
     | `spec_path`가 없음 | ``deep-interview has no persisted spec; write it with `deep-interview spec` first`` |
     | 루트 세션 `specs/` 밖 | `deep-interview spec_path <path> is not in this session's specs/` |
     | 읽기 실패(예: 일반 파일이 아님) | `deep-interview spec <path> is unreadable (<error>)` |
     | 파일 없음 | `deep-interview spec <path> is missing` |
     | sha256이 `spec_sha256`과 다름 | `` deep-interview spec <path> does not match spec_sha256; persist it again with `deep-interview spec` `` |

  4. 공통 `handoffWorkflowTx`(caller `deep-interview`, callee `to`, reason `deep-interview handoff to <to>`). 그 안의 검사: callee 상태가 손상이면 `existing state for <callee> is corrupt or tampered (<error>); refusing to hand off`, 병합한 두 상태 중 하나가 StateStore 한도를 넘으면 그 한도 문구(저널을 시작하기 전).
- **쓰는 것**: 저널 → callee 상태(활성, 시작 phase, `handoff_from`) → deep-interview 상태(비활성, `handoff`, `handoff_to`) → 두 행 → 스냅숏 → 저널 `committed` 뒤 삭제. 단계와 감사 행은 [entry-and-handoff.md](entry-and-handoff.md)에 있습니다. goal 상태는 건드리지 않습니다(D-HL8).
- **결과**: 결과 줄(`messages.ts:136-143`), 줄바꿈, 영수증 JSON.
  ```
  Handed off to ralplan: deep-interview is inactive (phase handoff) and ralplan is active in planner. Load the `ralplan` skill now; do not call `ralplan start` — continue this run with `ralplan write` and use the spec as the planning input (spec: <session>/specs/deep-interview-demo.md).
  {
    "ok": true,
    "from": "deep-interview",
    "to": "ralplan",
    "handoff_at": "2026-10-02T10:06:02.195Z",
    "mutation_id": "deep-interview:handoff:ralplan:2026-10-02T10:06:02.195Z",
    "phases": {
      "from": "handoff",
      "to": "planner"
    },
    "paths": {
      "from": "<session>/state/deep-interview-state.json",
      "to": "<session>/state/ralplan-state.json",
      "active_state": "<session>/state/skill-active-state.json"
    }
  }
  ```
  `to: "ultragoal"`의 결과 줄:
  ```
  Handed off to ultragoal: deep-interview is inactive (phase handoff) and ultragoal is active in goal-planning. Load the `ultragoal` skill now and call `ultragoal create` with the spec's acceptance criteria as goals (spec: <spec_path>).
  ```
  영수증의 `phases.to`는 `goal-planning`입니다.
- **두 번째 호출**: 넘긴 뒤 deep-interview는 비활성이므로 다시 부르면 비활성 거부(`… the interview is not active (phase handoff) …`)가 납니다.

**편차**: deep-interview 편차 5(phase `handoff`와 확인된 스펙이 필요함. gjc의 `state handoff` 동사는 둘 다 보지 않음), 1.

## `status`

상태를 읽어 보여 줍니다. 아무것도 쓰지 않습니다. `statusTx`(`store.ts:673-682`), gjc `gjc state read deep-interview`.

- **입력**: `fields?`(`STATE_FIELD_ALLOWLIST`, `store.ts:131-153`의 21개: `skill`, `phase`, `current_phase`, `next`, `active`, `status`, `fresh`, `fresh_until`, `receipt`, `artifact_path`, `plan_path`, `spec_path`, `run_id`, `stage`, `stage_n`, `session_id`, `updated_at`, `handoff_to`, `handoff_from`, `counts`, `hud`)
- **`fields`가 없을 때**: `{skill: "deep-interview", state: <읽기 경계를 거친 봉투>, storage_path}`. 상태가 없으면 `state: {}`입니다. `_meta`는 빠집니다.
  ```json
  {
    "skill": "deep-interview",
    "state": {},
    "storage_path": "<session>/state/deep-interview-state.json"
  }
  ```
- **`fields`가 있을 때** (`projectStateFields`, `store.ts:635-666`, gjc `state-renderer.ts:82-104`): 고른 필드만 냅니다.
  - `skill`은 늘 `deep-interview`.
  - `phase`·`current_phase`는 상태의 `current_phase`, 없으면 `phase`, 그것도 없으면 `interviewing`. 그래서 상태가 없어도 `"phase": "interviewing"`이 나옵니다.
  - `next`는 전이 표에서 그 phase를 출발점으로 하는 행의 도착 phase들(`interviewing` → `["handoff", "complete"]`, `handoff` → `["complete"]`).
  - `fresh`는 `receipt.fresh_until`이 지금보다 뒤인지. deep-interview 상태에는 영수증이 없으므로 늘 `false`입니다(deep-interview 편차 2).
  - 그 밖은 봉투의 같은 이름 필드입니다. 값이 없으면 JSON에서 빠집니다.
  ```json
  {
    "skill": "deep-interview",
    "phase": "handoff",
    "next": ["complete"],
    "active": true,
    "spec_path": "<session>/specs/deep-interview-demo.md",
    "fresh": false
  }
  ```
- **손상**: 결과는 `state: {}`(또는 빈 상태 위 투영)이고, 뒤에 한 줄이 붙습니다.
  ```
  WARNING: failed to read <session>/state/deep-interview-state.json; ignoring corrupt state: state file is corrupted; it was preserved
  ```

**SKILL만 요구하는 것**: Phase 0과 Phase 0.5, 이어 하기(Resume)는 `status`로 상태를 먼저 봅니다.

## `doctor`

deep-interview의 상태, 행, 스냅숏을 읽기 전용으로 검사합니다. `doctorTx`(`store.ts:685-687`)가 공통 `collectDoctorSummaryTx(tx, "deep-interview")`와 `renderDoctorText`(`src/skill-state/doctor.ts:149-298`)를 부릅니다. 검사 항목은 [state-and-files.md](state-and-files.md)에 있습니다. 아무것도 고치지 않습니다.

- **입력**: 없음
- **결과**: gjc 텍스트. `journals_scanned` 줄이 없습니다(deep-interview 편차 21).
  ```
  ok: false
  root: <session>/state
  skills_scanned: 1
  files_scanned: 3
  findings_total: 3
  counts: schema_violation=0, stale_active_state=3
  finding: kind=stale_active_state skill=deep-interview path=<session>/state/active/deep-interview.json message=active entry for deep-interview does not match a live active mode-state fix=deep-interview clear
  finding: kind=stale_active_state skill=deep-interview path=<session>/state/active/deep-interview.json message=active entry for deep-interview phase interviewing differs from canonical mode-state phase complete fix=deep-interview clear
  finding: kind=stale_active_state skill=deep-interview path=<session>/state/skill-active-state.json message=active snapshot for deep-interview phase interviewing differs from canonical mode-state phase complete fix=deep-interview clear
  ```
  (상태를 손으로 `{active:false, current_phase:"complete"}`로 바꾸고 활성 행을 남겨 둔 경우입니다.) 문제가 없으면 `ok: true`와 다섯 줄만 나옵니다.
- **고치는 명령**: `schema_violation`은 `deep-interview clear (force: true)`, `stale_active_state`는 `deep-interview clear`입니다. 위 예처럼 상태가 이미 `complete`면 `force` 없는 `clear`는 낡음으로 거부되므로 `force`가 필요합니다(K9).

## `state`

봉투에 패치를 병합합니다. gjc `gjc state deep-interview write`이고, 런타임 소유 필드를 거부하는 점이 다릅니다(deep-interview 편차 19). `patchStateTx`(`store.ts:700-750`)가 맡습니다.

- **입력**: `patch`(객체). 없으면 도구가 `patch is required for deep-interview state`로 거부합니다(`tool.ts:156`).
- **검사 순서**:
  1. 패치에서 `_meta`를 뗍니다.
  2. 필드 거부 둘을 함께 모읍니다. 둘 다 걸리면 줄바꿈으로 이어 한 번에 냅니다.
     - `statePatchFieldError`(`manifest.ts:164-178`): 최상위나 `state` 안에 `spec_slug`, `spec_path`, `spec_sha256`, `spec_stage`, `spec_persisted_at`, `rounds`, `established_facts`, `current_ambiguity`, `ambiguity_floor`가 있으면(어느 층이든) 거부합니다(spec D-SR9).
       ```
       deep-interview state cannot set spec_path, rounds, state.current_ambiguity: rounds, facts and ambiguity are written by `deep-interview write` (inside "state"), and the spec fields by `deep-interview spec`.
       ```
     - `topLevelTranscriptError("state", …)`: 위에서 이름을 댄 것을 빼고, 최상위의 나머지 전사 필드(`topology`, `ontology_snapshots`, `auto_researched_rounds`, `auto_answered_rounds`, `architect_failures`)를 거부합니다(PQ-20 C). `state` 안의 같은 필드는 허용합니다.
       ```
       deep-interview state: topology belong inside "state"; resend them as {"state": {…}} (top-level transcript fields are rejected, not moved).
       ```
  3. 활성 요구(`activeStateTx("state", 패치의 active === true)`). 필드 거부가 이보다 먼저라서, 상태가 없어도 필드 거부가 먼저 납니다. 패치가 `active: true`이고 상태가 비활성 `interviewing`이면 재개로 받습니다. 이때 ralplan이나 ultragoal이 보이는 주 skill이면 `start`처럼 거부합니다(`resumeRefusal`, deep-interview 편차 12·30).
     ```
     deep-interview state: resuming the interview is refused while ralplan is the active workflow (phase planner). To interview from here: …, then resume.
     ```
  4. 패치의 직렬화 JSON 100,000자(`deep-interview state patch exceeds max length 100000`).
  5. `mergeDeepInterviewEnvelope(현재, 패치)`: 최상위 `null`은 삭제, `state`는 지우지 않고 그 안의 `null`은 삭제, 객체가 아닌 `patch.state`는 무시합니다(PQ-25 A).
  6. 병합 결과를 `workflowEnvelopeError`(`src/skill-state/doctor.ts:64-79`)로 검사합니다. 예: `state.active must be a boolean when present`, `state skill must match selected mode deep-interview`, `state.current_phase must be a string when present`.
  7. 목표 phase: 패치의 `current_phase`, 없으면 `phase`, 없으면 `patch.state.current_phase`(읽기 경계가 `state` 안에서 지우지만 phase로는 읽음), 없으면 병합 결과의 phase, 없으면 현재 phase, 없으면 `interviewing`.
  8. `deepInterviewPhasePatchError(현재, 목표)`(`manifest.ts:81-89`): 목표가 manifest phase가 아니면 `unknown deep-interview phase "<phase>"`, 현재가 manifest phase이고 같은 phase도 표의 간선도 아니면 `invalid deep-interview phase transition from <a> to <b>`. 허용되는 이동은 같은 phase, `interviewing → handoff`, `handoff → complete`, `interviewing → complete`뿐입니다. `handoff → interviewing`은 거부됩니다.
  9. 런타임 필드: `skill`, `current_phase`(목표), `version: 2`, `updated_at`, `session_id`. `active`가 boolean이 아니면(예: `{active: null}`로 지움) `true`.
  10. 하한을 다시 적용합니다(`applyAmbiguityFloorToEnvelope`). `state.topology` 패치가 `ambiguity_floor`와 `current_ambiguity`를 그 자리에서 맞춥니다.
  11. 다시 `workflowEnvelopeError`, prose 상한, `assertStatePayload`.
- **쓰기**: 상태, 감사 행 `state/write`(`mutation_id` `deep-interview:<at>`), 행(상태가 `active: false`면 행 삭제)과 스냅숏.
- **결과**:
  ```json
  {
    "ok": true,
    "skill": "deep-interview",
    "state_path": "<session>/state/deep-interview-state.json",
    "current_phase": "interviewing",
    "active": true,
    "mutation_id": "deep-interview:2026-10-02T10:06:44.072Z"
  }
  ```
- **취소와 재개** (deep-interview 편차 30): `state(patch={"active": false})`는 인터뷰를 취소합니다. phase와 라운드는 남고, 행이 지워져 편집 가드와 continuation이 멈춥니다. 취소된 인터뷰는 `write`·`spec`·`handoff`가 재개 안내와 함께 거부하고, 로드 게이트는 `interviewing`이면 거부합니다([entry-and-handoff.md](entry-and-handoff.md)). `state(patch={"active": true})`가 재개합니다. 행이 다시 쓰이고 라운드가 그대로 이어집니다. 끝난 인터뷰(`complete` 등)와 넘긴 인터뷰(비활성 `handoff`)는 재개되지 않습니다. SKILL은 재개 전에 사용자에게 묻습니다(Phase 0). 같은 패치의 다른 필드는 함께 병합되고, phase를 함께 주면 활성 인터뷰처럼 전이표를 따릅니다. 다시 취소하면 "이미 취소됨"으로 거부합니다. 스펙 뒤(phase `handoff`)의 취소는 SKILL이 `clear`로 하므로 재개가 없습니다([known-limits.md](known-limits.md) K19). 테스트 T11, T12.

## `clear`

인터뷰를 끝냅니다. `clearStateTx`(`store.ts:785-820`), gjc `handleClear`(`state-runtime.ts:1402-1490`)와 `describeStaleClearState`(`:244-270`)입니다(계획 DR-15).

- **입력**: `force?`
- **검사 순서** (`force`면 둘 다 건너뜀):
  1. 상태가 손상이면 `existing state for deep-interview is corrupt or tampered (<error>); use force: true to overwrite`.
  2. 낡음 판정 `describeStaleClearTx`(`store.ts:757-777`):
     - phase가 release phase이고 `inactive`가 아니면(`complete`, `completed`, `failed`, `cancelled`, `canceled`) 낡음: `mode-state is already terminal (<phase>)`
     - 행 파일을 읽을 수 없으면 바로 거부: `active row <path> is unreadable (<error>); use force: true to clear`
     - 보이는 항목(skill이 `deep-interview`인 행 파일, 없으면 스냅숏의 같은 skill 항목)이 활성인데 phase가 상태와 다르면 낡음: `active-state phase <행 phase> differs from mode-state phase <상태 phase>`
     - 낡음이면 `existing state for deep-interview is stale (<이유>); use force: true to clear`.
- **쓰는 것**:
  - 상태: `{skill, …기존 필드, active: false, current_phase: "complete", updated_at, version: 2}`. 손상(`force`)이거나 상태가 없으면 기존 필드 없이 이 다섯만 씁니다. 상태가 없을 때도 파일을 만듭니다(PQ-12 B′, gjc·ultragoal과 같음). 이때 `session_id`는 없고 `_meta.sessionId`만 있습니다.
  - 감사 행 `state/clear`(`mutation_id` `deep-interview:clear:<at>`, `to_phase` `complete`, `forced`는 `force` 값).
  - 행 삭제(`state/remove-active-entry`, 행이 있었을 때만)와 스냅숏. best-effort입니다.
  - 스펙 파일과 index는 그대로 둡니다. goal 상태도 건드리지 않습니다(D-HL8).
- **결과**:
  ```json
  {
    "ok": true,
    "skill": "deep-interview",
    "state_path": "<session>/state/deep-interview-state.json",
    "active": false,
    "current_phase": "complete",
    "mutation_id": "deep-interview:clear:2026-10-02T10:06:02.180Z"
  }
  ```
- **두 번째 `clear`**: 이미 `complete`이므로 `existing state for deep-interview is stale (mode-state is already terminal (complete)); use force: true to clear`. 상태 없이 부른 첫 `clear`도 `complete` 파일을 만들므로, 그다음 `clear`는 `force`가 필요합니다(T8).
- **넘긴 뒤의 `clear`**: 비활성 `handoff`는 release phase가 아니고 행도 비활성이라 `force` 없이 됩니다.
- **K1 상태**(행 없이 활성 상태만 남음): 행이 없으니 낡음 판정에 걸리지 않아 `force` 없이 됩니다(T8).
- **`clear` 뒤 로드 게이트**: `clear`는 `spec_*`를 남기므로, 같은 execution에서 `skill ralplan|ultragoal`을 로드하면 유효한 스펙이 있는 끝난 인터뷰로 보고 넘깁니다([entry-and-handoff.md](entry-and-handoff.md), K15).

**SKILL만 요구하는 것**: Phase 5 "Finish here"는 `clear`로 끝냅니다. Phase 0.5는 빈 인터뷰일 때만 `clear`하고, 라운드·스펙·넘기기 기록·확정 topology가 있으면 지우지 말고 사용자에게 묻습니다. 손상된 자기 상태는 `clear(force: true)` 뒤 다시 시드합니다. 코드는 이 판단을 하지 않습니다.
