# Chrome Browser Native Messaging Implementation Plan

Status: active implementation plan
Owner: Browser integration, Desktop, daemon, Web, and release maintainers
Last verified: 2026-08-24
Baseline: `main@90635c83e6ec6645699a45c114c59905c996ec12`
Source contract: [Chrome Browser Built-in Plugin](chrome-browser-built-in-plugin.md)

## Scope

Upgrade Ling for Chrome from manual workspace pairing to automatic Native Messaging discovery, then
repair MV3 lifecycle recovery in extension `0.1.2`. Deliver persistent reconnect wake-up, macOS
engineering-package signing, deterministic packaging, and Web Store resubmission without changing
browser tools, MCP approval, Native wire protocols, or database schema.

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

## Slice 4: Extension `0.1.2`

- Add `nativeMessaging` and `alarms`; retain storage only for pause, transient reconnect metadata,
  and legacy migration, and remove all new workspace/address/credential writes.
- Connect Native first, report status/versions, execute existing `ling.chrome.v1` commands, and send
  shared heartbeats/results.
- If Host is unavailable and old credentials exist, silently use the V1 WebSocket path.
- On Native ready, remove legacy credential, cwd, and daemon URL keys.
- Replace popup pairing fields with connected, Ling unavailable, update required, and paused states
  plus Retry and Pause/Resume actions.
- Route install, startup, disconnect, Alarm, and popup events through one single-flight connection
  state machine. Persist only the retry attempt in `storage.session`; clear retry state on success,
  pause, disable, or intentional replacement.

Exit gate: popup has no workspace, pairing, address, credential, or consent controls; first install,
worker-idle restart without opening the popup, pause/resume, Host missing, Ling unavailable,
incompatible, fallback, and migration tests pass. Awake-Chrome recovery is at most 35 seconds.

## Slice 5: Desktop Packaging And Product UI

- Register the packaged Host idempotently at Desktop startup without blocking the main window on a
  recoverable registration failure.
- Include the current-platform Host and manifest templates in Desktop resources; verify executable
  identity, SHA, and source commit metadata.
- Add macOS signing coverage and Windows NSIS uninstall cleanup for exact Ling manifest/registry
  entries.
- Make `browser-host build:native` explicitly ad-hoc sign the copied macOS Host, reject residual
  `linker-signed` identity, and record the signing level in deterministic build metadata before
  Chrome acceptance. Release signing may replace this local identity later.
- Explicitly ad-hoc sign `unsigned_dev` macOS engineering apps after Electron Fuses are applied and
  require `codesign --verify --deep --strict`; do not upgrade that evidence to Developer ID status.
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
  A custom `--user-data-dir` receives a temporary profile-local Native Messaging manifest which is
  restored after the run. The daemon-side session must connect before the test opens the popup, so
  popup startup cannot hide a Service Worker recovery failure. CDP `Extensions.loadUnpacked` mode
  proves first-install connection only because Chrome does not persist that installation across a
  restart. The Chrome-restart and six-tool gates run only with `LING_CHROME_SMOKE_PREINSTALLED=1`
  after the isolated profile has received one real persistent unpacked installation.
- Run platform-neutral Host framing/lifecycle tests on generic CI. The Host test runner builds and
  verifies the native executable only on supported macOS arm64 or Windows x64 hosts; Linux CI still
  runs Node lifecycle and Rust protocol tests without pretending to produce a Linux Host. Do not
  build a new Windows installer for this reconnect-only release because Host and daemon wire
  protocols are unchanged.
- Keep the repair branch local, create no PR or push, and build `ling-for-chrome.zip` from the exact
  clean local commit that passed acceptance. Record source, manifest, and ZIP SHA-256 values.
- Upload `0.1.2` only after isolated-profile Chrome acceptance passes, update the `alarms` permission
  justification and reviewer instructions, submit with automatic publishing, and verify the item is
  under review at draft version `0.1.2`.

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
- No new UI for legacy pairing and no new credential issuance for `0.1.2` users.
- No direct Host business logic, model access, workspace selection, or browser API access.
- No Store upload before current-mac real Chrome acceptance and platform-neutral protocol gates pass.
- A real Chrome acceptance failure caused by an inactive MV3 worker is release-blocking; opening the
  popup or manually reloading the extension is diagnostic evidence, never an accepted recovery step.
- No claim that local unsigned artifacts satisfy Developer ID, notarization, Authenticode,
  SmartScreen, or clean-machine release gates.
