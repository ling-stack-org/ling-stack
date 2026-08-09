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
} from "../dist/index.js";
import { SqliteChannelTeamEvidenceStore } from "../dist/storage/sqlite/channel-team-evidence-store.js";

test("sqlite channel team evidence migration is idempotent", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-evidence-migration-"));
  try {
    createSqliteRunStore(cwd).close();
    createSqliteRunStore(cwd).close();

    const paths = resolveRuntimePaths(cwd);
    const database = new DatabaseSync(paths.databasePath);
    try {
      const table = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_team_evidence_items'")
        .get();
      assert.ok(table);
      assert.ok(
        database
          .prepare("SELECT version FROM schema_migrations WHERE version = 81 AND name = 'create_channel_team_evidence_items'")
          .get(),
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite channel team evidence round-trips without visible message or runtime event side effects", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-evidence-"));
  const now = "2026-06-26T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
  const message = store.createChannelMessage(
    {
      channelId: channel.id,
      authorType: "local-user",
      body: "Review this plan quietly.",
    },
    "2026-06-26T00:01:00.000Z",
  );
  store.close();

  const paths = resolveRuntimePaths(cwd);
  const database = new DatabaseSync(paths.databasePath);
  try {
    const evidence = openChannelTeamEvidenceStore(database);
    const beforeMessageCount = readCount(database, "conversation_items");
    const beforeRunEventCount = readCount(database, "run_events");

    const created = evidence.createChannelTeamEvidenceItem(
      buildSpecialistNoteEvidenceInput({
        id: "channel_team_evidence_test_note",
        channelId: channel.id,
        turnId: "turn_demo",
        agentId: "teammate_builtin_security",
        kind: "specialist_note",
        status: "completed",
        visibility: "folded_evidence",
        evidenceGrade: "inspected",
        summary: "Security reviewer found one approval risk.",
        concerns: ["The proposed command may mutate protected files."],
        recommendations: ["Route destructive changes through the existing approval policy."],
        confidence: 0.82,
        sourceRefs: [{ type: "message", id: message.id, label: "User request" }],
        expiresAt: "2026-07-26T00:00:00.000Z",
      }),
      "2026-06-26T00:02:00.000Z",
    );

    assert.equal(created.id, "channel_team_evidence_test_note");
    assert.equal(created.workspaceId, "workspace_default");
    assert.equal(created.kind, "specialist_note");
    assert.equal(created.visibility, "folded_evidence");
    assert.deepEqual(created.sourceRefs, [{ type: "message", id: message.id, label: "User request" }]);
    assert.deepEqual(created.payload, { noteType: "specialist_note", hiddenReasoningStored: false });
    assert.equal(readCount(database, "conversation_items"), beforeMessageCount);
    assert.equal(readCount(database, "run_events"), beforeRunEventCount);

    const relevance = evidence.createChannelTeamEvidenceItem(
      {
        id: "channel_team_evidence_test_relevance",
        channelId: channel.id,
        turnId: "turn_demo",
        agentId: "teammate_builtin_architect",
        kind: "agent_relevance_card",
        status: "completed",
        summary: "Architecture reviewer is relevant to the turn.",
        confidence: 0.64,
        expiresAt: "2026-06-25T00:00:00.000Z",
      },
      "2026-06-26T00:03:00.000Z",
    );

    assert.equal(relevance.visibility, "internal");
    assert.deepEqual(
      evidence.listChannelTeamEvidenceItems({
        channelId: channel.id,
        turnId: "turn_demo",
        now: "2026-06-26T00:04:00.000Z",
      }).map((item) => item.id),
      ["channel_team_evidence_test_note"],
    );
    assert.deepEqual(
      evidence.listChannelTeamEvidenceItems({
        channelId: channel.id,
        turnId: "turn_demo",
        includeExpired: true,
      }).map((item) => item.id),
      ["channel_team_evidence_test_relevance", "channel_team_evidence_test_note"],
    );

    const folded = evidence.listFoldedChannelTeamEvidenceForTurn({
      channelId: channel.id,
      turnId: "turn_demo",
      now: "2026-06-26T00:04:00.000Z",
    });

    assert.equal(folded.totalCount, 1);
    assert.equal(folded.completedCount, 1);
    assert.deepEqual(folded.entries.map((item) => item.id), ["channel_team_evidence_test_note"]);
    assert.deepEqual(folded.chips.map((chip) => chip.agentId), ["teammate_builtin_security"]);
    assert.equal(folded.entries[0].summary, "Security reviewer found one approval risk.");
    assert.equal(folded.entries[0].payload, undefined);

    const updated = evidence.updateChannelTeamEvidenceItem(
      created.id,
      {
        status: "adopted",
        visibility: "promoted",
        evidenceGrade: "verified",
        confidence: null,
        payload: { noteType: "specialist_note", adoptedBy: "ling_agent" },
      },
      "2026-06-26T00:05:00.000Z",
    );

    assert.equal(updated?.status, "adopted");
    assert.equal(updated?.visibility, "promoted");
    assert.equal(updated?.evidenceGrade, "verified");
    assert.equal(updated?.confidence, undefined);
    assert.deepEqual(updated?.payload, { noteType: "specialist_note", adoptedBy: "ling_agent" });
    assert.equal(readCount(database, "conversation_items"), beforeMessageCount);
    assert.equal(readCount(database, "run_events"), beforeRunEventCount);
  } finally {
    database.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function openChannelTeamEvidenceStore(database) {
  return new SqliteChannelTeamEvidenceStore(
    { database },
    {
      assertChannelExists(channelId) {
        const row = database.prepare("SELECT id FROM channels WHERE id = ?").get(channelId);
        if (!row) {
          throw new Error(`Channel not found: ${channelId}`);
        }
      },
    },
  );
}

function readCount(database, tableName) {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
  return Number(row.count);
}
