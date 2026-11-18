import { createServer, type ServerResponse } from "node:http";
import { test, expect, type Page } from "@playwright/test";
import { defaultCompanionManifest } from "@ling-stack/core";
import type { AiTeammate, CompanionProfile, CompanionState, TeammateDirectMessage } from "@ling-stack/contracts";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate } from "./support/mock-state";

test.setTimeout(60_000);

async function fixture(page: Page, mode: "normal" | "interrupted" | "pending" | "same-session-race" | "terminal-error" = "normal", historyCount = 0,
  options: { empty?: boolean; cooldownMs?: number; secondCompanion?: boolean; locale?: string } = {}) {
  page.on("pageerror", error => console.error("Companion page error:", error.message));
  const base = createBaseState({ approvalStatus: "pending" });
  const teammate = createMockTeammate({ id: "teammate_companion" }) as unknown as AiTeammate; base.aiTeammates = [teammate];
  await mockDaemon(page, base);
  await page.addInitScript(locale => localStorage.setItem("ling-stack.locale", locale), options.locale ?? "en-US");
  let companion: CompanionProfile = {
    id: "companion_yui", workspaceId: "workspace_default", teammateId: teammate.id, displayName: "Yui",
    description: "Companion", manifest: defaultCompanionManifest, status: "active",
    behaviorPolicy: { proactiveEnabled: false, cooldownMs: options.cooldownMs ?? 900_000 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const secondCompanion = { ...companion, id: "companion_mio", displayName: "Mio" };
  let created = !options.empty;
  const state: CompanionState = { companionId: companion.id, phase: "idle", emotionId: "neutral",
    emotionIntensity: 0.5, energy: 100, updatedAt: new Date().toISOString() };
  const makeMessage = (id: string, body: string, authorType: TeammateDirectMessage["authorType"], status: TeammateDirectMessage["status"] = "ready", index = 0): TeammateDirectMessage => ({
    id, workspaceId: "workspace_default", threadId: "thread", teammateId: teammate.id, authorType, body, status,
    attachmentIds: [], linkPreviewIds: [], fileRefs: [], createdAt: new Date(Date.parse("2026-11-16T01:00:00Z") + index * 1000).toISOString(), updatedAt: new Date().toISOString(),
  });
  const messages = Array.from({ length: historyCount }, (_, i) => makeMessage(`history_${i}`, `History ${i}`, i % 2 ? "ai-teammate" : "local-user", "ready", i));
  const submissions = new Map<string, { message: TeammateDirectMessage; aiReply?: TeammateDirectMessage }>();
  const keys: string[] = [];
  const cursors: string[] = [];
  let release: (() => void) | undefined;
  let completed = false;
  let receiptGate: Promise<void> | undefined;
  let receiptsUnavailable = false;
  let releaseReceipt: (() => void) | undefined;
  const heldReceiptKeys = new Set<string>();
  const heldReceiptWaiters = new Map<string, Array<() => void>>();
  const gate = new Promise<void>(resolve => { release = resolve; });
  const json = (response: ServerResponse, body: unknown, code = 200) => {
    response.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); response.end(JSON.stringify(body));
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (request.method === "OPTIONS") { response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE", "Access-Control-Allow-Headers": "Content-Type,Accept" }); response.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (url.pathname === "/companions") {
      if (request.method === "POST") {
        const policy = { ...companion.behaviorPolicy, ...body.behaviorPolicy };
        if (policy.quietHours === null) delete policy.quietHours;
        companion = { ...companion, id: "companion_created", ...body, behaviorPolicy: policy };
        created = true;
      }
      json(response, request.method === "POST" ? { companion }
        : { companions: created ? [companion, ...(options.secondCompanion ? [secondCompanion] : [])] : [] }); return;
    }
    if (url.pathname.endsWith("/state")) { json(response, { state }); return; }
    if (url.pathname.endsWith("/events")) { json(response, { events: [] }); return; }
    if (url.pathname.endsWith("/messages/stream")) {
      keys.push(body.idempotencyKey);
      const existing = submissions.get(body.idempotencyKey);
      const user = existing?.message ?? makeMessage(`user_${body.idempotencyKey}`, body.body, "local-user", "ready", 100);
      const reply = makeMessage(`reply_${body.idempotencyKey}`, "", "ai-teammate", "pending", 101);
      const submission = existing ?? { message: user }; submissions.set(body.idempotencyKey, submission);
      if (!existing) messages.push(user);
      response.writeHead(200, { "Content-Type": "text/event-stream", "Access-Control-Allow-Origin": "*" });
      const frame = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      frame("accepted", { message: user, state: { ...state, phase: "thinking" } });
      if (mode === "terminal-error" && keys.length === 1) {
        frame("error", { message: user, error: "provider startup unavailable", state }); response.end(); return;
      }
      frame("ready", { aiReply: reply }); frame("delta", { messageId: reply.id, body: "Streamed", delta: "Streamed" });
      if ((mode === "interrupted" && keys.length === 1)
        || (mode === "same-session-race" && keys.length <= 2)) { response.end(); return; }
      if (mode === "pending") {
        submission.aiReply = { ...reply, body: "Streamed" }; response.end(); return;
      }
      await gate;
      submission.aiReply = { ...reply, body: "Streamed reply.", status: "ready" }; messages.push(submission.aiReply);
      frame("done", { message: user, aiReply: submission.aiReply, state }); response.end(); return;
    }
    if (url.pathname.endsWith("/messages")) {
      const key = url.searchParams.get("idempotencyKey");
      if (key) {
        if (receiptsUnavailable) { json(response, { error: "receipt_temporarily_unavailable" }, 503); return; }
        if (heldReceiptKeys.has(key)) {
          await new Promise<void>(resolve => {
            const waiters = heldReceiptWaiters.get(key) ?? [];
            waiters.push(resolve);
            heldReceiptWaiters.set(key, waiters);
          });
        }
        await receiptGate;
        const submission = submissions.get(key); json(response, { status: submission ? "accepted" : "unknown", ...submission, state }); return;
      }
      const before = url.searchParams.get("beforeMessageId");
      if (before) cursors.push(before);
      const end = before ? messages.findIndex(message => message.id === before) : messages.length;
      const start = Math.max(0, end - 40); const page = messages.slice(start, end);
      json(response, { messages: page, hasMore: start > 0, ...(start > 0 ? { nextBeforeMessageId: page[0]?.id } : {}) }); return;
    }
    if (request.method === "PATCH") {
      const policy = { ...companion.behaviorPolicy, ...body.behaviorPolicy };
      if (policy.quietHours === null) delete policy.quietHours;
      companion = { ...companion, ...body, behaviorPolicy: policy }; json(response, { companion }); return;
    }
    json(response, { events: [] });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
  await page.route(url => url.origin === "http://127.0.0.1:17891"
    && (url.pathname === "/companions" || url.pathname.startsWith("/companions/")), async route => {
    const url = new URL(route.request().url());
    await route.continue({ url: `http://127.0.0.1:${address.port}${url.pathname}${url.search}` });
  });
  return {
    keys, cursors, get companion() { return companion; },
    holdReceipts: () => { receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; }); },
    releaseReceipts: () => { releaseReceipt?.(); receiptGate = undefined; },
    setReceiptsUnavailable: (unavailable: boolean) => { receiptsUnavailable = unavailable; },
    forgetSubmission: (key: string) => { submissions.delete(key); },
    holdReceiptKey: (key: string) => { heldReceiptKeys.add(key); },
    heldReceiptCount: (key: string) => heldReceiptWaiters.get(key)?.length ?? 0,
    releaseLatestReceipt: (key: string) => { heldReceiptWaiters.get(key)?.pop()?.(); },
    releaseOldestReceipt: (key: string) => { heldReceiptWaiters.get(key)?.shift()?.(); },
    addSystemMessage: (body: string) => messages.push(makeMessage("system_prompt", body, "system")),
    finish: () => { if (completed) return; completed = true; release?.(); },
    finishPending: () => { for (const submission of submissions.values()) {
      const reply = submission.aiReply ?? makeMessage(`reply_${submission.message.id}`, "", "ai-teammate", "pending", 101);
      submission.aiReply = { ...reply, body: "Recovered after disconnect.", status: "ready" };
      if (!messages.some(message => message.id === submission.aiReply!.id)) messages.push(submission.aiReply);
    } },
    close: async () => {
      releaseReceipt?.(); release?.();
      for (const waiters of heldReceiptWaiters.values()) for (const resolve of waiters) resolve();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function openPanel(page: Page) {
  await page.goto("/");
  await page.locator(".companion-config-button").click();
  const panel = page.getByRole("dialog", { name: "Intelligent companion" });
  await expect(panel.getByRole("img", { name: "Yui" })).toBeVisible();
  await panel.hover();
  return panel;
}

test("streams reply text before completion and uses one durable submission key", async ({ page }) => {
  const f = await fixture(page);
  try {
    const panel = await openPanel(page);
    await panel.getByRole("textbox", { name: "Message companion" }).fill("Hello Yui");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.getByRole("log")).toContainText("Streamed");
    await expect(panel.getByRole("log")).not.toContainText("Streamed reply.");
    f.finish();
    await expect(panel.getByRole("log")).toContainText("Streamed reply.");
    await expect(panel.getByRole("textbox")).toHaveValue("");
    expect(f.keys).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("ling-stack.companion-submission")))).toEqual([]);
  } finally { await f.close(); }
});

