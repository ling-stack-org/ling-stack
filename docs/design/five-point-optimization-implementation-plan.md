# Conversation Experience And Test-Duration Implementation Plan

Status: P2 UX1-UX3 source/local complete with concerns; release acceptance open; P5 independently owned
Owner: conversations, Web/Desktop and CI maintainers
Last verified: 2026-10-16 (full Web 1475 pass, all 11 local gates reconciled; Desktop Node follow-up 1795 pass/4 conditional skips, isolated native checks; release concerns retained)
Document type: protected implementation and acceptance plan
Planning baseline: `b529a4b475f41442b29b59ff5bfeeece8879c74e`

## Read This Before Continuing

The [scope contract](five-point-optimization-contract.md) covers P2 conversation
experience and P5 full-suite duration. Both use existing Main owners and keep
current functionality, permissions and regression coverage.

P2 source implementation and isolated local verification were authorized on 2026-10-13.
Implementation baseline: `4a6480196b0656e733b11376f088494f168ad47f`, verified against
remote Main. Worktree: `codex/p2-conversation-experience`. Preserve other worktrees,
databases, model configuration and independent P5 work. Installation, commit, push
and PR are not authorized by this implementation request.

Detailed historical verification stays in local SDD evidence rather than this
delivery queue. Documentation checks are not functional acceptance.

## Task Graph And Authorization

| Task | State in this revision | Depends on | Deliverable / exit condition |
| --- | --- | --- | --- |
| FT0 Clean-Main full inventory and baseline timing | PLANNED; no new measurement | P5 plan, separate benchmark/source authorization | Complete existing-lane inventory and baseline; independent existing-lane inventory |
| FT1 Changed-candidate inventory and baseline refresh | PLANNED when retained source changes | FT0, separately authorized source changes | Reconcile changed cases and refresh affected evidence; source-bound inventory refresh |
| FT2 Build/fixture reuse and resource isolation | PLANNED | FT0, separate source authorization | Valid build reuse, independent resources, unchanged assertions and failure-path cleanup |
| FT3 Bounded scheduling and aggregation | PLANNED | FT2 | Same-snapshot comparisons, complete test-ID accounting; existing coverage unchanged |
| UX1 Main behavior inventory and reading/sending stability | SOURCE/LOCAL SLICE VERIFIED; release acceptance open | Accepted P2 plan, 2026-10-13 source authorization, Main `4a648019` | Existing behavior classified; only reproduced streaming/read/send gaps repaired using existing owners |
| UX2 Recoverable operations and decision ownership | SOURCE/LOCAL VERIFIED; release acceptance open | UX1 | Per-file retry/cleanup, receipt/effect-aware recovery, authoritative stop and one action owner |
| UX3 Process display/performance/accessibility closure | SOURCE/LOCAL COMPLETE WITH CONCERNS; release acceptance open | UX2 source/local verified | Existing typed display/windowing retained; full Web 1475 pass, all 11 local gates reconciled; Desktop Node 1795 pass/4 conditional skips, native local follow-up; specialist/platform limitations retained |

P2 and P5 remain independent. The separate test-duration worktree and its SDD own
current P5 implementation; this legacy shared queue does not start or overwrite it.
All existing functionality tests remain in the inventory.


## FT1/FT2/FT3: Complete Verification With Measured Scheduling

### Inventory And Measurements

Discover package scripts, Node files/cases, Web E2E, Desktop Node/renderer/a11y, native
helper/platform tests, migration/security tests, static checks and real/package gates.
Record execution exclusions and their actual owning lanes, not just glob totals. Root
recursive tests alone are not the full inventory.

Every run records source/dirty manifest, lockfile/toolchain, platform, configuration,
test inventory/IDs, build fingerprints, per-stage wall time, per-file duration, retries,
peak memory where available, timeout/cancellation reason and child cleanup. Unavailable
measurements are marked unavailable, never estimated as observed values.

Start from the current serial/default configuration. Repeat baseline and candidate
comparisons on the same snapshot and report distributions, cold/warm build differences
and machine load. Set the duration budget after this baseline, not from the old 65%
experiment. Diagnose slow imports/setup, waits/locks, giant files, retries and exits before
changing concurrency or deadlines.

### Reuse And Isolation

- Reuse the existing CI dependency graph/artifacts; content-bind source, lockfile,
  compiler options, tool versions, platform and outputs. Invalid inputs rebuild.
- Reuse closed SQLite fixture templates only for eligible business tests; preserve
  production initialization, schema/migration/recovery and constructor tests separately.
- Give each worker independent HOME/config/state/SQLite/ports/output and track owned
  processes. Browser context isolation alone is insufficient for a shared Daemon/database.
- Refactor shared fixed paths and fixture lifecycle before lifting worker limits. Keep
  real single-owner resources in explicit serial groups without reducing their tests.
- Avoid a blanket outer sandbox that prevents the Desktop renderer or native sandbox
  tests from initializing. Separate worker isolation from the OS boundary being tested;
  preserve macOS native-helper and Linux fail-closed lanes.
- Start with bounded trials; select concurrency by consistent outcomes and cleanup, not
  fastest wall time. Historical concurrency nine is a rejected experiment, not a setting.

### Scheduling And Completeness

Use actual duration records with version/freshness metadata, robust sampling and stable
tie-breaks; use conservative estimates only for new/unmeasured tests. Split giant files
for independent scheduling only after preserving case IDs, assertions and setup semantics.
Never enable parallel test cases that mutate a shared fixture just by adding workers.

Same-source/config retries may rerun failed lanes with bounded attempts and retained first
failures. Source changes invalidate affected evidence; a receipt/manifest verifies any
reused results. Final aggregation compares expected versus observed test IDs and lanes;
missing, duplicate, cancelled or unexpected skipped cases cannot become `FULL_PASS`.
Failures do not prevent independent lanes from producing results; the final exit is nonzero.

| Gate | Exit evidence |
| --- | --- |
| FT-A01 | Full discovered inventory, owning lanes and omissions reconciled |
| FT-A02 | Cold/warm build and fixture reuse preserve output/data identity where applicable |
| FT-A03 | Same test IDs/assertions, no new failures/cancellations/skips under bounded concurrency |
| FT-A04 | Resource collisions, lock waits, hanging Promise and orphan cleanup stress fixtures |
| FT-A05 | Timing-based stable shard balance, bounded retries and failure-preserving aggregation |
| FT-A06 | Current-Main repeated benchmark with build/setup/execute/cleanup breakdown, no old speed claims |
| FT-A07 | Web/Desktop Renderer valid full comparison; native/package unavailable gates remain explicit |

## UX1/UX2/UX3: Shared Conversation Interaction

These are the original three batches, with all six objectives retained. They improve
the inspected Main implementation, not reconstruct the old branch or adopt every
unfinished Main architecture task. Send receipt, execution facts and reading view state
remain independent. P2 uses existing Main behavior and does not wait for scheduler work.
Existing test coverage still runs.

### UX1 Starting Point: Current Behavior And Exact Gap Records

Use the six-row existing/gap/change/acceptance map in the paired contract. Before source
implementation, recheck the actual selected Main-based snapshot against the planning
SHA; record source/serving identity and affected interfaces. Do not treat this detached
older documentation checkout or its copied native work as the latest Main runtime.

1. Keep existing Feed/Timeline/projector/registry/view-store owners and current route
   callbacks. Verify streaming, reading, upload, recovery, tool and decision behavior
   before prescribing a change. Existing implementation is reuse, not a new deliverable.
