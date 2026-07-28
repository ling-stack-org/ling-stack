import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { createDarwinCandidateExecutableRestorerForTest } from "../scripts/cua-driver-source-build-darwin-executable.mjs";
import {
  createCuaDriverSourceBuildPromoterForTest,
  createPlatformRecord,
  createProposedProviderLock,
  promoteCuaDriverSourceBuild,
} from "../scripts/cua-driver-source-build-promotion-lib.mjs";
import {
  createPromotionOutputPublisherForTest,
  preparePromotionOutput,
} from "../scripts/cua-driver-source-build-promotion-publish.mjs";
import { parsePromotionArgs } from "../scripts/promote-cua-driver-source-build.mjs";

const COMMITTED_RESOURCE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../resources/providers/cua-driver/0.8.3-ling.1",
);
const RESOURCE_FIXTURE_PARENT = await mkdtemp(
  join(tmpdir(), "ling-cua-promotion-resources-"),
);
after(() => rm(RESOURCE_FIXTURE_PARENT, { recursive: true, force: true }));
const RESOURCE_ROOT = join(RESOURCE_FIXTURE_PARENT, "unpromoted");
await cp(COMMITTED_RESOURCE_ROOT, RESOURCE_ROOT, { recursive: true });
const unpromotedProviderLockPath = join(RESOURCE_ROOT, "provider-lock.json");
const unpromotedProviderLock = JSON.parse(
  await readFile(unpromotedProviderLockPath, "utf8"),
);
unpromotedProviderLock.enabledPlatforms = [];
unpromotedProviderLock.platforms = {};
await writeFile(
  unpromotedProviderLockPath,
  `${JSON.stringify(unpromotedProviderLock, null, 2)}\n`,
);
const UNPROMOTED_PROVIDER_LOCK_SHA256 = sha256(
  await readFile(unpromotedProviderLockPath),
);
const DIGEST = "d".repeat(64);

function createFixturePromoter(verifyCandidate) {
  return createCuaDriverSourceBuildPromoterForTest(verifyCandidate, {
    expectedProviderLockSha256: UNPROMOTED_PROVIDER_LOCK_SHA256,
  });
}

test("promotion CLI requires two candidates and rejects unknown or duplicate options", () => {
  assert.deepEqual(
    parsePromotionArgs([
      "--platform", "darwin",
      "--candidate-a", "/tmp/a",
      "--candidate-b", "/tmp/b",
      "--output-dir", "/tmp/out",
    ]),
    {
      platform: "darwin",
      "candidate-a": "/tmp/a",
      "candidate-b": "/tmp/b",
      "output-dir": "/tmp/out",
    },
  );
  assert.throws(
    () => parsePromotionArgs([
      "--platform", "darwin",
      "--candidate-a", "/tmp/a",
      "--output-dir", "/tmp/out",
    ]),
    /--candidate-b is required/u,
  );
  assert.throws(
    () => parsePromotionArgs([
      "--platform", "darwin",
      "--candidate-a", "/tmp/a",
      "--candidate-a", "/tmp/a2",
      "--candidate-b", "/tmp/b",
      "--output-dir", "/tmp/out",
    ]),
    /duplicate option/u,
  );
  assert.throws(
    () => parsePromotionArgs([
      "--platform", "darwin",
      "--candidate-a", "/tmp/a",
      "--candidate-b", "/tmp/b",
      "--output-dir", "/tmp/out",
      "--verifier", "/tmp/attacker",
    ]),
    /unknown option/u,
  );
});

test("production promotion API does not accept a verifier trust override", async () => {
  await assert.rejects(
    promoteCuaDriverSourceBuild({
      platform: "darwin",
      candidateA: "/tmp/a",
      candidateB: "/tmp/b",
      outputDir: "/tmp/out",
      verifyCandidate: async () => ({ ok: true }),
    }),
    /promotion_trust_override_forbidden/u,
  );
  const foreignPlatform = process.platform === "darwin" ? "win32-x64" : "darwin";
  await assert.rejects(
    promoteCuaDriverSourceBuild({
      platform: foreignPlatform,
      candidateA: "/tmp/a",
      candidateB: "/tmp/b",
      outputDir: "/tmp/out",
    }),
    /promotion_host_platform_mismatch/u,
  );
});

