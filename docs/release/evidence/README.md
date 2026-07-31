# Desktop release evidence contracts

These schemas describe operator-supplied evidence that the release harness consumes. A
JSON document matching a schema is not proof by itself.

The bundled Windows target separates artifact placement from promotion trust. Its target
contract uses `signingTier = unsigned_dev | test_signed_internal | production_signed`,
`distributionChannel = development | internal | production`, and
`promotionStatus = BLOCKED | MANUAL_REVIEW_REQUIRED | INTERNAL_TEST_PASS | RELEASE_PASS`.
Only `RELEASE_PASS` may set `releaseReady: true`; `INTERNAL_TEST_PASS` is a genuine installed
test-signed bundled acceptance verdict but always keeps `releaseReady: false`.

The live schema set implements this contract atomically: candidate manifest v4, release
policy v3, review/build attestation v2, release verification v2, internal verification v1,
handoff index/cell/report schemas and the signed-acceptance matrix. The strict filename set,
JS validators, PowerShell runner, producer, finalizer, detached verifiers, negative fixtures
and cross-platform CI contract lane migrate together; older tuples are rejected rather than
upgraded in place.

## Slice -1 signing-feasibility evidence

`apps/desktop/tests/cua-driver-signing-feasibility.test.mjs` and the modules under
`apps/desktop/scripts/cua-driver-signing/` are a certificate-free Electron Builder
26.15.3 hook-order spike. They exercise `afterPack`, the opt-in macOS/Windows platform
sign callbacks, `afterSign`, and `artifactBuildCompleted` on both platforms. The disposable
fixture signer uses an explicit `testOnly` envelope; it is not Authenticode, Developer ID,
or a production certificate, and it cannot be selected for `production_signed`. Fixture
ZIP/DMG/NSIS containers are reopened and every member is rehashed before the normal provider
tuple verifier runs. The trace records pre-sign, post-sign, seal, catalog, outer-role and
final-artifact digests. Negative cases fail closed for double signing, post-seal mutation,
mixed tier/channel, reused internal bytes, unexpected provider executables and missing
extractors. This proves hook sequencing and byte invariants only; it does not prove real
certificate trust, notarization, SmartScreen, NSIS Authenticode, or production release
readiness. Those remain external test-signed/production gates in Slice 6A and Slice 8.
`apps/desktop/tests/run-cua-driver-signing-builder-fixture.mjs` additionally runs real
`electron-builder@26.15.3` file targets: macOS invokes `--mac dmg zip` and requires exactly
`outer-dmg` plus `outer-zip`; Windows invokes `--win nsis` and requires exactly
`outer-nsis`. Generated `.blockmap` sidecars never count as verified artifacts. Every
accepted final event must reproduce the `afterPack` provider, seal, catalog, capability and
runtime-policy digests. The macOS fixture keeps the explicit ad-hoc `identity: "-"` input
while exercising the signed-tier hardened-runtime package shape; its disposable bundle
envelope is not real codesign evidence. Ubuntu runs the portable Node fixture lane and
reports the platform-builder lane as skipped rather than claiming cross-platform evidence.

- `macos-signed-acceptance.schema.json` is the v2 output contract of
  `apps/desktop/tests/finalize-macos-signed-acceptance.mjs`. The finalizer reads every
  referenced file, recomputes SHA-256, live-reverifies the candidate, validates the full
  arm64 denied/prompt/granted/revoked matrix, and emits a content-bound review
  bundle. It deliberately remains `MANUAL_REVIEW_REQUIRED`; final PASS requires a separate
  verifier that recomputes the evidence digest and checks a detached signature against a
  release-policy-pinned reviewer key. The schema couples those states: local manual-review
  output must be `not_verified` without an attestation, while PASS requires an attestation
  plus `trusted_external_signature`, verifier identity, and policy-pinned key ID.
- `macos-tcc-case.schema.json` describes one architecture-specific TCC report. Relative
  paths resolve from the report that owns them.
