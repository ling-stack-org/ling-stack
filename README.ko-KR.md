<div align="center">
  <img src="apps/web/public/icons/ling-mark.svg" alt="Ling Stack" width="88" height="88" />
  <h1>Ling Stack</h1>
  <p><strong>하나의 로컬 프로젝트 작업 공간에서 AI 팀원과 함께 작업하세요.</strong></p>
  <p>모델을 선택하고, 대화와 도구 승인, 결과를 한곳에 모으세요.</p>
  <p>
    <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.ja-JP.md">日本語</a> · 한국어 ·
    <a href="README.de-DE.md">Deutsch</a> · <a href="README.fr-FR.md">Français</a> ·
    <a href="README.es-ES.md">Español</a> · <a href="README.pt-BR.md">Português (Brasil)</a>
  </p>
  <p>
    <img alt="소스 코드 알파" src="https://img.shields.io/badge/Status-source_alpha-5964a0.svg" />
    <a href="LICENSE"><img alt="라이선스: MIT" src="https://img.shields.io/badge/License-MIT-08765d.svg" /></a>
    <img alt="Node.js 22.22.1+" src="https://img.shields.io/badge/Node.js-22.22.1%2B-3c873a.svg" />
    <img alt="pnpm 10" src="https://img.shields.io/badge/pnpm-10-f69220.svg" />
  </p>
</div>

> [!NOTE]
> **소스 코드 실행을 우선하는 알파 버전입니다.** 먼저 소스에서 Web UI, 로컬 daemon, CLI를 실행하세요.
> Desktop 개발 환경은 별도로 사용할 수 있습니다. 안정적인 서명된 설치 프로그램과 정식으로 지원하는 프로덕션 릴리스는 아직 제공하지 않습니다.

## 하나의 공동 작업부터 시작하기

여러 모델을 사용하면 작업, 응답, 도구 실행 요청, 결과가 서로 다른 창에 흩어지기 쉽습니다.
Ling Stack은 이를 프로젝트 채널에 모읍니다. 팀원에게 모델과 도구를 할당하고, 활동을 확인하며, 결과를 대화와 함께 보관할 수 있습니다.

두 명의 팀원으로 범위를 제한한 [프로젝트 문서 검토](docs/community/first-project-review.md)를 시도해 보세요.
[공개 예제](examples/project-review/README.md)도 제공합니다. 처음에는 대화만 진행하고, 이후 작업에 필요한 도구와 권한을 추가하세요.
직접 모델 서비스를 설정하고 자신의 API 키를 사용해야 하며, 서비스 이용 요금은 사용자가 부담합니다.

![새 작업 공간의 Ling Stack 영어 UI](docs/assets/ling-workspace-home.jpg)

모델 설정 전의 로컬 작업 공간을 실제로 촬영한 영어 UI입니다. 이 이미지는 작업 공간의 배치를 보여 주며, 작업이 완료되었다는 증거는 아닙니다.
위의 검토 가이드로 첫 협업을 시작할 수 있습니다.

## 누구를 위한 도구인가요?

여러 AI 모델이나 팀원을 활용하면서 작업을 한곳에서 관리하고 싶은 개발자와 사용자를 위한 도구입니다.
공통 Model Workbench에서 OpenAI, Anthropic, Volcengine Ark, DeepSeek 호환 엔드포인트,
MiniMax, GLM, OpenAI 호환 중계 서비스를 연결할 수 있습니다.

작업 공간 상태, 대화 기록, 실행 증거는 로컬에 저장됩니다. 요청과 해당 컨텍스트는 선택한 모델 또는 도구 서비스로 전송됩니다.
**로컬 저장이 오프라인 추론을 의미하지는 않습니다.** 인터페이스에는 55개의 언어 및 지역 옵션이 있으며, UI 언어와 AI 응답 언어는 각각 설정할 수 있습니다.
README는 상단에 링크된 8개 언어로 제공됩니다. 다른 문서는 여전히 영어 또는 중국어일 수 있습니다.

## 세 가지 사용 방식

