import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate } from "./support/mock-state";
import { installNormalConversationFixture, normalConversationFixtureTitle } from "./support/normal-conversation-fixture";

const evidenceDir = process.env.LING_P2_EVIDENCE_DIR ?? fileURLToPath(new URL("../../../.ling-stack/acceptance/p2-ux2-attachments-20261014/", import.meta.url));
const errorsByPage = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  errorsByPage.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/^Failed to load resource: the server responded with a status of (400|422|503|404)\b/.test(message.text())) errors.push(message.text());
  });
});
test.afterEach(async ({ page }) => { expect(errorsByPage.get(page)).toEqual([]); });

async function capture(page: Page, name: string) {
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}${name}.png`, animations: "disabled" });
}

async function openSurface(page: Page, surface: "private" | "normal" | "channel" = "private", prepare?: (state: ReturnType<typeof createBaseState>) => void) {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "p2_upload_provider", model: "gpt-5.5", lastCheck: {
    ok: true, code: "ready", message: "Controlled upload fixture", checkedAt: "2026-10-14T00:00:00.000Z",
  } })];
  state.aiTeammates = [createMockTeammate({ id: "p2_upload_teammate", displayName: "P2 Upload", providerPresetId: "p2_upload_provider" })];
  state.runs = []; state.tasks = []; state.approvals = []; state.teammateDirectMessages = [];
  state.threads = []; state.turns = []; state.channelMessages = [];
  state.workspaceSettings.defaultProviderPresetId = "p2_upload_provider";
  state.channels = state.channels.map(channel => ({ ...channel, defaultProviderPresetId: "p2_upload_provider" }));
  state.channels.push({ ...state.channels[0], id: "p2_other_channel", name: "P2 Other" });
  prepare?.(state);
  await mockDaemon(page, state);
  await page.goto("/");
  if (surface !== "normal") await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", {
    name: surface === "private" ? "P2 Upload" : "Engineering", exact: true,
  }).click();
  const composer = page.getByLabel(surface === "private" ? "Private chat composer" : surface === "channel" ? "Channel composer" : "New conversation composer", { exact: true });
  await expect(composer).toBeVisible();
  return { composer, state };
}

const openPrivate = (page: Page) => openSurface(page, "private");

for (const surface of ["normal", "private", "channel"] as const) {
  test(`${surface} image preview survives upload failure and selected retry and is released once on removal and unmount`, async ({ page }) => {
    await page.addInitScript(() => {
      const created: string[] = [];
      const revoked: string[] = [];
      Object.assign(window, { p2PreviewProbe: { created, revoked } });
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = value => { const url = create(value); created.push(url); return url; };
      URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
    });
    const { composer } = await openSurface(page, surface);
    const endpoint = surface === "private" ? "**/teammates/p2_upload_teammate/direct-attachments**"
      : surface === "normal" ? "**/conversations/attachments**" : "**/channels/channel_engineering/attachments**";
    let attempts = 0;
    await page.route(endpoint, async route => {
      if (route.request().method() !== "POST") return route.fallback();
      if (++attempts === 1) return route.fulfill({ status: 422, json: { message: "Controlled preview upload failure" } });
      return route.fallback();
    });
    const image = { name: "preview.png", mimeType: "image/png", buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64") };
    const probe = () => page.evaluate(() => (window as unknown as {
      p2PreviewProbe: { created: string[]; revoked: string[] };
    }).p2PreviewProbe);
    await composer.locator('input[type="file"]').setInputFiles(image);
    const card = composer.locator(".composer-preview-card");
    await expect(card).toHaveClass(/failed/);
    const first = (await probe()).created[0];
    await expect(card.locator("img")).toHaveAttribute("src", first);
    await card.getByRole("button", { name: "Retry upload" }).click();
    await expect(card).toHaveClass(/ready/);
    await expect(card.locator("img")).toHaveAttribute("src", first);
    expect(await probe()).toEqual({ created: [first], revoked: [] });
    await card.getByRole("button", { name: "Remove pending attachment" }).click();
    await expect(card).toHaveCount(0);
    expect((await probe()).revoked).toEqual([first]);
    await composer.locator('input[type="file"]').setInputFiles(image);
    await expect(card).toHaveClass(/ready/);
    const second = (await probe()).created[1];
    await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", {
      name: surface === "channel" ? "P2 Upload" : "Engineering", exact: true,
    }).click();
    await expect(composer).toHaveCount(0);
    await expect.poll(async () => (await probe()).revoked).toEqual([first, second]);
  });
}

function heldResponse() {
  let release!: () => void;
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { release, started, requested, wait };
}

test("channel root and branch own separate attachment drafts and late uploads cannot enter the branch", async ({ page }) => {
  const { composer } = await openSurface(page, "channel", state => {
    const now = "2026-10-15T00:00:00.000Z";
    const root = { id: "thread_channel_channel_engineering", workspaceId: "workspace_default", channelId: "channel_engineering",
      kind: "channel_discussion" as const, title: "Engineering", status: "open" as const, surfaceKind: "channel_root" as const,
      relationKind: "root" as const, createdAt: now, updatedAt: now };
    state.threads = [root, { ...root, id: "p2-upload-branch", title: "P2 Upload Branch", parentThreadId: root.id,
      surfaceKind: "branch", relationKind: "branch" }];
    state.channelBranches = [{ id: "p2-upload-branch-record", workspaceId: "workspace_default", channelId: "channel_engineering",
      rootThreadId: "p2-upload-branch", name: "P2 Upload Branch", status: "active", createdAt: now, updatedAt: now }];
  });
  await composer.locator('input[type="file"]').setInputFiles({ name: "root-ready.txt", mimeType: "text/plain", buffer: Buffer.from("root ready") });
  await expect(composer.locator(".composer-preview-card")).toHaveClass(/ready/);
  const held = heldResponse();
  const deleted: string[] = [];
  page.on("request", request => { if (request.method() === "DELETE") deleted.push(new URL(request.url()).pathname); });
  await page.route("**/channels/channel_engineering/attachments**", async route => {
    if (route.request().method() !== "POST" || route.request().postDataJSON().fileName !== "root-late.txt") return route.fallback();
    held.started(); await held.wait; return route.fallback();
  });
  await composer.locator('input[type="file"]').setInputFiles({ name: "root-late.txt", mimeType: "text/plain", buffer: Buffer.from("root late") });
  await held.requested;
  const sidebar = page.getByRole("complementary", { name: /Sidebar display/ });
  await sidebar.getByRole("button", { name: "P2 Upload Branch", exact: true }).click();
  await expect(composer.locator(".composer-preview-card")).toHaveCount(0);
  await composer.getByRole("textbox").fill("This belongs to the branch");
  await composer.locator('input[type="file"]').setInputFiles({ name: "branch.txt", mimeType: "text/plain", buffer: Buffer.from("branch") });
  await expect(composer.locator(".composer-preview-card")).toHaveClass(/ready/);
  held.release();
  await expect.poll(() => deleted.length).toBe(1);
  await expect(composer.locator(".composer-preview-card")).toContainText("branch.txt");
  await expect(composer.getByRole("textbox")).toHaveAttribute("data-value", "This belongs to the branch");
  await capture(page, "branch-owned-attachment-draft");
  await sidebar.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect(composer.locator(".composer-preview-card").filter({ hasText: "root-ready.txt" })).toHaveClass(/ready/);
  await expect(composer.locator(".composer-preview-card").filter({ hasText: "root-late.txt" })).toHaveClass(/failed/);
  await expect(composer.locator(".composer-preview-card").filter({ hasText: "branch.txt" })).toHaveCount(0);
  await capture(page, "root-owned-attachment-draft");
  await sidebar.getByRole("button", { name: "P2 Upload Branch", exact: true }).click();
  await expect(composer.locator(".composer-preview-card")).toContainText("branch.txt");
  await expect(composer.getByRole("textbox")).toHaveAttribute("data-value", "This belongs to the branch");
});

test("a topic reply neither inherits nor consumes the main channel attachment draft", async ({ page }) => {
  const { composer, state } = await openSurface(page, "channel", state => {
    const now = "2026-10-15T00:00:00.000Z";
    state.channelMessages = [{ id: "p2-attachment-topic-root", workspaceId: "workspace_default", channelId: "channel_engineering",
      kind: "ai_reply", intent: "discuss", authorType: "ai-teammate", authorId: "ling_agent", body: "Open this attachment topic",
      mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [], status: "ready", createdAt: now, updatedAt: now }];
  });
  await composer.locator('input[type="file"]').setInputFiles({ name: "main-only.txt", mimeType: "text/plain", buffer: Buffer.from("main only") });
  const attachment = composer.locator(".composer-preview-card");
  await expect(attachment).toHaveClass(/ready/);
  await composer.getByRole("textbox").fill("Unsent main channel draft");
  const root = page.getByLabel("Channel message feed", { exact: true }).locator("[data-conversation-row-key]").filter({ hasText: "Open this attachment topic" });
  await root.hover();
  await root.getByRole("button", { name: "Reply in topic", exact: true }).click();
  const panel = page.getByLabel("Topic replies", { exact: true });
  await panel.getByRole("textbox", { name: "Topic reply input", exact: true }).fill("Independent topic reply");
  await panel.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(panel.locator("[data-conversation-timeline]")).toContainText("Independent topic reply");
  expect(state.lastChannelTurnRequest?.attachmentIds).toEqual([]);
  await panel.getByRole("button", { name: "Close topic", exact: true }).click();
  await expect(attachment).toHaveClass(/ready/);
  await expect(attachment).toContainText("main-only.txt");
  await expect(composer.getByRole("textbox")).toHaveAttribute("data-value", "Unsent main channel draft");
  await capture(page, "topic-keeps-main-attachment-draft");
});

for (const surface of ["normal", "private", "channel"] as const) {
  test(`${surface} a proven rejected send restores its original attachment with removal ownership`, async ({ page }) => {
    const { composer } = await openSurface(page, surface);
    const endpoint = surface === "normal" ? "**/conversations/stream**"
      : surface === "private" ? "**/teammates/p2_upload_teammate/direct-messages/stream**"
        : "**/channels/channel_engineering/turns/stream**";
    await page.route(endpoint, route => route.fulfill({ status: 400, json: { error: "bad_request", message: "Controlled rejection before acceptance" } }));
    const receiptEndpoint = surface === "private" ? "**/teammates/p2_upload_teammate/direct-messages?**" : "**/conversation-submissions?**";
    await page.route(receiptEndpoint, route => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET" || !url.searchParams.has("idempotencyKey")) return route.fallback();
      return route.fulfill({ json: { status: "unknown", cwd: url.searchParams.get("cwd"),
        idempotencyKey: url.searchParams.get("idempotencyKey"), ...(surface === "private" ? { teammateId: "p2_upload_teammate" } : {}) } });
    });
    const deletes: string[] = [];
    page.on("request", request => { if (request.method() === "DELETE") deletes.push(new URL(request.url()).pathname); });
    await composer.locator('input[type="file"]').setInputFiles({ name: "rejected.txt", mimeType: "text/plain", buffer: Buffer.from("original file") });
    const card = composer.locator(".composer-preview-card");
    await expect(card).toHaveClass(/ready/);
    await composer.getByRole("textbox").fill("This input was not accepted");
    await composer.getByRole("textbox").press("Enter");
    await expect(page.getByText("Controlled rejection before acceptance", { exact: true })).toBeVisible();
    await expect(card).toHaveClass(/ready/);
    await expect(composer.getByRole("textbox")).toHaveAttribute("data-value", "This input was not accepted");
    expect(deletes).toEqual([]);
    await capture(page, `${surface}-rejected-send-restores-file`);
    await card.getByRole("button", { name: "Remove pending attachment" }).click();
    await expect(card).toHaveCount(0);
    await expect.poll(() => deletes.length).toBe(1);
  });
}

test("private mixed uploads settle independently without losing the successful file", async ({ page }) => {
  const { composer } = await openPrivate(page);
  await page.route("**/teammates/p2_upload_teammate/direct-attachments**", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    if (body.fileName !== "failed.txt") return route.fallback();
    await route.fulfill({ status: 422, json: { error: "upload_failed", message: "Controlled upload failure" } });
  });
  await composer.locator('input[type="file"]').setInputFiles([
    { name: "ready.txt", mimeType: "text/plain", buffer: Buffer.from("ready") },
    { name: "failed.txt", mimeType: "text/plain", buffer: Buffer.from("failed") },
  ]);
  const ready = composer.locator(".composer-preview-card").filter({ hasText: "ready.txt" });
  const failed = composer.locator(".composer-preview-card").filter({ hasText: "failed.txt" });
  await expect(failed).toHaveClass(/failed/);
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}private-mixed-outcome.png`, animations: "disabled" });
  await expect(ready).toHaveClass(/ready/);
  await expect(failed).toContainText("Controlled upload failure");
});

