import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, type MockState } from "./support/mock-state";
import { captureP6FeedbackEvidence } from "./support/p6-feedback-evidence";
import { openEngineeringChannel } from "./support/test-helpers";

test("artifact preview sends copy and download success to one deduped global Toast", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  await mockDaemon(page, artifactPreviewFeedbackState());
  await routeArtifactPreviewFeedback(page);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const trigger = feed.getByRole("button", { name: `Preview: ${successAttachmentName}` });
  await trigger.click();

  const preview = page.getByLabel("File preview");
  const panel = preview.locator(".artifact-preview-panel");
  await expect(preview.locator(".artifact-preview-text-panel")).toBeVisible();
  await expect(preview.getByRole("button", { name: "Close preview" })).toBeFocused();

  const copy = preview.getByRole("button", { name: "Copy preview" });
  await copy.click();
  await copy.click();
  const copyToast = globalToast(page, `${successScope}:copy`);
  await expect(copyToast).toHaveCount(1);
  await expect(copyToast).toContainText("Copied");
  await expect.poll(() => copiedPreviewText(page)).toContain(successPreviewText);
  await expect(preview.locator(".artifact-preview-action-feedback")).toHaveCount(0);
  await expect(preview.locator('[data-artifact-preview-feedback="action"]')).toHaveCount(0);
  await captureP6FeedbackEvidence(
    page,
    "conversations/artifact-preview-feedback",
    "1440x960-ling-light-copy-success-toast.png",
  );

  const download = preview.getByRole("link", { name: "Download file" });
  const downloadEvent = page.waitForEvent("download");
  await download.click();
  const downloaded = await downloadEvent;
  expect(downloaded.suggestedFilename()).toBe(successAttachmentName);
  const downloadToast = globalToast(page, `${successScope}:download`);
  await expect(downloadToast).toHaveCount(1);
  await expect(downloadToast).toContainText("Download started");
  await expect(preview.locator('[data-artifact-preview-feedback="action"]')).toHaveCount(0);

  await expectContainedGeometry(page, preview, panel, preview.locator(".artifact-preview-body"));
  await expectNoDocumentOverflow(page);
  await preview.getByRole("button", { name: "Close preview" }).click();
  await expect(preview).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(copyToast).toBeHidden({ timeout: 5_000 });
  await expect(downloadToast).toBeHidden({ timeout: 5_000 });
  expect(runtimeErrors).toEqual([]);
});

