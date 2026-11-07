import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, isRecord } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

test("channel image activity loads its trusted artifact and opens the compare preview", async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const run = state.runs[0];
  run.threadId = "thread_inspect";
  run.status = "succeeded";
  run.errorMessage = undefined;
  run.updatedAt = "2026-05-25T00:22:00.000Z";
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === "task_inspect"
    ? { ...task, status: "done", updatedAt: run.updatedAt } : task);
  state.approvals = [];
  state.artifactsByRun[run.id] = [{
    id: "artifact_thread_screenshot", runId: run.id, type: "image",
    path: "screenshots/channel-transcript.jpg", title: "channel-transcript.jpg",
    contentType: "image/jpeg", sizeBytes: 4096,
    compareBeforeImageUrl: "/e2e/fixtures/fronalpstock-3840.jpg",
    compareAfterImageUrl: "/themes/ling-ocean/salt-coast-v1-thumb.webp",
    compareBeforeLabel: "Previous screenshot", compareAfterLabel: "Current screenshot",
    createdAt: "2026-05-25T00:21:05.000Z",
  }];
  state.executionActions = [{
    id: "execution_action_thread_image", revision: 1,
    workspaceId: "workspace_default", threadId: "thread_inspect", runId: run.id,
    attemptId: `attempt:${run.id}`, participantId: "ling", actionType: "image_view",
    risk: "low", status: "succeeded", title: "View channel-transcript.jpg",
    summary: "Opened the generated channel transcript image.", targetRefs: [],
    previewArtifactIds: [], resultArtifactIds: ["artifact_thread_screenshot"],
    sourceRefs: [
      { kind: "conversation_item", id: "conversation-assistant:turn_thread_inspect" },
      { kind: "run_event", id: "run_event_thread_image_completed" },
    ],
    createdAt: "2026-05-25T00:21:31.000Z", updatedAt: "2026-05-25T00:21:34.000Z",
    executedAt: "2026-05-25T00:21:31.000Z", completedAt: "2026-05-25T00:21:34.000Z",
  }];
  state.turns = [{
    id: "turn_thread_inspect", workspaceId: "workspace_default", threadId: "thread_inspect",
    kind: "initial_request", status: "succeeded", title: "Inspect workspace",
    userInstruction: "Inspect the workspace and summarize the result.",
    channelId: "channel_engineering", taskId: "task_inspect", lastRunId: run.id,
    createdByActor: "local-user", createdAt: "2026-05-25T00:20:00.000Z",
    updatedAt: run.updatedAt, completedAt: run.updatedAt,
  }];
  state.turnRunLinks = [{
    turnId: "turn_thread_inspect", runId: run.id, attemptNumber: 1,
    role: "primary", createdAt: "2026-05-25T00:20:00.000Z",
  }];
  state.channelMessages.push({
    id: `source_${run.id}`, body: "Inspect the repo and report next steps.", linkedRunId: run.id,
    workspaceId: "workspace_default", channelId: "channel_engineering",
    threadId: "thread_channel_channel_engineering", kind: "message", intent: "discuss",
    authorType: "local-user", authorId: "local-user", mentions: [], attachmentIds: [], linkPreviewIds: [],
    status: "ready", createdAt: "2026-05-22T00:00:00.000Z", updatedAt: "2026-05-22T00:00:00.000Z",
  });
  const imagePreviewRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/artifacts/artifact_thread_screenshot/preview")) {
      imagePreviewRequests.push(request.url());
    }
  });
  await mockDaemon(page, state);
  await page.route(/\/artifacts\/artifact_thread_screenshot\/content\?/u, (route) => route.fulfill({
    contentType: "image/jpeg", path: fileURLToPath(new URL("./fixtures/fronalpstock-3840.jpg", import.meta.url)),
  }));
  await page.goto("/");
  await openEngineeringChannel(page);
  const timeline = page.locator('.message-feed [data-conversation-timeline-scope="channel_root"]');
  await timeline.locator("[data-conversation-process-header]").click();
  const image = timeline.locator('[data-conversation-timeline-kind="imageView"]');
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("data-conversation-action-id", "execution_action_thread_image");
  await expect(image).toHaveAttribute("data-conversation-run-id", run.id);
  await expect(image).toHaveAttribute("data-conversation-attempt-id", `attempt:${run.id}`);
  await expect(image).toHaveAttribute("data-conversation-participant-id", "ling");
  for (const ref of ["artifact:artifact_thread_screenshot", "conversation_item:conversation-assistant:turn_thread_inspect", "run_event:run_event_thread_image_completed"]) {
    expect(await image.getAttribute("data-conversation-source-refs")).toContain(ref);
  }
  const thumbnail = image.locator(".conversation-timeline-image-preview img");
  await expect(thumbnail).toBeVisible();
  await expect(thumbnail).toHaveAttribute("src", /artifacts%2Fartifact_thread_screenshot|artifacts\/artifact_thread_screenshot/u);
  await expect.poll(() => thumbnail.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  expect(imagePreviewRequests.length).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath("channel-image-thumbnail.png") });
  const requestsBeforeLightbox = imagePreviewRequests.length;
  await thumbnail.click();
  const lightbox = page.locator(".artifact-preview-lightbox");
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator(".image-compare-viewer")).toBeVisible();
  await expect(lightbox.locator(".image-compare-toolbar")).toContainText("Side by side");
  await expect.poll(() => imagePreviewRequests.length).toBeGreaterThan(requestsBeforeLightbox);
  await lightbox.getByRole("button", { name: "Close preview" }).click();
  await expect(lightbox).toHaveCount(0);
  await expect(timeline.locator('[data-conversation-timeline-kind="diagnostic"]')).toHaveCount(0);
});