test("private retry uploads only the failed file and unresolved files cannot be silently sent", async ({ page }) => {
  const { composer, state } = await openPrivate(page);
  const attempts: string[] = [];
  await page.route("**/teammates/p2_upload_teammate/direct-attachments**", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const { fileName } = route.request().postDataJSON();
    attempts.push(fileName);
    if (fileName === "failed.txt" && attempts.filter(name => name === fileName).length === 1) {
      return route.fulfill({ status: 422, json: { error: "upload_failed", message: "Controlled upload failure" } });
    }
    return route.fallback();
  });
  await composer.locator('input[type="file"]').setInputFiles([
    { name: "ready.txt", mimeType: "text/plain", buffer: Buffer.from("ready") },
    { name: "failed.txt", mimeType: "text/plain", buffer: Buffer.from("failed") },
  ]);
  const ready = composer.locator(".composer-preview-card").filter({ hasText: "ready.txt" });
  const failed = composer.locator(".composer-preview-card").filter({ hasText: "failed.txt" });
  await expect(ready).toHaveClass(/ready/);
  await expect(failed).toHaveClass(/failed/);
  await composer.getByRole("textbox").fill("Keep both attachments");
  await expect(composer.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await composer.getByRole("textbox").press("Enter");
  expect(state.lastTeammateDirectMessageRequest).toBeUndefined();
  await failed.getByRole("button", { name: "Retry upload" }).click();
  await expect(failed).toHaveClass(/ready/);
  expect(attempts.filter(name => name === "ready.txt")).toHaveLength(1);
  expect(attempts.filter(name => name === "failed.txt")).toHaveLength(2);
  await expect(composer.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await page.screenshot({ path: `${evidenceDir}private-retry-ready.png`, animations: "disabled" });
});

test("private removing an uploading file fences its late success and deletes only the orphan", async ({ page }) => {
  const { composer, state } = await openPrivate(page);
  const held = heldResponse();
  const deleted: string[] = [];
  page.on("request", request => { if (request.method() === "DELETE") deleted.push(new URL(request.url()).pathname); });
  await page.route("**/teammates/p2_upload_teammate/direct-attachments**", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    held.started(); await held.wait; return route.fallback();
  });
  await composer.locator('input[type="file"]').setInputFiles({ name: "late.txt", mimeType: "text/plain", buffer: Buffer.from("late") });
  await held.requested;
  await composer.getByRole("button", { name: "Remove pending attachment" }).click();
  await expect(composer.locator(".composer-preview-card")).toHaveCount(0);
  held.release();
  await expect.poll(() => deleted).toEqual(["/attachments/tpatt_1"]);
  expect(state.teammatePrivateAttachments).toHaveLength(0);
  await expect(composer.locator(".composer-preview-card")).toHaveCount(0);
});

