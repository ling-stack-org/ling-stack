import { expect, test, type Locator } from "@playwright/test";

for (const messageCount of [2, 120]) {
for (const locale of ["en-US", "zh-CN"] as const) {
for (const theme of ["light", "dark"] as const) {
test(`${messageCount} messages ${locale} ${theme}: diagram dialog contains keyboard focus and restores the opener without moving the reader`, async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(({ locale, theme }) => {
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify({ mode: "fixed", themeId: `ling-${theme}` }));
  }, { locale, theme });
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async count => {
    const path = "/e2e/support/p2-reading-harness.tsx";
    window.p2ReadingHarness = (await import(path)).mountReadingFixture(count);
    window.p2ReadingHarness.stream("```mermaid\nflowchart LR\n  Prompt --> Execute\n  Execute --> Verify\n```", true);
  }, messageCount);
  try {
    const feed = page.getByLabel(locale === "zh-CN" ? "对话消息" : "Conversation messages", { exact: true });
    const figure = feed.locator('[data-rich-content="mermaid"]');
    await expect(figure).toHaveAttribute("data-render-status", "rendered", { timeout: 15_000 });
    const names = locale === "zh-CN"
      ? { expand: "展开详情", preview: "预览", close: "关闭预览", copy: "复制代码", copied: "已复制" }
      : { expand: "Expand details", preview: "Preview", close: "Close preview", copy: "Copy code", copied: "Copied" };
    const opener = figure.getByRole("button", { name: names.expand, exact: true });
    await opener.focus();
    const offset = await feed.evaluate(element => element.scrollTop);
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: names.preview, exact: true });
    const close = dialog.getByRole("button", { name: names.close, exact: true });
    await expect(close).toBeFocused();
    await expect(dialog).toHaveCSS("animation-name", "none");
    await expectDiagramAboveReader(dialog);
    await expect(page.locator("html")).toHaveAttribute("data-ui-theme", `ling-${theme}`);
    await page.screenshot({ path: info.outputPath("diagram-dialog-keyboard.png") });
    await page.keyboard.press("Tab");
    const copy = dialog.getByRole("button", { name: names.copy, exact: true });
    await expect.soft(copy).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("button", { name: names.copied, exact: true })).toBeFocused();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Prompt --> Execute");
    await page.keyboard.press("Shift+Tab");
    await expect.soft(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect.soft(opener).toBeFocused();
    expect(await feed.evaluate(element => element.scrollTop)).toBe(offset);
    if (messageCount > 80) {
      await opener.press("Enter");
      await expect(close).toBeFocused();
      await feed.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
      await expect(feed.locator('[data-feed-item-id="message:user:reading-message-0"]')).toBeAttached();
      await expect(dialog).toBeVisible();
      await expect(close).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
      expect(await feed.evaluate(element => element.scrollTop)).toBe(0);
    }
    const beforePointerClose = await feed.evaluate(element => element.scrollTop);
    await opener.press("Enter");
    await expect(close).toBeFocused();
    await close.click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await feed.evaluate(element => element.scrollTop)).toBe(beforePointerClose);
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => window.p2ReadingHarness.dispose());
  }
});
}
}
}

test("streamed tokens never enter a live region while a meaningful preview failure has one status owner", async ({ page }, info) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "zh-CN"));
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async () => {
    const path = "/e2e/support/p2-reading-harness.tsx";
    window.p2ReadingHarness = (await import(path)).mountReadingFixture(2);
  });
  const feed = page.getByLabel("对话消息", { exact: true });
  try {
    await expect(feed).toBeVisible();
    for (let index = 1; index <= 12; index++) {
      const text = `P2_STREAM_TOKEN_${index}`;
      await page.evaluate(text => window.p2ReadingHarness.stream(text), text);
      const message = feed.getByText(text, { exact: true });
      await expect(message).toBeVisible();
      expect(await message.evaluate(element => Boolean(element.closest('[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])')))).toBe(false);
      await expect(page.locator('[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])').filter({ hasText: text })).toHaveCount(0);
    }
    await page.evaluate(() => window.p2ReadingHarness.stream(`\`\`\`mermaid\n${"x".repeat(40_001)}\n\`\`\``, true));
    await expect(feed.locator('[data-rich-content="mermaid"]')).toHaveAttribute("data-render-status", "error");
    await expect(feed.getByRole("status")).toHaveCount(1);
    await expect(feed.getByRole("status")).toHaveText("预览不可用");
    await page.screenshot({ path: info.outputPath("bounded-preview-failure-status.png") });
  } finally {
    await page.evaluate(() => window.p2ReadingHarness.dispose());
  }
});

for (const messageCount of [2, 120]) {
for (const initialTheme of ["light", "dark"] as const) {
test(`${messageCount} messages: open diagram keeps its dialog and keyboard focus while ${initialTheme} theme redraws`, async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.emulateMedia({ colorScheme: initialTheme, reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/e2e/support/p2-reading.html?manual");
  await page.evaluate(async count => {
    const path = "/e2e/support/p2-reading-harness.tsx";
    window.p2ReadingHarness = (await import(path)).mountReadingFixture(count);
    window.p2ReadingHarness.stream("```mermaid\nflowchart LR\n  Prompt --> Execute\n  Execute --> Verify\n```", true);
  }, messageCount);
  try {
    const feed = page.getByLabel("Conversation messages", { exact: true });
    const figure = feed.locator('[data-rich-content="mermaid"]');
    await expect(figure).toHaveAttribute("data-render-status", "rendered", { timeout: 15_000 });
    const opener = figure.getByRole("button", { name: "Expand details", exact: true });
    await opener.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Preview", exact: true });
    const originalDialog = await dialog.elementHandle();
    const close = dialog.getByRole("button", { name: "Close preview", exact: true });
    await expect(close).toBeFocused();
    const offset = await feed.evaluate(element => element.scrollTop);
    const previousSvg = await dialog.locator(".message-mermaid-expanded svg").getAttribute("id");
    await page.emulateMedia({ colorScheme: initialTheme === "light" ? "dark" : "light" });
    await expect.poll(() => dialog.locator(".message-mermaid-expanded svg").getAttribute("id")).not.toBe(previousSvg);
    expect(await originalDialog?.evaluate(element => element.isConnected)).toBe(true);
    await expect(close).toBeFocused();
    await expectDiagramAboveReader(dialog);
    await page.screenshot({ path: info.outputPath("diagram-theme-redraw.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    expect(await feed.evaluate(element => element.scrollTop)).toBe(offset);
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => window.p2ReadingHarness.dispose());
  }
});
}
}

async function expectDiagramAboveReader(dialog: Locator): Promise<void> {
  const layers = await dialog.evaluate(element => ({
    reader: Number(getComputedStyle(document.querySelector("#p2-reading-fixture")!).zIndex),
    dialog: Number(getComputedStyle(element).zIndex),
  }));
  // Radix can suppress background hit testing without preventing visual occlusion.
  expect(layers.reader).toBeLessThan(layers.dialog);
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(dialog.locator(".message-mermaid-expanded svg")).toBeInViewport({ ratio: 1 });
}
