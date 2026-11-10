import assert from "node:assert/strict";
import test from "node:test";
import { HostCapabilityBridgeController } from "../dist/features/runs/host-capability-bridge-controller.js";

const authority = { desktopInstanceId: "desktop-1", generation: 1 };

test("Host bridge requires claim and begin before accepting a matching receipt", async () => {
  const bridge = new HostCapabilityBridgeController({ commandTimeoutMs: 1_000 });
  bridge.publishAvailability(availability(authority));
  const execution = bridge.executeOpenLocalTarget(executionInput());
  const command = await bridge.claim(authority);
  assert.ok(command);
  bridge.begin(authority, command.id);
  const result = success(command);
  bridge.complete(authority, result);
  assert.equal((await execution).receiptId, "receipt-1");
  assert.doesNotThrow(() => bridge.complete(authority, result), "lost HTTP acknowledgements may retry the same result");
  assert.throws(
    () => bridge.complete(authority, { ...result, receipt: { ...result.receipt, receiptId: "conflict" } }),
    /host_capability_result_conflict/u,
  );
  bridge.close();
});

test("Host bridge fences authority replacement and cancellation", async () => {
  const bridge = new HostCapabilityBridgeController({ commandTimeoutMs: 1_000 });
  bridge.publishAvailability(availability(authority));
  const replacementExecution = bridge.executeOpenLocalTarget(executionInput({ idempotencyKey: "replacement" }));
  await bridge.claim(authority);
  bridge.publishAvailability(availability({ desktopInstanceId: "desktop-2", generation: 2 }));
  await assert.rejects(replacementExecution, /host_capability_authority_replaced/u);

  const replacement = { desktopInstanceId: "desktop-2", generation: 2 };
  const controller = new AbortController();
  const cancelledExecution = bridge.executeOpenLocalTarget(executionInput({ idempotencyKey: "cancelled", signal: controller.signal }));
  const command = await bridge.claim(replacement);
  assert.ok(command);
  controller.abort();
  await assert.rejects(cancelledExecution, /host_capability_cancelled/u);
  assert.throws(() => bridge.begin(replacement, command.id), /host_capability_command_not_found/u);
  bridge.close();
});

function availability(value) {
  return {
    protocol: "ling-host-capability-bridge/v1",
    ...value,
    capabilities: ["host.open_local_target"],
    checkedAt: "2026-09-10T00:00:00.000Z",
  };
}

function executionInput(overrides = {}) {
  return {
    path: "index.html",
    absolutePath: "/tmp/workspace/index.html",
    workspaceRoot: "/tmp/workspace",
    presentation: "interactive_html",
    runId: "run-1",
    attemptId: "attempt-1",
    toolCallId: "tool-1",
    approvalId: "approval-1",
    idempotencyKey: "idempotency-1",
    ...overrides,
  };
}

function success(command) {
  return {
    protocol: "ling-host-capability-bridge/v1",
    id: command.id,
    ok: true,
    receipt: {
      contractVersion: 1,
      capabilityId: "host.open_local_target",
      status: "launched",
      path: command.path,
      runId: command.runId,
      attemptId: command.attemptId,
      toolCallId: command.toolCallId,
      approvalId: command.approvalId,
      receiptId: "receipt-1",
      launchedAt: "2026-09-10T00:00:01.000Z",
      visibility: "unverified",
    },
  };
}
