# P7C.2 Quick Theme Studio Implementation Plan

Status: `decision-independent substrate verified / D3 decision-gated` on 2026-07-20.

This plan implements the offline Quick mode only. Generate and Advanced remain P7C.3/P7C.4. P7C.1
Web Theme Pack Management is verified and becomes the install/selection regression baseline.

## 1. Objective

Settings > Interface Preferences gains a real nested Theme Studio surface that can:

```text
Choose one local image
  -> validate and decode locally
  -> analyze a bounded RGBA sample locally
  -> derive a Light or Dark semantic theme
  -> compile and verify through the existing deterministic Compiler
  -> preview Home / Conversation / Settings / Dialog
  -> save and restore a local draft
  -> install atomically through the existing Theme Registry boundary
  -> optionally apply through the normal ThemeSelection transaction
```

Quick mode makes zero provider, daemon or network requests. The uploaded image never leaves the
browser. No fake progress timer, model fallback or placeholder result is permitted.

## 2. Source Of Truth

- [Interface Preferences](03-Interface-Preferences.md)
- [Theme Studio 与生成预览](../../components/13-Theme-Studio与生成预览.md)
- [AI 生成主题产品流程](../../themes/07-AI生成主题产品流程.md)
- [主题资源导入与安全](../../themes/05-主题资源导入与安全.md)
- [Theme Compiler 与 AI Provider 边界](../../architecture/08-Theme-Compiler与AI-Provider边界.md)
- [Theme Pack Management closeout](10-Theme-Pack-Management-implementation-plan.md)
- [UI 2.0 后续升级执行方案](../../04-UI2.0后续升级执行方案.md)

Security and deterministic Compiler contracts override visual convenience. Existing P7C.1 import,
selection, rollback and Desktop TODO states must not be reopened.

## 3. Audited Baseline

Already implemented:

- `analyzeThemeImage()` with deterministic luminance, palette, information score, focus, safe-area and
  recommended Profile output from a bounded RGBA sample.
- `compileLingTheme()` with complete semantic token derivation, contrast repair, generated manifest,
  Profile allowlist, artwork slot validation and structured verification report.
- Four app-owned Presentation Profiles and route-aware surface policies.
- `ThemeRegistry`, `ThemeProvider`, fixed/System selection, bootstrap and atomic apply rollback.
- P7C.1 manifest/package/preview storage and local ThemePicker actions; the shared database owner is
  now v3 and preserves v1/v2 data while adding Quick draft stores.
- a real Web PNG/JPEG/WebP validation, decode, bounded Canvas sample and SHA-256 adapter with no
  provider, daemon or network request;
- an atomic IndexedDB Quick draft metadata/source-Blob repository;
- a pure Quick reducer with revisioned stale-operation suppression and dependency-scoped invalidation.
- package-owned `ThemeStudioPreviewFixture` with synthetic Home/Conversation/Settings/Dialog surfaces,
  fixed desktop viewport contracts and exact CSS transform scaling;
- Shared Field, Input, Select, SegmentedControl, Tabs, Button, Dialog, Menu, Toast,
  InlineFeedback, InspectorSection and ThemePreviewFixture primitives.

Not implemented:

- local content-risk detection for readable text, Logo/watermark or UI chrome;
- a Theme Studio nested Settings surface or `Create theme` production entry;
- a Quick controller and production React surface;
- production Preview panel controls that connect surface/viewport selection to the shared fixture;
- generated artwork bytes in the installed package repository;
- a runtime artwork URL resolver or AppShell presentation artwork layer;
- Web generated-theme publish/rollback tests;
- Desktop native Theme Pack/draft repository, which remains a separate explicit TODO.

The current `AppPresentationSurfaceBridge` resolves only route policy attributes. It does not render
or resolve artwork bytes. A compiled manifest containing `artwork.assets` is therefore not proof that
the image can be displayed safely or restored after refresh.

## 4. Locked Decisions

- Imported packages: D1=A semantic tokens plus isolated Preview only. Runtime imported artwork stays
  rejected.
- Persistence: D2=A Web-first. Desktop native repository/IPC/restart remains
  `DESKTOP-THEME-PACK-PERSISTENCE-001`.
- Quick is offline and makes no text, vision or image-model request.
- Quick and P7C.1 import remain separate product flows. A `.ling-theme` file is not accepted by Quick.
- Generate/Advanced controls are not exposed until their real adapters exist.
- No Logo change, arbitrary CSS/JS/HTML/SVG/font/remote URL, Feature selector or DOM/layout payload.

