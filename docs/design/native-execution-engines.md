# Native Execution Engines

Status: accepted design change; source implemented, final regression and release acceptance incomplete
Date: 2026-10-18
Owner: daemon runtime, Core durable authority, Desktop and Web settings

## Change and authority

This change adapts the current native engine work to main
`708931accf7bc7de4d67abf2939500e1369969a2`. The user explicitly chose to retire
the legacy endpoint-based Codex/OpenClaw execution paths and migrate to native
profiles. This supersedes the legacy activation/rollout sections of
[Runner Adapters](runner-adapters.md) and its old implementation plan. Historical
records remain readable; retirement never grants new execution authority.

The implementation plan is
[Native Execution Engines Implementation Plan](native-execution-engines-implementation-plan.md).
Fresh evidence belongs in
[Native Execution Engines Validation](native-execution-engines-validation.md).

## Functional requirements

| ID | Required resulting behavior |
|---|---|
| N1 | Production composition describes Pi, Codex, Kimi and OpenClaw, selects the explicitly bound native target, and fails closed without current trusted availability and workspace permission. |
| N2 | Legacy endpoint flags cannot activate an adapter, probe a private endpoint or execute a request. Legacy requests receive a migration explanation; native requests never fall back to Pi or the retired transport. |
| N3 | Workflow preparation captures the current owner, commits ready through Core CAS, and rechecks admission immediately before execution. Cancelled or superseded owners cannot execute or release a successor's resources. |
| N4 | Idempotent retries return the original Run without changing its thread, activeRunId, state, leases or execution count. |
| N5 | Every active attempt renews its heartbeat/leases and obeys the mainline idle, hard timeout, approval-wait and cancellation semantics. |
| N6 | Local execution and writers drain before durable completion; Core independently verifies native effect coverage and exact attempt identity before successor admission. Unknown effects remain blocked. |
| N7 | Guidance FIFO and redirect retain the original native binding and lineage, revalidate profile revision/auth/policy, and start exactly one successor only after the source is safe. |
| N8 | Workspace migration requires explicit native authorization, preserves deny-all, uses CAS and typed default bindings, and never upgrades legacy grants or silently changes an external default to Pi. |
| N9 | Settings, request producers and run projections use the same availability facts. Configured, installed, authenticated, connected and executable are separate claims. |
| N10 | Existing Pi, normal conversation, workflow, approval/input waiting, recovery, history, secret and platform safeguards retain their contracts. |

## Scope and capability truth

Pi remains the default for existing Pi requests. Native targets in this change
are Codex app-server over stdio, Kimi ACP and OpenClaw ACP. Claude profile and
connection management remain available where already implemented, but Claude
execution remains unsupported until a separate execution implementation and
acceptance exist. Registration does not imply support for every workflow surface.

Identity-bound acceptance includes runtime/SDK/adapter versions, executable digest,
platform/architecture, profile/revision/configuration, workspace, policy and surface.
Connection/login observations cannot substitute for release or execution evidence.
Expired, missing, revoked or mismatched evidence blocks execution. A trusted
candidate verifier can generate evidence; no public request or workspace boolean
may bypass acceptance or self-certify it.

The repository's isolated Codex candidate tool records fixed owned-execution
scenes and actual source/dist/executable snapshots. Its narrow scene results do
not certify production input/resource admission, cross-workspace enforcement,
authentication identity or signed packages. Full release checks remain not_run;
the tool neither publishes evidence nor changes the production admission path.
Its additional production HTTP rejection observation uses the existing embedding
options for a degraded, non-keychain secret resolver and a disabled browser broker.
It proves rejection without trusted evidence and preserves canonical input; full
default startup and successful production admission remain unverified. The current
production Codex target fixes modelProvider to openai, so an owned candidate using
cliproxyapi does not establish production configuration equivalence.
See the [candidate tool instructions](../../scripts/native-execution-engines/README.md).

## Execution and data model

`executionBinding` chooses `pi_provider` or `native_profile`. Native selection pins
engineId, profileId, profileRevision and the target's required model information.
The daemon rechecks current profile/auth/executable identity before launch and at
existing protocol authority points. No credential is copied into a Run snapshot.

Reuse the existing Run/WorkUnit/Attempt, Thread/Turn, native submission, approval,
Host-operation and output journals. Preserve the mainline canonical input and
workflow authority. Extract shared supervision/completion behavior rather than
copying the Pi orchestrator into another permanent control implementation.

Preparation order: validate structural request and workspace policy; resolve
idempotency; capture workflow owner; prepare the existing concurrency claim;
durably link the run; commit workflow ready; notify ready; register execution;
assert current workflow/attempt admission immediately before executing. Repeated
or failed preparation has no authority over a run linked by another request.

Protocol events supplied by native targets are already durably journaled. Forward
them once; do not append a second event with the same meaning.

## Request option projection

A caller's tool selection is an upper bound, independent of workspace approval
policy. Kimi intersects it with its supported native tools, profile configuration
and host policy; excluded tools cannot regain authority through approval or host
callbacks. The host-only selection participates in the native configuration
fingerprint, including recovery. It is not an ACP wire configuration option.
Codex and OpenClaw currently accept the complete Ling tool grant or an internal
request without a narrower tool selection. Explicit subsets, including an empty
list and the HTTP read-only default, are rejected before profile probing or native
execution because these integrations cannot guarantee the requested tool set.

