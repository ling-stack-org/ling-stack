import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/settings/settings-authorization-personalization/",
  import.meta.url,
));

test("Default Authorization uses shared rows and segmented choices at 1440x960 light", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await openSettingsSection(page, /Default authorization/);

  const surface = page.locator("[data-ui2-default-authorization]");
  await expect(surface).toBeVisible();
  await expect(surface.locator(".ling-ui-data-row")).toHaveCount(2);
  await expect(surface.locator(".ling-ui-segmented-control")).toHaveCount(2);
  await expect(surface.locator(".rich-choice-select, .rich-choice-select-trigger")).toHaveCount(0);

  const authorization = surface.getByRole("radiogroup", { name: "Authorization mode" });
  const access = surface.getByRole("radiogroup", { name: "Sandbox settings" });
  await expect(authorization.getByRole("radio")).toHaveCount(3);
  await expect(access.getByRole("radio")).toHaveCount(3);
  await expect(authorization.getByRole("radio", { name: "Help me approve" })).toHaveAttribute("aria-checked", "true");
  await expect(access.getByRole("radio", { name: "Workspace write" })).toHaveAttribute("aria-checked", "true");

  await authorization.getByRole("radio", { name: "Ask first" }).click();
  await expect.poll(() => state.workspaceSettings.defaultAuthorizationMode).toBe("ask");
  await expect(surface.locator('[data-authorization-choice="mode"]')).toContainText(
    "Ask before workspace changes, commands, and external actions.",
  );

  await access.getByRole("radio", { name: "Full access" }).click();
  await expect.poll(() => state.workspaceSettings.defaultWorkspaceAccessMode).toBe("full_access");
  await expect(surface.locator('[data-authorization-choice="access"]')).toContainText(
    "Access files outside the workspace; each run still requires explicit confirmation.",
  );
  await expect(surface).not.toContainText("Tool permission policy");
  await expect(surface).not.toContainText("Execution runners");
  await expect(surface).not.toContainText("Advanced workspace policy");
  await expectMinimumHitArea(authorization.getByRole("radio", { name: "Ask first" }), 32);
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1440x960-ling-light-default-authorization.png");
  expect(runtimeErrors).toEqual([]);
});

test("Default Authorization preserves keyboard selection and dark compact geometry", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await openSettingsSection(page, /Default authorization/);

  const surface = page.locator("[data-ui2-default-authorization]");
  const authorization = surface.getByRole("radiogroup", { name: "Authorization mode" });
  const smart = authorization.getByRole("radio", { name: "Help me approve" });
  await smart.focus();
  await page.keyboard.press("ArrowRight");
  const always = authorization.getByRole("radio", { name: "Always authorize" });
  await expect(always).toBeFocused();
  await expect(always).toHaveAttribute("aria-checked", "true");
  await expect.poll(() => state.workspaceSettings.defaultAuthorizationMode).toBe("always");

  const access = surface.getByRole("radiogroup", { name: "Sandbox settings" });
  const workspaceWrite = access.getByRole("radio", { name: "Workspace write" });
  await workspaceWrite.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(access.getByRole("radio", { name: "Read only" })).toBeFocused();
  await expect.poll(() => state.workspaceSettings.defaultWorkspaceAccessMode).toBe("read_only");

  await expectReducedMotion(always);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-default-authorization.png");
  expect(runtimeErrors).toEqual([]);
});

test("Personalization keeps only editable controls and actionable feedback at 1440x960 light", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");
  await openSettingsSection(page, /Personalization/);

  const surface = page.locator("[data-ui2-personalization]");
  const tone = surface.locator("[data-personalization-tone]");
  const governanceSection = surface.locator("[data-personalization-governance]");
  await expect(tone.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await expect(governanceSection.getByRole("button", { name: "Refresh" })).toHaveCount(0);
  await expect(tone.getByText("Concise, focused, direct.", { exact: true })).toHaveCount(0);

  const toneGroup = tone.getByRole("radiogroup", { name: "Ling conversation tone" });
  await expect(toneGroup).toHaveClass(/ling-ui-segmented-control/u);
  await expect(toneGroup.getByRole("radio", { name: "Pragmatic" })).toHaveAttribute("aria-checked", "true");
  await toneGroup.getByRole("radio", { name: "Friendly" }).click();
  await expect.poll(() => state.workspaceSettings.lingConversationTone).toBe("friendly");
  await expect(page.locator('.ling-ui-toast[data-scope="settings:personalization:tone:save"]')).toContainText(
    "Ling conversation tone applied",
  );
  await expect(tone.getByText("Workspace", { exact: true })).toHaveCount(0);

  const governance = governanceSection.getByRole("region", { name: "Skill policy" });
  await expect(governance.locator(".ling-ui-field")).toHaveCount(2);
  await expect(governance.locator(".ling-ui-inspector-section")).toHaveCount(0);
  await expect(governance.getByText("Advanced governance", { exact: true })).toHaveCount(0);
  await expect(governance.getByText("Create pending candidates after repeated stable success", { exact: true })).toHaveCount(0);
  await expect(governance.getByText("Users can start skill recording explicitly", { exact: true })).toHaveCount(0);
  await expect(governance.getByText("Candidate publishing and binding still require manual review.")).toHaveCount(0);

  const save = governance.getByRole("button", { name: "Save governance policy" });
  await expect(save).toBeDisabled();
  await governance.getByRole("combobox", { name: "Skill candidate generation mode" }).selectOption("approval_only");
  await governance.getByRole("combobox", { name: "Skill recording mode" }).selectOption("disabled");
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => {
    const policy = state.workspaceSettings.skillGovernancePolicy;
    return isRecord(policy) ? `${policy.generationMode}:${policy.recordingMode}` : "";
  }).toBe("approval_only:disabled");
  await expect(page.locator('.ling-ui-toast[data-scope="settings:personalization:governance:save"]')).toContainText(
    "Skill governance policy saved",
  );
  await expect(save).toBeDisabled();

  await expect(governance.getByText("Source", { exact: true })).toHaveCount(0);
  await expect(governance.getByText("Stored in workspace settings", { exact: true })).toHaveCount(0);
  await expect(surface.locator(".settings-inline-tip, .settings-inline-success")).toHaveCount(0);
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1440x960-ling-light-personalization-compact.png");
  expect(runtimeErrors).toEqual([]);
});

