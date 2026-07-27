# P7C.1 Theme Pack Management Implementation Plan

Status: Web `verified` on 2026-07-20. D1 and D2 were explicitly confirmed as option A on 2026-07-21.
Desktop native Theme Pack persistence remains an explicit required follow-up and is not included in this closeout.

This is the focused execution plan for `SETTINGS-INTERFACE-THEME-IMPORT-001` and
`UI-THEME-IMPORT-001`. It extends the already verified ThemePicker selection surface; it does not
reopen P7A.4 or redefine ThemeRegistry, System mapping, Theme Compiler, Theme Studio, Logo, Settings
IA, workspace state, or backend APIs.

## 1. Objective

Settings > Interface Preferences must support the complete local Theme Pack lifecycle:

```text
Select .ling-theme
  -> inspect and validate without changing the active theme
  -> preview a normalized package
  -> import atomically
  -> optionally apply after import
  -> preview / reimport / delete an installed local theme
  -> recover to the previous authoritative state after every failure
```

The surface remains quiet and compact. Theme selection is the primary task; package management is
secondary. Built-in themes never expose reimport or delete.

## 2. Source Of Truth

- [Interface Preferences](03-Interface-Preferences.md)
- [ThemePicker 与主题预览](../../components/12-ThemePicker与主题预览.md)
- [主题资源导入与安全](../../themes/05-主题资源导入与安全.md)
- [主题包 Schema 与 Token 合同](../../themes/02-主题包Schema与Token合同.md)
- [主题注册表与运行时切换](../../architecture/07-主题注册表与运行时切换.md)
- [Desktop 多窗口与主题同步](../../architecture/09-Desktop多窗口渲染器与主题同步.md)
- [UI 2.0 后续升级执行方案](../../04-UI2.0后续升级执行方案.md)

If these documents conflict, security and non-executable Theme Pack rules win. Existing verified
selection/apply/rollback behavior is preserved unless this plan explicitly extends it.

## 3. Entry-Audit Baseline

This section records the state before P7C.1 implementation. The final implementation and status are
recorded in section 14.

Already implemented before P7C.1:

- `ThemeRegistry`, strict manifest/token/contrast validation, independent `ling-light` and
  `ling-dark`, fixed/System selection, first-paint bootstrap and atomic DOM apply/rollback.
- Web IndexedDB persistence for local manifests and local theme restoration on startup.
- `ThemeProvider.installTheme(manifest)` and `removeTheme(themeId)` at manifest level.
- Shared `ThemePicker` with token swatch, selected/active/applying/disabled states, keyboard
  behavior, long-name coverage and reduced-motion CSS.
- Revisioned Web -> Desktop/PiP token snapshot reporting.

Missing before P7C.1:

- `.ling-theme` ZIP reader or normalized package model.
- Archive path, file count, compressed/uncompressed size, MIME, image dimensions, symlink and
  checksum enforcement.
- IndexedDB storage for package assets, license text and package metadata.
- Import, reimport, preview and delete management UI.
- Per-option More action slot in ThemePicker.
- Isolated `ThemePreviewDialog`.
- Desktop app-data Theme Pack repository and typed preload IPC.
- Reliable readable-text, Logo/watermark and UI-chrome detection for imported runtime artwork.

The final Web adapter uses direct dependency `fflate@^0.8.2`. `jszip` was not promoted from a
transitive dependency because its browser timer types conflicted with the existing Web type surface.

## 4. Decision Gates

The selected D1 and D2 options are recorded here and in the temporary execution controller.

### D1: Imported Runtime Artwork Safety

The compiler requires truthful `readableText`, `logoOrWatermark` and `uiChrome` risk signals.
Browser-local decoding and palette analysis cannot reliably infer those signals.

| Option | P7C.1 behavior | Trade-off |
|---|---|---|
| A - token + preview only (recommended) | Accept manifest tokens, license and optional isolated preview image; reject runtime `artwork` slots until P7C.2/P2B artwork verification exists | Safest and fully local; first imported themes cannot change shell artwork |
| B - user attestation | Accept runtime artwork after technical validation and explicit confirmation that it contains no readable text, Logo/watermark or UI chrome | Faster rich themes, but safety depends on user declaration |
| C - mandatory vision review | Accept runtime artwork only after a configured vision-capable model returns structured risk signals and local verification passes | Stronger automation, but import depends on provider availability, cost and privacy consent |

Selected option: `A - token + preview only`.

