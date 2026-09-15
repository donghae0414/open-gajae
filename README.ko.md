[English](README.md) | [한국어](README.ko.md)

# open-gajae

OMC의 철학과 행동 계약에 맞춰 정렬 중인 OpenCode 플러그인입니다. OpenCode는 호스트이며 구현 대상이 아닙니다. OpenCode 본체는 수정하지 않습니다.

## 개발 방향과 현재 상태

- **Phase 1:** OMC를 기능·워크플로·agent 역할 계약의 기준으로 삼습니다. 호스트 전용 연결은 OpenCode의 native API·권한에 맞게 이식하고 필요한 차이는 기록합니다.
- **Phase 2:** Phase 1 완성 후 OMX를 분석하고 장점을 선별 도입합니다. OMX는 Phase 1 설계 원천이 아니며, OMO는 제품 정책이 아닌 호스트 연결 구현의 참고로만 사용합니다.
- **현재 구현:** deep-interview와 자체 primary/read-only explore에는 OMC·OMX 혼합 계약과 OMO 유래 agent 지침이 남아 있습니다. 아래 사용법·동작 설명은 이 현재 구현을 설명하며 OMC 정렬 완료를 뜻하지 않습니다. 실행 프롬프트·검증 코드·테스트는 별도 구현 변경에서 함께 수정해야 합니다.
- **구현 정렬 전 결정:** Phase 1 기능 범위·기준 OMC 커밋·완료 검증 조건을 확정합니다. 현재 기능 목록이 OMC 전체 이식을 약속하는 것은 아닙니다.

개발 정책의 기준은 [AGENTS.md](AGENTS.md)입니다. 전환 중에도 남아 있는 파생물의 출처와 라이선스 조건은 유지합니다.

## 빌드와 로컬 등록

Bun과 plugin/SDK **1.18.30**에 호환되는 OpenCode가 필요합니다.

```sh
bun install
bun run typecheck
bun test tests/state.test.ts tests/integration.test.ts
bun run build
```

플러그인 구현을 갱신해도 로컬 설정은 바뀌지 않습니다. 배포한 갱신본을 사용하기 전에 `dist/`를 다시 빌드하고 OpenCode를 재시작하세요.

`dist/`, `skills/`, `prompts/`, `licenses/`, `THIRD-PARTY-NOTICES.md`를 함께 유지하세요. dist/index.js만 복사하면 자산을 찾을 수 없습니다.

**로컬 설정 변경 승인 후**, 기존 OpenCode JSONC 원문을 보존하고 다른 설정/plugin을 유지한 채 등록 항목 하나만 변경합니다.

```jsonc
{ "plugin": ["file:///Users/dongwuk/apps/open-gajae/dist/index.js"] }
```

전체 설정 파일을 위 예시로 덮어쓰는 것이 아닙니다. 기존 로컬 URI의 `apps/opengajae`는 하이픈이 빠진 경로입니다. 실제 빌드 자산 확인 후 해당 항목만 교체하세요. 실패 시 기존 원문과 변경한 dedicated 설정을 복구하고 OpenCode를 재시작합니다. 플러그인은 로컬 host 설정을 자동 변경하지 않습니다.

```sh
opencode debug skill
opencode debug agent open-gajae
opencode debug agent open-gajae-explore
opencode --model openai/gpt-5.6-luna
opencode --model openai/gpt-5.6-terra
```

실제 skill source와 UI의 `/deep-interview` 노출을 확인하고 primary는 UI에서 선택합니다. 기본 agent를 강제 변경하지 않습니다. 동명 command/explorer 정의와 configured skill paths의 중복 이름은 오류로 알립니다. `agent.open-gajae`는 기본 primary에 대한 사용자 덮어쓰기 설정으로 받습니다. host가 발견한 전역/원격 skill 충돌도 debug source로 확인하세요. 별도 discovery 엔진은 만들지 않습니다.

## 사용

- `/deep-interview <아이디어>`: 현재 host session에 인터뷰 시작.
- `/deep-interview resume`: 저장된 상태와 실제 tool 기록을 확인해 명시적으로 재개. 취소·미해결 질문 대기는 추가 확인이 필요하며 자동 부활하지 않습니다.
- `/deep-interview cancel`: 취소를 기록합니다.
- build/plan에서도 같은 명시 호출을 사용하며 내장 정의는 바꾸지 않습니다.

