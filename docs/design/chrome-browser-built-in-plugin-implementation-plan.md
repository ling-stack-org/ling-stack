# Chrome Browser Native Messaging Implementation Plan

Status: active implementation plan
Owner: Browser integration, Desktop, daemon, Web, and release maintainers
Last verified: 2026-08-21
Baseline: `main@43fc109fbaf0b215768c8293a7974e68a713d8ef`
Source contract: [Chrome Browser Built-in Plugin](chrome-browser-built-in-plugin.md)

## Scope

Upgrade Ling for Chrome from manual workspace pairing to automatic Native Messaging discovery in
extension `0.1.1`. Deliver macOS arm64 and Windows x64 Host builds, source-mode lifecycle commands,
shared daemon transports, product status projection, deterministic packaging, and Web Store
resubmission without changing browser tools, MCP approval, or database schema.

## Slice 1: Contracts And Documentation

- Add `ling.chrome.native.v1`, Host/runtime descriptor constants, exact parsers, state enums, and
  compatibility fields to shared contracts.
- Replace manual pairing UX and privacy language in design, release, Store, and privacy documents.
- Preserve `ling.chrome.v1` and legacy pairing DTOs only for internal migration.
- Define `transport`, `hostState`, and `extensionState` while retaining `connected`.

Exit gate: docs links pass; new contracts reject `cwd`, unknown fields, oversized values, wrong
origins, and incompatible versions.

## Slice 2: Native Host And Lifecycle

- Add dependency-minimal Rust Host source under `packages/browser-host` with deterministic build
  metadata and no external runtime installation.
- Implement one-megabyte little-endian Native Messaging framing, exact first-message parsing,
  descriptor loading, origin validation, private loopback connection, bidirectional relay, EOF, and
  sanitized errors.
- Add user-level Chrome/Chromium manifest install, status, upgrade rewrite, and uninstall helpers for
  macOS and Windows HKCU.
- Add `ling-stack browser-host install|status|uninstall`; source install builds the current platform
  Host before registration.

Exit gate: frame boundary, multi-frame, maximum size, malformed input, bad origin, stale descriptor,
broker failure, repeat install, upgrade, status, and uninstall tests pass.

## Slice 3: Daemon Native Broker And Shared Session

- Publish an atomic protected runtime descriptor after a random-port loopback broker starts; refresh
  expiry and remove only the owned generation on shutdown.
- Authenticate startup token, allowlisted extension origin, Host/extension versions, and paused state
  before activating a session.
- Extract a common transport interface and adapt both Native framed sockets and legacy WebSocket to
  the existing heartbeat, command, timeout, cancellation, replacement, revoke, and shutdown path.
- Bind Native sessions to daemon workspace authority and reject any handshake containing `cwd`.
- Revoke old credential rows on first Native success without closing the new session.

Exit gate: Native auto-binding, single-session replacement, pause, disable, revoke, timeout,
cancellation, descriptor expiry, legacy fallback, migration cleanup, and shutdown races pass.

## Slice 4: Extension `0.1.1`

- Add `nativeMessaging`, retain `storage` only for pause and legacy migration, and remove all new
  workspace/address/credential writes.
- Connect Native first, report status/versions, execute existing `ling.chrome.v1` commands, and send
  shared heartbeats/results.
- If Host is unavailable and old credentials exist, silently use the V1 WebSocket path.
- On Native ready, remove legacy credential, cwd, and daemon URL keys.
- Replace popup pairing fields with connected, Ling unavailable, update required, and paused states
  plus Retry and Pause/Resume actions.

Exit gate: popup has no workspace, pairing, address, credential, or consent controls; first install,
restart, pause/resume, Host missing, Ling unavailable, incompatible, fallback, and migration tests
pass.

## Slice 5: Desktop Packaging And Product UI

- Register the packaged Host idempotently at Desktop startup without blocking the main window on a
  recoverable registration failure.
- Include the current-platform Host and manifest templates in Desktop resources; verify executable
  identity, SHA, and source commit metadata.
- Add macOS signing coverage and Windows NSIS uninstall cleanup for exact Ling manifest/registry
  entries.
- Replace Plugin Manager pairing-code generation/copy/expiry UI with automatic detection and
  actionable Host, extension, paused, incompatible, disabled, and Ling-unavailable states.
- Update Chinese/English copy and remove one-second pairing polling/flicker.

Exit gate: focused Desktop package tests and Plugin Manager unit/E2E tests pass in Chinese/English,
Light/Dark, with no invalid refresh action or loading flicker.

## Slice 6: Release Verification And Store Submission

- Run docs links, public safety, licenses, dependency security, typecheck, unit, Web lint/i18n/build,
  relevant Playwright, and `git diff --check`.
- Run current-mac official Chrome acceptance in an isolated profile across all six tools, MCP
  approval, Desktop restart, workspace switch, extension restart, pause, revoke, and migration.
- Run the Windows x64 self-hosted Host build, framing/lifecycle tests, NSIS layout, hash, registry,
  and uninstall checks. Failure blocks Store upload.
- Create a PR, wait for CI, merge to `main`, and rebuild `ling-for-chrome.zip` from that exact merge
  commit. Record source, manifest, and ZIP SHA-256 values.
- Synchronize the public privacy Gist, upload `0.1.1`, update permission justification and reviewer
  instructions, and save the Store draft.
- Ask for action-time confirmation immediately before `Submit for review`; submit with automatic
  publishing and verify the item is under review at draft version `0.1.1`.

## Verification Commands

```bash
corepack pnpm --filter @ling-stack/browser-host test
corepack pnpm --filter @ling-stack/contracts test
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/chrome-extension test
corepack pnpm --filter @ling-stack/chrome-extension build
corepack pnpm --filter @ling-stack/cli test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web lint
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web test
corepack pnpm --filter @ling-stack/desktop typecheck
node --test apps/desktop/tests/chrome-extension-*.test.mjs
corepack pnpm check:docs
corepack pnpm check:public
corepack pnpm check:licenses
corepack pnpm check:dependency-security
git diff --check
```

## Non-Goals And Hard Stops

- No new database table, browser tool, MCP approval path, remote relay, or public broker.
- No new UI for legacy pairing and no new credential issuance for `0.1.1` users.
- No direct Host business logic, model access, workspace selection, or browser API access.
- No Store upload before the Windows x64 gate and current-mac real Chrome acceptance pass.
- No claim that local unsigned artifacts satisfy Developer ID, notarization, Authenticode,
  SmartScreen, or clean-machine release gates.
