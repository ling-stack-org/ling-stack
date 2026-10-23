# Turn process disclosure

Status: implemented, source/rendered regressions passed, and packaged macOS
real-history rendering accepted, 2026-10-01. This is not a new live-model run
or overall E6/Harness acceptance.
The 2026-10-23 activity-presentation increment has source/browser fixture coverage
in the production AppShell with a simulated Host; it does not renew packaged or
real-provider acceptance.
Extends conversation-turn-response-ownership.md; does not replace its completion,
copy, privacy or scoped Review authority.

## Responsibilities

One Turn contains ordered commentary and atomic tool facts, followed by the final
answer, net file card and one response footer. Process disclosure is a view-only
group, not a TerminalReport, another summary, persisted Item or nested Timeline.
Normal, teammate-private, channel and depth-1 Agent children use the same policy.

Conversation detail and channel pages expose optional `contextCompactions`, a
read-only reconstruction of SDK start/end Run events with Run/Attempt lineage.
These independent rows show running, succeeded, failed, cancelled or unconfirmed
results outside process folds. SDK installation is not a Host recovery receipt;
this projection changes neither the compaction algorithm nor checkpoint authority.

Public Codex protocol at 6996cde697b228fbf5695ce855b2498c5c668795 confirms
Turn.items, commentary/final_answer phases and independent completion notification.
It does not establish the desktop renderer's automatic folding. That presentation
requirement comes from the user's screenshots. Do not repeat upstream research.

## Grouping and lifecycle

- Keep canonical order. Group contiguous process Items only with explicit matching
  turnId, runId, attemptId, participantId and workflowStepId. Never infer lineage
  from names, prose, temporal proximity or a sibling's final answer.
- Commentary, reasoning, plan and evidenced activity belong to the process.
  User messages, final answers, unknown-phase text and TerminalReports remain
  outside. A group identity is stable across streaming revisions and batch
  expansion, but does not cross a retry, participant, step or intervening result.
- Live and unknown lifecycle keep process content visible without a process
  header. Adjacent successful operations may collapse by category within matching
  lineage and a known context segment; successful Host-settled process groups
  initially collapse. Explicit user expansion survives revisions and reconnection.
  Unresolved approval/questions, diagnostics and failed/blocked/cancelled/partial
  facts force visibility even if a
  prior user preference was collapsed.
- Final phase alone is not completion evidence. Require Host terminal status or
  an owning Host Run lifecycle; live facts override a stale terminal snapshot.
  Loaded Items are not a complete-history claim. No counts claim unseen history.
  Unknown phase remains visible. Missing lifecycle/timestamps do not become zero
  duration or a guessed elapsed time; show duration only from Host Run timestamps.
- Depth-1 uses its own run and attempt. The existing Agent disclosure must also
  reveal pending child attention. No depth-2 Timeline/virtualizer is introduced.

## Display and recovery

Use one muted, clickable completion entrance with chevron, labelled
`Worked for {duration}` when Host timing exists, otherwise `Execution details`. Attention uses
`Needs attention`. Category disclosures name the successful read, edit, command,
tool or web-search facts. Live waiting copy uses the shared activity label;
provider-safe reasoning renders without a repeated heading. Expansion reveals the
original Markdown/tool renderers in original order. Final answer, net +/− file card, Review
navigation and response footer stay outside process disclosure. Copy still reads
all privacy-filtered narration in the response, not just mounted/expanded rows.

Process header durations use the shared `formatElapsedDuration` with the app's
locale. Floor to whole seconds, split into hours/minutes/seconds and omit zero
units: `19分钟49秒` / `19m 49s`, `1小时1分钟1秒` / `1h 1m 1s`.
Below one second displays zero seconds; absent/negative/non-finite facts remain
absent. Do not change Host timing semantics or tool-detail precision.

The existing view store owns disclosure. The single root display model indexes
hidden atoms and ancestor reveal paths; source navigation opens process, Agent
and batch ancestors before revealing the original row. Virtual row identity and
scroll owner remain unchanged for real Items. Retain keys include process groups.

## Verification classification

`not_run` is an execution status, not automatically an unmet requirement. A model
must not decide check applicability through prose or an unvalidated optional flag.
Host projection must distinguish evidence-backed expected checks from an
informational non-execution declaration. Missing/unknown classification remains
conservative. Required missing/failed checks and unresolved risks remain attention.
No report history or database is rewritten to fix display.

## Acceptance

Pure and rendered regressions cover live → succeeded, touched state, unknown
phase/lineage, run/attempt/participant/step isolation, required attention, depth-1,
batch atom lookup, pagination/revision replacement, one footer, copy invariance
and files/Review outside fold. Native packaged acceptance must reopen real cases
and exercise both open and closed states; fixtures are not labelled real model QA.

## Implementation and acceptance record

The shared process projection, header, disclosure state, hidden-atom locator,
response-copy ownership and Host Run lifecycle adapters are connected across
normal, teammate-private, channel and depth-1 children. Host verification
expectation is derived from matching sealed evidence, not model prose; an
informational skipped/not_run declaration does not create a false warning.
Unknown or evidence-backed unmet checks remain attention. No database/history
rewrite or persisted process/batch table is introduced.

The projection indexes reports by Turn and memoizes repeated scope state within
one projection invocation. This removes per-group whole-history scans and
same-scope recomputation without cross-revision caching or lineage changes.
The long-history regression failed before the optimization and passes after it.

Final gates: Web 408/408, Daemon 2117/2117, rendered matrix 43/43, Web build
(including TypeScript), lint and diff-check passed. The final signed QA package
reopened existing real-model histories and verified normal collapsed/expanded,
private collapsed and channel/child attention and disclosure states. Fixtures
remain simulation; live streaming, restart and SSE recovery are not newly
accepted by reopening history.

Evidence, package hashes and remaining boundaries are recorded in
`../../output/e6-20260928/process-disclosure-20261001/README.md`.
No unresolved product decisions for this slice. Overall E6/Harness and the
independent existing backlog remain incomplete; no code was staged or committed.
