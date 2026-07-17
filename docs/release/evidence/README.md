# Desktop release evidence contracts

These schemas describe operator-supplied evidence that the release harness consumes. A
JSON document matching a schema is not proof by itself.

- `macos-signed-acceptance.schema.json` is the v2 output contract of
  `apps/desktop/tests/finalize-macos-signed-acceptance.mjs`. The finalizer reads every
  referenced file, recomputes SHA-256, live-reverifies the candidate, validates the full
  arm64/x86_64 x denied/prompt/granted/revoked matrix, and emits a content-bound review
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
  their canonical SPKI SHA-256 fingerprints. Bundled Slice 8 versions this schema to add
  explicit `requiredAcceptanceCells`; allowlist membership for one host is not matrix
  coverage. Signer identities and keys are read from this
  content-addressed policy, not accepted as command-line assertions. Reviewer and
  candidate-build roles must be disjoint by identity, key ID, and SPKI fingerprint.
- `windows-candidate-manifest.schema.json` currently freezes the external/reference
  baseline: commit, approved policy hash, reviewed upstream archive tuple, both reference
  PE hashes, Ling app/installer hashes, and daemon payload strategy/tree fingerprint.
  Bundled Slice 8 must supersede those runtime fields with the source/build lock, packaged
  main-PE seal, signed provider catalog/path and an audit-only UIAccess hash. Until that
  schema migration lands, this contract must not be read as the bundled target.
- `windows-full-manual-evidence.schema.json` is the current external-baseline shared
  content contract for six Full evidence kinds: supported Windows build,
  dual-display/DPI visuals, Narrator, NVDA,
  SmartScreen, and install/update/uninstall. Each document binds the candidate-manifest
  hash and exact host/session/build, derives PASS/FAIL from its case content, requires a
  reviewer-routing claim after the operator completes the case, and references at least one
  separately hashed retained attachment. That JSON reviewer field is explicitly unverified
  and cannot promote a release. Attachments must remain relative to their evidence document.
  One evidence document or attachment reference cannot be reused to close another evidence
  kind.
  Bundled Slice 8 versions display evidence so one immutable report represents one exact
  single- or dual-display/DPI cell instead of forcing every report to be dual-display.
- Bundled Slice 8 adds per-cell handoff/report schemas plus a Windows signed-acceptance
  matrix schema. Each producer uses exclusive-create, binds report-relative attachments,
  binds a common `handoffIndexSha256` and unique `cellManifestSha256`, and is aggregated
  by `finalize-windows-signed-acceptance.mjs`, which requires every policy cell exactly
  once and remains `MANUAL_REVIEW_REQUIRED`.
- `windows-review-attestation.schema.json` is the detached reviewer signature over the
  canonical Full report evidence digest.
- `windows-candidate-build-attestation.schema.json` is the detached build-attestor signature
  over the candidate manifest, commit, policy hash, and daemon payload tree fingerprint.
- `windows-release-verification.schema.json` is the only local contract allowed to carry
  `releaseReady: true`; it is emitted by the independent verifier after both signatures pass
  and the selected public keys are proven distinct.

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
`candidate_build_provenance_unverified`. Only
`apps/desktop/tests/verify-windows-release-attestations.mjs`, running in the external release
boundary with caller-fixed anchors and policy-pinned public keys, may emit the separate PASS
verification document.

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
