# ultragoal 동작 문서

이 폴더는 open-gajae `ultragoal`이 **지금 코드에서 어떻게 동작하는지**를 단계별로 적은 문서입니다. 기준은 브랜치 `feat/ultragoal-gjc-revision`의 커밋 `9b5d4f9`이고, 참조한 gajae-code(gjc)는 `5c5231418930673e42cc5d08ebe4376e03187533`입니다. 2026-10-02 deep-interview gjc 개정(브랜치 `feat/deep-interview-gjc-revision`)이 바꾼 곳(deep-interview와의 인계, 진입 게이트, 상태 도구 삭제, 이어가기 순서, `ralplan start` 거부)은 그 브랜치 기준으로 고쳤습니다. open-gajae 코드 위치는 파일과 함수·상수 이름으로 가리키고 줄 번호는 적지 않습니다. gjc와 OpenCode 호스트 코드는 고정 커밋 기준 줄 번호로 가리킬 때가 있습니다.

다른 문서와는 이렇게 나뉩니다.

- **정책**: `AGENTS.md`와 `docs/development.md`가 정합니다. GJC와 다른 점은 `docs/development.md`의 "GJC로부터의 deviation (ultragoal)" 표에 있고, 알려진 동작은 [known-limits.md](known-limits.md)에 있습니다.
- **결정 기록**: spec `.omc/specs/deep-interview-ultragoal-gjc-revision.md`, 계획 `.omc/plans/ralplan-ultragoal-gjc-revision.md`, 결정 모음 `.omc/plans/ultragoal-gjc-pq-decisions.md`에 있습니다.
- **이 폴더**: 현재 구현만 적습니다. 결정 ID(`PQ-…`, `D-…`, `C-…`)와 편차 번호는 근거를 찾아갈 수 있게 달아 둡니다.

## ultragoal이 하는 일

ultragoal은 할 일을 여러 **목표(goal)**로 나눠 파일에 적고, 하나씩 실행하고 검증한 뒤 끝내는 workflow입니다. 두 가지 도구와 여러 훅이 이를 나눠 맡습니다.

| 구성 | 역할 |
|---|---|
| `ultragoal` 도구 | 목표 목록(`goals.json`), 원장(`ledger.jsonl`), 진행 메모(`progress.txt`), 검증 제출서(quality gate) 검사, 완료 영수증 |
| `goal` 도구 | "goal 모드"의 목표 하나(`goal-state.json`)를 켜고 끄고 완료합니다. `ultragoal create`는 열린 goal이 없을 때 이 goal을 켭니다. 이미 열린 goal이 ultragoal에서 왔거나 같은 목표면 그대로 두고, 그 밖에는 `Goal not armed: …`를 알립니다([ops.md](ops.md)). |
| 훅 (`src/hooks.ts`, `src/goal/hooks.ts`) | 진입과 인계, 가드, 도구 숨김, goal 문맥 주입, 턴이 끝날 때 이어서 하라는 continuation, 보류, 압축 복구 |
| SKILL (`skills/ultragoal/SKILL.md`) | 모델에게 순서를 지시합니다. 누구를 언제 부를지, blocker를 어떻게 기록할지 같은 것입니다. |

**코드가 강제하는 것과 SKILL만 요구하는 것은 다릅니다.** 코드는 도구에 들어온 입력과 제출서를 검사하고, 파일 상태에 따라 거부하거나 주입합니다. 예를 들어 architect를 실제로 불렀는지, cohort lane을 세대마다 한 번만 돌렸는지는 코드가 알 수 없습니다. 그런 규칙은 SKILL 문구로만 요구합니다. 각 문서는 이 구분을 따로 적습니다.

## 전체 흐름

