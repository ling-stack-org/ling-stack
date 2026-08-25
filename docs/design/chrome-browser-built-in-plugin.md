# Chrome Browser Built-in Plugin

Status: active product, security, and transport contract
Owner: Browser integration, Desktop, daemon, and release maintainers
Last verified: 2026-08-24
Code and test anchors: `apps/chrome-extension`, `packages/browser-host`,
`packages/daemon/src/features/browser-extension`, `apps/web/src/features/plugins`, and
`apps/desktop/tests/chrome-extension-*.mjs`

## Decision

Ling exposes Chrome as a product-managed built-in plugin. It contributes one logical MCP server
whose six tools operate the user's existing Google Chrome profile after the extension is installed,
the plugin is enabled, and the normal MCP approval is granted.

Version `0.1.2` uses Chrome Native Messaging for automatic local discovery and persistent MV3
reconnection:

```text
Ling conversation / teammate / channel
  -> existing MCP binding, approval, cancellation, and audit
  -> built-in:chrome + mcp_chrome_browser
  -> daemon browser session controller
  -> private loopback native broker
  -> com.lingstack.browser Native Messaging Host
  -> Ling for Chrome Manifest V3 extension
  -> chrome.tabs / chrome.scripting / on-demand content script
  -> the user's existing Chrome profile
```

The extension never selects a workspace and never receives a workspace path. The daemon binds the
session to its current workspace authority. Legacy HTTP pairing and WebSocket transport remain only
for already-installed `0.1.0` credentials during the `0.1.1`/`0.1.2` migration window.

## Goals

- Make Chrome usable after normal Web Store installation without asking for a path, daemon URL, or
  pairing code.
- Reuse the user's open tabs and signed-in browser profile without launching a second profile.
- Keep Host, extension, plugin, and protocol failures distinct and actionable.
- Reuse MCP approvals, teammate bindings, run snapshots, cancellation, and audit.
- Keep browser traffic local to the current machine and fail closed on identity, token, version,
  descriptor, or session failures.
- Ship one standalone, dependency-minimal Host binary for macOS arm64 and Windows x64.

## Non-Goals

- No silent or policy-forced Chrome extension installation.
- No remote relay, cloud browser, or public Host listener.
- No Chrome password, cookie, payment, autofill, history, bookmark, or download access.
- No arbitrary JavaScript evaluation, network interception, or response-body capture.
- No control of browser-internal, extension, file, data, or JavaScript URLs.
- No second browser permission engine, business protocol, tool registry, or database.
- No Firefox, Safari, Edge, Brave, Opera, or Vivaldi support in `0.1.2`.

## Stable Identities

```text
plugin id:                  built-in:chrome
logical MCP id:             mcp_chrome_browser
business protocol:          ling.chrome.v1
native transport protocol:  ling.chrome.native.v1
native host name:           com.lingstack.browser
extension package:          @ling-stack/chrome-extension
extension version:          0.1.2
```

The production extension ID is `mbmlnnfhebclljonhedpjghbhibfapei`. The existing development ID
`ggmhibjboaedlnidbemkefonahjgcapc` remains explicitly allowlisted for source acceptance. No
arbitrary `chrome-extension://` origin is accepted by the Host, manifest, or daemon.

## Product States

Plugin Manager projects these states without exposing paths, ports, tokens, extension IDs, or raw
transport errors:

| State | Meaning | Primary action |
| --- | --- | --- |
| Disabled | Browser tools are disabled in Ling | Enable |
| Connection component missing | Native Host is not registered or its executable is unavailable | Repair connection component |
| Extension required | Host is ready but no compatible extension has been detected | Open Chrome Web Store |
| Ling unavailable | Extension and Host ran, but the local daemon broker was unavailable | Open Ling |
| Paused | The user paused the extension | Resume in the extension |
| Update required | Host, extension, or transport version is incompatible | Update Ling or extension |
| Ready | The Native session and MCP tools are available | Details |

`connected` remains a compatibility projection. New consumers use `transport`, `hostState`, and
`extensionState`. The UI must not collapse every failure into `Not connected` or show a manual
refresh loop that causes status flicker.

## First Connection And Migration

1. The user installs Ling for Chrome from the Web Store and enables Chrome in Ling. These two
   explicit actions form the one-time connection authorization.
2. Desktop startup idempotently registers `com.lingstack.browser` for Chrome and Chromium. Source
   users run `ling-stack browser-host install` once.
