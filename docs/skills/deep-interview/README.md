# deep-interview 동작 문서

이 폴더는 open-gajae `deep-interview`가 **지금 코드에서 어떻게 동작하는지**를 단계별로 적은 문서입니다.

- **기준 코드**: 브랜치 `feat/deep-interview-gjc-revision`(S3c, S4 뒤 Architect 리뷰 반영 커밋, 그리고 2026-10-03 리뷰의 취소·재개와 종료 조건 반영 커밋). 코드 위치는 이 기준 코드의 `path:line`으로 적습니다.
- **참조한 gajae-code(gjc)**: `5c5231418930673e42cc5d08ebe4376e03187533`. gjc 줄 번호는 각 open-gajae 파일의 머리말 주석이 적은 값을 옮긴 것이고, 이 문서를 쓰며 gjc 소스로 다시 확인하지는 않았습니다.

다른 문서와는 이렇게 나뉩니다.

- **정책**: `AGENTS.md`와 `docs/development.md`가 정합니다. GJC와 다른 점은 `docs/development.md`의 "GJC로부터의 deviation (deep-interview)" 표에 있습니다. 이 폴더에서 "deep-interview 편차 N"은 그 표의 번호입니다.
- **결정 기록**: spec `.omc/specs/deep-interview-deep-interview-gjc-revision.md`(Errata E1–E20이 본문보다 우선), 계획 `.omc/plans/ralplan-deep-interview-gjc-revision.md`, 결정 모음 `.omc/plans/deep-interview-gjc-pq-decisions.md`.
- **이 폴더**: 현재 구현만 적습니다. 결정 ID(`DR-…`, `C-…`, `PQ-…`, `K…`)는 근거를 찾아갈 수 있게 달아 둡니다. 결정 기록과 코드가 다르면 코드가 기준입니다.

## deep-interview가 하는 일

deep-interview는 모호한 요청을 한 번에 질문 하나씩 묻고, 답마다 모호도(ambiguity)를 점수로 매겨, 기준치 아래로 내려오면 스펙(spec)을 저장하고 ralplan이나 ultragoal로 넘기는 workflow입니다. gjc의 deep-interview skill과 런타임을 OpenCode 플러그인에 맞게 옮긴 것이고, OMC에서 온 옛 deep-interview와 옛 상태 도구 3개(`state_*`)를 대신합니다.

| 구성 | 역할 |
|---|---|
| `deep-interview` 도구 (`src/deep-interview-runtime/tool.ts`) | op 8개(`start`, `write`, `spec`, `handoff`, `status`, `doctor`, `state`, `clear`). deep-interview 상태, 스펙 파일, 스펙 index, 활성 행을 쓰는 유일한 길입니다. `open-gajae`만 부를 수 있습니다. |
| 훅 (`src/hooks.ts`, `src/deep-interview-runtime/hooks.ts`) | 키워드·멘션 안내, 편집 가드, 스펙 경로 항상 차단, 같은 execution의 skill 로드 게이트, continuation, 압축 문맥, 도구 숨김 |
| SKILL (`skills/deep-interview/SKILL.md`) | 모델에게 순서를 지시합니다. Phase 0 기준치, Round 0 topology, 질문과 점수, 라운드 기록, 패널, closure·restate gate, 스펙, Phase 5 선택지. |
| 패널 역할 (`open-gajae-lateral-reviewer`, `prompts/open-gajae-lateral-reviewer.md`) | 패널 persona가 도는 읽기 전용 subagent 역할. 프롬프트가 gjc 패널 조각 `lateral-review-panel.md`입니다. |
| 공통 기반 (`src/skill-state/`, `src/state.ts`) | 활성 행과 스냅숏, 감사 로그, 저널 인계, doctor, 세션 쓰기 큐. ralplan·ultragoal과 함께 씁니다. |

