# ralplan 저장 파일과 상태

이 문서는 ralplan이 디스크에 남기는 파일과, 그 파일을 바꾸는 규칙을 코드 그대로 적습니다. 다루는 것은 세션 폴더와 계보 루트, 세션마다 하나인 쓰기 큐, 상태 파일 `state/ralplan-state.json`의 모양과 필드, phase manifest, 활성 행·스냅숏·보이는 주 skill, HUD 칩, 감사 로그, 인계 저널, doctor, 저장소 바인딩, `ralplan.*` 설정, continuation 카운터 파일입니다. 기준 코드는 [README.md](README.md) 머리에 있습니다. 코드 위치는 `5b92a60` 기준입니다.

예시는 기준 코드를 bun으로 임시 `StateStore`에 대고 실제로 실행해 얻은 것입니다(`tests/ralplan-tool.test.ts`처럼 `createTools`로 도구를 만들고 가짜 계보를 줌). 세션 폴더 절대 경로는 `<session>`, 저장소 경로는 `<worktree>`, 커밋 해시는 `<HEAD>`로 줄였습니다. 시각, uuid, sha256은 실행마다 다릅니다.

이웃 문서가 맡는 것:

- [ops.md](ops.md): `ralplan` 도구의 op 7개(입력, 검사 순서, 거부 문구, 결과 모양)
- [stages-and-ledger.md](stages-and-ledger.md): 단계 파일, `index.jsonl`, 중복 처리, 예산과 PLANNING-STUCK, run 전환, final 승인과 `auto_handoff`, disposition
- [entry-and-handoff.md](entry-and-handoff.md): 진입, 넘기기 경로, 공통 저널 인계의 단계
- [guards-and-continuation.md](guards-and-continuation.md): 계획 가드, 산출물 항상 차단, continuation 판단, 압축 문맥
- [roles-and-consensus.md](roles-and-consensus.md): 역할 에이전트와 합의 루프, 역할 메타데이터를 쓰는 법
- [known-limits.md](known-limits.md): 알려진 한계

## 1. 세션 폴더

### 폴더와 계보 루트

- 루트는 `<worktree>/.open-gajae/`입니다. `<worktree>`는 플러그인 `setup`이 받은 `ctx.location.project.directory`를 `StateStore`가 `realpathSync`로 푼 경로입니다(`src/index.ts:25-33`, `src/state.ts:291-303`).
- 폴더 이름은 `_session-<YYYYMMDD-HHMMSS>-<세션 id>`입니다(`sessionDirName`, `src/state.ts:242-247`). 시각은 호스트 세션의 `time.created`를 로컬 시간으로 적은 값입니다. 한 번 만든 폴더는 이름 끝의 `-<세션 id>`로 찾고, 같은 꼬리의 폴더가 둘이면 `ambiguous session directories for <id>: …`로 실패합니다(`resolveSessionDir`, `src/state.ts:311-340`). 폴더는 첫 쓰기에서만 만들어집니다. 자세한 규칙은 [ultragoal 문서](../ultragoal/state-and-files.md)의 1장과 같습니다.
- **계보 루트(lineage root)**: `rootSession`(`src/hooks.ts:626-658`)이 `session.get`으로 `parentID`를 따라 올라가 부모 없는 세션을 찾고, 지나온 세션마다 결과를 캐시합니다. 조회 실패, 읽을 수 없는 응답, 순환은 모두 예외입니다.
- `ralplan` 도구는 호출자 검사 뒤 `deps.rootSession(context.sessionID)`를 소유자로 씁니다(`ownerSession`, `src/ralplan-runtime/tool.ts:168-187`). 그래서 planner·architect·critic 역할이 자기 자식 세션에서 부른 `write`도 루트 세션 폴더에 씁니다(계획 DR-1, ralplan 편차 32). 계보를 풀지 못하면 `could not resolve the session lineage for ralplan`으로 거부합니다.
- 훅도 루트 폴더를 봅니다. 계획 가드와 `skill ultragoal` 게이트는 `rootSession`을 거치고, continuation은 부모 없는 세션의 `session.execution.succeeded`에서만 돕니다(`src/hooks.ts:1284-1286`). 예외 하나: ralplan 압축 문맥은 `store.ralplanTransaction(event.sessionID, …)`로 압축하는 세션 자신의 폴더를 읽습니다(`src/hooks.ts:1211-1240`). 자식 세션 폴더에는 보통 ralplan 상태가 없으므로 실제로는 루트 세션에서만 문맥이 붙습니다.

### ralplan 트리

```text
<worktree>/.open-gajae/
  _session-<YYYYMMDD-HHMMSS>-<root 세션 id>/
    plans/ralplan/<run-id>/
      stage-NN-<stage>.md          단계 파일 (stages-and-ledger.md)
      index.jsonl                  run 원장
      pending-approval.md          마지막 final의 복사본
    state/
      ralplan-state.json           ralplan 상태
      ralplan-continuation.json    continuation 카운터 (훅 전용)
      active/ralplan.json          ralplan 활성 행
      skill-active-state.json      스냅숏 (세 skill 공통)
      audit.jsonl                  감사 로그 (세 skill 공통)
      transactions/<id>.json       인계 저널 (인계가 도는 동안만)
```

`<run-id>`는 `start`의 `run_id`, 없으면 상태의 `run_id`, 없으면 루트 세션 id입니다(계획 DR-19, [stages-and-ledger.md](stages-and-ledger.md)).

### 파일별 쓰는 곳과 읽는 곳

| 파일 | 쓰는 곳 | 읽는 곳 |
|---|---|---|
| `plans/ralplan/<run-id>/stage-NN-<stage>.md` | `ralplan write`(`persistArtifactTx`, `src/ralplan-runtime/store.ts:372-405`) | `write`의 중복·복구 검사, 압축 문맥(sha256 확인), 모델 |
| `plans/ralplan/<run-id>/index.jsonl` | `ralplan write`(단계 행, PLANNING-STUCK 행) | `write`(중복, 예산, final 승인, disposition 출처), HUD 칩(`start`·`write`), 압축 문맥 |
| `plans/ralplan/<run-id>/pending-approval.md` | `ralplan write(stage="final")`. 같은 final을 다시 쓸 때 파일이 없으면 다시 만듦(`ensureFinalPendingApprovalTx`, `store.ts:408-437`) | 중복 final의 바이트 확인, `ralplan handoff`(결과 문구와 거부 문구에 경로를 넣음), 모델 |
| `state/ralplan-state.json` | `ralplan` 도구의 `start`·`write`·`state`·`handoff`·`clear`; continuation 차단기 소진(훅); 같은 execution의 `skill ultragoal` 게이트 인계(훅); `ultragoal handoff(to:"ralplan")`; `deep-interview handoff(to:"ralplan")`와 결합 호출 `spec(…, handoff:"ralplan")`(`startRunTx`로 시드한 뒤 인계); deep-interview 로드 게이트의 `skill ralplan` 인계 | 도구의 모든 op, 계획 가드, continuation, `skill ultragoal` 게이트, 압축 문맥, `readVisiblePrimaryTx`(잠긴 phase), `clear`의 낡음 판정, doctor |
| `state/ralplan-continuation.json` | continuation 판단 `decideRalplan`(`src/hooks.ts:474-533`) | 같은 함수(`readBreaker`, `:449-463`)만 |
| `state/active/ralplan.json` | `syncActiveRowTx`(`start`·`write`·`state`·`clear`, 차단기 소진), `writeHandoffRowsTx`(인계). ultragoal이 활성 행을 쓰면 위쪽 파이프라인 행으로 지워짐 | `rebuildSnapshotTx`, `readVisiblePrimaryTx`, `clear`의 낡음 판정, doctor, 인계(이전 행의 `handoff_from`) |
| `state/skill-active-state.json` | `rebuildSnapshotTx`(행이 바뀔 때마다) | `readVisiblePrimaryTx`, `clear`의 낡음 판정(행이 없을 때), doctor |
| `state/audit.jsonl` | `appendAudit`(`src/skill-state/audit.ts:37-53`) | 코드는 읽지 않음 |
| `state/transactions/<id>.json` | 인계 저널(`src/skill-state/journal.ts`) | 저널 함수 자신만. doctor는 읽지 않음 |

- 모든 쓰기는 2장의 큐 안에서 `tx`로만 합니다. 키워드, 멘션, `skill ralplan` 로드는 ralplan 상태를 쓰지 않습니다(ralplan 편차 36, [entry-and-handoff.md](entry-and-handoff.md)).
- 어떤 에이전트도 `write`·`edit`·`patch`로 `plans/ralplan/**`와 `state/**`를 쓸 수 없습니다(`isRalplanOwned`, `isSessionState`, `src/artifact-guard.ts:127-152`; [guards-and-continuation.md](guards-and-continuation.md)). 그래서 손상된 상태를 고치는 길은 `ralplan clear(force: true)`입니다.
- 지우는 op는 없습니다. `clear`, `start`, 인계 모두 단계 파일, `index.jsonl`, `pending-approval.md`, 이전 run 폴더를 남깁니다. 지우는 파일은 활성 행과 저널뿐입니다.

## 2. 쓰기 큐와 파일 쓰기

### 큐 하나

- `StateStore.workflowTransaction(owner, fn)`(`src/state.ts:476-578`)은 세션마다 큐 하나(`queueKey` = `<.open-gajae 경로>\0<세션 id>\0workflow`, `:446-451`)에 `fn`을 줄 세웁니다. `ralplanTransaction`(`:581-586`)은 같은 함수의 다른 이름입니다(ultragoal 계획 C-1.2). ralplan, ultragoal, goal, deep-interview의 op와 훅 판단이 모두 이 큐를 지나므로, 한 세션의 workflow 파일은 큐 밖에서 바뀌지 않습니다.
- 앞 작업이 실패해도 다음 작업은 돕니다(`enqueue`, `:270-282`). 큐는 한 프로세스 안의 것이고, 프로세스 사이 잠금은 없습니다(ralplan 편차 17의 "several processes are a known limit").
- `fn`은 `tx`만 써야 합니다. 몸체 안에서 같은 세션의 트랜잭션을 또 열면 자기 큐를 기다리며 멈춥니다(`src/state.ts:470-475`, ultragoal 계획 C-1.3). ralplan의 `*Tx` 함수는 모두 받은 `tx`만 쓰고, 도구는 op마다 트랜잭션 하나를 엽니다(`src/ralplan-runtime/store.ts:5-10` 머리말, 계획 C-1 규칙 1).

### 롤백 없음

트랜잭션은 직렬화만 합니다. 몸체가 중간에 예외를 던지면 그때까지 쓴 파일은 남습니다. 예: 손으로 만든 `{active: true, current_phase: "completed", version: 2, run_id: "r1"}` 상태에서 역할이 같은 run에 `architect`를 쓰면(`run_id`가 없으면 새 run으로 보고 정상 기록됩니다), 단계 파일과 `index.jsonl` 행을 쓴 뒤 역할 메타데이터 병합에서 `Refusing to write unknown ralplan phase "completed" to <session>/state/ralplan-state.json: not a known ralplan manifest state`로 실패하고, 두 파일은 남습니다(실행으로 확인). 같은 내용으로 다시 쓰면 원장 중복으로 처리됩니다([stages-and-ledger.md](stages-and-ledger.md)). 현재 op들은 활성 상태를 manifest 밖 phase에 두지 않으므로, 이 경우는 손으로 만든 상태에서만 생깁니다.

