# Interactive HTML Artifacts (Gen UI)

## Status

Status: design approved for implementation
Owner: Web / Contracts / Daemon
Last verified: 2026-10-26

## Background and competitive reference

ZCode renders assistant-produced HTML as inline interactive views (charts,
simulators, tools) that the user can click through next to the conversation.
Ling's artifact previews are static (`markdown`, `code`, `image`, `diff`, ...).
A large class of useful outputs — data visualizations, small calculators,
interactive mockups — currently arrive as code the user must save and open.

## Goal

A conversation or run can produce a self-contained HTML artifact that the user
opens in a sandboxed, interactive preview inside Ling (right dock / artifact
viewer), without it ever getting script access to Ling's APIs or the daemon.

## Design

### 1. Contract: `html_interactive` preview kind

`packages/contracts/src/artifacts.ts`:

```ts
export interface PreviewHtmlInteractive {
  readonly html: string;            // full document, self-contained
  readonly sandbox: readonly string[]; // fixed allowlist, see below
}
```

`PreviewContentKind` gains `"html_interactive"`. `PreviewContentResponse`
gains `htmlInteractive?: PreviewHtmlInteractive`.

### 2. Rendering: static by default, explicit script trust

- Opening a preview renders a static document with an empty `sandbox` and a
  trusted outer document enforcing `script-src 'none'`. The outer frame also
  restricts navigation of its inner document to `about:`.
- “Run interactive preview” explicitly enables `allow-scripts` for that exact
  document. The UI explains that scripts can contact external services. Stop,
  closing or switching the preview, and any content change revoke this trust.
  Neither frame gains `allow-same-origin`, cookie/storage access to Ling,
  top navigation, popups, or form submission.
- The resource CSP blocks HTTP subresources, fetch and nested frame loading;
  it is **not a network sandbox**. Chromium can send WebRTC STUN packets despite
  `connect-src 'none'`. Only the default script-disabled preview prevents this
  automatic execution; explicitly trusted scripts may use browser networking.
- The daemon returns scanned HTML as JSON preview data with an injected
  resource CSP. The renderer creates the fixed outer document and sandbox;
  preview JSON is never interpreted as a grant of browser permissions.
- No `allow-top-navigation`, no `allow-popups` in V1.
- Size cap (e.g. 2 MB) and a static sanity scan (reject `src=http*` remote
  scripts by default — offline-first, remote resources are a follow-up opt-in
  flag per artifact).

### 3. Production path for agents

Same as document deliverables: the harness gains a bounded tool
`html_artifact_create` (or reuses `deliverable_create` with kind `html`) that
registers an artifact with `contentType: text/html` and
`interactive: true`. Runs already persist artifacts; the transcript renders an
"Open interactive preview" block via the existing RichContent pipeline
(`packages/conversation-ui-react/src/blocks/RichContent.tsx`).

### 4. Compatibility analysis

| Existing surface | Impact | Handling |
|---|---|---|
| `PreviewContentKind` switch statements | additive | New kind; default branch keeps `unsupported`. Audit all consumers (`apps/desktop/main/local-files/preview.ts`, daemon `previews` feature, web dock). |
| Desktop local file preview | reuse | The same sandboxed iframe component lives in `conversation-ui-react` so web and desktop share it; desktop `local-files` only needs to serve the bytes. |
| Security review gates | front-loaded | Opaque-origin sandbox + CSP decided up front; no eval, no `allow-same-origin` anywhere. |
| Existing markdown/code previews | unchanged | They remain the fallback when `interactive` is false. |

### 5. Incompatible-case upgrade path

If a future need requires `allow-same-origin` (e.g. persisted interactive
state), that is a *new* preview kind (`html_interactive_persisted`) behind an
explicit authority grant — never silently added to the existing sandbox.
The renderer applies its fixed sandbox allowlist; it never grants extra
permissions based on an arbitrary `sandbox` array in a preview response.

## Implementation plan

1. Contracts: kind + response field + sandbox allowlist constant.
2. Daemon `previews`: detect `contentType: text/html` artifacts flagged
   interactive; serve through CSP-hardened route; cap + scan.
3. `conversation-ui-react`: `HtmlInteractiveFrame` component (sandbox iframe,
   height resize via postMessage handshake inside the frame document).
4. Web right dock + artifact viewer integration; desktop renderer reuses it.
5. Harness tool + artifact registration.
6. Tests: contracts unit test (allowlist), daemon route test (CSP headers,
   size cap, remote-script rejection), Playwright spec: agent artifact →
   interactive preview renders a button and responds to click, screenshots.

## Acceptance

- A run-produced HTML artifact renders statically until the user explicitly
  enables interaction, then responds to the click counter demo. Stopping
  restores a fresh static preview inside the right dock on web; screenshot
  evidence is captured.
- Attempting to load a remote script inside the artifact is blocked (test).
- All existing preview suites remain green.
