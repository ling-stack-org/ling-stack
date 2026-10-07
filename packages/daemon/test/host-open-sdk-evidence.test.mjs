import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { hostCapabilityToolsV1 } from "@ling-stack/contracts";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { createHostCapabilityAuthority } from "../dist/features/runs/host-capability-authority.js";
import { listAllExecutionActionsForRun } from "../dist/features/runs/execution-actions.js";
import { hostAuthorityFixture } from "./support/host-capability-authority-fixture.mjs";
import { startLoopbackPiProvider } from "./support/loopback-pi-provider-fixture.mjs";

const tool = hostCapabilityToolsV1.find(tool => tool.capabilityId === "host.open_local_target");

// Real SDK and durable approval. The opener is a fixture, not a launched window.
for (const scenario of ["launched", "queued", "failure", "wrong-path"]) {
  test("real SDK preserves Host open " + scenario + " without inventing command evidence", async t => {
    const provider = await startLoopbackPiProvider((_body, number) => number === 1
      ? { tool: tool.name, input: { path: "index.html" } }
      : { text: "Fixture narration is not a launch receipt." });
    t.after(() => provider.close());
    const f = await hostAuthorityFixture(t, { tools: [tool],
      provider: { provider: "host-loopback", model: "static-tools", baseUrl: provider.baseUrl,
        api: "openai-completions", apiKey: "loopback-fixture", reasoning: false } });
    const authority = createHostCapabilityAuthority(f);
    const events = [];
    let calls = 0, receipt;
    const append = (type, data) => f.store.appendExecutionEvent(f.run.id, f.sourceFence, type, { ...data, attemptId: f.attempt.id });
    const approval = f.handler({
      appendAndMaybeStream(type, data) {
        const event = append(type, data);
        if (type === "approval_requested") f.store.approveApprovalRequest(data.approvalId, { reason: "Fixture only" }, new Date().toISOString());
        return event;
      },
    });
    await new PiRunnerAdapter().runTask({ ...f.runnerOptions, preparedInput: f.prepared.preparedInput,
      runId: f.run.id, runnerAttemptId: f.attempt.id,
      onToolBefore(request) {
        const rejection = authority.check({ ...request, task: f.task });
        return rejection ? { allowed: false, ...rejection } : { allowed: true };
      },
      onApprovalRequired: approval,
      onHostCapabilityCall(request) {
        assert.equal(authority.check(request, request.approvalId), undefined);
        calls += 1;
        receipt = { contractVersion: 1, capabilityId: tool.capabilityId, status: scenario === "queued" ? "queued" : "launched",
          path: scenario === "wrong-path" ? "other.html" : request.input.path, runId: request.runId, attemptId: request.attemptId,
          toolCallId: request.toolCallId, approvalId: request.approvalId, receiptId: "sdk-fixture-launch",
          launchedAt: new Date().toISOString(), visibility: "unverified" };
        return { isError: scenario === "failure",
          content: [{ type: "text", text: scenario === "launched" ? "Host launch accepted; window visibility unverified." : "Host launch not confirmed." }],
          details: { hostCapabilityResult: receipt } };
      },
      onEvent(event) {
        events.push(event);
        if (["tool_start", "tool_update", "tool_end"].includes(event.type)) {
          const { type, ...data } = event;
          append(type, data);
        }
      },
    });
    assert.equal(calls, 1);
    assert.equal(provider.requests.length, 2);
    const end = events.find(event => event.type === "tool_end");
    assert.deepEqual(end.result.details.hostCapabilityResult, receipt);
    assert.equal(end.isError, scenario === "failure");
    const actions = listAllExecutionActionsForRun(f.store, f.run.id);
    assert.equal(actions.length, 1, "approval and SDK tool events describe one action");
    assert.equal(actions[0].actionType, "host_capability");
    assert.equal(actions[0].commandEvidence, undefined);
    assert.equal(actions[0].status, scenario === "launched" ? "succeeded" : "failed");
    assert.deepEqual(actions[0].hostOpenReceipt, scenario === "launched" ? receipt : undefined);
    assert.ok(actions[0].sourceRefs.some(ref => ref.kind === "run_event"));
    f.store.close();
    const reopened = createSqliteRunStore(f.cwd);
    try { assert.deepEqual(listAllExecutionActionsForRun(reopened, f.run.id), actions); }
    finally { reopened.close(); }
    assert.equal(calls, 1, "history reload must not open the file again");
  });
}
