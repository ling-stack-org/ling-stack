import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, createMockTeammate } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";
import { installNormalConversationFixture } from "./support/normal-conversation-fixture";

const evidence = new URL("../../../docs/design/evidence/conversation-bottom-status-strip/", import.meta.url);
const surfaces = ["channel", "normal_conversation", "teammate_direct"] as const;
const runtimeMetricsFixture = {
  aiRounds: 8, toolSteps: 12, recentReplyTokensPerSecond: 15.5,
  totalTokens: 1000, inputTokens: 600, outputTokens: 100,
  cacheReadTokens: 200, cacheWriteTokens: 100,
  context: { measuredInputTokens: 3600, capacityTokens: 12000, estimatedTokens: null, basis: "measured" },
  coverage: "complete",
} as const;

for (const surface of surfaces) {
  for (const locale of ["en-US", "zh-CN"] as const) {
    test(`${surface} displays localized metrics centered below the composer (${locale})`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.addInitScript((language) => {
        localStorage.setItem("ling-stack.locale", language);
        localStorage.setItem("ling-stack.themePreference", "dark");
        localStorage.setItem("ling-stack.themeBootstrapPreference", "dark");
        localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ mode: "preset", presetId: "ling-dark" }));
        localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify({ mode: "preset", presetId: "ling-dark" }));
      }, locale);
      const state = createBaseState({ approvalStatus: "expired" });
      state.runtimeMetricsFixture = runtimeMetricsFixture;
      if (surface === "normal_conversation") installNormalConversationFixture(state);
      state.providers = [createChatProvider({
        id: "status_test_provider",
        displayName: "Status Test Relay",
        model: "status-test-model",
        lastCheck: { ok: true, code: "ready", message: "Ready", checkedAt: "2026-10-28T00:00:00.000Z" },
      })];
      state.channels = state.channels.map((channel) => ({ ...channel, defaultProviderPresetId: "status_test_provider" }));
      state.aiTeammates = [createMockTeammate({ id: "engineer", displayName: "Engineer", providerPresetId: "status_test_provider" })];
      await mockDaemon(page, state);
      await page.route(/\/notifications(?:\/stream)?(?:\?.*)?$/u, async (route) => {
        await route.fulfill({ json: { schemaVersion: 1, notifications: [], nextSince: null } });
      });
      await page.goto("/");
      if (surface === "channel") {
        await openEngineeringChannel(page);
      } else if (surface === "normal_conversation") {
        await page.getByRole("button", { name: locale === "zh-CN" ? "打开最近对话 1" : "Open recent conversation 1" }).click();
      } else if (surface === "teammate_direct") {
        await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })
          .getByRole("button", { name: "Engineer", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Engineer", level: 1 })).toBeVisible();
      }

      const frame = page.locator(`[data-conversation-composer-frame="${surface}"]`).first();
      const composer = frame.locator("[data-conversation-composer]");
      const status = frame.locator("[data-conversation-bottom-status]");
      await expect(composer).toBeVisible();
      await expect(status).toBeVisible();
      await expect(status).toContainText(locale === "zh-CN" ? "8 轮 AI" : "8 rounds");
      await expect(status).toContainText(locale === "zh-CN" ? "12 步骤" : "12 steps");
      await expect(status).toContainText("15.5 tok/s");
      await expect(status).toContainText(locale === "zh-CN" ? "1,000 Token" : "1,000 tokens");
      await expect(status).toContainText(locale === "zh-CN" ? "22% 缓存命中" : "22% cache hit");
      await expect(status).toContainText("30%");
      const activity = locale === "zh-CN" ? "运行活动" : "Runtime activity";
      const usage = locale === "zh-CN" ? "Token 与缓存" : "Token and cache usage";
      const context = locale === "zh-CN" ? "上下文" : "Context usage";
      const detail = locale === "zh-CN" ? "详情" : "details";
      await status.getByRole("button", { name: activity }).click();
      await expect(status.getByRole("group", { name: `${activity} ${detail}` }))
        .toContainText(locale === "zh-CN" ? "含工具耗时" : "including tool time");
      await status.getByRole("button", { name: usage }).focus();
      const usageDetail = status.getByRole("group", { name: `${usage} ${detail}` });
      await expect(usageDetail).toContainText(locale === "zh-CN" ? "缓存读取: 200" : "Cache read: 200");
      await expect(usageDetail).toContainText(locale === "zh-CN" ? "覆盖: 完整" : "Coverage: complete");
      await status.getByRole("button", { name: context, exact: true }).focus();
      await expect(status.getByRole("group", { name: `${context} ${detail}` }))
        .toContainText(locale === "zh-CN" ? "最近请求上下文: 3,600 Token" : "Recent request context: 3,600 tokens");
      await composer.focus();
      const geometry = await page.evaluate((selector) => {
        const frame = document.querySelector(selector);
        const box = frame?.querySelector(":scope > [data-conversation-composer]");
        const strip = frame?.querySelector(":scope > [data-conversation-bottom-status]");
        if (!(box instanceof HTMLElement) || !(strip instanceof HTMLElement)) return null;
        const b = box.getBoundingClientRect();
        const s = strip.getBoundingClientRect();
        const style = getComputedStyle(strip);
        return {
          gap: s.top - b.bottom,
          offset: Math.abs((s.left + s.right) / 2 - (b.left + b.right) / 2),
          background: style.backgroundColor,
          borderWidth: style.borderTopWidth,
        };
      }, `[data-conversation-composer-frame="${surface}"]`);
      expect(geometry).not.toBeNull();
      expect(geometry!.gap).toBeGreaterThan(0);
      expect(geometry!.offset).toBeLessThanOrEqual(1);
      expect(geometry!.background).toBe("rgba(0, 0, 0, 0)");
      expect(geometry!.borderWidth).toBe("0px");

      if (locale === "en-US") {
        await mkdir(evidence, { recursive: true });
        await page.screenshot({ path: new URL(`${surface}.png`, evidence).pathname, fullPage: true });
      }
    });
  }
}
