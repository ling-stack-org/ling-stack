# P2 cold-start bootstrap independent delta review

Date: 2026-10-23

Reviewer: `/root/p2_bootstrap_delta_review`, independent of the implementation. This is a scoped source/isolated-process review, not release approval or packaged GUI acceptance.

Repository: `/Users/tianxiao/.codex/worktrees/ling-e6-continuation/ling-stack`

Branch: `codex/e6-safe-continuation`

HEAD anchor: `78f0f9abe701a17e949a49194fc5a7652098cb36`. The reviewed delta is uncommitted; the hashes below, not HEAD alone, identify the candidate.

## Verdict

The original P1 finding is closed on the identified inputs. No other confirmed actionable defect remains in this scoped review. The resource/readiness split is suitable to proceed to the owner's separate, concrete QA approval and packaged cold-start verification; this report does not supply either approval or verification.

Reviewed: the new Core FD4 writer/reader; Core FD3 AbortSignal and error-drain changes; Desktop bootstrap/service stages and owned-child cancellation; actual Daemon CLI ordering; Core export mapping; explicit Office review-input inventory additions; and the associated focused tests.

Not re-reviewed: the separately assigned eight-worker source-authentication change, historical full content audit, unrelated E6 WIP, or the entire Desktop Main graph.

Budget semantics checked in source: packaged resources have a fixed 60-second deadline that partial activity cannot renew; only the validated EOF receipt starts the ordinary 20-second service-readiness phase. FD3 authority starts reading at child retention with a bounded total 80-second budget under defaults (60 seconds plus the configured/default service budget), and the shared abort disposes both readers on stop/exit/error. This is not an unbounded heartbeat lease or a replacement of the service deadline with 80 seconds.

## Closed P1: queued pipe error racing cancellation could crash the Host

Original motivating code in both readers removed the final error listener before destroying the stream. An error already queued by `channel.destroy(ioError)` still emitted after an immediate `abort.abort()`. In two independent isolated Node processes, the read Promise rejected as expected but an unhandled `error` subsequently terminated the process with exit 1.

Affected original locations:

- `packages/core/src/daemon-resource-bootstrap.ts`, original finish block at line 42.
- `packages/core/src/execution-engine-host-authority.ts`, original finish block at line 62.

Minimal original replay:

```js
const pending = read({ channel, pid: 42, signal: abort.signal, ...authorityEndpoint });
channel.destroy(new Error("queued_io_error"));
abort.abort();
await pending.catch(() => undefined);
await new Promise(resolve => setImmediate(resolve));
```

The revised readers remove protocol handlers but retain a temporary error drain through `close`. When Node already marks a stream closed before queued error/close delivery, next-loop cleanup prevents leaving that temporary listener behind. This preserves rejection and protocol limits rather than swallowing the failed read or returning authority.

Independent verification executed the new regression for both readers and both orderings, `queued-error-abort` and `pre-destroyed-error`. All four subprocesses exit 0, reject with unavailable, and finish with zero data/end/error/close listeners. The original two subprocesses had each exited 1. Confidence in closure: high, supported by source and executable regression.

## Independent checks actually executed

### Focused five-file combination

```sh
node --test \
  packages/core/test/daemon-resource-bootstrap.test.mjs \
  packages/core/test/execution-engine-host-authority.test.mjs \
  apps/desktop/tests/daemon-lifecycle.test.mjs \
  packages/daemon/test/daemon-resource-bootstrap.test.mjs \
  packages/daemon/test/packaged-qa-harness-bootstrap.test.mjs
```

Result: **86 passed, 0 failed, 0 cancelled, 0 skipped**. Runtime: Node v24.15.0. This reviewer did not rebuild or modify dist.

Coverage includes: private real FD4 transfer; strict schema, phase, PID, size and EOF admission; fixed non-renewable resource timeout; unchanged service-stage timeout; FD3 total startup budget; stopping, child exit and spawn error; missing/corrupt receipts; authority ownership; reader cleanup and queued-error race; actual CLI resource failure and invalid-descriptor rejection; actual CLI resource receipt before service startup and FD3 after service readiness; and existing QA selection restrictions.

The CLI tests run real `cli.ts` with native/resource/service side effects replaced at their module boundaries. They retain production FD3/FD4 writers and readers over actual child-process pipes. They are composition tests, not an actual Daemon/GUI run.

### Production defaultSpawn with a real CLI child

An additional independent stdin-only probe used the production `DesktopDaemonLifecycle` default spawner, not its `spawnDaemon` seam, to execute the actual `packages/daemon/src/cli.ts`. A process-local Node import hook replaced only native/resource/service boundaries. No source, dist, profile or database was changed; health was an in-process fake and no listener/model was started.

Observed result:

```json
{"scenario":"production-defaultSpawn-real-CLI","connected":true,"pidMatched":true,"bootstrapEnvRemoved":true,"fd4ClosedBeforeService":true,"realChildExited":true,"events":["daemon.spawned","daemon.resources_preparing","daemon.resources_ready","daemon.ready"]}
```

