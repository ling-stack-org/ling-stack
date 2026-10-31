# P2 actual packaged cold-start failure — 2026-10-23

Scope: isolated QA only, no publication. App identity was verified before launch
(see `p2-packaged-identity-readback-20261023.md`). This is not completed GUI acceptance.

## Actual failure

- App PID20241 used the exact new bundle and the existing private QA profile.
- Daemon PID20273 spawned at `08:24:44.189Z`; Desktop timed out at `08:25:04.228Z`.
- Built-in Computer Use captured the actual recovery screen in
  `p2-cold-start-timeout-20261023.png`, then clicked Quit.
- Subsequent process/port readback confirmed both PIDs absent and 17928 without a listener.
- No conversation was opened and no model request was made.

Call chain: Desktop `daemon-lifecycle.ts` sets both a 20s readiness deadline and
a 20s FD3 authority-reader deadline. Daemon CLI first awaits
`preparePackagedGstackStartup()` (complete inventory/checksums, browser validation,
generation retention), and only then starts the server and writes FD3 authority.
Resource bootstrap is incorrectly charged to service readiness.

## Isolated real-resource probes (not GUI acceptance)

All probes finished exit0, using the actual App's fixed resources in separate temporary caches.

| Probe | Actual duration | Conclusion |
| --- | --- | --- |
| Production retention, original sequential verifier | 34227.809ms | Exceeds ordinary 20s startup budget |
| Synchronous copy only (GStack + browser) | 3894.953ms | Copy alone does not explain full latency |
| Production retention with temporary cpSync diagnostic | 32303.881ms | Insufficient improvement; not adopted |
| Bounded 8-worker verifier with original async copy | 24273.825ms | Helps but still exceeds 20s; not a complete fix |

The last probe overlapped a small test run. Do not present it as an exclusive-load
performance benchmark, nor as proof that full CLI bootstrap fits any deadline.

## Preserved interrupted cache

The exact QA profile's `ling-home/sources/bundled-gstack/` has a writer receipt
for dead PID20273 and `.staging-58fe8641-1a3d-489f-8623-2d9b4ed226d7`.
The partial generation contains 9620 files / 568755514 bytes. Existing production
code correctly refuses silent stale-lock takeover. Nothing has been deleted,
marked successful, or substituted for the fixed P1 resources. Before retrying a
new approved package, preserve this exact failed QA cache by recoverable isolation,
only after rechecking process ownership. Never reset the profile or its history.

## Repair context, not yet accepted

The 8-worker verifier keeps all path/inventory/identity/checksum guards and drains
in-flight descriptors on error. Its initial new test RED was genuine serial
preflight. A subsequent test expectation used `/var` while production canonicalizes
to `/private/var`; fix that expectation with realpath, not the production guard.

Next repair: separate bounded authenticated resource bootstrap from ordinary
service readiness, retain the 20s service budget, and cover FD3 authority lifetime,
child exit/spawn failure/cancellation/invalid bootstrap. No unbounded heartbeat or
trusted stdout/log claims. Newly changed reviewed inputs require independent delta
review and a new concrete user approval before repackaging. Existing approvals,
full-suite results, P1 resources, pins and failed artifacts remain intact.

## Implemented candidate and current evidence

Implemented: an absolute 60s resource-bootstrap phase over private FD4, followed
by the unchanged ordinary 20s service-readiness budget. FD4 accepts only one
bounded schema/phase/PID-bound record at EOF. The CLI deletes descriptor environment
variables before bootstrap/runner initialization; only after resource authentication
and retention does it close FD4 and call startDaemon. FD3 retains independent
credential/endpoint/PID checks, now includes the resource phase in its bounded
lifetime, and is revoked with FD4 on stop/exit/error. Ordinary launches do not
request FD4 or change their readiness budget.

Independent review reproduced a cancellation race in both readers:
`channel.destroy(ioError)` followed by same-tick abort rejected the Promise but
left the queued error unhandled, crashing the Host. Persistent isolated-process
regression was RED with `Unhandled 'error' event`, then GREEN for both readers,
including already-destroyed error pipes. Readers retain a temporary error drain
through close and then remove all listeners. These are real Node process/pipe
tests, not packaged GUI success.

Current combined regression: 1497 tests, 1497 pass, 0 fail/cancel/skip, exit0;
`p2-cold-bootstrap-final-regression-20261023.tap`. Includes resource identity/path
guards, worker admission/drain, both pipe readers, Desktop lifecycle, actual CLI
composition over real inherited pipes, existing QA selection, and real esbuild
source-custody/Office fixed-closure tests with synthetic native/signature boundaries.
Core, Daemon and Desktop Main TypeScript compilation exited0; diff-check exited0.
Previously completed full Core/Daemon/Runner suites are not rerun or represented
as revalidated for unrelated modules by this targeted evidence.

The complete production resource preparation path was additionally executed
once against actual fixed App resources and a fresh isolated cache (not the QA
profile), with native/service bootstrap not invoked. Actual exit0: 27399.204ms,
initial authentication 2167.635ms, initializerPrepared=true, externalProviderCalls=0.
See `p2-resource-bootstrap-real-probe-20261023.json`. This demonstrates the complete
resource workload, not that a new packaged GUI has started.

The new protocol and Main lifecycle are explicitly added to the fixed Office
review inventory. Both independent delta reviews are complete with zero unresolved
findings on their frozen inputs. Reports: `p2-cold-preflight-independent-review-20261023.md`
and `p2-bootstrap-independent-review-20261023.md`. The new concrete pending snapshot
must bind these reports and the current source before the owner approves QA-only
repackaging; prior Builder-copy approval remains exact and does not cover new
reviewed bytes. P3 and H09 are still open. No new package or GUI success is claimed.
