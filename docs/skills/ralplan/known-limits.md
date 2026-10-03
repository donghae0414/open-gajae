# 알려진 한계

이 문서는 ralplan에 남아 있는 한계와, 처음 보면 이상해 보이지만 기록된 동작을 모읍니다. 각 항목은 무엇이 일어나는지, 왜 그런지, 사용자나 모델이 무엇을 하면 되는지를 적습니다. 기준 코드는 [README.md](README.md) 머리에 있습니다.

- **출처**: 루트 `README.md`의 Ralplan 절 알려진 동작(176–193행), "Deviations from GJC (ralplan)" 표의 Impact 열과 "Accepted behavior differences"(394–454행), "Deviations from OMC" 표의 R-OD20·R-OD21 행(390행), "Mandatory follow-up development" 4–6(581–583행). 계획 `.omc/plans/ralplan-gjc-stage-trail.md`의 §5 위험과 §8.1 결정. ultragoal·deep-interview known-limits의 ralplan 관련 항목. 2026-09-28~29 수동 실행 기록. 이 폴더의 문서를 쓰며 코드에서 찾은 것(RK36–RK41과 여러 항목의 보충).
- **줄 번호**: 코드 위치는 커밋 `5b92a60` 기준입니다. `.omc/` 아래의 계획·spec·진행 기록은 `.gitignore`에 들어 있어 저장소에 없는 로컬 기록입니다. 루트 `README.md`와 `README.ko.md`의 줄 번호는 이 문서와 함께 들어가는 현재 파일 기준이고, 이 문서가 인용한 줄은 두 파일에서 같은 번호입니다.
- **번호**: RK 번호는 이 문서에서 새로 붙였습니다. ultragoal의 U 번호와 deep-interview의 K 번호는 다시 쓰지 않고, 그 문서의 번호 그대로 가리킵니다([ultragoal known-limits](../ultragoal/known-limits.md), [deep-interview known-limits](../deep-interview/known-limits.md)).
- **gjc와 같음**: 표시한 항목은 gjc(`gajae-code/`, 고정 커밋 `5c52314`)에서도 같은 결과가 납니다. 표시한 곳마다 이 문서를 쓰며 gjc 소스를 읽어 확인했고, 그 위치를 함께 적습니다. README에서 옮기기만 한 gjc 위치는 그렇다고 따로 적습니다. gjc 경로는 `gajae-code/packages/coding-agent/src/` 기준입니다.
- **실행 확인**: 이 문서를 쓰며 bun으로 임시 `StateStore` 위에 `ralplan` 도구를 만들어(`tests/ralplan-tool.test.ts`와 같은 방식) 돌려 본 항목입니다. 결과의 세션 폴더 경로는 `<session>`으로 바꿨고, 시각과 sha256은 실행마다 다릅니다.
- **테스트**: 근거의 테스트는 `파일:줄`로 적습니다. 그 줄에서 시작하는 `test(...)` 하나를 가리킵니다. RP1–RP5는 `tests/ralplan-tool.test.ts`의 테스트 이름 앞머리입니다.
- **편차 번호**: "ralplan 편차 N"은 루트 README "Deviations from GJC (ralplan)" 표의 N번 행입니다.

자세한 동작은 이웃 문서에 있습니다.

- 도구와 op별 검사 순서: [ops.md](ops.md)
- 단계 쓰기, 예산, PLANNING-STUCK, disposition: [stages-and-ledger.md](stages-and-ledger.md)
- 상태 파일, 활성 행, doctor, 설정: [state-and-files.md](state-and-files.md)
- 진입, 인계, 같은 execution 게이트: [entry-and-handoff.md](entry-and-handoff.md)
- 계획 가드, 항상 차단 경로, continuation, 압축 문맥: [guards-and-continuation.md](guards-and-continuation.md)
- 합의 절차와 역할: [roles-and-consensus.md](roles-and-consensus.md)

## 한눈에 보기

| RK | 한계 | 근거 | 할 일/우회 |
|---|---|---|---|
| RK1 | `skill ralplan` 로드와 키워드·멘션은 상태를 쓰지 않는다. `ralplan start`(또는 첫 `write`) 전에는 계획 가드와 continuation이 없다 | ralplan 편차 36; `executeBefore`(`src/hooks.ts:1004-1097`) | 로드 직후 `ralplan start` (SKILL 지시) |
| RK2 | 활성 run이 있으면 `start`가 거부된다. 승인 질문 중인 활성 `final`도, 새 `run_id`를 줘도 같다. ultragoal로 인계한 뒤에는 ultragoal 거부에 걸린다 | ralplan 편차 39; `start`(`src/ralplan-runtime/tool.ts:189-211`); RP3, RP4; 실행 확인 | 이어 가려면 `write`. 새로 하려면 Stop here·`clear` 뒤 새 `run_id`로 `start`. ultragoal 인계 뒤에는 `ultragoal handoff(to: "ralplan")` 뒤 새 `run_id`로 `write` |
| RK3 | `run_id` 없는 `start`는 옛 run 폴더를 이어 쓴다. 옛 단계 파일, opener 예산, 막힘 행, `pending-approval.md`가 남는다 (gjc와 같음) | `startRunTx`(`store.ts:915-988`); 계획 R-11; 실행 확인 | 새 계획은 `start(run_id: "<새 이름>")` |
| RK4 | `start` 없이 `write`로 생긴 상태에는 `mode`, `interactive`, `task`, `repository_binding`이 없다 (gjc와 같음) | `persistActiveRunIdTx`(`store.ts:513-545`); 수용 차이 "No seeding"; R-O6 | 기록만 |
| RK5 | 키워드는 안내만 하고 `open-gajae`에만 간다. 감지는 OMC 규칙 그대로라 `ralplan 이거 정리해줘`는 조용하고 `랄플랜 이거 정리해줘`는 발화하며, `use 랄플랜 for this`처럼 영어 동사 뒤의 별칭은 발화하지 않는다 (OMC와 같음) | `prompt` 훅(`src/hooks.ts:860-1002`); R-OD20, U26; `tests/ralplan.test.ts:231`; 실행 확인 | `@ralplan` 멘션이나 `skill ralplan` |
| RK6 | ultragoal 실행 중의 `write`가 ralplan을 활성으로 만든다. 그 행은 다음 ultragoal 행 쓰기에 지워져, 행 없는 활성 상태가 남을 수 있다 | `write`(`tool.ts:249`), `syncActiveRowTx`(`src/skill-state/rows.ts:144-162`); R-AE1, R-13, U22 | `ralplan state(patch={"active": false})` 또는 `ralplan clear` |
| RK7 | 잠기지 않은 phase에서 `active: false`로 멈춘 run은 같은 run의 다음 `write`로 다시 활성이 된다 (gjc와 같음) | `persistActiveRunIdTx`(`store.ts:531-541`); 실행 확인 | 역할이 다 끝난 뒤 다시 멈추거나 `clear` |
| RK8 | 잠긴 phase 뒤 `write`는 `active`·phase를 두고 역할 id·판정·`auto_handoff`만 병합하며 활성 행을 다시 쓴다. doctor는 `stale_active_state`와 `ralplan clear`를 안내하는데, 다듬기 행에서는 그 clear가 성공해 run을 `complete`로 끝내고, `clear` 뒤에는 force 없는 clear와 `{"active": false}`만의 패치가 거부된다 (gjc와 같음) | `writeStageTx`(`store.ts:823-867`), `describeStaleClearTx`(`store.ts:1093-1130`); R-OD8, R-OD14, R-25; 실행 확인 | 다듬기 행은 `state(patch={"active": false})`, `clear` 뒤 행은 `clear(force: true)`나 manifest phase를 함께 주는 `state` 패치 |
| RK9 | 전이 표에 없는 `write`는 진행되고 `invalid_transition_detected` 감사 행만 남는다. SKILL 순서가 이 행을 늘 만든다 (gjc와 같음) | `writeStateTx`(`store.ts:193-245`); spec D-T11, R-18, U38 | 기록만 |
| RK10 | `state` op에는 `force`·`replace`가 없고 중첩 `state`는 필드로 저장된다. 표 밖의 phase 변경과 manifest 밖 phase(`complete` 등)는 거부된다 | `patchStateTx`(`store.ts:1001-1079`); ralplan 편차 38, R-OD19; 실행 확인 | `write`, `handoff`, `clear(force: true)` |
| RK11 | 옛 형식(알 수 없는 phase) 상태는 "판독 불가"로 다뤄지지만, `start`는 활성 run으로 거부하고 그 거부가 권하는 `state {"active": false}`도 실패한다 | DR-21; `tool.ts:197-198`, `store.ts:1039-1040`; 실행 확인 | force 없는 `ralplan clear` |
| RK12 | 상태에 receipt·revision이 없어 `status`의 `fresh`는 늘 `false`이고 `fresh_until`·`receipt`는 비어 있다 | `projectStateFields`(`store.ts:1224-1261`); ralplan 편차 17, R-OD6; 실행 확인 | 기록만 |
| RK13 | `ralplan.*` 설정은 플러그인 시작 때 한 번 읽는다 | `src/index.ts:29,62`; ralplan 편차 4, DR-13 | 바꾼 뒤 호스트 재시작 |
| RK14 | PLANNING-STUCK run은 활성으로 남아 계획 가드가 계속 막는다. lane 예산 초과도 그 run의 모든 `final`을 `planning_stuck`으로 만든다. 같은 execution 게이트는 고를 수 없는 승인 단계를 안내하고, 막힌 `final`은 `ralplan handoff`와 게이트를 그대로 지난다 | `shouldContinue`(`src/ralplan.ts:121-139`), `guardPlanning`(`src/hooks.ts:742-782`), `ralplanHandoffTx`(`store.ts:1328-1371`); U14; 실행 확인 | 막힌 `final` 뒤에는 SKILL대로 Stop here |
| RK15 | `stage_n`은 모델이 정한다. 도구는 1..999 범위만 본다. 쓰기마다 번호를 올리면 disposition의 같은 회차 검사를 맞출 수 없다 | `parseStageN`(`ledger.ts:341-351`), `assertDispositionProvenance`(`review-conflicts.ts:339-380`); 계획 §8.1 "stage_n 묶음" | 기록만 (모델 해석) |
| RK16 | 합의 판정, 리뷰 조인, 충돌 때 disposition 먼저, 2회차부터 순차 리뷰, 승인 질문은 SKILL만 요구한다 (gjc와 같음) | `writeStageTx`(`store.ts:635-880`)에 그 검사가 없음; SKILL 4–9단계 | 기록만 |
| RK17 | 역할은 본문을 인라인 `content`로만 넘긴다. primary의 `path`는 OS 임시 파일만 받아, 저장소 파일은 `path`로 넘길 수 없다. macOS에서 `os.tmpdir()`의 실제 경로(`/private/var/folders/…`)로 적은 파일도 거부된다 (gjc와 같음) | `write`(`tool.ts:219-234`), `readTempArtifact`(`temp-paths.ts:94-122`); ralplan 편차 30, R-O4, R-7 | `content`로 넘김 |
| RK18 | 계획 가드는 `write`·`edit`·`patch`만 보고 `shell`은 보지 않는다. 가드가 판단하다 실패하면 막지 않는다. 임시 경로 예외는 RK17과 같은 판정이다 | `ARTIFACT_TOOLS`(`src/artifact-guard.ts:16-20`), `guardPlanning`; ralplan 편차 11 | 프롬프트로만 막음 |
| RK19 | 항상 차단 경로 검사는 대소문자를 구분하고 심볼릭 링크를 풀지 않는다 | `src/artifact-guard.ts:74-85,115-159`; 필수 후속 5, R-OD13, U4 | 필수 후속 5(대소문자 정규화) |
| RK20 | continuation은 `final`·`handoff`를 붙잡지 않고, ralplan이 보이는 주 skill이며 goal이 활성이 아닐 때만 돈다 | `decideRalplan`(`src/hooks.ts:474-533`), `shouldContinue`; ralplan 편차 10, PQ-7 B | 기록만 |
| RK21 | continuation은 agent를 확인하지 않는다 | `continueSession`(`src/hooks.ts:536-597`); R-OD21, U27 | `open-gajae`로 돌아가거나 Esc |
| RK22 | breaker는 30회·45분이고 사용자 프롬프트, Stop here, `clear`, `run_id` 없는 `start`로 되돌아가지 않는다. 안내는 `resume: true`로 들어간다. 다 쓰면 run이 그 phase에서 비활성이 된다. continuation 문구는 끝낼 때 `ralplan clear`를 권한다 | `src/ralplan.ts:25-26,46-56,121-139`, `decideRalplan`; ralplan 편차 26, DR-17 | 이어 가려면 `state(patch={"active": true})` |
| RK23 | Stop here·`clear`·인계 뒤에는 `ralplan handoff`가 거부되고, 나중에 로드한 ultragoal에는 `handoff_from`이 없다 (gjc와 같은 결과) | `ralplanHandoffTx`; ralplan 편차 34, R-OD18, U25; `tests/ralplan-tool.test.ts:414` | `skill ultragoal` 뒤 `ultragoal create` |
| RK24 | `skill ultragoal` 게이트는 ralplan을 로드한 execution 안에서만 인계한다. 나중 execution의 로드는 ralplan을 활성 `final`로 남긴다. 게이트가 먼저 인계하면 이어 부른 `ralplan handoff`는 거부된다 | `ultragoalGate`(`src/hooks.ts:796-818`), 표식 삭제(`:1264`); ralplan 편차 37, PQ-21 A, U8; `tests/hooks.test.ts:1562` | `final` 뒤, `skill ultragoal` 전에 `ralplan handoff(to="ultragoal")` |
| RK25 | 계획 중 체인 가드는 ultragoal 쪽만 있다. `skill ralplan` 재로드와 `skill deep-interview` 로드는 거부되지 않는다 | `executeBefore`(`src/hooks.ts:1037-1093`); ralplan 편차 37 | SKILL 문구로만 |
| RK26 | `final` 뒤 다듬기 쓰기가 있어도 인계는 옛 `pending-approval.md`를 넘긴다 | `persistArtifactTx`(`store.ts:372-406`), 잠긴 phase; U10 (결정 필요) | 다듬었으면 새 `final`을 쓴 뒤 인계 |
| RK27 | 계획 경로는 결과 문구로만 전해지고, ralplan 쪽 인계 이유는 어디에도 남지 않는다 | `ralplanHandoff`(`store.ts:1378-1394`), `handoffWorkflowTx`; U6, U41 | 기록만 |
| RK28 | 넘겨받은 run은 옛 run을 이어 쓰고, 이미 활성인 ralplan도 인계가 `planner`로 되돌린다 | `handoffWorkflowTx`(`src/skill-state/handoff.ts:212-322`); U13, U40, K7, K15 | 새 예산이면 첫 `write`에 새 `run_id` |
| RK29 | deep-interview 결합 호출 `spec(…, handoff: "ralplan")`은 `start`의 두 거부를 거치지 않는다 | `src/tools.ts:56-62`; K1, K11, K12, K14 | deep-interview 문서 |
| RK30 | doctor는 checksum·저널을 보지 않고, 행 없는 활성 상태도 보고하지 않는다 | `collectDoctorSummaryTx`(`src/skill-state/doctor.ts:149-279`); ralplan 편차 13, U15 | 기록만 |
| RK31 | 진행 표시가 없다. Stop here 뒤에는 승인 대기를 보여 줄 행도 없다 | ralplan 편차 9, 필수 후속 6, R-OD17, U5, K4 | `ralplan status` |
| RK32 | 압축 복구 문맥은 상태가 활성이면 보이는 주 skill과 상관없이 들어가고, 첫 planner·revision·final 파일 전에는 들어가지 않는다 | `compaction`(`src/hooks.ts:1194-1241`), `projectRalplanRun`(`recovery.ts:202-305`) | 기록만 |
| RK33 | 여러 OpenCode 프로세스 사이는 직렬화하지 않는다 | 필수 후속 4, R-5, U31; `queueKey`(`src/state.ts:446-451`) | 한 worktree에 프로세스 하나 |
| RK34 | `repository_binding`은 기록만 하고 강제하지 않는다 | ralplan 편차 12; `src/ralplan-runtime/binding.ts` | 기록만 |
| RK35 | 병렬 쓰기 호스트 프로브는 같은 큐의 경합을 강제하지 않는다 | `tests/ralplan-trail-probe.ts:9-12`; 로컬 기록 `.omc/progress.txt:73` | 열린 리뷰 항목(차단 아님) |
| RK36 | 결과·거부 문구와 SKILL·프롬프트 몇 곳이 실제 동작과 다르다. 루트 README의 불일치는 2026-10-04 고침 | 2026-10-03 문서화; 아래 절 | 결정 필요 (README 부분은 해결) |
| RK37 | 역할이 자기 lane 밖 단계와 새 `run_id`를 쓸 수 있고, `state` op는 어떤 필드도 지키지 않는다(안전하지 않은 `run_id`가 들어가면 `start`·`handoff`가 막힌다). 조인 gate는 상태로 볼 수 없다 | `tool.ts:61,236-239`, `patchStateTx`; 실행 확인 | 결정 필요 |
| RK38 | 원장 복구·중복 처리에 가장자리 동작이 있다(복구의 "no changes written", 깨진 index 줄, opener 전 단계, 중간 실패를 되돌리지 않음 등) | `writeStageTx`, `ledger.ts`; 실행 확인 | 결정 필요 |
| RK39 | run 전환이 옛 필드를 남기고, 상태의 몇 필드는 기록만 하며, HUD 칩 상한이 `handoff` 칩을 떨어뜨린다 | `store.ts:523-529`, `hud.ts`; 실행 확인 | 기록만 |
| RK40 | 가드의 phase 비교와 사라진 `final` 파일 문구가 gjc와 다르다. 2026-10-04 ralplan 편차 40·41로 기록 | `src/hooks.ts:753-758`, `store.ts:417-420` | 기록만 (편차 40·41) |
| RK41 | 계획 문구와 쓰이지 않는 코드가 남아 있다. 낡은 주석, 입력 설명, gjc 줄 범위, ultragoal 문서는 2026-10-04 고침 | 아래 절 | 고칠 때 같이 (나머지는 해결) |

