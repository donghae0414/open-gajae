[English](README.md) | [한국어](README.ko.md)

![open-gajae — Clarify. Plan. Execute.](assets/branding/open-gajae-banner.png)

# open-gajae

**OpenCode v2용 플러그인으로 개발한 개인 학습 및 토이 프로젝트입니다.** OpenCode v1은 지원하지 않습니다.

## 개발 배경과 프로젝트 성격

[gajae-code](https://github.com/Yeachan-Heo/gajae-code)와 [oh-my-claudecode (OMC)](https://github.com/Yeachan-Heo/oh-my-claudecode)를 사용하며 좋은 경험을 했습니다. 다만 OpenCode만 사용할 수 있는 환경적 제약이 있어, OpenCode에서도 비슷한 경험을 만들어 보고 싶었습니다. 코딩 에이전트 개발을 공부하려는 목적을 겸해 두 프로젝트를 참고하며 open-gajae를 개발하게 되었습니다. OpenCode 플러그인 개발과 호스트 연동 방식을 공부하는 데에는 [oh-my-openagent (OMO)](https://github.com/code-yeongyu/oh-my-openagent)도 참고했습니다. 영감과 배움의 바탕이 된 세 프로젝트의 제작자와 기여자분들께 감사드립니다.

이 프로젝트는 독립적으로 개발한 비공식 프로젝트입니다. gajae-code, OMC, OMO, OpenCode/Anomaly와 제휴하거나 공식 승인을 받은 프로젝트가 아니며, gajae-code, OMC, OMO의 공식 이식판 또는 호환 플러그인이 아닙니다. 원본 프로젝트와 동일한 기능·동작이나 호환성을 보장하지 않으며, 개인 학습과 실험을 목적으로 합니다.

실제로 포함하거나 수정해 사용한 외부 자료의 출처와 라이선스는 [third-party notices](THIRD-PARTY-NOTICES.md)에 기록되어 있습니다. [배너 출처](assets/branding/open-gajae-banner.md).

## 라이선스

open-gajae의 자체 작성 부분은 MIT, 외부 자료는 각 원본 라이선스를 따릅니다. 자세한 조건은 [LICENSE](LICENSE)와 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md)를 확인하세요.

## 개요

세션에 묶인 `deep-interview`/`ralplan`/`ultragoal` skill, `goal` 도구, 아홉 개의 자체 역할, 작은 읽기 전용 코드 조사 도구를 제공하는 OpenCode 플러그인입니다. 메인 에이전트 프롬프트, `deep-interview` skill(런타임과 측면 리뷰 패널 포함), `ralplan` skill(런타임과 세 합의 역할 포함), `ultragoal` skill(런타임 포함)과 `goal` 도구, cleaner 역할은 GJC를 바탕으로 이식하며, explore·document-specialist·executor 역할과 ultragoal의 진행 기록 형식은 OMC 기반 계약을 유지합니다. OMC나 GJC의 전체 이식은 아니며, 실행 워크플로는 GJC ultragoal과 goal 모드를 기준으로 다시 만든 `ultragoal` 하나뿐입니다.

## 범위와 상태

