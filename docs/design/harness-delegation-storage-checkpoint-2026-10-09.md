# H10 delegation persistence checkpoint, 2026-10-09

## Scope and current missing implementation

Continue the independent Lane C of the approved
[Harness plan](ling-harness-gap-closure-implementation-plan.md) on the existing
`codex/e6-safe-continuation` tree. Foundation has public `DelegationStepV1` and
`DelegationMessageV1` contracts, a pure transition helper and a read-port shape.
The bounded production SQLite read store is now implemented and verified.
There is no authenticated delegation writer or durable dynamic child runtime.
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
- `DelegationQueryStore` now has three complete-or-error reads and two explicit
  live-page queries, backed by the verified SQLite reader. It has no mutation,
  authenticated producer or root reservation port. Reads/mapper and a strictly
  non-executing planned intent are not actual spawn or G19/G20 acceptance.
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

## Writer contract review — in progress, 2026-10-09

Fixed target: the **Subsequent writer gate** in this document, not the completed
migration/read prerequisite, Pi/Expo migration, old UI work or another checkout.
Review session: `0-1791490840-bf520289`; baseline `d095da29`.
This is a pending contract review, not an approved implementation or completed
engineering review. Architecture decisions must resolve before the remaining
Code Quality, Test, Performance and outside-coverage stages can finish. No new
product source, native build, live provider call or test run occurred here.

### Scope Challenge record

Scope accepted as-is: trusted frozen delegation facts, current parent Attempt
fencing, full Run ancestry, root reservation/settlement and atomic child create.
Reuse existing domain, SQLite Store and Daemon admission boundaries; no second
orchestrator, scheduler service, batch table or rewrite of accepted workflows.
The existing approved H10 behavior and its necessary tests/docs stay together.
Writer module/file counts remain estimates until its contract is selected;
there is no reason to cut an already approved feature to reduce file count.
The user explicitly authorized continuous internal chains and waived repeated
file-count confirmations; no new file-count approval was requested.

Prior completed implementation and its receipts are reused, not rerun. The
Pi/Expo user addition is already covered by
[the migration checkpoint](pi1-expo57-migration-checkpoint-2026-10-08.md): exact
Pi 1.1.0 and supported Expo57 pairing are implemented; fresh packaged macOS and
Mobile native/device acceptance remain open. A prior bundle/test receipt is not
a fresh GUI or native-device receipt. No cloud CI, push, merge or credential
mutation is authorized by this review.

Known reuse: `runExecutionOwnerSql`, the existing complete evaluation ancestry
walk, revisioned Store transactions and disposable SQLite fixtures. Existing
Goal terminal accounting is not reservation authority. Existing SHA-sealed JSON
is not Host policy provenance. Public read pages are not a fan-in snapshot.
Prior learning applied: `ling-t6-package-tests-not-landing-clearance` and
`office-source-only-needs-exports-snapshots-metafile` (observed, confidence 10/10).
Aside and general WebSearch are unavailable in this host; no new web-research
coverage is claimed. Existing authored source and approved design are the
evidence; no provider or UI behavior is inferred from undocumented external code.

### Architecture finding F1

**[P1 for dynamic activation] (confidence 9/10), Root and independent reader
`delegation_migration_adversarial`: root budget authority is not yet specified.**

Motivating approved contract: the Harness plan's Root Budget section says
"Children reserve from root remaining capacity; unused reservation returns on
terminal completion." This requires a single authority before atomic spawn.

Current evidence, not a proposed implementation:

- `packages/contracts/src/threads.ts:110`: `readonly tokenBudget?: number;`.
  The current Goal supports a token bound, not the complete root budget contract.
- `packages/daemon/src/features/runs/threads.ts:242`:
  `const nextTokensUsed = goal.tokensUsed + additionalTokens;` is inside
  `syncLingThreadGoalForTerminalRun`, with the budget check at line 292.
  This terminal read/modify/write tally does not reserve sibling capacity.
- `packages/core/src/run-types.ts:1218-1220`: `taskSnapshot`,
  `providerSnapshot` and `requestSnapshot` are `unknown`, not a typed trusted
  root-budget producer. `RunSession`/`CreateRunInput` must not be credited with
  an authenticated budget just because these JSON containers exist.
- `packages/daemon/src/config.ts:188-191`: delegation config currently contains
  `mode` and `maxDepth`, not a root budget producer or ledger.
- `packages/core/src/harness/delegations.ts:76-89` compares supplied parent/child
  numbers only; it neither authenticates their source nor reserves descendants.

This finding does not reopen the completed read/store/schema decisions. The
root authority, time meaning, price authority and effective inherited child
cap are independently selectable. Selecting one must not silently settle the
others, change any numeric default or activate dynamic children.

## Decision ledger

### R1: root budget authority

