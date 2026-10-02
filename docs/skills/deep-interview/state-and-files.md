# deep-interview 저장 파일과 상태

이 문서는 deep-interview가 쓰는 파일과, 상태(봉투)가 어떤 규칙으로 만들어지고 바뀌는지를 코드 그대로 적습니다. 기준 코드는 [README.md](README.md) 머리에 있습니다. 예시는 기준 코드를 bun으로 실제로 불러 얻은 것이고, 세션 폴더 절대 경로는 `<session>`으로 줄였습니다.

op별 입력과 결과는 [ops.md](ops.md), 넘기기의 단계는 [entry-and-handoff.md](entry-and-handoff.md)에 있습니다.

## 1. 세션 폴더

### 폴더와 계보 루트

- 폴더 이름은 `_session-<YYYYMMDD-HHMMSS>-<세션 id>`입니다. 시각은 세션 생성 시각(로컬 시간)이고, 한 번 만든 뒤에는 `-<세션 id>` 꼬리로 찾습니다. 꼬리가 같은 폴더가 둘이면 `ambiguous session directories for <id>: …`로 실패합니다(`src/state.ts:311-340`).
- deep-interview 도구는 호출 세션의 계보 루트를 소유자로 씁니다(`src/deep-interview-runtime/tool.ts:94-103`). 자식 세션(subagent)에서 부른 op도 루트 폴더에 씁니다.

### 파일

```
<worktree>/.open-gajae/_session-<created>-<root id>/
  state/
    deep-interview-state.json     상태(봉투)
    active/deep-interview.json    deep-interview 활성 행
    skill-active-state.json       스냅숏 (세 skill 공통)
    audit.jsonl                   감사 로그 (세 skill 공통)
    transactions/<id>.json        인계 저널 (진행 중일 때만)
  specs/
    deep-interview-<slug>.md      스펙
    deep-interview-index.jsonl    스펙 index
```

| 파일 | 쓰는 곳 | 읽는 곳 |
|---|---|---|
| `state/deep-interview-state.json` | `deep-interview` 도구의 `start`·`write`·`spec`·`state`·`clear`, 공통 인계 `handoffWorkflowTx`(deep-interview가 caller일 때와 callee일 때) | 도구의 모든 op, 훅(편집 가드, continuation, 로드 게이트, 압축 문맥), doctor |
| `state/active/deep-interview.json` | `syncActiveRowTx`(도구 op), `writeHandoffRowsTx`(인계). ralplan·ultragoal의 활성 행 쓰기가 지우기도 함 | `readVisiblePrimaryTx`, `clear`의 낡음 판정, doctor |
| `state/skill-active-state.json` | `rebuildSnapshotTx`(행이 바뀔 때마다) | `readVisiblePrimaryTx`, `clear`의 낡음 판정, doctor |
| `state/audit.jsonl` | `appendAudit` | 사람(코드는 읽지 않음) |
| `state/transactions/<id>.json` | 인계 저널 | 코드는 읽지 않음 |
| `specs/deep-interview-<slug>.md` | `spec`(결합 호출 포함) | 인계 전 스펙 확인 `verifySpecTx`, 모델 |
| `specs/deep-interview-index.jsonl` | `spec` | 코드는 읽지 않음 |

`state/**`와 `specs/deep-interview-*`는 `write`·`edit`·`patch`로 쓸 수 없습니다([guards-and-continuation.md](guards-and-continuation.md)).

## 2. 쓰기 큐와 파일 쓰기

- **큐 하나**: `StateStore.workflowTransaction(owner, fn)`(`src/state.ts:476-578`)은 세션마다 큐 하나(`queueKey`, `src/state.ts:446-451`)를 잡고 `fn`을 돕니다. deep-interview·ralplan·ultragoal·goal의 op와 훅 판단이 모두 이 큐를 지납니다. 한 프로세스 안에서만 줄 세웁니다.
- **경로 제한**: `tx`의 `readText`·`writeText`·`appendLine`·`list`·`remove`는 세션 폴더 밖 경로를 `workflow path escapes the session directory`로 거부합니다.
- **원자적 쓰기**: 임시 파일 `.<이름>.<uuid>.tmp`(모드 `0600`)에 쓰고 `rename`합니다. 경로에 심볼릭 링크나 디렉터리가 아닌 것이 끼면 거부합니다. 새 디렉터리는 모드 `0700`입니다.
- **덧붙이기**: `appendLine`은 줄바꿈이 든 줄을 거부하고, `O_NOFOLLOW`로 엽니다.
- **상태 읽기 검사** (`readFile`, `src/state.ts:382-405`; `validateStoredState`, `:256-268`). 아래는 모두 예외이고, deep-interview는 이를 "손상(corrupt)"으로 봅니다.
  - JSON이 아님: `state file is corrupted; it was preserved`
  - 한도 위반: `state file is invalid; it was preserved: <한도 오류>`
  - 소유 세션 불일치(`_meta.sessionId`, 없으면 `session_id`가 루트와 다름): `state scope does not match this session; it was preserved`
  - 일반 파일이 아님: `state file is not a regular file`
