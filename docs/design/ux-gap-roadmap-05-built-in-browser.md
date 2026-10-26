# Built-in Browser Automation

## Status

Status: design approved (phased); Phase 1 + 2 in implementation
Owner: Daemon / Browser Host / Desktop
Last verified: 2026-10-26

## Background and competitive reference

MiniMax Code connects the user's browser out of the box; ZCode bundles a
driven browser with screenshot verification. Ling's Chrome extension provides
6 tab tools but requires manual native-messaging pairing, an installed Chrome,
and is not yet store-published. The result: on a fresh machine, the agent
cannot see the web at all.

## Goal

A fresh install can, with zero extensions: open a page, click, type, screenshot,
and extract content — inside an explicit, user-visible browser session — while
the Chrome extension path remains available and unchanged for users who prefer
their own profile.

## Design (phased)

### Phase 1 — daemon-driven Playwright browser (MVP, no desktop dependency)

- New daemon feature `features/builtin-browser/` driving
  `playwright-core` against a channel-downloaded Chromium (or detected system
  Chrome via `channel: "chrome"`). `playwright-core` is dependency-light and
  already battle-tested in this repo's own e2e stack, minimizing new supply chain.
- Session model: `BrowserSession { id, ownerScope (channel|conversation|teammate_private), headless, profile: "ephemeral" | "ling-persistent" }`.
  `ling-persistent` stores a dedicated user-data-dir under the daemon data root
  — never the user's real Chrome profile.
- Tools exposed to the agent (bounded, approval-gated, reusing the authority
  model):
  `browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`,
  `browser_snapshot` (a11y tree), `browser_extract`.
  Screenshots become image artifacts via the existing registry.
- Egress honesty: these are real navigations; they flow through the same
  audited-public-destination pinning as everything else, with an
  interactive-confirmation for first navigation to any new host (approval
  `ask | smart | always` per host rule — the command-rule approval mechanism
  generalizes to host rules).

### Phase 2 — manual handoff to real profile (read-only assist)

The Chrome extension path gains a "share current tab to Ling" action that
pushes a read-only snapshot (a11y tree + screenshot) of the user's actual tab
into the conversation — no control, closes the biggest practical gap without
asking users to hand over profile control.

### Phase 3 — desktop PiP surface

The desktop Computer Use PiP window can host the built-in browser's visible
viewport (composited via CDP screencast) — deferred to after computer-use
hardening (item 06) since they share the capture surface.

### Compatibility analysis

| Existing surface | Impact | Handling |
|---|---|---|
| Chrome extension + browser-host | unchanged | Different transport (native messaging vs CDP). Tool names kept distinct (`chrome_*` vs `browser_*`) so skills referencing either remain valid. |
| Command-rule approvals | reused | Host rules are a new rule subject alongside command rules; the once/persistent approval UX is reused verbatim. |
| Computer use PiP | phased | Phase 3 composes; no shared code until then. |
| Media/screenshots | reuse | Screenshots register through the artifact registry; image preview + compare modes already exist. |

### Incompatible-case upgrade path

Playwright major bumps are confined to the daemon feature; the tool contract
(a11y snapshot + screenshot bytes) is renderer-agnostic and versioned in
contracts (`browserToolContractVersion`). If a future engine replaces
Playwright (e.g. CDP-direct), tools keep their schemas; only the feature module
swaps.

## Implementation plan

1. Contracts: session + tool schemas, host-rule approval subject.
2. Daemon feature: session manager (spawn/attach/teardown, hard timeout,
   crash containment), tool handlers, route for session listing + manual stop.
3. Authority wiring: first-visit host approval; `always` persists a host rule.
4. Web settings: "Built-in browser" card (session list, stop, data-dir reset).
5. Tests: daemon unit (session lifecycle, teardown on crash), tool handler
   tests against a local static server (no external network in CI), approval
   flow unit tests, Playwright spec with mocked daemon asserting the settings
   card + conversation tool blocks, screenshots.

## Acceptance

- Against a local test page: navigate → snapshot → screenshot artifact flow
  completes under unit tests without external network.
- Unapproved host navigation blocks and raises an approval (unit test).
- Chrome extension suites untouched and green.
