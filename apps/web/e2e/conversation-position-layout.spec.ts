import { expect, test } from "@playwright/test";
import { expectRailAtSurfaceEdge } from "./support/conversation-position-assertions";

test("navigation stays at the surface edge when the reading column resizes", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => {
    const path = "/e2e/support/p2-reading-harness.tsx";
    const fixture: { mountReadingFixture: (count: number) => unknown } = await import(/* @vite-ignore */ path);
    fixture.mountReadingFixture(36);
  });
  const feed = page.getByLabel("Conversation messages", { exact: true });
  const rail = page.locator(".conversation-position-rail");
  await expect(rail).toBeVisible();
  await expectRailAtSurfaceEdge(feed);
  const railBefore = await rail.boundingBox();
  await page.setViewportSize({ width: 1100, height: 960 });
  await expectRailAtSurfaceEdge(feed);
  expect((await rail.boundingBox())!.x).toBe(railBefore!.x);
  await rail.locator("button[tabindex='0']").hover();
  const preview = await rail.locator(".conversation-position-rail__preview").boundingBox();
  const frame = await feed.locator("..").boundingBox();
  expect(preview!.x).toBeGreaterThanOrEqual(frame!.x);
  expect(preview!.x + preview!.width).toBeLessThanOrEqual(frame!.x + frame!.width);
  await page.setViewportSize({ width: 680, height: 960 });
  await expect(rail).toBeVisible();
  await expectRailAtSurfaceEdge(feed);
  await page.setViewportSize({ width: 540, height: 800 });
  await expect(rail).toBeHidden();
  await expect.poll(() => feed.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath("position-rail-mobile.png") });
});
