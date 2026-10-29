# Contracts and API Client

## Purpose

This document records the first shared contracts and API client extraction plan.

The Web UI currently owns daemon DTOs in `apps/web/src/types.ts` and daemon fetch logic in
`apps/web/src/api.ts`. That works for one client, but Web, CLI, Desktop, and future
constrained mobile surfaces should not each copy semantic wire shapes.

The first slice is a non-breaking extraction. It should not redesign the daemon API.

## Goals

- Add shared daemon DTOs and status enums.
- Add one reusable daemon API client.
- Keep Web form state out of shared contracts.
- Keep daemon routes and response shapes unchanged.
- Let Web migrate to the shared API client first.
- Keep the broad trusted-local daemon client separate from the device-authenticated Mobile
  Remote Gateway client.
- Avoid forcing daemon internals to depend on contracts until the wire shape is stable.

## Target Packages

```text
packages/contracts/
  src/
    approvals.ts
    artifacts.ts
    channels.ts
    conversation-transcript.ts
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
- MCP server, runtime status snapshot, tool catalog, and teammate binding DTOs,
- approval and approval policy DTOs,
- media job DTOs,
- state transition and resource lease DTOs,
- conversation transcript DTOs for shared Web/Desktop/CLI rendering,
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

## Conversation Transcript Contract

The conversation transcript is not Web-only UI state. It is a shared semantic read model
that lets Web, Desktop, and CLI/TUI clients render the same Ling Agent
conversation without reimplementing intent routing or workflow/run grouping.

Target file:

```text
packages/contracts/src/conversation-transcript.ts
```

The contract should model meaning and lifecycle, not CSS or React components:

```ts
export type ConversationTranscriptSurface = "main" | "expanded" | "raw";

export type ConversationTurnStatus =
  | "open"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "superseded";

export type TranscriptBlockStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "blocked"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TranscriptBlockKind =
  | "user_message"
  | "coordinator_text"
  | "operation_cell"
  | "agent_activity_span"
  | "command_execution"
  | "file_change"
  | "approval"
  | "artifact_strip"
  | "source_summary_strip"
  | "memory_evidence"
  | "raw_detail_ref";

export interface ConversationTranscript {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly turns: readonly ConversationTranscriptTurn[];
  readonly sequence: number;
  readonly generatedAt: string;
}

