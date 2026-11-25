import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon, cwd } from "./support/mock-daemon";
import { createBaseState, createMockTeammate } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";
import { mkdir } from "node:fs/promises";
import type { WorkSummaryResponse } from "@ling-stack/contracts";

const evidence = "/tmp/ling-work-summary-evidence";
const alternateCwd = `${cwd}/.ling-stack/worktrees/offline-sync`;
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
  let summary = fixture(); let reads = 0; let fail = false;
  const reviewedDirectories: string[] = [];
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
    const query = new URL(route.request().url()).searchParams;
    expect(query.get("baseline")).toBe("head");
    const reviewCwd = query.get("cwd") ?? "";
    reviewedDirectories.push(reviewCwd);
    const path = reviewCwd === alternateCwd ? "src/offline-sync.ts" : "src/panel.ts";
    await route.fulfill({ json: { cwd: reviewCwd, state: "dirty", additions: 1, deletions: 1, totalFileCount: 1, truncated: false, checkedAt: "2026-10-23T08:00:00Z",
      files: [{ path, kind: "modified", staged: false, unstaged: true, untracked: false, additions: 1, deletions: 1, truncated: false,
        diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n` }] } });
  });
  await page.goto("/"); await openEngineeringChannel(page);
  return { get reads() { return reads; }, get reviewedDirectories() { return [...reviewedDirectories]; }, fail() { fail = true; }, replace(next: WorkSummaryResponse) { summary = next; } };
}

function withAlternateWorktree(data = fixture()): WorkSummaryResponse {
  return {
    ...data,
    sessions: [...data.sessions, {
      id: "summary-conversation", threadId: "summary-conversation", title: "Summary conversation", surface: "conversation",
      status: "succeeded", workspaceKey: alternateCwd,
    }],
    workspaces: [...data.workspaces, {
      key: alternateCwd, cwd: alternateCwd, state: "ready", branch: "feat/offline-sync", changedFiles: 1,
      additions: 8, deletions: 1, partial: false, checkedAt: data.checkedAt, commits: [],
    }],
  };
}

test("summary switches scopes, groups shared work, and reviews the selected checkout", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const f = await prepare(page);
  f.replace(withAlternateWorktree());
  expect(f.reads).toBe(0);
  const trigger = page.getByRole("button", { name: "Summary", exact: true });
  await trigger.click();
  const panel = page.getByRole("region", { name: "Work summary", exact: true });
  const popover = page.locator(".channel-progress-popover").filter({ has: panel });
  const current = panel.getByRole("tabpanel", { name: "Current conversation" });
  const overview = panel.getByRole("tabpanel", { name: "Project overview" });
  await expect(current).toContainText("Local environment");
  await expect(current.getByRole("button", { name: /Uncommitted changes/u })).toContainText("+123");
  await expect(current.locator(".attention-environment-row").filter({ hasText: "Changes" })).toHaveCount(0);
  await expect(current).not.toContainText("feat/offline-sync");
  await expect(overview).toBeHidden();
  const bounds = await panel.boundingBox();
  expect(bounds!.x + bounds!.width).toBeGreaterThan(1350);
  await mkdir(evidence, { recursive: true });
  await popover.screenshot({ path: `${evidence}/current-conversation.png` });
  const currentTab = panel.getByRole("tab", { name: "Current conversation" });
  const overviewTab = panel.getByRole("tab", { name: "Project overview" });
  await currentTab.press("ArrowRight");
  await expect(overview).toBeVisible();
  await expect(overview).toContainText("2 workspaces · 3 sessions");
  await expect(overview.getByRole("button", { name: /codex\/workspace-work-summary.*2 sessions/u })).toHaveAttribute("aria-expanded", "true");
  await expect(overview.getByRole("button", { name: /Uncommitted changes/u })).toHaveCount(1);
  await expect(overview).toContainText("CI pending");
  await expect(overview.getByRole("button", { name: /Implement workspace panel/u })).toContainText("Running");
  await expect(overview.getByRole("button", { name: /Review module boundaries/u })).toContainText("Waiting for approval");
  const alternateGroup = overview.getByRole("button", { name: /feat\/offline-sync/u });
  await expect(alternateGroup).toHaveAttribute("aria-expanded", "false");
  await popover.screenshot({ path: `${evidence}/project-overview.png` });
  await alternateGroup.press("Enter");
  await expect(overview.getByRole("button", { name: /Summary conversation/u })).toBeVisible();
  expect(f.reviewedDirectories).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(panel).toBeHidden();
  await trigger.click();
  await overviewTab.click();
  await alternateGroup.click();
  await overview.getByRole("button", { name: /Uncommitted changes.*1 changed file/u }).click();
  const review = page.getByLabel("Channel workspace dock");
  await expect(review).toContainText("offline-sync.ts");
  await expect(panel).toBeHidden();
  expect(f.reviewedDirectories).toEqual([alternateCwd]);
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await expect(review).toBeHidden();
  await trigger.click();
  await overviewTab.click();
  await alternateGroup.click();
  await overview.getByRole("button", { name: /Summary conversation/u }).click();
  await expect(page.getByRole("toolbar", { name: "Conversation workspace toolbar" })).toBeVisible();
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});

test("PR attach and unlink remain project-local; refresh failures retain data and time", async ({ page }) => {
  const f = await prepare(page, "ling-dark"); await page.getByRole("button", { name: "Summary", exact: true }).click();
  const panel = page.locator(".work-summary-panel");
  await panel.getByRole("tab", { name: "Project overview" }).click();
  await expect(panel).toContainText("+123");
  await panel.getByRole("button", { name: "Link a pull request" }).click();
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
  const data = withAlternateWorktree();
  f.replace({ ...data, workspaces: [
    { ...data.workspaces[0]!, changedFiles: undefined, additions: undefined, deletions: undefined, partial: true },
    { ...data.workspaces[1]!, branch: "main", changedFiles: 0, additions: 0, deletions: 0 },
  ] });
  await page.getByRole("button", { name: "Summary", exact: true }).click(); const panel = page.locator(".work-summary-panel");
  await panel.getByRole("tab", { name: "Project overview" }).click();
  await expect(panel).toContainText("Partial statistics");
  await expect(panel.locator(".work-summary-stats")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /main.*No changes/u })).toBeVisible();
  await expect(panel.getByRole("button", { name: /Uncommitted changes|^Changes$/u })).toHaveCount(0);
  const bounds = await panel.boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(720);
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/web-narrow.png` });
});


for (const surface of ["normal", "private"] as const) {
  test(`unified summary preserves ${surface} context and opens net diff in its existing drawer`, async ({ page }) => {
    const f = await prepare(page);
    if (surface === "normal") f.replace(withAlternateWorktree());
    if (surface === "normal") await page.locator(".sidebar-recent-row").filter({ hasText: "Summary conversation" }).click();
    else await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Summary engineer", exact: true }).click();
    const toolbar = page.getByRole("toolbar", { name: surface === "normal" ? "Conversation workspace toolbar" : "Private chat actions" });
    await toolbar.getByRole("button", { name: "Summary", exact: true }).click();
    const panel = page.locator(".work-summary-panel");
    const current = panel.getByRole("tabpanel", { name: "Current conversation" });
    await expect(current).toContainText(surface === "normal" ? "Workspace" : "Private workspace");
    if (surface === "normal") {
      await expect(current).toContainText("feat/offline-sync");
      await expect(current.getByRole("button", { name: /Uncommitted changes/u })).toContainText("+8");
      await expect(current).not.toContainText("+123");
    }
    await panel.getByRole("tab", { name: "Project overview" }).click();
    const overview = panel.getByRole("tabpanel", { name: "Project overview" });
    await expect(overview.getByRole("button", { name: /codex\/workspace-work-summary.*2 sessions/u })).toBeVisible();
    await overview.getByRole("button", { name: /Uncommitted changes/u }).click();
    const drawer = page.getByLabel(surface === "normal" ? "Conversation workspace dock" : "Private chat workspace dock");
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText(surface === "normal" ? "offline-sync.ts" : "panel.ts");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(f.reviewedDirectories).toEqual([surface === "normal" ? alternateCwd : cwd]);
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
  await page.getByRole("tabpanel", { name: "Current conversation" }).getByRole("button", { name: /Uncommitted changes/u }).click();
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
  await page.route("**/workspace-files/open-options?**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    await route.fulfill({
      json: {
        cwd: query.get("cwd"),
        path: query.get("path"),
        options: [
          ["vscode", "Visual Studio Code"], ["cursor", "Cursor"], ["zed", "Zed"], ["xcode", "Xcode"],
          ["pycharm", "PyCharm"], ["webstorm", "WebStorm"], ["intellij", "IntelliJ IDEA"], ["sublime_text", "Sublime Text"],
          ["finder", "Show in Finder"], ["terminal", "Terminal"],
        ].map(([id, label]) => ({ id, label, available: true })),
      },
    });
  });
  const card = review.locator(".workspace-change-file-section").last();
  await card.getByRole("button", { name: "Open with", exact: true }).click();
  const menu = card.locator(".workspace-file-open-popover");
  await expect(menu.getByRole("button")).toHaveCount(10);
  await expect(card.locator(".workspace-file-open-menu")).toHaveClass(/above/);
  await expect.poll(() => menu.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
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
