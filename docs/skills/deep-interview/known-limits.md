# 알려진 한계

이 문서는 deep-interview에 남아 있는 한계를 모읍니다. 기준 코드는 [README.md](README.md) 머리에 있습니다.

- **출처**: spec `.omc/specs/deep-interview-deep-interview-gjc-revision.md`의 "Known consequences"(K1–K4)와 계획 `.omc/plans/ralplan-deep-interview-gjc-revision.md` S4의 known-limits 목록(K5–K17), 그리고 2026-10-03 리뷰에서 더한 K18–K19. 번호는 그대로 씁니다.
- **번호 없는 항목**: 번호 목록 밖에서 이 문서를 쓰며 정리한 것은 맨 끝 "그 밖의 한계"에 둡니다.
- **gjc와 같음**: 표시한 항목은 gjc에서도 같은 결과가 나는 것입니다.
- 근거의 테스트 ID: RT1–RT13은 `tests/deep-interview-runtime.test.ts`, T1–T10은 `tests/deep-interview-tool.test.ts`, H1–H9는 `tests/hooks.test.ts`, RP1–RP5는 `tests/ralplan-tool.test.ts`. T11–T12와 H9는 2026-10-03 리뷰에서 더했습니다.

## 한눈에 보기

| K | 한계 | 근거 | 할 일 |
|---|---|---|---|
| K1 | 이전 execution에서 로드한 deep-interview에는 로드 게이트가 없다. 다음 skill을 시작하면 deep-interview 행만 지워지고 상태는 활성으로 남는다 (gjc와 같음) | 턴 표식은 execution 끝에 지워짐(`src/hooks.ts:1264`), 활성 행 쓰기가 위쪽 행을 지움(`src/skill-state/rows.ts:149-162`); H3, T8 | `deep-interview clear`로 정리(`force` 불필요) |
| K2 | 스펙 뒤 "더 다듬기"는 phase `handoff`에 머문다. continuation은 없고(`interviewing` 전용), 편집 가드와 goal continuation 건너뛰기는 유지된다 | `decideContinuation`(`src/deep-interview-runtime/hooks.ts:106-117`), 가드 phase(`manifest.ts:64`); spec E1; H1, H2 | 기록만. 다듬은 뒤 다시 `spec` |
| K3 | 라운드 기록은 모델이 쓴다. 실제 `question` 주고받기와 같은지 검사하지 않는다 | 기록기 없음(deep-interview 편차 3), spec D-RS1 | 기록만 |
| K4 | 활성 행과 HUD 칩은 계산해 기록만 하고 그리지 않는다 | TUI 플러그인 없음(deep-interview 편차 23, R-OD17); spec D-HL1 | 기록만. 진행은 `deep-interview status`로 봄 |
| K5 | deep-interview 동안에도 goal 문맥 주입은 계속된다 (gjc와 같음) | `context` 훅(`src/hooks.ts:1146-1180`)은 deep-interview를 보지 않음 | 기록만 |
| K6 | 1 MiB / 깊이 10 / 최상위 키 100 한도. 아주 긴 인터뷰의 `write`가 실패하고 파일은 그대로 남는다 | `assertStatePayload`(`src/state.ts:163-166`)를 쓰기 전에 부름(계획 DR-31), deep-interview 편차 34 | 요약해서 줄이거나(DIPP-7) 스펙으로 넘어감 |
| K7 | 결합 호출, `handoff(to:"ralplan")`, ralplan ↔ deep-interview 왕복은 기존 ralplan `run_id`를 다시 쓴다(옛 run 폴더, 반복 예산, `stage_n`이 이어짐). `handoff(to:"ralplan")`으로 넘겨받은 run은 옛 `task`를 지킨다 | `startRunTx`의 `run_id`(`src/ralplan-runtime/store.ts:925`), 인계의 필드 유지 병합(`src/skill-state/handoff.ts:230-240`); PQ-23 A, PQ-2 A; T5 | 새 run 폴더가 필요하면 첫 `ralplan write`에 새 `run_id` |
| K8 | 라운드 필드는 모델이 쓴다. 모양은 검사하지만 내용은 검사하지 않는다 | `roundRecordErrors`(`manifest.ts:266-288`), deep-interview 편차 36; RT13 | 기록만 |
| K9 | doctor의 낡은 행 안내는 `deep-interview clear`인데, 상태가 이미 `complete`인 낡은 행은 `clear(force: true)`가 필요하다 | doctor 안내(`src/skill-state/doctor.ts:166-167`), 낡음 판정(`store.ts:757-777`); spec E3 | `clear(force: true)` |
| K10 | `spec(path)`: 경로 오타는 스펙 본문으로 저장된다. 디렉터리 경로도 그렇다. 프로젝트 밖 파일도 호스트 권한 확인 없이 읽는다 (gjc와 같음) | `resolveSpecContent`(`store.ts:439-450`); PQ-6 A; T4 | 되도록 `content`로 넘기고, `path`를 쓰면 결과 파일을 확인 |
| K11 | 결합 호출의 뒤 단계가 실패하면 앞 단계의 결과가 남는다 | `specHandoffTx`(`store.ts:548-561`); PQ-18 A, DR-29; T5 | `status`로 확인하고 `deep-interview handoff(to:"ralplan")` |
| K12 | 결합 호출은 `ralplan start`의 ultragoal 거부를 거치지 않는다. ultragoal이 활성이면 ultragoal이 계속 보이는 주 skill이라 `skill ralplan`이 체인 가드에 막히고, `ultragoal handoff(to:"ralplan")`가 `handoff_from`을 바꾼다 | 시드가 `startRunTx`를 직접 부름(`src/tools.ts:61-62`), 순위(`rows.ts:51-55`); PQ-18 A | 기록만 (gjc와 같음) |
| K13 | `write`는 `spec_*`를 바꿀 수 있고 `state`는 거부한다. 값이 실제 스펙과 어긋나면 넘기기가 거부된다 | 정리기가 `spec_*`를 지우지 않음(`envelope.ts:222-236`), `statePatchFieldError`(`manifest.ts:164-178`), `verifySpecTx`(`store.ts:572-592`); PQ-14 A; T6 | 다시 `spec` |
| K14 | (해결) `ralplan start`가 활성 run을 거부하므로 게이트 넘기기 뒤 다시 시드되지 않는다. 옛 `task`는 남는다(K7) | `ralplanRunActiveRefusal`(`src/ralplan-runtime/tool.ts:73-78,197-198`); 관리자 답 K14 C, DR-39; RP3, RP4 | 없음 |
| K15 | 같은 execution에서 로드한, 유효한 스펙을 가진 끝난 인터뷰는 이미 활성인 ralplan·ultragoal에도 연결되어 그것을 시작 phase(`planner`/`goal-planning`)로 되돌린다. ultragoal은 `create`까지 제품 편집을 거부하고, `create`는 `goals.json`을 덮어쓰며, 열린 goal은 계속 재촉한다 | `gateTx` release 분기(`src/deep-interview-runtime/hooks.ts:147-162`), 인계의 시작 phase(`handoff.ts:230-239`); PQ-36 C; H3 | 받아들인 결과(PQ-36 C). 피하려면 다음 skill을 새 execution에서 로드 |
| K16 | 설정 최상위 key 검사에는 자동 테스트가 없다 | `src/config.ts:86`; PQ-39 A | 기록만 |
| K17 | `write(reset)`은 빈 기준에서 다시 만들어 기준치·`spec_*`·`handoff_*`를 지운다. reset 입력에 `threshold`·`threshold_source`가 없으면 HUD와 압축 문맥에서 기준치가 사라진다 | `writeTx`의 `reset`(`store.ts:380`); PQ-13 A; T3 | reset 입력의 `state`에 기준치 두 필드를 넣음 |
| K18 | 열린 goal이 있으면 인터뷰 취소 직후 goal continuation이 턴을 맡는다 (gjc와 같음) | 취소된 인터뷰는 deep-interview 판단이 `none`이라 goal 경로가 돎(`src/hooks.ts:558-585`); ultragoal에서 넘겨받은 인터뷰는 goal을 활성으로 남김(D-HL8); 관리자 결정(2026-10-03); H9 | Esc는 다음 프롬프트까지 멈추고, `goal drop`은 goal을 끝냄 |
| K19 | 스펙 뒤(phase `handoff`, Phase 5·"더 다듬기")의 취소는 재개할 수 없다. SKILL은 이때 `deep-interview clear`("여기서 마치기"와 같음)를 부르고 스펙 파일은 남는다 | 재개는 비활성 `interviewing`만 받음(`store.ts:200-215`); 비활성 `handoff`는 넘겨준 인터뷰와 구별되지 않음(인계가 옛 `handoff_to`를 남김); 관리자 결정(2026-10-03); T12 | 스펙으로 ralplan·ultragoal에 가려면 Phase 5에서 고름. 취소 뒤에는 새 `start` |