2. Classify each scenario as source-confirmed behavior, source-confirmed repair candidate,
   runtime-reproduced defect, unverified acceptance or verified pass. A current source
   difference or future contract target is not a reproduced UX defect.
3. Give a failing scenario its actual source owner, expected/observed outcome, focused
   failing test, smallest change and UX-A gate. Passing scenarios retain existing code
   and become regressions. Preserve existing supported actions/resources and policies.
4. Treat `renderMessageChrome` replacement and old MessageRow/WorkCell/activity caller
   retirement as existing transcript-plan work, not UX1 preflight or P2 delivery tasks.
   If an exact UX defect is blocked by an interface, record the local dependency and
   separate scope decision. Do not turn it into all-surface cutover automatically.

Use same-fact fixture identity/order/status/renderer and action/result/Timeline/scroll
ownership comparisons for changed paths. These constrain targeted fixes; they do not
require eliminating every current route wrapper before a behavior can be accepted.

| Capability to preserve | Target owner / verification |
| --- | --- |
| Identity, avatar, timestamp, edited marker, Markdown/code | Existing root and message presentation; stream/completed regression, no metadata-interface replacement prerequisite |
| Copy, edit/save/cancel, feedback | Existing callbacks and mutation services; permission, busy and failure behavior |
| Topic reply and create-task | Existing supported surface callbacks; same task/topic lineage and no lost entry point |
| Attachments, links, trusted paths, web/memory references | Existing resources and Host callbacks; same visibility/privacy and no path-derived permission |
| Generated images/media and accepted plans | Existing typed kinds and evidence refs; no second card/result owner |
| Replacement retry, regeneration, continuation and stop | Existing receipt/capability/Run services; partial output and effect safety |
| Approve once/deny/valid command rule and structured questions | Existing owning gate/dialog, durable decisions/receipts and stale-response protection |

### UX1 Batch 1: Reading And Sending Stability

The rules below are expected behavior and acceptance scenarios, not a claim that each
is missing in Main. Implement only reproduced gaps using the preceding gap record.

- Reconcile optimistic input, durable accepted input, stream deltas and final-only output
  with stable identities. Cover duplicate/reordered/replayed events and reconnect before
  linkage; one submission cannot become two replies or a narration-derived terminal.
- Reuse shared incremental Markdown/code rendering. Test unfinished fences, long code,
  malformed input fallback and final completion without remounting the message identity
  or replacing `reply_result`/TerminalReport ownership.
- Converge route-local scroll behavior through the shared viewport. Capture the actual
  visible `rowKey + offset`; preserve it through history prepend, image decoding,
  disclosure, child expansion, dynamic measurement and dock/sidebar resize.
- Distinguish explicit user up-scroll/search from programmatic restoration. Only current
  tail-following or explicit return-to-latest resumes following. Use the shared locator
  for unloaded/collapsed targets and Main's parent-header fallback for collapsed anchors.
- Recover a lost send response through its original receipt/identity. Do not clear a
  draft on a transport timeout or resubmit because no assistant text is visible. Verify
  rapid normal/channel/private/topic/branch switching without another surface's draft,
  search target, follow mode or pending output leaking into the active surface.

### Historical UX1 Implementation Checkpoint, 2026-10-14

This checkpoint is a targeted slice, not completion of UX1 or all P2 gates.

| Reproduced gap | Existing owner / bounded change | Verification boundary |
| --- | --- | --- |
| Canonical position correction changes display-row identity | Display model keeps encoded parent/item identity independent of position | Unit regression for prepend/revision and delimiter collisions |
| Short Timeline binds an inactive virtualizer and scrolls back to zero | Root Timeline enables its existing virtualizer only when windowing and viewport are ready | Real production component fixture; short stream and long-window regressions |
| Ordinary history/search is moved by prepend, reflow or streamed body updates | Normal feed stores row/offset, pauses on search, distinguishes layout restoration and user intent | Controlled browser geometry for prepend/media/resize/search and return-to-latest |
| A reading target is temporarily unmounted when windowing starts | Existing locator adds non-expanding reading-row/parent reveal; async result is fenced to current anchor | Threshold transition, virtual prepend and collapsed-parent tests |
| Keyboard scrolling was not reported to the viewport policy | Shared Feed composes route handler and reports navigation keys outside editors/actions | Browser callback, real PageUp interaction and reduced-motion regression |
| Private/channel/topic history shifts after media or viewport reflow | Route feeds reuse the shared row/offset viewport policy; topic gets explicit tail/latest behavior | Controlled private, channel root, branch and topic reading tests |
| Channel accepted stream failure skips the original-thread read | Existing channel action refresh reconciles the accepted source thread before reporting failure | Normal/private/channel/branch after-ready response-loss cases; no replay |
| Topic accepted send retains its submitted draft or a late failure overwrites a reopened topic | Existing acceptance callback clears only the submitted draft; send-version and owner fence reject old completions | Topic response loss and close/reopen late-result cases |
| Channel accepted terminal error is classified as an unsent input | Composer uses recorded acceptance for both error events and thrown transport errors, including detached surfaces | Accepted terminal error and surface-switch tests; no input-retry action |
| Topic reply has two bubble backgrounds and an incorrect send-failed prefix | Remove obsolete reply-wrapper presentation; shared MessageRow owns the bubble; keep the actual error without relabelling acceptance | Light/dark computed styles, retained copy/edit controls and genuine browser captures |

Normal/private/channel process disclosure, copy/files, draft-owner transitions,
late upload/send ownership and active guidance are exercised as existing capability
regressions. Passing paths are preserved; the continuation changes only existing
Web read/send callbacks and obsolete topic wrapper styles. It changes no send API,
receipt, approval policy, artifact cleanup or execution authority. New text keys
are unnecessary.

The pre-interface-extension 2026-10-14 continuation passed 84 affected browser regressions, 197 Web unit
tests and 70 isolated SQLite/Daemon acceptance, reopen, dispatch-recovery and
private-owner tests. Controlled reading now covers normal/private/channel root/
topic/branch; after-ready recovery verifies the original input appears once with
no draft restoration or input replay. These are not full live-backend acceptance.

At that historical checkpoint, UX1 remained open for confirmation lost before ready
and browser/backend reconnection. Normal/channel already accepted optional keys,
but Web did not pass them; private reply-owner idempotency was not an initial-input
receipt. The subsequent approved implementation below closes that source/local gap.
Do not infer non-acceptance from missing ready or match input ownership by text.
On 2026-10-14 the user approved the bounded existing-interface extension:
private initial submissions gain an optional idempotency key and read-only receipt
lookup; normal/channel Web submissions use their existing keys and query native
accepted items. No new execution engine, permission or receipt authority is added.
Private identity is stored with the original message, scoped to workspace/teammate;
same-key payload or permission drift is rejected. Durable acceptance precedes reply
dispatch, and duplicate submissions never dispatch again. A receipt is not proof
of reply success; missing/unreachable receipts remain unknown, not rejected.
Tests exercise Core public storage, existing Daemon HTTP and Web send surfaces,
including reopen, races, drift, legacy callers and lost confirmation without replay.
The extension is now implemented and verified for the authorized source/local slice:

- Migration 154 adds nullable key/fingerprint columns and a unique native-message
  index. Acceptance and identity writes are one SQLite transaction. Reopen, two-writer
  races, rollback, payload/permission drift and legacy unkeyed callers are covered.
