# T13A manual MCP metadata publication, 2026-10-09

## Scope and confirmed cause

Continue the original E6 goal in the dedicated `codex/e6-safe-continuation`
tree. Pi 1.1/Expo 57 migration is already saved and is not repeated. This
slice covers generic MCP `check` and `sync-tools`, not Provider refresh,
plugin health, model discovery, or external credential version authority.

Both routes read a server before an await, then unconditionally publish its
result. Same-config concurrent requests have no ordering fence. Sync writes
snapshot and deletes/inserts the catalog separately, so failure can expose
ready status with a partial catalog. Existing server/catalog revisions protect
tool execution, but do not represent metadata request order.

## Contract chosen for this slice

- Check and sync share a durable per-server request generation. **Last admitted
  request wins**, not first completion. A later check invalidates an earlier
  sync and vice versa, even if the later request is still pending or fails.
- Begin owns a short `BEGIN IMMEDIATE` transaction, captures the current server
  and existing server/tools revisions, and advances metadata request revision.
  Disabled servers remain checkable. No lock is held over network awaits.
- Migration 155 appends request/published revisions to the existing authority
  table, preserving its delete/recreate tombstone. The existing two-field
  `getMcpAuthorityRevision` and tool-execution semantics remain unchanged.
- Commit owns a separate synchronous `BEGIN IMMEDIATE` transaction. It verifies
  generation, server revision, tools revision, existence and one-time use; then
  writes snapshot, optional ready-sync catalog, consumed revision and durable
  control-plane event together. Errors roll back all these writes.
- Catalog methods retain their existing caller-owned-transaction behavior so
  bundled Cua activation is not broken by a nested `BEGIN`.
- Only a successful COMMIT returns an event for Hub broadcast. A superseded
  HTTP result is 409 `mcp_metadata_result_superseded`, with no stale server,
  snapshot or tools. Published responses use the server read in the transaction,
  not the old pre-await object.
- Check emits `mcp.status_checked`; successful sync emits `mcp.tools_synced`.
  Failed sync emits `mcp.tools_sync_failed`, persists its failed snapshot, and
  preserves the last catalog rather than deleting it.
- Duplicate publication is rejected before modifying snapshot or catalog.
  A failed transaction does not consume the request, so retrying that same
  still-current request is safe. A newer admission supersedes it permanently.

Core port shape: `beginMcpMetadataRequest(serverId, kind)` returns an optional
`{server, kind, requestRevision, serverRevision, toolsRevision}` ticket.
`commitMcpMetadataResult({request, statusSnapshot, tools?, cwd, now})` returns
`{published:false, reason}` or `{published:true, server, statusSnapshot,
tools?, event}`. Core owns event action/data/idempotency, not caller-provided
event JSON. Ticket revision numbers must be safe nonnegative integers; request
revision must be positive. No ticket is put on HTTP/SSE.

## Explicit remaining boundaries

This is **not full T13A closure**. Credentials resolved by the broker may rotate
outside Ling; existing `SecretResolver` has no version authority. Config/request
CAS must not be described as credential CAS or transactional external Keychain
isolation. Provider manual/startup/import, discovery, runtime observation and
UI request-key invalidation remain separate unfinished producers.

No real database, credential, Keychain, packaged approval manifest, signing,
release, push or cloud CI mutation is part of this slice. The existing writer
design WIP is untouched. Fresh packaged macOS and native Mobile gates remain
open; previously accepted duration/R03/layout cases are not reworked.

## Verification plan and current verdict

Start with deterministic deferred HTTP races against the old production build.
Then test Core on temporary SQLite with two independent connections, restart,
same-timestamp delete/recreate, enabled/config/catalog changes, duplicate use,
tool/event write failure and transaction ownership. Run fresh Core/Daemon
focused tests, broader regressions, workspace types and Desktop source-input
admission after implementation. Record RED and final source-bound receipts.

## Implementation and evidence

