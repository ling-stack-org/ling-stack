# External Work Phase 8.0 Adapter Registry Implementation Plan

## Summary

Phase 8.0 turns the current external-work source adapter shape into an explicit
registry. This is a refactor phase with no new provider and no behavior change.

The current code already has the beginning of the right abstraction:

- `ExternalWorkSourceAdapter` exists in `packages/core/src/external-work-types.ts`.
- `createGitHubExternalWorkAdapter` and `createLinearExternalWorkAdapter` exist in
  `packages/core/src/external-work-scheduler.ts`.
- GitHub and Linear read-only polling already normalize into shared
  `ExternalWorkItem` records.

The problem is that routing is still hard-coded around GitHub and Linear in poll,
import, reconcile, daemon routes, token resolution, and source key construction. Phase
8.0 promotes the existing adapter shape into a registry so GitLab, Gitea/Forgejo, and
Bitbucket can be added later without copying another provider-specific branch through
the scheduler.

Target flow:

```text
WORKFLOW.md
-> parse source config
-> resolve adapter registration by source.kind
-> resolve source target and secret purpose
-> load or normalize provider work items
-> existing processCandidate scheduler path
-> existing workflow, artifact, lease, and workspace records
```

## Required Baseline

Phase 8.0 assumes these capabilities already exist:

- GitHub PR/issue import, poll, reconcile, CI triage, and approved actions.
- Linear issue import and poll.
- Shared scheduler state, subject/source leases, workspace allocation, hook evidence,
  and external-work list/detail views.
- Secret refs through `env:` and `keychain:`.
- `WORKFLOW.md` validation for `source.kind`, `source.repository`, and
  `source.projectSlug`.

Still enforced:

- No new source kinds in Phase 8.0.
- No source behavior change for GitHub or Linear.
- No route removal or CLI breaking change.
- No new external mutation path.
- No automatic network call from status or setup endpoints.

## Goals

- Move GitHub and Linear source routing behind a first-class registry.
- Keep existing GitHub and Linear daemon, SDK, and CLI surfaces working.
- Replace duplicated poll plumbing with a source-agnostic core poll function.
- Make source target resolution explicit instead of overloading `repository` for Linear.
- Centralize source key construction for leases and scheduler state.
- Centralize source secret purpose mapping.
- Keep remote terminal reconciliation capability optional per adapter.
- Prepare the codebase for GitLab read-only support without touching scheduler state
  machines.

## Non-Goals

- No GitLab, Gitea/Forgejo, or Bitbucket source kind yet.
- No generic `/external-work/:source/poll` public endpoint yet.
- No generic action executor.
- No webhook receiver.
- No background scheduler generalization beyond avoiding new coupling.
- No SQLite schema migration.
- No Web Settings UI redesign.

## Current Implementation Gaps

The current adapter shape is useful but not yet the platform boundary:

- `pollGitHubExternalWork` and `pollLinearExternalWork` duplicate source leases,
  candidate loading, response initialization, and candidate processing.
- `reconcileExternalWork` only creates a GitHub adapter when
  `workflowDefinition.config.source.kind === "github"`.
- Daemon import handlers duplicate GitHub and Linear workflow parsing, source checks,
  normalization, rendering, workflow creation, and artifact creation.
- Token resolution lives in daemon source-specific branches.
- `ExternalWorkLoadCandidatesInput.repository` is used for both GitHub repository names
  and Linear project slugs.
- Source key construction is in each poll function, such as `github:owner/repo` and
  `linear:projectSlug`.
- The existing adapter does not declare whether `getWorkItem` is meaningful for remote
  terminal reconciliation.

Phase 8.0 should tighten these seams without changing output shapes.

## Adapter Registration Model

Add an internal registry that maps `ExternalSourceKind` to source behavior.

```ts
export interface ExternalSourceRegistration {
  readonly kind: ExternalSourceKind;
  readonly displayName: string;
  readonly workItemKinds: readonly ExternalWorkItemKind[];
  readonly secretPurpose?: ExternalSecretPurpose;
  readonly supportsRemoteTerminalReconcile: boolean;

  resolveTarget(config: ExternalWorkflowSourceConfig): ExternalSourceTarget;
  sourceKey(target: ExternalSourceTarget): string;
  createAdapter(options: ExternalSourceAdapterOptions): ExternalWorkSourceAdapter;
  normalizeImport(input: ExternalSourceImportInput): ExternalWorkItem;
}
```

Supporting types:

```ts
export type ExternalSecretPurpose = "github_token" | "linear_token";

export interface ExternalSourceTarget {
  readonly kind: ExternalSourceKind;
  readonly id: string;
  readonly label: string;
}

export interface ExternalSourceAdapterOptions {
  readonly fetch?: typeof globalThis.fetch;
}

export interface ExternalSourceImportInput {
  readonly eventType: string;
  readonly payload: unknown;
  readonly workflowDefinition: ExternalWorkflowDefinition;
}
```

