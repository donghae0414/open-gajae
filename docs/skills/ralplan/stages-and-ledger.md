# 단계 기록과 원장: 예산, PLANNING-STUCK, disposition, 최종 승인 판정

이 문서는 `ralplan write` 한 번이 안에서 하는 일을 코드 그대로 적습니다. 다루는 것은 `writeStageTx`(`src/ralplan-runtime/store.ts:635-880`)의 단계별 순서, 단계 이름과 `stage_n`, 단계 파일 이름과 본문 정규화, 원장 `index.jsonl`의 행과 읽기 규칙, 같은 단계를 다시 쓸 때의 중복 처리·덮어쓰기 거부·원장 복구, `pending-approval.md`, run 식별과 상태 갱신, phase 전진과 잠긴 phase, 전이 감사 행, 반복 상한과 lane 예산, PLANNING-STUCK, lane verdict, 역할 세션 ID와 대체 메타, final의 `auto_handoff` 판정, disposition 단계, 영수증입니다. 기준 코드는 [README.md](README.md) 머리에 있습니다. 코드 위치는 `5b92a60` 기준입니다.

예시 출력은 기준 코드를 임시 폴더의 `StateStore` 위에서 bun으로 실제로 불러 얻은 것입니다(`tests/ralplan-tool.test.ts`와 같은 방식, 13장). 세션 폴더 절대 경로는 `<session>`으로 줄였고, 시각과 해시는 실행마다 다릅니다. 영수증의 `repository_binding` 객체는 `{…}`로 줄였습니다.

다음 주제는 다른 문서가 맡습니다.

- 도구 정의, 입력 스키마, 호출자 검사, 계보 루트, `write` 앞의 입력 검사(`content`/`path`, 임시 경로), op별 결과: [ops.md](ops.md)
- 상태 봉투의 필드와 op별 변화, `migrateRalplanState`, 활성 행·스냅숏·HUD 칩, 감사 행 모양, phase manifest 전체(T, R, known phases), doctor, 설정 로딩: [state-and-files.md](state-and-files.md)
- `ralplan handoff`, Stop here 뒤의 진입, 저널 인계: [entry-and-handoff.md](entry-and-handoff.md)
- 계획 가드, continuation(`planning_stuck`을 읽는 곳), 압축 문맥: [guards-and-continuation.md](guards-and-continuation.md)
- SKILL의 합의 루프와 역할 agent, 재개와 대체 경로: [roles-and-consensus.md](roles-and-consensus.md)
- 알려진 한계: [known-limits.md](known-limits.md)

이 문서에서 쓰는 말은 이렇습니다. 이 폴더 [README.md](README.md)의 용어집에 있는 것(stage, `stage_n`, opener, 반복, lane, run, 잠긴 phase, 영수증, PLANNING-STUCK)은 다시 정의하지 않습니다.

| 용어 | 뜻 |
|---|---|
| 단계 파일 | `plans/ralplan/<run_id>/stage-NN-<stage>.md`. 한 번 쓰면 바꾸지 않습니다. |
| 원장 / 원장 행 | run 폴더의 `index.jsonl`과 그 한 줄. 단계 행과 막힘 행 두 종류가 있습니다. |
| 막힘 행 | `{"event":"planning_stuck", …}` 행. run마다 많아야 하나입니다. |
| 원장 중복 | 같은 `(stage, stage_n)`의 완전한 행이 이미 원장에 있는 경우(4.2). |
| 원장 복구 (repair) | 단계 파일은 있는데 그 행이 원장에 없을 때 같은 내용을 다시 써서 행을 채우는 경로(4.3). |
| 승인 판정 (admission) | final이 정하는 `auto_handoff` 객체. 설정된 대상과 실제 대상, 낮춘 이유, 출처를 담습니다(10장). |

## 1. `write` 한 번의 처리 순서

`writeStageTx`는 gjc `handleArtifactWrite`(`gjc-runtime/ralplan-runtime.ts:2033-2256`)의 순서를 그대로 따릅니다(계획 DR-2). 순서에서 빠진 것은 둘입니다. 저장소 바인딩을 강제하지 않고(ralplan 편차 12), gjc가 final 승인 기록 뒤에 남기는 세션 활동 표식 `writeSessionActivityMarker`(`:2213-2216`)를 쓰지 않습니다(`.session-activity.json`이 없음, deep-interview 편차 26). gjc 줄 번호는 따로 적지 않으면 `store.ts`·`ledger.ts` 머리말의 범위이고, `handleArtifactWrite`, `persistActiveRunId`, `buildDeduplicatedResult`는 이 문서를 쓰며 `gajae-code/`에서 다시 확인했습니다.

### 1.1 도구 쪽에서 먼저 하는 검사

`writeStageTx`가 불리기 전에 `src/ralplan-runtime/tool.ts:213-248`의 `write`가 입력을 확인합니다. 이 검사의 순서와 입력·임시 `path` 거부 문구는 [ops.md](ops.md)의 `write` 절에 있고, 역할 메타데이터와 lane verdict의 거부 문구는 이 문서 9.2절과 8장에 있습니다. 여기서는 순서만 요약합니다.

1. 역할 agent가 `path`를 넘기면 거부(R-O4)
2. `stage` 필수, `assertRalplanStage`(`manifest.ts:136-144`): `unknown stage: <stage>. Expected one of: planner, intent, architect, critic, disposition, revision, post-interview, adr, final.`
3. `parseStageN`(`ledger.ts:341-351`) (2장)
4. `content`와 `path` 중 정확히 하나, `path`면 임시 파일 읽기, 본문이 정확히 `""`이면 `artifact content is empty`
5. 역할 세션 ID 결정과 `parsePersistedRoleState` (9장)
6. `parseLaneVerdict` (8장)
7. 트랜잭션 하나(`store.ralplanTransaction`) 안에서 `writeStageTx`. ultragoal이 실행 중이어도 거부하지 않습니다(R-AE1).

### 1.2 `writeStageTx`의 순서

거부는 모두 예외이고, 도구 결과는 `Error: <문구>`가 됩니다. PLANNING-STUCK은 예외가 아니라 결과입니다(7.4).

| 순서 | 코드 (`store.ts`) | 하는 일 | 거부 문구 또는 쓰는 것 |
|---|---|---|---|
| 1 | `:642` `readStateForMutation` (`:250-260`) | 상태 파일을 읽습니다. 없으면 `undefined`. | 읽기 실패: ``existing ralplan state is corrupt or tampered (<오류>); refusing to overwrite <state 경로>. Reset it with `ralplan clear` and force: true.`` |
| 2 | `:643-644` | `run_id` 결정과 run 폴더 경로 (6.1) | `invalid path component for run_id: <값>` |
| 3 | `:647-648` | 영수증용 바인딩: 상태의 `repository_binding`, 없으면 지금 캡처(`captureRepositoryBinding`) | 없음 (검사하지 않음, 편차 12) |
| 4 | `:651` `loadIndexTx` (`:324-332`) | 원장을 한 번 읽습니다. 중복 확인, 두 예산, disposition 출처 검사가 모두 이 읽기 결과를 씁니다(gjc `:2075`). | 없음 (읽을 수 없으면 "있지만 못 믿음", 3.3) |
| 5 | `:652-655` | `disposition`이면 `normalizeDispositionArtifact`로 검사하고 다시 직렬화 (11장) | `invalid ralplan disposition artifact: <사유>` |
| 6 | `:656-657` | 끝 개행 정규화, sha256 (2.3) | 없음 |
| 7 | `:668-692` | **원장 중복**: 같은 `(stage, stage_n)` 행이 있으면 (4.2) | sha256이 다르면 덮어쓰기 거부(4.4). 같으면 final만 `pending-approval.md` 확인(5장), 그리고 중복 영수증을 돌려주고 끝 |
| 8 | `:695-759` | **원장 복구**: 행은 없고 단계 파일이 있으면 (4.3) | sha256이 다르면 덮어쓰기 거부. 같으면 final만 `pending-approval.md` 확인, 원장 행 추가, 같은 run이면 역할 메타·lane verdict 병합, 중복 영수증을 돌려주고 끝 |
| 9 | `:762` | run 폴더 목록(`tx.list`, 이름순). 폴더가 없으면 빈 목록 | 폴더가 심볼릭 링크이거나 폴더가 아니면 `state path contains a symlink or non-directory` |
| 10 | `:763-781` | **반복 상한** (7.2) | 넘으면 막힘 기록 후 PLANNING-STUCK 결과를 돌려주고 끝 |
| 11 | `:782-800` | **lane 예산** (7.3) | 넘으면 막힘 기록 후 PLANNING-STUCK 결과를 돌려주고 끝 |
| 12 | `:803-810` | final이면 승인 판정 `resolveRalplanAutoHandoffTarget` (10장). 파일을 쓰기 전에 정합니다(gjc `:2191-2203`). | 없음 |
| 13 | `:812` `persistActiveRunIdTx` (`:513-545`) | 상태 만들기, run 전환, phase 전진, 다시 활성화. 잠긴 phase면 아무것도 쓰지 않음 (6.2) | `state/write` 감사 행. 그 앞에 `invalid_transition_detected` 행이 붙을 수 있음(6.6) |
| 14 | `:813-822` `persistArtifactTx` (`:372-405`) | 단계 파일 → 원장 행 → final이면 `pending-approval.md` | `artifact/write`, `ledger/append`, (final) `artifact/write` |
| 15 | `:823-830` | 역할 메타 병합 `mergeRunStateTx` (9장) | `state/write` |
| 16 | `:831-838` | lane verdict 병합 (8장) | `state/write` |
| 17 | `:839-840` | final이면 승인 판정을 상태에 (`persistFinalAdmissionTx`, 같은 run일 때만) | `state/write` |
| 18 | `:842-866` | 활성 행과 스냅숏(최선 노력, 실패해도 결과는 그대로). 행의 `phase`는 방금 쓴 단계(DR-8, R-OD5) | `state/write-active-entry`, `state/rebuild-active-snapshot` (위쪽 파이프라인 행을 지우면 `state/remove-superseded-pipeline-entry`도) |
| 19 | `:867-879` | 새 기록 영수증 `buildWriteReceipt` (12장) | — |

상태 쓰기(8, 10, 11, 13, 15~17단계)는 모두 `writeStateTx`(`:193-247`)를 거칩니다. `writeStateTx`는 `active: true`인 상태를 manifest에 없는 phase로 쓰려 하면 `Refusing to write unknown ralplan phase "<phase>" to <state 경로>: not a known ralplan manifest state`로 거부합니다. 13단계는 manifest 밖의 phase를 방금 쓴 단계로 바꾸므로(잠긴 phase가 아니므로) 새 기록 경로에서는 이 거부가 나지 않습니다. 8단계의 병합과 10·11단계의 막힘 기록은 phase를 바꾸지 않으므로, 상태가 이미 manifest 밖의 phase(예: OMC 시절의 `"ralplan"`, `version: 2`)로 `active: true`이면 거부됩니다. 막힘 기록에서 이 거부가 나면 막힘 행은 이미 붙은 뒤이고, 결과는 PLANNING-STUCK이 아니라 `Error:`입니다(실행해 확인).

### 1.3 쓰는 순서: 실제 감사 행

`start` 뒤 planner 역할이 `planner 1`을 쓰면 상태가 이미 같은 run의 `planner`에 `active: true`이므로 13단계는 아무것도 쓰지 않습니다. 남는 감사 행은 다섯입니다(13장 실행 A).

```
artifact:write -> <session>/plans/ralplan/ses_root/stage-01-planner.md
ledger:append -> <session>/plans/ralplan/ses_root/index.jsonl
state:write -> <session>/state/ralplan-state.json
state:write-active-entry -> <session>/state/active/ralplan.json
state:rebuild-active-snapshot -> <session>/state/skill-active-state.json
```

셋째 줄은 15단계(역할 ID 병합)입니다. 이어서 architect 역할이 `lane_verdict`와 함께 `architect 1`을 쓰면 phase가 `intent`에서 `architect`로 움직이므로 13단계가 먼저 씁니다.

```
state:write -> <session>/state/ralplan-state.json          (13: phase 전진)
artifact:write -> <session>/plans/ralplan/ses_root/stage-01-architect.md
ledger:append -> <session>/plans/ralplan/ses_root/index.jsonl
state:write -> <session>/state/ralplan-state.json          (15: architect_id)
state:write -> <session>/state/ralplan-state.json          (16: last_review_verdict*)
state:write-active-entry -> <session>/state/active/ralplan.json
state:rebuild-active-snapshot -> <session>/state/skill-active-state.json
```

괄호 안 설명은 이 문서가 붙인 것입니다. 상태 파일은 한 번의 write에서 최대 세 번 다시 쓰입니다(architect·critic의 13, 15, 16단계. final은 13, 17단계). 모두 한 트랜잭션 안이지만 파일 단위로 원자적일 뿐이고, 중간에 실패하면 앞의 쓰기는 남습니다.

### 1.4 결과 형식

