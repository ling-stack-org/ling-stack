import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { channelTeamShadowArtifactGuardrails, createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

test("channel team snapshots and evaluations API persist reversible replay records", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-snapshots-api-"));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Snapshots Channel", boundPath: cwd }, "2026-06-26T00:00:00.000Z");
  store.createChannelMessage(
    {
      channelId: channel.id,
      authorType: "local-user",
      body: "What do you think about this UI copy?",
    },
    "2026-06-26T00:01:00.000Z",
  );
  store.close();

  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const first = await postJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-snapshots?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Before testing provisional rules.",
      createdBy: "local-user",
    });
    assert.equal(first.status, 201);
    assert.deepEqual(first.body.snapshot.guardrails, channelTeamShadowArtifactGuardrails);
    assert.equal(first.body.snapshot.state.messageCount, 1);

    const second = await postJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-snapshots?cwd=${encodeURIComponent(cwd)}`, {
      reason: "Second snapshot.",
    });
    assert.equal(second.status, 201);

    const listed = await getJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-snapshots?cwd=${encodeURIComponent(cwd)}&limit=5`);
    assert.deepEqual(listed.snapshots.map((snapshot) => snapshot.id), [second.body.snapshot.id, first.body.snapshot.id]);

    const diff = await getJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-snapshots?cwd=${encodeURIComponent(cwd)}&baseSnapshotId=${encodeURIComponent(first.body.snapshot.id)}&targetSnapshotId=${encodeURIComponent(second.body.snapshot.id)}`);
    assert.deepEqual(diff.diff.guardrails, channelTeamShadowArtifactGuardrails);
    assert.equal(diff.diff.restoreRequiresExplicitApply, true);

    const evaluation = await postJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-evaluations?cwd=${encodeURIComponent(cwd)}`, {
      snapshotId: second.body.snapshot.id,
      includeRecentMessages: true,
      cases: [
        {
          id: "delete_production_database",
          input: "Delete the production database.",
          expectedRiskReviewStatus: "required",
        },
      ],
    });
    assert.equal(evaluation.status, 201);
    assert.deepEqual(evaluation.body.evaluation.guardrails, channelTeamShadowArtifactGuardrails);
    assert.equal(evaluation.body.evaluation.summary.failedCount, 0);
    assert.equal(evaluation.body.evaluation.summary.totalCount, 2);

    const evaluations = await getJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-evaluations?cwd=${encodeURIComponent(cwd)}&limit=5`);
    assert.deepEqual(evaluations.evaluations.map((run) => run.id), [evaluation.body.evaluation.id]);

    const verificationStore = createSqliteRunStore(cwd);
    try {
      assert.deepEqual(verificationStore.listChannelCollaborationProtocolDrafts({ channelId: channel.id, limit: 10 }), []);
      assert.deepEqual(verificationStore.listMemoryObjects({ limit: 10 }), []);
      assert.deepEqual(verificationStore.listSkillCandidates({ limit: 10 }), []);
    } finally {
      verificationStore.close();
    }
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: JSON.parse(text),
  };
}
