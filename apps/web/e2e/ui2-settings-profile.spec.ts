import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/settings/settings-profile/",
  import.meta.url,
));

const avatarSvg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#527a69"/><circle cx="80" cy="72" r="34" fill="#f4f4f0"/></svg>',
);

test("Settings Profile uses shared identity, insight, and crop controls at 1440x960 light", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  seedLongProfileUsage(state);
  await mockDaemon(page, state);
  await page.goto("/");
  await openSettingsProfile(page);

  const surface = page.locator("[data-ui2-settings-profile]");
  await expect(surface).toHaveAttribute("data-profile-state", "loaded");
  const avatarAction = surface.getByRole("button", { name: "Change avatar" });
  const editAction = surface.getByRole("button", { name: "Edit display name" });
  await expect(avatarAction).toHaveClass(/ling-ui-button/u);
  await expect(editAction).toHaveClass(/ling-ui-button/u);
  await expectMinimumHitArea(avatarAction, 32);
  await expectMinimumHitArea(editAction, 28);
  await expect(surface.getByText(`@${state.userProfile.handle ?? "local-user"}`)).toBeVisible();
  await expect(surface.getByLabel("Handle")).toHaveCount(0);

  const activityRange = surface.getByRole("radiogroup", { name: "Token activity range" });
  await expect(activityRange).toHaveClass(/ling-ui-segmented-control/u);
  await expect(activityRange.getByRole("radio")).toHaveCount(3);
  await expect(surface.locator('[data-profile-usage="true"]')).toBeVisible();
  await expect(surface.locator(".profile-usage-details summary")).toHaveCount(0);
  await activityRange.getByRole("radio", { name: "Daily" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(activityRange.getByRole("radio", { name: "Weekly" })).toHaveAttribute("aria-checked", "true");

  const skillRows = surface.locator('[data-profile-skill-row="true"]');
  await expect(skillRows).toHaveCount(5);
  await expect(skillRows.first()).toHaveClass(/ling-ui-data-row/u);
  await expect(skillRows.first()).toContainText("1 run");
  await expect(skillRows.first()).not.toContainText("1 runs");
  await expect(surface.locator(".profile-usage-meta-line")).toContainText("5 min");
  await expect(surface.locator(".profile-settings-heatmap-months")).not.toContainText("月");
  await captureEvidence(page, "1440x960-ling-light-settings-profile-loaded.png");

  await editAction.click();
  const nameInput = surface.getByLabel("Display name", { exact: true });
  await expect(nameInput).toBeFocused();
  await expect(nameInput.locator("xpath=..")).toHaveClass(/ling-ui-input/u);
  await expectContained(nameInput.locator("xpath=.."), surface);
  await nameInput.fill("Cancelled profile name");
  await page.keyboard.press("Escape");
  await expect(nameInput).toHaveCount(0);
  await expect(editAction).toBeFocused();
  expect(state.userProfile.displayName).not.toBe("Cancelled profile name");

  await editAction.click();
  await surface.getByLabel("Display name", { exact: true }).fill("UI Two User");
  await page.keyboard.press("Enter");
  await expect.poll(() => state.userProfile.displayName).toBe("UI Two User");
  await expect(page.locator('.ling-ui-toast[data-scope="profile:save"]')).toBeVisible();

  const fileChooserPromise = page.waitForEvent("filechooser");
  await avatarAction.click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: "profile-ui2.svg",
    mimeType: "image/svg+xml",
    buffer: avatarSvg,
  });
  const cropDialog = page.getByRole("dialog", { name: "Adjust avatar" });
  await expect(cropDialog).toBeVisible();
  await expect(cropDialog).toHaveClass(/ling-ui-dialog-content/u);
  await expect(cropDialog.getByLabel("Avatar crop preview")).toBeVisible();
  await expect(cropDialog.getByRole("button", { name: "Use avatar" })).toHaveClass(/ling-ui-button/u);
  await captureEvidence(page, "1440x960-ling-light-settings-profile-crop.png");
  await page.keyboard.press("Escape");
  await expect(cropDialog).toHaveCount(0);
  await expect(avatarAction).toBeFocused();

  const invalidFileChooserPromise = page.waitForEvent("filechooser");
  await avatarAction.click();
  const invalidFileChooser = await invalidFileChooserPromise;
  await invalidFileChooser.setFiles({
    name: "not-an-avatar.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("not an image"),
  });
  await expect(surface.getByText("Choose an image file")).toBeVisible();
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Settings Profile blur autosave exposes saving and a global three-second Toast at 1440x960 light", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  seedLongProfileUsage(state);
  await mockDaemon(page, state);

  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let observeSave!: (body: { readonly displayName?: unknown }) => void;
  const saveStarted = new Promise<{ readonly displayName?: unknown }>((resolve) => {
    observeSave = resolve;
  });
  await page.route(/\/profile(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    const body = await route.request().postDataJSON() as { readonly displayName?: unknown };
    observeSave(body);
    await saveGate;
    state.userProfile = {
      ...state.userProfile,
      displayName: typeof body.displayName === "string" ? body.displayName : state.userProfile.displayName,
      updatedAt: "2026-07-23T08:00:00.000Z",
    };
    await fulfillProfile(route, state);
  });

  await page.goto("/");
  await openSettingsProfile(page);
  const surface = page.locator("[data-ui2-settings-profile]");
  const editAction = surface.getByRole("button", { name: "Edit display name" });
  await editAction.click();
  const nameInput = surface.getByLabel("Display name", { exact: true });
  await expect(nameInput).toBeFocused();
  await expectContained(nameInput.locator("xpath=.."), surface);
  await nameInput.fill("Blur saved UI Two User");
  await nameInput.press("Tab");

  expect(await saveStarted).toMatchObject({ displayName: "Blur saved UI Two User" });
  await expect(nameInput).toHaveCount(0);
  await expect(editAction).toBeDisabled();
  await expect(editAction).toHaveAttribute("aria-busy", "true");
  await expect(editAction).toHaveAttribute("data-loading", "true");
  await expect(surface.getByText(`@${state.userProfile.handle ?? "local-user"}`)).toBeVisible();
  await expect(surface.getByLabel("Handle")).toHaveCount(0);

  releaseSave();
  await expect.poll(() => state.userProfile.displayName).toBe("Blur saved UI Two User");
  const toast = page.locator('.ling-ui-toast[data-scope="profile:save"]');
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute("data-tone", "success");
  await expect(toast).toContainText("Profile saved");
  await expect(surface.locator(".ling-ui-toast")).toHaveCount(0);
  await expectTopCenterToast(page, toast);
  await captureEvidence(page, "1440x960-ling-light-settings-profile-toast.png");

  const visibleAt = Date.now();
  await page.waitForTimeout(2_500);
  await expect(toast).toBeVisible();
  await expect(toast).toHaveCount(0, { timeout: 1_200 });
  expect(Date.now() - visibleAt).toBeGreaterThanOrEqual(2_700);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Settings Profile cancels crop and keeps avatar failure persistent at 1280x800 dark", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800, "reduce");
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  seedLongProfileUsage(state);
  await mockDaemon(page, state);
  await page.route(/\/profile(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 503,
        json: { error: "mock_profile_avatar_save_failed", message: "Profile avatar save is temporarily unavailable." },
      });
      return;
    }
    await route.fallback();
  });

  await page.goto("/");
  await openSettingsProfile(page);
  const surface = page.locator("[data-ui2-settings-profile]");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expectDarkProfileTokens(surface);
  const avatarAction = surface.getByRole("button", { name: "Change avatar" });
  await expectReducedMotion(avatarAction);

  const firstChooserPromise = page.waitForEvent("filechooser");
  await avatarAction.click();
  const firstChooser = await firstChooserPromise;
  await firstChooser.setFiles({ name: "profile-cancel.svg", mimeType: "image/svg+xml", buffer: avatarSvg });
  let cropDialog = page.getByRole("dialog", { name: "Adjust avatar" });
  await expect(cropDialog).toBeVisible();
  const cancelAction = cropDialog.getByRole("button", { name: "Cancel" });
  await expect(cancelAction).toBeFocused();
  await cancelAction.click();
  await expect(cropDialog).toHaveCount(0);
  await expect(avatarAction).toBeFocused();
  await expect(surface.locator(".profile-settings-avatar img")).toHaveCount(0);

  const failureChooserPromise = page.waitForEvent("filechooser");
  await avatarAction.click();
  const failureChooser = await failureChooserPromise;
  await failureChooser.setFiles({ name: "profile-failure.svg", mimeType: "image/svg+xml", buffer: avatarSvg });
  cropDialog = page.getByRole("dialog", { name: "Adjust avatar" });
  const useAvatarAction = cropDialog.getByRole("button", { name: "Use avatar" });
  await expect(useAvatarAction).toBeEnabled();
  await useAvatarAction.click();

  await expect(cropDialog).toHaveCount(0);
  const feedback = surface.locator(".profile-settings-feedback.ling-ui-inline-feedback");
  await expect(feedback).toHaveAttribute("data-tone", "danger");
  await expect(feedback).toContainText("Profile changes were not saved. Try again.");
  await expect(surface.locator(".profile-settings-avatar img")).toHaveCount(0);
  await expect(page.locator('.ling-ui-toast[data-scope="profile:save"]')).toHaveCount(0);
  await page.locator(".profile-usage-card").click({ position: { x: 12, y: 12 } });
  await page.mouse.move(1180, 760);
  await expect(page.getByRole("tooltip", { name: "Change avatar" })).toHaveCount(0);
  await page.waitForTimeout(3_200);
  await expect(feedback).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-settings-profile-avatar-error.png");
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Settings Profile distinguishes loading and empty states at 1280x800 dark", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.skillRegistryEntries = [];
  await mockDaemon(page, state);

  let releaseProfile!: () => void;
  const profileGate = new Promise<void>((resolve) => {
    releaseProfile = resolve;
  });
  await page.route(/\/profile(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await profileGate;
    await fulfillProfile(route, state);
  });

  await page.goto("/");
  await openSettingsProfile(page);
  const surface = page.locator("[data-ui2-settings-profile]");
  await expect(surface).toHaveAttribute("data-profile-state", "loading");
  await expect(surface.locator(".ling-ui-skeleton")).toHaveCount(6);
  await expect(surface.locator(".ling-ui-empty-state")).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-dark-settings-profile-loading.png");

  releaseProfile();
  await expect(surface).toHaveAttribute("data-profile-state", "empty");
  await expect(surface.locator(".ling-ui-skeleton")).toHaveCount(0);
  await expect(surface.locator(".ling-ui-empty-state")).toContainText("Not enough local activity yet.");
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Settings Profile keeps save failure local with long data at 980x680 dark", async ({ page }) => {
  await prepareSurface(page, "dark", 980, 680);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  seedLongProfileUsage(state);
  const originalName = state.userProfile.displayName;
  await mockDaemon(page, state);
  await page.route(/\/profile(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 503,
        json: { error: "mock_profile_save_failed", message: "Profile save is temporarily unavailable." },
      });
      return;
    }
    await route.fallback();
  });

  await page.goto("/");
  await openSettingsProfile(page);
  const surface = page.locator("[data-ui2-settings-profile]");
  await surface.getByRole("button", { name: "Edit display name" }).click();
  const nameInput = surface.getByLabel("Display name", { exact: true });
  await nameInput.fill("Unsaved UI Two User");
  await nameInput.press("Tab");

  await expect(surface.getByText("Profile changes were not saved. Try again.")).toBeVisible();
  await expect(surface.locator(".profile-settings-name-row")).toContainText(originalName);
  await expect(page.locator('.ling-ui-toast[data-scope="profile:save"]')).toHaveCount(0);
  await expect(surface.locator('[data-profile-skill-row="true"]')).toHaveCount(5);
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "980x680-ling-dark-settings-profile-save-error-long.png");
  expect(runtimeErrors).toEqual([]);
});

