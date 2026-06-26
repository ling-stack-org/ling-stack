import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  buildSpecialistNoteEvidenceInput,
  createSqliteRunStore,
  resolveRuntimePaths,
} from "../../core/dist/index.js";
import { SqliteChannelTeamLifecycleStore } from "../../core/dist/storage/sqlite/channel-team-lifecycle-store.js";
import { createDaemonServer } from "../dist/index.js";

test("channel team metrics API exposes read-only team metrics for a channel", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-metrics-api-"));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Metrics Channel", boundPath: cwd }, "2026-06-26T00:00:00.000Z");
  store.createChannelTeamEvidenceItem(
    buildSpecialistNoteEvidenceInput({
      id: "channel_team_note_architecture",
      channelId: channel.id,
      turnId: "turn_demo",
      agentId: "teammate_builtin_architect",
      evidenceGrade: "verified",
      summary: "Architecture verified the handoff.",
      recommendations: ["Keep this as folded evidence."],
      sourceRefs: [{ type: "turn", id: "turn_demo" }],
      now: "2026-06-26T00:01:00.000Z",
    }),
    "2026-06-26T00:01:00.000Z",
  );
  store.close();

  const paths = resolveRuntimePaths(cwd);
  const database = new DatabaseSync(paths.databasePath);
  try {
    const lifecycle = new SqliteChannelTeamLifecycleStore({ database });
    lifecycle.createReliabilityIncident(
      {
        id: "incident_architecture_quality",
        agentId: "teammate_builtin_architect",
        capabilityScope: "architecture",
        kind: "low_quality",
        severity: "high",
        summary: "Architecture reviewer missed a dependency.",
        sourceRefs: [{ type: "turn", id: "turn_demo" }],
      },
      "2026-06-26T00:02:00.000Z",
    );
  } finally {
    database.close();
  }

  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await getJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-metrics?cwd=${encodeURIComponent(cwd)}&limit=25`);

    assert.equal(response.cwd, cwd);
    assert.equal(response.channelId, channel.id);
    assert.equal(response.metrics.channelId, channel.id);
    assert.equal(response.metrics.summary.totalEvidenceCount, 1);
    assert.equal(response.metrics.summary.healthState, "degraded");
    assert.equal(response.metrics.riskReview.openReliabilityIncidentCount, 1);
    assert.equal(response.metrics.learningQueue.recommendationEvidenceCount, 1);
    assert.deepEqual(response.metrics.agents.map((agent) => agent.agentId), ["teammate_builtin_architect"]);

    const missingChannel = await requestJson(`${baseUrl}/channels/missing_channel/team-metrics?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missingChannel.status, 404);
    assert.equal(missingChannel.body.error, "channel_not_found");

    const missingCwd = await requestJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-metrics`);
    assert.equal(missingCwd.status, 400);
    assert.equal(missingCwd.body.error, "bad_request");
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

async function requestJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  return {
    status: response.status,
    body: JSON.parse(text),
  };
}
