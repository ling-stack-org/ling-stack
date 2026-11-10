import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ReadingHarness } from "./support/p2-reading-harness";

const storageKey = "ling-stack.conversation-reading.v1";

async function mount(page: Page, navigate = true) {
  if (navigate) await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => {
    const path = "/e2e/support/p2-reading-harness.tsx";
    const fixture = await import(/* @vite-ignore */ path);
    window.p2ReadingHarness = fixture.mountReadingFixture(120) as ReadingHarness;
  });
  const feed = page.getByLabel("Conversation messages", { exact: true });
  await expect(feed).toBeVisible();
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(1_000);
  return feed;
}

async function anchor(feed: Locator) {
  return feed.evaluate(el => {
    const rect = el.getBoundingClientRect();
    const row = Array.from(el.querySelectorAll<HTMLElement>("[data-conversation-row-key]"))
      .find(row => row.getBoundingClientRect().bottom > rect.top + 12 && row.getBoundingClientRect().top < rect.bottom - 12)!;
    return { key: row.dataset.conversationRowKey!, offset: row.getBoundingClientRect().top - rect.top };
  });
}

async function expectRestored(feed: Locator, saved: Awaited<ReturnType<typeof anchor>>) {
  await expect.poll(() => feed.evaluate((el, saved) => {
    const row = Array.from(el.querySelectorAll<HTMLElement>("[data-conversation-row-key]"))
      .find(row => row.dataset.conversationRowKey === saved.key);
    return row ? Math.abs(row.getBoundingClientRect().top - el.getBoundingClientRect().top - saved.offset) : Infinity;
  }, saved)).toBeLessThanOrEqual(2);
}

async function readHistory(page: Page, feed: Locator) {
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
  await feed.evaluate(el => {
    el.style.overflowAnchor = "none";
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -240 }));
    el.scrollTop = el.scrollHeight * 0.4;
  });
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
  await expect.poll(() => page.evaluate(key => {
    const data = JSON.parse(localStorage.getItem(key) ?? "null");
    return data?.entries?.some((entry: [string, { viewport?: { following: boolean } }]) => entry[1].viewport?.following === false);
  }, storageKey)).toBe(true);
  return anchor(feed);
}

test("virtualized reading position returns after A to B to A and a page reload", async ({ page }) => {
  const feed = await mount(page);
  const saved = await readHistory(page, feed);
  await page.evaluate(() => window.p2ReadingHarness.switchThread());
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
  await page.evaluate(() => window.p2ReadingHarness.returnToThread());
  await expectRestored(feed, saved);
  await page.reload();
  await mount(page, false);
  await expectRestored(feed, saved);
});

test("same thread in another workspace starts at latest and preserves the first workspace reader", async ({ page }) => {
  const feed = await mount(page);
  const saved = await readHistory(page, feed);
  await page.evaluate(() => window.p2ReadingHarness.workspace("/different-workspace"));
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
  await page.evaluate(() => window.p2ReadingHarness.workspace("/p2-fixture"));
  await expectRestored(feed, saved);
});

test("explicit latest replaces saved history and survives reload", async ({ page }) => {
  const feed = await mount(page);
  await readHistory(page, feed);
  await page.getByRole("button", { name: "Jump to latest message" }).click();
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
  await page.reload();
  await mount(page, false);
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toHaveCount(0);
});

test("a missing saved row and corrupt storage fall back without blocking reading", async ({ page }) => {
  const feed = await mount(page);
  await readHistory(page, feed);
  await page.evaluate(key => {
    // Stop the real writer before injecting a stale snapshot; pagehide would
    // otherwise correctly replace the test's edited storage with live state.
    window.p2ReadingHarness.dispose();
    const data = JSON.parse(localStorage.getItem(key)!);
    for (const entry of data.entries) if (entry[1].viewport?.anchor) entry[1].viewport.anchor.rowKey = "deleted-row";
    localStorage.setItem(key, JSON.stringify(data));
  }, storageKey);
  await page.reload();
  await mount(page, false);
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
  await page.evaluate(key => {
    window.p2ReadingHarness.dispose();
    localStorage.setItem(key, "{broken");
  }, storageKey);
  await page.reload();
  await mount(page, false);
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
});

test("another window saving latest does not move an active history reader", async ({ page, context }) => {
  const feed = await mount(page);
  const saved = await readHistory(page, feed);
  const other = await context.newPage();
  const otherFeed = await mount(other);
  await expectRestored(otherFeed, saved);
  await other.getByRole("button", { name: "Jump to latest message" }).click();
  await expect.poll(() => otherFeed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
  await expectRestored(feed, saved);
  await page.evaluate(() => window.p2ReadingHarness.append());
  await expectRestored(feed, saved);
  await other.close();
});
