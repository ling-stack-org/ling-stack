import { expect, type Locator, type Page } from "@playwright/test";

export async function openPendingStartupDiagnostics(page: Page): Promise<Locator> {
  // Startup & diagnostics graduated from the pending placeholder to a
  // first-class section (ux-gap-roadmap-13): the entry is visible and
  // clickable like every other section now.
  const navigation = page.getByLabel(/Settings sections|设置分组/);
  const entry = navigation.locator('[data-settings-section="startup-diagnostics"]');
  await entry.click();
  const panel = page.locator("[data-ui2-settings-startup-diagnostics]");
  await expect(panel).toBeVisible();
  return panel;
}
