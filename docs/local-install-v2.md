# 로컬 설치 기록 (OpenCode v2)

로컬 OpenCode 설정에 open-gajae v2 플러그인을 등록하는 절차를 기록한 문서입니다. `docs/local-install-v1.md`와 같은 구성을 따르며, v1 호스트에는 적용되지 않습니다 — v1 호스트는 v2 플러그인을 로드하지 않습니다(`id`와 `setup`을 가진 default export를 요구하는 형태는 같지만, v1은 `@opencode-ai/plugin` 형태만 읽습니다).

- 기록 시점: 2026-09-24
- 호스트: OpenCode v2 `2.0.15` (`~/.opencode/bin/opencode`)
- 플러그인: open-gajae `feat/opencode-v2-port` 커밋 `f4df6e6`, v2 플러그인 API `@opencode/plugin` 2.0.15
- 갱신: 2026-09-29, GJC 기반 `ralplan`(도구 `ralplan`; TUI 사이드바는 보류, README "필수 후속 개발" 6번) — 브랜치 `feat/ralplan-gjc-stage-trail`
- 갱신: 2026-09-30, GJC 기반 `ultragoal`과 `goal` 도구(`ultragoal.hardMaxIterations` 설정 삭제, 도구 14개, workflow 도구 숨김) — 브랜치 `feat/ultragoal-gjc-revision`

## 0. 저장소 준비

