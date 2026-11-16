import { createServer, type ServerResponse } from "node:http";
import { test, expect, type Page } from "@playwright/test";
import { defaultCompanionManifest } from "@ling-stack/core";
import type { AiTeammate, CompanionProfile, CompanionState, TeammateDirectMessage } from "@ling-stack/contracts";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate, cwd } from "./support/mock-state";

test.setTimeout(60_000);

async function fixture(page: Page, mode: "normal" | "interrupted" | "pending" = "normal", historyCount = 0) {
  page.on("pageerror", error => console.error("Companion page error:", error.message));
  const base = createBaseState({ approvalStatus: "pending" });
  const teammate = createMockTeammate({ id: "teammate_companion" }) as unknown as AiTeammate; base.aiTeammates = [teammate];
  await mockDaemon(page, base);
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  let companion: CompanionProfile = {
    id: "companion_yui", workspaceId: "workspace_default", teammateId: teammate.id, displayName: "Yui",
    description: "Companion", manifest: defaultCompanionManifest, status: "active",
    behaviorPolicy: { proactiveEnabled: false, cooldownMs: 900_000 }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
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
      if (request.method === "POST") companion = { ...companion, id: "companion_created", ...body, behaviorPolicy: { ...companion.behaviorPolicy, ...body.behaviorPolicy } };
      json(response, request.method === "POST" ? { companion } : { companions: [companion] }); return;
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
      frame("ready", { aiReply: reply }); frame("delta", { messageId: reply.id, body: "Streamed", delta: "Streamed" });
      if (mode === "interrupted" && keys.length === 1) { response.end(); return; }
      if (mode === "pending") {
        submission.aiReply = { ...reply, body: "Streamed" }; response.end(); return;
      }
      await gate;
      submission.aiReply = { ...reply, body: "Streamed reply.", status: "ready" }; messages.push(submission.aiReply);
      frame("done", { message: user, aiReply: submission.aiReply, state }); response.end(); return;
    }
    if (url.pathname.endsWith("/messages")) {
      const key = url.searchParams.get("idempotencyKey");
      if (key) { const submission = submissions.get(key); json(response, { status: submission ? "accepted" : "unknown", ...submission, state }); return; }
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
    addSystemMessage: (body: string) => messages.push(makeMessage("system_prompt", body, "system")),
    finish: () => { if (completed) return; completed = true; release?.(); },
    finishPending: () => { for (const submission of submissions.values()) if (submission.aiReply) {
      submission.aiReply = { ...submission.aiReply, body: "Recovered after disconnect.", status: "ready" }; messages.push(submission.aiReply);
    } },
    close: async () => { release?.(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
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

test("retries a truncated stream with the same key and one user message", async ({ page }) => {
  const f = await fixture(page, "interrupted"); f.finish();
  try {
    const panel = await openPanel(page);
    await panel.getByRole("textbox").fill("Retry the original text"); await panel.getByRole("button", { name: "Send", exact: true }).click();
    await panel.getByRole("button", { name: "Recover or retry message" }).click();
    await expect(panel.getByRole("log")).toContainText("Streamed reply.");
    expect(f.keys).toHaveLength(2); expect(f.keys[1]).toBe(f.keys[0]);
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
