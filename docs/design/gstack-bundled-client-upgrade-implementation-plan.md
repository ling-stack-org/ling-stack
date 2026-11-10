# Bundled GStack Client Implementation Plan

Status: source implementation ready for independent PR; package and installed-client acceptance deferred
Owner: Skills and Desktop maintainers
Last verified: 2026-10-17 against Main `cd7d9d83`
Document type: active protected implementation plan
Code and test anchors: `packages/core/test/bundled-skill-source.test.mjs`, `packages/daemon/test/packaged-gstack-runtime.test.mjs`, `scripts/gstack/testsavant-integration.test.mjs`

## Goal

Deliver the [bundled client contract](gstack-bundled-client-upgrade.md) for
GStack `1.91.101.0`, all 57 skills, original TestSavant, the package-owned browser,
and exact resource-version binding. Keep conversation answer/recovery UI and final
desktop packaging outside this PR.

## Current Baseline

- Ling Main: `cd7d9d83bf3b13ac3b8b68c99f343e51a01a6e56`.
- GStack: `47d639abffa882b8cbb641d7d1dedf08ecada9ec` / `1.91.101.0`.
- TestSavant: `5bfc06f0b54950e6653f253eb7df1e3c9811b5cb`.
- Working branch: `gansx/gstack-bundled-upgrade`.
- Preserved follow-up branch: `gansx/gstack-bundled-refresh` at `b9cfa71b`.

## PR Scope

### 1. Managed Resource Construction

- Pin and render the upstream source without reading global skill installs.
- Inventory all 57 skill bodies, references, scripts, assets, commands, and
  dependency closure.
- Build portable Node, native, Bun CLI, PDF, diagram, CSO, and browser resources
  under the external managed workspace.
- Enforce one heavy writer, external temp/cache paths, logical byte limits, free
  space admission, and at most two successful generations.
- Preserve provenance, licenses, notices, hashes, and deterministic output checks.

### 2. Original TestSavant

- Acquire only the pinned TestSavant files with exact size and SHA-256 checks.
- Build the packaged worker and GStack client adapter without first-run download.
- Verify local inference, bounded token windows, offline guards, malformed output,
  timeouts, cancellation, process cleanup, and circuit breaking.
- Record bilingual quality observations without changing thresholds or blocking
  bundle inclusion. Do not include Wolf candidate code.

### 3. Source Registry And Upgrade Lifecycle

- Publish all missing bundled sources atomically before exposing them.
- Keep custom skills, drafts, archive/disabled state, and teammate bindings.
- Implement follow, pin, resume-following, and rollback with stale-selection
  protection.
- Add the `bundle_update_mode` SQLite migration, selects, mappers, and transaction
  APIs.

### 4. Frozen Runtime Binding

- Bind new packaged runs to manifest, upstream, adaptation, and source checksums.
- Validate serialized bindings before restoring prepared inputs.
- Restore retained generations for resumed tasks and fail closed when unavailable.
- Inject package-owned GStack, browser, Node, TestSavant, and isolated state paths
  into raw command execution, with a second check at launch.
- Describe the existing native question tool only for eligible GStack/Pi runs.

### 5. Desktop Build Wiring

- Read one immutable build selection from `.ling-stack/build`.
- Include GStack and browser trees with `extraResources`.
- Embed the exact bundle identity in the packaged daemon source build.
- Verify copied and original resources after pack/sign phases.
- Keep package generation and release outside this PR.

## Explicit Exclusions

- Authenticated answer submission, recovery UI, shared composer/timeline changes,
  and delegation UI.
- The answer/recovery implementation preserved in `b9cfa71b`.
- Wolf or another classifier replacement.
- Claude engine/SDK installation, account access, paid calls, or credentials.
- Mac/Windows `.app`, DMG, ZIP, NSIS, release upload, or remote merge.
- User global GStack, Codex, Claude Code, hooks, or browser state changes.

## Verification Order

1. Build `@ling-stack/core` and `@ling-stack/daemon` from the PR branch.
2. Run focused Core source, publication, migration, and rollback tests.
3. Run focused Daemon startup, registry, source context, runtime binding, and
   publication tests.
4. Run TestSavant model, runtime, response, quality-observation, and offline tests.
5. Run browser source/launch and Desktop packaged-resource source tests.
6. Run retained external-bundle integration checks through
   `pnpm gstack:managed`; do not create another full resource generation.
7. Run `pnpm check:docs`, `pnpm check:public`, and `git diff --check`.
8. Review the final diff for excluded UI/recovery and Wolf files.
9. Commit, push, and open one independent PR. Do not merge without a separate
   user instruction.

## Release Follow-Up

After the source PR lands, package acceptance proceeds separately:

1. Generate Mac and Windows packages from the same authenticated bundle identity.
2. Verify clean install/upgrade/rollback and simulated offline first launch.
3. Verify no-system-Node operation, damaged resources, timeouts, and exit cleanup.
4. Execute the 57 real workflow rows in the
   [acceptance matrix](gstack-bundled-client-acceptance-matrix.md).

Model quality observations remain visible but are not a package-build blocker.
Final release claims must still distinguish component availability from detection
quality and real workflow acceptance.

## UI Follow-Up

PR #553 owns the shared conversation timeline, composer submission receipts,
stop/recovery behavior, approvals, questions, and normal/private/channel surfaces.
The preserved answer/recovery work overlaps those modules and must be rebased and
redesigned on top of #553. It must extend the existing single decision owner and
timeline, not introduce a second answer surface. This follow-up starts only after
the independent GStack PR is complete.