test("Darwin promotion safely restores or preserves execute permission at the artifact boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-promotion-executable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateA = await createCandidate(join(root, "a"), "darwin");
  const candidateB = await createCandidate(join(root, "b"), "darwin");
  const binaryA = join(candidateA.root, "darwin/ling-cua-driver");
  const binaryB = join(candidateB.root, "darwin/ling-cua-driver");
  const bytesA = await readFile(binaryA);
  const bytesB = await readFile(binaryB);
  await chmod(binaryA, 0o644);
  await chmod(binaryB, 0o644);

  let verifierCalls = 0;
  const promoter = createFixturePromoter(async (input) => {
    const metadata = await lstat(join(input.candidateRoot, "darwin/ling-cua-driver"));
    assert.equal(metadata.mode & 0o100, 0o100);
    verifierCalls += 1;
    return fixtureVerifier(input);
  });
  const result = await promoter({
    platform: "darwin",
    candidateA: candidateA.root,
    candidateB: candidateB.root,
    outputDir: join(root, "promotion"),
    resourceRoot: RESOURCE_ROOT,
  });

  assert.equal(result.ok, true);
  assert.equal(verifierCalls, 2);
  assert.deepEqual(await readFile(binaryA), bytesA);
  assert.deepEqual(await readFile(binaryB), bytesB);
  assert.equal((await lstat(binaryA)).mode & 0o777, 0o744);
  assert.equal((await lstat(binaryB)).mode & 0o777, 0o744);

  await chmod(binaryA, 0o755);
  await chmod(binaryB, 0o755);
  const idempotent = await promoter({
    platform: "darwin",
    candidateA: candidateA.root,
    candidateB: candidateB.root,
    outputDir: join(root, "promotion-idempotent"),
    resourceRoot: RESOURCE_ROOT,
  });
  assert.equal(idempotent.ok, true);
  assert.equal(verifierCalls, 4);
  assert.equal((await lstat(binaryA)).mode & 0o777, 0o755);
  assert.equal((await lstat(binaryB)).mode & 0o777, 0o755);
});

test("Darwin execute permission repair rejects unsafe candidate entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-promotion-executable-unsafe-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const fixture of [
    {
      name: "root-symlink",
      expected: /promotion_candidate_root_symlink_forbidden/u,
      prepareCandidateRoot: async (candidateRoot, fixtureRoot) => {
        const alias = join(fixtureRoot, "candidate-alias");
        await symlink(candidateRoot, alias);
        return alias;
      },
    },
    {
      name: "intermediate-symlink",
      expected: /promotion_candidate_executable_symlink_forbidden/u,
      replace: async (path) => {
        const directory = dirname(path);
        const target = `${directory}-real`;
        await rename(directory, target);
        await symlink(target, directory);
      },
    },
    {
      name: "symlink",
      expected: /promotion_candidate_executable_symlink_forbidden/u,
      replace: async (path, outside) => {
        await rm(path);
        await symlink(outside, path);
      },
    },
    {
      name: "hardlink",
      expected: /promotion_candidate_executable_hardlink_forbidden/u,
      replace: async (path, outside) => {
        await rm(path);
        await link(outside, path);
      },
    },
    {
      name: "directory",
      expected: /promotion_candidate_executable_non_regular/u,
      replace: async (path) => {
        await rm(path);
        await mkdir(path);
      },
    },
    {
      name: "missing",
      expected: /promotion_candidate_executable_missing/u,
      replace: async (path) => rm(path),
    },
    {
      name: "group-world-writable",
      expected: /promotion_candidate_executable_mode_unsafe/u,
      replace: async (path) => chmod(path, 0o666),
    },
  ]) {
    await t.test(fixture.name, async () => {
      const fixtureRoot = join(root, fixture.name);
      const candidateA = await createCandidate(join(fixtureRoot, "a"), "darwin");
      const candidateB = await createCandidate(join(fixtureRoot, "b"), "darwin");
      const outside = join(fixtureRoot, "outside-cua-driver");
      await writeFile(outside, "fixture-darwin-main");
      const candidateARoot = await fixture.prepareCandidateRoot?.(
        candidateA.root,
        fixtureRoot,
      ) ?? candidateA.root;
      await fixture.replace?.(join(candidateA.root, "darwin/ling-cua-driver"), outside);
      let verifierCalls = 0;
      await assert.rejects(
        createFixturePromoter(async (input) => {
          verifierCalls += 1;
          return fixtureVerifier(input);
        })({
          platform: "darwin",
          candidateA: candidateARoot,
          candidateB: candidateB.root,
          outputDir: join(fixtureRoot, "promotion"),
          resourceRoot: RESOURCE_ROOT,
        }),
        fixture.expected,
      );
      assert.equal(verifierCalls, 0);
    });
  }
});

