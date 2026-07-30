import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runOwnedProcess } from "./cua-driver-owned-process.mjs";

const execFile = promisify(execFileCallback);
const LING_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export const PROVIDER_VERSION_DIR = "0.8.3-ling.1";
export const PROVIDER_RESOURCE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../resources/providers/cua-driver",
  PROVIDER_VERSION_DIR,
);

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const LOCKED_NEW_RUST_FILES = [
  "libs/cua-driver/rust/crates/cua-driver-core/src/input_fence.rs",
  "libs/cua-driver/rust/crates/cua-driver-core/src/ling_managed.rs",
  "libs/cua-driver/rust/crates/cua-driver-core/src/ling_managed_readiness.rs",
  "libs/cua-driver/rust/crates/cua-driver/src/ling_managed_lifetime.rs",
  "libs/cua-driver/rust/crates/cua-driver/tests/ling_managed_native.rs",
  "libs/cua-driver/rust/crates/platform-windows/src/ling_managed_capability.rs",
  "libs/cua-driver/rust/crates/platform-windows/src/managed_lifetime.rs",
  "libs/cua-driver/rust/crates/platform-windows/src/managed_readiness.rs",
];

export async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function loadProviderLock(resourceRoot = PROVIDER_RESOURCE_ROOT) {
  const path = join(resourceRoot, "provider-lock.json");
  const sourceInputsPath = join(resourceRoot, "source-build-inputs.json");
  const providerLock = JSON.parse(await readFile(path, "utf8"));
  const sourceInputs = JSON.parse(await readFile(sourceInputsPath, "utf8"));
  return {
    path,
    sourceInputsPath,
    providerLock,
    sourceInputs,
    value: {
      ...providerLock,
      productVersionLabel: sourceInputs.productVersionLabel,
      upstream: { ...providerLock.upstream, ...sourceInputs.upstreamBuild },
      referenceArtifacts: sourceInputs.referenceArtifacts,
      patchSet: sourceInputs.patchSet,
      toolchain: sourceInputs.toolchain,
      sourceBuildPlatforms: sourceInputs.sourceBuildPlatforms,
      platformBuildOutputs: sourceInputs.platformOutputs,
      runtime: sourceInputs.runtime,
      compatibility: sourceInputs.compatibility,
      packagingGate: sourceInputs.packagingGate,
    },
  };
}

export async function loadPatchSeries(resourceRoot, lock) {
  const manifestPath = safeResolve(resourceRoot, lock.patchSet.manifest);
  return {
    manifestPath,
    patchRoot: dirname(manifestPath),
    value: JSON.parse(await readFile(manifestPath, "utf8")),
  };
}

export function parsePatchTouchedPaths(patchText) {
  assert(typeof patchText === "string", "patch text must be a string");
  const observedPaths = new Set();
  let section;

  const finishSection = () => {
    if (!section) return;
    const hasOldMarker = section.oldPath !== undefined;
    const hasNewMarker = section.newPath !== undefined;
    assert(hasOldMarker === hasNewMarker, "patch file markers must include both old and new paths");
    const hasRenameFrom = section.renameFrom !== undefined;
    const hasRenameTo = section.renameTo !== undefined;
    assert(hasRenameFrom === hasRenameTo, "patch rename metadata must include both old and new paths");
    const paths = hasOldMarker
      ? [section.oldPath, section.newPath]
      : hasRenameFrom
        ? [section.renameFrom, section.renameTo]
        : [section.headerOldPath, section.headerNewPath];
    for (const path of paths) {
      if (path !== null) observedPaths.add(path);
    }
  };

  for (const line of patchText.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      finishSection();
      const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
      assert(match, `patch diff header must use canonical unquoted paths: ${line}`);
      section = {
        headerOldPath: validateRepositoryPatchPath(match[1]),
        headerNewPath: validateRepositoryPatchPath(match[2]),
        oldPath: undefined,
        newPath: undefined,
        renameFrom: undefined,
        renameTo: undefined,
      };
      continue;
    }
    if (line.startsWith("--- ")) {
      assert(section, `patch file marker requires a canonical diff header: ${line}`);
      assert(section.oldPath === undefined, `patch diff section has a duplicate old path marker: ${line}`);
      assert(section.newPath === undefined, `patch old path marker follows its new path marker: ${line}`);
      section.oldPath = parsePatchFileMarker(line.slice(4), "a/");
      continue;
    }
    if (line.startsWith("+++ ")) {
      assert(section, `patch file marker requires a canonical diff header: ${line}`);
      assert(section.oldPath !== undefined, `patch new path marker is missing its old path marker: ${line}`);
      assert(section.newPath === undefined, `patch diff section has a duplicate new path marker: ${line}`);
      section.newPath = parsePatchFileMarker(line.slice(4), "b/");
      continue;
    }
    if (!section) continue;
    if (section.renameFrom === undefined && line.startsWith("rename from ")) {
      section.renameFrom = validateRepositoryPatchPath(line.slice("rename from ".length));
      continue;
    }
    if (section.renameTo === undefined && line.startsWith("rename to ")) {
      section.renameTo = validateRepositoryPatchPath(line.slice("rename to ".length));
    }
  }
  finishSection();
  assert(observedPaths.size > 0, "patch does not declare any touched paths");
  return [...observedPaths].sort();
}