- **`_meta`**: 쓸 때마다 StateStore가 `{mode, sessionId, updatedAt, updatedBy}`로 다시 만듭니다(`writeMerged`, `src/state.ts:453-468`). `updatedBy`는 `deep_interview_tool` 또는 `deep_interview_hook`이고, 인계로 쓰일 때는 caller의 writer입니다. 예: `ralplan handoff(to:"deep-interview")`가 쓴 deep-interview 상태는 `ralplan_tool`.

## 3. 봉투

### `start`가 쓰는 모양

```json
{
  "skill": "deep-interview",
  "version": 2,
  "active": true,
  "current_phase": "interviewing",
  "threshold": 0.05,
  "threshold_source": "default",
  "session_id": "ses_root",
  "updated_at": "2026-10-02T10:06:02.183Z",
  "state": {
    "initial_idea": "build a cli",
    "rounds": [],
    "established_facts": [],
    "current_ambiguity": 1,
    "threshold": 0.05,
    "threshold_source": "default"
  },
  "_meta": {
    "mode": "deep-interview",
    "sessionId": "ses_root",
    "updatedAt": "2026-10-02T10:06:02.183Z",
    "updatedBy": "deep_interview_tool"
  }
}
```

gjc 시드에서 `resolution`, `intent_contract_required`, trace, 언어 필드를 뺀 모양입니다(계획 DR-2, deep-interview 편차 5, 8). receipt, checksum, `state_revision`, 초안은 없습니다(deep-interview 편차 2).

### 필드

| 필드 | 쓰는 곳 | 비고 |
|---|---|---|
| `skill`, `version`(2), `updated_at` | 모든 쓰기 | 런타임이 덮어씀 |
| `active` | `start`·`write`·`spec`은 `true`, `state`는 패치 값(없으면 `true`), `clear`와 caller 쪽 인계는 `false`, callee 쪽 인계는 `true` | |
| `current_phase` | `start`·`reset`은 `interviewing`, `spec`은 `handoff`, `state`는 표를 따름, `clear`는 `complete`, 인계는 caller `handoff`/callee `interviewing` | `write`는 바꾸지 않음 |
| `threshold`, `threshold_source` | `start` (봉투와 `state` 양쪽) | `write`·`state`로 바꿀 수 있음, `reset`이 지움 |
| `session_id` | `start`·`write`·`spec`·`state`가 루트 id로 덮어씀. 인계는 문자열이 아닐 때만 채움 | `clear`는 쓰지 않음 |
| `spec_slug`, `spec_path`, `spec_sha256`, `spec_stage`(`final`), `spec_persisted_at` | `spec` | `state` op는 거부, `write`는 바꿀 수 있음(K13) |
| `handoff_to`, `handoff_at` | caller 쪽 인계 | |
| `handoff_from`, `handoff_at` | callee 쪽 인계(ralplan·ultragoal에서 돌아올 때) | |
| `state` | `start`가 만들고 `write`가 병합 | 인터뷰 내용 |
| 그 밖의 최상위 키 | `write`·`state`가 병합 | 모델 자유. 다만 최상위 전사 필드는 거부 |

`state` 안에서 런타임이 쓰는 것은 `start`의 초기값, `current_ambiguity`(파생), `ambiguity_floor`(하한 내역), 하한에 걸린 최신 라운드의 `ambiguity`·`reported_ambiguity`·`ambiguity_floor`뿐입니다. 나머지(`interview_id`, `type`, `topology`, `ontology_snapshots`, `lateral_reviews`, `lateral_panel_failures`, `closure_overrides`, `restated_goal`, `ambiguity_milestone` 등)는 SKILL이 정한 모양을 모델이 씁니다.

### op별 변화

| op | 봉투에 하는 일 |
|---|---|
| `start` | 위 모양으로 통째로 새로 씀 |
| `write` | 입력을 병합, 런타임 필드, 사실 재병합, 모호도 파생과 하한. phase 유지 |
| `write(reset)` | 빈 기준 위에 입력만으로 다시 만듦. phase `interviewing`, 기준치·`spec_*`·`handoff_*` 사라짐 |
| `spec` | `active: true`, `current_phase: "handoff"`, `spec_*` 다섯, `updated_at`, `session_id` |
| `handoff` (caller) | `active: false`, `current_phase: "handoff"`, `handoff_to`, `handoff_at`, `updated_at`. 다른 필드 유지 |
| 인계 callee (ralplan·ultragoal → deep-interview) | `active: true`, `current_phase: "interviewing"`, `handoff_from`, `handoff_at`, `updated_at`, `session_id`(없을 때). 다른 필드(라운드, `spec_*`, 이전 `handoff_to` 포함) 유지 |
| `state` | 패치 병합, 표에 맞는 phase, 하한 재적용. `{active: false}`는 취소(phase·라운드 유지), 취소된 `interviewing`에 `{active: true}`는 재개(deep-interview 편차 30) |
| `clear` | `active: false`, `current_phase: "complete"`, `updated_at`, `version`. 다른 필드 유지 |

