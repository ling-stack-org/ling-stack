# P8.1c AI Teammate Management Profile Evidence

## Scope And Result

- Function ID: `TEAMMATE-PROFILE-001`
- Status: `verified` on 2026-07-21 for the reachable single-teammate Settings shell, Profile/Avatar and
  persona progressive-disclosure surface.
- Branch / HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b8050`.
- Working tree: mixed Desktop/Computer Use and UI 2.0 changes; no reset, clean, stash, switch, commit, push,
  rebase or merge was performed.
- Served artifact: Playwright-owned real Vite dev server at `http://127.0.0.1:4174`, not static source,
  built `dist` or a code-only assertion.
- Browser: Playwright Chromium; locales `en-US` and `zh-CN`.

The slice covers standard and protected Profile fields, dirty/reset/save, action-scoped busy state, expiring
global success Toast, persistent local failure, valid/invalid avatar selection, shared crop drag/zoom/Esc/focus,
upload/remove and their failures, folded persona, keyboard disclosure, preview warning, apply preservation,
long content, reduced motion and both target viewports/themes. Existing APIs, protected-field policy and
persona authority boundaries are unchanged.

## Screenshots

| File | Viewport / Theme Pack | Changed state | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-standard-profile.png` | 1440x960 / `ling-light` | standard identity/lifecycle/description, one Header action owner and folded advanced area | `303217c2db4bb2042448dda57b907e7c1c439d1fdea00d57301e5a7149d87092` |
| `1280x800-ling-dark-protected-profile.png` | 1280x800 / `ling-dark`, `zh-CN` | protected Ling Agent fields, long identity and concise protected state | `e7a4de1e971e080cf4d1c72eee9381e2c30fe566559f214fd3677f0c69e345a3` |
| `1440x960-ling-dark-avatar-crop.png` | 1440x960 / `ling-dark` | shared crop Dialog using the real engineer avatar, zoom and dragged crop | `aa22badc18e47a315163d2ba0ccd203c1265df2f4d77b559eceaf141037912a6` |
| `1280x800-ling-light-persona-draft.png` | 1280x800 / `ling-light`, reduced motion | expanded persona draft, source, full summary and authority warning in internal scroll | `b4bc1c5d25b1bc32c51d114a2f87a3b8a1487a08e11e2bfb9c4279cffff86312` |
| `1280x800-ling-dark-save-failure.png` | 1280x800 / `ling-dark` | retained long draft and Profile-owned persistent save failure | `22be99bfbe9e7ddaad9becacd37f9d5f6198b554ae8dba521511e21928ff8d8d` |

All five files were verified at their original pixel dimensions and inspected after the final DataRow/scroll
adjustment. Summary values remain readable, persona draft/warning are fully framed, crop content is visible,
Header/navigation/content/summary columns do not overlap, and document horizontal/vertical overflow is zero.

## Verification

- `@ling-stack/ui-react`: `50/50` passed; compact `StatusIndicator` now keeps its hidden accessible label inside
  a relative owner and has a package CSS regression assertion.
- focused `ui2-teammate-management-profile.spec.ts`: `6/6` passed, including evidence capture.
- existing `teammates.spec.ts`: `21/21` passed.
- selected user Profile / Settings workspace tools / Dark regression: `16/16`; selected command plus focused
  owner: `22/22` passed.
- Web typecheck, i18n audit, lint/import/overlay guards and `git diff --check`: passed.
- focused CSS scan: zero color literals, `!important`, Theme/Profile selectors, `transition: all`, private
  keyframes and package-private `.ling-ui-*` selectors.
- migrated Profile/avatar/settings selectors outside focused owners: zero.
- runtime console/page errors and document horizontal/vertical overflow: zero in all focused cases.

## Ownership Boundary

- `TeammateWorkspace.tsx`: `2,489 -> 2,362` lines; Profile/avatar/persona state moved to a 314-line controller.
- Profile display owners: Profile tab 278, Settings Header 52, Navigation 42 and Summary 53 lines.
- shared crop implementation: 331 lines under `shared/ui`; the user Profile path is a compatibility re-export.
- `teammates.css`: `2,864 -> 2,648`; `strict-console.css`: `1,187 -> 1,186`.
- focused Settings shell/Profile CSS owners: 257 and 182 lines.

The 2,362-line `TeammateWorkspace.tsx` remains architecture debt and must continue shrinking; P8.1d Model is
the next independent slice and must extract before adding major behavior. Skills/MCP, Memory and remaining Tabs
are not claimed. D1=A/D2=A remain fixed and `DESKTOP-THEME-PACK-PERSISTENCE-001` remains an explicit TODO.
