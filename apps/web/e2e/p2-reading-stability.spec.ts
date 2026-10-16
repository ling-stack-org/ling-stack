import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ReadingHarness } from "./support/p2-reading-harness";
import type { BatchWindowHarness } from "./support/timeline-batch-window-harness";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const evidenceDir = process.env.LING_P2_EVIDENCE_DIR ?? fileURLToPath(new URL("../../../.ling-stack/acceptance/p2-ux1-20261013/", import.meta.url));

async function mountFixture(page: Page, messageCount = 36) {
  // Load only the production styles and component probe, not a live workspace.
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async messageCount => {
    const path = "/e2e/support/p2-reading-harness.tsx";
    const fixture = await import(/* @vite-ignore */ path);
    window.p2ReadingHarness = fixture.mountReadingFixture(messageCount) as ReadingHarness;
  }, messageCount);
  const feed = page.getByLabel("Conversation messages", { exact: true });
  await expect(feed).toBeVisible();
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(1_000);
  await expect(feed.locator(`[data-feed-item-id="message:agent:reading-message-${messageCount - 1}"], [data-feed-item-id="message:user:reading-message-${messageCount - 1}"]`)).toBeAttached();
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
  return feed;
}

async function readAnchor(feed: Locator) {
  return feed.evaluate(element => {
    const top = element.getBoundingClientRect().top;
    const bottom = element.getBoundingClientRect().bottom;
    const row = Array.from(element.querySelectorAll<HTMLElement>("[data-conversation-row-key]"))
      .find(el => el.getBoundingClientRect().bottom > top + 12 && el.getBoundingClientRect().top < bottom - 12)!;
    return { key: row.dataset.conversationRowKey!, offset: row.getBoundingClientRect().top - top };
  });
}

async function anchorOffset(feed: Locator, key: string) {
  return feed.evaluate((element, key) => {
    const row = Array.from(element.querySelectorAll<HTMLElement>("[data-conversation-row-key]"))
      .find(el => el.dataset.conversationRowKey === key)!;
    return row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
  }, key);
}

async function settleMeasuredScroll(feed: Locator) {
  await feed.evaluate(async element => {
    let previous = "";
    let stableFrames = 0;
    for (let frame = 0; frame < 60; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const current = `${element.scrollTop}:${element.scrollHeight}`;
      stableFrames = current === previous ? stableFrames + 1 : 0;
      if (stableFrames >= 4) return;
      previous = current;
    }
    throw new Error("Virtual row measurements did not settle");
  });
}

for (const change of ["grow", "prepend", "resize", "mediaResize"] as const) {
  test(`reading anchor survives ${change} without browser scroll anchoring`, async ({ page }) => {
    const feed = await mountFixture(page);
    await feed.evaluate(el => { el.style.overflowAnchor = "none"; el.scrollTop = el.scrollHeight / 2; });
    await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
    const before = await readAnchor(feed);
    if (change === "mediaResize") {
      await page.evaluate(() => window.p2ReadingHarness.mediaResize());
    } else if (change === "resize") {
      await page.evaluate(() => window.p2ReadingHarness.resize());
      await expect.poll(() => feed.evaluate(el => el.clientWidth)).toBeLessThan(600);
    } else {
      await page.evaluate(change => change === "grow" ? window.p2ReadingHarness.grow(1) : window.p2ReadingHarness.prepend(), change);
      await expect(feed.getByText(change === "grow" ? /New content above the reader/ : /Earlier history/).first()).toBeAttached();
    }
    await expect.poll(async () => Math.abs((await anchorOffset(feed, before.key)) - before.offset)).toBeLessThanOrEqual(2);
  });
}

test("search pauses tail-follow even before a result scroll", async ({ page }) => {
  const feed = await mountFixture(page);
  await page.evaluate(() => window.p2ReadingHarness.search());
  const before = await readAnchor(feed);
  await page.evaluate(() => window.p2ReadingHarness.append());
  await expect(feed.getByText(/A new incoming message/).first()).toBeAttached();
  await expect.poll(async () => Math.abs((await anchorOffset(feed, before.key)) - before.offset)).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
});

