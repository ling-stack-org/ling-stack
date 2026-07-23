import assert from "node:assert/strict";
import {
  execFile as execFileCallback,
  spawn,
} from "node:child_process";
import { once } from "node:events";
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
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  atomicPublishDirectoryNoReplace as atomicPublishDirectoryNoReplaceWithLease,
  CuaDriverAtomicPublishError,
  encodeNativeParentLeaseCallFrameForTest,
  preflightAtomicPublishDirectoryNoReplace,
  readAtomicPublishDirectoryIdentities,
  removeAtomicPublishDirectoryTree as removeAtomicPublishDirectoryTreeWithLease,
  removeAtomicPublishUnsecuredEmptyDirectory as removeAtomicPublishUnsecuredEmptyDirectoryWithLease,
  runDarwinIdentityBoundExecutableForTest,
  runOwnedWindowsProcess,
  spawnOwnedWindowsProcess,
  securePrivateStagingDirectory as securePrivateStagingDirectoryWithLease,
  verifyPrivateStagingDirectorySecurity,
  withAtomicPublishParentLease,
  withAtomicPublishParentLeaseForTest,
} from "../scripts/cua-driver-package-atomic-publish.mjs";

const execFile = promisify(execFileCallback);
const NATIVE_SOURCE = fileURLToPath(new URL(
  "../scripts/native/cua-driver-package-atomic-publish.cc",
  import.meta.url,
));
const LEGACY_PARENT_LOCK_FILE_NAME = ".ling-cua-driver-staging.lock";
const ATOMIC_PUBLISH_MODULE_URL = new URL(
  "../scripts/cua-driver-package-atomic-publish.mjs",
  import.meta.url,
).href;

/**
 * The public mutators deliberately require an opaque native parent-lease
 * capability. Existing tree-safety cases are concerned with the operation
 * itself, so run each through a real lease rather than bypassing that boundary.
 */
async function withTestParentLease(parentRoot, operation) {
  let helperPid;
  const receipt = await withAtomicPublishParentLease(
    { parentRoot, timeoutMs: 2_000 },
    async (lease) => {
      helperPid = lease.helperPid;
      return operation(lease);
    },
  );
  // LCRPC1 receipts are accepted only from the process that owns the OS
  // parent lease. Keep legacy result-shape assertions below focused on their
  // operation fields after proving the new ownership context.
  assert.equal(receipt.operationOwnerPid, helperPid);
  const { operationOwnerPid, ...result } = receipt;
  return Object.freeze(result);
}

function atomicPublishDirectoryNoReplace(input) {
  return withTestParentLease(input.parentRoot, (lease) => (
    atomicPublishDirectoryNoReplaceWithLease(input, lease)
  ));
}

function securePrivateStagingDirectory(input) {
  return withTestParentLease(input.parentRoot, (lease) => (
    securePrivateStagingDirectoryWithLease(input, lease)
  ));
}

function removeAtomicPublishDirectoryTree(input) {
  return withTestParentLease(input.parentRoot, (lease) => (
    removeAtomicPublishDirectoryTreeWithLease(input, lease)
  ));
}

function removeAtomicPublishUnsecuredEmptyDirectory(input) {
  return withTestParentLease(input.parentRoot, (lease) => (
    removeAtomicPublishUnsecuredEmptyDirectoryWithLease(input, lease)
  ));
}

test("native helper preflight executes the no-side-effect platform probe", async () => {
  assert.deepEqual(await preflightAtomicPublishDirectoryNoReplace(), {
    schemaVersion: 1,
    platform: process.platform,
  });
});

test("production native helper rejects every standalone mutating verb", {
  skip: process.platform !== "darwin" && process.platform !== "win32",
}, async (t) => {
  const root = await testRoot(t);
  const nativePublisher = join(
    root,
    process.platform === "win32" ? "native-publisher.exe" : "native-publisher",
  );
  await buildNativePublisher(nativePublisher);
  for (const operation of [
    "secure-private",
    "publish",
    "remove-tree",
    "remove-unsecured-empty",
  ]) {
    const parentRoot = join(root, operation);
    const sourceName = "source";
    const sourcePath = join(parentRoot, sourceName);
    await mkdir(parentRoot, { mode: 0o700 });
    if (operation === "remove-unsecured-empty") {
      await mkdir(sourcePath, { mode: 0o755 });
    } else {
      await createSource(sourcePath, "source-value");
    }
    const inspected = JSON.parse((await execFile(
      nativePublisher,
      ["inspect", parentRoot, sourceName],
      { encoding: "utf8", timeout: 2_000 },
    )).stdout.trim());
    const sourceIdentityBefore = await fileIdentity(sourcePath);
    const securityBefore = operation === "secure-private"
      ? await nativeCommandOutcome(nativePublisher, [
          "verify-private",
          parentRoot,
          sourceName,
          inspected.parentIdentity,
          inspected.sourceIdentity,
        ])
      : undefined;
    const args = operation === "publish"
      ? [
          operation,
          parentRoot,
          sourceName,
          "destination",
          inspected.parentIdentity,
          inspected.sourceIdentity,
        ]
      : operation === "remove-tree"
        ? [
            operation,
            parentRoot,
            sourceName,
            inspected.parentIdentity,
            inspected.sourceIdentity,
            "1",
            String(Buffer.byteLength("source-value")),
          ]
        : [
            operation,
            parentRoot,
            sourceName,
            inspected.parentIdentity,
            inspected.sourceIdentity,
          ];
    const error = await captureRejection(() => execFile(
      nativePublisher,
      args,
      { encoding: "utf8", timeout: 2_000 },
    ));
    assert.equal(error.code, 22);
    const receipt = JSON.parse(error.stdout.trim());
    assert.equal(receipt.outcome, "not_committed");
    assert.equal(receipt.reason, "invalid_input");
    assert.equal(await exists(sourcePath), true);
    assertSameIdentity(await fileIdentity(sourcePath), sourceIdentityBefore);
    if (operation !== "remove-unsecured-empty") {
      assert.equal(
        await readFile(join(sourcePath, "sentinel.txt"), "utf8"),
        "source-value",
      );
    }
    if (securityBefore !== undefined) {
      assert.deepEqual(await nativeCommandOutcome(nativePublisher, [
        "verify-private",
        parentRoot,
        sourceName,
        inspected.parentIdentity,
        inspected.sourceIdentity,
      ]), securityBefore);
    }
    assert.equal(await exists(join(parentRoot, "destination")), false);
  }

  for (const testOperation of [
    "test-hold-publish",
    "test-post-commit-hold-publish",
  ]) {
    const parentRoot = join(root, `production-${testOperation}`);
    await mkdir(parentRoot, { mode: 0o700 });
    await createSource(join(parentRoot, "source"), "production-source");
    const inspected = JSON.parse((await execFile(
      nativePublisher,
      ["inspect", parentRoot, "source"],
      { encoding: "utf8", timeout: 2_000 },
    )).stdout.trim());
    const holder = await startNativeParentLockHolder(
      t,
      nativePublisher,
      parentRoot,
    );
    const rejectedTestOpcode = await finishNativeProtocolHolder(
      holder,
      Buffer.from(lcrpcCall(1, testOperation, [
        "source",
        "destination",
        inspected.parentIdentity,
        inspected.sourceIdentity,
        "ready",
        "gate",
        "completed",
      ])),
    );
    assert.equal(rejectedTestOpcode.exitCode, 21);
    assert.equal(rejectedTestOpcode.receipts.at(-1)?.outcome, "ambiguous");
    assert.equal(
      rejectedTestOpcode.receipts.at(-1)?.reason,
      "parent_lock_protocol_invalid",
    );
    assert.equal(
      await readFile(join(parentRoot, "source", "sentinel.txt"), "utf8"),
      "production-source",
    );
    for (const absentName of ["destination", "ready", "gate", "completed"]) {
      assert.equal(await exists(join(parentRoot, absentName)), false);
    }
  }
});

test("mutating publisher APIs fail closed without an active parent-lease capability", async (t) => {
  const parentRoot = await testRoot(t);
  const sourceName = "source";
  await createSource(join(parentRoot, sourceName), "source-value");
  const expected = await nativeIdentities(parentRoot, sourceName);
  const mutationCalls = [
    () => atomicPublishDirectoryNoReplaceWithLease({
      parentRoot,
      sourceName,
      destinationName: "destination",
      ...expected,
    }),
    () => securePrivateStagingDirectoryWithLease({
      parentRoot,
      directoryName: sourceName,
      expectedParentIdentity: expected.expectedParentIdentity,
      expectedDirectoryIdentity: expected.expectedSourceIdentity,
    }),
    () => removeAtomicPublishDirectoryTreeWithLease({
      parentRoot,
      sourceName,
      ...expected,
      expectedEntries: 1,
      expectedTotalBytes: Buffer.byteLength("source-value"),
    }),
    () => removeAtomicPublishUnsecuredEmptyDirectoryWithLease({
      parentRoot,
      sourceName,
      ...expected,
    }),
  ];
  for (const mutate of mutationCalls) {
    const error = await captureRejection(mutate);
    assert.ok(error instanceof CuaDriverAtomicPublishError);
    assert.equal(error.code, "staging_parent_lock_capability_required");
  }
  assert.equal(await readFile(join(parentRoot, sourceName, "sentinel.txt"), "utf8"), "source-value");
});

test("LCRPC1 client rejects lone surrogates and oversized frames before writing", () => {
  for (const invalidUnicode of ["\ud800", "\udc00", `valid-prefix-\ud800`]) {
    assert.throws(
      () => encodeNativeParentLeaseCallFrameForTest(
        1,
        "inspect",
        [invalidUnicode],
      ),
      (error) => {
        assert.ok(error instanceof CuaDriverAtomicPublishError);
        assert.equal(error.code, "staging_parent_lock_protocol_invalid");
        assert.equal(error.outcome, "ambiguous");
        return true;
      },
    );
  }

  assert.throws(
    () => encodeNativeParentLeaseCallFrameForTest(
      1,
      "inspect",
      ["a".repeat(8 * 1024)],
    ),
    (error) => {
      assert.ok(error instanceof CuaDriverAtomicPublishError);
      assert.equal(error.code, "staging_parent_lock_protocol_invalid");
      assert.equal(error.outcome, "ambiguous");
      return true;
    },
  );
});

test("LCRPC1 client rejects mismatched receipt context and never reuses a timed-out lease", async (t) => {
  const parentRoot = await testRoot(t);
  await createSource(join(parentRoot, "source"), "source-value");
  const input = {
    parentRoot,
    sourceName: "source",
    destinationName: "destination",
    expectedParentIdentity: "1:1",
    expectedSourceIdentity: "1:2",
  };
  for (const mode of [
    "invalidJson",
    "invalidArray",
    "invalidNull",
    "invalidShape",
    "lockedOutcome",
    "requestId",
    "operation",
    "operationOwnerPid",
    "releaseOutcome",
  ]) {
    const error = await captureRejection(() => withAtomicPublishParentLeaseForTest({
      parentRoot,
      timeoutMs: 2_000,
      operationTimeoutMs: 500,
      holderCommand: process.execPath,
      holderArgs: fakeLcrpcHolderArgs(mode),
    }, async (lease) => atomicPublishDirectoryNoReplaceWithLease(input, lease)));
    assert.ok(error instanceof CuaDriverAtomicPublishError);
    assert.equal(error.code, "staging_parent_lock_protocol_invalid");
  }

  let expiredLease;
  const timeout = await captureRejection(() => withAtomicPublishParentLeaseForTest({
    parentRoot,
    timeoutMs: 2_000,
    operationTimeoutMs: 20,
    holderCommand: process.execPath,
    holderArgs: fakeLcrpcHolderArgs("timeout"),
  }, async (lease) => {
    expiredLease = lease;
    return atomicPublishDirectoryNoReplaceWithLease(input, lease);
  }));
  assert.ok(timeout instanceof CuaDriverAtomicPublishError);
  assert.equal(timeout.code, "staging_parent_lock_operation_timeout");
  assert.equal(processExists(expiredLease.helperPid), false);
  const reuse = await captureRejection(() => (
    atomicPublishDirectoryNoReplaceWithLease(input, expiredLease)
  ));
  assert.ok(reuse instanceof CuaDriverAtomicPublishError);
  assert.equal(reuse.code, "staging_parent_lock_capability_required");
});

