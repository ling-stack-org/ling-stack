# H10 delegation persistence checkpoint, 2026-10-09

## Scope and current missing implementation

Continue the independent Lane C of the approved
[Harness plan](ling-harness-gap-closure-implementation-plan.md) on the existing
`codex/e6-safe-continuation` tree. Foundation has public `DelegationStepV1` and
`DelegationMessageV1` contracts, a pure transition helper and a read-port shape.
There is no production delegation SQLite store or durable dynamic child tree.
Neither an accepted static workflow nor a nested activity renderer supplies
that missing persistence. Do not redo the completed UI or Pi migration.

The old migration reservation 138 collides with channel-proposal CAS. At the
inspected head 153, add **154/create_delegation_tree_v1**, without replacing old
markers, backfilling children, changing accepted workflow graphs or introducing
a display-batch table. The historical `139/create_delegation_tree` marker has a
different identity and is preserved; its name is not reused or treated as proof
of the V1 schema. Incompatible same-named tables still refuse startup.
This checkpoint is the migration prerequisite of H10,
not an assertion that G19/G20 or runtime spawn/recovery are complete.

## Module boundaries

- Contracts/domain: reuse the existing V1 field and state unions. No public
  mutation API, generic authority callback or runtime activation in this slice.
- SQLite migration: dedicated `delegation-migration.ts`; enforce structural
  identities, safe-integer limits, immutable bindings, one child binding,
  legal revisioned transitions, terminal fencing and append-only messages.
- Startup registration: call the new migration under the existing serialized
  migration lock and normal release-migration gate. Existing legacy migration
  fixtures retain their intentional gate; no new production bypass flag.
- Packaging: every new runtime leaf must be an explicit required hashed source
  review input. Actual esbuild metadata must include that source, not workspace
  dist. Missing review/mutated bytes refuse before building. This is required
  inventory, **not production source-review approval**.
- Verification: actual disposable SQLite files, public store startup/reopen,
  fault injection and direct constraint attempts; no real user database.

## Persistence invariants and remaining authority boundaries

Step identities bind root/parent Run, source Attempt, optional workflow and
parent delegation, spawn call, objective and capability snapshot artifacts.
Budget/artifact/lineage fields never change in place. The natural spawn identity
`(parent_attempt_id, spawn_call_id)` is unique independently of caller-provided
idempotency keys. `INSERT/UPDATE OR REPLACE` cannot evict either logical spawn,
step, child or message identity, including with recursive triggers disabled.
A child Run binding is
null until spawn and then immutable, with unique ownership. A terminal step
cannot be reopened or have a late child attached. Updates advance revision by
exactly one and follow the existing domain transition graph. Messages contain
sealed-body references/digests and reject update/delete/replace, not editable
conversation narration. Foreign keys retain referenced rows; these keys prove
existence, not authenticated actors, frozen artifact contents or execution.

No SQL migration certifies current Attempt fencing, capability subsets, actual
provider scope, root budget reservation, active child leases or child completion
evidence. Those checks must exist in the subsequent store/coordinator and the
atomic child-create/reservation transaction before production spawn. Required
transitive fan-in remains the later H12 gate. No new model/child process can run
merely because its table exists. No schema-row count is completion evidence.
The tree-edge trigger proves only the delegation-ID parent/depth linkage. It
does not resolve the actual Run ancestry or detect cycles built by independently
claimed root/parent Run references; the later Store must walk that ancestry,
bind the exact source Attempt and refuse false roots/cyclic Run lineage.
Foreign-key RESTRICT retains workflow history; once this overlay has rows,
channel/workflow hard deletion must refuse rather than erase those records.
Activation must add an explicit deletion conflict response and its UI/API tests;
an empty migration does not claim that future product behavior is already wired.

Migration checks compare the intended schema, indexes, foreign keys and trigger
definitions, not only their names. A conflicting version/name or incompatible
same-named table refuses without replacing data. Missing expected index/trigger
is repaired only for the intended schema. Postconditions and foreign-key checks
precede the recorded marker and commit; failure rolls back only the transaction
owned by this migration. Caller-owned transactions must never be rolled back.

## Acceptance status

The migration prerequisite is implemented and its frozen whole-Daemon
verification has completed. Preserve original failure logs separately from
passing candidates; this is not runtime delegation or packaged acceptance.
Current authored migration SHA-256 is
`b3b5b8ab9ba33a03e1e2ffa7d8b6d0725f9ca05971d40f485581874626e93170`;
the migration test SHA-256 is
`8b2dde0639f4621cef637435aa63dd66cebd0176fdaa08076ee59db97e4e8dc1`.

Actual disposable SQLite tests found two defects before saving the checkpoint:

- A single parent Attempt/spawn call could create two delegation rows by changing
  caller keys. The independent RED failed with `Missing expected exception`;
  the natural unique index and explicit replacement guard fixed it.
- The proposed unversioned migration name collided with the known historical
  `139/create_delegation_tree` marker. Core full failed 1 of 2,460 tests, and a
  new public-startup reproduction failed 0/1. The unpublished migration now has
  its own V1 identity. Historical markers and the old approval regression were
  not edited. The positive case preserves every old marker across two public
  reopens; a negative case proves an old marker cannot hide incompatible tables.

Fresh current-source evidence under `output/e6-20260928/`:

| Gate | Result | Raw receipt |
| --- | --- | --- |
| Node 22 migration + existing approval | 114/114, exit 0 | `delegation-migration-v1-core-focused-20261009.tap` |
| Node 24 migration | 37/37, exit 0 | `delegation-migration-v1-node24-final-20261009.tap` |
| Node 22 Core full | 2,462/2,462, exit 0 | `delegation-migration-v1-core-full-final-20261009.tap` |
| Node 22 Desktop full | 1,878 pass, 3 Windows-only skips, exit 0 | `delegation-migration-v1-desktop-full-final-20261009.tap` |
| Daemon startup/config/health/continuation/approval/input neighbors | 88/88, exit 0 | `delegation-migration-v1-daemon-neighbors-isolated-final-20261009.tap` |
| Effective-config isolated fixture | 4/4, exit 0 | `delegation-migration-effective-config-isolation-green-20261009.tap` |
| Node 22 Daemon frozen full | 3,672/3,672; zero fail/cancel/skip/todo; exit 0 | `delegation-migration-v1-daemon-full-frozen-final-20261009.tap` |
| Workspace typecheck | exit 0 | `delegation-migration-v1-workspace-typecheck-final-20261009.log` |

Desktop's actual esbuild metadata includes the exact migration SHA above and
zero runtime dist inputs from the nine authored workspaces. Missing review
digest, changed bytes and absent source all refuse before builders. Native
compiler/signing assertions are synthetic; no production review was issued.
The old whole-Daemon launch was stopped with exit 1 after it exposed other
pre-existing fixtures using the checkout as the default workspace. Its failed
raw log is retained and is not a passing receipt. Harness/effective-config
fixtures now own and close temporary Stores. The new whole-Daemon process
uses a separate default workspace/user root for each test process, without
resetting the earlier test database or disabling runtime locks. The first
process-isolated whole run reported **3,671/3,672**, exit 1: the only remaining
failure explicitly used `resolve(".")` in the Computer Use relative-path fixture.
That fixture now uses a temporary workspace's relative path; its full module
passes **29/29**, including the unchanged route authorization and canonical
path assertions. The final frozen whole-Daemon process, session 82381, returned
exit 0: **3,672/3,672**, zero fail/cancel/skip/todo, in 664,278.536375 ms.
All eight source/test SHA-256 entries were reread and match the frozen manifest.
Save this only as a local checkpoint, not a release gate.

The tested source is saved in local checkpoint `3945ce8b`; save the final
verification receipt separately before continuing the store gate.
H10/T10, H11/T11, H12/T12 and original packaged macOS gates remain unchecked.

No new user policy decision is required for this additive migration slice.
Office's isolated-Keychain permission and H09's authenticated producer/budgets
remain independent unresolved gates; this work neither answers nor bypasses
them. No cloud CI enablement, push, PR, merge or publication is part of this
local checkpoint.

## Next Store gate, not an authenticated producer yet

### Additive read prerequisite

Implement the existing three `DelegationStore` reads with a focused SQLite
store and strict row mappers. `RunStore` extends the shared read facet rather
than redefining its signatures; its existing large facade only delegates.
The constructor receives the database context, not Runner, policy, artifact
body, current-Attempt or budget authority. This slice adds no mutation or API
route, creates no children and does not change the migration or feature flags.

The two array-returning legacy lists mean **complete or explicit failure**:
read at most 1,001 rows and throw typed `read_limit_exceeded` if the collection
exceeds 1,000. Never silently return a partial array as a complete child set.
Separate additive `queryDelegationChildren` and `queryDelegationMessages`
methods return `items`, `hasMore` and an optional `nextCursor`. Page limits
default to 200, with a maximum of 1,000; invalid values fail rather than clamp.
This bound limits row count, not payload bytes.

Keyset cursors bind schema version, query kind, exact scope ID and the last
returned row's original `(createdAt, id)`. The schema only guarantees nonempty
date strings; keep them unchanged and compare/order with SQLite BINARY
semantics. Do not normalize through `Date.parse`, use the lookahead row as the
cursor, or accept a children cursor for messages or another scope. These are
live discovery pages, not an atomic tree snapshot. A concurrent append before
the cursor can be missed; `hasMore=false` is never a required-child completion,
authorization or root-budget decision. Later fan-in must use its own atomic
authoritative query, not page exhaustion.

