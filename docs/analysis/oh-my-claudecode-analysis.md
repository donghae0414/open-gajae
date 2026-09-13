# oh-my-claudecode 상세 분석 (Claude Code plugin)

> 대상 버전: oh-my-claudecode `v5.4.0` 기준
> 분석 범위: `deep-interview`, `ralplan`, `ultragoal` 세 스킬 + 하네스(hook / state / question) 전반
> 독자: opencode plugin을 개발하며 이 워크플로들을 이식/참고하려는 개발자

---

## 1. 프로젝트 개요

oh-my-claudecode(OMC)는 **Claude Code용 플러그인**으로, Claude Code 위에 다중 에이전트 오케스트레이션 레이어를 얹는다. oh-my-codex와 같은 개발자가 만든 자매 프로젝트지만 **호스트가 Claude Code**라는 점에서 하네스 기반이 다르다.

- 스킬 계약: `skills/<name>/SKILL.md` (플러그인 배포 시 `skill-bodies/`로 아카이브되는 compact shim 구조).
- 하네스 소스: `src/`, 훅: `hooks/`, 상태/질문/트리거는 Claude Code의 hook·MCP 도구 기반.
- 사용자 대면 호출: `/deep-interview`, `/ralplan`, `/ultragoal` (또는 `Skill("oh-my-claudecode:<name>")`).

핵심 설계 사상은 codex와 동일: **판단은 LLM, 강제는 코드(hook)**. 다만 Claude Code의 네이티브 프리미티브(`AskUserQuestion`, `/goal` Stop hook, `Task` subagent, state MCP 도구)를 최대한 재사용한다.

### 1.1 Claude Code가 제공하는 네이티브 프리미티브 (codex 대비 핵심 차이)

| 기능 | Claude Code 네이티브 | codex는? |
|------|----------------------|----------|
| 구조화 질문 | **`AskUserQuestion`** (클릭 UI) | 없음 → `omx question` 자체 구현 |
| goal 추적 | **`/goal`** (세션 스코프 Stop hook, 조건 충족까지 종료 차단, 성공 시 auto-clear) | `get_goal/create_goal/update_goal` |
| subagent | **`Task`** | adapted role routing (권한 문제로 무거움) |
| state | MCP 도구 `state_write/read/clear/list_active/get_status` | `omx state` CLI |

→ 이 네이티브 프리미티브 덕에 OMC는 codex보다 하네스 자체 구현이 가볍다.

---

## 2. deep-interview (claudecode)

`skills/deep-interview/SKILL.md` (약 802줄 — codex 571줄보다 큼).

### 2.1 계약 요지

- Ouroboros 영감 소크라테스 질문 + **수학적 ambiguity 채점**.
- 파이프라인: **deep-interview → omc-plan consensus → pending approval → 명시적 승인 후 실행** (게이트형).
- 질문 UI: **`AskUserQuestion`** (SKILL.md가 "OMX-only 구조화 질문 transport를 도입하지 말라" 명시 = 네이티브 고수).
- 아티팩트: spec → `.omc/specs/deep-interview-{slug}.md`, 임시물은 `.omc/state/` 또는 state.
- 기본 handoff: **→ `omc-plan --consensus --direct`** (권장), autopilot, ralph, team.

### 2.2 Phase 0: Ambiguity Threshold 해석 (blocking)

Phase 1 이전, 어떤 announce/state_write/질문/채점 전에 **반드시** 먼저:

- 우선순위: 프로젝트 `./.claude/settings.json` > 유저 `~/.claude/settings.json` > 기본 `0.2`.
- 키: `omc.deepInterview.ambiguityThreshold`.
- **단일 threshold** (codex의 3-profile과 대비 — profile 개념 없음). 라운드는 고정: soft 경고 10, hard cap 20.
- 첫 사용자 대면 라인 강제: `Deep Interview threshold: <percent> (source: <source>)`. `threshold_source`를 state·최종 스펙 메타에 보존.

### 2.3 ambiguity 채점 (codex와 다른 공식)

- 차원: **goal / constraints / criteria (+ brownfield: context)** — **3~4차원**.
- Greenfield: `1 - (goal×0.40 + constraints×0.30 + criteria×0.30)`
- Brownfield: `1 - (goal×0.35 + constraints×0.25 + criteria×0.25 + context×0.15)`
- 채점 모델: opus, temperature 0.1 (일관성).

> codex는 intent/outcome을 분리한 5~6차원(intent 0.30 등). OMC는 goal 하나로 통합한 3~4차원. **이는 호환 차이가 아니라 채점 모델 자체의 차이.**

### 2.4 claudecode 고유 기능 (전부 프롬프트 레벨)

