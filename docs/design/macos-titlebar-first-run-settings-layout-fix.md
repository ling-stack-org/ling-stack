# macOS Titlebar, First Run, And Settings Layout Fix

Status: approved for local implementation and packaged macOS acceptance

## Intent

Repair three layout ownership failures without changing product behavior:

- First Run connectors must yield space to readable step labels.
- macOS Sidebar toggle ownership must stay in Desktop Chrome across expanded and collapsed states.
- Settings traffic-light clearance must belong to the navigation container, not the Back button width.

## Implementation

1. Keep step icons and labels at content width, give connectors the flexible remainder, and use a compact
   vertical list only when the dialog is genuinely too narrow.
2. Render one `32x32` macOS Sidebar toggle in a Desktop Chrome toolbar at `76px + 8px`; reserve another
   `8px` before draggable content. Keep the `48px` compact rail, with New conversation as its first action.
3. Keep the Web and Windows toggle inside Sidebar navigation. Suppress that copy only when macOS Desktop
   Chrome owns the control.
4. Apply macOS Settings top clearance to the navigation container and let Back to app fill its normal
   content box.

## Non-goals

- Do not hide the compact rail.
- Do not add Back, Forward, history, or decorative titlebar actions.
- Do not change onboarding state, Settings information architecture, backend APIs, permissions, or copy.
- Do not push, create a PR, or publish a release in this slice.

## Acceptance

- Chinese and long-locale step labels remain readable and do not create horizontal overflow.
- The macOS Sidebar toggle keeps identical geometry and behavior before and after collapse, with no duplicate.
- Back to app fills the Settings navigation content width and remains below the traffic lights.
- Web and Windows retain their existing Sidebar behavior.
- Real packaged macOS screenshots cover First Run, expanded Sidebar, collapsed Sidebar, and Settings in Light
  and Dark themes, with console/page errors checked and language parity bound to the final source commit.