test("artifact preview keeps load, preview, copy, and download failures inline until retry or close", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  await mockDaemon(page, artifactPreviewFeedbackState());
  await routeArtifactPreviewFeedback(page);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  const successTrigger = feed.getByRole("button", { name: `Preview: ${successAttachmentName}` });
  await successTrigger.click();

  const preview = page.getByLabel("File preview");
  const panel = preview.locator(".artifact-preview-panel");
  await expect(preview.locator(".artifact-preview-text-panel")).toBeVisible();
  await expect(panel).toHaveCSS("animation-name", "none");

  await setCopyFailure(page, true);
  await preview.getByRole("button", { name: "Copy preview" }).click();
  const actionFailure = preview.locator('[data-artifact-preview-feedback="action"]');
  await expect(actionFailure).toContainText("Copy failed");
  await page.waitForTimeout(1_100);
  await expect(actionFailure).toContainText("Copy failed");
  await expect(globalToast(page, `${successScope}:copy`)).toHaveCount(0);
  await captureP6FeedbackEvidence(
    page,
    "conversations/artifact-preview-feedback",
    "1280x800-ling-dark-copy-failure-inline.png",
  );

  await setCopyFailure(page, false);
  await preview.getByRole("button", { name: "Copy preview" }).click();
  await expect(actionFailure).toHaveCount(0);
  await expect(globalToast(page, `${successScope}:copy`)).toContainText("Copied");

  await setDownloadFailure(page, true);
  await preview.getByRole("link", { name: "Download file" }).click();
  await expect(actionFailure).toContainText("Download file: Failed");
  await page.waitForTimeout(1_100);
  await expect(actionFailure).toContainText("Download file: Failed");
  await expect(globalToast(page, `${successScope}:download`)).toHaveCount(0);

  await setDownloadFailure(page, false);
  const downloadEvent = page.waitForEvent("download");
  await preview.getByRole("link", { name: "Download file" }).click();
  await downloadEvent;
  await expect(actionFailure).toHaveCount(0);
  await expect(globalToast(page, `${successScope}:download`)).toContainText("Download started");
  await expectContainedGeometry(page, preview, panel, preview.locator(".artifact-preview-body"));
  await preview.getByRole("button", { name: "Close preview" }).click();
  await expect(successTrigger).toBeFocused();

  const unavailableTrigger = feed.getByRole("button", { name: `Preview: ${unavailableAttachmentName}` });
  await unavailableTrigger.click();
  const unavailablePreview = page.getByLabel("File preview");
  const previewFailure = unavailablePreview.locator('[data-artifact-preview-feedback="preview"]');
  await expect(previewFailure).toContainText("Preview unavailable");
  await page.waitForTimeout(1_100);
  await expect(previewFailure).toBeVisible();
  await unavailablePreview.getByRole("button", { name: "Close preview" }).click();
  await expect(unavailableTrigger).toBeFocused();

  const loadFailureTrigger = feed.getByRole("button", { name: `Preview: ${loadFailureAttachmentName}` });
  await loadFailureTrigger.click();
  const failedPreview = page.getByLabel("File preview");
  const loadFailure = failedPreview.locator('[data-artifact-preview-feedback="load"]');
  await expect(loadFailure).toContainText("Preview unavailable");
  await page.waitForTimeout(1_100);
  await expect(loadFailure).toBeVisible();
  await expectNoDocumentOverflow(page);
  await failedPreview.getByRole("button", { name: "Close preview" }).click();
  await expect(loadFailureTrigger).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

const successAttachmentId = "attachment_ui2_feedback_success";
const unavailableAttachmentId = "attachment_ui2_feedback_unavailable";
const loadFailureAttachmentId = "attachment_ui2_feedback_load_failure";
const successAttachmentName = "artifact-feedback-success.txt";
const unavailableAttachmentName = "artifact-feedback-unavailable.bin";
const loadFailureAttachmentName = "artifact-feedback-load-failure.txt";
const successPreviewText = "Artifact preview feedback uses the global Ling Toast.";
const successScope = `artifact-preview:attachment:${successAttachmentId}`;

function artifactPreviewFeedbackState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelMessages = [{
    id: "message_ui2_artifact_feedback",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "tian",
    body: "Inspect Artifact Preview feedback ownership.",
    mentions: [],
    attachmentIds: [successAttachmentId, unavailableAttachmentId, loadFailureAttachmentId],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-26T08:00:00.000Z",
    updatedAt: "2026-07-26T08:00:00.000Z",
  }];
  state.channelAttachments = [
    channelAttachment(successAttachmentId, successAttachmentName, "text"),
    channelAttachment(unavailableAttachmentId, unavailableAttachmentName, "file"),
    channelAttachment(loadFailureAttachmentId, loadFailureAttachmentName, "text"),
  ];
  return state;
}

function channelAttachment(id: string, fileName: string, kind: "file" | "text"): Record<string, unknown> {
  return {
    id,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    messageId: "message_ui2_artifact_feedback",
    kind,
    fileName,
    contentType: kind === "text" ? "text/plain; charset=utf-8" : "application/octet-stream",
    sizeBytes: 256,
    path: `.ling-stack/attachments/${fileName}`,
    materializationStatus: "available",
    previewStatus: "available",
    createdAt: "2026-07-26T08:00:00.000Z",
  };
}