인계 callee 쪽은 읽기 경계를 거치지 않고 쓰입니다. 이전 상태가 없으면 `state` 객체 없이 `{skill, version, active, current_phase, handoff_from, handoff_at, updated_at, session_id}`만 생깁니다(계획 DR-10). 모든 읽기가 읽기 경계를 거치므로 op와 훅에는 빈 `state`로 보입니다(테스트 H4: `rounds: 0`).

## 4. 읽기 경계 `normalizeForRead`

`src/deep-interview-runtime/envelope.ts:49-57`. deep-interview를 읽는 모든 코드(도구 op, 훅 판단, HUD, 병합, 하한)가 이 함수를 거칩니다(계획 C-2). 입력을 바꾸지 않고 새 객체를 돌려줍니다. 하는 일은 둘뿐입니다.

1. `state`를 객체로 만들고, `state.rounds`와 `state.established_facts`가 배열이 아니면 빈 배열로 둡니다.
2. `state` 안의 봉투 예약 키 11개를 지웁니다(`ENVELOPE_RESERVED_STATE_KEYS`, `manifest.ts:128-140`): `state`, `receipt`, `skill`, `version`, `updated_at`, `active`, `current_phase`, `state_revision`, `source_state_revision`, `last_applied_draft_id`, `session_id`.

최상위 필드를 `state`로 옮기는 gjc의 끌어올리기(hoisting)는 하지 않습니다(spec D-SR8, deep-interview 편차 25). 그래서 최상위에 남은 `rounds` 같은 필드는 인터뷰 내용으로 쓰이지 않습니다. 대신 `write`와 `state` op가 그런 입력을 거부합니다(6절).

## 5. gjc 병합

### 라운드 (`mergeDeepInterviewRounds`, `envelope.ts:108-129`)

- **병합 키** (`durableRoundKey`, `:66-75`): 비어 있지 않은 `round_key`. 없으면 `round_id`나 `question_id`에서 `nointerview::rid:<round_id>` 또는 `nointerview::r:<round>::q:<question_id|noqid>`를 만듭니다. 셋 다 없으면 키가 없습니다.
- **같은 키**: 기존 레코드 위에 새 레코드의 필드를 덮습니다(`mergeRoundPair`, `:92-102`). 값이 `undefined`인 필드는 건너뜁니다. 기존이 `lifecycle: "scored"`면 `scored`로 남습니다. 새 레코드의 `question_hash`, `answer_hash`, `question_text`가 비었고 기존 값이 있으면 기존 값을 둡니다.
- **키 없는 레코드**: 그대로 붙이고, 완전히 같은 레코드는 건너뜁니다.
- 순서는 기존 레코드 순서, 그다음 새 키의 레코드입니다.

그래서 라운드 하나를 다시 채점하려면 같은 `round_key`로 바뀐 필드만 보내면 됩니다. 예: `{round_key: "round-2", ambiguity: 0.04}`는 나머지 필드를 그대로 두고 `ambiguity`만 바꿉니다(그 결과 레코드는 다시 검사됩니다, 7절). `write`는 키 없는 입력 레코드를 따로 거부하므로(7절), 키 없는 레코드 규칙은 이전 파일에 이미 있는 레코드에만 쓰입니다.

### 사실 (`mergeEstablishedFacts`, `envelope.ts:178-200`)

- 비어 있지 않은 `id`가 있는 사실은 `id`로 필드 단위 병합합니다.
- `id`가 없는 사실은 붙이고, JSON이 완전히 같은 것은 건너뜁니다.
- 델타는 사실을 지우지 못합니다. 반박은 `disputed: true`, 대체는 `superseded_by`로 합니다(SKILL Step 2c).

`write`는 봉투 병합에서 입력의 `established_facts`로 목록을 바꾼 뒤, 기준 상태의 사실 목록과 이 함수로 다시 병합합니다(`store.ts:395-400`). 그래서 사실 하나만 보내도 다른 사실이 남습니다. `reset`에서는 기준이 비어 있어 다시 병합하지 않습니다.

### 봉투 (`mergeDeepInterviewEnvelope`, `envelope.ts:141-171`)

- 양쪽을 먼저 읽기 경계로 정리합니다.
- 최상위 키: 기존 위에 새 값을 덮고, 새 값이 `null`이면 그 키를 지웁니다.
- `state`는 지우지 않습니다. 새 `state`가 객체가 아니면(문자열, `null` 등) 무시합니다. `state` 안의 키는 얕게 병합하고 `null`이면 지웁니다.
- `state.rounds`는 위 라운드 병합으로 합칩니다.
- `state.established_facts`는 입력이 그 키를 **가졌을 때만** 바꿉니다.
- `topology` 같은 객체 필드는 통째로 바뀝니다(SKILL: "include the full object when changing any part of it").

## 6. `write` 정리기

`sanitizeWritePayload`(`envelope.ts:222-236`, gjc `sanitizeStagedPayload`).