The service boundary explicitly checked both bootstrap environment names had already been removed and that FD4 was closed (`EBADF`) before `startDaemon`. Production FD3 authority PID matched the retained real child. Normal stop completed and `process.kill(pid, 0)` returned `ESRCH`. Earlier independent real-child probes also verified wrong-PID rejection and stop-during-bootstrap cancellation with actual child termination.

### Fixed Office source-inventory regression

```sh
node --test apps/desktop/tests/packaged-office-daemon-source-inputs.test.mjs
```

Result: **1,344 passed, 0 failed, 0 cancelled, 0 skipped**, exit 0. This suite uses isolated fixture trees and synthetic native boundaries; some cases run real esbuild. It does not attest production native binaries or perform the historical content review again.

Static inspection also confirmed that the fixed input list explicitly contains Desktop lifecycle, new bootstrap source, FD3 authority source, original source verifier, `packages/core/package.json`, and Daemon CLI. The new export maps only to the corresponding generated JS/types. The input-list additions do not grant approval or regenerate a production approval record.

Integrator-only supplementary evidence, not claimed as a second independent execution: the parent reports a final 12-file combination of 1,497/1,497 passing with no skips, plus Main/Daemon TypeScript and diff checks passing. This reviewer independently executed only the commands and probes itemized above.

## Frozen reviewed fingerprints

SHA-256 of authored inputs and tests, rechecked after the tests:

| Path | SHA-256 |
| --- | --- |
| `packages/core/src/daemon-resource-bootstrap.ts` | `39549fe2e817e2e7fc3f1f311bd28a4443f42f973426c50ebc7a8d7f53428cb0` |
| `packages/core/src/execution-engine-host-authority.ts` | `b0f8ae6fd5e16ad5c7f3ae84b4e5514bcf78c324e1077baa5d7d106bce45cacb` |
| `packages/core/package.json` | `ea102b476c064fdd1e081741cb85443b3eabc919fd04c8e00b5a4702c5cc90e6` |
| `apps/desktop/main/daemon-lifecycle.ts` | `5c40ca0bdfb6afd87bbba2d4b5fa55c6b20244368bb14bed7230bd47d100960b` |
| `packages/daemon/src/cli.ts` | `6bf645e63551e5c048dd5ecde1cee7f04364d84c9d80b55f3dc6bf296da9cea7` |
| `apps/desktop/scripts/packaged-office-native-review-inputs.mjs` | `4028815657e748796bf8f6db5c382b4a61b67716ab5fd4b0c9bd093d2d5c04f5` |
| `packages/core/test/daemon-resource-bootstrap.test.mjs` | `90fdc34b87e050787686949f5df73462566fb5837837acb0a81935851c2c25a4` |
| `packages/core/test/execution-engine-host-authority.test.mjs` | `cc394fda72749c68a7da378b53d27d47a9e7343f8fd8d33132bb1931f3d4f61d` |
| `apps/desktop/tests/daemon-lifecycle.test.mjs` | `67a1a17d38fd88eb67f99560af684478951d71ba3afc51d3ba0c37da0cc4ef9b` |
| `packages/daemon/test/daemon-resource-bootstrap.test.mjs` | `cb236eed93e0da73abb114bc355ea147b5bf34b28242108a857f63bd07314c5d` |
| `packages/daemon/test/packaged-qa-harness-bootstrap.test.mjs` | `b76d7db7255bb484a7b8aeb0cc41dffbb89adc19fc746aa3be30ef8d4338cc3b` |
| `apps/desktop/tests/packaged-office-daemon-source-inputs.test.mjs` | `45f496f1832d4d5cc9d0119a38275cfea62ccd5d60e4f2304eb2fd89ab573c39` |

Consumed generated JS fingerprints (test evidence only, not substitute authored review inputs):

| Path | SHA-256 |
| --- | --- |
| `packages/core/dist/daemon-resource-bootstrap.js` | `6583a26a62898d1fbc9a9237bc2934562a3f49e03696c73b7432a6cce1b93e3b` |
| `packages/core/dist/execution-engine-host-authority.js` | `c4999f0695312a5778eb23b14096916bc793385e7dd70296a604b53f4d7c127a` |
| `apps/desktop/dist/main/daemon-lifecycle.js` | `a32d46da283a70ed2af88a4d806b3d7bf82f1ed2932d89d6b8610e3e33b15698` |

## Remaining limits and next gate

- The previous packaged App still contains the earlier bytes. This report does not repair or validate that App.
- The measured real resource-copy/authentication duration and the chosen 60-second hard phase still need a new packaged cold start on the actual Electron runtime. Node fixture timing is not that proof.
- No actual macOS GUI, model request, approval recovery, SSE reconnect, Office task or multi-Agent task was executed by this reviewer.
- No full audit of other E6 changes, third-party dependencies, OS permissions, signing/notarization or Windows behavior is claimed.
- The previously interrupted QA cache/writer remains outside this review. No lock, staged generation or history was removed or adopted.
- No production approval file, packet approval, release asset, Git commit, PR or merge was changed by this reviewer. The sole reviewer-created repository file is this report.

Next: bind this exact delta plus the separately reviewed verifier delta into the concrete pending QA packet, obtain the owner's specific QA-only approval, then build and verify the isolated App. Do not interpret this scoped verdict as release permission or completion of P3/E6.
