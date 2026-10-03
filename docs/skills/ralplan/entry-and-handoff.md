# 진입과 넘기기

이 문서는 세션이 ralplan에 **들어오는 길**과, ralplan이 다른 workflow(ultragoal, deep-interview)와 **제어를 주고받는 길**을 코드 그대로 적습니다. 다루는 것은 `ralplan` 키워드와 `@ralplan` 멘션 안내, 턴 표식, `skill ralplan` 로드, 진입점인 `ralplan start`와 `start` 없는 `write`, deep-interview와 ultragoal에서 넘겨받기, `ralplan handoff(to)`, 같은 execution의 `skill ultragoal` 게이트, Stop here, 체인 가드와 막지 않는 것입니다. 기준 코드는 [README.md](README.md) 머리에 있습니다. 코드 위치는 `5b92a60` 기준이고, 루트 `README.md`의 줄 번호는 지금 파일(이 폴더와 함께 들어간 링크 문단 두 줄 포함) 기준입니다. 용어(stage, run, 계보 루트, 보이는 주 skill, T, R, known phases, phase lock, 턴 표식, 영수증)는 [README.md](README.md)의 용어 절을 따릅니다.

이웃 주제는 다른 문서에 있습니다.

- [ops.md](ops.md): `ralplan` 도구 정의, 호출자 검사, op 7개의 입력·검사·결과. 이 문서는 `start`와 `handoff`를 진입과 넘기기 쪽에서만 봅니다.
- [stages-and-ledger.md](stages-and-ledger.md): `write` 안에서 일어나는 일(run 전환, phase 이동과 잠금, 예산, 영수증).
- [state-and-files.md](state-and-files.md): 상태 파일 모양, 활성 행·스냅숏·보이는 주 skill 계산, 감사 로그, 인계 저널 파일.
- [guards-and-continuation.md](guards-and-continuation.md): `execute.before` 전체 순서와 차단 방식, 계획 가드, continuation, 압축 문맥.
- [roles-and-consensus.md](roles-and-consensus.md): SKILL 1~9단계와 승인 질문.
- [known-limits.md](known-limits.md): 알려진 한계.
- 다른 skill 쪽: [deep-interview 진입과 넘기기](../deep-interview/entry-and-handoff.md), [ultragoal 진입과 인계](../ultragoal/entry-and-handoff.md). 공통 저널 인계 `handoffWorkflowTx`의 단계, 필드 병합, 저널 수명은 두 문서에 자세히 있습니다.

이 문서의 실행 예(감지 결과, 안내 문구, 결과 줄, 영수증, 상태 필드)는 5b92a60 코드를 scratchpad의 임시 `StateStore`와 실제 훅(`createHooks`)·도구(`createTools`)로 돌려 얻었습니다. 세션 폴더 절대 경로는 `<session>`, 작업 트리는 `<root>`로 바꿨고, 시각과 sha256은 실행마다 다릅니다.

## 진입 경로 한눈에 보기

| 경로 | 무엇이 일어나나 | ralplan 상태 |
|---|---|---|
| 키워드 `ralplan`·`랄플랜`·`ラルプラン` | `<ralplan-notice>` 키워드 안내 | 쓰지 않음 |
| `@ralplan` 멘션 | 멘션 안내, 턴 표식 `ralplan` | 쓰지 않음 |
| `skill ralplan` 로드 | 체인 가드와 DR-21 게이트를 지나면 턴 표식 `ralplan` | 로드 자체는 쓰지 않음(ralplan 편차 36). DR-21 게이트가 deep-interview를 넘기면 그 인계가 씀 |
| `ralplan start(task, interactive?, deliberate?, run_id?)` | 시드 | 새 상태, 활성 `planner`, `mode`·`task`·binding, 활성 행 |
| `start` 없는 `ralplan write` | 상태 생성 | 활성, phase는 쓴 stage, `mode`·`task`·binding 없음 |
| `deep-interview handoff(to:"ralplan")` | 저널 인계 | 기존 필드 위에 활성 `planner`, `handoff_from: "deep-interview"` |
| `deep-interview spec(…, handoff:"ralplan")` | `startRunTx` 시드 뒤 저널 인계 | 새 상태(`deliberate`, `task` = 스펙 경로) + `handoff_from` |
| 같은 execution에서 `skill deep-interview` 뒤 `skill ralplan` | DR-21 로드 게이트가 인계 | 위 인계와 같음. 결과 줄 없음 |
| `ultragoal handoff(to:"ralplan", reason)` | 저널 인계 | 기존 필드 위에 활성 `planner`, `handoff_from: "ultragoal"`, `run_id` 유지 |

나가는 길은 `ralplan handoff(to: "ultragoal" | "deep-interview")`, 같은 execution의 `skill ultragoal`, Stop here(`ralplan state {"active": false}`)입니다. `ralplan clear`와 breaker로 끝나는 길은 [ops.md](ops.md)와 [guards-and-continuation.md](guards-and-continuation.md)에 있습니다.

## 키워드와 멘션 안내

v2 `prompt` 세션 훅(`prompt`, `src/hooks.ts:860-1002`)이 맡습니다. 사용자가 프롬프트를 보낼 때마다 한 번 돕니다. 결정: D-F13, R-O6(안내만, 시드 없음), R-OD20(안내 대상), PQ-5 (1) B(ultragoal이 주 skill일 때).

### 검사 순서

```
G1  session.get으로 세션 agent 조회 (:863-870)
    ROLE_SUBAGENTS(:266-273)면 여기서 끝. 조회 실패는 agent 모름으로 계속
G2  프롬프트에 INJECTION_MARKERS(src/injection.ts:17-40) 중 하나가 있으면 끝 (:876-880)
 ↓  Esc 중단 표시 해제. 계보 루트를 구하고, 이 세션이 루트면 deep-interview
    continuation 횟수 초기화와 goal 보류 해제 (:885-900). 루트 조회 실패는 로그만
 ↓  agent가 문자열이고 "open-gajae"가 아니면 끝 (:906, R-OD20)
 ↓  감지 (:908-921): 멘션 = event.prompt.skills에 id "ralplan"
                    키워드 = detectRalplanKeyword(text) !== null
 ↓  ralplan이나 deep-interview를 감지했고 루트를 구했으면, 루트의 보이는 주 skill이
    ultragoal인지 읽음 (:925-933). 읽기 실패는 "아님"
 ↓  안내 목록: ralplan 계열 → ultragoal → deep-interview 순 (:934-995)
 ↓  멘션이 있었으면 턴 표식, 그다음 안내 쓰기 (:997-998)
훅 전체의 예외는 로그만 남깁니다 (:999-1001).
```

안내를 받는 세션과 받지 않는 세션:

| 세션 agent | 안내 | 중단 표시 해제, (루트면) goal 보류 해제 |
|---|---|---|
| 역할 subagent 여섯(`open-gajae-planner`, `-architect`, `-critic`, `-executor`, `-cleaner`, `-lateral-reviewer`) | 없음 | 하지 않음(G1에서 끝) |
| `open-gajae` | 받음 | 함 |
| agent 없음, 조회 실패 | 받음 | 함 |
| 그 밖(`build`, `general`, 사용자 agent, `open-gajae-explore` 등) | 없음 | 함 |

`open-gajae` 밖의 agent에게는 `ralplan` 도구가 숨겨지고 거부되므로, 안내가 거부로 이어질 뿐이라 보내지 않습니다(R-OD20, `src/hooks.ts:902-906` 주석). 역할 subagent는 받은 지시문에 키워드가 인용될 수 있어 아예 건너뜁니다(`:257-265`).

### 키워드 감지 (`detectRalplanKeyword`)

`src/ralplan.ts:740-747`. 지운 텍스트 위에서 `findActionableRalplanMatch`를 돌립니다. 이 감지기는 OMC `keyword-detector/index.ts`를 옮긴 것이고(머리말 `:140-157`), ralph·autopilot 전용 함수 둘(`isRalphMetaOrBanterContext`, `isAutopilotCreationAlias`)은 옮기지 않았습니다. ultragoal 키워드도 같은 함수를 씁니다(`detectUltragoalKeyword`, `:752-759`). deep-interview 키워드는 둘째 거름(호출 문맥) 없이 첫째 거름만 씁니다(`detectDeepInterviewKeyword`, `:772-778`).

정규식은 `RALPLAN_KEYWORD` = `/\b(ralplan)\b|(랄플랜)|(ラルプラン)/i`입니다(`:24`). 대소문자를 가리지 않고, `\b`가 ASCII 단어 경계라 `ralplan으로`도 맞습니다. 한국어·일본어 별칭에는 경계 조건이 없습니다.

**① 잡음 지우기** (`sanitizeForKeywordDetection`, `:348-368`). 이 순서로 지웁니다.