- `macos-tcc-revocation.schema.json` records the machine-observed two-phase revoked case
  produced by `run-macos-tcc-revocation.mjs`. Operator recording covers the system capture
  indicator, which macOS does not expose as a query API.
- `macos-signed-performance.schema.json` describes the packaged signed performance report
  produced by `run-macos-signed-performance.mjs`. A completed measurement may consistently
  report either PASS when every release budget passes or FAIL when a budget is exceeded;
  the finalizer still accepts only PASS evidence for release promotion.
- `macos-acceptance-failure.schema.json` describes the explicit diagnostic envelope written
  when a macOS TCC, revocation, signed-acceptance, or signed-performance producer fails before
  it can emit a success report. Failure envelopes carry `failure: true` and `verdict.pass: false`;
  they are retained for diagnosis and can never close a release gate.
- `windows-release-policy.schema.json` records the approved policy version, approver,
  approval time, exact Ling/provider signer subjects, signer certificate SHA-256 values,
  the explicit supported Windows build allowlist, reviewer/build-attestor identities, and
  their canonical SPKI SHA-256 fingerprints. Version 3 adds explicit
  `requiredAcceptanceCells`; allowlist membership for one host is not matrix
  coverage. Signer identities and keys are read from this
  content-addressed policy, not accepted as command-line assertions. Reviewer and
  candidate-build roles must be disjoint by identity, key ID, and SPKI fingerprint.
  Version 3 additionally pins required `signingTier` and
  `distributionChannel`, distinguishes internal test signer identities from the production
  legal Publisher, and rejects every cross-tier/channel combination. TryCua release source
  provenance is not an Authenticode signer identity.
- `windows-candidate-manifest.schema.json` v4 records source/build provenance, private packaged-provider
  path, `signingTier`, `distributionChannel`, production eligibility, applicable
  `testAuthorityKind`, clean `preSignPayloadSha256`, tier-specific final app/installer/
  uninstaller/provider/catalog hashes, provider seal/catalog hashes, audit-only UIAccess
  output, and observed actual Authenticode subjects/certificate SHA-256/timestamp policy.
  `tierGovernedArtifacts` is exactly installer, installed Ling main PE, trusted uninstaller,
  private provider and signed-tier catalog; the private payload allows no extra member.
  Electron/Chromium vendor native files use a separate normalized
  `vendorNativeInventory` path/hash/observed-signer inventory and the existing Electron
  Builder policy rather than silently enabling
  `signDlls`. Effective tier is independently derived from governed artifacts and is the
  lowest member tier; the manifest cannot promote itself. Unsigned/development and
  test/internal branches require `productionEligible: false`. Only production/production
  may set it true, and that value allows review rather than proving `RELEASE_PASS` or
  `releaseReady: true`.
  The producer copies and rehashes every inventory member into the handoff candidate app tree.
- `windows-full-manual-evidence.schema.json` v3 is the shared content contract for six Full
  evidence kinds: supported Windows build, single/dual-display DPI visuals, Narrator, NVDA,
  SmartScreen, and install/update/uninstall. Each document binds the candidate-manifest
  hash and exact host/session/build, derives PASS/FAIL from its case content, requires a
  reviewer-routing claim after the operator completes the case, and references at least one
  separately hashed retained attachment. That JSON reviewer field is explicitly unverified
  and cannot promote a release. Attachments must remain relative to their evidence document.
  One evidence document or attachment reference cannot be reused to close another evidence
  kind.
- Per-cell handoff/report schemas plus a Windows signed-acceptance
  matrix schema. Each producer uses exclusive-create, binds report-relative attachments,
  binds a common `handoffIndexSha256` and unique `cellManifestSha256`, and is aggregated
  by `finalize-windows-signed-acceptance.mjs`, which requires every policy cell exactly
  once and cannot self-promote. A profile-aware independent verifier may emit
  `INTERNAL_TEST_PASS` for the exact test/internal tuple or continue to production review
  for the exact production tuple.