## 5. D3 Decision Gate: Quick Runtime Artwork Safety

Current local analysis can derive color and composition but cannot truthfully determine whether an
arbitrary image contains readable text, Logo/watermark or application chrome. The Compiler requires
those risk values and must not receive fabricated `false` values.

| Option | Quick v1 behavior | Trade-off |
|---|---|---|
| A - token-only from image (recommended) | Use local pixels to derive palette and tokens; do not store or render the source as runtime artwork | Preserves offline and strongest safety, but the installed theme changes color rather than background |
| B - explicit clean-background attestation | Require source class, rights and no-text/Logo/UI confirmation; publish the normalized image as generated runtime artwork | Delivers full visual result offline, but content safety depends on the user's declaration |
| C - mandatory vision review | Run a configured vision-capable model before artwork publication | Stronger automated review, but Quick is no longer offline or model-free |

Selected option: `pending user decision`.

Decision-independent image validation, decode/sample, draft storage, reducer and shared multi-surface
Preview fixture work is complete. No production `Create theme` entry, install action or runtime artwork
publication may land until D3 is selected and this plan is updated.

## 6. Product Entry And Shell

P7C.2 adds one real `Create theme` secondary action next to `Import theme` only when the complete Quick
flow for the selected D3 option is ready.

```text
SettingsShell
  Interface Preferences
    Appearance
      ThemePicker
      [Create theme] [Import theme]

  Create theme -> ThemeStudioSurface
    ThemeStudioHeader
      Back to themes
      Draft name / saved state
    QuickThemeWorkspace
      QuickThemeInputPanel
      ThemeStudioPreviewPanel
    ThemeStudioFooter
      real stage summary
      Install and use / Install only
```

- The Settings left navigation remains visible and `interface-preferences` remains selected.
- No route, ViewId or SettingsSectionId is added.
- `InterfacePreferencesSettingsPanel` owns only `overview | quick-studio` local navigation.
- Back returns to the ThemePicker at the previous scroll position and restores focus to Create theme.
- Browser back is not intercepted until Settings has a real internal history owner; Esc does not leave
  the full page.
- Dirty Back opens one shared confirmation Dialog. Running analysis is abortable and must settle before
  leaving.
- Generate and Advanced are absent in P7C.2, not disabled placeholders or “coming soon” cards.

## 7. Quick Default Layer

```text
Quick theme
  Local image                                      FileButton / Drop zone
  Theme name                                       Input
  Color scheme                                     Segmented Light | Dark
  Presentation                                     Select
  Artwork intensity                                Segmented, only if D3=B/C
  Generate preview                                 Primary Button

Preview
  Home | Conversation | Settings | Dialog          Tabs
  1280x800 | 1440x960                              Segmented
  Verification                                     InlineFeedback / Inspector
```

- The input panel starts at `340px`; preview uses `minmax(0, 1fr)`.
- At a Settings content width below `960px`, Preview appears above Input in one column. This is desktop
  compact behavior, not a mobile contract.
- Theme name is required, 1..80 Unicode characters. Theme ID is generated once from a normalized ASCII
  fallback plus a short random suffix, never rewritten while editing the name.
- Accepted source formats: PNG, JPEG, WebP; maximum 16 MB, 8192 longest edge and 32 MP.
- File input and drop use the same validator and one accessible Button owner.
- The selected image row shows thumbnail, filename, dimensions, size, Replace and Remove. Absolute paths
  and EXIF metadata are never shown or stored.
- Product copy says `Generated locally. No model or network request.`
- Advanced composition details remain folded until analysis succeeds.

## 8. Image Decode And Analysis Contract

The Web adapter performs:

1. validate extension and byte size before decode;
2. MIME-sniff PNG/JPEG/WebP bytes and require extension agreement;
3. decode with `createImageBitmap(..., { imageOrientation: "none" })` or an object-URL Image fallback;
4. reject zero, over-edge or over-pixel dimensions;
5. draw a contain-scaled sample with longest edge at most `128px`;
6. read RGBA pixels and call package `analyzeThemeImage()`;
7. compute SHA-256 for stable source revision;
8. create/revoke a preview object URL owned by the controller;
9. if D3=B/C, normalize runtime artwork to an approved PNG/WebP Blob before publication;
10. clear source metadata and never persist the original filename as an asset path.

The adapter exposes structured product issue codes. Browser decoder text and DOMException details stay
in collapsed diagnostics and are not used as primary copy.

## 9. Deterministic Defaults