1. **최상위 전사 필드 거부**: 입력 최상위에 `TRANSCRIPT_STATE_FIELDS` 9개(`manifest.ts:112-122`: `rounds`, `established_facts`, `current_ambiguity`, `ambiguity_floor`, `topology`, `ontology_snapshots`, `auto_researched_rounds`, `auto_answered_rounds`, `architect_failures`) 중 하나라도 있으면 `write` 전체를 거부합니다(PQ-20 C, deep-interview 편차 25).
   ```
   deep-interview write: <필드들> belong inside "state"; resend them as {"state": {…}} (top-level transcript fields are rejected, not moved).
   ```
2. **런타임 소유 키 9개**(`RUNTIME_OWNED_ENVELOPE_KEYS`, `manifest.ts:95-105`: `current_phase`, `active`, `skill`, `version`, `state_revision`, `source_state_revision`, `receipt`, `updated_at`, `last_applied_draft_id`)는 최상위에서 지우고 `ignored_runtime_owned_keys`에 이름을 넣습니다(PQ-14 A).
3. **`state` 안의 예약 키**: 이름을 `state.<키>`로 보고만 하고, 실제로는 병합의 읽기 경계가 지웁니다.

지우지 않는 것: `session_id`(병합 뒤 런타임이 루트 id로 덮음), `_meta`(StateStore가 다시 만듦), `spec_*`, `handoff_*`, `threshold`. 그래서 `write`로 `spec_*`를 바꿀 수 있습니다(K13).

`state` op는 이 정리기를 쓰지 않고, 전사 필드와 런타임 소유 필드를 거부합니다([ops.md](ops.md)의 `state`).

## 7. 라운드 기록 검사

모델이 라운드를 직접 기록하므로(deep-interview 편차 3), 런타임은 `write`가 건드린 라운드의 모양을 검사합니다(PQ-22 D, deep-interview 편차 36). gjc는 라운드를 자유 필드로 통과시킵니다.

- **검사 대상** (`inputRoundKeys`, `manifest.ts:247-259`; PQ-31 B): 입력 `state.rounds[]`의 각 `round_key`. 그 키의 **병합 뒤** 레코드를 검사하므로, 이미 완전한 라운드에 바뀐 필드만 보내도 통과합니다. `state.rounds`가 배열이 아니면 `state.rounds: must be an array of round records`, 문자열 `round_key`가 없는 항목은 `state.rounds[<i>]: round_key (a string such as "round-1") is required`(키가 없으면 병합할 곳도, 검사할 레코드도 정할 수 없음, 계획 C4-6).
- **1라운드 이상** (`scoredRoundProblems`, `manifest.ts:225-240`): `ROUND_RECORD_REQUIRED`(`manifest.ts:185-195`)
  - `round`: 정수 ≥ 1
  - `round_key`: 정확히 `"round-<round>"`
  - `lifecycle`: `"scored"`
  - `question_text`, `answer`: 비어 있지 않은 문자열
  - `ambiguity`, `scores.goal`, `scores.constraints`, `scores.criteria`: 0 이상 1 이하의 유한한 수
  - brownfield(병합 뒤 `state.type === "brownfield"`; `type`이 없으면 greenfield, PQ-32 A)면 `scores.context`도
- **Round 0** (`round0Problems`, `manifest.ts:216-223`; PQ-33 A): `round_key`가 `"round-0"`이거나 `round`가 0인 레코드. `round_key`는 `"round-0"`, `round`가 있으면 0, `question_text`·`answer`는 비어 있지 않아야 합니다. `lifecycle`은 검사하지 않습니다(SKILL은 `"answered"`).
- **나머지 필드**(`weakest_dimension`, `component_scores`, `triggers`, `ontology` 등)는 자유입니다.
- **모두 한 번에** (`roundRecordErrors`, `manifest.ts:266-288`; PQ-34 A): 어긋난 라운드마다 한 줄(`round <n> (<round_key>): <필드들>`, Round 0은 `round 0 (round-0): …`)을 모아, `roundRecordRefusal`(`manifest.ts:291-297`)이 SKILL의 꼴을 가리키는 마지막 줄과 함께 냅니다. 예는 [ops.md](ops.md)의 `write`에 있습니다. 하나라도 어긋나면 `write` 전체를 거부하고 아무것도 쓰지 않습니다.
- **SKILL과 같은 목록**: SKILL Step 2e의 `Required:` 줄과 이 상수가 같은 집합인지 `tests/integration.test.ts:416-417`이 확인합니다.

## 8. 런타임 모호도

`current_ambiguity`는 런타임이 정합니다(spec D-RS2, 계획 DR-5 7단계). `src/deep-interview-runtime/ambiguity.ts`.

### 파생 (`deriveRuntimeAmbiguity`, `ambiguity.ts:151-169`)

gjc `deriveRuntimeAmbiguity`(`deep-interview-stage.ts:485-512`).

1. `state.rounds` 중 `lifecycle: "scored"`이고 `round`와 `ambiguity`가 유한한 수인 레코드에서, `round`가 가장 큰 것(같으면 뒤의 것)을 고릅니다.
2. 있으면 그 `ambiguity`가 `state.current_ambiguity`입니다.
3. 없으면 기준 상태(이전 상태)의 `state.current_ambiguity`가 유한한 수일 때 그 값, 아니면 키를 지웁니다.
4. 그다음 하한을 적용합니다.

