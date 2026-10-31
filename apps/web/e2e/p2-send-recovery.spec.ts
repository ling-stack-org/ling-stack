import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate } from "./support/mock-state";

const evidenceDir = process.env.LING_P2_EVIDENCE_DIR ?? fileURLToPath(new URL("../../../.ling-stack/acceptance/p2-ux1-surfaces-20261014/", import.meta.url));
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
});
test.afterEach(async ({ page }) => { expect(browserErrors.get(page)).toEqual([]); });

async function interruptAfterAcceptance(page: Page, hold = false) {
    await page.addInitScript(({ hold }) => {
      localStorage.setItem("ling-stack.locale", "en-US");
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const url = String(args[0]);
        if (!/\/(conversations|direct-messages|turns)\/stream(?:\?|$)/.test(url)) return response;
        const blocks = (await response.text()).split("\n\n");
        const ready = blocks.find(block => block.startsWith("event: ready\n"));
        if (!ready) throw new Error("The recovery fixture did not accept a message");
        let delivered = false;
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (delivered) {
              if (hold) await new Promise<void>(resolve => window.addEventListener("p2-release-response", () => resolve(), { once: true }));
              controller.error(new TypeError("Controlled response loss after acceptance"));
            }
            else { delivered = true; controller.enqueue(new TextEncoder().encode(ready + "\n\n")); }
          },
        }, { highWaterMark: 0 }), { status: response.status, headers: response.headers });
      };
    }, { hold });
}

function recoveryState() {
    const state = createBaseState({ approvalStatus: "expired" });
    state.runs = []; state.tasks = []; state.approvals = []; state.channelMessages = [];
    state.teammateDirectMessages = [];
    state.threads = []; state.turns = [];
    const providerId = "p2-recovery-provider";
    state.providers = [createChatProvider({ id: providerId, model: "gpt-5.5", lastCheck: {
      ok: true, checkedAt: "2026-10-14T00:00:00.000Z", summary: "Controlled model fixture",
    } })];
    state.channels = state.channels.map(channel => ({ ...channel, defaultProviderPresetId: providerId, defaultTeammateId: "ling_agent", autoReplyMode: "default_teammate" }));
    state.channelAiReplyBody = "P2 recovered channel reply";
    state.aiTeammates = [createMockTeammate({ id: "p2-recovery-teammate", displayName: "P2 Recovery", providerPresetId: providerId })];
    return state;
}