test("waits for a truncated accepted stream without resubmitting", async ({ page }) => {
  const f = await fixture(page, "interrupted");
  try {
    const panel = await openPanel(page);
    await panel.getByRole("textbox").fill("Retry the original text"); await panel.getByRole("button", { name: "Send", exact: true }).click();
    await panel.getByRole("button", { name: "Recover or retry message" }).click();
    await expect.poll(() => f.keys).toHaveLength(1);
    f.finishPending();
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(panel.getByRole("log")).toContainText("Recovered after disconnect.");
    expect(f.keys).toHaveLength(1);
    await expect(panel.locator(".companion-mini-message.user")).toHaveCount(1);
  } finally { await f.close(); }
});

test("pending receipt survives reload and recovers without another POST", async ({ page }) => {
  const f = await fixture(page, "pending");
  try {
    let panel = await openPanel(page);
    await panel.getByRole("textbox").fill("Keep this pending"); await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Recover or retry message" })).toBeVisible();
    await expect(panel.getByRole("textbox")).toHaveValue("Keep this pending");
    await page.reload(); await page.locator(".companion-config-button").click();
    panel = page.getByRole("dialog", { name: "Intelligent companion" }); await panel.hover();
    await expect(panel.getByRole("textbox")).toBeDisabled();
    f.finishPending(); await panel.getByRole("button", { name: "Recover or retry message" }).click();
    await expect(panel.getByRole("log")).toContainText("Recovered after disconnect.");
    await expect(panel.getByRole("textbox")).toBeEnabled(); expect(f.keys).toHaveLength(1);
  } finally { await f.close(); }
});