```
[진입]
  ralplan 승인 "Approve execution via ultragoal"
    ├ ralplan handoff(to="ultragoal")        ── 저널로 감싼 인계
    └ 같은 execution에서 skill ultragoal 로드  ── 훅이 같은 인계를 대신 수행
  또는 "ultragoal"·"@ultragoal" 안내 → 모델이 skill ultragoal 로드 → goal-planning 시작
        │
        ▼
[goal-planning]  ultragoal 행 활성, 제품 파일 write/edit/patch 거부
        │  ultragoal create(description, goals[{title, description, acceptanceCriteria[]}])
        ▼
[create]  goals.json(v2) 새로 씀 · ledger plan_created · progress PLAN · goal 켬(열린 goal이 없을 때)
        │
        ▼
[목표 루프] ── 목표마다 반복
   next  → 목표를 active로, ledger goal_started, "checkpoint requires=…" 출력
   구현 → 목표 테스트(targetedVerification)
   ├ 중간 목표: architect 리뷰 → checkpoint(complete, 목표별 gate) → per-goal 영수증
   │            불통과면 checkpoint(failed) → 수정 → next(retry_failed)
   └ 마지막 필수 목표: 변경 고정 → cohort(cleaner · architect · executor QA 병렬)
            ├ blocker 있음 → record_review_blockers → 수정 목표(새 마지막 목표)
            │                → 다음 세대는 바뀐 부분만 검토
            └ clean → terminal critic → checkpoint(complete, 최종 gate) → final-aggregate 영수증
        │
        ▼
[완료]  ultragoal 활성 행 삭제(파일의 목표 상태가 모두 끝나면) · run_complete: yes(영수증까지 맞으면)
        · goal complete → continuation 멈춤

[실행 내내]
  - goal 문맥 주입(goal마다 1회, 압축 뒤 다시)
  - 루트 세션의 execution이 성공으로 끝날 때 goal이 active면 <goal-continuation> 주입
    (Esc 뒤, 자식 execution이 도는 동안, 보류 중, paused goal에는 없음)
  - 도구 없는 턴 3회 또는 critic 비OKAY 5회 → 보류, 다음 사용자 프롬프트가 해제
  - Esc(interrupted) → 다음 사용자 프롬프트까지 continuation 없음
  - 압축 → [ULTRAGOAL RUN ACTIVE] 복구 문맥

[다른 출구]
  ultragoal handoff(to="ralplan" | "deep-interview") · goal pause(human_blocked + critic OKAY)
  · goal drop · ultragoal clear(state가 깨졌거나 낡았으면 force 필요)
```

"마지막 필수 목표"는 이 목표를 빼고 끝나지 않은 필수 목표가 하나도 없는 목표입니다. 수정 목표의 부모(`review_blocked`)는 이미 대체된 것으로 셉니다(`src/ultragoal-runtime/plan.ts`의 `completionView`). 그래서 cohort와 critic은 "모든 목표가 끝난 뒤"가 아니라 **마지막 목표를 완료 처리하기 전에** 돕니다. 검토 범위는 실행 전체의 누적 변경입니다.

## 문서 목록

| 문서 | 내용 |
|---|---|
| [entry-and-handoff.md](entry-and-handoff.md) | 키워드·멘션 안내, `skill ultragoal` 로드, 턴 표식, `ralplan handoff`와 `ultragoal handoff`, 저널 인계, 체인 가드, `goal-planning` |
| [ops.md](ops.md) | `ultragoal` 도구의 op 전부: 입력, 검사 순서, 쓰는 파일, 원장 이벤트, 결과 문구 |
| [gates-and-receipts.md](gates-and-receipts.md) | 목표별 gate와 최종 gate, 결함 코드, 완료 영수증, 실행 완료 판정, 재오픈, 수정 목표 연쇄, critic 연속 횟수 |
| [goal-loop.md](goal-loop.md) | `goal` 도구, goal 문맥 주입, continuation, 보류와 해제, Esc, 압축 복구 |
| [state-and-files.md](state-and-files.md) | 세션 폴더 구성, 쓰기 큐, 파일 스키마, 활성 행·스냅숏·순위, 감사 로그, 저널, 단계 전이와 reconcile, HUD, doctor |
| [guards.md](guards.md) | 산출물 가드, `goal-planning` 편집 가드, 도구 숨김, 역할 권한, red-team 조각, cleaner |
| [known-limits.md](known-limits.md) | 알려진 한계와 후속. 옛 `docs/ultragoal-follow-ups.md`의 열린 항목과 U 번호 대응표 |

## 코드 지도

