import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  CUA_DRIVER_COMMITTED_LOCK_SHA256,
  CUA_DRIVER_PACKAGE_DESTINATION,
  cleanupCuaDriverStagingResidue,
  CuaDriverPackageStagingError,
  createCuaDriverPackageStagerForTest,
  listCuaDriverStagingResidues,
  providerRootFor,
  stageCuaDriverProvider,
  verifyCuaDriverPreSignStage,
  verifyCuaDriverSourceInput,
} from "../scripts/cua-driver-package-staging.mjs";
import { inspectWindowsPe } from "../scripts/cua-driver-binary-identity.mjs";
import {
  assertSafeTree,
  CUA_DRIVER_PACKAGE_TREE_LIMITS,
  listTreeInventory,
  readBoundedFileSnapshot,
} from "../scripts/cua-driver-package-staging-files.mjs";
import {
  createCuaDriverSourceBuildVerifierForTest,
} from "../scripts/cua-driver-package-staging-source.mjs";
import { validatePackageLock } from "../scripts/cua-driver-package-staging-validation.mjs";
import {
  securePrivateStagingDirectory,
  withAtomicPublishParentLease,
} from "../scripts/cua-driver-package-atomic-publish.mjs";

const execFile = promisify(execFileCallback);
const STAGING_SCRIPT = resolve(
  import.meta.dirname,
  "../scripts/cua-driver-package-staging.mjs",
);

const RESOURCE_SCAFFOLD = resolve(
  import.meta.dirname,
  "../resources/providers/cua-driver/0.8.3-ling.1",
);

test("stages only the current Darwin provider allowlist outside app.asar", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");

  const result = await trust.stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  });

  assert.equal(result.platform, "darwin");
  assert.deepEqual(result.files, [
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "darwin/ling-cua-driver",
    "provider-lock.json",
  ]);
  assert.deepEqual(result.electronBuilderExtraResource, {
    from: result.providerRoot,
    to: CUA_DRIVER_PACKAGE_DESTINATION,
  });
  assert.equal(
    await exists(join(outputRoot, "providers/cua-driver/0.8.3-ling.1/source-build-manifest.json")),
    false,
  );
  await assert.rejects(
    trust.stage({ sourceRoot, outputRoot, platform: "darwin" }),
    /output_root_exists/u,
  );
});

test("Windows staging keeps UIAccess audit bytes out of the standard payload", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "win32-x64", { includeAudit: true });
  const trust = await createTrustedInputs(root, sourceRoot, "win32-x64");

  const source = await trust.verify({
    sourceRoot,
    platform: "win32-x64",
  });
  assert.ok(source.files.includes("audit/win32-x64/cua-driver-uia.exe"));
  const result = await trust.stage({
    sourceRoot,
    outputRoot,
    platform: "win32-x64",
  });

  assert.deepEqual(result.files, [
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "provider-lock.json",
    "win32-x64/payload/ling-cua-driver.exe",
  ]);
  assert.equal(
    await exists(join(result.providerRoot, "audit/win32-x64/cua-driver-uia.exe")),
    false,
  );
});

test("the checked-in fail-closed scaffold is not a packageable provider input", async () => {
  assert.equal(
    sha256(await readFile(join(RESOURCE_SCAFFOLD, "provider-lock.json"))),
    CUA_DRIVER_COMMITTED_LOCK_SHA256,
  );
  await assert.rejects(
    verifyCuaDriverSourceInput({ sourceRoot: RESOURCE_SCAFFOLD, platform: "darwin" }),
    /provider_trust_root_overlap|provider_source_extra_entry|provider_platform_not_enabled/u,
  );
});

test("production staging APIs reject caller-controlled trust before use", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  const trustedResourceRoot = join(root, "attacker-trust");
  await createSourceFixture(sourceRoot, "darwin");
  await mkdir(trustedResourceRoot);
  await writeFile(
    join(trustedResourceRoot, "provider-lock.json"),
    await readFile(join(sourceRoot, "provider-lock.json")),
  );
  let verifierCalled = false;
  const sourceBuildVerifier = async () => {
    verifierCalled = true;
    return {
      platform: "darwin",
      files: await packageDigestMap(sourceRoot, "darwin"),
    };
  };
  const override = { sourceBuildVerifier, trustedResourceRoot };

  for (const operation of [
    () => verifyCuaDriverSourceInput({
      sourceRoot,
      platform: "darwin",
      ...override,
    }),
    () => stageCuaDriverProvider({
      sourceRoot,
      outputRoot,
      platform: "darwin",
      ...override,
    }),
  ]) {
    await assert.rejects(operation(), (error) => {
      assert.equal(error?.code, "staging_trust_override_forbidden");
      return true;
    });
  }
  assert.equal(verifierCalled, false);
  assert.equal(await exists(outputRoot), false);
  await assert.rejects(
    verifyCuaDriverSourceInput({
      sourceRoot,
      platform: "darwin",
      sourceBuildVerifier: undefined,
    }),
    /staging_trust_override_forbidden/u,
  );
  for (const operation of [
    () => verifyCuaDriverSourceInput({
      expectedTrustedLockSha256: undefined,
      sourceRoot,
      platform: "darwin",
    }),
    () => stageCuaDriverProvider({
      expectedTrustedLockSha256: undefined,
      sourceRoot,
      outputRoot,
      platform: "darwin",
    }),
  ]) {
    await assert.rejects(operation(), /staging_trust_override_forbidden/u);
  }
});

test("source staging rejects digest, architecture, license and extra executable drift", async (t) => {
  const cases = [
    ["digest", async (root) => {
      await writeFile(join(root, "darwin/ling-cua-driver"), makeArm64MachO({ sdkVersion: [26, 4, 0] }));
    }, /provider_pre_sign_digest_mismatch/u],
    ["architecture", async (root) => {
      const path = join(root, "win32-x64/payload/ling-cua-driver.exe");
      const bytes = await readFile(path);
      bytes.writeUInt16LE(0xaa64, 0x80 + 4);
      await writeFile(path, bytes);
      await rewriteLockDigest(root, "win32-x64", sha256(bytes));
    }, /provider_binary_identity_invalid/u],
    ["license", async (root) => {
      await writeFile(join(root, "LICENSE.md"), "changed license\n");
    }, /provider_license_digest_mismatch/u],
    ["mode", async (root) => {
      await chmod(join(root, "darwin/ling-cua-driver"), 0o644);
    }, /provider_darwin_not_executable/u],
    ["extra", async (root) => {
      const path = join(root, "win32-x64/payload/other.exe");
      await writeFile(path, "unexpected executable");
    }, /provider_source_extra_entry/u],
    ["extra-directory", async (root) => {
      await mkdir(join(root, "win32-x64/payload/empty"));
    }, /provider_source_extra_entry/u],
    ["uia-payload", async (root) => {
      const path = join(root, "win32-x64/payload/cua-driver-uia.exe");
      await writeFile(path, "forbidden helper");
    }, /provider_uia_payload_forbidden/u],
  ];

  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async (t) => {
      const root = await testRoot(t);
      const platform = ["digest", "license", "mode"].includes(name)
        ? "darwin"
        : "win32-x64";
      const sourceRoot = join(root, "source");
      await createSourceFixture(sourceRoot, platform);
      await mutate(sourceRoot);
      const trust = await createTrustedInputs(root, sourceRoot, platform);
      await assert.rejects(
        trust.verify({ sourceRoot, platform }),
        pattern,
      );
    });
  }
});

test("source staging rejects a self-consistent lock that differs from committed authority", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");

  const provider = makeArm64MachO({
    minimumOSVersion: [13, 0, 0],
    sdkVersion: [26, 4, 0],
  });
  await writeFile(join(sourceRoot, "darwin/ling-cua-driver"), provider);
  await rewriteLockDigest(sourceRoot, "darwin", sha256(provider));

  await assert.rejects(
    trust.verify({ sourceRoot, platform: "darwin" }),
    /provider_lock_anchor_mismatch/u,
  );
});

test("a promoted provider lock requires a fresh second source build attestation", async (t) => {
  const root = await testRoot(t);
  const firstBuildRoot = join(root, "first-build");
  await createSourceFixture(firstBuildRoot, "darwin");
  const firstLockBytes = await readFile(join(firstBuildRoot, "provider-lock.json"));
  const firstLockSha256 = sha256(firstLockBytes);
  const firstAttestationBytes = Buffer.from(`${JSON.stringify({
    providerLockSha256: firstLockSha256,
  }, null, 2)}\n`);
  await writeFile(
    join(firstBuildRoot, "source-build-attestation.json"),
    firstAttestationBytes,
  );

  const promotedLock = JSON.parse(firstLockBytes.toString("utf8"));
  promotedLock.platforms.darwin.referenceReleaseArtifact.sizeBytes += 1;
  const promotedLockBytes = Buffer.from(`${JSON.stringify(promotedLock, null, 2)}\n`);
  const promotedLockSha256 = sha256(promotedLockBytes);
  assert.notEqual(promotedLockSha256, firstLockSha256);

  const trustedResourceRoot = join(root, "promoted-resources");
  await mkdir(trustedResourceRoot);
  await writeFile(join(trustedResourceRoot, "provider-lock.json"), promotedLockBytes);

  let verifierInvocations = 0;
  const sourceBuildVerifier = createCuaDriverSourceBuildVerifierForTest(
    async (_executable, args) => {
      verifierInvocations += 1;
      const resourceRoot = optionArgument(args, "--resource-root");
      const attestationPath = optionArgument(args, "--attestation");
      const outputRoot = optionArgument(args, "--output-root");
      const attestation = JSON.parse(await readFile(attestationPath, "utf8"));
      const trustedLockSha256 = sha256(await readFile(join(resourceRoot, "provider-lock.json")));
      if (attestation.providerLockSha256 !== trustedLockSha256) {
        const error = new Error("source-build verifier rejected stale attestation");
        error.stderr = "attestation provider lock digest mismatch";
        throw error;
      }
      return {
        stdout: JSON.stringify({
          ok: true,
          platform: "darwin",
          files: await packageDigestMap(outputRoot, "darwin"),
        }),
      };
    },
  );
  const stager = createCuaDriverPackageStagerForTest({
    sourceBuildVerifier,
    trustedResourceRoot,
  });

  await assert.rejects(
    stager.verifySourceInput({ sourceRoot: firstBuildRoot, platform: "darwin" }),
    /provider_lock_anchor_mismatch/u,
  );
  assert.equal(verifierInvocations, 0);

  const rewrittenFirstBuildRoot = join(root, "rewritten-first-build");
  await createSourceFixture(rewrittenFirstBuildRoot, "darwin");
  await writeFile(join(rewrittenFirstBuildRoot, "provider-lock.json"), promotedLockBytes);
  await writeFile(
    join(rewrittenFirstBuildRoot, "source-build-attestation.json"),
    firstAttestationBytes,
  );
  await assert.rejects(
    stager.verifySourceInput({
      sourceRoot: rewrittenFirstBuildRoot,
      platform: "darwin",
    }),
    /provider_source_build_verification_failed:attestation provider lock digest mismatch/u,
  );
  assert.equal(verifierInvocations, 1);

  const secondBuildRoot = join(root, "second-build");
  await createSourceFixture(secondBuildRoot, "darwin");
  await writeFile(join(secondBuildRoot, "provider-lock.json"), promotedLockBytes);
  await writeFile(
    join(secondBuildRoot, "source-build-attestation.json"),
    `${JSON.stringify({ providerLockSha256: promotedLockSha256 }, null, 2)}\n`,
  );
  const verified = await stager.verifySourceInput({
    sourceRoot: secondBuildRoot,
    platform: "darwin",
  });
  assert.equal(verified.sourceBuildVerified, true);
  assert.equal(verifierInvocations, 2);
  assert.equal(
    await readFile(join(firstBuildRoot, "provider-lock.json"), "utf8"),
    firstLockBytes.toString("utf8"),
  );
  assert.equal(
    await readFile(join(firstBuildRoot, "source-build-attestation.json"), "utf8"),
    firstAttestationBytes.toString("utf8"),
  );
});