test("private failed cleanup stays visible and retries removal instead of reuploading", async ({ page }) => {
  const { composer, state } = await openPrivate(page);
  let deletes = 0;
  await page.route("**/attachments/tpatt_1?**", async route => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deletes++;
    if (deletes === 1) return route.fulfill({ status: 503, json: { error: "cleanup_failed", message: "Controlled cleanup failure" } });
    return route.fallback();
  });
  await composer.locator('input[type="file"]').setInputFiles({ name: "cleanup.txt", mimeType: "text/plain", buffer: Buffer.from("cleanup") });
  await expect(composer.locator(".composer-preview-card")).toHaveClass(/ready/);
  await composer.getByRole("button", { name: "Remove pending attachment" }).click();
  const error = composer.getByRole("alert").filter({ hasText: "Controlled cleanup failure" });
  await expect(error).toBeVisible();
  await capture(page, "private-cleanup-retry");
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(error).toHaveCount(0);
  expect(state.teammatePrivateAttachments).toHaveLength(0);
  expect(deletes).toBe(2);
});

test("cleanup retry treats an already removed upload as settled", async ({ page }) => {
  const { composer, state } = await openPrivate(page);
  let deletes = 0;
  await page.route("**/attachments/tpatt_1?**", async route => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deletes++;
    state.teammatePrivateAttachments = [];
    return route.fulfill({ status: deletes === 1 ? 503 : 404, json: { error: "attachment_not_found", message: "Controlled cleanup receipt loss" } });
  });
  await composer.locator('input[type="file"]').setInputFiles({ name: "cleanup.txt", mimeType: "text/plain", buffer: Buffer.from("cleanup") });
  await expect(composer.locator(".composer-preview-card")).toHaveClass(/ready/);
  await composer.getByRole("button", { name: "Remove pending attachment" }).click();
  const error = composer.getByRole("alert").filter({ hasText: "Controlled cleanup receipt loss" });
  await expect(error).toBeVisible();
  await error.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(error).toHaveCount(0);
  expect(deletes).toBe(2);
});

