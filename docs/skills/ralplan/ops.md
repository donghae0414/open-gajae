# `ralplan` 도구의 op

이 문서는 `ralplan` 도구의 op 7개(`start`, `write`, `status`, `doctor`, `state`, `handoff`, `clear`)를 코드 그대로 적습니다. 도구 정의와 등록, 입력 스키마, 호출자 검사와 소유 세션, op마다 여는 트랜잭션, 결과와 거부의 형식을 먼저 적고, 그다음 op마다 입력, 검사 순서와 거부 문구, 쓰는 파일과 순서, 감사 행, 결과 모양을 다룹니다. 기준 코드는 [README.md](README.md) 머리에 있습니다.

예시 출력은 기준 코드(main `5b92a60`)를 임시 폴더의 `StateStore` 위에서 bun으로 실제로 불러 얻은 것입니다. `tests/ralplan-tool.test.ts`의 `fixture`처럼 `createTools`로 도구를 만들고, 가짜 계보(`ses_root` 아래에 `ses_planner`, `ses_architect`, `ses_critic`)를 `rootSession`으로 넘겼습니다. 세션 폴더 절대 경로는 `<session>`, 임시 프로젝트 폴더는 `<project>`로 바꿨습니다. 시각, 해시, `mutation_id`의 UUID는 실행마다 다릅니다. 같은 `repository_binding`이 되풀이되는 곳은 `{…}`로 줄였습니다.

다음 주제는 다른 문서가 맡습니다. 여기서는 링크만 겁니다.

- 용어(stage, `stage_n`, opener, lane, run, 계보 루트, 보이는 주 skill, T, R, phase lock, 턴 표식, 영수증, PLANNING-STUCK), 전체 흐름, 코드 지도: [README.md](README.md)
- `write` 한 번 안에서 일어나는 일(파일 이름, 정규화와 sha256, `index.jsonl` 행, 중복 제거와 덮어쓰기 거부, `pending-approval.md`, run 전환, phase 전진과 phase lock, 전이 감사 행, 반복 상한과 lane 예산, PLANNING-STUCK 기록, lane verdict, 역할 메타데이터, final 승인과 `auto_handoff`, disposition 검사, 영수증 필드): [stages-and-ledger.md](stages-and-ledger.md)
- 세션 폴더와 파일 표, 쓰기 큐와 `RalplanTx` API, 상태 파일의 모양과 필드, StateStore 한도, phase manifest, 활성 행·스냅숏·보이는 주 skill, HUD 칩, 감사 행 모양, doctor 검사 항목, 저장소 바인딩, 설정 `ralplan.*`: [state-and-files.md](state-and-files.md)
- 키워드와 멘션, skill 로드, 다른 skill에서 들어오는 길, `ralplan handoff`의 공통 저널 인계, 같은 execution의 `skill ultragoal` 게이트: [entry-and-handoff.md](entry-and-handoff.md)
- 계획 가드, 도구 숨김, 역할 권한 규칙, continuation(그 breaker가 부르는 `state` op 포함): [guards-and-continuation.md](guards-and-continuation.md)
- 세 역할 agent와 합의 루프의 호출 순서: [roles-and-consensus.md](roles-and-consensus.md)

"ralplan 편차 N"은 루트 `README.md`의 "Deviations from GJC (ralplan)" 절(README.md:394-454)에 있는 편차 표(398-438)의 번호입니다. 같은 절의 "Accepted behavior differences"는 438-452입니다. 코드 위치는 main `5b92a60` 기준이고, 루트 README의 줄 번호만은 이 문서들과 함께 들어가는 현재 파일 기준입니다(118행 뒤로는 5b92a60보다 2줄씩 뒤). 루트 README의 ralplan 절은 README.md:115-193이고, 그 안의 `ralplan` 도구 op 표는 129-137입니다. gjc 줄 번호는 open-gajae 파일 머리말 주석(`src/ralplan-runtime/tool.ts:10-25`, `store.ts:14-61`)이 적은 값을 옮긴 것입니다. 이 문서를 쓰며 gjc 소스(`5c5231418930673e42cc5d08ebe4376e03187533`)로 다시 확인한 것은 `gjc-runtime/state-runtime.ts:1290-1345`(`state write`의 phase 검사)뿐입니다.

## 한눈에 보기

| op | 부를 수 있는 agent | 필요한 상태 | 쓰는 것 (순서대로) | 감사 행 `category/verb` | 결과 |
|---|---|---|---|---|---|
| `start` | `open-gajae` | 활성 ultragoal도, 활성 ralplan run도 없음. 손상이면 거부 | 상태(새로 씀) → 위쪽 파이프라인 행 삭제 → 행 → 스냅숏 | `state/write` | JSON |
| `write` | `open-gajae`, 세 역할 | 없음(상태가 없으면 만듦). 손상이면 거부 | 상태 → 단계 파일 → `index.jsonl` 한 줄 → (`final`이면) `pending-approval.md` → 역할·verdict·승인 병합 → 행 → 스냅숏 | `state/write`(여러 번), `artifact/write`, `ledger/append` | 영수증 한 줄 + JSON, 또는 PLANNING-STUCK 한 줄 + JSON |
| `status` | `open-gajae`, 세 역할 | 없음 | 없음 | 없음 | JSON (손상이면 `WARNING:` 줄 하나 더) |
| `doctor` | `open-gajae` | 없음 | 없음 | 없음 | JSON |
| `state` | `open-gajae`, 세 역할 | 없음(상태가 없으면 만듦). 손상이면 거부 | 상태 → 행(또는 행 삭제) → 스냅숏 | `state/write` | JSON |
| `handoff` | `open-gajae` | 활성, phase ∈ T | 저널 → callee 상태 → ralplan 상태 → 두 행 → 스냅숏 → 저널 정리 | `state/handoff` 둘 + 저널 행 | 결과 줄 + JSON |
| `clear` | `open-gajae` | 없음(손상·낡음이면 `force`) | 상태 → 행 삭제 → 스냅숏 | `state/clear` | JSON |

행과 스냅숏을 바꿀 때마다 감사 행이 하나씩 더 남습니다(`state/write-active-entry`, `state/remove-active-entry`, `state/remove-superseded-pipeline-entry`, `state/rebuild-active-snapshot`). 감사 행 모양은 [state-and-files.md](state-and-files.md)에 있습니다.

## 도구 정의

`src/ralplan-runtime/tool.ts:166-309`의 `ralplanTool(store, deps)`가 도구를 만들고, `src/tools.ts:48-52`의 `createTools`가 등록합니다. 플러그인 setup은 `src/index.ts:57-65`에서 `createTools`를 부르고, 그 결과를 `ctx.tool.transform`으로 호스트에 더합니다. 등록할 때 넘기는 것(`RalplanToolDeps`, `tool.ts:92-98`)은 셋입니다.

- `rootSession`: `src/hooks.ts:626-658`의 `rootSession`. `parentID`를 따라 올라가 계보 루트를 찾고, 조회 실패·순환·읽을 수 없는 응답은 모두 예외입니다. `createTools`에 이 값이 없으면 `noHostLookup`(`src/tools.ts:28-30`)이 늘 예외를 던지므로 모든 op가 거부됩니다(fail closed).
- `settings`: `loadSettings`가 setup 때 한 번 정한 `ralplan.*`(`maxIterations`, `maxReviewPassesPerLane`, `autoHandoff`, `source`). 없으면 `DEFAULT_RALPLAN_SETTINGS`(`tool.ts:81-90`: `5`, `1`, `"off"`, 출처는 모두 `"default"`)입니다. 설정을 읽는 규칙은 [state-and-files.md](state-and-files.md)에 있습니다. 설정 파일을 바꾸면 호스트를 다시 시작해야 반영됩니다(ralplan 편차 4).
- `projectDir`: 주 agent의 상대 `path`를 푸는 기준이고, 저장소 바인딩을 잡는 디렉터리입니다.

**이름과 권한**: 이름도 권한 이름도 `ralplan`입니다(`tool.ts:269-270`). `src/tools/define.ts:31-51`의 `defineTool`이 `options: {codemode: false, permission: "ralplan"}`으로 감쌉니다. Code Mode가 아닌 직접 도구라는 뜻입니다. 이 권한으로 다른 agent에게서 도구를 숨기는 방법과 역할 권한 규칙은 [guards-and-continuation.md](guards-and-continuation.md)에 있습니다.

**모델이 보는 설명** (`tool.ts:271-272`):

```
Operate this session's ralplan run (gjc ralplan): start a run, write a stage artifact (planner, intent, architect, critic, disposition, revision, post-interview, adr, final) and get its receipt, status, doctor, state (merge patch; Stop here is {active:false}), handoff to ultragoal or deep-interview after final, clear. The only way to change ralplan files and state.
```

**op 목록**: 입력 스키마의 `op` enum(`tool.ts:101-103`)이 7개를 이 순서로 정합니다. `tests/ralplan-tool.test.ts`의 "AC1: seven ops; …"가 순서까지 확인합니다. 다른 이름은 호스트의 스키마 검사에서 걸리므로(아래 "호스트의 검사"), `execute`의 `switch` 끝의 `unknown op <op>`(`tool.ts:306`)는 테스트처럼 `execute`를 바로 부를 때만 나옵니다.

**gjc 출처** (머리말 기준, `tool.ts:10-17`): `gjc-runtime/ralplan-runtime.ts:1535-1583`(`resolveArtifactArgs`: stage, `stage_n`, artifact, run id 우선순위, 빈 artifact), `:2033-2261`(`handleArtifactWrite`), `:2382-2475`(시드), `gjc-runtime/workflow-cli-common.ts:24-30`(`assertSafePathComponent`), `gjc-runtime/state-runtime.ts`(read, write, clear, doctor). 넘기기는 공통 저널 인계(`src/skill-state/handoff.ts`)입니다. 편차(`tool.ts:18-25`): ralplan 편차 1(CLI → op), 2(역할은 `content`만), 5(역할 세션 id 자동 기록, `resumable` 하나), 30(주 agent의 `path`는 OS 임시 파일), 31(`start{run_id}`), 32(소유 세션은 계보 루트), 34(넘기기는 phase ∈ T), 39(활성 run 위의 `start` 거부).

