# macOS Fixed Titlebar, First Run, And Settings Layout Fix

Status: approved for local implementation and packaged macOS acceptance

## Intent

Repair three layout ownership failures without changing product behavior:

- First Run connectors must yield space to readable step labels.
- macOS Sidebar toggle ownership must stay in Desktop Chrome across expanded and collapsed states.
- Settings traffic-light clearance must belong to the navigation container, not the Back button width.

## Implementation

1. Keep step icons and labels at content width, give connectors the flexible remainder, and use a compact
   vertical list only when the dialog is genuinely too narrow.
2. Render one real, full-width `48px` macOS Desktop Chrome row before the application body. Keep one
   `32x32` Sidebar toggle at `x=84px` and `y=8px`, after the `76px` traffic-light exclusion.
3. Mount the active surface Header into the Desktop Chrome title slot. The Sidebar, compact rail,
   workspace body and inspector all begin below the row; macOS must never render an inline duplicate.
4. Keep the Web and Windows toggle and Header inside their existing page layouts. Suppress those copies only when macOS Desktop
   Chrome owns the control.
5. Keep Settings below the shared row, show the active Settings section title in that row, and let Back to
   app fill its normal content box without a separate traffic-light offset.

## Non-goals

- Do not hide the compact rail.
- Do not add Back, Forward, history, or decorative titlebar actions.
- Do not keep the rejected absolute overlay, transparent sibling drag zones, or per-page titlebar offsets.
- Do not change onboarding state, Settings information architecture, backend APIs, permissions, or copy.
- Do not push, create a PR, or publish a release in this slice.

## Acceptance

- Chinese and long-locale step labels remain readable and do not create horizontal overflow.
- The titlebar is one `48px` layout row spanning the viewport; no body content renders behind it.
- The macOS Sidebar toggle keeps identical geometry and behavior before and after collapse, with no duplicate.
- Home, channel, normal conversation and private chat render at most one Header, in the shared row.
- Back to app fills the Settings navigation content width below the shared row.
- Web and Windows retain their existing Sidebar behavior.
- Real packaged macOS screenshots cover First Run, expanded Sidebar, collapsed Sidebar, and Settings in Light
  and Dark themes, with console/page errors checked and language parity bound to the final source commit.
