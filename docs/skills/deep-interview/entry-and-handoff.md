# 진입과 넘기기

이 문서는 deep-interview가 어떻게 시작되고, 다른 workflow(ralplan, ultragoal)와 어떻게 제어를 주고받는지 코드 그대로 적습니다. 기준 코드는 [README.md](README.md) 머리에 있습니다. 용어(계보 루트, 보이는 주 skill, release phase, 턴 표식)는 [README.md](README.md)를 따릅니다.

op 하나하나의 검사와 결과는 [ops.md](ops.md), 파일 모양은 [state-and-files.md](state-and-files.md)에 있습니다.

## 진입 경로 한눈에 보기

| 경로 | 무엇이 일어나나 | deep-interview 상태 |
|---|---|---|
| 키워드(`deep interview`, `deep-interview`, `딥인터뷰`, `ディープインタビュー`, `ouroboros`) | `<deep-interview-notice>` 안내 | 쓰지 않음 |
| `@deep-interview` 멘션 | 같은 안내 + 턴 표식 `deep-interview` | 쓰지 않음 |
| `skill deep-interview` 로드 | 체인 가드를 지나면 턴 표식 `deep-interview` | 쓰지 않음 |
| `deep-interview start(idea, threshold?)` | 시드 | 새 봉투, `interviewing` |
| `ralplan handoff(to:"deep-interview")` | 저널 인계 | `interviewing`, 기존 필드 유지 |
| `ultragoal handoff(to:"deep-interview", reason)` | 저널 인계 | 같음 |

상태를 처음 쓰는 것은 `start`뿐입니다(deep-interview 편차 13). gjc는 skill 로드가 시드합니다.

## 키워드와 멘션 안내

`src/hooks.ts:860-1002`의 `prompt` 훅(v2 `prompt` 세션 훅)이 맡습니다.

### 검사 순서

1. **G1 역할 subagent**: 세션의 agent가 `ROLE_SUBAGENTS`(`src/hooks.ts:266-273`: planner, architect, critic, executor, cleaner, `open-gajae-lateral-reviewer`)면 아무것도 하지 않습니다. agent 조회가 실패하면 모르는 agent로 보고 계속합니다.
2. **G2 주입 표식**: 프롬프트에 플러그인 주입 표식(`INJECTION_MARKERS`, `src/injection.ts:17`)이 있으면 무시합니다. 플러그인이 넣은 안내나 continuation이 다시 들어온 경우입니다.
3. 실제 사용자 프롬프트로 보고 Esc 표식을 풉니다. 세션이 계보 루트면 deep-interview continuation 횟수를 0으로 돌리고(`src/hooks.ts:894`), goal 보류를 풉니다([guards-and-continuation.md](guards-and-continuation.md)).
4. agent가 `open-gajae`가 아닌 문자열이면 여기서 끝납니다. 안내는 `open-gajae`(그리고 agent가 없거나 조회에 실패한 세션)에만 갑니다.
5. 감지(`src/hooks.ts:908-921`):
   - 멘션: `event.prompt.skills`에 id `deep-interview`가 있음
   - 키워드: `detectDeepInterviewKeyword`(`src/ralplan.ts:772-778`). OMC 정규식 `/\b(deep[\s-]interview|ouroboros)\b|(딥인터뷰)|(ディープインタビュー)/i`(`src/ralplan.ts:32-33`)에 OMC의 일반 가드(질문, 인용, 코드, 표, 블록 인용 같은 정보성 문맥은 제외)를 씁니다. ralplan과 달리 "실행해 달라"는 문맥은 요구하지 않습니다. 정리한 텍스트가 `ouroboros`·`ooo` CLI 꼴(`/^\s*\/?(?:ouroboros|ooo)\b/i`)로 시작하면 감지하지 않습니다.
6. ralplan이나 deep-interview를 감지했으면 보이는 주 skill이 ultragoal인지 봅니다. 행을 읽을 수 없으면 아니라고 봅니다.
7. 안내 고르기(`src/hooks.ts:980-995`):
   - ultragoal이 주 skill이면 ultragoal 인계 안내만 냅니다. 턴 표식은 세우지 않습니다.
     ```
     [ULTRAGOAL ACTIVE] deep-interview was not started because an ultragoal run is active. To switch, call ultragoal handoff(to="deep-interview", reason); the goals and progress are kept and can be resumed later.
     ```
   - 아니면, 멘션이었으면 턴 표식을 `deep-interview`로 세우고(앞에서 ralplan·ultragoal 멘션이 표식을 정했으면 그대로), 프롬프트에 `[MAGIC KEYWORD: DEEP-INTERVIEW]`가 없으면 안내를 냅니다.
