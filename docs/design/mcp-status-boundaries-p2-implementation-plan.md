# MCP Status Boundaries P2 Implementation Plan

## Status

Detailed implementation breakdown for [MCP Status Boundaries P2](mcp-status-boundaries-p2.md).

Implemented in the current P2 patch set. This document remains the patch plan
and review map; it does not replace the P2 boundary design. The goal is to keep
the MCP hardening work reviewable as small patches while removing the raw-secret
and persisted-status traps from the previous prototype.

Implementation status:

- P2.1 core MCP boundary types: done.
- P2.2 SQLite status snapshot and legacy secret migration state: done.
- P2.3 daemon MCP schemas and routes: done.
- P2.4 broker transport factory and stdio launcher split: done.
- P2.5 run MCP access and redaction: done.
- P2.6 contracts, API client, and Web MCP editor: done.
- P2.7 doctor and CLI status surface: done.
- P2.8 test matrix and docs alignment: done for this slice.

## Source Design

Authoritative behavior lives in:

- [MCP Status Boundaries P2](mcp-status-boundaries-p2.md)
- [CLI v0.1](cli-v0.1.md)
- [Secrets and Keychain](secrets-keychain.md)
- [Daemon Modularization](daemon-modularization.md)
- [Runner Adapters](runner-adapters.md)

Implementation must preserve these boundaries:

- normal runs still go through daemon `/runs`,
- MCP tool calls still obey teammate bindings and runner approval policy,
- daemon HTTP remains the public daemon API for P2,
- doctor stays read-only,
- public responses never include MCP secret values,
- existing raw SQLite MCP secrets are migration evidence, not a source to return
  or silently copy into Keychain.

## Original Hotspots

| Area | Current owner | P2 issue |
| --- | --- | --- |
| core MCP types | `packages/core/src/mcp-types.ts` | config, status, and secret value names are coupled |
| SQLite store | `packages/core/src/storage/sqlite-run-store.ts` | `mcp_server_secrets.secret_value` stores raw values; `mcp_servers.status_json` stores runtime state |
| daemon request parsing | `packages/daemon/src/features/mcp/schemas.ts` | create/update accepts raw `secrets` and `status` |
| daemon routes | `packages/daemon/src/features/mcp/routes.ts` | raw secret endpoint exists; check/sync mutate server status |
| daemon broker | `packages/daemon/src/features/mcp/broker.ts` | broker receives raw secret map and owns stdio process placement |
| run MCP access | `packages/daemon/src/features/runs/mcp.ts` | run snapshots use persisted server status and raw-store secret checks |
| contracts/API client | `packages/contracts/src/index.ts`, `packages/api-client/src/client.ts` | public contract includes `McpServerSecretResponse` and `getMcpServerSecret()` |
| Web MCP UI | `apps/web/src/features/mcp/McpToolsPage.tsx`, `apps/web/src/api.ts` | edit flow fetches and displays saved secret values |
| CLI doctor | `packages/cli/src/main.ts`, `packages/cli/src/doctor/` | MCP secret check reads a shape that does not match the current public response and lacks migration/status freshness checks |
| tests | `packages/core/test/mcp-store.test.mjs`, `packages/daemon/test/mcp-api.test.mjs` | tests assert raw secret persistence and broker raw-secret delivery |

## Patch Sequence

P2 landed as eight implementation patches.

```text
P2.1 core MCP boundary types
P2.2 SQLite status snapshot and legacy secret migration state
P2.3 daemon MCP schemas and routes
P2.4 broker transport factory and stdio launcher split
P2.5 run MCP access and redaction
P2.6 contracts, API client, and Web MCP editor
P2.7 doctor and CLI status surface
P2.8 test matrix and docs alignment
```

The patches can be reviewed together, but this order is still the intended
dependency chain. Each patch removes one old dependency before the next layer
consumes the new contract.

## P2.1 Core MCP Boundary Types

### Files

Update:

```text
packages/core/src/mcp-types.ts
packages/core/src/secrets.ts
packages/core/src/run-types.ts
packages/core/src/index.ts
```

### Responsibility

Core owns durable MCP data shapes, short-lived status snapshot shapes, run access
snapshots, and secret ref typing. It should not know how daemon resolves secrets
or launches MCP transports.

### Target Transport Shape

Replace new-write usage of secret name lists with explicit refs.