test("source staging rejects canonical root aliases and hard-linked inputs", async (t) => {
  await t.test("output aliases inside source", async (t) => {
    const root = await testRoot(t);
    const sourceRoot = join(root, "real/source");
    await createSourceFixture(sourceRoot, "darwin");
    const trust = await createTrustedInputs(root, sourceRoot, "darwin");
    const alias = join(root, "source-alias");
    await symlink(sourceRoot, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      trust.stage({
        sourceRoot,
        outputRoot: join(alias, "stage"),
        platform: "darwin",
      }),
      /staging_roots_overlap/u,
    );
  });

  await t.test("output parent changes during source verification", async (t) => {
    const root = await testRoot(t);
    const sourceRoot = join(root, "source");
    const firstParent = join(root, "first-parent");
    const secondParent = join(root, "second-parent");
    const parentAlias = join(root, "output-parent");
    await createSourceFixture(sourceRoot, "darwin");
    await mkdir(firstParent);
    await mkdir(secondParent);
    await symlink(
      firstParent,
      parentAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const trust = await createTrustedInputs(root, sourceRoot, "darwin", {
      sourceBuildVerifier: async () => {
        await rm(parentAlias, { force: true });
        await symlink(
          secondParent,
          parentAlias,
          process.platform === "win32" ? "junction" : "dir",
        );
        return {
          platform: "darwin",
          files: await packageDigestMap(sourceRoot, "darwin"),
        };
      },
    });
    await assert.rejects(
      trust.stage({
        sourceRoot,
        outputRoot: join(parentAlias, "stage"),
        platform: "darwin",
      }),
      /staging_output_parent_changed/u,
    );
    assert.equal(await exists(join(firstParent, "stage")), false);
    assert.equal(await exists(join(secondParent, "stage")), false);
  });

  await t.test("hard-linked package input", async (t) => {
    const root = await testRoot(t);
    const sourceRoot = join(root, "source");
    await createSourceFixture(sourceRoot, "darwin");
    const original = join(root, "license-original");
    await rename(join(sourceRoot, "LICENSE.md"), original);
    await link(original, join(sourceRoot, "LICENSE.md"));
    const trust = await createTrustedInputs(root, sourceRoot, "darwin");
    await assert.rejects(
      trust.verify({ sourceRoot, platform: "darwin" }),
      /provider_hardlink_forbidden/u,
    );
  });

  await t.test("trusted lock aliases the source root", async (t) => {
    const root = await testRoot(t);
    const sourceRoot = join(root, "source");
    await createSourceFixture(sourceRoot, "darwin");
    const trustedResourceRoot = join(root, "trusted-alias");
    await symlink(
      sourceRoot,
      trustedResourceRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const stage = createCuaDriverPackageStagerForTest({
      trustedResourceRoot,
      sourceBuildVerifier: async () => ({
        platform: "darwin",
        files: await packageDigestMap(sourceRoot, "darwin"),
      }),
    });
    await assert.rejects(
      stage.verifySourceInput({
        sourceRoot,
        platform: "darwin",
      }),
      /provider_trust_root_overlap/u,
    );
  });
});

test("bounded file snapshots accept an exact fixed-size input", async (t) => {
  const root = await testRoot(t);
  const path = join(root, "fixed-size.bin");
  const bytes = Buffer.from("fixed-size-snapshot");
  await writeFile(path, bytes);

  const snapshot = await readBoundedFileSnapshot(
    path,
    bytes.byteLength,
    "fixed_size_fixture",
  );

  assert.deepEqual(snapshot.bytes, bytes);
  assert.equal(snapshot.size, bytes.byteLength);
  assert.equal(snapshot.sha256, sha256(bytes));
  assert.equal(Object.isFrozen(snapshot), true);
});

test("bounded file snapshots reject an oversized input from metadata", async (t) => {
  const root = await testRoot(t);
  const path = join(root, "oversized.bin");
  const maxBytes = 16;
  await writeFile(path, Buffer.alloc(maxBytes + 1, 0x61));

  await assert.rejects(
    readBoundedFileSnapshot(path, maxBytes, "oversized_fixture"),
    (error) => {
      assert.equal(error?.code, "oversized_fixture_size_invalid");
      return true;
    },
  );
});

test("source-build receipt closes mutation between snapshot and staging", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin", {
    sourceBuildVerifier: async () => {
      const provider = makeArm64MachO({
        minimumOSVersion: [13, 0, 0],
        sdkVersion: [26, 4, 0],
      });
      await writeFile(join(sourceRoot, "darwin/ling-cua-driver"), provider);
      await rewriteLockDigest(sourceRoot, "darwin", sha256(provider));
      return { platform: "darwin", files: await packageDigestMap(sourceRoot, "darwin") };
    },
  });
  await assert.rejects(
    trust.stage({
      sourceRoot,
      outputRoot,
      platform: "darwin",
    }),
    /provider_source_build_receipt_mismatch/u,
  );
  assert.equal(await exists(outputRoot), false);
});

test("default stage path passes the trusted provider snapshot to the source-build child", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const expectedProviderSha256 = sha256(
    await readFile(join(sourceRoot, "darwin/ling-cua-driver")),
  );
  let invocation;
  const sourceBuildVerifier = createCuaDriverSourceBuildVerifierForTest(
    async (command, args, options) => {
      invocation = { args, command, options };
      return {
        stdout: JSON.stringify({
          files: await packageDigestMap(sourceRoot, "darwin"),
          ok: true,
          platform: "darwin",
        }),
      };
    },
  );
  const trust = await createTrustedInputs(root, sourceRoot, "darwin", {
    sourceBuildVerifier,
  });

  await trust.stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  });

  assert.equal(invocation.command, process.execPath);
  assert.equal(argumentValue(invocation.args, "--expected-platform"), "darwin");
  assert.equal(
    argumentValue(invocation.args, "--expected-provider-sha256"),
    expectedProviderSha256,
  );
  assert.equal(invocation.options.timeout, 120_000);
  assert.equal(invocation.options.maxBuffer, 8 * 1024 * 1024);
});

test("source-build verifier wrapper validates child failures and receipt protocol", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const trustedResourceRoot = join(root, "trusted");
  const expectedProviderSha256 = "a".repeat(64);
  const files = Object.fromEntries([
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "darwin/ling-cua-driver",
    "provider-lock.json",
  ].map((path, index) => [path, String(index + 1).repeat(64)]));
  const input = {
    expectedProviderSha256,
    platform: "darwin",
    sourceRoot,
    trustedResourceRoot,
  };
  const success = createCuaDriverSourceBuildVerifierForTest(async () => ({
    stdout: JSON.stringify({ files, ok: true, platform: "darwin" }),
  }));
  const receipt = await success(input);
  assert.deepEqual(receipt, { files, platform: "darwin" });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.files), true);

  for (const [name, error] of [
    ["child failure", Object.assign(new Error("child failed"), { stderr: "child failed" })],
    ["timeout", Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true })],
    ["output limit", Object.assign(new Error("stdout maxBuffer length exceeded"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    })],
  ]) {
    await t.test(name, async () => {
      const verifier = createCuaDriverSourceBuildVerifierForTest(async () => {
        throw error;
      });
      await assert.rejects(verifier(input), (caught) => {
        assert.equal(caught?.code, "provider_source_build_verification_failed");
        return true;
      });
    });
  }

  const receiptCases = [
    ["non JSON", "not-json"],
    ["wrong platform", JSON.stringify({ files, ok: true, platform: "win32-x64" })],
    ["missing files", JSON.stringify({ ok: true, platform: "darwin" })],
    ["missing required file", JSON.stringify({
      files: Object.fromEntries(Object.entries(files).filter(([path]) => path !== "darwin/ling-cua-driver")),
      ok: true,
      platform: "darwin",
    })],
    ["invalid digest", JSON.stringify({
      files: { ...files, "darwin/ling-cua-driver": "invalid" },
      ok: true,
      platform: "darwin",
    })],
  ];
  for (const [name, stdout] of receiptCases) {
    await t.test(name, async () => {
      const verifier = createCuaDriverSourceBuildVerifierForTest(async () => ({ stdout }));
      await assert.rejects(verifier(input), (error) => {
        assert.equal(error?.code, "provider_source_build_receipt_invalid");
        return true;
      });
    });
  }

  await assert.rejects(
    success({ ...input, expectedProviderSha256: "invalid" }),
    (error) => {
      assert.equal(error?.code, "provider_source_build_expected_digest_invalid");
      return true;
    },
  );
});

