import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  cwd,
  defaultRuntimePolicy,
  isRecord,
} from "./support/mock-state";
import {
  readSidebarSelection,
} from "./support/test-helpers";

test("AI teammates page creates a durable teammate and opens its private workspace", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    {
      id: "provider_local",
      kind: "openai-compatible",
      displayName: "Local Relay",
      providerId: "local-relay",
      model: "gpt-5.5",
      api: "openai-completions",
      apiKeyConfigured: true,
      headers: {},
      authHeader: true,
      reasoning: true,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 16384,
      compat: {},
      capabilities: ["chat", "tool_call", "reasoning"],
      enabled: true,
      lastCheck: { ok: true, message: "ok", checkedAt: "2026-05-22T00:00:00.000Z" },
      createdAt: "2026-05-22T00:00:00.000Z",
      updatedAt: "2026-05-22T00:00:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "AI Teammates" }).first().click();
  await expect(page.getByRole("heading", { name: "AI Teammates", level: 1 })).toBeVisible();
  await expect(page.locator(".teammate-management-grid")).toBeVisible();
  await expect(page.getByLabel("Workspace teammates")).toBeVisible();
  await expect(page.getByLabel("Teammate templates")).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").getByText("Ling Engineer")).toHaveCount(0);
  await expect(page.locator(".teammate-command-strip")).toHaveCount(0);
  await expect(page.locator(".teammate-detail-panel")).toHaveCount(0);
  await expect(page.getByLabel("AI teammate context")).toHaveCount(0);
  await expect(page.getByLabel("Teammate templates").getByRole("button", { name: "Add teammate" })).toBeVisible();
  await page.getByLabel("Teammate templates").getByRole("button", { name: /Product Strategist/ }).click();
  const roleDetail = page.getByRole("dialog", { name: "Role detail" });
  await expect(roleDetail).toBeVisible();
  await expect(roleDetail.getByRole("heading", { name: "Product Strategist" })).toBeVisible();
  await expect(roleDetail.getByText("System prompt")).toBeHidden();
  await expect(roleDetail.locator(".teammate-advanced-detail")).not.toHaveAttribute("open", "");
  await roleDetail.getByRole("button", { name: "Use this role" }).click();
  await expect(page.getByRole("dialog", { name: "Create AI teammate" })).toBeVisible();
  await expect(page.getByLabel("Teammate setup steps")).toHaveCount(0);
  await expect(page.getByLabel("Teammate preview")).toHaveCount(0);
  await page.getByRole("button", { name: "Close teammate creator" }).click();
  await expect(page.getByRole("dialog", { name: "Create AI teammate" })).toHaveCount(0);
  await page.getByLabel("Teammate templates").getByRole("button", { name: "Add teammate" }).click();
  const creator = page.getByRole("dialog", { name: "Create AI teammate" });
  await expect(creator).toBeVisible();
  await expect(page.getByLabel("Teammate setup steps")).toHaveCount(0);
  await expect(page.getByLabel("Teammate preview")).toHaveCount(0);
  await page.getByLabel("Teammate template chooser").getByRole("button", { name: /Engineer/ }).click();

  await expect(page.getByLabel("Model choices").getByRole("button", { name: /Local Relay/ })).toBeVisible();

  await page.getByLabel("Teammate name").fill("Ling Engineer");
  await page.getByLabel("Description").fill("Owns scoped implementation in the Engineering channel.");
  await creator.getByText("Advanced settings").click();
  await expect(page.getByLabel("Channel choices").getByRole("button", { name: /Engineering/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Create teammate" }).click();

  await expect(page.getByRole("heading", { name: "Ling Engineer", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").locator(".sidebar-row.selected")).toContainText("Ling Engineer");
  await expect(page.getByLabel("Private chat", { exact: true })).toBeVisible();
  await expect.poll(() => state.aiTeammates.some((item) => isRecord(item) && item.displayName === "Ling Engineer")).toBe(true);
  await expect.poll(() => state.teammateChannelMemberships.some((item) => isRecord(item) && item.teammateId === "teammate_created_1" && item.channelId === "channel_engineering")).toBe(true);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "AI Teammates" }).first().click();
  await expect(page.getByLabel("Workspace teammates").locator(".teammate-draft-row").filter({ hasText: "Ling Engineer" })).toBeVisible();
  const lingEngineerRow = page.getByLabel("Workspace teammates").locator(".teammate-draft-row").filter({ hasText: "Ling Engineer" });
  await expect(lingEngineerRow.locator(".teammate-row-status.ready")).toContainText("Ready teammate");
  await expect(lingEngineerRow.getByLabel("Teammate actions")).toBeVisible();
  await expect(page.getByLabel("Workflow")).toHaveCount(0);
  await expect(page.locator(".teammate-detail-panel")).toHaveCount(0);

  await lingEngineerRow.getByLabel("Teammate actions").hover();
  await expect(lingEngineerRow.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await lingEngineerRow.getByRole("menuitem", { name: "Delete" }).click();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.displayName === "Ling Engineer");
    return isRecord(teammate) ? `${String(teammate.status)}:${String(teammate.hidden)}` : "missing";
  }).toBe("disabled:true");
  await expect(lingEngineerRow).toHaveCount(0);
  await expect(page.getByLabel("Workspace teammates")).toContainText("No workspace teammates");
});

test("AI teammate private workspace sends blocked chat replies and persists settings", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_engineer";
  state.providers = [
    createChatProvider({
      id: "provider_local",
      displayName: "Local Relay",
      model: "dpv4",
      lastCheck: { ok: true, code: "ready", message: "Provider is reachable.", checkedAt: "2026-05-29T00:00:00.000Z" },
    }),
    createChatProvider({
      id: "provider_alt",
      displayName: "Model Shuttle",
      model: "qwen-plus",
      lastCheck: { ok: true, code: "ready", message: "Provider is reachable.", checkedAt: "2026-05-29T00:00:00.000Z" },
    }),
  ];
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: undefined })];
  state.channels = state.channels.map((channel) =>
    isRecord(channel) && channel.id === "channel_engineering"
      ? { ...channel, defaultTeammateId: teammateId }
      : channel,
  );
  state.channels.push({
    id: "channel_design",
    workspaceId: "workspace_default",
    name: "Design",
    status: "active",
    boundPath: cwd,
    defaultTeammateId: "designer",
    allowedTools: ["read", "grep"],
    runtimePolicy: defaultRuntimePolicy,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
  });
  state.teammateChannelMemberships = [
    {
      teammateId,
      channelId: "channel_engineering",
      isDefault: true,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    },
  ];
  state.teammateSkillBindings = [
    {
      teammateId,
      skillId: "implement",
      source: "template",
      enabled: true,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    },
  ];
  state.teammateMemoryScopes = [
    {
      id: "memory_private",
      teammateId,
      kind: "private-chat-summary",
      enabled: true,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    },
  ];
  state.memoryObjects = [
    {
      id: "memory_private_acceptance",
      workspaceId: "workspace_default",
      scopeType: "teammate",
      ownerId: teammateId,
      title: "Private acceptance memory",
      body: "Private workspace replies should keep acceptance criteria concise.",
      tags: ["private-chat"],
      sourceRefs: [],
      reviewState: "active",
      enabled: true,
      sensitivity: "private",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    },
  ];
  state.usedMemoryEvents = [
    {
      id: "used_memory_private_acceptance",
      workspaceId: "workspace_default",
      memoryIds: ["memory_private_acceptance"],
      intent: "private-chat",
      recallQuery: "private workspace acceptance criteria",
      teammateId,
      responseId: "tdmsg_2",
      policyVersion: "ling-memory-v1-lexical",
      createdAt: "2026-05-29T00:10:01.000Z",
    },
  ];
  state.teammateDirectMessages = [
    {
      id: "tdmsg_pending_reply",
      workspaceId: "workspace_default",
      threadId: `tdthread_${teammateId}`,
      teammateId,
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "",
      attachmentIds: [],
      status: "pending",
      createdAt: "2026-05-29T00:09:58.000Z",
      updatedAt: "2026-05-29T00:09:58.000Z",
    },
  ];
  state.channelMessages = [
    {
      id: "chmsg_deleted_teammate_history",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "ai_reply",
      intent: "discuss",
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "Historical channel reply from a teammate that will be deleted.",
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: "2026-05-29T00:00:30.000Z",
      updatedAt: "2026-05-29T00:00:30.000Z",
    },
    ...state.channelMessages,
  ];
  state.tasks = [
    {
      id: "task_teammate",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      title: "Private workspace task",
      prompt: "Verify teammate private workspace.",
      status: "todo",
      assigneeTeammateId: teammateId,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z",
    },
    ...state.tasks,
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: "Ling Engineer" }).click();
  await expect(page.getByRole("heading", { name: "Ling Engineer", level: 1 })).toBeVisible();
  await expect(page.locator(".brand-mark")).toHaveCount(0);
  await expect.poll(() => readSidebarSelection(page)).toEqual({ activeNav: [], selectedRows: ["Ling Engineer"] });
  await expect(page.getByText("Model needs setup")).toBeVisible();
  const privateChatDarkSurfaces = await page.evaluate(() => {
    const selectors = [
      ".teammate-workspace-hero",
      ".teammate-chat-composer",
      ".teammate-chat-composer .primary-button:disabled",
    ];
    return selectors.flatMap((selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        return [];
      }
      const color = element ? getComputedStyle(element).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number) ?? [] : [];
      return [{
        selector,
        maxChannel: color.length > 0 ? Math.max(...color) : 255,
      }];
    });
  });
  for (const surface of privateChatDarkSurfaces) {
    expect(surface.maxChannel, `${surface.selector} should stay on dark console tokens`).toBeLessThanOrEqual(45);
  }

  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0);
  const privateFeed = page.getByLabel("Private message feed", { exact: true });
  await expect(privateFeed).toBeVisible();
  await expect(privateFeed.locator(".message-feed-virtualizer")).toBeVisible();
  const pendingPrivateRow = page.locator(".teammate-message-row.ai-teammate").filter({ hasText: "AI teammate is replying..." });
  await expect(pendingPrivateRow).toBeVisible();
  await expect(pendingPrivateRow).toHaveClass(/message-bubble/);
  await expect(pendingPrivateRow).toHaveClass(/message-bubble-peer/);
  await expect(pendingPrivateRow).toHaveClass(/message-bubble-pending/);
  await expect(pendingPrivateRow.locator(".message-pending-spinner")).toBeVisible();
  await expect(pendingPrivateRow.locator(".status-badge")).toHaveCount(0);
  await page.locator(".teammate-direct-composer input[type=file]").setInputFiles({
    name: "private-notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# private notes"),
  });
  await expect.poll(() => state.teammatePrivateAttachments.length).toBe(1);

  await page.getByPlaceholder("Message this AI teammate privately").fill("Please refine the private workspace acceptance criteria.");
  await page.getByPlaceholder("Message this AI teammate privately").press("Enter");
  await expect(page.getByText("Please refine the private workspace acceptance criteria.")).toBeVisible();
  await expect(page.getByLabel("Private chat", { exact: true }).getByText("AI teammate is blocked: No provider preset is selected for this teammate.")).toBeVisible();
  const privateMessageRow = page.locator(".teammate-message-row").filter({ hasText: "Please refine the private workspace acceptance criteria." });
  await expect(privateMessageRow).toHaveClass(/message-bubble-inline/);
  await expect(privateMessageRow).toHaveClass(/message-bubble-own/);
  await expect(privateMessageRow.locator("header")).toHaveCount(0);
  await expect(privateMessageRow.locator(".status-badge")).toHaveCount(0);
  await expect(privateMessageRow.getByRole("link", { name: "private-notes.md" })).toHaveAttribute("href", /\/attachments\/tpatt_1\/content/);
  const blockedPrivateRow = page.locator(".teammate-message-row.ai-teammate").filter({ hasText: "AI teammate is blocked: No provider preset is selected for this teammate." });
  await expect(blockedPrivateRow).toHaveClass(/message-bubble-chat-blocked/);
  await expect(blockedPrivateRow).toHaveClass(/message-bubble-peer/);
  await expect(blockedPrivateRow.locator(".status-badge")).toHaveCount(0);
  await expect(page.getByLabel("Conversation context").getByText("Private acceptance memory")).toBeVisible();
  await expect.poll(() => state.teammateDirectMessages.length).toBe(3);
  await expect.poll(() => {
    const message = state.teammateDirectMessages.find((item) =>
      isRecord(item) && item.body === "Please refine the private workspace acceptance criteria."
    );
    return isRecord(message) && Array.isArray(message.attachmentIds) ? message.attachmentIds : [];
  }).toEqual(["tpatt_1"]);

  await page.locator(".teammate-message-row").filter({ hasText: "Please refine the private workspace acceptance criteria." }).getByRole("button", { name: "Create task" }).click();
  await expect.poll(() => {
    const created = state.tasks.find((task) =>
      isRecord(task) &&
      task.prompt === "Please refine the private workspace acceptance criteria." &&
      task.assigneeTeammateId === teammateId
    );
    return isRecord(created) ? created.channelId : undefined;
  }).toBe("channel_engineering");

  await page.getByLabel("AI teammate private chat").getByRole("button", { name: "Settings" }).click();
  const settingsSections = page.getByLabel("Settings sections");
  await expect(settingsSections).toBeVisible();
  await settingsSections.getByRole("button", { name: /Channels/ }).click();
  await expect(page.getByText("Engineering").first()).toBeVisible();
  const designRow = page.locator(".teammate-channel-row").filter({ hasText: "Design" });
  await expect(designRow).toContainText("Not joined");
  await designRow.getByRole("button", { name: "Join" }).click();
  await expect.poll(() => state.teammateChannelMemberships.some((item) =>
    isRecord(item) && item.teammateId === teammateId && item.channelId === "channel_design"
  )).toBe(true);
  await expect(designRow.getByRole("button", { name: "Set default" })).toHaveCount(0);
  await expect.poll(() => {
    const membership = state.teammateChannelMemberships.find((item) =>
      isRecord(item) && item.teammateId === teammateId && item.channelId === "channel_design"
    );
    return isRecord(membership) ? membership.isDefault : false;
  }).toBe(false);
  const engineeringRow = page.locator(".teammate-channel-row").filter({ hasText: "Engineering" });
  await engineeringRow.getByRole("button", { name: "Leave" }).click();
  await expect.poll(() => state.teammateChannelMemberships.some((item) =>
    isRecord(item) && item.teammateId === teammateId && item.channelId === "channel_engineering"
  )).toBe(false);

  await settingsSections.getByRole("button", { name: /Skills/ }).click();
  const skillsPanel = page.locator(".teammate-skills-panel");
  await expect(skillsPanel).toContainText("Implementation");
  const skillsDarkSurfaces = await page.evaluate(() => {
    const selectors = [".teammate-skill-add-row", ".teammate-skill-row", ".teammate-skills-panel .phase-token"];
    return selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)).map((element) => {
        const color = getComputedStyle(element).backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
        return {
          selector,
          maxChannel: color.length > 0 ? Math.max(...color) : 255,
        };
      }),
    );
  });
  expect(skillsDarkSurfaces.length).toBeGreaterThan(0);
  for (const surface of skillsDarkSurfaces) {
    expect(surface.maxChannel, `${surface.selector} should stay on dark console tokens`).toBeLessThanOrEqual(45);
  }
  await skillsPanel.getByPlaceholder("Search Skill or blocked reason").fill("Engineering Plan Review");
  const engineeringReviewRow = skillsPanel.getByRole("row", { name: /Engineering Plan Review/ });
  await expect(engineeringReviewRow).toContainText("Available skill");
  await engineeringReviewRow.getByRole("button", { name: "Bind" }).click();
  await expect.poll(() => state.teammateSkillBindings.some((item) =>
    isRecord(item) && item.teammateId === teammateId && item.skillId === "plan-eng-review" && item.enabled === true
  )).toBe(true);
  await expect(skillsPanel).toContainText("Skills updated");
  await skillsPanel.getByPlaceholder("Search Skill or blocked reason").fill("");
  const implementationRow = skillsPanel.getByRole("row", { name: /Implementation implement/ });
  await expect(implementationRow.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await implementationRow.getByRole("button", { name: "Disable" }).click();
  await expect.poll(() => {
    const binding = state.teammateSkillBindings.find((item) =>
      isRecord(item) && item.teammateId === teammateId && item.skillId === "implement"
    );
    return isRecord(binding) ? binding.enabled : undefined;
  }).toBe(false);
  await skillsPanel.getByRole("button", { name: "Import" }).click();
  await skillsPanel.getByLabel("Draft name").fill("Custom QA Pack");
  await skillsPanel.getByLabel("Source path").fill("skills/custom-qa/SKILL.md");
  await skillsPanel.getByLabel("Skill content").fill([
    "# Custom QA Drill",
    "id: custom-qa-drill",
    "summary: Run a focused QA pass for private workspace changes.",
    "Keep approval and secret instructions as review-only text.",
  ].join("\n"));
  await skillsPanel.getByRole("button", { name: "Preview draft" }).click();
  await expect(skillsPanel).toContainText("custom-qa-drill");
  await expect(skillsPanel).toContainText("Permission-like instruction");
  await skillsPanel.getByRole("button", { name: "Publish to registry" }).click();
  await expect.poll(() => state.skillRegistryEntries.some((item) =>
    isRecord(item) && item.id === "custom-qa-drill" && item.reviewStatus === "published"
  )).toBe(true);
  await expect(skillsPanel).toContainText("Published 1 skills");
  const skillIdInput = skillsPanel.getByLabel("Skill id");
  await skillIdInput.fill("custom-qa-drill");
  await skillIdInput.press("Enter");
  await expect.poll(() => {
    const binding = state.teammateSkillBindings.find((item) =>
      isRecord(item) && item.teammateId === teammateId && item.skillId === "custom-qa-drill"
    );
    return isRecord(binding) ? [binding.source, binding.enabled] : undefined;
  }).toEqual(["user", true]);
  const customSkillRow = skillsPanel.getByRole("row", { name: /Custom QA Drill/ });
  await expect(customSkillRow).toContainText("User skill");
  await customSkillRow.getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => state.teammateSkillBindings.some((item) =>
    isRecord(item) && item.teammateId === teammateId && item.skillId === "custom-qa-drill"
  )).toBe(false);
  await expect(customSkillRow).toContainText("Registry skill");
  await customSkillRow.getByRole("button", { name: "Archive" }).click();
  await expect.poll(() => state.skillRegistryEntries.some((item) =>
    isRecord(item) && item.id === "custom-qa-drill" && item.reviewStatus === "archived"
  )).toBe(true);

  await settingsSections.getByRole("button", { name: /Memory/ }).click();
  await expect(page.getByText("Private chat summary")).toBeVisible();

  await settingsSections.getByRole("button", { name: /Profile/ }).click();
  const profilePanel = page.getByLabel("Teammate settings");
  await profilePanel.getByLabel("Teammate name").fill("Renamed Engineer");
  await profilePanel.getByLabel("Description").fill("Updated teammate description from settings.");
  await profilePanel.getByLabel("System prompt").fill("Updated teammate system prompt from settings.");
  await page.getByLabel("Single agent settings").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  await expect(page.getByLabel("Single agent settings").getByRole("heading", { name: "Renamed Engineer settings", level: 2 })).toBeVisible();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate)
      ? {
          displayName: teammate.displayName,
          description: teammate.description,
          systemPrompt: teammate.systemPrompt,
        }
      : undefined;
  }).toEqual({
    displayName: "Renamed Engineer",
    description: "Updated teammate description from settings.",
    systemPrompt: "Updated teammate system prompt from settings.",
  });

  await settingsSections.getByRole("button", { name: /Model/ }).click();
  const modelPanel = page.locator(".teammate-model-panel");
  await modelPanel.getByLabel("Provider").selectOption("provider_alt");
  await expect(modelPanel.locator(".teammate-config-card")).toContainText("Model Shuttle");
  await expect(modelPanel.locator(".teammate-config-card")).toContainText("qwen-plus");
  await modelPanel.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? teammate.providerPresetId : undefined;
  }).toBe("provider_alt");

  await page.getByRole("button", { name: "Back to private chat" }).click();
  await expect(page.getByRole("heading", { name: "Renamed Engineer", level: 1 })).toBeVisible();
  await page.getByPlaceholder("Message this AI teammate privately").fill("Use the newly saved model.");
  await page.getByPlaceholder("Message this AI teammate privately").press("Enter");
  await expect(page.getByLabel("Private chat", { exact: true }).getByText("Private reply: I will refine this into a scoped task.")).toBeVisible();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Design" }).click();
  await page.locator(".channel-header-actions").getByRole("button", { name: "AI teammate management" }).click();
  const channelTeammateManager = page.getByLabel("Channel teammates");
  const renamedEngineerChip = channelTeammateManager.locator(".channel-teammate-chip").filter({ hasText: "Renamed Engineer" });
  await expect(renamedEngineerChip).toBeVisible();
  await expect(renamedEngineerChip).not.toHaveClass(/default/);

  await page.reload();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Renamed Engineer" }).click();
  await expect(page.getByRole("heading", { name: "Renamed Engineer", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Private chat", { exact: true }).getByText("AI teammate is blocked: No provider preset is selected for this teammate.")).toBeVisible();

  await page.getByLabel("AI teammate private chat").getByRole("button", { name: "Settings" }).click();
  const personaPanel = page.getByLabel("Persona import");
  await personaPanel.getByLabel("Source path").fill("AGENTS.md");
  await personaPanel.getByLabel("Persona content").fill([
    "# Imported QA Persona",
    "Review private workspace changes carefully.",
    "Do not grant tools, approvals, secrets, or external send permissions.",
  ].join("\n"));
  await personaPanel.getByRole("button", { name: "Preview draft" }).click();
  await expect(personaPanel.getByText("Draft ready")).toBeVisible();
  await expect(personaPanel.getByText("Permission-like persona text was ignored for authority changes.")).toBeVisible();
  await personaPanel.getByRole("button", { name: "Apply persona draft" }).click();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? [teammate.displayName, teammate.appendSystemPrompt, teammate.allowedTools, teammate.approvalProfile] : undefined;
  }).toEqual(["Imported QA Persona", [], ["read", "grep", "find", "ls"], { mode: "standard", risk: "medium" }]);
  await expect(page.getByLabel("Single agent settings").getByRole("heading", { name: "Imported QA Persona settings", level: 2 })).toBeVisible();

  await page.getByLabel("Avatar").locator("input[type=file]").setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from("png"),
  });
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? teammate.avatarImageAttachmentId : undefined;
  }).toBe("tpatt_2");
  await expect(page.getByLabel("Avatar").locator(".teammate-avatar-image")).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").locator(".sidebar-row.selected .teammate-avatar-image")).toBeVisible();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "AI Teammates" }).click();
  const rosterRowWithAvatar = page.locator(".teammate-draft-row").filter({ hasText: "Imported QA Persona" });
  await expect(rosterRowWithAvatar.locator(".teammate-avatar-image")).toBeVisible();

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Design" }).click();
  await page.locator(".channel-header-actions").getByRole("button", { name: "AI teammate management" }).click();
  const channelChipWithAvatar = page.getByLabel("Channel teammates").locator(".channel-teammate-chip").filter({ hasText: "Imported QA Persona" });
  await expect(channelChipWithAvatar.locator(".teammate-avatar-image")).toBeVisible();
  await expect(channelChipWithAvatar).not.toHaveClass(/default/);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Imported QA Persona" }).click();
  await page.getByLabel("AI teammate private chat").getByRole("button", { name: "Settings" }).click();

  await page.getByRole("button", { name: "Remove avatar" }).click();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? teammate.avatarImageAttachmentId : "missing";
  }).toBeUndefined();
  await expect(page.getByLabel("Avatar").locator(".teammate-avatar-image")).toHaveCount(0);
  await expect(page.getByLabel("Ling Stack navigation").locator(".sidebar-row.selected .teammate-avatar-image")).toHaveCount(0);

  await page.getByLabel("Settings sections").getByRole("button", { name: "Danger zone" }).click();
  await page.getByPlaceholder("Reason").fill("owner request");
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("Hard delete this teammate");
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Hard delete" }).click();
  await expect.poll(() => state.retentionTombstones.length).toBe(1);
  await expect.poll(() => state.aiTeammates.some((item) => isRecord(item) && item.id === teammateId)).toBe(false);
  await expect.poll(() => state.teammatePrivateAttachments.some((item) => isRecord(item) && item.teammateId === teammateId)).toBe(false);
  await expect(page.getByRole("heading", { name: "AI Teammates", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Renamed Engineer" })).toHaveCount(0);
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Engineering" }).click();
  const deletedHistoryMessage = page.locator(".message-group").filter({ hasText: "Historical channel reply from a teammate that will be deleted." });
  await expect(deletedHistoryMessage).toContainText("Deleted teammate");
  await expect(deletedHistoryMessage).not.toContainText(teammateId);
});

test("AI teammate memory tab imports Markdown as review candidates", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_engineer";
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: undefined })];
  state.memoryObjects = [
    {
      id: "memory_existing_export",
      workspaceId: "workspace_default",
      scopeType: "workspace",
      ownerId: "workspace_default",
      title: "Existing export memory",
      body: "Existing memory can be exported from the Memory tab.",
      tags: ["export"],
      sourceRefs: [{ type: "manual", id: "manual_export", label: "Manual export" }],
      reviewState: "active",
      enabled: true,
      sensitivity: "normal",
      verifyBeforeUse: false,
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-18T00:00:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  await page.getByLabel("AI teammate private chat").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Memory/ }).click();

  const memoryPanel = page.locator(".teammate-memory-panel");
  await expect(memoryPanel.getByRole("heading", { name: "Memory" })).toBeVisible();
  await expect(memoryPanel.getByText("Markdown transfer")).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await memoryPanel.getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/memory-export-workspace_default-/);
  await expect(memoryPanel).toContainText("Downloaded 1 memories");

  await memoryPanel.getByLabel("Source label").fill("web-import.md");
  await memoryPanel.getByPlaceholder("Paste a Ling memory Markdown export").fill(markdownImportFixture());
  await memoryPanel.getByRole("button", { name: "Preview import" }).click();

  await expect(memoryPanel).toContainText("Preview ready: 1 candidates");
  const preview = memoryPanel.locator(".teammate-memory-import-preview");
  await expect(preview.locator("span").filter({ hasText: "Candidates" }).locator("strong")).toHaveText("1");
  await expect(preview.locator("span").filter({ hasText: "Skipped" }).locator("strong")).toHaveText("0");
  await expect(preview.locator("span").filter({ hasText: "Warnings" }).locator("strong")).toHaveText("2");
  await expect(memoryPanel).toContainText("retrievalProviderId was not imported.");
  await expect(memoryPanel).toContainText('Original reviewState "active" was imported as candidate.');
  await expect.poll(() => state.memoryMarkdownImportCalls).toEqual([
    {
      dryRun: true,
      sourceLabel: "web-import.md",
      candidateCount: 1,
      skippedCount: 0,
    },
  ]);
  await expect.poll(() => state.memoryObjects.map((item) => isRecord(item) ? item.title : undefined)).not.toContain("Web import preview memory");

  await memoryPanel.getByRole("button", { name: "Import candidates" }).click();
  await expect(memoryPanel).toContainText("Imported 1 candidates");
  await expect.poll(() => state.memoryMarkdownImportCalls.map((call) => call.dryRun)).toEqual([true, false]);
  await expect.poll(() => {
    const imported = state.memoryObjects.find((item) => isRecord(item) && item.title === "Web import preview memory");
    return isRecord(imported)
      ? {
          reviewState: imported.reviewState,
          enabled: imported.enabled,
          retrievalProviderId: imported.retrievalProviderId,
          sourceRefs: Array.isArray(imported.sourceRefs) ? imported.sourceRefs.map((ref) => isRecord(ref) ? ref.type : undefined) : [],
        }
      : undefined;
  }).toEqual({
    reviewState: "candidate",
    enabled: true,
    retrievalProviderId: undefined,
    sourceRefs: ["manual", "import"],
  });
  await expect(memoryPanel.locator(".teammate-memory-review-card").filter({ hasText: "Web import preview memory" })).toBeVisible();
});

