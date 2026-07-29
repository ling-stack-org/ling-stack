import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd } from "./support/mock-state";

test("shared Toast deduplicates Profile saves and pauses while hovered", async ({ page }, testInfo) => {
  const browserErrors = captureBrowserErrors(page);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "light");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await mockControlPlaneReads(page);
  await page.goto("/");
  await openProfileSettings(page);

  await saveDisplayName(page, "UI Two User");
  const toast = page.locator('.ling-ui-toast[data-scope="profile:save"]');
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText("Profile saved");
  await expect(toast).toHaveAttribute("data-tone", "success");

  await saveDisplayName(page, "UI Two User Updated");
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText("Profile saved");
  await toast.hover();
  await page.waitForTimeout(3_200);
  await expect(toast).toBeVisible();

  await expect(page.locator(".profile-settings-tip, .ling-toast-viewport")).toHaveCount(0);
  await expect(page.locator('[data-profile-section="identity"] .ling-ui-toast')).toHaveCount(0);
  await expectNoPageOverflow(page);
  expect(browserErrors).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("1440x960-ling-light-profile-toast.png"),
    fullPage: true,
  });

  await page.mouse.move(20, 700);
  await expect(toast).toHaveCount(0, { timeout: 4_500 });
});

test("Profile blocking errors remain inline and EmptyState uses the shared primitive in Dark mode", async ({ page }, testInfo) => {
  const browserErrors = captureBrowserErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", "dark");
  });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await mockControlPlaneReads(page);
  await page.route("http://127.0.0.1:17891/profile**", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 500,
        json: { error: { code: "profile_save_failed", message: "Profile storage is temporarily unavailable." } },
      });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  await openProfileSettings(page);

  await saveDisplayName(page, "Unsaved UI Two User");
  const feedback = page.locator(".profile-settings-feedback.ling-ui-inline-feedback");
  await expect(feedback).toBeVisible();
  await expect(feedback).toContainText("Profile needs attention");
  await expect(feedback).toHaveAttribute("data-tone", "danger");
  await expect(page.locator(".ling-ui-toast")).toHaveCount(0);
  await expect(feedback).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("1280x800-ling-dark-profile-inline-error.png"),
    fullPage: true,
  });

  await page.getByLabel("Settings sections").getByRole("button", { name: "Model Workbench" }).click();
  const emptyState = page.locator(".provider-table-shell .ling-ui-empty-state").first();
  await expect(emptyState).toBeVisible();
  await expectNoPageOverflow(page);
  expect(browserErrors.filter((message) => !message.includes("http://127.0.0.1:17891/profile?"))).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("1280x800-ling-dark-model-empty-state.png"),
    fullPage: true,
  });
});

async function openProfileSettings(page: Page): Promise<void> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "User profile" }).click();
  await expect(page.locator('[data-profile-section="identity"]')).toBeVisible();
}

async function saveDisplayName(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Edit display name" }).click();
  const input = page.getByLabel("Display name", { exact: true });
  await input.fill(name);
  await page.locator('[data-profile-section="usage"]').click();
  await expect(input).toHaveCount(0);
}

function captureBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const source = message.location().url;
      errors.push(source ? `${message.text()} @ ${source}` : message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function mockControlPlaneReads(page: Page): Promise<void> {
  await page.route("http://127.0.0.1:17891/control-plane/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/control-plane/snapshot") {
      const requestedDomains = (url.searchParams.get("domains") ?? "")
        .split(",")
        .map((domain) => domain.trim())
        .filter(Boolean);
      const domains = Object.fromEntries(requestedDomains.map((domain) => [domain, {
        ok: false,
        revision: 0,
        error: { code: "fixture_unavailable", message: "Use the mock daemon fallback for this domain." },
      }]));
      await route.fulfill({
        json: {
          cwd,
          workspaceId: "workspace_default",
          generatedAt: "2026-07-18T00:00:00.000Z",
          latestEventSeq: 0,
          domains,
        },
      });
      return;
    }
    if (url.pathname === "/control-plane/stream") {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fallback();
  });
}
