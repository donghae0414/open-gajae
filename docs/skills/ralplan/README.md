# ralplan 동작 문서

이 폴더는 open-gajae `ralplan`이 **지금 코드에서 어떻게 동작하는지**를 단계별로 적은 문서입니다.

- **기준 코드**: `main` 커밋 `5b92a60`에, 이 문서들과 함께 들어가는 소스 주석·도구 입력 설명 수정(2026-10-04, 코드 동작은 그대로, 줄 수도 그대로)을 더한 것. 코드 위치는 `5b92a60`의 `path:line`으로 적고 그 줄 번호는 수정 뒤에도 맞습니다. 함수·상수 이름을 함께 씁니다. 루트 `README.md`의 줄 번호는 이 폴더를 가리키는 링크 문단이 들어간 현재 파일 기준입니다.
- **참조한 gajae-code(gjc)**: `5c5231418930673e42cc5d08ebe4376e03187533`. gjc 줄 번호는 각 open-gajae 파일의 머리말 주석이 적은 값을 옮긴 것이고, 이 파일을 쓰며 gjc 소스로 다시 확인하지는 않았습니다.
- **호스트**: OpenCode v2.0.15(`opencode/`).

다른 문서와는 이렇게 나뉩니다.

- **정책**: `AGENTS.md`와 루트 `README.md`가 정합니다. ralplan은 README의 "Ralplan" 절(`README.md:115-193`)과 "Deviations from GJC (ralplan)" 절(`README.md:394-454`, 그 안의 "Accepted behavior differences" 표는 `:440-454`)에 있습니다. 이 폴더에서 "ralplan 편차 N"은 그 편차 표의 N번 행입니다. 철회된 번호(14, 15, 16, 18, 19, 24, 25, 27, 28, 29)는 다시 쓰지 않습니다. "deep-interview 편차 N", "ultragoal 편차 N"은 각 skill의 편차 표입니다.
- **결정 기록**: 이식 spec `.omc/specs/deep-interview-ralplan-gjc-stage-trail.md`(끝의 Errata가 본문을 고칩니다), 이식 계획 `.omc/plans/ralplan-gjc-stage-trail.md`(§1.3 `DR-…`, §3.0 `C-…`, §7 편차 초안, §8.1 `R-O…`·`R-OD…`·`R-AE1`·`R-CE1`). 그 뒤 개정은 `.omc/plans/ralplan-ultragoal-gjc-revision.md`과 `.omc/plans/ultragoal-gjc-pq-decisions.md`(`PQ-…`), `.omc/plans/ralplan-deep-interview-gjc-revision.md`과 `.omc/plans/deep-interview-gjc-pq-decisions.md`에 있습니다.
- **이 폴더**: 현재 구현만 적습니다. 결정 ID와 편차 번호는 근거를 찾아갈 수 있게 달아 둡니다. 결정 기록이나 README와 코드가 다르면 코드가 기준입니다.

## ralplan이 하는 일

ralplan은 Planner·Architect·Critic 세 역할 agent가 합의할 때까지 계획을 다듬는 workflow입니다. 단계마다 산출물을 run 폴더에 바뀌지 않는 파일로 남기고 원장 `index.jsonl`에 한 줄씩 적으며, 마지막 계획은 `pending-approval.md`로 둡니다. 사용자가 실행을 승인하기 전에는 계획만 하고, 승인되면 ultragoal로 넘깁니다. gjc의 ralplan skill, 역할 프롬프트, 런타임 계약을 OpenCode 플러그인에 맞게 옮긴 것이고, 키워드 감지와 continuation은 OMC에서 온 것을 유지합니다(continuation은 편차 10, 키워드 감지는 `src/ralplan.ts:141` 머리 주석과 루트 `README.md:121`).

