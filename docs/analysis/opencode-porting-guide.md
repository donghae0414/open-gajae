# deep-interview / ralplan / ultragoal — opencode 이식 분석 정리

> **독자:** opencode plugin을 개발하는 개발자
> **목적:** oh-my-claudecode(Claude Code)와 oh-my-codex(Codex)의 세 워크플로(`deep-interview`, `ralplan`, `ultragoal`)를 분석하고, 이를 **opencode 플러그인으로 이식**하기 위한 실전 가이드를 제공한다.
> **상세 근거 문서:**
> - [oh-my-claudecode 상세 분석](./oh-my-claudecode-analysis.md)
> - [oh-my-codex 상세 분석](./oh-my-codex-analysis.md)

---

## 0. TL;DR

1. **세 워크플로 모두 opencode로 이식 가능하다.** 셋을 함께 이식해도 필요한 **코어 패치는 단 1개**(`session.finish` 훅 신설)뿐이고, 나머지는 전부 플러그인 + 커스텀 agent + 기존 프리미티브(`question`/`task`/`todowrite`/`permission.ask`)로 구현된다.
2. **두 원본은 "호환 차이만 빼면 동일"이 아니다.** `ultragoal`은 사실상 동일(호스트 goal 바인딩만 다름), `ralplan`은 핵심만 동일(주변 장치 상이), `deep-interview`는 기능 자체가 갈라져 있다.
3. **두 원본의 차이는 대부분 프롬프트 계약(SKILL.md) 레벨**이다. 컴파일된 하네스는 형태가 대체로 공유되고, 갈라진 건 "모델에게 무엇을 시키는가"다. → 이식 시 좋은 아이디어를 **취사선택(merge)** 하는 게 최적.

---

## 1. 두 원본의 핵심 아키텍처 (공통 골격)

두 프로젝트 모두 동일한 3계층 + 동일한 설계 사상("판단은 LLM, 강제는 코드")을 쓴다.

| 계층 | oh-my-codex | oh-my-claudecode |
|------|-------------|------------------|
| ① Hook 런타임 | `codex-native-hook.ts` (UserPromptSubmit/Stop/PreToolUse) | Claude Code hooks (UserPromptSubmit 계열 + Stop persistent-mode) |
| ② SKILL 계약 | `skills/<n>/SKILL.md` | `skills/<n>/SKILL.md` |
| ③ 질문/도구 런타임 | `omx question` 자체 CLI + tmux 렌더러 | `AskUserQuestion` 네이티브 |
| state | `omx state` CLI (단일 writer) | state MCP 도구 |
| goal | Codex `get_goal/create_goal/update_goal` | Claude `/goal` (네이티브 Stop hook) |
| subagent | adapted role routing (권한 문제) | `Task` 네이티브 |

---

## 2. 세 스킬 기능 등가 비교 (claudecode vs codex)

### 2.1 요약 판정

| 스킬 | "호환 제외 시 동일?" | 판정 근거 |
|------|----------------------|-----------|
| **ultragoal** | ✅ **동일** | 호스트 goal 바인딩(Claude `/goal` vs Codex `get_goal/...`)만 다름. ledger·서브커맨드·최종 게이트 전부 동일 |
| **ralplan** | 🔶 **핵심만 동일** | 합의 엔진(Planner→Architect→Critic 순차 + 재검토 max5 + RALPLAN-DR + deliberate)은 동일. 주변 장치/handoff는 다름 |
| **deep-interview** | ❌ **기능 자체가 갈라짐** | 채점 차원·가중치·프로파일·고유 게이트가 서로 다른 방향으로 진화 |

### 2.2 deep-interview 세부 차이

| 측면 | oh-my-codex | oh-my-claudecode |
|------|-------------|------------------|
| 채점 차원 | 5~6 (intent/outcome/scope/constraints/success/context) | 3~4 (goal/constraints/criteria/context) |
| 가중치(greenfield) | 0.30/0.25/0.20/0.15/0.10 | 0.40/0.30/0.30 |
| 프로파일 | 3종 (quick 0.30/5, standard 0.20/12, deep 0.15/20) | 단일 threshold(설정, 기본 0.2) + 고정 라운드(10/20) |
| 설정 소스 | `.omx/config.toml` | `.claude/settings.json` |
| **codex 고유** | Fact/Judgment 라우팅, Dialectic Rhythm Guard, Pressure Pass, Non-goals·Decision-Boundaries 필수 게이트 | — |
| **claudecode 고유** | — | Round 0 Topology 게이트, Ontology 수렴 추적, Challenge Agents(Contrarian/Simplifier/Ontologist) |
| 질문 UI | omx question (tmux) | AskUserQuestion |
| 기본 handoff | → ultragoal | → omc-plan `--consensus --direct` |