8. 안내는 `session.synthetic({resume: false})`로 씁니다. 거부되면 프롬프트 끝에 붙입니다.

### 안내 문구

`deepInterviewMessage`(`src/ralplan.ts:807-830`), OMC `createSkillInvocation`의 deep-interview 본문을 호스트에 맞춘 것입니다. 표식 `<deep-interview-notice>`로 감쌉니다.

```
[MAGIC KEYWORD: DEEP-INTERVIEW]

Skill routing detected: deep-interview
Preferred invocation: @deep-interview
Read fallback: open <패키지>/skills/deep-interview/SKILL.md and follow its SKILL.md instructions.

User request (compact echo; original prompt remains authoritative):
<프롬프트, 길면 잘림>

IMPORTANT: Start the deep-interview workflow immediately. If the `@deep-interview` mention is unavailable, read the SKILL.md at the fallback path instead of relying on this compact guide.
```

안내는 상태를 쓰지 않습니다(테스트 H6). 모델은 안내를 보고 skill을 로드하고, SKILL Phase 1에서 `start`를 부릅니다.

## 턴 표식

`src/hooks.ts:383-389`의 `turnSkill`(세션 id → skill 이름)입니다(ultragoal 계획 C-10, gjc `session/agent-session.ts:7448,8038-8046`).

- **세움**: guard를 지난 `skill` 호출(`markTurn`, `src/hooks.ts:821-825`)과 `@<skill>` 멘션.
- **되돌림**: 그 `skill` 호출이 실패하면 `execute.after`가 이전 값으로 돌립니다(`src/hooks.ts:1105-1122`).
- **지움**: execution이 끝날 때마다(`succeeded`, `failed`, `interrupted`) 지웁니다(`src/hooks.ts:1264`). 그래서 표식은 "이번 execution에서 로드한 skill"입니다.
- 표식은 호출한 세션 id 기준이고, 게이트의 판단은 그 세션의 계보 루트 상태로 합니다.

## `skill deep-interview` 로드

`src/hooks.ts:1004-1097`의 `execute.before`에서 `skill` 호출(입력 `{id}`)을 봅니다.

1. 산출물 가드와 편집 가드는 `skill`과 상관이 없습니다(경로가 없음).
2. id가 workflow skill(`ralplan`, `ultragoal`, `deep-interview`)이 아니면 끝.
3. `deep-interview`는 ultragoal 분기가 아니므로 **체인 가드**(`src/hooks.ts:1059-1073`)로 갑니다. 보이는 주 skill이 ultragoal이면 거부합니다(행을 읽을 수 없으면 통과).
   ```
   open-gajae: refusing to chain from "ultragoal" (phase=<phase>) into "deep-interview". Run ultragoal handoff(to: "deep-interview", reason) directly, or finish or clear the ultragoal run first.
   ```
4. 통과하면 턴 표식을 `deep-interview`로 세웁니다. 이 단계는 agent를 보지 않습니다.

로드는 상태도 행도 쓰지 않습니다. gjc는 skill 로드가 시드하고, 같은 skill이 이미 활성이면 쓰지 않습니다(deep-interview 편차 13).

## Phase 0: 기준치

### SKILL이 정하는 순서

SKILL Phase 0(`skills/deep-interview/SKILL.md:92-111`)이 모델에게 시킵니다. 코드는 모델이 이 순서를 지켰는지 보지 않습니다.

1. `deep-interview status`의 상태가 **활성**이고(넘겨받은 것 포함) 유한한 `threshold`와 비어 있지 않은 `threshold_source`(최상위나 `state`)가 있으면 그 값을 쓰고 그 인터뷰를 이어 갑니다. 활성 상태 위에서 `start`하지 않습니다. 비활성 상태의 값은 쓰지 않습니다.
2. 아니면 사용자가 이 인터뷰에 기준치를 직접 말했으면 그 값과 출처 `start(threshold)`. Phase 1에서 `start(idea, threshold)`로 넘깁니다.
3. 아니면 시스템 프롬프트의 `<open-gajae-runtime-settings>` 블록의 값과 `source`. 설정 파일을 직접 읽지 않습니다.
4. 사용자에게 내는 첫 줄은 `Deep Interview threshold: <percent> (source: <source>)`입니다.
5. 첫 `write`의 `state`(이전 기준치 없이 넘겨받은 인터뷰, `reset` 입력 포함)에 `threshold`·`threshold_source`를 넣고, 스펙 메타데이터에도 적습니다.