- Suggested scheme: `dark` when average luminance `<0.38`; otherwise `light`. The user can override it.
- Suggested Profile: use `analysis.recommendedProfileId` only when the selected D3 option permits
  runtime artwork; otherwise default to `ling-standard`.
- Palette background: first dominant color; accent: `analysis.accentCandidate`.
- Presentation intensity defaults to `balanced`; decoration set defaults to `none`.
- Focus and safe area come from analysis and are clamped to `0..1`.
- Every override invalidates only Compile/Verify, never re-decodes the unchanged image.
- Compile runs synchronously after bounded analysis but still uses explicit `compile` and `verify` stage
  transitions; no artificial delay is introduced.

## 10. State Model

```ts
type QuickThemeStage =
  | "empty"
  | "validating"
  | "analyzing"
  | "draft-ready"
  | "compiling"
  | "blocked"
  | "preview-ready"
  | "publishing"
  | "installed";

interface QuickThemeDraft {
  id: string;
  revision: number;
  name: string;
  themeId: string;
  colorScheme: "light" | "dark";
  presentationProfileId: LingPresentationProfileId;
  artworkIntensity: "subtle" | "balanced" | "strong";
  source?: QuickThemeSourceRecord;
  analysis?: ThemeImageAnalysis;
  compiled?: CompiledLingThemeCandidate;
  stage: QuickThemeStage;
  issue?: QuickThemeIssue;
  updatedAt: string;
}
```

- One reducer owns invalidation. Components do not independently clear analysis or candidate state.
- Source replacement increments `revision` and invalidates analysis/compiled/verification.
- Scheme/Profile/intensity invalidates compiled/verification only.
- Name edits invalidate manifest identity only.
- Async decode results with an old revision are ignored and their object URLs/bitmaps are released.
- Cancel aborts decode/analysis where possible, keeps source and returns to `draft-ready`.
- Retry starts a new operation ID at the failed stage.
- Analysis or storage failure never creates a successful empty theme.

## 11. Draft Persistence

Upgrade the single `ling-stack-ui2` database owner to version 3:

```text
themes                 installed manifest by themeId
theme-packages         installed package metadata by themeId
theme-assets           installed assets by themeId/path
theme-drafts           Quick draft metadata by draftId
theme-draft-assets     source/normalized/preview Blob by draftId/kind
```

- Version 3 preserves all version 1 and version 2 data.
- Draft metadata and assets write in one transaction.
- At most one active Quick draft is restored in P7C.2; old drafts are not exposed as a management list.
- localStorage stores only the last draft ID, never pixels, palette, manifest or image bytes.
- Save is debounced by the repository/controller boundary, not a Feature timer scattered in fields.
- Quota, blocked upgrade and transaction abort leave the last committed draft intact.
- Removing a source deletes only its draft assets. Installed theme assets are a separate namespace.
- Successful install marks the draft clean; Done may delete the draft after explicit confirmation.

## 12. Preview Contract

`ThemeStudioPreviewFixture` is package-owned and receives semantic variables plus a Presentation policy.
It uses synthetic content only and never mounts workspace/domain data.

Required surfaces:

- Home: shell/sidebar identity, title, action and composer geometry.
- Conversation: feed rows, summary affordance, dock/terminal boundaries.
- Settings: Field, Select, DataRow and Inspector hierarchy with artwork forced off.
- Dialog: overlay, focus ring, status, Toast sample and destructive action.

Required viewport controls in P7C.2: `1280x800` and `1440x960`. The larger 1920/2560/3440 fixtures
remain required before final cross-platform Theme Studio completion but do not justify stretching one
static screenshot.

- Candidate variables are scoped to the fixture root and never applied to `documentElement`.
- Tabs and viewport selection preserve Input state and focus.
- Preview controls are focusable for accessibility but do not invoke product actions.
- D3=A shows token surfaces and explicitly labels artwork as not installed.
- D3=B/C may show a local object URL only after the corresponding safety gate is satisfied.
- Settings/Dialog never display runtime artwork even for immersive Profiles.

Implementation checkpoint on 2026-07-20:

- `ThemeStudioPreviewFixture` accepts only copy, semantic variable map, Presentation policy, surface,
  viewport, scale and an optional caller-owned `blob:` object URL; it drops non-allowlisted style keys,
  data/remote artwork URLs and imports no Web/domain/storage owner.
- Five viewport IDs map to exact immutable dimensions. The fixture uses a real layout viewport and
  `transform: scale(...)`; it never stretches a screenshot.
- Settings and Dialog normalize to `solid / artwork off / decorations false` inside the package even
  when the caller passes an immersive policy.
