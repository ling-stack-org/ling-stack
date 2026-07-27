# Shared Conversation Work Cell Shell/Artifacts Evidence

## Scope

- Slice: `T13-O.15 Shared Conversation Work Cell Shell/Artifacts owner`.
- Surfaces: Channel, Normal Conversation and AI Teammate Private Chat.
- Families: WorkCell root and Operation Shell, Artifact Strip, changed files, Reference Strip, artifact hover preview,
  file-open trigger adapter and Channel turn layout adapters.
- Business behavior, projector, API, contracts, i18n, Summary, Input and O.14 Activity/Details owners are unchanged.

## Migration Result

- Audited source: 825 physical lines, 106 rules and 141 selector branches from non-contiguous `components.css` families.
- New owner: `apps/web/src/styles/shared/conversation-work-cell-shell-artifacts.css`, 690 lines.
- Aggregate change: `components.css 6,259 -> 5,434`.
- Web CSS: 152 files / 38,323 lines.
- Removed dead families: WorkCell rail; old head/kicker/summary; unreachable OperationBubble kind/copy/source/actions/action/section;
  obsolete artifact-row direct SVG branch.
- Preserved boundaries: shared `conversation-settle-in`, generic workspace file-open menu/popover, O.14 Activity/Details,
  File Diff contextual adapters and Runtime Feedback remain with their existing owners and import order.
- Screenshot review exposed a pre-existing missing owner for `.workspace-file-open-trigger`; O.15 restores one 32px,
  token-only artifact-row adapter so the control no longer falls back to a native gray button.

## Screenshot Evidence

| File | Theme / viewport | Reachable state | SHA-256 |
|---|---|---|---|
| `1280x800-ling-dark-channel-artifact-hover.png` | `ling-dark`, 1280x800 | Channel WorkCell, Artifact Strip, changed files, diff hover preview and restored Open With trigger | `93fae7d47f7e80dee6f00adc14393dd318251a40839bbb9fe66a5b36d2ebef37` |
| `1280x800-ling-dark-channel-reference-focus.png` | `ling-dark`, 1280x800 | Channel message reference focused from keyboard; full app containment | `7551a8c95482e74724e937f02912f6fc8b531d61521974521880cbd916595e56` |
| `ling-dark-channel-reference-tooltip-detail.png` | `ling-dark`, 321x76 detail | Visible structured Reference tooltip and long workspace path wrapping | `97980e6542626bbc8f197c765bf258d919f257e88756164335f68aec2cdd791f` |
| `1440x960-ling-light-normal-work-cell-shell.png` | `ling-light`, 1440x960 | Normal Conversation shared WorkCell shell and completed command batch | `a954a9e60a19a1cf96a8ce4108a01671a5c4232be1e7b0b21591976ac141e3b6` |
| `1280x800-ling-dark-teammate-work-cell-shell.png` | `ling-dark`, 1280x800 | AI Teammate Private Chat shared WorkCell shell in reduced motion | `3019d9fd4d49c0da49973843dadda2b6587bc26c59bb3a1bc52340f898ca7dad` |

All four viewport captures are original-size PNGs. The 321x76 image is a supplementary original-pixel detail capture,
not a replacement for viewport evidence.

## Automated Verification

- `ui2-conversation-work-cell-shell-artifacts.spec.ts`: Channel, Normal and Teammate focused states; `3/3`.
- Combined O.15 + O.14 + File Diff focused suite: `12/12`.
- App + Channel + Teammates + Dark broad regression: `147/147`.
- Web `typecheck`, UI 2.0 `lint`, `check:i18n`, production `build` and `git diff --check`: pass.
- Focused CSS forbidden scan: no color literal, numeric z-index, `!important`, Theme selector, `transition: all` or
  package-private `.ling-ui-*` selector.
- Browser gates: keyboard Enter/Tab, hover preview, visible Reference tooltip, reduced motion, console error,
  page error and document horizontal overflow pass.

## Honest Boundaries

- Normal and Teammate focused fixtures expose the shared shell and command batch but do not synthesize Artifact/Reference
  data. Deep Artifact, changed-file, hover and Reference states are therefore verified on the real Channel demo; the existing
  Teammates structured-reference regression also passes in the `147/147` suite.
- The production build retains the pre-existing large-chunk warning.
- `T12.1b` input focus containment remains closed and unchanged; O.15 does not add a global Input override.
- No Function ID or packaged Desktop verification status changes in this CSS ownership slice.