test("private cleanup failure survives closing its draft and can be retried when returning to the owner", async ({ page }) => {
  const { composer, state } = await openPrivate(page);
  let deletes = 0;
  await page.route("**/attachments/tpatt_1?**", async route => {
    if (route.request().method() !== "DELETE") return route.fallback();
    if (++deletes === 1) return route.fulfill({ status: 503, json: { message: "Controlled cleanup failure after leaving the draft" } });
    return route.fallback();
  });
  await composer.locator('input[type="file"]').setInputFiles({ name: "closed-draft.txt", mimeType: "text/plain", buffer: Buffer.from("closed") });
  await expect(composer.locator(".composer-preview-card")).toHaveClass(/ready/);
  const sidebar = page.getByRole("complementary", { name: /Sidebar display/ });
  await sidebar.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect.poll(() => deletes).toBe(1);
  const other = page.getByLabel("Channel composer", { exact: true });
  await expect(other.getByRole("alert").filter({ hasText: "Controlled cleanup failure after leaving the draft" })).toHaveCount(0);
  await sidebar.getByRole("button", { name: "P2 Upload", exact: true }).click();
  const cleanup = composer.getByRole("alert").filter({ hasText: "Controlled cleanup failure after leaving the draft" });
  await expect(cleanup).toBeVisible();
  await capture(page, "private-closed-draft-cleanup-retry");
  await cleanup.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(cleanup).toHaveCount(0);
  await expect.poll(() => state.teammatePrivateAttachments.length).toBe(0);
  expect(deletes).toBe(2);
});

