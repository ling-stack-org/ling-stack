import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/quick-theme-first-run/",
  import.meta.url,
));

test("First Run opens softly, skip survives refresh, and leaves the application usable", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [];
  await mockDaemon(page, state, { firstRunPreference: "unset" });
  await page.goto("/");

  const dialog = page.getByRole("dialog", { name: "Get started with Ling" });
  await expect(dialog).toBeVisible();
  await page.screenshot({ animations: "disabled", path: `${evidenceDirectory}1440x960-ling-light-first-run.png` });
  await expect(dialog.getByRole("button", { name: "Skip for now" }).last()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Ling Stack navigation")).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ling-first-run:v1") ?? "null")?.status)).toBe("skipped");

  await page.evaluate(() => localStorage.removeItem("ling-first-run:v1"));
  await page.reload();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Skip for now" }).last().click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Ling Stack navigation")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("dialog", { name: "Get started with Ling" })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ling-first-run:v1") ?? "null")?.status)).toBe("skipped");
});

test("First Run remains readable in compact dark mode", async ({ page }) => {
  await useEnglishLocale(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [];
  state.workspaceSettings.theme = "dark";
  await mockDaemon(page, state, { firstRunPreference: "unset" });
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect(page.getByRole("dialog", { name: "Get started with Ling" })).toBeVisible();
  await page.screenshot({ animations: "disabled", path: `${evidenceDirectory}1280x800-ling-dark-first-run.png` });
});

test("First Run stays silent for a ready installation and records completion", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    lastCheck: { ok: true, message: "ok", checkedAt: "2026-07-30T00:00:00.000Z" },
  })];
  await mockDaemon(page, state, { firstRunPreference: "unset" });
  await page.goto("/");

  await expect(page.getByRole("dialog", { name: "Get started with Ling" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("ling-first-run:v1") ?? "null")?.status)).toBe("completed");
});

test("First Run sends model repair to the existing Model Workbench owner", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [];
  await mockDaemon(page, state, { firstRunPreference: "unset" });
  await page.goto("/");

  const dialog = page.getByRole("dialog", { name: "Get started with Ling" });
  await expect(dialog).toContainText("Connect a model");
  await dialog.getByRole("button", { name: "Open Model Workbench" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: /Model Workbench/ })).toHaveClass(/active/);
});

async function useEnglishLocale(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
}