### ralplan이 쓰는 `tx`

`ralplanTransaction`의 몸체는 `WorkflowTx`(`src/state.ts:79-101`)를 받습니다. 이것은 `RalplanTx`(`:40-72`)에 다른 skill의 경로와 `readModeState`·`writeModeState`를 더한 것입니다. 어느 메서드도 큐를 타지 않습니다.

| 이름 | 내용 | ralplan에서 쓰는 곳 |
|---|---|---|
| `paths.statePath` | `state/ralplan-state.json` | 상태 쓰기와 감사 행, 결과의 `state_path` |
| `paths.continuationPath` | `state/ralplan-continuation.json` | continuation 훅 |
| `paths.activeRowPath` | `state/active/ralplan.json` (행 디렉터리를 얻는 데도 씀) | `clear`의 낡음 판정, 행 목록, doctor |
| `paths.snapshotPath` | `state/skill-active-state.json` | 스냅숏, `state` op 영수증의 `state_path` |
| `paths.auditPath` | `state/audit.jsonl` | `appendAudit` |
| `paths.runDir(runId)` | `plans/ralplan/<runId>`. `runId`는 `safeComponent`(`src/state.ts:204-208`: `^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$`, `..` 금지)를 통과해야 하고, 아니면 `invalid path component for run_id: <값>` | run 폴더, 상태의 `run_id` 검사(`activeRunId`, `store.ts:498-503`) |
| `readState()` / `writeState(state, updatedBy)` | ralplan 상태 읽기, 통째로 교체(병합 아님) | 모든 op |
| `readModeState(mode)` | 다른 skill 상태 읽기 | `start`의 ultragoal 검사, 공통 코드(행, doctor, 인계) |
| `readText`, `writeText`, `appendLine`, `list`, `remove` | 세션 폴더 안 파일 읽기, 원자적 쓰기, 한 줄 덧붙이기(줄바꿈이 든 줄은 거부), 정렬된 목록, 삭제 | 단계 파일, 원장, 행, 저널, 카운터 |

- 파일 인자는 세션 폴더 안이어야 합니다. 벗어나면 `workflow path escapes the session directory`입니다.
- 상태의 `run_id`가 안전한 경로 성분이 아니면 `activeRunId`가 위 오류를 냅니다. `write`는 `run_id` 입력이 없을 때만 이 함수를 불러 멈추고, `start`는 입력을 보기 전에 이 함수를 부르므로(`store.ts:922-925`) `run_id`를 넣어도 멈춥니다. 실행: 상태 `run_id`가 `"bad run"`이면 `start(task, run_id: "good")`는 `Error: invalid path component for run_id: bad run`, `write(run_id: "good", …)`는 성공.

### 원자적 쓰기와 덧붙이기

- `writeText`와 상태 쓰기는 `atomicWriteText`(`src/state.ts:411-439`)입니다. 같은 디렉터리에 `.<이름>.<uuid>.tmp`를 `wx`·`0600`으로 쓰고 `rename`합니다. 경로 중간에 심볼릭 링크나 디렉터리가 아닌 것이 있거나 대상이 일반 파일이 아니면 거부합니다. 새 디렉터리는 `0700`입니다.
- `appendLine`은 `O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW`, `0600`으로 엽니다(`appendText`, `:589-614`). `index.jsonl`과 감사 로그가 이 경로입니다.
- 상태 JSON은 2칸 들여쓰기에 끝 줄바꿈입니다. 행, 스냅숏, 저널, 카운터도 각 코드가 2칸 들여쓰기로 직렬화해 `writeText`로 씁니다.

### 상태 읽기 검사와 `_meta`

- `readState`는 `readFile`(`src/state.ts:382-405`) → `validateStoredState`(`:256-268`)를 거칩니다. 아래는 모두 예외입니다.
  - JSON이 아님: `state file is corrupted; it was preserved`
  - 한도 위반: `state file is invalid; it was preserved: <한도 오류>`
  - 소유 세션 불일치(`_meta.sessionId`, 없으면 `session_id`가 루트와 다름): `state scope does not match this session; it was preserved`
  - 일반 파일이 아님: `state file is not a regular file`
- 쓸 때마다 StateStore가 `_meta = {mode: "ralplan", sessionId, updatedAt, updatedBy}`를 새로 붙입니다(`writeMerged`, `:453-468`). ralplan 코드는 쓰기 전에 `payloadOf`(`store.ts:165-168`)로 이전 `_meta`를 떼어 냅니다. `status` op는 파일을 그대로 돌려주므로 결과에 `_meta`가 보입니다.

ralplan 상태의 `_meta.updatedBy`:

| 값 | 쓰는 경우 |
|---|---|
| `ralplan_tool` | 도구 op(`start`, `write`, `state`, `clear`, `handoff`). deep-interview 결합 호출이 부르는 `startRunTx`도 owner가 `open-gajae-runtime`이라 이 값입니다(`writeStateTx`, `store.ts:231-234`) |
| `ralplan_hook` | continuation 차단기 소진(`patchStateTx`, owner `open-gajae-hook`), 같은 execution의 `skill ultragoal` 게이트가 하는 인계 |
| `ultragoal_tool` | `ultragoal handoff(to:"ralplan")`: 인계는 두 상태를 caller의 writer로 씁니다(`WRITERS`, `src/skill-state/handoff.ts:95-99`) |
| `deep_interview_tool` | `deep-interview handoff(to:"ralplan")`, 결합 호출 `spec(…, handoff:"ralplan")`의 인계 단계(시드 뒤 마지막 쓰기) |
| `deep_interview_hook` | deep-interview를 로드한 execution에서 `skill ralplan`을 로드해 deep-interview 로드 게이트가 인계할 때 |

### 한도

모든 상태 쓰기는 `writeMerged`가 마지막에 `payloadError`(`src/state.ts:119-156`)로 검사합니다: JSON 객체, `_meta`를 뺀 최상위 키 100개 이하, 중첩 깊이 10 이하, `_meta`를 뺀 직렬화 1,048,576바이트 이하. 넘으면 그 쓰기가 `state exceeds 100 top-level keys`, `state exceeds nesting depth 10`, `state exceeds 1048576 bytes`, `state is not JSON serializable`로 실패하고 파일은 그대로입니다.

- ralplan op는 deep-interview처럼 첫 쓰기 전에 `assertStatePayload`를 부르지 않습니다. 공통 인계만 두 병합 상태를 저널 전에 검사합니다(`src/skill-state/handoff.ts:254-255`, deep-interview 계획 DR-31).
- `start`와 `state`는 상태 쓰기가 첫 쓰기라 한도에 걸리면 아무것도 쓰지 않습니다. 실행 예: 1,100,000자 `task`의 `start`는 `Error: state exceeds 1048576 bytes`이고 상태 파일이 생기지 않습니다. 키 100개를 더하는 `state` 패치는 `Error: state exceeds 100 top-level keys`입니다.
- `write`는 상태 쓰기 → 단계 파일 → 원장 → 메타데이터 병합 순서라, 앞의 쓰기가 성공한 뒤 뒤의 상태 쓰기가 한도에 걸리면 앞의 파일이 남습니다(롤백 없음).
- 같은 한도가 읽기에도 걸립니다. 손으로 고쳐 한도를 넘은 파일은 위의 `state file is invalid`로 읽힙니다.

## 3. 상태 파일 `state/ralplan-state.json`

gjc의 workflow 봉투(envelope)입니다. gjc의 `receipt`, checksum, `state_revision`은 없고 StateStore의 `_meta`가 있습니다(ralplan 편차 17, R-OD6). 열린 봉투라 모르는 키도 남습니다.

### `start`가 쓰는 모양

`startRunTx`(`src/ralplan-runtime/store.ts:915-988`)가 상태를 **통째로** 새로 씁니다. 이전 상태의 필드(역할 id, verdict, `auto_handoff`, `handoff_*` 등)는 남지 않고, `run_id`와 같은 run의 바인딩만 이어받습니다. `ralplan start(task="Add CSV export to the report page")` 뒤:

```json
{
  "active": true,
  "current_phase": "planner",
  "skill": "ralplan",
  "version": 2,
  "mode": "short",
  "interactive": false,
  "task": "Add CSV export to the report page",
  "run_id": "ses_root",
  "updated_at": "2026-10-03T15:02:51.455Z",
  "repository_binding": {
    "schema": "gjc.repository_binding.v1",
    "worktreeRoot": "<worktree>",
    "commonDir": "<worktree>/.git",
    "displayPath": "<worktree>",
    "head": "<HEAD>",
    "branch": "main"
  },
  "session_id": "ses_root",
  "_meta": {
    "mode": "ralplan",
    "sessionId": "ses_root",
    "updatedAt": "2026-10-03T15:02:51.455Z",
    "updatedBy": "ralplan_tool"
  }
}
```

- `mode`는 `deliberate: true`면 `"deliberate"`, 아니면 `"short"`, `interactive`는 `interactive === true`입니다.
- `StartRunInput`에는 `handoff_from`·`handoff_at`이 있지만(`store.ts:886-894`, R-O1) 지금 이 입력을 넘기는 호출자는 없습니다. `ralplan start`도, deep-interview 결합 호출의 시드(`{task: <spec 경로>, deliberate: true}`, `src/deep-interview-runtime/store.ts:555`)도 넘기지 않습니다. 결합 호출에서는 바로 뒤의 공통 인계가 `handoff_from: "deep-interview"`를 씁니다.

### `start` 없이 `write`가 만든 모양

상태 파일이 없을 때 `write`는 `persistActiveRunIdTx`(`store.ts:513-545`)로 상태를 만듭니다(`docs/development.md` "GJC로부터의 deviation (ralplan)"의 "수용한 동작 차이" 표 "시딩 없음, `write`가 state 생성" 행, R-O6). 새 세션에서 `ralplan write(stage="planner", stage_n=1, …)` 뒤:

```json
{
  "run_id": "ses_w",
  "skill": "ralplan",
  "active": true,
  "current_phase": "planner",
  "version": 2,
  "updated_at": "2026-10-03T15:02:51.509Z",
  "_meta": {
    "mode": "ralplan",
    "sessionId": "ses_w",
    "updatedAt": "2026-10-03T15:02:51.509Z",
    "updatedBy": "ralplan_tool"
  }
}
```

`mode`, `interactive`, `task`, `repository_binding`이 없고, `session_id`도 없습니다. `version: 2`는 `migrateRalplanState`가 넣은 것입니다(아래). 이런 run의 `write` 영수증은 매번 바인딩을 새로 잡습니다(10장).

### 필드

`store.ts`와 `ledger.ts`의 payload 만드는 코드에서 뽑은 목록입니다.

