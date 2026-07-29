# Channel Activity / Work Thread Evidence

## Scope

- Slice: `T13-O.16 Channel Activity / Work Thread focused owner`.
- Reachable production surface: Channel Activity filters, search, no-result, drilldown and triage.
- Disabled inventory surface: Work Thread tree visual states.
- Input containment remains owned by frozen `T12.1b`; no shared Input component or global focus rule changed.

## Migration Result

- Audited source: 583 physical lines, 73 rules and 90 selector branches across `components.css` and
  `strict-console.css`.
- New owner: `apps/web/src/styles/channel-activity-work-thread.css`, 556 lines.
- Aggregate change: `components.css 5,434 -> 4,867`; `strict-console.css` Activity repaint branches removed.
- Web CSS: 153 files / 38,296 lines.
- Removed dead selectors: two `.channel-branch-empty` rules, `.activity-saved-view-actions.compact`,
  `.activity-filter-chip.saved-view` and the mixed `.activity-view-select strong` branch.
- Preserved boundaries: `.activity-shell .message-feed`, `.compact-icon-button`, Activity confirmation/action rows,
  Conversation Block Action, Thread Reply, Runtime/Work History and the 19-line `channel-activity-controls.css` owner.
- Visual review found the disabled Work Thread no-result item stretching its flex row; the focused owner now uses
  top alignment and a full-row empty state without changing product reachability.

## Screenshot Evidence

| File | Theme / viewport | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-filters-open.png` | `ling-light`, 1440x960 | Real Channel Activity filters, saved-view controls, category and attention chips | `7719e21ca1b3bd882eb6d25a32d3b136ddbcc11b79053d05afa2a736da9d0bf0` |
| `1440x960-ling-light-search-no-result.png` | `ling-light`, 1440x960 | Real Activity search no-result while Work Board and Composer remain contained | `648c754f6caba52b4b1e93869f61f69cb3ba82fcb5ba1bd57ad9075cab77b9e5` |
| `1440x960-ling-light-drilldown-open.png` | `ling-light`, 1440x960 | Real Run drilldown with source metadata disclosure | `91173f30847f6a7d3413aeee1daa6206290c8bb319eab5aa2df99c2f517eb3f7` |
| `1440x960-ling-light-triage-failed.png` | `ling-light`, 1440x960 | Real Triage form with retained draft and retryable failure | `8d9fa2a521176c2f370d7bdf1d5874f8675d1a7db1935a464148994ae256391d` |
| `1440x960-ling-light-triage-succeeded.png` | `ling-light`, 1440x960 | Real Triage retry success and result action | `7ddf6f772b12acee6339eef234738f2f924e7aa06132108004073b1184a2246b` |
| `1280x800-ling-dark-work-thread-states.png` | `ling-dark`, 1280x800 | Disabled CSS specimen: loading, error, no-result, long title, selection and archive confirmation | `48f5bd5133ad9de7f94cfe21528602728adb21cbd030b3ed9acb9792cf29ea9d` |
| `1280x800-ling-dark-work-thread-detail.png` | `ling-dark`, 801x230 detail | Original-pixel Work Thread CSS specimen detail | `50292365d96d731a1840db825d5d2e785f7cd9b1baa57450024ba8ee1189fcc9` |

The first six captures are original-size viewport screenshots. The 801x230 image is a supplementary original-pixel
detail and does not replace viewport evidence.

## Automated Verification

- `ui2-channel-activity-work-thread.spec.ts`: `2/2`.
- Existing `channel.spec.ts --grep "channel activity"`: `7/7`.
- Runtime, Dark and Input containment combination: `25/25`.
- Web `typecheck`, UI 2.0 `lint`, `check:i18n`, production `build` and `git diff --check`: pass.
- Focused CSS forbidden scan: no color literal, numeric z-index, `!important`, Theme selector, `transition: all`,
  private keyframe or package-private `.ling-ui-*` selector.
- Browser gates: Enter interaction, 34px shell/native focus bounding boxes, retained Triage draft, failure/retry/success,
  console error, page error, owner overflow and document horizontal overflow pass.

## Honest Boundaries

- `WorkspaceClientView.tsx` currently sets `channelWorkThreadTreeVisible = false`. The Work Thread images are a
  test-only CSS specimen for the already-present component family, not evidence of a reachable product state.
- Opening Work Thread chrome requires a separate product/reachability slice; O.16 intentionally does not edit the
  4,000-line workspace view or enable hidden behavior.
- The focused search assertions confirm the prior T12.1b fix: a 34px shell contains the native input before and after
  focus with zero native border, outline and shadow. O.16 does not reopen or replace that owner.
- The production build retains the pre-existing large-chunk warning. Function IDs and packaged Desktop verification
  status are unchanged.