for (const surface of ["private", "normal", "channel"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`${surface} ${theme} long attachment controls stay aligned and retry restores keyboard focus`, async ({ page }) => {
      await page.setViewportSize(theme === "light" ? { width: 1440, height: 960 } : { width: 1280, height: 800 });
      await page.addInitScript(theme => {
        const selection = JSON.stringify({ themeId: `ling-${theme}`, mode: "fixed" });
        localStorage.setItem("ling-stack.themeSelection", selection);
        localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
        localStorage.setItem("ling-stack.themePreference", theme);
        localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
      }, theme);
      const { composer } = await openSurface(page, surface);
      let attempt = 0;
      const endpoint = surface === "private" ? "**/teammates/p2_upload_teammate/direct-attachments**"
        : surface === "normal" ? "**/conversations/attachments**" : "**/channels/channel_engineering/attachments**";
      await page.route(endpoint, async route => {
        if (route.request().method() !== "POST") return route.fallback();
        attempt++;
        if (attempt === 1) return route.fulfill({ status: 422, json: { error: "upload_failed", message: "Controlled long upload failure message without shifting adjacent controls" } });
        return route.fallback();
      });
      await composer.locator('input[type="file"]').setInputFiles({ name: "a-very-long-attachment-name-that-must-never-overlap-retry-or-remove-controls.txt", mimeType: "text/plain", buffer: Buffer.from("long") });
      const card = composer.locator(".composer-preview-card");
      await expect(card).toHaveClass(/failed/);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const geometry = await card.evaluate(element => {
        const body = element.querySelector(".composer-preview-body")!.getBoundingClientRect();
        const controls = Array.from(element.querySelectorAll("button"), button => button.getBoundingClientRect());
        return { overlap: controls.some(control => control.left < body.right),
          controlsOverlap: controls.length > 1 && controls[0].bottom > controls[1].top,
          overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(geometry).toEqual({ overlap: false, controlsOverlap: false, overflow: false });
      await capture(page, `${surface}-${theme}-failed-controls`);
      const retry = card.getByRole("button", { name: "Retry upload" });
      await retry.focus(); await retry.press("Enter");
      await expect(card).toHaveClass(/ready/);
      await expect(card.getByRole("button", { name: "Remove pending attachment" })).toBeFocused();
      await capture(page, `${surface}-${theme}-retry-ready`);
    });
  }
}

test("private unknown send outcome does not delete a possibly message-bound attachment", async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href);
      if (url.pathname.endsWith("/direct-messages") && url.searchParams.has("idempotencyKey")) {
        return new Response(JSON.stringify({ message: "Controlled receipt unavailable" }), { status: 503 });
      }
      const response = await originalFetch(...args);
      if (url.pathname.endsWith("/direct-messages/stream")) {
        await response.text();
        return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return response;
    };
  });
  const { composer } = await openPrivate(page);
  let deletes = 0;
  page.on("request", request => { if (request.method() === "DELETE") deletes++; });
  await composer.locator('input[type="file"]').setInputFiles({ name: "bound.txt", mimeType: "text/plain", buffer: Buffer.from("bound") });
  await expect(composer.locator(".composer-preview-card")).toHaveClass(/ready/);
  await composer.getByRole("textbox").fill("Do not delete my accepted attachment");
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Pending confirmation", { exact: true }).first()).toBeVisible();
  await expect(composer.locator(".composer-preview-card")).toHaveClass(/ready/);
  await composer.getByRole("button", { name: "Remove pending attachment" }).click();
  await expect(composer.locator(".composer-preview-card")).toHaveCount(0);
  expect(deletes).toBe(0);
});

