# Ling Stack

A multilingual, local-first AI teammate workspace for humans, agents, tools, approvals, and model providers.

Ling Stack connects channels, tasks, runtime sessions, provider routing, artifacts, and human approval gates in one auditable workspace. It initially prioritizes domestic AI vendors while keeping GPT, Claude, and OpenAI-compatible relay entry points first-class.

> Local-first workspace. AI teammates. Channels and tasks. Pi coding-agent runtime. Provider adapters. Approval gates. Auditable sessions. Domestic AI providers first, GPT and Claude included.

## Documentation

- [Product design](docs/product-design.md)
- [Architecture](docs/architecture.md)
- [v0.1 detailed design](docs/v0.1-detailed-design.md)
- [Daemon API](docs/daemon-api.md)
- [Provider adapters](docs/provider-adapters.md)
- [Provider presets](docs/design/provider-presets.md)
- [Approval policy](docs/design/approval-policy.md)
- [Pi coding-agent integration](docs/pi-coding-agent-integration.md)

## Why This Exists

AI coding and agent tools are getting powerful, but most of them still live in separate boxes:

- One chat client for GPT or Claude.
- One local relay for domestic models.
- One coding-agent CLI for file edits.
- One media tool for image or video generation.
- One task tracker for real work.
- One human review process outside the agent runtime.

That split creates operational friction. The model may generate useful work, but the surrounding workflow is still manual: copy the prompt, choose the model, run the tool, inspect the diff, approve the risky action, save the artifact, and explain what happened later.

Ling Stack exists to make that workflow explicit and inspectable. The goal is not another chat window. The goal is a workspace where AI teammates can pick up scoped tasks, run through a maintained agent kernel, produce logs and artifacts, and hand risky actions back to humans for approval.

## The Core Idea

Separate the product layer from the agent kernel.

```text
workspace and channels
+ tasks and AI teammates
+ approval and audit policy
+ provider routing
+ maintained coding-agent kernel
+ streamed runtime events
+ artifacts and session records
```

Ling Stack owns the workspace. Pi owns the first coding-agent runtime.

### Responsibility Layers

| Layer | Purpose | Current path |
| --- | --- | --- |
| Workspace | Channels, tasks, teammates, approvals, artifacts | `packages/core` |
| Runner | Execute coding-agent tasks and stream events | `packages/runner-pi` |
| Daemon | Local API for CLI, web UI, and desktop shell | `packages/daemon` |
| Providers | Model and media capability adapters | `packages/providers` |
| UI | Local web and future desktop surfaces | `apps/web`, `apps/desktop` |

## Benefits

- **No duplicated agent kernel:** Ling Stack wraps `@earendil-works/pi-coding-agent` instead of rebuilding a coding-agent loop from scratch.
- **Provider flexibility:** GPT, Claude, DeepSeek / DPV4-compatible endpoints, MiniMax, GLM, Doubao, Jimeng, and OpenAI-compatible relays can sit behind one workspace policy.
- **Multilingual by design:** the product is not limited to Chinese users; the initial provider emphasis is domestic AI vendor support.
- **Auditable execution:** runner events are streamed as first-class workspace events instead of disappearing inside a terminal.
- **Approval-ready workflow:** file writes, shell commands, external sends, deployments, and high-cost media jobs can route through human review.
- **Local-first adoption:** the first useful version can run as a CLI, local daemon, and local web UI before cloud/team sync exists.
- **Desktop later, not blocking:** macOS, Windows, and Linux apps can wrap the local daemon after the runtime is useful.

## Core Principles

- Do not build another generic chat client.
- Keep channels, tasks, approvals, artifacts, and audit logs as the core product surface.
- Treat model providers as capability adapters, not just chat endpoints.
- Use Pi for the coding-agent kernel and maintain only a thin adapter.
- Keep domestic AI vendors first-class without making the product China-only.
- Keep GPT, Claude, and OpenAI-compatible relay entry points first-class.
- Make risky side effects visible and approvable.
- Store enough runtime evidence to explain what happened after the fact.
- Keep the desktop shell downstream of the daemon API.

## Who Should Use This

Ling Stack is for:

- Developers who use multiple model providers and want one local AI workspace.
- Teams that need AI help with code, docs, support, operations, and media tasks.
- Users who need domestic AI providers alongside GPT and Claude.
- Agent power users already using Codex, Claude Code, Pi, MCP, local proxies, or OpenAI-compatible relays.
- Builders who want auditable AI work instead of opaque chat transcripts.