## 항목별 설명

### 진입과 시작

#### RK1. 로드만으로는 run이 시작되지 않음 (ralplan 편차 36)

- **흐름**: `@ralplan` 멘션과 키워드는 `[MODE: RALPLAN]` 안내만 넣습니다(`src/hooks.ts:938-957`). 멘션과 `skill ralplan` 로드는 턴 표식도 세웁니다(`:951,997`, `:1093`). 상태 파일도 활성 행도 생기지 않습니다.
- **결과**: `ralplan start`나 첫 `ralplan write` 전까지 ralplan은 보이는 주 skill이 아닙니다. 그래서 계획 가드가 편집을 막지 않고, 모델이 턴을 끝내도 continuation이 없습니다.
- **gjc와 다름**: README 편차 36에 따르면 gjc는 `/skill:ralplan` 로드 때 `planner` 상태와 저장소 바인딩, 활성 행을 씁니다(`hooks/skill-state.ts:387-496,641`; 이 위치는 README에서 옮겼고 이 문서를 쓰며 다시 읽지 않았습니다). open-gajae는 spec D-F13·R-O6대로 `start`를 진입으로 둡니다.
- **예외**: 같은 execution에서 deep-interview를 로드한 뒤의 `skill ralplan`은 deep-interview 로드 게이트를 지납니다(`src/hooks.ts:1074-1092`). 게이트가 인계하면 ralplan은 `planner`로 활성이 됩니다([entry-and-handoff.md](entry-and-handoff.md)).
- **정리**: SKILL의 첫 지시가 `ralplan start`입니다(`skills/ralplan/SKILL.md:17`).

#### RK2. 활성 run에서는 `start`가 거부됨 (ralplan 편차 39)

- **검사**: `start`는 트랜잭션 하나에서 ① ultragoal 상태가 `active: true`, ② ralplan 상태 파일이 `active: true`, ③ 빈 `task` 순으로 거부합니다(`tool.ts:194-201`). ②는 활성 행이 아니라 상태 파일만 봅니다. ②의 문구는 다음 틀입니다(`ralplanRunActiveRefusal`, `tool.ts:73-78`). `<…>`는 상태 값이고, `handoff_from`이 있을 때만 괄호 안 두 번째 부분이 붙습니다.

  ```
  ralplan run <run_id> is already active (phase <current_phase>, handed over from <handoff_from>); continue it with ralplan write. To plan anew, stop it first with ralplan state {"active": false} or ralplan clear.
  ```

- **걸리는 경우**: 진행 중인 run, `ultragoal handoff`나 deep-interview 인계로 넘겨받은 run, 승인 질문 중인 활성 `final`, `write`가 만든 상태(RK4), ultragoal 중 `write`로 활성이 된 상태(RK6), 옛 형식 상태(RK11). 실행 확인: 활성 `final`에 `start(task, run_id: "fresh-run")`을 부르면 `ralplan run ses_root is already active (phase final); …`로 거부됩니다. 새 `run_id`도 이 검사를 지나지 못합니다.
- **정리**: 이어 갈 run이면 `ralplan write`. 새 계획이면 Stop here(`ralplan state(patch={"active": false})`)나 `ralplan clear` 뒤 `start(task, run_id: "<새 이름>")`입니다. `run_id`를 빼면 옛 폴더로 갑니다(RK3). ultragoal로 인계한 뒤에는 ultragoal이 활성이라 `start`가 ①의 ultragoal 거부에 걸리므로(실행 확인: `ralplan cannot be started while ultragoal is active; …`), `ultragoal handoff(to: "ralplan", reason)` 뒤 첫 `write`에 새 `run_id`를 줍니다(RK28). deep-interview로 인계한 뒤에는 `start`가 됩니다. RK11의 옛 형식 상태는 `clear`만 됩니다.
- **근거**: 관리자 결정 K14 C(deep-interview 개정, DR-39). gjc의 CLI 시드는 거부하지 않고 같은 run id로 다시 시드합니다(편차 39의 출처). 테스트 RP3 `tests/ralplan-tool.test.ts:529`, RP4 `:558`.

#### RK3. `start`가 옛 run 폴더를 이어 씀 (gjc와 같음)

- **흐름**: `startRunTx`의 run 폴더는 입력 `run_id` → 상태의 `run_id` → 소유 세션 id 순입니다(`store.ts:922-925`). 상태의 `run_id`는 Stop here나 `clear` 뒤에도 남습니다. 그래서 같은 세션에서 `run_id` 없이 다시 `start`하면 옛 폴더를 씁니다. `start`는 상태 파일을 통째로 새로 쓰므로 `planning_stuck`, `auto_handoff`, 리뷰 판정 필드는 사라지지만, 폴더 안의 파일은 그대로입니다.
- **실행 확인 1** (Stop here 뒤 `start(task: "second")`): 결과 `run_id`는 옛 값 `ses_root`입니다. `planner` 1을 다른 내용으로 쓰면 다음처럼 거부됩니다.

  ```
  refusing to overwrite ralplan planner stage 1 at <session>/plans/ralplan/ses_root/stage-01-planner.md: an artifact with different content already exists (existing sha256=…, new sha256=…). Use a new stage_n to record another pass.
  ```

- **실행 확인 2** (`maxIterations: 1`, 막힌 run을 `clear`한 뒤 `start`): 새 `planner` 3이 곧바로 `PLANNING-STUCK: ralplan consensus iteration cap exceeded: opening planner would start iteration 2 (max 1) …`을 받고, 새 `final`의 `auto_handoff`는 `degradationReason: "planning_stuck"`입니다. 예산은 `index.jsonl`과 디스크 파일에서 세고, 막힘 행도 그 index에 남기 때문입니다([stages-and-ledger.md](stages-and-ledger.md)).
- 옛 `pending-approval.md`는 새 `final`이 덮어쓸 때까지 남습니다.
- **gjc**: `seedRalplanState`도 기존 run id를 다시 씁니다(`gjc-runtime/ralplan-runtime.ts:2388-2391`, "Reuse an existing run id when present …"). gjc 시드에는 run id 입력이 없고, `start(run_id)`는 open-gajae가 더한 것입니다(ralplan 편차 31).
- **거부 문구가 알려 주지 않음**: RK2의 거부 문구는 "To plan anew, stop it first …"까지만 말합니다(`tool.ts:77`). 그대로 멈춘 뒤 `run_id` 없이 `start`하면 옛 폴더로 가서 새 계획의 `planner` 1이 위처럼 덮어쓰기로 거부됩니다. 새 `run_id`를 주라는 말은 SKILL에만 있습니다(RK36).
- **정리**: 새 계획은 `start(task, run_id: "<새 이름>")`(`SKILL.md:17`). 계획 R-11이 같은 위험을 적었습니다.

#### RK4. `write`로 생긴 상태 (수용 차이 "No seeding", gjc와 같음)

