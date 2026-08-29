import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { installChannelWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, type MockState } from "./support/mock-state";
import { captureP6FeedbackEvidence } from "./support/p6-feedback-evidence";
import { openEngineeringChannel } from "./support/test-helpers";

const hookPath = fileURLToPath(new URL(
  "../src/features/workspace/useChannelConversationBlockInteractions.tsx",
  import.meta.url,
));
const componentCssPath = fileURLToPath(new URL("../src/styles/components.css", import.meta.url));
const feedbackCssPath = fileURLToPath(new URL(
  "../src/styles/channel-conversation-block-feedback.css",
  import.meta.url,
));

test("Conversation Block feedback has one Toast owner and one persistent failure owner", async () => {
  const [hookSource, componentCss, feedbackCss] = await Promise.all([
    readFile(hookPath, "utf8"),
    readFile(componentCssPath, "utf8"),
    readFile(feedbackCssPath, "utf8"),
  ]);

  expect(hookSource).toContain("useLingToast");
  expect(hookSource).toContain("durationMs: 3_000");
  expect(hookSource).toContain("scope: `message:${conversationBlockId(block)}:${action}`");
  expect(hookSource).not.toContain("conversationBlockFeedbackTimeoutRef");
  expect(hookSource).not.toContain("setConversationBlockFeedback");
  expect(componentCss).not.toContain(".conversation-block-feedback");
  expect(feedbackCss).toContain(".conversation-block-feedback");
  expect(feedbackCss).toContain(".conversation-block-action-menu .conversation-block-feedback");
});

test("copy and expand success use deduped 3000ms global Toast without local status", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960 });
  const runtime = watchRuntime(page);
  await initializeClipboard(page, true);
  const state = createFeedbackState();
  installChannelWorkCellFixture(state, "feedback_expand");
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);
  const feed = page.getByLabel("Channel message feed");
  const first = feedbackMessage(feed, "Focused feedback alpha.");
  await first.focus();
  await first.press("Control+Shift+C");

  const blockId = await requiredAttribute(first, "data-feed-item-id");
  const copyToast = toastByScope(page, `message:${blockId}:copy`);
  await expect(copyToast).toContainText("Copied focused block");
  await expect(copyToast).toHaveAttribute("data-tone", "success");
  await first.press("Control+Shift+C");
  await expect(copyToast).toHaveCount(1);
  await expect(page.locator(".conversation-block-feedback")).toHaveCount(0);
  await captureP6FeedbackEvidence(
    page,
    "conversations/conversation-block-feedback",
    "1440x960-ling-light-copy-success-toast.png",
  );

  const expandableBlock = feed.locator([
    "[data-conversation-focus-block='true']:has(.conversation-work-cell-evidence-summary[aria-expanded='false'])",
    "[data-conversation-focus-block='true']:has(.conversation-timeline-activity-main[aria-expanded='false'])",
    "[data-conversation-focus-block='true']:has(.transcript-block-view-head[aria-expanded='false'])",
  ].join(",")).first();
  await expect(expandableBlock).toBeVisible();
  const expandableBlockId = await requiredAttribute(expandableBlock, "data-feed-item-id");
  await expandableBlock.focus();
  await expandableBlock.press("Enter");
  const expandToast = toastByScope(page, `message:${expandableBlockId}:expand`);
  await expect(expandToast).toContainText("Expanded focused block");
  await expect(expandToast).toHaveAttribute("data-tone", "info");
  await expect(page.locator(".conversation-block-feedback")).toHaveCount(0);

  await expect(copyToast).toHaveCount(0, { timeout: 5_000 });
  await expect(expandToast).toHaveCount(0, { timeout: 5_000 });
  await expectNoHorizontalOverflow(page, [feed]);
  runtime.expectClean();
});

