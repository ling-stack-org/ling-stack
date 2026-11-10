import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon, cwd } from "./support/mock-daemon";
import { createBaseState, createMockTeammate } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";
import { mkdir } from "node:fs/promises";
import type { WorkSummaryResponse } from "@ling-stack/contracts";

const evidence = "/tmp/ling-work-summary-evidence";
function fixture(): WorkSummaryResponse {
  return { cwd, checkedAt: "2026-10-23T08:00:00Z", truncated: false,
    sessions: [ { id: "one", channelId: "channel_engineering", title: "Implement workspace panel", surface: "channel", status: "running", workspaceKey: cwd },
      { id: "two", channelId: "channel_engineering", title: "Review module boundaries", surface: "channel", status: "waiting_for_approval", workspaceKey: cwd } ],
    workspaces: [{ key: cwd, cwd, state: "ready", branch: "codex/workspace-work-summary", changedFiles: 4, additions: 123, deletions: 18, binaryFiles: 1, partial: false, checkedAt: "2026-10-23T08:00:00Z",
      commits: [{ sha: "1234567890abcdef1234567890abcdef12345678", subject: "Add project work summary", committedAt: "2026-10-23T07:30:00Z" }] }],
    pullRequests: [{ url: "https://github.com/ling-stack-org/ling-stack/pull/42", repository: "ling-stack-org/ling-stack", number: 42, title: "Workspace work summary", state: "draft", connection: "connected", ci: "pending", createdAt: "2026-10-23T08:00:00Z" }] };
}
async function prepare(page: Page, theme = "ling-light") {
  await page.addInitScript((theme) => { localStorage.setItem("ling-stack.locale", "en-US"); const selection = { mode: "fixed", themeId: theme }; localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection)); localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection)); }, theme);
  const state = createBaseState({ approvalStatus: "expired" });
  state.threads = [{ id: "summary-conversation", workspaceId: "workspace_default", kind: "conversation", title: "Summary conversation", objective: "Review current work", status: "open", createdAt: "2026-10-23T08:00:00Z", updatedAt: "2026-10-23T08:00:00Z" }];
  state.turns = [{ id: "summary-turn", workspaceId: "workspace_default", threadId: "summary-conversation", kind: "initial_request", status: "succeeded", title: "Review current work", userInstruction: "Review current work", createdByActor: "local-user", createdAt: "2026-10-23T08:00:00Z", updatedAt: "2026-10-23T08:00:00Z", completedAt: "2026-10-23T08:00:00Z" }];
  state.aiTeammates = [createMockTeammate({ id: "summary-engineer", displayName: "Summary engineer" })];
  await mockDaemon(page, state);
  let summary = fixture(); let reads = 0; let detailReads = 0; let fail = false;
  await page.route("http://127.0.0.1:17891/workspace/work-summary**", async (route) => {
    const method = route.request().method();
    if (method === "GET") { reads++; if (fail) { await route.abort("failed"); return; } }
    if (method === "POST") {
      const url = route.request().postDataJSON().url;
      summary = { ...summary, pullRequests: [...summary.pullRequests, { url, repository: "example/repo", number: 7, state: "unknown", connection: "unconnected", ci: "unknown", createdAt: "2026-10-23T08:00:00Z" }] };
    }
    if (method === "DELETE") summary = { ...summary, pullRequests: summary.pullRequests.filter((item) => item.url !== new URL(route.request().url()).searchParams.get("url")) };
    await route.fulfill({ json: method === "GET" ? summary : { ok: true } });
  });
  await page.route("**/workspace/changes?**", async (route) => {
    detailReads++;
    expect(new URL(route.request().url()).searchParams.get("baseline")).toBe("head");
    await route.fulfill({ json: { cwd, state: "dirty", additions: 1, deletions: 1, totalFileCount: 1, truncated: false, checkedAt: "2026-10-23T08:00:00Z",
      files: [{ path: "src/panel.ts", kind: "modified", staged: false, unstaged: true, untracked: false, additions: 1, deletions: 1, truncated: false, diff: "diff --git a/src/panel.ts b/src/panel.ts\n--- a/src/panel.ts\n+++ b/src/panel.ts\n@@ -1 +1 @@\n-old\n+new\n" }] } });
  });
  await page.goto("/"); await openEngineeringChannel(page);
  return { get reads() { return reads; }, get detailReads() { return detailReads; }, fail() { fail = true; }, replace(next: WorkSummaryResponse) { summary = next; } };
}

