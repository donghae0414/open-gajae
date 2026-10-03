# 가드, continuation, 압축 문맥, 도구 숨김

이 문서는 ralplan이 도는 동안 훅이 **막거나 덧붙이는 일**을 코드 그대로 적습니다. 다루는 것은 `execute.before`의 순서와 차단 방식, ralplan 경로의 항상 차단, 계획 가드(planning guard)와 OS 임시 경로 예외, continuation과 breaker, 중단 표식과 자식 execution 추적, 압축 복구 문맥, 도구 숨김과 역할 권한입니다. 판단과 호스트 호출은 거의 모두 `src/hooks.ts`의 `createHooks`(`:352-1304`) 안에 있고, 순수 판단과 문구는 `src/ralplan.ts`, 경로 판정은 `src/artifact-guard.ts`와 `src/ralplan-runtime/temp-paths.ts`, 압축 투영은 `src/ralplan-runtime/recovery.ts`에 있습니다. 기준 코드는 [README.md](README.md) 머리에 있습니다. 코드 위치는 그 기준 코드(`5b92a60`)의 줄 번호이고, 루트 `README.md`·`README.ko.md`의 줄 번호는 지금 파일 기준입니다.

이웃 주제는 다음 문서에 있습니다.

- [ops.md](ops.md): `ralplan` 도구의 정의와 op별 거부, `state {"active": false}`·`clear`로 run을 멈추는 길
- [state-and-files.md](state-and-files.md): `state/ralplan-continuation.json`의 자리와 모양, 활성 행·스냅숏·보이는 주 skill(`readVisiblePrimaryTx`), phase 집합 T·R·known의 정의, 감사 행 모양
- [stages-and-ledger.md](stages-and-ledger.md): `index.jsonl` 행과 sha256, `planning_stuck` 기록
- [entry-and-handoff.md](entry-and-handoff.md): 키워드·멘션 안내, 턴 표식, 같은 `execute.before`의 C·D 단계(같은 execution의 `skill ultragoal` 게이트, 체인 가드), Stop here
- [roles-and-consensus.md](roles-and-consensus.md): 세 역할의 등록·모델·프롬프트, subagent 재개
- [known-limits.md](known-limits.md): 알려진 한계
- 다른 skill의 같은 장치: [../deep-interview/guards-and-continuation.md](../deep-interview/guards-and-continuation.md), [../ultragoal/guards.md](../ultragoal/guards.md), [../ultragoal/goal-loop.md](../ultragoal/goal-loop.md)

용어 몇 가지(나머지는 [README.md](README.md)의 용어 절):

- **execution**: 호스트(OpenCode v2)가 세션에서 모델을 한 번 돌리는 단위입니다. `session.execution.started`로 시작해 `succeeded`, `failed`, `interrupted` 가운데 하나로 끝납니다.
- **중립 임시 경로(neutral temp path)**: OS 임시 루트 아래에 있으면서 프로젝트 밖인 경로입니다. 아래 "중립 임시 경로" 절에 판정 순서가 있습니다.
- **synthetic 메시지**: 플러그인이 `session.synthetic(...)`으로 세션에 써 넣는 메시지입니다. `resume: true`면 호스트가 새 execution을 시작합니다. `description`은 TUI에 보이는 한 줄이고, 없으면 TUI가 메시지를 숨깁니다(`src/hooks.ts:70-73` 주석).

## 한눈에 보기

| 장치 | 하는 일 | 누구에게 | 어디서 | 판단 실패 시 |
|---|---|---|---|---|
| 항상 차단 | `plans/ralplan/**`와 세션 `state/**`에 `write`/`edit`/`patch` 거부 | 모든 agent, 모든 세션 | `execute.before` A | 막음 (fail closed) |
| 계획 가드 | ralplan이 보이는 주 skill이고 `active: true`이며 phase가 알려진 phase이고 R 밖이면, OS 임시 경로 밖 `write`/`edit`/`patch` 거부 | 계보의 모든 agent | `execute.before` B | 통과 (fail open) |
| continuation | ralplan이 보이는 주 skill이고 `active: true`, phase가 알려졌고 T 밖, `planning_stuck` 없음이면 `<ralplan-continuation>`을 넣고 새 execution을 엶 | 계보 루트 | `session.execution.succeeded` | 넣지 않음 |
| breaker | 31번째 판단에서 ralplan을 `active: false`로 바꾸고 `<ralplan-notice>`를 넣음 | 계보 루트 | 같음 | — |
| 중단 표식 | interrupt 이유가 `user`·`shutdown`이면 다음 실제 사용자 프롬프트까지 continuation 없음 | 세션별 | `session.execution.interrupted`, `prompt` 훅 | — |
| 자식 execution 대기 | 같은 위치의 자식 execution이 도는 동안 continuation 없음 | 부모 세션 | `session.execution.*` | — |
| 압축 문맥 | `<ralplan-compaction-context>`를 압축 프롬프트의 system에 추가 | ralplan state가 있는 세션 (사실상 계보 루트) | `compaction` 세션 훅 | 넣지 않음 |
| 도구 숨김 | `ralplan` 도구를 주인 넷이 아닌 agent의 요청에서 지움 | 그 밖의 모든 agent | `context`·`compaction`·`generate` 세션 훅 | — |
| 도구의 호출자 검사 | 주인이 아니면 거부, 역할은 `write`·`status`·`state`만 | 같음 + 역할 셋 | `ralplan` 도구 `execute` | 막음 |
| 역할 권한 | planner·architect·critic은 `ralplan` 유지, 나머지 다섯 역할은 `ralplan` 거부 | 역할 subagent 여덟 | 호스트 권한(`roleRules`) | — |

## 훅 등록

`src/index.ts:70-93`:

```
ctx.session.hook("prompt",      hooks.prompt)       // 이 문서의 몫: 중단 표식 해제
ctx.session.hook("context",     hooks.context)      // hideTools, 그다음 goal 문맥
ctx.session.hook("compaction",  hooks.hideTools)
ctx.session.hook("generate",    hooks.hideTools)
ctx.session.hook("compaction",  hooks.compaction)   // 압축 복구 문맥 (hideTools 다음)
ctx.tool.hook("execute.before", hooks.executeBefore)
ctx.tool.hook("execute.after",  hooks.executeAfter)
for await (const event of ctx.event.subscribe(...)) await hooks.onEvent(event)
```

이벤트는 하나씩 순서대로 처리합니다. 그래서 자식의 `started`가 부모의 `succeeded` 판단보다 먼저 기록됩니다(`src/index.ts:80-81` 주석).

## `execute.before`의 순서와 차단 방식

`executeBefore`(`src/hooks.ts:1004-1097`)가 차례로 봅니다.

```
A  항상 차단 (guardSessionArtifacts, :689-724)   걸리면 막고 끝. 판단 중 예외면 경로가 있는 호출을 막음
B  계획 가드 (guardPlanning, :742-782)           걸리면 막고 끝. 자기 예외는 안에서 삼키고 통과
C  tool == "subagent" → ultragoal red-team 조각, 끝
D  tool == "skill"   → ultragoal 게이트 / 체인 가드 / deep-interview 로드 게이트, 턴 표식
```

C·D는 [entry-and-handoff.md](entry-and-handoff.md)와 ultragoal 문서의 몫입니다. `ralplan` 도구 호출은 파일 도구가 아니어서 경로가 없으므로 A·B에 걸리지 않습니다.

막는 방식은 예외가 아니라 입력을 비우는 것입니다. Promise 훅의 예외는 호스트에서 결함이 되기 때문입니다(`:1005-1010` 주석).

```
execute.before: blocked.set(call id, 문구); event.input = {}
      ↓ 호스트가 {}를 그 도구의 입력으로 해석하다 실패 → Tool.Error, status "error"   (주석 기준, Phase 0 P3)
execute.after : 이 call id의 문구를 꺼내 지우고, status가 "error"면
                event.error = new ToolError({ message: 문구 })                     (:1105-1122)
      ↓ 모델은 도구 오류로 그 문구를 봅니다.
```

- 호스트의 도구 입력 복구가 이 훅보다 먼저 돌기 때문에, 문자열로 온 JSON 입력도 이미 풀린 채로 들어옵니다(`:1008-1010` 주석. 호스트 소스로 확인하지 않았습니다).
- 기록된 문구가 없는 실패(예: 호스트 권한 거부)는 `execute.after`가 건드리지 않습니다.
- A에서 `guardSessionArtifacts` 자체가 예외를 던지면, 그 호출에 경로가 하나라도 있을 때 `guidance(tool, "_session-*")`(`:671-673`) 문구로 막습니다. 이 문구에는 `open-gajae:` 머리가 없습니다: `<tool> may only write under this session's plans/ or drafts/ (<접두>.open-gajae/_session-*/plans|drafts/)` (`<접두>`는 `projectPrefix`, 호스트 위치와 프로젝트가 같으면 빈 문자열).

## 항상 차단: ralplan run 폴더와 세션 `state/`

