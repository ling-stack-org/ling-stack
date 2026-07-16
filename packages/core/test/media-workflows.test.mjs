import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSqliteRunStore, resolveRuntimePaths } from "../dist/index.js";

const createdAt = "2026-07-14T01:00:00.000Z";

test("media workflow storage preserves direct jobs and immutable workflow versions", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-media-workflows-"));
  let store = createSqliteRunStore(cwd);
  try {
    const directJob = store.createMediaJob({
      providerPresetId: "provider_seedance",
      operation: "video_generate",
      prompt: "Direct Seedance scene",
      input: { ratio: "16:9", duration: 5 },
    }, createdAt);
    assert.deepEqual(directJob.executionSource, { kind: "provider", providerPresetId: "provider_seedance" });

    const connection = store.createMediaWorkflowConnection({
      name: "Local ComfyUI",
      baseUrl: "http://127.0.0.1:8188",
      authMode: "none",
      networkPolicy: "trusted_private_network",
    }, createdAt);
    const definition = store.createMediaWorkflowDefinition({
      connectionId: connection.id,
      name: "Storyboard video",
    }, createdAt);
    const firstVersion = store.createMediaWorkflowVersion({
      workflowDefinitionId: definition.id,
      sourceDigest: "digest-v1",
      graphSnapshot: graph("first prompt"),
      inputFields: [promptField()],
      outputRules: [{ nodeId: "9", artifactType: "video", collect: "all" }],
      validation: { ok: true, errors: [], warnings: [], checkedAt: createdAt },
    }, createdAt);
    const secondVersion = store.createMediaWorkflowVersion({
      workflowDefinitionId: definition.id,
      sourceDigest: "digest-v2",
      graphSnapshot: graph("second prompt"),
      inputFields: [promptField()],
      outputRules: [{ nodeId: "9", artifactType: "video", collect: "first" }],
      validation: { ok: true, errors: [], warnings: [], checkedAt: createdAt },
    }, "2026-07-14T01:01:00.000Z");
    assert.equal(firstVersion.version, 1);
    assert.equal(secondVersion.version, 2);
    assert.equal(store.getMediaWorkflowVersion(firstVersion.id).graphSnapshot["1"].inputs.text, "first prompt");

    const workflowJob = store.createMediaJob({
      workflowVersionId: secondVersion.id,
      operation: "video_generate",
      prompt: "Workflow scene",
      input: { workflowInputValues: { "1.text": "Workflow scene" } },
    }, createdAt);
    assert.deepEqual(workflowJob.executionSource, { kind: "workflow", workflowVersionId: secondVersion.id });

    const project = store.createMediaProject({
      name: "Mixed production",
      defaultProviderPresetId: "provider_seedance",
    }, createdAt);
    const scene = store.createMediaScene({
      projectId: project.id,
      title: "Opening",
      prompt: "Opening scene",
    }, createdAt);
    assert.equal(project.defaultExecutionMode, "direct");
    assert.equal(scene.executionMode, "inherit");

    assert.throws(() => store.deleteMediaWorkflowDefinition(definition.id), /run history/i);
    assert.throws(() => store.deleteMediaWorkflowConnection(connection.id), /referenced/i);
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    const directJob = store.listMediaJobs({ providerPresetId: "provider_seedance" })[0];
    assert.equal(directJob.executionSource.kind, "provider");
    assert.equal(store.listMediaWorkflowConnections().length, 1);
    assert.equal(store.listMediaWorkflowDefinitions().length, 1);
    assert.equal(store.listMediaWorkflowVersions(store.listMediaWorkflowDefinitions()[0].id).length, 2);
  } finally {
    store.close();
  }

  const databasePath = resolveRuntimePaths(cwd).databasePath;
  const database = new DatabaseSync(databasePath);
  try {
    assert.ok(database.prepare("SELECT version FROM schema_migrations WHERE version = 104 AND name = 'create_media_external_workflows'").get());
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    database.prepare("DELETE FROM schema_migrations WHERE version = 104").run();
  } finally {
    database.close();
  }

  store = createSqliteRunStore(cwd);
  store.close();
  const reopened = new DatabaseSync(databasePath);
  try {
    assert.deepEqual(reopened.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM media_workflow_versions").get().count, 2);
    assert.ok(reopened.prepare("SELECT version FROM schema_migrations WHERE version = 104").get());
  } finally {
    reopened.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

function graph(prompt) {
  return {
    "1": { class_type: "CLIPTextEncode", inputs: { text: prompt } },
    "9": { class_type: "SaveVideo", inputs: { filename_prefix: "Ling" } },
  };
}

function promptField() {
  return {
    id: "1.text",
    label: "提示词",
    kind: "text",
    semantic: "prompt",
    required: true,
    nodeId: "1",
    inputName: "text",
  };
}