모델이 `state.current_ambiguity`에 넣은 값은 어떤 경우에도 남지 않습니다. Round 0만 있을 때는 `start`의 `1.0`이 이어집니다. `reset`은 기준이 비어 있으므로 채점된 라운드가 없으면 키가 없습니다.

### 하한 (`computeAmbiguityFloor`, `ambiguity.ts:68-79`)

gjc `computeAmbiguityFloor`에서 자동 답변 항을 뺀 것입니다(spec D-RS2, D-RS4, deep-interview 편차 4).

```
floor = 0.10 × (해결되지 않은 반박 사실 수) + 0.05 × (확정 topology의 채점 안 된 활성 구성요소 수)
        → [0, 1]로 자르고 소수 둘째 자리로 반올림
```

- **해결되지 않은 반박 사실** (`isUnresolvedDisputedFact`, `:43-46`): `state.established_facts`의 객체 중 `disputed === true`이고 `superseded_by`가 비어 있지 않은 문자열이 아닌 것.
- **채점 안 된 활성 구성요소** (`countUnscoredActiveComponents`, `:52-65`): `state.topology.status === "confirmed"`일 때만 셉니다. `components` 중 `status`가 `"deferred"`가 아닌 객체에서 `clarity_scores.goal`, `constraints`, `criteria` 중 하나라도 유한한 수가 아니면 하나로 셉니다.
- 결과는 `state.ambiguity_floor = {floor, disputed_fact_count, unscored_active_component_count}`로 기록됩니다.

### 적용 (`applyAmbiguityFloorToEnvelope`, `ambiguity.ts:97-143`)

- 최신 채점 라운드(`scored`, 유한한 `round`, `round`가 가장 큰 것)의 `ambiguity`가 하한보다 작으면, 그 레코드를 `{…, reported_ambiguity: <원래 값, 이미 있으면 유지>, ambiguity: <하한>, ambiguity_floor: <하한>}`로 바꿉니다. 이전 라운드는 고치지 않습니다.
- `state.current_ambiguity`가 하한보다 작으면 하한으로 올립니다.
- 값은 `[0, 1]`로 자릅니다(`clampReportedAmbiguity`, `:82-89`).

`write`는 파생과 함께, `state` op는 병합 뒤 이 함수를 다시 부릅니다.

**예**: 반박 사실 하나가 있고 라운드 1의 `ambiguity`가 `0.03`이면 결과는 다음과 같습니다(기준치 0.05보다 높아 수렴하지 못함).

```json
{
  "round": 1, "round_key": "round-1", "lifecycle": "scored",
  "question_text": "q1", "answer": "a1",
  "ambiguity": 0.1,
  "scores": { "goal": 0.9, "constraints": 0.9, "criteria": 0.9 },
  "reported_ambiguity": 0.03,
  "ambiguity_floor": 0.1
}
```

`state.current_ambiguity`는 `0.1`, `state.ambiguity_floor`는 `{floor: 0.1, disputed_fact_count: 1, unscored_active_component_count: 0}`입니다. 그 사실을 `{id, disputed: false, superseded_by: "f2"}`로 대체하고 다음 라운드를 쓰면 하한은 0이 되고 모델의 값이 그대로 남습니다.

**모호도 계산 자체**(goal 0.40·constraints 0.30·criteria 0.30, brownfield는 0.35·0.25·0.25·0.15)는 SKILL Step 2c가 모델에게 시키는 것이고, 코드는 라운드의 `ambiguity`와 `scores`가 서로 맞는지 보지 않습니다.

## 9. 입력 상한

`envelope.ts:242-322`(spec D-SR11, 계획 DR-7). gjc의 같은 이름 함수들입니다.

| 대상 | 상한 | 세는 법 | 거부 문구 |
|---|---|---|---|
| `start`의 `idea`(trim 뒤) | 50,000 | NFC 정규화 뒤 코드 포인트 | `initial_idea exceeds max length 50000` |
| 봉투·`state`의 `initial_idea`, `initial_context`, `initial_context_summary` | 50,000 | 같음 | `state.<필드> exceeds max length 50000` (최상위면 `<필드> …`) |
| 봉투·`state`의 `user_response`, `answer` | 10,000 | 같음 | `state.<필드> exceeds max length 10000` |
| 각 `state.rounds[i]`의 `custom_input`, `customInput`, `user_response`, `answer`(문자열) | 10,000 | 같음 | `state.rounds[<i>].<필드> exceeds max length 10000` |
| `write`의 `input`(정리 뒤) | 100,000 | NFC 없이, 직렬화한 JSON의 코드 포인트 | `deep-interview write input exceeds max length 100000` |
| `state`의 `patch` | 100,000 | 같음 | `deep-interview state patch exceeds max length 100000` |
| `spec` 본문 | 100,000 | NFC 뒤 코드 포인트 | `spec content exceeds max length 100000` |

