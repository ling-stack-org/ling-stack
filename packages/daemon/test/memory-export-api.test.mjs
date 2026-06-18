import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createDaemonServer } from "../dist/index.js";

test("memory export API previews markdown and writes projection under the resolved export root", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-export-api-"));
  const daemon = await startDaemonForTest();
  try {
    const memory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "workspace",
      ownerId: "workspace_default",
      title: "Provider secret ref",
      body: "Use env refs instead of Bearer local-token-value in docs.",
      tags: ["providers"],
      sourceRefs: [{ type: "manual", id: "manual_1", label: "Operator note" }],
      reviewState: "candidate",
    })).memory;
    await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "workspace",
      ownerId: "workspace_default",
      title: "Secret adjacent",
      body: "sk-secret-adjacent should not export by default.",
      sensitivity: "secret-adjacent",
    });
    await postJson(`${daemon.url}/memory/${encodeURIComponent(memory.id)}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "keep_candidate",
      reason: "Needs human review.",
      actor: "local-user",
    });

    const preview = await getJson(`${daemon.url}/memory/export?cwd=${encodeURIComponent(cwd)}&generatedAt=${encodeURIComponent("2026-06-18T00:00:00.000Z")}`);
    assert.equal(preview.export.memoryCount, 1);
    assert.equal(preview.export.skippedSecretAdjacentCount, 1);
    assert.equal(preview.export.items[0].reviewState, "candidate");
    assert.equal(preview.export.items[0].sensitivity, "normal");
    assert.equal(preview.export.items[0].confidence, "unknown");
    assert.match(preview.export.markdown, /"sourceRefs": \[/);
    assert.match(preview.export.markdown, /\[REDACTED\]/);
    assert.doesNotMatch(preview.export.markdown, /Bearer local-token-value/);

    const metadataOnlyPreview = await getJson(`${daemon.url}/memory/export?cwd=${encodeURIComponent(cwd)}&includeMarkdown=false`);
    assert.equal(metadataOnlyPreview.export.memoryCount, 1);
    assert.equal("markdown" in metadataOnlyPreview.export, false);

    const written = await postJson(`${daemon.url}/memory/export?cwd=${encodeURIComponent(cwd)}`, {
      fileName: "memory-export-test.md",
    });
    assert.equal(written.export.memoryCount, 1);
    assert.equal("markdown" in written.export, false);
    assert.match(written.filePath, /memory-export-test\.md$/);
    const content = await readFile(written.filePath, "utf8");
    assert.match(content, /# Ling Memory Export/);
    assert.match(content, /"reviewState": "candidate"/);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory import API previews and creates candidate-only memories", async () => {
  const sourceCwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-import-source-"));
  const targetCwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-import-target-"));
  const daemon = await startDaemonForTest();
  try {
    const original = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(sourceCwd)}`, {
      scopeType: "workspace",
      ownerId: "workspace_default",
      title: "Imported provider workflow",
      body: "Use keychain refs for imported provider memories.",
      tags: ["providers", "import"],
      sourceRefs: [{ type: "manual", id: "manual_1", label: "Operator note" }],
      reviewState: "active",
      retrievalProviderId: "vector-main",
      retrievalHandle: "vec_123",
    })).memory;
    const exported = await getJson(`${daemon.url}/memory/export?cwd=${encodeURIComponent(sourceCwd)}&includeMarkdown=true`);

    const dryRun = await postJson(`${daemon.url}/memory/import?cwd=${encodeURIComponent(targetCwd)}`, {
      markdown: exported.export.markdown,
      sourceLabel: "memory-export.md",
      dryRun: true,
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.importedCount, 0);
    assert.equal(dryRun.plan.candidateCount, 1);
    assert.equal(dryRun.plan.candidates[0].originalId, original.id);
    assert.equal(dryRun.plan.candidates[0].createInput.reviewState, "candidate");
    assert.equal(dryRun.plan.candidates[0].createInput.retrievalProviderId, undefined);
    assert.match(dryRun.plan.candidates[0].warnings.join("\n"), /Original reviewState "active" was imported as candidate/);
    assert.match(dryRun.plan.candidates[0].warnings.join("\n"), /retrievalProviderId was not imported/);
    assert.equal((await getJson(`${daemon.url}/memory?cwd=${encodeURIComponent(targetCwd)}`)).memories.length, 0);

    const imported = await postJson(`${daemon.url}/memory/import?cwd=${encodeURIComponent(targetCwd)}`, {
      markdown: exported.export.markdown,
      sourceLabel: "memory-export.md",
    });
    assert.equal(imported.dryRun, false);
    assert.equal(imported.importedCount, 1);
    assert.notEqual(imported.memories[0].id, original.id);
    assert.equal(imported.memories[0].reviewState, "candidate");
    assert.equal(imported.memories[0].enabled, true);
    assert.equal(imported.memories[0].retrievalProviderId, undefined);
    assert.equal(imported.memories[0].retrievalHandle, undefined);
    assert.deepEqual(imported.memories[0].sourceRefs.map((ref) => ref.type), ["manual", "import"]);
  } finally {
    await daemon.close();
    await rm(sourceCwd, { recursive: true, force: true });
    await rm(targetCwd, { recursive: true, force: true });
  }
});

async function startDaemonForTest() {
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return await readJsonResponse(response);
}

async function getJson(url) {
  const response = await fetch(url);
  return await readJsonResponse(response);
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${text}`);
  }
  return text.trim() ? JSON.parse(text) : {};
}