test("Darwin execute permission repair rejects deterministic path replacement races", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-promotion-executable-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  for (const hookName of ["afterRootLstat", "afterOpen", "afterModeRepair"]) {
    await t.test(hookName, async () => {
      const candidateRoot = join(root, hookName);
      const movedRoot = `${candidateRoot}-opened`;
      const executablePath = join(candidateRoot, "darwin/ling-cua-driver");
      const displacedPath = join(candidateRoot, "darwin/ling-cua-driver-opened");
      await mkdir(dirname(executablePath), { recursive: true });
      await writeFile(executablePath, "original", { mode: 0o644 });
      const restore = createDarwinCandidateExecutableRestorerForTest({
        [hookName]: async () => {
          if (hookName === "afterRootLstat") {
            await rename(candidateRoot, movedRoot);
            await mkdir(dirname(executablePath), { recursive: true });
          } else {
            await rename(executablePath, displacedPath);
          }
          await writeFile(executablePath, "replacement", { mode: 0o644 });
        },
      });

      await assert.rejects(
        restore(candidateRoot),
        hookName === "afterRootLstat"
          ? /promotion_candidate_root_changed/u
          : /promotion_candidate_executable_changed/u,
      );
      const originalPath = hookName === "afterRootLstat"
        ? join(movedRoot, "darwin/ling-cua-driver")
        : displacedPath;
      assert.equal(
        (await lstat(originalPath)).mode & 0o777,
        hookName === "afterModeRepair" ? 0o744 : 0o644,
      );
      assert.equal((await lstat(executablePath)).mode & 0o777, 0o644);
    });
  }
});

test("promotion output failure cleanup is identity-bound and preserves the original error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-promotion-output-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = {
    proposedProviderLockBytes: Buffer.from("{}\n"),
    promotionReceiptBytes: Buffer.from("{}\n"),
  };

  await t.test("private temporary tree is removed after a later failure", async () => {
    const outputParent = join(root, "private-output");
    await mkdir(outputParent);
    const outputRoot = join(outputParent, "promotion");
    const outputAuthority = await preparePromotionOutput(outputRoot);
    const publish = createPromotionOutputPublisherForTest({
      afterPrivateSecured: async () => {
        throw new Error("fixture-private-failure");
      },
    });
    await assert.rejects(
      publish({ outputAuthority, ...bytes }),
      /fixture-private-failure/u,
    );
    assert.deepEqual(await readdir(outputParent), []);
  });

  await t.test("unsecured empty temporary tree is removed by exact identity", async () => {
    const outputParent = join(root, "unsecured-output");
    await mkdir(outputParent);
    const outputRoot = join(outputParent, "promotion");
    const outputAuthority = await preparePromotionOutput(outputRoot);
    const publish = createPromotionOutputPublisherForTest({
      afterTemporaryIdentityBeforeSecure: async () => {
        throw new Error("fixture-unsecured-failure");
      },
    });
    await assert.rejects(
      publish({ outputAuthority, ...bytes }),
      /fixture-unsecured-failure/u,
    );
    assert.deepEqual(await readdir(outputParent), []);
  });

  await t.test("cleanup failure cannot replace the promotion error", async () => {
    const outputParent = join(root, "cleanup-failure-output");
    await mkdir(outputParent);
    const outputRoot = join(outputParent, "promotion");
    const outputAuthority = await preparePromotionOutput(outputRoot);
    const publish = createPromotionOutputPublisherForTest({
      afterFilesWritten: async ({ temporaryRoot }) => {
        await writeFile(join(temporaryRoot, "unexpected.json"), "{}\n");
      },
    });
    await assert.rejects(
      publish({ outputAuthority, ...bytes }),
      (error) => {
        assert.match(error.message, /promotion_output_inventory_invalid/u);
        assert(error.promotionCleanupError instanceof Error);
        assert.match(error.promotionResiduePath, /promotion\.tmp-/u);
        return true;
      },
    );
    await assert.rejects(readFile(outputRoot), /ENOENT/u);
    assert.equal((await readdir(outputParent)).length, 1);
  });

  await t.test("post-commit verification failure never deletes the published directory", async () => {
    const outputParent = join(root, "post-commit-output");
    await mkdir(outputParent);
    const outputRoot = join(outputParent, "promotion");
    const outputAuthority = await preparePromotionOutput(outputRoot);
    const publish = createPromotionOutputPublisherForTest({
      afterAtomicPublish: async ({ outputRoot: publishedRoot }) => {
        await writeFile(join(publishedRoot, "unexpected.json"), "{}\n");
      },
    });
    await assert.rejects(
      publish({ outputAuthority, ...bytes }),
      (error) => {
        assert.match(error.message, /promotion_output_inventory_invalid/u);
        assert.equal("promotionCleanupError" in error, false);
        return true;
      },
    );
    assert.deepEqual(
      (await readdir(outputRoot)).sort(),
      [
        "provider-lock.json",
        "source-build-promotion-receipt.json",
        "unexpected.json",
      ],
    );
  });
});

