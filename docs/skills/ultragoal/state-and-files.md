# ultragoal 저장 파일과 상태

이 문서는 ultragoal이 디스크에 남기는 파일과 그 파일을 바꾸는 규칙을 코드 그대로 적습니다. 다루는 것은 세션 폴더 구성, 세션마다 하나인 쓰기 큐, 파일별 스키마, 활성 행·스냅숏·순위, 단계(phase) 전이와 reconcile, HUD 칩, doctor입니다. 어떤 op가 무엇을 쓰는지는 [ops.md](ops.md), 인계 중 저널의 생애는 [entry-and-handoff.md](entry-and-handoff.md), 검증 제출서(gate)와 영수증의 의미는 [gates-and-receipts.md](gates-and-receipts.md), goal 도구와 continuation 루프의 의미는 [goal-loop.md](goal-loop.md), 파일 쓰기 가드와 도구 숨김은 [guards.md](guards.md)에 있습니다. 전체 흐름과 코드 지도는 [README.md](README.md), 알려진 한계는 [known-limits.md](known-limits.md)를 보세요.

용어:

- **세션 폴더**: 한 세션의 workflow 파일이 모두 모이는 `.open-gajae/_session-…/` 폴더.
- **lineage root**: 하위 에이전트(subagent) 세션이 `parentID`를 따라 올라가 닿는 맨 위 세션. ultragoal 파일은 모두 root의 세션 폴더에 있습니다.
- **mode-state**: 스킬마다 하나인 상태 파일 `state/<skill>-state.json`. ultragoal의 것은 `state/ultragoal-state.json`입니다.
- **활성 행(active row)**: 스킬마다 하나인 `state/active/<skill>.json`. "지금 이 스킬이 켜져 있다"는 표시와 HUD 칩을 담습니다.
- **스냅숏(snapshot)**: 모든 활성 행을 모아 주 스킬 하나를 고른 `state/skill-active-state.json`.
- **reconcile**: `goals.json`과 원장에서 실행 상태를 다시 계산해, 파생 필드를 기존 mode-state 위에 병합하고(`mergeWithNullDelete`, 파일은 매번 통째로 다시 씀. 기존 파일이 깨졌을 때만 `{}`에서 시작) 활성 행과 스냅숏을 다시 맞추는 절차(`src/ultragoal-runtime/store.ts`의 `reconcileUltragoalTx`, 5장).

## 1. 세션 폴더

### 폴더 이름

`src/state.ts`의 `StateStore`가 폴더를 정합니다.

- 루트는 `<worktree>/.open-gajae/`입니다. `<worktree>`는 플러그인 `setup`이 넘기는 `ctx.location.project.directory`를 `realpathSync`로 푼 경로입니다(`src/index.ts`).
- 이름은 `sessionDirName`이 만듭니다: `_session-<YYYYMMDD-HHMMSS>-<세션 ID>`. 날짜·시각은 호스트 세션의 `time.created`를 **로컬 시간**으로 적은 값입니다(`formatCreatedLabel`). `opencode session list`가 보여 주는 생성 시각과 맞추려는 것입니다. `time.created`는 숫자, `Date`, `epochMillis`를 가진 객체 중 무엇이든 받습니다(`epochMillis`).
- 세션 ID는 인코딩하지 않고 검사만 합니다(`validateSessionID`): `[A-Za-z0-9_-]+`, `.`/`..` 금지, 길이는 255바이트에서 고정부 25바이트(`_session-` 9 + 시각 15 + `-` 1, `SESSION_DIR_FIXED_BYTES`)를 뺀 230자까지.
- 기존 폴더는 이름 끝의 `-<세션 ID>`로 찾습니다(`resolveSessionDir`). 그래서 다른 시간대에서 만든 폴더도 찾습니다. 같은 ID로 끝나는 폴더가 둘이면 `ambiguous session directories`로 실패합니다. 폴더가 없을 때만 호스트에 `session.get`을 물어 생성 시각을 얻습니다. 찾은 경로는 `StateStore` 인스턴스 안에 캐시합니다.
- 폴더는 첫 쓰기에서만 만들어집니다. 읽기와 `resolveSessionDir`는 디렉터리를 만들지 않습니다. 쓰기 경로의 `inspectParent(create = true)`가 빠진 디렉터리를 `0o700`으로 만들고, 경로 중간에 심볼릭 링크나 디렉터리가 아닌 것이 있으면 거부합니다.

예: 한국 시간(UTC+9) 2026-10-01 09:15:00에 만든 세션 `ses_example01`의 폴더는 `.open-gajae/_session-20261001-091500-ses_example01/`입니다. 세션 생성 시각은 폴더 이름에만 있고, 그것을 적는 파일은 없습니다. 파일 안의 타임스탬프(`created_at`, `updated_at`, `timestamp`, `ts` 등)는 쓴 시점의 `new Date().toISOString()`, 즉 UTC ISO 문자열입니다(예: 한국 시간 09:20에 쓴 값은 `2026-10-01T00:20:00.000Z`).

### lineage root로 모이기

`ultragoal`·`goal`·`ralplan` 도구와 훅은 호출한 세션이 아니라 그 lineage root의 폴더를 씁니다.

- `src/hooks.ts`의 `rootSession`이 `session.get`으로 `parentID`를 따라 올라가 root를 찾고, 지나온 세션마다 결과를 캐시합니다. 조회 실패, 읽을 수 없는 응답, 순환은 모두 예외입니다(fail closed).
- `ultragoal` 도구는 `ownerSession`에서 호출 에이전트가 `open-gajae`인지 확인한 뒤 `rootSession(context.sessionID)`를 owner로 씁니다(`src/ultragoal-runtime/tool.ts`). `goal` 도구도 같습니다(`src/goal/tool.ts`). owner를 정한 **뒤에** `store.workflowTransaction(owner, …)`에 들어갑니다.
- 그래서 role 하위 에이전트가 무엇을 하든 ultragoal 파일은 root 폴더 하나에만 생깁니다(D-SF6).
- 예외: `state_read`/`state_write`/`state_clear` 도구는 `deep-interview` 모드만 받고 호출 세션 ID를 그대로 씁니다(`src/tools.ts`). ultragoal mode-state는 이 도구로 읽거나 쓸 수 없습니다(`ULTRAGOAL_MODE` 주석, plan §7 decision 21).

### ultragoal 관련 트리

```text
<worktree>/.open-gajae/
  _session-<YYYYMMDD-HHMMSS>-<root 세션 ID>/
    ultragoal/
      goals.json                 목표 목록(원본)
      ledger.jsonl               원장(증거 스트림, 한 줄에 이벤트 하나)
      progress.txt               진행 메모(OMC ralph 형식)
    state/
      ultragoal-state.json       ultragoal mode-state
      goal-state.json            goal 모드의 goal
      goal-continuation.json     continuation 카운터와 보류(훅 전용)
      active/
        ultragoal.json           ultragoal 활성 행
        ralplan.json             ralplan 활성 행(있을 때)
      skill-active-state.json    스냅숏
      audit.jsonl                감사 로그
      transactions/
        <인코딩된 mutation id>.json   인계 저널(인계가 도는 동안만)
      ralplan-state.json, ralplan-continuation.json   (ralplan 소관)
    plans/ specs/ drafts/        (ralplan·deep-interview 소관)
```

`deep-interview.json` 활성 행은 현재 코드가 쓰지 않습니다(4장 참고).

### 파일별 쓰는 곳과 읽는 곳

| 파일 | 쓰는 곳 | 읽는 곳 | 용도 |
|---|---|---|---|
| `ultragoal/goals.json` | `ultragoal` 도구의 `create`, `next`, `checkpoint`, `add`/`revise`/`supersede`, `record_review_blockers` (`writePlanTx`) | ultragoal op `status`, `next`, `checkpoint`, `validate_gate`, `add`/`revise`/`supersede`, `record_review_blockers`, `record_critic_verdict`(`readPlanTx`/`requirePlanTx`); reconcile(그래서 `create`, `classify_blocker`는 reconcile을 통해서만 읽음); `goal` 도구 가드(`readUltragoalGuardInput`); 압축 복구(`src/goal/hooks.ts`의 `ultragoalCompaction`). `add_pattern`, `handoff`, `doctor`, `state`, `clear`는 읽지 않음([ops.md](ops.md)) | 목표와 상태의 원본 |
| `ultragoal/ledger.jsonl` | `ultragoal` 도구(`appendLedgerTx`): `create`, `next`, `checkpoint`, `add`/`revise`/`supersede`, `record_review_blockers`, `classify_blocker`, `record_critic_verdict`, `handoff`; reconcile 실패 행 | ultragoal op(엄격 파서 `parseLedger`), reconcile(느슨한 `latestLedgerEvent`), `goal` 도구 가드, goal 훅의 critic 연속 횟수, 압축 복구 | 체크포인트·영수증·blocker·계획 변경·리뷰의 증거 |
| `ultragoal/progress.txt` | `create`(`PLAN` 메모), `checkpoint(complete)`(항목), `handoff`(`HANDOFF` 메모), `add_pattern` | 같은 op(읽고 덧붙임), 압축 복구(Codebase Patterns, 최근 learnings) | 진행 메모 |
| `state/ultragoal-state.json` | reconcile, 스킬 로드 seed(`seedUltragoalTx`), `state` op, `clear`, 인계(`handoffWorkflowTx`, 호출자·피호출자 모두) | 같은 쓰기 경로(기존 필드 유지), planning 가드(`src/hooks.ts`의 `guardPlanning`), doctor | ultragoal mode-state |
| `state/goal-state.json` | `goal` 도구(`writeGoalStateTx(…, "goal")`), `ultragoal create`의 goal 켜기(`"ultragoal"`) | `goal` 도구, ultragoal `status`/`create`/`clear`/`record_critic_verdict`, goal 훅 | goal 모드의 goal |
| `state/goal-continuation.json` | goal 훅 `decideContinuation`, `releaseHold` | 같은 훅, `record_critic_verdict`(critic 재시작 표시) | continuation 카운터·보류 |
| `state/active/<skill>.json` | `src/skill-state/rows.ts`의 `syncActiveRowTx`, `writeHandoffRowsTx` | `rebuildSnapshotTx`, `readVisiblePrimaryTx`, doctor, `clear`의 stale 검사, 압축 복구(ultragoal 행), 인계(호출자 이전 행의 `handoff_from`) | 활성 행 |
| `state/skill-active-state.json` | `rebuildSnapshotTx` | `readVisiblePrimaryTx`, doctor, `clear`의 stale 검사(행이 없을 때) | 스냅숏 |
| `state/audit.jsonl` | `src/skill-state/audit.ts`의 `appendAudit` | 코드 안에 읽는 곳 없음 | 파일 변경마다 한 행 |
| `state/transactions/<id>.json` | `src/skill-state/journal.ts`(인계 중) | 저널 함수 자신(덮어쓰기 방지, 병합)만. doctor는 읽지 않음 | 인계 저널(증거 전용) |

## 2. 쓰기 큐: `workflowTransaction`

출처: `src/state.ts` 헤더와 `workflowTransaction` 주석의 plan C-1(E-1).

### 큐 하나

