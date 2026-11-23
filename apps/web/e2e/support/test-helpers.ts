import { expect, type Locator } from "@playwright/test";

export {
  channelEventFilterToggle,
  channelEventFilters,
  openEngineeringChannel,
  openChannelChatTools,
  openChannelContextPanel,
  openNewTaskPanel,
  openTaskFromAttentionQueue,
  readHorizontalOverflow,
  readScrollState,
  readSidebarSelection,
} from "./mock-daemon";

export async function expectAboveComposer(status: Locator, composer: Locator): Promise<void> {
  await expect(status).toBeVisible();
  await expect(composer).toBeVisible();
  const statusBox = (await status.boundingBox())!;
  const composerBox = (await composer.boundingBox())!;
  expect(statusBox.y + statusBox.height).toBeLessThanOrEqual(composerBox.y);
  expect(statusBox.x).toBeCloseTo(composerBox.x, 0);
  expect(statusBox.width).toBeCloseTo(composerBox.width, 0);
}