test("parent lease wrapper releases normally and classifies contention", async (t) => {
  const root = await testRoot(t);
  const parentRoot = join(root, "wrapper-parent");
  await mkdir(parentRoot, { mode: 0o700 });
  let releaseFirst;
  let firstEntered;
  const firstReady = new Promise((resolve) => {
    firstEntered = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  t.after(() => releaseFirst());

  const first = withAtomicPublishParentLease(
    { parentRoot, timeoutMs: 2_000 },
    async (lease) => {
      assert.match(lease.parentIdentity, /^[0-9a-f]+:[0-9a-f]+$/u);
      firstEntered();
      await firstGate;
      lease.assertHeld();
      return "first";
    },
  );
  await firstReady;

  await assert.rejects(
    withAtomicPublishParentLease(
      { parentRoot, timeoutMs: 40 },
      async () => "unexpected",
    ),
    (error) => {
      assert.equal(error?.code, "staging_parent_lock_timeout");
      assert.equal(error?.nativeReason, "parent_lock_timeout");
      assert.equal(error?.outcome, "not_committed");
      return true;
    },
  );
  releaseFirst();
  assert.equal(await first, "first");
  assert.equal(await withAtomicPublishParentLease(
    { parentRoot, timeoutMs: 2_000 },
    async () => "next",
  ), "next");
});

test("parent lease loss aborts and drains guarded work before returning", async (t) => {
  const root = await testRoot(t);
  const parentRoot = join(root, "lost-helper-parent");
  const markerPath = join(root, "must-not-write-after-lock-loss");
  await mkdir(parentRoot, { mode: 0o700 });
  let guardedFinished = false;

  await assert.rejects(
    withAtomicPublishParentLease(
      { parentRoot, timeoutMs: 2_000 },
      async (lease) => {
        process.kill(lease.helperPid, "SIGKILL");
        await lease.guard(async (signal) => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          if (!signal.aborted) {
            await writeFile(markerPath, "late-write");
          }
          guardedFinished = true;
        });
      },
    ),
    (error) => {
      assert.equal(error?.code, "staging_parent_lock_lost");
      assert.equal(error?.outcome, "ambiguous");
      return true;
    },
  );
  assert.equal(guardedFinished, true);
  assert.equal(await exists(markerPath), false);
  const recoveredAbandonedLock = await withAtomicPublishParentLease(
    { parentRoot, timeoutMs: 2_000 },
    async (lease) => lease.recoveredAbandonedLock,
  );
  // Windows reports WAIT_ABANDONED only to a contender that was already
  // waiting when the owner died. A later opener may create a new mutex, so
  // recovery correctness must never depend on this diagnostic.
  assert.equal(typeof recoveredAbandonedLock, "boolean");
});

test("parent leases for different canonical parents remain independent", async (t) => {
  const root = await testRoot(t);
  const parents = [join(root, "parent-a"), join(root, "parent-b")];
  await Promise.all(parents.map((parentRoot) => mkdir(parentRoot, { mode: 0o700 })));
  let arrivals = 0;
  let releaseBoth;
  const bothEntered = new Promise((resolve) => {
    releaseBoth = resolve;
  });
  const enter = async () => {
    arrivals += 1;
    if (arrivals === 2) releaseBoth();
    await bothEntered;
  };
  t.after(() => releaseBoth());

  await Promise.all(parents.map((parentRoot) => withAtomicPublishParentLease(
    { parentRoot, timeoutMs: 2_000 },
    enter,
  )));
  assert.equal(arrivals, 2);
});

test("parent lease serializes independent Node processes", async (t) => {
  const root = await testRoot(t);
  const parentRoot = join(root, "cross-process-parent");
  await mkdir(parentRoot, { mode: 0o700 });
  const environment = {
    ...process.env,
    LING_TEST_ATOMIC_PUBLISH_MODULE: ATOMIC_PUBLISH_MODULE_URL,
    LING_TEST_PARENT_ROOT: parentRoot,
  };
  const holder = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `const api = await import(process.env.LING_TEST_ATOMIC_PUBLISH_MODULE);
     await api.withAtomicPublishParentLease(
       { parentRoot: process.env.LING_TEST_PARENT_ROOT, timeoutMs: 10_000 },
       async () => {
         process.stdout.write("locked\\n");
         await new Promise((resolve) => process.stdin.once("data", resolve));
       },
     );`,
  ], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(async () => {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill("SIGKILL");
      await waitForChildExit(holder);
    }
  });
  const holderLines = createInterface({
    crlfDelay: Infinity,
    input: holder.stdout,
  });
  t.after(() => holderLines.close());
  const holderIterator = holderLines[Symbol.asyncIterator]();
  assert.equal((await holderIterator.next()).value, "locked");

  const contender = await execFile(process.execPath, [
    "--input-type=module",
    "--eval",
    `const api = await import(process.env.LING_TEST_ATOMIC_PUBLISH_MODULE);
     try {
       await api.withAtomicPublishParentLease(
         { parentRoot: process.env.LING_TEST_PARENT_ROOT, timeoutMs: 50 },
         async () => process.stdout.write("entered\\n"),
       );
     } catch (error) {
       process.stdout.write(JSON.stringify({ code: error.code, entered: false }) + "\\n");
     }`,
  ], {
    encoding: "utf8",
    env: environment,
    timeout: 15_000,
    windowsHide: true,
  });
  assert.deepEqual(JSON.parse(contender.stdout.trim()), {
    code: "staging_parent_lock_timeout",
    entered: false,
  });

  holder.stdin.end("release\n");
  assert.equal(await waitForChildExit(holder), 0);
});

test("parent lease is released when its Node owner is killed", async (t) => {
  const root = await testRoot(t);
  const parentRoot = join(root, "crashed-owner-parent");
  await mkdir(parentRoot, { mode: 0o700 });
  const environment = {
    ...process.env,
    LING_TEST_ATOMIC_PUBLISH_MODULE: ATOMIC_PUBLISH_MODULE_URL,
    LING_TEST_PARENT_ROOT: parentRoot,
  };
  const holder = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    `const api = await import(process.env.LING_TEST_ATOMIC_PUBLISH_MODULE);
     await api.withAtomicPublishParentLease(
       { parentRoot: process.env.LING_TEST_PARENT_ROOT, timeoutMs: 10_000 },
       async () => {
         process.stdout.write("locked\\n");
         await new Promise(() => {});
       },
     );`,
  ], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const holderLines = createInterface({
    crlfDelay: Infinity,
    input: holder.stdout,
  });
  t.after(() => holderLines.close());
  assert.equal(
    (await holderLines[Symbol.asyncIterator]().next()).value,
    "locked",
  );
  holder.kill("SIGKILL");
  await waitForChildExit(holder);

  const next = await execFile(process.execPath, [
    "--input-type=module",
    "--eval",
    `const api = await import(process.env.LING_TEST_ATOMIC_PUBLISH_MODULE);
     const value = await api.withAtomicPublishParentLease(
       { parentRoot: process.env.LING_TEST_PARENT_ROOT, timeoutMs: 5_000 },
       async () => "recovered",
     );
     process.stdout.write(value + "\\n");`,
  ], {
    encoding: "utf8",
    env: environment,
    timeout: 15_000,
    windowsHide: true,
  });
  assert.equal(next.stdout.trim(), "recovered");
});

test("Darwin native parent vnode lease serializes by exact parent identity", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const root = await testRoot(t);
  const nativePublisher = join(root, "native-publisher");
  await buildNativePublisher(nativePublisher);

  await t.test("holds the lease until an exact release command", async (t) => {
    const parentRoot = join(root, "release-parent");
    await mkdir(parentRoot, { mode: 0o700 });
    const holder = await startNativeParentLockHolder(
      t,
      nativePublisher,
      parentRoot,
    );

    assertParentLockReceipt(holder.locked, "locked", false);
    assert.equal(
      await exists(join(parentRoot, LEGACY_PARENT_LOCK_FILE_NAME)),
      false,
    );

    const released = await finishNativeParentLockHolder(holder);
    assertParentLockReceipt(released.receipt, "released", false);
    assert.equal(released.exitCode, 0);
    assert.equal(
      await exists(join(parentRoot, LEGACY_PARENT_LOCK_FILE_NAME)),
      false,
    );
  });

  await t.test("times out a concurrent holder and permits the next holder", async (t) => {
    const parentRoot = join(root, "timeout-parent");
    await mkdir(parentRoot, { mode: 0o700 });
    const first = await startNativeParentLockHolder(
      t,
      nativePublisher,
      parentRoot,
    );

    const timeoutError = await captureRejection(() => execFile(
      nativePublisher,
      ["hold-parent-lock", parentRoot, "40"],
      { encoding: "utf8", timeout: 2_000 },
    ));
    assert.equal(timeoutError.code, 20);
    const timeoutReceipt = JSON.parse(timeoutError.stdout.trim());
    assert.equal(timeoutReceipt.outcome, "not_committed");
    assert.equal(timeoutReceipt.reason, "parent_lock_timeout");
    assert.ok(timeoutReceipt.nativeCode > 0);

    assert.equal((await finishNativeParentLockHolder(first)).exitCode, 0);
    const next = await startNativeParentLockHolder(
      t,
      nativePublisher,
      parentRoot,
    );
    assertParentLockReceipt(next.locked, "locked", false);
    assert.equal((await finishNativeParentLockHolder(next)).exitCode, 0);
  });

  await t.test("renaming a legacy lock entry cannot split the parent vnode lease", async (t) => {
    const parentRoot = join(root, "lock-entry-replacement-parent");
    const lockPath = join(parentRoot, LEGACY_PARENT_LOCK_FILE_NAME);
    const displacedPath = join(parentRoot, "displaced-legacy-lock");
    await mkdir(parentRoot, { mode: 0o700 });
    await writeFile(lockPath, "legacy", { mode: 0o600 });
    const holder = await startNativeParentLockHolder(
      t,
      nativePublisher,
      parentRoot,
    );

    await rename(lockPath, displacedPath);
    await writeFile(lockPath, "replacement", { mode: 0o600 });
    const timeoutError = await captureRejection(() => execFile(
      nativePublisher,
      ["hold-parent-lock", parentRoot, "40"],
      { encoding: "utf8", timeout: 2_000 },
    ));
    assert.equal(timeoutError.code, 20);
    assert.equal(JSON.parse(timeoutError.stdout.trim()).reason, "parent_lock_timeout");
    assert.equal(await readFile(displacedPath, "utf8"), "legacy");
    assert.equal(await readFile(lockPath, "utf8"), "replacement");

    assert.equal((await finishNativeParentLockHolder(holder)).exitCode, 0);
  });

  await t.test("rejects a non-exact release and still releases by RAII", async (t) => {
    const parentRoot = join(root, "invalid-release-parent");
    await mkdir(parentRoot, { mode: 0o700 });
    const holder = await startNativeParentLockHolder(
      t,
      nativePublisher,
      parentRoot,
    );
    const rejected = await finishNativeParentLockHolder(
      holder,
      "LCRPC1\trelease\t1\ntrailing",
    );
    assert.equal(rejected.receipt.outcome, "ambiguous");
    assert.equal(rejected.receipt.reason, "parent_lock_protocol_invalid");
    assert.equal(rejected.exitCode, 21);

    const next = await startNativeParentLockHolder(
      t,
      nativePublisher,
      parentRoot,
    );
    assert.equal((await finishNativeParentLockHolder(next)).exitCode, 0);
  });
});

