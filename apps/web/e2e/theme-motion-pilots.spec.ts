import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider } from "./support/mock-state";
import { installNormalConversationFixture, normalConversationFixtureTitle } from "./support/normal-conversation-fixture";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const activeFeedback = ".ling-ui-file-drop-feedback[data-active=true]";
const glint = ".ling-ui-file-drop-glint";

test("theme cards use the active palette and keep keyboard selection, focus and identity", async ({ page }) => {
  const errors = watchErrors(page);
  await prepare(page);
  const panel = await preferences(page);
  const light = panel.locator('[data-theme-option-id="ling-light"]');
  const dark = panel.locator('[data-theme-option-id="ling-dark"]');
  await light.hover({ position: { x: 24, y: 28 } });
  await expect(light).toHaveAttribute("data-spotlight", "true");
  const initial = await light.evaluate(element => ({
    gradient: getComputedStyle(element, "::before").backgroundImage,
    x: (element as HTMLElement).style.getPropertyValue("--ling-spot-x"),
    pointerEvents: getComputedStyle(element, "::before").pointerEvents,
  }));
  expect(Math.abs(Number.parseFloat(initial.x) - 24)).toBeLessThan(2);
  expect(initial.pointerEvents).toBe("none");
  const identity = await dark.elementHandle();
  await dark.focus();
  await dark.press("Space");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect(dark).toBeFocused();
  expect(await dark.evaluate((element, original) => element === original, identity)).toBe(true);
  expect(await light.evaluate(element => getComputedStyle(element, "::before").backgroundImage)).not.toBe(initial.gradient);
  await dark.press("ArrowRight");
  await expect(light).toBeFocused();
  await light.press("Space");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-light");
  const breeze = panel.locator('[data-theme-option-id="ling-breeze"]');
  await breeze.click();
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-breeze");
  await light.hover();
  expect(await light.evaluate(element => getComputedStyle(element, "::before").backgroundImage)).not.toBe(initial.gradient);
  await noOverflow(page);
  await page.screenshot({ path: test.info().outputPath("1440x960-green-theme-card.png") });
  expect(errors).toEqual([]);
});

