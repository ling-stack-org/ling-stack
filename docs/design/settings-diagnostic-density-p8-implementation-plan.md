# Settings Diagnostic Density P8 Implementation Plan

## Related Docs

- [P8 Design](settings-diagnostic-density-p8.md)
- [Settings Visual Density Follow-up](settings-visual-density-followup.md)

## Summary

Implement P8 as a focused desktop Web pass over Plugin Manager and Skill Library.
The work is view-model, layout, copy, CSS, and e2e only. It must not change backend
contracts, storage, Settings IA, or plugin/skill state machines.

## Implementation Steps

1. Add plugin view-model helpers.
   - Derive row summary, source label, readiness copy, package summary, linked
     resource summary, primary action, and secondary detail actions.
   - Keep helper output UI-only and free of API calls.

2. Refactor Plugin Manager.
   - Default row renders only title, status/source chips, readiness summary, and
     the primary action.
   - Move raw facts and secondary actions into a details inspector inside each row.
   - Preserve existing action callbacks and busy states.

3. Refine Skill Library default list.
   - Remove required-tools and approval-profile columns from the default table.
   - Keep those facts in `SkillCompactInspector`.
   - Keep search, filters, sort, archive, and details actions unchanged.

4. Make Source sync and review evidence summary-first.
   - Hide diff, checksum, context findings, semantic details, and warning evidence
     behind per-record details.
   - Keep selection checkboxes, preview, refresh, check updates, and publish selected
     workflows unchanged.

5. Update copy, CSS, and tests.
   - Add productized i18n keys for summaries and details labels.
   - Add focused Settings diagnostic-density CSS without broad restyling.
   - Update `settings.spec.ts` and `dark-mode.spec.ts`.

## Test Plan

- `git diff --check`
- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts dark-mode.spec.ts`
- Optional regression: `corepack pnpm --filter @ling-stack/web test:e2e -- model-workbench.spec.ts`

## Acceptance Checklist

- [x] P8 docs are linked from Settings visual-density docs.
- [x] Plugin Manager default rows hide raw diagnostic facts.
- [x] Plugin detail inspector keeps all secondary actions reachable.
- [x] Skill Library list columns are reduced and desktop-safe.
- [x] Source sync raw preview evidence is collapsed by default.
- [x] Settings and dark-mode e2e pass.

## Evidence

- Added `plugin-manager-view-models.ts` so plugin status/readiness, primary
  action, secondary actions, raw facts, and diagnostics are derived outside the
  Settings panel.
- Refactored Plugin Manager rows to show title, status/source, readiness, and
  one primary action by default. Raw plugin id, version, package hash, linked
  resources, runtime preview facts, contributions, and low-frequency actions now
  live behind `Details and diagnostics`.
- Extracted `SkillLibraryTable.tsx` and reduced the default skill list to
  status, skill, source, stage, bound teammates, and actions. Required tools,
  approval profile, raw/source details, prompt fragments, and checksums remain
  in the existing inspector.
- Changed Source sync records so checksum, drift diff, context findings,
  semantic diff, and warning evidence are behind per-record `Source evidence`
  details.
- Added focused `settings-diagnostics.css` and imported it from `styles.css`
  instead of expanding the broad Settings stylesheet.
- Verification:
  - `git diff --check`
  - `corepack pnpm --filter @ling-stack/web check:i18n`
  - `corepack pnpm --filter @ling-stack/web typecheck`
  - `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts dark-mode.spec.ts` (16 passed)
