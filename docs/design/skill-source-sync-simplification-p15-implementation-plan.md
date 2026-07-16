# Skill Source Sync Simplification P15 Implementation Plan

## Related Docs

- [Managed Official Skill Source P16](managed-official-skill-source-p16.md)
- [P15 Design](skill-source-sync-simplification-p15.md)
- [Settings Interaction Depth P9](settings-interaction-depth-p9.md)
- [Settings Full-Surface Productization P10](settings-full-surface-productization-p10.md)
- [Skill Capability Model And Library Simplification](skill-capability-model-and-library-simplification.md)

## Module Boundaries

> Superseded for normal source acquisition by
> [Managed Official Skill Source P16](managed-official-skill-source-p16.md). This plan is
> retained only as the historical implementation plan for the original one-action UI.

| Layer | Responsibility |
| --- | --- |
| `packages/core/src/gstack-source-connection.ts` | bounded candidate discovery, official-origin normalization, and checkout validation |
| `packages/core/src/storage/sqlite/*` | workspace-scoped persisted gstack connection |
| `packages/contracts/src/skills.ts` | private connection-state and typed apply-response contracts |
| `packages/daemon/src/features/skills/gstack-source-connection-route.ts` | automatic connection, native-picker binding, and source availability handling |
| `packages/daemon/src/features/skills/routes.ts` | fresh connected-gstack scan, atomic source publish, and result generation |
| `packages/api-client/src/endpoints/skills.ts` | typed `applyGstackSkillSourceSync` client method |
| `apps/web/src/api/skills.ts` | Web API wrapper |
| `skill-source-sync-result-cache.ts` | workspace-scoped, timestamp-validated browser cache for the latest result |
| `SkillLibrarySettingsPanel.tsx` | connection state, local sync request state, result persistence, and result refresh |
| `SkillLibraryWidgets.tsx` | compact connection-aware source-sync surface |
| daemon/API/Web tests | safe write and user-visible interaction regression coverage |

## Steps

1. Add a workspace-scoped official gstack connection.
   - Store repository root, skills root, normalized origin, version, and connection times
     in `gstack_source_connections`; do not return local paths to the Web app.
   - Discover only bounded directory-name candidates and accept a candidate only when it
     is a Git checkout with `.agents/skills` and the `github.com/garrytan/gstack` origin.
   - Connect a unique candidate automatically. For zero or multiple candidates, use the
     existing native directory picker and validate the user-selected repository root.

2. Make `POST /skills/sync/gstack/apply` a trusted connected-gstack import.
   - Rebuild the source preview on every request using only the persisted, revalidated
     official gstack checkout.
   - Publish all parseable new and changed source records with the existing
     snapshot/artifact persistence path.
   - Refuse missing, unreadable, or unparseable source before a partial write.
   - Update `lastCheckedAt` after a complete operation.

3. Preserve compatibility APIs.
   - Do not remove preview, refresh, check-updates, or explicit publish routes.
   - Do not duplicate trusted-source write decisions in the Web app.

4. Replace the Source Sync default UI.
   - Render connection state and one `Sync updates` action. When unconnected, render
     only `Connect gstack`; do not show a path, candidate list, or diagnostic wall.
   - Remove preview controls, selected-record state, check action, refresh, publish,
     root controls, upgrade policy, and standalone source-health disclosure.

5. Render only compact completed-state evidence.
   - Show compact sync totals after an apply result and restore them after a page
     reload when their `completedAt` matches the daemon policy's `lastCheckedAt`.
   - Discard cached results after a newer sync so stale totals are never presented as
     current.
   - Keep a blocking failure in the Settings error state with a concise local-gstack
     reason; do not render a review queue.

6. Align tests and mock daemon behavior.
   - Add direct core and daemon coverage for official-origin validation, unique automatic
     connection, ambiguous/missing candidates, moved connections, no-op syncs, new
     skills, warning-bearing updates, and missing sources.
   - Add typed API-client route coverage.
   - Update Settings E2E to assert one action, no default diagnostics, and bounded
     attention rendering.

## Validation

- `git diff --check`
- `corepack pnpm --filter @ling-stack/web check:i18n`
- `corepack pnpm --filter @ling-stack/web typecheck`
- `corepack pnpm --filter @ling-stack/api-client test`
- `corepack pnpm --filter @ling-stack/daemon test -- skill-source-upgrade-api.test.mjs`
- `corepack pnpm --filter @ling-stack/web test:e2e -- settings.spec.ts dark-mode.spec.ts`

Desktop visual verification uses `1440x960` and `1280x800` in light and dark mode.
The Source Sync page must have no horizontal overflow or default review queue.
