import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  buildEffectiveTeammateSkills,
  createBuiltinAiTeammateId,
  createSqliteRunStore,
  GSTACK_DEFAULT_SKILL_PACK_ID,
  listDefaultSkills,
} from "../dist/index.js";

test("sqlite seeds durable builtin AI teammates and migrates legacy template references", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ai-teammates-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-05-29T00:00:00.000Z";
  const engineerId = createBuiltinAiTeammateId("engineer");
  let closed = false;
  try {
    const teammates = store.listAiTeammates({ includeHidden: true, includeDisabled: true });
    const engineer = teammates.find((item) => item.id === engineerId);
    assert.ok(engineer);
    assert.equal(engineer.templateId, "engineer");
    assert.equal(engineer.pinned, true);
    assert.ok(store.listTeammateSkillBindings(engineerId).some((binding) => binding.skillId === "implement"));

    const channel = store.createChannel({ name: "Engineering", boundPath: cwd, defaultTeammateId: "engineer" }, now);
    const task = store.createTask({ channelId: channel.id, title: "Legacy teammate", prompt: "Migrate me.", assigneeTeammateId: "engineer" }, now);
    store.close();
    closed = true;

    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getChannel(channel.id).defaultTeammateId, engineerId);
      assert.equal(reopened.getTask(task.id).assigneeTeammateId, engineerId);
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) {
      store.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite persists Ling Memory v1 objects, scoped lexical recall, and used-memory events", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-memory-v1-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-06-04T01:00:00.000Z";
  const engineerId = createBuiltinAiTeammateId("engineer");
  const designerId = createBuiltinAiTeammateId("designer");
  try {
    const engineering = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const design = store.createChannel({ name: "Design", boundPath: cwd }, now);
    const workspaceMemory = store.createMemoryObject(
      {
        scopeType: "workspace",
        ownerId: "workspace_default",
        title: "Workspace baseline",
        body: "Model Workbench uses the same shell width as the other pages.",
        tags: ["model-workbench", "layout"],
      },
      now,
    );
    const channelMemory = store.createMemoryObject(
      {
        scopeType: "channel",
        ownerId: engineering.id,
        title: "Engineering channel decision",
        body: "The channel agreed to keep lexical recall scoped by channel.",
        tags: ["recall"],
        sourceRefs: [{ type: "decision", id: "decision_1", label: "Recall scope" }],
      },
      now,
    );
    const otherChannelMemory = store.createMemoryObject(
      {
        scopeType: "channel",
        ownerId: design.id,
        title: "Design-only channel memory",
        body: "This unrelated channel memory mentions lexical recall too.",
      },
      now,
    );
    const privateMemory = store.createMemoryObject(
      {
        scopeType: "teammate",
        ownerId: engineerId,
        title: "Private engineer preference",
        body: "Use lexical recall for Model Workbench implementation notes.",
        sensitivity: "private",
      },
      now,
    );
    const designerMemory = store.createMemoryObject(
      {
        scopeType: "teammate",
        ownerId: designerId,
        title: "Designer private memory",
        body: "Designer memory also mentions Model Workbench.",
        sensitivity: "private",
      },
      now,
    );
    store.createMemoryObject(
      {
        scopeType: "workspace",
        ownerId: "workspace_default",
        title: "Secret-adjacent memory",
        body: "Secret-adjacent Model Workbench token detail.",
        sensitivity: "secret-adjacent",
      },
      now,
    );
    const disabled = store.createMemoryObject(
      {
        scopeType: "workspace",
        ownerId: "workspace_default",
        title: "Disabled memory",
        body: "Disabled lexical recall note.",
        enabled: false,
      },
      now,
    );
    store.updateMemoryObject(disabled.id, { reviewState: "archived" }, "2026-06-04T01:01:00.000Z");

    const channelRecall = store.recallMemory({
      teammateId: engineerId,
      channelId: engineering.id,
      intent: "channel-reply",
      query: "lexical recall model workbench",
    });
    assert.deepEqual(workspaceMemory.sourceRefs, [{ type: "manual", id: workspaceMemory.id, label: "Manual memory" }]);
    const channelIds = channelRecall.memories.map((item) => item.memory.id);
    assert.ok(channelIds.includes(workspaceMemory.id));
    assert.ok(channelIds.includes(channelMemory.id));
    assert.ok(channelIds.includes(privateMemory.id));
    assert.equal(channelIds.includes(otherChannelMemory.id), false);
    assert.equal(channelIds.includes(designerMemory.id), false);

    const privateRecall = store.recallMemory({
      teammateId: engineerId,
      intent: "private-chat",
      query: "model workbench",
      includePrivate: true,
    });
    const privateIds = privateRecall.memories.map((item) => item.memory.id);
    assert.ok(privateIds.includes(privateMemory.id));
    assert.equal(privateIds.includes(designerMemory.id), false);
    assert.equal(channelIds.includes(disabled.id), false);

    const used = store.recordUsedMemoryEvent(
      {
        memoryIds: [workspaceMemory.id, channelMemory.id],
        intent: "channel-reply",
        recallQuery: channelRecall.request.query,
        teammateId: engineerId,
        channelId: engineering.id,
        responseId: "message_1",
        policyVersion: channelRecall.policyVersion,
      },
      "2026-06-04T01:02:00.000Z",
    );
    assert.equal(used.memoryIds.length, 2);
    assert.deepEqual(store.listUsedMemoryEvents({ responseId: "message_1" }).map((event) => event.id), [used.id]);
    assert.equal(store.getMemoryObject(workspaceMemory.id).lastUsedAt, "2026-06-04T01:02:00.000Z");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("effective teammate skills expose blocked reasons", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-effective-skills-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-06-04T02:00:00.000Z";
  const engineerId = createBuiltinAiTeammateId("engineer");
  try {
    const engineer = store.getAiTeammate(engineerId);
    assert.ok(engineer);
    const bindings = store.replaceTeammateSkillBindings(
      engineerId,
      [
        { skillId: "implement", source: "template", enabled: true },
        { skillId: "qa", source: "user", enabled: false },
      ],
      now,
    );
    const effective = buildEffectiveTeammateSkills({
      teammate: engineer,
      bindings,
      skills: listDefaultSkills(GSTACK_DEFAULT_SKILL_PACK_ID),
      channelAllowedTools: ["read"],
      providerCapabilities: ["chat"],
    });
    const implement = effective.find((item) => item.skillId === "implement");
    assert.ok(implement);
    assert.equal(implement.executable, false);
    assert.ok(implement.blockedReasons.some((reason) => reason.code === "channel_policy"));
    assert.ok(implement.blockedReasons.some((reason) => reason.code === "missing_provider_capability"));
    const qa = effective.find((item) => item.skillId === "qa");
    assert.ok(qa);
    assert.ok(qa.blockedReasons.some((reason) => reason.code === "disabled_binding"));
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite persists skill import drafts and publishes custom registry skills", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-skill-registry-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-06-04T02:30:00.000Z";
  try {
    const draft = store.createSkillImportDraft(
      {
        source: "custom",
        name: "Workspace QA Pack",
        description: "Custom QA workflow pack.",
        definitions: [{
          definition: {
            id: "custom-qa-check",
            name: "Custom QA Check",
            summary: "Run a custom QA pass.",
            roleAffinity: ["qa"],
            workflowPhase: "test",
            promptFragments: ["Verify the selected flow and report failures first."],
            requiredTools: ["read", "grep", "find", "ls"],
            requiredProviderCapabilities: ["chat", "reasoning"],
            approvalProfile: { mode: "none" },
            stateEffects: ["creates_artifact"],
          },
        }],
      },
      now,
    );
    assert.equal(store.getSkillImportDraft(draft.id).definitions[0].definition.id, "custom-qa-check");

    const published = store.publishSkillImportDraft(draft.id, "2026-06-04T02:31:00.000Z");
    assert.equal(published.length, 1);
    assert.equal(published[0].id, "custom-qa-check");
    assert.equal(published[0].reviewStatus, "published");
    assert.equal(store.listSkillRegistryEntries().some((entry) => entry.id === "custom-qa-check"), true);

    const archived = store.archiveSkillRegistryEntry("custom-qa-check", "2026-06-04T02:32:00.000Z");
    assert.equal(archived.reviewStatus, "archived");
    assert.equal(store.listSkillRegistryEntries().some((entry) => entry.id === "custom-qa-check"), false);
    assert.equal(store.listSkillRegistryEntries({ includeArchived: true }).some((entry) => entry.id === "custom-qa-check"), true);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite persists AI teammate direct thread, messages, channel memberships, and memory scopes", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ai-teammate-private-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-05-29T01:00:00.000Z";
  const engineerId = createBuiltinAiTeammateId("engineer");
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd }, now);
    const skillBindings = store.replaceTeammateSkillBindings(
      engineerId,
      [
        { skillId: "implement", source: "template", enabled: false },
        { skillId: "plan-eng-review", source: "user", enabled: true },
      ],
      now,
    );
    assert.deepEqual(skillBindings.map((item) => [item.skillId, item.source, item.enabled]), [
      ["implement", "template", false],
      ["investigate", "template", true],
      ["plan-eng-review", "user", true],
      ["review", "template", true],
    ]);
    const deletedUserSkillBindings = store.replaceTeammateSkillBindings(
      engineerId,
      [{ skillId: "triage-playbook", source: "user", enabled: true }],
      "2026-05-29T01:00:01.000Z",
    );
    assert.deepEqual(deletedUserSkillBindings.map((item) => [item.skillId, item.source, item.enabled]), [
      ["implement", "template", false],
      ["investigate", "template", true],
      ["review", "template", true],
      ["triage-playbook", "user", true],
    ]);

    const memberships = store.replaceTeammateChannelMemberships(
      engineerId,
      [{ channelId: channel.id, isDefault: true }],
      now,
    );
    assert.deepEqual(memberships.map((item) => [item.channelId, item.isDefault]), [[channel.id, true]]);
    assert.equal(store.getChannel(channel.id).defaultTeammateId, engineerId);

    const scopes = store.replaceTeammateMemoryScopes(
      engineerId,
      [
        { kind: "private-chat-summary", enabled: true },
        { kind: "channel-brief", channelId: channel.id, enabled: true },
      ],
      now,
    );
    assert.deepEqual(scopes.map((item) => item.kind), ["private-chat-summary", "channel-brief"]);

    const thread = store.getOrCreateTeammateDirectThread(engineerId, now);
    const userMessage = store.createTeammateDirectMessage(
      {
        threadId: thread.id,
        teammateId: engineerId,
        authorType: "local-user",
        authorId: "tian",
        body: "Review the private workspace plan.",
      },
      now,
    );
    const aiMessage = store.createTeammateDirectMessage(
      {
        threadId: thread.id,
        teammateId: engineerId,
        authorType: "ai-teammate",
        body: "Private workspace plan reviewed.",
        status: "ready",
      },
      "2026-05-29T01:01:00.000Z",
    );
    assert.deepEqual(store.listTeammateDirectMessages({ teammateId: engineerId }).map((item) => item.id), [userMessage.id, aiMessage.id]);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite private attachments and hard delete remove private teammate data", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ai-teammate-hard-delete-"));
  const store = createSqliteRunStore(cwd);
  const now = "2026-06-04T01:00:00.000Z";
  const engineerId = createBuiltinAiTeammateId("engineer");
  let closed = false;
  try {
    const channel = store.createChannel({ name: "Engineering", boundPath: cwd, defaultTeammateId: engineerId }, now);
    const task = store.createTask({ channelId: channel.id, title: "Assigned", prompt: "Private work.", assigneeTeammateId: engineerId }, now);
    store.replaceTeammateChannelMemberships(engineerId, [{ channelId: channel.id, isDefault: true }], now);
    store.replaceTeammateMemoryScopes(engineerId, [{ kind: "private-chat-summary", enabled: true }], now);
    const thread = store.getOrCreateTeammateDirectThread(engineerId, now);
    const attachment = store.createTeammatePrivateAttachment({
      teammateId: engineerId,
      threadId: thread.id,
      scope: "teammate_direct_thread",
      kind: "text",
      fileName: "brief.txt",
      contentType: "text/plain",
      sizeBytes: 12,
      path: `teammates/${engineerId}/direct/${thread.id}/brief.txt`,
      createdAt: now,
    });
    const avatar = store.createTeammatePrivateAttachment({
      teammateId: engineerId,
      scope: "teammate_profile_avatar",
      kind: "image",
      fileName: "avatar.png",
      contentType: "image/png",
      sizeBytes: 8,
      path: `teammates/${engineerId}/avatar/avatar.png`,
      createdAt: now,
    });
    store.updateAiTeammate(engineerId, { avatarImageAttachmentId: avatar.id }, now);
    const message = store.createTeammateDirectMessage(
      {
        threadId: thread.id,
        teammateId: engineerId,
        authorType: "local-user",
        body: "See attached private brief.",
        attachmentIds: [attachment.id],
      },
      now,
    );
    assert.deepEqual(message.attachmentIds, [attachment.id]);
    assert.throws(() => store.updateAiTeammate(engineerId, { avatarImageAttachmentId: attachment.id }, now), /Avatar image attachment/);
    const memory = store.createMemoryObject(
      {
        scopeType: "teammate",
        ownerId: engineerId,
        title: "Private teardown memory",
        body: "Hard delete should remove this private memory.",
        sensitivity: "private",
      },
      now,
    );
    store.recordUsedMemoryEvent(
      {
        memoryIds: [memory.id],
        intent: "private-chat",
        recallQuery: "teardown",
        teammateId: engineerId,
        responseId: message.id,
        policyVersion: "test",
      },
      now,
    );

    const result = store.hardDeleteAiTeammate(engineerId, { reason: "owner request" }, "2026-06-04T01:05:00.000Z");
    assert.ok(result);
    assert.equal(result.tombstone.entityId, engineerId);
    assert.equal(result.tombstone.reason, "owner request");
    assert.equal(result.tombstone.deletedCounts.privateAttachments, 2);
    assert.deepEqual(result.deletedAttachmentPaths.sort(), [attachment.path, avatar.path].sort());
    assert.equal(store.getAiTeammate(engineerId), undefined);
    assert.equal(store.getTeammateDirectMessage(message.id), undefined);
    assert.equal(store.getTeammatePrivateAttachment(attachment.id), undefined);
    assert.equal(store.getMemoryObject(memory.id), undefined);
    assert.equal(store.listUsedMemoryEvents({ teammateId: engineerId }).length, 0);
    assert.equal(store.getChannel(channel.id).defaultTeammateId, undefined);
    assert.equal(store.getTask(task.id).assigneeTeammateId, undefined);
    store.close();
    closed = true;

    const reopened = createSqliteRunStore(cwd);
    try {
      assert.equal(reopened.getAiTeammate(engineerId), undefined);
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) {
      store.close();
    }
    await rm(cwd, { recursive: true, force: true });
  }
});
