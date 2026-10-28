import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ReadingHarness } from "./support/p2-reading-harness";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate, cwd } from "./support/mock-state";

const railSelector = ".conversation-position-rail";
const previewSelector = ".conversation-position-rail__preview";

async function mountNormal(page: Page, count = 120) {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async count => {
    const path = "/e2e/support/p2-reading-harness.tsx";
    const fixture = await import(/* @vite-ignore */ path);
    window.p2ReadingHarness = fixture.mountReadingFixture(count) as ReadingHarness;
  }, count);
  const feed = page.getByLabel("Conversation messages", { exact: true });
  await expect(page.locator(railSelector)).toBeVisible();
  await expect.poll(() => feed.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(2);
  return feed;
}

async function settle(feed: Locator) {
  await feed.evaluate(async el => {
    let previous = "", stable = 0;
    for (let frame = 0; frame < 90; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const next = `${el.scrollTop}:${el.scrollHeight}`;
      stable = next === previous ? stable + 1 : 0;
      if (stable >= 6) return;
      previous = next;
    }
    throw new Error("Navigation scroll did not settle");
  });
}

async function jumpFirst(page: Page) {
  const rail = page.locator(railSelector);
  const entry = rail.locator("button[tabindex='0']");
  await entry.focus();
  await expect(entry).toBeFocused();
  await page.keyboard.press("Home");
  const first = rail.getByRole("button", { name: /^Message 1 of / });
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute("data-feed-item-id"))).toBe(true);
}

for (const theme of ["light", "dark"] as const) {
  test(`normal ${theme}: preview identity and OpenClaw tick motion`, async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: theme });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const feed = await mountNormal(page, 36);
    await jumpFirst(page);
    await settle(feed);
    const rail = page.locator(railSelector);
    const marker = rail.getByRole("button", { name: "Message 5 of 36: Local Operator", exact: true });
    await marker.hover();
    const preview = rail.locator(previewSelector);
    await expect(preview).toContainText("Local Operator");
    await expect(preview).toContainText("History 4");
    await expect(preview.locator(".conversation-position-rail__avatar > *")).toBeVisible();
    for (const [distance, width] of [[0, 32], [1, 24], [2, 16], [3, 12]] as const) {
      await expect(rail.locator(`[data-hover-distance='${distance}']`).first().locator("span")).toHaveCSS("width", `${width}px`);
    }
    await expect(rail.locator(".conversation-position-rail__tick").first()).toHaveCSS("transition-duration", "0.1s, 0.1s");
    await expect.poll(() => feed.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath(`position-rail-${theme}.png`) });
    await expect(rail.locator(previewSelector)).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}

test("virtual history navigation keeps its destination through append and stream", async ({ page }) => {
  const feed = await mountNormal(page);
  const rail = page.locator(railSelector);
  expect(await rail.locator("button").count()).toBeLessThan(65);
  await expect(feed.getByText("History 0", { exact: true })).toHaveCount(0);
  await jumpFirst(page);
  await settle(feed);
  await expect(rail.getByRole("button", { name: /^Message 1 of / })).toHaveAttribute("aria-current", "true");
  await expect(rail.getByRole("button", { name: /^Message 1 of / })).toHaveAttribute("data-visible", "true");
  const firstRow = feed.locator('[data-feed-item-id="message:user:reading-message-0"]');
  await expect(firstRow).toBeFocused();
  const destinationOffset = () => firstRow.evaluate(el => el.getBoundingClientRect().top - el.closest("[data-conversation-feed-viewport]")!.getBoundingClientRect().top);
  await expect.poll(destinationOffset).toBeLessThanOrEqual(25);
  expect(await destinationOffset()).toBeGreaterThanOrEqual(-1);
  const before = await feed.evaluate(el => el.scrollTop);
  await page.evaluate(() => window.p2ReadingHarness.append());
  await settle(feed);
  expect(Math.abs(await feed.evaluate(el => el.scrollTop) - before)).toBeLessThanOrEqual(2);
  await page.evaluate(() => window.p2ReadingHarness.stream("A streaming tail\n\n".repeat(100)));
  await settle(feed);
  expect(Math.abs(await feed.evaluate(el => el.scrollTop) - before)).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
  await page.evaluate(() => window.p2ReadingHarness.prepend());
  await expect(rail.getByRole("button", { name: /^Message 1 of 122:/ })).toBeAttached();
  await settle(feed);
  await jumpFirst(page);
  await expect(feed.getByText(/Earlier history/).first()).toBeInViewport();
  await feed.evaluate(el => {
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 240 }));
    el.scrollTop = el.scrollHeight / 2;
  });
  await settle(feed);
  await expect(rail.locator('[aria-current="true"]')).toHaveCount(1);
  await expect(rail.locator('[aria-current="true"]')).not.toHaveAttribute("aria-label", /^Message 1 of /);
  await expect(rail.locator('[aria-current="true"]')).toHaveAttribute("data-visible", "true");
});

