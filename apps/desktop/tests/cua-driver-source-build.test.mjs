import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";

import {
  parseGitNumstatTouchedPaths,
  parseGitNameStatusTouchedPaths,
  verifyPatchTouchedPathAllowlist,
  PROVIDER_RESOURCE_ROOT,
  verifySourceBuildArtifactInventory,
  verifyProviderInputs,
} from "../scripts/cua-driver-source-build-lib.mjs";
import {
  mergeEnvironment,
  parseWindowsEnvironment,
} from "../scripts/cua-driver-source-build-toolchain.mjs";
import { generateSupplyChainMetadata } from "../scripts/cua-driver-source-build-supply-chain.mjs";
import {
  canonicalJson,
  canonicalizeToolsList,
  FROZEN_DENIED_TOOLS,
  FROZEN_HEALTH_SKIP,
  probeCuaDriverProvider,
  sha256Text,
  validateManagedWindowsAcl,
  verifyLinkUnchanged,
  verifyManagedStatePermissions,
} from "../scripts/probe-cua-driver-provider.mjs";
import {
  inspectUniversalMachO,
  verifyPinnedBytes,
  verifyVersionOutput,
} from "../scripts/cua-driver-binary-identity.mjs";
import {
  normalizeCuaDriverMachOIdentity,
  selectCanonicalCuaDriverMachOIdentity,
} from "../scripts/cua-driver-macho-identity-normalizer.mjs";
import {
  downloadPinnedArchive,
  parseBooleanEntitlements,
  parseTarVerboseListing,
  validateArchiveMemberPath,
  validateReferenceMemberInventory,
  verifyReferenceArtifactEvidence,
} from "../scripts/cua-driver-reference-artifacts.mjs";
import {
  bindExpectedProviderSnapshot,
  createObservedProviderVersionResolverForTest,
  stableRuntimeProbe,
  verifyAttestationShape,
  verifyOutputMetadataBindings,
  verifyPromotionBindings,
  verifyProviderSealInputs,
  verifyRuntimeProbe,
} from "../scripts/verify-cua-driver-source-build.mjs";
import {
  resolveCuaDriverPackageAuthorization,
} from "../scripts/check-cua-driver-package-authorization.mjs";

const execFile = promisify(execFileCallback);
const BUILD_SCRIPT = new URL("../scripts/build-cua-driver-provider.mjs", import.meta.url).pathname;
const VERIFY_SCRIPT = new URL("../scripts/verify-cua-driver-source-build.mjs", import.meta.url).pathname;
const DESKTOP_ARTIFACTS_WORKFLOW = new URL("../../../.github/workflows/desktop-artifacts.yml", import.meta.url).pathname;
const SELF_HOSTED_NATIVE_WORKFLOW = new URL("../../../.github/workflows/cua-driver-self-hosted-native.yml", import.meta.url).pathname;
const DARWIN_REPRODUCIBILITY_DIAGNOSTIC = new URL("../scripts/diagnose-cua-driver-darwin-reproducibility.mjs", import.meta.url).pathname;

test("provider lock is the exact V2 contract and remains fail-closed", async () => {
  const lock = JSON.parse(await readFile(join(PROVIDER_RESOURCE_ROOT, "provider-lock.json"), "utf8"));
  assert.deepEqual(Object.keys(lock).sort(), [
    "componentId",
    "distributionRevision",
    "enabledPlatforms",
    "platforms",
    "schemaVersion",
    "upstream",
  ]);
  assert.deepEqual(Object.keys(lock.upstream).sort(), [
    "commit",
    "license",
    "licenseSha256",
    "releaseStage",
    "repository",
    "tag",
    "tree",
    "version",
  ]);
  assert.deepEqual(lock.enabledPlatforms, []);
  assert.deepEqual(lock.platforms, {});
  const inputs = JSON.parse(await readFile(join(PROVIDER_RESOURCE_ROOT, "source-build-inputs.json"), "utf8"));
  assert.deepEqual(Object.keys(inputs).sort(), [
    "compatibility",
    "componentId",
    "distributionRevision",
    "packagingGate",
    "patchSet",
    "platformOutputs",
    "productVersionLabel",
    "providerLockRelativePath",
    "referenceArtifacts",
    "runtime",
    "schemaVersion",
    "sourceBuildPlatforms",
    "toolchain",
    "upstreamBuild",
  ]);
  assert.equal(inputs.platformOutputs.win32X64.uiaPackaged, false);
  assert.equal(inputs.packagingGate.eligible, false);
  assert.deepEqual(inputs.runtime.managedDeniedTools, ["check_for_update"]);
  const series = JSON.parse(
    await readFile(join(PROVIDER_RESOURCE_ROOT, inputs.patchSet.manifest), "utf8"),
  );
  assert.deepEqual(series.rustfmtPaths, [
    "libs/cua-driver/rust/crates/cua-driver-core/src/ling_managed.rs",
    "libs/cua-driver/rust/crates/cua-driver-core/src/ling_managed_readiness.rs",
    "libs/cua-driver/rust/crates/cua-driver/src/ling_managed_lifetime.rs",
    "libs/cua-driver/rust/crates/cua-driver/tests/ling_managed_native.rs",
    "libs/cua-driver/rust/crates/platform-windows/src/ling_managed_capability.rs",
    "libs/cua-driver/rust/crates/platform-windows/src/managed_lifetime.rs",
    "libs/cua-driver/rust/crates/platform-windows/src/managed_readiness.rs",
  ]);
});

test("package authorization follows only the independently anchored committed lock", async () => {
  const providerLock = JSON.parse(
    await readFile(join(PROVIDER_RESOURCE_ROOT, "provider-lock.json"), "utf8"),
  );
  const digest = "a".repeat(64);
  const closed = resolveCuaDriverPackageAuthorization({
    actualLockSha256: digest,
    expectedLockSha256: digest,
    platform: "darwin",
    providerLock,
  });
  assert.equal(closed.authorized, false);

  const promoted = {
    ...providerLock,
    enabledPlatforms: ["darwin"],
    platforms: { darwin: {} },
  };
  assert.equal(resolveCuaDriverPackageAuthorization({
    actualLockSha256: digest,
    expectedLockSha256: digest,
    platform: "darwin",
    providerLock: promoted,
  }).authorized, true);
  assert.equal(resolveCuaDriverPackageAuthorization({
    actualLockSha256: digest,
    expectedLockSha256: digest,
    platform: "win32-x64",
    providerLock: promoted,
  }).authorized, false);
  assert.throws(
    () => resolveCuaDriverPackageAuthorization({
      actualLockSha256: digest,
      expectedLockSha256: "b".repeat(64),
      platform: "darwin",
      providerLock: promoted,
    }),
    /provider_lock_anchor_mismatch/u,
  );
});