Mappers require every selected column, distinguish SQL NULL from a missing
field, accept only 0/1 booleans and safe-integer numeric fields, and validate
contract enums/digests and single-row child/terminal invariants. Bad rows fail
the read rather than disappearing into a healthy-looking subset. Artifact IDs
remain references; mapping does not authenticate their contents, Run ancestry,
policy provenance or current execution ownership. Do not add current max-depth
or canonical timestamp assumptions to historical reads.

Acceptance must cover actual temporary SQLite reopen through the public facade,
same-time keyset order, scope isolation, limit boundaries, malformed cursors,
complete nullable mapping, poisoned-row rejection and no data/schema writes.
Every new runtime leaf must also enter the existing explicit source-review
inventory and actual-esbuild missing/mutated/absent-source rejection matrix.
The read prerequisite is implemented and frozen. Final-source Node 22
reader/migration tests pass 48/48; Node 24 reader tests pass 11/11; Core full
passes 2,473/2,473; Desktop full passes 1,886 with three Windows-only skips.
Fresh Core/Daemon builds and final workspace typecheck pass. The original
feature-missing RED and two revoked-Proxy RED cases are preserved separately.
Exact bigint reads plus strict mapping reject poisoned SQLite integers with
typed errors; input capture never leaks the revoked-Proxy IsArray TypeError.

Actual esbuild includes the frozen Store SHA
`b33ec94ccdc6732101de0a830642e9344a9fd387f21d586646380dbf1aeaf77e`
and mapper SHA
`d49b765fd37ce7a840cb7d112317ab776e79b3e5075017e83cd73561ecb7ecbc`,
with zero workspace-dist runtime inputs. New-leaf missing-review, mutation and
missing-source cases reject before builders. The nine-path source/test manifest
and raw final receipts are under `output/e6-20260928/delegation-store-*`.
The final frozen whole-Daemon process (39039) returned exit 0:
**3,672/3,672**, zero fail/cancel/skip/todo, in 743,084.235333 ms. All nine
manifest entries matched on the post-terminal reread. Source checkpoint
`55172c7e` saved 11 files (+708/-1); the tree remains clean and unpublished.
The read prerequisite and its full regression gate are complete. This remains
a local checkpoint, not G19/G20, packaged/device acceptance or publication
approval. Do not repeat terminal test handles when continuing the writer gate.

### Subsequent writer gate

The next mutation must validate the exact captured Attempt fence inside its
write transaction using the existing `runExecutionOwnerSql` predicate, not
merely an Attempt lookup or a fence-shaped object. Resolve full Run ancestry
with missing-parent/cycle bounds and verify workflow/step lineage. FK presence
does not certify any of these relationships.

The read-only prerequisite audit identifies these actual reusable seams:

- `run-execution-admission.ts` checks Run/WorkUnit/current Attempt/token/live
  ownership in the writer SQL. A new spawn must additionally require a running
  parent rather than treating queued/created or cleanup authority as execution.
- Evaluation's private root resolver walks complete ancestry with missing-parent,
  cycle and depth rejection. Reuse that behavior through a focused shared helper,
  not a new direct-parent shortcut or a new meaning for delegation depth.
- Artifact creation and evaluation consumers support sealed JSON plus recomputed
  digest/owner checks. They do not authenticate permission/tool/workspace/provider
  role facts or pin immutable expected bytes for delegation. The tool Store's
  policy-owner check alone is insufficient for this gate.
- `DelegationStore` still exposes only three reads and has no SQLite implementation.
  Reads/mapper and a strictly non-executing planned intent can be separated from
  actual spawn; never report them as G19/G20 acceptance.
- Thread Goal's terminal usage tally and the runtime semaphore are not a root
  reservation ledger. No existing ledger atomically accounts sibling allocation,
  settlement/refund or a trusted frozen money-price source.

Verify frozen policy artifacts and their scope before reservation; a JSON SHA
proves integrity, not a Host-produced permission or capability decision. Root
token/cost/time accounting and atomic child creation are required before
enabling runtime spawn. These are separate from this empty-schema checkpoint;
the read-port, a nested renderer or a successful row insert is not their proof.
Do not enable dynamic children or rewrite accepted static workflows first.

Unresolved for the later runtime contract: the authoritative root budget source,
root wall deadline versus accumulated execution time, trusted cost pricing and
the persisted effective value of inherited child limits. These do not block
the empty-schema checkpoint, but must be specified and tested before G19/G20
or any dynamic spawn activation. No fabricated budget/permission producer is
permitted as a substitute.