```ts
export interface McpStdioTransport {
  readonly type: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly secretEnvRefs: Readonly<Record<string, string>>;

  // Legacy read-only compatibility. Do not write in P2.
  readonly secretEnvNames?: readonly string[];
}

export interface McpStreamableHttpTransport {
  readonly type: "streamable-http";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly secretHeaderRefs: Readonly<Record<string, string>>;
  readonly bearerTokenRef?: string;
  readonly oauthClientId?: string;
  readonly oauthResource?: string;

  // Legacy read-only compatibility. Do not write in P2.
  readonly bearerTokenEnvVar?: string;
  readonly envHeaders?: Readonly<Record<string, string>>;
  readonly secretHeaderNames?: readonly string[];
}
```

Rules:

- `secretEnvRefs` maps env var name to `env:` or `keychain:` ref.
- `secretHeaderRefs` maps HTTP header name to `env:` or `keychain:` ref.
- `bearerTokenRef` resolves to `Authorization: Bearer <value>` only when no
  explicit `Authorization` header is produced.
- static `env` and `headers` reject values that look like secret refs or obvious
  bearer tokens only at validation time if the check is deterministic. Do not
  add heuristic false positives to core.
- legacy fields stay readable so old SQLite rows can be diagnosed.

### Status Types

Add:

```ts
export type McpRuntimeStatusKind =
  | "unknown"
  | "ready"
  | "failed"
  | "disabled"
  | "expired"
  | "migration_required";

export type McpAuthStatusKind =
  | "not_required"
  | "configured"
  | "missing"
  | "access_denied"
  | "store_unavailable"
  | "invalid_ref"
  | "migration_required";

export interface McpAuthStatus {
  readonly kind: McpAuthStatusKind;
  readonly refs: readonly string[];
  readonly missingRefs: readonly string[];
  readonly message?: string;
}

export interface McpRuntimeStatusSnapshot {
  readonly serverId: string;
  readonly checkedAt: string;
  readonly expiresAt: string;
  readonly status: McpRuntimeStatusKind;
  readonly serverInfo?: {
    readonly name?: string;
    readonly version?: string;
  };
  readonly protocolVersion?: string;
  readonly toolCount?: number;
  readonly missingSecretRefs: readonly string[];
  readonly authStatus: McpAuthStatus;
  readonly latencyMs?: number;
  readonly errorCode?: string;
  readonly message?: string;
}
```

Keep the existing `McpServerStatus` type as a compatibility DTO for current Web
and CLI rendering, but treat it as derived from `McpRuntimeStatusSnapshot`. New
code should not use it as durable config.

### Public Server Shape

Add a public projection type:

```ts
export interface PublicMcpServer extends McpServer {
  readonly status: McpServerStatus;
  readonly statusSnapshot?: McpRuntimeStatusSnapshot;
  readonly secretConfigured: Readonly<Record<string, boolean>>;
  readonly secretStatuses: readonly SecretStatus[];
  readonly legacySecretMigrationRequired: boolean;
}
```

`McpServer` may keep the current field list during P2 to reduce churn, but the
source of truth should shift to:

- durable config from `mcp_servers`,
- latest snapshot from `mcp_status_snapshots`,
- secret statuses from `SecretResolver`,
- legacy raw secret count from `mcp_server_secrets`.

### Secret Purpose

Prefer existing purposes unless a test proves ambiguity hurts clients:

- HTTP header secrets use `custom_header`,
- bearer tokens use `custom_header`,
- stdio env secrets use `automation_token`.

If UI copy or status filtering needs a more exact purpose, add one new
`SecretPurpose` value:

```ts
"mcp_transport_secret"
```

Do not add multiple MCP-specific secret purposes in P2.

## P2.2 SQLite Status Snapshot And Legacy Secret Migration State

### Files

Update:

```text
packages/core/src/storage/sqlite-run-store.ts
packages/core/src/run-types.ts
packages/core/test/mcp-store.test.mjs
```

### Responsibility

SQLite owns durable config, cached tool catalog, teammate bindings, and a small
short-lived status snapshot cache. It must not accept new raw MCP secret writes.

### Schema

Add one migration:

```sql
CREATE TABLE IF NOT EXISTS mcp_status_snapshots (
  server_id TEXT PRIMARY KEY,
  status_json TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mcp_status_snapshots_expires
ON mcp_status_snapshots(expires_at);
```

Keep `mcp_server_secrets` in place for legacy detection only. Do not drop it in
P2 because existing local databases need a readable migration warning.

Keep `mcp_servers.status_json` readable for older rows, but stop updating it.
New server writes should use `{ "kind": "unknown" }` only as compatibility
padding until a later migration removes the column.