export interface ConversationTranscriptTurn {
  readonly id: string;
  readonly sourceMessageId: string;
  readonly status: ConversationTurnStatus;
  readonly blocks: readonly TranscriptBlock[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TranscriptBlock =
  | UserMessageBlock
  | CoordinatorTextBlock
  | OperationCellBlock
  | AgentActivitySpanBlock
  | CommandExecutionBlock
  | FileChangeBlock
  | ApprovalBlock
  | ArtifactStripBlock
  | SourceSummaryStripBlock
  | MemoryEvidenceBlock
  | RawDetailRefBlock;

export interface TranscriptBlockBase {
  readonly id: string;
  readonly kind: TranscriptBlockKind;
  readonly status?: TranscriptBlockStatus;
  readonly actorId?: string;
  readonly actorLabel?: string;
  readonly rawDetailRef?: RawDetailRef;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OperationCellBlock extends TranscriptBlockBase {
  readonly kind: "operation_cell";
  readonly operationKind: "plan" | "read" | "edit" | "run_command" | "search" | "approval" | "verify" | "handoff" | "watch";
  readonly displayLabel: string;
  readonly activeLabel?: string;
  readonly terminalLabel?: string;
  readonly summary?: string;
  readonly rows: readonly OperationRowBlock[];
  readonly evidenceRefs: readonly EvidenceRef[];
  readonly sourceRefs?: readonly EvidenceSourceRef[];
}

export interface SourceSummaryStripBlock extends TranscriptBlockBase {
  readonly kind: "source_summary_strip";
  readonly placement: "floating_popover" | "expanded_operation" | "drawer_summary";
  readonly sources: readonly EvidenceSourceRef[];
}

export type EvidenceSourceKind =
  | "tool"
  | "app"
  | "web"
  | "memory"
  | "file"
  | "artifact";

export interface EvidenceSourceRef {
  readonly id: string;
  readonly kind: EvidenceSourceKind;
  readonly label: string;
  readonly icon?: "tool" | "app" | "globe" | "memory" | "file" | "artifact";
  readonly url?: string;
  readonly filePath?: string;
  readonly appId?: string;
  readonly toolServer?: string;
  readonly toolName?: string;
  readonly memoryId?: string;
  readonly artifactId?: string;
  readonly relatedBlockIds: readonly string[];
  readonly rawDetailRef?: RawDetailRef;
}

export interface RawDetailRef {
  readonly type: "message" | "workflow" | "workflow_step" | "run" | "run_event" | "approval" | "artifact" | "agent_span";
  readonly id: string;
}
```

The exact TypeScript names can change during implementation, but these invariants cannot:

- one user turn owns one ordered `blocks[]` stream;
- coordinator text is natural prose, not a required prefix format;
- operation, command, approval, file, and agent blocks have stable ids and mutable status;
- active labels and terminal labels are states of the same block;
- raw workflow/run/work-unit ids stay in `RawDetailRef` or `EvidenceRef`, not default
  display fields;
- source refs are structured evidence. They are derived from tool, web, memory, file, app,
  and artifact records, not parsed from coordinator prose;
- internal helper sources such as `node_repl`, daemon glue, projector helpers, and setup
  wrappers are filtered before they reach default transcript surfaces;
- display/expanded/raw are render modes over the same block data, not separate competing
  models.

### Transcript Delta Events

The trusted local API client should eventually expose a stream helper for the transcript
lifecycle:

```ts
export type ConversationTranscriptEvent =
  | { readonly type: "transcript_snapshot"; readonly transcript: ConversationTranscript; readonly sequence: number }
  | { readonly type: "turn_started"; readonly turnId: string; readonly sequence: number }
  | { readonly type: "block_started"; readonly turnId: string; readonly block: TranscriptBlock; readonly sequence: number }
  | { readonly type: "block_delta"; readonly turnId: string; readonly blockId: string; readonly patch: TranscriptBlockPatch; readonly sequence: number }
  | { readonly type: "block_completed"; readonly turnId: string; readonly blockId: string; readonly status: TranscriptBlockStatus; readonly patch?: TranscriptBlockPatch; readonly sequence: number }
  | { readonly type: "turn_completed"; readonly turnId: string; readonly status: ConversationTurnStatus; readonly sequence: number };
```

`TranscriptBlockPatch` should be a constrained contract patch, not arbitrary JSON Merge
Patch. For example, status, labels, body delta, bounded output rows, evidence refs, and
timestamps are valid patch fields. Provider metadata, raw event payloads, and stdout
chunks that exceed inline limits belong behind raw/detail refs.

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
  getChannelTranscript(cwd: string, channelId: string): Promise<ChannelConversationTranscriptResponse>;
  streamChannelTranscript(cwd: string, channelId: string, options?: ChannelConversationTranscriptStreamOptions): AsyncIterable<ConversationTranscriptEvent>;
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

  listMcpServers(cwd: string): Promise<McpServerListResponse>;
  createMcpServer(cwd: string, input: McpServerMutationRequest): Promise<McpServerMutationResponse>;
  updateMcpServer(cwd: string, serverId: string, input: McpServerMutationRequest): Promise<McpServerMutationResponse>;
  deleteMcpServer(cwd: string, serverId: string): Promise<void>;
  checkMcpServer(cwd: string, serverId: string): Promise<McpServerCheckResponse>;
  getMcpServerStatus(cwd: string, serverId: string): Promise<McpServerStatusResponse>;
  syncMcpServerTools(cwd: string, serverId: string): Promise<McpServerToolSyncResponse>;
  listMcpTools(cwd: string, serverId?: string): Promise<McpToolListResponse>;

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

- `cwd` remains a query parameter for trusted local clients only. The Mobile Remote Gateway
  maps an opaque approved workspace id to a fixed PC-side path and never accepts remote
  `cwd` or filesystem paths.
- error bodies prefer `message`, then `error`, then HTTP status text.
- `.ling-stack` path errors keep the friendly workspace-path guidance.
- artifact URLs preserve the optional `cwd`.
- POST `/runs` streaming remains separate because it uses SSE over `fetch()` response
  bodies.
- Transcript streaming should be exposed as a shared local client helper once the daemon
  provides the endpoint. Web and Desktop must not each parse raw SSE differently.
- Mobile uses `@ling-stack/remote-client` and `@ling-stack/remote-protocol` over the
  allowlisted Remote Gateway; it must not instantiate the broad `LingDaemonClient` against
  a remotely reachable URL.

## Migration Order

1. Add `packages/contracts` with types copied from Web and aligned to core public types.
2. Add `packages/api-client` with tests using mocked `fetch`.
3. Convert `apps/web/src/api.ts` into a thin wrapper around `LingDaemonClient`.
4. Convert Web imports to use shared contracts for daemon DTOs.
5. Keep Web form state in Web.
6. Later, migrate daemon route handlers to explicitly return contract types.

## Implementation Status

- `packages/contracts` now owns daemon DTOs, status unions, shared primitive unions, and
  request payload types for channels, tasks, providers, MCP servers/tools/status
  snapshots, approvals, media jobs, state transitions, resource leases, and secret
  status.
- `packages/api-client` now exports `LingDaemonClient`, `LingDaemonError`, and
  `daemonBaseUrlFromEnv`. The client preserves the existing daemon routes, query
  parameters, friendly workspace-path error, artifact URL behavior, and
  `/secrets/status` read API. MCP helpers intentionally omit the removed raw-secret
  read route and expose `getMcpServerStatus()` instead.
- `apps/web/src/types.ts` is a compatibility layer: daemon wire types are re-exported
  from `@ling-stack/contracts`, while Web-only form state remains local.
- `apps/web/src/api.ts` is now a thin wrapper around `LingDaemonClient`; run request
  builders and SSE streaming remain Web-local for this slice.
- Daemon route handlers intentionally do not import contracts yet.
- Conversation transcript contracts are the next extraction target. The current Web
  projection can remain a prototype, but the stable `ConversationTranscript` wire shape
  belongs in `packages/contracts`.

## Compatibility Boundary

Compatibility code is removed only when the canonical contract has replaced every
production caller and a migration has handled persisted records. The current media jobs
surface meets that bar: `MediaJobsPage` consumes `MediaJobsDomainState` and
`MediaJobsDomainActions` directly, and `MediaJobFormState` emits only structured `input`
fields. The former page-prop bridge and the unmounted JSON `inputText` form path are no
longer part of the Web API boundary.

The following paths remain intentional compatibility boundaries and require a separate
cutover before removal:

- SQLite continuity imports and migrations, which read old tables once and validate the
  canonical v2 topology before dropping those tables.
- `permissionMode`/`permissionPreset` projections alongside
  `authorizationMode`/`workspaceAccessMode`, because existing workspace settings,
  snapshots, and clients still carry both shapes.
- External media protocols such as legacy ComfyUI evidence remain readable because old
  configuration and completed jobs are historical facts. Persisted runner bindings have
  a separate versioned cutover (SQLite migration 177): mutable operational rows are
  canonicalized to `pi`, while immutable Run snapshots retain their original bytes and
  normalize only at the read projection.
- The Web DTO re-export layer in `apps/web/src/types.ts` and legacy browser theme storage,
  until all clients and stored records have completed their versioned migration.

Each future removal must include a versioned data migration or client cutover, a fixture
for the old shape, a canonical-path test, and an explicit check that no production caller
still reaches the compatibility branch.

## Non-Goals

- No daemon route redesign.
- No runtime schema validation dependency in this slice.
- No OpenAPI generator.
- No forced daemon-to-contract dependency in the first slice.
- No Mobile Remote Gateway implementation in this extraction slice.
- No requirement that CLI own or generate conversation transcript state. CLI is a client
  over the shared API.

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
- MCP list/create/update/delete/check/status/sync-tools routes, including redacted
  status snapshots and no `getMcpServerSecret()` helper.
- `approve` and `deny` request bodies.
- `artifactContentUrl`.
- friendly error mapping.
- future transcript snapshot and transcript stream helpers, including reconnect behavior
  and ordered sequence handling.

## Assumptions

- Contracts are compile-time TypeScript contracts first.
- Runtime validation can be added later if daemon/client drift becomes a real problem.
- Web is the first consumer; Desktop and CLI should migrate to the shared transcript
  contract once the package is stable.