test("keyboard scroll intent is reported without stealing editable or button keys", async ({ page }) => {
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => {
    const path = "/e2e/support/p2-reading-harness.tsx";
    window.p2ScrollIntentHarness = (await import(path)).mountScrollIntentFixture();
  });
  const feed = page.getByLabel("Keyboard reading viewport");
  await feed.focus();
  await page.keyboard.press("PageUp");
  expect(await page.evaluate(() => window.p2ScrollIntentHarness.counts())).toEqual({ intentCount: 1, handlerCount: 1 });
  await page.getByRole("textbox", { name: "Editable message" }).press("ArrowUp");
  await page.getByRole("button", { name: "Disclosure" }).press("Space");
  expect(await page.evaluate(() => window.p2ScrollIntentHarness.counts())).toEqual({ intentCount: 1, handlerCount: 3 });
});

test("switching threads resets follow state instead of inheriting the old reader", async ({ page }) => {
  const feed = await mountFixture(page);
  await feed.evaluate(el => { el.scrollTop = 0; });
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
  await page.evaluate(() => window.p2ReadingHarness.switchThread());
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
});

test("keyboard history reading is not restored back to the old tail", async ({ page }) => {
  const feed = await mountFixture(page);
  await feed.focus();
  await page.keyboard.press("PageUp");
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(100);
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
  await settleMeasuredScroll(feed);
  const before = await readAnchor(feed);
  await page.evaluate(() => window.p2ReadingHarness.stream("New streamed text\n\n".repeat(30)));
  await expect.poll(async () => Math.abs((await anchorOffset(feed, before.key)) - before.offset)).toBeLessThanOrEqual(2);
});

test("starting windowing preserves a history reader instead of resetting scroll", async ({ page }) => {
  const feed = await mountFixture(page, 79);
  await expect(feed.locator("[data-conversation-timeline]")).not.toHaveClass(/virtualized/);
  await feed.evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
  await settleMeasuredScroll(feed);
  const before = await readAnchor(feed);
  await page.evaluate(() => window.p2ReadingHarness.append());
  await expect(feed.locator("[data-conversation-timeline]")).toHaveClass(/virtualized/);
  await expect.poll(async () => Math.abs((await anchorOffset(feed, before.key)) - before.offset)).toBeLessThanOrEqual(2);
});

test("virtualized history prepend keeps the same reading row and offset", async ({ page }) => {
  const feed = await mountFixture(page, 96);
  await expect(feed.locator("[data-conversation-timeline]")).toHaveClass(/virtualized/);
  await feed.evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
  await settleMeasuredScroll(feed);
  const before = await readAnchor(feed);
  await page.evaluate(() => window.p2ReadingHarness.prepend());
  await expect.poll(async () => Math.abs((await anchorOffset(feed, before.key)) - before.offset)).toBeLessThanOrEqual(2);
});

test("reading locator falls back to a collapsed parent without revealing hidden work", async ({ page }) => {
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => {
    const path = "/e2e/support/timeline-batch-window-harness.tsx";
    window.batchWindowHarness = (await import(path)).mountBatchWindowFixture("channel_root", true) as BatchWindowHarness;
  });
  await expect.poll(() => page.evaluate(() => window.batchWindowHarness.ready())).toBe(true);
  const root = page.locator("#batch-window-simulation");
  const parent = root.locator('[data-feed-item-id="simulation-agent-span"]');
  const trigger = parent.getByRole("button", { expanded: false });
  await expect(trigger).toBeVisible();
  const anchor = { rowKey: "unmounted-child", parentSubAgentId: "simulation-agent-span", offsetTop: 0 };
  expect(await page.evaluate(anchor => window.batchWindowHarness.revealReading(anchor), anchor)).toBe("revealed");
  await expect(parent).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(root.locator('[data-feed-item-id="command:1000"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.batchWindowHarness.revealReading({ rowKey: "missing", offsetTop: 0 }))).toBe("not_found");
  await page.evaluate(() => window.batchWindowHarness.dispose());
});

test("return to latest uses no smooth movement when reduced motion is requested", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const scrollTo = HTMLElement.prototype.scrollTo;
    const observed: string[] = [];
    (window as typeof window & { p2ScrollBehaviors: string[] }).p2ScrollBehaviors = observed;
    HTMLElement.prototype.scrollTo = function (...args: Parameters<HTMLElement["scrollTo"]>) {
      if (this.matches(".normal-conversation-feed") && typeof args[0] === "object") observed.push(args[0].behavior ?? "auto");
      scrollTo.apply(this, args);
    };
  });
  const feed = await mountFixture(page);
  await feed.evaluate(el => { el.scrollTop = 0; });
  await page.getByRole("button", { name: "Jump to latest message" }).click();
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
  const behaviors = await page.evaluate(() => (window as typeof window & { p2ScrollBehaviors: string[] }).p2ScrollBehaviors);
  expect(behaviors.length).toBeGreaterThan(0);
  expect(behaviors.every(behavior => behavior === "auto")).toBe(true);
});

