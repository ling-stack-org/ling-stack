import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate, cwd } from "./support/mock-state";
import { triggerFocusRevalidation } from "./support/focus-revalidation";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const evidenceDir = process.env.LING_P2_EVIDENCE_DIR ?? fileURLToPath(new URL("../../../.ling-stack/acceptance/p2-ux1-surfaces-20261014/", import.meta.url));

async function readAnchor(feed: Locator) {
  return feed.evaluate(element => {
    const viewport = element.getBoundingClientRect();
    const row = Array.from(element.querySelectorAll<HTMLElement>("[data-conversation-row-key]"))
      .find(row => row.getBoundingClientRect().bottom > viewport.top + 12
        && row.getBoundingClientRect().top < viewport.bottom - 12)!;
    return { key: row.dataset.conversationRowKey!, offset: row.getBoundingClientRect().top - viewport.top };
  });
}

async function anchorOffset(feed: Locator, key: string) {
  return feed.evaluate((element, key) => {
    const row = Array.from(element.querySelectorAll<HTMLElement>("[data-conversation-row-key]"))
      .find(row => row.dataset.conversationRowKey === key);
    return row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
  }, key);
}

async function settleScroll(feed: Locator) {
  await feed.evaluate(async element => {
    let previous = "";
    let stable = 0;
    for (let frame = 0; frame < 90; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const current = `${element.scrollTop}:${element.scrollHeight}`;
      stable = current === previous ? stable + 1 : 0;
      if (stable >= 6) return;
      previous = current;
    }
    throw new Error("Reading geometry did not settle");
  });
}

async function openPrivateFixture(page: Page, messageCount = 40) {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_p2_reader";
  state.providers = [createChatProvider({ id: "provider_p2_reader", model: "gpt-5.5" })];
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "P2 Reader", providerPresetId: "provider_p2_reader" })];
  state.teammateDirectMessages = Array.from({ length: messageCount }, (_, index) => ({
    id: `p2-private-${index}`, workspaceId: "workspace_default", teammateId,
    threadId: `tdthread_${teammateId}`, authorType: index % 2 ? "ai-teammate" : "local-user",
    authorId: index % 2 ? teammateId : "local-user",
    body: `Reading history ${index}\n\n${"Stable private reading without stealing position. ".repeat(15)}`,
    attachmentIds: [], linkPreviewIds: [], fileRefs: [], status: "ready",
    createdAt: new Date(Date.UTC(2026, 9, 14, 0, index)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 9, 14, 0, index)).toISOString(),
  }));
  state.runs = []; state.tasks = []; state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "P2 Reader", exact: true }).click();
  const feed = page.getByLabel("Private message feed", { exact: true });
  await expect(feed).toBeVisible();
  await expect(feed.getByText(new RegExp(`Reading history ${messageCount - 1}\\b`))).toBeAttached();
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
  await settleScroll(feed);
  return { feed, state };
}

test("private history reader keeps row offset when media above reflows", async ({ page }) => {
  const { feed } = await openPrivateFixture(page);
  await feed.evaluate(el => {
    el.style.overflowAnchor = "none";
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -240 }));
    el.scrollTop = el.scrollHeight / 2;
  });
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
  await settleScroll(feed);
  const before = await readAnchor(feed);
  await feed.evaluate(el => {
    const row = el.querySelector<HTMLElement>("[data-conversation-row-key]")!;
    row.style.paddingTop = "240px";
  });
  await expect.poll(async () => Math.abs(await anchorOffset(feed, before.key) - before.offset)).toBeLessThanOrEqual(2);
});