Finding: F1, P1 for activation, confidence 9/10; evidence above. Reviewers: Root
and `delegation_migration_adversarial` (read-only native review, not outside voice).
Plan baseline: approved H10/G20 requires root accounting and atomic reservation;
the root source is explicitly unresolved in the preceding writer gate. The
user's instruction to complete internal chains approves that scope, not a new
budget authority or numerical default.
Runtime evidence: Goal token accounting exists only as terminal tally; there is
no authenticated root budget producer/reservation ledger in the inspected code.

Comparison grid:

| Independently selectable value | Current | A | B | Approval |
| --- | --- | --- | --- | --- |
| R1 authority source | unspecified | Host-owned immutable snapshot scoped to RootRun | remains unspecified; bounded comparison with Goal authority only | pending |
| Root child reservation/atomic create | required, not implemented | unchanged required contract | unchanged required contract, no implementation while source pending | approved H10/G20 |
| Existing Goal behavior | current terminal accounting | preserved; may be an explicit snapshot input, not mutable root authority | preserved during investigation | current behavior retained |
| Numeric defaults / UI configuration | unspecified for root writer | still pending, not selected by A | still pending | not decided here |
| R2 time definition | unspecified | still pending | still pending | not decided here |
| R3 trusted pricing | unspecified | still pending | still pending | not decided here |
| R4 effective child inheritance | helper intent, runtime producer unspecified | still pending | still pending | not decided here |
| Runtime activation / native acceptance | incomplete | not authorized or certified by A | not authorized or certified by B | existing gates retained |

Question D1:

D1 — 多 Agent 的根预算由谁作为权威？
Project/branch/task: Ling / codex/e6-safe-continuation / H10 writer。
ELI10: 多个子 Agent 同时接任务，必须从同一个账本预留额度。现在 Goal 只在任务结束后累计用量；如果直接拿它当并发预算，会出现各个 Agent 都看到同一份剩余额度的风险。
Stakes if we pick wrong: 可能重复分配预算，或修改长期目标时意外改变正在执行任务的限额。
Recommendation: A，因为 RootRun 专属的 Host 冻结快照能把执行权限和可编辑目标分开。
Note: options differ in kind, not coverage — no completeness score.
Pros / cons:
A) RootRun 冻结快照（推荐）
  ✅ 由 Host 在根任务准入时生成并持久化同一份不可变预算快照，所有子 Agent 从同一根账本预留，而不是自行声明总额度。
  ✅ 保留现有 Goal 的用量和状态行为，后续修改长期目标不会隐式改写已经启动任务的预算来源，也便于重启后追溯原依据。
  ❌ 需要补专用快照生产者和账本接线（human: ~1 day / CC: ~45 min，估算），数值默认、时间、价格和继承规则仍需分别落实。
B) 先比较 Goal 权威
  ✅ 先限定核对 Goal 创建、替换和更新对 RootRun 的绑定方式，复用现有额度入口的可行性会有具体源码依据而不是猜测。
  ✅ 保留当前 Goal、已有静态协作以及其他已批准工作不变；这只是讨论本项来源，不撤销 H10，也不自动选择任何预算数值。
  ❌ 本项仍未决定，动态委派不能据此启用（human: ~1 hour / CC: ~10 min，估算）；调查只比较来源，不实现或默认采用 Goal。
Net: A 直接确定执行预算的权威边界；B 只进一步比较来源，不改变其他待决规则。
Header: 根预算来源
Options:
A) RootRun 冻结快照（推荐）
由 Host 在根任务准入时生成并持久化同一份不可变预算快照，所有子 Agent 从同一根账本预留，而不是自行声明总额度。保留现有 Goal 的用量和状态行为，后续修改长期目标不会隐式改写已经启动任务的预算来源，也便于重启后追溯原依据。需要补专用快照生产者和账本接线（human: ~1 day / CC: ~45 min，估算），数值默认、时间、价格和继承规则仍需分别落实。
B) 先比较 Goal 权威
先限定核对 Goal 创建、替换和更新对 RootRun 的绑定方式，复用现有额度入口的可行性会有具体源码依据而不是猜测。保留当前 Goal、已有静态协作以及其他已批准工作不变；这只是讨论本项来源，不撤销 H10，也不自动选择任何预算数值。本项仍未决定，动态委派不能据此启用（human: ~1 hour / CC: ~10 min，估算）；调查只比较来源，不实现或默认采用 Goal。

State: pending
Actual answer: unanswered
Accepted scope: none for R1; approved H10 scope remains unchanged.
History: no prior R1 answer; no completed prerequisite or SDK migration reopened.

R2 (time), R3 (pricing) and R4 (effective child inheritance) remain pending and
will not be bundled into D1. Approval readiness has not passed. No completed
review log, clearance dashboard or success telemetry is claimed for this review.
