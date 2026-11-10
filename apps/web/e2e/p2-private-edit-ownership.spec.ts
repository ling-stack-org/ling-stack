import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate } from "./support/mock-state";

const evidence = process.env.LING_P2_EVIDENCE_DIR ?? fileURLToPath(new URL("../../../.ling-stack/acceptance/p2-ux2-completion-20261015/screenshots/", import.meta.url));
const now = "2026-10-15T00:00:00.000Z";

for (const action of ["edit", "replacement"] as const) {
for (const theme of ["light", "dark"] as const) {
test(`late private ${action} cannot change the next teammate's state in ${theme}`, async ({ page }) => {
  await page.setViewportSize(theme === "light" ? { width: 1440, height: 960 } : { width: 1280, height: 800 });
  await page.addInitScript(theme => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const selection = JSON.stringify({ themeId: `ling-${theme}`, mode: "fixed" });
    for (const key of ["ling-stack.themeSelection", "ling-stack.themeBootstrapSelection"]) localStorage.setItem(key, selection);
    for (const key of ["ling-stack.themePreference", "ling-stack.themeBootstrapPreference"]) localStorage.setItem(key, theme);
  }, theme);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "edit-provider" })];
  state.workspaceSettings.defaultProviderPresetId = state.providers[0].id;
  state.aiTeammates = ["Original", "Current"].map(name => createMockTeammate({ id: `edit-${name}`, displayName: `${name} Editor`,
    providerPresetId: state.providers[0].id }));
  state.teammateDirectMessages = ["Original", "Current"].map(name => ({ id: `edit-message-${name}`,
    workspaceId: "workspace_default", teammateId: `edit-${name}`, threadId: `tdthread_edit-${name}`,
    authorType: "local-user", authorId: "local-user", body: `${name} private prompt`,
    attachmentIds: [], linkPreviewIds: [], fileRefs: [], status: "ready", revision: 2,
    ...(action === "replacement" ? { pendingReplacement: { supersessionId: `supersession-${name}`,
      idempotencyKey: `replacement-${name}`, failureReason: `${name} response unavailable` } } : {}),
    createdAt: now, updatedAt: now }));
  await mockDaemon(page, state);
  const releases = new Map<string, () => void>();
  const posts: Record<string, unknown>[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource: the server responded with a status of 503")) errors.push(message.text());
  });
  await page.route(url => url.pathname === "/conversation-message-edits", async route => {
    const body = route.request().postDataJSON();
    posts.push(body);
    await new Promise<void>(resolve => { releases.set(body.ownerId, resolve); });
    await route.fulfill({ status: 503, json: { error: `Late ${body.ownerId} failure` } });
  });
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: /Sidebar display/ });
  const feed = page.getByLabel("Private message feed", { exact: true });
  const row = feed.locator(".teammate-message-row.local-user");
  async function start(name: string) {
    await sidebar.getByRole("button", { name: `${name} Editor`, exact: true }).click();
    await expect(feed).toContainText(`${name} private prompt`);
    if (action === "edit") {
      await row.hover();
      await row.getByRole("button", { name: "Edit message", exact: true }).click();
      await feed.getByLabel("Edit message", { exact: true }).fill(`${name} revised private prompt`);
      await expect(feed.getByRole("button", { name: "Save and resend", exact: true })).toBeEnabled();
      await feed.getByRole("button", { name: "Save and resend", exact: true }).click();
    } else await row.getByRole("button", { name: "Retry response", exact: true }).click();
    await expect.poll(() => releases.has(`edit-${name}`)).toBe(true);
  }
  try {
    await start("Original");
    await start("Current");
    const oldResponse = page.waitForResponse(response => response.url().includes("/conversation-message-edits")
      && response.request().postDataJSON().ownerId === "edit-Original");
    releases.get("edit-Original")!();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect.poll(() => page.locator(".teammate-message-error").count()).toBe(0);
    // The current request remains pending after the old request's finally ran.
    await expect(feed.getByRole("button", { name: action === "edit" ? "Save and resend" : "Retry response", exact: true })).toBeDisabled();
    await expect(feed).not.toContainText("Late edit-Original failure");
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/private-${action}-late-owner-${theme}.png`, fullPage: true });
    releases.get("edit-Current")!();
    await expect(feed).toContainText("Late edit-Current failure");
    expect(posts.map(body => body.ownerId)).toEqual(["edit-Original", "edit-Current"]);
    if (action === "replacement") expect(posts.map(body => body.idempotencyKey)).toEqual(["replacement-Original", "replacement-Current"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { for (const release of releases.values()) release(); }
});
}
}
