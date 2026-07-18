#!/usr/bin/env node

import { cp, lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import {
  PROVIDER_RESOURCE_ROOT,
  acquireSource,
  artifactDigestMap,
  applyPatchSeries,
  loadProviderLock,
  run,
  runText,
  sha256File,
  verifyProviderInputs,
} from "./cua-driver-source-build-lib.mjs";
import { generateSupplyChainMetadata } from "./cua-driver-source-build-supply-chain.mjs";
import {
  mergeEnvironment,
  verifyToolchain,
} from "./cua-driver-source-build-toolchain.mjs";
import { probeCuaDriverProvider, sha256Text } from "./probe-cua-driver-provider.mjs";

const args = parseArgs(process.argv.slice(2));
const resourceRoot = resolve(args["resource-root"] || PROVIDER_RESOURCE_ROOT);
const platform = args.platform;
if (!platform || !["darwin", "win32-x64"].includes(platform)) {
  usage("--platform must be darwin or win32-x64");
}
if (!args["output-dir"]) usage("--output-dir is required; generated binaries must be explicit");
if (!args["verify-only"] && !args["work-dir"]) {
  usage("--work-dir is required for a native build; build state must have an explicit owner");
}

const outputRoot = resolve(args["output-dir"]);
const workRoot = args["work-dir"]
  ? resolve(args["work-dir"])
  : resolve(dirname(outputRoot), ".ling-cua-driver-verify-only-work");
const sourceRoot = resolve(args["source-dir"] || join(workRoot, "source"));
const targetDirectory = join(workRoot, "cargo-target");
await assertSafeOutputRoot({
  outputRoot,
  resourceRoot,
  sourceRoot,
  targetDirectory,
  workRoot,
});
if (!args["verify-only"]) {
  await assertPathDoesNotExist(sourceRoot, "source checkout");
  await assertPathDoesNotExist(targetDirectory, "Cargo target directory");
}
const { value: lock } = await loadProviderLock(resourceRoot);
const verifiedInputs = await verifyProviderInputs(resourceRoot);
if (args["verify-only"]) {
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      lock: verifiedInputs.lock.upstream,
      patchSet: verifiedInputs.seriesSha256,
      packagingEligible: verifiedInputs.lock.packagingGate.eligible,
    }, null, 2)}\n`,
  );
  process.exit(0);
}

const toolchain = await verifyToolchain(platform, lock);
await acquireSource(sourceRoot, verifiedInputs);
await applyPatchSeries(sourceRoot, verifiedInputs);

const workspace = join(sourceRoot, lock.upstream.workspaceRoot);
const buildEnvValue = buildEnv(sourceRoot, targetDirectory, lock, platform, toolchain.env);
await run(
  "cargo",
  ["+" + lock.toolchain.rustcVersion, "fetch", "--locked", "--manifest-path", join(workspace, "Cargo.toml")],
  buildEnvValue,
);
const rustfmtPaths = verifiedInputs.series.rustfmtPaths;
await run(
  "rustfmt",
  [
    `+${lock.toolchain.rustcVersion}`,
    "--edition",
    "2021",
    "--check",
    ...rustfmtPaths.map((path) => join(sourceRoot, ...path.split("/"))),
  ],
  { cwd: workspace, env: buildEnvValue.env },
);
const testPackages = ["cua-driver-core", "platform-windows", "cua-driver"];
await run(
  "cargo",
  [
    `+${lock.toolchain.rustcVersion}`,
    "test",
    "--locked",
    "--offline",
    "--all-targets",
    "--manifest-path",
    join(workspace, "Cargo.toml"),
    ...testPackages.flatMap((pkg) => ["-p", pkg]),
  ],
  { cwd: workspace, env: buildEnvValue.env },
);
const cargoMetadata = JSON.parse(
  await runText(
    "cargo",
    [
      `+${lock.toolchain.rustcVersion}`,
      "metadata",
      "--locked",
      "--offline",
      "--format-version",
      "1",
      "--manifest-path",
      join(workspace, "Cargo.toml"),
    ],
    { cwd: workspace, env: buildEnvValue.env },
  ),
);
const rustcVersion = await runText("rustc", [`+${lock.toolchain.rustcVersion}`, "--version"], {
  env: buildEnvValue.env,
});
const cargoVersion = await runText("cargo", [`+${lock.toolchain.cargoVersion}`, "--version"], {
  env: buildEnvValue.env,
});

const buildTarget = platform === "darwin" ? [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
] : ["x86_64-pc-windows-msvc"];
for (const target of buildTarget) {
  const packages = platform === "win32-x64" ? ["cua-driver", "cua-driver-uia"] : ["cua-driver"];
  await run(
    "cargo",
    [
      `+${lock.toolchain.rustcVersion}`,
      "build",
      "--locked",
      "--offline",
      "--release",
      "--manifest-path",
      join(workspace, "Cargo.toml"),
      "--target",
      target,
      ...packages.flatMap((pkg) => ["-p", pkg]),
    ],
    { cwd: workspace, env: { ...buildEnvValue.env, CARGO_BUILD_TARGET: target } },
  );
}

// The source builder never deletes an output directory. Requiring a fresh path keeps a
// typo in --output-dir from turning a reproducibility command into a recursive delete.
await mkdir(outputRoot);
if (platform === "darwin") {
  const arm = join(targetDirectory, "aarch64-apple-darwin", "release", "cua-driver");
  const x64 = join(targetDirectory, "x86_64-apple-darwin", "release", "cua-driver");
  const output = join(outputRoot, "darwin", "cua-driver");
  await mkdir(join(outputRoot, "darwin"), { recursive: true });
  await run("xcrun", ["lipo", "-create", arm, x64, "-output", output], {
    env: buildEnvValue.env,
  });
} else {
  const main = join(targetDirectory, "x86_64-pc-windows-msvc", "release", "cua-driver.exe");
  const uia = join(targetDirectory, "x86_64-pc-windows-msvc", "release", "cua-driver-uia.exe");
  await mkdir(join(outputRoot, "win32-x64", "payload"), { recursive: true });
  await mkdir(join(outputRoot, "audit", "win32-x64"), { recursive: true });
  await cp(main, join(outputRoot, "win32-x64", "payload", "cua-driver.exe"));
  await cp(uia, join(outputRoot, "audit", "win32-x64", "cua-driver-uia.exe"));
}

await cp(join(resourceRoot, "provider-lock.json"), join(outputRoot, "provider-lock.json"));
await cp(join(resourceRoot, "source-build-inputs.json"), join(outputRoot, "source-build-inputs.json"));
await cp(join(resourceRoot, "LICENSE.md"), join(outputRoot, "LICENSE.md"));
const supplyChain = await generateSupplyChainMetadata({
  cargoMetadata,
  lock,
  outputRoot,
  platform,
});

const binaries = platform === "darwin"
  ? [{ relativePath: "darwin/cua-driver", role: "main", packaged: true }]
  : [
      { relativePath: "win32-x64/payload/cua-driver.exe", role: "main", packaged: true },
      { relativePath: "audit/win32-x64/cua-driver-uia.exe", role: "uia-audit", packaged: false },
    ];
const binaryEvidence = [];
for (const binary of binaries) {
  const path = join(outputRoot, ...binary.relativePath.split("/"));
  binaryEvidence.push({
    ...binary,
    sha256BeforeSigning: await sha256File(path),
  });
}
const mainBinaryPath = join(
  outputRoot,
  platform === "darwin" ? "darwin/cua-driver" : "win32-x64/payload/cua-driver.exe",
);
const probe = await probeCuaDriverProvider({
  binaryPath: mainBinaryPath,
  platform,
  stateHome: join(workRoot, "probe-state"),
});
const lockSha256 = await sha256File(join(outputRoot, "provider-lock.json"));
const sourceBuildInputsSha256 = await sha256File(join(outputRoot, "source-build-inputs.json"));
const stableRuntimeProbe = {
  initializeProtocolVersion: probe.initializeProtocolVersion,
  toolsListCanonicalSha256: probe.toolsListCanonicalSha256,
  healthSchemaVersion: probe.healthSchemaVersion,
  stdinEof: probe.stdinEof,
  ...(platform === "win32-x64" ? {
    managedReadiness: {
      schemaVersion: probe.managedReadiness.schemaVersion,
      jobObjectAssigned: probe.managedReadiness.jobObjectAssigned,
      killOnJobClose: probe.managedReadiness.killOnJobClose,
      contentObserved: probe.managedReadiness.contentObserved,
    },
  } : {}),
};
const promotionInputs = {
  schemaVersion: 1,
  kind: "ling.cua-driver.source-build-promotion-inputs",
  promotionEligible: false,
  platform,
  providerLockSha256: lockSha256,
  sourceBuildInputsSha256,
  sourceBuild: {
    cargoLockSha256: lock.upstream.cargoLockSha256,
    rustcVersion: rustcVersion.match(/^rustc ([^ ]+)/u)?.[1] ?? rustcVersion,
    cargoVersion: cargoVersion.match(/^cargo ([^ ]+)/u)?.[1] ?? cargoVersion,
    patchSet: {
      id: lock.patchSet.id,
      sha256: verifiedInputs.seriesSha256,
      patches: verifiedInputs.series.patches,
      touchedPaths: verifiedInputs.series.touchedPaths,
    },
    binariesSha256BeforeSigning: Object.fromEntries(
      binaryEvidence.map((binary) => [binary.role, binary.sha256BeforeSigning]),
    ),
    toolsListCanonicalSha256: probe.toolsListCanonicalSha256,
    healthSchemaVersion: probe.healthSchemaVersion,
  },
  providerSealInputs: {
    componentId: platform === "darwin" ? "cua-driver-darwin" : "cua-driver-win32-x64",
    lockSha256,
    distributionRevision: lock.distributionRevision,
    providerVersion: lock.upstream.version,
    serverInitializeProtocolVersion: probe.initializeProtocolVersion,
    healthSchemaVersion: probe.healthSchemaVersion,
    toolsListCanonicalSha256: probe.toolsListCanonicalSha256,
    stateSchemaVersion: lock.runtime.stateSchemaVersion,
    binaries: binaryEvidence,
    ...(platform === "win32-x64" ? {
      limitations: lock.runtime.limitations,
      signingTier: "unsigned_dev",
      distributionChannel: "development",
      productionEligible: false,
      integrityCatalogRelativePath: null,
    } : {}),
  },
  supplyChain: {
    sbomSha256: supplyChain.sbomSha256,
    noticesSha256: supplyChain.noticesSha256,
  },
  runtimeProbe: stableRuntimeProbe,
  missingFinalIdentity: platform === "darwin"
    ? ["cdhashes", "codeIdentifier", "teamId", "designatedRequirement", "entitlementsCanonicalSha256"]
    : ["peManifestCanonicalSha256", "authenticodeStatus", "providerSealSha256"],
};
await writeFile(join(outputRoot, "source-build-promotion-inputs.json"), `${JSON.stringify(promotionInputs, null, 2)}\n`);
const artifactDigests = await artifactDigestMap(outputRoot);
const manifest = {
  schemaVersion: 1,
  kind: "ling.cua-driver.source-build-manifest",
  platform,
  files: artifactDigests,
};
await writeFile(join(outputRoot, "source-build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const manifestSha256 = await sha256File(join(outputRoot, "source-build-manifest.json"));
const promotionInputsSha256 = await sha256File(join(outputRoot, "source-build-promotion-inputs.json"));
const attestation = {
  schemaVersion: 2,
  kind: "ling.cua-driver.source-build-attestation",
  providerLockSha256: lockSha256,
  sourceBuildInputsSha256,
  upstreamCommit: lock.upstream.commit,
  upstreamTree: lock.upstream.tree,
  patchSetSha256: verifiedInputs.seriesSha256,
  platform,
  sourceDateEpoch: lock.upstream.sourceDateEpoch,
  toolchain: lock.toolchain[platform === "darwin" ? "darwin" : "win32X64"],
  checks: {
    toolchain: toolchain.evidence,
    rustfmt: {
      status: "passed",
      scope: "new-rust-files",
      paths: rustfmtPaths,
    },
    cargoTests: { status: "passed", packages: testPackages },
    cargoMetadataSha256: sha256Text(JSON.stringify(cargoMetadata)),
    runtimeProbe: probe,
  },
  binaries: binaryEvidence,
  supplyChain: {
    sbomSha256: supplyChain.sbomSha256,
    noticesSha256: supplyChain.noticesSha256,
  },
  promotionInputsSha256,
  manifestSha256,
  packagingEligible: false,
  signingState: "pre-sign-only",
};
await writeFile(join(outputRoot, "source-build-attestation.json"), `${JSON.stringify(attestation, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(attestation, null, 2)}\n`);

function buildEnv(
  sourceRootValue,
  targetDirectoryValue,
  lockValue,
  platformValue,
  toolchainEnvironment = {},
) {
  const remap = `--remap-path-prefix=${sourceRootValue}=/usr/src/cua-driver`;
  const flags = ["-C", "debuginfo=0", "-C", "strip=symbols", remap];
  if (platformValue === "darwin") flags.push("-C", "link-arg=-Wl,-no_uuid");
  if (platformValue === "win32-x64") {
    flags.push("-C", "target-feature=+crt-static", "-C", "link-arg=/Brepro");
  }
  const environment = mergeEnvironment(
    process.env,
    toolchainEnvironment,
    platformValue === "win32-x64",
  );
  return {
    cwd: sourceRootValue,
    env: {
      ...environment,
      CARGO_TARGET_DIR: targetDirectoryValue,
      CARGO_INCREMENTAL: "0",
      SOURCE_DATE_EPOCH: String(lockValue.upstream.sourceDateEpoch),
      TZ: "UTC",
      RUSTFLAGS: flags.join(" "),
      ...(platformValue === "darwin" ? { MACOSX_DEPLOYMENT_TARGET: "13.0" } : {}),
    },
  };
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) usage(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "verify-only") {
      result[key] = true;
      continue;
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) usage(`missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function usage(message) {
  if (message) process.stderr.write(`error: ${message}\n`);
  process.stderr.write(
    "usage: build-cua-driver-provider.mjs --platform <darwin|win32-x64> --output-dir <dir> --work-dir <dir> [--source-dir <dir>] [--resource-root <dir>] [--verify-only]\n",
  );
  process.exit(2);
}

async function assertSafeOutputRoot({
  outputRoot: outputRootValue,
  resourceRoot: resourceRootValue,
  sourceRoot: sourceRootValue,
  targetDirectory: targetDirectoryValue,
  workRoot: workRootValue,
}) {
  const root = parse(outputRootValue).root;
  if (outputRootValue === root) usage(`unsafe output directory: ${outputRootValue}`);
  for (const [label, protectedPath] of [
    ["provider resources", resourceRootValue],
    ["source checkout", sourceRootValue],
    ["Cargo target", targetDirectoryValue],
  ]) {
    if (pathsOverlap(outputRootValue, protectedPath)) {
      usage(`unsafe output directory overlaps ${label}: ${outputRootValue}`);
    }
  }
  if (isSameOrAncestor(outputRootValue, workRootValue)) {
    usage(`unsafe output directory contains the work root: ${outputRootValue}`);
  }
  await assertPathDoesNotExist(outputRootValue, "output directory");
}

async function assertPathDoesNotExist(path, label) {
  try {
    await lstat(path);
    usage(`${label} already exists; choose a fresh path: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function pathsOverlap(left, right) {
  const leftValue = comparablePath(left);
  const rightValue = comparablePath(right);
  return leftValue === rightValue
    || leftValue.startsWith(`${rightValue}${sep}`)
    || rightValue.startsWith(`${leftValue}${sep}`);
}

function isSameOrAncestor(candidate, value) {
  const candidateValue = comparablePath(candidate);
  const resolvedValue = comparablePath(value);
  return candidateValue === resolvedValue || resolvedValue.startsWith(`${candidateValue}${sep}`);
}

function comparablePath(value) {
  const resolvedValue = resolve(value);
  return process.platform === "win32" ? resolvedValue.toLowerCase() : resolvedValue;
}
