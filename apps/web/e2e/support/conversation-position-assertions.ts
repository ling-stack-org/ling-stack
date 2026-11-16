import { expect, type Locator } from "@playwright/test";

export async function expectRailAtSurfaceEdge(feed: Locator): Promise<void> {
  await expect.poll(() => feed.evaluate(element => {
    const frame = element.parentElement!;
    const rail = frame.querySelector<HTMLElement>(".conversation-position-rail");
    const timeline = element.querySelector<HTMLElement>(".conversation-timeline-depth-0");
    if (!rail || rail.hidden || !timeline) return false;
    const frameBox = frame.getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    const feedBox = element.getBoundingClientRect();
    const contentStart = timeline.getBoundingClientRect().x + parseFloat(getComputedStyle(timeline).paddingInlineStart);
    const surface = frame.closest(".activity-chat-main, .teammate-private-feed-owner") ?? frame.parentElement!;
    const surfaceBox = surface.getBoundingClientRect();
    return Math.abs(frameBox.x - surfaceBox.x) <= 1 &&
      Math.abs(frameBox.width - surfaceBox.width) <= 1 &&
      Math.abs(railBox.x - frameBox.x - 2) <= 1 &&
      feedBox.width <= 800 && contentStart >= railBox.right &&
      Math.abs(feedBox.x + feedBox.width / 2 - frameBox.x - frameBox.width / 2) <= 1;
  })).toBe(true);
}
