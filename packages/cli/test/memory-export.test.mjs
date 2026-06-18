import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID } from "../../core/dist/index.js";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

test("memory export command writes a redacted markdown projection", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-memory-export-"));
  try {
    const store = createSqliteRunStore(cwd);
    try {
      store.createMemoryObject({
        scopeType: "workspace",
        ownerId: DEFAULT_WORKSPACE_ID,
        title: "Provider docs",
        body: "Use env refs instead of sk-local-secret-value in provider docs.",
        tags: ["providers"],
        sourceRefs: [{ type: "manual", id: "manual_1", label: "Operator note" }],
        reviewState: "active",
      }, "2026-06-18T00:00:00.000Z");
      store.createMemoryObject({
        scopeType: "workspace",
        ownerId: DEFAULT_WORKSPACE_ID,
        title: "Secret adjacent",
        body: "Secret adjacent memory should be skipped.",
        sensitivity: "secret-adjacent",
      }, "2026-06-18T00:01:00.000Z");
    } finally {
      store.close();
    }

    const outputPath = resolve(cwd, "memory-export.md");
    const result = await runCli(cwd, ["memory", "export", "--output", outputPath, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.outputPath, outputPath);
    assert.equal(body.export.memoryCount, 1);
    assert.equal(body.export.skippedSecretAdjacentCount, 1);
    assert.equal("markdown" in body.export, false);

    const markdown = await readFile(outputPath, "utf8");
    assert.match(markdown, /# Ling Memory Export/);
    assert.match(markdown, /"reviewState": "active"/);
    assert.match(markdown, /\[REDACTED\]/);
    assert.doesNotMatch(markdown, /sk-local-secret-value/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("memory import command creates review candidates only", async () => {
  const sourceCwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-memory-import-source-"));
  const targetCwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-memory-import-target-"));
  try {
    const sourceStore = createSqliteRunStore(sourceCwd);
    let original;
    try {
      original = sourceStore.createMemoryObject({
        scopeType: "workspace",
        ownerId: DEFAULT_WORKSPACE_ID,
        title: "Imported CLI workflow",
        body: "CLI imports should land as candidates only.",
        tags: ["cli", "import"],
        sourceRefs: [{ type: "manual", id: "manual_1", label: "Operator note" }],
        reviewState: "active",
        retrievalProviderId: "vector-main",
        retrievalHandle: "vec_123",
      }, "2026-06-18T00:00:00.000Z");
    } finally {
      sourceStore.close();
    }

    const outputPath = resolve(sourceCwd, "memory-export.md");
    const exportResult = await runCli(sourceCwd, ["memory", "export", "--output", outputPath, "--json"]);
    assert.equal(exportResult.code, 0, exportResult.stderr);

    const dryRun = await runCli(targetCwd, ["memory", "import", "--file", outputPath, "--dry-run", "--json"]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dryRunBody = JSON.parse(dryRun.stdout);
    assert.equal(dryRunBody.dryRun, true);
    assert.equal(dryRunBody.importedCount, 0);
    assert.equal(dryRunBody.plan.candidateCount, 1);
    assert.equal(dryRunBody.plan.candidates[0].originalId, original.id);
    assert.equal(dryRunBody.plan.candidates[0].createInput.reviewState, "candidate");
    assert.equal(dryRunBody.plan.candidates[0].createInput.retrievalProviderId, undefined);

    let targetStore = createSqliteRunStore(targetCwd);
    try {
      assert.equal(targetStore.listMemoryObjects({ limit: 100 }).length, 0);
    } finally {
      targetStore.close();
    }

    const importResult = await runCli(targetCwd, ["memory", "import", "--file", outputPath, "--json"]);
    assert.equal(importResult.code, 0, importResult.stderr);
    const importBody = JSON.parse(importResult.stdout);
    assert.equal(importBody.dryRun, false);
    assert.equal(importBody.importedCount, 1);
    assert.notEqual(importBody.memories[0].id, original.id);
    assert.equal(importBody.memories[0].reviewState, "candidate");
    assert.equal(importBody.memories[0].retrievalProviderId, undefined);

    targetStore = createSqliteRunStore(targetCwd);
    try {
      const memories = targetStore.listMemoryObjects({ limit: 100 });
      assert.equal(memories.length, 1);
      assert.equal(memories[0].reviewState, "candidate");
      assert.deepEqual(memories[0].sourceRefs.map((ref) => ref.type), ["manual", "import"]);
    } finally {
      targetStore.close();
    }
  } finally {
    await rm(sourceCwd, { recursive: true, force: true });
    await rm(targetCwd, { recursive: true, force: true });
  }
});

function runCli(cwd, args) {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [cliPath, "--daemon-url", "http://127.0.0.1:9", "--cwd", cwd, ...args], (error, stdout, stderr) => {
      resolveResult({
        code: typeof error?.code === "number" ? error.code : 0,
        stdout,
        stderr,
      });
    });
  });
}
