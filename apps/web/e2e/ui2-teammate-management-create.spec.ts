import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  isRecord,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/ai-teammate-management-create/",
  import.meta.url,
));

test("default roles use one compact shared-control catalog", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCreateState();
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openTeammateManagement(page);
  const catalog = surface.locator("[data-ui2-teammate-role-catalog]");
  await expect(catalog).toBeVisible();
  await expect(catalog.getByRole("heading", { name: "Default roles" })).toBeVisible();
  const roleRows = catalog.locator(".teammate-role-catalog-row");
  expect(await roleRows.count()).toBeGreaterThanOrEqual(5);
  await expect(roleRows.first()).toHaveClass(/ling-ui-button/);
  const createButton = catalog.getByRole("button", { name: "New AI teammate" });
  await expect(createButton).toHaveClass(/ling-ui-button/);
  await expect(createButton.locator("[data-ling-button-slot='label']")).toContainText("New teammate");
  const createLabelOverflow = await createButton.locator("[data-ling-button-slot='label']")
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(createLabelOverflow).toBeLessThanOrEqual(1);

  const layout = await catalog.evaluate((element) => {
    const firstRow = element.querySelector<HTMLElement>(".teammate-role-catalog-row");
    const style = firstRow ? getComputedStyle(firstRow) : undefined;
    const pseudo = firstRow ? getComputedStyle(firstRow, "::after") : undefined;
    return {
      overflow: element.scrollWidth - element.clientWidth,
      rowOverflow: firstRow ? firstRow.scrollWidth - firstRow.clientWidth : Number.NaN,
      color: style?.color ?? "",
      background: style?.backgroundColor ?? "",
      pseudoContent: pseudo?.content ?? "",
    };
  });
  expect(layout.overflow).toBeLessThanOrEqual(1);
  expect(layout.rowOverflow).toBeLessThanOrEqual(1);
  expect(layout.color).not.toBe(layout.background);
  expect(["none", "normal", "\"\""]).toContain(layout.pseudoContent);

  const productRole = catalog.getByRole("button", { name: /Product Strategist/u });
  await productRole.click();
  await expect(page.getByRole("dialog", { name: "Role detail" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Role detail" })).toHaveCount(0);
  await expect(productRole).toBeFocused();
  await captureEvidence(page, "1440x960-ling-light-default-roles.png");

  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("role and custom setup use the shared dialog and form grammar", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800, "reduce");
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCreateState();
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openTeammateManagement(page);
  const dialog = await openCreateDialog(page, surface);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-ui2-teammate-create", "true");
  await expect(dialog.getByLabel("Teammate template chooser")).toBeVisible();
  await expect(dialog.getByLabel("Teammate name").locator("xpath=..")).toHaveClass(/ling-ui-input/);
  await expect(dialog.getByLabel("Join channels").locator("xpath=..")).toHaveClass(/ling-ui-select/);
  await expect(dialog.getByLabel("Base model").locator("xpath=..")).toHaveClass(/ling-ui-select/);
  await expect(dialog.getByRole("button", { name: "Create teammate" })).toHaveClass(/ling-ui-button/);

  const dialogLayout = await dialog.evaluate((element) => {
    const body = element.querySelector<HTMLElement>(".ling-ui-dialog-body");
    const footer = element.querySelector<HTMLElement>(".ling-ui-dialog-footer");
    const dialogRect = element.getBoundingClientRect();
    return {
      overflow: element.scrollWidth - element.clientWidth,
      bodyOverflowY: body ? getComputedStyle(body).overflowY : "",
      footerInsideBody: Boolean(body && footer && body.contains(footer)),
      oversized: Array.from(element.querySelectorAll<HTMLElement>("*"))
        .map((child) => {
          const rect = child.getBoundingClientRect();
          const style = getComputedStyle(child);
          return {
            className: child.className,
            left: Math.round(rect.left - dialogRect.left),
            right: Math.round(rect.right - dialogRect.right),
            scrollOverflow: child.scrollWidth - child.clientWidth,
            margin: style.margin,
          };
        })
        .filter((child) => child.right > 1 || child.left < -1 || child.scrollOverflow > 1)
        .slice(0, 12),
    };
  });
  expect(dialogLayout.overflow, JSON.stringify(dialogLayout.oversized)).toBeLessThanOrEqual(1);
  expect(dialogLayout.bodyOverflowY).toBe("auto");
  expect(dialogLayout.footerInsideBody).toBe(false);
  await captureEvidence(page, "1280x800-ling-dark-role-select.png");

  await dialog.getByRole("button", { name: /Start from blank/ }).click();
  await expect(dialog.getByLabel("Custom teammate setup")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Back" })).toHaveClass(/ling-ui-button/);
  await expect(dialog.getByLabel("Teammate name").locator("xpath=..")).toHaveClass(/ling-ui-input/);
  await expect(dialog.getByLabel("Brief description")).toHaveClass(/ling-ui-textarea/);
  await dialog.getByLabel("Upload avatar").setInputFiles({
    name: "ui2-avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
  });
  await expect(dialog.getByText("ui2-avatar.png")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Remove avatar" })).toHaveClass(/ling-ui-button/);

  await page.setViewportSize({ width: 1440, height: 960 });
  await captureEvidence(page, "1440x960-ling-dark-custom-setup.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("model failure remains in the progress dialog and returns to the original setup", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCreateState("provider_broken");
  await mockDaemon(page, state, { providerCheckModelUnsupportedProviderIds: ["broken-relay"] });
  await page.goto("/");

  const initialCount = state.aiTeammates.length;
  const surface = await openTeammateManagement(page);
  const dialog = await openCreateDialog(page, surface);
  await dialog.getByRole("button", { name: /Start from blank/ }).click();
  await dialog.getByLabel("Teammate name").fill("Blocked UI2 teammate");
  await dialog.getByLabel("Brief description").fill("Keeps the failed state inspectable.");
  await dialog.getByLabel("Base model").selectOption("provider_broken");
  await dialog.getByRole("button", { name: "Create and verify" }).click();

  const progress = dialog.getByLabel("Teammate setup progress");
  await expect(progress).toBeVisible();
  await expect(progress).toContainText("Setup needs attention");
  await expect(progress.locator(".teammate-create-step")).toHaveCount(7);
  await expect(progress.locator(".teammate-create-step.failed")).toContainText("Model check");
  await expect(dialog.getByRole("button", { name: "Back to setup" })).toBeVisible();
  await expect.poll(() => state.aiTeammates.length).toBe(initialCount);
  await captureEvidence(page, "1280x800-ling-dark-model-failure.png");

  await dialog.getByRole("button", { name: "Back to setup" }).click();
  await expect(dialog.getByLabel("Custom teammate setup")).toBeVisible();
  await expect(dialog.getByLabel("Teammate name")).toHaveValue("Blocked UI2 teammate");
  await expect(dialog.getByLabel("Brief description")).toHaveValue("Keeps the failed state inspectable.");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("post-create setup failure opens the created teammate without creating a duplicate", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCreateState();
  await mockDaemon(page, state, { failTeammateAvatarUploads: true });
  await page.goto("/");

  const initialCount = state.aiTeammates.length;
  const surface = await openTeammateManagement(page);
  const dialog = await openCreateDialog(page, surface);
  await dialog.getByRole("button", { name: /Start from blank/ }).click();
  await dialog.getByLabel("Teammate name").fill("Created With Warning");
  await dialog.getByLabel("Upload avatar").setInputFiles({
    name: "warning-avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"),
  });
  await dialog.getByRole("button", { name: "Create and verify" }).click();

  const progress = dialog.getByLabel("Teammate setup progress");
  await expect(progress).toContainText("Teammate created with setup warnings");
  await expect(progress.locator(".teammate-create-step.failed")).toContainText("Upload avatar");
  await expect(dialog.getByRole("button", { name: "Back to setup" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Open chat" })).toBeVisible();
  await expect.poll(() => state.aiTeammates.length).toBe(initialCount + 1);
  await captureEvidence(page, "1440x960-ling-light-partial-warning.png");

  await dialog.getByRole("button", { name: "Open chat" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Created With Warning", level: 1 })).toBeVisible();
  await expect.poll(() => state.aiTeammates.length).toBe(initialCount + 1);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("successful creation closes the complete dialog and opens the created private chat", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCreateState();
  state.providerCheckDelayMs = 40;
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openTeammateManagement(page);
  const dialog = await openCreateDialog(page, surface);
  await dialog.getByLabel("Teammate name").fill("UI2 Engineer");
  await dialog.getByRole("button", { name: "Create teammate" }).click();

  await expect(dialog.getByLabel("Teammate setup progress")).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "UI2 Engineer", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Private chat", { exact: true })).toBeVisible();
  await expect.poll(() => state.aiTeammates.some((item) => isRecord(item) && item.displayName === "UI2 Engineer")).toBe(true);
  expect(runtimeErrors).toEqual([]);
});

function createCreateState(providerId = "provider_ready"): ReturnType<typeof createBaseState> {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: providerId,
    providerId: providerId === "provider_broken" ? "broken-relay" : "local-relay",
    displayName: providerId === "provider_broken" ? "Broken Relay" : "Local Relay",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "Ready", checkedAt: "2026-07-20T00:00:00.000Z" },
  })];
  state.aiTeammates = [createMockTeammate({
    id: "teammate_existing",
    templateId: "engineer",
    roleKey: "engineer",
    displayName: "Existing Engineer",
    providerPresetId: providerId,
  })];
  return state;
}

async function openTeammateManagement(page: Page): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Teammate Management" }).click();
  const surface = page.locator("[data-ui2-settings-workspace-tool][data-settings-workspace-tool='teammates']");
  await expect(surface).toBeVisible();
  return surface;
}

async function openCreateDialog(page: Page, surface: Locator): Promise<Locator> {
  await surface.getByRole("button", { name: "New AI teammate" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create AI teammate" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  width: number,
  height: number,
  reducedMotion: "no-preference" | "reduce" = "no-preference",
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion });
  await page.addInitScript(({ initialTheme }) => {
    const themeId = initialTheme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", initialTheme);
  }, { initialTheme: theme });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.locator(".settings-layout").screenshot({
    animations: "disabled",
    path: `${evidenceDirectory}${filename}`,
  });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