test("Darwin promotion emits a review-only lock proposal and incremental Windows merge preserves it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-promotion-success-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const darwinA = await createCandidate(join(root, "darwin-a"), "darwin");
  const darwinB = await createCandidate(join(root, "darwin-b"), "darwin");
  const resourcesBefore = await snapshotTree(RESOURCE_ROOT);
  const candidateABefore = await snapshotTree(darwinA.root);
  const candidateBBefore = await snapshotTree(darwinB.root);
  const promoter = createFixturePromoter(fixtureVerifier);
  const darwinOutput = join(root, "darwin-promotion");
  const result = await promoter({
    platform: "darwin",
    candidateA: darwinA.root,
    candidateB: darwinB.root,
    outputDir: darwinOutput,
    resourceRoot: RESOURCE_ROOT,
  });
  const swapped = await promoter({
    platform: "darwin",
    candidateA: darwinB.root,
    candidateB: darwinA.root,
    outputDir: join(root, "darwin-promotion-swapped"),
    resourceRoot: RESOURCE_ROOT,
  });
  assert.equal(result.ok, true);
  assert.equal(result.promotionStatus, "MANUAL_REVIEW_REQUIRED");
  const darwinLock = JSON.parse(await readFile(result.proposedLockPath, "utf8"));
  assert.equal(
    await readFile(result.proposedLockPath, "utf8"),
    await readFile(swapped.proposedLockPath, "utf8"),
  );
  assert.deepEqual(
    (await readdir(darwinOutput)).sort(),
    ["provider-lock.json", "source-build-promotion-receipt.json"],
  );
  assert.deepEqual(darwinLock.enabledPlatforms, ["darwin"]);
  assert.deepEqual(
    darwinLock.platforms.darwin.binary.supportedMacOSCells.map((cell) => cell.major),
    ["13", "14", "15", "26"],
  );
  assert.equal(
    darwinLock.platforms.darwin.binary.requiredEntitlementsCanonicalSha256,
    "5c301f02f6b64d3feb13c1b0f29f4135174132b33a828b85264aee8b8a5ac7ac",
  );
  assert.deepEqual(
    Object.keys(darwinLock.platforms.darwin.sourceBuild.patchSet.patches[0]).sort(),
    ["id", "sha256"],
  );
  const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
  assert.deepEqual(Object.keys(receipt).sort(), [
    "baseProviderLockSha256",
    "candidateEvidence",
    "kind",
    "nextNativeBuild",
    "platform",
    "platformRecordSha256",
    "preservedEnabledPlatforms",
    "promotionStatus",
    "proposedProviderLockSha256",
    "reviewBlockers",
    "schemaVersion",
    "sourceBuildInputsMutation",
    "sourceBuildInputsSha256",
    "stableArtifactDigests",
  ]);
  assert.equal(receipt.sourceBuildInputsMutation, "forbidden");
  assert.equal(receipt.reviewBlockers.length, 2);
  assert.deepEqual(receipt.nextNativeBuild, {
    required: true,
    providerLockSha256: result.proposedProviderLockSha256,
    candidateEvidenceReusable: false,
  });
  assert.equal(darwinA.promotion.providerLockSha256 === result.proposedProviderLockSha256, false);
  assert.equal("releaseReady" in receipt, false);
  assert.equal("promotionVerdict" in receipt, false);
  await assert.rejects(
    readFile(join(darwinOutput, "source-build-inputs.json")),
    /ENOENT/u,
  );
  assert.deepEqual(await snapshotTree(RESOURCE_ROOT), resourcesBefore);
  assert.deepEqual(await snapshotTree(darwinA.root), candidateABefore);
  assert.deepEqual(await snapshotTree(darwinB.root), candidateBBefore);

  const windows = await createCandidate(join(root, "windows-record"), "win32-x64");
  const windowsRecord = createPlatformRecord({
    evidence: {
      promotion: windows.promotion,
    },
    platform: "win32-x64",
    sourceInputs: windows.sourceInputs,
  });
  const combined = createProposedProviderLock({
    baseLock: darwinLock,
    platform: "win32-x64",
    platformRecord: windowsRecord,
  });
  assert.deepEqual(combined.enabledPlatforms, ["darwin", "win32-x64"]);
  assert.deepEqual(combined.platforms.darwin, darwinLock.platforms.darwin);
  assert.equal(combined.platforms.win32X64.binary.uiaAuditArtifact.packaged, false);
  assert.throws(
    () => createProposedProviderLock({
      baseLock: darwinLock,
      platform: "darwin",
      platformRecord: darwinLock.platforms.darwin,
    }),
    /platform_already_promoted/u,
  );
});

test("Windows promotion records standard payload and keeps UIAccess audit-only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-promotion-windows-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateA = await createCandidate(join(root, "a"), "win32-x64");
  const candidateB = await createCandidate(join(root, "b"), "win32-x64");
  const result = await createFixturePromoter(fixtureVerifier)({
    platform: "win32-x64",
    candidateA: candidateA.root,
    candidateB: candidateB.root,
    outputDir: join(root, "promotion"),
    resourceRoot: RESOURCE_ROOT,
  });
  const lock = JSON.parse(await readFile(result.proposedLockPath, "utf8"));
  assert.deepEqual(lock.enabledPlatforms, ["win32-x64"]);
  assert.deepEqual(
    lock.platforms.win32X64.binary.packagedFilesBySigningTier.test_signed_internal,
    [
      "provider-integrity.cat",
      "payload/ling-cua-driver.exe",
      "payload/provider-seal.json",
    ],
  );
  assert.equal(lock.platforms.win32X64.binary.uiaAuditArtifact.packaged, false);
  assert.equal(
    lock.platforms.win32X64.sourceBuild.binariesSha256BeforeSigning.uiaAuditArtifact,
    candidateA.binaryDigests["uia-audit"],
  );
});

