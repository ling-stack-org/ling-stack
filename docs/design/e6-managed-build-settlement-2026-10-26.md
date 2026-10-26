# E6 managed build settlement — 2026-10-26

Scope: the resource-build supervisor, not the model execution/Run lifecycle,
whole-host containment, GUI acceptance or release. Implementation, focused
regression verification and final narrow independent review are complete.

## Confirmed cause and contract

`runManagedNode` previously awaited direct child `close`, sent TERM/KILL for a
leaked process group and unconditionally called `lease.release()` in `finally`.
No final observation followed KILL. `release()` authenticates the owner token,
but cannot independently prove process settlement. Its scratch removal was
therefore not justified on an unknown/still-live failure path.

The supervisor now requires both direct child `close` and an actual POSIX
process-group absence observation (`ESRCH`) before authorizing cleanup. Sending
a signal, direct exit, permission errors and a timeout are not absence evidence.
After termination it observes within a fixed five-second window; present or
unknown at expiry retains the owned scratch and exclusive lease. A fresh writer
must still fail busy; no stale lock or scratch is automatically removed.

The real macOS 27.0.1 test returned transient `EPERM` after KILL. This was first
preserved as a failed observation/test, not counted as absent. Bounded repeated
observation can obtain later `ESRCH`; persistent `EPERM` still retains state.
No additional termination is sent merely to retry an observation.

This contract is explicitly **POSIX process-group-only**. Detached escapes are
not contained by it. An escape holding inherited pipes prevents close: the API
returns a bounded failure with retained state rather than hanging or cleaning.
An escape that closes all inherited pipes is not disproved by this mechanism.
The successor's fixed controlled build pipeline still needs its own reviewed
consumer inventory; this fix is not whole-tree/whole-host proof.

Windows tree settlement is unverified and does not authorize cleanup after a
spawn. No Windows acceptance is claimed. Full Access/unrestricted same-user
processes remain outside the sandbox isolation guarantee.

## Adjacent failure handling required for this contract

- Validate `args` as an array of strings before acquiring the lease. An object
  selects Node's `spawn(command, options)` overload and discards the controlled
  detached/stdio options. The initial regression fixture exposed that real
  overload; only its exact verified test PID was stopped, not an App/Host.
- Bound the wait for close after cancellation/failure. Unverified pipe holders
  are unreferenced and retained; late data cannot restart a finished supervisor
  or call the external sink again.
- Track default stdout/stderr write callbacks and asynchronous stream errors,
  including real `EPIPE`. Keep their error listener through the callback's
  subsequent event-loop turn. Custom Promise rejections are also supervised.
  Output draining has a fixed bound; unknown output settlement is a failure,
  not an excuse to hang or imply process settlement.
- A CLI owner with a paused-but-open downstream pipe can remain referenced even
  after the library API returns. Only the CLI finalizer explicitly exits
  nonzero on unverified output settlement after the local receipt is written
  and process cleanup is decided. It does not destroy global stdout in library
  callers or claim all output was delivered. A real separate controller tests
  this distinct open-pipe case; EPIPE alone cannot prove it.
- Preserve the initial error together with receipt/release failures. A failed
  no-child spawn can release its unused lease, but the original error is still
  thrown. No invalid negative/undefined PID is signalled.

`last-run.json` is written while the exclusive lease is held. On safe cleanup it
records `release_authorized`, not a post-release claim; only the returned result
can say `released` after `release()` really succeeds. Unknown/present/unfinished
consumers record `retained` and the exact owned scratch path.

## Fresh evidence and limits

Evidence directory:
`output/e6-20260928/p5-merged-input-review-20261026/`.

Final command (serial):

```
node --test --test-concurrency=1 scripts/gstack/run-managed.test.mjs scripts/gstack/resource-workspace.test.mjs scripts/gstack/resource-workspace-storage-modes.regression-1.test.mjs scripts/gstack/build-shell-parser.test.mjs scripts/gstack/collect-pinned-source.test.mjs
```

