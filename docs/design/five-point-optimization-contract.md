# Conversation Experience And Test-Duration Contract

Status: current planning contract for P2 conversation experience and P5 test duration
Owner: conversations, Web/Desktop and CI maintainers
Last verified: 2026-10-17 (P2 rebased onto `origin/main@a44c4377`; source/local revalidation complete and PR delivery authorized; installed-client/provider/platform release acceptance remains open)
Document type: cross-feature product and architecture contract
Planning baseline: `b529a4b475f41442b29b59ff5bfeeece8879c74e` (`origin/main`)
Delivery integration baseline: `a44c4377832b74416cbd332e626a322f9f35ab8d` (`origin/main`)

## Purpose And Authority

This planning contract covers two independent workstreams:

| Original point | Current scope |
| --- | --- |
| P2 Conversation interaction reliability | Existing-Main behavior, evidence gaps and bounded fixes |
| P5 Full-suite test duration | Complete coverage, isolation and measured scheduling |

The paired [implementation plan](five-point-optimization-implementation-plan.md)
owns the delivery sequence. Existing product, permission, protocol, recovery and
release contracts remain authoritative for existing functionality.

The 2026-10-13 request authorizes P2 source implementation and isolated local
verification. Implementation uses `codex/p2-conversation-experience` at Main
`4a6480196b0656e733b11376f088494f168ad47f`. The original dirty checkout, local
Main, independent P5 worktree, user data, credentials and model configuration
remain unchanged. Commit, push, PR, installation and packaging are not authorized.

That sentence records the original 2026-10-13 boundary. On 2026-10-17 the user
separately authorized rebasing, renewed source/local verification, push and PR.
Installation, packaging, external-provider and native Windows acceptance remain open.

## Evidence And Baseline

| Evidence | Meaning and limitation |
| --- | --- |
| `origin/main` at `b529a4b4`, 2026-10-09 03:38:16 +08:00 | Pinned historical planning snapshot, not today's latest Main or a certified platform release |
| Main `4a648019` verified on 2026-10-13 | P2 isolated source baseline; matches live remote Main at verification time, not a certified release |
| Historical testbench, 2026-10-03 | Same-inventory Node concurrency experiment, not a current-Main speed or correctness result |

The retained detailed discussions are `会话优化` and `测试时长优化`.
Source inspection identifies implementation inputs and evidence gaps, not runtime acceptance.

Source anchors below were rechecked in the isolated implementation tree. The earlier
planning baseline remains historical; it is not the serving source. A later Main update
requires an affected-interface check and renewed evidence before implementation resumes.

## Shared Invariants

- Preserve Ling UI 2.0, the existing information architecture, user data and 55 locales.
- Keep workspace policy, host capabilities, runner support and participant permissions
  as separate inputs. Effective capability is their validated intersection.
- Discovery, login, a screenshot or a successful probe does not authorize execution.
- Decisions, accepted inputs, Attempts and outputs retain durable identities. Never
  infer ownership, approval or successful effects from text, timing or visible UI.
- Stop, recovery and retry must distinguish not submitted, accepted and unknown outcomes.
  Unknown side effects are not permission to replay them.
- Keep historical evidence available, but mark it historical for changed source,
  dependency, configuration, protocol, platform or package identities.
- No implicit fallback to Pi, native always-allow, credential import, paid verification
  or feature removal is introduced to make an incomplete gate appear green.

## P2: Conversation Interaction Reliability

Borrow assistant-ui interaction and state ideas, not its complete framework or visual
system. The original `会话优化` discussion retains all six objectives below and its
three delivery batches. Main is the implementation starting point, not a second task to
rebuild or migrate toward. This revision replaces the previous blanket architecture
preflight with a per-objective map of existing behavior, evidence gaps, necessary local
changes and acceptance. Source inspection is not runtime acceptance.

### Six Preserved Objectives