export function verifyPatchTouchedPathAllowlist(patchTexts, touchedPaths) {
  assert(Array.isArray(patchTexts) && patchTexts.length > 0, "patch texts must be a non-empty array");
  const observedPaths = [...new Set(patchTexts.flatMap(parsePatchTouchedPaths))].sort();
  assertDeepEqual(observedPaths, touchedPaths, "patch touched-path allowlist");
  return observedPaths;
}

export function parseGitNameStatusTouchedPaths(value) {
  assert(typeof value === "string", "git name-status output must be a string");
  const fields = value.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const observedPaths = new Set();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    assert(/^(?:[RC]\d{1,3}|[ADMTUXB])$/u.test(status), `unexpected staged diff status: ${status}`);
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    assert(index + pathCount <= fields.length, `staged diff status is missing paths: ${status}`);
    for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
      observedPaths.add(validateRepositoryPatchPath(fields[index++]));
    }
  }
  return [...observedPaths].sort();
}

export function parseGitNumstatTouchedPaths(value) {
  assert(typeof value === "string", "git numstat output must be a string");
  const fields = value.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const observedPaths = new Set();
  for (let index = 0; index < fields.length;) {
    const row = fields[index++];
    const match = /^(?:-|\d+)\t(?:-|\d+)\t(.*)$/su.exec(row);
    assert(match, `unexpected git numstat row: ${row}`);
    if (match[1]) {
      observedPaths.add(validateRepositoryPatchPath(match[1]));
      continue;
    }
    assert(index + 2 <= fields.length, "git numstat rename or copy row is missing paths");
    observedPaths.add(validateRepositoryPatchPath(fields[index++]));
    observedPaths.add(validateRepositoryPatchPath(fields[index++]));
  }
  return [...observedPaths].sort();
}

function parsePatchFileMarker(value, prefix) {
  if (value === "/dev/null") return null;
  assert(value.startsWith(prefix), `patch file marker must start with ${prefix} or be /dev/null: ${value}`);
  return validateRepositoryPatchPath(value.slice(prefix.length));
}

function validateRepositoryPatchPath(path) {
  assert(typeof path === "string" && path.length > 0, "patch path is missing");
  assert(!path.startsWith("/"), `patch path must be relative: ${path}`);
  assert(!path.includes("\\"), `patch path must use POSIX separators: ${path}`);
  assert(!path.includes(".."), `patch path contains traversal: ${path}`);
  return path;
}

