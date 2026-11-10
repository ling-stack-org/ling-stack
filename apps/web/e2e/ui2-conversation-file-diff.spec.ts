import { expect, test, type Locator, type Page } from "@playwright/test";
import { expandTimelineProcesses } from "./support/timeline-process";
import type { WorkspaceChangesResponse } from "@ling-stack/contracts";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expectMessageFrameContained } from "./support/message-frame-assertions";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  cwd,
  isRecord,
  type MockArtifact,
  type MockState,
} from "./support/mock-state";
import {
  createRunsThreadsFixture,
  installRunsThreadsFixture,
  openMainRunHistory,
} from "./support/runs-threads-fixture";
import { openEngineeringChannel } from "./support/test-helpers";

const containmentTolerance = 1;
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/shared-conversation-file-diff/",
  import.meta.url,
));

test("Channel structured and deferred diffs stay keyboard-operable and contained", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "pending" });
  state.channelMessages = [channelDiffMessage()];
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const message = feed.locator(".message-bubble").filter({ hasText: "Focused shared file diff" });
  await expect(message).toBeVisible();
  await expectMessageFrameContained(message);

  const structured = message.locator(".message-diff-block").filter({ hasText: "src/focused-example.ts" });
  await expect(structured).toBeVisible();
  await expect(structured.locator(".diff-line.add")).toHaveCount(2);
  await expect(structured.locator(".diff-line.delete")).toHaveCount(2);
  await expect(structured.locator(".diff-line.context")).toHaveCount(1);
  await expect(structured.locator(".diff-fold")).toContainText("18 unmodified lines");
  await expect(structured).toContainText("LongUnbrokenDiffPayload");

  const malformedFallback = message.locator(".message-code-block").filter({ hasText: "not actually a unified patch" });
  await expect(malformedFallback).toBeVisible();

  const deferred = feed.locator(".message-diff-block.deferred").filter({ hasText: "Large diff deferred" });
  await expect(deferred).toContainText("Large diff deferred");
  await expect(deferred.locator(".diff-viewer")).toHaveCount(0);
  const showDetails = deferred.getByRole("button", { name: "Show diff details" });
  await showDetails.focus();
  await showDetails.press("Enter");

  const expanded = message.locator(".message-diff-block.expanded-deferred");
  await expect(expanded.locator(".diff-viewer")).toBeVisible();
  const showRemaining = expanded.getByRole("button", { name: /Show remaining diff ranges/u });
  await expect(showRemaining).toHaveAttribute("aria-expanded", "false");
  await showRemaining.focus();
  await showRemaining.press("Space");
  await expect(expanded.getByRole("button", { name: "Collapse diff ranges" })).toHaveAttribute("aria-expanded", "true");

  const collapse = expanded.getByRole("button", { name: "Collapse diff details" });
  await collapse.focus();
  await collapse.press("Enter");
  await expect(message.locator(".message-diff-block.deferred")).toBeVisible();

  await expectHorizontalContainment(page, [message, structured, malformedFallback]);
  await captureEvidence(page, "1440x960-ling-light-channel-message-diff.png");
  expect(runtimeErrors).toEqual([]);
});

