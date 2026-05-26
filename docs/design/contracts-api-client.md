# Contracts and API Client

## Purpose

This document records the first shared contracts and API client extraction plan.

The Web UI currently owns daemon DTOs in `apps/web/src/types.ts` and daemon fetch logic in
`apps/web/src/api.ts`. That works for one client, but Web, CLI, future desktop, future
mobile/PWA, and GitHub automation UI should not each copy daemon wire shapes.

The first slice is a non-breaking extraction. It should not redesign the daemon API.

## Goals

- Add shared daemon DTOs and status enums.
- Add one reusable daemon API client.
- Keep Web form state out of shared contracts.
- Keep daemon routes and response shapes unchanged.
- Let Web migrate to the shared API client first.
- Avoid forcing daemon internals to depend on contracts until the wire shape is stable.

## Target Packages

```text
packages/contracts/
  src/
    approvals.ts
    artifacts.ts
    channels.ts
    daemon.ts
    index.ts
    media.ts
    providers.ts
    runs.ts
    state-transitions.ts
    tasks.ts

packages/api-client/
  src/
    client.ts
    errors.ts
    index.ts
    request-builders.ts
```

## Contract Ownership

Contracts should include daemon wire types:

- health response,
- run/session/event/artifact DTOs,
- channel/task DTOs,
- provider preset/template/check DTOs,
- approval and approval policy DTOs,
- media job DTOs,
- state transition and resource lease DTOs,
- request payload types for daemon CRUD/mutation calls.

Contracts should not include Web-only UI state:

- `ProviderFormState`,
- `ChannelFormState`,
- `TaskFormState`,
- `TaskEditFormState`,
- `MediaJobFormState`,
- view ids,
- wizard state,
- local teammate drafts,
- UI filters and display-only grouping types.

## API Client Shape

Expose one class:

```ts
export interface LingDaemonClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class LingDaemonClient {
  constructor(options?: LingDaemonClientOptions);

  getHealth(): Promise<DaemonHealthResponse>;
  listRuns(cwd: string, limit?: number): Promise<RunListResponse>;
  getRun(runId: string, cwd?: string): Promise<RunSession>;
  getRunEvents(runId: string, cwd?: string): Promise<RunEventsResponse>;
  listRunArtifacts(runId: string, cwd?: string): Promise<RunArtifactListResponse>;
  cancelRun(cwd: string, runId: string): Promise<RunCancelResponse>;

  listChannels(cwd: string): Promise<ChannelListResponse>;
  createChannel(cwd: string, input: CreateChannelRequest): Promise<ChannelMutationResponse>;
  updateChannel(cwd: string, channelId: string, input: UpdateChannelRequest): Promise<ChannelMutationResponse>;
  deleteChannel(cwd: string, channelId: string): Promise<void>;

  listTasks(cwd: string, options?: ListTasksRequest): Promise<TaskListResponse>;
  createTask(cwd: string, input: CreateTaskRequest): Promise<TaskMutationResponse>;
  updateTask(cwd: string, taskId: string, input: UpdateTaskRequest): Promise<TaskMutationResponse>;
  deleteTask(cwd: string, taskId: string): Promise<void>;

  listProviders(cwd: string): Promise<ProviderListResponse>;
  listProviderTemplates(): Promise<ProviderTemplateListResponse>;
  createProvider(cwd: string, input: CreateProviderRequest): Promise<ProviderMutationResponse>;
  updateProvider(cwd: string, providerId: string, input: UpdateProviderRequest): Promise<ProviderMutationResponse>;
  deleteProvider(cwd: string, providerId: string): Promise<void>;
  checkProvider(cwd: string, providerId: string): Promise<ProviderCheckResult>;

  listApprovals(cwd: string, options?: ListApprovalsRequest): Promise<ApprovalListResponse>;
  approveApproval(cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse>;
  denyApproval(cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse>;

  getApprovalPolicy(cwd: string): Promise<ApprovalPolicyResponse>;
  updateApprovalPolicy(cwd: string, input: UpdateApprovalPolicyRequest): Promise<ApprovalPolicyResponse>;

  listMediaJobs(cwd: string, limit?: number): Promise<MediaJobListResponse>;
  createMediaJob(cwd: string, input: CreateMediaJobRequest): Promise<MediaJobMutationResponse>;
  runMediaJob(cwd: string, mediaJobId: string): Promise<MediaJobMutationResponse>;
  listMediaJobArtifacts(mediaJobId: string, cwd?: string): Promise<MediaJobArtifactListResponse>;

  listStateTransitions(cwd: string, options?: ListStateTransitionsRequest): Promise<StateTransitionListResponse>;
  listResourceLeases(cwd: string, options?: ListResourceLeasesRequest): Promise<ResourceLeaseListResponse>;

  artifactContentUrl(artifactId: string, cwd?: string): string;
}
```

The client should preserve the current Web behavior:

- `cwd` remains a query parameter.
- error bodies prefer `message`, then `error`, then HTTP status text.
- `.ling-stack` path errors keep the friendly workspace-path guidance.
- artifact URLs preserve the optional `cwd`.
- POST `/runs` streaming remains separate because it uses SSE over `fetch()` response
  bodies.

## Migration Order

1. Add `packages/contracts` with types copied from Web and aligned to core public types.
2. Add `packages/api-client` with tests using mocked `fetch`.
3. Convert `apps/web/src/api.ts` into a thin wrapper around `LingDaemonClient`.
4. Convert Web imports to use shared contracts for daemon DTOs.
5. Keep Web form state in Web.
6. Later, migrate daemon route handlers to explicitly return contract types.

## Implementation Status

- `packages/contracts` now owns daemon DTOs, status unions, shared primitive unions, and
  request payload types for channels, tasks, providers, approvals, media jobs, state
  transitions, resource leases, and secret status.
- `packages/api-client` now exports `LingDaemonClient`, `LingDaemonError`, and
  `daemonBaseUrlFromEnv`. The client preserves the existing daemon routes, query
  parameters, friendly workspace-path error, artifact URL behavior, and
  `/secrets/status` read API.
- `apps/web/src/types.ts` is a compatibility layer: daemon wire types are re-exported
  from `@ling-stack/contracts`, while Web-only form state remains local.
- `apps/web/src/api.ts` is now a thin wrapper around `LingDaemonClient`; run request
  builders and SSE streaming remain Web-local for this slice.
- Daemon route handlers intentionally do not import contracts yet.

## Non-Goals

- No daemon route redesign.
- No runtime schema validation dependency in this slice.
- No OpenAPI generator.
- No forced daemon-to-contract dependency in the first slice.
- No desktop implementation.

## Test Plan

```bash
corepack pnpm --filter @ling-stack/contracts build
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web build
corepack pnpm --filter @ling-stack/web exec playwright test
corepack pnpm typecheck
git diff --check
```

API client tests should cover:

- URL/query construction for `cwd`, `limit`, `runId`, `mediaJobId`, transition filters,
  and lease filters.
- POST/PATCH bodies for channels, tasks, providers, approval policy, and media jobs.
- `approve` and `deny` request bodies.
- `artifactContentUrl`.
- friendly error mapping.

## Assumptions

- Contracts are compile-time TypeScript contracts first.
- Runtime validation can be added later if daemon/client drift becomes a real problem.
- Web is the first consumer; CLI and desktop can migrate after the package is stable.