- NFC로 세므로 분해형 한글도 조합형과 같은 수로 셉니다(`canonicalizeText`).
- 직렬화 검사는 bigint, 함수, symbol, 유한하지 않은 수가 있으면 `<이름> is not a valid structured deep-interview response`로 거부합니다.
- prose 상한 검사(`assertEnvelopeInputLimits`)는 `write`에서 입력에 한 번, 결과 봉투에 한 번 돌고, `state`에서는 결과 봉투에 돕니다. 이 필드들의 값이 문자열이 아니면 `<이름> must be a string`입니다(라운드의 `answer`는 문자열이 아니면 건너뜀).
- 문자 종류는 보지 않습니다. 셸 메타문자가 든 prose도 받습니다(SKILL "Input safety").

## 10. StateStore 한도

모든 mode-state 쓰기는 `writeMerged`가 마지막에 검사합니다(`payloadError`, `src/state.ts:119-156`). deep-interview op는 같은 검사를 **첫 쓰기 전에** `assertStatePayload`(`src/state.ts:163-166`)로 먼저 합니다(계획 DR-31, deep-interview 편차 34). 그래서 한도에 걸린 op는 아무것도 쓰지 않고, 파일은 그대로입니다(K6).

| 한도 | 값 | 세는 법 | 문구 |
|---|---|---|---|
| 최상위 키 | 100 | `_meta`를 뺀 봉투의 최상위 키 | `state exceeds 100 top-level keys` |
| 깊이 | 10 | 봉투가 1단계, `state`가 2단계. 그래서 `state` 안의 값은 8단계까지 중첩할 수 있음 | `state exceeds nesting depth 10` |
| 크기 | 1,048,576 바이트 | `_meta`를 뺀 봉투의 `JSON.stringify` UTF-8 바이트 | `state exceeds 1048576 bytes` |
| 직렬화 | — | | `state is not JSON serializable` |

- 검사하는 곳: `start`, `write`, `spec`, `state`의 결과 봉투, 그리고 공통 인계가 저널을 시작하기 전에 callee·caller 두 병합 상태(`src/skill-state/handoff.ts:254-255`). `clear`는 따로 검사하지 않습니다(기존 필드를 그대로 두거나 다섯 필드만 씀).
- 한 번의 `write` 입력은 100,000자 상한에 먼저 걸리므로, 1 MiB는 긴 인터뷰가 라운드를 쌓아 갈 때 걸립니다.
- 같은 한도는 읽기에도 걸립니다. 손으로 고쳐 한도를 넘은 파일은 손상으로 읽힙니다.

## 11. 스펙 파일과 index

- **경로**: 루트 세션 폴더의 `specs/deep-interview-<slug>.md`(`specFileName`, `manifest.ts:300-302`). 상태에는 절대 경로로 기록됩니다.
- **slug**: 입력 `slug`(trim), 없으면 UTC `YYYY-MM-DD-HHMM-<4 hex>`(`defaultSpecSlug`, `manifest.ts:308-315`). 예: `2026-10-02-1006-6477`. `safeComponent` 규칙을 따릅니다.
- **본문**: 끝에 줄바꿈을 보장합니다. 같은 slug는 덮어씁니다.
- **index**: `specs/deep-interview-index.jsonl`(`SPEC_INDEX_FILE`, `manifest.ts:305`)에 `spec`마다 한 줄 덧붙입니다.
  ```
  {"slug":"demo","stage":"final","path":"<session>/specs/deep-interview-demo.md","created_at":"2026-10-02T10:06:02.189Z","sha256":"c3d6…925d"}
  ```
- **확인** (`verifySpecTx`, `store.ts:569-589`): 넘기기 전에 `spec_path`가 루트 세션 `specs/` 안에 있고, 읽히고, 내용의 sha256이 `spec_sha256`과 같은지 봅니다. 파일을 고치거나 지우면 넘기기가 거부됩니다. 다시 `spec`하면 됩니다.
- **지우지 않음**: `start`, `clear`, `reset`, 인계 모두 스펙 파일과 index를 지우지 않습니다.

## 12. 활성 행, 스냅숏, 순위

공통 코드 `src/skill-state/rows.ts`입니다.

### 활성 행

`state/active/deep-interview.json`(`rowEntry`, `rows.ts:104-119`):

```json
{
  "skill": "deep-interview",
  "phase": "handoff",
  "active": true,
  "activated_at": "2026-10-02T10:06:02.190Z",
  "updated_at": "2026-10-02T10:06:02.190Z",
  "session_id": "ses_root",
  "hud": { "version": 1, "chips": [ … ], "updated_at": "…" }
}
```

인계로 쓰인 행에는 `handoff_from` 또는 `handoff_to`와 `handoff_at`이 붙습니다. caller 쪽 행은 이전 행의 `handoff_from`을 이어받습니다(`writeHandoffRowsTx`, `rows.ts:170-184`).

