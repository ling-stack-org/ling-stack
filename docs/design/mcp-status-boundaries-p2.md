# MCP Status Boundaries P2

## Status

Implemented in the Codex CLI borrowing P2 slice.

P2 is a boundary-hardening design, not a replacement of the Ling daemon HTTP API.
The goal is to separate MCP persisted configuration, runtime connection state,
auth/secret resolution, and status reporting before more CLI and Web MCP surfaces
depend on them.

Detailed patch breakdown lives in MCP Status Boundaries P2.

Current implementation state:

- new MCP writes use secret refs only,
- raw MCP secret reads return `410 Gone`,
- check and sync persist short-lived runtime status snapshots,
- public MCP responses include secret status metadata but never resolved values,
- broker and run tool calls resolve refs only inside trusted daemon paths,
- Web edits refs instead of reading saved secret values,
- doctor stays read-only and redacted.

## Related Docs

- [CLI v0.1](cli-v0.1.md)
- [CLI Run I/O and Completion P1](cli-run-io-completion-p1.md)
- [Daemon API](../daemon-api.md)
- [Secrets and Keychain](secrets-keychain.md)
- [Daemon Modularization](daemon-modularization.md)
- [Runner Adapters](runner-adapters.md)

## Reference Snapshot

Upstream reference: `openai/codex` at `345cf6e`.

Ling Stack should borrow the separation ideas that matter for a local operator
loop: status snapshots, connection lifecycle ownership, redacted diagnostics,
and config/auth/runtime boundaries. It should not copy Codex app-server JSON-RPC
wholesale in P2.

## Problem

Before P2, the MCP implementation was functional, but several boundaries were
blurred:

- persisted MCP server rows carry runtime `status`,
- raw MCP secret values can be stored in SQLite,
- the daemon exposes an MCP secret read endpoint,
- create/update requests accept raw `secrets`,
- the broker owns both MCP protocol calls and stdio process placement,
- check and sync operations update durable config-adjacent state rather than
  producing short-lived runtime observations.

That shape is tolerable for an early local prototype, but it is the wrong base
for doctor output, CLI automation, Web settings, and future desktop packaging.
P2 should make the safe model the only model for new writes.

## Pre-P2 Baseline

Current public routes:

- `GET /mcp/servers`
- `POST /mcp/servers`
- `GET /mcp/servers/:id`
- `PATCH /mcp/servers/:id`
- `DELETE /mcp/servers/:id`
- `POST /mcp/servers/:id/check`
- `POST /mcp/servers/:id/sync-tools`
- `GET /mcp/servers/:id/secret?name=...`
- `GET /mcp/tools`

Useful existing pieces:

- `toPublicMcpServer()` exposes `secretConfigured` status instead of secret values.
- `withMcpClient()` creates a short-lived SDK client and closes it in `finally`.
- tool sync already persists a catalog separate from live tool calls.
- runner access snapshots already model MCP tools as approval-aware runtime access.

Pre-P2 risks addressed by this design:

- `mcp_server_secrets.secret_value` stores raw MCP secret values in SQLite.
- `GET /mcp/servers/:id/secret` returns a raw `secretValue`.
- create/update accepts raw `secrets` and writes them into the store.
- `McpServer.status` is persisted on the server config object.
- `broker.ts` directly creates `StdioClientTransport`, including child process
  command, env, cwd, and stderr placement.

## Goals

- Keep persisted MCP config separate from runtime/auth/status state.
- Represent live check results as short-lived status snapshots.
- Store only secret refs and status metadata in persisted config.
- Resolve secrets only inside trusted daemon execution paths.
- Remove or deprecate every raw MCP secret read path.
- Keep MCP tool access under the existing runner approval model.
- Preserve the daemon HTTP API shape; do not migrate to app-server JSON-RPC in P2.
- Keep doctor read-only and redacted.

## Non-Goals

