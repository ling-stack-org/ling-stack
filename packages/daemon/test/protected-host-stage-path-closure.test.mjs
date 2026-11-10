import assert from "node:assert/strict";
import fs, { mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureProtectedHostStagePaths } from "../dist/runtime/sandbox/protected-host-stage-paths.js";

function patchFs(replacements, effect) {
  const originals = new Map(Object.keys(replacements).map(name => [name, fs[name]]));
  for (const [name, replacement] of Object.entries(replacements)) fs[name] = replacement(originals.get(name));
  syncBuiltinESMExports();
  try { return effect(); }
  finally { for (const [name, original] of originals) fs[name] = original; syncBuiltinESMExports(); }
}

function capture(t) {
  const stage = realpathSync(mkdtempSync(join(tmpdir(), "ling-stage-close-facts-")));
  t.after(() => rmSync(stage, { recursive: true, force: true }));
  const paths = captureProtectedHostStagePaths(stage);
  t.after(() => { try { paths.close(); } catch {} });
  return { stage, paths };
}

// Value: protects=original readonly custody observations; fails_when=close facts reopen/stat
// pathnames or expose reusable FD integers; why_new=Core settlement needs post-close history;
// seam=real filesystem descriptors, no native/bootstrap/inventory substitute.
test("original path closure facts are immutable snapshots with no FD, reopening or post-close stat", t => {
  const { paths } = capture(t), identity = paths.identityFacts();
  const before = paths.readTerminalClosureFacts();
  assert.ok(Object.isFrozen(before));
  assert.equal(before.length, identity.length);
  before.forEach((fact, index) => {
    assert.ok(Object.isFrozen(fact));
    assert.deepEqual(Object.keys(fact).sort(), ["path", "device", "inode", "uid", "mode", "acquisition", "firstIdentity", "state", "close"].sort());
    assert.deepEqual({ path: fact.path, device: fact.device, inode: fact.inode, uid: fact.uid, mode: fact.mode }, identity[index]);
    assert.equal(fact.acquisition, "returned"); assert.equal(fact.firstIdentity, "matched");
    assert.equal(fact.state, "retained"); assert.equal(fact.close, "not_entered");
  });
  paths.close();
  const rejectIo = () => () => { assert.fail("closure history must not issue filesystem I/O"); };
  const after = patchFs({ openSync: rejectIo, fstatSync: rejectIo, lstatSync: rejectIo,
    realpathSync: rejectIo, closeSync: rejectIo }, () => paths.readTerminalClosureFacts());
  assert.ok(after.every(fact => fact.state === "closed" && fact.close === "returned"));
  assert.ok(before.every(fact => fact.state === "retained" && fact.close === "not_entered"));
  assert.throws(() => { after[0].state = "retained"; }, TypeError);
  assert.throws(() => paths.assertCurrent(), /protected_host_stage_identity_changed/u);
});

// Value: protects=close-entry linearization; fails_when=a reentrant reader sees returned
// before the original syscall returns; why_new=the Core bridge must not infer completion
// from a tombstoned slot; seam=actual close with a synchronous read at its entry boundary.
test("closure facts tombstone an entered close before exposing its eventual return", t => {
  const { paths } = capture(t), seen = [];
  patchFs({ closeSync: original => fd => {
    const facts = paths.readTerminalClosureFacts();
    assert.equal(facts.filter(fact => fact.state === "unknown" && fact.close === "unknown").length, 1);
    assert.ok(facts.every(fact => fact.close !== "returned" || fact.state === "closed"));
    seen.push(facts); original(fd);
  } }, () => paths.close());
  assert.equal(seen.length, paths.readTerminalClosureFacts().length);
  assert.ok(paths.readTerminalClosureFacts().every(fact => fact.state === "closed" && fact.close === "returned"));
  assert.ok(seen.every(facts => facts.some(fact => fact.state === "unknown" && fact.close === "unknown")));
});