async function interruptBeforeAcceptance(page: Page, initiallyUnknown = false, transport: "error" | "empty" | "400" = "error") {
  await page.addInitScript(({ initiallyUnknown, transport }) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const originalFetch = window.fetch;
    const accepted = new Map<string, { cwd: string; surface: string; owner?: string; data: Record<string, any> }>(JSON.parse(sessionStorage.getItem("p2-fixture-receipts") ?? "[]"));
    let available = !initiallyUnknown || sessionStorage.getItem("p2-fixture-receipts-available") === "true";
    window.addEventListener("p2-receipts-available", () => { available = true; sessionStorage.setItem("p2-fixture-receipts-available", "true"); });
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href);
      const privateQuery = url.pathname.endsWith("/direct-messages") && url.searchParams.has("idempotencyKey");
      if (url.pathname === "/conversation-submissions" || privateQuery) {
        const key = url.searchParams.get("idempotencyKey")!;
        const record = accepted.get(key);
        const data = record?.data;
        const common = { cwd: url.searchParams.get("cwd"), idempotencyKey: key };
        const sameOwner = privateQuery ? record?.owner === url.pathname.split("/")[2]
          : record?.surface === url.searchParams.get("surface") && (!record.owner || record.owner === url.searchParams.get("channelId"));
        const receipt = available && record && data && sameOwner && record.cwd === common.cwd
          ? privateQuery ? { ...common, teammateId: record.owner, status: "accepted", message: data.message, aiReply: data.aiReply }
            : { ...common, status: "accepted", threadId: data.thread.id, turnId: data.turn.id,
              sourceItemId: data.userItem?.id ?? data.userMessage.id, sourceItem: data.userItem }
          : { ...common, ...(privateQuery ? { teammateId: url.pathname.split("/")[2] } : {}), status: "unknown" };
        return new Response(JSON.stringify(receipt), { headers: { "Content-Type": "application/json" } });
      }
      const response = await originalFetch(...args);
      if (!/\/(conversations|direct-messages|turns)\/stream$/.test(url.pathname)) return response;
      const request = JSON.parse(String(args[1]?.body));
      if (!request.idempotencyKey) throw new Error("Missing submission identity");
      const ready = (await response.text()).split("\n\n").find(block => block.startsWith("event: ready\n"));
      if (!ready) throw new Error("No persisted fixture input");
      const data = JSON.parse(ready.slice("event: ready\ndata: ".length));
      if (url.pathname === "/conversations/stream") {
        const detailUrl = new URL(`/conversations/${data.thread.id}`, url.origin);
        detailUrl.searchParams.set("cwd", url.searchParams.get("cwd")!);
        const detail = await (await originalFetch(detailUrl)).json();
        data.userItem = detail.conversationItems.find((item: { id: string }) => item.id === data.userMessage.id);
      }
      accepted.set(request.idempotencyKey, { cwd: url.searchParams.get("cwd")!,
        surface: url.pathname.includes("direct-messages") ? "private" : url.pathname.includes("turns") ? "channel" : "normal",
        owner: url.pathname.includes("conversations") ? undefined : url.pathname.split("/")[2], data });
      sessionStorage.setItem("p2-fixture-receipts", JSON.stringify([...accepted]));
      if (transport === "400") return new Response(JSON.stringify({ message: "Controlled preparation failure after durable acceptance" }), { status: 400, headers: { "Content-Type": "application/json" } });
      if (transport === "empty") return new Response("", { status: response.status, headers: response.headers });
      return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("Controlled loss before any confirmation")); } }), {
        status: response.status, headers: response.headers,
      });
    };
  }, { initiallyUnknown, transport });
}

for (const surface of ["normal", "private", "channel"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`${surface} ${theme} recovers a completely lost confirmation by submission identity`, async ({ page }) => {
      await interruptBeforeAcceptance(page);
      await page.addInitScript(theme => {
        const selection = JSON.stringify({ themeId: `ling-${theme}`, mode: "fixed" });
        localStorage.setItem("ling-stack.themeSelection", selection);
        localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
        localStorage.setItem("ling-stack.themePreference", theme);
        localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
      }, theme);
      const state = recoveryState();
      await mockDaemon(page, state);
      let submissions = 0;
      page.on("request", request => { if (request.method() === "POST" && /\/(conversations|direct-messages|turns)\/stream(?:\?|$)/.test(request.url())) submissions++; });
      await page.goto("/");
      if (surface !== "normal") await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", {
        name: surface === "private" ? "P2 Recovery" : "Engineering", exact: true,
      }).click();
      const input = page.getByLabel(surface === "private" ? "Private chat composer" : surface === "channel" ? "Channel composer" : "New conversation composer", { exact: true }).getByRole("textbox");
      const body = `P2 ${surface} missing confirmation?`;
      await input.fill(body); await input.press("Enter");
      const feed = page.getByLabel(surface === "private" ? "Private message feed" : surface === "channel" ? "Channel message feed" : "Conversation messages", { exact: true });
      await expect(feed.getByText(body, { exact: true })).toHaveCount(1);
      await expect(input).toHaveAttribute("data-value", "");
      await expect(feed.locator('[data-conversation-timeline-kind="agentMessage"]')).toContainText(surface === "normal"
        ? `Ling Agent response: ${body}` : surface === "channel" ? "P2 recovered channel reply" : /Mock|Received|reply/i);
      expect(submissions).toBe(1);
      await expect(page.locator("body")).toHaveCSS("background-color", theme === "dark" ? "rgb(31, 31, 31)" : "rgb(255, 255, 255)");
      await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
      await mkdir(evidenceDir, { recursive: true });
      await page.screenshot({ path: `${evidenceDir}${surface}-${theme}-before-ready-recovery.png`, animations: "disabled" });
    });
  }
}

