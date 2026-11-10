import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveSessionRunPolicy } from "@ling-stack/core";
import { AttemptHostOperationTracker } from "../dist/runtime/attempt-host-operation-tracker.js";
import { NativeRestrictedCommandRuntime } from "../dist/runtime/sandbox/restricted-command-runtime.js";
import { createUnifiedExecFixture } from "./support/unified-exec-fixture.mjs";
import { createRestrictedCommandFixture } from "./support/restricted-command-fixture.mjs";

const required = { kind: "user_input_required", requestId: "pause", requestVersion: 1 };
const options = { skip: process.platform !== "darwin" };
async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "ling-command-native-tracker-")));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const task = { id: "native-task", title: "Native command prepare", prompt: "Isolated native preparation" };
  const f = createUnifiedExecFixture(t, cwd, task, "native-run");
  const source = { runId: f.run.id, ...f.sourceFence };
  const tracker = new AttemptHostOperationTracker({ store: f.store, source });
  const handle = tracker.beginHostCall("command", "native-call");
  const host = tracker.commandOperation(handle);
  const preparation = host.registerPreparation("native-input-copy");
  const pin = path => {
    const actual = realpathSync(path);
    return { path: actual, sha256: createHash("sha256").update(readFileSync(actual)).digest("hex") };
  };
  // System true is finite-lived and deliberately cannot produce the input
  // protocol. Its failure exercises an actual spawned helper, never fake success.
  const runtime = new NativeRestrictedCommandRuntime({ inputHelper: { ...pin("/usr/bin/true"), version: "native-test" },
    executables: { echo: pin("/bin/echo") } });
  const policy = resolveSessionRunPolicy({ workspacePolicy: f.store.getApprovalPolicy(),
    authorizationMode: "always", workspaceAccessMode: "workspace_write" }).snapshot;
  const input = { command: "echo native", cwd, inputRefs: [], policy,
    source: { ...source, workspaceId: f.store.getApprovalPolicy().workspaceId, toolCallId: "native-call" },
    assertCurrentAuthority() { assert.equal(f.store.isCurrentRunExecutionOwner(f.run.id, f.sourceFence), true); },
    hostOperation: preparation };
  const child = () => tracker.executorGroup.getSnapshot().operations.find(row => row.ticket.parentId === handle.operationId);
  return { ...f, cwd, runtime, tracker, host, handle, preparation, input, child, group: tracker.executorGroup };
}

test("real restricted preparation directories are guarded and callback return cannot prove physical drain", options, async t => {
  const f = await fixture(t);
  let forwardEffects = 0, cleanupEffects = 0;
  const prepared = await f.runtime.prepare({ ...f.input, hostOperation: { ...f.preparation, effectGuard: {
    launch(effect) { forwardEffects++; return f.preparation.effectGuard.launch(effect); },
    cleanup(effect) { cleanupEffects++; return f.preparation.effectGuard.cleanup(effect); },
  } } });
  const root = dirname(prepared.evidence.executionCwd);
  assert.match(root, /^\/private\/tmp\/ling-command-/);
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(forwardEffects, 2, "both root creation and workspace/scratch creation use captured gates");
  assert.equal(existsSync(prepared.evidence.executionCwd), true);
  assert.equal(f.store.getHostOperation(f.child().ticket.id).phase, "launched");
  prepared.dispose();
  assert.equal(cleanupEffects, 1);
  assert.equal(existsSync(root), false);
  f.preparation.finish();
  assert.equal(f.store.getHostOperation(f.child().ticket.id).phase, "unknown_outcome");
  assert.throws(() => f.host.settleNoStart(), /evidence.*invalid/);
  f.host.markUnknown("command_physical_scope_unverified");
  f.group.closeAdmission(required);
  assert.equal((await f.group.drain()).blockers.length, 2);
});

test("closed admission prevents even temporary root creation before native preparation", options, async t => {
  const f = await fixture(t); f.group.closeAdmission(required);
  let effects = 0;
  await assert.rejects(f.runtime.prepare({ ...f.input, hostOperation: { ...f.preparation, effectGuard: {
    launch(effect) { return f.preparation.effectGuard.launch(() => { effects++; return effect(); }); },
    cleanup() { assert.fail("nothing was launched"); },
  } } }), /admission.*closed/);
  assert.equal(effects, 0);
  f.preparation.finish(); f.host.settleNoStart();
  assert.equal((await f.group.drain()).status, "settled");
});

