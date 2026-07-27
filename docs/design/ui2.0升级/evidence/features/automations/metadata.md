# Automations UI 2.0 Evidence Metadata

## Scope And Status

- Recorded and reproduced: `2026-07-24`, Asia/Shanghai.
- Branch / baseline HEAD: `codex/ui2-desktop-coverage-foundation` / `0a0b80502715d0333342422e6dc8cedd2cd77b14`.
- Working tree: shared and dirty before this closeout; unrelated Desktop and UI 2.0 changes were preserved.
- Served artifact: real Vite source application at `http://127.0.0.1:4174`, not a static DOM harness.
- Browser: Playwright Chromium desktop, one worker, `deviceScaleFactor=1`, `en-US`.
- Themes: built-in `ling-light` and `ling-dark`, plus imported `Quiet Ocean` Theme Pack coverage for the list,
  Inspector and shared create Dialog.
- Web status: `AUTO-LIST-001`, `AUTO-STATUS-001`, `AUTO-CREATE-001`, `AUTO-SCHEDULE-001`,
  `AUTO-TARGET-001`, `AUTO-RUN-001` and `AUTO-INSPECT-001` are verified.
- Desktop status: packaged Electron macOS/Windows evidence remains a separate release gate.

## Reproduction And Test Results

```bash
corepack pnpm --filter @ling-stack/web test:e2e -- \
  ui2-automations.spec.ts automations.spec.ts
```

Results:

- focused `ui2-automations.spec.ts`: `6/6` passed;
- legacy `automations.spec.ts`: `2/2` passed;
- formal focused + legacy Automations command: `8/8` passed;
- existing combined regression: `68/68` passed;
- broad App/Channel/Teammates/Archive/Dark regression: `149/149` passed;
- lint, i18n, typecheck, production build and `git diff --check`: passed.

The focused suite covers 100-row internal scrolling, search/Escape, keyboard selection, retained rows after refresh
failure, request/selection races, manual create failure with retained input, template review, invalid chat draft,
scheduler stopped/start and scoped busy, missing-target repair, run failure repair, raw details folding, schedule edit,
archive failure ownership and imported Theme Pack ownership. The suite asserts no unexpected console/page errors and
no horizontal document or surface overflow; synthetic `503` responses are allowed only in the scenarios that
deliberately create them.

## CSS Ownership Closeout

- `strict-console.css` decreased from `682` to `584` lines; `automations/page.css` increased only from `111` to
  `113` lines to retain authoritative root geometry.
- Eleven dead Automations roots were removed. Aggregate CSS no longer paints the Automations surface positively and
  retains only negative exclusions around live generic workspace rules.
- Those exclusions use `:where(:not(.workspace-automations-surface))`; the zero-specificity wrapper preserves the
  original cascade for non-Automations surfaces while releasing Automations to focused CSS and shared primitives.
- Web CSS is `155 files / 36,523 lines`. This ownership release does not change Function ID or packaged Desktop status.

## Original-Size Screenshot Ledger

All files are direct Playwright viewport PNGs and were not resized or recompressed after capture.

| Evidence | Viewport / theme | State | SHA-256 |
|---|---|---|---|
| `1440x960-ling-light-list-inspector.png` | `1440x960`, `ling-light` | 100 definitions, selected row and persistent Inspector | `83c7c73c5fce44be59af146748e72fee3d0982dc45259d7eece2716964f67ec8` |
| `1440x960-ling-light-create-review.png` | `1440x960`, `ling-light` | Template applied into the shared manual review Dialog | `0a48ed58453668a6de8282ff0d84ff0449ba76678c2298463ef2ff873a53bd0c` |
| `1440x960-ling-light-scheduler-stopped.png` | `1440x960`, `ling-light` | Stopped scheduler with one actionable Start control | `c723843434a493cf27ba69f302402a01b60000d6dfa9ecb498bcdd07f9f6ef87` |
| `1280x800-ling-dark-chat-draft-invalid.png` | `1280x800`, `ling-dark` | Invalid conversation draft retained for manual repair | `eeabf3647d70a37f685774cbfbb47981b10f3ae9a56a10004e04801d30897910` |
| `1280x800-ling-dark-failure-repair.png` | `1280x800`, `ling-dark` | Needs-attention list, failed run and Inspector Retry | `5ad355bc5165d7e791c3b5176aa0c60eb8aac1f857c075836d5ebc0dcdf5b842` |
| `1280x800-ling-dark-archive-failure.png` | `1280x800`, `ling-dark` | Archive Dialog remains open with scoped failure | `aa2b1ff10bf2ad7ee96dc8f22105602fa928cb9fc9cba89402b048155934be57` |
| `1440x960-quiet-ocean-list-inspector.png` | `1440x960`, `Quiet Ocean` | Imported Theme Pack list and Inspector ownership | `8cd85fb45bc998923574de8e1552d722eaafa942244de3219e676016d1b3496f` |
| `1280x800-quiet-ocean-create-dialog.png` | `1280x800`, `Quiet Ocean` | Imported Theme Pack shared create Dialog ownership | `68de80e2d3f6cdb2cb359ed517608ebeb8be8df8d41efbf33ef47eb22c3caed2` |

## Original-Size Visual Audit

All eight PNGs were inspected at original size after the passing test run:

- the 100-row list owns vertical scrolling while Header, Scheduler summary and Inspector remain fixed;
- actions, four status Tabs and the 320-360px Inspector remain contained without root horizontal overflow;
- Create and Archive Dialogs stay inside both viewports and preserve readable footer actions;
- invalid draft, run failure and archive failure are anchored to their owning Dialog/Inspector rather than a page wall;
- Light, Dark and imported Quiet Ocean overlays, rows, controls and backdrops use coherent semantic tokens without
  opposite-theme panels;
- shared focused inputs keep stable outer geometry and do not draw an overflowing second native focus box.

## Honest Remaining Gaps

- No packaged Electron macOS Retina or Windows 125%/150% capture was produced.
- Web evidence does not prove native titlebar, OS font rasterization, forced colors, GPU composition or packaged
  renderer startup behavior.