P7C.1 rejects every manifest with runtime `artwork` entries. An optional validated `preview` asset
may appear only inside the isolated Theme preview and never becomes AppShell/Home artwork. Runtime
artwork safety and publication remain a later Theme Studio/presentation verification slice.

### D2: Desktop Persistence Scope

| Option | P7C.1 behavior | Trade-off |
|---|---|---|
| A - Web repository first (recommended) | Complete Web IndexedDB import lifecycle and existing renderer token sync; keep Desktop app-data persistence `inventory/pending` for a separate adapter slice | Avoids current Desktop/CUA overlap and permits focused verification now |
| B - Web + Desktop together | Add app-data `themes/<themeId>/`, staging/atomic rename, typed IPC and packaged restart evidence in P7C.1 | Delivers native persistence now but touches the current remote-overlap area and materially enlarges the slice |

Selected option: `A - Web repository first`.

Desktop app-data Theme Pack persistence is an explicit follow-up, not an optional aspiration. It
must add `appData/themes/<themeId>/`, staging + atomic rename, typed preload IPC, packaged restart
restoration and macOS/Windows evidence before Desktop theme import can be called complete.

These choices do not change the final UI 2.0 product contract. Runtime artwork and native storage
remain explicit follow-up work and must stay visible in the coverage/status matrices.

## 5. Product Contract

### 5.1 Interface Preferences Default Layer

```text
Appearance
  Follow system                                      Switch
  Current theme                                      Resolved theme name
  ThemePicker
    built-in options
    local options                                    More menu
  [Create theme] [Import theme]
```

- Existing ThemePicker geometry, radio behavior and atomic selection remain unchanged.
- `Import theme` is a secondary action. `Create theme` remains a P7C.2 route and must not be faked.
- Local ThemeOption More contains `Preview`, `Reimport` and `Delete` only.
- Built-in ThemeOptions may expose `Preview`; they never expose `Reimport` or `Delete`.
- Theme ID, schema, checksum, asset paths and parser diagnostics remain out of the default layer.

### 5.2 Import Dialog

The Dialog has four explicit phases and one owner:

1. `choose`: file picker accepts only `.ling-theme`.
2. `validating`: archive and package checks run with scoped busy state; Dialog cannot be dismissed
   through repeated primary actions.
3. `review`: show name, author, color scheme, token swatch, source/license summary, asset summary,
   warnings and an optional `Use after import` checkbox.
4. `publishing`: persist package atomically, register it, optionally apply it, then close on success.

Validation blockers remain inside the Dialog as `InlineFeedback`. Technical issue codes, normalized
paths, size totals and checksums belong in collapsed `InspectorSection` details. A Toast never
replaces a blocking import error.

### 5.3 Preview Dialog

- Preview uses a package-owned fixture for Button, Field, Menu, StatusIndicator, Toast and DataRow.
- It never mounts real workspace data and never changes the document root theme.
- Candidate tokens are scoped to the preview root through an allowlisted variable map.
- Preview artwork, if allowed by D1, is loaded from a validated object URL and revoked on close.
- Esc, backdrop, Close and focus return follow the shared Dialog contract.
- Opening Preview while import validation is active is disabled with a truthful reason.

### 5.4 Reimport

- Reimport is available only for `local-import` themes.
- The replacement archive must resolve to the same Theme ID. A different ID is a new import and is
  not silently substituted.
- Validation completes before any installed data changes.
- Publication replaces assets and manifest in one repository transaction; Registry refresh occurs
  only after the transaction succeeds.
- If the replaced theme is active, apply the validated replacement atomically. On apply failure,
  restore the previous package and previous resolved theme.
- A failed reimport leaves the original package selectable and active.

### 5.5 Delete

- Delete uses the shared destructive Dialog; no `window.confirm`.
- Built-in themes cannot be deleted through UI or adapter calls.
- Deleting a non-active local theme removes manifest, assets, license and metadata atomically.
- Deleting the active fixed theme first applies the matching built-in fallback, then deletes.
- If persistence deletion fails, keep the theme registered and show persistent error feedback.
- If the package disappears externally, Registry marks it unavailable and offers Reimport/Delete;
  it does not leave a broken image or silently remove user metadata.

## 6. Archive And Asset Validation

The parser must enforce the existing safety contract before publication:

| Budget | Limit |
|---|---:|
| archive file | 20 MB |
| total uncompressed content | 32 MB |
| files | 16 |
| `theme.json` | 1 MB |
| one image | 16 MB |
| decoded pixels | 32 MP |
| longest image edge | 8192 px |

