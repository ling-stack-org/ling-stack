import type {} from "./support/review-harness";
import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { attachCommittedChannelReportItem, completedTerminalReport, installChannelWorkCellFixture, installNormalWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { openEngineeringChannel } from "./support/test-helpers";
async function mount(page: Page) {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.route(/\/providers(?:\?.*)?$/u, route => route.fulfill({ json: { providers: [] } }));
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => { const path = "/e2e/support/review-harness.tsx"; window.reviewHarness = (await import(/* @vite-ignore */ path)).mountReviewFixture(); });
  await expect(page.getByRole("heading", { name: "Review workspace" })).toBeVisible();
}
async function addCodeComment(page: Page, text: string) {
  await page.getByRole("button", { name: "Comment on line 2", exact: true }).last().click();
  await page.getByRole("button", { name: "Comment on line 3", exact: true }).click({ modifiers: ["Shift"] });
  await page.locator(".code-review-comment-editor").getByRole("textbox").fill(text);
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
}
test("code ranges survive reload and conversation switches, and clear only on accepted send", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await mount(page); await addCodeComment(page, "Handle missing configuration");
  const shelf = page.getByRole("region", { name: "Review feedback" });
  await expect(shelf).toContainText("src/main.ts:2-3");
  await page.getByRole("button", { name: "Switch conversation" }).click(); await expect(shelf).toHaveCount(0);
  await page.getByRole("button", { name: "Switch conversation" }).click(); await expect(shelf).toBeVisible();
  await page.reload(); await page.evaluate(async () => { const path = "/e2e/support/review-harness.tsx"; window.reviewHarness = (await import(/* @vite-ignore */ path)).mountReviewFixture(); });
  await expect(shelf.getByRole("textbox")).toHaveValue("Handle missing configuration");
  await page.getByRole("button", { name: "Fail next send" }).click(); await shelf.getByRole("button", { name: "Send feedback" }).click();
  await expect(page.getByRole("status")).toContainText("Send failed"); await expect(shelf).toBeVisible();
  await page.screenshot({ path: info.outputPath("review-range-recovery.png") });
  await page.getByRole("button", { name: "Fail next send" }).click(); await shelf.getByRole("textbox").fill("Validate the config first");
  await shelf.getByRole("button", { name: "Send feedback" }).click(); await expect(shelf).toHaveCount(0);
  expect(await page.evaluate(() => window.reviewHarness.accepted()[0]?.[0]?.annotation)).toMatchObject({ kind: "code", side: "right", startLine: 2, text: "Validate the config first", revision: "run:review:1" });
  expect(errors).toEqual([]);
});
test("image comments use image coordinates, drawing export keeps transparency and resizing", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); await mount(page);
  const editor = page.locator(".image-review-editor"); const canvas = editor.locator("canvas");
  await expect(editor.getByRole("button", { name: "Download edited image" })).toBeEnabled();
  await editor.getByRole("button", { name: "Comment", exact: true }).click();
  await canvas.click({ position: { x: 100, y: 60 } }); await editor.getByRole("textbox", { name: "Image comment" }).fill("Move this label");
  await editor.getByRole("button", { name: "Add comment" }).click(); await expect(editor.locator(".image-review-pin")).toHaveCount(1);
  await editor.getByRole("button", { name: "Brush", exact: true }).click();
  const box = (await canvas.boundingBox())!; await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down(); await page.mouse.move(box.x + 100, box.y + 50, { steps: 8 }); await page.mouse.up();
  await expect(editor.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
  await editor.getByRole("button", { name: "Erase pixels" }).click(); await canvas.click({ position: { x: 60, y: 60 } });
  const alpha = await canvas.evaluate((element: HTMLCanvasElement) => { const rect = element.getBoundingClientRect(); return element.getContext("2d")!.getImageData(Math.floor(60 * element.width / rect.width), Math.floor(60 * element.height / rect.height), 1, 1).data[3]; });
  expect(alpha).toBe(0);
  await editor.getByRole("button", { name: "Undo", exact: true }).click(); await editor.getByRole("button", { name: "Redo", exact: true }).click();
  await editor.getByRole("spinbutton", { name: "Image width" }).fill("320"); await editor.getByRole("button", { name: "Resize", exact: true }).click();
  await expect(canvas).toHaveAttribute("width", "320");
  await editor.getByRole("button", { name: "Add image to message" }).click();
  await expect.poll(async () => (await page.evaluate(() => window.reviewHarness.files())).at(-1)).toMatchObject({ name: "review-edited.png", type: "image/png" });
  const download = page.waitForEvent("download"); await editor.getByRole("button", { name: "Download edited image" }).click(); expect((await download).suggestedFilename()).toBe("review-edited.png");
  await expect(editor.getByRole("button", { name: "Remove background" })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("image-review-edited.png") });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(editor.getByRole("button", { name: "Add image to message" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("image-review-mobile.png") }); expect(errors).toEqual([]);
});
test("normal conversation sends code comments through its actual stream payload", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US")); const state = createBaseState({ approvalStatus: "expired" }); const title = installNormalWorkCellFixture(state); const firstProvider = state.providers[0]; if (firstProvider && typeof firstProvider === "object") (firstProvider as Record<string, unknown>).lastCheck = { ok: true, code: "ready", message: "Ready", checkedAt: "2026-11-17T00:00:00.000Z" }; state.terminalReports = state.terminalReports.map(report => ({ ...(report as object), changes: [{ id: "change", kind: "code", title: "Updated", summary: "Applied", paths: ["src/main.ts"], sourceRefs: [] }] })); await mockDaemon(page, state);
  await page.route(/\/(runs|turns)\/[^/]+\/workspace-changes(?:\?.*)?$/u, route => { const url = new URL(route.request().url()); const [, collection, id] = url.pathname.split("/"); const kind = collection === "runs" ? "run" : "turn"; return route.fulfill({ json: { cwd: url.searchParams.get("cwd"), state: "unavailable", canUndo: false, canReapply: false, files: [], summary: { fileCount: 1 }, review: { scope: { kind, id }, workspaceId: "workspace_default", runIds: [], revision: "review:1", state: "exact", coveredPaths: ["src/main.ts"], files: [{ id: "a", path: "src/main.ts", kind: "modified", state: "exact", additions: 2, deletions: 1, diff: "@@ -1,2 +1,3 @@\n-before\n+after\n+more\n context" }], additions: 2, deletions: 1 } } }); });
  let payload: Record<string, unknown> | undefined; page.on("request", request => { if (request.url().includes("/conversations/stream") && request.method() === "POST") payload = request.postDataJSON() as Record<string, unknown>; });
  await page.goto("/"); await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
  await page.getByRole("button", { name: "View changes", exact: true }).first().click();
  await page.locator(".workspace-change-review-page").getByRole("button", { name: "Comment on line 1", exact: true }).last().click();
  await page.locator(".code-review-comment-editor").getByRole("textbox").fill("Check this boundary"); await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await page.getByRole("region", { name: "Review feedback" }).getByRole("button", { name: "Send feedback" }).click();
  await expect.poll(() => payload).toBeTruthy(); expect(payload?.fileRefs).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/main.ts", line: 1, annotation: expect.objectContaining({ kind: "code", text: "Check this boundary" }) })]));
});