test("LCRPC1 binds successful mutations to the native holder and rejects malformed frames", {
  skip: process.platform !== "darwin" && process.platform !== "win32",
}, async (t) => {
  const root = await testRoot(t);
  const nativePublisher = nativePublisherTestPath(root);
  await buildNativePublisher(nativePublisher);

  await t.test("a successful publish receipt names the lock-holder process", async (t) => {
    const parentRoot = join(root, "receipt-parent");
    await mkdir(parentRoot, { mode: 0o700 });
    await createSource(join(parentRoot, "source"), "receipt-source");
    const holder = await startNativeParentLockHolder(t, nativePublisher, parentRoot);

    holder.child.stdin.write(lcrpcCall(1, "inspect", ["source"]));
    const inspected = await nextNativeReceipt(holder);
    assert.equal(inspected.outcome, "inspected");
    assert.equal(inspected.requestId, 1);
    assert.equal(inspected.operation, "inspect");
    assert.equal(inspected.operationOwnerPid, holder.child.pid);

    holder.child.stdin.write(lcrpcCall(2, "publish", [
      "source",
      "destination",
      inspected.parentIdentity,
      inspected.sourceIdentity,
    ]));
    const published = await nextNativeReceipt(holder);
    assert.equal(published.outcome, "committed");
    assert.equal(published.requestId, 2);
    assert.equal(published.operation, "publish");
    assert.equal(published.operationOwnerPid, holder.child.pid);
    assert.equal(await exists(join(parentRoot, "destination")), true);

    const released = await finishNativeParentLockHolder(holder, "LCRPC1\trelease\t3\n");
    assert.equal(released.receipt.requestId, 3);
    assert.equal(released.receipt.operationOwnerPid, holder.child.pid);
    assert.equal(released.exitCode, 0);
  });

  const invalidFrames = [
    ["oversized", Buffer.from(`LCRPC1\tcall\t1\tinspect\t1\t${"00".repeat(9_000)}\n`)],
    ["odd hex", Buffer.from("LCRPC1\tcall\t1\tinspect\t1\t0\n")],
    ["non-hex", Buffer.from("LCRPC1\tcall\t1\tinspect\t1\tgg\n")],
    // The field itself is valid lowercase hex. Its decoded byte sequence is
    // an overlong UTF-8 encoding, which must fail strict UTF-8 validation.
    ["invalid UTF-8", Buffer.from("LCRPC1\tcall\t1\tinspect\t1\tc080\n")],
    ["unknown opcode", Buffer.from("LCRPC1\tcall\t1\tunknown\t0\n")],
    ["wrong arity", Buffer.from("LCRPC1\tcall\t1\tinspect\t0\n")],
    ["duplicate request id", Buffer.from(
      "LCRPC1\tcall\t1\tinspect\t1\t736f75726365\n"
      + "LCRPC1\tcall\t1\tinspect\t1\t736f75726365\n",
    )],
    ["out-of-order request id", Buffer.from("LCRPC1\tcall\t2\tinspect\t1\t736f75726365\n")],
    ["partial EOF", Buffer.from("LCRPC1\tcall\t1\tinspect\t1\t736f75726365")],
  ];
  for (const [name, frame] of invalidFrames) {
    await t.test(name, async (t) => {
      const parentRoot = join(root, `invalid-${name.replaceAll(" ", "-")}`);
      await mkdir(parentRoot, { mode: 0o700 });
      await createSource(join(parentRoot, "source"), "source-value");
      const holder = await startNativeParentLockHolder(t, nativePublisher, parentRoot);
      const result = await finishNativeProtocolHolder(holder, frame);
      const receipt = result.receipts.at(-1);
      assert.equal(receipt.outcome, "ambiguous");
      assert.equal(receipt.reason, "parent_lock_protocol_invalid");
      assert.equal(result.exitCode, 21);
    });
  }
});

