# 패널 (lateral review panel)과 advisory lane

이 문서는 SKILL Phase 3의 다관점 리뷰 패널과 질문마다 쓰는 advisory lane을 적습니다. 기준 코드는 [README.md](README.md) 머리에 있습니다.

패널은 모델이 다음 질문을 더 낫게 만들도록 돕는 보조 층입니다. 결정을 내리거나 상태를 쓰지 않습니다. 코드가 제공하는 것은 **역할 하나와 그 권한**뿐이고, 언제 열지, 무엇을 넘길지, 결과를 어떻게 쓸지는 모두 SKILL이 정합니다.

| 무엇 | 어디서 정하나 |
|---|---|
| 패널 역할 `open-gajae-lateral-reviewer`의 등록, 프롬프트, 권한, 도구 숨김, 모델 설정 | 코드 (`src/config.ts`, `src/hooks.ts`, `src/tools/permissions.ts`, `prompts/open-gajae-lateral-reviewer.md`) |
| 패널 조각의 내용(persona 렌즈, 응답 JSON 꼴) | 조각 파일 `skills/deep-interview/lateral-review-panel.md` |
| 언제 여는지(밴드 전이), 누구를 부르는지(persona), 결과를 어떻게 합치는지, 무엇을 기록하는지 | SKILL Phase 3(`skills/deep-interview/SKILL.md:556-593`)와 Internal_Panel_Fragment(`:75-82`) |

## 패널 역할 `open-gajae-lateral-reviewer`

persona가 도는 읽기 전용 subagent 역할입니다(계획 DR-36; PQ-7 N, PQ-26 B~PQ-29 A; spec Errata E10; deep-interview 편차 37).

### 왜 따로 두나

gjc의 persona는 부모 문맥을 물려받는(fork-context) subagent이고, 읽기 전용 architect로 설명됩니다. OpenCode `subagent`는 새 문맥에서 시작하고, 기존 `open-gajae-architect` 역할은 자기 Markdown 출력 계약을 가지고 있어 조각의 JSON 꼴과 부딪힙니다. 그래서 출력 계약이 없는 짧은 역할을 새로 만들었습니다(`prompts/open-gajae-lateral-reviewer.md:12`).

### 등록

| 항목 | 코드 |
|---|---|
| 이름 | `agentNames`(`src/config.ts:9-21`, `:20`) |
| 설명 | `Read-only lateral-review persona for deep-interview panels; answers in the shape its assignment asks for.`(`src/config.ts:248-249`) |
| 모드 | `subagent`(`registerAgents`, `src/config.ts:362`) |
| 시스템 프롬프트 | `prompts/open-gajae-lateral-reviewer.md`(`loadPrompts`, `src/config.ts:330-341`). `<open-gajae-runtime-settings>` 블록은 붙지 않음(`open-gajae`만) |
| 권한 | `roleRules`의 기본 분기(`src/config.ts:320-327`; PQ-28 A): `edit`, `subagent`, `question`, `deep-interview`, `opencode_session_move`, `opencode_session_rename`, `ultragoal`, `goal`, `ralplan` 거부. `shell` 규칙은 없음 |
| 코드 도구 | `CODE_ACTORS`(`src/tools/permissions.ts:24-34`)에 있어 AST·LSP 읽기 도구를 쓸 수 있음 |
| workflow 도구 | 어떤 도구의 주인도 아니어서 `ralplan`, `ultragoal`, `goal`, `deep-interview`가 모두 숨겨짐(`TOOL_OWNERS`, `src/hooks.ts:288-298`) |
| 프롬프트 훅 | `ROLE_SUBAGENTS`(`src/hooks.ts:266-273`)에 있어 키워드·멘션 안내를 받지 않음(테스트 H6) |

권한 규칙은 `tests/integration.test.ts:245-267`이, 도구 숨김은 `tests/hooks.test.ts:1686-1705`가 확인합니다.

### 모델과 variant

설정 파일의 `agents.open-gajae-lateral-reviewer.{model, variant}`로 정합니다(PQ-29 A). 기본값은 없고, 없으면 호스트가 정합니다.