- A read-only normal/channel receipt endpoint queries original items/turns; private
  receipt lookup extends its existing message collection. No second receipt table.
- Each Web surface records only a scoped lookup pointer before POST. Unknown or
  unreachable outcomes remain query-only after reload; only a proven rejection
  enables input retry. Empty 200 and 400-after-acceptance are reconciled, not replayed.
- Recovering an older submission preserves a fresh draft. Private clearing compares
  the complete live body/attachment/link/file-reference draft, not just equal text.
- Final 13-file browser regression: 110 PASS. Six light/dark cases use source HTTP
  handlers and isolated SQLite with controlled execution; they do not call models.
  Web units: 203 PASS; affected Core/Daemon: 97 PASS; Contracts: 88 PASS;
  API-client: 84 PASS; conversation-ui-core/react: 189/25 PASS.
- Production package typechecks/builds, Web lint/build, 55-locale i18n and whitespace
  checks pass. The optional standalone E2E typecheck reports 169 diagnostics, all in
  the unchanged shared mock-daemon fixture; it is not reported as passing.

UX1-R03 source/local acceptance is complete. UX1 release-level real-provider and
installed-client checks remain unverified, not waived or replaced by mock captures.
The next source batch is UX2; full P2 and UX-A01..11 acceptance is not claimed.

UX2 per-file attachment implementation is underway. Effect-aware recovery/stop
and single decision ownership remain open, followed by UX3 closure. No installed
macOS/Windows acceptance is claimed.

Detailed run results, first failures, source manifests and genuine browser PNGs stay
in local SDD/ignored acceptance storage. Component captures use controlled messages;
full-page captures use either the existing mock Daemon or explicitly identified
source HTTP/SQLite fixtures. None is real external model execution. The current
manifest excludes historical captures, verifies actual theme backgrounds and binds
HEAD plus dirty-source, dependency-build and PNG hashes. Transport-loss diagnostic
feedback remains visible after receipt recovery; it does not offer input replay or
claim reply success. Its presentation is retained for UX2 recovery-state review.

### UX2 Batch 2: Recoverable Operations

Attachments settle independently. Reuse current upload APIs and owner fencing. Controlled
browser regressions reproduced private/channel batch-wide failure and missing selected
retry. The shared per-file hook repairs these paths without replacing upload endpoints.
Source HTTP handlers with isolated SQLite also verify all three surfaces' independent
valid/empty-file outcomes and deletion receipt reconciliation. These are local controlled
tests, not external-model or installed-client acceptance.

Track each local file and upload operation against the original workspace, real thread,
teammate where applicable and draft generation. Removal/retry creates a current operation
fence so older completions cannot resurrect a file. A successful file stays ready when
another fails; retry only the selected failed file. Keep current file limits and send
eligibility; never silently discard an unresolved attachment. Use bounded upload
concurrency only if needed, without changing outcome semantics.

Specify preview release, removal during upload, late orphan cleanup and accepted-message
ownership before implementation. Never delete an already message-bound artifact because
a local view was reset. Failed send restores only the original still-owned draft;
switching surfaces must not restore attachments into another conversation. Cleanup
failure remains diagnosable/recoverable rather than silently leaking or deleting data.

An existing conversation's draft actions wait until its selected detail binds the
real thread scope. Keep loading and ready owners distinct; gate attachment selection,
paste/drop, editing and submission during hydration rather than accepting input into
a disposable owner. New drafts stay immediately usable. Browser regressions delay the
detail response explicitly and wait for the actual ready control, not a fixed delay.

| Recovery action | Required authority and behavior |
| --- | --- |
| Resend unaccepted input | Proven not accepted; preserve intended text/files and existing idempotency contract |
| Recover accepted send / unknown response | Query original receipt before replay; reconcile original reply and Attempt |
| Regenerate a reply | Expose only supported existing capability; preserve original history and new Attempt lineage |
| Continue interrupted execution | Host-validated continuation/checkpoint and current permissions, not local message text |
| Retry an effect | Exact operation outcome and policy/approval; unknown side effects reconcile before replay |
| Stop | Pending until authoritative terminal/cancellation and owned-resource cleanup; preserve partial output and report uncertainty |

Approval/question facts focus the single owning control instead of injecting duplicate
forms into Timeline/Composer/dock. Preserve valid once/deny/command-rule options and
failure retry, without widening rule scope. Cover duplicate decisions, stale request,
question answer receipts, safe-yield, cancellation/restart and fresh Attempt fencing.
Every async action remains scoped to its owning item/operation; local busy state cannot
disable unrelated messages or manufacture task completion.

#### Final UX2 Source/Local Closure (2026-10-15)

Implementation and the final affected source/local regressions are complete.
The current evidence root is `.ling-stack/acceptance/p2-ux2-closure-20261015/`;
its final manifest/report, not older counts below, owns this delivery snapshot.

- R01: independent attachment retry/removal, draft/operation fencing, unbound-orphan
  cleanup retry and preview disposal preserve accepted-message resources. Cleanup
  retry remains page-session scoped; this does not add a background cleanup service.
- R02: lost submission/intervention/stop responses recover by original identifiers
  without POST replay. Private editing and continuation claims retain current owners.
  FIFO checks both root and immediate predecessor drain, effects and resources.
- Original Host lifetimes persist independently of logical cancellation. Actual SDK
  sealed tool inventory can establish tool-free completion, or refer to separately
  verified tracked executors. A returned tool result alone supplies no effect proof.
- Release and TTL expiry cannot bypass a registered live lifetime or known pending/
  unknown Host operation. Cancelled resources need positive effect coverage. Exact-
  source deferred cleanup updates both resource tables transactionally and retries
  bounded failures; drained observers retire only after owned work is settled.
- Canonical required-input yield retains its existing physical/effect verifier and
  releases both resource tables inside the checkpoint/status transaction, before
  clearing its active Attempt. Generic release reasons cannot bypass the veto.
- R03: terminal-aware approval merge, scoped callbacks and reload lookup pointers
  preserve one decision owner. Once/deny/rule, failure/retry, malformed or lost
  responses, stale snapshots and keyboard focus retain existing policy. Existing
  question claim/duplicate/expiry/cancel/yield boundaries are tested without enabling
  the unfinished public question tool.

Core full regression, affected Daemon and final source HTTP/SQLite/browser recovery pass. Independent
review reproduced the private continuation claim, nonterminal release/expiry and
safe-yield cleanup gaps; red/green evidence is retained and re-review found no new
blocking issue. The evidence report records static checks and exact owned-process
cleanup separately; neither screenshots nor a green subset substitutes for that record.

Unknown legacy/no-Run, remote, process-descendant and background effects remain
explicitly unverified, not successful physical stops. They do not authorize automatic
release, continuation or replay. This safety outcome is distinct from testing a real
remote cancellation protocol. Installed-client, external-provider and cross-platform
release acceptance remain unverified. UX3 and P5 are not started by this closure.

#### Historical UX2 Source Progress (2026-10-15)

The following checkpoint records and their open items describe earlier snapshots;
the final closure above supersedes them for current delivery status.

Per-file ready/failed/uploading state, selected retry, unresolved-send blocking,
late-upload fencing, original-owner cleanup and keyboard focus are implemented.
Cached unbound channel drafts are cleaned when their Composer is destroyed, while
accepted-message attachments remain untouched. Failed DELETEs retain a retryable
record in page-session memory under the original owner, including after unmount;
other conversations cannot see or retry that record. This is not restart-persistent
cleanup storage. Successful deletion followed by a lost receipt and HTTP 404 on
retry settles instead of reporting a new failure.

