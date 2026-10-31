# Bounded learning review runtime

Status: source implemented, opt-in; model quality and release acceptance remain separate
Owner: daemon learning coordinator and SQLite learning review store
Last verified: 2026-10-30
Document type: runtime contract
Canonical replacement: none

Ling's learning review extracts reviewable candidates from selected durable task evidence.
It does not publish skills, bind teammates, edit source bundles, change tools, or activate
memories. Existing memory, skill, protocol and playbook review rules remain authoritative.

## Enrollment and source ownership

`GET/PUT /skills/learning-policy?cwd=...` reads or changes the workspace policy. The
migration defaults to `off`; `propose` requires an explicitly selected provider preset and
an `expectedRevision`. Existing `semi_auto` skill policy is not model-call authorization.
A policy change cancels queued/running automatic jobs. Skill generation/recording controls
remain additional gates.

`POST /skills/learning-reviews?cwd=...` with `runId`, `providerPresetId` and optional
`correction` explicitly enrolls one selected Run. The daemon resolves task/channel/teammate
ownership and membership from the durable Run, never from a supplied scope. The first
source adapter requires a terminal Run and either a persisted task or a durable terminal
Turn linked to its owning non-archived thread. Normal, teammate-direct and channel reply
Turns preserve their durable owners; a transient request task id never grants task scope.
Failed/cancelled Runs are
available only through explicit selection; their status is preserved and successful local
steps need actual successful tool evidence. A correction requires a selected skill.

Skill provenance comes from the source Run's frozen `skillDefinitionSnapshot`, verified
against the historical revision's skill id and definition hash. A later registry revision
never becomes the source Run's revision. Explicit correction without verified provenance
fails with `learning_skill_provenance_unavailable` before model dispatch; an ordinary save
may still extract experience with that missing-evidence marker. If the current definition
has moved beyond the frozen revision, extraction results cannot publish against it.

Alternatively `decisionId` selects one active channel decision created by `local-user`.
Exactly one source is accepted. Unconfirmed AI drafts, rejected or superseded decisions
are ineligible. Only the decision text is read; referenced conversations are not traversed.
Decision evidence is not successful tool verification, so it can support knowledge candidates
but cannot manufacture a verified procedure. Channel inspector decisions reuse the same UI.

Automatic enrollment considers newly completed successful multi-step Runs and newly
confirmed decisions after policy enablement. Each bounded sweep checks ten recent Runs
and ten decisions in each of twenty recent channels; older items remain explicitly savable.
It does not scan old conversations. A decision has no invented task/Run. Memory candidates
use the existing task owner when available, otherwise the selected channel, teammate or Run.
Source edits, rejection, archive and ownership/membership changes invalidate frozen evidence.

The frozen evidence contains at most 64 items and less than 32 KiB. The current adapter
uses a smaller 6,000-byte text window, redacts secrets, records omitted ranges, event count,
source timestamps, selected definition revision and effective source Attempt. Every method
step and verification cites a supplied event with a literal quote; verification requires a
successful tool result. This checks fidelity to supplied evidence, not effectiveness in a
new execution. Missing results may produce `none`.

## Durable job and execution lifecycle

Migration 186 adds `learning_review_policy` and `learning_review_jobs`. A unique
workspace/source identity/source Attempt/evidence digest identifies one logical job across
manual and automatic enrollment. The job records policy revision, evidence, status,
WorkUnit/Attempt fence, reserved budget and output candidate ids. A partial unique index
permits one running review per workspace. Repeated enrollment returns the existing job.

The daemon uses the existing Runtime Supervisor and a `learning_review` WorkUnit, with
an independent Attempt and fencing token. No SQL transaction spans model I/O. Final
source, current-policy and Attempt checks occur in the same synchronous transaction as
candidate creation, job completion and durable event append. Live events follow commit.
An obsolete result cannot leave a partial candidate or overwrite a newer claim.

Foreground claimed/running work prevents a new review. A 250 ms observation boundary
aborts existing model I/O on foreground activity, cancellation, source changes, provider
changes, or generation-policy disablement. A 10 second heartbeat and 120 second deadline
bound a live review. Shutdown closes admission before aborting and draining owned calls.
Restart cancels old running reviews; it never replays an uncertain model call automatically.
Queued explicit jobs remain selectable if their sources and current policy still qualify.

## Model transport and budget

The initial production transport supports explicitly configured `openai-completions`
presets with `reasoning: false`. This setting does not establish whether an upstream
model performs internal reasoning. Unsupported APIs/models fail before model dispatch. It
materializes credentials through the existing provider resolver, performs one HTTP POST
per admission, disables redirects, exposes no tools or Agent loop, caps the response body,
and rejects tool calls, partial responses and malformed outputs.

Each admission durably reserves a conservative UTF-8 byte upper bound for input plus
2,048 output tokens before dispatch. A job permits at most two requests, 16,000 cumulative
input tokens reserved and 4,096 output tokens reserved. Only HTTP 429/502/503/504 may get
one delayed retry, within the same reservation and deadline. Other failures do not retry.
The provider receives a 2,048 `max_tokens` cap. Reservations are not billed usage figures.
Automatic jobs have a durable initial cap of 10 per workspace per UTC day; explicit saves
do not consume that quota but retain all per-job bounds. The policy can lower request,
input/output, timeout and daily quota limits. Limits are validated against the hard caps
and frozen on enrollment; a policy change cancels automatic work from the older policy.