test("lease-owned publish keeps or drops the lock with its native holder", {
  skip: process.platform !== "darwin" && process.platform !== "win32",
}, async (t) => {
  const root = await testRoot(t);
  const nativePublisher = nativePublisherTestPath(root, "native-publisher-test-gate");
  await buildNativePublisher(nativePublisher, { testGate: true });

  async function setupHeldPublish(
    t,
    name,
    operation = "test-hold-publish",
  ) {
    const parentRoot = join(root, name);
    await mkdir(parentRoot, { mode: 0o700 });
    await createSource(join(parentRoot, "source"), name);
    const expected = await nativeIdentities(parentRoot, "source");
    const holder = await startNativeParentLockHolder(t, nativePublisher, parentRoot, 10_000);
    const readyName = "ready";
    const gateName = "gate";
    const completionName = "completed";
    holder.child.stdin.write(lcrpcCall(1, operation, [
      "source",
      "destination",
      expected.expectedParentIdentity,
      expected.expectedSourceIdentity,
      readyName,
      gateName,
      completionName,
    ]));
    await waitForPath(join(parentRoot, readyName));
    return {
      completionName,
      expected,
      gateName,
      holder,
      operation,
      parentRoot,
      readyName,
    };
  }

  async function setupNodeOwnedPublish(t, name) {
    const parentRoot = join(root, name);
    await mkdir(parentRoot, { mode: 0o700 });
    await createSource(join(parentRoot, "source"), name);
    const expected = await nativeIdentities(parentRoot, "source");
    const readyName = "ready";
    const gateName = "gate";
    const completionName = "completed";
    const owner = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      nodeOwnedHeldPublishSource(),
    ], {
      env: {
        ...process.env,
        LING_TEST_COMPLETION_NAME: completionName,
        LING_TEST_DESTINATION_NAME: "destination",
        LING_TEST_EXPECTED_PARENT_IDENTITY: expected.expectedParentIdentity,
        LING_TEST_EXPECTED_SOURCE_IDENTITY: expected.expectedSourceIdentity,
        LING_TEST_GATE_NAME: gateName,
        LING_TEST_NATIVE_PUBLISHER: nativePublisher,
        LING_TEST_PARENT_ROOT: parentRoot,
        LING_TEST_READY_NAME: readyName,
        LING_TEST_SOURCE_NAME: "source",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const ownerLines = createInterface({ input: owner.stdout, crlfDelay: Infinity });
    const ownerIterator = ownerLines[Symbol.asyncIterator]();
    const ownerReady = await nextJsonChildLine(
      owner,
      ownerIterator,
      "Node owner exited before its native RPC reached the hold gate",
    );
    assert.ok(Number.isSafeInteger(ownerReady.holderPid));
    assert.ok(ownerReady.holderPid > 0);
    assert.equal(ownerReady.locked?.outcome, "locked");

    t.after(async () => {
      ownerLines.close();
      if (owner.exitCode === null && owner.signalCode === null) {
        forceKillChildForTest(owner);
        await waitForChildExit(owner);
      }
      if (processExists(ownerReady.holderPid)) {
        await writeFile(join(parentRoot, gateName), "cleanup", {
          flag: "a",
          mode: 0o600,
        });
        await waitForProcessExit(ownerReady.holderPid, 500).catch(() => {});
      }
      if (processExists(ownerReady.holderPid)) {
        forceKillPidForTest(ownerReady.holderPid);
      }
    });
    return {
      completionName,
      expected,
      gateName,
      holderPid: ownerReady.holderPid,
      owner,
      parentRoot,
      readyName,
    };
  }

  async function inspectWithTestNative(parentRoot, sourceName) {
    return JSON.parse((await execFile(
      nativePublisher,
      ["inspect", parentRoot, sourceName],
      { encoding: "utf8", timeout: 2_000, windowsHide: true },
    )).stdout.trim());
  }

  await t.test("parent path replacement before commit cannot publish through the displaced lock", async (t) => {
    const fixture = await setupHeldPublish(t, "parent-replaced-before-commit");
    const displacedParent = join(root, "parent-replaced-before-commit-displaced");

    await rename(fixture.parentRoot, displacedParent);
    await mkdir(fixture.parentRoot, { mode: 0o700 });

    const replacementHolder = await startNativeParentLockHolder(
      t,
      nativePublisher,
      fixture.parentRoot,
    );
    assert.notEqual(
      replacementHolder.locked.parentIdentity,
      fixture.expected.expectedParentIdentity,
    );
    assert.equal((await finishNativeParentLockHolder(replacementHolder)).exitCode, 0);

    await writeFile(join(displacedParent, fixture.gateName), "go", { mode: 0o600 });
    const rejected = await nextNativeReceipt(fixture.holder);
    assert.equal(rejected.outcome, "not_committed");
    assert.equal(rejected.reason, "parent_identity_mismatch");
    assert.equal(rejected.requestId, 1);
    assert.equal(rejected.operation, fixture.operation);
    assert.equal(rejected.operationOwnerPid, fixture.holder.child.pid);

    const displacedSource = await inspectWithTestNative(displacedParent, "source");
    assert.equal(
      displacedSource.parentIdentity,
      fixture.expected.expectedParentIdentity,
    );
    assert.equal(
      displacedSource.sourceIdentity,
      fixture.expected.expectedSourceIdentity,
    );
    assert.equal(
      await readFile(join(displacedParent, "source", "sentinel.txt"), "utf8"),
      "parent-replaced-before-commit",
    );
    for (const parent of [displacedParent, fixture.parentRoot]) {
      assert.equal(await exists(join(parent, "destination")), false);
      assert.equal(await exists(join(parent, fixture.completionName)), false);
    }

    const released = await finishNativeParentLockHolder(
      fixture.holder,
      "LCRPC1\trelease\t2\n",
    );
    assert.equal(released.exitCode, 0);
    assert.equal(released.receipt.requestId, 2);
  });

  await t.test("parent path replacement after commit is reported as ambiguous", async (t) => {
    const fixture = await setupHeldPublish(
      t,
      "parent-replaced-after-commit",
      "test-post-commit-hold-publish",
    );
    const displacedParent = join(root, "parent-replaced-after-commit-displaced");

    assert.equal(await exists(join(fixture.parentRoot, "source")), false);
    assert.equal(await exists(join(fixture.parentRoot, "destination")), true);
    await rename(fixture.parentRoot, displacedParent);
    await mkdir(fixture.parentRoot, { mode: 0o700 });

    const replacementHolder = await startNativeParentLockHolder(
      t,
      nativePublisher,
      fixture.parentRoot,
    );
    assert.notEqual(
      replacementHolder.locked.parentIdentity,
      fixture.expected.expectedParentIdentity,
    );
    assert.equal((await finishNativeParentLockHolder(replacementHolder)).exitCode, 0);

    await writeFile(join(displacedParent, fixture.gateName), "go", { mode: 0o600 });
    const ambiguous = await nextNativeReceipt(fixture.holder);
    assert.equal(ambiguous.outcome, "ambiguous");
    assert.equal(ambiguous.reason, "parent_identity_mismatch");
    assert.equal(ambiguous.requestId, 1);
    assert.equal(ambiguous.operation, fixture.operation);
    assert.equal(ambiguous.operationOwnerPid, fixture.holder.child.pid);

    const displacedDestination = await inspectWithTestNative(
      displacedParent,
      "destination",
    );
    assert.equal(
      displacedDestination.parentIdentity,
      fixture.expected.expectedParentIdentity,
    );
    assert.equal(
      displacedDestination.sourceIdentity,
      fixture.expected.expectedSourceIdentity,
    );
    assert.equal(await exists(join(displacedParent, "source")), false);
    assert.equal(
      await readFile(join(displacedParent, "destination", "sentinel.txt"), "utf8"),
      "parent-replaced-after-commit",
    );
    for (const name of ["source", "destination", fixture.completionName]) {
      assert.equal(await exists(join(fixture.parentRoot, name)), false);
    }
    assert.equal(await exists(join(displacedParent, fixture.completionName)), false);

    const released = await finishNativeParentLockHolder(
      fixture.holder,
      "LCRPC1\trelease\t2\n",
    );
    assert.equal(released.exitCode, 0);
    assert.equal(released.receipt.requestId, 2);
  });

  await t.test("caller EOF during a running RPC leaves the holder locked until publish completes", async (t) => {
    const fixture = await setupHeldPublish(t, "caller-eof");
    // This is the owner-crash window: the pipe closes while the native holder
    // is inside its operation. It must not release the OS lease midway.
    fixture.holder.child.stdin.end();
    const contender = await captureRejection(() => execFile(
      nativePublisher,
      ["hold-parent-lock", fixture.parentRoot, "40"],
      { encoding: "utf8", timeout: 2_000, windowsHide: true },
    ));
    assert.equal(contender.code, 20);
    assert.equal(JSON.parse(contender.stdout.trim()).reason, "parent_lock_timeout");

    await writeFile(join(fixture.parentRoot, fixture.gateName), "go", { mode: 0o600 });
    const published = await nextNativeReceipt(fixture.holder);
    assert.equal(published.outcome, "committed");
    assert.equal(published.operationOwnerPid, fixture.holder.child.pid);
    // A clean owner-pipe EOF is a normal lease release once the in-flight
    // native operation has completed. Only a partial frame is protocol-invalid.
    assert.equal(await waitForChildExit(fixture.holder.child), 0);
    assert.equal(await exists(join(fixture.parentRoot, fixture.completionName)), true);
    assert.equal(await exists(join(fixture.parentRoot, "destination")), true);

    const next = await startNativeParentLockHolder(t, nativePublisher, fixture.parentRoot);
    assert.equal((await finishNativeParentLockHolder(next)).exitCode, 0);
  });

  await t.test("killing the Node owner mid-RPC keeps the holder leased or fails closed", async (t) => {
    const fixture = await setupNodeOwnedPublish(t, "node-owner-kill");
    forceKillChildForTest(fixture.owner);
    await waitForChildExit(fixture.owner);

    const assertFailedClosed = async () => {
      assert.equal(processExists(fixture.holderPid), false);
      assert.equal(
        await exists(join(fixture.parentRoot, fixture.completionName)),
        false,
      );
      assert.equal(await exists(join(fixture.parentRoot, "destination")), false);
      assert.equal(await exists(join(fixture.parentRoot, "source")), true);
      assert.equal(
        await readFile(join(fixture.parentRoot, "source", "sentinel.txt"), "utf8"),
        "node-owner-kill",
      );
      const source = await inspectWithTestNative(fixture.parentRoot, "source");
      assert.equal(
        source.parentIdentity,
        fixture.expected.expectedParentIdentity,
      );
      assert.equal(
        source.sourceIdentity,
        fixture.expected.expectedSourceIdentity,
      );
    };

    if (processExists(fixture.holderPid)) {
      const contender = await nativeCommandOutcome(nativePublisher, [
        "hold-parent-lock",
        fixture.parentRoot,
        "40",
      ]);
      if (contender.code === 20) {
        assert.equal(
          JSON.parse(contender.stdout.trim()).reason,
          "parent_lock_timeout",
        );
        assert.equal(await exists(join(fixture.parentRoot, "destination")), false);
      } else {
        // The holder may observe its dead owner's pipe closure while the
        // contender waits. Recovery is safe only after that holder is gone.
        assert.equal(contender.code, 0);
        assert.equal(processExists(fixture.holderPid), false);
      }
    }

    if (processExists(fixture.holderPid)) {
      await writeFile(join(fixture.parentRoot, fixture.gateName), "go", {
        mode: 0o600,
      });
      const completionPath = join(fixture.parentRoot, fixture.completionName);
      const deadline = Date.now() + 2_000;
      while (
        !await exists(completionPath)
        && processExists(fixture.holderPid)
        && Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (await exists(completionPath)) {
        assert.equal(await exists(join(fixture.parentRoot, "destination")), true);
        assert.equal(await exists(join(fixture.parentRoot, "source")), false);
        await waitForProcessExit(fixture.holderPid, 2_000);
      } else {
        await assertFailedClosed();
      }
    } else {
      await assertFailedClosed();
    }

    const next = await startNativeParentLockHolder(t, nativePublisher, fixture.parentRoot);
    assert.equal((await finishNativeParentLockHolder(next)).exitCode, 0);
  });

  await t.test("release queued behind an in-flight RPC does not unlock early", async (t) => {
    const fixture = await setupHeldPublish(t, "release-queued");
    fixture.holder.child.stdin.end("LCRPC1\trelease\t2\n");
    const contender = await captureRejection(() => execFile(
      nativePublisher,
      ["hold-parent-lock", fixture.parentRoot, "40"],
      { encoding: "utf8", timeout: 2_000, windowsHide: true },
    ));
    assert.equal(contender.code, 20);

    await writeFile(join(fixture.parentRoot, fixture.gateName), "go", { mode: 0o600 });
    const published = await nextNativeReceipt(fixture.holder);
    assert.equal(published.outcome, "committed");
    assert.equal(published.operationOwnerPid, fixture.holder.child.pid);
    const released = await nextNativeReceipt(fixture.holder);
    assert.equal(released.outcome, "released");
    assert.equal(released.requestId, 2);
    assert.equal(released.operationOwnerPid, fixture.holder.child.pid);
    assert.equal(await waitForChildExit(fixture.holder.child), 0);
    assert.equal(await exists(join(fixture.parentRoot, fixture.completionName)), true);
    const next = await startNativeParentLockHolder(t, nativePublisher, fixture.parentRoot);
    assert.equal((await finishNativeParentLockHolder(next)).exitCode, 0);
  });

  await t.test("holder death mid-RPC leaves no completion and permits only later recovery", async (t) => {
    const fixture = await setupHeldPublish(t, "holder-kill");
    forceKillChildForTest(fixture.holder.child);
    await waitForChildExit(fixture.holder.child);
    assert.equal(await exists(join(fixture.parentRoot, fixture.completionName)), false);
    assert.equal(await exists(join(fixture.parentRoot, "destination")), false);
    assert.equal(await exists(join(fixture.parentRoot, "source")), true);
    const next = await startNativeParentLockHolder(t, nativePublisher, fixture.parentRoot);
    assert.equal((await finishNativeParentLockHolder(next)).exitCode, 0);
  });
});

test("native operation watchdog terminates the whole lock holder before a stalled RPC can mutate", {
  skip: process.platform !== "darwin" && process.platform !== "win32",
  timeout: 30_000,
}, async (t) => {
  const root = await testRoot(t);
  const nativePublisher = nativePublisherTestPath(root, "native-publisher-watchdog");
  await buildNativePublisher(nativePublisher, {
    testGate: true,
    watchdogMs: 200,
  });
  const parentRoot = join(root, "watchdog-parent");
  await mkdir(parentRoot, { mode: 0o700 });
  await createSource(join(parentRoot, "source"), "watchdog-source");
  const inspected = JSON.parse((await execFile(
    nativePublisher,
    ["inspect", parentRoot, "source"],
    { encoding: "utf8", timeout: 2_000, windowsHide: true },
  )).stdout.trim());
  const holder = await startNativeParentLockHolder(
    t,
    nativePublisher,
    parentRoot,
    2_000,
  );
  holder.child.stdin.write(lcrpcCall(1, "test-hold-publish", [
    "source",
    "destination",
    inspected.parentIdentity,
    inspected.sourceIdentity,
    "ready",
    "never-created-gate",
    "completed",
  ]));
  await waitForPath(join(parentRoot, "ready"));

  assert.equal(await waitForChildExit(holder.child), 21);
  assert.equal(await exists(join(parentRoot, "source")), true);
  assert.equal(await exists(join(parentRoot, "destination")), false);
  assert.equal(await exists(join(parentRoot, "completed")), false);

  const next = await startNativeParentLockHolder(t, nativePublisher, parentRoot);
  assert.equal((await finishNativeParentLockHolder(next)).exitCode, 0);
});

test("Windows contender already waiting observes WAIT_ABANDONED after holder death", {
  skip: process.platform !== "win32",
}, async (t) => {
  const root = await testRoot(t);
  const nativePublisher = join(root, "native-publisher.exe");
  await buildNativePublisher(nativePublisher, { testGate: true });
  const parentRoot = join(root, "abandoned-parent");
  await mkdir(parentRoot, { mode: 0o700 });
  const owner = await startNativeParentLockHolder(t, nativePublisher, parentRoot, 10_000);
  const contender = await startWindowsWaitingParentLockHolder(
    t,
    nativePublisher,
    parentRoot,
    "contender-waiting",
  );
  await waitForPath(join(parentRoot, "contender-waiting"));
  forceKillChildForTest(owner.child);
  await waitForChildExit(owner.child);

  const locked = await nextNativeReceipt(contender);
  assert.equal(locked.outcome, "locked");
  assert.equal(locked.recoveredAbandonedLock, true);
  const released = await finishNativeParentLockHolder(contender);
  assert.equal(released.exitCode, 0);
});

test("Darwin helper execution stays bound to the held vnode across path replacement", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const root = await testRoot(t);
  const executable = join(root, "identity-runner");
  const retained = join(root, "identity-runner-retained");
  await writeFile(executable, "#!/bin/sh\nprintf original", { mode: 0o700 });

  const result = await runDarwinIdentityBoundExecutableForTest(
    executable,
    [],
    async () => {
      await rename(executable, retained);
      await writeFile(executable, "#!/bin/sh\nprintf replacement", { mode: 0o700 });
    },
  );

  assert.equal(result.stdout, "original");
  assert.equal(await readFile(executable, "utf8"), "#!/bin/sh\nprintf replacement");
});

test("Darwin helper execution fails closed when the held vnode is unlinked", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const root = await testRoot(t);
  const executable = join(root, "identity-runner");
  await writeFile(executable, "#!/bin/sh\nprintf original", { mode: 0o700 });

  await assert.rejects(runDarwinIdentityBoundExecutableForTest(
    executable,
    [],
    async () => {
      await rm(executable);
      await writeFile(executable, "#!/bin/sh\nprintf replacement", { mode: 0o700 });
    },
  ));

  assert.equal(await readFile(executable, "utf8"), "#!/bin/sh\nprintf replacement");
});

