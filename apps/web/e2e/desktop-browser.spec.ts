import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

test("shared Browser workspace isolates scopes, restores tabs and hides the native viewport for overlays", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/e2e/support/desktop-browser.html");
  const address = page.getByRole("textbox", { name: "Browser address" });
  await expect(address).toBeVisible();
  await address.fill("localhost:3000"); await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(address).toHaveValue("http://localhost:3000/");
  await expect(page.getByRole("tab", { name: "localhost:3000" })).toBeVisible();
  await page.getByRole("button", { name: "Allow agent control", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Agent control available");
  await expect.poll(() => page.evaluate(() => window.browserFixture.viewports.at(-1)?.visible)).toBe(true);
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await expect(page.getByText("Recorded browser evidence", { exact: true })).toBeVisible();
  await expect(address).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.browserFixture.viewports.at(-1)?.visible)).toBe(false);
  await page.getByRole("button", { name: "Browser", exact: true }).click();
  await expect(address).toHaveValue("http://localhost:3000/");
  await expect.poll(() => page.evaluate(() => window.browserFixture.viewports.at(-1)?.visible)).toBe(true);
  await page.getByRole("button", { name: "Open approval overlay" }).click();
  await expect.poll(() => page.evaluate(() => window.browserFixture.viewports.at(-1)?.visible)).toBe(false);
  await page.getByRole("button", { name: "Dismiss approval overlay" }).click();
  await expect.poll(() => page.evaluate(() => window.browserFixture.viewports.at(-1)?.visible)).toBe(true);
  for (const surface of ["channel", "teammate_direct"] as const) {
    await page.getByRole("button", { name: surface, exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(0); await expect(address).toHaveValue("");
    await address.fill("https://example.com"); await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(address).toHaveValue("https://example.com/");
  }
  await page.getByRole("button", { name: "normal_conversation", exact: true }).click();
  await expect(address).toHaveValue("http://localhost:3000/"); await expect(page.getByRole("tab")).toHaveCount(1);
  await page.getByRole("button", { name: "Open a browser tab", exact: true }).click();
  await address.fill("https://example.com/second"); await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await page.getByRole("button", { name: "Close browser tab" }).last().click();
  await expect(address).toHaveValue("http://localhost:3000/");
  await address.fill("javascript:alert(1)"); await page.getByRole("button", { name: "Go", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("could not complete");
  await page.evaluate(() => window.browserFixture.dispose());
  expect(await page.evaluate(() => window.browserFixture.subscriptions())).toBe(0);
  expect(await page.evaluate(() => window.browserFixture.viewports.at(-1)?.visible)).toBe(false);
});

for (const locale of ["en-US", "zh-CN"] as const) for (const colorScheme of ["light", "dark"] as const) {
  test(`Browser layout supports ${locale} ${colorScheme} at desktop sizes`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.addInitScript(locale => { localStorage.setItem("ling-stack.locale", locale); localStorage.setItem("ling-stack.themePreference", "system"); }, locale);
    await page.goto("/e2e/support/desktop-browser.html");
    const address = page.getByRole("textbox", { name: locale === "en-US" ? "Browser address" : "浏览器地址" });
    await expect(address).toBeVisible();
    for (const viewport of [{ width: 1440, height: 960 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => page.locator(".browser-workspace").evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      const evidence = resolve("../../output/playwright/desktop-browser"); await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: `${evidence}/${locale}-${colorScheme}-${viewport.width}.png` });
    }
  });
}

test("Web clients retain browser evidence without an interactive address bar", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/e2e/support/desktop-browser.html?web");
  await expect(page.getByText("Recorded browser evidence", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Browser address" })).toHaveCount(0);
});

test("conversation links use their real scope and independent website/local preferences", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/e2e/support/desktop-browser.html");
  for (const surface of ["normal_conversation", "channel", "teammate_direct"] as const) {
    await page.getByRole("button", { name: surface, exact: true }).click();
    await page.getByRole("link", { name: "Local preview link" }).click();
    await expect(page.getByRole("textbox", { name: "Browser address" })).toHaveValue("http://localhost:3000/from-chat");
    expect(await page.evaluate(() => window.browserFixture.calls.at(-1)?.scope)).toEqual({ surface, ownerId: `thread-${surface}` });
  }
  await page.getByRole("button", { name: "Browser settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Website links", exact: true }).selectOption("system");
  await page.getByText("Restore browser tabs after restart", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Restore browser tabs after restart", exact: true })).not.toBeChecked();
  await page.getByRole("link", { name: "Website link", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "Browser address" })).toHaveValue("http://localhost:3000/from-chat");
  expect(await page.evaluate(() => window.browserFixture.calls.at(-1)?.action)).toBe("open_link");
  expect(await page.evaluate(() => window.browserFixture.calls.filter(call => call.action === "preferences").at(-1))).toMatchObject({
    preferences: { websiteLinks: "system", localhostLinks: "in_app", restoreTabs: false },
  });
});

test("page annotations add an untrusted attachment and independent user comment to the existing draft", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/e2e/support/desktop-browser.html");
  for (const surface of ["normal_conversation", "channel", "teammate_direct"] as const) {
    await page.getByRole("button", { name: surface, exact: true }).click(); await page.getByRole("link", { name: "Local preview link" }).click();
    await page.getByRole("button", { name: "Annotate element", exact: true }).click();
    await page.getByRole("textbox", { name: "Annotation comment", exact: true }).fill(`Adjust the title for ${surface}`);
    await page.getByText("Include selected screenshot", { exact: true }).click();
    await page.getByRole("button", { name: "Locate annotation", exact: true }).click();
    await expect(page.getByText("Annotation is stale. Select the page again.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add to message draft", exact: true }).click();
    await expect(page.getByTestId("annotation-draft")).toHaveText(`Adjust the title for ${surface}`);
    await expect(page.getByRole("textbox", { name: "Annotation comment", exact: true })).toHaveCount(0);
    const submission = await page.evaluate(() => window.browserFixture.submissions.at(-1)!);
    expect(submission.fileNames).toHaveLength(1);
    expect(submission.metadata).toMatchObject({ trust: "untrusted_web_content", scope: { surface, ownerId: `thread-${surface}` } });
    expect(submission.metadata).not.toHaveProperty("screenshot"); expect(submission.metadata).not.toHaveProperty("comment");
  }
});

test("browser management separates profile data, downloads and durable site policies", async ({ page }) => {
  let policy: unknown = { rules: [] };
  await page.route("**/workspace-settings?**", async route => {
    if (route.request().method() === "PATCH") policy = route.request().postDataJSON().desktopBrowserPolicy;
    await route.fulfill({ json: { cwd: "/browser-fixture", settings: { desktopBrowserPolicy: policy } } });
  });
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/e2e/support/desktop-browser.html?management"); await page.getByRole("link", { name: "Local preview link" }).click();
  await page.getByRole("button", { name: "Browser settings", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved website", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear history", exact: true }).click();
  await expect(page.getByRole("button", { name: "Saved website", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Downloads", exact: true }).click();
  await expect(page.getByText(/fixture.txt · Completed/u)).toBeVisible();
  await page.getByText("Ask where to save each download", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Ask where to save each download", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Site permissions", exact: true }).click();
  await page.getByRole("combobox", { name: "Agent browsing", exact: true }).selectOption("deny");
  await page.getByRole("button", { name: "Save site permissions", exact: true }).click();
  await expect.poll(() => policy).toEqual({ rules: [{ origin: "http://localhost:3000", browse: "deny", downloads: "ask", history: "ask", fullCdp: false, webMcp: false }] });
  await page.getByRole("button", { name: "Browser data", exact: true }).click();
  await page.getByText("Cookies", { exact: true }).click();
  await page.getByRole("button", { name: "Review and clear browser data", exact: true }).click();
  await expect(page.getByRole("tab")).toHaveCount(0);
  expect(await page.evaluate(() => window.browserFixture.calls.at(-1))).toMatchObject({ action: "clear_data", cookies: true, storage: false, cache: false, history: false });
});