출처: gjc `skill-state/workflow-mutation-guard.ts:1683-1690`(`isBlockedGjcPath`, `hasBlockedGjcTarget`: `.gjc/**` 대상 변경 도구를 막음)과 같은 파일 `:24-25`의 `WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE`, 거부 때 붙이는 `\nUse: ${command}` 줄(`:1790,1812`). 이 줄 번호는 `gajae-code/`에서 확인했습니다. 결정: 계획 S3 ①, AC18, AC21(plan `.omc/plans/ralplan-gjc-stage-trail.md`).

### 검사하는 도구와 경로

`src/artifact-guard.ts`:

- `ARTIFACT_TOOLS`(`:16-20`): `write`, `edit`, `patch`.
- `artifactPathsOf`(`:46-65`): `write`·`edit`는 `input.path` 하나(빈 문자열이면 없음), `patch`는 `patchText`의 각 줄을 다듬은 뒤 `*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:` 뒤의 경로를 모두 모읍니다(`PATCH_MARKERS`, `:27-32`). 그 밖의 도구는 빈 목록이라 검사하지 않습니다.
- `projectRelative`(`:74-85`): 상대 경로는 호스트의 `location.directory` 기준으로 풀고, 프로젝트 디렉터리 기준 POSIX 상대 경로로 바꿉니다. 프로젝트 밖이면 `undefined`이고 이 가드는 판단하지 않습니다. 심볼릭 링크는 풀지 않는 글자 비교입니다.
- `RALPLAN_OWNED`(`:128`): `^\.open-gajae\/_session-[^/]+\/plans\/ralplan(?:\/|$)` (`isRalplanOwned`, `:130-137`)
- `SESSION_STATE`(`:143`): `^\.open-gajae\/_session-[^/]+\/state(?:\/|$)` (`isSessionState`, `:145-152`)

### 판정 순서와 문구

`guardSessionArtifacts`(`src/hooks.ts:689-724`)가 경로마다 차례로 보고, 처음 걸린 것에서 멈춥니다.

| 순서 | 조건 | 문구 |
|---|---|---|
| 1 | ultragoal 파일(`isUltragoalOwned`) | `open-gajae: <경로> is ultragoal-owned; change it only through the ultragoal tool` |
| 2 | deep-interview 스펙(`isDeepInterviewOwned`) | `` open-gajae: <경로> is deep-interview-owned; write specs only through `deep-interview spec` `` |
| 3 | ralplan run 폴더(`isRalplanOwned`) 또는 세션 `state/` 트리(`isSessionState`) | `open-gajae: <경로>: ` + `WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE` |
| 4 | 다른 세션의 `plans/`·`drafts/` | 다른 세션 안내 ([../ultragoal/guards.md](../ultragoal/guards.md)) |

`<경로>`는 프로젝트 상대 경로입니다(없으면 받은 그대로). `WORKFLOW_STATE_MUTATION_BLOCK_MESSAGE`(`src/hooks.ts:326-327`)는 gjc 문구의 `.gjc/**`와 `gjc` CLI를 호스트 경로와 도구로 바꾸고, `Use:` 줄을 도구 목록으로 바꾼 것입니다.