| 구성 | 역할 |
|---|---|
| `ralplan` 도구 (`src/ralplan-runtime/tool.ts`) | op 7개(`start`, `write`, `status`, `doctor`, `state`, `handoff`, `clear`). ralplan 상태, run 폴더의 단계 파일·`index.jsonl`·`pending-approval.md`, ralplan 활성 행과 스냅숏을 바꾸는 길로는 agent가 직접 부르는 유일한 도구입니다. 그 밖에 다른 skill의 인계(ralplan이 callee일 때와 결합 호출의 `startRunTx`)와 훅(continuation 차단기의 `patchStateTx`, `skill ultragoal` 턴 게이트, ultragoal 시드의 ralplan 행 삭제)도 씁니다. `open-gajae`는 모든 op를, 세 역할은 `write`·`status`·`state`만 부를 수 있습니다. |
| 훅 (`src/hooks.ts`, `src/ralplan.ts`) | 키워드·멘션 안내, run 폴더와 `state/` 항상 차단, 계획 가드, 같은 execution의 `skill ultragoal` 턴 게이트, continuation과 차단기, 압축 문맥, 도구 숨김. `src/ralplan.ts`는 키워드 감지, 주입 문구, continuation 판단만 맡는 순수 모듈입니다. |
| SKILL (`skills/ralplan/SKILL.md`) | 모델에게 순서를 지시합니다. `start`, 합의 9단계, 역할 재개, `question`, 승인 질문, Stop here, 넘기기. gjc SKILL 원문에 호스트 치환과, 끝 표(`SKILL.md:226-268`)에 적은 삭제·추가를 했습니다. |
| 역할 agent (`open-gajae-planner`, `open-gajae-architect`, `open-gajae-critic`) | 초안·수정, 구조 리뷰, 계획 리뷰를 하는 subagent. 프롬프트는 `prompts/open-gajae-{planner,architect,critic}.md`(gjc 역할 프롬프트, 편차 33), 등록과 권한 규칙은 `src/config.ts`입니다. |
| 공통 기반 (`src/skill-state/`, `src/state.ts`) | 활성 행과 스냅숏, 보이는 주 skill, 감사 로그, 저널 인계, doctor, 세션 쓰기 큐. deep-interview·ultragoal과 함께 씁니다. |

**코드가 강제하는 것과 SKILL만 요구하는 것은 다릅니다.** 코드는 도구 입력(단계 이름, `stage_n` 1–999, `lane_verdict` 토큰, 역할의 `path` 거부, primary `path`는 OS 임시 파일만), 호출자, 반복 상한과 lane 예산(PLANNING-STUCK), 단계 파일의 불변과 sha256·원장 중복 처리, `disposition` 문서의 스키마·열린 충돌·출처(같은 run의 원장 행), `final`의 `auto_handoff` 판정, `state` op의 phase 전이, 계획 가드, `handoff`의 phase(T)와 `active`를 검사합니다. pass 1의 병렬 리뷰와 pass 2부터의 순차 리뷰, review join gate(같은 회차에 두 lane이 있고 Critic `OKAY`·Architect `CLEAR`인지), 충돌이 있을 때 revision 전에 `disposition`을 쓰는 것(코드는 `disposition`이 들어올 때만 검사합니다), re-review context bundle과 다섯 규칙 ratchet, `question`을 하나씩 묻는 것, 승인 질문, 자동 승인 때 실제로 넘기는 것(코드는 `auto_handoff`를 기록할 뿐 넘기지 않습니다), PLANNING-STUCK인 `final`을 넘기지 않는 것(`ralplan handoff`는 `planning_stuck`을 보지 않습니다), 역할 재개 경로, 영수증만 돌려주기, 회차마다 `stage_n`을 올리는 것, Pre-Execution Gate(`src/`에 구현이 없습니다)는 SKILL과 프롬프트 문구로만 요구합니다. 각 문서는 이 구분을 따로 적습니다.

## 전체 흐름