test("AI teammate settings save status and visibility fields", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "pending" });
  const teammateId = "teammate_builtin_engineer";
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: undefined })];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  await page.getByLabel("AI teammate private chat").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Profile/ }).click();
  const profilePanel = page.getByLabel("Teammate settings");
  await profilePanel.getByLabel("Status").selectOption("paused");
  await profilePanel.getByLabel("Pinned in sidebar").setChecked(false);
  await profilePanel.getByLabel("Hidden from sidebar").setChecked(true);
  await page.getByLabel("Single agent settings").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved")).toBeVisible();

  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? [teammate.status, teammate.pinned, teammate.hidden] : undefined;
  }).toEqual(["paused", false, true]);
  await expect(page.getByRole("heading", { name: "Ling Engineer settings", level: 2 })).toBeVisible();
});

test("AI teammate private chat previews image attachments and keeps them in message history", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_engineer";
  state.providers = [
    createChatProvider({
      id: "provider_local",
      displayName: "Local Relay",
      model: "vision-chat",
      input: ["text", "image"],
      capabilities: ["chat", "vision"],
      lastCheck: { ok: true, code: "ready", message: "Provider is reachable.", checkedAt: "2026-06-04T00:00:00.000Z" },
    }),
  ];
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: "provider_local" })];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  const privateComposer = page.locator(".teammate-direct-composer");
  await privateComposer.locator("input[type=file]").setInputFiles({
    name: "direct-shot.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
  });
  await expect(privateComposer.locator(".composer-preview-thumbnail[alt='direct-shot.png']")).toBeVisible();
  await expect.poll(() => {
    const attachment = state.teammatePrivateAttachments.find((item) => isRecord(item) && item.fileName === "direct-shot.png");
    return isRecord(attachment) ? attachment.kind : undefined;
  }).toBe("image");

  const privateInput = privateComposer.locator("textarea");
  await privateInput.fill("Please read this private image.");
  await privateInput.press("Enter");

  const privateChat = page.getByLabel("Private chat", { exact: true });
  const userMessage = privateChat.locator(".teammate-message-row.local-user").filter({ hasText: "Please read this private image." });
  await expect(userMessage).toContainText("direct-shot.png");
  await expect(privateChat.getByText("Private reply: I can see the image attachment direct-shot.png.")).toBeVisible();
  await expect(privateComposer.getByLabel("Pending message assets")).toHaveCount(0);
  await expect.poll(() => {
    const message = state.teammateDirectMessages.find((item) => isRecord(item) && item.body === "Please read this private image.");
    return isRecord(message) ? message.attachmentIds : [];
  }).toEqual(["tpatt_1"]);

  await page.reload();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  const reloadedMessage = page.getByLabel("Private chat", { exact: true }).locator(".teammate-message-row.local-user").filter({ hasText: "Please read this private image." });
  await expect(reloadedMessage).toContainText("direct-shot.png");
});

