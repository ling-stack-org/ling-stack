# Managed Official Skill Source P16 Implementation Plan

## Related Docs

- [P16 Design](managed-official-skill-source-p16.md)
- [Skill Source Sync Simplification P15](skill-source-sync-simplification-p15.md)
- [GStack Skill Source Sync](gstack-skill-source-sync.md)
- [Settings Full-Surface Productization P10](settings-full-surface-productization-p10.md)

## Module Boundaries

| Layer | Responsibility |
| --- | --- |
| `packages/core/src/runtime-paths.ts` | Declare the user-global managed-source cache root. |
| `packages/core/src/managed-official-skill-source.ts` | Official source constants, Git cache refresh, identity validation, revision/version resolution, and sanitized state types. |
| `packages/core/src/storage/sqlite/*` | Retire local connection data and persist workspace subscription provenance. |
| `packages/contracts/src/*` | Typed status and apply response without filesystem paths or source-input fields. |
| `packages/daemon/src/features/skills/managed-official-skill-source-route.ts` | Resolve status and bridge a managed checkout into the source scanner. |
| `packages/daemon/src/features/skills/routes.ts` | Keep only the thin apply orchestration; publish the scanned revision atomically. |
| `packages/api-client/src/endpoints/skills.ts` | Typed status and zero-input apply calls. |
| `apps/web/src/api/skills.ts` | Web-facing API adapters. |
| `apps/web/src/features/settings/*` | One-action official-update status and result view. |
| core, daemon, API, and E2E tests | Cache, migration, no-partial-write, and user-visible regression coverage. |

## Steps

1. Define the managed source location and source primitive.
   - Add `sourcesDir` under Ling's user config root, never under a workspace or a user
     checkout.
   - Implement one core service around the immutable official origin and default ref.
   - Inject the Git command runner for unit tests; keep command construction in this
     service rather than route handlers.

2. Refresh the managed checkout safely.
   - Clone into the managed root on first use; fetch and detached-checkout the configured
     ref on later requests.
   - Validate Git root, normalized origin, checked-out revision, and `.agents/skills`
     before returning a scan root.
   - Convert command and filesystem failures to typed, path-free domain errors. Do not
     forward Git stderr to the Web client.

3. Replace the local-connection persistence contract.
   - Add a forward SQLite migration for an `official_skill_source_subscriptions` table
     holding source id, origin, ref, last synced revision, optional version, and
     timestamps per workspace.
   - Retire `gstack_source_connections`; do not migrate repo paths into the new table.
   - Preserve existing registry entries, source snapshots, artifacts, and bindings.

4. Rework source-sync routes and contracts.
   - Add a path-free status endpoint for the stored workspace subscription.
   - Make apply accept no source selection/path configuration and resolve the managed
     checkout directly.
   - Publish all parseable new or changed records through the existing snapshot/artifact
     pipeline and commit subscription provenance only after success.
   - Keep legacy preview/publish routes isolated for compatibility, but remove normal Web
     callers and connection-route registration.

5. Rework the Web flow.
   - Replace connection state with managed-official status.
   - Rename the user-facing panel to `Official skill updates` / `官方技能更新`.
   - Render one `Sync updates` action and the latest compact result; no path, connect,
     local version, candidate list, source count, or diagnostics.
   - Convert operation failures to a persistent, localized result with retry available.

6. Test and validate.
   - Core: first clone, fetch existing cache, wrong origin, missing skills directory,
     revision/version derivation, and no local-root scanning.
   - Daemon: fresh apply writes source provenance, same revision is unchanged, invalid
     cache/network failure leaves registry and subscription unchanged, and no input path
     can alter the official source.
   - API client: status and zero-input apply URLs.
   - E2E: fresh page has one `Sync updates` action and no connect/path copy; successful
     result persists after reload; failure remains visible; `1440x960` and `1280x800`
     light/dark have no horizontal overflow.

## Validation

- `git diff --check`
- `corepack pnpm --filter @ling-stack/core typecheck`
- `corepack pnpm --filter @ling-stack/contracts typecheck`
- `corepack pnpm --filter @ling-stack/api-client test`
- `corepack pnpm --filter @ling-stack/daemon typecheck`
- `corepack pnpm --filter @ling-stack/web typecheck`
- targeted core and daemon source-sync tests
- `corepack pnpm --filter @ling-stack/web exec playwright test apps/web/e2e/skill-library-ownership.spec.ts apps/web/e2e/settings.spec.ts`
- live `127.0.0.1:5173` and daemon source-status verification against the main checkout
