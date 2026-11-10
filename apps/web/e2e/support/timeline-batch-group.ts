import { expect, type Locator } from "@playwright/test";

/** Follow the header's public ARIA relation, not the former nested fact DOM. */
export async function timelineBatchGroup(batch: Locator): Promise<Locator> {
  const header = batch.locator("button[aria-expanded]").first();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  const id = await header.getAttribute("aria-controls");
  if (!id) throw new Error("Expanded batch is missing its root-window group");
  const group = batch.page().locator(`[id=${JSON.stringify(id)}]`);
  await expect(group).toHaveCount(1);
  return group;
}
