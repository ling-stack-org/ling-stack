import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";
import { installNormalWorkCellFixture, installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";

// Display fixtures test the real shared renderer, not a model or packaged run.
for (const surface of ["normal", "private", "channel"] as const) {
  test(`${surface} exposes one final result copy outside evidence disclosure`, async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      localStorage.setItem("ling-stack.locale", "en-US");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => {
          (globalThis as typeof globalThis & { __resultCopy?: string }).__resultCopy = text;
        } },
      });
    });
    const state = createBaseState({ approvalStatus: "expired" });
    const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
    const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
    if (surface === "channel") await page.addInitScript(() => localStorage.setItem("ling-stack.workCellDemo", "true"));
    await mockDaemon(page, state);
    await page.goto("/");
    if (title) await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
    if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
    if (surface === "channel") await openEngineeringChannel(page);

    const result = page.locator("[data-conversation-terminal-response]").first();
    await expect(result).toBeVisible();
    const summary = result.locator(".conversation-timeline-result-summary");
    await expect(summary).toBeVisible();
    const summaryText = await summary.innerText();
    expect(summaryText.trim()).not.toBe("");
    const toggle = result.locator(".conversation-timeline-activity-main");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const copy = result.locator(".message-action-bar").getByRole("button", { name: "Copy message", exact: true });
    const actions = result.locator(".message-action-bar");
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS("opacity", "0");
    await result.screenshot({ path: testInfo.outputPath(`fixture-${surface}-copy-hidden.png`) });
    await result.hover();
    await expect(actions).toHaveCSS("opacity", "1");
    await result.screenshot({ path: testInfo.outputPath(`fixture-${surface}-copy-hover.png`) });
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS("opacity", "0");
    await copy.focus();
    await expect(actions).toHaveCSS("opacity", "1");
    await expect(copy).toBeVisible();
    await expect(copy).toHaveCount(1);
    await copy.click();
    const collapsedCopy = await page.evaluate(() => (globalThis as typeof globalThis & { __resultCopy?: string }).__resultCopy);
    expect(collapsedCopy).toContain(summaryText);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(summary).toHaveCount(1);
    await expect(result.locator(".message-action-bar button")).toHaveCount(1);
    await result.locator(".message-action-bar button").click();
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { __resultCopy?: string }).__resultCopy)).toBe(collapsedCopy);
    await page.screenshot({ path: testInfo.outputPath(`fixture-${surface}-final-result-copy.png`) });
  });
}

test.describe('touch result actions', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test('keeps copy discoverable without hover', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('ling-stack.locale', 'en-US');
      localStorage.setItem('ling-stack.workCellDemo', 'true');
    });
    await mockDaemon(page, createBaseState({ approvalStatus: 'expired' }));
    await page.goto('/');
    await page.getByRole('button', { name: 'Channels', exact: true }).click();
    await openEngineeringChannel(page);
    const actions = page.locator('[data-conversation-terminal-response] .message-action-bar').first();
    await expect(actions).toHaveCSS('opacity', '1');
    await expect(actions.getByRole('button', { name: 'Copy message', exact: true })).toBeVisible();
  });
});
