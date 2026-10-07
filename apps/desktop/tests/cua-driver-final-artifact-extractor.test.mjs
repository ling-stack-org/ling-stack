import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
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
        ...atomicCleanupDependencies({}, darwinDirectoryIdentity),
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

test("DMG cleanup refuses the empty replacement installed after detach", async t => {
  let displaced;
  const f = await dmgFixture(t, {
    async command(_command, args) {
      if (args[0] !== "detach") return;
      displaced = `${f.mountPoint}.displaced`;
      await rename(f.mountPoint, displaced);
      await mkdir(f.mountPoint, { mode: 0o700 });
    },
  });
  const extracted = await f.extract();
  let cleanupError;
  try { await extracted.cleanup(); } catch (error) { cleanupError = error; }
  const preserved = await lstat(f.mountPoint).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  t.diagnostic(`post-detach replacement preserved=${String(preserved)}, bare-rmdir calls=${f.calls.bareRemove}`);
  assert.match(cleanupError?.message ?? "cleanup accepted the replacement", /final_artifact_cleanup_identity_mismatch/u);
  assert.equal((await lstat(f.mountPoint)).isDirectory(), true);
  assert.equal((await lstat(displaced)).isDirectory(), true);
  assert.equal(f.calls.bareRemove, 0);
  assert.equal(f.calls.recursiveRemove, 0);
});

test("DMG initial custody matches Darwin uint64 hexadecimal native receipts", async t => {
  const f = await dmgFixture(t, {
    atomic: {
      async readIdentities(input, lease, invokeDefault) {
        const current = await invokeDefault(input, lease);
        t.diagnostic(`native hexadecimal parent=${current.parentIdentity}, source=${current.sourceIdentity}`);
        return current;
      },
      async secure(input) {
        const [parent, source] = await Promise.all([
          lstat(f.root, { bigint: true }), lstat(f.mountPoint, { bigint: true }),
        ]);
        assert.equal(input.expectedParentIdentity, darwinDirectoryIdentity(parent));
        assert.equal(input.expectedDirectoryIdentity, darwinDirectoryIdentity(source));
        return { parentIdentity: input.expectedParentIdentity, directoryIdentity: input.expectedDirectoryIdentity };
      },
    },
  });
  const extracted = await f.extract();
  await extracted.cleanup();
  assert.equal(f.calls.secure, 1);
  assert.equal(f.calls.emptyRemove, 1);
  assert.equal(f.calls.bareRemove, 0);
});

test("DMG native empty cleanup retries without another detach and coalesces concurrent calls", async t => {
  let initialPins;
  let attempt = 0;
  let entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = await dmgFixture(t, {
    atomic: {
      async secure(input) {
        initialPins = { parentIdentity: input.expectedParentIdentity, sourceIdentity: input.expectedDirectoryIdentity };
        return Object.freeze({ parentIdentity: initialPins.parentIdentity, directoryIdentity: initialPins.sourceIdentity });
      },
      async removeUnsecured(input, lease, invokeDefault) {
        assert.equal(input.expectedParentIdentity, initialPins.parentIdentity);
        assert.equal(input.expectedSourceIdentity, initialPins.sourceIdentity);
        attempt += 1;
        if (attempt === 1) throw false;
        entered();
        await barrier;
        return invokeDefault(input, lease);
      },
    },
  });
  const extracted = await f.extract();
  assert.equal(await captureRejection(() => extracted.cleanup()), false);
  assert.equal((await lstat(f.mountPoint)).isDirectory(), true);
  const current = extracted.cleanup();
  const concurrent = extracted.cleanup();
  await enteredPromise;
  release();
  await Promise.all([current, concurrent]);
  await extracted.cleanup();
  assert.equal(f.calls.secure, 1);
  assert.equal(attempt, 2);
  assert.equal(f.calls.commands.filter(([, args]) => args[0] === "detach").length, 1);
  assert.equal(f.calls.bareRemove, 0);
  assert.equal(f.calls.recursiveRemove, 0);
  await assert.rejects(lstat(f.mountPoint), { code: "ENOENT" });
});

