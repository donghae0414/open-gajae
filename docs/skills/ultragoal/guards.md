# 가드, 도구 숨김, 역할 권한, red-team 조각

이 문서는 ultragoal 실행 중에 **누가 무엇을 못 하게 막는 장치**를 코드 그대로 적습니다. 다루는 것은 `execute.before` 훅의 산출물 가드와 `goal-planning` 편집 가드, `context` 훅의 도구 숨김, `src/config.ts`의 역할 권한 규칙(`roleRules`), `[ultragoal-red-team]` 표식이 붙이는 executor red-team 조각, cleaner 역할, 그리고 ultragoal이 쓰는 범위의 architect·critic 프롬프트입니다.

다른 주제는 해당 문서에 있습니다. 진입과 인계, 체인 가드(`skill ralplan`·`skill deep-interview` 거부), `goal-planning`이 시작되고 끝나는 길은 [entry-and-handoff.md](entry-and-handoff.md), cohort lane과 gate가 lane 결과를 어떻게 검사하는지는 [gates-and-receipts.md](gates-and-receipts.md), 세션 폴더 구성과 활성 행은 [state-and-files.md](state-and-files.md), 알려진 한계는 [known-limits.md](known-limits.md)를 보세요. 전체 지도는 [README.md](README.md)에 있습니다.

## 한눈에 보기

| 장치 | 무엇을 막나 | 누구에게 | 어디서 | 판단 실패 시 |
|---|---|---|---|---|
| 산출물 가드 | `.open-gajae/` 아래 ultragoal 파일, `state/**`, `plans/ralplan/**`, 남의 세션 plans·drafts에 `write`/`edit`/`patch` | 모든 agent, 모든 세션 | `execute.before` A | 막음 (fail closed) |
| `goal-planning` 편집 가드 | ultragoal이 `goal-planning`인 동안 OS 임시 경로 밖 `write`/`edit`/`patch` | 계보 전체의 모든 agent | `execute.before` B | 통과 (fail open) |
| 체인 가드 | ultragoal이 주 skill인 동안 `skill ralplan`·`skill deep-interview` | 모든 agent | `execute.before` D | 통과 |
| 도구 숨김 | `ultragoal`·`goal`·`ralplan`·`deep-interview` 도구를 주인 아닌 agent의 요청에서 지움 | 주인 아닌 모든 agent | `context`·`compaction`·`generate` | — |
| 도구의 호출자 검사 | 주인 아닌 agent의 호출 거부 | 같음 | 각 도구의 `execute` | 막음 |
| 역할 권한 규칙 | 역할마다 `edit`, `subagent`, `question`, workflow 도구(`deep-interview` 포함) 거부 | 역할 subagent 여덟 | 호스트 권한(`roleRules`) | — |
| red-team 조각 | (막는 장치가 아니라 붙이는 장치) 표식 있는 executor 과제에 조각 추가 | `open-gajae-executor` 과제 | `execute.before` C | — |

체인 가드는 [entry-and-handoff.md](entry-and-handoff.md)에 있습니다. 여기서는 순서만 표시합니다.

## `execute.before`의 차단 방식

`src/index.ts`가 `ctx.tool.hook("execute.before", hooks.executeBefore)`와 `ctx.tool.hook("execute.after", hooks.executeAfter)`를 등록합니다. 몸체는 `src/hooks.ts`의 `executeBefore`, `executeAfter`입니다. `executeBefore` 주석에 따르면 호스트의 도구 입력 복구가 이 훅보다 먼저 돌기 때문에, 문자열로 온 JSON 입력은 이미 풀린 상태로 들어옵니다(주석 기준, 호스트 소스로 확인하지 않음).

검사 순서:

```
A  산출물 가드 (guardSessionArtifacts)             걸리면 차단하고 끝
B  goal-planning·ralplan 계획 가드 (guardPlanning)  걸리면 차단하고 끝
C  tool == "subagent" → red-team 조각 붙이기, 끝
D  tool == "skill" → 진입 게이트(ultragoal) 또는 체인 가드(ralplan·deep-interview), 턴 표식
```

차단은 예외를 던지지 않고 **입력을 무효로 만드는** 방식입니다. 호스트에서 Promise 훅의 예외는 결함으로 처리되기 때문입니다(`executeBefore` 주석).

```
execute.before: blocked.set(call id, 문구); event.input = {}
      ↓ 호스트가 {}를 입력 스키마로 해석하다 실패 → Tool.Error, status "error"   (주석 기준, Phase 0 P3)
execute.after : 이 call id에 기록된 문구가 있고 status가 "error"면
                event.error = new ToolError({ message: 문구 })
      ↓ 모델은 도구 오류로 그 문구를 봅니다.
```