async function routeArtifactPreviewFeedback(page: Page): Promise<void> {
  await page.route(/\/attachments\/(attachment_ui2_feedback_[^/]+)\/preview(?:\?.*)?$/u, async (route) => {
    const attachmentId = new URL(route.request().url()).pathname.split("/").at(-2);
    if (attachmentId === loadFailureAttachmentId) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{" });
      return;
    }
    if (attachmentId === unavailableAttachmentId) {
      await route.fulfill({
        json: previewResponse(attachmentId, unavailableAttachmentName, {
          kind: "unsupported",
        }),
      });
      return;
    }
    await route.fulfill({
      json: previewResponse(successAttachmentId, successAttachmentName, {
        kind: "plain_text",
        text: successPreviewText,
      }),
    });
  });
  await page.route(new RegExp(`/attachments/${successAttachmentId}/content(?:\\?.*)?$`, "u"), async (route) => {
    await route.fulfill({ status: 200, contentType: "text/plain", body: successPreviewText });
  });
}

function previewResponse(
  id: string,
  label: string,
  content: { readonly kind: "plain_text"; readonly text: string } | { readonly kind: "unsupported" },
): Record<string, unknown> {
  return {
    ref: {
      id,
      source: "attachment",
      scope: "channel",
      label,
      displayPath: `.ling-stack/attachments/${label}`,
      contentType: content.kind === "plain_text" ? "text/plain; charset=utf-8" : "application/octet-stream",
      sizeBytes: 256,
      previewable: true,
    },
    ...content,
    truncated: false,
    sizeBytes: 256,
    redactionNotes: [],
  };
}

async function prepareSurface(page: Page, theme: "light" | "dark", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript(({ themeId }) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);

    const originalCreateObjectUrl = URL.createObjectURL.bind(URL);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          const state = window as typeof window & {
            __artifactPreviewCopiedText?: string;
            __artifactPreviewCopyShouldFail?: boolean;
          };
          if (state.__artifactPreviewCopyShouldFail) throw new Error("copy_failed");
          state.__artifactPreviewCopiedText = text;
        },
      },
    });
    URL.createObjectURL = (blob: Blob) => {
      const state = window as typeof window & { __artifactPreviewDownloadShouldFail?: boolean };
      if (state.__artifactPreviewDownloadShouldFail) throw new Error("download_failed");
      return originalCreateObjectUrl(blob);
    };
  }, { themeId: theme });
}

function globalToast(page: Page, scope: string): Locator {
  return page.locator(`[data-ling-overlay="toast"][data-scope="${scope}"]`);
}

async function copiedPreviewText(page: Page): Promise<string> {
  return page.evaluate(() => (window as typeof window & { __artifactPreviewCopiedText?: string }).__artifactPreviewCopiedText ?? "");
}

async function setCopyFailure(page: Page, shouldFail: boolean): Promise<void> {
  await page.evaluate((value) => {
    (window as typeof window & { __artifactPreviewCopyShouldFail?: boolean }).__artifactPreviewCopyShouldFail = value;
  }, shouldFail);
}

async function setDownloadFailure(page: Page, shouldFail: boolean): Promise<void> {
  await page.evaluate((value) => {
    (window as typeof window & { __artifactPreviewDownloadShouldFail?: boolean }).__artifactPreviewDownloadShouldFail = value;
  }, shouldFail);
}

async function expectContainedGeometry(page: Page, owner: Locator, ...children: Locator[]): Promise<void> {
  const ownerBox = await owner.boundingBox();
  expect(ownerBox).not.toBeNull();
  for (const child of children) {
    const childBox = await child.boundingBox();
    expect(childBox).not.toBeNull();
    expect(childBox!.x).toBeGreaterThanOrEqual(ownerBox!.x - 1);
    expect(childBox!.y).toBeGreaterThanOrEqual(ownerBox!.y - 1);
    expect(childBox!.x + childBox!.width).toBeLessThanOrEqual(ownerBox!.x + ownerBox!.width + 1);
    expect(childBox!.y + childBox!.height).toBeLessThanOrEqual(ownerBox!.y + ownerBox!.height + 1);
    expect(await child.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  return errors;
}