| 시나리오 | 수행할 작업 | 함께 보관되는 내용 |
| --- | --- | --- |
| 모델에 질문하기 | 채팅 모델을 설정하고 문서, 아이디어, 프로젝트에 대해 대화 | 메시지, 모델 선택, 첨부 파일, 결과 |
| AI 팀원과 협업하기 | 모델과 도구를 할당하고 프로젝트 채널에서 협업 | 참여자, 도구 활동, 승인, 산출물, 최종 보고서 |
| 미디어 제작하기 | 이미지 또는 동영상 기능을 설정하고 Media Production 사용 | 프로젝트, 장면, 생성 작업, 출력 |

간단한 대화로 시작하고, 필요할 때 팀원과 도구를 추가하세요. 스킬은 지침을 제공할 뿐 도구나 파일 접근 권한을 자동으로 부여하지 않습니다.
코딩 에이전트는 Pi 런타임 어댑터를 사용합니다. 실제 사용 가능한 도구는 플랫폼 설정과 작업 공간 정책에 따라 달라집니다.

## 소스에서 시작하기

필수 조건: Git, **Node.js 22.22.1 이상**, **Corepack과 pnpm 10**.
저장소는 pnpm `10.0.0`을 고정하며, CI의 Node 기준 버전은 `22.22.1`입니다.

### 1. 설치 및 빌드

```bash
git clone https://github.com/ling-stack-org/ling-stack.git
cd ling-stack
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm --workspace-concurrency=1 --filter '@ling-stack/cli...' -r build
```

이 빌드는 CLI, daemon, Web 앱과 해당 작업 공간 의존성을 포함합니다. Desktop과 Mobile은 별도 설정이 필요합니다.

### 2. daemon 시작

저장소 루트에서 첫 번째 터미널로 다음 명령을 실행하고, 계속 실행 상태로 두세요.

```bash
corepack pnpm ling daemon start --foreground
```

기본 주소는 `http://127.0.0.1:17891`입니다. 루프백 주소에서만 수신하도록 유지하세요.

### 3. Web UI 열기

두 번째 터미널의 동일한 저장소 루트에서 실행하세요.

```bash
corepack pnpm ling ui --foreground --open
```

브라우저가 자동으로 열리지 않으면 `http://127.0.0.1:5173`에 접속하세요.
다른 터미널에서 `curl http://127.0.0.1:17891/health`를 실행하면 `"ok": true`가 포함된 JSON을 반환해야 합니다.
이 결과는 로컬 서비스가 실행 중임을 확인할 뿐, 모델 사용 준비가 끝났다는 뜻은 아닙니다.

### 4. 모델 연결 및 대화

**Settings → Model Workbench**에서 채팅을 지원하는 모델과 자신의 API 키를 추가한 뒤 **Check**를 실행하세요.
처음으로 검사를 통과한 채팅 모델이 작업 공간의 기본 모델이 됩니다. 새 대화에서 간단한 질문을 보내고 응답과 상세 정보를 확인하세요.

모델을 설정하고 검사한 다음 진단을 실행하세요.

```bash
corepack pnpm ling doctor
```

Doctor는 모델 준비 상태와 로컬 서비스 상태를 함께 확인합니다. 채팅 모델이 없는 새 작업 공간에서는
daemon과 Web UI가 실행 중이어도 공급자 오류를 보고합니다.
첫 모델, 대화, 프로젝트 채널 설정은 [시작 가이드](docs/getting-started.md)를, 설정 오류는 [문제 해결](docs/troubleshooting.md)을 참고하세요.

## 지원 범위와 제한

| 기능 또는 연동 | 현재 범위 |
| --- | --- |
| Web, daemon, CLI | 소스 코드 알파의 기본 시작 경로 |
| Electron Desktop | 개발용 셸. 플랫폼 설정과 깨끗한 환경에서의 검증은 별도 필요 |
| Chrome 확장 및 Browser Host | 로컬 개발용 연동. Chrome Web Store 출시는 아직 진행 전 |
| MCP 및 Plugin Manager | 도구를 명시적으로 할당하고 활성화해야 하며 승인 경계를 준수 |
| Office 및 Computer Use 네이티브 기능 | 플랫폼에 따라 개발 중. 구현 및 릴리스 검증 조건 확인 필요 |
| 이미지 및 동영상 생성 | 공급자와 기능에 따라 다름. 일부 실제 서비스 어댑터는 추가 검증 필요 |
| Mobile | 실험적 개발이며 현재 제품 인수 검증 범위 밖 |