`tool.ts:263-265`가 두 경우를 같은 모양으로 만듭니다.

- 영수증: `<text>\n<payload JSON>`. `text`는 한 줄 또는 두 줄입니다(12장).
- PLANNING-STUCK: `<detail>\n<payload JSON>`. `Error:` 접두어가 없습니다(gjc의 exit 3, 편차 1).

## 2. 단계, `stage_n`, 파일 이름, 본문

### 2.1 단계

단계는 gjc `KNOWN_STAGES` 순서 그대로 아홉입니다(`RALPLAN_STAGES`, `manifest.ts:20-30`, spec D-T2). 코드가 단계마다 다르게 다루는 곳은 이렇습니다.

| 단계 | 반복 상한 (7.2) | lane 예산 (7.3) | 역할 메타 (9장) | lane verdict (8장) | 그 밖 |
|---|---|---|---|---|---|
| `planner`, `revision` | opener: 새 반복을 엶 | — | planner | 거부 | |
| `architect`, `critic` | — | 자기 lane | 자기 역할 | 받음 | |
| `disposition` | — | — | 거부 | 거부 | 본문을 JSON으로 검사·재직렬화 (11장) |
| `intent`, `post-interview`, `adr` | — | — | 거부 | 거부 | |
| `final` | — | — | 거부 | 거부 | `pending-approval.md` 복사, 승인 판정 |

"거부"는 그 입력을 넘겼을 때 거부한다는 뜻입니다. `—`는 그 검사를 하지 않는다는 뜻입니다. 막힘(7.6) 뒤에도 opener가 아닌 단계는 상한에 걸리지 않습니다.

### 2.2 `stage_n`

`parseStageN`(`ledger.ts:341-351`, gjc `parseStageN`)은 1 이상 999 이하의 정수만 받습니다. 그 밖(0, 1000, 1.5, 없음)은 이렇게 거부합니다. 문자열은 입력 스키마(`stage_n: z.number()`, `tool.ts:119`)가 먼저 거르고, 스키마를 거치지 않고 들어와도 `parseStageN`이 같은 문구로 거부합니다(테스트 "file names, stage_n range, body normalization and plain-hex sha256").

```
invalid stage_n: <값>. Expected integer 1..999.
```

`stage_n`은 회차 번호이고, 반복(iteration)을 세는 열쇠가 아닙니다. 반복은 원장의 opener 행 순서로 셉니다(7.2). 단계마다 `stage_n`은 따로이므로 `planner 1`과 `critic 1`은 다른 단계 파일입니다. `(stage, stage_n)` 쌍 하나에 단계 파일 하나입니다(spec D-T6).

### 2.3 파일 이름과 본문

- 파일 이름: `ralplanStageFileName`(`ledger.ts:336-338`) = `stage-${pad2(stage_n)}-${stage}.md`. `pad2`(`:331-333`)는 두 자리로 0을 채울 뿐 자르지 않으므로 100 이상은 세 자리입니다(`stage-100-critic.md`). disposition도 `.md`이고 내용은 JSON입니다.
- 본문 정규화: `normalizeArtifactContent`(`:354-356`)는 `\n`으로 끝나지 않으면 `\n` 하나를 붙입니다. 그 밖에는 바꾸지 않습니다. disposition은 먼저 11장의 재직렬화를 거칩니다.
- 해시: `sha256Hex`(`:359-361`)는 정규화한 본문(UTF-8)의 sha256 소문자 16진수입니다. `sha256:` 접두어가 없습니다. 이 값이 단계 파일 바이트의 해시이고, 원장 행과 영수증의 `sha256`입니다.
- 빈 본문: 도구는 정확히 `""`만 거부합니다. 공백만 있는 `content`(`"   "`)는 받아서 `"   \n"`로 저장합니다(실행해 확인).

## 3. 원장 `index.jsonl`

### 3.1 행 모양

**단계 행** (`ralplanStageIndexEntry`, `ledger.ts:125-141`). 키 순서도 이대로입니다.

```json
{"stage":"planner","stage_n":1,"path":"<session>/plans/ralplan/ses_root/stage-01-planner.md","created_at":"2026-10-03T15:03:10.187Z","sha256":"a6d460515adec1cd33d8b33e124d539c2836697dc2078ab65727c7745207a307"}
```

- `path`는 단계 파일의 절대 경로, `created_at`은 행을 만든 시각(ISO)입니다. 새 기록에서는 단계 파일을 쓴 직후의 시각이고, 원장 복구에서는 복구한 시각입니다(4.3).
- **final 행**에만 `auto_handoff`가 붙습니다(10장).

```json
{"stage":"final","stage_n":2,"path":"<session>/plans/ralplan/ses_root/stage-02-final.md","created_at":"2026-10-03T15:03:10.212Z","sha256":"dc1eee15…","auto_handoff":{"configuredTarget":"off","effectiveTarget":"off","degradationReason":null,"source":"default"}}
```

**막힘 행** (`ralplanPlanningStuckIndexEntry`, `:143-154`). `stage`가 없으므로 반복과 lane 계산에서는 행으로 세지 않습니다.

```json
{"event":"planning_stuck","planning_stuck":true,"marker":"PLANNING-STUCK","reason":"ralplan consensus iteration cap exceeded: opening revision would start iteration 2 (max 1)","created_at":"2026-10-03T15:03:10.254Z"}
```

### 3.2 멱등 추가

원장에 행을 붙이는 곳은 `appendJsonlIdempotentTx`(`store.ts:335-353`, gjc `appendJsonlIdempotent`) 하나입니다. 지금 원장을 읽고, `findJsonlDuplicate`(`ledger.ts:186-205`)가 키가 같은 행을 찾으면 붙이지 않습니다. 붙였을 때만 `ledger/append` 감사 행을 남깁니다.

| 키 함수 | 키 | 결과 |
|---|---|---|
| `ralplanIndexKey` (`:161-172`) | `stage`, `stage_n`, `sha256`을 `\u0000`으로 이은 문자열. 셋 중 하나라도 타입이 맞지 않으면 키 없음 | 같은 내용의 단계 행은 두 번 붙지 않습니다. |
| `ralplanPlanningStuckIndexKey` (`:175-179`) | `planning_stuck === true`면 `"planning_stuck"` | 막힘 행은 run마다 하나. 두 번째 막힘은 행을 붙이지 않고, 첫 사유가 남습니다. |

`findJsonlDuplicate`는 빈 줄과 JSON이 아닌 줄을 건너뜁니다. 그래서 망가진 줄이 추가를 막지는 않습니다. 키가 없는 후보(키 함수가 `undefined`)는 늘 붙습니다.

### 3.3 원장 읽기

`loadIndexTx`(`store.ts:324-332`)는 원장을 텍스트로 읽어 `loadRalplanIndexForCap`(`ledger.ts:238-257`)에 넘깁니다. 결과 `RalplanIndexLoad`는 `rows`, `indexPresent`, `parseableLines`, `rawLineCount`, `rawText`입니다.

- 줄 나누기는 `\r?\n`, 공백만 있는 줄은 버립니다(`rawLineCount`에서도 빠짐).
- `parseRalplanIndexLine`(`:208-223`)은 JSON 객체이고 `stage`가 문자열인 줄만 행으로 받습니다. `{stage, stageN?}`만 남깁니다(`stage_n`이 숫자일 때만 `stageN`). 막힘 행과 망가진 줄은 `rows`에 없습니다.

| 원장 상태 | `indexPresent` | `rows` | 막힘 판정 (10.2) |
|---|---|---|---|
| 파일 없음 | false | 빈 목록 | 아님 |
| 파일은 있으나 읽기 실패(예: 심볼릭 링크) | true | 빈 목록, `rawText` 없음 | 막힘 |
| 줄이 있는데 하나도 행이 아님 | true | 빈 목록 | 막힘 |
| 망가진 줄이 하나라도 있음 | true | 읽힌 행만 | 막힘 |
| 정상 | true | 모든 단계 행 | 막힘 행이 있을 때만 |

읽기 실패는 막힘 판정에서 끝나지 않습니다. 원장에 행을 붙일 때(14단계) `appendJsonlIdempotentTx`가 원장을 다시 읽다 같은 예외를 던지므로, 새 기록은 `Error: index.jsonl is not a regular file`로 끝납니다. 그때는 13단계의 상태 갱신과 단계 파일이 이미 쓰였고, 원장 행과 `pending-approval.md`는 없습니다(실행해 확인: 원장을 심볼릭 링크로 바꾼 뒤 `final 1`을 쓰면 상태는 `final`, 폴더에 `stage-01-final.md`만 생김).

읽기 결과를 쓰는 곳:

- 중복 확인(`findExistingStageArtifact`)과 disposition 출처 검사(`buildIndexedReviewArtifacts`)는 `rawText`를 다시 줄 단위로 읽습니다. 망가진 줄은 건너뜁니다.
- 반복 상한과 lane 예산은 `rows`를 씁니다. 원장이 적게 세면 디스크의 단계 파일로 보충합니다(7.2, 7.3).
- 승인 판정은 막힘 판정을 씁니다. 원장이 망가지면 실패 쪽(막힘)으로 판정합니다.
- 활성 행의 HUD 칩(`hud.ts:139-182`), 압축 문맥(`recovery.ts`)도 같은 원장을 읽습니다([state-and-files.md](state-and-files.md), [guards-and-continuation.md](guards-and-continuation.md)).

### 3.4 반복 요약: `summarizeRalplanIndex`

`summarizeRalplanIndex`(`ledger.ts:270-285`)는 행을 붙인 순서대로 보며 `iteration`과 `currentStages`를 셉니다.

- `planner`나 `revision` 행은 반복을 하나 올리고 `currentStages`를 그 단계 하나로 새로 시작합니다.
- 다른 행은 `currentStages`에 붙습니다. 그때까지 opener가 없었으면 `iteration`을 1로 둡니다.

따라서 opener보다 먼저 다른 단계가 기록된 run(예: `start` 없이 `architect 1`부터 쓴 run)은 그 단계가 반복 1을 열고, 뒤에 오는 `planner`는 반복 2가 됩니다. 반복 상한을 하나 더 씁니다. gjc 코드도 같습니다(머리말 `ledger-event-renderer.ts:80-166`).

## 4. 같은 단계를 다시 쓸 때

### 4.1 기존 기록 찾기: `findExistingStageArtifact`

`findExistingStageArtifact`(`ledger.ts:430-461`)는 원장에서 `stage`와 `stage_n`이 같고 `path`와 `sha256`이 문자열인 **마지막** 행을 찾습니다. `path`나 `sha256`이 빠진 행은 없는 것으로 봅니다. 그래야 디스크 확인(원장 복구)으로 넘어갈 수 있습니다. final이면 그 행의 `auto_handoff`를 `parseRalplanFinalAdmission`으로 읽어 붙입니다(모양이 틀리면 `undefined`).

### 4.2 원장 중복

같은 `(stage, stage_n)`의 행이 있으면(`store.ts:668-692`):

1. 새 본문의 sha256이 행의 것과 다르면 덮어쓰기 거부(4.4).
2. 같으면, final만 `ensureFinalPendingApprovalTx`로 `pending-approval.md`를 확인합니다(5장).
3. 중복 영수증(`deduplicated: true`)을 돌려줍니다. 단계 파일, 원장, 상태, 활성 행은 바꾸지 않습니다. 이번 입력의 역할 메타와 lane verdict는 **적용하지 않고** 영수증에도 넣지 않습니다(DR-20, gjc 그대로).

예: `architect 2`를 같은 본문, 다른 `lane_verdict: "WATCH"`로 다시 쓰면 중복 영수증만 돌아오고 상태의 `last_review_verdict`는 `OKAY` 그대로입니다(13.2).

단계 파일이 지워졌어도 원장 행만 있으면 이 경로입니다. final이 아니면 파일을 확인하지 않으므로 중복 영수증이 돌아오고 파일은 다시 만들어지지 않습니다. final이면 5장의 확인이 `stage artifact missing`으로 거부합니다. 이 문구는 open-gajae에만 있고, gjc는 파일 읽기 오류를 그대로 던집니다(ralplan 편차 41).

### 4.3 원장 복구

행은 없는데 `stage-NN-<stage>.md`가 디스크에 있으면(`store.ts:695-759`, gjc `:2103-2135`) 파일을 쓴 뒤 원장 행을 붙이기 전에 멈춘 것으로 봅니다.