## Candidate routing and user control

Facts/decisions use the existing memory consolidation pipeline and stay candidates in the
source task's scope. Procedures use the shared observation service, routing and duplicate
checks. A correction to an editable selected skill creates a pending `update_existing`
candidate with original tools, provider requirements and approval profile. Overlapping
pending candidates retain additional evidence instead of creating duplicate revisions.
Read-only skills are not rewritten. Channel-specific methods enter existing protocol or
playbook drafts and do not apply overrides or activate a playbook.

`GET /skills/learning-reviews`, `GET /skills/learning-reviews/:id` and
`POST /skills/learning-reviews/:id/cancel` expose the durable result and cancellation.
Pending means experience is available for review; it does not mean a skill was learned or
validated by replay. Definition history and user-approved application/undo are owned by
[Skill editing and revision](skill-editing-and-revision.md).

Focused coverage lives in `packages/daemon/test/learning-reviews.test.mjs`, including a
local HTTP provider fixture and daemon API round trip. It establishes dispatch, fencing,
budget and transaction behavior; it does not measure real model quality, cost, or platform
packaging. Provider-quality evaluation remains a separate gate.

The run diagnostics and unified settled-response footer provide a lazy Experience review
disclosure. Closed disclosures do not read or poll. Settings → Skills → AI evolution
uses the same component for policy, queue, cancellation and candidate review. Run-filtered
listing applies the source filter before the result limit. Pending results remain labelled
as awaiting review. Candidate steps, checks and original bounded evidence are inspectable;
non-skill results keep their existing memory/channel review surfaces. Definition changes
and undo use the skill editor and inspector described in the revision contract.

Channel message adapters retain their linked Run on the timeline item. A channel
terminal report carries the operation cell's Run only when that cell has one Run;
the shared footer may also resolve a unique explicit Run in the current response.
It never chooses an arbitrary latest Run from a multi-Run cell. Enrollment still
revalidates the selected durable Run and its owner in the daemon.

A local controlled HTTP provider and real daemon/browser journey cover explicit correction,
candidate review, application to the existing skill, history and restoring undo. This
demonstrates transport and product flow, not real-model quality or execution of the learned
procedure.

A separate isolated acceptance run used the user's local CPA gateway with `gpt-6-luna`
and artificial evidence. Four small extraction cases passed (procedure correction,
confirmed knowledge, missing-result rejection and malicious-tool-text rejection). A real
coordinator/HTTP/SQLite job produced one pending candidate, required explicit review,
updated the existing skill and restored its definition on undo. Safe old/new Runs used
the actual Pi runner and read tools, retained their respective definition revisions, and
returned correct receipt/ledger totals without changing inputs. Both methods succeeded
on this one case; it does not establish a quality improvement. CPA is a local gateway
and may forward inference remotely. Token usage was recorded; no monetary rate was
verified. Private-memory embedding in these acceptance samples stayed local and offline;
the optional retrieval contract separately defines any explicit remote/private opt-in.

Separate browser acceptance used real daemon/SQLite state, authored terminal sources
and a controlled local HTTP extractor for normal, teammate-direct and channel views.
Each exercised a missing-skill correction error with its draft retained, recovery to
an ordinary save, a pending memory, source inspection and explicit approval at the
original owner. Each view also completed skill correction, pending review, before/after
diff, application to the existing skill and restoring undo. The full definition, source,
authority and bindings were preserved, and the source Run retained its initial revision.
These are controlled UI journeys, not three real model conversations or actual execution
of the authored terminal/tool fixtures. Packaged-platform acceptance remains separate.

A separate CPA acceptance using `gpt-6.1-sol` completed the same verified-task lineage:
an actual read-only Pi Run read both receipt and ledger files, its successful `tool_end`
events became the selected learning job's exact verified evidence, and the result stayed
pending until explicit review. Application created the existing skill's next revision;
a subsequent real Run froze that revision and returned the correct reconciliation, while
the source Run retained its initial revision. Undo restored the complete original definition
without changing source or authority. The data was artificial, but the source tools and
learning chain actually ran. Both definitions succeeded on this one case; it establishes
the lineage and control flow, not a quality improvement or an exact CPA monetary cost.

The panel is keyed by workspace and selected Run/decision. Switching that identity resets
its local correction draft. Delayed reads and completion of an earlier save cannot repaint
the new source or replace its draft; the browser component acceptance delayed those HTTP
responses explicitly. This does not cancel a previously authorized save in its old workspace.

Memory results now expose their title, body, source refs and exact owner directly in the
shared result card. Explicit approve/archive calls the existing memory review action API;
there is no automatic promotion or ownership change. Channel protocol/playbook results
continue to point to the channel review queue. Read errors remain visible.

Optional semantic retrieval configuration and scoped Wiki browsing share the existing
Experience review disclosure. Their independent behavior and native distribution boundary
are owned by [Optional Memory Derivatives](memory-derived-views.md).
