import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate } from "./support/mock-state";
import {
  installNormalConversationFixture,
  normalConversationFixtureTitle,
} from "./support/normal-conversation-fixture";
import { openEngineeringChannel } from "./support/test-helpers";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/shared-panels/",
  import.meta.url,
));

test("channel summary stays visible while the details dock opens", async ({ page }) => {
  await useEnglishLightSurface(page, 1728);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  await openEngineeringChannel(page);

  const toolbar = page.getByRole("toolbar", { name: "Workspace task toolbar" });
  await toolbar.getByRole("button", { name: "Summary" }).click();

  const summary = page.locator(".channel-progress-popover");
  await expect(summary).toBeVisible();
  await expectOpaque(summary);
  await startVisibilitySampler(page, ".channel-progress-popover");

  await toolbar.getByRole("button", { name: "Show details" }).click();
  await expect(page.getByLabel("Channel workspace dock")).toBeVisible();
  await expect(summary).toBeVisible();
  await expectContinuousVisibility(page);
  await expect.poll(async () => summary.evaluate((element) => getComputedStyle(element).transitionDuration)).toContain("0.24s");

  await startVisibilitySampler(page, ".channel-progress-popover");
  await toolbar.getByRole("button", { name: "Hide details" }).click();
  await expect(summary).toBeVisible();
  await expect(summary).toHaveAttribute("data-right-dock-motion", "closing");
  await expect.poll(async () => summary.evaluate((element) => getComputedStyle(element).transitionDuration)).toContain("0.18s");
  await expectContinuousVisibility(page);
  await expect(page.getByLabel("Channel workspace dock")).toHaveCount(0);

  await toolbar.locator('[data-conversation-action="terminal"]').click();
  const terminal = page.getByLabel("Terminal session");
  await expect(terminal).toHaveAttribute("data-bottom-panel-motion", /opening|open/);
  await expect(summary).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Summary" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => terminal.evaluate((element) => getComputedStyle(element).transitionDuration)).toContain("0.24s");
  await terminal.getByRole("button", { name: "Close terminal panel" }).click();
  await expect(terminal).toHaveAttribute("data-bottom-panel-motion", "closing");
  await expect(terminal).toHaveCount(0);
});