test("DMG secure failure and failed empty recovery preserve every falsy cause and original residue pins", async t => {
  for (const [index, reason] of [undefined, null, false, 0, ""].entries()) {
    await t.test(`falsy-${index}`, async t => {
      const f = await dmgFixture(t, {
        atomic: {
          async secure() { throw reason; },
          async removeUnsecured() { throw reason; },
        },
      });
      const error = await captureRejection(() => f.extract());
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "final_artifact_cleanup_initialization_and_recovery_failed");
      assert.deepEqual(error.errors, [reason, reason]);
      assert.equal(error.cleanup.outcome, "residue");
      assert.equal(error.cleanup.residuePath, f.mountPoint);
      const original = await lstat(f.mountPoint, { bigint: true });
      assert.equal(error.cleanup.residueIdentity, darwinDirectoryIdentity(original));
      assert.equal(Object.isFrozen(error.cleanup), true);
      assert.equal(f.calls.commands.length, 0);
      assert.equal(f.calls.bareRemove, 0);
      assert.equal(f.calls.recursiveRemove, 0);
    });
  }
});

test("DMG initialization failures use only original-pin empty recovery and never start attach", async t => {
  for (const failure of ["inspect", "lease", "secure", "secure-receipt", "parent-receipt"]) {
    await t.test(failure, async t => {
      let identityCalls = 0;
      let leaseCalls = 0;
      const failureReason = new Error(`synthetic_${failure}_failed`);
      const f = await dmgFixture(t, {
        atomic: {
          async withLease(input, operation, invokeDefault) {
            leaseCalls += 1;
            if (failure === "lease" && leaseCalls === 1) throw failureReason;
            return invokeDefault(input, operation);
          },
          async readIdentities(input, lease, invokeDefault) {
            identityCalls += 1;
            if (failure === "inspect" && identityCalls === 1) throw failureReason;
            const current = await invokeDefault(input, lease);
            return failure === "parent-receipt" && identityCalls === 1
              ? { ...current, parentIdentity: "0:0" } : current;
          },
          async secure(input) {
            if (failure === "secure") throw failureReason;
            return { parentIdentity: input.expectedParentIdentity,
              directoryIdentity: failure === "secure-receipt" ? "0:0" : input.expectedDirectoryIdentity };
          },
        },
      });
      const error = await captureRejection(() => f.extract());
      if (failure.endsWith("receipt")) assert.match(error.message, /final_artifact_cleanup_identity_mismatch/u);
      else assert.equal(error, failureReason);
      assert.equal(f.calls.commands.length, 0);
      assert.equal(f.calls.bareRemove, 0);
      assert.equal(f.calls.recursiveRemove, 0);
      assert.equal(f.calls.emptyRemove, 1);
      await assert.rejects(lstat(f.mountPoint), { code: "ENOENT" });
    });
  }
});

test("DMG unknown initial custody keeps invalid roots without bare cleanup or attach", async t => {
  for (const kind of ["symlink", "file", "missing"]) {
    await t.test(kind, async t => {
      let target;
      const f = await dmgFixture(t, {
        async afterCreate(path) {
          await rmdir(path);
          if (kind === "missing") return;
          if (kind === "file") { await writeFile(path, "valuable invalid initial root"); return; }
          target = `${path}.target`;
          await mkdir(target);
          await writeFile(join(target, "valuable.txt"), "preserve");
          await symlink(target, path, "dir");
        },
      });
      const error = await captureRejection(() => f.extract());
      assert.ok(error instanceof AggregateError);
      assert.equal(error.message, "final_artifact_cleanup_initialization_and_recovery_failed");
      assert.equal(error.errors.length, 1);
      assert.equal(error.cleanup.residuePath, f.mountPoint);
      assert.equal(Object.hasOwn(error.cleanup, "residueIdentity"), false);
      assert.equal(f.calls.commands.length, 0);
      assert.equal(f.calls.bareRemove, 0);
      assert.equal(f.calls.emptyRemove, 0);
      if (kind === "file") assert.equal(await readFile(f.mountPoint, "utf8"), "valuable invalid initial root");
      if (kind === "symlink") assert.equal(await readFile(join(target, "valuable.txt"), "utf8"), "preserve");
    });
  }
});

