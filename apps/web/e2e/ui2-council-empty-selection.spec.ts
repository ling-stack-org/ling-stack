import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

test.describe.configure({ timeout: 60_000 });

const themes = [
  { height: 960, id: "light", width: 1440 },
  { height: 800, id: "dark", width: 1280 },
] as const;

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/council-empty-selection/",
  import.meta.url,
));

for (const theme of themes) {
  test(`Council keeps its populated-list empty selection actionable in ${theme.id} mode`, async ({ page }) => {
    await prepareSurface(page, theme);
    const runtimeErrors = collectRuntimeErrors(page);
    const state = createBaseState({ approvalStatus: "expired" });
    expect(state.aiCouncils.length).toBeGreaterThan(0);
    await mockDaemon(page, state);
    await page.goto("/");

    const surface = await openCouncilWorkspace(page);
    await expect(surface.locator(".council-list-health-row").first()).toBeVisible();

    await surface.getByLabel("Search councils").fill("no-council-can-match-this-query");
    await expect(surface.locator(".council-list-health-row")).toHaveCount(0);
    await expect(surface.getByText("No councils match the current filters", { exact: true })).toBeVisible();

    const detail = surface.getByLabel("Selected council");
    const emptyState = detail.locator(".ling-ui-empty-state");
    await expect(emptyState).toHaveCount(1);
    await expect(emptyState).toHaveAttribute("data-compact", "true");
    await expect(emptyState.locator(".ling-ui-empty-state-title")).toHaveText("No council selected");
    await expect(emptyState.locator(".ling-ui-empty-state-description"))
      .toHaveText("Select a council to manage members, channels, and settings.");
    await expect(emptyState).not.toHaveClass(/(?:^|\s)operation-empty-state(?:\s|$)/u);

    const actions = emptyState.locator(".ling-ui-empty-state-actions");
    await expect(actions.getByRole("button")).toHaveCount(2);
    const secondaryAction = actions.getByRole("button", { name: "Open AI Teammates", exact: true });
    const primaryAction = actions.getByRole("button", { name: "Create council", exact: true });
    await expect(secondaryAction).toHaveAttribute("data-variant", "secondary");
    await expect(primaryAction).toHaveAttribute("data-variant", "primary");
    await expectTextNotClipped(secondaryAction);
    await expectTextNotClipped(primaryAction);
    await expectContainedBy(detail, emptyState);
    await expectContainedBy(detail, secondaryAction);
    await expectContainedBy(detail, primaryAction);
    await captureEvidence(page, `${theme.width}x${theme.height}-ling-${theme.id}-council-empty-selection.png`);

    await primaryAction.click();
    const dialog = page.getByRole("dialog", { name: "Create council" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await secondaryAction.click();
    await expect(page.locator("[data-settings-workspace-tool='teammates']")).toBeVisible();
    await expectNoPageOverflow(page);
    expect(runtimeErrors).toEqual([]);
  });
}

async function openCouncilWorkspace(page: Page): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Council Workspace", exact: true }).click();
  const surface = page.locator("[data-settings-workspace-tool='councils']");
  await expect(surface).toBeVisible();
  return surface;
}

async function prepareSurface(
  page: Page,
  theme: { readonly height: number; readonly id: "dark" | "light"; readonly width: number },
): Promise<void> {
  await page.setViewportSize({ width: theme.width, height: theme.height });
  await page.emulateMedia({ colorScheme: theme.id });
  await page.addInitScript(({ themeId }) => {
    const selectedThemeId = themeId === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId: selectedThemeId };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, { themeId: theme.id });
}

async function expectContainedBy(container: Locator, target: Locator): Promise<void> {
  const [containerBox, targetBox] = await Promise.all([container.boundingBox(), target.boundingBox()]);
  expect(containerBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  expect(targetBox!.x).toBeGreaterThanOrEqual(containerBox!.x - 1);
  expect(targetBox!.y).toBeGreaterThanOrEqual(containerBox!.y - 1);
  expect(targetBox!.x + targetBox!.width).toBeLessThanOrEqual(containerBox!.x + containerBox!.width + 1);
  expect(targetBox!.y + targetBox!.height).toBeLessThanOrEqual(containerBox!.y + containerBox!.height + 1);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientHeight: document.documentElement.clientHeight,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);
}

async function expectTextNotClipped(target: Locator): Promise<void> {
  expect(await target.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
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