1. 디스크 파일의 sha256이 새 본문과 다르면 덮어쓰기 거부(4.4).
2. 같으면, final만 `pending-approval.md`를 확인합니다(5장).
3. `repairLedgerTx`(`:440-491`)가 원장 행을 붙입니다. `created_at`은 지금 시각입니다. final이면 행의 `auto_handoff`는 늘 `unavailableRalplanFinalAdmission()`입니다(10.4). 같은 `(stage, stage_n, sha256)` 키의 행이 이미 있으면(4.1이 `path`가 없어 건너뛴 행) 붙이지 않고, 영수증은 디스크 경로와 지금 시각을 씁니다. 이때 원장은 고쳐지지 않습니다. `path`와 `sha256`이 다 있는 같은 키의 행이었다면 4.2에서 이미 걸렸으므로, 코드의 "기존 행 값을 쓰는" 분기(`:464-482`)에는 도구 경로로 닿지 않습니다.
4. 역할 메타와 lane verdict는 상태의 `run_id`가 이번 `run_id`와 같을 때만 병합합니다(`mergeRunStateTx`의 `expectedRunId`, DR-20). 적용한 것만 영수증에 넣습니다. 상태가 없거나 다른 run이면 아무것도 병합하지 않습니다.
5. 중복 영수증을 돌려줍니다. 13단계의 상태 갱신(phase 전진, 다시 활성화), final 승인 판정의 상태 기록, 활성 행 갱신은 하지 않습니다.

이 경로의 결과 첫 줄도 `… (identical content; no changes written).`입니다. 실제로는 원장 행 하나(와 경우에 따라 `pending-approval.md`, 상태)를 썼습니다. gjc `buildDeduplicatedResult`(`:2270-2311`)도 같은 문구를 씁니다.

### 4.4 덮어쓰기 거부

두 경로 모두 `stageOverwriteRefusal`(`ledger.ts:464-472`)의 문구로 거부합니다. gjc의 `--stage_n`이 `stage_n`으로 바뀌었습니다(편차 1).

```
Error: refusing to overwrite ralplan final stage 2 at <session>/plans/ralplan/ses_root/stage-02-final.md: an artifact with different content already exists (existing sha256=dc1eee1540f3d5b561b108ca829d7dfa7b21a0bb8b232bcb2759681ff895d267, new sha256=c0cf8fd87f931959cb1c4a7ee44ee41a99d4f2afc166e59cd0d5de98bf72c183). Use a new stage_n to record another pass.
```

이 거부는 상태 쓰기(13단계)보다 앞이므로 phase를 되돌리지 않습니다.

### 4.5 세 경우 정리

| 원장 행 | 디스크 파일 | 내용 | 결과 |
|---|---|---|---|
| 있음 | (보지 않음, final은 확인) | 같음 | 중복 영수증, 아무것도 쓰지 않음 (final은 사본만 복구 가능) |
| 있음 | — | 다름 | 덮어쓰기 거부 |
| 없음 | 있음 | 같음 | 원장 복구 + 중복 영수증 |
| 없음 | 있음 | 다름 | 덮어쓰기 거부 |
| 없음 | 없음 | — | 예산 검사로 넘어가 새 기록 |

중복과 복구는 예산 검사보다 앞이므로 같은 내용의 재시도는 막힘이 되지 않습니다(SKILL의 per-lane 절 "Identical re-writes dedupe without stuck-signaling").

## 5. `pending-approval.md`

run 폴더의 `pending-approval.md`는 최신 final의 바이트 사본입니다(`RALPLAN_PENDING_APPROVAL_FILE`, `ledger.ts:58`).

- **새 final**: `persistArtifactTx`(`store.ts:372-405`)가 단계 파일, 원장 행 다음에 같은 내용으로 덮어씁니다(`artifact/write` 감사 행). 앞 final의 단계 파일은 그대로입니다. 막힌 run의 final, 잠긴 phase 위의 final도 씁니다.
- **final의 중복·복구**: `ensureFinalPendingApprovalTx`(`store.ts:408-437`, gjc `ensureFinalPendingApproval`, `:1776-1823`)가 확인합니다.
  1. 단계 파일을 읽습니다. 없으면 거부.
  2. 단계 파일의 sha256이 기록(원장 행 또는 디스크)의 것과 다르면 거부.
  3. 사본이 없으면 단계 파일 내용으로 새로 씁니다(`artifact/write`).
  4. 사본이 있는데 바이트가 다르면 거부.

```
refusing to deduplicate ralplan final stage <n>: stage artifact missing at <단계 파일 경로>.
refusing to deduplicate ralplan final stage <n>: stage artifact sha256 mismatch at <단계 파일 경로> (ledger sha256=<기록>, artifact sha256=<파일>).
refusing to deduplicate ralplan final stage <n>: pending approval content mismatch at <사본 경로> (stage sha256=<단계 파일>, pending sha256=<사본>).
```

첫 문구는 open-gajae에만 있습니다. gjc는 이 경우 파일 읽기 예외를 그대로 던집니다.

- **앞 final의 재시도는 거부됩니다.** final 3을 쓴 뒤 final 2를 같은 내용으로 다시 쓰면, 사본이 final 3이므로 세 번째 문구로 거부합니다(13.2에서 실행해 확인). gjc도 같습니다.
- Stop here, `clear`, `handoff`는 사본을 지우지 않습니다. `ralplan handoff`의 결과 줄이 이 경로를 알려 줍니다([entry-and-handoff.md](entry-and-handoff.md)).

## 6. run 식별과 상태 갱신

### 6.1 `run_id` 정하기

`writeStageTx`(`store.ts:643`)와 `startRunTx`(`:925`)는 같은 순서를 씁니다(gjc `:1565-1570`, DR-19).

1. 입력 `run_id`를 trim한 값. 비어 있으면 다음으로.
2. 상태의 `run_id`(`activeRunId`, `:498-503`, gjc `readActiveRunId`). trim한 값이 비어 있지 않으면 경로 성분 검사를 거칩니다. 이름은 "active"지만 상태의 `active` 값은 보지 않습니다. 그래서 Stop here나 `clear` 뒤에도 같은 run이 이어집니다.
3. 소유 세션 ID(계보 루트의 native ID).

run 폴더는 `tx.paths.runDir(runId)` = `<session>/plans/ralplan/<run_id>`이고, `safeComponent`(`src/state.ts:204-208`, gjc `assertSafePathComponent`)가 검사합니다. 첫 글자는 `A-Z a-z 0-9 _ -`, 나머지는 거기에 `.`을 더한 글자, 전체 1~64자이고 `..`을 포함하면 안 됩니다. 어기면 `invalid path component for run_id: <값>`입니다. 입력 `run_id`가 있으면 상태의 `run_id`는 검사하지 않습니다.

바인딩은 `start`와 다릅니다. `start`는 같은 run일 때만 상태의 바인딩을 씁니다. `write`는 run이 바뀌어도 상태에 `repository_binding`이 있으면 그것을 영수증에 씁니다(`:647-648`). 어느 쪽이든 기록만 하고 강제하지 않습니다(편차 12).

### 6.2 상태 갱신: `persistActiveRunIdTx`

`persistActiveRunIdTx`(`store.ts:513-545`, gjc `persistActiveRunId` `:986-1059`, DR-3)는 새 기록(13단계)에서만 불립니다. 중복, 복구, 막힘 경로는 부르지 않습니다.

`isNewRun`은 상태의 `run_id`가 이번 `run_id`와 다를 때 참입니다(상태가 없을 때 포함). 다음 phase는 새 run이면 방금 쓴 단계, 같은 run이면 `advanceCurrentPhase`(`manifest.ts:158-166`)의 결과입니다. `advanceCurrentPhase`는 지금 phase(trim)가 `RALPLAN_PHASE_LOCK`(`manifest.ts:72-81`: `final`, `handoff`, `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`)에 있으면 그대로 두고, 아니면 방금 쓴 단계를 돌려줍니다. 이 여덟 개는 T와 같은 집합입니다.

| 경우 | 상태에 쓰는 것 |
|---|---|
| 상태 없음 | 새 상태 `{run_id, skill: "ralplan", active: true, current_phase: <stage>, version: 2, updated_at}`. `mode`, `interactive`, `task`, `session_id`, 바인딩은 없습니다(R-O6). |
| 새 run | 아래 6.3의 필드를 지우고, `run_id`, `active: true`, `current_phase: <stage>`, `updated_at`. 잠긴 phase여도 새 run은 단계로 갑니다. |
| 같은 run, 잠기지 않은 phase | `active: true`, `current_phase: <stage>`, `updated_at`. 뒤로 가는 이동(예: `critic` → `planner`)도 그대로 씁니다. |
| 같은 run, `version: 2`, phase가 이미 그 단계이고 `active: true` | 쓰지 않음 (예: `architect 1` 다음 `architect 2`) |
| 같은 run, `version: 2`, 잠긴 phase | 쓰지 않음. `active`가 `false`여도 그대로 (R-OD9) |
| 같은 run, `version`이 2가 아님, 잠긴 phase | 조기 반환 조건을 통과하지 못해 `active: true`로 씁니다. phase는 manifest 상태면(`final`, `handoff`) 그대로, 아니면(`complete` 등) `migrateRalplanState`가 `planner`로 바꿉니다(실행해 확인: v1 `{active:false, current_phase:"final"}` → `{"active":true,"current_phase":"final","version":2}`, v1 `complete` → `planner`). open-gajae가 쓰는 상태는 늘 `version: 2`이므로 다른 곳에서 온 파일에서만 생깁니다([state-and-files.md](state-and-files.md)의 `migrateRalplanState`). |

쓸 때는 `migrateRalplanState`를 거치고(`version` 2, `skill`), `skill`이 문자열이 아니면 `"ralplan"`으로 둡니다. 쓰지 않는 조건은 gjc `:1014-1021`의 조기 반환 그대로입니다. 한 가지 결과: 상태가 잠기지 않은 phase에서 `active: false`가 되었으면(예: `critic`에서 continuation breaker가 소진되었거나 `ralplan state(patch={"active": false})`를 불렀으면) 다음 write가 run을 다시 `active: true`로 만듭니다.

### 6.3 새 run으로 바꿀 때

새 run이면 상태에서 이 필드를 지웁니다(`store.ts:523-529`, gjc 그대로).

- `verdict`
- 이름이 `last_review_verdict`로 시작하는 모든 키 (`last_review_verdict`, `_lane`, `_stage_n`)
- `planning_stuck`
- `auto_handoff`

나머지는 그대로 둡니다. `mode`, `interactive`, `task`, `session_id`, `repository_binding`, `handoff_from`, 역할 ID(`planner_subagent_id`, `architect_id`, `critic_id`), `*_resumable`, `*_fallback_*`가 모두 남습니다. 13.2의 실행에서 `run-2`로 바꾼 뒤의 상태가 그 예입니다. 새 run은 새 폴더이므로 원장, 반복 상한, lane 예산도 새로 시작합니다. 옛 run 폴더는 그대로 남고, 입력 `run_id`로 다시 그 폴더에 쓸 수 있습니다(그때는 다시 run 전환).

### 6.4 잠긴 phase 위의 write (R-OD9)

같은 run에서 phase가 잠긴 뒤의 write — final 다음의 다듬기, Stop here(`final`, `active: false`) 뒤, `clear`(`complete`) 뒤, `ralplan handoff`(`handoff`) 뒤 — 에서 실제로 쓰이는 것은 이렇습니다(Stop here 뒤는 13.2, `handoff` 뒤는 따로 돌린 스크립트로 확인).

| 대상 | 쓰나 | 내용 |
|---|---|---|
| 단계 파일, 원장 행 | 씀 | 보통과 같음. final이면 `pending-approval.md`도 덮어씀 |
| 상태의 `active`, `current_phase` | 쓰지 않음 | 13단계가 조기 반환 |
| 상태의 다른 필드 | 씀 | 역할 메타(역할이 자기 단계를 쓰면 늘 있음), lane verdict, final의 `auto_handoff`가 `updated_at`과 함께 병합됨. `active`는 `false`로 남음 |
| 활성 행 `state/active/ralplan.json` | 씀 | `active: true`, `phase: <방금 쓴 단계>`. `handoff_to`는 없어짐. 이것은 파일에 쓰인 원본이고, 보이는 주 skill을 읽는 쪽(`readVisiblePrimaryTx`, `src/skill-state/rows.ts:254-283`, gjc `withCanonicalRalplanPhase`)은 상태 phase가 잠겨 있으면 행의 `phase`와 `stage` 칩을 그 phase로 바꿔 봅니다(DR-8, R-OD15) |
| 위쪽 파이프라인 행 | 지움 | `deep-interview` 행이 있으면 지움(`syncActiveRowTx`, `src/skill-state/rows.ts:149-162`) |
| 스냅숏 | 다시 만듦 | |
| 전이 감사 행 | 없음 | 13단계가 상태를 쓰지 않으므로 |

예: Stop here 뒤 planner 역할이 `revision 3`을 쓰면 상태 파일은 바뀌지만(역할 ID 병합으로 `updated_at`이 바뀜) `{"active":false,"current_phase":"final"}`은 그대로이고, 활성 행은 `{"phase":"revision","active":true}`가 됩니다. 감사 행은 `artifact:write`, `ledger:append`, `state:write`, `state:write-active-entry`, `state:rebuild-active-snapshot`입니다. 그 뒤 `ralplan doctor`는 `stale_active_state` 셋을 보고합니다(13.2). 이 보고는 알려진 동작입니다(R-OD8, [known-limits.md](known-limits.md) RK8).