**(A) Round 0: Topology Enumeration Gate** — codex에 없음.
Phase 2 채점 **이전에** 스코프의 "모양"을 확정:
- 독립적으로 성공/실패하는 top-level 컴포넌트를 1~6개 열거 (구현 태스크/필드가 아니라 독립 산출물).
- 라운드 0에서 딱 한 번 확인 질문 → 사용자 확인 → `state.topology`에 **락**.
- Phase 2는 컴포넌트별 독립 채점 + **N개 활성 컴포넌트 간 타게팅 로테이션** → 한 컴포넌트에 깊게 파느라 형제 컴포넌트의 모호함이 가려지는 depth-first 실명 방어.
- 4-컴포넌트 픽스처 예: "CSV 수집 → 정규화 → 리뷰어 UI → export"면 Review UI만 상세해도 네 컴포넌트 모두 표면화, 상세 컴포넌트가 나머지를 흡수 금지. 스펙 `## Topology` 섹션에 각 컴포넌트 커버 또는 사용자 확인 보류 명시.

**(B) Ontology 추출 + Stability Convergence** — codex에 없음.
매 라운드 엔티티(명사) 추출 + 라운드 간 안정성 정량화:
- 각 엔티티: name / type(core·supporting·external) / fields[] / relationships[].
- 라운드 2+부터: `stable`(동명 존재), `changed`(다른 이름·같은 type·필드 50%+ 겹침 = 개명, **안정에 카운트**), `new`, `removed`.
- **`stability_ratio = (stable + changed) / total`** (1.0 = 수렴). 개명을 안정으로 세는 이유: 개념 유지 = 수렴.
- 스펙에 `## Ontology Convergence` 라운드별 추이 표. 2연속 무변화 = 도메인 모델 안정 판정.

**(C) Challenge Agents (프롬프트 주입)**:
- Round 4+ Contrarian ("반대라면?"), Round 6+ Simplifier ("최소 버전?"), Round 8+ Ontologist(ambiguity>0.3 시, "이게 본질적으로 뭔가?"). 각 1회, state에 사용 기록.

### 2.5 강제

- 실행 전: ambiguity ≤ threshold **AND** 사용자가 스코프된 실행 경로를 명시적 승인해야만. 승인 전 mutation 도구/실행 스킬/delegation 금지.
- state: `state_write/read` MCP 도구. resume: `.omc/state/deep-interview-state.json`.
- 실행 브리지: `AskUserQuestion`로 옵션 제시 → 선택 시 `Skill()`로만 bridge, 직접 구현 금지.

---

## 3. ralplan (claudecode)

`skills/ralplan/SKILL.md` (약 140줄). **`/oh-my-claudecode:plan --consensus`의 별칭.**

### 3.1 합의 워크플로 (codex와 동일한 핵심)

Planner → Architect → Critic + RALPLAN-DR 요약 + deliberate 모드 + 재검토 루프(max 5). codex와 동일하게:
- **Architect와 Critic은 순차, 개별 await** (병렬 금지, Architect 완료 후 Critic).
- 둘 다 **같은 fixed plan snapshot**을 독립 리뷰, Architect 출력을 Critic에 넘기지 않음, 결과는 Planner 합성에서만 결합.
- `--interactive`만 사용자 승인 UI(`AskUserQuestion`), 아니면 자동으로 `pending approval` 표시 후 정지.
- 기본 handoff: **→ team(권장) / ralph**.

### 3.2 claudecode 고유: `--architect codex` / `--critic codex`

Architect/Critic 패스를 **Codex CLI로** 실행 가능(가용 시). 없으면 기본 Claude 리뷰로 fallback. (호스트 교차 활용 — codex 쪽엔 없는 옵션)

### 3.3 claudecode 고유: Pre-Execution Gate (vague-prompt 자동 게이트)

**무엇:** 실행 스킬(`ralph`/`autopilot`/`team`)이 **너무 막연한 요청**으로 실행되는 걸 가로채 ralplan 합의로 강제 우회. "ralph improve the app" 같은 요청은 타깃이 없어 스코프 탐색에 사이클 낭비 + 어긋난 결과 → rework.

**판정:** concrete signal이 **하나라도** 있으면 통과(직접 실행), 없고 실효 단어 ≤15면 게이트 발동:

| 신호 | 통과 예 |
|------|---------|
| 파일 경로 | `ralph fix src/hooks/bridge.ts:326` |
| 이슈/PR 번호 | `autopilot implement #42` |
| camel/Pascal/snake 심볼 | `team fix processKeywordDetector` / `UserModel` / `user_model` |
| 테스트 러너 | `ralph npm test && fix failures` |
| 번호 단계 | `ralph do:\n1. ...\n2. ...` |
| 수용 기준 | `ralph add login - acceptance criteria: ...` |
| 에러 참조 | `ralph fix TypeError in auth` |
| 코드 블록 | ` ```ts ... ``` ` |
| 이스케이프 접두 | `force: ...` 또는 `! ...` |

