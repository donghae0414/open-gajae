# 가드, continuation, 압축 문맥, 도구 숨김

이 문서는 deep-interview 동안 훅이 **막거나 덧붙이는 일**을 코드 그대로 적습니다. 다루는 것은 스펙 경로 항상 차단, 편집 가드, continuation, 압축 문맥, 도구 숨김과 역할 권한입니다. 기준 코드는 [README.md](README.md) 머리에 있습니다.

판단 함수는 `src/deep-interview-runtime/hooks.ts`(`createDeepInterviewHooks`, `:85-191`)에 있고, 호스트 호출과 순서는 `src/hooks.ts`가 맡습니다. 같은 execution의 skill 로드 게이트와 체인 가드는 [entry-and-handoff.md](entry-and-handoff.md)에 있습니다.

## 한눈에 보기

| 장치 | 하는 일 | 누구에게 | 어디서 | 판단 실패 시 |
|---|---|---|---|---|
| 스펙 경로 항상 차단 | `specs/deep-interview-*`에 `write`/`edit`/`patch` 거부 | 모든 agent, 모든 세션 | `execute.before` A | 막음 (fail closed) |
| state 트리 항상 차단 | `state/**`(deep-interview 상태 포함)에 `write`/`edit`/`patch` 거부 | 같음 | `execute.before` A | 막음 |
| 편집 가드 | deep-interview가 보이는 주 skill, 활성, `interviewing`·`handoff`이면 OS 임시 경로 밖 `write`/`edit`/`patch` 거부 | 계보의 모든 agent | `execute.before` B | 통과 (fail open) |
| continuation | `interviewing`이면 사용자 프롬프트마다 2번 이어 하라고 주입. `handoff`나 횟수 소진이면 goal·ralplan continuation도 멈춤 | 계보 루트 | `session.execution.succeeded` | goal 경로로 넘어감 |
| 압축 문맥 | `<deep-interview-compaction-context>` 추가 | 계보 루트 | `compaction` 세션 훅 | 아무것도 넣지 않음 |
| 도구 숨김 | `deep-interview` 도구를 `open-gajae`가 아닌 agent의 요청에서 지움 | 그 밖의 모든 agent | `context`·`compaction`·`generate` | — |
| 도구의 호출자 검사 | `open-gajae`가 아니면 거부 | 같음 | 도구 `execute` | 막음 |
| 역할 권한 | 모든 역할 subagent에 `deep-interview` 거부 | 역할 subagent 8개 | 호스트 권한(`roleRules`) | — |

## `execute.before`의 순서와 차단 방식

`src/hooks.ts:1003-1094`의 `executeBefore`가 차례로 봅니다.

```
A  산출물 가드 (guardSessionArtifacts)          걸리면 막고 끝 (실패하면 막음)
B  편집 가드 (guardPlanning)                    걸리면 막고 끝 (실패하면 통과)
C  tool == "subagent" → ultragoal red-team 조각, 끝
D  tool == "skill"   → ultragoal 게이트 / 체인 가드 / deep-interview 로드 게이트, 턴 표식
```

막는 방식은 예외가 아니라 입력을 비우는 것입니다. `blocked`에 문구를 적고 `event.input = {}`로 바꾸면 호스트의 입력 해석이 실패하고, `execute.after`(`src/hooks.ts:1102-1119`)가 그 호출의 오류를 적어 둔 문구로 바꿉니다. 모델은 도구 오류로 그 문구를 봅니다(Promise 훅의 예외는 호스트에서 결함이 되기 때문, `src/hooks.ts:1004-1009` 주석).

## 항상 차단: 스펙 경로와 state 트리

계획 DR-24, deep-interview 편차 35. gjc는 `.gjc/**` 전체를 막는 규칙만 있고 deep-interview 스펙을 따로 다루지 않습니다.

### 검사하는 도구와 경로

`src/artifact-guard.ts`:

- `ARTIFACT_TOOLS`(`:16`): `write`, `edit`, `patch`.
- `artifactPathsOf`(`:46`): `write`·`edit`는 `input.path`, `patch`는 `patchText`의 `*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:` 경로. 그 밖의 도구(`read`, `shell` 등)는 검사하지 않습니다.
- 경로는 호스트의 `location.directory` 기준으로 풀고 프로젝트 상대 경로로 바꿉니다(`projectRelative`, `:74`). 프로젝트 밖이면 이 가드는 판단하지 않습니다.

### 판정 순서와 문구

`src/hooks.ts:689-724`의 `guardSessionArtifacts`가 경로마다 차례로 보고, 처음 걸린 것에서 멈춥니다.