**코드가 강제하는 것과 SKILL만 요구하는 것은 다릅니다.** 코드는 도구 입력의 모양, 상태의 phase와 `active`, 스펙 파일의 sha256, 크기 한도를 검사하고, 파일 상태에 따라 거부하거나 주입합니다. 질문을 실제로 `question`으로 했는지, 라운드 기록이 실제 답과 같은지, 모호도가 기준치 아래인지, 패널을 언제 열었는지는 코드가 알지 못합니다. 그런 규칙은 SKILL 문구로만 요구합니다. 각 문서는 이 구분을 따로 적습니다.

## 전체 흐름

```
[진입]
  "deep interview"·"딥인터뷰" 키워드, @deep-interview 멘션 → 안내만 (상태 없음)
  skill deep-interview 로드                              → 턴 표식만 (상태 없음)
        │
        ▼
[Phase 0]  deep-interview status → 기준치 결정
           (활성 상태의 값 → 사용자가 말한 값 → <open-gajae-runtime-settings> 블록)
           첫 줄 "Deep Interview threshold: <percent> (source: <source>)"
        │
        ▼
[start]  deep-interview start(idea, threshold?)
         새 봉투: active, phase interviewing, threshold, threshold_source, 활성 행
         (ralplan·ultragoal이 보이는 주 skill이면 거부)
        │
        ▼
[Round 0]  topology 확인 질문 하나 → write {state:{rounds:[round-0], topology}}
        │
        ▼
[라운드 루프]  question → 점수 → write {state:{rounds:[round-n], …}}
               런타임: round_key로 병합, 라운드 모양 검사, current_ambiguity 파생 + 하한
               ┌ 밴드가 바뀌면 Phase 3 패널(subagent(open-gajae-lateral-reviewer) 3~4개 병렬)
               └ 루트 execution이 끝날 때 interviewing이면 continuation (사용자 프롬프트마다 2번)
        │  모호도 ≤ 기준치
        ▼
[Phase 4]  closure 검토 → 한 문장 restate 확인 → 스펙 작성
           deep-interview spec(content|path, slug?) → specs/deep-interview-<slug>.md,
           index 한 줄, 상태 phase handoff + spec_*
        │
        ▼
[Phase 5]  question: ralplan으로 다듬기 / ultragoal로 실행 / 더 다듬기 / 여기서 끝내기
   ├ ralplan·ultragoal: deep-interview handoff(to) → skill ralplan|ultragoal
   │    (같은 execution이면 skill 로드가 넘기기를 대신함 = 로드 게이트)
   ├ deliberate ralplan을 미리 골랐으면: spec(…, handoff:"ralplan") 한 번에 3단계
   ├ 더 다듬기: phase handoff에 머문 채 라운드 계속, 다시 spec
   └ 여기서 끝내기: deep-interview clear → phase complete, 행 삭제, 스펙 파일은 남음

[실행 내내]
  - deep-interview가 보이는 주 skill이고 active이며 phase가 interviewing·handoff면
    write/edit/patch는 OS 임시 경로 밖에서 거부 (shell은 분류하지 않음)
  - specs/deep-interview-* 는 언제나 write/edit/patch 거부
  - 압축 → <deep-interview-compaction-context>

[되돌아오기]
  ralplan handoff(to:"deep-interview") · ultragoal handoff(to:"deep-interview")
  → interviewing, 기존 필드 유지, 활성 행

[취소와 재개]
  사용자가 멈춤 → deep-interview state(patch={"active": false})
                 비활성 interviewing, 라운드 유지, 행 삭제, 가드·continuation 멈춤
                 (스펙 뒤에는 deep-interview clear: 재개 없음, 스펙은 남음)
                 열린 goal이 있으면 그다음은 goal continuation (K18)
  skill 다시 로드 → Phase 0이 재개·새로·지우기를 물음
                 재개 → deep-interview state(patch={"active": true}) → write로 이어 감
```

## 문서 목록