// Value: protects=unknown-close does not become closed/retry; fails_when=returned error is
// repaired from pathname or reused descriptor; why_new=separate call result from FD state;
// seam=one actual close followed by injected return loss and a real foreign FD reuse.
test("closure facts retain unknown first close after actual close return loss and foreign reuse", t => {
  const { paths } = capture(t), calls = []; let victim, foreign;
  t.after(() => { if (foreign !== undefined) fs.closeSync(foreign); });
  patchFs({ closeSync: original => fd => {
    calls.push(fd); original(fd);
    if (foreign === undefined) {
      victim = fd; foreign = fs.openSync("/dev/null", fs.constants.O_RDONLY);
      assert.equal(foreign, victim);
      throw Object.assign(new Error("original close return lost"), { code: "EIO" });
    }
  } }, () => {
    assert.throws(() => paths.close(), /protected_host_stage_close_unknown/u);
    const firstCount = calls.length, first = paths.readTerminalClosureFacts();
    assert.equal(first.filter(fact => fact.state === "unknown" && fact.close === "unknown").length, 1);
    assert.equal(first.filter(fact => fact.state === "closed" && fact.close === "returned").length, first.length - 1);
    assert.throws(() => paths.close(), /protected_host_stage_close_unknown/u);
    assert.equal(calls.length, firstCount);
    assert.deepEqual(paths.readTerminalClosureFacts(), first);
  });
  assert.equal(new Set(calls).size, calls.length);
  assert.ok(fs.fstatSync(foreign).isCharacterDevice());
});

// Value: protects=lost/reused descriptor is not an original close result; fails_when=state
// unknown is silently reported as returned close; why_new=closure verifier needs both axes;
// seam=actual EBADF or inode reuse, real original cleanup of all other descriptors.
for (const failure of ["EBADF", "reused_inode"]) test("closure facts distinguish lost original FD from entered close: " + failure, t => {
  const opened = [], calls = [];
  const { paths } = patchFs({ openSync: original => (...args) => {
    const fd = original(...args); opened.push(fd); return fd;
  } }, () => capture(t));
  const victim = opened.at(-1); fs.closeSync(victim); let foreign;
  t.after(() => { if (foreign !== undefined) fs.closeSync(foreign); });
  if (failure === "reused_inode") { foreign = fs.openSync("/dev/null", fs.constants.O_RDONLY); assert.equal(foreign, victim); }
  assert.throws(() => paths.assertCurrent(), failure === "EBADF" ? /EBADF/u : /protected_host_stage_identity_changed/u);
  if (foreign === undefined) { foreign = fs.openSync("/dev/null", fs.constants.O_RDONLY); assert.equal(foreign, victim); }
  patchFs({ closeSync: original => fd => { calls.push(fd); original(fd); } }, () => {
    assert.throws(() => paths.close(), /protected_host_stage_close_unknown/u);
  });
  const facts = paths.readTerminalClosureFacts();
  assert.equal(facts.at(-1).state, "unknown"); assert.equal(facts.at(-1).close, "not_entered");
  assert.ok(facts.slice(0, -1).every(fact => fact.state === "closed" && fact.close === "returned"));
  assert.equal(calls.includes(victim), false);
  assert.equal(new Set(calls).size, opened.length - 1);
  assert.ok(fs.fstatSync(foreign).isCharacterDevice());
});

// Value: protects=path displacement does not mint live/creator/Core authority; fails_when=
// history reads a replacement inode or blocks original cleanup; why_new=post-close facts are
// historical only; seam=real rename, no replacement path adopted.
test("path displacement does not change captured identity or prevent original close facts", t => {
  const { stage, paths } = capture(t), before = paths.readTerminalClosureFacts(), displaced = stage + "-displaced";
  t.after(() => rmSync(displaced, { recursive: true, force: true }));
  renameSync(stage, displaced);
  assert.throws(() => paths.assertCurrent(), error => error.code === "ENOENT");
  paths.close();
  assert.deepEqual(paths.readTerminalClosureFacts(), before.map(fact => ({ ...fact, state: "closed", close: "returned" })));
});
