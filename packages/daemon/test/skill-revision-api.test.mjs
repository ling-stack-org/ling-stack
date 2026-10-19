import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createDaemonServer } from "../dist/index.js";

test("skill revision preview is side-effect free and publication preserves ownership", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-revision-api-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const created = await publishImportedSkill(baseUrl, cwd, {
      id: "editable-api-skill",
      name: "Editable API skill",
      summary: "Original summary",
      promptFragments: ["Read the request."],
      requiredTools: ["read"],
      requiredProviderCapabilities: ["chat"],
      approvalProfile: { mode: "none" },
    });
    const databasePath = resolve(cwd, ".ling-stack", "ling-stack.sqlite");
    const beforePreviewDraftCount = countDrafts(databasePath);
    const preview = await postJson(`${baseUrl}/skills/${created.id}/revision-preview?cwd=${encodeURIComponent(cwd)}`, {
      expectedUpdatedAt: created.updatedAt,
      definition: {
        name: "Edited API skill",
        summary: "Updated through a revision.",
        promptFragments: ["Read the request and report the result."],
        requiredTools: ["read"],
        requiredProviderCapabilities: ["chat"],
        approvalProfile: { mode: "none" },
      },
    });
    assert.equal(preview.preview.definition.id, created.id);
    assert.equal(preview.preview.requiresConfirmation, false);
    assert.equal(preview.preview.canPublish, true);
    assert.equal(countDrafts(databasePath), beforePreviewDraftCount);

    const published = await postJson(`${baseUrl}/skills/${created.id}/revisions?cwd=${encodeURIComponent(cwd)}`, {
      expectedUpdatedAt: created.updatedAt,
      definition: preview.preview.definition,
    });
    assert.equal(published.skill.definition.name, "Edited API skill");
    assert.equal(published.skill.id, created.id);
    assert.equal(published.skill.packId, created.packId);
    assert.equal(published.skill.source, created.source);
    assert.equal(published.skill.sourcePath, created.sourcePath);
    assert.equal(published.skill.reviewStatus, created.reviewStatus);

    const authorityPreview = await postJson(`${baseUrl}/skills/${created.id}/revision-preview?cwd=${encodeURIComponent(cwd)}`, {
      expectedUpdatedAt: published.skill.updatedAt,
      definition: {
        name: published.skill.definition.name,
        summary: published.skill.definition.summary,
        promptFragments: published.skill.definition.promptFragments,
        requiredTools: ["read", "bash"],
        requiredProviderCapabilities: ["chat", "reasoning"],
        approvalProfile: { mode: "strict", risk: "high", requiredForTools: ["bash"] },
      },
    });
    assert.equal(authorityPreview.preview.requiresConfirmation, true);
    assert.equal(authorityPreview.preview.authorityDiff.requiredToolsChanged, true);
    assert.equal(authorityPreview.preview.authorityDiff.approvalProfileChanged, true);

    const missingConfirmation = await postJsonResponse(`${baseUrl}/skills/${created.id}/revisions?cwd=${encodeURIComponent(cwd)}`, {
      expectedUpdatedAt: published.skill.updatedAt,
      definition: authorityPreview.preview.definition,
    });
    assert.equal(missingConfirmation.status, 409);
    assert.equal((await missingConfirmation.json()).error, "skill_revision_confirmation_required");

    const confirmed = await postJson(`${baseUrl}/skills/${created.id}/revisions?cwd=${encodeURIComponent(cwd)}`, {
      expectedUpdatedAt: published.skill.updatedAt,
      definition: authorityPreview.preview.definition,
      confirmAuthorityChanges: true,
    });
    assert.deepEqual(confirmed.skill.definition.requiredTools, ["read", "bash"]);
    assert.equal(confirmed.skill.definition.approvalProfile.mode, "strict");

    const stale = await postJsonResponse(`${baseUrl}/skills/${created.id}/revisions?cwd=${encodeURIComponent(cwd)}`, {
      expectedUpdatedAt: published.skill.updatedAt,
      definition: authorityPreview.preview.definition,
      confirmAuthorityChanges: true,
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, "skill_revision_conflict");
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill revision approval action decoder rejects unknown actions and accepts Host capability", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-revision-actions-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const skill = await publishImportedSkill(baseUrl, cwd, {
      id: "approval-action-decoder-skill",
      name: "Approval action decoder skill",
      summary: "Verify the runtime approval action closed set.",
      promptFragments: ["Use only the declared Host capability."],
      requiredTools: ["read"],
      requiredProviderCapabilities: ["chat"],
      approvalProfile: { mode: "none" },
    });
    const definition = {
      name: skill.definition.name,
      summary: skill.definition.summary,
      promptFragments: skill.definition.promptFragments,
      requiredTools: skill.definition.requiredTools,
      requiredProviderCapabilities: skill.definition.requiredProviderCapabilities,
      approvalProfile: { mode: "strict", risk: "medium", requiredForActions: ["unknown_host_action"] },
    };
    const invalid = await postJsonResponse(
      `${baseUrl}/skills/${skill.id}/revision-preview?cwd=${encodeURIComponent(cwd)}`,
      { expectedUpdatedAt: skill.updatedAt, definition });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "skill_revision_invalid");

    definition.approvalProfile.requiredForActions = ["host_capability"];
    const preview = await postJson(
      `${baseUrl}/skills/${skill.id}/revision-preview?cwd=${encodeURIComponent(cwd)}`,
      { expectedUpdatedAt: skill.updatedAt, definition });
    assert.deepEqual(preview.preview.definition.approvalProfile.requiredForActions, ["host_capability"]);
    assert.equal(preview.preview.requiresConfirmation, true);
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("skill revision rejects read-only sources and preserves AI candidate lineage", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-revision-ai-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0 });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const skills = await getJson(`${baseUrl}/skills?cwd=${encodeURIComponent(cwd)}`);
    const builtin = skills.skills.find((skill) => skill.source === "builtin");
    assert.ok(builtin);
    const builtinResponse = await postJsonResponse(`${baseUrl}/skills/${builtin.id}/revision-preview?cwd=${encodeURIComponent(cwd)}`, revisionBody(builtin));
    assert.equal(builtinResponse.status, 409);
    assert.equal((await builtinResponse.json()).error, "skill_not_editable");

    const workspaceSkill = await publishImportedSkill(baseUrl, cwd, {
      id: "workspace-managed-skill",
      name: "Workspace managed skill",
      summary: "Workspace managed skill",
      promptFragments: ["Keep this source read-only."],
      requiredTools: ["read"],
      requiredProviderCapabilities: ["chat"],
      approvalProfile: { mode: "none" },
    }, "workspace");
    const workspaceResponse = await postJsonResponse(`${baseUrl}/skills/${workspaceSkill.id}/revision-preview?cwd=${encodeURIComponent(cwd)}`, revisionBody(workspaceSkill));
    assert.equal(workspaceResponse.status, 409);
    assert.equal((await workspaceResponse.json()).error, "skill_not_editable");

    const candidateId = "skill_candidate_revision_ai";
    await postJson(`${baseUrl}/skill-candidates?cwd=${encodeURIComponent(cwd)}`, {
      id: candidateId,
      origin: "ling-generated",
      title: "AI revision skill",
      summary: "An AI-evolved skill used to verify revision lineage.",
      definition: {
        positiveTriggers: ["repeat AI revision flow"],
        negativeTriggers: ["one-off request"],
        procedureSteps: [{ title: "Review input", instruction: "Read the input." }],
        validationSteps: [{ title: "Verify output", expectedResult: "The result is complete." }],
        requiredTools: ["read"],
        requiredProviderCapabilities: ["chat"],
      },
      sourceRefs: [{ type: "manual", id: "ai-revision-source" }],
    });
    await postJson(`${baseUrl}/skill-candidates/${candidateId}/review?cwd=${encodeURIComponent(cwd)}`, {
      action: "approve_for_draft",
      reason: "The candidate has validation evidence.",
    });
    const candidateDraft = await postJson(`${baseUrl}/skill-candidates/${candidateId}/draft?cwd=${encodeURIComponent(cwd)}`, {
      content: JSON.stringify({
        name: "AI revision skill",
        description: "AI revision skill",
        skills: [{
          id: "ai-revision-skill",
          name: "AI revision skill",
          summary: "AI revision skill",
          promptFragments: ["Read the input and produce the result."],
          requiredTools: ["read"],
          requiredProviderCapabilities: ["chat"],
          approvalProfile: { mode: "none" },
          roleAffinity: ["custom"],
          stateEffects: [],
        }],
      }),
    });
    const candidatePublished = await postJson(`${baseUrl}/skills/import-drafts/${candidateDraft.draft.id}/publish?cwd=${encodeURIComponent(cwd)}`, {});
    const aiSkill = candidatePublished.skills[0];
    assert.equal(aiSkill.packId, "ling-generated");
    assert.equal(aiSkill.sourcePath, `skill-candidates/${candidateId}`);

    const revised = await postJson(`${baseUrl}/skills/${aiSkill.id}/revisions?cwd=${encodeURIComponent(cwd)}`, {
      expectedUpdatedAt: aiSkill.updatedAt,
      definition: {
        name: "AI revision skill edited",
        summary: "Edited without losing AI ownership.",
        promptFragments: ["Use the edited AI instructions."],
        requiredTools: aiSkill.definition.requiredTools,
        requiredProviderCapabilities: aiSkill.definition.requiredProviderCapabilities,
        approvalProfile: aiSkill.definition.approvalProfile,
      },
    });
    assert.equal(revised.skill.packId, "ling-generated");
    assert.equal(revised.skill.sourcePath, `skill-candidates/${candidateId}`);
    const candidate = await getJson(`${baseUrl}/skill-candidates/${candidateId}?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(candidate.candidate.status, "published");
  } finally {
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function publishImportedSkill(baseUrl, cwd, definition, source = "custom") {
  const draft = await postJson(`${baseUrl}/skills/import-draft?cwd=${encodeURIComponent(cwd)}`, {
    source,
    sourcePath: source === "workspace" ? "workspace/SKILL.md" : "imported-skill.json",
    content: JSON.stringify({ name: `${definition.name} pack`, skills: [definition] }),
  });
  const published = await postJson(`${baseUrl}/skills/import-drafts/${draft.draft.id}/publish?cwd=${encodeURIComponent(cwd)}`, {});
  return published.skills[0];
}

function revisionBody(skill) {
  return {
    expectedUpdatedAt: skill.updatedAt,
    definition: {
      name: skill.definition.name,
      summary: skill.definition.summary,
      promptFragments: skill.definition.promptFragments,
      requiredTools: skill.definition.requiredTools,
      requiredProviderCapabilities: skill.definition.requiredProviderCapabilities,
      approvalProfile: skill.definition.approvalProfile,
    },
  };
}

function countDrafts(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    return Number(database.prepare("SELECT COUNT(*) AS count FROM skill_import_drafts").get().count);
  } finally {
    database.close();
  }
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function postJson(url, body) {
  const response = await postJsonResponse(url, body);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function postJsonResponse(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