## 항목별 설명

### K1. 이전 execution의 deep-interview와 지워지는 행

- **흐름**: 로드 게이트는 이번 execution에서 deep-interview를 로드했을 때(턴 표식)만 돕니다. 표식은 execution이 끝날 때마다 지워지므로, 앞 턴에 인터뷰를 하다가 다음 턴에 `skill ralplan`을 로드하면 게이트 없이 로드됩니다([entry-and-handoff.md](entry-and-handoff.md)).
- **행이 지워짐**: 이어서 `ralplan start`(또는 `skill ultragoal`의 시드, ultragoal reconcile)가 자기 활성 행을 쓰면, 공통 `syncActiveRowTx`가 위쪽 파이프라인 행인 deep-interview 행을 지웁니다. deep-interview 상태는 활성 `interviewing`(또는 `handoff`)으로 남습니다.
- **결과**: deep-interview는 보이는 주 skill이 아니게 되어 편집 가드, continuation, 압축 문맥이 멈춥니다. `deep-interview status`는 여전히 활성을 보여 줍니다. 그 skill이 끝나 행이 사라져도 deep-interview 행은 돌아오지 않습니다(다음 deep-interview op가 행을 다시 쓸 때까지).
- **정리**: `deep-interview clear`. 행이 없어 낡음 판정에 걸리지 않으므로 `force` 없이 됩니다(T8). gjc도 같습니다(spec D-SH4).

