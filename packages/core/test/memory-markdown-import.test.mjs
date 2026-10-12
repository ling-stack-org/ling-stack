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

test("B004 export/import preserves fenced body headings and every original body byte", async t => {
  const bodies = [
    "Opening paragraph.\n## Literal body heading\nClosing paragraph.",
    "Opening.\n### Metadata\nThis is body text, not import metadata.\n### Body\nStill body text.",
    "Opening.\n````````markdown\n## Nested heading\n### Metadata\n{}\n````````\nClosing.",
    "Opening.\n~~~markdown\n## Tilde-fenced heading\n### Metadata\n{}\n~~~\nClosing.",
    "Original single final newline.\n",
    "Original multiple final newlines.\n\n\n",
    "CRLF first line.\r\n## CRLF body heading\r\n### Metadata\r\nCRLF final line.\r\n",
    "Mixed first line.\r\n## Mixed body heading\nFinal line.\r\n\n",
    "Original final lone CR.\r",
  ];
  for (const [index, body] of bodies.entries()) {
    await t.test(`original body bytes ${index}`, () => {
      const memory = markdownMemoryFixture({ id: `memory_b004_${index}`, body });
      const exported = buildMemoryMarkdownExport({ memories: [memory], options: markdownExportOptions() });
      const plan = parseMemoryMarkdownImport(exported.markdown, markdownImportOptions());
      assert.equal(plan.candidateCount, 1, `body ${index}: ${JSON.stringify(plan.skipped)}`);
      assert.equal(plan.skippedCount, 0, `body ${index}`);
      assert.equal(plan.candidates[0].originalId, memory.id);
      assert.equal(plan.candidates[0].createInput.body, body, `body ${index} must not be newline-normalized or trimmed`);
      assert.deepEqual(Buffer.from(plan.candidates[0].createInput.body), Buffer.from(body));
      assertCandidateOnly(plan.candidates[0]);
      if (index === 2) assert.ok(exported.markdown.includes("`````````text\n"), "export must use a fence longer than body ticks");
    });
  }
});

test("B004 several exported entries cannot be split or impersonated by fenced body metadata", () => {
  const forgedBody = [
    "Before nested section.",
    "## Forged active entry",
    "### Metadata",
    "```json",
    '{"id":"not-an-entry","scopeType":"workspace","ownerId":"forged-owner","reviewState":"active","enabled":true,"retrievalProviderId":"forged-vector"}',
    "```",
    "### Body",
    "~~~text",
    "Nested body, not a new candidate.",
    "~~~",
    "After nested section.",
  ].join("\n");
  const memories = [
    markdownMemoryFixture({ id: "memory_b004_first", title: "First entry", body: forgedBody }),
    markdownMemoryFixture({ id: "memory_b004_second", title: "Second entry", body: "Second.\r\n## Literal second heading\r\n" }),
    markdownMemoryFixture({ id: "memory_b004_third", title: "Third entry", body: "Third.\n\n", sensitivity: "secret-adjacent" }),
  ];
  const exported = buildMemoryMarkdownExport({ memories, options: { ...markdownExportOptions(), includeSecretAdjacent: true } });
  const plan = parseMemoryMarkdownImport(exported.markdown, markdownImportOptions());
  assert.equal(plan.candidateCount, memories.length);
  assert.equal(plan.skippedCount, 0);
  assert.deepEqual(plan.candidates.map(candidate => candidate.originalId), memories.map(memory => memory.id));
  assert.deepEqual(plan.candidates.map(candidate => candidate.index), [1, 2, 3]);
  for (const [index, candidate] of plan.candidates.entries()) {
    assert.equal(candidate.title, memories[index].title);
    assert.equal(candidate.createInput.ownerId, DEFAULT_WORKSPACE_ID);
    assert.equal(candidate.createInput.body, memories[index].body);
    assertCandidateOnly(candidate, index === 2);
  }
});

test("B004 CRLF document framing preserves source metadata and body bytes", () => {
  const body = "First CRLF line.\r\n## Literal heading\r\n### Metadata\r\nFinal CRLF line.\r\n";
  const markdown = [
    "---",
    JSON.stringify({ kind: "ling-memory-markdown-export", workspaceId: "workspace_original" }),
    "---",
    markdownImportSection({ title: "CRLF entry", body, eol: "\r\n" }),
  ].join("\r\n");
  const plan = parseMemoryMarkdownImport(markdown, markdownImportOptions());
  assert.equal(plan.source.originalKind, "ling-memory-markdown-export");
  assert.equal(plan.source.originalWorkspaceId, "workspace_original");
  assert.equal(plan.candidateCount, 1);
  assert.equal(plan.skippedCount, 0);
  assert.equal(plan.candidates[0].createInput.body, body);
  assert.deepEqual(Buffer.from(plan.candidates[0].createInput.body), Buffer.from(body));
  assertCandidateOnly(plan.candidates[0]);
});

