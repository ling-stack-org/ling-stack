import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

async function useEnglishLocale(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
}

function channelComposerTextbox(scope: Page | Locator): Locator {
  return scope.getByRole("textbox", { name: "Message this channel or @ an AI teammate", exact: true });
}

test("channel composer keeps typed text visible after a GitHub link token", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "pending" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composerInput = channelComposerTextbox(page);
  await composerInput.click();
  await page.keyboard.insertText("https://github.com/QuantConnect/Lean");
  await expect(page.locator(".channel-composer .composer-inline-token.url-reference").filter({ hasText: "QuantConnect/Lean" })).toBeVisible();

  await page.keyboard.insertText(" 这段文字应该继续显示");

  await expect.poll(() => composerInput.getAttribute("data-value")).toBe("https://github.com/QuantConnect/Lean 这段文字应该继续显示");
  await expect(page.locator(".channel-composer .composer-inline-text").filter({ hasText: "这段文字应该继续显示" })).toBeVisible();
});

test("channel composer keeps typed text visible when typing immediately after a GitHub link token", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "pending" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composerInput = channelComposerTextbox(page);
  await composerInput.click();
  await page.keyboard.insertText("https://github.com/QuantConnect/Lean");
  await expect(page.locator(".channel-composer .composer-inline-token.url-reference").filter({ hasText: "QuantConnect/Lean" })).toBeVisible();

  await page.keyboard.insertText("这段文字应该继续显示");

  await expect.poll(() => composerInput.getAttribute("data-value")).toBe("https://github.com/QuantConnect/Lean 这段文字应该继续显示");
  await expect(page.locator(".channel-composer .composer-inline-text").filter({ hasText: "这段文字应该继续显示" })).toBeVisible();
});

test("channel composer separates ASCII text typed immediately after a GitHub link token", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "pending" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composerInput = channelComposerTextbox(page);
  await composerInput.click();
  await page.keyboard.insertText("https://github.com/QuantConnect/Lean");
  await expect(page.locator(".channel-composer .composer-inline-token.url-reference").filter({ hasText: "QuantConnect/Lean" })).toBeVisible();

  await page.keyboard.insertText("please continue");

  await expect.poll(() => composerInput.getAttribute("data-value")).toBe("https://github.com/QuantConnect/Lean please continue");
  await expect(page.locator(".channel-composer .composer-inline-text").filter({ hasText: "please continue" })).toBeVisible();
});

test("channel composer aligns mention tokens with following text", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "pending" });
  state.aiTeammates = [createMockTeammate({ id: "engineer", displayName: "Engineer" })];
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const composerInput = channelComposerTextbox(page);
  await composerInput.fill("@Eng");
  await page.getByRole("option", { name: /@Engineer/ }).click();
  await page.keyboard.insertText("align this message");

  const alignment = await composerInput.evaluate((element) => {
    const token = element.querySelector<HTMLElement>(".composer-inline-token.mention");
    const text = [...element.querySelectorAll<HTMLElement>(".composer-inline-text")]
      .find((candidate) => candidate.textContent?.includes("align this message"));
    if (!token || !text) {
      throw new Error("Mention token or following text did not render.");
    }
    const tokenBox = token.getBoundingClientRect();
    const textBox = text.getBoundingClientRect();
    return {
      centerDelta: (tokenBox.top + tokenBox.height / 2) - (textBox.top + textBox.height / 2),
      textHeight: textBox.height,
      tokenHeight: tokenBox.height,
    };
  });

  expect(Math.abs(alignment.centerDelta), JSON.stringify(alignment)).toBeLessThanOrEqual(1);
});