- `start` 없는 첫 `write`는 `persistActiveRunIdTx`로 상태를 만듭니다(`store.ts:513-545`). 필드는 `run_id`, `skill`, `active: true`, `current_phase`(쓴 단계), `version`, `updated_at`뿐입니다. `mode`, `interactive`, `task`, `repository_binding`, `session_id`는 없습니다.
- 영수증의 `repository_binding`은 그때 잡은 값입니다(`store.ts:645-648`). 상태에는 저장되지 않으므로, 이런 run에서는 쓰기마다 세션 큐 안에서 `git`을 다시 불러 바인딩을 잡습니다.
- 새 `run_id`로 run을 바꿀 때 남는 옛 필드는 RK39에 있습니다.
- gjc `persistActiveRunId`도 이 필드들만 쓰고 `mode`, `interactive`, `task`, 바인딩은 쓰지 않습니다(`gjc-runtime/ralplan-runtime.ts:1022-1029`). 관리자 결정 R-O6. 테스트 `tests/ralplan-tool.test.ts:345`.

#### RK5. 키워드 감지와 안내 범위 (R-OD20, U26)

- **안내만**: 키워드·멘션은 상태를 쓰지 않습니다(RK1).
- **받는 쪽**: `open-gajae`, agent가 없는 세션, agent 조회가 실패한 세션만 안내를 받습니다(`src/hooks.ts:906`, R-OD20). 역할 subagent의 프롬프트는 훅 첫 검사에서 바로 돌아갑니다(`:870`). 호스트 `build`·`general`과 사용자 agent는 안내를 받지 않습니다. 이들에게는 `ralplan` 도구가 숨겨지고 호출해도 거부되기 때문입니다.
- **감지 규칙**: OMC 감지기를 그대로 옮겼습니다(`src/ralplan.ts` 141행 이후). 질문, 문서화 요청, 인용, 코드·표·인용 블록 안의 단어, 백틱 안의 `ralplan`은 발화하지 않습니다. OMC의 ASCII/한국어 비대칭도 그대로입니다. `랄플랜 이거 정리해줘`는 발화하고 `ralplan 이거 정리해줘`는 발화하지 않습니다(`tests/ralplan.test.ts:231`, 사용자 결정으로 대칭화하지 않음).
- **문맥 예** (해결, 2026-10-04: README.md 121행은 예전에 "따옴표 속 언급은 발화하지 않는다", "활성화 동사나 메시지 맨 앞"이라고 줄여 적었으나, 지금은 아래 동작과 실제 호출 문맥을 적습니다). 실행 확인(`detectRalplanKeyword`): `run "ralplan" on this issue`는 발화합니다. 한국어 문장 가운데의 키워드(`이 이슈 랄플랜 해줘`, `이번 작업은 ralplan 으로 해줘`)는 발화하지 않고, `랄플랜 해줘`처럼 맨 앞이면 발화합니다.
- **영어 동사 뒤의 한국어·일본어 별칭 (OMC와 같음)**: 활성화 동사 정규식과 영어 진단 정규식은 `\b…\b`로 키워드를 감싸서(`src/ralplan.ts:487-488,547-548`) 한글·가나 별칭을 잡지 못합니다. 실행 확인: `use 랄플랜 for this`와 `start ラルプラン now`는 조용하고 `please 랄플랜 this`는 발화합니다. 진단 문맥도 비대칭이라 `ralplan keeps looping`은 조용하지만 `랄플랜 keeps looping`은 발화합니다. OMC `5281b19`의 같은 정규식(`src/hooks/keyword-detector/index.ts:509-510,569-570`)을 그대로 옮긴 것입니다.
- **함께 온 요청**: ultragoal이 보이는 주 skill이면 ralplan 안내 대신 ultragoal 인계 안내가 갑니다(`:941-945`, PQ-5 (1) B). 한 메시지에 ralplan과 ultragoal 키워드가 함께 있으면 ultragoal 안내는 빠집니다(`:961`).
- **정리**: 안내가 없어도 `@ralplan` 멘션이나 `skill ralplan`으로 들어갈 수 있습니다. 자세한 규칙은 [entry-and-handoff.md](entry-and-handoff.md)에 있습니다.

### 쓰기와 상태

#### RK6. ultragoal 실행 중의 `write` (R-AE1, U22)

- **흐름**: `write`는 ultragoal을 확인하지 않습니다(`tool.ts:249`, "R-AE1: no refusal while ultragoal runs"). 역할이나 primary의 `ralplan write`는 ralplan 상태를 만들거나(RK4), 새 `run_id`나 잠기지 않은 phase면 다시 활성으로 만듭니다(`SKILL.md:30`).
- **행**: ralplan 행이 쓰이지만 순위상 ultragoal(2)이 ralplan(1)보다 위라서(`rows.ts:51-55`) ultragoal이 보이는 주 skill로 남습니다. 이 동안 ralplan 가드와 continuation은 적용되지 않습니다.
- **행이 지워지는 경우**: 그 뒤 ultragoal이 자기 행을 활성으로 쓰면(reconcile하는 op나 `skill ultragoal` 시드, `src/ultragoal-runtime/store.ts:428-432,491-501`) `syncActiveRowTx`가 위쪽 파이프라인 행인 ralplan 행을 지웁니다(`rows.ts:154-157`). ralplan 상태는 `active: true` 그대로입니다.
- **결과**:
  - ralplan 행이 남은 채 ultragoal 행이 없어지면 ralplan이 보이는 주 skill이 됩니다. 계획 가드가 편집을 막고, goal이 활성이 아니면 ralplan continuation이 다시 돕니다(README 181행).
  - ralplan 행이 지워졌으면 ralplan은 보이는 주 skill이 아니라서 가드와 continuation은 없습니다. 대신 `ralplan start`가 거부되고(RK2), 압축 때 ralplan 문맥이 들어가며(RK32), doctor는 이 상태를 보고하지 않습니다(RK30).
- **정리**: `ralplan state(patch={"active": false})`나 `ralplan clear`. 계획 가드의 거부 문구도 두 방법을 적습니다(`RALPLAN_MUTATION_BLOCK_MESSAGE`, `src/hooks.ts:334-335`). gjc 그대로 두기로 한 관리자 결정입니다(R-AE1, 계획 R-13, 수용 차이 "One-mode rule partly lifted").

#### RK7. 멈춘 run이 다음 `write`로 다시 켜짐 (gjc와 같음)

- **흐름**: `persistActiveRunIdTx`는 같은 run이면 phase를 쓴 단계로 옮기고 `active: true`를 다시 세웁니다. 상태를 그대로 두는 것은 현재 phase가 잠긴 phase일 때뿐입니다(`store.ts:521-541`, `advanceCurrentPhase` `manifest.ts:158-166`).
- **실행 확인**: `architect` 1을 쓴 뒤 `state(patch={"active": false})` → 상태 `{active: false, current_phase: "architect"}`, 행 없음 → critic이 `critic` 1을 씀 → 상태 `{active: true, current_phase: "critic"}`, 행 `{active: true, phase: "critic"}`.
- **일어나는 때**: 계획 중에 사용자가 멈춰 달라고 해서 primary가 `{"active": false}`를 부른 뒤 아직 돌던 역할이 쓰는 경우, breaker 소진(RK22) 뒤 역할이나 primary가 쓰는 경우입니다. 계획 가드와 continuation이 돌아옵니다.
- **gjc**: `persistActiveRunId`가 같은 방식으로 다시 켭니다(`gjc-runtime/ralplan-runtime.ts:1014-1026`, "always re-assert active").
- **정리**: 역할이 끝난 뒤 다시 멈춥니다. run을 끝낼 것이면 `ralplan clear`입니다. `complete`는 잠긴 phase라 그 뒤 같은 run의 쓰기는 상태를 다시 켜지 않습니다. 다만 행 문제가 남습니다(RK8).

#### RK8. 잠긴 phase 뒤의 쓰기, doctor, clear (README 알려진 동작, gjc와 같음)

- **흐름**: 같은 run의 phase가 잠겨 있으면(`final`, `handoff`, `complete` 등) `write`는 `active`와 `current_phase`를 바꾸지 않습니다(`store.ts:531-537`, R-OD9). 그러나 상태가 그대로인 것은 아닙니다. 역할 id·`*_resumable`·fallback 필드, lane 판정(`last_review_verdict*`), `final`의 `auto_handoff`는 그 뒤에 병합되고, 그때마다 `updated_at`이 바뀌며 상태 쓰기 감사 행이 남습니다(`store.ts:823-840`). 활성 행은 언제나 `active: true`, phase = 쓴 단계로 다시 씁니다(`store.ts:842-867`). gjc `syncRalplanHud`도 `active: !options.pendingApproval || options.stage === "final"`(`gjc-runtime/ralplan-runtime.ts:1922`)이라, 쓰기 뒤의 호출(`:2217-2226`)에서는 늘 참입니다.
- **실행 확인 (병합)**: `final` 1 뒤 Stop here, 그다음 architect가 `architect` 2를 `lane_verdict: "WATCH"`로 쓰면, 상태에서 `updated_at`, `architect_id`, `last_review_verdict`, `last_review_verdict_lane`, `last_review_verdict_stage_n`이 바뀌고 `active: false`, `current_phase: "final"`은 그대로이며, 행은 `{active: true, phase: "architect"}`로 다시 생깁니다. README.md 181행은 예전에 "the state is left untouched"라고 적었으나, 이 병합과 행 다시 쓰기, Stop here·`clear` 뒤 행을 지우는 방법을 적도록 고쳤습니다(해결, 2026-10-04). 계획 DR-3(`.omc/plans/ralplan-gjc-stage-trail.md:31`)은 옛 문구 그대로입니다(역사 기록). `SKILL.md:30`은 "does not re-activate"라고만 해 맞습니다.
- **실행 확인**: `final` 1 뒤에 `revision` 2를 쓴 세 경우입니다. doctor 결과의 `problems[].message`이고, `fixCommand`는 모두 `ralplan clear`였습니다.

  | 경우 | 상태 / 행 | doctor 메시지 | force 없는 `clear` | `state(patch={"active": false})` |
  |---|---|---|---|---|
  | 승인 질문 중 다듬기 | `{active: true, final}` / 활성 `revision` | `active entry for ralplan phase revision differs from canonical mode-state phase final`, 같은 내용의 `active snapshot …` | 성공. run이 `complete`로 끝남 | Stop here가 됨 |
  | Stop here 뒤 다듬기 | `{active: false, final}` / 활성 `revision` | 위 둘 + `active entry for ralplan does not match a live active mode-state` | 성공. run이 `complete`로 끝남 | 성공. 행을 지움 |
  | `clear` 뒤 쓰기 | `{active: false, complete}` / 활성 `revision` | 위 셋(phase가 `complete`) | `existing state for ralplan is stale (mode-state is already terminal (complete)); use force: true to clear` | `unknown ralplan phase "complete"` |

- gjc doctor도 같은 두 문구로 보고합니다(`gjc-runtime/state-runtime.ts:417,525`).
- **문제 1**: 위 두 경우에 doctor가 권하는 `ralplan clear`는 run을 끝냅니다. clear는 잠긴 상태 phase를 행 phase 대신 읽기 때문입니다(`describeStaleClearTx`, R-OD14; gjc `gjc-runtime/state-runtime.ts:244-270`도 같음). SKILL(`SKILL.md:32`)과 README(189행)는 "이 보고만으로 clear하지 않는다"고 적습니다(계획 R-25: 문서 안내로만 완화).
- **문제 2**: `clear` 뒤 쓰기로 생긴 행에는 force 없는 `clear`, `ralplan handoff`, `{"active": false}`만의 `state` 패치가 듣지 않습니다. force 없는 `clear`는 상태가 이미 종료 phase(`complete`)라서 거부하고(`describeStaleClearTx`의 첫 검사, `store.ts:1097-1099`), `ralplan handoff`는 비활성 ralplan을 거부하며(RK23), phase를 주지 않은 패치는 phase가 `complete`로 남아 manifest 밖이라 거부됩니다(RK10). 듣는 것은 `clear(force: true)`와, manifest phase를 함께 주는 패치(예: `state(patch={"active": false, "current_phase": "final"})`)입니다. 이전 phase `complete`가 manifest 상태가 아니라서 전이 검사를 건너뛰기 때문입니다(`store.ts:1037-1046`; RK37의 `run_id` 고치기와 같은 방식). 실행 확인: 그 패치는 성공했고, 행이 지워졌으며, 상태는 `{active: false, current_phase: "final"}`이 됐습니다.
- **문제 3**: 그 행이 남아 있는 동안 ralplan이 보이는 주 skill이 됩니다. 행 쓰기는 위쪽 deep-interview 행도 지웁니다. `deep-interview start`와 취소된 인터뷰의 재개(`state(patch={"active": true})`)는 이때 거부됩니다(`otherPrimaryTx`, `src/deep-interview-runtime/store.ts:217-223,313-314,710-711`). Stop here 뒤 다듬기의 행도 같고, 그때는 `ralplan state(patch={"active": false})`로 풀립니다. 실행 확인(`clear` 뒤 쓰기): `deep-interview start`는 다음처럼 거부되고, 문구가 권하는 세 방법은 이 상태에서 모두 실패합니다.

  ```
  deep-interview start is refused while ralplan is the active workflow (phase complete). To interview from here: while ultragoal runs, call `ultragoal handoff(to: "deep-interview", reason)`; once ralplan has finished (final), call `ralplan handoff(to: "deep-interview")`; or stop ralplan first with `ralplan state {"active": false}` or `ralplan clear`, then start.
  ```