| 필드 | 쓰는 곳 | 뜻과 읽는 곳 |
|---|---|---|
| `skill` | 모든 쓰기 | 항상 `"ralplan"` |
| `version` | `start`·`state`·`clear`·인계는 `2`를 직접, `write`의 상태 쓰기는 `migrateRalplanState`로 | gjc `WORKFLOW_STATE_VERSION`(`store.ts:134`) |
| `active` | `start` `true`. `write`: 새 run이거나 잠기지 않은 phase면 `true`(멈춘 run도 다시 켬), 같은 run의 잠긴 phase면 바꾸지 않음. 메타데이터 병합은 boolean이면 그대로 둠. `state`: 패치 값, boolean이 아니면 `true`. `clear` `false`. 인계 caller `false`, callee `true`. 차단기 소진 `false` | 계획 가드, continuation, `skill ultragoal` 게이트, `start` 거부(DR-39), `handoff` 거부(R-OD18), 압축 문맥 |
| `current_phase` | `start` `planner`. `write`: 방금 쓴 단계, 같은 run의 잠긴 phase면 그대로(`advanceCurrentPhase`, 4장). `state`: 패치의 `current_phase`나 `phase`, 없으면 기존 값. `clear` `complete`. 인계 caller `handoff`, callee `planner` | 4장의 집합들 |
| `updated_at` | 모든 쓰기 | ISO 시각 |
| `session_id` | `start`(루트 id). `state`와 인계 callee는 문자열이 아닐 때만 루트 id로 채움. `write`는 쓰지 않음 | StateStore 소유 검사(`_meta.sessionId`가 먼저) |
| `run_id` | `start`(DR-19), `write`(새 run이면 바꿈; [stages-and-ledger.md](stages-and-ledger.md)) | `write`·`start`의 run 선택, `handoff`의 `pending-approval.md` 찾기, continuation 카운터 키, 압축 문맥, `start` 거부 문구 |
| `mode`, `interactive`, `task` | `start`만 | 코드가 읽는 곳은 `mode` 하나: `current_phase`가 문자열이 아닐 때 HUD `stage` 칩의 대체 값(`buildRalplanHudFromState`, `src/ralplan-runtime/hud.ts:192-197`). 나머지는 기록만. `--interactive`·`--deliberate`의 의미는 [roles-and-consensus.md](roles-and-consensus.md) |
| `repository_binding` | `start`만 | `write` 영수증, 같은 run의 `start`가 이어받음(10장) |
| `planner_subagent_id`, `architect_id`, `critic_id` | `write`: 그 역할이 자기 lane의 단계를 쓸 때 자기 `context.sessionID`(planner는 `planner`·`revision`, 나머지는 같은 이름 단계). `persistedRoleStatePayload`(`src/ralplan-runtime/ledger.ts:1016-1033`) | 코드는 읽지 않음. 주 에이전트가 `status`로 읽어 이어 부름(ralplan 편차 5) |
| `<role>_resumable` | `write`의 `resumable` 입력. `<role>`은 호출자가 아니라 단계로 정합니다(`planner`·`revision` → `planner`, `architect`, `critic`). 다른 단계에 넣으면 거부 | 기록만 |
| `<role>_fallback_reason`, `_fallback_attempted_id`, `_fallback_stage_n`, `_fallback_receipt_path` | `write`의 `fallback_*` 입력(`<role>`은 같은 규칙) | 기록만 |
| `last_review_verdict`, `last_review_verdict_lane`, `last_review_verdict_stage_n` | `architect`·`critic` 단계의 `write`에 `lane_verdict`가 있을 때(`laneVerdictStatePayload`, `ledger.ts:1056-1065`) | HUD `verdict` 칩, 압축 문맥 |
| `planning_stuck` | `write`가 PLANNING-STUCK을 낼 때 `{marker: "PLANNING-STUCK", reason}`(`recordPlanningStuckTx`, `store.ts:568-591`). 상태의 `run_id`가 이번 run일 때만 | continuation(참이면 멈추고 카운터 초기화) |
| `auto_handoff` | `write(stage="final")`의 승인 결과 `{configuredTarget, effectiveTarget, degradationReason, source}`(`persistFinalAdmissionTx`, `store.ts:594-606`). 같은 run일 때만 | 코드는 읽지 않음. 권위 있는 값은 `index.jsonl` final 행과 final 영수증입니다(SKILL Flags의 `ralplan.autoHandoff` 항목) |
| `verdict` | open-gajae 코드는 쓰지 않음 | 새 run에서 지움(gjc 그대로). `state` op·인계 행의 HUD가 `last_review_verdict` 다음으로 봄 |
| `handoff_to`, `handoff_at` | 인계에서 ralplan이 caller일 때 | `handoff` 거부 문구(`handoff_to`) |
| `handoff_from`, `handoff_at` | 인계에서 ralplan이 callee일 때(ultragoal·deep-interview에서 넘어옴) | `start` 거부 문구 `handed over from <skill>`. 모델(SKILL: `handoff_from: "deep-interview"`이면 스펙을 계획 입력으로 읽음) |
| 그 밖의 키 | `state` op 패치(값이 `null`이면 지움) | 기록만. 패치의 `phase` 키도 필드로 남습니다(ralplan 편차 38: 중첩 `state`도 필드로 저장) |

**새 run에서 지우는 것**(`persistActiveRunIdTx`, `store.ts:523-529`): `verdict`, `last_review_verdict`로 시작하는 키, `planning_stuck`, `auto_handoff`. 역할 id·`*_resumable`·`*_fallback_*`, `mode`, `task`, `interactive`, `repository_binding`, `handoff_*`는 이전 run의 값으로 남습니다. 실행 예: `architect` 1회(`resumable: false`, `lane_verdict: "BLOCK"`) 뒤 `write(run_id="run-2", stage="planner")`를 하면 상태에 `architect_resumable: false`는 남고 `last_review_verdict*`는 사라집니다.

**같은 run의 잠긴 phase**(R-OD9): `persistActiveRunIdTx`는 같은 run이 이미 그 phase에 있고 `version: 2`이며 활성이거나 잠긴 phase면 아무것도 쓰지 않고 돌아옵니다(`store.ts:530-537`). 그래서 Stop here(`active: false`, `final`)나 `clear`(`complete`) 뒤의 `write`는 상태를 다시 켜지 않습니다. 다만 그 뒤의 메타데이터 병합(`mergeRunStateTx`, `store.ts:548-565`)은 상태를 씁니다. `active`가 이미 boolean이면 그대로 두므로, Stop here 뒤 역할이 `lane_verdict`를 쓰면 `last_review_verdict*`가 바뀐 비활성 상태가 됩니다.

### op별 변화

| 일 | 상태에 하는 일 | 감사 verb |
|---|---|---|
| `start` | 위 모양으로 통째로 교체 | `state/write` |
| `write` | ① `persistActiveRunIdTx`(새 run 전환, 활성화, phase 전진; 바뀔 것이 없으면 안 씀) ② 역할 메타데이터 병합 ③ lane verdict 병합 ④ final이면 `auto_handoff` 병합. PLANNING-STUCK이면 대신 `planning_stuck`만 병합. 원장 중복은 상태를 쓰지 않음. 디스크 복구(단계 파일은 있고 원장 행이 없음)는 원장 행을 붙이고(final이면 없는 `pending-approval.md`도 씀), 상태의 `run_id`가 이번 run이면 역할 메타데이터·verdict를 병합(`store.ts:694-759`). 둘 다 같은 중복 영수증을 돌려줌 | 쓰기마다 `state/write`, 표에 없는 전이면 그 앞에 `state/invalid_transition_detected` |
| `state` | 기존 위에 패치 병합, phase 검사 뒤 씀(`patchStateTx`, `store.ts:1001-1079`) | `state/write`(`mutation_id: ralplan:<at>`, `from_phase`·`to_phase`) |
| `clear` | `{skill, …기존, active: false, current_phase: "complete", updated_at, version: 2}`(`clearStateTx`, `store.ts:1140-1189`). `run_id`와 다른 필드는 남음 | `state/clear`(`forced` = `force`) |
| `handoff`(caller) | 기존 위에 `active: false`, `current_phase: "handoff"`, `handoff_to`, `handoff_at`, `updated_at`, `version: 2` | `state/handoff` |
| 인계 callee | 기존 위에(없으면 빈 객체) `active: true`, `current_phase: "planner"`, `handoff_from`, `handoff_at`, `updated_at`, `version: 2`, `session_id`(없을 때). `run_id`는 남음(ralplan 편차 24 철회 사유) | `state/handoff`, 전이 표에 없으면 그 앞에 `state/invalid_transition_detected` |
| 차단기 소진 | `patchStateTx(…, {active: false}, HOOK_OWNER, "breaker-exhausted")`(`src/hooks.ts:512-519`) | `state/write`(`mutation_id: ralplan:breaker-exhausted:<at>`, owner `open-gajae-hook`) |

`state` op의 phase 규칙(`store.ts:1020-1048`): 패치의 `current_phase`(없으면 `phase`)를 trim해 씁니다. 없으면 기존 `current_phase`, 그것도 없으면 `planner`입니다. 결과 phase가 manifest 상태가 아니면 `unknown ralplan phase "<p>"`, 기존 phase가 manifest 상태인데 전이 표에 없는 이동이면 `invalid ralplan phase transition from <a> to <b>`로 거부합니다(AC12). 패치 병합 전후로 봉투 형식(`workflowEnvelopeError`)도 검사합니다. `_meta`는 패치에서 버립니다. 전체 거부 문구와 결과는 [ops.md](ops.md)에 있습니다.

### 읽기와 손상 상태

ralplan 코드는 읽기 예외(2장)를 이렇게 다룹니다. 문구는 실행해 얻은 것입니다(손상된 JSON의 경우).

| 읽는 곳 | 손상(읽기 예외)일 때 |
|---|---|
| `write`, `handoff`(`readStateForMutation`, `store.ts:250-260`) | 거부 문구 (a) |
| `start` | 활성 run 검사(`tool.ts:197`)는 읽기 예외를 "활성 아님"으로 보고 넘어가고, 이어서 `startRunTx`의 `readStateForMutation`이 (a)로 거부 |
| `state` | 거부 문구 (b) |
| `clear` | `force` 없이: 거부 문구 (c). `force`면 기존을 `{}`로 보고 `{skill, active: false, current_phase: "complete", updated_at, version}`로 덮어씀 |
| `status` | 상태를 `{}`로 돌려주고 끝에 `WARNING: failed to read <path>; ignoring corrupt state: <오류>` 한 줄 |
| doctor | 파일을 직접 파싱. JSON이 아니면 `schema_violation`. 한도 위반·소유 불일치는 보고하지 않음(9장) |
| 계획 가드, continuation, `skill ultragoal` 게이트, 압축 문맥, `readVisiblePrimaryTx` | 없는 것으로 봄(가드는 풀리고, continuation과 압축 문맥은 없고, 게이트는 ultragoal 시드로 넘어감) |

거부 문구(괄호 안은 StateStore 오류, 여기서는 손상된 JSON):

```text
(a) existing ralplan state is corrupt or tampered (state file is corrupted; it was preserved); refusing to overwrite <session>/state/ralplan-state.json. Reset it with `ralplan clear` and force: true.
(b) existing state for ralplan is corrupt or tampered (state file is corrupted; it was preserved); reset it with `ralplan clear` and force: true
(c) existing state for ralplan is corrupt or tampered (state file is corrupted; it was preserved); use force: true to overwrite
```