> 이 고유 기능들은 **전부 SKILL.md의 프롬프트 지시**다(코드 강제 아님). 예: codex의 `[from-code]`/`[from-user]` 라벨은 "never use them as `omx question` `source` values"로 명시된 transcript 라벨일 뿐이다.

### 2.3 ralplan 세부 차이 (핵심 엔진은 동일)

| 측면 | oh-my-codex | oh-my-claudecode |
|------|-------------|------------------|
| vague-prompt 게이트 | 개념만 언급 | Pre-Execution Gate 상세(concrete-signal 표, `force:`/`!` 우회) |
| 부가 장치 | advisory 상태머신, role-routing preflight, durable handoff contract (provenance 강제 계열) | 없음(경량 `pending approval`) |
| 리뷰어 교차 | — | `--architect codex` / `--critic codex` |
| 기본 handoff | → ultragoal | → team / ralph |

### 2.4 어느 deep-interview 방식이 나은가 (설계 판단)

단일 우승자는 없다. 서로 다른 실패 모드를 방어한다.

- **codex 우위**: 대화 질·의도(why) 깊이·사용자 노력 절감 (Fact/Judgment 라우팅, Pressure Pass, Non-goals/Decision-Boundaries 게이트). 단, 규칙이 많아 모델 지시 준수 부담이 큼.
- **claudecode 우위**: 구조적 커버리지·수렴 증거 (Topology 게이트가 멀티컴포넌트 실명 방어, Ontology 수렴이 객관적 종료 신호). 단순해서 실행이 더 견고함.

**용도별 승자:**
| 상황 | 승자 |
|------|------|
| 개념 흐릿한 단일 목적 | codex |
| 여러 컴포넌트 시스템 | claudecode |
| 발견 가능한 사실 많은 brownfield | codex |
| 실행 후 스코프 분쟁 위험 큼 | codex (non-goals 게이트) |
| 객관적 종료 신호 필요 | claudecode (ontology 수렴) |
| 모델 지시 준수 불안 | claudecode (단순·견고) |

**opencode 이식 추천 (merge):** claudecode의 단순 채점 + Topology + Ontology를 베이스로, codex의 **Fact/Judgment 라우팅**과 **Non-goals/Decision-Boundaries 게이트**, 그리고 intent 차원 하나를 흡수. 기본값은 claudecode 방식, 고위험/고모호 작업엔 codex 방식.

---

## 3. opencode 하네스 프리미티브 매핑

이식 대상 opencode의 실제 코드 근거 (경로는 `opencode/packages/opencode/src/` 기준).

| 필요 기능 | opencode 프리미티브 | 위치 | 비고 |
|-----------|--------------------|------|------|
| 키워드 감지 + 상태 시딩 + 컨텍스트 주입 | **`chat.message` 플러그인 훅** | `session/prompt.ts:1000` | mutable `parts`에 synthetic part push (다운스트림 `:1011`이 소비). 코어 선례: `session/reminders.ts` |
| 시스템 프롬프트 주입 | `experimental.chat.system.transform` 훅 | `agent/agent.ts:381` | |
| 구조화 질문 (블로킹) | **`question` 도구 + `Question` 서비스** | `tool/question.ts`, `question/index.ts` | `ask()`가 Deferred로 에이전트 루프 블로킹. 스키마: `options[{label,description}]`, `multiple`, `custom` |
| subagent (Planner/Architect/Critic) | **`task` 도구** | `tool/task.ts` | `subagent_type` + `prompt`, foreground=순차 await |
| PreToolUse write 경계 (deny) | **`permission.ask` 훅** + agent `permission` 룰셋 | `plugin/src/index.ts`(Hooks), `permission/index.ts:75` | `output.status="deny"` 가능 |
| 진행 추적 (goal 대체) | **`todowrite` 도구 + TODO 시스템** | `tool/todo.ts`, `session/todo.ts` | DB 백엔드, 세션 스코프. **opencode엔 네이티브 goal 없음** |
| state | 플러그인 disk JSON (`FSUtil`) | — | codex `omx state` / OMC state MCP 대체 |
| **Stop 게이트** | ❌ **네이티브 없음** | `session/prompt.ts:1319` | 코어 패치 필요 (§4) |