Private guidance receipt loss reproduced deletion of a potentially accepted file.
Submitted guidance files are now protected from local removal/unmount deletion;
an accepted guidance's later refresh failure no longer restores a deletable draft.
Normal's equivalent protection is implemented but still needs dedicated behavioral
coverage. Normal accepted-stream loss also now executes the authoritative final
detail read, preserving one original submission rather than remaining pending.

Guidance receipt lookup now filters existing Run/private collections by the
original key before pagination, includes terminal history and echoes the applied
filter. Scoped query pointers survive reload without storing drafts or permission.
Normal/private recovery preserves newer text/files and only restores removal
ownership after a proven rejection. Core's 19 affected cases, Daemon's 61 cases,
API-client's two receipt cases and Web's 445 unit cases pass. The earlier 108-case
browser selection passed before the subsequent Run-details/stop changes.

Run details now uses the same query-only guidance recovery instead of minting a
new key on retry. Its three light/dark/reload cases pass. Mutations and finally
callbacks are fenced across selection changes. Existing rejection/retry fixtures
now supply HTTP 400 plus scoped absence; HTTP 503 remains an unknown outcome, not
permission to replay. The targeted 16-case Run-details selection passed before
the final selection-scoped stopping propagation.

Shared Run stop now queries the original Run and, where present, WorkUnit and
owned resources. It retains partial events and stopping state until terminal and
resource-release facts arrive; response loss never resends the cancellation.
Stopping state is propagated by Run ID instead of disabling unrelated channels.
The frozen-source 125-case browser selection passed (14 specs); refreshed Web
lint and i18n also passed. This is the attachment/guidance/shared-stop source
snapshot, not acceptance of subsequent private-stop changes or full UX2.

Private stop now has a separate controller, original-WorkUnit receipt polling and
scoped query-only restart pointers. Controlled browser regressions pass for
accepted stop, lost response, restart, denial/retry, read failure, original-Attempt
and resource settlement, and teammate-selection isolation. Missing original
Attempt receipts remain uncertain; a safely yielded Run can settle only with
authoritative logical WorkUnit cancellation, without rewriting Run history.

An initially absent WorkUnit pointer is now discovered from the original Run
before termination is confirmed. Shared Run stop query pointers survive reload
too; they contain identifiers only and never replay cancellation. A private
thread replacement fences an undispatched stop even when its teammate is unchanged.
Preflight failure permits another explicit click without claiming a mutation was
sent. The delayed-detail readiness repair and refreshed 17-spec/151-case browser
union pass, including the complete prior-draft identity regressions. This is the
snapshot before the following backend cancellation work, not full UX2 acceptance.

Run, WorkUnit and private cancellation now carry optional captured Attempt/Run
identifiers. A Core-owned SQLite writer transaction re-reads their binding before
the logical cancellation, pending approval changes and exact-owner resource cleanup.
Standalone cancellation uses the same fence and never reconciles runtime first.
Terminal Attempt writes explicitly join only that owned transaction. Event-file
copies, streamed cancellation and summaries are published after commit; failed
commit retains pending approvals, resources and logical state. Existing safe-yield
cancellation and pending-required-pause guards remain separate and unchanged.
Cancelling an old Run cannot overwrite a task now owned by another Run. Both
successor-Attempt mutation and task-owner overwrite had failing native regressions
before repair. Empty-body old clients remain compatible.

The focused identity-stop Chromium selection passed 17 cases. Its refreshed
17-spec/152-case union ended with 151 passes and one initial page-load timeout,
before channel attachment assertions. The unchanged failing case passed three
isolated repetitions. Preserve the first failure; its cause is not established.
The expanded identity-cancellation/safety selection passed 48 cases.

WorkUnit detail now exposes read-only source-fenced stop evidence. Captured main
and local-writer completion remain observable after the live Run entry is removed.
The original Host executor group and reverified Core operation/command journals
remain separate from callback drain. Pending/unknown/missing proof cannot settle
the UI, nor can a wrong runtime/fencing token, a duplicate proof or a missing
WorkUnit. Failed durable unknown recording does not downgrade the local unknown
fact to pending. No observation permits cancellation replay or effect replay.

The missing-WorkUnit regression first reproduced premature UI settlement. Its
refreshed frozen-source browser union passed 155 cases and the final native
Host/cancellation selection passed 204 cases. The historical manifest binds 60
fresh PNGs to that stop snapshot, not to subsequent approval repairs. API-client
86 and the prior affected Core 86 remain the last verified results for unchanged paths.

Approval regressions reproduced terminal decisions reopening after stale pending
snapshots/list omission and old A-B-A/reset responses modifying a newer decision's
error/busy state. Shared terminal-aware merge and request-owned callbacks repair
these cases. A separately reproduced startup-target invalidation regression was
repaired without accepting an abandoned workspace's list. Ten focused browser
cases and current 456 Web units/build/typecheck pass. Its first 208-case attempt was intentionally interrupted
after a diagnostic trace confirmed dependency HTTP 504 Outdated Optimize Dep and
an empty application root. Failures and trace are retained. Isolated-cache startup
passes the two unchanged approval tests; no assertions or timeouts were weakened.

Decision response loss now queries the existing original approval-by-ID endpoint,
never automatically repeats a decision POST. Only a same-ID terminal receipt
resolves the request. Missing/pending/wrong-ID receipts stay unresolved; missing
or unfinished post-commit effects retain an execution-reconciliation warning.
Refresh/event errors do not turn a durable approval into a failed decision.
The frozen receipt union finished at 251 PASS, zero fail/skip/flaky, with 132
fresh PNGs. `receipt-manifest.json` binds this historical source snapshot
(`3bf03cc74479829976cb7851a95b0228ad77d678d6f782ff1370974e272b3b63`),
not the following Core resource changes. Its earlier extended 24-case report
retains one pre-request module-load timeout; the unchanged case then passed
three repetitions. That startup cause is unproven, not erased by the passing union.

A separate public-service/SQLite test reproduced cancellation releasing the
original lease while a launched Host operation remained pending. The next test
reproduced TTL expiry bypassing the same unknown effect after reopening storage.
Core resource-lease and semaphore release/expiry now share a transactional veto
using independently reverified existing Host/Broker/command/media evidence.
Generic finally/reconciliation cleanup cannot bypass it; valid no-start facts
and unrelated expiry remain usable. This adds no approval or resume authority.
Core 237, cancellation HTTP 23 and Host/shutdown 103 targeted checks pass. The
source-frozen combined rerun ended at 363 PASS, zero fail/skip/cancel/todo;
`resource-manifest.json` binds SHA
`b6111fb92d40ef889f8f47f7d0c59ef140d4e00a19672458f21057cf57ed5596`.
This becomes historical after the following Web response-validation edits.

A subsequent public domain/browser test reproduced HTTP 200 with an empty
decision response leaving the approval pending without querying its original
receipt. Same-ID/known-terminal validation now sends unusable success responses
through existing GET recovery, without replaying the decision. The first focused
red/green pair is retained. Current-source browser coverage ended at 107 PASS,
zero fail/skip/flaky, with 108 genuine PNGs across normal/channel/private decisions,
both themes, keyboard command-rule menus, stale snapshots and unusable responses.
Malformed follow-up effect entries preserve the recorded decision and
execution-reconciliation warning instead of throwing. The warning reuses the
existing translated pending-confirmation
message and does not add a second decision authority.