기록된 문구가 없는 실패(예: 호스트 권한 차단)는 `execute.after`가 건드리지 않습니다. `execute.after`는 실패한 `skill` 호출이 세운 턴 표식도 되돌립니다([entry-and-handoff.md](entry-and-handoff.md)).

## 산출물 가드

gjc 출처: `skill-state/workflow-mutation-guard.ts:1683-1690`(`.gjc/**` 대상 변경 도구를 막는 규칙, `src/artifact-guard.ts` 헤더), 차단 문구는 같은 파일 `:24-25`의 `WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE`(첫 문장)에 호스트 경로와 도구를 넣고, gjc가 거부할 때 덧붙이는 `\nUse: ${command}` 줄(`:1790,1812`)을 도구 목록으로 바꿔 붙인 것입니다(`src/hooks.ts`). 결정: plan S3 ①, AC18, AC21.

### 검사하는 도구와 경로

`src/artifact-guard.ts`:

- `ARTIFACT_TOOLS`: `write`, `edit`, `patch`. v2에서 파일을 만들거나 바꾸거나 옮기거나 지우는 도구입니다.
- `artifactPathsOf(tool, input)`: `write`·`edit`는 `input.path` 하나, `patch`는 `input.patchText`의 각 줄을 다듬은 뒤 `*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:` 뒤의 경로를 모두 모읍니다. 그 밖의 도구는 빈 목록이라 검사하지 않습니다(`read`, `shell` 등).
- `projectRelative(locationDir, projectDir, p)`: 경로를 호스트의 `location.directory` 기준으로 풀고, 프로젝트 디렉터리 기준 POSIX 상대 경로로 바꿉니다. 프로젝트 밖이면 `undefined`이고, 그런 경로는 이 가드가 판단하지 않습니다.

### 판정 순서와 문구

`src/hooks.ts`의 `guardSessionArtifacts`가 경로마다 차례로 봅니다. 첫 번째로 걸린 것에서 멈춥니다. `<경로>`는 프로젝트 상대 경로(없으면 받은 그대로)입니다.

| 순서 | 조건 (정규식은 프로젝트 상대 경로에 적용) | 문구 |
|---|---|---|
| 1 | ultragoal 소유: `^\.open-gajae\/_session-[^/]+\/(?:ultragoal(?:\/\|$)\|state\/ultragoal-state\.json$)` (`isUltragoalOwned`) | `open-gajae: <경로> is ultragoal-owned; change it only through the ultragoal tool` |
| 2 | ralplan run 폴더 `^\.open-gajae\/_session-[^/]+\/plans\/ralplan(?:\/\|$)` (`isRalplanOwned`) 또는 세션 state 트리 `^\.open-gajae\/_session-[^/]+\/state(?:\/\|$)` (`isSessionState`) | `open-gajae: <경로>: ` 뒤에 아래 `WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE` |
| 3 | 세션 plans·drafts `^\.open-gajae\/(_session-[^/]+)\/(?:plans\|drafts)\/` 인데 폴더가 호출자 계보 루트의 폴더가 아님 | `open-gajae: <경로> belongs to another session's plans/drafts. <tool> may only write under this session's plans/ or drafts/ (<접두>.open-gajae/<내 폴더>/plans\|drafts/)` |
| 3′ | 3의 경로인데 호출자의 세션 폴더를 구하지 못함(`ownFolder`: 계보 루트 조회 실패, 또는 `resolveSessionDir` 실패. 예: 같은 세션 id로 끝나는 폴더가 둘 이상인 `ambiguous session directories for …`) | `open-gajae: could not resolve the session lineage for <sessionID>; refusing to write a session artifact. <tool> may only write under this session's plans/ or drafts/ (<접두>.open-gajae/_session-*/plans\|drafts/)` |

`WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE` 전문:

