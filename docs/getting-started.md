# Getting Started

This guide takes you from a source checkout to a first model-backed conversation and
a project channel. Ling Stack is a source-first alpha. Start with the Web UI, local
daemon, and CLI; native Desktop integrations have additional platform gates.

## Install And Start

Use Git, Node.js 22.22.1 or newer, Corepack with pnpm 10, and Rust with Cargo
([rustup installation](https://rustup.rs/)). The daemon build compiles the native
image sanitizer even when using only the Web UI. Its dependencies require Rust
1.89 or newer; CI uses Rust 1.97.1 and Node 22.22.1. The repository pins pnpm 10.0.0.

```bash
git clone https://github.com/ling-stack-org/ling-stack.git
cd ling-stack
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm --workspace-concurrency=1 --filter '@ling-stack/cli...' -r build
```

The build selects the CLI and its dependencies, including the daemon and Web app.
It leaves Desktop and Mobile development setup separate.

A fresh install may warn that the `ling-stack-daemon` bin target is missing before
the daemon has been built. Continue with the build, and invoke the source CLI using
`corepack pnpm ling`. Node 22's experimental SQLite warning is informational; check
the command's exit status and diagnostics to determine whether it succeeded.

Start the daemon from the repository root in one terminal:

```bash
corepack pnpm ling daemon start --foreground
```

Start the Web UI from the same repository root in a second terminal:

```bash
corepack pnpm ling ui --foreground --open
```

The Web UI opens at `http://127.0.0.1:5173`, and the daemon listens at
`http://127.0.0.1:17891`. Keep both terminals running. To stop them, press `Ctrl+C`
in each terminal.

`ling ui` starts the Vite development server. A successful source UI check does not
validate the built production pages; use the Web package's `preview` command for
that separate check after building.

In a third terminal, check the daemon:

```bash
curl http://127.0.0.1:17891/health
```

Expect JSON containing `"ok": true`. Open the Web address and confirm that the
workspace loads. These checks verify local startup; model-backed work needs the
next step.

## Connect Your First Model

1. Open **Settings → Model Workbench**. The first-run dialog also offers
   **Open Model Workbench**.
2. Choose **Add model** and select a model supplier. For a custom compatible endpoint,
   enter its provider name, Base URL, and API protocol.
3. Enter the exact model identifier your provider supports and your API key. Choose a
   chat-capable model for this tutorial. Image- or video-only presets serve different
   purposes.
4. Save the preset and run **Check** if it has not already passed the save-time check.
   Fix any key, endpoint, protocol, or model error reported by the check.
5. Confirm that the model is enabled and chat-ready. The first verified chat model
   becomes the workspace default. Use **Chat model** under **Default uses** to choose
   a different default later.

Readiness checks contact the selected provider and may incur provider charges. A
successful model listing alone does not verify that chat or tool calling works.
Credentials and billing come from your own provider account.

Now run the diagnostics from the repository root:

```bash
corepack pnpm ling doctor
```

Doctor checks model readiness, workspace state, services, and other setup. Before a
chat model is configured, a provider failure and exit code `4` are expected. After
configuration, review individual failures and their remediation instead of treating
the process exit code as an installation-only verdict.

## Have A First Conversation

Choose **New conversation** and confirm the selected chat model. Open the model control
to adjust **Thinking mode**; the slider includes `max` or `ultra` only when declared
for that model. If a model switch cannot keep the selected level, Ling chooses a
supported default and explains the change. Send a small prompt:

> Help me turn these notes into three concrete action items: review the README,
> check the startup guide, and prepare an alpha release description.

Wait for the final response. Use the conversation's **Show details** and **Summary**
views to inspect available run and environment information. Text-only work is a useful
first check before assigning tools or asking for file changes.

For project work, select the intended local directory and review the effective
permission settings. File access, command execution, MCP tools, and native integrations
each have their own readiness and approval requirements.

## Start A Project Channel

1. Open **Channels** and create a channel with a name, purpose, Ling Agent model, and
   project directory. Use a disposable sample project while learning the workflow.
2. For collaboration, create teammates in **Settings → Teammate Management**, configure
   their models and permitted tools, then invite them when creating the channel or
   manage members afterward.
3. Send a bounded request, such as reviewing a short document and reporting suggested
   changes. Ask for inspection first while you learn how permissions behave.
4. Inspect participant responses, tool activity, approval requests, and the final report.
   Open any resulting artifacts and check that they match the requested outcome.

Git-backed project channels can use isolated workspaces. Existing folders that are not
Git repositories run locally in the selected folder. A teammate's role or skill does
not grant tools or filesystem permission by itself. Native command execution and
Computer Use may remain unavailable until their platform gates are satisfied.

## Try Media Production

Add and check a model with the needed image or video capability, then open
**Media Production** to configure a project and scenes. Inspect the selected provider,
parameters, and any approval request before creating a job. Chat, image generation,
image editing, and video generation are separate capabilities. Provider availability,
live adapter acceptance, and billing apply to each job.

## Configuration And Data

By default, workspace state lives under `.ling-stack/` in the selected workspace:

| Path | Contents |
| --- | --- |
| `ling-stack.sqlite` | Workspace configuration and durable state |
| `sessions/` | Run events and evidence |
| `artifacts/` | Generated and collected files |
| `logs/` | Runtime logs |

API keys entered in Model Workbench are saved in local workspace storage. Treat the
database and its backups as sensitive. Environment references such as `env:NAME` and
supported keychain references are alternatives; see
[Provider adapters](provider-adapters.md) for integration details.

[`.env.example`](../.env.example) lists common development variable names. The daemon
inherits the environment of the terminal that starts it. Export required variables
there before startup; creating a `.env` file alone does not configure the daemon.

An explicit user-data-directory state mode is also available. Use the CLI migration
and registry-repair flows documented in
[Workspace State Storage](design/workspace-state-storage.md) when changing storage
location. Keep local state, API keys, logs, and private outputs out of Git.

Continue with [Troubleshooting](troubleshooting.md),
[Implementation Status](design/implementation-status.md), or
[Contributing](../CONTRIBUTING.md).