Final actual exit 0, **33 passed / 0 failed / 0 cancelled / 0 skipped**,
26,801.332083 ms (exec session 52267; fully collected, do not wait or rerun).
`managed-settlement-accepted-tool-result.json` preserves the final tool result.
The prior 30-test result is retained with its own earlier hashes; it is not
silently rebound to the final source.

- Source SHA256: `27353aa6dd70885643ce77030b6ee13ed997bbc6972b9fbe9270cacc750c7603`.
- Supervisor test SHA256: `bf09c42478c9348be1e80ef4300c0701d09a1f28fc98ef70fffd04e139e5a5e1`.
- Initial forced observation RED: 0/2; old observation sequence was exactly
  `[0,"SIGTERM","SIGKILL"]`, with no post-KILL probe.
- Intermediate malformed-argument fixture: 27/28, actual exit 1 (session
  54237). It hung because `{}` is a valid overload, not a pre-spawn exception.
  Its verified fixture-only PID 64522 was stopped to collect that failure.
- Intermediate real post-KILL observation: 29/30, actual exit 1 (51127), followed
  by a diagnostic-only real probe also returning `unknown/EPERM` (exit 1).
  Assertions were not widened; the implementation now makes bounded fresh
  absence observations. Persistent unknown/present cases remain required tests.
- Real subprocess cases cover TERM-resistant same-group descendants, detached
  pipe-holder cancellation, closed upstream stdout causing default EPIPE, and
  paused-open stdout requiring the actual CLI finalizer to exit nonzero.
  Deterministic syscall fixtures separately force persistent present/EPERM.
- Sync and async custom sink failures plus post-spawn caller argv mutation are
  covered. The command checksum binds the copied admitted argv, not a later
  mutation of the caller's original array.
- `node --check` and `git diff --check` passed. This is the complete affected
  module/adjacent five-file set, not a full monorepo or GUI suite. Existing
  unrelated accepted suites are reused, not rerun or relabelled.

The resource budget, free-space floor, native reservation, durable generations,
selection, old App/Host identities and formal Office/sandbox approval records
were not changed by this repair. No real resource cache was cleaned and no
successor resource/package was built. The owned-scratch successor wrapper,
temporary selection restoration, exact output reservation, final-container
GStack verification, missing GUI combinations and H09 remain open.

## Independent review and bounded verdict

`managed-settlement-independent-review.md`, 78 lines / 10,767 bytes, SHA256
`9e3fbcc0f1859ebbbe7e29b138ad36e9b2723bc0a033b9cd47ef8a5c6cb3bdf1`,
reviews all 257 source lines and 362 test lines to EOF. No remaining confirmed
finding within this scope. The reviewer independently read the final accepted
tool result and matched both source hashes; they did not rerun the tests. Its
review-cut text preserves that the final suite was pending when it was written;
the final 33/33 result above resolves that checkpoint. Do not rerun it for that
old time-sliced statement.

DEBUG REPORT: original symptom was post-KILL unconditional scratch release;
root cause was missing observed settlement. The final release gate, supervised
output and argv policy are implemented and covered by failing-before / passing-
after regressions. Bounded verdict: **DONE_WITH_CONCERNS**, where concerns are
the explicit process-group-only/Windows/custom-callback limits above and the
separately unfinished successor/E6 work. No release/GUI/full-plan verdict is
implied. The existing user-owned E6 freeze boundary was preserved; this run did
not acquire an owner token and must not remove that boundary. Project-local
learning is recorded below; no global memory update was made.

## Project-local learning

Neither signal intent nor direct-child close proves scratch consumers are gone.
The Node spawn overload also belongs in an execution supervisor's input guard:
an argv object changes process policy, not merely argument formatting. Default
stdout error events are asynchronous even when a custom sink contract is
synchronous. Keep these findings here; do not write global memory.
