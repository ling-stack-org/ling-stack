import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDaemonServer } from "../dist/index.js";

test("skill import preview parses supported inputs without writing drafts or registry entries", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-import-preview-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const initialSkills = await getJson(`${baseUrl}/skills?cwd=${encodeURIComponent(cwd)}`);
    const initialSkillCount = initialSkills.skills.length;

    const skillMarkdown = await postJson(`${baseUrl}/skills/import-preview?cwd=${encodeURIComponent(cwd)}`, {
      sourcePath: "SKILL.md",
      content: [
        "---",
        "name: Focused QA",
        "description: Review the current change.",
        "---",
        "",
        "Inspect the changed surface and report failures first.",
      ].join("\n"),
    });
    assert.equal(skillMarkdown.preview.source, "skill-directory");
    assert.equal(skillMarkdown.preview.sourcePath, "SKILL.md");
    assert.equal(skillMarkdown.preview.definitions[0].definition.id, "focused-qa");
    assert.equal("workflowPhase" in skillMarkdown.preview.definitions[0].definition, false);
    assert.equal("id" in skillMarkdown.preview, false);

    const agentsMarkdown = await postJson(`${baseUrl}/skills/import-preview?cwd=${encodeURIComponent(cwd)}`, {
      sourcePath: "AGENTS.md",
      content: "# Careful reviewer\n\nReview changes carefully and report concrete evidence.",
    });
    assert.equal(agentsMarkdown.preview.source, "agents-md");

    const jsonPreview = await postJson(`${baseUrl}/skills/import-preview?cwd=${encodeURIComponent(cwd)}`, {
      content: JSON.stringify({
        name: "JSON QA",
        summary: "Review a JSON-defined workflow.",
        workflowPhase: "test",
        prompt: "Review the current change.",
      }),
    });
    assert.equal(jsonPreview.preview.source, "custom");
    assert.equal(jsonPreview.preview.definitions[0].definition.id, "json-qa");
    assert.equal("workflowPhase" in jsonPreview.preview.definitions[0].definition, false);

    const duplicatePreview = await postJson(`${baseUrl}/skills/import-preview?cwd=${encodeURIComponent(cwd)}`, {
      content: JSON.stringify({
        id: "implement",
        name: "Implementation duplicate",
        summary: "Conflicts with a built-in skill.",
      }),
    });
    assert.equal(duplicatePreview.preview.definitions[0].warnings.some((warning) => warning.code === "duplicate_skill_id" && warning.severity === "error"), true);

    const listedAfterPreview = await getJson(`${baseUrl}/skills?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listedAfterPreview.skills.length, initialSkillCount);

    const database = new DatabaseSync(resolve(cwd, ".ling-stack", "ling-stack.sqlite"));
    try {
      const row = database.prepare("SELECT COUNT(*) AS count FROM skill_import_drafts").get();
      assert.equal(Number(row.count), 0);
    } finally {
      database.close();
    }
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill hard delete only removes unbound manually imported skills", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-hard-delete-api-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const draft = await postJson(`${baseUrl}/skills/import-draft?cwd=${encodeURIComponent(cwd)}`, {
      content: [
        "---",
        "name: Disposable skill",
        "description: A manually imported fixture.",
        "---",
        "",
        "Use this only for deletion testing.",
      ].join("\n"),
    });
    const published = await postJson(`${baseUrl}/skills/import-drafts/${encodeURIComponent(draft.draft.id)}/publish?cwd=${encodeURIComponent(cwd)}`, {});
    const skillId = published.skills[0].id;

    const blockedBuiltin = await postJsonResponse(`${baseUrl}/skills/implement/hard-delete?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(blockedBuiltin.status, 409);
    assert.equal((await blockedBuiltin.json()).error, "skill_delete_not_imported");

    const deleted = await postJson(`${baseUrl}/skills/${encodeURIComponent(skillId)}/hard-delete?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(deleted.deletedSkillId, skillId);
    const listed = await getJson(`${baseUrl}/skills?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(listed.skills.some((skill) => skill.id === skillId), false);

    const boundDraft = await postJson(`${baseUrl}/skills/import-draft?cwd=${encodeURIComponent(cwd)}`, {
      content: "# Bound skill\n\nA manually imported bound fixture.",
    });
    const boundPublished = await postJson(`${baseUrl}/skills/import-drafts/${encodeURIComponent(boundDraft.draft.id)}/publish?cwd=${encodeURIComponent(cwd)}`, {});
    const boundSkillId = boundPublished.skills[0].id;

    const database = new DatabaseSync(resolve(cwd, ".ling-stack", "ling-stack.sqlite"));
    try {
      const teammate = database.prepare("SELECT id FROM ai_teammates ORDER BY id LIMIT 1").get();
      assert.ok(teammate && typeof teammate.id === "string");
      database.prepare(`
        INSERT INTO teammate_skill_bindings (teammate_id, skill_id, source, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(teammate.id, boundSkillId, "user", 1, "2026-07-12T00:00:00.000Z", "2026-07-12T00:00:00.000Z");
    } finally {
      database.close();
    }

    const blockedBound = await postJsonResponse(`${baseUrl}/skills/${encodeURIComponent(boundSkillId)}/hard-delete?cwd=${encodeURIComponent(cwd)}`, {});
    assert.equal(blockedBound.status, 409);
    const blockedPayload = await blockedBound.json();
    assert.equal(blockedPayload.error, "skill_delete_blocked");
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

async function postJsonResponse(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