test("does not resubmit while the original reply is still pending", async ({ page }) => {
  const f = await fixture(page, "pending");
  try {
    const panel = await openPanel(page);
    await panel.getByRole("textbox").fill("Wait for the original reply");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Recover or retry message" })).toBeVisible();
    expect(f.keys).toHaveLength(1);
    await panel.getByRole("button", { name: "Recover or retry message" }).click();
    await expect.poll(() => f.keys).toHaveLength(1);
    await expect(panel.getByRole("button", { name: "Recover or retry message" })).toBeVisible();
  } finally { await f.close(); }
});

test("retries an accepted startup error with the original submission key", async ({ page }) => {
  const f = await fixture(page, "terminal-error");
  try {
    const panel = await openPanel(page);
    await panel.getByRole("textbox").fill("Recover this startup error");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("provider startup unavailable");
    await expect(panel.getByRole("button", { name: "Recover or retry message" })).toBeVisible();
    const key = f.keys[0];
    await panel.getByRole("button", { name: "Recover or retry message" }).click();
    await expect.poll(() => f.keys).toHaveLength(2);
    expect(f.keys[1]).toBe(key);
    f.finish();
    await expect(panel.getByRole("log")).toContainText("Streamed reply.");
    await expect(panel.getByRole("textbox")).toBeEnabled();
  } finally { await f.close(); }
});