### 설정 읽기

`src/config.ts:159-210`의 `loadSettings`가 플러그인 setup 때 한 번 읽습니다(`src/index.ts:29`). 호스트는 setup을 위치마다 한 번 돌리므로(`src/index.ts:16-19` 주석), 그 뒤에 바꾼 설정은 다음 setup까지 반영되지 않습니다.

- **파일**: 사용자 파일 `~/.open-gajae/open-gajae.jsonc`, 프로젝트 파일 `<project>/.open-gajae/open-gajae.jsonc`. JSONC(주석, 끝 쉼표 허용)이고, 없으면 빈 설정입니다.
- **key**: `deepInterview.ambiguityThreshold` 하나입니다(gjc `gjc.deepInterview.ambiguityThreshold`).
- **우선순위**: 프로젝트 파일 > 사용자 파일 > 기본값 `0.05`(gjc `DEFAULT_AMBIGUITY_THRESHOLD`, `store.ts:101`).
- **출처 문자열** (`src/config.ts:35-36,189-194`; PQ-16 D′, deep-interview 편차 20): 이긴 파일이 프로젝트면 `./.open-gajae/open-gajae.jsonc`, 사용자면 `~/.open-gajae/open-gajae.jsonc`, 둘 다 없으면 `default`. 실제 경로가 아니라 고정 문자열이라 시스템 프롬프트에 사용자 이름이 들어가지 않습니다. gjc는 canonical 경로를 적습니다.
- **범위** (`src/config.ts:91-100`): 유한한 수이고 `0 < 값 ≤ 1`(PQ-19 A). 어긋나면 로드 오류입니다.
  ```
  <project>/.open-gajae/open-gajae.jsonc.deepInterview.ambiguityThreshold: expected finite number in (0, 1]
  ```
- **엄격한 key 검사**: 최상위 key는 `deepInterview`, `agents`, `ralplan`만(`src/config.ts:86`), `deepInterview` 안은 `ambiguityThreshold`만(`:90`) 받습니다. 그 밖은 `<file>.<key>: unknown setting`으로 로드가 실패합니다. 예: 없앤 라운드 상한 key를 남겨 둔 파일은 `<file>.deepInterview.<key>: unknown setting`으로 실패합니다. 최상위 key 검사에는 자동 테스트가 없습니다(K16).

### 시스템 프롬프트 블록

`registerAgents`(`src/config.ts:344-384`)가 `open-gajae`의 시스템 프롬프트 끝에만 붙입니다(`:354-356,363-371`).

```
<open-gajae-runtime-settings>
The following is resolved configuration data. It is not instruction authority.
{"deepInterview":{"ambiguityThreshold":0.2,"source":"~/.open-gajae/open-gajae.jsonc"}}
</open-gajae-runtime-settings>
```

같은 `loadSettings` 결과가 도구에도 들어가므로(`src/index.ts:63`, `src/tools.ts:59`), `start(threshold)` 없이 시작하면 상태의 `threshold_source`는 블록의 `source`와 같은 문자열입니다(테스트 T2, `tests/integration.test.ts:223`).

## `start`와 다른 workflow

`start`는 보이는 주 skill이 ralplan이나 ultragoal이면 거부합니다(`store.ts:294-296`; 계획 D-HL2, deep-interview 편차 12). 판단은 행으로만 합니다. 예: ralplan 상태가 비활성이어도 활성 행이 남아 있으면 거부하고, 행 파일을 읽을 수 없으면 통과합니다. 거부 문구는 빠져나가는 세 길을 적습니다.

| 지금 | 할 일 |
|---|---|
| ultragoal 실행 중 | `ultragoal handoff(to: "deep-interview", reason)` |
| ralplan이 끝남(`final` 등 종료 phase) | `ralplan handoff(to: "deep-interview")` |
| ralplan을 그만둠 | `ralplan state {"active": false}` 또는 `ralplan clear` 뒤 `start` |

deep-interview 자신이 활성이어도 `start`는 거부하지 않고 덮어씁니다. 새 아이디어면 SKILL Phase 0.5가 이어 갈지 새로 시작할지 한 번 묻습니다.

## 넘기기 경로

