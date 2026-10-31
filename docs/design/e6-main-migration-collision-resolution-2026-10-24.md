# E6 / main migration176 collision resolution

## Historical ownership and canonical markers

The main work-summary feature and the E6 delegation ledger independently assigned
version176 to different migrations. Neither historical marker, its timestamp, nor
its domain data may be rewritten to make the other branch appear installed.

| Domain | Accepted historical marker | Canonical marker |
| --- | --- | --- |
| Work-summary PR bindings | 176 / `create_work_summary_pull_requests` | 188 / same name |
| Delegation budget ledger | 176 / `durable_delegation_budget_authority_v1` | 189 / same name |

Fresh databases append188/189. Existing main databases retain176 and PR bindings;
existing E6 databases retain176 and their ledger. Canonical markers are appended
only after the relevant existing schema and facts pass validation. Unknown176
owners are rejected before work-summary creates a table or marker. A known name
at an unrelated version or a canonical version with another owner is rejected.

## Atomicity and recovery

Each migration owns its own `BEGIN IMMEDIATE` transaction. Required missing tables
on a recorded history are an error, never an invitation to recreate authority.
Missing derived indexes/triggers may be recreated only within that transaction;
changed definitions fail closed. Any validation or marker-write error rolls back
this migration's writes, preserving the original rows and damaged scene. A failed
nested BEGIN must not roll back a transaction owned by the caller.

The migrations do not replay tools, recompute usage, refund reservations, replace
prices, or alter permission/approval history. They are not a repair service for a
corrupt database. Later startup migrations remain individually atomic; this is not
a new all-migrations transaction or a promise that unrelated earlier startup work
is rolled back after every later failure.

## Historical ledger admission

Budget adoption and canonical reopen check exact schema, foreign keys, table
integrity, and the existing runtime row parsers. Cross-table checks additionally
validate durable relationships: root/authority/price ownership; reservation
root, parent, child, step and deadline; and charge Run/WorkUnit/Attempt/allocation.
Original token/cost reservations must fit their immutable root/parent allocation;
NULL cannot bypass a non-NULL limit. Dispatch timestamps must fit that allocation.

Do not reuse transient INSERT prerequisites as historical validation: a step may
be running or terminal, a parent reservation may be settled/released, and an
unclaimed child legitimately lacks its step binding. Do not sum all historical
reservations as simultaneous consumption. A measured Provider usage overrun is a
possible runtime fact, not grounds to reject an otherwise valid original reserve.

## Verification and delivery boundary

Use isolated temporary SQLite files and fresh Ling state/workspace variables,
never the packaged QA profile or user databases. Regression coverage includes
both176 histories, canonical reopen, row preservation, marker/schema conflicts,
rollback and caller ownership; injected invalid CHECK/lineage/cap data must be
rejected without blessing or rewriting it. Real nested/released/settled history
must still be accepted.

This resolves branch integration. Passing source tests is not packaged macOS,
real multi-agent/recovery, H09, release, or whole-E6 completion. Source evidence and
the independent review are recorded in
`output/e6-20260928/p3-main-integration-migration-20261024.md` and the adjacent
independent review report.