- `enqueue(target, operation)`은 모듈 전역 `targetQueues`(Map)에 키마다 Promise 꼬리를 이어 붙입니다. 앞 작업이 실패해도 다음 작업은 돕니다(`previous.catch(() => undefined)`).
- 키는 `queueKey(sessionID)` = `<.open-gajae 경로>\0<세션 ID>\0workflow`입니다. 모드 이름이 키에 없습니다. 그래서 한 세션의 `read`/`write`/`patch`/`clear`(모든 모드)와 모든 `workflowTransaction`이 **하나의 큐**에 줄을 섭니다. 루트 경로가 키에 있으므로 같은 worktree의 `StateStore` 인스턴스 둘도 같은 큐를 씁니다. 다른 세션은 다른 큐입니다(`tests/state.test.ts` "C-1: one workflow queue per session…").
- 큐는 한 프로세스 안의 것입니다. 프로세스 사이 잠금은 없습니다(루트 README의 ralplan 편차 17: "several processes are a known limit").
- `ralplanTransaction`은 `workflowTransaction`의 다른 이름입니다(plan C-1.2).

**왜 하나인가.** ultragoal의 한 op는 여러 스킬의 파일을 함께 바꿉니다. 활성 행을 쓰면 상위 스킬(ralplan, deep-interview)의 행을 지우고, 스냅숏은 모든 스킬의 행을 모아 다시 만듭니다. 인계는 두 스킬의 mode-state와 행, 스냅숏, 저널을 한 번에 바꿉니다. 큐가 하나면 이런 쓰기가 다른 스킬의 쓰기와 섞이지 않고, 세션의 workflow 파일은 큐 밖에서 바뀌지 않습니다(`queueKey` 주석). 스냅숏을 같은 큐 안에서 행 파일로 다시 만들기 때문에, gjc처럼 스냅숏에 있는 모든 행을 다시 쓸 필요도 없습니다(`src/skill-state/rows.ts` 헤더의 편차).

**주의(C-1.3).** 트랜잭션 몸체 `fn`은 `tx`만 써야 합니다. 몸체 안에서 큐를 타는 `StateStore` 메서드(`read`, `write`, `workflowTransaction` …)를 부르면 자기 큐를 기다리며 멈춥니다. 호스트 호출도 몸체 밖에서 합니다. 다만 폴더가 아직 없을 때 `resolveSessionDir`가 호스트에 생성 시각을 묻는 일은 큐 안에서 일어납니다.

### 트랜잭션은 롤백하지 않습니다

`workflowTransaction`은 **직렬화**만 합니다. 몸체가 중간에 예외를 던지면 그때까지 쓴 파일은 그대로 남습니다. 그래서 ultragoal op는 입력 검사와 읽기, 새 계획과 원장 행 계산을 모두 먼저 하고 그 다음에 씁니다(`store.ts` 헤더의 C-7a). 쓰기 순서는 `goals.json` → 원장 → `progress.txt` → `goal-state.json` → reconcile(mode-state → 행 → 스냅숏)입니다. reconcile 자체의 실패는 op 결과를 바꾸지 않고 원장에 `reconcile_failed` 행만 남깁니다(5장).

### `WorkflowTx` API

몸체가 받는 `tx`(`src/state.ts`의 `WorkflowTx` = `RalplanTx` + 추가 경로·메서드). 어느 것도 큐를 타지 않습니다.

| 이름 | 내용 |
|---|---|
| `paths.sessionDir` | 세션 폴더 |
| `paths.statePath` | `state/ralplan-state.json` |
| `paths.continuationPath` | `state/ralplan-continuation.json` |
| `paths.auditPath` | `state/audit.jsonl` |
| `paths.activeRowPath` | `state/active/ralplan.json` (행 디렉터리를 얻는 데도 씀) |
| `paths.snapshotPath` | `state/skill-active-state.json` |
| `paths.runDir(runId)` | `plans/ralplan/<runId>` |
| `paths.activeRow(skill)` | `state/active/<skill>.json` |
| `paths.transactionsDir` | `state/transactions` |
| `paths.modeState(mode)` | `state/<mode>-state.json` |
| `paths.ultragoal` | `{dir, goals, progress, ledger}` = `ultragoal/`, `goals.json`, `progress.txt`, `ledger.jsonl` |
| `paths.goalState` | `state/goal-state.json` |
| `paths.goalContinuation` | `state/goal-continuation.json` |
| `readState()` / `writeState(state, updatedBy)` | ralplan mode-state 읽기·쓰기 |
| `readModeState(mode)` | mode-state 읽기. 없으면 `undefined` |
| `writeModeState(mode, state, updatedBy)` | mode-state 전체 교체(병합 아님). `_meta` 새로 만듦 |
| `readText(file)` | 텍스트 읽기. 없으면 `undefined` |
| `writeText(file, text)` | 원자적 교체 쓰기 |
| `appendLine(file, line)` | 한 줄 덧붙이기. `line`에 줄바꿈이 있으면 거부(JSONL) |
| `list(dir)` | 정렬된 항목 이름. 디렉터리가 없으면 `[]` |
| `remove(file)` | 삭제. `"deleted"` 또는 `"missing"` |

경로 규칙:

- 파일 인자는 모두 세션 폴더 안이어야 합니다(`inside`: 벗어나면 `workflow path escapes the session directory`).
- `runId`와 `skill`은 경로 요소 하나여야 합니다(`safeComponent`: `^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$`, `..` 금지; gjc `assertSafePathComponent`).
- 대상이나 중간 경로가 심볼릭 링크·특수 파일이면 읽기·쓰기·삭제 모두 거부합니다.

### 원자적 쓰기와 덧붙이기

- `writeText`와 mode-state 쓰기는 `atomicWriteText`를 씁니다: 같은 디렉터리에 `.<파일명>.<uuid>.tmp`를 `wx`(새 파일만)·`0o600`으로 쓴 뒤 `rename`으로 바꿔 끼웁니다. 실패하면 임시 파일을 지웁니다. 읽는 쪽은 옛 내용이나 새 내용 중 하나만 봅니다.
- `appendLine`은 `appendText`를 씁니다: `O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW`, `0o600`으로 열어 한 번에 덧붙입니다. 원장과 감사 로그가 이 경로입니다.
- mode-state JSON은 2칸 들여쓰기에 끝 줄바꿈입니다. 행·스냅숏·저널·`goals.json`·goal 파일도 각 모듈이 2칸 들여쓰기로 직렬화해 `writeText`로 씁니다.

### mode-state 읽기 검사와 `_meta`

- `readModeState`는 `readFile` → `validateStoredState`를 거칩니다. JSON 문법 오류는 `state file is corrupted; it was preserved`, 크기 제한 위반은 `state file is invalid; it was preserved: …`로 던집니다. 파일의 `_meta.sessionId`(없으면 `session_id`)가 owner와 다르면 `state scope does not match this session; it was preserved`를 던집니다.
- 크기 제한(`payloadError`, `_meta` 제외): JSON 객체, 최상위 키 100개 이하, 중첩 깊이 10 이하, UTF-8 1 MiB(1,048,576바이트) 이하.
- `writeModeState`는 `_meta = {mode, sessionId, updatedAt, updatedBy}`를 매번 새로 붙입니다(`writeMerged`).

`updatedBy`는 `StateWriter` 값입니다. 코드에 있는 값은 다섯 개뿐입니다.

| 값 | ultragoal mode-state에 쓰이는 경우 |
|---|---|
| `ultragoal_tool` | reconcile(현재 코드의 모든 호출이 기본 owner `open-gajae-runtime`), `state` op, `clear`, ultragoal이 호출자인 `handoff` op |
| `ultragoal_hook` | `skill ultragoal` 로드 seed(`seedUltragoalTx`, owner `open-gajae-hook`) |
| `ralplan_tool` | `ralplan handoff(to="ultragoal")` op: 인계는 두 상태를 모두 호출자의 writer로 씁니다(`handoff.ts`의 `WRITERS`) |
| `ralplan_hook` | 같은 execution에서 `skill ultragoal`을 로드해 훅이 ralplan을 인계할 때 |
| `state_write_tool` | 쓰이지 않음(`state_write` 도구, deep-interview 전용) |

`goal_tool`이나 `goal_hook` 같은 값은 없습니다. `goal-state.json`과 `goal-continuation.json`은 mode-state가 아니라 `writeText`로 쓰는 파일이라 `_meta`가 없습니다.

## 3. 파일 스키마

### `ultragoal/goals.json`

출처: `src/ultragoal-runtime/plan.ts`(gjc `ultragoal-runtime.ts`의 7개 상태 등; 편차 2·3·4·5·27·29·34·38·40·42). 파서 `parseGoals`는 JSON이 아니거나 검사기 `goalsFileError`가 오류를 내면 `invalid`를 돌려주고, op는 `goals.json is invalid: …`로 멈춥니다. 검사기가 거부하는 것은 아래 표의 필수 필드 누락, 타입·형식·길이 위반, 중복 ID·기준, 규칙 위반(물러난 기준 ID 재사용, 알 수 없는 `blockedGoalId` 등)입니다. **모르는 키는 거부하지 않습니다**: 최상위, 목표, `amendments` 항목에 스키마에 없는 키가 있어도 `valid`입니다. 모르는 키를 거부하는 것은 영수증 `completionVerification` 하나뿐입니다. 쓰기는 `serializeGoals`가 다시 검사한 뒤에만 합니다(`refusing to write an invalid goals.json`).

**최상위 필드**

| 필드 | 타입·제한 | 뜻 |
|---|---|---|
| `version` | 숫자 `2` | `1`이면 "retired OMC ralph format" 오류. 이전(migration) 코드는 없습니다. |
| `description` | 공백 아닌 문자열, 2000자 이하 | 실행 전체의 설명과 제약. 목표가 되지 않습니다. |
| `created_at` | 공백 아닌 문자열, 100자 이하 | `create` 시각 |
| `updated_at` | 같음 | 마지막 계획 쓰기 시각 |
| `goals` | 비어 있지 않은 배열 | 목표. `id`는 겹치면 안 됩니다. 순서가 실행 순서입니다. |

**목표 필드**

| 필드 | 타입·제한 | 뜻 |
|---|---|---|
| `id` | `G\d{3}`. 스키마는 `G000`도 받지만 도구는 `G001`부터 매깁니다 | 목표 ID |
| `title` | 공백 아닌 문자열, 200자 이하 | 제목 |
| `description` | 공백 아닌 문자열, 2000자 이하 | 목표의 objective |
| `status` | 7개 상태 중 하나 | 아래 표 |
| `acceptanceCriteria` | 비어 있지 않은 `[{id, text}]` | 기준. `id`는 `<목표 ID>.AC<n>`(n은 1 이상, 앞자리 0 없음). `text`는 2000자 이하. 같은 `id`나 같은 `text`가 두 번 나오면 안 됩니다. |
| `amendments` | 배열(빈 배열 가능) | 받아들인 계획 변경의 원문 기록 |
| `steering` | 선택. `{kind: "review_blocker", blockedGoalId}` | 수정 목표 표시. `blockedGoalId`는 자기 자신이 아닌, 파일에 있는 목표여야 합니다. |
| `evidence` | 선택. 문자열 | 마지막 체크포인트나 대체의 증거(스키마는 타입만 검사. 길이 4000자는 op 입력에서 검사) |
| `started_at` | 선택. 100자 이하 | `next`나 자동 전진으로 처음 active가 된 시각. 다시 active가 되어도 바꾸지 않습니다. |
| `completed_at` | 선택. 100자 이하 | `checkpoint(complete)` 시각 |
| `completionVerification` | 선택. 영수증 객체 | 아래 참고 |

**목표 상태 7개**(`GOAL_STATUSES`, gjc count 순서)