### Store Interface Additions

Add:

```ts
upsertMcpStatusSnapshot(snapshot: McpRuntimeStatusSnapshot, now: string): McpRuntimeStatusSnapshot;
getMcpStatusSnapshot(serverId: string, now?: string): McpRuntimeStatusSnapshot | undefined;
deleteMcpStatusSnapshot(serverId: string): boolean;
countLegacyMcpServerSecrets(serverId?: string): number;
listLegacyMcpServerSecretNames(serverId: string): readonly string[];
```

Change or deprecate:

```ts
setMcpServerSecret(...)
getMcpServerSecret(...)
hasMcpServerSecret(...)
deleteMcpServerSecret(...)
updateMcpServerStatus(...)
```

P2 rule:

- new daemon code must not call raw secret methods,
- tests should fail if create/update routes call `setMcpServerSecret`,
- raw getter should be package-internal legacy support only or removed from the
  public `RunStore` interface after all daemon callers move away.

### Normalization

Update `normalizeMcpServerTransport()`:

- preserve old `secretEnvNames`, `secretHeaderNames`, `envHeaders`, and
  `bearerTokenEnvVar` when reading legacy rows,
- normalize new `secretEnvRefs` and `secretHeaderRefs` to empty objects,
- validate every new ref with `parseSecretRef()`,
- reject duplicate static and secret destinations, such as the same HTTP header
  in both `headers` and `secretHeaderRefs`.

### Tests

Change `mcp-store.test.mjs` from "persists MCP secrets" to:

- persists MCP server config with secret refs,
- persists discovered tools and teammate bindings,
- persists latest status snapshot separately,
- deletes snapshot/tool/binding rows when the server is deleted,
- rejects or omits new raw secret writes,
- reports legacy raw secret names/count without exposing values.

## P2.3 Daemon MCP Schemas And Routes

### Files

Update:

```text
packages/daemon/src/features/mcp/schemas.ts
packages/daemon/src/features/mcp/routes.ts
packages/daemon/src/features/mcp/secrets.ts
packages/daemon/src/server/routes.ts
packages/daemon/src/server/router.ts
packages/daemon/test/mcp-api.test.mjs
```

### Responsibility

Daemon routes own request validation, public projections, and status snapshot
write/read behavior. They do not own secret value resolution.

### Request Contract

Remove from create/update:

```ts
status
secrets
clearSecretNames
```

Accept only:

```ts
displayName
transport
enabled
required
startupTimeoutSec
toolTimeoutSec
enabledTools
disabledTools
```

Validation should reject `secrets`, `clearSecretNames`, and `status` with a
clear `bad_request` message:

```text
MCP server secrets must be configured as secret refs; raw secret values are not accepted.
```

### Public Projection

Replace `toPublicMcpServer(store, server)` with a resolver-aware projection:

```ts
toPublicMcpServer(input: {
  readonly store: RunStore;
  readonly server: McpServer;
  readonly secretResolver: SecretResolver;
  readonly now: string;
}): PublicMcpServer
```

Projection rules:

- collect refs from `secretEnvRefs`, `secretHeaderRefs`, and `bearerTokenRef`,
- call `secretResolver.status(ref, purpose)` only,
- derive `secretConfigured` from statuses for compatibility,
- include `secretStatuses`,
- include latest non-expired status snapshot if available,
- derive `server.status` from the snapshot or legacy `status_json`,
- set `legacySecretMigrationRequired` if raw rows exist.

### Route Contract

Keep:

```http
GET /mcp/servers
POST /mcp/servers
GET /mcp/servers/:id
PATCH /mcp/servers/:id
DELETE /mcp/servers/:id
POST /mcp/servers/:id/check
POST /mcp/servers/:id/sync-tools
GET /mcp/tools
```

Add:

```http
GET /mcp/servers/:id/status
```

Remove or disable:

```http
GET /mcp/servers/:id/secret
```

Recommended P2 behavior for the old secret route:

```json
{
  "error": "mcp_secret_endpoint_removed",
  "message": "MCP secret values are not readable. Use secret refs and /secrets/status."
}
```

Use HTTP `410`.

### Check Response

`POST /mcp/servers/:id/check` returns:

```ts
interface McpServerCheckResponse {
  readonly server: PublicMcpServer;
  readonly statusSnapshot: McpRuntimeStatusSnapshot;
}
```

On failure, still persist and return a failed snapshot when possible:

```json
{
  "error": "mcp_check_failed",
  "message": "...",
  "server": {},
  "statusSnapshot": {}
}
```