test("channel cached ready files survive navigation while a detached upload cannot return as ready", async ({ page }) => {
  const { composer, state } = await openSurface(page, "channel");
  const held = heldResponse();
  const deleted: string[] = [];
  page.on("request", request => { if (request.method() === "DELETE") deleted.push(new URL(request.url()).pathname); });
  await composer.locator('input[type="file"]').setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("keep") });
  await expect(composer.locator(".composer-preview-card")).toHaveClass(/ready/);
  await page.route("**/channels/channel_engineering/attachments**", async route => {
    if (route.request().method() !== "POST" || route.request().postDataJSON().fileName !== "late.txt") return route.fallback();
    held.started(); await held.wait; return route.fallback();
  });
  await composer.locator('input[type="file"]').setInputFiles({ name: "late.txt", mimeType: "text/plain", buffer: Buffer.from("late") });
  await held.requested;
  const sidebar = page.getByRole("complementary", { name: /Sidebar display/ });
  await sidebar.getByRole("button", { name: "P2 Other", exact: true }).click();
  held.release();
  await expect.poll(() => deleted.length).toBe(1);
  await expect(composer.locator(".composer-preview-card")).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect(composer.locator(".composer-preview-card").filter({ hasText: "keep.txt" })).toHaveClass(/ready/);
  await expect(composer.locator(".composer-preview-card").filter({ hasText: "late.txt" })).toHaveClass(/failed/);
  expect(state.channelAttachments.filter(item => typeof item === "object" && item !== null && "fileName" in item && item.fileName === "keep.txt")).toHaveLength(1);
});