| 상태 | 들어가는 op | 필수 목표인가 |
|---|---|---|
| `pending` | `create`, `add`, `record_review_blockers`(새 수정 목표), `checkpoint(pending)`(다시 열기) | 예 |
| `active` | `next`, `checkpoint(complete)`의 자동 전진 | 예 |
| `complete` | `checkpoint(complete)` | 예 |
| `failed` | `checkpoint(failed)` | 예 |
| `blocked` | `checkpoint(blocked)` | 예 |
| `review_blocked` | `record_review_blockers`(부모 목표) | 예 |
| `superseded` | `supersede`(목표), 수정 목표 완료 시 부모 자동 대체 | 아니오(`requiredGoals`가 뺍니다) |

**기준 ID.** `create`와 `add`(목표)는 `<id>.AC1..n`을 붙입니다(`newGoal`). 기준을 더하거나 고치면 `nextCriterionId`가 지금 기준과 `amendments`의 `criterionId`/`replacementId`에 쓰인 적 있는 가장 큰 번호 + 1을 줍니다. 고친 기준은 새 번호를 받고, 물러난 번호는 다시 쓰지 않습니다(PQ-22 A). 스키마도 이를 검사합니다: `revised`/`superseded`로 물러난 ID가 아직 active 기준에 있거나 두 번 물러나면 오류입니다. 목표 ID는 `nextGoalId`가 가장 큰 번호 + 1로 정합니다(목표는 지우지 않으므로 gjc의 `goals.length + 1`과 같음). `G999`를 넘으면 거부합니다.

**`amendments` 항목**(`Amendment`, D-AG6). 변경이 닿은 목표에 붙습니다.

| 필드 | 뜻 |
|---|---|
| `target` | `"goal"` 또는 `"criterion"` |
| `kind` | `"added"`, `"revised"`, `"superseded"` |
| `criterionId` | 기준일 때 필수. 추가면 새 ID, 수정·대체면 물러난 ID |
| `replacementId` | 기준 수정일 때 필수. 새 ID |
| `original` / `replacement` | 기준 원문·새 문장, 또는 목표의 `{"title","description"}` JSON 문자열 |
| `after` | `G\d{3}`. `add`/`revise`에서 `after`를 준 경우 |
| `rationale` | 2000자 이하, 공백 아님 |
| `evidence` | 4000자 이하, 공백 아님 |
| `timestamp` | 100자 이하, 공백 아님 |

op별로 만드는 항목 모양은 `store.ts`의 `steerTx`에 있습니다. 목표 추가는 새 목표 자신에게 `{target:"goal", kind:"added", replacement, after?}`, 목표 수정은 `{kind:"revised", original, replacement, after?}`, 목표 대체는 `{kind:"superseded", original}`, 기준 추가는 `{kind:"added", criterionId, replacement}`, 기준 수정은 `{kind:"revised", criterionId, replacementId, original, replacement}`, 기준 대체는 `{kind:"superseded", criterionId, original}`입니다. `rationale`, `evidence`, `timestamp`는 모두 붙습니다.

**`completionVerification`**(영수증)은 정확히 6개 키만 가진 객체입니다: `receiptId`, `receiptKind`(`"per-goal"` 또는 `"final-aggregate"`), `criteriaRevision`, `qualityGateHash`, `checkpointLedgerEventId`, `verifiedAt`. 모두 빈 문자열이 아닌 문자열이어야 하고(공백만 있는 값은 막지 않음) 다른 키가 있으면 오류입니다(`src/ultragoal-runtime/receipt.ts`의 `completionVerificationError`). 만드는 법과 유효성은 [gates-and-receipts.md](gates-and-receipts.md)에 있습니다. `checkpoint(pending|failed|blocked)`와 `record_review_blockers`는 이 필드를 지우지 않습니다.

**op 입력 제한**(`LIMITS`, `store.ts`의 `checkText`/`checkList`/`checkSubstantive`). 스키마 제한과 같은 값이지만 입력 단계에서 먼저 검사합니다.

| 항목 | 제한 |
|---|---|
| `title` | 200자 |
| 설명·기준·목록 항목(`text`) | 2000자 |
| `evidence` | 4000자 |
| `pattern` | 500자, 한 줄 |
| `record_review_blockers`의 `objective` | 1972자(2000 − 접미사 `" is resolved and re-verified"` 28자, E-24) |
| 목표 수 | 999개 |
| 계획 변경의 `rationale`·`evidence` | 5단어 이상, 32자 이상(`isSubstantive`) |

예(1개 목표로 만든 계획에 `record_review_blockers`까지 한 뒤, 8장의 (d)):

```json
{
  "version": 2,
  "description": "Add CSV export to the report page. Keep the existing API unchanged.",
  "created_at": "2026-10-01T00:20:00.000Z",
  "updated_at": "2026-10-01T00:40:00.000Z",
  "goals": [
    {
      "id": "G001",
      "title": "CSV export",
      "description": "Users can download the report table as a CSV file.",
      "status": "review_blocked",
      "acceptanceCriteria": [
        { "id": "G001.AC1", "text": "The export button downloads report.csv" },
        { "id": "G001.AC2", "text": "Commas and quotes in cells are escaped" }
      ],
      "amendments": [],
      "started_at": "2026-10-01T00:21:00.000Z",
      "evidence": "The QA lane found that an empty report crashes the export."
    },
    {
      "id": "G002",
      "title": "Resolve final code-review blockers",
      "description": "An empty report exports a header-only CSV",
      "status": "pending",
      "acceptanceCriteria": [
        { "id": "G002.AC1", "text": "An empty report exports a header-only CSV is resolved and re-verified" }
      ],
      "amendments": [],
      "steering": { "kind": "review_blocker", "blockedGoalId": "G001" }
    }
  ]
}
```

기준 수정 뒤의 `amendments` 예:

```json
{
  "target": "criterion",
  "kind": "revised",
  "criterionId": "G001.AC2",
  "replacementId": "G001.AC3",
  "original": "Commas and quotes in cells are escaped",
  "replacement": "Commas, quotes and newlines in cells are escaped",
  "rationale": "Multi-line notes in the report also break the CSV rows.",
  "evidence": "A report with a multi-line note produced a broken third column.",
  "timestamp": "2026-10-01T00:25:00.000Z"
}
```

### `ultragoal/ledger.jsonl`

출처: `src/ultragoal-runtime/ledger.ts`(gjc `appendLedger`, `readUltragoalLedger` 등; 편차 5·18·39). 한 줄에 JSON 객체 하나이고, 덧붙이기만 합니다.

**봉투.** 모든 행은 `{eventId, ...필드, timestamp}` 순서입니다(`ledgerRow`). `eventId`는 `randomUUID()`, `timestamp`는 ISO 시각입니다. `checkpoint`의 `goal_checkpointed`만 미리 만든 `eventId`를 써서, 그 ID가 영수증의 `checkpointLedgerEventId`가 됩니다.

**이벤트**(`LedgerEventFields`)

| `event` | 필드 | 쓰는 op |
|---|---|---|
| `plan_created` | `goalIds: string[]`, `description` | `create` |
| `goal_started` | `goalId` | `next`, `checkpoint(complete)`가 다음 목표를 active로 올릴 때 |
| `goal_checkpointed` | `goalId`, `status`, `evidence`, `qualityGateJson?`, `completionVerification?` | `checkpoint`(모든 상태), `record_review_blockers`(부모, `status: "review_blocked"`) |
| `steering_accepted` | `kind`(`add`/`revise`/`supersede`), `target`(`goal`/`criterion`), `goalId`, `criterionId?`, `after?`, `rationale`, `evidence`, `amendment` | `add`, `revise`, `supersede` |
| `review_blockers_recorded` | `goalId`(부모), `blockerGoalId`(새 수정 목표) | `record_review_blockers` |
| `blocker_classified` | `classification`(`resolvable`/`human_blocked`), `goalId?`, `evidence` | `classify_blocker` |
| `critic_verdict` | `terminus`(`completion`/`pause`), `verdict`(`OKAY`/`ITERATE`/`REJECT`), `evidence`, `blockers: string[]`, `classificationEventId?`, `goalId?` | `record_critic_verdict` |
| `workflow_handoff` | `to`(`ralplan`/`deep-interview`), `reason` | `handoff`(ultragoal이 호출자일 때, `recordCaller` 단계) |

`goal_checkpointed` 세부:

- `status: "complete"`: `qualityGateJson`은 제출한 gate 그대로, `completionVerification`은 새 영수증입니다.
- `pending`/`failed`/`blocked`: gate를 냈을 때만 `qualityGateJson`이 붙고, 목표에 이미 영수증이 있으면 그 영수증이 `completionVerification`으로 붙습니다.
- `review_blocked`(`record_review_blockers`): gate는 없고, 부모에 영수증이 있으면 붙습니다.
- `steering_accepted.criterionId`는 기준 수정일 때 **물러난** ID입니다. 새 ID는 `amendment.replacementId`에 있습니다.

**reconcile 실패 행.** 이벤트가 아니라 `type`으로 구분하는 gjc 행입니다: `{eventId, type: "reconcile_failed", error, timestamp}`(DR-20).

**쓰지 않는 것**(PQ-16 C): 거부된 op, `add_pattern`, 읽기 op(`status`, `validate_gate`, `doctor`), `state`, `clear`, 목표가 이미 active일 때의 `next`, 같은 상태·증거의 `checkpoint` 재실행(E-15), `record_review_blockers`의 중복(같은 objective·부모) 호출. `pattern` 같은 이벤트는 없습니다. ralplan → ultragoal 인계도 ultragoal 원장에 행을 쓰지 않습니다.

**두 개의 읽기.**

- 엄격 읽기 `parseLedger`(DR-19): 빈 줄을 뺀 모든 줄이 JSON 객체이고, 빈 문자열이 아닌 문자열 `eventId`와 문자열 `timestamp`를 가지고, `eventId`가 겹치지 않고, 알려진 이벤트의 필수 필드 타입이 맞아야 합니다(또는 `event` 없는 `reconcile_failed` 행에 문자열 `error`). 하나라도 어기면 `invalid`이고 op는 `ledger.jsonl is invalid: ledger.jsonl line <n> …`로 멈춥니다. 파일이 없으면 빈 원장입니다. 영수증 판정, 실행 완료, critic 연속 횟수, 가드가 이 읽기를 씁니다.
- 느슨한 읽기 `latestLedgerEvent`: 뒤에서부터 파싱되는 첫 줄 중 `event`(없으면 `type`)가 있는 행을 `{event, goalId?, timestamp?, kind?, evidence?}`로 돌려줍니다. 파싱 안 되는 줄은 건너뜁니다. reconcile이 mode-state의 `latestLedgerEvent`와 HUD `ledger` 칩에 씁니다.

예(8장 실행의 원장, `qualityGateJson` 줄임):

```text
{"eventId":"0b5e…","event":"plan_created","goalIds":["G001"],"description":"Add CSV export to the report page. Keep the existing API unchanged.","timestamp":"2026-10-01T00:20:00.001Z"}
{"eventId":"4c1a…","event":"goal_started","goalId":"G001","timestamp":"2026-10-01T00:21:00.000Z"}
{"eventId":"9d27…","event":"goal_checkpointed","goalId":"G001","status":"review_blocked","evidence":"The QA lane found that an empty report crashes the export.","timestamp":"2026-10-01T00:40:00.000Z"}
{"eventId":"e310…","event":"review_blockers_recorded","goalId":"G001","blockerGoalId":"G002","timestamp":"2026-10-01T00:40:00.000Z"}
{"eventId":"77f0…","event":"goal_started","goalId":"G002","timestamp":"2026-10-01T00:41:00.000Z"}
{"eventId":"a6c4…","event":"goal_checkpointed","goalId":"G002","status":"complete","evidence":"Generation 2 joined clean …","qualityGateJson":{"targetedVerification":{…},"architectReview":{…},"criteriaCoverage":[…],"reviewCohort":{…},"criticReview":{…}},"completionVerification":{"receiptId":"5f0e…","receiptKind":"final-aggregate","criteriaRevision":"cb95…","qualityGateHash":"e3ab…","checkpointLedgerEventId":"a6c4…","verifiedAt":"2026-10-01T01:05:00.000Z"},"timestamp":"2026-10-01T01:05:00.000Z"}
```