프롬프트는 native question 도구로 한 번에 한 질문을 제시하도록 요구합니다. 도구 가용성은 호스트가 결정하며 플러그인이 모델의 호출을 강제하지는 않습니다. 호출되면 native 도구가 응답 대기와 수신을 처리하고, 도구 반환 뒤 모델은 자연스럽게 계속합니다. 일반 채팅 답변을 원생 질문 답변으로 대체 처리하지 않습니다. 도구를 사용할 수 없거나 거부되면 우회하지 말고 그 상태를 보고하고 중단합니다. OMC Round0/Topology·3/4차원 점수·ontology와 OMX 동일 주제 심화·Fact/Judgment·리듬·closure를 조합합니다. `[from-code][auto-confirmed]`, `[from-code]`, `[from-research]`, `[from-user]`는 **transcript/spec 라벨**이며 runtime question `source`가 아닙니다. 고신뢰 기술 사실 자동 기록은 요구 질문 round에 포함하지 않고 목표·범위·트레이드오프 판단은 사용자에게 묻습니다.

공개 도구는 `state_read`, `state_write`, `deep_interview_spec` 세 개입니다. 모델 snapshot은 merge가 아닌 대체이며 명시 인자가 우선합니다. `_runtime`/`_meta`는 host 소유로 제출할 수 없습니다. 상태는 `.open-gajae/state/sessions/<session>/`, 명세는 `.open-gajae/specs/<session>/<interview>.md`에 저장됩니다. 로컬 대화/명세의 공개 여부에 주의하세요. 명세 저장은 구현 승인이나 미구현 downstream 호출이 아닙니다.

### 원생 질문 권한

OpenCode 1.18.30은 custom agent에 기본적으로 `question: deny`를 적용하며, 내장 build/plan에는 별도로 허용합니다. 이제 플러그인은 사용자 전역·primary 권한에 question과 일치하는 규칙이 없으면 `open-gajae`에 `question: allow`를 기본 적용합니다. 명시적 규칙(`*` 및 권한 이름 와일드카드 포함)은 호스트 순서 그대로 전역 → 개별 agent 순으로 적용됩니다. 사용자 거부 뒤에 허용을 추가하거나 별도 권한 정책을 평가하지 않습니다. `opencode debug agent open-gajae`로 최종 권한을 확인하세요.

기본 동작을 위해 별도 허용 설정은 필요 없습니다. 덮어쓰려면 기존 설정을 유지하면서 **OpenCode의 `opencode.jsonc`**에 다음 항목을 합칩니다. 아래는 primary의 질문을 거부하는 예시이며, 플러그인의 모델 설정 파일에 넣는 항목이 아닙니다.

```json
{
  "agent": {
    "open-gajae": {
      "permission": { "question": "deny" }
    }
  }
}
```

`"allow"`나 `"ask"`로 바꾸면 해당 원생 동작을 선택할 수 있습니다. build/plan처럼 개별 규칙으로 전역 규칙을 덮어쓸 수 있습니다. explorer의 deny 7개와 중복 정의 거부는 유지합니다. 호스트의 도구 가용성 및 모델의 지침 준수는 권한과 별개입니다.

## 자체 agent·모델 설정

사용자 `~/.open-gajae/open-gajae.jsonc`, 프로젝트 `<project>/.open-gajae/open-gajae.jsonc`에서 항목별 **프로젝트→사용자→기본값** 우선순위를 적용합니다. 잘못된 JSONC/알 수 없는 key/타입은 조용한 fallback이 아니라 경로·key 오류입니다.

OpenCode의 `agent.open-gajae` 설정은 위 플러그인 설정에서 선택한 model/variant를 포함해 해당 primary 필드보다 우선합니다. 지정하지 않은 필드는 기본값을 유지하며, 권한 우선순위는 앞 절을 따릅니다.

```jsonc
{
  "deepInterview": { "ambiguityThreshold": 0.20, "maxRounds": 20 },
  "agents": {
    "open-gajae": { "model": "openai/gpt-5.6-luna" },
    "open-gajae-explore": { "model": "openai/gpt-5.6-terra" }
  }
}
```