for (const surface of ["normal", "channel"] as const) {
  test(`${surface} mixed uploads settle independently and only the selected failure is retried`, async ({ page }) => {
    const { composer } = await openSurface(page, surface);
    const attempts: string[] = [];
    const endpoint = surface === "normal" ? "**/conversations/attachments**" : "**/channels/channel_engineering/attachments**";
    await page.route(endpoint, async route => {
      if (route.request().method() !== "POST") return route.fallback();
      const { fileName } = route.request().postDataJSON();
      attempts.push(fileName);
      if (fileName === "failed.txt" && attempts.filter(name => name === fileName).length === 1) {
        return route.fulfill({ status: 422, json: { error: "upload_failed", message: "Controlled upload failure" } });
      }
      return route.fallback();
    });
    await composer.locator('input[type="file"]').setInputFiles([
      { name: "ready.txt", mimeType: "text/plain", buffer: Buffer.from("ready") },
      { name: "failed.txt", mimeType: "text/plain", buffer: Buffer.from("failed") },
    ]);
    const ready = composer.locator(".composer-preview-card").filter({ hasText: "ready.txt" });
    const failed = composer.locator(".composer-preview-card").filter({ hasText: "failed.txt" });
    await expect(failed).toHaveClass(/failed/);
    await expect(ready).toHaveClass(/ready/);
    await composer.getByRole("textbox").fill("Both files belong to this draft");
    await expect(composer.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
    await failed.getByRole("button", { name: "Retry upload" }).click();
    await expect(failed).toHaveClass(/ready/);
    expect(attempts.filter(name => name === "ready.txt")).toHaveLength(1);
    expect(attempts.filter(name => name === "failed.txt")).toHaveLength(2);
    await expect(composer.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  });
}

for (const surface of ["normal", "private"] as const) {
  test(`${surface} switching away during upload cleans the late orphan without changing another draft`, async ({ page }) => {
    const { composer } = await openSurface(page, surface);
    const held = heldResponse();
    const deleted: string[] = [];
    page.on("request", request => { if (request.method() === "DELETE") deleted.push(new URL(request.url()).pathname); });
    const endpoint = surface === "normal" ? "**/conversations/attachments**" : "**/teammates/p2_upload_teammate/direct-attachments**";
    await page.route(endpoint, async route => {
      if (route.request().method() !== "POST") return route.fallback();
      held.started(); await held.wait; return route.fallback();
    });
    await composer.locator('input[type="file"]').setInputFiles({ name: "detached.txt", mimeType: "text/plain", buffer: Buffer.from("detached") });
    await held.requested;
    await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Engineering", exact: true }).click();
    const other = page.getByLabel("Channel composer", { exact: true });
    await other.getByRole("textbox").fill("Keep the newly selected channel draft");
    held.release();
    await expect.poll(() => deleted.length).toBe(1);
    expect(deleted).toEqual([surface === "normal" ? "/attachments/conv_att_1" : "/attachments/tpatt_1"]);
    await expect(other.locator(".composer-preview-card")).toHaveCount(0);
    await expect(other.getByRole("textbox")).toHaveAttribute("data-value", "Keep the newly selected channel draft");
  });
}

test("channel leaving the composer cleans cached unbound drafts from every detached channel", async ({ page }) => {
  const { composer, state } = await openSurface(page, "channel");
  const deleted: string[] = [];
  page.on("request", request => { if (request.method() === "DELETE") deleted.push(new URL(request.url()).pathname); });
  await composer.locator('input[type="file"]').setInputFiles({ name: "cached.txt", mimeType: "text/plain", buffer: Buffer.from("cached") });
  await expect(composer.locator(".composer-preview-card")).toHaveClass(/ready/);
  const sidebar = page.getByRole("complementary", { name: /Sidebar display/ });
  await sidebar.getByRole("button", { name: "P2 Other", exact: true }).click();
  await expect(composer.locator(".composer-preview-card")).toHaveCount(0);
  expect(deleted).toEqual([]);
  await sidebar.getByRole("button", { name: "P2 Upload", exact: true }).click();
  await expect(page.getByLabel("Private chat composer", { exact: true })).toBeVisible();
  await expect.poll(() => deleted).toEqual(["/attachments/att_1"]);
  expect(state.channelAttachments).toHaveLength(0);
});

for (const surface of ["normal", "private", "channel"] as const) {
  test(`${surface} an accepted image preview is released once without deleting its message attachment`, async ({ page }) => {
    await page.addInitScript(() => {
      const created: string[] = [], revoked: string[] = [];
      Object.assign(window, { p2AcceptedPreviewProbe: { created, revoked } });
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = value => { const url = create(value); created.push(url); return url; };
      URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
    });
    const { composer } = await openSurface(page, surface);
    const deleted: string[] = [];
    page.on("request", request => { if (request.method() === "DELETE") deleted.push(new URL(request.url()).pathname); });
    await composer.locator('input[type="file"]').setInputFiles({ name: "accepted.png", mimeType: "image/png", buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64") });
    await expect(composer.locator(".composer-preview-card")).toHaveClass(/ready/);
    await composer.getByRole("textbox").fill("Keep the file attached to this accepted message");
    await composer.getByRole("textbox").press("Enter");
    const feed = page.getByLabel(surface === "normal" ? "Conversation messages" : surface === "private" ? "Private message feed" : "Channel message feed", { exact: true });
    await expect(feed).toContainText("Keep the file attached to this accepted message");
    await expect(composer.locator(".composer-preview-card")).toHaveCount(0);
    const previewState = () => page.evaluate(() => (window as unknown as {
      p2AcceptedPreviewProbe: { created: string[]; revoked: string[] };
    }).p2AcceptedPreviewProbe);
    const initial = await previewState();
    expect(initial.created).toHaveLength(1);
    await expect.poll(async () => (await previewState()).revoked).toEqual(initial.created);
    await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", {
      name: surface === "channel" ? "P2 Upload" : "Engineering", exact: true,
    }).click();
    await expect(page.getByLabel(surface === "channel" ? "Private chat composer" : "Channel composer", { exact: true })).toBeVisible();
    expect(deleted).toEqual([]);
    expect((await previewState()).revoked).toEqual(initial.created);
  });
}

test("private a lost guidance receipt cannot make its accepted attachment removable on the server", async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (new URL(String(args[0]), location.href).pathname.endsWith("/direct-interventions") && args[1]?.method === "POST") {
        await response.text();
        throw new TypeError("Controlled loss after guidance acceptance");
      }
      return response;
    };
  });
  const { composer, state } = await openSurface(page, "private", state => {
    const teammateId = "p2_upload_teammate";
    const now = "2026-10-14T00:00:00.000Z";
    state.teammateDirectMessages = [{ id: "p2-guidance-reply", teammateId,
      threadId: `tdthread_${teammateId}`, authorType: "ai-teammate", body: "Partial original reply", status: "pending", createdAt: now, updatedAt: now }];
    state.workUnits = [{ id: "p2-guidance-work", workspaceId: "workspace_default", kind: "teammate_direct_reply",
      ownerType: "teammate", ownerId: teammateId, teammateId, idempotencyKey: "p2-guidance-work",
      status: "running", priority: 50, attemptCount: 1, activeAttemptId: "p2-guidance-attempt",
      createdByActor: "user", request: { sourceMessageId: "p2-guidance-source" },
      timeoutPolicy: { staleAfterMs: 120000, timeoutAfterMs: 300000 }, linkedMessageId: "p2-guidance-reply",
      createdAt: now, updatedAt: now, startedAt: now }];
  });
  let deletes = 0;
  page.on("request", request => { if (request.method() === "DELETE") deletes++; });
  await composer.locator('input[type="file"]').setInputFiles({ name: "guidance-bound.txt", mimeType: "text/plain", buffer: Buffer.from("bound") });
  await expect(composer.locator(".composer-preview-card")).toHaveClass(/ready/);
  await composer.getByRole("textbox").fill("Continue with the accepted guidance file");
  await composer.getByRole("textbox").press("Enter");
  await expect.poll(() => state.teammateDirectInterventions.length).toBe(1);
  await expect(page.getByText("Pending confirmation", { exact: true })).toBeVisible();
  await capture(page, "private-guidance-receipt-loss");
  await composer.getByRole("button", { name: "Remove pending attachment" }).click();
  await expect(composer.locator(".composer-preview-card")).toHaveCount(0);
  expect(deletes).toBe(0);
});

