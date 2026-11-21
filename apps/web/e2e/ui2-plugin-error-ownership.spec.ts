import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const domainPath = fileURLToPath(new URL("../src/domains/plugins/use-plugins-domain.ts", import.meta.url));
const controllerPath = fileURLToPath(new URL("../src/features/plugins/usePluginManagerController.ts", import.meta.url));
const pagePath = fileURLToPath(new URL("../src/features/plugins/PluginManagerPage.tsx", import.meta.url));
const appShellPath = fileURLToPath(new URL("../src/app/AppShell.tsx", import.meta.url));
const guardPath = fileURLToPath(new URL("../scripts/check-ui2-feedback.mjs", import.meta.url));
const fencePath = fileURLToPath(new URL("../src/domains/plugins/plugin-action-fence.ts", import.meta.url));

test("plugin errors remain scoped to the marketplace and explicit action owners", async () => {
  const [domain, controller, pluginPage, appShell, guard, fence] = await Promise.all([
    readFile(domainPath, "utf8"),
    readFile(controllerPath, "utf8"),
    readFile(pagePath, "utf8"),
    readFile(appShellPath, "utf8"),
    readFile(guardPath, "utf8"),
    readFile(fencePath, "utf8"),
  ]);
  expect(domain).not.toContain("setErrorMessage");
  expect(domain).toContain("actionFenceRef.current.isLatest(action)");
  expect(domain).toContain("clearPluginActionErrors(request.owner");
  expect(controller).toContain("findLatestOwnedAction");
  expect(controller).toContain('requested === "row" && candidate === "detected-connect"');
  for (const action of ["apply", "check", "validate", "install", "refresh-package", "runtime-preview", "enable", "disable", "connect", "uninstall"]) {
    expect(pluginPage, `${action} must pass through the focused owner controller`).toContain(`action: "${action}"`);
  }
  expect(appShell).toContain("loadError={pluginsLoadError}");
  expect(appShell).toContain("actionErrors={pluginManagerActionErrors}");
  expect(appShell).toContain("pendingActions={pluginManagerPendingActions}");
  expect(fence).toContain('`${action.pluginId}:${family}:${action.owner}`');
  expect(guard).toContain('"apps/web/src/domains/plugins/use-plugins-domain.ts",');
});

async function openPluginManager(page: Page): Promise<void> {
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  await navigation.getByRole("button", { name: "Engineering", exact: true }).click();
  await navigation.getByRole("button", { name: /Plugin Manager|插件管理/u }).click();
  await expect(page.getByRole("region", { name: /Official|官方/u })).toBeVisible();
}

test("catalog load failure stays on the plugin page and is retryable", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.route("**/plugins/catalog**", async (route) => {
    await route.fulfill({ status: 503, json: { error: "plugin_catalog_unavailable", message: "Synthetic Plugin catalog failure" } });
  });
  await page.goto("/");
  await openPluginManager(page);
  const failure = page.locator(".plugin-marketplace-empty");
  await expect(failure).toContainText("Official plugin source unavailable");
  await expect(failure).toContainText("Synthetic Plugin catalog failure");
  await expect(failure.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.locator(".plugin-marketplace-row")).toHaveCount(0);
  await expect(page.locator("[data-ling-overlay='toast'][data-tone='error']")).toHaveCount(0);
});
