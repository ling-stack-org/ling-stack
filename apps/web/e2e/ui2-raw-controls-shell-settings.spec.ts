import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, type MockState } from "./support/mock-state";

const sidebarSourceUrl = new URL("../src/features/navigation/SidebarNavigation.tsx", import.meta.url);
const policyEditorSourceUrl = new URL("../src/features/settings/AdvancedWorkspacePolicyEditor.tsx", import.meta.url);
const sidebarCssUrl = new URL("../src/styles/app/sidebar-layout.css", import.meta.url);
const authorizationCssUrl = new URL("../src/styles/settings-default-authorization.css", import.meta.url);
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/raw-text-controls/first-wave/",
  import.meta.url,
));
const captureEvidence = process.env.LING_CAPTURE_UI2_EVIDENCE === "1";

test("owned shell and settings sources use the shared Input contract without private CSS overrides", async () => {
  const [sidebarSource, policyEditorSource, sidebarCss, authorizationCss] = await Promise.all([
    readFile(sidebarSourceUrl, "utf8"),
    readFile(policyEditorSourceUrl, "utf8"),
    readFile(sidebarCssUrl, "utf8"),
    readFile(authorizationCssUrl, "utf8"),
  ]);

  expect(findRawTextControls(sidebarSource)).toEqual([]);
  expect(findRawTextControls(policyEditorSource)).toEqual([]);
  expect(sidebarSource).toContain("IconButton, InlineFeedback, Input, StatusIndicator");
  expect(sidebarSource).toContain("containerClassName=\"sidebar-branch-name-control\"");
  expect(sidebarSource).toContain("onChange={(event) => setBranchDraftName(event.target.value)}");
  expect(sidebarSource).toContain("onSubmit={(event) => void submitBranchDraft(event, channel.id)}");
  expect(policyEditorSource).toContain("import { Input } from \"../../shared/ui/index.js\"");
  expect(policyEditorSource).toContain("containerClassName=\"settings-write-path-control\"");
  expect(policyEditorSource).toContain("onChange={(event) => setPathDraft(event.target.value)}");
  expect(policyEditorSource).toContain("onKeyDown={handlePathKeyDown}");
  expect(policyEditorSource).toContain("onSubmit={submitPath}");
  expect(sidebarCss).not.toMatch(/sidebar-branch-create-form\s+input/gu);
  expect(sidebarCss).not.toContain(".ling-ui-");
  expect(authorizationCss).not.toContain(".ling-ui-");
});

test("1440x960 Ling Light keeps branch validation, Enter submit, focus, and geometry intact", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, { theme: "light", width: 1440, height: 960 });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  const { form, input, navigation } = await openBranchDraft(page);
  await expectSharedInputFocusContained(input, form);
  await captureScreenshot(page, "1440x960-ling-light-branch-shared-input-focus.png");
  const branchCountBefore = state.channelBranches.length;

  await input.press("Enter");
  await expect(form).toBeVisible();
  expect(state.channelBranches).toHaveLength(branchCountBefore);

  await input.fill("  UI2 shared branch  ");
  await input.press("Enter");
  await expect(form).toHaveCount(0);
  await expect.poll(() => branchNames(state)).toContain("UI2 shared branch");
  await expect(navigation.getByRole("button", { name: "UI2 shared branch" })).toBeVisible();
  await expectNoHorizontalOverflow(navigation);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("1280x800 Ling Dark keeps branch autoFocus and Escape cancellation contained", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, { reducedMotion: true, theme: "dark", width: 1280, height: 800 });
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await page.goto("/");

  const { form, input, navigation } = await openBranchDraft(page);
  const branchCountBefore = state.channelBranches.length;
  await expect(input).toBeFocused();
  await expectSharedInputFocusContained(input, form);
  await captureScreenshot(page, "1280x800-ling-dark-branch-shared-input-focus.png");
  await input.fill("Cancelled branch draft");
  await input.press("Escape");
  await expect(form).toHaveCount(0);
  expect(state.channelBranches).toHaveLength(branchCountBefore);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectNoHorizontalOverflow(navigation);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function findRawTextControls(source: string): readonly string[] {
  return source.match(/<(?:input|textarea)\b/gu) ?? [];
}