test("desktop companion retries teammate discovery after a transient daemon failure", async ({ page }) => {
  const f = await fixture(page);
  let teammateReads = 0;
  let companionReads = 0;
  await page.route(url => url.origin === "http://127.0.0.1:17891" && url.pathname === "/teammates", async route => {
    teammateReads++;
    if (teammateReads === 1) {
      await route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } });
      return;
    }
    await route.fallback();
  });
  await page.route(url => url.origin === "http://127.0.0.1:17891" && url.pathname === "/companions", async route => {
    companionReads++;
    if (companionReads === 1) {
      await route.fulfill({ status: 503, json: { error: "temporarily_unavailable" } });
      return;
    }
    await route.fallback();
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, "lingCompanionDesktop", {
      configurable: true,
      value: {
        cwd: "/tmp/ling-stack-workspace",
        daemonBaseUrl: "http://127.0.0.1:17891",
        close: async () => ({ accepted: true }),
        openSettings: async () => ({ accepted: true }),
      },
    });
  });
  try {
    await page.goto("/?companionWindow=1");
    const panel = page.getByRole("dialog", { name: "Intelligent companion" });
    await expect(panel.locator(".companion-mini-avatar-wrap .teammate-avatar-image")).toHaveCount(1, { timeout: 12_000 });
    expect(teammateReads).toBeGreaterThanOrEqual(2);
    expect(companionReads).toBeGreaterThanOrEqual(2);
  } finally { await f.close(); }
});

test("a restored submission blocks new text until its unavailable receipt recovers", async ({ page }) => {
  const f = await fixture(page, "pending");
  try {
    let panel = await openPanel(page);
    await panel.getByRole("textbox").fill("Original pending text");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Recover or retry message" })).toBeVisible();
    f.setReceiptsUnavailable(true);
    await page.reload(); await page.locator(".companion-config-button").click();
    panel = page.getByRole("dialog", { name: "Intelligent companion" }); await panel.hover();
    await expect(panel.getByRole("alert")).toBeVisible();
    await expect(panel.getByRole("textbox")).toBeDisabled();
    await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    expect(f.keys).toHaveLength(1);
    f.finishPending(); f.setReceiptsUnavailable(false);
    await panel.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(panel.getByRole("log")).toContainText("Recovered after disconnect.");
    await expect(panel.getByRole("textbox")).toBeEnabled();
    await panel.getByRole("textbox").fill("A different new message");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => f.keys).toHaveLength(2);
    expect(f.keys[1]).not.toBe(f.keys[0]);
  } finally { await f.close(); }
});

test("an unknown restored receipt clears the stale submission and allows a new message", async ({ page }) => {
  const f = await fixture(page, "pending");
  try {
    let panel = await openPanel(page);
    await panel.getByRole("textbox").fill("Original message");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Recover or retry message" })).toBeVisible();
    const staleKey = f.keys[0]!;
    f.forgetSubmission(staleKey);

    await page.reload(); await page.locator(".companion-config-button").click();
    panel = page.getByRole("dialog", { name: "Intelligent companion" }); await panel.hover();
    await expect(panel.getByRole("alert")).toContainText("The reply was interrupted");
    await expect(panel.getByRole("textbox")).toBeEnabled({ timeout: 30_000 });
    await panel.getByRole("textbox").fill("A new message");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => f.keys).toHaveLength(2);
    expect(f.keys[1]).not.toBe(staleKey);
  } finally { await f.close(); }
});

