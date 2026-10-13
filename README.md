<div align="center">
  <img src="apps/web/public/icons/ling-mark.svg" alt="Ling Stack" width="88" height="88" />
  <h1>Ling Stack</h1>
  <p><strong>Bring AI teammates into one local project workspace.</strong></p>
  <p>Choose their models. Keep conversations, tool approvals, and results together.</p>
  <p>
    English · <a href="README.zh-CN.md">简体中文</a> ·
    <a href="README.ja-JP.md">日本語</a> · <a href="README.ko-KR.md">한국어</a> ·
    <a href="README.de-DE.md">Deutsch</a> · <a href="README.fr-FR.md">Français</a> ·
    <a href="README.es-ES.md">Español</a> · <a href="README.pt-BR.md">Português (Brasil)</a>
  </p>
  <p>
    <img alt="Source alpha" src="https://img.shields.io/badge/Status-source_alpha-5964a0.svg" />
    <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-08765d.svg" /></a>
    <img alt="Node.js 22.22.1+" src="https://img.shields.io/badge/Node.js-22.22.1%2B-3c873a.svg" />
    <img alt="pnpm 10" src="https://img.shields.io/badge/pnpm-10-f69220.svg" />
  </p>
  <p>
    <a href="docs/community/first-project-review.md">Try a project review</a> ·
    <a href="docs/getting-started.md">Getting started</a> ·
    <a href="docs/troubleshooting.md">Troubleshooting</a> ·
    <a href="docs/architecture.md">Architecture</a> ·
    <a href="CONTRIBUTING.md">Contributing</a> ·
    <a href="CHANGELOG.md">Changelog</a>
  </p>
</div>

> [!NOTE]
> **Source-first alpha.** Start with the Web UI, local daemon, and CLI from source.
> Desktop development is available separately; stable signed installers and a supported
> production release are not available yet.

## Start With One Shared Task

When work involves several models, the task, their responses, tool requests, and results
can end up in separate windows. Ling Stack brings that work into a project channel:
give teammates model and tool bindings, review their activity, and keep the outcome
with the conversation.

Try a bounded [project document review](docs/community/first-project-review.md) with
two teammates and a [public sample brief](examples/project-review/README.md). Begin
with discussion; add tools and permissions when a later task needs them. Your own
provider configuration and API key are required, and provider charges apply.

![Ling Stack English homepage in a fresh workspace](docs/assets/ling-workspace-home.jpg)

English interface in a fresh local workspace before configuring a model. This capture
shows the workspace layout, not a completed task. Follow the review guide above to
try your own first collaboration.

## Who Is It For?

Ling Stack is for developers and people who work with several AI models or teammates
and want to keep their work in one place. It connects OpenAI, Anthropic, Volcengine Ark,
DeepSeek-compatible endpoints, MiniMax, GLM, and OpenAI-compatible relays through a
shared Model Workbench.

Workspace state, conversation history, and run evidence are stored locally. Requests
and their context go to the model or tool providers you choose. The interface offers
55 language and region options; interface language and AI response language can be
configured separately. README translations cover the eight languages linked above,
not every interface locale. Other documentation may still be in English or Chinese.

## Three Ways To Use It

| Scenario | What you do | What stays together |
| --- | --- | --- |
| Ask a model | Configure a chat model and start a conversation about a document, idea, or project | Messages, model selection, attachments, and results |
| Work with AI teammates | Give teammates model and tool bindings, then collaborate in a project channel | Participants, tool activity, approvals, artifacts, and the final report |
| Create media | Configure an image or video capability and use Media Production | Projects, scenes, generation jobs, and outputs |

Begin with a simple conversation, then add teammates or tools when the work needs them.
Skills provide instructions; tool access and permission remain explicit. Coding-agent
work uses the Pi runtime adapter, and available execution tools depend on platform setup
and workspace policy.

## Quick Start From Source

Requirements: Git, Node.js **22.22.1 or newer**, and **Corepack with pnpm 10**.
The repository pins pnpm `10.0.0`; Node `22.22.1` is the CI baseline.

### 1. Install and build the local Web stack

```bash
git clone https://github.com/ling-stack-org/ling-stack.git
cd ling-stack
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm --workspace-concurrency=1 --filter '@ling-stack/cli...' -r build
```

The filtered build includes the CLI, daemon, Web app, and their workspace dependencies.
Desktop and Mobile builds have separate setup requirements.

### 2. Start the daemon

Keep this command running in the first terminal, from the repository root:

```bash
corepack pnpm ling daemon start --foreground
```

The default daemon address is `http://127.0.0.1:17891`. Keep it on loopback.

### 3. Open the Web UI

In a second terminal, from the same repository root:

```bash
corepack pnpm ling ui --foreground --open
```

