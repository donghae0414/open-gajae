# 합의 루프와 역할 agent

이 문서는 SKILL의 합의 루프(1–9단계)가 어떤 도구 호출과 단계 파일로 이어지는지, 그중 무엇을 코드가 강제하고 무엇을 SKILL과 역할 프롬프트만 요구하는지를 적습니다. 함께 다루는 것은 세 역할 agent `open-gajae-planner`·`open-gajae-architect`·`open-gajae-critic`의 등록과 권한, 프롬프트, OpenCode 호스트에서 역할 subagent를 다시 부르는(재개·조종) 방식, `--interactive`·`--deliberate`, `question` 사용, 최종 승인, Pre-Execution Gate, 두 pass로 끝나는 run의 호출 순서입니다. 기준 코드는 [README.md](README.md) 머리에 있습니다. 코드 위치는 그 기준 코드의 줄 번호이고, 루트 `README.md`의 줄 번호만은 이 폴더로 가는 링크 문단이 들어간 지금 파일의 번호입니다. 예시 출력은 기준 코드를 임시 폴더의 `StateStore` 위에서 bun으로 실제로 불러 얻은 것입니다(`tests/ralplan-tool.test.ts`와 같은 방식, 역할의 자식 세션은 가짜 계보로 흉내 냄). 세션 폴더 절대 경로는 `<session>`, 프로젝트 경로는 `<project>`로 바꿨고, 시각과 해시는 실행마다 다릅니다.

다음 주제는 다른 문서가 맡습니다.

- 단계 쓰기 안쪽(예산, 회차 상한, lane 예산, PLANNING-STUCK, 중복 제거, disposition 검사, `auto_handoff` 계산, 영수증의 모든 필드): [stages-and-ledger.md](stages-and-ledger.md)
- `ralplan` 도구의 op별 입력, 검사 순서, 거부 문구, 결과 모양: [ops.md](ops.md)
- 진입, `ralplan handoff`, 같은 execution의 `skill ultragoal` 게이트, 공통 저널 인계: [entry-and-handoff.md](entry-and-handoff.md)
- 계획 가드, continuation, 도구 숨김의 동작, 역할 권한 규칙이 가드와 맞물리는 방식: [guards-and-continuation.md](guards-and-continuation.md)
- 상태 파일의 필드와 활성 행, HUD 칩: [state-and-files.md](state-and-files.md)
- 알려진 한계: [known-limits.md](known-limits.md)

이 문서에서 쓰는 말:

- **리더**: 주 agent `open-gajae`. SKILL은 "primary agent", "ralplan leader", "parent"라고 부릅니다.
- **역할 agent**: 세 consensus 역할. 리더가 호스트 `subagent` 도구로 띄우고, 각각 리더 세션의 자식 세션에서 돕니다.
- **과제(assignment)**: 리더가 `subagent` 호출의 `prompt`에 넣는 글. 역할은 역할 프롬프트와 과제에 든 것만 봅니다.
- **review pass N**: SKILL이 정한, lane 하나가 run 전체에서 몇 번째 리뷰를 하는지의 순번. 코드의 lane 예산과 다릅니다(아래 5단계).

## 한눈에 보기

| 무엇 | 어디서 정하나 |
|---|---|
| 역할 셋의 이름, 설명, `subagent` 모드, 시스템 프롬프트, 모델 설정, 권한 규칙 | 코드 (`src/config.ts`) |
| 역할이 `ralplan` 도구를 보고 부를 수 있는지, 부를 수 있는 op | 코드 (`src/hooks.ts`의 `TOOL_OWNERS`, `src/ralplan-runtime/tool.ts`의 `ROLES`·`ROLE_OPS`) |
| 역할 세션 id 기록, `resumable`·fallback 필드 검사, `lane_verdict` 토큰 검사 | 코드 (`src/ralplan-runtime/tool.ts`, `ledger.ts`) |
| 회차 상한, lane 예산, disposition 검사, final의 `auto_handoff` | 코드 ([stages-and-ledger.md](stages-and-ledger.md)) |
| 누가 언제 무엇을 쓰는지, pass 1 병렬·pass 2부터 순차, join gate, review pass N, 재리뷰 문맥 묶음, 질문과 승인 | SKILL (`skills/ralplan/SKILL.md:61-131,185-209`) |
| 다섯 규칙 ratchet | SKILL(이름과 적용 시점)과 architect·critic 프롬프트(규칙 본문) |
| 역할의 출력 형식, 읽기 전용 `shell`, 영수증만 돌려주기 | 역할 프롬프트 (`prompts/open-gajae-{planner,architect,critic}.md`)와 SKILL |
| 재개·조종, 병렬 실행, background, 질문 폼 | OpenCode 호스트 (`opencode/packages/core/src/tool/plugin/subagent.ts`, `question.ts`, `core/src/session/runner/step.ts`) |

## 합의 루프 단계별

SKILL "The consensus workflow"(`SKILL.md:61-131`)의 단계를 호출과 파일로 옮긴 표입니다. "단계 파일"은 run 폴더 `plans/ralplan/<run_id>/`에 생기는 파일이고, 모든 단계 쓰기는 `index.jsonl`에 한 줄을 더합니다([stages-and-ledger.md](stages-and-ledger.md)).

| 단계 | 누가 | 호출 | 단계 파일 | 코드가 강제 | SKILL·프롬프트만 |
|---|---|---|---|---|---|
| 시작 | 리더 | `ralplan start(task, interactive?, deliberate?, run_id?)` | 없음(상태, 활성 행, 스냅숏) | 활성 ultragoal·활성 ralplan이면 거부([ops.md](ops.md)) | skill 로드 뒤 1단계 전에 부름 |
| 1 Planner | 리더 → planner | `subagent(open-gajae-planner)`; planner가 `ralplan write(stage:"planner", stage_n:1, run_id, content)` | `stage-01-planner.md` | 역할은 `content`만, planner 세션 id 자동 기록, 회차 상한 | run당 한 번 띄움, Architect 전에 기다림, RALPLAN-DR 요약 내용 |
| 2 사전 의도 맞추기 | 리더(+ 사용자) | `question`(열린 항목마다 하나씩); `ralplan write(stage:"intent", …)`; 범위가 바뀌면 planner 재개 → `revision` | `stage-NN-intent.md`, (`stage-NN-revision.md`) | 없음(쓰기 자체만) | 열린 항목 판단, 질문 순서, `intent` 내용(`material-open-items: none` 등), `--interactive` 초안 확인 |
| 3 리뷰 fan-out | 리더 → architect, critic | 한 메시지에 `subagent` 둘; 각 역할이 `ralplan write(stage:"architect", …, lane_verdict)` 또는 `stage:"critic"` | `stage-NN-architect.md`, `stage-NN-critic.md` | lane 예산, `lane_verdict` 토큰, 역할 id 기록 | 같은 Planner 영수증을 리뷰, plan-only critic일 때만 병렬, `lane_verdict`를 넣으라는 지시 |
| 4 join gate | 리더 | (충돌이 있으면) `ralplan write(stage:"disposition", content:<JSON>)` | `stage-NN-disposition.md` | disposition 문서를 쓸 때 그 스키마와 출처를 index와 대조 | 두 lane 판정이 같은 pass에 모두 있는지, 충돌이 있는지 판단, 판정에 따른 경로 |
| 5 재리뷰 루프 | 리더 → planner → architect → critic | planner 재개 → `revision`; architect 재개 → `architect`; critic 재개 → `critic` | `stage-NN-revision.md` 등 | 회차 상한(기본 5), PLANNING-STUCK 결과 | 같은 세션 재개, pass 2부터 순차, 재리뷰 문맥 묶음, review pass N, ratchet |
| 6 사후 의도 확인 | 리더(+ 사용자) | `question`(늘); `ralplan write(stage:"post-interview", …)` | `stage-NN-post-interview.md` | 없음(쓰기 자체만) | 새 열린 항목 수집, 이전 스펙과 대조, 질문을 늘 `question`으로 |
| 7 final | 리더 | `ralplan write(stage:"final", …)` (원하면 그 전에 `adr`) | `stage-NN-final.md`, `pending-approval.md` | `pending-approval.md` 복사, `auto_handoff` 계산·기록 | join gate 재확인, ADR 절과 Intent Reconciliation 절 |
| 8 admission과 승인 | 리더(+ 사용자) | `auto_handoff`를 읽음; `off`면 `question` | 없음 | 없음 | stuck이면 보내지 않음, `ultragoal`이면 묻지 않음, 선택지 셋 |
| 9 실행 또는 멈춤 | 리더 | `ralplan handoff(to:"ultragoal")` → `skill ultragoal`; 또는 `ralplan state(patch={"active": false})` | 없음 | handoff는 활성·T phase 필요([entry-and-handoff.md](entry-and-handoff.md)) | 승인 없이 handoff하지 않음, stuck이면 handoff하지 않음 |