test("a delayed receipt cannot retry a message in a different companion session", async ({ page }) => {
  const f = await fixture(page, "interrupted", 0, { secondCompanion: true });
  f.finish();
  try {
    const panel = await openPanel(page);
    await panel.getByRole("textbox").fill("Private text for Yui");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Recover or retry message" })).toBeVisible();
    f.holdReceipts();
    const lookup = page.waitForRequest(request => request.url().includes("idempotencyKey=") && request.method() === "GET");
    await panel.getByRole("button", { name: "Recover or retry message" }).click();
    const request = await lookup;
    await panel.getByLabel("Active companion").selectOption("companion_mio");
    await expect(panel.getByRole("img", { name: "Mio" })).toBeVisible();
    const receipt = page.waitForResponse(response => response.request() === request);
    f.releaseReceipts();
    await receipt;
    await expect(panel.getByRole("textbox")).toBeEnabled();
    await panel.getByRole("textbox").fill("Draft for Mio");
    await expect(panel.getByRole("textbox")).toHaveValue("Draft for Mio");
    expect(f.keys).toHaveLength(1);
  } finally { await f.close(); }
});

test("a delayed receipt cannot replace a newer pending message in the same session", async ({ page }) => {
  const f = await fixture(page, "same-session-race");
  try {
    const panel = await openPanel(page);
    await panel.getByRole("textbox").fill("Message A");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Recover or retry message" })).toBeVisible();

    const keyA = f.keys[0]!;
    f.holdReceiptKey(keyA);
    const automaticLookup = page.waitForRequest(request => request.method() === "GET" && request.url().includes(`idempotencyKey=${keyA}`));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await automaticLookup;
    await expect.poll(() => f.heldReceiptCount(keyA)).toBe(1);

    f.finishPending();
    const manualLookup = page.waitForRequest(request => request.method() === "GET" && request.url().includes(`idempotencyKey=${keyA}`));
    await panel.getByRole("button", { name: "Recover or retry message" }).click();
    await manualLookup;
    await expect.poll(() => f.heldReceiptCount(keyA)).toBe(2);
    f.releaseLatestReceipt(keyA);
    await expect.poll(() => f.heldReceiptCount(keyA)).toBe(1);

    await expect(panel.getByRole("textbox")).toBeEnabled();
    await panel.getByRole("textbox").fill("Message B");
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => f.keys).toHaveLength(2);
    await expect(panel.getByRole("button", { name: "Recover or retry message" })).toBeVisible();

    f.finishPending();
    const delayedReceipt = page.waitForResponse(response => response.request().method() === "GET"
      && response.request().url().includes(`idempotencyKey=${keyA}`));
    f.releaseOldestReceipt(keyA);
    await delayedReceipt;

    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(panel.getByRole("log")).toContainText("Recovered after disconnect.");
    await expect(panel.getByRole("textbox")).toBeEnabled();
    expect(f.keys).toHaveLength(2);
    await expect(panel.locator(".companion-mini-message.user").filter({ hasText: "Message B" })).toHaveCount(1);
  } finally { await f.close(); }
});

test("history pagination retains its cursor across reconnect synchronization", async ({ page }) => {
  const f = await fixture(page, "normal", 90);
  try {
    const panel = await openPanel(page);
    const log = panel.getByRole("log"); await log.evaluate(element => { element.scrollTop = 0; });
    await log.getByRole("button", { name: "Load earlier messages" }).click();
    await expect(log).toContainText("History 10");
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => f.cursors).toEqual(["history_50"]);
    await log.evaluate(element => { element.scrollTop = 0; });
    await log.getByRole("button", { name: "Load earlier messages" }).click();
    await expect(log).toContainText("History 0"); expect(f.cursors).toEqual(["history_50", "history_10"]);
    await expect(log.getByRole("button", { name: "Load earlier messages" })).toHaveCount(0);
  } finally { await f.close(); }
});

