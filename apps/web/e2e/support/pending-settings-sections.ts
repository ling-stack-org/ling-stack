import { expect, type Locator, type Page } from "@playwright/test";

export async function openPendingStartupDiagnostics(page: Page): Promise<Locator> {
  const navigation = page.getByLabel(/Settings sections|设置分组/);
  const pendingEntry = navigation.locator('[data-settings-section="startup-diagnostics"]');
  await expect(pendingEntry).toBeHidden();
  await pendingEntry.evaluate((element) => (element as HTMLElement).click());
  const panel = page.locator("[data-ui2-settings-startup-diagnostics]");
  await expect(panel).toBeVisible();
  return panel;
}
