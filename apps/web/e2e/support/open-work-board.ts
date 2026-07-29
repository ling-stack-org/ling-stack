import type { Page } from "@playwright/test";
import { openPendingInbox } from "./pending-primary-navigation";

export async function openWorkBoardFromInbox(page: Page): Promise<void> {
  await openPendingInbox(page);
  await page.getByRole("button", { name: /^(Open Work Board|打开工作看板)$/ }).first().click();
}
