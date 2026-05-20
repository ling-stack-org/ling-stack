# Pi Coding Agent Integration

Ling Stack uses `@earendil-works/pi-coding-agent` as the first maintained coding-agent kernel.

This is a deliberate dependency, not a temporary reference implementation.

## Why Use Pi

Pi already owns several pieces Ling Stack should not rebuild early:

- Agent session lifecycle.
- Streaming model turns.
- Tool calling loop.
- File-oriented coding tools: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`.
- Session state and compaction primitives.
- Multi-provider model registry.
- Custom provider registration.

Ling Stack should avoid becoming responsible for a full coding-agent engine until there is clear evidence pi cannot support the required product behavior.

## Ownership Boundary

Pi owns:

- Coding-agent runtime.
- Model invocation for coding sessions.
- Tool execution primitives.
- Agent event stream.
- Session internals for a single run.

Ling Stack owns:

- Workspace, channel, and task model.
- AI teammate configuration.
- Approval policy.
- Audit log and artifact storage.
- Provider policy and user-facing provider setup.
- Daemon, CLI, web UI, and future desktop UI.
- Media jobs such as Jimeng / Seedream / Seedance.

## Adapter Package

The integration lives in:

```text
packages/runner-pi/
```

`@ling-stack/runner-pi` depends on:

```text
@earendil-works/pi-coding-agent
@earendil-works/pi-ai
```

The adapter exposes Ling Stack types instead of pi internal types:

- `PiRunnerTask`
- `PiRunnerProviderConfig`
- `PiRunnerRunOptions`
- `PiRunnerEvent`
- `PiRunnerResult`

This keeps `packages/daemon`, `apps/web`, and future desktop code independent from pi internals.

## Event Translation

Pi events are translated into Ling Stack runner events:

| Pi event | Ling Stack event |
| --- | --- |
| `turn_start` | `turn_start` |
| `turn_end` | `turn_end` |
| `message_update` / `text_delta` | `assistant_text_delta` |
| `message_update` / `thinking_delta` | `assistant_thinking_delta` |
| `tool_execution_start` | `tool_start` |
| `tool_execution_update` | `tool_update` |
| `tool_execution_end` | `tool_end` |
| `message_end` | `message_end` |

The daemon should persist these translated events, not raw pi events, unless debugging mode is explicitly enabled.

## Provider Strategy

For coding sessions, use pi's existing provider support first:

- OpenAI GPT.
- Anthropic Claude.
- DeepSeek.
- MiniMax.
- ZAI / GLM.
- OpenAI-compatible relays.

Ling Stack can register custom pi providers when a user supplies `baseUrl`, `model`, and compatibility settings.

Domestic or media-specific providers that do not fit coding-agent chat should stay outside pi:

- Jimeng / Seedream image generation.
- Seedance video generation.
- Other async media job APIs.

## Update Policy

Prefer upgrading the upstream pi dependency over carrying local patches.

Only fork or patch pi when all of these are true:

1. The missing behavior blocks a core Ling Stack workflow.
2. The behavior cannot be implemented through pi SDK options, custom provider registration, extensions, or event translation.
3. The patch is small enough to upstream or carry temporarily.

Default path:

```text
upgrade pi dependency -> adjust runner-pi adapter -> keep Ling Stack product code unchanged
```

## Near-Term Work

Next integration steps:

1. Add daemon `POST /runs` using `PiRunnerAdapter.runTask()`.
2. Stream `PiRunnerEvent` over SSE or WebSocket.
3. Persist translated events under `.ling-stack/sessions`.
4. Add approval hooks before write/edit/bash side effects.
5. Add provider presets for GPT, Claude, DeepSeek, MiniMax, GLM, and OpenAI-compatible relays.
