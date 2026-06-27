import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { channelTeamShadowArtifactGuardrails, createSqliteRunStore } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

test("channel team patterns API creates and lists inspect-only patterns", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-patterns-api-"));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Patterns Channel", boundPath: cwd }, "2026-06-26T00:00:00.000Z");
  store.close();

  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const created = await postJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-patterns?cwd=${encodeURIComponent(cwd)}`, {
      pattern: "Prefer security review for destructive git commands.",
      summary: "Repeated folded evidence supports a low-risk attention trial.",
      evidenceCount: 2,
      sourceRefs: [{ type: "turn", id: "turn_demo" }],
      status: "provisional",
      createdBy: "ai-draft",
      provisionalEffect: "attention_ordering",
      provisionalRationale: "Only changes suggested observer ordering.",
      expiresAt: "2026-07-26T00:00:00.000Z",
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.cwd, cwd);
    assert.equal(created.body.channelId, channel.id);
    assert.equal(created.body.pattern.status, "provisional");
    assert.equal(created.body.pattern.provisionalEffect, "attention_ordering");
    assert.deepEqual(created.body.pattern.guardrails, channelTeamShadowArtifactGuardrails);

    const listed = await getJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-patterns?cwd=${encodeURIComponent(cwd)}&status=provisional&limit=10`);
    assert.equal(listed.cwd, cwd);
    assert.equal(listed.channelId, channel.id);
    assert.deepEqual(listed.patterns.map((pattern) => pattern.id), [created.body.pattern.id]);

    const invalidStatus = await postJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-patterns?cwd=${encodeURIComponent(cwd)}`, {
      pattern: "Bad status.",
      summary: "Approved must not be created by this endpoint.",
      status: "approved",
    });
    assert.equal(invalidStatus.status, 400);
    assert.match(invalidStatus.body.message, /candidate or provisional/);

    const missingChannel = await getRequest(`${baseUrl}/channels/missing_channel/team-patterns?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missingChannel.status, 404);
    assert.equal(missingChannel.body.error, "channel_not_found");

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

async function getRequest(url) {
  const response = await fetch(url);
  const text = await response.text();
  return {
    status: response.status,
    body: JSON.parse(text),
  };
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