```
.open-gajae workflow state and ralplan artifacts are runtime-owned. Agent mutation tools cannot edit `.open-gajae/_session-*/state/**` or `.open-gajae/_session-*/plans/ralplan/**`; use the sanctioned tool instead.
Use: `ralplan` for ralplan state and plans, `ultragoal` for ultragoal state, `goal` for the goal, `deep-interview` for deep-interview state and specs.
```

`<접두>`는 `projectPrefix(locationDir, projectDir)`입니다. 호스트 위치에서 프로젝트 디렉터리까지의 상대 경로에 `/`를 붙인 값이고, 둘이 같으면 빈 문자열입니다.

1~2는 **모든 agent, 모든 세션**에 대해 항상 막습니다. 다른 세션의 ultragoal 폴더도 마찬가지입니다. 3은 plans·drafts를 자기 계보 루트의 폴더에만 쓰게 합니다.

### ultragoal과 관련된 경로

| 경로(프로젝트 상대) | 결과 |
|---|---|
| `.open-gajae/_session-X/ultragoal/goals.json`, `ledger.jsonl`, `progress.txt` | 1 (ultragoal 소유) |
| `.open-gajae/_session-X/ultragoal` (폴더 자체) | 1 |
| `.open-gajae/_session-X/state/ultragoal-state.json` | 1 (state 트리보다 먼저 걸림) |
| `.open-gajae/_session-X/state/goal-state.json`, `goal-continuation.json` | 2 (state 트리) |
| `.open-gajae/_session-X/state/active/ultragoal.json`, `skill-active-state.json`, `audit.jsonl`, `transactions/…` | 2 |
| `.open-gajae/_session-X/plans/ultragoal.md` | 1·2가 아님. 3의 규칙(자기 세션이면 허용) |
| `.open-gajae/_session-X/specs/spec.md`, `.open-gajae/open-gajae.jsonc` | 이 가드는 허용 |
| `src/ultragoal.ts` | 이 가드는 허용 |
| 하위 디렉터리에서 연 호스트가 `.open-gajae/_session-X/state/…`를 상대 경로로 씀 | 하위 디렉터리 기준으로 풀려 프로젝트의 `.open-gajae`가 아니므로 해당 없음 |

(`goals.json`, `progress.txt`, 폴더 자체, `state/ultragoal-state.json`, `plans/ultragoal.md`, `specs/spec.md`, `src/ultragoal.ts`, 하위 디렉터리 줄은 `tests/artifact-guard.test.ts`의 표에 있고, `.open-gajae/open-gajae.jsonc`는 `tests/hooks.test.ts` (m)에 있습니다. `ledger.jsonl`, `goal-state.json`, `goal-continuation.json`, `active/ultragoal.json`, `skill-active-state.json`, `audit.jsonl`, `transactions/…` 줄은 테스트가 없고 `ULTRAGOAL_OWNED`·`SESSION_STATE` 정규식에서 이끌어 낸 것입니다.)

### 실패 처리 (fail closed)

- 대상이 세션 plans·drafts(3의 경로)일 때만 호출자의 세션 폴더를 구합니다(`ownFolder`). 여기서 계보 루트 조회나 `resolveSessionDir`가 실패하면 3′ 문구로 막습니다. 1·2의 경로는 폴더를 구하지 않고 정규식만으로 막고, 그 밖의 경로는 이 단계까지 오지 않습니다.
- `guardSessionArtifacts` 자체가 예외를 던지면, 그 호출에 경로가 하나라도 있으면 `<tool> may only write under this session's plans/ or drafts/ (<접두>.open-gajae/_session-*/plans|drafts/)` 문구로 막습니다.

### 이 가드가 막지 않는 것

- `shell`로 하는 변경. 명령을 해석하지 않습니다(ralplan 편차 11과 같은 성격). ultragoal SKILL("do not change them through `shell` either"), executor·cleaner·architect·critic 프롬프트가 글로만 금지합니다.
- 대소문자가 다른 경로. 정규식에 `i` 플래그가 없어 대소문자를 구분합니다. 대소문자를 구분하지 않는 파일 시스템에서는 `.OPEN-GAJAE/…`가 빠져나갑니다([known-limits.md](known-limits.md) U4).
- 여러 OpenCode 프로세스 사이의 동시 쓰기([known-limits.md](known-limits.md) U31).

## `goal-planning` 편집 가드

gjc 출처: `skill-state/workflow-mutation-guard.ts:28-29,274`(`ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE`, `getActivePlanningSkill`, `isBlockingPlanningPhase`, `planningBlockedTargets`). 결정: D-HE5, DR-22, PQ-13 A. 계보 전체 적용은 ralplan 편차 23, `shell` 미분류는 ralplan 편차 11.

### 조건

`src/hooks.ts`의 `guardPlanning`. 도구가 `write`/`edit`/`patch`일 때만 돕니다.

```
1. 호출 세션의 계보 루트를 구함
2. 계보 루트의 workflowTransaction 안에서 보이는 주 skill(활성 행)을 읽음
3. 주 skill이 "ralplan"      → ralplan 계획 가드(아래 "주 skill을 따른다")
   주 skill이 "ultragoal"   → ultragoal state를 읽어
                              active == true 이고 current_phase(trim, 소문자) == "goal-planning"이면 막음
   그 밖                     → 통과
4. 막을 상황이면 대상 경로를 봄
     경로가 하나도 없음          → 막음 (대상을 모르면 막는 gjc 규칙)
     경로 중 하나라도 중립 임시 경로가 아님 → 막음
     모두 중립 임시 경로          → 통과
