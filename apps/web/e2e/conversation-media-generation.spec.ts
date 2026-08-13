import { expect, test, type Locator, type Page } from "@playwright/test";
import { installNormalWorkCellFixture, installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMediaProvider,
  cwd,
  type MockState,
} from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const readyCheck = {
  ok: true,
  code: "ready",
  message: "Provider is reachable.",
  checkedAt: "2026-08-12T00:00:00.000Z",
};

test("model workbench always exposes independent chat, image, and video default uses", async ({ page }) => {
  await useEnglish(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({ id: "chat_primary", displayName: "Primary Chat", model: "gpt-primary", lastCheck: readyCheck }),
    createChatProvider({ id: "chat_secondary", displayName: "Secondary Chat", model: "gpt-secondary", lastCheck: readyCheck }),
    createChatProvider({ id: "chat_unchecked", displayName: "Unchecked Chat", model: "gpt-unchecked" }),
    createChatProvider({
      id: "chat_custom_imported",
      displayName: "gpt-5.6-luna · gemini-pro-agent",
      providerId: "custom-openai-compatible",
      model: "gemini-pro-agent",
      lastCheck: readyCheck,
    }),
    createMediaProvider({ id: "image_seedream", displayName: "Seedream Studio", lastCheck: readyCheck }),
    createMediaProvider({
      id: "image_custom_imported",
      kind: "openai-compatible",
      displayName: "gpt-5.6-luna · gpt-image-2",
      providerId: "custom-openai-compatible",
      model: "gpt-image-2",
      lastCheck: readyCheck,
    }),
    createMediaProvider({ id: "image_openai", kind: "openai", providerId: "openai", model: "gpt-image-1", displayName: "OpenAI Images", lastCheck: readyCheck }),
    createMediaProvider({
      id: "video_seedance",
      kind: "seedance",
      providerId: "seedance",
      model: "doubao-seedance-1-0-pro-250528",
      displayName: "Seedance Studio",
      capabilities: ["video_generate"],
      input: ["text"],
      lastCheck: readyCheck,
    }),
  ];
  installImageWorkflowTarget(state);
  state.workspaceSettings = {
    ...state.workspaceSettings,
    defaultProviderPresetId: "chat_primary",
  };
  await mockDaemon(page, state);
  await page.goto("/");
  await openModelWorkbench(page);

  const defaults = page.locator(".provider-default-purpose-bar");
  const chat = defaults.getByLabel("Chat model");
  const image = defaults.getByLabel("Image generation target");
  const video = defaults.getByLabel("Video generation target");
  await expect(defaults).toBeVisible();
  await expect(defaults.getByText("Default uses", { exact: true })).toHaveCount(0);
  await expect(chat).toHaveValue("chat_primary");
  await expect(chat.locator("option", { hasText: "Unchecked Chat" })).toHaveCount(0);
  await expect(image.locator("option:checked")).toHaveText("Ask when used (4 available)");
  await expect(video.locator("option:checked")).toHaveText("Automatic selection (Model · Seedance Studio)");
  await expect(image.locator("option")).toContainText(["Ask when used (4 available)", "Model · Seedream Studio", "Model · OpenAI Images", "ComfyUI · Poster Flow"]);
  await expect(chat.locator('option[value="chat_custom_imported"]')).toHaveText("gemini-pro-agent");
  await expect(image.locator('option[value="provider:image_custom_imported"]')).toHaveText("Model · gpt-image-2");
  await expect(defaults).not.toContainText("gpt-5.6-luna");
  const purposeGeometry = await defaults.locator(".provider-default-purpose-field").evaluateAll((fields) =>
    fields.map((field) => {
      const label = field.querySelector<HTMLElement>("span")?.getBoundingClientRect();
      const select = field.querySelector<HTMLElement>("select")?.getBoundingClientRect();
      return {
        labelCenter: label ? label.y + label.height / 2 : 0,
        selectCenter: select ? select.y + select.height / 2 : 0,
        selectWidth: select?.width ?? 0,
      };
    })
  );
  expect(purposeGeometry.every((item) => Math.abs(item.labelCenter - item.selectCenter) <= 1)).toBe(true);
  expect(purposeGeometry.every((item) => item.selectWidth <= 221)).toBe(true);
  await expect(page.locator(".provider-row").getByRole("button", { name: /Set default|Current default/ })).toHaveCount(0);

  await chat.selectOption("chat_secondary");
  await image.selectOption("workflow:poster_flow");
  await expect.poll(() => state.workspaceSettings.mediaGenerationDefaults).toEqual({
    image: { kind: "workflow", workflowDefinitionId: "poster_flow" },
  });
  await expect(image.locator("option:checked")).toHaveText("ComfyUI · Poster Flow");
  await image.selectOption("provider:image_seedream");
  await video.selectOption("provider:video_seedance");
  await expect.poll(() => state.workspaceSettings.defaultProviderPresetId).toBe("chat_secondary");
  await expect.poll(() => state.workspaceSettings.mediaGenerationDefaults).toEqual({
    image: { kind: "provider", providerPresetId: "image_seedream" },
    video: { kind: "provider", providerPresetId: "video_seedance" },
  });
  await expect(image.locator("option:checked")).toHaveText("Model · Seedream Studio");
  await expect(video.locator("option:checked")).toHaveText("Model · Seedance Studio");

  await page.reload();
  await openModelWorkbench(page);
  const restored = page.locator(".provider-default-purpose-bar");
  await expect(restored.getByLabel("Chat model")).toHaveValue("chat_secondary");
  await expect(restored.getByLabel("Image generation target")).toHaveValue("provider:image_seedream");
  await expect(restored.getByLabel("Video generation target")).toHaveValue("provider:video_seedance");
});

