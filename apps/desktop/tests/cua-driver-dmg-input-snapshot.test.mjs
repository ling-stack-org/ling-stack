import assert from "node:assert/strict";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createDmgInputSnapshot } from "../scripts/cua-driver-signing/dmg-input-snapshot.mjs";

test("private snapshot uses exclusive 0600 copy and retained readonly original FD with repeated explicit-position reads", async t => {
  const f = await fixture(t);
  const before = await lstat(f.original, { bigint: true });
  const snapshot = await f.create();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual(Object.keys(snapshot).sort(), ["cleanup", "path", "releaseHandles", "verifyOriginal", "verifySnapshot"]);
  assert.notEqual(snapshot.path, f.original);
  assert.deepEqual(await readFile(snapshot.path), f.bytes);
  assert.equal((await lstat(snapshot.path)).mode & 0o777, 0o600);
  assert.equal(f.opens[0].flags & (constants.O_WRONLY | constants.O_RDWR), constants.O_RDONLY);
  assert.ok((f.opens[0].flags & constants.O_NOFOLLOW) !== 0);
  assert.ok((f.opens[1].flags & constants.O_EXCL) !== 0);
  assert.ok((f.opens[1].flags & constants.O_NOFOLLOW) !== 0);
  for (let count = 0; count < 3; count += 1) {
    await snapshot.verifyOriginal(); await snapshot.verifySnapshot();
  }
  assert.equal(f.opens.length, 2);
  assert.equal(f.closes.length, 0);
  assert.deepEqual(metadata(await lstat(f.original, { bigint: true })), metadata(before));
  const result = await snapshot.cleanup();
  assert.equal(result.outcome, "removed"); assert.equal(result.validation, "verified");
  assert.equal(f.closes.length, 2);
  await assert.rejects(lstat(dirname(snapshot.path)), { code: "ENOENT" });
  await assert.rejects(snapshot.verifyOriginal(), /handles_closed/u);
  await assert.rejects(snapshot.verifySnapshot(), /handles_closed/u);
  await snapshot.cleanup(); assert.equal(f.removals, 1); assert.equal(f.closes.length, 2);
});

test("snapshot ctime-only synthetic cache mutation is allowed while original full-ctime pin stays fixed", async t => {
  const f = await fixture(t), snapshot = await f.create();
  const before = await lstat(snapshot.path, { bigint: true });
  await bumpCtime(snapshot.path);
  const after = await lstat(snapshot.path, { bigint: true });
  assert.notEqual(before.ctimeNs, after.ctimeNs);
  assert.deepEqual(metadata(after, false), metadata(before, false));
  await snapshot.verifySnapshot();
  await snapshot.verifyOriginal();
  await snapshot.cleanup();
});

test("original ctime-only change is rejected without refresh and remains sticky after cleanup recovery", async t => {
  const f = await fixture(t), snapshot = await f.create();
  await bumpCtime(f.original);
  await assert.rejects(snapshot.verifyOriginal(), /identity_mismatch/u);
  const first = await rejection(() => snapshot.cleanup());
  assert.ok(first instanceof AggregateError);
  assert.match(first.errors[0].message, /identity_mismatch/u);
  assert.equal(first.cleanup.outcome, "removed");
  assert.equal(first.cleanup.validation, "not_verified");
  assert.equal(f.closes.length, 2);
  const retry = await rejection(() => snapshot.cleanup());
  assert.equal(retry.errors[0], first.errors[0]);
  assert.equal(f.removals, 1); assert.equal(f.opens.length, 2);
});