- `model`은 `provider/model` 꼴이어야 합니다(`src/config.ts:149-152`).
- `variant`만 있고 `model`이 없으면(사용자·프로젝트 파일을 합친 뒤) 로드 오류입니다: `open-gajae-lateral-reviewer.variant is set without model; add model "provider/model"`(`src/config.ts:180-183`).
- 프로젝트 파일 값이 사용자 파일 값을 덮습니다(`src/config.ts:173-175`).

```jsonc
{
  "agents": {
    "open-gajae-lateral-reviewer": { "model": "provider/model", "variant": "medium" }
  }
}
```

### 프롬프트

`prompts/open-gajae-lateral-reviewer.md:1-8` 요지:

- deep-interview 리더가 `subagent`로 부르고, 한 번에 persona 하나, 여러 개를 병렬로 부릅니다.
- 자기 문맥에서 돌므로 다른 persona가 할 말에 기대지 않습니다.
- 과제의 문맥은 읽기 전용 배경입니다. 코드 편집, 파일 쓰기, `.open-gajae/` 변경, 포매터, workflow 인계, 구현을 하지 않습니다. `shell`은 읽기 전용 확인에만 씁니다.
- 사용자에게 묻지 않고 맡기지 않습니다. 문맥이 모자라면 지어내지 말고 무엇이 모자란지 말합니다.
- 맡은 관점에서만, 과제가 요구하는 꼴 그대로 답합니다. **자기 출력 계약은 없습니다.**

`shell`의 읽기 전용은 권한이 아니라 프롬프트로만 요구합니다(다른 모든 역할과 같음).

## 패널 조각 `lateral-review-panel.md`

`skills/deep-interview/lateral-review-panel.md`는 gjc의 같은 이름 조각에 호스트 치환만 한 것입니다(`:51` 출처 주석). skill이 아니며 `skill`로 로드하지 않습니다(SKILL `:76`).

내용:

- persona 넷(`researcher`, `contrarian`, `simplifier`, `architect`)의 렌즈(`:11-16`)
- 과제: 자기 렌즈에서 다음 질문이 다뤄야 할 가장 큰 사각지대나 미결정 하나와 해결 방안(`:18-20`)
- 응답 꼴: 이 JSON 객체 하나만(`:22-39`)
  ```json
  {
    "status": "answered",
    "persona": "researcher|contrarian|simplifier|architect",
    "finding": "One concrete, user-safe blind spot or decision this persona surfaces.",
    "rationale": ["Context, repo fact, or confirmed constraint supporting the finding."],
    "suggested_options": ["A concise answer option or recommended draft the next single question can offer."],
    "confidence": "high|medium|low"
  }
  ```
- 규칙: `finding`은 비어 있지 않고 확정된 제약과 어긋나지 않음, `rationale` 1~3개, `suggested_options` 1~3개, `confidence`는 셋 중 하나(`:41-45`)
- 문맥이 모자라면: `confidence` `low`, `finding`에 가장 중요한 빠진 문맥, `suggested_options`에 가장 안전한 확인 질문 하나(`:47-49`)

호스트 치환(`:51`): "inherited context" → "the context passed in this prompt"(OpenCode `subagent`는 새 문맥, deep-interview 편차 18), `.gjc/` → `.open-gajae/`, "read-only architect panel" → "read-only review panel"(persona는 architect 역할이 아니라 패널 역할로 돎, deep-interview 편차 37), agent가 대신 답하기 전 패널을 여는 부분 삭제(deep-interview 편차 6). 출력 계약 문장을 더하지 않았습니다(계획 DR-33 철회). `tests/integration.test.ts:440-451`이 조각의 머리, 출처, `.gjc`·"output contract"가 없음을 확인합니다.

### 전달 방식

SKILL Internal_Panel_Fragment(`SKILL.md:75-82`, deep-interview 편차 27):

