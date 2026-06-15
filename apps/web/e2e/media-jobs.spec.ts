import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
} from "./support/mock-state";

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
      prompt: "Live gated product mockup.",
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
  const failedJob = page.locator(".media-job-row").filter({ hasText: "Live gated product mockup." });
  await expect(failedJob).toContainText("failed");
  await expect(failedJob).toContainText("Seedream image generation failed with HTTP 429");
  const imageJob = page.locator(".media-job-row").filter({ hasText: "Generated Seedream image artifact." });
  const imageArtifactRow = imageJob.locator(".artifact-row").filter({ hasText: "Seedream image 1" });
  await expect(imageArtifactRow).toContainText("image");
  await expect(imageArtifactRow).toContainText("4.0 KB");
  await expect(imageArtifactRow.getByRole("link", { name: "Open" })).toHaveAttribute("href", /\/artifacts\/artifact_media_image\/content/);
  const mediaDownloadLink = imageArtifactRow.getByRole("link", { name: "Download" });
  await expect(mediaDownloadLink).toHaveAttribute("href", /\/artifacts\/artifact_media_image\/content/);
  await expect(mediaDownloadLink).toHaveAttribute("download", "001-seedream-image.png");

  const existingJob = page.locator(".media-job-row").filter({ hasText: "Existing product mockup." });
  await expect(existingJob).toContainText("Existing product mockup.");
  state.approvals.unshift({
    id: "approval_media_job_existing",
    mediaJobId: "media_job_existing",
    actionType: "media_cost",
    risk: "high",
    title: "Approve generation cost",
    description: "Seedream Image image_generate requires approval before live media execution.",
    payload: {
      type: "media_cost",
      providerPresetId: "provider_seedream",
      model: "seedream",
      operation: "image_generate",
      promptPreview: "Existing product mockup.",
    },
    status: "approved",
    createdAt: "2026-05-23T00:02:00.000Z",
    expiresAt: "2099-01-01T00:02:00.000Z",
  });
  await existingJob.getByRole("button", { name: "Run" }).click();
  await expect(existingJob).toContainText("succeeded");
  await expect(existingJob.locator(".artifact-row")).toContainText("Seedream image result");
  await expect(existingJob.locator(".artifact-main-link")).toHaveAttribute("href", /\/artifacts\/artifact_media_job_existing\/content/);

  await page.getByRole("textbox", { name: "Prompt" }).fill("New campaign image.");
  await page.getByRole("button", { name: "Create generation task" }).click();

  await expect(page.locator(".media-job-row").first()).toContainText("New campaign image.");
  await expect.poll(() => state.mediaJobs.length).toBe(4);
});

test("generation tasks page surfaces live generation cost approvals", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [
    {
      id: "provider_seedream",
      kind: "seedream",
      displayName: "Seedream Image",
      providerId: "seedream",
      model: "seedream",
      api: "media-job",
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
      prompt: "Approval gated product mockup.",
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
  const jobRow = page.locator(".media-job-row").filter({ hasText: "Approval gated product mockup." });
  await jobRow.getByRole("button", { name: "Run" }).click();
  await expect(jobRow).toContainText("waiting_for_approval");
  await expect(jobRow).toContainText("Approval required before live execution");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Review Queue" }).click();
  const mediaApproval = page.locator(".approval-list .approval-row").filter({ hasText: "Approve generation cost" });
  await expect(mediaApproval).toContainText("media_cost");
  await expect(mediaApproval).toContainText("generation task");
  await expect(mediaApproval.getByLabel("Media cost approval summary")).not.toContainText("provider_seedream");
  await expect(mediaApproval.getByLabel("Media cost approval summary")).toContainText("Approval gated product mockup.");

  await mediaApproval.getByLabel("Decision reason").fill("Approved for local smoke.");
  await mediaApproval.getByRole("button", { name: "Approve" }).click();
  await mediaApproval.getByRole("button", { name: "Confirm approve" }).click();
  await expect.poll(() => state.approvals.find((approval) => approval.id === "approval_media_job_live_pending")?.status).toBe("approved");
  await expect(mediaApproval).toHaveCount(0);

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Generation" }).click();
  await jobRow.getByRole("button", { name: "Run" }).click();
  await expect(jobRow).toContainText("succeeded");
  await expect(jobRow.locator(".artifact-row")).toContainText("Seedream image result");
});