for (const active of [false, true]) test(`channel sends structured comments with active reply=${active}`, async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const { threadId, runId } = installChannelWorkCellFixture(state, "annotation");
  const turnId = state.turnRunLinks.find(link => link.runId === runId)?.turnId;
  const report = { ...completedTerminalReport({ id: "report_annotation", threadId, runId, turnId, title: "Files reviewed" }),
    channelId: "channel_engineering", changes: [{ id: "change", kind: "code" as const, title: "Updated", summary: "Applied", paths: ["src/main.ts"], sourceRefs: [] }] };
  state.terminalReports = [report]; attachCommittedChannelReportItem(state, report);
  if (active) {
    const original = state.runs[0]!;
    const activeRun = { ...original, id: "run_review_active", channelId: "channel_engineering", threadId, status: "running" as const, endedAt: undefined };
    state.runs.push(activeRun);
    state.channelMessages.push({ id: "message_review_active", workspaceId: "workspace_default", channelId: "channel_engineering", threadId,
      kind: "message", intent: "discuss", authorType: "local-user", authorId: "local-user", body: "Continue the review", mentions: [], attachmentIds: [], linkPreviewIds: [],
      fileRefs: [], linkedRunId: activeRun.id, status: "ready", createdAt: "2026-11-17T00:00:00.000Z", updatedAt: "2026-11-17T00:00:00.000Z" });
  }
  await mockDaemon(page, state);
  await page.route(/\/(runs|turns)\/[^/]+\/workspace-changes(?:\?.*)?$/u, route => {
    const url = new URL(route.request().url()); const [, collection, id] = url.pathname.split("/"); const kind = collection === "runs" ? "run" : "turn";
    return route.fulfill({ json: { cwd: url.searchParams.get("cwd"), state: "unavailable", canUndo: false, canReapply: false, files: [], summary: { fileCount: 1 }, review: {
      scope: { kind, id }, workspaceId: "workspace_default", runIds: [], revision: "channel-review:1", state: "exact", coveredPaths: ["src/main.ts"],
      files: [{ id: "a", path: "src/main.ts", kind: "modified", state: "exact", additions: 1, deletions: 1, diff: "@@ -1 +1 @@\n-before\n+after" }], additions: 1, deletions: 1,
    } } });
  });
  await page.goto("/"); await openEngineeringChannel(page);
  await page.getByRole("button", { name: "View changes", exact: true }).first().click();
  await page.locator(".workspace-change-review-page").getByRole("button", { name: "Comment on line 1", exact: true }).last().click();
  await page.locator(".code-review-comment-editor").getByRole("textbox").fill("Validate the channel boundary");
  await page.locator(".code-review-comment-editor").getByRole("button", { name: "Add comment", exact: true }).click();
  const shelf = page.getByRole("region", { name: "Review feedback" });
  await page.screenshot({ path: info.outputPath(`channel-feedback-${active ? "active" : "idle"}.png`) });
  await shelf.getByRole("button", { name: "Send feedback" }).click();
  await expect.poll(() => state.lastChannelTurnRequest).toBeTruthy();
  expect(state.lastChannelTurnRequest?.fileRefs).toEqual(expect.arrayContaining([expect.objectContaining({ path: "src/main.ts", line: 1, annotation: expect.objectContaining({ kind: "code", text: "Validate the channel boundary" }) })]));
  await expect(shelf).toHaveCount(0);
  if (active) expect(state.runInterventions.at(-1)?.messagePayload?.fileRefs).toEqual(expect.arrayContaining([expect.objectContaining({ annotation: expect.objectContaining({ text: "Validate the channel boundary" }) })]));
});
