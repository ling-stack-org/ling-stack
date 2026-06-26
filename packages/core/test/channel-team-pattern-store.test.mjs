import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  buildChannelTeamPatternCandidateFromEvidence,
  createSqliteRunStore,
  isActiveChannelTeamProvisionalRule,
  resolveRuntimePaths,
} from "../dist/index.js";

test("sqlite channel team pattern migration creates a protocol-side pattern table", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-pattern-migration-"));
  try {
    createSqliteRunStore(cwd).close();
    createSqliteRunStore(cwd).close();

    const paths = resolveRuntimePaths(cwd);
    const database = new DatabaseSync(paths.databasePath);
    try {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_team_patterns'").get());
      assert.ok(
        database
          .prepare("SELECT version FROM schema_migrations WHERE version = 83 AND name = 'create_channel_team_patterns'")
          .get(),
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel team patterns store candidates and TTL-bound provisional rules without protocol mutation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-pattern-store-"));
  const now = "2026-06-26T00:00:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Pattern Channel", boundPath: cwd }, now);
    const beforeProtocol = store.getChannelCollaborationProtocolOverride(channel.id);

    const candidateInput = buildChannelTeamPatternCandidateFromEvidence({
      channelId: channel.id,
      pattern: "Security notes repeatedly recommend approval routing for destructive git commands.",
      summary: "Repeated security evidence supports a review rule candidate.",
      now,
      expiresAt: "2026-06-27T00:00:00.000Z",
      evidence: [
        evidence({
          channelId: channel.id,
          id: "evidence_adopted",
          status: "adopted",
          recommendations: ["Route destructive git commands through approval."],
          updatedAt: "2026-06-26T00:01:00.000Z",
        }),
        evidence({
          channelId: channel.id,
          id: "evidence_failed",
          status: "timeout",
          sourceRefs: [],
          updatedAt: "2026-06-26T00:02:00.000Z",
        }),
        evidence({ channelId: "other_channel", id: "evidence_other" }),
      ],
    });

    assert.ok(candidateInput);
    assert.equal(candidateInput.evidenceCount, 2);
    assert.equal(candidateInput.adoptedCount, 1);
    assert.equal(candidateInput.failureCount, 1);
    assert.equal(candidateInput.verifyBeforeUse, true);

    const candidate = store.createChannelTeamPattern(candidateInput, "2026-06-26T00:03:00.000Z");
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.verifyBeforeUse, true);

    const provisional = store.createChannelTeamPattern(
      {
        channelId: channel.id,
        pattern: "Prefer security reviewer before risky git history changes.",
        summary: "Low-risk attention ordering trial.",
        evidenceCount: 3,
        sourceRefs: [{ type: "turn", id: "turn_demo" }],
        status: "provisional",
        createdBy: "ai-draft",
        provisionalEffect: "attention_ordering",
        provisionalRationale: "Only changes observer ordering and expires automatically.",
        expiresAt: "2026-06-27T00:00:00.000Z",
      },
      "2026-06-26T00:04:00.000Z",
    );

    assert.equal(isActiveChannelTeamProvisionalRule(provisional, "2026-06-26T12:00:00.000Z"), true);
    assert.deepEqual(
      store.listActiveChannelTeamProvisionalRules({
        channelId: channel.id,
        now: "2026-06-26T12:00:00.000Z",
      }).map((pattern) => pattern.id),
      [provisional.id],
    );
    assert.deepEqual(
      store.listActiveChannelTeamProvisionalRules({
        channelId: channel.id,
        now: "2026-06-28T00:00:00.000Z",
      }).map((pattern) => pattern.id),
      [],
    );

    assert.equal(store.expireChannelTeamPatterns("2026-06-28T00:00:00.000Z"), 2);
    assert.deepEqual(
      store.listChannelTeamPatterns({
        channelId: channel.id,
        status: "expired",
        now: "2026-06-28T00:01:00.000Z",
      }).map((pattern) => pattern.id),
      [provisional.id, candidate.id],
    );
    assert.equal(store.getChannelCollaborationProtocolOverride(channel.id), beforeProtocol);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("channel team patterns reject provisional fields on plain candidates", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-channel-team-pattern-invalid-"));
  const store = createSqliteRunStore(cwd);
  try {
    const channel = store.createChannel({ name: "Invalid Pattern Channel", boundPath: cwd }, "2026-06-26T00:00:00.000Z");
    assert.throws(
      () => store.createChannelTeamPattern(
        {
          channelId: channel.id,
          pattern: "Candidate with hidden behavior.",
          summary: "This should fail.",
          status: "candidate",
          provisionalEffect: "attention_ordering",
        },
        "2026-06-26T00:01:00.000Z",
      ),
      /provisional rule fields require provisional status/,
    );
    assert.throws(
      () => store.createChannelTeamPattern(
        {
          channelId: channel.id,
          pattern: "Approved without review.",
          summary: "This should fail.",
          status: "approved",
        },
        "2026-06-26T00:02:00.000Z",
      ),
      /candidate or provisional/,
    );
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function evidence(overrides = {}) {
  return {
    id: overrides.id ?? "evidence_default",
    workspaceId: "workspace_default",
    channelId: overrides.channelId ?? "channel_demo",
    turnId: overrides.turnId ?? "turn_demo",
    agentId: overrides.agentId ?? "teammate_builtin_security",
    kind: overrides.kind ?? "specialist_note",
    status: overrides.status ?? "completed",
    visibility: overrides.visibility ?? "folded_evidence",
    evidenceGrade: overrides.evidenceGrade ?? "observed",
    summary: overrides.summary ?? "Evidence summary.",
    concerns: overrides.concerns ?? [],
    recommendations: overrides.recommendations ?? [],
    confidence: overrides.confidence,
    sourceRefs: overrides.sourceRefs ?? [{ type: "turn", id: overrides.turnId ?? "turn_demo" }],
    payload: overrides.payload ?? {},
    expiresAt: overrides.expiresAt,
    createdAt: overrides.createdAt ?? "2026-06-26T00:01:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-26T00:01:00.000Z",
  };
}