for (const mode of ["light", "dark", "breeze"] as const) {
  test(`${mode} background editor drop distinguishes reception from validation and preserves the committed background on error`, async ({ page }) => {
    const errors = watchErrors(page);
    await prepare(page);
    if (mode === "dark") await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize(mode === "dark" ? { width: 1280, height: 800 } : { width: 1440, height: 960 });
    const panel = await preferences(page);
    if (mode === "breeze") {
      await panel.locator('[data-theme-option-id="ling-breeze"]').click();
      await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-breeze");
    }
    await expect(panel.getByRole("button", { name: "Create theme", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Import theme", exact: true })).toHaveCount(0);
    const zone = panel.locator(".background-editor");
    await expect(zone.locator('input[type=file]')).toBeEnabled();
    const before = await zone.boundingBox();
    await drag(page, zone, "dragover");
    await expect(zone.locator(activeFeedback)).toHaveCount(1);
    const palette = await dropPalette(zone);
    expect(palette.border).toBe(palette.expectedBorder);
    expect(palette.background).toBe(palette.expectedBackground);
    await expect(zone.locator(".ling-ui-file-drop-feedback")).toHaveCSS("pointer-events", "none");
    await drag(page, zone, "dragleave", { inside: true });
    await expect(zone.locator(activeFeedback)).toHaveCount(1);
    expect(await zone.boundingBox()).toEqual(before);
    await page.screenshot({ path: test.info().outputPath(`${mode}-studio-drag-active.png`) });
    await drag(page, zone, "dragleave");
    await expect(zone.locator(activeFeedback)).toHaveCount(0);
    await drag(page, zone, "drop", { file: false });
    await expect(zone.locator(glint)).toHaveCount(0);

    await observeGlints(zone);
    await drag(page, zone, "drop", { name: "palette.png" });
    await expect(panel.locator('[data-background-preview]')).toHaveAttribute("data-draft", "true");
    expect(await glintCount(zone)).toBe(1);
    const received = await glintDetails(zone);
    expect(received.duration).toBe("0.18s");
    expect(received.background).toBe(received.expectedBackground);
    expect(Math.max(Number.parseFloat(received.width), Number.parseFloat(received.height))).toBe(56);
    expect(Math.min(Number.parseFloat(received.width), Number.parseFloat(received.height))).toBe(2);
    await expect(zone.locator(glint)).toHaveCount(0);
    await drag(page, zone, "drop", { name: "invalid.svg", invalid: true });
    await expect(panel.locator('[data-background-settings]').getByRole("alert")).toBeVisible();
    await expect(panel.locator('[data-background-preview]')).toHaveAttribute("data-draft", "false");
    await expect(page.locator("html")).toHaveAttribute("data-user-background", mode === "breeze" ? "ready" : "off");
    await drag(page, zone, "drop", { name: "replacement.png" });
    await expect(panel.locator('[data-background-settings]').getByRole("alert")).toHaveCount(0);
    await expect(panel.locator('[data-background-preview]')).toHaveAttribute("data-draft", "true");
    await noOverflow(page);
    expect(errors).toEqual([]);
  });
}

test("reduced motion and forced colors keep static feedback without tracking or moving edge glints", async ({ page }) => {
  const errors = watchErrors(page);
  await prepare(page);
  const panel = await preferences(page);
  const light = panel.locator('[data-theme-option-id="ling-light"]');
  await page.emulateMedia({ reducedMotion: "reduce" });
  await light.hover({ position: { x: 20, y: 20 } });
  await expect(light).not.toHaveAttribute("data-spotlight");
  expect(await light.evaluate(element => getComputedStyle(element, "::before").getPropertyValue("--ling-spot-x").trim())).toBe("50%");
  await light.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(light).toBeFocused();
  await page.emulateMedia({ forcedColors: "active" });
  expect(await light.evaluate(element => getComputedStyle(element, "::before").display)).toBe("none");
  const zone = panel.locator(".background-editor");
  await expect(zone.locator('input[type=file]')).toBeEnabled();
  await observeGlints(zone);
  await drag(page, zone, "dragover");
  await expect(zone.locator(activeFeedback)).toHaveCount(1);
  expect((await dropPalette(zone)).borderWidth).toBe("2px");
  await drag(page, zone, "drop");
  await expect(panel.locator('[data-background-preview]')).toHaveAttribute("data-draft", "true");
  expect(await glintCount(zone)).toBe(0);
  await page.screenshot({ path: test.info().outputPath("forced-colors-reduced-motion.png") });
  await page.emulateMedia({ forcedColors: "none" });
  await drag(page, zone, "drop", { name: "reduced-only.png" });
  await expect(panel.locator('[data-background-preview]')).toHaveAttribute("data-draft", "true");
  expect(await glintCount(zone)).toBe(0);
  expect(errors).toEqual([]);
});

test("normal conversation keeps draft and focus while drop uploads, fails and retries", async ({ page }) => {
  const errors = watchErrors(page, true);
  const state = await prepare(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: /Open recent conversation \d+/ }).filter({ hasText: normalConversationFixtureTitle }).click();
  const composer = page.getByLabel("New conversation composer", { exact: true });
  const zone = composer.locator(".conversation-composer-input-zone");
  const textbox = composer.getByRole("textbox");
  await expect(composer.locator('input[type=file]')).toBeEnabled();
  await textbox.fill("Keep my conversation draft");
  let uploads = 0;
  let release!: () => void;
  let fail = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/conversations/attachments?**", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    uploads += 1;
    if (uploads === 1) await held;
    if (fail) return route.fulfill({ status: 500, json: { error: "controlled_upload_failure", message: "Controlled upload failure" } });
    return route.fallback();
  });
  await observeGlints(zone);
  await drag(page, zone, "dragover");
  await expect(composer.getByText("Drop files to attach", { exact: true })).toBeVisible();
  await drag(page, textbox, "dragleave", { inside: true });
  await expect(zone.locator(activeFeedback)).toHaveCount(1);
  await drag(page, zone, "drop", { name: "notes.txt", text: true });
  await expect(composer.locator(".composer-preview-card.uploading")).toBeVisible();
  expect(await glintCount(zone)).toBe(1);
  await expect(textbox).toBeFocused();
  await expect(textbox).toHaveText("Keep my conversation draft");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect(textbox).toBeFocused();
  await expect(textbox).toHaveText("Keep my conversation draft");
  release();
  await expect(composer.locator(".composer-preview-card.ready")).toContainText("notes.txt");
  fail = true;
  await drag(page, zone, "drop", { name: "failed.txt", text: true });
  await expect(composer.locator(".composer-preview-card.failed")).toContainText("failed.txt");
  await page.screenshot({ path: test.info().outputPath("1280x800-dark-attachment-error.png") });
  fail = false;
  await composer.locator(".composer-preview-card.failed").getByRole("button", { name: /Retry/ }).click();
  await expect(composer.locator(".composer-preview-card.ready")).toHaveCount(2);
  expect(uploads).toBe(3);
  expect(state.conversationAttachments).toHaveLength(2);
  await drag(page, zone, "dragover");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(zone.locator(activeFeedback)).toHaveCount(0);
  await drag(page, zone, "dragover");
  await page.evaluate(() => window.dispatchEvent(new Event("dragend")));
  await expect(zone.locator(activeFeedback)).toHaveCount(0);
  await drag(page, zone, "drop", { file: false });
  await drag(page, zone, "drop", { nonFile: true });
  expect(uploads).toBe(3);
  await page.emulateMedia({ forcedColors: "active" });
  // Deliver the preference-change event (which clears drag feedback) before the next drag.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await drag(page, zone, "dragover");
  const hint = composer.locator(".composer-drop-hint");
  await expect(hint).toHaveCSS("border-top-width", "2px");
  expect(await hint.evaluate(element => getComputedStyle(element).borderColor)).toBe((await dropPalette(zone)).border);
  await noOverflow(page);
  expect(errors).toEqual([]);
});