test("Settings Profile keeps load failure inside its content owner", async ({ page }) => {
  await prepareSurface(page, "light", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.route(/\/profile(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 503,
        json: { error: "mock_profile_load_failed", message: "Profile load is temporarily unavailable." },
      });
      return;
    }
    await route.fallback();
  });

  await page.goto("/");
  await openSettingsProfile(page);
  const surface = page.locator("[data-ui2-settings-profile]");
  await expect(surface).toHaveAttribute("data-profile-state", "error");
  await expect(surface.getByText("Profile could not be loaded. Try reopening this page.")).toBeVisible();
  await expect(surface.locator(".ling-ui-skeleton, .ling-ui-empty-state")).toHaveCount(0);
  await expect(page.getByLabel("Settings sections")).toBeVisible();
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

async function openSettingsProfile(page: Page): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "User profile", exact: true }).click();
}

function seedLongProfileUsage(state: MockState): void {
  const skillEntries = state.skillRegistryEntries as Array<{
    id: string;
    definition: { name?: string };
  }>;
  const selectedSkills = skillEntries.slice(0, 6);
  selectedSkills.forEach((entry, index) => {
    entry.definition.name = `Workspace research and implementation skill ${index + 1} with a deliberately long descriptive name`;
  });
  const baseRun = state.runs[0];
  if (!baseRun) throw new Error("base profile fixture needs one run");
  state.runs = selectedSkills.map((skill, index) => Object.assign({
    ...baseRun,
    id: `run_profile_ui2_${index}`,
    status: index === 0 ? "failed" : "succeeded",
    providerModel: "provider-model-with-an-intentionally-long-identity-for-overflow-verification",
    createdAt: `2026-07-${String(index + 10).padStart(2, "0")}T08:00:00.000Z`,
    updatedAt: `2026-07-${String(index + 10).padStart(2, "0")}T08:05:00.000Z`,
  }, { selectedSkillId: skill.id }));
}

