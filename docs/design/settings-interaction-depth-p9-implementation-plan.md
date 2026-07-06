# Settings Interaction Depth P9 Implementation Plan

## Related Docs

- [P9 Design](settings-interaction-depth-p9.md)
- [Settings Visual Density Follow-up](settings-visual-density-followup.md)
- [Settings Diagnostic Density P8](settings-diagnostic-density-p8.md)

## Summary

Implement P9 as four focused Web slices. The work is documentation, component
extraction, view-model/presentation helpers, copy, CSS, and e2e coverage only. It
must not change Settings IA, routes, daemon APIs, database schema, or backend
state machines.

## Implementation Steps

1. Skill Library deep interactions.
   - Extract the import draft dialog from `SkillLibrarySettingsPanel`.
   - Make import preview, optimization preview, review queue, source sync records,
     and compact inspector details summary-first.
   - Keep raw ids, paths, checksums, diffs, context findings, source refs, and token
     estimates behind details.

2. Plugin Manager and External Work.
   - Keep Plugin Manager default rows from P8.
   - Make runtime preview and details results product-status-first.
   - Move low-frequency or raw External Work workflow/token facts into details,
     while keeping setup, save token, poll, reconcile, and background controls
     reachable.

3. Default authorization, Maintenance, and Archived Items.
   - Reduce advanced permission, runner, startup, and archived restore/delete
     screens to task summary plus action.
   - Keep dangerous warnings near the action and move raw readiness or diagnostic
     facts to details.

4. Settings interaction system cleanup.
   - Add a focused `settings-interactions.css` for deep Settings interaction
     layouts instead of expanding broad global Settings styles.
   - Align i18n in `en-US` and `zh-CN`; remove or stop rendering unused deep
     explanation copy.
   - Extend `settings.spec.ts` and `dark-mode.spec.ts` assertions to click tabs,
     dialogs, previews, and details.

## Test Plan

- `git diff --check`
- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts dark-mode.spec.ts`
- Optional regressions if touched flows fail: `mcp.spec.ts`,
  `external-work.spec.ts`, `model-workbench.spec.ts`.

## Acceptance Checklist

- [x] P9 docs linked from P6/P8 Settings density docs.
- [x] Skill Library import/review/source/inspector deep states are summary-first.
- [x] Plugin Manager runtime preview and detail results are productized.
- [x] External Work workflow/token controls keep raw facts in details.
- [x] Permission, maintenance, and archived deep states avoid duplicate gray copy.
- [x] Settings e2e and dark-mode e2e cover the deep interaction states.

## Evidence

- Added `SkillImportDialog.tsx` so the Skill Library import flow owns its dialog,
  preview summary, import evidence details, and optimization preview details
  outside the main Settings panel.
- Added `SkillReviewQueuePanels.tsx` so review queue candidate, cluster, and
  playbook surfaces are no longer embedded in the generic Skill Library widgets
  file.
- Updated Source sync records to show names, status, and counts first; skill ids,
  paths, checksums, drift diffs, semantic diffs, and context findings remain behind
  `Source evidence`.
- Updated Plugin Manager runtime preview and preset result banners so product
  status is visible first and raw ids/status overlays sit behind details.
- Updated External Work, runner readiness, and startup readiness deep surfaces so
  raw workflow/token/runner/startup facts sit behind details.
- Added focused `settings-interactions.css` and imported it from `styles.css`.
- Verification:
  - `git diff --check`
  - `corepack pnpm --filter @ling-stack/web check:i18n`
  - `corepack pnpm --filter @ling-stack/web typecheck`
  - `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts`
  - `corepack pnpm --filter @ling-stack/web test:e2e -- dark-mode.spec.ts`

## Assumptions

- P9 preserves the current Settings IA and all existing actions.
- Diagnostics remain available for advanced users.
- Desktop Web is the validation target.