test("Durable file-change evidence opens a capability-scoped diff in the Host dock", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, reducedMotion: true });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const artifactId = installDurableWorkCellFixture(state);
  const capabilityRequests: unknown[] = [];
  const previewRequests: unknown[] = [];
  await mockDaemon(page, state);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/workspace-files/capabilities") {
      capabilityRequests.push(request.postDataJSON());
    }
    if (request.method() === "POST" && url.pathname === "/workspace-files/preview") {
      previewRequests.push(request.postDataJSON());
    }
  });

  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const timeline = feed.locator(
    '[data-conversation-timeline="true"][data-conversation-timeline-depth="0"]',
  ).first();
  await expect(timeline).toBeVisible();
  await expandTimelineProcesses(timeline);
  const editRow = timeline.locator('.conversation-timeline-activity[data-conversation-timeline-kind="fileChange"]')
    .filter({ hasText: "Edited FileDiffSurface.tsx" });
  await expect(editRow).toHaveAttribute("data-conversation-action-id", "execution_action_ui2_file_diff");
  await expect(editRow).toHaveAttribute("data-conversation-run-id", state.runs[0]!.id);
  const rowToggle = editRow.locator(".conversation-timeline-activity-main");
  await expect(rowToggle).toHaveAttribute("aria-expanded", "false");
  await rowToggle.focus();
  await rowToggle.press("Space");
  await expect(rowToggle).toHaveAttribute("aria-expanded", "true");

  const diffRef = editRow.locator("button.conversation-timeline-file-ref").filter({ hasText: "±" }).first();
  await expect(editRow.locator("button.conversation-timeline-file-ref").filter({ hasText: "±" })).toHaveCount(1);
  await expect(editRow.locator("button.conversation-timeline-file-ref").filter({ hasText: "▧" })).toHaveCount(1);
  await expect(diffRef).toHaveAccessibleName("Show diff details");
  await expect(diffRef).toHaveAttribute("title", "apps/web/src/features/workspace/FileDiffSurface.tsx");
  await diffRef.focus();
  await diffRef.press("Enter");

  await expect.poll(() => capabilityRequests.length).toBe(1);
  expect(capabilityRequests[0]).toMatchObject({
    cwd,
    capabilityTarget: "open_diff",
    refId: artifactId,
    scope: {
      workspaceId: "workspace_default",
      threadId: "thread_ui2_file_diff",
      runId: state.runs[0]!.id,
      actionId: "execution_action_ui2_file_diff",
      participantId: "ling",
    },
  });

  const dock = page.getByRole("complementary", { name: "Channel workspace dock" });
  const preview = dock.locator('[data-workspace-capability-target="open_diff"][data-workspace-viewer-kind="diff"]');
  await expect(preview).toBeVisible();
  await expect.poll(() => previewRequests.length).toBeGreaterThanOrEqual(1);
  for (const request of previewRequests) {
    expect(request).toMatchObject({
      cwd,
      scope: {
        workspaceId: "workspace_default",
        threadId: "thread_ui2_file_diff",
        runId: state.runs[0]!.id,
        actionId: "execution_action_ui2_file_diff",
        participantId: "ling",
      },
      maxBytes: 65536,
    });
  }
  expect(await preview.locator(".right-dock-code-line.add").count()).toBeGreaterThan(100);
  await expect(preview.locator(".right-dock-code-line.delete")).toHaveCount(3);
  await expect(preview.locator(".right-dock-code-truncated")).toContainText("Preview truncated");
  await expect(preview).toContainText("workCellLine 1");
  await expect(preview).toContainText("focusedStyleLine 1");
  await expect(preview).toContainText("hiddenLine 1");
  await expect(preview).not.toContainText("hiddenLine 220");

  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  const animatedTargets = await page.locator("body").evaluate((root) => [
    ...root.querySelectorAll<HTMLElement>('[data-workspace-viewer-kind="diff"], .right-dock-code-preview'),
  ].map((element) => ({
    animationDuration: getComputedStyle(element).animationDuration,
    animationName: getComputedStyle(element).animationName,
  })).filter((entry) => entry.animationName !== "none" && entry.animationDuration !== "0s"));
  expect(animatedTargets).toEqual([]);
  await expectHorizontalContainment(page, [feed, timeline, editRow, dock, preview]);
  await captureEvidence(page, "1280x800-ling-dark-capability-diff-dock.png");
  expect(runtimeErrors).toEqual([]);
});