test("loading conversation scope blocks file drop and resets drag feedback on navigation", async ({ page }) => {
  const errors = watchErrors(page);
  const state = await prepare(page);
  const threadId = state.threads[0].id;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/conversations/${threadId}?**`, async route => {
    if (route.request().method() === "GET") await held;
    return route.fallback();
  });
  await page.getByRole("button", { name: /Open recent conversation \d+/ }).filter({ hasText: normalConversationFixtureTitle }).click();
  const composer = page.getByLabel("New conversation composer", { exact: true });
  const zone = composer.locator(".conversation-composer-input-zone");
  await expect(composer.locator('input[type=file]')).toBeDisabled();
  await observeGlints(zone);
  await drag(page, zone, "dragover");
  await expect(zone.locator(activeFeedback)).toHaveCount(0);
  await drag(page, zone, "drop", { name: "blocked.txt", text: true });
  expect(await glintCount(zone)).toBe(0);
  expect(state.conversationAttachments).toHaveLength(0);
  release();
  await expect(composer.locator('input[type=file]')).toBeEnabled();
  await drag(page, zone, "dragover");
  await expect(zone.locator(activeFeedback)).toHaveCount(1);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator(activeFeedback)).toHaveCount(0);
  expect(errors).toEqual([]);
});

async function prepare(page: Page) {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
    const selection = { mode: "system", lightThemeId: "ling-light", darkThemeId: "ling-dark" };
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
  });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({ id: "motion-provider", lastCheck: {
    ok: true, code: "ready", message: "Controlled motion acceptance fixture", checkedAt: "2026-10-18T00:00:00.000Z",
  } })];
  state.workspaceSettings.defaultProviderPresetId = state.providers[0].id;
  state.approvals = [];
  installNormalConversationFixture(state);
  await mockDaemon(page, state);
  // These pilots use an explicit Pi workspace. Native selection states have
  // their own regression coverage; an omitted new endpoint must not return 404.
  await page.route("**/runtime/conversation-execution**", async route => {
    const cwd = new URL(route.request().url()).searchParams.get("cwd") ?? "";
    await route.fulfill({ json: { cwd, status: "not_selected", defaultRunnerId: "pi" } });
  });
  await page.goto("/");
  return state;
}

async function preferences(page: Page) {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Interface preferences", exact: true }).click();
  const panel = page.locator("[data-ui2-interface-preferences]");
  await expect(panel).toBeVisible();
  return panel;
}

async function drag(page: Page, target: Locator, type: string, options: { file?: boolean; inside?: boolean; invalid?: boolean; name?: string; nonFile?: boolean; text?: boolean } = {}) {
  const transfer = await page.evaluateHandle(({ png, options }) => {
    const data = new DataTransfer();
    if (options.nonFile) data.setData("text/plain", "not a file");
    else if (options.file !== false) {
      const bytes = options.invalid || options.text ? "controlled test file" : Uint8Array.from(atob(png), char => char.charCodeAt(0));
      data.items.add(new File([bytes], options.name ?? "palette.png", { type: options.invalid ? "image/svg+xml" : options.text ? "text/plain" : "image/png" }));
    }
    return data;
  }, { png, options });
  const bounds = await target.boundingBox();
  await target.dispatchEvent(type, { dataTransfer: transfer, clientX: type === "dragleave" && !options.inside ? 0 : (bounds?.x ?? 0) + 24, clientY: type === "dragleave" && !options.inside ? 0 : (bounds?.y ?? 0) + 24 });
  await transfer.dispose();
}

async function dropPalette(zone: Locator) {
  return zone.locator(".ling-ui-file-drop-feedback").evaluate(element => ({
    border: getComputedStyle(element, "::before").borderColor,
    borderWidth: getComputedStyle(element, "::before").borderTopWidth,
    background: getComputedStyle(element, "::before").backgroundColor,
    expectedBorder: (() => { const probe = document.createElement("span"); probe.style.color = "var(--ling-border-focus)"; element.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })(),
    expectedBackground: (() => { const probe = document.createElement("span"); probe.style.backgroundColor = "color-mix(in srgb, var(--ling-action-accent) 5%, transparent)"; element.append(probe); const color = getComputedStyle(probe).backgroundColor; probe.remove(); return color; })(),
  }));
}

async function observeGlints(zone: Locator) {
  await zone.evaluate(element => {
    element.setAttribute("data-received-glints", "0");
    new MutationObserver(records => {
      for (const record of records) for (const added of record.addedNodes) {
        if (added instanceof Element && added.matches(".ling-ui-file-drop-glint")) {
          element.setAttribute("data-received-glints", String(Number(element.getAttribute("data-received-glints")) + 1));
          const style = getComputedStyle(added);
          element.setAttribute("data-last-glint", JSON.stringify({
            background: style.backgroundImage,
            duration: style.animationDuration,
            edge: added.getAttribute("data-edge"),
            height: style.height,
            width: style.width,
          }));
        }
      }
    }).observe(element, { childList: true, subtree: true });
  });
}

async function glintCount(zone: Locator) { return Number(await zone.getAttribute("data-received-glints")); }

async function glintDetails(zone: Locator): Promise<{ background: string; duration: string; edge: string; height: string; width: string; expectedBackground: string }> {
  return zone.evaluate(element => {
    const details = JSON.parse(element.getAttribute("data-last-glint") ?? "null");
    if (!details) throw new Error("No edge glint was observed");
    const probe = document.createElement("span");
    const direction = details.edge === "top" || details.edge === "bottom" ? "90deg" : "180deg";
    probe.style.backgroundImage = `linear-gradient(${direction}, transparent, color-mix(in srgb, var(--ling-border-focus) 72%, transparent), transparent)`;
    element.append(probe);
    const expectedBackground = getComputedStyle(probe).backgroundImage;
    probe.remove();
    return { ...details, expectedBackground };
  });
}

function watchErrors(page: Page, controlledFailure = false) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !(controlledFailure && /500 \(Internal Server Error\)/.test(message.text()))) errors.push(message.text());
  });
  return errors;
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