test("source-build workflow actions use immutable full commit SHAs", async () => {
  const workflow = await readFile(DESKTOP_ARTIFACTS_WORKFLOW, "utf8");
  const sourceJobs = workflow.slice(
    workflow.indexOf("  cua-driver-source-build-macos:"),
    workflow.indexOf("  macos-unsigned:"),
  );
  const uses = [...sourceJobs.matchAll(/^\s+uses:\s+([^\s]+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(uses.length, 17);
  for (const action of uses) assert.match(action, /^[^@]+@[0-9a-f]{40}$/u);
  const macosBuildJob = sourceJobs.slice(
    sourceJobs.indexOf("  cua-driver-source-build-macos:"),
    sourceJobs.indexOf("  cua-driver-source-build-windows:"),
  );
  const windowsBuildJob = sourceJobs.slice(
    sourceJobs.indexOf("  cua-driver-source-build-windows:"),
    sourceJobs.indexOf("  cua-driver-source-build-promotion-macos:"),
  );
  const macosPromotionJob = sourceJobs.slice(
    sourceJobs.indexOf("  cua-driver-source-build-promotion-macos:"),
    sourceJobs.indexOf("  cua-driver-source-build-promotion-windows:"),
  );
  const windowsPromotionJob = sourceJobs.slice(
    sourceJobs.indexOf("  cua-driver-source-build-promotion-windows:"),
  );
  assert.doesNotMatch(macosBuildJob, /promote-cua-driver-source-build\.mjs/u);
  assert.doesNotMatch(windowsBuildJob, /promote-cua-driver-source-build\.mjs/u);
  assert.match(
    macosPromotionJob,
    /needs: cua-driver-source-build-macos[\s\S]+actions\/download-artifact@[0-9a-f]{40}[\s\S]+name: cua-driver-source-build-macos-universal/u,
  );
  assert.match(
    windowsPromotionJob,
    /needs: cua-driver-source-build-windows[\s\S]+actions\/download-artifact@[0-9a-f]{40}[\s\S]+name: cua-driver-source-build-windows-x64/u,
  );
  assert.match(
    macosPromotionJob,
    /promote-cua-driver-source-build\.mjs[\s\S]+--platform darwin[\s\S]+--candidate-a[\s\S]+--candidate-b[\s\S]+--output-dir/u,
  );
  assert.match(
    windowsPromotionJob,
    /promote-cua-driver-source-build\.mjs --platform win32-x64 --candidate-a[\s\S]+--candidate-b[\s\S]+--output-dir/u,
  );
  assert.match(sourceJobs, /name: cua-driver-source-build-promotion-macos-universal/u);
  assert.match(sourceJobs, /name: cua-driver-source-build-promotion-windows-x64/u);
  assert.match(sourceJobs, /name: cua-driver-source-build-macos-universal/u);
  assert.match(sourceJobs, /name: cua-driver-source-build-windows-x64/u);
  for (const artifactName of [
    "cua-driver-source-build-promotion-macos-universal",
    "cua-driver-source-build-promotion-windows-x64",
  ]) {
    const start = sourceJobs.indexOf(`          name: ${artifactName}`);
    const end = sourceJobs.indexOf("\n\n", start);
    const upload = sourceJobs.slice(start, end);
    assert.match(
      upload,
      /path: \$\{\{ runner\.temp \}\}\/ling-cua-driver-source-build-download\/promotion\/\*\*/u,
    );
    assert.doesNotMatch(upload, /path:\s*\|/u);
  }
  for (const [job, artifactName] of [
    [macosPromotionJob, "cua-driver-source-build-macos-universal"],
    [windowsPromotionJob, "cua-driver-source-build-windows-x64"],
  ]) {
    assert.match(job, new RegExp(
      `name: ${artifactName}[\\s\\S]+path: \\$\\{\\{ runner\\.temp \\}\\}/ling-cua-driver-source-build-download`,
      "u",
    ));
    assert.match(job, /candidate-a[^\n]+a\/output/u);
    assert.match(job, /candidate-b[^\n]+b\/output/u);
  }
  assert.match(
    macosBuildJob,
    /Resolve committed macOS package authorization[\s\S]+id: package-authorization[\s\S]+--platform darwin[\s\S]+Run production macOS package wrapper with both architectures\n\s+if: steps\.package-authorization\.outputs\.authorized == 'true'[\s\S]+run-cua-driver-signing-builder-fixture\.mjs[\s\S]+a\/output/u,
  );
  assert.match(
    windowsBuildJob,
    /Resolve committed Windows package authorization[\s\S]+id: package-authorization[\s\S]+--platform win32-x64[\s\S]+Run production Windows package wrapper\n\s+if: steps\.package-authorization\.outputs\.authorized == 'true'[\s\S]+run-cua-driver-signing-builder-fixture\.mjs --source-root/u,
  );
  const desktopPackage = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  assert.match(desktopPackage.scripts["package:mac"], /--mac dmg zip --arm64 --x64/u);
  assert.match(desktopPackage.scripts["package:win"], /--win nsis --x64/u);
});

test("self-hosted macOS A/B failures emit bounded reproducibility diagnostics", async () => {
  const [workflow, diagnostic] = await Promise.all([
    readFile(SELF_HOSTED_NATIVE_WORKFLOW, "utf8"),
    readFile(DARWIN_REPRODUCIBILITY_DIAGNOSTIC, "utf8"),
  ]);
  assert.match(
    workflow,
    /- name: Compare repeated universal pre-sign outputs\n\s+id: repeat-build-compare[\s\S]+- name: Diagnose macOS repeated-build mismatch\n\s+if: failure\(\) && steps\.repeat-build-compare\.outcome == 'failure'/u,
  );
  assert.match(workflow, /diagnose-cua-driver-darwin-reproducibility\.mjs/u);
  assert.match(diagnostic, /MAX_BINARY_BYTES = 128 \* 1024 \* 1024/u);
  assert.match(diagnostic, /MAX_REPORTED_DIFFERENCES = 64/u);
  assert.match(diagnostic, /SWIFT_ARCHIVE_PATTERN/u);
});

test("self-hosted native workflow is manual, identity-bound, and uses only dedicated runner labels", async () => {
  const workflow = await readFile(SELF_HOSTED_NATIVE_WORKFLOW, "utf8");
  const macosBuildJob = workflow.slice(
    workflow.indexOf("  macos-source-build:"),
    workflow.indexOf("  macos-promotion-proposal:"),
  );
  const windowsBuildJob = workflow.slice(
    workflow.indexOf("  windows-source-build:"),
    workflow.indexOf("  windows-promotion-proposal:"),
  );
  assert.match(workflow, /^  workflow_call:/mu);
  assert.match(workflow, /^  workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^  (?:pull_request|push):/mu);
  assert.match(workflow, /expected_commit:[\s\S]+Full 40-character commit SHA/u);
  assert.match(workflow, /runs-on:\n      - ling-cua-driver-macos-arm64-v1/u);
  assert.match(workflow, /runs-on:\n      - ling-cua-driver-windows-x64-v1/u);
  assert.doesNotMatch(workflow, /runs-on:\s+(?:macos-|windows-|ubuntu-)/u);
  assert.doesNotMatch(workflow, /\b(?:pull_request_target|schedule)\b/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /retention-days: 1/u);
  assert.match(workflow, /GITHUB_TRIGGERING_ACTOR/u);
  assert.doesNotMatch(workflow, /\$\{\{\s*runner\.temp\s*\}\}/u);
  assert.match(workflow, /LING_CUA_BUILD_ROOT=\$RUNNER_TEMP\//u);
  assert.match(workflow, /LING_CUA_PROMOTION_ROOT=\$RUNNER_TEMP\//u);
  assert.match(workflow, /LING_CUA_BUILD_ROOT=\$env:RUNNER_TEMP\\/u);
  assert.match(workflow, /LING_CUA_PROMOTION_ROOT=\$env:RUNNER_TEMP\\/u);
  assert.match(workflow, /verify-cua-driver-self-hosted-runner\.mjs --platform darwin/u);
  assert.match(workflow, /verify-cua-driver-self-hosted-runner\.mjs --platform win32-x64/u);
  assert.match(
    macosBuildJob,
    /Resolve committed macOS package authorization[\s\S]+id: package-authorization[\s\S]+--platform darwin[\s\S]+Run production macOS package wrapper with both architectures\n\s+if: steps\.package-authorization\.outputs\.authorized == 'true'[\s\S]+run-cua-driver-signing-builder-fixture\.mjs[\s\S]+LING_CUA_BUILD_ROOT\/a\/output/u,
  );
  assert.match(
    windowsBuildJob,
    /Resolve committed Windows package authorization[\s\S]+id: package-authorization[\s\S]+--platform win32-x64[\s\S]+Run production Windows package wrapper\n\s+if: steps\.package-authorization\.outputs\.authorized == 'true'[\s\S]+run-cua-driver-signing-builder-fixture\.mjs --source-root/u,
  );
  assert.match(workflow, /cua-driver-self-hosted-electron-builder-macos-/u);
  assert.match(workflow, /cua-driver-self-hosted-electron-builder-windows-/u);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/u);
  assert.match(workflow, /actions\/download-artifact@[0-9a-f]{40}/u);
  for (const action of workflow.matchAll(/^\s+uses:\s+([^\s]+)$/gmu)) {
    assert.match(action[1], /^[^@]+@[0-9a-f]{40}$/u);
  }

  const caller = await readFile(DESKTOP_ARTIFACTS_WORKFLOW, "utf8");
  assert.match(caller, /execution_mode:[\s\S]+self-hosted-native/u);
  assert.match(caller, /uses: \.\/\.github\/workflows\/cua-driver-self-hosted-native\.yml/u);
  assert.match(caller, /expected_commit: \$\{\{ inputs\.expected_commit \}\}/u);
  assert.equal(
    [...caller.matchAll(/if: inputs\.execution_mode != 'self-hosted-native'/gu)].length,
    7,
  );
});

test("reproducible final linker flags never poison executable host build scripts", async () => {
  const source = await readFile(BUILD_SCRIPT, "utf8");
  const buildEnvironment = source.slice(
    source.indexOf("function buildEnv("),
    source.indexOf("function finalBinaryRustcFlags("),
  );
  assert.doesNotMatch(buildEnvironment, /(?:no|random)_uuid|Brepro|target-feature/u);
  assert.match(buildEnvironment, /RUSTFLAGS: flags\.join/u);
  const finalFlags = source.slice(source.indexOf("function finalBinaryRustcFlags("));
  assert.doesNotMatch(finalFlags, /(?:no|random)_uuid/u);
  assert.match(finalFlags, /link-arg=-Wl,-reproducible/u);
  assert.doesNotMatch(finalFlags, /link-arg=-Wl,-no_deduplicate/u);
  assert.match(finalFlags, /link-arg=\/Brepro/u);
  assert.match(source, /normalizeCuaDriverSwiftArchives/u);
  assert.match(source, /postLinkIdentityNormalization/u);
  assert.match(source, /swiftArchiveNormalization\.finalMetadata/u);
  assert.match(source, /finalRelink\.cleanPackage/u);
  assert.match(source, /selectCanonicalCuaDriverMachOIdentity/u);
  assert.ok(
    source.indexOf("selectCanonicalCuaDriverMachOIdentity({")
      < source.indexOf("identityPin.codesignPath"),
    "canonical relink selection must finish before codesign",
  );
  assert.match(
    source,
    /"clean",[\s\S]+"--release",[\s\S]+"--target",[\s\S]+"--package",[\s\S]+"--target-dir"/u,
  );
  assert.match(source, /"rustc",[\s\S]+"--bin",[\s\S]+finalBinaryRustcFlags\(platform\)/u);
});

test("canonical Mach-O relink selector accepts only the reviewed identity and fails closed", async () => {
  const canonical = makeThinMachO(0x41);
  const alternate = makeThinMachO(0x42);
  const expectedSourceSha256 = normalizeCuaDriverMachOIdentity(canonical).sourceSha256;

  let attempts = 0;
  const first = await selectCanonicalCuaDriverMachOIdentity({
    target: "aarch64-apple-darwin",
    expectedSourceSha256,
    maxAttempts: 32,
    relink: async () => {
      attempts += 1;
      return canonical;
    },
  });
  assert.equal(first.relinkAttempts, 1);
  assert.equal(attempts, 1);

  const events = [];
  const second = await selectCanonicalCuaDriverMachOIdentity({
    target: "aarch64-apple-darwin",
    expectedSourceSha256,
    maxAttempts: 32,
    relink: async (attempt) => {
      events.push(`relink:${attempt}`);
      return attempt === 1 ? alternate : canonical;
    },
  });
  events.push("codesign");
  assert.equal(second.relinkAttempts, 2);
  assert.deepEqual(events, ["relink:1", "relink:2", "codesign"]);

  attempts = 0;
  await assert.rejects(
    selectCanonicalCuaDriverMachOIdentity({
      target: "aarch64-apple-darwin",
      expectedSourceSha256,
      maxAttempts: 3,
      relink: async () => {
        attempts += 1;
        return alternate;
      },
    }),
    /canonical Mach-O source identity was not reached.*after 3 attempts/u,
  );
  assert.equal(attempts, 3);
});

test("macOS and Windows artifact jobs run complete core, daemon and Pi runner suites", async () => {
  const workflow = await readFile(DESKTOP_ARTIFACTS_WORKFLOW, "utf8");
  const macosJob = workflow.slice(
    workflow.indexOf("  macos-unsigned:"),
    workflow.indexOf("  windows-unsigned:"),
  );
  const windowsJob = workflow.slice(workflow.indexOf("  windows-unsigned:"));

  for (const [name, job] of [["macOS", macosJob], ["Windows", windowsJob]]) {
    assert.match(job, /- name: Run Computer Use contract tests\s+run: node --test packages\/contracts\/test\/computer-use\.test\.mjs packages\/api-client\/test\/computer-use\.test\.mjs/u, name);
    assert.match(job, /- name: Run complete core suite\s+run: corepack pnpm --filter @ling-stack\/core test/u, name);
    assert.match(job, /- name: Run complete daemon suite\s+run: corepack pnpm --filter @ling-stack\/daemon test/u, name);
    assert.match(job, /- name: Run complete Pi runner suite\s+run: corepack pnpm --filter @ling-stack\/runner-pi test/u, name);
  }
});

test("verify-only validates the pinned source, patch series and closed packaging gate", async () => {
  const result = await runNode([BUILD_SCRIPT, "--platform", "darwin", "--output-dir", join(await mkdtemp(join(tmpdir(), "ling-cua-verify-out-")), "out"), "--verify-only"]);
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.packagingEligible, false);
  assert.match(value.patchSet, /^[0-9a-f]{64}$/u);
});

test("source-build verification stays non-promoting when package authority enables a platform", async () => {
  const promoted = await copyResources();
  try {
    const lock = await readJson(join(promoted, "provider-lock.json"));
    lock.enabledPlatforms = ["darwin"];
    lock.platforms = { darwin: {} };
    await writeJson(join(promoted, "provider-lock.json"), lock);

    const verified = await verifyProviderInputs(promoted);
    assert.deepEqual(verified.providerLock.enabledPlatforms, ["darwin"]);
    assert.equal(verified.lock.packagingGate.eligible, false);

    const inputs = await readJson(join(promoted, "source-build-inputs.json"));
    inputs.packagingGate.eligible = true;
    await writeJson(join(promoted, "source-build-inputs.json"), inputs);
    await assert.rejects(
      verifyProviderInputs(promoted),
      /source-build packaging gate must remain closed/u,
    );
  } finally {
    await rm(promoted, { recursive: true, force: true });
  }
});

test("source builder refuses overlapping or pre-existing output paths without deleting them", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-output-boundary-"));
  try {
    const workRoot = join(root, "work");
    const overlap = await runNode([
      BUILD_SCRIPT,
      "--platform",
      "darwin",
      "--work-dir",
      workRoot,
      "--output-dir",
      workRoot,
      "--verify-only",
    ]);
    assert.notEqual(overlap.code, 0);
    assert.match(overlap.stderr, /unsafe output directory/);

    const existing = join(root, "valuable-output");
    await mkdir(existing);
    const sentinel = join(existing, "keep.txt");
    await writeFile(sentinel, "do not delete");
    const occupied = await runNode([
      BUILD_SCRIPT,
      "--platform",
      "darwin",
      "--work-dir",
      workRoot,
      "--output-dir",
      existing,
      "--verify-only",
    ]);
    assert.notEqual(occupied.code, 0);
    assert.match(occupied.stderr, /already exists/);
    assert.equal(await readFile(sentinel, "utf8"), "do not delete");

    const sourceRoot = join(workRoot, "source");
    await mkdir(sourceRoot, { recursive: true });
    const sourceSentinel = join(sourceRoot, "keep.txt");
    await writeFile(sourceSentinel, "do not initialize over this directory");
    const occupiedSource = await runNode([
      BUILD_SCRIPT,
      "--platform",
      "darwin",
      "--work-dir",
      workRoot,
      "--output-dir",
      join(workRoot, "fresh-output"),
    ]);
    assert.notEqual(occupiedSource.code, 0);
    assert.match(occupiedSource.stderr, /source checkout already exists/);
    assert.equal(await readFile(sourceSentinel, "utf8"), "do not initialize over this directory");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider resources reject extra lock fields, missing platform output and embedded .git", async () => {
  const extra = await copyResources();
  try {
    const lock = await readJson(join(extra, "provider-lock.json"));
    lock.extra = true;
    await writeJson(join(extra, "provider-lock.json"), lock);
    await assert.rejects(verifyProviderInputs(extra), /provider lock keys/);
  } finally {
    await rm(extra, { recursive: true, force: true });
  }

  const missing = await copyResources();
  try {
    const inputs = await readJson(join(missing, "source-build-inputs.json"));
    delete inputs.platformOutputs.win32X64;
    await writeJson(join(missing, "source-build-inputs.json"), inputs);
    await assert.rejects(verifyProviderInputs(missing), /platform outputs keys|win32-x64 platform output/);
  } finally {
    await rm(missing, { recursive: true, force: true });
  }

  const missingLockRecord = await copyResources();
  try {
    const lock = await readJson(join(missingLockRecord, "provider-lock.json"));
    lock.enabledPlatforms = ["darwin"];
    await writeJson(join(missingLockRecord, "provider-lock.json"), lock);
    await assert.rejects(verifyProviderInputs(missingLockRecord), /missing its lock record/);
  } finally {
    await rm(missingLockRecord, { recursive: true, force: true });
  }

  const extraInput = await copyResources();
  try {
    const inputs = await readJson(join(extraInput, "source-build-inputs.json"));
    inputs.runtime.unreviewedFlag = true;
    await writeJson(join(extraInput, "source-build-inputs.json"), inputs);
    await assert.rejects(verifyProviderInputs(extraInput), /source-build runtime keys/);
  } finally {
    await rm(extraInput, { recursive: true, force: true });
  }

  const withGit = await copyResources();
  try {
    await mkdir(join(withGit, ".git"));
    await assert.rejects(verifyProviderInputs(withGit), /.git repository/);
  } finally {
    await rm(withGit, { recursive: true, force: true });
  }
});

test("patch tampering and touched-path allowlist tampering fail closed", async () => {
  const tamperedPatch = await copyResources();
  try {
    const patchPath = join(tamperedPatch, "patches/ling-managed-embedded-v1/0001-ling-embedded-state-home-v1.patch");
    await writeFile(patchPath, `${await readFile(patchPath, "utf8")}\n# tampered\n`);
    await assert.rejects(verifyProviderInputs(tamperedPatch), /patch digest mismatch/);
  } finally {
    await rm(tamperedPatch, { recursive: true, force: true });
  }

  const tamperedManifest = await copyResources();
  try {
    const seriesPath = join(tamperedManifest, "patches/ling-managed-embedded-v1/series.json");
    const series = await readJson(seriesPath);
    series.touchedPaths.push("libs/cua-driver/rust/UNEXPECTED.rs");
    await writeJson(seriesPath, series);
    await assert.rejects(verifyProviderInputs(tamperedManifest), /patch series digest mismatch|touched-path allowlist|touchedPaths/);
  } finally {
    await rm(tamperedManifest, { recursive: true, force: true });
  }

  const addDeleteRenamePatch = [
    "diff --git a/src/deleted.rs b/src/deleted.rs",
    "deleted file mode 100644",
    "--- a/src/deleted.rs",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-deleted",
    "diff --git a/src/added.rs b/src/added.rs",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/added.rs",
    "@@ -0,0 +1 @@",
    "+added",
    "diff --git a/src/old-name.rs b/src/new-name.rs",
    "similarity index 100%",
    "rename from src/old-name.rs",
    "rename to src/new-name.rs",
    "",
  ].join("\n");
  const exactPaths = [
    "src/added.rs",
    "src/deleted.rs",
    "src/new-name.rs",
    "src/old-name.rs",
  ];
  assert.throws(
    () => verifyPatchTouchedPathAllowlist(
      [addDeleteRenamePatch],
      exactPaths.filter((path) => path !== "src/deleted.rs"),
    ),
    /patch touched-path allowlist mismatch/,
  );
  assert.deepEqual(verifyPatchTouchedPathAllowlist([addDeleteRenamePatch], exactPaths), exactPaths);
  assert.deepEqual(
    parseGitNameStatusTouchedPaths(
      "A\0src/added.rs\0D\0src/deleted.rs\0R100\0src/old-name.rs\0src/new-name.rs\0",
    ),
    exactPaths,
  );
  assert.deepEqual(
    parseGitNumstatTouchedPaths(
      [
        "1\t0\tsrc/added.rs",
        "0\t1\tsrc/deleted.rs",
        "0\t0\t",
        "src/old-name.rs",
        "src/new-name.rs",
        "",
      ].join("\0"),
    ),
    exactPaths,
  );

  const traditionalDeletion = [
    "--- a/src/hidden-delete.rs",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-hidden",
    "",
  ].join("\n");
  assert.throws(
    () => verifyPatchTouchedPathAllowlist([traditionalDeletion], ["src/hidden-delete.rs"]),
    /requires a canonical diff header/,
  );
  const canonicalAdditionWithAppendedTraditionalDeletion = [
    "diff --git a/src/visible-add.rs b/src/visible-add.rs",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/visible-add.rs",
    "@@ -0,0 +1 @@",
    "+visible",
    traditionalDeletion,
  ].join("\n");
  assert.throws(
    () => verifyPatchTouchedPathAllowlist(
      [canonicalAdditionWithAppendedTraditionalDeletion],
      ["src/hidden-delete.rs", "src/visible-add.rs"],
    ),
    /duplicate old path marker/,
  );
});

test("reference archive inventory rejects traversal, duplicates, extras and links", () => {
  const expected = ["bundle/cua-driver-uia.exe", "bundle/cua-driver.exe"];
  assert.deepEqual(validateReferenceMemberInventory({
    listedMembers: ["bundle/cua-driver-uia.exe", "bundle/cua-driver.exe"],
    verboseMembers: [
      { path: "bundle/cua-driver-uia.exe", type: "file" },
      { path: "bundle/cua-driver.exe", type: "file" },
    ],
    expectedMembers: expected,
  }), expected);
  for (const invalid of ["/absolute.exe", "C:/absolute.exe", "../escape.exe", "bundle/../escape.exe", "bundle\\escape.exe", "bundle//escape.exe"]) {
    assert.throws(() => validateArchiveMemberPath(invalid), /absolute|traverses|invalid/);
  }
  assert.throws(() => validateReferenceMemberInventory({
    listedMembers: [expected[0], expected[0]],
    verboseMembers: [{ path: expected[0], type: "file" }, { path: expected[1], type: "file" }],
    expectedMembers: expected,
  }), /duplicate members/);
  assert.throws(() => validateReferenceMemberInventory({
    listedMembers: [...expected, "bundle/extra.exe"],
    verboseMembers: [...expected.map((path) => ({ path, type: "file" })), { path: "bundle/extra.exe", type: "file" }],
    expectedMembers: expected,
  }), /allowlist mismatch/);
  for (const type of ["symlink", "hardlink", "other"]) {
    assert.throws(() => validateReferenceMemberInventory({
      listedMembers: expected,
      verboseMembers: [{ path: expected[0], type }, { path: expected[1], type: "file" }],
      expectedMembers: expected,
    }), /not a regular file/);
  }
  assert.throws(
    () => parseTarVerboseListing(`-rw-r--r-- 0 0 0 1 Jan 1 00:00 ${expected[0]}\nlrwxr-xr-x 0 0 0 1 Jan 1 00:00 bundle/extra.exe`, expected),
    /unrecognized verbose archive member/,
  );
});

test("reference downloader enforces exact bytes, digest and per-attempt deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-reference-download-"));
  try {
    const expected = {
      sizeBytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    };
    const accepted = join(root, "accepted.bin");
    await downloadPinnedArchive(
      "https://example.invalid/reference",
      accepted,
      expected,
      async () => new Response(Buffer.from("abc")),
      1_000,
    );
    assert.equal(await readFile(accepted, "utf8"), "abc");

    await assert.rejects(
      downloadPinnedArchive(
        "https://example.invalid/stalled",
        join(root, "stalled.bin"),
        expected,
        async (_url, { signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
        5,
      ),
      /timed out after 5ms/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reference and built binary identity pins fail closed", async () => {
  const inputs = await readJson(join(PROVIDER_RESOURCE_ROOT, "source-build-inputs.json"));
  const darwin = inputs.referenceArtifacts.darwin;
  const darwinEvidence = {
    schemaVersion: 1,
    usage: "reference_only_never_packaged",
    platform: "darwin",
    archive: {
      filename: darwin.filename,
      sizeBytes: darwin.sizeBytes,
      sha256: darwin.sha256,
      members: [darwin.member],
    },
    identity: {
      member: darwin.member,
      sizeBytes: darwin.binarySizeBytes,
      sha256: darwin.binarySha256,
      format: "Mach-O universal",
      architectures: ["arm64", "x86_64"],
      slices: [
        { architecture: "arm64", minimumOSVersion: darwin.minimumOSVersion, sdkVersion: darwin.sdkVersion },
        { architecture: "x86_64", minimumOSVersion: darwin.minimumOSVersion, sdkVersion: darwin.sdkVersion },
      ],
      signing: {
        identifier: darwin.identifier,
        teamId: darwin.teamId,
        authority: darwin.authority,
        hardenedRuntime: true,
        runtimeVersion: darwin.runtimeVersion,
        entitlements: darwin.entitlements,
      },
    },
  };
  assert.equal(verifyReferenceArtifactEvidence({ platform: "darwin", reference: darwin, evidence: darwinEvidence }), true);
  const emptySlices = structuredClone(darwinEvidence);
  emptySlices.identity.slices = [];
  assert.throws(
    () => verifyReferenceArtifactEvidence({ platform: "darwin", reference: darwin, evidence: emptySlices }),
    /slices changed/,
  );
  const wrongSigner = structuredClone(darwinEvidence);
  wrongSigner.identity.signing.teamId = "ATTACKER";
  assert.throws(() => verifyReferenceArtifactEvidence({ platform: "darwin", reference: darwin, evidence: wrongSigner }), /Team ID changed/);

  const win = inputs.referenceArtifacts.win32X64;
  const windowsEvidence = {
    schemaVersion: 1,
    usage: "reference_only_never_packaged",
    platform: "win32-x64",
    archive: {
      filename: win.filename,
      sizeBytes: win.sizeBytes,
      sha256: win.sha256,
      members: [win.mainMember, win.uiaMember].sort(),
    },
    identity: {
      binaries: [
        referencePeEvidence(win.mainMember, "main", win.mainSizeBytes, win.mainSha256, false, win.mainManifestSha256),
        referencePeEvidence(win.uiaMember, "uia-audit", win.uiaSizeBytes, win.uiaSha256, true, win.uiaManifestSha256),
      ],
    },
  };
  assert.equal(verifyReferenceArtifactEvidence({ platform: "win32-x64", reference: win, evidence: windowsEvidence }), true);
  const signedReference = structuredClone(windowsEvidence);
  signedReference.identity.binaries[0].embeddedCertificateTablePresent = true;
  assert.throws(() => verifyReferenceArtifactEvidence({ platform: "win32-x64", reference: win, evidence: signedReference }), /signing state changed/);
  const wrongManifest = structuredClone(windowsEvidence);
  wrongManifest.identity.binaries[1].manifest.uiAccess = false;
  assert.throws(() => verifyReferenceArtifactEvidence({ platform: "win32-x64", reference: win, evidence: wrongManifest }), /manifest changed/);

  assert.deepEqual(verifyPinnedBytes(Buffer.from("abc"), {
    sizeBytes: 3,
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  }, "fixture"), {
    sizeBytes: 3,
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
  assert.throws(() => verifyPinnedBytes(Buffer.from("abc"), { sizeBytes: 4, sha256: "0".repeat(64) }, "fixture"), /size mismatch/);
  const booleanPlist = "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>a</key><true/><key>b</key><false/></dict></plist>";
  assert.deepEqual(parseBooleanEntitlements(booleanPlist), { a: true, b: false });
  assert.throws(
    () => parseBooleanEntitlements("<plist><dict><key>a</key><true/><key>extra</key><string>value</string></dict></plist>"),
    /non-boolean or malformed/,
  );
  assert.equal(verifyVersionOutput("cua-driver 0.8.3\n"), "cua-driver 0.8.3");
  assert.throws(() => verifyVersionOutput("cua-driver 0.8.3-ling.1"), /version output mismatch/);

  const macho = makeUniversalMachO({ minimumOSVersion: [13, 0, 0], sdkVersion: [26, 5, 0] });
  assert.deepEqual(inspectUniversalMachO(macho).architectures, ["arm64", "x86_64"]);
  const wrongArchitecture = Buffer.from(macho);
  wrongArchitecture.writeUInt32BE(0x01000012, 8);
  wrongArchitecture.writeUInt32LE(0x01000012, 48 + 4);
  assert.throws(() => inspectUniversalMachO(wrongArchitecture), /must contain exactly arm64 and x86_64/);
});

test("repeated-build digest verifier catches a changed artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-compare-"));
  const left = join(root, "left");
  const right = join(root, "right");
  await mkdir(left);
  await mkdir(right);
  await writeFile(join(left, "payload.bin"), "same");
  await writeFile(join(right, "payload.bin"), "same");
  const equal = await runNode([VERIFY_SCRIPT, "--compare-a", left, "--compare-b", right]);
  assert.equal(equal.code, 0, equal.stderr);
  await writeFile(join(right, "payload.bin"), "changed");
  const unequal = await runNode([VERIFY_SCRIPT, "--compare-a", left, "--compare-b", right]);
  assert.notEqual(unequal.code, 0);
  assert.match(unequal.stderr, /repeated-build digest mismatch/);
  await rm(root, { recursive: true, force: true });
});

test("staging expectation binds verification to the exact child snapshot", () => {
  const snapshot = Object.freeze({
    bytes: Buffer.from("bounded-provider-snapshot"),
    sha256: "a".repeat(64),
  });
  assert.strictEqual(
    bindExpectedProviderSnapshot({
      expectedProviderSha256: snapshot.sha256,
      relativePath: "darwin/cua-driver",
      snapshot,
    }),
    snapshot,
  );
  assert.throws(
    () => bindExpectedProviderSnapshot({
      expectedProviderSha256: "b".repeat(64),
      relativePath: "darwin/cua-driver",
      snapshot,
    }),
    /provider changed after staging snapshot/u,
  );
});

test("staging version evidence never executes the provider candidate", async () => {
  const calls = [];
  const resolveVersion = createObservedProviderVersionResolverForTest(
    async (executablePath) => {
      calls.push(executablePath);
      return "cua-driver 0.8.3";
    },
  );

  assert.equal(await resolveVersion({
    attestationVersionOutput: "cua-driver 0.8.3",
    executablePath: "/tmp/staged-candidate-must-not-run",
    expectedVersion: "0.8.3",
    stagingExpected: true,
  }), "cua-driver 0.8.3");
  assert.deepEqual(calls, []);

  assert.equal(await resolveVersion({
    attestationVersionOutput: "ignored in standalone mode",
    executablePath: "/tmp/standalone-candidate",
    expectedVersion: "0.8.3",
    stagingExpected: false,
  }), "cua-driver 0.8.3");
  assert.deepEqual(calls, ["/tmp/standalone-candidate"]);

  await assert.rejects(
    resolveVersion({
      attestationVersionOutput: "cua-driver 0.8.4",
      executablePath: "/tmp/staged-candidate-must-not-run",
      expectedVersion: "0.8.3",
      stagingExpected: true,
    }),
    /version output mismatch/u,
  );
  assert.deepEqual(calls, ["/tmp/standalone-candidate"]);
});

test("source-build attestation rejects malformed schema before trusting any digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-attestation-"));
  try {
    const { lock } = await verifyProviderInputs();
    const attestation = join(root, "source-build-attestation.json");
    await writeJson(attestation, { schemaVersion: 1, packagingEligible: true });
    const result = await runNode([VERIFY_SCRIPT, "--attestation", attestation, "--output-root", root]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /attestation schema mismatch/);
    const shaped = {
      schemaVersion: 2,
      kind: "ling.cua-driver.source-build-attestation",
      providerLockSha256: "1".repeat(64),
      sourceBuildInputsSha256: "2".repeat(64),
      upstreamCommit: "3".repeat(40),
      upstreamTree: "4".repeat(40),
      patchSetSha256: "5".repeat(64),
      platform: "darwin",
      sourceDateEpoch: 1,
      toolchain: {},
      checks: {
        toolchain: {},
        rustfmt: { status: "passed", scope: "new-rust-files", paths: [] },
        cargoTests: { status: "passed", packages: [] },
        cargoMetadataSha256: "6".repeat(64),
        machOIdentityNormalization: {
          status: "passed",
          algorithm: "sha256-zeroed-lc-uuid-and-code-signature-v1",
          binaries: ["aarch64-apple-darwin", "x86_64-apple-darwin"].map((target) => ({
            target,
            adHocIdentifier: "ling-cua-driver-presign",
            relinkAttempts: 1,
            sourceSha256: lock.toolchain.darwin.swiftArchiveNormalization
              .finalRelink.targets[target].expectedSourceSha256,
            sha256: "c".repeat(64),
            uuid: "AAAAAAAA-BBBB-3CCC-8DDD-EEEEEEEEEEEE",
          })),
        },
        swiftArchiveNormalization: {
          status: "passed",
          section: "__LLVM,__swift_modhash",
          dwarfSegment: "__DWARF",
          targets: ["aarch64-apple-darwin", "x86_64-apple-darwin"].map((target) => ({
            target,
            archives: [
              { archive: "libapple_cf.rlib", machoMembers: 19, normalizedSections: 13, normalizedDwarfSections: 130 },
              { archive: "libscreencapturekit.rlib", machoMembers: 21, normalizedSections: 10, normalizedDwarfSections: 100 },
            ],
          })),
        },
        referenceArtifact: {},
        binaryIdentity: {},
        versionOutput: "cua-driver 0.8.3",
        runtimeProbe: {},
      },
      binaries: [],
      supplyChain: { sbomSha256: "7".repeat(64), noticesSha256: "8".repeat(64) },
      promotionInputsSha256: "9".repeat(64),
      manifestSha256: "a".repeat(64),
      packagingEligible: false,
      signingState: "pre-sign-only",
    };
    assert.equal(verifyAttestationShape(shaped, lock), true);
    const badUuid = structuredClone(shaped);
    badUuid.checks.machOIdentityNormalization.binaries[0].uuid = "not-a-uuid";
    assert.throws(
      () => verifyAttestationShape(badUuid, lock),
      /Mach-O identity normalization binary evidence mismatch/u,
    );
    for (const index of [0, 1]) {
      const nonCanonical = structuredClone(shaped);
      nonCanonical.checks.machOIdentityNormalization.binaries[index].sourceSha256 = "b".repeat(64);
      assert.throws(
        () => verifyAttestationShape(nonCanonical, lock),
        /Mach-O identity normalization binary evidence mismatch/u,
      );
    }
    const excessiveAttempts = structuredClone(shaped);
    excessiveAttempts.checks.machOIdentityNormalization.binaries[0].relinkAttempts =
      lock.toolchain.darwin.swiftArchiveNormalization.finalRelink
        .targets["aarch64-apple-darwin"].maxAttempts + 1;
    assert.throws(
      () => verifyAttestationShape(excessiveAttempts, lock),
      /Mach-O identity normalization binary evidence mismatch/u,
    );
    const excessiveX64Attempts = structuredClone(shaped);
    excessiveX64Attempts.checks.machOIdentityNormalization.binaries[1].relinkAttempts = 2;
    assert.throws(
      () => verifyAttestationShape(excessiveX64Attempts, lock),
      /Mach-O identity normalization binary evidence mismatch/u,
    );
    assert.throws(
      () => verifyAttestationShape(shaped),
      /canonical Mach-O identity policy is missing/u,
    );
    assert.throws(() => verifyAttestationShape({ ...shaped, unexpected: true }, lock), /attestation keys changed/);
    const missingCheck = structuredClone(shaped);
    delete missingCheck.checks.runtimeProbe;
    assert.throws(() => verifyAttestationShape(missingCheck, lock), /attestation checks keys changed/);

    await writeJson(attestation, shaped);
    const wrongPlatform = await runNode([
      VERIFY_SCRIPT,
      "--expected-platform",
      "win32-x64",
      "--expected-provider-sha256",
      "a".repeat(64),
      "--attestation",
      attestation,
      "--output-root",
      root,
    ]);
    assert.notEqual(wrongPlatform.code, 0);
    assert.match(wrongPlatform.stderr, /does not match the staging expectation/u);

    const missingDigest = await runNode([
      VERIFY_SCRIPT,
      "--expected-platform",
      "darwin",
      "--attestation",
      attestation,
      "--output-root",
      root,
    ]);
    assert.notEqual(missingDigest.code, 0);
    assert.match(missingDigest.stderr, /must be supplied together/u);

    const invalidDigest = await runNode([
      VERIFY_SCRIPT,
      "--expected-platform",
      "darwin",
      "--expected-provider-sha256",
      "invalid",
      "--attestation",
      attestation,
      "--output-root",
      root,
    ]);
    assert.notEqual(invalidDigest.code, 0);
    assert.match(invalidDigest.stderr, /digest is not a SHA-256/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("output metadata digests and platform are bound to the attestation", () => {
  const attestation = {
    platform: "darwin",
    providerLockSha256: "1".repeat(64),
    sourceBuildInputsSha256: "2".repeat(64),
  };
  const actual = {
    "provider-lock.json": attestation.providerLockSha256,
    "source-build-inputs.json": attestation.sourceBuildInputsSha256,
  };
  const manifest = { platform: "darwin" };
  assert.equal(verifyOutputMetadataBindings({ actual, attestation, manifest }), true);
  assert.throws(
    () => verifyOutputMetadataBindings({ actual, attestation, manifest: { platform: "win32-x64" } }),
    /manifest platform mismatch/,
  );
  assert.throws(
    () => verifyOutputMetadataBindings({ actual: { ...actual, "provider-lock.json": "3".repeat(64) }, attestation, manifest }),
    /output provider lock digest mismatch/,
  );
  assert.throws(
    () => verifyOutputMetadataBindings({ actual: { ...actual, "source-build-inputs.json": "4".repeat(64) }, attestation, manifest }),
    /output source-build inputs digest mismatch/,
  );
});

test("runtime and promotion evidence bindings fail closed field by field", async () => {
  const verified = await verifyProviderInputs();
  const { lock } = verified;
  const digest = "1".repeat(64);
  const managedState = {
    preexistingLinkRejected: true,
    rootLinkRejectedBeforeInitialize: true,
    externalHomeUnchanged: true,
    restartPersistence: true,
    accessControl: { root: "0700", directories: "0700", files: "0600" },
    sameUserConcurrentReplacementBoundary: "out_of_scope_v1",
  };
  const darwinRuntime = {
    platform: "darwin",
    clientInitializeProtocolVersion: "2025-11-25",
    serverInitializeProtocolVersion: "2025-06-18",
    serverInfo: { name: "cua-driver", version: "0.8.3" },
    toolsListCanonicalSha256: digest,
    healthSchemaVersion: "1",
    healthProbeSkip: [...FROZEN_HEALTH_SKIP],
    healthCoreChecks: { binaryVersion: "pass", platformSupported: "pass", sessionActive: "pass" },
    managedDeniedTools: [...FROZEN_DENIED_TOOLS],
    stdinEof: "passed",
    managedState,
  };
  assert.equal(verifyRuntimeProbe("darwin", darwinRuntime, lock), darwinRuntime);
  for (const [mutate, pattern] of [
    [(value) => { value.serverInfo.version = "0.8.2"; }, /server identity mismatch/],
    [(value) => { value.toolsListCanonicalSha256 = "bad"; }, /tools-list digest/],
    [(value) => { value.healthCoreChecks.binaryVersion = "fail"; }, /health core-check evidence/],
    [(value) => { value.managedDeniedTools = []; }, /managed denied tools mismatch/],
    [(value) => { value.managedState.accessControl.files = "0644"; }, /managed-state acceptance/],
    [(value) => { value.unexpected = true; }, /runtime probe keys changed/],
  ]) {
    const value = structuredClone(darwinRuntime);
    mutate(value);
    assert.throws(() => verifyRuntimeProbe("darwin", value, lock), pattern);
  }

  const windowsRuntime = {
    ...structuredClone(darwinRuntime),
    platform: "win32-x64",
    managedState: {
      ...structuredClone(managedState),
      accessControl: {
        root: "current_user_only_protected_dacl",
        directories: "current_user_only_protected_dacl",
        files: "current_user_only_protected_dacl",
      },
    },
    managedReadiness: {
      schemaVersion: 1,
      readinessSequence: 1,
      activeChildPidBound: true,
      childInstanceNonceBound: true,
      leaseGenerationBound: true,
      sameInteractiveSession: true,
      hostIntegrityLevel: "medium",
      providerIntegrityLevel: "medium",
      inputDesktop: "default_unlocked",
      jobObjectAssigned: true,
      killOnJobClose: true,
      uiaRuntime: "available",
      d3d11: "available",
      wgcApi: "supported",
      contentObserved: false,
    },
  };
  assert.equal(verifyRuntimeProbe("win32-x64", windowsRuntime, lock), windowsRuntime);
  const wrongReadiness = structuredClone(windowsRuntime);
  wrongReadiness.managedReadiness.readinessSequence = 2;
  assert.throws(() => verifyRuntimeProbe("win32-x64", wrongReadiness, lock), /managed-readiness evidence mismatch/);
  assert.equal("readinessSequence" in stableRuntimeProbe(windowsRuntime, "win32-x64").managedReadiness, false);

  const binaries = [{
    relativePath: "darwin/cua-driver",
    role: "main",
    packaged: true,
    sha256BeforeSigning: "2".repeat(64),
  }];
  const binaryIdentity = { binaries: [{ role: "main", format: "fixture" }] };
  const attestation = {
    platform: "darwin",
    providerLockSha256: "3".repeat(64),
    sourceBuildInputsSha256: "4".repeat(64),
    binaries,
    checks: { binaryIdentity, versionOutput: "cua-driver 0.8.3" },
    supplyChain: { sbomSha256: "8".repeat(64), noticesSha256: "9".repeat(64) },
  };
  const promotion = {
    schemaVersion: 1,
    kind: "ling.cua-driver.source-build-promotion-inputs",
    promotionEligible: false,
    platform: "darwin",
    providerLockSha256: attestation.providerLockSha256,
    sourceBuildInputsSha256: attestation.sourceBuildInputsSha256,
    sourceBuild: {
      cargoLockSha256: verified.sourceInputs.upstreamBuild.cargoLockSha256,
      rustcVersion: verified.sourceInputs.toolchain.rustcVersion,
      cargoVersion: verified.sourceInputs.toolchain.cargoVersion,
      patchSet: {
        id: verified.series.id,
        sha256: verified.seriesSha256,
        patches: verified.series.patches,
        touchedPaths: verified.series.touchedPaths,
      },
      binaryIdentity,
      versionOutput: "cua-driver 0.8.3",
      clientInitializeProtocolVersion: "2025-11-25",
      serverInitializeProtocolVersion: "2025-06-18",
      toolsListCanonicalSha256: digest,
      healthSchemaVersion: "1",
      healthProbeSkip: [...FROZEN_HEALTH_SKIP],
      healthCoreChecks: structuredClone(darwinRuntime.healthCoreChecks),
      managedDeniedTools: [...FROZEN_DENIED_TOOLS],
      binariesSha256BeforeSigning: { main: binaries[0].sha256BeforeSigning },
    },
    providerSealInputs: {
      componentId: "cua-driver-darwin",
      lockSha256: attestation.providerLockSha256,
      distributionRevision: lock.distributionRevision,
      providerVersion: lock.upstream.version,
      serverInitializeProtocolVersion: "2025-06-18",
      healthSchemaVersion: "1",
      toolsListCanonicalSha256: digest,
      stateSchemaVersion: lock.runtime.stateSchemaVersion,
      binaries,
    },
    supplyChain: structuredClone(attestation.supplyChain),
    runtimeProbe: stableRuntimeProbe(darwinRuntime, "darwin"),
    missingFinalIdentity: ["cdhashes", "codeIdentifier", "teamId", "designatedRequirement", "entitlementsCanonicalSha256"],
  };
  const verify = (value) => verifyPromotionBindings({
    attestation,
    lock,
    observedBinaryIdentity: binaryIdentity,
    observedVersion: "cua-driver 0.8.3",
    promotion: value,
    runtimeProbe: darwinRuntime,
    verified,
  });
  assert.equal(verify(promotion), true);
  for (const [mutate, pattern] of [
    [(value) => { value.runtimeProbe.stdinEof = "failed"; }, /runtime probe evidence mismatch/],
    [(value) => { value.sourceBuild.binariesSha256BeforeSigning.main = "5".repeat(64); }, /pre-sign binary digest map mismatch/],
    [(value) => { value.sourceBuild.toolsListCanonicalSha256 = "6".repeat(64); }, /source-build tools digest mismatch/],
    [(value) => { value.providerSealInputs.toolsListCanonicalSha256 = "7".repeat(64); }, /not bound to the attestation/],
    [(value) => { value.providerSealInputs.binaries[0].packaged = false; }, /not bound to the attestation/],
    [(value) => { value.schemaVersion = 999; }, /promotion input schema mismatch/],
    [(value) => { value.kind = "attacker.kind"; }, /promotion input schema mismatch/],
    [(value) => { value.sourceBuild.cargoLockSha256 = "0".repeat(64); }, /promotion toolchain bindings mismatch/],
    [(value) => { value.sourceBuild.rustcVersion = "ATTACKER"; }, /promotion toolchain bindings mismatch/],
    [(value) => { value.sourceBuild.cargoVersion = "ATTACKER"; }, /promotion toolchain bindings mismatch/],
    [(value) => { value.sourceBuild.versionOutput = "cua-driver 0.8.4"; }, /built provider version evidence mismatch/],
    [(value) => { value.sourceBuild.patchSet.id = "attacker"; }, /promotion patch-set bindings mismatch/],
    [(value) => { value.missingFinalIdentity = []; }, /promotion missing-final-identity bindings mismatch/],
    [(value) => { value.unexpected = true; }, /promotion inputs keys changed/],
  ]) {
    const value = structuredClone(promotion);
    mutate(value);
    assert.throws(() => verify(value), pattern);
  }
  assert.equal(
    verifyProviderSealInputs("darwin", promotion.providerSealInputs, attestation, darwinRuntime, lock),
    undefined,
  );
});

test("canonical JSON tool-list hashing is key-order independent", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: false, c: 1 } }), canonicalJson({ a: { c: 1, d: false }, b: 2 }));
  const alpha = {
    name: "alpha",
    description: "Alpha",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    capabilities: { ignored: true },
  };
  const zeta = {
    name: "zeta",
    description: "Zeta",
    inputSchema: { type: "object", properties: { value: { type: "string" } } },
    annotations: { readOnlyHint: false },
    unexpected: "ignored",
  };
  assert.deepEqual(canonicalizeToolsList({ capability_version: "ignored", tools: [zeta, alpha] }), [
    {
      name: "alpha",
      description: "Alpha",
      inputSchema: alpha.inputSchema,
      annotations: alpha.annotations,
    },
    {
      name: "zeta",
      description: "Zeta",
      inputSchema: zeta.inputSchema,
      annotations: zeta.annotations,
    },
  ]);
  assert.throws(() => canonicalizeToolsList({ tools: [alpha, alpha] }), /duplicate raw tool names/);
});

