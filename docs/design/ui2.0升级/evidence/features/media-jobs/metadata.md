# Media Jobs UI 2.0 Evidence Metadata

## Scope And Status

- Captured and verified: `2026-07-23 02:43 CST`, Asia/Shanghai.
- Branch / baseline HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Working tree: shared dirty tree; existing UI 2.0, Desktop and product changes were preserved. No reset, clean,
  stash, switch, checkout, rebase, merge, commit or push was run.
- Served artifact: real Vite source application at `http://127.0.0.1:4194`, with Playwright daemon fixtures.
- Browser: Playwright `1.60.0` Chromium project, one worker, desktop `deviceScaleFactor=1`.
- Themes: built-in `ling-light`, built-in `ling-dark`, and imported token-only fixture `quiet-ocean`.
- Web status: `MEDIA-JOB-LIST-001`, `MEDIA-JOB-CREATE-001`, `MEDIA-JOB-RESULT-001` and
  `MEDIA-JOB-REPAIR-001` are verified.
- Desktop status: packaged Electron macOS/Windows, Retina/DPI and high-contrast evidence remains a separate gate.

## Reproduction And Results

```bash
cd apps/web
LING_PLAYWRIGHT_PORT=4194 corepack pnpm exec playwright test e2e/ui2-media-jobs.spec.ts --reporter=line
LING_PLAYWRIGHT_PORT=4194 corepack pnpm exec playwright test e2e/media-jobs.spec.ts --reporter=line
LING_PLAYWRIGHT_PORT=4194 corepack pnpm exec playwright test \
  e2e/ui2-media-jobs.spec.ts e2e/media-jobs.spec.ts e2e/media-production.spec.ts --reporter=line
```

- focused Media Jobs: `11/11` passed;
- legacy Media Jobs: `5/5` passed after migrating obsolete private-class assertions to public role/data contracts;
- final combined Media Jobs + Media Production: `24/24` passed;
- Work Board focused/legacy regression reached `11/11`; isolated Model Workbench menu/Escape regression reached `1/1`;
- focused Media Jobs CSS totals `521` lines, down from `985` legacy lines;
- legacy `media.css`, `media-job-detail.css` and `media-create-dialog.css` are deleted;
- Media Jobs selector families in `components.css`, `strict-console.css` and `media-production.css` are zero;
- focused CSS contains zero hard-coded colors, `!important`, `transition: all`, private keyframes or theme selectors.

The focused suite covers the only production entry, initial/retained loading, empty/no-result/100-row lists,
keyboard selection, request and workspace races, scoped create/run/artifact busy state, image/edit/video creation,
validation, advanced disclosure, approval-gated and legacy waiting states, provider/workflow repair, one/multiple/partial
artifacts, copy/reuse, folded raw details, preview retry, Light/Dark/imported-theme media pixels, long content,
reduced motion, hit areas, Dialog bounds, root overflow and browser errors.

## Original-Size Screenshot Ledger

All files are direct Playwright viewport PNGs. Capture disables animation and caret rendering so evidence cannot freeze
a Dialog entrance frame. PNGs were not resized or recompressed after capture.

