import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  DEFAULT_WORKSPACE_ID,
  createSqliteRunStore,
  getBuiltinAutomationTemplate,
} from "../dist/index.js";

const now = "2026-07-12T00:00:00.000Z";

function definition(id) {
  return {
    id,
    name: `Skill ${id}`,
    summary: `Summary for ${id}.`,
    roleAffinity: ["engineer"],
    promptFragments: ["Read the request and complete the scoped task."],
    requiredTools: ["read"],
    requiredProviderCapabilities: ["chat"],
    approvalProfile: { mode: "none" },
    stateEffects: [],
  };
}

async function publishSkill(store, id, source = "custom") {
  const draft = store.createSkillImportDraft({
    source,
    name: `Pack ${id}`,
    description: `Pack for ${id}.`,
    definitions: [{ definition: definition(id) }],
  }, now);
  return store.publishSkillImportDraft(draft.id, now)[0];
}

test("hard delete removes a manually imported skill and its source records", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-hard-delete-"));
  const store = createSqliteRunStore(cwd);
  try {
    const skill = await publishSkill(store, "delete-me", "custom");
    const snapshot = store.upsertSkillSourceSnapshot({
      skillId: skill.id,
      sourceKind: "manual-markdown",
      sourceChecksum: "sha256:delete-me",
      rawSkillMarkdown: "# Delete me",
      agentMetadata: {},
      referencedFiles: [],
      warnings: [],
      reviewStatus: "published",
    }, now);
    const artifact = store.upsertSkillSourceArtifact({
      snapshotId: snapshot.id,
      path: "reference.md",
      kind: "reference",
      checksum: "sha256:reference",
      sizeBytes: 12,
      storageRef: "skill-source/delete-me/reference.md",
      reviewStatus: "published",
      includedInRuntime: true,
    }, now);

    const result = store.hardDeleteSkillRegistryEntry(skill.id);
    assert.equal(result.status, "deleted");
    assert.deepEqual(result.artifactStorageRefs, [artifact.storageRef]);
    assert.equal(store.getSkillRegistryEntry(skill.id), undefined);
    assert.equal(store.getSkillSourceSnapshotById(snapshot.id), undefined);
    assert.equal(store.getSkillSourceArtifact(artifact.id), undefined);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("hard delete rejects synced skills and skills that remain bound to a teammate", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-hard-delete-blockers-"));
  const store = createSqliteRunStore(cwd);
  try {
    const synced = await publishSkill(store, "synced-skill", "gstack");
    const syncedResult = store.hardDeleteSkillRegistryEntry(synced.id);
    assert.equal(syncedResult.status, "not_imported");

    const bound = await publishSkill(store, "bound-skill", "agents-md");
    const teammate = store.listAiTeammates()[0];
    assert.ok(teammate);
    store.replaceTeammateSkillBindings(teammate.id, [{
      skillId: bound.id,
      source: "user",
      enabled: true,
    }], now);

    const boundResult = store.hardDeleteSkillRegistryEntry(bound.id);
    assert.equal(boundResult.status, "blocked");
    if (boundResult.status === "blocked") {
      assert.deepEqual(boundResult.blockers, [{ kind: "teammate_binding", id: teammate.id }]);
    }

    const channel = store.createChannel({ name: "Delete blockers", boundPath: cwd }, now);
    const taskSkill = await publishSkill(store, "task-skill", "custom");
    const task = store.createTask({
      channelId: channel.id,
      title: "Pending skill task",
      prompt: "Keep this active.",
      requestedSkillId: taskSkill.id,
    }, now);
    const taskResult = store.hardDeleteSkillRegistryEntry(taskSkill.id);
    assert.equal(taskResult.status, "blocked");
    if (taskResult.status === "blocked") {
      assert.deepEqual(taskResult.blockers, [{ kind: "active_task", id: task.id }]);
    }

    const runSkill = await publishSkill(store, "run-skill", "custom");
    const run = store.createRun({
      id: "run_skill_hard_delete_blocker",
      cwd,
      taskId: "task_skill_hard_delete_blocker",
      channelId: channel.id,
      selectedSkillId: runSkill.id,
      providerName: "Test provider",
      providerModel: "test-model",
      taskSnapshot: {},
      providerSnapshot: {},
      requestSnapshot: {},
      createdAt: now,
    });
    const runResult = store.hardDeleteSkillRegistryEntry(runSkill.id);
    assert.equal(runResult.status, "blocked");
    if (runResult.status === "blocked") {
      assert.deepEqual(runResult.blockers, [{ kind: "active_run", id: run.id }]);
    }

    const automationSkill = await publishSkill(store, "automation-skill", "custom");
    const thread = store.createLingThread({
      kind: "automation",
      channelId: channel.id,
      title: "Deletion automation",
      objective: "Keep the skill referenced.",
    }, now);
    const template = getBuiltinAutomationTemplate("daily_brief");
    const automation = store.createAutomationDefinition({
      channelId: channel.id,
      threadId: thread.id,
      title: "Skill deletion blocker",
      kind: "daily_brief",
      trigger: template.defaultTrigger,
      target: {
        scope: "channel",
        workspaceId: DEFAULT_WORKSPACE_ID,
        channelId: channel.id,
        cwd,
      },
      promptTemplate: template.defaultPromptTemplate,
      executionPolicy: {
        ...template.defaultExecutionPolicy,
        requestedSkillId: automationSkill.id,
      },
      outputPolicy: template.defaultOutputPolicy,
    }, now);
    const automationResult = store.hardDeleteSkillRegistryEntry(automationSkill.id);
    assert.equal(automationResult.status, "blocked");
    if (automationResult.status === "blocked") {
      assert.deepEqual(automationResult.blockers, [{ kind: "automation", id: automation.id }]);
    }
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