- Shared package tests are `50/50`; Quick substrate focused E2E is `4/4`; Theme Pack/Registry/Compiler/
  Quick combined regression is `15/15`.
- Browser screenshots were inspected for Home Light, Conversation Dark and Dialog Dark. They are
  substrate test output, not final production evidence and cannot close `UI-THEME-STUDIO-PREVIEW-001`.

## 13. Progress And Feedback

Quick uses stable step IDs:

```text
Validate -> Analyze -> Compile -> Verify -> Ready
```

- Only the active real stage shows Spinner and `aria-current="step"`.
- Completed stages use a neutral check and one result summary, not green cards.
- Blocking source/compile/storage issues remain InlineFeedback at the owner with Retry/Replace.
- Technical details use InspectorSection.
- File selected, Analyze success and Compile success are silent; no Toast per stage.
- Install success uses one global Toast scoped `theme:studio:<draftId>`.
- Install/apply are separate. Apply failure keeps the installed theme and restores the previous active
  selection with persistent local feedback.
- Delete draft success may use Toast; dirty/leave confirmation remains a Dialog.

## 14. Publish Boundary By D3

Common rules:

- Candidate must have `readyToPublish=true` and zero blockers.
- Registry source is `local-generated`; generation mode is `quick`.
- Built-in IDs and installed different IDs cannot be overwritten.
- Install and apply remain separate transactions.
- Failure restores Registry, stored package/assets and visible theme.

D3=A publication:

- install generated manifest and optional isolated Preview only;
- omit `manifest.artwork` and runtime source bytes;
- force or confirm a token-compatible Profile before Ready.

D3=B publication:

- require clean-wallpaper source class, rights confirmation and explicit no-text/Logo/watermark/UI
  attestation before Compile/Ready;
- persist normalized generated artwork and manifest in one transaction;
- retain the attestation result as non-secret generation metadata, not a safety guarantee label.

D3=C publication:

- requires a separate vision-review adapter and privacy/cost confirmation;
- cannot be implemented as Quick under the current offline contract without changing product copy and
  acceptance. Selecting C therefore triggers a follow-up design revision before code.

## 15. Module Boundaries

```text
packages/ui-react/src/theme-studio/
  ThemeStudioPreviewFixture.tsx       synthetic multi-surface preview + domain-neutral props

apps/web/src/shared/ui/theme/studio/
  web-quick-theme-image.ts             sniff/decode/sample/hash/normalize
  web-theme-draft-repository.ts        IndexedDB v3 transaction owner
  web-generated-theme-publication.ts   generated asset publication adapter

apps/web/src/features/settings/theme-studio/
  ThemeStudioSurface.tsx               composition only
  QuickThemeInputPanel.tsx
  ThemeStudioPreviewPanel.tsx
  ThemeStudioProgress.tsx
  ThemeStudioLeaveDialog.tsx
  useQuickThemeStudioController.ts
  quick-theme-state.ts
  quick-theme-view-models.ts

apps/web/src/styles/
  settings-theme-studio.css
```

- `@ling-stack/ui-react` imports no File, Blob, Canvas, IndexedDB, i18n, API client or route.
- Web decode/storage adapters contain no JSX or translated copy.
- Controller coordinates state and object URL lifecycle; it does not implement token math or render UI.
- `ThemeStudioSurface.tsx` targets below 250 lines; controller/reducer each below 400 lines.
- `InterfaceThemeSettings.tsx` only receives `onCreateTheme`; no draft/image logic is appended.
- `PersonalInterfaceSettingsPanel.tsx` owns local nested-surface selection, not the draft state machine.
- `SettingsPage.tsx` and `AppShell.tsx` receive no Quick business logic.
- Focused CSS owns only Studio geometry; shared control/overlay/theme/motion visuals stay package-owned.

## 16. Implementation Order

Decision-independent substrate:

1. Done: record this audit, D3 and Function IDs in all matrices.
2. Done: add Web image issue/types and sniff/decode/sample/hash adapter with browser tests.
3. Done: upgrade IndexedDB owner to v3 and add atomic draft metadata/assets repository with v1/v2 migration tests.
4. Done: add pure Quick reducer/invalidation tests.
5. Done: add package-owned multi-surface preview fixture, focused CSS, package tests and real Vite geometry checks.

After D3 is selected:

6. Update section 14 to one authoritative publication contract.
7. Add generated-theme publication/runtime artwork adapter required by that option.
8. Build controller, nested Settings surface and focused CSS.
9. Add zh-CN/en-US copy, ARIA, keyboard, reduced motion and long-content handling.
10. Add focused E2E, selected regression and real Vite evidence.
11. Inspect original pixels, record SHA-256 and update every matrix/status document.