| 문서 | 내용 |
|---|---|
| [ops.md](ops.md) | `deep-interview` 도구의 op 8개: 입력, 검사 순서, 쓰는 파일과 감사 verb, 결과 모양, 거부 문구, op별 허용 상태표(C-3), 결합 호출 |
| [state-and-files.md](state-and-files.md) | 세션 폴더 파일, 봉투 모양과 op별 변화, 읽기 경계, gjc 병합, `write` 정리기, 라운드 검사, 런타임 모호도와 하한, 입력 상한, StateStore 한도, 행·스냅숏·감사·저널, HUD 칩, doctor |
| [entry-and-handoff.md](entry-and-handoff.md) | 진입, Phase 0 기준치와 설정, `start` 거부, 넘기기 경로 다섯(op, 결합 호출, 로드 게이트, ralplan·ultragoal에서 돌아오기), 공통 저널 인계, 결과 문구 |
| [guards-and-continuation.md](guards-and-continuation.md) | 편집 가드, 스펙 경로 항상 차단, continuation, 압축 문맥, 도구 숨김과 역할 권한 |
| [panel.md](panel.md) | 패널 역할 `open-gajae-lateral-reviewer`, 패널 조각, 밴드, persona, 결과 합치기, 기록, advisory lane |
| [known-limits.md](known-limits.md) | 알려진 한계 K1–K17 |

## 코드 지도

`src/deep-interview-runtime/`:

| 파일 | 맡는 일 | 자세한 문서 |
|---|---|---|
| `manifest.ts` | phase 셋(`interviewing`, `handoff`, `complete`)과 전이 표, release·가드 phase 집합, 런타임 소유 키 목록, 최상위 전사 필드 목록, `state` op가 거부하는 필드, 라운드 기록 검사(`ROUND_RECORD_REQUIRED`, `roundRecordErrors`), 스펙 파일 이름과 기본 slug | state-and-files, ops |
| `envelope.ts` | 읽기 경계 `normalizeForRead`, gjc 병합 셋(라운드, 사실, 봉투), `write` 정리기 `sanitizeWritePayload`, 최상위 전사 필드 거부, 입력 상한 | state-and-files |
| `ambiguity.ts` | 하한 계산(`computeAmbiguityFloor`), 하한 적용(`applyAmbiguityFloorToEnvelope`), 런타임 모호도(`deriveRuntimeAmbiguity`) | state-and-files |
| `hud.ts` | 활성 행의 HUD 칩과, 압축 문맥이 같이 쓰는 사실 추출(`deepInterviewHudFacts`) | state-and-files, guards-and-continuation |
| `messages.ts` | 모델이 보는 문구: 편집 가드, 스펙 가드, 체인 거부, `start` 거부, op 거부, continuation, 압축 문맥, 넘기기 결과 줄 | 각 문서 |
| `store.ts` | op 함수들. `tool.ts`가 연 트랜잭션 안에서 읽기 → 모든 검사 → 쓰기를 합니다. 스펙 확인(`verifySpecTx`)과 deep-interview 쪽 넘기기(`deepInterviewHandoffTx`)는 로드 게이트와 같이 씁니다. | ops, state-and-files |
| `tool.ts` | 도구 정의, 입력 스키마, 호출자 검사, 계보 루트로 op 실행 | ops |
| `hooks.ts` | 훅 판단 함수: 편집 가드 문구, continuation 판단과 횟수, 로드 게이트, 압축 문맥. 호스트 호출은 `src/hooks.ts`가 합니다. | guards-and-continuation, entry-and-handoff |

deep-interview가 쓰는 공통 기반:

