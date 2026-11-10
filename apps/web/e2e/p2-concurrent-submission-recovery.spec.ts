import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

const scenarios = (["light", "dark"] as const)
  .flatMap(theme => (["acknowledged", "pending"] as const).map(newerResponse => ({ theme, newerResponse })));

for (const { theme, newerResponse } of scenarios) {
  test(`channel ${theme} retains an older unknown receipt while a newer send is ${newerResponse}`, async ({ page }, info) => {
    const errors: string[] = [], submittedKeys: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/turns/stream")) {
        submittedKeys.push(request.postDataJSON().idempotencyKey);
      }
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(({ theme, newerResponse }) => {
      localStorage.setItem("ling-stack.locale", "en-US");
      const selection = JSON.stringify({ mode: "fixed", themeId: `ling-${theme}` });
      localStorage.setItem("ling-stack.themeSelection", selection);
      localStorage.setItem("ling-stack.themeBootstrapSelection", selection);
      const originalFetch = window.fetch.bind(window);
      window.addEventListener("p2-enable-concurrent-receipt", () => sessionStorage.setItem("p2-concurrent-available", "true"));
      window.fetch = async (...args) => {
        const url = new URL(String(args[0]), location.href);
        if (url.pathname === "/conversation-submissions") {
          const saved = JSON.parse(sessionStorage.getItem("p2-concurrent-receipt") ?? "null");
          const common = { cwd: url.searchParams.get("cwd"), idempotencyKey: url.searchParams.get("idempotencyKey") };
          return new Response(JSON.stringify(saved && saved.idempotencyKey === common.idempotencyKey
            && sessionStorage.getItem("p2-concurrent-available") === "true" ? saved : { ...common, status: "unknown" }),
          { headers: { "content-type": "application/json" } });
        }
        const response = await originalFetch(...args);
        if (!url.pathname.endsWith("/turns/stream")) return response;
        const request = JSON.parse(String(args[1]?.body));
        if (request.body === "Second acknowledged input" && newerResponse === "pending") {
          sessionStorage.setItem("p2-second-response-pending", "true");
          await new Promise<void>(resolve => window.addEventListener("p2-release-second-response", () => resolve(), { once: true }));
          return response;
        }
        if (request.body !== "First delayed input") return response;
        const ready = (await response.text()).split("\n\n").find(block => block.startsWith("event: ready\n"))!;
        const data = JSON.parse(ready.slice("event: ready\ndata: ".length));
        sessionStorage.setItem("p2-concurrent-receipt", JSON.stringify({ cwd: url.searchParams.get("cwd"),
          idempotencyKey: request.idempotencyKey, status: "accepted", threadId: data.thread.id,
          turnId: data.turn.id, sourceItemId: data.userItem.id, sourceItem: data.userItem }));
        await new Promise<void>(resolve => window.addEventListener("p2-lose-first-response", () => resolve(), { once: true }));
        return new Response(new ReadableStream({ start(controller) {
          controller.error(new TypeError("Controlled response loss before receipt"));
        } }), { headers: { "content-type": "text/event-stream" } });
      };
    }, { theme, newerResponse });
    const state = createBaseState({ approvalStatus: "expired" });
    const provider = createChatProvider({ id: "p2-concurrent-provider", model: "fixture-model", lastCheck: {
      ok: true, checkedAt: "2026-10-16T00:00:00.000Z", code: "ready", message: "Controlled local fixture",
    } });
    state.providers = [provider];
    state.channels = state.channels.map(channel => ({ ...channel, defaultProviderPresetId: provider.id,
      defaultTeammateId: "ling_agent", autoReplyMode: "default_teammate" }));
    state.channelAiReplyBody = "Controlled reply for concurrent input";
    state.runs = [];
    state.tasks = [];
    state.approvals = [];
    state.channelMessages = [];
    state.threads = [];
    state.turns = [];
    await mockDaemon(page, state);
    await page.goto("/");
    await openEngineeringChannel(page);
    const input = page.getByLabel("Channel composer", { exact: true }).getByRole("textbox");
    await input.fill("First delayed input");
    await input.press("Enter");
    await expect.poll(() => submittedKeys.length).toBe(1);
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("p2-concurrent-receipt"))).not.toBeNull();
    await expect(input).toHaveAttribute("data-value", "");
    await input.fill("Second acknowledged input");
    await input.press("Enter");
    await expect.poll(() => submittedKeys.length).toBe(2);
    await expect(input).toHaveAttribute("data-value", "");
    const composer = page.getByLabel("Channel composer", { exact: true });
    const pendingKeys = () => page.evaluate(() => Object.entries(localStorage)
      .filter(([key]) => key.startsWith("ling-stack.submission-lookup.v1:"))
      .flatMap(([, value]) => value.startsWith("[") ? JSON.parse(value) as string[] : [value]));
    if (newerResponse === "pending") {
      await expect.poll(() => page.evaluate(() => sessionStorage.getItem("p2-second-response-pending"))).toBe("true");
      await expect(composer.getByRole("button", { name: "Sending...", exact: true })).toBeVisible();
      await expect.poll(pendingKeys).toEqual(submittedKeys);
    } else {
      await expect.poll(pendingKeys).toEqual([submittedKeys[0]]);
    }
    await page.evaluate(() => window.dispatchEvent(new Event("p2-lose-first-response")));
    await expect(page.getByText("Pending confirmation", { exact: true }).first()).toBeVisible();
    if (newerResponse === "pending") {
      await expect(composer.getByRole("button", { name: "Sending...", exact: true })).toBeVisible();
      await expect.poll(pendingKeys).toEqual(submittedKeys);
      await page.screenshot({ path: info.outputPath("newer-send-still-pending.png"), animations: "disabled" });
      await page.evaluate(() => window.dispatchEvent(new Event("p2-release-second-response")));
      await expect(composer.getByRole("button", { name: "Sending...", exact: true })).toHaveCount(0);
      await expect.poll(pendingKeys).toEqual([submittedKeys[0]]);
    }
    await page.screenshot({ path: info.outputPath("older-response-unknown.png"), animations: "disabled" });
    await page.reload();
    await openEngineeringChannel(page);
    await input.fill("Keep this unsent draft");
    await input.press("Enter");
    await expect(input).toHaveAttribute("data-value", "Keep this unsent draft");
    await expect.poll(pendingKeys).toEqual([submittedKeys[0]]);
    await page.evaluate(() => window.dispatchEvent(new Event("p2-enable-concurrent-receipt")));
    await input.press("Enter");
    await expect.poll(pendingKeys).toEqual([]);
    await expect(input).toHaveAttribute("data-value", "Keep this unsent draft");
    expect(submittedKeys).toHaveLength(2);
    expect(new Set(submittedKeys).size).toBe(2);
    expect(state.channelMessages.filter(message => message.authorType === "local-user").map(message => message.body))
      .toEqual(["First delayed input", "Second acknowledged input"]);
    const feed = page.getByLabel("Channel message feed", { exact: true });
    await expect(feed.getByText("First delayed input", { exact: true })).toHaveCount(1);
    await expect(feed.getByText("Second acknowledged input", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Provider needs attention", { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("recovered-without-replay.png"), animations: "disabled" });
    expect(errors).toEqual([]);
  });
}
