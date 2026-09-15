# deep-interview / ralplan / ultragoal — opencode 이식 분석 정리

> **독자:** opencode plugin을 개발하는 개발자
> **목적:** OMC 기준 개발 정책과 현재 구현 상태를 구분하고, OMC·OMX의 세 워크플로(`deep-interview`, `ralplan`, `ultragoal`)에 대한 과거 비교·이식 제안을 보존한다. 개발 정책의 기준은 [AGENTS.md](../../AGENTS.md)다.
> **상세 근거 문서:**
> - [oh-my-claudecode 상세 분석](./oh-my-claudecode-analysis.md)
> - [oh-my-codex 상세 분석](./oh-my-codex-analysis.md)

---

## 0. 개발 정책과 구현 상태

### 현재 개발 정책

- **Phase 1은 OMC 기준 이식이다.** 기능·철학·워크플로·agent 역할 계약은 OMC를 따른다. OMX와 동등 비교하여 혼합하는 방식은 더 이상 활성 개발 지침이 아니다.
- **OpenCode는 기술적 기준이다.** 본체는 수정하지 않고 native API·도구·권한·생명주기로 연결한다. OMC의 호스트 전용 계약을 그대로 지원할 수 없으면 차이·이유·기능상 영향을 기록하며 OMX/OMO 정책으로 조용히 대체하지 않는다.
- **OMX 검토는 Phase 2로 유보한다.** Phase 1 완료 후 장점을 개별 분석·선별한다. OMO는 OpenCode 연결 구현 참고로만 사용한다.
- **Phase 1 범위·기준 OMC 커밋·완료 검증 조건은 구현 정렬 전에 확정한다.** 현재 deep-interview와 자체 primary/explore가 구현되어 있다는 사실은 전체 OMC 이식이나 세 워크플로의 Phase 1 포함을 의미하지 않는다. 고지에 기록된 과거 파생물 커밋을 새 기준 커밋으로 자동 간주하지 않는다.
- **문서 정비와 실행 계약 정렬은 별도다.** `prompts/*.md`, `skills/deep-interview/SKILL.md`, 관련 상태 검증·테스트는 후속 구현 변경에서 함께 정렬한다. 안전한 저장 등 기술 장치를 출처만으로 삭제하지 않으며 남은 파생물의 고지·라이선스를 유지한다.

### 현재 구현 계약 — 혼합 상태, OMC 정렬 전

아래는 현재 제품 동작의 기록이며 새 설계의 채택 지침이 아니다. 현재 제품은 본체 무수정 deep-interview 플러그인이며 ralplan/ultragoal은 구현되어 있지 않다.

