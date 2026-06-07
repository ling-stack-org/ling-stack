# Core Tools Runtime Boundary Implementation Plan

## Status

Implementation plan.

This plan implements the boundary defined in
[Core Tools, Runners, MCP Tools, and Plugin Boundary](core-tools-runtime-boundary.md).
The goal is narrow: stop the Plugin Manager from presenting built-in core tools as
plugins, while preserving internal extension metadata for diagnostics and future runtime
snapshots.

## Current Shape

Relevant current facts:

- `createDefaultLingExtensionRegistry()` registers local channel source, Pi runner,
  built-in tools, built-in skill packs, and built-in providers.
- Plugin catalog construction currently starts from `extensionRegistry.list()` and maps
  those extensions into managed plugin descriptors.
- Built-in tools exist as `tool:*` internal extension metadata.
- Approval policy already owns the seven core tools:
  `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write`.
- Pi runner already declares those tools as supported runtime metadata.
- Plugin Manager also includes bundled descriptors and trusted local presets such as
  Cua Driver.

The implementation should keep the useful internal registry metadata, but it should not
project every internal extension into `/plugins`.

## Desired Product Behavior

After this slice:

- Plugin Manager shows product-managed plugin entries only.
- Plugin Manager does not show `Read`, `Grep`, `Find`, `List`, `Bash`, `Edit`, or
  `Write` as plugin cards.
- Approval policy still shows all seven core tools.
- Runtime runner settings can still show runner metadata and supported tools.
- Internal extension diagnostics can still expose `tool:*`, `runner:*`, provider,
  channel-source, and skill-pack metadata through a diagnostic endpoint.

## Slice 1: Filter Plugin Catalog Projection

Scope:

- Update `packages/daemon/src/features/plugins/catalog.ts`.
- Stop treating plain internal extensions as managed plugin descriptors by default.
- Keep bundled descriptors from `listBundledPackageDescriptors()`.
- Keep trusted local preset descriptors from `listTrustedLocalPresetDescriptors()`.
- Keep persisted plugin records so historical state remains readable.

Recommended first implementation:

```ts
function buildDescriptorMap(...): Map<string, ManagedPluginDescriptor> {
  const descriptors = new Map<string, ManagedPluginDescriptor>();

  for (const descriptor of listBundledPackageDescriptors()) {
    descriptors.set(descriptor.id, descriptor);
  }
  for (const descriptor of listTrustedLocalPresetDescriptors()) {
    descriptors.set(descriptor.id, descriptor);
  }
  for (const descriptor of listProductManagedBuiltInPluginDescriptors(extensionRegistry)) {
    descriptors.set(descriptor.id, descriptor);
  }
  for (const record of store.listManagedPlugins({ limit: 500 })) {
    if (!descriptors.has(record.id)) {
      descriptors.set(record.id, record.descriptor);
    }
  }

  return descriptors;
}
```

`listProductManagedBuiltInPluginDescriptors()` can initially return `[]`. Add it as a
named seam so a future built-in product bundle can opt in deliberately without reopening
the "everything in the extension registry is a plugin" mistake.

Do not delete `extensionToManagedPluginDescriptor()` if package install and trusted
preset paths still need descriptor conversion. If it becomes unused after the filter,
either remove it in the same slice or keep a narrower helper for explicitly opted-in
built-ins.

Non-goals:

- Do not remove built-in tool extension metadata.
- Do not remove `LingExtensionRegistry.tools`.
- Do not change approval policy defaults.
- Do not change runner supported-tool metadata.

## Slice 2: Runtime Extension Diagnostics

Scope:

- Add a read-only diagnostic API for internal extension metadata if it does not already
  exist.
- Suggested route: `GET /runtime/extensions?cwd=...`.
- The endpoint reports internal registry metadata only. It is not plugin lifecycle state.

Response shape:

```ts
interface RuntimeExtensionListResponse {
  readonly cwd: string;
  readonly extensions: readonly RuntimeExtensionView[];
}

interface RuntimeExtensionView {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kind:
    | "provider"
    | "runner"
    | "channel-source"
    | "skill-pack"
    | "tool"
    | "memory"
    | "automation";
  readonly trustLevel: "internal" | "internal-isolated";
  readonly capabilities: readonly string[];
  readonly defaultApproval?: "allow" | "ask" | "deny";
  readonly sideEffectLevel?: "none" | "read" | "write" | "write-network" | "external" | "credential" | "deploy";
}
```

Rules:

- No secrets.
- No health checks.
- No install actions.
- No enable or disable actions.
- No linked resource state.
- No runtime process args or raw logs.

This endpoint gives operators and future UI a place to inspect internal capabilities
without polluting Plugin Manager.

## Slice 3: UI Copy and Grouping

Scope:

- Update `apps/web/src/features/settings/PluginManagerSettingsPanel.tsx` if necessary.
- Update settings navigation copy only if the filtered catalog creates confusing empty
  states.
- Keep Approval policy as the only editable home for `allow`, `ask`, and `deny` decisions
  for core tools.
- Keep Runtime runners as the home for runner default/allowed settings.
- Keep MCP tools grouped by MCP server.

Recommended copy:

- Plugin Manager subtitle: `Managed capability bundles and trusted local presets`.
- Empty state: `No managed plugins registered`.
- Runtime extensions diagnostics, if surfaced later: `Internal runtime extensions`.

Do not add per-core-tool cards to Plugin Manager.

## Slice 4: Tests

Backend tests:

- Extend `packages/daemon/test/plugin-manager-api.test.mjs`.
- Assert `/plugins` excludes:
  - `tool:read`,
  - `tool:grep`,
  - `tool:find`,
  - `tool:ls`,
  - `tool:bash`,
  - `tool:edit`,
  - `tool:write`.
- Assert `/plugins` still includes:
  - trusted local Cua Driver preset,
  - bundled Cua Driver package descriptor if bundled packages are available.
- If `/runtime/extensions` lands in the same slice, assert it includes the seven `tool:*`
  entries and `runner:pi`.

Core tests:

- Keep `packages/core/test/builtin-extensions.test.mjs` proving built-in tool extension
  metadata still matches approval policy defaults.

Web tests:

- Extend `apps/web/e2e/settings.spec.ts` or the closest Settings e2e.
- Assert Plugin Manager does not render `Bash`, `Edit`, `Write`, `Read`, `Grep`, `Find`,
  or `List` as plugin rows.
- Assert Approval policy still renders all seven tool decision controls.

## Migration and Compatibility

No data migration is required.

Persisted managed plugin records should remain readable. If an older workspace somehow
has a stored record for a built-in `tool:*` descriptor, the catalog should not resurrect
it as an active product plugin unless the implementation deliberately supports legacy
display. The safer behavior is:

- hide plain built-in `tool:*` records from `/plugins`,
- keep their historical run evidence untouched,
- leave approval policy as the source of truth.

## Validation

Run the narrow checks first:

```bash
corepack pnpm --filter @ling-stack/daemon test -- plugin-manager-api
corepack pnpm --filter @ling-stack/core test -- builtin-extensions
corepack pnpm --filter @ling-stack/web exec playwright test apps/web/e2e/settings.spec.ts
```

Then run broader checks if the implementation touches shared contracts:

```bash
corepack pnpm typecheck
corepack pnpm test
```

## Acceptance Criteria

- `/plugins` is a product plugin catalog, not an internal extension dump.
- `/plugins` excludes the seven core tools.
- Approval policy still includes the seven core tools.
- Runtime extension diagnostics, if implemented, includes internal extensions without
  plugin lifecycle controls.
- Existing Cua Driver plugin manager flows still pass.
- No approval policy, runner registry, MCP broker, or teammate binding semantics change
  as a side effect of this cleanup.