| 언제 | 행 |
|---|---|
| `start`, `write`, `spec`, 활성 `state` | 씀(`syncActiveRowTx`, `rows.ts:149-162`). phase가 `complete`면(`state` op 제외) 지움 |
| 비활성으로 만드는 `state` | 지움 |
| `clear` | 지움 |
| `handoff`·결합 호출 ③·로드 게이트 넘기기 (caller) | **비활성** 행 `{active: false, phase: "handoff", handoff_to}`로 씀 |
| ralplan·ultragoal에서 넘겨받음 (callee) | 활성 행 `{phase: "interviewing", handoff_from}` |
| ralplan·ultragoal이 활성 행을 씀(`ralplan start`, 결합 호출 ②, `skill ultragoal` 시드, ultragoal reconcile 등) | 위쪽 파이프라인 행이라 지워짐(`state/remove-superseded-pipeline-entry`). deep-interview **상태는 그대로** (K1) |

### 스냅숏

`state/skill-active-state.json`은 행이 바뀔 때마다 행 파일들로 다시 만듭니다(`rebuildSnapshotTx`, `rows.ts:212-235`): `{version: 1, active, skill, phase, updated_at, session_id, active_skills: [모든 행], active_subskills: []}`. 맨 위 `skill`·`phase`는 비활성이 아닌 행 중 순위가 가장 높은 것입니다.

### 순위와 보이는 주 skill

- 파이프라인 순위는 `deep-interview`(0) → `ralplan`(1) → `ultragoal`(2)이고, 높은 쪽이 이깁니다(`PIPELINE_RANK`, `rows.ts:51-55`). 활성 행을 쓰면 낮은 순위 행을 지웁니다.
- 보이는 주 skill(`readVisiblePrimaryTx`, `rows.ts:246-292`)은 스냅숏 항목 위에 행 파일을 덮어(행이 이김) 활성 항목만 남기고, 잠긴 ralplan phase를 반영한 뒤, 파이프라인을 가장 높은 단계 하나로 줄여 고릅니다. 행 파일을 읽을 수 없으면 예외입니다.
- 그래서 deep-interview는 ralplan·ultragoal 행이 활성이 아닐 때만 보이는 주 skill이 됩니다. 편집 가드, continuation, 압축 문맥, `start` 거부가 이 값을 봅니다.

## 13. 감사 로그

`state/audit.jsonl`, 파일이 바뀔 때마다 한 줄(`appendAudit`, `src/skill-state/audit.ts:37-53`; 계획 C-7):

```json
{"ts":"…","skill":"deep-interview","category":"state","verb":"write-incremental","owner":"open-gajae-runtime","mutation_id":"deep-interview:write:2026-10-02T10:06:02.185Z","from_phase":"interviewing","to_phase":"interviewing","forced":false,"paths":["<session>/state/deep-interview-state.json"]}
```

- `owner`는 도구가 쓰면 `open-gajae-runtime`, 훅(로드 게이트)이 쓰면 `open-gajae-hook`입니다.
- 행·스냅숏·저널 행에는 `skill`이 없고, `mutation_id`는 무작위 uuid이거나 인계의 `mutation_id`입니다.
- deep-interview가 남기는 verb:

| 일 | `category/verb` | `mutation_id` |
|---|---|---|
| `start` | `state/write` | `deep-interview:start:<at>` |
| `write` | `state/write-incremental`, `state/write-reset` | `deep-interview:write:<at>` |
| `spec` | `artifact/write`(스펙), `ledger/append`(index), `state/write` | `deep-interview:spec:<at>` |
| `state` | `state/write` | `deep-interview:<at>` |
| `clear` | `state/clear` (`forced`) | `deep-interview:clear:<at>` |
| 인계 | `state/handoff`(callee, caller 순), 필요하면 그 앞에 `state/invalid_transition_detected` | `<caller>:handoff:<callee>:<at>` |
| 행·스냅숏 | `state/write-active-entry`, `state/remove-active-entry`, `state/remove-superseded-pipeline-entry`, `state/rebuild-active-snapshot` | uuid |
| 저널 | `state/write-transaction-journal`, `state/remove-transaction-journal` | 인계의 id |

`invalid_transition_detected`는 인계가 **활성**으로 쓰는 쪽(callee)의 phase가 바뀌고 그 이동이 그 skill의 전이 표에 없을 때만 남는 진단입니다(`src/skill-state/handoff.ts:171-189`). 예: 진행 중인 ralplan `architect` → `planner`. caller는 비활성으로 쓰이므로 남지 않습니다.

## 14. 인계 저널

`state/transactions/<인코딩한 mutation id>.json`(`src/skill-state/journal.ts`). 공통 인계가 시작할 때 `pending`으로 만들고, 단계마다 `steps`를 갱신하고, 끝에 `committed`로 바꾼 뒤 지웁니다.

```json
{"version":1,"mutation_id":"deep-interview:handoff:ralplan:…","status":"pending","created_at":"…","updated_at":"…","caller":"deep-interview","callee":"ralplan","paths":["…/ralplan-state.json","…/deep-interview-state.json","…/skill-active-state.json"],"steps":["callee-mode-state","caller-mode-state","active-state"]}
```

증거용입니다. 다시 실행하거나 되돌리는 코드가 없고, doctor도 읽지 않습니다(deep-interview 편차 21). 인계 도중 프로세스가 멈추면 `pending` 저널이 남습니다.