test("Runs file-change evidence loads lazily and keeps preview failure to one stable attempt", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createRunsThreadsFixture();
  const successRun = state.runs.find((run) => run.id === "run_ui2_retry");
  const failureRun = state.runs.find((run) => run.id === "run_ui2_failed");
  expect(successRun).toBeDefined();
  expect(failureRun).toBeDefined();

  const successArtifact = diffArtifact({
    id: "artifact_ui2_file_diff_success",
    runId: successRun!.id,
    path: "changes/success.diff",
    title: "Focused success diff",
    diff: runsSuccessDiff(),
    createdAt: successRun!.updatedAt,
  });
  const failureArtifact = diffArtifact({
    id: "artifact_ui2_file_diff_failure",
    runId: failureRun!.id,
    path: "changes/failure.diff",
    title: "Focused failure diff",
    diff: "@@ -1 +1 @@\n-old\n+new",
    createdAt: failureRun!.updatedAt,
  });
  state.artifactsByRun[successRun!.id] = [successArtifact];
  state.artifactsByRun[failureRun!.id] = [failureArtifact];

  await installRunsThreadsFixture(page, state);
  let successPreviewRequests = 0;
  let failurePreviewRequests = 0;
  await page.route(new RegExp(`/artifacts/${successArtifact.id}/preview(?:\\?.*)?$`, "u"), async (route) => {
    successPreviewRequests += 1;
    await wait(180);
    await route.fallback();
  });
  await page.route(new RegExp(`/artifacts/${failureArtifact.id}/preview(?:\\?.*)?$`, "u"), async (route) => {
    failurePreviewRequests += 1;
    await route.fulfill({
      status: 503,
      json: { error: "focused_diff_preview_failed", message: "Focused diff preview failed." },
    });
  });

  await page.goto("/");
  await openMainRunHistory(page, "Retry completed with evidence");
  const successDetail = page.getByLabel("Run detail", { exact: true });
  const successEvidence = successDetail.locator(".file-change-evidence");
  const successSummary = successEvidence.locator(":scope > summary");
  await expect(successEvidence).toBeVisible();
  expect(successPreviewRequests).toBe(0);
  await successSummary.focus();
  await successSummary.press("Space");
  await expect(successEvidence.getByText("Loading preview...")).toBeVisible();
  await expect(successEvidence.locator(".diff-file-summary")).toHaveCount(2);
  await expect(successEvidence.locator(".diff-viewer")).toContainText("first focused run change");

  const secondFile = successEvidence.locator(".diff-file-summary").filter({ hasText: "second-focused-run.ts" });
  await secondFile.focus();
  await secondFile.press("Enter");
  await expect(secondFile).toHaveClass(/selected/u);
  await expect(successEvidence.locator(".diff-viewer")).toContainText("second focused run change");
  expect(successPreviewRequests).toBe(1);
  await expectHorizontalContainment(page, [successDetail, successEvidence]);

  await page.goto("/");
  await openMainRunHistory(page, "Failed provider repair run");
  const failureDetail = page.getByLabel("Run detail", { exact: true });
  const failureEvidence = failureDetail.locator(".file-change-evidence");
  const failureSummary = failureEvidence.locator(":scope > summary");
  await failureSummary.focus();
  await failureSummary.press("Space");
  await expect.poll(() => failurePreviewRequests).toBeGreaterThanOrEqual(1);
  await wait(300);

  // A failed preview must stay failed until the user explicitly retries or reopens it.
  expect(failurePreviewRequests).toBe(1);
  await expect(failureEvidence.getByRole("alert")).toContainText("Focused diff preview failed.");
  const failureArtifactRow = failureDetail.locator(".artifact-row").filter({ hasText: "Focused failure diff" });
  await expectNoOverlap(failureArtifactRow, [".artifact-type", ".artifact-main", ":scope > small", ".artifact-actions"]);
  await expectHorizontalContainment(page, [failureDetail, failureEvidence]);
  await captureEvidence(page, "1440x960-ling-light-runs-preview-failure.png");
  expect(runtimeErrors).toEqual([]);
});

