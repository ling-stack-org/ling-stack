import assert from "node:assert/strict";
import fs, { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { captureProtectedHostStagePaths } from "../dist/runtime/sandbox/protected-host-stage-paths.js";
import { captureOriginalOfficeDirectoryWindowPaths } from "../dist/runtime/sandbox/protected-host-office-directory-window.js";

// Mechanism only: actual ephemeral directories and original readonly FDs. These inputs
// are not owning Core records, genuine Host inventory, Registry membership or safe claims.
function patchFs(replacements, effect) {
  const originals = new Map(Object.keys(replacements).map(name => [name, fs[name]]));
  for (const [name, replacement] of Object.entries(replacements)) fs[name] = replacement(originals.get(name));
  syncBuiltinESMExports();
  try { return effect(); }
  finally { for (const [name, original] of originals) fs[name] = original; syncBuiltinESMExports(); }
}

function identity(path) {
  const stat = lstatSync(path, { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino), mode: Number(stat.mode),
    sizeBytes: String(stat.size), modifiedNs: String(stat.mtimeNs), changedNs: String(stat.ctimeNs),
    isDirectory: stat.isDirectory(), isFile: stat.isFile() };
}

function chain(path, role) {
  const paths = [path];
  while (dirname(paths.at(-1)) !== paths.at(-1)) paths.push(dirname(paths.at(-1)));
  return paths.reverse().map((value, index) => ({ path: value, resourceSlotId: `${role}-${index}`, identity: identity(value) }));
}

function fixture(t, { destinationIsWorkspace = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-window-mechanism-")));
  const workspace = join(root, "workspace"), stagePath = join(root, "stage");
  mkdirSync(workspace, { mode: 0o755 }); chmodSync(workspace, 0o755);
  mkdirSync(stagePath, { mode: 0o700 });
  const destinationPath = destinationIsWorkspace ? workspace : join(workspace, "reports");
  if (!destinationIsWorkspace) { mkdirSync(destinationPath, { mode: 0o755 }); chmodSync(destinationPath, 0o755); }
  const stage = captureProtectedHostStagePaths(stagePath), windows = [];
  function input(destination = destinationPath) {
    return { workspacePath: workspace, workspaceIdentity: identity(workspace),
      stage: { parentPath: stagePath, ancestors: chain(stagePath, "stage") },
      destination: { parentPath: destination, ancestors: chain(destination, "destination") } };
  }
  function capture(expected = input(), heldStage = stage) {
    const window = captureOriginalOfficeDirectoryWindowPaths(expected, heldStage);
    windows.push(window); return window;
  }
  t.after(() => {
    for (const window of windows) {
      if (window.readClosureFacts().phase === "active") try { window.closeOriginalPaths(); } catch { /* Unknown original close is never retried. */ }
    }
    try { stage.close(); } catch { /* Retain an unknown tombstone; never close a reused integer. */ }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace, stagePath, destinationPath, stage, input, capture };
}

const invalidIdentity = /protected_host_office_window_identity_invalid/u;
const allRows = facts => [...facts.stage, ...facts.destination];

// Value: protects=ordinary destination semantics; fails_when=the private-stage 0700
// requirement leaks into a canonical destination; seam=actual 0755 directory chains.
for (const destinationIsWorkspace of [false, true]) test(
  `readonly window mechanism accepts a 0755 ${destinationIsWorkspace ? "workspace itself" : "workspace child"} without granting authority`, t => {
    const f = fixture(t, { destinationIsWorkspace }), expected = f.input(), window = f.capture(expected);
    assert.equal(lstatSync(f.destinationPath).mode & 0o777, 0o755);
    window.assertCurrent();
    const facts = window.readClosureFacts();
    assert.equal(facts.phase, "active");
    for (const role of ["stage", "destination"]) {
      assert.deepEqual(facts[role].map(row => ({ path: row.path, device: row.device, inode: row.inode, mode: row.mode })),
        expected[role].ancestors.map(row => ({ path: row.path, device: row.identity.device, inode: row.identity.inode, mode: String(row.identity.mode) })));
    }
    assert.ok(allRows(facts).every(row => row.state === "retained" && row.close === "not_entered"));
    assert.deepEqual(Object.keys(window).sort(), ["assertCurrent", "closeOriginalPaths", "destination", "readClosureFacts"].sort());
  });

// Value: protects=complete original chains, not caller path/identity descriptions;
// fails_when=an expected row can substitute order, device, inode or mode.
for (const role of ["stage", "destination"]) for (const field of ["chain", "device", "inode", "mode"]) test(
  `readonly window mechanism rejects a mismatched original ${role} ${field}`, t => {
    const f = fixture(t), expected = f.input(), rows = expected[role].ancestors;
    if (field === "chain") [rows[0], rows[1]] = [rows[1], rows[0]];
    else if (field === "mode") rows.at(-1).identity.mode ^= 0o010;
    else rows.at(-1).identity[field] = String(BigInt(rows.at(-1).identity[field]) + 1n);
    assert.throws(() => f.capture(expected), invalidIdentity);
    f.stage.assertCurrent(); // A refused destination capture must not close the borrowed stage set.
  });

test("readonly window mechanism rejects a workspace identity detached from its destination chain", t => {
  const f = fixture(t), expected = f.input();
  expected.workspaceIdentity.inode = String(BigInt(expected.workspaceIdentity.inode) + 1n);
  assert.throws(() => f.capture(expected), invalidIdentity);
  f.stage.assertCurrent();
});

// Value: protects=directory publication may change size/timestamps without retargeting
// original FD identities; seam=real writes and deterministic timestamp changes.
test("readonly window mechanism permits real directory timestamp changes but retains its first identities", t => {
  const f = fixture(t), expected = f.input(), window = f.capture(expected), before = window.readClosureFacts();
  for (const path of [f.stagePath, f.destinationPath]) {
    writeFileSync(join(path, "actual-entry"), "directory contents changed");
    utimesSync(path, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-02T00:00:00Z"));
    assert.notEqual(identity(path).modifiedNs, expected[path === f.stagePath ? "stage" : "destination"].ancestors.at(-1).identity.modifiedNs);
  }
  window.assertCurrent(); assert.deepEqual(window.readClosureFacts(), before);
});

// Value: protects=the first mode seal and current mode agree; fails_when=chmod can be
// repaired by rewriting supplied input after capture; seam=real chmod, no mocked stat.
for (const role of ["stage", "destination"]) test(
  `readonly window mechanism rejects live ${role} mode drift despite rewritten caller input`, t => {
    const f = fixture(t), expected = f.input(), window = f.capture(expected);
    const path = role === "stage" ? f.stagePath : f.destinationPath;
    chmodSync(path, role === "stage" ? 0o755 : 0o700);
    expected[role].ancestors.at(-1).identity = identity(path);
    assert.throws(() => window.assertCurrent(), invalidIdentity);
    window.closeOriginalPaths(); assert.equal(window.readClosureFacts().phase, "closed_pending");
  });

test("readonly window mechanism cannot reseal an old stage FD set with a newly matching expected mode", t => {
  const f = fixture(t), first = f.stage.readTerminalClosureFacts();
  chmodSync(f.stagePath, 0o755);
  const newlyMatching = f.input();
  assert.equal(newlyMatching.stage.ancestors.at(-1).identity.mode & 0o777, 0o755);
  assert.equal(Number(first.at(-1).mode) & 0o777, 0o700);
  assert.throws(() => f.capture(newlyMatching), invalidIdentity);
  assert.deepEqual(f.stage.readTerminalClosureFacts(), first);
});

// Value: protects=canonical pathname replacement cannot adopt a new inode; cleanup
// still closes originals, not replacements; seam=real rename and mkdir.
for (const role of ["stage", "destination"]) test(
  `readonly window mechanism rejects a replaced ${role} inode and still closes original paths`, t => {
    const f = fixture(t), window = f.capture(), before = window.readClosureFacts();
    const path = role === "stage" ? f.stagePath : f.destinationPath;
    renameSync(path, path + "-original"); mkdirSync(path, { mode: role === "stage" ? 0o700 : 0o755 });
    assert.notEqual(identity(path).inode, before[role].at(-1).inode);
    assert.throws(() => window.assertCurrent(), /protected_host_stage_identity_changed/u);
    window.closeOriginalPaths();
    const after = window.readClosureFacts(); assert.equal(after.phase, "closed_pending");
    for (const currentRole of ["stage", "destination"]) {
      assert.deepEqual(after[currentRole], before[currentRole].map(row => ({ ...row, state: "closed", close: "returned" })));
    }
  });

test("readonly window mechanism rejects another directory's stage chain without consuming its FDs", t => {
  const f = fixture(t), other = fixture(t);
  assert.throws(() => f.capture(f.input(), other.stage), invalidIdentity);
  f.stage.assertCurrent(); other.stage.assertCurrent();
});

test("readonly window mechanism rejects an ordinary destination outside its workspace", t => {
  const f = fixture(t), outside = join(f.root, "outside"); mkdirSync(outside, { mode: 0o755 });
  assert.throws(() => f.capture(f.input(outside)), invalidIdentity);
  f.stage.assertCurrent();
});

test("readonly window mechanism keeps independent expected chains when caller input is mutated", t => {
  const f = fixture(t), expected = f.input(), window = f.capture(expected), before = window.readClosureFacts();
  expected.stage.ancestors[0].identity.inode = "caller-replacement";
  expected.destination.ancestors.length = 0;
  expected.destination.parentPath = "/";
  window.assertCurrent(); assert.deepEqual(window.readClosureFacts(), before);
});

// Value: protects=shared ancestor pathnames still have separate original FD lifetimes;
// fails_when=path dedup drops a close or post-close readers perform filesystem I/O.
test("readonly window mechanism closes both overlapping ancestor FD sets once and reads closed_pending without filesystem I/O", t => {
  const opened = [], calls = [];
  const { f, window } = patchFs({ openSync: original => (...args) => {
    const fd = original(...args); opened.push({ path: args[0], fd }); return fd;
  } }, () => { const f = fixture(t); return { f, window: f.capture() }; });
  const before = window.readClosureFacts(), stagePaths = new Set(before.stage.map(row => row.path));
  const overlapping = before.destination.filter(row => stagePaths.has(row.path));
  assert.ok(overlapping.length > 0);
  for (const row of overlapping) assert.equal(opened.filter(item => item.path === row.path).length, 2);
  assert.equal(opened.length, allRows(before).length); assert.equal(new Set(opened.map(row => row.fd)).size, opened.length);
  patchFs({ closeSync: original => fd => { calls.push(fd); original(fd); } }, () => window.closeOriginalPaths());
  assert.deepEqual([...calls].sort((a, b) => a - b), opened.map(row => row.fd).sort((a, b) => a - b));
  const rejectIo = () => () => { assert.fail("closed_pending history must not reopen, stat or close a pathname/FD"); };
  const after = patchFs({ openSync: rejectIo, fstatSync: rejectIo, lstatSync: rejectIo,
    realpathSync: rejectIo, closeSync: rejectIo }, () => {
    const facts = window.readClosureFacts();
    assert.throws(() => window.assertCurrent(), invalidIdentity);
    assert.throws(() => window.closeOriginalPaths(), /protected_host_office_window_close_already_entered/u);
    return facts;
  });
  assert.equal(after.phase, "closed_pending");
  assert.ok(Object.isFrozen(after) && Object.isFrozen(after.stage) && Object.isFrozen(after.destination));
  assert.ok(allRows(after).every(row => Object.isFrozen(row) && row.state === "closed" && row.close === "returned"));
  assert.ok(allRows(before).every(row => row.state === "retained" && row.close === "not_entered"));
  for (const role of ["stage", "destination"]) assert.deepEqual(after[role], before[role].map(row => ({ ...row, state: "closed", close: "returned" })));
  assert.throws(() => { after.stage[0].state = "retained"; }, TypeError);
  assert.equal(f.stage.readTerminalClosureFacts().length, before.stage.length);
});

test("readonly window mechanism latches close_entered before real close and rejects reentrant close", t => {
  const f = fixture(t), window = f.capture(), seen = [], calls = [];
  patchFs({ closeSync: original => fd => {
    calls.push(fd);
    const facts = window.readClosureFacts(); seen.push(facts);
    assert.equal(facts.phase, "close_entered");
    assert.equal(allRows(facts).filter(row => row.state === "unknown" && row.close === "unknown").length, 1);
    assert.throws(() => window.closeOriginalPaths(), /protected_host_office_window_close_already_entered/u);
    original(fd);
  } }, () => window.closeOriginalPaths());
  assert.equal(seen.length, allRows(window.readClosureFacts()).length);
  assert.equal(new Set(calls).size, calls.length);
  assert.equal(window.readClosureFacts().phase, "closed_pending");
});

// Value: protects=actual close return loss stays unknown, never retrying a foreign
// reused integer; both original sets drain despite the first set's failure.
test("readonly window mechanism keeps actual close return loss unknown while closing every other original FD once", t => {
  const f = fixture(t), window = f.capture(), before = window.readClosureFacts(), calls = [];
  let victim, foreign;
  t.after(() => { if (foreign !== undefined) fs.closeSync(foreign); });
  patchFs({ closeSync: original => fd => {
    calls.push(fd); original(fd);
    if (foreign === undefined) {
      victim = fd; foreign = fs.openSync("/dev/null", fs.constants.O_RDONLY);
      assert.equal(foreign, victim);
      throw Object.assign(new Error("actual original close return lost"), { code: "EIO" });
    }
  } }, () => {
    assert.throws(() => window.closeOriginalPaths(), /protected_host_office_window_close_unknown/u);
    const after = window.readClosureFacts(), count = calls.length;
    assert.equal(after.phase, "unknown"); assert.equal(count, allRows(before).length);
    assert.equal(new Set(calls).size, count);
    assert.equal(allRows(after).filter(row => row.state === "unknown" && row.close === "unknown").length, 1);
    assert.equal(allRows(after).filter(row => row.state === "closed" && row.close === "returned").length, count - 1);
    assert.ok(after.stage.every(row => row.state === "closed" && row.close === "returned"));
    assert.throws(() => window.closeOriginalPaths(), /protected_host_office_window_close_already_entered/u);
    assert.equal(calls.length, count); assert.deepEqual(window.readClosureFacts(), after);
  });
  const rejectIo = () => () => { assert.fail("unknown closure history must not issue filesystem I/O"); };
  const facts = patchFs({ openSync: rejectIo, fstatSync: rejectIo, lstatSync: rejectIo,
    realpathSync: rejectIo, closeSync: rejectIo }, () => window.readClosureFacts());
  assert.equal(facts.phase, "unknown"); assert.ok(fs.fstatSync(foreign).isCharacterDevice());
});
