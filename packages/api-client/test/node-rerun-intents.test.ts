import assert from "node:assert/strict";
import test from "node:test";
import type { NodeRerunIntentResponseV1, NodeRerunIntentSubmissionV1 } from "@ling-stack/contracts";
import { LingDaemonClient } from "../dist/index.js";

test("durable rerun prepare and read keep encoded source scope and no execution authority", async () => {
  const request: NodeRerunIntentSubmissionV1 = {
    intent: { schemaVersion: 1, kind: "node_rerun_intent", intentId: "intent", idempotencyKey: "rerun-key",
      requestedBy: "local-user", createdAt: "2026-11-16T00:00:00.000Z",
      source: { runId: "run/中文", attemptId: "attempt", nodeId: "node", graphVersionDigest: "a".repeat(64),
        inputArtifact: { artifactId: "input", contentSha256: "b".repeat(64) },
        dependencyClosure: { complete: true, upstream: [], downstreamNodeIds: [] }, sourceSnapshotDigest: "c".repeat(64) },
      target: { executionIdentity: "host_minted", fence: "host_minted", approval: "fresh_current_policy", graphMutation: "none" } },
    planFingerprint: "nrhpv1_0123456789abcdef",
  };
  const body: NodeRerunIntentResponseV1 = { schemaVersion: 1, kind: "node_rerun_intent_response", executionAuthorized: false,
    record: { ...request, schemaVersion: 1, kind: "node_rerun_prepared_intent", id: "record/one", workspaceId: "workspace",
      status: "prepared", policyFingerprint: "d".repeat(64), preparedAt: "2026-11-16T00:00:01.000Z", executionAuthorized: false } };
  const calls: { url: URL; init?: RequestInit }[] = [];
  const client = new LingDaemonClient({ computerUseRouteToken: "TOKEN_SENTINEL",
    fetch: async (input, init) => { calls.push({ url: new URL(String(input)), init }); return Response.json(body); } });
  assert.deepEqual(await client.prepareNodeRerunIntent(request.intent.source.runId, "/workspace/rerun", request), body);
  assert.deepEqual(await client.getNodeRerunIntent(request.intent.source.runId, "/workspace/rerun", body.record.id), body);
  await client.requestNodeRerunApproval(request.intent.source.runId, "/workspace/rerun", body.record.id);
  await client.prepareNodeRerunTarget(request.intent.source.runId, "/workspace/rerun", body.record.id);
  assert.equal(calls[0]!.url.pathname, "/runs/run%2F%E4%B8%AD%E6%96%87/node-rerun/intents");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), request);
  assert.equal(calls[1]!.url.pathname, "/runs/run%2F%E4%B8%AD%E6%96%87/node-rerun/intents/record%2Fone");
  assert.equal(calls[1]!.init?.method, "GET");
  assert.equal(calls[1]!.init?.body, undefined);
  assert.equal(calls[2]!.url.pathname, "/runs/run%2F%E4%B8%AD%E6%96%87/node-rerun/intents/record%2Fone/approval");
  assert.equal(calls[2]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[2]!.init?.body)), {});
  await client.listApprovals("/workspace/rerun", { nodeRerunIntentId: body.record.id });
  assert.equal(calls[3]!.url.pathname, "/runs/run%2F%E4%B8%AD%E6%96%87/node-rerun/intents/record%2Fone/target");
  assert.equal(calls[3]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[3]!.init?.body)), {});
  assert.equal(calls[4]!.url.pathname, "/approvals");
  assert.equal(calls[4]!.url.searchParams.get("nodeRerunIntentId"), body.record.id);
  await client.getNodeRerunGeneration(request.intent.source.runId, "/workspace/rerun", body.record.id);
  assert.equal(calls[5]!.url.pathname, "/runs/run%2F%E4%B8%AD%E6%96%87/node-rerun/intents/record%2Fone/generation");
  assert.equal(calls[5]!.init?.method, "GET");
  assert.equal(calls[5]!.init?.body, undefined);
  await client.cancelNodeRerunTarget(request.intent.source.runId, "/workspace/rerun", body.record.id);
  assert.equal(calls[6]!.url.pathname, "/runs/run%2F%E4%B8%AD%E6%96%87/node-rerun/intents/record%2Fone/target/cancel");
  assert.equal(calls[6]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[6]!.init?.body)), {});
  await client.getNodeRerunTargetReadiness(request.intent.source.runId, "/workspace/rerun", body.record.id);
  assert.equal(calls[7]!.url.pathname, "/runs/run%2F%E4%B8%AD%E6%96%87/node-rerun/intents/record%2Fone/target/readiness");
  assert.equal(calls[7]!.init?.method, "GET");
  assert.equal(calls[7]!.init?.body, undefined);
  assert.ok(calls.every(call => call.url.searchParams.get("cwd") === "/workspace/rerun"));
  assert.ok(!JSON.stringify(calls).includes("TOKEN_SENTINEL"));
});

test("dedicated rerun dispatch keeps source scope and uses an empty body", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const client = new LingDaemonClient({ fetch: async (input, init) => {
    calls.push({ url: new URL(String(input)), init });
    return Response.json({});
  } });
  await client.dispatchNodeRerunTarget("run/中文", "/workspace/rerun", "record/one");
  assert.equal(calls[0]!.url.pathname, "/runs/run%2F%E4%B8%AD%E6%96%87/node-rerun/intents/record%2Fone/target/dispatch");
  assert.equal(calls[0]!.url.searchParams.get("cwd"), "/workspace/rerun");
  assert.equal(calls[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {});
});