test("Normal Details Review supports keyboard navigation and bounded long diffs", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, reducedMotion: true });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const conversationTitle = installNormalReviewFixture(state);
  await mockDaemon(page, state);
  await page.route(/\/workspace\/changes(?:\?.*)?$/u, async (route) => {
    await route.fulfill({ json: normalWorkspaceChangesFixture() });
  });

  await page.goto("/");
  await openConversation(page, conversationTitle);
  const conversation = page.getByLabel("Conversation page");
  const detailsTrigger = page.getByRole("toolbar", { name: "Conversation workspace toolbar" })
    .getByRole("button", { name: "Show details" });
  await detailsTrigger.focus();
  await detailsTrigger.press("Enter");

  const dock = page.getByRole("complementary", { name: "Conversation workspace dock" });
  await expect.poll(async () => (await dock.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(300);
  const reviewLauncher = dock.getByRole("button", { name: "Review", exact: true });
  await reviewLauncher.focus();
  await reviewLauncher.press("Enter");

  const review = dock.locator(".workspace-change-review-page");
  await expect(review.locator(".workspace-change-file-section")).toHaveCount(4);
  const navigatorTrigger = review.getByRole("button", { name: "Changed file navigator" });
  await navigatorTrigger.focus();
  await navigatorTrigger.press("Enter");
  const navigator = dock.getByRole("complementary", { name: "Changed file navigator" });
  await expect(navigator).toBeVisible();
  const filter = navigator.getByLabel("Filter files");
  await filter.fill("NormalConversationWorkspacePanels");

  const longPath = longWorkspaceReviewPath();
  const navigatorFile = navigator.getByRole("button", { name: /NormalConversationWorkspacePanelsWithAnIntentionallyLongName\.tsx/u });
  await navigatorFile.focus();
  await navigatorFile.press("Space");

  const selectedFile = review.locator(`.workspace-change-file-section[data-workspace-change-path="${longPath}"]`);
  await expect(selectedFile).toHaveClass(/selected/u);
  const fileToggle = selectedFile.getByRole("button", { name: /Collapse code preview/u });
  await fileToggle.focus();
  await fileToggle.press("Space");
  await expect(selectedFile).toHaveClass(/collapsed/u);
  const expandToggle = selectedFile.getByRole("button", { name: /Expand code preview/u });
  await expandToggle.focus();
  await expandToggle.press("Enter");
  await expect(selectedFile).not.toHaveClass(/collapsed/u);

  const showRemaining = selectedFile.getByRole("button", { name: /Show remaining diff ranges/u });
  await expect(showRemaining).toHaveAttribute("aria-expanded", "false");
  await showRemaining.focus();
  await showRemaining.press("Enter");
  await expect(selectedFile.getByRole("button", { name: "Collapse diff ranges" })).toHaveAttribute("aria-expanded", "true");

  const deletedFile = review.locator('.workspace-change-file-section[data-workspace-change-path="src/removed-file.ts"]');
  await expect(deletedFile.getByRole("button", { name: "Open with" })).toHaveCount(0);
  const truncatedFile = review.locator('.workspace-change-file-section[data-workspace-change-path="src/untracked-preview.txt"]');
  await expect(truncatedFile).toContainText("Preview truncated");

  const diffViewer = selectedFile.locator(".diff-viewer");
  const diffMetrics = await diffViewer.evaluate((element) => ({
    clientHeight: element.clientHeight,
    maxHeight: Number.parseFloat(getComputedStyle(element).maxHeight),
    scrollHeight: element.scrollHeight,
  }));
  expect(diffMetrics.maxHeight).toBeLessThanOrEqual(465);
  expect(diffMetrics.scrollHeight).toBeGreaterThan(diffMetrics.clientHeight);
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await expectHorizontalContainment(page, [conversation, dock, review, navigator, selectedFile, diffViewer]);
  await captureEvidence(page, "1280x800-ling-dark-normal-workspace-review.png");
  expect(runtimeErrors).toEqual([]);
});