소유 세션이 다른 상태(`session_id: "ses_other"`)도 같은 길을 갑니다. `write`는 `… (state scope does not match this session; it was preserved); refusing to overwrite …`로 거부하지만 doctor는 `ok: true`입니다(실행으로 확인).

### `migrateRalplanState`

gjc `migrateWorkflowState`의 v1 → v2(`store.ts:263-279`; gjc `gjc-runtime/state-migrations.ts:62-127`과 대조함).

- `version`이 숫자이고 2 이상이면 그대로 돌려줍니다. 아니면 버전 1로 봅니다.
- `version: 2`, `skill: "ralplan"`을 넣고, `current_phase`(문자열이 아니면 `phase`)를 trim해 `"planning"`이면 `planner`로, manifest 상태가 아니면 `planner`로 바꿉니다. 문자열 `phase` 필드가 있으면 같은 값으로 맞춥니다.
- 부르는 곳은 `write`의 상태 쓰기 넷(`persistActiveRunIdTx`, `mergeRunStateTx`, `recordPlanningStuckTx`, `persistFinalAdmissionTx`)뿐입니다. `start`·`state`·`clear`·인계는 `version: 2`를 직접 넣고 phase를 옮기지 않습니다.
- open-gajae가 쓰는 상태는 모두 `version: 2`이므로, 실제로 옮겨지는 것은 다른 곳에서 온 파일(gjc v1 상태, 손으로 만든 파일)입니다. 그런 파일이 잠긴 phase(예: `complete`)에 있으면, 같은 run의 `write`는 조기 반환 조건(`version === 2`)을 통과하지 못해 `active: true`가 되고, phase는 manifest 상태가 아니므로 `planner`가 됩니다(코드 읽기로 확인, 실행해 보지는 않음).

### 알 수 없는 phase (DR-21)

`current_phase`가 알려진 phase(4장) 밖인 상태, 예를 들어 OMC 옛 형식 `{active: true, current_phase: "ralplan"}`은 StateStore로는 정상으로 읽힙니다. 손상이 아니므로 위 표가 아니라 각 소비자의 phase 검사가 다룹니다. 옮기는 코드는 없습니다(spec D-T10). 실행 결과:

| 소비자 | 결과 |
|---|---|
| 계획 가드, continuation, `skill ultragoal` 게이트, 압축 문맥 | `isKnownPhase`가 거짓이라 없는 것처럼 지나감(가드 해제, continuation 없음, 게이트는 ultragoal 시드) |
| doctor | `schema_violation`, `unknown ralplan phase "ralplan"`, 고치는 명령 `ralplan clear (force: true)` |
| `ralplan start` | **거부**: `ralplan run (none) is already active (phase ralplan); continue it with ralplan write. To plan anew, stop it first with ralplan state {"active": false} or ralplan clear.` 활성 run 검사(DR-39)는 `active === true`만 보고 phase를 보지 않습니다 |
| `ralplan state {"active": false}` | **거부**: `unknown ralplan phase "ralplan"`. 패치에 manifest phase(`current_phase`)를 함께 넣으면 통과합니다 |
| `ralplan handoff` | phase가 T 밖이라 거부 |
| `ralplan write` | `run_id`가 없거나 다르면 새 run으로 보고 정상 기록. 전이 감사는 이전 phase가 manifest 상태가 아니라 남지 않음 |
| `ralplan clear` (force 없이) | 통과. 결과는 `{skill, active: false, current_phase: "complete", iteration: 2, updated_at, version: 2}`처럼 다른 필드를 남김 |

`docs/development.md` "GJC로부터의 deviation (ralplan)"의 "수용한 동작 차이" 표 "이전 형식 state" 행이 이 동작을 적습니다. 정리하는 길은 `ralplan clear`입니다([known-limits.md](known-limits.md)).

## 4. phase manifest

`src/ralplan-runtime/manifest.ts`. gjc `gjc-runtime/workflow-manifest.ts:215-292`(ralplan `states`, `terminalStates`, `transitions`, `phaseLock`), `:154-160`(기본 `stopReleasingPhases`), `tools/skill.ts:42`(`TERMINAL_PHASES`), `gjc-runtime/ralplan-runtime.ts:81-91,666-670,971-984`에서 옮겼습니다(줄 번호는 파일 머리말의 값). 이 상수들은 여기에만 정의하고 모든 소비자가 가져다 씁니다(계획 P-AC15).

### 단계와 상태

- **단계** `RALPLAN_STAGES`(`:20-30`, gjc `KNOWN_STAGES` 순서): `planner`, `intent`, `architect`, `critic`, `disposition`, `revision`, `post-interview`, `adr`, `final`. `write`의 `stage` 입력은 이 아홉 중 하나여야 합니다(`assertRalplanStage`, `:136-144`: `unknown stage: <s>. Expected one of: …`).
- **상태** `RALPLAN_STATES`(`:34`): 아홉 단계와 `handoff`. 초기 상태 `RALPLAN_INITIAL_STATE`는 `planner`(`:35`).
- **manifest 종료 상태** `RALPLAN_TERMINAL_STATES`(`:37`): `final`, `handoff`.

### 전이 표

`RALPLAN_TRANSITIONS`(`:42-69`, gjc 표를 행 그대로). `verb`는 gjc 이름표이고 코드는 쓰지 않습니다.

| from | to (`write-artifact`) |
|---|---|
| `planner` | `intent`, `architect`(옛 run 호환, gjc 주석) |
| `intent` | `architect`, `revision` |
| `architect` | `critic`, `disposition` |
| `critic` | `disposition`, `revision`, `post-interview` |
| `disposition` | `revision`, `post-interview` |
| `revision` | `intent`, `post-interview`, `adr` |
| `post-interview` | `revision`, `adr` |
| `adr` | `final` |

그리고 `handoff` verb 8행: `planner`, `intent`, `architect`, `critic`, `disposition`, `revision`, `adr`, `post-interview` → `handoff`. `final`에서 나가는 행은 없습니다(`final` → `handoff`도 없음).

`isValidTransition(from, to)`(`:147-152`)는 같은 phase이거나 표의 행이면 참입니다.

- `write`는 표에 없는 이동도 씁니다. 감사 행 `invalid_transition_detected`만 남깁니다(spec D-T11). SKILL 순서가 이런 행을 늘 만듭니다: 병렬 리뷰 `intent→critic`·`critic→architect`, `architect→post-interview`, `post-interview→final` 등([known-limits.md](known-limits.md) RK9; 7장의 실행 예).
- `state` op는 표에 없는 이동을 거부합니다. 그래서 `final`에서는 같은 `final`(예: Stop here) 말고 어디로도 못 갑니다. 인계가 `final` → `handoff`를 `state` op가 아니라 공통 인계로 하는 까닭입니다(ralplan 편차 22).
- 인계의 caller 쓰기는 비활성이라 전이 검사를 하지 않습니다. callee로 쓰일 때는 검사합니다. 예: ralplan이 `handoff`나 `final`에 있다가 `ultragoal handoff(to:"ralplan")`로 `planner`가 되면 `handoff→planner`·`final→planner` 행이 표에 없어 `invalid_transition_detected`가 남습니다(`tests/skill-state.test.ts` "handoff ultragoal → ralplan: …").

### phase lock, T, R, 알려진 phase

| 이름 | 값 | 정의 |
|---|---|---|
| phase lock(잠긴 phase) `RALPLAN_PHASE_LOCK` | `final`, `handoff`, `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive` | `:72-81`, gjc `phaseLock`(= `canonicalOverrides`) |
| T `TERMINAL_PHASES` | phase lock과 같은 여덟: `final`, `handoff` ∪ gjc skill 도구의 `complete`, `completed`, `handoff`, `failed`, `cancelled`, `canceled`, `inactive` | `:84-102`, 계획 C-2 |
| R `GUARD_RELEASE_PHASES` | `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive` | `:109-116`, gjc 기본 `stopReleasingPhases` |
| 알려진 phase `KNOWN_PHASES` | 상태 10개 ∪ R = 16개 | `:119-122`, 계획 C-3 |

- `advanceCurrentPhase(existing, stage)`(`:158-166`): 기존 phase가 잠겨 있으면 그대로, 아니면 방금 쓴 단계(계획 DR-3).
- open-gajae 코드가 쓰는 R phase는 `clear`의 `complete` 하나입니다. `completed`, `failed`, `cancelled`, `canceled`, `inactive`는 gjc 호환을 위해 집합에만 있고, `state` op로도 쓸 수 없습니다(manifest 상태가 아님).
- T와 phase lock은 값이 같지만 다른 이름입니다. T는 "끝난 계획"(continuation 멈춤, 인계 허용), phase lock은 "단계 쓰기가 phase를 옮기지 않음"입니다.

### 어느 집합을 누가 쓰나

| 소비자 | 쓰는 집합 | 위치 |
|---|---|---|
| 계획 가드 | 알려진 phase이고 R 밖이며 `active`일 때 막음(그래서 `final`·`handoff`도 막음) | `guardPlanning`, `src/hooks.ts:742-782` |
| continuation | 알려진 phase 밖이면 건너뜀, T이거나 `planning_stuck`이면 건너뛰고 카운터 초기화 | `shouldContinue`, `src/ralplan.ts:121-138` |
| `skill ultragoal` 게이트 | 이번 execution에서 ralplan을 로드했고(턴 표식) 상태가 알려진 phase이며 `active`일 때만 판단: T 밖이면 거부(`RALPLAN_RUNNING_REFUSAL`), T면 인계 | `ultragoalGate`, `src/hooks.ts:796-818` |
| `ralplan handoff` op | T 밖이면 거부(DR-7, ralplan 편차 34) | `ralplanHandoffTx`, `store.ts:1338-1342` |
| `ralplan state` op | manifest 상태(10개)만 받고 전이 표 검사 | `patchStateTx`, `store.ts:1039-1046` |
| `write`의 상태 쓰기 | 활성 쓰기는 manifest 상태여야 함, 표에 없으면 감사 행, 잠긴 phase는 유지 | `writeStateTx`(`store.ts:193-247`), `persistActiveRunIdTx` |
| `clear`의 낡음 판정 | R(`inactive` 제외)이면 거부, 보이는 행 phase는 phase lock으로 치환 | `describeStaleClearTx`, `store.ts:1093-1130` |
| 보이는 주 skill | phase lock으로 행 phase 치환 | `readVisiblePrimaryTx`, `src/skill-state/rows.ts:254-283` |
| doctor | 알려진 phase 밖이면 `schema_violation`, 비활성 상태의 phase는 phase lock 안일 때만 비교 | `DOCTOR_SKILLS`, `modeStatePhase`(`src/skill-state/doctor.ts:57-61,109-119`) |
| 압축 문맥 | 알려진 phase이고 `active`일 때만 | `src/hooks.ts:1213-1215` |
| 인계(callee 감사) | manifest 상태와 전이 표 | `HANDOFF_SKILLS.ralplan.manifest`, `src/skill-state/handoff.ts:76-83` |
| `status`의 `next` 투영 | 전이 표의 `to` 목록 | `projectStateFields`, `store.ts:1242-1246` |

T를 쓰는 곳은 위 표의 셋(continuation, `skill ultragoal` 턴 게이트, handoff op)뿐입니다(`manifest.ts:97` 주석과 같음).

## 5. 활성 행, 스냅숏, 순위, 보이는 주 skill