export async function verifyProviderInputs(resourceRoot = PROVIDER_RESOURCE_ROOT) {
  const {
    path: lockPath,
    sourceInputsPath,
    providerLock,
    sourceInputs,
    value: lock,
  } = await loadProviderLock(resourceRoot);
  verifyDistributionLockV2(providerLock);
  verifySourceBuildInputs(sourceInputs);
  assert(lock.schemaVersion === 2, "provider lock schemaVersion must be 2");
  assert(lock.componentId === "cua-driver", "provider lock componentId changed");
  assert(lock.distributionRevision === "ling.1", "distribution revision changed");
  assert(COMMIT_PATTERN.test(lock.upstream.commit), "upstream commit is not a full SHA-1");
  assert(COMMIT_PATTERN.test(lock.upstream.tree), "upstream tree is not a full SHA-1");
  assertSha(lock.upstream.cargoLockSha256, "Cargo.lock digest");
  assertSha(lock.upstream.licenseSha256, "license digest");
  assert(lock.upstream.tag === "cua-driver-rs-v0.8.3", "upstream tag changed");
  assert(lock.upstream.version === "0.8.3", "upstream version changed");
  assert(lock.upstream.releaseStage === "prerelease", "release stage must remain explicit");

  assert(Array.isArray(lock.enabledPlatforms), "enabledPlatforms must be an array");
  assert(
    lock.packagingGate?.eligible === false,
    "source-build evidence must remain non-promoting",
  );
  assert(lock.platformBuildOutputs.darwin, "source-build inputs must include the darwin platform output");
  assert(lock.platformBuildOutputs.win32X64, "source-build inputs must include the win32-x64 platform output");
  assert(
    lock.platformBuildOutputs.win32X64.uiaPackaged === false,
    "the standard source-build lock must not package cua-driver-uia.exe",
  );
  assert(
    lock.referenceArtifacts.darwin.usage === "reference_only_never_packaged" &&
      lock.referenceArtifacts.win32X64.usage === "reference_only_never_packaged",
    "upstream binaries may only be reference evidence",
  );

  const licensePath = safeResolve(resourceRoot, "LICENSE.md");
  await listFilesRecursively(resourceRoot);
  assert(
    (await sha256File(licensePath)) === lock.upstream.licenseSha256,
    "checked-in upstream license digest does not match provider lock",
  );

  const toolchainPath = safeResolve(resourceRoot, lock.toolchain.rustToolchainFile);
  const toolchainText = await readFile(toolchainPath, "utf8");
  assert(
    toolchainText.includes(`channel = "${lock.toolchain.rustcVersion}"`),
    "rust-toolchain.toml does not pin the locked Rust version",
  );
  for (const target of [
    ...lock.toolchain.darwin.targets,
    lock.toolchain.win32X64.target,
  ]) {
    assert(toolchainText.includes(`"${target}"`), `missing Rust target pin: ${target}`);
  }

  const { manifestPath, patchRoot, value: series } = await loadPatchSeries(resourceRoot, lock);
  assertExactKeys(series, [
    "id",
    "implementationStatus",
    "patches",
    "remainingRuntimeWork",
    "rustfmtPaths",
    "schemaVersion",
    "seriesDigestAlgorithm",
    "seriesSha256",
    "touchedPaths",
    "upstreamCommit",
  ], "patch series");
  assert(series.schemaVersion === 1, "patch series schemaVersion must be 1");
  assert(series.id === lock.patchSet.id, "patch series id does not match provider lock");
  assert(series.upstreamCommit === lock.upstream.commit, "patch series commit does not match lock");
  assert(
    series.seriesDigestAlgorithm === "sha256(id:patchSha256 followed by LF, in manifest order)",
    "patch series digest algorithm changed",
  );
  assert(series.implementationStatus === "runtime_integrated", "patch status must be runtime_integrated");
  assert(
    Array.isArray(series.remainingRuntimeWork) && series.remainingRuntimeWork.length === 0,
    "runtime-integrated patch series cannot leave runtime work unlisted",
  );
  assert(Array.isArray(series.patches) && series.patches.length === 5, "expected five patches");
  assertDeepEqual(
    series.patches.map(({ id, file }) => ({ id, file })),
    [
      { id: "ling-embedded-state-home-v1", file: "0001-ling-embedded-state-home-v1.patch" },
      { id: "ling-managed-readiness-v1", file: "0002-ling-managed-readiness-v1.patch" },
      { id: "ling-managed-lifetime-v1", file: "0003-ling-managed-lifetime-v1.patch" },
      { id: "ling-windows-capability-errors-v1", file: "0004-ling-windows-capability-errors-v1.patch" },
      { id: "ling-provider-input-fence-v1", file: "0005-ling-provider-input-fence-v1.patch" },
    ],
    "patch order and identity",
  );
  assertSortedUnique(series.touchedPaths, "patch touchedPaths");
  assertSortedUnique(series.rustfmtPaths, "patch rustfmtPaths");
  assertDeepEqual(series.rustfmtPaths, LOCKED_NEW_RUST_FILES, "locked new Rust file allowlist");
  for (const path of series.rustfmtPaths) {
    assert(series.touchedPaths.includes(path), `rustfmt path is not touched by the patch series: ${path}`);
  }

  const digestRows = [];
  const patchTexts = [];
  for (const patch of series.patches) {
    assert(typeof patch.id === "string" && patch.id.length > 0, "patch id is missing");
    assertSha(patch.sha256, `patch ${patch.id} digest`);
    const patchPath = safeResolve(patchRoot, patch.file);
    assert(dirname(patchPath) === patchRoot, `patch escapes patch root: ${patch.file}`);
    const observedSha = await sha256File(patchPath);
    assert(observedSha === patch.sha256, `patch digest mismatch: ${patch.file}`);
    digestRows.push(`${patch.id}:${observedSha}`);
    const patchText = await readFile(patchPath, "utf8");
    assertDeepEqual(
      parsePatchTouchedPaths(patchText),
      parseGitNumstatTouchedPaths(
        await runText("git", ["apply", "--numstat", "-z", patchPath], { cwd: LING_REPOSITORY_ROOT }),
      ),
      `patch parser Git oracle: ${patch.file}`,
    );
    patchTexts.push(patchText);
  }
  const seriesSha256 = sha256Text(`${digestRows.join("\n")}\n`);
  assert(seriesSha256 === series.seriesSha256, "patch series digest mismatch");
  assert(seriesSha256 === lock.patchSet.sha256, "provider lock patch digest mismatch");
  verifyPatchTouchedPathAllowlist(patchTexts, series.touchedPaths);

  return {
    lockPath,
    sourceInputsPath,
    providerLock,
    sourceInputs,
    manifestPath,
    resourceRoot,
    lock,
    series,
    seriesSha256,
  };
}