- 패널을 열 때만 조각을 읽습니다.
- persona마다 `subagent(open-gajae-lateral-reviewer)` 프롬프트에 **조각 전문**, 그 persona 이름(`persona`), 프롬프트 예산에 맞춘 인터뷰 문맥 요약을 넣습니다. persona는 새 문맥에서 시작하므로 프롬프트에 든 것만 봅니다.
- gjc는 `skill-fragment` 로더로 fork-context subagent에 조각을 붙입니다. open-gajae에는 그런 로더가 없어 리더가 매번 넘깁니다.

## 언제 여나: 밴드 전이

SKILL Phase 3(`SKILL.md:556-567`). 고정 라운드 번호가 아니라 모호도 밴드가 바뀔 때 엽니다.

| 밴드 | 모호도 |
|---|---|
| `initial` | > 0.60 |
| `progress` | 0.60 ≥ a > 0.30 |
| `refined` | 0.30 ≥ a > 기준치 |
| `ready` | ≤ 기준치 |

- 직전 채점 라운드와 밴드가 다르면 전이입니다. 점수가 다시 오를 수 있으므로 양방향입니다.
- 전이가 있으면 다음 질문을 만들기 **전에** 패널을 엽니다.
- 모델은 라운드마다 `ambiguity_milestone`을 다시 계산해 `write`로 기록합니다(SKILL Step 2e). 런타임은 밴드를 계산하지 않습니다. 런타임이 정한 `current_ambiguity`는 `write` 결과에 있습니다([state-and-files.md](state-and-files.md)).

## persona

SKILL Phase 3(`SKILL.md:569-579`).

| persona | 렌즈 | 언제 |
|---|---|---|
| `researcher` | 외부 사실, 선행 사례, 버전·호환성 제약, 인터뷰가 기대는 미지수 | 늘 |
| `contrarian` | 핵심 가정에 도전. "반대가 참이면? 이 제약은 실제인가 습관인가?" | 늘 |
| `simplifier` | 복잡성을 뺄 수 있나. "여전히 가치 있는 가장 단순한 버전은?" | 늘 |
| `architect` | 시스템 모양, 소유, 통합 영향 | 이번 라운드가 시스템 모양을 바꿨을 때(범위 확장, 새 구성요소·통합(trigger D), 소유·구조 변경) |

- 한 메시지에서 `subagent(open-gajae-lateral-reviewer)`를 병렬로 부르고, persona마다 문맥을 따로 복사해 넣습니다. 다른 persona의 틀에 기대지 않게 하기 위함입니다.
- **background로 돌리지 않습니다.** 자식 execution이 도는 동안에는 플러그인이 인터뷰를 이어 가게 하지 않기 때문입니다([guards-and-continuation.md](guards-and-continuation.md)의 continuation 순서 3).
- **ontology 격상**: 모호도가 3라운드 동안 ±0.05 안에 머물거나 8라운드 뒤에도 0.30을 넘으면, 패널(특히 `contrarian`과 `architect`)에게 "이것은 정말 무엇인가?"를 묻게 합니다.

## 결과 합치기

SKILL Phase 3 "Folding findings"(`SKILL.md:571`)와 Internal_Panel_Fragment(`:79`):

- 응답마다 검증합니다: 필수 필드가 있는지, 요청한 꼴인지, `rationale`이 주어진 문맥을 인용하는지, `confidence`가 명시됐는지, 문맥 부족 fallback을 지켰는지.
- 구체적이고 사용자에게 안전한 지적만 다음 **질문 하나**에 접어 넣습니다. 순위를 매긴 답 선택지 2~3개나 추천 초안 하나로 넣습니다.
- 패널은 두 번째 질문을 만들지 않고, 요구를 스스로 바꾸지 않으며, 인터뷰를 완료로 표시하지 않습니다. 질문 하나 규칙은 그대로입니다.

코드는 응답을 검증하지 않습니다. 패널 역할은 `deep-interview` 도구를 쓸 수 없으므로 상태에 직접 쓰지도 못합니다. 기록은 리더(`open-gajae`)가 `write`로 합니다.

## 기록

SKILL Phase 3 "Bookkeeping"(`SKILL.md:581`), Step 2e(`:474`), Phase 1 초기화(`:181-182`):