Codex maps systemPrompt to native baseInstructions and appendSystemPrompt to
native developerInstructions; both participate in the configuration identity.
The current ACP integrations have no supported system-instruction slot and reject
explicit systemPrompt/appendSystemPrompt rather than changing their authority.
For ordinary ACP conversations, the trusted request builder preserves the typed
tone and original response-language preference, including follow_user, instead
of creating those system fields.
The dispatcher renders them as a separately labelled user-level preference block
before the task content. These are presentation preferences, not system-level
security instructions. Continuations and message replacements retain the original
typed language preference rather than freezing a previous inferred language. Existing
accepted ACP snapshots with explicit system fields are not silently rewritten.

## Supervision and terminal ordering

Use distinct heartbeat and meaningful-event clocks. Heartbeats renew the current
attempt's leases and must not refresh the idle clock. Idle/hard watchdogs share
mainline monotonic-clock and legitimate approval/input pause semantics. Stop
intent reaches owned execution; late success cannot overwrite cancellation.

ActiveRun registration includes run/workUnit/attempt/runtime/fencingToken. Its
lifetime covers execution and all enrolled local writers. A terminal Run is not
proof of physical completion or settled effects.

Core's existing Pi completion coverage types must not be reused to assert native
completion. Add typed native observations tied to native submissions and closed
effect inventories; Core independently validates them against the original
journals and current durable vetoes. Process exit alone does not prove remote
OpenClaw agent termination. Missing or unknown remote terminal evidence, approval
replies or Host effects withhold settlement and successor admission.

Ordering: close callback enrollment, drain execution/writers, resolve the original
lifetime, await durable completion, release only the exact owner's resources,
then invoke terminal successor callbacks. Never await a successor barrier from a
callback whose own return is required to resolve the barrier's source lifetime.
Keep recovery authority while effects remain unknown.

## Retirement and migration

Old `runners.codexAppServer.baseUrl` and `runners.openclawAcp.endpoint` flags remain
parseable for migration diagnostics but cannot activate code or cause fetches.
Native OpenClaw gatewayUrl/agentId/credentials are a different configuration and
remain supported. Do not delete shared protocol helpers solely because they
reside in a directory previously used by legacy adapters.

Version the existing workspace runtime settings with v2 semantics; retain the
single allowedRunnerIds authority and add a typed defaultExecutionBinding.
Unversioned legacy external grants are migration candidates, not native grants.
The user explicitly confirms the native allowlist/default using expectedUpdatedAt.
Missing settings seed only Pi; an explicit empty allowlist denies all. A stale
native default blocks for re-selection instead of selecting a newer profile or Pi.

Migration is previewed before writing. Preserve history and make consistent
backups; do not copy only the main file of an active WAL database. Active legacy
runs must finish or be reconciled under their original authority before cutover;
unknown remote effects cannot be repaired by replaying the task through native.
Safe profile references may be reused after verification, but endpoint credentials
cannot be guessed to be native login or model credentials.

## Regression and rollback

Behavior tests run at the agreed public interfaces: daemon production composition,
workflow dispatch, ActiveRun/supervision, Core completion journals, continuation
FIFO and workspace settings/client interfaces. Use real temporary SQLite stores
and controlled protocol targets for deterministic failure cases, then validate
actual engines and target platforms separately.

Rollback can disable native admission while retaining journals and Pi behavior.
It must not reactivate legacy endpoints, silently change requested targets or
downgrade an active database. Schema changes are additive; old records without
original proof stay unverified. External effects cannot be undone by code rollback.

Completion requires N1–N10 evidence and no unexplained affected-test failures.
Simulation, compilation or a passing policy evaluator alone does not establish
real engine, packaged application or cross-platform acceptance.
Desktop evidence must name the startup path exercised. An isolated production
renderer/preload/IPC harness can establish only its observed interactions;
complete Main startup and signed-package behavior require separate checks.
Harness bootstrap or driver failures must be distinguished from product defects,
and interrupted interactions remain unverified.

### 普通对话默认选择的只读投影

`GET /runtime/conversation-execution` 按 cwd、thread、项目路径和独立权限字段复用运行前的 native target admission，返回默认 binding 及 ready/blocked/not_selected。读取不创建 Thread/Turn/Run 或 native submission；连接探测不能替代此投影。无真实可信验收时显示 blocked。客户端的展示结果不能代替执行前再次检查；服务端总是重新核验实际持久线程与当前权限。

## Dependency and current CLI compatibility

Claude profile management retains its stable engine ID while connection metadata
comes from the selected CLI's isolated public no-prompt auth status command.
Configured metadata remains separate from remote authentication and execution
certification; no Claude Run target is added by removing the Agent SDK dependency.

Native image bytes pass through the product-owned, byte/pixel/time-bounded Rust
codec and existing safe publication. Decode, EXIF orientation, bounded ICC-to-sRGB
conversion and metadata removal remain required. The Node caller owns cancellation,
process termination and close receipts. Current-host dependency checks use the
existing policy without Unknown/LGPL exceptions; distribution/platform acceptance
remains separate. See the [replacement record](native-execution-engines-license-review.md).

For Codex 0.158.0, moderation metadata is validated and discarded without refreshing
meaningful activity. The reserved local command environment is accepted only from
a verified thread response matching the single bound workspace/root exactly.
Named, remote, ambiguous or expanded environments remain blocked. Experimental
turn permission grants do not inherit this command-environment compatibility.

## Startup recovery after runtime custody

Runtime custody and fencing precede Core stale-Run recovery. An enforced Harness
logical Run may remain resumable after its WorkUnit becomes stale only when its
active lost Attempt, attempt count, startup error markers and complete-fence
terminal audit match. The audit must record a system startup loss from claimed
or running to stale at the Attempt's terminal time. Cancellation, unrelated loss
and incomplete evidence never gain recovery authority through this exception.
The daemon still rechecks frozen input, policy, approvals, Task and continuation
CAS before creating a replacement Attempt. Channel reply children retain their
separate recovery path.
