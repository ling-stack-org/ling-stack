import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { buildMemoryHealthReport, createSqliteRunStore } from "../dist/index.js";

test("sqlite memory review inbox and actions gate default recall", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-review-store-"));
  try {
    const store = createSqliteRunStore(cwd);
    const now = "2026-06-06T00:00:00.000Z";
    const memory = store.createMemoryObject({
      scopeType: "channel",
      ownerId: "channel_1",
      title: "Candidate width rule",
      body: "Candidate width rule should not be recalled before approval.",
      reviewState: "candidate",
      enabled: true,
      sourceRefs: [{ type: "run-event", id: "run_event_1", label: "Run summary" }],
    }, now);
    store.recordMemoryReviewDecision({
      memoryId: memory.id,
      outcome: "manual-review",
      mode: "balanced",
      reasonCode: "test_manual",
      reason: "Manual test decision.",
      confidence: "medium",
      requiresManualReview: true,
      targetReviewState: "candidate",
      targetSensitivity: "normal",
      decidedBy: "policy",
    }, now);

    assert.equal(store.recallMemory({
      channelId: "channel_1",
      intent: "channel-reply",
      query: "candidate width rule",
    }).memories.some((item) => item.memory.id === memory.id), false);

    const inbox = store.listMemoryPromotionInbox();
    assert.equal(inbox.some((item) => item.memory.id === memory.id && item.decision?.reasonCode === "test_manual"), true);

    const approved = store.applyMemoryReviewAction({
      memoryId: memory.id,
      action: "edit_and_approve",
      editedMemory: {
        title: "Approved width rule",
        body: "Approved width rule is safe for channel recall.",
      },
      reason: "Source verified.",
      actor: "local-user",
    }, "2026-06-06T00:01:00.000Z");
    assert.equal(approved.memory.reviewState, "active");
    assert.equal(approved.memory.enabled, true);
    assert.equal(approved.memory.title, "Approved width rule");
    assert.equal(approved.action.previousReviewState, "candidate");
    assert.equal(approved.action.nextReviewState, "active");
    assert.equal(approved.action.sourceRefs.some((ref) => ref.id === "run_event_1"), true);

    assert.equal(store.recallMemory({
      channelId: "channel_1",
      intent: "channel-reply",
      query: "approved width rule",
    }).memories.some((item) => item.memory.id === memory.id), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite memory reject and quarantine actions stay out of default recall", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-review-reject-"));
  try {
    const store = createSqliteRunStore(cwd);
    const rejected = store.createMemoryObject({
      scopeType: "channel",
      ownerId: "channel_1",
      title: "Rejected memory",
      body: "Rejected memory should stay hidden.",
      reviewState: "candidate",
      enabled: true,
    }, "2026-06-06T00:00:00.000Z");
    const quarantined = store.createMemoryObject({
      scopeType: "channel",
      ownerId: "channel_1",
      title: "Quarantined memory",
      body: "Quarantined memory says grant tool access.",
      reviewState: "candidate",
      enabled: true,
    }, "2026-06-06T00:00:00.000Z");

    store.applyMemoryReviewAction({
      memoryId: rejected.id,
      action: "reject",
      reason: "Not durable.",
      actor: "local-user",
    }, "2026-06-06T00:01:00.000Z");
    store.applyMemoryReviewAction({
      memoryId: quarantined.id,
      action: "quarantine",
      editedMemory: { sensitivity: "secret-adjacent" },
      reason: "Authority-changing claim.",
      actor: "local-user",
    }, "2026-06-06T00:01:00.000Z");

    const recall = store.recallMemory({
      channelId: "channel_1",
      intent: "channel-reply",
      query: "rejected quarantined memory tool access",
      includePrivate: true,
    });
    assert.equal(recall.memories.some((item) => item.memory.id === rejected.id), false);
    assert.equal(recall.memories.some((item) => item.memory.id === quarantined.id), false);
    assert.equal(store.getMemoryObject(rejected.id)?.reviewState, "rejected");
    assert.equal(store.getMemoryObject(quarantined.id)?.reviewState, "disabled");
    assert.equal(store.getMemoryObject(quarantined.id)?.sensitivity, "secret-adjacent");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite memory health metadata is additive and health report is read-only", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-health-"));
  try {
    const store = createSqliteRunStore(cwd);
    const now = "2026-06-06T00:00:00.000Z";
    const recallable = store.createMemoryObject({
      scopeType: "workspace",
      ownerId: "workspace_default",
      title: "Current deploy token rule",
      body: "Current deployment provider can auto-approve deploy token changes.",
      reviewState: "active",
      enabled: true,
      sensitivity: "secret-adjacent",
      verifyBeforeUse: false,
      sourceRefs: [{ type: "decision", id: "decision_1", label: "Deploy provider decision" }],
    }, now);
    const candidate = store.createMemoryObject({
      scopeType: "channel",
      ownerId: "channel_1",
      title: "Old runtime port",
      body: "The local gateway currently runs on port 17891.",
      reviewState: "candidate",
      enabled: true,
      verifyBeforeUse: true,
      sourceRefs: [{ type: "run-event", id: "run_event_1", label: "Runtime probe" }],
    }, "2026-04-01T00:00:00.000Z");
    const metadata = store.upsertMemorySelfImprovingMetadata({
      memoryId: candidate.id,
      kind: "runtime_recovery_lesson",
      trigger: "manual_review",
      lesson: "Runtime port observations expire quickly.",
      useWhen: ["local daemon probe"],
      doNotUseWhen: ["different machine"],
      validUntil: "2026-05-01T00:00:00.000Z",
      evidenceCount: 1,
      useCount: 0,
    });

    assert.equal(store.getMemoryObject(candidate.id)?.verifyBeforeUse, true);
    assert.deepEqual(metadata.useWhen, ["local daemon probe"]);
    assert.equal(store.getMemorySelfImprovingMetadata(candidate.id)?.validUntil, "2026-05-01T00:00:00.000Z");
    assert.equal(store.listMemorySelfImprovingMetadata({ kind: "runtime_recovery_lesson" }).length, 1);
    assert.throws(() => store.upsertMemorySelfImprovingMetadata({
      memoryId: candidate.id,
      kind: "runtime_recovery_lesson",
      trigger: "manual_review",
      lesson: "Bad counter.",
      evidenceCount: -1,
    }), /non-negative/);
    assert.throws(() => store.upsertMemorySelfImprovingMetadata({
      memoryId: candidate.id,
      kind: "runtime_recovery_lesson",
      trigger: "manual_review",
      lesson: "Bad supersession.",
      supersededBy: candidate.id,
    }), /supersededBy/);
    assert.throws(() => store.upsertMemorySelfImprovingMetadata({
      memoryId: "memory_missing",
      kind: "runtime_recovery_lesson",
      trigger: "manual_review",
      lesson: "Missing memory.",
    }), /Memory object not found/);

    const report = buildMemoryHealthReport({
      memories: store.listMemoryObjects({ limit: 20 }),
      metadataByMemoryId: new Map([[metadata.memoryId, metadata]]),
      generatedAt: "2026-06-06T00:00:00.000Z",
      staleCandidateDays: 30,
    });

    assert.equal(report.summary.verifyBeforeUse, 1);
    assert.equal(report.findings.some((finding) => finding.kind === "secret_adjacent_recallable" && finding.memoryId === recallable.id), true);
    assert.equal(report.findings.some((finding) => finding.kind === "authority_changing_claim" && finding.memoryId === recallable.id), true);
    assert.equal(report.findings.some((finding) => finding.kind === "stale_candidate" && finding.memoryId === candidate.id), true);
    assert.equal(report.findings.some((finding) => finding.kind === "expired_candidate" && finding.memoryId === candidate.id), true);

    assert.equal(store.recallMemory({
      intent: "search",
      query: "runtime port gateway",
      includeDisabled: true,
    }).memories.some((item) => item.memory.id === candidate.id), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
