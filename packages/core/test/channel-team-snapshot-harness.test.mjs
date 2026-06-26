import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  buildChannelTeamEvaluationRunInput,
  createSqliteRunStore,
  diffChannelTeamSnapshots,
  resolveRuntimePaths,
} from "../dist/index.js";

test("sqlite channel team snapshot migration creates snapshot and evaluation tables", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-snapshot-migration-"));
  try {
    createSqliteRunStore(cwd).close();
    createSqliteRunStore(cwd).close();

    const paths = resolveRuntimePaths(cwd);
    const database = new DatabaseSync(paths.databasePath);
    try {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_team_snapshots'").get());
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_team_evaluations'").get());
      assert.ok(
        database
          .prepare("SELECT version FROM schema_migrations WHERE version = 84 AND name = 'create_channel_team_snapshots_and_evaluations'")
          .get(),
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel team snapshots persist diffable reversible state without restoring automatically", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-snapshot-store-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Snapshot Channel", boundPath: cwd }, "2026-06-26T00:00:00.000Z");
    const before = store.createChannelTeamSnapshot(
      {
        channelId: channel.id,
        reason: "Before provisional rule.",
        createdBy: "local-user",
        state: snapshotState({ messageCount: 1, activeRuleIds: [] }),
      },
      "2026-06-26T00:01:00.000Z",
    );
    const after = store.createChannelTeamSnapshot(
      {
        channelId: channel.id,
        reason: "After provisional rule.",
        state: snapshotState({ messageCount: 2, activeRuleIds: ["pattern_security"] }),
      },
      "2026-06-26T00:02:00.000Z",
    );

    const diff = diffChannelTeamSnapshots(before, after);
    assert.equal(diff.restoreRequiresExplicitApply, true);
    assert.deepEqual(diff.entries.map((entry) => entry.path), ["activeProvisionalRuleIds", "patternIds", "messageCount"]);
    assert.deepEqual(store.listChannelTeamSnapshots({ channelId: channel.id }).map((snapshot) => snapshot.id), [after.id, before.id]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel team evaluation harness records synthetic risk-review expectations", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-evaluation-store-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Evaluation Channel", boundPath: cwd }, "2026-06-26T00:00:00.000Z");
    const input = buildChannelTeamEvaluationRunInput({
      channelId: channel.id,
      now: "2026-06-26T00:01:00.000Z",
      cases: [
        {
          id: "destructive_production_delete",
          input: "Delete the production database.",
          expectedRiskReviewStatus: "required",
          maxObserverCount: 4,
        },
        {
          id: "ordinary_ui_discussion",
          input: "What do you think about this button copy?",
          expectedRiskReviewStatus: "not_required",
          maxObserverCount: 4,
        },
      ],
    });
    const evaluation = store.createChannelTeamEvaluationRun(input, "2026-06-26T00:02:00.000Z");

    assert.equal(evaluation.summary.totalCount, 2);
    assert.equal(evaluation.summary.failedCount, 0);
    assert.deepEqual(evaluation.results.map((result) => result.observedRiskReviewStatus), ["required", "not_required"]);
    assert.deepEqual(store.listChannelTeamEvaluationRuns({ channelId: channel.id }).map((run) => run.id), [evaluation.id]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function snapshotState({ messageCount, activeRuleIds }) {
  const rules = activeRuleIds.map((id) => ({
    id,
    workspaceId: "workspace_default",
    channelId: "channel_demo",
    pattern: "Prefer security review.",
    summary: "Low-risk attention rule.",
    evidenceCount: 1,
    adoptedCount: 0,
    failureCount: 0,
    sourceRefs: [],
    status: "provisional",
    createdBy: "system",
    provisionalEffect: "attention_ordering",
    provisionalRationale: "TTL-bound test.",
    verifyBeforeUse: true,
    lastSeenAt: "2026-06-26T00:00:00.000Z",
    expiresAt: "2026-07-26T00:00:00.000Z",
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
  }));
  return {
    protocol: {
      version: 1,
      defaultWorkflowPreference: "manual",
      visibleMultiReplyMaxParticipants: 3,
      privacyRules: [],
      reviewRules: [],
      updatedAt: "2026-06-26T00:00:00.000Z",
    },
    activeProvisionalRules: rules,
    patterns: rules,
    reliabilityIncidentIds: [],
    availabilityIncidentIds: [],
    messageCount,
  };
}