HTTP status can remain `400` for failed checks, but the body must be structured
so Web and CLI can render the snapshot.

### Sync Response

`POST /mcp/servers/:id/sync-tools` returns:

```ts
interface McpServerToolSyncResponse {
  readonly server: PublicMcpServer;
  readonly statusSnapshot: McpRuntimeStatusSnapshot;
  readonly tools: readonly McpTool[];
}
```

Tool sync should:

1. resolve status and auth,
2. list tools through the broker,
3. persist tool catalog rows only after tool listing succeeds,
4. persist a status snapshot either way.

### Status Response

`GET /mcp/servers/:id/status`:

- reads the latest snapshot only,
- does not open a live MCP connection,
- returns `unknown` or `expired` if no fresh snapshot exists,
- includes secret status from refs but no values.

## P2.4 Broker Transport Factory And Stdio Launcher Split

### Files

Add:

```text
packages/daemon/src/features/mcp/status.ts
packages/daemon/src/features/mcp/transport-factory.ts
packages/daemon/src/features/mcp/stdio-launcher.ts
```

Update:

```text
packages/daemon/src/features/mcp/broker.ts
packages/daemon/src/context.ts
packages/daemon/src/index.ts
packages/daemon/test/mcp-api.test.mjs
```

### Responsibility

The broker owns MCP protocol operations. Transport factory owns SDK transport
construction. Stdio launcher owns child process placement.

### Broker Interface

Change `McpBroker` from raw secret maps to trusted resolver options:

```ts
export interface McpBrokerOptions {
  readonly secretResolver: SecretResolver;
  readonly now?: () => string;
}

export interface McpBroker {
  checkServer(server: McpServer, options: McpBrokerOptions): Promise<McpStatusCheckResult>;
  listTools(server: McpServer, options: McpBrokerOptions): Promise<McpToolSyncResult>;
  callTool(
    server: McpServer,
    options: McpBrokerOptions,
    toolName: string,
    input: unknown,
  ): Promise<PiRunnerMcpToolCallResult>;
}
```

Results:

```ts
export interface McpStatusCheckResult {
  readonly statusSnapshot: McpRuntimeStatusSnapshot;
}

export interface McpToolSyncResult {
  readonly statusSnapshot: McpRuntimeStatusSnapshot;
  readonly tools: readonly ReplaceMcpServerToolInput[];
}
```

### Secret Resolution

`transport-factory.ts` should:

- collect refs from the transport,
- call `secretResolver.resolve(ref, purpose)` only inside factory/call paths,
- return both SDK transport and resolved values for redaction registration,
- fail closed on missing required refs,
- never return values to routes, contracts, or Web.

Legacy raw secret rows are not inputs to the factory.

### Stdio Launcher

`stdio-launcher.ts` should wrap `StdioClientTransport` construction:

```ts
export interface McpProcessLauncher {
  createStdioTransport(input: McpStdioLaunchInput): McpTransport;
}
```

Default implementation:

- merges `getDefaultEnvironment()`,
- overlays static env,
- overlays resolved secret env values,
- sets cwd,
- sets stderr to `pipe`,
- owns process-placement errors.

This is deliberately small. It is not a process supervisor and should not keep
long-lived MCP stdio processes in P2.

### Status Snapshot Construction

`status.ts` should provide helpers:

```ts
createDisabledMcpStatusSnapshot(...)
createMcpMissingSecretSnapshot(...)
createMcpReadySnapshot(...)
createMcpFailedSnapshot(...)
deriveMcpServerStatus(snapshot)
```

Default TTL:

```text
5 minutes
```

Do not make status freshness a correctness gate for tool calls. Tool calls must
resolve refs and connect live, even if the last check is stale.

## P2.5 Run MCP Access And Redaction

### Files

Update:

```text
packages/daemon/src/features/runs/mcp.ts
packages/daemon/src/features/runs/routes.ts
packages/core/src/mcp-types.ts
packages/daemon/test/mcp-api.test.mjs
```

### Responsibility

Run startup owns an immutable access snapshot: which MCP servers/tools the
teammate was allowed to use at run start. It does not own secret values.

### Snapshot Changes

Update `RunMcpServerAccessSnapshot`:

```ts
export interface RunMcpServerAccessSnapshot {
  readonly serverId: string;
  readonly displayName: string;
  readonly transportType: McpServerTransportType;
  readonly required: boolean;
  readonly status: McpServerStatus;
  readonly secretStatuses: readonly SecretStatus[];
  readonly missingSecretRefs: readonly string[];
  readonly legacySecretMigrationRequired: boolean;
  readonly tools: readonly RunMcpToolAccessItem[];
}
```

