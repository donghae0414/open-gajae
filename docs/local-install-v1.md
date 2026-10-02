# 로컬 설치 기록 (OpenCode v1)

OpenCode v2로 넘어가면서 로컬 OpenCode 설정에서 뺀 open-gajae 항목을 기록한 문서입니다. 나중에 같은 설정을 다시 넣을 때 참고합니다.

- 기록 시점: 2026-09-23
- 호스트: OpenCode v1 1.18.31 (`~/.opencode/bin/opencode`, 공식 설치 스크립트)
- 플러그인: open-gajae `main` e47b4c1, v1 플러그인 API `@opencode-ai/plugin` 1.18.30
- 갱신: 2026-10-02, deep-interview gjc 개정(브랜치 `feat/deep-interview-gjc-revision`)에서 지금 플러그인에 없는 설정 key 두 줄(라운드 상한, 회사 맥락)을 2절 표에서 지우고, 3절 도구 목록의 상태 도구 이름을 "옛 상태 도구 3개(`state_*`)"로 바꿨습니다. 나머지는 기록 시점 그대로입니다.

현재 open-gajae는 v1 플러그인입니다. v2 호스트는 v1 플러그인을 로드하지 않습니다(`Plugin must export a default definition with an id and an effect or setup function.`). 아래 항목은 **v1 호스트에서만** 다시 넣을 수 있습니다. v2 전환 뒤의 설치 방법은 v2 이식이 끝난 뒤 따로 정합니다.

## 1. 호스트 설정 파일에 넣었던 항목

플러그인이 호스트 설정 파일을 자동으로 고치지는 않습니다. 아래 항목은 직접 넣은 것입니다.

### `~/.config/opencode/opencode.jsonc`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "open-gajae",
  "plugin": ["file:///Users/dongwuk/apps/open-gajae/dist/index.js"]
}
```

| 키 | 역할 |
|---|---|
| `plugin` | 빌드한 서버 플러그인(`dist/index.js`)을 로드합니다. `bun run build`로 만듭니다. |
| `default_agent` | 새 세션의 기본 에이전트를 `open-gajae`로 정합니다. 플러그인이 없으면 이 에이전트도 없으므로 함께 뺐습니다. |

### `~/.config/opencode/tui.json`

```json
{
  "plugin": ["file:///Users/dongwuk/apps/open-gajae/dist/tui.js"],
  "scroll_acceleration": {
    "enabled": true
  }
}
```

- `plugin`의 `dist/tui.js`는 보관 중인 ultragoal WIP(`feat/ultragoal-port` fa427d3)에서만 빌드됩니다. `main`의 `dist/`에는 `index.js`만 있으므로, `main` 기준으로는 이 항목을 넣지 않습니다.
- `scroll_acceleration`은 open-gajae와 관계없는 호스트 설정입니다. v2는 처음 실행할 때 전역 `tui.json`의 지원 설정을 `~/.config/opencode/cli.json`으로 옮깁니다.

### `~/.config/opencode/package.json`

```json
{ "dependencies": { "@opencode-ai/plugin": "1.18.29" } }
```

호스트가 관리하는 v1 플러그인 의존성입니다. 직접 넣은 항목이 아니므로 다시 넣을 필요가 없습니다.

## 2. open-gajae 자체 설정 (그대로 둠)

`~/.open-gajae/open-gajae.jsonc`(사용자)와 `<worktree>/.open-gajae/open-gajae.jsonc`(프로젝트)는 플러그인이 읽는 설정입니다. 호스트는 읽지 않으므로 v2 설치에 영향이 없고, 지우지 않았습니다. 같은 키는 프로젝트 설정이 우선합니다.

| 키 | 기본값 | 내용 |
|---|---|---|
| `deepInterview.ambiguityThreshold` | `0.2` | spec을 저장할 모호도 임계값 |
| `agents.<이름>` | 없음 | 역할별 `model`/`variant`. 로컬에서는 primary·explore에 `openai/gpt-5.6-luna`, planner·architect·critic에 `openai/gpt-5.6-terra`를 씁니다. |

로컬 파일에 있는 `open-gajae-executor`, `open-gajae-qa-tester` 항목은 ultragoal WIP용입니다.

> **역사적 정정 (2026-09-24, v2 이식 Step 9에서 추가):** 위 문장은 틀렸습니다. `open-gajae-executor`/`open-gajae-qa-tester`처럼 6개 에이전트 이름에 없는 key가 `agents`에 있으면 `main`은 이를 조용히 무시하지 않고 `unknown setting` 오류로 설정 로드 자체를 거부합니다(엄격한 key 검증, `src/config.ts`의 `keys()`). 이 기록 시점(2026-09-23)에 로컬 설정 파일에서 해당 항목을 이미 정리해 두었기 때문에 실제로는 오류가 발생하지 않았을 뿐입니다. v2의 같은 검증 규칙은 [README.ko.md](../README.ko.md)의 "자체 역할과 설정"을 참고하세요.

## 3. 플러그인이 로드되면 호스트에 등록하는 것

파일을 고치지 않고, 로드될 때 `config` 훅으로 메모리에 있는 설정에 추가합니다. 사용자가 같은 이름으로 설정한 `model`/`variant`는 유지됩니다.

- **에이전트 6개**: `open-gajae`(primary), `open-gajae-explore`, `open-gajae-document-specialist`, `open-gajae-planner`, `open-gajae-architect`, `open-gajae-critic`. 프롬프트는 `prompts/<이름>.md`입니다.
- **명령 2개**: `/ralplan`, `/deep-interview`. 호스트가 스킬에서 만드는 같은 이름의 명령을 가립니다.
- **스킬 경로**: 패키지의 `skills/`를 `skills.paths`에 추가합니다.
- **`subagent_depth`**: 최소 2로 올립니다. 사용자가 더 큰 값을 넣었으면 그대로 둡니다.
- **권한**: 전역이나 primary에 `question` 권한 설정이 없으면 primary에 `question: allow`를 넣습니다.
- **도구 8개**: 옛 상태 도구 3개(`state_*`), `ast_grep_search`, `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_servers`.
- **훅**: `event`, `chat.message`, `tool.execute.before`, `command.execute.before`.

작업 산출물은 `<worktree>/.open-gajae/_session-<생성 시각>-<세션 ID>/` 아래에 저장됩니다.

## 4. v1 호스트에 다시 넣는 순서

1. v1을 설치합니다: `curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.31`
2. 플러그인을 빌드합니다: `bun install && bun run build`
3. 1절의 `opencode.jsonc` 항목(`plugin`, `default_agent`)을 넣습니다. 파일 전체를 바꾸지 말고 이 키만 추가합니다.
4. OpenCode를 다시 시작하고 등록 상태를 확인합니다.

```sh
opencode debug skill
opencode debug agent open-gajae
opencode debug agent open-gajae-planner
```
