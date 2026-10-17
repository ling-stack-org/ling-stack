import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { expectCompactMutedComposerControl } from "./support/composer-control-assertions";
import { createBaseState, createChatProvider } from "./support/mock-state";
import { expectMessageFrameContained } from "./support/message-frame-assertions";
import { openEngineeringChannel } from "./support/test-helpers";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/channel-feed-composer/",
  import.meta.url,
));

function channelComposerTextbox(scope: Page | Locator): Locator {
  return scope.getByRole("textbox", { name: "Message this channel or @ an AI teammate", exact: true });
}

async function prepareSurface(page: Page, theme: "light" | "dark", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((themeId) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, theme);
}

for (const viewport of [
  { width: 1440, height: 960, label: "1440x960", theme: "light" },
  { width: 1280, height: 800, label: "1280x800", theme: "dark" },
] as const) {
  test(`channel feed and composer share one stable column at ${viewport.label}`, async ({ page }) => {
    await prepareSurface(page, viewport.theme, viewport.width, viewport.height);
    const runtimeErrors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "expired" });
    state.providers = [createChatProvider({
      id: "provider_ui2_channel_feed",
      displayName: "Local Relay",
      model: "gpt-5.5",
      lastCheck: {
        ok: true,
        code: "ready",
        message: "Provider is reachable.",
        checkedAt: "2026-07-19T00:00:00.000Z",
      },
    })];
    state.workspaceSettings.defaultProviderPresetId = "provider_ui2_channel_feed";
    state.channels[0].defaultProviderPresetId = "provider_ui2_channel_feed";
    state.runs = [];
    state.tasks = [];
    state.approvals = [];
    state.channelMessages = Array.from({ length: 32 }, (_, index) => ({
      id: `ui2_feed_${index + 1}`,
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      kind: "message",
      intent: "discuss",
      authorType: "local-user",
      authorId: "tian",
      body: `UI 2.0 channel message ${index + 1} keeps the feed independently scrollable.`,
      mentions: [],
      attachmentIds: [],
      linkPreviewIds: [],
      status: "ready",
      createdAt: new Date(Date.UTC(2026, 6, 19, 0, index, 0)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 6, 19, 0, index, 0)).toISOString(),
    }));
    await mockDaemon(page, state);
    await page.goto("/");
    await openEngineeringChannel(page);

    const feed = page.getByLabel("Channel message feed");
    const composer = page.getByLabel("Channel composer");
    const input = channelComposerTextbox(composer);
    await expect(feed).toBeVisible();
    await expect(composer).toHaveAttribute("data-conversation-composer", "true");
    await expect(composer).toHaveAttribute("data-surface", "channel");
    await expect(composer).toHaveAttribute("data-density", "docked");
    const latestMessage = feed.locator(".channel-message-row").filter({ hasText: "UI 2.0 channel message 32" });
    await expect(latestMessage).toHaveClass(/message-bubble-document/);
    await expect(latestMessage).toHaveClass(/message-bubble-own/);
    await expectMessageFrameContained(latestMessage);

    const beforeFocus = await composer.boundingBox();
    await input.click();
    const afterFocus = await composer.boundingBox();
    expect(Math.round(afterFocus?.width ?? 0)).toBe(Math.round(beforeFocus?.width ?? 0));
    expect(Math.abs((afterFocus?.height ?? 0) - (beforeFocus?.height ?? 0))).toBeLessThanOrEqual(1);

    const geometry = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        const box = element?.getBoundingClientRect();
        return box ? { x: box.x, width: box.width, right: box.right } : undefined;
      };
      return {
        layout: rect(".activity-chat-layout"),
        feed: rect(".activity-shell .message-feed"),
        composer: rect(".activity-shell .channel-composer"),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(geometry.layout).toBeDefined();
    expect(geometry.feed).toBeDefined();
    expect(geometry.composer).toBeDefined();
    expect(Math.abs((geometry.feed?.x ?? 0) - (geometry.composer?.x ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((geometry.feed?.width ?? 0) - (geometry.composer?.width ?? 0))).toBeLessThanOrEqual(1);
    expect(geometry.overflow).toBe(0);

    const composerY = afterFocus?.y ?? 0;
    await feed.hover();
    await page.mouse.wheel(0, -1_200);
    await feed.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(page.getByRole("button", { name: "Jump to latest message" })).toBeVisible();
    expect(Math.abs(((await composer.boundingBox())?.y ?? 0) - composerY)).toBeLessThanOrEqual(1);

    const permissionButton = composer.getByRole("button", { name: /Selected permission preset/ });
    await expectCompactMutedComposerControl(permissionButton);
    await permissionButton.click();
    const permissionMenu = page.locator('[data-ling-overlay="menu"]');
    await expect(permissionMenu).toBeVisible();
    await expect(permissionMenu.getByRole("menuitemradio")).toHaveCount(3);
    await captureEvidence(
      page,
      `${viewport.width}x${viewport.height}-ling-${viewport.theme}-channel-feed-composer.png`,
    );
    await page.keyboard.press("Escape");
    await expect(permissionMenu).toHaveCount(0);
    await expect(permissionButton).toBeFocused();
    expect(runtimeErrors).toEqual([]);
  });
}

test("channel composer keeps failed drafts and uses shared persistent feedback", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_ui2_channel_composer_failure",
    displayName: "Local Relay",
    model: "gpt-5.5",
    lastCheck: {
      ok: true,
      code: "ready",
      message: "Provider is reachable.",
      checkedAt: "2026-07-19T00:00:00.000Z",
    },
  })];
  state.workspaceSettings.defaultProviderPresetId = "provider_ui2_channel_composer_failure";
  state.channels[0].defaultProviderPresetId = "provider_ui2_channel_composer_failure";
  await mockDaemon(page, state);
  let rejectNext = true;
  await page.route("**/channels/channel_engineering/turns/stream?**", async route => {
    if (!rejectNext) { await route.fallback(); return; }
    rejectNext = false;
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ message: "Controlled input rejection before acceptance" }) });
  });
  await page.route("**/conversation-submissions?**", async route => {
    const url = new URL(route.request().url());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "unknown",
      cwd: url.searchParams.get("cwd"), idempotencyKey: url.searchParams.get("idempotencyKey") }) });
  });
  await page.goto("/");
  await openEngineeringChannel(page);

  const composer = page.getByLabel("Channel composer");
  const input = channelComposerTextbox(composer);
  await input.fill("Retry this UI 2.0 message");
  await composer.getByRole("button", { name: "Send" }).click();

  const failure = composer.locator('.ling-ui-inline-feedback[data-tone="danger"]');
  await expect(failure).toBeVisible();
  await expect(failure).toContainText("Message failed");
  await expect(page.locator(".task-workbench-window > .inline-error")).toHaveCount(0);
  await expect(input).toHaveAttribute("data-value", "Retry this UI 2.0 message");
  await captureEvidence(page, "1440x960-ling-light-channel-composer-failure.png");
  await failure.getByRole("button", { name: "Retry" }).click();

  await expect(page.getByLabel("Channel message feed").getByText("Retry this UI 2.0 message")).toBeVisible();
  await expect(input).toHaveAttribute("data-value", "");
  const success = page.locator('[data-ling-overlay="toast"][data-scope="channel:channel_engineering:composer"]')
    .filter({ hasText: "Message sent" });
  await expect(success).toHaveCount(1);
  await expect(composer.locator('.composer-status-row.success[data-tone="success"]')).toHaveCount(0);
  await expect(success).toHaveCount(0, { timeout: 5_000 });
  expect(runtimeErrors).toEqual([]);
});

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") {
    return;
  }
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
