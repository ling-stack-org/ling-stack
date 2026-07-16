import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  buildEffectiveTeammateSkills,
  createBuiltinAiTeammateId,
  createSqliteRunStore,
  DEVELOPMENT_COUNCIL_ID,
  GSTACK_DEFAULT_SKILL_PACK_ID,
  LING_AGENT_DEFAULT_SKILL_IDS,
  LING_AGENT_ID,
  LING_AGENT_SYSTEM_PROMPT,
  lingAgentAllowedTools,
  lingAgentEditableFields,
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

test("sqlite seeds Ling Agent as a protected system teammate and channel member", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ling-agent-system-teammate-"));
  const now = "2026-06-12T00:00:00.000Z";
  const updatedAt = "2026-06-12T00:01:00.000Z";
  const store = createSqliteRunStore(cwd);
  try {
    const lingAgent = store.getAiTeammate(LING_AGENT_ID);
    assert.ok(lingAgent);
    assert.equal(lingAgent.kind, "system_teammate");
    assert.equal(lingAgent.systemRole, "ling_agent");
    assert.equal(lingAgent.protectedProfile, true);
    assert.deepEqual(lingAgent.editableFields, lingAgentEditableFields);
    assert.equal(lingAgent.templateId, LING_AGENT_ID);
    assert.equal(lingAgent.status, "active");
    assert.equal(lingAgent.pinned, true);
    assert.equal(lingAgent.hidden, false);
    assert.equal(lingAgent.systemPrompt, LING_AGENT_SYSTEM_PROMPT);
    assert.deepEqual(lingAgent.allowedTools, lingAgentAllowedTools);
    const lingAgentSkillBindings = store.listTeammateSkillBindings(LING_AGENT_ID);
    assert.deepEqual(lingAgentSkillBindings.map((binding) => binding.skillId).sort(), [...LING_AGENT_DEFAULT_SKILL_IDS].sort());
    assert.ok(lingAgentSkillBindings.every((binding) => binding.source === "template" && binding.enabled));
    const lingAgentEffectiveSkills = buildEffectiveTeammateSkills({
      teammate: lingAgent,
      bindings: lingAgentSkillBindings,
      skills: listDefaultSkills(GSTACK_DEFAULT_SKILL_PACK_ID),
      channelAllowedTools: lingAgentAllowedTools,
      providerCapabilities: ["chat", "reasoning", "tool_call"],
    });
    assert.deepEqual(
      lingAgentEffectiveSkills.filter((skill) => !skill.executable).map((skill) => [skill.skillId, skill.blockedReasons.map((reason) => reason.code)]),
      [],
    );

    const channel = store.createChannel(
      {
        name: "Default Ling Agent Channel",
        boundPath: cwd,
        defaultTeammateId: LING_AGENT_ID,
      },
      now,
    );
    assert.equal(channel.defaultTeammateId, undefined);
    assert.deepEqual(store.listTeammateChannelMemberships(LING_AGENT_ID).map((membership) => membership.channelId), [channel.id]);
    assert.equal(store.listTeammateChannelMemberships(LING_AGENT_ID)[0].isDefault, false);
    assert.deepEqual(
      store.listTeammateMemoryScopes(LING_AGENT_ID).map((scope) => [scope.kind, scope.channelId ?? null, scope.enabled]),
      [
        ["private-chat-summary", null, true],
        ["private-notes", null, true],
        ["channel-brief", channel.id, true],
        ["channel-decisions", channel.id, true],
      ],
    );

    const engineerId = createBuiltinAiTeammateId("engineer");
    assert.deepEqual(
      store.listTeammateMemoryScopes(engineerId).map((scope) => [scope.kind, scope.channelId ?? null, scope.enabled]),
      [
        ["private-chat-summary", null, true],
        ["private-notes", null, true],
      ],
    );
    const specialistChannel = store.createChannel(
      {
        name: "Preferred Specialist Channel",
        boundPath: cwd,
        defaultTeammateId: engineerId,
      },
      now,
    );
    assert.equal(specialistChannel.defaultTeammateId, engineerId);
    assert.equal(store.updateChannel(specialistChannel.id, { defaultTeammateId: LING_AGENT_ID }, updatedAt).defaultTeammateId, undefined);

    const personalized = store.updateAiTeammate(
      LING_AGENT_ID,
      {
        displayName: "Ling",
        description: "Workspace coordinator",
        appendSystemPrompt: ["Prefer concise Chinese status reports."],
      },
      updatedAt,
    );
    assert.equal(personalized.displayName, "Ling");
    assert.equal(personalized.description, "Workspace coordinator");
    assert.deepEqual(personalized.appendSystemPrompt, ["Prefer concise Chinese status reports."]);
    assert.equal(personalized.systemPrompt, LING_AGENT_SYSTEM_PROMPT);
    assert.deepEqual(personalized.allowedTools, lingAgentAllowedTools);
    assert.deepEqual(personalized.approvalProfile, { mode: "standard", risk: "medium" });
    assert.equal(personalized.status, "active");
    assert.equal(personalized.pinned, true);
    assert.equal(personalized.hidden, false);

    assert.throws(() => store.updateAiTeammate(LING_AGENT_ID, { systemPrompt: "override" }, updatedAt), /protected fields/);
    assert.throws(() => store.updateAiTeammate(LING_AGENT_ID, { allowedTools: ["read"] }, updatedAt), /protected fields/);
    assert.throws(() => store.updateAiTeammate(LING_AGENT_ID, { status: "disabled" }, updatedAt), /protected fields/);
    assert.throws(() => store.disableAiTeammate(LING_AGENT_ID, updatedAt), /cannot be disabled/);
    assert.throws(() => store.hardDeleteAiTeammate(LING_AGENT_ID, { reason: "owner request" }, updatedAt), /cannot be deleted/);
    assert.throws(() => store.replaceTeammateChannelMemberships(LING_AGENT_ID, [], updatedAt), /membership is protected/);
    assert.throws(() => store.replaceTeammateSkillBindings(LING_AGENT_ID, [], updatedAt), /skill bindings are protected/);
    assert.throws(() => store.replaceTeammateMemoryScopes(LING_AGENT_ID, [], updatedAt), /memory scopes are protected/);
    assert.throws(() => store.replaceTeammateMcpBindings(LING_AGENT_ID, [], updatedAt), /MCP bindings are protected/);
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite seeds Development Council and projects channel council members without copying memberships", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-development-council-"));
  const now = "2026-06-20T00:00:00.000Z";
  const updatedAt = "2026-06-20T00:01:00.000Z";
  const engineerId = createBuiltinAiTeammateId("engineer");
  const store = createSqliteRunStore(cwd);
  try {
    const council = store.getAiCouncil(DEVELOPMENT_COUNCIL_ID);
    assert.ok(council);
    assert.equal(council.source, "builtin");
    assert.equal(council.templateId, "development");
    assert.equal(council.displayName, "Development Council");
    assert.equal(council.status, "active");
    assert.equal(council.governanceProfile.permissionBoundary, "restrict_only");
    assert.equal(council.governanceProfile.approvalBoundary, "cannot_bypass");

    const members = store.listAiCouncilMembers(DEVELOPMENT_COUNCIL_ID);
    assert.ok(members.length >= 8);
    assert.ok(members.some((member) => member.teammateId === engineerId));
    assert.equal(members.some((member) => member.teammateId === LING_AGENT_ID), false);
    const initialHealth = store.getAiCouncilHealthReport(now);
    assert.equal(initialHealth.workspaceId, "workspace_default");
    assert.equal(initialHealth.summary.totalCouncils >= 1, true);
    assert.equal(initialHealth.summary.activeCouncils >= 1, true);
    assert.equal(initialHealth.summary.totalMembers >= members.length, true);
    assert.equal(initialHealth.findings.some((finding) => finding.kind === "member_disabled" && finding.teammateId === engineerId), false);

    const channel = store.createChannel({ name: "Council Channel", boundPath: cwd }, now);
    const defaultPolicy = store.getChannelCouncilPolicy(channel.id);
    assert.ok(defaultPolicy);
    assert.deepEqual(defaultPolicy.attachedCouncilIds, []);
    assert.equal(defaultPolicy.preferredCouncilId, undefined);

    const policy = store.upsertChannelCouncilPolicy(
      channel.id,
      {
        attachedCouncilIds: [DEVELOPMENT_COUNCIL_ID],
        preferredCouncilId: DEVELOPMENT_COUNCIL_ID,
      },
      updatedAt,
    );
    assert.deepEqual(policy.attachedCouncilIds, [DEVELOPMENT_COUNCIL_ID]);
    assert.equal(policy.preferredCouncilId, DEVELOPMENT_COUNCIL_ID);

    const effective = store.getEffectiveChannelCouncil(channel.id);
    assert.ok(effective);
    assert.deepEqual(effective.policy.attachedCouncilIds, [DEVELOPMENT_COUNCIL_ID]);
    assert.ok(effective.councils.some((item) => item.council.id === DEVELOPMENT_COUNCIL_ID));
    const engineerSpecialist = effective.specialists.find((specialist) => specialist.teammateId === engineerId);
    assert.ok(engineerSpecialist);
    assert.ok(engineerSpecialist.sources.some((source) => source.kind === "council" && source.councilId === DEVELOPMENT_COUNCIL_ID));
    assert.equal(
      store.listTeammateChannelMemberships(engineerId).some((membership) => membership.channelId === channel.id),
      false,
    );

    const disabledMembers = members.map((member) => ({
      teammateId: member.teammateId,
      slotKey: member.slotKey,
      label: member.label,
      position: member.position,
      enabled: member.teammateId === engineerId ? false : member.enabled,
    }));
    store.replaceAiCouncilMembers(DEVELOPMENT_COUNCIL_ID, disabledMembers, updatedAt);
    const effectiveAfterDisable = store.getEffectiveChannelCouncil(channel.id);
    assert.ok(effectiveAfterDisable);
    assert.equal(effectiveAfterDisable.specialists.some((specialist) => specialist.teammateId === engineerId), false);
    const disabledEngineer = effectiveAfterDisable.councils
      .find((item) => item.council.id === DEVELOPMENT_COUNCIL_ID)
      .members.find((member) => member.member.teammateId === engineerId);
    assert.ok(disabledEngineer);
    assert.equal(disabledEngineer.enabled, false);
    assert.equal(disabledEngineer.blockedReason, "member_disabled");

    const healthAfterDisable = store.getAiCouncilHealthReport(updatedAt);
    assert.ok(healthAfterDisable.findings.some((finding) =>
      finding.kind === "member_disabled" &&
      finding.councilId === DEVELOPMENT_COUNCIL_ID &&
      finding.teammateId === engineerId
    ));
    assert.equal(healthAfterDisable.summary.blockedMembers >= 1, true);

    store.replaceAiCouncilMembers(
      DEVELOPMENT_COUNCIL_ID,
      members.map((member) => ({
        teammateId: member.teammateId,
        slotKey: member.slotKey,
        label: member.label,
        position: member.position,
        enabled: false,
      })),
      updatedAt,
    );
    const healthAfterAllDisabled = store.getAiCouncilHealthReport(updatedAt);
    assert.ok(healthAfterAllDisabled.findings.some((finding) =>
      finding.kind === "council_no_available_members" &&
      finding.councilId === DEVELOPMENT_COUNCIL_ID &&
      finding.severity === "critical"
    ));
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite creates, clones, and archives user AI councils without granting authority", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-custom-council-"));
  const now = "2026-06-20T01:00:00.000Z";
  const updatedAt = "2026-06-20T01:01:00.000Z";
  const engineerId = createBuiltinAiTeammateId("engineer");
  const designerId = createBuiltinAiTeammateId("designer");
  const store = createSqliteRunStore(cwd);
  try {
    const customCouncil = store.createAiCouncil(
      {
        displayName: "Design Systems Council",
        description: "Custom council for design-system implementation review.",
        routingPolicy: {
          defaultMode: "advisory",
          maxActiveMembers: 2,
          notes: ["Review design-system changes without granting tools."],
        },
        members: [
          {
            teammateId: engineerId,
            slotKey: "implementation",
            label: "Implementation",
            position: 0,
            enabled: true,
          },
        ],
        pinned: true,
      },
      now,
    );
    assert.equal(customCouncil.source, "user");
    assert.equal(customCouncil.templateId, undefined);
    assert.equal(customCouncil.displayName, "Design Systems Council");
    assert.equal(customCouncil.routingPolicy.defaultMode, "advisory");
    assert.equal(customCouncil.routingPolicy.maxActiveMembers, 2);
    assert.equal(customCouncil.governanceProfile.permissionBoundary, "restrict_only");
    assert.equal(customCouncil.governanceProfile.approvalBoundary, "cannot_bypass");
    assert.equal(customCouncil.governanceProfile.toolGrantBoundary, "cannot_grant");
    assert.equal(customCouncil.governanceProfile.credentialBoundary, "cannot_grant");
    assert.deepEqual(store.listAiCouncilMembers(customCouncil.id).map((member) => member.teammateId), [engineerId]);

    const clonedCouncil = store.cloneAiCouncil(
      DEVELOPMENT_COUNCIL_ID,
      {
        displayName: "Frontend Review Council",
        description: "Cloned specialist collection for frontend channels.",
      },
      updatedAt,
    );
    assert.equal(clonedCouncil.source, "user");
    assert.equal(clonedCouncil.templateId, undefined);
    assert.equal(clonedCouncil.displayName, "Frontend Review Council");
    assert.equal(clonedCouncil.governanceProfile.toolGrantBoundary, "cannot_grant");
    const clonedMembers = store.listAiCouncilMembers(clonedCouncil.id);
    assert.ok(clonedMembers.some((member) => member.teammateId === engineerId));
    assert.ok(clonedMembers.some((member) => member.teammateId === designerId));
    assert.equal(clonedMembers.some((member) => member.teammateId === LING_AGENT_ID), false);

    assert.throws(
      () => store.updateAiCouncil(DEVELOPMENT_COUNCIL_ID, { status: "archived" }, updatedAt),
      /clone them first/,
    );
    assert.throws(
      () => store.createAiCouncil({ displayName: "Invalid", routingPolicy: { defaultMode: "execute_everything" } }, updatedAt),
      /routingPolicy\.defaultMode/,
    );

    const channel = store.createChannel({ name: "Frontend", boundPath: cwd }, now);
    store.upsertChannelCouncilPolicy(
      channel.id,
      {
        attachedCouncilIds: [customCouncil.id, clonedCouncil.id],
        preferredCouncilId: clonedCouncil.id,
      },
      updatedAt,
    );
    const archived = store.updateAiCouncil(clonedCouncil.id, { status: "archived" }, "2026-06-20T01:02:00.000Z");
    assert.ok(archived);
    assert.equal(archived.status, "archived");
    const detachedPolicy = store.getChannelCouncilPolicy(channel.id);
    assert.ok(detachedPolicy);
    assert.deepEqual(detachedPolicy.attachedCouncilIds, [customCouncil.id]);
    assert.equal(detachedPolicy.preferredCouncilId, customCouncil.id);

    const health = store.getAiCouncilHealthReport("2026-06-20T01:03:00.000Z");
    assert.ok(health.summary.totalCouncils >= 3);
    assert.ok(health.findings.some((finding) =>
      finding.kind === "council_not_active" &&
      finding.councilId === clonedCouncil.id
    ));
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite backfills current template skill defaults for existing builtin teammates without resetting overrides", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ai-teammate-skill-backfill-"));
  const store = createSqliteRunStore(cwd);
  const qaId = createBuiltinAiTeammateId("qa");
  const databasePath = store.paths.databasePath;
  const oldCreatedAt = "2026-05-29T00:00:00.000Z";
  let closed = false;
  try {
    store.close();
    closed = true;

    const database = new DatabaseSync(databasePath);
    try {
      database.exec("BEGIN");
      database.prepare("DELETE FROM teammate_skill_bindings WHERE teammate_id = ?").run(qaId);
      const insert = database.prepare(`
        INSERT INTO teammate_skill_bindings (
          teammate_id,
          skill_id,
          source,
          enabled,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      insert.run(qaId, "investigate", "template", 1, oldCreatedAt, oldCreatedAt);
      insert.run(qaId, "qa", "template", 0, oldCreatedAt, oldCreatedAt);
      insert.run(qaId, "health", "user", 1, oldCreatedAt, oldCreatedAt);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.close();
    }

    const reopened = createSqliteRunStore(cwd);
    try {
      const bindings = reopened.listTeammateSkillBindings(qaId);
      const bySkill = new Map(bindings.map((binding) => [binding.skillId, binding]));
      for (const skillId of [
        "qa",
        "qa-only",
        "investigate",
        "design-review",
        "devex-review",
        "benchmark",
        "benchmark-models",
        "browse",
        "scrape",
        "ios-qa",
        "ios-design-review",
      ]) {
        assert.ok(bySkill.has(skillId), `${skillId} should be present after template backfill`);
      }
      assert.equal(bySkill.get("qa").enabled, false, "existing disabled template binding should stay disabled");
      assert.equal(bySkill.get("qa").updatedAt, oldCreatedAt, "existing template binding should not be rewritten");
      assert.equal(bySkill.get("health").source, "user", "custom user binding should stay present");
      assert.equal(bySkill.get("qa-only").source, "template");
      assert.equal(bySkill.get("qa-only").enabled, true);
      assert.equal(bindings.length, 12);
    } finally {
      reopened.close();
    }

    const reopenedAgain = createSqliteRunStore(cwd);
    try {
      assert.equal(reopenedAgain.listTeammateSkillBindings(qaId).length, 12, "backfill should be idempotent");
    } finally {
      reopenedAgain.close();
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
      ["claude", "template", true],
      ["context-restore", "template", true],
      ["context-save", "template", true],
      ["design-html", "template", true],
      ["health", "template", true],
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
      ["claude", "template", true],
      ["context-restore", "template", true],
      ["context-save", "template", true],
      ["design-html", "template", true],
      ["health", "template", true],
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
    assert.deepEqual(
      store.listTeammateMemoryScopes(engineerId).map((item) => [item.kind, item.channelId ?? null, item.enabled]),
      [
        ["private-chat-summary", null, true],
        ["private-notes", null, true],
        ["channel-brief", channel.id, true],
        ["channel-decisions", channel.id, true],
      ],
    );
    store.replaceTeammateChannelMemberships(engineerId, [], now);
    assert.deepEqual(
      store.listTeammateMemoryScopes(engineerId).map((item) => [item.kind, item.channelId ?? null, item.enabled]),
      [
        ["private-chat-summary", null, true],
        ["private-notes", null, true],
      ],
    );
    store.replaceTeammateChannelMemberships(engineerId, [{ channelId: channel.id, isDefault: true }], now);
    assert.throws(
      () => store.replaceTeammateMemoryScopes(engineerId, [{ kind: "private-chat-summary", enabled: false }], now),
      /memory is always enabled/,
    );

    const scopes = store.replaceTeammateMemoryScopes(
      engineerId,
      [
        { kind: "private-chat-summary", enabled: true },
        { kind: "channel-brief", channelId: channel.id, enabled: true },
      ],
      now,
    );
    assert.deepEqual(scopes.map((item) => [item.kind, item.channelId ?? null, item.enabled]), [
      ["private-chat-summary", null, true],
      ["private-notes", null, true],
      ["channel-brief", channel.id, true],
      ["channel-decisions", channel.id, true],
    ]);

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

test("sqlite persists teammate direct reply interventions with idempotency and cancellation", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ai-teammate-direct-interventions-"));
  const now = "2026-06-09T01:00:00.000Z";
  let store = createSqliteRunStore(cwd);
  const teammateId = createBuiltinAiTeammateId("designer");
  let queuedInterventionId = "";
  let attachmentId = "";
  try {
    const thread = store.getOrCreateTeammateDirectThread(teammateId, now);
    const attachment = store.createTeammatePrivateAttachment({
      teammateId,
      threadId: thread.id,
      scope: "teammate_direct_thread",
      kind: "image",
      fileName: "wireframe.png",
      contentType: "image/png",
      sizeBytes: 512,
      path: `teammates/${teammateId}/direct/${thread.id}/wireframe.png`,
      createdAt: now,
    });
    attachmentId = attachment.id;
    const sourceMessage = store.createTeammateDirectMessage(
      {
        threadId: thread.id,
        teammateId,
        authorType: "local-user",
        authorId: "local-user",
        body: "继续优化私聊回复。",
      },
      now,
    );
    const pendingReply = store.createTeammateDirectMessage(
      {
        threadId: thread.id,
        teammateId,
        authorType: "ai-teammate",
        authorId: teammateId,
        body: "",
        status: "pending",
      },
      "2026-06-09T01:00:01.000Z",
    );
    store.createWorkUnit({
      id: "wu_direct_source",
      workspaceId: "workspace_default",
      kind: "teammate_direct_reply",
      ownerType: "teammate_direct_message",
      ownerId: sourceMessage.id,
      teammateId,
      linkedMessageId: pendingReply.id,
      idempotencyKey: "direct-source",
      status: "running",
      createdByActor: "system",
      request: { sourceMessageId: sourceMessage.id },
      now: "2026-06-09T01:00:02.000Z",
    });

    const queued = store.createTeammateDirectReplyIntervention(
      {
        teammateId,
        threadId: thread.id,
        sourceMessageId: sourceMessage.id,
        sourceWorkUnitId: "wu_direct_source",
        mode: "queue_followup",
        instruction: "回复完后补一版简短结论。",
        messagePayload: {
          body: "回复完后补一版简短结论。",
          attachmentIds: [attachment.id],
        },
        idempotencyKey: "direct-guidance-1",
        requestedBy: "local-user",
      },
      "2026-06-09T01:01:00.000Z",
    );
    queuedInterventionId = queued.id;
    assert.deepEqual(queued.messagePayload, {
      body: "回复完后补一版简短结论。",
      attachmentIds: [attachment.id],
      linkPreviewIds: [],
    });
    const duplicate = store.createTeammateDirectReplyIntervention(
      {
        teammateId,
        threadId: thread.id,
        sourceMessageId: sourceMessage.id,
        sourceWorkUnitId: "wu_direct_source",
        mode: "queue_followup",
        instruction: "重复请求不应创建第二条。",
        idempotencyKey: "direct-guidance-1",
        requestedBy: "local-user",
      },
      "2026-06-09T01:01:01.000Z",
    );
    const redirect = store.createTeammateDirectReplyIntervention(
      {
        teammateId,
        threadId: thread.id,
        sourceMessageId: sourceMessage.id,
        sourceWorkUnitId: "wu_direct_source",
        mode: "interrupt_redirect",
        instruction: "停止当前回复，改为聚焦风险。",
        idempotencyKey: "direct-guidance-2",
        requestedBy: "local-user",
      },
      "2026-06-09T01:02:00.000Z",
    );
    const otherTeammateId = createBuiltinAiTeammateId("engineer");
    const otherThread = store.getOrCreateTeammateDirectThread(otherTeammateId, now);
    const otherAttachment = store.createTeammatePrivateAttachment({
      teammateId: otherTeammateId,
      threadId: otherThread.id,
      scope: "teammate_direct_thread",
      kind: "image",
      fileName: "other.png",
      contentType: "image/png",
      sizeBytes: 128,
      path: `teammates/${otherTeammateId}/direct/${otherThread.id}/other.png`,
      createdAt: now,
    });
    assert.throws(
      () => store.createTeammateDirectReplyIntervention(
        {
          teammateId,
          threadId: thread.id,
          sourceMessageId: sourceMessage.id,
          sourceWorkUnitId: "wu_direct_source",
          mode: "queue_followup",
          instruction: "错误附件不应入队。",
          messagePayload: {
            body: "错误附件不应入队。",
            attachmentIds: [otherAttachment.id],
          },
          idempotencyKey: "direct-guidance-bad-attachment",
          requestedBy: "local-user",
        },
        "2026-06-09T01:02:30.000Z",
      ),
      /Private attachment does not belong to teammate direct thread/,
    );

    assert.equal(duplicate.id, queued.id);
    assert.deepEqual(
      store.listTeammateDirectReplyInterventions({ teammateId, threadId: thread.id }).map((item) => item.id),
      [queued.id, redirect.id],
    );

    const started = store.updateTeammateDirectReplyInterventionStatus({
      interventionId: redirect.id,
      status: "started",
      continuationMessageId: "msg_continuation",
      continuationWorkUnitId: "wu_continuation",
      startedAt: "2026-06-09T01:03:00.000Z",
      completedAt: "2026-06-09T01:03:00.000Z",
      now: "2026-06-09T01:03:00.000Z",
    });
    assert.equal(started?.continuationMessageId, "msg_continuation");
    assert.equal(started?.continuationWorkUnitId, "wu_continuation");

    const cancelled = store.cancelTeammateDirectReplyIntervention(queued.id, "2026-06-09T01:04:00.000Z", "user_cancelled");
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.failureReason, "user_cancelled");
  } finally {
    store.close();
  }

  store = createSqliteRunStore(cwd);
  try {
    assert.deepEqual(store.getTeammateDirectReplyIntervention(queuedInterventionId).messagePayload, {
      body: "回复完后补一版简短结论。",
      attachmentIds: [attachmentId],
      linkPreviewIds: [],
    });
    const persisted = store.listTeammateDirectReplyInterventions({ teammateId });
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].status, "cancelled");
    assert.equal(persisted[1].status, "started");
    assert.equal(persisted[1].sourceWorkUnitId, "wu_direct_source");
  } finally {
    store.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("sqlite lists latest teammate direct messages and pages older history", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-ai-teammate-direct-message-pagination-"));
  const store = createSqliteRunStore(cwd);
  const engineerId = createBuiltinAiTeammateId("engineer");
  try {
    const thread = store.getOrCreateTeammateDirectThread(engineerId, "2026-06-16T00:00:00.000Z");
    const messages = [];
    for (let index = 0; index < 106; index += 1) {
      messages.push(store.createTeammateDirectMessage(
        {
          threadId: thread.id,
          teammateId: engineerId,
          authorType: index % 2 === 0 ? "local-user" : "ai-teammate",
          body: `Message ${index + 1}`,
        },
        new Date(Date.UTC(2026, 5, 16, 0, index, 0)).toISOString(),
      ));
    }

    const latest = store.listTeammateDirectMessages({ teammateId: engineerId, threadId: thread.id });
    assert.equal(latest.length, 100);
    assert.deepEqual(latest.map((message) => message.id), messages.slice(6).map((message) => message.id));

    const latestPage = store.listTeammateDirectMessagesPage({ teammateId: engineerId, threadId: thread.id });
    assert.equal(latestPage.hasMore, true);
    assert.equal(latestPage.nextBeforeMessageId, messages[6].id);

    const olderPage = store.listTeammateDirectMessagesPage({
      teammateId: engineerId,
      threadId: thread.id,
      beforeMessageId: latestPage.nextBeforeMessageId,
    });
    assert.equal(olderPage.hasMore, false);
    assert.deepEqual(olderPage.messages.map((message) => message.id), messages.slice(0, 6).map((message) => message.id));
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
