import { expect, test, type Page } from "@playwright/test";
import type { LingTurnStatus, WorkspaceChangeReview } from "@ling-stack/contracts";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider } from "./support/mock-state";
import { installChannelWorkCellFixture, installNormalWorkCellFixture, installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { openEngineeringChannel } from "./support/test-helpers";

const paths = ["src/shared.ts", "tests/shared.ts", ...Array.from({ length: 12 }, (_, index) => `packages/long-workspace-directory/another-directory/file-${index}.ts`)];
function reviewFor(threadId: string, turnId: string, revision: string, selectedPaths = paths): WorkspaceChangeReview {
  const files = selectedPaths.map((path) => ({ id: `${turnId}:${path}`, path, kind: "modified" as const, state: "exact" as const, additions: 1, deletions: 1,
    diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+${revision} ${path}\n` }));
  return { scope: { kind: "turn", id: turnId }, workspaceId: "workspace_default", threadId, runIds: [], revision, state: "exact", coveredPaths: selectedPaths,
    files, additions: files.length, deletions: files.length };
}
const invalidate = (page: Page) => page.evaluate(() => window.dispatchEvent(new CustomEvent("ling:work-summary-invalidated")));

for (const surface of ["normal", "private", "channel"] as const) for (const locale of ["en-US", "zh-CN"] as const) {
  test(`${surface} ${locale} live composer summary opens a bounded file list and follows scoped review changes`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.addInitScript((value) => {
      localStorage.setItem("ling-stack.locale", value);
      localStorage.setItem("ling-stack.themePreference", value === "zh-CN" ? "dark" : "light");
    }, locale);
    const state = createBaseState({ approvalStatus: "expired" });
    state.workspaceSettings.locale = locale;
    state.workspaceSettings.theme = locale === "zh-CN" ? "dark" : "light";
    const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
    const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
    const channel = surface === "channel" ? installChannelWorkCellFixture(state, "summary") : undefined;
    const threadId = channel?.threadId ?? (surface === "normal" ? "thread_ui2_normal_work_cell" : "thread_ui2_teammate_work_cell");
    const turnId = state.turns.find((turn) => turn.threadId === threadId)!.id;
    let status: LingTurnStatus = "running";
    let review = reviewFor(threadId, turnId, "first");
    let summaryReads = 0;
    const scopedReads: string[] = [];
    await mockDaemon(page, state);
    await page.route(/\/threads\/[^/]+\/workspace-change-summary(?:\?.*)?$/u, async (route) => {
      const url = new URL(route.request().url());
      const requested = decodeURIComponent(url.pathname.split("/")[2]!);
      summaryReads += 1;
      await route.fulfill({ json: { cwd: url.searchParams.get("cwd"), threadId: requested,
        turn: requested === threadId ? { id: turnId, status } : undefined,
        review: requested === threadId ? { ...review, files: review.files.map(({ diff: _diff, ...file }) => file) } : undefined } });
    });
    await page.route(/\/turns\/[^/]+\/workspace-changes(?:\?.*)?$/u, async (route) => {
      const url = new URL(route.request().url()); const id = decodeURIComponent(url.pathname.split("/")[2]!);
      scopedReads.push(id);
      await route.fulfill({ json: { cwd: url.searchParams.get("cwd"), turnId: id, threadId, runIds: [], state: "unavailable", canUndo: false, canReapply: false,
        summary: { fileCount: review.files.length }, files: [], review } });
    });
    await page.goto("/");
    await expect(page).toHaveTitle("Ling Stack");
    expect(new URL(page.url()).pathname).toBe("/");
    if (title) await page.getByRole("button", { name: /Open recent conversation \d+|打开最近对话 \d+/u }).filter({ hasText: title }).click();
    if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
    if (channel) await openEngineeringChannel(page);
    const chip = page.locator("[data-conversation-change-summary]");
    const popover = page.locator(".conversation-change-summary-popover");
    await expect(chip).toHaveAttribute("data-conversation-change-summary", turnId);
    await expect(chip).toContainText(locale === "zh-CN" ? "正在编辑 14 个文件" : "Editing 14 files");
    await expect(chip.locator(".conversation-change-summary-counts")).toHaveText("+14−14");
    const composerSurface = surface === "normal" ? "normal_conversation" : surface === "private" ? "teammate_direct" : "channel";
    const frame = page.locator(`[data-conversation-composer-frame="${composerSurface}"]`);
    await expect(frame.locator("[data-conversation-change-summary]")).toHaveCount(1);
    await expect(frame.locator("section [data-conversation-change-summary]")).toHaveCount(0);
    await chip.hover(); await expect(popover).toBeVisible();
    await expect(popover.getByRole("button")).toHaveCount(14);
    await expect(popover).toHaveCSS("opacity", "1");
    const chipBox = await chip.boundingBox(); const popupBox = await popover.boundingBox();
    expect(popupBox!.y + popupBox!.height).toBeLessThanOrEqual(chipBox!.y);
    expect(await popover.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await popover.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${surface}-${locale}-summary-popover.png`) });
    await popover.getByRole("button", { name: "tests/shared.ts", exact: true }).click();
    const dock = page.locator(".workspace-change-review-page");
    await expect(dock).toHaveAttribute("data-workspace-change-review-id", turnId);
    await expect(dock.locator('.workspace-change-file-section[data-workspace-change-path="tests/shared.ts"]')).toHaveClass(/selected/u);
    await expect(dock).toContainText("first tests/shared.ts");
    review = reviewFor(threadId, turnId, "second", [...paths, "src/newly-edited.ts"]);
    await invalidate(page);
    await expect(chip).toHaveAttribute("data-change-summary-revision", "second");
    await expect(dock).toHaveAttribute("data-workspace-change-review-revision", "second");
    await expect(dock.locator(".workspace-change-file-section")).toHaveCount(15);
    await expect(dock).toContainText("second src/newly-edited.ts");
    status = "succeeded"; await invalidate(page);
    await expect(chip).toContainText(locale === "zh-CN" ? "已编辑 15 个文件" : "Edited 15 files");
    await chip.locator(".conversation-change-summary-main").focus();
    await page.keyboard.press("Tab");
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape"); await expect(popover).toHaveCount(0);
    const trigger = chip.getByRole("button", { name: locale === "zh-CN" ? "变更文件" : "Changed files" });
    await trigger.click(); await expect(popover).toHaveAttribute("data-state", "open");
    await popover.getByRole("button", { name: "src/shared.ts", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(dock.locator('.workspace-change-file-section[data-workspace-change-path="src/shared.ts"]')).toHaveClass(/selected/u);
    await page.setViewportSize({ width: 820, height: 900 });
    await trigger.click(); await expect(popover).toHaveAttribute("data-state", "open");
    await expect(popover).toHaveCSS("opacity", "1");
    const narrowBox = await popover.boundingBox(); expect(narrowBox!.x).toBeGreaterThanOrEqual(0); expect(narrowBox!.x + narrowBox!.width).toBeLessThanOrEqual(820);
    await page.screenshot({ path: testInfo.outputPath(`${surface}-${locale}-narrow-popover.png`) });
    await expect(popover).toHaveAttribute("data-state", "open");
    review = reviewFor(threadId, turnId, "zero", []); await invalidate(page);
    await expect(chip).toHaveCount(0); await expect(popover).toHaveCount(0);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(summaryReads).toBeGreaterThan(1); expect(scopedReads.every((id) => id === turnId)).toBe(true); expect(errors).toEqual([]);
  });
}

test("switching conversation hides a delayed old summary before it can publish", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const title = installNormalWorkCellFixture(state); const teammate = installTeammateWorkCellFixture(state);
  await mockDaemon(page, state);
  let release!: () => void; let normalRequested = false; let normalReturned = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/threads\/[^/]+\/workspace-change-summary(?:\?.*)?$/u, async (route) => {
    const url = new URL(route.request().url()); const threadId = decodeURIComponent(url.pathname.split("/")[2]!);
    const turnId = threadId.includes("normal") ? "turn_ui2_normal_work_cell" : "turn_ui2_teammate_work_cell";
    if (threadId.includes("normal")) { normalRequested = true; await gate; }
    const review = reviewFor(threadId, turnId, threadId);
    await route.fulfill({ json: { cwd: url.searchParams.get("cwd"), threadId, turn: { id: turnId, status: "succeeded" }, review } });
    if (threadId.includes("normal")) normalReturned = true;
  });
  await page.goto("/"); await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
  await expect.poll(() => normalRequested).toBe(true);
  await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
  const chip = page.locator("[data-conversation-change-summary]");
  await expect(chip).toHaveAttribute("data-conversation-change-summary", "turn_ui2_teammate_work_cell");
  release(); await expect.poll(() => normalReturned).toBe(true);
  await expect(chip).toHaveAttribute("data-conversation-change-summary", "turn_ui2_teammate_work_cell");
});