test("private unresolved confirmation blocks a second POST and a later click only queries the original receipt", async ({ page }) => {
  await interruptBeforeAcceptance(page, true);
  const state = recoveryState();
  await mockDaemon(page, state);
  let submissions = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/direct-messages\/stream/.test(request.url())) submissions++; });
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "P2 Recovery", exact: true }).click();
  const input = page.getByLabel("Private chat composer", { exact: true }).getByRole("textbox");
  const body = "P2 unknown private input?";
  await input.fill(body); await input.press("Enter");
  await expect(page.getByText("Pending confirmation", { exact: true })).toBeVisible();
  await expect(input).toHaveAttribute("data-value", body);
  await input.press("Enter");
  expect(submissions).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("p2-receipts-available")));
  await input.press("Enter");
  await expect(input).toHaveAttribute("data-value", "");
  await expect(page.getByLabel("Private message feed", { exact: true }).getByText(body, { exact: true })).toHaveCount(1);
  expect(submissions).toBe(1);
});

test("private receipt recovery preserves same-text draft with a newly attached file", async ({ page }) => {
  await interruptBeforeAcceptance(page, true);
  const state = recoveryState();
  await mockDaemon(page, state);
  let submissions = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/direct-messages\/stream/.test(request.url())) submissions++; });
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "P2 Recovery", exact: true }).click();
  const composer = page.getByLabel("Private chat composer", { exact: true });
  const input = composer.getByRole("textbox");
  const body = "Same text but a different attachment?";
  await input.fill(body); await input.press("Enter");
  await expect(page.getByText("Pending confirmation", { exact: true })).toBeVisible();
  await composer.locator('input[type="file"]').setInputFiles({ name: "new-draft.txt", mimeType: "text/plain", buffer: Buffer.from("New unsent attachment") });
  await expect(composer.getByText("new-draft.txt", { exact: true }).first()).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("p2-receipts-available")));
  await input.press("Enter");
  await expect(page.getByLabel("Private message feed", { exact: true }).getByText(body, { exact: true })).toHaveCount(1);
  await expect(input).toHaveAttribute("data-value", body);
  await expect(composer.getByText("new-draft.txt", { exact: true }).first()).toBeVisible();
  expect(submissions).toBe(1);
});

