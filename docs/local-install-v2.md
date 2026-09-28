# 로컬 설치 기록 (OpenCode v2)

로컬 OpenCode 설정에 open-gajae v2 플러그인을 등록하는 절차를 기록한 문서입니다. `docs/local-install-v1.md`와 같은 구성을 따르며, v1 호스트에는 적용되지 않습니다 — v1 호스트는 v2 플러그인을 로드하지 않습니다(`id`와 `setup`을 가진 default export를 요구하는 형태는 같지만, v1은 `@opencode-ai/plugin` 형태만 읽습니다).

- 기록 시점: 2026-09-24
- 호스트: OpenCode v2 `2.0.15` (`~/.opencode/bin/opencode`)
- 플러그인: open-gajae `feat/opencode-v2-port` 커밋 `f4df6e6`, v2 플러그인 API `@opencode/plugin` 2.0.15
- 갱신: 2026-09-29, GJC 기반 `ralplan`(도구 `ralplan`; TUI 사이드바는 보류, README "필수 후속 개발" 6번) — 브랜치 `feat/ralplan-gjc-stage-trail`

## 0. 저장소 준비

```sh
cd /Users/dongwuk/apps/open-gajae
bun install
bun run typecheck
bun test
```

`bun install`은 `package.json`의 `dependencies`(`@opencode/plugin`, `zod`, `@ast-grep/napi`, `jsonc-parser`)를 이 저장소의 `node_modules`에 설치합니다. 빌드 단계는 없습니다 — `package.json`의 `exports["."]`가 `./src/index.ts`를 가리키고, 루트 `index.ts`가 이를 re-export하므로 host는 TypeScript 소스를 바로 로드합니다. `dist/`는 만들지 않습니다.

## 1. 호스트 설정 파일에 넣을 항목

플러그인은 호스트 설정 파일을 자동으로 고치지 않습니다. 아래 항목을 직접 넣습니다.

### `~/.config/opencode/opencode.jsonc`

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/Users/dongwuk/apps/open-gajae"],
  "default_agent": "open-gajae",
  "experimental": { "subagent_depth": 2 }
}
```

| 키 | 역할 |
|---|---|
| `plugins` | 이 저장소의 **디렉터리**를 가리킵니다. v1의 `plugin: ["file:///…/dist/index.js"]`(빌드된 파일)와 달리, v2는 디렉터리 경로만 로드합니다. host는 `<dir>/server`, 그다음 `<dir>/index`를 확장자 추론과 함께 찾으며, 파일 경로로 설정된 plugin 항목은 건너뜁니다. 이 저장소는 root `index.ts` → `src/index.ts`이므로 `<dir>/index`로 잡힙니다. |
| `default_agent` | 새 세션의 기본 에이전트를 `open-gajae`로 정합니다. v1과 동일한 역할입니다. |
| `experimental.subagent_depth` | `open-gajae-planner`가 `subagent` 도구로 `open-gajae-explore`/`open-gajae-document-specialist`에 위임하려면 최소 2가 필요합니다. **플러그인이 이 값을 스스로 올릴 수 없습니다** — v2 플러그인 API에는 config를 수정하는 domain이 없어서, v1이 하던 `subagent_depth` 자동 상향이 v2에서는 불가능합니다. GJC 기반 planner 프롬프트에는 위임 지시가 없어 위임 여부는 모델이 정하며, 값이 없으면 host가 planner의 `subagent` 호출을 거부하고 planner는 직접 `read`/`grep`/`glob`로 조사합니다. |

파일 전체를 바꾸지 말고 이 세 key만 추가/유지하세요. 다른 host 설정(모델 provider, 다른 플러그인 등)은 그대로 둡니다.

### v1에서 옮길 필요 없는 항목

- `plugin`(v1의 단수형 키, `file://…/dist/index.js`)은 삭제합니다. v2는 `plugins`(복수형)를 씁니다.
- `~/.config/opencode/tui.json`의 `plugin: ["file://…/dist/tui.js"]` 항목: `main`에는 이 파일을 만드는 빌드 산출물이 없으므로 넣지 않습니다(v1 기록과 동일). v2에는 등록할 TUI 플러그인이 없습니다(ralplan 사이드바 보류, README "필수 후속 개발" 6번).
- `~/.config/opencode/package.json`의 `@opencode-ai/plugin` 항목: host가 관리하는 v1 의존성이며, v2 host는 이를 요구하지 않습니다.

