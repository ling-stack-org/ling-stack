# Chrome Browser Built-in Plugin

## Status

Active product and architecture contract for the first Ling-managed Chrome extension integration.

This contract supersedes the blanket `browser: deferred` statement in
[Ling Web Tools](ling-web-tools.md). Public search and URL reading remain daemon evidence tools;
interactive control of the user's existing Chrome profile is a separate built-in plugin backed by
an explicitly installed Manifest V3 extension.

## Decision

Ling ships a product-managed Plugin Manager entry named `Chrome`. The plugin contributes one
logical MCP server whose tools operate the user's existing Google Chrome tabs, login state and
browser profile through a Ling-owned extension.

The integration uses:

```text
Ling conversation / teammate / channel
  -> existing MCP tool selection, binding, approval and audit
  -> built-in:chrome plugin + mcp_chrome_browser
  -> daemon browser generation broker
  -> authenticated loopback WebSocket session
  -> Ling Chrome Manifest V3 extension
  -> chrome.tabs / chrome.scripting / content-script DOM adapter
  -> the user's existing Chrome window and tabs
```

Ling does not silently install, sideload or policy-force a Chrome extension. Normal users approve
the Chrome Web Store installation. Development builds may use `Load unpacked` from the committed
extension output, but that path is never presented as the production installation flow.

## Product Goals

- Show Chrome as a first-class built-in item in Plugin Manager.
- Reuse the user's open tabs and authenticated browser sessions without launching a second profile.
- Keep pairing, enablement, health, tool availability and revocation understandable from Ling.
- Reuse MCP bindings, approval enforcement, run snapshots, cancellation and audit instead of adding
  a private browser permission engine.
- Keep browser content and commands local between Chrome and the loopback Ling daemon.
- Fail closed when the extension ID, credential, protocol version, workspace or active session is
  missing or stale.

## Non-Goals

- No hidden or forced Chrome extension installation.
- No Chrome password, cookie, payment, autofill or credential database access.
- No browsing-history, bookmark or download management in V1.
- No arbitrary JavaScript evaluation, network interception or response-body capture in V1.
- No control of `chrome://`, `chrome-extension://`, `file:`, `data:` or `javascript:` URLs.
- No Firefox, Safari, Edge, Brave, Opera or Vivaldi support in the first release.
- No remote browser relay or cloud browser session.
- No bypass around MCP tool approval, teammate binding or run cancellation.

## Stable Identities

```text
plugin id:          built-in:chrome
logical MCP id:     mcp_chrome_browser
protocol:           ling.chrome.v1
extension package:  @ling-stack/chrome-extension
```

The production Chrome Web Store extension ID is `mbmlnnfhebclljonhedpjghbhibfapei`, derived from
the Store-issued public key committed in the manifest. The legacy development ID
`ggmhibjboaedlnidbemkefonahjgcapc` remains an explicit compatibility allowlist entry. The daemon
never accepts an arbitrary `chrome-extension://` origin.

## User Experience

### Plugin Manager row

The row uses the Chrome icon and the description `Control Chrome with Ling`.

Product states:

| State | Meaning | Primary action |
| --- | --- | --- |
| Disabled | Ling access is off | Enable |
| Extension required | Plugin requested, but the Ling extension has not paired | Connect Chrome |
| Waiting for Chrome | A credential exists, but no current extension session is connected | Check connection |
| Ready | Extension session and MCP tools are available | Details |
| Needs attention | Protocol, credential or extension identity failed | View repair steps |

The default layer does not expose extension IDs, WebSocket URLs, token hashes or MCP server IDs.
Those values remain in technical diagnostics.

### Connect flow

1. User enables Chrome in Plugin Manager.
2. Ling shows the official Chrome Web Store action and a short-lived pairing code.
3. User installs/opens the extension and reviews the prominent local-data disclosure in its popup.
4. User enters the code and explicitly checks consent; Connect remains disabled until both are present.
5. The extension exchanges the one-time code for a persistent random credential.
6. The extension stores only the raw credential in `chrome.storage.local`; Ling stores only its
   SHA-256 hash.
