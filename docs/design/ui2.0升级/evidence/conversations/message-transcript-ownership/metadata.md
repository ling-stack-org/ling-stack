# Shared Message And Transcript Ownership UI 2.0 Evidence

## Scope And Status

- Recorded: `2026-07-24`, Asia/Shanghai.
- Branch / baseline HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Working tree was already shared and dirty. Existing Desktop, Computer Use and UI 2.0 work was preserved.
- Source: the real Vite application through Playwright Chromium and daemon fixtures, not static markup.
- Themes/viewports: `ling-light`, `ling-dark`, imported `Quiet Ocean`; `1440x960` and `1280x800`.
- Status: `T13-O.27 Shared Message / Transcript ownership release` is implemented and visually evidenced on Web. It does not change Function ID status or close packaged macOS/Windows evidence.

## Ownership Boundary

- `@ling-stack/conversation-ui-react` owns MessageRow, MessageBubble and MessageActionBar structure, semantic states, 32px actions, loading/disabled/selected/danger behavior and Radix Tooltip interaction.
- Channel focused CSS owns Channel row alignment, 30px identity, full-width AI replies, Turn geometry, Transcript disclosure/status and AI footer placement.
- Normal conversation no longer emits `channel-message-row`; Normal and Teammate retain only their real surface adapters.
- `components.css` and `strict-console.css` no longer define generic Message/Action/Transcript visuals. Stable message and Transcript data attributes release both roots and descendants from the Dark blanket.
- `.conversation-message-tag`, `.channel-message-row-actions` and `.conversation-turn-segment` have no production or CSS owner.
- No API, contract, database, routing, composer, WorkCell, Dock, action-policy, Logo or Desktop behavior changed.

## Input Focus Decision

The focus overflow visible in earlier screenshots is not a global `@ling-stack/ui-react` Input defect. Shared
Input/Select/Textarea containment remains covered by `ui2-form-controls.spec.ts` (`4/4`). Activity, Work Thread,
MCP and Channel Create nested raw inputs are already closed by T12.1b. Other legacy raw controls remain in the U13
page-by-page migration lane. O.27 does not add or modify a global `input:focus` rule.

## Verification

| Gate | Result |
|---|---|
| Conversation package tests | `17/17` passed |
| Focused spec, ordinary | `3/3` passed |
| Focused spec, formal capture after final CSS fix | `3/3` passed |
| Selected conversation suite | initial `30/31`; O.28 real outside-target refresh closes the failure and final selected is `31/31` |
| Broad App/Channel/Teammates/Workspace/Dark/Theme | initial `160/165`; full-width regression exact `1/1`; O.28 refreshes four old MessageFrame contracts and all five former failures pass `5/5` |
| Web lint and i18n | passed |
| Web typecheck | passed |
| Web production build | passed; existing large-chunk warning only |
| `git diff --check` and selector/forbidden scans | passed |

The focused spec verifies Channel Turn/Transcript expand and collapse, keyboard focus, terminal blocks, Normal
own/peer/pending/failed/work-cell states, Teammate own/peer/blocked/attachment/Memory states, author/time baseline,
32px actions, real Radix Tooltip hover and keyboard focus, selected state, reduced motion, imported Theme Pack,
console/page errors and document/region overflow.

The broad suite exposed a real standalone Channel AI width regression (`602px` instead of the 740px minimum) and
a local-user message frame override. The focused Channel owner now gives AI rows the full conversation track and
restores the local-user surface padding/background contract. The width assertion passes on exact rerun. Production
code was not changed to restore deprecated pseudo-tooltip attributes or the legacy transparent-hover expectation.
O.28 later migrated the old broad assertions to exact accessible actions, the Radix Tooltip Portal and semantic hover,
and replaced the non-product coordinate outside click with a real composer target. The five former failures pass `5/5`
and the selected conversation suite passes `31/31` without production changes.

## CSS And Module Ownership

- Package `styles/blocks/message-frame.css`: 235 lines.
- Package `styles/feedback/message-action-bar.css`: 146 lines.
- Web `channel-message-transcript.css`: 438 lines.
- Web `conversation-message-frame.css`: 27 lines, retaining only feed/group/day/mention boundaries.
- `components.css`: `3,743 -> 2,890`; `strict-console.css`: `439 -> 434`; `layout.css`: 907 unchanged.
- Web CSS moves from the O.26 baseline `159 files / 35,124 lines` to `160 files / 34,438 lines`, a net reduction of 686 lines while adding one explicit focused owner.
- Production package files remain below 250 lines. The new E2E spec is 691 lines, below the 800-line boundary.

## Original-Size Screenshot Ledger

| Evidence | Viewport/theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-channel-turn-transcript.png` | 1440x960 / Ling Light | Full Channel Turn, expanded Transcript, WorkCell/terminal blocks and Radix Copy Tooltip | `f250abc4bdfa04c37f6e3e6fbf8c4ddbb16b2aad28c91c1cc1abb17c3a93ab47` |
| `1280x800-ling-dark-normal-message-states.png` | 1280x800 / Ling Dark / reduced motion | Normal own/peer/pending/failed/work-cell states and selected action | `0bb939dd631605ff4782363584f9d22c90ccccf20fa65432d362980c94052cfc` |
| `1440x960-quiet-ocean-teammate-message-states.png` | 1440x960 / Quiet Ocean | Teammate identity, attachment, expanded Memory, blocked state and Radix Copy Tooltip | `858ade89edeb3e1690fc8c0c72e2a90cc9324dcb0b5bdea81b6772f2dc205df3` |

All PNGs are direct viewport captures and were inspected at original size after the final focused run. Tooltip,
author/time alignment, action hit areas, message containment, expanded evidence and semantic Theme surfaces remain
readable without document-level horizontal overflow.

## Honest Remaining Gaps

- O.28 closed the four legacy pseudo-tooltip/transparent-hover assertions and the coordinate outside-click test debt. Production did not regain `data-tooltip` or pseudo Tooltip writers.
- Remaining raw form controls still migrate page by page under T12.1b/U13; no global focus patch is allowed.
- No packaged Electron macOS Retina or Windows 125%/150% evidence was produced.
- `components.css` remains 2,890 lines, and existing large files such as `channel.spec.ts`, `app.spec.ts`, `WorkspaceClientView.tsx` and `TeammateWorkspace.tsx` remain architecture debt. O.27 did not add production behavior to those files.