Open `http://127.0.0.1:5173` if the browser does not open automatically. In another
terminal, `curl http://127.0.0.1:17891/health` should return JSON with `"ok": true`.

### 4. Connect a model and try a conversation

Open **Settings → Model Workbench**, add a chat-capable model with your own API key,
and run **Check**. The first verified chat model becomes the workspace default. Start
a new conversation and ask a small question, then inspect the response and its details.

After configuring and checking the model, run:

```bash
corepack pnpm ling doctor
```

Doctor reports model readiness as well as local service health. A fresh workspace with
no chat model reports a provider failure even when the daemon and Web UI are running.

Follow [Getting started](docs/getting-started.md) for the first model, conversation,
and project channel. See [Troubleshooting](docs/troubleshooting.md) for setup errors.

## Support And Limits

| Surface or integration | Current scope |
| --- | --- |
| Web, daemon, and CLI | Source alpha; the default getting-started path |
| Electron Desktop | Development shell; platform setup and clean-machine acceptance remain separate gates |
| Chrome extension and Browser Host | Local development integration; Chrome Web Store publication pending |
| MCP and Plugin Manager | Explicit tool assignment, activation, and approval boundaries |
| Office and Computer Use native features | Platform-dependent development; consult the maintained implementation and release gates |
| Image and video generation | Provider- and capability-dependent; selected live adapters still have open gates |
| Mobile | Experimental work outside the current product acceptance scope |

Platform execution, accessibility, signing, and installer acceptance remain open for
selected native features. The [Implementation Status](docs/design/implementation-status.md)
index records what is implemented and what still needs acceptance. A source build or
focused test result does not establish installer readiness.

For questions and reproducible bugs, read [Support](SUPPORT.md) and use the
[GitHub Issue forms](https://github.com/ling-stack-org/ling-stack/issues/new/choose).
Maintenance is best effort. Report vulnerabilities through [Security](SECURITY.md).

### Desktop development

Desktop has additional requirements: Xcode Command Line Tools with Swift and `codesign`
on macOS, or the .NET 8 SDK on Windows for the Office driver. The current Desktop
distribution targets are macOS arm64 and Windows x64. Electron also needs its platform
binary; see [Desktop troubleshooting](docs/troubleshooting.md#desktop-development).

```bash
corepack pnpm --filter @ling-stack/desktop dev
```

For platform tools, build commands, and manual checks, follow the
[Mac and Windows development-package guide](docs/release/development-packages.md).
Read [Desktop release and acceptance](docs/release/desktop.md) before packaging for
distribution. Public source publication and signed binary releases are separate steps.

## Data And Permissions

Default workspace state is under `.ling-stack/`, including `ling-stack.sqlite`,
`sessions/`, `artifacts/`, and `logs/`. Provider keys entered in Model Workbench are
saved in local workspace storage. Environment and supported keychain references are
also available; see [Configuration and data](docs/getting-started.md#configuration-and-data).

Keep keys, databases, session logs, and private outputs out of Git and public reports.
Workspace permissions govern file access, shell commands, external mutations, and paid
generation. Review approval requests before accepting them. For storage migration, use
the [CLI storage flows](docs/design/workspace-state-storage.md).

## Explore Or Contribute

If this workflow is useful to you, star the repository to follow its progress. Tell us
what you tried, where the first task got stuck, and whether the result helped through
the [Issue forms](https://github.com/ling-stack-org/ling-stack/issues/new/choose).

- [README translation guidelines](CONTRIBUTING.md#readme-translations): help keep the language versions aligned.
- [First project review](docs/community/first-project-review.md): a small collaboration trial.
- [Community launch kit](docs/community/launch-kit.md): introduction drafts and first-user feedback plan.

The Web app (`apps/web`), Desktop shell (`apps/desktop`), and CLI (`packages/cli`) share
the daemon (`packages/daemon`). Core domain logic, contracts, provider adapters, and
runner integrations live under `packages/`.

- [Contributing](CONTRIBUTING.md): setup, focused checks, and pull request expectations.
- [Architecture](docs/architecture.md) and [Daemon API](docs/daemon-api.md): system boundaries.
- [Design index](docs/design/README.md) and [Implementation Status](docs/design/implementation-status.md): maintained contracts and acceptance gates.
- [Provider adapters](docs/provider-adapters.md) and [Pi integration](docs/pi-coding-agent-integration.md): model and runtime integration.
- [Release policy](docs/release/README.md), [Changelog](CHANGELOG.md), and [Third-party notices](THIRD_PARTY_NOTICES.md): publication and licensing.

Ling Stack is available under the [MIT License](LICENSE). Community participation
follows the [Code of Conduct](CODE_OF_CONDUCT.md).