다른 이벤트 모양:

```text
{"eventId":"…","event":"steering_accepted","kind":"revise","target":"criterion","goalId":"G001","criterionId":"G001.AC2","rationale":"…","evidence":"…","amendment":{"target":"criterion","kind":"revised","criterionId":"G001.AC2","replacementId":"G001.AC3","original":"…","replacement":"…","rationale":"…","evidence":"…","timestamp":"…"},"timestamp":"…"}
{"eventId":"…","event":"blocker_classified","classification":"human_blocked","goalId":"G002","evidence":"…","timestamp":"…"}
{"eventId":"…","event":"critic_verdict","terminus":"pause","verdict":"OKAY","evidence":"…","blockers":[],"classificationEventId":"…","timestamp":"…"}
{"eventId":"…","event":"workflow_handoff","to":"ralplan","reason":"The export needs a new API; replan.","timestamp":"…"}
{"eventId":"…","type":"reconcile_failed","error":"JSON Parse error: …","timestamp":"…"}
```

### `ultragoal/progress.txt`

출처: `src/ultragoal-runtime/progress.ts`. ultragoal 런타임에서 유일하게 OMC(v5.4.0 `src/hooks/ralph/progress.ts`)에서 온 부분입니다. gjc에는 이 파일이 없습니다(ultragoal 편차 1: gjc는 `brief.md`). 순수 함수이고, 호출자가 읽고 씁니다.

- **머리**(`initialProgress`): 파일이 없을 때만 씁니다. `create`는 기존 파일에 덧붙이고 새로 만들지 않습니다(PQ-15 A).
- **항목**(`appendProgressEntry`): `checkpoint(complete)`마다 하나. 제목의 시각은 ISO 문자열을 잘라 만든 `YYYY-MM-DD HH:MM`(UTC)입니다(`stamp`). 세 목록은 각각 한 항목 이상이어야 하고(op 검사), 항목 안의 줄바꿈은 공백으로 합칩니다(`oneLine`).
- **메모**(`appendProgressNote`): `PLAN`은 `**Description:**` 아래 `create`의 `description`, `HANDOFF`는 `**Reason:**` 아래 `to <대상>: <reason>`.
- **패턴**(`addProgressPattern`): `add_pattern`이 `(No patterns discovered yet)` 줄을 지우고, `## Codebase Patterns` 뒤 첫 `---` 앞에 `- <pattern>`과 빈 줄을 넣습니다. 그래서 첫 패턴 앞에는 빈 줄이 하나 있습니다. 파일이 없으면 `add_pattern`은 거부합니다.
- **읽기**(`parseProgress`): 압축 복구가 Codebase Patterns와 최근 10개 항목의 learnings를 가져갑니다(`src/ultragoal-runtime/recovery.ts`의 `renderUltragoalRecoveryContext`). OMC와 다른 점 하나: 굵은 섹션 제목 줄을 항목으로 읽지 않습니다.

예:

```text
# Ultragoal Progress Log
Started: 2026-10-01T00:20:00.000Z

## Codebase Patterns

- tests live under tests/ and run with npm test

---


## [2026-10-01 00:20] - PLAN

**Description:**
- Add CSV export to the report page. Keep the existing API unchanged.

---

## [2026-10-01 01:05] - G002

**What was implemented:**
- CSV export with header-only output for empty reports

**Files changed:**
- src/report/export.ts
- tests/export.spec.ts

**Learnings for future iterations:**
- Empty tables need their own fixture in the export tests

---
```

인계 메모는 `## [2026-10-01 00:50] - HANDOFF` 아래 `**Reason:**`와 `- to ralplan: …` 한 줄입니다.

### `state/ultragoal-state.json`

ultragoal mode-state입니다. 열린 envelope이라 모르는 필드도 남습니다. 필드가 어디서 오는지로 나눕니다.

| 필드 | 쓰는 곳 | 뜻 |
|---|---|---|
| `skill` | 모든 쓰기 | 항상 `"ultragoal"` |
| `version` | 모든 쓰기 | gjc `WORKFLOW_STATE_VERSION` = `2` |
| `active` | reconcile, seed, 인계, `state`, `clear` | 이 run이 켜져 있는가 |
| `current_phase` | 같음 | 단계(5장) |
| `updated_at` | 같음 | 마지막 쓰기 시각 |
| `session_id` | 없을 때만 채움 | owner(lineage root) 세션 ID |
| `status` | reconcile | 파생 실행 상태. reconcile에서는 `current_phase`와 같은 값 |
| `goals` | reconcile | `[{id, title, status}]` |
| `counts` | reconcile | 7개 상태별 개수(`countGoals`) |
| `active_goal_id` | reconcile | 첫 `pending`/`active`/`failed` 목표(`currentGoal`). 없으면 `null`을 병합해 **키를 지웁니다** |
| `goals_path`, `ledger_path`, `progress_path` | reconcile | 세 파일의 절대 경로 |
| `latestLedgerEvent` | reconcile | 느슨한 읽기의 최신 이벤트. 원장에 이벤트가 없으면 키를 건드리지 않습니다 |
| `handoff_from`, `handoff_to`, `handoff_at` | 인계 | 피호출자·호출자 표시와 시각. 이후 병합에서도 남습니다 |
| 그 밖의 키 | `state` op | 모델이 넣은 필드(예: `note`) |
| `_meta` | `StateStore` | `{mode:"ultragoal", sessionId, updatedAt, updatedBy}` |

reconcile, seed, 인계, `state`, `clear`는 모두 기존 필드 위에 병합합니다. reconcile과 `state`는 gjc `mergeWithNullDelete`(값이 `null`이면 키 삭제)를 씁니다.

예(8장 (d) 뒤):

```json
{
  "skill": "ultragoal",
  "version": 2,
  "active": true,
  "current_phase": "blocked",
  "handoff_from": "ralplan",
  "handoff_at": "2026-10-01T00:18:00.000Z",
  "updated_at": "2026-10-01T00:40:00.003Z",
  "session_id": "ses_example01",
  "status": "blocked",
  "goals": [
    { "id": "G001", "title": "CSV export", "status": "review_blocked" },
    { "id": "G002", "title": "Resolve final code-review blockers", "status": "pending" }
  ],
  "counts": { "pending": 1, "active": 0, "complete": 0, "failed": 0, "blocked": 0, "review_blocked": 1, "superseded": 0 },
  "active_goal_id": "G002",
  "goals_path": "/work/app/.open-gajae/_session-20261001-091500-ses_example01/ultragoal/goals.json",
  "ledger_path": "/work/app/.open-gajae/_session-20261001-091500-ses_example01/ultragoal/ledger.jsonl",
  "progress_path": "/work/app/.open-gajae/_session-20261001-091500-ses_example01/ultragoal/progress.txt",
  "latestLedgerEvent": { "event": "review_blockers_recorded", "goalId": "G001", "timestamp": "2026-10-01T00:40:00.000Z" },
  "_meta": { "mode": "ultragoal", "sessionId": "ses_example01", "updatedAt": "2026-10-01T00:40:00.003Z", "updatedBy": "ultragoal_tool" }
}
```

### `state/goal-state.json`

출처: `src/goal/state.ts`(gjc `goals/state.ts`, `goals/runtime.ts`; 편차 6·8·12·37). 의미와 op 전이는 [goal-loop.md](goal-loop.md)에 있습니다.

| 필드 | 타입 | 뜻 |
|---|---|---|
| `version` | `1` | `GOAL_STATE_VERSION` |
| `id` | 공백 아닌 문자열 | goal마다 새 UUID. continuation 기록이 이 값으로 goal을 구분합니다 |
| `objective` | 공백 아닌 문자열 | ultragoal이 켠 goal은 `ultragoalGoalObjective`의 고정 문장 |
| `status` | `active`/`paused`/`complete`/`dropped` | `dropped`는 모든 op가 "goal 없음"으로 봅니다(DR-9) |
| `source` | `ultragoal`/`user` | gjc `provenance` 대신 |
| `created_at`, `updated_at` | 공백 아닌 문자열 | 시각 |

다른 키가 있거나 검사에 어긋나면 파일은 "goal 없음"으로 읽히고 그대로 남습니다. 다음 `create`가 덮어씁니다(`readGoalStateTx`). 쓰기마다 감사 행이 하나 붙는데, `skill`은 `goal` 도구면 `"goal"`, `ultragoal create`면 `"ultragoal"`입니다(`writeGoalStateTx`).

```json
{
  "version": 1,
  "id": "9aeee1df-bf80-4804-804a-f73d56ed856b",
  "objective": "Complete the durable ultragoal plan in .open-gajae/_session-20261001-091500-ses_example01/ultragoal/goals.json, including later accepted/appended goals, under the original description constraints; use .open-gajae/_session-20261001-091500-ses_example01/ultragoal/ledger.jsonl as the audit trail.",
  "status": "active",
  "source": "ultragoal",
  "created_at": "2026-10-01T00:20:00.000Z",
  "updated_at": "2026-10-01T00:20:00.000Z"
}
```

### `state/goal-continuation.json`

훅 전용 기록입니다(PQ-2 B). 감사하지 않고, 내용이 바뀔 때만 씁니다(`writeContinuationTx`). 의미는 [goal-loop.md](goal-loop.md)에 있습니다.

| 필드 | 뜻 |
|---|---|
| `goal_id` | 이 기록이 속한 goal의 `id`. 다르면 기록을 새로 시작합니다(`continuationForGoal`) |
| `tool_less_turns` | 0 이상 정수. 도구 없이 끝난 연속 턴 수 |
| `held` | 선택. `{reason, at}`. `reason`은 `"no_tool_progress"` 또는 `"critic_streak"` |
| `critic_reset_after` | 선택. critic 연속 횟수를 이 `critic_verdict` `eventId` 뒤부터 셉니다 |

읽을 수 없거나 모양이 틀리면 없는 것으로 봅니다(`parseGoalContinuation`).

```json
{
  "goal_id": "9aeee1df-bf80-4804-804a-f73d56ed856b",
  "tool_less_turns": 0,
  "critic_reset_after": "c2d9e1a0-5b7e-4f3a-9d1c-0e6f2a4b8c11"
}
```

### `state/active/<skill>.json` (활성 행)

출처: `src/skill-state/rows.ts`의 `rowEntry`(gjc `syncSkillActiveState`/`buildSyncEntry`; 편차는 4장).

| 필드 | 뜻 |
|---|---|
| `skill` | 스킬 이름 |
| `phase` | 쓴 시점의 단계 |
| `active` | `true` 또는 `false`(인계 호출자 행만 `false`로 남습니다) |
| `activated_at` | 이 행을 쓴 시각. 다시 쓸 때마다 바뀝니다(gjc와 같음) |
| `updated_at` | 같은 시각 |
| `session_id` | owner 세션 |
| `handoff_from`, `handoff_to`, `handoff_at` | 인계 행에만 |
| `hud` | 정규화한 HUD 요약(6장) |
| `receipt` | ultragoal 행에는 쓰지 않습니다 |