test("DMG mounted-view replacement is not mistaken for the original host directory (synthetic VFS only)", async t => {
  let hostIdentity;
  let mounted = false;
  let hiddenHost;
  const f = await dmgFixture(t, {
    atomic: {
      async readIdentities(input, lease, invokeDefault) {
        assert.equal(mounted, false, "initial host pins must not be compared to a mounted path view");
        return invokeDefault(input, lease);
      },
    },
    async command(_command, args) {
      if (args[0] === "attach") {
        const host = await lstat(f.mountPoint, { bigint: true });
        hostIdentity = `${String(host.dev)}:${String(host.ino)}`;
        hiddenHost = `${f.mountPoint}.hidden-host`;
        await rename(f.mountPoint, hiddenHost);
        await mkdir(f.mountPoint);
        const view = await lstat(f.mountPoint, { bigint: true });
        assert.notEqual(`${String(view.dev)}:${String(view.ino)}`, hostIdentity);
        mounted = true;
      } else {
        // A disposable directory swap models a VFS view change, not an OS mount.
        await rmdir(f.mountPoint);
        await rename(hiddenHost, f.mountPoint);
        mounted = false;
        const restored = await lstat(f.mountPoint, { bigint: true });
        assert.equal(`${String(restored.dev)}:${String(restored.ino)}`, hostIdentity);
      }
    },
  });
  const extracted = await f.extract();
  await extracted.cleanup();
  assert.equal(f.calls.secure, 1);
  assert.equal(f.calls.emptyRemove, 1);
  assert.equal(f.calls.bareRemove, 0);
});

test("DMG both detach failures keep falsy reasons, skip removal, and remain retryable", async t => {
  let detachBlocked = true;
  const f = await dmgFixture(t, {
    async command(_command, args) {
      if (args[0] === "detach" && detachBlocked) throw args[1] === "-force" ? 0 : null;
    },
  });
  const extracted = await f.extract();
  const error = await captureRejection(() => extracted.cleanup());
  assert.ok(error instanceof AggregateError);
  assert.deepEqual(error.errors, [null, 0]);
  assert.match(error.message, /final_artifact_dmg_detach_failed/u);
  assert.equal(f.calls.emptyRemove, 0);
  assert.equal(f.calls.bareRemove, 0);
  assert.equal((await lstat(f.mountPoint)).isDirectory(), true);
  detachBlocked = false;
  await extracted.cleanup();
  await extracted.cleanup();
  assert.equal(f.calls.commands.filter(([, args]) => args[0] === "detach").length, 3);
  assert.equal(f.calls.emptyRemove, 1);
});

test("DMG partial attach failures preserve original and cleanup causes", async t => {
  for (const cleanupFails of [false, true]) {
    await t.test(`cleanup-fails-${cleanupFails}`, async t => {
      const f = await dmgFixture(t, {
        async command(_command, args) {
          if (args[0] === "attach") throw false;
          if (cleanupFails) throw args[1] === "-force" ? "" : undefined;
        },
      });
      const error = await captureRejection(() => f.extract());
      if (cleanupFails) {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.message, "final_artifact_extraction_and_cleanup_failed");
        assert.equal(error.errors[0], false);
        assert.deepEqual(error.errors[1].errors, [undefined, ""]);
        assert.equal((await lstat(f.mountPoint)).isDirectory(), true);
        assert.equal(f.calls.emptyRemove, 0);
      } else {
        assert.equal(error, false);
        assert.equal(f.calls.emptyRemove, 1);
        await assert.rejects(lstat(f.mountPoint), { code: "ENOENT" });
      }
      assert.equal(f.calls.bareRemove, 0);
      assert.equal(f.calls.recursiveRemove, 0);
    });
  }
});