export function verifyDistributionLockV2(value) {
  assertExactKeys(value, ["componentId", "distributionRevision", "enabledPlatforms", "platforms", "schemaVersion", "upstream"], "provider lock");
  assert(value.schemaVersion === 2, "provider lock schemaVersion must be 2");
  assert(value.componentId === "cua-driver", "provider lock componentId changed");
  assert(value.distributionRevision === "ling.1", "provider lock distributionRevision changed");
  assertExactKeys(value.upstream, ["commit", "license", "licenseSha256", "releaseStage", "repository", "tag", "tree", "version"], "provider lock upstream");
  assert(value.upstream.repository === "https://github.com/trycua/cua", "provider lock repository changed");
  assert(value.upstream.tag === "cua-driver-rs-v0.8.3", "provider lock tag changed");
  assert(value.upstream.commit === "0612c26b2c7b8556f6de7f6b4f3927ecac914e4f", "provider lock commit changed");
  assert(value.upstream.tree === "831819eaf2b79c4d81c2b68773cd5920772e91e9", "provider lock tree changed");
  assert(value.upstream.version === "0.8.3", "provider lock version changed");
  assert(value.upstream.releaseStage === "prerelease", "provider lock release stage changed");
  assert(value.upstream.license === "MIT", "provider lock license changed");
  assertSha(value.upstream.licenseSha256, "provider lock license digest");
  assert(Array.isArray(value.enabledPlatforms), "provider lock enabledPlatforms must be an array");
  for (const platform of value.enabledPlatforms) {
    assert(platform === "darwin" || platform === "win32-x64", `invalid enabled platform: ${platform}`);
    const key = platform === "darwin" ? "darwin" : "win32X64";
    assert(value.platforms[key], `enabled platform is missing its lock record: ${platform}`);
  }
  assertExactKeys(
    value.platforms,
    value.enabledPlatforms.map((platform) => platform === "darwin" ? "darwin" : "win32X64"),
    "provider lock platforms",
  );
  return true;
}