for (const surface of ["normal", "channel", "private"] as const) {
for (const transport of ["empty", "400"] as const) {
test(`${surface} reconciles durable acceptance despite a ${transport} pre-ready response`, async ({ page }) => {
  await interruptBeforeAcceptance(page, false, transport);
  const state = recoveryState();
  await mockDaemon(page, state);
  let submissions = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/(conversations|direct-messages|turns)\/stream/.test(request.url())) submissions++; });
  await page.goto("/");
  if (surface !== "normal") await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: surface === "private" ? "P2 Recovery" : "Engineering", exact: true }).click();
  const input = page.getByLabel(surface === "private" ? "Private chat composer" : surface === "channel" ? "Channel composer" : "New conversation composer", { exact: true }).getByRole("textbox");
  const body = `Durably accepted ${surface} ${transport} input?`;
  await input.fill(body); await input.press("Enter");
  await expect(input).toHaveAttribute("data-value", "");
  const feed = page.getByLabel(surface === "private" ? "Private message feed" : surface === "channel" ? "Channel message feed" : "Conversation messages", { exact: true });
  await expect(feed.getByText(body, { exact: true })).toHaveCount(1);
  await expect(feed.locator('[data-conversation-timeline-kind="agentMessage"]')).toContainText(surface === "normal" ? `Ling Agent response: ${body}` : surface === "channel" ? "P2 recovered channel reply" : /Mock|Received|reply/i);
  expect(submissions).toBe(1);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
});
}
test(`${surface} unresolved receipt survives reload and reconciliation preserves a new draft without a second POST`, async ({ page }) => {
  await interruptBeforeAcceptance(page, true);
  const state = recoveryState();
  await mockDaemon(page, state);
  let submissions = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/(conversations|direct-messages|turns)\/stream/.test(request.url())) submissions++; });
  const open = async () => {
    await page.goto("/");
    if (surface !== "normal") await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", {
      name: surface === "private" ? "P2 Recovery" : "Engineering", exact: true,
    }).click();
  };
  await open();
  const input = page.getByLabel(surface === "private" ? "Private chat composer" : surface === "channel" ? "Channel composer" : "New conversation composer", { exact: true }).getByRole("textbox");
  const body = `Original unknown ${surface} input?`;
  await input.fill(body); await input.press("Enter");
  await expect(page.getByText("Pending confirmation", { exact: true }).first()).toBeVisible();
  expect(submissions).toBe(1);
  await open();
  const freshDraft = "Keep this new draft until I explicitly send it";
  await input.fill(freshDraft); await input.press("Enter");
  await expect(page.getByText("Pending confirmation", { exact: true }).first()).toBeVisible();
  expect(submissions).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("p2-receipts-available")));
  await input.press("Enter");
  const feed = page.getByLabel(surface === "private" ? "Private message feed" : surface === "channel" ? "Channel message feed" : "Conversation messages", { exact: true });
  await expect(feed.getByText(body, { exact: true })).toHaveCount(1);
  await expect(input).toHaveAttribute("data-value", freshDraft);
  await expect(feed.getByText(freshDraft, { exact: true })).toHaveCount(0);
  expect(submissions).toBe(1);
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}${surface}-reload-receipt-recovery.png`, animations: "disabled" });
});
}

test("channel accepted terminal errors do not offer input replay", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = recoveryState();
  await mockDaemon(page, state);
  // Fail after accepting the user input and before an assistant reply exists.
  // A persisted assistant failure has its own error owner in the message feed.
  await page.route(/\/channels\/channel_engineering\/turns\/stream(?:\?.*)?$/, async route => {
    const request = route.request().postDataJSON();
    state.lastChannelTurnRequest = request;
    const thread = state.threads.find(item => item.id === request.surface?.threadId)!;
    expect(thread).toBeDefined();
    const now = "2026-10-14T00:00:00.000Z";
    const message = { id: "p2-accepted-terminal-input", workspaceId: "workspace_default", channelId: "channel_engineering",
      threadId: thread.id, kind: "message", intent: "discuss", authorType: "local-user", authorId: "tian",
      body: request.body, mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [], status: "ready", createdAt: now, updatedAt: now };
    state.channelMessages.push(message);
    const turn = { id: `turn_${message.id}`, workspaceId: "workspace_default", threadId: thread.id, channelId: message.channelId,
      kind: "manual_followup", status: "failed", title: request.body, userInstruction: request.body,
      sourceItemId: message.id, createdByActor: "local-user", createdAt: now, updatedAt: now, completedAt: now };
    state.turns.push(turn);
    const accepted = { thread, turn, decorations: [], userItem: { schemaVersion: 1, id: message.id, workspaceId: "workspace_default",
      channelId: message.channelId, threadId: thread.id, turnId: turn.id, sequence: 1, kind: "user_message", status: "committed",
      actorType: "local_user", actorId: "tian", visibility: "channel", payload: { body: request.body, format: "plain_text",
        mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] }, domainRefs: [], revision: 1,
      createdAt: now, updatedAt: now, committedAt: now } };
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: [
      `event: ready\ndata: ${JSON.stringify(accepted)}\n\n`,
      `event: error\ndata: ${JSON.stringify({ ...accepted, error: "Controlled terminal error after acceptance" })}\n\n`,
    ].join("") });
  });
  let submissions = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/turns\/stream/.test(request.url())) submissions++; });
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Engineering", exact: true }).click();
  const composer = page.getByLabel("Channel composer", { exact: true });
  const input = composer.getByRole("textbox");
  const body = "P2 accepted input with a terminal error?";
  await input.fill(body);
  await input.press("Enter");
  await expect(composer.getByText("Controlled terminal error after acceptance", { exact: true })).toBeVisible();
  await expect(composer.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(composer).not.toContainText("Message failed");
  await expect(input).toHaveAttribute("data-value", "");
  await expect(page.getByLabel("Channel message feed", { exact: true }).getByText(body, { exact: true })).toHaveCount(1);
  expect(submissions).toBe(1);
  expect(state.channelMessages).toHaveLength(1);
  expect(state.channelMessages).toEqual([expect.objectContaining({ kind: "message", body })]);
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}channel-accepted-terminal-error.png`, animations: "disabled" });
});