## 15. HUD 칩

활성 행의 `hud`(`src/deep-interview-runtime/hud.ts`, gjc `skill-state/workflow-hud.ts:83-186`). 상태가 바뀔 때마다, 인계의 양쪽 행에도 다시 계산합니다(계획 DR-17). **아무것도 그리지 않습니다**: TUI 플러그인이 없습니다(deep-interview 편차 23).

| 칩 | 우선순위 | 값 |
|---|---|---|
| `gate`, `blocked`, `next` | 5, 15, 25 | 공통 gate 칩. deep-interview는 값을 주지 않으므로 생기지 않음 |
| `phase` | 10 | 행의 phase |
| `ambiguity` | 20 | `<현재%>/<기준치%>`. 현재는 `state.current_ambiguity`, 없으면 배열에서 마지막 채점 라운드의 `ambiguity`. 기준치는 `state.threshold`, 없으면 최상위 `threshold`. 하나만 있으면 그 하나, 둘 다 없으면 칩 없음 |
| `round` | 30 | `state.rounds`의 길이(Round 0 포함) |
| `target` | 40 | `state.topology.last_targeted_component_id` |
| `weakest` | 50 | 대상 구성요소의 `weakest_dimension`, 없으면 처음 나오는 deferred 아닌 구성요소의 것, 없으면 아무 구성요소의 것 |
| `spec` | 60 | `spec` op가 행을 쓸 때만 `persisted` |

- 사실 추출(`deepInterviewHudFacts`, `hud.ts:101-132`)은 압축 문맥도 같이 씁니다. `state` 아래에 없는 필드는 최상위 값으로 대신합니다(gjc와 같음). 최상위 전사 필드는 `write`·`state`가 거부하므로 실제로 대신 쓰이는 것은 최상위 `threshold` 정도입니다.
- `topology.status`가 `legacy_missing`이면 `target`·`weakest`가 없습니다.
- 값은 백분율로 반올림합니다(`0.4` → `40%`).
- 칩은 저장 전에 정리됩니다(`normalizeWorkflowHudSummary`: 최대 6개, 글자 80자).
- `spec` 칩은 그다음 `write`나 인계로 행을 다시 쓰면 사라집니다.

예: Round 0과 라운드 1을 쓰고 topology를 확정한 뒤의 칩.

```json
[
  {"label":"phase","value":"interviewing","priority":10},
  {"label":"ambiguity","value":"40%/5%","priority":20},
  {"label":"round","value":"2","priority":30},
  {"label":"target","value":"cli","priority":40},
  {"label":"weakest","value":"goal","priority":50}
]
```

## 16. doctor

`collectDoctorSummaryTx(tx, "deep-interview")`(`src/skill-state/doctor.ts:149-279`, gjc `collectDoctorSummary`). deep-interview의 알려진 phase는 manifest 셋입니다(`DOCTOR_SKILLS`, `doctor.ts:57-61`; spec D-SR10).

| 검사 | 결과 종류 | 메시지 |
|---|---|---|
| 상태 JSON을 파싱할 수 없음 | `schema_violation` | `mode-state JSON is unreadable: <error>` |
| 봉투 형식(`workflowEnvelopeError`, `doctor.ts:64-79`) | `schema_violation` | 예: `state skill must match selected mode deep-interview`, `state.active must be a boolean when present` |
| `current_phase`가 문자열인데 manifest phase가 아님 | `schema_violation` | `unknown deep-interview phase "<phase>"` |
| deep-interview 행이 활성인데 상태가 없거나 활성이 아님 | `stale_active_state` | `active entry for deep-interview does not match a live active mode-state` |
| 활성 행의 phase가 상태 phase와 다름(상태가 형식 위반이 아닐 때) | `stale_active_state` | `active entry for deep-interview phase <a> differs from canonical mode-state phase <b>` |
| 스냅숏이 활성 deep-interview를 나열하는데 행 파일이 없음 | `stale_active_state` | `active snapshot lists deep-interview but no raw per-skill active entry exists` |
| 스냅숏 항목의 phase가 상태와 다름 | `stale_active_state` | `active snapshot for deep-interview phase <a> differs from canonical mode-state phase <b>` |

- 상태 phase 비교(`modeStatePhase`, `doctor.ts:109-119`)에서 비활성 상태의 phase는 ralplan 잠금 phase(`final`, `handoff`, `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`)일 때만 셉니다. gjc가 모든 skill에 ralplan의 `canonicalOverrides`를 쓰는 것과 같습니다.
- doctor는 파일을 `readRawJsonTx`로 직접 읽습니다. 그래서 JSON으로는 읽히지만 StateStore가 손상으로 보는 상태(한도 위반, 소유 세션 불일치)는 doctor에서 문제로 나오지 않을 수 있습니다.
- 고치는 명령은 `schema_violation`이면 `deep-interview clear (force: true)`, `stale_active_state`면 `deep-interview clear`입니다. 상태가 이미 `complete`면 `force`가 필요합니다(K9).
- checksum과 고아 저널은 검사하지 않습니다(deep-interview 편차 21).
