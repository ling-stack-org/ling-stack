import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  extractCuaDriverFinalArtifact,
} from "../scripts/cua-driver-signing/final-artifact-extractor.mjs";

test("ZIP extraction uses fixed ditto and identity-bound retryable cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-extractor-test-"));
  try {
    const artifactPath = join(root, "Ling Stack.zip");
    await writeFile(artifactPath, "zip");
    const calls = [];
    let removeAttempts = 0;
    const cleanupDependencies = atomicCleanupDependencies({
      async remove(input, lease, removeDefault) {
        removeAttempts += 1;
        if (removeAttempts === 1) throw new Error("cleanup_busy");
        return removeDefault(input, lease);
      },
    });
    const extracted = await extractCuaDriverFinalArtifact(
      artifactPath,
      { platform: "darwin", artifactRole: "outer-zip" },
      {
        ...cleanupDependencies,
        async runCommand(command, args) { calls.push([command, args]); },
      },
    );
    assert.deepEqual(calls, [["/usr/bin/ditto", ["-x", "-k", artifactPath, extracted.artifactRoot]]]);
    await assert.rejects(extracted.cleanup(), /cleanup_busy/u);
    await Promise.all([extracted.cleanup(), extracted.cleanup()]);
    assert.equal(removeAttempts, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ZIP cleanup refuses a replaced extraction directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-extractor-replace-"));
  try {
    const artifactPath = join(root, "Ling Stack.zip");
    await writeFile(artifactPath, "zip");
    const extracted = await extractCuaDriverFinalArtifact(
      artifactPath,
      { platform: "darwin", artifactRole: "outer-zip" },
      {
        ...atomicCleanupDependencies(),
        async runCommand() {},
      },
    );
    const displaced = `${extracted.artifactRoot}.displaced`;
    await rename(extracted.artifactRoot, displaced);
    await mkdir(extracted.artifactRoot);
    await assert.rejects(extracted.cleanup(), /final_artifact_cleanup_identity_mismatch/u);
    await rm(extracted.artifactRoot, { recursive: true, force: true });
    await rm(displaced, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secure-private failure removes the identity-bound empty extraction root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-extractor-secure-fail-"));
  let extractionRoot;
  try {
    const artifactPath = join(root, "Ling Stack.zip");
    await writeFile(artifactPath, "zip");
    await assert.rejects(
      extractCuaDriverFinalArtifact(
        artifactPath,
        { platform: "darwin", artifactRole: "outer-zip" },
        {
          ...atomicCleanupDependencies({
            async secure() { throw new Error("secure_failed"); },
          }),
          async mkdtemp(prefix) {
            extractionRoot = await mkdtemp(prefix);
            return extractionRoot;
          },
          async runCommand() { assert.fail("extraction must not start"); },
        },
      ),
      /secure_failed/u,
    );
    await assert.rejects(lstat(extractionRoot), { code: "ENOENT" });
  } finally {
    if (extractionRoot) await rm(extractionRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("secure-private and identity-bound empty cleanup failures are aggregated", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-extractor-secure-aggregate-"));
  let extractionRoot;
  try {
    const artifactPath = join(root, "Ling Stack.zip");
    await writeFile(artifactPath, "zip");
    const error = await captureRejection(() => extractCuaDriverFinalArtifact(
      artifactPath,
      { platform: "darwin", artifactRole: "outer-zip" },
      {
        ...atomicCleanupDependencies({
          async secure() { throw new Error("secure_failed"); },
          async removeUnsecured() { throw new Error("empty_cleanup_failed"); },
        }),
        async mkdtemp(prefix) {
          extractionRoot = await mkdtemp(prefix);
          return extractionRoot;
        },
        async runCommand() { assert.fail("extraction must not start"); },
      },
    ));
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "final_artifact_cleanup_initialization_and_recovery_failed");
    assert.ok(error.errors[0] instanceof AggregateError);
    assert.equal(error.errors[0].message, "final_artifact_cleanup_initialization_and_cleanup_failed");
    assert.deepEqual(error.errors[0].errors.map((entry) => entry.message), [
      "secure_failed",
      "empty_cleanup_failed",
    ]);
    assert.equal(error.errors[1].message, "empty_cleanup_failed");
    assert.equal(error.cleanup.residuePath, extractionRoot);
    assert.match(error.cleanup.residueIdentity, /^\d+:\d+$/u);
    assert.equal((await lstat(extractionRoot)).isDirectory(), true);
  } finally {
    if (extractionRoot) await rm(extractionRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

for (const failureKind of ["lease", "identity"]) {
  test(`${failureKind} initialization failure retries identity-bound empty cleanup`, async () => {
    const root = await mkdtemp(join(tmpdir(), `ling-cua-extractor-${failureKind}-init-`));
    let extractionRoot;
    let leaseCalls = 0;
    let identityCalls = 0;
    try {
      const artifactPath = join(root, "Ling Stack.zip");
      await writeFile(artifactPath, "zip");
      const dependencies = atomicCleanupDependencies({
        async withLease(input, operation, invokeDefault) {
          leaseCalls += 1;
          if (failureKind === "lease" && leaseCalls === 1) throw new Error("lease_init_failed");
          return invokeDefault(input, operation);
        },
        async readIdentities(input, lease, invokeDefault) {
          identityCalls += 1;
          if (failureKind === "identity" && identityCalls === 1) {
            throw new Error("identity_init_failed");
          }
          return invokeDefault(input, lease);
        },
      });
      await assert.rejects(
        extractCuaDriverFinalArtifact(
          artifactPath,
          { platform: "darwin", artifactRole: "outer-zip" },
          {
            ...dependencies,
            async mkdtemp(prefix) {
              extractionRoot = await mkdtemp(prefix);
              return extractionRoot;
            },
            async runCommand() { assert.fail("extraction must not start"); },
          },
        ),
        new RegExp(`${failureKind}_init_failed`, "u"),
      );
      await assert.rejects(lstat(extractionRoot), { code: "ENOENT" });
    } finally {
      if (extractionRoot) await rm(extractionRoot, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("persistent cleanup initialization failure returns an identity-bound residue receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-extractor-init-receipt-"));
  let extractionRoot;
  try {
    const artifactPath = join(root, "Ling Stack.zip");
    await writeFile(artifactPath, "zip");
    const error = await captureRejection(() => extractCuaDriverFinalArtifact(
      artifactPath,
      { platform: "darwin", artifactRole: "outer-zip" },
      {
        ...atomicCleanupDependencies({
          async withLease() { throw new Error("lease_unavailable"); },
        }),
        async mkdtemp(prefix) {
          extractionRoot = await mkdtemp(prefix);
          return extractionRoot;
        },
        async runCommand() { assert.fail("extraction must not start"); },
      },
    ));
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "final_artifact_cleanup_initialization_and_recovery_failed");
    assert.equal(error.cleanup.outcome, "residue");
    assert.equal(error.cleanup.residuePath, extractionRoot);
    assert.match(error.cleanup.residueIdentity, /^\d+:\d+$/u);
    assert.equal((await lstat(extractionRoot)).isDirectory(), true);
  } finally {
    if (extractionRoot) await rm(extractionRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("ZIP cleanup keeps both trees when replacement wins after inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-extractor-race-"));
  try {
    const artifactPath = join(root, "Ling Stack.zip");
    await writeFile(artifactPath, "zip");
    let displaced;
    let hookCalls = 0;
    const extracted = await extractCuaDriverFinalArtifact(
      artifactPath,
      { platform: "darwin", artifactRole: "outer-zip" },
      {
        ...atomicCleanupDependencies(),
        async runCommand(_command, args) {
          await writeFile(join(args.at(-1), "original.txt"), "original");
        },
        async testOnlyAfterCleanupInventory({ root: extractionRoot }) {
          hookCalls += 1;
          displaced = `${extractionRoot}.displaced`;
          await rename(extractionRoot, displaced);
          await mkdir(extractionRoot, { mode: 0o700 });
          await writeFile(join(extractionRoot, "replacement.txt"), "replacement");
        },
      },
    );

    await assert.rejects(extracted.cleanup(), /source_identity_mismatch/u);
    assert.equal(await readFile(join(extracted.artifactRoot, "replacement.txt"), "utf8"), "replacement");
    assert.equal(await readFile(join(displaced, "original.txt"), "utf8"), "original");
    await assert.rejects(extracted.cleanup(), /final_artifact_cleanup_identity_mismatch/u);
    assert.equal(hookCalls, 1);
    assert.equal(await readFile(join(extracted.artifactRoot, "replacement.txt"), "utf8"), "replacement");
    assert.equal(await readFile(join(displaced, "original.txt"), "utf8"), "original");
    await rm(extracted.artifactRoot, { recursive: true, force: true });
    await rm(displaced, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ZIP cleanup passes exact bounded inventory to artifact-only removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-extractor-inventory-"));
  try {
    const artifactPath = join(root, "Ling Stack.zip");
    await writeFile(artifactPath, "zip");
    let removalInput;
    const cleanupDependencies = atomicCleanupDependencies({
      async remove(input, lease, removeDefault) {
        removalInput = input;
        return removeDefault(input, lease);
      },
    });
    const extracted = await extractCuaDriverFinalArtifact(
      artifactPath,
      { platform: "darwin", artifactRole: "outer-zip" },
      {
        ...cleanupDependencies,
        async runCommand(_command, args) {
          const extractionRoot = args.at(-1);
          await mkdir(join(extractionRoot, "nested"));
          await writeFile(join(extractionRoot, "root.txt"), "root");
          await writeFile(join(extractionRoot, "nested", "child.txt"), "child");
        },
      },
    );
    await Promise.all([extracted.cleanup(), extracted.cleanup()]);
    await extracted.cleanup();
    assert.equal(removalInput.expectedEntries, 3);
    assert.equal(removalInput.expectedTotalBytes, Buffer.byteLength("rootchild"));
    assert.equal(removalInput.entryPolicy, "darwin-artifact-symlinks");
    assert.equal(removalInput.parentRoot, await realpath(dirname(extracted.artifactRoot)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact cleanup rejects injected inventories outside the fixed bounds", async () => {
  for (const inventory of [
    { entries: 100_001, totalBytes: 0 },
    { entries: 0, totalBytes: 4 * 1024 * 1024 * 1024 + 1 },
  ]) {
    const root = await mkdtemp(join(tmpdir(), "ling-cua-extractor-bounds-"));
    try {
      const artifactPath = join(root, "Ling Stack.zip");
      await writeFile(artifactPath, "zip");
      let removeCalls = 0;
      const cleanupDependencies = atomicCleanupDependencies({
        async remove(input, lease, removeDefault) {
          removeCalls += 1;
          return removeDefault(input, lease);
        },
      });
      const extracted = await extractCuaDriverFinalArtifact(
        artifactPath,
        { platform: "darwin", artifactRole: "outer-zip" },
        {
          ...cleanupDependencies,
          async testOnlyMeasureFinalArtifactCleanupInventory() { return inventory; },
          async runCommand() {},
        },
      );
      await assert.rejects(extracted.cleanup(), /final_artifact_cleanup_inventory_oversized/u);
      assert.equal(removeCalls, 0);
      await rm(extracted.artifactRoot, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Darwin native cleanup rejects a post-inventory root replacement", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-extractor-native-race-"));
  let displaced;
  let extracted;
  try {
    const artifactPath = join(root, "Ling Stack.zip");
    await writeFile(artifactPath, "zip");
    extracted = await extractCuaDriverFinalArtifact(
      artifactPath,
      { platform: "darwin", artifactRole: "outer-zip" },
      {
        async runCommand(_command, args) {
          await writeFile(join(args.at(-1), "original.txt"), "original");
        },
        async testOnlyAfterCleanupInventory({ root: extractionRoot }) {
          displaced = `${extractionRoot}.displaced`;
          await rename(extractionRoot, displaced);
          await mkdir(extractionRoot, { mode: 0o700 });
          await writeFile(join(extractionRoot, "replacement.txt"), "replacement");
        },
      },
    );
    await assert.rejects(extracted.cleanup(), /source_identity_mismatch/u);
    assert.equal(await readFile(join(extracted.artifactRoot, "replacement.txt"), "utf8"), "replacement");
    assert.equal(await readFile(join(displaced, "original.txt"), "utf8"), "original");
    await assert.rejects(extracted.cleanup(), /final_artifact_cleanup_identity_mismatch/u);
    assert.equal(await readFile(join(extracted.artifactRoot, "replacement.txt"), "utf8"), "replacement");
    assert.equal(await readFile(join(displaced, "original.txt"), "utf8"), "original");
  } finally {
    if (extracted) await rm(extracted.artifactRoot, { recursive: true, force: true });
    if (displaced) await rm(displaced, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("Darwin artifact cleanup unlinks symlinks without following their targets", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-extractor-native-link-"));
  try {
    const artifactPath = join(root, "Ling Stack.zip");
    const externalRoot = join(root, "external");
    await writeFile(artifactPath, "zip");
    await mkdir(externalRoot);
    await writeFile(join(externalRoot, "valuable.txt"), "valuable");
    const extracted = await extractCuaDriverFinalArtifact(
      artifactPath,
      { platform: "darwin", artifactRole: "outer-zip" },
      {
        async runCommand(_command, args) {
          await symlink(externalRoot, join(args.at(-1), "external-link"), "dir");
        },
      },
    );
    await extracted.cleanup();
    assert.equal(await readFile(join(externalRoot, "valuable.txt"), "utf8"), "valuable");
    await assert.rejects(lstat(extracted.artifactRoot), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DMG cleanup falls back to force detach and stays idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-extractor-dmg-"));
  try {
    const artifactPath = join(root, "Ling Stack.dmg");
    await writeFile(artifactPath, "dmg");
    const calls = [];
    const extracted = await extractCuaDriverFinalArtifact(
      artifactPath,
      { platform: "darwin", artifactRole: "outer-dmg" },
      {
        async runCommand(command, args) {
          calls.push([command, args]);
          if (args[0] === "detach" && args[1] !== "-force") {
            throw new Error("ordinary_detach_failed");
          }
        },
      },
    );
    await extracted.cleanup();
    await extracted.cleanup();
    assert.equal(calls.filter(([, args]) => args[0] === "attach").length, 1);
    assert.equal(calls.filter(([, args]) => args[0] === "detach").length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("NSIS extraction uses pinned 7zip and exact nested app-64 archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-extractor-nsis-"));
  try {
    const artifactPath = join(root, "Ling Stack Setup.exe");
    await writeFile(artifactPath, "setup");
    const calls = [];
    let removalInput;
    const cleanupDependencies = atomicCleanupDependencies({
      async remove(input, lease, removeDefault) {
        removalInput = input;
        return removeDefault(input, lease);
      },
    });
    const extracted = await extractCuaDriverFinalArtifact(
      artifactPath,
      { platform: "win32", artifactRole: "outer-nsis", environment: {} },
      {
        ...cleanupDependencies,
        async getPath7za() { return "C:\\pinned\\7za.exe"; },
        async runCommand(command, args) {
          calls.push([command, args]);
          const outputRoot = args.find((value) => value.startsWith("-o")).slice(2);
          if (calls.length === 1) {
            await mkdir(join(outputRoot, "$PLUGINSDIR"), { recursive: true });
            await writeFile(join(outputRoot, "$PLUGINSDIR", "app-64.7z"), "nested");
          } else {
            await mkdir(join(outputRoot, "resources"), { recursive: true });
          }
        },
      },
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], "C:\\pinned\\7za.exe");
    assert.match(calls[1][1].at(-1), /\$PLUGINSDIR[/\\]app-64\.7z$/u);
    await extracted.cleanup();
    assert.equal(removalInput.entryPolicy, "artifact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("NSIS rejects override, missing nested archive, and extraction residue", async () => {
  const root = await mkdtemp(join(tmpdir(), "ling-cua-extractor-nsis-invalid-"));
  try {
    const artifactPath = join(root, "Ling Stack Setup.exe");
    await writeFile(artifactPath, "setup");
    await assert.rejects(
      extractCuaDriverFinalArtifact(
        artifactPath,
        {
          platform: "win32",
          artifactRole: "outer-nsis",
          environment: { ELECTRON_BUILDER_7ZIP_PATH: "C:\\evil\\7za.exe" },
        },
      ),
      /final_artifact_7zip_override_forbidden/u,
    );
    let containerRoot;
    await assert.rejects(
      extractCuaDriverFinalArtifact(
        artifactPath,
        { platform: "win32", artifactRole: "outer-nsis", environment: {} },
        {
          ...atomicCleanupDependencies(),
          async getPath7za() { return "7za"; },
          async mkdtemp(prefix) {
            containerRoot = await mkdtemp(prefix);
            return containerRoot;
          },
          async runCommand(_command, args) {
            const outputRoot = args.find((value) => value.startsWith("-o")).slice(2);
            await mkdir(outputRoot, { recursive: true });
          },
        },
      ),
      /final_artifact_nsis_app_archive_invalid/u,
    );
    await mkdir(containerRoot);
    await rm(containerRoot, { recursive: true, force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function atomicCleanupDependencies(overrides = {}) {
  async function identities(parentRoot, sourceName) {
    const [parent, source] = await Promise.all([
      lstat(parentRoot, { bigint: true }),
      lstat(join(parentRoot, sourceName), { bigint: true }).catch((error) => {
        if (error?.code === "ENOENT") error.nativeReason = "source_missing";
        throw error;
      }),
    ]);
    return Object.freeze({
      parentIdentity: `${String(parent.dev)}:${String(parent.ino)}`,
      sourceIdentity: `${String(source.dev)}:${String(source.ino)}`,
    });
  }

  async function removeDefault(input) {
    const current = await identities(input.parentRoot, input.sourceName);
    if (current.parentIdentity !== input.expectedParentIdentity
      || current.sourceIdentity !== input.expectedSourceIdentity) {
      const error = new Error("source_identity_mismatch");
      error.nativeReason = "source_identity_mismatch";
      throw error;
    }
    await rm(join(input.parentRoot, input.sourceName), { recursive: true, force: true });
  }

  return {
    async withAtomicPublishParentLease(input, operation) {
      const invokeDefault = async ({ parentRoot }, defaultOperation) => {
        const parent = await lstat(parentRoot, { bigint: true });
        const lease = {
          parentIdentity: `${String(parent.dev)}:${String(parent.ino)}`,
          assertHeld() {},
          guard(callback) { return callback(); },
        };
        return defaultOperation(lease);
      };
      if (overrides.withLease) {
        return overrides.withLease(input, operation, invokeDefault);
      }
      return invokeDefault(input, operation);
    },
    async readAtomicPublishDirectoryIdentities(input, lease) {
      const invokeDefault = async (defaultInput) => identities(
        defaultInput.parentRoot,
        defaultInput.sourceName,
      );
      if (overrides.readIdentities) {
        return overrides.readIdentities(input, lease, invokeDefault);
      }
      return invokeDefault(input, lease);
    },
    async securePrivateStagingDirectory(input, lease) {
      if (overrides.secure) return overrides.secure(input, lease);
      return Object.freeze({
        parentIdentity: input.expectedParentIdentity,
        directoryIdentity: input.expectedDirectoryIdentity,
      });
    },
    async removeAtomicPublishDirectoryTree(input, lease) {
      if (overrides.remove) {
        return overrides.remove(input, lease, removeDefault);
      }
      return removeDefault(input, lease);
    },
    async removeAtomicPublishUnsecuredEmptyDirectory(input, lease) {
      if (overrides.removeUnsecured) {
        return overrides.removeUnsecured(input, lease, removeDefault);
      }
      return removeDefault(input, lease);
    },
  };
}

async function captureRejection(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail("expected operation to reject");
}
