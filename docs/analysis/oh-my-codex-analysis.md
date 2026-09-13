# oh-my-codex 상세 분석 (Codex plugin)

> 대상 버전: oh-my-codex `0.21.5` 기준
> 분석 범위: `deep-interview`, `ralplan`, `ultragoal` 세 스킬 + 이를 구동하는 하네스(hook / state / question) 전반
> 독자: opencode plugin을 개발하며 이 워크플로들을 이식/참고하려는 개발자

---

## 1. 프로젝트 개요

oh-my-codex는 **Codex CLI용 플러그인**으로, Codex 위에 다중 에이전트 오케스트레이션 레이어(OMX)를 얹는다. TypeScript/Bun 기반이며, 핵심 런타임은 `src/` 아래에 있고, 스킬 계약은 `skills/<name>/SKILL.md`에 있다.

핵심 설계 사상:

> **판단이 필요한 것은 LLM(프롬프트)에게, 강제가 필요한 것은 코드(hook)에게.**

LLM은 좋은 질문/계획을 만들지만 "질문을 건너뛰거나 게이트를 무시하는 것"을 스스로 못 막는다. 그래서 결정적(deterministic) hook이 세션의 완료(Stop)와 도구 사용(PreToolUse)을 코드로 강제한다.

### 1.1 3계층 아키텍처

| 계층 | 책임 | 대표 파일 |
|------|------|-----------|
| **① Hook 런타임 (결정적)** | Codex가 부르는 네이티브 훅. 키워드 감지, state 시딩, 지시문 주입, Stop/PreToolUse 게이팅 | `src/scripts/codex-native-hook.ts`, `src/hooks/keyword-*.ts`, `src/config/codex-hooks.ts` |
| **② SKILL 계약 (프롬프트)** | LLM이 따르는 행동 규약 | `skills/<name>/SKILL.md` |
| **③ omx question 런타임 (결정적)** | 구조화 질문을 tmux에 렌더링·답 회수, obligation 상태머신 | `src/question/*.ts` |

---

## 2. Hook 런타임

### 2.1 훅 등록 — `src/config/codex-hooks.ts`

설치 시 Codex `config.toml`에 단일 스크립트(`dist/scripts/codex-native-hook.js`)를 여러 이벤트에 바인딩한다.

```
SessionStart      → codex-native-hook.js
UserPromptSubmit  → codex-native-hook.js   # 트리거 진입점
Stop              → codex-native-hook.js   # 완료 게이트
SubagentStop      → codex-native-hook.js
```

- Codex 이벤트명 → 내부 스네이크 매핑: `UserPromptSubmit → user_prompt_submit`, `Stop → stop` (`codex-hooks.ts:74-80`).
- 훅 계약: stdin으로 payload(JSON) 수신 → stdout으로 `{ hookSpecificOutput: { additionalContext }, decision, ... }` 반환. `additionalContext`는 에이전트 컨텍스트에 주입되는 텍스트, `decision:"block"`은 흐름을 막는 신호.

### 2.2 트리거 — 키워드 감지

**`src/hooks/keyword-registry.ts`** — 선언적 키워드 테이블:

```ts
{ keyword: '$deep-interview', skill: 'deep-interview', priority: 8, ... },
{ keyword: 'deep interview',  skill: 'deep-interview', priority: 8, ... },
{ keyword: 'interview me' / "don't assume" / 'ouroboros' / 'gather requirements', ... },
{ keyword: '$ralplan' / 'consensus plan', skill: 'ralplan', priority: 11, ... },
{ keyword: '$ultragoal' / 'ultragoal', skill: 'ultragoal', priority: 10, ... },
```

- `$` 접두 = explicit invocation, 나머지는 자연어 트리거.
- 충돌 해소 `compareKeywordMatches`: **priority 내림차순 → 키워드 길이 내림차순 → 알파벳순**.

**`src/hooks/keyword-detector.ts`** — 감지 엔진 (약 4000줄):

- `detectKeywords` / `detectPrimaryKeyword` (`:3552`, `:3557`) — 테이블 매칭.
- `classifyKeywordInput` (`:3474`) — "새 워크플로 활성화 vs 진행 중 인터뷰의 후속 답변 vs omx question 답변"을 구분 (`reservedInput === "omx-question-answered"` 등). 이 분류기가 없으면 인터뷰 중 사용자 답변에 들어간 키워드가 다른 스킬을 오발화시킨다.
- 스킬별 초기 phase 매핑: `deep-interview → intent-first`, `autopilot → deep-interview`(즉 autopilot도 첫 phase는 deep-interview 게이트).