- `skills.paths`로 bundled SKILL을 등록하고 host의 skill-derived `/deep-interview`를 사용한다. 중복 custom command나 core patch는 없다.
- 분석한 OMC 리비전의 기본 등록 MJS Stop 경로에는 deep-interview 전용 자동 계속 처리가 없다. 기본 경로에 연결되지 않은 별도 TS 활성 스킬 보강 구현(최대 10회·30분 만료)은 가져오지 않는다.
- prompt 계약과 실제 native `question` 도구 가용성으로 한 번에 한 질문을 지원한다. 모델의 호출을 강제하지 않으며, 호출된 도구가 실제 대기·응답 수신을 처리한 뒤 모델은 자연스럽게 계속한다. 도구를 사용할 수 없거나 거부되면 plaintext 답변 fallback 없이 중단하고 보고한다.
- OpenCode 1.18.30의 `agent/agent.ts` 기본값은 custom agent의 `question`을 거부하며 내장 build/plan에 별도 허용한다. 이후 승인된 수정으로 자체 primary도 question을 기본 허용한다. 단 사용자 전역·개별 권한에 question과 일치하는 규칙이 있으면 허용을 추가하지 않고 호스트 평가에 맡긴다. 전역 → 개별 agent 우선순위와 와일드카드 규칙 순서를 보존한다. `agent.open-gajae`는 사용자 덮어쓰기로 수용하며 explorer의 deny 7개와 중복 정의 검사는 유지한다. 등록된 도구 목록과 실제 agent의 사용 권한은 별개다.
- deep-interview에는 `session.idle` 후 `promptAsync` 재진입, one-shot correction, budget, 또는 obligation 엔진이 없다. 실제 question Asked/Replied/Rejected, tool 결과 및 interruption은 동일 session 저장 연산으로 처리하고 취소·오류·restart/resume에서 durable state와 대조한다. 누락된 after/reject를 답변으로 만들지 않으며 legacy SDK에 없는 `question.list`는 사용하지 않는다.
- OMC deep-interview snapshot 대체·명시 인자 우선·custom payload 한도와 OMX atomic 저장 패턴을 조합한다. runtime 기록은 모델 snapshot과 분리해 보호한다. 동일 process queue만 보장하며 multi-process lock은 없다.
- OMC Round0/점수/ontology와 OMX Fact/Judgment·출처 라벨·리듬·Pressure Pass/Closure Audit는 원문 기반 프롬프트 계약이다. transcript/spec의 `[from-code]`, `[from-code][auto-confirmed]`, `[from-research]`, `[from-user]`를 runtime question `source`와 혼동하지 않는다.
- 자체 `open-gajae` primary와 `open-gajae-explore`만 정의한다. OMC `agents/explore.md`와 OMX `prompts/explore.md`를 동등 원천으로 조합하며 OMO의 custom AgentConfig/model 연결 방식을 참고한다. 내장 explore/general 재사용이나 모델 override가 아니다.
- 모델 설정은 소유 두 역할에만 적용한다. 미지정은 host 현재/부모 모델 경로, runtime TUI 선택은 유지한다. native가 미존재 variant를 생략할 수 있어 semantic 오류를 항상 보장하지 않는다.
- host의 configured agent permissions는 user policy 뒤에 결합된다. late allow로 기존 read/task deny를 넓히지 않도록 explore는 edit/bash/task/external_directory/question/state_write/deep_interview_spec의 deny만 추가하고 primary에는 task grant를 넣지 않는다.
- 이 deny 목록은 최종 host policy와 다르다. `agent.ts:296-310`의 Truncate.GLOB allow 및 `subagent-permissions.ts`의 부모 external_directory 정책 결합은 host 예외로 남는다. 플러그인 최종 deny 엔진이나 core patch로 바꾸지 않고 한계를 문서화한다.
- public `/command`는 `Command.Info` schema의 source/template를 반환한다(legacy SDK 타입만 source를 생략). 초기화 중 client 호출 없이 실제 command before-hook에서 source와 bundle base-directory를 확인해 MCP/외부 skill 충돌에 의한 잘못된 상태 시딩을 거부한다.
- 인터뷰의 제품 변경 금지는 원본 수준 안내와 native 권한에 의존한다. 전역 hard guard·자손 격리·OS sandbox·unknown MCP 전체 차단을 주장하지 않는다.
- FOLLOWUP-01: 실제 downstream skill이 생길 때 인계/승인/취소/실패 처리를 추가한다. FOLLOWUP-02: 최초 자체 explore는 현재 범위이며 이후 specialist 추가 시 primary 라우팅·모델·권한·검증도 함께 갱신한다.
- 원본 revision과 고지/변경 이유는 [THIRD-PARTY-NOTICES](../../THIRD-PARTY-NOTICES.md)에 기록한다. 설치/사용자 검증은 README를 따른다. fixture 통과는 실제 host/model E2E 성공을 뜻하지 않는다.

---

## 1. 두 원본의 핵심 아키텍처 (과거 비교 기록)

> **§1~7 전체는 과거 분석·설계 기록이다.** 비교 결론과 merge 추천은 Phase 1 개발 지침이 아니다. `session.finish` 코어 패치 제안은 미채택이며 현재 구현의 필수 조건도 아니다. 기술적 주장과 기능 등가 판정은 해당 기준 소스로 재검증해야 한다.

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

### 2.4 어느 deep-interview 방식이 나은가 (과거 설계 판단)

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