for (const messageCount of [36, 120]) {
  test(`smooth return reaches the latest row after layout changes with ${messageCount} messages`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const feed = await mountFixture(page, messageCount);
    await feed.evaluate(element => { element.scrollTop = element.scrollHeight * 0.45; });
    const latest = page.getByRole("button", { name: "Jump to latest message" });
    await expect(latest).toBeVisible();
    await settleMeasuredScroll(feed);
    await page.evaluate(() => window.p2ReadingHarness.mediaResize());
    await settleMeasuredScroll(feed);
    await latest.click();
    await expect.poll(() => feed.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop))
      .toBeLessThanOrEqual(2);
    await expect(latest).toBeHidden();
    await expect(feed.getByText(`History ${messageCount - 1}`, { exact: false }).first()).toBeVisible();
  });
}

test("user scrolling can interrupt a smooth return and preserve the new reading anchor", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const feed = await mountFixture(page, 120);
  await feed.evaluate(element => { element.scrollTop = 0; });
  const latest = page.getByRole("button", { name: "Jump to latest message" });
  await expect(latest).toBeVisible();
  await latest.click();
  await feed.hover();
  await page.mouse.wheel(0, -600);
  await expect(latest).toBeVisible();
  await settleMeasuredScroll(feed);
  const before = await readAnchor(feed);
  await page.evaluate(() => window.p2ReadingHarness.append());
  await expect.poll(async () => Math.abs((await anchorOffset(feed, before.key)) - before.offset)).toBeLessThanOrEqual(2);
});

for (const theme of ["light", "dark"] as const) {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 960 }]) {
    test(`stream keeps node identity and tail ownership ${theme} ${viewport.width}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      page.on("pageerror", error => errors.push(error.message));
      await page.setViewportSize(viewport);
      await page.addInitScript(theme => {
        localStorage.setItem("ling-stack.locale", "en-US");
        const selection = JSON.stringify({ mode: "fixed", themeId: `ling-${theme}` });
        localStorage.setItem("ling-stack.themeSelection", selection);
        localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
      }, theme);
      const feed = await mountFixture(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      expect(await page.locator("#p2-reading-fixture").evaluate(el => getComputedStyle(el).backgroundColor))
        .toBe(theme === "dark" ? "rgb(31, 31, 31)" : "rgb(255, 255, 255)");
      const row = feed.locator('[data-feed-item-id="message:agent:reading-message-35"]');
      const original = await row.elementHandle();
      const unfinished = "Streaming a code example\n\n```ts\nconst stable = true;\n";
      await page.evaluate(text => window.p2ReadingHarness.stream(text), unfinished);
      await expect(row).toContainText("const stable = true;");
      const completed = `${unfinished}console.log(stable);\n\`\`\`\n\nFinished in the same message.`;
      await page.evaluate(text => window.p2ReadingHarness.stream(text, true), completed);
      await expect(row).toContainText("Finished in the same message.");
      expect(await row.evaluate((el, previous) => el === previous, original)).toBe(true);
      await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
      await feed.evaluate(el => { el.scrollTop = el.scrollHeight / 2; });
      const latest = page.getByRole("button", { name: "Jump to latest message" });
      await expect(latest).toBeVisible();
      await mkdir(evidenceDir, { recursive: true });
      await page.screenshot({ path: `${evidenceDir}${theme}-${viewport.width}-reading-paused.png`, animations: "disabled" });
      await latest.click();
      await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
      await page.screenshot({ path: `${evidenceDir}${theme}-${viewport.width}-stream-completed.png`, animations: "disabled" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    });
  }
}