3. The daemon starts a private random-port broker and publishes a short-lived user-only runtime
   descriptor.
4. The extension connects with `chrome.runtime.connectNative("com.lingstack.browser")`.
   Real-Chrome acceptance that launches Chrome with a custom `--user-data-dir` must stage the same
   manifest under that isolated user-data root's `NativeMessagingHosts/` directory. This is
   test-fixture setup only; production installation continues to register the standard per-user
   Chrome and Chromium locations. A directory chooser may appear only when a developer deliberately
   performs the one-time `Load unpacked` acceptance setup; Store-installed users never select an
   extension directory, workspace, daemon address, or Native Host path.
5. The Host validates the Chrome origin, reads the current descriptor, and forwards a bounded native
   handshake containing the startup token and versions. It does not accept `cwd`.
6. The daemon binds the session to its current workspace, activates the existing business protocol,
   and exposes tools only when the plugin is enabled.
7. Each browser command still enters the normal MCP approval path.

If Native Messaging is unavailable and `0.1.0` credentials already exist, `0.1.2` may silently use
the legacy WebSocket path. New users are never shown the legacy pairing UI. On the first successful
Native connection, the daemon revokes the legacy credential and the extension deletes credential,
workspace, and daemon-address keys from `chrome.storage.local`.

## Extension Surface

The Manifest V3 extension contains one background service worker, a compact popup, and an on-demand
content script. Required permissions are:

```text
nativeMessaging
scripting
storage
alarms
host_permissions: <all_urls>
```

`storage.local` owns only the paused state and the one-release legacy migration.
`storage.session` may hold a non-sensitive reconnect attempt counter while Chrome is running.
Neither area may persist a new workspace, daemon URL, startup token, or newly issued credential.
`alarms` provides a durable wake-up after the MV3 worker is suspended. `<all_urls>` remains
necessary for approved visible-viewport capture after navigation; runtime policy still rejects
non-HTTP(S) pages.

The popup shows only:

- connected;
- Ling is not running;
- connection component or extension update is required;
- paused;
- Connect/Retry and Pause/Resume actions;
- a concise local-data disclosure.

It never shows workspace, daemon address, pairing code, credential, extension ID, or an authorization
checkbox. Browser tool approvals remain in Ling at the moment of use.

## MV3 Connection Recovery

Installation, Chrome startup, popup retry, Native disconnect, legacy disconnect, and
`chrome.alarms.onAlarm` all enter one single-flight connection state machine. A stale attempt may not
replace a newer connection or clear its heartbeat.

Unexpected disconnect schedules the named `ling.chrome.reconnect` alarm as a 30-second periodic
wake-up, alongside bounded in-worker exponential backoff capped at 30 seconds. Alarm creation must
be awaited. A wake-up must keep the periodic alarm installed until the connection reaches a terminal
state; it must not clear the only durable wake-up before starting an asynchronous connection attempt.
Successful connection, pause, plugin disable, or an intentional replacement clears the alarm and
session retry counter. With Chrome active and the machine awake, a suspended worker must reconnect
within 35 seconds without opening the popup. Sleep time is excluded; recovery begins again when
Chrome resumes.

## Native Host Contract

`Ling Browser Host` is a standalone binary with no external runtime installation. It owns only
Chrome Native Messaging framing and forwarding. It must not parse pages, choose a workspace, execute
browser tools, persist credentials, or make model/run decisions.

The user-level runtime descriptor is:

```text
~/.ling-stack/browser-host/runtime-v1.json
```

It contains only schema version, loopback port, random startup token, generation, daemon PID,
expiration, and protocol/Host compatibility fields. On macOS the directory is mode `0700` and the
descriptor is `0600`. On Windows the directory and descriptor ACL are restricted to the current
user. Publication is atomic; shutdown removes only a descriptor whose generation still belongs to
that daemon.

Host rules:

- maximum frame size is the shared one-megabyte Chrome limit;
- truncated frames, EOF, malformed JSON, unknown fields, stale descriptors, wrong origin, wrong
  token, and incompatible versions fail closed;
- stdout contains Native Messaging frames only; sanitized diagnostics go to stderr;
- the Host connects only to the descriptor's loopback port;
- disconnect terminates both relay directions and does not leave a background process.

Desktop owns idempotent manifest registration, packaged Host identity, upgrade rewriting, signing,
and uninstall cleanup. macOS writes user-level Chrome and Chromium manifests. Dragging the app to the
trash may leave only a credential-free manifest pointing at a missing executable. Windows writes the
same manifest plus the two HKCU registry bindings; NSIS uninstall removes the exact Ling entries.