Required rejection cases:

- extension is not `.ling-theme`, malformed ZIP, encrypted/password or unsupported archive;
- absolute path, `..`, empty/control-character path, duplicate normalized/case-folded path;
- symlink, hardlink/special Unix file type or unsupported entry metadata;
- files outside `theme.json`, optional `LICENSE.txt` and `assets/`;
- CSS, JavaScript, HTML, SVG, font, executable, WASM, remote URL or data URL;
- missing/multiple `theme.json`, unsupported schema, reserved `ling-*` ID, invalid source claim;
- declared MIME differs from decoded bytes, unsupported dimensions, checksum mismatch;
- manifest references an absent asset or an unreferenced executable/unknown file remains;
- artwork policy prohibited by the selected D1 option.

The parser must inspect `unsafeOriginalName`/raw archive names where the ZIP library normalizes
paths. Library sanitization is defense in depth, not evidence that the original entry was safe.

## 7. Data And Transaction Model

Use a normalized package boundary; do not pass a raw `File`, `JSZipObject` or absolute path into
ThemeRegistry.

```ts
interface ParsedThemePackage {
  manifest: LingThemePackManifest;
  packageChecksumSha256: string;
  assets: readonly ParsedThemeAsset[];
  licenseText?: string;
  warnings: readonly ThemePackageIssue[];
}

interface ParsedThemeAsset {
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteLength: number;
  width: number;
  height: number;
  checksumSha256: string;
  blob: Blob;
}
```

The package layer owns asset bytes and publication metadata. ThemeRegistry continues to own only
validated manifests, registration state and resolution.

### Web Repository

Upgrade `ling-stack-ui2` IndexedDB through one database owner. Target stores:

```text
themes                 manifest by themeId
theme-packages          checksum, license, timestamps and source by themeId
theme-assets            Blob + metadata by [themeId, path]
```

- Schema upgrade is versioned and preserves current manifest records.
- Install/reimport/delete use one `readwrite` transaction across all stores.
- Asset object URLs are created lazily, cached by package revision and revoked on revision/delete.
- localStorage continues to hold only selection and validated bootstrap snapshot, never image bytes.
- Quota, blocked upgrade and transaction abort errors are surfaced without mutating Registry.

### Desktop Repository

Desktop will own `appData/themes/<themeId>/`, random staging, permissions, atomic rename, cleanup and
typed IPC in the dedicated follow-up. Web/renderer sends normalized bytes and metadata, never
arbitrary destination paths. Because D2=A, none of these IPCs are added in P7C.1 and native
persistence remains explicitly unverified.

## 8. Module Boundaries

```text
packages/ui-react/src/theme/import/
  package-types.ts                 normalized metadata and issue types
  validate-package-index.ts        runtime-neutral allowlist/budget validation

packages/ui-react/src/theme-picker/
  ThemePicker.tsx                  selection plus non-nested action slot
  ThemePreviewFixture.tsx          isolated primitive preview

apps/web/src/shared/ui/theme/package/
  web-theme-package-parser.ts      File/Blob + ZIP adapter
  web-theme-package-repository.ts  IndexedDB transaction owner
  web-theme-asset-urls.ts          object URL lifecycle

apps/web/src/features/settings/theme-packages/
  ThemePackageActions.tsx
  ThemeImportDialog.tsx
  ThemePreviewDialog.tsx
  ThemeDeleteDialog.tsx
  useThemePackageController.ts
  theme-package-view-models.ts

apps/web/src/styles/
  settings-theme-packages.css
```

- `@ling-stack/ui-react` imports no Web i18n, IndexedDB, File System, API Client, Core or routes.
- ZIP/Blob mechanics stay in the Web adapter; Feature components receive translated view-models.
- `InterfaceThemeSettings.tsx` remains composition and event wiring, targeted below 250 lines.
- `theme.tsx` may expose atomic register/unregister/package refresh operations but must not parse ZIP,
  render Dialogs or own feature copy.
- ThemePicker actions must be siblings of the selection control; never nest Button/Menu triggers
  inside a radio/toggle item.
- New production owners target below 400 lines. Existing files over 800 lines receive no new major
  behavior.

## 9. State And Feedback Matrix

