# P3 main integration: browser declaration boundary repair

Date: 2026-10-24. Scope: source-only repair in the E6 worktree; no permission/configuration change, database operation, commit, or index update.

## Confirmed cause

The combined Web build failed with TS2591 at `packages/core/dist/storage/sqlite/store-context.d.ts`: the browser tsconfig deliberately does not include Node globals/types.

A targeted `tsc -p apps/web/tsconfig.json --noEmit` reproduced exactly that error with actual exit code 1. `--explainFiles` established the dependency chain:

`core/index.d.ts` → `storage/sqlite-run-store.d.ts` → `delegation-host-store-bridge.d.ts` → concrete delegation/suspension SQLite Store declarations → `store-context.d.ts` → `node:sqlite`.

`work-summary-store.ts` was not in this Web declaration dependency graph and was not changed. Adding Node types to the browser would conceal, rather than fix, this Host declaration leak.

## Minimal repair

- Added `packages/core/src/delegation-host-store-binding-types.ts`, containing only the opaque `DelegationHostStoreBinding` interface and its unexported declared `unique symbol` brand.
- `delegation-host-store-bridge.ts` imports and re-exports that exact type. Existing consumers importing the type from the old bridge path still receive the same current declaration identity; this is not a second structurally interchangeable brand.
- `storage/sqlite-run-store.ts` imports the public options type from the pure module, separately from the runtime `captureDelegationHostStoreBinding` import. Its generated declaration can now name the opaque type without loading the concrete Host writer/store graph.

The brand remains type-only. Real authority remains the bridge's existing WeakMap registration, owner checks, capture/install rules, and retirement. No writer accessor, database reference, runtime constructor argument, permission mode, or authorization check changed. The old bridge exports and runtime paths remain available.

## Verification state

`git diff --check` for the three source files passed (actual exit code 0). Source reviewed to confirm that no WeakMap/owner/writer implementation lines changed.

After-repair Core declaration generation and Web typecheck are intentionally delegated to the main agent's serial build lane. No parallel build or `dist` write was started by this subtask. Do not interpret this report as claiming that the rebuilt Web typecheck or packaged QA has passed.

Source SHA-256 at handoff:

| Source | SHA-256 |
| --- | --- |
| `delegation-host-store-binding-types.ts` | `df82edd51005b8f7edb263cca16eb86af42a45f8084b5ee0b6459272f7345dbb` |
| `delegation-host-store-bridge.ts` | `eb4cee8804af907ffe72caa658c4ebf29fd25aa4bd311aeeea6a07e18de93570` |
| `storage/sqlite-run-store.ts` | `1e36bb717a8df454bab8352fd587cb7c606fa35f2e9459a5f2b91339e133f913` |

The last file also contains main-integration changes outside this subtask; its hash freezes the combined file, not merely these two import lines.