It is less useful for one-shot prompts, stateless bots, or users who only need a simple chat client.

## What This Is / Is Not

This project is:

- A local-first AI teammate workspace.
- A product layer around maintained agent runtimes.
- A provider and approval orchestration layer.
- A future CLI, web UI, and desktop app surface.
- A place to make AI work visible, reviewable, and repeatable.

This project is not:

- A replacement for Pi.
- A model provider.
- A pure chat UI.
- A vector database.
- A secret manager.
- A permission slip for agents to change files, deploy, or send messages without review.

## Quick Start

The project is still early, but the daemon can already stream Pi runner events.

### 1. Install dependencies

```bash
corepack pnpm install
```

### 2. Build and typecheck

```bash
corepack pnpm typecheck
corepack pnpm build
```

### 3. Start the daemon

```bash
node packages/daemon/dist/cli.js
```

Default endpoint:

```text
http://127.0.0.1:17891
```

### 4. Check health

```bash
curl http://127.0.0.1:17891/health
```

### 5. Create and check a provider preset

Provider presets persist non-secret provider configuration in the local workspace database. Secrets are referenced by name, not stored as raw keys.

Built-in templates are available from the daemon:

```bash
curl http://127.0.0.1:17891/provider-templates
```

Common development secret refs:

```bash
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...
export LOCAL_RELAY_API_KEY=sk-local
export ARK_API_KEY=...
export DEEPSEEK_API_KEY=...
export MINIMAX_API_KEY=...
export ZHIPU_API_KEY=...
export JIMENG_API_KEY=...
export SEEDREAM_API_KEY=...
export SEEDANCE_API_KEY=...
```

Recommended CLI first loop:

```bash
node packages/cli/dist/index.js init --with-provider-templates
export LOCAL_RELAY_API_KEY=sk-local
node packages/cli/dist/index.js provider list
node packages/cli/dist/index.js provider update provider_... --enabled true --api-key-ref env:LOCAL_RELAY_API_KEY
node packages/cli/dist/index.js provider check-all
node packages/cli/dist/index.js doctor
```

The Web UI exposes the same flow in Providers: choose a GPT, Claude, relay, domestic AI, or media template; save the preset; set the shown `env:NAME`; run Check; then use only preflight-ready providers in Workspace.

Seedream `image_generate` can run through the live transport gate. Configure a media preset through the CLI:

```bash
node packages/cli/dist/index.js provider update provider_... \
  --base-url https://ark.cn-beijing.volces.com/api/v3 \
  --model doubao-seedream-5-0-260128 \
  --api-key-ref env:SEEDREAM_API_KEY \
  --compat-json '{"mediaVendorTransport":{"mode":"live"}}'
```

This validates `baseUrl` and `apiKeyRef`. A live-gated media job first creates a `media_cost` approval and moves to `waiting_for_approval`; after approval, Seedream `image_generate` can call the configured OpenAI-compatible `/images/generations` endpoint. Automated tests use mock HTTP; real smoke requires `SEEDREAM_API_KEY`. The adapter records request/response metadata and downloads returned HTTP(S) image URLs into local `.ling-stack/artifacts` image artifacts without forwarding the provider authorization header to the image URL.

```bash
export LOCAL_RELAY_API_KEY=sk-local

curl http://127.0.0.1:17891/providers?cwd="$PWD" \
  -H 'content-type: application/json' \
  -d '{
    "kind": "openai-compatible",
    "displayName": "Local Relay",
    "providerId": "local-relay",
    "model": "gpt-5.5",
    "api": "openai-completions",
    "baseUrl": "http://127.0.0.1:8317/v1",
    "apiKeyRef": "env:LOCAL_RELAY_API_KEY",
    "capabilities": ["chat", "tool_call", "reasoning"],
    "input": ["text"],
    "enabled": true
  }'
```

The response includes a generated `provider.id`, for example `provider_...`.

### 6. Create a channel and task

```bash
node packages/cli/dist/index.js channel create --name Engineering --path "$PWD" --provider provider_...
node packages/cli/dist/index.js task create --channel channel_... --title "Inspect repo" --prompt "List files and summarize this repo."
```

### 7. Run a task through the Pi runner

`POST /runs` returns an SSE stream. See [Daemon API](docs/daemon-api.md) for full request examples.

```bash
curl -N http://127.0.0.1:17891/runs \
  -H 'content-type: application/json' \
  -d '{
    "cwd": "'$PWD'",
    "task": {
      "id": "task-1",
      "title": "Inspect the project",
      "prompt": "List the files and summarize the repo."
    },
    "providerPresetId": "provider_...",
    "tools": ["read", "grep", "find", "ls"],
    "thinkingLevel": "medium"
  }'
```