7. A successful authenticated WebSocket session changes the plugin to Ready and exposes tools.

Disable closes the active session and removes runtime eligibility while preserving the pairing for
quick re-enable. `Remove Chrome access` revokes the credential, closes the session and requires a
new pairing code. When the extension receives the authoritative `4003 / chrome_access_revoked`
close signal, it removes its local credential and workspace binding and does not reconnect. Other
disconnect reasons, including ordinary plugin disable, must preserve the local pairing.
If access was revoked while Chrome was offline, the next authoritative
`4002 / chrome_browser_credential_invalid` close performs the same local cleanup instead of
entering an invalid-credential reconnect loop.

## Extension Surface

The Manifest V3 extension uses a small popup and one background service worker. A content script
provides bounded semantic snapshots and ref-based interactions. It is injected on demand only after
an approved browser tool targets an HTTP(S) tab; the manifest does not install it on every page.

Required permissions:

```text
scripting
storage
host_permissions: <all_urls>
```

V1 does not request `debugger`, `history`, `bookmarks`, `cookies`, `downloads`, `webRequest` or
`nativeMessaging`.

Chrome requires `<all_urls>` or temporary `activeTab` for `captureVisibleTab`. Ling needs reliable
approved screenshots after navigation, so V1 keeps `<all_urls>` and removes the redundant `tabs`
and `activeTab` permissions. Ling still rejects all non-HTTP(S) tabs in its own command and
content-script policy, and Chrome keeps file URL access off unless the user separately changes the
browser-owned extension setting.

The popup shows only:

- Ling connection state;
- daemon address fixed to loopback;
- pairing-code input while unpaired;
- a prominent disclosure of URL, visible-content, interactive-label and screenshot handling;
- an unchecked explicit-consent control that gates the first connection;
- Connect / Disconnect;
- the active tab title and origin when connected.

## Pairing And Session Protocol

### HTTP pairing

```http
POST /plugins/built-in%3Achrome/pairing?cwd=...
POST /browser-extension/v1/pair
POST /plugins/built-in%3Achrome/revoke?cwd=...
```

`pairing` requires an enabled plugin and creates a single-use, high-entropy code with a five-minute
TTL. Only one live code exists per workspace. Failed attempts are rate limited.

`/browser-extension/v1/pair` accepts requests only from a configured
`chrome-extension://<id>` Origin and a loopback Host. It consumes the code and returns one random
credential exactly once. Raw credentials and pairing codes never enter logs, events, plugin health
or API responses after issuance.

### WebSocket session

```text
WS /browser-extension/v1/connect?cwd=<encoded workspace>
Origin: chrome-extension://<allowlisted-id>
first message: authenticated hello with protocol, extension version and credential
```

The server authenticates before accepting commands. One workspace owns at most one active Chrome
session. A newer valid session replaces the older one. Heartbeats expire silently after a bounded
deadline. Disable, revoke, daemon shutdown and workspace-authority changes close pending commands
and reject late results.

Command envelope:

```ts
interface ChromeBrowserCommand {
  readonly protocol: "ling.chrome.v1";
  readonly id: string;
  readonly method: ChromeBrowserMethod;
  readonly params: unknown;
  readonly deadlineAt: string;
}

interface ChromeBrowserResult {
  readonly protocol: "ling.chrome.v1";
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}
```

Payloads are size bounded. Unknown fields, duplicate IDs, expired commands and results from a
replaced session fail closed.

## Initial MCP Tools

| Tool | Purpose | Default approval |
| --- | --- | --- |
| `chrome_tabs` | List bounded tab metadata | ask |
| `chrome_snapshot` | Read visible semantic page content and interactive refs | ask |
| `chrome_navigate` | Navigate or create an HTTP(S) tab | ask |
| `chrome_click` | Click a ref from the latest snapshot | ask |
| `chrome_type` | Enter text into a non-password ref | ask |
| `chrome_screenshot` | Capture the visible viewport | ask |