1. 붙여 넣은 명령 기록(`stripPastedCommandPayloads`, `:197-296`): `[MAGIC KEYWORD…]` 머리 블록, `<system>`·`<user>`·`<tool_result>` 같은 역할 경계 블록, `User request:` 줄과 다음 줄, `Skill: oh-my-claudecode:` 줄, `$ `·`% `·`❯ `로 시작하는 셸 기록 줄, git diff 블록
2. HTML 주석 `<!-- … -->`
3. 같은 이름으로 닫히는 XML 태그 블록과 self-closing 태그
4. URL(`http://`, `https://`)
5. 블록 인용 줄(`> …`), 표 행과 표 구분선
6. 파일 경로(`FILE_PATH_PATTERN`, `:334-341`): 디렉터리가 한 단계 이상 있는 경로. `/ralplan`처럼 안쪽 슬래시가 없는 것은 남습니다
7. 코드(`removeCodeBlocks`, `:162-171`): ```` ``` ````·`~~~` 펜스, 한 줄 백틱

**② 일치마다 두 거름** (`findActionableRalplanMatch`, `:704-732`). 정규식의 모든 일치를 앞에서부터 보고, 두 거름을 모두 지나는 첫 일치를 돌려줍니다.

- **정보성 문맥이면 버립니다** (`isInformationalKeywordContext`, `:566-672`). 일치 앞뒤 80자 창(`INFORMATIONAL_CONTEXT_WINDOW`)을 이 순서로 봅니다.
  1. 키워드가 따옴표 안이고, 그 따옴표 바로 밖 앞뒤 28자에 실행·활성 동사(`fix`, `debug`, `implement`, `build`, `use`, `run`, `start` 등)가 없으면 정보성
  2. 키워드 앞이 직접 호출 접두사(아래)이고 바로 뒤가 `:`이며, `:` 뒤 80자에 물음 없이 실행 동사가 있으면 정보성 아님(`ralplan: fix …`)
  3. 활성 의도와 실행 지시(`fix|debug|investigate|resolve|handle|patch|address|implement|build`)가 함께 있으면 정보성 아님
  4. 정보 의도 낱말(`what is`, `explain`, `describe`, `뭐야`, `설명`, `알려줘`, `사용법`, `とは` 등, `:370-376`)과 강한 도움 질문(`?`, `how to use`, `사용법` 등)이 함께 있으면 정보성
  5. 활성 의도나 대화형 호출(아래)이 있으면 정보성 아님
  6. 진단 의도(`ralplan keeps looping`, `bug with ralplan`, `랄플랜 자꾸 멈추…`, `:542-556`)면 정보성
  7. 키워드가 있는 줄이 블록 인용이나 표 행이면 정보성
  8. 따옴표 안 키워드이고 따옴표 밖에 후속 질문 낱말(`why`, `how many`, `cost`, `왜`, `비용` 등)이 있으면 정보성
  9. 글 전체가 참고 자료 모양이면 정보성(`looksLikeReferenceContent`, `:456-470`: 비교·문서·가이드·`정리` 같은 낱말, `결론:`·`summary:` 같은 설명 틀, 화살표, 서로 다른 모드 이름 둘 이상, 따옴표 밖 질문의 조합)
  10. 나머지는 정보 의도 낱말이 있으면 정보성
- **호출 문맥이 아니면 버립니다** (`hasExplicitInvocationContext`, `:522-540`). 셋 중 하나가 있어야 합니다.
  - 직접 접두사(`hasDirectInvocationPrefix`, `:495-498`): 일치 앞의 글 전체가 비었거나 `$`, `/`, `!`, `force:`, `oh-my-claudecode:`, `oh-my-codex:`뿐. 그래서 글 맨 앞의 키워드는 언제나 호출 문맥입니다.
  - 활성 의도(`hasActivationIntentNearKeyword`, `:472-493`): 80자 창 안에서 `use|run|start|enable|activate|invoke|trigger|launch` 뒤 같은 줄 28자 안에 키워드가 있거나, `fix … issue|bug|problem|error … with|in ralplan`. 단 `how do I use … ralplan` 같은 도움 질문은 빼냅니다.
  - 대화형(`hasConversationalInvocationNearKeyword`, `:500-520`): 키워드가 따옴표 밖이고, 앞 80자(따옴표 부분 제외)가 `please `, `let's `, `I want|need|would like a(n) `, `can|could|would|will you `로 끝남.

한국어 동사(`계획해줘`, `해줘`)는 활성 의도 목록에 없습니다. 그래서 한국어로만 쓴 문장 **가운데**의 키워드는 감지되지 않고, 맨 앞에 두어야 합니다.

별칭(`랄플랜`, `ラルプラン`)은 활성 의도와 영어 진단 의도 정규식이 키워드를 `\b…\b`로 감싸므로(`:487-488`, `:547-548`) 그 둘에 걸리지 않습니다. `\b`가 한글·가나 옆에서는 맞지 않기 때문입니다. 그래서 별칭은 글 맨 앞, 직접 접두사, 대화형 표현(경계 조건 없음)에서만 감지되고, 영어 활성 동사 뒤에서는 감지되지 않습니다. 실행 예: `use 랄플랜 for this`, `start ラルプラン now`는 안 함, `please 랄플랜 this`는 감지. 진단 의도로도 걸러지지 않아 `랄플랜 keeps looping`은 감지되고(`ralplan keeps looping`은 안 함), 한국어 진단 패턴(`자꾸|계속 … 멈추` 등, 경계 조건 없음)만 별칭에도 맞습니다. OMC의 같은 함수도 같은 `\b` 정규식입니다(`oh-my-claudecode/src/hooks/keyword-detector/index.ts:509-510,569-570`, 이 포트 머리말이 적은 HEAD `5281b19`의 로컬 checkout에서 확인).

### 예

현재 코드로 `detectRalplanKeyword`를 직접 돌린 결과입니다.

| 프롬프트 | 결과 | 이유 |
|---|---|---|
| `ralplan fix issue #2053`, `ralplan 로그인 기능 계획해줘`, `ralplan으로 계획 세워줘`, `RALPLAN add auth`, `ralplan` | 감지 | 글 맨 앞 |
| `랄플랜으로 계획해줘`, `랄플랜 <task>`, `ラルプラン で計画を立てて` | 감지 | 글 맨 앞 |
| `$ralplan fix issue #2053`, `!ralplan fix auth`, `/ralplan add auth`, `force: ralplan add auth` | 감지 | 직접 접두사 |
| `ralplan: fix the auth bug` | 감지 | 맨 앞, `:` 뒤 실행 동사 |
| `please use ralplan to plan issue #2053`, `start ralplan for the auth redesign` | 감지 | 활성 동사 |
| `please ralplan this issue`, `let's ralplan the auth redesign`, `I want a ralplan for this issue`, `can you ralplan this?` | 감지 | 대화형 |
| `run "ralplan" on this issue`, `use "ralplan" here` | 감지 | 따옴표 바로 밖에 활성 동사 |
| `랄플랜 이거 정리해줘` | 감지 | 맨 앞. 아래 줄과 비대칭 |
| `ralplan 이거 정리해줘` | 안 함 | `정리` + ASCII 모드 이름 → 참고 자료 모양. 모드 이름 세기(`MODE_REFERENCE_PATTERN`)가 ASCII만 봐서 생기는 OMC의 비대칭을 그대로 옮김(테스트 "the OMC ASCII/Korean asymmetry is ported verbatim") |
| `I want ralplan for this issue` | 안 함 | `a`/`an`이 없어 대화형이 아니고 맨 앞도 아님 |
| `이번엔 ralplan으로 계획 세워줘`, `ultragoal 말고 ralplan으로 해줘`, `이 작업 랄플랜으로 계획해줘` | 안 함 | 맨 앞이 아니고 영어 활성 동사·대화형 표현이 없음 |
| `I used ralplan yesterday`, `Please document ralplan in the README.` | 안 함 | 호출 문맥 없음 |
| `what is ralplan?`, `does ralplan stop after planning?`, `ralplan 이 뭐야?`, `ralplan: what is this?` | 안 함 | 정보성 |
| `ralplan으로 계획해줘. ralplan 이 뭐야?` | 안 함 | 두 일치 모두 80자 창에 `뭐야`와 `?` |
| `ralplan keeps looping` | 안 함 | 진단 의도 |
| ``Load the `ralplan` skill and plan: fix auth``, `> ralplan fix this`, `see docs/ralplan/plan.md`, `<note>ralplan fix</note>`, `\| ralplan \| fix \|` | 안 함 | 백틱, 블록 인용, 경로, XML 태그, 표 행이 지워짐 |

더 많은 예는 `tests/ralplan.test.ts`의 OMC 코퍼스("a ralplan mention, question or documentation request never fires", "an explicit ralplan invocation fires in every spelling")에 있습니다.

### 어떤 안내가 나가나

`src/hooks.ts:941-957`. 한 프롬프트에서 ralplan 쪽 안내는 최대 하나입니다.

| 조건(위에서 먼저 맞는 것) | 안내 | TUI 한 줄(`description`) | 턴 표식 |
|---|---|---|---|
| ralplan 감지(키워드나 멘션), ultragoal이 보이는 주 skill | `ultragoalHandoffNotice("ralplan")` | `open-gajae: ultragoal handoff notice added` | 세우지 않음 |
| `@ralplan` 멘션 | `mentionMessage()` | `open-gajae: ralplan mention notice added` | `ralplan` |
| 키워드이고 글에 `[MODE: RALPLAN]`(`KEYWORD_NOTICE_MARKER`, `:337`)이 없음 | `keywordMessage()` | `open-gajae: ralplan keyword notice added` | 세우지 않음 |
| 키워드뿐이고 글에 `[MODE: RALPLAN]`이 있음 | 없음 | — | — |