test("a partial summary omits aggregate counts and keeps unavailable file state explicit", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" }); const title = installNormalWorkCellFixture(state);
  await mockDaemon(page, state);
  await page.route(/\/threads\/[^/]+\/workspace-change-summary(?:\?.*)?$/u, async (route) => {
    const url = new URL(route.request().url()); const threadId = decodeURIComponent(url.pathname.split("/")[2]!);
    const exact = reviewFor(threadId, "turn_ui2_normal_work_cell", "partial", paths.slice(0, 2));
    await route.fulfill({ json: { cwd: url.searchParams.get("cwd"), threadId, turn: { id: "turn_ui2_normal_work_cell", status: "running" },
      review: { ...exact, state: "partial", additions: undefined, deletions: undefined, files: [exact.files[0], { ...exact.files[1], state: "unavailable", additions: undefined, deletions: undefined, diff: undefined }] } } });
  });
  await page.goto("/"); await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
  const chip = page.locator("[data-conversation-change-summary]");
  await expect(chip).toContainText("Partial statistics"); await expect(chip.locator(".conversation-change-summary-counts")).toHaveCount(0);
  await chip.hover(); const popover = page.locator(".conversation-change-summary-popover");
  await expect(popover).toContainText("Historical diff unavailable");
  await expect(popover.getByRole("button", { name: "tests/shared.ts", exact: true })).toContainText("Unavailable");
});

