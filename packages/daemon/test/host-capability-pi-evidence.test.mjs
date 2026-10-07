import assert from "node:assert/strict";
import test from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { hostCapabilityToolsV1 } from "@ling-stack/contracts";
import { PiRunnerAdapter } from "@ling-stack/runner-pi";
import { createHostCapabilityAuthority } from "../dist/features/runs/host-capability-authority.js";
import { collectHostLocalNetworkInfo } from "../dist/features/runs/host-local-network-info.js";
import { hostLocalNetworkToolResult } from "../dist/features/runs/host-local-network-result.js";
import { listAllExecutionActionsForRun } from "../dist/features/runs/execution-actions.js";
import { hostAuthorityFixture } from "./support/host-capability-authority-fixture.mjs";
import { startLoopbackPiProvider } from "./support/loopback-pi-provider-fixture.mjs";

const networkTool = hostCapabilityToolsV1.find(tool => tool.capabilityId === "host.local_network_info");
const collectedAt = "2026-09-09T01:02:03.000Z";
const sampleAddress = { interfaceName: "fixture-en0", family: "IPv4", address: "192.0.2.19", internal: false };
const failure = rejection => ({ isError: true, content: [{ type: "text", text: rejection.reason }], details: { code: rejection.code } });

/**
 * Real Pi SDK + durable approval + OS collector with static OS input + SQLite.
 * The callback wiring here is deliberately test-only: it does not implement the
 * production dispatcher, current surface permissions, or a live model/GUI test.
 */
async function executeFixture(t, scenario = "success") {
  const provider = await startLoopbackPiProvider((_body, number) => number === 1
    ? { tool: networkTool.name, input: {} }
    : { text: "Fixture narration only; not an execution receipt." });
  t.after(() => provider.close());
  const f = await hostAuthorityFixture(t, { tools: [networkTool], prompt: "Read the local IPv4 and IPv6 interface addresses.",
    provider: { provider: "host-loopback", model: "static-tools", baseUrl: provider.baseUrl, api: "openai-completions", apiKey: "loopback-fixture", reasoning: false } });
  const controller = new AbortController();
  const authority = createHostCapabilityAuthority({ ...f, signal: controller.signal });
  const approvals = [], events = [], rejectedEvents = [];
  let collections = 0, hostCalls = 0;
  const append = (type, data) => {
    try { return f.store.appendExecutionEvent(f.run.id, f.sourceFence, type, data); }
    catch (error) {
      // Match the production emitter's stale-writer handling. A fenced-out
      // event is not a provider failure and must never use appendEvent fallback.
      if (error.code !== "stale_run_execution") throw error;
      rejectedEvents.push({ type, data });
      return undefined;
    }
  };
  f.store.appendExecutionEvent(f.run.id, f.sourceFence, "run_created", { attemptId: f.attempt.id });
  const approval = f.handler({ signal: controller.signal,
    appendAndMaybeStream(type, data) {
      const event = append(type, data);
      if (type === "approval_requested") {
        const request = f.store.getApprovalRequest(data.approvalId);
        approvals.push(request);
        if (scenario === "cancel-during-approval") controller.abort();
        if (scenario === "denied") f.store.denyApprovalRequest(request.id, { reason: "Fixture denies local interface query" }, new Date().toISOString());
        else f.store.approveApprovalRequest(request.id, { reason: "Fixture grants this query only" }, new Date().toISOString());
      }
      return event;
    },
    onApprovalResolved: scenario === "replaced-after-approval" ? () => f.replace() : undefined,
  });
  if (scenario === "replaced-before-call") f.replace();
  const run = new PiRunnerAdapter().runTask({ ...f.runnerOptions, preparedInput: f.prepared.preparedInput,
    runId: f.run.id, runnerAttemptId: f.attempt.id, signal: controller.signal,
    onToolBefore(request) {
      const rejection = authority.check({ ...request, task: f.task });
      return rejection ? { allowed: false, ...rejection } : { allowed: true };
    },
    onApprovalRequired: approval,
    onHostCapabilityCall(request) {
      hostCalls += 1;
      assert.equal(request.runId, f.run.id);
      assert.equal(request.attemptId, f.attempt.id);
      const rejection = authority.check(request, scenario === "foreign-approval" ? "foreign-approval" : request.approvalId);
      if (rejection) return failure(rejection);
      const result = collectHostLocalNetworkInfo(request.input, { signal: request.signal, now: () => new Date(collectedAt),
        readInterfaces() {
          collections += 1;
          if (scenario === "os-error") throw new Error("PRIVATE_OS_ERROR_DO_NOT_PUBLISH");
          return { [sampleAddress.interfaceName]: [{ ...sampleAddress, mac: "PRIVATE_MAC_DO_NOT_PUBLISH" }] };
        } });
      return hostLocalNetworkToolResult(result);
    },
    onEvent(event) {
      events.push(event);
      if (["tool_start", "tool_update", "tool_end"].includes(event.type)) {
        const { type, ...data } = event;
        append(type, { ...data, attemptId: f.attempt.id });
      }
    },
  });
  // A cancelled SDK task can either reject AbortError or return an aborted
  // transcript. In either case, no successful Host result may be published.
  let thrown;
  try { await run; } catch (error) { thrown = error; }
  if (scenario === "cancel-during-approval") {
    if (thrown) assert.equal(thrown.name, "AbortError");
  } else assert.equal(thrown, undefined);
  return { ...f, provider, approvals, events, rejectedEvents, collections, hostCalls,
    actions: listAllExecutionActionsForRun(f.store, f.run.id) };
}