### 2.3 컨텍스트 주입 — `codex-native-hook.ts`

`buildAdditionalContextMessage` (`:2697`)가 여러 조각을 `.filter(Boolean).join(" ")`로 합쳐 하나의 `additionalContext`를 만든다:

- `detectedKeywordMessage` ("detected workflow keyword ... → deep-interview")
- `buildSkillStateCliInstruction` (state는 `omx state write/read`로만 갱신하라)
- `buildDeepInterviewQuestionBridgeInstruction` — **tmux 여부에 따라 질문 방식 분기** (§4.1)
- config override 지시문 (§3.2)

### 2.4 환경 분기 — tmux vs non-tmux

`resolveExecutionEnvironment` → `deepInterviewInstruction` (`codex-native-hook.ts:2431~2506`):

| 환경 | 질문 방식 | 네이티브 도구 |
|------|-----------|----------------|
| tmux 부착 | **`omx question` 강제** | `request_user_input` **금지** |
| tmux 밖 (Codex App/native) | `omx question` 금지, 네이티브 structured question → 없으면 plain-text | 네이티브 1순위 |

---

## 3. deep-interview (codex)

### 3.1 SKILL 계약 요지 (`skills/deep-interview/SKILL.md`)

- **의도 우선 소크라테스 루프**: 실행/계획 전에 "왜 원하는가, 어디까지, 무엇을 제외, OMX가 확인 없이 결정해도 되는 범위"를 명확히.
- **프로파일 3종**:
  | 프로파일 | threshold | max rounds |
  |----------|-----------|-----------|
  | `--quick` | ≤ 0.30 | 5 |
  | `--standard` (기본) | ≤ 0.20 | 12 |
  | `--deep` | ≤ 0.15 | 20 |
- **ambiguity 가중 공식**:
  - Greenfield: `1 - (intent×0.30 + outcome×0.25 + scope×0.20 + constraints×0.15 + success×0.10)` — **5차원**
  - Brownfield: `1 - (intent×0.25 + outcome×0.20 + scope×0.20 + constraints×0.15 + success×0.10 + context×0.10)` — **6차원**
- **한 라운드에 질문 하나** (batch 금지), 가장 약한 차원 타게팅.
- 아티팩트: transcript → `.omx/interviews/{slug}-*.md`, spec → `.omx/specs/deep-interview-{slug}.md`.
- 기본 handoff: **→ `$ultragoal`** (default), `$ralplan`, `$autopilot`, `$team`.

### 3.2 config 해석 — `src/config/deep-interview.ts`

TOML 우선순위 탐색: `<cwd>/.omx/config.toml` → `<cwd>/omx.toml` → (worktree 시 projectRoot) → `~/.omx/config.toml`. `[omx.deepInterview]` 테이블 읽음. `--quick|--standard|--deep` 플래그가 config `defaultProfile`보다 우선. malformed TOML은 경고 후 무시(fail-soft).

`buildDeepInterviewConfigInstruction` (`src/hooks/deep-interview-config-instruction.ts`)가 해석된 config를 자연어 지시문으로 만들어 SKILL.md 기본값 대신 쓰게 한다.

### 3.3 codex 고유 "행동 규약" (전부 프롬프트 레벨 — 코드 강제 아님)

> **중요:** 아래 기능들은 SKILL.md의 **모델 지시**이지, 컴파일된 하네스 기능이 아니다. 어떤 훅도 이 라벨/규칙을 파싱하지 않는다. 이식 시 프롬프트로 옮기면 된다.

**(A) Fact/Judgment 라우팅** — transcript/spec 라벨:

| 라벨 | 의미 | 처리 |
|------|------|------|
| `[from-code][auto-confirmed]` | 고신뢰 정확 사실 | 안 물음. transcript만 갱신, **라운드 카운트/obligation 생성 X** |
| `[from-code]` | 저신뢰 추론 | 확인 라운드 1회 |
| `[from-research]` | 외부 사실 | 사실일 뿐 결정 아님 |
| `[from-user]` | 목표·스코프·비목표·트레이드오프 | **오직 이것만 진짜 질문** |