test("normal conversation summary uses the channel panel motion", async ({ page }) => {
  await useEnglishLightSurface(page, 1728);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_ui2_conversation_panels",
    displayName: "Local Relay",
    model: "gpt-5.5",
  })];
  installNormalConversationFixture(state);
  await mockDaemon(page, state);
  await page.goto("/");

  await openNormalConversationFixture(page);

  const conversation = page.getByLabel("Conversation page");
  const toolbar = conversation.getByRole("toolbar", { name: "Conversation workspace toolbar" });
  await toolbar.getByRole("button", { name: "Summary" }).click();
  await expect(page.locator(".normal-conversation-summary-popover")).toBeVisible();
  await expectOpaque(page.locator(".normal-conversation-summary-popover"));
  await startVisibilitySampler(page, ".normal-conversation-summary-popover, .normal-conversation-summary-panel");

  await toolbar.getByRole("button", { name: "Show details" }).click();
  const summary = page.locator(".normal-conversation-summary-panel");
  await expect(page.getByLabel("Conversation workspace dock")).toBeVisible();
  await expect(summary).toBeVisible();
  await expectContinuousVisibility(page);
  await expect.poll(async () => summary.evaluate((element) => getComputedStyle(element).transitionDuration)).toContain("0.24s");

  await startVisibilitySampler(page, ".normal-conversation-summary-popover");
  await toolbar.getByRole("button", { name: "Hide details" }).click();
  await expect(summary).toBeVisible();
  await expect(summary).toHaveAttribute("data-right-dock-motion", "closing");
  await expect.poll(async () => summary.evaluate((element) => getComputedStyle(element).transitionDuration)).toContain("0.18s");
  await expectContinuousVisibility(page);
  await expect(page.getByLabel("Conversation workspace dock")).toHaveCount(0);

  await startVisibilitySampler(page, ".normal-conversation-summary-popover");
  await toolbar.getByRole("button", { name: "Show details" }).click();
  await page.waitForTimeout(40);
  await toolbar.getByRole("button", { name: "Hide details" }).click();
  await page.waitForTimeout(40);
  await toolbar.getByRole("button", { name: "Show details" }).click();
  await expect(page.getByLabel("Conversation workspace dock")).toBeVisible();
  await expect(summary).toBeVisible();
  await expectContinuousVisibility(page);

  const dockResizeHandle = conversation.getByRole("separator", { name: "Resize workspace dock" });
  const dockFrame = page.locator(".normal-conversation-right-dock-frame");
  const dockWidthBeforeResize = (await dockFrame.boundingBox())?.width ?? 0;
  const dockHandleBox = await dockResizeHandle.boundingBox();
  expect(dockHandleBox).not.toBeNull();
  await dockResizeHandle.hover({ position: { x: Math.max(1, dockHandleBox!.width / 2), y: Math.min(80, dockHandleBox!.height - 1) } });
  await page.mouse.down();
  await expect(conversation).toHaveClass(/is-resizing-workspace-right-dock/);
  await page.mouse.move(Math.max(1, dockHandleBox!.x - 150), dockHandleBox!.y + 80, { steps: 4 });
  await expect(summary).toHaveAttribute("data-right-dock-motion", "resizing");
  await expect.poll(async () => summary.evaluate((element) => getComputedStyle(element).transitionDuration)).toContain("0s");
  await expect.poll(async () => (await dockFrame.boundingBox())?.width ?? 0).toBeGreaterThan(dockWidthBeforeResize + 80);
  await page.mouse.move(1, dockHandleBox!.y + 80, { steps: 4 });
  const maximumDockWidth = await page.evaluate(() => Math.floor(globalThis.innerWidth * 0.5));
  await expect.poll(async () => (await dockFrame.boundingBox())?.width ?? 0).toBeLessThanOrEqual(maximumDockWidth);
  await expect(summary).toBeHidden();
  await expect(toolbar.getByRole("button", { name: "Summary" })).toHaveAttribute("aria-pressed", "true");
  await expect(toolbar.getByRole("button", { name: "Summary" })).toHaveAttribute("aria-expanded", "false");
  await page.mouse.up();

  await toolbar.getByRole("button", { name: "Hide details" }).click();
  await expect(page.getByLabel("Conversation workspace dock")).toHaveCount(0);
  await expect(summary).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(summary).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "Summary" })).not.toHaveAttribute("aria-pressed", "true");

  await toolbar.getByRole("button", { name: "Summary" }).click();
  await expect(summary).toBeVisible();
  await toolbar.getByRole("button", { name: "Terminal" }).click();
  const terminal = page.getByLabel("Terminal session");
  await expect(terminal).toBeVisible();
  await expect(summary).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Summary" })).toHaveAttribute("aria-pressed", "true");
  await expect(terminal).toHaveAttribute("data-bottom-panel-motion", /opening|open/);
  await expect.poll(async () => terminal.evaluate((element) => getComputedStyle(element).transitionDuration)).toContain("0.24s");
  await expect(terminal).toHaveAttribute("data-bottom-panel-motion", "open");
  const terminalResizeHandle = terminal.getByRole("separator", { name: "Resize terminal panel" });
  const terminalHeightBeforeResize = (await terminal.boundingBox())?.height ?? 0;
  const terminalHandleBox = await terminalResizeHandle.boundingBox();
  expect(terminalHandleBox).not.toBeNull();
  await terminalResizeHandle.hover();
  await page.mouse.down();
  await page.mouse.move(terminalHandleBox!.x + terminalHandleBox!.width / 2, Math.max(1, terminalHandleBox!.y - 120), { steps: 4 });
  await expect(terminal).toHaveAttribute("data-bottom-panel-motion", "resizing");
  await expect.poll(async () => terminal.evaluate((element) => getComputedStyle(element).transitionDuration)).toContain("0s");
  await expect.poll(async () => (await terminal.boundingBox())?.height ?? 0).toBeGreaterThan(terminalHeightBeforeResize + 60);
  await page.mouse.move(terminalHandleBox!.x + terminalHandleBox!.width / 2, 1, { steps: 4 });
  const conversationHeight = (await conversation.boundingBox())?.height ?? 0;
  await expect.poll(async () => (await terminal.boundingBox())?.height ?? 0).toBeLessThanOrEqual(Math.floor(conversationHeight / 2) + 1);
  await page.mouse.up();
  await expect(terminal).not.toHaveAttribute("data-bottom-panel-motion", "resizing");
  await terminal.getByRole("button", { name: "Close terminal panel" }).click();
  await expect(terminal).toHaveAttribute("data-bottom-panel-motion", "closing");
  await expect.poll(async () => terminal.evaluate((element) => getComputedStyle(element).transitionDuration)).toContain("0.18s");
  await expect(terminal).toHaveCount(0);
});