```
[진입]  안내와 skill 로드 자체는 ralplan 상태를 쓰지 않음 (편차 36)
  "ralplan"·"랄플랜" 키워드, @ralplan 멘션 → [MODE: RALPLAN] 안내만
                                           (open-gajae primary나 agent 없는 세션에게만)
  skill ralplan 로드                     → 턴 표식만
    · 같은 execution에서 deep-interview를 로드했으면 deep-interview 로드 게이트가 먼저:
      interviewing이면 로드 거부, spec을 쓴 인터뷰는 이때 ralplan으로 넘어감 (DR-21)
    · ultragoal이 보이는 주 skill이면 안내 대신 ultragoal handoff 안내, skill 로드는 거부
        │
        ▼
[start]  ralplan start(task, interactive?, deliberate?, run_id?)
         새 상태: active, phase planner, mode short|deliberate, run_id, repository_binding, 활성 행
         (ultragoal 상태가 active거나 ralplan run이 이미 active면 거부, 편차 39)
        │
        ▼
[1 planner]   subagent(open-gajae-planner) → write(planner, 1)
        │
        ▼
[2 intent]    question 하나씩 → write(intent, N)
              계약이 바뀌면 planner 재개 → write(revision, N+1)
        │
        ▼
[3 pass 1]    subagent(open-gajae-architect) ∥ subagent(open-gajae-critic)  (한 메시지에 두 호출)
              → write(architect, N, lane_verdict) · write(critic, N, lane_verdict)
        │
        ▼
[4 join]      충돌이 있으면 write(disposition, N)  (JSON, 출처를 원장 행과 맞춰 봄)
        │  Critic OKAY + Architect CLEAR가 아니면
        ▼
[5 re-review] planner 재개 → write(revision, N+1) → architect 재개 → critic 재개 (순차) → 4로
              opener가 maxIterations(기본 5)를, lane이 반복마다 maxReviewPassesPerLane(기본 1)을
              넘으면 그 write는 파일 없이 PLANNING-STUCK 결과. 예산은 opener·lane에만 걸리므로
              intent·disposition·post-interview·adr·final은 언제나 기록됨
        │  합의
        ▼
[6 post-interview]  question 하나씩 → write(post-interview, N)
        │
        ▼
[7 final]     (write(adr, N)) → write(final, N)
              stage-NN-final.md, 같은 내용의 pending-approval.md, 원장 행·상태의 auto_handoff
              (SKILL 7단계는 ADR을 final 본문에 넣고 adr 단계를 따로 쓰지 않음)
        │
        ▼
[8 승인]
   ├ degradationReason planning_stuck → 넘기지 않음, pending approval로 끝 (SKILL만)
   ├ effectiveTarget ultragoal        → 묻지 않고 9로 (넘기기는 모델이 호출)
   └ off → question: Refine further / Approve execution via ultragoal (Recommended) / Stop here
        │
        ▼
[9]
   ├ 승인: ralplan handoff(to:"ultragoal") → skill ultragoal → ultragoal create
   │       같은 execution에서 skill ralplan을 로드했으면 skill ultragoal 로드가 이 넘기기를 대신함
   │       (그때 ralplan이 계획 중 phase면 로드 거부: RALPLAN_RUNNING_REFUSAL)
   ├ Refine further: 5로. 상태 phase는 잠긴 final에 머물고, 활성 행 phase는 방금 쓴 단계
   ├ Stop here: ralplan state(patch={"active": false}) → phase final 유지, 행 삭제, 파일 유지
   └ 인터뷰로: ralplan handoff(to:"deep-interview") → skill deep-interview → deep-interview write

[실행 내내]
  - 계획 가드: ralplan이 보이는 주 skill이고 상태가 active, phase가 R 밖(final·handoff 포함)이면
    계보의 모든 agent의 write/edit/patch는 대상이 모두 OS 임시 경로일 때만 통과 (shell은 보지 않음)
  - 항상 차단: 세션 폴더의 plans/ralplan/**, state/**는 누구도 write/edit/patch 불가
  - continuation: 루트 execution이 성공으로 끝나면 deep-interview → goal → ralplan 순서로 판단.
    ralplan은 보이는 주 skill이고 active, T 밖, PLANNING-STUCK이 아닐 때 <ralplan-continuation>.
    직전 continuation에서 45분 안에 이어진 31번째 판단이면 차단기: active:false, 행 삭제, 안내 한 번.
    Esc(user·shutdown) 뒤 다음 사용자 프롬프트까지, 자식 세션 execution(백그라운드 subagent 등)이
    도는 동안에는 없음
  - 압축: 상태가 active면 <ralplan-compaction-context> (원장 sha256이 파일과 맞을 때만)

[다른 출구]
  Stop here · ralplan clear(active:false, phase complete, 행 삭제, 파일·run_id 유지)
  · ralplan handoff(ralplan은 inactive handoff, 행은 비활성 handoff_to 행) · 차단기 소진

[다른 skill에서 들어오기]
  deep-interview handoff(to:"ralplan") · deep-interview spec(…, handoff:"ralplan")(먼저 deliberate로 시드)
  · ultragoal handoff(to:"ralplan", reason)
  → 공통 저널 인계: ralplan active, phase planner, handoff_from, 기존 필드(run_id) 유지
  → ralplan start는 거부되므로(편차 39) ralplan write로 이어 감
```