The next native red-green regression reproduced a never-launched original Host
operation unable to record no-start after logical cancellation. Only that original
memory-only ticket may now settle its no-start fact when Run, WorkUnit, Attempt,
runtime and fencing token still match under the journal's writer transaction.
It cannot reopen admission, perform effects or cleanup, settle launched/unknown
operations or borrow a successor. The focused case and expanded 29-case cancellation
suite pass, including failed-write retry and a second SQLite writer changing source
linkage. Broader Core 1327 and Web 456 units pass; the unchanged 147-case
Host/MCP/shutdown selection passes serially. Its first concurrent run retains
129 PASS/18 cancelled, including 5s/15s timeouts; the idle MCP worker still held
two local listeners and was terminated. High observed load and passing serial
retest support contention, but do not prove it was the sole cause. No timeout or
assertion was relaxed. This does not close safe
post-cancellation settlement for launched file/media/remote effects or default
physical-stop/restart proof.

`response-validation-manifest.json` binds SHA
`6af7ecc4535dc4b0ba9275dedaf08a80c610f66c18f4c2317c54d329a90d9551`,
the exact 107-case inventory, current source/dependency builds, all four native/unit
reports and 108 PNGs. This source snapshot was captured after browser completion;
all changed source/test mtimes predate the browser run and the same content/builds
were verified at final native completion. It is not labelled a pre-run freeze.
Web typecheck/lint/i18n/build and docs checks pass. Two changed-state screenshots
were inspected, not all 108. The isolated source server was stopped; no user
configuration, external provider or installed client was used.

UX2-R02 remains implementing: this read projection does not add missing physical
stop protocols or make logical cancellation physically safe. Original Host tracking
still requires the existing internal user-input opt-in; it was not enabled for
public execution. Opt-out/legacy/no-Run and restarted sources without their
original observation remain unverified, which can keep confirmation pending.
Completing default-path, durable restart and authoritative resource safety is a
release blocker, not an accepted limitation or full stop acceptance.
Supported regenerate/continue,
effect-specific recovery and full Attempt lineage still need closure. A durable
resource veto is not a positive physical-stop certificate: default/untracked
execution and callback drain, safe post-cancellation settlement and restart
recovery remain required. UX2-R03 remaining malformed-response/reload recovery, full
approval/question ownership, duplicate decisions and focus localization remain
open. Do not mark full UX2,
UX-A04/A05/A06/A09 or release acceptance
complete from these targeted changes. No installed-client or provider execution
is used by the controlled browser fixtures.

#### Historical UX2 Durable Completion And Ownership Follow-Up (2026-10-15)

Approval lookup pointers now survive reload without POST replay. Reload recovery
uses the latest shell callback so a workspace hydration race cannot clear the
conversation list; its still-unconfirmed error remains visible after remount.
The six channel/normal/private dual-theme reload cases include menu keyboard
focus, unknown receipt reload, eventual original receipt recovery and one POST.
The preceding affected browser union ended 116 PASS; it predates the subsequent
private editor changes and is not full UX2 acceptance.

The user approved minimal persistent Host completion facts. Migration 155 stores
only original Run/WorkUnit/Attempt/runtime/token identity and registration/drain
timestamps. Core captures the original promise while its source is active and
revalidates the historical source under the completion write lock. Production
waits for main completion and the closed local callback group, including the
actual automatic-review Runner. The read-only WorkUnit projection can recover
local drain after registry restart. Live draining and durable effect vetoes win.
Observation write failure is diagnostic and does not change off/shadow execution;
it withholds durable proof. No imported tool-result text certifies completion.

This does not certify untracked remote/process-descendant/background effects or
backfill old/no-Run execution. Those stay unverified/unknown. The original file
Host ticket can now settle independently verified completed facts after logical
cancellation; a successor still cannot use that ticket to execute or settle.

Private edit/replacement recovery reproduced a second defect: an outstanding
edit for one teammate disabled the next teammate's editor. Reuse the existing
request owner with workspace/teammate/thread identity and action generations;
scope success, error and finally callbacks and reset busy state on identity
change. Existing replacement idempotency keys remain unchanged. Four genuine
dual-theme browser cases and both existing private edit/retry cases pass.

The first expanded Core run found the new completion table's cascading runtime
foreign keys conflicting with missing-runtime-table self-healing. They now use
the existing restricted Host journal reference convention. The rebuilt full Core
suite passes 2423 cases, including missing-runtime-table and missing-completion-table
self-healing without backfilled proof. The first failing report is retained.

The refreshed source/local slice passes 140 affected browser cases, 2 existing
private edit/retry cases, 157 serial Host/stop tests, 460 Web units, 4 focused
API-client cases and 88 Contracts cases. Core/Daemon/Web typechecks, Web lint,
i18n, build, docs and whitespace checks pass; existing build warnings remain.
The local completion manifest binds HEAD plus 166 changed non-doc file hashes,
dependency/build outputs, original failures, exact browser inventory and 130 genuine
approval/private PNGs. Only four current PNGs were visually inspected. Browser
routes are controlled; native tests exercise isolated SQLite/Host/filesystem and
HTTP projections, not external providers or installed clients. The source snapshot
was captured before the final native run, after the browser/Core lanes began;
it is not described as a whole-project pre-run freeze. All checks are terminal
and the owned 4196 source server is stopped.

UX2 remains active. Full supported recovery/Attempt lineage, physical stop and
resource closure, and full decision/question acceptance must close before UX3.

### UX3 Batch 3: Process Display, Performance And Accessibility

#### Desktop Follow-Up Acceptance (2026-10-16)

The user authorized continued acceptance, not packaging, installation or shipping.
The original evidence directory is frozen. New logs, real content-area screenshots
and the report are in `.ling-stack/acceptance/p2-desktop-followup-20261016/`.

After the existing development build, the complete Desktop Node run terminates
1795 pass, zero fail/cancel, four conditional skips, 1799 total. Two new bundled
metadata regressions and ten formerly cancelled nested cases explain the larger
inventory; no original case was removed. Three mock-lifetime roots use explicit
test clocks and the handoff fixture resolves physical Git paths. Production
timers, assertions, deadlines, permissions and signed review inputs are unchanged.

Actual isolated Electron startup/send found one development-build defect: the
relocated daemon could not resolve bundled metadata outside the repository cwd.
The development build now stages only the existing three allowlisted metadata
files. Original RED screenshot/log and GREEN reply screenshot are retained;
two permanent regressions, rebuilt startup and real UI send pass. No packaged
resolver precedence or executable capability changed.

Native light/dark, expanded/collapsed sidebar, Settings and actual BrowserWindow
1280x800 resize pass. Reload returns the existing Home surface; reopening the
saved conversation retains exactly one reply. No new page/console/HTTP errors
were observed in the reconnected theme/resize/reopen pass. All fourteen originals
were inspected; the immediate light-theme transition capture is diagnostic only,
with a separate stable-state capture. These are real renderer screenshots, not
OS traffic-light chrome captures. The native follow-up covers normal chat, not
channel/private native execution or an external model; only a loopback SSE fixture.