test("secures, verifies and idempotently re-secures a private staging directory", async (t) => {
  const parentRoot = await testRoot(t);
  const directoryName = "private-stage";
  const directoryPath = join(parentRoot, directoryName);
  await mkdir(directoryPath, { mode: 0o755 });
  const expectedIdentities = await readAtomicPublishDirectoryIdentities({
    parentRoot,
    sourceName: directoryName,
  });

  const secured = await securePrivateStagingDirectory({
    parentRoot,
    directoryName,
    expectedParentIdentity: expectedIdentities.parentIdentity,
    expectedDirectoryIdentity: expectedIdentities.sourceIdentity,
  });
  assert.equal(Object.isFrozen(secured), true);
  assert.equal(secured.outcome, "secured");
  assert.equal(secured.platform, process.platform);
  assert.match(secured.parentIdentity, /^[0-9a-f]+:[0-9a-f]+$/u);
  assert.match(secured.directoryIdentity, /^[0-9a-f]+:[0-9a-f]+$/u);
  if (process.platform === "darwin") {
    assert.equal(secured.ownerIdentity, `euid:${process.geteuid()}`);
    assert.equal(secured.securityProfile, "current-euid-mode-0700");
    assert.equal(secured.childrenInheritProtection, false);
    const metadata = await lstat(directoryPath);
    assert.equal(metadata.uid, process.geteuid());
    assert.equal(metadata.mode & 0o7777, 0o700);
  } else {
    assert.match(secured.ownerIdentity, /^S-(?:[0-9]+-)+[0-9]+$/u);
    assert.equal(
      secured.securityProfile,
      "protected-dacl-current-user-system-administrators",
    );
    assert.equal(secured.childrenInheritProtection, true);
  }

  await writeFile(join(directoryPath, "inherited-child.txt"), "private-child");
  const verified = await verifyPrivateStagingDirectorySecurity({
    parentRoot,
    directoryName,
    expectedParentIdentity: secured.parentIdentity,
    expectedDirectoryIdentity: secured.directoryIdentity,
  });
  assert.deepEqual(verified, {
    ...secured,
    outcome: "verified",
  });

  const securedAgain = await securePrivateStagingDirectory({
    parentRoot,
    directoryName,
    expectedParentIdentity: expectedIdentities.parentIdentity,
    expectedDirectoryIdentity: expectedIdentities.sourceIdentity,
  });
  assert.deepEqual(securedAgain, secured);
  assert.equal(
    await readFile(join(directoryPath, "inherited-child.txt"), "utf8"),
    "private-child",
  );

  if (process.platform === "darwin") {
    await chmod(directoryPath, 0o755);
    const error = await captureRejection(() => (
      verifyPrivateStagingDirectorySecurity({
        parentRoot,
        directoryName,
        expectedParentIdentity: secured.parentIdentity,
        expectedDirectoryIdentity: secured.directoryIdentity,
      })
    ));
    assert.ok(error instanceof CuaDriverAtomicPublishError);
    assert.equal(error.code, "staging_private_directory_invalid");
    assert.equal(error.nativeReason, "directory_security_invalid");
    await securePrivateStagingDirectory({
      parentRoot,
      directoryName,
      expectedParentIdentity: expectedIdentities.parentIdentity,
      expectedDirectoryIdentity: expectedIdentities.sourceIdentity,
    });
  }
});

test("identity-bound private security rejects a replaced parent or directory before mutation", async (t) => {
  await t.test("replaced directory", async (t) => {
    const parentRoot = await testRoot(t);
    const directoryName = "private-stage";
    const directoryPath = join(parentRoot, directoryName);
    const displacedPath = join(parentRoot, "displaced-stage");
    await mkdir(directoryPath, { mode: 0o755 });
    const expected = await readAtomicPublishDirectoryIdentities({
      parentRoot,
      sourceName: directoryName,
    });
    await rename(directoryPath, displacedPath);
    await mkdir(directoryPath, { mode: 0o755 });
    await writeFile(join(directoryPath, "valuable.txt"), "replacement-value");
    const replacementBefore = await lstat(directoryPath, { bigint: true });

    const error = await captureRejection(() => securePrivateStagingDirectory({
      parentRoot,
      directoryName,
      expectedParentIdentity: expected.parentIdentity,
      expectedDirectoryIdentity: expected.sourceIdentity,
    }));

    assert.ok(error instanceof CuaDriverAtomicPublishError);
    assert.equal(error.outcome, "not_committed");
    assert.equal(error.nativeReason, "directory_identity_mismatch");
    assertSameIdentity(await fileIdentity(directoryPath), replacementBefore);
    assert.equal(await readFile(join(directoryPath, "valuable.txt"), "utf8"), "replacement-value");
    if (process.platform === "darwin") {
      assert.equal((await lstat(directoryPath)).mode & 0o7777, 0o755);
    }
    assert.equal(await exists(displacedPath), true);
  });

  await t.test("replaced parent", async (t) => {
    const holder = await testRoot(t);
    const parentRoot = join(holder, "parent");
    const displacedParent = join(holder, "displaced-parent");
    const directoryName = "private-stage";
    await mkdir(parentRoot);
    await mkdir(join(parentRoot, directoryName), { mode: 0o755 });
    const expected = await readAtomicPublishDirectoryIdentities({
      parentRoot,
      sourceName: directoryName,
    });
    await rename(parentRoot, displacedParent);
    await mkdir(parentRoot);
    await rename(
      join(displacedParent, directoryName),
      join(parentRoot, directoryName),
    );

    const error = await captureRejection(() => securePrivateStagingDirectory({
      parentRoot,
      directoryName,
      expectedParentIdentity: expected.parentIdentity,
      expectedDirectoryIdentity: expected.sourceIdentity,
    }));

    assert.ok(error instanceof CuaDriverAtomicPublishError);
    assert.equal(error.outcome, "not_committed");
    assert.equal(error.nativeReason, "parent_identity_mismatch");
    assert.equal(await exists(join(parentRoot, directoryName)), true);
    if (process.platform === "darwin") {
      assert.equal((await lstat(join(parentRoot, directoryName))).mode & 0o7777, 0o755);
    }
  });
});

test("private staging security rejects a symlink or junction without touching its target", async (t) => {
  const parentRoot = await testRoot(t);
  const externalRoot = join(parentRoot, "external-stage");
  const linkedName = "linked-stage";
  await mkdir(externalRoot, { mode: 0o755 });
  await writeFile(join(externalRoot, "valuable.txt"), "external-value");
  const before = await lstat(externalRoot);
  await symlink(
    externalRoot,
    join(parentRoot, linkedName),
    process.platform === "win32" ? "junction" : "dir",
  );

  const error = await captureRejection(() => securePrivateStagingDirectory({
    parentRoot,
    directoryName: linkedName,
  }));
  assert.ok(error instanceof CuaDriverAtomicPublishError);
  assert.equal(error.code, "staging_publish_reparse_forbidden");
  assert.equal(error.nativeReason, "directory_reparse_forbidden");
  assert.equal(await readFile(join(externalRoot, "valuable.txt"), "utf8"), "external-value");
  if (process.platform === "darwin") {
    const after = await lstat(externalRoot);
    assert.equal(after.uid, before.uid);
    assert.equal(after.mode & 0o7777, before.mode & 0o7777);
  }
});

test("unsecured empty cleanup removes only the exact current-user-owned empty directory", async (t) => {
  const parentRoot = await testRoot(t);
  const sourceName = "unsecured-empty";
  const sourcePath = join(parentRoot, sourceName);
  await mkdir(sourcePath, { mode: 0o755 });
  // Windows administrator tokens may assign a newly created directory to the
  // Administrators group. Apply the production security operation first so
  // this test's current-user-owner premise is true on every supported host.
  await securePrivateStagingDirectory({
    parentRoot,
    directoryName: sourceName,
  });
  const expected = await nativeIdentities(parentRoot, sourceName);

  const receipt = await removeAtomicPublishUnsecuredEmptyDirectory({
    parentRoot,
    sourceName,
    ...expected,
  });

  assert.deepEqual(receipt, {
    schemaVersion: 1,
    outcome: "removed",
    platform: process.platform,
    parentIdentity: expected.expectedParentIdentity,
    sourceIdentity: expected.expectedSourceIdentity,
    removedEntries: 0,
    removedBytes: 0,
  });
  assert.equal(await exists(sourcePath), false);
});

test("unsecured empty cleanup refuses non-empty, replaced, reparse and wrong-parent roots", async (t) => {
  await t.test("non-empty directory", async (t) => {
    const parentRoot = await testRoot(t);
    const sourceName = "unsecured-empty";
    const sourcePath = join(parentRoot, sourceName);
    await mkdir(sourcePath, { mode: 0o755 });
    await securePrivateStagingDirectory({
      parentRoot,
      directoryName: sourceName,
    });
    await writeFile(join(sourcePath, "valuable.txt"), "valuable");
    const expected = await nativeIdentities(parentRoot, sourceName);

    const error = await captureRejection(() => (
      removeAtomicPublishUnsecuredEmptyDirectory({
        parentRoot,
        sourceName,
        ...expected,
      })
    ));

    assert.ok(error instanceof CuaDriverAtomicPublishError);
    assert.equal(error.outcome, "not_committed");
    assert.equal(error.nativeReason, "directory_not_empty");
    assert.equal(await readFile(join(sourcePath, "valuable.txt"), "utf8"), "valuable");
  });

  await t.test("replaced directory", async (t) => {
    const parentRoot = await testRoot(t);
    const sourceName = "unsecured-empty";
    const sourcePath = join(parentRoot, sourceName);
    const displacedPath = join(parentRoot, "displaced-empty");
    await mkdir(sourcePath, { mode: 0o755 });
    const expected = await nativeIdentities(parentRoot, sourceName);
    await rename(sourcePath, displacedPath);
    await mkdir(sourcePath, { mode: 0o755 });

    const error = await captureRejection(() => (
      removeAtomicPublishUnsecuredEmptyDirectory({
        parentRoot,
        sourceName,
        ...expected,
      })
    ));

    assert.ok(error instanceof CuaDriverAtomicPublishError);
    assert.equal(error.nativeReason, "source_identity_mismatch");
    assert.equal(await exists(sourcePath), true);
    assert.equal(await exists(displacedPath), true);
  });

  await t.test("reparse directory", async (t) => {
    const parentRoot = await testRoot(t);
    const sourceName = "unsecured-empty";
    const sourcePath = join(parentRoot, sourceName);
    const displacedPath = join(parentRoot, "displaced-empty");
    const externalPath = join(parentRoot, "external-empty");
    await mkdir(sourcePath, { mode: 0o755 });
    await mkdir(externalPath, { mode: 0o755 });
    await writeFile(join(externalPath, "valuable.txt"), "external-value");
    const expected = await nativeIdentities(parentRoot, sourceName);
    await rename(sourcePath, displacedPath);
    await symlink(
      externalPath,
      sourcePath,
      process.platform === "win32" ? "junction" : "dir",
    );

    const error = await captureRejection(() => (
      removeAtomicPublishUnsecuredEmptyDirectory({
        parentRoot,
        sourceName,
        ...expected,
      })
    ));

    assert.ok(error instanceof CuaDriverAtomicPublishError);
    assert.equal(error.nativeReason, "source_reparse_forbidden");
    assert.equal(await readFile(join(externalPath, "valuable.txt"), "utf8"), "external-value");
    assert.equal(await exists(displacedPath), true);
  });

  await t.test("replaced parent", async (t) => {
    const holder = await testRoot(t);
    const parentRoot = join(holder, "parent");
    const displacedParent = join(holder, "displaced-parent");
    const sourceName = "unsecured-empty";
    await mkdir(parentRoot);
    await mkdir(join(parentRoot, sourceName), { mode: 0o755 });
    const expected = await nativeIdentities(parentRoot, sourceName);
    await rename(parentRoot, displacedParent);
    await mkdir(parentRoot);
    await rename(
      join(displacedParent, sourceName),
      join(parentRoot, sourceName),
    );

    const error = await captureRejection(() => (
      removeAtomicPublishUnsecuredEmptyDirectory({
        parentRoot,
        sourceName,
        ...expected,
      })
    ));

    assert.ok(error instanceof CuaDriverAtomicPublishError);
    assert.equal(error.nativeReason, "parent_identity_mismatch");
    assert.equal(await exists(join(parentRoot, sourceName)), true);
  });
});