test("AI teammate private chat opens latest messages and loads older history from the top", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_designer";
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Designer" })];
  state.teammateDirectMessages = Array.from({ length: 106 }, (_, index) => ({
    id: `tdmsg_history_${index + 1}`,
    workspaceId: "workspace_default",
    threadId: `tdthread_${teammateId}`,
    teammateId,
    authorType: index % 2 === 0 ? "local-user" : "ai-teammate",
    authorId: index % 2 === 0 ? "local-user" : teammateId,
    body: `private history ${index + 1}`,
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: new Date(Date.UTC(2026, 5, 16, 0, index, 0)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 5, 16, 0, index, 0)).toISOString(),
  }));
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Designer" }).click();
  const privateChat = page.getByLabel("Private chat", { exact: true });
  await expect(privateChat.getByText("private history 106", { exact: true })).toBeVisible();
  await expect(privateChat.getByText("private history 1", { exact: true })).toHaveCount(0);

  const feed = page.locator(".teammate-message-list");
  await feed.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect.poll(() => page.locator(".teammate-message-row", { hasText: "private history 1" }).count()).toBeGreaterThan(0);
  await feed.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(privateChat.getByText("private history 1", { exact: true })).toBeVisible();
});

test("AI teammate private chat demotes recovered provider preflight history", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_engineer";
  const provider = createChatProvider({
    id: "provider_relay",
    displayName: "中转站",
    lastCheck: {
      ok: true,
      code: "ready",
      message: "Provider is reachable and accepted the configured model.",
      checkedAt: "2026-06-09T00:00:00.000Z",
    },
  });
  state.providers = [provider];
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: "provider_relay" })];
  state.teammateDirectMessages = [
    {
      id: "tdmsg_old_timeout",
      workspaceId: "workspace_default",
      threadId: `tdthread_${teammateId}`,
      teammateId,
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "AI teammate is blocked: 中转站: provider check failed (network_failed). Provider network check failed: The operation was aborted due to timeout",
      errorMessage: "中转站: provider check failed (network_failed). Provider network check failed: The operation was aborted due to timeout",
      attachmentIds: [],
      status: "blocked",
      createdAt: "2026-06-09T00:00:00.000Z",
      updatedAt: "2026-06-09T00:00:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  const privateChat = page.locator(".teammate-private-chat");
  await expect(privateChat).toContainText("历史模型检查失败，当前模型已恢复。可以重新发送或继续对话。");
  await expect(privateChat).not.toContainText("AI teammate is blocked");
  await expect(privateChat).not.toContainText("Provider network check failed");
});

