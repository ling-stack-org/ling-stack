import { writeFile } from "node:fs/promises";
import { expect, test, type Locator } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { transcriptDomScaleFixture } from "./support/transcript-dom-scale-fixture";

async function countMountedTimeline(timeline: Locator) {
  return timeline.evaluate((root) => ({
    mountedRows: root.querySelectorAll('[data-conversation-timeline-kind][data-conversation-timeline-depth="0"]').length,
    domNodes: root.querySelectorAll('*').length,
    rootVirtualizers: root.querySelectorAll(':scope > .conversation-timeline-virtualizer').length,
    nestedVirtualizers: root.querySelectorAll('.conversation-timeline-virtualizer .conversation-timeline-virtualizer').length,
    nestedTimelines: root.querySelectorAll('[data-conversation-timeline="true"]').length,
  }));
}

for (const count of [10, 1_000, 10_000] as const) {
  test(`synthetic ${count} atomic messages retain bounded DOM and reachable history`, async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const fixture = transcriptDomScaleFixture(count);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
    await mockDaemon(page, fixture.state);
    await page.route(new RegExp(`/conversations/${fixture.detail.thread.id}(?:\\?.*)?$`),
      (route) => route.fulfill({ json: fixture.detail }));
    await page.goto("/");
    await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: fixture.title }).click();
    const conversationPage = page.getByLabel("Conversation page");
    const feed = conversationPage.getByLabel("Conversation messages", { exact: true });
    const timeline = feed.locator('[data-conversation-timeline="true"][data-conversation-timeline-depth="0"]');
    await expect(timeline).toHaveCount(1);
    await expect(timeline).toHaveAttribute("data-conversation-timeline-potential-row-count", String(count));
    await expect(timeline).toHaveAttribute("data-conversation-timeline-visible-row-count", String(count));
    await expect(timeline.getByText(`Scale assistant ${count / 2}`, { exact: true })).toBeVisible();
    await page.evaluate((size) => {
      const label = document.createElement("div");
      label.textContent = `SIMULATION · ${size.toLocaleString()} atomic messages · DOM scale fixture`;
      label.style.cssText = "position:fixed;right:12px;top:6px;z-index:99999;background:#fff3cd;color:#3d3100;padding:6px;font:12px sans-serif";
      document.body.append(label);
    }, count);
    const samples = [];
    for (const position of ["bottom", "top", "middle"] as const) {
      await feed.evaluate((element, where) => {
        element.scrollTop = where === "top" ? 0 : where === "middle" ? element.scrollHeight / 2 : element.scrollHeight;
        element.dispatchEvent(new Event("scroll", { bubbles: true }));
      }, position);
      if (position === "top") await expect(timeline.getByText("Scale user 1", { exact: true })).toBeVisible();
      if (position === "bottom") await expect(timeline.getByText(`Scale assistant ${count / 2}`, { exact: true })).toBeVisible();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const sample = { position, ...await countMountedTimeline(timeline) };
      expect(sample.mountedRows).toBeGreaterThan(0);
      expect(sample.mountedRows).toBeLessThanOrEqual(count === 10 ? 10 : 60);
      expect(sample.rootVirtualizers).toBe(count === 10 ? 0 : 1);
      expect(sample.nestedVirtualizers).toBe(0);
      expect(sample.nestedTimelines).toBe(0);
      samples.push(sample);
      await page.screenshot({ path: testInfo.outputPath(`simulation-${count}-${position}.png`) });
    }
    const scrollOwners = await conversationPage.evaluate((root) => Array.from(root.querySelectorAll<HTMLElement>("*"))
      .filter((element) => /^(auto|scroll)$/u.test(getComputedStyle(element).overflowY)
        && element.scrollHeight > element.clientHeight + 1).map((element) => element.className));
    // Long histories also scroll their independent navigation marks, outside the feed.
    expect(scrollOwners).toEqual(count === 10
      ? [expect.stringContaining("normal-conversation-feed")]
      : [expect.stringContaining("normal-conversation-feed"), "conversation-position-rail__marks"]);
    if (count > 10) {
      const rail = conversationPage.getByRole("complementary", { name: "Conversation navigation", exact: true });
      await expect(rail).toBeVisible();
      expect(await feed.locator(".conversation-position-rail").count()).toBe(0);
      await expect(rail.locator(".conversation-position-rail__marks")).toHaveCSS("overflow-y", "auto");
    }
    expect(errors).toEqual([]);
    await writeFile(testInfo.outputPath("simulation-dom-counts.json"), JSON.stringify({
      capturedAt: new Date().toISOString(), simulation: true, count, surface: "normal", samples, scrollOwners,
      browser: page.context().browser()?.version(),
      methodology: "Real AppShell/shared Timeline, synthetic canonical DTO. Sampled top/middle/bottom DOM, not all transient peaks or a packaged run. Exact potential/visible logical row counts prove records were not truncated.",
    }, null, 2));
  });
}
