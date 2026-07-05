import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
} from "./support/mock-state";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
});

test("generation tasks page lists, runs, and creates generation tasks", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    {
      id: "provider_seedream",
      kind: "seedream",
      displayName: "Seedream Image",
      providerId: "seedream",
      model: "seedream",
      api: "media-job",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKeyRef: "env:SEEDREAM_API_KEY",
      apiKeyConfigured: true,
      headers: {},
      input: ["text", "image"],
      compat: { mediaVendorTransport: { mode: "live" } },
      capabilities: ["image_generate", "image_edit"],
      enabled: true,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
    },
    {
      id: "provider_local",
      kind: "openai-compatible",
      displayName: "Local Relay",
      providerId: "local-relay",
      model: "dpv4",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:8317/v1",
      apiKeyRef: "env:LOCAL_RELAY_API_KEY",
      apiKeyConfigured: true,
      headers: {},
      authHeader: true,
      reasoning: true,
      input: ["text"],
      compat: {},
      capabilities: ["chat", "tool_call"],
      enabled: true,
      lastCheck: {
        ok: true,
        code: "ready",
        message: "Provider is reachable and accepted the configured model.",
        checkedAt: "2026-05-23T00:00:00.000Z",
      },
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
    },
  ];
  state.mediaJobs = [
    {
      id: "media_job_live_failed",
      workspaceId: "workspace_default",
      providerPresetId: "provider_seedream",
      operation: "image_generate",
      prompt: "Live product mockup.",
      input: {},
      artifactIds: [],
      status: "failed",
      errorMessage: "Seedream image generation failed with HTTP 429 Too Many Requests. rate limited",
      createdAt: "2026-05-23T00:00:30.000Z",
      updatedAt: "2026-05-23T00:01:00.000Z",
    },
    {
      id: "media_job_succeeded_image",
      workspaceId: "workspace_default",
      providerPresetId: "provider_seedream",
      operation: "image_generate",
      prompt: "Generated Seedream image artifact.",
      input: {},
      artifactIds: ["artifact_media_image"],
      status: "succeeded",
      createdAt: "2026-05-23T00:00:45.000Z",
      updatedAt: "2026-05-23T00:01:15.000Z",
    },
    {
      id: "media_job_existing",
      workspaceId: "workspace_default",
      providerPresetId: "provider_seedream",
      operation: "image_generate",
      prompt: "Existing product mockup.",
      input: {},
      artifactIds: [],
      status: "queued",
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
    },
  ];
  state.artifactsByMediaJob.media_job_succeeded_image = [
    {
      id: "artifact_media_image",
      mediaJobId: "media_job_succeeded_image",
      type: "image",
      path: "media_jobs/media_job_succeeded_image/001-seedream-image.png",
      title: "Seedream image 1",
      contentType: "image/png",
      sizeBytes: 4096,
      createdAt: "2026-05-23T00:01:15.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Generation" }).click();
  await expect(page.getByRole("heading", { name: "Generation tasks", level: 1 })).toBeVisible();
  const jobRows = page.locator(".media-job-row");
  const detailPanel = page.locator(".media-job-detail-panel");
  await expect(jobRows).toHaveCount(3);

  const failedJob = jobRows.nth(0);
  await expect(failedJob).toContainText("Needs attention");
  await expect(failedJob).not.toContainText("Live product mockup.");
  await expect(detailPanel).toContainText("Live product mockup.");
  await expect(detailPanel).toContainText("Seedream image generation failed with HTTP 429");

  const imageJob = jobRows.nth(1);
  await imageJob.click();
  await expect(detailPanel).toContainText("Generated Seedream image artifact.");
  await expect(imageJob).toContainText("Completed");
  await expect(imageJob.getByRole("button", { name: "Start generation" })).toHaveCount(0);
  await expect(imageJob.getByRole("button", { name: "Retry generation" })).toHaveCount(0);
  const imageArtifactRow = detailPanel.locator(".artifact-row").filter({ hasText: "Seedream image 1" });
  await expect(imageArtifactRow).toContainText("image");
  await expect(imageArtifactRow).toContainText("4.0 KB");
  await expect(imageArtifactRow.getByRole("link", { name: "Open" })).toHaveAttribute("href", /\/artifacts\/artifact_media_image\/content/);
  const mediaDownloadLink = imageArtifactRow.getByRole("link", { name: "Download" });
  await expect(mediaDownloadLink).toHaveAttribute("href", /\/artifacts\/artifact_media_image\/content/);
  await expect(mediaDownloadLink).toHaveAttribute("download", "001-seedream-image.png");

  const existingJob = jobRows.nth(2);
  await existingJob.click();
  await expect(existingJob).not.toContainText("Existing product mockup.");
  await expect(detailPanel).toContainText("Existing product mockup.");
  await existingJob.getByRole("button", { name: "Start generation" }).click();
  await expect(existingJob).toContainText("Completed");
  await expect(detailPanel.locator(".artifact-row")).toContainText("Seedream image result");
  await expect(detailPanel.locator(".artifact-main-link")).toHaveAttribute("href", /\/artifacts\/artifact_media_job_existing\/content/);
  expect(state.approvals.some((approval) => approval.mediaJobId === "media_job_existing" && approval.actionType === "media_cost")).toBe(false);

  await page.getByRole("button", { name: "Create generation task" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create generation task" });
  await expect(createDialog.getByText("Advanced parameters")).toBeVisible();
  await expect(createDialog.getByText("Size, count, seed, watermark")).toBeVisible();
  await expect(createDialog.getByText("Input JSON")).toHaveCount(0);
  await createDialog.getByLabel("Image size").selectOption("1024x1024");
  await createDialog.getByLabel("Result count").fill("2");
  await createDialog.getByRole("textbox", { name: "Seed" }).fill("42");
  await createDialog.getByLabel("Watermark").selectOption("false");
  await createDialog.getByRole("textbox", { name: "Prompt" }).fill("New campaign image.");
  await createDialog.getByRole("button", { name: "Create generation task" }).click();

  await expect(page.locator(".media-job-row").first()).toContainText("Ready to start");
  await expect(detailPanel).toContainText("New campaign image.");
  await expect.poll(() => state.mediaJobs.length).toBe(4);
  expect(state.mediaJobs[0]?.input).toEqual({
    size: "1024x1024",
    n: 2,
    seed: 42,
    watermark: false,
  });
});

