import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { buildMemoryMarkdownExport, createSqliteRunStore, DEFAULT_WORKSPACE_ID } from "../dist/index.js";

test("memory markdown export preserves review metadata and redacts secret-like values", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-markdown-export-"));
  try {
    const store = createSqliteRunStore(cwd);
    const active = store.createMemoryObject({
      scopeType: "workspace",
      ownerId: DEFAULT_WORKSPACE_ID,
      title: "Provider token rule sk-test-secret",
      body: "Use env refs, never paste Bearer local-secret-token into provider docs.",
      tags: ["providers", "token"],
      sourceRefs: [{ type: "manual", id: "manual_1", label: "Operator note" }],
      reviewState: "active",
      sensitivity: "normal",
      verifyBeforeUse: true,
    }, "2026-06-18T00:00:00.000Z");
    const secretAdjacent = store.createMemoryObject({
      scopeType: "workspace",
      ownerId: DEFAULT_WORKSPACE_ID,
      title: "Secret adjacent deploy note",
      body: "Deploy key shape is sk-secret-adjacent.",
      sensitivity: "secret-adjacent",
    }, "2026-06-18T00:01:00.000Z");
    store.recordMemoryReviewDecision({
      memoryId: active.id,
      outcome: "manual-review",
      mode: "balanced",
      reasonCode: "manual_note",
      reason: "Preserve only after review.",
      confidence: "medium",
      requiresManualReview: true,
      targetReviewState: "active",
      targetSensitivity: "normal",
      decidedBy: "local-user",
    }, "2026-06-18T00:02:00.000Z");

    const memories = store.listMemoryObjects({ limit: 100 });
    const exportResult = buildMemoryMarkdownExport({
      memories,
      latestDecisionsByMemoryId: new Map(memories.map((memory) => [memory.id, store.getLatestMemoryReviewDecision(memory.id)])),
      metadataByMemoryId: new Map(),
      options: {
        workspaceId: DEFAULT_WORKSPACE_ID,
        generatedAt: "2026-06-18T00:03:00.000Z",
      },
    });

    assert.equal(exportResult.memoryCount, 1);
    assert.equal(exportResult.skippedSecretAdjacentCount, 1);
    assert.deepEqual(exportResult.skippedSecretAdjacentIds, [secretAdjacent.id]);
    assert.equal(exportResult.items[0].confidence, "medium");
    assert.equal(exportResult.items[0].reviewState, "active");
    assert.equal(exportResult.items[0].sensitivity, "normal");
    assert.match(exportResult.markdown, /"reviewState": "active"/);
    assert.match(exportResult.markdown, /"sensitivity": "normal"/);
    assert.match(exportResult.markdown, /"confidence": "medium"/);
    assert.match(exportResult.markdown, /"tags": \[\n\s+"providers",\n\s+"token"\n\s+\]/);
    assert.match(exportResult.markdown, /"sourceRefs": \[/);
    assert.match(exportResult.markdown, /\[REDACTED\]/);
    assert.doesNotMatch(exportResult.markdown, /sk-test-secret/);
    assert.doesNotMatch(exportResult.markdown, /Bearer local-secret-token/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