| ID | User outcome | Main-aware implementation direction |
| --- | --- | --- |
| UX-G01 Stable streamed messages | One reply stays readable while arriving, reconnecting or arriving only at completion | Preserve canonical identity/order; update the shared document renderer in place, including incremental Markdown/code |
| UX-G02 Stable reading position | Reading history or a search result is not interrupted by new output or layout changes | One viewport policy, stable display-row anchors and explicit return-to-latest |
| UX-G03 Recoverable attachments | Each file reports its own outcome and can be removed or retried without damaging others | Reuse upload APIs and identity fencing; converge per-file settlement across surfaces |
| UX-G04 Safe recovery and stop | Resend, regeneration, continuation and side-effect retry have distinct consequences | Recover accepted inputs by receipt; use existing Host capabilities and authoritative terminal/cleanup facts |
| UX-G05 Compact, auditable process display | Successful routine work is compact; failures, waits and consequential changes remain inspectable | Existing typed registry and reversible display batching, never narration-derived tool facts |
| UX-G06 One decision owner and accessible controls | Approval/question actions are not duplicated, and keyboard/focus/announcements remain usable | Existing approval/input receipt owners, typed callbacks, bounded live regions and reduced motion |

### Current Main And Evidence-Based Improvement Boundary

The pinned Main already mounts `ConversationTimelineFeed -> mountConversationTimeline`
once for normal, private and channel viewports. Channel root/topic/branch facts use the
same composition, and depth-1 Agent rows belong to the root display model. Reuse this
structure: one Timeline, one vertical scroll owner and root-only display-row windowing.
Do not rebuild a shared timeline or reintroduce `ConversationVirtualFeed` underneath it.

Normal/private use `renderMessageChrome` in the inspected Main implementation. Main's
component contract records a longer-term typed presentation/interaction target, but that
interface cutover belongs to the existing transcript plan. It is not an added P2 task or
a universal prerequisite for improving streaming, scroll, uploads or recovery. Do not
delete production callers or replace their interface solely to complete this UX plan.
This correction does not cancel the original transcript plan or weaken its contracts.

| Objective | Existing Main implementation / source anchor | Evidence gap or confirmed difference | Necessary scope and acceptance |
| --- | --- | --- | --- |
| UX-G01 Streaming | Shared Timeline/document rendering, canonical projection and send lifecycle; normal/private feeds already mount the root | Controlled UX1 regression reproduced position-based row remount and inactive-virtualizer scroll reset; real replay/reconnect acceptance remains open | Stable display identity and conditional virtualizer binding repaired; unfinished fences complete in place. Preserve receipts/result owners. UX-A01/A02/A08/A09 |
| UX-G02 Reading | Root display model/locator exists; normal, channel and private controllers handle scroll separately | Controlled tests reproduce search/resize/prepend/virtual-row anchor gaps and cover normal/private/channel root/topic/branch parity; installed-client acceptance remains open | Route feeds reuse row/offset restoration, non-expanding locator fallback and shared keyboard intent; tail-follow resumes only through reader intent. UX-A03/A07/A11 |
| UX-G03 Attachments | Normal controller catches each upload separately; private `uploadPrivateFiles` uses batch-wide `Promise.all` rejection | One private upload rejection marks that batch's files failed in source; retry/remove/late cleanup needs controlled reproduction | Repair private per-file settlement using existing upload API and owner guards after a deterministic failing test; verify other surfaces, do not rewrite a working upload path. UX-A04/A08/A09 |
| UX-G04 Recovery/stop | Send lifecycle, accepted-input storage, Runner continuations and Daemon cancellation already exist | Before/after-ready loss, empty streams, accepted 400 responses, reload/query-only recovery and topic/surface ownership pass controlled browser regressions; six cases use real HTTP handlers and isolated SQLite. External-model/installed-client reconnect remains unverified | Approved private initial-submit identity is stored on native messages; normal/channel use existing input keys. A scoped lookup-pointer journal survives reload without storing message text or granting authority. Receipt reads never automatically replay input. Stop/cleanup stays in UX2; no new engine or receipt authority. UX-A05/A09 |
| UX-G05 Tool display | Typed command/exploration renderers, display batches and original atomic evidence already exist | Group eligibility, failure visibility and disclosure behavior require current parity/interaction proof | Verify existing grouping; adjust only failing presentation/eligibility while preserving atomic facts and result owners. UX-A01/A08/A10/A11 |
| UX-G06 Decisions/accessibility | Approval/question renderers, durable answer/decision owners and existing interaction controls exist | Single-action ownership, focus, announcements and reduced-motion behavior require scenario-based verification | Test existing controls; fix only an evidenced duplicate, unavailable focus target or accessibility defect. UX-A06/A07/A09/A11 |