test("Darwin staging rejects malformed arm64 Mach-O and load-command boundaries", async (t) => {
  const cases = [
    ["CPU", (bytes) => bytes.writeUInt32LE(0, 4), /inner CPU type/u],
    ["file type", (bytes) => bytes.writeUInt32LE(0, 12), /MH_EXECUTE/u],
    ["magic", (bytes) => bytes.writeUInt32LE(0, 0), /Mach-O 64-bit/u],
    ["truncated commands", (bytes) => bytes.writeUInt32LE(0xffff, 20), /load commands are truncated/u],
    ["duplicate build version", duplicateFirstBuildVersion, /duplicate LC_BUILD_VERSION/u],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async (t) => {
      const root = await testRoot(t);
      const sourceRoot = join(root, "source");
      await createSourceFixture(sourceRoot, "darwin");
      const providerPath = join(sourceRoot, "darwin/ling-cua-driver");
      let provider = await readFile(providerPath);
      const replacement = mutate(provider);
      if (Buffer.isBuffer(replacement)) provider = replacement;
      await writeFile(providerPath, provider);
      await rewriteLockDigest(sourceRoot, "darwin", sha256(provider));
      const trust = await createTrustedInputs(root, sourceRoot, "darwin");
      await assert.rejects(
        trust.verify({ sourceRoot, platform: "darwin" }),
        pattern,
      );
    });
  }
});

test("pre-sign Windows staging rejects certificate-table claims", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  await createSourceFixture(sourceRoot, "win32-x64");
  const providerPath = join(sourceRoot, "win32-x64/payload/ling-cua-driver.exe");
  const provider = await readFile(providerPath);
  setPeCertificateTable(provider, true);
  await writeFile(providerPath, provider);
  await rewriteLockDigest(sourceRoot, "win32-x64", sha256(provider));
  const trust = await createTrustedInputs(root, sourceRoot, "win32-x64");
  await assert.rejects(
    trust.verify({ sourceRoot, platform: "win32-x64" }),
    /provider_windows_identity_mismatch/u,
  );
});

test("staging applies the authoritative runtime provider-lock contract", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  await createSourceFixture(sourceRoot, "win32-x64");
  const lock = JSON.parse(await readFile(join(sourceRoot, "provider-lock.json"), "utf8"));
  const licenseSha256 = sha256(await readFile(join(sourceRoot, "LICENSE.md")));
  const cases = [
    ["reference evidence", (value) => delete value.platforms.win32X64.referenceReleaseArtifact,
      /provider_lock_platform_sections_missing/u],
    ["main manifest digest", (value) => delete value.platforms.win32X64.binary.mainManifestCanonicalSha256,
      /provider_lock_windows_binary_evidence_invalid/u],
    ["MCP SDK", (value) => { value.platforms.win32X64.compatibility.mcpClientSdk = "unreviewed"; },
      /provider_lock_windows_compatibility_invalid/u],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => {
      const candidate = structuredClone(lock);
      mutate(candidate);
      assert.throws(
        () => validatePackageLock({
          lock: candidate,
          platform: "win32-x64",
          licenseSha256,
        }),
        pattern,
      );
    });
  }

  const darwinRoot = join(root, "source-darwin");
  await createSourceFixture(darwinRoot, "darwin");
  const darwinLock = JSON.parse(
    await readFile(join(darwinRoot, "provider-lock.json"), "utf8"),
  );
  const darwinLicenseSha256 = sha256(await readFile(join(darwinRoot, "LICENSE.md")));
  for (const [name, mutate, expectedCode] of [
    [
      "Darwin reference evidence",
      (value) => { value.platforms.darwin.referenceReleaseArtifact.teamId = ""; },
      "provider_lock_darwin_reference_evidence_invalid",
    ],
    [
      "Darwin source build",
      (value) => { value.platforms.darwin.sourceBuild.targets = ["x86_64-apple-darwin"]; },
      "provider_lock_darwin_source_build_invalid",
    ],
    [
      "Darwin binary evidence",
      (value) => { delete value.platforms.darwin.binary.minimumMacOS; },
      "provider_lock_darwin_binary_evidence_invalid",
    ],
  ]) {
    await t.test(name, () => {
      const candidate = structuredClone(darwinLock);
      mutate(candidate);
      assert.throws(
        () => validatePackageLock({
          lock: candidate,
          platform: "darwin",
          licenseSha256: darwinLicenseSha256,
        }),
        (error) => {
          assert.ok(error instanceof CuaDriverPackageStagingError);
          assert.equal(error.code, expectedCode);
          return true;
        },
      );
    });
  }
});

test("Windows staging binds the exact RT_MANIFEST bytes to the provider lock", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  await createSourceFixture(sourceRoot, "win32-x64");
  const lockPath = join(sourceRoot, "provider-lock.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.platforms.win32X64.binary.mainManifestCanonicalSha256 = "e".repeat(64);
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const trust = await createTrustedInputs(root, sourceRoot, "win32-x64");

  await assert.rejects(
    trust.verify({
      sourceRoot,
      platform: "win32-x64",
    }),
    /provider_windows_manifest_digest_mismatch/u,
  );
});

test("staging CLI exposes no final phase or signing tier", async (t) => {
  const root = await testRoot(t);
  for (const [flag, value] of [
    ["--phase", "final"],
    ["--signing-tier", "unsigned_dev"],
  ]) {
    const result = await runNode([
      STAGING_SCRIPT,
      "--resources-root",
      root,
      "--platform",
      "darwin",
      flag,
      value,
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /cli_argument_invalid/u);
  }
});

test("native publisher preflight completes before a temporary payload tree exists", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const sentinel = new Error("stop after native preflight");
  let temporaryRoot;
  const stage = trust.withHooks({
    afterNativePublisherPreflight: async (paths) => {
      temporaryRoot = paths.temporaryRoot;
      throw sentinel;
    },
  });

  const error = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));

  assert.strictEqual(error, sentinel);
  assert.ok(temporaryRoot);
  assert.equal(await exists(temporaryRoot), false);
  assert.equal(await exists(outputRoot), false);
});

test("lease loss after mkdir but before identity capture is recoverable through residue listing", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  let temporaryRoot;
  const stage = trust.withHooks({
    afterTemporaryCreateBeforeIdentity: async ({
      parentLeaseHelperPid,
      parentLeaseSignal,
      temporaryRoot: path,
    }) => {
      temporaryRoot = path;
      const aborted = new Promise((resolve) => {
        parentLeaseSignal.addEventListener("abort", resolve, { once: true });
      });
      process.kill(parentLeaseHelperPid, "SIGKILL");
      await aborted;
    },
  });

  const error = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));

  assert.equal(error?.code, "staging_parent_lock_lost");
  assert.equal(error?.outcome, "ambiguous");
  assert.equal(error?.cleanup?.reason, "parent_lock_lost");
  assert.equal(error?.cleanup?.residuePath, temporaryRoot);
  assert.equal(Object.hasOwn(error.cleanup, "residueIdentity"), false);
  assert.equal(await exists(temporaryRoot), true);

  const listed = await listCuaDriverStagingResidues({ outputRoot });
  assert.equal(listed.totalMatching, 1);
  assert.equal(listed.truncated, false);
  assert.equal(listed.residues[0].residuePath, temporaryRoot);
  assert.match(listed.residues[0].residueIdentity, /^[0-9a-f]+:[0-9a-f]+$/u);

  const receipt = await cleanupCuaDriverStagingResidue({
    expectedResidueIdentity: listed.residues[0].residueIdentity,
    outputRoot,
    residuePath: temporaryRoot,
  });
  assert.equal(receipt.outcome, "removed");
  assert.equal(await exists(temporaryRoot), false);
});

test("failure before private security returns an identity-bound cleanup receipt", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const sentinel = new Error("stop before private security");
  let temporaryRoot;
  const stage = trust.withHooks({
    afterTemporaryIdentityBeforeSecure: async (paths) => {
      temporaryRoot = paths.temporaryRoot;
      if (process.platform !== "win32") {
        await chmod(temporaryRoot, 0o755);
      }
      throw sentinel;
    },
  });

  const error = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));

  assert.strictEqual(error, sentinel);
  assert.equal(error.cleanup.reason, "retained_fail_closed");
  assert.match(error.cleanup.residueIdentity, /^[0-9a-f]+:[0-9a-f]+$/u);
  assert.equal(error.cleanup.residueEntries, 0);
  assert.equal(error.cleanup.residueBytes, 0);
  assert.equal(error.cleanup.residuePath, temporaryRoot);
  assert.equal(await exists(temporaryRoot), true);

  const listed = await listCuaDriverStagingResidues({ outputRoot });
  assert.equal(listed.totalMatching, 1);
  assert.equal(listed.truncated, false);
  assert.equal(listed.residues[0].residuePath, temporaryRoot);
  assert.equal(
    listed.residues[0].residueIdentity,
    error.cleanup.residueIdentity,
  );
  assert.ok(["private", "unsecured"].includes(listed.residues[0].securityState));

  const receipt = await cleanupCuaDriverStagingResidue({
    expectedResidueIdentity: error.cleanup.residueIdentity,
    outputRoot,
    residuePath: temporaryRoot,
  });
  assert.equal(receipt.outcome, "removed");
  assert.equal(receipt.residueIdentity, error.cleanup.residueIdentity);
  assert.equal(await exists(temporaryRoot), false);
});

test("staging stops before payload writes when the parent lease helper is lost", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  let temporaryRoot;
  const stage = trust.withHooks({
    afterTemporaryIdentityBeforeSecure: async ({
      parentLeaseHelperPid,
      parentLeaseSignal,
      temporaryRoot: path,
    }) => {
      temporaryRoot = path;
      const aborted = new Promise((resolve) => {
        parentLeaseSignal.addEventListener("abort", resolve, { once: true });
      });
      process.kill(parentLeaseHelperPid, "SIGKILL");
      await aborted;
    },
  });

  const error = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));

  assert.equal(error?.code, "staging_parent_lock_lost");
  assert.equal(error?.outcome, "ambiguous");
  assert.match(error?.cleanup?.residueIdentity, /^[0-9a-f]+:[0-9a-f]+$/u);
  assert.equal(error?.cleanup?.residuePath, temporaryRoot);
  assert.equal(Object.hasOwn(error.cleanup, "residueEntries"), false);
  assert.equal(Object.hasOwn(error.cleanup, "residueBytes"), false);
  assert.equal(await exists(providerRootFor(temporaryRoot)), false);

  const listed = await listCuaDriverStagingResidues({ outputRoot });
  assert.equal(listed.totalMatching, 1);
  assert.equal(listed.residues[0].residueIdentity, error.cleanup.residueIdentity);
  assert.equal(listed.residues[0].entries, 0);
  assert.equal(listed.residues[0].totalBytes, 0);

  const receipt = await cleanupCuaDriverStagingResidue({
    expectedResidueIdentity: listed.residues[0].residueIdentity,
    outputRoot,
    residuePath: temporaryRoot,
  });
  assert.equal(receipt.outcome, "removed");
});