`ralplan handoff(to: "deep-interview")` 뒤 같은 run에 write하면, ralplan 상태는 `{active: false, current_phase: "handoff", handoff_to: "deep-interview"}`로 남지만 deep-interview의 활성 행이 지워지고 ralplan 행이 `active: true`로 쓰입니다(실행해 확인: 행 파일은 `ralplan.json` 하나만 남고, 스냅숏의 주 skill은 `ralplan`). gjc도 활성 항목을 쓸 때 위쪽 파이프라인 항목을 지웁니다(`skill-state/active-state.ts:886-898`, 확인). 그 결과 보이는 주 skill과 가드·continuation이 어떻게 되는지는 [guards-and-continuation.md](guards-and-continuation.md)를 봅니다.

[known-limits.md](known-limits.md) RK8과 [state-and-files.md](state-and-files.md)도 같게 적습니다: 잠긴 phase에서는 `active`와 phase만 그대로이고, 기록한 역할의 세션 ID, lane verdict, `final`의 `auto_handoff`는 상태에 합쳐지며, 활성 행은 방금 쓴 단계로 다시 활성이 됩니다. SKILL의 문구("keeps a locked phase … and does not re-activate the state")도 코드와 맞습니다. 결정 기록인 계획 DR-3(`.omc/plans/ralplan-gjc-stage-trail.md:31`)만 "상태를 전혀 바꾸지 않는다"로 남아 있습니다. 계획 문서는 당시 기록이라 고치지 않았고, 코드가 기준입니다.

### 6.5 같은 run 병합: `mergeRunStateTx`

역할 메타와 lane verdict는 `mergeRunStateTx`(`store.ts:548-565`, gjc `applyPersistedRoleStateUpdate`/`applyLaneVerdictUpdate`의 공통 몸체)로 상태에 붙습니다.

- `expectedRunId`가 주어지고(복구 경로) 상태의 `run_id`와 다르면 아무것도 하지 않고 `undefined`를 돌려줍니다. 새 기록 경로는 `undefined`를 넘기므로 늘 병합합니다(13단계가 이미 같은 run으로 맞춰 둠).
- 필드를 `Object.assign`으로 덮고, `skill`이 문자열이 아니면 `"ralplan"`, `active`가 boolean이 아니면 `true`, `current_phase`가 문자열이 아니면 `"planner"`로 채운 뒤 `migrateRalplanState`, `updated_at`을 씁니다.
- 막힘 기록(`recordPlanningStuckTx`, 7.5)과 final 승인 기록(`persistFinalAdmissionTx`, `:594-606`)은 상태의 `run_id`가 이번 run일 때만, 지금 상태에 그 필드 하나를 얹고 `migrateRalplanState`, `updated_at`을 씁니다. `skill`, `active`, `current_phase`를 채우는 기본값 처리는 없습니다.

### 6.6 전이 감사 행

`writeStateTx`(`store.ts:193-247`, gjc `writeWorkflowEnvelopeAtomic`)는 쓰기 전에 전이를 봅니다. 조건은 넷입니다.

1. `force`가 아니고 새 상태가 `active: true`
2. 새 phase(`current_phase` trim)가 있음. manifest 밖이면 1.2의 거부
3. 이전 phase: 감사 입력의 `fromPhase`, 없으면 이전 상태가 `active: true`일 때만 그 `current_phase`
4. 이전 phase가 manifest 상태이고, 새 phase와 다르고, `isValidTransition`(`manifest.ts:147-152`)이 거짓

넷이 맞으면 `invalid_transition_detected` 감사 행을 하나 붙이고(실패해도 무시), 쓰기는 그대로 합니다(spec D-T11). `write`에서 이 조건이 맞는 것은 13단계뿐입니다. 이전 상태가 비활성(Stop here 뒤 등)이면 3번에서 이전 phase가 없으므로 행이 없습니다. 병합 쓰기는 phase를 바꾸지 않으므로 행이 없습니다. `state` op는 같은 표로 **거부**합니다([ops.md](ops.md)).

전이 표는 gjc ralplan manifest 그대로입니다(`RALPLAN_TRANSITIONS`, `manifest.ts:42-69`). SKILL의 순서가 표에 없는 이동을 늘 만듭니다([known-limits.md](known-limits.md) RK9).

| SKILL의 순서 | 이동 | 표에 있나 |
|---|---|---|
| planner 뒤 intent | `planner → intent` | 있음 |
| 1회차 리뷰, architect가 먼저 | `intent → architect`, `architect → critic` | 있음 |
| 1회차 리뷰, critic이 먼저 (병렬) | `intent → critic`, `critic → architect` | 없음 |
| intent에서 계약이 바뀌어 revision 뒤 리뷰 | `revision → architect`, `revision → critic` | 없음 |
| 마지막 리뷰가 architect | `architect → revision`, `architect → post-interview` | 없음 |
| critic 뒤 revision, post-interview | `critic → revision`, `critic → post-interview` | 있음 |
| 2회차 이후: revision 다음 architect | `revision → architect` | 없음 |
| disposition | `architect → disposition`, `critic → disposition`, `disposition → revision` | 있음 |
| step 7: post-interview 뒤 final | `post-interview → final` | 없음 (표는 `adr`을 거침) |
| final 뒤 다듬기 | (잠긴 phase, 상태를 쓰지 않음) | 행 없음 |

13.1의 실행 A(1회차 architect 먼저, 2회차, post-interview 뒤 final)는 `revision -> architect`, `post-interview -> final` 두 행을 남겼습니다. gjc도 같은 표와 같은 SKILL이므로 같은 행을 씁니다.

## 7. 반복 상한과 lane 예산

### 7.1 설정

설정 세 개는 `src/config.ts`가 플러그인 setup 때 한 번 읽습니다(`src/index.ts:29`, 편차 4, DR-13). 바꾸면 OpenCode를 다시 시작해야 합니다.

| 키 | 값 | 기본값 | 잘못된 값 |
|---|---|---|---|
| `ralplan.maxIterations` | 정수 1..20 | 5 | `<파일>.ralplan.maxIterations: expected an integer between 1 and 20` |
| `ralplan.maxReviewPassesPerLane` | 정수 1..10 | 1 | `<파일>.ralplan.maxReviewPassesPerLane: expected an integer between 1 and 10` |
| `ralplan.autoHandoff` | `"off"` 또는 `"ultragoal"` | `"off"` | `<파일>.ralplan.autoHandoff: expected one of off, ultragoal` |

- 검사는 `load`(`config.ts:103-135`)가 하고, 모르는 키는 `<파일>.ralplan.<키>: unknown setting`입니다. 어느 하나라도 틀리면 `loadSettings`가 예외를 던지고 플러그인 setup이 그 예외로 끝납니다. 호스트는 setup이 실패한 플러그인을 `failed` 상태로 두고, 플러그인 정의가 바뀌기 전에는 다시 시도하지 않습니다(OpenCode v2.0.15 `core/src/plugin.ts:23-24,285-290`). 그래서 설정을 고친 뒤에는 OpenCode를 다시 시작해야 합니다. 어느 경우든 틀린 설정으로 도는 write는 없습니다.
- 우선순위는 키마다 프로젝트 `<worktree>/.open-gajae/open-gajae.jsonc` → 사용자 `~/.open-gajae/open-gajae.jsonc` → 기본값입니다(`config.ts:166-171,197-208`).
- `source`는 키마다 이긴 파일의 경로(`join`으로 만든 절대 경로) 또는 `default`입니다. PLANNING-STUCK 결과의 `*_source`와 `auto_handoff.source`가 이 값입니다.
- `evaluateRalplanIterationCap`과 `evaluateRalplanReviewLaneBudget`은 범위 밖 값을 받으면 기본값(5, 1)으로 바꿉니다. 설정 로더가 이미 거르므로 도구 경로에서는 쓰이지 않는 방어 코드입니다.

### 7.2 반복 상한: `evaluateRalplanIterationCap`

opener는 `planner`와 `revision`입니다(`RALPLAN_ITERATION_OPENER_STAGES`, `ledger.ts:75`). 반복은 opener 행이 연 구간입니다(3.4).

`evaluateRalplanIterationCap`(`ledger.ts:531-582`)의 계산:

1. `fromIndex` = `summarizeRalplanIndex(rows).iteration`
2. `floor` = 디스크의 opener 파일 수 `countRalplanOnDiskOpeners`(`:487-493`). 정규식 `^stage-\d{2,}-(planner|revision)\.md$`(`:479`)에 맞는 이름을 셉니다.
3. `currentIterations` = `max(fromIndex, floor)`. 원장이 지워지거나, 비거나, 잘리거나, 망가져도 디스크 파일이 아래를 받칩니다(AC8).
4. 이번 단계가 opener가 아니면 허용합니다. `final` 포함, 상한을 넘은 뒤에도 그렇습니다.
5. opener면 `projectedIterations = currentIterations + 1`, 이것이 `maxIterations`보다 크면 거부합니다.

거부 사유(`reason`) 문구:

```
ralplan consensus iteration cap exceeded: opening <stage> would start iteration <projected> (max <max>)
ralplan consensus iteration cap exceeded: opening <stage> would start iteration <projected> (max <max>) (ledger under-count: index=<fromIndex>, on-disk openers=<floor>)
```

둘째는 `floor > fromIndex`일 때입니다. 상한은 run 폴더마다입니다. 기본값 5에서는 opener 다섯 번(planner 1 + revision 4)까지 열리고 여섯째가 막힙니다(테스트 "opener cap: the 5th opener is allowed, the 6th is PLANNING-STUCK").

### 7.3 lane 예산: `evaluateRalplanReviewLaneBudget`

`evaluateRalplanReviewLaneBudget`(`ledger.ts:610-674`)은 `architect`와 `critic`만 봅니다. 다른 단계는 늘 허용합니다(`currentPasses: 0`). 계산은 이렇습니다.

1. 원장 행을 `(stage, stageN)` 기준으로 하나씩만 남깁니다(`deduplicateRalplanIndexRowsByStageIdentity`, `:314-325`).
2. `indexCurrent` = 지금 반복(`currentStages`)에 있는 이 lane의 행 수. 마지막 opener 행 **뒤에** 붙은 행만 셉니다. `stage_n`은 보지 않습니다.
3. `parsedTotal` = run 전체에서 이 lane의 행 수
4. `onDiskTotal` = 디스크의 이 lane 파일 수(`countRalplanOnDiskLaneArtifacts`, `:499-509`, 정규식 `^stage-\d{2,}-(architect|critic)\.md$`)
5. `diskExcess = max(0, onDiskTotal - parsedTotal)`, `currentPasses = indexCurrent + diskExcess` (DR-4)
6. `projectedPasses = currentPasses + 1`. 이것이 `maxReviewPassesPerLane`보다 크면 거부합니다. 같으면 `finalSlot: true`입니다.

거부 사유 문구(`iteration`은 `max(1, summary.iteration)`):

```
ralplan review lane budget exceeded: <lane> pass <projected> of max <max> in consensus iteration <n>
ralplan review lane budget exceeded: <lane> pass <projected> of max <max> in consensus iteration <n> (ledger under-count: parsed <lane> rows=<parsedTotal>, on-disk <lane> artifacts=<onDiskTotal>)
```

따라 나오는 성질:

- 예산은 반복마다 새로 시작합니다. 기본값 1에서는 반복마다 architect 한 번, critic 한 번입니다. 다음 리뷰는 `revision`을 쓴 뒤에 열립니다.
- 순서만 봅니다. 1회차 리뷰를 `revision 2` 다음에 늦게 쓰면 그 리뷰는 반복 2의 예산을 씁니다.
- 디스크 초과분은 run 전체에서 세어 지금 반복에 더합니다. 원장이 지워진 run에서는 그 lane 파일이 하나라도 있으면 기본값 1에서 그 lane이 막힙니다(테스트 "lane budget: one critic per iteration, a revision resets it, disk excess counts").

`reviewBudgetWarning`(`:683-695`)은 허용된 쓰기가 마지막 칸(`finalSlot`)을 썼고 한도가 1보다 클 때 `{lane, passes, max}`를 돌려줍니다. 한도가 1이면 경고가 없습니다. 영수증의 `review_budget_warning`과 첫 줄 `Warning: …`가 이것입니다(12.1).

### 7.4 PLANNING-STUCK 결과

상한이나 예산을 넘으면 `writeStageTx`는 예외 대신 `{kind: "stuck", payload, detail}`을 돌려주고, 도구는 `<detail>\n<payload JSON>`을 결과로 냅니다. 두 종류가 있습니다(gjc `:527-612`).

**반복 상한** (`buildPlanningStuckResult`, `ledger.ts:703-730`). `detail`:

```
PLANNING-STUCK: <reason> (run_id=<run>, stage=<stage>, stage_n=<n>, source=<maxIterations의 source>). Stop opening planner/revision passes; escalate the best existing plan via final/pending-approval without auto-implementation.
```

`payload`: `ok: false`, `planning_stuck: true`, `marker: "PLANNING-STUCK"`, `run_id`, `stage`, `stage_n`, `iteration`(= `currentIterations`), `projected_iteration`, `max_iterations`, `max_iterations_source`, `reason`.

