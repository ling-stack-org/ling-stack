import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockTeammate,
  cwd,
  defaultRuntimePolicy,
  type MockRun,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/shell/sidebar-list-states/",
  import.meta.url,
));

test("Sidebar channel and teammate rows expose one truthful primary state", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "expired" });
  state.tasks = [
    task("task_channel_running", "channel_running", "running"),
    task("task_channel_failed", "channel_failed", "failed"),
    task("task_teammate_waiting", "channel_idle_1", "running", "teammate_waiting"),
    task("task_teammate_running", "channel_idle_1", "running", "teammate_running"),
    task("task_teammate_failed", "channel_idle_1", "failed", "teammate_failed"),
  ];
  state.runs = [
    run("run_channel_running", "task_channel_running", "running", { channelId: "channel_running" }),
    run("run_channel_failed", "task_channel_failed", "failed", { channelId: "channel_failed" }),
    run("run_teammate_running", "task_teammate_running", "running", { teammateId: "teammate_running" }),
    run("run_teammate_failed", "task_teammate_failed", "failed", { teammateId: "teammate_failed" }),
    run("run_teammate_waiting", "task_teammate_waiting", "waiting_for_approval", { teammateId: "teammate_waiting" }),
  ];
  state.approvals = [approval("approval_teammate_waiting", "task_teammate_waiting")];
  state.channels = [
    channel("channel_paused", "Paused Channel", "paused"),
    channel("channel_running", "Running Channel"),
    channel("channel_failed", "Failed Channel"),
    ...Array.from({ length: 7 }, (_, index) => channel(`channel_idle_${index + 1}`, `Idle Channel ${index + 1}`)),
  ];
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_paused", displayName: "Paused Teammate", status: "paused" }),
    createMockTeammate({ id: "teammate_waiting", displayName: "Waiting Teammate" }),
    createMockTeammate({ id: "teammate_running", displayName: "Running Teammate" }),
    createMockTeammate({ id: "teammate_failed", displayName: "Failed Teammate" }),
    ...Array.from({ length: 4 }, (_, index) => createMockTeammate({
      id: `teammate_idle_${index + 1}`,
      displayName: `Idle Teammate ${index + 1}`,
    })),
  ];
  state.threads = Array.from({ length: 6 }, (_, index) => conversationThread(index));
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await expectPrimaryStatus(navigation, "Paused Channel", "paused");
  await expectPrimaryStatus(navigation, "Running Channel", "running");
  await expectPrimaryStatus(navigation, "Failed Channel", "failed");
  await expectPrimaryStatus(navigation, "Paused Teammate", "paused");
  await expectPrimaryStatus(navigation, "Waiting Teammate", "waiting");
  await expectPrimaryStatus(navigation, "Running Teammate", "running");
  await expectPrimaryStatus(navigation, "Failed Teammate", "failed");
  await expect(rowFor(navigation, "Idle Channel 1").locator("[data-sidebar-primary-status]")).toHaveCount(0);
  await expect(navigation.locator(".channel-mention")).toHaveCount(0);
  await expect(navigation.locator(".sidebar-recent-row")).toHaveCount(5);
  await expectNoHorizontalOverflow(navigation);
  await captureEvidence(page, "1440x960-ling-light-dense-states.png");
  expect(runtimeErrors).toEqual([]);
});

test("Recent conversations keep a stable header while the initial list uses a Skeleton", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 1280, 800);
  const state = createBaseState({ approvalStatus: "expired" });
  state.threads = [{ ...conversationThread(0), status: "running" }];
  await mockDaemon(page, state);
  await delayRoute(page, /^http:\/\/127\.0\.0\.1:17891\/threads(?:\?.*)?$/, 1_500);
  const threadListResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/threads" && url.searchParams.get("kind") === "conversation";
  });
  await page.goto("/");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  const recentHeaderStatus = navigation.locator('[data-sidebar-section="recent"] .sidebar-section-status');
  await expect(recentHeaderStatus.getByRole("status", { name: "Loading conversations..." })).toHaveCount(0);
  await expect(recentHeaderStatus.locator(".sidebar-section-count")).toHaveText("0");
  await expect(navigation.getByRole("status", { name: "Loading conversations..." }).first()).toBeVisible();
  await expect(navigation.locator('[data-sidebar-section="recent"] .sidebar-section-skeleton-row')).toHaveCount(2);
  expect((await (await threadListResponse).json()).threads[0].status).toBe("running");
  const recentRow = navigation.locator(".sidebar-recent-row-shell").first();
  await expect(recentRow).toBeVisible({ timeout: 4_000 });
  await expect(recentRow).toHaveAttribute("data-sidebar-row-status", "running");
  await expect(recentRow.locator('[data-sidebar-primary-status="running"]')).toHaveCount(1);
  await expect(recentRow.locator('[data-sidebar-primary-status="running"]')).toBeVisible();
  await expect(recentRow.getByRole("status", { name: "Running" })).toBeVisible();
  const recentButton = recentRow.getByRole("button", { name: "Open recent conversation 1" });
  await recentButton.click();
  await expect(recentButton).toHaveAttribute("aria-current", "page");
  await expect(navigation.getByRole("status", { name: "Loading conversations..." })).toHaveCount(0);
  await expect(recentRow.getByRole("status", { name: "Running" })).toBeVisible();
  await expect(recentRow.locator('[data-sidebar-primary-status="running"]')).toHaveCount(1);
  await expectNoHorizontalOverflow(navigation);
  await captureEvidence(page, "1280x800-ling-dark-recent-loading-busy.png");
  expect(runtimeErrors).toEqual([]);
});