test("default uses expose unavailable records, dangling references, and explicit clearing", async ({ page }) => {
  await useEnglish(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    createChatProvider({ id: "chat_ready", displayName: "Ready Chat", lastCheck: readyCheck }),
    createMediaProvider({
      id: "image_unchecked",
      displayName: "Unchecked Image",
      lastCheck: { ...readyCheck, ok: false, code: "failed", message: "Check failed." },
    }),
    createMediaProvider({
      id: "image_never_checked",
      displayName: "Never Checked Image",
      lastCheck: undefined,
    }),
  ];
  state.workspaceSettings = {
    ...state.workspaceSettings,
    defaultProviderPresetId: "chat_ready",
    mediaGenerationDefaults: {
      image: { kind: "provider", providerPresetId: "image_unchecked" },
      video: { kind: "workflow", workflowDefinitionId: "deleted_video_flow" },
    },
  };
  await mockDaemon(page, state);
  await page.goto("/");
  await openModelWorkbench(page);

  const defaults = page.locator(".provider-default-purpose-bar");
  const image = defaults.getByLabel("Image generation target");
  const video = defaults.getByLabel("Video generation target");
  await expect(image.locator("option:checked")).toHaveText("Model · Unchecked Image · Needs attention");
  await expect(video.locator("option:checked")).toHaveText("Unavailable target · Needs attention");
  const neverCheckedRow = page.locator(".provider-row").filter({ hasText: "Never Checked Image" });
  await expect(neverCheckedRow).toContainText("Needs check");
  await expect(neverCheckedRow).not.toContainText("Ready");
  await expect(image.locator("option", {
    hasText: "Model · Never Checked Image · Needs attention",
  })).toHaveCount(1);

  await image.selectOption({ label: "Not configured" });
  await expect.poll(() => state.workspaceSettings.mediaGenerationDefaults).toEqual({
    video: { kind: "workflow", workflowDefinitionId: "deleted_video_flow" },
  });
  await video.selectOption({ label: "Not configured" });
  await expect.poll(() => state.workspaceSettings.mediaGenerationDefaults).toBeUndefined();
  await expect(image.locator("option:checked")).toHaveText("Not configured");
  await expect(video.locator("option:checked")).toHaveText("Not configured");
});

