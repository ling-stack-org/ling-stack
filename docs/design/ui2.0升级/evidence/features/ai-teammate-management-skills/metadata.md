# P8.1e AI Teammate Management Skills Evidence

## Scope

- Captured: 2026-07-21, Asia/Shanghai.
- Branch / HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b8050`.
- Working tree: mixed Desktop/Computer Use and UI 2.0 changes; no reset, clean, stash, commit, push, rebase or merge.
- Surface: real Vite application with Playwright daemon fixtures, not a static component screenshot.
- Function ID: `TEAMMATE-SKILLS-001`.
- Acceptance target: desktop Web at `1440x960` and `1280x800`; mobile is not included.

## Product Boundary

The Skills Tab manages the current teammate's bindings to the existing Skill Registry. It reuses the existing
Registry list/source-health, teammate binding replacement, import-draft/publish and archive APIs. It does not create
a second Skill Library, change Skill parsing, grant tools or permissions, edit approval policy, add routes or alter
runtime execution. Removing a binding only unlinks the current teammate; archiving a custom Registry Skill remains
a distinct confirmed global action. Ling Agent remains protected in both navigation and the existing Core write path.

## Screenshot Matrix

| File | Viewport / Theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-loaded-search.png` | 1440x960 / `ling-light` | compact summary, search, filter, one DataRow and advanced binding folded | `994804c869738504fca0fdb03088f53a963b5f4309a7b4f15481668801b40636` |
| `1440x960-ling-light-skill-detail.png` | 1440x960 / `ling-light` | shared Drawer, requirements, action and explicitly opened raw/source Inspector | `b9722f2d0034e9d28d267e476dd65ed33d40c3d93f73bb316f8100e45aeeff0a` |
| `1280x800-ling-dark-blocked-source-warning.png` | 1280x800 / `ling-dark`, reduced motion | executable, disabled, blocked, missing-definition and source-warning rows | `497d2b618ae2596d27900420697eba98ed834dab58f12dff3a1b025762095c57` |
| `1280x800-ling-dark-import-error.png` | 1280x800 / `ling-dark` | guarded Import Dialog, duplicate blocking issue and disabled Publish | `6ed8d02232fc8403f16f1944cb311f5b0b90da3ca7652340481e3fc0ab1888b1` |
| `1440x960-ling-dark-archive-confirm.png` | 1440x960 / `ling-dark` | unlink success Toast plus separate Registry archive confirmation | `ae8c227bdb1be33900d356eb04a81eade823675e171e80f37a06b4cc4c11175b` |

All five PNG files were inspected at original resolution. The Settings header, navigation, bounded Skills list,
right configuration summary, Drawer, Dialog and global Toast remain separated. Search/Input focus, long row identity,
status/actions, fixed Dialog footer and 1280-wide three-column shell do not overlap or create document overflow.
Every focused scenario asserts an empty browser error console and document `scrollWidth/scrollHeight` containment.

## Reachable State Evidence

- initial loading: the existing stable teammate workspace loading state remains visible; no false empty surface.
- empty Registry: current product fallback to built-in Skill Packs remains truthful and does not render a false
  `No skills available` state.
- load failure: the authoritative workspace error owns the failure and the loading state settles.
- loaded/search/filter: compact Bound/Executable/Needs attention summary, technical-value discovery without raw value
  leakage, all five exact filters and a clear no-result action.
- bindable/executable/disabled/blocked/missing definition/source warning: one deterministic primary state and one
  truthful Bind/Enable/Disable action per row.
- advanced binding: empty, duplicate, normalized known id, unknown id failure and historical missing binding repair.
- details: row Enter/Space and icon open one Drawer; raw source data stays folded by default; Escape restores focus.
- import: stale preview invalidation, blocking error, publishable warning, busy dismissal guard, success refresh/Toast,
  preview failure and publish failure with source preserved.
- unlink/archive: teammate unlink and Registry archive remain distinct; archive requires confirmation and failure keeps
  the row and Registry state.
