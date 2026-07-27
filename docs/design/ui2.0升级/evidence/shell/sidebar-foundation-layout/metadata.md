# Sidebar Foundation / Layout Evidence

## Scope

- Slice: `T13-O.17 Sidebar Foundation / Layout focused owner`.
- Reachable production surface: expanded AppShell Sidebar, primary navigation, sections, object rows, long lists,
  branch creation/list and the fixed Settings footer.
- Frozen compatibility surfaces: compact rail motion/responsive behavior, `app/sidebar-ui2.css`, AppShell and
  navigation TSX, business callbacks and all non-Sidebar modules.

## Migration Result

- New owner: `apps/web/src/styles/app/sidebar-layout.css`, 737 lines; target `620-740`, hard maximum `800`.
- `components.css`: `4,867 -> 4,384`; old expanded drawer and branch family removed.
- `sidebar.css`: `1,816 -> 1,148`; expanded foundation moved out while rail, motion and responsive rules remain.
- `layout.css`: `1,321 -> 1,063`; Sidebar-only structural fallback removed.
- `navigation.css`: `82 -> 4`; retained only the live generic `nav` grammar.
- Web CSS: `154 files / 37,547 lines`, down 749 lines from the O.16 closeout.
- Confirmed dead families are zero in the migrated source set: legacy brand button/copy, hidden Sidebar toolbar,
  inbox alert, drawer-scoped hash/status/mention, direct selected row and non-drawer config family.
- The focused owner contains no color literal, Theme/Profile selector, `!important`, `transition: all`, numeric
  z-index, private keyframe or package-private `.ling-ui-*` selector.

## Screenshot Evidence

| File | Theme / viewport | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-expanded-long-row.png` | `ling-light`, 1440x960 | Expanded dense Sidebar, long row, status and actions | `dc3be3b70c7eadc2685fee2e4cf9f6e9185ad1a440148842d79a37bb57eec44a` |
| `1440x960-ling-light-expanded-scroll-bottom.png` | `ling-light`, 1440x960 | Internal scroll at the end while Settings remains fixed | `5315b744879d05c5b7c6e6f62ed791685b076fb5e37d72b8ea9f9eaf3e27b6ff` |
| `1280x800-ling-dark-branch-draft-focus.png` | `ling-dark`, 1280x800 | Branch draft focused and contained beside its submit action | `eca2f379badc6810c9fe624e1a32c217811f82a9f38d2cf4c55505713390a74a` |
| `1280x800-ling-dark-branch-draft-closed.png` | `ling-dark`, 1280x800 | Branch draft closed with Escape | `e47bc37e06427bb3893d90099ff9a1266fb1cab6fa2df29510dc83adfb2fc964` |
| `1280x800-ling-dark-channel-section-menu.png` | `ling-dark`, 1280x800 | Channel section menu anchored inside the Sidebar edge | `a2f170406725a2833d96daed1871e2623f503a595ba7489d617e9263b12e16f5` |
| `1280x800-ling-light-compact-rail.png` | `ling-light`, 1280x800 | Existing 48px compact rail regression | `860200c5fcbcdf10b8b44678053c7b890daab9f8ee6a19353e4780f4bb7e74e0` |
| `1280x800-ling-light-reexpanded.png` | `ling-light`, 1280x800 | Compact rail restored to the 240px foundation | `3657acfa3d31c362d800ac5eaa9dd541fdd7eb43b3d60a9b070f7876967e9860` |
| `900x800-ling-dark-compact-boundary.png` | `ling-dark`, 900x800 | Responsive boundary keeps the compact rail | `ced69d7fd142fe0128fa8c91556d866ef8e75ba2e96c8a9bcb9e9bf817e8deb2` |
| `901x800-ling-dark-expanded-boundary.png` | `ling-dark`, 901x800 | Desktop boundary uses the expanded foundation | `f8a76e920a8f8191e9fc820f1a9adeb60c53eb553d49804fcf24a1b48b5b0c68` |
| `901x800-ling-dark-reexpanded-boundary.png` | `ling-dark`, 901x800 | Boundary round trip returns to 240px without overflow | `285daa3564768ab44e7f149cb7d2bed17b25d03f988830e993fc90444a7e6b83` |

All captures retain their original viewport dimensions. The six representative states were visually inspected for
text/action overlap, input containment, menu placement, rail identity and document overflow.

## Automated Verification

- `ui2-sidebar-foundation-layout.spec.ts`: `4/4`.
- Existing Sidebar controls/list/object/sections: `8/8`; combined focused run: `12/12`.
- App, Channel, Teammates, Channel Archive and Dark regression: `149/149`.
- Web `typecheck`, UI 2.0 `lint`, `check:i18n`, production `build` and `git diff --check`: pass.
- Browser gates: one bounded `.sidebar-scroll-region`, 240px expanded / 48px compact geometry, 900/901px
  boundary, branch focus containment, menu keyboard/Escape, reduced motion, console/pageerror and document
  horizontal overflow pass.

## Honest Boundaries

- Compact rail selector consolidation remains a separate O.18 candidate; O.17 verifies its behavior but does not
  claim ownership of its motion, stack preview or responsive duplication.
- The bare `nav` selector remains in `navigation.css` because other semantic navigation surfaces may consume it.
- No route, `ViewId`, API, contract, database, permission, callback or business state changed.
- Packaged Desktop, Windows DPI/native chrome and platform-specific surface validation are unchanged.
- The production build retains the pre-existing large-chunk warning.
