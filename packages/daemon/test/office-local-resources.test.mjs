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
  assert.deepEqual(owner.snapshots(), [{ origin: "effect", memberId: "temporary", resourceLifetimeId: "lifetime", openEffectId: "open-lifetime", state: "retained" }]);
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
  assert.deepEqual(owner.snapshots(), [{ origin: "effect", memberId: "temporary", resourceLifetimeId: "lifetime", openEffectId: "open-lifetime", state: "retained" }]);
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

const now = () => new Date().toISOString();
const instant = (at, offset) => new Date(Date.parse(at) + offset).toISOString();
const readBytes = Buffer.from("actual member read bytes");

/** Capture a real read-only native open return, without inspecting its FD first. */
function readInput(f, id = "read-lifetime", purpose = "refresh", name = "read.tmp") {
  fs.writeFileSync(join(f.cwd, name), readBytes);
  const openCalledAt = now(), fd = f.open(name, "r"), openReturnedAt = now();
  return { resourceLifetimeId: id, memberId: "temporary", readId: `read-${id}`, purpose, openCalledAt, openReturnedAt, fd };
}

/** Read cleanup has no fstat precondition and marks closed only after native return. */
function releaseRead(owner, resource, f) {
  owner.beginReadClose(resource, now());
  f.close(resource.fd);
  owner.markReadClosed(resource, now());
}

for (const purpose of ["refresh", "final"]) {
  test(`Office read resource ${purpose} retains before first fstat and freezes complete FD-free metadata`, t => {
    const f = fixture(t), owner = new OfficeLocalResourceOwner("execution", source);
    let stats = 0, input, resource, observed;
    withFstat(original => (...args) => { stats++; return original(...args); }, () => {
      input = readInput(f, "read-lifetime", purpose); resource = owner.retainReadOpened(input);
      assert.equal(stats, 0, "native read open return is owned before its first fstat");
      assert.equal(Object.isFrozen(resource), true);
      assert.deepEqual(owner.cleanupCandidates(), [], "writer effect cleanup cannot close a read handle");
      observed = owner.inspectUsable(resource);
      assert.equal(stats, 1);
    });
    const actual = nativeFstat(input.fd, { bigint: true }), snapshot = owner.readSnapshot(resource);
    assert.equal(observed.isFile, true);
    assert.deepEqual(observed.identity, { device: String(actual.dev), inode: String(actual.ino), sizeBytes: Number(actual.size),
      modifiedNs: String(actual.mtimeNs), changedNs: String(actual.ctimeNs) });
    assert.deepEqual(fs.readFileSync(input.fd), readBytes);
    assert.deepEqual(Object.keys(snapshot).sort(), ["memberId", "resourceLifetimeId", "identity", "origin", "state",
      "readId", "purpose", "openCalledAt", "openReturnedAt", "identityObservedAt"].sort());
    assert.equal(snapshot.origin, "member_read"); assert.equal(snapshot.state, "retained");
    assert.equal(snapshot.readId, input.readId); assert.equal(snapshot.purpose, purpose);
    assert.equal(snapshot.resourceLifetimeId, input.resourceLifetimeId); assert.deepEqual(snapshot.identity, observed.identity);
    assert.equal(snapshot.openCalledAt, input.openCalledAt); assert.equal(snapshot.openReturnedAt, input.openReturnedAt);
    assert.ok(snapshot.openCalledAt <= snapshot.openReturnedAt && snapshot.openReturnedAt <= snapshot.identityObservedAt);
    assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(snapshot.identity), true);
    assert.throws(() => { snapshot.state = "closed"; }, TypeError);
    assert.throws(() => { snapshot.identity.inode = "foreign"; }, TypeError);
    const snapshots = owner.snapshots();
    assert.equal(Object.isFrozen(snapshots), true); assert.deepEqual(snapshots, [snapshot]);
    assert.throws(() => snapshots.push(snapshot), TypeError);
    releaseRead(owner, resource, f);
    const closed = owner.readSnapshot(resource);
    assert.equal(closed.state, "closed"); assert.deepEqual(closed.identity, snapshot.identity);
    assert.equal(closed.identityObservedAt, snapshot.identityObservedAt);
    assert.ok(closed.identityObservedAt <= closed.closeEnteredAt && closed.closeEnteredAt <= closed.closeReturnedAt);
    for (const key of ["openCalledAt", "openReturnedAt", "identityObservedAt", "closeEnteredAt", "closeReturnedAt"]) {
      assert.equal(new Date(closed[key]).toISOString(), closed[key]);
    }
    assert.deepEqual(Object.keys(closed).sort(), [...Object.keys(snapshot), "closeEnteredAt", "closeReturnedAt"].sort());
    assert.equal("fd" in closed, false); assert.equal("openEffectId" in closed, false); assert.equal("closeEffectId" in closed, false);
    assert.equal(JSON.stringify(closed).includes('"fd"'), false);
    assert.equal(snapshot.state, "retained", "an earlier immutable snapshot is not rewritten after close");
    assert.throws(() => nativeFstat(input.fd), { code: "EBADF" });
  });
}