test("identity-bound native removal deletes only the preflighted bounded tree", async (t) => {
  const parentRoot = await testRoot(t);
  const sourceName = "remove-tree";
  const sourcePath = join(parentRoot, sourceName);
  await mkdir(join(sourcePath, "nested"), { recursive: true });
  await writeFile(join(sourcePath, "root.txt"), "root");
  await writeFile(join(sourcePath, "nested/child.txt"), "child");
  const secured = await securePrivateStagingDirectory({
    parentRoot,
    directoryName: sourceName,
  });

  const receipt = await removeAtomicPublishDirectoryTree({
    parentRoot,
    sourceName,
    expectedParentIdentity: secured.parentIdentity,
    expectedSourceIdentity: secured.directoryIdentity,
    expectedEntries: 3,
    expectedTotalBytes: Buffer.byteLength("rootchild"),
  });

  assert.deepEqual(receipt, {
    schemaVersion: 1,
    outcome: "removed",
    platform: process.platform,
    parentIdentity: secured.parentIdentity,
    sourceIdentity: secured.directoryIdentity,
    removedEntries: 3,
    removedBytes: Buffer.byteLength("rootchild"),
  });
  assert.equal(await exists(sourcePath), false);
});

test("identity-bound native removal rejects a replaced root without touching either tree", async (t) => {
  const parentRoot = await testRoot(t);
  const sourceName = "remove-tree";
  const sourcePath = join(parentRoot, sourceName);
  const displacedPath = join(parentRoot, "displaced-tree");
  await createSource(sourcePath, "verified-tree");
  const secured = await securePrivateStagingDirectory({
    parentRoot,
    directoryName: sourceName,
  });
  await rename(sourcePath, displacedPath);
  await createSource(sourcePath, "foreign-tree");
  await securePrivateStagingDirectory({
    parentRoot,
    directoryName: sourceName,
  });

  const error = await captureRejection(() => removeAtomicPublishDirectoryTree({
    parentRoot,
    sourceName,
    expectedParentIdentity: secured.parentIdentity,
    expectedSourceIdentity: secured.directoryIdentity,
    expectedEntries: 1,
    expectedTotalBytes: Buffer.byteLength("verified-tree"),
  }));

  assert.ok(error instanceof CuaDriverAtomicPublishError);
  assert.equal(error.outcome, "not_committed");
  assert.equal(error.nativeReason, "source_identity_mismatch");
  assert.equal(await readFile(join(sourcePath, "sentinel.txt"), "utf8"), "foreign-tree");
  assert.equal(
    await readFile(join(displacedPath, "sentinel.txt"), "utf8"),
    "verified-tree",
  );
});