for (const surface of ["normal", "private", "channel"] as const) {
  test(`${surface} reads the original accepted reply after losing the response without replay`, async ({ page }) => {
    await interruptAfterAcceptance(page);
    const state = recoveryState();
    await mockDaemon(page, state);
    let submissions = 0;
    page.on("request", request => {
      if (request.method() === "POST" && /\/(conversations|direct-messages|turns)\/stream(?:\?|$)/.test(request.url())) submissions++;
    });
    await page.goto("/");
    const sidebar = page.getByRole("complementary", { name: /Sidebar display/ });
    if (surface !== "normal") await sidebar.getByRole("button", { name: surface === "private" ? "P2 Recovery" : "Engineering", exact: true }).click();
    const composer = page.getByLabel(surface === "private" ? "Private chat composer" : surface === "channel" ? "Channel composer" : "New conversation composer", { exact: true });
    const input = composer.getByRole("textbox");
    const body = `P2 ${surface} accepted input?`;
    await input.fill(body);
    await input.press("Enter");
    const feed = page.getByLabel(surface === "private" ? "Private message feed" : surface === "channel" ? "Channel message feed" : "Conversation messages", { exact: true });
    await expect(feed.getByText(body, { exact: true })).toHaveCount(1);
    await expect(input).toHaveAttribute("data-value", "");
    // The mock Host has already durably completed. The interrupted stream only sent ready.
    await expect(feed.locator('[data-conversation-timeline-kind="agentMessage"]')).toContainText(surface === "normal"
      ? `Ling Agent response: ${body}`
      : surface === "channel" ? "P2 recovered channel reply" : /Mock|Received|reply/i);
    if (surface === "channel") {
      await expect(composer.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
      await expect(composer.getByText("Controlled response loss after acceptance", { exact: true })).toBeVisible();
    }
    expect(submissions).toBe(1);
    expect(surface === "private" ? state.teammateDirectMessages.length : surface === "channel" ? state.channelMessages.length : state.turns.length).toBe(surface === "normal" ? 1 : 2);
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({ path: `${evidenceDir}${surface}-accepted-response-recovery.png`, animations: "disabled" });
  });
}

for (const phase of ["after-ready", "before-ready"] as const) {
test(`branch recovers the accepted turn in its own thread without replay · ${phase}`, async ({ page }) => {
  if (phase === "before-ready") await interruptBeforeAcceptance(page);
  else await interruptAfterAcceptance(page);
  const state = recoveryState();
  const now = "2026-10-14T00:00:00.000Z";
  const rootId = "thread_channel_channel_engineering", threadId = "p2-recovery-branch";
  const root = { id: rootId, workspaceId: "workspace_default", channelId: "channel_engineering", kind: "channel_discussion" as const,
    title: "Engineering", objective: "Recovery fixture", status: "open" as const, surfaceKind: "channel_root" as const,
    relationKind: "root" as const, createdAt: now, updatedAt: now };
  state.threads = [root, { ...root, id: threadId, title: "P2 Recovery Branch", parentThreadId: rootId,
    surfaceKind: "branch", relationKind: "branch" }];
  state.channelBranches = [{ id: "p2-recovery-branch-record", workspaceId: "workspace_default", channelId: "channel_engineering",
    rootThreadId: threadId, name: "P2 Recovery Branch", status: "active", createdAt: now, updatedAt: now }];
  await mockDaemon(page, state);
  let submissions = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/turns\/stream/.test(request.url())) submissions++; });
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: /Sidebar display/ });
  await sidebar.getByRole("button", { name: "P2 Recovery Branch", exact: true }).click();
  const composer = page.getByLabel("Channel composer", { exact: true });
  const input = composer.getByRole("textbox");
  const body = "@P2 Recovery P2 accepted branch input?";
  await input.fill(body);
  await input.press("Enter");
  const feed = page.getByLabel("Channel message feed", { exact: true });
  await expect(feed.getByText(body, { exact: true })).toHaveCount(1);
  await expect(feed).toContainText("P2 recovered channel reply");
  await expect(input).toHaveAttribute("data-value", "");
  await expect(composer.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  expect(state.lastChannelTurnRequest?.surface).toEqual({ kind: "thread", threadId });
  expect(submissions).toBe(1);
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}branch-${phase}-response-recovery.png`, animations: "disabled" });
  await sidebar.getByRole("list", { name: "Engineering Conversations", exact: true }).locator("[data-session-default=true] .sidebar-branch-row").click();
  await expect(feed).not.toContainText(body);
});
}

test("normal receipt recovery performs a final read when an earlier evidence snapshot is still pending", async ({ page }) => {
  await interruptAfterAcceptance(page, true);
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    let released = false;
    window.addEventListener("p2-release-response", () => { released = true; });
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (!/\/conversations\/(?!stream\?)[^/?]+\?/.test(String(args[0])) || !response.ok) return response;
      if (released) return response;
      const detail = await response.json();
      detail.messages = detail.messages.map((message: { role: string; content: string; status: string }) => message.role === "assistant"
        ? { ...message, content: "", status: "pending" } : message);
      detail.conversationItems = [];
      return new Response(JSON.stringify(detail), { status: 200, headers: response.headers });
    };
  });
  const state = recoveryState();
  await mockDaemon(page, state);
  let reads = 0, submissions = 0;
  page.on("request", request => {
    if (request.method() === "GET" && /\/conversations\/(?!stream\?)[^/?]+\?/.test(request.url())) reads++;
    if (request.method() === "POST" && /\/conversations\/stream/.test(request.url())) submissions++;
  });
  await page.goto("/");
  const input = page.getByLabel("New conversation composer", { exact: true }).getByRole("textbox");
  const body = "P2 normal pending evidence input?";
  await input.fill(body);
  await input.press("Enter");
  await expect.poll(() => reads).toBeGreaterThanOrEqual(1);
  const feed = page.getByLabel("Conversation messages", { exact: true });
  await expect(feed).not.toContainText(`Ling Agent response: ${body}`);
  const readsBeforeLoss = reads;
  await page.evaluate(() => window.dispatchEvent(new Event("p2-release-response")));
  await expect(feed).toContainText(`Ling Agent response: ${body}`);
  await expect(input).toHaveAttribute("data-value", "");
  expect(reads).toBeGreaterThan(readsBeforeLoss);
  expect(submissions).toBe(1);
});

for (const theme of ["light", "dark"] as const) {
for (const phase of ["after-ready", "before-ready"] as const) {
test(`topic reads the accepted reply without duplicate bubbles or draft restoration · ${theme} · ${phase}`, async ({ page }) => {
  if (phase === "before-ready") await interruptBeforeAcceptance(page);
  else await interruptAfterAcceptance(page);
  await page.addInitScript(theme => {
    const selection = JSON.stringify({ themeId: `ling-${theme}`, mode: "fixed" });
    localStorage.setItem("ling-stack.themeSelection", selection);
    localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
  }, theme);
  const state = recoveryState();
  const now = "2026-10-14T00:00:00.000Z";
  state.channelMessages = [{ id: "p2-topic-root", workspaceId: "workspace_default", channelId: "channel_engineering",
    kind: "ai_reply", intent: "discuss", authorType: "ai-teammate", authorId: "ling_agent", body: "P2 topic root",
    mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [], status: "ready", createdAt: now, updatedAt: now }];
  await mockDaemon(page, state);
  let submissions = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/turns\/stream/.test(request.url())) submissions++; });
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Engineering", exact: true }).click();
  const root = page.getByLabel("Channel message feed", { exact: true }).locator("[data-conversation-row-key]").filter({ hasText: "P2 topic root" });
  await root.hover();
  await root.getByRole("button", { name: "Reply in topic", exact: true }).click();
  const panel = page.getByLabel("Topic replies", { exact: true });
  const input = panel.getByRole("textbox", { name: "Topic reply input", exact: true });
  const body = "P2 accepted topic reply";
  await input.fill(body);
  await panel.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(panel.locator("[data-conversation-timeline]").getByText(body, { exact: true })).toHaveCount(1);
  await expect(input).toHaveValue("");
  await expect(panel.getByRole("button", { name: "Send reply", exact: true })).toBeDisabled();
  await expect(panel.getByRole("alert")).toContainText(phase === "before-ready" ? "Controlled loss before any confirmation" : "Controlled response loss after acceptance");
  await expect(panel.getByRole("alert")).not.toContainText("Message failed");
  expect(submissions).toBe(1);
  expect(state.channelMessages).toHaveLength(2);
  const ownReply = panel.locator("[data-conversation-message-row]").filter({ hasText: body });
  await expect(ownReply).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(ownReply).toHaveCSS("border-top-width", "0px");
  await expect(ownReply).toHaveCSS("padding-top", "0px");
  await expect(ownReply.locator(".message-content")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(ownReply.getByRole("button", { name: "Copy message", exact: true })).toHaveCount(1);
  await expect(ownReply.getByRole("button", { name: "Edit message", exact: true })).toHaveCount(1);
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}topic-${theme}-${phase}-response-recovery.png`, animations: "disabled" });
});
}
}