test("rapid navigation and a pending jump cannot focus the previous conversation", async ({ page }) => {
  const feed = await mountNormal(page);
  const rail = page.locator(railSelector);
  await rail.evaluate(el => {
    const buttons = [...el.querySelectorAll<HTMLButtonElement>("button")];
    buttons[0]!.click();
    buttons.at(-1)!.click();
  });
  await settle(feed);
  await expect(feed.locator('[data-feed-item-id="message:agent:reading-message-119"]')).toBeFocused();
  await rail.locator("button[tabindex='0']").focus();
  await page.keyboard.press("Home");
  await rail.getByRole("button", { name: /^Message 1 of / }).evaluate(el => {
    el.click();
    window.p2ReadingHarness.switchThread();
  });
  await settle(feed);
  await expect(rail.locator(previewSelector)).toHaveCount(0);
  await expect(feed.locator("[data-feed-item-id]").first()).toHaveAttribute("data-feed-item-id", /other-reading-message/);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-feed-item-id") ?? "")).not.toMatch(/^message:(?:user|agent):reading-message/);
});

test("collapsed process navigation yields to a newer jump and reconciles removed focus", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => {
    const path = "/e2e/support/position-navigation-harness.tsx";
    window.positionHarness = (await import(/* @vite-ignore */ path)).mountPositionFixture();
  });
  const feed = page.getByLabel("Navigation test feed", { exact: true });
  const rail = page.locator(railSelector);
  await expect(rail).toBeVisible();
  await rail.locator("button[tabindex='0']").focus();
  await page.keyboard.press("Home");
  const commentary = rail.getByRole("button", { name: /^Message 1 of / });
  const destinationIndex = await commentary.evaluate(el => {
    const next = [...el.closest("aside")!.querySelectorAll<HTMLButtonElement>("button")].at(-1)!;
    const position = Number(next.getAttribute("aria-label")!.match(/^Message (\d+)/)![1]);
    el.click();
    // Keep both locates in one task: disclosure of the first target is still pending.
    next.click();
    return position - 2;
  });
  await settle(feed);
  const lastRow = feed.locator(`[data-feed-item-id="position-final-${destinationIndex}"]`);
  await expect(lastRow).toBeInViewport();
  await expect(lastRow).toBeFocused();
  await rail.locator("button[tabindex='0']").focus();
  await page.keyboard.press("Home");
  await page.evaluate(() => window.positionHarness.removeFirst());
  await expect(rail.locator("button[tabindex='0']")).toHaveCount(1);
  await expect(rail.locator("button[tabindex='0']")).toHaveAttribute("aria-label", /of 120:/);
  await rail.locator("button[tabindex='0']").focus();
  await page.keyboard.press("Home");
  await expect(rail.getByRole("button", { name: /^Message 1 of 120:/ })).toBeFocused();
  await page.evaluate(() => window.positionHarness.failNext());
  await rail.locator("button[tabindex='0']").click();
  await expect(rail.getByRole("status")).toContainText("Source unavailable");
  await rail.locator("button[tabindex='0']").click();
  await expect(rail.getByRole("status")).toHaveCount(0);
  await expect(feed.locator('[data-feed-item-id="position-final-0"]')).toBeInViewport();
  await page.evaluate(() => window.positionHarness.single());
  await expect(rail).toBeHidden();
  await page.evaluate(() => window.positionHarness.restore());
  await expect(rail).toBeVisible();
});

test("a cancelled disclosure lookup performs no destination scroll or focus", async ({ page }) => {
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => {
    const path = "/e2e/support/position-navigation-harness.tsx";
    window.positionHarness = (await import(/* @vite-ignore */ path)).mountPositionFixture();
  });
  const feed = page.getByLabel("Navigation test feed", { exact: true });
  await expect(page.locator(railSelector)).toBeVisible();
  await feed.evaluate(el => { el.scrollTop = el.scrollHeight; el.focus(); });
  await settle(feed);
  const before = await feed.evaluate(el => el.scrollTop);
  expect(await page.evaluate(() => window.positionHarness.cancelPending())).toEqual({ result: "cancelled", revealed: false });
  await settle(feed);
  await expect(feed).toBeFocused();
  expect(await feed.evaluate(el => el.scrollTop)).toBeGreaterThan(before * 0.9);
});

