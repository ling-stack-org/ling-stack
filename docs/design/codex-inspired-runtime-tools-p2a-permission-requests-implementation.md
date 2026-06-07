# Codex-Inspired Runtime Tools P2A: Permission Requests Implementation

## Status

Implemented for the first P2A runtime permission request slice.

The shipped first slice adds additive core/contracts types, a core validation and grant
helper, daemon approval-bridge handling, a gated runner-pi `request_permission` meta-tool,
Web/CLI approval summaries, and focused core/daemon tests. Grants are derived from
approved approval records; no separate grant table was added.

This document narrows P2A from
[Codex-Inspired Runtime Tools P2: Permission Requests And Shell Snapshots](codex-inspired-runtime-tools-p2-permissions-shell-snapshots.md)
into an executable implementation slice. P2A implements durable runtime permission
requests. It does not implement P2B shell snapshots.

## Goal

Let a runner ask for a narrowly scoped capability expansion when it is blocked:

```text
runner reports permission request
-> daemon validates requested scope against current run snapshot and workspace policy
-> daemon creates a durable approval request
-> user approves or denies through existing Web/CLI approval surfaces
-> daemon returns a normal grant or denial
-> active run continues only if the runner can safely consume the grant
```

The grant is run-scoped or continuation-scoped evidence. It is not a workspace policy
mutation.

## Related Docs

- [Codex-Inspired Runtime Tools](codex-inspired-runtime-tools.md)
- [Codex-Inspired Runtime Tools P2: Permission Requests And Shell Snapshots](codex-inspired-runtime-tools-p2-permissions-shell-snapshots.md)
- [Inline Runtime Approval Detailed Design](inline-runtime-approval-detailed-design.md)
- [Core Tools, Runners, MCP Tools, and Plugin Boundary](core-tools-runtime-boundary.md)
- [Approval Policy](approval-policy.md)
- [Runner Registry](runner-registry.md)
- [Runner Adapters](runner-adapters.md)
- [MCP Status Boundaries P2](mcp-status-boundaries-p2.md)
- [CLI Run I/O and Completion P1](cli-run-io-completion-p1.md)

## Non-Goals

- No P2B shell snapshot implementation.
- No P1 unified exec implementation.
- No Codex app-server, JSON-RPC, or config migration.
- No Plugin Manager cards for core tools, permission requests, or runtime feature gates.
- No workspace approval-policy mutation from a run-scoped request.
- No active-run prompt injection.
- No dynamic mutation of Pi's active tool registry unless Pi exposes a safe API later.
- No second approval system separate from Ling's existing approval APIs.
- No raw secret values in request payloads, events, artifacts, or CLI/Web summaries.

## Current Code Anchors

| Area | Current Anchor | P2A Use |
| --- | --- | --- |
| Approval contracts | `packages/core/src/approval-types.ts`, `packages/contracts/src/index.ts` | Add `runtime_permission_request` action/payload types |
| Approval storage | `packages/core/src/storage/sqlite-run-store.ts` | Reuse `approval_requests.payload_json`; no new table for P2A.1 |
| Run approval bridge | `packages/daemon/src/features/runs/approvals.ts` | Add permission-request bridge beside tool approval bridge |
| Run snapshot | `RunSession.requestSnapshot` | Derive current tools, write paths, MCP refs, and runner id |
| Runner-pi approval hook | `packages/runner-pi/src/index.ts` | Add optional permission callback and gated meta-tool |
| Runner registry | `packages/daemon/src/runtime/runners.ts`, `packages/daemon/src/index.ts` | Advertise request-permission support through runner capabilities |
| CLI output | `packages/cli/src/run/output.ts` | Summarize runtime permission approval payloads |
| Web approval cards | `apps/web/src/features/approvals/ApprovalCard.tsx` | Render current scope, requested scope, and continuation plan |

## Contract Decisions

### Approval Action And Payload

Add a new approval action type:

```ts
type ApprovalActionType = /* existing */ | "runtime_permission_request";
```

Add a new approval payload variant:

```ts
type RuntimePermissionRequestKind =
  | "core_tool"
  | "write_scope"
  | "mcp_tool"
  | "runner_capability";

interface RuntimePermissionRequestPayload {
  readonly type: "runtime_permission_request";
  readonly requestKind: RuntimePermissionRequestKind;
  readonly requestedByRunId: string;
  readonly requestedByToolCallId?: string;
  readonly reason: string;
  readonly requestedScope: RuntimePermissionScope;
  readonly currentScope: RuntimePermissionScopeSnapshot;
  readonly proposedContinuation: RuntimePermissionContinuationPlan;
}
```

P2A should add this shape in both `@ling-stack/core` and `@ling-stack/contracts`.
The storage layer already stores `payload_json`, so the first implementation does not
need a schema migration.

### Grant Materialization

Do not add a grant table in P2A.1. Materialize a grant from an approved approval:

```ts
interface RuntimePermissionGrant {
  readonly id: string;
  readonly approvalId: string;
  readonly runId: string;
  readonly scope: RuntimePermissionScope;
  readonly mode: "same_run" | "continuation";
  readonly createdAt: string;
  readonly expiresAt?: string;
}
```

Recommended deterministic id:

```text
runtime_permission_grant:<approvalId>
```

This keeps the durable source of truth as the approval record. A later table is justified
only if grants need independent revocation, indexing, or multi-run lookup.

### Runner Capability

Use existing runner capability strings for P2A:

```text
runtime:request-permissions
```

This avoids adding a parallel runner metadata object before there is a proven need.
Runner list output can already expose `capabilities`.

### Permission Meta-Tool

For `runner-pi`, P2A may expose a gated runtime meta-tool such as
`request_permission`. It is not a Ling core run tool, not an MCP tool, and not a Plugin
Manager entry.

Rules:

- expose it only when the `requestPermissions` runtime feature gate is enabled;
- route calls to `onPermissionRequired`;
- require structured scope arguments;
- never apply grants inside Pi by editing the active tool registry;
- if same-run consumption is unsupported, return a clear result that a continuation is
  required or has been queued.

This is the practical path for embedded Pi because a model cannot ask for a missing core
tool if there is no request-permission affordance.

## Implementation Slices

### P2A.1 Core And Contract Types

Status: implemented.

Files:

- `packages/core/src/approval-types.ts`
- `packages/core/src/index.ts`
- `packages/contracts/src/index.ts`

Tasks:

- Add `runtime_permission_request` to `ApprovalActionType`.
- Add payload/scope/current-scope/continuation/grant types.
- Add the action type to `approvalActionTypes`.
- Export the new types from core.
- Keep all fields additive.

Acceptance:

- TypeScript accepts existing approval payloads unchanged.
- Creating, storing, listing, approving, and denying a permission approval round-trips
  through `payload_json`.

### P2A.2 Scope Validation Helpers

Status: implemented.

Recommended new core helper:

```text
packages/core/src/runtime-permissions.ts
```

Tasks:

- Validate `requestKind` and `requestedScope` match.
- Reject unknown core tools.
- Normalize write-scope paths and reject empty, traversal, and host-secret-shaped values.
- Keep MCP scope references as ids/names only; never include input payloads or secret
  values.
- Build stable scope summaries for Web/CLI.
- Derive `RuntimePermissionGrant` from an approved approval payload.

Policy rules:

- Workspace `deny` is final.
- An approved request grants at most the requested scope.
- A request cannot add tools outside the runner's supported tool set.
- A request cannot add MCP tools that are missing from the catalog or secret-status
  readiness checks.
- Write-scope requests must stay within workspace/channel boundaries.

Acceptance:

- Malformed requests fail closed.
- Secret-looking values are redacted or rejected before approval creation.
- Unit tests cover all four request kinds.

### P2A.3 Daemon Permission Request Bridge

Status: implemented.

Recommended new daemon module:

```text
packages/daemon/src/features/runs/permission-requests.ts
```

Tasks:

- Add `createRunPermissionRequestHandler` beside `createRunApprovalHandler`.
- Read current scope from `RunSession.requestSnapshot`.
- Evaluate requested scope against effective policy and runner registry.
- Create a durable approval with action type `runtime_permission_request`.
- Reuse existing approval requested/resolved events.
- Reuse existing approve/deny endpoints.
- Return a normalized decision to the runner.

Behavior:

| Case | Result |
| --- | --- |
| Request malformed | Return denial; record readable run event if available |
| Workspace policy denies scope | Create auto-denied approval evidence, same as denied tool attempts |
| User denies | Return normal denial |
| Approval expires | Return normal expired denial |
| User approves and same-run is supported | Return `RuntimePermissionGrant` with `mode: "same_run"` |
| User approves but same-run is unsupported | Return grant plus continuation instruction/status |

Implementation note: extract shared approval-waiting code from `approvals.ts` only if
that reduces duplication. Do not refactor unrelated approval behavior.

Acceptance:

- Pending permission requests put the run into `waiting_for_approval`.
- Approved/denied/expired decisions emit the same durable approval event family as
  existing tool approvals.
- Workspace `deny` cannot be overridden by user approval.

### P2A.4 Runner-Pi Integration

Status: implemented for the gated `request_permission` meta-tool. The active Pi tool
registry is not dynamically mutated after approval.

Files:

- `packages/runner-pi/src/index.ts`
- `packages/daemon/src/index.ts`
- `packages/daemon/src/runtime/runners.ts`

Tasks:

- Add optional `onPermissionRequired` to `PiRunnerRunOptions`.
- Add request/decision/grant types to runner-pi.
- Add `runtime:request-permissions` to Pi runner capabilities only when the feature is
  wired and tested.
- Expose a gated `request_permission` meta-tool through a Pi extension.
- Convert meta-tool calls into `onPermissionRequired` requests.
- Return a structured text/tool result that explains whether approval was granted,
  denied, expired, or requires continuation.

Boundary:

- Do not add `request_permission` to `RunTool`.
- Do not put `request_permission` in Plugin Manager.
- Do not dynamically add `bash`, `edit`, `write`, MCP tools, or runner capabilities to
  the active Pi session unless Pi later exposes a safe API and Ling adds tests for it.

Acceptance:

- With the feature gate off, Pi behavior is unchanged.
- With the feature gate on, a model can request a permission without executing the
  requested side-effect.
- Approval denial is returned as a normal tool result/error, not a daemon crash.

### P2A.5 Web And CLI Rendering

Status: implemented for existing approval surfaces. The optional read-only
`/permission-requests` convenience endpoints remain deferred because existing approval
list/show endpoints can inspect and resolve the new payload.

Files:

- `apps/web/src/features/approvals/ApprovalCard.tsx`
- `packages/cli/src/run/output.ts`
- optional API client/types if read views are added

Tasks:

- Add a Web summary for `payload.type === "runtime_permission_request"`.
- Show request kind, current scope, requested scope, and continuation mode.
- Add a CLI summary for runtime permission request payloads.
- Keep approve/deny commands unchanged.
- Avoid showing raw absolute host paths unless existing UI already shows them for the
  same run context.

Optional read-only views:

```http
GET /permission-requests?cwd=...&runId=...
GET /permission-requests/:id?cwd=...
```

These are filtered approval read models. They must not introduce new resolution
endpoints.

Acceptance:

- Web approval cards are readable without opening raw JSON.
- `ling-stack run` prints a concise permission request summary on stderr.
- `--json` output remains JSON-only.

### P2A.6 Tests

Status: implemented for core helpers and daemon bridge behavior.

Recommended tests:

- `packages/core/test/runtime-permissions.test.mjs`
- `packages/daemon/test/runtime-permission-requests.test.mjs`
- targeted updates to existing approval/Web/CLI tests

Test matrix:

| Scenario | Expected |
| --- | --- |
| Core tool request approved | Durable approval resolves and materializes run-scoped grant |
| Core tool request denied | Runner receives normal denial |
| Workspace policy denies requested tool | User cannot override |
| Write-scope path traversal | Fails closed before actionable approval |
| MCP tool missing | Fails closed with readable diagnostic |
| Runner lacks capability | Fails closed or requires continuation |
| Same-run unsupported | No tool registry mutation; continuation path is reported |
| Secret in reason/scope | Payload/event/output is redacted or request is rejected |
| Feature gate off | No Pi `request_permission` meta-tool |
| Core tools remain outside Plugin Manager | Regression test stays green |

Minimum validation command set:

```bash
bun test packages/core/test/runtime-permissions.test.mjs
bun test packages/daemon/test/runtime-permission-requests.test.mjs
bun run typecheck
git diff --check
```

Use narrower package-specific typecheck/test commands if the repo has them wired.

## Feature Gate

Recommended flag:

```ts
interface RuntimeToolFeatureFlags {
  readonly requestPermissions?: boolean;
}
```

If there is no runtime-tool feature flag container yet, P2A can start with daemon config
or runtime diagnostics only. The flag must be visible in run request snapshots before the
Pi meta-tool is enabled.

Default:

```text
requestPermissions = false
```

Enable only after P2A tests pass.

## Rollout Plan

1. Add additive types and tests.
2. Add daemon bridge with tests using direct handler calls.
3. Add Web/CLI summaries for the new approval payload.
4. Add runner-pi optional callback and gated meta-tool.
5. Add integration test for approved, denied, expired, and same-run-unsupported flows.
6. Flip feature gate only in local/dev config after conformance passes.

Current rollout state:

- Types and tests are in place.
- Daemon bridge is covered by direct handler integration tests.
- Web/CLI summaries are in existing approval rendering paths.
- Runner-pi exposes the meta-tool only when `runtimeToolFeatures.requestPermissions` is
  enabled for the run.
- The global default remains off.
- Global config wiring for enabling the feature across all run entrypoints is deferred.

## Acceptance Criteria

P2A is complete when:

- a runner can create a durable `runtime_permission_request` approval;
- existing Web and CLI approval flows can inspect and resolve it;
- approved requests produce run-scoped or continuation-scoped grants;
- denied and expired requests are delivered back to the runner as normal denials;
- workspace `deny` and write-scope boundaries cannot be bypassed;
- active sessions are not modified through hidden prompt injection;
- Pi's active tool registry is not mutated without an explicit safe API;
- payloads, events, artifacts, and summaries do not leak raw secrets;
- P2B remains unimplemented until P1 unified exec exists.

## Open Questions

- Should `request_permission` be visible to every model when the feature gate is enabled,
  or only when a run has a restricted tool snapshot?
- Should approved grants expire immediately at run completion, or at a short fixed TTL
  for queued continuation creation?
- Should `/permission-requests` read-only endpoints land in P2A.1, or wait until Web
  needs filtering beyond existing approvals?
- Should multi-scope requests be rejected in P2A to keep audit review simple?