for (const terminalError of [false, true]) {
test(`channel ${terminalError ? "terminal error" : "response loss"} after switching surfaces cannot restore the accepted draft or affect the new surface`, async ({ page }) => {
  await interruptAfterAcceptance(page, true, terminalError);
  const state = recoveryState();
  await mockDaemon(page, state);
  let submissions = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/turns\/stream/.test(request.url())) submissions++; });
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: /Sidebar display/ });
  await sidebar.getByRole("button", { name: "Engineering", exact: true }).click();
  const composer = page.getByLabel("Channel composer", { exact: true });
  const input = composer.getByRole("textbox");
  const body = "P2 detached accepted channel input?";
  await input.fill(body);
  await input.press("Enter");
  await expect(input).toHaveAttribute("data-value", "");
  await expect.poll(() => state.channelMessages.length).toBe(2);
  await sidebar.getByRole("button", { name: "P2 Recovery", exact: true }).click();
  const privateInput = page.getByLabel("Private chat composer", { exact: true }).getByRole("textbox");
  await privateInput.fill("New surface keeps its draft");
  await page.evaluate(() => window.dispatchEvent(new Event("p2-release-response")));
  await expect(privateInput).toHaveAttribute("data-value", "New surface keeps its draft");
  await expect(page.getByLabel("Private message feed", { exact: true })).not.toContainText(body);
  await sidebar.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect(input).toHaveAttribute("data-value", "");
  await expect(composer.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Channel message feed", { exact: true }).getByText(body, { exact: true })).toHaveCount(1);
  expect(submissions).toBe(1);
});
}