`source_state_revision`, `thread_id`, `turn_id`는 없습니다. `src/skill-state/rows.ts` 헤더가 이것들과 active subskill 없음을 "ralplan 17" 편차 아래에 묶어 적습니다. 루트 README의 ralplan 편차 17 행은 envelope `receipt`·checksum·revision과 stale-skip만 다루고, `thread_id`·`turn_id`·active subskill은 적지 않습니다.

```json
{
  "skill": "ultragoal",
  "phase": "blocked",
  "active": true,
  "activated_at": "2026-10-01T00:40:00.005Z",
  "updated_at": "2026-10-01T00:40:00.005Z",
  "session_id": "ses_example01",
  "hud": {
    "version": 1,
    "chips": [
      { "label": "blocked", "value": "1", "priority": 5, "severity": "blocked" },
      { "label": "goals", "value": "0/2", "priority": 10 },
      { "label": "current", "value": "G002:Resolve final code-review blockers", "priority": 20 },
      { "label": "status", "value": "blocked", "priority": 30 },
      { "label": "ledger", "value": "review_blockers_recorded:G001", "priority": 35 }
    ],
    "updated_at": "2026-10-01T00:40:00.003Z"
  }
}
```

### `state/skill-active-state.json` (스냅숏)

`rebuildSnapshotTx`가 행 파일로 매번 새로 만듭니다.

| 필드 | 뜻 |
|---|---|
| `version` | `1` |
| `active` | 보이는(`active !== false`) 행이 하나라도 있는가 |
| `skill`, `phase`, `updated_at` | 주 행의 값. 없으면 `""` |
| `session_id` | 주 행의 값. 주 행이 없으면 키가 없습니다(`undefined`라 직렬화에서 빠짐) |
| `active_skills` | `state/active/`의 `.json` 파일 중 JSON 객체이고 공백 아닌 `skill`을 가진 것(비활성 행 포함), 파일 이름 순(`readRowsTx`) |
| `active_subskills` | 항상 `[]`(`rows.ts` 헤더의 "ralplan 17" 편차 묶음) |

행이 하나도 없을 때:

```json
{
  "version": 1,
  "active": false,
  "skill": "",
  "phase": "",
  "updated_at": "",
  "active_skills": [],
  "active_subskills": []
}
```

### `state/audit.jsonl` (감사 로그)

출처: `src/skill-state/audit.ts`의 `appendAudit`(gjc `state-writer.ts`의 `maybeAudit`; 편차 ralplan 21). 파일을 하나 바꿀 때마다 한 줄을 덧붙입니다. 코드는 이 파일을 읽지 않습니다.

| 필드 | 뜻 |
|---|---|
| `ts` | 쓴 시각 |
| `skill` | 선택. mode-state·산출물·원장·goal-state 행에만. 행·스냅숏·저널 행에는 없음 |
| `category` | `state`, `artifact`, `ledger` |
| `verb` | 아래 표 |
| `owner` | `open-gajae-runtime`(도구) 또는 `open-gajae-hook`(훅). gjc는 `gjc-runtime`/`gjc-hook` |
| `mutation_id` | 준 값, 없으면 새 UUID |
| `from_phase`, `to_phase` | 선택. mode-state 쓰기(`reconcile`, seed `write`, `state` op `write`, `clear`, `handoff`, `invalid_transition_detected`)에만. 이 행들에는 단계가 바뀌지 않아도(예: `complete` → `complete`) `to_phase`가 늘 있고, `from_phase`는 이전 상태에 단계가 있을 때만 있습니다 |
| `forced` | 기본 `false`. reconcile은 `true`, `clear`는 `force` 값 |
| `paths` | 바꾼 파일 경로 하나의 배열 |

값이 없는 선택 필드는 JSON에서 빠집니다.

ultragoal에서 나오는 감사 행:

| `verb` | `category` | 대상 | `skill` | `mutation_id` | 누가 |
|---|---|---|---|---|---|
| `write` | `state` | `ultragoal/goals.json` | `ultragoal` | UUID | `writePlanTx` |
| `append` | `ledger` | `ultragoal/ledger.jsonl` | `ultragoal` | UUID | `appendLedgerTx`(행마다 하나, `reconcile_failed` 포함) |
| `write` | `artifact` | `ultragoal/progress.txt` | `ultragoal` | UUID | `writeProgressTx` |
| `write` | `state` | `state/goal-state.json` | `goal`/`ultragoal` | UUID | `writeGoalStateTx` |
| `reconcile` | `state` | `state/ultragoal-state.json` | `ultragoal` | `ultragoal:reconcile:<ISO>` | reconcile, `forced: true` |
| `write` | `state` | `state/ultragoal-state.json` | `ultragoal` | `ultragoal:seed:<ISO>` | seed(owner `open-gajae-hook`), `to_phase: goal-planning` |
| `write` | `state` | `state/ultragoal-state.json` | `ultragoal` | `ultragoal:<ISO>` | `state` op |
| `clear` | `state` | `state/ultragoal-state.json` | `ultragoal` | `ultragoal:clear:<ISO>` | `clear`, `to_phase: complete` |
| `handoff` | `state` | 호출자·피호출자 mode-state | 해당 스킬 | `<caller>:handoff:<callee>:<ISO>` | 인계(`writeHandoffStateTx`) |
| `invalid_transition_detected` | `state` | ralplan mode-state | `ralplan` | 인계 ID | 인계 중 ralplan 전이표에 없는 active 쓰기. ultragoal에는 manifest를 등록하지 않아 나오지 않습니다 |
| `write-active-entry` | `state` | `state/active/<skill>.json` | — | UUID | `writeRowTx` |
| `remove-active-entry` | `state` | 같음 | — | UUID | 비활성 동기화로 실제로 지웠을 때만 |
| `remove-superseded-pipeline-entry` | `state` | 상위 스킬 행 | — | UUID | 활성 동기화가 상위 행을 실제로 지웠을 때만 |
| `rebuild-active-snapshot` | `state` | `state/skill-active-state.json` | — | UUID | `rebuildSnapshotTx`(행을 쓰거나 지우려 할 때마다) |
| `write-transaction-journal` | `state` | 저널 파일 | — | 저널 ID | 저널 쓰기마다 |
| `remove-transaction-journal` | `state` | 저널 파일 | — | 저널 ID | 저널을 실제로 지웠을 때만 |

`goal-continuation.json`은 감사하지 않습니다(plan C-6).

```text
{"ts":"2026-10-01T00:40:00.004Z","skill":"ultragoal","category":"state","verb":"reconcile","owner":"open-gajae-runtime","mutation_id":"ultragoal:reconcile:2026-10-01T00:40:00.003Z","from_phase":"active","to_phase":"blocked","forced":true,"paths":["/work/app/.open-gajae/_session-20261001-091500-ses_example01/state/ultragoal-state.json"]}
{"ts":"2026-10-01T00:40:00.005Z","category":"state","verb":"write-active-entry","owner":"open-gajae-runtime","mutation_id":"98ac53ca-…","forced":false,"paths":["/work/app/.open-gajae/_session-20261001-091500-ses_example01/state/active/ultragoal.json"]}
```

### `state/transactions/<id>.json` (인계 저널)

출처: `src/skill-state/journal.ts`(gjc `WorkflowTransactionJournal` 등; 편차: 저널도 감사함, 덮어쓰기 방지는 큐 안의 확인+쓰기). 인계를 감싸는 증거입니다. 아무것도 재실행하거나 되돌리지 않고 doctor도 읽지 않습니다(I-19). 인계 순서 자체는 [entry-and-handoff.md](entry-and-handoff.md)에 있습니다.

- **파일 이름**(`journalPath`): `encodeURIComponent(mutationId)`에서 `.`을 `%2E`로 바꾼 뒤 `.json`. mutation ID가 `ralplan:handoff:ultragoal:2026-10-01T00:18:00.000Z`이면 파일은 `ralplan%3Ahandoff%3Aultragoal%3A2026-10-01T00%3A18%3A00%2E000Z.json`입니다.
- **필드**: `version: 1`, `mutation_id`, `status`(`pending`/`committed`), `created_at`, `updated_at`, `caller`, `callee`, `paths`(피호출자 mode-state, 호출자 mode-state, 스냅숏), `steps`.
- **단계 이름**(`steps`): `callee-mode-state`, `caller-mode-state`, `active-state`, 그리고 ultragoal이 호출자일 때 `caller-records`.
- **생애**: 시작할 때 `pending`으로 씁니다(같은 파일이 있으면 그대로 둠). 단계마다 병합해 다시 씁니다. 끝나면 `committed`로 쓰고 지웁니다. 지우기가 실패하면 `committed` 파일이 남고 오류는 아닙니다. 중간에 예외가 나면 `pending` 파일이 남습니다. 정상 인계 뒤 `state/transactions/`는 빈 디렉터리로 남습니다.

```json
{
  "version": 1,
  "mutation_id": "ultragoal:handoff:ralplan:2026-10-01T00:50:00.000Z",
  "status": "pending",
  "created_at": "2026-10-01T00:50:00.001Z",
  "updated_at": "2026-10-01T00:50:00.004Z",
  "caller": "ultragoal",
  "callee": "ralplan",
  "paths": [".../state/ralplan-state.json", ".../state/ultragoal-state.json", ".../state/skill-active-state.json"],
  "steps": ["callee-mode-state", "caller-mode-state", "active-state"]
}
```

## 4. 활성 행, 스냅숏, 순위

출처: `src/skill-state/rows.ts`(gjc `skill-state/active-state.ts`, `gjc-runtime/state-writer.ts`). 헤더에 적힌 편차: ralplan 17(revision·stale-skip·`thread_id`/`turn_id`·active subskill 없음), 인계는 호출자와 피호출자 행만 씀, 보이는 읽기는 스킬 이름으로만 행을 구분함(한 세션 폴더의 행은 모두 그 세션 것).

### 파이프라인 순위

`PIPELINE_RANK`(gjc `PLANNING_PIPELINE_RANK`): `deep-interview`(0) → `ralplan`(1) → `ultragoal`(2). 숫자가 클수록 하류 단계이고 상류 단계를 대체합니다. `comparePrimary`는 두 행 중 하나라도 파이프라인 스킬이면 순위 차이만 봅니다(파이프라인 스킬이 다른 스킬보다, 높은 순위가 낮은 순위보다 앞). 둘 다 파이프라인 스킬이 아닐 때만 더 최근 시각을 앞에 둡니다.

### 행 쓰기와 지우기

- `syncActiveRowTx(tx, input, owner)`: `active: true`면 상위 스킬의 행을 먼저 지우고(`remove-superseded-pipeline-entry`) 이 행을 씁니다. `active: false`면 이 행을 지웁니다(`remove-active-entry`). 어느 쪽이든 끝에 스냅숏을 다시 만듭니다. 하위 스킬의 행은 지우지 않습니다: ultragoal 행이 있을 때 ralplan이 활성 동기화를 해도 ultragoal 행은 남습니다(`tests/skill-state.test.ts` "rows: an active row removes the upstream pipeline rows, never a downstream one").
- 그래서 ultragoal이 활성으로 동기화될 때마다(reconcile, seed, `state`) `state/active/ralplan.json`과 `state/active/deep-interview.json`이 있으면 지워집니다(D-SF2).
- `writeHandoffRowsTx(tx, {caller, callee?, at}, owner)`: 호출자 행을 `active: false`, `phase: "handoff"`, `handoff_to`로 **남기고**(이전 행의 `handoff_from`이 있으면 이어받음), 피호출자 행이 있으면 `active: true`, 초기 단계, `handoff_from`으로 씁니다. 두 행의 시각은 인계 시각입니다. 상위 행을 지우지 않습니다. 끝에 스냅숏을 다시 만듭니다.
- ultragoal 행을 쓰는 호출: reconcile(`reconcileUltragoalTx`), seed(`seedUltragoalTx`), `state` op, `clear`(항상 비활성 → 지움), 인계(ultragoal이 호출자면 비활성 행, 피호출자면 활성 행). `state`와 `clear`의 행 동기화는 실패해도 무시합니다(gjc state 동사의 HUD 동기화처럼 best-effort).
- 행은 인계에서 온 것이 아니면 `handoff_*` 필드가 없습니다. 예: 인계로 생긴 ultragoal 행에는 `handoff_from: "ralplan"`이 있지만, 다음 seed나 reconcile이 쓴 행에는 없습니다(mode-state에는 남음).