test("committed Darwin promotion cannot overwrite its reviewed platform record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-promotion-committed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateA = await createCandidate(join(root, "a"), "darwin", {
    resourceRoot: COMMITTED_RESOURCE_ROOT,
  });
  const candidateB = await createCandidate(join(root, "b"), "darwin", {
    resourceRoot: COMMITTED_RESOURCE_ROOT,
  });
  await assert.rejects(
    createCuaDriverSourceBuildPromoterForTest(fixtureVerifier)({
      platform: "darwin",
      candidateA: candidateA.root,
      candidateB: candidateB.root,
      outputDir: join(root, "promotion"),
      resourceRoot: COMMITTED_RESOURCE_ROOT,
    }),
    /platform_already_promoted/u,
  );
});

test("promotion fails closed for mismatched, mixed, extra, cross-platform, UIAccess and final-identity evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-promotion-failures-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const promoter = createFixturePromoter(fixtureVerifier);

  await t.test("same or nested candidate roots", async () => {
    const candidate = await createCandidate(join(root, "same"), "darwin");
    await assert.rejects(
      promoter({
        platform: "darwin",
        candidateA: candidate.root,
        candidateB: candidate.root,
        outputDir: join(root, "same-output"),
        resourceRoot: RESOURCE_ROOT,
      }),
      /promotion_roots_overlap/u,
    );
  });

  await t.test("different stable artifact maps and tools digests", async () => {
    const candidateA = await createCandidate(join(root, "map-a"), "darwin");
    const candidateB = await createCandidate(join(root, "map-b"), "darwin", {
      toolsDigest: "e".repeat(64),
    });
    await assert.rejects(
      promoter({
        platform: "darwin",
        candidateA: candidateA.root,
        candidateB: candidateB.root,
        outputDir: join(root, "map-output"),
        resourceRoot: RESOURCE_ROOT,
      }),
      /candidate_artifact_digest_mismatch/u,
    );
  });

  await t.test("cross-platform candidate", async () => {
    const candidateA = await createCandidate(join(root, "cross-a"), "darwin");
    const candidateB = await createCandidate(join(root, "cross-b"), "win32-x64");
    await assert.rejects(
      promoter({
        platform: "darwin",
        candidateA: candidateA.root,
        candidateB: candidateB.root,
        outputDir: join(root, "cross-output"),
        resourceRoot: RESOURCE_ROOT,
      }),
      /promotion_candidate_executable_missing/u,
    );
  });

  await t.test("mixed provider lock", async () => {
    const candidateA = await createCandidate(join(root, "lock-a"), "darwin");
    const candidateB = await createCandidate(join(root, "lock-b"), "darwin", {
      mutateProviderLock: true,
    });
    await assert.rejects(
      promoter({
        platform: "darwin",
        candidateA: candidateA.root,
        candidateB: candidateB.root,
        outputDir: join(root, "lock-output"),
        resourceRoot: RESOURCE_ROOT,
      }),
      /candidate_input_digest_mismatch/u,
    );
  });

  await t.test("extra candidate file", async () => {
    const candidateA = await createCandidate(join(root, "extra-a"), "darwin");
    const candidateB = await createCandidate(join(root, "extra-b"), "darwin", {
      extraFile: true,
    });
    await assert.rejects(
      promoter({
        platform: "darwin",
        candidateA: candidateA.root,
        candidateB: candidateB.root,
        outputDir: join(root, "extra-output"),
        resourceRoot: RESOURCE_ROOT,
      }),
      /candidate_inventory_mismatch/u,
    );
  });

  await t.test("UIAccess helper marked packaged", async () => {
    const candidateA = await createCandidate(join(root, "uia-a"), "win32-x64", {
      uiaPackaged: true,
    });
    const candidateB = await createCandidate(join(root, "uia-b"), "win32-x64", {
      uiaPackaged: true,
    });
    await assert.rejects(
      promoter({
        platform: "win32-x64",
        candidateA: candidateA.root,
        candidateB: candidateB.root,
        outputDir: join(root, "uia-output"),
        resourceRoot: RESOURCE_ROOT,
      }),
      /candidate_uia_packaged/u,
    );
  });

  await t.test("candidate fabricates final identity", async () => {
    const candidateA = await createCandidate(join(root, "identity-a"), "darwin", {
      missingFinalIdentity: [],
    });
    const candidateB = await createCandidate(join(root, "identity-b"), "darwin", {
      missingFinalIdentity: [],
    });
    await assert.rejects(
      promoter({
        platform: "darwin",
        candidateA: candidateA.root,
        candidateB: candidateB.root,
        outputDir: join(root, "identity-output"),
        resourceRoot: RESOURCE_ROOT,
      }),
      /candidate_final_identity_invalid/u,
    );
  });

  await t.test("candidate opens its own promotion gate", async () => {
    const candidateA = await createCandidate(join(root, "gate-a"), "darwin", {
      promotionEligible: true,
    });
    const candidateB = await createCandidate(join(root, "gate-b"), "darwin", {
      promotionEligible: true,
    });
    await assert.rejects(
      promoter({
        platform: "darwin",
        candidateA: candidateA.root,
        candidateB: candidateB.root,
        outputDir: join(root, "gate-output"),
        resourceRoot: RESOURCE_ROOT,
      }),
      /candidate_promotion_gate_invalid/u,
    );
  });

  await t.test("candidate changes the locked Rust toolchain", async () => {
    const candidateA = await createCandidate(join(root, "toolchain-a"), "darwin", {
      rustcVersion: "9.9.9",
    });
    const candidateB = await createCandidate(join(root, "toolchain-b"), "darwin", {
      rustcVersion: "9.9.9",
    });
    await assert.rejects(
      promoter({
        platform: "darwin",
        candidateA: candidateA.root,
        candidateB: candidateB.root,
        outputDir: join(root, "toolchain-output"),
        resourceRoot: RESOURCE_ROOT,
      }),
      /promotion_toolchain_binding_invalid/u,
    );
  });

  await t.test("Windows pre-sign evidence contains a certificate table", async () => {
    const candidateA = await createCandidate(join(root, "signed-a"), "win32-x64", {
      certificateTablePresent: true,
    });
    const candidateB = await createCandidate(join(root, "signed-b"), "win32-x64", {
      certificateTablePresent: true,
    });
    await assert.rejects(
      promoter({
        platform: "win32-x64",
        candidateA: candidateA.root,
        candidateB: candidateB.root,
        outputDir: join(root, "signed-output"),
        resourceRoot: RESOURCE_ROOT,
      }),
      /promotion_windows_binary_identity_invalid/u,
    );
  });

  await t.test("promotion never overwrites an existing output directory", async () => {
    const candidateA = await createCandidate(join(root, "existing-a"), "darwin");
    const candidateB = await createCandidate(join(root, "existing-b"), "darwin");
    const output = join(root, "existing-output");
    await mkdir(output);
    await assert.rejects(
      promoter({
        platform: "darwin",
        candidateA: candidateA.root,
        candidateB: candidateB.root,
        outputDir: output,
        resourceRoot: RESOURCE_ROOT,
      }),
      /promotion_output_exists/u,
    );
  });

  await t.test("candidate metadata changes after verifier completion", async () => {
    const candidateA = await createCandidate(join(root, "race-a"), "darwin");
    const candidateB = await createCandidate(join(root, "race-b"), "darwin");
    let calls = 0;
    const mutatingPromoter = createFixturePromoter(async (input) => {
      const receipt = await fixtureVerifier(input);
      calls += 1;
      if (calls === 1) {
        const path = join(input.candidateRoot, "source-build-attestation.json");
        const value = JSON.parse(await readFile(path, "utf8"));
        value.unverified = true;
        await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
      }
      return receipt;
    });
    await assert.rejects(
      mutatingPromoter({
        platform: "darwin",
        candidateA: candidateA.root,
        candidateB: candidateB.root,
        outputDir: join(root, "race-output"),
        resourceRoot: RESOURCE_ROOT,
      }),
      /candidate_changed_after_verification/u,
    );
  });

  await t.test("output parent replacement during verification cannot receive proposal bytes", async () => {
    const candidateA = await createCandidate(join(root, "parent-swap-a"), "darwin");
    const candidateB = await createCandidate(join(root, "parent-swap-b"), "darwin");
    const outputParent = join(root, "parent-swap-output");
    const movedParent = join(root, "parent-swap-output-moved");
    await mkdir(outputParent);
    let calls = 0;
    const parentReplacingPromoter = createFixturePromoter(async (input) => {
      const receipt = await fixtureVerifier(input);
      calls += 1;
      if (calls === 2) {
        await rename(outputParent, movedParent);
        await mkdir(outputParent);
      }
      return receipt;
    });
    await assert.rejects(
      parentReplacingPromoter({
        platform: "darwin",
        candidateA: candidateA.root,
        candidateB: candidateB.root,
        outputDir: join(outputParent, "promotion"),
        resourceRoot: RESOURCE_ROOT,
      }),
      /promotion_output_parent_changed/u,
    );
    assert.deepEqual(await readdir(outputParent), []);
    assert.deepEqual(await readdir(movedParent), []);
  });

  await t.test("verifier receipt points at a foreign attestation", async () => {
    const candidateA = await createCandidate(join(root, "foreign-a"), "darwin");
    const candidateB = await createCandidate(join(root, "foreign-b"), "darwin");
    const foreignPathPromoter = createFixturePromoter(async (input) => ({
      ...await fixtureVerifier(input),
      attestation: join(root, "foreign-attestation.json"),
    }));
    await assert.rejects(
      foreignPathPromoter({
        platform: "darwin",
        candidateA: candidateA.root,
        candidateB: candidateB.root,
        outputDir: join(root, "foreign-output"),
        resourceRoot: RESOURCE_ROOT,
      }),
      /candidate_verifier_path_mismatch/u,
    );
  });
});