Source SHA256 `bd8dc0dd07073f55c9a2d8d4b9edcb84a5344c0e97041d3f091da5530175f7de`
differs from the prior full Web run only in seven Desktop paths. Web and backend
source/runtime inputs and seven pre-existing dirty PNGs are unchanged, so their
recorded full results remain reusable. Preview 28/a11y 3 inputs are byte-identical
across both development builds. Supplementary runtime hashes include the actual
daemon, staged metadata and signed local helper, not just the older runtime helper's
limited roots. Owned native app/daemon/helper and listeners are stopped.

Four conditional native/platform skips, specialist dirty-tree guard, installed
client, external provider, native Windows and package/release gates stay open.
Desktop lint is an unconfigured echo, not a passing lint check. No UX4, new engine,
Main/P5/configuration changes, commit, push or PR. The following closure is the
13:10 UTC historical checkpoint; its Desktop concern is superseded only here.

#### Final P2 Source/Local Closure (2026-10-16)

UX3 completes the authorized P2 functional scope; no UX4 is introduced. All six
objectives UX-G01..06 have current source/local evidence, mapped to UX-A01..11.
Full Web passes 1475 with zero failures, skips, retries or flaky cases, preserving
all 1472 original IDs plus the same three early-measurement regression cases.
The terminal full run consumed source SHA256
`953e83f0d75be241b5bdda7b8508140d4a9fb8fd60addcaca9ea0f6fba3965bb`
and runtime SHA256
`4953aa22a1d3fa29dc7a4c9625087499ab4007bafe5c55cf51270a30fe382f85`;
post-run equality and all seven pre-existing dirty PNG hashes are verified.
Core 2481, Daemon 3657, Contracts 88, Runner 257, API 87, UI 72, conversation
Core 189/React 26 and Web 462 pass on their recorded unchanged relevant inputs.
Ten package typechecks, actual Web lint/build, 55-locale/15-check i18n and docs
checks pass. Overlapping focused lanes are not added to full-suite totals.

Individually reviewed current originals comprise 24 surface/theme/desktop-size
process states, 13 rich-content states, one performance state and four approval
states. Local 500-child disclosure uses 20 measured samples after three warmups:
p95 32.2ms, max 32.6ms, at most 31 mounted children, one root/no nested virtualizer.
No packaged performance or external-model execution is inferred. A synthetic
reader masking the real preview was caught by original-image review; controlled
paint-order RED/GREEN and permanent assertions correct that test fixture without
production changes. Interrupted and failed runs remain non-green historical evidence.

Verified owned port 4197 service, acceptance-local browser copy and two disposable
caches are removed; no owned process/listener remains. User configuration, data,
Main/c212, independent P5 and retained evidence are unchanged. Final requirement
audit, report and exact manifest live in `.ling-stack/acceptance/p2-ux3-20261016/`.

This is complete with concerns, not a full product/release pass. Desktop Node
remains 1734 pass/16 fail/33 cancelled/4 skipped with retained prerequisite,
physical-path and unchanged-HEAD mock-lifetime diagnoses; Desktop authored-input
2, Electron preview 28 and preview a11y 3 pass separately. Design specialist
stopped at its dirty-tree guard; manual screenshot review is not specialist
completion. Installed client, external provider, native Windows, packaging and
shipping gates remain unverified/outside this authorization. Unknown effects
remain blocked. The dated checkpoints below are history, not current status.

The user authorized UX3 as the final P2 source/local batch on 2026-10-16, followed
by aggregate regression, evidenced bug fixes, documentation and owned-resource
cleanup. No UX4, new engine, packaging, installation or shipping is introduced.
Evidence is retained at `.ling-stack/acceptance/p2-ux3-20261016/`. The first real
browser regression reproduced keyboard focus loss when a focused command row
leaves the root virtual window. UX3 and aggregate P2 acceptance remain incomplete.

#### UX3 Source/Local Checkpoint (2026-10-16)

Confirmed defects now have retained RED/GREEN browser evidence: a focused virtual
row unmounted during scrolling; a Mermaid preview lacked a focus trap and opener
restoration; a closing tooltip's enter animation intercepted immediate Escape;
and the channel feed's Enter shortcut intercepted native disclosure buttons.
Only the focused root row is pinned outside the current window, including its
portal-owned dialog; moving focus retires the pin. Shared Dialog owns preview
keyboard/focus behavior. Application-owned existing translated labels now cover
process/batch groups, child lifecycle and preview controls without new locale keys.

Focused verification passed: 22 scale/matrix cases, 17 accessibility/windowing
cases, and a subsequent 12-case canonical-order screenshot matrix. Normal/private/
channel, light/dark, 1280x800/1440x960, Chinese/English preview controls, actual
clipboard copy, reduced motion and no streamed-token live region are covered.
The 500-factual-child fixture mounted at most 31 focus rows with one root and no
nested virtualizer; 20 warmed expansions measured p95 31.9ms on Apple M4 Chromium
156. This is controlled local evidence, not a provider or packaged performance claim.

Original failed reports remain. Two validation defects were corrected separately
from product fixes: missing scoped workspace-change responses caused mock 404s;
the performance helper counted all depth-marked nested elements instead of the
contract's focus rows. The 48-focus-row budget is unchanged. Existing batch scale
tests now open the current process disclosure before its batch and count the
distinct process header; no production grouping or windowing limit was weakened.
The screenshot matrix also fixes equal-time mock reply ordering and asserts the
user row precedes its response. Early captures with the bad fixture are historical.

Source snapshot `aggregate-source-start.json` has fingerprint
`5f647baa7a7ed7278307a9e1d52087b226f8a6d060d562d371e506bbf8474ef4`.
Ten affected package typechecks, eight package builds, actual Web lint/build,
55-locale i18n and docs checks passed. Aggregate units/capability regression,
independent review, final evidence binding and owned-process cleanup are still
in progress. Do not mark UX3, full P2 or release acceptance complete from this
checkpoint. Evidence lives under `.ling-stack/acceptance/p2-ux3-20261016/`.

#### UX3 Aggregate Regression Checkpoint (2026-10-16)

The full Core run has 2446 passes and Runner has 253 passes. These lanes terminated
successfully. The broader lanes have now terminated: Web 1407 pass / 49 fail /
7 not run (1463 total), Daemon 3627 pass / 10 fail / 1 cancelled (3638 total).
Neither full lane is green. Original reports remain authoritative for those runs;
later overlapping focused results must not be added to their unique totals.
The first Web and Daemon aggregate attempts were interrupted for evidenced repairs
and remain historical. Do not add overlapping focused lanes to unique totals.

Concurrent channel submissions reproduced a real UX1 regression: an in-flight send
was confused with a lost response, and a later send could overwrite its receipt
pointer. The scoped journal now retains all unresolved keys, distinguishes live
ownership and removes only the acknowledging key. Twelve unit cases, three existing
send regressions and two light/dark lost-response/reload cases pass. The latter
assert actual visible messages, one original POST per input, query-only recovery
and preservation of a newer draft. Earlier weak screenshots with an unconfigured
provider remain historical; the corrected captures were visually inspected.

Independent review reproduced a safety gap in stop evidence: an empty executor
registry was treated as complete coverage. Positive settlement now requires the
durable original completion's `drainedAt` and `effectCoverage`, retaining pending
and unknown vetoes. Both successful/failed incomplete-inventory adapters remain
unverified live and after reopening storage. Focused Daemon 53 passes include
actual local SDK/read/shutdown paths. Follow-up read-only review found no new issue
in this repair; this does not prove an actual Desktop Host-open effect completed.