## Session And Protocol Contract

Native transport starts with an exact `ling.chrome.native.v1` handshake containing extension origin,
Host version, extension version, browser version, paused state, and the descriptor startup token.
The extension must not send `cwd`. Native and legacy adapters then feed the same session controller:

- one current session per daemon workspace;
- newer valid sessions replace older sessions;
- shared heartbeat and last-seen tracking;
- shared command deadline, cancellation, revoke, disable, and shutdown behavior;
- late results from replaced sessions are ignored;
- business commands and results remain `ling.chrome.v1`.

Legacy endpoints remain internal during migration:

```text
POST /browser-extension/v1/pair
WS   /browser-extension/v1/connect?cwd=...
```

They serve only previously stored `0.1.0` credentials and are not linked from new product UI.

## Browser Tools And Trust Boundary

| Tool | Purpose | Default approval |
| --- | --- | --- |
| `chrome_tabs` | List bounded tab metadata | ask |
| `chrome_snapshot` | Read visible semantic page content and refs | ask |
| `chrome_navigate` | Navigate or create an HTTP(S) tab | ask |
| `chrome_click` | Click a ref from the latest snapshot | ask |
| `chrome_type` | Type into a non-password ref | ask |
| `chrome_screenshot` | Capture the visible viewport | ask |

Tool definitions, calls, approvals, results, and failures stay in the existing MCP/run record path.
Page-derived text and images are bounded and marked `untrusted_web_content`. Password and file inputs
are rejected, refs are revision-scoped, screenshots are compressed, and cancellation prevents late
commit. Enabling Chrome may reconcile the protected Ling Agent binding; custom teammates are never
auto-bound.

## Persistence And Revocation

No database migration is added. `chrome_browser_credentials` remains only for legacy migration and
revocation. Native sessions use the daemon startup token from the protected descriptor and do not
create a durable browser credential.

Disabling the plugin closes the active session and removes tool eligibility. Revoking Chrome access
closes the session, revokes legacy credentials, and requires explicit re-enable/reconnect. Pausing in
the extension keeps the Host installed but prevents command activation. Desktop or daemon shutdown
closes pending commands and invalidates the descriptor generation.

## Packaging And Release

The deterministic extension build records extension version, extension ID, manifest SHA-256, ZIP
SHA-256, and source commit SHA. Desktop carries the matching platform Host and manifest templates.
The Host is part of macOS signing verification and Windows NSIS/hash verification.

Normal releases rebuild the final Web Store ZIP from the exact merged `main` commit after CI passes.
The user-authorized `0.1.2` recovery release is a narrow exception: it may be built from a clean,
locally committed repair branch after all local gates pass, without pushing or opening a PR. Build
metadata must bind that exact commit. Store copy and privacy policy must explain `nativeMessaging`,
`alarms`, automatic local discovery, legacy credential migration, and the absence of workspace
storage. Review approval uses automatic publishing.

## Acceptance

- A fresh Web Store install connects after Ling starts without path, address, pairing code, or
  credential entry.
- Desktop restart after the worker has become idle reconnects without opening the extension popup;
  an awake Chrome instance recovers within 35 seconds.
- macOS arm64 and Windows x64 Host build, install, status, upgrade, and uninstall tests pass.
- Host, extension, paused, incompatible, disabled, and Ling-unavailable states are distinct.
- Native requests contain no `cwd`; workspace switching follows daemon authority.
- Existing `0.1.0` credentials can fall back once and are removed after Native success.
- All six tools pass real-Chrome acceptance with MCP approval, cancellation, Desktop restart,
  extension restart, and workspace switch coverage.
- Packaging proves the Host and extension metadata originate from the same source commit.

## Hard Stops

- Do not add remote relay, cloud authority, public broker binding, or direct extension-to-model path.
- Do not accept workspace, daemon URL, credential, or arbitrary origin from the new extension UI.
- Do not duplicate MCP approval, tool registration, cancellation, or session business semantics.
- Do not upload `0.1.2` until current-mac isolated-profile acceptance, worker-idle recovery, and
  platform-neutral Host/extension protocol tests pass. This reconnect-only release does not require
  a new Windows installer build because Host and daemon wire protocols are unchanged.
- Do not describe an unsigned or structurally inspected Host as release-signed.