These rows distinguish source-confirmed behavior from runtime-reproduced defects and
unverified acceptance. A missing screenshot, different controller or future interface
target is not sufficient evidence for a rewrite. A passing behavior remains reuse plus
regression; a failing behavior gets an exact source owner, failing scenario, minimum
change and gate ID before implementation. If a local fix genuinely needs a new interface,
record that dependency and obtain its scope decision instead of importing all E4 work.

The authorized P2 source/local scope is complete with concerns on 2026-10-16.
The exact final source has 1475 clean full-browser passes, all 1472 original case
identities retained plus three permanent timing regressions, and UX-A01..11
evidence reconciled. Core 2481 and Daemon 3657 pass on unchanged relevant inputs.
Forty-two actual current-run screenshot originals were individually inspected;
500-child disclosure p95 is 32.2ms with at most 31 mounted children, one root and
no nested virtualizer. This is local synthetic evidence, not a speedup promise.
Source/runtime equality and seven pre-existing dirty PNGs were checked before
owned browser/service/cache cleanup. The exact manifest and requirement audit
live in `.ling-stack/acceptance/p2-ux3-20261016/`.

The baseline private batch-upload rejection above is repaired by per-file outcomes,
selected retry/removal, identity-fenced late completion and orphan cleanup. Shared
receipt lookup, authoritative stop, process disclosure and accessibility regressions
are verified locally; unknown external effects still block replay and unsafe release.
The 13:10 UTC Desktop Node checkpoint (1734 pass, 16 fail, 33 cancelled, 4 skipped)
is retained historical evidence. The authorized Desktop follow-up now passes
1795 cases with zero failures/cancellations and four unchanged conditional skips.
Existing development prerequisites were built; deterministic timer/physical-Git
test fixtures were repaired without changing production timers or safety checks.
A real development-client send exposed missing bundled plugin metadata when the
workspace is outside the repository. Staging the existing three allowlisted files
beside the development daemon fixes that startup path without changing packaged
resource precedence. Two permanent regressions and a real isolated native send pass.
Electron preview renderer 28 and accessibility 3 passes retain byte-identical inputs.
Native normal-chat, Settings, light/dark, sidebar and 1280x800 resize/reopen checks
are separate evidence, using only the local protocol fixture, not an external model.
The new evidence is `.ling-stack/acceptance/p2-desktop-followup-20261016/`;
the earlier frozen evidence directory is unchanged. Its manifest additionally binds
the actual daemon bundle, three metadata files and signed local Office helper.
Design-specialist completion is not claimed after its dirty-tree guard; manual
original-image inspection is separate. No installed-client, external-provider,
native Windows, packaging or shipping acceptance is implied. No UX4 is added.

Delivery revalidation on 2026-10-17 uses `origin/main@a44c4377` as its exact
integration baseline. Core passes 3339 cases; Daemon passes 4899 with one existing
skip; Runner Pi 407, Contracts 88, API client 91 and Web 520 pass. Desktop Node
passes 2426 with four conditional Windows skips; renderer 28 and accessibility 3
pass. The final P2 browser union passes all 285 cases after a stale keyboard-intent
expectation was updated to the approved interaction contract. Root typecheck, lint,
build, the 55-locale i18n audit, documentation links and whitespace checks pass.
These results do not add installed-client, external-provider, native Windows,
packaging or shipping evidence.

