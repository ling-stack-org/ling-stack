# Settings Archived Items Permanent Delete P14 Implementation Plan

## Related Docs

- [Settings Archived Items Permanent Delete P14](settings-archived-items-permanent-delete.md)
- [Settings Archived Items Category Tabs P14.2](settings-archived-items-category-tabs-p14.2.md)
- [Settings Full Surface Productization P10](settings-full-surface-productization-p10.md)

## Summary

Implement Settings-only permanent deletion for archived conversations and AI teammates.
Keep existing channel and branch deletion unchanged, preserve historical conversation
runs, and reuse the existing teammate hard-delete path.

## Implementation Steps

1. Generalize the retention tombstone entity type for AI teammates and conversation
   threads, and add typed thread hard-delete request/response contracts.
2. Add a focused SQLite Ling thread cleanup store that collects attachment paths and
   counts, writes the tombstone, clears run references, deletes non-cascading goals/plans,
   and deletes the archived conversation transactionally.
3. Add `POST /threads/:threadId/hard-delete` with archived, conversation-kind,
   active-work, and automation-target guards. Remove attachment files after commit.
4. Add API client/Web wrappers and extend the archived Settings controller with
   conversation and teammate delete actions.
5. Add icon-only Delete actions and product confirmation copy to conversation and
   teammate rows. Keep channel and branch rows unchanged.
6. Update mock daemon behavior, i18n, core/API/daemon tests, and Settings E2E coverage.

## API And Types

- Add `HardDeleteLingThreadRequest` with an optional reason.
- Add `HardDeleteLingThreadResponse` containing the retention tombstone.
- Add `hardDeleteLingThread` to the API client, Web API wrapper, and `RunStore`.
- Extend retention tombstone entity type to `ai-teammate | conversation-thread`.
- No database schema migration or new Settings route.

## Test Plan

- `git diff --check`
- Web i18n and typecheck.
- Contracts, API client, core, and daemon typecheck/tests.
- Web E2E: `settings.spec.ts app.spec.ts channel-archive.spec.ts dark-mode.spec.ts`.
- Browser acceptance at `1440x960` and `1280x800` in light and dark themes.

## Implementation Constraints

- Preserve current unrelated Skill Library, permissions, tests, styles, and design-doc
  work in the dirty worktree.
- Put cleanup logic in a focused store instead of expanding `ling-thread-store.ts`.
- Keep sidebar archive non-destructive.
- Stop if correct deletion requires removing historical runs or changing the Settings IA.

## Implementation Evidence

- Added typed `POST /threads/:threadId/hard-delete` support across contracts, API client,
  Web API, daemon routing, and `RunStore`.
- Added the focused SQLite thread cleanup store and verified transactional content
  cleanup, run unlinking, child-thread detachment, tombstone counts, and attachment path
  collection.
- Added daemon coverage for physical attachment deletion, active run/turn guards,
  non-archived and non-conversation guards, enabled automation blocking, and archived
  automation release.
- Added Settings coverage for all four Delete actions, confirmation cancellation,
  conversation and teammate success, row loading, inline product error recovery, list
  scrolling, action alignment, and `1280x800` overflow.
- Added dark-theme archived-item coverage at `1280x800`; the standard Settings suite
  continues to run at `1440x960`.

Validation completed:

- `git diff --check`
- `corepack pnpm --filter @ling-stack/contracts typecheck`
- `corepack pnpm --filter @ling-stack/api-client test` (37 passed)
- `corepack pnpm --filter @ling-stack/core test` (276 passed)
- `corepack pnpm --filter @ling-stack/daemon test` (492 passed)
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/web check:i18n`
- Playwright regression: Settings, App shell, channel archive, and dark mode; 34 tests
  passed in the combined run, followed by 2 dark-mode tests after updating the existing
  Skill Library selector to its current ownership-separated UI.