공통 코드 `src/skill-state/rows.ts`(gjc `skill-state/active-state.ts`, `gjc-runtime/state-writer.ts`; 편차는 rows.ts 머리말: ralplan 17로 revision·stale-skip·`thread_id`/`turn_id`·active subskill 없음).

### 활성 행 `state/active/ralplan.json`

`rowEntry`(`rows.ts:104-119`)의 모양입니다. `start` 직후:

```json
{
  "skill": "ralplan",
  "phase": "planner",
  "active": true,
  "activated_at": "2026-10-03T15:02:51.457Z",
  "updated_at": "2026-10-03T15:02:51.457Z",
  "session_id": "ses_root",
  "hud": {
    "version": 1,
    "summary": "short run · automated",
    "chips": [
      { "label": "stage", "value": "planner", "priority": 10 },
      { "label": "iter", "value": "1", "priority": 30 }
    ],
    "updated_at": "2026-10-03T15:02:51.455Z"
  }
}
```

- `activated_at`과 `updated_at`은 행을 쓴 시각이고, 다시 쓸 때마다 바뀝니다(gjc와 같음).
- 인계로 쓴 행에만 `handoff_from` 또는 `handoff_to`와 `handoff_at`이 붙습니다.
- `state` op가 쓴 행에만 `receipt`가 붙습니다(`stateWriteReceipt`, `store.ts:295-313`, gjc `buildWorkflowStateReceipt`). 다음 `write`가 행을 다시 쓰면 사라집니다. 활성 `final`에 `state(patch={"note": …})`를 한 뒤:

```json
"receipt": {
  "version": 1,
  "skill": "ralplan",
  "owner": "open-gajae-runtime",
  "command": "ralplan state",
  "state_path": "<session>/state/skill-active-state.json",
  "storage_path": "<session>/state/ralplan-state.json",
  "mutated_at": "2026-10-03T15:03:57.356Z",
  "fresh_until": "2026-10-03T15:33:57.356Z",
  "status": "fresh",
  "mutation_id": "ralplan:2026-10-03T15:03:57.356Z"
}
```

`fresh_until`은 `mutated_at` + 30분(`RECEIPT_FRESH_MS`, `store.ts:136`)입니다. 이 영수증을 읽는 코드는 없습니다. 상태 봉투에는 영수증이 없으므로 `status(fields=["fresh"])`는 늘 `false`입니다(`projectStateFields`는 상태의 `receipt`를 봄).

### 행을 쓰고 지우는 때

| 언제 | 행 | 코드 |
|---|---|---|
| `start` | 활성 행 `planner`. 먼저 위쪽 파이프라인 행(`deep-interview`)을 지움 | `syncActiveRowTx`(`rows.ts:149-162`), `store.ts:957-977` |
| `write`(새 기록) | 활성 행, `phase` = **방금 쓴 단계**. 상태가 비활성이거나 잠긴 phase여도 활성 행을 씀 | `store.ts:842-866` |
| `write`(원장 중복, 디스크 복구) | 행을 건드리지 않음 | `store.ts:667-759` |
| `write`가 PLANNING-STUCK | 행을 건드리지 않음 | `store.ts:769-800` |
| `state` op, 결과 `active: true` | 활성 행, `phase` = 결과 `current_phase`, `receipt` | `store.ts:1056-1070` |
| `state` op, 결과 `active: false`(Stop here), 차단기 소진 | 행 삭제(R-OD10) | 같음 |
| `clear` | 행 삭제 | `store.ts:1180` |
| `handoff`(ralplan이 caller) | **비활성** 행 `{active: false, phase: "handoff", handoff_to, handoff_at}`. 이전 행의 `handoff_from`은 이어받음 | `writeHandoffRowsTx`(`rows.ts:170-184`) |
| ralplan이 callee(ultragoal·deep-interview에서 넘어옴) | 활성 행 `{phase: "planner", handoff_from, handoff_at}` | 같음 |
| ultragoal이 활성 행을 씀(seed, reconcile, `state` 등) | 위쪽 파이프라인 행이라 삭제(`remove-superseded-pipeline-entry`). ralplan 상태는 그대로 | `syncActiveRowTx` |

- `start`·`write`·`state`·`clear`의 행 동기화는 best-effort입니다(`bestEffort`, `store.ts:286-292`). 실패해도 op 결과는 바뀌지 않습니다(gjc HUD 동기화와 같음). 인계의 행 쓰기는 best-effort가 아닙니다.
- 행 쓰기는 하위 skill(ultragoal)의 행을 지우지 않습니다. 인계는 위쪽 행을 지우지 않습니다.
- **Stop here나 `clear` 뒤의 `write`**: 상태는 비활성으로 남지만(3장) 행은 다시 **활성**으로 생깁니다(실행으로 확인). 그러면 ralplan이 다시 보이는 주 skill이 됩니다(phase는 아래처럼 잠긴 `final`·`complete`로 보임). 계획 가드와 continuation은 상태의 `active`를 따로 보므로 다시 켜지지 않지만, doctor는 `active entry for ralplan does not match a live active mode-state`를 보고하고, deep-interview `start`와 취소된 인터뷰의 재개는 ralplan을 이유로 거부합니다(`otherPrimaryTx`, `src/deep-interview-runtime/store.ts:217-223,313-314,708-711`). Stop here 뒤라면 `state {"active": false}`나 `clear`가 이 행을 지웁니다. `clear` 뒤라면 `clear(force: true)`, 또는 manifest phase를 함께 넣은 `state` 패치(예: `{"active": false, "current_phase": "final"}`)가 지웁니다. 이전 phase `complete`가 manifest 상태가 아니라 전이 검사를 건너뛰기 때문입니다(`store.ts:1041-1046`). phase를 `complete`에 둔 채의 `state {"active": false}`는 `unknown ralplan phase "complete"`로, force 없는 `clear`는 이미 끝난 상태로 거부됩니다(모두 실행으로 확인). ultragoal의 활성 행도 이 행을 지웁니다. 상태가 비활성이므로 `ralplan handoff`는 거부됩니다(R-OD18). [known-limits.md](known-limits.md) RK8도 이 동작을 적습니다.

### 방금 쓴 단계와 잠긴 phase (R-OD5, R-OD15)

- **기록**(R-OD5, 계획 DR-8): `write`는 행 `phase`와 `stage` 칩에 방금 쓴 단계를 씁니다(gjc `syncRalplanHud({stage: persisted.stage})`). `start`·`state`·인계는 결과 `current_phase`를 씁니다. 그래서 `final` 뒤 다듬기(`revision` 2)에서 상태는 `final`, 행은 `revision`입니다(실행 결과의 행 `phase: "revision"`, 상태 `current_phase: "final"`).
- **보이는 읽기**(R-OD15): `readVisiblePrimaryTx`는 ralplan 상태의 phase가 phase lock 안이면(비활성 상태는 phase lock 안일 때만 셈, `modeStatePhase`) 행 `phase`와 `stage` 칩 값을 그 phase로 바꿔 돌려줍니다(gjc `withCanonicalRalplanPhase`, `active-state.ts:507-546`과 대조함). 파일은 바꾸지 않습니다. Stop here 뒤 `adr` 2를 쓴 행을 보이는 읽기로 보면 `phase: "final"`, `stage` 칩 `final`입니다(실행 결과).
- **원본을 읽는 곳**: 스냅숏의 맨 위 `phase`와 doctor는 원본 행을 봅니다. 그래서 다듬기 중 doctor는 `stale_active_state`를 보고합니다(9장, R-OD8). `clear`의 낡음 판정은 보이는 읽기와 같은 치환을 해서 다듬기 중 `clear`는 통과합니다(R-OD14).

### 스냅숏 `state/skill-active-state.json`

`rebuildSnapshotTx`(`rows.ts:212-235`)가 행이 바뀔 때마다 `state/active/`의 `.json` 파일을 이름 순으로 모두 읽어 새로 씁니다. 이전 스냅숏은 읽지 않습니다.

```json
{
  "version": 1,
  "active": true,
  "skill": "ralplan",
  "phase": "planner",
  "updated_at": "2026-10-03T15:02:51.457Z",
  "session_id": "ses_root",
  "active_skills": [ { "skill": "ralplan", "phase": "planner", "active": true, … } ],
  "active_subskills": []
}
```

- `active_skills`는 JSON 객체이고 공백 아닌 `skill`을 가진 행 전부(비활성 행 포함)입니다. 파싱이 안 되는 행 파일이 하나라도 있으면 다시 만들기가 예외입니다.
- 맨 위 `skill`·`phase`·`updated_at`·`session_id`는 `active !== false`인 행 중 순위가 가장 높은 것의 원본 값입니다. 그런 행이 없으면 `active: false`, 빈 문자열 셋, `session_id` 없음입니다(Stop here 뒤 실행 결과와 같음).
- ralplan → ultragoal 인계 뒤에는 비활성 ralplan 행과 활성 ultragoal 행이 둘 다 `active_skills`에 있고, 맨 위는 `ultragoal`·`goal-planning`입니다.

### 순위와 보이는 주 skill

- **파이프라인 순위** `PIPELINE_RANK`(`rows.ts:51-55`): `deep-interview`(0) → `ralplan`(1) → `ultragoal`(2). 높은 쪽이 이깁니다. `comparePrimary`(`:76-88`)는 한쪽이라도 파이프라인 skill이면 순위만 봅니다. 활성 행을 쓰면 낮은 순위 행을 지웁니다.
- **보이는 주 skill(visible primary)** `readVisiblePrimaryTx`(`rows.ts:246-292`): 스냅숏 항목 위에 행 파일을 덮고(행이 이김), `active !== false`인 것만 남기고, ralplan 행의 phase를 위처럼 치환한 뒤, 파이프라인을 가장 높은 단계 하나로 줄여 첫 항목을 돌려줍니다. 스냅숏이나 ralplan 상태를 읽지 못하면 없는 것으로 보고, 행 파일이 깨졌으면 예외입니다.
- 이 값을 보는 곳: 계획 가드(주 skill이 ralplan일 때만 ralplan 상태를 봄), ralplan continuation(PQ-7 B, ralplan 편차 10), `skill` 체인 가드(ultragoal이 주 skill이면 `skill ralplan`·`skill deep-interview` 로드를 거부, `visiblePrimary`, `src/hooks.ts:1059-1073`), deep-interview `start`·재개 거부, deep-interview 자신의 편집 가드·continuation·압축 문맥(`guardedPhaseTx`, `src/deep-interview-runtime/hooks.ts:76-83`). 그래서 ultragoal 행이 활성인 동안에는 ralplan 상태가 활성이어도 ralplan 가드와 continuation이 돌지 않습니다([guards-and-continuation.md](guards-and-continuation.md)).

## 6. HUD 칩

`src/ralplan-runtime/hud.ts`(gjc `skill-state/workflow-hud.ts:188-248` `buildRalplanHudSummary`, 칩 순서 대조함), 공통 도우미와 정규화는 `src/skill-state/hud.ts`. 칩은 활성 행의 `hud`에 **저장만** 합니다. 그리는 코드는 없습니다(ralplan 편차 9, R-OD17: TUI 사이드바 보류, `docs/development.md` "필수 후속 개발" 6번).

### 계산하는 곳