function verifySourceBuildInputs(value) {
  assertExactKeys(value, [
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
  ], "source-build inputs");
  assert(value.schemaVersion === 1, "source-build inputs schemaVersion must be 1");
  assert(value.componentId === "cua-driver-source-build", "source-build input component changed");
  assert(value.distributionRevision === "ling.1", "source-build distribution revision changed");
  assert(value.productVersionLabel === "0.8.3 (Ling build 1)", "source-build product label changed");
  assert(value.providerLockRelativePath === "provider-lock.json", "source-build provider lock path changed");
  assertExactKeys(value.upstreamBuild, ["cargoLockSha256", "licensePath", "sourceDateEpoch", "workspaceRoot"], "source-build upstream");
  assert(Number.isSafeInteger(value.upstreamBuild.sourceDateEpoch) && value.upstreamBuild.sourceDateEpoch > 0, "source date epoch is invalid");
  assert(value.upstreamBuild.workspaceRoot === "libs/cua-driver/rust", "source-build workspace root changed");
  assertSha(value.upstreamBuild.cargoLockSha256, "source-build Cargo.lock digest");
  assert(value.upstreamBuild.licensePath === "LICENSE.md", "source-build license path changed");
  assertExactKeys(value.referenceArtifacts, ["darwin", "win32X64"], "source-build reference artifacts");
  assertExactKeys(value.referenceArtifacts.darwin, [
    "authority",
    "binarySha256",
    "binarySizeBytes",
    "entitlements",
    "filename",
    "identifier",
    "member",
    "minimumOSVersion",
    "runtimeVersion",
    "sdkVersion",
    "sha256",
    "sizeBytes",
    "teamId",
    "usage",
  ], "darwin reference artifact");
  assertExactKeys(value.referenceArtifacts.win32X64, [
    "filename",
    "mainManifestSha256",
    "mainMember",
    "mainSha256",
    "mainSizeBytes",
    "sha256",
    "sizeBytes",
    "uiaManifestSha256",
    "uiaMember",
    "uiaSha256",
    "uiaSizeBytes",
    "usage",
  ], "Windows reference artifact");
  assert(value.referenceArtifacts.darwin.filename === "cua-driver-rs-0.8.3-darwin-universal-binary.tar.gz", "darwin reference filename changed");
  assert(value.referenceArtifacts.darwin.sizeBytes === 15320898, "darwin reference size changed");
  assert(value.referenceArtifacts.darwin.sha256 === "a2a29f3ccbd45989819df639d60fa68ac6f28b844f74d7d2b0a1495e4359c6a1", "darwin reference digest changed");
  assert(value.referenceArtifacts.darwin.member === "cua-driver", "darwin reference member changed");
  assert(value.referenceArtifacts.darwin.binarySizeBytes === 42324640, "darwin reference binary size changed");
  assert(value.referenceArtifacts.darwin.binarySha256 === "c1c015ccceda4880b9e171dc438700a8276af0eeecfdf0bb4b3fb23298ae7305", "darwin reference binary digest changed");
  assert(value.referenceArtifacts.darwin.minimumOSVersion === "13.0", "darwin reference minimum OS changed");
  assert(value.referenceArtifacts.darwin.sdkVersion === "26.5", "darwin reference SDK changed");
  assert(value.referenceArtifacts.darwin.identifier === "cua-driver", "darwin reference identifier changed");
  assert(value.referenceArtifacts.darwin.teamId === "YCK386LBJ7", "darwin reference Team ID changed");
  assert(value.referenceArtifacts.darwin.authority === "Developer ID Application: Cua AI, Inc. (YCK386LBJ7)", "darwin reference authority changed");
  assert(value.referenceArtifacts.darwin.runtimeVersion === "26.5.0", "darwin reference runtime changed");
  assertDeepEqual(value.referenceArtifacts.darwin.entitlements, {
    "com.apple.security.automation.apple-events": true,
    "com.apple.security.device.screen-capture": true,
  }, "darwin reference entitlements");
  assert(value.referenceArtifacts.win32X64.filename === "cua-driver-rs-0.8.3-windows-x86_64.zip", "Windows reference filename changed");
  assert(value.referenceArtifacts.win32X64.sizeBytes === 10585087, "Windows reference size changed");
  assert(value.referenceArtifacts.win32X64.sha256 === "6acdc84b98629fcd0be2368cc16565c18d5f21d9dedd4e10fdb6f58547fce9d0", "Windows reference archive digest changed");
  assert(value.referenceArtifacts.win32X64.mainMember === "cua-driver-rs-0.8.3-windows-x86_64/cua-driver.exe", "Windows main reference member changed");
  assert(value.referenceArtifacts.win32X64.mainSizeBytes === 19417088, "Windows main reference size changed");
  assert(value.referenceArtifacts.win32X64.mainSha256 === "3cc33572defac29e23bc07e211c20245da9f6ebe8e6481f865b31534b1de8cee", "Windows main reference digest changed");
  assert(value.referenceArtifacts.win32X64.mainManifestSha256 === "c9292d0a7640c5a9b7eaa2df68410900a0ebf475b0acee6087a95afb2733de9e", "Windows main reference manifest changed");
  assert(value.referenceArtifacts.win32X64.uiaMember === "cua-driver-rs-0.8.3-windows-x86_64/cua-driver-uia.exe", "Windows UIAccess reference member changed");
  assert(value.referenceArtifacts.win32X64.uiaSizeBytes === 8238592, "Windows UIAccess reference size changed");
  assert(value.referenceArtifacts.win32X64.uiaSha256 === "1b35a27d41008507d66f819248751b9e79a15c9e6e03390c56749c6fe5daca1c", "Windows UIAccess reference digest changed");
  assert(value.referenceArtifacts.win32X64.uiaManifestSha256 === "ade4fdc1fa2c2227deef697e3867f0ca1e20a478fcc1564103562f1683161ed7", "Windows UIAccess reference manifest changed");
  assertExactKeys(value.patchSet, ["id", "implementationStatus", "manifest", "sha256"], "source-build patch set");
  assert(value.patchSet.id === "ling-managed-embedded-v1", "source-build patch id changed");
  assert(value.patchSet.implementationStatus === "runtime_integrated", "source-build patch status changed");
  assertSha(value.patchSet.sha256, "source-build patch digest");
  assertExactKeys(value.toolchain, ["cargoVersion", "darwin", "rustToolchainFile", "rustcVersion", "win32X64"], "source-build toolchain");
  assertExactKeys(value.toolchain.darwin, ["deploymentTarget", "developerDir", "macOSSDKVersion", "postLinkIdentityNormalization", "runner", "swiftArchiveNormalization", "targets", "xcodeBuildVersion", "xcodeVersion"], "darwin toolchain");
  assertExactKeys(value.toolchain.win32X64, ["msvcToolsetVersion", "runner", "target", "visualStudioVersion", "windowsSdkVersion"], "Windows toolchain");
  assert(value.toolchain.rustcVersion === "1.97.1" && value.toolchain.cargoVersion === "1.97.1", "Rust toolchain version changed");
  assert(value.toolchain.darwin.runner === "ling-cua-driver-macos-arm64-v1", "darwin runner changed");
  assert(value.toolchain.darwin.developerDir === "/Applications/Xcode.app/Contents/Developer", "Xcode developer directory changed");
  assert(value.toolchain.darwin.xcodeVersion === "26.6" && value.toolchain.darwin.xcodeBuildVersion === "17F113", "Xcode pin changed");
  assert(value.toolchain.darwin.macOSSDKVersion === "26.5" && value.toolchain.darwin.deploymentTarget === "13.0", "macOS SDK pin changed");
  assertDeepEqual(value.toolchain.darwin.targets, ["aarch64-apple-darwin"], "darwin Rust targets");
  assertDeepEqual(value.toolchain.darwin.swiftArchiveNormalization, {
    section: "__LLVM,__swift_modhash",
    dwarfSegment: "__DWARF",
    finalMetadata: "ling-cua-final-v1",
    finalRelink: {
      strategy: "bounded-canonical-source-identity-v1",
      cleanPackage: "cua-driver",
      targets: {
        "aarch64-apple-darwin": {
          expectedSourceSha256: "e79f3c696c623aaa18074f44d668416018525c8b1ffb8d262bf1fd77e1ade99a",
          maxAttempts: 32,
        },
      },
    },
    linkerFlags: ["-reproducible"],
    archives: [
      { archive: "libapple_cf.rlib", machoMembers: 19, normalizedSections: 13, normalizedDwarfSections: 130 },
      { archive: "libscreencapturekit.rlib", machoMembers: 21, normalizedSections: 10, normalizedDwarfSections: 100 },
    ],
  }, "darwin Swift archive normalization");
  assertDeepEqual(value.toolchain.darwin.postLinkIdentityNormalization, {
    algorithm: "sha256-zeroed-lc-uuid-and-code-signature-v1",
    adHocIdentifier: "ling-cua-driver-presign",
    codesignPath: "/usr/bin/codesign",
  }, "darwin post-link identity normalization");
  assert(value.toolchain.win32X64.runner === "ling-cua-driver-windows-x64-v1", "Windows runner changed");
  assert(value.toolchain.win32X64.visualStudioVersion === "17.14.37502.11", "Visual Studio pin changed");
  assert(value.toolchain.win32X64.msvcToolsetVersion === "14.44.35211", "MSVC toolset pin changed");
  assert(value.toolchain.win32X64.windowsSdkVersion === "10.0.26100.0", "Windows SDK pin changed");
  assert(value.toolchain.win32X64.target === "x86_64-pc-windows-msvc", "Windows Rust target changed");
  assertDeepEqual(value.sourceBuildPlatforms, ["darwin", "win32-x64"], "source-build platforms");
  assertExactKeys(value.platformOutputs, ["darwin", "win32X64"], "source-build platform outputs");
  assertExactKeys(value.platformOutputs.darwin, ["architectures", "artifactRelativePath", "binarySha256BeforeSigning", "status"], "darwin platform output");
  assertExactKeys(value.platformOutputs.win32X64, ["architecture", "artifactRelativePath", "auditArtifactRelativePath", "mainSha256BeforeSigning", "status", "uiaAuditSha256BeforeSigning", "uiaPackaged"], "Windows platform output");
  assertDeepEqual(value.platformOutputs.darwin.architectures, ["arm64"], "darwin platform architectures");
  assert(value.platformOutputs.darwin.binarySha256BeforeSigning === null, "darwin digest must remain unset before native evidence");
  assert(value.platformOutputs.win32X64.mainSha256BeforeSigning === null, "Windows main digest must remain unset before native evidence");
  assert(value.platformOutputs.win32X64.uiaAuditSha256BeforeSigning === null, "Windows audit digest must remain unset before native evidence");
  assert(value.platformOutputs.win32X64.uiaPackaged === false, "UIAccess helper cannot enter the packaged payload");
  assertExactKeys(value.runtime, [
    "args",
    "childInstanceNonceEnvironmentVariable",
    "contentObserved",
    "defaultIntegrityCoverage",
    "hostProcessIdEnvironmentVariable",
    "inputEpochEnvironmentVariable",
    "inputFenceAdmission",
    "inputFencePortEnvironmentVariable",
    "inputFenceProtocolVersion",
    "inputFenceTokenEnvironmentVariable",
    "healthProbeSkip",
    "killOnJobCloseRequired",
    "leaseGenerationEnvironmentVariable",
    "limitations",
    "managedReadinessChangedNotification",
    "managedReadinessMethod",
    "managedDeniedTools",
    "managedUpdaterToolsAllowed",
    "readinessHeartbeatMs",
    "requiredHostIntegrityLevel",
    "requiredProviderIntegrityLevel",
    "startupUpdateCheckEnabled",
    "stateHomeEnvironmentVariable",
    "stateSchemaVersion",
    "telemetryEnabled",
    "uiaHelperActivation",
  ], "source-build runtime");
  assert(value.runtime.contentObserved === false, "managed readiness must remain content-free");
  assert(value.runtime.inputFencePortEnvironmentVariable === "CUA_DRIVER_INPUT_FENCE_PORT", "input fence port env changed");
  assert(value.runtime.inputFenceTokenEnvironmentVariable === "CUA_DRIVER_INPUT_FENCE_TOKEN", "input fence token env changed");
  assert(value.runtime.inputEpochEnvironmentVariable === "CUA_DRIVER_INPUT_EPOCH", "input epoch env changed");
  assert(value.runtime.inputFenceProtocolVersion === 1, "input fence protocol changed");
  assert(value.runtime.inputFenceAdmission === "mutating_tool_call_v1", "input fence admission changed");
  assert(value.runtime.killOnJobCloseRequired === true, "managed Windows lifetime must require KILL_ON_JOB_CLOSE");
  assertDeepEqual(value.runtime.managedDeniedTools, ["check_for_update"], "managed denied updater tools");
  assertDeepEqual(value.runtime.healthProbeSkip, [
    "ax_capability",
    "bundle_identity",
    "screen_capture_capability",
    "tcc_accessibility",
    "tcc_screen_recording",
  ], "source-build health probe skip list");
  assertExactKeys(value.compatibility, ["clientInitializeProtocolVersion", "healthSchemaVersion", "mcpClientSdk", "serverInitializeProtocolVersion", "toolsListSha256"], "source-build compatibility");
  assert(value.compatibility.mcpClientSdk === "@modelcontextprotocol/sdk@1.29.0", "MCP client SDK pin changed");
  assert(value.compatibility.clientInitializeProtocolVersion === "2025-11-25", "MCP client initialize protocol changed");
  assert(value.compatibility.serverInitializeProtocolVersion === "2025-06-18", "MCP server initialize protocol changed");
  assert(value.compatibility.healthSchemaVersion === "1", "health schema version changed");
  assert(value.compatibility.toolsListSha256 === null, "tools digest must remain unset before native evidence");
  assertExactKeys(value.packagingGate, ["eligible", "reasons"], "source-build packaging gate");
  assert(value.packagingGate.eligible === false, "source-build packaging gate must remain closed");
  assert(Array.isArray(value.packagingGate.reasons) && value.packagingGate.reasons.length > 0, "source-build packaging blockers are missing");
}