test("AI teammate private chat exposes direct reply guidance and stop controls", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_engineer";
  const threadId = `tdthread_${teammateId}`;
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: undefined })];
  state.teammateDirectMessages = [
    {
      id: "tdmsg_pending_reply",
      workspaceId: "workspace_default",
      threadId,
      teammateId,
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "",
      attachmentIds: [],
      status: "pending",
      createdAt: "2026-05-29T00:09:58.000Z",
      updatedAt: "2026-05-29T00:09:58.000Z",
    },
  ];
  state.workUnits = [
    {
      id: "wu_direct_pending",
      workspaceId: "workspace_default",
      kind: "teammate_direct_reply",
      ownerType: "teammate",
      ownerId: teammateId,
      teammateId,
      idempotencyKey: "direct-reply:pending",
      status: "running",
      priority: 50,
      attemptCount: 1,
      activeAttemptId: "wua_direct_pending",
      createdByActor: "user",
      request: { sourceMessageId: "tdmsg_user_source" },
      timeoutPolicy: { staleAfterMs: 120000, timeoutAfterMs: 300000 },
      linkedMessageId: "tdmsg_pending_reply",
      createdAt: "2026-05-29T00:09:57.000Z",
      updatedAt: "2026-05-29T00:09:58.000Z",
      startedAt: "2026-05-29T00:09:58.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  const guidance = page.getByLabel("正在回复");
  const privateComposer = page.locator(".teammate-direct-composer");
  const privateInput = privateComposer.getByPlaceholder("输入引导，回车加入队列");
  await expect(guidance).toBeVisible();
  await expect(guidance.locator("textarea")).toHaveCount(0);
  await expect(privateComposer.getByRole("button", { name: "停止回复" })).toBeEnabled();

  await privateInput.fill("Continue with only risks after this reply.");
  await privateInput.press("Enter");
  await expect.poll(() => state.teammateDirectInterventions.map((item) => [item.mode, item.status, item.instruction])).toEqual([
    ["queue_followup", "queued", "Continue with only risks after this reply."],
  ]);
  await expect(privateInput).toHaveValue("");
  await expect(guidance).toContainText("已排队");
  await expect(guidance.getByRole("button", { name: "立即执行这条引导" })).toBeEnabled();
  await expect(guidance.getByRole("button", { name: "删除排队引导" })).toBeEnabled();
  await guidance.getByRole("button", { name: "更多引导操作" }).click();
  await expect(guidance.getByRole("menuitem", { name: "编辑消息" })).toBeVisible();
  await expect(guidance.getByRole("menuitem", { name: "关闭排队" })).toBeVisible();
  await guidance.getByRole("menuitem", { name: "编辑消息" }).click();
  await expect(privateInput).toHaveValue("Continue with only risks after this reply.");
  await expect.poll(() => state.teammateDirectInterventions[0]?.status).toBe("cancelled");

  const guidanceAfterCancel = page.getByLabel("正在回复");
  await privateInput.fill("Line one");
  await privateInput.press("Shift+Enter");
  await expect(privateInput).toHaveValue("Line one\n");
  await expect.poll(() => state.teammateDirectInterventions.filter((item) => item.status === "queued").length).toBe(0);

  await privateInput.fill("Close only this queued guidance.");
  await privateInput.press("Enter");
  await expect.poll(() => state.teammateDirectInterventions.filter((item) => item.status === "queued").map((item) => item.instruction)).toEqual([
    "Close only this queued guidance.",
  ]);
  await expect(privateInput).toHaveValue("");
  await privateInput.fill("Keep this queued guidance.");
  await privateInput.press("Enter");
  await expect.poll(() => state.teammateDirectInterventions.filter((item) => item.status === "queued").map((item) => item.instruction)).toEqual([
    "Close only this queued guidance.",
    "Keep this queued guidance.",
  ]);
  const closeOnlyRow = guidanceAfterCancel.locator(".channel-run-guidance-row").filter({ hasText: "Close only this queued guidance." });
  await closeOnlyRow.getByRole("button", { name: "更多引导操作" }).click();
  await closeOnlyRow.getByRole("menuitem", { name: "关闭排队" }).click();
  await expect.poll(() => {
    const closed = state.teammateDirectInterventions.find((item) => item.instruction === "Close only this queued guidance.");
    const kept = state.teammateDirectInterventions.find((item) => item.instruction === "Keep this queued guidance.");
    return [closed?.status, kept?.status];
  }).toEqual(["cancelled", "queued"]);
  const keptRow = guidanceAfterCancel.locator(".channel-run-guidance-row").filter({ hasText: "Keep this queued guidance." });
  await expect(keptRow).toBeVisible();
  await expect(keptRow.getByRole("button", { name: "立即执行这条引导" })).toBeVisible();
  await keptRow.getByRole("button", { name: "删除排队引导" }).click();
  await expect.poll(() => {
    const kept = state.teammateDirectInterventions.find((item) => item.instruction === "Keep this queued guidance.");
    return kept?.status;
  }).toBe("cancelled");

  await privateInput.fill("Run this queued guidance immediately.");
  await privateInput.press("Enter");
  await expect.poll(() => state.teammateDirectInterventions.at(-1)?.status).toBe("queued");
  await guidanceAfterCancel.locator(".channel-run-guidance-row").filter({ hasText: "Run this queued guidance immediately." }).getByRole("button", { name: "立即执行这条引导" }).click();
  await expect.poll(() => state.teammateDirectInterventions.at(-1)?.status).toBe("cancelling_source");
  await expect.poll(() => state.workUnits[0]?.status).toBe("cancelled");
  await expect(page.getByLabel("私聊引导")).toContainText("正在停止");

  state.workUnits[0] = {
    ...state.workUnits[0],
    status: "running",
    endedAt: undefined,
    updatedAt: "2026-06-04T00:33:00.000Z",
  };
  await page.reload();
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  const resumedComposer = page.locator(".teammate-direct-composer");
  const resumedInput = resumedComposer.locator("textarea");
  await resumedInput.fill("Keep this draft while stopping.");
  await expect(resumedComposer.getByRole("button", { name: "排队执行" })).toBeEnabled();
  await resumedComposer.getByRole("button", { name: "排队执行" }).click();
  await expect.poll(() => state.teammateDirectInterventions.at(-1)?.instruction).toBe("Keep this draft while stopping.");
  await expect(resumedInput).toHaveValue("");
  await expect(resumedComposer.getByRole("button", { name: "停止回复" })).toBeEnabled();

  await resumedComposer.getByRole("button", { name: "停止回复" }).click();
  await expect.poll(() => state.workUnits[0]?.status).toBe("cancelled");
  await expect.poll(() => {
    const message = state.teammateDirectMessages.find((item) => isRecord(item) && item.id === "tdmsg_pending_reply");
    return isRecord(message) ? message.status : undefined;
  }).toBe("cancelled");
  await expect(resumedInput).toHaveValue("");
  await expect(page.getByLabel("Private message feed").getByText("回复已停止").first()).toBeVisible();
});

