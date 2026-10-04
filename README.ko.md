[English](README.md) | [한국어](README.ko.md)

<div align="center">

# open-gajae

**막연한 아이디어를 검증된 코드 변경으로 이끄는 OpenCode 플러그인입니다.**

`deep-interview`로 명확화 · `ralplan`으로 계획 · `ultragoal`로 실행

<img src="assets/branding/open-gajae-banner.png" width="980" alt="open-gajae — Clarify. Plan. Execute.">

<sub><a href="#빠른-시작">빠른 시작</a> · <a href="#워크플로-명확화--계획--실행">워크플로</a> · <a href="#설정">설정</a> · <a href="#문서">문서</a></sub>

</div>

> [!WARNING]
> open-gajae는 학습과 실험을 위해 대부분 AI로 만든 비공식 개인 프로젝트이며, 상당 부분이 AI slop입니다. 최적화, 버그, 기능은 앞으로 조금씩 고쳐 나갈 예정입니다.

## 배경

[gajae-code](https://github.com/Yeachan-Heo/gajae-code)와 [oh-my-claudecode (OMC)](https://github.com/Yeachan-Heo/oh-my-claudecode)를 너무 잘 쓰고 있습니다. (이 프로젝트도 이 두 harness로 개발했습니다.) 아쉽게도 지금은 사내 정책 때문에 OpenCode만 쓸 수 있어서, OpenCode에서도 비슷하게 쓸 수 있도록 직접 만들어 봤습니다. OpenCode 플러그인 만드는 법은 [oh-my-openagent (OMO)](https://github.com/code-yeongyu/oh-my-openagent) 코드를 보면서 많이 배웠습니다.

좋은 프로젝트를 만들어 주신 분들께 감사드립니다.

open-gajae는 위 프로젝트들과는 관계 없는 개인 프로젝트입니다. 공식 이식판이 아니며, 기능과 동작 또한 다를 수 있습니다.

## 빠른 시작

```sh
# 1) 설치 (Bun 또는 Node.js)
bunx open-gajae install     # 또는: npx open-gajae install

# 2) 출력이 알려 주면 OpenCode를 다시 시작합니다. 이때 OpenCode가 npm에서 open-gajae를 받아 옵니다.

# 3) 새 세션에서 보내 보세요:
#    @deep-interview API에 속도 제한 넣고 싶어
```

**OpenCode v2가 필요합니다(2.0.15 기준, v1은 지원하지 않음).** `default_agent`를 다른 값으로 두었다면 3단계 전에 `open-gajae` 에이전트로 바꿉니다.

| 설치가 넣는 것 | 값 | 이미 값이 있으면 |
|---|---|---|
| `plugins` | `"open-gajae"` 추가 | 그대로 둠 |
| `default_agent` | `"open-gajae"` | 그대로 둠 |
| `experimental.subagent_depth` | `2` | 그대로 둠. 2보다 작으면 안내 |
| `~/.open-gajae/open-gajae.jsonc` | 모든 설정이 주석인 템플릿 | 건드리지 않음 |

- **고치는 파일:** OpenCode 전역 설정 폴더(`OPENCODE_CONFIG_DIR`, 없으면 `$XDG_CONFIG_HOME/opencode`, 그것도 없으면 `~/.config/opencode`)의 `opencode.jsonc`, 그 파일이 없으면 `opencode.json`입니다. 둘 다 없으면 `opencode.jsonc`를 만들고, 둘 다 있으면 `opencode.jsonc`만 고치며 경고를 출력합니다.
- **안전장치:** 기존 파일은 고치기 전에 `<파일 이름>.bak-<YYYYMMDD-HHMMSS>`로 백업합니다. JSON·JSONC가 잘못되었으면 아무것도 쓰지 않고 멈추며, 다시 실행해도 바뀌는 것이 없습니다.

### 직접 설정

OpenCode 전역 설정 폴더의 `opencode.json`이나 `opencode.jsonc`에 다음 키를 넣습니다. 파일의 나머지 내용은 그대로 둡니다.

```json
{
  "plugins": ["open-gajae"],
  "default_agent": "open-gajae",
  "experimental": {
    "subagent_depth": 2
  }
}
```

| 키 | 하는 일 |
|---|---|
| `plugins` | open-gajae를 불러옵니다. 목록이 이미 있으면 끝에 `"open-gajae"`를 덧붙입니다. |
| `default_agent` | 스킬은 `open-gajae` 에이전트에서만 동작하므로, 새 세션의 에이전트를 이것으로 정합니다. |
| `experimental.subagent_depth` | OpenCode 기본값 1에서는 메인 에이전트만 서브에이전트를 시작할 수 있습니다. 2로 두면 planner와 executor가 다른 역할에 일을 맡길 수 있습니다. |

두 파일이 다 있으면 OpenCode는 `plugins` 목록을 합치고, `default_agent`와 `experimental`은 `opencode.jsonc`의 값을 씁니다.

### 제거

제거 명령은 따로 없습니다. 전역 설정에서(두 파일이 있으면 두 파일 모두) 다음을 지웁니다.

1. `plugins`에서 `"open-gajae"`를 지웁니다. 예전 키인 `plugin`을 썼다면 거기서도 지웁니다.
2. `default_agent`가 `"open-gajae"`이면 지웁니다.
3. `experimental.subagent_depth`는 다른 에이전트나 플러그인이 쓸 수도 있으니 남길지 직접 정합니다.
4. 필요 없으면 `~/.open-gajae/open-gajae.jsonc`를 지웁니다.

마친 뒤 OpenCode를 다시 시작합니다. 프로젝트의 `.open-gajae/` 폴더(그 프로젝트의 세션 기록과 설정)는 영향을 받지 않습니다.

## 워크플로: 명확화 → 계획 → 실행

스킬은 메인 `open-gajae` 에이전트에서 실행되고, 이 에이전트는 서브에이전트 역할 여덟 개에 일을 맡깁니다(설정 절의 역할 표 참고). 세션마다 생기는 스펙, 계획, 목표 같은 작업 기록은 프로젝트의 `.open-gajae/` 아래에 저장됩니다.

스킬은 하나씩 따로 쓸 수 있고, deep-interview와 ralplan은 끝날 때 결과를 다음 스킬로 넘길지 묻습니다. `open-gajae` 에이전트에서 스킬을 시작하는 방법은 두 가지입니다.

- 이름을 넣어 요청하기: `ralplan을 써서 API 속도 제한을 계획해 줘`
- 멘션하기: `@ralplan`을 입력하고 자동완성 목록에서 고릅니다.

```text
아이디어
    │
    ▼
deep-interview (명확화)   질문을 하나씩
    │  스펙 완성 → ralplan으로 다듬기를 선택
    ▼
ralplan (계획)            planner, architect, critic
    │  승인을 기다리는 계획 → ultragoal 실행을 승인
    ▼
ultragoal (실행)          목표마다 리뷰하며 진행
    │
    ▼
검증된 변경
```

### deep-interview

deep-interview는 질문을 한 번에 하나씩 하고, 답을 들을 때마다 요청이 아직 얼마나 모호한지 점수를 매깁니다. 점수가 기준치(기본 0.05) 이하로 내려가면 스펙을 쓰고, ralplan으로 다듬을지, ultragoal로 실행할지, 더 다듬을지, 여기서 마칠지 묻습니다.

Try: `@deep-interview API에 속도 제한 넣고 싶어`

[deep-interview 동작 문서](docs/skills/deep-interview/README.md)

### ralplan

ralplan에서는 planner가 계획 초안을 쓰고 architect와 critic이 검토하며, 둘이 모두 승인하거나 회차 상한에 이를 때까지 계획을 고칩니다. 단계마다 결과를 파일로 남깁니다. 두 리뷰어가 승인한 계획은 더 다듬을지, ultragoal로 실행할지, 여기서 멈출지 사용자가 고르고, 회차 상한에서 멈춘 계획은 읽을 수 있게 남겨 두되 실행하지 않습니다.

Try: `@ralplan API 속도 제한 계획 세워 줘`

[ralplan 동작 문서](docs/skills/ralplan/README.md)

### ultragoal

ultragoal은 작업을 수용 기준이 있는 목표로 나누고 하나씩 처리합니다. 각 목표는 architect 리뷰를 거쳐야 완료되고, 마지막 목표는 정리(cleanup)·아키텍처·QA 리뷰에 이어 최종 critic 점검까지 받습니다.

Try: `@ultragoal API에 속도 제한 넣어 줘`

[ultragoal 동작 문서](docs/skills/ultragoal/README.md)

## 설정

open-gajae는 없어도 되는 설정 파일 두 개를 읽습니다. 모든 프로젝트에 적용되는 `~/.open-gajae/open-gajae.jsonc`와, 프로젝트 루트의 `.open-gajae/open-gajae.jsonc`입니다. 프로젝트 값이 사용자 값을 키 단위로 덮어쓰고, 정하지 않은 항목은 기본값을 씁니다. 두 파일 모두 JSONC라서 주석과 끝 쉼표를 쓸 수 있습니다. 설정은 엄격하게 검사합니다. 문법 오류, 알 수 없는 키, 잘못된 값은 오류로 보고되고, 고칠 때까지 open-gajae가 로드되지 않습니다. open-gajae는 프로젝트에서 시작할 때 설정을 한 번만 읽으므로, 설정을 고친 뒤에는 OpenCode를 다시 시작하세요.

`open-gajae install`이 만든 템플릿에는 모든 설정이 주석으로 들어 있습니다. 바꾸고 싶은 설정 앞의 `//`를 지우면 됩니다. 예를 들면 다음과 같습니다.

```json
{
  "deepInterview": { "ambiguityThreshold": 0.1 },
  "ralplan": { "maxIterations": 3 },
  "agents": {
    "open-gajae": { "model": "provider/model", "variant": "high" },
    "open-gajae-planner": { "model": "provider/model" }
  }
}
```

`provider/model` 자리에는 OpenCode에 등록한 프로바이더의 모델을 `provider/model` 형식으로 적습니다.

| 설정 | 기본값 | 허용 값 | 하는 일 |
|---|---|---|---|
| `deepInterview.ambiguityThreshold` | `0.05` | 0보다 크고 1 이하 | 모호도가 이 값 이하가 되면 deep-interview가 스펙을 씁니다. 요청에서 기준치를 직접 말하면 그 인터뷰에는 그 값을 씁니다. |
| `ralplan.maxIterations` | `5` | 1~20 정수 | ralplan 실행 하나가 열 수 있는 계획 회차(planner 초안이나 수정)의 최대 수 |
| `ralplan.maxReviewPassesPerLane` | `1` | 1~10 정수 | 회차마다 architect와 critic이 각각 쓸 수 있는 리뷰 수 |
| `ralplan.autoHandoff` | `"off"` | `"off"` 또는 `"ultragoal"` | `"ultragoal"`이면 완성된 계획을 승인 질문 없이 ultragoal로 넘깁니다. 회차 상한에 걸린 계획은 넘기지 않습니다. |
| `agents.<역할>.model`, `agents.<역할>.variant` | 없음 | `provider/model`, 그 모델이 지원하는 variant | 역할이 쓸 모델. `model`이 없으면 OpenCode가 고르고, `variant`를 쓰려면 같은 역할에 `model`이 있어야 합니다(두 파일 중 어디에 있어도 됨). |

역할과 에이전트 이름은 다음과 같습니다.

| 역할 | 하는 일 | 편집 도구 |
|---|---|---|
| `open-gajae` | 메인 에이전트. 사용자와 대화하고, 세 스킬을 실행하고, 아래 역할에 일을 맡깁니다. | 허용 |
| `open-gajae-explore` | 저장소의 파일, 심볼, 관계를 조사합니다. | 거부 |
| `open-gajae-document-specialist` | 문서를 조사하고 출처를 밝힙니다. | 거부 |
| `open-gajae-planner` | ralplan의 계획을 쓰고 고칩니다. | 거부 |
| `open-gajae-architect` | ralplan의 계획과 ultragoal의 각 목표를 리뷰합니다. | 거부 |
| `open-gajae-critic` | ralplan의 최종 계획 리뷰와 ultragoal의 최종 점검을 맡습니다. | 거부 |
| `open-gajae-executor` | ultragoal이 맡긴 코드 변경을 하고, ultragoal의 QA 리뷰를 맡습니다. | 허용 |
| `open-gajae-cleaner` | ultragoal에서 바뀐 파일의 AI slop과 정리할 점을 찾아 보고하며, 파일은 고치지 않습니다. | 거부 |
| `open-gajae-lateral-reviewer` | deep-interview 리뷰 패널의 리뷰어 페르소나를 맡습니다. | 거부 |

`open-gajae`를 뺀 역할은 모두 서브에이전트로 실행됩니다. OpenCode 설정에서 이 에이전트들에 정한 권한 규칙은 open-gajae의 규칙 뒤에 적용되어 우선합니다.

읽기 전용 코드 도구는 함께 설치되는 ast-grep 라이브러리로 코드를 구문 단위로 검색하고, 이미 설치된 언어 서버로 심볼을 조회합니다. open-gajae가 언어 서버를 내려받지는 않습니다.

## 문서

- 스킬 문서: [deep-interview](docs/skills/deep-interview/README.md), [ralplan](docs/skills/ralplan/README.md), [ultragoal](docs/skills/ultragoal/README.md)이 지금 코드에서 어떻게 동작하는지 단계별로 설명합니다.
- [개발 문서](docs/development.md)(관리자용): 범위와 상태, 고정한 참조 버전, 참조 프로젝트와 달라진 점의 기록, 후속 개발, 검증 근거를 담습니다.
- [Third-party notices](THIRD-PARTY-NOTICES.md)(영어): open-gajae가 포함하거나 고쳐 쓴 외부 자료와 그 라이선스를 적습니다.
- [배너 출처](assets/branding/open-gajae-banner.md)(영어)

## 라이선스

- 자체 코드: MIT
- oh-my-openagent(OMO)에서 가져온 부분: Sustainable Use License (무료·비상업적 배포만 허용)
- 그 밖의 외부 자료: 각 원본 라이선스

자세히: [LICENSE](LICENSE) · [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
