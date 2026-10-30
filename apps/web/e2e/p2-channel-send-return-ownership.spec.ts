import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const scenarios = (["rejected", "unknown", "accepted"] as const)
  .flatMap(outcome => [false, true].map(newerDraft => ({ outcome, newerDraft })));

for (const { outcome, newerDraft } of scenarios) {
  test(`channel return settles a detached ${outcome} send ${newerDraft ? "preserving a newer draft" : "without a newer draft"}`, async ({ page }, info) => {
    const errors: string[] = [];
    const posts: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error" && !message.text().includes("Failed to load resource")) errors.push(message.text());
    });
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/turns/stream")) {
        posts.push(request.postDataJSON().body);
      }
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(outcome => {
      localStorage.setItem("ling-stack.locale", "en-US");
      const selection = JSON.stringify({ mode: "fixed", themeId: outcome === "unknown" ? "ling-dark" : "ling-light" });
      localStorage.setItem("ling-stack.themeSelection", selection);
      localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
      if (outcome !== "accepted") return;
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (!new URL(String(args[0]), location.href).pathname.endsWith("/turns/stream")) return response;
        const body = await response.text();
        sessionStorage.setItem("p2-channel-result-waiting", "true");
        await new Promise<void>(resolve => window.addEventListener("p2-channel-release-result", () => resolve(), { once: true }));
        return new Response(body, { status: response.status, headers: response.headers });
      };
    }, outcome);
    const state = createBaseState({ approvalStatus: "expired" });
    const provider = createChatProvider({ id: "p2-return-provider", model: "fixture-model",
      lastCheck: { ok: true, code: "ready", message: "Controlled local fixture", checkedAt: "2026-10-16T00:00:00.000Z" } });
    state.providers = [provider];
    state.channels = state.channels.map(channel => ({ ...channel, defaultProviderPresetId: provider.id }));
    state.channels.push({ ...state.channels[0]!, id: "channel_research", name: "Research" });
    state.channelMessages = [];
    state.threads = [];
    state.turns = [];
    state.runs = [];
    state.tasks = [];
    state.approvals = [];
    await mockDaemon(page, state);
    let releaseResult!: () => void;
    const resultGate = new Promise<void>(resolve => { releaseResult = resolve; });
    let lookupStarted!: () => void;
    const lookupGate = new Promise<void>(resolve => { lookupStarted = resolve; });
    if (outcome !== "accepted") {
      await page.route(/\/channels\/channel_engineering\/turns\/stream(?:\?.*)?$/, async route => {
        await route.fulfill({ status: outcome === "rejected" ? 400 : 503,
          json: { error: "controlled_channel_result", message: "Original channel input rejected" } });
      });
      await page.route(/\/conversation-submissions(?:\?.*)?$/, async route => {
        lookupStarted();
        await resultGate;
        const url = new URL(route.request().url());
        await route.fulfill({ json: { status: "unknown", cwd: url.searchParams.get("cwd"),
          idempotencyKey: url.searchParams.get("idempotencyKey") } });
      });
    }
    await page.goto("/");
    await openEngineeringChannel(page);
    const composer = page.getByLabel("Channel composer", { exact: true });
    const input = composer.getByRole("textbox");
    await input.fill("Original channel input");
    await composer.getByRole("button", { name: "Send", exact: true }).click();
    if (outcome === "accepted") {
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem("p2-channel-result-waiting"))).toBe("true");
    } else {
      await lookupGate;
    }
    const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/ });
    await navigation.getByRole("button", { name: "Research", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Research / Research conversation", level: 1 })).toBeVisible();
    await expect(input).toHaveText("");
    await navigation.getByRole("button", { name: "Engineering", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Engineering / Engineering conversation", level: 1 })).toBeVisible();
    if (newerDraft) await input.fill("Keep my newer unsent draft");
    if (outcome === "accepted") {
      await page.evaluate(() => window.dispatchEvent(new Event("p2-channel-release-result")));
    } else {
      releaseResult();
    }
    await expect(composer.getByRole("button", { name: "Sending...", exact: true })).toHaveCount(0);
    await expect(input).toHaveText(newerDraft ? "Keep my newer unsent draft" : outcome === "rejected" ? "Original channel input" : "");
    if (newerDraft || outcome === "rejected") {
      await expect(composer.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    }
    if (outcome === "rejected") {
      await expect(composer.locator(".composer-status-row.failed")).toContainText("Original channel input rejected");
    } else {
      await expect(composer.locator(".composer-status-row.failed")).toHaveCount(0);
    }
    if (outcome === "unknown") await expect(page.getByText("Pending confirmation", { exact: true }).first()).toBeVisible();
    expect(posts).toEqual(["Original channel input"]);
    await expect(page.getByText("Provider needs attention", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`${outcome}-returned-with-draft.png`), animations: "disabled" });
  });
}