```
.open-gajae workflow state and ralplan artifacts are runtime-owned. Agent mutation tools cannot edit `.open-gajae/_session-*/state/**` or `.open-gajae/_session-*/plans/ralplan/**`; use the sanctioned tool instead.
Use: `ralplan` for ralplan state and plans, `ultragoal` for ultragoal state, `goal` for the goal, `deep-interview` for deep-interview state and specs.
```

실제로 돌린 결과(`bun`으로 임시 `StateStore`에 `createHooks`를 만들고 `executeBefore` → `executeAfter`를 부름, `<session>`은 세션 폴더 이름):

```
write .open-gajae/<session>/plans/ralplan/<run>/stage-01-planner.md →
open-gajae: .open-gajae/<session>/plans/ralplan/<run>/stage-01-planner.md: .open-gajae workflow state and ralplan artifacts are runtime-owned. …(위 문구 그대로)

edit .open-gajae/<session>/state/ralplan-continuation.json →
open-gajae: .open-gajae/<session>/state/ralplan-continuation.json: .open-gajae workflow state and ralplan artifacts are runtime-owned. …(위 문구 그대로)
```

### ralplan과 관련된 경로

| 경로(프로젝트 상대) | 결과 |
|---|---|
| `.open-gajae/_session-X/plans/ralplan/<run>/stage-01-planner.md`, `index.jsonl`, `pending-approval.md` | 3 |
| `.open-gajae/_session-X/plans/ralplan` (폴더 자체) | 3 |
| 하위 디렉터리에서 연 호스트의 `../.open-gajae/_session-X/plans/ralplan/run/index.jsonl` | 3 |
| `.open-gajae/_session-X/state/ralplan-state.json`, `ralplan-continuation.json`, `active/ralplan.json` | 3 |
| `.open-gajae/_session-X/state/skill-active-state.json`, `audit.jsonl`, `transactions/…` | 3 |
| `.open-gajae/_session-X/plans/ralplan-notes.md`, `plans/plan.md` | 3이 아님. 4의 규칙(자기 계보 루트의 폴더면 허용) |
| 하위 디렉터리에서 연 호스트가 `.open-gajae/_session-X/state/ralplan-state.json`을 상대 경로로 씀 | 하위 디렉터리 기준으로 풀려 프로젝트의 `.open-gajae`가 아니므로 해당 없음 |

(`stage-01-planner.md`, 폴더 자체, `../` 줄, `ralplan-state.json`, `ralplan-continuation.json`, `active/ralplan.json`, `ralplan-notes.md`, `plan.md`, 하위 디렉터리 줄은 `tests/artifact-guard.test.ts`의 "ralplan run folders and the session state tree are runtime-owned from any location (AC18, AC21)" 표에 있습니다. `index.jsonl`·`pending-approval.md`, `skill-active-state.json`·`audit.jsonl`·`transactions/…` 줄은 정규식에서 이끌어 냈습니다.)

3은 **모든 agent, 모든 세션**에 늘 적용됩니다. ralplan이 활성인지, 주 skill인지와 상관없습니다. 다른 세션의 `state/`와 `plans/ralplan/`도 막습니다. 계보 조회가 실패해도 1~3은 정규식만으로 막습니다(테스트 "(m) with the lineage lookup failing, …").

### 막지 않는 것

- `shell`로 하는 변경. 명령을 해석하지 않습니다. 역할 프롬프트("Workflow persistence and state go through the `ralplan` tool …, not `shell`")와 SKILL의 경계 문장만 금지합니다.
- 대소문자가 다른 경로. 정규식에 `i` 플래그가 없어, 대소문자를 구분하지 않는 파일 시스템(macOS 기본)에서는 `.OPEN-GAJAE/…` 같은 경로가 빠져나갑니다. 계획 가드가 걸려 있는 동안은 그 경로도 프로젝트 안이라 계획 가드가 막습니다. 루트 README "Mandatory follow-up development" 5번, 결정 R-OD13, ultragoal known-limits U4.
- 여러 OpenCode 프로세스 사이의 동시 쓰기. 쓰기 큐는 한 프로세스 안에서만 직렬화합니다(README 후속 4번, ultragoal U31).
- 프로젝트 안의 심볼릭 링크를 거치는 경로. 글자로만 비교하므로 `.open-gajae/…/state`를 가리키는 링크 폴더 아래 경로는 정규식에 걸리지 않습니다(코드에서 이끌어 냄). 링크를 만들려면 `shell`이 필요하고, 호스트 `write`가 그 링크를 따라 쓰는지는 이 문서를 쓰며 확인하지 않았습니다.
- `read` 등 파일을 쓰지 않는 도구.

## 계획 가드

계획 중에 제품 파일을 고치지 못하게 합니다. 출처: gjc `skill-state/workflow-mutation-guard.ts`의 `RALPLAN_MUTATION_BLOCK_MESSAGE`(`:26-27`), `isBlockingPlanningPhase`(`:272-276`), `getActivePlanningSkill`(`:325-351`, fail-open 계약 주석 `:320`), `planningBlockedTargets`(`:1768-1775`). 이 줄 번호는 `gajae-code/`에서 확인했습니다. 결정: DR-10(phase ∉ R, 계보 전체), C-2(R), C-3(known phase), R-O10(`final`·`handoff`도 막음), DR-11(임시 경로), DR-21(모르는 phase는 판독 불가), R-O7(ultragoal이 실행 중이면 ralplan 가드 없음, 지금은 주 skill 규칙이 대신함), R-AE1(복구 줄), ultragoal 계획 D-HE5·PQ-13 A(주 skill 규칙). 편차: ralplan 편차 11(`shell` 미분류), 23(계보 전체).

### 조건

`guardPlanning`(`src/hooks.ts:742-782`)이 도구가 `write`/`edit`/`patch`일 때만 돕니다.

```
1. 호출 세션의 계보 루트를 구함 (rootSession, :626-658)
2. 루트의 workflowTransaction 하나에서 보이는 주 skill을 읽음 (readVisiblePrimaryTx)
3. 주 skill이 "ralplan"이면 ralplan state(tx.readModeState("ralplan"))를 읽어
     state.active === true
     && isKnownPhase(state.current_phase)            (C-3: 9단계 + handoff + R)
     && !GUARD_RELEASE_PHASES.has(current_phase)     (R 밖)
   이면 RALPLAN_MUTATION_BLOCK_MESSAGE
   주 skill이 "ultragoal"이면 goal-planning 가드, "deep-interview"면 편집 가드 (아래 "다른 가드와의 관계")
   그 밖이면 통과
4. 막기로 했으면 대상 경로를 봄 (artifactPathsOf)
     경로가 하나도 없음                                 → 막음 (gjc가 모르는 대상을 막는 것과 같음)
     isNeutralTempPath(resolve(locationDir, 경로), projectDir)가 하나라도 거짓 → 막음
     모두 중립 임시 경로                                 → 통과
```

- **주 skill을 따름**: 단계 3의 분기는 보이는 주 skill 하나로 정합니다. 순위는 ultragoal > ralplan > deep-interview입니다(gjc `collapsePlanningPipeline`. 자세한 규칙은 [state-and-files.md](state-and-files.md)). 그래서 ultragoal 행이 활성이면 ralplan state가 활성이어도 ralplan 분기는 돌지 않습니다.
- **phase는 state에서**: 활성 행의 `phase`가 아니라 `ralplan-state.json`의 `current_phase`를 봅니다. 글자 그대로 비교합니다. 다듬기(trim)나 소문자 변환을 하지 않으므로 `" planner"`, `"Planner"`는 모르는 phase가 되어 통과합니다. gjc `isBlockingPlanningPhase`는 다듬고 소문자로 바꾸며, state에 `current_phase`가 없으면 행의 `phase`를 씁니다(`:273,348`). 런타임 op는 다듬은 manifest phase만 쓰므로, 차이는 손으로 고친 state에서만 생깁니다(ralplan 편차 40).
- **누구에게**: agent를 보지 않습니다. 계보 루트가 같은 모든 세션, 곧 `open-gajae`와 그 아래 역할·executor 등 모든 subagent의 호출입니다(DR-10, 편차 23. gjc는 호출한 세션의 id로 판단합니다).
- **자기 세션의 `plans/`·`drafts/`도 막힘**: 항상 차단의 4번 규칙은 자기 계보 루트의 `plans/notes.md`를 통과시키지만, 계획 가드가 그 다음에 돌므로 계획 중에는 그 쓰기도 막힙니다(아래 실행 결과). 플랜 본문은 `ralplan write`로만 기록합니다.

### phase별 결과

`src/ralplan-runtime/manifest.ts`의 집합(T `:99-102`, R `:109-116`, known `:119-126`)으로 정리하면 이렇습니다. continuation과 압축 문맥은 아래 절의 내용을 미리 모은 것입니다.

| `current_phase` (state가 `active: true`일 때) | 계획 가드 (주 skill일 때) | continuation (주 skill일 때) | 압축 문맥 |
|---|---|---|---|
| `planner`, `intent`, `architect`, `critic`, `disposition`, `revision`, `post-interview`, `adr` | 막음 | 넣음 (`planning_stuck`이면 없음) | 넣음 (투영이 되면) |
| `final`, `handoff` (T이지만 R 아님) | 막음 | 없음, 카운터 0 | 넣음 (투영이 되면) |
| `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive` (R) | 통과 | 없음, 카운터 0 | 넣음 (투영이 되면) |
| 그 밖의 문자열, 문자열 아님 (DR-21) | 통과 | 없음, 카운터 그대로 | 없음 |
| state가 `active: false`이거나 없음·손상 | 통과 | 없음, 카운터 그대로 | 없음 |

R의 phase에 `active: true`인 조합은 런타임 op가 만들지 않습니다(`clear`는 `active: false`와 `complete`를 함께 쓰고, `state` op는 manifest 밖 phase를 거부합니다. [ops.md](ops.md)). 테스트: "(d) an active final or handoff keeps blocking edits outside a temp path; an active complete releases (C-2 R)", "(e) a legacy ralplan state is unreadable: no guard, no continuation, `skill ultragoal` enters (DR-21)", "(c) clear, then a write on the same run, leaves it finished: edits pass, no continuation (DR-3, R-OD9)".

### 문구

`RALPLAN_MUTATION_BLOCK_MESSAGE`(`src/hooks.ts:334-335`). gjc 문구의 `gjc ralplan --write`를 `ralplan write`로 바꾸고, 낡거나 실수로 시작한 run을 끝내는 복구 줄을 더했습니다(R-AE1).

```
Ralplan planning phase boundary: keep refining the consensus plan and persist plan artifacts through `ralplan write` (stage scratch files under a temp dir if needed). Product-code mutation tools and patch execution are blocked while ralplan is active; mutate only after the plan is approved and execution begins.
If this ralplan run is stale or was started by mistake, stop it with `ralplan state` {"active": false} or `ralplan clear`.
```

실제로 돌린 결과(`ralplan start` 뒤 phase `planner`, 호출은 모두 `open-gajae`):

| 호출 | 결과 |
|---|---|
| `edit {path: "src/x.ts"}` | 위 문구로 막힘 |
| `write {path: "<os.tmpdir()>/open-gajae-scratch.md"}` | 통과 |
| `write {path: ".open-gajae/<session>/plans/notes.md"}` (자기 세션) | 위 문구로 막힘 |
| `patch {patchText: "*** Begin Patch\n*** End Patch"}` (경로 없음) | 위 문구로 막힘 |

### 중립 임시 경로

`isNeutralTempPath`(`src/ralplan-runtime/temp-paths.ts:71-87`). gjc `workflow-mutation-guard.ts:1698-1766`(`neutralTempRoots`, `isPathWithin`, `realpathOrSelf`, `canonicalizeForContainment`, `isNeutralTempPath`)을 옮긴 것입니다(DR-11). 같은 함수가 primary의 `ralplan write {path}` 입력 검사(`readTempArtifact`, `:94-122`, [ops.md](ops.md))에도 쓰입니다.

```
1. 앞뒤 공백을 자른 경로가 비었으면 거짓
2. projectDir 기준으로 절대 경로를 만듦 (가드는 이미 location.directory 기준으로 푼 값을 넘김)
3. 글자로 프로젝트 안이면 거짓
4. 임시 루트 어느 것 안에도 없으면 거짓
     임시 루트(neutralTempRoots, :18-29) = os.tmpdir(), $TMPDIR, /tmp, /var/tmp, /private/tmp, /private/var/tmp
5. canonicalizeForContainment(:48-63): 존재하는 가장 가까운 조상을 realpath로 풀고 남은 꼬리를 다시 붙임
   (심볼릭 링크 조상과 macOS /tmp → /private/tmp 별칭을 풂)
6. 그 실제 경로가 realpath로 푼 프로젝트 안이면 거짓
7. realpath로 푼 임시 루트 어느 것 안에 있으면 참
```

실제로 돌린 결과(프로젝트가 임시 루트 아래에 있는 경우 포함):

| 대상 | 결과 |
|---|---|
| 임시 루트 아래 보통 파일 (목록에 있는 루트의 글자 그대로) | 참 |
| `realpath(os.tmpdir())` 아래 파일 (macOS `/private/var/folders/…/T/x.md`) | **거짓** |
| `/tmp/og-alias-check.md` (macOS에서 `/private/tmp` 별칭) | 참 |
| 프로젝트 파일(절대 경로, 상대 경로) | 거짓 |
| 임시 폴더의 링크 → 프로젝트 안 **있는** 파일 | 거짓 |
| 임시 폴더의 링크 → 프로젝트 안 **없는** 파일 (끊긴 링크) | **참** |

- **끊긴 심볼릭 링크(R-OD12)**: 5단계에서 링크 자체가 realpath에 실패하므로, 부모 폴더의 실제 경로에 링크 이름을 붙인 값으로 판정합니다. 그래서 프로젝트 안의 아직 없는 파일을 가리키는 임시 폴더의 링크는 중립 임시 경로로 판정됩니다. gjc도 같습니다(`:1731-1745`). 관리자 결정 R-OD12는 "gjc 그대로, 변경 없음"이고, 근거는 링크를 만들려면 검사하지 않는 `shell`이 필요하다는 것입니다(편차 11). 그런 링크로 쓴 `write`를 호스트가 어떻게 처리하는지(링크를 따라 프로젝트에 파일을 만드는지)는 이 문서를 쓰며 확인하지 않았습니다.
- **realpath로 푼 macOS 임시 폴더는 막힙니다.** 4단계는 글자 비교이고, 임시 루트 목록에는 `os.tmpdir()`(macOS에서는 보통 `/var/folders/…/T`)는 있지만 그 실제 경로 `/private/var/folders/…/T`는 없습니다. 실제로 돌려 보면 `join(os.tmpdir(), "x.md")`는 참, `join(realpath(os.tmpdir()), "x.md")`는 거짓입니다. 그래서 모델이 임시 경로를 정규화해 `/private/var/folders/…`로 쓰면 계획 가드에 막히고, primary의 `ralplan write {path}`도 거부됩니다. `/tmp`·`/private/tmp`는 둘 다 목록에 있어 이 문제가 없습니다. gjc도 같습니다(`:1698-1708`, `:1755-1766`). 편차가 아닙니다.
- 대소문자를 바꾼 경로는 글자 비교에서 프로젝트 밖·임시 루트 밖으로 보이므로 중립이 아닙니다(막는 쪽).
- 테스트: `tests/ralplan-runtime.test.ts` "temp paths: /tmp and os.tmpdir() files are neutral; project paths and temp symlinks into the project are not".

### 실패 처리 (fail open)

`guardPlanning`은 자기 안의 예외를 모두 잡아 로그(`planning guard could not decide; allowing the call`)만 남기고 호출을 통과시킵니다(`:778-781`). gjc의 fail-open 계약(`:320`)과 같고, 항상 차단과 반대입니다.

| 상황 | 결과 |
|---|---|
| 계보 조회 실패 (`rootSession`이 던짐) | 통과 (테스트 (m)) |
| 활성 행 파일을 읽을 수 없음 (`readVisiblePrimaryTx`가 던짐) | 통과 |
| 스냅숏을 읽을 수 없음 | 스냅숏이 없는 것으로 보고 계속 ([state-and-files.md](state-and-files.md)) |
| ralplan state가 없음 | 통과 (`state?.active`가 `true`가 아님) |
| ralplan state가 손상 (`readModeState`가 던짐) | 통과 |
| phase를 모름 (DR-21, 예: 옛 OMC 형식 `"ralplan"`) | 통과 (테스트 (e)) |
| `isNeutralTempPath`가 던짐 | 통과 (같은 `try` 안) |

### 다른 가드와의 관계

같은 `guardPlanning`이 세 skill의 계획 가드를 모두 맡고, 보이는 주 skill 하나만 판단합니다.

| 보이는 주 skill | 막는 조건 | 문구 |
|---|---|---|
| ultragoal | ultragoal state가 활성이고 `current_phase`(다듬고 소문자)가 `goal-planning` | `Ultragoal goal-planning phase boundary: …` ([../ultragoal/guards.md](../ultragoal/guards.md)) |
| ralplan | 위 조건 | `Ralplan planning phase boundary: …` |
| deep-interview | deep-interview state가 유효하고 활성이며 phase가 `interviewing`·`handoff` | `Deep-interview phase boundary: …` ([../deep-interview/guards-and-continuation.md](../deep-interview/guards-and-continuation.md)) |
| 없음 | — | 통과 |

예:

- ralplan이 `planner`로 활성인 세션에서 나중 execution에 `skill ultragoal`을 불러오면, ultragoal 시드가 ralplan 행을 지우고 ultragoal이 주 skill이 됩니다. 이후 편집은 ralplan 문구가 아니라 `goal-planning` 문구로 막히고, `ultragoal create` 뒤에는 ralplan state가 여전히 활성이어도 아무 가드도 걸리지 않습니다(테스트 "(G) goal-planning refuses product edits outside a temp path; the ralplan guard follows the primary (D-HE5, PQ-13 A)", ultragoal known-limits U22).
- `ultragoal handoff(to: "ralplan")` 뒤에는 ultragoal 행이 비활성 `handoff_to` 행이 되고 ralplan 행이 활성이므로, ralplan 가드가 다시 걸립니다.
- deep-interview가 활성이어도 ralplan 행이 활성이면 ralplan이 주 skill이고 ralplan 조건으로 판단합니다.

### 막지 않는 것

- `shell`. 파일을 바꾸는 명령도 분류하지 않습니다(편차 11. gjc는 `bash`의 변경 명령을 분류합니다, `:1475-1610`). SKILL의 Planning/Execution Boundary("do not mutate product source, run mutation-oriented shell, …")와 역할 프롬프트가 글로만 금지합니다. SKILL은 큰 산출물을 `write` 도구나 따옴표 heredoc(`cat > /tmp/plan.md <<'EOF' … EOF`)으로 임시 루트에 두라고 합니다. 앞쪽은 가드가 통과시키고, 뒤쪽은 가드가 보지 않습니다.
- `skill ralplan` 로드와 `ralplan start` 사이. 로드는 state를 쓰지 않으므로 그동안 편집이 막히지 않습니다(편차 36).
- `final`의 Stop here(`state {"active": false}`), `clear`, `ralplan handoff` 뒤. state가 비활성이므로 통과합니다. 이때 phase가 `final`·`complete`·`handoff`로 잠겨 있어, 같은 run에 다시 `write`해도 state가 다시 켜지지 않습니다(DR-3, R-OD9, 테스트 (c)). 계획 phase(잠기지 않은 phase)에서 `state {"active": false}`로 멈췄다면 다릅니다: 같은 run의 다음 `write`가 state를 다시 켜고 활성 행도 다시 쓰므로 가드가 다시 걸립니다(`persistActiveRunIdTx`, `src/ralplan-runtime/store.ts:513-545`. 실제로 돌려 보면 `planner`에서 멈춘 뒤 편집은 통과하고, 같은 run의 `write` 뒤에는 다시 막힘. [state-and-files.md](state-and-files.md) 3장 "필드"의 `active` 행).
- ultragoal이 주 skill인 동안의 활성 ralplan(U22).

## continuation

계획 중 모델이 턴을 끝내면 "계획 루프를 이어 가라"는 메시지를 넣어 다시 돌립니다. OMC `persistent-mode/index.ts`의 `checkRalplan`(`:2057-2160`, `src/ralplan.ts:95-103` 주석)을 옮긴 것이고, gjc의 TUI 세션에는 ralplan continuation이 없습니다(편차 10). 종료 조건은 gjc의 T와 `planning_stuck`, `active: false`이고(C-2, AC17), 카운터는 훅 전용 파일에 둡니다(R-O3, 편차 26). 결정: C-1.5(트랜잭션 하나), PQ-7 B(주 skill일 때만), D-TL6·I-6(활성 goal은 goal 경로만), deep-interview DR-20(deep-interview가 먼저), Phase 0 Q5·Q9·Q10.

### 이벤트 처리

v2 호스트에는 `session.idle`이 없습니다. `onEvent`(`src/hooks.ts:1243-1292`)가 `ctx.event.subscribe`의 이벤트를 받습니다. 이벤트가 `{type, data}` 객체가 아니거나 `data.sessionID`가 빈 문자열이면 무시합니다.

| 이벤트 | 처리 (ralplan에 관계된 것) |
|---|---|
| `session.created` | 세션의 `location`과 `parentID`를 캐시(`sessions`) |
| `session.execution.started` | 자기 위치의 자식이면 부모의 `running`에 추가 |
| `session.execution.succeeded` | 자식이면 부모의 `running`에서 뺌. 부모가 없는 세션이면 `continueSession` |
| `session.execution.failed` | 자식이면 `running`에서 뺌. continuation 없음 |
| `session.execution.interrupted` | 자식이면 `running`에서 뺌. 이유가 `user`·`shutdown`이면 중단 표식. continuation 없음 |

(`session.tool.called`의 도구 호출 수와 턴 표식은 goal 루프와 [entry-and-handoff.md](entry-and-handoff.md)의 몫입니다.)

**위치 확인(Q10)**: `sessionOf`(`:411-427`)는 세션의 `location.directory`가 이 플러그인 인스턴스의 위치와 글자 그대로 같은지 보고 결과를 세션마다 캐시합니다. `session.created`가 위치를 실어 오면 조회하지 않고, 아니면 `session.get`을 한 번 부릅니다. 공유 서버에서는 모든 인스턴스가 모든 이벤트를 받으므로, 위치가 다른 세션의 이벤트는 여기서 버립니다(테스트 "sessions of another location are ignored (Q10)"). 조회가 실패하면 그 이벤트는 바깥 `catch`에서 로그만 남깁니다.

**루트 판정**: `continueSession`은 세션 정보에 `parentID`가 없을 때만 부릅니다(`:1285-1286`). `rootSession`을 거치지 않습니다. 자식 세션(역할 subagent)의 `succeeded`는 continuation을 만들지 않습니다.

### 중단 표식 (Q9)

- `session.execution.interrupted`의 `data.reason`이 `STOP_REASONS`(`:305`) = `user`(Esc나 interrupt API), `shutdown`이면 `interrupted`에 세션을 넣습니다(`:1277-1283`). 플러그인 주석에 따르면 `shutdown`은 닫은 `question` 폼과 이유 없는 interrupt의 호스트 기본값입니다. 호스트 `core/src/session/execution.ts:53`이 이유 없는 interrupt를 `"shutdown"`으로 만드는 것은 확인했고, `question` 폼을 닫을 때의 이유는 확인하지 않았습니다.
- 다른 이유는 표식을 남기지 않습니다. 호스트 v2.0.15의 `InterruptReason` 타입은 `"user" | "shutdown" | "inactivity"`이므로, 실제로 오는 다른 이유는 `inactivity`입니다. 테스트 "inactivity and superseded interrupts do not set the mark"는 `superseded`도 넣어 확인합니다. 이 값은 고정된 호스트 소스에 없고, 목록 밖의 이유이므로 표식을 남기지 않습니다.
- 표식이 있으면 `continueSession`은 다른 모든 판단보다 먼저 끝냅니다. ralplan state도 카운터 파일도 쓰지 않으므로 `active: true`가 그대로 남습니다.
- 표식은 **다음 실제 사용자 프롬프트까지** 갑니다. `prompt` 훅(`:860-1002`)이 G1(세션 agent가 역할 subagent 여섯 가운데 하나면 끝), G2(프롬프트에 `INJECTION_MARKERS`의 표지가 있으면 끝) 뒤에 `interrupted.delete`를 합니다(`:885`). 표지가 든 fallback 안내나 붙여 넣은 continuation 문구로는 풀리지 않습니다. agent가 `build` 같은 다른 agent여도 풉니다(R-OD20).
- 그사이 백그라운드 자식이 끝나 호스트가 부모를 다시 돌리고 그 execution이 `succeeded`로 끝나도, 표식이 남아 있으므로 continuation은 없습니다. 표식을 한 번 쓰고 지우지 않는 이유입니다(`:75-79` 주석).
- 표식은 세션별이고 메모리에만 있습니다. 다른 세션의 Esc는 이 세션을 멈추지 않고, 플러그인이 다시 시작되면 사라집니다.
- 테스트: "a user or shutdown interrupt stops continuation until a real prompt (Q9)", "an interrupt of another session does not silence this one".

### 자식 execution 대기 (Q5)

`running: Map<부모, Set<자식>>`(`:399`)은 자기 위치의 세션 가운데 `parentID`가 있는 것의 `started`에서 자식을 더하고, 그 자식의 다른 `session.execution.*` 이벤트에서 뺍니다(`:1269-1275`). `continueSession`은 이 집합이 비어 있지 않으면 끝냅니다. 자식이 끝나면 호스트가 부모를 다시 돌리고, 그 뒤의 `succeeded`를 새로 판단합니다(`:550-552` 주석, OMC `persistent-mode/index.ts:529-537` 인용). background 여부는 보지 않고 이 위치의 모든 자식 execution을 셉니다. foreground `subagent`는 부모 execution 안에서 끝나므로, 실제로 차이가 나는 것은 `background: true`로 띄운 자식 같은 경우입니다. 테스트: "continuation waits while a child execution runs (Q5)".

### `continueSession`의 순서

`continueSession`(`src/hooks.ts:536-597`):

```
1. 같은 세션의 continuation이 진행 중(inFlight)이면 끝 — 겹친 succeeded가 하나만 넣음
2. 중단 표식이 있으면 끝
3. 자식 execution이 돌고 있으면 끝
4. deep-interview 판단 (deepInterview.decideContinuation)
     continue → <deep-interview-continuation> 넣고 끝
     hold     → 아무것도 하지 않고 끝 (goal·ralplan도 건너뜀)
     none     → 다음으로
     예외     → 로그를 남기고 none처럼 다음으로
5. goal 판단 (goal.decideContinuation)
     message  → goal continuation이나 보류 알림을 넣고 끝
     held     → 아무것도 하지 않고 끝 (ralplan도 건너뜀, I-6)
     inactive → 다음으로
     예외     → 로그(goal continuation failed)를 남기고 끝 (ralplan도 돌지 않음)
6. decideRalplan → 결과가 있으면 inject (resume: true)
     예외     → 로그(ralplan continuation failed)
```

그래서 ralplan continuation은 **deep-interview가 맡지 않고 활성 goal도 없을 때만** 돕니다. 예: `ultragoal handoff(to: "ralplan")` 뒤에는 goal이 그대로 `active`이므로 계획 중에도 goal continuation만 들어갑니다([../ultragoal/goal-loop.md](../ultragoal/goal-loop.md) 3절, 테스트 "(A) an active goal takes the goal path only; otherwise ralplan continues; only the root continues (D-TL6, C-2)"). deep-interview와 goal의 판단은 [../deep-interview/guards-and-continuation.md](../deep-interview/guards-and-continuation.md)와 [../ultragoal/goal-loop.md](../ultragoal/goal-loop.md)에 있습니다.

### `decideRalplan`

`decideRalplan`(`src/hooks.ts:474-533`)은 루트의 `ralplanTransaction` 하나 안에서 읽고, 판단하고, 카운터를 씁니다(C-1.5). 메시지는 트랜잭션이 끝난 뒤 넣습니다.

```
1. readVisiblePrimaryTx: 던지면 로그(active rows unreadable; no ralplan continuation)를 남기고 없음
2. 주 skill이 "ralplan"이 아니면 없음 (PQ-7 B) — 카운터도 건드리지 않음
3. tx.readState(): 던지면 로그(ralplan state unreadable; treating session as inactive)를 남기고 없음
4. readBreaker(tx, state.run_id) (:449-463): 카운터 파일을 읽어 run_id가 같을 때만 씀
     파일 없음 → undefined / 읽기·파싱 실패 → 로그(… starting over) 뒤 undefined / 다른 run → undefined
5. shouldContinue(state, breaker, Date.now()) (src/ralplan.ts:121-138)
     skip     → resetBreaker이고 지금 카운트가 0이 아니면 카운터를 0으로 씀. 없음
     breaker  → patchStateTx(…, {active: false}, HOOK_OWNER, "breaker-exhausted"), 카운터 0, breaker 알림
     continue → 카운터를 count로 씀, continuation 메시지
```

### `shouldContinue` (AC17)

| 입력 | 결과 |
|---|---|
| state가 없음, 또는 `active !== true` | `skip` |
| `current_phase`가 알려진 phase가 아님 (DR-21) | `skip` |
| `current_phase` ∈ T, 또는 `planning_stuck`이 참으로 평가되는 값 | `skip` + `resetBreaker` |
| 그 밖 | `count = (카운터가 신선하면 breaker_count, 아니면 0) + 1` |
| `count > 30` | `breaker` |
| `count ≤ 30` | `continue` |

- **신선함**: `breaker_updated_at`이 문자열이고 `now - Date.parse(…) ≤ 45분`(`RALPLAN_STOP_BLOCKER_TTL_MS`, `src/ralplan.ts:26`)일 때입니다. 날짜로 읽을 수 없으면 신선하지 않습니다. `breaker_count`는 `Number(…) || 0`으로 읽으므로(`src/ralplan.ts:135`), 숫자로 바꿀 수 없으면 0이고 `"5"` 같은 숫자 문자열은 그 수로 셉니다.
- 상한 30(`RALPLAN_STOP_BLOCKER_MAX`, `:25`)과 45분은 OMC v1의 상수 그대로입니다(`persistent-mode/index.ts:1876-1877`).
- `planning_stuck`은 런타임이 `{marker, reason}` 객체로 씁니다([stages-and-ledger.md](stages-and-ledger.md)). 새 `run_id`의 `write`가 이 필드를 지웁니다.
- 테스트: `tests/ralplan.test.ts` "shouldContinue truth table (AC17)".

### 카운터 파일 `state/ralplan-continuation.json`

훅만 씁니다(R-O3). 경로는 `tx.paths.continuationPath`(`src/state.ts:502`)이고, 항상 차단의 `state/**` 아래라 `write`/`edit`/`patch`로 고칠 수 없습니다. 감사 행을 남기지 않습니다. 실제로 돌린 첫 continuation 뒤의 내용(시각은 실행마다 다름):

```json
{
  "run_id": "ses_guard1",
  "breaker_count": 1,
  "breaker_updated_at": "2026-10-03T15:02:57.707Z"
}
```

`run_id`는 그 순간 state의 `run_id`입니다(위 예는 `run_id` 없이 `start`해 계보 루트 세션 id가 된 경우). 쓰는 때와 값:

| 때 | 쓰는 값 |
|---|---|
| `continue` | `breaker_count: count`, 시각 갱신 |
| `skip` + `resetBreaker` (T, `planning_stuck`) | 지금 카운트가 0이 아닐 때만 `breaker_count: 0` |
| `breaker` | `breaker_count: 0` |
| `active: false`, 모르는 phase, state 없음·손상, 주 skill이 아님 | 쓰지 않음 |

같이 알아둘 것:

- **45분은 마지막 continuation부터 잽니다.** 매번 `breaker_updated_at`을 새로 쓰므로, 45분 안에 한 번씩 이어지는 한 30번까지 셉니다. 45분 넘게 쉬었으면 다음은 1부터입니다(테스트 "a counter past the TTL or of another run restarts the count at one").
- **실제 사용자 프롬프트는 카운트를 되돌리지 않습니다.** `prompt` 훅은 deep-interview 횟수와 goal 보류만 풉니다(`:892-899`). 그래서 30번은 사용자 프롬프트마다가 아니라 run 하나의 45분 연속 구간마다의 상한입니다.
- **`clear`나 멈춤 뒤에도 카운트가 남습니다.** `clear`와 `state {"active": false}`는 활성 행을 지우므로, 다음 판단은 2단계(주 skill 아님)에서 끝나고 카운터를 0으로 쓰지 않습니다. 실제로 돌려 보면:
  - 5번 이어 간 뒤 `clear`하고 45분 안에 같은 세션에서 `run_id` 없이 다시 `ralplan start`하면 다음 continuation은 `6/30`입니다. `clear`는 `run_id`를 남기고(`clearStateTx`, `src/ralplan-runtime/store.ts:1133-1139` 주석), `start`는 `run_id`가 없으면 state의 `run_id`를 다시 쓰기 때문입니다(`startRunTx`, `:925`).
  - 계획 phase(`planner`)에서 3번 뒤 `state {"active": false}`로 멈췄다가 `{"active": true}`로 재개하면 다음은 `4/30`입니다.
  - `final`의 Stop here는 그 전에 무엇이 있었는지에 따라 다릅니다. `final`을 쓴 뒤 활성 `final`인 채로 `succeeded`가 한 번이라도 오면 그때 카운터가 0이 됩니다(T). 승인 질문과 Stop here가 `final`을 쓴 execution 안에서 끝나면 카운트가 그대로 남습니다(3 그대로). 그 뒤 `{"active": true}`로 재개하면 활성 `final`이라 continuation은 없고, 다음 `succeeded`에서 0이 됩니다.
  - 새 `run_id`를 주면 1부터입니다.
- 파일을 읽을 수 없거나 다른 run의 것이면 1부터 다시 셉니다.

### 주입 문구

continuation(`continuationMessage(count)`, `src/ralplan.ts:46-56`). OMC `persistent-mode/index.ts:2147-2160`의 문구에서 마지막 문장을 `ralplan clear`로 바꿨습니다(plan DR-17). 실제로 돌린 첫 번째:

```
<ralplan-continuation>

[RALPLAN - CONSENSUS PLANNING | REINFORCEMENT 1/30]

The ralplan consensus workflow is active. Continue the Planner/Architect/Critic planning loop only.
Ralplan is read-only/planning mode: do not implement, invoke execution skills, edit source, commit, push, or open PRs from this continuation.
When consensus is reached, stop at a pending-approval handoff and require explicit user approval before execution.
When done, call `ralplan clear` to cleanly exit.

</ralplan-continuation>

---

```

- TUI 줄: `open-gajae: ralplan continuation <count>/30`. `resume: true`.

breaker(`breakerMessage()`, `src/ralplan.ts:59-64`). OMC `:2140`이 감싸지 않고 내던 문구를 `<ralplan-notice>`로 감쌌습니다.

```
<ralplan-notice>

[RALPLAN CIRCUIT BREAKER] Stop enforcement exceeded 30 reinforcements. Allowing stop and deactivating stale ralplan state to prevent infinite restart loops.

</ralplan-notice>

---

```

- TUI 줄: `open-gajae: ralplan continuation stopped (breaker limit reached)`.
- **breaker 알림도 `resume: true`로 들어갑니다.** `continueSession`이 `inject(sessionID, action.text, action.description)`(`:593`)를 `resume` 인자 없이 부르고, `inject`의 기본값이 `true`입니다(`:430-435`). 실제 실행 결과도 `"resume": true`입니다. 그래서 알림 뒤 모델 execution이 한 번 더 돌고, 그 `succeeded`에서는 state가 비활성이라 아무것도 넣지 않습니다. breaker 알림은 `resume: false`로 쓰는 키워드·멘션 안내와 다른 길(continuation 길)로 나갑니다(루트 README "Ralplan" 절, `README.md:125,185`).
- `inject`(`:430-442`)는 `synthetic`이 실패하면 로그(`continuation synthetic failed`)만 남기고 다시 시도하지 않습니다. 카운터는 이미 올라 있으므로 다음 `succeeded`가 다시 시도하는 셈입니다(주석, 테스트 "a rejected synthetic does not escape the event handler"). 키워드·멘션 안내와 달리 프롬프트 텍스트에 덧붙이는 fallback은 없습니다. `continueSession`이 넣는 것은 모두 이 `inject`를 지나므로 같습니다: ralplan continuation과 breaker 알림, deep-interview continuation, goal continuation과 goal 보류 알림(`resume: false`).

### breaker 소진이 쓰는 것

`patchStateTx(tx, sessionID, {active: false}, HOOK_OWNER, "breaker-exhausted")`(`src/ralplan-runtime/store.ts:1001-1079`)는 `ralplan state` op와 같은 런타임 기록자입니다. 병합 패치로 `active: false`를 쓰고 `updated_at`을 갱신하며, phase와 다른 필드는 그대로 둡니다. `deactivated_reason`·`completed_at`은 쓰지 않습니다(R-O3, P-AC8). 실제로 돌린 31번째 뒤의 감사 로그 끝(시각과 id는 실행마다 다름, `<session>`은 세션 폴더):

```
{"ts":"…","skill":"ralplan","category":"state","verb":"write","owner":"open-gajae-hook","mutation_id":"ralplan:breaker-exhausted:…","from_phase":"planner","to_phase":"planner","forced":false,"paths":["<session>/state/ralplan-state.json"]}
{"ts":"…","category":"state","verb":"remove-active-entry","owner":"open-gajae-hook","mutation_id":"…","forced":false,"paths":["<session>/state/active/ralplan.json"]}
{"ts":"…","category":"state","verb":"rebuild-active-snapshot","owner":"open-gajae-hook","mutation_id":"…","forced":false,"paths":["<session>/state/skill-active-state.json"]}
```

- 감사 행은 셋입니다: `breaker-exhausted`가 붙은 state 쓰기 행, 활성 행 제거, 스냅숏 재구성(루트 README "Ralplan" 절, `README.md:185`). 계획의 "감사 1행"(`.omc/plans/ralplan-gjc-stage-trail.md:180`, 역사 기록)과 테스트 "the thirty-first succeeded trips the circuit breaker: …"는 `breaker-exhausted` 행만 셉니다.
- state의 `_meta.updatedBy`는 `ralplan_hook`입니다.
- state가 비활성이고 활성 행도 지워지므로 그 뒤 계획 가드도 풀립니다. 다시 계획하려면 `state {"active": true}`로 재개하거나 새 run을 엽니다. phase가 잠기지 않았으므로 같은 run의 다음 `write`도 state를 다시 켭니다. 어느 쪽이든 카운터가 0이므로 다음은 `1/30`입니다.
- `patchStateTx`가 거부하면(예: 봉투 검사 실패) 예외가 `continueSession`까지 올라가 로그만 남습니다. 알림도, 카운터 0도 쓰지 않습니다(코드에서 이끌어 냄, 테스트 없음).

### `question`과의 관계

열린 `question`은 답이 올 때까지 execution을 붙잡으므로, 그동안 `succeeded`가 나오지 않고 continuation도 없습니다. 호스트 코드로 확인했습니다. `question` 도구가 `forms.ask`를 부르고(`opencode/packages/core/src/tool/plugin/question.ts:74-87`), `Form.ask`가 `Deferred.await`로 도구 호출을 붙잡습니다(`form.ts:148-153`). 플러그인 continuation은 루트의 `succeeded`에서만 돕니다(`src/hooks.ts:1285-1286`). 실제 OpenCode에서 돌려 확인하지는 않았습니다([roles-and-consensus.md](roles-and-consensus.md)와 같은 근거). 게다가 승인 질문이 열린 동안 state는 활성 `final`(T)이므로, `succeeded`가 오더라도 continuation은 없습니다.

폼을 닫으면(dismiss) 도구가 `CancelledError`로 끝나고(`question.ts:89-93`), 러너는 이를 거절(decline)로 기록하고 그 스텝을 중단으로 처리합니다(`session/runner/step.ts:192-201`). 플러그인 주석은 그 execution이 이유 `shutdown`의 `interrupted`로 끝나 중단 표식이 생긴다고 적습니다(`src/hooks.ts:300-305`). 이유 없는 interrupt가 `shutdown`이 되는 것(`execution.ts:53`)까지는 확인했고, `CancelledError`에서 그 이유까지 이어지는 길은 이 문서를 쓰며 따라가지 않았습니다.

### agent를 보지 않음 (R-OD21)

`decideRalplan`과 `continueSession`은 세션의 agent를 보지 않습니다. 활성 ralplan 세션을 `build` 같은 다른 agent로 바꾸면 그 agent의 턴에 continuation이 들어갈 수 있고, 그 agent에게는 `ralplan` 도구가 숨겨져 있습니다. ralplan 쪽은 breaker에서 멈춥니다. 관리자 결정 R-OD21은 "기록만"입니다(루트 README "Notices go only to the `open-gajae` primary" 행).

### 결과 정리

| 상황 | ralplan continuation | 카운터 파일 |
|---|---|---|
| ralplan이 주 skill, 활성, 알려진 비T phase, stuck 아님, 활성 goal 없음 | 넣음 (`n/30`) | `n` |
| 같은데 31번째 | breaker 알림, state `active: false`, 행 제거 | 0 |
| 활성 `final`·`handoff` (예: `final`을 쓰고 승인 질문을 기다림) | 없음 | 0 |
| `planning_stuck` | 없음 | 0 |
| Stop here, `clear` 뒤, ralplan 행이 없음 | 없음 | 그대로 |
| ultragoal이 주 skill (ralplan state는 활성이어도) | 없음 (테스트 "(I2) ralplan continues only while it is the visible primary skill (PQ-7 B)") | 그대로 |
| 활성 goal | 없음, goal 경로 | 그대로 |
| deep-interview가 주 skill (`interviewing`·`handoff`면 goal도 건너뜀) | 없음 (ralplan이 주 skill이 아님) | 그대로 |
| 모르는 phase, 손상된 state | 없음 | 그대로 |
| Esc 뒤, 자식 execution 실행 중, `failed`, 자식 세션, 다른 위치의 세션 | 없음 | 그대로 |

## 압축 문맥

대화가 압축된 뒤 계획을 이어 갈 수 있게, 지금 run의 계획 요약을 압축 프롬프트의 system 부분에 넣습니다. 출처: gjc `gjc-runtime/workflow-recovery-projection.ts`(투영)와 `session/agent-session.ts:667-703`(`renderWorkflowRecoveryContext`, `gajae-code/`에서 확인. 루트 README 편차 20 행과 `src/hooks.ts:22`·`recovery.ts:13` 머리 주석도 같은 범위), `:745-753`(`sanitizeCompactionStateText`). 투영 쪽 줄 번호는 `src/ralplan-runtime/recovery.ts:7-14` 머리 주석의 값입니다. 결정: spec D-H2, AC19, DR-14. 편차: ralplan 편차 20.

### 순서

`compaction`(`src/hooks.ts:1194-1241`)이 셋을 차례로 넣습니다. 앞의 것이 실패해도 뒤의 것은 돕니다. 같은 `compaction` 세션 훅에는 그 앞에 `hideTools`가 등록돼 있습니다.

1. ultragoal 복구 문맥 (세션이 계보 루트일 때)
2. deep-interview 문맥 (세션이 계보 루트일 때)
3. ralplan 복구 계약 (`:1211-1240`)

### 조건

```
store.ralplanTransaction(event.sessionID) 안에서
1. tx.readState() — 던지면 없는 것으로 봄
2. state.active === true 이고 isKnownPhase(state.current_phase) 가 아니면 없음
3. ralplanRecoveryRunFromState(state) (recovery.ts:172-185): run_id가 안전한 이름이 아니면 없음
     안전: 문자열, 비지 않음, 앞뒤 공백 없음, 경로 구분자 없음(basename과 같음), "."·".." 아님
4. runDir = tx.paths.runDir(run_id), indexText = index.jsonl 내용
5. projectRalplanRun(...) → 결과가 없으면 없음
6. compactionMessage(renderRalplanRecoveryContext(projection)) 를 event.system에 추가
```

- **주 skill을 보지 않습니다.** 계획 가드·continuation과 달리 활성이고 알려진 phase이기만 하면 넣습니다. 그래서 T의 활성 `final`(승인 대기)에서도 넣고, ultragoal이 주 skill인데 ralplan state가 활성으로 남은 경우(U22)에도 넣습니다. 실제로 돌려 보면, `ralplan start`와 `planner` 쓰기 뒤 나중 execution에 `skill ultragoal`을 불러 `goal-planning`이 된 세션의 압축에는 `<ralplan-compaction-context>` 하나가 들어갔습니다(`goals.json`이 아직 없어 ultragoal 문맥은 없음).
- **계보 루트를 구하지 않습니다.** ultragoal·deep-interview 단계와 달리 `event.sessionID` 자기 세션 폴더의 state를 봅니다. `ralplan` 도구는 언제나 계보 루트의 폴더에 쓰므로, 자식 세션의 압축에는 보통 아무것도 들어가지 않습니다.
- 손상된 state, 비활성, 모르는 phase(DR-21)는 없음입니다(테스트 "(f) compaction adds the ralplan recovery contract of an active run only (AC19)").
- 파일 읽기는 트랜잭션을 거칩니다. 계약 파일 읽기(`readArtifact`, `:1223-1231`)는 run 폴더 밖을 가리키는 경로를 거절하고, `tx.readText`는 세션 폴더 밖 경로, 심볼릭 링크인 성분, 보통 파일이 아닌 대상을 거부합니다(`src/state.ts:342-380,487-497,616-626`). 그런 거부는 계약이 없는 것으로 봅니다. `index.jsonl` 읽기의 예외는 이 단계 전체를 실패(로그 `ralplan compaction context failed`)로 만듭니다.

### 투영 (`projectRalplanRun`, `recovery.ts:202-305`)

```
1. index.jsonl이 없으면 없음. 빈 줄을 뺀 각 줄이 JSON 객체가 아니면(한 줄이라도) 없음
2. 계약 행: 가장 새 stage "final" 행, 없으면 가장 새 "revision"·"planner" 행
   그 행의 path가 비었거나 sha256이 문자열이 아니면 없음
3. path(상대 경로면 run 폴더 기준으로 풂)를 한 번 읽음. 못 읽으면 없음
4. objective = 첫 번째 "#"로 시작하지 않는 비지 않은 줄 (600자). 없으면 없음
5. "## " 절(앞 24개)에서 목록을 뽑음 (아래 표)
6. 읽은 바이트의 sha256이 행의 sha256(접두 "sha256:" 있든 없든)과 같지 않거나,
   행 값이 "sha256:" + 소문자 hex 64자 모양이 아니면 없음
7. 다음 행동(nextAction)을 정함 (아래 표)
```

| 항목 | 찾는 절 제목 (대소문자 무시) | 개수 한도 | 항목 길이 |
|---|---|---|---|
| 수용 기준 | "acceptance criteria", "verification", "test plan"을 **포함**. 없으면 정확히 "acceptance" | 12 (`MAX_CRITERIA_ITEMS`) | 240자 (`MAX_ITEM_CHARS`) |
| 범위 | 정확히 "scope", "accepted scope" | 12 (`MAX_SCOPE_ITEMS`) | 240자 |
| 비목표 | 정확히 "non-goals", "non goals", "non-goal", "out of scope" | 12 | 240자 |
| Intent Reconciliation | "intent reconciliation", "open confirmation", "unresolved"를 포함 | 8 (`MAX_UNRESOLVED_ITEMS`) | 240자 |

항목은 절 본문의 글머리표(`-`, `*`, `+`, `1.`, `1)`) 뒤 글, 또는 글머리표 없는 비지 않은 줄입니다. 한도를 넘는 글은 잘라 `…`를 붙입니다(`boundText`, `:74-79`). 상수는 `recovery.ts:68-72`입니다.

| 조건 (위에서부터) | `Next action:` |
|---|---|
| index에 `event: "planning_stuck"`이고 `planning_stuck: true`인 행이 있음 | `awaiting-approval` |
| 계약 행이 `final` | `awaiting-approval` |
| index의 마지막 행이 `critic` | state의 `last_review_verdict_lane`이 `critic`이고 `last_review_verdict`가 `OKAY`면 `reconcile-intent`, 아니면 `revise-plan` |
| index의 마지막 행이 `planner`·`revision` | `reconcile-intent` |
| 그 밖 | `run-plan-review` |

(투영은 `detail`도 만들지만 렌더는 `actionClass`만 적습니다.)

### 렌더와 문구

`renderRalplanRecoveryContext`(`recovery.ts:319-349`)가 줄을 만들고, `compactionMessage`(`src/ralplan.ts:86-93`)가 머리 줄을 붙여 `<ralplan-compaction-context>`로 감쌉니다. 각 값은 `&`, `<`, `>`를 escape하고 줄바꿈을 공백으로 바꾼 뒤 자릅니다(`sanitizeCompactionStateText`, `:308-316`).

| 줄 | 넣는 때 | 한도 |
|---|---|---|
| `Workflow contract (ralplan): <objective>` | 늘 | 200자 |
| `Accepted scope: a; b; …` | 범위가 있을 때 | 앞 8개, 각 120자 |
| `Non-goals: …` | 비목표가 있을 때 | 앞 6개, 각 120자 |
| `Acceptance criteria: …` | 수용 기준이 있을 때 | 모두(최대 12), 각 120자 |
| `Intent Reconciliation: …` | 있을 때 (편차 20, DR-14) | 모두(최대 8), 각 120자 |
| `Next action: <actionClass>` | 늘 | — |
| `Contract digest: sha256:<hex>` | 늘 (투영에 sha256이 있음) | — |

실제로 돌린 결과(`ralplan start` 뒤 `final` 1회차를 아래 본문으로 쓰고 압축). 본문:

```markdown
# Plan

Ship the cache layer.

## Scope
- cache reads
- cache invalidation on deploy

## Non-goals
- cache writes

## Acceptance criteria
- hit rate logged
- p95 read latency under 20ms

## Intent Reconciliation
- confirm the TTL
```

`event.system`에 들어간 텍스트(digest는 본문의 sha256):

```
<ralplan-compaction-context>

[RALPLAN RUN ACTIVE] Keep this workflow contract in the summary; the durable ralplan state and plan files are authoritative over summary prose.

Workflow contract (ralplan): Ship the cache layer.
Accepted scope: cache reads; cache invalidation on deploy
Non-goals: cache writes
Acceptance criteria: hit rate logged; p95 read latency under 20ms
Intent Reconciliation: confirm the TTL
Next action: awaiting-approval
Contract digest: sha256:d0948cf2890f05563763cd7e75da2353ccdf04088f996455e7ed7db9c25d21db

</ralplan-compaction-context>

---

```

`planner` 1회차(`# Draft\n\nAdd a cache.\n`)만 있는 run은 `Workflow contract (ralplan): Add a cache.`, `Next action: reconcile-intent`, `Contract digest: …` 세 줄입니다.

### sha256이 다르면

계약 파일을 바꾸면(예: `shell`로 고침) 6단계에서 투영이 없어지고 아무것도 넣지 않습니다. 더 오래된 행으로 대신하지도 않습니다(테스트 (f)의 마지막 단계). 압축 전 마지막 `final`이 손상됐으면 그 run의 복구 문맥은 다음 `final`을 쓸 때까지 사라집니다.

### gjc와 다른 점

- `Intent Reconciliation:` 줄이 더 있습니다(gjc는 투영만 하고 출력하지 않음, 편차 20, DR-14).
- gjc의 줄들을 머리 줄 하나와 함께 `<ralplan-compaction-context>` 블록 하나로 넣습니다. ultragoal의 `<ultragoal-compaction-context>`와 같은 모양입니다(편차 20).
- ultragoal 전용 필드(`currentGoal`, `progress`)와 zero-progress fingerprint는 옮기지 않았고, `run_id` 없는 state의 옛 폴더 탐색도 없습니다(`recovery.ts:15-22` 주석).

## 도구 숨김과 역할 권한

### 주인 표와 숨김

`TOOL_OWNERS`(`src/hooks.ts:288-298`)에서 `ralplan`의 주인은 `open-gajae`, `open-gajae-planner`, `open-gajae-architect`, `open-gajae-critic` 넷입니다(D-W3, 계획 C-11). `hideTools`(`:1129-1135`)는 요청의 `tools`가 객체일 때, 요청의 agent가 문자열이 아니거나 주인 목록에 없으면 `delete tools["ralplan"]`을 합니다. `ultragoal`, `goal`, `deep-interview`도 같은 방식으로 지우고, 표에 없는 도구는 건드리지 않습니다.

- `context`(먼저 `hideTools`, 그다음 goal 문맥), `compaction`, `generate` 세 세션 훅에 걸려 있습니다.
- 지운 도구는 호스트가 모델에게 내놓지 않고, 호출이 와도 `execute.before` 훅 뒤에 `Tool is not available for this request: <tool>`로 거부합니다(호스트 `opencode/packages/core/src/tool.ts:271-275`, v2.0.15 체크아웃에서 확인).

| 요청의 agent | 남는 workflow 도구 |
|---|---|
| `open-gajae` | `deep-interview`, `goal`, `ralplan`, `ultragoal` |
| `open-gajae-planner`, `-architect`, `-critic` | `ralplan` |
| `open-gajae-executor`, `-cleaner`, `-lateral-reviewer`, `build`, `general`, `plan`, 사용자 정의 agent, agent 없음 | 없음 |

(테스트 "(K2, H5) C-11: goal, ultragoal and deep-interview belong to the primary alone; ralplan to the primary and its three roles". `open-gajae-explore`, `-document-specialist`는 테스트 목록에 없고 `TOOL_OWNERS`에서 이끌어 냈습니다. 결과는 "없음"입니다.)

### 두 번째 층: 도구의 호출자 검사

숨김을 빠져나와도 `ralplan` 도구가 스스로 거부합니다(`ownerSession`, `src/ralplan-runtime/tool.ts:168-187`). 거부는 `defineTool`(`src/tools/define.ts:44-48`)이 `Error: <문구>` 출력으로 돌려줍니다.

| 조건 | 문구 |
|---|---|
| `sessionID`가 없음 | `a native session is required` |
| agent가 `open-gajae`도 역할 셋도 아님 | `the ralplan tool is not available to <agent>` |
| 역할 셋이 `write`·`status`·`state` 밖의 op | `<agent> may only use write, status and state` |
| 계보 조회 실패 | `could not resolve the session lineage for ralplan` |

op별 거부는 [ops.md](ops.md)에 있습니다.

### 역할 권한 규칙

`roleRules`(`src/config.ts:274-328`). `registerAgents`가 각 agent의 `permissions` 뒤에 붙이고, 호스트(OpenCode) 설정의 `agents.<id>` 권한 규칙이 그 뒤에 붙어 이깁니다(`:268-273` 주석, R4). 플러그인 설정 `open-gajae.jsonc`의 `agents.<id>`는 `model`과 `variant`만 받으므로(`:143`) 권한을 바꾸지 못합니다. 호스트는 규칙을 `findLast`로 평가하고 마지막 규칙이 `*` deny인 도구를 요청에서 뺍니다(`opencode/packages/core/src/tool.ts:231,292-295` `whollyDisabled`, 확인함). 모든 역할에 공통 묶음 `readonlyDenies`(`:261-266`: `question`, `deep-interview`, `opencode_session_move`, `opencode_session_rename`)가 붙습니다.

| agent | 거부 | `ralplan` |
|---|---|---|
| `open-gajae` | 없음 | 사용 |
| `open-gajae-planner` | `edit`, `subagent`(뒤에 explore·document-specialist 허용), `readonlyDenies`, `ultragoal`, `goal` | 사용 (규칙 없음) |
| `open-gajae-architect`, `-critic` | `edit`, `subagent`, `readonlyDenies`, `ultragoal`, `goal` | 사용 (lane 쓰기용) |
| `open-gajae-executor` | `subagent`(뒤에 explore·architect 허용), `readonlyDenies`, `ultragoal`, `goal`, `ralplan` | 거부 (plan S2) |
| `open-gajae-explore`, `-document-specialist`, `-cleaner`, `-lateral-reviewer` | `edit`, `subagent`, `readonlyDenies`, `ultragoal`, `goal`, `ralplan` | 거부 |

- `shell` 규칙은 없습니다(R5/R6). 세 역할 모두 `shell`을 가지고, 읽기 전용 사용은 프롬프트만 요구합니다.
- `edit` 권한 이름은 호스트의 `write`, `edit`, `patch`가 함께 씁니다(`opencode/packages/core/src/tool/plugin/{write,edit,patch}.ts`가 모두 `permission: "edit"`, 확인함). 그래서 세 역할은 계획 가드와 상관없이 파일 도구를 쓸 수 없고, 산출물은 `ralplan write`의 `content`로만 남깁니다(D-T4, R-O4). executor는 `edit`이 있지만 계획 가드와 항상 차단은 executor에게도 똑같이 걸립니다.
- `ralplan` 도구의 권한 이름은 `ralplan`입니다(`src/ralplan-runtime/tool.ts:270`).

### 세 겹이 겹치는 방식

```
1. roleRules   deny("ralplan")               → 다섯 역할에게서 호스트가 도구를 뺌 (호스트 설정의 agents.<id> 권한이 풀 수 있음)
2. hideTools   context/compaction/generate   → 주인 넷 밖의 모든 agent 요청에서 지움 (설정과 상관없이)
3. 도구 자신    ownerSession                  → 주인이 아니면 거부, 역할은 write/status/state만
```

`build`처럼 이 플러그인이 만들지 않은 agent에게는 1이 없고 2와 3이 막습니다. 세 역할은 1·2를 통과하고 3에서 op가 제한됩니다.

## 코드가 강제하는 것과 SKILL만 요구하는 것

| 규칙 | 코드 | SKILL·프롬프트만 |
|---|---|---|
| `plans/ralplan/**`와 `state/**`를 `write`/`edit`/`patch`로 바꾸지 못함 | 예 (모든 agent, 모든 세션, 대소문자 구분) | |
| 그 파일들을 `shell`로 바꾸지 않음 | | 예 (역할 프롬프트, SKILL 경계) |
| 계획 중 제품 파일 `write`/`edit`/`patch` 금지 | 예 (주 skill이고 활성, phase ∉ R일 때, 계보 전체, 임시 경로 예외) | |
| 계획 중 `shell`로 파일 변경·커밋·푸시 금지 | | 예 (Planning/Execution Boundary, 편차 11) |
| 큰 산출물은 임시 루트에만 둠 | `write` 도구는 가드가 강제, `ralplan write {path}`는 `readTempArtifact`가 강제 | heredoc 경로는 글로만 |
| 실행 skill을 부르지 않음, 구현을 맡기지 않음 | `ralplan` 밖으로의 체인은 ultragoal 쪽만 일부 ([entry-and-handoff.md](entry-and-handoff.md)) | 예 |
| 멈춘 계획 턴을 이어 감 | 예 (주 skill일 때, 30번·45분 breaker) | |
| 합의 뒤 승인 질문에서 멈춤 | `final`은 T라 continuation이 멈춤 | 승인 질문을 실제로 묻는 일 |
| 끝나면 `ralplan clear` | | 예 (continuation 문구) |
| 압축 뒤 계약을 요약에 유지 | 압축 문맥이 안내 | 예 |
| 역할은 `question`·파일 도구·다른 workflow 도구를 쓰지 않음 | 예 (`roleRules`, 숨김, 호출자 검사) | |
| 역할은 읽기 전용 `shell`만 | | 예 (역할 프롬프트) |