test("closure after actual root creation blocks later mkdir and permits only original-source cleanup", options, async t => {
  const f = await fixture(t);
  let root, forwardEffects = 0, cleanupEffects = 0;
  await assert.rejects(f.runtime.prepare({ ...f.input, hostOperation: { ...f.preparation, effectGuard: {
    launch(effect) {
      const value = f.preparation.effectGuard.launch(effect);
      if (++forwardEffects === 1) {
        root = value;
        assert.match(root, /^\/private\/tmp\/ling-command-/);
        f.group.closeAdmission(required);
      }
      return value;
    },
    cleanup(effect) { cleanupEffects++; return f.preparation.effectGuard.cleanup(effect); },
  } } }), /admission.*closed/);
  assert.equal(forwardEffects, 1);
  assert.equal(cleanupEffects, 1);
  assert.equal(existsSync(root), false);
  f.preparation.finish(); f.host.markUnknown("command_physical_scope_unverified");
  assert.equal((await f.group.drain()).status, "blocked");
});

test("actual native input helper protocol failure stays unknown and cannot hide under main no-start", options, async t => {
  const f = await fixture(t);
  writeFileSync(join(f.cwd, "input.txt"), "authorized input", "utf8");
  let forwardEffects = 0, cleanupEffects = 0, root;
  await assert.rejects(f.runtime.prepare({ ...f.input,
    inputRefs: [{ path: "input.txt", sourceRefs: [{ itemId: "source-item", quote: "Read this input" }] }],
    hostOperation: { ...f.preparation, effectGuard: {
      launch(effect) {
        const value = f.preparation.effectGuard.launch(effect);
        if (++forwardEffects === 1) { root = value; assert.match(root, /^\/private\/tmp\/ling-command-/); }
        return value;
      },
      cleanup(effect) { cleanupEffects++; return f.preparation.effectGuard.cleanup(effect); },
    } },
  }), /native_input_/);
  assert.ok(forwardEffects >= 4, "directory creation, actual helper spawn and framed request send are gated");
  assert.equal(cleanupEffects, 1, "copy preparation cleans up only its own concrete temporary root");
  assert.equal(existsSync(root), false);
  f.preparation.finish();
  assert.equal(f.store.getHostOperation(f.child().ticket.id).code, "command_preparation_scope_unverified");
  assert.throws(() => f.host.settleNoStart(), /evidence.*invalid/);
  f.host.markUnknown("command_physical_scope_unverified");
  f.group.closeAdmission(required);
  assert.equal((await f.group.drain()).blockers.length, 2);
});

test("production approval to restricted command keeps native producer and command identities separately blocked", options, async t => {
  const f = await createRestrictedCommandFixture(t, "echo native");
  const pin = path => {
    const actual = realpathSync(path);
    return { path: actual, sha256: createHash("sha256").update(readFileSync(actual)).digest("hex") };
  };
  const runtime = new NativeRestrictedCommandRuntime({ inputHelper: { ...pin("/usr/bin/true"), version: "native-test" },
    executables: { echo: pin("/bin/echo") } });
  const source = { runId: f.run.id, ...f.sourceFence };
  const tracker = new AttemptHostOperationTracker({ store: f.store, source });
  const result = await f.approve(runtime, () => {}, { hostOperationTracker: tracker });
  assert.equal(result.approved, true);
  assert.equal(result.handledResult.details.unifiedExec.status, "succeeded");
  assert.equal(result.handledResult.details.unifiedExec.processObservation.descendants, "unverified");
  const rows = f.store.listHostOperationBlockers(source);
  assert.equal(rows.length, 2);
  const main = rows.find(row => !row.parentOperationId), producer = rows.find(row => row.parentOperationId);
  assert.equal(producer.parentOperationId, main.operationId);
  assert.equal(producer.producerId, "restricted-command-prepare");
  assert.equal(main.evidenceRef.kind, "host_command");
  assert.equal(main.code, "command_physical_scope_unverified");
  assert.equal(producer.code, "command_preparation_scope_unverified");
  const settled = f.store.listEvents(f.run.id).find(event => event.type === "host_command_settled");
  assert.equal(settled.data.outcome, "completed", "ordinary H2 execution result is not relabeled as cancellation");
  tracker.executorGroup.closeAdmission(required);
  assert.equal((await tracker.executorGroup.drain()).status, "blocked");
});