No production Create Theme entry is added before steps 1..8 form a truthful complete flow.

## 17. Test Plan

### Package And Static

```text
git diff --check
corepack pnpm --filter @ling-stack/ui-react test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web check:i18n
corepack pnpm --filter @ling-stack/web lint
```

Package tests cover multi-surface fixture semantics, Profile fallback, variable scoping, long copy and
reduced motion. Existing Compiler golden/contrast/artwork blocker tests remain mandatory.

### Focused Web E2E

Add `apps/web/e2e/ui2-settings-quick-theme-studio.spec.ts` and cover:

1. Create entry, nested Back/focus/scroll and no new Settings route;
2. PNG/JPEG/WebP valid source, wrong extension/MIME, corrupt image, over-size/edge/pixels;
3. local analysis result, deterministic scheme/Profile/palette and zero network/provider requests;
4. source replace/remove, old-result suppression, object URL/bitmap release;
5. name/scheme/Profile invalidation without repeated decode;
6. Validate/Analyze/Compile/Verify real progress, cancel and retry;
7. Home/Conversation/Settings/Dialog Tabs and both required viewports;
8. compile blocker, storage/quota failure, persistent repair and technical Details;
9. IndexedDB v2 -> v3 migration, draft refresh restore and stale/invalid draft recovery;
10. install only, install-and-use, apply rollback, duplicate ID and active theme deletion regression;
11. D3-specific artwork absence/attestation/review behavior;
12. zh-CN/en-US, keyboard, reduced motion, console, internal/document overflow.

Selected regression:

```text
ui2-settings-theme-packages.spec.ts
ui2-settings-interface-preferences.spec.ts
ui2-theme-registry.spec.ts
ui2-presentation-compiler.spec.ts
ui2-settings-shell.spec.ts
ui2-dialog-controls.spec.ts
ui2-navigation-overlays.spec.ts
ui2-feedback-data-display.spec.ts
settings.spec.ts
app.spec.ts
dark-mode.spec.ts
desktop-computer-use-bridge.spec.ts
```

### Real Browser Evidence

Capture at least six changed states from the Playwright-managed real Vite server:

- `1440x960 ling-light`: Quick empty/default layer;
- `1280x800 ling-dark zh-CN`: selected source and local-analysis progress;
- `1440x960 candidate-light`: Home preview plus verification;
- `1280x800 candidate-dark`: Settings or Dialog preview with compact stacking;
- `1440x960 ling-light`: draft restored after refresh;
- `1280x800 ling-dark`: compile/storage/publish failure with repair path.

Metadata records branch/HEAD/dirty state, served URL, source fixture checksum, locale, viewport,
candidate theme ID, D3 policy, network request count, console, overflow, keyboard, reduced motion and
PNG SHA-256. Browser evidence remains Web-only and cannot close Desktop native persistence.

## 18. Exit Gate

P7C.2 may reach Web `verified` only when:

- D3 is selected and no implementation fabricates artwork content-risk values;
- Quick performs zero model/provider/daemon/network requests;
- valid local image analysis and deterministic Compiler output are proven;
- invalid/corrupt/oversized inputs never enter draft publication or Registry;
- draft and generated package publication are atomic with tested rollback;
- source bytes/object URLs/bitmaps have explicit lifecycle ownership;
- all four preview surfaces and two required viewports are reachable and verified;
- install only/apply and failure ownership are truthful;
- Generate/Advanced and Desktop native persistence are not claimed complete;
- no arbitrary CSS/JS/HTML/SVG/font/remote URL/Logo/Feature selector support is introduced;
- production owners respect module/line boundaries;
- package/static/focused/selected E2E and six real screenshots are green;
- coverage, page/E2E/theme/CSS/selector/motion/feedback/status/controller docs are updated.

## 19. Hard Stops

- Do not set `readableText`, `logoOrWatermark` or `uiChrome` to false without the selected D3 evidence.
- Do not expose Create theme before install/rollback is real for the selected D3 option.
- Do not make Quick call a model silently or fall back to Generate.
- Do not store image bytes or manifest in localStorage.
- Do not use data URLs as persistent asset identity.
- Do not let renderer/user input select an absolute storage path.
- Do not put Canvas/IndexedDB/Blob logic in React components or `theme.tsx`.
- Do not add AppShell, route, ViewId, SettingsSectionId, daemon API or database changes.
- Do not modify Logo, Generate, Advanced or Desktop native repository in this slice.