test("identity-bound native removal rejects reparse and hard-linked members", async (t) => {
  await t.test("reparse member", async (t) => {
    const parentRoot = await testRoot(t);
    const sourceName = "remove-tree";
    const sourcePath = join(parentRoot, sourceName);
    const externalPath = join(parentRoot, "external");
    await mkdir(sourcePath);
    await mkdir(externalPath);
    await writeFile(join(externalPath, "valuable.txt"), "valuable");
    await symlink(
      externalPath,
      join(sourcePath, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const secured = await securePrivateStagingDirectory({
      parentRoot,
      directoryName: sourceName,
    });
    const error = await captureRejection(() => removeAtomicPublishDirectoryTree({
      parentRoot,
      sourceName,
      expectedParentIdentity: secured.parentIdentity,
      expectedSourceIdentity: secured.directoryIdentity,
      expectedEntries: 1,
      expectedTotalBytes: 0,
    }));
    assert.ok(error instanceof CuaDriverAtomicPublishError);
    assert.equal(error.outcome, "not_committed");
    assert.equal(error.nativeReason, "tree_reparse_forbidden");
    assert.equal(await readFile(join(externalPath, "valuable.txt"), "utf8"), "valuable");
    assert.equal(await exists(sourcePath), true);
  });

  await t.test("hard-linked member", async (t) => {
    const parentRoot = await testRoot(t);
    const sourceName = "remove-tree";
    const sourcePath = join(parentRoot, sourceName);
    const externalFile = join(parentRoot, "external.txt");
    await mkdir(sourcePath);
    await writeFile(externalFile, "valuable");
    await link(externalFile, join(sourcePath, "linked.txt"));
    const secured = await securePrivateStagingDirectory({
      parentRoot,
      directoryName: sourceName,
    });
    const error = await captureRejection(() => removeAtomicPublishDirectoryTree({
      parentRoot,
      sourceName,
      expectedParentIdentity: secured.parentIdentity,
      expectedSourceIdentity: secured.directoryIdentity,
      expectedEntries: 1,
      expectedTotalBytes: Buffer.byteLength("valuable"),
    }));
    assert.ok(error instanceof CuaDriverAtomicPublishError);
    assert.equal(error.outcome, "not_committed");
    assert.equal(error.nativeReason, "tree_hardlink_forbidden");
    assert.equal(await readFile(externalFile, "utf8"), "valuable");
    assert.equal(await exists(sourcePath), true);
  });
});

test("Windows run-owned preserves argv and kills descendants when its helper times out", {
  skip: process.platform !== "win32",
}, async () => {
  const argvResult = await runOwnedWindowsProcess(
    process.execPath,
    [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      "space value",
      "quote\"value",
      "trailing\\",
      "",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 5_000 },
  );
  assert.deepEqual(JSON.parse(argvResult.stdout), [
    "space value",
    "quote\"value",
    "trailing\\",
    "",
  ]);

  const childCode = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
    "  { stdio: 'ignore', windowsHide: true });",
    "console.log(child.pid);",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const timeoutError = await captureRejection(() => runOwnedWindowsProcess(
    process.execPath,
    ["-e", childCode],
    { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 300 },
  ));
  const descendantPid = Number(String(timeoutError.stdout).trim());
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  assert.equal(processExists(descendantPid), false);
});

test("Windows interactive owned spawn forwards stdin and drains descendants before close", {
  skip: process.platform !== "win32",
}, async () => {
  const source = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
    "  { stdio: 'ignore', windowsHide: true });",
    "console.log(child.pid);",
    "process.stdin.once('data', () => process.exit(0));",
  ].join("\n");
  const owned = await spawnOwnedWindowsProcess(
    process.execPath,
    ["-e", source],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const [chunk] = await once(owned.stdout, "data");
  const descendantPid = Number(String(chunk).trim());
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  owned.stdin.end("release\n");
  const [exitCode, exitSignal] = await once(owned, "close");
  assert.equal(exitCode, 0);
  assert.equal(exitSignal, null);
  assert.equal(processExists(descendantPid), false);
});

test("publishes a missing destination without changing the source directory identity", async (t) => {
  const root = await testRoot(t);
  const sourceName = "source";
  const destinationName = "destination";
  const sourcePath = join(root, sourceName);
  const destinationPath = join(root, destinationName);
  await createSource(sourcePath, "source-value");
  const sourceIdentity = await fileIdentity(sourcePath);
  const expectedIdentities = await nativeIdentities(root, sourceName);

  const result = await atomicPublishDirectoryNoReplace({
    parentRoot: root,
    sourceName,
    destinationName,
    ...expectedIdentities,
  });

  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(result, {
    schemaVersion: 1,
    outcome: "committed",
    platform: process.platform,
  });
  assert.equal(await exists(sourcePath), false);
  assertSameIdentity(await fileIdentity(destinationPath), sourceIdentity);
  assert.equal(await readFile(join(destinationPath, "sentinel.txt"), "utf8"), "source-value");
});

test("never replaces an existing file, directory, or link-like destination", async (t) => {
  const cases = [
    {
      name: "file",
      create: async (root, destinationPath) => {
        await writeFile(destinationPath, "valuable-file");
        return async () => {
          assert.equal(await readFile(destinationPath, "utf8"), "valuable-file");
        };
      },
    },
    {
      name: "empty directory",
      create: async (_root, destinationPath) => {
        await mkdir(destinationPath);
        return async () => {
          assert.deepEqual(await readDirectoryNames(destinationPath), []);
        };
      },
    },
    {
      name: "non-empty directory",
      create: async (_root, destinationPath) => {
        await mkdir(destinationPath);
        await writeFile(join(destinationPath, "valuable.txt"), "valuable-directory");
        return async () => {
          assert.equal(
            await readFile(join(destinationPath, "valuable.txt"), "utf8"),
            "valuable-directory",
          );
        };
      },
    },
    {
      name: process.platform === "win32" ? "junction" : "symlink",
      create: async (root, destinationPath) => {
        const targetPath = join(root, "link-target");
        await mkdir(targetPath);
        await writeFile(join(targetPath, "valuable.txt"), "valuable-link-target");
        await symlink(
          targetPath,
          destinationPath,
          process.platform === "win32" ? "junction" : "dir",
        );
        const expectedTarget = await realpath(destinationPath);
        return async () => {
          assert.equal((await lstat(destinationPath)).isSymbolicLink(), true);
          assert.equal(await realpath(destinationPath), expectedTarget);
          assert.equal(
            await readFile(join(targetPath, "valuable.txt"), "utf8"),
            "valuable-link-target",
          );
        };
      },
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async (t) => {
      const root = await testRoot(t);
      const sourceName = "source";
      const destinationName = "destination";
      const sourcePath = join(root, sourceName);
      const destinationPath = join(root, destinationName);
      await createSource(sourcePath, `source-${fixture.name}`);
      const sourceIdentity = await fileIdentity(sourcePath);
      const expectedIdentities = await nativeIdentities(root, sourceName);
      const assertDestinationUnchanged = await fixture.create(root, destinationPath);
      const destinationIdentity = await fileIdentity(destinationPath);

      const error = await captureRejection(() => atomicPublishDirectoryNoReplace({
        parentRoot: root,
        sourceName,
        destinationName,
        ...expectedIdentities,
      }));

      assert.ok(error instanceof CuaDriverAtomicPublishError);
      assert.equal(error.code, "output_root_exists");
      assert.equal(error.outcome, "not_committed");
      assert.equal(error.nativeReason, "destination_exists");
      assertSameIdentity(await fileIdentity(sourcePath), sourceIdentity);
      assertSameIdentity(await fileIdentity(destinationPath), destinationIdentity);
      assert.equal(
        await readFile(join(sourcePath, "sentinel.txt"), "utf8"),
        `source-${fixture.name}`,
      );
      await assertDestinationUnchanged();
    });
  }
});

test("two concurrent publishers produce exactly one committed destination", async (t) => {
  const root = await testRoot(t);
  const destinationName = "destination";
  const sourceNames = ["source-a", "source-b"];
  await Promise.all(sourceNames.map((sourceName) => createSource(
    join(root, sourceName),
    sourceName,
  )));
  const sourceIdentities = new Map(await Promise.all(sourceNames.map(async (sourceName) => [
    sourceName,
    await fileIdentity(join(root, sourceName)),
  ])));
  const nativeIdentityBySource = new Map(await Promise.all(sourceNames.map(async (sourceName) => [
    sourceName,
    await nativeIdentities(root, sourceName),
  ])));

  const outcomes = await Promise.allSettled(sourceNames.map((sourceName) => (
    atomicPublishDirectoryNoReplace({
      parentRoot: root,
      sourceName,
      destinationName,
      ...nativeIdentityBySource.get(sourceName),
    })
  )));

  const committed = outcomes
    .map((outcome, index) => ({ outcome, sourceName: sourceNames[index] }))
    .filter(({ outcome }) => outcome.status === "fulfilled");
  const rejected = outcomes
    .map((outcome, index) => ({ outcome, sourceName: sourceNames[index] }))
    .filter(({ outcome }) => outcome.status === "rejected");
  assert.equal(committed.length, 1);
  assert.equal(rejected.length, 1);
  assert.deepEqual(committed[0].outcome.value, {
    schemaVersion: 1,
    outcome: "committed",
    platform: process.platform,
  });
  assert.ok(rejected[0].outcome.reason instanceof CuaDriverAtomicPublishError);
  assert.equal(rejected[0].outcome.reason.code, "output_root_exists");
  assert.equal(rejected[0].outcome.reason.outcome, "not_committed");
  assert.equal(rejected[0].outcome.reason.nativeReason, "destination_exists");

  const destinationPath = join(root, destinationName);
  const winningSource = committed[0].sourceName;
  const losingSource = rejected[0].sourceName;
  assert.equal(await readFile(join(destinationPath, "sentinel.txt"), "utf8"), winningSource);
  assertSameIdentity(
    await fileIdentity(destinationPath),
    sourceIdentities.get(winningSource),
  );
  assert.equal(await exists(join(root, winningSource)), false);
  assertSameIdentity(
    await fileIdentity(join(root, losingSource)),
    sourceIdentities.get(losingSource),
  );
  assert.equal(
    await readFile(join(root, losingSource, "sentinel.txt"), "utf8"),
    losingSource,
  );
});

test("refuses to publish a source name that no longer matches the inspected identity", async (t) => {
  const root = await testRoot(t);
  const sourceName = "source";
  const sourcePath = join(root, sourceName);
  const displacedPath = join(root, "displaced-source");
  const destinationPath = join(root, "destination");
  await createSource(sourcePath, "verified-source");
  const expectedIdentities = await nativeIdentities(root, sourceName);
  await rename(sourcePath, displacedPath);
  await createSource(sourcePath, "foreign-source");
  const foreignIdentity = await fileIdentity(sourcePath);

  const error = await captureRejection(() => atomicPublishDirectoryNoReplace({
    parentRoot: root,
    sourceName,
    destinationName: "destination",
    ...expectedIdentities,
  }));

  assert.ok(error instanceof CuaDriverAtomicPublishError);
  assert.equal(error.code, "staging_publish_not_committed");
  assert.equal(error.outcome, "not_committed");
  assert.equal(error.nativeReason, "source_identity_mismatch");
  assertSameIdentity(await fileIdentity(sourcePath), foreignIdentity);
  assert.equal(await readFile(join(sourcePath, "sentinel.txt"), "utf8"), "foreign-source");
  assert.equal(await readFile(join(displacedPath, "sentinel.txt"), "utf8"), "verified-source");
  assert.equal(await exists(destinationPath), false);
});

test("binds publication to the originally inspected parent directory identity", async (t) => {
  const holder = await testRoot(t);
  const parentRoot = join(holder, "parent");
  const displacedParent = join(holder, "displaced-parent");
  const sourceName = "source";
  await mkdir(parentRoot);
  await createSource(join(parentRoot, sourceName), "verified-source");
  const expectedIdentities = await nativeIdentities(parentRoot, sourceName);
  const sourceIdentity = await fileIdentity(join(parentRoot, sourceName));

  await rename(parentRoot, displacedParent);
  await mkdir(parentRoot);
  await rename(
    join(displacedParent, sourceName),
    join(parentRoot, sourceName),
  );

  const error = await captureRejection(() => atomicPublishDirectoryNoReplace({
    parentRoot,
    sourceName,
    destinationName: "destination",
    ...expectedIdentities,
  }));

  assert.ok(error instanceof CuaDriverAtomicPublishError);
  assert.equal(error.code, "staging_publish_not_committed");
  assert.equal(error.nativeReason, "parent_identity_mismatch");
  assertSameIdentity(await fileIdentity(join(parentRoot, sourceName)), sourceIdentity);
  assert.equal(
    await readFile(join(parentRoot, sourceName, "sentinel.txt"), "utf8"),
    "verified-source",
  );
  assert.equal(await exists(join(parentRoot, "destination")), false);
  assert.deepEqual(await readDirectoryNames(displacedParent), []);
});

test("rejects parent and source links without touching their external targets", async (t) => {
  const holder = await testRoot(t);
  const externalParent = join(holder, "external-parent");
  const linkedParent = join(holder, "linked-parent");
  await mkdir(externalParent);
  await createSource(join(externalParent, "source"), "external-parent-source");
  await symlink(
    externalParent,
    linkedParent,
    process.platform === "win32" ? "junction" : "dir",
  );

  const parentError = await captureRejection(() => (
    readAtomicPublishDirectoryIdentities({
      parentRoot: linkedParent,
      sourceName: "source",
    })
  ));
  assert.ok(parentError instanceof CuaDriverAtomicPublishError);
  assert.equal(parentError.code, "staging_publish_reparse_forbidden");
  assert.equal(
    await readFile(join(externalParent, "source", "sentinel.txt"), "utf8"),
    "external-parent-source",
  );

  const parentRoot = join(holder, "real-parent");
  const externalSource = join(holder, "external-source");
  await mkdir(parentRoot);
  await createSource(externalSource, "external-source-value");
  await symlink(
    externalSource,
    join(parentRoot, "source"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const sourceError = await captureRejection(() => (
    readAtomicPublishDirectoryIdentities({ parentRoot, sourceName: "source" })
  ));
  assert.ok(sourceError instanceof CuaDriverAtomicPublishError);
  assert.equal(sourceError.code, "staging_publish_reparse_forbidden");
  assert.equal(
    await readFile(join(externalSource, "sentinel.txt"), "utf8"),
    "external-source-value",
  );
  assert.equal(await exists(join(parentRoot, "destination")), false);
});

test("rejects a missing or non-directory source", async (t) => {
  const parentRoot = await testRoot(t);
  const missingError = await captureRejection(() => (
    readAtomicPublishDirectoryIdentities({ parentRoot, sourceName: "missing" })
  ));
  assert.ok(missingError instanceof CuaDriverAtomicPublishError);
  assert.equal(missingError.code, "staging_publish_not_committed");
  assert.equal(missingError.nativeReason, "source_missing");

  await writeFile(join(parentRoot, "source"), "valuable-file");
  const fileIdentityBefore = await fileIdentity(join(parentRoot, "source"));
  const fileError = await captureRejection(() => (
    readAtomicPublishDirectoryIdentities({ parentRoot, sourceName: "source" })
  ));
  assert.ok(fileError instanceof CuaDriverAtomicPublishError);
  assert.equal(fileError.code, "staging_publish_not_committed");
  assert.equal(fileError.nativeReason, "source_invalid");
  assertSameIdentity(await fileIdentity(join(parentRoot, "source")), fileIdentityBefore);
  assert.equal(await readFile(join(parentRoot, "source"), "utf8"), "valuable-file");
});

test("rejects non-basename source and destination names without moving anything", async (t) => {
  const absoluteName = resolve(tmpdir(), "ling-cua-package-publisher-invalid-name");
  for (const [name, input] of [
    ["empty source", { sourceName: "", destinationName: "destination" }],
    ["dot source", { sourceName: ".", destinationName: "destination" }],
    ["parent source", { sourceName: "../outside-source", destinationName: "destination" }],
    ["nested source", { sourceName: "nested/source", destinationName: "destination" }],
    ["backslash source", { sourceName: "nested\\source", destinationName: "destination" }],
    ["absolute source", { sourceName: absoluteName, destinationName: "destination" }],
    ["empty destination", { sourceName: "source", destinationName: "" }],
    ["dot destination", { sourceName: "source", destinationName: "." }],
    ["parent destination", { sourceName: "source", destinationName: "../destination" }],
    ["nested destination", { sourceName: "source", destinationName: "nested/destination" }],
    ["backslash destination", { sourceName: "source", destinationName: "nested\\destination" }],
    ["absolute destination", { sourceName: "source", destinationName: absoluteName }],
    ["same source and destination", { sourceName: "source", destinationName: "source" }],
    ...(process.platform === "win32"
      ? [[
          "case-only source and destination",
          { sourceName: "source", destinationName: "SOURCE" },
        ]]
      : []),
  ]) {
    await t.test(name, async (t) => {
      const caseRoot = await testRoot(t);
      await createSource(join(caseRoot, "source"), "inside-source");
      const sourceIdentity = await fileIdentity(join(caseRoot, "source"));

      const error = await captureRejection(() => atomicPublishDirectoryNoReplace({
        parentRoot: caseRoot,
        ...input,
      }));

      assert.ok(error instanceof CuaDriverAtomicPublishError);
      assert.equal(error.code, "staging_publish_name_invalid");
      assertSameIdentity(await fileIdentity(join(caseRoot, "source")), sourceIdentity);
      assert.equal(
        await readFile(join(caseRoot, "source", "sentinel.txt"), "utf8"),
        "inside-source",
      );
      assert.equal(await exists(join(caseRoot, "destination")), false);
    });
  }
});

async function buildNativePublisher(
  outputPath,
  { testGate = false, watchdogMs } = {},
) {
  if (watchdogMs !== undefined) {
    assert.equal(testGate, true, "watchdog override requires the test-only native build");
    assert.ok(Number.isSafeInteger(watchdogMs));
    assert.ok(watchdogMs > 0);
  }
  const watchdogDefinition = watchdogMs === undefined
    ? []
    : [`LING_CUA_DRIVER_PACKAGE_STAGING_TEST_WATCHDOG_MS=${watchdogMs}`];
  if (process.platform === "darwin") {
    await execFile("/usr/bin/clang++", [
      "-std=c++17",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      ...(testGate ? ["-DLING_CUA_DRIVER_PACKAGE_STAGING_TESTS=1"] : []),
      ...watchdogDefinition.map((definition) => `-D${definition}`),
      NATIVE_SOURCE,
      "-o",
      outputPath,
    ]);
    return;
  }
  if (process.platform === "win32") {
    await execFile("cl.exe", [
      "/nologo",
      "/std:c++17",
      "/O2",
      "/EHsc",
      "/W4",
      "/WX",
      ...(testGate ? ["/DLING_CUA_DRIVER_PACKAGE_STAGING_TESTS=1"] : []),
      ...watchdogDefinition.map((definition) => `/D${definition}`),
      `/Fe:${outputPath}`,
      NATIVE_SOURCE,
      "Advapi32.lib",
    ], { cwd: dirname(outputPath) });
    return;
  }
  assert.fail(`native publisher test compilation is unsupported on ${process.platform}`);
}

async function startNativeParentLockHolder(
  t,
  nativePublisher,
  parentRoot,
  timeoutMs = 1_000,
) {
  const child = spawn(
    nativePublisher,
    ["hold-parent-lock", parentRoot, String(timeoutMs)],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lineIterator = lines[Symbol.asyncIterator]();
  const holder = { child, lineIterator, lines };
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      forceKillChildForTest(child);
      await waitForChildExit(child);
    }
  });
  holder.locked = await nextNativeReceipt(holder);
  assert.equal(holder.locked.outcome, "locked");
  return holder;
}

async function startWindowsWaitingParentLockHolder(
  t,
  nativePublisher,
  parentRoot,
  readyName,
) {
  const child = spawn(
    nativePublisher,
    ["hold-parent-lock-test-wait-ready", parentRoot, "10000", readyName],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const lineIterator = lines[Symbol.asyncIterator]();
  const holder = { child, lineIterator, lines };
  t.after(async () => {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      forceKillChildForTest(child);
      await waitForChildExit(child);
    }
  });
  return holder;
}

async function finishNativeParentLockHolder(holder, command = "LCRPC1\trelease\t1\n") {
  holder.child.stdin.end(command);
  const receipt = await nextNativeReceipt(holder);
  if (receipt.outcome === "released") {
    assert.equal(receipt.operationOwnerPid, holder.child.pid);
  }
  const exitCode = await waitForChildExit(holder.child);
  holder.lines.close();
  return Object.freeze({ exitCode, receipt });
}

async function finishNativeProtocolHolder(holder, frame) {
  let stdinError;
  const onStdinError = (error) => {
    stdinError = error;
  };
  holder.child.stdin.on("error", onStdinError);
  holder.child.stdin.end(frame);
  const receipts = [];
  for await (const line of holder.lineIterator) {
    receipts.push(JSON.parse(line));
  }
  const exitCode = await waitForChildExit(holder.child);
  holder.child.stdin.off("error", onStdinError);
  holder.lines.close();
  if (stdinError !== undefined
    && stdinError.code !== "EPIPE"
    && stdinError.code !== "ECONNRESET") {
    throw stdinError;
  }
  assert.ok(receipts.length > 0, "native holder must emit a protocol receipt");
  return Object.freeze({ exitCode, receipts: Object.freeze(receipts) });
}

function lcrpcCall(requestId, operation, args) {
  return `LCRPC1\tcall\t${requestId}\t${operation}\t${args.length}\t${args
    .map((value) => Buffer.from(value, "utf8").toString("hex"))
    .join("\t")}\n`;
}

function fakeLcrpcHolderArgs(mode) {
  const source = `
    const mode = ${JSON.stringify(mode)};
    const platform = process.platform === "darwin" ? "darwin" : "win32";
    const locked = {
      schemaVersion: 1,
      outcome: mode === "lockedOutcome" ? "not_committed" : "locked",
      platform,
      reason: mode === "lockedOutcome" ? "parent_lock_timeout" : "locked",
      nativeCode: mode === "lockedOutcome" ? 1 : 0,
      parentIdentity: "1:1",
      lockScope: "parent",
      recoveredAbandonedLock: false,
    };
    process.stdout.write(JSON.stringify(locked) + "\\n");
    process.stdin.once("data", (chunk) => {
      if (mode === "timeout") {
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "invalidJson") {
        process.stdout.write("{invalid-json\\n");
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "invalidShape") {
        process.stdout.write(JSON.stringify({ schemaVersion: 1 }) + "\\n");
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "invalidArray") {
        process.stdout.write("[]\\n");
        setInterval(() => {}, 1_000);
        return;
      }
      if (mode === "invalidNull") {
        process.stdout.write("null\\n");
        setInterval(() => {}, 1_000);
        return;
      }
      const fields = chunk.toString("utf8").trim().split("\\t");
      const requestId = Number(fields[2]);
      const operation = fields[3];
      const receipt = {
        schemaVersion: 1,
        outcome: "committed",
        platform,
        reason: "committed",
        nativeCode: 0,
        requestId: mode === "requestId" ? requestId + 1 : requestId,
        operation: mode === "operation" ? "inspect" : operation,
        operationOwnerPid: mode === "operationOwnerPid" ? process.pid + 1 : process.pid,
      };
      process.stdout.write(JSON.stringify(receipt) + "\\n");
      if (mode === "releaseOutcome") {
        process.stdin.once("data", (releaseChunk) => {
          const releaseFields = releaseChunk.toString("utf8").trim().split("\\t");
          process.stdout.write(JSON.stringify({
            schemaVersion: 1,
            outcome: "not_committed",
            platform,
            reason: "parent_lock_timeout",
            nativeCode: 1,
            parentIdentity: "1:1",
            lockScope: "parent",
            recoveredAbandonedLock: false,
            requestId: Number(releaseFields[2]),
            operation: "release",
            operationOwnerPid: process.pid,
          }) + "\\n");
          setTimeout(() => process.exit(0), 10);
        });
        return;
      }
      setInterval(() => {}, 1_000);
    });
  `;
  return ["--input-type=module", "--eval", source];
}

function nodeOwnedHeldPublishSource() {
  return `
    import { spawn } from "node:child_process";
    import { existsSync } from "node:fs";
    import { join } from "node:path";
    import { createInterface } from "node:readline";
    import { setTimeout as delay } from "node:timers/promises";

    const holder = spawn(
      process.env.LING_TEST_NATIVE_PUBLISHER,
      ["hold-parent-lock", process.env.LING_TEST_PARENT_ROOT, "10000"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const lines = createInterface({ input: holder.stdout, crlfDelay: Infinity });
    const first = await lines[Symbol.asyncIterator]().next();
    if (first.done) {
      throw new Error("native holder exited before its locked receipt");
    }
    const locked = JSON.parse(first.value);
    const args = [
      process.env.LING_TEST_SOURCE_NAME,
      process.env.LING_TEST_DESTINATION_NAME,
      process.env.LING_TEST_EXPECTED_PARENT_IDENTITY,
      process.env.LING_TEST_EXPECTED_SOURCE_IDENTITY,
      process.env.LING_TEST_READY_NAME,
      process.env.LING_TEST_GATE_NAME,
      process.env.LING_TEST_COMPLETION_NAME,
    ];
    const frame = "LCRPC1\\tcall\\t1\\ttest-hold-publish\\t7\\t"
      + args.map((value) => Buffer.from(value, "utf8").toString("hex")).join("\\t")
      + "\\n";
    holder.stdin.write(frame);
    const readyPath = join(
      process.env.LING_TEST_PARENT_ROOT,
      process.env.LING_TEST_READY_NAME,
    );
    const deadline = Date.now() + 5000;
    while (!existsSync(readyPath)) {
      if (Date.now() >= deadline) {
        throw new Error("native RPC did not reach its hold gate");
      }
      await delay(10);
    }
    process.stdout.write(JSON.stringify({ holderPid: holder.pid, locked }) + "\\n");
    await new Promise(() => {});
  `;
}

async function nextJsonChildLine(child, lineIterator, message) {
  const result = await lineIterator.next();
  if (result.done) {
    const stderr = child.stderr.read()?.toString("utf8") ?? "";
    assert.fail(`${message}: ${stderr}`);
  }
  return JSON.parse(result.value);
}

async function nextNativeReceipt(holder) {
  const result = await holder.lineIterator.next();
  if (result.done) {
    const stderr = holder.child.stderr.read()?.toString("utf8") ?? "";
    assert.fail(`native parent lock helper exited without a receipt: ${stderr}`);
  }
  return JSON.parse(result.value);
}

async function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return child.exitCode;
  }
  const [exitCode] = await once(child, "exit");
  return exitCode;
}

