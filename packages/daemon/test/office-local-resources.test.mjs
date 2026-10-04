import assert from "node:assert/strict";
import fs, { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OfficeLocalResourceOwner } from "../dist/features/office-documents/office-local-resources.js";

const source = Object.freeze({ runId: "run", workUnitId: "unit", attemptId: "attempt",
  runtimeInstanceId: "office-runtime", fencingToken: "fence" });
const invalid = error => error.code === "office_local_resource_invalid";
const nativeClose = fs.closeSync;
const nativeFstat = fs.fstatSync;

/** Real temporary files and FD lifetimes only; no SQLite, SDK, GUI or safe receipt. */
function fixture(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-resources-")));
  const opened = new Set();
  t.after(async () => {
    // Test teardown closes only live descriptors this fixture actually opened.
    // It is not a production retry or a transition from unknown to closed.
    for (const fd of opened) nativeClose(fd);
    await rm(cwd, { recursive: true, force: true });
  });
  const open = (name = "resource.tmp", flags = "w+") => {
    const fd = fs.openSync(join(cwd, name), flags, 0o600);
    opened.add(fd); return fd;
  };
  const close = fd => { nativeClose(fd); opened.delete(fd); };
  const retain = (owner, fd, id = "lifetime", memberId = "temporary") => owner.retainOpened({
    resourceLifetimeId: id, memberId, openEffectId: `open-${id}`, fd,
  });
  return { cwd, open, close, retain };
}

/** Synchronous fault/spy with deterministic restoration of Node's ESM binding. */
function withFstat(replacement, run) {
  const original = fs.fstatSync;
  fs.fstatSync = replacement(original); syncBuiltinESMExports();
  try { return run(); } finally { fs.fstatSync = original; syncBuiltinESMExports(); }
}

function release(owner, resource, f, closeEffectId = `close-${resource.resourceLifetimeId}`) {
  owner.assertUsable(resource);
  owner.beginClose(resource, closeEffectId);
  f.close(resource.fd);
  owner.markClosed(resource);
}

test("Office resource retains a real FD before observation and exposes frozen metadata without raw FD", t => {
  const f = fixture(t), owner = new OfficeLocalResourceOwner("execution", source), fd = f.open();
  const resource = f.retain(owner, fd);
  assert.equal(Object.isFrozen(resource), true);
  assert.deepEqual(owner.snapshots(), [{ memberId: "temporary", resourceLifetimeId: "lifetime", openEffectId: "open-lifetime", state: "retained" }]);
  assert.equal(owner.cleanupCandidates()[0], resource);
  const identity = owner.assertUsable(resource), actual = nativeFstat(fd, { bigint: true });
  assert.equal(identity.device, String(actual.dev)); assert.equal(identity.inode, String(actual.ino));
  const snapshot = owner.snapshots();
  assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(snapshot[0]), true);
  assert.equal("fd" in snapshot[0], false);
  assert.throws(() => snapshot.push({ state: "closed" }), TypeError);
  assert.throws(() => { snapshot[0].state = "closed"; }, TypeError);
  release(owner, resource, f);
});

for (const otherSource of [source, { ...source, attemptId: "foreign-attempt" }]) {
  test(`Office resource clone and ${otherSource === source ? "same-source" : "foreign-source"} owner cannot borrow live capability`, t => {
    const f = fixture(t), owner = new OfficeLocalResourceOwner("execution", source);
    const other = new OfficeLocalResourceOwner("execution", otherSource), fd = f.open(), resource = f.retain(owner, fd);
    const clone = { ...resource }, fromJson = JSON.parse(JSON.stringify(resource));
    let stats = 0;
    withFstat(original => (...args) => { stats++; return original(...args); }, () => {
      for (const rejected of [clone, fromJson]) {
        assert.throws(() => owner.assertUsable(rejected), invalid);
        assert.throws(() => owner.beginClose(rejected, "close-clone"), invalid);
        assert.throws(() => owner.markClosed(rejected), invalid);
      }
      assert.throws(() => other.assertUsable(resource), invalid);
      assert.throws(() => other.beginClose(resource, "close-foreign"), invalid);
      assert.throws(() => other.markClosed(resource), invalid);
      assert.equal(stats, 0, "capability rejection must precede even fstat");
    });
    assert.deepEqual(other.cleanupCandidates(), []);
    assert.equal(owner.cleanupCandidates()[0], resource);
    assert.equal(owner.snapshots()[0].state, "retained");
    assert.doesNotThrow(() => nativeFstat(fd));
    release(owner, resource, f);
  });
}

test("Office unknown close forbids retry and fstat even after the OS reuses the same FD for the same inode", t => {
  const f = fixture(t), owner = new OfficeLocalResourceOwner("execution", source), fd = f.open();
  const resource = f.retain(owner, fd), identity = owner.assertUsable(resource);
  let closes = 0, borrowed;
  // Fault injection delivers a thrown close API result after the actual kernel
  // released the number. The owner never receives a confirmed native return.
  const unknownNativeClose = () => {
    closes++; f.close(fd);
    borrowed = f.open("resource.tmp", "r+");
    assert.equal(borrowed, fd, "use a real OS reused number, not a mocked FD");
    throw Object.assign(new Error("native close outcome is unconfirmed"), { code: "EINTR" });
  };
  const closeAttempt = () => {
    owner.assertUsable(resource);
    owner.beginClose(resource, "close-unknown");
    unknownNativeClose();
    owner.markClosed(resource);
  };
  assert.throws(closeAttempt, { code: "EINTR" });
  const borrowedIdentity = nativeFstat(borrowed, { bigint: true });
  assert.equal(String(borrowedIdentity.dev), identity.device); assert.equal(String(borrowedIdentity.ino), identity.inode);
  let stats = 0;
  withFstat(original => (...args) => { stats++; return original(...args); }, () => {
    assert.throws(closeAttempt, invalid);
    assert.throws(() => owner.assertUsable(resource), invalid);
    assert.throws(() => owner.beginClose(resource, "second-close"), invalid);
    assert.equal(stats, 0, "unknown close must not inspect a potentially borrowed FD");
  });
  assert.equal(closes, 1);
  assert.deepEqual(owner.cleanupCandidates(), []);
  assert.equal(owner.snapshots()[0].state, "unknown");
  assert.equal(owner.snapshots()[0].closeEffectId, "close-unknown");
  assert.doesNotThrow(() => nativeFstat(borrowed), "the borrowed same-inode descriptor must still be open");
});