핵심 규칙: 어떤 발견이 "무엇을 해야 하는지/어떤 패턴/트레이드오프/스코프"를 함의하면, 사실이 있어도 **판단으로서 `[from-user]`에 라우팅**. SKILL.md는 이 라벨을 "never use them as `omx question` `source` values"로 명시 — 즉 런타임 계약이 아니라 문서 라벨.

**(B) Dialectic Rhythm Guard**: 비-사용자/확인성 답변이 **3연속**이면 다음 material 라운드는 반드시 사람 판단(`[from-user]`)을 요구.

**(C) Pressure Pass**: crystallize 전 최소 1회, 이전 답변을 근거/가정/트레이드오프로 더 깊게 재심문. "breadth without pressure is not progress." readiness 게이트에 포함.

**(D) Non-goals & Decision Boundaries 필수 게이트**: ambiguity가 threshold를 만족해도 이 둘이 explicit하지 않으면 crystallize/handoff **금지**.

---

## 4. omx question + obligation 상태머신 (③계층)

### 4.1 왜 자체 구현인가

Codex에는 네이티브 `request_user_input`이 있지만 **fire-and-forget**라, "질문을 실제로 했는지"를 남기는 디스크 흔적이 없다. deep-interview의 Stop 게이트는 그 흔적이 필요하므로 `omx question`을 자체 구현했다. tmux 안에서는 `omx question` 강제, tmux 밖에서는 네이티브로 fallback (§2.4).

### 4.2 질문 스키마 — `src/question/types.ts`

```ts
QuestionInput { question, options[{label,value,description}],
  type: 'single-answerable' | 'multi-answerable',  // multi_select와 자동 정합
  allow_other, other_label, source, session_id, questions?[] }
QuestionAnswer { kind:'option'|'other'|'multi', value, selected_labels[], selected_values[] }
```

deep-interview는 항상 `source:"deep-interview"`. `normalizeQuestionInput`이 방어 검증(type/multi_select 충돌, 빈 옵션, id 중복).

### 4.3 서브프로세스 브리지 — `src/question/client.ts`

```ts
spawn(process.execPath, [omxBin, 'question', '--json', '--input', JSON.stringify(input)])
```

stdout JSON을 파싱해 `{ ok, question_id, answers[] }` 반환. 에러 코드: `question_no_stdout`, `question_invalid_stdout`, `question_nonzero_exit`.

### 4.4 tmux 렌더러 — `src/question/renderer.ts`

전략 `resolveQuestionRendererStrategy`: `inside-tmux`(TMUX env / `OMX_QUESTION_RETURN_PANE`) / `detached-tmux` / `inline-tty` / `windows-console`. 리더 팬 리턴은 `OMX_QUESTION_RETURN_PANE=$TMUX_PANE`, transport `tmux-send-keys`. 질문 레코드는 `omx.question/v1` 스키마로 디스크 저장, status: `pending→prompting→answered|aborted|error`.

### 4.5 obligation 상태머신 — `src/question/deep-interview.ts`

하네스의 안전 심장부.

```
createDeepInterviewQuestionObligation()  → {status:'pending', source:'omx-question', lifecycle_outcome:'askuserQuestion'}
runDeepInterviewQuestion():
  1. autopilot wait 중복 방지 클레임 (동시 인터뷰 차단)
  2. obligation 'pending' 기록 (state에 active:false, run_outcome:'blocked_on_user' 동반)
  3. runOmxQuestion() 실행
  4. 성공 → satisfyDeepInterviewQuestionObligation(status:'satisfied', question_id)
     실패 → clearDeepInterviewQuestionObligation(status:'cleared', reason:'error')
```

크래시/재시작 대비 **재조정기** `reconcileDeepInterviewQuestionEnforcementFromAnsweredRecords`: pending obligation이 남으면 디스크의 답변된 question 레코드를 스캔(세션 일치 + `source==='deep-interview'` + `created_at >= requested_at`)해 자동 satisfied 처리 (idempotent).

### 4.6 Stop 게이트 — `codex-native-hook.ts`

- `SKILL_STOP_BLOCKERS = new Set(["ralplan"])` (`:233`) — ralplan은 Stop 차단 대상. deep-interview는 별도 obligation 경로.
- `buildDeepInterviewQuestionStopOutput` (`:20924`): reconcile 먼저 → state 로드 → phase가 terminal이 아니고 `question_enforcement`가 여전히 `pending`이면:
  ```
  { decision:"block", stopReason:"deep_interview_question_required",
    reason:"...has a pending structured question obligation; use `omx question` before stopping." }
  ```