test("source-build input anchor rejects a self-consistent custom resource root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-promotion-anchor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const customResources = join(root, "resources");
  await cp(RESOURCE_ROOT, customResources, { recursive: true });
  const sourceInputsPath = join(customResources, "source-build-inputs.json");
  await writeFile(sourceInputsPath, `${await readFile(sourceInputsPath, "utf8")}\n`);
  const candidateA = await createCandidate(join(root, "a"), "darwin");
  const candidateB = await createCandidate(join(root, "b"), "darwin");
  await assert.rejects(
    createFixturePromoter(fixtureVerifier)({
      platform: "darwin",
      candidateA: candidateA.root,
      candidateB: candidateB.root,
      outputDir: join(root, "promotion"),
      resourceRoot: customResources,
    }),
    /source_build_inputs_anchor_mismatch/u,
  );
});

async function createCandidate(root, platform, options = {}) {
  const resourceRoot = options.resourceRoot ?? RESOURCE_ROOT;
  const sourceInputs = JSON.parse(await readFile(join(resourceRoot, "source-build-inputs.json"), "utf8"));
  const providerLockValue = JSON.parse(await readFile(join(resourceRoot, "provider-lock.json"), "utf8"));
  if (options.mutateProviderLock) providerLockValue.upstream.licenseSha256 = "f".repeat(64);
  await mkdir(root, { recursive: true });
  const providerLockBytes = `${JSON.stringify(providerLockValue, null, 2)}\n`;
  const sourceInputsBytes = await readFile(join(resourceRoot, "source-build-inputs.json"));
  await writeFile(join(root, "provider-lock.json"), providerLockBytes);
  await writeFile(join(root, "source-build-inputs.json"), sourceInputsBytes);
  await cp(join(resourceRoot, "LICENSE.md"), join(root, "LICENSE.md"));
  await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), "fixture notices\n");
  await writeFile(join(root, "cua-driver.spdx.json"), "{\"fixture\":true}\n");

  const binaries = platform === "darwin"
    ? [{ relativePath: "darwin/ling-cua-driver", role: "main", packaged: true }]
    : [
        { relativePath: "win32-x64/payload/ling-cua-driver.exe", role: "main", packaged: true },
        {
          relativePath: "audit/win32-x64/cua-driver-uia.exe",
          role: "uia-audit",
          packaged: options.uiaPackaged ?? false,
        },
      ];
  const binaryDigests = {};
  for (const binary of binaries) {
    const path = join(root, ...binary.relativePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    const bytes = Buffer.from(`fixture-${platform}-${binary.role}`);
    await writeFile(path, bytes);
    binary.sha256BeforeSigning = sha256(bytes);
    binaryDigests[binary.role] = binary.sha256BeforeSigning;
  }
  const series = JSON.parse(await readFile(
    join(resourceRoot, "patches/ling-managed-embedded-v1/series.json"),
    "utf8",
  ));
  const binaryIdentity = platform === "darwin"
    ? {
        binaries: [{
          role: "main",
          format: "Mach-O 64-bit",
          architecture: "arm64",
          minimumOSVersion: "13.0",
          sdkVersion: "26.5",
        }],
      }
    : {
        binaries: [
          windowsIdentity("main", false, "a".repeat(64), options.certificateTablePresent),
          windowsIdentity("uia-audit", true, "b".repeat(64), options.certificateTablePresent),
        ],
      };
  const providerLockSha256 = sha256(Buffer.from(providerLockBytes));
  const sourceBuildInputsSha256 = sha256(sourceInputsBytes);
  const toolsDigest = options.toolsDigest ?? DIGEST;
  const promotion = {
    schemaVersion: 1,
    kind: "ling.cua-driver.source-build-promotion-inputs",
    promotionEligible: options.promotionEligible ?? false,
    platform,
    providerLockSha256,
    sourceBuildInputsSha256,
    sourceBuild: {
      cargoLockSha256: sourceInputs.upstreamBuild.cargoLockSha256,
      rustcVersion: options.rustcVersion ?? sourceInputs.toolchain.rustcVersion,
      cargoVersion: sourceInputs.toolchain.cargoVersion,
      patchSet: {
        id: series.id,
        sha256: series.seriesSha256,
        patches: series.patches,
        touchedPaths: series.touchedPaths,
      },
      binariesSha256BeforeSigning: binaryDigests,
      binaryIdentity,
      versionOutput: "cua-driver 0.8.3",
      clientInitializeProtocolVersion: sourceInputs.compatibility.clientInitializeProtocolVersion,
      serverInitializeProtocolVersion: sourceInputs.compatibility.serverInitializeProtocolVersion,
      toolsListCanonicalSha256: toolsDigest,
      healthSchemaVersion: sourceInputs.compatibility.healthSchemaVersion,
      healthProbeSkip: sourceInputs.runtime.healthProbeSkip,
      healthCoreChecks: ["fixture"],
      managedDeniedTools: sourceInputs.runtime.managedDeniedTools,
    },
    providerSealInputs: {
      componentId: platform === "darwin" ? "cua-driver-darwin" : "cua-driver-win32-x64",
      lockSha256: providerLockSha256,
      distributionRevision: "ling.1",
      providerVersion: "0.8.3",
      serverInitializeProtocolVersion: sourceInputs.compatibility.serverInitializeProtocolVersion,
      healthSchemaVersion: sourceInputs.compatibility.healthSchemaVersion,
      toolsListCanonicalSha256: toolsDigest,
      stateSchemaVersion: 1,
      binaries,
    },
    supplyChain: {
      sbomSha256: await digestFile(join(root, "cua-driver.spdx.json")),
      noticesSha256: await digestFile(join(root, "THIRD_PARTY_NOTICES.md")),
    },
    runtimeProbe: { platform, toolsListCanonicalSha256: toolsDigest },
    missingFinalIdentity: options.missingFinalIdentity ?? (platform === "darwin"
      ? ["cdhashes", "codeIdentifier", "teamId", "designatedRequirement", "entitlementsCanonicalSha256"]
      : ["authenticodeStatus", "providerSealSha256"]),
  };
  await writeFile(
    join(root, "source-build-promotion-inputs.json"),
    `${JSON.stringify(promotion, null, 2)}\n`,
  );
  const stablePaths = [
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "cua-driver.spdx.json",
    "provider-lock.json",
    "source-build-inputs.json",
    "source-build-promotion-inputs.json",
    ...binaries.map((binary) => binary.relativePath),
  ].sort();
  const files = {};
  for (const relativePath of stablePaths) {
    files[relativePath] = await digestFile(join(root, ...relativePath.split("/")));
  }
  const manifestBytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    kind: "ling.cua-driver.source-build-manifest",
    platform,
    files,
  }, null, 2)}\n`);
  await writeFile(join(root, "source-build-manifest.json"), manifestBytes);
  const promotionInputsSha256 = files["source-build-promotion-inputs.json"];
  const attestation = {
    schemaVersion: 2,
    kind: "ling.cua-driver.source-build-attestation",
    providerLockSha256,
    sourceBuildInputsSha256,
    platform,
    promotionInputsSha256,
    manifestSha256: sha256(manifestBytes),
    packagingEligible: false,
    signingState: "pre-sign-only",
    binaries,
  };
  await writeFile(
    join(root, "source-build-attestation.json"),
    `${JSON.stringify(attestation, null, 2)}\n`,
  );
  if (options.extraFile) await writeFile(join(root, "unexpected.txt"), "unexpected\n");
  return { binaryDigests, promotion, root, sourceInputs };
}

async function fixtureVerifier({ candidateRoot }) {
  const attestationPath = join(candidateRoot, "source-build-attestation.json");
  const attestationBytes = await readFile(attestationPath);
  const manifestPath = join(candidateRoot, "source-build-manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const promotionPath = join(candidateRoot, "source-build-promotion-inputs.json");
  const promotionBytes = await readFile(promotionPath);
  const attestation = JSON.parse(attestationBytes.toString("utf8"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  return {
    ok: true,
    attestation: attestationPath,
    attestationSha256: sha256(attestationBytes),
    manifestSha256: sha256(manifestBytes),
    platform: attestation.platform,
    promotionInputsSha256: sha256(promotionBytes),
    files: manifest.files,
  };
}

function windowsIdentity(role, uiAccess, manifestSha256, certificateTablePresent = false) {
  return {
    role,
    format: "PE32+",
    machine: "0x8664",
    architecture: "x86_64",
    embeddedCertificateTablePresent: certificateTablePresent,
    manifest: {
      sha256: manifestSha256,
      executionLevel: "asInvoker",
      uiAccess,
    },
  };
}

async function digestFile(path) {
  return sha256(await readFile(path));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function snapshotTree(root) {
  const values = {};
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const path = join(directory, entry.name);
      const relativePath = path.slice(root.length + 1).split("\\").join("/");
      if (entry.isDirectory()) {
        values[`${relativePath}/`] = "directory";
        await visit(path);
      } else if (entry.isFile()) {
        values[relativePath] = await digestFile(path);
      } else {
        values[relativePath] = `other:${entry.isSymbolicLink()}`;
      }
    }
  }
  await visit(root);
  return values;
}
