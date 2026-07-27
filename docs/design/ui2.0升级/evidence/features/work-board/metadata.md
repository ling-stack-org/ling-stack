# Work Board UI 2.0 Evidence Metadata

## Scope And Status

- Verified: `2026-07-23`, Vite source at `http://127.0.0.1:4203`, Playwright Chromium, one worker.
- Web IDs verified: `BOARD-LIST-001`, `BOARD-ROW-001`, `BOARD-DETAIL-001`, `BOARD-EMPTY-001`,
  `BOARD-OPEN-001`, `BOARD-GUIDE-001`.
- Focused + legacy result: `12/12`, including one Light/Dark selector-owner case covering global and Channel roots.
- Selected `4211` regression: `147/147`; app `19/19`, approvals `2/2`, runtime `19/19`, Dark `2/2`,
  Channel `105/105`. The support helper now enters the public Channel Work Board DataRow/action contract instead of
  querying the removed legacy `article` structure; task detail still opens through the shared right dock.
- A stronger `156`-test run including AI Teammate Tasks completed `154/156`; the two unrelated Channel timing cases
  each passed `3/3` in isolation, then both passed in the exact `147/147` gate. This remains a suite-stability note,
  not a Work Board product failure.
- The action failure remains productized in InlineFeedback; optional raw `technicalMessage` is only available inside
  a closed `Technical details` InspectorSection, with a translated fallback when no raw message exists.
- Packaged Electron macOS/Windows evidence remains P13 pending.

## Screenshot Ledger

All PNGs are original Playwright viewport captures. Every `.metadata.json` sidecar reports `verification=verified`,
console pass, exact image dimensions, matching SHA-256 and document overflow `0/0`.

| Evidence | State | SHA-256 |
|---|---|---|
| `1440x960-ling-light-actionable-mixed.png` | mixed actionable list and keyboard-selected Inspector | `71445ebd96762a323a292182539c2091f12555e604312fb7bd600e2e26e27694` |
| `1440x960-ling-light-durable-fail-dialog.png` | failed durable mutation, retained reason, raw detail folded | `e02f52c34f7c0a683819dd546c7f0146595867811144c9ad2e11c4c37dd85ff4` |
| `1440x960-ling-light-approval-inspector.png` | pending approval, exact Inbox action, no inline decision | `cb9302efbaba7de803ac852d6e4a479d92980f0cc97e54fa388e6324027ba70c` |
| `1440x960-ling-light-selected-missing.png` | authoritative removal with explicit recovery | `1fdded3fbc5b8d6455f684c2cc60b864940af0c5d9489c94455bc6af7feb5aeb` |
| `1280x800-ling-dark-retained-stale.png` | retained capped rows after source refresh failure | `e868b849b59b093039a664cc49bdeecd62f9a279255818a4d079ad825d35da48` |
| `1280x800-ling-dark-filter-no-result.png` | active filter with no result and clear action | `b3b4a04e23eb627d9922a2ce291f993477153ada4766652ebd9a6fd196c124fa` |
| `1280x800-ling-dark-long-list-reduced-motion.png` | 120-row long list and independent scroll owners | `1000cba8dbcc3338adc0680ed884e392c025745be087ec7c437001621a18fa1b` |
| `1280x800-ling-dark-channel-projection.png` | bounded Engineering Channel projection | `9d518097281db8b4be5358c4ec86598bb5cb32584525d2183020702d55f1dcd4` |
| `1280x800-ling-dark-true-empty.png` | true empty state with collapsed guide | `e3f268c8949d0ae115a2b50d88b04a64468624442726233853fd0bb72e884c15` |

## Selector And Theme Ownership

- `work-board.css` is a five-line import manifest. `page.css`, `toolbar.css`, `list.css`, `inspector.css` and
  `channel.css` are the only Work Board visual selector sources; all 48 focused class names have production JSX
  references and no production Work Board class is missing a focused CSS reference.
- Before the exclusion, the real Dark page matched eight `strict-console.css` rule groups: the explicit page entry,
  structure, head/detail/content, heading/strong, muted copy, non-UI2 role button, selected and waiting status blankets.
- The explicit `:root[data-theme="dark"] .work-board-page` entry is removed. All 21 related Dark blanket selectors
  exclude `.work-board-page` / `.channel-work-board` and their descendants through one zero-specificity public-root
  boundary. The post-change Light, Dark and Channel audits all report `strictConsoleMatches=[]`.
- Real-page computed values equal semantic token resolutions. Light: panel `rgb(255, 255, 255)`, default text
  `rgb(43, 48, 54)`, strong text `rgb(18, 20, 23)`, subtle surface `rgb(241, 243, 245)`, border
  `rgb(217, 221, 226)`. Dark: panel `rgb(23, 26, 29)`, default text `rgb(215, 219, 224)`, strong text
  `rgb(244, 245, 246)`, subtle surface `rgb(34, 38, 43)`, border `rgb(53, 59, 66)`.
- Focused sources contain zero Dark/Profile selectors, `!important`, literal colors, private keyframes or
  `transition: all`. Shared UI primitives remain the owner for their internal Button/DataRow/Status/overlay visuals.

## Visual Audit And Remaining Gates

- List and Inspector retain independent vertical scroll; no root horizontal or vertical overflow appears.
- Dialog, reason Textarea, failure feedback and closed Technical details fit without overlapping footer actions.
- Light/Dark surfaces use semantic tokens; every sidecar contains focused matched rules, computed token values and
  zero matching strict-console rules. Long rows do not widen action columns.
- No claim token, raw transport error or technical message appears in the default layer.
- `T13-D` Web selector/theme-owner closeout is complete. Custom imported Theme Pack and packaged Desktop evidence are
  not represented by this ledger and remain global gates.