export async function verifySourceCheckout(sourceRoot, verifiedInputs) {
  const { lock } = verifiedInputs;
  const commit = await runText("git", ["rev-parse", "HEAD"], { cwd: sourceRoot });
  const tree = await runText("git", ["rev-parse", "HEAD^{tree}"], { cwd: sourceRoot });
  assert(commit === lock.upstream.commit, `source commit ${commit} does not match lock`);
  assert(tree === lock.upstream.tree, `source tree ${tree} does not match lock`);

  const tagCommit = await runText("git", ["rev-parse", `${lock.upstream.tag}^{commit}`], {
    cwd: sourceRoot,
  });
  assert(tagCommit === lock.upstream.commit, "upstream tag does not resolve to locked commit");

  const cargoLockPath = safeResolve(sourceRoot, `${lock.upstream.workspaceRoot}/Cargo.lock`);
  assert(
    (await sha256File(cargoLockPath)) === lock.upstream.cargoLockSha256,
    "upstream Cargo.lock digest does not match lock",
  );
  const licensePath = safeResolve(sourceRoot, lock.upstream.licensePath);
  assert(
    (await sha256File(licensePath)) === lock.upstream.licenseSha256,
    "upstream license digest does not match lock",
  );
}

export async function acquireSource(sourceRoot, verifiedInputs) {
  const { lock } = verifiedInputs;
  await mkdir(dirname(sourceRoot), { recursive: true });
  await run("git", ["init", sourceRoot]);
  await run("git", ["config", "core.autocrlf", "false"], { cwd: sourceRoot });
  await run("git", ["config", "core.eol", "lf"], { cwd: sourceRoot });
  await run("git", ["remote", "add", "origin", lock.upstream.repository], { cwd: sourceRoot });
  await run(
    "git",
    ["fetch", "--depth", "1", "origin", `refs/tags/${lock.upstream.tag}:refs/tags/${lock.upstream.tag}`],
    { cwd: sourceRoot },
  );
  await run("git", ["checkout", "--detach", lock.upstream.commit], { cwd: sourceRoot });
  await verifySourceCheckout(sourceRoot, verifiedInputs);
}

