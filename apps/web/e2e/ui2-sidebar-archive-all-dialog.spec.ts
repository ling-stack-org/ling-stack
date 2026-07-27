import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon, type MockLingThread } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/shell/sidebar-archive-all-dialog/",
  import.meta.url,
));

test("archive all conversations uses a busy-safe Dialog and restores focus", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const browserDialogs: string[] = [];
  page.on("dialog", (dialog) => browserDialogs.push(dialog.type()));
  const state = createBaseState({ approvalStatus: "expired" });
  state.threads = [conversationThread("one"), conversationThread("two")];
  await mockDaemon(page, state);
  await page.route(/\/threads\/[^/]+\/archive(?:\?.*)?$/u, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.fallback();
  });
  await page.goto("/");

  const recentActions = page.getByRole("button", { name: "Recent conversation actions" });
  await openArchiveAllDialog(page, recentActions);
  const dialog = page.getByRole("dialog", { name: "Archive all conversations" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await captureEvidence(page, "1440x960-ling-light-archive-all-dialog.png");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(recentActions).toBeFocused();
  expect(state.threads.filter((thread) => thread.archivedAt)).toHaveLength(0);

  await openArchiveAllDialog(page, recentActions);
  const confirm = dialog.getByRole("button", { name: "Archive all conversations" });
  await confirm.click();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(confirm).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator(".sidebar-recent-row")).toHaveCount(0);
  expect(state.threads.every((thread) => Boolean(thread.archivedAt))).toBe(true);
  expect(browserDialogs).toEqual([]);
  expect(runtimeErrors).toEqual([]);
  await captureEvidence(page, "1440x960-ling-light-archive-all-complete.png");
});

test("archive all keeps partial failure visible in the Sidebar", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800, true);
  const runtimeErrors = collectRuntimeErrors(page);
  const browserDialogs: string[] = [];
  page.on("dialog", (dialog) => browserDialogs.push(dialog.type()));
  const state = createBaseState({ approvalStatus: "expired" });
  const blocked = conversationThread("blocked");
  const archived = conversationThread("ready");
  state.threads = [blocked, archived];
  await mockDaemon(page, state);
  await page.route(new RegExp(`/threads/${blocked.id}/archive(?:\\?.*)?$`, "u"), async (route) => {
    await route.fulfill({
      status: 409,
      json: {
        error: "active_thread_archive_blocked",
        message: `Cannot archive thread with active work: ${blocked.id}`,
      },
    });
  });
  await page.goto("/");

  const recentActions = page.getByRole("button", { name: "Recent conversation actions" });
  await openArchiveAllDialog(page, recentActions);
  const dialog = page.getByRole("dialog", { name: "Archive all conversations" });
  await dialog.getByRole("button", { name: "Archive all conversations" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".sidebar-recent-row")).toHaveCount(1);
  await expect(page.getByText("1 conversations still have active work and cannot be archived yet.")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(Boolean(state.threads.find((thread) => thread.id === blocked.id)?.archivedAt)).toBe(false);
  expect(Boolean(state.threads.find((thread) => thread.id === archived.id)?.archivedAt)).toBe(true);
  expect(browserDialogs).toEqual([]);
  expect(runtimeErrors.some((message) => message.includes("409 (Conflict)"))).toBe(true);
  expect(runtimeErrors.filter((message) => !message.includes("409 (Conflict)"))).toEqual([]);
  await captureEvidence(page, "1280x800-ling-dark-archive-all-partial-failure.png");
});

async function openArchiveAllDialog(page: Page, trigger: Locator): Promise<void> {
  await trigger.click();
  await page.getByRole("menuitem", { name: "Archive all conversations" }).click();
  await expect(page.getByRole("dialog", { name: "Archive all conversations" })).toBeVisible();
}

function conversationThread(suffix: string): MockLingThread {
  return {
    id: `thread_sidebar_archive_${suffix}`,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: `Conversation ${suffix}`,
    objective: `Conversation ${suffix}`,
    status: "open",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:01:00.000Z",
    metadata: { lastActivityAt: "2026-07-26T00:01:00.000Z" },
  };
}

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  width: number,
  height: number,
  reducedMotion = false,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  await page.addInitScript((value) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", value);
    localStorage.setItem("ling-stack.themeBootstrapPreference", value);
  }, theme);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
