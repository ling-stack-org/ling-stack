# T13-P.3-W Channel Workflow Status Formal Evidence

## Scope And Provenance

- Slice: `T13-P.3-W`, formal Web evidence for the status presentation implemented by `T13-P.3-U`.
- No new Function ID is introduced by this evidence-only slice.
- Branch: `codex/ui2-desktop-coverage-foundation`.
- Capture HEAD: `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Local `origin/main` at capture: `db56fd7f3885d8146a363b8aa4449521af0e200e`.
- Merge base: `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Capture date: 2026-07-26.
- The shared worktree was intentionally dirty at capture: 347 tracked changes and 1,494 untracked entries.
- The screenshots therefore prove the served dirty-worktree Vite source, not the committed HEAD in isolation.
- The evidence slice did not modify production, CSS, API, contracts, state, i18n, master plans or migration documents.
- The only test change is two capture-composition calls to `scrollIntoViewIfNeeded()` after the existing Light/Dark
  Workflow queue assertions. Fixture data, assertions and production behavior are unchanged. Final focused-spec
  SHA-256: `b8ea1d1b160bb4bc3c02aa9f1d402de16d3e1582c14d7f8649b295c7688bc19e`.

The first capture made before the Runtime supervisor MetaRow containment repair was an invalid draft: its labels and
values visibly overlapped (`Runtimeruntime...` and `Statushealthy`). Those two files were not accepted as evidence and
were overwritten after the focused Runtime CSS fix was stable. A subsequent clean-but-poorly-framed draft exposed
only the Workflow queue bottom edge; it was also overwritten after the permitted capture-composition adjustment.
The accepted capture used
`channel-runtime-diagnostics.css` SHA-256
`b8cdf792816ff6e79403f517ce1c4f7bd82571f2726602ef52cd5be0d9a53c2c`.
The repaired Runtime/PID/Status/Started rows were inspected at original size in the discarded post-fix intermediate
capture and were separated correctly. The accepted formal screenshots intentionally scroll the Dock to the Workflow
queue, so those final rasters do not independently display or prove the Runtime MetaRow repair.

## Reproduction

The final screenshots were captured from the real Web renderer served by the Playwright-managed Vite source server
on independent port `4298`. The existing focused spec and mock daemon fixture were used with only the two permitted
post-assertion queue scroll calls described above.

```bash
LING_UI2_SCREENSHOT_DIR="$PWD/docs/design/ui2.0升级/evidence/conversations/channel-workflow-status" \
LING_PLAYWRIGHT_PORT=4298 \
corepack pnpm --filter @ling-stack/web test:e2e -- ui2-channel-workflow-status-presentation.spec.ts
```

Final result: `3/3` Chromium tests passed in 7.0 seconds.

## Status Matrix And Automated Assertions

- Workflow presentation exhaustively verifies 8 states: `draft`, `ready`, `running`, `waiting_for_approval`,
  `blocked`, `succeeded`, `failed`, `cancelled`.
- Workflow Step presentation exhaustively verifies 9 states: `queued`, `claimed`, `running`,
  `waiting_for_approval`, `blocked`, `succeeded`, `failed`, `skipped`, `cancelled`.
- Linked Run presentation exhaustively verifies 6 runtime states: `queued`, `running`,
  `waiting_for_approval`, `succeeded`, `failed`, `cancelled`; the non-running `saved` fallback is also asserted.
- The real page fixture displays a `waiting_for_approval` Workflow, all 9 Step states, a linked Workflow in
  `waiting_for_approval`, and a linked Run in `failed`. Visible labels are translated product labels rather than raw
  snake_case, with the expected neutral/info/warning/success/danger tone.
- `Advance`, Workflow `Cancel`, `Start step`, `Start + run`, `Retry`, Step `Skip` and Step `Cancel` remain present
  with the expected enabled/disabled state. Proposal Edit/Cancel, permission confirmation, collaboration evidence,
  authorize and Open run surfaces are exercised before capture.
- Long workflow title/objective, Step prompt/blocker, proposal title/error and unbroken segments remain contained.
- The document, Workflow queue card, every Step card, proposal card and linked-status row each have horizontal
  overflow no greater than the one-pixel geometry tolerance.
- The runtime collector reports `console.error=0` and `pageerror=0` at both final capture points.

## Screenshot Validation

Both files are non-empty, 8-bit RGB PNGs without alpha. Signal-stat variance confirms nonblank raster content:

- Dark: `YMIN=19`, `YAVG=32.1482`, `YMAX=235`, `SATAVG=1.29956`.
- Light: `YMIN=30`, `YAVG=227.673`, `YMAX=235`, `SATAVG=0.80217`.

| File | Theme / viewport | Bytes | SHA-256 | Original-size visual inspection |
|---|---|---:|---|---|
| `1440x960-ling-light-workflow-statuses.png` | `ling-light`, 1440x960 | 241030 | `bf42aa061c31f1ca0b4d8147f6ceb3cb6c885a9e2ac7aca3660ae09943293b67` | The queue is framed from its top: the Workflow title/status semantics, warning dot, Advance/Cancel actions and long title/objective wrapping are visible. Step activity projections remain readable, the linked proposal error and Authorize/Open run actions stay contained, with no overlap or horizontal overflow in the visible queue composition. |
| `1280x800-ling-dark-workflow-statuses.png` | `ling-dark`, 1280x800 | 206194 | `0c5a15d2b62f784b8c61edf779a419b1fb9425224117ea701311f3a9578a872a` | The Dock composition clearly exposes the first visible Step cards and their semantic indicator dots for Claimed, Running, Waiting for approval and Blocked, together with the related actions. Dark surfaces and long Step content remain contained without white leakage, overlap or horizontal overflow. |

The evidence pair now shows the Workflow queue header/status in Light and multiple Step StatusIndicators in Dark.
The complete 9-Step matrix and linked Workflow/Run status row cannot all fit in one fixed-height Dock raster; their
labels, tones and containment are verified immediately before each screenshot by the same focused test. The images
are representative visual evidence, not a substitute for the exhaustive matrix assertions above.

## Evidence Boundary

- These files prove the mocked Web product surface rendered by Chromium from Vite source.
- They include the Web AppShell frame but do not close full AppShell route/geometry acceptance.
- They do not prove a real daemon, provider, terminal process, Electron host, native window material, macOS Retina,
  Windows DPI, packaged restart or packaged Desktop behavior.
- Packaged macOS and Windows evidence remains a separate acceptance lane.