test("conversation stays beside the character across themes and below it on narrow screens", async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const f = await fixture(page, "normal", 10);
  f.addSystemMessage("Internal proactive scheduler prompt");
  const evidence = process.env.LING_COMPANION_VISUAL_EVIDENCE;
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openPanel(page);
    for (const themeId of ["ling-light", "ling-dark", "ling-breeze", "ling-ocean", "ling-night", "ling-journey"]) {
      await page.evaluate(id => {
        const selection = JSON.stringify({ mode: "fixed", themeId: id });
        localStorage.setItem("ling-stack.themeSelection", selection);
        localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
      }, themeId);
      const panel = await openPanel(page);
      await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);
      const conversation = await panel.locator(".companion-mini-conversation").boundingBox();
      const character = await panel.getByRole("img", { name: "Yui" }).boundingBox();
      expect(conversation!.x + conversation!.width).toBeLessThanOrEqual(character!.x);
      expect(await panel.getByRole("img", { name: "Yui" }).evaluate(async el => {
        const url = getComputedStyle(el).backgroundImage.slice(5, -2);
        const image = new Image(); image.src = url; await image.decode();
        return image.naturalWidth;
      })).toBeGreaterThan(1000);
      await expect(panel.getByRole("log")).toContainText("History 9");
      await expect(panel.getByRole("log")).not.toContainText("Internal proactive scheduler prompt");
      await panel.getByRole("textbox").fill("A draft beside Yui");
      await expect(panel.getByRole("textbox")).toHaveValue("A draft beside Yui");
      if (evidence) await page.screenshot({ path: `${evidence}/companion-chat-${themeId}.png` });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const panel = page.getByRole("dialog", { name: "Intelligent companion" });
    const stage = await panel.locator(".companion-pet-stage").boundingBox();
    const conversation = await panel.locator(".companion-mini-conversation").boundingBox();
    expect(stage!.y + stage!.height).toBeLessThanOrEqual(conversation!.y);
    expect(await panel.getByRole("img", { name: "Yui" }).evaluate(el => getComputedStyle(el).animationName)).toBe("none");
    await panel.getByRole("textbox").focus();
    await expect(panel.getByRole("textbox")).toBeFocused();
    if (evidence) await page.screenshot({ path: `${evidence}/companion-chat-mobile.png` });
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test("companion settings persist explicit cooldown and quiet hours and can clear them", async ({ page }) => {
  const f = await fixture(page);
  try {
    const panel = await openPanel(page); await panel.getByRole("button", { name: "Manage companions in Settings" }).click();
    const settings = page.locator(".companion-settings-page");
    await settings.getByRole("button", { name: "Create companion", exact: true }).first().click();
    await expect(settings.getByLabel("Allow proactive companion prompts")).not.toBeChecked();
    await expect(settings.getByLabel("Proactive cooldown")).toHaveValue("15");
    await settings.getByLabel("Companion name").fill("Yui");
    await settings.getByText("Allow proactive companion prompts", { exact: true }).click();
    await expect(settings.getByLabel("Allow proactive companion prompts")).toBeChecked();
    await settings.getByLabel("Proactive cooldown").selectOption("30");
    await settings.getByText("Pause proactive prompts during quiet hours", { exact: true }).click();
    await settings.getByLabel("Quiet hours start").selectOption("22"); await settings.getByLabel("Quiet hours end").selectOption("8");
    await settings.getByRole("button", { name: "Create companion", exact: true }).last().click();
    await expect.poll(() => f.companion.behaviorPolicy).toEqual({ proactiveEnabled: true, cooldownMs: 1_800_000, quietHours: [22, 8] });
    await settings.getByText("Pause proactive prompts during quiet hours", { exact: true }).click();
    await settings.getByRole("button", { name: "Save companion", exact: true }).click();
    await expect.poll(() => f.companion.behaviorPolicy.quietHours).toBeUndefined();
  } finally { await f.close(); }
});

test("the first companion form defaults to proactive behavior off", async ({ page }) => {
  const f = await fixture(page, "normal", 0, { empty: true });
  try {
    await page.goto("/");
    await page.locator(".companion-config-button").click();
    await page.getByRole("button", { name: "Open companion settings", exact: true }).click();
    const settings = page.locator(".companion-settings-page");
    await expect(settings.getByLabel("Allow proactive companion prompts")).not.toBeChecked();
    await settings.getByLabel("Companion name").fill("First Yui");
    await settings.getByRole("button", { name: "Create companion", exact: true }).last().click();
    await expect.poll(() => f.companion.behaviorPolicy).toEqual({ proactiveEnabled: false, cooldownMs: 900_000 });
  } finally { await f.close(); }
});

test("refresh preserves unsaved companion settings while selection changes load the chosen companion", async ({ page }) => {
  const f = await fixture(page, "normal", 0, { secondCompanion: true });
  try {
    const panel = await openPanel(page);
    await panel.getByRole("button", { name: "Manage companions in Settings" }).click();
    const settings = page.locator(".companion-settings-page");
    await expect(settings.getByLabel("Companion name")).toHaveValue("Yui");
    await settings.getByLabel("Companion name").fill("  Draft Yui  ");
    await settings.locator("textarea").fill("An unsaved description");
    await settings.getByText("Allow proactive companion prompts", { exact: true }).click();
    await settings.getByLabel("Proactive cooldown").selectOption("30");
    await settings.getByText("Pause proactive prompts during quiet hours", { exact: true }).click();
    await settings.getByLabel("Quiet hours start").selectOption("21");
    await settings.getByLabel("Quiet hours end").selectOption("7");
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/companions"
      && response.request().method() === "GET");
    await settings.getByRole("button", { name: "Refresh", exact: true }).click();
    await refreshed;
    await expect(settings.getByLabel("Companion name")).toHaveValue("  Draft Yui  ");
    await expect(settings.locator("textarea")).toHaveValue("An unsaved description");
    await expect(settings.getByLabel("Allow proactive companion prompts")).toBeChecked();
    await expect(settings.getByLabel("Proactive cooldown")).toHaveValue("30");
    await expect(settings.getByLabel("Quiet hours start")).toHaveValue("21");
    await expect(settings.getByLabel("Quiet hours end")).toHaveValue("7");
    await settings.getByRole("button", { name: "Save companion", exact: true }).click();
    await expect(settings.getByLabel("Companion name")).toHaveValue("Draft Yui");
    expect(f.companion.description).toBe("An unsaved description");
    expect(f.companion.behaviorPolicy).toEqual({ proactiveEnabled: true, cooldownMs: 1_800_000, quietHours: [21, 7] });
    await settings.locator(".companion-settings-list").getByRole("button", { name: /Mio/ }).click();
    await expect(settings.getByLabel("Companion name")).toHaveValue("Mio");
    await expect(settings.locator("textarea")).toHaveValue("Companion");
    await expect(settings.getByLabel("Allow proactive companion prompts")).not.toBeChecked();
    await expect(settings.getByLabel("Proactive cooldown")).toHaveValue("15");
    await expect(settings.getByLabel("Pause proactive prompts during quiet hours")).not.toBeChecked();
  } finally { await f.close(); }
});

