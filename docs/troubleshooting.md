# Troubleshooting

Start with the [source startup guide](getting-started.md). This page covers local setup
and common first-run questions. Platform-specific acceptance is tracked in
[Implementation Status](design/implementation-status.md).

## Installation And Build

| Symptom | Check and remedy |
| --- | --- |
| `corepack: command not found` | Install Corepack for your Node installation, then run `corepack enable`. The repository uses pnpm `10.0.0`. |
| `node:sqlite` or TypeScript source-import errors | Check `node --version` in every startup terminal. Use Node `22.22.1` or newer; CI uses `22.22.1`. |
| Frozen-lockfile install fails | Check that `package.json`, workspace manifests, patches, and `pnpm-lock.yaml` come from the same checkout. For a network or registry error, retry the locked install and retain the error output. |
| `packages/cli/dist/index.js` or daemon CLI cannot be found | Run the filtered build below from the repository root before using `pnpm ling`. |
| The Web build cannot resolve a workspace package | Build the complete CLI dependency graph below, including shared UI and contract packages. |
| `xcrun` or `dotnet` is missing while trying the Web UI | A repository-wide `pnpm build` includes Desktop native work. Use the filtered Web-stack build below, or install the separate Desktop toolchain. |

Default source build:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --workspace-concurrency=1 --filter '@ling-stack/cli...' -r build
```

This selects the CLI, daemon, Web app, and their workspace dependencies. Desktop and
Mobile setup are separate. A lockfile change should be reviewed as a dependency change.

## The Web UI Opens But Cannot Connect

Confirm that both foreground processes are still running, from the same repository
root:

```bash
corepack pnpm ling status
curl http://127.0.0.1:17891/health
```

The daemon health response should contain `"ok": true`. Restart a stopped daemon using
`corepack pnpm ling daemon start --foreground`; the UI starts separately with
`corepack pnpm ling ui --foreground --open`. Keep both terminals open.

If a default port is occupied, inspect the existing service before changing it. An
installed Ling Desktop may already own the default daemon port. Changing ports alone
does not isolate storage. For a separate source session, create a disposable project
directory and user-data directory, then replace the placeholder paths below with their
absolute paths. These environment assignments use Bash/Zsh syntax; on Windows, set
`LING_STACK_HOME` in each startup terminal using your shell's environment syntax.

```bash
LING_STACK_HOME=/path/to/disposable/ling-home corepack pnpm ling --cwd /path/to/disposable/project --daemon-url http://127.0.0.1:17892 daemon start --foreground --port 17892
```

In a second terminal:

```bash
LING_STACK_HOME=/path/to/disposable/ling-home corepack pnpm ling --cwd /path/to/disposable/project --daemon-url http://127.0.0.1:17892 ui --foreground --port 5174 --open
```

Use the same `LING_STACK_HOME`, `--cwd`, and `--daemon-url` for diagnostics against
that session too. The source CLI injects the selected daemon URL and workspace into
the Web process. Run one full daemon per workspace.

## Doctor Reports A Provider Failure

Doctor diagnoses model readiness as well as service health. A fresh workspace without
an enabled chat-capable model reports `providers.configured` as a failure and exits
with code `4`. Check `/health` and the Web page for startup, then configure a model in
**Settings → Model Workbench**, run **Check**, and run doctor again.

A configured model can still fail because its API key is unavailable, its endpoint or
API protocol is wrong, or the selected account cannot access the model. Use the failed
check's guidance. An image- or video-only preset does not satisfy chat readiness.

## Model Setup Questions

- **Do I need an API key to open the app?** You can explore the local UI before adding
  a provider. Model-backed work needs an enabled, checked model and any required credentials.
- **Does adding a supplier enable every capability?** Each preset has separate chat,
  tool-calling, image, and video capabilities. Select and check the capability needed
  for the task.
- **Why is an environment key still missing?** The daemon reads its own process
  environment. Export the variable in the terminal that starts the daemon and restart
  that source session after changing it. A `.env` file is not loaded automatically.
- **Where are keys stored when entered in the UI?** In local workspace storage. Treat
  the workspace database and backups as sensitive; protect them with filesystem access
  controls. Use supported environment or keychain references when appropriate.
- **Does local-first mean requests stay offline?** Workspace state stays local by
  default. Models and tools receive requests and context according to the providers
  you configure, and their billing and data policies apply.

## Desktop Development

The Web source guide does not require native Desktop toolchains. Desktop development
adds Xcode Command Line Tools with Swift and `codesign` on macOS, or the .NET 8 SDK on
Windows for the Office driver. Distribution targets are macOS arm64 and Windows x64;
native feature acceptance is tracked separately.

If Electron reports that it failed to install correctly, its platform binary may be
missing. This repository limits dependency install scripts, so a package install alone
may not download Electron. For Desktop development, explicitly run the installed
Electron package's binary installer:

```bash
corepack pnpm --filter @ling-stack/desktop exec node node_modules/electron/install.js
corepack pnpm --filter @ling-stack/desktop dev
```

The installer downloads the Electron version from the locked package. Network access
to Electron's distribution service is required. Office and Computer Use capabilities
have additional readiness requirements. Read
[Desktop release and acceptance](release/desktop.md) before distributing packages.

## Reporting A Problem

Follow [Support](../SUPPORT.md) and use the
[GitHub Issue forms](https://github.com/ling-stack-org/ling-stack/issues/new/choose).
Include the commit, operating system and architecture, Node and pnpm versions,
startup commands, failing check, and smallest reproduction. State whether the problem
occurs in Web source development or Desktop.

Review diagnostic output before sharing it. Remove keys, tokens, personal paths,
private provider endpoints, conversation content, and workspace data. Send security
findings through the private process in [Security](../SECURITY.md).
