import { expect, test, type Locator, type Page } from "@playwright/test";
import { cwd, mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate, isRecord } from "./support/mock-state";
import { createApproval } from "./support/approvals-fixture";

async function sessionAction(page: Page, scope: Locator, action: string): Promise<void> {
  await scope.hover();
  await scope.getByRole("button", { name: /^Conversation actions:/ }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${action}:`) }).click();
}

const composer = (scope: Page | Locator) => scope.getByRole("textbox", { name: "Message this channel or @ an AI teammate", exact: true });

test("channel sessions create only on send, isolate drafts and history, and retain identity through archive and restore", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, state);
  await page.goto("/");
  const nav = page.getByRole("complementary", { name: /Sidebar display/ });
  const group = nav.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  await group.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect(group.locator('[data-session-default="true"]')).toBeVisible();
  await group.locator('[data-session-default="true"]').hover();
  await group.locator('[data-session-default="true"]').getByRole("button", { name: /^Conversation actions:/ }).click();
  await expect(page.getByRole("menuitem", { name: /^Archive conversation:/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const initial = state.channelBranches.length;
  await group.getByRole("button", { name: "Engineering", exact: true }).hover();
  await group.getByRole("button", { name: "New conversation in Engineering", exact: true }).click();
  await page.getByRole("textbox", { name: "Conversation name (optional)", exact: true }).fill("Session A");
  await expect(group.locator("[data-session-draft]")).toContainText("Session A");
  await expect(group.locator("[data-session-draft]")).toContainText("Draft");
  await expect(group.getByRole("textbox")).toHaveCount(0);
  await composer(page).fill("A draft survives switching");
  expect(state.channelBranches).toHaveLength(initial);
  await group.locator('[data-session-default="true"] .sidebar-branch-row').click();
  await expect(composer(page)).toHaveText("");
  await group.getByRole("button", { name: "New conversation in Engineering", exact: true }).click();
  await expect(composer(page)).toContainText("A draft survives switching");
  await page.locator(".channel-composer").getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.channelBranches.length).toBe(initial + 1);
  const sessionA = state.channelBranches.find(branch => (branch as { name?: string }).name === "Session A") as { rootThreadId: string };
  await expect.poll(() => state.lastChannelTurnRequest?.surface).toEqual({ kind: "thread", threadId: sessionA.rootThreadId });
  await expect(group.locator(`[data-session-id="${sessionA.rootThreadId}"]`)).toBeVisible();
  await group.getByRole("button", { name: "New conversation in Engineering", exact: true }).click();
  await page.getByRole("textbox", { name: "Conversation name (optional)", exact: true }).fill("Session B");
  await composer(page).fill("B message is separate");
  await page.locator(".channel-composer").getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.channelBranches.length).toBe(initial + 2);
  const sessionB = state.channelBranches.find(branch => (branch as { name?: string }).name === "Session B") as { rootThreadId: string };
  await expect.poll(() => state.lastChannelTurnRequest?.surface).toEqual({ kind: "thread", threadId: sessionB.rootThreadId });
  await expect(page.getByLabel("Channel message feed", { exact: true })).not.toContainText("A draft survives switching");
  await group.locator(`[data-session-id="${sessionA.rootThreadId}"] .sidebar-branch-row`).click();
  await expect(page.getByLabel("Channel message feed", { exact: true })).toContainText("A draft survives switching");
  await expect(page.getByLabel("Channel message feed", { exact: true })).not.toContainText("B message is separate");
  const rowA = group.locator(`[data-session-id="${sessionA.rootThreadId}"]`);
  await sessionAction(page, rowA, "Rename conversation");
  await expect(rowA.getByRole("textbox", { name: "Conversation title" })).toBeFocused();
  await rowA.getByRole("textbox", { name: "Conversation title" }).fill("Renamed A");
  await rowA.getByRole("button", { name: "Save", exact: true }).click();
  await expect(rowA).toContainText("Renamed A");
  await sessionAction(page, rowA, "Archive conversation");
  await expect(rowA).toHaveCount(0);
  await group.getByRole("button", { name: "View all conversations" }).click();
  const dialog = page.getByRole("dialog", { name: "Engineering / Conversations" });
  await dialog.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(dialog).toContainText("Renamed A");
  await sessionAction(page, dialog.locator("[data-session-id]"), "Restore conversation");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(group.locator(`[data-session-id="${sessionA.rootThreadId}"]`)).toContainText("Renamed A");
  await group.locator(`[data-session-id="${sessionA.rootThreadId}"] .sidebar-branch-row`).click();
  await expect(page.getByLabel("Channel message feed", { exact: true })).toContainText("A draft survives switching");
  await sessionAction(page, group.locator(`[data-session-id="${sessionA.rootThreadId}"]`), "Archive conversation");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(group.locator(`[data-session-id="${sessionA.rootThreadId}"]`)).toBeVisible();
  await group.locator(`[data-session-id="${sessionA.rootThreadId}"]`).hover();
  await sessionAction(page, group.locator(`[data-session-id="${sessionA.rootThreadId}"]`), "Archive conversation");
  await group.getByRole("button", { name: "View all conversations" }).click();
  await dialog.getByRole("button", { name: "Archived", exact: true }).click();
  await dialog.getByRole("button", { name: "Renamed A", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Renamed A");
  await expect(composer(page)).toHaveCount(0);
  await expect(page.getByLabel("Channel message feed", { exact: true })).toContainText("A draft survives switching");
  await page.locator(".channel-session-archived-actions").getByRole("button", { name: "Restore conversation" }).click();
  await expect(composer(page)).toBeVisible();
  await expect(group.locator(`[data-session-id="${sessionA.rootThreadId}"] .sidebar-branch-row`)).toHaveAttribute("aria-current", "page");
  await page.screenshot({ path: "/tmp/ling-channel-sessions-acceptance.png", fullPage: true });
  await page.evaluate(() => {
    const selection = JSON.stringify({ mode: "fixed", themeId: "ling-dark" });
    localStorage.setItem("ling-stack.themeSelection", selection);
    localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
    localStorage.setItem("ling-stack.themePreference", "dark");
    localStorage.setItem("ling-stack.themeBootstrapPreference", "dark");
  });
  await page.reload();
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(31, 31, 31)");
  await group.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect(page.getByLabel("Channel message feed", { exact: true })).toContainText("A draft survives switching");
  await page.screenshot({ path: "/tmp/ling-channel-sessions-acceptance-dark.png", fullPage: true });
});

test("late streaming output from A cannot overwrite the B draft or transcript", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelAiReplyBody = "A completed isolated reply";
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const body = typeof args[1]?.body === "string" ? args[1].body : "";
      if (!String(args[0]).includes("/turns/stream") || !body.includes("A isolated streaming message")) return response;
      const chunks = (await response.text()).split("\n\n").filter(Boolean).map(chunk => `${chunk}\n\n`);
      const boundary = chunks.findIndex(chunk => chunk.startsWith("event: delta"));
      if (boundary < 0) throw new Error("Mock stream has no delta barrier");
      const encoder = new TextEncoder();
      const harness = window as unknown as { releaseSessionA?: () => void; sessionAReleased?: boolean };
      return new Response(new ReadableStream({
        start(controller) {
          for (const chunk of chunks.slice(0, boundary)) controller.enqueue(encoder.encode(chunk));
          harness.releaseSessionA = () => {
            for (const chunk of chunks.slice(boundary)) controller.enqueue(encoder.encode(chunk));
            controller.close(); harness.sessionAReleased = true;
          };
        },
      }), { headers: { "Content-Type": "text/event-stream" } });
    };
  });
  await mockDaemon(page, state);
  await page.goto("/");
  const group = page.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  await group.getByRole("button", { name: "Engineering", exact: true }).click();
  await group.getByRole("button", { name: "New conversation in Engineering", exact: true }).click();
  await page.getByRole("textbox", { name: "Conversation name (optional)", exact: true }).fill("Streaming A");
  await composer(page).fill("A isolated streaming message");
  await page.locator(".channel-composer").getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(() => typeof (window as unknown as { releaseSessionA?: unknown }).releaseSessionA === "function");
  const A = state.channelBranches.find(branch => (branch as { name?: string }).name === "Streaming A") as { rootThreadId: string };
  await group.getByRole("button", { name: "New conversation in Engineering", exact: true }).click();
  await composer(page).fill("B draft remains local");
  await page.evaluate(() => (window as unknown as { releaseSessionA: () => void }).releaseSessionA());
  await page.waitForFunction(() => (window as unknown as { sessionAReleased?: boolean }).sessionAReleased === true);
  await expect(composer(page)).toContainText("B draft remains local");
  await expect(page.getByLabel("Channel message feed", { exact: true })).not.toContainText("A isolated streaming message");
  await expect(page.getByLabel("Channel message feed", { exact: true })).not.toContainText("A completed isolated reply");
  await group.locator(`[data-session-id="${A.rootThreadId}"] .sidebar-branch-row`).click();
  await expect(page.getByLabel("Channel message feed", { exact: true })).toContainText("A isolated streaming message");
  await expect(page.getByLabel("Channel message feed", { exact: true })).toContainText("A completed isolated reply");
  await group.getByRole("button", { name: "New conversation in Engineering", exact: true }).click();
  await expect(composer(page)).toContainText("B draft remains local");
});

test("all-conversation title search can select and send to a session beyond the preview", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  let selectedSessionGets = 0;
  page.on("request", request => { if (request.method() === "GET" && new URL(request.url()).pathname.endsWith("/sessions/session-thread-12")) selectedSessionGets += 1; });
  state.channelBranches = Array.from({ length: 13 }, (_, index) => ({
    id: `session-directory-${index}`, workspaceId: "workspace_default", channelId: "channel_engineering",
    name: `Session ${index}`, rootThreadId: `session-thread-${index}`, status: "active",
    createdAt: "2026-05-25T00:00:00.000Z", updatedAt: "2026-05-25T00:00:00.000Z",
  }));
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, state);
  await page.goto("/");
  const group = page.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  await group.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect(group.locator("[data-session-id]")).toHaveCount(11);
  await group.getByRole("button", { name: "View all conversations" }).click();
  const dialog = page.getByRole("dialog", { name: "Engineering / Conversations" });
  await dialog.getByRole("textbox", { name: "Search conversations" }).fill("Session 12");
  await expect(dialog.locator("[data-session-id]")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Session 12", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Session 12");
  await expect(group.locator('[data-session-id="session-thread-12"] .sidebar-branch-row')).toHaveAttribute("aria-current", "page");
  await expect(group.locator("[data-session-id]").nth(1)).toHaveAttribute("data-session-id", "session-thread-12");
  await expect(group.locator("[data-session-id]")).toHaveCount(12);
  await expect.poll(() => selectedSessionGets).toBeGreaterThan(0);
  const initialSelectedSessionGets = selectedSessionGets;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => selectedSessionGets).toBeGreaterThan(initialSelectedSessionGets);
  await composer(page).fill("Send beyond the ten-session preview");
  await page.locator(".channel-composer").getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => state.lastChannelTurnRequest?.surface).toEqual({ kind: "thread", threadId: "session-thread-12" });
});

test("the directory retries failed pages, searches the default, and preserves keyboard navigation beyond fifty sessions", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelBranches = Array.from({ length: 60 }, (_, index) => ({
    id: `directory-${index}`, workspaceId: "workspace_default", channelId: "channel_engineering",
    name: `Directory ${index}`, rootThreadId: `directory-thread-${index}`, status: "active",
    createdAt: "2026-05-25T00:00:00.000Z", updatedAt: "2026-05-25T00:00:00.000Z",
  }));
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, state);
  let failFirst = true; let failMore = true;
  await page.route("**/channels/channel_engineering/sessions?**", async route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("limit") === "50" && !query.get("q") && (query.has("cursor") ? failMore : failFirst)) {
      if (query.has("cursor")) failMore = false; else failFirst = false;
      await route.fulfill({ status: 503, json: { error: "directory_temporarily_unavailable" } });
    } else await route.fallback();
  });
  await page.goto("/");
  const group = page.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  await group.getByRole("button", { name: "Engineering", exact: true }).click();
  const trigger = group.getByRole("button", { name: "View all conversations" });
  await trigger.focus(); await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Engineering / Conversations" });
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.locator("[data-session-id]")).toHaveCount(51);
  await dialog.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(dialog.locator("[data-session-id]")).toHaveCount(51);
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(dialog.locator("[data-session-id]")).toHaveCount(61);
  const search = dialog.getByRole("textbox", { name: "Search conversations" });
  await search.fill("Engineering conversation");
  await expect(dialog.locator("[data-session-default=true]")).toHaveCount(1);
  await expect(dialog.locator("[data-session-id]")).toHaveCount(1);
  await search.fill("Directory 59");
  const selected = dialog.getByRole("button", { name: "Directory 59", exact: true });
  await selected.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Directory 59");
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await trigger.click();
  await expect(search).toHaveValue("");
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

test("offline reconciliation and focus mark only the visible session read, with unread preserved after reload", async ({ page, context }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelBranches = ["A", "B"].map(name => ({
    id: `read-directory-${name}`, workspaceId: "workspace_default", channelId: "channel_engineering", name: `Read ${name}`,
    rootThreadId: `read-thread-${name}`, status: "active", createdAt: "2026-05-25T00:00:00.000Z", updatedAt: "2026-05-25T00:00:00.000Z",
  }));
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const harness = window as unknown as { testWindowFocused: boolean; testWindowVisible: boolean };
    harness.testWindowFocused = false; harness.testWindowVisible = true;
    Object.defineProperty(document, "hasFocus", { configurable: true, value: () => harness.testWindowFocused });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => harness.testWindowVisible ? "visible" : "hidden" });
  });
  await mockDaemon(page, state);
  let revision = 0; let reconciliations = 0;
  await page.route("**/channels/channel_engineering/sessions?**", async route => {
    reconciliations += 1;
    const session = (id: string, title: string, isDefault = false) => ({ id, title, isDefault, channelId: "channel_engineering",
      surfaceKind: isDefault ? "channel_root" : "channel_session", createdAt: "2026-05-25T00:00:00.000Z", activityAt: "2026-05-25T00:00:00.000Z",
      latestNotificationRevision: isDefault ? 0 : revision, pendingApprovalCount: 0, pendingApprovalIds: [], activeRunIds: [], runtimeState: "idle" });
    const sessions = [session("read-thread-A", "Read A"), session("read-thread-B", "Read B")];
    const defaultSession = session("thread_channel_channel_engineering", "Engineering conversation", true);
    await route.fulfill({ json: { cwd, channelId: "channel_engineering", defaultSession, sessions, diagnostics: [],
      notificationWatermarks: [defaultSession, ...sessions].map(({ id, latestNotificationRevision }) => ({ id, latestNotificationRevision })),
      aggregate: { pendingApprovalCount: 0, runningCount: 0, waitingCount: 0, failedCount: 0 } } });
  });
  await page.goto("/");
  const group = page.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  await group.getByRole("button", { name: "Engineering", exact: true }).click();
  const A = group.locator('[data-session-id="read-thread-A"]');
  const B = group.locator('[data-session-id="read-thread-B"]');
  await A.locator(".sidebar-branch-row").click();
  await context.setOffline(true); revision = 1;
  const beforeReconnect = reconciliations;
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => reconciliations).toBeGreaterThan(beforeReconnect);
  await expect(A.getByLabel("Unread", { exact: true })).toHaveCount(1);
  await expect(B.getByLabel("Unread", { exact: true })).toHaveCount(1);
  await page.evaluate(() => {
    const harness = window as unknown as { testWindowFocused: boolean; testWindowVisible: boolean };
    harness.testWindowFocused = true; harness.testWindowVisible = false;
    document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus"));
  });
  await expect(A.getByLabel("Unread", { exact: true })).toHaveCount(1);
  await page.evaluate(() => {
    (window as unknown as { testWindowVisible: boolean }).testWindowVisible = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(A.getByLabel("Unread", { exact: true })).toHaveCount(0);
  await expect(B.getByLabel("Unread", { exact: true })).toHaveCount(1);
  await page.reload();
  await group.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect(A.locator(".sidebar-branch-row")).toHaveAttribute("aria-current", "page");
  await expect(B.getByLabel("Unread", { exact: true })).toHaveCount(1);
});

test("full access belongs to one draft and its created thread; cancelling another draft preserves it without creating a session", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "sessions-provider", lastCheck: { ok: true, code: "ready", message: "ready", checkedAt: "2026-10-29T00:00:00.000Z" } })];
  state.channels = state.channels.map(channel => isRecord(channel) ? { ...channel, defaultProviderPresetId: "sessions-provider" } : channel);
  Object.assign(state.workspaceSettings, { defaultAuthorizationMode: "always", defaultWorkspaceAccessMode: "full_access", defaultPermissionMode: "full_access", defaultPermissionPreset: "full_access" });
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, state); await page.goto("/");
  const group = page.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  await group.getByRole("button", { name: "Engineering", exact: true }).click();
  const initial = state.channelBranches.length;
  const dialog = page.getByRole("dialog", { name: "Confirm full access" });
  const send = page.getByLabel("Channel composer", { exact: true }).getByRole("button", { name: "Send", exact: true });
  const permission = page.getByLabel("Channel composer", { exact: true }).getByRole("button", { name: /Selected permission preset/ });
  await group.getByRole("button", { name: "New conversation in Engineering", exact: true }).click();
  await page.getByRole("textbox", { name: "Conversation name (optional)", exact: true }).fill("Access A");
  await composer(page).fill("A first confirmed message"); await send.click();
  await expect(dialog).toBeVisible(); expect(state.channelBranches).toHaveLength(initial);
  await dialog.getByRole("button", { name: "Start with full access" }).click();
  await expect.poll(() => state.channelBranches.length).toBe(initial + 1);
  await expect(page.getByLabel("Channel message feed", { exact: true })).toContainText("A first confirmed message");
  await expect(dialog).toHaveCount(0);
  await expect(permission).toContainText("Confirmed for this conversation");
  const sessionA = state.channelBranches.find(branch => (branch as { name?: string }).name === "Access A") as { rootThreadId: string };
  const A = { kind: "thread", threadId: sessionA.rootThreadId };
  await expect.poll(() => state.lastChannelTurnRequest?.surface).toEqual(A);
  await composer(page).fill("A second message reuses its grant"); await send.click();
  await expect(page.getByLabel("Channel message feed", { exact: true })).toContainText("A second message reuses its grant");
  await expect(dialog).toHaveCount(0); expect(state.lastChannelTurnRequest?.surface).toEqual(A);
  await group.getByRole("button", { name: "New conversation in Engineering", exact: true }).click();
  await page.getByRole("textbox", { name: "Conversation name (optional)", exact: true }).fill("Access B");
  await expect(permission).not.toContainText("Confirmed for this conversation");
  await composer(page).fill("B draft survives confirmation cancellation"); await send.click();
  await expect(dialog).toBeVisible(); expect(state.channelBranches).toHaveLength(initial + 1);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).last().click();
  await expect(composer(page)).toContainText("B draft survives confirmation cancellation");
  expect(state.channelBranches).toHaveLength(initial + 1); expect(state.lastChannelTurnRequest?.surface).toEqual(A);
  await send.click(); await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Start with full access" }).click();
  await expect.poll(() => state.channelBranches.length).toBe(initial + 2);
  await expect(page.getByLabel("Channel message feed", { exact: true })).toContainText("B draft survives confirmation cancellation");
  await expect(dialog).toHaveCount(0);
  const sessionB = state.channelBranches.find(branch => (branch as { name?: string }).name === "Access B") as { rootThreadId: string };
  expect(sessionB.rootThreadId).not.toBe(sessionA.rootThreadId);
  await expect.poll(() => state.lastChannelTurnRequest?.surface).toEqual({ kind: "thread", threadId: sessionB.rootThreadId });
});

test("lost creation response and rejected first send retain the same draft and do not duplicate the session", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const creationKeys: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/sessions")) creationKeys.push(request.postDataJSON().idempotencyKey);
  });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const originalFetch = window.fetch.bind(window); let loseCreation = true; let rejectSend = true;
    window.fetch = async (...args) => {
      const path = new URL(String(args[0]), location.href).pathname;
      if (args[1]?.method === "POST" && path.endsWith("/turns/stream") && rejectSend) {
        rejectSend = false;
        return new Response(JSON.stringify({ error: "invalid_request", message: "Controlled first-send rejection" }), { status: 400, headers: { "Content-Type": "application/json" } });
      }
      const response = await originalFetch(...args);
      if (args[1]?.method === "POST" && path.endsWith("/sessions") && loseCreation) {
        loseCreation = false; await response.text(); throw new TypeError("Controlled creation response loss");
      }
      return response;
    };
  });
  await mockDaemon(page, state);
  await page.route(url => url.pathname === "/conversation-submissions", route => {
    const url = new URL(route.request().url());
    return route.fulfill({ json: { status: "unknown", cwd: url.searchParams.get("cwd"), idempotencyKey: url.searchParams.get("idempotencyKey") } });
  });
  await page.goto("/");
  const group = page.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  await group.getByRole("button", { name: "Engineering", exact: true }).click();
  const initial = state.channelBranches.length;
  await group.getByRole("button", { name: "New conversation in Engineering", exact: true }).click();
  await page.getByRole("textbox", { name: "Conversation name (optional)", exact: true }).fill("Retry same creation");
  await composer(page).fill("Retained original first message");
  const send = page.getByLabel("Channel composer", { exact: true }).getByRole("button", { name: "Send", exact: true });
  await send.click();
  await expect(page.getByLabel("Channel composer", { exact: true })).toContainText("Controlled creation response loss");
  await expect(page.getByText("Conversation creation is unconfirmed. Send again to check using the same request.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Conversation name (optional)" })).toBeDisabled();
  await expect(composer(page)).toContainText("Retained original first message");
  expect(state.channelBranches).toHaveLength(initial + 1);
  await group.locator('[data-session-default="true"] .sidebar-branch-row').click();
  await group.getByRole("button", { name: "New conversation in Engineering", exact: true }).click();
  await expect(composer(page)).toContainText("Retained original first message");
  await send.click();
  await expect(page.getByLabel("Channel composer", { exact: true })).toContainText("Controlled first-send rejection");
  await expect(composer(page)).toContainText("Retained original first message");
  expect(creationKeys).toHaveLength(2); expect(creationKeys[1]).toBe(creationKeys[0]);
  expect(state.channelBranches).toHaveLength(initial + 1);
  await send.click();
  await expect(page.getByLabel("Channel message feed", { exact: true })).toContainText("Retained original first message");
  expect(state.channelBranches).toHaveLength(initial + 1); expect(creationKeys).toHaveLength(2);
});

test("B approval and Stop controls target B durable IDs while A continues in a separate work thread", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const now = "2026-10-29T00:00:00.000Z";
  const template = state.runs[0];
  state.channelBranches = ["A", "B"].map(id => ({ id: `directory-${id}`, workspaceId: "workspace_default", channelId: "channel_engineering", name: `Work ${id}`, rootThreadId: `session-${id}`, status: "active", createdAt: now, updatedAt: now }));
  state.threads.push(...["default", "A", "B"].map(id => ({ id: id === "default" ? "thread_channel_channel_engineering" : `session-${id}`, workspaceId: "workspace_default", kind: "channel_discussion" as const, channelId: "channel_engineering", title: id === "default" ? "Default conversation" : `Work ${id}`, objective: "Session ownership fixture", status: "open" as const, conversationMode: { mode: "default" as const }, surfaceKind: id === "default" ? "channel_root" as const : "channel_session" as const, relationKind: "root" as const, nextItemSequence: 1, createdAt: now, updatedAt: now })));
  state.runs = ["A", "B"].map(id => ({ ...template, id: `run-${id}`, channelId: "channel_engineering", threadId: `physical-work-${id}`, workUnitId: `work-${id}`, status: "running", endedAt: undefined, requestSnapshot: { sourceMessageId: `unloaded-source-${id}` } }));
  state.workUnits = ["A", "B"].map(id => ({ id: `work-${id}`, workspaceId: "workspace_default", kind: "channel_ai_reply", ownerType: "channel", ownerId: "channel_engineering", channelId: "channel_engineering", idempotencyKey: `work-${id}`, status: "running", priority: 50, attemptCount: 1, activeAttemptId: `attempt-${id}`, createdByActor: "user", request: { sourceMessageId: `unloaded-source-${id}` }, timeoutPolicy: { staleAfterMs: 120000, timeoutAfterMs: 300000 }, linkedRunId: `run-${id}`, createdAt: now, updatedAt: now, startedAt: now }));
  state.approvals = ["A", "B"].map(id => createApproval({ id: `approval-${id}`, runId: `run-${id}`, channelId: "channel_engineering", actionType: "bash", title: `Review only ${id}`, payload: { type: "bash", command: `echo ${id}` }, availableDecisions: ["approve_once", "deny"] }));
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, state);
  await page.route(url => /\/channels\/channel_engineering\/sessions(?:\/[^/]+)?$/.test(url.pathname), async route => {
    if (route.request().method() !== "GET") return route.fallback();
    const summaries = ["A", "B"].map(id => {
      const activeRunIds = state.runs.filter(run => run.id === `run-${id}` && run.status === "running").map(run => run.id);
      const pendingApprovalIds = state.approvals.filter(approval => approval.id === `approval-${id}` && approval.status === "pending").map(approval => approval.id);
      return { id: `session-${id}`, channelId: "channel_engineering", legacyBranchId: `directory-${id}`, title: `Work ${id}`, isDefault: false, surfaceKind: "channel_session", createdAt: now, activityAt: now, latestNotificationRevision: 0, pendingApprovalCount: pendingApprovalIds.length, activeRunIds, pendingApprovalIds, runtimeState: pendingApprovalIds.length ? "waiting" : activeRunIds.length ? "running" : "idle" };
    });
    const defaultSession = { ...summaries[0], id: "thread_channel_channel_engineering", title: "Default conversation", isDefault: true, surfaceKind: "channel_root", activeRunIds: [], pendingApprovalIds: [], pendingApprovalCount: 0, runtimeState: "idle" };
    const sessionId = new URL(route.request().url()).pathname.split("/sessions/")[1];
    if (sessionId) return route.fulfill({ json: { session: [...summaries, defaultSession].find(session => session.id === sessionId) } });
    return route.fulfill({ json: { cwd, channelId: "channel_engineering", defaultSession, sessions: summaries, diagnostics: [], notificationWatermarks: [...summaries, defaultSession].map(({ id, latestNotificationRevision }) => ({ id, latestNotificationRevision })), aggregate: { pendingApprovalCount: summaries.reduce((count, session) => count + session.pendingApprovalCount, 0), runningCount: 2, waitingCount: 2, failedCount: 0 } } });
  });
  const cancellations: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && /\/(?:runs|work-units)\/[^/]+\/cancel$/.test(new URL(request.url()).pathname)) cancellations.push(new URL(request.url()).pathname); });
  await page.goto("/");
  const group = page.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  await group.getByRole("button", { name: "Engineering", exact: true }).click();
  await group.locator('[data-session-id="session-B"] .sidebar-branch-row').click();
  const gate = page.getByRole("region", { name: "Allow this action?", exact: true });
  await expect(gate).toHaveAttribute("data-runtime-approval-id", "approval-B");
  await expect(gate).toContainText("echo B"); await expect(gate).not.toContainText("echo A");
  await gate.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect.poll(() => state.approvalDecisionRequests.map(request => request.approvalId)).toEqual(["approval-B"]);
  await expect(gate).toHaveCount(0);
  await page.getByLabel("Channel composer", { exact: true }).getByRole("button", { name: "Stop reply", exact: true }).click();
  await expect.poll(() => cancellations).toEqual(["/work-units/work-B/cancel"]);
  expect(state.runs.find(run => run.id === "run-A")?.status).toBe("running");
  expect(state.approvals.find(approval => approval.id === "approval-A")?.status).toBe("pending");
  await group.locator('[data-session-id="session-A"] .sidebar-branch-row').click();
  await expect(gate).toHaveAttribute("data-runtime-approval-id", "approval-A");
});

test("session header menus, long draft names and zoom retain usable controls", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, state); await page.goto("/");
  const group = page.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  await group.getByRole("button", { name: "Engineering", exact: true }).click();
  await group.getByRole("button", { name: "New conversation in Engineering", exact: true }).click();
  const name = page.getByRole("textbox", { name: "Conversation name (optional)", exact: true });
  const send = page.getByLabel("Channel composer", { exact: true }).getByRole("button", { name: "Send", exact: true });
  await name.fill("字".repeat(121)); await composer(page).fill("Independent conversation");
  await expect(name).toHaveAttribute("aria-invalid", "true"); await expect(send).toBeDisabled();
  const longTitle = "频道中的长会话名称".repeat(12);
  await name.fill(longTitle);
  await expect(name).not.toHaveAttribute("aria-invalid", "true");
  await expect(group.locator("[data-session-draft]")).toContainText(longTitle);
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  await expect(name).toBeVisible();
  await page.screenshot({ path: "/tmp/ling-channel-sessions-draft-zoom.png", fullPage: true });
  await page.evaluate(() => { document.documentElement.style.zoom = ""; });
  await send.click(); await expect(page.getByRole("heading", { level: 1 })).toHaveAttribute("title", `Engineering / ${longTitle}`);
  const heading = page.locator(".channel-session-heading");
  await heading.getByRole("button", { name: `Conversation actions: ${longTitle}`, exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: `Rename conversation: ${longTitle}`, exact: true }).click();
  const rename = heading.getByRole("textbox", { name: "Conversation title", exact: true });
  await expect(rename).toBeFocused(); await rename.fill("Header renamed"); await rename.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Header renamed");
  await expect(group.locator("[data-session-id]").filter({ hasText: "Header renamed" })).toHaveCount(1);
  let rejectArchive = true;
  await page.route("**/channels/channel_engineering/sessions/*", async route => {
    if (rejectArchive && route.request().method() === "PATCH" && route.request().postDataJSON().archived === true) {
      rejectArchive = false;
      return route.fulfill({ status: 409, json: { error: "session_busy", message: "Conversation still has active work" } });
    }
    await route.fallback();
  });
  await sessionAction(page, heading, "Archive conversation");
  await expect(page.getByRole("region", { name: "Notifications" })).toContainText("Header renamed: Conversation still has active work");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Header renamed");
  await sessionAction(page, heading, "Archive conversation");
  await expect(page.getByRole("heading", { level: 1 })).not.toContainText("Header renamed");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(group.locator("[data-session-id]").filter({ hasText: "Header renamed" })).toBeVisible();
  const channelMenu = group.getByRole("button", { name: "Channel actions: Engineering", exact: true });
  await channelMenu.click();
  await page.getByRole("menuitem", { name: "Channel settings", exact: true }).click();
  await expect(page.locator(".channel-settings-header-title")).toContainText("Channel settings");
  await page.getByRole("button", { name: "Back to channel", exact: true }).click();
  await channelMenu.click();
  await page.getByRole("menuitem", { name: "Rename channel", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Rename channel", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("directory diagnostics are collapsed and do not prevent healthy conversation access", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, state);
  await page.route("**/channels/channel_engineering/sessions?**", async route => {
    const defaultSession = { id: "thread_channel_channel_engineering", title: "Engineering conversation", channelId: "channel_engineering",
      isDefault: true, surfaceKind: "channel_root", createdAt: "2026-05-25T00:00:00.000Z", activityAt: "2026-05-25T00:00:00.000Z",
      latestNotificationRevision: 0, pendingApprovalCount: 0, pendingApprovalIds: [], activeRunIds: [], runtimeState: "idle" };
    await route.fulfill({ json: { cwd, channelId: "channel_engineering", defaultSession, sessions: [],
      diagnostics: [{ branchId: "historical-ambiguous", code: "ambiguous_thread" }], notificationWatermarks: [{ id: defaultSession.id, latestNotificationRevision: 0 }],
      aggregate: { pendingApprovalCount: 0, runningCount: 0, waitingCount: 0, failedCount: 0 } } });
  });
  await page.goto("/");
  const group = page.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  await group.getByRole("button", { name: "Engineering", exact: true }).click();
  const details = group.locator("details");
  await expect(details).not.toHaveAttribute("open", "");
  await expect(details.getByText("historical-ambiguous", { exact: true })).not.toBeVisible();
  await details.locator("summary").click();
  await expect(details).toContainText("historical-ambiguous");
  await group.locator('[data-session-default="true"] .sidebar-branch-row').click();
  await expect(composer(page)).toBeVisible();
});

function proposalSessionState() {
  const state = createBaseState({ approvalStatus: "expired" });
  const now = "2026-10-29T00:00:00.000Z";
  state.aiTeammates = [createMockTeammate({ id: "ling_agent", displayName: "Ling Agent" })];
  state.channelBranches = ["A", "B"].map(id => ({ id: `proposal-directory-${id}`, workspaceId: "workspace_default", channelId: "channel_engineering", name: `Proposal ${id}`, rootThreadId: `proposal-session-${id}`, status: "active", createdAt: now, updatedAt: now }));
  state.channelMessages = ["A", "B"].map(id => ({ id: `proposal-source-${id}`, workspaceId: "workspace_default", channelId: "channel_engineering", threadId: `proposal-session-${id}`, kind: "message", intent: "discuss", authorType: "local-user", authorId: "tian", body: `Only conversation ${id} owns this source`, mentions: [], attachmentIds: [], linkPreviewIds: [], status: "ready", createdAt: now, updatedAt: now }));
  const proposal = (id: string, sourceMessageId = "proposal-source-A", createdAt = now) => ({ id, workspaceId: "workspace_default", channelId: "channel_engineering", sourceMessageId, proposedByTeammateId: "ling_agent", title: id, prompt: `Review ${id}`, assigneeTeammateId: "ling_agent", acceptanceCriteria: ["Only the owning conversation can decide."], collaborationSteps: [{ teammateId: "ling_agent", action: "coordinated", summary: "Review the owning source." }], requiredTools: ["read"], status: "draft", createdAt, updatedAt: createdAt });
  return { state, proposal };
}

for (const decision of ["Allow", "Deny"] as const) {
  test(`proposal gate stays with A through B and a new draft, then ${decision} targets A`, async ({ page }) => {
    const { state, proposal } = proposalSessionState();
    state.channelExecutionProposals = [proposal("proposal-A-old"), proposal("proposal-A-new", "proposal-source-A", "2026-10-29T00:00:01.000Z")];
    await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
    await mockDaemon(page, state); await page.goto("/");
    const group = page.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
    await group.getByRole("button", { name: "Engineering", exact: true }).click();
    await group.locator('[data-session-id="proposal-session-A"] .sidebar-branch-row').click();
    const gate = page.locator('[data-conversation-decision-kind="task_proposal"]');
    await expect(gate).toHaveAttribute("data-channel-execution-proposal-id", "proposal-A-new");
    await page.getByLabel("Task proposal summary").filter({ hasText: "proposal-A-old" }).getByRole("button", { name: "View task", exact: true }).click();
    await expect(gate).toHaveAttribute("data-channel-execution-proposal-id", "proposal-A-old");
    await group.locator('[data-session-id="proposal-session-B"] .sidebar-branch-row').click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Proposal B");
    await expect(gate).toHaveCount(0); await expect(composer(page)).toBeVisible();
    await composer(page).fill("B keeps its own draft");
    await group.getByRole("button", { name: "New conversation in Engineering", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Conversation name (optional)", exact: true })).toBeVisible();
    await expect(gate).toHaveCount(0); await expect(composer(page)).toBeVisible();
    await composer(page).fill("A new draft is independent");
    await group.locator('[data-session-id="proposal-session-A"] .sidebar-branch-row').click();
    await expect(gate).toHaveAttribute("data-channel-execution-proposal-id", "proposal-A-new");
    await gate.getByRole("button", { name: decision, exact: true }).click();
    await expect.poll(() => state.channelExecutionProposals.find(item => isRecord(item) && item.id === "proposal-A-new")).toMatchObject({ status: decision === "Allow" ? "accepted" : "cancelled" });
    expect(state.channelExecutionProposals.find(item => isRecord(item) && item.id === "proposal-A-old")).toMatchObject({ status: "draft" });
    if (decision === "Allow") expect(state.channelWorkflows[0]).toMatchObject({ metadata: { sourceProposalId: "proposal-A-new", sourceMessageId: "proposal-source-A" } });
    else expect(state.channelWorkflows).toHaveLength(0);
    await group.locator('[data-session-id="proposal-session-B"] .sidebar-branch-row').click();
    await expect(composer(page)).toContainText("B keeps its own draft");
    await expect(gate).toHaveCount(0);
    await group.getByRole("button", { name: "New conversation in Engineering", exact: true }).click();
    await expect(composer(page)).toContainText("A new draft is independent");
    await expect(gate).toHaveCount(0);
  });
}

test("proposal gate fails closed when its source is not loaded in the canonical conversation", async ({ page }) => {
  const { state, proposal } = proposalSessionState();
  state.channelExecutionProposals = [proposal("proposal-unloaded", "source-not-loaded")];
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, state); await page.goto("/");
  const group = page.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  await group.getByRole("button", { name: "Engineering", exact: true }).click();
  await group.locator('[data-session-id="proposal-session-A"] .sidebar-branch-row').click();
  await expect(page.getByLabel("Channel message feed", { exact: true })).toContainText("Only conversation A owns this source");
  await expect(page.locator('[data-conversation-decision-kind="task_proposal"]')).toHaveCount(0);
  await expect(composer(page)).toBeVisible();
  expect(state.channelExecutionProposals[0]).toMatchObject({ status: "draft" });
});

test("an archived owning conversation shows history without an executable proposal gate", async ({ page }) => {
  const { state, proposal } = proposalSessionState();
  Object.assign(state.channelBranches[0] as object, { status: "archived", archivedAt: "2026-10-29T00:01:00.000Z" });
  state.channelExecutionProposals = [proposal("proposal-archived-A")];
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, state); await page.goto("/");
  const group = page.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  await group.getByRole("button", { name: "Engineering", exact: true }).click();
  await group.getByRole("button", { name: "View all conversations", exact: true }).click();
  const directory = page.getByRole("dialog", { name: "Engineering / Conversations", exact: true });
  await directory.getByRole("button", { name: "Archived", exact: true }).click();
  await directory.getByRole("button", { name: "Proposal A", exact: true }).click();
  await expect(page.getByLabel("Channel message feed", { exact: true })).toContainText("Only conversation A owns this source");
  await expect(page.locator(".channel-session-archived-actions")).toContainText("Archived");
  await expect(page.locator('[data-conversation-decision-kind="task_proposal"]')).toHaveCount(0);
  await page.getByLabel("Task proposal summary").getByRole("button", { name: "View task", exact: true }).click();
  await expect(page.locator('[data-conversation-decision-kind="task_proposal"]')).toHaveCount(0);
  await expect(composer(page)).toHaveCount(0);
  expect(state.channelExecutionProposals[0]).toMatchObject({ status: "draft" });
});

test("a collapsed channel distinguishes generic waiting from pending approvals in visible and accessible text", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  let pendingApprovalCount = 0;
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, state);
  await page.route("**/channels/channel_engineering/sessions?**", async route => {
    const defaultSession = { id: "thread_channel_channel_engineering", title: "Engineering conversation", channelId: "channel_engineering", isDefault: true, surfaceKind: "channel_root", createdAt: "2026-10-29T00:00:00.000Z", activityAt: "2026-10-29T00:00:00.000Z", latestNotificationRevision: 0, pendingApprovalCount, pendingApprovalIds: [], activeRunIds: [], runtimeState: "waiting" };
    await route.fulfill({ json: { cwd, channelId: "channel_engineering", defaultSession, sessions: [], diagnostics: [], notificationWatermarks: [{ id: defaultSession.id, latestNotificationRevision: 0 }], aggregate: { pendingApprovalCount, runningCount: 0, waitingCount: 1, failedCount: 0 } } });
  });
  await page.goto("/");
  const group = page.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  await group.getByRole("button", { name: "Engineering", exact: true }).click();
  await group.getByRole("button", { name: "Collapse conversations: Engineering", exact: true }).click();
  const status = group.locator('.sidebar-channel-container-row [data-sidebar-primary-status="waiting"]');
  await expect(status).toHaveText("Waiting");
  await expect(status).toHaveAccessibleName("Waiting");
  await expect(group).not.toContainText("Waiting for approval");
  pendingApprovalCount = 2;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(status).toHaveText("Waiting for approval");
  await expect(status).toHaveAccessibleName("2 pending approvals");
});

for (const theme of ["light", "dark"] as const) {
  test(`conversation directory selection and unread use shared semantic colors in ${theme} theme`, async ({ page }) => {
    const { state } = proposalSessionState();
    state.channelMessages.push({ id: "unread-B", workspaceId: "workspace_default", channelId: "channel_engineering", threadId: "proposal-session-B", sourceItemId: "proposal-source-B", kind: "ai_reply", intent: "discuss", authorType: "ai-teammate", authorId: "ling_agent", body: "Unread B reply", mentions: [], attachmentIds: [], linkPreviewIds: [], status: "ready", createdAt: "2026-10-29T00:00:01.000Z", updatedAt: "2026-10-29T00:00:01.000Z" });
    await page.addInitScript(({ cwd, theme }) => {
      localStorage.setItem("ling-stack.locale", "en-US");
      const selection = JSON.stringify({ mode: "fixed", themeId: `ling-${theme}` });
      localStorage.setItem("ling-stack.themeSelection", selection); localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
      localStorage.setItem("ling-stack.themePreference", theme); localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
      localStorage.setItem(`ling:channel-sessions:v1:${cwd}:read`, JSON.stringify({ "channel-baseline:channel_engineering": 1, "proposal-session-B": 0 }));
    }, { cwd, theme });
    await mockDaemon(page, state); await page.goto("/");
    const group = page.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
    await group.getByRole("button", { name: "Engineering", exact: true }).click();
    await group.locator('[data-session-id="proposal-session-A"] .sidebar-branch-row').click();
    await group.getByRole("button", { name: "View all conversations", exact: true }).click();
    const directory = page.getByRole("dialog", { name: "Engineering / Conversations", exact: true });
    const selected = directory.locator('[data-session-id="proposal-session-A"]');
    await expect(selected).toHaveClass(/selected/);
    const semanticColor = async (token: string) => selected.evaluate((element, token) => {
      const probe = document.createElement("span"); probe.style.backgroundColor = `var(${token})`; element.append(probe);
      const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color;
    }, token);
    const selectedColor = await semanticColor("--ling-navigation-selected-bg");
    expect(selectedColor).not.toBe("rgba(0, 0, 0, 0)");
    await expect(selected).toHaveCSS("background-color", selectedColor);
    const unread = directory.locator('[data-session-id="proposal-session-B"] .sidebar-session-unread');
    await expect(unread).toBeVisible();
    await expect(unread).toHaveCSS("background-color", await semanticColor("--ling-action-accent"));
    await expect(directory).toBeVisible();
    await expect(directory).toHaveCSS("opacity", "1");
    await expect(selected).toBeVisible();
    await page.screenshot({ path: `/tmp/ling-channel-sessions-p5-web-directory-${theme}.png`, fullPage: true, animations: "disabled" });
  });
}