Virtualizer measurement compensation is layout movement, not reader navigation,
even when its native scroll event precedes the new row transforms/total-height
commit. The Timeline identifies that write before it occurs; each existing reading
owner preserves its row/offset. Wheel, keyboard, disclosure, source-location and
explicit latest actions retain their own intent. Total-height equality alone is
not proof that a scroll came from the reader. Ordinary/private/channel permanent
early-measurement cases retain the native variants and original4px/5s assertions.

Preserve author/avatar/time/edited presentation, copy, edit/save/cancel, feedback,
topic reply/create-task, attachments, links/path/memory references, generated media,
recovery, approval and structured questions under their existing policies. This is a
regression list for targeted fixes, not a component-removal checklist. Do not invent
permissions, another fact array, result authority or renderer fallback.

P2 operates on existing Main conversation behavior. P5 scheduling optimization is
independent; relevant existing tests and safety gates still run. The historical UX1
verification served source at port `4187`; current UX3 uses its owned port `4197`.
Controlled component/API fixtures
do not certify live Daemon execution, reconnection or an installed client.

### Independent State Axes

Keep three independent state axes:

| Axis | Authority | Required distinction |
| --- | --- | --- |
| Sending | Existing send lifecycle | `submitting -> message_accepted -> reply_linked -> settled` is acceptance/linkage, not task success |
| Execution | Daemon/Core | Running, approval wait, user-input wait, failed, cancelled and completed are backend facts |
| Reading | Frontend viewport | Tail-following, history reading and search anchoring do not change execution state; this is view state, not a new persisted execution model |

### Batch 1: Reading And Sending Stability

- Preserve canonical reply/item identity and monotonic order across stream deltas,
  reconnect/replay, pending-to-durable reconciliation and final-only output. Do not
  create a second reply or treat commentary as the final result. `reply_result` and
  TerminalReport retain their existing, distinct result ownership.
- An unfinished Markdown/code fence stays safe and readable in the same item; completing
  it revises the body, not the message identity. Reuse the shared parser and escaping;
  no per-route Markdown engine or narration-to-command conversion.
- Follow new output only while the reader is following the bottom. Explicit up-scroll
  or search suspends following and makes return-to-latest available. Loading history,
  image decode, tool/child disclosure and sidebar/right-dock resizing preserve the
  visible `rowKey + offset`, including root virtualizer measurement changes.
- Programmatic anchor restoration is not a new user scroll intent. Resolve an unloaded
  or collapsed search target through the existing locator; collapsing the anchored
  child returns to its parent header as Main specifies, not an unrelated tail jump.
- A lost send response is recovered by the original accepted-input identity before any
  replay. Draft clearing and optimistic reconciliation follow receipt ownership, never
  a timer or visible assistant text. This batch does not redesign task completion.
- A live channel submission is not an unknown response. Queued guidance may still be
  submitted while an earlier request is in flight. Retain every unresolved key for
  the exact scope; an out-of-order acknowledgement removes only its own pointer.
  Reload recovery queries the oldest non-live pointer without replaying input or
  overwriting the reader's newer draft. Persist no message body or authorization.

### Batch 2: Recoverable Operations

- Each attachment has stable local identity, per-file upload/result/remove/retry state
  and the original workspace/conversation/draft operation fence. A removed or stale file
  cannot reappear when a late upload finishes. One failed file cannot mark another
  successful file failed or force it to upload again.
- Reuse successful draft artifacts on retry. Preserve existing send eligibility and
  file limits; do not silently drop failed/pending files to send a different message.
  Preview URL and uploaded-artifact cleanup depends on actual ownership: never delete
  an artifact already bound to an accepted message.
