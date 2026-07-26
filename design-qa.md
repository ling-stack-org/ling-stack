# macOS Private Chat Titlebar Design QA

## Comparison Target

- Source visual truth: `/var/folders/wv/szx379kx7r135_kzktxrrs680000gn/T/codex-clipboard-b71e6037-3066-4871-9b46-69d34f9e62de.png`
- Implementation screenshot: `/Users/tianxiao/ling-stack-macos-titlebar-density-fix/apps/web/test-results/macos-titlebar-macOS-deskt-73ae6-r-and-uses-one-dock-divider-chromium/macos-titlebar.png`
- Viewport: `1440 x 919` CSS pixels.
- Source: `2880 x 1838` pixels at macOS `2x`; normalized comparison size `1440 x 919`.
- Implementation: `1440 x 919` pixels at browser `1x`.
- State: Chinese locale, Ling Agent private chat selected, empty message feed, workspace tools dock fully expanded, light theme.
- Native chrome note: the source includes macOS traffic lights; the browser implementation capture excludes native window chrome. Native chrome was excluded from the content-layout comparison.

## Findings

- No actionable P0, P1, or P2 visual differences remain in the user-marked regions.
- Fonts and typography: unchanged from the shared Web implementation; hierarchy, weight, truncation, and small-label sizing remain consistent.
- Spacing and layout rhythm: the unintended `20px` outer workspace gutter is removed. The private-chat header now begins at the workspace top-left, while its intentional `18px` internal content inset remains.
- Colors and tokens: backgrounds, borders, muted text, selection fill, and drawer row separators continue to use the existing shared tokens.
- Image and asset quality: no image assets were added or replaced. Existing avatar fallback behavior remains unchanged.
- Copy and content: Chinese labels and the empty-state/drawer content match the selected product state.
- Drawer affordance: the resize handle remains an `8px` hit target with one centered `1px` visible divider; the drawer no longer paints a second left border.

## Full-view Evidence

- Before: the source shows a visible top and left gutter around the private-chat surface and two adjacent vertical lines at the workspace dock boundary.
- After: the implementation screenshot shows the header flush with the workspace origin and one divider between conversation content and the dock.

## Focused-region Evidence

- The header origin and dock boundary were inspected at original resolution in the paired comparison. Both target defects occupy clear, high-contrast regions in the full-height capture, so an additional crop was not needed.
- Computed geometry confirms `padding-top: 0px`, `padding-left: 0px`, header top `0`, header left inset `0`, resize line width `1px`, and dock left border width `0px`.

## Comparison History

1. Initial finding: P1 outer workspace gutter added `20px` above and left of the private-chat surface. P2 duplicate divider came from the resize-handle pseudo-element plus the drawer's own left border.
2. Fix: excluded `.workspace-teammate-private-surface` from the generic padded workspace selector and suppressed the drawer border inside `.workspace-right-dock-frame` while retaining the resize-handle line.
3. Post-fix evidence: the `1440 x 919` Chinese empty-state capture and the focused layout regression test both pass.

## Interaction And Runtime Checks

- Opened Ling Agent from the sidebar.
- Opened and fully expanded the workspace tools dock.
- Verified the empty conversation surface, composer, toolbar, and dock remain visible.
- No application page errors or application console errors were observed. Expected missing mock image requests exercised the existing asset fallback and were excluded from the application-error assertion.

## Implementation Checklist

- [x] Remove the private-chat outer gutter.
- [x] Preserve the Web header's native height and internal spacing.
- [x] Keep the drawer resize interaction with one visible divider.
- [x] Add a macOS layout regression test.
- [x] Capture and compare the target state at the normalized viewport.

## Open Questions

- None.

final result: passed