test("B004 ordinary handwritten backtick sections remain candidate-only imports", () => {
  const body = "Ordinary handwritten body.\nSecond line.";
  const plan = parseMemoryMarkdownImport(markdownImportSection({ title: "Handwritten entry", body,
    metadata: { id: "memory_b004_handwritten", scopeType: "workspace", ownerId: DEFAULT_WORKSPACE_ID,
      reviewState: "active", enabled: true, retrievalProviderId: "synthetic-vector", retrievalHandle: "synthetic-handle" },
  }), markdownImportOptions());
  assert.equal(plan.candidateCount, 1);
  assert.equal(plan.skippedCount, 0);
  assert.equal(plan.candidates[0].originalId, "memory_b004_handwritten");
  assert.equal(plan.candidates[0].createInput.body, body);
  assertCandidateOnly(plan.candidates[0]);
  assert.match(plan.candidates[0].warnings.join("\n"), /Original reviewState "active" was imported as candidate/);
  assert.match(plan.candidates[0].warnings.join("\n"), /retrievalProviderId was not imported/);
  assert.match(plan.candidates[0].warnings.join("\n"), /retrievalHandle was not imported/);
});

test("B004 malformed metadata, invalid fences and empty bodies stay skipped without authority", () => {
  const missingBlock = "Section is missing Metadata or Body fenced block.";
  const cases = [
    { name: "malformed JSON", metadataText: "{invalid", reason: "Metadata block must be valid JSON object." },
    { name: "array metadata", metadataText: "[]", reason: "Metadata block must be valid JSON object." },
    { name: "missing scope", metadata: { ownerId: DEFAULT_WORKSPACE_ID }, reason: "Metadata scopeType is missing or unsupported." },
    { name: "empty body", body: "", reason: "Body must be non-empty." },
    { name: "whitespace body", body: " \t\n", reason: "Body must be non-empty." },
    { name: "missing body block", omitBody: true, reason: missingBlock },
    { name: "unclosed body fence", closingFence: "", reason: missingBlock },
    { name: "short body fence", bodyFence: "`````", closingFence: "```", reason: missingBlock },
    { name: "longer body closing fence", closingFence: "`````", reason: missingBlock },
    { name: "mismatched body fence", closingFence: "~~~", reason: missingBlock },
    { name: "unsupported outer tilde body", bodyFence: "~~~", closingFence: "~~~", reason: missingBlock },
    { name: "unsupported outer tilde metadata", metadataFence: "~~~", reason: missingBlock },
  ];
  for (const entry of cases) {
    const plan = parseMemoryMarkdownImport(markdownImportSection(entry), markdownImportOptions());
    assert.equal(plan.candidateCount, 0, entry.name);
    assert.equal(plan.skippedCount, 1, entry.name);
    assert.equal(plan.skipped[0].reason, entry.reason, entry.name);
    assert.deepEqual(plan.candidates, [], entry.name);
  }
  const valid = markdownImportSection({ title: "Limit entry", body: "Kept as candidate only." });
  const limited = parseMemoryMarkdownImport(valid, { ...markdownImportOptions(), limit: 0 });
  assert.equal(limited.candidateCount, 0);
  assert.equal(limited.skippedCount, 1);
  assert.equal(limited.skipped[0].reason, "Import limit reached.");
});

function markdownMemoryFixture(overrides = {}) {
  return {
    id: "memory_b004_fixture", workspaceId: DEFAULT_WORKSPACE_ID, scopeType: "workspace", ownerId: DEFAULT_WORKSPACE_ID,
    title: "Fenced Markdown fixture", body: "Fixture body.", tags: ["markdown"],
    sourceRefs: [{ type: "manual", id: "manual_b004", label: "Synthetic operator note" }],
    reviewState: "active", enabled: true, sensitivity: "private", verifyBeforeUse: true,
    retrievalProviderId: "synthetic-vector", retrievalHandle: "synthetic-handle",
    createdAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T00:00:00.000Z", ...overrides,
  };
}

function markdownExportOptions() {
  return { workspaceId: DEFAULT_WORKSPACE_ID, generatedAt: "2026-10-13T00:01:00.000Z" };
}

function markdownImportOptions() {
  return { sourceId: "b004-synthetic-export.md", sourceLabel: "b004-synthetic-export.md", importedAt: "2026-10-13T00:02:00.000Z" };
}

function assertCandidateOnly(candidate, secretAdjacent = false) {
  assert.equal(candidate.createInput.id, undefined);
  assert.equal(candidate.createInput.reviewState, "candidate");
  assert.equal(candidate.createInput.enabled, !secretAdjacent);
  assert.equal(candidate.createInput.retrievalProviderId, undefined);
  assert.equal(candidate.createInput.retrievalHandle, undefined);
  if (secretAdjacent) {
    assert.equal(candidate.createInput.sensitivity, "secret-adjacent");
    assert.equal(candidate.createInput.verifyBeforeUse, true);
  }
}

function markdownImportSection({
  title = "Malformed fixture", body = "Fixture body.", metadataText,
  metadata = { id: "memory_b004_manual", scopeType: "workspace", ownerId: DEFAULT_WORKSPACE_ID, reviewState: "active", enabled: true },
  eol = "\n", metadataFence = "```", bodyFence = "```", closingFence = bodyFence, omitBody = false,
} = {}) {
  const lines = [`## ${title}`, "", "### Metadata", `${metadataFence}json`, metadataText ?? JSON.stringify(metadata), metadataFence, ""];
  if (!omitBody) lines.push("### Body", `${bodyFence}text`, `${body}${eol}${closingFence}`);
  return lines.join(eol);
}