| 행을 쓰는 곳 | 만드는 함수 | 입력 |
|---|---|---|
| `start` | `buildRalplanHud`(`hud.ts:139-182`) | `stage: "planner"`, `iteration: 1`, run의 `index.jsonl`, `summary` = `<mode> run · interactive` 또는 `<mode> run · automated` |
| `write`(새 기록) | `buildRalplanHud` | 방금 쓴 단계, `iteration: stage_n`, `pendingApproval: stage === "final"`, `reviewPassBudget: maxReviewPassesPerLane`, 쓴 뒤 다시 읽은 `index.jsonl`, 상태의 `last_review_verdict`, `summary` = `persisted <stage> stage <n>` |
| `state` op, 인계의 ralplan 행 | `buildRalplanHudFromState`(`hud.ts:188-210`) | 상태만: `stage` = `current_phase`(문자열이 아니면 `mode`), `verdict` = `last_review_verdict` ?? `verdict`, `iteration` = 숫자 `iteration` 필드(open-gajae 코드는 쓰지 않음, `state` 패치나 옛 상태에만 있음), `pendingApproval` = `pending_approval === true` 또는 `stage === "final"`. `summary` 없음 |

### 칩

`buildRalplanHudSummary`(`hud.ts:66-131`)가 이 순서로 넣습니다.

| 칩 | 우선순위 | 값 | 나오는 조건 |
|---|---|---|---|
| `pending` | 5 | `approval`, severity `warning` | `pendingApproval` |
| `gate`, `blocked`, `next` | 6, 16, 26 | 공통 `gateChips` | open-gajae는 입력을 주지 않아 나오지 않음 |
| `stage` | 10 | 위 표의 stage | 값이 있을 때 |
| `waiting` | 20 | — | 입력을 주지 않아 나오지 않음 |
| `iter` | 30 | `iterationFromIndex` ?? `iteration` | `iterationFromIndex`는 원장에서 센 반복 수(`summarizeRalplanIndex`: `planner`·`revision` 행마다 하나, 첫 행이 opener가 아니면 1). 원장 행이 없으면 입력 `iteration`(`start`는 1, `write`는 `stage_n`). `state` op·인계 행은 상태의 `iteration` 필드가 있을 때만 |
| `stages` | 35 | 현재 반복의 단계 단어를 ` · `로 이음 | 원장 행이 있을 때 |
| `arch`, `crit` | 36, 38 | `<현재 반복의 architect·critic 행 수>/<maxReviewPassesPerLane>` | `pending`이 아니고, 수가 1 이상이고, 예산을 받았을 때(`write`만) |
| `verdict` | 40 | verdict 대문자. `BLOCK`·`REJECT` → `blocked`, `ITERATE`·`WATCH` → `warning`, `APPROVE`·`CLEAR`·`OKAY` → `success` | verdict가 있을 때 |
| `handoff` | 45 | `<configuredTarget>→<effectiveTarget>[:<degradationReason>]`. severity: 원장이 stuck이면(stuck 행, 또는 읽을 수 없거나 파싱 안 되는 줄이 있는 원장, `readRalplanPlanningStuck`) `blocked`, 아니고 `degradationReason`이 있으면 `warning` | 원장에 final 행이 있을 때(`readRalplanFinalAdmission`: 마지막 final 행의 승인). `start`·`write`만 |

- **`stages` 단어와 80자**(ralplan 편차 9): `formatRalplanStagePresence`(`ledger.ts:297-312`)는 gjc의 글자 코드(`P·A·C`) 대신 단어를 씁니다. 최대 6단어를 보이고, 나머지는 ` … N more stage(s)`로 붙입니다. 이 꼬리까지 합쳐 80자(`HUD_TEXT_LIMIT`)를 넘으면 단어를 하나씩 줄여, 정규화가 값을 자르지 않게 합니다. 단어를 중간에서 자르지 않습니다. 실행 예:
  ```
  planner · intent · architect · critic · disposition … 3 more stages
  revision · architect · critic · post-interview · adr · final … 1 more stage
  ```
  첫 줄은 8단계 중 6단어를 보이면 84자라 5단어로 줄인 것입니다.
- **`pending`**: `write(stage="final")`과, 활성 `final`에서의 `state` op가 붙입니다. `pending`이 있으면 `arch`·`crit`는 나오지 않습니다. Stop here는 행을 지우므로 `pending` 칩도 사라집니다(`docs/development.md` "GJC로부터의 deviation (ralplan)"의 "수용한 동작 차이" 표 "Stop here가 활성 행을 제거" 행).
- **정규화**(`normalizeWorkflowHudSummary`, `src/skill-state/hud.ts:129-146`, 계획 DR-9, gjc와 같은 값): `version`이 1이 아니면 버림, 칩은 배열 순서대로 최대 6개, label 32자, value·summary 80자에서 자름, ANSI 제거, 줄바꿈·탭은 공백, 모르는 severity는 버림, `updated_at` 40자.
- **6개 한도로 빠지는 칩**: `pending`이 없을 때 `stage`, `iter`, `stages`, `arch`, `crit`, `verdict`, `handoff`가 모두 있으면 일곱이라 마지막 `handoff`가 빠집니다. 실행 예: `final` 1 뒤 `revision`·`architect`·`critic` 2를 쓴 행의 칩은 `stage=critic`, `iter=2`, `stages=revision · architect · critic`, `arch=1/1`, `crit=1/1`, `verdict=OKAY`이고 `handoff`가 없습니다. gjc도 같은 순서와 한도라 같은 결과입니다.

예: 1회차 `final` 뒤의 칩(`write`가 쓴 행).

```json
[
  { "label": "pending", "value": "approval", "priority": 5, "severity": "warning" },
  { "label": "stage", "value": "final", "priority": 10 },
  { "label": "iter", "value": "1", "priority": 30 },
  { "label": "stages", "value": "planner · intent · critic · architect · post-interview · final", "priority": 35 },
  { "label": "verdict", "value": "WATCH", "priority": 40, "severity": "warning" },
  { "label": "handoff", "value": "off→off", "priority": 45 }
]
```

PLANNING-STUCK 뒤 `autoHandoff: "ultragoal"`로 쓴 `final`의 `handoff` 칩은 `{"label":"handoff","value":"ultragoal→off:planning_stuck","priority":45,"severity":"blocked"}`입니다(실행 결과).

## 7. 감사 로그

`state/audit.jsonl`. 파일이 바뀔 때마다 한 줄입니다(`appendAudit`, `src/skill-state/audit.ts:37-53`, gjc `state-writer.ts:517-532` `maybeAudit`; 계획 DR-18).

| 필드 | 뜻 |
|---|---|
| `ts` | 쓴 시각 |
| `skill` | 상태·산출물·원장 행에만(`ralplan`, 인계의 상대 skill). 행·스냅숏·저널 행에는 없음 |
| `category` | `state`, `artifact`, `ledger` |
| `verb` | 아래 표 |
| `owner` | 도구는 `open-gajae-runtime`, 훅은 `open-gajae-hook`(ralplan 편차 21; gjc는 `gjc-runtime`/`gjc-hook`) |
| `mutation_id` | 준 값, 없으면 새 uuid |
| `from_phase`, `to_phase` | 준 경우에만 |
| `forced` | 기본 `false` |
| `paths` | 바꾼 파일 하나의 배열 |

값이 없는 선택 필드는 JSON에서 빠집니다.

ralplan이 남기는 행:

| 일 | `category/verb` | `mutation_id` | phase 필드 |
|---|---|---|---|
| `start`, `write`의 상태 쓰기(phase 전진, 역할 메타데이터, verdict, stuck, 승인) | `state/write` | uuid | 없음 |
| `write`의 활성 쓰기가 전이 표에 없는 이동 | `state/invalid_transition_detected`(그 쓰기 앞, best-effort) | `ralplan:invalid-transition:<at>` | 둘 다 |
| 단계 파일, `pending-approval.md` | `artifact/write` | uuid | 없음 |
| `index.jsonl`의 단계 행과 PLANNING-STUCK 행 | `ledger/append` | uuid | 없음 |
| `state` op | `state/write` | `ralplan:<at>` | `to_phase`, 이전 phase가 있으면 `from_phase` |
| continuation 차단기 소진(owner `open-gajae-hook`) | `state/write` | `ralplan:breaker-exhausted:<at>` | 같음 |
| `clear` | `state/clear`, `forced` = `force` | `ralplan:clear:<at>` | `to_phase: "complete"`, 이전 phase가 있으면 `from_phase` |
| 인계(ralplan이 caller나 callee) | `state/handoff`(callee, caller 순) | `<caller>:handoff:<callee>:<at>` | 같음 |
| 인계에서 ralplan이 callee이고 표에 없는 이동 | `state/invalid_transition_detected` | 인계의 id | 둘 다 |
| 행·스냅숏 | `state/write-active-entry`, `state/remove-active-entry`, `state/remove-superseded-pipeline-entry`, `state/rebuild-active-snapshot` | uuid | 없음 |
| 인계 저널 | `state/write-transaction-journal`, `state/remove-transaction-journal` | 인계의 id | 없음 |

`ralplan-continuation.json`의 쓰기는 감사하지 않습니다(ralplan 편차 26). 차단기 소진만 감사에 남고, 세 행입니다: `breaker-exhausted`가 붙은 상태 `write`, 행 삭제 `remove-active-entry`, `rebuild-active-snapshot`(모두 owner `open-gajae-hook`, 실행 결과).

실행에서 얻은 행(시각과 uuid는 실행마다 다름):

```text
{"ts":"2026-10-03T15:02:51.456Z","skill":"ralplan","category":"state","verb":"write","owner":"open-gajae-runtime","mutation_id":"2eac8e1c-926f-486b-99e0-bcfddd8115d5","forced":false,"paths":["<session>/state/ralplan-state.json"]}
{"ts":"2026-10-03T15:02:51.466Z","skill":"ralplan","category":"state","verb":"invalid_transition_detected","owner":"open-gajae-runtime","mutation_id":"ralplan:invalid-transition:2026-10-03T15:02:51.466Z","from_phase":"intent","to_phase":"critic","forced":false,"paths":["<session>/state/ralplan-state.json"]}
{"ts":"2026-10-03T15:02:51.476Z","skill":"ralplan","category":"artifact","verb":"write","owner":"open-gajae-runtime","mutation_id":"9033404e-361c-46bb-8712-b4047fafa4f9","forced":false,"paths":["<session>/plans/ralplan/ses_root/stage-01-final.md"]}
{"ts":"2026-10-03T15:02:51.477Z","skill":"ralplan","category":"ledger","verb":"append","owner":"open-gajae-runtime","mutation_id":"48ce0aa4-4950-4323-be0e-446af0e13d7a","forced":false,"paths":["<session>/plans/ralplan/ses_root/index.jsonl"]}
{"ts":"2026-10-03T15:02:51.492Z","skill":"ralplan","category":"state","verb":"write","owner":"open-gajae-runtime","mutation_id":"ralplan:2026-10-03T15:02:51.491Z","from_phase":"final","to_phase":"final","forced":false,"paths":["<session>/state/ralplan-state.json"]}
{"ts":"2026-10-03T15:02:51.496Z","skill":"ralplan","category":"state","verb":"clear","owner":"open-gajae-runtime","mutation_id":"ralplan:clear:2026-10-03T15:02:51.495Z","from_phase":"final","to_phase":"complete","forced":false,"paths":["<session>/state/ralplan-state.json"]}
{"ts":"2026-10-03T15:02:51.542Z","skill":"ralplan","category":"state","verb":"handoff","owner":"open-gajae-runtime","mutation_id":"ralplan:handoff:ultragoal:2026-10-03T15:02:51.541Z","from_phase":"final","to_phase":"handoff","forced":false,"paths":["<session>/state/ralplan-state.json"]}
{"ts":"2026-10-03T15:02:51.564Z","skill":"ralplan","category":"state","verb":"write","owner":"open-gajae-hook","mutation_id":"ralplan:breaker-exhausted:2026-10-03T15:02:51.564Z","from_phase":"planner","to_phase":"planner","forced":false,"paths":["<session>/state/ralplan-state.json"]}
```