- Distinguish unaccepted resend, accepted-send recovery, supported regeneration,
  Host-approved continuation and effect-specific retry. Unknown submission/effect
  outcomes are reconciled first, not resubmitted. Unsupported operations are not
  simulated, replayed through a different engine or granted broader permission.
- Guidance recovery uses the original idempotency key on the existing Run/private
  intervention GET collection. Exact filtering happens before pagination and includes
  terminal records. The response echoes the applied key; an old server's unfiltered
  list or a missing item in recent/open history cannot establish non-acceptance.
- Stop preserves partial text, disables duplicate local submissions and remains pending
  until authoritative cancellation/terminal and owned-resource cleanup facts arrive.
  Failure or uncertainty stays recoverable; an optimistic local click cannot settle it.
  The original memory-only Host ticket may record independently verified no-start
  after exact-source logical cancellation, provided it never entered launch. This
  records a fact, not forward/cleanup permission, callback drain or restart proof;
  replaced Attempts, launched effects and unknown outcomes cannot use that path.
- Approval and structured user-input requests have one active mutation owner. Timeline
  facts/status can focus the owning gate/dialog, not duplicate its form. Preserve
  existing approve-once/deny and valid workspace-command-rule choices without expanding
  grant scope. Reuse `waiting_for_input`, safe-yield checkpoints, answer receipts and
  continuation fencing; late/duplicate/stale responses cannot start a second Attempt.
  A successful HTTP status without a usable same-ID terminal decision is still an
  unknown outcome: query the original approval without replay. Missing or malformed
  follow-up effect facts do not undo its recorded decision or prove execution recovery.

Main's private upload uses batch `Promise.all` with batch-wide rejection handling;
normal upload catches and settles each file. The gap is source-confirmed, not a fresh
browser reproduction. Normal is a reusable behavior reference, not proof that per-file
retry, cleanup and every surface already meet this contract. Existing scroll controllers
also need behavior parity despite their shared viewport.

### Batch 3: Process Display, Performance And Accessibility

- Use the existing typed renderer/registry and eligible reversible display batching.
  Keep thread/Turn/Attempt/participant/action boundaries and original atomic evidence.
  Failures, waits, approvals and consequential changes remain individually discoverable;
  a successful group must not hide them or supply completion/fan-in facts.
- Keep one disclosure owner per fact and lazy heavy details under the existing deferral
  policy. Disclosure, virtual unmount/remount and revision updates preserve reading
  anchors, selection and reachable actions; no second vertical feed or child Timeline.
- Keyboard and focus behavior is validated throughout all batches, with final closure
  here. Menus/forms restore focus to the invoking control or owning item; virtualized
  items use the existing locator. Live regions announce meaningful state transitions,
  not every stream token, and reduced motion disables optional movement.
- Compare logic/identity fingerprints together with real changed-state desktop captures
  in light/dark at `1280x800` and `1440x960`. Screenshots alone cannot close ownership,
  permission, recovery or cleanup gates; mobile is not added to scope.

### Authorities And Pinned Source Anchors

Main authorities and source anchors are inspected at the planning baseline; their
existing unfinished transcript architecture work is referenced, not adopted as P2 scope:
`docs/design/conversation-surface-contract.md` (v3.9.1 override),
`docs/design/conversation-codex-parity-component-detailed-design.md` (28.1.1 transitional
slice, 28.2/28.3 typed interaction/presentation, 28.5/28.6 windowing and cutover),
`docs/design/conversation-typed-transcript-detailed-design.md`,
`docs/design/conversation-codex-style-transcript-implementation-plan.md`,
`docs/design/conversation-user-input-and-sandbox-integration.md`,
`docs/design/conversation-command-execution-batching-detailed-design.md`,
`docs/design/conversation-activity-summary-and-exploration-batching-detailed-design.md`
and `docs/design/conversation-performance-deferral-and-virtualization.md`.

