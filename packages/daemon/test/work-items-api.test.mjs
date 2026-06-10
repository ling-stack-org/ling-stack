import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { ensureGitRepoForChannelPost } from "./git-test-helpers.mjs";

test("work item API lists, routes, claims, heartbeats, releases, completes, and fails durable items", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-work-items-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(stores);
  try {
    const channel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
      name: "Ops",
      boundPath: cwd,
      allowedTools: ["read"],
    });
    const targetChannel = await postJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`, {
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

    const list = await getJson(`${daemon.url}/work-items?cwd=${encodeURIComponent(cwd)}&channelId=${encodeURIComponent(channel.channel.id)}`);
    assert.equal(list.workItems.length, 1);
    assert.equal(list.workItems[0].id, item.id);

    const detail = await getJson(`${daemon.url}/work-items/${encodeURIComponent(item.id)}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(detail.workItem.title, "Handle queue item");

    const routed = await postJson(`${daemon.url}/work-items/${encodeURIComponent(item.id)}/route?cwd=${encodeURIComponent(cwd)}`, {
      channelId: targetChannel.channel.id,
      priority: "urgent",
    });
    assert.equal(routed.workItem.channelId, targetChannel.channel.id);
    assert.equal(routed.workItem.priority, "urgent");

    const claimed = await postJson(`${daemon.url}/work-items/${encodeURIComponent(item.id)}/claim?cwd=${encodeURIComponent(cwd)}`, {
      ownerId: "agent-a",
      leaseMs: 60_000,
    });
    assert.ok(claimed.claimToken);
    assert.equal(claimed.workItem.status, "running");

    const secondClaim = await postJson(`${daemon.url}/work-items/${encodeURIComponent(item.id)}/claim?cwd=${encodeURIComponent(cwd)}`, {
      ownerId: "agent-b",
      leaseMs: 60_000,
    });
    assert.equal(secondClaim.blocker.code, "already_claimed");
    assert.equal(secondClaim.workItem.id, item.id);

    const heartbeated = await postJson(`${daemon.url}/work-items/${encodeURIComponent(item.id)}/heartbeat?cwd=${encodeURIComponent(cwd)}`, {
      claimToken: claimed.claimToken,
      leaseMs: 120_000,
    });
    assert.equal(heartbeated.workItem.claim.token, claimed.claimToken);

    const badHeartbeat = await postJsonExpectError(`${daemon.url}/work-items/${encodeURIComponent(item.id)}/heartbeat?cwd=${encodeURIComponent(cwd)}`, {
      claimToken: "bad-token",
      leaseMs: 60_000,
    });
    assert.equal(badHeartbeat.status, 409);
    assert.equal(badHeartbeat.body.error, "work_item_claim_mismatch");

    const released = await postJson(`${daemon.url}/work-items/${encodeURIComponent(item.id)}/release?cwd=${encodeURIComponent(cwd)}`, {
      claimToken: claimed.claimToken,
    });
    assert.equal(released.workItem.status, "ready");

    const retryItem = store.upsertWorkItem({
      sourceType: "manual",
      sourceId: "manual-api-retry",
      title: "Retry API item",
      retryBudget: 2,
    }, "2026-06-01T00:01:00.000Z");
    const retryClaim = await postJson(`${daemon.url}/work-items/${encodeURIComponent(retryItem.id)}/claim?cwd=${encodeURIComponent(cwd)}`, {
      ownerId: "agent-b",
      leaseMs: 60_000,
    });
    const failed = await postJson(`${daemon.url}/work-items/${encodeURIComponent(retryItem.id)}/fail?cwd=${encodeURIComponent(cwd)}`, {
      claimToken: retryClaim.claimToken,
      reason: "Needs input",
      retry: true,
    });
    assert.equal(failed.workItem.status, "ready");
    assert.equal(failed.workItem.failureReason, "Needs input");

    const finalClaim = await postJson(`${daemon.url}/work-items/${encodeURIComponent(item.id)}/claim?cwd=${encodeURIComponent(cwd)}`, {
      ownerId: "agent-c",
      leaseMs: 60_000,
    });
    const completed = await postJson(`${daemon.url}/work-items/${encodeURIComponent(item.id)}/complete?cwd=${encodeURIComponent(cwd)}`, {
      claimToken: finalClaim.claimToken,
      proofArtifactIds: ["artifact_1"],
    });
    assert.equal(completed.workItem.status, "done");
    assert.deepEqual(completed.workItem.proofArtifactIds, ["artifact_1"]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("work item API returns structured claim blockers for dependencies", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-work-items-blocker-"));
  const stores = new Map();
  const daemon = await startDaemonForTest(stores);
  try {
    await getJson(`${daemon.url}/channels?cwd=${encodeURIComponent(cwd)}`);
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

    const response = await postJson(`${daemon.url}/work-items/${encodeURIComponent(dependent.id)}/claim?cwd=${encodeURIComponent(cwd)}`, {
      ownerId: "agent-a",
    });
    assert.equal(response.blocker.code, "dependency_blocked");
    assert.deepEqual(response.blocker.dependencyIds, [dependency.id]);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function startDaemonForTest(stores) {
  const daemon = createDaemonServer(
    { host: "127.0.0.1", port: 0 },
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
    close: () => daemon.stop(),
  };
}

async function getJson(url) {
  const response = await fetch(url);
  return await readJsonResponse(response);
}

async function postJson(url, body) {
  await ensureGitRepoForChannelPost(url, body);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response);
}

async function postJsonExpectError(url, body) {
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

async function readJsonResponse(response) {
  const text = await response.text();
  assert.ok(response.ok, text);
  return text.trim() ? JSON.parse(text) : {};
}
