# Business Data and API Compatibility Boundaries

## Purpose

Ling Stack has several schema generations in active use. Compatibility is a boundary
contract, not a second business model: new requests and mutable rows use the current
canonical shape, while historical records remain readable until an explicit cutover is
complete.

## Invariants

1. **Normalize at every trusted input boundary.** HTTP schemas, automation payloads,
   teammate settings, workflow templates, fork/resume requests, and readiness routes
   must turn historical aliases into the canonical value before validation or durable
   snapshot creation.
2. **Write only canonical mutable state.** Mutable operational bindings are migrated in
   a versioned SQLite transaction. Re-running the migration is a no-op and a failed
   update or marker write rolls back the whole transaction.
3. **Project immutable history on read.** Run snapshots, runtime events, and control
   plane evidence keep their original JSON bytes and fingerprints. Read mappers expose
   canonical IDs to current API consumers without changing audit/replay evidence.
4. **Do not infer authorization from a lossy compatibility field.** The new
   `authorizationMode` and `workspaceAccessMode` fields are authoritative when present;
   `permissionMode` and `permissionPreset` remain a deterministic read/write projection
   until the API cutover.

## Compatibility inventory

| Surface | Current rule | Removal gate |
| --- | --- | --- |
| SQLite historical rows | Keep versioned migrations and repair markers. Migration 177 canonicalizes mutable runner bindings in `ai_teammates`, `work_units`, `work_unit_attempts`, and `runner_continuations`. | All supported databases have applied the migration and rollback tests cover partial failure. |
| Runner IDs | Accept `pi-coding-agent` at old request/read boundaries, normalize to `pi`, and never write the alias again. | Alias usage telemetry is zero for one release and all persisted rows are canonical. |
| Permission fields | Read both the new independent axes and legacy `permissionMode`/`permissionPreset`; write the new axes plus the deterministic legacy projection where a persisted/API DTO still exposes it. | Every supported client reads the new axes and the API version no longer promises the legacy fields. |
| ComfyUI/media evidence | Keep `prompt_legacy` and `comfy_prompt_legacy_v1` decoders and evidence mappers. They describe historical protocol facts, not a preferred new execution path. | A versioned media-evidence migration and API cutover can prove no historical row or replay path needs them. |
| Web DTOs | Normalize historical snapshots in the server mapper/DTO boundary; do not make each page guess which schema generation it received. | All clients consume the canonical DTO and the old response shape is removed in a versioned API release. |
| Theme storage | Read old theme references through the storage migration/projection layer and emit the current theme manifest shape. | Existing user theme records have been migrated and the old manifest version is outside the supported window. |

## Runner implementation slice

`packages/core/src/runner-ids.ts` owns the alias table and recursive snapshot
projection. Daemon request schemas call it before runner resolution. SQLite writes call
the same canonicalizer, while mappers use the projection for immutable JSON. This keeps
the alias policy in one module instead of duplicating string comparisons across API,
runtime, and storage code.

The historical user-input continuation plan is validated against a canonical projection
of its request, task, provider, and runner execution input. Its stored fingerprint is
still checked against the original prepared input, so accepting a historical alias does
not authorize a changed continuation.

## Verification

The compatibility regression suite must cover:

- migration success, idempotency, and rollback on row-update or marker failure;
- old runner aliases from task, teammate, automation, workflow, fork/resume, and
  readiness inputs;
- canonical read projections for run snapshots, work-unit requests, runtime events,
  and control-plane events;
- historical user-input execution plans that retain their original fingerprint;
- legacy permission and media protocol fixtures remaining readable.

## Non-goals

This contract does not delete historical evidence, silently rewrite immutable snapshots,
or remove the old permission/media/theme fields before their API and storage cutover
has been versioned and verified.