test("AI teammate private chat queues image attachments in direct guidance", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_engineer";
  const threadId = `tdthread_${teammateId}`;
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: undefined })];
  state.teammateDirectMessages = [
    {
      id: "tdmsg_pending_reply",
      workspaceId: "workspace_default",
      threadId,
      teammateId,
      authorType: "ai-teammate",
      authorId: teammateId,
      body: "",
      attachmentIds: [],
      linkPreviewIds: [],
      fileRefs: [],
      status: "pending",
      createdAt: "2026-06-04T00:45:00.000Z",
      updatedAt: "2026-06-04T00:45:00.000Z",
    },
  ];
  state.workUnits = [
    {
      id: "wu_direct_pending",
      workspaceId: "workspace_default",
      kind: "teammate_direct_reply",
      ownerType: "teammate",
      ownerId: teammateId,
      teammateId,
      idempotencyKey: "direct-reply:pending",
      status: "running",
      priority: 50,
      attemptCount: 1,
      activeAttemptId: "wua_direct_pending",
      createdByActor: "user",
      request: { sourceMessageId: "tdmsg_user_source" },
      timeoutPolicy: { staleAfterMs: 120000, timeoutAfterMs: 300000 },
      linkedMessageId: "tdmsg_pending_reply",
      createdAt: "2026-06-04T00:44:59.000Z",
      updatedAt: "2026-06-04T00:45:00.000Z",
      startedAt: "2026-06-04T00:45:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  const privateComposer = page.locator(".teammate-direct-composer");
  await privateComposer.locator("input[type=file]").setInputFiles({
    name: "queued-shot.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
  });
  await expect(privateComposer.locator(".composer-preview-thumbnail[alt='queued-shot.png']")).toBeVisible();
  await privateComposer.locator("textarea").fill("Use this new image before answering.");
  await privateComposer.locator("textarea").press("Enter");

  const guidance = page.getByLabel("正在回复");
  const queuedRow = guidance.locator(".channel-run-guidance-row").filter({ hasText: "Use this new image before answering." });
  await expect(queuedRow).toContainText("queued-shot.png");
  await expect.poll(() => {
    const intervention = state.teammateDirectInterventions.at(-1);
    return intervention?.messagePayload;
  }).toEqual({
    body: "Use this new image before answering.",
    attachmentIds: ["tpatt_1"],
    linkPreviewIds: [],
    fileRefs: [],
  });

  await queuedRow.getByRole("button", { name: "立即执行这条引导" }).click();
  await expect.poll(() => {
    const intervention = state.teammateDirectInterventions.at(-1);
    return [intervention?.status, intervention?.messagePayload?.attachmentIds];
  }).toEqual(["cancelling_source", ["tpatt_1"]]);
});