| 순서 | 조건 | 문구 |
|---|---|---|
| 1 | ultragoal 파일(`isUltragoalOwned`) | `open-gajae: <경로> is ultragoal-owned; change it only through the ultragoal tool` |
| 2 | deep-interview 스펙: `^\.open-gajae\/_session-[^/]+\/specs\/deep-interview-[^/]+$` (`isDeepInterviewOwned`, `src/artifact-guard.ts:159-168`) | `` open-gajae: <경로> is deep-interview-owned; write specs only through `deep-interview spec` `` (`specGuardRefusal`, `messages.ts:27-29`) |
| 3 | ralplan run 폴더나 세션 `state/` 트리 | `open-gajae: <경로>: ` + `WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE` (아래) |
| 4 | 다른 세션의 `plans/`·`drafts/` | 다른 세션 안내 |

`WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE`(`src/hooks.ts:326-327`) 전문:

```
.open-gajae workflow state and ralplan artifacts are runtime-owned. Agent mutation tools cannot edit `.open-gajae/_session-*/state/**` or `.open-gajae/_session-*/plans/ralplan/**`; use the sanctioned tool instead.
Use: `ralplan` for ralplan state and plans, `ultragoal` for ultragoal state, `goal` for the goal, `deep-interview` for deep-interview state and specs.
```

### deep-interview와 관련된 경로

| 경로(프로젝트 상대) | 결과 |
|---|---|
| `.open-gajae/_session-X/specs/deep-interview-x.md` | 2 (테스트 H7) |
| `.open-gajae/_session-X/specs/deep-interview-index.jsonl` | 2 (정규식에서 이끌어 냄) |
| `.open-gajae/_session-X/specs/notes.md` | 막지 않음 (테스트 H7). 다른 `specs/` 문서는 대상이 아님 |
| `.open-gajae/_session-X/state/deep-interview-state.json`, `state/active/deep-interview.json`, `state/skill-active-state.json`, `state/audit.jsonl`, `state/transactions/…` | 3 (정규식에서 이끌어 냄) |

모든 agent와 모든 세션에 늘 적용됩니다. 다른 세션의 스펙도 막습니다. 판단 중 예외가 나면, 경로가 하나라도 있는 호출은 막습니다(`src/hooks.ts:1021-1028`).

### 막지 않는 것

- `shell`로 하는 변경. 명령을 해석하지 않습니다. SKILL(DIPP-8)과 역할 프롬프트가 글로만 금지합니다.
- 대소문자가 다른 경로. 정규식이 대소문자를 구분합니다(ultragoal known-limits U4와 같은 성격).
- 여러 OpenCode 프로세스 사이의 동시 쓰기.

## 편집 가드

인터뷰 동안 제품 파일을 고치지 못하게 합니다. 계획 DR-19(spec D-HL4, PQ-10 B), gjc `skill-state/workflow-mutation-guard.ts:22-23,264-268`(`DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE`, release phase가 아니면 막음).

### 조건

`src/hooks.ts:742-782`의 `guardPlanning`이 `write`/`edit`/`patch`일 때만 돕니다.

```
1. 호출 세션의 계보 루트를 구함
2. 루트의 트랜잭션 하나에서 보이는 주 skill을 읽음
3. 주 skill이 deep-interview면 guardMessageTx (src/deep-interview-runtime/hooks.ts:94-99):
     상태가 유효하고 active == true이고 current_phase(trim)가 interviewing·handoff이면 막음
   (주 skill이 ralplan·ultragoal이면 각자의 계획 가드가 판단)
4. 막기로 했으면 대상 경로를 봄:
     경로가 하나도 없으면 막음 (gjc가 모르는 대상을 막는 것과 같음)
     모든 경로가 중립 임시 경로(isNeutralTempPath)면 통과, 하나라도 아니면 막음
```

- **중립 임시 경로**: `src/ralplan-runtime/temp-paths.ts`의 `isNeutralTempPath`. 임시 루트(`os.tmpdir()`, `$TMPDIR`, `/tmp`, `/var/tmp`, `/private/tmp`, `/private/var/tmp`) 아래이면서 프로젝트 밖인 경로입니다. 심볼릭 링크와 macOS `/tmp` 별칭을 풀어서도 다시 확인합니다. SKILL은 큰 스펙을 이런 곳에 써서 `spec(path)`로 넘기라고 합니다.
- **누구에게**: 계보의 모든 agent입니다. 루트의 `open-gajae`뿐 아니라 그 아래 subagent(예: `open-gajae-executor`)의 쓰기도 막습니다(테스트 H1이 자식 세션을 확인).
- **주 skill을 따름**: ralplan이나 ultragoal 행이 활성이면 그쪽이 보이는 주 skill이므로 deep-interview 분기는 돌지 않습니다(테스트 H1). 예: K1처럼 deep-interview 상태는 활성인데 ralplan을 시작해 deep-interview 행이 지워진 경우.
- **phase `handoff`에서도 막음**: 스펙을 쓴 뒤 "더 다듬기" 동안에도 막습니다(spec Errata E1, K2). 비활성 인터뷰, `complete`, 손상된 상태는 막지 않습니다.

### 문구

`DEEP_INTERVIEW_MUTATION_BLOCK_MESSAGE`(`messages.ts:23-24`). gjc 문구에서 명령 이름을 `deep-interview spec`으로 바꾸고, ralplan처럼 복구 줄을 더했습니다.

```
Deep-interview phase boundary: continue gathering context/questions/risks and emit a handoff/spec before code edits. Mutation tools and patch execution are blocked while deep-interview is active; finalize specs through `deep-interview spec` or hand off to an execution phase.
If this deep-interview is stale or was started by mistake, end it with `deep-interview clear`.
```

### 실패 처리 (fail open)

계보 조회 실패, 행 파일을 읽을 수 없음(`readVisiblePrimaryTx`가 던짐) 같은 예외는 로그만 남기고 호출을 통과시킵니다(`src/hooks.ts:778-781`). 산출물 가드와 반대입니다. deep-interview 상태가 없거나 손상이어도 막지 않습니다.

### 막지 않는 것

- `shell`. 파일을 바꾸는 명령도 분류하지 않습니다(deep-interview 편차 14, ralplan 편차 11과 같음). SKILL Execution_Policy가 "do not implement, edit/write code"로 글로만 금지합니다.
- `subagent`로 구현을 맡기는 것 자체. 맡은 subagent의 `write`/`edit`/`patch`는 위 조건으로 막힙니다.

## continuation

인터뷰 도중 모델이 턴을 끝내면 이어서 질문하라고 다시 밀어 줍니다. 계획 DR-20(spec D-HL5, Errata E2), gjc `session/agent-session.ts:21137-21211`(`#checkActiveDeepInterviewCompletion`: `interviewing`이면 사용자 의도마다 두 번, 다른 deep-interview 정지 사유는 goal·todo continuation을 건너뜀 `:8138-8157`).

### 트리거

`src/hooks.ts:1240-1289`의 `onEvent`가 `session.execution.succeeded`를 받고, 이 플러그인 위치의 세션이며 부모가 없을 때(계보 루트) `continueSession`(`src/hooks.ts:536-597`)을 부릅니다. `failed`는 이어 가지 않습니다.

### 순서

```
1. 같은 세션의 continuation이 이미 진행 중이면 끝
2. Esc 표식(interrupted, reason user·shutdown)이 있으면 끝 — 다음 실제 사용자 프롬프트까지
3. 자식 execution이 돌고 있으면 끝 — 자식이 끝나 부모가 다시 succeeded하면 그때 판단
4. deep-interview 판단 (decideContinuation)
     continue → <deep-interview-continuation> 주입하고 끝
     hold     → 아무것도 하지 않고 끝 (goal·ralplan도 건너뜀)
     none     → 다음으로
     예외     → 로그를 남기고 none처럼 다음으로
5. goal 판단 (활성 goal이 있으면 goal 경로만)
6. ralplan 판단
```

deep-interview가 goal보다 먼저입니다. "활성 goal은 goal 경로만 탄다"(ultragoal 계획 D-TL6)의 예외입니다(deep-interview 편차 16).

### 판단 (`decideContinuation`, `src/deep-interview-runtime/hooks.ts:106-117`)

루트의 트랜잭션 하나에서:

1. `guardedPhaseTx`(`:76-83`): 보이는 주 skill이 deep-interview이고, 상태가 유효하고 `active: true`이며, phase가 `interviewing`·`handoff`인지 봅니다. 아니면 `none`.
2. phase가 `handoff`면 `hold`.
3. 이번 사용자 프롬프트 뒤 보낸 횟수가 2(`DEEP_INTERVIEW_CONTINUATION_MAX`, `:52`) 이상이면 `hold`.
4. 아니면 횟수를 하나 올리고 `continue`.

횟수는 메모리의 `Map<루트, 횟수>`(`:87`)입니다. 파일에 남지 않으므로 OpenCode를 다시 띄우면 0부터입니다(gjc는 런타임이 셈).

### 횟수 초기화

계보 루트 세션에 실제 사용자 프롬프트가 들어오면 `resetContinuation`(`:120-122`)이 0으로 돌립니다(`src/hooks.ts:891-893`). 역할 subagent 세션, 주입 표식이 든 프롬프트, 루트가 아닌 세션은 돌리지 않습니다. agent는 보지 않습니다.

### 주입 문구

`continuationMessage(count)`(`messages.ts:63-73`). gjc 알림을 `<deep-interview-continuation>`으로 감싸고 `ask` → `question`, 기록 명령 → `deep-interview write`로 바꿨습니다.

```
<deep-interview-continuation>

You stopped while the deep-interview workflow is still active (phase interviewing).
Continue the active round immediately: score and persist the answered round with `deep-interview write`, report progress, then use the `question` tool for the next question.
Only stop after crystallizing the spec, recording a handoff, or explicitly cancelling the workflow.
(Continuation 1/2 for this prompt)

</deep-interview-continuation>

---
```

`session.synthetic({resume: true})`로 넣고(`inject`, `src/hooks.ts:430-442`), TUI 설명은 `open-gajae: deep-interview continuation 1/2`입니다(`continuationDescription`, `messages.ts:76-78`). `synthetic`이 실패하면 로그만 남깁니다.

### 결과 정리

| 상황 | deep-interview | goal continuation | ralplan continuation |
|---|---|---|---|
| deep-interview가 주 skill, 활성 `interviewing`, 이번 프롬프트에서 0~1번 보냄 | 주입 | 없음 | 없음 |
| 같은데 2번 다 씀 | 없음 (hold) | 없음 | 없음 |
| 활성 `handoff` (스펙 뒤 "더 다듬기"·Phase 5 대기) | 없음 (hold) | 없음 | 없음 |
| 비활성, `complete`, 상태 없음·손상, 다른 skill이 주 skill | 없음 (none) | 평소대로 | 평소대로 |
| 판단 중 예외(예: 행 파일 손상) | 없음 | 평소대로 | 평소대로 |
| Esc 뒤, 자식 execution 실행 중 | 없음 | 없음 | 없음 |

테스트 H2가 위의 주요 경우를 확인합니다.

### 같이 알아둘 것

- **agent를 보지 않습니다.** 세션의 agent를 다른 것으로 바꿔도 `interviewing`이면 continuation이 들어갑니다(goal continuation과 같음). 그 agent에게는 `deep-interview` 도구가 숨겨져 있어 `write`할 수 없습니다.
- **패널을 background로 돌리지 말 것**: 자식 execution이 도는 동안은 continuation이 없으므로, SKILL Phase 3은 패널을 background로 돌리지 말라고 합니다([panel.md](panel.md)).
- **`handoff`에서는 continuation이 없습니다** (K2). Phase 5에서 사용자 선택을 기다리는 동안 다시 밀지 않기 위함이고, "더 다듬기" 동안에도 마찬가지입니다.
- **goal 문맥 주입은 계속됩니다** (K5). `context` 훅의 goal 문맥(`src/hooks.ts:1143-1177`)은 deep-interview를 보지 않습니다. hold가 멈추는 것은 goal **continuation**뿐입니다.

## 압축 문맥

대화가 압축된 뒤 인터뷰를 이어 갈 수 있게 상태 요약을 시스템 프롬프트에 넣습니다. 호스트 추가 기능입니다(계획 DR-22, deep-interview 편차 15). gjc에는 없습니다.

### 순서

`src/hooks.ts:1191-1238`의 `compaction` 훅이 셋을 차례로 넣습니다. 앞의 것이 실패해도 뒤의 것은 돕니다.

1. ultragoal 복구 문맥 (루트 세션일 때)
2. deep-interview 문맥 (루트 세션일 때, `:1200-1207`)
3. ralplan 복구 계약

### 조건과 내용 (`compactionText`, `src/deep-interview-runtime/hooks.ts:172-188`)

- 조건은 continuation과 같은 `guardedPhaseTx`입니다: deep-interview가 보이는 주 skill이고, 활성이며, phase가 `interviewing`·`handoff`.
- 내용은 `compactionMessage`(`messages.ts:95-108`)가 만듭니다. 값은 HUD와 같은 `deepInterviewHudFacts`에서 옵니다([state-and-files.md](state-and-files.md)).

```
<deep-interview-compaction-context>

deep-interview is active (phase interviewing).
rounds: 2
ambiguity: 40% (threshold 5%)
target: cli
weakest: goal
Read the full state with `deep-interview status`; ask the next question with `question`, one at a time.

</deep-interview-compaction-context>

---
```

- `rounds`는 `state.rounds`의 길이(Round 0 포함)입니다.
- 모호도나 기준치가 없으면 `unknown`으로 적습니다. 기준치 없이 `reset`한 경우가 그렇습니다(K17).
- `target`, `weakest`, `spec: <spec_path>` 줄은 값이 있을 때만 넣습니다.
- 넘겨받아 `state`가 없는 파일도 읽기 경계 덕분에 `rounds: 0`으로 나옵니다(테스트 H4).
- 판단 중 예외(예: 행 파일 손상)는 로그만 남기고 아무것도 넣지 않습니다.

## 도구 숨김과 역할 권한

### 도구 숨김

`src/hooks.ts:288-298`의 `TOOL_OWNERS`에서 `deep-interview`의 주인은 `open-gajae` 하나입니다(계획 DR-23, deep-interview 편차 24). `hideTools`(`src/hooks.ts:1126-1132`)는 요청의 agent가 주인이 아니면(agent가 없어도) 요청의 `tools`에서 그 도구를 지웁니다. `context`, `compaction`, `generate` 세 세션 훅에 걸려 있습니다(`src/index.ts:74-76`).

| 요청의 agent | 남는 workflow 도구 |
|---|---|
| `open-gajae` | `deep-interview`, `goal`, `ralplan`, `ultragoal` |
| `open-gajae-planner`, `-architect`, `-critic` | `ralplan` |
| `open-gajae-executor`, `-cleaner`, `-explore`, `-document-specialist`, `-lateral-reviewer`, `build`, `general`, `plan`, 사용자 정의 agent, agent 없음 | 없음 |

(테스트 `(K2, H5)`, `tests/hooks.test.ts:1686-1705`. explore와 document-specialist는 테스트 목록에 없고 `TOOL_OWNERS`에서 이끌어 냈습니다.)

숨김을 빠져나와도 도구가 스스로 `the deep-interview tool is not available to <agent>`로 거부합니다([ops.md](ops.md)).

### 역할 권한 규칙

`src/config.ts:274-328`의 `roleRules`. 모든 역할이 공통 묶음 `readonlyDenies`(`:261-266`: `question`, `deep-interview`, `opencode_session_move`, `opencode_session_rename`)를 가집니다. `deep-interview` 거부가 옛 상태 도구 3개(`state_*`)의 쓰기·지우기 거부를 대신합니다(계획 I-17).

| agent | 거부 |
|---|---|
| `open-gajae` | 없음 |
| `open-gajae-architect`, `-critic` | `edit`, `subagent`, `readonlyDenies`, `ultragoal`, `goal` |
| `open-gajae-executor` | `subagent`(explore·architect만 허용), `readonlyDenies`, `ultragoal`, `goal`, `ralplan` |
| `open-gajae-planner` | `edit`, `subagent`(explore·document-specialist만 허용), `readonlyDenies`, `ultragoal`, `goal` |
| `open-gajae-explore`, `-document-specialist`, `-cleaner`, `-lateral-reviewer` | `edit`, `subagent`, `readonlyDenies`, `ultragoal`, `goal`, `ralplan` |

`shell` 규칙은 없습니다. `edit` 권한은 호스트의 `write`·`edit`·`patch`가 함께 씁니다. 사용자 설정 `agents.<id>`의 규칙이 플러그인 규칙 뒤에 붙어 이깁니다(`src/config.ts:268-273` 주석).

그래서 역할 agent에게는 세 겹이 있습니다: 역할 권한(사용자 설정이 풀 수 있음), 도구 숨김(설정과 상관없이), 도구 자신의 호출자 검사. `build`처럼 이 플러그인이 만들지 않은 agent에게는 첫 겹이 없고 뒤의 둘이 막습니다.

## 코드가 강제하는 것과 SKILL만 요구하는 것

| 규칙 | 코드 | SKILL만 |
|---|---|---|
| 인터뷰 중 제품 파일 `write`/`edit`/`patch` 금지 | 예(주 skill이고 활성 `interviewing`·`handoff`일 때) | |
| 인터뷰 중 `shell`로 파일 변경 금지 | | 예 |
| 구현 subagent를 띄우지 않음 | 쓰기만 막힘 | 예 |
| `.open-gajae/` 직접 편집 금지 | 예(`state/**`, 스펙 파일) | 다른 `specs/` 문서는 SKILL만 |
| 평범한 라운드 뒤 "계속할까요?"를 묻지 않음 | | 예 (Step 2f) |
| 멈춘 인터뷰를 이어 감 | 예(사용자 프롬프트마다 2번) | |
| 압축 뒤 `status`로 전체 상태를 다시 읽음 | 압축 문맥이 안내 | 예 |