- `stop_hook_active` 재진입 무한루프 방지: `allowRepeatDuringStopHook` (`:3043`).

**요점:** LLM의 자기 규율이 아니라 완료 이벤트(Stop)에서 코드가 결정적으로 거부한다.

---

## 5. ralplan (codex)

### 5.1 SKILL 계약 요지 (`skills/ralplan/SKILL.md`)

Autopilot의 `$deep-interview`와 `$ultragoal` 사이 **합의 계획 단계**. `omx ralplan run --task <...>`로 자체 consensus 런타임 구동.

**합의 워크플로 (핵심 — claudecode와 동일)**:
1. **Planner** 적응형 플랜 + RALPLAN-DR 요약(Principles 3-5 / Decision Drivers top3 / Viable Options ≥2 / 단일 옵션 시 대안 무효화 근거 / deliberate 모드는 pre-mortem 3 + 확장 테스트).
2. (`--interactive`만) 사용자 피드백.
3. **Architect** 리뷰 — steelman antithesis + 트레이드오프 tension + synthesis. **완료 대기 후 4단계.**
4. **Critic** 평가 — principle-option 일관성, 공정한 대안, 리스크 완화, testable 수용기준, 검증 단계. Architect 리뷰를 Critic에 넘기지 않음.
5. **재검토 루프 (max 5)**: 비-`APPROVE` verdict → Planner 수정 → Architect → Critic 반복. 5회 도달 시 best를 사용자에.
6~8. Critic 승인 시 실행-준비 아티팩트 + 순차 리뷰 증거 persist → `ralplan_execution_handoff` 기록 → **→ `$ultragoal`**.

> Architect·Critic은 **순차 role-specific subagent** (같은 배치 병렬 금지, Architect 완료 후 Critic).

### 5.2 Planning/Execution 경계 — PreToolUse write 제한

ralplan 활성 중 write 도구는 planning 경로(`.omx/context`,`plans`,`specs`,`state`)로만 허용. `codex-native-hook.ts`의 `isAllowedRalplanArtifactPath`/`isAllowedRalplanDraftPath` (`:4717~4730`)가 PreToolUse에서 경로 검사.

### 5.3 codex 부가 장치 (provenance/강제 계열 — claudecode에 없음)

**(A) Advisory 상태머신 (`--advisory`)**: standalone 옵트인. 동일 Planner→Architect→Critic를 돌리되 플랜+두 리뷰를 **exact-byte 바인딩 + tracker iteration**에 묶고 `active:false`로 복귀. **협조적 워크플로 일시정지지 보안 펜스가 아님** — PreToolUse allow/block 안 냄, consensus gate 완료 안 함, 실행 승인 안 함. terminal 상태는 consensus gate/host verification/execution handoff를 명시적 `false`로 기록. "local Advisory 파일/prompt/tracker ≠ host-issued authority" 반복 강조. Darwin 128 KiB / 그 외 8 MiB. 소스: `src/ralplan/advisory*.ts` (advisory.ts 53KB 등).

**(B) Native role-routing preflight**: ralplan이 역할 특화 subagent를 스폰할 **실제 권한**이 있는지 검증. 네이티브가 `role_routing_unavailable` 보고 + adapted Planner/Architect/Critic 권한 시도 시에만 `omx ralplan preflight --json`. `unsupported_documented_leader_proof` 시 정지. root 정체성을 session_id/thread_id/cwd/프롬프트 라벨로 추론 금지. 특정 검증 릴리스(0.144.5/0.145.0/0.146.1/0.148.0-alpha.5)는 adapted 권한 불가, 그 외 버전은 fail-closed. 네이티브가 `agent_type`를 노출하면 설치된 OMX role로 설정, 노출 안 하면 날조 금지.

**(C) Durable Consensus Handoff Contract**: "PRD/test-spec 파일 존재 ≠ 완료/실행가능". 실행 전 다음 구분 레코드를 persist:
- `planning_artifacts` (PRD/test-spec 경로)
- `ralplan_architect_review` (승인된 완료 리뷰)
- `ralplan_critic_review` (Architect 이후 기록, 승인)
- `ralplan_execution_handoff` `{authorized, reason, authorized_at, session_id, review_cycle, source:"autopilot"|"user"}`
- `ralplan_consensus_gate.complete` (순차 승인 후 lifecycle 완료; 호스트 보안 주장 아님)

