import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildMemoryMarkdownExport,
  createSqliteRunStore,
  DEFAULT_WORKSPACE_ID,
  parseMemoryMarkdownImport,
} from "../dist/index.js";

test("memory markdown import turns exported memories into review candidates only", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-markdown-import-"));
  try {
    const store = createSqliteRunStore(cwd);
    const active = store.createMemoryObject({
      scopeType: "workspace",
      ownerId: DEFAULT_WORKSPACE_ID,
      title: "Provider workflow",
      body: "Use keychain refs for provider secrets.",
      tags: ["providers", "workflow"],
      sourceRefs: [{ type: "manual", id: "manual_1", label: "Operator note" }],
      reviewState: "active",
      sensitivity: "private",
      verifyBeforeUse: true,
      retrievalProviderId: "vector-main",
      retrievalHandle: "vec_123",
    }, "2026-06-18T00:00:00.000Z");
    store.recordMemoryReviewDecision({
      memoryId: active.id,
      outcome: "auto-active",
      mode: "balanced",
      reasonCode: "explicit_user_note",
      reason: "User explicitly asked to remember it.",
      confidence: "high",
      requiresManualReview: false,
      targetReviewState: "active",
      targetSensitivity: "private",
      decidedBy: "policy",
    }, "2026-06-18T00:01:00.000Z");

    const memories = store.listMemoryObjects({ limit: 100 });
    const exportResult = buildMemoryMarkdownExport({
      memories,
      latestDecisionsByMemoryId: new Map(memories.map((memory) => [memory.id, store.getLatestMemoryReviewDecision(memory.id)])),
      metadataByMemoryId: new Map(),
      options: {
        workspaceId: DEFAULT_WORKSPACE_ID,
        generatedAt: "2026-06-18T00:02:00.000Z",
      },
    });

    const plan = parseMemoryMarkdownImport(exportResult.markdown, {
      sourceId: "export-file.md",
      sourceLabel: "export-file.md",
      importedAt: "2026-06-18T00:03:00.000Z",
    });

    assert.equal(plan.kind, "ling-memory-markdown-import");
    assert.equal(plan.source.originalKind, "ling-memory-markdown-export");
    assert.equal(plan.source.originalWorkspaceId, DEFAULT_WORKSPACE_ID);
    assert.equal(plan.candidateCount, 1);
    assert.equal(plan.skippedCount, 0);
    const candidate = plan.candidates[0];
    assert.equal(candidate.originalId, active.id);
    assert.equal(candidate.title, "Provider workflow");
    assert.equal(candidate.createInput.id, undefined);
    assert.equal(candidate.createInput.reviewState, "candidate");
    assert.equal(candidate.createInput.enabled, true);
    assert.equal(candidate.createInput.sensitivity, "private");
    assert.equal(candidate.createInput.verifyBeforeUse, true);
    assert.equal(candidate.createInput.retrievalProviderId, undefined);
    assert.equal(candidate.createInput.retrievalHandle, undefined);
    assert.equal(candidate.createInput.createdBy, "ling-stack memory import");
    assert.deepEqual(candidate.createInput.tags, ["providers", "workflow"]);
    assert.deepEqual(candidate.createInput.sourceRefs?.map((ref) => ref.type), ["manual", "import"]);
    assert.match(candidate.warnings.join("\n"), /Original reviewState "active" was imported as candidate/);
    assert.match(candidate.warnings.join("\n"), /retrievalProviderId was not imported/);
    assert.match(candidate.warnings.join("\n"), /retrievalHandle was not imported/);
    assert.match(candidate.warnings.join("\n"), /latestReviewDecision was not imported/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory markdown import quarantines secret-adjacent content as disabled candidate", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-markdown-import-secret-"));
  try {
    const store = createSqliteRunStore(cwd);
    store.createMemoryObject({
      scopeType: "workspace",
      ownerId: DEFAULT_WORKSPACE_ID,
      title: "Secret-adjacent workflow",
      body: "Credential handling note with redacted values only.",
      reviewState: "active",
      sensitivity: "secret-adjacent",
      enabled: true,
    }, "2026-06-18T00:00:00.000Z");

    const memories = store.listMemoryObjects({ limit: 100 });
    const exportResult = buildMemoryMarkdownExport({
      memories,
      latestDecisionsByMemoryId: new Map(),
      metadataByMemoryId: new Map(),
      options: {
        workspaceId: DEFAULT_WORKSPACE_ID,
        generatedAt: "2026-06-18T00:01:00.000Z",
        includeSecretAdjacent: true,
      },
    });
    const plan = parseMemoryMarkdownImport(exportResult.markdown, {
      sourceLabel: "secret-export.md",
      importedAt: "2026-06-18T00:02:00.000Z",
    });

    assert.equal(plan.candidateCount, 1);
    assert.equal(plan.candidates[0].createInput.reviewState, "candidate");
    assert.equal(plan.candidates[0].createInput.sensitivity, "secret-adjacent");
    assert.equal(plan.candidates[0].createInput.enabled, false);
    assert.equal(plan.candidates[0].createInput.verifyBeforeUse, true);
    assert.match(plan.candidates[0].warnings.join("\n"), /Original reviewState "active" was imported as candidate/);
    assert.match(plan.candidates[0].warnings.join("\n"), /Original enabled flag was not restored/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