- teammate switch: a delayed mutation may finish for its original teammate but cannot overwrite the new teammate UI,
  leak a success Toast or create a target binding.
- protected Ling Agent: no Skills Tab is reachable, and a direct write attempt is rejected without mutation.
- zh-CN, long content, Light/Dark and reduced motion remain contained at the two desktop baselines.

## Verification

- `corepack pnpm --filter @ling-stack/ui-react test`: `50/50`.
- `corepack pnpm --filter @ling-stack/conversation-ui-react test`: `10/10`.
- `ui2-teammate-management-skills.spec.ts`: `13/13`, including final evidence capture.
- `teammates.spec.ts` + focused Profile/Model + Settings + Dark regression: `52/52`.
- Web `typecheck`, `check:i18n`, `lint` and `git diff --check`: passed.
- UI 2.0 import boundary: direct Feature package/Radix imports `0`; overlay root remains one provider and one Toast
  viewport.
- Focused Skills CSS forbidden color literal, `!important`, Theme/Profile selector, `transition: all`, private keyframe
  and package-private `.ling-ui-*` selector hits: zero.

## Structure And Residual Risk

- `TeammateWorkspace.tsx`: `2,348 -> 2,098`; Skills API/UI state, mutations and overlays moved out.
- Focused owners: controller 399 lines, controller types 65, pure view-models 226, Tab 354, Import Dialog 161,
  Inspector Drawer 198 and Skills CSS 390.
- `teammates.css`: `2,628 -> 2,105`; migrated Skills selectors were removed. The role-template preview now uses its
  own `teammate-role-skill-*` family in the focused role-catalog owner instead of borrowing management selectors.
- `TeammateWorkspace.tsx` remains above the 1,200-line architecture-debt threshold. MCP, Memory and remaining Tabs
  must continue extracting focused controllers/components before adding major behavior.
- `TEAMMATE-MCP-001` remains a separate decision-gated slice. Theme Studio D3 and
  `DESKTOP-THEME-PACK-PERSISTENCE-001` remain unrelated open work and are not claimed here.

## 2026-07-31 Replacement Evidence

The capture and verification record above remains historical evidence for the former Registry-heavy Skills Tab. It no
longer describes the reachable default layer. The current section manages only whether the selected teammate uses a
Skill. Import, manual Skill ID binding and Registry archive returned to the Skill Library owner.

The current list contains `Skill / Description / Use`, searches only user-visible names, descriptions and tool labels,
and opens details from the row. Healthy Skills have no status label. Missing, blocked or source-invalid entries alone
show `Needs attention`. Unlink remains available in the detail Drawer; source identifiers, checksum and path stay in
folded technical information. The list uses natural height and a shared overlay scrollbar only after content exceeds
the remaining Settings viewport. The list, rather than the outer Settings content, owns long-content scrolling.

| File | Viewport / Theme | Current state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-binding-list-and-detail.png` | 1440x960 / `ling-light`, en-US | compact binding list, immediate use Switch and row-owned detail Drawer | `8ab35240c5684138be75cc83191815d2678263d4f55e3685a922b0a405d0498c` |
| `1280x800-ling-dark-attention-detail.png` | 1280x800 / `ling-dark`, en-US | exceptional Skill state and user-facing blocker detail | `7d9aa1173bc882caa031007441cfeacb0d9e509693e02496c5d2d6fc8cee9cbc` |
| `1280x800-ling-dark-overlay-scroll-zh-CN.png` | 1280x800 / `ling-dark`, zh-CN | natural-height list capped by the remaining viewport and internally scrolled without outer-page overflow | `957274d9d57c3c92b55ddd96244a430be0ac93165708650bd0e49e8482eb1395` |

All current PNGs were reviewed at original resolution. The complete teammate-management matrix passed `48/48`, and
Web typecheck, lint, i18n and unit tests passed. Skill Registry ownership, binding replacement and runtime selection
semantics did not change.
