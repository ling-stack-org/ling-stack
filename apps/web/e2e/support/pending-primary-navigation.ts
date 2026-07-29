import { expect, type Locator, type Page } from "@playwright/test";

export async function openPendingInbox(page: Page): Promise<Locator> {
  const navigation = page.getByLabel(/Ling Stack navigation|Ling Stack 导航/);
  const pendingEntry = navigation.locator('[data-pending-primary-view="approvals"]');
  await expect(pendingEntry).toBeHidden();
  await pendingEntry.evaluate((element) => (element as HTMLElement).click());
  const surface = page.locator("[data-approvals-ui2-page]");
  await expect(surface).toBeVisible();
  return surface;
}
