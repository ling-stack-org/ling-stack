import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createDaemonServer } from "../dist/index.js";

test("memory export API previews markdown and writes projection under the resolved export root", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-export-api-"));
  const daemon = await startDaemonForTest(cwd);
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
  const daemon = await startDaemonForTest(sourceCwd);
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

test("B004 B005 GET and file export share safe skipped titles and exact candidate body", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-b004-b005-api-"));
  const daemon = await startDaemonForTest(cwd);
  try {
    const body = "Safe first line.\r\n## Literal body heading\r\n### Metadata\r\nSafe final line.\r\n";
    const memory = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "workspace", ownerId: "workspace_default", title: "Ordinary B004 workflow", body,
      reviewState: "active", retrievalProviderId: "synthetic-vector", retrievalHandle: "synthetic-handle",
    })).memory;
    const syntheticSecret = "sk-b005-test-synthetic-api-title-secret";
    const skipped = (await postJson(`${daemon.url}/memory?cwd=${encodeURIComponent(cwd)}`, {
      scopeType: "workspace", ownerId: "workspace_default", title: `Skipped deploy ${syntheticSecret}`,
      body: "Skipped body remains private.", sensitivity: "secret-adjacent",
    })).memory;
    const generatedAt = "2026-10-13T00:00:00.000Z";
    const query = `cwd=${encodeURIComponent(cwd)}&generatedAt=${encodeURIComponent(generatedAt)}`;
    const preview = await getJson(`${daemon.url}/memory/export?${query}`);
    assert.equal(preview.export.memoryCount, 1);
    assert.equal(preview.export.skippedSecretAdjacentCount, 1);
    assert.deepEqual(preview.export.skippedSecretAdjacentIds, [skipped.id]);
    assert.equal(preview.export.redactionApplied, true, "only the skipped title needs redaction");
    assert.equal(preview.export.items[0].redactionApplied, false);
    assert.ok(preview.export.markdown.includes(`- \`${skipped.id}\` Skipped deploy [REDACTED]`));
    assert.ok(!JSON.stringify(preview).includes(syntheticSecret));
    assert.ok(!preview.export.markdown.includes(skipped.body));

    const metadataOnly = await getJson(`${daemon.url}/memory/export?${query}&includeMarkdown=false`);
    assert.equal("markdown" in metadataOnly.export, false);
    assert.equal(metadataOnly.export.redactionApplied, true);
    assert.deepEqual(metadataOnly.export.skippedSecretAdjacentIds, [skipped.id]);
    const written = await postJson(`${daemon.url}/memory/export?cwd=${encodeURIComponent(cwd)}`, {
      generatedAt, fileName: "b004-b005-safe-export.md",
    });
    assert.equal("markdown" in written.export, false);
    assert.equal(written.export.redactionApplied, true);
    assert.deepEqual(written.export.skippedSecretAdjacentIds, [skipped.id]);
    const content = await readFile(written.filePath, "utf8");
    assert.equal(content, preview.export.markdown, "GET and POST file must use the same shared projection");
    assert.ok(!content.includes(syntheticSecret));

    const dryRun = await postJson(`${daemon.url}/memory/import?cwd=${encodeURIComponent(cwd)}`, {
      markdown: content, sourceLabel: "b004-b005-safe-export.md", dryRun: true,
    });
    assert.equal(dryRun.importedCount, 0);
    assert.equal(dryRun.plan.candidateCount, 1);
    assert.equal(dryRun.plan.skippedCount, 0);
    assert.equal(dryRun.plan.candidates[0].originalId, memory.id);
    assert.equal(dryRun.plan.candidates[0].createInput.body, body);
    assert.equal(dryRun.plan.candidates[0].createInput.reviewState, "candidate");
    assert.equal(dryRun.plan.candidates[0].createInput.retrievalProviderId, undefined);
    assert.equal(dryRun.plan.candidates[0].createInput.retrievalHandle, undefined);

    const included = await getJson(`${daemon.url}/memory/export?${query}&includeSecretAdjacent=true`);
    assert.equal(included.export.memoryCount, 2);
    assert.equal(included.export.skippedSecretAdjacentCount, 0);
    assert.deepEqual(included.export.skippedSecretAdjacentIds, []);
    assert.ok(!JSON.stringify(included).includes(syntheticSecret));
    assert.ok(included.export.items.some(item => item.id === skipped.id && item.title === "Skipped deploy [REDACTED]"));
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function startDaemonForTest(defaultWorkspaceCwd) {
  assert.ok(defaultWorkspaceCwd, "every fixture daemon must start in an explicit owned workspace");
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd });
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
