import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { LingDaemonClient } from "@ling-stack/api-client";
import type { ChannelConversationTurnResponse, CreateChannelTurnRequest } from "@ling-stack/contracts";
import { createSqliteRunStore, type Channel, type RunStore, type WorkItemListResponse, type WorkItemDetailResponse,
  type WorkItemClaimResponse, type WorkItemMutationResponse } from "@ling-stack/core";
import { createDaemonServer, type DaemonServer } from "../dist/index.js";
import { prepareChannelCreateBody } from "./conversation-model-test-fixture.mjs";
import { ensureGitRepoForChannelPost } from "./git-test-helpers.mjs";

test("channel turns attach one explicit input to the current Work Item without creating a Run", async t => {
  const { cwd, stores, url } = await startDaemonForTest(t);
  const { channel } = await postJson<{ channel: Channel }>(`${url}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "Engineering", boundPath: cwd, allowedTools: ["read"],
  });
  const { channel: other } = await postJson<{ channel: Channel }>(`${url}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "Support", boundPath: cwd, allowedTools: ["read"],
  });
  const store = stores.get(cwd);
  assert.ok(store);
  const item = store.upsertWorkItem({ channelId: channel.id, sourceType: "manual", sourceId: "channel-input",
    title: "Update the integration checks" }, new Date().toISOString());
  const input: CreateChannelTurnRequest = {
    idempotencyKey: "channel-input-1",
    body: "The integration matrix includes Windows.",
    workItemTarget: { workItemId: item.id, expectedRevision: item.revision },
  };
  const turnsUrl = (channelId: string) => `${url}/channels/${channelId}/turns?cwd=${encodeURIComponent(cwd)}`;
  const denied = await postJsonExpectError(turnsUrl(other.id), input);
  assert.equal(denied.status, 404);
  assert.equal(denied.body.error, "work_item_target_unavailable");
  const client = new LingDaemonClient({ baseUrl: url });
  const [first, stream] = await Promise.all([
    client.createChannelTurn(cwd, channel.id, input),
    client.streamChannelTurn(cwd, channel.id, input),
  ]);
  const done = (await stream.text()).split("\n\n").find(block => block.startsWith("event: done\n"));
  assert.ok(done);
  const fromStream = JSON.parse(done.split("\n").find(line => line.startsWith("data: "))!.slice(6)) as ChannelConversationTurnResponse;
  assert.ok(first.workItemInput);
  assert.deepEqual(fromStream.workItemInput, first.workItemInput);
  assert.equal(first.workItemInput.workItemId, item.id);
  assert.equal(first.workItemInput.sourceItemId, first.userItem.id);
  assert.equal(first.workItemInput.acceptedRevision, item.revision);
  assert.equal(first.turn.status, "succeeded");
  assert.deepEqual(first.userItem.domainRefs, [{ type: "work_item", id: item.id }]);
  const [evidence] = store.listWorkItemEvidence({ workItemId: item.id });
  assert.equal(evidence.id, first.workItemInput.evidenceId);
  assert.equal(evidence.sourceRefs[0].id, first.userItem.id);
  const stale = await postJsonExpectError(turnsUrl(channel.id), { ...input, idempotencyKey: "another-input" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "stale_revision");
  const conflict = await postJsonExpectError(turnsUrl(channel.id), { ...input, body: "Different source content." });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, "idempotency_conflict");
  await assert.rejects(client.editConversationMessage(cwd, {
    surface: "channel_root", ownerId: channel.id, messageId: first.userItem.id, expectedRevision: 1,
    body: "Replace the committed evidence.", idempotencyKey: "edit-targeted-input",
  }), { status: 409 });
  assert.equal(store.listLingTurns({ threadId: first.thread.id }).length, 1);
  assert.equal(store.listWorkItemEvidence({ workItemId: item.id }).length, 1);
  const events = store.listControlPlaneEvents({ workspaceId: item.workspaceId, entityType: "work_item", entityId: item.id,
    action: "work_item.evidence.updated" });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.evidenceId, evidence.id);
  assert.equal(store.listRuns().length, 0);
});