for (const kind of ["bytes", "mtime", "mode", "hardlink", "inode", "symlink", "truncate", "append"]) {
  test(`snapshot ${kind} changes are rejected and never adopted as valid pins`, async t => {
    const f = await fixture(t, kind === "bytes" ? { snapshotMtime: 1234567890 } : {}), snapshot = await f.create();
    const stat = await lstat(snapshot.path);
    if (kind === "bytes") {
      const handle = await open(snapshot.path, "r+");
      await handle.write(Buffer.alloc(f.bytes.length, 120), 0, f.bytes.length, 0); await handle.close();
      await utimes(snapshot.path, 1234567890, 1234567890);
    } else if (kind === "mtime") await utimes(snapshot.path, stat.atime, new Date(1234567890000));
    else if (kind === "mode") await chmod(snapshot.path, 0o400);
    else if (kind === "hardlink") await link(snapshot.path, `${snapshot.path}.linked`);
    else if (kind === "truncate") await truncate(snapshot.path, 1);
    else if (kind === "append") await writeFile(snapshot.path, "extra", { flag: "a" });
    else {
      await rename(snapshot.path, `${snapshot.path}.displaced`);
      if (kind === "inode") await writeFile(snapshot.path, f.bytes, { mode: 0o600 });
      else await symlink(`${snapshot.path}.displaced`, snapshot.path);
    }
    if (kind === "bytes") {
      assert.equal((await lstat(snapshot.path, { bigint: true })).mtimeNs, 1234567890000000000n);
      await assert.rejects(snapshot.verifySnapshot(), /bytes_mismatch/u);
    } else await assert.rejects(snapshot.verifySnapshot(), /identity_mismatch/u);
    const first = await rejection(() => snapshot.cleanup());
    assert.equal(first.cleanup.validation, "not_verified"); assert.equal(f.removals, 0);
    assert.equal(f.closes.length, 2);
    const retry = await rejection(() => snapshot.cleanup());
    assert.equal(retry.cleanup.validation, "not_verified");
    if (["inode", "symlink", "hardlink", "mode", "mtime", "truncate", "append"].includes(kind)) {
      assert.equal(f.removals, 0);
      assert.equal((await lstat(dirname(snapshot.path))).isDirectory(), true);
    }
  });
}

for (const kind of ["inode", "symlink", "truncate", "append"]) {
  test(`original ${kind} mutation cannot pass retained FD and pathname fences`, async t => {
    const f = await fixture(t), snapshot = await f.create();
    if (kind === "truncate") await truncate(f.original, 1);
    else if (kind === "append") await writeFile(f.original, "extra", { flag: "a" });
    else {
      await rename(f.original, `${f.original}.displaced`);
      if (kind === "inode") await writeFile(f.original, f.bytes);
      else await symlink(`${f.original}.displaced`, f.original);
    }
    await assert.rejects(snapshot.verifyOriginal(), /identity_mismatch/u);
    await assert.rejects(snapshot.cleanup(), error => contains(error, /identity_mismatch/u));
    assert.equal(f.closes.length, 2); assert.equal(f.opens.length, 2);
  });
}

test("bounded streaming handles positive partial reads and partial writes", async t => {
  const f = await fixture(t, { readLimit: 7, writeLimit: 3 });
  const snapshot = await f.create();
  await snapshot.verifyOriginal(); await snapshot.verifySnapshot();
  assert.deepEqual(await readFile(snapshot.path), f.bytes);
  await snapshot.cleanup(); assert.equal(f.closes.length, 2);
});

for (const kind of ["zero-read", "zero-write", "copy-append", "copy-truncate"]) {
  test(`${kind} initialization fails with bounded cleanup and no leaked FD`, async t => {
    let hit = false;
    const f = await fixture(t, {
      async read(handle, path, buffer, offset, length, position) {
        if (path === f.original && !hit) {
          hit = true;
          if (kind === "zero-read") return { bytesRead: 0, buffer };
          if (kind === "copy-append") await writeFile(path, "appended", { flag: "a" });
          if (kind === "copy-truncate") await truncate(path, 1);
        }
        return handle.read(buffer, offset, length, position);
      },
      async write(handle, buffer, offset, length, position) {
        if (kind === "zero-write") return { bytesWritten: 0, buffer };
        return handle.write(buffer, offset, length, position);
      },
    });
    const error = await rejection(() => f.create());
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /creation_failed/u);
    assert.equal(f.closes.length, 2);
    await assert.rejects(lstat(f.stage), { code: "ENOENT" });
  });
}

test("fixed 4 GiB budget rejects a sparse oversized original before opening or staging", async t => {
  const f = await fixture(t);
  await truncate(f.original, 4 * 1024 * 1024 * 1024 + 1);
  const error = await rejection(() => f.create());
  assert.match(error.errors[0].message, /budget_exceeded/u);
  assert.equal(f.opens.length, 0); assert.equal(f.stage, undefined);
});

for (const kind of ["symlink", "hardlink", "directory", "relative"]) {
  test(`unsafe original ${kind} fails before copying`, async t => {
    const f = await fixture(t);
    let path = f.original;
    if (kind === "symlink") { path = join(f.root, "link.dmg"); await symlink(f.original, path); }
    else if (kind === "hardlink") await link(f.original, join(f.root, "linked.dmg"));
    else if (kind === "directory") path = f.root;
    else path = "relative.dmg";
    await assert.rejects(createDmgInputSnapshot(path, f.dependencies), /original_invalid|creation_failed|path_invalid/u);
    assert.equal(f.opens.length, 0);
  });
}