### 입력 스키마

입력은 zod 객체 하나입니다(`tool.ts:100-158`). `op`만 필수이고 나머지는 모두 선택입니다. 어떤 필드가 필요한지는 op가 실행 중에 검사합니다. 넷째 열은 스키마의 `describe` 문구 그대로입니다(모델이 보는 필드 설명). `run_id`와 `force`의 문구는 2026-10-04에 코드 동작에 맞춰 고친 현재 파일의 것입니다(줄 번호와 동작은 그대로).

| 필드 | 타입 | 쓰는 op | `describe` |
|---|---|---|---|
| `op` | `start` \| `write` \| `status` \| `doctor` \| `state` \| `handoff` \| `clear` | 전부 | `The operation; see the ralplan skill for each op's fields.` |
| `task` | string | `start` | `start: the planning task.` |
| `interactive` | boolean | `start` | `start: gjc --interactive.` |
| `deliberate` | boolean | `start` | `start: gjc --deliberate.` |
| `run_id` | string | `start`, `write` | `start/write: the run folder (1-64 of A-Z a-z 0-9 . _ -, not starting with ., no ..); defaults to the state's run_id, then the session id.` |
| `stage` | string | `write` | `write: planner, intent, architect, critic, disposition, revision, post-interview, adr or final.` |
| `stage_n` | number | `write` | `write: the pass number, 1..999.` |
| `content` | string | `write` | `write: the full artifact (Markdown; disposition is JSON).` |
| `path` | string | `write` | `write (primary only): a file under the OS temp directory holding the artifact.` |
| `lane_verdict` | string | `write` | `write: architect CLEAR/WATCH/BLOCK or critic OKAY/ITERATE/REJECT.` |
| `resumable` | boolean | `write` | `write (planner/revision/architect/critic): whether this role session can be resumed.` |
| `fallback_reason` | string | `write` | `write: why a role session was not resumed: context_unavailable, not_found, no_runner, resume_failed, process_restart or missing_record.` |
| `fallback_attempted_id` | string | `write` | `write: the session id that could not be resumed.` |
| `fallback_stage_n` | number | `write` | `write: the stage_n of the failed resume.` |
| `fallback_receipt_path` | string | `write` | `write: the fresh role's stage artifact path (gjc --fallback-receipt-path).` |
| `fields` | `STATE_FIELD_ALLOWLIST` 값의 배열 | `status` | `status: project only these fields.` |
| `patch` | 문자열 키 객체(`record<string, unknown>`) | `state` | `state: fields to merge; null deletes a field. Stop here is {"active": false}.` |
| `to` | `ultragoal` \| `deep-interview` | `handoff` | `handoff: the target skill.` |
| `force` | boolean | `clear` | `clear: clear even a corrupt or stale state (skips the corrupt, stale and unreadable-row checks).` |

스키마 수준의 동작:

