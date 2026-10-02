# 진입과 인계

이 문서는 세션이 ultragoal에 **들어오는 길**과 ultragoal에서 ralplan·deep-interview로 **넘기고 돌아오는 길**을 코드 그대로 적습니다. 다루는 것은 `ultragoal` 키워드와 `@ultragoal` 멘션 안내, 턴 표식, `skill ultragoal` 로드 때 훅이 하는 일, `goal-planning` 단계, `ralplan handoff(to="ultragoal")`, `ultragoal handoff(to, reason)`, 두 방향이 함께 쓰는 저널 인계(`handoffWorkflowTx`), 체인 가드입니다.

다른 주제는 해당 문서에 있습니다. 전체 흐름과 코드 지도는 [README.md](README.md), op 하나하나의 입력과 결과는 [ops.md](ops.md), `goal-planning` 동안의 편집 거부와 산출물 가드는 [guards.md](guards.md), goal 도구와 continuation은 [goal-loop.md](goal-loop.md), 활성 행·스냅숏·감사 로그·저널 파일 형식은 [state-and-files.md](state-and-files.md), 알려진 한계는 [known-limits.md](known-limits.md)를 보세요.

## 용어

| 용어 | 뜻 | 코드 |
|---|---|---|
| 계보 루트 (lineage root) | subagent는 자식 세션에서 돕니다. 부모를 끝까지 따라 올라간 첫 세션이 계보 루트입니다. workflow 파일은 모두 계보 루트의 세션 폴더(`.open-gajae/_session-<created>-<id>/`)에 있습니다. 조회가 실패하면 예외를 던집니다(fail closed). | `src/hooks.ts`의 `rootSession` |
| 보이는 주 skill (visible primary skill) | 활성 행(`state/active/<skill>.json`) 중 순위가 가장 높은 것. 순위는 `deep-interview → ralplan → ultragoal` 순으로 아래쪽이 이깁니다. `src/hooks.ts`에서 이 값을 읽는 곳은 셋입니다: `goal-planning`·ralplan·deep-interview 계획 가드(`guardPlanning`), ralplan continuation(`decideRalplan`), `visiblePrimary`(프롬프트의 handoff 안내 판정과 체인 가드). deep-interview 쪽에서는 이어가기 판단(`src/deep-interview-runtime/hooks.ts`)과 `deep-interview start`의 거부 판단(`src/deep-interview-runtime/store.ts`)이 읽습니다. 인계 함수(`handoffWorkflowTx`, `ralplanHandoffTx`, `handoffTx`), 진입 게이트(`ultragoalGate`: 턴 표식과 ralplan state로 판단), goal continuation(`decideContinuation`)은 읽지 않습니다. 계산 방법은 [state-and-files.md](state-and-files.md)의 "보이는 주 스킬" 절에 있습니다. | `src/skill-state/rows.ts`의 `readVisiblePrimaryTx` |
| execution | 호스트가 한 번 모델을 돌리는 단위. `session.execution.started`로 시작해 `succeeded`·`failed`·`interrupted` 중 하나로 끝납니다. | `src/hooks.ts`의 `onEvent` |
| 턴 표식 (turn marker) | 지금 execution에서 불러온 workflow skill 이름. 아래 [턴 표식](#턴-표식) 절을 보세요. | `src/hooks.ts`의 `turnSkill` |
| T | ralplan의 "끝난 단계" 집합: `final, handoff, complete, completed, failed, cancelled, canceled, inactive`. | `src/ralplan-runtime/manifest.ts`의 `TERMINAL_PHASES` |
| `goal-planning` | ultragoal의 첫 단계. ultragoal은 켜졌지만 아직 `create`로 목표를 기록하지 않은 상태입니다. | `src/ultragoal-runtime/manifest.ts`의 `ULTRAGOAL_INITIAL_STATE` |

## 진입 경로 한눈에 보기

| 경로 | 무엇이 일어나나 | 상태를 쓰나 |
|---|---|---|
| 프롬프트의 `ultragoal` 키워드 | 안내 한 건만 추가 | 안내는 쓰지 않음(같은 훅의 goal 보류 해제는 쓸 수 있음, 아래) |
| 프롬프트의 `@ultragoal` 멘션 | 안내 한 건, 턴 표식 `ultragoal` | 같음 |
| `open-gajae`의 `skill ultragoal` 로드 | 진입 게이트: 같은 execution에서 ralplan을 불렀고 ralplan이 `active: true`이면서 끝난 단계면 인계, 활성인데 계획 중이면 거부, 그 밖(비활성 `final` 포함)에는 `goal-planning` 시드 | 씀 |
| `ralplan handoff(to="ultragoal")` | 저널 인계. ultragoal이 `goal-planning`으로 켜짐 | 씀 |
| `ultragoal create` 직접 호출 | 스킬을 불러오지 않아도 코드는 막지 않습니다. `goal-planning`을 거치지 않고 곧바로 계획이 생깁니다([ops.md](ops.md)). | 씀 |
| reconcile하는 op로 다시 켜짐 | `goals.json`이 있고 완료가 아니면, `status` 같은 reconcile op가 비활성 ultragoal(`clear`·`handoff` 뒤 등)을 그 계획의 단계로 다시 활성화합니다. 단계는 `deriveRunStatus(goals.json)`이라 계획 상태에 따라 `pending`, `active`, `failed`, `blocked` 중 하나입니다. 예: 목표를 아직 시작하지 않은 계획에서 `clear` 뒤 `status` → `pending`, 활성 행. 시작한 목표가 있으면 `active`입니다. `goal-planning`은 거치지 않습니다. | 씀 |
| `ultragoal state` op | 저장된 단계가 없으면(파일 없음 포함) `{patch:{}}`만으로도 활성 `goal-planning` state와 행을 씁니다. 아래 [`goal-planning`](#goal-planning) 절 | 씀 |

나가는 길은 `ultragoal handoff(to="ralplan" | "deep-interview", reason)`입니다. 실행을 끝내는 `clear`, 완료, goal pause는 [ops.md](ops.md)와 [goal-loop.md](goal-loop.md)에 있습니다.

## 키워드와 멘션 안내

gjc 출처: 없음. 안내 문구는 open-gajae가 만든 것입니다(`src/ultragoal-runtime/messages.ts` 헤더 주석). 결정: D-HE4, PQ-5 (1) B.

### 트리거

호스트의 v2 `prompt` 훅입니다. `src/index.ts`가 `ctx.session.hook("prompt", hooks.prompt)`로 등록하고, 몸체는 `src/hooks.ts`의 `prompt`입니다. 사용자가 프롬프트를 보낼 때마다 한 번 돕니다.

### 검사 순서

```
G1  세션 agent 조회(session.get). 역할 subagent(planner·architect·critic·executor·cleaner)면
    여기서 끝. 아무것도 하지 않음(중단 표시·goal 보류도 건드리지 않음). 조회 실패는 통과.
G2  프롬프트 글에 주입 표식(INJECTION_MARKERS: <ultragoal-notice> 등)이 있으면 끝.
    플러그인이 넣은 글이 다시 들어온 경우를 거릅니다.
 ↓  중단 표시(Esc) 해제. 계보 루트를 구하고, 이 세션이 루트면 goal 보류 해제
    (goal-loop.md). 루트 조회 실패는 기록만 하고 계속.
 ↓  agent가 문자열이고 "open-gajae"가 아니면 끝(안내 없음, R-OD20).
    agent가 없거나 조회에 실패했으면 계속.
 ↓  감지: 멘션은 prompt.skills의 id, 키워드는 detect*Keyword.
 ↓  ralplan이나 deep-interview가 감지됐고 계보 루트를 구했으면 루트의 보이는 주 skill을 읽음.
    ultragoal이면 "ultragoal이 주 skill" 판정. 읽기 실패는 "아님"으로 처리.
 ↓  안내 목록을 만들고, 멘션이 있으면 턴 표식을 세운 뒤 안내를 씀.
```

감지 규칙:

- `@ultragoal` 멘션: 호스트가 넘긴 `event.prompt.skills`에 `{ id: "ultragoal" }`가 있으면 멘션입니다.
- `ultragoal` 키워드: `src/ralplan.ts`의 `detectUltragoalKeyword`. 정규식은 `ULTRAGOAL_KEYWORD` = `/\b(ultragoal)\b/i`입니다. 코드 블록·인용·경로 같은 잡음을 지운 뒤, 질문이나 설명 같은 정보성 문맥이면 버리고, 호출 의도가 보이는 문맥만 인정합니다. ralplan 키워드와 같은 검사입니다(`findActionableRalplanMatch`). `ralph`, `랄프`, `ulw`는 ultragoal을 켜지 않습니다(D-R16).

| 프롬프트 | 키워드로 인정 |
|---|---|
| `force: ultragoal add auth` | 예 |
| `ultragoal 로그인 기능 추가해줘` | 예 |
| `ultragoal로 진행해줘` | 예 |
| `run ultragoal` | 예 |
| `what is ultragoal?` | 아니오 |
| `ultragoal 이 뭐야?` | 아니오 |
| `ralph fix src/a.ts` | 아니오 |

(위 표는 현재 코드로 `detectUltragoalKeyword`를 직접 돌려 확인한 결과입니다.)

### 어떤 안내가 나가나

한 프롬프트에서 안내는 ralplan 계열, ultragoal, deep-interview 순서로 모입니다. ultragoal에 관한 것만 적습니다.

| 조건 | 안내 | TUI 한 줄(`description`) |
|---|---|---|
| ultragoal 감지, 같은 프롬프트에 ralplan 감지 없음, `@ultragoal` 멘션 | `ultragoalMentionNotice()` | `open-gajae: ultragoal mention notice added` |
| ultragoal 키워드만, 글에 `[MODE: ULTRAGOAL]`이 없음 | `ultragoalKeywordNotice()` | `open-gajae: ultragoal keyword notice added` |
| ultragoal과 ralplan이 함께 감지됨 | ultragoal 안내는 없습니다. ralplan 쪽은 평소 규칙을 따릅니다: ultragoal이 주 skill이면 아래 handoff 안내, 아니면 `@ralplan` 멘션 안내, 아니면 ralplan 키워드 안내. 키워드뿐이고 글에 이미 `[MODE: RALPLAN]`이 있으면 ralplan 쪽 안내는 나가지 않습니다. deep-interview 쪽은 따로 판단하므로 같은 프롬프트에서 deep-interview 안내는 나갈 수 있습니다. | — |
| ultragoal이 보이는 주 skill인데 ralplan(키워드 또는 `@ralplan`)이 감지됨 | ralplan 안내 대신 `ultragoalHandoffNotice("ralplan")` | `open-gajae: ultragoal handoff notice added` |
| ultragoal이 보이는 주 skill인데 deep-interview(키워드 또는 `@deep-interview`)가 감지됨 | deep-interview 안내 대신 `ultragoalHandoffNotice("deep-interview")` | `open-gajae: ultragoal handoff notice added` |

안내 문구(`src/ultragoal-runtime/messages.ts`). 모두 `wrapUltragoalInjected("<ultragoal-notice>", …)`로 감쌉니다.

```
[MODE: ULTRAGOAL] Persistent goal execution requested. Load the `ultragoal` skill and follow it for this request.
```

```
[MODE: ULTRAGOAL] Persistent goal execution requested through the `@ultragoal` mention. Load the `ultragoal` skill with the `skill` tool, which starts its goal-planning phase, and follow it for this request.
```

```
[ULTRAGOAL ACTIVE] ralplan was not started because an ultragoal run is active. To switch, call ultragoal handoff(to="ralplan", reason); the goals and progress are kept and can be resumed later.
```

(`deep-interview`일 때는 `ralplan` 두 곳이 `deep-interview`로 바뀝니다.)

감싼 모양은 `src/injection.ts`의 `wrapInjected`가 정합니다.

```
<ultragoal-notice>

[MODE: ULTRAGOAL] Persistent goal execution requested. Load the `ultragoal` skill and follow it for this request.

</ultragoal-notice>

---

```

### 안내를 쓰는 방식

`src/hooks.ts`의 `emitNotices`가 안내마다 `session.synthetic({ sessionID, text, description, resume: false })`를 부릅니다. 새 실행을 시작하지 않는 합성 메시지입니다. 호스트는 이 메시지를 같은 턴의 사용자 메시지 **앞에** 놓습니다(OMC·v1은 뒤에 붙였음, 기록된 편차; `src/hooks.ts` 헤더 주석 기준). TUI는 `description`이 없는 합성 메시지를 숨기므로 안내마다 한 줄 설명을 붙입니다. `synthetic`이 실패하면 표식으로 감싼 안내를 프롬프트 글 끝에 `\n\n`과 함께 붙입니다. 표식이 있으므로 이 글이 다시 `prompt` 훅에 들어와도 G2가 거릅니다.

### 안내가 하지 않는 일

- 안내 자체는 상태 파일을 쓰지 않습니다. ultragoal state, 활성 행, goal 모두 그대로입니다. 다만 같은 `prompt` 훅이 계보 루트 세션에서 `goal.releaseHold`(`src/goal/hooks.ts`)를 부르고, 이것은 지금 goal의 보류 기록이나 0이 아닌 도구 없는 턴 수가 있으면 `state/goal-continuation.json`을 다시 씁니다([goal-loop.md](goal-loop.md)). 키워드·멘션이 없는 프롬프트에서도 똑같이 일어납니다.
- `@ultragoal` 멘션은 호스트가 skill 본문을 메시지에 붙이지만 `skill` 도구 호출은 아닙니다(`ultragoalMentionNotice` 주석). 그래서 멘션만으로는 `goal-planning`이 시작되지 않고, 안내가 `skill` 도구로 불러오라고 말합니다.
- ultragoal이 주 skill일 때 `@ralplan`·`@deep-interview` 멘션이 붙인 skill 본문은 막지 못합니다. 코드가 막는 것은 `skill` 도구 로드(아래 [체인 가드](#체인-가드))와 `ralplan start`뿐입니다.
- 안내를 받는 것은 agent가 `open-gajae`인 세션과, agent가 없거나 조회에 실패한 세션입니다. 역할 subagent 다섯(`open-gajae-planner`, `-architect`, `-critic`, `-executor`, `-cleaner`, `ROLE_SUBAGENTS`)은 G1에서 바로 끝나므로 중단 표시와 goal 보류도 풀지 않습니다. 그 밖의 agent(`open-gajae-explore`, `open-gajae-document-specialist`, `build` 같은 호스트·사용자 agent)는 안내를 받지 않지만 중단 표시를 풀고, 계보 루트면 goal 보류도 풉니다([known-limits.md](known-limits.md) U26).

## 턴 표식

gjc 출처: `session/agent-session.ts:7448,8038-8046` (`src/hooks.ts` 헤더 주석, C-10, PQ-21 A).

턴 표식은 "지금 execution에서 불러온 workflow skill" 하나를 세션마다 기억하는 값입니다. 프로세스 메모리(`turnSkill: Map<sessionID, skill>`)에만 있고 파일에 쓰지 않습니다. 호스트를 다시 켜면 사라집니다.

| 동작 | 언제 | 코드 |
|---|---|---|
| 세움 | 가드를 통과한 `skill` 호출. id가 `ralplan`·`deep-interview`면 모든 agent, `ultragoal`이면 `open-gajae`가 진입 게이트를 통과했을 때 | `executeBefore` → `markTurn(sessionID, callID, skill)` |
| 세움 | 프롬프트의 멘션. `@ralplan`(ultragoal이 주 skill이 아닐 때)이 먼저, 없으면 `@ultragoal`(ralplan 감지가 없을 때), 없으면 `@deep-interview`(ultragoal이 주 skill이 아닐 때) | `prompt` → `markTurn(sessionID, undefined, mentioned)` |
| 되돌림 | 표식을 세운 `skill` 호출이 `status: "error"`로 끝나면 바로 전 값으로 되돌림(없었으면 지움) | `executeAfter`, `markerUndo` |
| 지움 | `session.execution.succeeded`·`failed`·`interrupted` 이벤트마다, 다른 판단보다 먼저 | `onEvent`, `EXECUTION_ENDS` |

표식이 쓰이는 곳은 하나입니다. `skill ultragoal` 진입 게이트가 표식이 `ralplan`인지 봅니다. 즉 "ralplan을 불러온 **같은** execution 안에서 ultragoal을 불러왔는가"를 가립니다.

## `skill ultragoal` 로드

gjc 출처: `tools/skill.ts:170-222`(같은 턴 인계, D-HE6), `hooks/skill-state.ts:429-470`(스킬 로드 시드). 편차: ultragoal 35(시드가 비활성 state를 필드를 살린 채 올림), ultragoal 22(체인 가드), ralplan 34·37.

### 트리거와 검사 순서

호스트의 `execute.before` 도구 훅입니다(`src/hooks.ts`의 `executeBefore`). v2 `skill` 도구의 입력은 `{ id }`입니다.

`execute.before` 단계 이름 A~D는 [guards.md](guards.md)의 것과 같습니다.

```
A  산출물 가드         skill 호출에는 파일 경로가 없어 해당 없음
B  계획 가드           write/edit/patch만 보므로 해당 없음
C  subagent 처리       tool이 "subagent"가 아니므로 건너뜀
D  skill 처리          tool이 "skill"이고 입력의 id가 workflow skill인가
   D-ultragoal  id가 "ultragoal"일 때
     1. event.agent가 "open-gajae"가 아니면 그대로 통과 (시드 없음, 표식 없음)
     2. 진입 게이트 ultragoalGate(sessionID)
          거부 문구를 돌려주면 → 차단(입력을 {}로 바꾸고 execute.after가 문구로 바꿔 씀)
          undefined면 → 턴 표식을 "ultragoal"로 세우고 로드 진행
   D-chain      id가 "ralplan"·"deep-interview"일 때 → 아래 체인 가드
```

차단 방식(입력 무효화와 `execute.after`의 오류 바꿔 쓰기)은 [guards.md](guards.md)에 있습니다.

### 진입 게이트 분기

`src/hooks.ts`의 `ultragoalGate`. 계보 루트의 `workflowTransaction` 하나 안에서 돕니다. 턴 표식은 **호출한 세션**의 값을 봅니다.

```
표식 == "deep-interview" ?
 ├ 예 → deep-interview 로드 게이트 gateTx(tx, root, "ultragoal")
 │       거부(interviewing, 모르는 phase, 활성 handoff의 인계 실패) → 로드 거부
 │       인계함(활성 handoff, 또는 끝난 인터뷰 + 유효 spec) → 로드 진행(시드는 하지 않음)
 │       통과(state 없음·읽기 실패, 비활성 handoff, 유효 spec 없는 끝난 인터뷰) → 아래로
표식 == "ralplan" ?
 ├ 예 → ralplan state 읽기(읽기 실패는 "없음"으로)
 │       active == true 이고 phase가 알려진 단계(isKnownPhase)인가?
 │        ├ phase ∉ T  → 거부: RALPLAN_RUNNING_REFUSAL
 │        └ phase ∈ T  → ralplanHandoffTx(tx, root, HOOK_OWNER,
 │                         "skill ultragoal loaded after ralplan")   ── 같은 execution 인계
 │                        → 로드 진행(시드는 하지 않음)
 │       그 밖(비활성, 없음, 읽기 실패, 모르는 phase) → 아래 시드로
 └ 아니오 → seedUltragoalTx(tx, root, HOOK_OWNER) → 로드 진행
```

deep-interview 로드 게이트는 deep-interview 개정에서 더했습니다(`src/deep-interview-runtime/hooks.ts`의 `gateTx`, 그 개정 계획의 DR-21, PQ-11 E/B, PQ-36 C, U-1 A). 거부 문구는 `open-gajae: refusing to chain from "deep-interview" (phase=<phase>) into "ultragoal". …`입니다. 자세한 내용은 [deep-interview 문서](../deep-interview/entry-and-handoff.md)에 있습니다.

**활성 run이 `goal-planning`으로 돌아가는 예외**(ultragoal SKILL `:10`, PQ-36 C): 같은 execution에서 `skill deep-interview`를 불렀고 그 인터뷰가 유효 spec과 함께 끝나 있으면, 게이트가 deep-interview → ultragoal 인계를 합니다. 이 인계는 callee를 언제나 초기 단계로 쓰므로, ultragoal이 이미 실행 중(`pending`, `active` 등)이어도 `goal-planning`으로 돌아갑니다. 그러면 `create` 전까지 제품 `write`/`edit`/`patch`가 거부되고, `create`가 `goals.json`을 덮어씁니다(ledger와 `progress.txt`는 남음). goal은 그대로라 goal 루프는 계속 돕니다. 아래 시드의 "실행 중이면 phase 유지"는 이 경로에는 적용되지 않습니다. 알려진 한계는 [deep-interview known-limits](../deep-interview/known-limits.md) K15입니다.

거부 문구(`src/ralplan-runtime/store.ts`의 `RALPLAN_RUNNING_REFUSAL`):

```
ralplan planning is running; finish it first: choose "Approve execution via ultragoal" at its approval step, or stop ralplan (`ralplan state` with {"active": false}) and try again.
```

같은 execution 인계는 `ralplan handoff` op와 **같은 함수**(`ralplanHandoffTx`)를 씁니다. 다른 점은 쓰는 주체입니다. 감사 행 `owner`는 `open-gajae-hook`, 두 state의 `_meta.updatedBy`는 `ralplan_hook`입니다. 넘기는 이유 문자열은 어디에도 기록되지 않습니다(ralplan 쪽 인계에는 `recordCaller`가 없음). 인계 결과는 [ralplan handoff](#ralplan-handofftoultragoal)와 같습니다.

표식이 `ralplan`이 아닐 때, 예를 들어 ralplan을 **이전** execution에서 불렀다면, ralplan이 `final`에 활성으로 있어도 인계하지 않고 시드합니다. 이때 ralplan state는 `active: true`, `final`로 남고, 시드가 ultragoal 행을 쓰면서 ralplan 행만 지웁니다(아래 시드 ④). ralplan SKILL 9단계는 조건 없이 "Before loading the `ultragoal` skill, hand ralplan off"라고 지시하고, 이어서 이유를 설명합니다: 같은 execution에서 불러오면 로드가 스스로 넘기지만, 나중 execution에서 불러오면 인계 없이 들어가므로 `final` 뒤에는 `ralplan handoff(to="ultragoal")`를 먼저 부르라는 것입니다(`skills/ralplan/SKILL.md`).

### 시드 (`seedUltragoalTx`)

`src/ultragoal-runtime/store.ts`의 `seedUltragoalTx`. 반환값은 `"seeded" | "kept" | "corrupt"`이고, 게이트는 이 값을 보지 않습니다.

```
① ultragoal state 읽기 (state/ultragoal-state.json)
   읽기 실패(깨진 JSON 등) → "corrupt". 아무것도 쓰지 않음. 로드는 그대로 진행.
② state가 active == true → "kept". state는 건드리지 않음.
③ 그 밖(없음, 비활성) → 기존 필드 위에 병합해 씀:
     skill: "ultragoal", version: 2, active: true,
     current_phase: "goal-planning", updated_at: <지금>
     session_id: 문자열이 아니면 계보 루트 id
   _meta.updatedBy: "ultragoal_hook"
   감사 행: category state, verb write, owner open-gajae-hook,
            mutation_id "ultragoal:seed:<시각>", from_phase <이전 phase>, to_phase goal-planning
④ 활성 행 동기화(syncActiveRowTx, active: true, phase: state의 current_phase)
     - 윗단계 행 state/active/deep-interview.json, ralplan.json 삭제
       (있을 때만, 감사 verb remove-superseded-pipeline-entry)
     - state/active/ultragoal.json 씀 (감사 write-active-entry, HUD 포함)
     - 스냅숏 state/skill-active-state.json 다시 만듦 (감사 rebuild-active-snapshot)
```

예:

- 처음 불러올 때: state가 없으므로 `goal-planning`으로 새로 씁니다.
- `clear`(`active: false`, `complete`)나 완료, `ultragoal handoff` 뒤에 다시 불러올 때: 비활성이므로 `goal-planning`으로 올립니다. `goals`, `counts`, `status`, `handoff_to` 같은 이전 필드는 **그대로 남습니다**. 다음 reconcile이 파생 필드를 다시 씁니다. 편차 35의 영향으로 이 경우에도 `goal-planning` 편집 가드가 걸립니다.
- 실행 중(`pending`, `active` 등)에 다시 불러올 때: state의 phase를 유지하고 행만 다시 씁니다(`activated_at`, `updated_at`이 새 시각).
- state가 깨졌을 때: 아무것도 쓰지 않고 로드만 됩니다. SKILL의 "Corrupt current-session state recovery"는 `ultragoal({"op":"clear","force":true})`를 먼저 부르라고 합니다.

### 게이트 안에서 실패하면

`executeBefore`의 `try`가 게이트의 예외를 받아 `console.warn`으로 기록(`[open-gajae:hooks] execute.before handler failed`)만 하고, **로드를 막지 않습니다**(fail open). 표식도 세우지 않고, 모델에게 보이는 알림도 없습니다. 이런 경우입니다.

- 계보 루트 조회 실패.
- 같은 execution 인계 중 예외. 예: ultragoal state가 깨져 `existing state for ultragoal is corrupt or tampered (…); refusing to hand off`. 이 검사는 저널을 만들기 전에 하므로 이 경우 쓴 파일은 없습니다.
- 그 밖의 저장소 오류. 저널을 만든 뒤에 나면 거기까지 쓴 state·행과 `pending` 저널이 남습니다([저널 수명](#저널-수명)).

시드 경로에서 state가 깨진 경우(`"corrupt"`)는 예외가 아니라 반환값이라 기록조차 남지 않습니다.

## `goal-planning`

gjc 출처: `skill-state/initial-phase.ts:13-19`(초기 단계), `skill-state/workflow-mutation-guard.ts:28-29`(편집 가드 문구). 결정: DR-21, DR-22, PQ-13 A.

**뜻**: ultragoal state가 `active: true`, `current_phase: "goal-planning"`인 상태입니다. ultragoal은 켜졌지만 이번 계획의 목표를 아직 `create`로 기록하지 않았습니다.

**들어오는 길**:

| 경로 | 쓰는 주체 |
|---|---|
| `skill ultragoal` 로드의 시드 | `seedUltragoalTx` |
| ralplan → ultragoal 인계(`ralplan handoff` op 또는 같은 execution의 `skill ultragoal`) | `handoffWorkflowTx`, callee 초기 단계 |
| `ultragoal state` op, 저장된 단계가 없을 때(`{patch: {}}`도 됨), 또는 매니페스트 밖일 때 `{current_phase: "goal-planning"}` | `patchStateTx` |
| `ultragoal state` op, 저장된 단계가 이미 `goal-planning`일 때 `{active: true}` | `patchStateTx` |

`ultragoal state` op(`src/ultragoal-runtime/store.ts`의 `patchStateTx`)는 이렇게 동작합니다.

- 새 단계는 patch의 `current_phase`(또는 `phase`), 없으면 병합 결과의 `current_phase`, 그것도 없으면 저장된 단계, 그것도 없으면 `ULTRAGOAL_INITIAL_STATE`(`goal-planning`)입니다. `active`가 불리언이 아니면 `true`로 채웁니다.
- 전이 검사(`ultragoalPhasePatchError`)는 새 단계가 매니페스트 단계인지 보고, **저장된 단계가 매니페스트 단계일 때만** 전이 표(`ULTRAGOAL_TRANSITIONS`)를 봅니다. 표에는 `goal-planning`으로 들어오는 줄이 없습니다.
- 그래서 state 파일이 없으면 `ultragoal state {patch: {}}`만으로 활성 `goal-planning` state와 활성 행이 생깁니다. `{active: false}`로 끈 `goal-planning`은 `{active: true}`로 다시 켜집니다(같은 단계는 허용).
- 저장된 단계가 다른 매니페스트 단계(예: `clear` 뒤 `complete`)면 `invalid ultragoal phase transition from complete to goal-planning`으로 거부됩니다.

(위 네 가지는 임시 폴더에서 `patchStateTx`를 직접 불러 확인했습니다. op 전체는 [ops.md](ops.md).)

**걸리는 것**: ultragoal이 보이는 주 skill이고 state가 `goal-planning`이면, 계보 전체에서 제품 파일 `write`/`edit`/`patch`가 거부됩니다. OS 임시 경로만 허용됩니다. 조건, 문구, 실패 처리는 [guards.md](guards.md)에 있습니다.

**끝나는 길**: `goal-planning`을 끝내는 것은 state를 다시 쓰는 op입니다. SKILL이 정한 길은 `create`입니다.

| op | 결과 단계 | 비고 |
|---|---|---|
| `create` | `pending`, `active: true` | 정상 경로. `goals.json`을 새로 쓰고 끝의 reconcile이 단계를 `goals.json`에서 다시 계산합니다. 새 계획은 모든 목표가 `pending`이므로 `deriveRunStatus`가 `pending`을 냅니다. |
| `status`, `classify_blocker` | 계획이 없으면 `missing`, `active: false`(활성 행 삭제). 이전 계획이 있으면 그 계획의 상태 | 계획 없이도 reconcile까지 갑니다. SKILL은 `create` 전에 부르지 말라고 합니다. |
| `next`, `checkpoint`, `add`/`revise`/`supersede`, `record_review_blockers`, `record_critic_verdict` | 이전 계획이 있으면 그 계획의 상태 | 계획이 없으면 reconcile 전에 거부됩니다(`No ultragoal plan found. Run \`ultragoal create\` first.` 또는 `record_critic_verdict requires an active ultragoal plan`). 이전 `goals.json`이 남아 있으면(`clear`나 인계 뒤 다시 들어온 경우) 이 op들도 `goal-planning`을 끝냅니다. SKILL은 `status`·`classify_blocker`만 이름을 듭니다. |
| `state` (patch) | 전이 표상 다른 단계로는 `pending`, `handoff`만 허용. `{active:false}`면 단계는 그대로 두고 행이 지워짐 | [ops.md](ops.md) |
| `clear` | `complete`, `active: false` | |
| `handoff` | `handoff`, `active: false` | 아래 |

`create`는 단계를 확인하지 않습니다. `goal-planning`이 아니어도, 스킬을 불러오지 않았어도 호출할 수 있습니다. `create`의 입력·쓰기·goal 켜기는 [ops.md](ops.md)에 있습니다.

## `ralplan handoff(to="ultragoal")`

gjc 출처: `gjc-runtime/state-runtime.ts:1572-1881`(인계 동사), `tools/skill.ts:42-61,170-171,203-221`(단계 검사가 있던 곳). 편차: ralplan 22(SKILL 9단계의 state 쓰기 + 스킬 도구 인계가 op 하나로), ralplan 34(T 단계와 `active` 요구, DR-7, R-OD18).

### 입력과 호출자 검사

`src/ralplan-runtime/tool.ts`의 `ralplanTool` → `ownerSession` → `handoff` 분기.

| 검사 | 거부 문구(결과는 `Error: <문구>`) |
|---|---|
| 세션 id 없음 | `a native session is required` |
| agent가 `open-gajae`도 역할(planner·architect·critic)도 아님 | `the ralplan tool is not available to <agent>` |
| 역할 agent | `<agent> may only use write, status and state` |
| 계보 루트 조회 실패 | `could not resolve the session lineage for ralplan` |
| `to`가 `"ultragoal"`이 아님(생략 포함). 입력 스키마가 `z.enum(["ultragoal"])`이라 다른 값은 스키마 단계에서 막힘 | `to must be "ultragoal"` |

그다음 `src/ralplan-runtime/store.ts`의 `ralplanHandoff`가 계보 루트의 트랜잭션 하나에서 `ralplanHandoffTx(tx, root, RUNTIME_OWNER, "ralplan handoff to ultragoal")`를 부릅니다. 마지막 인자(이유)는 `handoffWorkflowTx`의 `reason`으로 넘어가지만, 이 값을 쓰는 곳은 `recordCaller`뿐이고 ralplan 쪽은 `recordCaller`를 넘기지 않으므로 어디에도 저장되지 않습니다. 진입 게이트가 넘기는 `"skill ultragoal loaded after ralplan"`도 같습니다.

### `ralplanHandoffTx` 검사 순서

```
① ralplan state 읽기
     깨짐 → 거부 (readStateForMutation 문구)
     없음 → 거부
② phase ∈ T 인가? 아니면 거부            ← active보다 먼저 봄
③ run 폴더의 pending-approval.md 경로 찾기 (있을 때만)
④ active != true 이면 거부
     phase == "handoff" → "이미 넘김" 문구
     그 밖               → "활성 아님" 문구
⑤ handoffWorkflowTx(caller "ralplan", callee "ultragoal")   ── 아래 공통 인계
```

거부 문구(`<…>`는 실제 값):

```
existing ralplan state is corrupt or tampered (<오류>); refusing to overwrite <state 경로>. Reset it with `ralplan clear` and force: true.
```

```
there is no ralplan state in this session to hand off
```

```
ralplan can hand off to ultragoal only from a finished phase (final, handoff, complete, completed, failed, cancelled, canceled, inactive); the current phase is <phase 또는 (none)>. Record the final plan first.
```

```
ralplan was already handed off (inactive, phase handoff); continue in the `ultragoal` skill.
```

```
ralplan is not active (phase <phase>), so there is nothing to hand off: Stop here or `clear` ended the run. To execute the plan, load the `ultragoal` skill, then call `ultragoal create` with the plan's goals (the approved plan: <경로>).
```

(마지막 문구의 괄호 부분은 `pending-approval.md`가 있을 때만 붙습니다.)

공통 인계에서 나오는 거부: ultragoal state가 깨졌으면 `existing state for ultragoal is corrupt or tampered (<오류>); refusing to hand off`. 저널을 만들기 전이라 아무것도 쓰지 않습니다.

예:

- `ralplan start` 직후(`planner`)에 부르면 ②에서 "finished phase" 문구로 거부됩니다. `active: false`인 `planner`도 같은 문구입니다.
- **Stop here**(`ralplan state {"active": false}`, 단계는 `final`) 뒤에 부르면 ④의 "not active (phase final)" 문구입니다. 이때 ultragoal state는 만들지 않습니다([known-limits.md](known-limits.md) U25).
- 한 번 넘긴 뒤 다시 부르면 "already handed off" 문구입니다. 같은 execution의 `skill ultragoal`이 먼저 넘긴 뒤 SKILL 9단계대로 부를 때도 같습니다([known-limits.md](known-limits.md) U8).
- `ralplan clear` 뒤(`complete`, 비활성)는 "not active (phase complete)" 문구입니다.

### 결과 문구

첫 줄 뒤에 인계 영수증을 2칸 들여쓰기 JSON으로 붙입니다. 계획 경로는 이 글에만 실려 갑니다(D-HE1, [known-limits.md](known-limits.md) U6).

```
Handed off to ultragoal: ralplan is inactive (phase handoff) and ultragoal is active in goal-planning. Load the `ultragoal` skill now and call `ultragoal create` with the approved plan's goals (the approved plan: <세션 폴더>/plans/ralplan/<run_id>/pending-approval.md).
{
  "ok": true,
  "from": "ralplan",
  "to": "ultragoal",
  "handoff_at": "<시각>",
  "mutation_id": "ralplan:handoff:ultragoal:<시각>",
  "phases": {
    "from": "handoff",
    "to": "goal-planning"
  },
  "paths": {
    "from": "<세션 폴더>/state/ralplan-state.json",
    "to": "<세션 폴더>/state/ultragoal-state.json",
    "active_state": "<세션 폴더>/state/skill-active-state.json"
  }
}
```

`pending-approval.md`가 없으면 ` (the approved plan: …)` 부분이 빠집니다. 경로는 모두 절대 경로입니다.

### 인계 뒤

- ralplan: `active: false`, `handoff`. 활성 행은 지워지지 않고 비활성 `handoff_to` 행으로 남습니다(ralplan 편차 19 철회, PQ-6 A). 그래서 ralplan 가드와 ralplan continuation은 멈춥니다.
- ultragoal: `active: true`, `goal-planning`, 활성 행. 보이는 주 skill이 ultragoal이 되어 `goal-planning` 편집 가드와 체인 가드가 걸립니다.
- goal은 건드리지 않습니다. goal은 이어지는 `create`가 켭니다.
- 남은 비활성 ralplan 행은 다음에 ultragoal 행을 활성으로 쓸 때(시드, `create` 등의 reconcile) 윗단계 행으로 지워집니다.
- 다음 할 일은 SKILL이 지시합니다. `skill ultragoal`을 불러오고(이미 활성이므로 시드는 `"kept"`), 최종 계획을 읽어 `create`를 부릅니다.

## `ultragoal handoff(to, reason)`

gjc 출처: `gjc-runtime/state-runtime.ts:1572-1881`(인계), `skill-state/active-state.ts:969-1015`(행). 편차: ultragoal 39(원장 `workflow_handoff`), 1(`progress.txt`의 `HANDOFF` 메모). deep-interview callee의 단계와 행을 다르게 쓰던 ultragoal 편차 33은 deep-interview 개정에서 철회되었습니다. gjc의 `gjc state ultragoal handoff` 동사가 `ultragoal` 도구의 op가 된 것은 `src/ultragoal-runtime/tool.ts` 헤더가 편차 25로 묶지만, 루트 README의 편차 25 행은 `doctor`, `state`, `clear`만 적습니다.

### 입력

`src/ultragoal-runtime/tool.ts`의 입력 스키마 중 이 op가 쓰는 것:

| 필드 | 형식 | 검사 |
|---|---|---|
| `to` | `"ralplan"` 또는 `"deep-interview"` | 다른 값은 스키마에서 거부. 생략하면 `to is required for ultragoal handoff` |
| `reason` | 문자열 | 앞뒤 공백을 뺀 값이 비면 `reason is required (a non-empty string)` |

호출자 검사는 모든 `ultragoal` op와 같습니다. `open-gajae`만 부를 수 있고(`the ultragoal tool is not available to <agent>`), 계보 루트의 `workflowTransaction` 하나에서 `src/ultragoal-runtime/store.ts`의 `handoffTx`가 돕니다.

### 검사

`handoffTx`와 `handoffWorkflowTx`가 하는 검사는 이것뿐입니다.

| 조건 | 거부 문구 |
|---|---|
| ultragoal state 파일이 없음 | `ultragoal handoff: caller is not active (no mode-state file at <경로>)` |
| ultragoal state가 깨짐 | `existing state for ultragoal is corrupt or tampered (<오류>); refusing to hand off` |
| callee state가 깨짐 | `existing state for <callee> is corrupt or tampered (<오류>); refusing to hand off` |

입력에서는 `to`와 `reason`만 검사하고, ultragoal이 **활성인지, 어느 단계인지는 보지 않습니다**. 파일만 있으면 `clear` 뒤(`complete`), `missing`, 이미 `handoff`인 상태에서도 인계가 진행되고, 두 번 연속 불러도 두 번 모두 성공합니다. callee가 이미 활성이어도 초기 단계로 되돌립니다. 예: `architect` 단계로 활성인 ralplan에 넘기면 `planner`로 돌아가고 `invalid_transition_detected` 감사 행이 하나 남습니다. gjc의 인계 동사도 파일 존재만 봅니다(`src/ralplan-runtime/store.ts`의 `ralplanHandoffTx` 주석). 비활성 ralplan을 거부하는 `ralplan handoff`(R-OD18)와는 이 점이 다르고, 이 비대칭을 적은 루트 README 편차 행은 없습니다.

### 쓰는 것

`handoffWorkflowTx(caller "ultragoal", callee to, owner open-gajae-runtime, reason, recordCaller)`. 단계는 [공통 저널 인계](#공통-저널-인계-handoffworkflowtx)에 있고, 결과만 정리하면 이렇습니다.

| 대상 | `to: "ralplan"` | `to: "deep-interview"` |
|---|---|---|
| callee state | `state/ralplan-state.json`: 기존 필드 유지(`run_id` 등) + `active: true`, `current_phase: "planner"`, `handoff_from: "ultragoal"`, `handoff_at` | `state/deep-interview-state.json`: 기존 필드 유지(`rounds`, `spec_*` 등) + `active: true`, `current_phase: "interviewing"`, `handoff_from: "ultragoal"`, `handoff_at` |
| ultragoal state | 기존 필드 유지 + `active: false`, `current_phase: "handoff"`, `handoff_to`, `handoff_at` | 같음 |
| 활성 행 | ultragoal 비활성 `handoff_to` 행, ralplan 활성 `planner` 행 | ultragoal 비활성 `handoff_to` 행, deep-interview 활성 `interviewing` 행 |
| 보이는 주 skill | ralplan | deep-interview |
| 원장 `ultragoal/ledger.jsonl` | `{"event":"workflow_handoff","to":"ralplan","reason":…}` 한 줄(`eventId`, `timestamp` 포함) | `to: "deep-interview"`로 같음 |
| `ultragoal/progress.txt` | `HANDOFF` 메모 추가 | 같음 |
| `ultragoal/goals.json` | 그대로 | 그대로 |
| goal (`state/goal-state.json`) | 그대로 | 그대로 |
| `_meta.updatedBy`(두 state) | `ultragoal_tool` | 같음 |

`progress.txt`에 붙는 메모 모양(`src/ultragoal-runtime/progress.ts`의 `progressForHandoff` → `appendProgressNote`, 파일이 없으면 머리부터 새로 만듦):

```

## [2026-09-30 12:34] - HANDOFF

**Reason:**
- to ralplan: the plan needs a new design

---
```

인계는 reconcile을 돌리지 않습니다. ultragoal state에서 바뀌는 것은 caller 필드(`skill`, `version`, `active: false`, `current_phase: "handoff"`, `handoff_to`, `handoff_at`, `updated_at`)뿐이고, 파생 필드(`status`, `counts`, `active_goal_id` 등)는 인계 직전 값으로 남습니다.

### 결과

gjc 쓰기 영수증 형식의 한 줄 JSON입니다(`renderWriteReceipt`, 값이 `undefined`인 키는 뺌).

```
{"ok":true,"from":"ultragoal","to":"ralplan","handoff_at":"<시각>","mutation_id":"ultragoal:handoff:ralplan:<시각>","phases":{"from":"handoff","to":"planner"},"paths":{"from":"<세션 폴더>/state/ultragoal-state.json","to":"<세션 폴더>/state/ralplan-state.json","active_state":"<세션 폴더>/state/skill-active-state.json"}}
```

### 인계 뒤

**goal은 그대로입니다.** 그래서 활성 goal이 있으면 인계 뒤에도 goal continuation이 평소 규칙대로 들어옵니다. 평소 규칙이란, 계보 루트 세션의 `session.execution.succeeded`에서만 판단하고, Esc 뒤(다음 사용자 프롬프트까지), 자식 execution이 돌고 있는 동안, 보류 중에는 건너뛰는 것입니다. goal이 활성인 동안은 goal 경로만 돌고 ralplan continuation은 판단하지 않습니다(D-TL6). 예외는 deep-interview로 넘긴 경우입니다: deep-interview가 `interviewing`이나 `handoff`에 활성인 동안은 deep-interview가 턴을 맡고 goal 경로는 건너뜁니다(deep-interview 편차 16). 자세한 조건은 [goal-loop.md](goal-loop.md)에 있습니다. SKILL도 "goal continuation keeps prompting while you plan in ralplan; while deep-interview is active, the interview's own continuation takes the turn instead"라고 적습니다.

ralplan으로 넘긴 뒤:

- 체인 가드가 풀려 `skill ralplan`을 불러올 수 있습니다(주 skill이 ralplan).
- 넘겨받은 ralplan run은 `planner`에서 활성이고 `run_id`를 그대로 가집니다. SKILL은 `ralplan start`를 부르지 말고 `ralplan write`로 이어 쓰라고 합니다. 코드도 `start`를 거부합니다: `ralplan start`는 ralplan state가 `active: true`이면 run과 인계 메타를 그대로 두고 거부합니다(ralplan 편차 39, [known-limits.md](known-limits.md) U13).
- 계획이 끝나면 `ralplan handoff(to="ultragoal")`(또는 `skill ralplan`을 부른 같은 execution의 `skill ultragoal`)로 돌아옵니다. ultragoal은 `goal-planning`으로 돌아가고, `create`가 `goals.json`을 새로 씁니다.

deep-interview로 넘긴 뒤:

- 보이는 주 skill은 deep-interview입니다. deep-interview 편집 가드와 deep-interview 이어가기가 걸리고, 이어가기는 goal 루프보다 먼저 판단합니다: deep-interview가 `interviewing`이나 `handoff`에 활성인 동안 goal 루프는 건너뜁니다(deep-interview 편차 16). `goal-planning` 가드, ultragoal 체인 가드, ralplan continuation은 걸리지 않습니다.
- 넘겨받은 인터뷰는 `deep-interview start` 없이 `deep-interview write`로 이어 씁니다. 라운드와 spec 필드는 병합으로 남습니다. deep-interview state는 `deep-interview` 도구만 바꿉니다.
- 돌아오는 길은 `deep-interview handoff(to: "ultragoal")`(spec을 `deep-interview spec`으로 저장한 뒤), 또는 Phase 5의 **Refine with ralplan consensus** → `deep-interview handoff(to: "ralplan")` → `ralplan write`로 이어 쓰기 → `final` → `ralplan handoff(to="ultragoal")`입니다. ultragoal SKILL의 "Handoff back to planning"도 두 길을 적고, ralplan이나 deep-interview를 진행하는 동안 `ultragoal` op를 부르지 말라고 합니다. 코드상으로는 이 밖에 같은 execution의 `skill ultragoal` 로드(위 진입 게이트)와 아래의 reconcile op로도 돌아올 수 있습니다.

두 경우 모두, 넘긴 뒤 `ultragoal` op를 부르면 조심해야 합니다. reconcile을 하는 op(`status` 포함)의 결과는 `goals.json`에 달려 있습니다(`reconcileUltragoalTx`: `active = file !== undefined && status !== "complete"`).

- `goals.json`이 있고 완료가 아니면: ultragoal이 그 계획의 단계로 다시 활성이 되고, `syncActiveRowTx`가 활성 행을 쓰면서 윗단계 행(ralplan, deep-interview)을 지웁니다. ralplan state나 deep-interview state는 활성으로 남습니다.
- `goals.json`이 없으면(`status`, `classify_blocker`만 여기까지 옴): `missing`, `active: false`가 되고 ultragoal 자신의 행만 지웁니다. 다른 행은 그대로입니다.
- 계획이 완료면: `complete`, `active: false`로 ultragoal 행만 지웁니다.

SKILL은 "do not call `ultragoal` ops"라고 적어 두었을 뿐 **코드는 막지 않습니다.**

## 공통 저널 인계 (`handoffWorkflowTx`)

gjc 출처: `gjc-runtime/state-runtime.ts:1572-1881`(`handleHandoffUnlocked`), `gjc-runtime/state-writer.ts:1009-1068`(감사용 `invalid_transition_detected`), `skill-state/initial-phase.ts:13-19`, `skill-state/active-state.ts:969-1015`(`applyHandoffToActiveState`), 저널은 `gjc-runtime/state-writer.ts:82-92,1590-1640`. 편차: ultragoal 39, ralplan 17(봉투 영수증·체크섬·`state_revision` 없음), 영수증에 gjc의 state별 영수증 대신 `mutation_id`. "`--force`가 없어 깨진 state는 거부"는 `src/skill-state/handoff.ts` 헤더가 ralplan 17 아래에 함께 적은 것이고, 루트 README의 ralplan 17 행에는 없습니다.

`src/skill-state/handoff.ts`의 `handoffWorkflowTx`는 모든 인계 입구가 함께 쓰는 인계 하나입니다: `ralplan handoff` op, `skill ultragoal` 진입 게이트, `ultragoal handoff` op, 그리고 deep-interview 개정에서 더한 `deep-interview handoff` op, 결합 호출 `deep-interview spec(…, handoff: "ralplan")`, deep-interview 로드 게이트(`skill ralplan`·`skill ultragoal`). 호출하는 쪽이 제 검사를 먼저 합니다(ralplan: T 단계와 `active`, deep-interview: phase와 spec 검증). 이 함수는 goal state를 건드리지 않습니다(D-HE2). 받는 `tx`는 `StateStore.workflowTransaction` 하나의 것이고, 그 트랜잭션은 세션의 쓰기 큐 하나를 잡고 있는 동안 파일을 **바로** 씁니다. 되돌리기(rollback)는 없습니다.

### 단계

```
0  callee == caller 이면 거부
   "handoff: the callee must differ from the caller (both are \"<caller>\")"
① caller state 읽기: 깨짐 → 거부, 없음 → 거부("… caller is not active (no mode-state file at …)")
   callee state 읽기: 깨짐 → 거부, 없음 → {}
   at = 지금(ISO), mutation_id = "<caller>:handoff:<callee>:<at>"
② 저널 만들기 (status "pending")                      감사 write-transaction-journal
③ callee state 쓰기                                     감사 [invalid_transition_detected], handoff
   저널 steps ["callee-mode-state"]                       감사 write-transaction-journal
④ caller state 쓰기                                     감사 handoff
   저널 steps [… "caller-mode-state"]                     감사 write-transaction-journal
⑤ 활성 행: caller 비활성 행, callee 활성 행, 스냅숏
                                                         감사 write-active-entry ×1~2, rebuild-active-snapshot
   저널 steps [… "active-state"]                          감사 write-transaction-journal
⑥ recordCaller (ultragoal caller만): 원장 workflow_handoff, progress HANDOFF
                                                         감사 ledger/append, artifact/write
   저널 steps [… "caller-records"]                        감사 write-transaction-journal
⑦ 저널 status "committed"                               감사 write-transaction-journal
   저널 파일 삭제                                         감사 remove-transaction-journal(삭제됐을 때만)
→ 영수증 반환
```

### 필드 보존 병합

두 state 모두 **기존 필드 위에 덮어쓰는** 병합입니다. StateStore의 `_meta`는 쓸 때마다 새로 만들므로 읽을 때 뺐다가 다시 붙입니다.

| 필드 | callee | caller |
|---|---|---|
| `skill` | callee 이름 | caller 이름 |
| `version` | `2` | `2` |
| `active` | `true` | `false` |
| `current_phase` | 초기 단계: ralplan `planner`, ultragoal `goal-planning`, deep-interview `interviewing` | `handoff` |
| `handoff_from` | caller 이름 | (건드리지 않음) |
| `handoff_to` | (건드리지 않음) | callee 이름 |
| `handoff_at`, `updated_at` | `at` | `at` |
| `session_id` | 문자열이 아니면 계보 루트 id | (건드리지 않음) |
| 그 밖 | 모두 유지 | 모두 유지 |
| `_meta.updatedBy` | caller의 쓰는 주체 | 같음 |

`_meta.updatedBy`는 caller와 owner로 정합니다(`WRITERS`): ralplan caller는 `ralplan_tool`/`ralplan_hook`, ultragoal caller는 `ultragoal_tool`/`ultragoal_hook`, deep-interview caller는 `deep_interview_tool`/`deep_interview_hook`.

지우는 필드가 없으므로 왕복하면 이전 인계 필드가 남습니다. 예: ultragoal → ralplan → ultragoal을 거치면 ultragoal state에 옛 `handoff_to: "ralplan"`과 새 `handoff_from: "ralplan"`이 함께 있습니다.

### 감사용 전이 진단

callee state를 쓸 때 조건이 모두 맞으면, `handoff` 감사 행보다 먼저 `invalid_transition_detected` 행을 하나 남깁니다. 실패해도 무시합니다(best-effort). 쓰기는 그대로 진행됩니다.

- 새 state가 `active: true`이고(callee는 항상 참, caller는 항상 거짓),
- 전이 표가 있는 skill이고(ralplan과 deep-interview. ultragoal은 없음),
- 이전 단계가 있고, 새 단계와 다르고, 그 skill의 단계이고,
- 전이 표에 그 줄이 없을 때.

ultragoal → ralplan 인계에서 이 행이 남는 것은 저장된 ralplan 단계가 `RALPLAN_STATES`(아홉 stage와 `handoff`)에 들고 `planner`가 아닐 때입니다. `RALPLAN_TRANSITIONS`에는 `planner`로 들어가는 줄이 없으므로 이 경우는 항상 남습니다. 예: `final`, `handoff`, `architect`. 반대로 ralplan state가 없거나, `planner`이거나, `RALPLAN_STATES` 밖의 해제 단계(`ralplan clear` 뒤의 `complete` 등)이면 남지 않습니다. (임시 폴더 확인: `complete`에서 0행, `architect`에서 1행.)

deep-interview가 callee일 때도 같습니다. `DEEP_INTERVIEW_TRANSITIONS`에는 `interviewing`으로 들어가는 줄이 없으므로, 저장된 deep-interview phase가 `handoff`나 `complete`이면 이 행이 남고, state가 없거나 `interviewing`이면 남지 않습니다.

### 활성 행 쓰기 (`writeHandoffRowsTx`)

`src/skill-state/rows.ts`의 `writeHandoffRowsTx`. 두 행 모두 `activated_at`과 `updated_at`이 `at`입니다.

- caller 행: `{skill, phase: "handoff", active: false, activated_at, updated_at, session_id, handoff_to, handoff_at, hud}`. 이전 caller 행에 `handoff_from`이 있었으면 그 값을 이어 받습니다. 비활성이지만 파일로 남습니다.
- callee 행: `{skill, phase: <초기 단계>, active: true, …, handoff_from, handoff_at, hud}`.
- HUD는 병합된 state로 계산합니다(ralplan `buildRalplanHudFromState`, ultragoal `buildUltragoalHudFromState`, deep-interview `buildDeepInterviewHudFromState`).
- 윗단계 행을 지우지 않습니다. 이 점이 `syncActiveRowTx`와 다릅니다.
- 끝에 스냅숏을 다시 만듭니다. 행·스냅숏의 형식과 순위는 [state-and-files.md](state-and-files.md)에 있습니다.

### 저널 수명

`src/skill-state/journal.ts`. 저널은 증거용입니다. 다시 실행하거나 되돌리는 코드가 없고 doctor도 읽지 않습니다(I-19).

| 항목 | 값 |
|---|---|
| 경로 | `state/transactions/<encodeURIComponent(mutation_id), "."은 "%2E">.json`. 예: `ultragoal%3Ahandoff%3Aralplan%3A2026-09-30T00%3A00%3A00%2E000Z.json` |
| 처음 내용 | `{version: 1, mutation_id, status: "pending", created_at, updated_at, caller, callee, paths: [callee state, caller state, 스냅숏], steps: []}` |
| 만들 때 | 같은 파일이 이미 있으면 덮지 않고 그대로 둡니다(no clobber). |
| 갱신 | 병합 패치 + 새 `updated_at`. 단계마다 `steps`에 이름을 더함 |
| 성공 | `pending` → `committed`로 쓴 뒤 → 파일 삭제. 삭제가 실패하면 `committed` 파일이 남고 오류로 치지 않습니다. |
| 중간 실패 | 예외가 그대로 올라가고 저널은 `pending`과 거기까지의 `steps`로 남습니다. 이미 쓴 state와 행은 되돌리지 않습니다. 이를 알리는 곳은 없습니다([known-limits.md](known-limits.md) U15). |

저널 쓰기와 삭제마다 감사 행(`write-transaction-journal`, `remove-transaction-journal`)을 인계의 `mutation_id`로 남깁니다. gjc는 저널을 감사하지 않습니다(편차, `journal.ts` 헤더). 행·스냅숏·원장·progress 감사 행은 각자 새 `mutation_id`를 씁니다. 감사 로그 형식은 [state-and-files.md](state-and-files.md)에 있습니다.

### 영수증

`HandoffReceipt`:

| 필드 | 값 |
|---|---|
| `ok` | `true` |
| `from`, `to` | caller, callee |
| `handoff_at` | `at` |
| `mutation_id` | `<caller>:handoff:<callee>:<at>` |
| `phases` | `{from: "handoff", to: <callee 초기 단계>}` |
| `paths` | `{from: caller state, to: callee state, active_state: 스냅숏}` (절대 경로) |

`ralplan handoff`는 이것을 2칸 들여쓰기 JSON으로, `ultragoal handoff`는 한 줄 JSON으로 돌려줍니다. 진입 게이트는 버립니다.

## 체인 가드

gjc 출처: `tools/skill.ts:205-209`(체인 거부 문구). 편차: ultragoal 22(나가는 쪽은 durable 상태, 곧 활성 행으로 판단). 결정: D-HE3, DR-23.

### 트리거와 조건

`execute.before`의 D 단계(skill 처리)에서 `skill` 호출의 id가 `ralplan` 또는 `deep-interview`일 때입니다. **모든 agent**에 적용합니다.

```
계보 루트의 보이는 주 skill 읽기 (읽기 실패 → 기록만 하고 통과)
주 skill == "ultragoal" → 차단, 문구 ultragoalChainRefusal(<행의 phase 또는 "unknown">, <skill>)
id == "ralplan", agent == "open-gajae", 턴 표식 == "deep-interview"
                        → deep-interview 로드 게이트 gateTx(tx, root, "ralplan"): 거부면 차단
그 밖                   → 턴 표식을 <skill>로 세우고 로드 진행
```

deep-interview 로드 게이트는 [진입 게이트 분기](#진입-게이트-분기)의 것과 같은 함수입니다(callee만 `ralplan`).

거부 문구(`src/ultragoal-runtime/messages.ts`의 `ultragoalChainRefusal`). gjc의 "현재 skill을 먼저 마무리" 경로(`gjc state ultragoal write current_phase=handoff`)는 "끝내거나 clear"로 바뀌었습니다(DR-23).

```
open-gajae: refusing to chain from "ultragoal" (phase=goal-planning) into "ralplan". Run ultragoal handoff(to: "ralplan", reason) directly, or finish or clear the ultragoal run first.
```

`phase`는 ultragoal 활성 행의 값입니다. `goal-planning`, `pending`, `active`, `blocked`, `failed` 모두 막습니다. ultragoal 행이 활성이 아니게 되면 풀립니다. `ultragoal handoff`는 행을 비활성 `handoff_to` 행으로 남기고, `clear`, `state {active:false}`, 완료를 쓴 reconcile은 행을 지웁니다. 둘 다 보이는 주 skill 계산에서 빠집니다.

### 같이 알아둘 거부

| 거부 | 어디서 | 조건 | 문구 |
|---|---|---|---|
| `ralplan start` | `src/ralplan-runtime/tool.ts`의 `start` | ultragoal **state**가 `active: true`(행이 아님). 읽기 실패는 "활성 아님" | `ralplan cannot be started while ultragoal is active; call ultragoal handoff(to="ralplan", reason) instead, which makes ralplan active in its planner phase.` |
| `ralplan start`(활성 run) | 같음, ultragoal 검사 다음 | ralplan **state**가 `active: true`(넘겨받은 run 포함, ralplan 편차 39) | `ralplan run <run_id> is already active (phase <phase>[, handed over from <skill>]); continue it with ralplan write. To plan anew, stop it first with ralplan state {"active": false} or ralplan clear.` |
| `skill ultragoal`(ralplan 계획 중) | 진입 게이트 | 같은 execution에서 ralplan을 불렀고 ralplan이 T 밖에서 활성 | `RALPLAN_RUNNING_REFUSAL`(위) |

막지 않는 것: `skill ultragoal` 로드 자체에는 체인 가드가 없습니다. ultragoal이 주 skill일 때 다시 불러오면 시드가 `"kept"`로 끝납니다. `ralplan write`도 ultragoal 실행 중에 막지 않습니다([known-limits.md](known-limits.md) U22).

## 왕복 예

ultragoal 실행 중 계획을 다시 세우는 경우입니다(옛 U7).

```
1. ultragoal: G002 active, 주 skill ultragoal
2. 사용자 "@ralplan 다시 계획해줘"
     → prompt 훅: ultragoal이 주 skill이므로 ralplan 안내 대신 handoff 안내
3. 모델: skill ralplan
     → 체인 가드 거부: refusing to chain from "ultragoal" (phase=active) into "ralplan" …
4. 모델: ultragoal handoff(to="ralplan", reason="…")
     → ultragoal handoff, ralplan planner(활성, run_id 유지), 원장 workflow_handoff,
       progress HANDOFF, goal 그대로(continuation 계속)
5. 모델: skill ralplan → 통과, 턴 표식 "ralplan"
6. 모델: ralplan write … final
7. 모델: skill ultragoal (같은 execution)
     → 진입 게이트: 표식 ralplan, ralplan active·final ∈ T → 저널 인계
       ralplan handoff(비활성), ultragoal goal-planning(handoff_from "ralplan")
   (다른 execution이었다면 먼저 ralplan handoff(to="ultragoal"))
8. 모델: ultragoal create(description, goals) → goals.json 새로 씀, pending,
       열린 goal이 source "ultragoal"이라 새로 켜지 않고 유지
       ("Goal armed: the open ultragoal goal (active) already tracks this plan.")
```

8단계의 goal 유지 규칙은 [ops.md](ops.md)의 `create`에 있습니다.

## 코드가 강제하는 것과 SKILL만 요구하는 것

| 규칙 | 코드 | SKILL만 |
|---|---|---|
| 키워드·멘션 안내는 ultragoal state·행·goal을 쓰지 않음 | 예 (안내 자체는 아무것도 쓰지 않음. 같은 `prompt` 훅의 goal 보류 해제는 루트에서 `state/goal-continuation.json`을 다시 쓸 수 있음) | |
| `skill ultragoal`이 없거나 비활성인 state를 `goal-planning`으로 올림 | 예 (`open-gajae`가 부를 때만) | |
| 같은 execution의 ralplan 로드 뒤 `skill ultragoal`: ralplan이 활성이고 끝난 단계면 인계, 활성이고 계획 중이면 거부 | 예 | |
| `ultragoal` skill을 불러오기 전에 `ralplan handoff`를 먼저 부름(ralplan SKILL 9단계, 조건 없음) | 같은 execution이면 게이트가 대신 넘김 | 예 (나중 execution이면 코드는 인계 없이 시드) |
| `goal-planning`에서 제품 파일 `write`/`edit`/`patch` 거부 | 예 ([guards.md](guards.md)) | |
| `create` 전에 `status`·`classify_blocker`를 부르지 않음 | | 예 (코드는 허용하고 `goal-planning`을 끝냄. 이전 `goals.json`이 있으면 `next`·`checkpoint`·계획 변경·`record_*`도 끝냄) |
| 최종 계획을 읽어 구조화된 인자로 `create` | | 예 (계획 경로는 글로만 전달) |
| ultragoal이 주 skill이면 `skill ralplan`·`skill deep-interview` 거부 | 예 | |
| `ultragoal handoff`에 비어 있지 않은 `reason` | 예 | |
| 인계는 goal을 건드리지 않음 | 예 | |
| 넘겨받은 ralplan에서 `ralplan start`를 부르지 않음 | | 예 (ultragoal이 비활성이라 코드는 허용) |
| 넘긴 뒤 ralplan·deep-interview 작업 중에는 `ultragoal` op를 부르지 않음 | | 예 (끝나지 않은 `goals.json`이 있으면 reconcile op가 ultragoal을 다시 켬) |
| `ralplan handoff`는 T 단계와 `active`를 요구 | 예 | |
| `ultragoal handoff`는 ultragoal의 활성·단계를 요구 | 아니오 (파일 존재만 확인) | SKILL도 요구하지 않음 |