- `windows-review-attestation.schema.json` v2 is the detached reviewer signature over the
  canonical finalized-matrix evidence digest. It signs an exact
  `INTERNAL_TEST_PASS` or `RELEASE_PASS` verdict plus tier/channel; generic `PASS` is not a
  promotion verdict.
- `windows-candidate-build-attestation.schema.json` v2 is the detached build-attestor signature
  over the candidate manifest, commit, policy hash, and daemon payload tree fingerprint.
  It also carries and signs tier/channel explicitly.
- `windows-release-verification.schema.json` v2 remains the production-only contract allowed
  to carry `releaseReady: true`; it also proves
  `production_signed + production`, every production trust gate, both detached signatures
  and distinct selected public keys before emitting `RELEASE_PASS`.
- `windows-internal-verification.schema.json` v1 has
  `kind: "ling.windows.internal-verification"`. Only
  `verify-windows-internal-attestations.mjs` with verifier name
  `ling.windows.internal-attestation-verifier` may emit it, fixed to
  `test_signed_internal + internal`, `productionEligible: false`,
  `promotionStatus: "INTERNAL_TEST_PASS"`, `releaseReady: false` and blocker
  `production_signing_required`. The production verifier/schema rejects that kind and is
  not relaxed to accept a test certificate.

`produce-windows-acceptance-handoff.mjs` is the live producer. Its candidate-only phase
derives v4 from a clean Git commit, approved policy, signed artifact bytes, pre-sign bytes,
provider seal/catalog, audit-only UIAccess output and observed signer inventory. Its handoff
phase recomputes that candidate, rejects drift, clones the exact clean repository, copies
policy/artifacts/manual evidence plus attachments, and atomically publishes a new root with
one immutable manifest per policy cell. Publication atomically claims a previously absent
root without replacement and moves `handoff-index.json` last as the ready boundary. Full
mode accepts only one of those manifests and
checks its pinned minimum Node/PowerShell/Git versions before candidate execution.

macOS evidence paths are report-relative. Retain each report, its logs/evidence, and the
candidate's relative artifact tree together. The Windows CLI reads and validates the JSON
content and every attachment hash; a boolean switch, empty file, self-declared signer
subject, or archive checksum that proves only download integrity cannot close Full
acceptance.

Bundled Windows lifecycle evidence also binds the active child PID/nonce match, host and
provider integrity levels, Job Object assignment/`KILL_ON_JOB_CLOSE`, old/new lease
generations, lock/revoke/unlock/reprobe ordering and zero main-child/grandchild residue.
One-shot diagnostics may support preflight evidence but can never substitute for the
active-child readiness record.

The packaged provider smoke separately proves one real daemon-to-child tool exchange. After
the canonical bundled activation succeeds, Desktop submits the test-owned PID/HWND to the
bridge-token-protected provider-target verification route. The daemon calls `list_windows`
through the current lease-generation client, fences the result against the current provider
and lease authority, and returns the exact target plus instance/epoch/generation and
lock/seal/catalog digests. Desktop binds those fields to its ready child PID, nonce digest and
private executable path in one structured proof. The runner compares that proof with the
activation response, observes the old child PID gone, and requires a new Desktop instance and
child PID/nonce after restart. A new Desktop process may start numeric generation at `1`; the
authority key is the complete Desktop instance/epoch/generation tuple.

Internal test trust is provisioned outside Ling only into disposable CI machines or
dedicated isolated QA machines. `ephemeral-ci` trust is removed after every job or VM
revert; `managed-internal` trust may persist only in a dedicated isolated QA image/VM under
external PKI lifecycle and cannot enter a general image or production chain. Ling Setup
must not carry/import a test root or PFX. Internal/production verification rejects
mixed/double signatures, an unsigned governed member, a tier/channel mismatch or any
unexpected member in the exact distribution/platform/two-file payload tree; production also rejects every test
root or reuse of test-signed final bytes. Development requires all expected governed PEs
to derive as `unsigned_dev`, no catalog and an active compile-time dev gate.
Production signing starts again from the approved clean pre-sign payload. Authenticode
`Status=Valid` proves only signature validity in the current trust context; SmartScreen
evidence is candidate/time/VM/MOTW/network/policy-bound, and any WDAC claim binds exact
policy id/version/hash/enforcement mode.

