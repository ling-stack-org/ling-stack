import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { EventEmitter } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";

import {
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
  probeCuaDriverProvider,
} from "../scripts/probe-cua-driver-provider.mjs";

const execFile = promisify(execFileCallback);
const BUILD_SCRIPT = new URL("../scripts/build-cua-driver-provider.mjs", import.meta.url).pathname;
const VERIFY_SCRIPT = new URL("../scripts/verify-cua-driver-source-build.mjs", import.meta.url).pathname;

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
  const series = JSON.parse(
    await readFile(join(PROVIDER_RESOURCE_ROOT, inputs.patchSet.manifest), "utf8"),
  );
  assert.deepEqual(series.rustfmtPaths, [
    "libs/cua-driver/rust/crates/cua-driver-core/src/ling_managed.rs",
    "libs/cua-driver/rust/crates/cua-driver-core/src/ling_managed_readiness.rs",
    "libs/cua-driver/rust/crates/cua-driver/src/ling_managed_lifetime.rs",
    "libs/cua-driver/rust/crates/platform-windows/src/ling_managed_capability.rs",
    "libs/cua-driver/rust/crates/platform-windows/src/managed_lifetime.rs",
    "libs/cua-driver/rust/crates/platform-windows/src/managed_readiness.rs",
  ]);
});

test("verify-only validates the pinned source, patch series and closed packaging gate", async () => {
  const result = await runNode([BUILD_SCRIPT, "--platform", "darwin", "--output-dir", join(await mkdtemp(join(tmpdir(), "ling-cua-verify-out-")), "out"), "--verify-only"]);
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.packagingEligible, false);
  assert.match(value.patchSet, /^[0-9a-f]{64}$/u);
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

test("source-build attestation rejects malformed schema before trusting any digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-attestation-"));
  try {
    const attestation = join(root, "source-build-attestation.json");
    await writeJson(attestation, { schemaVersion: 1, packagingEligible: true });
    const result = await runNode([VERIFY_SCRIPT, "--attestation", attestation, "--output-root", root]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /attestation schema mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical JSON tool-list hashing is key-order independent", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: false, c: 1 } }), canonicalJson({ a: { c: 1, d: false }, b: 2 }));
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
    });
    assert.equal(result.initializeProtocolVersion, "2025-06-18");
    assert.equal(result.healthSchemaVersion, "1");
    assert.equal(result.stdinEof, "passed");
    assert.deepEqual(
      requests.map((request) => request.method),
      ["initialize", "notifications/initialized", "tools/list", "tools/call"],
    );
    assert.equal(requests[0].params.protocolVersion, "2025-06-18");
  } finally {
    await rm(stateHome, { recursive: true, force: true });
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
  const parsed = parseWindowsEnvironment("Path=C:\\VS\\bin;C:\\Windows\r\nVCToolsVersion=14.51.36247\r\n");
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

function createFakeProviderSpawner(requests) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = "";
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
          if (request.id === 1) {
            child.stdout.write(`${JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                serverInfo: { name: "fake-cua-driver", version: "0.8.3" },
              },
            })}\n`);
          } else if (request.id === 2) {
            child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } })}\n`);
          } else if (request.id === 3) {
            child.stdout.write(`${JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              result: { structuredContent: { schema_version: 1 } },
            })}\n`);
          }
        }
        callback();
      },
      final(callback) {
        callback();
        queueMicrotask(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
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