test("runtime probe starts with MCP initialize and waits for stdin EOF closure", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "ling-cua-probe-state-"));
  const requests = [];
  try {
    const result = await probeCuaDriverProvider({
      binaryPath: "fake-provider",
      platform: "darwin",
      stateHome,
      timeoutMs: 1_000,
      spawnProcess: createFakeProviderSpawner(requests),
      performStateAcceptance: false,
    });
    assert.equal(result.clientInitializeProtocolVersion, "2025-11-25");
    assert.equal(result.serverInitializeProtocolVersion, "2025-06-18");
    assert.deepEqual(result.serverInfo, { name: "cua-driver", version: "0.8.3" });
    assert.equal(result.healthSchemaVersion, "1");
    assert.deepEqual(result.healthProbeSkip, FROZEN_HEALTH_SKIP);
    assert.deepEqual(result.managedDeniedTools, FROZEN_DENIED_TOOLS);
    assert.deepEqual(result.healthCoreChecks, {
      binaryVersion: "pass",
      platformSupported: "pass",
      sessionActive: "pass",
    });
    assert.equal(result.stdinEof, "passed");
    assert.deepEqual(
      requests.map((request) => request.method),
      ["initialize", "notifications/initialized", "tools/list", "tools/call"],
    );
    assert.equal(requests[0].params.protocolVersion, "2025-11-25");
    assert.deepEqual(requests.at(-1).params.arguments.skip, FROZEN_HEALTH_SKIP);
  } finally {
    await rm(stateHome, { recursive: true, force: true });
  }
});

