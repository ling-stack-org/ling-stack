import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, type MockState } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const evidence = resolve("../../output/playwright/gen-ui");
const interactiveAttachmentName = "run-summary-dashboard.html";

function interactiveAttachmentState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelMessages = [{
    id: "message_gen_ui_interactive",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "engineer",
    body: "Here is the interactive run dashboard.",
    mentions: [],
    attachmentIds: ["attachment_gen_ui_interactive"],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-10-26T08:00:00.000Z",
    updatedAt: "2026-10-26T08:00:00.000Z",
  }];
  state.channelAttachments = [{
    id: "attachment_gen_ui_interactive",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    messageId: "message_gen_ui_interactive",
    kind: "text",
    fileName: interactiveAttachmentName,
    contentType: "text/html; charset=utf-8",
    sizeBytes: 2048,
    path: `.ling-stack/attachments/${interactiveAttachmentName}`,
    materializationStatus: "available",
    previewStatus: "available",
    createdAt: "2026-10-26T08:00:00.000Z",
  }];
  return state;
}

async function routeInteractivePreview(page: Page): Promise<void> {
  await page.route(/\/attachments\/attachment_gen_ui_interactive\/preview(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      json: {
        ref: {
          id: "attachment_gen_ui_interactive",
          source: "attachment",
          scope: "channel",
          label: interactiveAttachmentName,
          displayPath: `.ling-stack/attachments/${interactiveAttachmentName}`,
          contentType: "text/html; charset=utf-8",
          sizeBytes: 2048,
          previewable: true,
        },
        kind: "html_interactive",
        htmlInteractive: {
          sandbox: ["allow-scripts"],
          html: [
            "<!doctype html><html><head><style>body{font-family:sans-serif;padding:16px}button{padding:8px 16px}</style></head>",
            "<body><h3>Run dashboard</h3><button id='counter'>Clicked 0</button>",
            "<script>let n=0;document.getElementById('counter').onclick=function(){n++;this.textContent='Clicked '+n;};</script>",
            "</body></html>",
          ].join(""),
        },
        truncated: false,
        sizeBytes: 2048,
        redactionNotes: ["Interactive preview runs in a sandboxed frame and is not included in AI context."],
      },
    });
  });
}

test("interactive HTML artifact renders in a sandboxed frame inside the file preview", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockDaemon(page, interactiveAttachmentState());
  await routeInteractivePreview(page);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  await feed.getByRole("button", { name: `Preview: ${interactiveAttachmentName}` }).click();

  const preview = page.getByLabel("File preview");
  const frame = preview.locator("iframe[data-ui2-artifact-interactive]");
  await expect(frame).toBeVisible();
  const sandbox = await frame.getAttribute("sandbox");
  expect(sandbox).toBe("allow-scripts");
  expect(sandbox?.includes("allow-same-origin")).toBe(false);

  // Interactivity: click inside the sandboxed document and observe its state.
  const frameLocator = page.frameLocator("iframe[data-ui2-artifact-interactive]");
  await frameLocator.locator("#counter").click();
  await expect(frameLocator.locator("#counter")).toHaveText("Clicked 1");
  await frameLocator.locator("#counter").click();
  await expect(frameLocator.locator("#counter")).toHaveText("Clicked 2");

  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/interactive-preview.png`, animations: "disabled" });
  expect(errors).toEqual([]);
});