test("Opening a failed recent conversation acknowledges only the current failure revision", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 1280, 800);
  const state = createBaseState({ approvalStatus: "expired" });
  const failedTitle = "Failed command conversation";
  state.threads = [
    {
      ...conversationThread(0),
      id: "thread_failed_attention",
      title: failedTitle,
      status: "failed",
      updatedAt: "2026-07-19T00:10:00.000Z",
      metadata: { lastActivityAt: "2026-07-19T00:10:00.000Z" },
    },
    {
      ...conversationThread(1),
      id: "thread_open_attention",
      title: "Healthy conversation",
      updatedAt: "2026-07-19T00:09:00.000Z",
      metadata: { lastActivityAt: "2026-07-19T00:09:00.000Z" },
    },
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  const failedRow = rowFor(navigation, failedTitle);
  await expectPrimaryStatus(navigation, failedTitle, "failed");
  await failedRow.getByRole("button", { name: "Open recent conversation 1" }).click();
  await expect(failedRow.getByRole("button", { name: "Open recent conversation 1" })).toHaveAttribute("aria-current", "page");
  await expect(failedRow.locator('[data-sidebar-primary-status="failed"]')).toHaveCount(0);
  expect(state.threads[0]!.status).toBe("failed");

  await page.reload();
  await expect(rowFor(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }), failedTitle).locator('[data-sidebar-primary-status="failed"]')).toHaveCount(0);

  state.threads[0] = {
    ...state.threads[0]!,
    updatedAt: "2026-07-19T00:11:00.000Z",
    metadata: { lastActivityAt: "2026-07-19T00:11:00.000Z" },
  };
  await page.reload();
  await expectPrimaryStatus(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }), failedTitle, "failed");
  expect(runtimeErrors).toEqual([]);
});

async function expectPrimaryStatus(navigation: Locator, name: string, status: string): Promise<void> {
  const row = rowFor(navigation, name);
  await expect(row.locator(`[data-sidebar-primary-status="${status}"]`)).toHaveCount(1);
  await expect(row.locator("[data-sidebar-primary-status]")).toHaveCount(1);
}

function rowFor(navigation: Locator, name: string): Locator {
  return navigation.locator(".sidebar-row-shell").filter({ hasText: name }).first();
}

function channel(id: string, name: string, status = "active"): Record<string, unknown> {
  return { id, workspaceId: "workspace_default", name, status, boundPath: cwd, autoReplyMode: "mentions_only",
    allowedTools: ["read"], runtimePolicy: defaultRuntimePolicy,
    createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z" };
}

function task(id: string, channelId: string, status: string, assigneeTeammateId?: string): Record<string, unknown> {
  return { id, workspaceId: "workspace_default", channelId, title: id, prompt: id, status,
    assigneeTeammateId, attachmentIds: [], createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:01:00.000Z" };
}

function run(id: string, taskId: string, status: string, owner: { channelId?: string; teammateId?: string; threadId?: string }): MockRun {
  return { id, taskId, status, ...owner, cwd, providerName: "local", providerModel: "gpt-test",
    taskSnapshot: {}, providerSnapshot: {}, requestSnapshot: {}, eventLogPath: `${id}.jsonl`,
    createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:01:00.000Z" };
}

function approval(id: string, taskId: string): Record<string, unknown> {
  return { id, taskId, actionType: "bash", risk: "medium", title: id, description: id, payload: {},
    status: "pending", createdAt: "2026-07-19T00:00:00.000Z", expiresAt: "2099-07-19T00:00:00.000Z" };
}

function conversationThread(index: number): Record<string, unknown> {
  const suffix = index + 1;
  return { id: `thread_sidebar_${suffix}`, workspaceId: "workspace_default", kind: "conversation",
    title: suffix === 1 ? "A very long recent conversation title that must remain inside the Sidebar row" : `Conversation ${suffix}`,
    objective: `Conversation ${suffix}`, status: "open", createdAt: `2026-07-19T00:0${index}:00.000Z`,
    updatedAt: `2026-07-19T00:0${index}:30.000Z`, metadata: { lastActivityAt: `2026-07-19T00:0${index}:30.000Z` } };
}

async function prepareSurface(page: Page, theme: "dark" | "light", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((value) => { localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", value); localStorage.setItem("ling-stack.themeBootstrapPreference", value); }, theme);
}

async function delayRoute(page: Page, pattern: RegExp, delayMs: number): Promise<void> {
  await page.route(pattern, async (route) => { await new Promise((resolve) => setTimeout(resolve, delayMs)); await route.fallback(); });
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  expect(await locator.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