async function fulfillProfile(route: Route, state: MockState): Promise<void> {
  await route.fulfill({
    json: {
      cwd: "/tmp/ling-stack-workspace",
      profile: state.userProfile,
    },
  });
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
  await page.addInitScript((themeId) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, theme);
}

async function expectMinimumHitArea(locator: Locator, minimum: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(minimum);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(minimum);
}

async function expectContained(inner: Locator, outer: Locator): Promise<void> {
  const [innerBox, outerBox, scrollOverflow] = await Promise.all([
    inner.boundingBox(),
    outer.boundingBox(),
    inner.evaluate((element) => element.scrollWidth - element.clientWidth),
  ]);
  expect(innerBox).not.toBeNull();
  expect(outerBox).not.toBeNull();
  expect((innerBox?.x ?? 0) - (outerBox?.x ?? 0)).toBeGreaterThanOrEqual(-1);
  expect(((outerBox?.x ?? 0) + (outerBox?.width ?? 0)) - ((innerBox?.x ?? 0) + (innerBox?.width ?? 0))).toBeGreaterThanOrEqual(-1);
  expect(scrollOverflow).toBeLessThanOrEqual(1);
}

async function expectTopCenterToast(page: Page, toast: Locator): Promise<void> {
  const box = await toast.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(96);
  expect(Math.abs(((box?.x ?? 0) + (box?.width ?? 0) / 2) - (viewport?.width ?? 0) / 2)).toBeLessThanOrEqual(2);
}

