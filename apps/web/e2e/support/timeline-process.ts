import { expect, type Locator } from "@playwright/test";

/** Open the mounted view-only process entrances before checking their facts. */
export async function expandTimelineProcesses(timeline: Locator): Promise<void> {
  const headers = timeline.locator("[data-conversation-process-header]");
  await expect(headers).not.toHaveCount(0);
  const count = await headers.count();
  for (let index = 0; index < count; index++) {
    const header = headers.nth(index);
    if (await header.getAttribute("aria-expanded") === "false") await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
  }
}