한 `write`가 남기는 순서의 예(역할 critic이 `intent` 다음에 `critic` 1을 `lane_verdict`·`resumable`과 함께 씀): `invalid_transition_detected`(intent → critic) → `state/write`(phase) → `artifact/write`(단계 파일) → `ledger/append` → `state/write`(역할 메타데이터) → `state/write`(verdict) → `write-active-entry` → `rebuild-active-snapshot`. `final`이면 `ledger/append` 뒤에 `artifact/write`(`pending-approval.md`)가, 메타데이터 뒤에 `state/write`(승인)가 더 붙습니다. phase가 바뀌지 않는 `write`(예: `start` 직후의 `planner` 1)는 첫 `state/write`가 없습니다.

## 8. 인계 저널

`state/transactions/<인코딩한 mutation id>.json`(`src/skill-state/journal.ts`, gjc `state-writer.ts:82-92,1590-1640`). 공통 인계 `handoffWorkflowTx`(`src/skill-state/handoff.ts:212-322`)가 시작할 때 `pending`으로 만들고, 단계마다 `steps`를 갱신하고, 끝에 `committed`로 쓴 뒤 지웁니다. 인계 단계 자체는 [entry-and-handoff.md](entry-and-handoff.md)에 있습니다.

- 파일 이름(`journalPath`, `journal.ts:38-41`): `encodeURIComponent(mutation id)`에서 `.`을 `%2E`로 바꾼 뒤 `.json`. 예: `ralplan%3Ahandoff%3Aultragoal%3A2026-10-03T15%3A02%3A51%2E541Z.json`.
- `paths`는 callee 상태, caller 상태, 스냅숏 순서입니다. `steps`는 `callee-mode-state`, `caller-mode-state`, `active-state`(ultragoal이 caller일 때만 `caller-records`가 더 붙음).
- 같은 이름의 저널이 이미 있으면 새로 만들지 않습니다(gjc의 `wx` 대신 큐 안의 확인과 쓰기). 쓰기마다 `write-transaction-journal` 감사 행이 남습니다(gjc는 저널을 감사하지 않음).
- 증거용입니다. 다시 실행하거나 되돌리는 코드가 없고 doctor도 읽지 않습니다(ralplan 편차 13, ultragoal 계획 I-19). 인계 중간에 예외가 나면 `pending` 저널이 남습니다. 정상 인계 뒤 `state/transactions/`는 빈 디렉터리로 남습니다(실행 결과 `[]`).

`ralplan handoff(to="ultragoal")`에서 `active-state` 단계 뒤에 쓴 저널(쓰기를 가로채 얻음):

```json
{
  "version": 1,
  "mutation_id": "ralplan:handoff:ultragoal:2026-10-03T15:02:51.541Z",
  "status": "pending",
  "created_at": "2026-10-03T15:02:51.541Z",
  "updated_at": "2026-10-03T15:02:51.544Z",
  "caller": "ralplan",
  "callee": "ultragoal",
  "paths": [
    "<session>/state/ultragoal-state.json",
    "<session>/state/ralplan-state.json",
    "<session>/state/skill-active-state.json"
  ],
  "steps": ["callee-mode-state", "caller-mode-state", "active-state"]
}
```

## 9. doctor

`ralplan doctor`는 `doctorTx`(`store.ts:1286-1288`) → `collectDoctorSummaryTx(tx, "ralplan")`(`src/skill-state/doctor.ts:149-279`, gjc `state-runtime.ts:317-604` `collectDoctorSummary`)입니다. 읽기만 하고 고치지 않습니다. ralplan 도구는 요약 객체를 **JSON**으로 돌려줍니다. 같은 요약의 gjc 텍스트 형식(`renderDoctorText`)은 ultragoal과 deep-interview 도구가 씁니다(spec D-T13; ultragoal 계획 C-14).

### 검사

ralplan만 고르므로 `skills_scanned`는 1입니다. 파일은 직접 파싱합니다(`readRawJsonTx`, `doctor.ts:82-93`). StateStore 읽기 검사를 거치지 않습니다.

| 대상 | 조건 | 종류 | 메시지 |
|---|---|---|---|
| `state/ralplan-state.json` | JSON 파싱 실패 | `schema_violation` | `mode-state JSON is unreadable: <오류>` |
| 같음 | 봉투 형식 위반(`workflowEnvelopeError`, `doctor.ts:64-79`) | `schema_violation` | `state for ralplan must be a JSON object`, `state skill must match selected mode ralplan`, `state.active must be a boolean when present`, `state.current_phase must be a string when present`, `state.version must be a number when present`, `state.updated_at must be a string when present`, `state.receipt must be an object when present` |
| 같음 | `current_phase`가 문자열인데 알려진 phase 밖(DR-21) | `schema_violation` | `unknown ralplan phase "<p>"` |
| `state/active/*.json`의 ralplan 행 | 행이 활성인데 상태가 없거나 비활성 | `stale_active_state` | `active entry for ralplan does not match a live active mode-state` |
| 같음 | 행이 활성이고 상태가 형식 위반이 아니며, 행 `phase` ≠ 상태의 기준 phase | `stale_active_state` | `active entry for ralplan phase <a> differs from canonical mode-state phase <b>` |
| 스냅숏의 ralplan 항목 | 활성인데 ralplan 행 파일이 없음 | `stale_active_state` | `active snapshot lists ralplan but no raw per-skill active entry exists` |
| 같음 | 활성이고 phase가 다름 | `stale_active_state` | `active snapshot for ralplan phase <a> differs from canonical mode-state phase <b>` |

- 상태의 기준 phase(`modeStatePhase`, `doctor.ts:109-119`)는 `current_phase`이되, 비활성 상태는 phase lock 안일 때만 셉니다. 행 phase는 치환하지 않고 원본을 봅니다(R-OD8).
- `files_scanned`는 상태 파일, `state/active/`의 모든 `.json`(다른 skill 행 포함), 스냅숏을 셉니다. 깨진 행 파일은 세기만 하고 문제로 보고하지 않습니다(실행: 깨진 `active/ralplan.json`에서 `ok: true`, `files_scanned: 3`).
- 고치는 명령(`fixCommand`): `schema_violation`이면 `ralplan clear (force: true)`, `stale_active_state`면 `ralplan clear`(ralplan 편차 1: gjc의 `gjc state … migrate|clear` 대신 도구 op 이름, migrate op 없음). 문제는 종류, skill, 경로 순으로 정렬합니다.

### 출력

`final` 뒤 다듬기(`revision` 2)를 쓴 직후([known-limits.md](known-limits.md) RK8):

```json
{
  "ok": false,
  "root": "<session>/state",
  "summary": {
    "skills_scanned": 1,
    "files_scanned": 3,
    "findings_total": 2,
    "by_kind": { "schema_violation": 0, "stale_active_state": 2 }
  },
  "problems": [
    {
      "type": "stale_active_state",
      "skill": "ralplan",
      "path": "<session>/state/active/ralplan.json",
      "message": "active entry for ralplan phase revision differs from canonical mode-state phase final",
      "fixCommand": "ralplan clear"
    },
    {
      "type": "stale_active_state",
      "skill": "ralplan",
      "path": "<session>/state/skill-active-state.json",
      "message": "active snapshot for ralplan phase revision differs from canonical mode-state phase final",
      "fixCommand": "ralplan clear"
    }
  ]
}
```

이 보고는 gjc와 같은 알려진 동작입니다. `clear`는 run을 끝내므로 이 보고만으로 부르지 않습니다(R-OD8, 계획 R-25). Stop here 뒤 `write`를 했다면 여기에 `active entry for ralplan does not match a live active mode-state`가 하나 더 붙습니다(실행 결과 `findings_total: 3`). 문제가 없으면 `ok: true`, `findings_total: 0`, `problems: []`이고, 보통 `files_scanned`는 3(상태, 행, 스냅숏), ralplan → ultragoal 인계 뒤에는 4입니다.

### 하지 않는 검사

- checksum, 고아(pending) 인계 저널, `journals_scanned`(ralplan 편차 13).
- revision 비교: 행과 스냅숏에 revision이 없고, `stale_active_state`는 phase와 `active`만 비교합니다(ralplan 편차 17).
- StateStore 읽기 검사(한도, 소유 세션): JSON으로 읽히면 문제로 보지 않습니다. 실행: 소유 세션이 다른 상태에서 `ok: true`.
- run 폴더(단계 파일, `index.jsonl`, `pending-approval.md`의 sha256), continuation 카운터 파일, 다른 skill의 상태.

## 10. 저장소 바인딩

`src/ralplan-runtime/binding.ts`(gjc `gjc-runtime/repository-binding.ts:13-30,207-215`, 줄 번호는 파일 머리말의 값). 파일 머리말과 ralplan 편차 12에 따르면 gjc는 `.git`을 직접 읽어 바인딩을 잡고 worktree가 다르면 쓰기를 거부합니다(gjc 쪽은 이 문서를 쓰며 다시 확인하지 않았습니다). 여기서는 기록만 하고 강제하지 않습니다(ralplan 편차 12, spec D-T9).

**모양** `gjc.repository_binding.v1`(`REPOSITORY_BINDING_SCHEMA`):

| 필드 | 값 |
|---|---|
| `schema` | `"gjc.repository_binding.v1"` |
| `worktreeRoot` | git 저장소면 `git rev-parse --show-toplevel`의 realpath, 아니면 `projectDir`의 realpath |
| `commonDir` | git 저장소면 `git rev-parse --git-common-dir`을 `projectDir` 기준으로 푼 realpath, 아니면 `null` |
| `displayPath` | 받은 `projectDir` 그대로(권한 판단에 쓰지 않음) |
| `head` | `git rev-parse --verify --quiet HEAD`. git 저장소에서 값이 있을 때만(태어나지 않은 브랜치면 없음) |
| `branch` | `git symbolic-ref --quiet HEAD`가 `refs/heads/`로 시작할 때 그 뒤 이름. 분리된 HEAD면 없음 |

**잡는 법** `captureRepositoryBinding(projectDir)`(`binding.ts:63-93`): `projectDir`을 realpath로 푼 뒤 git 명령 넷을 병렬로 `execFile`합니다(`timeout` 2,000 ms, `GIT_TIMEOUT_MS`). 명령이 실패하거나 시간이 넘거나 출력이 비면 그 값은 없는 것입니다. 저장소 여부는 `--show-toplevel`과 `--git-common-dir`이 둘 다 값을 낼 때입니다. 예외를 던지지 않고, `projectDir` 자체를 풀지 못할 때만 `null`을 돌려줍니다. `projectDir`은 플러그인 setup의 `ctx.location.project.directory`입니다(`src/tools.ts:48-52`).

