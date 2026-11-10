# Interrupted normal Turn: failure publication is not tool settlement

This closes the real R03 packaged restart seam. It does not change retry policy,
process-stop guarantees, provider sessions, SQLite history or completion authority.

## Two independent barriers

- `settled` retains its existing meaning: terminal Turn, no active Run, every
  linked Run terminal, no pending approval, and every accepted tool_start has a
  matching accepted tool_end. Successful publication still requires this barrier.
- An explicit `failurePublicationAllowed` permits only a non-success failure
  explanation when the Turn and linked Runs are terminal, no approval is pending,
  lifecycle identity is valid, and each unfinished tool is fenced by a durable
  matching run_error/run_cancelled after its tool_start. A terminal row alone is
  insufficient. This does not set settled=true.
- The complete unfinished-tool list is part of the captured basis, fingerprint
  and atomic publication CAS. A late tool_end after the Run fence is audit-only;
  it cannot remove an unknown-effect warning or authorize success.

## Mandatory unknown-effect evidence

Each unfinished tool contributes a stable `execution-unconfirmed:<run>:<call>`
risk. The Host records that no tool_end exists, stop/effects are unconfirmed and
the tool was not automatically reexecuted. The report must retain the exact
critical/unverified Host risk and its Run/operation references. Model synthesis
cannot omit, mitigate or reword it into a confirmed-stop claim; validation uses
deterministic fallback on violation. Missing/truncated required risk fails closed.

Report, result Item, supersession and durable invalidation stay one transaction.
Fresh basis and full collector are reread inside that transaction. Existing
successful/open-tool and pending-approval refusal tests stay unchanged. No second
publication authority, fabricated tool_end, exitCode or process-stop receipt.

Verification checks use `unknown` when their tool has no accepted end receipt,
even when the owning Run/action is failed or cancelled. The check summary uses
the same localized Host warning. This rule applies to Run, Turn and workflow
collectors; only an accepted tool outcome can report a passed/failed check.

## Verification

Cover failed/cancelled unfinished tools, missing terminal event, malformed tool
identity, pending approval, live successor, stale evidence, risk omission/mutation,
late end, retry and duplicate/reopen recovery. Preserve the original failed R03
Run; a new package reads it and publishes its failure explanation without another
model admission, approval or command execution. Native GUI proof remains required.
