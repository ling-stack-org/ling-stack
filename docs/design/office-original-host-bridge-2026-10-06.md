# Office T2 — original Store/Host bridge binding

## Boundary

The internal `@ling-stack/core/original-office-host-bridge` subpath creates
separate opaque reader and setup handles. The actual `SqliteRunStore`
constructor captures the reader before filesystem or database initialization.
The fixed trusted startup composition retains the setup handle and installs
one frozen synchronous Host endpoint against that exact Store instance.

Setup custody is the trust boundary. Hidden exports, TypeScript brands,
matching JSON or the first arbitrary callback do not establish genuine Host
authority. The fixed Host endpoint must independently validate its own private
custody map. Core minting alone is not proof of that custody. This mechanism
does not isolate arbitrary malicious trusted Host JavaScript.

Reader/setup/authority identity is checked through private WeakMaps. Clones,
spread objects, proxies, foreign channels and reopened Stores cannot adopt an
original handle. A default Store has no implicit permissive bridge. Closing the
owning Store retires the channel.

## Binding lifecycle

`RunStore.bindHostOfficeLocalDirectoryScopeAuthorityV2(ticket, authority)`
accepts only the original live V2 ticket and constructor-bound authority.
It checks the original journal parent/producer, current Attempt owner and
forward admission. Effects, uncertain launches, close or terminal claims
preclude a late bind. Host receives a separate deeply frozen snapshot derived
from the owning execution row, not caller-supplied claims.

The synchronous endpoint runs inside the owning journal transaction's
read-only window. Nested Store snapshots can read that same window; writes and
non-void/Promise results are rejected. Arbitrary thenables are not executed.

Both the channel authority and ticket retain an irreversible entered latch.
Endpoint failure, reentry, return loss or the outer journal COMMIT failing
invalidate the entered binding. SQL rollback does not restore effect
admission. Preflight failure before entry does not consume a valid ticket.
Bound tickets also check the channel on every mutable operation, so a retired
bridge cannot continue effects when database close throws but leaves it open.

## Not yet enabled

This is the Core transport/binding slice only. It does not implement the fixed
Daemon private custody accessor, Registry canonical visibility window,
`closed_pending` protection retention, independent safe certificate or atomic
journal settlement. The V2 safe-unavailable verifier remains unchanged, as do
native-only `coreSafe: false` outcomes. No production MCP writer route is
enabled by this slice. Full Access/unrestricted same-UID processes remain
outside the controlled-process isolation promise.

## Verification

Node 22.22.1 local mechanism/SQLite tests: 22 passed, zero skips. A real outer
COMMIT failure first reproduced continued effect admission after failed binding;
the new irreversible invalidation closes that path. Both failure before COMMIT
and actual COMMIT followed by return loss are covered, as is database close
failure leaving an open connection with a retired channel. The six-file neighboring
V2/journal/read-snapshot suite passed 240 tests, zero skips. Fresh Core and
Daemon TypeScript builds passed. These are not genuine Host/native, hosted CI,
Office product or packaged GUI acceptance claims.