test("AI teammate summary uses the channel panel motion", async ({ page }) => {
  await useEnglishLightSurface(page, 1728);
  const teammateName = "Ling Engineer";
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_ui2_teammate_panels",
    displayName: "Local Relay",
    model: "gpt-5.5",
  })];
  state.aiTeammates = [createMockTeammate({
    id: "teammate_ui2_conversation_panels",
    displayName: teammateName,
  })];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: teammateName }).click();
  const toolbar = page.getByRole("toolbar", { name: "Private chat actions" });
  await toolbar.getByRole("button", { name: "Summary" }).click();
  await expect(page.locator(".teammate-chat-summary-popover")).toBeVisible();
  await expectOpaque(page.locator(".teammate-chat-summary-popover"));
  await startVisibilitySampler(page, ".teammate-chat-summary-popover, .teammate-private-summary-panel");

  await toolbar.getByRole("button", { name: "Show details" }).click();
  const summary = page.locator(".teammate-private-summary-panel");
  await expect(page.getByLabel("Private chat workspace dock")).toBeVisible();
  await expect(summary).toBeVisible();
  await expectContinuousVisibility(page);
  await expect.poll(async () => summary.evaluate((element) => getComputedStyle(element).transitionDuration)).toContain("0.24s");

  await toolbar.getByRole("button", { name: "Terminal" }).click();
  const terminal = page.getByLabel("Terminal session");
  await expect(terminal).toHaveAttribute("data-bottom-panel-motion", /opening|open/);
  await expect(summary).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "Summary" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => terminal.evaluate((element) => getComputedStyle(element).transitionDuration)).toContain("0.24s");
  await terminal.getByRole("button", { name: "Close terminal panel" }).click();
  await expect(terminal).toHaveAttribute("data-bottom-panel-motion", "closing");
  await expect(terminal).toHaveCount(0);
});

test("conversation panels remove spatial motion when reduced motion is requested", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await useEnglishLightSurface(page, 1728);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
  await page.goto("/");
  await openEngineeringChannel(page);

  const toolbar = page.getByRole("toolbar", { name: "Workspace task toolbar" });
  await toolbar.getByRole("button", { name: "Summary" }).click();
  const summary = page.locator(".channel-progress-popover");
  await expect(summary).toBeVisible();
  await toolbar.getByRole("button", { name: "Show details" }).click();
  await expect(page.getByLabel("Channel workspace dock")).toBeVisible();
  await expect.poll(async () => summary.evaluate((element) => (
    getComputedStyle(element).transitionDuration.split(", ").every((duration) => duration === "0s")
  ))).toBe(true);
});

test("summary intent survives constrained Details geometry and restores when Sidebar or Details releases space", async ({ page }) => {
  await useEnglishLightSurface(page, 1440);
  const teammateName = "Ling Engineer";
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_ui2_summary_restore",
    displayName: "Local Relay",
    model: "gpt-5.5",
  })];
  state.aiTeammates = [createMockTeammate({
    id: "teammate_ui2_summary_restore",
    displayName: teammateName,
  })];
  installNormalConversationFixture(state);
  await mockDaemon(page, state);
  await page.goto("/");

  await openEngineeringChannel(page);
  await expectSummaryConcealAndRestore(
    page,
    page.getByRole("toolbar", { name: "Workspace task toolbar" }),
    page.locator(".channel-progress-popover"),
    page.getByLabel("Channel workspace dock"),
  );

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: teammateName }).click();
  await expectSummaryConcealAndRestore(
    page,
    page.getByRole("toolbar", { name: "Private chat actions" }),
    page.locator(".teammate-private-summary-panel"),
    page.getByLabel("Private chat workspace dock"),
  );

  await openNormalConversationFixture(page);
  await expectSummaryConcealAndRestore(
    page,
    page.getByRole("toolbar", { name: "Conversation workspace toolbar" }),
    page.locator(".normal-conversation-summary-panel"),
    page.getByLabel("Conversation workspace dock"),
  );
});