Inline provider JSON is still accepted for development, but product flows should prefer `providerPresetId` so raw API keys are not persisted in workspace records.

## Repository Layout

```text
apps/
  web/          Local workspace UI.
  desktop/      Future cross-platform desktop shell.

packages/
  core/         Workspace, tasks, approvals, sessions, and policy engine.
  cli/          Command-line interface.
  daemon/       Local HTTP/SSE API.
  providers/    Model and media provider adapters.
  runner-pi/    Pi coding-agent wrapper used as the first execution kernel.

docs/
  product-design.md
  architecture.md
  v0.1-detailed-design.md
  daemon-api.md
  design/provider-presets.md
  design/approval-policy.md
  provider-adapters.md
  pi-coding-agent-integration.md

examples/
```

## Provider Targets

First-class provider targets:

- OpenAI GPT models.
- Anthropic Claude models.
- Doubao / Volcengine Ark.
- DeepSeek / DPV4-compatible endpoints.
- MiniMax.
- GLM / Zhipu.
- Jimeng / Seedream / Seedance for image and video generation.
- Generic OpenAI-compatible relay endpoints.

Provider support is capability-based. Ling Stack should not pretend every provider is only a chat model.

## Current Status

Implemented:

- Monorepo scaffold.
- `@ling-stack/runner-pi` wrapper around `@earendil-works/pi-coding-agent`.
- `@ling-stack/daemon` with `GET /health`.
- `POST /runs` streaming Pi runner events over SSE.
- SQLite-backed run session and event persistence.
- JSONL event audit logs under `.ling-stack/sessions`.
- `GET /runs`, `GET /runs/:id`, and `GET /runs/:id/events`.
- Artifact metadata storage plus `GET /runs/:id/artifacts`, `GET /artifacts/:id`, and `GET /artifacts/:id/content`.
- Best-effort `POST /runs/:id/cancel`.
- Workspace bootstrap plus persisted channel and task storage.
- Channel daemon APIs: `GET/POST /channels`, `GET/PATCH/DELETE /channels/:id`.
- Task daemon APIs: `GET/POST /tasks`, `GET/PATCH/DELETE /tasks/:id`.
- Task lifecycle updates from linked run sessions: `running`, `done`, `failed`, and `cancelled`.
- Provider preset storage and daemon APIs.
- Built-in provider templates for OpenAI, Claude, OpenAI-compatible relays, Doubao, DeepSeek/DPV4, MiniMax, GLM, Jimeng, Seedream, and Seedance.
- `POST /runs` with `providerPresetId`.
- Provider live checks for OpenAI-compatible chat, OpenAI Responses, and Anthropic Messages presets.
- Approval request storage and daemon APIs.
- Default read-only tool policy for product runs.
- Pi pre-tool approval gate for `bash`, `edit`, and `write`.
- Workspace approval policy storage, daemon API, Web settings UI, CLI policy commands, tool decisions, and write path scopes.
- Local web UI with channel/task workspace, channel detail editing, task detail editing, task run entry, event stream, persisted run detail/rerun, provider settings, approval list, and persisted English / Chinese UI language switching.
- Run Evidence panel with session files, summary preview, tool/approval counts, and artifact rows.
- Automatic artifact extraction from Pi tool outputs, generated text/log/Markdown/diff content, and generated file path metadata.
- Media job foundation with local metadata storage, `POST/GET /media-jobs`, static media provider checks, media adapter contract, provider-kind registry wiring, vendor request planning, disabled-by-default vendor transport seam, `media_cost` approval gate for live execution, Seedream `image_generate` live HTTP adapter, Seedream image URL byte artifacts, static execution adapter, local metadata artifacts, and Web Media Jobs panel.
- CLI first-loop commands for init, channels, tasks, providers, runs, approvals, approval policy, daemon foreground start, and Web UI launch.
- Initial product, architecture, daemon, provider, and Pi integration docs.

Not implemented yet:

- Approval gates for external sends, deployments, and credential changes.
- Rich task detail views beyond the first edit form.
- Real media byte outputs beyond Seedream `image_generate` HTTP(S) image URL downloads.
- Live Jimeng/Seedance execution and Seedream operations beyond `image_generate`.
- OS keychain integration for secrets.
- Live media provider generation checks.
- Desktop packaging.

## License

MIT.