**lane 예산** (`buildLaneBudgetStuckResult`, `:732-762`). `detail`:

```
PLANNING-STUCK: <reason> (run_id=<run>, stage=<stage>, stage_n=<n>, source=<maxReviewPassesPerLane의 source>). Stop re-invoking the <lane> review lane in this consensus iteration; route a rule-2-justified blocker through a Planner revision opener (fresh lane budget) while opener budget remains, or escalate the best existing plan via post-interview/adr/final without auto-implementation.
```

`payload`: `ok: false`, `planning_stuck: true`, `marker`, `run_id`, `stage`, `stage_n`, `lane`, `passes`(= `currentPasses`), `projected_passes`, `max_review_passes_per_lane`, `max_review_passes_source`, `reason`.

실제 결과는 13.3에 있습니다.

### 7.5 막혔을 때 기록하는 것: `recordPlanningStuckTx`

`recordPlanningStuckTx`(`store.ts:568-591`, gjc `recordRalplanPlanningStuck`)는 두 가지를 씁니다.

1. 막힘 행을 멱등 추가합니다(3.2). run에 막힘 행이 이미 있으면 붙이지 않으므로 원장에는 **첫** 막힘의 사유만 남습니다.
2. 상태가 있고 그 `run_id`가 이번 run이면 상태에 `planning_stuck: {marker: "PLANNING-STUCK", reason}`을 씁니다. 막힐 때마다 다시 쓰므로 상태에는 **마지막** 막힘의 사유가 남습니다(13.3: 반복 상한 뒤 lane 예산으로 막히자 상태의 `reason`이 lane 사유로 바뀜).

쓰지 않는 것: 단계 파일, 단계 행, phase 전진(상태의 `current_phase`는 막히기 전 그대로), 활성 행. 감사 행은 첫 막힘에서 `ledger:append`와 `state:write`, 그 뒤로는 `state:write`뿐입니다.

### 7.6 막힌 뒤

| 쓰기 | 막힌 run에서 |
|---|---|
| `planner`, `revision` (새 opener) | 상한을 넘는 동안 다시 PLANNING-STUCK |
| `architect`, `critic` | 이미 열린 반복의 예산 안이면 허용 |
| `intent`, `disposition`, `post-interview`, `adr`, `final` | 허용 (예산 검사 없음) |
| 같은 내용의 재기록 | 중복 영수증 (4장) |
| 새 `run_id`의 첫 쓰기 | 새 폴더, 새 예산. 상태의 `planning_stuck`을 지움(6.3) |

막힘의 효과는 run이 끝날 때까지 남습니다.

- 막힘 행이 있으므로 그 run의 모든 final은 `auto_handoff`가 `effectiveTarget: "off"`, `degradationReason: "planning_stuck"`입니다(10장). SKILL step 8은 이 영수증을 종료로 보고 넘기지도 묻지도 않습니다.
- 상태의 `planning_stuck`이 있으면 ralplan continuation이 멈춥니다(`src/ralplan.ts:129`, [guards-and-continuation.md](guards-and-continuation.md)).
- lane 예산을 넘은 것도 같은 막힘입니다. 막힘 문구는 "revision opener로 돌리라"고 안내하고 SKILL도 그렇게 적지만, 그 뒤 revision으로 합의에 이르러도 이 run의 final은 막힘으로 판정됩니다. gjc도 같습니다(`handleArtifactWrite`의 두 막힘 분기가 같은 `recordRalplanPlanningStuck`을 부름, 확인).
- 같은 run에서 막힘을 푸는 op는 없습니다. `ralplan state`로 상태의 `planning_stuck`을 지울 수는 있지만 원장의 막힘 행은 남습니다. 새 예산은 새 `run_id`뿐입니다.

## 8. lane verdict

architect와 critic은 자기 판정을 `lane_verdict`로 넘깁니다(SKILL step 3). `parseLaneVerdict`(`ledger.ts:1035-1053`, gjc `parseLaneVerdictArgs`)의 규칙:

| 단계 | 받는 값 (trim 후 대문자) |
|---|---|
| `architect` | `CLEAR`, `WATCH`, `BLOCK` |
| `critic` | `OKAY`, `ITERATE`, `REJECT` |

```
lane_verdict is only valid with stage architect or critic (received <stage>).
invalid lane_verdict for <stage>: <원래 값>. Expected one of: <받는 값, 쉼표+공백>.
```

`"clear"`는 `CLEAR`로 받습니다. `APPROVE`/`COMMENT`/`REQUEST CHANGES` 같은 architect의 두 번째 판정은 받지 않습니다.

적용되면(새 기록, 또는 같은 run의 원장 복구) 상태에 세 필드를 씁니다(`laneVerdictStatePayload`, `:1056-1064`).

| 필드 | 값 |
|---|---|
| `last_review_verdict` | 대문자 판정 |
| `last_review_verdict_lane` | `architect` 또는 `critic` |
| `last_review_verdict_stage_n` | 이번 `stage_n` |

lane마다 따로 두지 않고 마지막 하나만 남습니다. 새 run이면 지웁니다(6.3). 영수증에는 `lane_verdict: {lane, verdict}`가 붙습니다. 원장 중복 경로는 적용하지 않습니다(4.2).

이 값을 읽는 코드는 둘입니다. 활성 행의 `verdict` 칩(write 뒤에는 `store.ts:856-859`, `state` op와 ralplan이 callee인 공통 인계 뒤에는 `buildRalplanHudFromState`의 `hud.ts:198`, `src/skill-state/handoff.ts:82`), 그리고 압축 문맥의 다음 행동(`recovery.ts:281-285`: 원장의 마지막 행이 `critic`일 때 verdict가 critic의 `OKAY`면 `reconcile-intent`, 아니면 `revise-plan`)입니다. verdict로 쓰기를 거부하거나 합의를 판정하는 코드는 없습니다.

## 9. 역할 세션 ID와 대체 메타

### 9.1 무엇을 넘기나

역할 세션 ID는 입력이 아닙니다. 도구가 호출 agent에서 정합니다(`tool.ts:236-239`, 편차 5). 호출자가 `open-gajae-planner`/`-architect`/`-critic`이고 이번 단계가 그 역할의 단계일 때만 `{role, id: context.sessionID}`입니다. 역할의 단계는 `persistedRoleForStage`(`ledger.ts:908-912`)가 정합니다: `planner`와 `revision`은 planner, `architect`, `critic`은 각자. 그 밖의 경우(primary가 쓴 단계, 역할이 다른 역할의 단계를 쓴 경우)에는 ID를 기록하지 않습니다. 역할이 다른 역할의 단계를 쓰는 것 자체는 거부하지 않습니다(실행해 확인: architect 역할이 `critic 6`을 쓰면 기록되고 `critic_id`는 남지 않음).

### 9.2 `parsePersistedRoleState`

`parsePersistedRoleState`(`ledger.ts:931-1013`, gjc `parsePersistedRoleStateArgs`)는 이 순서로 봅니다.

1. 넘어온 역할 ID의 역할이 단계의 역할과 다르면 `<roleIdKey> is only valid with stage <planner or revision|architect|critic> (received <stage>).` 9.1 때문에 도구 경로에서는 나오지 않습니다.
2. 단계가 역할 단계가 아니면(`intent`, `disposition`, `post-interview`, `adr`, `final`): `resumable`이 있으면 `resumable is only valid with stage planner, revision, architect, or critic (received <stage>).`, `fallback_*` 중 하나라도 있으면 `fallback_reason is only valid with stage planner, revision, architect, or critic (received <stage>).`, 둘 다 없으면 아무것도 없음.
3. ID, `resumable`, `fallback_*`가 모두 없으면 아무것도 없음.
4. ID가 있으면 `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`(`SUBAGENT_ID_RE`, `:94`)로 검사: `invalid <planner_subagent_id|architect_id|critic_id>: <값>`
5. `resumable`은 넘어온 boolean 그대로
6. `fallback_*` 중 하나라도 있으면 묶음 검사:
   - `fallback_reason` 없음: `fallback_reason is required when recording <role> fallback metadata.`
   - 여섯 값(`KNOWN_FALLBACK_REASONS`, `:85-92`) 밖: `invalid fallback_reason: <값>. Expected one of: context_unavailable, not_found, no_runner, resume_failed, process_restart, missing_record.`
   - `fallback_attempted_id` 없음: `fallback_attempted_id is required when recording <role> fallback metadata.`, 정규식 밖: `invalid fallback_attempted_id: <값>`
   - `fallback_stage_n` 없음: `fallback_stage_n is required when recording <role> fallback metadata.`, 범위 밖은 `parseStageN`의 `invalid stage_n: <값>. Expected integer 1..999.`
   - `fallback_receipt_path`는 선택. 있으면 공백만이 아니어야 합니다: `fallback_receipt_path must not be empty.` 경로인지는 보지 않습니다.

모든 거부는 `writeStageTx` 전이므로 아무것도 쓰지 않습니다.

### 9.3 상태와 영수증

`persistedRoleStatePayload`(`ledger.ts:1016-1032`)가 넘어온 필드만 snake_case로 만듭니다.

| 역할 | ID | 나머지 |
|---|---|---|
| planner | `planner_subagent_id` | `planner_resumable`, `planner_fallback_reason`, `planner_fallback_attempted_id`, `planner_fallback_stage_n`, `planner_fallback_receipt_path` |
| architect | `architect_id` | `architect_resumable`, `architect_fallback_*` (같은 네 개) |
| critic | `critic_id` | `critic_resumable`, `critic_fallback_*` |

- 상태에는 병합합니다. 이번에 넘기지 않은 필드는 지우지 않으므로, 앞 회차의 대체 메타나 `resumable`이 남습니다. 새 run이어도 지우지 않습니다(6.3).
- 영수증에는 `<role>_state`로 이번에 넘어온 것만 붙습니다(예: `"architect_state": {"architect_id": "ses_architect"}`).
- 적용 시점은 lane verdict와 같습니다: 새 기록과 같은 run의 원장 복구. 원장 중복에서는 적용하지 않습니다.

기록한 ID가 재개 가능함을 뜻하지는 않습니다. 재개 경로와 대체 이유를 고르는 규칙은 [roles-and-consensus.md](roles-and-consensus.md)에 있습니다.

## 10. final 승인 판정과 `auto_handoff`

### 10.1 판정: `resolveRalplanAutoHandoffTarget`

final의 새 기록은 파일을 쓰기 전에(12단계) `resolveRalplanAutoHandoffTarget(settings.autoHandoff, settings.source.autoHandoff, {planningStuck})`(`ledger.ts:769-788`)로 판정합니다. `planningStuck`은 그때 원장의 `readRalplanPlanningStuck`입니다.

| 설정 | 막힘 | `configuredTarget` | `effectiveTarget` | `degradationReason` |
|---|---|---|---|---|
| `off` | 아님 | `off` | `off` | `null` |
| `ultragoal` | 아님 | `ultragoal` | `ultragoal` | `null` |
| 무엇이든 | 막힘 | 설정값 | `off` | `"planning_stuck"` |

`source`는 `ralplan.autoHandoff`의 출처(파일 경로 또는 `default`)입니다. gjc의 `autoresearch` 대상은 없습니다(편차 6).

### 10.2 막힘 판정: `readRalplanPlanningStuck`

`readRalplanPlanningStuck`(`ledger.ts:870-884`)은 실패 쪽으로 판정합니다(3.3 표).

- 원장 텍스트가 없으면 `indexPresent` 그대로(없으면 아님, 읽기 실패면 막힘)
- 줄이 있는데 하나도 행이 아니면 막힘
- 줄마다: JSON이 아니면 막힘, `planning_stuck === true`면 막힘

그래서 원장에 망가진 줄이 하나만 있어도 final은 `planning_stuck`으로 낮춰집니다. 이때 막힘 행도 상태의 `planning_stuck`도 생기지 않습니다(실행해 확인: `autoHandoff: "ultragoal"`에서 `not json` 줄을 붙인 뒤의 final이 `{"configuredTarget":"ultragoal","effectiveTarget":"off","degradationReason":"planning_stuck",…}`, 상태의 `planning_stuck`은 없음).

### 10.3 기록하는 곳

새 final 하나가 같은 판정을 세 곳에 씁니다.

1. 원장의 final 행 `auto_handoff` (14단계)
2. 상태의 `auto_handoff` (17단계, `persistFinalAdmissionTx`). 상태의 `run_id`가 이번 run일 때만. 새 run으로 바뀌면 지워집니다.
3. 영수증의 `auto_handoff`

### 10.4 중복과 복구의 `auto_handoff`

원장 중복과 원장 복구는 판정을 다시 하지 않습니다. 영수증의 값은 `buildDeduplicatedReceipt`(`ledger.ts:1128-1171`)가 이렇게 만듭니다.

```
applyRalplanPlanningStuckOverride(existing.autoHandoff ?? unavailableRalplanFinalAdmission(), <지금 원장의 막힘 판정>)
```