다른 skill과 함께일 때:

- ralplan을 감지하면 ultragoal 키워드·멘션 안내는 나가지 않고 `@ultragoal`의 턴 표식도 세우지 않습니다(`:961`, D-HE4).
- deep-interview는 따로 판단하므로 같은 프롬프트에서 deep-interview 안내도 나갈 수 있고, ralplan 안내 다음에 갑니다(테스트 "both keywords in one message write ralplan first, then deep-interview"). ultragoal이 주 skill이면 둘 다 각자의 handoff 안내로 바뀝니다.
- 멘션이 둘 이상이면 턴 표식은 `@ralplan`이 이깁니다(`mentioned ??=`, `:967,986`).

ultragoal이 주 skill인지는 프롬프트 훅이 행으로 판단합니다(`visiblePrimary`, `:661-666`). ultragoal state가 활성이어도 행이 없으면 평소 안내가 나갑니다.

### 안내 문구

`keywordMessage`(`src/ralplan.ts:66-71`), `mentionMessage`(`:76-81`), `ultragoalHandoffNotice`(`src/ultragoal-runtime/messages.ts:186-191`). 모두 `wrapInjected`(`src/injection.ts:47-50`)로 감쌉니다. 실제로 만든 문자열입니다.

```
<ralplan-notice>

[MODE: RALPLAN] Consensus planning requested. Load the `ralplan` skill and run its Planner/Architect/Critic workflow for this request.

</ralplan-notice>

---

```

```
<ralplan-notice>

[MODE: RALPLAN] Consensus planning requested through the `@ralplan` mention. The `ralplan` skill is already attached to this message; run its Planner/Architect/Critic workflow for this request.

</ralplan-notice>

---

```

```
<ultragoal-notice>

[ULTRAGOAL ACTIVE] ralplan was not started because an ultragoal run is active. To switch, call ultragoal handoff(to="ralplan", reason); the goals and progress are kept and can be resumed later.

</ultragoal-notice>

---

```

멘션 안내 문구는 open-gajae가 더한 것입니다(OMC는 명시 호출에도 안내를 내지만 문구가 다름, `src/ralplan.ts:73-75` 주석, 루트 README "Deviations from OMC" 표의 `@ralplan` 행).

### 안내를 쓰는 방식

`emitNotices`(`src/hooks.ts:844-858`)가 안내마다 `session.synthetic({sessionID, text, description, resume: false})`를 부릅니다. 새 실행을 시작하지 않는 합성 메시지입니다. 거부되면 안내를 `\n\n`과 함께 프롬프트 글 끝에 붙입니다. 붙인 글에는 표식 태그가 있으므로 다시 훅에 들어와도 G2가 거릅니다(테스트 "a rejected synthetic appends the marked notice to the prompt"). `src/hooks.ts` 머리말(`:67-73`)에 따르면 호스트는 합성 메시지를 같은 턴 사용자 메시지 **앞**에 두고(OMC·v1은 뒤, 기록된 편차), TUI는 `description` 없는 합성 메시지를 숨깁니다. 이 두 호스트 동작은 이 문서를 쓰며 호스트 소스로 확인하지 않았습니다.

### 안내가 하지 않는 일

