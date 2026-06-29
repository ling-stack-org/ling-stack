import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  buildSpecialistNoteEvidenceInput,
  createSqliteRunStore,
} from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

test("channel team experts API exposes a compact folded projection", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-experts-api-"));
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Experts Channel", boundPath: cwd }, "2026-06-26T00:00:00.000Z");
  store.createChannelTeamEvidenceItem(
    buildSpecialistNoteEvidenceInput({
      id: "channel_team_note_security",
      channelId: channel.id,
      turnId: "turn_demo",
      agentId: "teammate_builtin_security",
      evidenceGrade: "verified",
      summary: "Security verified the risky action boundary.",
      sourceRefs: [{ type: "turn", id: "turn_demo" }],
      now: "2026-06-26T00:01:00.000Z",
      expiresAt: null,
    }),
    "2026-06-26T00:01:00.000Z",
  );
  store.createChannelTeamEvidenceItem(
    buildSpecialistNoteEvidenceInput({
      id: "channel_team_note_expired_architect",
      channelId: channel.id,
      turnId: "turn_demo",
      agentId: "teammate_builtin_architect",
      evidenceGrade: "inspected",
      summary: "Architect historical note is retained for transcript display.",
      sourceRefs: [{ type: "turn", id: "turn_demo" }],
      now: "2026-06-26T00:01:00.000Z",
      expiresAt: "2000-01-01T00:00:00.000Z",
    }),
    "2026-06-26T00:01:00.000Z",
  );
  store.close();

  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await getJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-experts?cwd=${encodeURIComponent(cwd)}&turnId=turn_demo`);

    assert.equal(response.cwd, cwd);
    assert.equal(response.channelId, channel.id);
    assert.equal(response.turnId, "turn_demo");
    assert.equal(response.experts.totalCount, 1);
    assert.equal(response.experts.completedCount, 1);
    assert.deepEqual(response.experts.chips.map((chip) => chip.agentId), ["teammate_builtin_security"]);
    assert.equal(response.experts.entries[0].summary, "Security verified the risky action boundary.");

    const historicalResponse = await getJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-experts?cwd=${encodeURIComponent(cwd)}&turnId=turn_demo&includeExpired=true`);
    assert.equal(historicalResponse.experts.totalCount, 2);
    assert.ok(historicalResponse.experts.entries.some((entry) => entry.summary === "Architect historical note is retained for transcript display."));

    const missingTurn = await requestJson(`${baseUrl}/channels/${encodeURIComponent(channel.id)}/team-experts?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(missingTurn.status, 400);
    assert.equal(missingTurn.body.error, "bad_request");
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
