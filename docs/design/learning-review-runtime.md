# Bounded learning review runtime

Status: implemented backend, opt-in; UI and broader source enrollment in progress
Owner: daemon learning coordinator and SQLite learning review store
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
`correction` explicitly enrolls one selected task. The daemon resolves task/channel/teammate
ownership and membership from the durable Run, never from a supplied scope. The first
source adapter requires a persisted task and terminal Run. Failed/cancelled Runs are
available only through explicit selection; their status is preserved and successful local
steps need actual successful tool evidence. A correction requires a selected skill.

Automatic enrollment considers only newly completed successful multi-step Runs after the
policy's enablement time. It does not scan old conversations. Confirmed decision/turn
sources remain a follow-up adapter; private conversation Runs without a persisted task
are safely skipped by the current adapter.

The frozen evidence contains at most 64 items and less than 32 KiB. The current adapter
uses a smaller 6,000-byte text window, redacts secrets, records omitted ranges, event count,
source timestamps, selected definition revision and effective source Attempt. Every method
step and verification cites a supplied event with a literal quote; verification requires a
successful tool result. This checks fidelity to supplied evidence, not effectiveness in a
new execution. Missing results may produce `none`.

## Durable job and execution lifecycle

Migration 179 adds `learning_review_policy` and `learning_review_jobs`. A unique
workspace/source Run/source Attempt/evidence digest identifies one logical job across
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

The initial production transport supports explicitly configured, non-reasoning
`openai-completions` presets. Unsupported APIs/models fail before model dispatch. It
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
packaging. Provider-quality evaluation and the UI review journey remain separate gates.