async function expectDarkProfileTokens(surface: Locator): Promise<void> {
  const colors = await surface.evaluate((element) => {
    const resolveToken = (token: string): string => {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      element.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    };
    const metric = element.querySelector(".profile-usage-metric");
    const details = element.querySelector(".profile-usage-details");
    if (!(metric instanceof HTMLElement) || !(details instanceof HTMLElement)) {
      throw new Error("Profile dark token targets did not render");
    }
    return {
      metric: getComputedStyle(metric).backgroundColor,
      panelToken: resolveToken("--ling-bg-panel"),
      details: getComputedStyle(details).backgroundColor,
      subtleToken: resolveToken("--ling-bg-subtle"),
    };
  });
  expect(colors.metric).toBe(colors.panelToken);
  expect(colors.details).toBe(colors.subtleToken);
  expect(colors.metric).not.toBe("rgb(255, 255, 255)");
  expect(colors.details).not.toBe("rgb(255, 255, 255)");
}

async function expectReducedMotion(locator: Locator): Promise<void> {
  const motion = await locator.evaluate((element) => ({
    matches: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    durations: getComputedStyle(element).transitionDuration.split(",").map((value) => Number.parseFloat(value) || 0),
  }));
  expect(motion.matches).toBe(true);
  expect(Math.max(...motion.durations)).toBeLessThanOrEqual(0.01);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    height: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.height + 1);
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