All tools use the existing MCP tool pipeline. Tool definitions, calls, approvals, results and
failures therefore remain visible in run records. Enabling the built-in plugin creates one explicit
`all_current_tools` binding for the protected `ling_agent`, because normal conversations cannot edit
that teammate's hidden advanced-tool page; every tool still defaults to `ask`. Custom teammates are
never auto-bound and continue to use their existing Tools and permissions editor.

Snapshot rules:

- visible text and interactive elements only;
- maximum text, node count and nesting depth are bounded;
- password values, hidden inputs and form secrets are never returned;
- refs are scoped to tab ID, document identity and snapshot revision;
- stale refs fail instead of searching for a similar element;
- screenshots are compressed and bounded before entering MCP results.
- every page-derived text result is wrapped in a top-level `untrusted_web_content` envelope, and
  every screenshot is preceded by the same trust notice; browser content is evidence, never an
  instruction source.

## Managed Plugin Integration

`built-in:chrome` is returned by the product-managed built-in descriptor catalog. Enablement creates
or reconciles `mcp_chrome_browser` and its linked contribution. Built-in plugins do not require a
package-cache record. The logical MCP server uses an internal generation broker; its placeholder
transport is never contacted, so no unauthenticated browser-control MCP listener is exposed on
loopback.

The plugin is effectively injectable only when:

- the managed record is enabled;
- a valid paired credential exists;
- the allowlisted extension has a live authenticated session;
- plugin health is Ready;
- the logical MCP server and contribution are enabled.

Health and catalog projection consume the browser-session controller. The renderer never infers
readiness from Chrome process names, extension files or stale health copy.

## Persistence

Add a feature-owned credential table:

```text
chrome_browser_credentials
- workspace_id
- plugin_id
- extension_id
- credential_hash
- created_at
- updated_at
- revoked_at
```

Only a SHA-256 credential hash is stored. Pairing codes, raw credentials, tab content, screenshots
and command payloads are not persisted by this table. Generic run and MCP audit records continue to
own executed tool evidence.

## Security Boundaries

- Bind HTTP and WebSocket surfaces to loopback only.
- Validate Host and exact Chrome extension Origin before parsing pairing/session bodies.
- Use constant-time credential hash comparison.
- Enforce pairing TTL, one-time use, attempt limits and one active session per workspace.
- Redact credentials, pairing codes, typed text and screenshot bytes from daemon logs.
- Mark page titles, URLs, visible content and screenshots as untrusted before they enter the model
  context so webpage prompt injection cannot silently become trusted instructions.
- Reject password/file inputs and browser-internal or non-HTTP(S) navigation.
- Apply command deadlines and run cancellation; late extension results cannot commit.
- Keep the extension source auditable and dependency-light.
- Never claim Web Store availability until the final extension ID and listing are published.

## Distribution

The repository carries extension source and a deterministic ZIP build. Desktop packages may include
the ZIP and license/notice files for diagnostics, but Chrome installation still goes through the Web
Store. Release metadata binds:

- extension version;
- manifest hash;
- public-key-derived extension ID;
- minimum Chrome version;
- supported daemon protocol version;
- Web Store URL once published.

## Acceptance

- Chrome appears as Built-in in Plugin Manager without affecting Cua Driver or local plugins.
- Unpaired, paired-disconnected, connected, disabled, revoked and incompatible states are distinct.
- Extension install and pairing require explicit user action.
- All six tools execute through MCP approval and are rejected when disabled, disconnected, stale or
  cancelled.
- No cookies, passwords, history, bookmarks or raw credentials appear in API/log/test artifacts.
- macOS and Windows path-independent daemon/extension tests pass; real Chrome acceptance is required
  on the current macOS host, while Windows packaged/Web Store acceptance remains separately stated.

## Hard Stops

- Do not reuse Cua Driver screenshots or coordinate clicks as the Chrome extension transport.
- Do not expose a generic JavaScript-eval tool.
- Do not weaken Chrome installation prompts, MCP approval or extension-origin validation.
- Do not add a second plugin database or a second runner tool-injection path.
- If Chrome requires a native helper for production reliability, stop and design its packaging,
  signing, update and uninstall ownership before adding that binary.