**과거 merge 제안 — Phase 1 적용 제외:** claudecode의 단순 채점 + Topology + Ontology를 베이스로, codex의 **Fact/Judgment 라우팅**과 **Non-goals/Decision-Boundaries 게이트**, 그리고 intent 차원 하나를 흡수하자는 제안이었다. 기본값은 claudecode 방식, 고위험/고모호 작업엔 codex 방식을 쓰자는 당시 판단이며 현재 개발 정책이 아니다.

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

## 4. 과거 미채택 제안: `session.finish` 코어 훅 신설

> 아래는 당시 가설과 코드 제안이다. 구현·검증 완료를 뜻하지 않으며 현재의 OpenCode 본체 무수정 정책에서는 적용하지 않는다.

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

## 5. 스킬별 과거 이식 제안

> 현재 구현 명세나 승인된 작업 목록이 아니다. 아래 코어 패치·obligation·혼합 계약·아티팩트 경로 제안은 §0의 현재 구현과 구분한다. Phase 1 포함 여부와 호스트 연결은 별도로 확정·검증한다.

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

## 6. 과거 이식 체크리스트 — 실행 대상 아님

> 당시 검토 항목을 보존한 목록이다. 미완료 제품 작업이나 Phase 1 완료 조건으로 해석하지 않는다. 코어 패치는 미채택이며 merge 제안은 Phase 1에서 제외한다.

- [ ] **코어 패치 1개**: `session.finish` 훅 신설 (`prompt.ts:1319`) — 세 스킬의 Stop 게이트 공유.
- [ ] `chat.message` 훅: 키워드 감지 + disk state 시딩 + synthetic part 주입 (3스킬 공통 진입점).
- [ ] 커스텀 agent 정의: deep-interview(question+read only), Planner/Architect/Critic(각 role, read-only), ultragoal orchestrator. `permission` 룰셋으로 requirements/planning 경계 강제.
- [ ] `question` 도구 재사용 (deep-interview 라운드).
- [ ] `task` 도구 재사용 (ralplan subagent, ultragoal 최종 리뷰).
- [ ] `permission.ask` 훅 (ralplan write 경계).
- [ ] `todowrite` 바인딩 or 생략 (ultragoal goal 포인터).
- [ ] disk 아티팩트: `.opencode/{specs,plans,ultragoal,context,state}/`.
- [ ] 당시 merge 검토안: claudecode 베이스 + codex의 Fact/Judgment 라우팅·Non-goals/Decision-Boundaries 게이트 흡수. 현재 Phase 1 적용 제외.

---

## 7. 과거 분석 결론 — 현재 지침 아님

> 아래 강제 지점과 단일 패치의 충분성은 당시 설계 주장이지 현재 호스트에서 검증된 보장이 아니다. 현재 개발에는 §0과 AGENTS.md를 적용한다.

1. **prompt vs code 구분이 이식의 핵심.** 두 원본의 워크플로 차이는 대부분 SKILL.md(프롬프트) 레벨이다. 하네스 코드는 형태가 공유되므로, 이식이란 "SKILL 계약을 opencode agent 프롬프트로 옮기고, 몇 개의 강제 지점만 opencode 프리미티브에 연결"하는 작업이다.
2. **강제(enforcement)만 코드로.** "질문을 건너뛰지 못하게 / 계획 없이 실행 못 하게 / 미완료 시 못 끝내게" — 이 셋만 결정적 코드가 필요하고, opencode에선 `question`(블로킹) + `permission.ask`(veto) + `session.finish`(신설) 세 지점으로 커버된다.
3. **단일 코어 패치로 충분.** 세 워크플로를 함께 이식해도 `session.finish` 하나면 된다. 나머지는 전부 플러그인·agent·기존 도구.

---

*본 정리 문서와 링크된 두 상세 문서는 open-gajae 세션 분석 기반이다. 파일:라인 앵커는 분석 시점(oh-my-codex 0.21.5 / oh-my-claudecode v5.4.0 / 현재 opencode 체크아웃) 기준이며, 구현 착수 전 해당 심볼의 현존을 재확인할 것.*
