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

test("B005 skipped secret-adjacent titles are redacted and counted without exporting bodies", () => {
  const syntheticTitle = "Skipped deploy sk-b005-test-synthetic-title-secret";
  const syntheticAuthTitle = "Skipped authorization Bearer b005-test-synthetic-title-token";
  const memories = [
    markdownExportMemoryFixture({ id: "memory_b005_public", title: "Ordinary exported workflow" }),
    markdownExportMemoryFixture({ id: "memory_b005_skipped_key", title: syntheticTitle, body: "Skipped key body.", sensitivity: "secret-adjacent" }),
    markdownExportMemoryFixture({ id: "memory_b005_skipped_auth", title: syntheticAuthTitle, body: "Skipped auth body.", sensitivity: "secret-adjacent" }),
    markdownExportMemoryFixture({ id: "memory_b005_skipped_plain", title: "Ordinary skipped workflow", body: "Skipped plain body.", sensitivity: "secret-adjacent" }),
  ];
  const original = structuredClone(memories);
  for (const includeSecretAdjacent of [undefined, false]) {
    const result = buildMemoryMarkdownExport({ memories, options: {
      workspaceId: DEFAULT_WORKSPACE_ID, generatedAt: "2026-10-13T00:00:00.000Z", includeSecretAdjacent,
    } });
    assert.equal(result.memoryCount, 1);
    assert.equal(result.skippedSecretAdjacentCount, 3);
    assert.deepEqual(result.skippedSecretAdjacentIds, memories.slice(1).map(memory => memory.id));
    assert.deepEqual(result.items.map(item => item.id), [memories[0].id]);
    assert.equal(result.items[0].title, memories[0].title);
    assert.equal(result.items[0].redactionApplied, false);
    assert.equal(result.redactionApplied, true, "aggregate includes skipped-title redaction even when exported body is safe");
    assert.match(result.markdown, /"redactionApplied": true/);
    assert.match(result.markdown, /- Redaction applied: yes/);
    assert.ok(result.markdown.includes(`- \`${memories[1].id}\` Skipped deploy [REDACTED]`));
    assert.ok(result.markdown.includes(`- \`${memories[2].id}\` Skipped authorization [REDACTED]`));
    assert.ok(result.markdown.includes(`- \`${memories[3].id}\` Ordinary skipped workflow`));
    assert.ok(!JSON.stringify(result).includes(syntheticTitle));
    assert.ok(!JSON.stringify(result).includes(syntheticAuthTitle));
    for (const memory of memories.slice(1)) assert.ok(!result.markdown.includes(memory.body));
  }
  assert.deepEqual(memories, original, "projection must not mutate memory authority");
});

test("B005 explicit secret-adjacent inclusion retains IDs and redacts exported titles normally", () => {
  const syntheticSecret = "sk-b005-test-synthetic-included-title";
  const memories = [
    markdownExportMemoryFixture({ id: "memory_b005_included_plain", title: "Ordinary included workflow" }),
    markdownExportMemoryFixture({ id: "memory_b005_included_secret", title: `Included ${syntheticSecret}`, sensitivity: "secret-adjacent" }),
  ];
  const result = buildMemoryMarkdownExport({ memories, options: {
    workspaceId: DEFAULT_WORKSPACE_ID, generatedAt: "2026-10-13T00:00:00.000Z", includeSecretAdjacent: true,
  } });
  assert.equal(result.memoryCount, 2);
  assert.equal(result.skippedSecretAdjacentCount, 0);
  assert.deepEqual(result.skippedSecretAdjacentIds, []);
  assert.deepEqual(result.items.map(item => item.id), memories.map(memory => memory.id));
  assert.equal(result.items[0].title, memories[0].title);
  assert.equal(result.items[0].redactionApplied, false);
  assert.equal(result.items[1].title, "Included [REDACTED]");
  assert.equal(result.items[1].redactionApplied, true);
  assert.equal(result.redactionApplied, true);
  assert.ok(!JSON.stringify(result).includes(syntheticSecret));
  assert.doesNotMatch(result.markdown, /## Skipped Secret-Adjacent Memories/);
});

test("B005 ordinary skipped titles alone do not claim redaction", () => {
  const skippedBody = "Ignored skipped body sk-b005-test-synthetic-skipped-body-secret";
  const memory = markdownExportMemoryFixture({ id: "memory_b005_ordinary", title: "Ordinary\r\nskipped workflow", body: skippedBody, sensitivity: "secret-adjacent" });
  const result = buildMemoryMarkdownExport({ memories: [memory], options: {
    workspaceId: DEFAULT_WORKSPACE_ID, generatedAt: "2026-10-13T00:00:00.000Z",
  } });
  assert.equal(result.memoryCount, 0);
  assert.equal(result.skippedSecretAdjacentCount, 1);
  assert.deepEqual(result.skippedSecretAdjacentIds, [memory.id]);
  assert.deepEqual(result.items, []);
  assert.equal(result.redactionApplied, false);
  assert.match(result.markdown, /- Redaction applied: no/);
  assert.ok(result.markdown.includes(`- \`${memory.id}\` Ordinary skipped workflow`));
  assert.ok(!JSON.stringify(result).includes(skippedBody), "unrendered skipped body neither leaks nor claims redaction");
});

function markdownExportMemoryFixture(overrides = {}) {
  return {
    id: "memory_b005_fixture", workspaceId: DEFAULT_WORKSPACE_ID, scopeType: "workspace", ownerId: DEFAULT_WORKSPACE_ID,
    title: "Ordinary fixture", body: "Ordinary safe body.", tags: [], sourceRefs: [], reviewState: "candidate",
    enabled: true, sensitivity: "normal", verifyBeforeUse: false,
    createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z", ...overrides,
  };
}
