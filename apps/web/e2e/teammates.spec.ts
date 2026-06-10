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
  await expect(page.getByLabel("Workspace teammates").locator(".teammate-draft-row").filter({ hasText: "Ling Engineer" }).locator(".teammate-status-dot.ready")).toBeVisible();
  const lingEngineerRow = page.getByLabel("Workspace teammates").locator(".teammate-draft-row").filter({ hasText: "Ling Engineer" });
  await expect(lingEngineerRow.getByLabel("Teammate actions")).toBeVisible();
  await expect(page.getByLabel("Workflow")).toHaveCount(0);
  await expect(page.locator(".teammate-detail-panel")).toHaveCount(0);

  await lingEngineerRow.getByLabel("Teammate actions").click();
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
  await page.getByRole("button", { name: "Send" }).click();
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
  await designRow.getByRole("button", { name: "Set default" }).click();
  await expect.poll(() => {
    const design = state.channels.find((channel) => isRecord(channel) && channel.id === "channel_design");
    return isRecord(design) ? design.defaultTeammateId : undefined;
  }).toBe(teammateId);
  await expect.poll(() => {
    const membership = state.teammateChannelMemberships.find((item) =>
      isRecord(item) && item.teammateId === teammateId && item.channelId === "channel_design"
    );
    return isRecord(membership) ? membership.isDefault : false;
  }).toBe(true);
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
  await page.getByLabel("Teammate name").fill("Renamed Engineer");
  await page.getByLabel("Single agent settings").getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved")).toBeVisible();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? teammate.displayName : "";
  }).toBe("Renamed Engineer");

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
    return isRecord(teammate) ? [teammate.displayName, teammate.allowedTools, teammate.approvalProfile] : undefined;
  }).toEqual(["Imported QA Persona", ["read", "grep", "find", "ls"], { mode: "standard", risk: "medium" }]);
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

  await page.getByRole("button", { name: "Remove avatar" }).click();
  await expect.poll(() => {
    const teammate = state.aiTeammates.find((item) => isRecord(item) && item.id === teammateId);
    return isRecord(teammate) ? teammate.avatarImageAttachmentId : "missing";
  }).toBeUndefined();
  await expect(page.getByLabel("Avatar").locator(".teammate-avatar-image")).toHaveCount(0);

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
    localStorage.setItem("ling-stack.locale", "en-US");
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
  const guidance = page.getByLabel("Replying");
  await expect(guidance).toBeVisible();
  await expect(guidance.getByRole("button", { name: "Stop reply" })).toBeEnabled();
  await expect(guidance.getByRole("button", { name: "Queue guidance" })).toBeDisabled();

  await guidance.getByPlaceholder("Add guidance").fill("Continue with only risks after this reply.");
  await guidance.getByRole("button", { name: "Queue guidance" }).click();
  await expect.poll(() => state.teammateDirectInterventions.map((item) => [item.mode, item.status, item.instruction])).toEqual([
    ["queue_followup", "queued", "Continue with only risks after this reply."],
  ]);
  await expect(guidance).toContainText("Queued");
  await expect(guidance.getByRole("button", { name: "Run this guidance now" })).toBeEnabled();
  await expect(guidance.getByRole("button", { name: "Delete queued guidance" })).toBeEnabled();
  await guidance.getByRole("button", { name: "More guidance actions" }).click();
  await expect(guidance.getByRole("menuitem", { name: "Edit message" })).toBeVisible();
  await expect(guidance.getByRole("menuitem", { name: "Close queue" })).toBeVisible();
  await guidance.getByRole("menuitem", { name: "Edit message" }).click();
  await expect(guidance.getByPlaceholder("Add guidance")).toHaveValue("Continue with only risks after this reply.");
  await expect.poll(() => state.teammateDirectInterventions[0]?.status).toBe("cancelled");

  const guidanceAfterCancel = page.getByLabel("Replying");
  await guidanceAfterCancel.getByPlaceholder("Add guidance").fill("Delete this queued guidance.");
  await guidanceAfterCancel.getByRole("button", { name: "Queue guidance" }).click();
  await expect.poll(() => state.teammateDirectInterventions.at(-1)?.status).toBe("queued");
  await guidanceAfterCancel.getByRole("button", { name: "Delete queued guidance" }).click();
  await expect.poll(() => state.teammateDirectInterventions.at(-1)?.status).toBe("cancelled");

  await guidanceAfterCancel.getByPlaceholder("Add guidance").fill("Close the whole guidance queue.");
  await guidanceAfterCancel.getByRole("button", { name: "Queue guidance" }).click();
  await expect.poll(() => state.teammateDirectInterventions.at(-1)?.status).toBe("queued");
  await guidanceAfterCancel.getByRole("button", { name: "More guidance actions" }).click();
  await guidanceAfterCancel.getByRole("menuitem", { name: "Close queue" }).click();
  await expect.poll(() => state.teammateDirectInterventions.at(-1)?.status).toBe("cancelled");

  await guidanceAfterCancel.getByPlaceholder("Add guidance").fill("Run this queued guidance immediately.");
  await guidanceAfterCancel.getByRole("button", { name: "Queue guidance" }).click();
  await expect.poll(() => state.teammateDirectInterventions.at(-1)?.status).toBe("queued");
  await guidanceAfterCancel.getByRole("button", { name: "Run this guidance now" }).click();
  await expect.poll(() => state.teammateDirectInterventions.at(-1)?.status).toBe("cancelling_source");
  await expect.poll(() => state.workUnits[0]?.status).toBe("cancelled");
  await expect(page.getByLabel("Private guidance")).toContainText("Stopping");

  state.workUnits[0] = {
    ...state.workUnits[0],
    status: "running",
    endedAt: undefined,
    updatedAt: "2026-06-04T00:33:00.000Z",
  };
  const resumedGuidance = page.getByLabel("Replying");
  await resumedGuidance.getByPlaceholder("Add guidance").fill("Stop and continue with blockers only.");
  await expect(resumedGuidance.getByRole("button", { name: "Stop and continue" })).toBeEnabled();
  await resumedGuidance.getByRole("button", { name: "Stop and continue" }).click();
  await expect.poll(() => state.teammateDirectInterventions.at(-1)?.mode).toBe("interrupt_redirect");
  await expect(resumedGuidance).toContainText("Stopping");

  await resumedGuidance.getByRole("button", { name: "Stop reply" }).click();
  await expect.poll(() => state.workUnits[0]?.status).toBe("cancelled");
  await expect.poll(() => {
    const message = state.teammateDirectMessages.find((item) => isRecord(item) && item.id === "tdmsg_pending_reply");
    return isRecord(message) ? message.status : undefined;
  }).toBe("cancelled");
  await expect(page.getByLabel("Private message feed").getByText("Reply stopped").first()).toBeVisible();
});