```

- **누구에게**: agent를 보지 않습니다. 계보 루트가 같은 모든 세션, 곧 `open-gajae`와 그 아래 executor 등 subagent 모두입니다(`tests/hooks.test.ts` (G)).
- **중립 임시 경로**: `src/ralplan-runtime/temp-paths.ts`의 `isNeutralTempPath`. 경로를 `location.directory` 기준으로 풀어서, 프로젝트 밖이고 OS 임시 루트(`os.tmpdir()`, `$TMPDIR`, `/tmp`, `/var/tmp`, `/private/tmp`, `/private/var/tmp`) 안이어야 합니다. 심볼릭 링크와 별칭을 푼 실제 경로로도 한 번 더 확인하므로, 임시 폴더에서 프로젝트를 가리키는 링크는 통과하지 못합니다.
- **판단 근거**: 단계는 행의 `phase`가 아니라 **ultragoal state의 `current_phase`**를 봅니다. 주 skill 여부는 행으로 봅니다.

문구(`src/ultragoal-runtime/messages.ts`의 `ULTRAGOAL_GOAL_PLANNING_MUTATION_BLOCK_MESSAGE`, gjc의 `gjc ultragoal`을 `ultragoal create`로 바꾼 것):

```
Ultragoal goal-planning phase boundary: finish goal planning and record goals through `ultragoal create` before editing code. Product-code mutation tools and patch execution are blocked until goal planning completes and execution begins.
```

예(`tests/hooks.test.ts` (G)):

- `write src/x.ts` → 막힘. `patch`의 `*** Add File: src/y.ts` → 막힘.
- `write <OS 임시 폴더>/open-gajae-goal-planning-scratch.md` → 통과.
- 같은 요청을 executor 자식 세션이 해도 결과가 같습니다.
- `ultragoal create` 뒤에는 단계가 `pending`이 되어 모두 통과합니다.

### 실패 처리 (fail open)

산출물 가드와 반대로, 스스로 판단하지 못하면 **통과**시킵니다(gjc `:320`과 같음). 계보 조회 실패, 활성 행 파일이 깨져 읽기 실패, state 읽기 실패 모두 기록(`planning guard could not decide; allowing the call`)만 하고 호출을 진행합니다.

### 주 skill을 따른다

같은 함수가 ralplan 계획 가드도 맡습니다. 어느 쪽이 걸릴지는 **보이는 주 skill 하나**가 정합니다. 순위상 ultragoal이 ralplan보다 위이므로, 두 행이 모두 활성이면 ultragoal 쪽만 봅니다.

| 주 skill | 막는 조건 | 문구 |
|---|---|---|
| ralplan | ralplan state가 활성이고 알려진 단계이며 해제 단계(`complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`)가 아님. `final`과 `handoff`도 막음(DR-10) | `Ralplan planning phase boundary: …` (`RALPLAN_MUTATION_BLOCK_MESSAGE`) |
| ultragoal | ultragoal state가 활성이고 `goal-planning` | 위 문구 |

예(`tests/hooks.test.ts` (G)): ralplan이 `planner`로 활성인 세션에서 나중 execution에 `skill ultragoal`을 불러오면, 시드가 ralplan 행을 지우고 ultragoal이 주 skill이 됩니다. 이후 편집은 ralplan 문구가 아니라 `goal-planning` 문구로 막힙니다. `create` 뒤에는 ralplan state가 여전히 `planner`로 활성이지만 주 skill이 아니므로 아무 가드도 걸리지 않습니다([known-limits.md](known-limits.md) U22).

`goal-planning`에 들어오고 나가는 길은 [entry-and-handoff.md](entry-and-handoff.md)의 `goal-planning` 절에 있습니다.

### 이 가드가 막지 않는 것

- `shell`로 하는 변경(ralplan 편차 11). SKILL과 프롬프트의 글로만 금지됩니다.
- 파일 도구가 아닌 호출(`read`, workflow 도구, `subagent` 등).
- `goal-planning`이 아닌 단계. `pending`부터는 편집이 자유롭고, 순서(`next` 뒤에 구현)는 SKILL이 지시합니다.

## 도구 숨김

결정: plan C-11, D-HE8, E-2. 편차: ultragoal 23(gjc는 goal 도구를 항상 등록, `sdk/session.ts:4559-4575`).

### 주인 표

`src/hooks.ts`의 `TOOL_OWNERS`. 각 도구의 호출자 검사와 같은 주인입니다.

| 도구 | 주인 agent |
|---|---|
| `ultragoal` | `open-gajae` |
| `goal` | `open-gajae` |
| `ralplan` | `open-gajae`, `open-gajae-planner`, `open-gajae-architect`, `open-gajae-critic` |
| `deep-interview` | `open-gajae` |

### 규칙

`hideTools(event)`:

- `event.tools`가 객체가 아니면 아무것도 하지 않습니다.
- 위 네 도구마다, `event.agent`가 문자열이 아니거나 주인 목록에 없으면 `delete tools[도구]`.
- 표에 없는 도구는 건드리지 않습니다.
- agent가 없는 요청은 아무것도 갖지 않은 것으로 봅니다. 네 도구가 모두 지워집니다.

지운 도구는 호스트가 모델에게 내놓지도 않고, 호출이 와도 실행하지 않습니다(`TOOL_OWNERS` 주석이 가리키는 호스트 `core/src/session/model-request.ts:225-255`, `core/src/tool.ts:272-275`; 호스트 소스로 확인하지는 않음). 호스트 자신의 patch 플러그인이 자기 도구를 지우는 방식과 같습니다.

### 등록 위치

`src/index.ts`:

```
ctx.session.hook("context",    hooks.context)     // hideTools, 그다음 goal 문맥 주입
ctx.session.hook("compaction", hooks.hideTools)
ctx.session.hook("generate",   hooks.hideTools)
ctx.session.hook("compaction", hooks.compaction)  // 압축 복구 문맥
```

`context`의 goal 문맥 주입은 [goal-loop.md](goal-loop.md)에 있습니다.

결과 예(`tests/hooks.test.ts` (K2)):

| 요청의 agent | 남는 workflow 도구 |
|---|---|
| `open-gajae` | `deep-interview`, `goal`, `ralplan`, `ultragoal` |
| `open-gajae-planner`, `-architect`, `-critic` | `ralplan` |
| `open-gajae-executor`, `-cleaner`, `-lateral-reviewer`, `build`, `general`, `plan`, 사용자 정의 agent, agent 없음 | 없음 |

### 두 번째 층: 도구의 호출자 검사

숨김을 빠져나와도 각 도구가 스스로 거부합니다. 결과는 `Error: <문구>`인 도구 출력입니다(`src/tools/define.ts`의 `defineTool`이 예외를 출력으로 바꿈).

| 도구 | 조건 | 문구 |
|---|---|---|
| `ultragoal` | agent가 `open-gajae`가 아님 | `the ultragoal tool is not available to <agent>` |
| `goal` | 같음 | `the goal tool is not available to <agent>` |
| `ralplan` | 주인이 아님 | `the ralplan tool is not available to <agent>` |
| `ralplan` | 역할(planner·architect·critic)이 `write`·`status`·`state` 밖의 op | `<agent> may only use write, status and state` |
| `deep-interview` | agent가 `open-gajae`가 아님 | `the deep-interview tool is not available to <agent>` |

ultragoal state는 `ultragoal` 도구로만 바뀝니다. deep-interview state는 `deep-interview` 도구로만 바뀝니다(옛 상태 도구 3개(`state_*`)는 deep-interview 개정에서 삭제).

## 역할 권한 규칙

`src/config.ts`의 `roleRules(id)`. `registerAgents`가 각 agent의 `permissions` 뒤에 붙입니다. 출처: agent·권한 연동은 oh-my-openagent `d1557a4b…`, 역할 정책은 OMC(`src/config.ts` 헤더). ultragoal·goal 거부는 plan C-11입니다.

호스트 규칙 해석(주석 기준):

- 플러그인 규칙은 호스트 기본값 뒤에 붙고, 사용자 설정 `agents.<id>`의 규칙이 그 뒤에 붙어 이깁니다(R4).
- 호스트는 규칙을 `findLast`로 평가하고, 마지막 규칙이 `*` deny인 도구만 숨깁니다(`core/src/tool.ts:231,291-294`). 그래서 allow 규칙은 `*` deny 뒤에 둡니다.
- `shell` 규칙은 없습니다(R5/R6). 모든 역할이 `shell`을 가집니다.
- `edit` 권한 이름은 호스트의 `write`, `edit`, `patch` 도구가 함께 씁니다(로컬 `opencode/` `v2.0.15` 체크아웃의 `packages/core/src/tool/plugin/{write,edit,patch}.ts`가 모두 `permission: "edit"`).

공통 묶음 `readonlyDenies`: `question`, `deep-interview`, `opencode_session_move`, `opencode_session_rename` 거부.

| agent | 거부 | 허용(거부 뒤에 붙음) | workflow 도구 |
|---|---|---|---|
| `open-gajae` | 없음(`[]`) | — | 넷 다 사용 |
| `open-gajae-architect`, `open-gajae-critic` | `edit`, `subagent`, `readonlyDenies`, `ultragoal`, `goal` | — | `ralplan` 유지(lane 쓰기용) |
| `open-gajae-executor` | `subagent`, `readonlyDenies`, `ultragoal`, `goal`, `ralplan` | `subagent` → `open-gajae-explore`, `open-gajae-architect` | 없음 |
| `open-gajae-planner` | `edit`, `subagent`, `readonlyDenies`, `ultragoal`, `goal` | `subagent` → `open-gajae-explore`, `open-gajae-document-specialist` | `ralplan` 유지 |
| `open-gajae-explore`, `open-gajae-document-specialist`, `open-gajae-cleaner`, `open-gajae-lateral-reviewer` | `edit`, `subagent`, `readonlyDenies`, `ultragoal`, `goal`, `ralplan` | — | 없음 |

executor만 `edit`이 거부되지 않습니다. 제품 코드를 고치는 유일한 역할입니다. 그래도 산출물 가드와 `goal-planning` 가드는 executor에게도 똑같이 걸립니다.

### 세 겹이 겹치는 방식

`ultragoal`·`goal`을 예로 들면, 역할 agent에게는 세 겹이 있습니다.

```
1. roleRules      deny("ultragoal"), deny("goal")   → 호스트가 도구를 숨김 (사용자 설정이 풀 수 있음)
2. hideTools      context/compaction/generate 요청에서 삭제 → 사용자 설정과 상관없이 숨김 (편차 23)
3. 도구 자신      agent != "open-gajae" → "the ultragoal tool is not available to <agent>"
```

`build`처럼 이 플러그인이 만들지 않은 agent에게는 1이 없고 2와 3이 막습니다.

## red-team 조각

gjc 출처: `prompts/agents/executor.md:34-46`(`ultragoal_red_team_mode` 조각). 편차: ultragoal 20. 결정: D-VF11, plan C-12.

### 트리거

`execute.before`의 C 단계, `src/hooks.ts`의 `attachRedTeam(input)`. A·B를 통과한 `subagent` 호출마다 돕니다(`subagent`에는 파일 경로가 없어 A·B는 사실상 해당 없음). 조건을 모두 만족해야 붙입니다.

```
input이 객체이고
input.agent === "open-gajae-executor"                        (정확히 같아야 함)
input.prompt가 문자열이고 "[ultragoal-red-team]"를 포함        (대소문자 구분, 위치 무관)
input.prompt에 "<ultragoal_red_team_mode>"가 아직 없음           (두 번 붙이지 않음)
→ input.prompt = `${prompt}\n\n${ULTRAGOAL_RED_TEAM_FRAGMENT}`
```

- **어디에 붙나**: executor의 시스템 프롬프트(`prompts/open-gajae-executor.md`)가 아니라, `subagent` 입력의 `prompt`, 곧 자식 세션에 보내는 **과제 글의 끝**입니다. 호스트의 `subagent` 도구는 이 `prompt`를 "The task for the subagent to perform"으로 받습니다(`opencode/packages/core/src/tool/plugin/subagent.ts`).
- **호출자**: 누가 `subagent`를 부르는지는 보지 않습니다. ultragoal이 활성인지도 보지 않습니다. 표식만 봅니다.
- **붙지 않는 경우**(`tests/hooks.test.ts` (J)): 표식 없는 executor 과제, 표식이 있어도 architect 과제, critic 과제. reviewer에게 붙이는 brief는 없습니다.

### 조각 전문

`src/ultragoal-runtime/messages.ts`의 `ULTRAGOAL_RED_TEAM_FRAGMENT`:

```
<ultragoal_red_team_mode>
This mode is active because the assignment carries the `[ultragoal-red-team]` marker: you are the Ultragoal completion QA/red-team lane. Without the marker, preserve ordinary Executor behavior.