### K2. phase `handoff`에서 다듬기

- Phase 5 "Refine further"는 phase `handoff`에 머문 채 라운드를 이어 갑니다(spec Errata E1). `write`는 phase를 바꾸지 않고, `state` op로 `handoff → interviewing`은 전이 표에 없어 거부됩니다.
- 그동안 continuation은 `hold`입니다. 모델이 턴을 끝내면 다시 밀지 않고, goal·ralplan continuation도 건너뜁니다.
- 편집 가드는 유지됩니다. 다 다듬으면 다시 `spec`(같은 slug면 덮어씀)한 뒤 Phase 5로 돌아갑니다.

### K3, K8. 모델이 쓰는 라운드

- open-gajae에는 gjc의 `ask` 메타데이터와 라운드 기록기가 없습니다(deep-interview 편차 3). 모델이 `write`로 `question_text`, `answer`, 점수, `ambiguity`를 직접 씁니다.
- 런타임은 필수 필드가 있고 범위가 맞는지만 봅니다(deep-interview 편차 36). 질문을 실제로 `question`으로 했는지, 답을 그대로 옮겼는지, 점수가 SKILL의 가중치 공식과 맞는지는 모릅니다.

### K4. 행과 칩은 그리지 않음

- 활성 행 `state/active/deep-interview.json`의 `hud` 칩은 상태가 바뀔 때마다 계산해 기록하지만, 화면에 그리는 TUI 플러그인이 없습니다(deep-interview 편차 23). ralplan·ultragoal과 같고, 배포된 OpenCode 2.0.15 바이너리의 TUI 플러그인 import 문제로 ralplan 사이드바도 제거됐습니다(R-OD17).
- 칩의 모양은 [state-and-files.md](state-and-files.md)의 HUD 절에 있습니다.

### K5. goal 문맥

- 활성 goal이 있으면 루트 `open-gajae` 요청마다 goal 문맥이 들어갑니다(goal마다 한 번, 압축 뒤 다시). deep-interview가 `hold`로 멈추는 것은 goal **continuation**뿐이고 문맥 주입은 아닙니다.
- gjc도 deep-interview 중 goal 문맥을 주입합니다(계획 R8). 인터뷰 중 모델이 goal 쪽 일을 하도록 끌릴 수 있습니다.

### K6. StateStore 한도

- 검사는 `start`, `write`, `spec`, `state`의 결과 봉투와 인계의 두 상태에 첫 쓰기 전에 걸립니다. 그래서 실패해도 파일, 감사 로그, 행이 그대로입니다.
- 한 번의 `write` 입력은 100,000자 상한이 먼저이므로, 1 MiB는 라운드와 `ontology_snapshots` 같은 배열이 쌓이면서 걸립니다. 깊이는 `state` 안에서 8단계까지입니다([state-and-files.md](state-and-files.md)).
- 할 일: SKILL DIPP-7대로 큰 문맥을 요약해 넣고, 오래된 스냅숏이나 큰 필드를 `null`로 지우거나(최상위·`state` 안의 `null`은 삭제), 요약으로 `write(reset)`(K17 주의)하거나, 스펙으로 넘어갑니다.

