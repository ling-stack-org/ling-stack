# E6 latest-main integration and isolated-QA binding

Date: 2026-10-26. This records a narrow reviewed integration, not E6 completion,
GUI acceptance, main landing, CI enablement, or publication.

## Exact integration

- E6 predecessor: `4973ec89777f9a6fd5f68a8e2c2fc993dbcdee1f`.
- Previously integrated main: `4ca3f9de16903cdfb4b89322dfcbcf690a1ff861`.
- New main cut: `b3403df97c50e0cf54ea22765e0ebda64219e6d6`, six commits from
  PRs #591, #593 and #594. The merge is non-rewriting and preserves both parents.
- Remote changes are exactly `.github/workflows/desktop-prerelease.yml` and
  `pnpm-lock.yaml`. The lock retains the E6 Daemon acorn declaration.

Structured YAML comparison found only apps/mobile's expo-camera 58.0.11 →
58.0.12, barcode-detector 3.2.2 → 3.2.3 and zxing-wasm 3.1.3 → 3.1.6 records.
The independent review traced all workspace importers: only Mobile reaches
these changed snapshots; Desktop/Core/Daemon closures remain identical.
Workflow changes replace only setup-dotnet/setup-go action SHAs; triggers,
permissions, conditions, tool versions and arguments are unchanged. No CI was
enabled or dispatched. This is not a new Mobile native/device acceptance.

## Exact source-review binding

The existing user instructions authorize continued isolated QA (`批准，不发布，
只验证` and `批准，不用再问我了`), not release or fabricated human authentication.
Root applies that standing scope only after the independent delta review.
This is not a fresh line-by-line human approval or a new OS trust guarantee.

Of Office's 1,621 packaging inputs, only the lock digest changes. Office's 15
native source hashes and sandbox's 19 source hashes remain equal to their
reviewed records. Sandbox's reviewed row and all other Office approval,
runtime, toolchain, signing, protocol and trust fields are unchanged.

The single approved packaging digest is rebound in
`native/office-local/reviewed-packaged-source-v1.json`:

- Previous lock: `3acab5b137fdd0371cebab7d7075089ed03d057fed951b07c9c20dc0c6ab8c65`.
- Combined lock: `46f37854dc9456064c168d7ea07dbb4949ebec566b746bdf5cf65edea4a489e3`.

Before this binding, the unchanged real reader rejected the new lock with
`packaged_office_native_source_review_invalid`. After binding it actually
validated all 1,621 packaging inputs; the record's SHA256 is
`1da894f0a90dfd8c5ef7e95ae3da4dc147a23d585f3211d4c2730b6cc12878ed`.
A structured comparison with the predecessor verified that only that single
lock digest changed. No reader assertion, frozen input, or guard is
removed. The remote lock alone has a different digest because it lacks E6's
already-reviewed acorn declaration; copying that digest would be incorrect.

Independent evidence is retained in
`output/e6-20260928/p5-merged-input-review-20261026/remote-main-b3403df9-independent-delta-review.md`.
The existing v4 environment delta review is separate and does not itself
approve this new main cut. The merged checkpoint must be clean and saved
before v4 freeze; only a real subsequent package and GUI run can close P3/P5.