test("late topic failure cannot overwrite a reopened topic draft or error state", async ({ page }) => {
  await interruptAfterAcceptance(page, true);
  const state = recoveryState();
  const now = "2026-10-14T00:00:00.000Z";
  state.channelMessages = [{ id: "p2-topic-root", workspaceId: "workspace_default", channelId: "channel_engineering",
    kind: "ai_reply", intent: "discuss", authorType: "ai-teammate", authorId: "ling_agent", body: "P2 topic root",
    mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [], status: "ready", createdAt: now, updatedAt: now }];
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Engineering", exact: true }).click();
  const root = page.getByLabel("Channel message feed", { exact: true }).locator("[data-conversation-row-key]").filter({ hasText: "P2 topic root" });
  await root.hover();
  await root.getByRole("button", { name: "Reply in topic", exact: true }).click();
  const panel = page.getByLabel("Topic replies", { exact: true });
  const input = panel.getByRole("textbox", { name: "Topic reply input", exact: true });
  await input.fill("Accepted reply from the old topic lifetime");
  await panel.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(input).toHaveValue("");
  await panel.getByRole("button", { name: "Close topic", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await root.hover();
  await root.getByRole("button", { name: "Reply in topic", exact: true }).click();
  await expect(panel.locator("[data-conversation-timeline]")).toContainText("Accepted reply from the old topic lifetime");
  await input.fill("The reopened topic keeps this new draft");
  await page.evaluate(async () => {
    window.dispatchEvent(new Event("p2-release-response"));
    for (let frame = 0; frame < 6; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  await expect(input).toHaveValue("The reopened topic keeps this new draft");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(state.channelMessages).toHaveLength(2);
});