Keep `configuredSecretNames` and `missingSecretNames` only if existing UI/tests
need a compatibility window. New tests should assert `secretStatuses` and
`missingSecretRefs`.

### Tool Call Handler

Change:

```ts
mcpBroker.callTool(server, collectMcpServerSecrets(store, server), ...)
```

to:

```ts
mcpBroker.callTool(server, { secretResolver }, ...)
```

The handler still revalidates:

- tool was authorized at run start,
- server still exists and is enabled,
- cached tool still exists and is enabled,
- teammate binding cannot be widened mid-run.

### Redaction

Remove `collectMcpSecretValuesForAccess()` as a raw-store helper.

If a call resolves secret values, redaction should happen inside the trusted
call path before logging or artifact/event creation. Do not resolve all MCP
secret refs at run start only to build a redaction list.

Tests should assert:

- run request snapshots contain refs/status only,
- fake broker receives a resolver or a pre-resolved private transport object, not
  raw store values,
- serialized run JSON does not include configured secret values.

## P2.6 Contracts, API Client, And Web MCP Editor

### Files

Update:

```text
packages/contracts/src/index.ts
packages/api-client/src/client.ts
packages/api-client/test/client.test.mjs
apps/web/src/types.ts
apps/web/src/api.ts
apps/web/src/domains/mcp/use-mcp-domain.ts
apps/web/src/features/mcp/McpToolsPage.tsx
apps/web/src/styles/mcp.css
```

### Contracts

Add:

```ts
McpRuntimeStatusSnapshot
McpAuthStatus
McpServerCheckResponse
McpServerStatusResponse
```

Change:

```ts
McpServerToolSyncResponse.statusSnapshot
McpServer.secretStatuses
McpServer.legacySecretMigrationRequired
McpServerMutationRequest.transport secret-ref fields
```

Remove or deprecate:

```ts
McpServerSecretResponse
McpServerMutationRequest.secrets
McpServerMutationRequest.clearSecretNames
```

### API Client

Remove:

```ts
getMcpServerSecret(...)
```

Add:

```ts
getMcpServerStatus(cwd: string, serverId: string): Promise<McpServerStatusResponse>
```

Change:

```ts
checkMcpServer(...): Promise<McpServerCheckResponse>
syncMcpServerTools(...): Promise<McpServerToolSyncResponse>
```

### Web Form

Replace secret value fields with secret ref fields.

Current:

```text
Header secret name
Header secret value
Env secret name
Env secret value
```

Target:

```text
Header name
Header secret ref
Env variable name
Env secret ref
Bearer token ref
```

Rules:

- editing a server never fetches or displays a saved secret value,
- no show/hide password toggle remains for MCP secrets,
- create/update sends only refs,
- status badges render configured/missing/access denied/store unavailable,
- legacy raw-secret rows render `Migration required`,
- check/sync feedback uses returned `statusSnapshot`.

P2 minimum supports `env:` and externally managed `keychain:` refs. A narrow MCP
Keychain write UI can be added later, but it must be a declared-ref setup flow,
not a generic secret value API.

## P2.7 Doctor And CLI Status Surface

### Files

Update:

```text
packages/cli/src/main.ts
packages/cli/src/doctor/checks.ts
packages/cli/src/doctor/report.ts
packages/cli/test/doctor.test.mjs
```

Optional add after the route work is stable:

```text
packages/cli/src/mcp/commands.ts
packages/cli/src/mcp/output.ts
```

### Doctor

Doctor should keep using `GET /mcp/servers`; it must not call live `check` or
`sync-tools`.

Replace the current MCP checks with:

- `mcp.servers`: total/enabled count,
- `mcp.secret_refs`: missing or invalid refs,
- `mcp.legacy_secrets`: migration-required raw SQLite secret rows,
- `mcp.status_snapshots`: missing, stale, failed, or ready snapshots,
- `mcp.tools`: cached enabled tool count if the daemon response includes enough
  data or after a cheap `GET /mcp/tools`.

Statuses:

- no MCP servers is `ok`, because MCP is optional,
- missing refs on enabled required servers is `fail`,
- missing refs on optional servers is `warning`,
- legacy raw secrets is `warning` with migration remediation,
- stale status snapshot is `warning`,
- failed status snapshot for required server is `fail`.

