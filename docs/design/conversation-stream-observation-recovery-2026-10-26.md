# Accepted conversation stream observation recovery

## Real failure and scope

R02 uniquely submitted `E6-R02-DUAL-20261026-0232` in packaged macOS QA.
Severing the established execution POST and control-plane GET did not replay the
command. The original Run/Turn succeeded with all 24 ticks. After replay, however,
the composer retained `network error` and the recent-thread list retained
`running`. Original evidence remains in
`output/e6-20260928/r02-dual-stream-transport-20261026/live-findings.md`.

These are client observation defects, not proof of failed execution or lost
SQLite history. This change adds no execution, approval, permission, database or
retry capability.

## Recovery contract

1. A stream failure before durable acceptance retains the existing submission
   lookup/rejection rules. Unknown acceptance is not silently made successful.
2. For accepted input, retain an in-memory recovery pointer to the exact error
   operation and accepted source item. Do not replay the POST or mark the
   assistant failed merely because observation disconnected.
3. Begin a fresh read-only detail request. If it fails, keep the scoped transport
   error. The existing control-plane reconnect or later explicit selection can
   perform the same reconciliation.
4. Only a read started after the error, still admitted by the read epoch and
   selection/workspace guards, may clear it. The raw returned detail must match
   workspace, thread, and the exact accepted user source. A previous cached
   snapshot or merged client union is not recovery evidence.
5. Clearing uses the original error operation token. A newer send/error cannot
   be cleared by an older request. Failure on another thread/workspace cannot
   disappear because the visible thread loads successfully.
6. This heals transport observation only. Host running, waiting approval,
   failed, cancelled, blocked and succeeded facts are not rewritten. Genuine
   errors remain in the canonical transcript.

## Recent-list invalidation

Every coalesced `runs/work_units/approvals/artifacts` batch refreshes the ordinary
recent-thread list once, independent of which conversation/channel/private-chat
surface is selected. Existing selected-detail and channel refreshes remain.

The control-plane caller requests `throwOnError` for this read. Its existing
applied-cursor barrier must not advance when this list refresh fails. Other
callers retain the existing owned sidebar-feedback behavior. There is no new
timer or polling loop, and no terminal success inferred from transport health.

## Verification and limits

New actual-controller regressions use synthetic API/SSE ports with deterministic
React hooks. They cover original-input non-replay, fresh-source recovery,
offline preservation, Host failure, thread/workspace isolation, late reads,
newer errors, global list invalidation, and cursor retry on failed list reads.
They are not packaged GUI or real execution evidence.

The original packaged R02 failure remains failed. A reviewed successor package
and a fresh uniquely submitted transport-fault case are required for GUI closure.
Do not re-send the original R02 nonce or claim Daemon restart/tree containment
from its command exit status. Full E6 acceptance remains open.