for (const fixture of [{ theme: "light", width: 1440, height: 960 }, { theme: "dark", width: 1280, height: 800 }] as const) {
  test(`private resize and return-to-latest preserve reading ownership ${fixture.theme}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    await page.setViewportSize(fixture);
    await page.addInitScript(theme => {
      const selection = JSON.stringify({ themeId: `ling-${theme}`, mode: "fixed" });
      localStorage.setItem("ling-stack.themeSelection", selection);
      localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
    }, fixture.theme);
    const { feed } = await openPrivateFixture(page);
    await feed.evaluate(el => { el.style.overflowAnchor = "none"; el.scrollTop = el.scrollHeight / 2; });
    await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
    await settleScroll(feed);
    const before = await readAnchor(feed);
    await page.setViewportSize({ width: fixture.width - 180, height: fixture.height });
    await expect.poll(async () => Math.abs(await anchorOffset(feed, before.key) - before.offset)).toBeLessThanOrEqual(2);
    await expect(page.locator("html")).toHaveAttribute("data-theme", fixture.theme);
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({ path: `${evidenceDir}private-${fixture.theme}-reading-resize.png`, animations: "disabled" });
    await page.getByRole("button", { name: "Jump to latest message" }).click();
    await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
    await expect(page.getByRole("button", { name: "Jump to latest message" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("private search stays paused through a refreshed reply and resumes explicitly", async ({ page }) => {
  const { feed, state } = await openPrivateFixture(page);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("textbox", { name: "Search private messages", exact: true }).fill("Reading history");
  await settleScroll(feed);
  const before = await readAnchor(feed);
  state.teammateDirectMessages[39] = { ...state.teammateDirectMessages[39] as Record<string, unknown>,
    body: "Reading history 39\n\n" + "New refreshed reply.\n\n".repeat(40), updatedAt: "2026-10-14T01:00:00.000Z" };
  await triggerFocusRevalidation(page);
  await expect(feed.getByText(/New refreshed reply/).first()).toBeAttached();
  await expect.poll(async () => Math.abs(await anchorOffset(feed, before.key) - before.offset)).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Jump to latest message" }).click();
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
});

test("private virtualized prepend retains the visible row instead of a height estimate", async ({ page }) => {
  const { feed } = await openPrivateFixture(page, 130);
  await expect(feed.locator("[data-conversation-timeline]")).toHaveClass(/virtualized/);
  let release!: () => void;
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  const responseReleased = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/teammates/teammate_p2_reader/direct-messages**", async route => {
    if (!new URL(route.request().url()).searchParams.has("beforeMessageId")) return route.fallback();
    started();
    await responseReleased;
    await route.fallback();
  });
  await feed.evaluate(el => {
    el.style.overflowAnchor = "none";
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -240 }));
    el.scrollTop = 60;
  });
  try {
    await requestStarted;
    await settleScroll(feed);
    const before = await readAnchor(feed);
    const heightBefore = await feed.evaluate(el => el.scrollHeight);
    release();
    await expect.poll(() => feed.evaluate(el => el.scrollHeight)).toBeGreaterThan(heightBefore);
    await expect.poll(async () => Math.abs(await anchorOffset(feed, before.key) - before.offset)).toBeLessThanOrEqual(2);
  } finally {
    release();
  }
});

async function openChannelFixture(page: Page, surface: "channel_root" | "branch") {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = []; state.runs = []; state.tasks = []; state.approvals = [];
  const workspaceId = "workspace_default", channelId = "channel_engineering", now = "2026-10-14T00:00:00.000Z";
  const rootId = "thread_channel_channel_engineering";
  const threadId = surface === "branch" ? "p2-reading-branch" : rootId;
  const rootThread = { id: rootId, workspaceId, channelId, kind: "channel_discussion" as const,
    title: "Engineering conversation", objective: "Read history", status: "open" as const,
    surfaceKind: "channel_root" as const, relationKind: "root" as const, createdAt: now, updatedAt: now };
  state.threads = [rootThread];
  const thread = surface === "branch" ? { ...rootThread, id: threadId, surfaceKind: "branch" as const,
    relationKind: "branch" as const, parentThreadId: rootId, title: "P2 Branch" } : rootThread;
  if (surface === "branch") {
    state.threads.push(thread);
    state.channelBranches = [{ id: "p2-branch", workspaceId, channelId, rootThreadId: threadId,
      name: "P2 Branch", status: "active", createdAt: now, updatedAt: now }];
  }
  const items = Array.from({ length: 40 }, (_, index) => ({
    schemaVersion: 1, workspaceId, channelId, threadId, turnId: `p2-turn-${index}`,
    id: `p2-channel-${index}`, sequence: index + 1, kind: "assistant_message",
    actorType: "teammate", actorId: "engineer", visibility: "channel", status: "committed", revision: 1,
    domainRefs: [], createdAt: now, updatedAt: now, committedAt: now,
    payload: { body: `Reading history ${index}\n\n${"Stable channel reading position. ".repeat(20)}`,
      format: "markdown", deliveryStatus: "ready", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }));
  await mockDaemon(page, state);
  await page.route("**/channels/channel_engineering/items**", async route => {
    const selected = new URL(route.request().url()).searchParams.get("threadId") ?? rootId;
    if (selected !== threadId) return route.fallback();
    await route.fulfill({ json: { cwd, channelId, thread, items, turns: [], turnContextAssignments: [],
      userInputs: [], decorations: [], generatedMedia: [], hasMore: false } });
  });
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display/ })
    .getByRole("button", { name: surface === "branch" ? "P2 Branch" : "Engineering", exact: true }).click();
  const feed = page.getByLabel("Channel message feed", { exact: true });
  await expect(feed.getByText(/Reading history 39\b/)).toBeAttached();
  await settleScroll(feed);
  return feed;
}

for (const surface of ["channel_root", "branch"] as const) {
  test(`${surface} reader retains row offset through content and viewport resize`, async ({ page }) => {
    const feed = await openChannelFixture(page, surface);
    await feed.evaluate(el => {
      el.style.overflowAnchor = "none";
      el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -240 }));
      el.scrollTop = el.scrollHeight / 2;
    });
    await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
    await settleScroll(feed);
    const before = await readAnchor(feed);
    await feed.evaluate(el => { el.querySelector<HTMLElement>("[data-conversation-row-key]")!.style.paddingTop = "240px"; });
    await expect.poll(async () => Math.abs(await anchorOffset(feed, before.key) - before.offset)).toBeLessThanOrEqual(2);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(async () => Math.abs(await anchorOffset(feed, before.key) - before.offset)).toBeLessThanOrEqual(2);
  });
}

test("topic reader follows the tail, preserves reading reflow, and resumes explicitly", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const rootId = "p2-topic-root", threadId = "p2-topic-thread", channelId = "channel_engineering";
  const now = "2026-10-14T00:00:00.000Z";
  state.runs = []; state.tasks = []; state.approvals = [];
  state.channelMessages = [{ id: rootId, workspaceId: "workspace_default", channelId, kind: "ai_reply",
    intent: "discuss", authorType: "ai-teammate", authorId: "engineer", body: "P2 topic reading root",
    mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [], status: "ready", createdAt: now, updatedAt: now }];
  const thread = { id: threadId, workspaceId: "workspace_default", channelId, kind: "channel_discussion",
    title: "P2 reading topic", objective: "Read topic", status: "open", surfaceKind: "topic", relationKind: "reply",
    anchorItemId: rootId, parentThreadId: "thread_channel_channel_engineering", createdAt: now, updatedAt: now };
  const items = Array.from({ length: 40 }, (_, index) => ({
    schemaVersion: 1, workspaceId: "workspace_default", channelId, threadId, turnId: `topic-turn-${index}`,
    id: `p2-topic-${index}`, sequence: index + 1, kind: "assistant_message", status: "committed",
    actorType: "teammate", actorId: "engineer", visibility: "channel", revision: 1, domainRefs: [],
    createdAt: now, updatedAt: now, committedAt: now,
    payload: { body: `Topic reading ${index}\n\n${"Keep the topic reading position. ".repeat(16)}`,
      format: "markdown", deliveryStatus: "ready", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }));
  await mockDaemon(page, state);
  await page.route("**/channels/channel_engineering/items**", async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("anchorItemId") !== rootId && url.searchParams.get("threadId") !== threadId) return route.fallback();
    await route.fulfill({ json: { cwd, channelId, thread, items, turns: [], userInputs: [],
      turnContextAssignments: [], decorations: [], generatedMedia: [], hasMore: false } });
  });
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Engineering", exact: true }).click();
  const root = page.getByLabel("Channel message feed").locator("[data-conversation-row-key]").filter({ hasText: "P2 topic reading root" });
  await root.hover();
  await root.getByRole("button", { name: "Reply in topic", exact: true }).click();
  const panel = page.getByLabel("Topic replies", { exact: true });
  const feed = panel.getByLabel("Replies", { exact: true });
  await expect(feed.getByText(/Topic reading 39\b/)).toBeAttached();
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
  await feed.evaluate(el => {
    el.style.overflowAnchor = "none";
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -240 }));
    el.scrollTop = el.scrollHeight / 2;
  });
  await settleScroll(feed);
  const before = await readAnchor(feed);
  await feed.evaluate(el => { el.querySelector<HTMLElement>("[data-conversation-row-key]")!.style.paddingTop = "240px"; });
  await expect.poll(async () => Math.abs(await anchorOffset(feed, before.key) - before.offset)).toBeLessThanOrEqual(2);
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}topic-reading-reflow.png`, animations: "disabled" });
  await panel.getByRole("button", { name: "Jump to latest message" }).click();
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
  await panel.getByRole("button", { name: "Close topic", exact: true }).click();
  await expect(panel).toHaveCount(0);
});