function channelDiffMessage(): Record<string, unknown> {
  const largeDiff = fileDiff("src/deferred-large.ts", 190, "deferredDiffLine");
  return {
    id: "message_ui2_shared_file_diff",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "engineer",
    body: [
      "Focused shared file diff",
      "",
      "```diff",
      "diff --git a/src/focused-example.ts b/src/focused-example.ts",
      "--- a/src/focused-example.ts",
      "+++ b/src/focused-example.ts",
      "@@ -1 +1 @@",
      "-export const first = 1;",
      "+export const first = \"LongUnbrokenDiffPayloadWithoutAnyWhitespaceToVerifyContainment1234567890\";",
      "@@ -20,2 +20,2 @@",
      " export const stable = true;",
      "-export const second = 1;",
      "+export const second = 2;",
      "```",
      "",
      "```diff",
      "not actually a unified patch",
      "```",
      "",
      "```diff",
      largeDiff,
      "```",
    ].join("\n"),
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-23T09:00:00.000Z",
    updatedAt: "2026-07-23T09:00:00.000Z",
  };
}

function installDurableWorkCellFixture(state: MockState): string {
  const run = state.runs[0];
  const threadId = "thread_ui2_file_diff";
  const turnId = "turn_ui2_file_diff";
  const sourceMessageId = "message_ui2_file_diff";
  const artifactId = "artifact_ui2_work_cell_file_diff";
  const timestamp = "2026-07-23T09:10:00.000Z";
  if (!run) throw new Error("Base state must include one run");

  run.threadId = threadId;
  run.turnId = turnId;
  run.status = "succeeded";
  run.errorMessage = undefined;
  run.startedAt = timestamp;
  run.endedAt = timestamp;
  run.updatedAt = timestamp;
  state.tasks = state.tasks.map((task) => isRecord(task) && task.id === run.taskId
    ? { ...task, status: "done", updatedAt: timestamp }
    : task);
  state.approvals = [];
  state.artifactsByRun[run.id] = [diffArtifact({
    id: artifactId,
    runId: run.id,
    path: "apps/web/src/features/workspace/FileDiffSurface.tsx",
    title: "FileDiffSurface.tsx",
    diff: [
      fileDiff("apps/web/src/features/workspace/FileDiffSurface.tsx", 18, "workCellLine"),
      fileDiff("apps/web/src/styles/shared/file-diff-focused.css", 4, "focusedStyleLine"),
      fileDiff("apps/web/src/hidden/file-diff-not-rendered.ts", 220, "hiddenLine"),
    ].join("\n"),
    createdAt: timestamp,
  })];
  state.executionActions = [{
    id: "execution_action_ui2_file_diff",
    workspaceId: "workspace_default",
    threadId,
    runId: run.id,
    attemptId: `attempt_${run.id}`,
    participantId: "ling",
    toolCallId: "tool_ui2_file_diff",
    actionType: "edit",
    risk: "medium",
    status: "succeeded",
    title: "Render focused file diff",
    summary: "Rendered the durable inline file diff.",
    targetRefs: [{ type: "file", path: "apps/web/src/features/workspace/FileDiffSurface.tsx" }],
    sourceRefs: [{ kind: "conversation_item", id: sourceMessageId }],
    previewArtifactIds: [],
    resultArtifactIds: [artifactId],
    createdAt: timestamp,
    updatedAt: timestamp,
    executedAt: timestamp,
    completedAt: timestamp,
  }];
  state.turns = [{
    id: turnId,
    workspaceId: "workspace_default",
    threadId,
    kind: "initial_request",
    status: "succeeded",
    title: "Inspect shared file diff",
    userInstruction: "Render the durable shared file diff.",
    channelId: "channel_engineering",
    taskId: run.taskId,
    lastRunId: run.id,
    createdByActor: "local-user",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
  }];
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "channel_discussion",
    channelId: "channel_engineering",
    title: "Inspect shared file diff",
    objective: "Render the durable shared file diff.",
    status: "succeeded",
    lastRunId: run.id,
    surfaceKind: "channel_root",
    relationKind: "root",
    conversationMode: { mode: "default" },
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
  state.channelMessages = [{
    id: sourceMessageId,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    threadId,
    kind: "message",
    intent: "task",
    authorType: "local-user",
    authorId: "local-user",
    body: "Render the durable shared file diff.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    linkedRunId: run.id,
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
  state.turnRunLinks = [{ turnId, runId: run.id, attemptNumber: 1, role: "primary", createdAt: timestamp }];
  return artifactId;
}

function installNormalReviewFixture(state: MockState): string {
  const title = "UI2 focused file review";
  const threadId = "thread_ui2_focused_file_review";
  const turnId = "turn_ui2_focused_file_review";
  const runId = "run_ui2_focused_file_review";
  const timestamp = "2026-07-23T09:20:00.000Z";
  state.providers = [createChatProvider({ id: "provider_ui2_file_review", displayName: "Local Relay", model: "gpt-5.5" })];
  state.threads = [{
    id: threadId,
    workspaceId: "workspace_default",
    kind: "conversation",
    title,
    objective: "Verify the normal conversation workspace review.",
    status: "succeeded",
    lastRunId: runId,
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
  state.turns = [{
    id: turnId,
    workspaceId: "workspace_default",
    threadId,
    kind: "initial_request",
    status: "succeeded",
    title,
    userInstruction: "Open the focused workspace review.",
    lastRunId: runId,
    createdByActor: "local-user",
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
  }];
  state.turnRunLinks = [{ turnId, runId, attemptNumber: 1, role: "primary", createdAt: timestamp }];
  state.runs.unshift({
    id: runId,
    status: "succeeded",
    cwd,
    taskId: `task_${runId}`,
    providerPresetId: "provider_ui2_file_review",
    providerName: "local-relay",
    providerModel: "gpt-5.5",
    taskSnapshot: { id: `task_${runId}`, title: "Focused file review" },
    providerSnapshot: {},
    requestSnapshot: { cwd },
    eventLogPath: `.ling-stack/sessions/${runId}.jsonl`,
    threadId,
    turnId,
    createdAt: timestamp,
    startedAt: timestamp,
    updatedAt: timestamp,
    endedAt: timestamp,
  });
  state.eventsByRun[runId] = [{
    id: `event_${runId}`,
    runId,
    seq: 1,
    ts: timestamp,
    type: "assistant_text_delta",
    data: { text: "Workspace review is ready." },
  }];
  return title;
}

function normalWorkspaceChangesFixture(): WorkspaceChangesResponse {
  const path = longWorkspaceReviewPath();
  return {
    cwd,
    state: "dirty",
    repoRoot: cwd,
    branchName: "codex/ui2-focused-file-review",
    additions: 236,
    deletions: 4,
    files: [
      {
        path,
        kind: "modified",
        staged: false,
        unstaged: true,
        untracked: false,
        additions: 230,
        deletions: 1,
        diff: fileDiff(path, 230, "workspaceReviewLine"),
        truncated: false,
      },
      {
        path: "apps/web/src/styles/shared/conversation-file-diff.css",
        kind: "added",
        staged: true,
        unstaged: false,
        untracked: false,
        additions: 4,
        deletions: 0,
        diff: fileDiff("apps/web/src/styles/shared/conversation-file-diff.css", 4, "focusedCssLine"),
        truncated: false,
      },
      {
        path: "src/removed-file.ts",
        kind: "deleted",
        staged: true,
        unstaged: false,
        untracked: false,
        additions: 0,
        deletions: 3,
        diff: "diff --git a/src/removed-file.ts b/src/removed-file.ts\n--- a/src/removed-file.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-export const removed = true;\n-export const second = true;\n-export const third = true;",
        truncated: false,
      },
      {
        path: "src/untracked-preview.txt",
        kind: "added",
        staged: false,
        unstaged: true,
        untracked: true,
        additions: 2,
        deletions: 0,
        truncated: true,
      },
    ],
    totalFileCount: 4,
    truncated: false,
    checkedAt: "2026-07-23T09:21:00.000Z",
  };
}

function runsSuccessDiff(): string {
  return [
    fileDiff("src/first-focused-run.ts", 3, "first focused run change"),
    fileDiff("src/second-focused-run.ts", 3, "second focused run change"),
  ].join("\n");
}

function fileDiff(path: string, additionCount: number, linePrefix: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${additionCount} @@`,
    `-export const previousValue = \"${linePrefix} old\";`,
    ...Array.from({ length: additionCount }, (_, index) => `+export const ${safeIdentifier(linePrefix)}${index + 1} = \"${linePrefix} ${index + 1} ${"LongUnbrokenPayload".repeat(index === 0 ? 8 : 1)}\";`),
  ].join("\n");
}

function safeIdentifier(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_$]/gu, "_");
  return /^[a-zA-Z_$]/u.test(normalized) ? normalized : `line_${normalized}`;
}

function diffArtifact(input: {
  readonly id: string;
  readonly runId: string;
  readonly path: string;
  readonly title: string;
  readonly diff: string;
  readonly createdAt: string;
}): MockArtifact {
  return {
    id: input.id,
    runId: input.runId,
    type: "diff",
    path: input.path,
    title: input.title,
    contentType: "text/x-diff; charset=utf-8",
    contentText: input.diff,
    sizeBytes: input.diff.length,
    createdAt: input.createdAt,
  };
}

function longWorkspaceReviewPath(): string {
  return "apps/web/src/features/workspace/deeply/nested/review/NormalConversationWorkspacePanelsWithAnIntentionallyLongName.tsx";
}

async function openConversation(page: Page, title: string): Promise<void> {
  await page.getByRole("complementary", { name: "Sidebar display" })
    .getByRole("button", { name: /Open recent conversation/u })
    .filter({ hasText: title })
    .click();
  await expect(page.getByLabel("Conversation page")).toBeVisible();
}

async function prepareSurface(page: Page, fixture: {
  readonly theme: "light" | "dark";
  readonly width: number;
  readonly height: number;
  readonly reducedMotion?: boolean;
}): Promise<void> {
  await page.setViewportSize({ width: fixture.width, height: fixture.height });
  await page.emulateMedia({ reducedMotion: fixture.reducedMotion ? "reduce" : "no-preference" });
  await page.addInitScript(({ theme }) => {
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { theme: fixture.theme });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectHorizontalContainment(page: Page, elements: readonly Locator[]): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(containmentTolerance);
  for (const element of elements) {
    await expect.poll(() => element.evaluate((node) => node.scrollWidth - node.clientWidth))
      .toBeLessThanOrEqual(containmentTolerance);
  }
}

async function expectNoOverlap(owner: Locator, selectors: readonly string[]): Promise<void> {
  await expect.poll(() => owner.evaluate((element, { targetSelectors, tolerance }) => {
    const boxes = targetSelectors.flatMap((selector) => Array.from(element.querySelectorAll<HTMLElement>(selector)))
      .filter((child) => {
        const styles = getComputedStyle(child);
        return styles.display !== "none" && styles.visibility !== "hidden";
      })
      .map((child) => ({ className: child.className, rect: child.getBoundingClientRect() }));
    const collisions: string[] = [];
    for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
        const left = boxes[leftIndex]!;
        const right = boxes[rightIndex]!;
        const overlapWidth = Math.min(left.rect.right, right.rect.right) - Math.max(left.rect.left, right.rect.left);
        const overlapHeight = Math.min(left.rect.bottom, right.rect.bottom) - Math.max(left.rect.top, right.rect.top);
        if (overlapWidth > tolerance && overlapHeight > tolerance) {
          collisions.push(`${left.className} <> ${right.className}`);
        }
      }
    }
    return collisions;
  }, { targetSelectors: selectors, tolerance: containmentTolerance })).toEqual([]);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