test("lease loss during residue observation preserves identity-bound cleanup metadata", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  let temporaryRoot;
  const stage = trust.withHooks({
    afterTemporaryIdentityBeforeSecure: async () => {
      throw new Error("force ordinary staging failure before residue observation");
    },
    beforeRetainedResidueObservation: async ({
      parentLeaseHelperPid,
      parentLeaseSignal,
      temporaryRoot: path,
    }) => {
      temporaryRoot = path;
      const aborted = new Promise((resolve) => {
        parentLeaseSignal.addEventListener("abort", resolve, { once: true });
      });
      process.kill(parentLeaseHelperPid, "SIGKILL");
      await aborted;
    },
  });

  const error = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));

  assert.match(error?.code, /^staging_parent_lock_/u);
  assert.equal(error?.outcome, "ambiguous");
  assert.equal(error?.cleanup?.reason, "parent_lock_lost");
  assert.match(error?.cleanup?.residueIdentity, /^[0-9a-f]+:[0-9a-f]+$/u);
  assert.equal(error?.cleanup?.residuePath, temporaryRoot);
  assert.equal(await exists(temporaryRoot), true);

  const receipt = await cleanupCuaDriverStagingResidue({
    expectedResidueIdentity: error.cleanup.residueIdentity,
    outputRoot,
    residuePath: temporaryRoot,
  });
  assert.equal(receipt.outcome, "removed");
});

test("confirmed publish survives parent lease loss at the guard post-check", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  let temporaryRoot;
  const stage = trust.withHooks({
    afterAtomicPublishCommitConfirmed: async ({
      commitReceipt,
      parentLeaseHelperPid,
      parentLeaseSignal,
      publishRoot,
      temporaryRoot: path,
    }) => {
      temporaryRoot = path;
      assert.equal(commitReceipt.outcome, "committed");
      assert.equal(await exists(publishRoot), true);
      assert.equal(await exists(temporaryRoot), false);
      const aborted = new Promise((resolve) => {
        parentLeaseSignal.addEventListener("abort", resolve, { once: true });
      });
      process.kill(parentLeaseHelperPid, "SIGKILL");
      await aborted;
    },
  });

  const error = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));

  assert.ok(error instanceof CuaDriverPackageStagingError);
  assert.equal(error?.code, "published_stage_verification_failed");
  assert.equal(error?.outcome, "ambiguous");
  assert.equal(error?.published, true);
  assert.equal(error?.path, await realpath(outputRoot));
  assert.equal(error?.cause?.code, "staging_parent_lock_lost");
  assert.equal(error?.cleanup, undefined);
  assert.equal(await exists(outputRoot), true);
  assert.equal(await exists(temporaryRoot), false);
  assert.equal((await listCuaDriverStagingResidues({ outputRoot })).totalMatching, 0);
  assert.equal((await verifyCuaDriverPreSignStage({
    resourcesRoot: outputRoot,
    platform: "darwin",
  })).platform, "darwin");
});

test("cleanup never starts security recovery after losing the parent lease", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const retained = await captureRejection(() => trust.withHooks({
    afterTemporaryIdentityBeforeSecure: async ({ temporaryRoot }) => {
      if (process.platform !== "win32") await chmod(temporaryRoot, 0o755);
      throw new Error("retain unsecured root for cleanup lease-loss coverage");
    },
  })({ sourceRoot, outputRoot, platform: "darwin" }));
  const cleaner = trust.withHooks({
    afterCleanupIdentityBeforeSecurity: async ({
      parentLeaseHelperPid,
      parentLeaseSignal,
    }) => {
      const aborted = new Promise((resolve) => {
        parentLeaseSignal.addEventListener("abort", resolve, { once: true });
      });
      process.kill(parentLeaseHelperPid, "SIGKILL");
      await aborted;
    },
  });

  const error = await captureRejection(() => cleaner.cleanupResidue({
    expectedResidueIdentity: retained.cleanup.residueIdentity,
    outputRoot,
    residuePath: retained.cleanup.residuePath,
  }));

  assert.equal(error?.code, "staging_parent_lock_lost");
  assert.equal(error?.outcome, "ambiguous");
  assert.equal(await exists(retained.cleanup.residuePath), true);
  const receipt = await cleanupCuaDriverStagingResidue({
    expectedResidueIdentity: retained.cleanup.residueIdentity,
    outputRoot,
    residuePath: retained.cleanup.residuePath,
  });
  assert.equal(receipt.outcome, "removed");
});

test("retained residue cleanup requires its native identity and is available through CLI", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const stage = trust.withHooks({
    beforeAtomicPublish: async () => {
      throw new Error("retain for explicit cleanup");
    },
  });
  const error = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));
  assert.equal(error.cleanup.reason, "retained_fail_closed");
  assert.match(error.cleanup.residueIdentity, /^[0-9a-f]+:[0-9a-f]+$/u);
  assert.ok(error.cleanup.residueEntries > 0);
  assert.ok(error.cleanup.residueBytes > 0);

  const listResult = await runNode([
    STAGING_SCRIPT,
    "--list-residue",
    "--output-root",
    outputRoot,
  ]);
  assert.equal(listResult.code, 0, listResult.stderr);
  const listed = JSON.parse(listResult.stdout);
  assert.equal(listed.totalMatching, 1);
  assert.equal(listed.residues[0].residueIdentity, error.cleanup.residueIdentity);
  assert.equal(listed.residues[0].residuePath, error.cleanup.residuePath);

  await assert.rejects(
    cleanupCuaDriverStagingResidue({
      expectedResidueIdentity: "dead:beef",
      outputRoot,
      residuePath: error.cleanup.residuePath,
    }),
    (cleanupError) => {
      assert.equal(cleanupError?.code, "staging_residue_identity_mismatch");
      return true;
    },
  );
  assert.equal(await exists(error.cleanup.residuePath), true);

  const result = await runNode([
    STAGING_SCRIPT,
    "--cleanup-residue",
    error.cleanup.residuePath,
    "--output-root",
    outputRoot,
    "--expected-residue-identity",
    error.cleanup.residueIdentity,
  ]);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.outcome, "removed");
  assert.equal(receipt.residueIdentity, error.cleanup.residueIdentity);
  assert.equal(receipt.residuePath, error.cleanup.residuePath);
  assert.equal(await exists(error.cleanup.residuePath), false);
});

test("residue listing handles absent and empty output parents", async (t) => {
  const root = await testRoot(t);
  const canonicalRoot = await realpath(root);
  const missingOutputRoot = join(canonicalRoot, "missing-parent", "stage");

  assert.deepEqual(await listCuaDriverStagingResidues({
    outputRoot: missingOutputRoot,
  }), {
    schemaVersion: 1,
    outputRoot: missingOutputRoot,
    residues: [],
    totalMatching: 0,
    truncated: false,
  });

  const emptyParent = join(canonicalRoot, "empty-parent");
  const emptyOutputRoot = join(emptyParent, "stage");
  await mkdir(emptyParent, { mode: 0o700 });
  assert.deepEqual(await listCuaDriverStagingResidues({
    outputRoot: emptyOutputRoot,
  }), {
    schemaVersion: 1,
    outputRoot: emptyOutputRoot,
    residues: [],
    totalMatching: 0,
    truncated: false,
  });
});