test("DMG post-detach missing, nonempty, symlink, and parent replacements fail closed without refresh", async t => {
  for (const kind of ["missing", "nonempty", "symlink", "parent"]) {
    await t.test(kind, async t => {
      let displaced;
      let valuable;
      const f = await dmgFixture(t, {
        async command(_command, args) {
          if (args[0] !== "detach") return;
          if (kind === "missing") { await rmdir(f.mountPoint); return; }
          if (kind === "nonempty") {
            valuable = join(f.mountPoint, "valuable.txt");
            await writeFile(valuable, "preserve");
            return;
          }
          if (kind === "symlink") {
            displaced = `${f.mountPoint}.displaced`;
            await rename(f.mountPoint, displaced);
            valuable = join(displaced, "valuable.txt");
            await writeFile(valuable, "preserve");
            await symlink(displaced, f.mountPoint, "dir");
            return;
          }
          displaced = `${f.root}.displaced`;
          t.after(() => rm(displaced, { recursive: true, force: true }));
          await rename(f.root, displaced);
          await mkdir(f.root);
          await mkdir(f.mountPoint);
          valuable = join(displaced, "valuable.txt");
          await writeFile(valuable, "preserve");
        },
      });
      const extracted = await f.extract();
      if (kind === "missing") await assert.rejects(extracted.cleanup(), { code: "ENOENT" });
      else if (kind === "nonempty") await assert.rejects(extracted.cleanup(), { code: "ENOTEMPTY" });
      else await assert.rejects(extracted.cleanup(), /final_artifact_cleanup_identity_mismatch/u);
      assert.equal(f.calls.bareRemove, 0);
      assert.equal(f.calls.recursiveRemove, 0);
      assert.equal(f.calls.commands.filter(([, args]) => args[0] === "detach").length, 1);
      if (valuable) assert.equal(await readFile(valuable, "utf8"), "preserve");
      if (kind === "parent") assert.equal((await lstat(f.mountPoint)).isDirectory(), true);
    });
  }
});

test("DMG first stat pins reject native inspection of a replacement without refreshing custody", async t => {
  let displaced;
  let replaced = false;
  const f = await dmgFixture(t, {
    atomic: {
      async readIdentities(input, lease, invokeDefault) {
        if (!replaced) {
          replaced = true;
          displaced = `${f.mountPoint}.displaced`;
          await rename(f.mountPoint, displaced);
          await mkdir(f.mountPoint, { mode: 0o700 });
        }
        return invokeDefault(input, lease);
      },
    },
  });
  const error = await captureRejection(() => f.extract());
  assert.ok(error instanceof AggregateError);
  assert.match(error.errors[0].message, /final_artifact_cleanup_identity_mismatch/u);
  assert.match(error.errors[1].message, /final_artifact_cleanup_identity_mismatch/u);
  assert.equal(error.cleanup.residuePath, f.mountPoint);
  assert.match(error.cleanup.residueIdentity, /^[0-9a-f]+:[0-9a-f]+$/u);
  assert.equal(f.calls.commands.length, 0);
  assert.equal(f.calls.secure, 0);
  assert.equal(f.calls.bareRemove, 0);
  assert.equal((await lstat(displaced)).isDirectory(), true);
  assert.equal((await lstat(f.mountPoint)).isDirectory(), true);
});

test("DMG empty removal rechecks original pins after the JS identity check", async t => {
  let displaced;
  const f = await dmgFixture(t, {
    atomic: {
      async removeUnsecured(input, lease, invokeDefault) {
        displaced = `${f.mountPoint}.displaced`;
        await rename(f.mountPoint, displaced);
        await mkdir(f.mountPoint, { mode: 0o700 });
        return invokeDefault(input, lease);
      },
    },
  });
  const extracted = await f.extract();
  await assert.rejects(extracted.cleanup(), /source_identity_mismatch/u);
  assert.equal((await lstat(f.mountPoint)).isDirectory(), true);
  assert.equal((await lstat(displaced)).isDirectory(), true);
  await assert.rejects(extracted.cleanup(), /final_artifact_cleanup_identity_mismatch/u);
  assert.equal(f.calls.commands.filter(([, args]) => args[0] === "detach").length, 1);
  assert.equal(f.calls.bareRemove, 0);
  assert.equal(f.calls.recursiveRemove, 0);
});

