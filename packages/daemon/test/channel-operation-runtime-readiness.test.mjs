import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { channelOperationPlanFingerprintV1 } from "../../contracts/dist/index.js";
import { createSqliteRunStore } from "../../core/dist/index.js";
import { PiRunnerAdapter } from "../../runner-pi/dist/index.js";
import { createRunnerRegistry } from "../dist/runtime/runners.js";
import { assertChannelOperationRunnerReady, assertChannelOperationRuntimeReady } from "../dist/features/channels/channel-operation-runtime-readiness.js";
import { typedOperation } from "./support/workflow-operation-gate-fixture.mjs";

const plan = (...operations) => ({ bindingVersion: 1, operations, fingerprint: channelOperationPlanFingerprintV1(operations) });
const read = { ...typedOperation("file_read", "input.txt"), id: "read" };
const create = { ...typedOperation("file_create", "output.txt"), id: "create", dependsOn: ["read"] };
const owners = new Map([["read", 0], ["create", 1]]);
const blocked = (callback) => assert.throws(callback, (error) => error.code === "operation_binding_runtime_not_ready");

test("verified read and exclusive create preserve the declared dependency graph", () => {
  assert.doesNotThrow(() => assertChannelOperationRuntimeReady(plan(read, create), owners));
  assert.doesNotThrow(() => assertChannelOperationRuntimeReady(plan(read, create), new Map([["read", 0], ["create", 0]])));
});

test("unverified command, unavailable open, and edit effects retain the interlock", () => {
  for (const kind of ["run_command", "open_local_target", "file_edit"]) {
    blocked(() => assertChannelOperationRuntimeReady(plan({ ...read, kind }), owners));
  }
});

test("Host open becomes ready only with its independent connected executor and closed effect scope", () => {
  const open = { ...typedOperation("open_local_target", "index.html"), id: "open" };
  assert.doesNotThrow(() => assertChannelOperationRuntimeReady(
    plan(open),
    new Map([["open", 0]]),
    undefined,
    (capabilityId) => capabilityId === "host.open_local_target",
  ));
  blocked(() => assertChannelOperationRuntimeReady(
    plan({ ...open, binding: { ...open.binding, effectScope: { ...open.binding.effectScope, allowNetworkAccess: true } } }),
    new Map([["open", 0]]),
    undefined,
    () => true,
  ));
});

test("all-optional and mixed optional typed plans cannot downgrade to legacy", () => {
  blocked(() => assertChannelOperationRuntimeReady(plan({ ...read, required: false }), owners));
  blocked(() => assertChannelOperationRuntimeReady(plan(read, { ...create, required: false }), owners));
});

test("missing binding and future or missing dependency owners fail closed", () => {
  blocked(() => assertChannelOperationRuntimeReady(plan({ ...read, binding: undefined }), owners));
  blocked(() => assertChannelOperationRuntimeReady(plan(read, create), new Map([["read", 1], ["create", 0]])));
  blocked(() => assertChannelOperationRuntimeReady(plan(read, create), new Map([["create", 0]])));
});

test("legacy plans keep their existing routing", () => {
  assert.doesNotThrow(() => assertChannelOperationRuntimeReady(undefined, new Map()));
  assert.doesNotThrow(() => assertChannelOperationRuntimeReady({ operations: [{ kind: "run_command", required: false }] }, new Map()));
});

test("tampered fingerprints and duplicate effect candidates remain blocked", () => {
  blocked(() => assertChannelOperationRuntimeReady({ ...plan(read), fingerprint: "tampered" }, owners));
  blocked(() => assertChannelOperationRuntimeReady({ ...plan(read), bindingVersion: undefined }, owners));
  blocked(() => assertChannelOperationRuntimeReady(plan(read, { ...read, id: "read-again" }), new Map([["read", 0], ["read-again", 0]])));
  blocked(() => assertChannelOperationRuntimeReady(plan(read, create, { ...create, id: "create-again" }), new Map([...owners, ["create-again", 0]])));
});

test("runner readiness trusts the actual Pi gate, not registry capability claims", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-operation-runner-readiness-"));
  const store = createSqliteRunStore(cwd);
  t.after(async () => { store.close(); await rm(cwd, { recursive: true, force: true }); });
  const participants = [{ teammate: store.getAiTeammate("teammate_builtin_engineer") }];
  for (const adapter of [{ runTask() { throw new Error("must not execute"); } }, new PiRunnerAdapter()]) {
    const runnerRegistry = createRunnerRegistry([{ id: "pi", displayName: "Untrusted claims", status: "enabled", adapter,
      capabilities: ["workflow_operation_scope", "universal_before_tool"] }]);
    const check = () => assertChannelOperationRunnerReady({ plan: plan(read), store, runnerRegistry, participants });
    if (adapter instanceof PiRunnerAdapter) assert.doesNotThrow(check);
    else assert.throws(check, { code: "operation_binding_runner_gate_unavailable" });
  }
  assert.throws(() => assertChannelOperationRunnerReady({ plan: plan(read), store, participants }), { code: "operation_binding_runner_gate_unavailable" });
  assert.equal(store.listTasks({ limit: 20 }).length, 0);
  assert.equal(store.listRuns({ limit: 20 }).length, 0);
});