test("Personalization distinguishes initial loading from tone save failure at 1280x800 dark", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);

  let releaseConfig!: () => void;
  const configGate = new Promise<void>((resolve) => {
    releaseConfig = resolve;
  });
  await page.route(/\/config\/effective(?:\?.*)?$/u, async (route) => {
    await configGate;
    await route.fallback();
  });

  await page.goto("/");
  await openSettingsSection(page, /Personalization/);
  const surface = page.locator("[data-ui2-personalization]");
  await expect(surface).toHaveAttribute("data-personalization-state", "loading");
  await expect(surface.locator(".ling-ui-skeleton")).toHaveCount(5);
  await expect(surface.getByRole("radiogroup", { name: "Ling conversation tone" })).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-dark-personalization-loading.png");

  releaseConfig();
  const toneGroup = surface.getByRole("radiogroup", { name: "Ling conversation tone" });
  await expect(toneGroup).toBeVisible();
  await page.route(/\/workspace-settings(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "PATCH") {
      const body = await route.request().postDataJSON() as Record<string, unknown>;
      if (body.lingConversationTone !== undefined) {
        await route.fulfill({
          status: 503,
          json: { error: "mock_tone_save_failed", message: "Conversation tone could not be saved." },
        });
        return;
      }
    }
    await route.fallback();
  });

  await toneGroup.getByRole("radio", { name: "Friendly" }).click();
  await expect(surface.getByText("Conversation tone could not be saved.")).toBeVisible();
  await expect(toneGroup.getByRole("radio", { name: "Pragmatic" })).toHaveAttribute("aria-checked", "true");
  expect(state.workspaceSettings.lingConversationTone).not.toBe("friendly");
  await expect(page.locator('.ling-ui-toast[data-scope="settings:personalization:tone:save"]')).toHaveCount(0);
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-personalization-save-error.png");
  expect(runtimeErrors).toEqual([]);
});

test("Personalization keeps unsupported governance persistent and repairable", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.route(/\/config\/effective(?:\?.*)?$/u, async (route) => {
    await fulfillEffectiveConfigWithoutSkillPolicy(route, state);
  });
  await page.goto("/");
  await openSettingsSection(page, /Personalization/);

  const surface = page.locator("[data-ui2-personalization]");
  const governance = surface.locator("[data-personalization-governance]");
  await expect(governance.getByText("Update Ling daemon to save skill governance policy.")).toBeVisible();
  await expect(governance.locator('.ling-ui-inline-feedback[data-tone="warning"]')).toBeVisible();
  await expect(governance.getByRole("combobox")).toHaveCount(2);
  await expect(governance.getByRole("combobox").first()).toBeDisabled();
  await expect(governance.getByRole("button", { name: "Save governance policy" })).toBeDisabled();
  await expect(page.locator('.ling-ui-toast[data-scope^="settings:personalization:governance"]')).toHaveCount(0);
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-personalization-unsupported.png");
  expect(runtimeErrors).toEqual([]);
});

async function openSettingsSection(page: Page, name: RegExp): Promise<void> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name }).click();
}

async function prepareSurface(page: Page, theme: "dark" | "light", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((themeId) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, theme);
}

async function fulfillEffectiveConfigWithoutSkillPolicy(route: Route, state: MockState): Promise<void> {
  const workspaceCwd = typeof state.workspaceSettings.workspaceCwd === "string"
    ? state.workspaceSettings.workspaceCwd
    : "/tmp/ling-stack-workspace";
  await route.fulfill({
    json: {
      cwd: workspaceCwd,
      paths: {},
      values: {
        workspaceCwd: { value: workspaceCwd, source: "workspace", key: "workspaceCwd" },
        theme: { value: "system", source: "built_in", key: "theme" },
        locale: { value: "en-US", source: "built_in", key: "locale" },
        responseLanguage: { value: "follow_user", source: "built_in", key: "responseLanguage" },
        lingConversationTone: { value: "pragmatic", source: "built_in", key: "lingConversationTone" },
        runtime: {
          defaultRunnerId: { value: "pi", source: "built_in", key: "runtime.defaultRunnerId" },
          explicitRunnerFallback: { value: "disabled", source: "built_in", key: "runtime.explicitRunnerFallback" },
          implicitRunnerFallback: { value: "disabled", source: "built_in", key: "runtime.implicitRunnerFallback" },
        },
      },
      layers: { workspaceSettings: state.workspaceSettings },
      diagnostics: [],
    },
  });
}

async function expectMinimumHitArea(locator: Locator, minimum: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(minimum);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(minimum);
}

async function expectReducedMotion(locator: Locator): Promise<void> {
  const durations = await locator.evaluate((element) => getComputedStyle(element).transitionDuration
    .split(",")
    .map((duration) => Number.parseFloat(duration)));
  expect(durations).toEqual(durations.map(() => 0));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