When active:
- Report the QA lane in the contract the assignment gives: `status` (`passed` only when every case passed), `commands` (each command you ran), `adversarialCases` (each adversarial case you tried, with its result), `evidence` and `blockers`. If the assignment omits the contract, read the QA lane contract step of the ultragoal SKILL's "Boundary completion cohort gate" section before producing evidence.
- Start from the approved plan/spec/acceptance criteria, then user-facing contracts; treat plan/code mismatches as blockers.
- Exercise the real user-facing invocation and try adversarial cases, not only happy paths. A prose claim without a command you ran is not evidence.
- Do not call `question`; report unresolved decisions and findings to the leader as blockers.
- Report blockers for missing plan/spec/acceptance source, contract ambiguity, plan/code mismatch, untestable surface, failed adversarial case, or shallow evidence.
</ultragoal_red_team_mode>
```

gjc 원문과 다른 곳(편차 20, `messages.ts` 주석): gjc의 typed `executionMode: "ultragoal-red-team"`(와 과제 글 대체 경로) 대신 표식이 켭니다. `executorQa` matrix·artifact·replay 문장은 가벼운 QA lane 계약으로, `inlineEvidence` 문장은 "A prose claim without a command you ran is not evidence."로, `ask`는 `question`으로, `gjc ultragoal record-review-blockers` 실행은 leader에게 blocker로 보고하는 것으로 바뀌었고, "missing artifact refs"는 빠졌습니다.

### 코드가 강제하지 않는 것

- 과제에 표식을 넣는 일, QA lane 계약(`status`, `commands`, `adversarialCases`, `evidence`, `blockers`)을 과제에 적는 일은 SKILL("Boundary completion cohort gate" 5·6단계)만 요구합니다.
- executor가 조각대로 보고했는지는 훅이 보지 않습니다. leader가 최종 gate의 `reviewCohort.lanes.qa`에 옮겨 적은 내용을 `checkpoint`의 gate 검사가 봅니다([gates-and-receipts.md](gates-and-receipts.md)).
- "Do not call `question`"은 글이지만, executor는 `roleRules`에서 `question`이 거부되어 있어 실제로도 부를 수 없습니다.

## cleaner 역할

gjc 출처: `packages/coding-agent/src/defaults/gjc/skills/ultragoal/ai-slop-cleaner.md`. 편차: ultragoal 19(gjc의 skill 조각 대신 `subagent`로 부르는 역할).

**무엇인가**: `open-gajae-cleaner`는 ultragoal 완료 gate의 cleanup 점검 lane입니다. 프롬프트는 `prompts/open-gajae-cleaner.md`이고, gjc의 ultragoal `ai-slop-cleaner` 조각입니다. leader가 `subagent`로 부르며 검사할 변경 파일 목록을 줍니다. 사용자가 직접 쓰는 workflow가 아닙니다.

**프롬프트의 요점**:

- 읽기 전용 탐지·보고자입니다. 코드 수정, 파일 쓰기, 포매터 실행, `.open-gajae/` 상태 변경, checkpoint, goal 도구, workflow 시작을 하지 않습니다. `shell`로도 파일을 바꾸지 않습니다.
- `shell`은 읽기 전용 점검에만 씁니다: `git diff`, `git log`, `git show`, `git status`, 그리고 쓰기 플래그 없이 기존 테스트·lint·typecheck 실행. 사용자에게 묻지 않고, 위임하지 않습니다.
- leader가 준 변경 파일만 봅니다. 넓은 맥락이 필요하면 leader에게 그 필요를 보고합니다. 관련 수정이 없으면 `Gate Result: PASS`인 통과 보고를 냅니다.
- 재귀 방지: `ralplan`, `deep-interview`, `ultragoal`을 중첩으로 시작하지 않습니다. 넓거나 구조적인 지적은 leader에게 review blocker로 넘깁니다.
- 분류: 가림(masking) fallback과 근거 있는 fallback, 중복, 죽은 코드, 불필요한 추상화, 경계 위반, UI/디자인 slop, 테스트 누락. 각 지적을 blocking 또는 advisory로 나눕니다. advisory는 gate 보고에만 두고 ultragoal 원장에 쓰지 않습니다.
- 보고: `AI SLOP CLEANUP REPORT` 머리와 정해진 라벨, 마지막에 `Gate Result: PASS | BLOCKED`. 보고의 `Leader Action`은 BLOCKED면 `open-gajae-executor`에게 blocking 지적만 고치게 하고 cleaner를 다시 돌리라고 적습니다. ultragoal SKILL의 "Internal ultragoal cleaner" 절도 같은 말("the cleaner reruns until zero blocking findings remain")을 합니다. 그런데 SKILL "Boundary completion cohort gate" 3단계는 cohort 안의 cleaner BLOCKING 지적이 따로 수정 루프를 시작하지 않고 cohort 지적에 합쳐진다고 적습니다. 두 지시가 어긋나며, 코드는 어느 쪽도 강제하지 않습니다.

**권한과 코드 강제**:

| 규칙 | 강제 |
|---|---|
| 파일 수정 금지 | `write`/`edit`/`patch`는 `edit` 거부로 코드가 막음. `shell`로 하는 변경은 프롬프트만 금지 |
| `shell` 명령 목록 | 프롬프트만. 명령을 검사하지 않음 |
| 질문·위임 금지 | `question`, `subagent` 거부로 코드가 막음 |
| workflow 중첩 금지 | `ralplan`·`ultragoal`·`goal` 도구가 거부·숨김·자체 거부로 막힘. `skill` 도구 로드 자체는 권한 규칙에 없음. 다만 ultragoal이 주 skill인 동안 `skill ralplan`·`skill deep-interview`는 체인 가드가 막고, 역할이 부른 `skill ultragoal`은 진입 게이트가 건너뛰어 상태를 만들지 않음 |
| 보고 형식, blocking/advisory 분류 | 프롬프트만. leader가 gate의 `reviewCohort.lanes.cleaner`에 옮겨 적은 값을 gate 검사가 봄([gates-and-receipts.md](gates-and-receipts.md)) |

테스트 실행 허용 문장은 gjc 원문이 아니라 예전 open-gajae 프롬프트에서 가져온 것입니다(프롬프트의 source 표). 병렬 lane과 부딪칠 수 있다는 기록은 [known-limits.md](known-limits.md) U37에 있습니다.

## architect와 critic (ultragoal이 쓰는 범위)

두 역할의 프롬프트는 ralplan용이고, ultragoal은 **바꾸지 않고, brief도 붙이지 않고** 다시 씁니다(각 프롬프트의 source 절). ultragoal에 관계된 부분만 적습니다.

| 항목 | `open-gajae-architect` | `open-gajae-critic` |
|---|---|---|
| 프롬프트 | `prompts/open-gajae-architect.md` | `prompts/open-gajae-critic.md` |
| ultragoal에서 맡는 일 | 목표마다의 architect 리뷰, 마지막 필수 목표의 cohort architect lane | 완료·pause 종착점의 terminal critic |
| 내는 판정 | Architectural Status `CLEAR`/`WATCH`/`BLOCK`, Code Review Recommendation `APPROVE`/`COMMENT`/`REQUEST CHANGES` | `OKAY`/`ITERATE`/`REJECT` |
| leader가 옮겨 적는 곳 | gate의 `architectReview`와 `reviewCohort.lanes.architect`. 아래 표 밑의 설명 참고 | 최종 gate의 `criticReview`, 또는 `ultragoal record_critic_verdict` |
| 읽기 전용 | 프롬프트가 요구, `edit` 거부로 파일 도구는 코드가 막음 | 같음 |
| `shell` | 프롬프트상 읽기 전용 점검과 읽기 전용 git만. 명령은 검사하지 않음 | 같음 |
| 권한 | `edit`, `subagent`, `readonlyDenies`, `ultragoal`, `goal` 거부. `ralplan` 유지 | 같음 |

`architectReview`의 세 상태를 어떻게 채우는지는 문서끼리 어긋납니다.

- `prompts/open-gajae-architect.md`의 source 설명: leader가 "this prompt's single architectural status"에서 `architectureStatus`, `productStatus`, `codeStatus`를 기록한다고 적고 ultragoal 편차 13을 듭니다.
- ultragoal SKILL의 목표별 gate 2단계: architect는 상태 하나와 권고 하나를 내고, leader는 세 상태를 "from its findings on each side" 기록하라고 적습니다.
- `docs/development.md`의 ultragoal 편차 13 행은 "모든 목표가 architect 리뷰를 받고 지연 gate가 없다"는 내용뿐이고, 세 상태 채우는 법은 다루지 않습니다.
- 코드(`src/ultragoal-runtime/gate.ts`의 `checkArchitectReview`)는 세 상태가 모두 `"CLEAR"`이고 `recommendation`이 `"APPROVE"`인지만 봅니다. 어떻게 채웠는지는 알 수 없습니다.

`ralplan` 도구를 가지고 있으므로 이 역할들은 ultragoal 실행 중에도 `ralplan write`·`status`·`state`를 부를 수 있습니다. 두 프롬프트는 "Persistence (ralplan runs only)" 절에서 과제가 ralplan 단계나 `stage_n`을 가리킬 때만 `ralplan write`를 부르라고 적어 두었고, 코드는 ultragoal 중의 `ralplan write`를 막지 않습니다([known-limits.md](known-limits.md) U22). terminal critic이 중첩 workflow를 시작하지 않는다는 규칙은 ultragoal SKILL("Invocation and containment")에만 있습니다.

gate가 이 판정들을 어떻게 검사하는지는 [gates-and-receipts.md](gates-and-receipts.md)에 있습니다.

## 코드가 강제하는 것과 SKILL·프롬프트만 요구하는 것

| 규칙 | 코드 | SKILL·프롬프트만 |
|---|---|---|
| ultragoal 파일과 `state/**`를 `write`/`edit`/`patch`로 바꾸지 못함 | 예 (모든 agent, 모든 세션) | |
| 그 파일들을 `shell`로 바꾸지 않음 | | 예 |
| `goal-planning` 동안 제품 파일 편집 금지 | 예 (`write`/`edit`/`patch`, 계보 전체, 임시 경로 예외) | `shell`은 글로만 |
| `ultragoal`·`goal`은 `open-gajae`만 | 예 (숨김 + 권한 + 자체 거부) | |
| 역할 agent는 checkpoint·goal 상태를 건드리지 않음 | 예 (도구가 없음) | |
| cleaner·architect·critic은 읽기 전용 | 파일 도구는 예 | `shell`은 글로만 |
| 역할은 사용자에게 묻지 않음 | 예 (`question` 거부) | |
| executor QA lane은 `[ultragoal-red-team]` 표식으로 조각을 받음 | 예 (표식이 있으면) | 표식을 넣는 일 |
| QA lane 계약과 보고 형식 | | 예 (gate가 옮겨 적은 값만 검사) |
| cleaner·terminal critic은 중첩 workflow를 시작하지 않음 | workflow 도구는 예 | 나머지는 글로만 |