### K7. ralplan `run_id`와 `task`가 이어짐

- **결합 호출**: `startRunTx`가 `run_id`를 받지 않으므로 기존 ralplan 상태의 `run_id`, 없으면 루트 세션 id를 씁니다. 옛 run 폴더의 단계 파일, 반복 예산, `stage_n`이 이어집니다. `task`는 새 스펙 경로로 바뀝니다.
- **`handoff(to:"ralplan")`·로드 게이트**: 공통 인계가 기존 ralplan 상태 위에 병합하므로 `run_id`, `task`, `mode`, `repository_binding`이 남습니다. 옛 `task`는 이전 계획 과제 그대로이고, 새 스펙 경로는 결과 줄(게이트에서는 `deep-interview status`의 `spec_path`)로만 전해집니다. 이전 ralplan 상태가 없으면 `run_id`·`task` 없이 `planner`만 생기고, `ralplan write`가 루트 세션 id를 run 폴더로 씁니다.
- **왕복**: ralplan → deep-interview → ralplan으로 돌아와도 같은 run을 이어 씁니다.
- gjc도 같습니다(PQ-23 A, PQ-2 A). 새 예산이 필요하면 첫 `ralplan write`에 새 `run_id`를 줄 수 있습니다(ralplan SKILL의 ultragoal 인계 문장과 같은 방법. deep-interview 인계용 문장은 PQ-40 A에 따라 두지 않음).

### K9. 이미 `complete`인 상태의 낡은 행

- 예: 상태가 `{active: false, current_phase: "complete"}`인데 활성 행이 남은 경우. doctor는 `stale_active_state`로 보고하고 고치는 명령을 `deep-interview clear`로 적습니다.
- 그러나 `force` 없는 `clear`는 phase `complete`를 보고 `existing state for deep-interview is stale (mode-state is already terminal (complete)); use force: true to clear`로 거부합니다. `clear(force: true)`가 행을 지웁니다. doctor 안내 규칙은 세 skill 공통이고(spec Errata E3), gjc도 같습니다.

### K10. `spec(path)`

- 경로를 `stat`해 일반 파일이면 읽고, 없거나(`ENOENT`, `ENOTDIR`, `ENAMETOOLONG`) 일반 파일이 아니면 **경로 문자열 자체**를 본문으로 씁니다. 예: `path: "spec-sorc.md"` → 스펙 파일 내용이 `spec-sorc.md` 한 줄.
- 프로젝트 밖 절대 경로도 도구가 직접 읽습니다. 호스트의 read 권한을 거치지 않습니다. 읽기는 세션 쓰기 큐 밖에서 합니다.
- SKILL은 `content`를 먼저 쓰고, 너무 크면 OS 임시 디렉터리에 써서 `path`로 넘기며 경로를 확인하라고 합니다.

### K11. 결합 호출의 부분 결과

- ① 스펙 저장이 실패하면 아무것도 쓰지 않습니다. ② ralplan 시드가 실패하면 스펙, index, deep-interview 활성 `handoff` 상태와 행이 남습니다. ③ 넘기기가 실패하면 그에 더해 ralplan `planner` 상태(`handoff_from` 없음)와 그 행이 남고, deep-interview 행은 ②가 지운 채입니다.
- SKILL Phase 5b대로 `deep-interview status`와 `ralplan status`를 보고 `deep-interview handoff(to:"ralplan")`로 이어 갑니다. ②가 손상된 ralplan 상태 때문에 실패했다면 그 상태부터 고쳐야 합니다([ops.md](ops.md)).

### K12. 결합 호출과 활성 ultragoal

