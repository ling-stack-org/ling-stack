# Terminal denial recovery preserves conversation recency

## Confirmed defect and bounded repair

Startup scans denied approval checkpoints. An already failed Run/WorkUnit still
needs decision-event reconciliation, Thread projection repair, narration recovery
and the terminal callback. Previously that branch passed startup wall time to
the Thread projection. Merely reopening Ling therefore moved an old denied
conversation above newer conversations, without new execution or user activity.

Only this already-terminal recovery branch now selects its projection time from
the later of `run.endedAt ?? run.updatedAt` and the existing `thread.updatedAt`.
The Run's durable time repairs stale projections; the Thread time retains later
user changes. It does not use the recovery wall clock as conversation activity.
Only the Thread storage projection receives this historical activity timestamp.
Goal/narration maintenance and terminal reconciliation retain the actual current
time. The shared terminal helper accepts a distinct optional Thread activity
time; every existing caller defaults to its unchanged current time.

No early return bypasses the projection or terminal callback. First-time denial
finalization, approval decision evidence, pending-input projection, goal and
narration hooks keep their existing paths. No new table, permission, model
request, history rewrite, timestamp cleanup or tool retry is introduced. This
does not repair previously advanced timestamps or redesign goal accounting.

## Verification and limits

`packages/daemon/test/approval-resume-recovery.test.mjs` extends the existing real
temporary SQLite fixture at `ApprovalResumeCoordinator.registerStore`. Only
Date is deterministic; no production test seam is added. Three cases cover an
already correct projection, a stale waiting projection and a later user rename.
An additional case creates a Goal after Run completion and checks recovery does
not backdate Goal.updatedAt. They check a genuinely newer conversation stays first, repeated recovery remains
stable, reconciliation continues, and Run/events/checkpoint/Attempts stay exact
with no tool effect. The first invalid fixture lacked a required objective; it
was corrected before either product RED or the product edit.

Two identical pre-repair runs failed all three recency assertions. The first
candidate passed those checks and 61 adjacent tests, but independent review found
the missing Goal clock boundary. Its evidence remains immutable in
`output/e6-20260928/p5-denial-recency-repair-20261026/`. The Goal case then failed
twice against that candidate; clock separation repair and final revalidation are
recorded separately in `output/e6-20260928/p5-denial-recency-clocks-r2-20261026/`.
Final compilation and 4/4 exact cases pass. The isolated expanded sweep passes
84/85: all 62 approval/narration/input checks pass, while the added API suite's
topic-pagination case returns two extra items. The same failure reproduces on
its own; native V8 coverage confirms none of the three modified terminal
functions executes in that case. Its root cause remains to be diagnosed; it is
not waived or claimed fixed. Initial API startup failures used an implicit
workspace with an old migration marker; the replay uses an owned temporary
workspace/home without changing migration checks or the old data.
Final three-input independent source review found no remaining introduced
issue, with matching first/end hashes. This is not a whole-branch pass.

These are source/temporary-SQLite checks, not new packaged GUI acceptance. The
currently running QA package predates this repair. Its successor requires the
normal packaging-input delta review/freeze and actual restart readback. R02 real
transport fault, remaining packaged cases, H09 and the overall E6 goal stay open.