상태 phase는 쓴 단계를 따라 움직이지만, 전이 표(`RALPLAN_TRANSITIONS`, `src/ralplan-runtime/manifest.ts:42-69`)에 없는 간선이어도 `write`는 거부되지 않고 `state/audit.jsonl`에 `invalid_transition_detected` 행만 남습니다(`writeStateTx`, `src/ralplan-runtime/store.ts:193-247`). 위 흐름에서 표에 없는 간선은 pass 1 병렬 기록의 순서(`intent→critic`, `revision→critic`, `critic→architect`), pass 1이 Architect를 마지막으로 끝날 때(`architect→revision`, `architect→post-interview`), pass 2의 시작(`revision→architect`), 7단계의 `post-interview→final`입니다. 다른 skill에서 넘어올 때는 ralplan의 이전 phase가 `planner`가 아닌 manifest 상태면(활성 여부와 상관없이, 예: `final`, `handoff`, `intent`) `<phase>→planner` 행을 남기고, 그 `mutation_id`는 인계의 것입니다. `complete` 같은 manifest 밖 phase와 상태가 없을 때는 남기지 않습니다(`writeHandoffStateTx`, `src/skill-state/handoff.ts:157-201`). 반대로 `ralplan state`의 phase 변경은 표에 없으면 거부됩니다(`patchStateTx`, `store.ts:1001-1079`). 자세한 것은 [stages-and-ledger.md](stages-and-ledger.md)와 [state-and-files.md](state-and-files.md)에 있습니다.

## 문서 목록

| 문서 | 내용 |
|---|---|
| [README.md](README.md) | 이 문서: 하는 일, 구성, 전체 흐름, 코드 지도, 용어 |
| [ops.md](ops.md) | `ralplan` 도구: 등록, 설명문, 입력 스키마, 호출자 검사, 소유 세션, op 7개의 입력·검사 순서·거부 문구·쓰는 파일·감사 verb·결과 |
| [stages-and-ledger.md](stages-and-ledger.md) | 단계 기록 하나의 안(`writeStageTx`): 파일 이름, 정규화와 sha256, `index.jsonl`, 중복과 덮어쓰기 거부, run 전환, phase 전진과 잠금, 전이 감사, 예산과 PLANNING-STUCK, lane verdict, 역할 메타, final 승인 판정, `disposition`, 영수증 |
| [state-and-files.md](state-and-files.md) | 세션 폴더와 파일 표, 쓰기 큐, 상태 파일 모양과 op별 변화, phase 표, 활성 행·스냅숏·보이는 주 skill, HUD 칩, 감사 로그, 저널, doctor, 저장소 바인딩, 설정, continuation 카운터 파일 |
| [entry-and-handoff.md](entry-and-handoff.md) | 키워드와 멘션, 안내 문구, 턴 표식, `skill ralplan` 로드, `start`, deep-interview·ultragoal에서 들어오기, `ralplan handoff`, `skill ultragoal` 턴 게이트, Stop here, 공통 저널 인계, 체인 가드 |
| [guards-and-continuation.md](guards-and-continuation.md) | `execute.before` 순서, 항상 차단, 계획 가드, continuation과 차단기, 중단 표시, 압축 문맥, 도구 숨김과 역할 권한 |
| [roles-and-consensus.md](roles-and-consensus.md) | SKILL 1–9단계와 도구 호출·파일의 대응, 역할 agent 세 개, 재개와 steer, `--interactive`/`--deliberate`, `question`, 승인, Pre-Execution Gate, 두 회차 예시 |
| [known-limits.md](known-limits.md) | 알려진 한계 RK1–RK41 |

## 코드 지도

`src/ralplan-runtime/`:

| 파일 | 맡는 일 | 자세한 문서 |
|---|---|---|
| `manifest.ts` | 순수. 단계 9개(`RALPLAN_STAGES` :20-30), 상태 10개(`RALPLAN_STATES` :34), 전이 표(`RALPLAN_TRANSITIONS` :42-69), phase 잠금(`RALPLAN_PHASE_LOCK` :72-81), T(:99-102), R(:109-116), 알려진 phase(:119-122), `isValidTransition`(:147-152), `advanceCurrentPhase`(:158-166) | state-and-files, stages-and-ledger |
| `tool.ts` | 도구 정의(`ralplanTool` :166-309)와 설명문(:271-272), 입력 스키마(:100-158), 호출자 검사와 소유 세션(`ownerSession` :168-187), `start`의 두 상태 거부(`RALPLAN_ACTIVATION_REFUSAL` :70-71, `ralplanRunActiveRefusal` :73-78), `write`의 입력 검사(:213-266), 기본 설정(`DEFAULT_RALPLAN_SETTINGS` :81-90) | ops |
| `store.ts` | op 함수. 대부분 `tool.ts`가 연 트랜잭션 안에서 읽기 → 검사 → 쓰기를 합니다(`ralplanHandoff`는 자기 트랜잭션을 열고(:1384), `startRunTx`는 deep-interview 결합 호출의 트랜잭션에서도 돕니다). 상태 쓰기와 전이 감사(`writeStateTx` :193-247), 단계 기록(`writeStageTx` :635-880), `startRunTx`(:915-988), `patchStateTx`(:1001-1079), `clearStateTx`(:1140-1189)와 stale 검사(`describeStaleClearTx` :1093-1130), `readStatusTx`(:1267-1283), `doctorTx`(:1286-1288), 넘기기(`ralplanHandoffTx` :1328-1371, `ralplanHandoff` :1378-1394), 턴 게이트 거부 문구(`RALPLAN_RUNNING_REFUSAL` :143-144) | ops, stages-and-ledger, state-and-files, entry-and-handoff |
| `ledger.ts` | 순수. 원장 행과 키(:101-205), 파일 이름(`ralplanStageFileName` :336-338), `parseStageN`(:341-351), 정규화·sha256(:354-361), 반복 세기(`summarizeRalplanIndex` :270-285), 반복 상한(`evaluateRalplanIterationCap` :531-582), lane 예산(`evaluateRalplanReviewLaneBudget` :610-674), PLANNING-STUCK 결과(:703-762), final 승인 판정(`resolveRalplanAutoHandoffTarget` :769-788, `readRalplanPlanningStuck` :870-884), 역할 메타(`parsePersistedRoleState` :931-1013), lane verdict(`parseLaneVerdict` :1035-1053), 영수증(`buildWriteReceipt` :1076-1122, `buildDeduplicatedReceipt` :1128-1171), 설정 기본값과 한도(:47-55) | stages-and-ledger |
| `review-conflicts.ts` | gjc `ralplan-review-conflicts.ts`를 머리말만 바꿔 옮긴 것. `disposition` 문서 검증(`parseReviewConflictDocument` :390-475), 충돌 도출(`detectReviewConflicts` :221-250), join 검사(`evaluateReviewJoinGate` :268-294), 출처 검사(`assertDispositionProvenance` :339-380). 런타임은 `disposition` 기록 때만 부릅니다(`normalizeDispositionArtifact`, `ledger.ts:398-415`). | stages-and-ledger |
| `hud.ts` | 순수. 활성 행의 HUD 칩(`buildRalplanHudSummary` :66-131): 기록 뒤(`buildRalplanHud` :139-182)와 상태 변경 뒤(`buildRalplanHudFromState` :188-210). 그리는 곳은 없습니다(편차 9, R-OD17). | state-and-files |
| `recovery.ts` | 순수. 압축 복구: 상태에서 run 고르기(`ralplanRecoveryRunFromState` :172-185), 최신 `final`(없으면 최신 `planner`·`revision`)을 원장 sha256과 맞춰 투영(`projectRalplanRun` :202-305), 줄로 렌더(`renderRalplanRecoveryContext` :319-349) | guards-and-continuation |
| `binding.ts` | `gjc.repository_binding.v1` 기록(`captureRepositoryBinding` :63-93). `git`을 2초 제한으로 부르고 실패한 값은 빼며, 강제하지 않습니다(편차 12). | state-and-files |
| `temp-paths.ts` | OS 임시 경로 판정(`isNeutralTempPath` :71-87)과 primary의 `path` 읽기(`readTempArtifact` :94-122). 계획 가드 예외와 `write{path}`가 함께 씁니다(DR-11, 편차 30). | ops, guards-and-continuation |

ralplan이 쓰는 공통 기반:

| 파일 | 맡는 일 | 자세한 문서 |
|---|---|---|
| `src/skill-state/handoff.ts` | 세 skill이 함께 쓰는 저널 인계 `handoffWorkflowTx`(:212-322). ralplan은 caller(`ralplan handoff`, 턴 게이트)이자 callee(deep-interview·ultragoal의 `handoff`, 처음 phase `planner`, :76-83)입니다. | entry-and-handoff |
| `src/skill-state/rows.ts` | 활성 행(`syncActiveRowTx` :149-162, 활성 행을 쓰면 위쪽 파이프라인 행을 지움), 인계 행(`writeHandoffRowsTx` :170-184), 스냅숏(`rebuildSnapshotTx` :212-235), 보이는 주 skill(`readVisiblePrimaryTx` :246-292), 순위(`PIPELINE_RANK` :51-55) | state-and-files |
| `src/skill-state/doctor.ts` | 읽기 전용 검사(`collectDoctorSummaryTx` :149-279), 봉투 검사(`workflowEnvelopeError` :64-79, `patchStateTx`도 씀), `modeStatePhase`(:109-119). ralplan `doctor`는 요약 객체를 JSON으로 돌려줍니다. | state-and-files, ops |
| `src/skill-state/audit.ts` | 감사 로그 한 줄(`appendAudit` :37-53), owner 값(:16-17, 편차 21) | state-and-files |
| `src/skill-state/journal.ts`, `hud.ts` | 인계 저널 `state/transactions/<mutation id>.json`(증거일 뿐 재생하지 않음, 편차 13), 칩 도우미와 정규화(`normalizeWorkflowHudSummary` :129-146, DR-9) | state-and-files |
| `src/state.ts` | 세션 폴더, `RalplanTx` 경로(:40-72), 세션마다 쓰기 큐 하나(`workflowTransaction` :476-578, 같은 것의 ralplan 이름 `ralplanTransaction` :581-586), run 폴더 이름 검사(`safeComponent` :204-208), payload 한도(`assertStatePayload` :163-180) | state-and-files |