test("normal conversation, channel, and teammate direct chat share one generated media projection", async ({ page }) => {
  await useEnglish(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const normalTitle = installNormalWorkCellFixture(state);
  const normalRunId = "run_ui2_normal_work_cell";
  const teammate = installTeammateWorkCellFixture(state);
  const teammateRunId = "run_ui2_teammate_work_cell";
  const channelRunId = "run_channel_media_shared";
  const channelMessageId = "message_channel_media_shared";
  state.channelMessages = [channelMessage(channelMessageId, channelRunId)];
  state.conversationGeneratedMedia = [
    generatedMedia({ mediaJobId: "media_normal", runId: normalRunId, status: "running", displayName: "Seedream Studio" }),
    generatedMedia({ mediaJobId: "media_channel", runId: channelRunId, status: "running", displayName: "Seedream Studio", messageId: channelMessageId }),
    generatedMedia({ mediaJobId: "media_teammate", runId: teammateRunId, status: "running", displayName: "Seedream Studio", messageId: "tdmsg_ui2_teammate_work_cell" }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await openNormalConversation(page, normalTitle);
  const normalBlock = page.getByLabel("Conversation page").getByLabel("Generated media");
  await expectPendingMediaBlock(normalBlock);
  const normalClass = await generatedMediaClass(normalBlock);

  await openEngineeringChannel(page);
  const channelBlock = page.getByLabel("Channel message feed").getByLabel("Generated media");
  await expectPendingMediaBlock(channelBlock);
  const channelClass = await generatedMediaClass(channelBlock);

  await openTeammate(page, teammate.displayName);
  const teammateBlock = page.getByLabel("Private message feed").getByLabel("Generated media");
  await expectPendingMediaBlock(teammateBlock);
  const teammateClass = await generatedMediaClass(teammateBlock);

  expect(new Set([normalClass, channelClass, teammateClass]).size).toBe(1);
});

test("generated media renders ordered image, video, failure, and cancellation states without overflow", async ({ page }) => {
  await useEnglish(page, "dark");
  await page.setViewportSize({ width: 1280, height: 800 });
  const browserErrors = collectBrowserErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const normalTitle = installNormalWorkCellFixture(state);
  const runId = "run_ui2_normal_work_cell";
  const imageArtifact = generatedArtifact({
    id: "artifact_conversation_image",
    mediaJobId: "media_success_image",
    type: "image",
    path: "quiet-city.svg",
    title: `Quiet city ${"wide title ".repeat(18)}`,
    contentType: "image/svg+xml",
  });
  const videoArtifact = generatedArtifact({
    id: "artifact_conversation_video",
    mediaJobId: "media_success_video",
    type: "video",
    path: "quiet-city.mp4",
    title: "Quiet city video",
    contentType: "video/mp4",
  });
  state.artifactsByMediaJob = {
    media_success_image: [imageArtifact],
    media_success_video: [videoArtifact],
  };
  state.conversationGeneratedMedia = [
    generatedMedia({
      mediaJobId: "media_success_image",
      runId,
      status: "succeeded",
      displayName: "Seedream Studio",
      artifacts: [imageArtifact],
      prompt: "A".repeat(2_000),
      createdAt: "2026-08-12T00:00:00.000Z",
    }),
    generatedMedia({
      mediaJobId: "media_success_video",
      runId,
      status: "succeeded",
      displayName: "ComfyUI Motion",
      operation: "video_generate",
      targetKind: "workflow",
      artifacts: [videoArtifact],
      createdAt: "2026-08-12T00:00:01.000Z",
    }),
    generatedMedia({
      mediaJobId: "media_failed",
      runId,
      status: "failed",
      displayName: "OpenAI Images",
      failureCode: "generation_authorization_required",
      createdAt: "2026-08-12T00:00:02.000Z",
    }),
    generatedMedia({
      mediaJobId: "media_policy_blocked",
      runId,
      status: "failed",
      displayName: "OpenAI Images",
      failureCode: "generation_content_policy_blocked",
      createdAt: "2026-08-12T00:00:02.500Z",
    }),
    generatedMedia({
      mediaJobId: "media_upstream_empty",
      runId,
      status: "failed",
      displayName: "OpenAI Images",
      failureCode: "generation_result_unavailable",
      createdAt: "2026-08-12T00:00:02.750Z",
    }),
    generatedMedia({
      mediaJobId: "media_cancelled",
      runId,
      status: "cancelled",
      displayName: "Seedream Studio",
      createdAt: "2026-08-12T00:00:03.000Z",
    }),
  ];
  await mockDaemon(page, state);
  await page.goto("/");
  await openNormalConversation(page, normalTitle);

  const list = page.getByLabel("Conversation page").getByLabel("Generated media");
  await expect(list.locator(".conversation-generated-media")).toHaveCount(6);
  await expect.poll(() => list.locator(".conversation-generated-media").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-media-job-id"))
  )).toEqual(["media_success_image", "media_success_video", "media_failed", "media_policy_blocked", "media_upstream_empty", "media_cancelled"]);

  const image = list.locator('img[alt^="Quiet city"]');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const video = list.locator("video");
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute("controls", "");
  await expect(video.locator("source")).toHaveAttribute("type", "video/mp4");
  await expect(list).not.toContainText("Generated by Seedream Studio");
  await expect(list).not.toContainText("Generated by ComfyUI Motion");
  await expect(list).not.toContainText("Quiet city video");
  await expect(list.locator(".status-succeeded .conversation-generated-media-header")).toHaveCount(0);
  const alignment = await Promise.all([
    list.boundingBox(),
    image.boundingBox(),
  ]);
  expect(Math.abs((alignment[0]?.x ?? 0) - (alignment[1]?.x ?? 0))).toBeLessThanOrEqual(1);
  await expect(list).toContainText("The generation target needs valid credentials");
  await expect(list).toContainText("The generation service rejected this request under its content policy");
  await expect(list).toContainText("The upstream generation service responded but did not return image data");
  await expect(list).toContainText("Media generation was cancelled");

  const open = list.getByRole("link", { name: "Open generated result" }).first();
  const download = list.getByRole("link", { name: "Download generated result" }).first();
  const mediaActions = list.locator(".status-succeeded .conversation-generated-media-artifact figcaption").first();
  await expect(open).toHaveAttribute("target", "_blank");
  await expect(open).toHaveAttribute("href", /\/artifacts\/artifact_conversation_image\/content/);
  await expect(download).toHaveAttribute("download", "quiet-city.svg");
  await expect(mediaActions).toHaveCSS("position", "absolute");
  await expect(mediaActions).toHaveCSS("opacity", "0");
  await image.hover();
  await expect(mediaActions).toHaveCSS("opacity", "1");
  await open.focus();
  await expect(open).toBeFocused();
  await expect(mediaActions).toHaveCSS("opacity", "1");

  expect(await list.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(browserErrors).toEqual([]);
});

function generatedMedia(input: {
  readonly mediaJobId: string;
  readonly runId: string;
  readonly status: "queued" | "running" | "waiting_for_approval" | "succeeded" | "failed" | "cancelled";
  readonly displayName: string;
  readonly messageId?: string;
  readonly operation?: "image_generate" | "video_generate";
  readonly targetKind?: "provider" | "workflow";
  readonly artifacts?: MockState["conversationGeneratedMedia"][number]["artifacts"];
  readonly failureCode?: MockState["conversationGeneratedMedia"][number]["failureCode"];
  readonly prompt?: string;
  readonly createdAt?: string;
}): MockState["conversationGeneratedMedia"][number] {
  return {
    mediaJobId: input.mediaJobId,
    runId: input.runId,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    operation: input.operation ?? "image_generate",
    target: {
      kind: input.targetKind ?? "provider",
      id: `${input.targetKind ?? "provider"}:${input.displayName.toLowerCase().replace(/\s+/gu, "_")}`,
      displayName: input.displayName,
    },
    prompt: input.prompt ?? "A quiet city at sunrise",
    status: input.status,
    artifacts: input.artifacts ?? [],
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    createdAt: input.createdAt ?? "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:01.000Z",
  };
}

function generatedArtifact(input: {
  readonly id: string;
  readonly mediaJobId: string;
  readonly type: "image" | "video";
  readonly path: string;
  readonly title: string;
  readonly contentType: string;
}): MockState["artifactsByMediaJob"][string][number] {
  return {
    ...input,
    sizeBytes: 4_096,
    createdAt: "2026-08-12T00:00:00.000Z",
  };
}

function installImageWorkflowTarget(state: MockState): void {
  const version = {
    id: "poster_flow_v1",
    workflowDefinitionId: "poster_flow",
    version: 1,
    sourceFormat: "comfy_api_json",
    sourceDigest: "poster-flow-digest",
    graphSnapshot: {},
    inputFields: [],
    outputRules: [{ nodeId: "9", artifactType: "image", collect: "first" }],
    validation: { ok: true, errors: [], warnings: [], checkedAt: "2026-08-12T00:00:00.000Z" },
    createdAt: "2026-08-12T00:00:00.000Z",
  };
  state.mediaWorkflowConnections = [{
    id: "poster_connection",
    workspaceId: "workspace_default",
    name: "Poster connection",
    adapterKind: "comfyui",
    baseUrl: "http://127.0.0.1:8188",
    authMode: "none",
    secretConfigured: false,
    networkPolicy: "trusted_private_network",
    protocolVariant: "auto",
    status: "ready",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  }];
  state.mediaWorkflows = [{
    definition: {
      id: "poster_flow",
      workspaceId: "workspace_default",
      connectionId: "poster_connection",
      name: "Poster Flow",
      status: "ready",
      currentVersionId: version.id,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
    currentVersion: version,
    versions: [version],
  }];
}

function channelMessage(id: string, linkedRunId: string): Record<string, unknown> {
  return {
    id,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "ling_agent",
    body: "The image generation task has started.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    linkedRunId,
    status: "ready",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:01.000Z",
  };
}

async function expectPendingMediaBlock(block: Locator): Promise<void> {
  await expect(block).toBeVisible();
  await expect(block).toContainText("Generating Image");
  await expect(block).toContainText("Using Seedream Studio");
  await expect(block.locator('[data-media-job-status="running"]')).toHaveCount(1);
  const spinner = block.locator(".conversation-generated-media-spinner");
  await expect(spinner).toBeVisible();
  await expect(spinner.locator("svg")).toHaveCSS("animation-name", "ling-ui-spinner-rotate");
  await expect(spinner.locator("svg")).toHaveCSS("animation-iteration-count", "infinite");
  const firstTransform = await spinner.locator("svg").evaluate((element) => getComputedStyle(element).transform);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const secondTransform = await spinner.locator("svg").evaluate((element) => getComputedStyle(element).transform);
  expect(firstTransform).not.toBe(secondTransform);
}

async function generatedMediaClass(block: Locator): Promise<string> {
  return await block.locator(".conversation-generated-media").getAttribute("class") ?? "";
}

async function useEnglish(page: Page, theme: "light" | "dark" = "light"): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  await page.addInitScript((selectedTheme) => {
    localStorage.setItem("ling-stack.themePreference", selectedTheme);
  }, theme);
}

function collectBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  return errors;
}

async function openModelWorkbench(page: Page): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Model Workbench" }).click();
  await expect(page.locator(".provider-workbench")).toBeVisible();
}

async function openNormalConversation(page: Page, title: string): Promise<void> {
  await page.getByLabel("Ling Stack navigation").locator(".sidebar-recent-row").filter({ hasText: title }).click();
  await expect(page.getByLabel("Conversation page")).toBeVisible();
}

async function openTeammate(page: Page, displayName: string): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: displayName }).click();
  await expect(page.getByRole("heading", { name: displayName, level: 1 })).toBeVisible();
  await expect(page.getByText("Loading teammate workspace...")).toHaveCount(0);
}