async function prepareSurface(page: Page, options: {
  readonly reducedMotion?: boolean;
  readonly theme: "dark" | "light";
  readonly width: number;
  readonly height: number;
}): Promise<void> {
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.emulateMedia({
    colorScheme: options.theme,
    reducedMotion: options.reducedMotion ? "reduce" : "no-preference",
  });
  await page.addInitScript((theme) => {
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, options.theme);
}

async function openBranchDraft(page: Page): Promise<{
  readonly form: Locator;
  readonly input: Locator;
  readonly navigation: Locator;
}> {
  const navigation = page.getByLabel("Ling Stack navigation");
  const engineeringGroup = navigation.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  await engineeringGroup.locator(".sidebar-row-shell").first().hover();
  await engineeringGroup.getByRole("button", { name: "Create branch" }).click();
  const form = engineeringGroup.locator("form.sidebar-branch-create-form");
  const input = form.getByLabel("Branch name");
  await expect(form).toBeVisible();
  await expect(input).toHaveAttribute("data-ling-control-native", "true");
  await expect(input).toBeFocused();
  return { form, input, navigation };
}

async function expectSharedInputFocusContained(input: Locator, region: Locator): Promise<void> {
  const shell = input.locator("xpath=ancestor::span[contains(@class, 'ling-ui-input')][1]");
  const before = await shell.boundingBox();
  expect(before).not.toBeNull();
  await region.getByRole("button", { name: "Create branch" }).focus();
  await input.focus();
  await expect(input).toBeFocused();
  const geometry = await input.evaluate((element) => {
    const shellElement = element.closest<HTMLElement>(".ling-ui-input");
    const regionElement = element.closest<HTMLElement>("form");
    if (!shellElement || !regionElement) throw new Error("Shared Input containment boundary is missing");
    const inputBox = element.getBoundingClientRect();
    const shellBox = shellElement.getBoundingClientRect();
    const regionBox = regionElement.getBoundingClientRect();
    const inputStyle = getComputedStyle(element);
    const shellStyle = getComputedStyle(shellElement);
    return {
      inputBottom: inputBox.bottom,
      inputTop: inputBox.top,
      nativeBorderTop: inputStyle.borderTopWidth,
      nativeBoxShadow: inputStyle.boxShadow,
      regionBottom: regionBox.bottom,
      regionTop: regionBox.top,
      shellBottom: shellBox.bottom,
      shellBoxShadow: shellStyle.boxShadow,
      shellTop: shellBox.top,
    };
  });
  const after = await shell.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.abs((after?.height ?? 0) - (before?.height ?? 0))).toBeLessThanOrEqual(0.5);
  expect(geometry.nativeBorderTop).toBe("0px");
  expect(geometry.nativeBoxShadow).toBe("none");
  expect(geometry.shellBoxShadow).toContain("inset");
  expect(geometry.inputTop).toBeGreaterThanOrEqual(geometry.shellTop - 0.5);
  expect(geometry.inputBottom).toBeLessThanOrEqual(geometry.shellBottom + 0.5);
  expect(geometry.shellTop).toBeGreaterThanOrEqual(geometry.regionTop - 0.5);
  expect(geometry.shellBottom).toBeLessThanOrEqual(geometry.regionBottom + 0.5);
  await expectNoHorizontalOverflow(region);
}

function branchNames(state: MockState): readonly string[] {
  return state.channelBranches.flatMap((branch) => (
    typeof branch === "object" && branch !== null && "name" in branch && typeof branch.name === "string"
      ? [branch.name]
      : []
  ));
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const geometry = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ))).toBeLessThanOrEqual(1);
}

async function captureScreenshot(page: Page, filename: string): Promise<void> {
  if (!captureEvidence) return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    path: `${evidenceDirectory}${filename}`,
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