| 파일 | 맡는 일 | 자세한 문서 |
|---|---|---|
| `src/skill-state/handoff.ts` | 세 skill이 함께 쓰는 저널 인계 `handoffWorkflowTx`. deep-interview는 caller이자 callee입니다. | entry-and-handoff |
| `src/skill-state/rows.ts` | 활성 행 `state/active/<skill>.json`, 스냅숏 `state/skill-active-state.json`, 파이프라인 순위, 보이는 주 skill(`readVisiblePrimaryTx`) | state-and-files |
| `src/skill-state/doctor.ts` | 읽기 전용 검사(`collectDoctorSummaryTx`)와 gjc 텍스트 형식(`renderDoctorText`). deep-interview phase 셋이 등록되어 있습니다. | state-and-files, ops |
| `src/skill-state/audit.ts` | 감사 로그 `state/audit.jsonl` 한 줄(`appendAudit`) | state-and-files |
| `src/skill-state/journal.ts`, `hud.ts` | 인계 저널, 칩 도우미 | state-and-files |
| `src/state.ts` | 세션 폴더 경로, 세션마다 쓰기 큐 하나(`workflowTransaction`), payload 한도(`assertStatePayload`), 경로 성분 검사(`safeComponent`) | state-and-files |

그 밖에 deep-interview가 닿는 곳:

| 파일 | 맡는 일 |
|---|---|
| `src/hooks.ts` | 훅 조립: `prompt`(안내, 턴 표식, continuation 횟수 초기화), `execute.before`(산출물 가드, 편집 가드, 체인 가드, 로드 게이트), `execute.after`, `context`(도구 숨김), `compaction`, 이벤트(continuation) |
| `src/tools.ts` | 도구 등록. 결합 호출의 ralplan 시드 콜백(`startRunTx`)을 여기서 주입합니다(`src/tools.ts:57-63`). |
| `src/config.ts` | 설정 `deepInterview.ambiguityThreshold`와 출처 문자열(`loadSettings`), 시스템 프롬프트의 설정 블록, 패널 역할 등록과 권한 규칙 |
| `src/artifact-guard.ts` | 스펙 경로 판정(`isDeepInterviewOwned`) |
| `src/ralplan.ts` | deep-interview 키워드 감지와 안내 문구(`detectDeepInterviewKeyword`, `deepInterviewMessage`) |
| `src/ralplan-runtime/store.ts`, `tool.ts` | `ralplan handoff(to:"deep-interview")`(`ralplanHandoffTx`), 결합 호출이 부르는 `startRunTx`, 활성 run 위의 `ralplan start` 거부(`ralplanRunActiveRefusal`) |
| `src/ultragoal-runtime/store.ts` | `ultragoal handoff(to:"deep-interview")`(`handoffTx`) |
| `prompts/open-gajae-lateral-reviewer.md` | 패널 역할 프롬프트 |

## 용어

- **상태**: `state/deep-interview-state.json`. gjc의 봉투(envelope)이고, 인터뷰 내용은 그 안의 `state` 객체에 있습니다. 이 문서에서 "상태"는 파일 전체, "`state`"는 안쪽 객체입니다.
- **활성**: 상태를 읽을 수 있고 `active === true`(계획 C-2).
- **계보 루트(lineage root)**: `parentID`를 따라 올라가 만나는 부모 없는 세션. 자식 세션에서 부른 op도 루트 세션 폴더의 상태를 씁니다.
- **보이는 주 skill(visible primary)**: 활성 행과 스냅숏에서 고른 하나(`readVisiblePrimaryTx`, `src/skill-state/rows.ts:246-292`). 순위는 ultragoal > ralplan > deep-interview입니다.
- **가드 phase**: `interviewing`, `handoff`(`src/deep-interview-runtime/manifest.ts:64`).
- **release phase**: `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`(`src/deep-interview-runtime/manifest.ts:51-58`). gjc의 기본 `stopReleasingPhases`입니다.
- **턴 표식**: 이번 execution에서 로드한 workflow skill 이름. 세션마다 메모리에 하나 있고, execution이 끝날 때마다 지워집니다([entry-and-handoff.md](entry-and-handoff.md)).

## 유지 규칙

- 코드가 바뀌면 같은 커밋에서 해당 문서도 고치고, 이 파일 머리의 기준을 갱신합니다.
- 문서와 코드가 다르면 코드가 기준입니다. 차이를 찾으면 문서를 고치거나 [known-limits.md](known-limits.md)에 적습니다.