| State | Persistent UI | Ephemeral feedback |
|---|---|---|
| file chosen / validation running | Dialog progress + disabled primary action | none |
| invalid archive/manifest/asset | Dialog InlineFeedback + details | none |
| valid with warnings | review summary + warning details | none |
| import success | installed ThemeOption | success Toast |
| import storage failure | Dialog remains open with retry | optional error Toast, never sole owner |
| reimport running | only target ThemeOption/menu busy | none |
| reimport failure | original option remains + inline error | error Toast may summarize |
| delete confirm/running | destructive Dialog scoped busy | none |
| delete success | option removed, deterministic focus target | success Toast |
| active delete fallback failure | theme remains installed/active + persistent error | error Toast may summarize |
| package missing/corrupt after startup | disabled option + Reimport/Delete repair | one deduplicated warning Toast |
| storage unavailable | section InlineFeedback; selection of built-ins remains usable | no repeated Toast |

Success Toast uses the global provider and auto-dismisses. Validation, storage, corruption and
repair states remain visible until fixed or dismissed. No feature timer or local Toast viewport.

## 10. Implementation Order

1. Record D1/D2 and update the temporary controller, coverage matrix and status board.
2. Add normalized package types and pure archive-index validation with malicious fixtures.
3. Add the direct ZIP dependency and Web parser; decode MIME/dimensions and compute SHA-256.
4. Refactor the existing IndexedDB helper into one versioned repository and migrate version 1 data.
5. Add asset URL lifecycle and startup integrity projection without changing selection semantics.
6. Extend ThemeProvider with transaction-safe package registration/removal operations.
7. Extend shared ThemePicker with a sibling action slot and add package tests for keyboard/focus.
8. Build Import, Preview, Reimport and Delete components/controllers with shared primitives.
9. Add `settings-theme-packages.css`; remove only selectors now owned by this slice.
10. Add zh-CN/en-US copy, ARIA, menu labels, repair reasons and technical Details labels.
11. Add focused unit/E2E suites, then run existing Theme/Settings/Dark/Desktop regressions.
12. Capture real Vite evidence, inspect original pixels, write metadata/hashes and update every matrix.

If D2=B, insert Desktop repository/preload/IPC work between steps 6 and 7 and run native tests before
Web UI integration. Do not edit the current Desktop overlap until a fresh remote conflict audit is
recorded.

## 11. Test Plan

### Static And Package

```text
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
```

Package tests cover normalized paths, duplicate case-folded paths, file budgets, manifest reference
integrity, ThemePicker action semantics, preview variable scope and reduced motion.

### Focused Web E2E

Add `apps/web/e2e/ui2-settings-theme-packages.spec.ts` and cover:

1. valid token-only import, review, import without use and import-and-use;
2. wrong extension, corrupt ZIP, ZIP Slip, duplicate path, excessive size/count and blocked file type;
3. invalid schema/token/contrast, reserved ID, missing asset, MIME mismatch and checksum mismatch;
4. Preview open/Esc/backdrop/focus return and no document-root theme mutation;
5. local ThemeOption More keyboard behavior and built-in action absence;
6. same-ID reimport success/failure rollback and different-ID rejection;
7. active/inactive delete, cancel, Esc, persistence failure and deterministic focus return;
8. IndexedDB unavailable/blocked/quota/upgrade migration and hard-refresh restoration;
9. long Chinese/English name, warning/details overflow and action-scoped loading;
10. rapid selection/menu/dialog switching, reduced motion, console and document overflow.

Selected regression:

```text
ui2-settings-interface-preferences.spec.ts
ui2-theme-registry.spec.ts
settings.spec.ts
ui2-settings-shell.spec.ts
ui2-dialog-controls.spec.ts
ui2-navigation-overlays.spec.ts
ui2-feedback-data-display.spec.ts
app.spec.ts
dark-mode.spec.ts
desktop-computer-use-bridge.spec.ts
```

### Evidence

Capture six changed-state images from the real Vite server:

- `1440x960 ling-light`: valid import review;
- `1280x800 ling-light`: isolated Preview Dialog without document-root theme mutation;
- `1440x960 imported-theme`: installed local ThemeOption + More;
- `1280x800 imported-theme`: same-ID reimport review;
- `1440x960 imported-theme`: active delete fallback confirmation;
- `1280x800 ling-dark zh-CN`: runtime artwork safety blocker.

Metadata records branch, HEAD, dirty state, served artifact/URL, fixture checksum, locale, viewport,
Theme Pack ID, trigger, console, overflow, keyboard, reduced motion and SHA-256. Browser-injected
Desktop capability is not packaged Desktop evidence.

## 12. Exit Gate

P7C.1 can be marked `verified` only when:

