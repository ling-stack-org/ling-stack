import { expect, type Locator, type Page } from "@playwright/test";

export async function openPendingInbox(page: Page): Promise<Locator> {
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  const pendingEntry = navigation.locator('[data-pending-primary-view="approvals"]');
  await expect(pendingEntry).toBeHidden();
  await pendingEntry.evaluate((element) => (element as HTMLElement).click());
  const surface = page.locator("[data-approvals-ui2-page]");
  await expect(surface).toBeVisible();
  return surface;
}
