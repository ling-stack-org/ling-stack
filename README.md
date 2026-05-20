# Ling Stack

Ling Stack is a local-first AI teammate workspace for developers and small teams.

It is designed to connect humans, AI teammates, tasks, approvals, tools, and model providers in one auditable workspace. The first-class targets are Chinese users, domestic model providers, GPT, Claude, and any OpenAI-compatible relay.

## Product Direction

Ling Stack is not another chat client. The core product surface is a workspace:

- Channels as shared context containers.
- Tasks as the smallest executable unit of AI work.
- AI teammates with scoped tools, memory, budgets, and approval rules.
- Runtime sessions with logs, artifacts, diffs, and replayable evidence.
- Human approval gates for file writes, external sends, deployments, and other risky actions.
- Provider adapters for GPT, Claude, Doubao, DeepSeek, MiniMax, GLM, Jimeng, and generic OpenAI-compatible APIs.

## Initial Scope

The v0.1 target is a single-user local workspace:

- CLI first.
- Local daemon API.
- Local web UI.
- SQLite metadata store.
- File-based session logs and artifacts.
- Provider health checks.
- OpenAI-compatible, OpenAI, Anthropic, Doubao, MiniMax, GLM, DeepSeek, and Jimeng adapter foundations.

Desktop apps for macOS, Windows, and Linux come after the local daemon and CLI are useful.

## Repository Layout

```text
apps/
  web/          Local workspace UI.
  desktop/      Future cross-platform desktop shell.
packages/
  core/         Workspace, tasks, approvals, sessions, and policy engine.
  cli/          Command-line interface.
  daemon/       Local HTTP/WebSocket API.
  providers/    Model and media provider adapters.
  runner-pi/    Pi coding-agent wrapper used as the first execution kernel.
docs/
  product-design.md
  architecture.md
  daemon-api.md
  provider-adapters.md
  pi-coding-agent-integration.md
examples/
```

## Provider Targets

First-class providers:

- OpenAI GPT models.
- Anthropic Claude models.
- Doubao / Volcengine Ark.
- DeepSeek V4 / compatible DeepSeek endpoints.
- MiniMax.
- GLM / Zhipu.
- Jimeng / Seedream / Seedance for image and video generation.
- Generic OpenAI-compatible relay endpoints.

Provider support is capability based. Ling Stack should not pretend every provider is only a chat model.

## Status

Design scaffold. No production runtime yet.

The first coding-agent runtime is intentionally built on `@earendil-works/pi-coding-agent`; see [docs/pi-coding-agent-integration.md](docs/pi-coding-agent-integration.md).

## License

MIT.
