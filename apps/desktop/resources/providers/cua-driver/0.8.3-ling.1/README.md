# Cua Driver source-build inputs

This directory locks the source inputs for `0.8.3 (Ling build 1)`. It contains
no provider executable and is therefore not a shipped provider artifact.

`provider-lock.json` intentionally keeps `enabledPlatforms` empty and
`packagingGate.eligible=false`. The build command verifies the exact tag,
commit, tree, Cargo lock, license, patch hashes and native toolchain before it
creates an output directory. Only native CI may later supply repeated-build
pre-sign digests and promote a platform record in a separate reviewed change.

The four committed patches route managed state, expose content-free live
readiness, own host/stdio/Job Object lifetime and return structured standard-tier
capability errors. Native repeated-build and behavioral evidence is still
required; until that evidence is attached, the output is an audit candidate,
not a packaged Ling resource.

The locked upstream commit is not globally clean under Rust 1.97.1 `cargo fmt`
(unrelated untouched files produce a large baseline diff). The build therefore
runs locked `rustfmt --check` over the seven newly introduced Rust files listed
in `series.json`, and separately compiles/tests every selected Cargo package.
Modified upstream files remain bounded by exact patch/touched-path digests rather
than being rewritten solely to erase unrelated baseline formatting drift.

## Reproduce the candidate

Run on the locked native runner for the target platform:

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

The output contains the pre-sign binary, SPDX SBOM, regenerated third-party
notices, `source-build-manifest.json` and
`source-build-promotion-inputs.json`. It never contains the upstream release
archive, a `.git` directory, `cua-driver-uia.exe` in the packaged payload, or a
fabricated provider seal. A second same-platform output must pass
`--compare-a/--compare-b` before a later signing/promotion slice may update the
V2 platform lock.
