# Contributing to Ling Stack

Thank you for helping improve Ling Stack. Contributions are welcome across product
design, documentation, TypeScript packages, the Web UI, the Electron desktop shell,
provider adapters, tests, and developer tooling.

Ling Stack is still an alpha. Correctness, explicit authority, local data safety, and
honest product status matter more than adding surface area quickly.

## Before You Start

- Read the [README](README.md), [architecture](docs/architecture.md), and
  [implementation status](docs/design/implementation-status.md).
- Search existing issues and pull requests before opening duplicate work.
- Open an issue before a large feature, public API change, storage migration, security
  boundary change, or new external integration.
- For substantial Ling product or architecture work, update the durable design contract
  and implementation plan under `docs/design/` before coding.
- Do not treat old phase numbers, deleted implementation diaries, or screenshots as the
  current source of truth.

Small fixes, tests, documentation corrections, and focused accessibility improvements do
not need a new design document.

## Development Setup

Requirements:

- Git and Node.js 22.22.1 or newer
- Corepack with pnpm 10

```bash
git clone https://github.com/ling-stack-org/ling-stack.git
cd ling-stack
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm --workspace-concurrency=1 --filter '@ling-stack/cli...' -r build
```

Start the daemon and Web UI in separate terminals:

```bash
corepack pnpm ling daemon start --foreground
corepack pnpm ling ui --foreground --open
```

This builds the CLI, daemon, Web app, and their workspace dependencies. Run both
startup commands from the repository root, each in its own terminal. Follow
[Getting started](docs/getting-started.md) for model setup and a first conversation,
and [Troubleshooting](docs/troubleshooting.md) for setup errors. Run `ling doctor`
after configuring and checking a chat model; an unconfigured workspace reports a
provider failure.

Desktop development has additional platform requirements: Xcode Command Line Tools
with Swift and `codesign` on macOS, or the .NET 8 SDK on Windows, plus the Electron
platform binary. See [Desktop development](README.md#desktop-development).

## Branches And Pull Requests

- Create a topic branch from the latest `main`.
- Use a descriptive branch name such as `feat/provider-health` or
  `fix/channel-scroll`.
- Do not force-push or commit directly to `main`.
- Keep unrelated changes out of the same pull request.
- Use short, imperative commit subjects. Conventional prefixes such as `feat:`, `fix:`,
  `docs:`, and `test:` are welcome but not required.
- Rebase or merge the latest `main` before requesting final review when the branch has
  drifted materially.

Every pull request must explain:

- the problem and user-visible outcome;
- the modules and boundaries changed;
- validation commands and manual checks performed;
- security, permission, storage, migration, and compatibility impact;
- known limitations or deliberately deferred work;
- screenshots for visible UI changes.

Draft pull requests are welcome for early alignment. A pull request is ready for review
only when its description is complete and its claimed validation has actually run.

## Engineering Guidelines

- Follow existing module boundaries and local patterns before introducing abstractions.
- Keep UI, state, domain logic, API/client code, types, and tests in focused modules.
- Avoid adding major behavior to production files over 800 lines; extract focused
  components, hooks, services, helpers, or types first.
- Do not bypass daemon contracts from Web or Desktop code to call providers, tools, or
  persistence directly.
- Use structured parsers and typed contracts for structured data.
- Keep user-facing copy outcome-oriented; raw IDs, hashes, routes, and provider payloads
  belong in technical details or logs.
- Preserve Chinese and English product coverage together.
- Do not weaken, skip, or delete tests merely to make a contribution pass.

## Validation

For documentation-only changes:

```bash
corepack pnpm check:docs
corepack pnpm check:licenses
corepack pnpm check:public
git diff --check
```

For code changes, run the narrowest focused tests first, then the relevant repository
checks:

```bash
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

These repository-wide commands include Desktop checks, and `test` also includes
Mobile checks. They require the relevant platform toolchain and test fixtures;
use package filters for a scoped change and state which checks ran. The default
Web setup above does not establish that all native or browser test fixtures are
available. CI selects and builds the affected package graph separately.

Web changes should also run:

```bash
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web check:i18n
```

Visible Web or Desktop changes require real interaction checks at supported desktop
viewports. Include screenshots when they help reviewers verify layout, dark mode,
loading, empty, error, focus, and overflow states.

Platform-specific Desktop, Computer Use, signing, packaging, and native-provider gates
must run on their documented target environment. A generic build or Linux CI pass does
not replace macOS, Windows, signing, accessibility, or clean-machine evidence.

## Security And Local Data

- Never commit API keys, tokens, credentials, `.env` files, local SQLite databases,
  session logs, generated artifacts, or `WORKFLOW.md` with machine-specific references.
- Keep the daemon bound to loopback unless a separately reviewed authenticated remote
  boundary is in scope.
- Do not broaden permissions, approval bypasses, external mutations, filesystem scope,
  or secret handling as an incidental part of another change.
- Use [SECURITY.md](SECURITY.md) for vulnerability reports. Do not disclose sensitive
  findings in public issues or pull requests.

## AI-Assisted Contributions

AI-assisted contributions are welcome. The human contributor remains responsible for
understanding the change, reviewing generated code, protecting private data, running the
claimed validation, and responding to review. Do not submit unreviewed model output or
private conversation transcripts.

## Community

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). Usage and setup
questions follow [SUPPORT.md](SUPPORT.md).

By contributing, you agree that your contribution is licensed under the repository's
[MIT License](LICENSE).