test("generation tasks page routes empty model state to model configuration", async ({ page }) => {
  const state = createBaseState({});
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Generation" }).click();
  await expect(page.getByRole("heading", { name: "Generation tasks", level: 1 })).toBeVisible();
  const headerConfigureButton = page.locator("header").getByRole("button", { name: "Configure generation model" });
  await expect(headerConfigureButton).toBeVisible();
  await expect(page.locator(".media-model-alert").getByRole("button", { name: "Configure generation model" })).toHaveCount(0);
  await headerConfigureButton.click();

  await expect(page.getByRole("button", { name: "Add model" }).first()).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Create generation task" })).toHaveCount(0);
});

test("generation tasks page treats OpenAI Images presets as runnable generation models", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    {
      id: "provider_openai_image",
      kind: "openai-compatible",
      displayName: "OpenAI Image",
      providerId: "custom-openai-compatible",
      model: "gpt-image-2",
      api: "media-job",
      baseUrl: "https://api.openai.test/v1",
      apiKeyRef: "env:OPENAI_API_KEY",
      apiKeyConfigured: true,
      headers: {},
      input: ["text", "image"],
      compat: {},
      capabilities: ["image_generate"],
      enabled: true,
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Generation" }).click();
  await expect(page.getByRole("heading", { name: "Generation tasks", level: 1 })).toBeVisible();
  await expect(page.locator("header").getByRole("button", { name: "Configure generation model" })).toHaveCount(0);
  await page.getByRole("button", { name: "Create generation task" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create generation task" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.getByLabel("Generation model")).toContainText("gpt-image-2 · api.openai.test");
});

test("generation tasks page runs live generation without media cost approval", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    {
      id: "provider_seedream",
      kind: "seedream",
      displayName: "Seedream Image",
      providerId: "seedream",
      model: "seedream",
      api: "media-job",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKeyRef: "env:SEEDREAM_API_KEY",
      apiKeyConfigured: true,
      headers: {},
      input: ["text", "image"],
      compat: { mediaVendorTransport: { mode: "live" } },
      capabilities: ["image_generate"],
      enabled: true,
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
  ];
  state.mediaJobs = [
    {
      id: "media_job_live_pending",
      workspaceId: "workspace_default",
      providerPresetId: "provider_seedream",
      operation: "image_generate",
      prompt: "Live product mockup.",
      input: {},
      artifactIds: [],
      status: "queued",
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Generation" }).click();
  const detailPanel = page.locator(".media-job-detail-panel");
  const jobRow = page.locator(".media-job-row").first();
  await expect(detailPanel).toContainText("Live product mockup.");
  await jobRow.getByRole("button", { name: "Start generation" }).click();
  await expect(jobRow).toContainText("Completed");
  await expect(page.locator(".media-job-detail-panel .artifact-row")).toContainText("Seedream image result");
  expect(state.approvals.some((approval) => approval.mediaJobId === "media_job_live_pending" && approval.actionType === "media_cost")).toBe(false);
});

test("generation tasks page lets legacy waiting media jobs run directly", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    {
      id: "provider_seedream",
      kind: "seedream",
      displayName: "Seedream Image",
      providerId: "seedream",
      model: "seedream",
      api: "media-job",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKeyRef: "env:SEEDREAM_API_KEY",
      apiKeyConfigured: true,
      headers: {},
      input: ["text", "image"],
      compat: { mediaVendorTransport: { mode: "live" } },
      capabilities: ["image_generate"],
      enabled: true,
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
  ];
  state.mediaJobs = [
    {
      id: "media_job_legacy_waiting",
      workspaceId: "workspace_default",
      providerPresetId: "provider_seedream",
      operation: "image_generate",
      prompt: "Legacy waiting product mockup.",
      input: {},
      artifactIds: [],
      status: "waiting_for_approval",
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Generation" }).click();
  const jobRow = page.locator(".media-job-row").first();
  const detailPanel = page.locator(".media-job-detail-panel");
  await expect(detailPanel).toContainText("Legacy waiting product mockup.");
  await expect(detailPanel).toContainText("Ready to start");
  await expect(jobRow.getByRole("button", { name: "Handle approval" })).toHaveCount(0);
  await jobRow.getByRole("button", { name: "Start generation" }).click();
  await expect(jobRow).toContainText("Completed");
  expect(state.approvals.some((approval) => approval.mediaJobId === "media_job_legacy_waiting" && approval.actionType === "media_cost")).toBe(false);
});
