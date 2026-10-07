import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { transcriptBatchScaleFixture } from "./support/transcript-batch-scale-fixture";

for (const kind of ["read", "command"] as const) {
  for (const count of [10, 1_000, 10_000] as const) {
    test(`synthetic ${count} ${kind} batch retains bounded mounted facts when expanded`, async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      const fixture = transcriptBatchScaleFixture(kind, count);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
      await mockDaemon(page, fixture.state);
      await page.route(new RegExp(`/conversations/${fixture.detail.thread.id}(?:\\?.*)?$`),
        (route) => route.fulfill({ json: fixture.detail }));
      await page.goto("/");
      await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: fixture.title }).click();
      const feed = page.getByLabel("Conversation page").getByLabel("Conversation messages", { exact: true });
      const timeline = feed.locator('[data-conversation-timeline="true"][data-conversation-timeline-depth="0"]');
      const batchKind = kind === "read" ? "exploration" : "command";
      const batch = timeline.locator(`[data-conversation-batch-kind="${batchKind}"]`);
      const header = batch.locator(`.conversation-${batchKind}-batch-header`);
      await expect(batch).toHaveCount(1);
      await expect(batch).toHaveAttribute("data-conversation-batch-count", String(count));
      await expect(header).toHaveAttribute("aria-expanded", "false");
      const allActionIds = await batch.getAttribute("data-conversation-batch-action-ids");
      expect(allActionIds?.split(",")).toEqual(fixture.state.executionActions.map((action) => action.id));
      await page.evaluate(({ size, kind }) => {
        const label = document.createElement("div");
        label.textContent = `SIMULATION · ${size.toLocaleString()} ${kind} operations · batch DOM probe`;
        label.style.cssText = "position:fixed;right:12px;top:6px;z-index:99999;background:#fff3cd;color:#3d3100;padding:6px;font:12px sans-serif";
        document.body.append(label);
      }, { size: count, kind });
      await header.click();
      await expect(header).toHaveAttribute("aria-expanded", "true");
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const sample = await timeline.evaluate((root, factKind) => ({
        mountedFacts: root.querySelectorAll(`[data-conversation-timeline-kind="${factKind}"]`).length,
        domNodes: root.querySelectorAll("*").length,
        potentialRows: Number(root.getAttribute("data-conversation-timeline-potential-row-count")),
        visibleRows: Number(root.getAttribute("data-conversation-timeline-visible-row-count")),
        rootVirtualizers: root.querySelectorAll(":scope > .conversation-timeline-virtualizer").length,
        nestedVirtualizers: root.querySelectorAll(".conversation-timeline-virtualizer .conversation-timeline-virtualizer").length,
        nestedTimelines: root.querySelectorAll('[data-conversation-timeline="true"]').length,
      }), kind === "read" ? "exploration" : "commandExecution");
      await writeFile(testInfo.outputPath("simulation-batch-dom.json"), JSON.stringify({
        capturedAt: new Date().toISOString(), simulation: true, count, kind, surface: "normal", sample,
        browser: page.context().browser()?.version(),
        methodology: "Real AppShell/shared Timeline; synthetic Host-shaped actions, not actual tool executions. Expanded DOM sampled after two animation frames. No full-page screenshot or real history access.",
      }, null, 2));
      await page.screenshot({ path: testInfo.outputPath(`simulation-${kind}-${count}-expanded.png`) });
      expect(errors).toEqual([]);
      expect(sample.mountedFacts).toBeGreaterThan(0);
      expect(sample.mountedFacts).toBeLessThanOrEqual(count === 10 ? 10 : 60);
      expect(sample.potentialRows).toBe(count + 3);
      expect(sample.visibleRows).toBe(count + 3);
      expect(sample.rootVirtualizers).toBe(count === 10 ? 0 : 1);
      expect(sample.nestedVirtualizers).toBe(0);
      expect(sample.nestedTimelines).toBe(0);
      // Windowing must preserve reachability, not merely mount fewer facts.
      const factKind = kind === "read" ? "exploration" : "commandExecution";
      const fact = (ordinal: number) => timeline.locator(`[data-conversation-timeline-kind="${factKind}"][data-conversation-action-id="batch-scale-${kind}-${ordinal}"]`);
      await feed.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
      await expect(fact(count)).toBeVisible();
      expect(await timeline.locator(`[data-conversation-timeline-kind="${factKind}"]`).count()).toBeLessThanOrEqual(count === 10 ? 10 : 60);
      await feed.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
      await expect(fact(1)).toBeVisible();
    });
  }
}
