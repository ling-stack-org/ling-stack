import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const evidence = resolve("../../output/playwright/spreadsheet-viewer");
const workbookName = "quarterly-metrics.xlsx";

function spreadsheetState(): ReturnType<typeof createBaseState> {
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.channelMessages = [{
    id: "message_spreadsheet_preview",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "tian",
    body: "Quarterly metrics attached.",
    mentions: [],
    attachmentIds: ["attachment_spreadsheet_preview"],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-10-27T08:00:00.000Z",
    updatedAt: "2026-10-27T08:00:00.000Z",
  }];
  state.channelAttachments = [{
    id: "attachment_spreadsheet_preview",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    messageId: "message_spreadsheet_preview",
    kind: "text",
    fileName: workbookName,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: 8192,
    path: `.ling-stack/attachments/${workbookName}`,
    materializationStatus: "available",
    previewStatus: "available",
    createdAt: "2026-10-27T08:00:00.000Z",
  }];
  return state;
}

async function routeSpreadsheetPreview(page: Page): Promise<void> {
  await page.route(/\/attachments\/attachment_spreadsheet_preview\/preview(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      json: {
        ref: {
          id: "attachment_spreadsheet_preview",
          source: "workspace_file",
          scope: "workspace",
          label: workbookName,
          displayPath: `reports/${workbookName}`,
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          sizeBytes: 8192,
          previewable: true,
        },
        kind: "spreadsheet",
        spreadsheet: {
          schemaVersion: 1,
          sheets: [
            { index: 0, name: "Q3", rowCount: 0, colCount: 0 },
            { index: 1, name: "Q4", rowCount: 0, colCount: 0 },
          ],
        },
        truncated: false,
        sizeBytes: 8192,
        redactionNotes: ["Preview is read-only and not included in AI context."],
      },
    });
  });
  await page.route(/\/previews\/spreadsheet\?.*$/u, async (route) => {
    const url = new URL(route.request().url());
    const sheet = Number.parseInt(url.searchParams.get("sheet") ?? "0", 10);
    const rowStart = Number.parseInt(url.searchParams.get("rowStart") ?? "0", 10);
    const rows = sheet === 0
      ? [["region", "revenue", "growth"], ["north", 1200, "0.18"], ["south", 980, "=B3*2"]]
      : [["region", "revenue"], ["north", 1500]];
    await route.fulfill({
      json: {
        schemaVersion: 1,
        sheetIndex: sheet,
        sheetName: sheet === 0 ? "Q3" : "Q4",
        rowStart,
        rowEnd: rowStart + rows.length,
        colStart: 0,
        colEnd: rows[0].length,
        rowCount: 3 + rowStart,
        colCount: rows[0].length,
        cells: rows.map((row) => row.map((value) => ({ v: value, f: String(value).startsWith("=") ? String(value).slice(1) : undefined }))),
      },
    });
  });
}

test("spreadsheet viewer opens workbooks with sheet tabs, selection and formula bar", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockDaemon(page, spreadsheetState());
  await routeSpreadsheetPreview(page);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  await feed.getByRole("button", { name: `Preview: ${workbookName}` }).click();

  const preview = page.getByLabel("File preview");
  const grid = preview.locator("[data-ui2-spreadsheet-grid]");
  await expect(grid).toBeVisible();

  // Q3 sheet content
  await expect(grid.locator(".spreadsheet-grid-cell").filter({ hasText: "north" })).toBeVisible();
  await expect(grid.locator(".spreadsheet-grid-cell").filter({ hasText: "1200" })).toBeVisible();

  // Cell selection shows the coordinate in the formula bar
  await grid.locator(".spreadsheet-grid-cell").filter({ hasText: "0.18" }).click();
  await expect(grid.locator(".spreadsheet-grid-formula code")).toHaveText(/^[A-Z]+\d+$/u);
  await expect(grid.locator(".spreadsheet-grid-formula span")).toContainText("0.18");

  // Formula cells display their formula in the formula bar
  await grid.locator(".spreadsheet-grid-cell").filter({ hasText: "=B3*2" }).click();
  await expect(grid.locator(".spreadsheet-grid-formula span")).toContainText("B3*2");

  await page.screenshot({ path: `${evidence}/spreadsheet-q3.png`, animations: "disabled" });

  // Switch to the second sheet
  const secondSheetRoute = page.waitForRequest((request) => request.url().includes("sheet=1"));
  await preview.locator(".spreadsheet-grid-toolbar, .artifact-preview-panel").getByText("Q4", { exact: true }).first().click();
  await secondSheetRoute;
  await expect(grid.locator(".spreadsheet-grid-cell").filter({ hasText: "1500" })).toBeVisible();
  await page.screenshot({ path: `${evidence}/spreadsheet-q4.png`, animations: "disabled" });

  const unexpected = errors.filter((error) => !error.includes("lacks the 'allow-same-origin' flag"));
  expect(unexpected).toEqual([]);
});