export async function applyPatchSeries(sourceRoot, verifiedInputs) {
  const { resourceRoot, lock, series } = verifiedInputs;
  const { patchRoot } = await loadPatchSeries(resourceRoot, lock);
  for (const patch of series.patches) {
    const patchPath = safeResolve(patchRoot, patch.file);
    await run("git", ["apply", "--check", "--whitespace=error-all", patchPath], { cwd: sourceRoot });
    await run("git", ["apply", "--index", "--whitespace=error-all", patchPath], { cwd: sourceRoot });
  }
  const touched = parseGitNameStatusTouchedPaths(
    await runText(
      "git",
      ["diff", "--cached", "--name-status", "-z", "--find-renames", "--diff-filter=ACDMRTUXB", "HEAD"],
      { cwd: sourceRoot },
    ),
  );
  assertDeepEqual(touched, series.touchedPaths, "applied patch touched paths");
}

export async function listFilesRecursively(root) {
  const values = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        assert(entry.name !== ".git", `resource tree must not contain a .git repository: ${path}`);
        await visit(path);
      }
      else if (entry.isFile()) values.push(path);
      else throw new Error(`unexpected non-file output: ${path}`);
    }
  }
  await visit(root);
  return values;
}

export async function artifactDigestMap(root, excludedRelativePaths = new Set(["source-build-attestation.json", "source-build-manifest.json"])) {
  const values = {};
  for (const path of await listFilesRecursively(root)) {
    const relativePath = path.slice(root.length + 1).split(sep).join("/");
    if (excludedRelativePaths.has(relativePath)) continue;
    values[relativePath] = await sha256File(path);
  }
  return values;
}