test("original replacement between lstat and open fails without repinning", async t => {
  let hit = false;
  const f = await fixture(t, {
    async beforeOpen(path) {
      if (path === f.original && !hit) {
        hit = true; await rename(path, `${path}.displaced`); await writeFile(path, f.bytes);
      }
    },
  });
  const error = await rejection(() => f.create());
  assert.match(error.errors[0].message, /identity_mismatch/u);
  assert.equal(f.closes.length, 1); assert.equal(f.stage, undefined);
  assert.deepEqual(await readFile(f.original), f.bytes);
});

test("partial-copy failure aggregates falsy primary, cleanup and close causes with fixed residue", async t => {
  const f = await fixture(t, {
    async write() { throw undefined; },
    async remove() { throw false; },
    async afterClose(_path, index) { throw index === 0 ? null : 0; },
  });
  const error = await rejection(() => f.create());
  assert.deepEqual(error.errors, [undefined, false, null, 0]);
  assert.equal(error.cleanup.outcome, "residue");
  assert.equal(error.cleanup.residuePath, f.stage);
  assert.match(error.cleanup.residueIdentity, /^[0-9a-f]+:[0-9a-f]+$/u);
  assert.match(error.cleanup.snapshotIdentity, /^[0-9a-f]+:[0-9a-f]+$/u);
  assert.equal(f.closes.length, 2);
});

test("secure failure removes only the initial identity-bound empty directory and closes original", async t => {
  const f = await fixture(t, { async secure() { throw null; } });
  const error = await rejection(() => f.create());
  assert.deepEqual(error.errors, [null]); assert.equal(error.cleanup.outcome, "removed");
  assert.equal(f.emptyRemovals, 1); assert.equal(f.closes.length, 1);
  await assert.rejects(lstat(f.stage), { code: "ENOENT" });
});

test("allocated root with failed initial stat reports untrusted residue without path-only deletion", async t => {
  const f = await fixture(t, {
    async inspect(path, options) {
      if (path === f.stage) throw undefined;
      return lstat(path, options);
    },
  });
  const error = await rejection(() => f.create());
  assert.deepEqual(error.errors, [undefined]);
  assert.equal(error.cleanup.residuePath, f.stage);
  assert.equal(error.cleanup.reason, "initial_identity_unavailable");
  assert.equal(Object.hasOwn(error.cleanup, "residueIdentity"), false);
  assert.equal((await lstat(f.stage)).isDirectory(), true);
  assert.equal(f.closes.length, 1); assert.equal(f.emptyRemovals, 0); assert.equal(f.removals, 0);
});

test("snapshot replacement during failed initialization stays residue and cannot be deleted as owned leaf", async t => {
  const f = await fixture(t, {
    async write(_handle) {
      const path = join(f.stage, "input.dmg");
      await rename(path, `${path}.displaced`); await writeFile(path, "replacement", { mode: 0o600 });
      throw "copy_failed";
    },
  });
  const error = await rejection(() => f.create());
  assert.equal(error.errors[0], "copy_failed"); assert.match(error.errors[1].message, /cleanup_leaf_identity_mismatch/u);
  assert.equal(await readFile(join(f.stage, "input.dmg"), "utf8"), "replacement");
  assert.equal(f.removals, 0); assert.equal(f.closes.length, 2);
});

test("snapshot cleanup root replacement remains fixed-pin residue on every retry", async t => {
  const f = await fixture(t), snapshot = await f.create();
  const displaced = `${f.stage}.displaced`; await rename(f.stage, displaced); await mkdir(f.stage, { mode: 0o700 });
  await writeFile(join(f.stage, "valuable.txt"), "preserve");
  for (let count = 0; count < 2; count += 1) {
    const error = await rejection(() => snapshot.cleanup());
    assert.equal(error.cleanup.residuePath, f.stage);
    assert.equal(error.cleanup.validation, "not_verified");
  }
  assert.equal(await readFile(join(f.stage, "valuable.txt"), "utf8"), "preserve");
  assert.equal(f.removals, 0); assert.equal(f.closes.length, 2);
});