test("real SDK Host result joins one approval/action and survives SQLite reopen without recollection", async t => {
  const f = await executeFixture(t);
  assert.equal(f.collections, 1);
  assert.equal(f.hostCalls, 1);
  assert.equal(f.approvals.length, 1);
  assert.equal(f.approvals[0].status, "pending", "Host must observe an actual durable pending approval");
  assert.equal(f.provider.requests.length, 2);
  const [start] = f.events.filter(event => event.type === "tool_start");
  const [end] = f.events.filter(event => event.type === "tool_end");
  assert.equal(end.toolCallId, start.toolCallId);
  assert.equal(end.isError, false);
  assert.deepEqual(end.result.details.hostCapabilityResult, { contractVersion: 1, capabilityId: "host.local_network_info",
    status: "succeeded", collectedAt, addresses: [sampleAddress], truncated: false });
  assert.equal(f.actions.length, 1, "approval and actual result are a single logical action");
  const [action] = f.actions;
  assert.equal(action.actionType, "host_capability");
  assert.equal(action.status, "succeeded");
  assert.equal(action.runId, f.run.id);
  assert.equal(action.attemptId, f.attempt.id);
  assert.equal(action.participantId, f.run.teammateId);
  assert.equal(action.approvalId, f.approvals[0].id);
  assert.equal(action.toolCallId, start.toolCallId);
  assert.equal(action.commandEvidence, undefined);
  assert.equal(action.targetRefs.some(ref => ["command", "mcp_tool", "file"].includes(ref.type)), false);
  assert.match(action.toolEvidence.outputText, /192\.0\.2\.19/);
  assert.match(action.toolEvidence.outputText, /Collected at: 2026-09-09T01:02:03\.000Z/);
  assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_MAC_DO_NOT_PUBLISH|exit 0/);
  assert.match(JSON.stringify(f.provider.requests[1].messages), /192\.0\.2\.19/);
  assert.ok(action.sourceRefs.some(ref => ref.kind === "run_event"));
  f.store.close();
  const reopened = createSqliteRunStore(f.cwd);
  try {
    assert.deepEqual(listAllExecutionActionsForRun(reopened, f.run.id), f.actions);
    const ends = reopened.listEvents(f.run.id).filter(event => event.type === "tool_end");
    assert.equal(ends.length, 1);
    assert.deepEqual(ends[0].data.result.details.hostCapabilityResult, end.result.details.hostCapabilityResult);
  } finally { reopened.close(); }
  assert.equal(f.collections, 1, "projection/reopen must not query current OS state");
});

for (const scenario of ["denied", "os-error", "foreign-approval"]) {
  test(`real SDK Host ${scenario} never turns narration into a successful action`, async t => {
    const f = await executeFixture(t, scenario);
    assert.equal(f.collections, scenario === "os-error" ? 1 : 0);
    assert.equal(f.hostCalls, scenario === "denied" ? 0 : 1);
    assert.equal(f.approvals.length, 1);
    const [end] = f.events.filter(event => event.type === "tool_end");
    assert.equal(end.isError, true);
    assert.equal(f.actions.length, 1);
    assert.equal(f.actions[0].status, scenario === "denied" ? "denied" : "failed");
    assert.doesNotMatch(JSON.stringify(f.events), /PRIVATE_OS_ERROR_DO_NOT_PUBLISH|PRIVATE_MAC_DO_NOT_PUBLISH|192\.0\.2\.19/);
    const stored = f.store.getApprovalRequest(f.approvals[0].id);
    assert.equal(stored.status, scenario === "denied" ? "denied" : "approved", "approval is not an execution outcome");
  });
}

for (const scenario of ["replaced-before-call", "replaced-after-approval", "cancel-during-approval"]) {
  test(`real SDK Host ${scenario} cannot collect or publish successful evidence`, async t => {
    const f = await executeFixture(t, scenario);
    assert.equal(f.collections, 0);
    assert.equal(f.hostCalls, 0);
    assert.equal(f.approvals.length, scenario === "replaced-before-call" ? 0 : 1);
    assert.equal(f.actions.some(action => action.status === "succeeded"), false);
    assert.equal(f.events.some(event => event.type === "tool_end" && !event.isError), false);
    if (scenario.startsWith("replaced-")) assert.ok(f.rejectedEvents.length > 0, "old SDK events must fail the SQLite ownership fence");
  });
}