- **op가 쓰지 않는 필드**는 조용히 무시합니다. 예를 들어 `state`에 `task`를 줘도 아무 일도 없습니다.
- **`stage`는 문자열**입니다. 9개 단계인지는 `write`가 실행 중에 검사합니다(`assertRalplanStage`). `lane_verdict`도 문자열이고, 대소문자는 실행 중에 정리됩니다.
- **`force`**는 설명대로 손상 상태, 낡은 상태, 읽을 수 없는 행 파일의 거부를 모두 건너뜁니다([clear](#clear)).
- **호스트의 검사**: 플러그인 도구는 promise 어댑터가 `input` 스키마를 그대로 둔 채 호스트에 더하고(`opencode/packages/plugin/src/promise/adapter.ts:480-484`), 호스트는 도구를 부르기 전에 그 스키마로 입력을 검사합니다. 경로는 `opencode/packages/core/src/tool.ts:113-119`의 `executeTool` → `core/src/tool/runtime.ts:28-30`의 `execute` → `decodeInput`(`:62-68`) → zod 스키마의 Standard Schema `~standard.validate`(`validateStandard`, `:141-153`)입니다(OpenCode v2.0.15 소스). 실패하면 도구를 부르지 않고 `Invalid arguments for tool "ralplan": …`로 시작하는 오류를 냅니다(`formatInputIssues`, `:87-99`). 그래서 enum 밖의 `op`·`to`·`fields` 값, 객체가 아닌 `patch`, 타입이 틀린 필드는 런타임에 닿지 않고, 모르는 키는 버린 값이 넘어옵니다. zod 4.6.5의 `~standard.validate`로 확인했습니다: `to: "ralplan"`, `patch: "x"`, `op: "bogus"`, `fields: ["nope"]`는 거부하고, `{op: "status", extra: 1}`은 `{op: "status"}`가 됩니다.
- **다시 파싱하지 않음**: `defineTool`이 만든 `execute`(`src/tools/define.ts:43-49`)는 입력을 다시 파싱하지 않습니다. 호스트를 거치지 않고 `execute`를 바로 부르면 스키마 검사가 없으므로, 테스트는 `tool.input.parse`를 먼저 부릅니다(`tests/ralplan-tool.test.ts:63-64`). 런타임은 그 밖에 `stage`, `stage_n`, `content`/`path`, `lane_verdict`, 역할 메타데이터, 병합한 상태의 envelope 모양을 따로 검사합니다.

## 소유 세션과 트랜잭션

### 호출자 검사와 소유 세션 (`ownerSession`)

`tool.ts:168-187`의 `ownerSession`이 모든 op 앞에서 차례로 검사합니다. 상수는 `PRIMARY = "open-gajae"`(`tool.ts:54`), `ROLES`(`tool.ts:56-60`: `open-gajae-planner` → `planner`, `open-gajae-architect` → `architect`, `open-gajae-critic` → `critic`), `ROLE_OPS = {write, status, state}`(`tool.ts:61`)입니다(spec D-W3).

| 순서 | 검사 | 거부 문구 |
|---|---|---|
| 1 | `context.sessionID`가 비어 있지 않은 문자열인가 | `a native session is required` |
| 2 | `context.agent`가 `open-gajae`가 아니면, `ROLES`에 있는가 | `the ralplan tool is not available to <agent>` |
| 3 | 역할이면, op가 `ROLE_OPS`에 있는가 | `<agent> may only use write, status and state` |
| 4 | `deps.rootSession(sessionID)`가 계보 루트를 돌려주는가 | `could not resolve the session lineage for ralplan` |

- 4의 원래 예외(`src/hooks.ts`의 `could not resolve the session lineage for <sessionID>` 등)는 `cause`에만 남고 결과 문구에는 나오지 않습니다.
- 그 결과 역할의 자식 세션에서 부른 op도 루트 세션 폴더의 상태와 run을 씁니다. 영수증의 `session_id`도 루트 id입니다(spec DR-1, ralplan 편차 32). 역할의 자기 세션 id는 `write`가 역할 메타데이터로만 기록합니다([write](#write)).
- 소유하지 않은 agent(호스트 `build`·`general`, 사용자 agent, `open-gajae-executor` 등)는 `context` 훅이 요청에서 도구를 지우므로 보통 부를 수 없고, 불러도 2에서 거부됩니다. 도구 숨김은 [guards-and-continuation.md](guards-and-continuation.md)에 있습니다. `tool.ts:24-25` 머리말도 "DR-22: agents other than `open-gajae` and the three roles are refused here; `src/hooks.ts` hides it too."라고 적습니다. 숨김이 실행 시 거부만 하던 DR-22의 설계를 대신한 경위는 루트 README "Accepted behavior differences"의 숨김 행(README.md:452)에 있습니다.

실제 출력:

```
Error: open-gajae-architect may only use write, status and state
Error: the ralplan tool is not available to open-gajae-executor
Error: could not resolve the session lineage for ralplan
```

(차례로 역할의 `doctor`, `open-gajae-executor`의 `status`, 계보에 없는 세션의 `status`입니다.)

### 트랜잭션 하나

op마다 `store.ralplanTransaction(owner, tx => …)` 하나를 열고, 그 안에서 `src/ralplan-runtime/store.ts`의 op 함수를 부릅니다. `ralplanTransaction`(`src/state.ts:581-586`)은 `workflowTransaction`(`src/state.ts:476-578`)의 다른 이름입니다. 루트 세션의 쓰기 큐 하나를 잡으므로, 같은 세션의 deep-interview·ultragoal·goal op와 훅 판단도 같은 큐에서 기다립니다(ultragoal 개정 계획 C-1). 큐와 `tx`의 API는 [state-and-files.md](state-and-files.md)에 있습니다.

- **op와 트랜잭션**: `start`, `write`, `status`, `doctor`, `state`, `clear`는 `tool.ts`에서 트랜잭션을 엽니다. `handoff`는 `ralplanHandoff`(`store.ts:1378-1394`)가 자기 트랜잭션 하나를 엽니다.
- **트랜잭션 밖의 일**: `write`의 입력 검사와 임시 `path` 파일 읽기는 트랜잭션을 열기 전에 합니다(`tool.ts:218-248`). `start`의 저장소 바인딩은 트랜잭션 안에서 `git`을 부릅니다(`captureRepositoryBinding`, 시간 제한 2초).
- **되돌리기 없음**: 트랜잭션은 줄 세우기일 뿐입니다. 첫 쓰기 뒤의 실패는 이미 쓴 파일을 남깁니다. deep-interview처럼 "모든 검사 뒤 첫 쓰기"를 보장하는 구조는 아닙니다. 대부분의 거부는 첫 쓰기 전에 나지만, 상태 한도 같은 StateStore 검사는 상태를 쓸 때마다(`writeMerged`, `src/state.ts:453-468`) 이루어지므로 `write`의 뒤쪽 상태 병합에서 실패하면 앞의 단계 파일과 원장 행이 남습니다.
- **행 동기화는 best-effort**: `start`, `write`, `state`, `clear`가 행과 스냅숏을 쓸 때는 `bestEffort`(`store.ts:286-292`)로 감싸 예외를 삼킵니다. op 결과는 바뀌지 않습니다. `handoff`의 행 쓰기는 감싸지 않습니다(`store.ts:58-61` 머리말, DR-8).

### 결과와 거부의 형식

- **정상 결과**: 대부분 2칸 들여쓰기 JSON입니다(`tool.ts:162-164`의 `json`).
- **`write`**: 사람이 읽는 한 줄(경고가 있으면 두 줄), 줄바꿈, 그다음 JSON입니다(`tool.ts:263-265`).
- **`handoff`**: 결과 줄 하나, 줄바꿈, 그다음 영수증 JSON입니다(`store.ts:1388-1393`).
- **`status`의 손상 경고**: JSON 뒤에 `WARNING:` 줄 하나가 붙습니다(`tool.ts:285`).
- **`doctor`**: 요약 객체를 JSON으로 돌려줍니다(`tool.ts:288`). deep-interview와 ultragoal의 `doctor`는 같은 요약을 gjc 텍스트(`renderDoctorText`)로 돌려주므로 형식이 다릅니다(`src/skill-state/doctor.ts:4-5` 머리말).
- **PLANNING-STUCK**: 오류가 아니라 결과입니다. `Error:`가 붙지 않습니다(ralplan 편차 1, gjc의 exit code 3).
- **거부**: op가 던진 `Error`를 `defineTool`이 잡아 `Error: <message>`로 돌려줍니다(`define.ts:46-48`, `errorText`는 `message`만 씁니다). 도구 호출 자체는 실패하지 않습니다.

## op별 허용 상태

"활성"은 상태를 읽을 수 있고 `active === true`인 것입니다. T는 `final`, `handoff`, `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`(`TERMINAL_PHASES`, `src/ralplan-runtime/manifest.ts:99-102`)입니다. 표의 칸은 이 문서의 아래 절에서 확인한 코드 경로입니다.

| op | 상태 없음 | 손상 | 활성, phase ∉ T | 활성, phase ∈ T (예: `final`) | 비활성 `final` (Stop here 뒤) | 비활성 `handoff` (넘긴 뒤) | 비활성 `complete` (`clear` 뒤) |
|---|---|---|---|---|---|---|---|
| `start` | 시드 | 거부 | 거부(활성 run) | 거부(활성 run) | 새로 씀 | 새로 씀 | 새로 씀 |
| `write` | 상태를 만듦(활성, phase = 단계) | 거부 | 쓰고 phase 전진 | 쓰고 phase 유지(잠김) | 쓰고 비활성 유지, 행은 다시 생김 | 같음 | 같은 run이면 비활성 유지, 새 run이면 활성 |
| `status` | `state: {}` | `state: {}` + 경고 줄 | 읽기 | 읽기 | 읽기 | 읽기 | 읽기 |
| `doctor` | 검사 | `schema_violation` | 검사 | 검사 | 검사 | 검사 | 검사 |
| `state` | 패치로 상태를 만듦 | 거부 | 패치(전이표) | 패치(`final`에서 나가는 간선 없음) | 패치(`{active: true}`로 다시 켬) | 패치 | phase 없는 패치는 거부, manifest phase를 주면 받음 |
| `handoff` | 거부 | 거부 | 거부(phase) | 넘김 | 거부(비활성) | 거부(이미 넘김) | 거부(비활성) |
| `clear` | 파일 생성 | `force` 필요 | `complete` (행 phase가 다르면 `force`) | `complete` | `complete` | `complete` | `force` 필요(이미 종료) |

표 밖의 조건:

- `start`는 상태와 상관없이 ultragoal 상태가 활성이면 거부합니다. 이 검사가 가장 먼저입니다([start](#start)).
- `write`는 활성 ultragoal이 있어도 거부하지 않습니다(spec R-AE1, R-O6). 그래서 ultragoal 실행 중에도 ralplan 상태를 만들거나 다시 켤 수 있습니다(루트 README "Accepted behavior differences"의 "One-mode rule partly lifted", README.md:448).
- 같은 execution의 `skill ultragoal` 게이트는 op가 아니라 훅이 `ralplanHandoffTx`를 부르는 길이므로 이 표의 `handoff` 칸과 거부 문구가 다릅니다([entry-and-handoff.md](entry-and-handoff.md)).

## 공통 도우미

### 상태 쓰기 (`writeStateTx`, `store.ts:193-247`)

모든 ralplan 상태 쓰기가 거칩니다. gjc `writeWorkflowEnvelopeAtomic`입니다(머리말 기준 `state-writer.ts:958-1067`).

1. `forced`가 아니고 다음 상태가 `active: true`이며 `current_phase`가 있으면:
   - 그 phase가 manifest 상태(9개 단계와 `handoff`, `RALPLAN_STATES`)가 아니면 거부합니다: `Refusing to write unknown ralplan phase "<phase>" to <statePath>: not a known ralplan manifest state`
   - 출발 phase(감사 입력의 `fromPhase`, 없으면 이전 상태가 활성일 때의 phase)가 manifest 상태이고 도착과 다르며 전이표에 없으면, 감사 행 `state/invalid_transition_detected`를 먼저 남기고 **그래도 씁니다**(spec D-T11). 이 감사 행 쓰기의 실패는 삼킵니다.
2. `tx.writeState(next, writer)`로 파일 전체를 바꿉니다. 병합이 아닙니다. writer는 런타임이면 `ralplan_tool`, 훅이면 `ralplan_hook`이고 `_meta.updatedBy`에 남습니다. StateStore가 `_meta`를 새로 붙이고 한도를 검사합니다.
3. 감사 행 `state/<verb>`(기본 `write`)를 남깁니다. `mutation_id`를 주지 않은 호출(`start`, `write` 안의 상태 쓰기)은 UUID가 들어가고 `from_phase`·`to_phase`가 빠집니다.

### 손상 상태 거부 (`readStateForMutation`, `store.ts:250-260`)

`start`(안의 `startRunTx`), `write`, `handoff`가 씁니다. 상태 파일이 없으면 `undefined`, 있으면 `_meta`를 뗀 사본을 돌려줍니다. 읽기가 예외를 던지면 거부합니다.

```
existing ralplan state is corrupt or tampered (<error>); refusing to overwrite <statePath>. Reset it with `ralplan clear` and force: true.
```

`<error>`는 StateStore의 문구입니다(`src/state.ts:382-405`, `256-268`). 예: `state file is corrupted; it was preserved`(JSON 아님), `state file is invalid; it was preserved: <한도 오류>`, `state scope does not match this session; it was preserved`. `state`와 `clear`는 같은 경우를 자기 문구로 거부하고, `status`는 경고만 붙입니다.

### 행 동기화

`start`, `write`, `state`, `clear`는 상태를 쓴 뒤 공통 `syncActiveRowTx`(`src/skill-state/rows.ts:149-162`)를 부릅니다. 활성이면 위쪽 파이프라인 행(ralplan에게는 `deep-interview` 행)을 지우고 `state/active/ralplan.json`을 쓰며, 비활성이면 그 행을 지웁니다. 그다음 스냅숏 `state/skill-active-state.json`을 행 파일들로 다시 만듭니다. 행의 `phase`는 `start`·`state` 뒤에는 상태의 `current_phase`, `write` 뒤에는 방금 쓴 단계입니다(DR-8, R-OD5). 행과 HUD 칩의 모양은 [state-and-files.md](state-and-files.md)에 있습니다.

## `start`

새 run을 시드합니다. 검사는 `tool.ts:189-211`의 `start`가, 쓰기는 `startRunTx`(`store.ts:915-988`)가 같은 트랜잭션 안에서 합니다. gjc 출처는 `seedRalplanState`와 `handleConsensusHandoff`(머리말 기준 `ralplan-runtime.ts:2382-2475`)입니다.

- **입력**: `task`, `interactive?`, `deliberate?`, `run_id?`
- **검사 순서** (deep-interview 개정 계획 DR-37, E-13, E-15, DR-39):

  | 순서 | 검사 | 거부 문구 |
  |---|---|---|
  | 1 | ultragoal 상태(`state/ultragoal-state.json`)를 읽을 수 있고 `active === true` | `ralplan cannot be started while ultragoal is active; call ultragoal handoff(to="ralplan", reason) instead, which makes ralplan active in its planner phase.` (`RALPLAN_ACTIVATION_REFUSAL`, `tool.ts:70-71`) |
  | 2 | ralplan 상태를 읽을 수 있고 `active === true` | `ralplan run <run_id> is already active (phase <phase>); continue it with ralplan write. To plan anew, stop it first with ralplan state {"active": false} or ralplan clear.` (`ralplanRunActiveRefusal`, `tool.ts:73-78`) |
  | 3 | `task`를 trim해서 비었음 | `ralplan start requires a task description, e.g. task: "<task>".` |
  | 4 | ralplan 상태가 손상(`startRunTx` 안의 `readStateForMutation`) | 위 [손상 상태 거부](#손상-상태-거부-readstateformutation-storets250-260) 문구 |
  | 5 | 상태에 남은 `run_id`가 경로 성분 규칙에 맞지 않음(`activeRunId`, `store.ts:498-503`). 명시한 `run_id`가 있어도 먼저 검사합니다(`:923`이 `run_id`를 고르는 `:925`보다 앞) | `invalid path component for run_id: <value>` |
  | 6 | 정한 `run_id`가 경로 성분 규칙에 맞지 않음(`tx.paths.runDir`) | `invalid path component for run_id: <value>` |

  - 1과 2는 읽기 실패를 "활성 아님"으로 봅니다(`.catch(() => undefined)`). 그래서 손상된 ultragoal 상태는 `start`를 막지 않고(테스트 "RP1"), 손상된 ralplan 상태는 2를 지나 4에서 거부됩니다(테스트 "RP5").
  - 2의 `<run_id>`·`<phase>`는 문자열이 아니면 `(none)`입니다. 상태에 `handoff_from`이 있으면 phase 뒤에 `, handed over from <skill>`이 붙습니다. 예: `ralplan run r1 is already active (phase planner, handed over from ultragoal); …`(테스트 "RP4").
  - 2는 상태 파일만 봅니다. 행이 없어도 상태가 활성이면 거부합니다(테스트 "RP3", U4-1 A). 둘 다 활성이면 1이 먼저입니다(E-15).
  - 경로 성분 규칙(`safeComponent`, `src/state.ts:204-208`): 첫 글자 `[A-Za-z0-9_-]`, 그 뒤 `[A-Za-z0-9._-]` 63자까지, `..` 없음.
  - 5에 걸리는 상태: `state` op는 `run_id`를 막지 않으므로([state](#state)의 4) 규칙에 맞지 않는 값이 들어갈 수 있고, `clear`도 그 값을 남깁니다. 그러면 `start`(명시한 `run_id`가 있어도)와 `handoff`([handoff](#handoff)의 3a)가 거부되고, `run_id` 없는 `write`도 같은 검사(`store.ts:643`)에서 거부됩니다. 명시한 `run_id`가 있는 `write`는 이 검사를 건너뛰고 새 run으로 상태의 `run_id`를 바꿉니다. 고치는 법은 `state(patch={"run_id": null})`이고, `clear` 뒤에는 phase가 manifest 밖이라 `state(patch={"run_id": null, "current_phase": "planner"})`처럼 phase를 함께 줘야 합니다. 실행해 확인: 비활성 `final`에 `{run_id: "../bad"}`를 넣으면 `start(run_id: "good")`가 `Error: invalid path component for run_id: ../bad`이고, `{run_id: null}` 뒤 같은 `start`는 성공했습니다. `clear` 뒤에는 `{run_id: null}`이 `unknown ralplan phase "complete"`로 거부되고, `{run_id: null, current_phase: "planner"}` 뒤 `start`가 성공했습니다. `write(run_id: "good")`도 성공했습니다(`run_id` 없는 `write`의 거부는 코드로만 확인).
- **run id**: trim한 `run_id`, 없으면 상태의 `run_id`, 없으면 소유 세션 id입니다(DR-19, ralplan 편차 31). 상태의 `run_id`를 이어 쓰면 그 run 폴더의 단계 파일과 `index.jsonl`도 그대로이므로 반복 예산이 이어집니다. 새 예산은 새 `run_id`로 엽니다.
- **저장소 바인딩**: 같은 run이고 상태에 `repository_binding`이 있으면 그것을, 아니면 `captureRepositoryBinding(projectDir)`(`src/ralplan-runtime/binding.ts:63-93`)로 새로 잡습니다. 기록만 하고 검사하지 않습니다(ralplan 편차 12).
- **새 상태**: 병합이 아니라 통째로 씁니다(`store.ts:938-956`). 키는 `active: true`, `current_phase: "planner"`, `skill`, `version: 2`, `mode`(`deliberate: true`면 `"deliberate"`, 아니면 `"short"`), `interactive`(`true`가 아니면 `false`), `task`(trim하지 않은 입력 그대로), `run_id`, `updated_at`, `repository_binding`, `session_id`(루트)입니다. 이전 상태의 역할 id, verdict, `planning_stuck`, `auto_handoff`, `handoff_*`는 남지 않습니다. `StartRunInput`의 `handoff_from`·`handoff_at`은 내부 호출자용이고 이 op는 넘기지 않습니다.
- **쓰는 것**: 상태와 감사 행 `state/write`(UUID `mutation_id`, phase 없음) → 행 동기화(phase `planner`, HUD `latestSummary` `<mode> run · <interactive|automated>`, 위쪽 deep-interview 행이 있으면 `state/remove-superseded-pipeline-entry`) → 스냅숏.
- **결과**: `{ok: true, session_id, skill, mode, state_path, run_id, handoff, repository_binding}`. `handoff`는 gjc의 `/skill:ralplan`을 호스트 skill id로 바꾼 `"ralplan"`입니다.

  ```json
  {
    "ok": true,
    "session_id": "ses_root",
    "skill": "ralplan",
    "mode": "deliberate",
    "state_path": "<session>/state/ralplan-state.json",
    "run_id": "ses_root",
    "handoff": "ralplan",
    "repository_binding": {
      "schema": "gjc.repository_binding.v1",
      "worktreeRoot": "<project>",
      "commonDir": null,
      "displayPath": "<project>"
    }
  }
  ```

  (`task: "ship the cli", deliberate: true`. 임시 프로젝트는 git 저장소가 아니라 `commonDir`가 `null`이고 `head`·`branch`가 없습니다.) 감사 행 셋:

  ```
  {"ts":"2026-10-03T15:02:40.459Z","skill":"ralplan","category":"state","verb":"write","owner":"open-gajae-runtime","mutation_id":"6e8879c4-ae75-4410-a01b-5d7757c1472f","forced":false,"paths":["<session>/state/ralplan-state.json"]}
  {"ts":"2026-10-03T15:02:40.461Z","category":"state","verb":"write-active-entry","owner":"open-gajae-runtime","mutation_id":"6ad3c571-b0a8-4e77-b92b-d25e23a90f14","forced":false,"paths":["<session>/state/active/ralplan.json"]}
  {"ts":"2026-10-03T15:02:40.461Z","category":"state","verb":"rebuild-active-snapshot","owner":"open-gajae-runtime","mutation_id":"63ef2c65-51df-4a36-bb09-af7fc3b41573","forced":false,"paths":["<session>/state/skill-active-state.json"]}
  ```

- **두 번째 `start`**: `Error: ralplan run ses_root is already active (phase planner); continue it with ralplan write. To plan anew, stop it first with ralplan state {"active": false} or ralplan clear.`

**같은 `startRunTx`를 쓰는 다른 길**: deep-interview의 결합 호출 `spec(…, handoff: "ralplan")`은 `src/tools.ts:61-62`에서 주입한 콜백으로 `startRunTx`를 바로 부릅니다. 위 1–3을 거치지 않으므로 활성 ultragoal이나 활성 ralplan run이 있어도 시드합니다(ralplan 편차 39의 마지막 문장, deep-interview K12). [entry-and-handoff.md](entry-and-handoff.md)를 보십시오.

## `write`

stage 산출물 하나를 기록합니다. 입력 검사는 `tool.ts:213-248`의 `write`가 트랜잭션 밖에서 하고, 기록은 `writeStageTx`(`store.ts:635-880`)가 트랜잭션 안에서 합니다. gjc 출처는 `resolveArtifactArgs`(`ralplan-runtime.ts:1535-1583`)와 `handleArtifactWrite`(`:2033-2261`, DR-2 순서)입니다(머리말 기준).

- **입력**: `stage`, `stage_n`, `content` 또는 `path`, `run_id?`, `lane_verdict?`, `resumable?`, `fallback_reason?`, `fallback_attempted_id?`, `fallback_stage_n?`, `fallback_receipt_path?`

### 도구 쪽 검사 (트랜잭션 밖)

| 순서 | 검사 | 거부 문구 |
|---|---|---|
| 1 | 역할 agent가 `path`를 줬음(R-O4, 다른 검사보다 먼저) | `<agent> must pass the artifact as content; path is for the primary agent only` |
| 2 | `stage`가 없음 | `stage is required for ralplan write` |
| 3 | `stage`가 9개 단계가 아님(`assertRalplanStage`, `manifest.ts:136-144`) | `unknown stage: <stage>. Expected one of: planner, intent, architect, critic, disposition, revision, post-interview, adr, final.` |
| 4 | `stage_n`이 1..999 정수가 아님(`parseStageN`, `ledger.ts:341-351`) | `invalid stage_n: <value>. Expected integer 1..999.` (빠지면 `<value>`가 `undefined`) |
| 5 | `content`와 `path`가 둘 다 없음 | `content or path is required for ralplan write` |
| 6 | 둘 다 있음 | `content and path are mutually exclusive` |
| 7 | `path`면 임시 파일 읽기(`readTempArtifact`, `temp-paths.ts:94-122`) | 아래 표 |
| 8 | 본문이 빈 문자열 `""` | `artifact content is empty` |
| 9 | 역할 메타데이터(`parsePersistedRoleState`, `ledger.ts:931-1013`) | 아래 요약 |
| 10 | lane verdict(`parseLaneVerdict`, `ledger.ts:1035-1053`) | 아래 요약 |

**임시 `path`** (주 agent만, DR-11, ralplan 편차 30): `isNeutralTempPath`(`temp-paths.ts:71-87`)가 경로를 `projectDir` 기준으로 풀고, 프로젝트 밖이며 OS 임시 루트(`os.tmpdir()`, `$TMPDIR`, `/tmp`, `/var/tmp`, `/private/tmp`, `/private/var/tmp`) 안인지 봅니다. symlink와 `/tmp` → `/private/tmp` 별칭을 푼 뒤에도 다시 봅니다. 그다음 `O_NOFOLLOW | O_NONBLOCK`으로 열어 일반 파일인지 확인하고 UTF-8로 읽습니다.

| 경우 | 문구 |
|---|---|
| 임시 루트 밖이거나 프로젝트 안 | `ralplan write path must be a file under an OS temp directory outside the project: <path>` |
| 열기 실패(없음, 마지막 성분이 symlink 등) | `failed to read ralplan write path <절대 경로>: <오류>` |
| 일반 파일이 아님 | `ralplan write path is not a regular file: <절대 경로>` |

**본문 검사**: 8은 정확히 `""`만 거부합니다. 공백만 있는 본문은 지나갑니다. 빈 임시 파일도 8에서 거부됩니다.

**역할 세션 id 기록** (ralplan 편차 5, `tool.ts:235-239`): 부른 agent가 역할이고 이 단계가 그 역할의 lane(`planner`·`revision` → planner, `architect`, `critic`)일 때만 그 역할의 `context.sessionID`를 기록합니다. 다른 lane의 단계를 쓰는 역할(예: architect가 `revision`)은 거부되지 않고 id만 남지 않습니다. 주 agent의 쓰기도 id를 남기지 않습니다. `resumable`과 fallback 필드는 부른 agent가 아니라 단계의 lane 역할에 붙습니다(주 agent가 `revision`에 `resumable: false`를 주면 `planner_resumable: false`). 규칙 전체는 [stages-and-ledger.md](stages-and-ledger.md) 9.1절에 있습니다.

**9와 10의 거부** (순서와 문구 전체는 [stages-and-ledger.md](stages-and-ledger.md) 9.2절과 8장):

- 역할 lane이 없는 단계(`intent`, `disposition`, `post-interview`, `adr`, `final`)에 `resumable`이나 fallback 필드를 주면 거부합니다.
- 기록할 세션 id와 `fallback_attempted_id`는 `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`에 맞아야 합니다.
- fallback 필드를 하나라도 주면 `fallback_reason`(6개 값 중 하나), `fallback_attempted_id`, `fallback_stage_n`(1..999)이 모두 있어야 합니다. `fallback_receipt_path`는 선택이지만 공백뿐이면 거부합니다.
- `lane_verdict`는 `architect`(`CLEAR`·`WATCH`·`BLOCK`)와 `critic`(`OKAY`·`ITERATE`·`REJECT`)에만 받고, trim하고 대문자로 바꿔 비교합니다.

실제 출력 몇 가지:

```
Error: open-gajae-planner must pass the artifact as content; path is for the primary agent only
Error: invalid stage_n: undefined. Expected integer 1..999.
Error: lane_verdict is only valid with stage architect or critic (received intent).
Error: ralplan write path must be a file under an OS temp directory outside the project: <project>/intent.md
Error: fallback_attempted_id is required when recording critic fallback metadata.
```

### `writeStageTx`의 단계

검사를 모두 지나면 트랜잭션 하나 안에서 `writeStageTx`(`store.ts:635-880`)가 gjc `handleArtifactWrite`의 순서(DR-2)대로 진행합니다. 단계별 코드 위치와 거부 문구, 실제 감사 행 순서는 [stages-and-ledger.md](stages-and-ledger.md) 1.2–1.3절에 있습니다.

1. 상태를 읽고(손상이면 [손상 상태 거부](#손상-상태-거부-readstateformutation-storets250-260)), `run_id`를 정해(명시값 → 상태의 값 → 소유 세션 id) 경로 성분을 검사합니다.
2. `index.jsonl`을 한 번 읽고, `disposition`이면 원장과 대조해 정규화하며(`invalid ralplan disposition artifact: <사유>`), 끝 줄바꿈을 보장해 sha256을 냅니다.
3. 같은 `(stage, stage_n)`이 원장에 있거나(원장 중복) 행 없이 단계 파일만 있으면(원장 복구): 같은 본문이면 중복 영수증으로 끝나고, 다른 본문이면 덮어쓰기 거부입니다.
4. run 폴더 목록을 읽습니다(`tx.list`, `store.ts:762`). run 폴더나 그 위의 폴더가 symlink이거나 폴더가 아니면 `state path contains a symlink or non-directory`(`src/state.ts:375-376`, `556-557`)로 거부합니다.
5. opener 반복 상한, 그다음 lane 예산을 봅니다. 넘으면 막힘을 기록하고 PLANNING-STUCK 결과로 끝납니다.
6. `final`이면 승인 판정(`auto_handoff`)을 파일을 쓰기 전에 정합니다.
7. 상태(만들기, run 전환, phase 전진, 잠긴 phase는 그대로) → 단계 파일 → `index.jsonl` 한 줄 → (`final`) `pending-approval.md` → 역할 메타데이터·lane verdict·승인 병합 → 활성 행과 스냅숏(best-effort) → 영수증.

감사 행은 상태를 쓸 때마다 `state/write`(전이표 밖 간선이면 그 앞에 `state/invalid_transition_detected`), 파일마다 `artifact/write`, 원장 행마다 `ledger/append`, 그리고 행·스냅숏 행입니다. 덮어쓰기 거부의 실제 출력:

```
Error: refusing to overwrite ralplan planner stage 1 at <session>/plans/ralplan/ses_root/stage-01-planner.md: an artifact with different content already exists (existing sha256=07b803f377de79b3fa15d840e68b28fe7c0d8cc5d37d993a612986702eb7e5a7, new sha256=b5b79e2b70a4030a0d207081f0982cccc59a5d906d506d1975b1dfc91cb4bc0c). Use a new stage_n to record another pass.
```

상태 없이 쓰기(`start` 없이도 상태를 만듦)와 잠긴 phase 위의 쓰기(Stop here·`clear`·`handoff` 뒤: `active`와 phase는 그대로지만 역할 id·verdict·승인은 병합되고 활성 행은 다시 생김)는 [stages-and-ledger.md](stages-and-ledger.md) 6.2절과 6.4절에 있습니다.

### 결과

결과는 영수증과 PLANNING-STUCK 두 가지이고(`StageWriteResult`, `store.ts:626-628`), 도구는 둘 다 "한 줄, 줄바꿈, JSON"으로 돌려줍니다(`tool.ts:263-265`). 필드와 첫 줄 문구는 [stages-and-ledger.md](stages-and-ledger.md) 12장(영수증)과 7.4절(PLANNING-STUCK)에 있습니다.

**영수증**: architect 역할이 `architect` 1회차를 `lane_verdict: "clear"`, `resumable: true`로 쓴 결과입니다.

```
Persisted ralplan architect stage 1 at <session>/plans/ralplan/ses_root/stage-01-architect.md.
{
  "session_id": "ses_root",
  "run_id": "ses_root",
  "path": "<session>/plans/ralplan/ses_root/stage-01-architect.md",
  "stage": "architect",
  "stage_n": 1,
  "sha256": "9b1dee03c7ee993161122ef0ea013bad68c84168d36f40846b260f305e5821d0",
  "repository_binding": {…},
  "created_at": "2026-10-03T15:02:40.472Z",
  "architect_state": {
    "architect_id": "ses_architect",
    "architect_resumable": true
  },
  "lane_verdict": {
    "lane": "architect",
    "verdict": "CLEAR"
  }
}
```

**중복 영수증**: planner 역할이 `"# Plan\n\ndraft"`를 쓴 뒤 `"# Plan\n\ndraft\n"`을 다시 쓴 결과입니다(끝 줄바꿈을 붙이면 같은 본문). 원장 중복은 아무것도 쓰지 않습니다.

```
ralplan planner stage 1 already persisted at <session>/plans/ralplan/ses_root/stage-01-planner.md (identical content; no changes written).
{
  "session_id": "ses_root",
  "run_id": "ses_root",
  "path": "<session>/plans/ralplan/ses_root/stage-01-planner.md",
  "stage": "planner",
  "stage_n": 1,
  "sha256": "07b803f377de79b3fa15d840e68b28fe7c0d8cc5d37d993a612986702eb7e5a7",
  "repository_binding": {…},
  "created_at": "2026-10-03T15:02:40.464Z",
  "deduplicated": true
}
```

**PLANNING-STUCK**: `maxIterations: 1` 설정에서 `planner` 1회차 뒤 `revision` 2회차를 쓴 결과입니다(`source` 값은 스크립트가 설정에 넣은 문자열입니다). 단계 파일과 행은 쓰지 않고 막힘 행과 상태의 `planning_stuck`만 씁니다([stages-and-ledger.md](stages-and-ledger.md) 7.5절). 오류가 아니므로 `Error:`가 붙지 않습니다.

```
PLANNING-STUCK: ralplan consensus iteration cap exceeded: opening revision would start iteration 2 (max 1) (run_id=ses_root, stage=revision, stage_n=2, source=<project>/.open-gajae/open-gajae.jsonc). Stop opening planner/revision passes; escalate the best existing plan via final/pending-approval without auto-implementation.
{
  "ok": false,
  "planning_stuck": true,
  "marker": "PLANNING-STUCK",
  "run_id": "ses_root",
  "stage": "revision",
  "stage_n": 2,
  "iteration": 1,
  "projected_iteration": 2,
  "max_iterations": 1,
  "max_iterations_source": "<project>/.open-gajae/open-gajae.jsonc",
  "reason": "ralplan consensus iteration cap exceeded: opening revision would start iteration 2 (max 1)"
}
```

**SKILL만 요구하는 것**: 패스마다 `stage_n`을 올릴 것, 모든 배정에 `run_id`를 넣을 것, 역할은 영수증만 돌려줄 것(RECEIPT-ONLY), 역할은 자기 lane의 단계만 쓸 것, architect·critic이 `lane_verdict`를 넣을 것. 코드는 `stage_n`의 순서, 단계의 차례, 부른 역할과 단계의 짝을 검사하지 않습니다(전이표 밖 간선은 감사 행만 남김). [roles-and-consensus.md](roles-and-consensus.md)를 보십시오.

## `status`

상태를 읽어 보여 줍니다. 아무것도 쓰지 않습니다. `readStatusTx`(`store.ts:1267-1283`), gjc `gjc state read ralplan`(OQ4, 머리말 기준 `state-runtime.ts:1156-1222`)입니다. 역할도 부를 수 있습니다.

- **입력**: `fields?`. 값은 `STATE_FIELD_ALLOWLIST`(`store.ts:1192-1214`)의 21개입니다: `skill`, `phase`, `current_phase`, `next`, `active`, `status`, `fresh`, `fresh_until`, `receipt`, `artifact_path`, `plan_path`, `spec_path`, `run_id`, `stage`, `stage_n`, `session_id`, `updated_at`, `handoff_to`, `handoff_from`, `counts`, `hud`.
- **`fields`가 없을 때**: `{skill: "ralplan", state, storage_path}`. 상태가 없으면 `state: {}`입니다. `state`는 StateStore가 읽은 객체 그대로라 `_meta`가 **들어 있습니다**(deep-interview의 `status`는 `_meta`를 뗍니다). 예(`architect` 뒤 `revision`까지 쓴 run, 가운데를 줄임):

  ```json
  {
    "skill": "ralplan",
    "state": {
      "active": true,
      "current_phase": "revision",
      "skill": "ralplan",
      "version": 2,
      "mode": "deliberate",
      "interactive": false,
      "task": "ship the cli",
      "run_id": "ses_root",
      …,
      "planner_subagent_id": "ses_planner",
      "planner_resumable": true,
      "architect_id": "ses_architect",
      "architect_resumable": true,
      "last_review_verdict": "CLEAR",
      "last_review_verdict_lane": "architect",
      "last_review_verdict_stage_n": 1,
      "_meta": {
        "mode": "ralplan",
        "sessionId": "ses_root",
        "updatedAt": "2026-10-03T15:02:40.475Z",
        "updatedBy": "ralplan_tool"
      }
    },
    "storage_path": "<session>/state/ralplan-state.json"
  }
  ```

- **`fields`가 있을 때** (`projectStateFields`, `store.ts:1224-1261`, gjc `state-renderer.ts:82-190`): 고른 필드만 냅니다.
  - `skill`은 늘 `ralplan`입니다.
  - `phase`·`current_phase`는 상태의 `current_phase`, 없으면 `phase`, 그것도 없으면 `planner`입니다. 그래서 상태가 없어도 `"current_phase": "planner"`가 나옵니다.
  - `next`는 전이표(`RALPLAN_TRANSITIONS`)에서 그 phase를 출발점으로 하는 행의 도착 phase들입니다. `final`과 `handoff`는 `[]`입니다.
  - `fresh`는 상태의 `receipt.fresh_until`이 지금보다 뒤인지입니다. ralplan 상태에는 `receipt`가 없으므로(`state` op의 영수증은 행에만 씀, ralplan 편차 17) 보통 `false`이고, `fresh_until`·`receipt`는 빠집니다.
  - 그 밖은 상태의 같은 이름 필드입니다. 값이 없으면 JSON에서 빠집니다(예: `stage`, `stage_n`, `plan_path`는 ralplan 상태에 없음).

  ```json
  {
    "skill": "ralplan",
    "current_phase": "revision",
    "next": [
      "intent",
      "post-interview",
      "adr",
      "handoff"
    ],
    "active": true,
    "run_id": "ses_root",
    "fresh": false
  }
  ```

  (`fields: ["skill", "current_phase", "next", "active", "run_id", "fresh", "stage"]`. `stage`는 빠졌습니다.)
- **손상**: 거부하지 않습니다. 결과는 `state: {}`(또는 빈 상태 위의 투영)이고 뒤에 한 줄이 붙습니다.

  ```
  {
    "skill": "ralplan",
    "state": {},
    "storage_path": "<session>/state/ralplan-state.json"
  }
  WARNING: failed to read <session>/state/ralplan-state.json; ignoring corrupt state: state file is corrupted; it was preserved
  ```

## `doctor`

ralplan의 상태, 행, 스냅숏을 읽기 전용으로 검사합니다. `doctorTx`(`store.ts:1286-1288`)가 공통 `collectDoctorSummaryTx(tx, "ralplan")`(`src/skill-state/doctor.ts:149-279`, gjc `collectDoctorSummary`, D-T13)를 부르고, 도구는 그 객체를 JSON으로 돌려줍니다. 아무것도 고치지 않습니다. 검사 항목의 세부는 [state-and-files.md](state-and-files.md)에 있습니다.

- **입력**: 없음. 주 agent만 부를 수 있습니다.
- **보고 종류** 두 가지와 고치는 명령:
  - `schema_violation`(`fixCommand` `ralplan clear (force: true)`): 상태를 읽을 수 없음(`mode-state JSON is unreadable: <error>`), envelope 검사 실패(`workflowEnvelopeError`), 알려진 phase(manifest 상태와 R, `KNOWN_PHASES`) 밖의 phase(`unknown ralplan phase "<phase>"`, DR-21).
  - `stale_active_state`(`fixCommand` `ralplan clear`): 활성 행이 있는데 상태가 없거나 비활성(`active entry for ralplan does not match a live active mode-state`), 스냅숏이 행 없는 활성 항목을 가짐, 행이나 스냅숏의 phase가 상태의 phase와 다름(`… phase <a> differs from canonical mode-state phase <b>`).
- **결과 모양**: `{ok, root, summary: {skills_scanned, files_scanned, findings_total, by_kind: {schema_violation, stale_active_state}}, problems: [{type, skill, path, message, fixCommand}]}`. `journals_scanned`는 없습니다(ralplan 편차 13). `skills_scanned`는 늘 1이고, `files_scanned`는 상태 파일, `state/active/`의 모든 `.json` 행 파일(다른 skill의 것 포함), 스냅숏을 셉니다.
- **실제 출력**: 문제가 없을 때와, 상태 파일을 `{`로 망가뜨렸을 때입니다. 둘째는 Stop here와 `clear` 뒤라 행 파일이 없을 때입니다.

  ```json
  {
    "ok": true,
    "root": "<session>/state",
    "summary": {
      "skills_scanned": 1,
      "files_scanned": 3,
      "findings_total": 0,
      "by_kind": {
        "schema_violation": 0,
        "stale_active_state": 0
      }
    },
    "problems": []
  }
  ```

  ```json
  {
    "ok": false,
    "root": "<session>/state",
    "summary": {
      "skills_scanned": 1,
      "files_scanned": 2,
      "findings_total": 1,
      "by_kind": {
        "schema_violation": 1,
        "stale_active_state": 0
      }
    },
    "problems": [
      {
        "type": "schema_violation",
        "skill": "ralplan",
        "path": "<session>/state/ralplan-state.json",
        "message": "mode-state JSON is unreadable: JSON Parse error: Expected '}'",
        "fixCommand": "ralplan clear (force: true)"
      }
    ]
  }
  ```

  행이 있는 진행 중 run(예: `start` 직후)의 상태를 망가뜨리면 `files_scanned`가 3, `findings_total`이 2이고, `state/active/ralplan.json`에 대한 `stale_active_state`(`active entry for ralplan does not match a live active mode-state`, `fixCommand` `ralplan clear`)가 하나 더 나옵니다(`doctor.ts:224-232`, 실행해 확인). 이때도 `clear`는 손상 상태 때문에 `force`가 필요합니다.

- **알려진 보고**: 잠긴 phase(`final`, `complete` 등) 위의 쓰기 뒤에는 행의 phase가 방금 쓴 단계라서 `stale_active_state`가 나옵니다. gjc와 같고(R-OD8), SKILL(SKILL.md:32)과 루트 README("Known behavior", README.md:189)는 이 보고만으로 `clear`하지 말라고 안내합니다. 테스트 "rows follow the stage just written, doctor reports drift, …"가 확인합니다.

## `state`

상태에 패치를 병합합니다. gjc `gjc state ralplan write`(머리말 기준 `state-runtime.ts:1235-1400`)이고, `--force`와 `--replace`가 없으며 중첩 `state` 객체를 펼치지 않습니다(ralplan 편차 38, R-OD19). `patchStateTx`(`store.ts:1001-1079`)가 맡습니다. 역할도 부를 수 있습니다.

- **입력**: `patch`(객체). 없으면 도구가 `patch is required for ralplan state`로 거부합니다(`tool.ts:290`).
- **검사와 계산 순서**:
  1. 상태를 읽습니다. 손상이면 ``existing state for ralplan is corrupt or tampered (<error>); reset it with `ralplan clear` and force: true``. 상태가 없으면 빈 객체에서 시작합니다(거부하지 않음).
  2. `mutation_id`를 정합니다: `ralplan:<at>`. continuation breaker가 부를 때는 `ralplan:breaker-exhausted:<at>`이고 감사 `owner`가 `open-gajae-hook`입니다(`src/hooks.ts:513-519`, R-O3).
  3. 패치에서 `_meta`를 뗍니다. 들어온 phase는 trim한 `patch.current_phase`, 없으면 `patch.phase`입니다.
  4. 얕은 병합: 값이 `null`인 키는 지우고, 나머지는 그대로 덮습니다. 중첩 객체는 통째로 바뀝니다. `phase` 키도 필드로 남습니다. 런타임이 쓰는 필드(`run_id`, `planning_stuck`, `auto_handoff`, `last_review_verdict*`, 역할 id, `handoff_*`, `repository_binding`, `task`, `mode`)를 막는 목록은 없습니다(deep-interview의 `state`와 다름).
  5. 병합 결과를 `workflowEnvelopeError`(`src/skill-state/doctor.ts:64-79`)로 검사합니다. 문구: `state skill must match selected mode ralplan`, `state.active must be a boolean when present`, `state.current_phase must be a string when present`, `state.version must be a number when present`, `state.updated_at must be a string when present`, `state.receipt must be an object when present`.
  6. 런타임 필드를 채웁니다: `skill: "ralplan"`, `current_phase`(들어온 phase, 없으면 병합 결과의 phase를 trim, 그것도 없으면 이전 phase, 없으면 `planner`), `version: 2`, `active`(boolean이 아니면 `true`), `updated_at`, `session_id`(문자열이 아니면 루트 id).
  7. 도착 phase가 manifest 상태(9개 단계와 `handoff`)가 아니면 `unknown ralplan phase "<phase>"`.
  8. 출발 phase(이전 상태의 `current_phase`, 활성 여부와 상관없음)가 manifest 상태이고, 같은 phase도 전이표의 간선도 아니면 `invalid ralplan phase transition from <a> to <b>`(AC12).
  9. 다시 `workflowEnvelopeError`.
- **쓰는 것**: `writeStateTx`(감사 행 `state/write`, `mutation_id`, `from_phase`, `to_phase`) → 행 동기화. `active !== false`면 행을 쓰고(위쪽 deep-interview 행은 지움), `false`면 행을 지웁니다. 행에는 gjc의 상태 쓰기 영수증(`stateWriteReceipt`, `store.ts:295-313`: `command: "ralplan state"`, `fresh_until`은 30분 뒤, `status: "fresh"`)이 붙습니다.
- **결과**: `{ok: true, skill, state_path, current_phase, active, mutation_id}`.

**Stop here** (SKILL step 9, spec D-F12): `state(patch={"active": false})`입니다. `final`에서 `final`로 가므로 전이 검사를 지나고, phase는 `final`로 남으며, 행이 지워집니다(R-OD10). 실제 결과와 감사 행:

```json
{
  "ok": true,
  "skill": "ralplan",
  "state_path": "<session>/state/ralplan-state.json",
  "current_phase": "final",
  "active": false,
  "mutation_id": "ralplan:2026-10-03T15:02:40.483Z"
}
```

```
{"ts":"2026-10-03T15:02:40.483Z","skill":"ralplan","category":"state","verb":"write","owner":"open-gajae-runtime","mutation_id":"ralplan:2026-10-03T15:02:40.483Z","from_phase":"final","to_phase":"final","forced":false,"paths":["<session>/state/ralplan-state.json"]}
{"ts":"2026-10-03T15:02:40.483Z","category":"state","verb":"remove-active-entry","owner":"open-gajae-runtime","mutation_id":"78edbb26-6337-4c53-8ad3-6843dcbb3bfe","forced":false,"paths":["<session>/state/active/ralplan.json"]}
{"ts":"2026-10-03T15:02:40.484Z","category":"state","verb":"rebuild-active-snapshot","owner":"open-gajae-runtime","mutation_id":"e118165f-e63d-4708-a9b5-a2ae135e4d62","forced":false,"paths":["<session>/state/skill-active-state.json"]}
```

같은 상태에서 받은 거부들(`final`에서 나가는 간선은 전이표에 없습니다):

```
Error: unknown ralplan phase "bogus"
Error: invalid ralplan phase transition from final to handoff
Error: state.active must be a boolean when present
```

**상태별로 주의할 동작** (이 문서를 쓰며 실행해 확인):

- **`clear` 뒤**: 상태의 phase가 `complete`이고 이것은 manifest 상태가 아니므로, phase를 주지 않는 패치는 모두 7에서 `Error: unknown ralplan phase "complete"`로 거부됩니다. `{active: false}`(실행해 확인)와 `{active: true}`(같은 코드 경로)도 마찬가지입니다. manifest phase를 주면 출발 phase가 manifest 밖이라 8을 건너뛰고 받습니다. 이때 `active`는 기존 `false`가 boolean이라 그대로 남습니다(`{current_phase: "planner"}`의 결과가 `"active": false`). gjc는 같은 경우를 `--force`로 넘길 수 있지만 여기에는 그 입력이 없습니다(ralplan 편차 38).
- **상태가 없을 때**: `{active: false}`가 `{active: false, skill, current_phase: "planner", version: 2, updated_at, session_id}`를 새로 만듭니다.
- **다시 켜기**: Stop here 뒤 `{active: true}`는 `final → final`이라 받고 행을 다시 씁니다. 테스트 "handoff refuses an inactive ralplan after Stop here, clear or a handoff; …"가 이 뒤 `handoff`가 성공함을 확인합니다.
- **역할의 `state`**: 역할도 이 op를 부를 수 있으므로 역할이 phase를 바꾸거나 run을 멈출 수 있습니다. 역할 프롬프트는 이 op를 쓰라고 하지 않습니다.

## `handoff`

끝난 계획을 ultragoal로 넘기거나 deep-interview로 되돌립니다. `ralplanHandoff`(`store.ts:1378-1394`)가 트랜잭션 하나를 열고 `ralplanHandoffTx`(`store.ts:1328-1371`)를 부릅니다. 같은 `ralplanHandoffTx`를 같은 execution의 `skill ultragoal` 게이트도 씁니다(`src/hooks.ts:811`, 감사 `owner` `open-gajae-hook`). 공통 저널 인계의 단계와 감사 행, 되돌아가는 쪽의 상태는 [entry-and-handoff.md](entry-and-handoff.md)에 있습니다.

- **입력**: `to`(`ultragoal` \| `deep-interview`). 없으면 도구가 `to must be "ultragoal" or "deep-interview"`로 거부합니다(`tool.ts:297`).
- **검사 순서**:

  | 순서 | 검사 | 거부 문구 |
  |---|---|---|
  | 1 | ralplan 상태 손상 | [손상 상태 거부](#손상-상태-거부-readstateformutation-storets250-260) 문구 |
  | 2 | 상태 없음 | `there is no ralplan state in this session to hand off` |
  | 3 | phase ∉ T (DR-7, ralplan 편차 34) | `ralplan can hand off to <to> only from a finished phase (final, handoff, complete, completed, failed, cancelled, canceled, inactive); the current phase is <phase \| (none)>. Record the final plan first.` |
  | 3a | `pending-approval.md`를 찾으려고 상태의 `run_id`를 경로 성분으로 검사(`pendingApprovalPathTx`, `store.ts:1298-1304` → `activeRunId`, `:498-503`) | `invalid path component for run_id: <value>` |
  | 4 | 비활성 (R-OD18), `to`와 phase에 따라 넷 | 아래 표 |
  | 5 | `handoffWorkflowTx` 안: callee 상태 손상 | `existing state for <to> is corrupt or tampered (<error>); refusing to hand off` |
  | 6 | `handoffWorkflowTx` 안: 병합한 두 상태가 StateStore 한도를 넘음(저널 전) | 한도 문구 |

  3a는 상태의 `run_id`가 있을 때 run 폴더에 `pending-approval.md`가 있는지 봅니다. 있으면 4의 ultragoal 문구와 결과 줄에 그 경로가 들어갑니다. `run_id`가 경로 성분 규칙에 맞지 않으면 활성 여부보다 먼저 거부합니다(실행해 확인: 비활성 `final` 상태에 `state`로 `run_id: "../bad"`를 넣은 뒤 `handoff(to: "ultragoal")` → `Error: invalid path component for run_id: ../bad`). 상태의 `run_id`가 이렇게 되는 길과 고치는 법은 [start](#start)의 5에 있습니다.

  | `to` | phase | 4의 문구 |
  |---|---|---|
  | `ultragoal` | `handoff` | ``ralplan was already handed off (inactive, phase handoff); continue in the `ultragoal` skill.`` (`handoff_to`가 `deep-interview`여도 `ultragoal`) |
  | `ultragoal` | 그 밖 | ``ralplan is not active (phase <phase>), so there is nothing to hand off: Stop here or `clear` ended the run. To execute the plan, load the `ultragoal` skill, then call `ultragoal create` with the plan's goals (the approved plan: <path>).`` (괄호는 `pending-approval.md`가 있을 때만) |
  | `deep-interview` | `handoff` | ``ralplan was already handed off (inactive, phase handoff); continue in the `<handoff_to 또는 ultragoal>` skill.`` |
  | `deep-interview` | 그 밖 | ``ralplan is not active (phase <phase>), so there is nothing to hand off: Stop here or `clear` ended the run. To interview again, load the `deep-interview` skill and call `deep-interview start`; to continue an existing interview, call `deep-interview status`.`` |

  4는 `RalplanNotActiveError`(`store.ts:1295`)로 던집니다. 도구 결과에서는 다른 거부와 같은 `Error: …`입니다.
- **쓰는 것** (`handoffWorkflowTx`, `src/skill-state/handoff.ts:212-322`): 저널 → callee 상태(기존 필드 위에 활성, 첫 phase, `handoff_from: "ralplan"`, `handoff_at`) → ralplan 상태(기존 필드 위에 `active: false`, `current_phase: "handoff"`, `handoff_to`, `handoff_at`; `run_id`는 남음) → ralplan 행(비활성, `handoff_to`)과 callee 행(활성) → 스냅숏 → 저널 `committed` 뒤 삭제. goal 상태는 건드리지 않습니다. `reason`(`ralplan handoff to <to>`)은 넘기지만 ralplan 쪽은 `recordCaller`를 주지 않으므로 어디에도 기록되지 않습니다.
- **감사 행**: 실제 실행(`final` 1회차 뒤 `to: "ultragoal"`)에서 11행이 이 순서로 남았습니다: `state/write-transaction-journal` → ultragoal의 `state/handoff`(`to_phase` `goal-planning`) → `state/write-transaction-journal` → ralplan의 `state/handoff`(`final` → `handoff`) → `state/write-transaction-journal` → `state/write-active-entry`(ralplan) → `state/write-active-entry`(ultragoal) → `state/rebuild-active-snapshot` → `state/write-transaction-journal` 두 번 → `state/remove-transaction-journal`. 저널 행과 `state/handoff` 행의 `mutation_id`는 `ralplan:handoff:<to>:<at>`이고, 행·스냅숏 행은 UUID입니다.
- **결과**: 결과 줄(`store.ts:1388-1392`), 줄바꿈, 영수증 JSON. `final` 1회차 뒤 `to: "ultragoal"`의 실제 출력:

  ```
  Handed off to ultragoal: ralplan is inactive (phase handoff) and ultragoal is active in goal-planning. Load the `ultragoal` skill now and call `ultragoal create` with the approved plan's goals (the approved plan: <session>/plans/ralplan/ses_root/pending-approval.md).
  {
    "ok": true,
    "from": "ralplan",
    "to": "ultragoal",
    "handoff_at": "2026-10-03T15:02:40.529Z",
    "mutation_id": "ralplan:handoff:ultragoal:2026-10-03T15:02:40.529Z",
    "phases": {
      "from": "handoff",
      "to": "goal-planning"
    },
    "paths": {
      "from": "<session>/state/ralplan-state.json",
      "to": "<session>/state/ultragoal-state.json",
      "active_state": "<session>/state/skill-active-state.json"
    }
  }
  ```

  `to: "deep-interview"`의 결과 줄(영수증의 `phases.to`는 `interviewing`):

  ```
  Handed off to deep-interview: ralplan is inactive (phase handoff) and deep-interview is active in interviewing. Load the `deep-interview` skill now and continue the existing interview with `deep-interview write`; do not call `deep-interview start`, which would reseed it (the approved plan: <path>).
  ```

  괄호의 `(the approved plan: …)`은 `pending-approval.md`가 있을 때만 붙고, 경로는 결과 줄에만 있습니다(D-HE1).
- **넘긴 뒤**: 다시 부르면 ``Error: ralplan was already handed off (inactive, phase handoff); continue in the `ultragoal` skill.``입니다. ultragoal이 활성이 되었으므로 `ralplan start`는 `RALPLAN_ACTIVATION_REFUSAL`로 거부됩니다.

**편차**: ralplan 편차 34(phase ∈ T와 활성 ralplan을 요구, gjc의 `state handoff` 동사는 둘 다 보지 않음), 22(SKILL step 9의 상태 쓰기 + skill 도구 인계를 op 하나로, DR-12).

## `clear`

run을 끝냅니다. `clearStateTx`(`store.ts:1140-1189`), gjc `handleClear`(`state-runtime.ts:1402-1490`)와 `describeStaleClearState`(`:244-270`)입니다(머리말 기준, DR-6을 고친 R-OD11).

- **입력**: `force?`(`true`일 때만 강제)
- **검사 순서** (`force`면 모두 건너뜀):

  | 순서 | 검사 | 거부 문구 |
  |---|---|---|
  | 1 | 상태 손상 | `existing state for ralplan is corrupt or tampered (<error>); use force: true to overwrite` |
  | 2 | phase가 R이고 `inactive`가 아님(`complete`, `completed`, `failed`, `cancelled`, `canceled`) | `existing state for ralplan is stale (mode-state is already terminal (<phase>)); use force: true to clear` |
  | 3 | 행 파일 `state/active/ralplan.json`을 읽을 수 없음(ralplan 편차 35, R-OD16) | `active row <path> is unreadable (<error>); use force: true to clear` |
  | 4 | 보이는 항목이 활성인데 그 phase가 상태의 phase와 다름(R-OD14) | `existing state for ralplan is stale (active-state phase <a> differs from mode-state phase <b>); use force: true to clear` |

  2–4는 `describeStaleClearTx`(`store.ts:1093-1130`)입니다. 4의 "보이는 항목"은 skill이 `ralplan`인 행 파일, 없으면 스냅숏의 같은 skill 항목이고, 활성일 때만 봅니다. 상태의 phase가 phase lock(`final`, `handoff`, `complete`, …)이면 항목의 phase 대신 그 phase를 씁니다(gjc `withCanonicalRalplanPhase`). 그래서 `final` 뒤 다듬기 쓰기로 행이 `revision`이어도 `force` 없는 `clear`가 지나갑니다. 비활성 상태의 phase는 phase lock에 있을 때만 셉니다(`modeStatePhase`). `force`면 손상 상태를 빈 객체로 보고, 행 파일을 읽지도 않습니다.
- **쓰는 것**:
  - 상태: `{skill, …기존 필드, active: false, current_phase: "complete", updated_at, version: 2}`. `run_id`, 역할 id, verdict, `auto_handoff`, `planning_stuck` 등 기존 필드가 모두 남습니다. 손상(`force`)이거나 상태가 없으면 `skill`, `active`, `current_phase`, `updated_at`, `version` 다섯만 씁니다(`session_id` 없음). 상태가 없어도 파일을 만듭니다.
  - 감사 행 `state/clear`(`mutation_id` `ralplan:clear:<at>`, `from_phase`, `to_phase` `complete`, `forced`).
  - 행 삭제(`state/remove-active-entry`, 행이 있었을 때만)와 스냅숏. best-effort입니다.
  - 단계 파일, `index.jsonl`, `pending-approval.md`는 그대로 둡니다.
- **결과**:

  ```json
  {
    "ok": true,
    "skill": "ralplan",
    "state_path": "<session>/state/ralplan-state.json",
    "active": false,
    "current_phase": "complete",
    "mutation_id": "ralplan:clear:2026-10-03T15:02:40.485Z"
  }
  ```

  (Stop here 뒤의 `clear`입니다. 행이 이미 없어서 감사 행은 `state/clear`(`"from_phase":"final","to_phase":"complete","forced":false`)와 `state/rebuild-active-snapshot` 둘이었습니다.)
- **두 번째 `clear`**: `Error: existing state for ralplan is stale (mode-state is already terminal (complete)); use force: true to clear`. `force: true`면 다시 `complete`를 씁니다.
- **넘긴 뒤의 `clear`**: 비활성 `handoff`는 R이 아니고 행도 비활성이라 `force` 없이 됩니다.
- **`clear` 뒤의 다음 일**: 같은 run의 `write`는 잠긴 `complete`를 유지해 비활성으로 남고, 새 `run_id`의 `write`나 `start`는 다시 활성으로 만듭니다. `state`는 manifest phase를 주지 않으면 거부됩니다([state](#state)).
- **`clear` 뒤 쓰기로 다시 생긴 행 지우기**: 같은 run의 `write`는 상태를 비활성 `complete`로 두지만 활성 행을 다시 씁니다. 이 행은 `force` 없는 `clear`(이미 종료라 거부)나 `state {"active": false}`(`unknown ralplan phase "complete"`)로는 지워지지 않고, `clear(force: true)`나 manifest phase를 함께 준 `state(patch={"active": false, "current_phase": "final"})`로 지워집니다. 출발 phase `complete`가 manifest 밖이라 전이 검사(`store.ts:1041-1046`)를 건너뛰기 때문입니다(실행해 확인: 결과 `"current_phase": "final", "active": false`, 행 파일 없음).

**SKILL만 요구하는 것**: 손상되거나 낡은 자기 상태에 `clear(force=true)`를 쓰라는 안내, `doctor`의 `stale_active_state` 보고만으로 `clear`하지 말라는 안내(SKILL.md:28-32)는 코드가 강제하지 않습니다.

## 코드가 강제하는 것과 SKILL만 요구하는 것

| 규칙 | 코드 | SKILL·프롬프트 |
|---|---|---|
| 도구는 `open-gajae`와 세 역할만, 역할은 `write`·`status`·`state`만 | `ownerSession`이 거부 | 같은 내용 |
| 역할은 `path` 없이 `content`만 | `write` 첫 검사로 거부(R-O4) | 같은 내용 |
| 주 agent의 `path`는 프로젝트 밖 OS 임시 파일 | `readTempArtifact`가 거부 | 같은 내용 |
| 같은 `(stage, stage_n)`에 다른 본문 금지 | 거부, "Use a new stage_n …" | 패스마다 `stage_n`을 올림 |
| 반복 상한과 lane 예산 | PLANNING-STUCK 결과 | 넘으면 다시 돌지 말고 최선의 계획을 `final`로 |
| 단계의 차례(전이표) | `write`는 감사 행만 남기고 씀, `state`는 거부 | 9단계 순서 |
| 역할이 자기 lane의 단계만 씀 | 검사 없음(자기 lane일 때만 세션 id 기록) | 역할 프롬프트는 자기 단계(`planner`, `architect`, `critic`)의 `write`만 보여 줌. SKILL은 planner의 `revision`도 둠 |
| 역할은 영수증만 돌려줌 | 검사 없음 | RECEIPT-ONLY |
| 모든 배정에 `run_id` | 검사 없음(없으면 상태의 `run_id`) | 모든 배정과 주 agent의 쓰기에 넣음 |
| architect·critic의 `lane_verdict` | 있으면 값만 검사, 없어도 됨 | 모든 리뷰 배정에 넣으라고 지시 |
| 활성 run 위에서 `start` 금지 | 거부(ralplan 편차 39) | 같은 내용 |
| ultragoal 실행 중 `start` 금지 | 거부 | 같은 내용 |
| ultragoal 실행 중 `write` | 거부하지 않음(R-AE1) | 정리하려면 `state {active:false}`나 `clear` |
| Stop here | `state {active:false}`가 하는 일만 | 승인 질문의 선택지로 부름 |
| 넘기기 시점 | phase ∈ T와 활성을 요구 | 승인 뒤, 또는 자동 승인 뒤 |
| 승인 질문과 자동 승인 | `final` 영수증의 `auto_handoff`만 계산 | 질문을 하고, `effectiveTarget`대로 넘김 |
| `doctor` 보고 뒤의 `clear` | 검사 없음 | 보고만으로 지우지 말 것 |