### 3.1 결정적 사실 — opencode의 hook 목록

opencode 플러그인 `Hooks` 인터페이스(`plugin/src/index.ts`)에는 다음이 있다: `event`(관찰 전용), `chat.message`, `chat.params/headers`, **`permission.ask`(veto 가능)**, `command.execute.before`, `tool.execute.before/after`, `experimental.chat.system.transform`, `tool.definition` 등.

**하지만 "세션 종료/idle을 거부하는 훅"은 없다.** `event`는 `Promise<void>` 관찰 전용이라 되돌리지 못한다. `plugin.trigger` 발화 지점을 전수 조사한 결과 stop 결정 지점(`prompt.ts:1319`)엔 trigger가 없다. → **Stop hook 형태는 코어 패치로만 가능.**

---

## 4. 유일한 코어 패치: `session.finish` 훅 신설

세 워크플로의 Stop 게이트(deep-interview obligation, ralplan `SKILL_STOP_BLOCKERS`, ultragoal reinforcement)는 **모두 이 패치 하나로 커버**된다.

**대응 지점:** `packages/opencode/src/session/prompt.ts:1319`
```ts
if (result === "stop") return "break" as const   // 모델이 자연 종료 → 루프 break → 세션 idle
```

**패치안:**
```ts
// plugin/src/index.ts — Hooks 인터페이스에 추가
"session.finish"?: (
  input: { sessionID: string; agent: string; finishReason: string },
  output: { decision: "stop" | "block"; reason?: string },
) => Promise<void>
```
```ts
// session/prompt.ts:1319 — 코어 분기
if (result === "stop") {
  const gate = { decision: "stop" as "stop" | "block", reason: undefined }
  yield* plugin.trigger("session.finish",
    { sessionID, agent: agent.name, finishReason: handle.message.finish! }, gate)
  if (gate.decision === "block") {
    yield* sessions.injectSyntheticUserPart(sessionID, gate.reason ?? STOP_REASON)
    continue   // ← "break" 대신 재구동 = Stop veto
  }
  return "break" as const
}
```

- 재주입(synthetic part + 루프 지속) 패턴은 **이미 코어에 선례**가 있다: `session/reminders.ts`(synthetic part push), `experimental.compaction.autocontinue`(종료 후 synthetic "continue" 턴). 새 개념이 아니라 기존 패턴의 재배치라 위험이 낮다.
- 패치 규모: 인터페이스 1줄 + 루프 분기 ~6줄.

---

## 5. 스킬별 이식 방안

### 5.1 deep-interview → opencode

| 컴포넌트 | 이식 방식 | 코어 패치? |
|----------|-----------|-----------|
| 트리거 + 상태 시딩 + 지시문 주입 | `chat.message` 훅 + disk state + synthetic part | ❌ |
| 구조화 질문 (라운드마다) | **내장 `question` 도구** (블로킹) | ❌ (더 우수 — in-loop 블로킹) |
| obligation | 플러그인 disk 레코드 (`session.finish`가 검사) | ❌ |
| Stop 게이트 | **`session.finish` 훅** | ⚠️ 공유 패치 |
| ambiguity 채점/Topology/Ontology/Fact-Judgment | orchestrator agent 프롬프트 (SKILL 이식) | ❌ |
| requirements 모드(구현 금지) | 커스텀 agent `permission` 룰셋(edit/write/bash deny) | ❌ (프롬프트보다 강함) |
| crystallize/handoff | 도구가 `.opencode/specs/…` 작성 → 실행 agent로 handoff | ❌ |

> codex는 `omx question`을 자체 구현해야 했지만(네이티브 fire-and-forget 회피), opencode는 `question` 도구가 **루프-블로킹**이라 그 이유가 사라진다. 재활용이 정답.

### 5.2 ralplan → opencode

| 컴포넌트 | 이식 방식 | 코어 패치? |
|----------|-----------|-----------|
| Planner/Architect/Critic 순차 | **`task` 도구** (foreground=순차 await) + 커스텀 agent | ❌ 네이티브 |
| 재검토 루프(max5) | orchestrator 내부 로직 | ❌ |
| **planning/execution write 경계** | **`permission.ask` 훅** + agent `permission` 룰셋 | ❌ **네이티브** (PreToolUse-형 훅 존재) |
| consensus gate (종료 차단) | **`session.finish` 훅** (deep-interview와 동일 패치 재사용) | ✅ 재사용 |
| Pre-Execution Gate(vague-prompt) | `chat.message` 훅에서 concrete-signal 검사 후 ralplan으로 라우팅 | ❌ |
| advisory/provenance(codex 부가) | 필요 시 disk state (opencode에선 대부분 불필요) | ❌ |

