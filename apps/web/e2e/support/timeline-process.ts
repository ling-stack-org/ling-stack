import { expect, type Locator } from "@playwright/test";

/** Open the mounted view-only process entrances before checking their facts. */
export async function expandTimelineProcesses(timeline: Locator): Promise<void> {
  const headers = timeline.locator("[data-conversation-process-header]");
  // Live narration has no outer fold. Opening a completed process can also
  // mount an inner operation fold, so inspect the current count each time.
  for (let index = 0; index < await headers.count(); index++) {
    const header = headers.nth(index);
    if (await header.getAttribute("aria-expanded") === "false") await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "true");
  }
}