```sh
cd /Users/dongwuk/apps/open-gajae
bun install
bun run typecheck
bun test ./tests
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

수동 테스트 체크리스트(아래 5절)에서 쓰는 예시로, 모든 역할에 `openai/gpt-6-luna`를 variant로 구분해 씁니다:

```jsonc
// ~/.open-gajae/open-gajae.jsonc
{
  "deepInterview": { "ambiguityThreshold": 0.2, "maxRounds": 20 },
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
| `ralplan.maxIterations` | `5` | 한 ralplan run이 열 수 있는 planner·revision 회차. `1..20` 정수, 넘으면 `PLANNING-STUCK` |
| `ralplan.maxReviewPassesPerLane` | `1` | 열린 회차당 architect 또는 critic 기록 수. `1..10` 정수, 넘으면 `PLANNING-STUCK` |
| `ralplan.autoHandoff` | `"off"` | `"ultragoal"`이면 막히지 않은 `final`을 승인 질문 없이 ultragoal에 인계 |
| `agents.<이름>` | 없음 | 역할별 `model`/`variant`. `variant`는 같은(병합된) entry에 `model`이 있어야 하며, 없으면 해당 agent 이름과 함께 오류로 거부됩니다. |

`ultragoal` key는 없습니다. 예전의 `ultragoal.hardMaxIterations`(continuation 반복 상한)는 goal 루프로 바뀌면서 삭제되었고, 설정 파일에 `ultragoal` key가 남아 있으면 `<파일>.ultragoal: unknown setting` 오류로 설정 로드가 실패합니다. 기존 파일에서 그 블록을 지우세요. goal 루프에는 반복 상한이 없습니다(README "Ultragoal" 절).

`open-gajae-executor`와 `open-gajae-cleaner`는 이제 이 8개 agent 이름에 포함되어 있으므로 위 예시처럼 `agents`에 넣을 수 있습니다. 이 두 이름을 뺀 `open-gajae-qa-tester` 같은 다른 ultragoal WIP용 key는 여전히 agent 이름에 없으므로 넣으면 설정 로드가 거부됩니다. 프로젝트 설정에서는 필요한 역할만 덮어쓰면 됩니다. `ralplan` key는 플러그인 setup 때 한 번만 읽으므로 바꾼 뒤에는 OpenCode를 재시작합니다.

## 3. 플러그인이 로드되면 등록하는 것

파일을 고치지 않고, 첫 프롬프트에서 `setup`이 실행될 때 host의 메모리 상태에 등록합니다(v1의 `config` 훅과 달리 v2는 `ctx.agent`/`ctx.skill`/`ctx.tool.transform`과 hook 등록입니다). 사용자가 host 설정의 `agents.<id>`로 같은 이름을 override하면 플러그인보다 우선합니다.

- **에이전트 8개**: `open-gajae`(primary), `open-gajae-explore`, `open-gajae-document-specialist`, `open-gajae-planner`, `open-gajae-architect`, `open-gajae-critic`, `open-gajae-executor`, `open-gajae-cleaner`. 프롬프트는 `prompts/<이름>.md`입니다.
- **skill 3개**: `deep-interview`, `ralplan`, `ultragoal` (`skills/<이름>/SKILL.md`에서 읽음). **명령은 없습니다** — v1의 `/ralplan`, `/deep-interview` 명령 등록은 v2에서 완전히 제거되었고, 진입은 `@<이름>` mention, 키워드, 또는 모델의 native `skill` 호출입니다. `ultragoal`은 키워드와 mention이 안내만 하고, `skill` 호출이 목표 계획(`goal-planning`)을 시작합니다.
- **도구 14개**: `state_read`, `state_write`, `state_clear`, `ralplan`, `ultragoal`, `goal`, `ast_grep_search`, `lsp_goto_definition`, `lsp_hover`, `lsp_diagnostics`, `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_servers`. `ultragoal`·`goal`은 `open-gajae` 전용이고, `ralplan`은 `open-gajae`와 planner·architect·critic 전용입니다. 소유하지 않은 agent(호스트 `build`·`general`, 사용자 정의 agent 포함)의 요청에서는 플러그인이 이 세 도구를 지웁니다.
- **hook**: `session.hook("prompt")`(키워드/mention 감지와 안내 주입, 턴 표식, goal 보류 해제), `session.hook("context")`(workflow 도구 숨김, goal 문맥 주입), `session.hook("compaction")`(workflow 도구 숨김, ultragoal·ralplan 압축 복구 문맥), `session.hook("generate")`(workflow 도구 숨김), `tool.hook("execute.before"|"execute.after")`(artifact guard, ralplan 계획 가드, ultragoal goal-planning 가드, `skill` 턴 게이트와 체인 가드, `[ultragoal-red-team]` 조각 덧붙이기), `event.subscribe()`(durable execution 이벤트로 goal 루프와 ralplan continuation). v1의 `event`/`chat.message`/`command.execute.before` 훅은 모두 사라졌습니다.
- **권한**: 역할별 rule을 각 agent의 `permissions`에 host 기본값 뒤로 추가합니다. `subagent_depth`는 올리지 않습니다(1절 참고) — v1과 다른 부분입니다.

작업 산출물은 v1과 같은 위치, `<worktree>/.open-gajae/_session-<생성 시각>-<세션 ID>/` 아래에 저장됩니다. ralplan 산출물은 그 아래 `plans/ralplan/<run-id>/`(`stage-NN-<stage>.md`, `index.jsonl`, `pending-approval.md`)에 `ralplan` 도구만 기록하며, run ID 기본값은 루트 세션의 native ID(`ses_…`)입니다. ultragoal 산출물은 `ultragoal/`(`goals.json`, `ledger.jsonl`, `progress.txt`)에 `ultragoal` 도구만 기록하고, goal은 `state/goal-state.json`, goal 루프 카운터는 `state/goal-continuation.json`, 인계 저널은 진행 중에만 `state/transactions/`에 있습니다(README "Ultragoal" 절의 저장 구성).

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

### 5.1 deep-interview와 ralplan

1. `@deep-interview <아이디어>`를 mention으로 보냅니다. magic notice가 보이는지 확인하고, `question` 라운드를 진행해 `_session-*/specs/`에 spec이 저장되는지 확인합니다. "Refine with ralplan consensus"를 선택하면 `ralplan` skill 호출이 첫 시도에서 (input 오류로 인한 재시도 없이) 성공하고, 끝나면 `plans/ralplan/<run-id>/pending-approval.md`가 저장되는지 확인합니다.
2. 두 skill 모두 키워드로 진입합니다(mention 없이 일반 텍스트로 `deep interview …`, `ralplan …`). 안내가 보이는지 확인합니다. ralplan 키워드는 state를 만들지 않으며, 모델이 `ralplan start`를 호출한 뒤에야 `state/ralplan-state.json`이 생기는지 확인합니다.
3. ralplan 루프 도중 Esc로 중단합니다. 이후 continuation이 재개되지 않는지 확인합니다 — background subagent가 그동안 완료되어도 마찬가지입니다. 다음 실제 프롬프트를 보내면 continuation이 다시 동작하는지 확인합니다.
4. planner 위임: GJC 기반 planner 프롬프트에는 위임 지시가 없으므로 위임 여부는 모델이 정합니다(권한은 `open-gajae-explore`/`open-gajae-document-specialist`로 유지). `experimental.subagent_depth: 2`가 설정된 상태에서 planner가 위임하면 호출이 성공하는지, 이 설정 없이 위임을 시도하면 host가 거부하고 planner가 직접 `read`/`grep`/`glob`로 조사해 `ralplan write`로 plan을 기록하는지 확인합니다. 위임하지 않았다면 그 사실만 기록합니다.
5. ralplan 1회 실행: `@ralplan <작업>`을 보냅니다.
   - `.open-gajae/_session-*/plans/ralplan/<ses_…>/`에 `stage-01-planner.md`, `stage-01-intent.md`, architect·critic 단계 파일, `stage-NN-final.md`가 생기고, `index.jsonl`의 각 줄이 JSON으로 읽히며 `stage`, `stage_n`, `path`, `created_at`, `sha256`을 가지는지, `pending-approval.md`가 마지막 `final`과 같은지 확인합니다.
   - planner·architect·critic이 본문을 붙여 넣지 않고 영수증만 돌려주는지 확인합니다.
   - 승인 질문에서 **Stop here**를 고르면 활성 행 `state/active/ralplan.json`이 지워지고 `pending-approval.md`는 남는지 확인합니다.
   - 이어서 "ultragoal로 진행"이라고 요청하면, 모델이 `skill` `ultragoal`을 바로 불러 `goal-planning`으로 진입하는지(Stop here 뒤라 ralplan이 비활성이므로 `ralplan handoff`는 부르면 R-OD18로 거부됨), 그 ultragoal state에 `handoff_from`이 없는지 확인합니다. 이어지는 ultragoal 확인은 5.2절입니다.
6. primary 임시 파일 스테이징: primary가 큰 산출물을 `/tmp` 같은 OS 임시 경로에 host `write`로 먼저 쓰고 `ralplan write`의 `path`로 넘기면, 프로젝트 밖 경로라서 host가 `external_directory` 확인 창을 띄웁니다. 규칙이 맞지 않는 권한은 host 기본값이 `ask`이고(`opencode/packages/core/src/permission.ts:86-95`), 기본 허용은 host 자신의 임시 디렉터리(`$TMPDIR/opencode/*`, `opencode/packages/core/src/agent.ts:62`) 등뿐이기 때문입니다. 확인 창이 뜨는지, 허용 후 `ralplan write`가 성공하는지 확인합니다. 역할(planner·architect·critic)은 `content`만 쓰므로 이 창이 뜨지 않아야 합니다.

### 5.2 ultragoal과 goal (2026-09-30 개정)

작은 연습용 저장소에서 한 세션으로 진행합니다. 파일 경로는 모두 그 세션 계보의 루트 세션 폴더 `.open-gajae/_session-<created>-<id>/` 기준입니다. 결과 문구는 README "Ultragoal" 절의 op 표와 같아야 합니다.

1. **설정 로드.** 사용자나 프로젝트의 `open-gajae.jsonc`에 `"ultragoal": {}`를 잠깐 넣고 OpenCode를 재시작해 첫 프롬프트를 보냅니다. 설정 로드가 `<파일>.ultragoal: unknown setting`으로 실패하는지 확인합니다(`GET /api/plugin` 응답이나 호스트 로그). key를 지우고 재시작하면 정상 로드되는지 확인합니다.
2. **`build` agent의 도구 숨김.** `build` agent로 새 세션을 열고 `ultragoal`, `goal`, `ralplan` 도구로 상태를 보라고 요청합니다. 모델이 그 도구를 찾지 못하거나, 호출이 호스트에서 `Tool is not available for this request: <도구>`로 거부되는지 확인합니다. 같은 요청을 `open-gajae` 세션에서 하면 세 도구가 동작하는지 확인합니다.
3. **진입과 goal-planning 가드.** `open-gajae` 세션에서 "ultragoal로 <작업>"을 보냅니다. TUI에 `open-gajae: ultragoal keyword notice added`가 보이고, 모델이 `skill` `ultragoal`을 부르기 전에는 `state/ultragoal-state.json`이 없는지 확인합니다. 로드 뒤 `state/active/ultragoal.json`의 phase가 `goal-planning`인지 확인합니다. 이 상태에서 제품 파일 수정을 요청하면 `write`/`edit`/`patch`가 `Ultragoal goal-planning phase boundary: …`로 거부되는지 확인합니다.
4. **`create`, goal 켜기, continuation.** 모델이 `ultragoal create`를 부르면 결과가 `Created ultragoal plan with N goal(s) at <path>.`와 `Goal armed: Complete the durable ultragoal plan in .open-gajae/_session-…/ultragoal/goals.json, …`인지 확인합니다. `goal get`이 같은 objective와 `Status: active`를 돌려주는지, `ultragoal/goals.json`이 `"version": 2`이고 기준 ID가 `G001.AC1` 꼴인지, `ultragoal/ledger.jsonl`에 `plan_created`, `ultragoal/progress.txt`에 `PLAN` 메모가 있는지 확인합니다. 이제 제품 파일 수정이 허용되는지, 턴이 끝나면 TUI에 `open-gajae: goal continuation`이 보이고 작업이 이어지는지 확인합니다.
5. **목표별 architect gate → checkpoint.** `ultragoal next` 결과에 `checkpoint requires=targetedVerification:passed,architectReview:CLEAR+APPROVE,criteriaCoverage:all`과 `criteria=`가 있는지 확인합니다. 모델이 `open-gajae-architect`에 목표 리뷰를 맡기는지 확인합니다. 한 번은 기준 줄이 빠진 gate로 `validate_gate`나 `checkpoint(complete)`를 부르게 해서 `N quality-gate error(s):`와 결함마다 `  path [code]: message` 줄이 나오는지 확인합니다. 올바른 gate로 `Checkpointed G001 as complete.` 다음에 `Next ultragoal goal: G002 — …`와 `Criteria: …`가 나오고 G002가 바로 `active`가 되는지, `progress.txt`에 G001 항목이 붙는지 확인합니다.
6. **재오픈.** 완료한 목표를 `revise`하라고 요청하면 `requires goal G001 status pending; found complete. To change it, reopen it first with ultragoal checkpoint(…status: "pending"…)` 꼴로 거부되는지 확인합니다. `checkpoint(status: "pending")`이 `Reopened G001; revise it, then run ultragoal next and checkpoint it again.`을 돌려주고, 기준을 고치면 새 ID(`G001.AC2` 같은)가 생기고 옛 ID는 `status`에서 사라지는지, `next`와 새 gate로 다시 완료되는지 확인합니다.
7. **경계 cohort → terminal critic → final checkpoint → `goal complete`.** 마지막 필수 목표의 `next`에 `,reviewCohort:joined,criticReview:OKAY`가 붙는지 확인합니다. 모델이 한 변경 집합에 대해 `open-gajae-cleaner`(`AI SLOP CLEANUP REPORT`, `Gate Result: PASS`), `open-gajae-architect`, 지시문에 `[ultragoal-red-team]`이 있는 `open-gajae-executor`를 부르는지, 그 executor 자식 세션의 첫 메시지 끝에 `<ultragoal_red_team_mode>` 조각이 붙는지 확인합니다. terminal `open-gajae-critic`의 `OKAY` 뒤 final checkpoint가 `All ultragoal goals are complete.`를 돌려주고, `ultragoal status`가 `run_complete: yes`인지 확인합니다. final checkpoint 뒤 `state/active/ultragoal.json`이 지워지는지, 모델이 `goal complete`를 부르면 `Status: complete`가 되고 그 뒤 continuation이 멈추는지 확인합니다.
8. **`ultragoal handoff(to: "ralplan")`와 복귀.** 새 실행 도중에 계획을 다시 짜라고 요청합니다. 모델이 먼저 `skill` `ralplan`을 부르면 `open-gajae: refusing to chain from "ultragoal" … into "ralplan"`으로 거부되는지 확인합니다. `ultragoal handoff(to: "ralplan", reason)` 결과가 한 줄 JSON 영수증인지, `state/ultragoal-state.json`이 `active: false`, `current_phase: "handoff"`, `handoff_to: "ralplan"`이고 `state/active/ultragoal.json`이 비활성 `handoff_to` 행으로 남는지, `state/ralplan-state.json`이 옛 `run_id`로 `planner`에 활성이고 `handoff_from: "ultragoal"`인지, ledger에 `workflow_handoff`, `progress.txt`에 `HANDOFF` 메모가 있는지, `state/transactions/`에 남은 저널이 없는지(저널은 인계가 끝나면 지워짐), `goal get`이 여전히 `active`인지 확인합니다. 모델이 `ralplan start` 없이 `ralplan write`로 이어 써서 `final`까지 가는지 확인하고, 옛 run의 `stage_n`과 겹치는지, 예산이 이어지는지 관찰해 기록합니다(README 알려진 동작). 승인 뒤 `ralplan handoff(to="ultragoal")`(또는 같은 execution의 `skill ultragoal`)로 ultragoal이 `goal-planning`으로 돌아오고, `create`가 `goals.json`을 새로 쓰며 ledger와 `progress.txt`는 기록을 유지하는지 확인합니다.
9. **도구 없는 턴 3회 보류와 해제.** 실행 중에 모델이 도구 없이 답하는 continuation 턴이 연속 3번 나오도록 유도합니다(예: 도구를 쓰지 말고 요약만 하라고 지시). TUI에 `open-gajae: goal continuation held (no_tool_progress)`가 한 번 보이고, 그 `<goal-notice>`에 `[GOAL CONTINUATION HELD - NO TOOL PROGRESS]`, `Cause: …`, `Send a message to continue: …`가 있는지, 그 뒤 continuation이 없는지, `state/goal-continuation.json`에 `held`가 있는지 확인합니다. 메시지를 보내면 `held`가 사라지고 `tool_less_turns`가 0이 되며, 그 턴이 끝난 뒤 continuation이 다시 들어오는지 확인합니다.
10. **Esc.** 실행 중 Esc로 중단하면 continuation이 없는지, 다음 프롬프트를 보내면 그 턴이 끝난 뒤 continuation이 다시 들어오는지 확인합니다.
11. **압축.** 실행 중 `/compact`를 합니다. 압축 요약에 `[ULTRAGOAL RUN ACTIVE]` 문맥(현재 목표, 다음 행동)이 반영되는지, 다음 요청에 TUI `open-gajae: goal context added`와 함께 goal 문맥이 다시 들어가는지 확인합니다. 9번의 보류 중에 `/compact`를 하면 보류 안내가 전달되고 호스트가 모델을 한두 단계 돌려도 보류는 유지되는지 관찰해 기록합니다(README 알려진 동작).
12. **다른 agent로 바꿨을 때(수용 동작).** 실행 중 세션 agent를 `build`로 바꾸고 goal continuation이 계속 들어오는지 관찰합니다. Esc, 또는 `open-gajae`로 돌아가 `goal drop`으로 끝냅니다(README 알려진 동작, `docs/skills/ultragoal/known-limits.md` U27).
13. **수정 목표(가능하면).** cohort에 blocker가 있을 때 `record_review_blockers`가 `Recorded review blockers. blocker-goal-id=<id>`를 돌려주고, 원 목표가 `review_blocked`, 수정 목표의 기준이 `<objective> is resolved and re-verified` 하나인지, 수정 목표가 첫 checkpoint부터 final gate를 요구받고 완료되면 원 목표가 `superseded`가 되어 실행이 완료되는지 확인합니다.
14. **정리.** `ultragoal doctor`가 텍스트 결과를 내는지, `ultragoal clear`가 한 줄 JSON 영수증과, goal이 열려 있으면 `The goal is still <status>; run goal drop to end it.`를 돌려주는지, `goal drop` 뒤 `goal get`이 `No active goal.`인지 확인합니다.
15. 결과(통과·실패·관찰)를 날짜와 함께 아래 6절에 기록합니다.

이 체크리스트는 실제 LLM 동작을 사람이 보고 판단하는 것으로, `bun test`/`bun run typecheck`나 host probe(`tests/host-probe.ts`, `tests/host-session-probe.ts`, `tests/planner-permission-probe.ts`, `tests/package-probe.ts`, `tests/ralplan-trail-probe.ts`)가 자동으로 대신하지 않습니다. 두 검증은 서로 다른 층을 다루며, README의 "검증 근거와 한계"를 참고하세요.

## 6. 수동 실행 결과 (Manual run result, AC37)

ultragoal gjc 개정의 실제 호스트 실행 기록입니다(spec AC37). 이 절의 결과는 자동 테스트나 호스트 probe가 대신하지 않습니다.

**부분 실행으로 기록합니다(2026-10-01, 관리자 결정).** 실행 조건이 5.2절의 전제와 두 가지 다릅니다.
- **모델**: 5.2절은 모든 역할을 `openai/gpt-6-luna`로 두고 variant로 구분합니다. 두 실행은 `-fast` 모델이었고, 기록된 variant는 모든 역할이 `default`였습니다. 설정에는 primary가 `high`였는데, 이것이 왜 적용되지 않았는지는 확인하지 못했습니다.
- **방식**: 체크리스트를 항목별로 따라가지 않았습니다. 앱 작업 요청 한 번을 ralplan → ultragoal로 끝까지 돌렸습니다.

아래 표에서 "미확인"인 항목은 실제 모델로 아직 확인하지 않은 것입니다.

| 구분 | 1차 | 2차 |
|---|---|---|
| 실행 시각 | 2026-09-30 20:24–20:51 (KST) | 2026-09-30 23:49 – 10-01 00:36 (KST) |
| 호스트 | OpenCode v2.0.15 | OpenCode v2.0.15 |
| 플러그인 | 브랜치 `feat/ultragoal-gjc-revision`, 커밋 `9b5d4f9` | 같음 |
| 모델 | 모든 역할 `openai/gpt-6-luna-fast` (variant `default`) | 모든 역할 `openai/gpt-6-sol-fast` (variant `default`) |
| 요청 | `@ralplan --interactive`: 단일 HTML 앱을 Next.js·React·TypeScript로 옮기고 상세 페이지 분리 | `@ralplan`: 교실 스타일을 우주정거장·우주선 스타일로 바꾸고 인터랙션 강화 |
| 세션 | `ses_f0df11fc9ffeWwrUZVfzxHw4FA` (자식 8) | `ses_f0d35376effec0XrVLC70z6Bfr` (자식 7) |
| 목표 | G001 하나 | G001 → 수정 목표 G002 → 수정 목표 G003 |

| 5.2 항목 | 결과 | 메모 |
|---|---|---|
| 1. 설정 로드 | 미확인 | |
| 2. `build` agent의 도구 숨김 | 미확인 | 호스트 probe(`tests/host-probe.ts`)는 `build`·`general`에서 숨김을 확인합니다. |
| 3. 진입과 goal-planning 가드 | 일부 통과 | 두 실행 모두 ralplan 승인 뒤 `ralplan handoff`에서 `skill ultragoal`로 이어져 `goal-planning`으로 들어갔습니다. 인계 저널은 생겼다가 지워졌습니다. 키워드 안내와 편집 거부는 이 흐름에 없어 미확인입니다. |
| 4. `create`, goal 켜기, continuation | 통과 (continuation 제외) | `Created ultragoal plan with 1 goal at …`, `Goal armed: …`, `goal get`의 `Status: active`, `goals.json`의 `"version": 2`와 `G001.AC1` 꼴 기준, ledger `plan_created`, progress `PLAN`, `open-gajae: goal context added`를 확인했습니다. 두 실행 모두 첫 execution 하나로 `goal complete`까지 가서 continuation이 들어갈 일이 없었습니다(`goal-continuation.json` 없음). |
| 5. 목표별 architect gate → checkpoint | 일부 통과 | `next`가 `checkpoint requires=`와 `criteria=`를 출력했습니다. 목표마다 마지막 목표여서 목표별 checkpoint, gate 오류 문구, 다음 목표 전환은 미확인입니다. |
| 6. 재오픈 | 미확인 | |
| 7. 경계 cohort → terminal critic → final checkpoint → `goal complete` | 통과 | 아래를 모두 확인했습니다. 1차 모델의 절차 위반은 이 표 아래 관찰에 적었습니다. |
| 8. `ultragoal handoff(to: "ralplan")`와 복귀 | 미확인 | 반대 방향(ralplan → ultragoal) 인계는 두 실행 모두 정상이었습니다. |
| 9. 도구 없는 턴 3회 보류와 해제 | 미확인 | |
| 10. Esc | 미확인 | |
| 11. 압축 | 미확인 | |
| 12. 다른 agent로 바꿨을 때 | 미확인 | |
| 13. 수정 목표 | 통과 (2차) | 아래를 모두 확인했습니다. 1차는 blocker가 있었지만 모델이 이 op를 부르지 않았습니다. |
| 14. 정리 | 미확인 | |

7번에서 확인한 것:
- `next`의 `checkpoint requires=`에 `,reviewCohort:joined,criticReview:OKAY`가 붙었습니다.
- cleaner(`AI SLOP CLEANUP REPORT`, `Gate Result: PASS`), architect, `[ultragoal-red-team]` executor가 돌았습니다.
- red-team 조각은 executor 메시지에만 붙었습니다.
- terminal critic `OKAY` → `validate_gate`의 `quality gate is valid.` → `All ultragoal goals are complete.` 순서였습니다.
- `run_complete: yes`, 영수증은 `receiptKind: final-aggregate`입니다.
- `state/active/ultragoal.json`이 지워졌습니다.
- `goal complete` 뒤 `Status: complete`이고, 그 뒤 continuation이 없었습니다.

13번에서 확인한 것(2차):
- 1세대 cohort 불통과 → `Recorded review blockers. blocker-goal-id=G002`
- G001이 `review_blocked`, G002 기준은 `… is resolved and re-verified` 하나입니다.
- G002의 첫 `next`부터 최종 gate를 요구했습니다.
- 2세대 불통과 → G003 → 뿌리 G001 `supersede`
- G003 완료 → G002 `superseded`(증거 `Resolved by verification blocker goal G003: …`), `run_complete: yes`

관찰(자세한 내용은 [`docs/skills/ultragoal/known-limits.md`](skills/ultragoal/known-limits.md)):
- **1차 모델의 절차 위반**: cohort blocker를 `record_review_blockers` 없이 바로 고쳤고, 같은 세대에서 lane을 다시 돌렸고(U36), 요청 없이 `git commit`을 했습니다. 2차 모델은 SKILL 절차를 그대로 따랐습니다.
- **lane 충돌**: 1차에서 cleaner와 QA lane이 동시에 e2e를 돌려 Playwright 산출물이 충돌했고, 이것이 가짜 blocker가 됐습니다(U37).
- **감사 로그**: 두 실행 모두 ralplan 감사 로그에 `invalid_transition_detected`가 4~5행 남았습니다. gjc 전이 표와 SKILL 흐름이 원래 어긋나서 생기는 것이고, 기록만 남습니다(U38).
- **서브에이전트 사용**: ralplan에서 `open-gajae-explore`는 쓰이지 않았고, ultragoal 구현은 leader가 직접 했습니다. SKILL 기본값("Direct inline implementation by the leader is the default")과 작은 앱 규모에 맞는 결과입니다.