위 배치는 형태 예시이지 기본값/성능 분업 권고가 아닙니다. 소유 두 역할에 optional `variant`도 지정할 수 있습니다. 미지정 model/variant는 property를 넣지 않아 native 현재/부모 경로를 따릅니다. runtime TUI 선택을 존중하며 매 호출 정규화·fallback 엔진·semantic variant validator는 없습니다. native가 없는 variant를 오류 대신 생략할 수 있으므로 실제 적용/생략을 확인해야 합니다.

`open-gajae`는 일반 작업을 직접 처리하고 repo 사실 조사만 `open-gajae-explore`에 위임합니다. explore는 OMC·OMX 원문을 조합한 자체 역할이며 내장 explore의 alias가 아닙니다. 내장 build/plan/explore/general·global 권한·default agent를 변경하지 않습니다. 자체 leaf에는 edit/bash/task/external_directory/question/state_write/deep_interview_spec의 **deny 7개만** 추가하며 사용자 read/task 제한을 푸는 late allow를 넣지 않습니다. 접근 불가는 미확인 근거로 반환합니다.

## 한계와 검증

- 인터뷰 중 제품 변경 금지는 지침과 기존 host 권한에 의존합니다. 전역 hard guard·전자손 격리·OS sandbox·unknown MCP 전체 격리를 보장하지 않습니다.
- leaf의 deny 7개는 추가하는 agent 규칙이지 host의 최종 정책이 아닙니다. OpenCode는 tool-output 디렉터리 접근과 부모 session의 external_directory 규칙을 뒤에 결합하므로 외부 읽기 예외가 남을 수 있습니다. repo-local 지침을 최종 디렉터리 sandbox라고 표현하지 않습니다.
- slash lifecycle 변경 전 public command의 실제 `source: skill`과 bundled base directory를 확인해 MCP/다른 skill의 가림을 거부합니다. 악의적인 template 위조에 대한 인증 장치가 아니며 host가 before-hook 전에 실행한 template shell을 되돌리지 못합니다.
- deep-interview에는 post-idle 계속, `promptAsync` 재주입, one-shot correction·budget·obligation 엔진이 없습니다. 취소·오류·restart/resume는 durable 상태와 실제 tool 기록을 대조해 조정하며 자동 재개하지 않습니다.
- 동일 process/session 변경은 queue와 atomic rename으로 처리합니다. 여러 plugin process가 같은 session을 동시에 쓰는 것은 지원하지 않습니다.
- 부분 명세 저장 뒤 명시 확인으로 복구하면 기존 interview ID와 원래 파일은 보존하고 새 `-rN.md` receipt 경로를 사용합니다.
- custom state만 UTF-8 1 MiB·depth10·top-level key100 제한을 적용합니다. 전체 runtime/spec 자원 한도가 아닙니다.
- fixture/package 검증은 실제 모델의 지침 준수나 live host E2E 증거가 아닙니다. **M0** 등록/자산/충돌/복구, **M1** 인터뷰/라벨/Topology/Ontology/정상·상한 명세, **M2** 질문 대기/닫힘/사용 불가·거부/cancel·오류/restart/resume, **M3** 자체 explore 실제 호출/모델 상속·명시/TUI/권한 거부를 ordinary luna·terra 각각으로 확인하고 자동 결과와 분리 기록하세요. 모델 목록 존재만으로 인증/추론 성공을 주장하지 않습니다.

FOLLOWUP-01: 실제 downstream skill이 생길 때 인계·승인/취소/실패 처리를 추가합니다. FOLLOWUP-02: 이후 specialist가 생기면 primary 라우팅·모델 목록·권한·검증도 함께 갱신합니다. 최초 자체 explore는 이번 범위입니다.

[이식 분석](docs/analysis/opencode-porting-guide.md), [제3자 고지](THIRD-PARTY-NOTICES.md)를 참고하세요. OMC/OMX MIT와 OMO Sustainable Use License 고지·수정 표시·이용/배포 조건을 유지하며 전체를 무제한 MIT로 표시하지 않습니다. 배포 목적이 바뀌면 적용 조건을 다시 확인하세요.