- OMC 기준선 이식인 Phase 1은 2026-09-27 관리자 결정으로 종료되었습니다. Phase 2 개선은 gajae-code를 주 참조로 관리자가 결정합니다. 정책은 [AGENTS.md](AGENTS.md)에 있습니다.
- GJC 기준(메인 에이전트 프롬프트, `deep-interview` skill·패널 조각·런타임과 lateral-reviewer 프롬프트, `ralplan` skill·런타임·합의 역할 프롬프트, 그리고 `ultragoal` skill·런타임, `goal` 도구, 공통 skill-state 기반, cleaner 프롬프트)은 GJC v0.17.7 커밋 `5c5231418930673e42cc5d08ebe4376e03187533`이며, OMC 기반 역할 내부 계약의 기준은 OMC v5.4.0 커밋 `5281b19e0d64f8e6dc6767f2130299a88af2dc71` 그대로입니다.
- 대상 호스트는 OpenCode v2입니다. 이번 이식은 `@opencode/plugin` 2.0.15를 대상으로 하며, 로컬 `opencode/` 참조는 `v2.0.15`(`6f3639d82e`)에 고정되어 있습니다. v1 호스트는 더 이상 이 플러그인을 로드할 수 없습니다(v1 지원 중단 — deviations 표 참고).
- 패키지는 빌드 단계가 없는 TS 소스입니다. `package.json`의 `exports["."]`는 `./src/index.ts`를 가리키고, 루트 `index.ts`가 이를 re-export합니다. `dist/`는 없습니다.
- 구현 범위는 `deep-interview`·`ralplan`·`ultragoal`, `open-gajae`/`open-gajae-explore`/`open-gajae-document-specialist`, `open-gajae-planner`/`open-gajae-architect`/`open-gajae-critic` 합의 역할, `open-gajae-executor`/`open-gajae-cleaner` ultragoal 실행 역할, `open-gajae-lateral-reviewer` deep-interview 패널 역할, 세션 상태, 그리고 바로 호출 가능한 도구 12개(`deep-interview`·`ralplan`·`ultragoal`·`goal` 도구 4개 + 읽기 전용 AST/LSP 도구 8개)입니다.
- `ralplan`은 제공하며 `pending approval` 상태의 plan(`pending-approval.md`)에서 끝나고, 최종 승인 질문은 `Refine further`/`Approve execution via ultragoal (Recommended)`/`Stop here`를 제공합니다. `ultragoal`은 GJC ultragoal 런타임과 goal 모드를 기준으로 구현했습니다: 수용 기준이 있는 지속 목표 목록, 완료 영수증을 담는 ledger, 목표마다 architect gate, 실행의 마지막 목표에서 경계 리뷰 cohort(cleaner, architect, executor QA/red-team)와 terminal critic, 그리고 `goal` 도구의 continuation 루프입니다([Ultragoal](#ultragoal) 참고). deep-interview → ralplan → ultragoal 핸드오프 체인, deep-interview → ultragoal 직접 핸드오프, 그리고 ultragoal과 ralplan에서 deep-interview로 돌아가는 핸드오프도 제공합니다. autopilot, team, 독립된 ralph skill, autoresearch, 공유 세션 상태, 자동 migration/recovery는 제공하지 않습니다. 슬래시 커맨드는 없으며 명시적인 자연어 요청이나 지원되는 mention·키워드로 skill에 진입할 수 있습니다(아래 "진입" 참고).
- v2 호스트와 워크플로 설명은 `feat/opencode-v2-port` 브랜치 커밋 `f4df6e6`에서 비롯되었으며, 위 메인 에이전트 프롬프트 기준은 별도 변경입니다. 그 변경 자체가 Phase 1 완료를 입증한 것은 아니며, 아래 검증 계층(typecheck, unit test, host probe)이 이 변경에 대해 통과했다는 주장도 아닙니다. 검증 항목은 plan을 참고하세요.

개발 정책은 [AGENTS.md](AGENTS.md), 출처는 [third-party notices](THIRD-PARTY-NOTICES.md)를 확인하세요.

## 설치 (OpenCode v2)

```sh
bun install
bun run typecheck
bun test ./tests
```

호스트 설정(보통 `~/.config/opencode/opencode.jsonc`)에 이 저장소의 **디렉터리**(빌드된 파일이 아님)를 가리키는 `plugins` 항목을 추가합니다.

```jsonc
{
  "plugins": ["/Users/dongwuk/apps/open-gajae"],
  "default_agent": "open-gajae",
  "experimental": { "subagent_depth": 2 }
}
```

- `plugins`는 디렉터리 경로여야 합니다. v2 호스트는 `<dir>/server`, 그다음 `<dir>/index`를 확장자 추론과 함께 찾으며, 파일 경로로 설정된 plugin 항목은 건너뜁니다(일부 host 문서는 파일 경로 예시를 보여주는데, 이는 기록된 문서-구현 불일치입니다). 이 패키지의 루트 `index.ts`가 `./src/index.ts`를 re-export하므로 호스트는 빌드 없이 TypeScript 소스를 바로 로드합니다.
- `experimental.subagent_depth: 2`는 `open-gajae-planner` 역할이 native `subagent` 도구로 `open-gajae-explore`/`open-gajae-document-specialist`에 연구를 위임하는 데 필요합니다. 플러그인이 직접 이 값을 올릴 수 없습니다 — v1과 달리 v2 플러그인 API에는 config를 수정하는 domain이 없습니다 — 그래서 이 값은 직접 넣어야 하는 host 설정입니다. GJC 기반 planner 프롬프트에는 위임 지시가 없어 위임 여부는 모델이 정합니다. 이 값이 없으면 host가 planner의 `subagent` 호출을 거부하고 planner는 `read`/`grep`/`glob`로 직접 조사합니다.
- `default_agent: "open-gajae"`는 새 세션의 기본 역할을 primary로 정합니다. 필수는 아니지만 권장합니다.
- 이는 전체 설정 교체 예시가 아닙니다. 파일의 나머지는 그대로 두고 이 key만 추가하세요. 플러그인은 host 설정을 스스로 편집하지 않습니다.

이는 요약이며, 검증 체크리스트를 포함한 단계별 설치는 [`docs/local-install-v2.md`](docs/local-install-v2.md)를, 이번에 대체되는 이전 v1 설정은 [`docs/local-install-v1.md`](docs/local-install-v1.md)(역사 기록으로 보존)를 참고하세요.

이 디렉터리에서 첫 프롬프트를 보낸 뒤(플러그인 `setup`은 서버 시작이 아니라 위치별 첫 프롬프트에서 지연 실행됩니다), `GET /api/plugin`(플러그인 id와 `index.ts` source 경로 확인) 또는 `opencode debug agent <id>` / `opencode debug skill`로 설치된 surface를 확인하세요.

## 진입

이 이식에는 슬래시 커맨드가 없습니다. v1의 `/deep-interview`와 `/ralplan`은 사라졌습니다(기록된 deviation). `deep-interview`, `ralplan`, `ultragoal`을 사용하라는 명시적 자연어 요청이나 지원되는 mention·호출 문맥의 키워드로 요청한 skill에 진입합니다.

- **Mention**: `@deep-interview`, `@ralplan`, `@ultragoal` 중 하나를 입력하고 TUI 자동완성에서 선택합니다. 선택하면 skill이 바로 붙습니다. 자동완성을 선택하지 않고 텍스트만 입력하면 skill이 붙지 않은 일반 텍스트로 전송됩니다 — 서버가 `@` mention을 자체적으로 파싱하지 않기 때문이며, 이 경우 아래 키워드 경로가 대신 감지합니다.
- **키워드**: v1과 같은 OMC 기반 키워드 감지(영/한/일 표기, 질문·인용·코드 블록 제외, ralplan의 호출 문맥 요구)가 일반 텍스트의 명시적 요청을 감지하고 안내를 주입합니다. 사용자가 요청하지 않은 heuristic 추천은 skill 또는 직접 진행을 제시하고 사용자의 선택을 따릅니다. `deep-interview`를 시작하지 않고도 일반적인 확인 질문을 할 수 있습니다. skill 시작 후에는 내부 질문·완료 선택·승인 절차가 그대로 적용됩니다.
- **Ultragoal**: `ultragoal` 키워드와 `@ultragoal` mention은 skill을 불러오라는 안내만 넣습니다. 실제 진입과 목표 계획 시작은 id가 `ultragoal`인 native `skill` 호출입니다([Ultragoal](#ultragoal) 참고). ultragoal이 활성 skill인 동안 `@ralplan`, `@deep-interview`와 그 키워드는 먼저 `ultragoal handoff`를 부르라는 안내를 대신 받습니다.
- **Deep-interview**: 키워드, `@deep-interview` mention, `skill` 로드는 안내하거나 skill을 붙이기만 합니다. 인터뷰는 주 에이전트가 `deep-interview start`를 부를 때 시작합니다([Deep interview](#deep-interview) 참고).

## Deep interview

`deep-interview`는 GJC 고정 커밋의 deep-interview skill과 런타임을 기준으로 다시 만든 요구사항 명확화입니다: `skills/deep-interview/SKILL.md`와 패널 조각 `lateral-review-panel.md`, `src/deep-interview-runtime/`의 `deep-interview` 도구, `open-gajae-lateral-reviewer` 역할, 그리고 `src/skill-state/`의 공통 기반(활성 행, 스냅숏, audit, 저널 넘기기, doctor). OMC 기반 deep-interview와 옛 상태 도구 3개(`state_*`)를 대체했습니다. GJC와 다른 점은 모두 [GJC로부터의 deviation (deep-interview)](#gjc로부터의-deviation-deep-interview)에 적었습니다. 설계 결정은 `.omc/specs/deep-interview-deep-interview-gjc-revision.md`(끝의 Errata E1–E16이 우선), `.omc/plans/ralplan-deep-interview-gjc-revision.md`, `.omc/plans/deep-interview-gjc-pq-decisions.md`에 있습니다. 구현이 단계별로 어떻게 동작하는지는 [`docs/skills/deep-interview/`](docs/skills/deep-interview/README.md)에 있습니다.

**진입.** `@deep-interview` mention이나 `deep interview`/`deep-interview`/`딥인터뷰`/`ディープインタビュー`/`ouroboros` 키워드는 OMC의 `[MAGIC KEYWORD: DEEP-INTERVIEW]` 안내를 최대 한 번 넣습니다. OMC와 같이 정보성 문맥(질문, 인용·참조 언급, 코드·표·인용 블록)과 `ouroboros`/`ooo` CLI 형식으로 시작하는 메시지는 무시합니다. 이들도 `skill` 로드도 상태를 쓰지 않습니다. 인터뷰는 주 에이전트가 `deep-interview start(idea, threshold?)`를 부를 때 시작합니다(deviation 13). skill은 native `question`을 한 번에 하나씩 씁니다. 저장된 spec은 구현 승인이 아닙니다.

**기준치.** 기본 ambiguity 기준치는 gjc의 `0.05`입니다. 설정 파일의 `deepInterview.ambiguityThreshold`(`(0, 1]`)가 이를 덮고, `start(threshold)`가 둘 다 덮습니다. 정해진 값과 출처(`~/.open-gajae/open-gajae.jsonc`, `./.open-gajae/open-gajae.jsonc`, `default`)는 `<open-gajae-runtime-settings>` 블록으로 주 에이전트에 전달되고, `start`도 같은 출처 문자열을 기록합니다. 인자로 준 값의 출처는 `start(threshold)`입니다(deviation 20). skill의 첫 줄은 `Deep Interview threshold: <percent> (source: <source>)`입니다. 활성 인터뷰는 자기 기준치를 유지하며, skill은 활성 상태 위에서 `start`하지 않습니다.

**라운드와 모호도.** 답을 받을 때마다 모델이 `deep-interview write`로 라운드를 기록합니다. 질문과 답 원문, 점수, 자기 원 모호도를 담고, GJC처럼 `round_key`(`round-<n>`)로 병합합니다(deviation 3). 런타임은 이번 쓰기가 건드린 라운드를 모두 검사합니다(`round`, `round_key`, `lifecycle: "scored"`, `question_text`, `answer`, `ambiguity`, goal·constraints·criteria 점수. brownfield는 `context` 추가. Round 0은 `answered`). 하나라도 어긋나면 `write` 전체를 거절합니다(deviation 36). `current_ambiguity`는 런타임이 정합니다. 마지막 채점 라운드의 값에, 해결 안 된 분쟁 사실마다 `0.10`, 채점 안 된 활성 구성요소마다 `0.05`의 하한을 적용합니다(deviation 4). `write` 입력 최상위의 전사 필드는 `state` 안으로 옮기지 않고 거절합니다(deviation 25). 인터뷰는 기준치 도달(점검·재진술 확인 뒤), 3라운드 이후의 조기 진행, 중단 요청, 고정 100라운드 상한에서만 끝나며, 보통 라운드 뒤에 계속할지 묻지 않습니다.

**스펙과 넘기기.** `deep-interview spec(content | path, slug?)`는 `specs/deep-interview-<slug>.md`를 쓰고, `specs/deep-interview-index.jsonl`에 한 줄을 더하고, `spec_path`·`spec_sha256`을 기록하고, 인터뷰를 `handoff`로 옮깁니다. 그다음 Phase 5는 네 가지를 제시합니다: ralplan으로 다듬기(추천), ultragoal로 실행(구현 가능하고 아주 단순한 스펙만), 더 다듬기, 여기서 마치기(`deep-interview clear`)(deviation 10). ralplan이나 ultragoal을 고르면 `deep-interview handoff(to)`를 부른 뒤 skill을 불러옵니다. 넘기기는 phase `handoff`와, sha256이 아직 맞는 스펙 파일을 요구합니다. `spec(…, handoff: "ralplan")`은 세 단계를 한 번에 합니다(deviation 38). deep-interview를 불러온 실행에서 `skill` `ralplan`이나 `ultragoal`을 불러오면 게이트를 거칩니다: `interviewing`인 인터뷰는 거절하고, `handoff`인 인터뷰는 넘기고, 유효한 스펙이 있는 끝난 인터뷰는 연결합니다(deviation 31). `ralplan handoff(to="deep-interview")`와 `ultragoal handoff(to="deep-interview")`는 라운드와 스펙 필드를 둔 채 인터뷰를 `interviewing`으로 다시 엽니다.

**가드와 이어가기.** deep-interview가 보이는 주 skill이고 `interviewing`이나 `handoff`로 활성인 동안, 세션의 모든 agent가 OS 임시 경로 밖에 `write`·`edit`·`patch`하는 것을 거절합니다(shell은 분류하지 않음, deviation 14). `specs/deep-interview-*`는 편집 도구에 늘 거절됩니다(deviation 35). 루트의 `succeeded`에서 플러그인은 `interviewing`인 인터뷰를 진짜 사용자 프롬프트마다 최대 두 번 이어가며(`open-gajae: deep-interview continuation N/2`), 이는 goal·ralplan 이어가기보다 먼저이고 그것들을 대신합니다. `handoff`에서는 둘 다 멈춥니다(deviation 16). 압축은 `<deep-interview-compaction-context>` 블록을 더합니다(deviation 15). `deep-interview` 도구는 `open-gajae` 전용이며 다른 모든 agent에게서 숨겨집니다(deviation 24).

**저장소.** 모든 파일은 세션 계보의 루트 세션에 속합니다.

```text
<worktree>/.open-gajae/
  _session-<created>-<session-id>/
    state/deep-interview-state.json
    state/active/deep-interview.json
    state/skill-active-state.json
    state/audit.jsonl
    specs/deep-interview-<slug>.md
    specs/deep-interview-index.jsonl
```

세션마다 `_session-<YYYYMMDD-HHMMSS>-<세션 ID>` 디렉터리를 하나 가집니다. 라벨은 세션 생성 시각(로컬 시간)이고 ID는 native 세션 ID 원문입니다. 이후에는 세션 ID 접미로 디렉터리를 찾으며, 같은 접미의 디렉터리가 둘이면 오류입니다. 상태는 GJC 봉투(`skill`, `version`, `active`, `current_phase` — `interviewing`, `handoff`, `complete` — `threshold`, `threshold_source`, `spec_*` 필드, 그리고 `state` 아래의 인터뷰)에 StateStore `_meta`를 더한 것입니다. receipt, checksum, revision, 초안은 없습니다(deviation 2). 모든 op는 세션의 workflow 큐 하나에서 돌고, 첫 쓰기 전에 모든 검사를 끝내며, 파일이 바뀔 때마다 audit을 한 줄 남깁니다. 결합 스펙 호출은 세 단계를 차례로 돌고, 뒤 단계가 실패하면 앞 단계의 결과가 남습니다([`docs/skills/deep-interview/`](docs/skills/deep-interview/README.md) 참고).

| Op | 입력 | 효과 |
|---|---|---|
| `start` | `idea`, `threshold?` | 이전 상태 위에 새 인터뷰를 시드합니다(스펙 파일은 남음). ralplan이나 ultragoal이 보이는 주 skill이면 거절합니다(deviation 12). |
| `write` | `input`, `reset?` | 활성 인터뷰에 라운드·사실·맥락을 병합합니다. `reset`은 입력만으로 상태를 다시 만듭니다. |
| `spec` | `content` 또는 `path`, `slug?`, `handoff?` | 최종 스펙을 저장하고 `handoff`로 옮깁니다. `handoff: "ralplan"`이면 ralplan도 시드하고 넘깁니다. |
| `handoff` | `to`(`ralplan`, `ultragoal`) | 스펙이 확인된 `handoff` 인터뷰의 저널 넘기기. |
| `status` | `fields?` | GJC의 `{skill, state, storage_path}` 또는 고른 필드. |
| `doctor` | — | deep-interview 상태·행·스냅숏에 대한 GJC doctor 텍스트. |
| `state` | `patch` | 패치를 병합합니다(`null`은 삭제). 라운드·사실·모호도·스펙 필드는 거절하고(deviation 19), phase는 GJC 전이표를 따릅니다. |
| `clear` | `force?` | `{active: false, current_phase: "complete"}`로 만들고 스펙 파일은 두고 행을 지웁니다. 상태가 없어도 동작합니다. `force` 없이는 손상된 상태, `inactive`가 아닌 해제 phase(`complete` 등)인 상태, phase가 상태와 다른 활성 행을 거부합니다(GJC `describeStaleClearState`). |

`write`·`spec`·`handoff`·`state`는 활성 인터뷰가 필요합니다(deviation 30). 사용자는 여전히 다른 세션의 spec이나 plan을 입력으로 지정할 수 있습니다. native Read와 그 권한이 적용되고, 세션은 실제로 읽은 경로를 알려야 하며, 상태·소유자·승인·권한은 아무것도 넘어가지 않습니다.

## Ralplan

`ralplan`은 GJC 고정 커밋의 ralplan skill과 런타임 계약을 바탕으로 다시 만든 합의 계획입니다. 구성은 `skills/ralplan/SKILL.md`, `open-gajae-planner`/`open-gajae-architect`/`open-gajae-critic` 프롬프트, 그리고 `src/ralplan-runtime/`의 `ralplan` 도구입니다. 계획만 하며, 사용자가 실행을 승인하기 전까지 plan은 `pending approval`로 남습니다. GJC와 다른 점은 모두 [GJC로부터의 deviation (ralplan)](#gjc로부터의-deviation-ralplan)에 기록되어 있습니다.

`@ralplan [--interactive] [--deliberate] <task>` mention, 또는 `ralplan`/`랄플랜` 키워드가 합의 계획을 시작합니다. OMC와 같이 키워드는 호출 문맥에서만 발화합니다: 직접 호출 접두(`$ralplan`, `!ralplan`, `force: ralplan`), 활성화 동사(`use`, `run`, `start`, `please`, `let's`), 또는 메시지 맨 앞의 키워드. 질문, 인용·참조 언급, 코드·표·인용 블록 안의 텍스트는 발화하지 않습니다. 키워드와 mention 안내는 `open-gajae` primary, 또는 agent가 없는 세션만 받습니다. 호스트 `build`와 사용자 정의 agent는 `ralplan` 도구가 숨겨지고 거부되므로 받지 않고(R-OD20), 소유 역할 subagent는 역할 지시문이 키워드를 인용할 수 있으므로 받지 않습니다. 한 메시지에 ralplan과 deep-interview 키워드가 함께 있으면 두 안내가 ralplan부터 순서대로 주입됩니다.

키워드 턴은 `[MODE: RALPLAN]` 안내를 주입해 모델에게 `ralplan` skill을 열도록 요청합니다. `@ralplan` mention은 skill이 이미 붙었다는 자체 `[MODE: RALPLAN]` 안내를 넣어 삽입 사실이 보이게 합니다(TUI에 `open-gajae: ralplan mention notice added`가 표시됨). 어느 쪽도 ralplan state를 쓰지 않습니다 — 시딩, 확인 단계, 남은 seed 정리가 없습니다. run은 primary가 문서화된 진입인 `ralplan start`를 호출할 때 시작합니다(GJC의 `gjc ralplan "<task>"`).

안내(ralplan·ultragoal 안내, deep-interview magic guide, goal 보류 안내, breaker 메시지)는 함께 일어나는 state 쓰기가 있으면 그 뒤에 `ctx.session.synthetic({ resume: false })` 메시지로 기록됩니다. host는 synthetic 메시지를 같은 턴의 user 메시지 **앞**에 배치합니다. OMC/v1은 뒤에 덧붙였으므로 이는 기록된 host 배치 차이이며, 설계 선택이 아닙니다. `synthetic` 자체가 실패하면 안내가 사라지지 않도록 marker로 감싼 채 prompt 텍스트에 덧붙입니다. state 쓰기는 어느 쪽이든 유지됩니다.

**`ralplan` 도구**는 ralplan state, run의 단계 파일, ralplan 활성 행과 스냅숏의 유일한 기록자입니다. `state_*` 도구는 더 이상 `mode: "ralplan"`을 받지 않으며 deep-interview 전용입니다. op는 GJC의 CLI·state 동사에 대응합니다.

| Op | 호출자 | 동작 |
|---|---|---|
| `start(task, interactive?, deliberate?, run_id?)` | primary | 새 state(`active: true`, phase `planner`, `mode` short 또는 deliberate)를 쓰고 `session_id`, `run_id`, `state_path`, `repository_binding`이 담긴 영수증을 돌려줍니다. ultragoal state가 활성이면 거부되며, 거부 문구가 `ultragoal handoff(to="ralplan", reason)`를 알립니다. |
| `write(stage, stage_n, content \| path, run_id?, lane_verdict?, resumable?, fallback_*)` | primary, planner, architect, critic | 단계 산출물 하나를 저장하고 평문 영수증(`path`, `sha256`, `stage`, `stage_n` 등)을 돌려줍니다. |
| `status(fields?)` | primary, planner, architect, critic | `{skill, state, storage_path}`를 돌려줍니다. `fields`는 state 필드를 골라 보여줍니다. |
| `doctor` | primary | `schema_violation`과 `stale_active_state`를 보고하며 아무것도 고치지 않습니다. |
| `state(patch)` | primary, planner, architect, critic | patch를 병합합니다(`null`은 필드 삭제). phase 변경은 GJC 전환 규칙표를 따라야 합니다. Stop here는 `patch={"active": false}`입니다. |
| `handoff(to="ultragoal")` | primary | 승인된 plan을 ultragoal에 넘깁니다(아래). |
| `clear(force?)` | primary | `{active: false, current_phase: "complete"}`로 두고 파일과 `run_id`는 유지합니다. `force` 없이는 GJC처럼 손상된 state, 이미 종료 해제 phase(`complete` 등)인 state, 잠기지 않은 phase에서 활성 행 phase가 그와 다른 state를 거부합니다(`final` 같은 잠긴 phase에서는 GJC가 행의 phase를 state의 phase로 읽으므로 final 이후 다듬기 중의 clear는 통과). 활성 행 파일을 읽을 수 없어도 멈춥니다(deviation 35). |

모든 op는 호출 세션의 계보 루트를 대상으로 하므로, 역할의 하위 세션도 루트 세션 폴더에 기록합니다. run 폴더는 명시한 `run_id`, 그다음 state의 `run_id`, 그다음 루트 세션의 native ID(예: `ses_f4b081a27ffe…`)입니다. 명시하는 `run_id`는 `A-Z a-z 0-9 . _ -` 1~64자이고, `.`으로 시작하거나 `..`을 포함할 수 없습니다. `open-gajae-explore`, `open-gajae-document-specialist`, `open-gajae-executor`, `open-gajae-cleaner`에서는 이 도구가 거부되고 숨겨집니다. 플러그인의 `context` 훅은 `build`/`general` 같은 host agent와 사용자 정의 agent의 요청에서도 이 도구를 지우며, 호출하면 도구가 거부합니다([수용한 동작 차이](#수용한-동작-차이) 참고).

```text
<worktree>/.open-gajae/
  _session-<created>-<session-id>/
    plans/ralplan/<run-id>/
      stage-01-planner.md
      stage-01-intent.md
      stage-01-architect.md
      stage-01-critic.md
      stage-02-revision.md
      …
      stage-NN-final.md
      index.jsonl
      pending-approval.md
    state/ralplan-state.json
    state/ralplan-continuation.json
    state/audit.jsonl
    state/active/ralplan.json
    state/skill-active-state.json
```

- **단계 파일.** 단계는 `planner`, `intent`, `architect`, `critic`, `disposition`, `revision`, `post-interview`, `adr`, `final`이고 `stage_n`(1~999)은 회차 번호입니다. write마다 불변 파일 `stage-NN-<stage>.md`를 만들고 run의 원장 `index.jsonl`에 `{stage, stage_n, path, created_at, sha256}` 한 줄을 추가합니다. `final` 줄에는 `auto_handoff`도 들어갑니다. `final`은 `pending-approval.md`로 복사되며 다음 `final`이 이를 덮어씁니다. 링크 규칙, 자동 목차, 자동 머리말은 없습니다.
- **멱등 기록.** 같은 `(stage, stage_n)`에 같은 내용을 다시 쓰면 앞의 영수증을 `deduplicated: true`와 함께 돌려주고(빠진 원장 줄은 복구), 다른 내용은 "Use a new stage_n to record another pass."로 거부합니다.
- **역할은 content로만 기록.** planner, architect, critic은 산출물 전체를 `content`로 넘기고 primary에게는 영수증만 돌려줍니다. primary는 `content`를 넘기거나, 프로젝트 밖 OS 임시 루트(`os.tmpdir()`, `$TMPDIR`, `/tmp`, `/var/tmp`와 그 `/private` 별칭) 아래 파일의 `path`를 넘길 수 있습니다.
- **Disposition.** Architect와 Critic의 지적이 충돌하면 revision 전에 `disposition` 단계(JSON, GJC `ralplan.review_conflicts.v1` 스키마)가 충돌마다 처리를 정해야 합니다. 도구는 근거 영수증을 run 원장과 대조해, 미처리·알 수 없는·불일치 항목을 거부합니다.
- **기록 관리.** `state/audit.jsonl`에는 파일 변경 1건당 한 줄이 남습니다. `state/active/ralplan.json`과 스냅숏 `state/skill-active-state.json`은 활성 행과 HUD 칩을 담습니다. 아직 open-gajae에는 이를 그리는 곳이 없습니다(필수 후속 개발 6번). `state/ralplan-continuation.json`은 continuation breaker 카운터만 담습니다.

**예산과 PLANNING-STUCK.** 한 run이 여는 회차(planner·revision opener)는 최대 `ralplan.maxIterations`(기본 5)이며, `index.jsonl`과 디스크의 단계 파일 중 큰 쪽으로 셉니다. 레인마다 열린 회차당 architect 또는 critic 기록은 `ralplan.maxReviewPassesPerLane`(기본 1)까지입니다. 어느 예산이든 넘는 write는 오류 대신 `PLANNING-STUCK` 결과(`ok: false`, `planning_stuck: true`, `marker: "PLANNING-STUCK"`)를 돌려주고 state에 `planning_stuck`을 기록합니다. 이미 열린 회차 안의 architect·critic 기록과 `post-interview`, `adr`, `final`은 계속 허용되어 가장 나은 plan을 `pending approval`로 남길 수 있습니다. 막힌 run의 `final`은 `auto_handoff`를 사유 `planning_stuck`과 함께 `off`로 해석하며 절대 인계되지 않습니다. 새 `run_id`는 새 폴더와 새 예산으로 시작합니다.

**합의 흐름.** skill은 GJC의 9단계를 따릅니다. planner가 초안을 씁니다(`planner`, 1회차). primary가 중요한 의도를 사용자와 맞추고(`intent`, native `question` 한 번에 하나씩), 계약이 바뀌었으면 planner를 재개해 `revision`을 씁니다. architect와 plan-only critic은 1회차를 병렬로 검토하고(한 메시지 안의 `subagent` 호출 두 개) `lane_verdict`(`CLEAR`/`WATCH`/`BLOCK`, `OKAY`/`ITERATE`/`REJECT`)를 기록합니다. 2회차부터는 같은 planner·architect·critic 세션을 재개하고(기록된 `sessionID`로 `subagent`) architect → critic 순서로 검토합니다. 합의 뒤 primary는 새로 생긴 의도 차이를 사용자와 확인하고(`post-interview`) ADR을 포함한 `final`을 씁니다. `--interactive`는 초안 검토를 추가합니다. `--deliberate`는 pre-mortem과 확장된 test plan을 추가하며, 명시적 고위험 신호에서 자동으로 켜집니다. 질문이 열려 있는 동안은 continuation이 발화하지 않습니다 — native `question` 도구가 답이 올 때까지 실행을 붙잡고 있어서 그동안 `session.execution.succeeded`가 발행되지 않기 때문입니다.

도구는 역할이 write할 때 그 역할 자신의 세션 ID(`planner_subagent_id`, `architect_id`, `critic_id`)를 기록해 primary가 재개할 수 있게 합니다. 재개가 실패하면 primary는 새 역할 세션을 띄우고 `fallback_reason`, `fallback_attempted_id`, `fallback_stage_n`을 기록합니다.

**승인, Stop here, 인계.** `final`이 `auto_handoff.effectiveTarget`을 `ultragoal`로 해석하면(`ralplan.autoHandoff: "ultragoal"` 설정, 막히지 않은 run) primary는 묻지 않고 인계합니다. 그 밖에는 **Refine further**, **Approve execution via ultragoal (Recommended)**, **Stop here**와 자유 입력을 담은 `question` 하나를 엽니다. 사용자가 승인하거나 같은 턴에서 이미 ultragoal을 지목하지 않으면 plan은 `pending approval`로 남습니다.

- **Refine further**는 재검토 루프로 돌아갑니다.
- **Stop here**는 `ralplan state(patch={"active": false})`입니다. phase는 `final` 그대로, `pending-approval.md`는 보존되고, 활성 행이 제거됩니다. 나중에 ultragoal을 요청하면 GJC처럼 ultragoal을 바로 불러옵니다. `ralplan handoff`는 비활성 ralplan을 거부하므로(R-OD18) ultragoal에 `handoff_from`이 남지 않습니다.
- **Approve execution via ultragoal**: primary가 `ralplan handoff(to="ultragoal")`를 호출하고 `ultragoal` skill을 불러와, final plan(결과가 `pending-approval.md`를 알려 줌)을 읽고 그 설명과 목표를 구조화 인자로 넣어 `ultragoal create`를 호출합니다. handoff op는 종료 phase(`final`, `handoff`, `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`)에 있는 활성 ralplan을 요구하며, 비활성 ralplan은 거부합니다(R-OD18). 인계는 공통 저널 인계로 합니다([Ultragoal](#ultragoal) 참고): ralplan은 `{active: false, current_phase: "handoff", handoff_to: "ultragoal"}`가 되고 활성 행은 비활성 `handoff_to` 행으로 남으며, ultragoal은 `handoff_from: "ralplan"`과 함께 `goal-planning`으로 활성이 됩니다. 양쪽 모두 기존 필드를 유지합니다.
- **같은 execution 게이트.** `ralplan`을 불러온 execution 안에서 `skill` `ultragoal`을 불러오면, ralplan이 종료 phase에서 활성일 때(예: 승인 질문이 열려 있는 동안의 활성 `final`) 그 로드가 같은 인계를 직접 수행하고, 진행 중 계획 phase에서 활성이면 로드가 거부됩니다. continuation이나 background subagent 완료가 세션을 다시 연 뒤의 execution에서는 인계 없이 ultragoal에 진입하고 ralplan은 그대로 둡니다. 그래서 `final` 뒤에는 `ralplan handoff(to="ultragoal")`를 먼저 부릅니다(알려진 동작, [Ultragoal](#ultragoal) 참고).
- **반대 방향.** `ultragoal handoff(to="ralplan", reason)`은 같은 저널 인계를 반대로 합니다: ultragoal은 `handoff`가 되고(목표, ledger, progress, goal은 유지), ralplan은 기록된 `run_id`를 유지한 채 `planner`로 활성이 됩니다. `ralplan start`는 부르지 않고 `ralplan write`로 그 run을 이어 씁니다. 이때 아직 쓰지 않은 다음 `stage_n`을 쓰거나, 새 폴더와 예산이 필요하면 첫 `write`에 새 `run_id`를 줍니다. 새 `final` 뒤 `ralplan handoff(to="ultragoal")`가 ultragoal을 `goal-planning`으로 되돌리고, `ultragoal create`가 목표 목록을 새로 씁니다.

**write 의미(GJC와 같음).** `start` 없이 `write`하면 state를 만듭니다(`active: true`, phase = 기록한 단계, `mode`·`interactive`·repository binding 없음). 새 `run_id`를 명시한 `write`는 run을 전환하며 verdict·stuck·auto-handoff 필드를 초기화합니다. 같은 run에서는 write가 `active: true`로 두고 phase를 기록한 단계로 전진시키지만, phase가 잠겨 있으면(`final`, `handoff`, `complete` 등) state를 전혀 바꾸지 않습니다 — 그래서 Stop here나 `clear` 뒤의 다듬기 write는 run을 다시 활성화하지 않습니다. 다만 write는 활성 행을 다시 쓰며, 그 행은 다음 Stop here, handoff, clear까지 남습니다. `write`는 ultragoal 실행 중에도 거부되지 않습니다: ultragoal 실행 중 역할이나 primary의 write가 ralplan을 활성화할 수 있습니다. ultragoal 행이 활성인 동안은 ultragoal이 보이는 주 skill로 남지만, 그 행이 사라지면(실행 완료나 clear) ralplan 행이 주 skill이 됩니다. 그러면 계획 가드가 편집을 막고, goal이 활성이 아니게 되면 ralplan continuation도 다시 동작합니다. `ralplan state(patch={"active": false})` 또는 `ralplan clear`로 복구하세요. 가드의 차단 메시지도 이 둘을 안내합니다.

**계획 가드.** ralplan이 루트 세션의 보이는 주 skill이고 그 state가 `active: true`이며 phase가 `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`가 아니면 — 즉 `final`과 `handoff`도 active인 동안은 막습니다 — 그 세션 계보의 모든 agent의 `write`, `edit`, `patch`를 거부합니다. 주 skill은 활성 행 중 순위가 가장 높은 것이며, 계획 파이프라인 deep-interview → ralplan → ultragoal은 가장 뒤 단계 하나로 접힙니다(GJC 순위). 대상이 모두 프로젝트 밖 OS 임시 루트 아래일 때만 통과합니다. ultragoal이 주 skill이면 ralplan 가드는 적용되지 않고, 대신 ultragoal 자체 가드가 `goal-planning` phase 동안 같은 호출을 막습니다. `shell` 명령은 검사하지 않습니다. deep-interview 스펙은 `deep-interview` 도구가 쓰므로 이 가드의 영향을 받지 않습니다. 가드와 별개로, 세션 폴더의 `plans/ralplan/**`, `state/**`, `specs/deep-interview-*`, 그리고 ultragoal 소유 파일에 대한 `write`, `edit`, `patch`는 모든 agent에게 항상 거부되며 도구만 이들을 바꿉니다.

continuation은 ralplan이 보이는 주 skill이고(활성 행 기준, ralplan deviation 10) 그 state가 active이며 종료 phase가 아니고 `planning_stuck`이 아닌 동안 durable `session.execution.succeeded` 이벤트(v2는 `session.idle`을 발행하지 않습니다)에서 `ctx.session.synthetic({ resume: true })`로 세션에 다시 프롬프트를 넣습니다. goal이 활성이면 그 턴은 goal 루프가 맡고 ralplan continuation은 없습니다([Ultragoal](#ultragoal) 참고). circuit breaker는 30회 주입에서 멈추고, `state/ralplan-continuation.json`에 두는 breaker 카운터는 45분이 지나면 만료됩니다 — v1과 같은 상수입니다. 소진되면 ralplan을 `active: false`로 두고 감사 로그에 한 줄을 남깁니다. 사용자가 턴을 중단하면 — `session.execution.interrupted`의 reason이 `user`(Esc 또는 interrupt API) 또는 `shutdown`(취소된 `question` form, 그리고 reason 없는 interrupt의 host 기본값)이면 — stop mark가 설정되고, 다음 실제 user 프롬프트만 이를 지웁니다. `inactivity`와 `superseded`는 mark를 설정하지 않습니다. continuation은 현재 세션 아래에서 실행 중인 background subagent 세션(`background: true`로 실행됨)이 있으면 `session.created`/`session.execution.started`/terminal 이벤트를 `parentID`로 추적해 건너뜁니다(OMC/OMO parity; v1에는 대응 사례가 없었습니다). 그런 child가 끝나면 host 자체의 subagent-completion synthetic이 parent를 재개하고, 그 뒤의 `succeeded`는 같은 breaker로 다른 succeeded와 동일하게 판단됩니다. v2 플러그인 인스턴스는 location마다 하나씩 만들어지지만 공유 서버는 모든 인스턴스에 모든 이벤트를 전달하므로, 이 플러그인은 자기 location과 일치하는 세션에만 동작합니다 — v2에서 새로 생긴 사실이며 위 결정들을 바꾸지는 않습니다.

host가 ralplan state가 active인 세션을 압축하면, 플러그인은 현재 plan의 목표, 범위, 비목표, 수용 기준, Intent Reconciliation, 다음 행동을 담은 `<ralplan-compaction-context>` 블록 하나를 압축 프롬프트에 추가합니다. state가 비활성이거나 손상되었거나 산출물의 sha256이 원장 줄과 맞지 않으면 추가하지 않습니다. state는 세션별이므로 세션 간 복원은 없고, ralplan restore 안내도 없습니다.

**알려진 동작(GJC와 같음).** 잠긴 phase에서 write하면 — `final` 이후의 다듬기, 또는 Stop here나 `clear` 뒤의 write — 활성 행의 phase는 방금 쓴 단계가 되고 state의 phase는 `final` 또는 `complete`로 남습니다. 이때 원본 행 파일을 읽는 `ralplan doctor`는 GJC처럼 `stale_active_state`를 보고하고 해결 명령으로 `ralplan clear`를 제시합니다. `final`에서 다듬은 뒤라면 `clear`가 잠긴 state의 phase를 행의 phase 대신 읽으므로 그 `force` 없는 `ralplan clear`는 GJC처럼 성공합니다(`clear` 뒤라면 state가 이미 종료라 `force` 없는 clear는 거부됩니다). 예상된 동작이므로 이 보고만으로 `ralplan clear`를 호출하지 마세요. clear는 run을 끝냅니다.

**알려진 동작(GJC와 같음): 전환 감사 행.** 현재 phase에서 표의 간선이 아닌 단계를 write해도 성공하며, `state/audit.jsonl`에 `invalid_transition_detected` 행 하나만 추가됩니다(spec D-T11). 표에 다음 간선이 없어서 스킬이 정한 순서대로 진행해도 이런 행이 흔히 생깁니다. 1회차 병렬 리뷰는 어느 순서로든 기록되고(`intent→critic`, `revision→critic`, `critic→architect`), 1회차가 Architect를 마지막으로 합의에 이를 수 있으며(`architect→post-interview`), 수정본은 마지막 리뷰 레인 뒤에 오며(`architect→revision`), 2회차는 수정본에서 바로 Architect로 가고(`revision→architect`), 7단계는 `post-interview` 바로 뒤에 `final`을 씁니다(표는 `final`을 `adr` 뒤에만 둠, `post-interview→final`). GJC의 표와 스킬도 같으므로 같은 순서면 GJC도 같은 행을 남깁니다.

**진행 표시 없음.** spec이 ralplan용으로 계획한 TUI 사이드바(D-H3~D-H7)는 보류되었습니다(R-OD17). 배포된 OpenCode 2.0.15 바이너리는 TUI 플러그인에 호스트의 `solid-js`·`@opentui/*` 인스턴스를 넘겨주지 않아, 일반 import로는 플러그인이 그릴 수 없습니다(필수 후속 개발 6번). ralplan 활성 행과 스냅숏에는 GJC의 HUD 칩이 계속 기록됩니다.

## Ultragoal

`ultragoal`은 GJC 고정 커밋의 ultragoal 런타임과 goal 모드를 기준으로 다시 만든 지속 다중 목표 실행입니다. 구성은 `skills/ultragoal/SKILL.md`, `src/ultragoal-runtime/`의 `ultragoal` 도구, `src/goal/`의 `goal` 도구와 goal 루프, `src/skill-state/`의 공통 기반(활성 행·스냅숏·감사·저널·인계·doctor), 그리고 `open-gajae-cleaner` 프롬프트입니다. Phase 1의 OMC ralph 이식을 대체했으며, OMC 기반으로 남은 것은 `progress.txt` 기록 형식(`src/ultragoal-runtime/progress.ts`)뿐입니다. GJC와 다른 점은 모두 [GJC로부터의 deviation (ultragoal)](#gjc로부터의-deviation-ultragoal)에 기록되어 있고, SKILL과 프롬프트의 source 섹션이 그 행 번호를 인용합니다. 설계 결정은 `.omc/specs/deep-interview-ultragoal-gjc-revision.md`(Errata E1~E6 포함), `.omc/plans/ralplan-ultragoal-gjc-revision.md`, `.omc/plans/ultragoal-gjc-pq-decisions.md`에 있습니다.

현재 구현이 단계마다 어떻게 동작하는지는 각 단계를 맡는 함수 수준까지 [`docs/skills/ultragoal/`](docs/skills/ultragoal/README.md)에 적혀 있습니다.

**진입과 목표 계획.** `ultragoal` 키워드와 `@ultragoal` mention은 skill을 불러오라는 안내(`open-gajae: ultragoal keyword notice added` / `mention notice added`)만 넣습니다. `open-gajae`의 native `skill` 호출(id `ultragoal`)이 진입입니다: ultragoal state가 없거나 비활성이면 — 완료되었거나 인계된 state 포함 — 기존 필드를 유지한 채 `goal-planning`으로 올리고, 이미 활성이면 phase를 바꾸지 않습니다(deviation 35). `ralplan`과 같은 execution에서 불러오면, 종료 phase에서 활성인 ralplan을 먼저 인계하고, 진행 중 계획 phase에서 활성인 ralplan이 있으면 거부됩니다([Ralplan](#ralplan) 참고). `deep-interview`와 같은 execution에서 불러오면 대신 deep-interview 게이트를 거칩니다: 아직 `interviewing`인 인터뷰는 로드를 거부하고, `handoff`인 인터뷰는 인계하고, 유효한 스펙이 있는 끝난 인터뷰는 연결합니다. 이 연결은 활성 실행도 `goal-planning`으로 되돌립니다([Deep interview](#deep-interview) 참고). ultragoal이 보이는 주 skill이고 그 state가 `goal-planning`으로 활성인 동안에는, 세션 계보의 모든 agent의 `write`, `edit`, `patch`가 모든 대상이 OS 임시 루트 아래일 때를 빼고 거부됩니다(GJC의 goal-planning 수정 가드). `create`가 목표 계획을 끝냅니다. `start` op는 없습니다. 다시 실행하려면 skill을 불러와 `create`를 호출합니다.

**저장 구성.** 모든 파일은 세션 계보의 루트 세션에 속하므로, 역할 subagent도 루트 폴더를 읽고 거기로 보고합니다.

```text
<worktree>/.open-gajae/
  _session-<created>-<session-id>/
    ultragoal/goals.json
    ultragoal/ledger.jsonl
    ultragoal/progress.txt
    state/ultragoal-state.json
    state/goal-state.json
    state/goal-continuation.json
    state/active/ultragoal.json
    state/skill-active-state.json
    state/audit.jsonl
    state/transactions/<mutation-id>.json
```

- `ultragoal/goals.json`(version 2)은 실행의 `description`과 목표 `G001`, `G002`, …를 담습니다. 목표마다 `title`, `description`(목표의 objective), `status`(`pending`, `active`, `complete`, `failed`, `blocked`, `review_blocked`, `superseded`), `acceptanceCriteria`(`[{id, text}]`, ID `G001.AC1`, …), `amendments`(받아들인 변경마다의 원문), 수정 목표의 `steering`, 완료 목표의 `completionVerification` 영수증이 있습니다. version 1 파일(폐기된 OMC ralph 형식)은 거부되며, 변환은 없습니다.
- `ultragoal/ledger.jsonl`은 감사 기록입니다. 이벤트마다 `eventId`와 `timestamp`를 가진 JSON 한 줄이며 — `plan_created`, `goal_started`, `goal_checkpointed`(gate 원문 `qualityGateJson`과 영수증 포함), `steering_accepted`, `review_blockers_recorded`, `blocker_classified`, `critic_verdict`, `workflow_handoff` — 재계산이 실패하면 GJC의 `{type: "reconcile_failed", error}` 줄이 남습니다. 거부된 op, `add_pattern`, 읽기 op는 줄을 남기지 않습니다.
- `ultragoal/progress.txt`는 OMC ralph의 진행 기록입니다: `## Codebase Patterns`, complete checkpoint마다의 항목(구현, 바뀐 파일, learnings), `PLAN`·`HANDOFF` 메모. `create`는 이 파일을 덮지 않고 이어 씁니다.
- `state/ultragoal-state.json`은 mode state이며, 재계산 op마다 `goals.json`과 ledger로 다시 씁니다. `state/active/ultragoal.json`은 GJC HUD 칩(blocked, goals, current, status, ledger)을 담은 활성 행이고 아직 그리는 곳은 없습니다. `state/skill-active-state.json`은 순위 스냅숏입니다.
- `state/goal-state.json`은 goal(아래)이고, `state/goal-continuation.json`은 goal 루프 훅 전용 카운터와 보류 기록이며 감사하지 않습니다.
- `state/transactions/`는 skill 간 인계가 진행되는 동안 그 저널을 둡니다. 저널은 증거용입니다: 재생하거나 되돌리는 코드가 없고 `doctor`도 읽지 않습니다(GJC doctor도 pending 저널을 보고하지 않음).
- `state/audit.jsonl`에는 ultragoal 파일, mode state, 행, 스냅숏, 저널, goal state의 쓰기마다 한 줄이 남습니다. `state/goal-continuation.json`만 감사하지 않습니다.

이 파일들은 `ultragoal`·`goal` 도구만 바꿉니다. 모든 agent의 `write`, `edit`, `patch`는 거부됩니다.

**`ultragoal` 도구**는 `open-gajae` 전용입니다. 다른 모든 agent에게는 숨겨지고 거부됩니다. 모든 op는 계보 루트를 대상으로 세션의 workflow 큐 하나에서 돌며, 첫 쓰기 전에 모든 검사를 끝낸 뒤 GJC 순서(계획, ledger, progress, goal state, 재계산)로 씁니다. 결과는 JSON이 아니라 GJC의 사람용 텍스트이고, 거부는 `Error: <message>`이며, GJC 명령 이름은 `ultragoal next`, `ultragoal record_review_blockers` 같은 op 호출로 바뀝니다.

| Op | 입력 | 동작과 결과 |
|---|---|---|
| `status` | — | GJC status 텍스트(`# ultragoal status`, `- status:`, `- goals: N (…)`, `- objective:`, `- current:`, `- goals_path:`, `- ledger_path:`) 다음에 `- run_complete: yes` 또는 `no (<이유>)`, `- goal: <status> (<source>)` 또는 `- goal: none`, 그리고 목표마다 영수증 상태(`valid`, `per-goal(superseded final)`, `stale`, `none`)와 활성 기준을 보여 주는 `## goals` 목록. |
| `create` | `description`, `{title, description, acceptanceCriteria[]}`의 `goals[]`(목표 1개 이상, 목표마다 기준 1개 이상) | `goals.json`을 모든 목표 `pending`으로 덮어쓰고, `plan_created`와 `PLAN` 메모를 붙이고, goal을 켭니다. `Created ultragoal plan with N goal(s) at <path>.` 다음 줄에 `Goal armed: …` 또는 `Goal not armed: …`. |
| `next` | `retry_failed?` | 다음 목표를 `active`로 만듭니다(`goal_started`): 활성 목표, 없으면 첫 대기 목표. `retry_failed`이고 활성 목표가 없으면 대기 목표보다 첫 failed 목표를 먼저 잡습니다. `ultragoal next-action=execute-goal goal-id=…`, `objective=`, `goal-objective=`, `checkpoint requires=`, `criteria=`를 출력합니다. 또는 `ultragoal complete all=true`(영수증이 실행을 닫지 못하면 `run-complete=no reason=…`과 재오픈 `hint=`), 또는 `retry-failed`·`resolve-blockers` 행동. |
| `checkpoint` | `goal_id`, `status`(`complete`, `failed`, `blocked`, `pending`), `evidence`. `complete`면 `gate`, `implementation[]`, `files_changed[]`, `learnings[]`도 | `complete`는 gate를 검증하고, 영수증을 쓰고, 수정 목표의 `review_blocked` 원 목표를 superseded로 바꾸고, progress 항목을 붙이고, 다음 목표를 활성화합니다. `failed`·`blocked`는 status를 기록하고, `pending`은 어느 status의 목표든 다시 엽니다. `goal_checkpointed`를 붙입니다. `Checkpointed <id> as <status>.`와 GJC 후속 줄, 다음 목표의 `Criteria:`, `Run not complete: <이유>`, 또는 `Reopened <id>; …`. |
| `validate_gate` | `gate`, `goal_id?` | `checkpoint(complete)`와 같은 gate 규칙을 읽기 전용으로: `quality gate is valid.` 또는 `N quality-gate error(s):`와 결함마다 `  path [code]: message` 한 줄. `goal_id`가 없으면 첫 pending·active·failed 목표를 검사하고, 계획이나 그런 목표가 없으면 목표별 gate로서 모양만 검사합니다. |
| `add`, `revise`, `supersede` | `target`(`goal` 또는 `criterion`), `goal_id`, `criterion_id`, `title`, `description`, `acceptanceCriteria`, `criterion`, `after`, `rationale`, `evidence` | 계획 변경(아래). `steering_accepted`를 붙이고 원문을 `amendments`에 남깁니다. `Accepted <op> steering. target=<id>`. |
| `add_pattern` | `pattern` | `progress.txt`의 Codebase Patterns에 한 줄을 더합니다. |
| `record_review_blockers` | `goal_id`, `title?`, `objective`, `evidence` | 목표를 `review_blocked`로 두고 수정 목표를 붙입니다(아래). `Recorded review blockers. blocker-goal-id=<id>`. |
| `classify_blocker` | `classification`(`resolvable`, `human_blocked`), `evidence`, `goal_id?` | `blocker_classified`를 붙입니다. `Recorded blocker classification: <c> event-id=<id>.` |
| `record_critic_verdict` | `terminus`(`completion`, `pause`), `verdict`(`OKAY`, `ITERATE`, `REJECT`), `evidence`, `blockers[]`, `classification_event_id?`, `goal_id?` | `critic_verdict`를 붙입니다. 판정과 `critic non-OKAY streak: n/5`를 출력하고, 5이면 `— continuation held`를 붙입니다. |
| `handoff` | `to`(`ralplan`, `deep-interview`), `reason` | 저널 인계(아래). 한 줄 JSON 영수증. |
| `doctor` | — | ultragoal state·행·스냅숏에 대한 GJC doctor 텍스트. 아무것도 바꾸지 않습니다. |
| `state` | `patch` | ultragoal state에 필드를 병합합니다(`null`은 삭제). 파생 필드(`goals`, `counts`, `status`, `active_goal_id`, 경로들, `latestLedgerEvent`, `skill`, `version`, `session_id`)는 거부하고, `current_phase` 변경은 GJC 전환표의 간선이어야 합니다. 한 줄 JSON 영수증. |
| `clear` | `force?` | 기존 필드 위에 `{active: false, current_phase: "complete"}`를 씁니다. 파일은 남기고 행은 지웁니다. `force` 없이는 손상된 state, 이미 해제 phase(`complete`, `failed` 등)인 state, phase가 state와 다른 행을 거부합니다. 한 줄 JSON 영수증이며, goal이 열려 있으면 `The goal is still <status>; run goal drop to end it.`를 더합니다. |

그 밖의 op — `status`, `create`, `next`, `checkpoint`, `add`, `revise`, `supersede`, `record_review_blockers`, `classify_blocker`, `record_critic_verdict` — 는 끝에 재계산합니다: `goals.json`과 ledger로 실행 status를 구하고 mode state, 활성 행, 스냅숏, HUD를 강제로 씁니다. `add_pattern`, `validate_gate`, `doctor`는 재계산하지 않고, `state`, `clear`, `handoff`는 행을 직접 씁니다.

**목표와 계획 변경.** 계획 변경에는 각각 5단어·32자 이상인 `rationale`과 `evidence`가 필요합니다. 고친 기준은 새 ID를 받고 옛 ID는 은퇴하며 다시 쓰지 않습니다. 허용 상태는 GJC steering op를 따릅니다(deviation 38).

- 목표의 문구, 위치(`after`를 준 `revise`), 기준은 목표가 `pending`일 때만 바뀝니다. `active`나 `failed` 목표는 먼저 `checkpoint(status: "pending")`으로 되돌립니다.
- 목표 `supersede`는 `pending`, `blocked`, `review_blocked` 목표를 받으며, 유일하게 남은 필수 목표는 거부합니다. 기준 `supersede`는 그 목표의 마지막 활성 기준을 거부합니다.
- 목표 `add`는 `after`가 가리키는 목표 바로 뒤, 없으면 끝에 들어갑니다. 목표를 맨 앞에 두는 호출은 없습니다.
- `complete` 목표는 전혀 바꿀 수 없습니다. 고쳐서 다시 검증하려면 `checkpoint(status: "pending")`으로 다시 열고, 고친 뒤, `next`를 부르고 새 gate로 `complete` checkpoint를 합니다. GJC처럼 `checkpoint(failed|blocked)`와 `record_review_blockers`도 목표를 `complete`에서 옮깁니다.

**검증.** 모든 목표는 `complete`로 checkpoint하기 전에 자기 architect 리뷰를 받습니다. 무거운 리뷰는 실행의 마지막 필수 목표 — 그 목표를 완료하면 다른 필수(superseded가 아닌) 목표가 남지 않는 목표 — 에서 한 번만 합니다. 목표에 필요한 gate는 `next`의 `checkpoint requires=` 줄이 알려 줍니다.

- 목표별 gate는 `targetedVerification`(`passed`, 명령 1개 이상, 증거), `architectReview`(`architectureStatus`, `productStatus`, `codeStatus` 모두 `CLEAR`, `recommendation: "APPROVE"`, 증거, blocker 없음), 활성 기준마다 정확히 한 줄인 `criteriaCoverage`(`covered`, `passed`, `verified`)입니다. 깨끗하지 않은 리뷰는 `failed`로 checkpoint하고 고친 뒤 `next(retry_failed: true)`로 다시 합니다. 재시도 상한은 없습니다.
- final gate는 여기에 `reviewCohort`와 `criticReview`를 더합니다. `reviewCohort`는 `reviewGeneration`, `joined: true`, 그리고 하나의 고정된 변경 집합에서 도는 세 레인입니다: 읽기 전용 `open-gajae-cleaner`(`PASS`), `open-gajae-architect`(`CLEAR`), `open-gajae-executor` QA/red-team 레인(`passed`, `commands`와 `adversarialCases` 포함). `criticReview`는 terminal `open-gajae-critic`의 `OKAY`입니다. 2세대 이상은 `deltaOnly: true`와 `deltaPaths`가 필요합니다. 모르는 최상위 키는 거부되고, 거부된 gate는 결함을 한 번에 모두 알립니다.
- 지시문에 `[ultragoal-red-team]`이 있는 `open-gajae-executor`에는 플러그인이 GJC executor red-team 조각을 덧붙입니다. 표식이 없으면 평소 executor입니다.
- **수정 목표.** blocker가 있는 cohort는 `record_review_blockers`로 한 묶음으로 기록합니다: 목표는 `review_blocked`가 되고, 기본 제목 `Resolve final code-review blockers`와 기준 하나 `<objective> is resolved and re-verified`를 가진 수정 목표가 붙습니다(`objective`는 1972자까지). 같은 blocked 목표에 trim한 objective가 같으면 열린 수정 목표를 돌려주고, 한 blocked 목표의 네 번째 미해결 수정 목표는 거부됩니다(`review_blocker_recursion_cap`). 수정 목표를 완료하면 `review_blocked` 원 목표가 superseded가 되며, 그 gate는 원 목표가 이미 superseded인 관점에서 판정합니다. 그래서 실행을 닫는 수정 목표는 첫 checkpoint부터 final gate가 필요합니다.
- **Terminal critic.** 완료 쪽 `ITERATE`·`REJECT`는 먼저 `record_critic_verdict`로 기록합니다. 비OKAY 판정이 연속 5회이면 — 마지막 OKAY(OKAY 판정, 또는 gate의 `criticReview`가 OKAY인 final checkpoint)와 최근 `create` 뒤부터, 두 종점을 합쳐 셈 — 다음 사용자 프롬프트까지 goal 루프를 보류합니다. gate는 바뀌지 않고 override op도 없습니다.
- **Pause.** 실행이 완료되지 않은 동안 `goal pause`는 거부됩니다. 예외는 최신 `blocker_classified` 이벤트가 `human_blocked`이고, 그 뒤에 `classification_event_id`로 묶인 깨끗한 pause `critic_verdict`(`OKAY`, 증거, blocker 없음)가 있을 때뿐입니다.

**영수증과 실행 완료.** complete checkpoint는 영수증 `completionVerification` — `receiptId`, `receiptKind`(`per-goal` 또는 `final-aggregate`), `criteriaRevision`(활성 기준의 해시), `qualityGateHash`, `checkpointLedgerEventId`, `verifiedAt` — 을 목표와 그 `goal_checkpointed` 이벤트에 씁니다. 영수증은 목표의 영수증이 ledger 이벤트와 같고 활성 기준이 바뀌지 않은 동안 유효합니다. final 영수증은 그 뒤 필수 목표 집합이 바뀌면(`plan_created`, 목표 `add`·`supersede`, `review_blockers_recorded`) 낡은 것이 되고, 그런 final은 per-goal 완료로 셉니다. 실행 완료는 모든 필수 목표가 `complete`이고, 각 영수증이 유효하며, 가장 나중에 완료된 목표가 유효한 final 영수증을 가질 때입니다. 파일 status만 보면 모든 목표가 완료로 보이고 — phase는 `complete`, 행은 사라짐 — 실행은 완료가 아닐 수 있습니다. 그러면 `status`가 `run_complete: no (<이유>)`를 보여 주고 `goal complete`가 거부되며, 마지막 완료 목표를 다시 열어 final gate로 재검증하면 됩니다.

**`goal` 도구**는 GJC goal 모드 도구이며 op는 `get`, `create`(`objective`), `complete`, `resume`, `drop`, `pause`이고 `open-gajae` 전용입니다. goal은 루트의 `state/goal-state.json`에 `{version, id, objective, status(active, paused, complete, dropped), source(ultragoal 또는 user), created_at, updated_at}`로 있습니다. 결과는 GJC 텍스트입니다: `Goal: <objective>`와 `Status: <status>`, 또는 `No active goal.`. 거부 문구도 GJC 것입니다(예: `cannot create a new goal because this session already has a goal`).

- `drop`은 파일을 `status: "dropped"`로 남기고, 이후 모든 op가 goal 없음으로 다룹니다: `get`은 `No active goal.`이고 `resume`은 거부됩니다.
- `complete`와 `pause`는 goal을 찾기 전에 goal 출처와 무관하게 ultragoal 가드를 거칩니다. `complete`는 실행이 완료되지 않은 ultragoal 계획이 있는 동안 거부되고, 영수증 때문이면 거부 문구가 `ultragoal checkpoint(status: "pending")`으로 다시 열 목표를 알려 줍니다. `pause`는 위 pause 조건을 만족하지 않으면 거부됩니다. `drop`에는 가드가 없습니다.
- `ultragoal create`가 goal을 켭니다: 열린 goal이 없으면(없음, complete, dropped) 고정 문구 "Complete the durable ultragoal plan in `.open-gajae/_session-<created>-<id>/ultragoal/goals.json`, including later accepted/appended goals, under the original description constraints; use `.open-gajae/_session-<created>-<id>/ultragoal/ledger.jsonl` as the audit trail."(실제 폴더 이름)로 `source: "ultragoal"` goal을 만듭니다. 출처가 `ultragoal`이거나 trim한 목표 문구가 그 문구와 같은 열린 goal은 그대로 두고, 다른 열린 goal이 있으면 켜지 않고 그 사실을 알립니다. 다른 ultragoal op와 훅은 goal을 바꾸지 않습니다.

**goal 루프.** goal이 활성인 동안 계보 루트의 `session.execution.succeeded`마다 — agent와 무관하게 — 플러그인은 continuation이 이미 진행 중이거나, Esc 뒤이거나, background child가 실행 중이면 건너뛰고, 아니면 GJC continuation 알림을 담은 `<goal-continuation>` 메시지(`resume: true`, TUI 줄 `open-gajae: goal continuation`)를 넣습니다. 반복 상한은 없습니다.

- **보류.** 도구 호출 없는 턴이 연속 3회이거나 critic 비OKAY 연속이 5회이면 루프를 보류합니다. 보류하면 원인과 "메시지를 보내면 이어진다"는 해제 방법을 적은 `<goal-notice>` 하나(`resume: false`, TUI 줄 `open-gajae: goal continuation held (<reason>)`)를 남깁니다. goal은 활성 그대로입니다. 루트에서 다음 실제 사용자 프롬프트가 보류를 풀고 도구 없는 턴 수를 0으로 되돌리며, critic 보류였으면 critic 카운트도 새로 시작합니다. 카운터와 보류는 `state/goal-continuation.json`에 있고, 새 goal이면 처음부터 다시 셉니다.
- **Esc.** reason이 `user`나 `shutdown`인 중단은 다음 실제 사용자 프롬프트까지 루프를 멈추고, 그 턴이 끝나면 다시 잇습니다.
- **Ralplan과 deep-interview.** deep-interview가 보이는 주 skill이고 `interviewing`이나 `handoff`로 활성이면 그 결정이 먼저이고 goal 루프는 건너뜁니다(spec D-TL6의 예외, deep-interview deviation 16). 그 밖에는 goal이 활성인 동안 보류 여부와 상관없이 goal 루프만 그 턴을 결정하고, ralplan continuation은 활성 goal이 없을 때만 돕니다.
- **goal 문맥.** goal이 활성인 동안 루트의 `open-gajae` 요청에는 `<goal-context>` 블록(GJC goal 모드 프롬프트)을 프롬프트 앞에 넣습니다. 요청에 같은 텍스트가 단일 파트 사용자 메시지로 이미 있으면 넣지 않습니다. 이 블록은 `synthetic({ resume: false })` 메시지(TUI 줄 `open-gajae: goal context added`)로도 남습니다. goal마다 한 번이고, 압축으로 빠지면 다시 넣습니다.
- **압축.** ultragoal 행이 `missing`, `failed`, `complete`, `handoff` 밖의 phase로 활성이고 goal이 paused가 아니면, 압축 프롬프트에 `<ultragoal-compaction-context>` 블록을 넣습니다: objective, 기준, 현재 목표, 진행, 다음 행동, Codebase Patterns와 최근 learnings, 그리고 지속 진행이 압축 사이에 바뀌지 않았으면 `STALLED` 줄.

**인계.** `ultragoal handoff(to: "ralplan" | "deep-interview", reason)`, `ralplan handoff(to="ultragoal")`, 같은 execution의 `skill ultragoal` 게이트는 저널 트랜잭션 하나를 함께 씁니다(GJC `state handoff` 동사): 저널을 쓰고, callee를 기존 필드 위에 병합하고(`active: true`, 첫 phase — ralplan은 `run_id`를 유지한 `planner`, deep-interview는 `interviewing` — `handoff_from`, `handoff_at`), caller를 병합하고(`active: false`, `current_phase: "handoff"`, `handoff_to`, `handoff_at`), caller 행은 비활성 `handoff_to` 행으로 남기고, callee 활성 행과 스냅숏을 쓰고, ultragoal이 넘길 때는 `workflow_handoff`와 `HANDOFF` 메모를 붙입니다. 그다음 저널을 committed로 표시하고 지웁니다. goal은 그대로이므로 계획하는 동안에도 goal 루프가 계속 재촉합니다. ultragoal이 보이는 주 skill인 동안 `skill` `ralplan`이나 `deep-interview`를 불러오면 `ultragoal handoff` 안내와 함께 거부됩니다. ralplan 승인 뒤 ultragoal은 `goal-planning`으로 돌아오고 `create`가 목표 목록을 새로 씁니다. ledger와 `progress.txt`는 기록을 유지합니다.

### 알려진 동작

GJC와 같거나 관리자가 수용한 동작입니다. 기록만 하며 바꿀 일정은 없습니다.

| 동작 | 근거 | 대응 |
|---|---|---|
| `ultragoal handoff` 뒤 재계산 op를 하나라도 부르면 `goals.json`으로 ultragoal이 다시 활성이 되고 ralplan 행이 지워집니다. | GJC 재계산(spec D-SF1) | 계획하는 동안 ultragoal op를 부르지 않습니다. 돌아올 때는 `ralplan handoff(to="ultragoal")`를 씁니다. |
| `create` 전의 `status`나 `classify_blocker`는 `goal-planning`을 끝냅니다(`missing`, 또는 이전 계획의 status로). `add_pattern`, `validate_gate`, `doctor`는 끝내지 않습니다. | GJC 재계산 대상, `add_pattern`은 재계산하지 않음(PQ-25 B) | skill 안내대로 `create`를 먼저 부릅니다. |
| `clear`는 goal을 열어 둡니다. | GJC `state clear`(plan I-10) | 결과의 `goal drop` 줄대로 실행이 끝나면 drop합니다. |
| `failed` phase인 실행은 `force` 없는 `clear`가 거부됩니다. | GJC `handleClear`(DR-14) | `clear(force: true)`를 씁니다. |
| goal 문맥 메시지는 goal이 끝난 뒤에도 transcript에 남고, 기본 `steer` 전달 때문에 모델 한 단계가 더 돌 수 있습니다. | 호스트 synthetic 전달, 호스트 Plan 알림과 같음(R12) | 없음. |
| `/compact` 뒤에는 보류된 루프의 `<goal-notice>`가 전달되고, `resume: false`로 남겼는데도 호스트가 모델을 한두 단계 돌립니다. 보류 자체는 유지되며 사용자 메시지 전까지 continuation은 없습니다. | 호스트 synthetic 전달 | 메시지를 보내면 이어집니다. |
| goal 루프는 agent를 확인하지 않고 상한도 없습니다. 세션을 `build` 같은 다른 agent로 바꾸면 continuation이 계속 들어오는데, 그 agent는 `goal`·`ultragoal`을 볼 수 없고 다른 도구 호출은 도구 진행으로 셉니다. 끝내는 방법은 Esc(다음 프롬프트까지), 도구 없는 턴 3회 보류, `open-gajae`로 돌아가 `goal drop`뿐입니다. | GJC 경로 A(PQ-20 A, 후속 U27) | `open-gajae`로 돌아가 `goal drop`합니다. |
| ralplan → ultragoal의 같은 턴 인계는 execution 하나 안에서만 일어납니다. continuation이나 background subagent 완료가 연 execution에서 `skill ultragoal`을 부르면 인계 없이 진입하고 ralplan은 `active: true`로 남지만, 주 skill이 아니므로 재촉은 없습니다. | GJC 턴 표식(PQ-21 A, PQ-7 B) | `final` 뒤에는 `ralplan handoff(to="ultragoal")`를 먼저 부릅니다. |
| 넘겨받은 ralplan은 옛 run을 이어 씁니다: 옛 final 승인과 iteration 예산이 이어지고, 같은 `stage_n`에 다른 내용을 쓰면 거부됩니다. | GJC `persistActiveRunId`(PQ-4 A, 후속 U13) | 쓰지 않은 다음 `stage_n`을 쓰거나 첫 `write`에 새 `run_id`를 줍니다. |
| 수정의 수정 사슬에서 상한 3은 사슬을 막지 못하고, 사슬의 원 목표는 `review_blocked`로 남습니다. | GJC 한 단계 supersede(PQ-23 A) | 마지막 수정 목표를 완료하기 전에 남은 `review_blocked` 목표를 supersede합니다. 늦었으면 그 목표를 다시 엽니다. |
| 완료 목표는 바꿀 수 없고, 작업 중이거나 실패한 목표를 바꾸려면 `checkpoint(pending)`, 수정, `next`를 거칩니다. | GJC steering 상태(PQ-14 (1) B′, PQ-26 A, spec E1) | `checkpoint(status: "pending")`으로 다시 엽니다. |
| 마지막 완료 목표에 유효한 final 영수증이 없으면(늦은 supersede, 수정 사슬 끝) phase와 행은 `complete`로 보이고 체인 가드도 풀리지만 `goal complete`는 거부됩니다. | GJC는 파일 status를 셈(plan C-7 (라)) | `run_complete: no`와 재오픈 hint를 따릅니다. |
| 목표 추가로 낡은 final 영수증은 per-goal 완료로 세고, 새 마지막 목표가 자기 final 영수증을 받아야 합니다. | GJC 결과(PQ-14 (3)-b, spec E2) | 없음. |
| `after`로 목표를 맨 앞에 둘 수 없습니다. | 계획 변경 op(IQ-1 B) | 목표를 추가한 뒤 `G001`을 그 뒤로 옮깁니다(호출 2번). |
| 다시 연 목표는 `status`에 옛 영수증 상태를 계속 보여 주며, 다시 완료되어야 셉니다. | GJC는 재오픈 때 영수증을 유지(IQ-2 A) | 없음. |
| 스키마에 맞지 않는 `goal-state.json`은 goal 없음으로 읽고, 다음 `create`가 덮어씁니다. | GJC `normalizeGoal` | 없음. |
| `goals.json`이 없으면 `goal complete`는 허용됩니다(실행 없음). `goal pause`는 `ultragoal/` 폴더가 있는데 `goals.json`이 없을 때만 거부됩니다. | GJC `gjc-runtime/ultragoal-guard.ts:569,703-711` | 없음. |

## 자체 역할과 설정

- **`open-gajae`**: primary입니다. 수정, 결정, 통합, workflow 도구를 소유합니다. host 기본값 외에 추가 rule은 없습니다.
- **`open-gajae-explore`**: repository 사실을 읽기 전용으로 조사합니다. edit, delegation(`subagent`), question, workflow 도구를 쓸 수 없습니다. `shell`은 전체 허용됩니다(OMC parity — 어떤 역할에도 `shell`/Bash rule을 추가하지 않습니다).
- **`open-gajae-document-specialist`**: 문서와 인용 근거를 조사합니다. edit, delegation, question, workflow 도구를 쓸 수 없습니다. `chub` 절차는 프롬프트에서 읽기 전용으로 문서화되어 있으며, host permission rule이 `shell`을 `chub` 명령으로 제한하지는 않습니다.
- **`open-gajae-planner`**, **`open-gajae-architect`**, **`open-gajae-critic`**: ralplan 합의 역할입니다. 세 역할 모두 `mode: subagent`이고 기본 모델은 없으며 설정의 `agents` 맵으로만 지정합니다. 프롬프트는 GJC의 planner·architect·critic 역할에 host 치환을 적용한 것입니다. 세 역할 모두 편집할 수 없습니다: 각자 단계 산출물을 `ralplan write`(`content`만)로 기록하고 `ralplan status`와 `ralplan state`를 쓸 수 있으며, `edit`와 `question`, `deep-interview`는 거부됩니다. architect와 critic은 `subagent`도 거부됩니다. planner는 조사를 위임합니다: `subagent` 권한은 `open-gajae-explore`와 `open-gajae-document-specialist`만 허용합니다. `question`, `deep-interview`, 그리고 Code Mode의 두 세션 도구(`opencode_session_move`, `opencode_session_rename`)는 여덟 subagent 역할 모두에서 거부됩니다. `subagent_depth`는 플러그인이 올리지 않습니다. host 설정에 `experimental.subagent_depth: 2`를 직접 넣으세요(설치 참고).
- **`open-gajae-executor`**(OMC `agents/executor.md` 이식): `ultragoal` 리더가 맡긴 범위가 정해진 코드 변경을 구현하고, 지시문에 `[ultragoal-red-team]`이 있으면 경계 cohort의 QA/red-team 레인을 맡습니다(그때 플러그인이 GJC red-team 조각을 덧붙임). `question`이 거부되어 사용자에게 물을 수 없고 `ultragoal`·`goal` 도구도 쓸 수 없습니다. delegation은 코드베이스 조사용 `open-gajae-explore`와, 같은 문제를 반복 실패했을 때의 `open-gajae-architect`로만 제한됩니다. `edit`과 `shell`은 유지합니다.
- **`open-gajae-cleaner`**: ultragoal 경계 리뷰 cohort의 읽기 전용 cleaner 레인입니다. 프롬프트는 GJC ultragoal의 `ai-slop-cleaner` 조각이며, 이전 OMC 기반 cleaner 프롬프트의 읽기 전용 문장 몇 개를 유지합니다. edit·write·patch·delegation·question·workflow 도구가 모두 거부됩니다. `shell`은 점검용으로 유지하며, blocking·advisory 항목을 `Gate Result: PASS` 또는 `BLOCKED`로 끝나는 `AI SLOP CLEANUP REPORT`로 보고할 뿐 아무것도 바꾸지 않습니다.
- **`open-gajae-lateral-reviewer`**: deep-interview 측면 리뷰 패널의 페르소나(researcher, contrarian, simplifier, architect)를 여럿 병렬로 돌립니다. 짧은 프롬프트에 출력 계약이 없고, 호출마다 JSON 객체를 요구하는 패널 조각을 받습니다. 기본 읽기 전용 역할 규칙(`edit`, `subagent`, `question`, workflow 도구 거부; 다른 모든 역할처럼 `shell`은 제한하지 않음)을 따르며 기본 모델은 없습니다(deep-interview deviation 37).
- `ultragoal`, `goal`, `deep-interview`는 `open-gajae` 전용입니다. 모든 자체 역할에서 이 도구들이 거부되고, 플러그인이 다른 모든 agent에게서 숨깁니다. ultragoal 안에서 `open-gajae-architect`는 목표마다의 리뷰와 cohort의 고정된 변경 집합 리뷰를, `open-gajae-critic`은 terminal critic을 맡습니다. 둘 다 판정을 응답으로 돌려주고, primary가 quality gate(`architectReview`, `reviewCohort`, `criticReview`)나 `ultragoal record_critic_verdict`로 기록합니다.

역할 rule은 각 agent의 `permissions` 배열에 host 기본값 뒤에 추가되지만, **여러분의 host `agents.<id>` permission rule은 플러그인 것보다 뒤에 적용되어 우선합니다** — v1이 순서를 바꿔 mandatory deny를 지켰던 것과 달리, host override가 역할의 기본 deny를 완화할 수 있습니다(기록된 deviation: "user config wins"). 설정은 `~/.open-gajae/open-gajae.jsonc`와 `<worktree>/.open-gajae/open-gajae.jsonc`에서 읽습니다. field는 project → user → defaults 순으로 병합됩니다. 알 수 없는 key, 잘못된 JSONC, 잘못된 값은 진단과 함께 실패합니다.

`deepInterview.ambiguityThreshold`는 deep-interview의 모호도 기준치로, GJC 기본값 `0.05`이고 `(0, 1]`입니다. deep-interview의 유일한 설정입니다. 주 에이전트는 정해진 값과 출처(`~/.open-gajae/open-gajae.jsonc`, `./.open-gajae/open-gajae.jsonc`, `default`)를 `<open-gajae-runtime-settings>` 블록으로 받습니다. 출처는 홈 경로를 줄여 써서 프롬프트에 사용자 이름이 들어가지 않습니다. 없앤 라운드 상한 key가 남은 설정 파일은 unknown setting으로 로드에 실패합니다. 그 key를 지우세요.

```jsonc
{
  "deepInterview": { "ambiguityThreshold": 0.05 },
  "agents": {
    "open-gajae": { "model": "provider/model", "variant": "variant-name" },
    "open-gajae-planner": { "model": "openai/gpt-6-luna" },
    "open-gajae-architect": { "model": "openai/gpt-6-luna", "variant": "high" },
    "open-gajae-critic": { "model": "openai/gpt-6-luna", "variant": "high" },
    "open-gajae-executor": { "model": "openai/gpt-6-luna", "variant": "medium" },
    "open-gajae-cleaner": { "model": "openai/gpt-6-luna", "variant": "medium" },
    "open-gajae-lateral-reviewer": { "model": "openai/gpt-6-luna", "variant": "medium" }
  },
  "ralplan": { "maxIterations": 5, "maxReviewPassesPerLane": 1, "autoHandoff": "off" }
}
```

`ultragoal` 설정은 없습니다. `ultragoal` key가 남은 설정 파일은 `<file>.ultragoal: unknown setting`으로 로드에 실패합니다. 그 key를 지우세요. goal 루프에는 반복 상한이 없습니다([Ultragoal](#ultragoal) 참고).

| 설정 | 기본값 | 의미 |
|---|---|---|
| `deepInterview.ambiguityThreshold` | `0.05` | 인터뷰의 모호도 기준치, `(0, 1]`. `deep-interview start(threshold)`가 인터뷰 하나에 대해 덮습니다 |
| `ralplan.maxIterations` | `5` | 한 run이 열 수 있는 planner·revision 회차, `1..20` 정수 |
| `ralplan.maxReviewPassesPerLane` | `1` | 열린 회차당 architect 또는 critic 기록 수, `1..10` 정수 |
| `ralplan.autoHandoff` | `"off"` | `"ultragoal"`이면 막히지 않은 `final`을 승인 질문 없이 ultragoal에 인계 |

`ralplan` key도 다른 field처럼 key별로 병합되며, 플러그인이 location에서 setup될 때 한 번만 해석됩니다. 바꾼 뒤에는 host를 재시작하세요. `final` 영수증의 `auto_handoff.source`는 `autoHandoff` 값이 이긴 파일 경로 또는 `default`입니다.

`variant`는 같은(이미 병합된) entry에 `model`이 있어야 합니다: user 레벨 `model` + project 레벨 `variant`는 유효하지만, `variant`만 있거나(한 파일에서든 양쪽에 나뉘어서든) 어디에도 `model`이 없으면 agent 이름과 `model "provider/model"` 추가 요청을 담은 오류로 거부됩니다. 이는 그런 variant를 진단만 남기고 조용히 버리는 v2 host보다 더 엄격합니다. provider fallback, tier mapping, 인위적 collision 거부는 없습니다.

## 읽기 전용 코드 도구

플러그인은 읽기 전용 코드 도구 8개를 등록합니다(위의 `deep-interview`·`ralplan`·`ultragoal`·`goal` 도구를 더하면 총 12개).

- `ast_grep_search` (`@ast-grep/napi` 0.31.1): AST 검색만 하며 replace는 없습니다.
- `lsp_goto_definition`, `lsp_hover`, `lsp_diagnostics`, `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_servers`.

LSP server는 감지·보고만 하며 자동 다운로드하지 않습니다. LSP rename, code action, replacement suite는 없습니다. 사용 가능한 actor는 아홉 개 자체 역할 전체입니다 — `open-gajae`, `open-gajae-explore`, `open-gajae-document-specialist`, `open-gajae-planner`, `open-gajae-architect`, `open-gajae-critic`, `open-gajae-executor`, `open-gajae-cleaner`, `open-gajae-lateral-reviewer` — OMC와 동일하게 모든 agent가 읽기 전용 LSP/AST 도구를 사용할 수 있습니다. project 경계는 v1의 call마다 host permission을 묻던 방식을 대체합니다: input 경로를 host의 현재 location 디렉터리 기준으로 해석하고, symlink를 따라가며, 실제 대상이 실제 project 디렉터리 안에 있어야 합니다. `.env`와 `.env.*` 파일은 요청한 이름과 해석된 이름 양쪽에서 거부되며, `ast_grep_search`는 traversal 중에도 건너뜁니다. 두 도구 모두 explorer 권한을 넓히거나 arbitrary shell 실행을 허용하지 않습니다.

source에서 실제 도달하는 제품 환경 변수는 `OPEN_GAJAE_LSP_TIMEOUT_MS`, `OPEN_GAJAE_LSP_IDLE_TIMEOUT_MS`, `OPEN_GAJAE_LSP_IDLE_CHECK_INTERVAL_MS`, `OPEN_GAJAE_LSP_CONTAINER_ID`, `OPEN_GAJAE_PYTHON_LSP=basedpyright`뿐입니다. 일반 설정이 아니라 LSP 구현 설정입니다.

## OMC와 v1 플러그인으로부터의 deviation

아래 표는 OMC 기반 워크플로·역할 또는 그 이전 v1 구현에서 호스트 요구로 바뀐 항목을 기록합니다(AGENTS.md 정책). 이 항목들은 이식의 spec/plan(`.omc/specs/deep-interview-opencode-v2-port.md`, `.omc/plans/ralplan-opencode-v2-port.md`)의 결정으로 추적됩니다. GJC 기반 메인 에이전트 프롬프트는 별도 이식이며([third-party notices](THIRD-PARTY-NOTICES.md) 참고), OMC 기반 ralplan skill·역할 프롬프트·state 시딩을 대체한 GJC 기반 `ralplan`도 별도 이식이며([GJC로부터의 deviation (ralplan)](#gjc로부터의-deviation-ralplan) 참고), 진행 기록 형식을 뺀 OMC ralph 이식을 대체한 GJC 기반 `ultragoal`·`goal`도 별도 이식입니다([GJC로부터의 deviation (ultragoal)](#gjc로부터의-deviation-ultragoal) 참고).

| Deviation | 내용 |
|---|---|
| 슬래시 커맨드 없음 | v1의 `/deep-interview`와 `/ralplan`이 사라졌습니다. 명시적 자연어 요청 또는 지원되는 skill mention·키워드로 요청한 skill에 진입하며, heuristic 추천은 사용자의 선택이 필요합니다. |
| `subagent_depth`는 host 설정 | v2 플러그인 API에는 config를 수정하는 domain이 없어 v1처럼 플러그인이 직접 올릴 수 없습니다. `experimental.subagent_depth: 2`를 직접 넣으세요. 값이 없으면 planner가 직접 조사로 fallback합니다. |
| host 설정이 역할 rule보다 우선 | host `agents.<id>` permission rule이 플러그인 것보다 뒤에 적용되어, v1의 rule 재정렬 트릭과 달리 역할의 기본 deny를 완화할 수 있습니다. |
| explore·document-specialist는 shell 전체 허용 | OMC parity: 어떤 역할에도 `shell`/Bash permission rule을 추가하지 않습니다. |
| "Bash"를 `shell`로 표기 | 모든 prompt와 skill이 "Bash" 대신 v2 도구 이름 `shell`을 씁니다. |
| 철회: deep-interview → ralplan bridge가 input field 대신 skill을 이름으로 지칭 | deep-interview 개정이 OMC 기반 bridge를 대체했습니다. 이제 deep-interview는 `deep-interview handoff(to)`(또는 결합 호출 `spec(…, handoff: "ralplan")`)로 넘긴 뒤 `skill` `ralplan`을 불러옵니다([GJC로부터의 deviation (deep-interview)](#gjc로부터의-deviation-deep-interview) 참고). |
| 안내는 실패했을 때만 prompt 텍스트에 덧붙임 | 안내는 state 우선으로 쓴 뒤 `synthetic` 메시지로 보냅니다. `synthetic` 자체가 거부되면 (marker로 감싼) 안내를 prompt 텍스트에 덧붙여 사라지지 않게 합니다. |
| 안내가 user 메시지 앞에 옴 | host는 `synthetic` 안내를 같은 턴의 user 메시지 앞에 배치합니다. OMC/v1은 뒤에 덧붙였습니다. 설계 선택이 아니라 host 배치 사실입니다. |
| 삽입 메시지의 TUI 표시 | TUI는 `description`이 없는 `synthetic` 메시지를 표시하지 않습니다. 플러그인이 넣는 모든 안내와 continuation에 한 줄 설명(예: `open-gajae: ralplan keyword notice added`, `open-gajae: ralplan continuation 1/30`)을 붙여 사용자가 삽입 사실을 볼 수 있게 합니다. 본문은 OMC처럼 모델에게만 전달됩니다. |
| 빌드 없는 TS 소스 패키징 | 루트 `index.ts`와 `package.json`의 `exports["."]`가 `./src/index.ts`를 가리킵니다. `dist/`와 build script는 사라졌습니다. |
| `model` 없는 `variant`는 설정 오류 | user+project 병합 뒤 agent 이름을 담은 오류로 거부됩니다 — variant를 진단만 남기고 조용히 버리는 v2 host보다 엄격합니다. |
| continuation이 durable execution 이벤트에서 동작 | `session.execution.succeeded`가 v2에서 발행하지 않는 `session.idle`을 대체합니다. |
| continuation이 background subagent를 기다림 | `background: true`로 실행 중인 child 세션이 있으면 `parentID`와 execution 이벤트로 추적해 건너뜁니다(OMC/OMO parity; v1에는 대응 사례가 없었습니다). |
| interrupt 처리가 reason 기반 | `user`와 `shutdown`은 다음 실제 프롬프트만 지우는 stop mark를 설정하고, `inactivity`/`superseded`는 설정하지 않습니다. background child 완료 뒤 host가 유발한 재개는 같은 breaker로 다른 `succeeded`와 동일하게 판단됩니다. |
| location별 이벤트 필터링 | v2 플러그인 인스턴스는 location마다 만들어지지만 공유 서버가 모든 인스턴스에 모든 이벤트를 전달하므로, 이 플러그인은 자기 location과 일치하는 세션에만 동작합니다. v2에서 새로 생긴 사실이며 R-decision을 바꾸지 않습니다. |
| artifact guard가 throw 대신 input 무효화로 차단 | `execute.before`가 차단할 호출의 input을 `{}`로 바꿔 host의 decode 자체를 실패시키고, `execute.after`가 그 오류를 모델이 이해할 안내로 다시 씁니다. ralplan 계획 가드, ultragoal goal-planning 가드, deep-interview 편집 가드, 항상 차단되는 `plans/ralplan/**`·`specs/deep-interview-*`·`state/**` 경로, `skill` 턴 게이트와 체인 가드의 skill 로드 거부도 같은 방식입니다. Promise-hook throw는 대신 host defect로 나타났을 것입니다. |
| code-tool 경계가 host ask 대신 realpath containment | host의 현재 location 기준으로 해석하고, symlink를 따라가며, 실제 project 디렉터리 안에 있어야 하고, `.env`/`.env.*`를 제외합니다 — v1의 call마다 permission을 묻던 방식을 대체합니다. |
| LSP surface가 도구 4개에서 7개로 확장 | `lsp_find_references`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_servers`에 `lsp_goto_definition`, `lsp_hover`, `lsp_diagnostics`가 추가되었습니다. |
| `@deep-interview` mention도 magic notice를 받음 | OMC parity입니다. v1은 명시적 호출에서 안내를 억제했습니다. |
| `@ralplan` mention도 안내를 받음 | mention 안내는 skill이 이미 붙었음을 알립니다. 키워드 안내처럼 ralplan state를 쓰지 않으며, run은 `ralplan start`에서 시작합니다. OMC도 명시적 호출에 안내를 붙이며, 문구는 host 추가분입니다. 사용자가 모든 삽입을 볼 수 있도록 추가했습니다. |
| 안내는 `open-gajae` primary에만 | 키워드·mention 안내(ralplan, deep-interview, ultragoal)를 호스트 `build`·`general`과 사용자 정의 agent를 포함한 다른 모든 agent에는 주지 않습니다. `deep-interview`·`ralplan`·`ultragoal`·`goal` 도구가 그 agent들에게 숨겨지고 거부되기 때문입니다(R-OD20). OMC는 모든 agent에 주입합니다. 그런 프롬프트도 중단 표시는 풀고, 계보 루트에서는 goal 루프 보류도 풉니다. agent가 없는 세션이나 agent 조회 실패는 계속 안내를 받습니다. continuation은 agent를 확인하지 않습니다(R-OD21, 기록만). ralplan이나 goal이 활성인 세션을 사용자가 다른 agent로 바꾸면 그 agent의 턴에 continuation이 주입될 수 있고, 그 agent는 도구를 쓸 수 없습니다. ralplan continuation은 breaker에서 멈추지만, goal 루프는 상한이 없어 Esc, 보류, `open-gajae`에서의 `goal drop`으로만 끝납니다([Ultragoal](#ultragoal) 알려진 동작 참고). |
| ralplan restore 안내 제거 | OMC 유래 `[RALPLAN MODE RESTORED]` 안내, 그 prompt hook 분기, `restored_at` 기록을 삭제했습니다. seed가 `started_at`과 `restored_at`을 같게 기록해 정상 흐름에서는 발동하지 않았고, GJC에는 이런 안내가 없으며, 문맥 손실은 압축 복구(`<ralplan-compaction-context>`)가 담당합니다. 재개한 세션에 ralplan 안내는 없고, ultragoal restore banner도 삭제했습니다(도달할 수 없었고 GJC에도 없음). |
| 설치 문서가 디렉터리 plugin 형태만 보여줌 | 일부 host 문서는 파일 경로 `plugins` 예시를 보여주지만, v2 host는 실제로는 파일 경로로 설정된 plugin 항목을 건너뜁니다. |

## GJC로부터의 deviation (ralplan)

출처: GJC v0.17.7 커밋 `5c5231418930673e42cc5d08ebe4376e03187533`(MIT). ralplan skill, 세 합의 역할 프롬프트, `src/ralplan-runtime/`은 아래 행이 달리 적지 않는 한 GJC ralplan 계약을 따릅니다(AGENTS.md 정책: 출처, deviation, 이유, 영향). GJC 경로는 `gajae-code/packages/coding-agent/src/` 기준이며 `SKILL.md`는 `defaults/gjc/skills/ralplan/SKILL.md`입니다. OpenCode 경로는 `opencode/packages/` 기준입니다. 결정 ID(`D-…`, `DR-…`, `R-…`)는 이식의 spec과 plan(`.omc/specs/deep-interview-ralplan-gjc-stage-trail.md`, `.omc/plans/ralplan-gjc-stage-trail.md`)을 가리킵니다. 행 번호는 skill과 프롬프트의 source 섹션이 인용하는 plan 번호를 그대로 씁니다. 18행은 `stage` 칩이 GJC를 따르게 되어(행에는 방금 쓴 단계를 기록하고, 잠긴 state phase가 있으면 표시할 때 그것으로 바꿈) 철회했고, 16행(`cli.json`에 등록하는 별도 `tui-plugin/` 디렉터리 사이드바)은 사이드바 보류와 함께 철회했습니다(R-OD17). 두 번호 모두 다시 쓰지 않습니다. ultragoal 개정(`.omc/plans/ralplan-ultragoal-gjc-revision.md` §7.2, 결정 ID `PQ-…`는 `.omc/plans/ultragoal-gjc-pq-decisions.md`)은 15·19·24·25·27·28·29행을 철회했고 이 행들은 이유와 함께 아래에 남깁니다. 10·13·14·37행은 고쳤습니다. 철회한 번호도 다시 쓰지 않습니다. deep-interview 개정(`.omc/plans/ralplan-deep-interview-gjc-revision.md` §7.2)은 14행을 철회하고, 10·11·34·37행을 고치고, 39행을 더했습니다.

| # | Deviation | GJC 출처 | 이유 | 영향 |
|---|---|---|---|---|
| 1 | CLI 명령(`gjc ralplan`, `gjc state ralplan`)이 `ralplan` 도구 op가 되고, flag는 입력이 되며, exit code 3과 2는 `PLANNING-STUCK` 결과와 오류가 됩니다. | `gjc-runtime/ralplan-runtime.ts:2483-2496`, `gjc-runtime/state-runtime.ts` | OpenCode 플러그인 host이며 GJC CLI가 없음 | 동사는 1:1로 대응. `state` op에는 `state write`의 flag 두 개가 없음(편차 38) |
| 2 | 산출물 본문을 bash 환경 변수로 넘기지 않습니다: 역할은 `content`, primary는 `content` 또는 OS 임시 `path`. | `SKILL.md:44-51`, `gjc-runtime/restricted-role-agent-bash.ts`, `tools/bash.ts:1331-1351` | OpenCode shell에는 GJC의 `env` 산출물 기능이 없음 | 역할용 제한 shell이 필요 없음. 역할에는 GJC처럼 파일 경로 입력이 없음 |
| 3 | 저장 루트 `.gjc/_session-<id>` → `.open-gajae/_session-<created>-<id>`. | `gjc-runtime/session-layout.ts:71-78` | 기존 세션 폴더 규칙(`src/state.ts`) | 경로만 다름 |
| 4 | 설정이 `.gjc/config.yml`에서 `open-gajae.jsonc` `ralplan.*`로 옮겨지고, write마다가 아니라 플러그인 setup 때 한 번 해석됩니다(DR-13). | `SKILL.md:134-161`, `gjc-runtime/ralplan-runtime.ts:414-437` | 기존 설정 파일과 로더(`src/index.ts`) | key·범위·project 우선 순위는 같음. 변경은 host 재시작 후 반영. `source`는 이긴 파일 경로를 읽은 그대로 보여주며, GJC는 정규(realpath) 경로를 보고함 |
| 5 | 역할 세션 ID flag(`--planner-id` 등)를 자동 기록으로 대체하고, 역할별 `--*-resumable` flag를 `resumable` 입력 하나로 대체합니다. | `SKILL.md:201-209`, `gjc-runtime/ralplan-runtime.ts:1113-1208` | host가 `context.sessionID`를 제공 | ID 전달 실수가 없어짐 |
| 6 | `autoresearch` 자동 인계 대상 없음. | `gjc-runtime/ralplan-runtime.ts:103-112` | autoresearch skill이 없음 | `autoHandoff`는 `off` 또는 `ultragoal` |
| 7 | `--architect/--critic openai-code` 없음. | `gjc-runtime/ralplan-runtime.ts:614-615` | 역할 모델은 `agents` 설정으로 지정 | run별로 리뷰어 모델을 바꿀 수 없음 |
| 8 | 승인 질문에 `workflowGate` 표식 없음. | `SKILL.md:110` | OpenCode `question`에 해당 필드가 없고(`core/src/tool/plugin/question.ts:23-25`) 시간초과 자동 선택도 없음 | 원격 workflow-gate 이벤트 없음 |
| 9 | HUD 칩은 활성 행과 스냅숏에 기록되지만 그려지지 않으며, `stages` 칩은 단계 전체 이름을 씁니다. | `skill-state/workflow-hud.ts:188-245`, `gjc-runtime/ledger-event-renderer.ts:156-166`, `modes/components/skill-hud/render.ts:43-64` | host UI 차이: TUI 사이드바 보류(R-OD17). 단계 이름은 관리자 선택 | TUI에 ralplan 진행 표시 없음. `stages` 칩은 여섯 단어가 칩 값 80자 제한을 넘으면 더 적은 단어를 보이며 단어를 자르지 않음 |
| 10 | OMC continuation을 유지합니다. ralplan이 보이는 주 skill(활성 행 기준, PQ-7 B)이고 활성 goal이 없을 때만 동작하며(활성 goal이면 goal 루프만 동작, ultragoal spec D-TL6), 종료 phase·`PLANNING-STUCK`·`active: false`에서 멈춥니다. deep-interview가 보이는 주 skill이고 `interviewing`이나 `handoff`로 활성이면 그 결정이 먼저이고, 그때는 goal·ralplan continuation이 돌지 않습니다(deep-interview deviation 16). | GJC 자체 TUI 세션에는 ralplan continuation이 없고, Stop 훅 검사로 deep-interview만 자동 재개합니다(`session/agent-session.ts:21140-21168`). 대신 GJC의 Codex 네이티브 Stop 훅은 ralplan이 활성인 동안 `final`·`handoff`에서도 종료를 막고, ralplan이 강등되거나 clear될 때 풉니다(`hooks/skill-state.ts:663-691,878-977`, `hooks/native-skill-hook.ts:385-395`). | 관리자 선택. 행 조건은 PQ-7 B | 멈춘 계획 턴이 breaker 한도 안에서 자동 재개. GJC 네이티브 Stop 훅과 달리 `final`·`handoff`는 붙잡지 않으므로, `final`을 쓰고 승인 질문 없이 턴을 끝낸 모델은 그대로 멈춤. 주 skill이 아닌 동안 `active: true`로 남은 ralplan(ultragoal 실행 중, 또는 다른 execution의 ultragoal 진입 뒤)은 재촉을 받지 않음 |
| 11 | 계획 가드가 `shell`의 변경 명령을 판별하지 않습니다. deep-interview 편집 가드도 같습니다(deep-interview deviation 14). | `skill-state/workflow-mutation-guard.ts:1475-1610` | 명령 판별의 비용과 정확도 | 계획 중 `shell`을 통한 수정은 프롬프트로만 억제 |
| 12 | `repository_binding`은 가능한 값만 기록하고 강제하지 않습니다. | `gjc-runtime/ralplan-runtime.ts:905-978` | 플러그인이 경로를 직접 해석 | 다른 worktree에서의 쓰기를 거부하지 않음 |
| 13 | `doctor`에 checksum·orphan journal 점검이 없습니다. | `gjc-runtime/state-runtime.ts:317,466-500` | checksum이 없음. 인계 저널(`state/transactions/`)은 증거용이라 읽거나 재생하거나 되돌리는 코드가 없고, GJC doctor도 pending 저널을 보고하지 않음(`:482-500`, ultragoal plan I-19) | 점검 항목 축소. 중단된 인계가 남긴 저널은 보고되지 않음 |
| 14 | deep-interview 개정으로 철회: deep-interview가 넘겨받을 때도 자기 행을 씁니다(deep-interview deviations 12, 13). | — | — | — |
| 15 | ultragoal 개정으로 철회: ultragoal에는 이제 리뷰어 brief가 없고, skill이 GJC 역할 프롬프트를 그대로 씁니다(ultragoal deviation 13). | — | — | — |
| 17 | state 봉투에 GJC `receipt`·checksum·`state_revision`이 없고 StateStore `_meta`를 유지합니다. 활성 행의 `source_state_revision`, 스냅숏의 `state_revision`, GJC revision·stale-skip 로직도 생략합니다(R-OD6). | `gjc-runtime/state-writer.ts:1003-1067`, `skill-state/workflow-state-contract.ts:23-40`; revision `gjc-runtime/state-writer.ts:446-472,852-857,1354-1360`, `skill-state/active-state.ts:85,858,943` | 13과 같은 이유와 StateStore 소유자 검사. ralplan 쓰기는 모두 한 프로세스의 소유 세션 큐 하나를 거치므로 순서가 뒤바뀌지 않음(여러 프로세스는 알려진 한계) | state·행·스냅숏 key 일부가 다름(형식 호환 범위 밖). `doctor`의 `stale_active_state`는 revision이 아니라 phase와 active 플래그를 비교하므로 영향 없음 |
| 19 | ultragoal 개정으로 철회(PQ-6 A): 공통 인계가 GJC처럼 caller 행을 비활성 `handoff_to` 행으로 남깁니다. | — | — | — |
| 20 | 압축 복구 텍스트에 `Intent Reconciliation:` 줄을 추가하고(DR-14), ultragoal 압축 문맥처럼 한 줄 머리말을 붙인 `<ralplan-compaction-context>` 블록 하나로 넣습니다. | `session/agent-session.ts:667-710` | spec AC19; host 압축 hook은 marker로 감싼 system 텍스트를 받음 | 복구 문맥이 약간 길어짐 |
| 21 | 감사 `owner` 값은 `open-gajae-runtime`과 `open-gajae-hook`입니다. | `gjc-runtime/state-writer.ts:517-532` | host 이름 | 필드는 같고 값만 다름 |
| 22 | SKILL 9단계의 state 쓰기 + skill 도구 인계가 `ralplan handoff` op 하나가 됩니다(DR-12). | `SKILL.md:118-124`, `tools/skill.ts:200-218` | GJC 자신의 전환 규칙표가 `final`에서의 그 state 쓰기를 거부함(`gjc-runtime/workflow-manifest.ts:241-265`, `gjc-runtime/state-runtime.ts:1335-1341`) | 인계가 op 호출 1회 |
| 23 | 계획 가드가 소유 세션 계보 전체에 적용됩니다(DR-10). | `skill-state/workflow-mutation-guard.ts:325-351` | 역할이 같은 host 프로세스의 하위 세션 | 계획 중에는 executor 등 다른 agent도 차단 |
| 24 | ultragoal 개정으로 철회(PQ-4 A, PQ-6 A): `ultragoal handoff(to="ralplan")`는 GJC의 저널·필드 보존 병합이며 `ralplan start`를 실행하지 않습니다. 넘겨받은 run은 `run_id`를 유지합니다. | — | — | — |
| 25 | ultragoal 개정으로 철회(PQ-6 A): 공통 인계가 callee state를 GJC `state handoff` 동사처럼 씁니다. | — | — | — |
| 26 | OMC continuation 카운터를 훅 전용 `state/ralplan-continuation.json`에 둡니다(R-O3). | (GJC에 없음) | GJC state 봉투에 생명주기 필드를 넣지 않음 | 파일 1개 추가. breaker 소진만 state와 감사 로그에 남음 |
| 27 | ultragoal 개정으로 철회: ultragoal skill도 이제 ralplan skill처럼 승인 선택지를 **Approve execution via ultragoal**로 부릅니다. | — | — | — |
| 28 | ultragoal 개정으로 철회(ultragoal spec D-HE5): ultragoal이 활성 행을 쓰므로 계획 가드가 GJC의 주 skill 규칙을 씁니다. | — | — | — |
| 29 | ultragoal 개정으로 철회(ultragoal spec D-HE6, PQ-21 A): ralplan → ultragoal 게이트가 GJC 턴 표식, 즉 현재 execution에서 불러온 skill을 따릅니다. | — | — | — |
| 30 | primary의 `path` 입력은 OS 임시 루트로 한정합니다(DR-11). | `SKILL.md:49`(`.gjc/` 밖에 준비한 artifact 경로). 런타임은 바인딩된 worktree 안 파일만 받고(`gjc-runtime/ralplan-runtime.ts:2053-2070` → `gjc-runtime/repository-binding.ts:187-201`), `--worktree-root`를 주면 호출한 cwd 안 파일만 받음(`gjc-runtime/ralplan-runtime.ts:811-846`) | spec D-W4 | 저장소 파일을 `path`로 넘길 수 없음. `content`를 사용 |
| 31 | `start(run_id)`는 open-gajae 추가분입니다(DR-19). | `gjc-runtime/ralplan-runtime.ts:2382-2391`(seed에 run ID 없음), `:1565-1570`(`--write`에만) | spec D-T3 | `start`에서 새 run 폴더와 예산을 지정할 수 있음 |
| 32 | owner 세션을 할당문의 `session_id`가 아니라 세션 계보에서 정합니다(DR-1). | `prompts/agent-fragments/ralplan-persistence.md:2,7` | host의 `context.sessionID` 계보를 신뢰할 수 있음 | 역할은 다른 세션의 run에 쓸 수 없음. 할당문에 `session_id`가 필요 없음 |
| 33 | 역할 프롬프트 host 치환: planner의 "Ask only about …"은 headless 규칙으로, architect의 forkContext 문장·`report_finding` 문단과 `irc`는 제거, `yield.result.data`는 최종 응답으로, `{{restrictedBash}}`는 읽기 전용 `shell` 문장으로 바꾸고 frontmatter는 제거합니다. | `prompts/agents/{planner,architect,critic}.md`, `prompts/agent-fragments/restricted-bash.md` | OpenCode에 해당 도구·필드가 없고 역할은 `question`을 쓸 수 없음 | 문구만 다름. 목록은 각 프롬프트의 source 섹션 |
| 34 | `ralplan handoff` op는 `ultragoal`로든 `deep-interview`로든 종료 phase(DR-7)와 활성 ralplan(R-OD18)을 요구합니다. | `gjc-runtime/state-runtime.ts:1572-1640`(동사는 phase도 `active`도 검사하지 않고 state 파일이 없을 때만 거부, `:1603-1608`), 검사는 `tools/skill.ts:42-61,170-171,203-221`이며 현재 턴에 불러온 스킬만 인계함(`session/agent-session.ts:8038-8046,13620-13622`) | skill 도구의 체인 가드를 op에 합침(D-F12) | 계획 도중의 직접 인계는 거부. Stop here·`clear`·인계 뒤에도 op는 거부되고, 나중의 ultragoal 로드는 GJC처럼 `handoff_from` 없이 ultragoal을 시작 |
| 35 | 활성 행 파일(`state/active/ralplan.json`)을 읽을 수 없으면 `force` 없는 `clear`는 GJC처럼 멈추지만, `clear(force: true)`는 그 파일을 읽지 않고 정리합니다(R-OD16). | `gjc-runtime/state-runtime.ts:244-270,1425` → `readActiveEntries`(`gjc-runtime/state-writer.ts:425-431`)가 `--force` 확인 전에 예외를 던짐 | 항상 차단 때문에 `state/**`를 편집 도구로 고칠 수 없어, GJC 동작이면 `shell`로 파일을 지우지 않고는 run을 끝낼 방법이 없음 | 손상된 행 파일이 있어도 강제 clear는 동작, force 없는 clear는 GJC와 같음 |
| 36 | ralplan 스킬을 불러와도 state를 쓰지 않습니다. run은, 그리고 계획 가드와 continuation도, `ralplan start`(또는 첫 `write`)에서 시작합니다. | `session/agent-session.ts:13582-13597` → `hooks/skill-state.ts:387-496,641`(`/skill:ralplan`을 불러오면 `ensureWorkflowSkillActivationState`가 phase `planner`인 mode state와 repository binding, 활성 행, 스냅숏을 써서, 불러온 순간부터 GJC의 mutation guard와 Stop 훅이 적용됨) | spec D-F13·R-O6: 훅과 키워드는 아무것도 시딩하지 않고 `start`가 문서화된 진입. 2026-09-29 리뷰 후 기록 | 스킬을 불러온 뒤 `ralplan start` 전까지는 계획 중 편집이 막히지 않고 멈춘 턴도 이어지지 않음. 스킬의 첫 지시가 `start` 호출 |
| 37 | ralplan에서 다른 스킬로 넘어가는 것은 ultragoal 방향만 막습니다. `ralplan` 로드와 같은 execution의 `skill ultragoal` 로드는 진행 중 계획 phase에서 거부되고 종료 phase에서는 인계합니다(편차 34). 계획 phase 진행 중에 `ralplan`을 다시 불러오거나 `deep-interview` 같은 다른 스킬을 불러와도 거부하지 않습니다. 인터뷰로 돌아가는 길은 종료 phase에서의 `ralplan handoff(to="deep-interview")`이고, ralplan이 주 skill인 동안 `deep-interview start`는 거부됩니다(deep-interview deviation 12). | `tools/skill.ts:170-176`(현재 활성 스킬로의 연쇄 거부), `:54-61,203-221`(`phasePermitsChain`: 진행 중인 ralplan phase에서는 모든 연쇄를 거부하고, 종료 phase에서는 불러온 스킬로 `gjc state handoff`를 실행). 이 가드는 현재 에이전트 턴에 불러온 스킬만 봄(`session/agent-session.ts:5961-5967,8038-8046,13620-13622`) | 이식 범위가 ralplan → ultragoal 게이트만 정했음(spec C-4, D-F12). ultragoal 개정은 GJC 턴 표식을 유지(PQ-21 A). 2026-09-29 리뷰 후 기록 | 계획 중 그런 로드는 통과하고 ralplan state는 그대로. 리더를 계획 루프에 붙잡는 것은 거부가 아니라 스킬 문구. 턴 표식은 GJC가 `agent_end`에서 지우듯 execution이 끝날 때마다 지워지므로, continuation이나 background subagent 완료가 연 다음 execution의 `ultragoal` 로드는 게이트를 거치지 않음. ultragoal에서 나가는 쪽은 대신 지속 활성 행으로 막음(ultragoal deviation 22) |
| 39 | 진행 중이든 `ultragoal handoff`나 deep-interview 넘기기로 넘겨받았든 ralplan run이 활성이면 `ralplan start`를 거절하고 상태(`run_id`, `handoff_from`)를 바꾸지 않습니다. 판단은 활성 행이 아니라 `ralplan-state.json`(`active: true`)으로 하고, 손상된 상태는 여전히 손상 상태 거절을 받습니다. `ralplan write`로 이어 쓰거나 먼저 멈춥니다(`ralplan state {"active": false}` / `ralplan clear`). deep-interview 결합 호출 `spec(…, handoff: "ralplan")`은 `gjc ralplan`처럼 그대로 다시 시드합니다. | `hooks/skill-state.ts:584-597`(skill 로드 시드는 보이는 활성 행에 이미 있는 스킬이면 아무것도 쓰지 않음), `gjc-runtime/ralplan-runtime.ts:2382-2400`(CLI 시드는 기존 run id로 다시 시드함) | 관리자 결정 K14 C(deep-interview 개정): 넘겨받은 run은 계보를 유지하고, 진행 중인 계획이 잘못된 `start`로 초기화되지 않음 | 같은 세션에서 새 계획을 시작하려면 활성 run을 먼저 멈추거나 지워야 함. `skills/ralplan/SKILL.md`와 `src/ralplan-runtime/tool.ts` 머리말에도 인용(AGENTS.md) |
| 38 | `state` op는 patch 병합만 합니다. GJC `state write`의 `--force`(알 수 없는 phase·잘못된 전환 거부를 우회)와 `--replace`(payload 전체 교체)에 해당하는 입력이 없고, 중첩된 `state` 객체는 최상위로 펼치지 않고 필드로 저장합니다(R-OD19). | `gjc-runtime/state-runtime.ts:1251,1274-1282,1297-1306,1332-1341` | GJC ralplan 스킬은 두 flag도 중첩 `state`도 쓰지 않음. 손상된 state는 `clear(force: true)`로 초기화. 관리자 결정: 기록만 | primary는 `state`로 전환표 밖 phase를 강제하거나 state 전체를 교체할 수 없음 |

### 수용한 동작 차이

아래 항목은 이식 spec이나 이전 open-gajae 결정과 다르며, 관리자가 수용했습니다. 대부분 GJC 동작을 그대로 따릅니다.

| 항목 | 동작 | 근거 | 영향 |
|---|---|---|---|
| 역할은 `content`만(spec D-W4 일부 대체) | 역할의 `path` 입력은 거부되고, OS 임시 `path`는 primary 전용입니다(R-O4). | GJC `gjc-runtime/ralplan-runtime.ts:852`, `SKILL.md:51` | 역할에는 파일 권한 확인 창이 없음. 큰 산출물(수십~100 KB 이상)이 도구 인자로 인라인 전달됨 |
| 시딩 없음, `write`가 state 생성(spec D-F13) | 훅·키워드는 아무것도 시딩하지 않고 `start`가 문서화된 진입입니다. `write`는 GJC처럼 state를 만들고 run을 전환합니다(R-O6). | GJC `gjc-runtime/ralplan-runtime.ts:986-1059`. GJC는 스킬 로드 때 시딩함(편차 36) | `write`로 만든 run에는 `mode`·`interactive`·repository binding이 없을 수 있음 |
| 한 모드 원칙 일부 해제 | ultragoal state가 활성이면 `start`만 거부하고, 역할·primary의 `write`는 거부하지 않습니다(R-O6, R-AE1). deep-interview 결합 호출 `spec(…, handoff: "ralplan")`도 GJC처럼 이 거부를 거치지 않습니다(deep-interview 알려진 한계 K12). | 관리자 결정(GJC 그대로) | ultragoal 실행 중 ralplan이 활성화될 수 있음. ultragoal 행이 활성인 동안은 ultragoal이 주 skill이지만, 그 행이 사라지면 ralplan 행이 계획 가드와 continuation을 이어받음. `ralplan state(patch={"active": false})` 또는 `ralplan clear`로 복구 |
| 종료 phase는 GJC 기준(spec D-F14, AC16) | 종료 집합은 spec의 `final`·`handoff`가 아니라 GJC의 8개 phase(`final`, `handoff`, `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`)이고, 가드는 GJC의 해제 phase 6개에서만 풀립니다(R-CE1). | GJC `tools/skill.ts:42`, `gjc-runtime/workflow-manifest.ts:154-160,229` | 승인 질문 중의 active `final`처럼 종료 phase에서 active인 run은 실행 중이 아님: continuation 없음, 같은 execution의 `skill ultragoal` 로드는 거부 대신 인계 |
| 이전 형식 state | 알 수 없는 phase(예: OMC의 `current_phase: "ralplan"`)의 state는 판독 불가로 봅니다: 가드 해제, continuation 없음, 게이트 통과, `doctor`는 `schema_violation` 보고. 이동 코드는 없습니다(DR-21). | spec D-T10 | 이전 세션이 편집을 잠그지 않음. 그 state는 직접 삭제 |
| 가드 해제 집합(spec D-F15, 명확화) | 가드는 `complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`에서만 풀리고, `final`과 `handoff`는 active인 동안 계속 막습니다(R-O10). | GJC `skill-state/workflow-mutation-guard.ts:264-276`, `gjc-runtime/workflow-manifest.ts:154-160` | 변화 없음. 이전 리뷰 질문의 잘못된 암시를 바로잡음 |
| `ralplan`·`ultragoal`·`goal`·`deep-interview`가 숨겨지는 범위(spec AC1, ultragoal spec D-HE8, deep-interview spec D-HL7) | 플러그인의 `context` 훅(`compaction`·`generate`에도 등록)이 각 workflow 도구를 소유하지 않은 agent의 요청에서 지웁니다. `ralplan`은 `open-gajae`, `open-gajae-planner`, `open-gajae-architect`, `open-gajae-critic`의 것이고, `ultragoal`·`goal`·`deep-interview`는 `open-gajae`만의 것입니다. host `build`/`general`과 사용자 정의 agent도 포함하며, agent가 없는 요청은 아무 도구도 소유하지 않습니다. 도구도 그런 호출을 계속 거부하고, 자체 역할의 `roleRules` deny도 유지합니다. 실행 시 거부만 하던 DR-22 방식을 대체합니다. | 호스트는 요청에 남은 도구만 광고하고 지워진 도구 호출은 거부함(`core/src/session/model-request.ts:225-255`, `core/src/tool.ts:272-275`). 호스트 patch 플러그인도 같은 방식으로 자기 도구를 지움(`core/src/tool/plugin/patch.ts:296-309`) | 그 agent들에게 도구가 보이지 않음. 사용자 설정이 허용해도 숨김이 우선 |
| Stop here가 활성 행을 제거(spec D-H6 일부 철회) | spec은 최신 `final`이 승인 대기인 동안 "Stop here 이후 포함" ralplan 표시를 유지하게 했습니다. Stop here는 GJC처럼 활성 행을 제거합니다(R-OD10). 승인 질문 중(active `final`)에는 행에 `pending` 칩이 있습니다. | GJC `skill-state/active-state.ts:849-866` | Stop here 뒤에는 활성 행으로 승인 대기를 알 수 없으므로 이후의 사이드바(후속 6번)도 알 수 없음. `pending-approval.md`는 보존 |
| revision 번호 없음(spec D-T8) | 활성 행과 스냅숏에 revision 번호를 두지 않습니다(R-OD6, deviation 17). | ralplan 쓰기는 모두 소유 세션 큐 하나에서 순차 기록 | 각각 D-T8 목록보다 key가 하나 적음 |

## GJC로부터의 deviation (ultragoal)

출처: GJC v0.17.7 커밋 `5c5231418930673e42cc5d08ebe4376e03187533`(MIT). ultragoal skill, `src/ultragoal-runtime/`(OMC ralph 기록 형식을 유지하는 `progress.ts` 제외), `src/goal/`, `src/skill-state/`, `open-gajae-cleaner` 프롬프트, executor red-team 조각은 아래 행이 달리 적지 않는 한 GJC ultragoal 런타임과 goal 모드를 따릅니다(AGENTS.md 정책: 출처, deviation, 이유, 영향). GJC 경로는 `gajae-code/packages/coding-agent/src/` 기준이며, `rt`는 `gjc-runtime/ultragoal-runtime.ts`, `guard`는 `gjc-runtime/ultragoal-guard.ts`, `fresh`는 `gjc-runtime/ultragoal-receipt-freshness.ts`, `REN`은 `gjc-runtime/state-renderer.ts`, `SKILL.md`는 `defaults/gjc/skills/ultragoal/SKILL.md`입니다. 결정 ID는 spec `.omc/specs/deep-interview-ultragoal-gjc-revision.md`(`D-…`, `AC…`. Errata E1~E6이 우선), plan `.omc/plans/ralplan-ultragoal-gjc-revision.md`(`C-…`, `DR-…`, `E-…`, `I-…`, `R…`), 관리자 결정 `.omc/plans/ultragoal-gjc-pq-decisions.md`(`PQ-…`, `IQ-…`)를 가리킵니다. 행 번호는 plan §7.1 번호 그대로이며, skill과 프롬프트의 source 섹션과 소스 파일 머리 주석이 이 번호를 인용합니다. deep-interview 개정은 33행을 철회하고 22·23행을 고쳤습니다. 그 번호는 다시 쓰지 않습니다.

| # | Deviation | GJC 출처 | 이유 | 영향 |
|---|---|---|---|---|
| 1 | `progress.txt`(구현, 바뀐 파일, learnings, Codebase Patterns, `add_pattern`, complete checkpoint마다의 항목, `PLAN`·`HANDOFF` 메모)를 유지하고 `brief.md`는 없습니다. `create`는 기록을 덮지 않고 이어 씁니다(PQ-15 A). `add_pattern`은 재계산하지 않습니다(PQ-25 B, spec E4). `checkpoint(complete)`는 `implementation`, `files_changed`, `learnings`를 각 1개 이상 요구합니다(PQ-10 A). | `rt:578-581`(`brief.md`), `SKILL.md:16-18` | spec D-AG1, PQ-10 A, PQ-15 A | 설명은 `goals.json`에 있음. 재계획 뒤에도 패턴과 learnings가 남아 압축 복구에 들어감(편차 26). 파일은 계속 자람 |
| 2 | 목표마다 구조화된 `acceptanceCriteria[{id, text}]`와 기준 revision(sha256) 바인딩을 둡니다. ID는 `G00x.ACn`이고, 고친 기준은 새 번호를 받으며 옛 번호는 은퇴합니다. op는 `criterion_id`로 기준을 가리킵니다(PQ-22 A). | 목표에는 objective 문장만(`rt:156-169`), 계약은 `executorQa.contractCoverage`(`rt:2038-2132`) | spec D-AG2, PQ-22 A | 완료 목표의 기준은 바꿀 수 없음(spec E1). `checkpoint(pending)`으로 다시 열어 고치면 다음 complete checkpoint가 새 revision으로 영수증을 씀. revision 바인딩은 직접 변조를 잡는 방어로 남음 |
| 3 | `create`는 `@goal` brief 대신 `description`과 구조화된 `goals[]`를 받습니다. `priority`는 없습니다. | `rt:1183-1221` | spec D-AG4 | 구분자 파싱 규칙이 없음 |
| 4 | 계획 변경은 GJC `steer` 6종 대신 목표·기준 대상의 `add`/`revise`/`supersede`와 `after`입니다. 분할은 `supersede`와 `add(after)`입니다. 인자는 GJC처럼 `rationale`과 `evidence`입니다(spec E3). 완료 목표는 GJC처럼 바꿀 수 없고(spec E1), 나머지 허용 상태는 38행입니다. | `rt:334-343,3869-3877,3959-4216` | spec D-AG6, PQ-14 (1) B′ | `reorder_pending`·`annotate_ledger`·`mark_blocked_superseded` op가 없고, `after`로 목표를 맨 앞에 둘 수 없음(IQ-1 B: 추가한 뒤 첫 목표를 그 뒤로 옮김). rationale과 evidence는 5단어·32자 이상 |
| 5 | 영수증 `completionVerification`을 GJC 안쪽 이름 그대로(PQ-27 A, spec E3) `{receiptId, receiptKind, criteriaRevision, qualityGateHash, checkpointLedgerEventId, verifiedAt}`로 줄였습니다. planGeneration basis, batch 영수증, `goalStatusBeforeCheckpoint`·`gjcGoalMode`·`gjcObjective`는 없습니다. GJC의 과거 영수증 허용 중에는 "목표 추가로 밀린 final을 per-goal 완료로 인정"하는 좁은 규칙만 둡니다(PQ-14 (3)-b, spec E2). final 유효성은 ledger 순서로 봅니다(plan C-7). "다른 목표가 아직 유효한 final-aggregate 영수증을 가지면 per-goal" 가지(`rt:640-652`)는 가져오지 않았습니다. | `rt:187-228,626-658,660-742`, `fresh:207-517`, `guard:377-398` | spec D-AG7, spec E2·E3 | 목표를 추가하면 옛 final은 per-goal 완료로 남고 새 마지막 목표가 final을 받음(GJC와 같은 결과, 다른 계산). 필수 목표가 줄어 남은 미완료 필수 목표가 없으면 마지막 완료 목표 하나를 다시 엶(plan C-7 (라)). 실행 완료는 마지막 완료 목표의 final 영수증으로 판정 |
| 6 | goal을 세션 transcript가 아니라 `state/goal-state.json`(GJC 모양 + `source`)에 두고, continuation 카운터와 보류는 훅 전용 `state/goal-continuation.json`에 둡니다(PQ-2 B). | `session/agent-session.ts:5847-5853`, `session/session-manager.ts:3089-3092`, `goals/state.ts:7-16` | spec D-TL1(호스트에 transcript 쓰기 없음), ralplan R-O3 선례 | 세션 분기(branch)를 따르지 않음. 재시작 뒤에도 카운터가 남음 |
| 7 | `/goal` 슬래시 명령과 사용자용 가드 우회 경로가 없습니다. | `modes/controllers/goal-mode-controller.ts:285-497` | open-gajae는 명령을 두지 않음, spec D-TL2 | 사용자는 모델을 통해서만 goal을 다룸 |
| 8 | `goal` 도구는 `open-gajae` 전용이고 토큰·시간 사용량을 기록하지 않습니다. | `sdk/session.ts:4559-4575`, `goals/runtime.ts:87-98,273-288` | spec D-TL3, D-TL4 | `get`에 사용량이 없음 |
| 9 | 경로 A continuation에 규칙 두 개를 둡니다: 도구 호출 없는 턴이 연속 3회면 보류하고, Esc 뒤에는 다음 실제 사용자 프롬프트까지 멈췄다가 그 턴이 끝나면 다시 잇습니다. 보류하면 원인과 "메시지를 보내면 이어진다"를 적은 `<goal-notice>` 하나(`resume: false`)를 남깁니다(IQ-3 C). | `session/agent-session.ts:21086-21121`(보류 없음. 중단 뒤 같은 goal의 다음 알림을 **한 번만** 건너뜀, `:21108-21112`), TUI 경로 B의 빈 continuation 억제와 timeout 보류(TUI 상태 줄만 보여 줌, `modes/controllers/goal-mode-controller.ts:193-218`) | spec D-TL5(현행 규칙). 안내는 IQ-3 C(플러그인은 TUI 상태 줄을 그리지 않음) | 진행 없는 루프가 3턴에서 멈추고, Esc는 알림 한 번이 아니라 다음 사용자 프롬프트까지 멈춤. 사용자는 루프가 멈춘 이유와 잇는 방법을 봄 |
| 10 | nudge 예산이 없고 `drop`은 항상 허용합니다. | `guard:814-886,1000-1055`, `rt:430,502-566` | spec D-TL9 | "더 해 봐" 거부가 없음 |
| 11 | `question`을 막지 않습니다. | `tools/ultragoal-ask-guard.ts:33-49` | spec D-TL8 | 실행 중에도 사용자에게 물을 수 있음 |
| 12 | 다른(사용자) goal이 열려 있으면 `create`는 goal을 켜지 않고 그 status와 source를 알립니다(`Goal not armed: …`). 켜면 `Goal armed: …`를 출력합니다. 같은 run 판정은 GJC `provenance.runId/goalId` 비교 대신 `source: "ultragoal"`로 하고, 다른 출처의 goal은 GJC처럼 trim한 문구 일치로 봅니다(`gjc-runtime/goal-mode-request.ts:145-152,195`). 여기서는 run이 루트 세션 하나라서 결과는 같습니다. | `gjc-runtime/goal-mode-request.ts:145-162,195,206-216`, `session/agent-session.ts:12992-12995`(요청을 조용히 버림) | spec D-TL10 | 모델이 다른 goal을 drop한 뒤 `create`를 다시 부름 |
| 13 | 모든 목표가 architect 리뷰를 받습니다. deferred gate는 없습니다. | `rt:2753-2764`, `SKILL.md:246-265` | spec D-VF1 | 목표당 리뷰 비용이 늘고, 목표별 결함을 일찍 잡음 |
| 14 | QA 증거는 명령·결과·적대 사례 텍스트뿐입니다. `executorQa` 행렬, artifact 파일, CLI replay, computer-use suite, architect `commands`가 없습니다. | `rt:1840-2152,2915-2928`, `gjc-runtime/ultragoal-evidence.ts` | spec D-VF2, D-VF4 | 증거를 기계적으로 확인하는 범위가 줄어듦 |
| 15 | gate에 활성 기준마다 한 줄인 `criteriaCoverage`가 필수입니다. | (없음. `executorQa.contractCoverage`, `rt:2038-2132`) | spec D-VF4 | 기준별 증거가 없으면 거부됨 |
| 16 | `sourceHash`, git 변경 집합, lane selection이 없습니다. 2세대 이상은 `deltaOnly`와 `deltaPaths`만 봅니다. | `gjc-runtime/ultragoal-change-set.ts:71-99`, `rt:2552-2640,2650-2725` | spec D-VF5 | 리뷰한 코드 상태와 제출한 상태를 기계적으로 묶지 않음 |
| 17 | gate를 통과하지 못한 목표는 `checkpoint(failed)`와 `next(retry_failed)`로 다시 합니다. 재시도 순서는 34행(PQ-19 B)입니다. | `rt:1278-1284` | spec D-VF8(open-gajae 규칙) | 고친 목표를 바로 재검증. 상한 없음 |
| 18 | critic 비OKAY 판정이 연속 5회(두 종점 합산)면 continuation을 보류합니다. 연속은 마지막 OKAY(`critic_verdict` OKAY, 또는 final gate의 `criticReview` OKAY)와 해제 표식 뒤, 그리고 마지막 `plan_created` 뒤의 비OKAY만 셉니다(PQ-3 (1) A·(2)-b). hard stop과 override op가 없고, 보류 중일 때만 다음 실제 사용자 프롬프트가 보류를 풀고 카운트를 새로 시작합니다. 보류 안내는 critic 연속을 원인으로 적습니다(9행). | `fresh:14,113-150`(실행 전체 누적, `:118-124`), `rt:4384-4425`, `guard:927-933` | spec D-VF9 | gate는 막지 않고 루프만 멈춤. 새 계획은 카운트를 새로 시작 |
| 19 | cleaner는 `open-gajae-cleaner` 역할(읽기 전용 권한)이고, 프롬프트만 GJC 조각입니다. | `defaults/gjc-skills.generated.ts:35-37`, `ai-slop-cleaner.md` | spec D-VF10 | skill 조각 로딩 대신 subagent 호출 |
| 20 | red-team 조각은 `open-gajae-executor` `subagent` 지시문에 `[ultragoal-red-team]`이 있을 때 붙고, 활성화 문장의 GJC typed `executionMode: "ultragoal-red-team"`(과 지시문 텍스트 대체 경로)을 이 표식으로 바꿉니다. `executorQa` 행렬 문장은 QA lane 계약으로, `inlineEvidence` 문장은 "A prose claim without a command you ran is not evidence."로, `ask`는 `question`으로, `record-review-blockers` 실행은 리더에게 보고로 바꾸고, blocker 목록에서 "missing artifact refs"를 뺍니다(plan C-12). | `task/ultragoal-redteam-activation.ts:17-75`, `prompts/agents/executor.md:34-46` | spec D-VF11 | 호스트 `subagent`에 `executionMode`가 없음. 표식이 없으면 평소 executor |
| 21 | validation batch가 없습니다. | `rt:775-995,2312-2464,2983-3239`, `validation-batch-contracts.md` | spec D-VF1 | 경계는 실행 끝 하나 |
| 22 | 연쇄 가드: ultragoal에서 나가는 쪽은 지속 state로 봅니다 — ultragoal이 활성 주 skill인 동안에는 `failed` phase에서도 `ralplan`·`deep-interview` 로드를 거부합니다 — 들어오는 쪽은 GJC처럼 턴 단위로 봅니다. deep-interview를 불러온 execution의 `skill ultragoal` 로드는 먼저 deep-interview 게이트를 거칩니다(deep-interview deviation 31). | `tools/skill.ts:42-61,170-222`, `session/agent-session.ts:7448,8038-8046` | spec D-HE3, D-HE6(관리자가 고른 비대칭) | 다른 턴의 ralplan 로드도 거부됨. U8은 기록만 |
| 23 | 소유하지 않은 agent에게서 `ultragoal`·`goal`·`ralplan`·`deep-interview`를 `context` 훅으로 숨깁니다. | goal 도구는 항상 등록(`sdk/session.ts:4559-4575`) | spec D-HE8 | 사용자 설정의 허용도 덮음(plan R9) |
| 24 | skill에서 GJC의 succession, review mode, computer-use suite, CLI replay, validation batch, nudge 설정, per-story 모드, `ask` 차단 절을 뺐습니다. binding·succession 검사도 없습니다. | `SKILL.md:21-36,103,133-134,267-280,435-465` | spec D-DT1, Non-Goals | 해당 기능 없음 |
| 25 | 공통 op(`doctor`/`state`/`clear`)를 `gjc state` CLI 대신 `ultragoal` 도구 안에 둡니다. `state`는 GJC 열린 patch지만 파생 필드는 거부하고 `--force` 우회가 없습니다(PQ-1 A, plan C-3). | `gjc-runtime/state-runtime.ts:1328-1341` | spec D-SF3(ralplan 선례) | 동사 대응 1:1. 결과는 GJC처럼 JSON 영수증(`state`, `clear`)과 텍스트(`doctor`)(plan C-14) |
| 26 | 압축 복구에 진행 기록의 패턴과 최근 learnings를 더하고, STALLED 줄을 압축 문맥에 넣습니다. GJC는 압축 뒤 continuation 프롬프트에 넣습니다. | `gjc-runtime/workflow-recovery-projection.ts:465-616`, `session/agent-session.ts:713-744` | spec D-SF5, 호스트에 압축 뒤 continuation 훅이 없음 | 복구 문맥이 조금 길어짐 |
| 27 | `checkpoint` status는 `complete`, `failed`, `blocked`, `pending`만 받습니다. `pending`은 목표를 다시 엽니다(spec E1). | `rt:1011-1019`(7종 모두 받음), `rt:3703-3767` | spec R17, PQ-14 (1) B′ | `active`·`review_blocked`·`superseded`는 전용 op(`next`, `record_review_blockers`, `supersede`)로만 바뀜 |
| 28 | final gate의 `reviewCohort`와 `criticReview`가 최상위 키이고 레인 status가 역할별입니다. | `rt:2656-2725,2956-2974` | spec D-VF4, D-VF6 | gate 모양이 다름 |
| 29 | 수정 목표를 완료할 때 gate 검증과 영수증 종류를 **둘 다** 원 목표가 이미 superseded인 계획으로 정합니다. GJC는 supersede 전 계획으로 gate를 검증하고(`rt:3707-3717` → `rt:2738-2742`), supersede 뒤에 영수증 종류를 다시 정합니다(`rt:3737-3750`). | 좌동 | GJC 순서에서는 실행을 닫는 수정 목표가 목표별 gate로 통과한 뒤 final 영수증을 받고, 가드가 critic 누락으로 막음(`guard:264-288`). open-gajae에는 그 재검증 경로가 없음(spec D-AG7) | 실행을 닫는 수정 목표는 첫 checkpoint부터 final gate(2세대 cohort)를 냄 |
| 30 | goal 문맥과 continuation은 TUI 줄이 붙은 보이는 synthetic 메시지입니다. continuation 프롬프트에서 GJC 첫 줄인 HTML 주석 `<!-- Hidden continuation steer. role=user, suppressed from visible transcript. -->`를 뺍니다(호스트 치환). | `session/agent-session.ts:13116-13168,21098-21120`, `prompts/goals/goal-continuation.md:1` | 호스트와 TUI 줄 규칙. 여기서는 메시지가 숨겨지지 않음 | 삽입마다 한 줄, 기본 `steer` 전달로 모델 한 단계가 더 돌 수 있음(plan R12) |
| 31 | continuation 문구에서 `todo_write`를 뺐습니다. | `prompts/goals/goal-continuation.md:12` | 호스트에 todo 도구가 없음 | 문구만 다름 |
| 32 | pause 판정에 planGeneration 결속이 없고, critic 상한이 pause를 막지 않습니다. | `fresh:56-111`, `guard:927-933` | spec D-AG7, D-VF9 | 옛 pause OKAY도 유효 |
| 33 | deep-interview 개정으로 철회: ultragoal → deep-interview 인계의 callee는 GJC의 `interviewing`과 활성 행을 받습니다. | — | — | — |
| 34 | `next(retry_failed: true)`는 활성 목표가 없으면 대기 목표보다 첫 failed 목표를 먼저 잡습니다. | `rt:1278-1284`(active → pending → failed) | spec D-VF8 "고친 뒤 재시도", PQ-19 B, spec E6 | 고친 목표를 바로 재검증. 대기 목표가 남아 있어도 AC24가 성립 |
| 35 | skill 로드가 없거나 비활성인 ultragoal state를 기존 필드를 유지한 채 `goal-planning`으로 올립니다. | `hooks/skill-state.ts:446-450`(`expectedRevision: 0`, 파일이 있으면 조용히 실패) | spec D-HE6 "항상 진입" | 완료·인계 뒤 재진입도 goal-planning 가드를 받음 |
| 36 | `record_review_blockers`와, 자동 진행을 포함한 `checkpoint(complete)`는 `goals.json`을 한 번씩만 씁니다. GJC는 둘 다 두 번 씁니다: review blockers는 checkpoint 뒤 목표 추가(`rt:4250-4271`), checkpoint는 계획 쓰기(`rt:3778`) 뒤 `startNextUltragoalGoal`의 계획 쓰기(`rt:1401`). | `rt:4250-4271,3778,1401` | plan C-7a(한 번에 쓰기) | 끝 상태는 같고 중간 상태가 없음 |
| 37 | `goal drop`은 파일을 `status: "dropped"`로 남기고, 모든 op가 goal 없음으로 다룹니다. | `goals/runtime.ts:377-389`(state 삭제) | spec D-TL1의 status 목록 | 보이는 동작은 같음. `resume`은 거부 |
| 38 | 계획 변경 op의 허용 상태를 GJC op에 대응시킵니다(PQ-26 A): 목표 문구와 위치는 `pending`일 때만 바뀌고, GJC에 없는 기준 op도 같은 `pending` 규칙을 따르며, 목표 `supersede`는 GJC `split_subgoal`(`pending`)과 `mark_blocked_superseded`(`blocked`, `review_blocked`)의 합집합입니다. | `rt:3869-3877,4030,4086,4126,4192-4198` | op 대응이 1:1이 아님(spec D-AG6, 4행) | 작업 중 목표를 고치려면 먼저 `pending`으로 되돌림(plan R21). 마지막 남은 대기 목표를 supersede하면 final 영수증이 없어질 수 있음(plan C-7 (라)) |
| 39 | ledger에 GJC에 없는 필드와 이벤트를 둡니다: `plan_created.description`, `steering_accepted`의 `target`·`criterionId`·`after`·`amendment`, 그리고 `workflow_handoff{to, reason}`. 거부된 op는 줄을 남기지 않고(GJC는 `steering_rejected`를 붙임), `add_pattern`과 읽기 op도 남기지 않습니다(PQ-16 C). | `rt:1274`(`plan_created{goalIds}`), `rt:392-428`, `rt:3929-3947`(`appendSteeringRejected`). GJC 인계는 ledger에 쓰지 않음(`gjc-runtime/state-runtime.ts:1731-1847`) | spec D-AG6(기준 대상·위치), D-AG8 "인계 이벤트", PQ-16 C | 인계와 기준 변경이 ultragoal 감사 기록에 남음. 거부된 시도는 거기에 남지 않음 |
| 40 | 수정 목표는 GJC 인자(`goal_id, title?, objective, evidence`)로 만들고, open-gajae 목표에 필요한 수용 기준은 자동 1개 "<objective> is resolved and re-verified"로 채웁니다. 그 기준이 2000자 한도에 들도록 `objective`는 1972자까지 받습니다(plan E-24). | `rt:4218-4274`(objective만) | spec D-AG2(목표마다 기준 필수), PQ-17 C | 수정 목표의 `criteriaCoverage`는 사실상 1줄 |
| 41 | 결과 텍스트에 GJC에 없는 줄을 더하고, GJC 명령 이름을 op 호출로, `next`의 `checkpoint requires=`를 open-gajae gate 이름으로 바꿉니다. 더한 줄: `status`의 `- run_complete: yes` 또는 `no (<이유>)`(예: `required goals not complete: …`, `<id> has no completion receipt`, `<id> completion receipt is stale: …`, `last completed goal <id> has no valid final-aggregate receipt`), `- goal: <status> (<source>)` 또는 `- goal: none`, 영수증 상태와 기준 ID가 있는 `## goals` 목록; `next`의 `criteria=`, `run-complete=`, 재오픈 `hint=`; checkpoint의 다음 목표 `Criteria:` 줄, `Run not complete: <이유>`, `Reopened <id>; …`; `create`의 `Goal armed: …` 또는 `Goal not armed: …`; 계획 변경·수정 목표 결과의 새 id; critic 연속 수; 계획 변경 거부와 `goal complete` 거부의 재오픈 줄. GJC의 `GJC objective:` 줄은 `Goal objective:`이고, 가드 진단은 GJC의 `.gjc/ultragoal`을 `ultragoal`로 씁니다. `checkpoint(complete)` 거부는 `validate_gate`와 같은 목록(`N quality-gate error(s):`와 결함마다 `  path [code]: message`, AC20)을 내며, GJC checkpoint 오류는 메시지만 줄바꿈으로 잇습니다(`rt:1447-1451`). | `REN:251-289`, `rt:5143-5227,5249-5342,5410,5534-5539,5576-5623`, `guard:250-300,460-530,703-711` | PQ-18 B, PQ-22 A(모델이 기준 ID를 볼 곳), DR-1(실행 완료가 파일 status와 다를 수 있음) | GJC 줄은 그대로 남고 출력이 몇 줄 늘어남 |
| 42 | goal 고정 문구의 용어를 바꾸고(stories → goals, brief → description) 실제 세션 경로를 씁니다. 같은 식으로 checkpoint 텍스트와 수정 목표의 원 목표 증거(`Resolved by verification blocker goal …`)의 "GJC goal"·"story"도 "goal"로 씁니다. | `gjc-runtime/goal-mode-request.ts:21-22`, `rt:3746,5212-5216` | 경로 오류 수정, open-gajae 용어(PQ-12 A) | 문구만 다름 |

## GJC로부터의 deviation (deep-interview)

출처: GJC v0.17.7 커밋 `5c5231418930673e42cc5d08ebe4376e03187533`(MIT). deep-interview skill과 패널 조각, `src/deep-interview-runtime/`, `open-gajae-lateral-reviewer` 프롬프트, `src/skill-state/`의 deep-interview 부분은 아래 행이 달리 적지 않는 한 GJC deep-interview 계약을 따릅니다(AGENTS.md 정책: 출처, deviation, 이유, 영향). GJC 경로는 `gajae-code/packages/coding-agent/src/` 기준이며, `RT`는 `gjc-runtime/deep-interview-runtime.ts`, `ST`는 `gjc-runtime/deep-interview-state.ts`, `STG`는 `gjc-runtime/deep-interview-stage.ts`, `AMB`는 `gjc-runtime/deep-interview-ambiguity.ts`, `STR`은 `gjc-runtime/state-runtime.ts`, `MG`는 `skill-state/workflow-mutation-guard.ts`, `SKT`는 `tools/skill.ts`, `AGS`는 `session/agent-session.ts`, `SKILL.md`는 `defaults/gjc/skills/deep-interview/SKILL.md`, `GL`은 그 `lateral-review-panel.md`입니다. 결정 ID는 spec `.omc/specs/deep-interview-deep-interview-gjc-revision.md`(`D-…`, `AC…`. Errata E1–E16이 우선), plan `.omc/plans/ralplan-deep-interview-gjc-revision.md`(`C-…`, `DR-…`, `K…`), 관리자 결정 `.omc/plans/deep-interview-gjc-pq-decisions.md`(`PQ-…`)를 가리킵니다. 행 번호는 plan §7.1 번호 그대로이며 skill의 source 섹션과 소스 파일 머리 주석이 이 번호를 인용합니다. 11·28·29·32·33번은 해당 결정이 GJC를 따르게 되어 배포 전에 철회했고 쓰지 않습니다.

### 엄격한 입력과 소유

런타임이 소유하거나 꼴을 정한 필드를 어기는 입력은 거절합니다.

| # | Deviation | GJC 출처 | 이유 | 영향 |
|---|---|---|---|---|
| 19 | `state` op는 런타임 소유 필드(`spec_slug`, `spec_path`, `spec_sha256`, `spec_stage`, `spec_persisted_at`, 그리고 `state` 안의 `rounds`, `established_facts`, `current_ambiguity`, `ambiguity_floor`)를 두 층 모두에서, 최상위 전사 필드 9개도 거절합니다(PQ-20 C). GJC `state write`는 열린 병합입니다. 객체가 아닌 `patch.state`는 GJC처럼 무시합니다(PQ-25 A). | `STR:1232-1400`, `ST:159-169` | spec D-SR9, ultragoal `state` op 선례(ultragoal PQ-1 A), spec E6 | 스펙·라운드·모호도는 `write`와 `spec`으로만 바뀜. `write`는 `spec_*`를 받고 `state`는 거절하는 비대칭은 GJC와 같음(K13) |
| 25 | 옛 형식 정규화(끌어올리기)가 없습니다. deep-interview 읽기는 모두 `state` 배열 보정과 `state` 안 봉투 키 제거만 하고, `write`·`state` 입력 최상위의 전사 필드는 옮기지 않고 거절합니다(PQ-20 C). 넘기기 쓰기는 정규화하지 않습니다. | `ST:159-244,362-363`, `AMB:166`, `STG:202-231`, `STR:1622-1628,1732-1738` | spec D-SR8, E6, E8 | 옛 세션 상태는 관리자가 지움. 최상위 전사 필드는 저장되지 않고, 필드 이름과 `{"state": {…}}` 안내가 든 오류로 돌아오며 아무것도 쓰지 않음 |
| 30 | `write`·`spec`·`handoff`·`state`는 활성 인터뷰가 필요합니다(PQ-12 B′). GJC는 상태 없이도 쓰고 늘 활성으로 만듭니다. 상태 없는 `clear`가 `{active: false, current_phase: "complete"}`를 쓰고 행을 지우는 것은 GJC·ultragoal과 같습니다. | `STG:428-451,830-920`, `RT:621-629`, `STR:1402-1492` | spec D-HL3, E7: 끝낸 인터뷰가 조용히 다시 활성이 되지 않게 함 | `clear` 뒤의 쓰기는 거절됨. 다시 열려면 `start`나 `ralplan handoff(to="deep-interview")` |
| 35 | 항상 차단 경로에 `specs/deep-interview-*`를 더합니다. GJC는 `.gjc/**` 전체를 막습니다. | `MG:1807-1817` | open-gajae의 항상 차단은 소유 파일만 대상 | 다른 `specs/` 문서는 이 가드 밖 |
| 36 | `write`는 자기가 건드린 라운드 기록을 병합한 뒤 검사합니다. 1라운드 이상은 `round`, `round_key` `"round-<round>"`, `lifecycle` `"scored"`, `question_text`, `answer`, 0..1의 `ambiguity`, goal·constraints·criteria 점수(brownfield면 `context`도)가 필요하고, Round 0은 `round_key` `"round-0"`, `question_text`, `answer`가 필요하며 `answered`여도 됩니다. 하나라도 어긋나면 `write` 전체를 거절하고 어긋난 라운드와 필드를 모두 적습니다(PQ-22 D, PQ-31 B, PQ-32 A, PQ-33 A, PQ-34 A). GJC는 크기·prose 상한·예약 키만 보고 라운드는 자유 필드입니다. | `STG:272-289`, `SKILL.md:532-561` | spec D-RS1(기록기가 없어 모델이 질문·답까지 씀), spec E9 | 틀린 라운드는 저장되지 않고 필드 이름과 함께 돌아옴. 필수 목록은 skill의 `Required:` 줄이 맞춰야 하는 상수 하나 |

### 호스트·기반 차이

OpenCode나 open-gajae 기반에 GJC 기능이 없습니다.

| # | Deviation | GJC 출처 | 이유 | 영향 |
|---|---|---|---|---|
| 1 | CLI 동사 대신 `deep-interview` 도구 op 8개. 소유 세션은 계보 루트입니다. | `commands/deep-interview.ts`, `RT:873-916`, `gjc-runtime/session-resolution.ts` | spec D-SR1, D-SR5 | 모델은 op 이름으로 부름 |
| 3 | `ask` 기록기와 `deepInterview` 질문 메타데이터가 없습니다. 모델이 라운드마다 `deep-interview write`로 기록합니다(꼴 검사는 deviation 36). | `tools/ask.ts:811-848`, `gjc-runtime/deep-interview-recorder.ts` | spec D-RS1. OpenCode `question`에는 메타데이터 칸이 없음 | 기록이 실제 대화와 맞는지는 모델에 달림(K3, K8) |
| 16 | 이어가기는 `synthetic` 메시지이고, 진짜 사용자 프롬프트마다 두 번까지 메모리에서 셉니다. goal 루프보다 먼저 도는 것은 ultragoal spec D-TL6의 예외입니다. | `AGS:21137-21211,8138-8157` | spec D-HL5 | 재시작하면 횟수가 0이 됨 |
| 17 | brownfield 탐색 역할은 `open-gajae-explore`입니다. | `SKILL.md:61,162` | spec D-IF5 | — |
| 18 | 패널 페르소나와 보조 lane은 fork-context 서브에이전트 대신 새 문맥으로 시작하는 OpenCode `subagent`로 돌고, 리더가 필요한 맥락을 프롬프트로 넘깁니다. lane 역할은 지정하지 않습니다(PQ-4 A, GJC와 같음). 패널 역할은 deviation 37입니다. | `SKILL.md:625,639-649`, `GL:3-7`, `task/types.ts:114-119` | spec D-IF2, D-IF4, E11 | 페르소나·lane 프롬프트마다 맥락을 담음 |
| 20 | 설정은 JSONC의 `ambiguityThreshold` key 하나이고 설정 이전이 없습니다. GJC의 skill 로드 사전 결정 대신 시스템 프롬프트 블록이 값과 출처를 주며, 출처는 줄여 씁니다: `~/.open-gajae/open-gajae.jsonc`, `./.open-gajae/open-gajae.jsonc`, `default`(GJC는 정규 경로, PQ-16 D′). `start(threshold)` 인자의 출처는 `start(threshold)`입니다(GJC는 `flag:--threshold`, U-2 C). Phase 0은 활성 상태의 값만 씁니다. | `gjc-runtime/workflow-settings.ts`, `SKILL.md:100-114`, `RT:378-379,511` | spec D-SR6, D-HL3(로드가 시드하지 않음), E4. 시스템 프롬프트에 사용자 이름을 넣지 않음 | Phase 0 순서는 GJC와 같음. 블록·표식 줄·`threshold_source`·스펙 메타데이터가 같은 꼴을 씀 |
| 23 | HUD 칩은 계산만 하고 그리지 않습니다. | `modes/components/skill-hud/render.ts` | spec D-HL1, ralplan R-OD17 | — |
| 26 | `.session-activity.json`과 최근 세션 자동 감지가 없습니다. | `gjc-runtime/session-resolution.ts:137-232` | spec D-SR5 | — |
| 27 | 패널 조각은 스킬 폴더의 파일이고 호스트 파일 목록에 보입니다. skill이 패널 호출마다 조각 전문을 넘깁니다(PQ-27 B). 조각 본문은 GJC 원문에 경로만 바꾼 것입니다. | `defaults/gjc-skills.generated.ts:79-85`, `SKILL.md:79-86`, `GL:1-49` | `src/config.ts` skill 등록, `core/src/skill.ts:36-66` | 모델이 조각을 읽어 넘김 |
| 31 | skill 로드 게이트는 `open-gajae`에만 걸립니다. 상태가 없거나 읽히지 않으면 통과하고, `interviewing`(활성·비활성)과 읽히지만 알 수 없는 phase는 GJC처럼 거절하며(U-1 A), 활성 `handoff`는 넘기고, 끝난 인터뷰(`complete`, `completed`, `failed`, `cancelled`, `canceled`, `inactive`, 활성·비활성)는 유효한 스펙(`spec_path`와 sha256)이 있으면 비활성이어도 공통 넘기기로 연결하고 없으면 통과합니다. 이미 넘긴 인터뷰는 통과합니다(PQ-11 E/B, A4-6). GJC는 `active`를 보지 않고, 상태가 없거나 읽히지 않으면 `"running"`으로 거절하며, `complete`에서는 넘기기를 돌리고 실패하면 거절합니다. 지운 인터뷰는 행이 없어 GJC에서는 연결되지 않습니다. | `SKT:42,203-222`, `AGS:6044-6064` | 로드가 시드하지 않음(spec D-HL3). 읽기 실패는 ultragoal 게이트와 같은 fail-open. spec E15 | `start` 전에는 다른 skill로 옮길 수 있음. 같은 execution에서 deep-interview를 불러왔다면 끝낸 인터뷰의 스펙이 다음 skill로 이어지고, 이미 활성인 callee도 시작 phase로 되돌림(PQ-36 C, K15). ultragoal이면 `goal-planning`으로 돌아가 `create` 전까지 제품 편집이 막히고, `create`가 `goals.json`을 덮어쓰며, 열린 goal은 계속 재촉함 |
| 34 | 전체 상태에 StateStore 한도(1 MiB, 깊이 10, key 100개)가 걸립니다. | `ST:466-470` | 공통 `writeModeState` 한도(`src/state.ts`) | 매우 긴 인터뷰의 `write`가 파일을 그대로 둔 채 실패함(K6) |
| 37 | 패널 페르소나를 새 읽기 전용 역할 `open-gajae-lateral-reviewer`(PQ-26 B)로 돌립니다. 권한으로 읽기 전용을 강제하고(기본 역할 규칙, PQ-28 A. 다른 모든 역할처럼 `shell`은 제한하지 않음), 역할 프롬프트에 출력 계약이 없으며(PQ-27 B), `agents.open-gajae-lateral-reviewer`로 모델·variant를 정할 수 있습니다(기본값 없음, PQ-29 A). GJC는 패널 역할 없이 fork-context 서브에이전트와 조각으로 돌리고 페르소나를 "read-only architect"로 묘사만 합니다. | `SKILL.md:625`, `task/types.ts:114-119,148`, `prompts/agents/architect.md:81-113` | OpenCode `subagent`는 역할이 필요하고 fork가 없음(F10). architect 역할의 Markdown 출력 계약에 끌려가지 않게 관리자가 역할 신설을 고름(PQ-7 N, spec E10) | 역할이 9개. 페르소나 응답이 다른 역할의 출력 계약에 끌려가지 않음 |

### 관리자 선택

spec 결정이나 PQ 답으로 기능을 빼거나 바꿨습니다.

| # | Deviation | GJC 출처 | 이유 | 영향 |
|---|---|---|---|---|
| 2 | receipt, checksum, revision, 초안, `stage/check/apply/discard`가 없습니다. StateStore `_meta`는 남습니다. `status`는 `gjc state read`의 꼴입니다. | `gjc-runtime/state-writer.ts:286-309,446-473`, `STG` | spec D-SR2 | 순서와 원자성은 세션 큐가 보장 |
| 4 | 모호도 하한에 자동답변 항이 없습니다. | `AMB:34,94-99,106-121` | spec D-RS2, D-RS4 | — |
| 5 | 의도 계약과 `intent_review`가 없습니다. `handoff` op는 활성 인터뷰, phase `handoff`, sha256이 맞는 스펙을 확인합니다(로드 게이트의 연결은 스펙과 sha256, deviation 31). GJC 동사는 계약이 없으면 스펙 없이 통과하고 phase를 보지 않습니다. | `ST:412-831`, `STR:1496-1551`, `SKT:203-209` | spec D-RS5, D-SH4, AC21 | 스펙 없이는 넘길 수 없음 |
| 6 | 자동답변 조각, 리듬 가드, 0.85 상한, 에이전트가 답하기 전의 패널 조건이 없습니다. | `defaults/gjc/skills/deep-interview/auto-answer-uncertain.md`, `SKILL.md:342,371-375,623` | spec D-RS4 | — |
| 7 | "Ask about these choices" 선택지가 없습니다. 직접 입력으로 온 되묻기는 짧게 답하고 같은 질문을 다시 묻습니다. | `tools/ask.ts:1240-1252`, `SKILL.md:369` | spec D-RS6 | — |
| 8 | trace, 해상도 플래그, 언어 감지가 없습니다. 언어 문장은 "사용자의 요청과 답에 쓰인 언어"로 바꿉니다(PQ-1 B). | `RT:49-98,382-410`, `SKILL.md:25-31` | spec D-SR12, D-IF9 | — |
| 9 | 직접 입력 정리 게이트(Step 2b″)가 없습니다. | `SKILL.md:377-383` | spec D-IF4 | — |
| 10 | Phase 5에 "여기서 마치기"(`deep-interview clear`)가 있고 autoresearch 선택지가 없습니다. | `SKILL.md:785-811` | spec D-SH3 | — |
| 12 | ralplan이나 ultragoal이 보이는 주 skill이면 `start`를 거절합니다. | `skill-state/active-state.ts:651-664` | spec D-HL2 | — |
| 13 | `start`만 상태를 시드합니다. 키워드·mention·skill 로드는 시드하지 않습니다. | `hooks/skill-state.ts:387-510`, `AGS:13565-13626` | spec D-HL3 | — |
| 14 | 편집 가드는 shell 명령을 분류하지 않습니다(PQ-10 B). | `MG:41,1475-1610,1677-1682` | ralplan deviation 11과 같은 판단, spec E12 | — |
| 15 | 압축 복구 문맥을 넣습니다. | `AGS:16190-16205` | spec D-HL6 | — |
| 21 | `doctor`에 checksum·고아 저널 검사가 없고 결과는 텍스트입니다(PQ-24 A). | `STR:424-648` | spec D-SR10, ralplan deviation 13 | — |
| 22 | 평문 질문을 감지하는 코드가 없습니다. skill의 평문 질문 규칙은 남깁니다. | `hooks/skill-state.ts:816-836` | spec D-IF7 | — |
| 24 | 도구를 `open-gajae` 밖의 agent에게서 숨깁니다. | `tools/bash-allowed-prefixes.ts` | spec D-HL7 | — |
| 38 | `--deliberate`를 `spec(…, handoff: "ralplan")` 호출 하나로 합쳤고, `spec`에 `--force`가 없습니다. | `RT:416-478`(플래그 `:444-476`) | spec D-SR1, SD-11 | 결합 호출은 늘 deliberate. 같은 slug의 스펙은 덮어씀(spec D-SH1) |

### 수용한 동작 차이

| 항목 | 동작 | 근거 | 영향 |
|---|---|---|---|
| `deep-interview`가 숨겨지는 범위(spec D-HL7) | `context` 훅이 `open-gajae`를 뺀 모든 agent의 요청에서 `deep-interview` 도구를 지웁니다. host `build`·`general`, 사용자 정의 agent, 자체 역할이 모두 포함되며, 자체 역할은 `roleRules`에서도 거부됩니다. | ralplan의 수용 차이 "`ralplan`·`ultragoal`·`goal`이 숨겨지는 범위" | 다른 agent는 보지도 부르지도 못함 |
| 이전 execution에서 불러온 deep-interview(K1) | 로드 게이트는 deep-interview를 불러온 execution 안에서만 걸립니다. 다음 execution의 `skill ralplan`·`ultragoal` 로드는 그 skill을 시작하고, GJC처럼 deep-interview 행만 지우고 상태는 활성으로 남습니다. | GJC 턴 표식(`AGS:8038-8046`) | `deep-interview clear`로 복구 |
| 결합 호출의 부분 결과(K11) | `spec(…, handoff: "ralplan")`은 세 단계를 차례로 돌고, 뒤 단계가 실패하면 앞 단계의 결과(스펙, ralplan 시드)가 남습니다. GJC와 같습니다(PQ-18 A). | `RT:805-855` | `deep-interview status`, `ralplan status`로 확인하고 `deep-interview handoff(to: "ralplan")`로 이어 감 |

## 필수 후속 개발

아래 항목은 정책으로 기록한 필수 후속 작업입니다. 2번과 3번은 ultragoal 개정(브랜치 `feat/ultragoal-gjc-revision`)으로, 1번과 7번은 deep-interview 개정(브랜치 `feat/deep-interview-gjc-revision`)으로 해결되었고 번호는 그대로 둡니다. 나머지는 아직 구현되지 않았습니다. ultragoal의 열린 한계와 후속 작업, 그리고 옛 후속 번호(U1–U34) 대응표는 [`docs/skills/ultragoal/known-limits.md`](docs/skills/ultragoal/known-limits.md)에 있습니다.

1. **deep-interview 활성 행 설계 — 해결.** deep-interview는 이제 자기 `deep-interview` 도구로 GJC 활성 행과 HUD 칩을 쓰며, 넘겨받을 때도 `interviewing`으로 행을 씁니다(ralplan deviation 14와 ultragoal deviation 33 철회. [Deep interview](#deep-interview) 참고). 칩을 그리는 일은 TUI 사이드바(6번)에 남습니다.
2. **ultragoal을 GJC 방식으로 개정 — 해결.** ultragoal은 이제 GJC ultragoal 런타임과 goal 모드를 따릅니다: 리뷰어 brief와 `record_verdict`는 없어졌고, 역할 고유의 판정이 quality gate에 들어가며, 테스트는 executor QA 레인에서 돕니다([Ultragoal](#ultragoal), [GJC로부터의 deviation (ultragoal)](#gjc로부터의-deviation-ultragoal) 참고).
3. **승인 라벨 정렬 — 해결.** `skills/ultragoal/SKILL.md`는 이제 GJC처럼 ralplan 승인 선택지를 **Approve execution via ultragoal**로 부릅니다.
4. **알려진 한계(기록만, 일정 없음).** 한 worktree에서 여러 OpenCode 프로세스가 동시에 작업하면 서로 직렬화되지 않습니다: 플러그인은 한 프로세스 안에서만 쓰기를 큐에 넣고, GJC는 파일 잠금을 씁니다.
5. **항상 차단 경로의 대소문자.** 항상 차단 경로 검사(`.open-gajae/_session-*/state/**`, `plans/ralplan/**`, ultragoal 파일)는 대소문자를 구분해 비교하므로, 대소문자를 구분하지 않는 파일 시스템(macOS 기본)에서는 `.OPEN-GAJAE/…`처럼 대소문자만 다른 경로가 계획 가드가 없는 때 이 검사를 빠져나갑니다. 이 검사들의 대소문자를 정규화합니다(관리자 결정 R-OD13).
6. **TUI 진행 사이드바(보류, R-OD17).** spec이 계획한 ralplan 사이드바(D-H3~D-H7)는 이식 브랜치 `feat/ralplan-gjc-stage-trail`에서 만들었다가(`tui-plugin/`, 커밋 `96e9176`, 수정 `eb85dde`·`0cbb491`) 병합 전에 제거했습니다. 배포된 OpenCode 2.0.15 바이너리(Bun 1.4.2로 컴파일)는 TUI 플러그인의 bare import(`solid-js`, `@opentui/solid`, `@opentui/core`, `@opencode/plugin/tui`)를 호스트 인스턴스로 연결하지 않습니다. 로컬 패키지가 없으면 플러그인 로드가 실패하고, 있으면 별도 사본을 불러와 요소를 만들 때 `No renderer found`가 나서 아무것도 그려지지 않습니다. OpenCode 자체 테스트는 이 연결을 기대하지만(`tui/test/plugin-source.test.ts`, "shared runtime and ordinary package identities survive plugin generations"), 컴파일하지 않은 상태에서 돕니다. 2026-09-29 수동 확인에서는 플러그인이 호스트의 가상 모듈 `opentui:runtime-module:<specifier>`(`@opentui/core` 0.5.10 `runtime-plugin.js`의 내부 명명 규칙)에서 호스트 인스턴스를 가져오면 블록이 그려졌습니다. 호스트가 플러그인 import를 연결하게 되면, 또는 그 우회를 호스트 통합 deviation으로 기록해 사이드바를 다시 넣습니다. 로컬 파일을 읽으므로 원격 서버에 attach한 TUI는 계속 지원하지 않습니다.
7. **deep-interview 도구 숨김 — 해결.** `deep-interview` 도구는 다른 workflow 도구처럼 `open-gajae` 전용이고 다른 모든 agent에게서 숨겨집니다(deep-interview deviation 24). 옛 상태 도구 3개(`state_*`)는 사라졌습니다.

## 검증 근거와 한계

이 이식이 정의하는 검증 계층은 `@opencode/plugin` 2.0.15에서의 `bun run typecheck`/`bun test`, prompt hook·permission rule 생성·continuation과 goal 루프·도구 숨김·artifact guard·state/code tool·공통 skill-state 기반·`ralplan` 도구와 런타임(`tests/fixtures/gjc-ralplan/`의 GJC 픽스처와의 key 집합 비교 포함)·`ultragoal`과 `goal` 도구와 런타임(텍스트 결과를 줄 단위로 확인)·`deep-interview` 도구와 런타임과 그 훅(`tests/deep-interview-runtime.test.ts`, `tests/deep-interview-tool.test.ts`, `tests/hooks.test.ts`의 H 사례)에 대한 unit test, 로컬 OpenCode 2.0.15 바이너리를 대상으로 한 host probe(`tests/host-probe.ts`, `tests/host-session-probe.ts`, `tests/planner-permission-probe.ts`, `tests/package-probe.ts`, `tests/ralplan-trail-probe.ts`), 그리고 `openai/gpt-6-luna`로 키워드 진입, ralplan 중 Esc interrupt, `experimental.subagent_depth` 유무에 따른 planner delegation, 단계 파일·Stop here·인계까지의 ralplan 1회 실행, 목표 계획·목표별과 final gate·재오픈·ralplan 왕복 인계·보류·도구 숨김까지의 ultragoal 1회 실행, 그리고 기본 흐름과 측면 리뷰 패널까지의 deep-interview 1회 실행을 다루는 manual checklist(`docs/local-install-v2.md` 5절과 7절)입니다. 이들의 현재 pass/fail 상태는 이식의 plan과 ledger가 관리하며 이 문서가 주장하지 않습니다.

이 계층들은 호스트 probe에 필요할 때 가짜 provider를 쓰는 결정적 transport·source-contract 검사입니다. 실제 모델 행동 검증이나 LLM obedience, prompt branch 보장, injection resistance, model 의미적 품질, external credential, 설치된 language server의 의미적 정확성 증거는 아닙니다. GJC 메인 프롬프트의 실제 모델 대화 확인은 GJC 프롬프트 plan의 사용자 전용 체크리스트에 따라 사용자가 맡으며, 여기서는 수행하지 않았습니다. LSP server는 자동 다운로드되지 않습니다. 이 가이드는 동작과 evidence scope를 기록하며 독립 completion proof는 durable delivery ledger에 둡니다.