test("runtime probe decodes split multibyte MCP stdout deterministically", async () => {
  const stateHome = await mkdtemp(join(tmpdir(), "ling-cua-probe-utf8-"));
  const tools = {
    tools: [{
      name: "describe_window",
      description: "Café window",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    }],
  };
  try {
    const result = await probeCuaDriverProvider({
      binaryPath: "fake-provider",
      platform: "darwin",
      stateHome,
      timeoutMs: 1_000,
      spawnProcess: createFakeProviderSpawner([], { tools, splitUtf8ResponseId: 2 }),
      performStateAcceptance: false,
    });
    assert.equal(
      result.toolsListCanonicalSha256,
      sha256Text(canonicalJson(canonicalizeToolsList(tools))),
    );
  } finally {
    await rm(stateHome, { recursive: true, force: true });
  }
});

test("runtime probe rejects server, health, updater, RPC, size, timeout and signal failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-probe-negative-"));
  let index = 0;
  const probe = (options, timeoutMs = 250) => probeCuaDriverProvider({
    binaryPath: "fake-provider",
    platform: "darwin",
    stateHome: join(root, String(index++)),
    timeoutMs,
    spawnProcess: createFakeProviderSpawner([], options),
    performStateAcceptance: false,
  });
  const health = (overrides = {}) => ({
    schema_version: 1,
    driver_version: "0.8.3",
    overall: "ok",
    platform: "darwin",
    checks: [
      { name: "binary_version", status: "pass" },
      { name: "platform_supported", status: "pass" },
      { name: "session_active", status: "pass" },
      ...FROZEN_HEALTH_SKIP.map((name) => ({ name, status: "skip" })),
    ],
    ...overrides,
  });
  try {
    await assert.rejects(probe({ serverInfo: { name: "cua-driver", version: "0.8.2" } }), /server identity mismatch/);
    await assert.rejects(probe({ healthReport: health({ overall: "error" }) }), /identity or overall status mismatch/);
    const failedHealth = health();
    failedHealth.checks[0].status = "fail";
    await assert.rejects(probe({ healthReport: failedHealth }), /core check did not pass/);
    await assert.rejects(probe({
      tools: {
        tools: [{
          name: FROZEN_DENIED_TOOLS[0],
          description: "Updater",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        }],
      },
    }), /denied updater tool/);
    await assert.rejects(probe({ duplicateResponseId: 1 }), /duplicate response id/);
    await assert.rejects(probe({
      mutateResponse: (response) => response.id === 1 ? { ...response, jsonrpc: "1.0" } : response,
    }), /invalid JSON-RPC message/);
    await assert.rejects(probe({
      mutateResponse: (response) => response.id === 1 ? { ...response, error: { code: -1 } } : response,
    }), /exactly one of result or error/);
    await assert.rejects(probe({ closeSignal: "SIGTERM" }), /signal=SIGTERM/);
    await assert.rejects(probe({ suppressResponseIds: new Set([1]) }, 20), /timed out after 20ms/);
    await assert.rejects(probe({
      rawStdoutOnInitialize: "x".repeat(4 * 1024 * 1024 + 1),
      suppressResponseIds: new Set([1]),
    }), /response exceeded .* without a delimiter|stdout exceeded/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows runtime probe requires exact live readiness identity and capabilities", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-readiness-probe-"));
  const hostPid = 991;
  const validReadiness = (request, child, overrides = {}) => ({
    schemaVersion: 1,
    childInstanceNonce: request.params.childInstanceNonce,
    leaseGeneration: request.params.leaseGeneration,
    readinessSequence: 1,
    hostProcessId: hostPid,
    hostSessionId: 7,
    hostIntegrityLevel: "medium",
    providerProcessId: child.pid,
    providerSessionId: 7,
    providerIntegrityLevel: "medium",
    inputDesktop: "default_unlocked",
    jobObjectAssigned: true,
    killOnJobClose: true,
    uiaRuntime: "available",
    d3d11: "available",
    wgcApi: "supported",
    contentObserved: false,
    ...overrides,
  });
  try {
    const requests = [];
    const accepted = await probeCuaDriverProvider({
      binaryPath: "fake-provider.exe",
      platform: "win32-x64",
      stateHome: join(root, "accepted"),
      hostPid,
      timeoutMs: 1_000,
      spawnProcess: createFakeProviderSpawner(requests, {
        readiness: (request, child) => validReadiness(request, child),
      }),
      performStateAcceptance: false,
    });
    assert.equal(accepted.managedReadiness.inputDesktop, "default_unlocked");
    assert.equal(accepted.managedReadiness.uiaRuntime, "available");
    assert.equal(accepted.managedReadiness.activeChildPidBound, true);
    assert.equal(accepted.managedReadiness.childInstanceNonceBound, true);
    assert.equal(accepted.managedReadiness.sameInteractiveSession, true);

    for (const [label, overrides] of [
      ["child nonce", { childInstanceNonce: "wrong" }],
      ["lease generation", { leaseGeneration: 2 }],
      ["readiness sequence", { readinessSequence: 2 }],
      ["host pid", { hostProcessId: hostPid + 1 }],
      ["provider pid", { providerProcessId: 4243 }],
      ["zero session", { hostSessionId: 0, providerSessionId: 0 }],
      ["session mismatch", { providerSessionId: 8 }],
      ["host integrity", { hostIntegrityLevel: "high" }],
      ["provider integrity", { providerIntegrityLevel: "unknown" }],
      ["input desktop", { inputDesktop: "locked" }],
      ["job assignment", { jobObjectAssigned: false }],
      ["kill on close", { killOnJobClose: false }],
      ["UIA", { uiaRuntime: "unavailable" }],
      ["D3D11", { d3d11: "unavailable" }],
      ["WGC", { wgcApi: "unsupported" }],
      ["content observed", { contentObserved: true }],
    ]) {
      await assert.rejects(probeCuaDriverProvider({
        binaryPath: "fake-provider.exe",
        platform: "win32-x64",
        stateHome: join(root, label.replaceAll(" ", "-")),
        hostPid,
        timeoutMs: 1_000,
        spawnProcess: createFakeProviderSpawner([], {
          readiness: (request, child) => validReadiness(request, child, overrides),
        }),
        performStateAcceptance: false,
      }), /readiness identity or lifetime invariant failed/, label);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed-state permission evidence is recursive, no-follow and exact", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-managed-permissions-"));
  const stateHome = join(root, "state");
  const telemetry = join(stateHome, "telemetry");
  const config = join(stateHome, "config.json");
  const telemetryFile = join(telemetry, "id");
  try {
    await mkdir(telemetry, { recursive: true, mode: 0o700 });
    await writeFile(config, "{}", { mode: 0o600 });
    await writeFile(telemetryFile, "id", { mode: 0o600 });
    await chmod(stateHome, 0o700);
    await chmod(telemetry, 0o700);
    await chmod(config, 0o600);
    await chmod(telemetryFile, 0o600);
    assert.deepEqual(await verifyManagedStatePermissions({ platform: "darwin", stateHome }), {
      root: "0700",
      directories: "0700",
      files: "0600",
    });

    await chmod(telemetryFile, 0o644);
    await assert.rejects(
      verifyManagedStatePermissions({ platform: "darwin", stateHome }),
      /telemetry\/id=644 expected=600/,
    );
    await chmod(telemetryFile, 0o600);
    const link = join(stateHome, "escape-link");
    await symlink(config, link);
    await verifyLinkUnchanged(link, config, "test link");
    await assert.rejects(
      verifyManagedStatePermissions({ platform: "darwin", stateHome }),
      /contains a link or reparse point/,
    );
    await rm(link);
    await writeFile(link, "replacement", { mode: 0o600 });
    await assert.rejects(verifyLinkUnchanged(link, config, "test link"), /replaced or retargeted/);
    await rm(link);

    const sid = "S-1-5-21-1-2-3-1001";
    const acl = {
      areAccessRulesProtected: true,
      ownerSid: sid,
      currentSid: sid,
      rules: [{
        sid,
        accessControlType: "Allow",
        isInherited: false,
        fileSystemRights: 2_032_127,
      }],
    };
    let inspected = 0;
    assert.deepEqual(await verifyManagedStatePermissions({
      platform: "win32-x64",
      stateHome,
      inspectWindowsAcl: async () => {
        inspected += 1;
        return structuredClone(acl);
      },
    }), {
      root: "current_user_only_protected_dacl",
      directories: "current_user_only_protected_dacl",
      files: "current_user_only_protected_dacl",
    });
    assert.equal(inspected, 4);

    for (const invalid of [
      { ...acl, areAccessRulesProtected: false },
      { ...acl, ownerSid: "S-1-5-18" },
      { ...acl, rules: [{ ...acl.rules[0], isInherited: true }] },
      { ...acl, rules: [{ ...acl.rules[0], fileSystemRights: 1 }] },
      { ...acl, rules: [...acl.rules, { ...acl.rules[0], sid: "S-1-5-18" }] },
    ]) {
      assert.throws(() => validateManagedWindowsAcl(invalid), /ACL .* invariant failed/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source-build inventory rejects extra or relabeled Windows executables", () => {
  const digest = "0".repeat(64);
  const binaries = [
    {
      relativePath: "win32-x64/payload/cua-driver.exe",
      role: "main",
      packaged: true,
      sha256BeforeSigning: digest,
    },
    {
      relativePath: "audit/win32-x64/cua-driver-uia.exe",
      role: "uia-audit",
      packaged: false,
      sha256BeforeSigning: digest,
    },
  ];
  const artifactPaths = [
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "cua-driver.spdx.json",
    "provider-lock.json",
    "source-build-inputs.json",
    "source-build-promotion-inputs.json",
    ...binaries.map((binary) => binary.relativePath),
  ];
  assert.equal(verifySourceBuildArtifactInventory({
    artifactPaths,
    binaries,
    platform: "win32-x64",
    promotionBinaries: structuredClone(binaries),
  }), true);
  assert.throws(
    () => verifySourceBuildArtifactInventory({
      artifactPaths: [...artifactPaths, "win32-x64/payload/cua-driver-uia.exe"],
      binaries,
      platform: "win32-x64",
      promotionBinaries: structuredClone(binaries),
    }),
    /artifact inventory mismatch/,
  );
  const relabeled = structuredClone(binaries);
  relabeled[1].relativePath = "win32-x64/payload/cua-driver-uia.exe";
  relabeled[1].role = "main";
  relabeled[1].packaged = true;
  assert.throws(
    () => verifySourceBuildArtifactInventory({
      artifactPaths,
      binaries: relabeled,
      platform: "win32-x64",
      promotionBinaries: structuredClone(relabeled),
    }),
    /binary path mismatch/,
  );
});

test("Windows developer-shell environment replaces case-insensitive PATH aliases", () => {
  const parsed = parseWindowsEnvironment("Path=C:\\VS\\bin;C:\\Windows\r\nVCToolsVersion=14.44.35211\r\n");
  assert.equal(parsed.Path, "C:\\VS\\bin;C:\\Windows");
  const merged = mergeEnvironment({ PATH: "stale", HOME: "home" }, parsed, true);
  assert.equal(merged.Path, parsed.Path);
  assert.equal("PATH" in merged, false);
  assert.equal(merged.HOME, "home");
});

test("supply-chain metadata is deterministic and orders the locked Cargo graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-supply-chain-"));
  try {
    const cargoMetadata = {
      packages: [
        { name: "zeta", version: "1.0.0", license: "MIT", source: "registry+https://example.invalid/index" },
        { name: "alpha", version: "2.0.0", license: "Apache-2.0", repository: "https://example.invalid/alpha" },
      ],
    };
    const lock = {
      distributionRevision: "ling.1",
      patchSet: { sha256: "1".repeat(64) },
      upstream: {
        commit: "2".repeat(40),
        sourceDateEpoch: 1_784_158_114,
        version: "0.8.3",
      },
    };
    const firstRoot = join(root, "first");
    const secondRoot = join(root, "second");
    const first = await generateSupplyChainMetadata({
      cargoMetadata,
      lock,
      outputRoot: firstRoot,
      platform: "darwin",
    });
    const second = await generateSupplyChainMetadata({
      cargoMetadata,
      lock,
      outputRoot: secondRoot,
      platform: "darwin",
    });
    assert.equal(first.sbomSha256, second.sbomSha256);
    assert.equal(first.noticesSha256, second.noticesSha256);
    const sbom = JSON.parse(await readFile(first.sbomPath, "utf8"));
    assert.deepEqual(sbom.packages.map((pkg) => pkg.name), ["alpha", "zeta"]);
    assert.equal(sbom.creationInfo.created, new Date(lock.upstream.sourceDateEpoch * 1_000).toISOString());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function referencePeEvidence(member, role, sizeBytes, sha256, uiAccess, manifestSha256) {
  return {
    member,
    role,
    sizeBytes,
    sha256,
    format: "PE32+",
    machine: "0x8664",
    architecture: "x86_64",
    embeddedCertificateTablePresent: false,
    manifest: {
      sha256: manifestSha256,
      executionLevel: "asInvoker",
      uiAccess,
    },
  };
}

function makeUniversalMachO({ minimumOSVersion, sdkVersion }) {
  const sliceSize = 56;
  const firstOffset = 48;
  const secondOffset = firstOffset + sliceSize;
  const buffer = Buffer.alloc(secondOffset + sliceSize);
  buffer.writeUInt32BE(0xcafebabe, 0);
  buffer.writeUInt32BE(2, 4);
  for (const [index, cpuType, offset] of [
    [0, 0x0100000c, firstOffset],
    [1, 0x01000007, secondOffset],
  ]) {
    const entry = 8 + index * 20;
    buffer.writeUInt32BE(cpuType, entry);
    buffer.writeUInt32BE(offset, entry + 8);
    buffer.writeUInt32BE(sliceSize, entry + 12);
    buffer.writeUInt32LE(0xfeedfacf, offset);
    buffer.writeUInt32LE(cpuType, offset + 4);
    buffer.writeUInt32LE(0x2, offset + 12);
    buffer.writeUInt32LE(1, offset + 16);
    buffer.writeUInt32LE(24, offset + 20);
    buffer.writeUInt32LE(0x32, offset + 32);
    buffer.writeUInt32LE(24, offset + 36);
    buffer.writeUInt32LE(1, offset + 40);
    buffer.writeUInt32LE(packAppleVersion(minimumOSVersion), offset + 44);
    buffer.writeUInt32LE(packAppleVersion(sdkVersion), offset + 48);
  }
  return buffer;
}

function makeThinMachO(payloadByte) {
  const buffer = Buffer.alloc(64, payloadByte);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(0x0100000c, 4);
  buffer.writeUInt32LE(0x2, 12);
  buffer.writeUInt32LE(1, 16);
  buffer.writeUInt32LE(24, 20);
  buffer.writeUInt32LE(0x1b, 32);
  buffer.writeUInt32LE(24, 36);
  return buffer;
}

function packAppleVersion([major, minor, patch]) {
  return (major << 16) | (minor << 8) | patch;
}

function createFakeProviderSpawner(requests, options = {}) {
  return (binaryPath) => {
    const child = new EventEmitter();
    child.pid = options.childPid ?? 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = "";
    const writeResponse = (response) => {
      const value = typeof options.mutateResponse === "function"
        ? options.mutateResponse(structuredClone(response))
        : response;
      const encoded = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
      const multibyteSplit = options.splitUtf8ResponseId === value.id
        ? encoded.findIndex((byte, index) => byte >= 0xc2 && byte <= 0xf4 && index + 1 < encoded.length) + 1
        : 0;
      if (multibyteSplit > 0) {
        child.stdout.write(encoded.subarray(0, multibyteSplit));
        child.stdout.write(encoded.subarray(multibyteSplit));
      } else {
        child.stdout.write(encoded);
      }
      if (options.duplicateResponseId === value.id) {
        child.stdout.write(encoded);
      }
    };
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        input += chunk.toString("utf8");
        let newline;
        while ((newline = input.indexOf("\n")) >= 0) {
          const line = input.slice(0, newline).trim();
          input = input.slice(newline + 1);
          if (!line) continue;
          const request = JSON.parse(line);
          requests.push(request);
          if (request.id === 1 && typeof options.rawStdoutOnInitialize === "string") {
            child.stdout.write(options.rawStdoutOnInitialize);
          }
          if (options.suppressResponseIds?.has(request.id)) continue;
          if (request.id === 1) {
            writeResponse({
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: options.serverProtocolVersion ?? "2025-06-18",
                capabilities: {},
                serverInfo: options.serverInfo ?? { name: "cua-driver", version: "0.8.3" },
              },
            });
          } else if (request.id === 2) {
            writeResponse({ jsonrpc: "2.0", id: 2, result: options.tools ?? { tools: [] } });
          } else if (request.id === 3) {
            writeResponse({
              jsonrpc: "2.0",
              id: 3,
              result: {
                structuredContent: options.healthReport ?? {
                  schema_version: 1,
                  driver_version: "0.8.3",
                  overall: "ok",
                  platform: String(binaryPath).endsWith(".exe") ? "win32" : "darwin",
                  checks: [
                    { name: "binary_version", status: "pass" },
                    { name: "platform_supported", status: "pass" },
                    { name: "session_active", status: "pass" },
                    ...FROZEN_HEALTH_SKIP.map((name) => ({ name, status: "skip" })),
                  ],
                },
              },
            });
          } else if (request.id === 4) {
            writeResponse({
              jsonrpc: "2.0",
              id: 4,
              result: typeof options.readiness === "function"
                ? options.readiness(request, child)
                : options.readiness,
            });
          }
        }
        callback();
      },
      final(callback) {
        callback();
        queueMicrotask(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit("exit", options.closeCode ?? 0, options.closeSignal ?? null);
          child.emit("close", options.closeCode ?? 0, options.closeSignal ?? null);
        });
      },
    });
    child.kill = () => true;
    return child;
  };
}

async function copyResources() {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-resource-fixture-"));
  const destination = join(root, "provider");
  await cp(PROVIDER_RESOURCE_ROOT, destination, { recursive: true });
  return destination;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function runNode(args) {
  try {
    const result = await execFile(process.execPath, args, { maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: `${error.stderr ?? ""}${error.message ?? ""}` };
  }
}