The production Core publisher and migration, facade/types and shared Daemon
manual service are implemented. The old raw primitives remain usable inside
Cua's existing transaction. The required Desktop review inventory now includes
every new runtime leaf; this is not a real approval manifest or signing permit.
Sixteen source/test/input files are frozen by
`output/e6-20260928/t13a-mcp-final-source-20261009.sha256`.

Additional root causes were reproduced and fixed during independent review:

- `toPublicMcpServer` reread current SQLite snapshot after COMMIT, so the nested
  response could contain B while its top-level receipt contained A. Two real
  HTTP tests were RED 0/2. Both manual responses now project their committed
  snapshot explicitly; ordinary GET continues to read the latest snapshot.
- A throwing Hub listener turned a committed metadata result into HTTP failure.
  The actual service/SQLite test was RED 0/1. Notification errors now emit a
  fixed, non-secret operational warning and retain the successful receipt;
  the durable event is available for replay. No error details are logged.
- The shared catalog replacement read only the default 200-item public page,
  resetting later tools' firstSeenAt. A 503-tool resync was RED 0/1. Replacement
  now reads complete raw-name/first-seen columns; public responses stay bounded.
- Unsafe historical SQLite revisions caused a Node RangeError before validation.
  Read exact BigInts, then enforce safe revision range. The first focused source
  run was 23/25; the corrected final targeted run is green.

The event no longer serializes a request-derived idempotency key. One-time
consumption and its event are in the same transaction, so duplicate use cannot
rewrite state or add events. Request tickets/revisions remain Host-private.

Final source-bound verification so far:

- Node 22 Core/publication/catalog/delegation/notification neighbors: **79/79**.
- Node 22 HTTP focused: **14/14**; complete API file: **19/19**.
- Node 24 combined same neighbors and HTTP: **98/98**.
- Node 22 complete Core suite: **2,564/2,564**, zero fail/cancel/skip/todo.
- Workspace typecheck: exit 0; Desktop reviewed authored-source admission:
  **56/56**. This uses real esbuild but synthetic native/sign inputs, not App
  or production signing acceptance.
- Actual temporary schema154→155 reopen preserves historical server/catalog/
  snapshot/tombstone/old revisions/triggers/154 marker. DDL and marker faults
  roll back; malformed marker/partial-column history fails closed. The older
  schema153 test now reconstructs actual153 and permits only the explicit155
  two-column change while still checking all other historical SQL/rows/markers.

Raw first-Core-full 2,549/2,550 is retained: its old153 fixture was actually
latest-minus154, leaving155 installed. It was not a production migration
failure; the corrected historical fixture passes the final full run. Initial
HTTP fixture failures were likewise before broker execution and are not the
actual RED. True race RED is **2 pass / 10 fail** with old results returning200
instead of409. The unfinished first Daemon-full was stopped before final
source changes and is not a final receipt. All original RED logs are retained.

Final Daemon/Desktop whole-suite runs are pending; do not infer their verdict
from these focused passes. No unresolved ordering choice in this slice.
External credential authority and other T13A producers remain unfinished.

## DEBUG REPORT

Symptom: stale manual checks/syncs overwrite new metadata; partial catalog or
mixed responses can look successful, and live-notification failure can look
failed after a real commit.

Root cause: no durable request generation, separate projection writes and
post-COMMIT current-state reread/unchecked listener exception.

Fix: latest-admitted ticket plus server/catalog CAS; one SQLite transaction for
snapshot/catalog/consumption/event; committed-snapshot response; notification
failure retains receipt; full catalog firstSeenAt preservation.

Evidence: true HTTP RED→GREEN, SQLite two-connection/reopen/rollback cases and
source-bound final Core/Node24/API/typecheck/packaging-input tests above.

Status: implementation and focused/complete Core verification passed; final
Daemon/Desktop full verdict still pending. Whole T13A/Harness/E6 remains active.
