# Repository Asset Provenance

Status: source publication inventory; project artwork origin confirmed by maintainer
Owner: repository maintainers
Last verified: 2026-10-08
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
| Public homepage screenshot | 1 | [Fresh workspace capture](../assets/ling-workspace-home.jpg), captured on 2026-10-08 before configuring a model. No real task, personal workspace path, or API key is shown. |

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