export function verifySourceBuildArtifactInventory({
  artifactPaths,
  binaries,
  platform,
  promotionBinaries,
}) {
  const expectedBinaries = platform === "darwin"
    ? [{ relativePath: "darwin/ling-cua-driver", role: "main", packaged: true }]
    : platform === "win32-x64"
      ? [
          { relativePath: "win32-x64/payload/ling-cua-driver.exe", role: "main", packaged: true },
          { relativePath: "audit/win32-x64/cua-driver-uia.exe", role: "uia-audit", packaged: false },
        ]
      : undefined;
  assert(expectedBinaries, `unsupported source-build platform: ${platform}`);
  assert(Array.isArray(binaries), "source-build binaries must be an array");
  assert(binaries.length === expectedBinaries.length, "source-build binary count mismatch");
  for (let index = 0; index < expectedBinaries.length; index += 1) {
    const binary = binaries[index];
    const expected = expectedBinaries[index];
    assertExactKeys(
      binary,
      ["packaged", "relativePath", "role", "sha256BeforeSigning"],
      `source-build binary ${index}`,
    );
    assert(binary.relativePath === expected.relativePath, `source-build binary path mismatch: ${binary.relativePath}`);
    assert(binary.role === expected.role, `source-build binary role mismatch: ${binary.role}`);
    assert(binary.packaged === expected.packaged, `source-build binary package flag mismatch: ${binary.relativePath}`);
    assertSha(binary.sha256BeforeSigning, `source-build binary ${binary.relativePath} digest`);
  }
  assertDeepEqual(
    promotionBinaries,
    binaries,
    "promotion and attestation binary inventories",
  );
  const expectedArtifactPaths = [
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "cua-driver.spdx.json",
    "provider-lock.json",
    "source-build-inputs.json",
    "source-build-promotion-inputs.json",
    ...expectedBinaries.map((binary) => binary.relativePath),
  ].sort();
  assertDeepEqual(
    [...artifactPaths].sort(),
    expectedArtifactPaths,
    "source-build artifact inventory",
  );
  return true;
}

export async function run(command, args, options = {}) {
  const {
    ownedProcessTree = false,
    ...processOptions
  } = options;
  if (typeof ownedProcessTree !== "boolean") {
    throw new TypeError("ownedProcessTree must be a boolean");
  }
  try {
    const runner = ownedProcessTree ? runOwnedProcess : execFile;
    return await runner(command, args, {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      ...processOptions,
    });
  } catch (error) {
    const detail = [error.message, error.stdout, error.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed\n${detail}`, { cause: error });
  }
}

export async function runText(command, args, options = {}) {
  const result = await run(command, args, { encoding: "utf8", ...options });
  return result.stdout.trim();
}

export function safeResolve(root, relativePath) {
  assert(typeof relativePath === "string" && relativePath.length > 0, "path is missing");
  assert(!relativePath.includes("\\"), `path must use POSIX separators: ${relativePath}`);
  const absoluteRoot = resolve(root);
  const value = resolve(absoluteRoot, relativePath);
  assert(value === absoluteRoot || value.startsWith(`${absoluteRoot}${sep}`), `path escapes root: ${relativePath}`);
  return value;
}

function assertSha(value, label) {
  assert(SHA256_PATTERN.test(value), `${label} is not a lowercase SHA-256`);
}

function assertExactKeys(value, keys, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assertDeepEqual(actual, expected, `${label} keys`);
}

function assertSortedUnique(values, label) {
  assert(Array.isArray(values) && values.length > 0, `${label} must be a non-empty array`);
  assertDeepEqual(values, [...new Set(values)].sort(), `${label} must be sorted and unique`);
}

function assertDeepEqual(actual, expected, label) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} mismatch\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(actual)}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