Desktop preview renderer/a11y warm-cache runs pass 28/3 cases. Their first runs
failed during Electron download; those original results remain. Desktop Node's
full run is not green: 1732 pass, 18 fail, 33 cancelled, 4 skipped. Isolated
diagnosis confirms three cancellation roots are existing unref-timer/mock-handle
test-lifetime problems in unchanged HEAD source. Other failures include missing
native/packaged prerequisites, a symlinked Git executable and fixed Office source
inventory drift after the new P2 imports. An explicit AST closure review found
18 missing authored inputs and no unresolved imports or new vendor dependencies.
Those exact paths were added to the fixed source inventory and its two tests pass;
production approval and digest records were not refreshed. The other failures
remain separately tracked; no packaged, real-Windows or release pass is claimed.

Five channel disclosure/late-result/terminal-resize cases pass after updating
obsolete assertions to the existing process disclosure and final-summary owners.
Full capability regression, current Web statics/build, final evidence binding,
design review, documentation consistency and owned-resource cleanup remain open.

Subsequent focused regression aligns existing process-disclosure and canonical
response-footer selectors without removing ordering, fact, color or owner checks:
normal narration/color 22 pass and private narration/exploration 9 pass. A genuine
late SDK informational event regression is separately fixed: closed local-writer
admission drops informational events without throwing, while executable callbacks
still reject. Its original RED and rebuilt GREEN (10 tests) are retained. Four
stop-fixture assertions now distinguish settled enrolled operations from unverified
whole-effect coverage; actual SDK usage fixtures replace synthetic goal completion.
The affected stop/goal lane passes 64 tests. Real compaction crash recovery still
fails before any provider request and is under investigation; no full P2 completion
or packaged/provider acceptance is implied by these focused results.

#### Aggregate Follow-Up And Checkpoint Handoff Boundary (2026-10-16)

The channel return-owner regression passes 30 browser cases, Web units pass 462,
and the generic Host-effect blocker lane passes 37 integration cases. The expanded
concurrent-send lane passes four light/dark cases, including a still-pending newer
request when an older response is lost; its genuine pending-state screenshot was
visually inspected. These focused results do not replace the non-green full runs.

The workflow budget fixture now exercises the actual SDK rather than a fake
Runner. Production pack measurements show that 16 capped dependencies fit a 4K
packet without compaction, while 20 trigger dependency compaction and retain its
summary. The measured pair passes: the original 1800-token window rejects before
any provider call; the 4096-token window compacts and admits exactly one local
synthetic response. No production budget or SDK capacity check was relaxed.

At the earlier diagnostic checkpoint, real SIGKILL restart failed with
`resource_conflict`; cancellation prevented replay. A dead process does not prove effect completion, and a sealed
`tool_end` does not certify an off-mode Host write. The repair must therefore use
a separate checkpoint-resource handoff, not a fabricated stop/drain receipt:

- Observe the original SDK inventory only inside its provider-admission boundary.
- Observe native file completion at the actual Host patch executor, independently
  of SDK result text, and bind its exact provenance artifacts and captured fence.
- Seal those observations to the exact committed checkpoint and source sequence.
  Missing inventory, pending/unknown Host operations or unaccounted tools withhold
  handoff authority; they do not change off/shadow execution policy.
- Revalidate source, latest checkpoint, post-checkpoint progress, effects and
  cancellation inside the same SQLite transaction that activates the successor
  and releases only the exact predecessor's leases and semaphore slots.
- Keep the original completion's `drainedAt` and `effectCoverage` untouched.
  Generic release/expiry and positive stop evidence retain their existing vetoes.

The exact checkpoint-resource handoff is now implemented. Rebuilt focused
verification passes28 Core cases and9 real local Daemon restart/privacy/public
artifact cases, including sealed-write and immediate-post-compaction SIGKILL
recovery without replay. Empty SDK turn-start markers before provider admission
are not task progress; later tool/output/effect progress still blocks recovery.
The original completion's drain/effect fields remain untouched. Internal recovery
receipts are durable but excluded from user artifact listing/metadata/content.

The authored Desktop runtime closure has four explicitly reviewed new leaves and
zero missing/unresolved runtime edges; no production approval/digest was refreshed.
These focused results do not replace full regression: prior Web1407pass/49fail/
7not-run and Daemon3627pass/10fail/1cancelled remain non-green. Full Core2480
passed before the last marker repair; a newer run was interrupted without a
summary and is not a pass. Fresh aggregate checks and final source/build/evidence
binding remain required. This is an evidenced recovery repair, not new engine work
or full P2/release acceptance.

#### Current Aggregate Verification (2026-10-16)

The current full Core suite passes2481 tests. All21 refreshed static/unit lanes
pass, including ten typechecks, Web lint/build,55-locale i18n/docs and seven package
unit suites. The206-case former Web failure-file union passes. Desktop preview28,
accessibility3 and fixed authored-input inventory2 pass; this is not an installed
client or native packaging result. The broader affected Daemon98pass/1fail retains
its crash-child ready timeout; isolated retry1 and current combined recovery/privacy
44 pass without increasing the timeout or weakening the production boundary.

The next full Web/Daemon runs stopped without terminal summaries; original handles,
PIDs and owned4197 listener were confirmed absent. Those incomplete runs are not
passes. Fresh full regressions use new logs on identical pre-run source/build
captures, retaining the original failures and seven pre-existing dirty PNG hashes.
UX3/P2 closure still requires terminal aggregate results, genuine screenshot review,
final source/evidence binding, documentation consistency and owned-resource cleanup.

The independent Web run was intentionally stopped at318/1471 after a real Plan
History source-location failure, before changing source. A one-variable feed reflow
reproduced5/5 failures: an outstanding pinned-follow callback returned the reader
to the newest message. A permanent baseline/reflow regression failed2 cases before
the repair. Explicit source-location intent now cancels initial/pinned/grace follow
and its queued frame before the existing locator runs. The two cases repeated3
pass6, with inspected genuine source-position screenshots. Latest Web typecheck,
lint,462 units and build pass. Fresh full Web1472 runs against sourcee66efd71/
build35f51f4a; only3 Web sources and Web build outputs changed. The live full
Daemon run retains unchanged backend inputs. Original failures and incomplete runs
remain retained; neither fresh full run is declared green before its terminal result.

The full Daemon subsequently terminates3657 PASS,0 fail/cancel/skip,exit0. The
refreshed complete Desktop Node run terminates1734pass/16fail/33cancelled/4skipped,
exit1, not green. Comparing exact non-green test names adds none and resolves the
two reviewed authored-input cases. Remaining failures are missing bundled/native/
preload prerequisites and physical Git-path checks; unchanged timer/mock-lifetime
cancellations retain their earlier control evidence. This does not establish
installed-client or Windows acceptance. Full Web remains running.

That Web run later loses the browser at case668, records missing shared-cache
executable launch errors, then receives SIGTERM with Vite. Both original workers
are confirmed absent before recovery; no terminal full pass is inferred. Source
and build fingerprints remain identical. A fresh complete1472-case run uses an
acceptance-only browser runtime copy whose22 files are byte-identical to the
existing cache; no download/global configuration change or assertion reduction.
All24 current-source matrix PNGs were individually inspected and their hashes
recorded. The measured500-child current fixture has p9531.9ms, at most31 mounted
rows, one root and no nested virtualizer. Final full-run/evidence/cleanup gates
remain open; these captures and measurements do not turn the interrupted run green.