test("AI teammate private chat keeps queued guidance from bypassing into a new message", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "zh-CN");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_builtin_engineer";
  const threadId = `tdthread_${teammateId}`;
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Engineer", providerPresetId: undefined })];
  state.teammateDirectThreads[teammateId] = {
    id: threadId,
    workspaceId: "workspace_default",
    teammateId,
    title: "Ling Engineer",
    createdAt: "2026-06-04T00:40:00.000Z",
    updatedAt: "2026-06-04T00:40:00.000Z",
  };
  state.teammateDirectInterventions = [
    {
      id: "tdint_orphaned_queue",
      workspaceId: "workspace_default",
      teammateId,
      threadId,
      sourceMessageId: "tdmsg_old_source",
      sourceWorkUnitId: "wu_old_direct_reply",
      mode: "queue_followup",
      status: "queued",
      instruction: "Use the queued guidance before any new message.",
      idempotencyKey: "orphaned-queue",
      requestedBy: "local-user",
      createdAt: "2026-06-04T00:40:01.000Z",
      updatedAt: "2026-06-04T00:40:01.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Ling Engineer" }).click();
  const guidance = page.getByLabel("私聊引导");
  const queuedRow = guidance.locator(".channel-run-guidance-row").filter({ hasText: "Use the queued guidance before any new message." });
  await expect(queuedRow).toBeVisible();
  await expect(queuedRow.getByRole("button", { name: "立即执行这条引导" })).toBeVisible();

  const privateComposer = page.locator(".teammate-direct-composer");
  await expect(privateComposer.getByPlaceholder("已有排队引导，等待执行或点击立即执行")).toBeVisible();
  await expect(privateComposer.getByRole("button", { name: "发送" })).toBeDisabled();
  await privateComposer.getByPlaceholder("已有排队引导，等待执行或点击立即执行").fill("This should not bypass the queued row.");
  await privateComposer.getByPlaceholder("已有排队引导，等待执行或点击立即执行").press("Enter");
  await expect.poll(() => state.teammateDirectMessages.length).toBe(0);
  await expect(page.getByText("已有排队引导，先执行或删除队列消息。")).toBeVisible();
});

function markdownImportFixture(): string {
  return [
    "---",
    JSON.stringify({
      schemaVersion: 1,
      product: "ling-stack",
      kind: "ling-memory-markdown-export",
      workspaceId: "workspace_default",
      generatedAt: "2026-06-18T00:00:00.000Z",
      memoryCount: 1,
      skippedSecretAdjacentCount: 0,
      redactionApplied: false,
      authority: "projection-only",
    }),
    "---",
    "",
    "# Ling Memory Export",
    "",
    "## Web import preview memory",
    "",
    "### Metadata",
    "```json",
    JSON.stringify({
      id: "mem_exported_test",
      workspaceId: "workspace_default",
      scopeType: "workspace",
      ownerId: "workspace_default",
      reviewState: "active",
      sensitivity: "normal",
      enabled: true,
      verifyBeforeUse: true,
      tags: ["web", "import"],
      sourceRefs: [{ type: "manual", id: "manual_1", label: "Browser QA" }],
      retrievalProviderId: "vector-main",
    }),
    "```",
    "",
    "### Body",
    "```text",
    "Browser preview should create a candidate only.",
    "```",
    "",
  ].join("\n");
}
