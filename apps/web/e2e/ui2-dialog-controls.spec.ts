import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/shell/ui2-dialog-foundation/",
  import.meta.url,
));

test("UI 2.0 dialog owns dismissal, focus restoration, scrolling, and busy safety", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "pending" });
  state.channels = [];
  state.channelBranches = [];
  state.channelCreateDelayMs = 1_500;
  await mockDaemon(page, state);
  await page.goto("/");

  const trigger = page.getByLabel("Ling Stack navigation").getByRole("button", { name: "No channel yet" });
  await trigger.click();

  let dialog = page.getByRole("dialog", { name: "New channel" });
  await expectDialogContract(dialog, page, 1440, 960);
  await expect(dialog.getByRole("heading", { name: "New channel" })).toBeVisible();
  await expect(dialog).toContainText("Name the channel, invite teammates, then create.");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  dialog = page.getByRole("dialog", { name: "New channel" });
  await expect(dialog).toBeVisible();
  await page.locator(".ling-ui-dialog-overlay").click({ position: { x: 4, y: 4 } });
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  dialog = page.getByRole("dialog", { name: "New channel" });
  await dialog.getByLabel("Name").fill("UI Foundation");
  await dialog.getByRole("button", { name: "Create channel" }).click();

  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByRole("button", { name: "Cancel" }).first()).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.locator(".ling-ui-dialog-overlay").click({ position: { x: 4, y: 4 } });
  await expect(dialog).toBeVisible();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Ling Stack navigation").getByRole("button", { name: "UI Foundation" })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("UI 2.0 dialog remains bounded and theme-safe at 1280x800 dark", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 1280, 800);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channels = [];
  state.channelBranches = [];
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "No channel yet" }).click();
  const dialog = page.getByRole("dialog", { name: "New channel" });
  await expectDialogContract(dialog, page, 1280, 800);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const colors = await dialog.evaluate((element) => {
    const styles = getComputedStyle(element);
    return {
      background: styles.backgroundColor,
      color: styles.color,
      border: styles.borderColor,
    };
  });
  expect(colors.background).not.toBe("rgb(255, 255, 255)");
  expect(colors.background).not.toBe(colors.color);
  expect(colors.border).not.toBe(colors.background);
  await captureEvidence(page, dialog, "1280x800-ling-dark-new-channel.png");

  await dialog.getByText("Advanced settings", { exact: true }).click();
  const body = dialog.locator(".ling-ui-dialog-body");
  await expect.poll(async () => body.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(0);
  await body.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect.poll(async () => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  await expect.poll(() => dialog.evaluate((content) => getComputedStyle(content).animationName)).toBe("none");
  await expect.poll(() => page.locator(".ling-ui-dialog-overlay").evaluate((overlay) =>
    getComputedStyle(overlay).animationName
  )).toBe("none");

  await dialog.getByRole("button", { name: "Cancel" }).first().click();
  await expect(dialog).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

async function expectDialogContract(
  dialog: Locator,
  page: Page,
  viewportWidth: number,
  viewportHeight: number,
): Promise<void> {
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/ling-ui-dialog-content/u);
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog).toHaveAttribute("data-size", "lg");
  await expect(dialog.locator(".ling-ui-dialog-header")).toHaveCount(1);
  await expect(dialog.locator(".ling-ui-dialog-body")).toHaveCount(1);
  await expect(dialog.locator(".ling-ui-dialog-footer")).toHaveCount(1);

  const closeButton = dialog.getByRole("button", { name: "Cancel" }).first();
  await expect.poll(async () => (await closeButton.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(32);
  await expect.poll(async () => (await closeButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(32);

  const bodyOverflow = await dialog.locator(".ling-ui-dialog-body").evaluate((element) => ({
    overflowX: getComputedStyle(element).overflowX,
    overflowY: getComputedStyle(element).overflowY,
  }));
  expect(bodyOverflow.overflowX).toBe("hidden");
  expect(bodyOverflow.overflowY).toBe("auto");

  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(16);
  expect(box!.y).toBeGreaterThanOrEqual(16);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth - 16);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight - 16);
  await expectNoHorizontalOverflow(dialog);

  await page.keyboard.press("Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  if (viewportWidth === 1440) {
    await captureEvidence(page, dialog, "1440x960-ling-light-new-channel.png");
  }
}

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((resolvedTheme) => {
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themePreference", resolvedTheme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", resolvedTheme);
  }, theme);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const metrics = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function captureEvidence(page: Page, dialog: Locator, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await dialog.screenshot({ animations: "disabled", path: `${evidenceDirectory}${filename}` });
  await page.locator(".ling-ui-dialog-overlay").screenshot({
    animations: "disabled",
    path: `${evidenceDirectory}overlay-${filename}`,
  });
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