파일만으로 ralplan 스킵/실행 금지.

### 5.4 소스 구조

`src/ralplan/`: `advisory-activation.ts`, `advisory-contract.ts`, `advisory-evidence.ts`, `runtime.ts`(31KB), `runtime-advisory-lifecycle.ts`, `documented-leader-preflight.ts`(26KB) 등. CLI: `src/cli/ralplan.ts`. 계약 문서: `docs/contracts/ralplan-consensus-gate.md`.

---

## 6. ultragoal (codex)

### 6.1 SKILL 계약 요지 (`skills/ultragoal/SKILL.md`)

브리프를 순서 있는 goal 집합으로 쪼개, start/checkpoint/blocker/failure 이벤트를 **append-only ledger**에 기록. Codex `/goal`을 병행 구동.

**이중 구조:**
| 층 | 실체 | 성격 |
|----|------|------|
| ① OMX ledger (SSOT) | `.omx/ultragoal/{brief.md, goals.json, ledger.jsonl}` | 세밀·durable, 스토리 단위 |
| ② Codex goal 포인터 | `get_goal`/`create_goal`/`update_goal` + `/goal` | 코스한 aggregate objective |

- CLI: `omx ultragoal create-goals / complete-goals / checkpoint / steer / status / record-review-blockers` (`src/cli/ultragoal.ts`, `src/ultragoal/artifacts.ts`).
- 기본 `--codex-goal-mode aggregate` (플랜 1개=포인터 1개), `per-story` 옵션.
- 스토리 완료 → checkpoint → 반복 (status 전부 complete까지).
- **steer** (codex 고유 강조): `add_subgoal / split_subgoal / reorder_pending / revise_pending_wording / annotate_ledger / mark_blocked_superseded`. 산문은 플랜 변경 못 함, 구조화 directive만.

### 6.2 최종 게이트

final 스토리 전: 타깃 검증 → `ai-slop-cleaner` 재검증 → 브리프의 아키텍처/도메인 invariant 감사 → `$code-review`(code-reviewer + architect 독립 레인). 클린하지 않으면 goal 완료 금지, `record-review-blockers`로 durable 블로커 기록. 클린 시 `update_goal({status:"complete"})` → `get_goal` → `--quality-gate-json`(cleaner/verification/review/invariant 증거)로 checkpoint. **"OMX state만으로 완료 주장 금지."**

### 6.3 강제

PreToolUse `/goal` 가드(standalone ultragoal이 다른 goal 덮어쓰기/Conductor 강탈 금지), Stop reinforcement(미완료 시 goal-mode 유지). cancel 시 runtime guard state 해제, durable ledger는 보존.

---

## 7. 이식 관점 요약 (opencode 개발자용)

| 컴포넌트 | codex 구현 형태 | 성격 |
|----------|----------------|------|
| 트리거 | UserPromptSubmit hook + keyword registry/detector | 코드 |
| state | `omx state write/read` 단일 writer, disk JSON | 코드 |
| 컨텍스트 주입 | `additionalContext` (hook stdout) | 코드 |
| 구조화 질문 | `omx question` 자체 CLI + tmux 렌더러 | 코드 (네이티브 fire-and-forget 회피 목적) |
| obligation | disk 레코드 + reconcile | 코드 |
| Stop 게이트 | Stop hook `decision:"block"` | 코드 |
| PreToolUse write 경계 (ralplan) | 경로 allow/deny | 코드 |
| deep-interview 채점/라우팅/게이트 | SKILL.md | **프롬프트** |
| ralplan 합의 루프 | SKILL.md + `omx ralplan run` 런타임 | 프롬프트 + 코드 |
| ultragoal ledger/steer | CLI + artifacts | 코드 |

→ 전체 매핑과 opencode 이식 방안은 [opencode-porting-guide.md](./opencode-porting-guide.md) 참조.

---

*본 문서는 세션 분석 기반이며, 파일:라인 앵커는 oh-my-codex 0.21.5 기준이다. 재현 시 해당 심볼 존재를 먼저 확인할 것.*