for (const failure of ["receipt", "refresh"] as const) {
  test(`normal accepted guidance keeps its file bound after ${failure} loss`, async ({ page }) => {
    if (failure === "receipt") await page.addInitScript(() => {
      const fetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await fetch(...args);
        if (/\/runs\/[^/]+\/interventions\?/.test(String(args[0])) && args[1]?.method === "POST") {
          await response.text();
          throw new TypeError("Controlled normal guidance receipt loss");
        }
        return response;
      };
    });
    const { composer, state } = await openSurface(page, "normal", state => {
      installNormalConversationFixture(state);
      const runId = state.runs[0].id;
      state.threads = state.threads.map(thread => ({ ...thread, status: "running", activeRunId: runId }));
      state.turns = state.turns.map(turn => ({ ...turn, status: "running", completedAt: undefined }));
      state.runs = state.runs.map(run => ({ ...run, status: "running", endedAt: undefined }));
    });
    await page.getByRole("button", { name: /Open recent conversation \d+/ }).filter({ hasText: normalConversationFixtureTitle }).click();
    await expect(composer.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    await expect(composer.locator('input[type="file"]')).toBeEnabled();
    let deletes = 0;
    page.on("request", request => { if (request.method() === "DELETE") deletes++; });
    if (failure === "refresh") await page.route("**/conversations/thread_desktop_chrome?**", route => {
      if (!state.runInterventions.length) return route.fallback();
      return route.fulfill({ status: 503, json: { message: "Controlled normal guidance refresh loss" } });
    });
    await composer.locator('input[type="file"]').setInputFiles({ name: "normal-guidance.txt", mimeType: "text/plain", buffer: Buffer.from("bound guidance") });
    await expect(composer.locator(".composer-preview-card")).toHaveClass(/ready/);
    await composer.getByRole("textbox").fill("Use this file for the original reply");
    await composer.getByRole("textbox").press("Enter");
    await expect.poll(() => state.runInterventions.length).toBe(1);
    await expect(page.getByText(failure === "receipt" ? "Pending confirmation" : `Controlled normal guidance ${failure} loss`, { exact: true })).toBeVisible();
    if (failure === "receipt") {
      await composer.getByRole("button", { name: "Remove pending attachment" }).click();
    } else {
      await expect(composer.getByRole("textbox")).toHaveAttribute("data-value", "");
    }
    await expect(composer.locator(".composer-preview-card")).toHaveCount(0);
    await capture(page, `normal-guidance-${failure}-loss`);
    await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Engineering", exact: true }).click();
    await expect(page.getByLabel("Channel composer", { exact: true })).toBeVisible();
    expect(deletes).toBe(0);
  });
}
