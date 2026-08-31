# Cross-platform Codex-aligned Titlebar, First Run, And Settings Layout

Status: implemented; the current shell contract lives in
[Codex Window Shell Parity](codex-window-shell-parity.md)

## Intent

Repair three layout ownership failures without changing product behavior:

- First Run connectors must yield space to readable step labels.
- macOS Sidebar toggle ownership must stay in Desktop Chrome across expanded and collapsed states.
- Settings traffic-light clearance must belong to the navigation container, not the Back button width.

## Implementation

1. Keep step icons and labels at content width, give connectors the flexible remainder, and use a compact
   vertical list only when the dialog is genuinely too narrow.
2. Render one real, full-width `48px` Desktop Chrome row before the application body on macOS, Windows
   and Web Desktop. Keep one
   `32x32` Sidebar toggle at `x=84px` and `y=8px`, after the `76px` traffic-light exclusion. Set the
   native traffic-light origin to `x=12px`, `y=17px`, so its `24px` visual center aligns with the
   Sidebar toggle, active title and all titlebar actions.
3. Mount the active surface Header into the Desktop Chrome title slot. The Sidebar,
   workspace body and inspector all begin below the row; macOS must never render an inline duplicate.
4. Use the same title slot on Web and Windows. Windows owns real frameless minimize, maximize/restore and
   close controls; Web renders no operating-system controls.
5. Keep Settings below the shared row, show the active Settings section title in that row, and let Back to
   app fill its normal content box without a separate traffic-light offset.
6. Keep the renderer bootstrap text-free and suppress the macOS BrowserWindow title before loading the
   shared Web document. Ignore later page-title updates on macOS so Sidebar layout transitions cannot reveal
   a native duplicate; keep the normal `Ling Stack` document title for Web and Windows.

7. Use a `292px` expanded Sidebar and atomically replace it with a dedicated `48px` compact rail when
   collapsed. Expanded labels, object rows and section menus leave layout, accessibility and hit testing;
   the compact rail keeps only icon-first shortcuts backed by existing Ling actions.
8. Align built-in Light/Dark surfaces with the approved Codex reference palette while preserving imported
   Theme Pack authority.

## Non-goals

- Do not compress the expanded Sidebar into a narrow text column or leave an empty collapsed margin.
- Do not add Back, Forward, history, or decorative titlebar actions.
- Do not keep the rejected absolute overlay, transparent sibling drag zones, or per-page titlebar offsets.
- Do not change onboarding state, Settings information architecture, backend APIs, permissions, or copy.
- Do not push, create a PR, or publish a release in this slice.

## Acceptance

- Chinese and long-locale step labels remain readable and do not create horizontal overflow.
- The titlebar is one `48px` layout row spanning the viewport; no body content renders behind it.
- Native traffic lights, the Sidebar toggle, active title and right-side actions share the same
  `y=24px` visual centerline; no control group may use the default `hiddenInset` vertical position.
- The macOS Sidebar toggle keeps identical geometry and behavior before and after collapse, with no duplicate.
- Home, channel, normal conversation and private chat render at most one Header, in the shared row.
- Delayed localization startup and repeated Sidebar expand/collapse frame capture show no visible product-name
  flash below the native controls or inside the titlebar.
- Back to app fills the Settings navigation content width below the shared row.
- Web and Windows use the same `292px -> 48px` Sidebar states and shared Header ownership.
- Real packaged macOS screenshots cover First Run, expanded Sidebar, collapsed Sidebar, and Settings in Light
  and Dark themes, with console/page errors checked and language parity bound to the final source commit.