Every macOS producer and the finalizer bind their required harness scripts to the current
commit twice: the report retains each working file's raw SHA-256 and its Git blob object ID,
while capture recomputes `git hash-object --path` from the exact bytes and requires it to
equal `<commit>:<path>`. A clean `git status` is only an additional guard; index flags such
as `assume-unchanged` cannot hide modified harness bytes from this binding. TCC, revocation,
and signed-performance provenance includes the transitive signed-candidate verifier they
execute, and the finalizer requires that dependency in each corresponding report.

The macOS granted-case restart evidence is produced by a production daemon registry/SSE
fixture seeded with one active projection. It proves same-daemon transport replay and Stop
acknowledgement only; it does not replace a real provider run or the clean-host TCC,
capture-indicator, accessibility, signing, notarization, or distribution gates. Producer
failures use `macos-acceptance-failure.schema.json` and are diagnostic only.

## Locked Computer Control feasibility evidence

`locked-control-darwin-26.5.2-arm64-unsupported.json` is the content-free result of the
attended disposable-target probe for the repository-fixed embedded Cua Driver 0.8.3 Ling
build 1. It binds the exact helper/provider hashes and records that same-session continuity,
exact-window capture and secure-surface exclusion passed while both process/window-scoped AX
and background pixel input failed to produce a target-app acknowledgement after lock. It is
non-promotional evidence: the macOS platform cell remains Off with
`locked_control_input_unavailable`. It contains no screenshot, window content, account name,
keystroke, password, biometric result or raw session identifier. A future upstream input
backend change requires a new adapter version and a fresh attended probe; this negative
artifact must not be edited into a positive result.

Windows report consumers must use the asynchronous `validateWindowsAcceptanceReport()`
entrypoint, which rehashes every referenced file and verifies the release harness scripts
against the candidate commit's Git blobs using a caller-fixed trusted Git executable. The
Full validator additionally requires caller-fixed `expectedCandidateCommit`,
`expectedRepositoryRoot`, and `expectedReleasePolicySha256` options. It rejects a report
unless those external anchors match the report binding, harness commit/root, and rehashed
release-policy reference; Preflight remains usable without them. The Full runner verifies
installer and uninstaller Authenticode before either executable runs, and the installed app
must match the candidate manifest. The separately exported
`validateWindowsAcceptanceReportShape()` checks only canonical JSON shape and derived
status consistency; its name is intentionally explicit so it cannot be mistaken for final
artifact/evidence verification. Even when every Full gate passes, the report builder writes
`releaseReady: false` with both `external_reviewer_attestation_unverified` and
`candidate_build_provenance_unverified`. Under the bundled target, only the profile-aware
independent verification boundary with caller-fixed anchors and policy-pinned public keys
may emit an acceptance verdict: internal verification is capped at `INTERNAL_TEST_PASS`,
while the production successor to
`apps/desktop/tests/verify-windows-release-attestations.mjs` may emit `RELEASE_PASS` /
`releaseReady: true` only for the production tuple.

Source-level harness binding does not cover ignored `packages/daemon/dist` by itself. Candidate
manifest v3 therefore records the clean source commit, chosen build strategy, and daemon tree
fingerprint; a policy-pinned build attestor must sign that exact tuple after deterministically
rebuilding it, or after verifying the daemon embedded in the signed candidate package.

The exact expected `*.schema.json` filename set in this directory is compiled as Draft
2020-12 with strict Ajv validation by
`corepack pnpm --filter @ling-stack/desktop verify:release-schemas`; missing and unexpected
schema files both fail. The same command validates positive and negative macOS review/verdict
and signed-performance PASS/FAIL fixtures, so schema-only CI is not compile-only. The Desktop
artifact workflow includes this directory in its path filters.