test("Office read resource first fstat failure closes its original FD without another inspection", t => {
  const f = fixture(t), owner = new OfficeLocalResourceOwner("execution", source);
  let stats = 0, input, resource;
  withFstat(() => () => {
    stats++;
    throw Object.assign(new Error(stats === 1 ? "first read fstat failed" : "cleanup must not inspect again"), { code: "EIO" });
  }, () => {
    input = readInput(f); resource = owner.retainReadOpened(input);
    assert.equal(stats, 0);
    assert.throws(() => owner.inspectUsable(resource), { code: "EIO" });
    assert.deepEqual(owner.readSnapshot(resource), { origin: "member_read", state: "retained", memberId: input.memberId,
      resourceLifetimeId: input.resourceLifetimeId, readId: input.readId, purpose: input.purpose,
      openCalledAt: input.openCalledAt, openReturnedAt: input.openReturnedAt });
    releaseRead(owner, resource, f);
    assert.equal(stats, 1, "beginReadClose/close/markReadClosed do not need a successful fstat");
  });
  const closed = owner.readSnapshot(resource);
  assert.equal(closed.state, "closed"); assert.equal("identity" in closed, false); assert.equal("identityObservedAt" in closed, false);
  assert.ok(closed.openReturnedAt <= closed.closeEnteredAt && closed.closeEnteredAt <= closed.closeReturnedAt);
  assert.deepEqual(owner.cleanupCandidates(), []);
  assert.throws(() => nativeFstat(input.fd), { code: "EBADF" });
});

test("Office read resource unknown close cannot inspect or retry a real same-inode reused FD", t => {
  const f = fixture(t), owner = new OfficeLocalResourceOwner("execution", source), input = readInput(f);
  const resource = owner.retainReadOpened(input), identity = owner.inspectUsable(resource).identity;
  let closes = 0, borrowed;
  const closeAttempt = () => {
    owner.beginReadClose(resource, now());
    closes++; f.close(input.fd);
    borrowed = f.open("read.tmp", "r");
    assert.equal(borrowed, input.fd, "the kernel must actually reuse the original number");
    throw Object.assign(new Error("read close outcome unconfirmed after kernel release"), { code: "EINTR" });
  };
  assert.throws(closeAttempt, { code: "EINTR" });
  const actual = nativeFstat(borrowed, { bigint: true }), before = owner.readSnapshot(resource);
  assert.equal(String(actual.dev), identity.device); assert.equal(String(actual.ino), identity.inode);
  assert.equal(before.state, "unknown"); assert.ok(before.closeEnteredAt >= before.openReturnedAt);
  assert.equal("closeReturnedAt" in before, false); assert.equal("closeEffectId" in before, false);
  let stats = 0;
  withFstat(original => (...args) => { stats++; return original(...args); }, () => {
    assert.throws(() => owner.inspectUsable(resource), invalid);
    assert.throws(() => owner.assertUsable(resource), invalid);
    assert.throws(() => owner.beginReadClose(resource, now()), invalid);
    assert.throws(closeAttempt, invalid);
    assert.equal(stats, 0, "unknown read close rejects before inspecting a borrowed numeric FD");
  });
  assert.equal(closes, 1); assert.deepEqual(owner.readSnapshot(resource), before);
  assert.deepEqual(owner.cleanupCandidates(), []);
  assert.deepEqual(fs.readFileSync(borrowed), readBytes);
  assert.doesNotThrow(() => nativeFstat(borrowed), "the same-inode borrowed descriptor remains open");
});

for (const otherSource of [source, { ...source, attemptId: "foreign-attempt" }]) {
  test(`Office read resource clone and ${otherSource === source ? "same-source" : "foreign-source"} owner cannot borrow capability`, t => {
    const f = fixture(t), owner = new OfficeLocalResourceOwner("execution", source), other = new OfficeLocalResourceOwner("execution", otherSource);
    const input = readInput(f), resource = owner.retainReadOpened(input), before = owner.snapshots();
    let stats = 0;
    withFstat(original => (...args) => { stats++; return original(...args); }, () => {
      for (const [target, rejected] of [[owner, { ...resource }], [owner, JSON.parse(JSON.stringify(resource))], [other, resource]]) {
        assert.throws(() => target.inspectUsable(rejected), invalid);
        assert.throws(() => target.assertUsable(rejected), invalid);
        assert.throws(() => target.readSnapshot(rejected), invalid);
        assert.throws(() => target.beginReadClose(rejected, now()), invalid);
        assert.throws(() => target.markReadClosed(rejected, now()), invalid);
      }
      assert.equal(stats, 0);
    });
    assert.deepEqual(owner.snapshots(), before); assert.deepEqual(other.snapshots(), []);
    assert.doesNotThrow(() => nativeFstat(input.fd)); releaseRead(owner, resource, f);
  });
}