- **정리**: 다듬기로 생긴 행은 `ralplan state(patch={"active": false})`(Stop here)로, `clear` 뒤의 행은 `ralplan clear(force: true)`나 `ralplan state(patch={"active": false, "current_phase": "final"})`로 지웁니다. 뒤의 것은 상태를 `final`로 되돌리므로, run을 끝난 상태로 두려면 `clear(force: true)`입니다. SKILL의 손상·낡은 상태 복구 절도 `clear(force=true)`를 적습니다(`SKILL.md:28`). 테스트 `tests/ralplan-tool.test.ts:292`, `tests/hooks.test.ts:1171`.

#### RK9. 전이 감사 행 (README 알려진 동작, gjc와 같음)

- `write`의 phase 이동이 전이 표(`RALPLAN_TRANSITIONS`, `manifest.ts:42-69`)에 없으면, 이전 상태가 활성일 때 `invalid_transition_detected` 감사 행을 남기고 그대로 씁니다(`writeStateTx`, `store.ts:199-228`, spec D-T11).
- SKILL 순서가 이 행을 늘 만듭니다. 1회차 병렬 리뷰(`intent→critic`, `critic→architect`), architect가 마지막인 합의(`architect→post-interview`), `revision→architect`, `post-interview→final` 등입니다(README 191행). 2026-09-30 수동 실행 두 번에서도 4~5행씩 남았습니다(U38).
- 인계도 같은 감사 행을 남길 수 있습니다(RK28). 영향은 감사 로그의 소음뿐이고 ralplan을 다시 개정할 때 볼 후보입니다(계획 R-18). gjc도 같은 자리에서 감사 행만 남기고 씁니다(`gjc-runtime/state-writer.ts:1052-1066`).

#### RK10. `state` op로 할 수 없는 것 (ralplan 편차 38)

- gjc `state write`의 `--force`(알 수 없는 phase와 표 밖 전이를 우회)와 `--replace`(전체 교체)가 없습니다. 관리자 결정은 기록만입니다(R-OD19).
- **실행 확인**: `planner`에서 `state(patch={"current_phase": "final"})`은 `invalid ralplan phase transition from planner to final`로 거부됩니다. `state(patch={"state": {"current_phase": "architect"}})`는 성공하지만, 중첩 객체를 최상위로 펼치지 않고 `state` 필드로 저장하며 phase는 `planner` 그대로입니다.
- phase는 manifest 상태 10개(9단계와 `handoff`)만 됩니다(`store.ts:1039-1040`). 그래서 `complete`나 옛 형식 phase의 상태에는 `{"active": false}` 같은 패치도 거부됩니다(RK8, RK11). 다만 이전 phase가 manifest 밖이면 전이 검사를 건너뛰므로, manifest phase를 함께 주는 패치는 지나갑니다(`store.ts:1041-1046`, RK8 문제 2, RK37). `final`에서 나가는 전이는 표에 없어서 `state`로 `final`을 떠날 수 없습니다. 인계는 `handoff` op가 맡습니다(ralplan 편차 22).
- gjc도 `--force` 없이는 같은 두 거부를 냅니다(`gjc-runtime/state-runtime.ts:1330-1341`).

#### RK11. 옛 형식 상태 (DR-21)

- **기록된 동작**: 알 수 없는 phase(예: OMC의 `current_phase: "ralplan"`)의 상태는 판독 불가로 봅니다. 계획 가드는 풀리고, continuation은 없고, `skill ultragoal` 게이트는 지나가고, doctor는 `schema_violation`을 보고합니다(README 450행, `tests/hooks.test.ts:1206`).
- **어긋나는 곳**: `start`의 활성 검사는 `active === true`만 봅니다(`tool.ts:197-198`). 실행 확인(`{active: true, current_phase: "ralplan"}`):

  | 호출 | 결과 |
  |---|---|
  | `start` | `ralplan run (none) is already active (phase ralplan); continue it with ralplan write. To plan anew, stop it first with ralplan state {"active": false} or ralplan clear.` |
  | `state(patch={"active": false})` | `unknown ralplan phase "ralplan"` |
  | `doctor` | `schema_violation`, `unknown ralplan phase "ralplan"`, fix `ralplan clear (force: true)` |
  | `clear` (force 없음) | 성공. `{active: false, current_phase: "complete"}` |

- README 450행은 예전에 "delete their state by hand"라고 적었으나(편집 도구는 `state/**` 항상 차단에 걸림), 지금은 `start` 거부와 `state` 거부를 적고 `ralplan clear`로 초기화하라고 합니다(해결, 2026-10-04). 코드 동작(활성인 옛 상태를 `start`가 거부하고, 그 거부가 권하는 `state {"active": false}`가 실패함)은 그대로 한계입니다. force 없는 `ralplan clear`로 충분합니다. `run_id`가 없는 옛 상태라면 첫 `write`도 새 run으로 바꿉니다. 옛 필드 위에 `run_id`, phase, `active`를 씁니다(RK4).

#### RK12. receipt·revision 없음 (ralplan 편차 17)

- 상태 봉투에 gjc `receipt`, checksum, `state_revision`이 없습니다(R-OD6). 행과 스냅숏에도 revision 번호가 없습니다(수용 차이 "No revision numbers").
- 그래서 `status(fields: ["fresh", "fresh_until", "receipt"])`는 늘 `fresh: false`이고 나머지 둘은 비어 있습니다(`store.ts:1229-1252`). 실행 확인: 결과가 `{"fresh": false}`였습니다. `state` op 뒤의 receipt는 활성 행에만 실립니다(`stateWriteReceipt`, `store.ts:295-317`).
- revision 없이도 쓰기 순서가 바뀌지 않는 것은 한 프로세스의 세션 큐 하나가 모든 쓰기를 줄 세우기 때문입니다. 여러 프로세스는 RK33입니다.

#### RK13. 설정은 시작 때 한 번 (ralplan 편차 4)

- `open-gajae.jsonc`의 `ralplan.maxIterations`, `maxReviewPassesPerLane`, `autoHandoff`는 플러그인 설정 때 한 번 읽습니다(`src/index.ts:29,62`, DR-13). 편차 4에 따르면 gjc는 쓰기마다 읽습니다.
- 바꾼 값은 호스트를 다시 시작해야 적용됩니다. `source`는 이긴 설정 파일의 경로를 적습니다([state-and-files.md](state-and-files.md)).

### 예산과 PLANNING-STUCK

#### RK14. 막힌 run (U14, 일부 gjc와 같음)

- **실행 확인** (`maxIterations: 1`, `planner` 1 뒤 `revision` 2): 결과 첫 줄은 다음과 같고, 상태는 `{active: true, current_phase: "planner", planning_stuck: {marker: "PLANNING-STUCK", …}}`로 남습니다.

  ```
  PLANNING-STUCK: ralplan consensus iteration cap exceeded: opening revision would start iteration 2 (max 1) (run_id=ses_root, stage=revision, stage_n=2, source=default). Stop opening planner/revision passes; escalate the best existing plan via final/pending-approval without auto-implementation.
  ```

- **continuation**: 멈추고 breaker를 되돌립니다(`src/ralplan.ts:129-130`).
- **계획 가드**: `planning_stuck`을 보지 않아 계속 편집을 막습니다(`src/hooks.ts:753-758`). gjc 가드도 보지 않습니다(`skill-state/workflow-mutation-guard.ts`에 `planning_stuck` 없음).
- **같은 execution의 `skill ultragoal`**: phase가 `planner`라 다음 문구로 거부합니다(`RALPLAN_RUNNING_REFUSAL`, `store.ts:143-144`). 막힌 run은 승인 단계로 갈 수 없으므로 앞쪽 안내는 맞지 않고, 뒤쪽 "ralplan 멈추기"는 동작합니다.

  ```
  ralplan planning is running; finish it first: choose "Approve execution via ultragoal" at its approval step, or stop ralplan (`ralplan state` with {"active": false}) and try again.
  ```

- **막힌 `final`**: `final`은 쓸 수 있고, 영수증의 `auto_handoff`는 `{"configuredTarget":"off","effectiveTarget":"off","degradationReason":"planning_stuck","source":"default"}`입니다. 그런데 `ralplan handoff(to: "ultragoal")`는 막힘을 보지 않고 성공하며, 결과는 계획을 "the approved plan"이라고 부릅니다(실행 확인). 같은 execution 게이트도 `final`이면 인계합니다(`src/hooks.ts:809-812`). gjc 체인 가드도 막힘을 보지 않습니다(`tools/skill.ts:54-61`).
- **lane 예산 초과도 run 전체를 막음**: 막힘 행은 run마다 하나이고(`ralplanPlanningStuckIndexKey`), lane 예산 초과도 그 행을 씁니다. 그 뒤 새 `revision`으로 합의에 이르러도 그 run의 모든 `final`은 `off`/`planning_stuck`이 되고, 상태의 `planning_stuck` 때문에 continuation도 멈춥니다. 실행 확인: `planner` 1, `architect` 1 뒤 `architect` 2가 lane 예산에 걸린 run에서 `revision` 2, `architect` 3(`CLEAR`), `critic` 3(`OKAY`)을 거쳐 쓴 `final` 3의 `auto_handoff`가 `degradationReason: "planning_stuck"`였습니다. lane 막힘 안내(`ledger.ts:742-744`)와 `SKILL.md:170`은 revision으로 넘기라고만 하고, 그러면 이 run은 승인 단계에서 끝난다는 말이 없습니다.
- **정리**: SKILL만 "막힌 final은 실행으로 보내지 않는다"고 요구합니다(`SKILL.md:100,111,117`). README.md 167행도 예전에는 "never dispatched"를 코드 동작처럼 적었으나, 지금은 코드가 강제하지 않아 막힌 `final`도 인계될 수 있다고 적습니다(해결, 2026-10-04). 코드 동작은 그대로입니다. 막힌 `final` 뒤에는 Stop here(`state(patch={"active": false})`)입니다. 거부 문구를 고칠지는 결정이 필요합니다(U14).

#### RK15. `stage_n`은 모델이 정함 (수동 실행 2026-09-28)

- 도구는 `stage_n`이 1..999 정수인지만 봅니다(`parseStageN`, `ledger.ts:341-351`). opener 예산은 `planner`·`revision` 행 수로, lane 예산은 마지막 opener 뒤의 lane 행 수로 세며 `stage_n`과 상관없습니다([stages-and-ledger.md](stages-and-ledger.md)).
- SKILL은 "increment `stage_n` each consensus pass"라고 합니다(`SKILL.md:51`). 2026-09-28 수동 실행에서 `openai/gpt-6-luna` 리더는 쓰기마다 번호를 올렸습니다. 관리자는 모델 해석으로 보고 바꾸지 않았습니다(계획 §8.1 "stage_n 묶음"). SKILL 문구와 도구 검사는 gjc와 같습니다.
- **영향**: 파일 번호가 회차와 맞지 않습니다. 또 disposition은 `plannerStageN`이 쓰기의 `stage_n`과 같고, 모든 finding의 source receipt `stageN`이 `plannerStageN`과 같아야 합니다(`review-conflicts.ts:343-360,416-418`). architect와 critic이 서로 다른 `stage_n`으로 썼다면 disposition을 쓸 수 없습니다. 이 거부 문구는 gjc 원문 그대로 `CLI --stage_n`이라고 적습니다(파일 머리 주석이 의도로 기록).

### 합의 절차

#### RK16. 합의는 SKILL만 요구함 (gjc와 같음)