### 스냅숏 다시 만들기

`rebuildSnapshotTx`는 `state/active/`의 `.json` 파일을 이름 순으로 모두 읽습니다(`readRowsTx`). JSON 객체가 아니거나 공백 아닌 `skill`이 없는 것은 건너뛰고, **JSON 파싱이 안 되는 파일이 하나라도 있으면 예외**입니다. 이전 스냅숏은 읽지 않습니다. `active !== false`인 행을 `comparePrimary(updated_at)`로 정렬해 첫 행을 주 행으로 삼고, `active_skills`에는 건너뛰지 않은 행을 모두 그대로 넣습니다. 쓰고 나면 `rebuild-active-snapshot` 감사 행을 남깁니다. 지울 행이 없어서 아무 행도 안 바뀌었어도 스냅숏은 다시 쓰고 감사합니다.

### 보이는 주 스킬(visible primary)

`readVisiblePrimaryTx`(gjc `readVisibleSkillActiveState`의 주 항목, C-3). 훅의 planning 가드, ralplan continuation, 스킬 로드 거부·안내가 이 값을 씁니다([guards.md](guards.md)).

1. 스냅숏의 `active_skills`를 스킬 이름으로 모으고, 행 파일로 덮어씁니다(행 파일이 이김). 스냅숏이 읽히지 않으면 없는 것으로 보고, 행 파일이 깨졌으면 예외입니다.
2. `active !== false`인 것만 남깁니다.
3. ralplan 행은, ralplan mode-state의 단계가 phase lock(`final`, `handoff`, `complete` 등)에 있으면 그 단계로 바꿔 봅니다(`withCanonicalRalplanPhase`). HUD의 `stage` 칩 값도 바꿉니다. ultragoal 행에는 이런 치환이 없습니다.
4. 파이프라인 행이 둘 이상이면 가장 높은 순위 하나만 남깁니다. `comparePrimary`는 파이프라인 스킬이 하나라도 끼면 순위 차이만 돌려주므로, 파이프라인 행 사이에서는 시각을 보지 않습니다.
5. 그중 첫 행이 주 스킬입니다. 보이는 행이 없으면 `undefined`입니다.

스냅숏의 주 행과 보이는 주 스킬이 다를 수 있는 이유는 두 가지입니다. 보이는 읽기는 행 파일이 없는 스냅숏 항목도 후보로 넣고(1단계), ralplan 단계를 치환합니다(3단계). 시각 기준도 다르지만(스냅숏은 `updated_at`, 보이는 읽기는 `handoff_at` → `updated_at` → `activated_at`), 그 차이는 파이프라인이 아닌 행끼리 비교할 때만 나타납니다. 보이는 행 중 파이프라인 스킬이 있으면 결과는 늘 그중 가장 높은 순위입니다. 그래서 ultragoal 행이 활성이면 ultragoal이 주 스킬입니다.

### deep-interview는 행이 없습니다

deep-interview는 활성 행을 쓰지 않습니다. ultragoal → deep-interview 인계에서도 피호출자 행을 쓰지 않습니다(`src/skill-state/handoff.ts`의 `HANDOFF_SKILLS["deep-interview"].row: false`, PQ-5 (2) A, 루트 README의 ultragoal 편차 33·ralplan 편차 14). 그래서 이 인계 뒤에는 ultragoal의 비활성 `handoff_to` 행만 남고, 스냅숏은 `active: false, skill: ""`, 보이는 주 스킬은 없습니다. deep-interview 행 설계는 후속 과제입니다(ultragoal spec E5, 루트 README "Mandatory follow-up development" 1번).

## 5. 단계 manifest와 reconcile

출처: `src/ultragoal-runtime/manifest.ts`(gjc `workflow-manifest.ts`의 ultragoal `states`/`terminalStates`/`transitions`, `skill-state/initial-phase.ts`, `state-runtime.ts`의 `state write` 단계 검사; 편차 25). 이 집합들은 ultragoal 것이고 ralplan의 집합과 섞지 않습니다.

### 단계 목록

`ULTRAGOAL_STATES`(gjc 순서): `missing`, `goal-planning`, `pending`, `active`, `blocked`, `failed`, `complete`, `handoff`.

| 단계 | 뜻 | 누가 만드는가 |
|---|---|---|
| `missing` | `goals.json`이 없음 | reconcile(`active: false`) |
| `goal-planning` | 계획을 세우는 중. 초기 단계(`ULTRAGOAL_INITIAL_STATE`) | seed, ralplan → ultragoal 인계, `state` op |
| `pending` | 목표가 있고 모두 `complete`/`superseded`는 아니며, `active`·`failed`·`blocked`·`review_blocked` 목표가 없음 | reconcile |
| `active` | active 목표가 있음 | reconcile |
| `blocked` | `blocked`나 `review_blocked` 목표가 있고 active·failed 목표가 없음 | reconcile |
| `failed` | failed 목표가 있고 active 목표가 없음 | reconcile |
| `complete` | 모든 목표가 `complete` 또는 `superseded` | reconcile(`active: false`), `clear`(`active: false`) |
| `handoff` | 다른 스킬로 넘겨줌 | ultragoal이 호출자인 인계(`active: false`) |

### 종료 단계, 전이표, guard-release 단계

- **종료 단계** `ULTRAGOAL_TERMINAL_STATES`: `missing`, `failed`, `complete`, `handoff`. 압축 복구는 행이 활성이고 단계가 이 집합 **밖**일 때만 돕니다(`recovery.ts`의 `ultragoalRecoveryApplies`).
- **guard-release 단계** `ULTRAGOAL_GUARD_RELEASE_PHASES`(gjc 기본 `stopReleasingPhases`, ultragoal은 자기 것을 두지 않음): `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`. 현재 코드에서 이 집합을 쓰는 곳은 `clear`의 stale 검사(`describeStaleClearTx`) 하나입니다. mode-state 단계가 이 집합에 있으면(`inactive` 제외) `force` 없는 `clear`를 거부합니다. goal-planning 편집 가드는 이 집합이 아니라 `goal-planning` 단계만 봅니다([guards.md](guards.md)).
- **전이표** `ULTRAGOAL_TRANSITIONS`(gjc 11행). `verb`는 gjc 이름표이고 코드가 쓰지는 않습니다.

| from | to | verb |
|---|---|---|
| `goal-planning` | `pending` | `create-goals` |
| `pending` | `active` | `complete-goals` |
| `active` | `blocked` | `checkpoint` |
| `active` | `failed` | `checkpoint` |
| `active` | `complete` | `checkpoint` |
| `blocked` | `active` | `checkpoint` |
| `failed` | `active` | `complete-goals` |
| `goal-planning` | `handoff` | `handoff` |
| `pending` | `handoff` | `handoff` |
| `active` | `handoff` | `handoff` |
| `blocked` | `handoff` | `handoff` |

`isValidUltragoalTransition(from, to)`는 같은 단계이거나 표에 있는 칸이면 참입니다. 이 표를 검사하는 곳은 `state` op 하나입니다(`ultragoalPhasePatchError`: 목표 단계가 manifest 단계가 아니면 `unknown ultragoal phase "<p>"`, 저장된 단계도 manifest 단계인데 표에 없는 이동이면 `invalid ultragoal phase transition from <a> to <b>`). reconcile, seed, 인계, `clear`는 표를 보지 않습니다. 인계의 `invalid_transition_detected` 감사 행도 ultragoal에는 나오지 않습니다(ultragoal에 manifest를 등록하지 않음).

### reconcile이 단계를 정하는 법

`reconcileUltragoalTx`(gjc `reconcileUltragoalState`, C-4). 단계는 `goals.json`의 목표 상태만으로 정합니다(`plan.ts`의 `deriveRunStatus`, DR-1). 영수증이 유효한지는 보지 않습니다. 영수증까지 따지는 실행 완료 판정(`runCompletion`)은 `status`·`next`·`checkpoint`의 출력과 `goal` 도구 가드가 따로 씁니다([gates-and-receipts.md](gates-and-receipts.md)).

| 조건(위에서부터 처음 맞는 것) | `status` = `current_phase` | `active` |
|---|---|---|
| `goals.json` 없음 | `missing` | `false` |
| 목표가 있고 모두 `complete` 또는 `superseded` | `complete` | `false` |
| `active` 목표가 있음 | `active` | `true` |
| `failed` 목표가 있음 | `failed` | `true` |
| `blocked` 또는 `review_blocked` 목표가 있음 | `blocked` | `true` |
| 그 밖 | `pending` | `true` |

예: `record_review_blockers`가 active였던 목표를 `review_blocked`로 바꾸고 새 수정 목표를 `pending`으로 넣으면, active 목표가 없고 `review_blocked`가 있으므로 단계는 `blocked`입니다. 다음 `next`가 수정 목표를 active로 올리면 `active`로 돌아갑니다.

`goals.json`이 깨져 있으면 reconcile은 예외를 내고 실패 행만 남깁니다(아래).

### reconcile의 쓰기

같은 트랜잭션 안에서 이 순서로 씁니다.

1. `goals.json`을 읽어 위 표로 `status`와 `active`를 정하고, 원장을 느슨하게 읽어 `latestLedgerEvent`를 얻습니다.
2. 파생 필드 묶음(`skill`, `status`, `current_phase`, `active`, `goals`, `counts`, `active_goal_id`, 세 경로, `latestLedgerEvent`)을 기존 mode-state 위에 `mergeWithNullDelete`로 병합합니다. 기존 mode-state가 깨졌거나 읽히지 않으면 빈 객체에서 시작해 **덮어씁니다**(gjc reconcile과 같음). `version: 2`, `updated_at`을 넣고 `session_id`가 없으면 채웁니다. `workflowEnvelopeError`로 envelope을 확인한 뒤 씁니다.
3. 감사 행 `reconcile`: `forced: true`, `from_phase`는 이전 단계, `to_phase`는 새 단계.
4. `syncActiveRowTx`로 행을 동기화합니다. `active: true`면 상위 행을 지우고 ultragoal 행을 새 단계와 HUD로 씁니다. `active: false`면 ultragoal 행을 지웁니다. 그리고 스냅숏을 다시 만듭니다.

**왜 `forced`인가.** reconcile의 단계는 `goals.json`에서 파생한 값이고, 전이표를 거치지 않고 그대로 씁니다(gjc `reconcileWorkflowSkillStateUnlocked`: "the write is forced and audited as `reconcile`"). 그래서 표에 없는 이동도 일어납니다. 예: `goal-planning` → `missing`(`create` 전에 `status`를 부름), `handoff` → `active`(인계 뒤 ultragoal op를 부름), `pending` → `blocked`(`checkpoint(blocked)`), `active` → `pending`(유일한 active 목표를 `checkpoint(pending)`으로 다시 엶). `forced: true`는 이 쓰기가 전이 검사를 하지 않았다는 기록입니다.