## 2. open-gajae 자체 설정

`~/.open-gajae/open-gajae.jsonc`(사용자)와 `<worktree>/.open-gajae/open-gajae.jsonc`(프로젝트)는 host가 아니라 플러그인이 직접 읽는 설정입니다. field는 project → user → defaults 순으로 병합되며, 알 수 없는 key·잘못된 JSONC·잘못된 값은 오류로 설정 로드를 막습니다(v1과 같은 엄격한 검증). `companyContext` key는 v2에서 완전히 제거되었습니다 — 넣으면 `unknown setting`으로 실패합니다.

수동 테스트 체크리스트(아래 4절)에서 쓰는 예시로, 모든 역할에 `openai/gpt-6-luna`를 variant로 구분해 씁니다:

```jsonc
// ~/.open-gajae/open-gajae.jsonc
{
  "deepInterview": { "ambiguityThreshold": 0.2, "maxRounds": 20 },
  "ultragoal": {
    // 0이면 무제한, 기본 200
    "hardMaxIterations": 200
  },
  "ralplan": { "maxIterations": 5, "maxReviewPassesPerLane": 1, "autoHandoff": "off" },
  "agents": {
    "open-gajae": { "model": "openai/gpt-6-luna", "variant": "none" },
    "open-gajae-explore": { "model": "openai/gpt-6-luna", "variant": "low" },
    "open-gajae-document-specialist": { "model": "openai/gpt-6-luna", "variant": "low" },
    "open-gajae-planner": { "model": "openai/gpt-6-luna", "variant": "medium" },
    "open-gajae-architect": { "model": "openai/gpt-6-luna", "variant": "high" },
    "open-gajae-critic": { "model": "openai/gpt-6-luna", "variant": "high" },
    "open-gajae-executor": { "model": "openai/gpt-6-luna", "variant": "medium" },
    "open-gajae-cleaner": { "model": "openai/gpt-6-luna", "variant": "medium" }
  }
}
```

| 키 | 기본값 | 내용 |
|---|---|---|
| `deepInterview.ambiguityThreshold` | `0.2` | spec을 저장할 모호도 임계값 |
| `deepInterview.maxRounds` | `20` | 최대 인터뷰 라운드 |
| `ultragoal.hardMaxIterations` | `200` | `ultragoal` continuation iteration의 hard ceiling. `0` 이상 정수, `0`이면 무제한 |
| `ralplan.maxIterations` | `5` | 한 ralplan run이 열 수 있는 planner·revision 회차. `1..20` 정수, 넘으면 `PLANNING-STUCK` |
| `ralplan.maxReviewPassesPerLane` | `1` | 열린 회차당 architect 또는 critic 기록 수. `1..10` 정수, 넘으면 `PLANNING-STUCK` |
| `ralplan.autoHandoff` | `"off"` | `"ultragoal"`이면 막히지 않은 `final`을 승인 질문 없이 ultragoal에 인계 |
| `agents.<이름>` | 없음 | 역할별 `model`/`variant`. `variant`는 같은(병합된) entry에 `model`이 있어야 하며, 없으면 해당 agent 이름과 함께 오류로 거부됩니다. |

`open-gajae-executor`와 `open-gajae-cleaner`는 이제 이 8개 agent 이름에 포함되어 있으므로 위 예시처럼 `agents`에 넣을 수 있습니다. 이 두 이름을 뺀 `open-gajae-qa-tester` 같은 다른 ultragoal WIP용 key는 여전히 agent 이름에 없으므로 넣으면 설정 로드가 거부됩니다. 프로젝트 설정에서는 필요한 역할만 덮어쓰면 됩니다. `ralplan` key는 플러그인 setup 때 한 번만 읽으므로 바꾼 뒤에는 OpenCode를 재시작합니다.

## 3. 플러그인이 로드되면 등록하는 것