test("Office read resource cannot use writer close APIs or appear in effect cleanup candidates", t => {
  const f = fixture(t), owner = new OfficeLocalResourceOwner("execution", source);
  const resource = owner.retainReadOpened(readInput(f)), effect = f.retain(owner, f.open("effect.tmp"), "effect-lifetime");
  const before = owner.snapshots(); let stats = 0;
  withFstat(original => (...args) => { stats++; return original(...args); }, () => {
    assert.throws(() => owner.beginClose(resource, "invented-read-close-effect"), invalid);
    assert.throws(() => owner.markClosed(resource), invalid);
    assert.throws(() => owner.beginReadClose(effect, now()), invalid);
    assert.throws(() => owner.markReadClosed(effect, now()), invalid);
    assert.throws(() => owner.readSnapshot(effect), invalid);
    assert.equal(stats, 0);
  });
  assert.deepEqual(owner.snapshots(), before); assert.deepEqual(owner.cleanupCandidates(), [effect]);
  owner.beginReadClose(resource, now());
  assert.throws(() => owner.beginClose(resource, "invented-read-close-effect"), invalid);
  assert.throws(() => owner.markClosed(resource), invalid);
  f.close(resource.fd); owner.markReadClosed(resource, now());
  assert.deepEqual(owner.cleanupCandidates(), [effect]); release(owner, effect, f);
});

for (const origin of ["effect", "member_read"]) {
  for (const stage of ["retained", "unknown", "closed"]) {
    test(`Office read resource lifetime cannot cross origins after ${origin} is ${stage}`, t => {
      const f = fixture(t), owner = new OfficeLocalResourceOwner("execution", source);
      const original = origin === "member_read" ? owner.retainReadOpened(readInput(f))
        : f.retain(owner, f.open("effect.tmp"), "read-lifetime");
      if (stage === "closed") {
        if (origin === "member_read") releaseRead(owner, original, f); else release(owner, original, f);
      } else if (stage === "unknown") {
        if (origin === "member_read") owner.beginReadClose(original, now()); else owner.beginClose(original, "close-unknown");
        f.close(original.fd);
      }
      const next = readInput(f, "read-lifetime", "final", "next.tmp"), before = owner.snapshots();
      assert.throws(() => owner.retainReadOpened(next), invalid);
      assert.throws(() => f.retain(owner, next.fd, "read-lifetime"), invalid);
      assert.deepEqual(owner.snapshots(), before);
      assert.doesNotThrow(() => nativeFstat(next.fd), "duplicate lifetime rejection cannot close the new unrelated handle");
      if (stage === "retained") {
        if (origin === "member_read") releaseRead(owner, original, f); else release(owner, original, f);
      }
    });
  }
}

for (const [label, change] of [
  ["invalid purpose", input => ({ ...input, purpose: "write" })],
  ["empty read ID", input => ({ ...input, readId: "" })],
  ["numeric lifetime", input => ({ ...input, resourceLifetimeId: input.fd })],
  ["noncanonical open time", input => ({ ...input, openCalledAt: "2026-10-04" })],
  ["invalid open return", input => ({ ...input, openReturnedAt: "not-a-time" })],
  ["open return before call", input => ({ ...input, openReturnedAt: instant(input.openCalledAt, -1) })],
]) {
  test(`Office read resource rejects ${label} without admitting or inspecting its FD`, t => {
    const f = fixture(t), owner = new OfficeLocalResourceOwner("execution", source), input = readInput(f);
    let stats = 0;
    withFstat(original => (...args) => { stats++; return original(...args); }, () => {
      assert.throws(() => owner.retainReadOpened(change(input)), invalid); assert.equal(stats, 0);
    });
    assert.deepEqual(owner.snapshots(), []); assert.doesNotThrow(() => nativeFstat(input.fd));
  });
}

test("Office read resource validates close times without inspecting or changing facts on rejection", t => {
  const f = fixture(t), owner = new OfficeLocalResourceOwner("execution", source), input = readInput(f), resource = owner.retainReadOpened(input);
  const retained = owner.readSnapshot(resource); let stats = 0;
  withFstat(original => (...args) => { stats++; return original(...args); }, () => {
    assert.throws(() => owner.markReadClosed(resource, now()), invalid);
    for (const at of ["not-a-time", "2026-10-04", instant(input.openReturnedAt, -1)]) {
      assert.throws(() => owner.beginReadClose(resource, at), invalid); assert.deepEqual(owner.readSnapshot(resource), retained);
    }
    owner.beginReadClose(resource, now());
    const unknown = owner.readSnapshot(resource);
    for (const at of ["not-a-time", "2026-10-04", instant(unknown.closeEnteredAt, -1)]) {
      assert.throws(() => owner.markReadClosed(resource, at), invalid); assert.deepEqual(owner.readSnapshot(resource), unknown);
    }
    f.close(input.fd); owner.markReadClosed(resource, now());
    const closed = owner.readSnapshot(resource);
    assert.throws(() => owner.beginReadClose(resource, now()), invalid);
    assert.throws(() => owner.markReadClosed(resource, now()), invalid);
    assert.deepEqual(owner.readSnapshot(resource), closed); assert.equal(stats, 0);
  });
  assert.throws(() => nativeFstat(input.fd), { code: "EBADF" });
});