function forceKillChildForTest(child) {
  const signal = process.platform === "win32" ? "SIGTERM" : "SIGKILL";
  assert.equal(child.kill(signal), true, `failed to kill child ${child.pid}`);
}

function forceKillPidForTest(pid) {
  try {
    process.kill(pid, process.platform === "win32" ? "SIGTERM" : "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for process ${pid} to exit`);
}

function assertParentLockReceipt(receipt, outcome, recoveredAbandonedLock) {
  const expected = {
    schemaVersion: 1,
    outcome,
    platform: "darwin",
    reason: outcome,
    nativeCode: 0,
    parentIdentity: receipt.parentIdentity,
    lockScope: "parent",
    recoveredAbandonedLock,
  };
  if (outcome === "released") {
    expected.requestId = 1;
    expected.operation = "release";
    expected.operationOwnerPid = receipt.operationOwnerPid;
    assert.ok(Number.isSafeInteger(receipt.operationOwnerPid));
    assert.ok(receipt.operationOwnerPid > 0);
  }
  assert.deepEqual(receipt, expected);
  assert.match(receipt.parentIdentity, /^[0-9a-f]+:[0-9a-f]+$/u);
}

async function createSource(path, value) {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "sentinel.txt"), value);
}

async function nativeIdentities(parentRoot, sourceName) {
  const result = await readAtomicPublishDirectoryIdentities({ parentRoot, sourceName });
  assert.equal(Object.isFrozen(result), true);
  return Object.freeze({
    expectedParentIdentity: result.parentIdentity,
    expectedSourceIdentity: result.sourceIdentity,
  });
}

async function captureRejection(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail("expected atomic publisher to reject");
}

async function nativeCommandOutcome(executable, args) {
  try {
    const result = await execFile(executable, args, {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });
    return Object.freeze({
      code: 0,
      stderr: result.stderr,
      stdout: result.stdout,
    });
  } catch (error) {
    return Object.freeze({
      code: error.code,
      stderr: error.stderr,
      stdout: error.stdout,
    });
  }
}

async function fileIdentity(path) {
  const metadata = await lstat(path, { bigint: true });
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

function assertSameIdentity(actual, expected) {
  assert.equal(actual.dev, expected.dev);
  assert.equal(actual.ino, expected.ino);
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

function nativePublisherTestPath(root, name = "native-publisher") {
  return join(root, process.platform === "win32" ? `${name}.exe` : name);
}

async function waitForPath(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${path}`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function readDirectoryNames(path) {
  return (await readdir(path)).sort();
}

async function testRoot(t) {
  const root = await mkdtemp(join(
    await realpath(tmpdir()),
    "ling-cua-package-publisher-",
  ));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