파일을 고치지 않고, 첫 프롬프트에서 `setup`이 실행될 때 host의 메모리 상태에 등록합니다(v1의 `config` 훅과 달리 v2는 `ctx.agent`/`ctx.skill`/`ctx.tool.transform`과 hook 등록입니다). 사용자가 host 설정의 `agents.<id>`로 같은 이름을 override하면 플러그인보다 우선합니다.

- **에이전트 8개**: `open-gajae`(primary), `open-gajae-explore`, `open-gajae-document-specialist`, `open-gajae-planner`, `open-gajae-architect`, `open-gajae-critic`, `open-gajae-executor`, `open-gajae-cleaner`. 프롬프트는 `prompts/<이름>.md`입니다.
- **skill 3개**: `deep-interview`, `ralplan`, `ultragoal` (`skills/<이름>/SKILL.md`에서 읽음). **명령은 없습니다** — v1의 `/ralplan`, `/deep-interview` 명령 등록은 v2에서 완전히 제거되었고, 진입은 `@<이름>` mention이나 키워드뿐입니다.
- **도구 13개**: `state_read`, `state_write`, `state_clear`, `ralplan`, `ultragoal`, `ast_grep_search`, `lsp_goto_definition`, `lsp_hover`, `lsp_diagnostics`, `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_servers`.
- **hook**: `session.hook("prompt")`(키워드/mention 감지, 안내 주입), `session.hook("compaction")`(ultragoal·ralplan 압축 복구 문맥), `tool.hook("execute.before"|"execute.after")`(artifact guard, ralplan 계획 가드, ultragoal 진입 게이트), `event.subscribe()`(durable execution 이벤트로 continuation). v1의 `event`/`chat.message`/`command.execute.before` 훅은 모두 사라졌습니다.
- **권한**: 역할별 rule을 각 agent의 `permissions`에 host 기본값 뒤로 추가합니다. `subagent_depth`는 올리지 않습니다(1절 참고) — v1과 다른 부분입니다.

작업 산출물은 v1과 같은 위치, `<worktree>/.open-gajae/_session-<생성 시각>-<세션 ID>/` 아래에 저장됩니다. ralplan 산출물은 그 아래 `plans/ralplan/<run-id>/`(`stage-NN-<stage>.md`, `index.jsonl`, `pending-approval.md`)에 `ralplan` 도구만 기록하며, run ID 기본값은 루트 세션의 native ID(`ses_…`)입니다.

## 4. 설치 순서와 확인

1. 저장소를 준비합니다(0절).
2. 1절의 `opencode.jsonc` 항목(`plugins`, `default_agent`, `experimental.subagent_depth`)을 넣습니다. 파일 전체를 바꾸지 말고 이 key들만 추가합니다.
3. 필요하면 2절의 `open-gajae.jsonc`를 사용자/프로젝트 위치에 둡니다.
4. OpenCode를 시작하고, 이 디렉터리(또는 하위 디렉터리)에서 **첫 프롬프트를 한 번 보냅니다.** 플러그인 `setup`은 서버 시작이나 세션 생성이 아니라 위치별 첫 프롬프트에서 지연 실행되므로, 프롬프트를 보내기 전에는 아래 확인 명령이 아무것도 보여주지 않습니다.
5. 등록 상태를 확인합니다.

```sh
opencode debug skill
opencode debug agent open-gajae
opencode debug agent open-gajae-explore
opencode debug agent open-gajae-document-specialist
opencode debug agent open-gajae-planner
opencode debug agent open-gajae-architect
opencode debug agent open-gajae-critic
```

`GET /api/plugin`도 확인에 씁니다. `{"id":"open-gajae","source":{"type":"local","path":"…/open-gajae/index.ts"}, "state":{"status":"active"}}` 형태로 응답하면 디렉터리 plugin이 `index.ts` 소스에서 로드된 것입니다. `opencode debug` 서브커맨드가 로컬 빌드에 없다면 `GET /api/plugin`, `GET /api/skill`, `GET /api/agent`로 대체할 수 있습니다.

## 5. 수동 테스트 체크리스트

2절의 `openai/gpt-6-luna` 설정으로, 다음을 직접 확인합니다(이식 plan의 매뉴얼 체크리스트):

