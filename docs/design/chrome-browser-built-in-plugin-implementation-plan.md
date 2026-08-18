# Chrome Browser Built-in Plugin Implementation Plan

## Status

Local implementation and validation complete; external platform closure remains open.

Baseline: `origin/main@f716679579b4d83c30d16d3c8a383442404b8285`.

Source contract: [Chrome Browser Built-in Plugin](chrome-browser-built-in-plugin.md).

## Scope

Deliver a Ling-owned Chrome Manifest V3 extension, daemon bridge, built-in Plugin Manager lifecycle
and MCP tool surface for the user's existing Chrome profile.

## Slice 1: Contracts And Persistence

- Add browser-extension setup DTOs, pairing responses and protocol schemas to `packages/contracts`.
- Add `chrome_browser_credentials` migration/store facet with hash-only persistence.
- Define stable plugin/MCP IDs, extension protocol and six initial tool descriptors.
- Add parser, migration and redaction tests.

Exit gate: credentials round-trip only as hashes; contracts reject unknown protocol versions,
oversized payloads and secret-bearing public projections.

## Slice 2: Daemon Session Authority

- Add `features/browser-extension/` with pairing-code authority, credential validation, WebSocket
  session ownership, heartbeat, command deadlines and cancellation.
- Attach one dedicated upgrade route to the daemon HTTP server.
- Validate loopback Host and exact allowlisted extension Origin before session acceptance.
- Ensure daemon shutdown closes sessions and rejects pending command promises.

Exit gate: replacement, stale result, timeout, revoke, disable and shutdown races have focused tests.

## Slice 3: Built-in MCP Runtime

- Add an internal generation broker for the logical Chrome MCP server. The placeholder persisted
  transport must never reach the generic network client.
- Register the six Chrome tools with bounded Zod schemas and MCP annotations.
- Route tool calls through the browser session authority and sanitize results.
- Add `built-in:chrome` descriptor plus logical MCP server/contribution reconciliation.
- Exclude package-cache requirements for true built-in descriptors.

Exit gate: generic MCP broker can check, list and call the browser tools; calls remain blocked when
the plugin is disabled or no authenticated extension session exists.

## Slice 4: Manifest V3 Extension

- Add `apps/chrome-extension` as a dependency-light workspace package.
- Commit manifest, background service worker, content script, popup, localized copy and Ling-owned
  icons.
- Implement pairing, credential storage, reconnect/backoff, heartbeat and command dispatch.
- Implement bounded snapshots, ref clicks, non-password typing, HTTP(S) navigation, tab listing and
  visible screenshots.
- Produce deterministic unpacked output and ZIP artifacts.

Exit gate: extension unit tests, manifest permission audit, secret scan and mock-daemon protocol tests
pass. No debugger/cookie/history/bookmark/network permissions are present.

## Slice 5: Plugin Manager Product Flow

- Add Chrome-specific row/detail view models and icon.
- Add Connect Chrome dialog/drawer with Web Store and development installation states.
- Add pairing-code generation, copy, waiting, connected and revoke actions.
- Keep extension IDs, hashes and transport details inside technical diagnostics.
- Update i18n in English and Chinese.

Exit gate: E2E covers disabled, extension-required, waiting, ready, failed and revoked states in Light
and Dark mode without changing existing Cua Driver presentation.

## Slice 6: Packaging And Acceptance

- Include extension ZIP, manifest metadata, license and notices in Desktop resources.
- Add package hash/version checks without claiming Chrome installation authority.
- Run contracts, core, daemon, runner-pi, Web, Desktop and extension checks.
- Validate real Chrome: install unpacked development build, pair, list tabs, snapshot a local fixture,
  click, type, navigate and screenshot; verify MCP approval and cancellation records.
- Record Web Store publication and Windows packaged acceptance as explicit release gates if external
  accounts or hardware are unavailable.

## Verification Commands

- `corepack pnpm --filter @ling-stack/contracts test`
- `corepack pnpm --filter @ling-stack/core test`
- `corepack pnpm --filter @ling-stack/daemon test`
- `corepack pnpm --filter @ling-stack/runner-pi test`
- `corepack pnpm --filter @ling-stack/chrome-extension test`
- `corepack pnpm --filter @ling-stack/chrome-extension build`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web lint`
- `corepack pnpm --filter @ling-stack/web run check:i18n`
- `corepack pnpm --filter @ling-stack/web test`
- focused Plugin Manager and browser-extension Playwright suites
- `corepack pnpm --filter @ling-stack/desktop typecheck`
- focused Desktop package-resource tests
- `git diff --check`

## Hard Stops

- No native host helper is added without a separate signing/packaging/uninstall design.
- No direct extension-to-model or extension-to-runner channel.
- No arbitrary script execution or credential-store access.
- No silent extension installation or fake Web Store-ready claim.
- No changes to Cua Driver authority, approvals, teammate binding or message persistence semantics.

## Local Completion Evidence

Validated on macOS on 2026-08-17:

- Contracts, Core, daemon, Runner Pi and Web suites pass for the implementation branch.
- Extension manifest, store-icon resolution, protocol, screenshot bounds and authoritative revoke
  behavior pass eight unit tests, including Store bootstrap identity and stale-socket fencing;
  background, popup and content-script syntax checks pass.
- The manifest requests only `scripting`, `storage` and the screenshot-required `<all_urls>` host
  permission. The popup discloses URL, visible-content, label and screenshot handling and requires
  an unchecked explicit-consent control before pairing; content scripts are injected only for an
  approved tool request rather than on every HTTP(S) page.
- The daemon validates and normalizes all six method-specific results before model exposure. Text
  and image results carry an `untrusted_web_content` boundary so webpage prompt injection is never
  projected as trusted instruction text.
- Online revoke and offline credential invalidation both clear the local pairing. Stale WebSocket
  events cannot clear a replacement session heartbeat or execute commands, and protocol/credential
  failures project an explicit incompatible repair state.
- Light and Dark isolated Chromium profiles complete pairing, tab listing, snapshot, click, type,
  navigation and screenshot. A daemon-side revoke then clears the extension credential/workspace
  binding and returns the popup to the unpaired state without reconnecting.
- Plugin Manager Light/Dark Playwright, Desktop typecheck and deterministic extension package
  boundary tests pass.
- The extension ZIP is deterministic and contains a store-compliant 128x128 Ling icon. An unsigned arm64 macOS
  App, ZIP and DMG build successfully; the final DMG contains byte-identical ZIP, build metadata,
  README, Store submission checklist and MIT LICENSE resources.
- A separate deterministic Store-bootstrap build produced the unpublished Dashboard item. The
  Store-issued public key is now committed, the final package derives production Item ID
  `mbmlnnfhebclljonhedpjghbhibfapei`, and the legacy development ID remains allowlisted only for
  compatibility.
- Official Google Chrome 151 rejects command-line extension loading with `ERR_BLOCKED_BY_CLIENT`.
  The successful local automation therefore remains explicitly Chromium-only and confirms that Ling
  must not claim or exercise Chrome installation authority.

Open release gates:

- submit the completed Chrome Web Store item for review, then publish and record the listing URL;
- repeat acceptance in official Chrome from the Web Store-installed package;
- complete Developer ID-signed macOS and signed Windows clean-host acceptance. The local arm64
  macOS package is structurally verified but unsigned because this machine has no valid signing
  identity.