Source anchors: `apps/web/src/shared/conversation/timeline/`,
`apps/web/src/shared/conversation/blocks/ConversationTimelineFeed.tsx`,
`apps/web/src/shared/conversation/conversation-send-lifecycle.ts`,
`apps/web/src/shared/conversation/view-store/`,
`apps/web/src/features/workspace/NormalConversationFeed.tsx`,
`apps/web/src/features/workspace/ChannelMessageFeed.tsx`,
`apps/web/src/features/workspace/useNormalConversationAttachmentController.ts`,
`apps/web/src/features/teammates/TeammatePrivateChatFeed.tsx` and
`apps/web/src/features/teammates/TeammateWorkspace.tsx`.
Recovery anchors: `packages/core/src/storage/sqlite/conversation-accepted-input-store.ts`,
`packages/core/src/harness/continuations.ts` and
`packages/daemon/src/features/runs/cancellation.ts`. Process anchors:
`apps/web/src/shared/conversation/timeline/renderer-registry.tsx` and
`apps/web/src/shared/conversation/timeline/conversation-timeline-display-model.ts`.

## P5: Full-Suite Duration Without Coverage Loss

The goal is faster complete verification, not module-only testing, reduced assertions,
increased timeouts or old passing results reused after source changes.

Main already has build-once CI artifacts, platform lanes and per-process closed SQLite
fixture templates. Reuse them. Schema initialization/migration/recovery tests must still
use the real production initializer rather than a template that skips their subject.

Remaining source-confirmed constraints include single-worker Web/Desktop Renderer,
serial Daemon shard interiors, source-size rather than measured-duration weights and
no full Web E2E in root `pnpm -r test` or the checked CI workflow. Older sidebar locator
mismatch counts are historical; the inspected Main locators have already changed.

The full-suite runner must enumerate every lane and preserve each lane's assertion set.
Separate deterministic source regression from real-account, native/platform and package
acceptance. If a required lane lacks credentials or a platform, report it not run, not
passed. Continue independent lanes after a failure and aggregate a nonzero final result.

Measure build, initialization, execution, retry and cleanup separately. Reuse valid builds
by source/lockfile/toolchain/platform fingerprint; do not blindly cache live test success.
Each parallel worker owns its data, HOME/config roots, ports, output and child processes.
Balance shards by recorded durations, retain serial resource groups where required and
bound memory/timeout/retry behavior with explicit diagnostics.

Historical Node experiment: 497 files/5038 cases, serial 16m24s versus concurrency four
5m46s with matching outcomes; both had 142 failures, 33 cancellations and 10 skips.
Concurrency nine changed outcomes and was rejected. Web's 1030-case comparison and
Desktop Renderer acceptance were incomplete. None of these figures proves today's
Main pass rate, duration or a promised speedup.

Main anchors: `scripts/ci/daemon-test-shard.mjs`, `scripts/ci/run-packages.mjs`,
`.github/workflows/ci.yml`, `apps/web/playwright.config.ts`,
`apps/desktop/tests/playwright.renderer.config.mjs` and
`packages/core/test/support/sqlite-run-store-fixture.mjs`.

## Sequence And Hard Stops

### Minimal Persistent Host Completion Facts

The 2026-10-15 approval permits a minimal local Host lifetime journal independent
of tool-log enforcement. Registration captures the exact Run/WorkUnit/Attempt,
runtime and fencing token before execution. Only settlement of the original main
lifetime and all captured local callbacks records an immutable drained timestamp.
Restart recovery is read-only. Cancellation, elapsed time, missing registry rows
and tool-result text cannot manufacture completion. A failed write or interrupted
observation remains unverified; an old completion never certifies its successor.