test("submitting the next message suppresses the prior chip and an empty next Turn does not restore it", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" }); const title = installNormalWorkCellFixture(state);
  state.providers = [createChatProvider({ id: "provider_ui2_work_cell", lastCheck: { ok: true, message: "ok", checkedAt: "2026-11-01T00:00:00.000Z" } })];
  let nextTurn = false;
  let nextTurnReads = 0;
  await mockDaemon(page, state);
  await page.route(/\/threads\/[^/]+\/workspace-change-summary(?:\?.*)?$/u, async (route) => {
    const url = new URL(route.request().url()); const threadId = decodeURIComponent(url.pathname.split("/")[2]!);
    if (nextTurn) nextTurnReads += 1;
    await route.fulfill({ json: { cwd: url.searchParams.get("cwd"), threadId, turn: { id: nextTurn ? "next-turn" : "turn_ui2_normal_work_cell", status: nextTurn ? "running" : "succeeded" },
      review: nextTurn ? undefined : reviewFor(threadId, "turn_ui2_normal_work_cell", "old") } });
  });
  let release!: () => void; let requested = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/conversations\/stream(?:\?.*)?$/u, async (route) => { requested = true; await gate; await route.fallback(); });
  await page.goto("/"); await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
  const chip = page.locator("[data-conversation-change-summary]"); await expect(chip).toBeVisible();
  await page.getByRole("textbox", { name: "Conversation message", exact: true }).fill("Continue with a new Turn.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requested).toBe(true); await expect(chip).toHaveCount(0);
  nextTurn = true; release(); await invalidate(page);
  await expect.poll(() => nextTurnReads).toBeGreaterThan(0);
  await expect(page.getByRole("textbox", { name: "Conversation message", exact: true })).toBeVisible();
  await expect(chip).toHaveCount(0);
});