Initial registrations:

- `github`
  - target id: `source.repository`
  - secret purpose: `github_token`
  - work item kinds: `github_pull_request`, `github_issue`
  - remote terminal reconcile: true
- `linear`
  - target id: `source.projectSlug`
  - secret purpose: `linear_token`
  - work item kinds: `linear_issue`
  - remote terminal reconcile: false in this phase

The registry should be internal to core at first. Public SDK and daemon API shapes can
stay source-specific until multi-forge read-only support needs a generic surface.

## Type Changes

Keep source kinds unchanged:

```ts
export type ExternalSourceKind = "github" | "linear";
```

Refine candidate loading input so it no longer calls every target a repository:

```ts
export interface ExternalWorkLoadCandidatesInput {
  readonly target: ExternalSourceTarget;
  readonly events: readonly string[];
  readonly activeStates: readonly string[];
  readonly token?: string;
  readonly limit?: number;
}
```

If the implementation wants less churn, it can temporarily support both:

```ts
readonly target?: ExternalSourceTarget;
readonly repository?: string;
```

The compatibility field should be removed before adding GitLab. The point of Phase 8.0
is to stop leaking provider-specific target names into generic scheduler code.

`ExternalWorkGetItemInput` should also move from `repository` to `target`:

```ts
export interface ExternalWorkGetItemInput {
  readonly target: ExternalSourceTarget;
  readonly kind: ExternalWorkItemKind;
  readonly number: number;
  readonly token?: string;
}
```

GitHub can continue to parse the numeric identifier from `externalWork.identifier`.
Linear should keep returning `undefined` for `getWorkItem`.

## Poll Refactor

Add a generic poll function:

```ts
export async function pollExternalWork(input: ExternalWorkPollInput): Promise<ExternalWorkPollResponse>
```

Input:

```ts
export interface ExternalWorkPollInput {
  readonly store: RunStore;
  readonly cwd: string;
  readonly channelId: string;
  readonly workflowDefinition: ExternalWorkflowDefinition;
  readonly workflowDirectory: string;
  readonly token?: string;
  readonly fetch?: FetchLike;
  readonly limit?: number;
  readonly executeHooks?: boolean;
  readonly now?: string;
}
```

Algorithm:

1. Resolve registration from `workflowDefinition.config.source.kind`.
2. Resolve target from the workflow source config.
3. Build `sourceKey` from the registration.
4. Acquire the `external_source` lease with the same TTL as today.
5. Create the registered adapter.
6. Call `adapter.loadCandidates({ target, events, activeStates, token, limit })`.
7. Reuse `processCandidate` unchanged.
8. Release source leases in `finally`.

Keep wrappers for compatibility:

```ts
export async function pollGitHubExternalWork(input: ExternalWorkPollGitHubInput) {
  assertSourceKind(input.workflowDefinition, "github");
  return pollExternalWork({ ...input, token: input.githubToken });
}

export async function pollLinearExternalWork(input: ExternalWorkPollLinearInput) {
  assertSourceKind(input.workflowDefinition, "linear");
  return pollExternalWork({ ...input, token: input.linearToken });
}
```

The wrappers should remain until daemon, SDK, CLI, tests, and docs can move to a
generic source-aware API in a later phase.

## Import Refactor

Phase 8.0 can reduce import duplication without changing routes.

Add a shared helper in daemon external-work imports:

```ts
async function importExternalWorkFromPayload(input: {
  readonly store: RunStore;
  readonly channelId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly workflowMarkdown: string;
  readonly expectedSourceKind: ExternalSourceKind;
}): Promise<ExternalWorkImportResponse>
```

Algorithm:

1. Parse the workflow.
2. Assert the source kind matches the route.
3. Resolve the source registration.
4. Call `registration.normalizeImport({ eventType, payload, workflowDefinition })`.
5. Render the workflow prompt.
6. Reuse `store.createOrReuseExternalWorkWorkflow`.
7. Reuse evidence artifact creation.

This preserves:

- `POST /external-work/github/import`
- `POST /external-work/linear/import`
- existing SDK methods
- existing CLI commands

The only expected diff should be less duplicated handler code.

## Reconcile Refactor

`reconcileExternalWork` should stop hard-coding GitHub. It should ask the registry
whether the current source supports remote terminal checks.

Algorithm:

1. Expire local leases as today.
2. Load scheduler states as today.
3. If `workflowDefinition` exists, resolve registration and target.
4. If `registration.supportsRemoteTerminalReconcile` is true, create the adapter.
5. For each active state, run the existing local workflow/step terminal checks.
6. For remote checks, call `adapter.getWorkItem({ target, kind, number, token })`.
7. Mark terminal when the remote item exists and its state matches terminal states.
8. If the adapter returns `undefined`, keep the current local reconcile behavior.