- **코드가 보는 것**: `lane_verdict` 토큰(architect `CLEAR`/`WATCH`/`BLOCK`, critic `OKAY`/`ITERATE`/`REJECT`), disposition을 쓸 때 그 JSON의 스키마와 출처, opener·lane 예산, `final`의 `auto_handoff`(막힘만 봄).
- **코드가 보지 않는 것**:
  - 두 lane이 같은 planner 산출물을 리뷰했는지(리뷰 조인 gate, `SKILL.md:80`)
  - `final` 전에 Critic `OKAY`와 Architect `CLEAR`가 있는지
  - 충돌이 있을 때 `revision` 전에 disposition이 있는지(`SKILL.md:81`). disposition은 쓸 때만 검사됩니다. README.md 164행도 예전에는 "must resolve each conflict before revision"이라고 적었으나, 지금은 도구가 `revision` 전에 요구하지 않고 쓸 때만 검사한다고 적습니다(해결, 2026-10-04).
  - 2회차부터 architect → critic 순서, 재리뷰 묶음, `intent`·`post-interview`를 썼는지
  - 승인 질문을 했는지, `--deliberate`의 pre-mortem이 있는지
  - architect의 `APPROVE`/`COMMENT`/`REQUEST CHANGES`. 받을 입력 칸이 없습니다(`lane_verdict`는 `CLEAR`/`WATCH`/`BLOCK`만, `LANE_VERDICTS`).
- gjc `handleArtifactWrite`에도 이런 검사가 없습니다(`gjc-runtime/ralplan-runtime.ts:2033-2261`에서 disposition 외 합의 검사를 찾지 못함). 자세한 대응은 [roles-and-consensus.md](roles-and-consensus.md)에 있습니다.
- 스펙이 계획에서 약해졌는지 잡는 곳도 `intent`·`post-interview` 단계의 모델 판단뿐입니다. ultragoal 최종 gate도 원래 스펙과 대조하지 않습니다([ultragoal known-limits](../ultragoal/known-limits.md) U42).

#### RK17. 본문 전달 방식 (ralplan 편차 30, R-O4)

- **역할**: `path`를 주면 바로 거부합니다(`tool.ts:220-223`, "`<agent>` must pass the artifact as content; path is for the primary agent only"). 큰 산출물(수십~백 KB 넘게)도 도구 인자로 인라인 전달됩니다(수용 차이 "Roles pass content only", 계획 R-7). 호스트 프로브 ①은 64 KiB 넘는 `content`가 바이트 그대로 저장되는지 확인합니다(`tests/ralplan-trail-probe.ts:4-8`).
- **primary**: `path`는 OS 임시 루트 아래, 프로젝트 밖의 일반 파일만 받습니다(`readTempArtifact`, `temp-paths.ts:94-122`). 저장소 파일은 `ralplan write path must be a file under an OS temp directory outside the project: <file>`로 거부됩니다. gjc 런타임은 바인딩된 worktree 안의 파일을 받습니다(편차 30의 출처).
- **`os.tmpdir()`의 실제 경로는 거부 (gjc와 같음)**: 임시 루트 목록은 `os.tmpdir()`를 `path.resolve`로만 넣고, 대상이 그 루트 안인지 먼저 글자로 비교합니다(`temp-paths.ts:18-29,80-81`). macOS에서 `os.tmpdir()`는 `/var/folders/…/T`이고 실제 경로는 `/private/var/folders/…/T`라서, 실제 경로로 적은 파일은 목록의 어느 루트에도 글자로 들어가지 않아 거부됩니다. 실행 확인: `realpath(os.tmpdir())` 아래 파일은 위 문구로 거부되고, `os.tmpdir()` 그대로 적은 같은 위치의 파일은 저장됐습니다. `/tmp`와 `/private/tmp`는 둘 다 목록에 있어 상관없습니다. 계획 가드의 임시 경로 예외도 같은 함수라 같습니다(RK18). gjc `neutralTempRoots`·`isNeutralTempPath`도 같습니다(`skill-state/workflow-mutation-guard.ts:1698-1708,1755-1766`). 우회는 `content`입니다.

### 가드

#### RK18. 계획 가드가 보는 도구 (ralplan 편차 11)

- 가드 대상은 `write`, `edit`, `patch`뿐입니다(`ARTIFACT_TOOLS`, `src/artifact-guard.ts:16-20`; `guardPlanning`, `src/hooks.ts:747`). `shell`의 변경 명령은 분류하지 않습니다. SKILL은 임시 디렉터리로의 heredoc 스테이징만 허용한다고 적지만(`SKILL.md:51`), `shell`로 제품 코드를 바꾸는 것은 프롬프트로만 막습니다. deep-interview 편집 가드도 같습니다(deep-interview 편차 14).
- 가드는 자기 오류에서 열립니다. 행 파일이나 상태를 읽지 못하거나, 계보 조회가 실패하면 막지 않습니다(`src/hooks.ts:778-781`, gjc와 같은 방향). 항상 차단 경로 검사는 반대로 실패하면 막습니다(`:1022-1028`). 테스트 `tests/hooks.test.ts:984`.
- 가드는 계보 전체에 걸립니다(ralplan 편차 23). executor나 다른 agent의 편집도 계획 중에는 막힙니다.
- 임시 경로 예외는 `isNeutralTempPath`라서, macOS에서 `os.tmpdir()`의 실제 경로로 적은 대상은 예외가 되지 않고 막힙니다(RK17, gjc와 같음).

#### RK19. 항상 차단 경로의 대소문자와 링크 (필수 후속 5, R-OD13, U4)

- `plans/ralplan/**`, `state/**`, deep-interview 스펙, ultragoal 파일 검사는 대소문자를 구분하는 정규식입니다(`src/artifact-guard.ts:115-116,128,143,159`). macOS 기본 파일 시스템에서는 `.OPEN-GAJAE/…` 같은 경로가 빠져나갑니다. 계획 가드가 적용 중이면 그 경로도 임시 경로가 아니라서 막힙니다.
- 이 문서를 쓰며 코드로 확인한 것(실행하지 않음): 경로는 `path.resolve`로만 정규화하고 realpath를 하지 않습니다(`projectRelative`, `:74-85`). 그래서 프로젝트 밖에서 `.open-gajae/` 안을 가리키는 심볼릭 링크 경로는 항상 차단에 걸리지 않습니다. 링크를 만들려면 `shell`이 필요하고 `shell`은 원래 검사하지 않습니다(RK18, R-OD12).
- 할 일: 비교 전 대소문자 정규화(관리자 결정 R-OD13, 필수 후속 5).

### continuation

#### RK20. continuation이 붙잡지 않는 것 (ralplan 편차 10)

- **조건**: ralplan이 보이는 주 skill이고(`decideRalplan`, `src/hooks.ts:476-483`, PQ-7 B), 상태가 활성이고, phase가 T(종료 phase 8개) 밖이고, `planning_stuck`이 아닐 때만 돕니다(`shouldContinue`, `src/ralplan.ts:121-139`). 그 앞에서 deep-interview가 먼저 판단하고, goal이 활성이면 goal 경로만 돕니다(`src/hooks.ts:558-585`).
- **결과 1**: `final`과 `handoff`는 T라 붙잡지 않습니다. 모델이 `final`을 쓰고 승인 질문 없이 턴을 끝내면 세션이 멈춥니다. 활성 `final`에서는 계획 가드가 계속 편집을 막으므로(`tests/hooks.test.ts:1188`) 사용자 답을 기다리는 상태가 됩니다. README 편차 10에 따르면 gjc의 Codex Stop 훅은 `final`·`handoff`에서도 멈춤을 막고, gjc TUI 세션에는 ralplan continuation이 없습니다(이 문서를 쓰며 gjc 소스를 다시 읽지 않음).
- **결과 2**: 보이는 주 skill이 아닌 활성 ralplan(RK6, RK24)에는 continuation이 없습니다. `tests/hooks.test.ts:1637`.
- **결과 3**: `ultragoal handoff(to: "ralplan")`으로 넘겨받은 run에서는 goal이 그대로 활성이라, ralplan continuation 대신 goal continuation이 턴을 맡습니다. 그 문구는 "Continue working on the active goal …"입니다(`src/goal/messages.ts:224-236`; README Ultragoal 절 "The goal is left as it is, so the goal loop keeps prompting while planning").

#### RK21. continuation이 agent를 확인하지 않음 (R-OD21, U27)

- `continueSession`(`src/hooks.ts:536-597`)은 루트 세션의 `session.execution.succeeded`만 보고, 그 턴의 agent를 보지 않습니다.
- 활성 ralplan 세션을 `build` 같은 agent로 바꾸면 그 agent의 턴에도 `<ralplan-continuation>`이 들어옵니다. 그 agent에게는 `ralplan` 도구가 숨겨져 있어 계획을 이어 가거나 멈출 수 없습니다.
- ralplan continuation은 breaker(RK22)에서 멈춥니다. goal 쪽은 상한이 없습니다(U27). 다른 agent의 프롬프트도 Esc 중단 표시를 풀므로(R-OD20 이후), Esc 뒤 agent를 바꿔도 해당합니다.
- 정리: `open-gajae`로 돌아가 Stop here나 `clear`, 또는 Esc(다음 실제 프롬프트까지).

#### RK22. breaker와 continuation 문구 (ralplan 편차 26, DR-17)

- **상수**: 30회, 45분(`src/ralplan.ts:25-26`, OMC 값). 카운터는 run별로 `state/ralplan-continuation.json`에 있습니다.
- **되돌아가는 때**: ralplan이 보이는 주 skill인 채로 T나 막힘 때문에 건너뛸 때, 상태의 `run_id`가 카운터와 다를 때(`start`나 `write`에 새 `run_id`를 준 경우 포함), 마지막 갱신에서 45분이 지났을 때, breaker를 다 써서 0으로 쓸 때(`src/hooks.ts:520`)뿐입니다(`src/ralplan.ts:129-135`, `src/hooks.ts:449-462,505-510`). 사용자의 실제 프롬프트는 deep-interview 예산과 goal 보류만 되돌리고 ralplan 카운터는 건드리지 않습니다(`src/hooks.ts:892-900`). 그래서 45분 안에 이어지는 긴 계획에서는 사용자와 주고받은 뒤에도 카운터가 쌓입니다. OMC가 사용자 프롬프트에서 되돌리는지는 이 문서를 쓰며 확인하지 않았습니다.
- **새 계획에도 이어짐**: 카운터는 `run_id`로만 구별됩니다. Stop here나 `clear` 뒤에는 ralplan이 보이는 주 skill이 아니라서 `decideRalplan`이 카운터를 읽기 전에 돌아가므로(`src/hooks.ts:483`) 되돌리지 않고, `start`는 상태의 `run_id`를 다시 쓰므로(RK3) 45분 안에 시작한 새 계획은 옛 횟수를 이어받습니다. 다른 문서 작성 중 실행 확인: 2회 뒤 Stop here → `clear` → `start` 다음 continuation이 `3/30`이었습니다.
- **`final`의 Stop here**: `final`을 쓴 뒤 활성 `final`인 채로 루트 `succeeded`가 한 번이라도 오면 그때 카운터가 0이 됩니다(T). 보통 흐름처럼 승인 질문과 Stop here가 `final`을 쓴 execution 안에서 끝나면(질문이 execution을 붙잡음) 0이 되지 않고 이어집니다. 다른 문서 작성 중 실행 확인. 경우별 설명은 [guards-and-continuation.md](guards-and-continuation.md)의 카운터 파일 절에 있습니다.
- **소진**: 31번째 판단에서 `patchStateTx(…, {"active": false})`를 훅 소유자로 부르고 breaker 안내를 넣습니다(`src/hooks.ts:513-526`, `tests/hooks.test.ts:569`). 행이 지워지고 run은 그 phase에 비활성으로 남습니다. Stop here와 같은 모양이라 다음 같은 run의 쓰기가 다시 켭니다(RK7).
- **breaker 안내와 감사 행**: breaker 안내는 continuation과 같은 `inject`로 들어가 `resume: true`이고 프롬프트 덧붙이기 대체가 없어서, 안내 뒤에 execution이 한 번 더 돕니다(`src/hooks.ts:430-435,593`). 감사 행은 `breaker-exhausted` 표시가 붙은 상태 쓰기, `remove-active-entry`, `rebuild-active-snapshot` 셋입니다(테스트는 표시가 붙은 행만 셈, `tests/hooks.test.ts:588-593`). README 125·185행은 예전에 이 안내를 `resume: false` 안내 목록에 넣고 감사 행을 하나라고 적었으나, 지금은 이대로 적습니다(해결, 2026-10-04).
- **문구**: continuation 본문 마지막 줄은 ``When done, call `ralplan clear` to cleanly exit.``입니다(`src/ralplan.ts:46-56`, OMC 문구의 마지막 줄만 바꾼 DR-17). SKILL의 끝은 승인 질문과 `handoff` 또는 Stop here라서, 모델이 이 줄을 따라 `final` 뒤에 `clear`하면 그 뒤 `ralplan handoff`가 거부됩니다(RK23). continuation은 T에서는 돌지 않으므로 이 줄은 계획 중에만 보입니다.
- 정리: 소진 뒤 이어 가려면 `ralplan state(patch={"active": true})`(같은 phase라 전이 검사를 지남)나 다음 `write`입니다.

