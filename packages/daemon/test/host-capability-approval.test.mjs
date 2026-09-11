import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { hostAuthorityFixture } from "./support/host-capability-authority-fixture.mjs";

test("Host approval remains separate from allowed Bash/read/MCP defaults and survives SQLite reopen", async t => {
  const f = await hostAuthorityFixture(t);
  const { cwd, store, attempt } = f;
  let observed;
  const handler = f.handler({
    appendAndMaybeStream(type, data) {
      const event = store.appendExecutionEvent(f.run.id, f.sourceFence, type, data);
      if (type === "approval_requested") {
        observed = store.getApprovalRequest(data.approvalId);
        assert.equal(observed.status, "pending");
        assert.equal(observed.actionType, "host_capability");
        assert.equal(observed.payload.capabilityId, "host.open_local_target");
        assert.deepEqual(observed.payload.input, { path: "index.html" });
        assert.equal(observed.availableDecisions?.includes("approve_command_rule") ?? false, false);
        store.approveApprovalRequest(observed.id, { reason: "Fixture scoped approval only" }, new Date().toISOString());
      }
      return event;
    }, streamEnvelope() {},
  });
  const decision = await handler(f.request);
  assert.ok(observed, "an allow hint cannot skip durable Host approval");
  assert.equal(decision.approved, true); assert.equal(decision.approvalId, observed.id);
  assert.equal(decision.handledResult, undefined, "approval is not an execution receipt");
  const reopened = createSqliteRunStore(cwd);
  try {
    const checkpoint = reopened.getApprovalCheckpointForApproval(observed.id);
    assert.equal(checkpoint.actionType, "host_capability");
    assert.equal(checkpoint.resumeBasis.priorAttemptId, attempt.id);
    assert.deepEqual(checkpoint.sideEffect, observed.payload);
    assert.equal(reopened.getApprovalRequest(observed.id).status, "approved");
  } finally { reopened.close(); }
});