test("Office first fstat failure keeps original ownership and permits one later bounded close", t => {
  const f = fixture(t), owner = new OfficeLocalResourceOwner("execution", source), fd = f.open(), resource = f.retain(owner, fd);
  let stats = 0;
  withFstat(original => (...args) => {
    if (args[0] === fd && ++stats === 1) throw Object.assign(new Error("first fstat failed"), { code: "EIO" });
    return original(...args);
  }, () => assert.throws(() => owner.assertUsable(resource), { code: "EIO" }));
  assert.equal(stats, 1);
  assert.deepEqual(owner.snapshots(), [{ memberId: "temporary", resourceLifetimeId: "lifetime", openEffectId: "open-lifetime", state: "retained" }]);
  assert.equal(owner.cleanupCandidates()[0], resource, "initial identity failure cannot discard the actual open return");
  assert.doesNotThrow(() => nativeFstat(fd));
  release(owner, resource, f);
  assert.equal(owner.snapshots()[0].state, "closed");
  assert.deepEqual(owner.cleanupCandidates(), []);
  assert.throws(() => nativeFstat(fd), { code: "EBADF" });
});

test("Office known close return stays closed after a later Host-callback error (owner state, not COMMIT integration)", t => {
  const f = fixture(t), owner = new OfficeLocalResourceOwner("execution", source), fd = f.open(), resource = f.retain(owner, fd);
  assert.throws(() => {
    owner.assertUsable(resource); owner.beginClose(resource, "close-returned");
    f.close(fd); owner.markClosed(resource);
    throw Object.assign(new Error("subsequent Host callback failed"), { code: "EIO" });
  }, { code: "EIO" });
  const snapshot = owner.snapshots()[0];
  assert.equal(snapshot.state, "closed"); assert.equal(snapshot.closeEffectId, "close-returned");
  assert.deepEqual(owner.cleanupCandidates(), []);
  let stats = 0;
  withFstat(original => (...args) => { stats++; return original(...args); }, () => {
    assert.throws(() => owner.assertUsable(resource), invalid);
    assert.throws(() => owner.beginClose(resource, "close-again"), invalid);
    assert.throws(() => owner.markClosed(resource), invalid);
    assert.equal(stats, 0);
  });
  assert.throws(() => nativeFstat(fd), { code: "EBADF" });
});

test("Office cleanup candidates contain only this owner's original retained handles, never unknown, closed or foreign", t => {
  const f = fixture(t), owner = new OfficeLocalResourceOwner("execution", source), foreign = new OfficeLocalResourceOwner("foreign", source);
  const retained = f.retain(owner, f.open("retained.tmp"), "retained");
  const unknown = f.retain(owner, f.open("unknown.tmp"), "unknown");
  const closed = f.retain(owner, f.open("closed.tmp"), "closed");
  const foreignResource = f.retain(foreign, f.open("foreign.tmp"), "foreign");
  owner.assertUsable(unknown); owner.beginClose(unknown, "close-unknown");
  f.close(unknown.fd); // Keep unknown metadata; do not invent a received return for this owner.
  release(owner, closed, f);
  const candidates = owner.cleanupCandidates();
  assert.equal(candidates.length, 1); assert.equal(candidates[0], retained);
  assert.equal(candidates.includes({ ...retained }), false);
  assert.equal(candidates.includes(unknown), false); assert.equal(candidates.includes(closed), false);
  assert.equal(candidates.includes(foreignResource), false);
  assert.throws(() => owner.assertUsable(foreignResource), invalid);
  assert.equal(foreign.cleanupCandidates()[0], foreignResource);
  candidates.length = 0;
  assert.equal(owner.cleanupCandidates()[0], retained, "editing a returned array cannot edit the owner's private roster");
  release(owner, retained, f); release(foreign, foreignResource, f);
});

for (const stage of ["retained", "unknown", "closed"]) {
  test(`Office lifetime cannot be reused after original resource is ${stage}`, t => {
    const f = fixture(t), owner = new OfficeLocalResourceOwner("execution", source), fd = f.open(), resource = f.retain(owner, fd);
    if (stage === "closed") release(owner, resource, f);
    else if (stage === "unknown") { owner.assertUsable(resource); owner.beginClose(resource, "close-unknown"); f.close(fd); }
    const nextFd = f.open("next.tmp"), before = owner.snapshots();
    assert.throws(() => f.retain(owner, nextFd), invalid);
    assert.deepEqual(owner.snapshots(), before);
    assert.doesNotThrow(() => nativeFstat(nextFd), "rejection does not close an unrelated new descriptor");
    if (stage === "retained") release(owner, resource, f);
  });
}

test("Office source is captured immutably, not borrowed from mutable caller metadata", t => {
  const f = fixture(t), input = { ...source }, owner = new OfficeLocalResourceOwner("execution", input);
  input.attemptId = "successor"; input.fencingToken = "successor-fence";
  assert.deepEqual(owner.source, source); assert.equal(Object.isFrozen(owner.source), true);
  const resource = f.retain(owner, f.open()); release(owner, resource, f);
});