**게이트 발동 예(→ ralplan):** `ralph fix this`, `autopilot build the app`, `team improve performance`, `ralph add authentication`. **우회:** `force:` / `!`.

> codex 설명에도 "auto-gates vague requests" 개념이 있으나, **OMC는 concrete-signal 표·우회·트러블슈팅까지 훨씬 상세히 문서화**되어 있다.

### 3.4 Planning/Execution 경계

ralplan은 계획 모듈. 명시적 실행 승인 전까지 산출물을 `pending approval`로 표시, mutation/커밋/PR/실행 스킬/delegation 금지.

---

## 4. ultragoal (claudecode)

`skills/ultragoal/SKILL.md` (약 103줄).

### 4.1 계약 요지 — codex와 기능적으로 동일, 호스트 goal 바인딩만 다름

브리프를 순서 있는 goal로 쪼개 **append-only ledger**에 이벤트 기록 + Claude `/goal` 병행.

| 층 | 실체 |
|----|------|
| ① OMC ledger (SSOT) | `.omc/ultragoal/{brief, goals, ledger}` |
| ② Claude goal 포인터 | **Claude Code `/goal`** (SKILL.md 표현: "세션 스코프 Stop hook — 조건 충족까지 종료 차단, 성공 시 auto-clear") |

- CLI: `omc ultragoal create-goals / complete-goals / checkpoint / status / record-review-blockers`.
- 기본 `--claude-goal-mode aggregate`, `per-story` 옵션.
- **멀티 plan-id / 병렬 세션 지원**: `--plan-id`/`--auto-plan-id`로 `.omc/ultragoal/plans/{planId}/`에 분리(동시 세션 clobber 방지). `list-plans`로 열거.

### 4.2 `/goal`의 중요 제약 (claudecode 특유)

- 셸/에이전트는 Claude `/goal` 상태를 **직접 변경 못 함**. `omc ultragoal`은 durable 아티팩트만 쓰고, 활성 에이전트가 in-session에서 읽고 행동할 **handoff 텍스트를 출력**.
- standalone Claude Code에서는 **사용자가 직접 `/goal <objective>` 타이핑**해야 함. `--claude-goal-json`은 ledger 정합만 맞추고 **PreToolUse `/goal` 가드를 만족시키지 못함** — 가드는 실제 활성 `/goal`을 관측할 때까지 도구 호출을 차단.

### 4.3 최종 게이트 (codex와 동일)

final 완료 전: `ai-slop-cleaner` + verification + `$code-review` 클린. 안 되면 `record-review-blockers`로 블로커 스토리 추가 + `/goal` 유지.

---

## 5. 강제 메커니즘 요약 (하네스 레벨)

| 메커니즘 | 형태 | 비고 |
|----------|------|------|
| 키워드 트리거 | Claude Code hook (UserPromptSubmit 계열) + `[MAGIC KEYWORD: ...]` 주입 | compact shim이 SKILL 본문을 on-demand 로드 |
| state | MCP 도구 `state_write/read/clear/list_active/get_status`, `.omc/state/sessions/{sessionId}/` | 세션 스코프 |
| 구조화 질문 | **`AskUserQuestion`** (네이티브) | 자체 구현 없음 |
| goal 추적/완료 차단 | **`/goal`** (네이티브 Stop hook) + PreToolUse `/goal` 가드 | ultragoal이 이 위에 durable 층 |
| deep-interview/ralplan Stop 차단 | Stop hook (persistent-mode) | `/oh-my-claudecode:cancel`로 해제 |
| subagent | **`Task`** (예: `Task(subagent_type="oh-my-claudecode:explore")`) | 네이티브 |

---

## 6. 이식 관점 요약 (opencode 개발자용)

핵심: **OMC의 세 스킬은 대부분 프롬프트 계약(SKILL.md) + Claude Code 네이티브 프리미티브**로 구현되어, 자체 하네스 코드가 codex보다 적다. deep-interview 고유 기능(Topology/Ontology)과 ralplan Pre-Execution Gate는 전부 프롬프트 레벨이라 이식이 용이하다.

→ 전체 매핑, codex와의 기능 등가 비교, opencode 이식 방안은 [opencode-porting-guide.md](./opencode-porting-guide.md) 참조.
→ codex 쪽 상세는 [oh-my-codex-analysis.md](./oh-my-codex-analysis.md) 참조.

---

*본 문서는 세션 분석 기반이며 oh-my-claudecode v5.4.0 SKILL.md 계약을 근거로 한다.*