1. `@deep-interview <아이디어>`를 mention으로 보냅니다. magic notice가 보이는지 확인하고, `question` 라운드를 진행해 `_session-*/specs/`에 spec이 저장되는지 확인합니다. "Refine with ralplan consensus"를 선택하면 `ralplan` skill 호출이 첫 시도에서 (input 오류로 인한 재시도 없이) 성공하고, 끝나면 `plans/ralplan/<run-id>/pending-approval.md`가 저장되는지 확인합니다.
2. 두 skill 모두 키워드로 진입합니다(mention 없이 일반 텍스트로 `deep interview …`, `ralplan …`). 안내가 보이는지 확인합니다. ralplan 키워드는 state를 만들지 않으며, 모델이 `ralplan start`를 호출한 뒤에야 `state/ralplan-state.json`이 생기는지 확인합니다.
3. ralplan 루프 도중 Esc로 중단합니다. 이후 continuation이 재개되지 않는지 확인합니다 — background subagent가 그동안 완료되어도 마찬가지입니다. 다음 실제 프롬프트를 보내면 continuation이 다시 동작하는지 확인합니다.
4. planner 위임: GJC 기반 planner 프롬프트에는 위임 지시가 없으므로 위임 여부는 모델이 정합니다(권한은 `open-gajae-explore`/`open-gajae-document-specialist`로 유지). `experimental.subagent_depth: 2`가 설정된 상태에서 planner가 위임하면 호출이 성공하는지, 이 설정 없이 위임을 시도하면 host가 거부하고 planner가 직접 `read`/`grep`/`glob`로 조사해 `ralplan write`로 plan을 기록하는지 확인합니다. 위임하지 않았다면 그 사실만 기록합니다.
5. ralplan 1회 실행: `@ralplan <작업>`을 보냅니다.
   - `.open-gajae/_session-*/plans/ralplan/<ses_…>/`에 `stage-01-planner.md`, `stage-01-intent.md`, architect·critic 단계 파일, `stage-NN-final.md`가 생기고, `index.jsonl`의 각 줄이 JSON으로 읽히며 `stage`, `stage_n`, `path`, `created_at`, `sha256`을 가지는지, `pending-approval.md`가 마지막 `final`과 같은지 확인합니다.
   - planner·architect·critic이 본문을 붙여 넣지 않고 영수증만 돌려주는지 확인합니다.
   - 승인 질문에서 **Stop here**를 고르면 활성 행 `state/active/ralplan.json`이 지워지고 `pending-approval.md`는 남는지 확인합니다.
   - 이어서 "ultragoal로 진행"이라고 요청하면 ultragoal이 시작되고(`source_plan` = `pending-approval.md`), ultragoal 목표 검증이 `VERDICT: approve` 또는 `VERDICT: reject`로 끝나는지 확인합니다(README "필수 후속 개발"의 판정 어휘 충돌 참고).
6. primary 임시 파일 스테이징: primary가 큰 산출물을 `/tmp` 같은 OS 임시 경로에 host `write`로 먼저 쓰고 `ralplan write`의 `path`로 넘기면, 프로젝트 밖 경로라서 host가 `external_directory` 확인 창을 띄웁니다. 규칙이 맞지 않는 권한은 host 기본값이 `ask`이고(`opencode/packages/core/src/permission.ts:86-95`), 기본 허용은 host 자신의 임시 디렉터리(`$TMPDIR/opencode/*`, `opencode/packages/core/src/agent.ts:62`) 등뿐이기 때문입니다. 확인 창이 뜨는지, 허용 후 `ralplan write`가 성공하는지 확인합니다. 역할(planner·architect·critic)은 `content`만 쓰므로 이 창이 뜨지 않아야 합니다.

이 체크리스트는 실제 LLM 동작을 사람이 보고 판단하는 것으로, `bun test`/`bun run typecheck`나 host probe(`tests/host-probe.ts`, `tests/host-session-probe.ts`, `tests/planner-permission-probe.ts`, `tests/package-probe.ts`, `tests/ralplan-trail-probe.ts`)가 자동으로 대신하지 않습니다. 두 검증은 서로 다른 층을 다루며, README의 "검증 근거와 한계"를 참고하세요.