for (const fixture of [
  { theme: "light" as const, width: 1728, height: 960, summaryWithDock: true },
  { theme: "light" as const, width: 1440, height: 960, summaryWithDock: false },
  { theme: "dark" as const, width: 1280, height: 800, summaryWithDock: false },
]) {
  test(`conversation panels keep the channel visual contract at ${fixture.width}x${fixture.height} ${fixture.theme}`, async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);
    await prepareSurface(page, fixture.theme, fixture.width, fixture.height);
    const teammateName = "Ling Engineer";
    const state = createBaseState({ approvalStatus: "expired" });
    state.providers = [createChatProvider({
      id: `provider_ui2_panels_${fixture.theme}`,
      displayName: "Local Relay",
      model: "gpt-5.5",
    })];
    state.aiTeammates = [createMockTeammate({
      id: `teammate_ui2_panels_${fixture.theme}`,
      displayName: teammateName,
    })];
    installNormalConversationFixture(state);
    await mockDaemon(page, state);
    await page.goto("/");

    await openEngineeringChannel(page);
    const channelToolbar = page.getByRole("toolbar", { name: "Workspace task toolbar" });
    await openSummaryAndDock(
      channelToolbar,
      page.locator(".channel-progress-popover"),
      page.getByLabel("Channel workspace dock"),
      fixture.summaryWithDock,
      page.locator(".activity-chat-layout"),
      page.locator('[data-conversation-composer][data-surface="channel"]'),
    );
    await captureEvidence(page, evidenceFilename(fixture, "channel-summary-dock"));
    await channelToolbar.getByRole("button", { name: "Summary" }).click();
    await openBottomTerminal(page, channelToolbar);
    await captureEvidence(page, evidenceFilename(fixture, "channel-terminal"));

    await page.getByLabel("Ling Stack navigation").getByRole("button", { name: teammateName }).click();
    const teammateToolbar = page.getByRole("toolbar", { name: "Private chat actions" });
    await openSummaryAndDock(
      teammateToolbar,
      page.locator(".teammate-private-summary-panel"),
      page.getByLabel("Private chat workspace dock"),
      fixture.summaryWithDock,
      page.locator(".teammate-message-list"),
      page.locator('[data-conversation-composer][data-surface="teammate_direct"]'),
    );
    await captureEvidence(page, evidenceFilename(fixture, "teammate-summary-dock"));
    await teammateToolbar.getByRole("button", { name: "Summary" }).click();
    await openBottomTerminal(page, teammateToolbar);
    await captureEvidence(page, evidenceFilename(fixture, "teammate-terminal"));

    await openNormalConversationFixture(page);
    const conversationToolbar = page.getByRole("toolbar", { name: "Conversation workspace toolbar" });
    await openSummaryAndDock(
      conversationToolbar,
      page.locator(".normal-conversation-summary-panel"),
      page.getByLabel("Conversation workspace dock"),
      fixture.summaryWithDock,
      page.locator(".normal-conversation-feed-frame"),
      page.locator('[data-conversation-composer][data-surface="normal_conversation"]'),
    );
    await captureEvidence(page, evidenceFilename(fixture, "normal-summary-dock"));
    await conversationToolbar.getByRole("button", { name: "Summary" }).click();
    await openBottomTerminal(page, conversationToolbar);
    await captureEvidence(page, evidenceFilename(fixture, "normal-terminal"));

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(runtimeErrors).toEqual([]);
  });
}

async function useEnglishLightSurface(page: Page, width = 1440): Promise<void> {
  await prepareSurface(page, "light", width, 960);
}

async function openNormalConversationFixture(page: Page): Promise<void> {
  await page
    .getByLabel("Ling Stack navigation")
    .locator(".sidebar-recent-row")
    .filter({ hasText: normalConversationFixtureTitle })
    .click();
  await expect(page.getByLabel("Conversation page")).toBeVisible();
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

async function openSummaryAndDock(
  toolbar: import("@playwright/test").Locator,
  summary: import("@playwright/test").Locator,
  dock: import("@playwright/test").Locator,
  summaryWithDock = true,
  feed?: import("@playwright/test").Locator,
  composer?: import("@playwright/test").Locator,
): Promise<void> {
  await toolbar.getByRole("button", { name: "Summary" }).click();
  await expect(summary).toBeVisible();
  await toolbar.getByRole("button", { name: "Show details" }).click();
  await expect(dock).toBeVisible();
  const summaryButton = toolbar.getByRole("button", { name: "Summary" });
  await expect(summaryButton).toHaveAttribute("aria-pressed", "true");
  await expect(summaryButton).toHaveAttribute("aria-expanded", summaryWithDock ? "true" : "false");
  await expect.poll(async () => dock.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left < globalThis.innerWidth && rect.right <= globalThis.innerWidth + 1;
  })).toBe(true);
  await expect.poll(async () => Math.round((await dock.boundingBox())?.width ?? 0)).toBeGreaterThanOrEqual(300);
  if (!summaryWithDock) {
    await expect(summary).toBeHidden();
    return;
  }
  await expect(summary).toBeVisible();
  await expect(summary).toHaveAttribute("data-right-dock-motion", "open");
  if (feed && composer) await expectConversationSummaryGeometry(feed, composer, summary, dock);
}