| Evidence | Viewport / theme / locale | Fixture and expected action | Function IDs | SHA-256 |
|---|---|---|---|---|
| `1280x800-ling-dark-create-video-advanced.png` | `1280x800`, `ling-dark`, `en-US` | `media_long_create`: Create video task | `MEDIA-JOB-CREATE-001` | `ac1933cf8c1ba3accfc6efd7f71b93bf74e3f82798bf1270eecb0d621d3c8607` |
| `1280x800-ling-dark-filter-no-result.png` | `1280x800`, `ling-dark`, `en-US` | `media_mixed_100`: Show all | `MEDIA-JOB-LIST-001` | `2d8562920360f6c1ae475fb43a207a35544e8a707c0de59cd9bfe7e9065e7af8` |
| `1280x800-ling-dark-needs-attention-repair.png` | `1280x800`, `ling-dark`, `zh-CN` | `media_provider_blocked`: Edit this model | `MEDIA-JOB-LIST-001`, `MEDIA-JOB-REPAIR-001` | `ed000dfd6b799f21c44dc8b171e38736f0cfe323214e1eb8692a7ac765df0add` |
| `1280x800-ling-dark-preview-unavailable.png` | `1280x800`, `ling-dark`, `en-US` | `media_missing_artifact`: Retry preview | `MEDIA-JOB-RESULT-001` | `3859a16b458718d36aa2416f1727afc9acc3ce3d9dec83e71d4ce65b5a000b84` |
| `1280x800-ling-dark-retained-refresh-failure.png` | `1280x800`, `ling-dark`, `en-US` | `media_refresh_stale`: Retry refresh | `MEDIA-JOB-LIST-001` | `0748dd2070d14b53faac21a921da3e79a240b82789150219d8723e74ed5ae6f5` |
| `1280x800-ling-dark-workflow-repair.png` | `1280x800`, `ling-dark`, `zh-CN` | `media_workflow_blocked`: Open connection settings | `MEDIA-JOB-REPAIR-001` | `23ea0e97e169123d4ab665b4ea3e2df892161e9056f79b8c72fe15e11e8d0948` |
| `1440x960-imported-quiet-ocean-image-result.png` | `1440x960`, `quiet-ocean`, `en-US` | `media_image_ready`: View result | `MEDIA-JOB-RESULT-001` | `7f5a8a1d1f7bbf76cedb024407ad30bf3e85c970444539fbc8c70b4a9def2d06` |
| `1440x960-ling-light-create-image.png` | `1440x960`, `ling-light`, `en-US` | `media_long_create`: Create task | `MEDIA-JOB-CREATE-001` | `e3f65142967cc96145188bbee76701482e7af15b56b8d91ccc7d8c2bc2f717f9` |
| `1440x960-ling-light-create-provider-blocked.png` | `1440x960`, `ling-light`, `en-US` | `media_provider_blocked`: Choose runnable model | `MEDIA-JOB-CREATE-001`, `MEDIA-JOB-REPAIR-001` | `c23c0b8970d6cef22af21e5e6f87e85e13e1dc80a3f1d330cda420db84c8af3c` |
| `1440x960-ling-light-empty-model-repair.png` | `1440x960`, `ling-light`, `en-US` | `media_empty_no_model`: Configure generation model | `MEDIA-JOB-LIST-001`, `MEDIA-JOB-CREATE-001`, `MEDIA-JOB-REPAIR-001` | `f4563605ef1c5d030f474be414e390dd3edaf7e836480ff1c58bebcdd65ad9c1` |
| `1440x960-ling-light-generating.png` | `1440x960`, `ling-light`, `zh-CN` | `media_video_running`: Wait for authoritative status | `MEDIA-JOB-LIST-001`, `MEDIA-JOB-RESULT-001` | `4b660c37d715c4ea65898fbfdbb28a7b315ee224c2e8f914f010d74f2945fa12` |
| `1440x960-ling-light-mixed-list-result.png` | `1440x960`, `ling-light`, `en-US` | `media_mixed_100`: Select and inspect result | `MEDIA-JOB-LIST-001`, `MEDIA-JOB-RESULT-001` | `626a7d38b157bb1847fa7cdc1ccef58d7cb32c81abf1913cf87fef511cb982f2` |

Every JSON sidecar matches the PNG SHA-256 and viewport dimensions, records canonical Function IDs, reports
`rootOverflow=0`, and keeps `packagedDesktop="pending"` explicit.

## Original-Size Visual Audit

- Light create Dialogs are opaque stable frames; no entrance-animation ghosting or duplicate overlay remains.
- Dark video advanced Dialog fits `1280x800`; body and footer own their scroll/geometry without opposite-theme blocks.
- Dark workflow repair now maps its legacy local surface variables to Theme Pack tokens; the connection list, form,
  controls and scrim no longer mix a white editor pane with black fields.
- 100-row list, no-result, retained refresh and needs-attention states keep list/Inspector as independent scroll owners.
- Failure summaries show product reason and next action; raw provider/workflow details remain folded.
- Preview-unavailable states retain Open/Download/Copy/Retry affordances without pretending mock bytes are playable.
- Imported `quiet-ocean` changes UI surfaces only; deterministic image interior pixel hash matches Light and Dark.
- No image showed incoherent overlap, root-width overflow, mixed Light/Dark surfaces or a second active Dialog.

## Honest Remaining Gaps

- Media Production P10.2 has legacy regression coverage here but is not marked UI 2.0 verified by this ledger.
- Packaged Electron macOS/Windows, Retina/DPI, forced-colors and native restart evidence is not captured.
- Media Workflow Library still owns legacy implementation/CSS outside the Media Jobs focused owner; this slice only
  fixes its reachable Dark repair surface with a scoped Theme Pack token bridge.
- Global U13 cleanup and final all-product regression remain separate closeout work.