GitHub behavior should remain unchanged. Linear should still skip remote terminal
reconcile.

## Secret Resolution

Move source-kind-to-purpose mapping into a shared helper:

```ts
export function externalWorkSecretPurposeForSource(kind: ExternalSourceKind):
  | "github_token"
  | "linear_token"
  | undefined
```

Phase 8.0 may keep the current `resolveExternalGitHubToken` and
`resolveExternalSourceToken` exports, but internal call sites should use the registry
metadata where possible.

Rules:

- Missing optional `secretRef` remains allowed for public GitHub reads.
- Linear read-only poll still requires a configured token when a workflow includes a
  `secretRef`.
- Secret status endpoints must continue to return status only.
- No raw token value is added to responses, artifacts, or logs.

## Affected Files

Likely core files:

- `packages/core/src/external-work-types.ts`
- `packages/core/src/external-work.ts`
- `packages/core/src/external-work-scheduler.ts`
- `packages/core/test/external-work.test.mjs`

Likely daemon files:

- `packages/daemon/src/features/external-work/imports.ts`
- `packages/daemon/src/features/external-work/sync.ts`
- `packages/daemon/src/features/external-work/workflow.ts`
- `packages/daemon/test/external-work-import.test.mjs`

Likely docs:

- `docs/design/external-work-multi-forge-adapters.md`
- `docs/design/external-work-roadmap.md`
- `docs/daemon-api.md` only if public response wording changes

Avoid touching:

- SQLite schema
- action execution
- CI triage
- background scheduler public API
- Web UI

## Implementation Slices

### Slice 1: Registry Types and Current Providers

- Add source registration types.
- Register GitHub and Linear.
- Add source target resolution helpers.
- Add source key helpers.
- Keep existing exported adapter factory functions.

Validation:

- Unit tests for GitHub target/source key.
- Unit tests for Linear target/source key.
- Unsupported source kind still fails with the existing readable message.

### Slice 2: Generic Poll Core

- Add `pollExternalWork`.
- Re-implement `pollGitHubExternalWork` and `pollLinearExternalWork` as wrappers.
- Keep response counts and result messages unchanged.

Validation:

- Existing GitHub poll tests pass.
- Existing Linear poll tests pass.
- Snapshot-sensitive tests should compare semantic fields, not function names.

### Slice 3: Import Helper

- Add shared daemon import helper.
- Route GitHub and Linear import handlers through it.
- Keep endpoint URLs and response status codes unchanged.

Validation:

- GitHub fixture import still returns 201 for new work and 200 for duplicates.
- Linear fixture import still returns 201 for new work and 200 for duplicates.

### Slice 4: Registry-Based Reconcile

- Replace GitHub-only adapter creation with registry lookup.
- Preserve GitHub terminal remote check.
- Keep Linear remote check skipped.

Validation:

- Existing GitHub terminal reconcile tests pass.
- Linear reconcile remains local-only.

## Testing Strategy

Core:

- `ExternalSourceRegistry` resolves GitHub and Linear registrations.
- GitHub target requires `source.repository`.
- Linear target requires `source.projectSlug`.
- Source keys remain `github:owner/repo` and `linear:projectSlug`.
- Generic poll produces the same counts as source-specific wrappers.
- `processCandidate` does not need provider-specific branching.

Daemon:

- GitHub import route still rejects a Linear workflow.
- Linear import route still rejects a GitHub workflow.
- Import duplicate behavior remains unchanged.
- Poll routes still resolve the right token purpose.
- Reconcile with a GitHub workflow still calls the GitHub read endpoint.
- Reconcile with a Linear workflow does not call Linear network endpoints for remote
  terminal checks.

Regression:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
```

If daemon tests are too broad during development, run the external-work focused daemon
test file first, then broaden before merge.

## Failure Modes

- Registry misses a source kind that parser accepts.
- Target resolution reports a generic error instead of naming the missing workflow
  field.
- Wrapper functions accidentally change response counts or error messages.
- Reconcile starts making Linear network calls unexpectedly.
- Token purpose mapping regresses and status surfaces show missing token for the wrong
  provider.
- Source key changes create duplicate scheduler state for existing GitHub or Linear
  items.

## Acceptance Criteria

Phase 8.0 is complete when:

- GitHub and Linear are both registered source adapters.
- GitHub and Linear poll wrappers route through a shared generic poll function.
- GitHub and Linear import handlers route through a shared import helper.
- Reconcile uses registry metadata for optional remote terminal checks.
- Existing public daemon, SDK, and CLI surfaces still work.
- Existing GitHub and Linear external-work tests pass without changing expected
  behavior.
- No new provider kind is accepted yet.