그 밖에 ralplan이 닿는 곳:

| 파일 | 맡는 일 |
|---|---|
| `src/hooks.ts` | 훅 조립(`createHooks` :352-1304). 키워드·멘션 안내(`prompt` :860-1002), 항상 차단(`guardSessionArtifacts` :689-724), 계획 가드(`guardPlanning` :742-782), 턴 게이트(`ultragoalGate` :796-818), 턴 표식(`turnSkill` :388, `markTurn` :821-825, `onEvent` :1243-1292가 execution 끝마다 지움), continuation(`continueSession` :536-597, `decideRalplan` :474-533, `readBreaker` :449-463), 도구 숨김(`TOOL_OWNERS` :288-298, `hideTools` :1129-1135), 압축 문맥(`compaction` :1194-1241), 계보 루트(`rootSession` :626-658), 차단 문구(:326-327, :334-335) |
| `src/ralplan.ts` | 키워드 감지(`detectRalplanKeyword` :740-747, OMC 감지기를 옮긴 정리·문맥 규칙 :162-732), 안내 문구(`keywordMessage` :66-71, `mentionMessage` :76-81), continuation 판단(`shouldContinue` :121-138)과 문구(`continuationMessage` :46-56, `breakerMessage` :59-64), 차단기 상수(:25-26), 압축 문맥 감싸기(`compactionMessage` :86-93) |
| `src/injection.ts` | 주입 표식(`INJECTION_MARKERS` :17-40; ralplan은 `<ralplan-continuation>`, `<ralplan-notice>`, `<ralplan-compaction-context>`)과 감싸기(`wrapInjected` :47-50). 프롬프트 훅은 표식이 든 텍스트를 무시합니다. |
| `src/tools.ts`, `src/tools/define.ts` | 도구 등록(`createTools` :36-65): `ralplanTool`에 `rootSession`·설정·`projectDir`를 넘기고(:48-52), deep-interview 결합 호출에 `startRunTx`를 주입(:57-63). `defineTool`(:31-51)은 throw를 `Error: …` 결과로 바꿉니다. |
| `src/config.ts` | 설정 `ralplan.*` 검사(:103-135)와 해석(`loadSettings` :159-210, 키별 `source`), 역할 설명(:238-243), 등록(`registerAgents` :344-384), 권한 규칙(`roleRules` :274-328) |
| `src/artifact-guard.ts` | `write`/`edit`/`patch` 경로 추출(`artifactPathsOf` :46), run 폴더 판정(`isRalplanOwned` :130-137), `state/**` 판정(`isSessionState` :145-152) |
| `src/index.ts` | 설정을 setup 때 한 번 읽고(:29), 훅을 먼저 만든 뒤 도구에 `rootSession`을 넘기며(:50-65), 훅을 등록하고(:70-79) 이벤트를 구독(:82-93) |
| `src/deep-interview-runtime/store.ts`, `hooks.ts` | deep-interview → ralplan 넘기기(`deepInterviewHandoffTx` store.ts:599-615), 결합 호출(`specHandoffTx` store.ts:548-561), 로드 게이트(`gateTx` hooks.ts:132-166), ralplan이 보이는 주 skill이면 `deep-interview start` 거부(`otherPrimaryTx` store.ts:218-223), continuation을 먼저 판단(`decideContinuation` hooks.ts:106-117) |
| `src/ultragoal-runtime/store.ts`, `messages.ts` | ultragoal → ralplan 넘기기(`handoffTx` store.ts:1097-1117), 나중 execution의 `skill ultragoal` 시드(`seedUltragoalTx` store.ts:452-503, ralplan 행을 위쪽 파이프라인 행으로 지움), ultragoal이 주 skill일 때의 안내와 체인 거부(`ultragoalHandoffNotice` messages.ts:186, `ultragoalChainRefusal` messages.ts:199) |
| `prompts/open-gajae-{planner,architect,critic}.md` | 역할 프롬프트. 각 파일 끝 "Source and host substitutions" 표가 gjc 원문과 다른 곳을 적습니다. |
| `skills/ralplan/SKILL.md` | 모델용 절차. 끝의 "Source and host substitutions" 표(:226-268)가 gjc 원문과 다른 곳과 편차 번호를 적습니다. |