/** Only disposable directories and synthetic commands/native receipts, never a real mount. */
async function dmgFixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-cua-dmg-custody-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactPath = join(root, "EXPLICIT-SYNTHETIC.dmg");
  await writeFile(artifactPath, "EXPLICIT SYNTHETIC DMG, NOT MOUNTABLE");
  let mountPoint;
  const calls = { commands: [], secure: 0, emptyRemove: 0, bareRemove: 0, recursiveRemove: 0 };
  const atomic = atomicCleanupDependencies({
    ...overrides.atomic,
    async secure(input, lease) {
      calls.secure += 1;
      if (overrides.atomic?.secure) return overrides.atomic.secure(input, lease);
      return Object.freeze({ parentIdentity: input.expectedParentIdentity,
        directoryIdentity: input.expectedDirectoryIdentity });
    },
    async removeUnsecured(input, lease, invokeDefault) {
      calls.emptyRemove += 1;
      if (overrides.atomic?.removeUnsecured) return overrides.atomic.removeUnsecured(input, lease, invokeDefault);
      return invokeDefault(input, lease);
    },
    async remove() { calls.recursiveRemove += 1; assert.fail("DMG must never remove mounted content recursively"); },
  }, darwinDirectoryIdentity);
  return {
    calls,
    get root() { return root; },
    get mountPoint() { return mountPoint; },
    async extract() {
      return extractCuaDriverFinalArtifact(artifactPath, { platform: "darwin", artifactRole: "outer-dmg" }, {
        ...atomic,
        async mkdtemp() {
          mountPoint = await mkdtemp(join(root, "mountpoint-"));
          if (overrides.afterCreate) await overrides.afterCreate(mountPoint);
          return mountPoint;
        },
        async rmdir(path) { calls.bareRemove += 1; return rmdir(path); },
        async runCommand(command, args, options) {
          assert.equal(command, "/usr/bin/hdiutil");
          calls.commands.push([command, args, options]);
          if (args[0] === "detach") assert.equal(options.timeoutMs, 30_000);
          if (overrides.command) return overrides.command(command, args, options);
        },
      });
    },
  };
}

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

function darwinDirectoryIdentity(metadata) {
  return `${BigInt.asUintN(64, metadata.dev).toString(16)}:${BigInt.asUintN(64, metadata.ino).toString(16)}`;
}

function atomicCleanupDependencies(overrides = {}, identity = metadata => `${String(metadata.dev)}:${String(metadata.ino)}`) {
  async function identities(parentRoot, sourceName) {
    const [parent, source] = await Promise.all([
      lstat(parentRoot, { bigint: true }),
      lstat(join(parentRoot, sourceName), { bigint: true }).catch((error) => {
        if (error?.code === "ENOENT") error.nativeReason = "source_missing";
        throw error;
      }),
    ]);
    return Object.freeze({
      parentIdentity: identity(parent),
      sourceIdentity: identity(source),
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

  async function removeEmptyDefault(input) {
    const current = await identities(input.parentRoot, input.sourceName);
    if (current.parentIdentity !== input.expectedParentIdentity
      || current.sourceIdentity !== input.expectedSourceIdentity) {
      const error = new Error("source_identity_mismatch");
      error.nativeReason = "source_identity_mismatch";
      throw error;
    }
    await rmdir(join(input.parentRoot, input.sourceName));
  }

  return {
    async withAtomicPublishParentLease(input, operation) {
      const invokeDefault = async ({ parentRoot }, defaultOperation) => {
        const parent = await lstat(parentRoot, { bigint: true });
        const lease = {
          parentIdentity: identity(parent),
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
        return overrides.removeUnsecured(input, lease, removeEmptyDefault);
      }
      return removeEmptyDefault(input, lease);
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