표의 "코드가 강제"는 도구가 거부하거나 계산하는 것만 적었습니다. 역할이 어느 단계를 쓰는지, 누가 쓰는지, 어떤 순서로 쓰는지는 코드가 막지 않습니다. 순서가 전이 표에 없으면 쓰기는 그대로 되고 `state/audit.jsonl`에 `invalid_transition_detected` 행만 남습니다([두 pass 예시](#두-pass-예시-호출-순서)).

### 1단계: Planner

SKILL `:62-68`. 리더는 Planner를 run마다 **한 번** `subagent`로 띄우고, 돌려받은 `sessionID`를 run의 Planner id로 삼습니다. Planner는 `ralplan write(stage="planner", stage_n=1, run_id, content)`로 계획을 쓰고 영수증과 짧은 상태만 돌려줍니다. 계획에는 RALPLAN-DR 요약(Principles 3–5개, Decision Drivers 상위 3개, Viable Options 2개 이상, 하나만 남으면 나머지를 버린 이유, deliberate 모드면 pre-mortem 3개와 확장 테스트 계획)이 들어가야 합니다.

- 이 요약 목록은 SKILL에만 있습니다. planner 프롬프트의 출력 계약(`prompts/open-gajae-planner.md:35-48`)에는 Decision Drivers와 Options는 있지만 Principles와 pre-mortem은 없습니다. 그래서 요약과 deliberate 요구는 리더가 과제에 적어 넘겨야 Planner에게 닿습니다.
- 코드는 계획의 내용을 보지 않습니다. 하는 일은 파일과 index 한 줄을 쓰고, 부른 agent가 planner면 그 세션 id를 `planner_subagent_id`로 남기는 것입니다([역할 메타데이터 기록](#역할-메타데이터-기록-ralplan-편차-5)).
- `planner` 쓰기는 회차를 여는 단계(opener)라서 회차 상한에 셉니다.

### 2단계: 사전 의도 맞추기

SKILL `:69-74`. 리뷰에 비용을 쓰기 전에, 계약을 바꿀 만한 열린 결정만 사용자와 맞춥니다.

- a: 리더가 Planner 산출물, 관련 `specs/deep-interview-*.md`, 이전 계획, 사용자 제약을 읽습니다.
- b: 열린 항목이 있으면 `question`으로 한 번에 하나씩, 영향이 큰 것부터 묻습니다. 없으면 묻지 않습니다.
- c: `ralplan write(stage="intent", …)`. 내용에는 살펴본 근거, 정해진 결정, 유지되는 non-goal, `material-open-items: none` 또는 남은 항목이 들어갑니다. 코드는 이 내용을 읽지 않습니다.
- d: 목표, 범위, non-goal, 수용 기준, 검증 의무가 바뀌면 Planner를 재개해 `revision`을 리뷰 전에 씁니다. 그러면 Architect·Critic은 이전 초안이 아니라 `revision`과 `intent` 영수증을 받습니다. 이 `revision`도 opener라서 회차를 하나 씁니다.
- e: `--interactive`면 맞춘 초안과 요약을 보여 주고 `question`으로 Proceed to review / Request changes / Skip review를 묻습니다. 아니면 그대로 진행합니다.

### 3단계: pass 1 리뷰 fan-out

SKILL `:75-79`. Architect와 Critic도 run마다 한 번 띄우고, 같은 Planner 영수증(path, sha, `stage_n`)을 리뷰하게 합니다.

- Critic이 **plan-only**(Architect의 결과를 쓰지 않음)면, 한 메시지에 `subagent` 호출 둘을 넣어 병렬로 돌립니다. 호스트는 모델이 한 단계에서 낸 도구 호출마다 따로 실행 fiber를 띄웁니다(`opencode/packages/core/src/session/runner/step.ts:117-128`, `Effect.forkScoped`). 리더의 단계는 두 호출이 모두 끝나야 끝납니다(`:143`, `Fiber.awaitAll`).
- Critic이 Architect의 결과를 평가해야 하면 Architect를 먼저 기다립니다(Sequential fallback, SKILL `:78`).
- 각 과제는 기존 `ralplan write`에 `lane_verdict`를 넣으라고 지시해야 합니다(SKILL `:79`). Architect는 Architectural Status(`CLEAR`/`WATCH`/`BLOCK`), Critic은 판정(`OKAY`/`ITERATE`/`REJECT`)을 넣습니다. 역할 프롬프트의 Persistence 절에는 `lane_verdict`가 없고(gjc 조각 `prompts/agent-fragments/ralplan-persistence.md`에도 없음), 코드에서도 선택 입력입니다. 그래서 과제가 지시하지 않으면 판정은 기록되지 않습니다.
- 두 쓰기는 서로 다른 자식 세션에서 오지만, 도구가 계보 루트를 주인으로 정하므로 같은 세션 쓰기 큐 하나에서 차례로 처리됩니다([state-and-files.md](state-and-files.md)). 어느 쪽이 먼저 오는지에 따라 감사 행이 달라집니다(예시 참고).

### 4단계: join gate와 typed conflict gate

SKILL `:80-81`. 합의, revision, final, 승인 전에, 같은 Planner 산출물·pass에 대해 Architect와 Critic의 영수증과 판정이 **둘 다** 있는지 확인합니다. Architect가 `CLEAR`가 아니거나 `APPROVE`가 아니거나, Critic이 `OKAY`가 아니면 Planner revision으로 돌아갑니다.

코드는 이 확인을 하지 않습니다.

- 상태에는 마지막 판정 하나만 남습니다: `last_review_verdict`, `last_review_verdict_lane`, `last_review_verdict_stage_n`(`laneVerdictStatePayload`, `ledger.ts:1056-1064`). 다음 lane의 쓰기가 앞 lane의 값을 덮으므로, 상태만으로는 두 lane을 함께 볼 수 없습니다. 두 lane의 판정은 영수증이나 단계 파일에서 읽어야 합니다.
- Architect의 Code Review Recommendation(`APPROVE`/`COMMENT`/`REQUEST CHANGES`)은 `lane_verdict`로 받지 않습니다. `LANE_VERDICTS.architect`는 `CLEAR`/`WATCH`/`BLOCK`뿐입니다(`ledger.ts:80-83`).
- 판정과 상관없이 `revision`, `post-interview`, `final`은 써집니다. 예를 들어 `planner` 하나만 쓴 run에서도 `final`이 써집니다([최종 승인과 admission](#최종-승인과-admission)의 PLANNING-STUCK 예시).

Architect와 Critic의 지적이 같은 계획 대상에 서로 맞지 않는 행동을 요구하면(`add` 대 `remove`, `remove` 대 `change`), revision 전에 `disposition` 단계(JSON, 스키마 `ralplan.review_conflicts.v1`)를 써야 합니다. 코드는 **disposition 문서를 쓸 때** 그 안의 findings에서 충돌을 계산하고, 충돌마다 처분이 있는지, 출처 영수증이 run의 `index.jsonl`의 architect·critic 행과 맞는지를 검사해 어긋나면 `Error:`로 거부합니다([stages-and-ledger.md](stages-and-ledger.md)). 리뷰 산출물(Markdown)에서 충돌을 찾아내 disposition을 요구하는 코드는 없습니다. 충돌이 있는지 판단하고 disposition을 쓰는 일은 리더 몫입니다.

### 5단계: 재리뷰 루프

SKILL `:82-101`과 Important 블록(`:131`).

**순서.** Critic이 `OKAY`가 아니거나 Architect가 `CLEAR`/`APPROVE`가 아니면 같은 닫힌 루프를 다시 돕니다.

1. 두 lane의 지적을 모읍니다(a). 충돌이 있으면 disposition을 먼저 씁니다(b).
2. **같은** Planner 세션을 재개해 지적과 disposition 영수증을 넘기고, `revision`을 씁니다(c, d). 재개가 안 되면 아래 재개 경로표대로 새로 띄웁니다.
3. pass 2부터는 **순차**입니다: Architect를 재개해 결과와 영수증을 기다린 뒤, 그 영수증을 넣어 Critic을 재개합니다(d). Critic은 Architect의 범위 부풀리기를 되짚는 규칙 5 검토를 합니다.
4. 같은 revision에 대해 두 판정을 다시 모읍니다(e). Critic `OKAY`와 Architect `CLEAR`/`APPROVE`가 같은 pass에서 나오거나, 5회에 닿을 때까지 반복합니다(f).
5. 5회에 닿으면 planner/revision을 더 열지 않고, 가장 나은 계획을 PLANNING-STUCK 결과로 남기며, 실행으로 보내지 않습니다(g).

**코드의 몫.** 회차 상한만 코드입니다(h). 새 `planner`·`revision`이 `ralplan.maxIterations`(기본 5)를 넘는 회차를 열려 하면 `ralplan write`가 영수증 대신 PLANNING-STUCK 결과를 돌려줍니다. 같은 회차 안의 `architect`·`critic`과 `post-interview`·`adr`·`final`은 계속 받습니다. 계산과 문구는 [stages-and-ledger.md](stages-and-ledger.md)에 있습니다. 순차·병렬, 같은 세션 재개, 재리뷰 문맥 묶음, ratchet은 코드가 보지 않습니다.

**review pass N과 lane 예산.** 둘은 다른 수입니다.

| | review pass N | lane 예산 |
|---|---|---|
| 정의 | lane 하나가 run 전체에서 하는 리뷰의 순번. 첫 Planner 산출물 리뷰가 1, 첫 revision 리뷰가 2. 회차가 바뀌어도, 새 revision이 열려도 1로 돌아가지 않음 | 회차(opener 하나와 그 뒤 단계들) 안에서 그 lane이 쓴 `architect`·`critic` 행의 수 |
| 어디에 | 과제 글에 `review pass N`이라고 그대로 적음(`SKILL.md:88`) | `evaluateRalplanReviewLaneBudget`(`ledger.ts:610-674`), 설정 `ralplan.maxReviewPassesPerLane`(기본 1) |
| 누가 셈 | 리더 | 코드(`index.jsonl`과 디스크의 lane 파일) |
| 넘으면 | — | PLANNING-STUCK 결과 |

기본 예산 1에서는 회차마다 lane이 한 번씩 쓰므로 두 수가 대개 같습니다. 예산을 2 이상으로 올리거나, 2d처럼 리뷰 전에 `revision`이 열리면(회차 2인데 첫 리뷰는 review pass 1) 어긋납니다. ratchet의 "pass 2부터"는 늘 review pass N을 기준으로 합니다(`:88`). `stage_n`도 별개입니다. SKILL은 합의 pass마다 `stage_n`을 올리라고 하지만(`:51`), 코드에게 `stage_n`은 파일 이름과 중복 판정의 열쇠일 뿐이고 회차를 세는 데 쓰지 않습니다(`summarizeRalplanIndex`, `ledger.ts:270-285`).

**다섯 규칙 ratchet.** pass 2부터 두 리뷰어를 묶는 규칙입니다. SKILL은 이름과 적용 시점만 적고(`:82`, `:95`, `:199`), 규칙 본문은 두 리뷰어 프롬프트에 있습니다. planner 프롬프트에는 없습니다.

| 규칙 | architect (`prompts/open-gajae-architect.md:27-33`) | critic (`prompts/open-gajae-critic.md:21-28`) |
|---|---|---|
| 1 delta-only | pass 2부터 이전 pass와의 차이와 이전 지적의 해결만 리뷰. 이전 pass는 재리뷰 문맥 묶음으로 식별 | 같음 |
| 2 새로움 정당화 | 이미 리뷰한 곳의 새 blocker는 "왜 이전 pass에서 안 보였나"가 있어야 함. 없으면 비차단 caveat | 같음 |
| 3 판정 단조성 | 이전 blocker가 모두 풀리면 Architectural Status와 Code Review Recommendation이 나빠지지 않음 | 판정이 나빠지지 않음(예: `ITERATE` → `REJECT`) |
| 4 심각도 규율 | 이월된 CRITICAL/HIGH는 늘 차단. pass 2부터 새로 나온 CRITICAL/HIGH는 규칙 2 정당화가 있어야 차단. pass 1에서는 모든 CRITICAL/HIGH가 차단(constraints `:22`에도 같은 문장) | 이월 blocker는 늘 차단, 새 고심각도는 규칙 2를 따름 |
| 5 반대 검토 | pass 2부터 Critic이 내 출력을 과설계·범위 확대로 검토함을 알고, 이전 지적을 푸는 것 이상으로 범위를 넓히지 않음. 구성적 종합(Stage 3)은 pass 1에서만 온전히 | pass 2부터 Architect 출력을 과설계·범위 확대로 검토하고, 정당화 없는 요구를 `ITERATE`로 바꾸지 않음 |
| (추가) | — | "spec too thin — expand" 요청도 pass 2부터는 규칙 2 정당화 필요 |

ratchet을 검사하는 코드는 없습니다. 판정 토큰이 나빠졌는지도 코드는 비교하지 않습니다.

**재리뷰 문맥 묶음.** pass 2부터 Architect·Critic 과제마다 반드시 넣는 것(`:87-95`): ① `review pass N`, ② 지금 리뷰할 revision 영수증(path, sha256, `stage_n`), ③ 이전 pass가 리뷰한 Planner/revision 경로, ④ 같은 lane의 이전 리뷰 파일 경로와 영수증, ⑤ 이전 blocker와 revision이 주장하는 해결(본문이 아니라 산출물 안을 가리키는 포인터), ⑥ Critic만: 이번 pass의 Architect 영수증·경로. 재개한 세션이든 새로 띄운 세션이든 묶음은 똑같이 넣습니다(`:95`, `:199`). 재개한 세션은 이전 문맥을 기억하지만, 새로 띄운 세션도 다섯 규칙을 적용할 수 있게 하기 위함입니다.

### 6–7단계: 사후 의도 확인과 final

SKILL `:102-110`.

- 6: 합의(같은 pass의 Critic `OKAY` + Architect `CLEAR`/`APPROVE`) 뒤, 사전 `intent` 영수증을 기준으로 합의가 새로 만든 가정·충돌만 모읍니다(a). `specs/deep-interview-*.md`와 관련 계획을 훑어 이전 결정과 어긋나는 곳을 찾습니다(b). 그리고 **`--interactive`와 상관없이** `question`으로 하나씩 확인합니다(c). 계획이 사용자 의도와 어긋나면 5단계 revision으로 돌아갑니다. 결과는 `ralplan write(stage="post-interview", …)`로 남기고 영수증과 짧은 상태(reconciled-clean / reconciled-with-revision / open-confirmations-pending)만 돌려줍니다(d).
- 7: join gate를 다시 확인하고, `ralplan write(stage="final", …)`로 ADR(Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups)과 `## Intent Reconciliation` 절을 담은 최종 계획을 씁니다. 코드는 `final`을 `pending-approval.md`로 복사하고 `auto_handoff`를 계산해 영수증, `index.jsonl`의 final 행, 상태에 남깁니다. 절이 있는지는 보지 않습니다.
- SKILL은 `final`을 `post-interview` 바로 뒤에 씁니다. 전이 표는 `final`로 가는 길을 `adr`에서만 두므로 이 쓰기는 `invalid_transition_detected` 감사 행을 남깁니다. gjc도 같습니다(루트 README "Known behavior (as in GJC): transition audit rows").

8–9단계는 [최종 승인과 admission](#최종-승인과-admission)에 있습니다.

## 역할 agent 셋

### 등록

세 역할은 다른 역할과 함께 `src/config.ts`에서 등록됩니다.

| 항목 | 코드 |
|---|---|
| 이름 | `agentNames`(`src/config.ts:9-21`, `:13-15`) |
| 모드 | `subagent`(`registerAgents`, `src/config.ts:362`). 호스트 `subagent` 도구는 `primary` 모드 agent를 거부하므로(`subagent.ts:136-137`) 리더 `open-gajae`는 subagent가 될 수 없습니다. |
| 시스템 프롬프트 | `prompts/<이름>.md` 그대로(`loadPrompts`, `src/config.ts:330-341`; `:363-371`). `<open-gajae-runtime-settings>` 블록은 `open-gajae`에만 붙습니다. 플러그인 시작 때 한 번 읽습니다. |
| 모델 | 설정 `agents.<이름>.model`이 있으면 `draft.model`로 넣습니다(`src/config.ts:372-380`). 아래 "모델과 variant" |
| 권한 | `draft.permissions.push(...roleRules(id))`(`src/config.ts:381`). 호스트 기본 규칙 뒤에 붙고, 사용자의 호스트 설정 `agents.<id>` 규칙이 그 뒤에 와서 이깁니다(`roleRules` 주석 `:268-273`, 루트 README "Owned roles and settings") |

설명은 `descriptions`(`src/config.ts:231-250`) 그대로이고, 호스트가 리더의 `subagent` 도구 설명 끝 "Available subagents:" 목록에 붙입니다(`subagent.ts:271-295`).

| 역할 | 설명 (`src/config.ts`) |
|---|---|
| `open-gajae-planner` | `Draft and revise consensus work plans and record them with the ralplan tool; never implements.`(`:238-239`) |
| `open-gajae-architect` | `Read-only architectural review with steelman antithesis and tradeoff tension.`(`:240-241`) |
| `open-gajae-critic` | `Read-only final quality gate for plans with severity-rated findings.`(`:242-243`) |

권한 규칙(`roleRules`, `src/config.ts:274-328`):

| 규칙 | planner (`:305-315`) | architect·critic (`:279-286`) |
|---|---|---|
| `edit` | deny (`write`·`edit`·`patch`가 모두 `edit` 권한을 씀: `core/src/tool/plugin/write.ts:59`, `edit.ts:123`, `patch.ts:81`) | deny |
| `subagent` | `*` deny, 그 뒤 `open-gajae-explore`·`open-gajae-document-specialist` allow | deny |
| `question` | deny (`readonlyDenies`, `:261-266`) | deny |
| `deep-interview`, `opencode_session_move`, `opencode_session_rename` | deny (`readonlyDenies`) | deny |
| `ultragoal`, `goal` | deny | deny |
| `ralplan` | 규칙 없음 → 호스트 기본 allow | 규칙 없음 → allow |
| `shell` | 규칙 없음 | 규칙 없음 |

호스트는 어떤 도구의 마지막 일치 규칙이 `*` deny면 그 도구를 요청에서 아예 뺍니다(`whollyDisabled`, `opencode/packages/core/src/tool.ts:231,291-294`). 그래서 세 역할에게 `question`과 편집 도구는 보이지 않고, architect·critic에게는 `subagent`도 보이지 않습니다. planner의 `subagent`는 마지막 규칙이 allow라 보이며, 다른 agent를 고르면 호스트가 `Subagent denied: <id>`로 거부합니다(`subagent.ts:138-151`). 규칙은 `tests/integration.test.ts`의 "read-only roles deny edit, subagent, question, deep-interview and session tools; primary adds none"와 "planner edits no path and delegates only to the two research roles"가 확인합니다.

planner가 실제로 위임하려면 호스트 설정 `experimental.subagent_depth`가 2 이상이어야 합니다. 호스트는 부른 세션의 깊이(부모를 따라 올라간 수)가 한도 이상이면 `Subagent depth limit reached (<한도>). Increase "experimental.subagent_depth" to allow nested subagents.`로 거부하고, 기본 한도는 1입니다(`subagent.ts:117-133`). planner는 리더의 자식(깊이 1)이므로 기본값에서는 거부됩니다. 플러그인은 이 값을 바꿀 수 없습니다(루트 `README.md:56`).

### 모델과 variant

설정 파일의 `agents.<역할 이름>.{model, variant}`로 정합니다. 기본값은 없습니다.

- `model`은 `provider/model` 꼴이어야 하고(`src/config.ts:149-152`), 첫 `/`에서 나눕니다(`:374-377`).
- 사용자·프로젝트 파일을 합친 뒤 `variant`만 있고 `model`이 없으면 로드 오류입니다(`:180-183`).
- 호스트 `subagent`는 모델을 "호출의 `model` 입력 → agent의 모델 → 부모 세션의 모델" 순으로 고릅니다(`subagent.ts:184`). 설정이 없으면 역할은 리더의 모델을 물려받습니다.
- 기존 세션을 재개할 때는 agent가 바뀌었거나 `model` 입력이 있을 때만 모델을 바꿉니다(`subagent.ts:171-182`).
- gjc의 `--architect openai-code`/`--critic openai-code`는 없습니다(ralplan 편차 7). run마다 리뷰어 모델을 고르는 입력은 없고, 호출 하나에 다른 모델을 쓰는 길은 호스트 `subagent`의 `model` 입력(`subagent.ts:36-39`)뿐입니다. 그 입력의 설명은 사용자가 명시적으로 요청하지 않으면 쓰지 말라고 하고, SKILL도 쓰라고 하지 않습니다.

### 쓸 수 있는 도구

- 호스트 기본 도구 중 거부되지 않은 것(`read` 같은 읽기 도구와 `shell`). `shell`의 읽기 전용은 프롬프트로만 요구합니다(ralplan 편차 11, 33).
- open-gajae 코드 도구(AST·LSP 읽기): 세 역할이 모두 `CODE_ACTORS`(`src/tools/permissions.ts:24-34`)에 있습니다.
- `ralplan` 도구: `TOOL_OWNERS.ralplan`(`src/hooks.ts:288-298`)에 세 역할이 있어 `context` 훅이 지우지 않습니다. `ultragoal`, `goal`, `deep-interview`는 리더만 주인이라 역할의 요청에서 지워집니다([guards-and-continuation.md](guards-and-continuation.md)). `tests/hooks.test.ts`의 "(K2, H5) C-11: … ralplan to the primary and its three roles"가 확인합니다.
- 역할 세션은 `ROLE_SUBAGENTS`(`src/hooks.ts:266-273`)에 있어 키워드·멘션 안내를 받지 않습니다.

### `ralplan` 도구에서 할 수 있는 것

`ralplanTool`의 호출자 검사(`ownerSession`, `src/ralplan-runtime/tool.ts:168-187`)는 `ROLES`(`:56-60`)와 `ROLE_OPS`(`:61`)를 씁니다. 역할은 `write`, `status`, `state`만 부를 수 있고, 주인 세션은 부른 세션의 계보 루트입니다(ralplan 편차 32). 그래서 역할의 쓰기는 리더 세션의 run 폴더에 들어갑니다. 실제 호출로 얻은 거부 문구:

```
Error: open-gajae-planner may only use write, status and state
Error: the ralplan tool is not available to open-gajae-executor
Error: open-gajae-architect must pass the artifact as content; path is for the primary agent only
```

- 첫 줄은 역할이 `start`·`doctor`·`handoff`·`clear`를 부를 때입니다. 둘째 줄은 세 역할도 리더도 아닌 agent입니다(보통은 도구가 숨겨져 여기까지 오지 않음).
- 셋째 줄은 역할이 `path`를 넘길 때이고, `stage` 검사보다 먼저 거부합니다(`tool.ts:220-223`, R-O4, ralplan 편차 2). 역할은 산출물 전체를 `content`로 넘깁니다. 프롬프트도 "pass the artifact inline as `content`"라고 적습니다.
- **역할이 쓰는 단계는 제한하지 않습니다.** architect가 `stage:"critic"`을 쓰면 거부 없이 `stage-01-critic.md`가 생기고, 그 쓰기는 critic lane 예산에 셉니다. 이때 세션 id는 기록되지 않습니다(자기 lane일 때만 기록, 아래). `intent`·`disposition`·`final`도 역할이 쓸 수 있습니다.
- **역할이 넘기는 `run_id`도 그대로 씁니다.** 새 값이면 run이 바뀌고 판정·stuck·`auto_handoff` 필드가 지워집니다([stages-and-ledger.md](stages-and-ledger.md)). 프롬프트는 과제가 준 `run_id`만 쓰라고 합니다.
- **`state`로 상태를 병합할 수 있습니다.** phase는 전이 표 안에서만 바뀌지만, `{"active": false}`(Stop here)나 다른 필드도 역할이 쓸 수 있습니다(`patchStateTx`, `store.ts:1001-1079`). 프롬프트는 "Workflow persistence and state go through the `ralplan` tool (`write`, `status`, `state`), not `shell`"이라고만 하고 언제 `state`를 쓰라고 정하지 않습니다. gjc 역할의 restricted bash도 `gjc state …`를 허용합니다(gjc `prompts/agent-fragments/restricted-bash.md`).

### 영수증만 돌려주기와 `lane_verdict`

SKILL RECEIPT-ONLY(`:55`): 역할은 `ralplan write`로 산출물을 남기고, 영수증 필드(`session_id`, `run_id`, `path`, `sha256`, 있으면 `stage`, `stage_n`)와 판정·상태만 돌려줍니다. 남긴 본문은 돌려주지 않습니다. 세 프롬프트의 Persistence 절이 같은 말을 합니다("Return the write receipt (`session_id`, `run_id`, `path`, `sha256`, `stage`, `stage_n`) and the role's compact verdict only."). 역할의 마지막 응답은 호스트가 `<subagent sessionID="…" state="completed">…</subagent>`로 감싸 리더에게 돌려줍니다(`subagent.ts:258-265`). 응답 길이나 모양을 검사하는 코드는 없습니다.

`lane_verdict`는 `architect`·`critic` 단계에서만 받습니다(`parseLaneVerdict`, `ledger.ts:1035-1053`). 앞뒤 공백을 지우고 대문자로 바꾼 뒤 검사합니다. 실제 호출 결과:

```
Error: invalid lane_verdict for architect: OKAY. Expected one of: CLEAR, WATCH, BLOCK.
```

`lane_verdict: "watch"`로 쓴 architect의 영수증(일부):

```json
{
  "session_id": "ses_root",
  "run_id": "ses_root",
  "path": "<session>/plans/ralplan/ses_root/stage-01-architect.md",
  "stage": "architect",
  "stage_n": 1,
  ...
  "architect_state": {
    "architect_id": "ses_architect"
  },
  "lane_verdict": {
    "lane": "architect",
    "verdict": "WATCH"
  }
}
```

`session_id`가 역할 자신의 세션(`ses_architect`)이 아니라 계보 루트(`ses_root`)인 점을 보세요. 역할의 세션 id는 `architect_state` 안에만 있습니다.

### 프롬프트

세 프롬프트는 gjc `packages/coding-agent/src/prompts/agents/{planner,architect,critic}.md`에 gjc 조각 `restricted-bash.md`와 `ralplan-persistence.md`를 렌더해 넣은 것입니다(`{{stage}}`는 역할 이름. gjc `task/agents.ts:41-58`의 `buildAgentContent`에서 이 문서를 쓰며 확인). 호스트 치환만 했고, 각 프롬프트 끝 "Source and host substitutions" 표가 치환을 하나씩 적습니다(ralplan 편차 33). 옛 OMC 기반 프롬프트의 글은 남아 있지 않습니다.

| 역할 | 요약 | source 절 |
|---|---|---|
| planner | 요청을 실행 가능한 계획으로 바꾸고 구현하지 않습니다. 얇은 입력은 가정, 선택지, 빠진 하위 범위, 시험 가능한 수용 기준으로 넓힙니다. 출력은 Summary, Intent Diff, Decision Drivers, Options, In/out of scope, File-level changes, Sequencing, Acceptance criteria, Verification, Escalation/Risk Gate, Verification Plan, Risks의 Markdown 하나. `question`을 쓸 수 없으므로 저장소로 풀 수 없는 결정은 가정과 열린 질문으로 Decision Drivers·Risks에 적습니다. | `prompts/open-gajae-planner.md:63-82` |
| architect | 아키텍처 리뷰와 코드 리뷰 규율. 스펙 준수 → 아키텍처 → 구성적 종합 → 품질·보안·성능 순서, 심각도 CRITICAL/HIGH/MEDIUM/LOW, 결함을 숨기는 fallback은 blocker. 출력은 Summary, Claims, Analysis, Root Cause, Findings, Recommendations, Architectural Status(`CLEAR`/`WATCH`/`BLOCK`), Code Review Recommendation(`APPROVE`/`COMMENT`/`REQUEST CHANGES`), Tradeoffs. ratchet 규칙 1–5. | `prompts/open-gajae-architect.md:100-115` |
| critic | 실행 전에 계획이 실행 가능한지 판정합니다. 파일 참조를 확인하고 대표 구현 과제 2–3개를 실제 파일에 대고 흉내 냅니다. 출력은 Verdict(`OKAY`/`ITERATE`/`REJECT`), Claim Checks, Missing Evidence, Approval Boundary, Summary, Required Changes. ratchet 규칙 1–5와 enrichment lane. | `prompts/open-gajae-critic.md:76-90` |

세 프롬프트에 공통인 것:

- 읽기 전용이고, `shell`은 읽기 전용 점검과 읽기 전용 git(`git status`, `git log`, `git show`, `git diff`, `git blame`, `git rev-parse`, `git ls-files`)에만 씁니다. 상태와 영속화는 `ralplan` 도구(`write`, `status`, `state`)로 합니다.
- Persistence (ralplan runs only): 과제가 ralplan 단계나 `stage_n`을 가리킬 때만, 과제가 준 `run_id`와 `stage_n`으로 `ralplan write(stage="<역할>", stage_n, run_id, content)`를 부릅니다. 둘 중 하나가 없으면 쓰지 않고 짧은 오류를 돌려줍니다. 자기 세션 id를 넘기거나 대신 쓰지 않습니다. 중복 쓰기 오류면 N을 올려 다시 씁니다. ralplan 과제가 아니면 쓰지 않고 결과 전체를 응답에 넣습니다.
- planner만: 과제가 영속화를 끄면("do not persist" 등) 문서 전체를 응답에 넣는 inline-output 예외(`:58-60`).

주요 호스트 치환(ralplan 편차 33과 2, 32): frontmatter(`tools`, `thinking-level`, `bashAllowedPrefixes` 등)를 지우고 설명·모델·권한은 `src/config.ts`와 설정에서 옴, `{{restrictedBash}}`를 읽기 전용 `shell` 문장으로, gjc의 "owner `session_id`와 `run_id` 필요"를 "`run_id`와 `stage_n` 필요"로(주인은 계보에서), `gjc ralplan --write … --artifact-env …`를 `ralplan write(…, content)`로, planner의 "Ask only about … headless면 묻지 않음"을 늘 headless 규칙으로, architect의 forkContext 문장과 `report_finding` 절 삭제, `yield.result.data`를 최종 응답으로, `autoresearch` 삭제(편차 6).

같은 두 리뷰어 프롬프트를 ultragoal도 바꾸지 않고 다시 씁니다([../ultragoal/guards.md](../ultragoal/guards.md) "architect와 critic").

**planner와 `revision` 단계.** planner 프롬프트의 Persistence 예시는 `stage="planner"`뿐입니다. gjc도 `{{stage}}`를 agent 이름으로 렌더하므로 같습니다. 한편 SKILL은 재리뷰 루프의 계획 수정을 `revision`으로 쓰라고 하고(`:97`), 한 곳에서는 revision을 리더 쪽 쓰기로(`:57` "every parent-side revision/post-interview/ADR/final write"), 다른 곳에서는 Planner의 정상 쓰기로(`:203-207` 표의 "Planner | `planner` or `revision`") 적습니다. 코드는 어느 쪽이든 받습니다.

- planner 역할이 `revision`이나 `planner`를 쓰면 `planner_subagent_id`가 기록됩니다. 둘 다 opener라서 회차를 하나 씁니다.
- 리더가 `revision`을 쓰면 세션 id는 기록되지 않습니다(리더는 역할이 아님). `resumable`·fallback 필드는 리더가 넘겨도 planner 몫으로 기록됩니다.
- planner가 `revision` 대신 `planner`를 쓰면 phase는 `planner`가 되고, 표에 `critic → planner` 같은 간선이 없어 감사 행이 남습니다.

그래서 과제가 단계 이름(`revision`)을 분명히 적어야 SKILL의 흐름과 맞습니다.

## OpenCode에서 subagent 재개와 조종

SKILL "Persisted role agents"(`:185-209`)는 gjc의 분리·재개 가능한 subagent를 OpenCode `subagent` 도구로 옮겼습니다. 아래는 호스트 v2.0.15 `opencode/packages/core/src/tool/plugin/subagent.ts`의 동작입니다.

### 띄우기, 재개, 조종

`subagent` 입력은 `agent`, `description`, `prompt`가 필수이고 `model`, `sessionID`, `background`가 선택입니다(`:29-48`). 처리 순서:

1. 부모 세션을 읽고 깊이를 셉니다. 한도 이상이면 거부(`:110-133`).
2. `agent`를 찾고(`Unknown agent: <agent>`), `primary` 모드면 거부(`Agent <agent> cannot run as a subagent`), 권한을 확인합니다(`Subagent denied: <id>`) (`:134-151`).
3. `sessionID`가 있으면 그 세션을 읽습니다. 없으면 `Subagent session not found: <sessionID>`(`:153-163`). 그 세션의 부모가 부른 세션이 아니면 `Session <id> is not a child of the current session`(`:164-167`).
4. 기존 세션의 agent가 다르면 그 agent로 바꾸고, 필요하면 모델도 바꿉니다. 실패하면 `Failed to switch subagent session: <id>`(`:171-182`).
5. `sessionID`가 없으면 부른 세션을 부모로 새 자식 세션을 만듭니다(`:185-198`).
6. 자식에게 프롬프트를 넣습니다. 새 세션이면 앞에 `You are a subagent spawned by another session.` 한 줄이 붙습니다. 이 넣기는 쉬고 있는 자식은 시작시키고, **돌고 있는 자식은 조종(steer)합니다**(`:203-218` 주석). 실패하면 `Failed to prompt subagent: <id>`.
7. `background: true`면 바로 `status: "running"`과 안내 글을 돌려줍니다(`:229-232`, 글은 `:19-27`). 아니면 자식이 끝날 때까지 기다립니다(`:234-240`). 기다리는 중 job이 background로 넘어가면 역시 `running`을 돌려줍니다(`:241-244`).
8. 끝난 결과: 오류면 `Subagent failed (sessionID: <id>): <오류>`, 취소면 `Subagent cancelled (sessionID: <id>)`, 아니면 `status: "completed"`와 자식의 마지막 응답(`:246-256`). 실패 문구에도 `sessionID`를 넣는 것은 모델이 그 자식을 이어 갈 수 있게 하려는 것입니다(`:245` 주석).

그래서 리더가 돌려받는 `sessionID`는 역할의 자식 세션 id이고, 그 역할이 `ralplan write`를 부를 때의 `context.sessionID`와 같습니다. 도구가 자동으로 기록하는 id(`planner_subagent_id` 등)가 바로 이 값입니다.

### 병렬과 background

- pass 1 fan-out은 한 메시지 안의 foreground `subagent` 호출 둘입니다. 각각 자기 fiber에서 돌고(`step.ts:117-128`), 리더는 두 결과를 함께 받습니다.
- `background: true`는 SKILL이 요구하지 않습니다. 재개 경로표가 `status: "running"`의 예로 들 뿐입니다. background 자식이 도는 동안 플러그인은 리더 세션의 continuation을 건너뛰고, 자식이 끝나면 호스트가 부모를 다시 깨웁니다([guards-and-continuation.md](guards-and-continuation.md), `src/hooks.ts:550-556`, `:1269-1275`).

### 재개 경로표와 호스트 결과

SKILL의 재개 경로표(`:191-197`)를 호스트가 실제로 내는 결과에 맞춘 표입니다. `fallback_reason` 값은 코드가 받는 여섯 가지(`KNOWN_FALLBACK_REASONS`, `ledger.ts:85-92`) 중 하나입니다.

| 호스트 결과 | SKILL 경로 | 기록할 `fallback_reason` |
|---|---|---|
| 앞선 호출이 `status: "running"`(background) | 같은 `sessionID`로 다시 불러 조종하고 기다림. 새로 띄우지 않음 | — |
| 앞선 호출이 `status: "completed"`, `Subagent failed …`, `Subagent cancelled …` | 같은 `sessionID`로 재개. 그 호출이 실패하면 새로 띄움 | 실패 문구에 따라 아래 |
| `Subagent session not found: <id>` | 새로 띄움 | `not_found` |
| `Session <id> is not a child of the current session` | 새로 띄움, `resumable: false` 기록 | `context_unavailable` |
| `Failed to prompt subagent: <id>`, `Failed to switch subagent session: <id>` 등 다른 실패 | 새로 띄움 | `resume_failed` |
| OpenCode 재시작 뒤 재개 실패 | 새로 띄움 | `process_restart` |
| 기록된 id가 없음 | 새로 띄움 | `missing_record` |
| (호스트에 없음) | — | `no_runner`는 받기만 함 |

gjc의 `queued` 결과는 OpenCode에 없어서 SKILL에서 그 행을 뺐습니다(SKILL source 표 `:262`). 재개 호출에서 `Subagent depth limit reached …`나 `Subagent denied: …`가 나오는 경우는 SKILL 표에 없습니다.

### 지속 경계

SKILL(`:189`): 같은 부모 안에서만 이어집니다. `subagent(sessionID)`는 부른 세션의 자식이고 호스트가 아직 가진 세션만 이어 가며, `.open-gajae` run 상태만으로는 역할을 재개할 수 없습니다.

- 호스트는 부모가 다르면 거부합니다(`subagent.ts:164-167`). 리더가 같은 세션에 있는 한, 마지막 호출이 끝난 자식도 재개됩니다.
- 호스트의 세션은 데이터베이스에 저장되므로(`core/src/session.ts`가 `Database`를 씀) OpenCode를 다시 시작한 뒤에도 `subagent(sessionID)`가 성공할 가능성이 있어 보입니다. 재시작 뒤 실제로 재개되는지는 이 문서를 쓰며 확인하지 않았습니다. `process_restart`는 그런 실패가 관찰됐을 때 쓰는 값일 뿐입니다.

### 역할 메타데이터 기록 (ralplan 편차 5)

gjc는 `--planner-id`·`--architect-id`·`--critic-id`와 역할별 `--*-resumable` 플래그를 받습니다. open-gajae는 부른 역할의 `context.sessionID`를 도구가 직접 기록하고, `resumable` 입력 하나를 둡니다(`tool.ts:235-247`).

| 역할 | 기록되는 단계 | 자동 기록 | 선택 입력 |
|---|---|---|---|
| planner | `planner`, `revision` | `planner_subagent_id` | `resumable` → `planner_resumable` |
| architect | `architect` | `architect_id` | `resumable` → `architect_resumable` |
| critic | `critic` | `critic_id` | `resumable` → `critic_resumable` |

- 자동 기록은 부른 agent가 그 역할이고 단계가 자기 lane일 때만입니다(`persistedRoleForStage`, `ledger.ts:908-912`; `tool.ts:236-239`). 리더가 쓴 `revision`이나 다른 역할의 단계에는 id가 붙지 않습니다.
- id는 `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`이어야 합니다(`SUBAGENT_ID_RE`, `ledger.ts:94`).
- fallback 필드는 그 역할의 정상 쓰기에 실어 보냅니다: `fallback_reason`, `fallback_attempted_id`, `fallback_stage_n`, 선택 `fallback_receipt_path`. 상태에는 `<역할>_fallback_reason` 등으로 남습니다(`persistedRoleStatePayload`, `ledger.ts:1016-1032`). 하나라도 있으면 앞의 셋이 모두 있어야 합니다(`parsePersistedRoleState`, `ledger.ts:931-1013`). 실제 거부 문구:

  ```
  Error: fallback_attempted_id is required when recording planner fallback metadata.
  Error: resumable is only valid with stage planner, revision, architect, or critic (received intent).
  ```

- 새로 띄운 역할이 쓰면 그 새 세션 id가 이전 id를 덮습니다(상태 병합, `mergeRunStateTx`, `store.ts:548-565`). 그래서 상태에는 늘 마지막에 쓴 세션이 남습니다.
- 같은 내용의 중복 쓰기(ledger에 이미 있는 행)는 아무것도 바꾸지 않습니다. 그 쓰기에 실은 id·판정도 기록되지 않습니다(`tests/ralplan-tool.test.ts` "write: stage files, ledger rows, receipts, role ids, verdicts, …").
- 새 `run_id`로 run이 바뀌면 판정·stuck·`auto_handoff`는 지워지지만 역할 id와 fallback 필드는 남습니다(`persistActiveRunIdTx`, `store.ts:513-545`). 넘겨받은 run(`ultragoal handoff(to:"ralplan")` 등)도 공통 인계가 기존 상태 위에 병합하므로(`handoffWorkflowTx`, `src/skill-state/handoff.ts:224-240`) 이전 run의 역할 id가 남아 있을 수 있습니다.
- 이 값을 읽는 코드는 없습니다. 리더가 `ralplan status`로 읽어 재개에 씁니다. 기록된 id는 재개 가능함을 증명하지 않습니다(SKILL `:201`). `resumable`은 부모 세션이 지속됨이 확실할 때만 `true`, `context_unavailable`을 본 뒤에는 `false`, 그 밖에는 넣지 않습니다(`:209`). 코드는 값만 기록합니다.

planner가 `resumable: true`로 쓴 영수증의 끝(실제 출력):

```json
  "planner_state": {
    "planner_subagent_id": "ses_planner",
    "planner_resumable": true
  }
```

리더가 fallback 셋을 실어 `revision`을 쓴 영수증의 끝(실제 출력, 리더라서 id는 없음):

```json
  "planner_state": {
    "planner_fallback_reason": "not_found",
    "planner_fallback_attempted_id": "ses_planner",
    "planner_fallback_stage_n": 2
  }
```

## `--interactive`와 `--deliberate`

`ralplan start`의 입력 `interactive`, `deliberate`(boolean, `tool.ts:105-106`)가 gjc 플래그에 해당합니다. `startRunTx`(`store.ts:915-988`)가 저장합니다.

| 입력 | 상태에 남는 것 | 그 밖에 |
|---|---|---|
| `deliberate: true` | `mode: "deliberate"`(아니면 `"short"`) (`:931`, `:946`) | `start` 결과의 `mode` |
| `interactive: true` | `interactive: true`(아니면 `false`) (`:932`, `:947`) | `start` 결과에는 없음 |

둘 다 start 때 활성 행 HUD의 `summary` 문장(`short run · automated` 꼴, `:970`)에도 들어가지만, 다음 `write`가 `persisted <stage> stage <n>`으로 덮습니다(`:860`).

이 뒤로 두 값을 읽어 동작을 바꾸는 코드는 없습니다. 이 문서를 쓰며 `src` 전체에서 찾아본 결과, `mode`를 읽는 곳은 상태의 `current_phase`가 문자열이 아닐 때 HUD `stage` 칩의 대체값으로 쓰는 `buildRalplanHudFromState`(`hud.ts:191-197`)뿐이고, `interactive`를 읽는 곳은 없습니다. gjc `gjc-runtime/ralplan-runtime.ts`도 두 값을 seed에서 상태에 쓰고(`:2404-2405`) 결과 줄과 HUD 문장에 적을 뿐입니다(`:2453`, `:2470`). gjc도 `mode`는 같은 HUD 대체값으로만 읽고(`buildHudForMode`의 ralplan 분기, `gjc-runtime/state-runtime.ts:855-860`; open-gajae `hud.ts:191-197`이 이것을 옮긴 것), `interactive`는 gjc의 다른 파일에서 manifest의 kickoff 플래그 선언(`gjc-runtime/workflow-manifest.ts:260`) 말고 읽는 곳을 찾지 못했습니다. 리더는 `ralplan status`로 읽을 수 있습니다.

`start` 없이 생긴 run에는 두 필드가 없습니다: `write`로 생긴 run, `ultragoal handoff(to:"ralplan")`나 `deep-interview handoff(to:"ralplan")`로 넘겨받은 run(이전 상태에 있던 값이 남음). deep-interview의 결합 호출 `spec(…, handoff:"ralplan")`은 `startRunTx`를 `deliberate: true`로 불러 `mode: "deliberate"`, `interactive: false`를 남깁니다(`src/deep-interview-runtime/store.ts:555`).

SKILL이 바꾸는 것:

- `--interactive`(`:21`): 2e의 초안 확인 질문(Proceed to review / Request changes / Skip review)이 더해집니다. Flags 절은 final 승인 질문도 말하지만, 8단계는 승인 질문을 `--interactive`와 상관없이 하므로 interactive만의 차이는 2e입니다.
- `--deliberate`(`:22`, `:68`): Planner 산출물에 pre-mortem 3개와 확장 테스트 계획(unit/integration/e2e/observability)이 들어갑니다. 인증·보안, migration, 파괴적 작업, 장애, 규정·개인정보, 공개 API 깨짐 같은 명시적 위험이 있으면 스스로 켜질 수 있다고 적지만, 켜는 판단도 모델 몫입니다. 리더 프롬프트도 구조·순서 위험이 드러난 일에 `ralplan --deliberate`를 권합니다(`prompts/open-gajae.md:24`). planner 프롬프트에는 deliberate 모드 이야기가 없으므로 과제가 전해야 합니다.

## `question` 사용

`question`은 호스트 도구이고(`opencode/packages/core/src/tool/plugin/question.ts`), 리더만 씁니다. 세 역할은 `question`이 거부·숨김이라 사용자에게 묻지 못합니다. planner 프롬프트는 그래서 열린 결정을 계획에 적게 합니다(`:16`).

| 언제 | SKILL | 늘? |
|---|---|---|
| 사전 의도 맞추기, 열린 항목마다 하나씩 | 2b(`:71`) | 열린 항목이 있을 때만 |
| 맞춘 초안 확인(Proceed to review / Request changes / Skip review) | 2e(`:74`) | `--interactive`일 때만 |
| 사후 의도 확인, 하나씩 | 6c(`:105-108`) | 열린 항목이 있으면 늘(`--interactive`와 무관). 합의 뒤 산문으로 멈추지 않음 |
| 최종 승인 | 8(`:111-116`) | `auto_handoff`가 `off`이고 stuck이 아니며 사용자가 아직 실행을 고르지 않았을 때 |

호스트 동작:

- 입력은 `questions` 배열이고, 질문마다 `question`, `header`, `options`(`label`, `description`), `multiple?`입니다(`question.ts:23-25`, `opencode/packages/schema/src/question.ts:6-16`).
- 자유 입력 칸은 호스트가 늘 더합니다. 도구 설명이 "A "Type your own answer" option is added automatically; don't include a separate option for free form answers"라고 하고(`question.ts:19`), 폼 필드가 `custom: true`입니다(`:126`). SKILL도 "The host adds a free-text answer to every `question`; do not add one yourself"라고 적습니다(`:116`).
- 답은 모델에게 `User has answered your questions: "<질문>"="<답>". You can now continue with the user's answers in mind.`로 돌아옵니다(`toModelContent`, `question.ts:38-46`).
- gjc의 `workflowGate: { stage: "ralplan", kind: "approval" }` 표식은 없습니다. OpenCode `question`에 그런 필드가 없기 때문입니다(ralplan 편차 8).
- 호스트 설명은 추천 선택지를 **맨 앞에** 두고 "(Recommended)"를 붙이라고 합니다(`question.ts:21`). SKILL의 승인 선택지는 gjc 그대로 Refine further가 먼저이고 추천 선택지가 둘째입니다.

**질문이 열려 있는 동안 continuation은 돌지 않습니다.** 루트 README "Consensus flow" 문단(`README.md:169`)의 주장이고, 코드로 확인됩니다. `question`은 폼의 답이 올 때까지 `Deferred.await`로 도구 호출을 붙잡고(`opencode/packages/core/src/form.ts:148-153`), 리더 세션의 execution은 그동안 끝나지 않습니다. 플러그인의 ralplan continuation은 루트 세션의 `session.execution.succeeded`에서만 돕니다(`src/hooks.ts:1285-1286`). 실제 OpenCode에서 실행해 확인하지는 않았습니다. 질문을 닫으면(dismiss) 그 execution이 어떻게 끝나고 정지 표식이 어떻게 남는지는 [guards-and-continuation.md](guards-and-continuation.md)에 있습니다.

## 최종 승인과 admission

SKILL 8–9단계(`:111-129`). `final` 영수증의 `auto_handoff`가 갈림길입니다. 값을 계산하는 방법(설정 `ralplan.autoHandoff`, stuck이면 `off`, 중복 영수증의 `admission_unavailable`)은 [stages-and-ledger.md](stages-and-ledger.md)에 있습니다.

```
final 영수증의 auto_handoff
  ├ degradationReason "planning_stuck"  → 끝. pending approval 유지, 보내지 않음, 승인 질문 없음
  ├ effectiveTarget "ultragoal"         → 승인으로 간주. 질문 없이 9단계
  └ effectiveTarget "off"               → 이번 턴에 사용자가 이미 ultragoal을 골랐나?
        ├ 예 (ultragoal, @ultragoal, skill id ultragoal, "Approve execution via ultragoal")
        │                                → 다시 묻지 않고 9단계
        └ 아니오                          → question (아래 선택지 셋)
```

승인 질문의 선택지(SKILL `:112-114`, 그대로):

```
- **Refine further** — re-run the consensus loop / request changes, then return here
- **Approve execution via ultragoal (Recommended)** — goal-tracked autonomous execution
- **Stop here** — keep the plan as `pending approval` and make no further changes
```

9단계:

- 승인(또는 자동 admission): `ralplan handoff(to="ultragoal")` → `skill ultragoal` → `pending_approval_path`의 계획을 읽고 `ultragoal create`. 같은 execution에서 ralplan을 로드했다면 `skill ultragoal` 로드가 handoff를 대신합니다([entry-and-handoff.md](entry-and-handoff.md)).
- Refine further: 5단계로 돌아갑니다. `final`은 잠긴 phase라서 이후 쓰기는 상태 phase를 `final`에 둔 채 단계 파일만 더하고, 새 `final`이 `pending-approval.md`를 덮습니다.
- Stop here: `ralplan state(patch={"active": false})`. phase는 `final`에 남고 활성 행이 지워집니다.

코드가 하는 것과 하지 않는 것:

- `auto_handoff`를 읽어 스스로 handoff하는 코드는 없습니다. `effectiveTarget`을 동작을 정하려고 읽는 코드도 없습니다. 읽는 곳은 HUD `handoff` 칩(`hud.ts:94-104`)과, 중복·복구 쓰기의 영수증을 다시 만들 때 index의 final 행에서 admission을 꺼내는 `parseRalplanFinalAdmission`(`ledger.ts:790-817`)뿐입니다. 자동 admission도 리더가 9단계를 실행해야 일어납니다.
- `ralplan handoff`는 활성 ralplan과 T의 phase만 확인합니다(`ralplanHandoffTx`, `store.ts:1328-1371`). 승인 여부도, `planning_stuck`도 보지 않습니다. 같은 execution의 `skill ultragoal` 게이트(`ultragoalGate`, `src/hooks.ts:796-818`)도 마찬가지입니다. `maxIterations: 1`, `autoHandoff: "ultragoal"`로 `planner` 하나 뒤 `revision`을 열어 PLANNING-STUCK을 받고 `final`을 쓴 뒤 `ralplan handoff(to:"ultragoal")`를 부르면, `final` 영수증은 `"effectiveTarget": "off", "degradationReason": "planning_stuck"`인데 handoff는 그대로 됩니다(실제 실행 결과 첫 줄):

  ```
  Handed off to ultragoal: ralplan is inactive (phase handoff) and ultragoal is active in goal-planning. Load the `ultragoal` skill now and call `ultragoal create` with the approved plan's goals (the approved plan: <session>/plans/ralplan/ses_root/pending-approval.md).
  ```

  "stuck이면 보내지 않음"은 SKILL만의 규칙입니다.
- `final`은 terminal phase라서 ralplan continuation이 돌지 않습니다(`shouldContinue`, `src/ralplan.ts:121-138`). `final`을 쓰고 승인 질문 없이 턴을 끝내면 세션은 그대로 쉽니다(ralplan 편차 10의 영향).

## Pre-Execution Gate

SKILL `:211-224`는 모호한 실행 요청(`fix this`, `build the app` 등)을 ralplan으로 돌리고, 파일 경로·이슈 번호·심볼·테스트·번호 단계·수용 기준·오류 참조·코드 블록·`force:`/`!` 접두가 있으면 통과시키는 gate를 적습니다.

**이 gate를 구현한 코드는 없습니다.** 이 문서를 쓰며 `src`에서 찾아본 결과:

- 요청의 구체성을 판정하거나 실행 skill 요청을 ralplan으로 돌리는 코드는 없습니다.
- `force:`와 `!`가 나오는 곳은 키워드 감지의 직접 호출 접두 `hasDirectInvocationPrefix`(`src/ralplan.ts:495-498`)뿐입니다. 이것은 "`force: ralplan …`"처럼 접두 뒤의 **ralplan 키워드**를 호출로 인정하는 OMC 유래 규칙이고, gate를 건너뛰는 장치가 아닙니다([entry-and-handoff.md](entry-and-handoff.md)).
- `ultragoal` 로드나 `ultragoal create`도 요청이 구체적인지 보지 않습니다.

그래서 이 절은 리더에게 주는 글로만 작동합니다. gjc 쪽은 `hooks/skill-keywords.ts`에 `$ralplan` 키워드만 보였고 이런 판정은 보이지 않았지만, gjc 전체를 확인하지는 않았습니다.

SKILL frontmatter의 `description`(`Consensus planning with Planner, Architect, and Critic until agreement, using RALPLAN-DR structured deliberation`)은 gjc 값이 아닙니다. gjc 값(`Consensus planning entrypoint that auto-gates vague ultragoal requests before execution`)은 이 플러그인이 구현하지 않은 키워드 gate를 설명하므로, 이전 OMC 기반 open-gajae SKILL(처음 추가한 커밋 `58ca0e1`)의 값을 남겼습니다(SKILL source 절 `:228`). 호스트에 등록되는 skill 설명은 이 값입니다(`loadSkills`, `src/config.ts:408-431`).

## 두 pass 예시 호출 순서

pass 1에서 Architect `WATCH`, Critic `ITERATE`가 나와 revision 한 번 뒤 pass 2에서 합의하고, 승인 뒤 ultragoal로 넘기는 run입니다. `ralplan` 호출(번호에 ★)은 기준 코드를 임시 `StateStore` 위에서 실제로 불러 얻은 결과이고(역할 세션은 `ses_planner`, `ses_architect`, `ses_critic`, 루트는 `ses_root`, 설정은 기본값), `subagent`·`question`·`skill` 호출은 SKILL이 정한 자리를 표시한 것입니다(실행하지 않음). 파일은 run 폴더 `plans/ralplan/ses_root/` 기준입니다.

| # | 호출자 | 호출 | 만드는 파일 | 호출 뒤 phase (active) | `invalid_transition_detected` |
|---|---|---|---|---|---|
| 1★ | 리더 | `ralplan start(task)` | (상태, 활성 행, 스냅숏) | `planner` (true) | — |
| 2 | 리더 | `subagent(agent: open-gajae-planner, prompt: 과제 + run_id + stage planner, stage_n 1)` | — | — | — |
| 3★ | planner | `ralplan write(stage:"planner", stage_n:1, run_id, content)` | `stage-01-planner.md`, `index.jsonl` 한 줄 | `planner` (true) | — |
| 4 | 리더 | (열린 항목이 있으면) `question` | — | — | — |
| 5★ | 리더 | `ralplan write(stage:"intent", stage_n:1, …)` | `stage-01-intent.md` | `intent` (true) | — |
| 6 | 리더 | 한 메시지에 `subagent(open-gajae-architect, …)`와 `subagent(open-gajae-critic, …)` | — | — | — |
| 7★ | architect | `ralplan write(stage:"architect", stage_n:1, lane_verdict:"WATCH", …)` | `stage-01-architect.md` | `architect` (true) | — |
| 8★ | critic | `ralplan write(stage:"critic", stage_n:1, lane_verdict:"ITERATE", …)` | `stage-01-critic.md` | `critic` (true) | — |
| 9 | 리더 | join gate(충돌 없음) → `subagent(sessionID: planner id, prompt: 모은 지적 + 영수증)` | — | — | — |
| 10★ | planner | `ralplan write(stage:"revision", stage_n:2, …)` | `stage-02-revision.md` (회차 2) | `revision` (true) | — |
| 11 | 리더 | `subagent(sessionID: architect id, prompt: review pass 2 묶음)` | — | — | — |
| 12★ | architect | `ralplan write(stage:"architect", stage_n:2, lane_verdict:"CLEAR", …)` | `stage-02-architect.md` | `architect` (true) | `revision→architect` |
| 13 | 리더 | `subagent(sessionID: critic id, prompt: review pass 2 묶음 + #12 영수증)` | — | — | — |
| 14★ | critic | `ralplan write(stage:"critic", stage_n:2, lane_verdict:"OKAY", …)` | `stage-02-critic.md` | `critic` (true) | — |
| 15 | 리더 | (새 열린 항목이 있으면) `question` | — | — | — |
| 16★ | 리더 | `ralplan write(stage:"post-interview", stage_n:2, …)` | `stage-02-post-interview.md` | `post-interview` (true) | — |
| 17★ | 리더 | `ralplan write(stage:"final", stage_n:2, …)` | `stage-02-final.md`, `pending-approval.md` | `final` (true) | `post-interview→final` |
| 18 | 리더 | `question`(선택지 셋) → 사용자가 Approve execution via ultragoal | — | — | — |
| 19★ | 리더 | `ralplan handoff(to:"ultragoal")` | (ultragoal 상태, 두 행, 스냅숏, 인계 저널) | `handoff` (false) | — |
| 20 | 리더 | `skill ultragoal` → `ultragoal create` | — | — | — |

- #17의 영수증 `auto_handoff`는 `{"configuredTarget":"off","effectiveTarget":"off","degradationReason":null,"source":"default"}`이므로 #18에서 승인 질문을 합니다.
- #19 뒤 `ralplan status`에 남은 역할 필드(실제 출력): `"mode":"short"`, `"interactive":false`, `"planner_subagent_id":"ses_planner"`, `"architect_id":"ses_architect"`, `"critic_id":"ses_critic"`, `"last_review_verdict":"OKAY"`, `"last_review_verdict_lane":"critic"`, `"last_review_verdict_stage_n":2`. Architect의 `CLEAR`는 #14가 덮어 상태에 없습니다.
- #19가 남긴 감사 행은 verb로 `write-transaction-journal` 다섯, `handoff` 둘, `write-active-entry` 둘, `rebuild-active-snapshot` 하나, `remove-transaction-journal` 하나입니다. 인계의 단계는 [entry-and-handoff.md](entry-and-handoff.md)에 있습니다.
- 끝난 run 폴더(실제 출력): `index.jsonl pending-approval.md stage-01-architect.md stage-01-critic.md stage-01-intent.md stage-01-planner.md stage-02-architect.md stage-02-critic.md stage-02-final.md stage-02-post-interview.md stage-02-revision.md`. `index.jsonl`의 단계 순서는 `planner/1 intent/1 architect/1 critic/1 revision/2 architect/2 critic/2 post-interview/2 final/2`입니다.

pass 1의 두 쓰기는 병렬이라 어느 쪽이 먼저 올지 정해져 있지 않습니다. Critic이 먼저 오면 같은 run에서 감사 행이 이렇게 늘어납니다(실제 실행):

| # | 쓰기 | `invalid_transition_detected` |
|---|---|---|
| 7′ | critic/1 | `intent→critic` |
| 8′ | architect/1 | `critic→architect` |
| 10 | revision/2 | `architect→revision` |
| 12 | architect/2 | `revision→architect` |
| 17 | final/2 | `post-interview→final` |

이 행들은 경고일 뿐이고 쓰기는 모두 성공합니다. 전이 표와 감사 행 모양은 [state-and-files.md](state-and-files.md)와 [stages-and-ledger.md](stages-and-ledger.md)에 있습니다.

## 코드가 강제하는 것과 SKILL·프롬프트만 요구하는 것

| 규칙 | 코드 | SKILL·프롬프트만 |
|---|---|---|
| 역할은 파일을 고치지 않음 | 예(`edit` 거부, 사용자 호스트 설정이 풀 수 있음) | `shell`은 프롬프트로만 |
| 역할은 사용자에게 묻지 않음 | 예(`question` 거부·숨김) | |
| architect·critic은 위임하지 않음, planner는 explore·document-specialist에게만 | 예(`subagent` 규칙; planner는 `subagent_depth` 2 이상 필요) | |
| 역할은 `ralplan`의 `write`·`status`·`state`만 | 예(`ROLE_OPS`) | |
| 역할은 `content`만 넘김 | 예(`path` 거부) | |
| 역할 쓰기는 리더 세션의 run에 들어감 | 예(계보 루트가 주인) | |
| 역할은 자기 lane 단계만 씀, 과제의 `run_id`만 씀, `state`를 함부로 바꾸지 않음 | | 예 |
| 역할 세션 id 기록 | 예(자기 lane일 때 자동) | 기록된 id로 재개하는 일 |
| `resumable`·fallback 필드의 모양과 짝 | 예 | 언제 넣는지, 무슨 값인지 |
| `lane_verdict` 토큰 | 예(넣었을 때만) | 넣으라는 지시 |
| 영수증만 돌려주기 | | 예 |
| Planner·Architect·Critic을 run마다 한 번 띄우고 재개 | | 예 |
| pass 1 병렬(plan-only critic), pass 2부터 순차 | | 예(다른 순서는 감사 행만 남음) |
| join gate: 같은 pass에 두 판정, `CLEAR`+`APPROVE`+`OKAY` | | 예(상태엔 마지막 판정 하나뿐) |
| 충돌이 있으면 revision 전에 disposition | | 예 |
| disposition의 스키마·처분·출처 | 예(쓸 때) | |
| 회차 상한, lane 예산, PLANNING-STUCK 결과 | 예 | |
| review pass N, 재리뷰 문맥 묶음, 다섯 규칙 ratchet | | 예 |
| `intent`·`post-interview`·`final`의 내용(ADR, Intent Reconciliation) | | 예 |
| 질문을 `question`으로 하나씩 | | 예 |
| `--interactive`·`--deliberate`의 효과 | 기록만 | 예 |
| final의 `auto_handoff` 계산과 기록 | 예 | |
| `auto_handoff`에 따른 갈림, 승인 질문 | | 예 |
| stuck이거나 승인 없는 plan을 ultragoal로 보내지 않음 | | 예(`ralplan handoff`와 로드 게이트는 막지 않음) |
| handoff는 활성 ralplan의 terminal phase에서만 | 예 | |
| Pre-Execution Gate | | 예 |