test("summary deduplicates shared work, opens net diff on demand, and restores keyboard focus", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const f = await prepare(page); expect(f.reads).toBe(0); expect(f.detailReads).toBe(0);
  const trigger = page.getByRole("button", { name: "Summary", exact: true });
  await trigger.click(); const panel = page.locator(".work-summary-panel");
  await expect(panel).toContainText("Shared by 2 sessions; counted once"); await expect(panel).toContainText("+123");
  await expect(panel.locator(".work-summary-change")).toHaveCount(1); await expect(panel).toContainText("CI pending");
  await expect(page.getByRole("button", { name: "Work summary", exact: true })).toHaveCount(0);
  await expect(panel).toContainText("Local environment");
  await expect(panel.locator(".attention-environment-row").filter({ hasText: "Changes" })).toHaveCount(0);
  const bounds = await panel.boundingBox();
  expect(bounds!.x + bounds!.width).toBeGreaterThan(1350);
  await mkdir(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/web-light.png` });
  expect(f.detailReads).toBe(0); await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
  await trigger.click(); await panel.getByRole("button", { name: /Changes/ }).click();
  const review = page.getByLabel("Channel workspace dock"); await expect(review).toBeVisible(); await expect(review).toContainText("panel.ts"); expect(f.detailReads).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Hide details", exact: true }).click();
  await expect(review).toBeHidden(); expect(errors).toEqual([]);
});

test("PR attach and unlink remain project-local; refresh failures retain data and time", async ({ page }) => {
  const f = await prepare(page, "ling-dark"); await page.getByRole("button", { name: "Summary", exact: true }).click();
  const panel = page.locator(".work-summary-panel"); await expect(panel).toContainText("+123");
  await panel.getByRole("textbox", { name: "Pull request URL" }).fill("https://github.com/example/repo/pull/7");
  await panel.getByRole("button", { name: "Attach", exact: true }).click();
  await expect(panel).toContainText("GitHub not connected"); await expect(panel.getByRole("link", { name: /example\/repo/ })).toHaveAttribute("href", "https://github.com/example/repo/pull/7");
  await panel.locator(".work-summary-pr").filter({ hasText: "example/repo" }).getByRole("button", { name: "Unlink pull request" }).click(); await expect(panel).not.toContainText("example/repo");
  const timestamp = await panel.locator(".work-summary-time").textContent(); f.fail(); await panel.getByRole("button", { name: "Refresh work summary" }).click();
  await expect(panel).toContainText("Refresh failed; showing last available data"); await expect(panel).toContainText("+123"); expect(await panel.locator(".work-summary-time").textContent()).toBe(timestamp);
  await page.screenshot({ path: `${evidence}/web-dark-offline.png` });
});

test("unknown and partial statistics cannot appear as zero, and panel fits a narrow viewport", async ({ page }) => {
  const f = await prepare(page); await page.setViewportSize({ width: 720, height: 720 });
  const data = fixture(); f.replace({ ...data, workspaces: [{ ...data.workspaces[0]!, additions: undefined, deletions: undefined, partial: true }] });
  await page.getByRole("button", { name: "Summary", exact: true }).click(); const panel = page.locator(".work-summary-panel");
  await expect(panel).toContainText("Partial statistics"); await expect(panel.locator(".work-summary-stats")).toHaveCount(0);
  const bounds = await panel.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(720);
  await page.screenshot({ path: `${evidence}/web-narrow.png` });
});


for (const surface of ["normal", "private"] as const) {
  test(`unified summary preserves ${surface} context and opens net diff in its existing drawer`, async ({ page }) => {
    const f = await prepare(page);
    if (surface === "normal") await page.locator(".sidebar-recent-row").filter({ hasText: "Summary conversation" }).click();
    else await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Summary engineer", exact: true }).click();
    const toolbar = page.getByRole("toolbar", { name: surface === "normal" ? "Conversation workspace toolbar" : "Private chat actions" });
    await toolbar.getByRole("button", { name: "Summary", exact: true }).click();
    const panel = page.locator(".work-summary-panel");
    await expect(panel).toContainText("Shared by 2 sessions; counted once");
    await expect(panel).toContainText(surface === "normal" ? "Workspace" : "Private workspace");
    await panel.locator(".work-summary-change").click();
    const drawer = page.getByLabel(surface === "normal" ? "Conversation workspace dock" : "Private chat workspace dock");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText("panel.ts");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(f.detailReads).toBe(1);
  });
}

async function openShortFileReview(page: Page): Promise<Locator> {
  await prepare(page);
  await page.route("**/workspace/changes?**", async (route) => {
    await route.fulfill({ json: { cwd, state: "dirty", additions: 2, deletions: 2, totalFileCount: 2, truncated: false, checkedAt: "2026-10-23T08:00:00Z",
      files: ["src/panel.ts", "notes.md"].map((path) => ({ path, kind: "modified", staged: false, unstaged: true, untracked: false, additions: 1, deletions: 1, truncated: false,
        diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n` })) } });
  });
  await page.getByRole("button", { name: "Summary", exact: true }).click();
  await page.locator(".work-summary-change").click();
  const review = page.getByLabel("Channel workspace dock");
  await expect(review.locator(".workspace-change-file-section")).toHaveCount(2);
  return review;
}