## 용어

- **stage(단계)**: run 폴더에 파일 하나로 남는 기록의 종류. `planner`, `intent`, `architect`, `critic`, `disposition`, `revision`, `post-interview`, `adr`, `final` 아홉 개입니다(`RALPLAN_STAGES`, `src/ralplan-runtime/manifest.ts:20-30`). 상태 phase는 여기에 `handoff`를 더한 열 개(`RALPLAN_STATES` :34)나 R의 phase입니다.
- **`stage_n`(회차)**: 기록마다 붙이는 1–999 정수(`parseStageN`, `src/ralplan-runtime/ledger.ts:341-351`). 두 자리로 채워 파일 이름 `stage-01-planner.md`에 들어가고(`ralplanStageFileName` :336-338), 같은 `(stage, stage_n)`은 한 번만 기록됩니다. SKILL은 합의 회차마다 올리라고 하지만 코드는 `stage_n`으로 반복을 세지 않습니다(`summarizeRalplanIndex` :270-285). `disposition`만 `stage_n`을 리뷰 영수증과 맞춰 봅니다.
- **opener(여는 단계)**: 반복을 여는 `planner`와 `revision` 기록(`RALPLAN_ITERATION_OPENER_STAGES`, `ledger.ts:75`).
- **iteration(반복)**: 원장에서 opener 행 하나가 반복 하나를 엽니다. opener 앞의 행은 반복 1로 셉니다(`summarizeRalplanIndex` `ledger.ts:270-285`). 반복 상한은 이 수와 디스크의 opener 파일 수 중 큰 값으로 검사합니다(`evaluateRalplanIterationCap` :531-582).
- **lane(리뷰 줄)**: `architect`와 `critic` 각각의 리뷰 기록 줄. 반복 하나에서 lane마다 `ralplan.maxReviewPassesPerLane`번까지 씁니다(`evaluateRalplanReviewLaneBudget` :610-674). lane verdict는 architect `CLEAR`/`WATCH`/`BLOCK`, critic `OKAY`/`ITERATE`/`REJECT`입니다(`LANE_VERDICTS` :80-83).
- **run, `run_id`(run 폴더)**: 한 계획의 기록 묶음, `plans/ralplan/<run_id>/`. `run_id`는 명시한 값 → 상태의 `run_id` → 소유 세션 ID 순으로 정합니다(`writeStageTx` `src/ralplan-runtime/store.ts:643`, `startRunTx` :925). 이름은 1–64자 `A-Z a-z 0-9 . _ -`이고 `.`로 시작하거나 `..`를 담을 수 없습니다(`safeComponent`, `src/state.ts:204-208`). 반복 상한과 lane 예산은 run마다 따로 셉니다.
- **소유 세션 = 계보 루트(lineage root)**: 호출 세션에서 `parentID`를 따라 올라가 만나는 부모 없는 세션(`rootSession`, `src/hooks.ts:626-658`; 조회에 실패하면 거부). `ralplan` 도구의 모든 op는 이 세션의 폴더에 씁니다(`ownerSession`, `src/ralplan-runtime/tool.ts:168-187`). 역할 subagent의 기록도 루트 세션의 run에 들어갑니다(편차 32).
- **보이는 주 skill(visible primary)**: 활성 행 파일과 스냅숏에서 고른 하나(`readVisiblePrimaryTx`, `src/skill-state/rows.ts:246-292`). active인 행만 보고, ralplan 행의 phase는 상태 phase가 잠겨 있으면 그 phase로 바꿔 읽으며, 순위는 ultragoal > ralplan > deep-interview입니다(`PIPELINE_RANK` :51-55).
- **T(terminal phases)**: `final`, `handoff`, `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`(`TERMINAL_PHASES`, `manifest.ts:99-102`; gjc `tools/skill.ts:42` ∪ ralplan `terminalStates`, 계획 C-2, R-CE1). continuation 판단(`src/ralplan.ts:129`), 턴 게이트(`src/hooks.ts:810`), `ralplan handoff`(`store.ts:1339`)가 씁니다. 이 문서는 T 밖의 phase를 "계획 중 phase"라고 부릅니다.
- **R(guard release phases)**: `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`(`GUARD_RELEASE_PHASES`, `manifest.ts:109-116`; gjc 기본 `stopReleasingPhases`). 계획 가드는 이 phase에서만 풀리므로 active인 `final`·`handoff`는 계속 막힙니다(R-O10). `force` 없는 `clear`는 상태 phase가 `inactive`가 아닌 R이면 이미 끝났다고 보고 거부합니다(`store.ts:1098`).
- **known phases(알려진 phase)**: 상태 열 개 ∪ R(`KNOWN_PHASES`, `manifest.ts:119-122`, 계획 C-3). 이 밖의 phase(예: OMC 옛 형식 `"ralplan"`)가 적힌 상태는 가드·continuation·게이트가 읽을 수 없는 상태로 다룹니다. 계획 가드는 풀리고, continuation과 압축 문맥은 없으며, 턴 게이트는 통과하고, doctor는 `schema_violation`을 보고합니다(DR-21). 그래도 `ralplan start`는 `active: true`만 보므로 거부하고, `ralplan state(patch={"active": false})`는 그 phase가 manifest 상태가 아니라서 `unknown ralplan phase "…"`로 거부됩니다. 이런 상태는 `ralplan clear`로 정리합니다.
- **phase lock(잠긴 phase)**: `final`, `handoff`, `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`(`RALPLAN_PHASE_LOCK`, `manifest.ts:72-81`; gjc `phaseLock`). 같은 run의 `write`는 잠긴 phase와 `active`를 바꾸지 않습니다(`advanceCurrentPhase` :158-166, `persistActiveRunIdTx` `store.ts:513-545`, DR-3, R-OD9). 역할 메타, lane verdict, final 승인 판정 필드는 여전히 씁니다. 원소는 T와 같지만 출처와 쓰임이 다릅니다.
- **turn marker(턴 표식)**: 이번 execution에서 로드한 workflow skill 이름(`turnSkill`, `src/hooks.ts:388`). 메모리에만 있습니다. 가드를 통과한 `skill` 호출이나 `@<skill>` 멘션이 세우고(`markTurn` :821-825), 실패한 `skill` 호출은 되돌리며(`executeAfter` :1105-1122), execution이 끝날 때마다 지웁니다(`onEvent` :1243-1292). 턴 표식이 `ralplan`일 때만 `skill ultragoal` 로드가 ralplan을 넘깁니다.
- **receipt(영수증)**: `write`가 돌려주는 JSON. `session_id`, `run_id`, `path`, `stage`, `stage_n`, `sha256`, `repository_binding`, `created_at`에 경우에 따라 `pending_approval_path`, `<role>_state`, `review_budget_warning`, `lane_verdict`, `auto_handoff`가 붙습니다(`buildWriteReceipt`, `ledger.ts:1076-1122`). 같은 내용을 다시 쓰면 `deduplicated: true`가 붙은 영수증이 돌아옵니다(`buildDeduplicatedReceipt` :1128-1171). SKILL은 역할이 본문 대신 영수증만 돌려주라고 합니다(RECEIPT-ONLY, `skills/ralplan/SKILL.md:55`). `start`의 요약, `handoff`의 인계 영수증, `state` 뒤 활성 행의 `receipt` 필드(`stateWriteReceipt`, `store.ts:295-313`)도 영수증이라 부르지만 모양이 다릅니다.
- **PLANNING-STUCK**: 반복 상한이나 lane 예산을 넘는 `write`의 결과. 오류가 아니라 `ok: false`, `planning_stuck: true`, `marker: "PLANNING-STUCK"`이 든 결과로 돌아오고(`buildPlanningStuckResult` `ledger.ts:703-730`, `buildLaneBudgetStuckResult` :732-762), 단계 파일은 쓰지 않습니다. 원장에 막힘 행을 run마다 한 번 남기고, 같은 run의 상태에 `planning_stuck: {marker, reason}`을 적습니다(`recordPlanningStuckTx`, `store.ts:568-591`). 그 뒤 continuation은 멈추고, 그 run의 `final`은 `auto_handoff`를 `off`(`degradationReason: "planning_stuck"`)로 정합니다. final 판정에서는 원장을 읽을 수 없거나 깨진 줄이 있어도 막힌 것으로 칩니다(`readRalplanPlanningStuck` :870-884).

## 유지 규칙

- 코드가 바뀌면 같은 커밋에서 해당 문서도 고치고, 이 파일 머리의 기준 커밋을 갱신합니다.
- 문서와 코드가 다르면 코드가 기준입니다. 차이를 찾으면 문서를 고치거나 [known-limits.md](known-limits.md)에 적습니다.
