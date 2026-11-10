# Fixed Office macOS signing-input checkpoint — 2026-10-08

This is an internal packaging-contract checkpoint, not an E6 completion,
release approval, signed product or packaged GUI acceptance.

## Confirmed cause and scope

The fixed Office lane selects `unsigned_dev`, `provider=false` and ad-hoc
identity `-`. That identity alone does not exclude certificate processing:
electron-builder 26.15.3's actual MacPackager resolves `codeSigningInfo` before
selecting the identity. Its default signer is osx-sign 1.3.3, not the separate
desktop dependency osx-sign 2.7.1 used by another signing path.

The Office wrapper passed inherited environment through the Cua package CLI
and scoped Builder environment. Certificate, password and Keychain inputs
could therefore reach certificate import or Keychain selection before the
ad-hoc signer. The minimal fix rejects conflicting inputs, with field names
only in errors; it must not silently erase inputs and claim they were reviewed.
Other signing lanes remain unchanged.

The new admission helper must be an explicit member of the fixed authored
packaging review closure. No build or test generates or approves a production
review row.

## Verification status and local save

Original RED is retained: 64 new rejection cases failed, while the original
22 leaf cases passed. TAP reports 87 tests, 22 passes and 65 failures because
the containing test also fails. Synthetic loaders and counters deliberately
replace Cua, native publication, config and Builder; this is not a real signer
or Keychain experiment. The admission GREEN is 87/87, the explicit source-pin
GREEN is 99/99, the owner eight-file neighborhood is 249/249, and the independent
Root eight-file matrix is 359/359. All have zero failure, cancellation or skip.
The source fix was saved locally as `38af2f29`.

Main `7b266981` was then normally merged, without conflicts or history rewriting,
as local `8bf22b9b`. Frozen installation and Runner/Daemon `build:ci` succeeded;
Runner's full suite is 249/249 and the five-file Daemon provider/runner matrix is
55/55. These are the new dependency graph's results, not borrowed old evidence.
Root's subsequent full Daemon run on the same pre-H09 graph also completed:
**3600/3600**, exit 0, zero failure, cancellation, skip or todo
(`office-signing-main7b-daemon-full-20261008.tap`). It is not the earlier
pre-main833 full receipt and does not certify later H09 additions.

The first full Desktop Node run on that graph failed: **1850 tests / 1812 pass /
2 fail / 33 cancelled / 3 skipped**. Both causes were separately reproduced:

- The real source-only esbuild closure reached the new
  `packages/core/src/storage/sqlite/recovery-discovery-validation.ts` through
  two pinned stores, but the fixed review input list omitted this import-free
  leaf. The fix adds only that explicit input, with membership and stale-byte
  mutation regression checks. No root, resolver fallback or approval was added.
  Root's three-file publication/source-input/projection GREEN is 221/221.
- Four deadline/backoff test cases used fake hosts, fake children or fake fetch
  without a referenced libuv handle. Their production `unref()` timers could
  outlive the test event loop, cancelling those cases and queued cases. Local
  MockTimers now drive the real callbacks after the expected timer admission;
  all original race, Abort, SIGTERM, close and cleanup assertions remain. There
  is no production change, global keepalive, deleted test or new skip. Root's
  independent three-file GREEN is 84/84. Portable Win32 logic tests are not a
  Windows OS or Job Object acceptance result.

These five-file corrections were saved locally as `97500855`. Independent
read-only review found no confirmed issue in that delta. The fresh Desktop Node
full rerun is **1863 tests / 1860 pass / 0 fail / 0 cancelled / 3 skipped**,
exit 0. The three retained platform skips are real Windows abandoned-mutex and
owned-process cases, not missing macOS cases. Main-TS typecheck, five changed
MJS syntax checks, scoped diff-check, 300-file documentation-link check and
4347-file public-safety scan also succeeded. No full Desktop build was run:
that path invokes the real Office driver signing step.

All these local commits remain unpushed; no new PR or cloud CI run was created.
The original failing TAPs remain available in the local continuation evidence
directory. Relevant raw prefixes are `office-signing-env-*`,
`office-recovery-source-pin-root-*`, `office-signing-timers-*`, and
`office-signing-main7b-*`, all dated 20261008. A test GREEN is not native source,
vendor/OS review, release approval or packaged GUI acceptance.

The signing-input/source-pin/test delta has no unresolved implementation
decision. The separate release boundaries below remain open. H09 shadow-only
calibration is an independent remaining internal work item; it does not
certify Keychain isolation or authorize model-gate enforcement.

## Remaining release boundaries

- The CSO launcher rejected snapshot admission: `MISSING_INPUT`,
  `Source exceeds the 64 MiB snapshot admission limit`. No run ID, audit report
  or security approval was produced. Status is **not assessed**. Engineering
  checks below do not replace that audit, and its limit was not bypassed.
- Installed vendor closure, complete native toolchain/SDK and default signer
  inputs still need independent release review. Existing lockfile integrity,
  compiler hashes and SDKSettings digest are pins, not that complete review.
- The default Keychain startup probe enters an unbound controlled producer.
  A dedicated finite-operation native role and closed codesign/Keychain proof
  bridge are required; existing command/codesign roles cannot certify it.
  Invocation records are single-use, but an unchanged certified domain needs
  reusable permanent history to avoid exhausting the Registry's 16-domain
  budget. No raw fallback, history reset or probe removal is acceptable.
- Real OS broker/default-search-list permissions remain unverified. An isolated
  credential test environment is a testing choice, not a product prerequisite.
  User-visible Keychain selection/timeout changes remain unresolved.
- The production Office review row is absent. Office missing-parent success,
  final App/ZIP/DMG, same-package barriers and real macOS GUI cases remain open.
  Full Access and unrestricted same-user processes remain outside isolation.

## GitHub readback, not an action by this workflow

PR #516 changed from its old incomplete 7.29.1 proposal to a complete Undici
7.30.0 manifest/lock upgrade. It was merged by the user account at
2026-10-08 09:36:44 UTC: merge/main `7b2669815f77e41213edeef29f7fda367171b9eb`.
The verified head is `e56513536f49808f042494fc78f37740f95614e7`; its tree matches
the merge tree. There are no head checks, and the cloud CI workflow is disabled;
Dependabot's successful update job is not product CI. Do not close or replace
this merged PR. PR #517 was closed by Dependabot. PR #520's current diff is
Lucide only; its body retains the removed-major migration record.