> ralplan은 **추가 코어 패치 0개**. write 경계는 opencode가 네이티브로 지원(deep-interview보다 더 깔끔).

### 5.3 ultragoal → opencode

| 컴포넌트 | 이식 방식 | 코어 패치? |
|----------|-----------|-----------|
| durable ledger(brief/goals/ledger) | 플러그인/CLI가 `.opencode/ultragoal/*` 작성 | ❌ |
| create/complete/checkpoint/steer/status | 플러그인 도구 또는 CLI | ❌ |
| 순차 스토리 루프 + 최종 게이트 | orchestrator + `task`(code-reviewer/architect) | ❌ |
| **goal 포인터 바인딩** | **네이티브 goal 없음** → §5.3.1 | ⚠️ 발산 |
| Stop reinforcement | **`session.finish` 훅** (재사용) | ✅ 재사용 |

#### 5.3.1 goal-mode 발산 처리

opencode엔 `get_goal/create_goal/update_goal`/`/goal`이 **전혀 없다** (확인 완료). 대신 **TODO 시스템**(`session/todo.ts` + `todowrite` 도구)이 네이티브 진행추적 프리미티브다. 두 옵션:

- **옵션 A (권장, 형태 충실):** Codex/Claude aggregate goal ↔ opencode 세션 todos. `create_goal`→`todowrite`(스토리를 todo로), `update_goal(complete)`→todo status 갱신. opencode TUI가 todo를 렌더하므로 **네이티브 UI 진행 표시**까지 보존.
- **옵션 B (생략, ledger-only):** goal 포인터는 UI 통합용 코스 포인터일 뿐, 진짜 SSOT는 ledger. opencode엔 `/goal` UI 개념이 없으니 빼도 기능 손실 거의 없음.

어느 쪽이든 ultragoal 본체(durable 멀티골 추적)는 완전 이식된다.

---

## 6. 종합 이식 체크리스트

- [ ] **코어 패치 1개**: `session.finish` 훅 신설 (`prompt.ts:1319`) — 세 스킬의 Stop 게이트 공유.
- [ ] `chat.message` 훅: 키워드 감지 + disk state 시딩 + synthetic part 주입 (3스킬 공통 진입점).
- [ ] 커스텀 agent 정의: deep-interview(question+read only), Planner/Architect/Critic(각 role, read-only), ultragoal orchestrator. `permission` 룰셋으로 requirements/planning 경계 강제.
- [ ] `question` 도구 재사용 (deep-interview 라운드).
- [ ] `task` 도구 재사용 (ralplan subagent, ultragoal 최종 리뷰).
- [ ] `permission.ask` 훅 (ralplan write 경계).
- [ ] `todowrite` 바인딩 or 생략 (ultragoal goal 포인터).
- [ ] disk 아티팩트: `.opencode/{specs,plans,ultragoal,context,state}/`.
- [ ] deep-interview는 merge 권장: claudecode 베이스 + codex의 Fact/Judgment 라우팅·Non-goals/Decision-Boundaries 게이트 흡수.

---

## 7. 핵심 통찰 (기억할 것)

1. **prompt vs code 구분이 이식의 핵심.** 두 원본의 워크플로 차이는 대부분 SKILL.md(프롬프트) 레벨이다. 하네스 코드는 형태가 공유되므로, 이식이란 "SKILL 계약을 opencode agent 프롬프트로 옮기고, 몇 개의 강제 지점만 opencode 프리미티브에 연결"하는 작업이다.
2. **강제(enforcement)만 코드로.** "질문을 건너뛰지 못하게 / 계획 없이 실행 못 하게 / 미완료 시 못 끝내게" — 이 셋만 결정적 코드가 필요하고, opencode에선 `question`(블로킹) + `permission.ask`(veto) + `session.finish`(신설) 세 지점으로 커버된다.
3. **단일 코어 패치로 충분.** 세 워크플로를 함께 이식해도 `session.finish` 하나면 된다. 나머지는 전부 플러그인·agent·기존 도구.

---

*본 정리 문서와 링크된 두 상세 문서는 open-gajae 세션 분석 기반이다. 파일:라인 앵커는 분석 시점(oh-my-codex 0.21.5 / oh-my-claudecode v5.4.0 / 현재 opencode 체크아웃) 기준이며, 구현 착수 전 해당 심볼의 현존을 재확인할 것.*