test("residue listing truncates over four roots and supports multi-round cleanup", async (t) => {
  const root = await realpath(await testRoot(t));
  const outputRoot = join(root, "stage");
  const residueNames = Array.from(
    { length: 5 },
    (_, index) => (
      `stage.tmp-${process.pid}-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
    ),
  );
  const identities = new Map();
  await withAtomicPublishParentLease(
    { parentRoot: root, timeoutMs: 2_000 },
    async (lease) => {
      for (const residueName of residueNames) {
        await mkdir(join(root, residueName), { mode: 0o700 });
        const secured = await securePrivateStagingDirectory({
          directoryName: residueName,
          parentRoot: root,
        }, lease);
        identities.set(residueName, secured.directoryIdentity);
      }
    },
  );

  const firstPage = await listCuaDriverStagingResidues({ outputRoot });
  assert.equal(firstPage.totalMatching, 5);
  assert.equal(firstPage.truncated, true);
  assert.equal(firstPage.residues.length, 4);
  assert.deepEqual(
    firstPage.residues.map(({ residuePath }) => basename(residuePath)),
    residueNames.slice(0, 4),
  );
  for (const residue of firstPage.residues) {
    assert.equal(
      residue.residueIdentity,
      identities.get(basename(residue.residuePath)),
    );
    assert.equal((await cleanupCuaDriverStagingResidue({
      expectedResidueIdentity: residue.residueIdentity,
      outputRoot,
      residuePath: residue.residuePath,
    })).outcome, "removed");
  }

  const secondPage = await listCuaDriverStagingResidues({ outputRoot });
  assert.equal(secondPage.totalMatching, 1);
  assert.equal(secondPage.truncated, false);
  assert.equal(secondPage.residues.length, 1);
  assert.equal(
    basename(secondPage.residues[0].residuePath),
    residueNames[4],
  );
  assert.equal((await cleanupCuaDriverStagingResidue({
    expectedResidueIdentity: secondPage.residues[0].residueIdentity,
    outputRoot,
    residuePath: secondPage.residues[0].residuePath,
  })).outcome, "removed");

  const finalPage = await listCuaDriverStagingResidues({ outputRoot });
  assert.equal(finalPage.totalMatching, 0);
  assert.equal(finalPage.truncated, false);
  assert.deepEqual(finalPage.residues, []);
});

test("cleanup and staging for one parent are serialized by the same lease", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const retained = await captureRejection(() => trust.withHooks({
    beforeAtomicPublish: async () => {
      throw new Error("retain for parent lease serialization");
    },
  })({ sourceRoot, outputRoot, platform: "darwin" }));
  const events = [];
  let cleanupEntered;
  let releaseCleanup;
  const cleanupReady = new Promise((resolve) => {
    cleanupEntered = resolve;
  });
  const cleanupGate = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  t.after(() => releaseCleanup());
  const cleaner = trust.withHooks({
    afterCleanupQuarantineVerifiedBeforeRemove: async () => {
      events.push("cleanup-held");
      cleanupEntered();
      await cleanupGate;
      events.push("cleanup-released");
    },
  });
  const cleanup = cleaner.cleanupResidue({
    expectedResidueIdentity: retained.cleanup.residueIdentity,
    outputRoot,
    residuePath: retained.cleanup.residuePath,
  });
  await cleanupReady;

  let stagePreflightReached;
  const stagePreflight = new Promise((resolve) => {
    stagePreflightReached = resolve;
  });
  const stage = trust.withHooks({
    afterNativePublisherPreflight: async () => {
      events.push("stage-preflight");
      stagePreflightReached();
    },
    afterTemporaryIdentityBeforeSecure: async () => {
      events.push("stage-temp");
    },
  })({ sourceRoot, outputRoot, platform: "darwin" });
  await stagePreflight;
  assert.equal(events.includes("stage-temp"), false);

  releaseCleanup();
  assert.equal((await cleanup).outcome, "removed");
  assert.equal((await stage).platform, "darwin");
  assert.ok(events.indexOf("stage-temp") > events.indexOf("cleanup-released"));
});

test("cleanup never deletes a foreign root swapped after quarantine verification", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const retained = await captureRejection(() => trust.withHooks({
    beforeAtomicPublish: async () => {
      throw new Error("retain for cleanup swap coverage");
    },
  })({ sourceRoot, outputRoot, platform: "darwin" }));
  let displacedQuarantine;
  let foreignQuarantine;
  const cleaner = trust.withHooks({
    afterCleanupQuarantineVerifiedBeforeRemove: async ({ quarantinePath }) => {
      foreignQuarantine = quarantinePath;
      displacedQuarantine = `${quarantinePath}.verified-residue`;
      await rename(quarantinePath, displacedQuarantine);
      await mkdir(quarantinePath, { mode: 0o700 });
      await writeFile(join(quarantinePath, "valuable.txt"), "foreign-value");
    },
  });

  const cleanupError = await captureRejection(() => cleaner.cleanupResidue({
    expectedResidueIdentity: retained.cleanup.residueIdentity,
    outputRoot,
    residuePath: retained.cleanup.residuePath,
  }));

  assert.equal(cleanupError?.code, "staging_residue_cleanup_ambiguous");
  assert.equal(cleanupError?.nativeReason, "source_identity_mismatch");
  assert.equal(
    await readFile(join(foreignQuarantine, "valuable.txt"), "utf8"),
    "foreign-value",
  );
  assert.equal(
    await exists(join(displacedQuarantine, "providers/cua-driver/0.8.3-ling.1")),
    true,
  );
});

test("a zero-mutation native cleanup failure rolls the exact residue back for retry", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  const externalRoot = join(root, "external");
  await createSourceFixture(sourceRoot, "darwin");
  await mkdir(externalRoot);
  await writeFile(join(externalRoot, "valuable.txt"), "external-value");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const retained = await captureRejection(() => trust.withHooks({
    beforeAtomicPublish: async () => {
      throw new Error("retain for cleanup rollback coverage");
    },
  })({ sourceRoot, outputRoot, platform: "darwin" }));
  const injectedName = "cleanup-race-link";
  const cleaner = trust.withHooks({
    afterCleanupQuarantineVerifiedBeforeRemove: async ({ quarantinePath }) => {
      await symlink(
        externalRoot,
        join(quarantinePath, injectedName),
        process.platform === "win32" ? "junction" : "dir",
      );
    },
  });

  const cleanupError = await captureRejection(() => cleaner.cleanupResidue({
    expectedResidueIdentity: retained.cleanup.residueIdentity,
    outputRoot,
    residuePath: retained.cleanup.residuePath,
  }));

  assert.equal(cleanupError?.code, "staging_residue_cleanup_failed");
  assert.equal(cleanupError?.nativeReason, "tree_reparse_forbidden");
  assert.equal(cleanupError?.cleanup?.reason, "cleanup_failed_residue_restored");
  assert.equal(cleanupError?.cleanup?.residuePath, retained.cleanup.residuePath);
  assert.equal(cleanupError?.cleanup?.residueIdentity, retained.cleanup.residueIdentity);
  assert.equal(await exists(retained.cleanup.residuePath), true);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.startsWith("stage.cleanup-")),
    [],
  );
  assert.equal(await readFile(join(externalRoot, "valuable.txt"), "utf8"), "external-value");

  await rm(join(retained.cleanup.residuePath, injectedName));
  const receipt = await cleanupCuaDriverStagingResidue({
    expectedResidueIdentity: retained.cleanup.residueIdentity,
    outputRoot,
    residuePath: retained.cleanup.residuePath,
  });
  assert.equal(receipt.outcome, "removed");
  assert.equal(await exists(retained.cleanup.residuePath), false);
});

test("cleanup never rolls a quarantine back after losing the parent lease", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  const externalRoot = join(root, "external");
  await createSourceFixture(sourceRoot, "darwin");
  await mkdir(externalRoot);
  await writeFile(join(externalRoot, "valuable.txt"), "external-value");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const retained = await captureRejection(() => trust.withHooks({
    beforeAtomicPublish: async () => {
      throw new Error("retain for rollback lease-loss coverage");
    },
  })({ sourceRoot, outputRoot, platform: "darwin" }));
  const injectedName = "cleanup-lease-loss-link";
  const cleaner = trust.withHooks({
    afterCleanupQuarantineVerifiedBeforeRemove: async ({ quarantinePath }) => {
      await symlink(
        externalRoot,
        join(quarantinePath, injectedName),
        process.platform === "win32" ? "junction" : "dir",
      );
    },
    afterCleanupRemoveFailureBeforeRollback: async ({
      parentLeaseHelperPid,
      parentLeaseSignal,
    }) => {
      const aborted = new Promise((resolve) => {
        parentLeaseSignal.addEventListener("abort", resolve, { once: true });
      });
      process.kill(parentLeaseHelperPid, "SIGKILL");
      await aborted;
    },
  });

  const error = await captureRejection(() => cleaner.cleanupResidue({
    expectedResidueIdentity: retained.cleanup.residueIdentity,
    outputRoot,
    residuePath: retained.cleanup.residuePath,
  }));

  assert.equal(error?.code, "staging_parent_lock_lost");
  assert.equal(await exists(retained.cleanup.residuePath), false);
  const quarantineNames = (await readdir(root))
    .filter((name) => name.startsWith("stage.cleanup-"));
  assert.equal(quarantineNames.length, 1);
  const quarantinePath = join(root, quarantineNames[0]);
  assert.equal(await readFile(join(externalRoot, "valuable.txt"), "utf8"), "external-value");
  await rm(join(quarantinePath, injectedName));

  const listed = await listCuaDriverStagingResidues({ outputRoot });
  assert.equal(listed.residues.length, 1);
  assert.equal(
    basename(listed.residues[0].residuePath),
    basename(quarantinePath),
  );
  const receipt = await cleanupCuaDriverStagingResidue({
    expectedResidueIdentity: listed.residues[0].residueIdentity,
    outputRoot,
    residuePath: listed.residues[0].residuePath,
  });
  assert.equal(receipt.outcome, "removed");
});

test("an ambiguous rollback returns a retryable quarantine receipt counted by quota", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  const externalRoot = join(root, "external");
  await createSourceFixture(sourceRoot, "darwin");
  await mkdir(externalRoot);
  await writeFile(join(externalRoot, "valuable.txt"), "external-value");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const retained = await captureRejection(() => trust.withHooks({
    beforeAtomicPublish: async () => {
      throw new Error("retain for quarantine receipt coverage");
    },
  })({ sourceRoot, outputRoot, platform: "darwin" }));
  const injectedName = "cleanup-race-link";
  const cleaner = createCuaDriverPackageStagerForTest({
    ...trust.configuration,
    residueLimits: { maxCount: 1 },
    afterCleanupQuarantineVerifiedBeforeRemove: async ({ quarantinePath }) => {
      await symlink(
        externalRoot,
        join(quarantinePath, injectedName),
        process.platform === "win32" ? "junction" : "dir",
      );
    },
    afterCleanupRemoveFailureBeforeRollback: async ({ residuePath }) => {
      await mkdir(residuePath, { mode: 0o700 });
      await writeFile(join(residuePath, "collision.txt"), "foreign-collision");
    },
  });

  const cleanupError = await captureRejection(() => cleaner.cleanupResidue({
    expectedResidueIdentity: retained.cleanup.residueIdentity,
    outputRoot,
    residuePath: retained.cleanup.residuePath,
  }));

  assert.equal(cleanupError?.code, "staging_residue_cleanup_failed");
  assert.match(basename(cleanupError.cleanup.residuePath), /^stage\.cleanup-/u);
  assert.equal(cleanupError.cleanup.residueIdentity, retained.cleanup.residueIdentity);
  assert.equal(
    await readFile(join(retained.cleanup.residuePath, "collision.txt"), "utf8"),
    "foreign-collision",
  );
  await rm(retained.cleanup.residuePath, { recursive: true });
  await rm(join(cleanupError.cleanup.residuePath, injectedName));
  const quotaError = await captureRejection(() => cleaner({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));
  assert.equal(quotaError?.code, "staging_residue_quota_exceeded");

  const retryCleaner = createCuaDriverPackageStagerForTest({
    ...trust.configuration,
    residueLimits: { maxCount: 1 },
  });
  const receipt = await retryCleaner.cleanupResidue({
    expectedResidueIdentity: cleanupError.cleanup.residueIdentity,
    outputRoot,
    residuePath: cleanupError.cleanup.residuePath,
  });
  assert.equal(receipt.outcome, "removed");
  assert.equal(await exists(cleanupError.cleanup.residuePath), false);
  assert.equal(await readFile(join(externalRoot, "valuable.txt"), "utf8"), "external-value");
});

test("atomic publish refuses a concurrently created output without obscuring cleanup state", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  let foreignIdentity;
  let temporaryRoot;
  const stage = trust.withHooks({
    beforeAtomicPublish: async (paths) => {
      temporaryRoot = paths.temporaryRoot;
      await mkdir(paths.publishRoot);
      foreignIdentity = await fileIdentity(paths.publishRoot);
    },
  });

  const error = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));

  assert.equal(error?.code, "output_root_exists");
  assert.equal(error?.outcome, "not_committed");
  assert.equal(error?.nativeReason, "destination_exists");
  assert.equal(error?.cleanup?.outcome, "residue");
  assert.equal(error?.cleanup?.reason, "retained_fail_closed");
  assert.equal(Object.isFrozen(error?.cleanup), true);
  assert.equal(error.message.match(/output_root_exists/gu)?.length, 1);
  assert.ok(foreignIdentity);
  assert.deepEqual(await fileIdentity(outputRoot), foreignIdentity);
  assert.equal(error.cleanup.residuePath, temporaryRoot);
  assert.equal(await exists(error.cleanup.residuePath), true);
});

test("atomic publish never commits a foreign replacement of the verified temporary tree", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  let bypassRoot;
  let foreignIdentity;
  let foreignTemporaryRoot;
  const stage = trust.withHooks({
    beforeAtomicPublish: async ({ temporaryRoot }) => {
      bypassRoot = `${temporaryRoot}.verified-bypass`;
      foreignTemporaryRoot = temporaryRoot;
      await rename(temporaryRoot, bypassRoot);
      await mkdir(temporaryRoot);
      await writeFile(join(temporaryRoot, "foreign.txt"), "foreign-temporary-content");
      foreignIdentity = await fileIdentity(temporaryRoot);
    },
  });

  const error = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));

  assert.equal(error?.code, "staging_publish_not_committed");
  assert.equal(error?.outcome, "not_committed");
  assert.equal(error?.nativeReason, "source_identity_mismatch");
  assert.equal(error?.cleanup?.outcome, "residue");
  assert.equal(error?.cleanup?.reason, "retained_identity_mismatch");
  assert.equal(error?.cleanup?.nativeCode, 0);
  assert.equal(error?.cleanup?.residuePath, foreignTemporaryRoot);
  assert.equal(Object.isFrozen(error?.cleanup), true);
  assert.equal(
    error.message.match(/staging_publish_not_committed/gu)?.length,
    1,
  );
  assert.equal(await exists(outputRoot), false);
  assert.ok(foreignIdentity);
  assert.deepEqual(await fileIdentity(foreignTemporaryRoot), foreignIdentity);
  assert.equal(
    await readFile(join(foreignTemporaryRoot, "foreign.txt"), "utf8"),
    "foreign-temporary-content",
  );
  assert.equal(await exists(bypassRoot), true);
  await assert.rejects(
    cleanupCuaDriverStagingResidue({
      expectedResidueIdentity: error.cleanup.residueIdentity,
      outputRoot,
      residuePath: error.cleanup.residuePath,
    }),
    (cleanupError) => {
      assert.equal(cleanupError?.code, "staging_residue_identity_mismatch");
      return true;
    },
  );
  assert.deepEqual(await fileIdentity(foreignTemporaryRoot), foreignIdentity);
  assert.equal(await exists(bypassRoot), true);
});

test("post-publish verification retains concurrently added foreign content for diagnosis", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  let foreignPath;
  let temporaryRoot;
  const stage = trust.withHooks({
    afterAtomicPublishBeforeVerify: async (paths) => {
      temporaryRoot = paths.temporaryRoot;
      foreignPath = join(providerRootFor(paths.publishRoot), "foreign.txt");
      await writeFile(foreignPath, "foreign-content");
    },
  });

  await assert.rejects(
    stage({ sourceRoot, outputRoot, platform: "darwin" }),
    (error) => {
      assert.equal(error?.code, "published_stage_verification_failed");
      assert.equal(error?.published, true);
      return true;
    },
  );

  assert.equal(await exists(outputRoot), true);
  assert.equal(await readFile(foreignPath, "utf8"), "foreign-content");
  assert.equal(await exists(temporaryRoot), false);
});

test("resources-root CLI output is explicitly inspection-only", async (t) => {
  const { outputRoot } = await stagedFixture(t, "darwin");

  const result = await runNode([
    STAGING_SCRIPT,
    "--resources-root",
    outputRoot,
    "--platform",
    "darwin",
  ]);

  assert.equal(result.code, 0, result.stderr);
  const inspected = JSON.parse(result.stdout);
  assert.equal(inspected.authority, "inspection_only");
  assert.equal(inspected.platform, "darwin");
});

test("two stagers for one output serialize under the parent lease", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const temporaryRoots = [];
  let arrivals = 0;
  let releaseBoth;
  let barrierTimeout;
  const bothArrived = new Promise((resolve, reject) => {
    releaseBoth = () => {
      clearTimeout(barrierTimeout);
      resolve();
    };
    barrierTimeout = setTimeout(() => {
      reject(new Error(`stager barrier timed out with ${arrivals}/2 arrivals`));
    }, 5_000);
  });
  t.after(() => releaseBoth());
  const stage = trust.withHooks({
    afterNativePublisherPreflight: async ({ temporaryRoot }) => {
      temporaryRoots.push(temporaryRoot);
      arrivals += 1;
      if (arrivals === 2) {
        releaseBoth();
      }
      await bothArrived;
    },
  });

  const outcomes = await Promise.allSettled([
    stage({ sourceRoot, outputRoot, platform: "darwin" }),
    stage({ sourceRoot, outputRoot, platform: "darwin" }),
  ]);
  const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, "output_root_exists");
  assert.equal((await verifyCuaDriverPreSignStage({
    resourcesRoot: outputRoot,
    platform: "darwin",
  })).platform, "darwin");
  assert.equal(temporaryRoots.length, 2);
  for (const temporaryRoot of temporaryRoots) {
    assert.equal(await exists(temporaryRoot), false);
  }
  assert.equal(rejected[0].reason.cleanup, undefined);
});

test("concurrent staging failures cannot exceed the retained residue quota", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const stage = trust.withHooks({
    beforeAtomicPublish: async () => {
      throw new Error("retain under the parent lease");
    },
  });

  const errors = await Promise.all(Array.from(
    { length: 6 },
    () => captureRejection(() => stage({
      sourceRoot,
      outputRoot,
      platform: "darwin",
    })),
  ));
  assert.equal(
    errors.filter((error) => error?.cleanup?.reason === "retained_fail_closed").length,
    4,
  );
  assert.equal(
    errors.filter((error) => error?.code === "staging_residue_quota_exceeded").length,
    2,
  );
  assert.equal(
    (await readdir(root)).filter((name) => name.startsWith("stage.tmp-")).length,
    4,
  );
});

test("repeated staging failures stop at the retained residue count quota", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const stage = trust.withHooks({
    beforeAtomicPublish: async () => {
      throw new Error("repeatable staging failure");
    },
    residueLimits: { maxCount: 1 },
  });

  const first = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));
  assert.equal(first.cleanup.reason, "retained_fail_closed");
  const second = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));
  assert.equal(second?.code, "staging_residue_quota_exceeded");
  const residues = (await readdir(root)).filter((name) => name.startsWith("stage.tmp-"));
  assert.deepEqual(residues, [basename(first.cleanup.residuePath)]);
});

test("staging stops when the output parent scan exceeds its fixed entry bound", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");

  const parentEntries = Array.from(
    { length: 1_025 },
    (_, index) => join(root, `unrelated-${String(index).padStart(4, "0")}`),
  );
  for (let offset = 0; offset < parentEntries.length; offset += 128) {
    await Promise.all(parentEntries
      .slice(offset, offset + 128)
      .map((path) => writeFile(path, "unrelated")));
  }

  const error = await captureRejection(() => trust.stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));

  assert.equal(error?.code, "staging_residue_scan_limit_exceeded");
  assert.equal(await exists(outputRoot), false);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.startsWith("stage.tmp-")),
    [],
  );
});

test("aggregate residue entries are bounded across individually valid trees", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const residueNames = [
    `stage.tmp-${process.pid}-00000000-0000-4000-8000-000000000001`,
    "stage.cleanup-00000000-0000-4000-8000-000000000002",
  ];
  for (const residueName of residueNames) {
    const residuePath = join(root, residueName);
    await mkdir(residuePath, { mode: 0o700 });
    await writeFile(join(residuePath, "first.bin"), "first");
    await writeFile(join(residuePath, "second.bin"), "second");
  }
  const stage = trust.withHooks({
    residueLimits: { maxEntries: 3 },
  });

  const error = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));

  assert.equal(error?.code, "staging_residue_quota_exceeded");
  assert.equal(await exists(outputRoot), false);
  for (const residueName of residueNames) {
    assert.deepEqual((await readdir(join(root, residueName))).sort(), [
      "first.bin",
      "second.bin",
    ]);
  }
});

test("entry quota reserves the complete incoming provider tree", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  const residuePath = join(
    root,
    `stage.tmp-${process.pid}-00000000-0000-4000-8000-000000000003`,
  );
  await createSourceFixture(sourceRoot, "darwin");
  await mkdir(residuePath, { mode: 0o700 });
  await writeFile(join(residuePath, "existing.bin"), "existing");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const stage = trust.withHooks({
    residueLimits: { maxEntries: 8 },
  });

  const error = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));

  assert.equal(error?.code, "staging_residue_quota_exceeded");
  assert.equal(await exists(outputRoot), false);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.startsWith("stage.tmp-")),
    [basename(residuePath)],
  );
});

test("retained residue total-byte quota fails closed before another temp tree", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const maxTotalBytes = await packageByteTotal(sourceRoot, "darwin") + 8;
  const stage = trust.withHooks({
    beforeAtomicPublish: async () => {
      throw new Error("retain for byte quota");
    },
    residueLimits: { maxTotalBytes },
  });
  const first = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));
  assert.equal(first.cleanup.reason, "retained_fail_closed");
  await writeFile(join(first.cleanup.residuePath, "quota-overflow.bin"), Buffer.alloc(16));

  const second = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));
  assert.equal(second?.code, "staging_residue_quota_exceeded");
  const residues = (await readdir(root)).filter((name) => name.startsWith("stage.tmp-"));
  assert.deepEqual(residues, [basename(first.cleanup.residuePath)]);
});

test("invalid staging test hooks fail before a stager is created", () => {
  const trust = {
    sourceBuildVerifier: async () => ({}),
    trustedResourceRoot: resolve(tmpdir(), "ling-cua-invalid-test-trust"),
  };
  for (const configuration of [
    undefined,
    null,
    [],
    { ...trust, beforeAtomicPublish: true },
    { ...trust, afterAtomicPublishCommitConfirmed: "invalid" },
    { ...trust, afterAtomicPublishBeforeVerify: "invalid" },
    { ...trust, unexpectedHook: async () => {} },
  ]) {
    assert.throws(
      () => createCuaDriverPackageStagerForTest(configuration),
      /staging_test_configuration_invalid/u,
    );
  }
});

test("residue metadata cannot obscure an original error with a locked cleanup field", async (t) => {
  const root = await testRoot(t);
  const sourceRoot = join(root, "source");
  const outputRoot = join(root, "stage");
  await createSourceFixture(sourceRoot, "darwin");
  const trust = await createTrustedInputs(root, sourceRoot, "darwin");
  const original = new Error("phase barrier failed");
  Object.defineProperty(original, "cleanup", {
    configurable: false,
    value: "locked",
    writable: false,
  });
  const stage = trust.withHooks({
    beforeAtomicPublish: async () => {
      throw original;
    },
  });

  const error = await captureRejection(() => stage({
    sourceRoot,
    outputRoot,
    platform: "darwin",
  }));

  assert.equal(error.code, "staging_failed");
  assert.equal(error.cause, original);
  assert.match(error.message, /phase barrier failed/u);
  assert.equal(error.cleanup.outcome, "residue");
  assert.equal(error.cleanup.reason, "retained_fail_closed");
  assert.equal(await exists(error.cleanup.residuePath), true);
});

test("stage verification rejects missing, extra, UIAccess and symlinked entries", async (t) => {
  await t.test("missing required file", async (t) => {
    const { outputRoot, providerRoot } = await stagedFixture(t, "darwin");
    const missingPath = join(providerRoot, "LICENSE.md");
    await rm(missingPath);
    await assert.rejects(
      verifyCuaDriverPreSignStage({
        resourcesRoot: outputRoot,
        platform: "darwin",
      }),
      (error) => {
        assert.equal(error?.code, "provider_stage_entry_missing");
        assert.equal(error?.path, missingPath);
        return true;
      },
    );
  });

  await t.test("extra file", async (t) => {
    const { outputRoot, providerRoot } = await stagedFixture(t, "darwin");
    await writeFile(join(providerRoot, "darwin/downloader"), "unexpected");
    await assert.rejects(
      verifyCuaDriverPreSignStage({
        resourcesRoot: outputRoot,
        platform: "darwin",
      }),
      /provider_stage_extra_entry/u,
    );
  });

  await t.test("extra empty directory", async (t) => {
    const { outputRoot, providerRoot } = await stagedFixture(t, "darwin");
    await mkdir(join(providerRoot, "darwin/empty"));
    await assert.rejects(
      verifyCuaDriverPreSignStage({
        resourcesRoot: outputRoot,
        platform: "darwin",
      }),
      /provider_stage_extra_entry/u,
    );
  });

  await t.test("UIAccess payload", async (t) => {
    const { outputRoot, providerRoot } = await stagedFixture(t, "win32-x64");
    await writeFile(join(providerRoot, "win32-x64/payload/cua-driver-uia.exe"), "forbidden");
    await assert.rejects(
      verifyCuaDriverPreSignStage({
        resourcesRoot: outputRoot,
        platform: "win32-x64",
      }),
      /provider_uia_payload_forbidden/u,
    );
  });

  await t.test("symlinked provider", async (t) => {
    const root = await testRoot(t);
    const { outputRoot, providerRoot } = await stagedFixture(t, "darwin", root);
    const providerPath = join(providerRoot, "darwin/ling-cua-driver");
    const outside = join(root, "outside-provider");
    await rename(providerPath, outside);
    await symlink(outside, providerPath);
    await assert.rejects(
      verifyCuaDriverPreSignStage({
        resourcesRoot: outputRoot,
        platform: "darwin",
      }),
      /provider_reparse_forbidden/u,
    );
  });
});

test("provider tree scans reject bounded-depth, entry-flood and cumulative-size abuse", async (t) => {
  const scanners = Object.freeze([
    ["safe tree", (root) => assertSafeTree(root, root)],
    ["inventory", (root) => listTreeInventory(root)],
  ]);

  await t.test("checked-in fixed inventory fits the exact entry budget", async () => {
    await assertSafeTree(RESOURCE_SCAFFOLD, RESOURCE_SCAFFOLD);
    const inventory = await listTreeInventory(RESOURCE_SCAFFOLD);
    assert.equal(
      inventory.files.length + inventory.directories.length,
      CUA_DRIVER_PACKAGE_TREE_LIMITS.maxEntries,
    );
  });

  await t.test("depth beyond the fixed inventory", async (t) => {
    const root = await testRoot(t);
    let directory = root;
    for (let depth = 0; depth <= CUA_DRIVER_PACKAGE_TREE_LIMITS.maxDepth; depth += 1) {
      directory = join(directory, `depth-${depth}`);
      await mkdir(directory);
    }
    for (const [name, scan] of scanners) {
      await assert.rejects(scan(root), (error) => {
        assert.equal(error?.code, "provider_tree_depth_exceeded", name);
        return true;
      });
    }
  });

  await t.test("entry flood beyond the fixed inventory", async (t) => {
    const root = await testRoot(t);
    await Promise.all(Array.from(
      { length: CUA_DRIVER_PACKAGE_TREE_LIMITS.maxEntries * 16 },
      (_, index) => writeFile(join(root, `entry-${String(index).padStart(4, "0")}`), "x"),
    ));
    for (const [name, scan] of scanners) {
      await assert.rejects(scan(root), (error) => {
        assert.equal(error?.code, "provider_tree_entry_count_exceeded", name);
        return true;
      });
    }
  });

  await t.test("cumulative bytes beyond the fixed inventory", async (t) => {
    const root = await testRoot(t);
    const oversized = join(root, "oversized-provider");
    await writeFile(oversized, "x");
    await truncate(
      oversized,
      CUA_DRIVER_PACKAGE_TREE_LIMITS.maxCumulativeBytes + 1,
    );
    for (const [name, scan] of scanners) {
      await assert.rejects(scan(root), (error) => {
        assert.equal(error?.code, "provider_tree_cumulative_size_exceeded", name);
        return true;
      });
    }
  });
});

async function stagedFixture(t, platform, existingRoot) {
  const root = existingRoot ?? await testRoot(t);
  const sourceRoot = join(root, `source-${platform}`);
  const outputRoot = join(root, `stage-${platform}`);
  await createSourceFixture(sourceRoot, platform);
  const trust = await createTrustedInputs(root, sourceRoot, platform);
  await trust.stage({ sourceRoot, outputRoot, platform });
  return { root, sourceRoot, outputRoot, providerRoot: providerRootFor(outputRoot) };
}

async function createTrustedInputs(root, sourceRoot, platform, options = {}) {
  const trustedResourceRoot = join(root, `trusted-${platform}`);
  await mkdir(trustedResourceRoot, { recursive: true });
  await writeFile(
    join(trustedResourceRoot, "provider-lock.json"),
    await readFile(options.lockSourcePath ?? join(sourceRoot, "provider-lock.json")),
  );
  const sourceBuildVerifier = options.sourceBuildVerifier ?? (async () => ({
    platform,
    files: await packageDigestMap(sourceRoot, platform),
  }));
  const configuration = Object.freeze({ sourceBuildVerifier, trustedResourceRoot });
  const stage = createCuaDriverPackageStagerForTest(configuration);
  return Object.freeze({
    configuration,
    stage,
    verify: stage.verifySourceInput,
    withHooks: (hooks) => createCuaDriverPackageStagerForTest({
      ...configuration,
      ...hooks,
    }),
  });
}

async function packageDigestMap(root, platform) {
  const paths = [
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "provider-lock.json",
    platform === "darwin" ? "darwin/ling-cua-driver" : "win32-x64/payload/ling-cua-driver.exe",
  ];
  return Object.fromEntries(await Promise.all(paths.map(async (relativePath) => [
    relativePath,
    sha256(await readFile(join(root, relativePath))),
  ])));
}

function optionArgument(args, option) {
  const index = args.indexOf(option);
  assert.notEqual(index, -1, `missing ${option}`);
  assert.ok(args[index + 1], `missing value for ${option}`);
  return args[index + 1];
}

async function packageByteTotal(root, platform) {
  const paths = [
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "provider-lock.json",
    platform === "darwin" ? "darwin/ling-cua-driver" : "win32-x64/payload/ling-cua-driver.exe",
  ];
  const values = await Promise.all(paths.map((path) => readFile(join(root, path))));
  return values.reduce((total, value) => total + value.byteLength, 0);
}

async function fileIdentity(path) {
  const metadata = await lstat(path, { bigint: true });
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

async function captureRejection(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail("expected staging operation to reject");
}

async function createSourceFixture(root, platform, options = {}) {
  const license = Buffer.from("MIT fixture license\n");
  const notices = Buffer.from("Fixture dependency notices\n");
  const provider = platform === "darwin"
    ? makeArm64MachO({ minimumOSVersion: [13, 0, 0], sdkVersion: [26, 5, 0] })
    : makeWindowsPe();
  const providerPath = join(
    root,
    platform === "darwin" ? "darwin/ling-cua-driver" : "win32-x64/payload/ling-cua-driver.exe",
  );
  await mkdir(dirname(providerPath), { recursive: true });
  await writeFile(providerPath, provider);
  if (platform === "darwin") {
    await chmod(providerPath, 0o755);
  }
  await writeFile(join(root, "LICENSE.md"), license);
  await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), notices);
  await writeFile(join(root, "provider-lock.json"), `${JSON.stringify(
    packageLock(platform, provider, sha256(license)),
    null,
    2,
  )}\n`);
  await writeFile(join(root, "source-build-manifest.json"), "{}\n");
  if (platform === "win32-x64" && options.includeAudit) {
    const audit = join(root, "audit/win32-x64/cua-driver-uia.exe");
    await mkdir(dirname(audit), { recursive: true });
    await writeFile(audit, "audit-only helper");
  }
}

function packageLock(platform, provider, licenseSha256) {
  const platformName = platform === "darwin" ? "darwin" : "win32-x64";
  const platformKey = platform === "darwin" ? "darwin" : "win32X64";
  const providerSha256 = sha256(provider);
  const patchSet = {
    id: "ling-managed-embedded-v1",
    sha256: "1".repeat(64),
    patches: [
      { id: "ling-embedded-state-home-v1", sha256: "2".repeat(64) },
      { id: "ling-managed-readiness-v1", sha256: "3".repeat(64) },
      { id: "ling-managed-lifetime-v1", sha256: "4".repeat(64) },
      { id: "ling-windows-capability-errors-v1", sha256: "5".repeat(64) },
    ],
    touchedPaths: ["libs/cua-driver/rust/crates/cua-driver/src/main.rs"],
  };
  const platformRecord = {
    schemaVersion: 1,
    componentId: platform === "darwin" ? "cua-driver-darwin" : "cua-driver-win32-x64",
    integrationMode: "embedded-stdio",
    distributionRevision: "ling.1",
    productVersionLabel: "0.8.3 (Ling build 1)",
    referenceReleaseArtifact: platform === "darwin"
      ? {
          filename: "cua-driver-rs-0.8.3-darwin-universal-binary.tar.gz",
          sizeBytes: 1,
          sha256: "6".repeat(64),
          binaryArchivePath: "cua-driver",
          teamId: "YCK386LBJ7",
          authority: "Developer ID Application: Cua AI, Inc. (YCK386LBJ7)",
          hardenedRuntime: true,
          entitlementsCanonicalSha256: "7".repeat(64),
        }
      : {
          filename: "cua-driver-rs-0.8.3-windows-x86_64.zip",
          sizeBytes: 1,
          sha256: "6".repeat(64),
          binaries: {
            "cua-driver.exe": { sha256: "7".repeat(64) },
            "cua-driver-uia.exe": { sha256: "8".repeat(64) },
          },
          authenticodeStatus: "unsigned-reference",
        },
    sourceBuild: platform === "darwin"
      ? {
          cargoLockSha256: "9".repeat(64),
          rustcVersion: "1.97.1",
          cargoVersion: "1.97.1",
          xcodeBuildVersion: "17F42",
          macOSSDKVersion: "26.5",
          targets: ["aarch64-apple-darwin"],
          patchSet,
          binarySha256BeforeSigning: providerSha256,
        }
      : {
          cargoLockSha256: "9".repeat(64),
          rustcVersion: "1.97.1",
          cargoVersion: "1.97.1",
          windowsSdkVersion: "10.0.26100.0",
          msvcToolsetVersion: "14.44.35211",
          target: "x86_64-pc-windows-msvc",
          patchSet,
          binariesSha256BeforeSigning: {
            main: providerSha256,
            uiaAuditArtifact: "a".repeat(64),
          },
        },
    binary: platform === "darwin"
      ? {
          architectures: ["arm64"],
          minimumMacOS: "13.0",
          supportedMacOSCells: [{ major: "13", architectures: ["arm64"] }],
          expectedUpstreamVersion: "0.8.3",
          lingBuild: 1,
          hardenedRuntime: true,
          requiredEntitlements: {
            "com.apple.security.automation.apple-events": true,
            "com.apple.security.device.screen-capture": true,
          },
          requiredEntitlementsCanonicalSha256: "b".repeat(64),
        }
      : {
          architecture: "x86_64",
          expectedUpstreamVersion: "0.8.3",
          lingBuild: 1,
          mainRelativePath: "payload/ling-cua-driver.exe",
          providerSealRelativePath: "payload/provider-seal.json",
          mainManifestCanonicalSha256: inspectWindowsPe(provider).manifest.sha256,
          integrityCatalogRelativePathBySigningTier: {
            unsigned_dev: null,
            test_signed_internal: "provider-integrity.cat",
            production_signed: "provider-integrity.cat",
          },
          packagedFilesBySigningTier: {
            unsigned_dev: ["payload/ling-cua-driver.exe", "payload/provider-seal.json"],
            test_signed_internal: [
              "provider-integrity.cat",
              "payload/ling-cua-driver.exe",
              "payload/provider-seal.json",
            ],
            production_signed: [
              "provider-integrity.cat",
              "payload/ling-cua-driver.exe",
              "payload/provider-seal.json",
            ],
          },
          uiaAuditArtifact: {
            packaged: false,
            relativeBuildOutput: "cua-driver-uia.exe",
            manifestCanonicalSha256: "c".repeat(64),
            requestedExecutionLevel: "asInvoker",
            uiAccess: true,
          },
        },
    runtime: platform === "darwin"
      ? {
          args: ["mcp", "--embedded", "--host-bundle-id", "com.lingstack.desktop"],
          stateHomeEnvironmentVariable: "CUA_DRIVER_STATE_HOME",
          stateSchemaVersion: 1,
          stateHomeRequiredInEmbeddedMode: true,
          telemetryEnabled: false,
          startupUpdateCheckEnabled: false,
          managedUpdaterToolsAllowed: false,
        }
      : {
          args: ["mcp", "--embedded", "--host-bundle-id", "com.lingstack.desktop"],
          requiredSession: "interactive-user",
          rejectSessionZero: true,
          stateHomeEnvironmentVariable: "CUA_DRIVER_STATE_HOME",
          stateSchemaVersion: 1,
          telemetryEnabled: false,
          startupUpdateCheckEnabled: false,
          managedUpdaterToolsAllowed: false,
          defaultIntegrityCoverage: "standard",
          managedReadinessMethod: "ling/managed_readiness",
          managedReadinessChangedNotification: "ling/managed_readiness_changed",
          childInstanceNonceEnvironmentVariable: "CUA_DRIVER_CHILD_INSTANCE_NONCE",
          leaseGenerationEnvironmentVariable: "CUA_DRIVER_LEASE_GENERATION",
          readinessHeartbeatMs: 1000,
          requiredHostIntegrityLevel: "medium",
          requiredProviderIntegrityLevel: "medium",
          killOnJobCloseRequired: true,
          limitations: ["elevated_pixel_input", "uwp_send_input"],
          uiaHelperActivation: "not-packaged-until-secure-path-contract",
        },
    compatibility: {
      mcpClientSdk: "@modelcontextprotocol/sdk@1.29.0",
      clientInitializeProtocolVersion: "2025-11-25",
      serverInitializeProtocolVersion: "2025-06-18",
      healthSchemaVersion: "1",
      ...(platform === "darwin" ? { embeddedHealthSkipChecks: ["bundle_identity"] } : {}),
      toolsListSha256: "d".repeat(64),
    },
  };
  return {
    schemaVersion: 2,
    componentId: "cua-driver",
    distributionRevision: "ling.1",
    upstream: {
      repository: "https://github.com/trycua/cua",
      tag: "cua-driver-rs-v0.8.3",
      commit: "0612c26b2c7b8556f6de7f6b4f3927ecac914e4f",
      tree: "831819eaf2b79c4d81c2b68773cd5920772e91e9",
      version: "0.8.3",
      releaseStage: "prerelease",
      license: "MIT",
      licenseSha256,
    },
    enabledPlatforms: [platformName],
    platforms: { [platformKey]: platformRecord },
  };
}

async function rewriteLockDigest(root, platform, digest) {
  const path = join(root, "provider-lock.json");
  const lock = JSON.parse(await readFile(path, "utf8"));
  if (platform === "darwin") {
    lock.platforms.darwin.sourceBuild.binarySha256BeforeSigning = digest;
  } else {
    lock.platforms.win32X64.sourceBuild.binariesSha256BeforeSigning.main = digest;
  }
  await writeFile(path, `${JSON.stringify(lock, null, 2)}\n`);
}

function makeArm64MachO({ minimumOSVersion = [13, 0, 0], sdkVersion = [26, 5, 0] } = {}) {
  const buffer = Buffer.alloc(56);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(0x0100000c, 4);
  buffer.writeUInt32LE(0x2, 12);
  buffer.writeUInt32LE(1, 16);
  buffer.writeUInt32LE(24, 20);
  buffer.writeUInt32LE(0x32, 32);
  buffer.writeUInt32LE(24, 36);
  buffer.writeUInt32LE(1, 40);
  buffer.writeUInt32LE(packAppleVersion(minimumOSVersion), 44);
  buffer.writeUInt32LE(packAppleVersion(sdkVersion), 48);
  return buffer;
}

function duplicateFirstBuildVersion(bytes) {
  const commandSize = 24;
  const expanded = Buffer.alloc(bytes.length + commandSize);
  bytes.copy(expanded);
  bytes.copy(expanded, bytes.length, 32, 32 + commandSize);
  expanded.writeUInt32LE(2, 16);
  expanded.writeUInt32LE(commandSize * 2, 20);
  return expanded;
}

function makeWindowsPe({ machine = 0x8664, signed = false } = {}) {
  const manifest = Buffer.from(
    '<assembly><trustInfo><security><requestedPrivileges><requestedExecutionLevel level="asInvoker" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>',
    "utf8",
  );
  const buffer = Buffer.alloc(0x800);
  const peOffset = 0x80;
  const optionalHeaderOffset = peOffset + 24;
  const optionalHeaderSize = 0xf0;
  const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
  const resourceOffset = 0x200;
  const resourceRva = 0x1000;
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(peOffset, 0x3c);
  buffer.write("PE\0\0", peOffset, "binary");
  buffer.writeUInt16LE(machine, peOffset + 4);
  buffer.writeUInt16LE(1, peOffset + 6);
  buffer.writeUInt16LE(optionalHeaderSize, peOffset + 20);
  buffer.writeUInt16LE(0x20b, optionalHeaderOffset);
  const dataDirectoryOffset = optionalHeaderOffset + 112;
  buffer.writeUInt32LE(resourceRva, dataDirectoryOffset + 2 * 8);
  buffer.writeUInt32LE(0x200, dataDirectoryOffset + 2 * 8 + 4);
  buffer.writeUInt32LE(0x400, sectionTableOffset + 8);
  buffer.writeUInt32LE(resourceRva, sectionTableOffset + 12);
  buffer.writeUInt32LE(0x400, sectionTableOffset + 16);
  buffer.writeUInt32LE(resourceOffset, sectionTableOffset + 20);

  writeResourceDirectory(buffer, resourceOffset, 24, 0x80000020);
  writeResourceDirectory(buffer, resourceOffset + 0x20, 1, 0x80000040);
  writeResourceDirectory(buffer, resourceOffset + 0x40, 1033, 0x60);
  buffer.writeUInt32LE(resourceRva + 0x80, resourceOffset + 0x60);
  buffer.writeUInt32LE(manifest.byteLength, resourceOffset + 0x64);
  manifest.copy(buffer, resourceOffset + 0x80);
  setPeCertificateTable(buffer, signed);
  return buffer;
}

function writeResourceDirectory(buffer, offset, id, target) {
  buffer.writeUInt16LE(1, offset + 14);
  buffer.writeUInt32LE(id, offset + 16);
  buffer.writeUInt32LE(target, offset + 20);
}

function setPeCertificateTable(buffer, present) {
  const peOffset = buffer.readUInt32LE(0x3c);
  const optionalHeaderOffset = peOffset + 24;
  const certificateDirectoryOffset = optionalHeaderOffset + 112 + 4 * 8;
  buffer.writeUInt32LE(present ? 0x700 : 0, certificateDirectoryOffset);
  buffer.writeUInt32LE(present ? 0x20 : 0, certificateDirectoryOffset + 4);
}

function packAppleVersion([major, minor, patch]) {
  return (major << 16) | (minor << 8) | patch;
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing child argument ${name}`);
  return args[index + 1];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function testRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-package-staging-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function runNode(args) {
  try {
    const result = await execFile(process.execPath, args, {
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: `${error.stderr ?? ""}${error.message ?? ""}`,
    };
  }
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