test("native transient failure coalesces attempts, closes exactly once and retries filesystem recovery only", async t => {
  let fail = true, attempts = 0;
  const f = await fixture(t, {
    async remove(input, invokeDefault) {
      attempts += 1;
      if (fail) throw undefined;
      return invokeDefault(input);
    },
  });
  const snapshot = await f.create();
  const errors = await Promise.all([rejection(() => snapshot.cleanup()), rejection(() => snapshot.cleanup())]);
  assert.equal(errors[0], errors[1]); assert.deepEqual(errors[0].errors, [undefined]);
  assert.equal(f.closes.length, 2); assert.equal(attempts, 1);
  await assert.rejects(snapshot.verifyOriginal(), /handles_closed/u);
  fail = false;
  const reads = f.reads;
  const results = await Promise.all([snapshot.cleanup(), snapshot.cleanup()]);
  assert.equal(results[0], results[1]); assert.equal(results[0].outcome, "removed");
  assert.equal(attempts, 2); assert.equal(f.reads, reads); assert.equal(f.opens.length, 2);
});

test("original final verification after native remove catches mutation and preserves both native and verification causes", async t => {
  const f = await fixture(t, {
    async remove() { await bumpCtime(f.original); throw false; },
  });
  const snapshot = await f.create(), error = await rejection(() => snapshot.cleanup());
  assert.ok(contains(error, /identity_mismatch/u)); assert.equal(error.errors.at(-1), false);
  assert.equal(error.cleanup.validation, "not_verified"); assert.equal(f.closes.length, 2);
});

test("release-only coalesces exact close calls, preserves image and later recovery cannot mint verification", async t => {
  const f = await fixture(t), snapshot = await f.create();
  const results = await Promise.all([snapshot.releaseHandles(), snapshot.releaseHandles()]);
  assert.equal(results[0].outcome, "residue"); assert.equal(results[0].validation, "not_verified");
  assert.equal(f.closes.length, 2); assert.equal(f.removals, 0);
  assert.deepEqual(await readFile(snapshot.path), f.bytes);
  await assert.rejects(snapshot.verifySnapshot(), /handles_closed/u);
  await assert.rejects(snapshot.verifyOriginal(), /handles_closed/u);
  const error = await rejection(() => snapshot.cleanup());
  assert.match(error.errors[0].message, /validation_unavailable/u);
  assert.equal(error.cleanup.outcome, "removed"); assert.equal(error.cleanup.validation, "not_verified");
  assert.equal(f.opens.length, 2); assert.equal(f.closes.length, 2);
});

test("falsy release close errors remain traceable on repeated release and cleanup", async t => {
  const f = await fixture(t, { async afterClose(_path, index) { throw index === 0 ? undefined : false; } });
  const snapshot = await f.create();
  for (let count = 0; count < 2; count += 1) {
    const error = await rejection(() => snapshot.releaseHandles());
    assert.deepEqual(error.errors, [undefined, false]);
    assert.equal(error.cleanup.outcome, "residue");
  }
  const cleanupError = await rejection(() => snapshot.cleanup());
  assert.match(cleanupError.errors[0].message, /validation_unavailable/u);
  assert.deepEqual(cleanupError.errors.slice(1), [undefined, false]);
  assert.equal(f.closes.length, 2);
});