### 인계

#### RK23. 비활성 ralplan의 인계 거부 (ralplan 편차 34, R-OD18, U25, gjc와 같은 결과)

- `ralplan handoff`는 phase가 T인지 본 다음, 비활성 ralplan을 거부합니다(`ralplanHandoffTx`, `store.ts:1336-1369`). Stop here, `clear`, 이미 한 인계가 모두 해당합니다. ultragoal 쪽 문구는 다음 둘입니다.

  ```
  ralplan was already handed off (inactive, phase handoff); continue in the `ultragoal` skill.
  ```

  ```
  ralplan is not active (phase <phase>), so there is nothing to hand off: Stop here or `clear` ended the run. To execute the plan, load the `ultragoal` skill, then call `ultragoal create` with the plan's goals (the approved plan: <pending-approval.md 경로>).
  ```

  괄호 안 경로는 `pending-approval.md`가 있을 때만 붙습니다. `to: "deep-interview"`의 문구는 [entry-and-handoff.md](entry-and-handoff.md)에 있습니다.
- 그래서 Stop here 뒤 나중에 실행을 요청하면 `skill ultragoal`을 바로 로드하고, ultragoal에는 `handoff_from`이 없습니다. gjc는 Stop here로 턴이 끝나 다음 턴의 로드가 인계할 활성 skill을 찾지 못하므로 결과가 같습니다(`tools/skill.ts:170-176,203-221`). 테스트 `tests/ralplan-tool.test.ts:414`.

#### RK24. 같은 execution 게이트와 나중 execution (ralplan 편차 37, PQ-21 A, U8)

- **흐름**: 턴 표식은 execution이 끝날 때마다 지워집니다(`src/hooks.ts:1264`). `ultragoalGate`(`:796-818`)는 표식이 `ralplan`이고 ralplan이 활성이며 phase가 알려진 phase일 때만 ralplan을 봅니다. T면 인계하고, 아니면 RK14의 문구로 거부합니다.
- **나중 execution**: continuation이나 백그라운드 subagent 완료가 연 execution에서 `skill ultragoal`을 로드하면 게이트 없이 ultragoal을 시드합니다(`:815`, `seedUltragoalTx` `src/ultragoal-runtime/store.ts:452-503`). 시드의 행 쓰기가 ralplan 행을 위쪽 파이프라인 행으로 지우고(`rows.ts:154-157`), ralplan 상태는 활성 `final`로 남습니다. README.md 178행은 예전에 "leaves ralplan as it is"라고만 적었으나, 지금은 상태는 남고 새 ultragoal 행이 ralplan 행을 지운다고 적습니다(해결, 2026-10-04). 보이는 주 skill이 아니라 continuation이 없고(RK20), `ralplan start`는 거부되며(RK2), 압축 문맥은 들어갑니다(RK32). README 알려진 동작(298행)과 `tests/hooks.test.ts:1562`.
- **늦은 `ralplan handoff`**: 그 뒤 `ralplan handoff(to="ultragoal")`를 부르면 활성 `final`이라 성공합니다(다른 문서 작성 중 실행 확인). 공통 인계는 ultragoal을 늘 시작 phase `goal-planning`으로 쓰므로(`handoff.ts:230-239`), 이미 `create`한 ultragoal도 `goal-planning`으로 돌아갑니다(이 부분은 코드로 확인, 실행하지 않음; K15·U40과 같은 방식).
- **같은 execution에서 순서가 바뀐 경우**: 게이트가 먼저 인계하면, SKILL 9단계대로 이어 부른 `ralplan handoff`는 `ralplan was already handed off …`로 거부됩니다(U8). 문구가 ultragoal로 가라고 하므로 흐름은 멈추지 않습니다.
- 정리: `final` 뒤에는 `skill ultragoal` 전에 `ralplan handoff(to="ultragoal")`를 먼저 부릅니다(`SKILL.md:117-127`).

#### RK25. 체인 가드는 ultragoal 쪽만 (ralplan 편차 37)

- 계획 중(T 밖) `skill ultragoal`만 같은 execution 게이트가 거부합니다. `skill ralplan` 재로드, `skill deep-interview` 로드는 `executeBefore`가 막지 않습니다(`src/hooks.ts:1059-1093`. ultragoal이 보이는 주 skill일 때의 체인 가드만 있음).
- 그런 로드는 ralplan 상태를 그대로 둡니다. 계획 루프를 지키는 것은 SKILL 문구입니다. ralplan이 보이는 주 skill인 동안 `deep-interview start`는 deep-interview 쪽에서 거부됩니다(deep-interview 편차 12). 인터뷰로 돌아가려면 T에서 `ralplan handoff(to="deep-interview")`입니다.
- gjc는 살아 있는 ralplan phase에서 어떤 skill로의 체인도 거부합니다(`tools/skill.ts:203-210`).

#### RK26. 오래된 `pending-approval.md` (U10, 결정 필요)

- `pending-approval.md`는 `final`을 쓸 때만 새로 복사됩니다(`persistArtifactTx`, `store.ts:399-403`). `final`은 잠긴 phase라 그 뒤 `revision`이나 `intent`를 써도 phase는 `final`입니다(RK8).
- `ralplan handoff`와 같은 execution 게이트는 phase만 보므로, 새 `final` 없이 인계하면 ultragoal은 이전 계획으로 시작할 수 있습니다. 2026-09-28 test-app 세션에 `final` 10 뒤 `revision` 11과 `intent` 12만 있는 실제 사례가 있습니다(U10).
- 정리: 다듬었으면 새 `final`을 쓴 뒤 인계합니다. 경고나 거부를 더할지는 결정이 필요합니다(U10).

#### RK27. 계획 경로와 인계 이유 (U6, U41)

- 계획 경로는 `ralplan handoff` 결과 문구의 `(the approved plan: <path>)`와 비활성 거부 문구로만 전해집니다(`store.ts:1359-1361,1387-1392`). 같은 execution 게이트는 경로를 알리지 않으므로 모델은 `final` 영수증의 `pending_approval_path`를 읽어야 합니다. ultragoal 상태에는 계획 경로 필드가 없습니다(U6, spec D-HE1).
- ralplan 쪽 인계 이유(`ralplan handoff to ultragoal`, `skill ultragoal loaded after ralplan`)는 `handoffWorkflowTx`에 넘겨지지만, ralplan은 `recordCaller`를 주지 않아 상태·원장 어디에도 남지 않습니다(`handoff.ts:308-311`, U41). 저널은 성공하면 지워집니다.

#### RK28. 넘겨받은 run과 되돌려지는 run (U13, U40, K7, K15)

- **옛 run 이어 쓰기**: `ultragoal handoff(to: "ralplan")`와 deep-interview 인계는 공통 인계로 ralplan 상태 위에 병합하므로 `run_id`, `task`, `mode`, `repository_binding`이 남습니다(`handoff.ts:230-239`). 옛 `final` 승인, opener 예산, `stage_n`, 막힘 행이 이어지고, 쓴 `stage_n`을 다른 내용으로 다시 쓰면 거부됩니다(README 299행, PQ-4 A, U13, K7, 계획 R-11). 새 예산이 필요하면 첫 `write`에 새 `run_id`를 줍니다. `start`는 RK2로 거부됩니다.
- **되돌리기**: 공통 인계는 callee를 늘 시작 phase로 씁니다. 이미 활성인 ralplan(예: `architect`)도 `planner`로 돌아가고, `invalid_transition_detected` 감사 행이 먼저 남습니다(`handoff.ts:172-189`). `ultragoal handoff`는 ultragoal이 활성인지 보지 않고(U40), deep-interview의 끝난 인터뷰 연결도 그렇습니다(K15, 관리자가 알고 유지한 PQ-36 C).

#### RK29. deep-interview 쪽 항목 (K1, K11, K12, K14)

- **K12**: 결합 호출 `spec(…, handoff: "ralplan")`은 `startRunTx`를 직접 부릅니다(`src/tools.ts:56-62`). 그래서 `start`의 ultragoal 거부와 활성 run 거부(RK2)를 모두 거치지 않고, 진행 중인 run도 같은 `run_id`로 다시 시드합니다. deep-interview 문서는 이것이 gjc `gjc ralplan --deliberate` 시드와 같다고 적습니다.
- **K11**: 결합 호출의 뒤 단계가 실패하면 앞 단계의 결과가 남습니다.
- **K1**: 앞 execution에서 시작한 인터뷰가 활성인데 `ralplan start`를 부르면, ralplan 행 쓰기가 위쪽 deep-interview 행을 지웁니다. 인터뷰 상태는 활성으로 남습니다. RK8 문제 3도 같은 행 쓰기입니다.
- **K14**: 해결. `ralplan start`가 활성 run을 거부해 게이트 인계 뒤 다시 시드되지 않습니다(RK2).
- 자세한 설명은 [deep-interview known-limits](../deep-interview/known-limits.md)에 있습니다.

#### RK30. doctor와 인계 저널 (ralplan 편차 13, U15)

- ralplan doctor는 gjc의 checksum 검사와 orphan 저널 검사가 없습니다(`src/skill-state/doctor.ts` 머리 주석). 인계 저널 `state/transactions/<mutation id>.json`은 증거용이라, 인계 도중 프로세스가 멈춰 `pending` 저널이 남아도 알리는 곳이 없습니다. gjc doctor도 `pending` 저널은 보고하지 않습니다(편차 13).
- doctor는 행과 스냅숏이 상태와 맞는지만 봅니다(`doctor.ts:212-258`). 활성 상태인데 행이 없는 경우(RK6, RK24)는 보고하지 않습니다. ralplan `doctor`는 요약을 JSON으로 돌려줍니다(ultragoal은 gjc 텍스트 형식).

### 표시와 기록

#### RK31. 진행 표시 없음 (ralplan 편차 9, 필수 후속 6, R-OD17, U5, K4)

- 활성 행과 스냅숏에 gjc HUD 칩을 기록하지만 그리는 TUI 플러그인이 없습니다. 배포된 OpenCode 2.0.15 바이너리가 TUI 플러그인의 `solid-js`·`@opentui/*` import를 호스트 인스턴스로 연결하지 않아, port 브랜치에서 만든 사이드바를 병합 전에 지웠습니다. 이는 2026-09-29 수동 확인 결과이고 코드로 확인할 수 없습니다.
- Stop here는 gjc처럼 활성 행을 지웁니다(R-OD10). 그래서 나중에 사이드바를 다시 붙여도 Stop here 뒤에는 승인 대기 계획을 보여 줄 행이 없습니다(수용 차이 "Stop here removes the active row"). `pending-approval.md`는 남습니다.
- 지금은 `ralplan status`로 진행을 봅니다. 칩 모양은 [state-and-files.md](state-and-files.md)에 있습니다.

#### RK32. 압축 복구 문맥의 조건

- `<ralplan-compaction-context>`는 상태가 `active: true`이고 phase가 알려진 phase이며, 최신 `final`(없으면 `planner`·`revision`) 파일의 투영이 만들어질 때만 들어갑니다(`src/hooks.ts:1211-1236`, `recovery.ts:196-201`).
- **보이는 주 skill과 상관없음**: ultragoal 실행 중 활성으로 남은 ralplan(RK6, RK24)도 압축 때 ralplan 계획 문맥을 넣습니다. ultragoal 문맥과 함께 들어갈 수 있습니다.
- **빠지는 때**: `start` 직후 단계 파일이 없을 때, `index.jsonl`에 깨진 줄이 하나라도 있을 때, 파일을 읽을 수 없거나 투영할 objective가 없을 때, 파일 sha256이 원장과 다를 때, Stop here 뒤. 역할 세션이 압축되면 그 세션 자체 폴더를 읽으므로 아무것도 넣지 않습니다(`store.ralplanTransaction(event.sessionID, …)`, `src/hooks.ts:1212`). ultragoal·deep-interview 블록은 먼저 루트 세션인지 확인하는데(`:1196,1204`), ralplan 블록은 계보 루트를 찾지 않고 받은 세션 id를 그대로 씁니다. 결과는 같지만(역할 세션 폴더에는 ralplan 상태가 없음) 방식이 다릅니다.
- gjc의 압축 복구가 같은 조건인지는 이 문서를 쓰며 확인하지 않았습니다. 형식 차이는 ralplan 편차 20입니다.

