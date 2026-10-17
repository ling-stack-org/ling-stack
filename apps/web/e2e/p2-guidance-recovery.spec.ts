import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cwd, mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate } from "./support/mock-state";
import { installNormalConversationFixture, normalConversationFixtureTitle } from "./support/normal-conversation-fixture";

const evidenceDir = process.env.LING_P2_EVIDENCE_DIR ?? fileURLToPath(new URL("../../../.ling-stack/acceptance/p2-ux2-guidance-20261015/", import.meta.url));

async function openGuidance(page: Page, surface: "normal" | "private") {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const fetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await fetch(...args);
      if (response.ok && /\/(?:direct-interventions|interventions)$/.test(new URL(String(args[0]), location.href).pathname) && args[1]?.method === "POST") {
        await response.text();
        throw new TypeError("Controlled guidance response loss");
      }
      return response;
    };
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "guidance-provider", lastCheck: { ok: true, code: "ready",
    message: "Controlled guidance fixture", checkedAt: "2026-10-15T00:00:00.000Z" } })];
  state.workspaceSettings.defaultProviderPresetId = state.providers[0].id;
  state.aiTeammates = [createMockTeammate({ id: "guidance-teammate", displayName: "Guidance Teammate", providerPresetId: state.providers[0].id })];
  state.runs = []; state.tasks = []; state.approvals = []; state.threads = []; state.turns = [];
  state.channelMessages = []; state.teammateDirectMessages = [];
  const now = "2026-10-15T00:00:00.000Z";
  if (surface === "normal") {
    installNormalConversationFixture(state);
    state.threads = state.threads.map(thread => ({ ...thread, status: "running", activeRunId: state.runs[0].id }));
    state.turns = state.turns.map(turn => ({ ...turn, status: "running", completedAt: undefined }));
    state.runs = state.runs.map(run => ({ ...run, status: "running", endedAt: undefined }));
  } else {
    state.teammateDirectMessages = [{ id: "guidance-reply", teammateId: "guidance-teammate", threadId: "tdthread_guidance-teammate",
      authorType: "ai-teammate", body: "Partial original reply", status: "pending", createdAt: now, updatedAt: now }];
    state.workUnits = [{ id: "guidance-work", workspaceId: "workspace_default", kind: "teammate_direct_reply",
      ownerType: "teammate", ownerId: "guidance-teammate", teammateId: "guidance-teammate", idempotencyKey: "guidance-work",
      status: "running", priority: 50, attemptCount: 1, activeAttemptId: "guidance-attempt", createdByActor: "user",
      request: { sourceMessageId: "guidance-source" }, timeoutPolicy: { staleAfterMs: 120000, timeoutAfterMs: 300000 },
      linkedMessageId: "guidance-reply", createdAt: now, updatedAt: now, startedAt: now }];
  }
  await mockDaemon(page, state);
  let available = false, posts = 0, queries = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/(?:direct-interventions|interventions)$/.test(new URL(request.url()).pathname)) posts++; });
  await page.route(url => /\/(?:direct-interventions|interventions)$/.test(url.pathname) && url.searchParams.has("idempotencyKey"), route => {
    queries++;
    const key = new URL(route.request().url()).searchParams.get("idempotencyKey");
    const interventions = (surface === "normal" ? state.runInterventions : state.teammateDirectInterventions).filter(item => item.idempotencyKey === key);
    return route.fulfill({ json: { cwd, idempotencyKey: key, interventions: available ? interventions : [],
      ...(surface === "private" ? { teammateId: "guidance-teammate", thread: { id: "tdthread_guidance-teammate" } } : {}) } });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/^Failed to load resource: the server responded with a status of 400\b/.test(message.text())) errors.push(message.text());
  });
  await page.goto("/");
  if (surface === "normal") await page.getByRole("button", { name: /Open recent conversation \d+/ }).filter({ hasText: normalConversationFixtureTitle }).click();
  else await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Guidance Teammate", exact: true }).click();
  const composer = page.getByLabel(surface === "normal" ? "New conversation composer" : "Private chat composer", { exact: true });
  await expect(composer.getByRole("button", { name: surface === "normal" ? "Stop" : "Stop reply", exact: true })).toBeVisible();
  await expect(composer.locator('input[type="file"]')).toBeEnabled();
  return { composer, state, errors, counts: () => ({ posts, queries }), reveal: () => { available = true; } };
}

