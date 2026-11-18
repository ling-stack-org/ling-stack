import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { createSqliteRunStore, type Channel, type RunStore, type WorkItemListResponse, type WorkItemDetailResponse,
  type WorkItemClaimResponse, type WorkItemMutationResponse } from "@ling-stack/core";
import { createDaemonServer, type DaemonServer } from "../dist/index.js";
import { prepareChannelCreateBody } from "./conversation-model-test-fixture.mjs";
import { ensureGitRepoForChannelPost } from "./git-test-helpers.mjs";

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