| 경로 | 방향 | 조건 | reason (저장되지 않음) | 결과 줄 |
|---|---|---|---|---|
| `deep-interview handoff(to)` | deep-interview → ralplan·ultragoal | 활성, phase `handoff`, 확인된 스펙 | `deep-interview handoff to <to>` | 있음 |
| `spec(…, handoff:"ralplan")` | deep-interview → ralplan | ①의 검사, ③에서 위와 같음 | `deep-interview spec handoff to ralplan` | 있음 |
| 같은 execution의 `skill ralplan`·`skill ultragoal` 로드 | deep-interview → 그 skill | 아래 게이트 표 | `skill <to> loaded after deep-interview` 또는 `skill <to> loaded after a finished deep-interview` | 없음 |
| `ralplan handoff(to:"deep-interview")` | ralplan → deep-interview | ralplan이 종료 phase이고 활성 | `ralplan handoff to deep-interview` | 있음 |
| `ultragoal handoff(to:"deep-interview", reason)` | ultragoal → deep-interview | `reason`만 | 입력 `reason`(원장과 진행 메모에 기록) | 없음(JSON 한 줄) |

모두 공통 저널 인계 `handoffWorkflowTx`를 씁니다([아래](#공통-저널-인계-handoffworkflowtx)). reason은 deep-interview caller에 기록 단계(`recordCaller`)가 없어 어디에도 저장되지 않습니다(계획 DR-35). ultragoal caller만 원장 `workflow_handoff`와 `progress.txt` `HANDOFF`에 남깁니다.

### `deep-interview handoff(to)`와 결합 호출

검사, 쓰기, 결과, 실패 때 남는 것은 [ops.md](ops.md)의 `handoff`와 결합 호출 절에 있습니다. 여기서는 위치만 적습니다.

- `handoff` op: `handoffTx`(`store.ts:600-610`) → `deepInterviewHandoffTx`(`store.ts:581-597`) → `handoffWorkflowTx`.
- 결합 호출: `specHandoffTx`(`store.ts:530-543`)가 `specTx` → `seedRalplanTx`(`startRunTx`) → `deepInterviewHandoffTx`를 차례로 부릅니다.

### 같은 execution의 skill 로드 게이트

이번 execution에서 deep-interview를 로드했으면(턴 표식 `deep-interview`), 이어서 `skill ralplan`이나 `skill ultragoal`을 로드할 때 게이트가 deep-interview 상태를 보고 거부하거나 넘기거나 통과시킵니다(계획 DR-21, PQ-11 E/B, PQ-35 A, PQ-36 C, U-1 A; deep-interview 편차 31). gjc `tools/skill.ts:203-222`의 체인 가드와 종료 phase 넘기기에 해당합니다.

**배선** (`src/hooks.ts`):

- `skill ralplan`: `execute.before`의 ⑤(`:1074-1092`). agent가 `open-gajae`이고 턴 표식이 `deep-interview`일 때만, ultragoal 체인 가드를 **지난 뒤** 루트의 트랜잭션 하나에서 `gateTx(tx, root, "ralplan")`를 부릅니다. 거부면 입력을 비워 막고, 아니면 턴 표식을 `ralplan`으로 세웁니다.
- `skill ultragoal`: `ultragoalGate`(`:796-818`)의 맨 앞(`:800-805`). `skill ultragoal`은 agent가 `open-gajae`일 때만 게이트를 돕니다(`:1047`). 턴 표식이 `deep-interview`면 같은 트랜잭션에서 `gateTx(tx, root, "ultragoal")`를 부릅니다. 거부면 막고, 넘겼으면 ultragoal을 따로 시드하지 않고 끝내며, 통과면 기존 ultragoal 게이트로 갑니다. 표식이 `deep-interview`이므로 ralplan 분기는 건너뛰고 `seedUltragoalTx`가 `goal-planning`을 시드합니다(이미 활성인 ultragoal은 phase를 지킴).

**판단** (`gateTx`, `src/deep-interview-runtime/hooks.ts:132-166`). phase는 `current_phase`를 trim하고 소문자로 바꾼 값이고, 없으면 `running`입니다(gjc `getActiveSkillPhase` → `(phase ?? "running").trim().toLowerCase()`).

| deep-interview 상태 | 판단 | `skill ralplan` | `skill ultragoal` |
|---|---|---|---|
| 없음 | 통과 | 로드됨, ralplan 상태 변화 없음 | 로드됨, `goal-planning` 시드 |
| 손상 | 통과 (gjc는 거부) | 같음 | 같음 |
| `interviewing` (활성이든 비활성이든) | 거부 | 거부 | 거부, 시드 없음 |
| 읽히지만 모르는 phase (예: `bogus`) | 거부, `phase=<값>` | 거부 | 거부 |
| `current_phase` 없음 | 거부, `phase=running` | 거부 | 거부 |
| 활성 `handoff` | `deepInterviewHandoffTx`로 넘김. 그 검사(활성, phase, 스펙 확인)나 인계가 실패하면 `open-gajae: <오류>`로 거부 | 넘긴 뒤 로드: ralplan 활성 `planner` | 넘긴 뒤 로드: ultragoal 활성 `goal-planning` |
| 비활성 `handoff` (이미 넘김) | 통과, 다시 넘기지 않음 | 로드됨 | 로드됨, 시드 경로 |
| release phase(`complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`), 활성이든 비활성이든 | 스펙 확인(`verifySpecTx`) 뒤 `handoffWorkflowTx`로 **연결**. 스펙이 없거나 확인·인계가 실패하면 통과하고, 이유를 `[open-gajae:hooks] finished deep-interview not linked to <skill>: <오류>`로 로그에 남김(계획 DR-21) | 연결됐으면 ralplan `planner` + `handoff_from`, 아니면 그냥 로드 | 연결됐으면 `goal-planning` + `handoff_from`, 아니면 시드 경로 |

거부 문구(`chainRefusal`, `messages.ts:35-37`):

```
open-gajae: refusing to chain from "deep-interview" (phase=interviewing) into "ralplan". Persist the spec with deep-interview spec, then call deep-interview handoff(to: "ralplan"), or clear the interview first.
```

활성 `handoff`에서 스펙을 지웠다면 예를 들어 `open-gajae: deep-interview spec <path> is missing`으로 거부합니다(테스트 H3).

**세부**:

- **연결은 비활성 인터뷰도 넘깁니다.** `handoff` op(활성 필요)와 다른 점입니다. `clear`가 `spec_*`를 남기므로, 스펙을 저장하고 `clear`한 인터뷰도 같은 execution에서 연결됩니다. 연결된 deep-interview는 비활성 `handoff`(`handoff_to`)가 되고, 감사 행은 caller 쪽 `state/handoff` 하나뿐입니다(비활성으로 쓰므로 `invalid_transition_detected` 없음, 테스트 H3).
- **활성 callee도 되돌립니다** (PQ-36 C, K15). 공통 인계가 callee를 시작 phase로 씁니다. 진행 중인 ralplan(예: `architect`)은 `planner`로, 진행 중인 ultragoal은 `goal-planning`으로 돌아갑니다. 단계 파일과 `goals.json`은 남습니다. callee 쪽 감사에는 `invalid_transition_detected`가 먼저 남습니다. ultragoal이 보이는 주 skill인 동안에는 `skill deep-interview` 로드가 체인 가드에 막히고 `@deep-interview` 멘션은 ultragoal 인계 안내만 받으므로(턴 표식 없음), ultragoal 쪽 경우는 ultragoal 행이 없어진 상태에서만 일어납니다.
- **결과 줄이 없습니다** (PQ-35 A). 게이트는 로드를 통과시킬 뿐 모델에게 넘기기를 알리지 않습니다. 그래서 ralplan SKILL(`skills/ralplan/SKILL.md:17`)과 ultragoal SKILL(`skills/ultragoal/SKILL.md:403`)은 상태에 `handoff_from: "deep-interview"`가 있고 결과 줄을 못 봤으면 `deep-interview status`의 `spec_path`를 읽으라고 합니다.
- **게이트가 돌지 않는 경우**: 이전 execution에서 로드한 deep-interview(턴 표식이 지워짐, K1), `open-gajae`가 아닌 agent의 로드(테스트 H3), ultragoal이 주 skill이라 체인 가드가 먼저 막은 `skill ralplan`.
- **예외**: `gateTx`는 넘기기 안의 실패(스펙 확인, callee 손상, 행 파일 손상 등)를 모두 잡아 위 표대로 거부나 통과로 바꿉니다. 그 밖에서 예외가 나면(예: 계보 조회 실패, 세션 폴더를 정할 수 없음, `skill ultragoal`의 이어지는 시드가 실패) `execute.before`가 로그만 남기고 호출을 통과시킵니다(`src/hooks.ts:1094-1096`). 이때 턴 표식은 세우지 않습니다.
- **감사 owner**: 게이트가 쓰는 행은 모두 `open-gajae-hook`, writer는 `deep_interview_hook`입니다.

### `ralplan handoff(to:"deep-interview")`

ralplan run이 사용자만 정할 수 있는 요구를 드러냈을 때 인터뷰로 돌아가는 길입니다(spec D-SH5, 계획 DR-11). `ralplan` 도구의 `handoff` op(`src/ralplan-runtime/tool.ts:296-298`) → `ralplanHandoff`(`src/ralplan-runtime/store.ts:1378-1394`) → `ralplanHandoffTx`(`:1328-1371`).

검사 순서:

1. ralplan 상태가 손상이면 `existing ralplan state is corrupt or tampered (…); refusing to overwrite …`.
2. 상태가 없으면 `there is no ralplan state in this session to hand off`.
3. phase가 종료 phase(`final`, `handoff`, `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`)가 아니면
   ```
   ralplan can hand off to deep-interview only from a finished phase (final, handoff, complete, completed, failed, cancelled, canceled, inactive); the current phase is <phase>. Record the final plan first.
   ```
4. 비활성이면(R-OD18):
   - phase `handoff`: ``ralplan was already handed off (inactive, phase handoff); continue in the `<handoff_to>` skill.``
   - 그 밖: ``ralplan is not active (phase <phase>), so there is nothing to hand off: Stop here or `clear` ended the run. To interview again, load the `deep-interview` skill and call `deep-interview start`; to continue an existing interview, call `deep-interview status`.``
5. 공통 인계(caller ralplan, callee deep-interview).

결과 줄(그다음 영수증 JSON). 실행의 `pending-approval.md`가 있으면 ` (the approved plan: <path>)`가 문장 끝 마침표 앞에 붙습니다.

```
Handed off to deep-interview: ralplan is inactive (phase handoff) and deep-interview is active in interviewing. Load the `deep-interview` skill now and continue the existing interview with `deep-interview write`; do not call `deep-interview start`, which would reseed it.
```

넘겨받은 deep-interview: 활성 `interviewing`, `handoff_from: "ralplan"`, 라운드·사실·`threshold`·`spec_*`·이전 `handoff_to` 모두 유지, 활성 행(`handoff_from`). 모델은 `deep-interview write`로 이어 가고 `start`하지 않습니다(SKILL Phase 0, `skills/ralplan/SKILL.md:129`). 다시 스펙을 쓰면 새 `spec`이 `spec_*`를 덮습니다.

### `ultragoal handoff(to:"deep-interview", reason)`

`ultragoal` 도구의 `handoff` op(`src/ultragoal-runtime/store.ts:1096-1116`). `reason`이 비면 `reason is required (a non-empty string)`. ultragoal이 활성인지, 어느 phase인지는 보지 않습니다. 공통 인계에 `recordCaller`를 넘겨, 행을 쓴 뒤 원장에 `workflow_handoff`, `progress.txt`에 `HANDOFF` 메모를 남깁니다.

결과는 결과 줄 없이 한 줄 JSON 영수증입니다.

```
{"ok":true,"from":"ultragoal","to":"deep-interview","handoff_at":"…","mutation_id":"ultragoal:handoff:deep-interview:…","phases":{"from":"handoff","to":"interviewing"},"paths":{"from":"<session>/state/ultragoal-state.json","to":"<session>/state/deep-interview-state.json","active_state":"<session>/state/skill-active-state.json"}}
```

넘겨받은 deep-interview는 ralplan 쪽과 같습니다. 이전 상태가 없으면 `state` 객체와 기준치 없이 생기므로, SKILL Phase 1이 `interview_id`가 없을 때 초기화 `write`(기준치 포함)를 한 번 하라고 합니다(`skills/deep-interview/SKILL.md:190`). ultragoal SKILL은 넘긴 동안 `ultragoal` op를 부르지 말라고 합니다. reconcile하는 op가 ultragoal을 `goals.json`에서 다시 활성으로 만들고 deep-interview 행을 지우기 때문입니다(`skills/ultragoal/SKILL.md:399`).

## 공통 저널 인계 `handoffWorkflowTx`

`src/skill-state/handoff.ts:212-322`. 세 skill의 모든 넘기기가 씁니다(ultragoal 계획 C-5, PQ-6 A). gjc 출처는 `gjc-runtime/state-runtime.ts:1572-1881`(`handleHandoffUnlocked`)입니다(머리말 기준). 호출자는 자기 검사를 먼저 합니다(deep-interview: 활성, phase `handoff`, 스펙 확인).

### 단계

```
① caller == callee 이면 거부: handoff: the callee must differ from the caller (both are "<skill>")
② 두 상태 읽기
   - 손상이면 거부: existing state for <skill> is corrupt or tampered (<error>); refusing to hand off
   - caller 상태가 없으면 거부: <caller> handoff: caller is not active (no mode-state file at <path>)
③ 두 병합 상태를 메모리에서 만듦
   callee = {…기존 callee, skill, version 2, active true, current_phase <시작 phase>,
             handoff_from <caller>, handoff_at, updated_at, session_id(문자열이 아니면)}
   caller = {…기존 caller, skill, version 2, active false, current_phase "handoff",
             handoff_to <callee>, handoff_at, updated_at}
④ 두 상태에 assertStatePayload (계획 DR-31, I-24) — 걸리면 아무것도 쓰지 않고 거부
⑤ 저널 시작 (pending)
⑥ callee 상태 쓰기 → 저널 step "callee-mode-state"
⑦ caller 상태 쓰기 → 저널 step "caller-mode-state"
⑧ 두 행 쓰기 (caller 비활성 handoff_to 행, callee 활성 행) + 스냅숏 → step "active-state"
⑨ (ultragoal caller만) recordCaller → step "caller-records"
⑩ 저널 committed → 삭제
```

- **시작 phase** (`HANDOFF_SKILLS`, `handoff.ts:75-92`; gjc `initialPhaseForSkill`): ralplan `planner`, ultragoal `goal-planning`, deep-interview `interviewing`. callee가 이미 활성이어도 이 phase로 씁니다.
- **필드 유지**: 두 상태 모두 기존 필드 위에 병합합니다. 그래서 ralplan callee는 이전 `run_id`, `task`, `mode`, `repository_binding`을, deep-interview callee는 라운드와 `spec_*`를 지킵니다(K7). 이전 ralplan 상태가 없으면 `run_id`·`task` 없이 `planner`만 생기고, `ralplan write`는 루트 세션 id를 run 폴더로 씁니다.
- **감사용 전이 진단**: callee를 **활성**으로 쓰면서 phase가 바뀌고 그 이동이 callee 전이 표에 없으면 `state/invalid_transition_detected`를 먼저 남깁니다(best-effort). 쓰기는 진행합니다. caller는 비활성으로 쓰므로 남지 않습니다.
- **행**: `writeHandoffRowsTx`(`src/skill-state/rows.ts:170-184`)가 caller 행을 비활성 `{phase: "handoff", handoff_to}`로, callee 행을 활성 `{phase: <시작>, handoff_from}`으로 쓰고 스냅숏을 다시 만듭니다. 두 행 모두 병합 상태로 다시 계산한 HUD 칩을 가집니다. 낮은 순위 행을 지우지 않습니다.
- **goal**: 어떤 인계도 goal 상태를 건드리지 않습니다(D-HL8).
- **영수증**: `{ok: true, from, to, handoff_at, mutation_id: "<caller>:handoff:<callee>:<at>", phases: {from: "handoff", to: <시작 phase>}, paths: {from, to, active_state}}`(gjc 영수증에 `mutation_id`를 더함).

### 실패하면 남는 것

| 실패 자리 | 남는 것 |
|---|---|
| ①~④ | 아무것도 쓰지 않음 |
| ⑤ 뒤 | `pending` 저널과 그때까지 쓴 상태·행. 다시 실행하거나 되돌리는 코드는 없고, doctor도 저널을 보지 않음(deep-interview 편차 21) |

## 결과 줄 모음

| 경로 | 첫 줄 | 정의 |
|---|---|---|
| `deep-interview handoff(to:"ralplan")`, 결합 호출 | ``Handed off to ralplan: deep-interview is inactive (phase handoff) and ralplan is active in planner. Load the `ralplan` skill now; do not call `ralplan start` — continue this run with `ralplan write` and use the spec as the planning input (spec: <spec_path>).`` | `messages.ts:111-113` |
| `deep-interview handoff(to:"ultragoal")` | ``Handed off to ultragoal: deep-interview is inactive (phase handoff) and ultragoal is active in goal-planning. Load the `ultragoal` skill now and call `ultragoal create` with the spec's acceptance criteria as goals (spec: <spec_path>).`` | `messages.ts:116-118` |
| `ralplan handoff(to:"deep-interview")` | ``Handed off to deep-interview: ralplan is inactive (phase handoff) and deep-interview is active in interviewing. Load the `deep-interview` skill now and continue the existing interview with `deep-interview write`; do not call `deep-interview start`, which would reseed it[ (the approved plan: <path>)].`` | `src/ralplan-runtime/store.ts:1388-1393` |
| `ultragoal handoff(to:"deep-interview")` | 없음(한 줄 JSON) | |
| 로드 게이트 | 없음 | |

## 넘긴 뒤: `ralplan start` 거부

ralplan으로 넘긴 뒤 모델이 `ralplan start`를 부르면 run을 다시 시드해 넘겨받은 필드(`handoff_from`)가 사라질 수 있었습니다. 지금은 `ralplan start`가 활성 run 위에서 거부합니다(계획 DR-39, 관리자 답 K14 C, ralplan 편차 39).

`src/ralplan-runtime/tool.ts:189-211`의 `start`가 ralplan 트랜잭션 하나에서 차례로 봅니다.

1. ultragoal 상태가 읽히고 `active: true`면 `RALPLAN_ACTIVATION_REFUSAL`(`:70-71`):
   ```
   ralplan cannot be started while ultragoal is active; call ultragoal handoff(to="ralplan", reason) instead, which makes ralplan active in its planner phase.
   ```
2. ralplan 상태가 읽히고 `active: true`면 `ralplanRunActiveRefusal`(`:73-78`). 행이 있는지는 보지 않습니다(U4-1 A). 상태는 바뀌지 않습니다.
   ```
   ralplan run <run_id> is already active (phase <phase>[, handed over from <handoff_from>]); continue it with ralplan write. To plan anew, stop it first with ralplan state {"active": false} or ralplan clear.
   ```
   이전 ralplan 상태 없이 deep-interview에서 넘겨받은 run에는 `run_id`가 없어 `ralplan run (none) is already active (phase planner, handed over from deep-interview); …`로 나옵니다.
3. 그다음 task 검사와 `startRunTx`.

손상된 상태는 활성이 아닌 것으로 보고 지나가서 `startRunTx`의 손상 문구로 거부됩니다(RP5). 이 확인은 도구에만 있으므로 결합 호출의 시드는 영향을 받지 않습니다(K12, K14). 테스트는 `tests/ralplan-tool.test.ts`의 RP3·RP4입니다.

## 왕복 예

```
1. deep-interview start(idea)                      DI 활성 interviewing, DI 행
2. write × n (Round 0, 라운드 1…n)                 DI 상태 병합, 칩 갱신
3. spec(content, slug:"s")                         specs/deep-interview-s.md, index, DI handoff, spec 칩
4. handoff(to:"ralplan")                           DI 비활성 handoff(handoff_to ralplan), DI 비활성 행
                                                   ralplan 활성 planner(handoff_from deep-interview), ralplan 행
5. skill ralplan → ralplan write …                 (ralplan start는 거부됨)
6. ralplan이 final에서 사용자 판단이 필요함
   ralplan handoff(to:"deep-interview")            ralplan 비활성 handoff, DI 활성 interviewing
                                                   (라운드·spec_*·handoff_to 유지, handoff_from ralplan)
7. skill deep-interview → write (start 아님) …     라운드 이어 쓰기
8. spec(…, slug:"s2") → handoff(to:"ralplan")      같은 ralplan run_id로 이어감 (K7)
```

같은 execution에서 3 뒤 `skill ralplan`을 바로 로드하면 4를 게이트가 대신합니다. 이때 결과 줄은 없습니다.

## 코드가 강제하는 것과 SKILL만 요구하는 것

| 규칙 | 코드 | SKILL만 |
|---|---|---|
| 상태를 처음 쓰는 것은 `start` | 예(안내·로드는 쓰지 않음) | |
| ralplan·ultragoal이 주 skill일 때 `start` 거부 | 예 | |
| 활성 인터뷰 위에서 `start`하지 않음 | | 예 (Phase 0) |
| 기준치 순서(활성 상태 → 사용자 값 → 블록)와 첫 줄 | 일부(`start`의 인자 > 설정) | 예 |
| 넘기기 전 phase `handoff`와 스펙 sha256 | 예 | |
| 사용자가 Phase 5에서 고른 뒤에만 넘김 | | 예 |
| 넘긴 뒤 `ralplan start` 금지 | 예(활성 run 거부) | 결과 줄도 안내 |
| 넘겨받은 인터뷰는 `write`로 이어 감 | | 예 (`start`는 막히지 않음) |
| 넘긴 동안 `ultragoal` op 금지 | | 예 (ultragoal SKILL) |