This fact does not prove remote/process-descendant/background effects stopped.
Unknown effect evidence remains unknown, even with proven local drain. Preserve
off/shadow behavior, approval permissions and existing execution engines. Store
only source identity, timestamps and a bounded Host coverage discriminator, not
command/transcript/secret content. `pi_no_tools_v1` is affirmative only when the
original SDK's memory-sealed observation ended without entering any tool boundary
and the Daemon observed no direct Host tool callbacks. Structural copies, event
text, empty journals, other Runs/Attempts and failed observations cannot set it.
Persist it atomically with local drain; independent pending/unknown effect evidence
still wins. This observes existing off/shadow execution, never enables enforcement.

For supported tracked effects, the original ended SDK inventory and captured Host
callback tool-call IDs may establish `pi_tracked_tools_v1` only when Core independently
revalidates a durable, exact-source executor settlement for every ID. Migration 167
stores the closed inventory as identifiers, never arguments, command text or results.
Read, release and restart paths revalidate its executor facts; empty inventories,
missing IDs, unconfirmed Bash descendants and unknown remote outcomes cannot qualify.
This does not enable tracking/enforcement for off/shadow tool execution.

A pending registered lifetime independently vetoes exact-owner resource release
and TTL expiry, including after restart. Successful durable completion triggers
deferred cleanup through both resource tables in one transaction using their
existing owner/effect guards. Registration or completion failure cannot trigger
that cleanup; no old-source cleanup can release successor resources.

A registered source still owned by a nonterminal Run also vetoes release/expiry
after local drain. Preserve the existing approval-suspension cleanup only for the
exact lost `runtime_suspend` Attempt, a matching waiting Run/WorkUnit and its
pending/approved checkpoint identity. Known Host blockers veto every registered
release, including succeeded/failed sources. Ordinary noncancelled completion
otherwise retains existing off/shadow cleanup semantics; releasing its scheduler
resources does not manufacture positive effect coverage or continuation authority.
Cancelled cleanup still requires affirmative coverage and durable quiescence.
An empty or settled in-memory executor registry is not a complete effect inventory.
Positive stop/continuation evidence requires the durable original completion's
`drainedAt` and independently verified `effectCoverage`; pending and unknown facts
remain vetoes both before and after reopening storage. A preview's accepted receipt
does not certify a Host operation's external completion or the whole SDK inventory.

The existing committed required-input yield is a distinct physical-quiescence
transaction: after its original Host proof and durable executor checks pass, it
releases both exact-source resource tables before clearing the active Attempt.
Its enclosing completion observer may still be pending until the yield callback
returns. Keep that release inside the canonical yield transaction, with rollback
of both tables/checkpoint on failure; a generic release reason or TTL is no bypass.

Continuation dispatch waits outside the original terminal callback for both its
main lifetime and durable cleanup. Gate the root source and the actual preceding
continuation: every relevant Attempt must be locally drained with known effect
outcomes and no owned active resources. Succeeded/failed status alone is not enough.

Private continuation queue cancellation may retire only queued/cancelling records,
not an already claimed `starting_continuation` execution. Persist its new WorkUnit
and message identity as soon as execution starts; stopping that execution uses the
existing fenced stop path. A claimed queue record cannot be removed to admit a
second concurrent dispatcher.
Preserve root parentage, FIFO order and one claimed continuation per queue. Filter
eligible private queue statuses before pagination. Migration 168 captures private
guidance's original Attempt; source drift before or during preparation cannot adopt
a successor. Legacy ambiguous multi-Attempt guidance remains blocked.

Resource cleanup retries transient storage failure at most three times against
the exact source. Persistent failure retains the resources and diagnostic. Never
release a nonterminal source through completion cleanup. Completed in-memory
observers may retire only after durable positive coverage and all deferred callbacks;
unverified or required-pause observations keep their original recovery evidence.

P2 and P5 proceed independently using their existing owners and separately authorized
Main-based source snapshots. P2 does not require completion of P5 scheduling
optimization before its existing tests can run.

Preserve current functionality, data, permissions and relevant safety tests.
Missing ownership or unbound evidence remains a hard stop for later source work.