The recovered original full Web run terminates1469pass/3fail,zero skip/flaky,
exit1 at10:11:01. It was frozen through completion. One genuine reading defect
and two test defects are retained with diagnosis: a virtualizer measurement scroll
was recaptured as navigation; reconnect asserted applied14 while policy refresh
was incomplete; the AppShell source assertion expected obsolete mixed error ownership.

Ordinary/private permanent timing cases reproduce5/6RED(private3/3); explicit
measurement-scroll identification passes10/10GREEN. Combined native reading,
reconnect's held-refresh13/applied14 and separated error/provider ownership pass
40 repeated cases. Extending the same timing to channel reproduces2/2RED, including
row71 becoming77 or offset drift25px. Its existing reading owner now preserves
measurement compensation and passes10 native/timing repeats. Genuine before/after
originals were inspected. No tolerance, deadline, production cursor order or
authority changed. The channel test also waits for the actual expanded response
instead of passing before the reflow arrives. Source-local full Web acceptance,
fresh exact inventory/build binding, visuals and owned cleanup remain open.

#### UX3 Selection And Receipt Test Boundaries (2026-10-16)

The subsequent complete browser run terminates non-green. Controlled response
gating identifies three test synchronization defects, not new permission or stop
authority defects. Run guidance must be entered only after the newly selected
detail is loaded; the regression now deliberately delays the old stop receipt
until the new draft belongs to its new owner, then verifies settlement and one
cancel mutation. Full-access reload parity must wait for client-side acceptance,
not a server request counter. Normal confirmation is checked after thread binding;
private unknown input remains blocked rather than being dispatched again.

The permanent tests retain their original assertions and deadlines. Focused
repeats, Web statics/units and localization checks pass without production changes.
Complete related receipt/stop capability regression and a fresh independently
listed full inventory remain required before closure. Retain original reports and
controlled RED/GREEN evidence in the ignored acceptance directory; do not upgrade
a failed run to green or treat this as installed-client/provider acceptance.

Use Main's existing typed registry and eligible command/exploration display projection,
with exact atomic evidence and thread/Turn/Attempt/participant/action boundaries. Test
reversible disclosure and individual access to failures, waits, approvals, consequential
changes and sources. No group count, caption or visible tool text supplies success/fan-in.

Preserve shell-first heavy-content deferral and one root display-row virtualizer. Opening
logs/media/diff/child details must not add a vertical feed, change canonical order or lose
focus/anchors. Apply the existing Main child-windowing/DOM/accessibility gates; measure
actual source-bound performance rather than promise a new unmeasured speed target.

Keyboard/focus behavior is tested during UX1/UX2 as well as closed here. Check navigation,
copy/edit/menu actions, approve/deny/questions, locator-assisted virtual focus, failure
retry and restoration after a closing menu/dialog. Announce meaningful state transitions
with bounded live regions, not each token. Respect reduced motion and preserve current
translation ownership/55 locales without adding explanatory gray UI text.

### Objective Coverage And Acceptance

| Objective | Delivery batch | Acceptance |
| --- | --- | --- |
| UX-G01 Stable streaming | UX1 | UX-A01, UX-A02, UX-A08, UX-A09 |
| UX-G02 Reading anchors | UX1; retained through UX2/UX3 | UX-A03, UX-A07, UX-A11 |
| UX-G03 Attachments | UX2 | UX-A04, UX-A08, UX-A09 |
| UX-G04 Recovery/stop | UX1 receipt base, UX2 closure | UX-A05, UX-A09 |
| UX-G05 Process display | UX3 | UX-A01, UX-A08, UX-A10, UX-A11 |
| UX-G06 Decisions/accessibility | UX2 ownership; accessibility throughout, UX3 closure | UX-A06, UX-A07, UX-A09, UX-A11 |

| Gate | Required scenario |
| --- | --- |
| UX-A01 | Normal/private/channel root/topic/branch and depth-1 child share canonical identity/order/result facts; one root Timeline/vertical scroll owner, no duplicate Header or child virtualizer |
| UX-A02 | Stream/reconnect/duplicate/reordered/pending-to-durable/final-only output; unfinished Markdown/code completes in place with one reply identity and no duplicate execution |
| UX-A03 | Tail follow, up-scroll, search, prepend, media/disclosure/child changes and sidebar/dock resize preserve stable row anchor; explicit return-to-latest and collapsed-parent fallback |
| UX-A04 | Mixed attachment outcomes, selected-file retry/remove, remove-during-upload, stale completion, switch-before-result, failed-send restoration and message-bound versus orphan cleanup |
| UX-A05 | Proven-unaccepted resend versus accepted/unknown receipt recovery, supported regenerate/continue/effect retry, authoritative stop; partial output, no replay and owned cleanup assertions |
| UX-A06 | Approval/question wait, once/deny/valid persistent rule, failed decision retry, duplicate/stale answer, safe-yield, cancel/restart and one mutation owner with current Attempt fencing |
| UX-A07 | Keyboard/menu/focus restoration/live-region/reduced-motion through changed states; no duplicated announcements or dead controls; actual console/page-error checks |
| UX-A08 | Long text/code/log/attachment/media and empty/loading/error/wait states, light/dark at 1280x800 and 1440x960; genuine source-bound screenshots |
| UX-A09 | Existing supported capabilities/resources remain reachable and policy-correct after targeted UX changes; passing paths preserved, no working action removed or permission widened |
| UX-A10 | Eligible typed batching is reversible and preserves atomic lineage/evidence; failures/waits/consequential actions remain inspectable, result and fan-in owners unchanged |
| UX-A11 | Root-only windowing and existing Main child DOM/reachability gates, virtual unmount/remount preserves disclosure/focus/anchors, rapid surface switches preserve ownership; measured performance evidence |

Use unit/projector/renderer fixtures for identities and structural ownership, integration
fixtures for receipts/effects/cleanup and real interactions for focus/reading geometry.
Record capability and structural regressions for every changed path. Caller deletion
is not a P2 task. Existing transcript packaged/reconnect/restart and safety gates
stay with their owners. Neither screenshots nor documentation checks replace tests.

Mobile is not added to this acceptance scope. Screenshots are real browser/client captures
of changed states, not generated images; they accompany logic/identity assertions rather
than replacing them.

## Verification Commands And Evidence Ownership

Documentation checks are `corepack pnpm check:docs`, `git diff --check` and SDD
JSON/revision/task consistency. UX1 targeted source checks use Web typecheck, repository
contract lint, i18n, build, conversation Core/React and affected Web unit/browser suites.
Record exact command/source and distinguish these from full-suite/package acceptance.

Later code batches must discover current scripts again, then execute Contracts/Core/
Daemon/Runner/API/Web/Desktop typecheck/build/tests, i18n, migration/security regressions,
full Web E2E and Desktop renderer/a11y/platform lanes. `pnpm -r test` is one lane group,
not a substitute for E2E. Distinguish stub lint scripts from actual linting. Preserve
macOS helper and actual Windows requirements rather than downgrading to Linux fixtures.

Keep detailed outputs, captures and package manifests in CI/Release or ignored acceptance
storage, not new screenshot/document diaries under `docs/`. SDD retains the current
plan/task/verification state and append-only requirement delta. Bind each result to its
source/input/configuration snapshot; missing evidence remains incomplete.
