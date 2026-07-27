# P7C.1 Web Theme Pack Management Evidence

Captured and verified on 2026-07-20 from the real Playwright-managed Vite server at
`http://127.0.0.1:4174/`.

## Source And Scope

- Branch: `codex/ui2-desktop-coverage-foundation`
- Base HEAD: `0a0b80502715d0333342422e6dc8cedd2cd77b14`
- Focused owner: `apps/web/e2e/ui2-settings-theme-packages.spec.ts`
- Web implementation owners: `InterfaceThemeSettings.tsx`, `theme-packages/*`,
  `shared/ui/theme/package/*`, `theme.tsx` and `settings-theme-packages.css`
- Shared owners: `@ling-stack/ui-react` package-index validation, `ThemePicker` action slot and
  `ThemePreviewFixture`
- Browser: Playwright Chromium, one isolated context per test
- Persistence under test: Web IndexedDB `ling-stack-ui2` version 2
- Mobile is not an acceptance target.

The selected safety policy is D1=A: imported packages may contain validated semantic tokens,
`LICENSE.txt` and one isolated PNG/JPEG/WebP preview. Runtime artwork, arbitrary CSS/JS/HTML/SVG,
fonts, remote URLs, feature selectors and Logo replacement are rejected.

The selected persistence scope is D2=A: this evidence verifies Web IndexedDB only. It does not
claim native Desktop Theme Pack persistence. `appData/themes/<themeId>/`, staging plus atomic rename,
typed preload IPC, packaged restart restoration and macOS/Windows evidence remain an explicit
`DESKTOP-THEME-PACK-PERSISTENCE-001` follow-up.

## Screenshot Matrix

| File | Viewport | Theme / locale | Reachable state | SHA-256 |
|---|---|---|---|---|
| `1440x960-ling-light-import-review.png` | 1440x960 | `ling-light`, en-US | valid package review before publication | `1d2a11617b62db81d5140f7d8b7ae19b89e759ba1003f2de614b024a8c0e42a7` |
| `1280x800-ling-light-preview-dialog.png` | 1280x800 | document `ling-light`, en-US | isolated candidate preview without root-theme mutation | `55078640d5cf40096fc7b7eab820577902853219f9936030237bc3f582e747a9` |
| `1440x960-quiet-ocean-installed-menu.png` | 1440x960 | `quiet-ocean`, en-US | installed local option with Preview, Reimport and Delete | `c0023e090945b3ea421b9a873cd257362473699358b0ba903be49e2e0c892114` |
| `1280x800-quiet-ocean-reimport-review.png` | 1280x800 | `quiet-ocean`, en-US | same-ID replacement review before atomic reimport | `55138eb941bd0cc0a45f6aa6281a5bf709eb321b8c67189f75c5ecf9f5ceb40f` |
| `1440x960-quiet-ocean-delete-confirm.png` | 1440x960 | `quiet-ocean-refined`, en-US | active-theme permanent delete and built-in fallback disclosure | `c157b4ce2de1a60db2784ca2e083db022c51d34edd35fcabf8e1695dbd4a33c1` |
| `1280x800-ling-dark-artwork-blocked.png` | 1280x800 | `ling-dark`, zh-CN | runtime artwork blocked without changing the active theme | `a9d373c94df1de0b7228a4b8d2e3fd9a0f36641660bb5154b3402045dd55ba21` |

All PNG files were inspected at original resolution. Dialogs, menus, ThemeOptions, long copy and
actions remain within the Settings owner. The final changed states produced no browser console or
page errors and no document-level horizontal overflow. The delete screenshot was recaptured after
the reimport success Toast expired, so it contains only the target confirmation state.

## Interaction And Safety Evidence

- A candidate is inspected before Registry, selection or storage changes.
- Preview tokens are scoped to `ThemePreviewFixture`; opening Preview does not change the document
  `data-ui-theme`.
- Successful import can apply the theme and survives a hard refresh from IndexedDB.
- Same-ID reimport replaces manifest, metadata and preview atomically; a storage failure restores the
  previous Registry, stored package and visible theme.
- Duplicate import and different-ID reimport are blocked without overwriting the installed package.
- Active-theme delete applies the matching built-in fallback first; failed deletion keeps the package.
- IndexedDB version 1 manifests survive the version 2 upgrade that adds `theme-packages` and
  `theme-assets` with a `themeId` index.
- Archive validation rejects traversal, case-folded duplicates, special entries, unsupported files,
  budget overflow, unsafe runtime artwork and invalid package identity before publication.
- Runtime preview bytes are MIME-sniffed, decoded for dimensions, checked by CRC32 and SHA-256, and
  exposed only through a revocable object URL.
- Import, Preview and Delete use shared Dialog/Menu/Toast/InlineFeedback owners; no feature Toast
  viewport, timer, browser alert or nested action inside the ThemeOption radio was added.

## Verification

```text
@ling-stack/ui-react test                                      45/45
ui2-settings-theme-packages.spec.ts                              5/5
Theme/Interface/Presentation focused regression                11/11
Settings/App/Dark/Desktop/Theme selected regression            83/83
Web typecheck                                                  passed
Web check:i18n                                                 passed
Web lint                                                       passed
git diff --check                                               passed
```

Final evidence recapture: `5/5` passed in 19.2 seconds.

## Status Decision

- `UI-THEME-PICKER-001`: `verified` for the current Web selection and package-action surface.
- `UI-THEME-IMPORT-001`: `verified` for token plus isolated-preview Web packages.
- `SETTINGS-INTERFACE-THEME-IMPORT-001`: `verified` for Web import, preview, reimport and delete.
- Runtime imported artwork remains `inventory` under the later artwork-verification slice.
- `DESKTOP-THEME-PACK-PERSISTENCE-001`: `inventory / explicit follow-up`; no native-complete claim.
- `SETTINGS-INTERFACE-THEME-CREATE-001`: remains `designed`; P7C.2 Quick Theme Studio is next.

P7C.1 is closed only for the currently reachable Web surface. Desktop native persistence remains on
the UI 2.0 work board until packaged macOS and Windows restart evidence exists.