- No cloud MCP marketplace.
- No dynamic OAuth browser flow unless P2 only needs status fields to model it.
- No generic `getSecretValue()` API.
- No hidden MCP tool approval bypass for CLI convenience.
- No migration to Codex app-server JSON-RPC.
- No silent copy of existing SQLite secrets into Keychain.

## Target Model

### `McpServerConfig`

Durable. Stored in SQLite.

Fields:

- `id`
- `workspaceId`
- `displayName`
- `enabled`
- `required`
- `transport`
- `startupTimeoutSec`
- `toolTimeoutSec`
- `enabledTools`
- `disabledTools`
- `createdAt`
- `updatedAt`

`transport` may include non-secret static values and secret refs. It must not
include resolved secret values.

### `McpRuntimeStatusSnapshot`

Short-lived. Produced by `check`, `sync-tools`, and optional status reads.

Fields:

- `serverId`
- `checkedAt`
- `expiresAt`
- `status`
- `serverInfo`
- `protocolVersion`
- `toolCount`
- `missingSecretRefs`
- `authStatus`
- `latencyMs`
- `errorCode`
- `message`

Snapshots are runtime observations. They are allowed to be cached briefly, but
they are not part of the durable server config contract.

### `McpAuthStatus`

Status-only.

Fields:

- `kind`: `not_required | configured | missing | access_denied | store_unavailable | invalid_ref`
- `refs`
- `message`

No OAuth token, bearer token, header value, or env value is ever exposed.

### `McpToolCatalog`

Durable tool metadata produced by explicit sync.

Fields stay close to the existing `McpTool` model:

- server id,
- raw/display names,
- input schema,
- callable namespace/name,
- side-effect level,
- default approval,
- enabled flag,
- first/last seen timestamps.

Tool catalog rows never contain secret values or auth artifacts.

## Secret Model

MCP must use the shared `SecretResolver` boundary.

For stdio transports:

```ts
{
  type: "stdio",
  command: "node",
  args: ["server.js"],
  env: {
    NODE_ENV: "production"
  },
  secretEnvRefs: {
    GITHUB_TOKEN: "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN"
  }
}
```

For streamable HTTP transports:

```ts
{
  type: "streamable-http",
  url: "http://127.0.0.1:3000/mcp",
  headers: {
    "X-Client": "ling-stack"
  },
  secretHeaderRefs: {
    "X-Api-Key": "keychain:MCP_REMOTE_API_KEY"
  },
  bearerTokenRef: "env:MCP_BEARER_TOKEN"
}
```

Rules:

- static `env` and `headers` may contain only non-secret values,
- `secretEnvRefs`, `secretHeaderRefs`, and `bearerTokenRef` store refs only,
- use either `secretHeaderRefs.Authorization` or `bearerTokenRef` for the
  Authorization header; `bearerTokenRef` is the shorthand for `Bearer <value>`,
- `envHeaders` should be deprecated or converted to explicit secret refs,
- raw `secrets` request bodies are transitional only and should be rejected for
  new persistent writes once the P2 migration lands,
- public responses may expose refs and configured status, never values.

## API Plan

Keep the existing route family and change the payload semantics.

```http
GET /mcp/servers
POST /mcp/servers
GET /mcp/servers/:id
PATCH /mcp/servers/:id
DELETE /mcp/servers/:id
POST /mcp/servers/:id/check
POST /mcp/servers/:id/sync-tools
GET /mcp/servers/:id/status
GET /mcp/tools
```

`POST /mcp/servers/:id/check` returns:

```json
{
  "server": {},
  "statusSnapshot": {}
}
```

`POST /mcp/servers/:id/sync-tools` returns:

```json
{
  "server": {},
  "statusSnapshot": {},
  "tools": []
}
```

`GET /mcp/servers/:id/status` returns only a recent non-authoritative snapshot
and is allowed to say `unknown` or `expired` without opening a live MCP
connection.

`GET /mcp/servers/:id/secret` must be removed or return `410 Gone`. Clients that
need status should use `GET /secrets/status?ref=...&purpose=...`.