async function expectConversationSummaryGeometry(
  feed: import("@playwright/test").Locator,
  composer: import("@playwright/test").Locator,
  summary: import("@playwright/test").Locator,
  dock: import("@playwright/test").Locator,
): Promise<void> {
  await expect.poll(async () => {
    const [feedBox, composerBox, summaryBox, dockBox] = await Promise.all([
      feed.boundingBox(),
      composer.boundingBox(),
      summary.boundingBox(),
      dock.boundingBox(),
    ]);
    if (!feedBox || !composerBox || !summaryBox || !dockBox) return undefined;
    return {
      axesMatch: Math.abs(feedBox.x - composerBox.x) <= 1 && Math.abs(feedBox.width - composerBox.width) <= 1,
      conversationClearsSummary: Math.max(feedBox.x + feedBox.width, composerBox.x + composerBox.width) <= summaryBox.x + 1,
      summaryClearsDock: summaryBox.x + summaryBox.width <= dockBox.x - 4,
    };
  }).toEqual({
    axesMatch: true,
    conversationClearsSummary: true,
    summaryClearsDock: true,
  });
}

async function expectSummaryConcealAndRestore(
  page: Page,
  toolbar: import("@playwright/test").Locator,
  summary: import("@playwright/test").Locator,
  dock: import("@playwright/test").Locator,
): Promise<void> {
  const summaryButton = toolbar.getByRole("button", { name: "Summary" });
  await summaryButton.click();
  await expect(summary).toBeVisible();
  await toolbar.getByRole("button", { name: "Show details" }).click();
  await expect(dock).toBeVisible();
  await expect(summary).toBeHidden();
  await expect(summaryButton).toHaveAttribute("aria-pressed", "true");
  await expect(summaryButton).toHaveAttribute("aria-expanded", "false");

  await page.getByRole("button", { name: "Hide navigation" }).click();
  await expect(summary).toBeVisible();
  await expect(summaryButton).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Show navigation" }).click();
  await expect(summary).toBeHidden();
  await expect(summaryButton).toHaveAttribute("aria-expanded", "false");

  await toolbar.getByRole("button", { name: "Hide details" }).click();
  await expect(dock).toHaveCount(0);
  await expect(summary).toBeVisible();
  await expect(summaryButton).toHaveAttribute("aria-expanded", "true");
  await summaryButton.click();
  await expect(summaryButton).not.toHaveAttribute("aria-pressed", "true");
}

async function openBottomTerminal(
  page: Page,
  toolbar: import("@playwright/test").Locator,
): Promise<void> {
  await toolbar.locator('[data-conversation-action="terminal"]').click();
  const terminal = page.locator(".workspace-terminal-panel");
  await expect(terminal).toBeVisible();
  await expect(terminal).toHaveAttribute("data-bottom-panel-expanded", "true");
  await expect(terminal).toHaveAttribute("data-bottom-panel-motion", "open");
}

function evidenceFilename(
  fixture: { readonly theme: "light" | "dark"; readonly width: number; readonly height: number },
  state: string,
): string {
  return `${fixture.width}x${fixture.height}-ling-${fixture.theme}-${state}.png`;
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function startVisibilitySampler(page: Page, selector: string): Promise<void> {
  await page.evaluate((targetSelector) => {
    const sample = { hiddenFrames: 0, samples: 0 };
    (window as typeof window & { __ui2ConversationPanelSample?: typeof sample }).__ui2ConversationPanelSample = sample;
    const startedAt = performance.now();
    const tick = (): void => {
      const visible = Array.from(document.querySelectorAll<HTMLElement>(targetSelector)).some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number.parseFloat(style.opacity || "1") > 0.05
          && rect.width > 0
          && rect.height > 0;
      });
      sample.samples += 1;
      if (!visible) sample.hiddenFrames += 1;
      if (performance.now() - startedAt < 420) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, selector);
}

async function readVisibilitySample(page: Page): Promise<{ readonly hiddenFrames: number; readonly samples: number }> {
  return page.evaluate(() => (
    (window as typeof window & { __ui2ConversationPanelSample?: { hiddenFrames: number; samples: number } })
      .__ui2ConversationPanelSample ?? { hiddenFrames: -1, samples: 0 }
  ));
}

async function expectContinuousVisibility(page: Page): Promise<void> {
  await expect.poll(async () => (await readVisibilitySample(page)).samples).toBeGreaterThan(10);
  await expect.poll(async () => (await readVisibilitySample(page)).hiddenFrames).toBe(0);
}

async function expectOpaque(locator: import("@playwright/test").Locator): Promise<void> {
  await expect.poll(async () => locator.evaluate((element) => Number.parseFloat(getComputedStyle(element).opacity || "1"))).toBeGreaterThan(0.99);
}