/** Real tempfile/FD fixtures with explicitly synthetic lease/security/native-removal receipts; no hdiutil or real mount. */
async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ling-cua-dmg-snapshot-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = join(root, "EXPLICIT-SYNTHETIC-NONMOUNTABLE.dmg");
  const bytes = Buffer.from("EXPLICIT SYNTHETIC DMG BYTES, NOT A MOUNTABLE IMAGE.\n".repeat(3));
  await writeFile(original, bytes, { mode: 0o600 });
  const f = { root, original, bytes, opens: [], closes: [], reads: 0, removals: 0, emptyRemovals: 0 };
  const verifyDirectory = async input => {
    const parent = await lstat(input.parentRoot, { bigint: true });
    const source = await lstat(join(input.parentRoot, input.sourceName ?? input.directoryName), { bigint: true });
    const parentIdentity = identity(parent), sourceIdentity = identity(source);
    assert.equal(parentIdentity, input.expectedParentIdentity);
    assert.equal(sourceIdentity, input.expectedSourceIdentity ?? input.expectedDirectoryIdentity);
    assert.equal(source.isDirectory() && !source.isSymbolicLink(), true);
    return { parentIdentity, sourceIdentity, directoryIdentity: sourceIdentity };
  };
  const removeDefault = async input => {
    await verifyDirectory(input);
    const path = join(input.parentRoot, input.sourceName), names = await readdir(path);
    assert.deepEqual(names, ["input.dmg"]);
    assert.equal((await lstat(join(path, "input.dmg"))).size, input.expectedTotalBytes);
    assert.equal(input.expectedEntries, 1); assert.equal(input.entryPolicy, "artifact");
    await rm(path, { recursive: true }); f.removals += 1;
  };
  f.dependencies = {
    async dmgSnapshotLstat(path, options) {
      if (overrides.inspect) return overrides.inspect(path, options);
      return lstat(path, options);
    },
    async dmgSnapshotMkdtemp() { f.stage = await mkdtemp(join(root, "stage-")); return f.stage; },
    async dmgSnapshotOpen(path, flags, mode) {
      if (overrides.beforeOpen) await overrides.beforeOpen(path);
      const handle = await open(path, flags, mode); f.opens.push({ path, flags, handle });
      return {
        stat: options => handle.stat(options),
        async sync() {
          await handle.sync();
          if (overrides.snapshotMtime !== undefined) await handle.utimes(overrides.snapshotMtime, overrides.snapshotMtime);
        },
        async read(buffer, offset, length, position) {
          f.reads += 1;
          assert.ok(Number.isSafeInteger(position) && position >= 0, "all reads require explicit positions");
          if (overrides.read) return overrides.read(handle, path, buffer, offset, length, position);
          return handle.read(buffer, offset, Math.min(length, overrides.readLimit ?? length), position);
        },
        async write(buffer, offset, length, position) {
          if (overrides.write) return overrides.write(handle, buffer, offset, length, position);
          return handle.write(buffer, offset, Math.min(length, overrides.writeLimit ?? length), position);
        },
        async close() {
          const index = f.closes.length; f.closes.push(path); await handle.close();
          if (overrides.afterClose) await overrides.afterClose(path, index);
        },
      };
    },
    async withAtomicPublishParentLease(_input, operation) {
      const lease = { guard: operation => operation(), assertHeld() {} };
      return operation(lease);
    },
    async readAtomicPublishDirectoryIdentities({ parentRoot, sourceName }) {
      return { parentIdentity: identity(await lstat(parentRoot, { bigint: true })),
        sourceIdentity: identity(await lstat(join(parentRoot, sourceName), { bigint: true })) };
    },
    async securePrivateStagingDirectory(input) {
      if (overrides.secure) return overrides.secure(input);
      await verifyDirectory(input); await chmod(join(input.parentRoot, input.directoryName), 0o700);
      return verifyDirectory(input);
    },
    async verifyPrivateStagingDirectorySecurity(input) {
      const result = await verifyDirectory(input);
      const stat = await lstat(join(input.parentRoot, input.directoryName));
      assert.equal(stat.mode & 0o777, 0o700); return result;
    },
    async removeAtomicPublishDirectoryTree(input) {
      if (overrides.remove) return overrides.remove(input, removeDefault);
      return removeDefault(input);
    },
    async removeAtomicPublishUnsecuredEmptyDirectory(input) {
      await verifyDirectory(input); await rmdir(join(input.parentRoot, input.sourceName)); f.emptyRemovals += 1;
    },
  };
  f.create = async () => {
    const snapshot = await createDmgInputSnapshot(original, f.dependencies);
    t.after(async () => { try { await snapshot.releaseHandles(); } catch {} });
    return snapshot;
  };
  return f;
}
function identity(stat) {
  return `${BigInt.asUintN(64, stat.dev).toString(16)}:${BigInt.asUintN(64, stat.ino).toString(16)}`;
}
function metadata(stat, ctime = true) {
  return ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", ...(ctime ? ["ctimeNs"] : [])].map(key => stat[key]);
}
async function bumpCtime(path) {
  const mode = (await lstat(path)).mode & 0o777;
  await chmod(path, mode ^ 0o200); await chmod(path, mode);
}
async function rejection(operation) {
  try { await operation(); } catch (error) { return error; }
  assert.fail("expected rejection, including a falsy rejection");
}
function contains(error, expression) {
  return expression.test(error?.message ?? "")
    || (error instanceof AggregateError && error.errors.some(cause => contains(cause, expression)));
}
