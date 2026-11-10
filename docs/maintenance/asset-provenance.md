# Repository Asset Provenance

Status: source publication inventory; project artwork origin confirmed by maintainer
Owner: repository maintainers
Last verified: 2026-10-10
Document type: repository governance

This inventory covers tracked images, icons, and font files. The MIT source license and
the npm dependency audit do not automatically establish third-party asset rights or
trademark rights. Recorded generation paths establish reproducibility; maintainers must
still confirm authority to publish the underlying artwork.

## Inventory

The reviewed source baseline contains 67 image/icon files and no tracked font files in
the surveyed extensions (`png`, `jpg`, `jpeg`, `svg`, `webp`, `ico`, `icns`, `woff`,
`woff2`, `ttf`, `otf`). The new public homepage capture brings this batch to 68 files.
Dependency and generated build fonts are covered by the license and binary inventories,
not by this tracked-file count.

| Asset group | Files in this batch | Recorded origin and publication status |
| --- | --- | --- |
| Web brand vectors and favicon | 5 | Shared brand vectors under `apps/web/public/icons/`; generated PNG favicon. Confirm project name and logo authority before publication. |
| Chrome extension runtime icons | 4 | Generated from shared vectors by `apps/desktop/scripts/generate-brand-icons.mjs`. |
| Desktop icons | 2 | Same generation script produces `icon.icns` and `icon.ico`. |
| Chrome Web Store candidates | 4 | Shared-vector icon and deterministic promotional HTML; two Plugin Manager screenshots use a non-live acceptance fixture. See the [store asset instructions](../../apps/chrome-extension/store-assets/README.md). These are submission candidates, not proof of store publication. |
| Default teammate avatars | 10 | `apps/web/public/avatars/teammates/`; on 2026-10-08 the maintainer confirmed these were made by the project or generated with AI. Detailed per-file creation metadata is not recorded. Retained for source publication. |
| Social preview | 1 | `docs/design/assets/ling-stack-social-preview.png`; the same maintainer confirmation covers this image. Detailed creation metadata is not recorded. Retained as the repository social preview candidate. |
| Desktop preview test baselines | 34 | Visual acceptance fixtures under `apps/desktop/tests/screenshots/computer-use-preview/darwin-arm64/`; preserve these as test evidence. They are not end-user feature acceptance or a product demo. |
| Web design evidence | 7 | Theme/profile screenshots under `docs/design/ui2.0升级/evidence/`; historical visual evidence, not a current product demo. |
| Public homepage screenshot | 1 | [Fresh workspace capture](../assets/ling-workspace-home.jpg), recaptured on 2026-10-17 from the local Web UI at merge commit `cd7d9d83bf3b13ac3b8b68c99f343e51a01a6e56`, with the English interface, Ling Light theme, and a non-secret demonstration model selected. No real task, personal workspace path, API key, or external model request is shown. |
| Current scene backgrounds | 6 | Breeze: generated in-house on 2026-10-29 (`forest-clearing-v1.webp`, 1672×941, 317870 bytes) to replace a user-supplied forest illustration whose author and public redistribution license were never established; the generated artwork carries no third-party attribution obligation and both `forest-sky-v3*` files were deleted. Previous Wikimedia photo and rejected StockCake candidate retain their historical CC BY-SA 4.0/CC0 records. Ocean: existing StockCake summer manga (source-declared CC0). Night: user-selected Titanfall 2 valley artwork, downloaded 3840×2160 without upscaling; copyrighted, public redistribution clearance open. Three complete static WebP files and same-source thumbnails. Exact dimensions, hashes, prompt and processing: [`scene-themes-v7.sources.json`](../../apps/web/public/themes/scene-themes-v7.sources.json); Ocean/Night detail remains in [`scene-themes-v6.sources.json`](../../apps/web/public/themes/scene-themes-v6.sources.json). Theme-code MIT does not cover supplied or game artwork. |
| Historical Night photographic background | 2 | `rain-window-v2.webp` and its thumbnail are retained with Marrik / CC BY-SA 4.0 attribution; historical source/export hashes remain in [`scene-themes-v3.sources.json`](../../apps/web/public/themes/scene-themes-v3.sources.json). |
| Historical Ocean photographic background | 2 | `salt-coast-v1.webp` and its thumbnail are retained with CC BY-SA 4.0 attribution; their hashes and author remain in [`photographic-scenes-v2.sources.json`](../../apps/web/public/themes/photographic-scenes-v2.sources.json). These files no longer provide the current Ocean scene. |

The current homepage image is an unedited browser capture at 1280 x 800, taken from
source commit `cd7d9d83bf3b13ac3b8b68c99f343e51a01a6e56` using an isolated fresh
workspace. Product language was changed through Settings > Interface preferences >
Product language. The selected model uses a public service label without a real API key,
and no external model request was made. It replaces the earlier English capture with a
blocked model warning, not the brand assets or Chrome Web Store candidates. Browser
warnings and errors were checked after capture; none were reported. This screenshot is
not packaged-client or full feature acceptance.

## Origin Records

The avatars and social preview have a maintainer-provided origin record: project-made
or AI-generated. This confirmation does not identify each file's author, generator,
generation date, or applicable service terms. Preserve those details when available;
do not invent a third-party license or attribution.

For future assets, record project authorship, or the AI service and applicable terms,
or a third-party source URL plus its license and required attribution.

Confirm authority over the project name and shared logo as well. The MIT License does
not grant third-party trademark rights. If an asset cannot be cleared, replace or remove
it before source publication rather than assigning it an invented license.

Review public screenshots for personal paths, account identifiers, tokens, and private
content. Preserve test baselines that remain necessary; recapture only evidence that
contains private content or no longer supports its intended assertion.

## Binary Boundary

Desktop releases must inventory the actual packaged fonts, native resources, media,
and dependency files. Include their license and attribution text in generated notices
and the SBOM. The Inter font source uses OFL-1.1; the dependency audit records that family,
but a source-tree check cannot prove that a future installer includes the required notice.
See [Third-Party Notices](../../THIRD_PARTY_NOTICES.md#binary-distribution-boundary).