test("keyboard, reduced motion, responsive layout and scope reset", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const feed = await mountNormal(page);
  const rail = page.locator(railSelector);
  await expect(rail).toHaveCSS("animation-name", "none");
  await rail.locator("button[tabindex='0']").focus();
  await page.keyboard.press("Home");
  await expect(rail.getByRole("button", { name: /^Message 1 of / })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(rail.getByRole("button", { name: /^Message 2 of / })).toBeFocused();
  await expect(rail.locator(previewSelector)).toContainText("Ling Agent");
  await page.keyboard.press("End");
  await expect(rail.getByRole("button", { name: /^Message 120 of / })).toBeFocused();
  await expect(rail.locator("button[tabindex='0']")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(feed).toBeFocused();
  await expect(rail.locator(previewSelector)).toHaveCount(0);
  await rail.locator("button[tabindex='0']").focus();
  await page.evaluate(() => window.p2ReadingHarness.switchThread());
  await expect(rail.locator(previewSelector)).toHaveCount(0);
  await expect(rail.locator("[data-position-marker-id*='other-reading-message']").first()).toBeAttached();
  await page.setViewportSize({ width: 540, height: 800 });
  await expect(rail).toBeHidden();
  await expect.poll(() => feed.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});

test("private conversation uses the selected teammate and local profile", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  state.userProfile = { ...state.userProfile, displayName: "Local Operator" };
  const teammateId = "teammate_position_reader";
  state.providers = [createChatProvider({ id: "provider_position_reader", model: "gpt-5.5" })];
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName: "Ling Reader", providerPresetId: "provider_position_reader" })];
  state.teammateDirectMessages = Array.from({ length: 40 }, (_, index) => ({
    id: `position-private-${index}`, workspaceId: "workspace_default", teammateId, threadId: `tdthread_${teammateId}`,
    authorType: index % 2 ? "ai-teammate" : "local-user", authorId: index % 2 ? teammateId : "local-user",
    body: `Private history ${index}\n\n${"Read earlier conversations. ".repeat(18)}`,
    attachmentIds: [], linkPreviewIds: [], fileRefs: [], status: "ready",
    createdAt: new Date(Date.UTC(2026, 9, 14, 0, index)).toISOString(), updatedAt: new Date(Date.UTC(2026, 9, 14, 0, index)).toISOString(),
  }));
  state.runs = []; state.tasks = []; state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Ling Reader", exact: true }).click();
  const feed = page.getByLabel("Private message feed", { exact: true });
  await expect(page.locator(railSelector)).toBeVisible();
  await jumpFirst(page);
  await settle(feed);
  const rail = page.locator(railSelector);
  await rail.getByRole("button", { name: "Message 2 of 40: Ling Reader", exact: true }).hover();
  await expect(rail.locator(previewSelector)).toContainText("Ling Reader");
  await expect(rail.locator(previewSelector)).toContainText("Private history 1");
  await expect(rail.locator(".conversation-position-rail__avatar > *")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("position-rail-private.png") });
  await rail.getByRole("button", { name: /^Message 1 of / }).hover();
  await expect(rail.locator(previewSelector)).toContainText("Local Operator");
});

test("channel navigation resolves the original sender identity", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = []; state.runs = []; state.tasks = []; state.approvals = [];
  state.aiTeammates = [
    createMockTeammate({ id: "engineer", displayName: "Ling Engineer", templateId: "engineer" }),
    createMockTeammate({ id: "reviewer", displayName: "Ling Reviewer", templateId: "qa", roleKey: "qa" }),
  ];
  const workspaceId = "workspace_default", channelId = "channel_engineering", now = "2026-10-14T00:00:00.000Z";
  const threadId = "thread_channel_channel_engineering";
  const thread = { id: threadId, workspaceId, channelId, kind: "channel_discussion" as const, title: "Engineering conversation",
    objective: "Read history", status: "open" as const, surfaceKind: "channel_root" as const, relationKind: "root" as const, createdAt: now, updatedAt: now };
  state.threads = [thread];
  const items = Array.from({ length: 40 }, (_, index) => ({
    schemaVersion: 1, workspaceId, channelId, threadId, turnId: `position-turn-${index}`, id: `position-channel-${index}`,
    sequence: index + 1, kind: "assistant_message", actorType: "teammate", actorId: index % 2 ? "reviewer" : "engineer", visibility: "channel",
    status: "committed", revision: 1, domainRefs: [], createdAt: now, updatedAt: now, committedAt: now,
    payload: { body: `Channel history ${index}\n\n${"Read earlier channel messages. ".repeat(18)}`, format: "markdown",
      deliveryStatus: "ready", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
  }));
  await mockDaemon(page, state);
  await page.route("**/channels/channel_engineering/items**", async route => {
    if ((new URL(route.request().url()).searchParams.get("threadId") ?? threadId) !== threadId) return route.fallback();
    await route.fulfill({ json: { cwd, channelId, thread, items, turns: [], turnContextAssignments: [], userInputs: [], decorations: [], generatedMedia: [], hasMore: false } });
  });
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display/ }).getByRole("button", { name: "Engineering", exact: true }).click();
  const feed = page.getByLabel("Channel message feed", { exact: true });
  const rail = page.locator(railSelector);
  await expect(rail).toBeVisible();
  await jumpFirst(page);
  await settle(feed);
  const avatarSources: string[] = [];
  for (const [position, author] of [[1, "Ling Engineer"], [2, "Ling Reviewer"]] as const) {
    await rail.getByRole("button", { name: `Message ${position} of 40: ${author}`, exact: true }).hover();
    await expect(rail.locator(previewSelector)).toContainText(author);
    await expect(rail.locator(previewSelector)).toContainText(`Channel history ${position - 1}`);
    const avatar = rail.locator(".conversation-position-rail__avatar img");
    await expect(avatar).toBeVisible();
    avatarSources.push((await avatar.getAttribute("src"))!);
  }
  expect(avatarSources[0]).not.toEqual(avatarSources[1]);
  await page.screenshot({ path: testInfo.outputPath("position-rail-channel.png") });
});