### 호스트와 저장

#### RK33. 여러 프로세스 (필수 후속 4, R-5, U31)

- 쓰기 큐는 모듈 수준 `Map`이고(`src/state.ts:109`), 키는 저장 루트와 세션 id입니다(`queueKey`, `:446-451`). 한 프로세스 안의 쓰기만 줄 세웁니다.
- 같은 worktree를 쓰는 OpenCode 프로세스 여럿은 서로 직렬화되지 않습니다. gjc는 파일 잠금을 씁니다. 기록만 하는 한계입니다.

#### RK34. 저장소 바인딩 (ralplan 편차 12)

- `repository_binding`은 `start` 때(그리고 `write`의 영수증에) `git`을 짧은 제한 시간으로 불러 잡을 뿐이고, 실패하면 빠집니다(`src/ralplan-runtime/binding.ts:1-9,63-93`). 쓰기에서 비교하지 않습니다(`store.ts:645-648`).
- gjc는 worktree가 다르면 닫힌 쪽으로 거부합니다. open-gajae는 다른 worktree에서 온 쓰기도 거부하지 않습니다.

#### RK35. 병렬 쓰기 프로브 (열린 리뷰 항목)

- 호스트 프로브 ②(`tests/ralplan-trail-probe.ts:9-12,120-147`)는 1회차 architect·critic `subagent` 호출이 한 메시지에 있고 두 쓰기가 모두 남는지, `index.jsonl`의 모든 줄이 파싱되는지를 봅니다. 두 쓰기를 같은 순간에 부딪치게 하는 장치는 없습니다.
- 2026-09-28 실행에서 두 쓰기는 약 44 ms 떨어져 도착해 같은 큐의 경합을 실제로 일으키지 않았습니다(로컬 기록 `.omc/progress.txt:73`). 단위 테스트에도 병렬 쓰기는 없습니다(R-OD3).
- 직렬화의 근거는 지금 코드의 세션 큐(RK33)입니다. 병합을 막지 않는 열린 리뷰 항목입니다.

## 다른 문서 번호와의 대응

| 다른 문서 | 번호 | 이 문서 |
|---|---|---|
| ultragoal known-limits | U4 | RK19 |
| | U5 | RK31 |
| | U6, U41 | RK27 |
| | U8 | RK24 |
| | U10 | RK26 |
| | U13, U40 | RK28 |
| | U14 | RK14 |
| | U15 | RK30 |
| | U22 | RK6 |
| | U25 | RK23 |
| | U26 | RK5 |
| | U27 | RK21 |
| | U31 | RK33 |
| | U38 | RK9 |
| deep-interview known-limits | K1, K11, K12, K14 | RK29 |
| | K4 | RK31 |
| | K7, K15 | RK28 |
| 계획 `.omc/plans/ralplan-gjc-stage-trail.md` §5 | R-5 | RK33, RK35 |
| | R-7 | RK17 |
| | R-11 | RK3, RK28 |
| | R-13 | RK6 |
| | R-15 | RK11 |
| | R-18 | RK9 |
| | R-25 | RK8 |

## 코드가 강제하는 것과 SKILL만 요구하는 것

- **코드가 막는 것**: 활성 run이나 활성 ultragoal에서의 `start`(RK2), 역할의 `path`(RK17), 같은 `(stage, stage_n)`의 다른 내용, opener·lane 예산(RK14), T 밖이나 비활성 ralplan의 `handoff`(RK23), 같은 execution의 계획 중 `skill ultragoal`(RK24), 계획 중 `write`·`edit`·`patch`(RK18), 항상 차단 경로(RK19).
- **SKILL만 요구하는 것**: 합의 판정과 리뷰 조인, 충돌 때 disposition 먼저, 2회차부터 순차 리뷰(RK16), `stage_n`을 회차마다 올리기(RK15), 로드 직후 `start`(RK1), 막힌 `final`을 실행으로 보내지 않기(RK14), 다듬은 뒤 새 `final`(RK26), `final` 뒤 `skill ultragoal` 전에 `handoff`(RK24), doctor 보고만으로 clear하지 않기(RK8), 계획 중 다른 skill을 로드하지 않기(RK25), `shell`로 고치지 않기(RK18).

## 문서화 중 확인한 불일치 (2026-10-03)

이 절은 2026-10-03 이 폴더의 문서 8개를 쓰며 찾은 것과, 그 문서들을 검토하며 찾은 것을 모읍니다. 각 작성자와 검토자가 코드를 읽었고, 여러 항목은 bun으로 재현했습니다. 재현한 것은 "실행 확인"으로 적습니다. 기존 항목을 보충하는 것은 그 항목(RK2, RK3, RK4, RK5, RK8, RK14, RK16, RK17, RK18, RK22, RK24, RK32)에 넣었습니다. RK36은 그런 항목을 한 줄로 가리킨 뒤 새로 나온 것만 풀어 적고, RK37–RK41은 새 항목입니다. "결정 필요"는 AGENTS.md에 따라 관리자가 코드나 문구를 고칠지, 기록만 할지 정할 항목입니다.

2026-10-04 관리자는 "코드가 기준"으로 정했습니다. 그래서 루트 README·README.ko, 소스 주석 몇 곳, `ralplan` 도구의 입력 설명 둘을 코드 동작에 맞게 고쳤고, 코드 동작은 바꾸지 않았습니다(줄 수도 그대로라 이 문서의 줄 번호는 유효합니다). 고친 것은 "(해결, 2026-10-04)"로 표시합니다. 코드 동작 자체가 한계인 것(예: 막힌 `final`의 인계, 잠긴 phase 뒤 병합, 옛 형식 상태의 `start` 거부, continuation 문구의 `ralplan clear`)은 해당 항목에 그대로 남습니다.

### RK36. 결과 문구·SKILL·프롬프트가 실제 동작과 다름 (결정 필요; 루트 README 부분은 해결)

**앞 항목에 설명이 있는 것**
- (해결, 2026-10-04) README.md 181행의 "the state is left untouched"와 행이 "stays until the next Stop here, handoff, or clear": RK8
- (해결, 2026-10-04) README.md 178행의 "leaves ralplan as it is": RK24
- (해결, 2026-10-04) README.md 164·167행에서 SKILL만 지키는 문장(disposition 먼저, 막힌 `final`을 보내지 않음): RK16, RK14
- (해결, 2026-10-04) README.md 125·185행의 breaker 안내 방식과 감사 행 수: RK22
- (해결, 2026-10-04) README.md 450행의 옛 형식 상태 "delete their state by hand": RK11
- 활성 run 거부 문구가 새 `run_id`를 말하지 않음: RK3
- `RALPLAN_RUNNING_REFUSAL`의 승인 단계 안내와 막힌 `final`의 "the approved plan": RK14
- continuation 문구의 ``When done, call `ralplan clear` …``: RK22
- `clear` 뒤 ralplan 행이 남았을 때 deep-interview 거부 문구가 권하는 세 방법이 모두 실패함: RK8

**루트 README** (`README.md`; `README.ko.md`도 같은 줄)
- **op 표**(129–137행): `handoff` 행은 `to="ultragoal"`만 적었으나 지금은 `"deep-interview"`도 적고(`tool.ts:156,297`), `start` 행은 활성 run 거부(편차 39, RK2)도 적습니다(해결, 2026-10-04). `doctor` 행(134행)도 예전에는 `ralplan doctor`가 요약을 JSON으로 돌려준다는 말이 없었으나, 지금은 적습니다(해결, 2026-10-04; `tool.ts:287-288`). deep-interview와 ultragoal의 doctor는 gjc 텍스트를 돌려줍니다(109·245행).
- **중단 이유**(185행, OMC 편차 표 383행): (해결, 2026-10-04) 예전에는 `superseded`를 중단 이유로 적었으나, 호스트 v2.0.15의 `InterruptReason`은 `user`, `shutdown`, `inactivity`뿐이라(`opencode/packages/core/src/session/execution.ts:49`) 지금은 "other reasons (`inactivity`)"로 적습니다. 기다리는 대상도 `background: true` subagent만이 아니라 같은 location의 모든 자식 execution이라고 고쳤습니다(`src/hooks.ts:1269-1275`).
- **편차 7의 영향**(406행): (해결, 2026-10-04) 예전의 "The reviewer model cannot change per run"은 지나쳤습니다. 지금은 run별 플래그는 없고, 호출 하나의 모델은 호스트 `subagent`의 `model` 입력으로만 바꿀 수 있으며 그 설명이 사용자가 명시적으로 요청할 때로 제한한다고 적습니다(`opencode/packages/core/src/tool/plugin/subagent.ts:36-39`).

**결과·거부 문구** (`src/ralplan-runtime/store.ts`)
- **이미 인계된 ralplan**: `to: "ultragoal"` 쪽 거부 문구는 ``continue in the `ultragoal` skill.``로 고정입니다(`store.ts:1355-1358`). deep-interview로 넘긴 ralplan에 `ralplan handoff(to: "ultragoal")`를 부르면 ultragoal로 가라고 잘못 안내합니다(실행 확인). `handoff_to`를 읽는 것은 `to: "deep-interview"` 분기뿐입니다(`:1347-1350`).

**SKILL과 프롬프트** (`skills/ralplan/SKILL.md`, `prompts/open-gajae-{planner,architect,critic}.md`)
- **`revision`을 누가 쓰는가**: `SKILL.md:57`은 revision을 "parent-side" 쓰기로 적고, 205행 표는 Planner의 정상 쓰기(`planner` 또는 `revision`)로 적습니다. planner 프롬프트의 예는 `stage="planner"`뿐이라(`open-gajae-planner.md:54`), 재개된 planner가 `planner`를 다시 쓰면 새 opener로 세어지고 `critic→planner` 같은 감사 행이 남습니다.
- **`lane_verdict`**: 세 프롬프트의 Persistence 블록에 `lane_verdict`가 없습니다(gjc 조각도 없음). 판정은 할당문이 시킬 때만 기록됩니다. SKILL 3단계가 할당문에 넣으라고 합니다.
- **RALPLAN-DR 요약, pre-mortem, deliberate 내용**: SKILL에만 있고 planner 프롬프트에는 없습니다.
- **`--interactive`**: 플래그 설명(`SKILL.md:21`)은 최종 승인 질문을 interactive와 묶어 적지만, 8단계는 `--interactive`와 상관없이 묻습니다(`SKILL.md:111`). 실제로 달라지는 것은 2e의 초안 확인뿐입니다.
- **승인 선택지 순서**: 8단계는 **Refine further**를 **Approve execution via ultragoal (Recommended)** 앞에 둡니다(`SKILL.md:112-113`). 호스트 `question` 설명은 추천 선택지를 맨 앞에 두라고 합니다(`opencode/packages/core/src/tool/plugin/question.ts:21`).
- **SKILL 출처 표**(`SKILL.md:232`): frontmatter `argument-hint`를 "as the plugin's skill loader reads them"이라고 하지만, `loadSkills`(`src/config.ts:408-431`)는 `name`과 `description`만 돌려줍니다.

### RK37. 역할과 `state` op의 넓은 권한 (결정 필요)

