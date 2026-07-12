# Skill Library Ownership Separation Implementation Plan

> Follow-up implementation is governed by [Skill Capability Model And Library Simplification Implementation Plan](skill-capability-model-and-library-simplification-implementation-plan.md). Keep the completed ownership work, but replace the stage/status/permanent-inspector slices.

## Related Docs

- [Skill Library Ownership Separation](skill-library-ownership-separation.md)
- [Ling Skill Import V1](ling-skill-import-v1.md)
- [GStack Skill Source Sync](gstack-skill-source-sync.md)

## Summary

Implement ownership-based Skill Library navigation as a frontend-only change. Reuse the
existing `SkillRegistryEntry.source` and `reviewStatus` fields, preserve all API and
runtime behavior, and reduce the oversized Settings panel by extracting registry view
logic and presentation before adding the new UI.

## Module Boundaries

1. Add `skill-library-view-models.ts`.
   - Own ownership classification, subsection types, filters, counts, search, binding
     filtering, and stable sorting.
   - Remain pure and free of React and API imports.

2. Add `SkillLibraryRegistrySection.tsx`.
   - Own the search/filter/sort toolbar, contextual meta, table, empty state, and inspector
     layout for My skills and Built-in skills.
   - Receive registry data and callbacks through explicit props.
   - Never call daemon APIs directly.

3. Refactor `SkillLibrarySettingsPanel.tsx`.
   - Keep data loading, import, source sync, review, optimization preview, archive, and
     rollback side effects.
   - Replace registry filtering and large registry JSX with the extracted section.
   - Target fewer than 800 lines after the extraction.

4. Extend existing presentation components.
   - `SkillLibraryTable` receives a `user | builtin` variant.
   - `SkillCompactInspector` receives a read-only ownership mode.
   - `SkillSourceInspector` hides source mutation actions in read-only mode.

## State And Data Flow

- `activeSubsection` defaults to `mine` and supports `mine / builtin / review / source`.
- The parent owns `skills`, `selectedSkillId`, source snapshots, artifacts, and async
  state.
- The registry section owns local search, user status filter, built-in binding filter,
  and per-view sort behavior.
- Switching subsection clears `selectedSkillId`; changing filters clears it only when the
  selected row is no longer visible.
- The parent continues loading artifacts and optimization previews for the selected skill.

## UI Changes

- Replace `Skills list` with `My skills` and add `Built-in skills` beside it.
- Use subnav badges for current user skill count, built-in count, review count, and source
  attention count.
- Remove the global built-in/custom filter from the registry toolbar.
- Show Import skill and New draft only in My skills.
- Remove the duplicate header shortcut to Source sync; the tab remains the canonical
  entry.
- Keep the registry body fixed-height with table and inspector internal scrolling.
- Add focused Settings CSS for ownership toolbars, contextual meta, and empty states;
  reuse existing Settings tokens and table styles.

## Interfaces

Frontend-only internal types:

```ts
type SkillLibrarySectionId = "mine" | "builtin" | "review" | "source";
type SkillOwnership = "user" | "builtin";
type UserSkillStatusFilter = "current" | "published" | "draft";
type BuiltinSkillBindingFilter = "all" | "bound" | "unbound";
```

No public contracts, daemon routes, SQLite schema, or registry record shapes change.

## Test Plan

- Add `apps/web/e2e/skill-library-ownership.spec.ts` instead of growing the existing
  large Settings spec further.
- Seed built-in, custom, workspace, skill-directory, agents-md, gstack, disabled, draft,
  and archived records.
- Assert My skills is selected by default and excludes built-ins.
- Assert each non-built-in source appears in My skills.
- Assert current/published/draft filters, updated/name sorting, search, and selection cleanup.
- Assert Built-in skills contains only built-ins, supports bound/unbound filters, and has
  no mutation actions in rows or inspector.
- Assert Review queue, Source sync, Import skill, and New draft remain reachable.
- Run:
  - `corepack pnpm --filter @ling-stack/web typecheck`
  - `corepack pnpm --filter @ling-stack/web run check:i18n`
  - `corepack pnpm --filter @ling-stack/web exec playwright test apps/web/e2e/settings.spec.ts apps/web/e2e/skill-library-ownership.spec.ts`
  - `git diff --check`
- Browser-check 1440x960 and 1280x800 against the active Vite dev server and record the
  verified URL and screenshots.

## Hard Stops

- Stop if built-in enable/disable requires a new persisted workspace override.
- Stop if ownership cannot be derived from the existing source and review status fields.
- Stop if a proposed UI action changes skill binding, runtime selection, approval, or
  source-sync publish semantics.

## Assumptions

- Every non-built-in source belongs to My skills.
- Built-in skills remain read-only.
- Settings entry count and navigation outside Skill Library remain unchanged.
- Existing unrelated model-workbench changes in the dirty worktree are preserved.

## Implementation Status

Completed on 2026-07-11.

- Added the ownership view-model, navigation, registry section, table variants, read-only
  inspector boundary, i18n, and focused ownership regression coverage.
- Reduced `SkillLibrarySettingsPanel.tsx` to 779 lines.
- Preserved the existing `/skills` behavior that excludes disabled and archived registry
  entries. The UI therefore exposes `Current / Published / Draft` instead of dead
  disabled/archive filters; archive remains an action that removes an entry from the
  current registry response.
- Verified Web typecheck, i18n audit, Settings and ownership Playwright coverage, and
  `git diff --check`.
- Browser-verified the active Vite development server at `http://127.0.0.1:5173/` for
  1440x960 and 1280x800. Evidence is stored under
  `.ling-stack/audits/skill-library-ownership-2026-07-11/`.
