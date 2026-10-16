import { writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

interface ExpansionSample {
  durationMs: number;
  mountedChildren: number;
  depthMarkedElements: number;
  rootVirtualizers: number;
  nestedVirtualizers: number;
  timelineDomNodes: number;
}

/** Measure the existing synthetic AppShell fixture, never a model/packaged run. */
export async function measureTranscriptDisclosure(
  page: Page, disclosure: Locator, testInfo: TestInfo,
  { fixtureChildCount, expectedRootVirtualizers }: { readonly fixtureChildCount: number; readonly expectedRootVirtualizers: 0 | 1 },
): Promise<void> {
  const samples: ExpansionSample[] = [];
  for (let iteration = -3; iteration < 20; iteration += 1) {
    await disclosure.scrollIntoViewIfNeeded();
    if (await disclosure.getAttribute("aria-expanded") === "true") await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await disclosure.evaluate((button) => {
      const target = button as HTMLButtonElement;
      const timeline = target.closest('[data-conversation-timeline][data-conversation-timeline-depth="0"]')!;
      const measurement = new Promise<ExpansionSample>((resolve, reject) => {
        target.addEventListener("click", () => {
          const start = performance.now();
          const checkFrame = (): void => {
            const groupId = target.getAttribute("aria-controls");
            const group = groupId ? document.getElementById(groupId) : null;
            const children = group?.querySelectorAll('.conversation-timeline-focus-block[data-conversation-timeline-depth="1"]');
            if (target.getAttribute("aria-expanded") === "true" && children?.length) {
              // One additional frame permits paint; exclude Playwright round-trip time.
              requestAnimationFrame(() => resolve({
                durationMs: performance.now() - start,
                mountedChildren: children.length,
                depthMarkedElements: group!.querySelectorAll('[data-conversation-timeline-depth="1"]').length,
                rootVirtualizers: timeline.querySelectorAll(':scope > .conversation-timeline-virtualizer').length,
                nestedVirtualizers: group!.querySelectorAll('.conversation-timeline-virtualizer').length,
                timelineDomNodes: timeline.querySelectorAll('*').length,
              }));
            } else if (performance.now() - start > 2_000) reject(new Error("Child rows did not mount within 2s"));
            else requestAnimationFrame(checkFrame);
          };
          requestAnimationFrame(checkFrame);
        }, { once: true, capture: true });
      });
      Object.assign(globalThis, { __lingG08Measurement: measurement });
    });
    await disclosure.click();
    const sample = await page.evaluate(() => (
      globalThis as typeof globalThis & { __lingG08Measurement: Promise<ExpansionSample> }
    ).__lingG08Measurement);
    expect(sample.mountedChildren).toBeGreaterThan(0);
    expect(sample.mountedChildren).toBeLessThanOrEqual(48);
    expect(sample.rootVirtualizers).toBe(expectedRootVirtualizers);
    expect(sample.nestedVirtualizers).toBe(0);
    if (iteration >= 0) samples.push(sample);
  }
  const ordered = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const result = {
    capturedAt: new Date().toISOString(), simulation: true, fixtureChildCount,
    sampleCount: samples.length, warmupCount: 3, samples,
    p50Ms: ordered[Math.ceil(ordered.length * .5) - 1],
    p95Ms: ordered[Math.ceil(ordered.length * .95) - 1], maxMs: ordered.at(-1),
    runtime: { browser: page.context().browser()?.version(), node: process.version, cpu: cpus()[0]?.model },
    methodology: "Trusted browser click capture to mounted child rows plus one animation frame. 20 warmed expansions, nearest-rank p95. Synthetic input through the production Timeline, not packaged GUI. No pre-fix browser baseline; only existing absolute local <100ms target.",
  };
  await writeFile(testInfo.outputPath(`simulation-${fixtureChildCount}-child-performance.json`), JSON.stringify(result, null, 2));
  await testInfo.attach("simulation-child-performance", { body: JSON.stringify(result), contentType: "application/json" });
  await page.evaluate(count => {
    const label = document.createElement("div");
    label.textContent = `SIMULATION · ${count} child rows · local performance fixture`;
    label.style.cssText = "position:fixed;right:12px;top:6px;z-index:99999;background:#fff3cd;color:#3d3100;padding:6px;font:12px sans-serif";
    document.body.append(label);
  }, fixtureChildCount);
  await page.screenshot({ path: testInfo.outputPath(`simulation-${fixtureChildCount}-child-expanded.png`) });
  expect(result.p95Ms).toBeLessThan(100);
}