- `existing.autoHandoff`: 원장 중복이면 그 행의 `auto_handoff`를 `parseRalplanFinalAdmission`(`:790-817`)으로 읽은 값입니다. 두 대상이 `off`/`ultragoal` 중 하나, `degradationReason`이 문자열이나 `null`, `source`가 문자열이어야 하고, 아니면 `undefined`입니다.
- `unavailableRalplanFinalAdmission()`(`:820-827`): `{configuredTarget: "off", effectiveTarget: "off", degradationReason: "admission_unavailable", source: "ledger"}`. 행에 판정이 없거나 모양이 틀린 경우, 그리고 **원장 복구가 붙이는 final 행은 늘** 이 값입니다(`store.ts:719`).
- `applyRalplanPlanningStuckOverride`(`:829-836`): 지금 막혔으면 `effectiveTarget: "off"`, `degradationReason: "planning_stuck"`으로 바꾸고 `configuredTarget`, `source`는 둡니다.

그래서 처음 `ultragoal`로 판정된 final이라도, 그 행이 사라진 뒤 같은 내용으로 복구하면 영수증과 새 행은 `off`/`admission_unavailable`입니다. 상태의 `auto_handoff`는 복구 경로가 쓰지 않으므로 처음 값(`ultragoal`) 그대로 남아 원장과 달라집니다(실행해 확인). 처음 판정 뒤 run이 막히면, 같은 final의 중복 영수증은 `planning_stuck`으로 낮아집니다.

### 10.5 `readRalplanFinalAdmission`

`readRalplanFinalAdmission`(`ledger.ts:842-864`)은 원장에서 `path`와 `sha256`이 있는 마지막 final 행의 판정을 읽습니다(모양이 틀리면 `admission_unavailable`, JSON이 아닌 줄은 건너뜀). open-gajae에서 이 함수를 부르는 곳은 활성 행의 `handoff` 칩(`hud.ts:156`)뿐이고, gjc도 HUD에서만 부릅니다(`ralplan-runtime.ts:1954`, 확인).

### 10.6 왜 원장에 두나