async function expectMenuItemReceivesPointer(item: Locator): Promise<void> {
  // DOM visibility and bounding boxes do not detect content-visibility paint clipping.
  await expect.poll(() => item.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
}

test("file open menus escape short and collapsed diff cards and launch the selected file", async ({ page }) => {
  const review = await openShortFileReview(page);
  const cards = review.locator(".workspace-change-file-section");
  for (const [index, path] of ["src/panel.ts", "notes.md"].entries()) {
    const card = cards.nth(index);
    for (const collapsed of [false, true]) {
      if (collapsed) await card.locator(".workspace-change-file-toggle").click();
      await card.getByRole("button", { name: "Open with", exact: true }).click();
      const menu = card.locator(".workspace-file-open-popover");
      await expect(menu.getByRole("button")).toHaveCount(4);
      for (const item of await menu.locator("button, a").all()) await expectMenuItemReceivesPointer(item);
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: `${evidence}/open-menu-${index}-${collapsed ? "collapsed" : "expanded"}.png` });
      const request = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/workspace-files/open");
      await menu.getByRole("button", { name: "Terminal", exact: true }).click();
      const launch = await request;
      expect(new URL(launch.url()).searchParams.get("path")).toBe(path);
      expect(launch.postDataJSON()).toEqual({ target: "terminal" });
      await expect(menu).toHaveCount(0);
    }
  }
});

test("file open menu flips and scrolls in a short drawer, and closes on outside click", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 400 });
  const review = await openShortFileReview(page);
  const card = review.locator(".workspace-change-file-section").last();
  await card.getByRole("button", { name: "Open with", exact: true }).click();
  const menu = card.locator(".workspace-file-open-popover");
  await expect(menu.getByRole("button")).toHaveCount(4);
  await expect(card.locator(".workspace-file-open-menu")).toHaveClass(/above/);
  const scrollable = await menu.evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(scrollable).toBe(true);
  for (const item of await menu.locator("button, a").all()) {
    await item.scrollIntoViewIfNeeded();
    await expectMenuItemReceivesPointer(item);
  }
  const download = menu.getByRole("link", { name: "Download", exact: true });
  await download.scrollIntoViewIfNeeded();
  await expectMenuItemReceivesPointer(download);
  const bounds = await menu.boundingBox();
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(400);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/open-menu-short-drawer.png` });
  await review.locator(".workspace-change-review-summary").click();
  await expect(menu).toHaveCount(0);
});
