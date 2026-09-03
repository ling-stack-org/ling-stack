# Cua Driver source-build inputs

This directory locks the source inputs for `0.8.3 (Ling build 1)`. It contains
no provider executable and is therefore not a shipped provider artifact.

`provider-lock.json` intentionally keeps `enabledPlatforms` empty, while
`source-build-inputs.json` keeps `packagingGate.eligible=false`. The build command verifies the exact tag,
commit, tree, Cargo lock, license, patch hashes and native toolchain before it
creates an output directory. Only native CI may later supply repeated-build
pre-sign digests and promote a platform record in a separate reviewed change.

The five committed patches route managed state, expose content-free live
readiness, own host/stdio/Job Object lifetime, return structured standard-tier
capability errors and add a one-way provider input-fence control thread. Native repeated-build and behavioral evidence is still
required; until that evidence is attached, the output is an audit candidate,
not a packaged Ling resource.

The locked upstream commit is not globally clean under Rust 1.97.1 `cargo fmt`
(unrelated untouched files produce a large baseline diff). The build therefore
runs locked `rustfmt --check` over the eight newly introduced Rust files listed
in `series.json`, and separately compiles/tests every selected Cargo package.
Modified upstream files remain bounded by exact patch/touched-path digests rather
than being rewritten solely to erase unrelated baseline formatting drift.

## Reproduce the candidate

Run in the separately governed private native release environment for the target platform:

```bash
node apps/desktop/scripts/build-cua-driver-provider.mjs \
  --platform darwin \
  --work-dir "$RUNNER_TEMP/ling-cua-driver/a" \
  --output-dir "$RUNNER_TEMP/ling-cua-driver/a/output"
node apps/desktop/scripts/verify-cua-driver-source-build.mjs \
  --attestation "$RUNNER_TEMP/ling-cua-driver/a/output/source-build-attestation.json" \
  --output-root "$RUNNER_TEMP/ling-cua-driver/a/output"
```

`--work-dir`, its `source`/`cargo-target` children, and `--output-dir` are
explicitly owned build paths. Source, target, and output paths must be fresh;
the builder never recursively deletes or initializes over an existing path.

On macOS, the locked final-link contract accepts only the reviewed thin-binary runtime
identity. arm64 may perform up to 32 clean `cua-driver` package relinks to reach that
identity. A mismatch is discarded before UUID rewrite or codesign, and exhausting the
bound fails the build. This is a fail-closed selector, not a relaxation of the mandatory
independent A/B byte comparison.

The output contains the pre-sign binary, SPDX SBOM, regenerated third-party
notices, `source-build-manifest.json` and
`source-build-promotion-inputs.json`. It never contains the upstream release
archive, a `.git` directory, `cua-driver-uia.exe` in the packaged payload, or a
fabricated provider seal. A second same-platform output must pass
`--compare-a/--compare-b` before a later signing/promotion slice may update the
V2 platform lock.

After both native candidates pass independently, upload the A/B output. A dependent job on
the same operating system downloads that artifact into a fresh root and generates the
review-only proposal:

```bash
node apps/desktop/scripts/promote-cua-driver-source-build.mjs \
  --platform darwin \
  --candidate-a "$RUNNER_TEMP/ling-cua-driver-download/a/output" \
  --candidate-b "$RUNNER_TEMP/ling-cua-driver-download/b/output" \
  --output-dir "$RUNNER_TEMP/ling-cua-driver-download/promotion"
```

The fresh output contains only a proposed `provider-lock.json` and
`source-build-promotion-receipt.json`. The receipt is always
`MANUAL_REVIEW_REQUIRED`: the upload/download round trip proves the serialized artifact is
what the fixed verifier consumed, but it cannot prove independent A/B build-runner
provenance, commit the lock, mutate this non-promoting source-input file, copy provider
binaries, or claim final signing identity. After the proposal and independent lock anchor
are reviewed and committed, native candidates must be rebuilt again so their attestations
bind the new committed lock before package staging.

The CLI captures the canonical output-parent native identity before either candidate is
executed. It later requires that same identity under the native parent lease, writes a
private identity-checked sibling, and publishes with no replacement. Parent symlink,
junction, reparse or directory swaps fail closed and cannot redirect proposal bytes.