- `ralplan start` op는 활성 ultragoal과 활성 ralplan run을 거부하지만, 이 확인은 도구에만 있습니다. 결합 호출은 `startRunTx`를 직접 불러 둘 다 거치지 않습니다(gjc `gjc ralplan --deliberate` 시드와 같음).
- ultragoal이 활성이고 행이 있으면, 결합 호출 뒤에도 ultragoal(순위 2)이 ralplan(순위 1)보다 위라서 보이는 주 skill로 남습니다. 결과 줄대로 `skill ralplan`을 로드하면 체인 가드가 거부하고 `ultragoal handoff(to: "ralplan", reason)`을 안내합니다. 그 넘기기는 ralplan의 `handoff_from`을 `"ultragoal"`로 바꿉니다.
- 진행 중인 ralplan run도 같은 `run_id`로 다시 시드됩니다(phase `planner`, 넘겨받은 필드는 새 상태에 없음).

### K13. `write`와 `spec_*`

- `write` 정리기는 gjc 목록의 런타임 소유 키 9개만 지우므로(PQ-14 A) 최상위 `spec_path`, `spec_sha256` 등을 바꿀 수 있습니다. `state` op는 같은 필드를 거부합니다(spec D-SR9).
- 바뀐 값이 실제 파일과 맞지 않으면 넘기기의 스펙 확인이 `… is not in this session's specs/`, `… is missing`, `… does not match spec_sha256 …`로 거부합니다. 다시 `spec`하면 맞춰집니다.

### K14. (해결) 게이트 넘기기 뒤 `ralplan start`

- 예전에는 결과 줄이 없는 게이트 넘기기 뒤 모델이 `ralplan start`를 부르면 같은 `run_id`로 다시 시드되어 `handoff_from`이 빠졌습니다. 지금은 `ralplan start`가 상태 파일이 `active: true`인 run을 거부합니다(계획 DR-39, ralplan 편차 39).
- 남는 것은 옛 `task`(K7)입니다.
- 이전 ralplan 상태 없이 넘겨받은 run은 `run_id`가 없어 거부 문구가 `ralplan run (none) is already active (phase planner, handed over from deep-interview); …`로 나옵니다.

### K15. 끝난 인터뷰가 활성 callee를 되돌림

- 로드 게이트는 release phase 인터뷰에 유효한 스펙이 있으면 callee가 이미 활성이어도 공통 인계로 연결합니다(PQ-36 C). 공통 인계는 callee를 늘 시작 phase로 씁니다.
- **ralplan**: 예를 들어 `architect`에서 `planner`로 돌아갑니다. `run_id`와 단계 파일은 남고, ralplan 감사에 `invalid_transition_detected`(`architect` → `planner`)가 먼저 남습니다(H3).
- **ultragoal**: `goal-planning`으로 돌아가 `create`까지 제품 `write`/`edit`/`patch`가 거부되고, SKILL 안내대로 `create`를 부르면 `goals.json`을 덮어씁니다(원장과 `progress.txt`는 남음). 열린 goal은 그대로라 goal continuation이 계속 재촉합니다.
- **ultragoal 쪽 조건**: ultragoal이 보이는 주 skill인 동안에는 체인 가드가 `skill deep-interview`를 거부하고, `@deep-interview` 멘션은 ultragoal 인계 안내만 받아 턴 표식이 서지 않습니다. 그래서 ultragoal 경우는 ultragoal 상태는 활성인데 그 행이 없어진 상태에서만 생깁니다(H3는 행을 손으로 지워 재현).
- 이미 활성인 callee를 되돌리는 것은 연결만이 아니라 deep-interview → callee의 모든 넘기기(`handoff` op, 게이트의 활성 `handoff`)가 같습니다. 결합 호출은 시드가 먼저 다시 시드합니다.
- 관리자가 이 영향을 알고 유지했습니다(PQ-36 재확인). 피하려면 끝난 인터뷰 뒤 다음 skill은 새 execution에서 로드합니다(턴 표식이 없으면 게이트가 돌지 않음).

### K16. 설정 최상위 key 검사

- `loadSettings`는 최상위 key를 `deepInterview`, `agents`, `ralplan`으로 제한하고 그 밖은 `<file>.<key>: unknown setting`으로 로드를 실패시킵니다(`src/config.ts:86`). 이 최상위 사례에는 자동 테스트가 없습니다. 이름공간 안의 사례(`tests/integration.test.ts:115`의 `agents.explore`, `:312`의 `ralplan.receipts`)만 있습니다(PQ-39 A).
- 이 문서를 쓰며 bun으로 `{"unknownTop": {}}`가 `<project>/.open-gajae/open-gajae.jsonc.unknownTop: unknown setting`으로 실패하는 것을 확인했습니다. 없앤 라운드 상한 key도 `deepInterview` 안의 모르는 key라 같은 방식으로 실패합니다.

