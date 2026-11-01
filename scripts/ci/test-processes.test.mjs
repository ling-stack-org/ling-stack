import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { trackTestProcesses } from "./test-processes.mjs";

function fixture(t, initial) {
  let table = initial;
  let tagged = new Set([101]);
  const signals = [];
  t.mock.method(childProcess, "execFileSync", (_command, args) => args[0] === "-axo"
    ? table.map(entry => `${entry.pid} ${entry.parent ?? 1} ${entry.group} S ${entry.started}`).join("\n")
    : [...tagged].map(pid => `${pid} node LING_STACK_CI_TEST_OWNER=fixture-owner`).join("\n"));
  t.mock.method(process, "kill", (pid, signal) => { signals.push({ pid, signal }); return true; });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { tracker: trackTestProcesses(101, "fixture-owner"), signals,
    update(next, tags = []) { table = next; tagged = new Set(tags); } };
}

test("a recycled orphan process group is not evidence of test ownership", t => {
  const f = fixture(t, [{ pid: 101, group: 101, started: "original" }]);
  assert.deepEqual(f.tracker.live(true).map(entry => entry.pid), [101]);
  f.update([{ pid: 202, group: 101, started: "unrelated" }]);
  f.tracker.signal("SIGKILL");
  assert.deepEqual(f.signals, []);
});

test("a replacement root PID does not inherit the previous root's ownership", t => {
  const f = fixture(t, [{ pid: 101, group: 101, started: "original" }]);
  f.tracker.live(true);
  f.update([{ pid: 101, group: 101, started: "replacement" }, { pid: 202, group: 101, started: "replacement-child" }]);
  f.tracker.signal("SIGKILL");
  assert.deepEqual(f.signals, []);
});

test("a root PID seen only after replacement cannot prove ownership without its tag", t => {
  const f = fixture(t, []);
  f.update([{ pid: 101, group: 101, started: "unrelated" }]);
  f.tracker.signal("SIGKILL");
  assert.deepEqual(f.signals, []);
});

test("observed detached descendants retain ownership after reparenting with a cleared environment", t => {
  const f = fixture(t, [{ pid: 101, group: 101, started: "original" }, { pid: 202, parent: 101, group: 202, started: "child" }]);
  assert.deepEqual(f.tracker.live(true).map(entry => entry.pid), [101, 202]);
  f.update([{ pid: 202, group: 202, started: "child" }, { pid: 303, group: 303, started: "spectator" }]);
  f.tracker.signal("SIGKILL");
  assert.deepEqual(f.signals, [{ pid: 202, signal: "SIGKILL" }]);
});

test("an inherited ownership tag finds detached descendants even after an unobserved root exit", t => {
  const f = fixture(t, []);
  f.update([{ pid: 202, group: 202, started: "child" }], [202]);
  f.tracker.signal("SIGTERM");
  assert.deepEqual(f.signals, [{ pid: 202, signal: "SIGTERM" }]);
});

test("inspection errors do not expose process environments", t => {
  fixture(t, []);
  t.mock.method(childProcess, "execFileSync", () => {
    throw Object.assign(new Error("private-process-environment"), { stdout: "private-process-environment", stderr: "private-process-environment" });
  });
  syncBuiltinESMExports();
  assert.throws(() => trackTestProcesses(101, "fixture-owner").live(true), error => {
    assert.equal(error.message, "Unable to inspect CI-owned test processes");
    assert.equal(error.cause, undefined);
    assert.equal(error.stdout, undefined);
    return true;
  });
});