test("editing a name preserves zero and non-minute custom cooldowns", async ({ page }) => {
  for (const cooldownMs of [0, 90_001]) {
    const f = await fixture(page, "normal", 0, { cooldownMs });
    try {
      const panel = await openPanel(page);
      await panel.getByRole("button", { name: "Manage companions in Settings" }).click();
      const settings = page.locator(".companion-settings-page");
      await settings.getByLabel("Companion name").fill("Renamed Yui");
      await settings.getByRole("button", { name: "Save companion", exact: true }).click();
      await expect.poll(() => f.companion.displayName).toBe("Renamed Yui");
      expect(f.companion.behaviorPolicy.cooldownMs).toBe(cooldownMs);
    } finally { await f.close(); await page.unrouteAll({ behavior: "wait" }); }
  }
});

test("compiled catalogs localize Chinese companion controls without clipping the send label", async ({ page }) => {
  const f = await fixture(page, "normal", 10, { locale: "zh-CN" });
  try {
    await page.goto("/");
    await page.locator(".companion-config-button").click();
    const panel = page.getByRole("dialog", { name: "智能伙伴" });
    await expect(panel.getByRole("button", { name: "打招呼", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "庆祝", exact: true })).toBeVisible();
    const send = panel.getByRole("button", { name: "发送", exact: true });
    await expect(send).toBeVisible();
    expect(await send.evaluate(element => {
      const label = element.querySelector(".ling-ui-button-label");
      return label ? label.scrollWidth <= label.clientWidth : element.scrollWidth <= element.clientWidth;
    })).toBe(true);
    const evidence = process.env.LING_COMPANION_VISUAL_EVIDENCE;
    if (evidence) await page.screenshot({ path: `${evidence}/companion-chat-zh-CN.png` });
  } finally { await f.close(); }
});