- **자기 lane 밖의 단계**: 역할은 어떤 단계든 쓸 수 있습니다. 실행 확인: architect가 `critic` 1을 쓰면 성공하고, critic lane 예산을 씁니다(이어 진짜 critic의 `critic` 2가 lane 예산 PLANNING-STUCK). 세션 id는 기록되지 않습니다. `tool.ts:236-239`가 역할과 lane이 맞을 때만 id를 넘기므로, `parsePersistedRoleState`의 역할 불일치 거부(`ledger.ts:943-949`)는 도구로는 닿지 않습니다. `resumable`과 fallback 필드는 호출한 역할이 아니라 단계의 lane에 붙습니다(실행 확인: architect가 `critic` 1에 `resumable: true` → 상태에 `critic_resumable: true`).
- **새 `run_id`**: 역할도 `write`에 새 `run_id`를 주어 run을 바꿀 수 있습니다(실행 확인).
- **`state` op**: 역할도 부를 수 있고(`ROLE_OPS`, `tool.ts:61`), 지키는 필드가 없습니다. 검사는 phase 전이와 봉투 모양뿐입니다(`store.ts:1001-1079`). 실행 확인: critic이 `state(patch={"run_id": "other", "planning_stuck": null})`로 `run_id`를 바꾸고 막힘 표시를 지웠습니다. `auto_handoff`와 역할 id도 같은 방법으로 바뀝니다. deep-interview `state`는 런타임 소유 필드를 거부합니다(deep-interview 편차 19).
- **안전하지 않은 `run_id`**: `state`는 `run_id` 값도 검사하지 않고, `clear`는 그 값을 남깁니다(`store.ts:1163-1170`). 그 뒤 `start`는 입력 `run_id`를 보기 전에 상태의 `run_id`를 경로로 검사하므로(`store.ts:923` → `:925`) 유효한 새 `run_id`를 줘도 실패하고, `ralplan handoff`도 비활성 거부보다 먼저 `pendingApprovalPathTx`(`store.ts:1298-1304`)에서 실패합니다. `write(run_id: "<유효한 값>")`는 입력을 먼저 쓰므로 지나갑니다(`store.ts:643`). 실행 확인: `state(patch={"run_id": "../bad"})` 뒤 Stop here, `start(task, run_id: "good")` → `invalid path component for run_id: ../bad`. `clear` 뒤의 `ralplan handoff`도 같은 오류였습니다. 고치려면 `state(patch={"run_id": null})`인데, `clear` 뒤에는 이것만으로는 `unknown ralplan phase "complete"`로 거부되고 `{"run_id": null, "current_phase": "planner"}`가 됐습니다. 새 `run_id`의 `write`로 바꿔도 됩니다.
- **조인 gate를 상태로 볼 수 없음**: `last_review_verdict*`는 마지막 판정 하나뿐이라 critic이 쓰면 architect 판정을 덮습니다(`laneVerdictStatePayload`, `ledger.ts:1056-1064`). architect의 결정 토큰도 기록되지 않습니다(RK16). 그래서 SKILL 4단계의 조인 gate는 단계 파일을 읽어야 합니다.
- gjc 역할 경로와 같은지는 이 문서를 쓰며 비교하지 않았습니다.

### RK38. 원장 복구·중복 처리의 가장자리 (결정 필요)

- **복구도 "no changes written"**: 단계 파일은 있는데 원장 행이 없는 경우(크래시 틈)의 복구 결과도 ``(identical content; no changes written)``이라고 합니다(`ledger.ts:1169`). 실제로는 원장 행을 덧붙이고, `final`이면 `pending-approval.md`를, 역할·판정이 있으면 상태를 쓸 수 있습니다(`store.ts:694-759`). 복구한 행의 `created_at`은 복구 시각입니다.
- **복구한 `final`의 승인**: 늘 `admission_unavailable`(`off`)을 받습니다(`store.ts:719`, `ledger.ts:820-827`). 원래 `ultragoal`이었어도 그렇고, 상태의 `auto_handoff`는 옛 값으로 남습니다.
- **옛 `final` 다시 쓰기**: 더 새 `final` 뒤에 옛 `final`을 같은 내용으로 다시 쓰면 `pending approval content mismatch`로 거부됩니다(`store.ts:431-435`).
- **깨진 index 줄**: `index.jsonl`의 깨진 줄 하나가 `final`을 `planning_stuck`으로 낮춥니다(`readRalplanPlanningStuck`, `ledger.ts:870-884`). 막힘 행도, 상태의 `planning_stuck`도 생기지 않습니다(실행 확인).
- **opener 전의 다른 단계**: 첫 `planner` 전에 다른 단계를 쓰면 그것이 iteration 1을 열어 `planner`가 두 번째 칸을 씁니다(`summarizeRalplanIndex`, `ledger.ts:270-285`). 실행 확인: `maxIterations: 1`에서 `intent` 1 뒤 `planner` 1이 `opening planner would start iteration 2 (max 1)`로 막혔습니다.
- **지워진 단계 파일**: `final`이 아닌 단계는 원장 행만 보고 중복을 판정하므로, 파일이 지워져도 중복 영수증을 받고 파일은 다시 생기지 않습니다(`store.ts:668-693`).
- **막힘 이유**: 원장의 막힘 행은 run마다 하나라 첫 이유를, 상태의 `planning_stuck.reason`은 마지막 이유를 가집니다(`ledger.ts:175-179`, `store.ts:568-591`).
- **알 수 없는 활성 phase**: 막힘이 나면 막힘 행을 덧붙인 뒤 상태 쓰기에서 오류가 납니다.
- **공백 본문**: `""`만 거부하므로(`tool.ts:234`) 공백만 있는 `content`도 저장됩니다(실행 확인).
- **되돌리기 없음**: 손으로 만든 활성 `completed` 상태(잠긴 phase)에서 critic이 `lane_verdict`와 함께 쓰면, 단계 파일과 index 행을 쓴 뒤 판정 병합의 상태 쓰기에서 `Refusing to write unknown ralplan phase "completed" …`로 실패하고 두 파일은 남습니다(실행 확인). `index.jsonl`을 심볼릭 링크로 바꿔 둔 run에서는 index를 읽지 못해 막힌 것으로 판정된 뒤(`loadIndexTx` `store.ts:324-333`, `readRalplanPlanningStuck`), `final` 쓰기가 상태를 `final`로 옮기고 단계 파일을 쓴 다음, 원장 덧붙이기가 index를 다시 읽는 곳(`appendJsonlIdempotentTx`, `store.ts:342`)에서 `index.jsonl is not a regular file`로 실패합니다. 원장 행과 `pending-approval.md`는 생기지 않습니다(실행 확인).

### RK39. run 전환과 기록 전용 필드 (기록만)

- **deep-interview로 넘긴 뒤의 쓰기**: 같은 run의 ralplan `write`는 상태를 비활성 `handoff`로 두지만, 행 쓰기가 deep-interview 행을 지우고 ralplan 행을 `handoff_to` 없이 `active: true`로 다시 씁니다(실행 확인). 위쪽 행을 지우는 것은 gjc `removeSupersededPlanningPipelineEntries`와 같습니다(`skill-state/active-state.ts:886-898`).
- **새 `run_id`로 바꿀 때 남는 것**: 지우는 것은 `verdict`, `last_review_verdict*`, `planning_stuck`, `auto_handoff`뿐입니다(`store.ts:523-529`, gjc와 같음). 역할 id, `*_resumable`, `*_fallback_*`, `mode`, `task`, `interactive`, `repository_binding`, `handoff_*`는 남습니다. 그래서 새 run의 영수증에 옛 바인딩이 실리고, 옛 `planner_subagent_id`가 남을 수 있습니다. 넘겨받은 run도 같습니다.
- **기록 전용 필드**: 상태의 `auto_handoff`, `mode`, `interactive`, `task`, 역할 id는 코드가 판단에 쓰지 않습니다. 자동 인계는 index의 `final` 행에서 읽고, `mode`는 `current_phase`가 없을 때의 HUD 단계 대체값으로만 읽습니다(`hud.ts:192-197`). ralplan 설정은 `<open-gajae-runtime-settings>`에 들어가지 않아(`src/config.ts:354-356`, `deepInterview`만) 모델은 `maxIterations` 같은 값을 알 수 없습니다.
- **HUD 칩 6개 상한**: 칩은 목록 순서로 6개에서 잘립니다(`src/skill-state/hud.ts:70,119-125`, gjc `skill-state/active-state.ts:134,189`도 6). 실행 확인: `final` 뒤 architect가 쓰면 행의 칩이 `stage`, `iter`, `stages`, `arch`, `crit`, `verdict`이고 `handoff` 칩이 빠졌습니다.
- **`status`의 `_meta`**: `fields` 없는 `status`는 `state` 안에 StateStore `_meta`를 그대로 담습니다(`store.ts:1274`, 실행 확인). deep-interview `status`는 뺍니다.

### RK40. gjc와의 작은 차이 두 가지 (기록만; 2026-10-04 편차 40·41로 기록)

- **가드의 phase 비교**: 계획 가드는 `current_phase`를 그대로 비교합니다(`src/hooks.ts:753-758`). gjc는 trim·소문자로 맞추고, 상태 phase가 없으면 행 phase를 씁니다(`skill-state/workflow-mutation-guard.ts:273,348`). 손으로 고친 상태(예: `" Architect "`)에서만 차이가 나며, open-gajae는 알 수 없는 phase로 보고 가드를 풉니다. 루트 README ralplan 편차 40.
- **사라진 `final` 파일의 중복 판정**: ``refusing to deduplicate ralplan final stage <N>: stage artifact missing at <path>.``(`store.ts:417-420`)는 open-gajae에만 있습니다. gjc는 파일 읽기 오류를 그대로 던집니다(`gjc-runtime/ralplan-runtime.ts:1787`). 루트 README ralplan 편차 41.

### RK41. 낡은 주석·입력 설명·계획 문구·다른 문서 (고칠 때 같이)

- (해결, 2026-10-04) `src/ralplan-runtime/tool.ts:24-25`: 예전에는 소유하지 않은 agent가 "can see the tool and are refused at run time"(DR-22)이라 적었습니다. 지금은 "agents other than `open-gajae` and the three roles are refused here; `src/hooks.ts` hides it too."입니다(숨김은 `TOOL_OWNERS` `src/hooks.ts:288-298`, `hideTools` `:1129-1135`, `src/index.ts:71-76`).
- (해결, 2026-10-04) `src/ralplan-runtime/manifest.ts:97`: 예전의 "Used by running, …"을 "Used by continuation, the `skill ultragoal` turn gate and the handoff op."으로 고쳤습니다. 쓰는 곳은 `src/ralplan.ts:129`, `src/hooks.ts:810`, `store.ts:1339`입니다.
- (해결, 2026-10-04) `src/hooks.ts:2-3`: 예전의 "the goal loop first, then ralplan"을 "(deep-interview, then the goal loop, then ralplan)"으로 고쳤습니다(`:558-570`).
- (해결, 2026-10-04) `src/hooks.ts:258`: 예전의 "the six owned role subagents from `src/config.ts`"를 "six of the eight owned subagents in `src/config.ts`"로 고쳤습니다(`config.ts:9-21`, `ROLE_SUBAGENTS` `:266-273`). 동작은 그대로입니다. 집합에 없는 `open-gajae-explore`와 `open-gajae-document-specialist`는 첫 검사를 지나 자기 세션의 중단 표시를 풀고, 안내는 받지 않습니다(`:906`).
- (해결, 2026-10-04) 입력 설명: `force`(`tool.ts:157`)는 예전의 "overwrite a corrupt state"에서 "clear: clear even a corrupt or stale state (skips the corrupt, stale and unreadable-row checks)."로 고쳤습니다(`store.ts:1107,1156`). `run_id`(`tool.ts:111`)에는 "not starting with ."을 더했습니다(`safeComponent`, `src/state.ts:204-207`).
- (해결, 2026-10-04) gjc 출처 줄: 루트 README ralplan 편차 20(417행)과 `src/hooks.ts:22`, `src/ralplan-runtime/recovery.ts:13`의 머리 주석은 `renderWorkflowRecoveryContext`를 `session/agent-session.ts:667-710`으로 적었습니다. 함수는 `:667-703`이라(705행부터는 다음 함수의 주석) 세 곳 모두 `:667-703`으로 고쳤습니다.
- 계획 R-OD18(`.omc/plans/ralplan-gjc-stage-trail.md:462`)은 `demoteRalplanForUltragoalEntry({requireActive})`와 트랜잭션 전 검사를 적지만 둘 다 없습니다. 게이트는 트랜잭션 안에서 봅니다(`src/hooks.ts:807-812`). R-OD20(`:464`)은 prompt 훅의 ultragoal seed·복원 안내와 오래된 seed 정리를 적지만 모두 사라졌습니다.
- (해결, 2026-10-04) ultragoal 문서: `docs/skills/ultragoal/entry-and-handoff.md`의 `ralplan handoff` 입력 검사 표는 `to` 스키마를 `z.enum(["ultragoal"])`, 문구를 `to must be "ultragoal"`로 적었고(실제는 두 값, 문구는 `to must be "ultragoal" or "deep-interview"`, `tool.ts:156,297`), 끝의 "코드가 강제하는 것" 표는 넘겨받은 ralplan에서 코드가 `ralplan start`를 허용한다고 적었습니다(지금은 거부, ralplan 편차 39). 같은 문서의 G1 목록과 안내 대상 문단, `goal-loop.md`의 보류 해제 G1, `known-limits.md` U26은 역할 subagent를 다섯으로 적었습니다(`ROLE_SUBAGENTS`는 `open-gajae-lateral-reviewer`를 더한 여섯). 모두 고쳤습니다.
- 쓰이지 않는 코드: `StartRunInput.handoff_from`·`handoff_at`(`store.ts:886-894`, R-O1)을 넘기는 호출이 없습니다. `RalplanNotActiveError`(`store.ts:1295`)는 던지기만 하고 어디서도 구별해 받지 않습니다.