- **상태를 쓰지 않습니다.** 새 세션에서 키워드 프롬프트, `@ralplan` 프롬프트, `skill ralplan` 로드를 차례로 한 뒤에도 `.open-gajae/` 아래에 그 세션 폴더가 생기지 않았습니다(실행 예). run은 `ralplan start`나 넘겨받기로 시작합니다(D-F13).
- **멘션은 skill 도구 호출이 아닙니다.** 호스트가 skill 본문을 메시지에 붙일 뿐이라 체인 가드와 DR-21 게이트를 거치지 않고, 턴 표식만 세웁니다. ultragoal이 주 skill일 때 `@ralplan`이 붙인 본문은 막지 못하고, 안내만 handoff 안내로 바뀝니다.
- 같은 훅의 goal 보류 해제는 키워드와 상관없이 루트 세션에서 `state/goal-continuation.json`을 다시 쓸 수 있습니다([ultragoal 문서](../ultragoal/entry-and-handoff.md#안내가-하지-않는-일)).

## 턴 표식

`turnSkill: Map<sessionID, skill>`(`src/hooks.ts:388`)과 되돌리기용 `markerUndo`(`:389`). 프로세스 메모리에만 있고, 호출한 세션 id 기준입니다(게이트의 상태 판단은 그 세션의 계보 루트로 합니다). gjc 출처는 `session/agent-session.ts:7448,8038-8046`(`src/hooks.ts` 머리말 `:29-35`, ultragoal 계획 C-10, PQ-21 A).

| 동작 | 언제 | 코드 |
|---|---|---|
| 세움 | `@ralplan` 멘션, ultragoal이 주 skill이 아닐 때 | `prompt` → `markTurn(sessionID, undefined, "ralplan")`(`:951,997`) |
| 세움 | `skill ralplan` 호출이 체인 가드와 DR-21 게이트를 지남. agent는 보지 않음 | `executeBefore` → `markTurn(sessionID, callID, "ralplan")`(`:1093`) |
| 되돌림 | 표식을 세운 `skill` 호출이 `status: "error"`로 끝남(이전 값으로, 없었으면 지움) | `executeAfter`(`:1107-1114`) |
| 지움 | `session.execution.succeeded`·`failed`·`interrupted`마다, 다른 판단보다 먼저 | `onEvent`(`:1264`, `EXECUTION_ENDS` `:308-312`) |

ralplan에 관한 쓰임은 셋입니다.

1. `skill ultragoal` 게이트: 표식이 `ralplan`이면 ralplan 상태를 보고 거부하거나 넘깁니다([아래](#같은-execution의-skill-ultragoal-게이트)).
2. `skill ralplan`의 DR-21 게이트: 표식이 `deep-interview`일 때만 돕니다([아래](#dr-21-로드-게이트)).
3. `skill ralplan`이 표식을 `ralplan`으로 덮습니다. 같은 execution에서 `skill deep-interview` → `skill ralplan`(게이트가 넘김) → `skill ultragoal` 순서면, 마지막 게이트는 방금 넘겨받아 활성 `planner`인 ralplan을 보고 `RALPLAN_RUNNING_REFUSAL`로 거부합니다(실행 예).

## `skill ralplan` 로드

`execute.before` 도구 훅(`executeBefore`, `src/hooks.ts:1004-1097`). v2 `skill` 도구의 입력은 `{id}`입니다. 단계 이름과 차단 방식(입력을 `{}`로 바꾸고 `execute.after`가 오류 문구를 바꿔 씀)은 [guards-and-continuation.md](guards-and-continuation.md)에 있습니다.

```
① 산출물 가드 (:1012-1029)    skill 입력에는 경로가 없어 해당 없음
② 계획 가드 (:1031-1036)      write/edit/patch만 봄
③ subagent 처리 (:1038-1041)  해당 없음
④ id가 workflow skill(ralplan, ultragoal, deep-interview)이 아니면 끝 (:1042-1045)
⑤ 체인 가드 (:1059-1073)      계보 루트의 보이는 주 skill이 ultragoal이면 거부. 모든 agent.
                               행을 읽을 수 없으면 로그만 남기고 통과
⑥ DR-21 게이트 (:1076-1092)   agent가 open-gajae이고 턴 표식이 deep-interview일 때만
⑦ 턴 표식 "ralplan" (:1093)
⑤~⑦의 예외 (:1094-1096)       로그만 남기고 통과. 표식은 세우지 않음
```

체인 가드의 거부 문구(`ultragoalChainRefusal`, `src/ultragoal-runtime/messages.ts:199-201`). `phase`는 ultragoal 행의 phase이고, 없으면 `unknown`입니다. 실제 결과입니다.

```
open-gajae: refusing to chain from "ultragoal" (phase=goal-planning) into "ralplan". Run ultragoal handoff(to: "ralplan", reason) directly, or finish or clear the ultragoal run first.
```

### 로드는 ralplan 상태를 쓰지 않음 (ralplan 편차 36)

gjc는 `/skill:ralplan` 로드가 mode state(phase `planner`, repository binding), 활성 행, 스냅숏을 써서 그때부터 편집 가드와 Stop 훅이 걸립니다(README 편차 36이 적은 gjc 출처 `hooks/skill-state.ts:387-496,641`; 이 문서를 쓰며 gjc 소스로 다시 확인하지 않았습니다). open-gajae의 로드는 아무것도 쓰지 않습니다(spec D-F13, R-O6). 그래서 로드와 `ralplan start` 사이에는 계획 가드도 continuation도 없습니다. SKILL의 첫 지시가 `start`입니다(`skills/ralplan/SKILL.md:17`).

예외는 DR-21 게이트입니다. 게이트가 deep-interview → ralplan 인계를 하면 그 인계가 ralplan 상태와 행을 씁니다.

### DR-21 로드 게이트

같은 execution에서 deep-interview를 로드했으면(턴 표식 `deep-interview`) `skill ralplan`은 `gateTx(tx, root, "ralplan")`(`src/deep-interview-runtime/hooks.ts:132-166`)를 루트의 트랜잭션 하나에서 지납니다. 체인 가드 **다음**에 돌므로 ultragoal이 주 skill이면 게이트까지 오지 않습니다. 판단과 세부(연결, 활성 callee 되돌림 K15, 로그)는 [deep-interview 문서](../deep-interview/entry-and-handoff.md#같은-execution의-skill-로드-게이트)에 있고, ralplan 쪽 결과만 적습니다.

| deep-interview 상태 | `skill ralplan` | ralplan 상태 |
|---|---|---|
| 없음, 손상 | 로드 | 그대로 |
| `interviewing`(활성·비활성), 모르는 phase, phase 없음(`running`으로 읽음) | 거부 | 그대로 |
| 활성 `handoff` | 넘긴 뒤 로드. 스펙 확인이나 인계가 실패하면 `open-gajae: <오류>`로 거부 | 활성 `planner`, `handoff_from: "deep-interview"`, 기존 필드 유지 |
| 비활성 `handoff`(이미 넘김) | 로드 | 그대로 |
| release phase(`complete` 등), 확인된 스펙 있음 | 연결한 뒤 로드 | 위와 같음. 진행 중인 ralplan(예: `architect`)도 `planner`로 돌아감(K15) |
| release phase, 스펙 없음·불일치 | 로드. `[open-gajae:hooks] finished deep-interview not linked to ralplan: <오류>` 로그 | 그대로 |

`interviewing`일 때의 거부(`chainRefusal`, `src/deep-interview-runtime/messages.ts:38-42`), 실제 결과입니다. 비활성 `interviewing`(취소된 인터뷰)이면 `cancelled` 문구를 씁니다(`src/deep-interview-runtime/hooks.ts:165`, deep-interview 편차 30).

활성 `interviewing`:

```
open-gajae: refusing to chain from "deep-interview" (phase=interviewing) into "ralplan". Persist the spec with deep-interview spec, then call deep-interview handoff(to: "ralplan"), or clear the interview first.
```

비활성 `interviewing`:

```
open-gajae: refusing to chain from "deep-interview" (phase=interviewing, cancelled) into "ralplan". The interview was cancelled: clear it with deep-interview clear first, or resume the interview instead with deep-interview state(patch={"active": true}).
```

게이트는 결과 줄을 내지 않습니다(PQ-35 A). 그래서 ralplan SKILL은 상태에 `handoff_from: "deep-interview"`가 있는데 결과 줄을 못 봤으면 `deep-interview status`의 `spec_path`를 읽어 계획 입력으로 쓰라고 합니다(`skills/ralplan/SKILL.md:17`).

## `ralplan start`로 시작

`start`(`src/ralplan-runtime/tool.ts:189-211`). 호출자 검사(`ownerSession`, `:168-187`) 뒤 계보 루트의 ralplan 트랜잭션 하나에서 차례로 봅니다(deep-interview 계획 DR-37, DR-39). 각 거부 문구는 [ops.md](ops.md)에도 있습니다.

| 순서 | 조건 | 결과 |
|---|---|---|
| 0 | 세션 id 없음, `open-gajae`·역할 agent가 아님, 역할 agent, 계보 조회 실패 | `a native session is required` / `the ralplan tool is not available to <agent>` / `<agent> may only use write, status and state` / `could not resolve the session lineage for ralplan` |
| 1 | ultragoal 상태가 읽히고 `active: true`(행은 보지 않음) | `RALPLAN_ACTIVATION_REFUSAL`(`:70-71`) |
| 2 | ralplan 상태가 읽히고 `active: true`(행은 보지 않음, ralplan 편차 39) | `ralplanRunActiveRefusal(state)`(`:73-78`) |
| 3 | `task`가 없거나 공백 | `ralplan start requires a task description, e.g. task: "<task>".` |
| 4 | `startRunTx` 안에서 ralplan 상태가 손상 | ``existing ralplan state is corrupt or tampered (<오류>); refusing to overwrite <상태 경로>. Reset it with `ralplan clear` and force: true.`` |

1과 2에서 읽기 실패는 "활성 아님"으로 봅니다. 그래서 손상된 ralplan 상태는 4에서 손상 문구로 거부됩니다(테스트 RP1, RP5). 실제 거부 문구입니다.

```
ralplan cannot be started while ultragoal is active; call ultragoal handoff(to="ralplan", reason) instead, which makes ralplan active in its planner phase.
```

```
ralplan run ses_e is already active (phase planner); continue it with ralplan write. To plan anew, stop it first with ralplan state {"active": false} or ralplan clear.
```

넘겨받은 run이면 `, handed over from <skill>`이 phase 뒤에 붙고, `run_id`가 없으면 `(none)`으로 나옵니다([아래](#그다음-skill이-시키는-일)).

거부를 모두 지나면 `startRunTx`(`src/ralplan-runtime/store.ts:915-988`)가 새 상태를 **통째로** 씁니다(기존 필드 병합이 아님): `active: true`, `current_phase: "planner"`, `skill`, `version: 2`, `mode`(`deliberate`면 `"deliberate"`, 아니면 `"short"`), `interactive`, `task`, `run_id`, `updated_at`, `repository_binding`, `session_id`. `run_id`는 입력 → 기존 상태의 `run_id` → 소유 세션 id 순이고(DR-19, ralplan 편차 31), binding은 같은 run이면 기존 값, 아니면 새로 잡습니다. 그다음 활성 `planner` 행과 스냅숏을 씁니다. 결과는 `{ok: true, session_id, skill, mode, state_path, run_id, handoff: "ralplan", repository_binding}`입니다. 자세한 모양은 [ops.md](ops.md)와 [state-and-files.md](state-and-files.md)에 있습니다.

**멈춘 뒤 다시 `start`하면 옛 run 폴더로 돌아갑니다.** Stop here나 `clear` 뒤에는 상태가 비활성이라 `start`가 통과하지만, `run_id`를 주지 않으면 기존 상태의 `run_id`를 다시 씁니다. 실행 예: `start` → `planner` 1 → `final` 1 → Stop here → `start(task: "v2")`는 `run_id`가 같은 값이고, 이어서 다른 내용으로 `planner` 1을 쓰면 `refusing to overwrite ralplan planner stage 1 at … Use a new stage_n to record another pass.`로 거부됩니다. 옛 반복 예산과 `pending-approval.md`도 그 run에 남습니다. SKILL은 새 run에는 새 `run_id`를 주라고 하지만(`skills/ralplan/SKILL.md:17`), 활성 run 거부 문구의 "To plan anew, stop it first …"는 이 점을 말하지 않습니다.

## `start` 없는 `write`

`start`를 부르지 않고 `ralplan write`를 해도 상태가 생깁니다(R-O6, 루트 README "Accepted behavior differences"의 "No seeding; `write` creates state"). 실행 예에서 빈 세션의 `write(stage: "planner", stage_n: 1)` 뒤 상태는 `{active: true, current_phase: "planner", run_id: <루트 세션 id>}`(그리고 `skill`, `version`, `updated_at`)이고 `mode`, `interactive`, `task`, `repository_binding`이 없습니다. 활성 행도 생기므로 이때부터 계획 가드와 continuation의 대상이 됩니다. `write`는 ultragoal이 실행 중이어도 거부하지 않습니다(R-AE1). 단계는 [stages-and-ledger.md](stages-and-ledger.md)에 있습니다.

## deep-interview에서 들어오기

deep-interview가 스펙을 저장한 뒤(phase `handoff`) ralplan으로 넘기는 길은 셋입니다. 셋 다 공통 저널 인계(`handoffWorkflowTx`)로 ralplan을 callee로 씁니다. 결정: spec D-SH4, 계획 DR-9, DR-21, DR-29.

| 길 | 함수 | ralplan 상태 결과 | 결과 줄 |
|---|---|---|---|
| `deep-interview handoff(to:"ralplan")` | `handoffTx` → `deepInterviewHandoffTx` → `handoffWorkflowTx`(`src/deep-interview-runtime/store.ts:599-628`) | 기존 필드 위에 `active: true`, `planner`, `handoff_from`, `handoff_at` | 있음 |
| `deep-interview spec(…, handoff:"ralplan")` | `specHandoffTx`(`:548-561`): `specTx` → `seedRalplanTx`(= `startRunTx`, `src/tools.ts:61-62`) → `deepInterviewHandoffTx` | `startRunTx`의 새 상태(`mode: "deliberate"`, `task` = 스펙 경로) 위에 `handoff_from`, `handoff_at` | 있음 |
| 같은 execution의 `skill ralplan` | `gateTx`([위](#dr-21-로드-게이트)) | 첫 줄과 같음 | 없음 |

이전 ralplan 상태가 없을 때 `deep-interview handoff(to:"ralplan")` 뒤의 `state/ralplan-state.json`(실행 예):

```json
{
  "skill": "ralplan",
  "version": 2,
  "active": true,
  "current_phase": "planner",
  "handoff_from": "deep-interview",
  "handoff_at": "2026-10-03T15:06:31.915Z",
  "updated_at": "2026-10-03T15:06:31.915Z",
  "session_id": "ses_p",
  "_meta": {
    "mode": "ralplan",
    "sessionId": "ses_p",
    "updatedAt": "2026-10-03T15:06:31.916Z",
    "updatedBy": "deep_interview_tool"
  }
}
```

`run_id`, `task`, `mode`가 없습니다. 이전 ralplan 상태가 있었으면 그 필드(`run_id`, `task`, `mode`, binding, 옛 `handoff_to` 등)가 모두 남습니다(K7). 결합 호출 뒤에는 `startRunTx`가 쓴 필드가 있습니다(실행 예: `mode: "deliberate"`, `interactive: false`, `task: "<session>/specs/deep-interview-s.md"`, `run_id: <루트 세션 id>`, `repository_binding`, 그리고 `handoff_from: "deep-interview"`).

결합 호출의 시드는 `ralplan start`의 두 상태 거부(활성 ultragoal, 활성 run)를 거치지 않습니다. 진행 중인 ralplan run도 새 상태로 다시 시드하고(`run_id`는 기존 값), 그때 옛 상태의 다른 필드는 없어집니다(ralplan 편차 39의 예외, gjc `ralplan --deliberate`와 같음, K12, K14). 뒤 단계가 실패하면 앞 단계의 결과가 남습니다(K11).

결과 줄(`handedOffToRalplan`, `src/deep-interview-runtime/messages.ts:136-138`). 뒤에 JSON이 붙습니다([deep-interview ops](../deep-interview/ops.md)).

```
Handed off to ralplan: deep-interview is inactive (phase handoff) and ralplan is active in planner. Load the `ralplan` skill now; do not call `ralplan start` — continue this run with `ralplan write` and use the spec as the planning input (spec: <session>/specs/deep-interview-s.md).
```

### 그다음 SKILL이 시키는 일

`skills/ralplan/SKILL.md:17`과 결과 줄이 같은 것을 시킵니다.

- `ralplan start`를 부르지 않습니다. 불러도 코드가 거부합니다(ralplan 편차 39, 관리자 답 K14 C). 이전 ralplan 상태 없이 넘겨받았을 때의 실제 거부:
  ```
  ralplan run (none) is already active (phase planner, handed over from deep-interview); continue it with ralplan write. To plan anew, stop it first with ralplan state {"active": false} or ralplan clear.
  ```
- `ralplan write`로 이어 갑니다. 첫 `write`의 `run_id`는 입력 → 상태의 `run_id` → 루트 세션 id입니다. 실행 예에서 `run_id` 없이 넘겨받은 run의 첫 `planner` 1 뒤 상태는 `run_id: <루트 세션 id>`, `handoff_from: "deep-interview"`는 그대로입니다. 활성 행은 `handoff_from` 없이 다시 쓰이고, 아래 순위의 deep-interview 행은 지워집니다(`syncActiveRowTx`, `src/skill-state/rows.ts:149-162`).
- 이전 ralplan run을 이어받았으면 옛 반복 예산과 `stage_n`이 이어집니다. 새 예산이 필요하면 첫 `write`에 새 `run_id`를 줍니다(K7, [stages-and-ledger.md](stages-and-ledger.md)).
- 스펙은 결과 줄의 `spec:` 경로나 `deep-interview status`의 `spec_path`에서 읽습니다. 결합 호출이면 `task`도 스펙 경로입니다.

## ultragoal에서 들어오기

`ultragoal handoff(to:"ralplan", reason)`(`handoffTx`, `src/ultragoal-runtime/store.ts:1097-1117`). 입력은 `to`와 비어 있지 않은 `reason`만 검사하고 ultragoal의 활성·phase는 보지 않습니다. 원장 `workflow_handoff`와 `progress.txt` `HANDOFF`를 남기는 점을 포함한 ultragoal 쪽 내용은 [ultragoal 문서](../ultragoal/entry-and-handoff.md#ultragoal-handoffto-reason)에 있습니다.

ralplan이 받는 것(실행 예: `start` → `final` → `ralplan handoff(to:"ultragoal")` → `ultragoal create` → `ultragoal handoff(to:"ralplan")` 뒤의 상태, `_meta`와 binding 생략):

```json
{
  "active": true,
  "current_phase": "planner",
  "skill": "ralplan",
  "version": 2,
  "mode": "short",
  "interactive": false,
  "task": "v1",
  "run_id": "ses_z",
  "updated_at": "2026-10-03T15:06:31.995Z",
  "session_id": "ses_z",
  "auto_handoff": {
    "configuredTarget": "off",
    "effectiveTarget": "off",
    "degradationReason": null,
    "source": "default"
  },
  "handoff_to": "ultragoal",
  "handoff_at": "2026-10-03T15:06:31.995Z",
  "handoff_from": "ultragoal"
}
```

- 기존 필드를 모두 지킵니다: `run_id`, `task`, `mode`, binding, 옛 `final`의 `auto_handoff`, 지난 인계의 `handoff_to: "ultragoal"`(PQ-4 A, PQ-6 A; ralplan 편차 24 철회).
- 저장된 ralplan phase가 `RALPLAN_STATES`에 있고 `planner`가 아니면(왕복에서는 `handoff`) 감사 로그에 `invalid_transition_detected`가 먼저 남습니다. `RALPLAN_TRANSITIONS`에 `planner`로 들어가는 줄이 없기 때문입니다([아래](#공통-저널-인계-ralplan-쪽-요약)).
- ultragoal 행이 비활성 `handoff_to` 행이 되므로 체인 가드가 풀려 `skill ralplan`을 로드할 수 있습니다(테스트 "(F)").

그다음:

- `ralplan start`는 거부됩니다. 실제 문구: `ralplan run ses_r2 is already active (phase planner, handed over from ultragoal); continue it with ralplan write. To plan anew, stop it first with ralplan state {"active": false} or ralplan clear.`
- 옛 run에 이어 쓸 때 이미 쓴 `(stage, stage_n)`을 다른 내용으로 쓰면 거부됩니다(실행 예: `planner` 1 → `refusing to overwrite ralplan planner stage 1 at <session>/plans/ralplan/ses_r2/stage-01-planner.md: an artifact with different content already exists (…). Use a new stage_n to record another pass.`). 다음 빈 `stage_n`(예: `revision` 2)은 통과하고 phase가 그 stage로 갑니다. 옛 final 승인과 반복 예산이 이어집니다(U13, 루트 README 알려진 동작 `README.md:299`).
- 첫 `write`에 새 `run_id`를 주면 새 run이 됩니다. 실행 예에서 `run_id: "r2"`의 `planner` 1 뒤 상태는 `run_id: "r2"`, `current_phase: "planner"`이고 `task`, `mode`, `handoff_from`, `handoff_to`는 남습니다(새 run은 `verdict`, `last_review_verdict*`, `planning_stuck`, `auto_handoff`만 지움, `persistActiveRunIdTx` `src/ralplan-runtime/store.ts:513-545`, [stages-and-ledger.md](stages-and-ledger.md)).
- goal은 인계가 건드리지 않습니다. goal이 활성인 동안은 goal continuation이 턴을 맡고 ralplan continuation은 판단하지 않습니다(D-TL6, [guards-and-continuation.md](guards-and-continuation.md)).
- 계획하는 동안 `ultragoal` op를 부르면 reconcile이 ultragoal을 `goals.json`에서 다시 활성으로 만들고 ralplan 행을 지웁니다. SKILL이 부르지 말라고 할 뿐 코드는 막지 않습니다(루트 README 알려진 동작, [ultragoal 문서](../ultragoal/entry-and-handoff.md#인계-뒤-1)).

## `ralplan handoff(to)`

ralplan 쪽의 나가는 op입니다. 결정: DR-7, DR-12(op 하나로, ralplan 편차 22), R-OD18(비활성 거부), D-SH5·DR-11(deep-interview로 돌아가기). ralplan 편차 34.

### 입력과 호출자

- `to`: `z.enum(["ultragoal", "deep-interview"]).optional()`(`src/ralplan-runtime/tool.ts:156`). 생략하면 `to must be "ultragoal" or "deep-interview"`(`:297`), 다른 값은 입력 스키마에서 막힙니다.
- `open-gajae`만 부를 수 있습니다. 역할 agent는 `<agent> may only use write, status and state`로 거부됩니다(`:177-178`).
- `ralplanHandoff`(`src/ralplan-runtime/store.ts:1378-1394`)가 루트의 ralplan 트랜잭션 하나에서 `ralplanHandoffTx(tx, root, RUNTIME_OWNER, "ralplan handoff to <to>", to)`를 부릅니다. 이유 문자열은 `handoffWorkflowTx`의 `reason`으로 가지만, ralplan caller에는 `recordCaller`가 없어 어디에도 저장되지 않습니다.

### 검사 순서 (`ralplanHandoffTx`)

`src/ralplan-runtime/store.ts:1328-1371`. op와 `skill ultragoal` 게이트가 함께 씁니다.

```
① readStateForMutation (:250-260)   손상 → 거부
② 상태 없음                          → 거부
③ trim한 current_phase ∉ T           → 거부            ← active보다 먼저 봄
④ pendingApprovalPathTx (:1298-1304) run 폴더에 pending-approval.md가 있으면 그 경로
                                     (run_id가 경로 성분 검사에 걸리면 그 오류로 거부)
⑤ active !== true                    → RalplanNotActiveError
     phase == "handoff"              → "already handed off" 문구
     그 밖                            → "not active" 문구 (to마다 다름)
⑥ handoffWorkflowTx(caller "ralplan", callee to)
```

거부 문구(실제 결과, `Error: ` 접두는 뺐습니다):

| 상황 | 문구 |
|---|---|
| 손상 | ``existing ralplan state is corrupt or tampered (<오류>); refusing to overwrite <상태 경로>. Reset it with `ralplan clear` and force: true.`` |
| 상태 없음 | `there is no ralplan state in this session to hand off` |
| phase ∉ T (예: `start` 직후) | `ralplan can hand off to <to> only from a finished phase (final, handoff, complete, completed, failed, cancelled, canceled, inactive); the current phase is planner. Record the final plan first.` (phase가 없으면 `(none)`) |
| 비활성 `handoff`, `to: "ultragoal"` | ``ralplan was already handed off (inactive, phase handoff); continue in the `ultragoal` skill.`` |
| 비활성 `handoff`, `to: "deep-interview"` | ``ralplan was already handed off (inactive, phase handoff); continue in the `<handoff_to, 없으면 ultragoal>` skill.`` |
| 그 밖 비활성(Stop here의 `final`, `clear`의 `complete`), `to: "ultragoal"` | ``ralplan is not active (phase final), so there is nothing to hand off: Stop here or `clear` ended the run. To execute the plan, load the `ultragoal` skill, then call `ultragoal create` with the plan's goals (the approved plan: <session>/plans/ralplan/ses_b/pending-approval.md).`` (괄호 부분은 `pending-approval.md`가 있을 때만) |
| 그 밖 비활성, `to: "deep-interview"` | ``ralplan is not active (phase final), so there is nothing to hand off: Stop here or `clear` ended the run. To interview again, load the `deep-interview` skill and call `deep-interview start`; to continue an existing interview, call `deep-interview status`.`` |

공통 인계에서 나오는 거부도 있습니다. callee 상태가 손상이면 `existing state for <callee> is corrupt or tampered (<오류>); refusing to hand off`(`src/skill-state/handoff.ts:146`), 병합한 상태가 StateStore 한도를 넘으면 그 오류입니다(DR-31). 둘 다 저널을 만들기 전이라 아무것도 쓰지 않습니다.

세부:

- **`to: "ultragoal"`의 "already handed off"는 언제나 `ultragoal`을 적습니다.** 문자열이 고정이라(`store.ts:1355-1358`), deep-interview로 넘긴 ralplan에 `handoff(to:"ultragoal")`을 불러도 ``continue in the `ultragoal` skill.``이 나옵니다(실행 예). `to: "deep-interview"` 쪽만 상태의 `handoff_to`를 읽습니다.
- `RalplanNotActiveError`(`store.ts:1295`)는 `Error`의 하위 클래스일 뿐이고, 이 클래스를 따로 가려 보는 코드는 없습니다. 도구 결과는 다른 거부와 같은 `Error: <문구>`입니다.

### 쓰는 것

`handoffWorkflowTx`([아래 요약](#공통-저널-인계-ralplan-쪽-요약))가 저널을 열고 callee 상태, ralplan 상태, 두 행과 스냅숏을 차례로 쓴 뒤 저널을 닫아 지웁니다. ralplan은 기존 필드 위에 `active: false`, `current_phase: "handoff"`, `handoff_to`, `handoff_at`, `updated_at`, `version: 2`가 되고, 이전 `handoff_from`도 남습니다. 활성 행은 지워지지 않고 비활성 `handoff_to` 행으로 남습니다(PQ-6 A, ralplan 편차 19 철회). 두 상태의 `_meta.updatedBy`는 op면 `ralplan_tool`, 게이트면 `ralplan_hook`입니다.

`ralplan handoff(to:"ultragoal")` 한 번이 남긴 감사 행(실행 예, `ts`·`mutation_id`·`paths` 생략). 이전 ultragoal 상태가 없어 callee 행에 `from_phase`가 없습니다.

```
write-transaction-journal                       (저널 시작, pending)
handoff        skill ultragoal  → goal-planning
write-transaction-journal                       (steps: callee-mode-state)
handoff        skill ralplan    final → handoff
write-transaction-journal                       (steps: … caller-mode-state)
write-active-entry ×2, rebuild-active-snapshot
write-transaction-journal                       (steps: … active-state)
write-transaction-journal                       (committed)
remove-transaction-journal
```

ralplan caller는 비활성으로 쓰므로 `invalid_transition_detected`가 남지 않습니다. ultragoal callee는 전이 표가 없어 남지 않습니다.

### 결과

첫 줄 뒤에 인계 영수증을 2칸 들여쓰기 JSON으로 붙입니다(`ralplanHandoff`, `store.ts:1387-1393`). 실행의 `pending-approval.md`가 있으면 ` (the approved plan: <경로>)`가 마지막 마침표 앞에 붙습니다. 계획 경로는 이 글에만 실려 갑니다(D-HE1, U6). 실제 결과입니다.

```
Handed off to ultragoal: ralplan is inactive (phase handoff) and ultragoal is active in goal-planning. Load the `ultragoal` skill now and call `ultragoal create` with the approved plan's goals (the approved plan: <session>/plans/ralplan/ses_a/pending-approval.md).
{
  "ok": true,
  "from": "ralplan",
  "to": "ultragoal",
  "handoff_at": "2026-10-03T15:02:50.829Z",
  "mutation_id": "ralplan:handoff:ultragoal:2026-10-03T15:02:50.829Z",
  "phases": {
    "from": "handoff",
    "to": "goal-planning"
  },
  "paths": {
    "from": "<session>/state/ralplan-state.json",
    "to": "<session>/state/ultragoal-state.json",
    "active_state": "<session>/state/skill-active-state.json"
  }
}
```

```
Handed off to deep-interview: ralplan is inactive (phase handoff) and deep-interview is active in interviewing. Load the `deep-interview` skill now and continue the existing interview with `deep-interview write`; do not call `deep-interview start`, which would reseed it (the approved plan: <session>/plans/ralplan/ses_d/pending-approval.md).
```

(deep-interview 쪽 영수증은 `"to": "deep-interview"`, `mutation_id`의 callee 이름(`ralplan:handoff:deep-interview:<시각>`), `"phases": {"from": "handoff", "to": "interviewing"}`, `paths.to`가 `<session>/state/deep-interview-state.json`인 것만 다릅니다.)

### 그다음

- **ultragoal로 넘긴 뒤**: ralplan 행이 비활성이 되어 계획 가드와 ralplan continuation이 멈추고, ultragoal이 보이는 주 skill이 되어 `goal-planning` 편집 가드와 체인 가드가 걸립니다. SKILL 9단계대로 `skill ultragoal`을 로드하면 이미 활성이라 시드는 `"kept"`이고, 최종 계획을 읽어 `ultragoal create`를 부릅니다. 남은 비활성 ralplan 행은 ultragoal이 다음에 활성 행을 쓸 때(시드, `create`의 reconcile) 위쪽 행으로 지워집니다(실행 예).
- **deep-interview로 넘긴 뒤**: deep-interview가 활성 `interviewing`, `handoff_from: "ralplan"`이 되고, 라운드·`spec_*`·옛 `handoff_to`가 남습니다. 이전 deep-interview 상태가 없었으면 `state` 객체 없이 생기므로(실행 예), deep-interview SKILL Phase 1의 초기화 `write`가 필요합니다([deep-interview 문서](../deep-interview/entry-and-handoff.md#ralplan-handofftodeep-interview)). `deep-interview start`는 이때 막히지 않습니다(주 skill이 deep-interview이므로). `start`하지 말라는 것은 결과 줄과 SKILL만 요구합니다.

## 같은 execution의 `skill ultragoal` 게이트

`skill ultragoal`은 `open-gajae`가 부를 때만 게이트를 돕니다(`src/hooks.ts:1046-1058`). 게이트는 `ultragoalGate`(`:796-818`)이고, 계보 루트의 `workflowTransaction` 하나 안에서 **호출한 세션**의 턴 표식을 봅니다. gjc 출처는 `tools/skill.ts:170-222`(같은 턴 인계, D-HE6)이고, 결정은 ultragoal 계획 C-10, I-7, PQ-21 A입니다.

```
표식 == "deep-interview" → deep-interview 로드 게이트 gateTx(tx, root, "ultragoal") 먼저
                           거부 → 로드 거부, 인계함 → 로드(시드 없음), 통과 → 아래로
표식 == "ralplan"        → ralplan 상태 읽기(실패 → 없음)
   active === true 이고 isKnownPhase(phase) 이면
      phase ∉ T → 거부: RALPLAN_RUNNING_REFUSAL
      phase ∈ T → ralplanHandoffTx(tx, root, HOOK_OWNER, "skill ultragoal loaded after ralplan")
                  → 로드(시드 없음)
   그 밖(비활성, 없음, 읽기 실패, 모르는 phase) → 아래 시드로
seedUltragoalTx(tx, root, HOOK_OWNER) → 로드
거부가 아니면 턴 표식 "ultragoal" (:1056)
```

거부 문구(`RALPLAN_RUNNING_REFUSAL`, `src/ralplan-runtime/store.ts:143-144`), 실제 결과입니다.

```
ralplan planning is running; finish it first: choose "Approve execution via ultragoal" at its approval step, or stop ralplan (`ralplan state` with {"active": false}) and try again.
```

- **T에서의 인계**는 `ralplan handoff` op와 같은 함수입니다. 다른 점은 쓰는 주체(감사 `owner` `open-gajae-hook`, `_meta.updatedBy` `ralplan_hook`)와 결과 줄이 없다는 것입니다. 실행 예: `start` → `skill ralplan` → `final` → `skill ultragoal`이면 ralplan은 비활성 `handoff`(`handoff_to: "ultragoal"`), ultragoal은 활성 `goal-planning`(`handoff_from: "ralplan"`)입니다. SKILL 9단계는 op를 먼저 부르라고 합니다("Before loading the `ultragoal` skill, hand ralplan off", `skills/ralplan/SKILL.md:119-123`). 그 순서면 게이트는 비활성 ralplan을 보고 시드 경로로 가고, 이미 활성인 ultragoal은 `"kept"`입니다. 로드를 먼저 해 게이트가 넘긴 뒤 op를 부르면 "already handed off"로 거부됩니다(U8). SKILL은 같은 execution의 로드가 스스로 넘기고 나중 execution의 로드는 넘기지 않는다고도 적습니다(`:127`).
- **거부된 로드는 표식을 세우지 않습니다.** 같은 execution에서 `final`까지 쓴 뒤 다시 로드하면 표식 `ralplan`이 남아 있으므로 넘깁니다(테스트 "(I)").
- **게이트 안의 예외**(계보 조회 실패, ultragoal 상태 손상으로 인한 인계 거부 등)는 `execute.before`가 로그만 남기고 로드를 통과시킵니다(`:1094-1096`). 표식은 세우지 않습니다.

**나중 execution의 로드.** 표식은 execution이 끝날 때마다 지워지므로, continuation이나 백그라운드 subagent 완료가 연 execution에서 `skill ultragoal`을 로드하면 ralplan을 보지 않고 시드합니다(ralplan 편차 37, 루트 README 알려진 동작 `README.md:298`). 실행 예(`final`에서 활성인 ralplan):

| 시점 | ralplan 상태 | ralplan 행 | ultragoal |
|---|---|---|---|
| 나중 execution의 `skill ultragoal` 뒤 | `active: true`, `final` | 없음(시드가 위쪽 행으로 지움) | 활성 `goal-planning`, `handoff_from` 없음 |
| 이어서 `ralplan handoff(to:"ultragoal")` | `active: false`, `handoff`, `handoff_to: "ultragoal"` | 비활성 `handoff_to` 행 | 활성 `goal-planning`, `handoff_from: "ralplan"` |

ralplan이 활성 `final`로 남아 있는 동안 op는 여전히 통과하므로, 순서가 뒤바뀌어도 `ralplan handoff`를 부르면 정리됩니다. 계획 중 phase(예: `planner`)에서 나중 execution에 로드하면 ralplan은 활성 `planner`로 남고 행만 지워집니다(실행 예). 행이 없으므로 ralplan 계획 가드와 continuation은 걸리지 않습니다(ralplan 편차 10).

## Stop here

SKILL 9단계의 **Stop here**는 `ralplan state(patch={"active": false})`입니다. `patchStateTx`(`src/ralplan-runtime/store.ts:1001-1079`)가 `active`를 `false`로 바꾸고 phase는 그대로(`final`) 둡니다(spec D-F12). 비활성이므로 활성 행을 지웁니다(R-OD10). `pending-approval.md`와 단계 파일은 남습니다.

그 뒤:

- 행이 없으므로 계획 가드가 풀리고 continuation이 멈춥니다([guards-and-continuation.md](guards-and-continuation.md)).
- `ralplan handoff`는 두 `to` 모두 "not active (phase final)" 문구로 거부됩니다([위 표](#검사-순서-ralplanhandofftx)). gjc에서는 Stop here로 턴이 끝나고 다음 턴의 skill 로드가 넘길 활성 skill을 찾지 못하는데, 이 결과에 맞춘 것입니다(R-OD18, ralplan 편차 34; gjc `tools/skill.ts:170-171,203-221`).
- 나중에 실행을 원하면 `skill ultragoal`이 `handoff_from` 없이 `goal-planning`을 시드합니다. ralplan은 비활성 `final`로 남습니다(실행 예, U25). 같은 execution에서 로드해도 ralplan이 비활성이라 같은 시드 경로입니다.
- `ralplan start`는 다시 통과하지만 `run_id` 없이는 옛 run 폴더를 씁니다([위](#ralplan-start로-시작)).
- 같은 run의 `write`는 잠긴 phase(`final`)를 바꾸지 않아 상태가 비활성으로 남습니다(DR-3, R-OD9, [stages-and-ledger.md](stages-and-ledger.md)).

## 공통 저널 인계 (ralplan 쪽 요약)

`handoffWorkflowTx`(`src/skill-state/handoff.ts:212-322`)는 세 skill의 모든 넘기기가 함께 쓰는 하나입니다(ultragoal 계획 C-5, PQ-6 A). gjc 출처는 `gjc-runtime/state-runtime.ts:1572-1881`(`handleHandoffUnlocked`, 머리말 기준)입니다. 단계는 이렇습니다.

```
0  callee == caller → 거부
①  두 상태 읽기: 손상 → 거부, caller 없음 → 거부, callee 없음 → {}
②  두 병합 상태를 메모리에서 만들고 assertStatePayload (DR-31)
③  저널 시작 (pending)
④  callee 상태 쓰기 (활성, 시작 phase, handoff_from, handoff_at)   → step callee-mode-state
⑤  caller 상태 쓰기 (비활성, handoff, handoff_to, handoff_at)      → step caller-mode-state
⑥  caller 비활성 handoff_to 행, callee 활성 행, 스냅숏             → step active-state
⑦  (ultragoal caller만) recordCaller                              → step caller-records
⑧  저널 committed → 삭제, 영수증 반환
```

단계별 감사 행, 필드 병합 표, 저널 파일 이름과 수명, 실패하면 남는 것은 [ultragoal 문서](../ultragoal/entry-and-handoff.md#공통-저널-인계-handoffworkflowtx)와 [deep-interview 문서](../deep-interview/entry-and-handoff.md#공통-저널-인계-handoffworkflowtx)에 있습니다. 저널은 증거용이라 다시 실행하거나 되돌리는 코드가 없고 doctor도 읽지 않습니다(ralplan 편차 13).

ralplan에 해당하는 것:

- **시작 phase**: ralplan이 callee면 `planner`(`HANDOFF_SKILLS`, `handoff.ts:75-92`). 이미 활성인 ralplan(예: `architect`)도 `planner`로 돌아갑니다. 단계 파일은 남습니다.
- **전이 진단**: callee를 활성으로 쓰면서 저장된 ralplan phase가 `RALPLAN_STATES`에 있고 `planner`와 다르면, `RALPLAN_TRANSITIONS`에 `planner`로 들어가는 줄이 없으므로 `invalid_transition_detected` 행이 `handoff` 행보다 먼저 남습니다(best-effort, `handoff.ts:172-189`). 상태가 없거나 `planner`이거나 R의 phase(`clear` 뒤 `complete`)면 남지 않습니다. ralplan이 caller면 비활성으로 쓰므로 남지 않습니다.
- **HUD**: 두 행의 칩은 병합한 상태로 다시 계산합니다(ralplan `buildRalplanHudFromState`).
- **쓰는 주체**: `_meta.updatedBy`는 caller와 owner로 정합니다(`WRITERS`, `handoff.ts:95-99`). ralplan이 callee일 때는 caller의 값(`deep_interview_tool`, `deep_interview_hook`, `ultragoal_tool`)이 적힙니다.
- **goal**: 어떤 인계도 goal 상태를 건드리지 않습니다(D-HE2).

## 체인 가드와 막지 않는 것

ralplan 쪽 체인은 **ultragoal 방향으로만** 지킵니다(ralplan 편차 37, spec C-4, D-F12). gjc의 skill 도구는 현재 턴에 로드한 workflow skill(`getActiveSkillState`, `session/agent-session.ts:5961-5967`)을 기준으로, 같은 skill을 다시 로드하는 것을 거부하고(`tools/skill.ts:170-176`), 계획 중인 ralplan에서 어떤 skill로든 나가는 것을 거부하며, T에서는 로드하는 skill로 `gjc state handoff`를 돌립니다(`:42,54-61,200-221`). 이 줄 번호는 핀 커밋의 gjc 소스에서 확인했습니다.

코드가 막는 것:

| 시도 | 조건 | 결과 | 근거 |
|---|---|---|---|
| `skill ralplan` | ultragoal이 보이는 주 skill | 거부(체인 가드) | D-HE3, ultragoal 편차 22 |
| `@ralplan`, ralplan 키워드 | ultragoal이 보이는 주 skill | 안내만 handoff 안내로 | PQ-5 (1) B |
| `ralplan start` | ultragoal 상태 활성 / ralplan 상태 활성 | 거부 | ultragoal 계획 C-3 / ralplan 편차 39 |
| ralplan을 로드한 같은 execution의 `skill ultragoal` | ralplan 활성, 계획 중 phase | 거부 | ultragoal 계획 C-10 |
| ralplan을 로드한 같은 execution의 `skill ultragoal` | ralplan 활성, T | ralplan을 넘김 | D-HE6 |
| `ralplan handoff` | phase ∉ T, 또는 비활성 | 거부 | ralplan 편차 34 |
| deep-interview를 로드한 같은 execution의 `skill ralplan` | deep-interview `interviewing` 등 | 거부 | DR-21 |
| `deep-interview start` | ralplan이 보이는 주 skill | 거부 | deep-interview 편차 12 |

막지 않는 것(`ralplan write` 줄은 테스트, 나머지는 실행 예로 확인):

| 시도 | 지금 | 결과 |
|---|---|---|
| `skill ralplan` 다시 로드 | ralplan 계획 중 | 로드됨, 상태 그대로(ralplan 편차 37) |
| `skill deep-interview` | ralplan 계획 중 | 로드됨. 다만 이어서 부르는 `deep-interview start`는 거부됨 |
| 나중 execution의 `skill ultragoal` | ralplan 계획 중이거나 활성 `final` | ultragoal 시드, ralplan 활성으로 남고 행만 지워짐 |
| `ultragoal create` | ralplan 계획 중 | 통과. ultragoal 행이 생기고 ralplan 행이 지워짐, ralplan은 활성 `planner`로 남음 |
| `ralplan write` | ultragoal 실행 중 | 통과, ralplan을 활성으로 만들 수 있음(R-AE1, U22; `tests/ralplan-tool.test.ts` "… runs beside ultragoal (P-AC4, P-AC11)") |
| 결합 호출 `spec(…, handoff:"ralplan")` | ralplan 활성 | 다시 시드. 실행 예: `task: "old"`, `mode: "short"`이던 활성 run이 같은 `run_id`로 `task` = 스펙 경로, `mode: "deliberate"`가 됨(K12, K14) |
| `ultragoal handoff(to:"ralplan")` | ralplan 계획 중 활성 | 통과. 실행 예: 활성 `architect`가 `planner`로 돌아가고 `invalid_transition_detected`(`architect`→`planner`)가 남음 |

`deep-interview start`가 ralplan 계획 중에 낸 실제 거부입니다(deep-interview 쪽 문구).

```
deep-interview start is refused while ralplan is the active workflow (phase planner). To interview from here: while ultragoal runs, call `ultragoal handoff(to: "deep-interview", reason)`; once ralplan has finished (final), call `ralplan handoff(to: "deep-interview")`; or stop ralplan first with `ralplan state {"active": false}` or `ralplan clear`, then start.
```

계획 중에 다른 skill로 새지 않게 하는 것은 SKILL의 Planning/Execution Boundary 문단(`skills/ralplan/SKILL.md:36-43`)입니다.

## 왕복 예

실행 예의 상태 필드입니다(DI = deep-interview, RP = ralplan, UG = ultragoal, `행`은 활성 행). 모두 같은 세션이고, `<sid>`는 루트 세션 id입니다.

**deep-interview → ralplan → ultragoal**

```
1. DI start, write(round 1), spec(slug "s")
     DI {active, handoff, spec_path specs/deep-interview-s.md}       DI 행 활성 handoff
2. deep-interview handoff(to:"ralplan")   (결과 줄: Handed off to ralplan …)
     DI {inactive, handoff, handoff_to ralplan}                      DI 행 비활성 handoff_to
     RP {active, planner, handoff_from deep-interview}  run_id 없음   RP 행 활성 planner
3. ralplan start → 거부: ralplan run (none) is already active (phase planner, handed over from deep-interview) …
4. ralplan write(planner, 1)
     RP {active, planner, run_id <sid>, handoff_from deep-interview} RP 행(handoff_from 없음), DI 행 지워짐
5. ralplan write(final, 1)
     RP {active, final, run_id <sid>, handoff_from deep-interview}
6. ralplan handoff(to:"ultragoal")
     RP {inactive, handoff, run_id <sid>, handoff_from deep-interview, handoff_to ultragoal}  RP 행 비활성 handoff_to
     UG {active, goal-planning, handoff_from ralplan}                         UG 행 활성
```

2를 `spec(…, handoff:"ralplan")` 한 번으로 하면 RP는 `{active, planner, run_id <sid>, task <session>/specs/deep-interview-s.md, mode deliberate, interactive false, handoff_from deep-interview}`입니다. 같은 execution에서 `skill deep-interview` 뒤 `skill ralplan`을 로드하면 2를 게이트가 하고 결과 줄은 없습니다.

**ultragoal → ralplan → ultragoal**

```
1. RP start(v1), write(planner 1), write(final 1), handoff(to:"ultragoal"), UG create
     RP {inactive, handoff, run_id <sid>, task v1, handoff_to ultragoal}   RP 행 없음(create가 지움)
     UG {active, pending, handoff_from ralplan}
2. ultragoal handoff(to:"ralplan", reason "replan")
     RP {active, planner, run_id <sid>, task v1, mode short, handoff_from ultragoal, handoff_to ultragoal}
     UG {inactive, handoff, handoff_from ralplan, handoff_to ralplan}
3. ralplan start → 거부: ralplan run <sid> is already active (phase planner, handed over from ultragoal) …
4. ralplan write(planner, 1) → 거부(다른 내용, 이미 있는 stage_n)
   ralplan write(revision, 2) → RP {active, revision, run_id <sid>}
5. ralplan write(planner, 1, run_id "r2") → RP {active, planner, run_id r2, task v1, handoff_from ultragoal, handoff_to ultragoal}
6. ralplan write(final, 1, run_id "r2"), skill ralplan, skill ultragoal (같은 execution)
     RP {inactive, handoff, run_id r2, handoff_from ultragoal, handoff_to ultragoal}
     UG {active, goal-planning, handoff_from ralplan, handoff_to ralplan}
7. (이 실행에서는 돌리지 않음) ultragoal create → goals.json을 새로 씀
```

7단계의 goal 유지 규칙은 [ultragoal 문서의 왕복 예](../ultragoal/entry-and-handoff.md#왕복-예)에 있습니다.

인계는 필드를 지우지 않으므로 왕복하면 옛 `handoff_to`와 새 `handoff_from`이 함께 남습니다.

**ralplan → deep-interview → ralplan**

```
1. (위 첫 예의 1~2), ralplan write(planner 1), write(final 1)
     RP {active, final, run_id <sid>, handoff_from deep-interview}
2. ralplan handoff(to:"deep-interview")   (결과 줄: Handed off to deep-interview … (the approved plan: …))
     RP {inactive, handoff, run_id <sid>, handoff_from deep-interview, handoff_to deep-interview}
     DI {active, interviewing, handoff_from ralplan, handoff_to ralplan, spec_path …-s.md, 라운드 1개}
3. deep-interview write(round 2), spec(slug "s2"), handoff(to:"ralplan")
     DI {inactive, handoff, spec_path …-s2.md, 라운드 2개}
     RP {active, planner, run_id <sid>, handoff_from deep-interview, handoff_to deep-interview}
4. ralplan start → 거부 (handed over from deep-interview)
5. ralplan write(revision, 2) → RP {active, revision, run_id <sid>}  같은 run을 이어 씀(K7)
```

## 코드가 강제하는 것과 SKILL만 요구하는 것

| 규칙 | 코드 | SKILL만 |
|---|---|---|
| 키워드·멘션 안내와 `skill ralplan` 로드는 ralplan 상태를 쓰지 않음 | 예(DR-21 게이트의 인계만 예외) | |
| 안내는 `open-gajae`(또는 agent 없음)에만 | 예 | |
| run은 `ralplan start`로 시작 | 아니오: `write`도 상태를 만듦 | 예 ("call `ralplan start` … before step 1", `SKILL.md:17`) |
| ultragoal 활성 중 `start` 거부 | 예(상태 기준) | |
| 활성 run(넘겨받은 run 포함) 위에서 `start` 거부 | 예(ralplan 편차 39) | 결과 줄과 SKILL도 안내 |
| 넘겨받은 run은 `write`로 이어 가고, 새 예산이면 첫 `write`에 새 `run_id` | 옛 run의 `stage_n` 중복만 거부 | 예 |
| 결과 줄을 못 봤으면 `spec_path`를 읽어 계획 입력으로 | | 예 |
| 멈춘 뒤 새 계획은 새 `run_id`로 | 아니오(`start`가 옛 `run_id`를 다시 씀) | 예(`SKILL.md:17`) |
| `ralplan handoff`는 T와 `active`를 요구 | 예 | |
| `ultragoal` 로드 전에 `ralplan handoff` | 같은 execution이면 게이트가 대신 넘김 | 예(9단계, `SKILL.md:119-127`) |
| 계획 중 ultragoal로 나가지 않음 | 같은 execution의 `skill ultragoal`만 거부 | 예(Boundary 문단) |
| 계획 중 다른 skill을 로드하지 않음 | 아니오(ralplan 편차 37) | 예 |
| Stop here는 `state {"active": false}`, phase는 `final` 유지 | phase 유지와 행 삭제는 코드 | 부르는 것은 SKILL 9단계 |
| deep-interview로 돌아간 뒤 `deep-interview start` 대신 `write` | 아니오(deep-interview가 주 skill이면 `start`가 통과) | 예(결과 줄, `SKILL.md:129`) |
| 넘긴 뒤 계획하는 동안 `ultragoal` op를 부르지 않음 | 아니오(reconcile이 ultragoal을 다시 켬) | 예(ultragoal SKILL) |
| 계획 경로 전달 | 결과 줄의 글로만(U6) | `create`에 구조화한 인자로 옮기는 것은 SKILL |
