import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider } from "./support/mock-state";
import { installNormalConversationFixture, normalConversationFixtureTitle } from "./support/normal-conversation-fixture";

const evidenceDir = process.env.LING_P2_EVIDENCE_DIR ?? fileURLToPath(new URL("../../../.ling-stack/acceptance/p2-ux2-attachments-20261014/", import.meta.url));

test("normal attachment selection waits for the selected conversation scope, then retains the ready file", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "readiness-provider", lastCheck: {
    ok: true, code: "ready", message: "Controlled readiness fixture", checkedAt: "2026-10-15T00:00:00.000Z",
  } })];
  state.workspaceSettings.defaultProviderPresetId = state.providers[0].id;
  state.approvals = [];
  installNormalConversationFixture(state);
  const threadId = state.threads[0].id;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  const uploads: Record<string, unknown>[] = [];
  const deletes: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/conversations/attachments") uploads.push(request.postDataJSON());
    if (request.method() === "DELETE") deletes.push(path);
  });
  await mockDaemon(page, state);
  await page.route(url => url.pathname === `/conversations/${threadId}`, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    requested = true;
    await held;
    return route.fallback();
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Open recent conversation \d+/ }).filter({ hasText: normalConversationFixtureTitle }).click();
  await expect.poll(() => requested).toBe(true);
  const composer = page.getByLabel("New conversation composer", { exact: true });
  const input = composer.locator('input[type="file"]');
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: `${evidenceDir}normal-selected-scope-loading.png`, animations: "disabled" });
  await expect(input).toBeDisabled();
  await expect(composer.getByRole("textbox")).toHaveAttribute("aria-readonly", "true");
  expect(uploads).toEqual([]);
  release();
  await expect(input).toBeEnabled();
  await expect(composer.getByRole("textbox")).not.toHaveAttribute("aria-readonly", "true");
  await input.setInputFiles({ name: "selected-scope.txt", mimeType: "text/plain", buffer: Buffer.from("Selected conversation only") });
  const file = composer.locator(".composer-preview-card");
  await expect(file).toHaveClass(/ready/);
  await expect(file).toContainText("selected-scope.txt");
  expect(uploads).toHaveLength(1);
  expect(uploads[0].threadId).toBe(threadId);
  expect(deletes).toEqual([]);
  await page.screenshot({ path: `${evidenceDir}normal-selected-scope-attachment-ready.png`, animations: "disabled" });
  expect(errors).toEqual([]);
});