git 밖에서 잡은 바인딩(실행 결과):

```json
{
  "schema": "gjc.repository_binding.v1",
  "worktreeRoot": "<tmp>",
  "commonDir": null,
  "displayPath": "<tmp>"
}
```

**쓰는 곳**:

- `start`: 상태의 `run_id`와 같은 run이고 상태에 바인딩이 있으면 그것을, 아니면 새로 잡아 상태와 결과에 넣습니다(`store.ts:927-930`).
- `write`: 상태의 바인딩, 없으면 새로 잡은 값을 **영수증에만** 넣습니다(`store.ts:645-648`). 상태에 저장하지 않으므로, `start` 없이 `write`로 만든 run은 `write`마다 git을 다시 부릅니다. 이 git 호출은 트랜잭션 안에서 돌아 그동안 세션 큐를 잡고 있습니다.
- run을 바꾸는 `write`(새 `run_id`)는 바인딩을 바꾸지 않습니다. 이전 run의 바인딩이 새 run의 영수증에도 나옵니다(3장 "새 run에서 지우는 것").
- 어떤 코드도 바인딩과 현재 위치를 비교하지 않습니다. 다른 worktree에서 온 쓰기도 거부하지 않습니다.

## 11. 설정 `ralplan.*`

`src/config.ts`(gjc `gjc.ralplan.*`, `gjc-runtime/ralplan-runtime.ts:93-112,388-524`; ralplan 편차 4, 6, 계획 DR-13).

| 키 | 기본값 | 허용 값 |
|---|---|---|
| `ralplan.maxIterations` | `5` | 정수 1–20 |
| `ralplan.maxReviewPassesPerLane` | `1` | 정수 1–10 |
| `ralplan.autoHandoff` | `"off"` | `"off"`, `"ultragoal"`(gjc의 `autoresearch` 없음, ralplan 편차 6) |

- **파일과 우선순위**(`loadSettings`, `src/config.ts:159-210`): 프로젝트 `<projectDir>/.open-gajae/open-gajae.jsonc` → 사용자 `~/.open-gajae/open-gajae.jsonc` → 기본값. 키마다 따로 정합니다. 파일이 없으면(ENOENT) 빈 층입니다.
- **`source`**(`ralplanSource`, `:166-171`): 키마다 이긴 파일의 경로, 없으면 `"default"`. 경로는 `join(projectDir, …)`·`join(homedir(), …)`로 만든 그대로이고 realpath로 풀지 않습니다(gjc는 정규 경로를 보고함, ralplan 편차 4). deep-interview의 `source`(`~/…`, `./…`)와 형식이 다릅니다.
- **실패**(`load`, `:69-158`): JSONC 문법 오류 `<path>:<offset>: <코드>`, 객체가 아님 `<path>.ralplan: expected an object`, 모르는 최상위 키(`deepInterview`, `agents`, `ralplan` 밖) `<path>.<key>: unknown setting`, 모르는 ralplan 키, 범위·값 위반. 어느 층이든 하나라도 틀리면 `loadSettings`가 예외를 던져 플러그인 setup이 끝나지 않습니다(`src/index.ts:29`). 호스트가 그 실패를 사용자에게 어떻게 보이는지는 이 문서를 쓰며 확인하지 않았습니다.
- **해석 시점**: 플러그인 setup에서 한 번(`src/index.ts:29,62`). 바꾸면 호스트를 다시 시작해야 적용됩니다(gjc는 쓰기마다 해석, ralplan 편차 4). 호스트 없이 도구를 만들면 `DEFAULT_RALPLAN_SETTINGS`(`src/ralplan-runtime/tool.ts:81-90`, 모두 `source: "default"`)를 씁니다(`src/tools.ts:50`).
- **쓰는 곳**: 모두 `write` 안입니다(`writeStageTx`). `maxIterations`와 `maxReviewPassesPerLane`은 예산과 PLANNING-STUCK 결과의 `max_*`·`source=`/`max_*_source`, `maxReviewPassesPerLane`은 `arch`·`crit` 칩의 분모, `autoHandoff`와 `source.autoHandoff`는 final 승인 `auto_handoff`입니다([stages-and-ledger.md](stages-and-ledger.md)).
- **모델이 보는 곳**: 주 에이전트 시스템 프롬프트의 `<open-gajae-runtime-settings>` 블록에는 `deepInterview`만 들어가고 ralplan 설정은 없습니다(`src/config.ts:354-370`). 모델은 ralplan 설정을 결과(PLANNING-STUCK, final 영수증의 `auto_handoff`)로만 봅니다.

실행 예: 사용자 파일 `{"ralplan": {"maxIterations": 7, "autoHandoff": "ultragoal"}}`, 프로젝트 파일 `{"ralplan": {"maxIterations": 3,}}`(JSONC 끝 쉼표 허용)이면:

```json
{
  "maxIterations": 3,
  "maxReviewPassesPerLane": 1,
  "autoHandoff": "ultragoal",
  "source": {
    "maxIterations": "<tmp>/wt/.open-gajae/open-gajae.jsonc",
    "maxReviewPassesPerLane": "default",
    "autoHandoff": "<tmp>/home/.open-gajae/open-gajae.jsonc"
  }
}
```

틀린 값의 오류(실행 결과):

```text
<tmp>/wt/.open-gajae/open-gajae.jsonc.ralplan.maxIterations: expected an integer between 1 and 20
<tmp>/wt/.open-gajae/open-gajae.jsonc.ralplan.maxIteration: unknown setting
<tmp>/wt/.open-gajae/open-gajae.jsonc.ralplan.autoHandoff: expected one of off, ultragoal
```

## 12. `state/ralplan-continuation.json`

OMC continuation의 차단기 카운터를 담는 훅 전용 파일입니다(계획 R-O3, ralplan 편차 26). gjc 상태 봉투에 수명 필드를 넣지 않으려고 따로 둡니다. 판단 규칙은 [guards-and-continuation.md](guards-and-continuation.md)에 있습니다.

```json
{
  "run_id": "ses_c",
  "breaker_count": 1,
  "breaker_updated_at": "2026-10-03T15:02:51.562Z"
}
```

- **쓰는 곳**: `decideRalplan`의 `writeBreaker`(`src/hooks.ts:494-506`)만. `tx.writeText`로 통째로 씁니다. `_meta`가 없고 감사하지 않습니다.
- **값**: continuation을 넣을 때 그 횟수, 차단기 소진 때 `0`(상태를 `active: false`로 쓴 뒤), T나 `planning_stuck`으로 건너뛸 때 카운터가 0이 아니면 `0`. `run_id`는 상태의 `run_id`(문자열이 아니면 키가 빠짐).
- **읽는 곳**: `readBreaker`(`src/hooks.ts:449-463`)만. 파일이 없거나, 읽거나 파싱하지 못하거나, `run_id`가 상태의 것과 다르면 없는 것으로 봅니다. 있더라도 `breaker_updated_at`이 45분(`RALPLAN_STOP_BLOCKER_TTL_MS`, `src/ralplan.ts:26`)보다 오래되면 이전 수를 버립니다(`shouldContinue`). 어느 경우든 다음 continuation은 1입니다. 30(`RALPLAN_STOP_BLOCKER_MAX`, `:25`)을 넘는 31번째가 차단기 소진입니다.
- **지우지 않음**: `clear`, `start`, 인계 모두 이 파일을 건드리지 않습니다. continuation은 ralplan이 보이는 주 skill일 때만 카운터를 읽고 쓰므로, `state {"active": false}`나 `clear`로 행이 사라진 뒤에는 카운터가 그대로 남습니다. 그 뒤 `start`가 같은 `run_id`(기본값은 상태에 남은 `run_id`)로 시작하면 45분 안에서는 이전 수에 이어 셉니다. 실행: continuation 2회 → 계획 phase(`planner`)에서 `state {"active": false}` → `clear` → `start` → continuation 1회 뒤 카운터는 `3`이고 설명은 `open-gajae: ralplan continuation 3/30`이었습니다.
- **`final`의 Stop here**: 활성 `final`인 동안 루트 `succeeded`가 한 번이라도 오면 `final`이 T라서 카운터가 `0`이 됩니다. 실행: continuation 2회 → `final` 기록 → `succeeded` → 카운터 `0` → Stop here → `clear` → `start` → continuation 1회 뒤 `1/30`. `final`을 쓴 뒤 `succeeded` 없이 바로 Stop here하면(같은 execution에서 승인 질문을 하고 답을 받은 경우) 카운터는 남고, 위처럼 `3/30`으로 이어 셉니다(실행으로 확인).

## 코드가 강제하는 것과 SKILL만 요구하는 것

**코드가 강제하는 것**

- ralplan 파일은 `ralplan` 도구, 몇몇 훅, 공통 인계만 씁니다. 편집 도구로는 `plans/ralplan/**`와 `state/**`를 쓸 수 없습니다.
- 모든 쓰기는 루트 세션 폴더에, 세션 큐 하나 안에서 합니다. 파일 쓰기는 원자적이고, 상태는 크기·깊이·키 수 한도와 소유 세션 검사를 거칩니다.
- 상태의 `skill`, `version`, `updated_at`, `_meta`, `active`와 `current_phase`의 규칙(phase lock, `state` op의 전이 표 검사, 알려진 phase 집합).
- 역할 id는 그 역할이 자기 lane의 단계를 쓸 때 호출 세션 id로만 기록됩니다.
- 활성 행과 스냅숏은 op마다 다시 쓰고, 파이프라인 순위로 위쪽 행을 지우고, 보이는 읽기에서 잠긴 phase로 치환합니다.
- 감사 행은 파일 변경마다 남습니다.

**SKILL과 프롬프트만 요구하는 것**

- 상태를 `ralplan start`로 시작하는 것(코드는 `write`만으로도 상태를 만듦).
- 잠긴 phase 뒤의 doctor `stale_active_state`만 보고 `clear`하지 않는 것(SKILL "During post-final refinement …" 단락, [known-limits.md](known-limits.md) RK8).
- 역할 id를 `status`로 읽어 같은 역할 세션을 이어 부르는 것, `resumable`·`fallback_*`를 맞게 넣는 것([roles-and-consensus.md](roles-and-consensus.md)).
- Stop here 뒤 더 바꾸지 않는 것(SKILL step 8 "make no further changes"). 코드는 그 뒤의 `write`도 받아 단계 파일을 쓰고 활성 행을 다시 만듭니다(5장). SKILL은 그런 `write` 뒤 상태가 비활성으로 남는다고만 적고, 행이 다시 활성이 되는 것은 적지 않습니다.
- ultragoal 실행 중 생긴 ralplan 상태를 `state(patch={"active": false})`나 `clear`로 정리하는 것(SKILL "`ralplan write` does not check for a running ultragoal" 단락).

저장소 바인딩은 SKILL도 강제를 요구하지 않습니다. 기록만 합니다(SKILL Source 표의 `--worktree-root` 행).