| 파일 | 맡는 일 | 자세한 문서 |
|---|---|---|
| `src/ultragoal-runtime/tool.ts` | `ultragoal` 도구 정의, 입력 스키마, 호출 세션의 계보 루트로 op 실행 | ops |
| `src/ultragoal-runtime/store.ts` | op 함수들. `tool.ts`가 연 트랜잭션 안에서 읽기 → 검사 → 쓰기(계획, 원장, 진행 메모, goal state 순)를 하고, 대부분의 op는 끝에 reconcile합니다(`handoff`, `state`, `clear`, `add_pattern`, `validate_gate`, `doctor`는 하지 않음) | ops, state-and-files |
| `src/ultragoal-runtime/plan.ts` | `goals.json` v2 스키마와 검증, ID, `after` 배치, 상태 허용표, 다음 목표, `completionView`, 실행 완료 판정, 수정 목표 도우미 | ops, gates-and-receipts |
| `src/ultragoal-runtime/gate.ts` | 목표별 gate와 최종 gate 검사, 결함 목록 | gates-and-receipts |
| `src/ultragoal-runtime/receipt.ts` | 완료 영수증(`completionVerification`) 모양, 해시, 유효 조건 | gates-and-receipts |
| `src/ultragoal-runtime/ledger.ts` | 원장 이벤트와 필드, 파서, 필수 목표 집합 변화 판정, critic 비OKAY 연속 횟수 | state-and-files, gates-and-receipts |
| `src/ultragoal-runtime/progress.ts` | `progress.txt` 형식과 파서 | state-and-files |
| `src/ultragoal-runtime/manifest.ts` | ultragoal 단계(`missing`, `goal-planning`…`handoff`), 전이 표, `state` op가 거부하는 필드 | state-and-files |
| `src/ultragoal-runtime/hud.ts` | ultragoal 행의 HUD 칩(그리지는 않음) | state-and-files |
| `src/ultragoal-runtime/recovery.ts` | 압축 복구 문맥과 무진행 감지 | goal-loop |
| `src/ultragoal-runtime/messages.ts` | 결과 문구, 거부 문구, red-team 조각 | 각 문서 |
| `src/goal/tool.ts`, `state.ts`, `messages.ts` | `goal` 도구와 `goal-state.json`, 보류 기록 `goal-continuation.json`, goal 문맥·continuation 문구 | goal-loop |
| `src/goal/hooks.ts` | continuation 판단, 보류 해제, goal 문맥, ultragoal 압축 복구 | goal-loop |
| `src/hooks.ts` | 훅 조립: 프롬프트 안내, `execute.before/after`(가드, 턴 표식, `skill ultragoal` 게이트, red-team 조각), `context`(도구 숨김, goal 문맥), 압축, 이벤트(continuation) | entry-and-handoff, guards, goal-loop |
| `src/skill-state/handoff.ts`, `journal.ts` | 두 방향 인계 하나(`handoffWorkflowTx`)와 그 저널 | entry-and-handoff, state-and-files |
| `src/skill-state/rows.ts`, `audit.ts`, `hud.ts`, `doctor.ts` | 활성 행과 스냅숏·순위, 감사 로그, 공통 HUD, doctor | state-and-files |
| `src/state.ts` | 세션 폴더 경로, 세션마다 쓰기 큐 하나(`workflowTransaction`) | state-and-files |
| `src/artifact-guard.ts` | `.open-gajae/` 경로 판정(항상 차단, ultragoal 소유 경로) | guards |
| `src/config.ts` | 역할 agent와 권한 규칙(`roleRules`) | guards |
| `src/injection.ts` | 주입 메시지 표식과 감싸기(`wrapInjected`) | goal-loop |
| `src/ralplan-runtime/store.ts` | ralplan 쪽 `handoff` op와 `RALPLAN_RUNNING_REFUSAL` | entry-and-handoff |
| `src/ralplan.ts` | 키워드 감지(`detectUltragoalKeyword` 등) | entry-and-handoff |
| `src/ralplan-runtime/temp-paths.ts` | 계획 가드가 허용하는 OS 임시 경로(`isNeutralTempPath`) | guards |
| `src/index.ts` | 도구와 훅 등록 | guards, goal-loop |
| `src/tools/define.ts` | 도구 정의 도우미(입력을 따로 검사하지 않음) | ops |
| `skills/ultragoal/SKILL.md` | 모델용 절차. 끝의 "Source and host substitutions" 표가 gjc 원문과 다른 곳과 편차 번호를 적습니다. | 각 문서 |
| `prompts/open-gajae-cleaner.md`, `open-gajae-executor.md` | cleaner 역할 프롬프트, executor 프롬프트 | guards |

## 유지 규칙

- 코드가 바뀌면 같은 커밋에서 해당 문서도 고치고, 이 파일 머리의 기준 커밋을 갱신합니다.
- 문서와 코드가 다르면 코드가 기준입니다. 차이를 찾으면 문서를 고치거나 [known-limits.md](known-limits.md)에 적습니다.