test("copy failure stays with its block or menu until next target, retry, or dismiss", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", reducedMotion: true, width: 1280, height: 800 });
  const runtime = watchRuntime(page);
  const browserDialogs: string[] = [];
  page.on("dialog", (dialog) => browserDialogs.push(dialog.type()));
  await initializeClipboard(page, false);
  const state = createFeedbackState();
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);

  const feed = page.getByLabel("Channel message feed");
  const first = feedbackMessage(feed, "Focused feedback alpha.");
  const second = feedbackMessage(feed, "Focused feedback beta.");
  await first.focus();
  await first.press("Control+Shift+C");
  let failure = page.locator('.conversation-block-feedback[data-feedback-owner="block"]');
  await expect(failure).toContainText("Copy unavailable");
  await page.waitForTimeout(3_200);
  await expect(failure).toBeVisible();
  await expect(page.locator('[data-ling-overlay="toast"]')).toHaveCount(0);
  await captureP6FeedbackEvidence(
    page,
    "conversations/conversation-block-feedback",
    "1280x800-ling-dark-object-local-failure.png",
  );

  await first.press("Alt+ArrowDown");
  await expect(second).toBeFocused();
  await expect(page.locator(".conversation-block-feedback")).toHaveCount(0);

  await second.press("Control+Shift+C");
  await expect(page.locator('.conversation-block-feedback[data-feedback-owner="block"]')).toContainText("Copy unavailable");
  await setClipboardAvailability(page, true);
  await second.press("Control+Shift+C");
  await expect(page.locator(".conversation-block-feedback")).toHaveCount(0);
  const secondBlockId = await requiredAttribute(second, "data-feed-item-id");
  const retryToast = toastByScope(page, `message:${secondBlockId}:copy`);
  await expect(retryToast).toContainText("Copied focused block");
  await retryToast.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(retryToast).toHaveCount(0);

  await setClipboardAvailability(page, false);
  await first.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Conversation block actions" });
  await expect(menu.getByRole("menuitem", { name: "Copy block" })).toBeFocused();
  await menu.getByRole("menuitem", { name: "Copy block" }).click();
  const menuFailure = menu.locator('.conversation-block-feedback[data-feedback-owner="menu"]');
  await expect(menuFailure).toContainText("Copy unavailable");
  await expectNoHorizontalOverflow(page, [feed, menu, menuFailure]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(first).toBeFocused();
  failure = page.locator('.conversation-block-feedback[data-feedback-owner="block"]');
  await expect(failure).toContainText("Copy unavailable");
  await failure.getByRole("button", { name: "Dismiss" }).click();
  await expect(failure).toHaveCount(0);
  await expect(first).toBeFocused();

  await setDelayedClipboardFailure(page, 180);
  await first.press("Control+Shift+C");
  await first.press("Alt+ArrowDown");
  await expect(second).toBeFocused();
  await page.waitForTimeout(240);
  await expect(page.locator(".conversation-block-feedback")).toHaveCount(0);
  await expect(page.locator('[data-ling-overlay="toast"]')).toHaveCount(0);

  await expectReducedMotion(page);
  await expectNoHorizontalOverflow(page, [feed]);
  expect(browserDialogs).toEqual([]);
  runtime.expectClean();
});

function createFeedbackState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages = [
    feedbackMessageFixture("feedback_alpha", "Focused feedback alpha.", "2026-07-26T03:00:00.000Z"),
    feedbackMessageFixture("feedback_beta", "Focused feedback beta.", "2026-07-26T03:01:00.000Z"),
  ];
  return state;
}

function feedbackMessageFixture(id: string, body: string, createdAt: string): MockState["channelMessages"][number] {
  return {
    id,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "local-user",
    body,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    status: "ready",
    createdAt,
    updatedAt: createdAt,
  };
}

function feedbackMessage(feed: Locator, text: string): Locator {
  return feed.locator("[data-conversation-focus-block='true']").filter({ hasText: text });
}

function toastByScope(page: Page, scope: string): Locator {
  return page.locator(`[data-ling-overlay="toast"][data-scope=${JSON.stringify(scope)}]`);
}

async function requiredAttribute(locator: Locator, name: string): Promise<string> {
  const value = await locator.getAttribute(name);
  expect(value).toBeTruthy();
  return value ?? "";
}

async function initializeClipboard(page: Page, available: boolean): Promise<void> {
  await page.addInitScript((enabled) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: enabled ? {
        writeText: async (text: string) => {
          (window as typeof window & { __lingConversationBlockCopy?: string }).__lingConversationBlockCopy = text;
        },
      } : undefined,
    });
  }, available);
}

async function setClipboardAvailability(page: Page, available: boolean): Promise<void> {
  await page.evaluate((enabled) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: enabled ? {
        writeText: async (text: string) => {
          (window as typeof window & { __lingConversationBlockCopy?: string }).__lingConversationBlockCopy = text;
        },
      } : undefined,
    });
  }, available);
}

async function setDelayedClipboardFailure(page: Page, delayMs: number): Promise<void> {
  await page.evaluate((delay) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => new Promise<void>((_resolve, reject) => {
          globalThis.setTimeout(() => reject(new Error("clipboard_unavailable")), delay);
        }),
      },
    });
  }, delayMs);
}

async function prepareSurface(page: Page, input: {
  readonly height: number;
  readonly reducedMotion?: boolean;
  readonly theme: "light" | "dark";
  readonly width: number;
}): Promise<void> {
  await page.setViewportSize({ width: input.width, height: input.height });
  await page.emulateMedia({ reducedMotion: input.reducedMotion ? "reduce" : "no-preference" });
  await page.addInitScript((theme) => {
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, input.theme);
}

function watchRuntime(page: Page): { readonly expectClean: () => void } {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return { expectClean: () => expect(errors).toEqual([]) };
}

async function expectReducedMotion(page: Page): Promise<void> {
  const animated = await page.locator(".conversation-block-feedback, .ling-ui-toast").evaluateAll((elements) =>
    elements.map((element) => ({
      duration: getComputedStyle(element).animationDuration,
      name: getComputedStyle(element).animationName,
    })).filter((entry) => entry.name !== "none" && entry.duration !== "0s")
  );
  expect(animated).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page, surfaces: readonly Locator[]): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
    .toBeLessThanOrEqual(1);
  for (const surface of surfaces) {
    await expect.poll(() => surface.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  }
}