test("work item API lists, routes, claims, heartbeats, releases, completes, and fails durable items", async (t) => {
  const { cwd, stores, url } = await startDaemonForTest(t);
  const channel = await postJson<{ channel: Channel }>(`${url}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "Ops",
    boundPath: cwd,
    allowedTools: ["read"],
  });
  const targetChannel = await postJson<{ channel: Channel }>(`${url}/channels?cwd=${encodeURIComponent(cwd)}`, {
    name: "Review",
    boundPath: cwd,
    allowedTools: ["read"],
  });
  const store = stores.get(cwd);
  assert.ok(store);
  const item = store.upsertWorkItem({
    channelId: channel.channel.id,
    sourceType: "manual",
    sourceId: "manual-api-1",
    title: "Handle queue item",
    retryBudget: 2,
  }, "2026-06-01T00:00:00.000Z");

  const list = await getJson<WorkItemListResponse>(`${url}/work-items?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}`);
  assert.equal(list.workItems.length, 1);
  assert.equal(list.workItems[0].id, item.id);

  const detail = await getJson<WorkItemDetailResponse>(`${url}/work-items/${encodeURIComponent(item.id)}?cwd=${encodeURIComponent(cwd)}`);
  assert.equal(detail.workItem.title, "Handle queue item");

  const routed = await postJson<WorkItemMutationResponse>(`${url}/work-items/${encodeURIComponent(item.id)}/route?cwd=${encodeURIComponent(cwd)}`, {
    channelId: targetChannel.channel.id,
    priority: "urgent",
  });
  assert.equal(routed.workItem.channelId, targetChannel.channel.id);
  assert.equal(routed.workItem.priority, "urgent");

  const claimed = await postJson<WorkItemClaimResponse>(`${url}/work-items/${encodeURIComponent(item.id)}/claim?cwd=${encodeURIComponent(cwd)}`, {
    ownerId: "agent-a",
    leaseMs: 60_000,
  });
  assert.ok(claimed.claimToken);
  assert.equal(claimed.workItem.status, "running");

  const secondClaim = await postJson<WorkItemClaimResponse>(`${url}/work-items/${encodeURIComponent(item.id)}/claim?cwd=${encodeURIComponent(cwd)}`, {
    ownerId: "agent-b",
    leaseMs: 60_000,
  });
  assert.equal(secondClaim.blocker?.code, "already_claimed");
  assert.equal(secondClaim.workItem.id, item.id);

  const heartbeated = await postJson<WorkItemMutationResponse>(`${url}/work-items/${encodeURIComponent(item.id)}/heartbeat?cwd=${encodeURIComponent(cwd)}`, {
    claimToken: claimed.claimToken,
    leaseMs: 120_000,
  });
  assert.equal(heartbeated.workItem.claim?.token, claimed.claimToken);

  const badHeartbeat = await postJsonExpectError(`${url}/work-items/${encodeURIComponent(item.id)}/heartbeat?cwd=${encodeURIComponent(cwd)}`, {
    claimToken: "bad-token",
    leaseMs: 60_000,
  });
  assert.equal(badHeartbeat.status, 409);
  assert.equal(badHeartbeat.body.error, "work_item_claim_mismatch");

  const released = await postJson<WorkItemMutationResponse>(`${url}/work-items/${encodeURIComponent(item.id)}/release?cwd=${encodeURIComponent(cwd)}`, {
    claimToken: claimed.claimToken,
  });
  assert.equal(released.workItem.status, "ready");

  const retryItem = store.upsertWorkItem({
    sourceType: "manual",
    sourceId: "manual-api-retry",
    title: "Retry API item",
    retryBudget: 2,
  }, "2026-06-01T00:01:00.000Z");
  const retryClaim = await postJson<WorkItemClaimResponse>(`${url}/work-items/${encodeURIComponent(retryItem.id)}/claim?cwd=${encodeURIComponent(cwd)}`, {
    ownerId: "agent-b",
    leaseMs: 60_000,
  });
  const failed = await postJson<WorkItemMutationResponse>(`${url}/work-items/${encodeURIComponent(retryItem.id)}/fail?cwd=${encodeURIComponent(cwd)}`, {
    claimToken: retryClaim.claimToken,
    reason: "Needs input",
    retry: true,
  });
  assert.equal(failed.workItem.status, "ready");
  assert.equal(failed.workItem.failureReason, "Needs input");

  const finalClaim = await postJson<WorkItemClaimResponse>(`${url}/work-items/${encodeURIComponent(item.id)}/claim?cwd=${encodeURIComponent(cwd)}`, {
    ownerId: "agent-c",
    leaseMs: 60_000,
  });
  const completed = await postJson<WorkItemMutationResponse>(`${url}/work-items/${encodeURIComponent(item.id)}/complete?cwd=${encodeURIComponent(cwd)}`, {
    claimToken: finalClaim.claimToken,
    proofArtifactIds: ["artifact_1"],
  });
  assert.equal(completed.workItem.status, "done");
  assert.deepEqual(completed.workItem.proofArtifactIds, ["artifact_1"]);
});

test("work item API returns structured claim blockers for dependencies", async (t) => {
  const { cwd, stores, url } = await startDaemonForTest(t);
  await getJson(`${url}/channels?cwd=${encodeURIComponent(cwd)}`);
  const store = stores.get(cwd);
  assert.ok(store);
  const dependency = store.upsertWorkItem({
    sourceType: "manual",
    sourceId: "dependency",
    title: "Dependency",
  }, "2026-06-01T00:00:00.000Z");
  const dependent = store.upsertWorkItem({
    sourceType: "manual",
    sourceId: "dependent",
    title: "Dependent",
    dependencyIds: [dependency.id],
  }, "2026-06-01T00:00:00.000Z");

  const response = await postJson<WorkItemClaimResponse>(`${url}/work-items/${encodeURIComponent(dependent.id)}/claim?cwd=${encodeURIComponent(cwd)}`, {
    ownerId: "agent-a",
  });
  assert.equal(response.blocker?.code, "dependency_blocked");
  assert.deepEqual(response.blocker?.dependencyIds, [dependency.id]);
});

async function startDaemonForTest(t: TestContext) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-work-items-")));
  const cwd = resolve(root, "workspace");
  const previousHome = process.env.LING_STACK_HOME;
  let daemon: DaemonServer | undefined;
  t.after(async () => {
    try { await daemon?.stop(); }
    finally {
      if (previousHome === undefined) delete process.env.LING_STACK_HOME;
      else process.env.LING_STACK_HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });
  await mkdir(cwd);
  process.env.LING_STACK_HOME = resolve(root, "user");
  const stores = new Map<string, RunStore>();
  daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd },
    {
      runner: {
        async runTask() {
          throw new Error("work item API tests must not run agents");
        },
      },
      storeFactory(cwd) {
        const store = createSqliteRunStore(cwd);
        stores.set(cwd, store);
        return store;
      },
    },
  );
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    cwd,
    stores,
  };
}

async function getJson<T>(url: string) {
  const response = await fetch(url);
  return await readJsonResponse<T>(response);
}

async function postJson<T>(url: string, body: object) {
  const preparedBody = await prepareChannelCreateBody(url, body);
  await ensureGitRepoForChannelPost(url, preparedBody);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(preparedBody),
  });
  return await readJsonResponse<T>(response);
}

async function postJsonExpectError(url: string, body: object) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.ok, false, text);
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) : {},
  };
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  assert.ok(response.ok, text);
  return JSON.parse(text) as T;
}