SKILL은 final 영수증의 `auto_handoff.effectiveTarget`을 "ledger-backed runtime-owned"이고 "authoritative across state loss and run switching"이라고 적습니다(Flags 절, step 7·8). 판정은 원장의 final 행에 있으므로, 상태 파일이 없어지거나(삭제) 새 run으로 바뀌어 상태의 `auto_handoff`가 지워져도 같은 final을 다시 쓰면 원장에서 같은 판정이 나옵니다(실행해 확인: 상태 파일을 지운 뒤 같은 final의 중복 영수증이 처음의 `ultragoal` 판정). 상태 파일이 망가져 읽을 수 없으면 write는 1단계에서 거부되므로 먼저 `ralplan clear(force: true)`가 필요합니다. gjc도 상태를 먼저 읽어 거부합니다(`enforceRalplanRepositoryBinding`, `:911-916`). gjc 코드의 주석도 "The ledger row below is the durable receipt for deduplicated retries; state is only a current-session projection."이라고 적습니다(`:2193-2195`). 넘길지 말지는 모델이 이 영수증을 읽고 정합니다. `auto_handoff`를 보고 스스로 넘기는 코드는 없습니다([roles-and-consensus.md](roles-and-consensus.md#최종-승인과-admission)의 "최종 승인과 admission").

## 11. disposition 단계

Architect와 Critic의 지적이 같은 계획 대상에 서로 맞지 않는 행동을 요구하면 SKILL step 4는 revision 전에 `disposition` 단계를 쓰라고 합니다(spec D-F6). 코드는 disposition을 쓸 때 그 JSON을 검사합니다. 검사 코드 `src/ralplan-runtime/review-conflicts.ts`는 gjc `gjc-runtime/ralplan-review-conflicts.ts:1-472`를 머리말만 빼고 그대로 옮긴 것입니다(이 문서를 쓰며 `diff`로 확인). 그래서 문구에 gjc의 `CLI --stage_n`이 남아 있습니다.

### 11.1 스키마 `ralplan.review_conflicts.v1`

본문은 JSON 하나입니다. ```` ```json ```` 울타리로 감싸도 됩니다(`parseReviewConflictJson`, `:297-306`). 읽을 때는 camelCase 키를 먼저 보고, 없으면 snake_case 별칭을 봅니다.

**문서**

| 필드 (별칭) | 규칙 |
|---|---|
| `schema` | `"ralplan.review_conflicts.v1"` |
| `plannerStageN` (`planner_stage_n`) | 1 이상 정수. 이번 write의 `stage_n`과 같아야 함 (11.5) |
| `findings` | 배열 (필수) |
| `conflicts` | 배열 (선택). 주면 모든 항목이 findings에서 나온 충돌이어야 함 |
| `dispositions` | 배열 (선택, 없으면 빈 배열) |

**finding**

| 필드 (별칭) | 규칙 |
|---|---|
| `findingId` (`finding_id`) | 비어 있지 않은 문자열(trim). 문서 안에서 유일 |
| `targetId` (`target_id`) | 비어 있지 않은 문자열 |
| `action` | `add`, `remove`, `change`, `clarify` |
| `severity` | `info`, `watch`, `block` |
| `evidence` | 비어 있지 않은 문자열 |
| `sourceRole` (`source_role`) | `architect`, `critic` |
| `sourceReceipt` (`source_receipt`) | 객체: `stage`(`architect`/`critic`), `stageN`(`stage_n`, 1 이상 정수), `path`, `sha256`(비어 있지 않은 문자열) |
| `proposedOwner` (`proposed_owner`) | 선택. 있으면 비어 있지 않은 문자열 |

**conflict** (코드가 만듦): `conflictId`, `targetId`, `findingIds`(둘), `actions`(둘), `sourceRoles`(둘), `status`(`open`/`dispositioned`)

**disposition**

| 필드 (별칭) | 규칙 |
|---|---|
| `conflictId` (`conflict_id`) | 비어 있지 않은 문자열. 문서 안에서 유일 |
| `choice` | `accept_architect`, `accept_critic`, `synthesize`, `defer_user`, `reject_both` |
| `rationale` | 비어 있지 않은 문자열 |
| `decisionOwner` (`decision_owner`) | 비어 있지 않은 문자열 |
| `affectedSections` (`affected_sections`) | 비어 있지 않은 문자열 배열, 1개 이상 |
| `dispositionedAt` (`dispositioned_at`) | 선택. 있으면 비어 있지 않은 문자열 |

문자열 값은 trim해서 저장합니다. 위에 없는 키는 저장하지 않습니다.

### 11.2 검사 순서: `parseReviewConflictDocument`

`writeStageTx` 5단계의 `normalizeDispositionArtifact`(`ledger.ts:398-415`)가 원장 텍스트로 출처 표(`buildIndexedReviewArtifacts`, `:364-392`)를 만들고 `parseReviewConflictDocument`(`review-conflicts.ts:390-475`)를 부릅니다. 어디서든 예외가 나면 `invalid ralplan disposition artifact: <사유>`로 거부합니다. 순서와 사유 문구:

1. JSON 읽기: `disposition artifact must be JSON: <파서 오류>`
2. 객체 아님: `disposition document must be a JSON object`
3. `schema`: `schema must be a non-empty string`, `schema must be ralplan.review_conflicts.v1`
4. `plannerStageN`: `plannerStageN must be an integer >= 1`
5. `findings`: `findings must be an array`, 그다음 항목마다 필드 검사. 문구는 `findings[<i>] must be an object`, `findings[<i>].<필드> must be a non-empty string`, `findings[<i>].action must be one of: add, remove, change, clarify`, `findings[<i>].severity must be one of: info, watch, block`, `findings[<i>].sourceRole must be one of: architect, critic`, `findings[<i>].sourceReceipt must be an object`, `findings[<i>].sourceReceipt.stage must be architect or critic`, `findings[<i>].sourceReceipt.stageN must be an integer >= 1` 꼴
6. ID 유일: `findingId values must be unique`
7. 구조 정렬(원장 없이도): `findings[<i>].sourceReceipt.stage=<stage> must equal sourceRole=<role>`, `findings[<i>].sourceReceipt.stageN=<n> must equal plannerStageN=<n>`
8. `dispositions` 항목마다 필드 검사(`dispositions[<i>] must be an object`, `dispositions[<i>].affectedSections must be a non-empty string array`, `dispositions[<i>].choice must be one of: accept_architect, accept_critic, synthesize, defer_user, reject_both` 등), 그다음 `disposition conflictId values must be unique`
9. 충돌 도출(11.3). `conflicts`를 줬으면 항목마다 `conflicts[<i>] must be an object`, `conflicts[<i>].conflictId must be a non-empty string`, 도출되지 않은 ID면 `conflicts[<i>] <id> is not derived from findings`. 준 목록에서 빠진 도출 충돌은 뒤에 붙입니다. 준 항목의 다른 필드는 버리고 도출한 값을 씁니다.
10. 합류 게이트(11.4). 통과하지 못하면 게이트의 `message`를 그대로 사유로 씁니다.
11. 출처 검사(11.5)

### 11.3 충돌 도출: `detectReviewConflicts`

`detectReviewConflicts`(`:221-250`)는 `targetId`가 같은 finding 쌍마다 봅니다.

- 같은 역할끼리는 충돌이 아닙니다. architect와 critic 사이만 봅니다.
- 행동 쌍이 `INCOMPATIBLE_ACTION_PAIRS`(`:89-94`)에 있어야 합니다.

| 한쪽 | 다른 쪽 | 충돌 |
|---|---|---|
| `add` | `remove` | 예 |
| `remove` | `change` | 예 |
| `add` | `change` | 아니오 |
| `clarify` | 무엇이든 | 아니오 |
| 같은 행동 | 같은 행동 | 아니오 |

충돌 ID는 `conflict:<targetId>:<작은 findingId>:<큰 findingId>`(문자열 비교)이고, `findingIds`, `actions`, `sourceRoles`도 그 순서입니다. 목록은 `conflictId` 순으로 정렬합니다.

### 11.4 합류 게이트: `evaluateReviewJoinGate`

`applyDispositions`(`:253-261`)가 disposition이 있는 충돌을 `dispositioned`, 나머지를 `open`으로 둡니다. `evaluateReviewJoinGate`(`:268-294`)는 open 충돌에 disposition이 없거나(빠짐), 도출되지 않은 충돌을 가리키는 disposition이 있으면(고아) 통과시키지 않습니다. 문구:

| 경우 | `message` |
|---|---|
| 충돌 없음, 통과 | `No typed review conflicts; join is clean.` |
| 충돌 모두 처리, 통과 | `All <n> typed review conflict(s) are dispositioned.` |
| 빠짐 (우선) | `Join blocked: <n> open conflict(s) lack disposition: <id, 쉼표+공백>.` |
| 고아 | `Join blocked: disposition(s) reference unknown conflict id(s): <id, 쉼표+공백>.` |

통과 문구는 결과에 나오지 않습니다. 기록에 성공하면 보통 영수증이 돌아옵니다.

### 11.5 출처 검사: `assertDispositionProvenance`

`assertDispositionProvenance`(`:339-380`)는 원장과 대조합니다. 출처 표는 원장에서 `stage`, 정수 `stage_n`, `path`, `sha256`이 모두 있는 행을 `(stage, stage_n)`마다 마지막 것으로 모은 것입니다. 원장이 없으면 표가 비어 있습니다.

1. `plannerStageN`이 write의 `stage_n`과 다름: `disposition provenance: plannerStageN=<n> does not match CLI --stage_n=<stage_n>`
2. finding마다:
   - `findings[<i>].sourceReceipt.stage=<stage> must equal sourceRole=<role>`
   - `findings[<i>].sourceReceipt.stageN=<n> must equal plannerStageN=<n> (same-pass join)`
   - 원장에 그 `(stage, stageN)` 행이 없음: `findings[<i>].sourceReceipt: no persisted <stage> stage <n> artifact in run index`
   - `path`가 다름: `findings[<i>].sourceReceipt.path does not match indexed <stage> stage <n> path`
   - `sha256`이 다름: `findings[<i>].sourceReceipt.sha256 does not match indexed <stage> stage <n> sha256`

2의 앞 두 검사는 11.2의 7단계가 이미 했으므로 여기서는 다시 걸리지 않습니다. 결과적으로 finding의 출처는 **같은 `stage_n`**의 architect·critic 기록이어야 합니다. pass N의 disposition은 `stage_n` N으로 쓰고, 그 리뷰도 `stage_n` N으로 기록되어 있어야 합니다. 경로와 해시는 영수증의 `path`, `sha256`을 그대로 옮기면 맞습니다.

### 11.6 저장되는 것

통과하면 `serializeReviewConflictDocument`(`:478-480`)가 `JSON.stringify(doc, null, 2)`에 `\n`을 붙인 문자열을 만들고, 이것이 단계 본문입니다. 저장되는 문서는 `schema`, `plannerStageN`, 정규화한 `findings`(입력 순서), 도출한 `conflicts`(상태 포함), 정규화한 `dispositions`입니다. 별칭 키는 camelCase로, 울타리는 벗겨집니다(13.5). 해시는 이 재직렬화 결과로 계산하므로 같은 내용을 다른 서식이나 별칭으로 다시 쓰면 중복 영수증이 됩니다. finding이나 disposition의 순서가 달라지면, 또는 `conflicts`를 직접 주면서 그 순서가 달라지면 다른 내용이 되어 덮어쓰기 거부입니다(`conflicts`를 주지 않으면 `conflictId` 순입니다).

disposition 단계는 반복 상한과 lane 예산에 걸리지 않고, 역할 메타와 lane verdict를 받지 않습니다(2.1).

### 11.7 코드가 하지 않는 것

- revision을 쓰기 전에 disposition이 있는지 보지 않습니다. 충돌이 있어도 `revision`, `post-interview`, `final`은 기록됩니다.
- architect·critic의 Markdown 본문에서 finding을 뽑지 않습니다. finding은 모델이 JSON으로 적은 것뿐이고, 본문 내용과 맞는지는 보지 않습니다.
- `choice`에 따라 계획을 바꾸지 않습니다. `defer_user`도 질문을 띄우지 않습니다.

## 12. 영수증

### 12.1 새 기록: `buildWriteReceipt`

`buildWriteReceipt`(`ledger.ts:1076-1122`, gjc `handleArtifactWrite` 끝 `:2227-2254`)

| 필드 | 값 | 언제 |
|---|---|---|
| `session_id` | 소유 세션(계보 루트) ID | 늘 |
| `run_id` | 이번 run | 늘 |
| `path` | 단계 파일 절대 경로 | 늘 |
| `stage`, `stage_n` | 이번 단계 | 늘 |
| `sha256` | 정규화 본문의 해시 | 늘 |
| `repository_binding` | 6.1의 바인딩, 없으면 `null` | 늘 |
| `created_at` | 원장 행의 `created_at` | 늘 |
| `pending_approval_path` | 사본 경로 | final |
| `<role>_state` | 이번에 넘어온 역할 메타 (9.3) | 역할 메타가 있을 때 |
| `review_budget_warning` | `{lane, passes, max}` | 마지막 칸을 썼고 한도 > 1 |
| `lane_verdict` | `{lane, verdict}` | verdict가 있을 때 |
| `auto_handoff` | 승인 판정 | final |

첫 줄(`text`):

```
Persisted ralplan <stage> stage <n> at <path>.
```

`review_budget_warning`이 있으면 그 앞에 한 줄이 더 붙습니다.

```
Warning: ralplan <lane> review budget final slot used (<passes>/<max>).
```

### 12.2 중복: `buildDeduplicatedReceipt`

`buildDeduplicatedReceipt`(`ledger.ts:1128-1171`, gjc `buildDeduplicatedResult` `:2270-2311`)

| 필드 | 값 |
|---|---|
| `session_id`, `run_id`, `stage`, `stage_n`, `sha256`, `repository_binding` | 새 기록과 같음 |
| `path` | 기존 행(또는 복구한 행)의 경로 |
| `created_at` | 기존 행의 `created_at`. 복구면 복구 시각. 행에 값이 없으면 `""` |
| `deduplicated` | `true` |
| `lane_verdict`, `<role>_state` | 원장 복구에서 같은 run에 적용한 것만 |
| `pending_approval_path`, `auto_handoff` | final (10.4) |

`review_budget_warning`은 없습니다. 첫 줄:

```
ralplan <stage> stage <n> already persisted at <path> (identical content; no changes written).
```

### 12.3 영수증이 아닌 것

- `RECEIPT_FRESH_MS`(`store.ts:136`, 30분)는 `state` op가 활성 행에 붙이는 `receipt`의 `fresh_until`에만 씁니다(`stateWriteReceipt`). `write`의 영수증에는 신선도 필드가 없습니다.
- gjc 상태 봉투의 `receipt`, checksum, `state_revision`은 없습니다(편차 17).
- SKILL의 RECEIPT-ONLY 규칙(역할은 `session_id`, `run_id`, `path`, `sha256`과 판정만 돌려줌)은 역할 프롬프트의 지시입니다. 도구는 영수증을 돌려줄 뿐 역할의 답을 검사하지 않습니다.

## 13. 실제 실행 예

스크립트는 `tests/ralplan-tool.test.ts`의 `fixture`처럼 임시 폴더에 `StateStore`를 만들고 `createTools(…).find((t) => t.name === "ralplan")`의 `execute`를 부릅니다. 계보는 `ses_root`가 루트이고 `ses_planner`, `ses_architect`, `ses_critic`이 역할의 자식 세션입니다. 역할의 write는 그 역할 agent와 자식 세션으로, 나머지는 `open-gajae`와 `ses_root`로 불렀습니다. 프로젝트 폴더는 git 저장소가 아니므로 바인딩의 `commonDir`이 `null`입니다.

### 13.1 실행 A: 두 회차 (기본 설정)

부른 순서: `start(task: "demo task")` → planner 역할 `planner 1`(`resumable: true`) → primary `intent 1` → architect 역할 `architect 1`(`lane_verdict: "block"`) → critic 역할 `critic 1`(`ITERATE`) → planner 역할 `revision 2` → architect `architect 2`(`CLEAR`) → critic `critic 2`(`OKAY`) → primary `post-interview 2` → primary `final 2`.

`architect 1`의 결과(바인딩 줄임):

```
Persisted ralplan architect stage 1 at <session>/plans/ralplan/ses_root/stage-01-architect.md.
{
  "session_id": "ses_root",
  "run_id": "ses_root",
  "path": "<session>/plans/ralplan/ses_root/stage-01-architect.md",
  "stage": "architect",
  "stage_n": 1,
  "sha256": "ad9e907c01bcb369c1237d57639358e33025e90c556d7b6846552ae0331a4fc7",
  "repository_binding": {…},
  "created_at": "2026-10-03T15:03:10.194Z",
  "architect_state": {
    "architect_id": "ses_architect"
  },
  "lane_verdict": {
    "lane": "architect",
    "verdict": "BLOCK"
  }
}
```

`final 2`의 결과에는 `pending_approval_path`와 `auto_handoff`(`off`/`off`/`null`/`default`)가 더 붙습니다(13.2의 중복 영수증과 같은 값).

run 폴더(이름순으로 정렬해 적음):

```
index.jsonl
pending-approval.md
stage-01-architect.md
stage-01-critic.md
stage-01-intent.md
stage-01-planner.md
stage-02-architect.md
stage-02-critic.md
stage-02-final.md
stage-02-post-interview.md
stage-02-revision.md
```

`index.jsonl` (경로와 해시만 줄임):

```
{"stage":"planner","stage_n":1,"path":"<session>/plans/ralplan/ses_root/stage-01-planner.md","created_at":"2026-10-03T15:03:10.187Z","sha256":"a6d46051…"}
{"stage":"intent","stage_n":1,"path":"<session>/plans/ralplan/ses_root/stage-01-intent.md","created_at":"2026-10-03T15:03:10.191Z","sha256":"8001cd7f…"}
{"stage":"architect","stage_n":1,"path":"<session>/plans/ralplan/ses_root/stage-01-architect.md","created_at":"2026-10-03T15:03:10.194Z","sha256":"ad9e907c…"}
{"stage":"critic","stage_n":1,"path":"<session>/plans/ralplan/ses_root/stage-01-critic.md","created_at":"2026-10-03T15:03:10.197Z","sha256":"285330d9…"}
{"stage":"revision","stage_n":2,"path":"<session>/plans/ralplan/ses_root/stage-02-revision.md","created_at":"2026-10-03T15:03:10.200Z","sha256":"1bc6a9a8…"}
{"stage":"architect","stage_n":2,"path":"<session>/plans/ralplan/ses_root/stage-02-architect.md","created_at":"2026-10-03T15:03:10.203Z","sha256":"285e2466…"}
{"stage":"critic","stage_n":2,"path":"<session>/plans/ralplan/ses_root/stage-02-critic.md","created_at":"2026-10-03T15:03:10.206Z","sha256":"caa2240b…"}
{"stage":"post-interview","stage_n":2,"path":"<session>/plans/ralplan/ses_root/stage-02-post-interview.md","created_at":"2026-10-03T15:03:10.209Z","sha256":"c5bf4374…"}
{"stage":"final","stage_n":2,"path":"<session>/plans/ralplan/ses_root/stage-02-final.md","created_at":"2026-10-03T15:03:10.212Z","sha256":"dc1eee15…","auto_handoff":{"configuredTarget":"off","effectiveTarget":"off","degradationReason":null,"source":"default"}}
```

`final 2` 뒤의 상태(`repository_binding`, `_meta` 줄임):

```json
{
  "active": true,
  "current_phase": "final",
  "skill": "ralplan",
  "version": 2,
  "mode": "short",
  "interactive": false,
  "task": "demo task",
  "run_id": "ses_root",
  "updated_at": "2026-10-03T15:03:10.212Z",
  "repository_binding": {…},
  "session_id": "ses_root",
  "planner_subagent_id": "ses_planner",
  "planner_resumable": true,
  "architect_id": "ses_architect",
  "last_review_verdict": "OKAY",
  "last_review_verdict_lane": "critic",
  "last_review_verdict_stage_n": 2,
  "critic_id": "ses_critic",
  "auto_handoff": {"configuredTarget": "off", "effectiveTarget": "off", "degradationReason": null, "source": "default"},
  "_meta": {…}
}
```

`planner_resumable: true`는 `planner 1`에서 넘긴 것이 `revision 2`(넘기지 않음) 뒤에도 남은 것입니다(9.3). 활성 행은 `phase: "final"`, 칩은 `pending=approval`, `stage=final`, `iter=2`, `stages=revision · architect · critic · post-interview · final`, `verdict=OKAY`, `handoff=off→off`입니다. 감사 로그의 `invalid_transition_detected` 행은 둘입니다.

```
revision -> architect
post-interview -> final
```

### 13.2 실행 A 이어서: 중복, 거부, 복구, 잠긴 phase, 새 run

같은 `final 2`를 끝 개행만 붙여 다시 쓰면 정규화 뒤 같은 내용이므로 중복입니다.

```
ralplan final stage 2 already persisted at <session>/plans/ralplan/ses_root/stage-02-final.md (identical content; no changes written).
{
  …
  "created_at": "2026-10-03T15:03:10.212Z",
  "deduplicated": true,
  "pending_approval_path": "<session>/plans/ralplan/ses_root/pending-approval.md",
  "auto_handoff": {"configuredTarget": "off", "effectiveTarget": "off", "degradationReason": null, "source": "default"}
}
```

다른 내용이면 4.4의 거부입니다. `architect 2`를 같은 본문, `lane_verdict: "WATCH"`로 다시 쓰면 영수증에 `lane_verdict`가 없고 상태의 `last_review_verdict`는 `"OKAY"` 그대로입니다.

원장에서 `intent` 행을 지우고 `intent 1`을 같은 내용으로 다시 쓰면 원장 복구입니다. 결과 첫 줄은 중복과 같고, 감사 행은 `ledger:append` 하나, 원장 끝에 새 시각의 행이 붙습니다.

```
{"stage":"intent","stage_n":1,"path":"<session>/plans/ralplan/ses_root/stage-01-intent.md","created_at":"2026-10-03T15:03:10.215Z","sha256":"8001cd7f…"}
```

Stop here(`ralplan state(patch={"active": false})`) 뒤 planner 역할이 `revision 3`을 쓰면 6.4의 표대로입니다. 상태 파일은 바뀌었고(역할 ID 병합) 그 `active`, `current_phase`, `planner_subagent_id`와 활성 행의 `phase`, `active`를 뽑으면 이렇습니다.

```
{"active":false,"current_phase":"final","planner_subagent_id":"ses_planner"}
{"phase":"revision","active":true}
```

이때 `ralplan doctor`는 `stale_active_state` 셋을 보고합니다: 행 파일의 `active entry for ralplan does not match a live active mode-state`, `active entry for ralplan phase revision differs from canonical mode-state phase final`, 스냅숏의 `active snapshot for ralplan phase revision differs from canonical mode-state phase final`(모두 `fixCommand: "ralplan clear"`).

이어서 `final 3`을 쓰고 `final 2`를 원래 내용으로 다시 쓰면 5장의 거부입니다.

```
Error: refusing to deduplicate ralplan final stage 2: pending approval content mismatch at <session>/plans/ralplan/ses_root/pending-approval.md (stage sha256=dc1eee1540f3d5b561b108ca829d7dfa7b21a0bb8b232bcb2759681ff895d267, pending sha256=5085ea10af5a79faf10184063cae7f1f41a3a4e95e8a5923e182f4f9c34be07d).
```

마지막으로 planner 역할이 `run_id: "run-2"`로 `planner 1`을 쓰면 `plans/ralplan/run-2/stage-01-planner.md`가 생기고, 상태의 키는 `active`(true), `current_phase`(`planner`), `skill`, `version`, `mode`, `interactive`, `task`, `run_id`(`run-2`), `updated_at`, `repository_binding`, `session_id`, `planner_subagent_id`, `planner_resumable`, `architect_id`, `critic_id`, `_meta`입니다. `last_review_verdict*`와 `auto_handoff`가 사라지고 역할 ID와 `planner_resumable`은 남았습니다. `active`는 Stop here의 `false`에서 `true`로 돌아왔습니다.

### 13.3 실행 B: 반복 상한 1, `autoHandoff: "ultragoal"`

설정은 `maxIterations: 1`, `autoHandoff: "ultragoal"`(두 키의 `source`는 가짜 경로 `/cfg/.open-gajae/open-gajae.jsonc`)입니다. `start(run_id: "cap-demo")` → `planner 1` → `architect 1`(BLOCK) → `critic 1`(ITERATE) → `revision 2`:

```
PLANNING-STUCK: ralplan consensus iteration cap exceeded: opening revision would start iteration 2 (max 1) (run_id=cap-demo, stage=revision, stage_n=2, source=/cfg/.open-gajae/open-gajae.jsonc). Stop opening planner/revision passes; escalate the best existing plan via final/pending-approval without auto-implementation.
{
  "ok": false,
  "planning_stuck": true,
  "marker": "PLANNING-STUCK",
  "run_id": "cap-demo",
  "stage": "revision",
  "stage_n": 2,
  "iteration": 1,
  "projected_iteration": 2,
  "max_iterations": 1,
  "max_iterations_source": "/cfg/.open-gajae/open-gajae.jsonc",
  "reason": "ralplan consensus iteration cap exceeded: opening revision would start iteration 2 (max 1)"
}
```

감사 행은 `ledger:append`(막힘 행)와 `state:write`(`planning_stuck`) 둘이고, 상태의 `current_phase`는 `critic` 그대로입니다. 같은 반복에서 `architect 2`를 쓰면 lane 예산으로 막힙니다.

```
PLANNING-STUCK: ralplan review lane budget exceeded: architect pass 2 of max 1 in consensus iteration 1 (run_id=cap-demo, stage=architect, stage_n=2, source=default). Stop re-invoking the architect review lane in this consensus iteration; route a rule-2-justified blocker through a Planner revision opener (fresh lane budget) while opener budget remains, or escalate the best existing plan via post-interview/adr/final without auto-implementation.
{
  "ok": false,
  "planning_stuck": true,
  "marker": "PLANNING-STUCK",
  "run_id": "cap-demo",
  "stage": "architect",
  "stage_n": 2,
  "lane": "architect",
  "passes": 1,
  "projected_passes": 2,
  "max_review_passes_per_lane": 1,
  "max_review_passes_source": "default",
  "reason": "ralplan review lane budget exceeded: architect pass 2 of max 1 in consensus iteration 1"
}
```

상태의 `planning_stuck.reason`은 이 lane 사유로 바뀌지만 원장에는 막힘 행이 하나(첫 사유)뿐입니다. `post-interview 1`, `adr 1`, `final 1`은 기록됩니다. `final 1`의 `auto_handoff`:

```json
{
  "configuredTarget": "ultragoal",
  "effectiveTarget": "off",
  "degradationReason": "planning_stuck",
  "source": "/cfg/.open-gajae/open-gajae.jsonc"
}
```

같은 `final 1`의 중복 영수증도 같은 값입니다. 원장(경로·해시 줄임):

```
{"stage":"planner","stage_n":1,"path":"…/cap-demo/stage-01-planner.md","created_at":"2026-10-03T15:03:10.245Z","sha256":"3fecf715…"}
{"stage":"architect","stage_n":1,"path":"…/cap-demo/stage-01-architect.md","created_at":"2026-10-03T15:03:10.248Z","sha256":"1f1c6bbf…"}
{"stage":"critic","stage_n":1,"path":"…/cap-demo/stage-01-critic.md","created_at":"2026-10-03T15:03:10.251Z","sha256":"21b1e062…"}
{"event":"planning_stuck","planning_stuck":true,"marker":"PLANNING-STUCK","reason":"ralplan consensus iteration cap exceeded: opening revision would start iteration 2 (max 1)","created_at":"2026-10-03T15:03:10.254Z"}
{"stage":"post-interview","stage_n":1,"path":"…/cap-demo/stage-01-post-interview.md","created_at":"2026-10-03T15:03:10.256Z","sha256":"da72aec1…"}
{"stage":"adr","stage_n":1,"path":"…/cap-demo/stage-01-adr.md","created_at":"2026-10-03T15:03:10.259Z","sha256":"b7d62212…"}
{"stage":"final","stage_n":1,"path":"…/cap-demo/stage-01-final.md","created_at":"2026-10-03T15:03:10.261Z","sha256":"ce1e0498…","auto_handoff":{"configuredTarget":"ultragoal","effectiveTarget":"off","degradationReason":"planning_stuck","source":"/cfg/.open-gajae/open-gajae.jsonc"}}
```

막힌 쓰기는 파일을 만들지 않으므로 폴더에는 `stage-02-revision.md`, `stage-02-architect.md`가 없습니다. `index.jsonl`을 지운 뒤 `planner 3`을 쓰면 디스크 opener가 아래를 받칩니다.

```
PLANNING-STUCK: ralplan consensus iteration cap exceeded: opening planner would start iteration 2 (max 1) (ledger under-count: index=0, on-disk openers=1) (run_id=cap-demo, stage=planner, stage_n=3, source=/cfg/.open-gajae/open-gajae.jsonc). Stop opening planner/revision passes; escalate the best existing plan via final/pending-approval without auto-implementation.
```

### 13.4 실행 C: lane 예산 2

`maxReviewPassesPerLane: 2`에서 `planner 1` → `critic 1` → `critic 2`:

```
Warning: ralplan critic review budget final slot used (2/2).
Persisted ralplan critic stage 2 at <session>/plans/ralplan/ses_root/stage-02-critic.md.
{
  …
  "critic_state": {
    "critic_id": "ses_critic"
  },
  "review_budget_warning": {
    "lane": "critic",
    "passes": 2,
    "max": 2
  }
}
```

`critic 3`은 `PLANNING-STUCK: ralplan review lane budget exceeded: critic pass 3 of max 2 in consensus iteration 1 (…)`입니다.

### 13.5 실행 D: disposition

`planner 1`, `architect 1`, `critic 1`을 쓰고, 두 리뷰 영수증의 `path`, `sha256`을 출처로 하는 finding 셋을 만들었습니다: `arch-1`(architect, `contract.cache`, `remove`), `crit-1`(critic, `contract.cache`, `change`, snake_case 별칭 `target_id`, `source_role`, `source_receipt`), `crit-2`(critic, `tests.e2e`, `add`). `arch-1`과 `crit-1`이 충돌입니다.

| 보낸 것 | 결과 |
|---|---|
| disposition 없음 | `Error: invalid ralplan disposition artifact: Join blocked: 1 open conflict(s) lack disposition: conflict:contract.cache:arch-1:crit-1.` |
| 맞는 disposition + 없는 ID `conflict:x:y:z` | `Error: invalid ralplan disposition artifact: Join blocked: disposition(s) reference unknown conflict id(s): conflict:x:y:z.` |
| 맞는 disposition, `stage_n: 2` | `Error: invalid ralplan disposition artifact: disposition provenance: plannerStageN=1 does not match CLI --stage_n=2` |
| `arch-1`만, `sha256`을 0 64개로 | `Error: invalid ralplan disposition artifact: findings[0].sourceReceipt.sha256 does not match indexed architect stage 1 sha256` |

맞는 문서를 ```` ```json ```` 울타리로 감싸고 disposition도 별칭(`conflict_id`, `decision_owner`, `affected_sections`)으로 보내면 `Persisted ralplan disposition stage 1 at <session>/plans/ralplan/ses_root/stage-01-disposition.md.`이고, 저장된 파일은 이렇습니다(경로·해시 줄임, `crit-2`는 생략).

```json
{
  "schema": "ralplan.review_conflicts.v1",
  "plannerStageN": 1,
  "findings": [
    {
      "findingId": "arch-1",
      "targetId": "contract.cache",
      "action": "remove",
      "severity": "block",
      "evidence": "duplicate cache layer",
      "sourceRole": "architect",
      "sourceReceipt": {
        "stage": "architect",
        "stageN": 1,
        "path": "<session>/plans/ralplan/ses_root/stage-01-architect.md",
        "sha256": "1f1c6bbf…"
      }
    },
    {
      "findingId": "crit-1",
      "targetId": "contract.cache",
      "action": "change",
      "severity": "watch",
      "evidence": "cache needs TTL",
      "sourceRole": "critic",
      "sourceReceipt": {
        "stage": "critic",
        "stageN": 1,
        "path": "<session>/plans/ralplan/ses_root/stage-01-critic.md",
        "sha256": "21b1e062…"
      }
    },
    …
  ],
  "conflicts": [
    {
      "conflictId": "conflict:contract.cache:arch-1:crit-1",
      "targetId": "contract.cache",
      "findingIds": ["arch-1", "crit-1"],
      "actions": ["remove", "change"],
      "sourceRoles": ["architect", "critic"],
      "status": "dispositioned"
    }
  ],
  "dispositions": [
    {
      "conflictId": "conflict:contract.cache:arch-1:crit-1",
      "choice": "synthesize",
      "rationale": "keep one cache with a TTL",
      "decisionOwner": "ralplan-leader",
      "affectedSections": ["## Cache"]
    }
  ]
}
```

실제 파일은 `JSON.stringify(…, null, 2)`이므로 배열도 한 원소씩 줄을 바꿉니다. 여기서는 짧게 붙여 적었습니다. 같은 울타리 본문을 다시 보내면 중복 영수증입니다.

## 14. 코드가 강제하는 것과 SKILL만 요구하는 것

| 코드가 강제함 | SKILL·프롬프트 문구로만 요구함 (코드가 확인하지 않음) |
|---|---|
| 단계 이름 아홉, `stage_n` 1..999, `(stage, stage_n)`마다 내용 하나(다른 내용은 거부) | 회차마다 `stage_n`을 올리기, 리뷰의 `stage_n`을 그 회차의 planner/revision과 맞추기. disposition만 같은 `stage_n`을 검사합니다(11.5). |
| 단계 파일, 원장 행, final 사본을 도구만 씀 (경로 차단은 [guards-and-continuation.md](guards-and-continuation.md)) | planner → intent → 리뷰 → (disposition) → revision → post-interview → final 순서. 코드는 순서를 거부하지 않고 표에 없는 이동을 감사 행으로만 남깁니다(6.6). |
| opener 상한(원장과 디스크 중 큰 값), 반복마다 lane 예산, 막힘 행과 상태의 `planning_stuck` | 5회 안에 합의가 안 되면 더 열지 않고 최선안을 `pending approval`로 남기기. 코드는 opener만 거부하고 `final`은 받습니다. |
| 막힌 run의 final `auto_handoff`를 `off`/`planning_stuck`으로 | 그 영수증을 종료로 보고 넘기지도 묻지도 않기(step 8). `ralplan handoff`와 같은 execution의 `skill ultragoal` 로드는 phase와 `active`만 보고 막힘은 보지 않으므로, 막힌 run의 active `final`에서도 넘어갑니다([entry-and-handoff.md](entry-and-handoff.md)). |
| `autoHandoff` 설정에서 판정을 만들어 원장·상태·영수증에 씀 | `effectiveTarget: "ultragoal"`이면 묻지 않고 넘기기, `off`면 승인 `question`. 판정을 보고 스스로 넘기는 코드는 없습니다. |
| `lane_verdict` 토큰 모양과 상태 기록 | architect·critic이 실제 판정과 같은 토큰을 넘기기, Critic `OKAY` + Architect `CLEAR`/`APPROVE`일 때만 합의로 보기(step 4, 5f). 코드는 verdict로 아무것도 막지 않습니다. |
| 역할 세션 ID 자동 기록(자기 단계일 때), 대체 메타 묶음과 이유 여섯 개 | 대체가 실제로 일어났을 때만 대체 메타를 넘기기, `resumable`을 증명될 때만 `true`로. 역할이 다른 역할의 단계를 쓰는 것은 거부하지 않습니다(9.1). |
| disposition 스키마, 충돌 도출, 모든 충돌의 처리, 같은 회차 원장 대조 | 충돌이 있을 때 revision 전에 disposition을 쓰기, finding을 리뷰 본문과 맞게 적기(11.7) |
| 같은 내용 재기록의 중복 처리와 원장 복구 | — |
| 역할은 `content`만 (`path` 거부) | RECEIPT-ONLY: 역할이 본문 대신 영수증 필드만 돌려주기 |
| 잠긴 phase에서 `active`·`current_phase` 유지 | Stop here 뒤에는 다시 쓰지 않기. 다시 쓰면 활성 행이 살아나고 doctor가 낡은 행을 보고합니다(6.4). |