### K17. `write(reset)`이 지우는 것

- `reset`은 빈 기준 위에 입력만으로 봉투를 다시 만듭니다(gjc와 같음, PQ-13 A). `threshold`, `threshold_source`, `spec_*`, `handoff_*`(`handoff_from` 포함)가 사라지고 phase는 `interviewing`입니다. 이전 `current_ambiguity`도 이어지지 않습니다.
- 입력에 기준치가 없으면 HUD `ambiguity` 칩에서 기준치가 빠지고(현재 값도 없으면 칩 자체가 없음), 압축 문맥은 `ambiguity: unknown (threshold unknown)`처럼 적습니다.
- SKILL Step 2e는 reset 입력의 `state`에 `threshold`·`threshold_source`를 넣으라고 합니다. 스펙을 이미 썼다면 `reset` 뒤 다시 `spec`해야 넘길 수 있습니다.

### K18. 취소 뒤의 goal continuation

- ultragoal → deep-interview 인계는 goal을 그대로 둡니다(D-HL8). 인터뷰가 `interviewing`이나 `handoff`에 활성인 동안에는 deep-interview 판단이 goal 경로를 막습니다(deep-interview 편차 16).
- 사용자가 "그만"이라고 하고 모델이 `state(patch={"active": false})`로 취소하면 deep-interview 판단이 `none`이 되어, 그 턴이 끝날 때 `<goal-continuation>`이 들어옵니다. gjc도 deep-interview가 해당 없으면 goal 경로를 돌립니다(`session/agent-session.ts:21137-21211`).
- 관리자가 gjc와 같게 두기로 했습니다(2026-10-03). 사용자가 다 멈추려면 Esc(다음 진짜 프롬프트까지 continuation 없음), 실행을 끝내려면 `open-gajae`에서 `goal drop`입니다. `goal pause`는 blocker 분류와 critic 판정이 있어야 해서 이 용도로 쓸 수 없습니다.

### K19. 스펙 뒤의 취소

- 재개는 비활성 `interviewing`만 받습니다. 스펙을 쓴 뒤의 비활성 `handoff`는 ralplan·ultragoal로 넘겨준 인터뷰와 같은 모양이라(인계가 옛 `handoff_to`를 남기므로 그 필드로 구별할 수 없음) 재개하지 않습니다.
- 그래서 SKILL은 스펙 뒤의 hard cancel을 `deep-interview clear`로 처리합니다. Phase 5 "여기서 마치기"와 같고, 스펙 파일과 index는 남습니다(관리자 결정, 2026-10-03).
- 같은 execution에서 `skill ralplan`·`skill ultragoal`을 로드하면 로드 게이트가 끝난 인터뷰의 유효한 스펙을 연결합니다(K15). 다음 execution부터는 새 `start`가 필요합니다.

## 그 밖의 한계

### 기준치 gate는 SKILL의 판단

- SKILL은 모호도가 기준치 이하이고 closure·restate gate를 지난 뒤에만 스펙을 쓰라고 합니다(DIPP-9, Phase 4). 조기 종료(3라운드부터 경고와 함께)와 100라운드 상한도 SKILL의 규칙입니다. 보통 라운드 뒤에 계속할지 묻지 않고 다음 질문으로 가는 것(`skills/deep-interview/SKILL.md:544`)과, Phase 5의 ultragoal 선택지를 이미 구현 준비가 된 아주 단순한 스펙에만 권하는 것(`:737`)도 SKILL의 규칙입니다. `handoff(to: "ultragoal")`는 활성 인터뷰, phase `handoff`, 스펙 sha256만 봅니다(deep-interview 편차 5).
- gjc에서 물려받은 고정 종료 문장 둘("All dimensions at 0.9+: Skip to spec generation", 해석 표의 "0.0 - 0.1 … Proceed immediately")은 이 규칙과 충돌해 지웠습니다(deep-interview 편차 39). 두 공식의 가중치 합이 1.0이라 모든 점수가 0.9면 모호도가 10%로, 기본 기준치 5%보다 큽니다.
- `spec`(`store.ts:471-534`)은 활성 상태만 요구하고 `current_ambiguity`와 `threshold`를 비교하지 않습니다. 넘기기도 phase와 스펙 sha256만 봅니다. gjc에도 코드 gate가 없습니다.