일부 네이티브 기능은 실행, 접근성, 서명, 설치 프로그램 검증이 아직 완료되지 않았습니다.
[구현 상태](docs/design/implementation-status.md)에 구현된 내용과 남은 검증을 기록합니다.
소스 빌드나 일부 테스트의 성공만으로 설치 프로그램이 준비되었다고 판단할 수는 없습니다.

질문과 재현 가능한 버그는 [지원 정책](SUPPORT.md)을 읽고 [GitHub Issue 양식](https://github.com/ling-stack-org/ling-stack/issues/new/choose)으로 알려 주세요.
유지보수는 가능한 범위에서 제공됩니다. 취약점은 [보안 보고 경로](SECURITY.md)를 이용하고, 민감한 정보를 공개 Issue에 올리지 마세요.

### Desktop 개발

macOS에서는 Swift와 `codesign`이 포함된 Xcode Command Line Tools가 필요합니다.
Windows에서는 Office 드라이버용 .NET 8 SDK가 필요합니다. 현재 배포 대상은 macOS arm64와 Windows x64입니다.
Electron의 플랫폼 바이너리도 필요합니다. [Desktop 문제 해결](docs/troubleshooting.md#desktop-development)을 참고하세요.

```bash
corepack pnpm --filter @ling-stack/desktop dev
```

플랫폼 도구, 빌드 명령, 수동 검증은 [Mac 및 Windows 개발 패키지 가이드](docs/release/development-packages.md)에 있습니다.
배포용 패키지를 만들기 전에 [Desktop 릴리스 및 검증](docs/release/desktop.md)을 읽어 주세요.
소스 공개와 서명된 바이너리 배포는 별도 단계입니다.

## 데이터와 권한

기본 작업 공간 데이터는 `.ling-stack/` 아래에 저장되며, `ling-stack.sqlite`, `sessions/`, `artifacts/`, `logs/`를 포함합니다.
Model Workbench에 입력한 API 키도 로컬 작업 공간 저장소에 보관됩니다. 환경 변수와 지원되는 키체인 참조도 사용할 수 있습니다.
[설정과 데이터](docs/getting-started.md#configuration-and-data)를 참고하세요.

키, 데이터베이스, 세션 로그, 비공개 산출물은 Git이나 공개 보고서에 포함하지 마세요.
파일 접근, 셸 명령, 외부 서비스 변경, 유료 생성은 작업 공간 권한의 적용을 받습니다. 승인하기 전에 요청 내용을 확인하세요.
저장소를 이전할 때는 [CLI 저장소 작업](docs/design/workspace-state-storage.md)을 사용하세요.

## 자세히 알아보기와 기여

도움이 되었다면 Star로 업데이트를 팔로우할 수 있습니다. 어떤 작업을 시도했는지, 어디서 막혔는지, 결과가 유용했는지 [Issue 양식](https://github.com/ling-stack-org/ling-stack/issues/new/choose)으로 알려 주세요.

Web (`apps/web`), Desktop (`apps/desktop`), CLI (`packages/cli`)는 공통 daemon (`packages/daemon`)을 사용합니다.
도메인 로직, 계약, 공급자 어댑터, 런타임 연동은 `packages/`에 있습니다.

- [기여 가이드](CONTRIBUTING.md)와 [README 번역 지침](CONTRIBUTING.md#readme-translations): 개발, 검증, 번역 수정.
- [첫 프로젝트 검토](docs/community/first-project-review.md)와 [커뮤니티 공개 자료](docs/community/launch-kit.md): 협업 체험과 피드백.
- [아키텍처](docs/architecture.md)와 [Daemon API](docs/daemon-api.md): 시스템 경계.
- [설계 색인](docs/design/README.md)과 [구현 상태](docs/design/implementation-status.md): 현재 계약과 검증 조건.
- [공급자 어댑터](docs/provider-adapters.md)와 [Pi 연동](docs/pi-coding-agent-integration.md): 모델과 런타임.
- [릴리스 정책](docs/release/README.md), [변경 기록](CHANGELOG.md), [서드파티 고지](THIRD_PARTY_NOTICES.md).

Ling Stack은 [MIT 라이선스](LICENSE)로 제공됩니다. 커뮤니티 참여에는 [행동 강령](CODE_OF_CONDUCT.md)이 적용됩니다.