- 연 패널마다 `state.lateral_reviews`에 라운드, 밴드 전이, 부른 persona, 접어 넣은 지적을 남깁니다.
- 패널 실행, 조각 읽기, 응답 검증이 실패하면 조용히 평소 질문으로 돌아가고 `state.lateral_panel_failures`를 1 올립니다. 질문이 달라지지 않는 한 도구 잡음을 사용자에게 보이지 않습니다.
- 스펙 메타데이터에 두 값(`Lateral Reviews`, `Lateral Panel Failures`)을 적습니다(SKILL Phase 4, `:631-632`).

두 필드는 런타임에게 자유 필드입니다. `write`가 `state` 안에서 얕게 병합하므로, `lateral_reviews` 배열을 보내면 **배열 전체가 바뀝니다**. 키로 병합하는 컬렉션은 `rounds`와 `established_facts`뿐입니다(SKILL `:537`). 그래서 새 항목을 더할 때는 기존 항목을 포함한 전체 배열을 보내야 합니다. 코드는 값의 모양이나 증가 여부를 보지 않습니다.

## advisory lane

SKILL Phase 3 "Per-question advisory fanout lanes"(`SKILL.md:583-593`). 밴드 전이 패널과 별개로, 질문 하나를 만들 때 쓰는 가벼운 보조입니다. ouroboros의 `ooo interview`에서 가져왔습니다.

| lane | 하는 일 |
|---|---|
| `code_context` | 사용자에게 묻기 전에 저장소 사실을 확인하고 기존 탐색을 재사용 |
| `web_context` | 지금의 외부 사실이 답에 실제로 영향을 줄 때만 검색 |
| `ambiguity_contrarian` | 숨은 가정, 모호한 말, 빠진 결정, 위험한 기본값 |
| `answer_simplifier` | 질문을 쉬운 선택지 2~3개나 짧은 초안 하나로 |
| `architecture_implications` | 답이 소유, 인터페이스, 배포, 시스템 모양을 바꾸는지 |

- **역할을 정하지 않습니다** (PQ-4 A, PQ-30 A; spec Errata E11). gjc처럼 SKILL이 lane의 역할을 적지 않고, 리더가 고릅니다. 읽기 전용 역할(`open-gajae-explore`, `open-gajae-document-specialist`, 패널 역할 등)을 쓸 수 있습니다.
- **문맥은 프롬프트로**: OpenCode `subagent`는 부모 문맥을 물려받지 않으므로, 리더가 lane마다 필요한 문맥을 프롬프트에 넣습니다(deep-interview 편차 18).
- 한 메시지의 병렬 `subagent` 호출로 돌리고, 패널처럼 background로 돌리지 않습니다(SKILL `:593`, 계획 DR-30). 자식 execution이 도는 동안에는 continuation이 멈추기 때문입니다.
- 보조일 뿐입니다. 사용자에게 가는 질문 하나를 대신하거나 늦추지 않고, 두 번째 질문을 더하지 않으며, 사용자의 승인이나 수정 없이 만든 답을 넘기지 않습니다.
- 같은 라운드에 패널과 lane이 모두 해당하면 패널을 열고, lane 결과도 같은 질문 하나에 접어 넣습니다.
- lane이 실패하면 조용히 평소 질문으로 돌아갑니다. 기록 필드는 없습니다.

## 코드가 강제하는 것과 SKILL만 요구하는 것

| 규칙 | 코드 | SKILL·프롬프트만 |
|---|---|---|
| persona는 파일을 고치지 않음 | 예(`edit` 거부, 사용자 설정이 풀 수 있음) | `shell`은 프롬프트로만 |
| persona는 workflow 도구·`question`·`subagent`를 쓰지 않음 | 예(권한 + 도구 숨김) | |
| 밴드가 바뀔 때만 패널을 엶 | | 예 |
| persona 셋(+ architect)을 병렬로, 조각 전문과 함께 부름 | | 예 |
| background로 돌리지 않음 | | 예 |
| 응답 검증, 질문 하나로 접기 | | 예 |
| `lateral_reviews`·`lateral_panel_failures` 기록 | | 예 |
| lane의 역할과 문맥 | | 예 |
