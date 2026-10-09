# Provider runtime logical invocation checkpoint

## Scope and accepted decision

Continue the existing E6 implementation on `codex/e6-safe-continuation` in the
dedicated `ling-e6-continuation/ling-stack` worktree. The root checkout and the
independent delegation-storage WIP are not implementation inputs for this slice.

The user actually selected Provider D1 **A**. See
[the detailed scope design](provider-runtime-observation-scope-detailed-design.md).
This does not answer H10's separate root-budget question or enable dynamic
children. Resolution-proof foundation was saved separately in `0a64d7fa`.

## Implemented chain

1. Runner issues one logical invocation identity per SDK stream only after
   awaited payload hooks and Host/prepared/context/reasoning gates succeed.
2. Public composed-provider `getProvider` / `registerProvider` wrapping samples
   the SDK-prepared model/key/full headers after credential resolution and
   `transformHeaders`. A private WeakMap associates that sample with the exact
   stream's payload-hook identity. The final payload gate rechecks the live
   sample; missing, changed or unsupported proof means unknown.
3. Existing composed authentication, header suppression, fetch and registration
   behavior is retained. The private SDK `prepareRequest` is not patched.
4. Settlement observes the same stream's result Promise without consuming its
   iterator. Cancellation, preparation and local-hook failures do not become
   Provider failures. Only existing bounded error diagnostics cross this port;
   no raw error body, prompt, secret or private path is retained in the receipt.
5. Daemon creates a nominal private failure handle from exact original
   resolver/Store/Run/Attempt lineage. Duplicate or reused IDs cannot revive;
   asynchronous/throwing sinks are drained without changing model execution.
   Diagnostic limits make additional observations unknown, not execution errors.
6. Trusted Pi orchestrator execution installs this observer. Channel dispatch
   carries its private sink, and each projected reply execution collects its
   own failure handles. A serialized Run or prepared snapshot cannot recreate
   those private handles. Nonconforming adapters remain unknown.
7. The real orchestrator regression exposed materialized custom-header values
   in persisted Run provider snapshots. Both normal and queued Run creation
   now use the same copy-only persistence boundary to mask the API key and
   **all header values**, without changing the live provider used by Pi.
8. Persisted inline snapshots containing masked credentials cannot be used
   as fresh credentials by resume/fork. Common inline resolution and prepared
   restoration reject with 409; they do not send `[REDACTED]` or silently fall
   back to anonymous authentication. Configured presets still resolve fresh.

The proof is **logical SDK admission**, not HTTP/WebSocket dispatch, per-wire
retry accounting, billed token usage or a completed task. Inner transport
implementations retain responsibility for later automatic client headers.
An absent materialized Host key/base URL/model-capacity tuple, independent
environment or unresolved header expression is unknown. Do not guess built-in
defaults to convert unknown into a match; normal calls still work.

## Root verification on the final post-resolution source

| Gate | Actual result |
| --- | --- |
| Runner and Daemon TypeScript builds | exit 0 |
| Node 22 final joint resolution/Runner/Host/orchestrator/persistence focused | 141/141, exit 0 |
| Node 24 final joint resolution/Runner/Host/orchestrator/persistence focused | 141/141, exit 0 |
| Runner complete suite | 336/336, exit 0 |
| Host provider diagnostics, prepared execution and continuation/compaction regressions | 61/61, exit 0 before the extra snapshot-privacy fix; final Daemon complete suite covers the latest source |
| Independent final review | post-resolution P1 eliminated, 21/21 narrow checks; snapshot/resume follow-up 5/5, no remaining P1/P2 in this slice |
| Daemon complete suite on frozen final source | 3846/3846, exit 0; zero failed/cancelled/skipped/todo |

Raw root output is preserved under `output/e6-20260928/`:

- `t13a-runtime-invocation-final-joint141-node22-20261010.tap`
- `t13a-runtime-invocation-final-joint141-node24-20261010.tap`
- `t13a-runtime-invocation-runner-final-full-20261010.tap`
- `t13a-runtime-invocation-host-final-regressions-20261010.tap`
- `t13a-runtime-invocation-daemon-final-full-20261010.tap` (3846/3846)
- `t13a-runtime-invocation-final-source-20261010.sha256` (16 source/test paths)

The original SDK A→B tenant-header counterexample executed normally but
incorrectly admitted under A. It is covered by the final real-ModelRuntime
regression. Deletion, expression resolution, key override, late mutation,
concurrent streams, real summarization, preserved anonymous/custom-auth
behavior, local rejection, cancellation and private output are also covered.
Host loopback and production-orchestrator tests use real Pi and disposable SQLite, including a held A
request, configuration B, A's 429 and a successful independent SDK retry.
They do not call a real external model or operate the packaged GUI.

The first real-orchestrator Node 22/24 executions each returned 2/7, exit 1:
four privacy assertions detected header leakage; one independent non-Pi retry
fixture violated the existing strict event schema. The fixture was corrected
without weakening its `succeeded`, SQLite retry or Host-result assertions.
The separate masked-inline guard also has an actual 0/2 RED receipt. These raw
failures remain preserved; files named `orchestrator-final` are **not** GREEN:

- `t13a-runtime-invocation-orchestrator-final-node22-20261010.tap` (2/7 RED)
- `t13a-runtime-invocation-orchestrator-final-node24-20261010.tap` (2/7 RED)
- `t13a-runtime-invocation-inline-mask-red-20261010.tap` (0/2 RED)
- `t13a-runtime-invocation-persistence-guard-green-node22-20261010.tap` (8/8)

The Daemon complete suite finished with its actual footer and process exit 0.
The final joint 141 includes the production-orchestrator and persistence guards.
The older pre-post-resolution
Runner 328/328 and the intentionally terminated Daemon partial run are not
final evidence for this source. No source is rebuilt while its full suite runs.

## Not yet the runtime producer/consumer cutover

The current old cache and incident consumers are deliberately not called fixed
by this foundation. The remaining chain is:

1. Capture safe numeric budget metrics from the actual projected SDK context,
   reusing the existing prepared-input estimator, not an earlier discussion
   pack or a second Daemon approximation.
2. Switch all reply/route/intent/reviewer/reconstruction producers to their
   own authentic invocation facts. Remove post-await current-preset attribution
   and aggregate-local-error incident creation.
3. Bind cached context-window learning to current Store/configuration/effective
   credential scope, and expire entries before minimum merging as well as
   reading, preserving the existing strict six-hour `>` boundary.
4. Atomically store safe original invocation provenance with durable incident
   history. Keep private credential proofs out of public DTOs/events/summaries.
   Missing proof after restart is unknown, not current health evidence.
5. Filter current applicability before limits in both observer agent/provider
   queries and team projections. A hard-coded larger fetch limit is not a
   complete substitute for filter-before-limit. Preserve existing historical
   snapshots and unrelated non-runtime availability incidents.
6. Recheck summary/tool budgets and then the required real packaged cases.

Fresh macOS packaged acceptance retains its separate formal Office source-review
gate. This checkpoint does not fabricate that approval, build a mixed old/new
package, perform a release, enable cloud CI or settle native/H10 decisions.

## Status

Logical-invocation foundation implemented and independently reviewed; remaining
production consumption and acceptance gates remain active. No new product
decision is required for this foundation. External credential sampled equality
is the explicitly accepted A guarantee, not an external mutation-history claim.