## Runtime Execution Flow

1. A run starts through the daemon as it does today.
2. The daemon loads durable MCP config and cached tool catalog rows.
3. The daemon builds a `RunMcpToolAccessSnapshot` from config, cached tools, and
   secret status only.
4. When the runner calls an MCP tool, the trusted daemon path resolves secret refs
   with `SecretResolver`.
5. The broker creates a short-lived client, performs the call, redacts resolved
   values from logs/events/artifacts, and closes the client.
6. Run snapshots and artifacts record MCP server ids, tool names, approval state,
   status codes, and redacted errors only.

No raw secret value crosses into runner snapshots, Web state, doctor JSON, logs,
or artifacts.

## Stdio Launcher Separation

P2 splits MCP runtime ownership into three small pieces:

- `McpBroker`: owns MCP operations such as `checkServer`, `listTools`, and
  `callTool`.
- `McpTransportFactory`: builds SDK transports from config plus resolved secrets.
- `McpProcessLauncher`: owns stdio child process command, cwd, environment,
  stdin/stdout/stderr placement, lifecycle cleanup, and process-level errors.

This keeps protocol behavior testable without making every protocol test launch
a process. It also gives Desktop a future place to own process placement without
rewriting MCP protocol calls.

## Migration Plan

Implemented P2 migration behavior:

1. Add secret-ref transport fields:
   - `secretEnvRefs`,
   - `secretHeaderRefs`,
   - `bearerTokenRef`.
2. Keep old fields readable long enough to report migration status.
3. Stop writing new rows to `mcp_server_secrets`.
4. Remove or disable the raw secret read endpoint.
5. Change create/update validation to reject raw `secrets` for persistent writes.
6. For existing `mcp_server_secrets.secret_value` rows:
   - report `migration_required`,
   - do not silently copy values into Keychain,
   - offer a later explicit CLI/Web migration flow if needed.
7. Move persisted `McpServer.status` into a runtime snapshot cache or remove it
   from the durable server row.
8. Update tests so the new failure mode is visible and intentional.

## Doctor And CLI

Doctor stays read-only.

Doctor may report:

- config schema validity,
- enabled/disabled server counts,
- secret ref status,
- migration-required raw SQLite secret rows,
- last cached tool count,
- last status snapshot age,
- stale or missing status snapshot.

Doctor must not:

- open live MCP connections by default,
- sync tools,
- read raw secret values,
- write status rows,
- repair config.

Future CLI commands may be added after P2:

```text
ling-stack mcp list
ling-stack mcp check <server-id>
ling-stack mcp sync-tools <server-id>
ling-stack mcp status <server-id>
```

Those commands should call the daemon API and preserve JSON stdout redaction.

## Test Plan

- create/update accepts secret refs and rejects raw persistent secret values,
- public MCP server responses never include secret values,
- `GET /mcp/servers/:id/secret` returns `404` or `410`,
- `check` returns a status snapshot without mutating durable server config,
- `sync-tools` returns a status snapshot and persists tool catalog rows only,
- broker resolves values through `SecretResolver` only inside trusted call paths,
- stdio process launching is testable separately from MCP protocol behavior,
- new writes do not insert into `mcp_server_secrets.secret_value`,
- existing raw rows surface a migration warning without exposing values,
- doctor JSON contains status and remediation only, never raw secrets,
- run events, snapshots, and artifacts redact resolved MCP secrets.

## Completion Criteria

P2 is complete when:

- MCP persisted config, runtime status, auth status, and tool catalog have separate
  ownership,
- new MCP writes do not store raw secret values in SQLite,
- no MCP raw secret endpoint remains available,
- check and sync create short-lived status snapshots,
- doctor reports MCP status read-only and redacted,
- existing MCP tool access still works under runner approval policy,
- no MCP secret value appears in `WORKFLOW.md`, SQLite new writes, logs, doctor
  JSON, run snapshots, or artifacts.