- all reachable import/preview/reimport/delete states above have tests and real-page evidence;
- malformed or unsafe packages never change selection, Registry or stored package data;
- import/reimport/delete are atomic across manifest and assets;
- built-in themes cannot be overwritten or deleted;
- active-theme deletion has a tested fallback and rollback path;
- ThemePicker keyboard selection and option More menu do not conflict;
- no raw ZIP/Blob/storage logic is added to the Settings composition component;
- no Feature theme selector, arbitrary CSS, Logo replacement or remote asset path is introduced;
- Web typecheck, i18n, lint, guards, package tests and selected regression are green;
- coverage, page/E2E/CSS/selector/motion/feedback matrices, README and status board are updated.

If D1=A, token/preview package lifecycle may reach Web `verified` while runtime artwork remains
`inventory` under the later artwork slice. If D2=A, Web P7C.1 may reach `verified`; Desktop app-data
persistence remains `inventory/pending` and must not be reported as native-complete.

## 13. Hard Stops

- Do not add arbitrary CSS, JS, HTML, SVG, font, remote URL or Feature selector support.
- Do not allow Theme Pack assets to replace or recolor the existing Logo.
- Do not make Quick/Generate/Advanced controls in this slice.
- Do not change Settings navigation, workspace state, backend API, database or ThemeSelection model.
- Do not silently overwrite a different Theme ID during reimport.
- Do not infer artwork safety from filename, prompt text or palette analysis.
- Do not claim macOS/Windows persistence from IndexedDB or browser fixtures.
- Do not resolve the current remote Desktop overlap by dropping either side.

## 14. Web Closeout And Desktop Follow-Up

### 14.1 Implemented Web Boundary

- Added runtime-neutral package issue/types, canonical path and archive-index validation to
  `@ling-stack/ui-react`.
- Added a `fflate` Web ZIP adapter that inspects EOCD/central/local headers, rejects ZIP64,
  multi-volume, encrypted, unsupported-compression, symlink/special and unsafe-path entries, then
  verifies decoded sizes, CRC32, MIME, dimensions and SHA-256.
- Upgraded `ling-stack-ui2` IndexedDB from version 1 to version 2 with `themes`, `theme-packages` and
  `theme-assets`; install, reimport and delete use one transaction and preserve version 1 manifests.
- Added Registry/storage/visible-theme rollback for failed publication, reimport and deletion.
- Added ThemePicker sibling actions, Import/Preview/Delete Dialogs, isolated preview fixture,
  focused controller/view-model/CSS, global success Toast and persistent local failure ownership.
- Runtime `artwork` is rejected. Only semantic tokens and one validated isolated preview are accepted.
- All new production owners remain below 400 lines; `InterfaceThemeSettings.tsx` is 212 lines and the
  controller is 303 lines.

### 14.2 Verified Evidence

- Shared package `45/45`.
- Focused Theme Package E2E `5/5`; final evidence recapture `5/5`.
- Theme/Interface/Presentation focused regression `11/11`.
- Selected Settings/App/Dark/Desktop/Theme regression `83/83`.
- Web typecheck, i18n, lint and `git diff --check` passed.
- Six original-resolution screenshots, console/overflow checks and SHA-256 metadata are recorded in
  [`evidence/settings/theme-packages/metadata.md`](../../evidence/settings/theme-packages/metadata.md).

### 14.3 Required Desktop TODO

`DESKTOP-THEME-PACK-PERSISTENCE-001` remains `inventory / pending`. A later dedicated slice must:

1. create the native repository at `appData/themes/<themeId>/` with canonical relative paths;
2. publish through random same-volume staging, fsync where supported and atomic rename/swap;
3. clean abandoned staging safely without following links or accepting renderer-selected paths;
4. expose narrow typed main/preload IPC for list/read/install/reimport/delete and error categories;
5. keep Web manifest/package validation authoritative before bytes cross the IPC boundary, then
   revalidate native paths, sizes and checksums in main;
6. restore installed Theme Packs and the active selection after packaged app restart;
7. prove rollback after write, rename, quota/permission and corrupted-package failures;
8. verify packaged macOS and Windows install/reimport/delete/restart flows, including DPI, dark
   surfaces and first-frame behavior;
9. update the Desktop migration matrix and evidence metadata before changing status from `inventory`.

Web IndexedDB, browser-injected Desktop capabilities and renderer token synchronization do not close
this TODO. P7C.1 Web may remain `verified` while Desktop native persistence stays open.