**행이 지워지는 때.** reconcile이 `active: false`를 낼 때, 즉 `complete`(모든 목표가 `complete`/`superseded`)나 `missing`일 때입니다. 마지막 필수 목표의 `checkpoint(complete)`가 보통 이 경우입니다. 그 밖에 `clear`는 항상, `active: false`를 넣은 `state` op도 행을 지웁니다. 인계는 행을 지우지 않고 비활성 `handoff_to` 행으로 남깁니다.

**다시 켜짐.** reconcile은 `active`를 목표 상태에서 다시 계산합니다. 그래서 `clear`나 인계로 꺼진 run도, 끝나지 않은 목표가 남아 있으면 다음 reconcile op(예: `status`)에서 다시 `active: true`가 되고 행이 다시 생기며 상위 행(ralplan)이 지워집니다. SKILL은 인계 뒤 ultragoal op를 부르지 말라고 적습니다(SKILL-only 규칙).

**reconcile하는 op.** `status`, `create`, `next`, `checkpoint`, `add`, `revise`, `supersede`, `record_review_blockers`, `classify_blocker`, `record_critic_verdict`. 하지 않는 op: `add_pattern`, `validate_gate`, `doctor`. `handoff`, `state`, `clear`는 행을 스스로 씁니다. op별 세부는 [ops.md](ops.md).

**reconcile 실패.** reconcile 안의 어떤 예외도 op 결과를 바꾸지 않습니다. 대신 원장에 `{type: "reconcile_failed", error}` 행을 덧붙이고(감사 `append`), 이 덧붙이기마저 실패하면 무시합니다. 롤백은 없습니다.

깨진 행 파일이 reconcile에 주는 영향은 파일 이름에 따라 다릅니다. `syncActiveRowTx`는 `rebuildSnapshotTx`가 행 파일을 파싱하기(`readRowsTx`) **전에** 파싱 없이 행을 덮어쓰거나 지웁니다.

- `ultragoal.json`: 활성 동기화는 `writeText`로 덮어쓰고, 비활성 동기화는 `tx.remove`로 지웁니다. 다음 reconcile에서 복구됩니다.
- `ralplan.json`, `deep-interview.json`: ultragoal이 활성으로 동기화될 때 상위 행으로 `tx.remove`됩니다. 그래서 그 reconcile에서 복구됩니다. 비활성 동기화(`complete`, `missing`)는 이 파일들을 건드리지 않으므로, 그때 깨져 있으면 재구성이 예외를 냅니다.
- 깨진 `skill-active-state.json`: 재구성이 읽지 않고 새로 쓰므로 영향이 없습니다.
- 파이프라인 스킬이 아닌 이름의 파일(예: `other.json`): 어떤 ultragoal op도 지우지 않으므로, 손으로 지울 때까지 모든 reconcile이 재구성 단계에서 실패하고 그때마다 `reconcile_failed` 행이 붙습니다(`tests/ultragoal-tool.test.ts` "a reconcile failure keeps the op's result and appends gjc's reconcile_failed ledger row").

이렇게 재구성 단계에서 실패하면 mode-state와 ultragoal 행(그리고 지워진 상위 행)은 이미 새 상태이고, **스냅숏만** 옛 값으로 남습니다.

### reconcile이 아닌 단계 쓰기

| 경로 | 결과 단계·`active` | 비고 |
|---|---|---|
| seed(`seedUltragoalTx`, `skill ultragoal` 로드) | 없거나 비활성인 상태 → `goal-planning`, `true`. 이미 활성이면 그대로 | 기존 필드 위에 병합(ultragoal 편차 35, ultragoal plan DR-21). 어느 경우든 행을 활성으로 동기화해 상위 행을 지움. 상태가 깨져 있으면 아무것도 쓰지 않음(`"corrupt"`) |
| 인계, ultragoal이 피호출자 | `goal-planning`, `true`, `handoff_from`, `handoff_at` | 기존 필드 위에 병합 |
| 인계, ultragoal이 호출자 | `handoff`, `false`, `handoff_to`, `handoff_at` | 기존 필드 위에 병합 |
| `state` op | 패치한 `current_phase`(전이표 검사). `active`는 병합 결과 값이고, boolean이 아니면 `true` | 아래 |
| `clear` | `complete`, `false` | 파일은 남김. 행 지움 |

seed와 인계 병합은 `status`, `goals`, `counts` 같은 이전 파생 필드를 지우지 않습니다. 그 값은 다음 reconcile까지 이전 run의 값으로 남습니다(6장의 HUD에 영향).

**`state` op가 거부하는 파생 필드**(`ULTRAGOAL_DERIVED_FIELDS`, PQ-1 A): `goals`, `counts`, `status`, `active_goal_id`, `goals_path`, `ledger_path`, `progress_path`, `latestLedgerEvent`, `skill`, `version`, `session_id`. 다음 reconcile이 어차피 다시 쓰기 때문입니다. 메시지는 `state patch cannot set derived ultragoal field(s): <keys>; the next ultragoal op rewrites them from goals.json and the ledger`입니다. `current_phase`와 `active`는 패치할 수 있습니다(단계는 전이표로 검사). `--force` 우회는 없습니다(편차 25). `_meta`는 패치에서 버립니다.

## 6. HUD 칩

출처: `src/ultragoal-runtime/hud.ts`(gjc `workflow-hud.ts`의 `buildUltragoalHudSummary`, `state-runtime.ts`의 `buildHudForMode` ultragoal 가지; 편차 없음), 공통 도우미와 정규화는 `src/skill-state/hud.ts`(DR-9).

HUD는 활성 행의 `hud` 필드에 **저장만** 합니다. 스냅숏의 `active_skills`에도 행 객체째로 들어갑니다. 이 값을 그리는 코드는 없습니다. TUI 사이드바는 미뤘습니다(R-OD17, 루트 README의 ralplan 편차 9와 후속 과제 6번). 계산하는 곳은 reconcile, seed, `state` op, 인계의 양쪽 행이고, 모두 `buildUltragoalHudFromState(state, at)`를 거칩니다.

**입력**(`buildUltragoalHudFromState`): mode-state의 `goals` 중 `id`·`title`·`status`가 모두 문자열인 것, `status`(없으면 `current_phase`, 그것도 없으면 `"pending"`), `latestLedgerEvent`(`event`가 문자열일 때), 그리고 시각 `at`.

**칩**(`buildUltragoalHud`, 이 순서로 넣음):

| label | value | priority | severity | 나오는 조건 |
|---|---|---|---|---|
| `blocked` | `blocked` + `review_blocked` + `failed` 목표 수 | 5 | `blocked` | 그 합이 1 이상 |
| `goals` | `<complete 수>/<전체 목표 수>`(superseded 포함) | 10 | — | 항상 |
| `current` | 첫 `active` 목표, 없으면 첫 `pending` 목표의 `<id>:<title>`. 둘 다 없으면 `status` 값 | 20 | — | 항상 |
| `status` | `status` 값 | 30 | `complete`면 `success` | 항상 |
| `ledger` | `event`, `kind`, `goalId` 중 있는 것을 `:`로 이은 값. 예: `steering_accepted:add:G004`, `goal_started:G002` | 35 | — | `latestLedgerEvent`가 있을 때 |
| `gate`, `blocked`, `next` | — | 40, 50, 60 | — | 공통 `gateChips`를 부르지만 ultragoal 입력에는 승인·차단·다음 행동 값이 없어 **나오지 않습니다** |

요약 객체는 `{version: 1, chips, updated_at: at}`입니다. `summary`, `details`, 최상위 `severity`는 넣지 않습니다.

**정규화**(`normalizeWorkflowHudSummary`, 행을 쓸 때마다): `version`이 1이 아니면 버림, 칩은 배열 순서대로 최대 6개, `details`는 최대 12개, label은 32자, value는 80자까지 자름, ANSI 이스케이프 제거, 줄바꿈·탭은 공백 하나로, 빈 label 칩은 버림, 알 수 없는 severity는 버림, `updated_at`은 40자까지.

주의할 동작(코드 그대로):

- `current` 칩은 첫 active, 없으면 첫 pending 목표입니다. mode-state의 `active_goal_id`(첫 pending·active·failed)와 다를 수 있습니다.
- `status` 칩은 mode-state의 `status` 필드를 먼저 봅니다. seed와 인계 병합은 이전 run의 `status`, `goals`, `counts`를 그대로 두므로, 끝난 run 뒤에 다시 들어오면 행의 `phase`는 `goal-planning`인데 HUD는 `status=complete`(severity `success`)와 이전 `goals` 기준의 `goals`·`current` 칩을 보여 줄 수 있습니다. ultragoal이 호출자인 인계 행도 인계 전 `status`(예: `active`)를 보여 줍니다. 다음 reconcile이 바로잡습니다.
- 마지막 목표가 끝나면 행을 지우므로 `status: complete` 칩은 남지 않습니다.

## 7. doctor

출처: `src/skill-state/doctor.ts`(gjc `state-runtime.ts`의 `collectDoctorSummary`, `renderDoctorText`, `state-validation.ts`의 `validateWorkflowStateEnvelope`). 편차: ralplan 13(checksum·고아 저널 검사 없음, `journals_scanned` 줄 없음), 등록되지 않은 스킬의 행은 세기만 하고 검사하지 않음, ralplan 1(수정 명령은 도구 op 이름), ralplan DR-21(알 수 없는 단계는 `schema_violation`), envelope 메시지에서 gjc의 `, got <type>` 꼬리를 뺌.

`ultragoal({"op":"doctor"})`는 `doctorTx` → `collectDoctorSummaryTx(tx, "ultragoal")` → `renderDoctorText`입니다. 읽기만 하고 아무것도 고치지 않습니다. 등록된 스킬은 `DOCTOR_SKILLS`의 `ralplan`(`isKnownPhase`)과 `ultragoal`(`isUltragoalPhase`)이고, ultragoal op는 ultragoal만 골라 검사합니다.

### 검사 항목

**1) mode-state `state/ultragoal-state.json`.** 파일이 있으면 `files_scanned`에 1을 더합니다.

| 조건 | 종류 | 메시지 |
|---|---|---|
| 읽기·JSON 파싱 실패 | `schema_violation` | `mode-state JSON is unreadable: <오류>` |
| 객체가 아님 | `schema_violation` | `state for ultragoal must be a JSON object` |
| `skill`이 있는데 `ultragoal`이 아님 | `schema_violation` | `state skill must match selected mode ultragoal` |
| `active`가 있는데 boolean이 아님 | `schema_violation` | `state.active must be a boolean when present` |
| `current_phase`가 있는데 문자열이 아님 | `schema_violation` | `state.current_phase must be a string when present` |
| `version`이 있는데 숫자가 아님 | `schema_violation` | `state.version must be a number when present` |
| `updated_at`이 있는데 문자열이 아님 | `schema_violation` | `state.updated_at must be a string when present` |
| `receipt`가 있는데 객체가 아님 | `schema_violation` | `state.receipt must be an object when present` |
| envelope은 맞지만 `current_phase`가 manifest 단계가 아님 | `schema_violation` | `unknown ultragoal phase "<p>"` |

이 중 하나라도 걸리면 그 상태는 "invalid"로 표시되어 아래의 단계 차이(drift) 검사를 건너뜁니다.

**2) 행 `state/active/*.json`.** `.json` 파일마다 `files_scanned`에 1을 더합니다(다른 스킬의 행도 셈). 소유 스킬은 행의 `skill`, 없으면 파일 이름입니다. ultragoal 행만 검사합니다.