Doctor JSON must include refs and status only. It must not include values or old
raw secret names if those names are themselves sensitive. Header/env destination
names such as `Authorization` and `GITHUB_TOKEN` are allowed.

### Optional CLI MCP Commands

Only add these if the implementation already needs them for manual testing:

```text
ling-stack mcp list
ling-stack mcp status <server-id>
ling-stack mcp check <server-id>
ling-stack mcp sync-tools <server-id>
```

Rules:

- `list` and `status` are read-only,
- `check` opens a live connection and returns a snapshot,
- `sync-tools` opens a live connection and writes tool catalog rows,
- `--json` stdout is redacted JSON,
- progress and warnings go to stderr.

## P2.8 Test Matrix And Docs Alignment

### Validation Run

Validated on 2026-06-06:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web exec playwright test e2e/app.spec.ts -g "MCP tool access page"
corepack pnpm --filter @ling-stack/cli test
git diff --check
```

The attempted `corepack pnpm --filter @ling-stack/web test:e2e -- app.spec.ts
-g "MCP tool access page"` command is intentionally not counted as evidence:
pnpm forwarded the literal `--` to Playwright and started unrelated `app.spec.ts`
tests. It was stopped and replaced with the direct `pnpm exec playwright`
command above.

### Required Tests

Core:

```bash
corepack pnpm --filter @ling-stack/core test
```

Required assertions:

- new transport refs normalize and persist,
- invalid refs fail validation,
- latest status snapshot persists separately from server config,
- expired snapshots are reported as expired or omitted,
- new writes do not create `mcp_server_secrets.secret_value`,
- legacy raw secret rows are counted without exposing values.

Daemon:

```bash
corepack pnpm --filter @ling-stack/daemon test
```

Required assertions:

- create/update rejects raw `secrets`,
- public MCP responses include `secretStatuses` and no values,
- old secret endpoint returns `410`,
- check returns `statusSnapshot` and does not mutate `mcp_servers.status_json`,
- sync returns `statusSnapshot` plus persisted tools,
- broker receives `SecretResolver` options, not raw store secrets,
- missing refs fail closed with structured status.

API client:

```bash
corepack pnpm --filter @ling-stack/api-client test
```

Required assertions:

- `getMcpServerSecret` is gone,
- check/sync response types include `statusSnapshot`,
- request payload helpers cannot send raw MCP secret values.

CLI:

```bash
corepack pnpm --filter @ling-stack/cli test
```

Required assertions:

- doctor does not call check/sync,
- doctor renders missing refs,
- doctor renders legacy secret migration warnings,
- doctor JSON is redacted.

Web:

```bash
corepack pnpm --filter @ling-stack/web typecheck
corepack pnpm --filter @ling-stack/web test:e2e
```

Required assertions:

- MCP editor no longer fetches raw secret values,
- create/update sends refs only,
- status badges show configured/missing/migration-required,
- check/sync use status snapshot response.

Repo-level:

```bash
corepack pnpm typecheck
corepack pnpm test
git diff --check
```

### Secret Pattern Scan

Before landing P2, scan staged diff for obvious MCP secret regressions:

```bash
git diff --cached -U0 | rg -n "secretValue|Bearer secret|run-secret-token|mcp_server_secrets|GET /mcp/servers/.*/secret"
```

Expected result:

- tests may contain fake placeholder values only when asserting redaction,
- production code should not expose raw secret values,
- `mcp_server_secrets` may remain only in migration/counting code.

## Compatibility Notes

- Existing UI consumers can keep reading `server.status.kind` during P2, but the
  daemon must derive it from snapshots.
- Existing old MCP configs with `secretHeaderNames` or `secretEnvNames` should
  load and show `migration_required` until the user edits them to refs.
- Existing raw secret rows should not be deleted automatically. Deletion without
  an explicit migration path can strand users without a way to recover the value.
- P2 should not silently write a Keychain item from SQLite. That would hide a
  sensitive migration and make provenance unclear.
- A later cleanup migration can remove legacy columns/methods after one release
  cycle or after the product has an explicit migration UI.

## Landing Criteria

P2 is ready to merge when:

- no new MCP API path accepts or returns raw secret values,
- new MCP config writes store secret refs only,
- status snapshots are separate from durable server config,
- check/sync return structured snapshots,
- Web editor no longer fetches saved MCP secret values,
- doctor reports MCP status without mutating state,
- run snapshots contain refs/status only,
- existing MCP tool calls still work when refs resolve,
- missing refs fail closed with clear remediation,
- the required package tests and repo checks pass.