for (const surface of ["normal", "private"] as const) {
  test(`${surface} dark desktop guidance remains readable and recovers through the same control`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.addInitScript(() => {
      const selection = JSON.stringify({ themeId: "ling-dark", mode: "fixed" });
      localStorage.setItem("ling-stack.themeSelection", selection);
      localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
      localStorage.setItem("ling-stack.themePreference", "dark");
      localStorage.setItem("ling-stack.themeBootstrapPreference", "dark");
    });
    const f = await openGuidance(page, surface);
    await f.composer.getByRole("textbox").fill("Recover the dark-mode guidance");
    await f.composer.getByRole("textbox").press("Enter");
    await expect(page.getByText("Pending confirmation", { exact: true })).toBeVisible();
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(31, 31, 31)");
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({ path: `${evidenceDir}${surface}-dark-guidance-pending.png`, animations: "disabled" });
    f.reveal();
    await f.composer.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(f.composer.getByRole("textbox")).toHaveAttribute("data-value", "");
    expect(f.counts().posts).toBe(1);
    await page.screenshot({ path: `${evidenceDir}${surface}-dark-guidance-recovered.png`, animations: "disabled" });
    expect(f.errors).toEqual([]);
  });

  test(`${surface} unknown guidance only queries its original receipt and never duplicates execution`, async ({ page }) => {
    const f = await openGuidance(page, surface);
    const input = f.composer.getByRole("textbox");
    await input.fill("Recover the original guidance");
    await input.press("Enter");
    await expect(page.getByText("Pending confirmation", { exact: true })).toBeVisible();
    expect(f.counts().posts).toBe(1);
    await input.press("Enter");
    await expect.poll(() => f.counts().queries).toBeGreaterThan(3);
    expect(f.counts().posts).toBe(1);
    f.reveal();
    await input.press("Enter");
    await expect(input).toHaveAttribute("data-value", "");
    expect(f.counts().posts).toBe(1);
    expect(surface === "normal" ? f.state.runInterventions : f.state.teammateDirectInterventions).toHaveLength(1);
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({ path: `${evidenceDir}${surface}-guidance-query-only.png`, animations: "disabled" });
    expect(f.errors).toEqual([]);
  });

  test(`${surface} recovering guidance preserves a newer text and file draft and its removal authority`, async ({ page }) => {
    const f = await openGuidance(page, surface);
    const input = f.composer.getByRole("textbox");
    const fileInput = f.composer.locator('input[type="file"]');
    let deletes = 0;
    page.on("request", request => { if (request.method() === "DELETE") deletes++; });
    await fileInput.setInputFiles({ name: "original.txt", mimeType: "text/plain", buffer: Buffer.from("original") });
    await expect(f.composer.locator(".composer-preview-card")).toHaveClass(/ready/);
    await input.fill("Original guidance with file"); await input.press("Enter");
    await expect(page.getByText("Pending confirmation", { exact: true })).toBeVisible();
    await f.composer.getByRole("button", { name: "Remove pending attachment" }).click();
    expect(deletes).toBe(0);
    await fileInput.setInputFiles({ name: "newer.txt", mimeType: "text/plain", buffer: Buffer.from("newer") });
    const newer = f.composer.locator(".composer-preview-card");
    await expect(newer).toHaveClass(/ready/);
    await input.fill("New independent draft");
    f.reveal(); await input.press("Enter");
    await expect(page.getByText("Pending confirmation", { exact: true })).toHaveCount(0);
    await expect(input).toHaveAttribute("data-value", "New independent draft");
    await expect(newer).toContainText("newer.txt");
    expect(f.counts().posts).toBe(1);
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({ path: `${evidenceDir}${surface}-guidance-preserves-new-draft.png`, animations: "disabled" });
    await newer.getByRole("button", { name: "Remove pending attachment" }).click();
    await expect.poll(() => deletes).toBe(1);
    expect(f.errors).toEqual([]);
  });

  test(`${surface} guidance lookup survives reload and source completion without becoming a new initial send`, async ({ page }) => {
    const f = await openGuidance(page, surface);
    const input = f.composer.getByRole("textbox");
    await input.fill("Guidance before reload"); await input.press("Enter");
    await expect(page.getByText("Pending confirmation", { exact: true })).toBeVisible();
    f.state.runs = f.state.runs.map(run => ({ ...run, status: "succeeded", endedAt: new Date().toISOString() }));
    f.state.workUnits = f.state.workUnits.map(work => ({ ...work, status: "succeeded" }));
    await page.reload();
    if (surface === "normal") await page.getByRole("button", { name: /Open recent conversation \d+/ }).filter({ hasText: normalConversationFixtureTitle }).click();
    else await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Guidance Teammate", exact: true }).click();
    await expect(f.composer.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    f.reveal();
    await f.composer.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(f.composer.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    expect(f.counts().posts).toBe(1);
    expect(surface === "normal" ? f.state.runInterventions : f.state.teammateDirectInterventions).toHaveLength(1);
    expect(f.errors).toEqual([]);
  });

  test(`${surface} proven rejected guidance restores a removable file without saving a pending query`, async ({ page }) => {
    const f = await openGuidance(page, surface);
    await page.route(url => /\/(?:direct-interventions|interventions)$/.test(url.pathname), route => {
      if (route.request().method() !== "POST") return route.fallback();
      return route.fulfill({ status: 400, json: { message: "Controlled rejection before guidance acceptance" } });
    });
    let deletes = 0;
    page.on("request", request => { if (request.method() === "DELETE") deletes++; });
    await f.composer.locator('input[type="file"]').setInputFiles({ name: "rejected-guidance.txt", mimeType: "text/plain", buffer: Buffer.from("unaccepted") });
    const file = f.composer.locator(".composer-preview-card");
    await expect(file).toHaveClass(/ready/);
    await f.composer.getByRole("textbox").fill("Unaccepted guidance");
    await f.composer.getByRole("textbox").press("Enter");
    await expect(page.getByText("Controlled rejection before guidance acceptance", { exact: true })).toBeVisible();
    await expect(f.composer.getByRole("textbox")).toHaveAttribute("data-value", "Unaccepted guidance");
    await expect(file).toHaveClass(/ready/);
    await file.getByRole("button", { name: "Remove pending attachment" }).click();
    await expect.poll(() => deletes).toBe(1);
    expect(f.errors).toEqual([]);
  });

  test(`${surface} a recovered accepted guidance receipt clears only its bound file`, async ({ page }) => {
    const f = await openGuidance(page, surface);
    f.reveal();
    let deletes = 0;
    page.on("request", request => { if (request.method() === "DELETE") deletes++; });
    await f.composer.locator('input[type="file"]').setInputFiles({ name: "accepted-guidance.txt", mimeType: "text/plain", buffer: Buffer.from("accepted") });
    await expect(f.composer.locator(".composer-preview-card")).toHaveClass(/ready/);
    await f.composer.getByRole("textbox").fill("Accepted guidance file");
    await f.composer.getByRole("textbox").press("Enter");
    await expect(f.composer.getByRole("textbox")).toHaveAttribute("data-value", "");
    await expect(f.composer.locator(".composer-preview-card")).toHaveCount(0);
    expect(f.counts().posts).toBe(1);
    expect(f.counts().queries).toBeGreaterThan(0);
    await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Engineering", exact: true }).click();
    await expect(page.getByLabel("Channel composer", { exact: true })).toBeVisible();
    expect(deletes).toBe(0);
    expect(f.errors).toEqual([]);
  });
}