| 조건 | 종류 | 메시지 |
|---|---|---|
| 행이 활성(`active !== false`)인데 mode-state가 없거나 비활성 | `stale_active_state` | `active entry for ultragoal does not match a live active mode-state` |
| 행이 활성이고 상태가 valid이며, 행 `phase`와 상태의 기준 단계가 다름 | `stale_active_state` | `active entry for ultragoal phase <행> differs from canonical mode-state phase <상태>` |

"상태의 기준 단계"(`modeStatePhase`)는 `current_phase`이되, 상태가 비활성이면 그 단계가 ralplan phase lock(`final`, `handoff`, `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`)에 있을 때만 셉니다(gjc가 모든 스킬에 ralplan의 `canonicalOverrides`를 쓰는 것과 같음). JSON이 깨진 행 파일은 `files_scanned`에 세지만, 값이 없어 활성으로 보지 않으므로 아무 문제로도 보고하지 않습니다.

**3) 스냅숏 `state/skill-active-state.json`.** 파일이 있으면 `files_scanned`에 1을 더합니다. JSON이 깨진 스냅숏도 세지만, `active_skills`를 읽을 수 없어 아무 문제로도 보고하지 않습니다. 읽히면 `active_skills`의 ultragoal 항목마다:

| 조건 | 종류 | 메시지 |
|---|---|---|
| 항목이 활성인데 `state/active/`에 ultragoal 행 파일이 없음 | `stale_active_state` | `active snapshot lists ultragoal but no raw per-skill active entry exists` |
| 항목이 활성이고 상태가 valid이며 단계가 다름 | `stale_active_state` | `active snapshot for ultragoal phase <항목> differs from canonical mode-state phase <상태>` |

**하지 않는 검사**: `goals.json`·원장·`progress.txt`·goal 파일의 내용, 인계 저널(남은 `pending` 저널도 보고하지 않음), checksum.

**수정 명령**(`fixCommand`): `schema_violation`이면 `ultragoal clear (force: true)`, `stale_active_state`면 `ultragoal clear`. 문제는 종류, 스킬, 경로 순으로 정렬합니다.

### 텍스트 형식

`renderDoctorText`(gjc `renderDoctorText`에서 `journals_scanned` 줄을 뺌). 끝에 줄바꿈이 하나 붙습니다. `root`는 `state/` 디렉터리입니다.

```text
ok: false
root: /work/app/.open-gajae/_session-20261001-091500-ses_example01/state
skills_scanned: 1
files_scanned: 3
findings_total: 1
counts: schema_violation=0, stale_active_state=1
finding: kind=stale_active_state skill=ultragoal path=/work/app/.open-gajae/_session-20261001-091500-ses_example01/state/active/ultragoal.json message=active entry for ultragoal phase blocked differs from canonical mode-state phase active fix=ultragoal clear
```

문제가 없으면 `ok: true`, `findings_total: 0`, `finding:` 줄 없음입니다. 정상 실행 중에는 보통 `files_scanned: 3`(mode-state, ultragoal 행, 스냅숏)입니다. ralplan 도구의 `doctor`는 같은 요약을 텍스트가 아니라 JSON 객체로 돌려줍니다.

## 8. 예: 한 번의 실행에서 파일이 바뀌는 모습

ralplan이 `final`에서 승인된 뒤 목표 하나로 시작해, 최종 리뷰에서 blocker가 나와 수정 목표 하나로 끝나는 실행입니다. 세션은 `ses_example01`, 폴더는 `_session-20261001-091500-ses_example01/`입니다. 감사 행은 `verb`와 대상만 적습니다. 실제 실행(`test-app`)의 감사 로그와 같은 순서입니다.

### (a) ralplan → ultragoal 인계, 그리고 skill 로드: `goal-planning`

`ralplan handoff(to="ultragoal")` op(owner `open-gajae-runtime`):

- `state/ultragoal-state.json`: 새로 생김. `{skill, version: 2, active: true, current_phase: "goal-planning", handoff_from: "ralplan", handoff_at, updated_at, session_id}`, `_meta.updatedBy: "ralplan_tool"`.
- `state/ralplan-state.json`: `active: false`, `current_phase: "handoff"`, `handoff_to: "ultragoal"`.
- 행: `active/ralplan.json`은 비활성 `handoff` 행(`handoff_to: "ultragoal"`), `active/ultragoal.json`은 활성 `goal-planning` 행(`handoff_from: "ralplan"`). ultragoal HUD 칩은 `goals=0/0`, `current=goal-planning`, `status=goal-planning`.
- 스냅숏: `active: true`, `skill: "ultragoal"`, `phase: "goal-planning"`, `active_skills`에 ralplan(비활성)과 ultragoal.
- 저널: 만들어졌다가 지워짐. `state/transactions/`는 빈 디렉터리로 남음.
- 원장·`goals.json`·`progress.txt`: 없음.
- 감사: `write-transaction-journal` → `handoff`(ultragoal, → `goal-planning`) → `write-transaction-journal` → `handoff`(ralplan, `final` → `handoff`) → `write-transaction-journal` → `write-active-entry`(ralplan) → `write-active-entry`(ultragoal) → `rebuild-active-snapshot` → `write-transaction-journal` ×2 → `remove-transaction-journal`.

그다음 모델이 `skill ultragoal`을 로드하면 seed가 돕니다(owner `open-gajae-hook`). 상태가 이미 활성이므로 상태는 그대로 두고(`"kept"`), 행을 활성으로 다시 씁니다.

- `active/ralplan.json` 삭제, `active/ultragoal.json` 재작성(이제 `handoff_from` 없음).
- 스냅숏: `active_skills`에 ultragoal만.
- 감사: `remove-superseded-pipeline-entry` → `write-active-entry` → `rebuild-active-snapshot`.

(같은 execution에서 ralplan에 이어 `skill ultragoal`을 로드한 경우에는 훅이 인계만 하고 seed는 부르지 않습니다. 그때는 ralplan 비활성 행이 다음 reconcile까지 남습니다.)

이 단계에서는 제품 파일 `write`/`edit`/`patch`가 막힙니다([guards.md](guards.md)).

### (b) `create`: `goal-planning` → `pending`

- `ultragoal/goals.json`: G001 하나, `pending`.
- `ultragoal/ledger.jsonl`: `plan_created`.
- `ultragoal/progress.txt`: 머리 + `PLAN` 메모.
- `state/goal-state.json`: 열린 goal이 없으면 새 goal, `status: "active"`, `source: "ultragoal"`.
- `state/ultragoal-state.json`: `current_phase`·`status` `pending`, `active: true`, `goals`, `counts`(`pending: 1`), `active_goal_id: "G001"`, 경로 셋, `latestLedgerEvent: {event: "plan_created", timestamp}`. `handoff_from`·`handoff_at`은 남음.
- 행: 활성 `pending`. 칩 `goals=0/1`, `current=G001:CSV export`, `status=pending`, `ledger=plan_created`.
- 스냅숏: 주 스킬 ultragoal, `phase: "pending"`.
- 감사: `write`(goals.json) → `append`(ledger) → `write`(progress.txt, `artifact`) → `write`(goal-state.json, skill `ultragoal`) → `reconcile`(`goal-planning` → `pending`, `forced: true`) → `write-active-entry` → `rebuild-active-snapshot`.

### (c) `next`: `pending` → `active`

- `goals.json`: G001 `active`, `started_at`.
- 원장: `goal_started` G001.
- mode-state: `active`, `counts.active: 1`, `latestLedgerEvent.event: "goal_started"`.
- 행: 칩 `goals=0/1`, `current=G001:CSV export`, `status=active`, `ledger=goal_started:G001`.
- 감사: `write`(goals.json) → `append` → `reconcile`(`pending` → `active`) → `write-active-entry` → `rebuild-active-snapshot`.

### (d) `record_review_blockers(goal_id="G001", …)`: `active` → `blocked`

- `goals.json`: G001 `review_blocked`와 `evidence`, 수정 목표 G002 `pending`(기준 `G002.AC1` 하나, `steering`). 3장의 예와 같습니다.
- 원장: `goal_checkpointed`(G001, `review_blocked`) → `review_blockers_recorded`(G001 → G002).
- mode-state: `blocked`(active 목표 없음, `review_blocked` 있음), `active: true`, `active_goal_id: "G002"`. 3장의 예와 같습니다.
- 행: 활성 `blocked`. 칩 `blocked=1`(severity `blocked`), `goals=0/2`, `current=G002:Resolve final code-review blockers`, `status=blocked`, `ledger=review_blockers_recorded:G001`.
- 감사: `write`(goals.json) → `append` ×2 → `reconcile`(`active` → `blocked`) → `write-active-entry` → `rebuild-active-snapshot`.

그다음 `next`가 G002를 올립니다: G002 `active`와 `started_at`, 원장 `goal_started` G002, 단계 `blocked` → `active`.

### (e) 마지막 `checkpoint(goal_id="G002", status="complete", gate=최종 gate, …)`: `active` → `complete`

- `goals.json`: G002 `complete`, `completionVerification`(`receiptKind: "final-aggregate"`), `evidence`, `completed_at`. 부모 G001은 `superseded`로 바뀌고 `evidence`가 `Resolved by verification blocker goal G002: <증거>`가 됩니다(`completionView`).
- 원장: `goal_checkpointed`(G002, `complete`, `qualityGateJson`, `completionVerification`). 다음 목표가 없으므로 `goal_started`는 없음.
- `progress.txt`: G002 항목.
- mode-state: `current_phase`·`status` `complete`, `active: false`, `counts`(`complete: 1`, `superseded: 1`), `active_goal_id` 키 **삭제**, `latestLedgerEvent: {event: "goal_checkpointed", goalId: "G002", timestamp, evidence}`.
- 행: `active/ultragoal.json` **삭제**. `state/active/`는 비어 있음.
- 스냅숏: 3장의 "행이 하나도 없을 때" 모양(`active: false`, `skill: ""`).
- `goal-state.json`: 아직 `active`. 모델이 `goal({"op":"complete"})`를 부르면 `complete`가 되고 감사 행(`write`, skill `goal`)이 하나 붙습니다([goal-loop.md](goal-loop.md)).
- 감사: `write`(goals.json) → `append` → `write`(progress.txt) → `reconcile`(`active` → `complete`, `forced: true`) → `remove-active-entry` → `rebuild-active-snapshot`.

이 뒤에 `status`를 다시 부르면 reconcile이 한 번 더 돕니다: `reconcile`(`complete` → `complete`) → (지울 행이 없어 `remove-active-entry` 없음) → `rebuild-active-snapshot`.

요약:

| 시점 | `current_phase` | `active` | ultragoal 행 | 스냅숏 주 스킬 | 이번에 붙은 원장 이벤트 |
|---|---|---|---|---|---|
| (a) 인계 뒤 | `goal-planning` | `true` | 활성(`handoff_from`) | ultragoal | — |
| (a) seed 뒤 | `goal-planning` | `true` | 활성 | ultragoal(ralplan 행 삭제) | — |
| (b) `create` | `pending` | `true` | 활성 | ultragoal | `plan_created` |
| (c) `next` | `active` | `true` | 활성 | ultragoal | `goal_started` |
| (d) `record_review_blockers` | `blocked` | `true` | 활성 | ultragoal | `goal_checkpointed`(review_blocked), `review_blockers_recorded` |
| (d) 다음 `next` | `active` | `true` | 활성 | ultragoal | `goal_started` |
| (e) 최종 `checkpoint` | `complete` | `false` | 삭제 | 없음(`skill: ""`) | `goal_checkpointed`(complete) |
