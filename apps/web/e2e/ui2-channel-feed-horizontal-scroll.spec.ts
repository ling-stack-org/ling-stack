import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd, defaultRuntimePolicy } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

test("channel feed keeps horizontal gestures contained and resets stale offset", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });

  const state = createBaseState({ approvalStatus: "expired" });
  state.channels.push({
    id: "channel_general",
    workspaceId: "workspace_default",
    name: "General",
    status: "active",
    boundPath: cwd,
    defaultTeammateId: "engineer",
    autoReplyMode: "mentions_only",
    allowedTools: ["read", "grep", "find", "ls"],
    runtimePolicy: defaultRuntimePolicy,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  });
  state.channelMessages = Array.from({ length: 12 }, (_, index) => ({
    id: `horizontal_feed_message_${index + 1}`,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "local-user",
    body: `Horizontal feed regression message ${index + 1}.`,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: `2026-08-26T00:${String(index).padStart(2, "0")}:00.000Z`,
    updatedAt: `2026-08-26T00:${String(index).padStart(2, "0")}:00.000Z`,
  }));
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel("Channel message feed");
  await expect(feed).toBeVisible();
  await expect.poll(() => feed.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
  await expect.poll(() => feed.evaluate((element) => getComputedStyle(element).overflowX)).toBe("hidden");

  const initialMetrics = await feed.evaluate((element) => {
    const probe = document.createElement("div");
    probe.dataset.testHorizontalOverflowProbe = "true";
    probe.style.cssText = "flex: 0 0 auto; width: calc(100% + 240px); height: 1px; pointer-events: none;";
    element.append(probe);
    element.scrollLeft = 0;
    return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, scrollLeft: element.scrollLeft };
  });
  expect(initialMetrics.scrollWidth).toBeGreaterThan(initialMetrics.clientWidth);
  await feed.hover();
  await page.mouse.wheel(240, 0);
  await expect.poll(() => feed.evaluate((element) => element.scrollLeft)).toBe(0);

  const offsetBeforeLatest = await feed.evaluate((element) => {
    element.scrollTop = 0;
    element.scrollLeft = 96;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    return element.scrollLeft;
  });
  expect(offsetBeforeLatest).toBeGreaterThan(0);
  const latestButton = page.getByRole("button", { name: "Jump to latest message" });
  await expect(latestButton).toBeVisible();
  await latestButton.click();
  await expect.poll(() => feed.evaluate((element) => element.scrollLeft)).toBe(0);

  const offsetBeforeReset = await feed.evaluate((element) => {
    element.scrollLeft = 96;
    return element.scrollLeft;
  });
  expect(offsetBeforeReset).toBeGreaterThan(0);
  await page.getByRole("button", { name: "General", exact: true }).click();
  await expect(feed).toBeVisible();
  await page.getByRole("button", { name: "Engineering", exact: true }).click();
  await expect.poll(() => feed.evaluate((element) => element.scrollLeft)).toBe(0);
});
