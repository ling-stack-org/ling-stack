import { expect, test, type Locator, type Page } from "@playwright/test";
import { access, readFile, readdir } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider, cwd, isRecord, type MockState } from "./support/mock-state";

const repositoryDirectory = fileURLToPath(new URL("../../../", import.meta.url));
const webSourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const channelCreatePath = fileURLToPath(new URL("../src/features/workspace/ChannelCreateDialog.tsx", import.meta.url));
const componentBarrelPath = fileURLToPath(new URL("../src/shared/components/index.ts", import.meta.url));
const createDialogShellPath = fileURLToPath(new URL("../src/shared/components/CreateDialogShell.tsx", import.meta.url));
const selectControlPath = fileURLToPath(new URL("../src/shared/components/SelectControl.tsx", import.meta.url));
const selectCssPath = fileURLToPath(new URL("../src/styles/select-controls.css", import.meta.url));
const creationCssPath = fileURLToPath(new URL("../src/styles/creation-dialogs.css", import.meta.url));
const stylesEntryPath = fileURLToPath(new URL("../src/styles.css", import.meta.url));
const importGuardPath = fileURLToPath(new URL("../scripts/check-ui2-imports.mjs", import.meta.url));
const selectGuardPath = fileURLToPath(new URL("../scripts/check-select-controls.mjs", import.meta.url));

const removedAdapterSelectors = [
  "create-dialog-shell",
  "create-dialog-head",
  "create-dialog-title-block",
  "create-dialog-body",
  "create-dialog-actions",
] as const;

const protectedChannelSelectors = [
  ".channel-create-dialog-clean",
  ".channel-create-body",
  ".channel-create-section",
  ".channel-create-fields",
  ".channel-create-project-menu",
  ".channel-create-advanced",
  ".channel-create-advanced-body",
] as const;

test("T13-P.3-N removes both adapters, their exports, CSS owner, and style import", async () => {
  for (const deletedPath of [createDialogShellPath, selectControlPath, selectCssPath]) {
    await expect(access(deletedPath), `${relative(repositoryDirectory, deletedPath)} must be deleted`).rejects.toThrow();
  }

  const [channelSource, componentBarrel, stylesEntry, importGuard, selectGuard] = await Promise.all([
    readFile(channelCreatePath, "utf8"),
    readFile(componentBarrelPath, "utf8"),
    readFile(stylesEntryPath, "utf8"),
    readFile(importGuardPath, "utf8"),
    readFile(selectGuardPath, "utf8"),
  ]);
  expect(channelSource).not.toContain("CreateDialogShell");
  expect(channelSource).not.toContain("SelectControl");
  expect(channelSource.match(/<Dialog(?=[\s>])/gu) ?? []).toHaveLength(1);
  expect(channelSource.match(/<DialogHeader(?=[\s>])/gu) ?? []).toHaveLength(1);
  expect(channelSource.match(/<DialogBody(?=[\s>])/gu) ?? []).toHaveLength(1);
  expect(channelSource.match(/<DialogFooter(?=[\s>])/gu) ?? []).toHaveLength(1);
  expect(channelSource.match(/<Select(?=[\s>])/gu) ?? []).toHaveLength(2);
  expect(componentBarrel).not.toContain("CreateDialogShell");
  expect(componentBarrel).not.toContain("SelectControl");
  expect(stylesEntry).not.toContain("select-controls.css");
  expect(importGuard).toContain("SelectControl: 0");
  expect(importGuard).toContain("CreateDialogShell: 0");
  expect(selectGuard).not.toContain("selectControlPath");

  const sourceFiles = await listFiles(webSourceDirectory, /\.(?:ts|tsx)$/u);
  const productionReferences: string[] = [];
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    if (/\b(?:CreateDialogShell|SelectControl)\b/u.test(source)) {
      productionReferences.push(relative(repositoryDirectory, file));
    }
  }
  expect(productionReferences).toEqual([]);
});

test("T13-P.3-N removes adapter CSS branches while preserving Channel Create layout owners", async () => {
  const cssFiles = await listFiles(webSourceDirectory, /\.css$/u);
  const legacyOwners: string[] = [];
  for (const file of cssFiles) {
    const css = await readFile(file, "utf8");
    const branches = extractSelectorBranches(css);
    if (branches.some((branch) =>
      removedAdapterSelectors.some((token) => selectorContainsClass(branch, token))
      || selectorContainsClass(branch, "select-control")
      || /\.select-control--[A-Za-z0-9_-]+/u.test(branch)
    )) {
      legacyOwners.push(relative(repositoryDirectory, file));
    }
  }
  expect(legacyOwners).toEqual([]);

  const creationCss = await readFile(creationCssPath, "utf8");
  const creationBranches = extractSelectorBranches(creationCss);
  for (const selector of protectedChannelSelectors) {
    expect(creationBranches, `${selector} must remain owned by creation-dialogs.css`).toContain(selector);
  }
});

test("Channel Create direct Dialog closes once through Escape and outside click with focus return", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  const state = createChannelCreateState();
  await mockDaemon(page, state);
  await page.goto("/");

  const trigger = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "No channel yet" });
  await trigger.click();
  let dialog = page.getByRole("dialog", { name: "New channel" });
  await expectDirectDialogRows(dialog);
  await expectSharedSelect(dialog.getByRole("combobox", { name: "Ling Agent model" }), "md");
  await expect(dialog.locator(".create-dialog-shell, .create-dialog-body, .create-dialog-actions")).toHaveCount(0);
  await dialog.getByText("Advanced settings", { exact: true }).click();
  await expectSharedSelect(dialog.getByRole("combobox", { name: "AI response language" }), "md");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  dialog = page.getByRole("dialog", { name: "New channel" });
  await page.locator(".ling-ui-dialog-overlay").click({ position: { x: 4, y: 4 } });
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

test("Channel Create blocks new users without a runnable model and offers one recovery action", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  const state = createChannelCreateState();
  state.providers = [];
  delete state.workspaceSettings.defaultProviderPresetId;
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "No channel yet" }).click();
  const dialog = page.getByRole("dialog", { name: "New channel" });
  await expect(dialog.getByRole("combobox", { name: "Ling Agent model" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Create channel" })).toBeDisabled();
  await expect(dialog.getByText("Choose a model before creating.", { exact: true })).toBeVisible();
  const recovery = dialog.getByRole("button", { name: "Open Model Workbench" });
  await expect(recovery).toHaveCount(1);
  await recovery.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: "Model Workbench" })).toHaveClass(/active/u);
  expect(runtimeErrors).toEqual([]);
});

test("Channel Create keeps project, provider, language, payload, and busy dismissal behavior", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  const state = createChannelCreateState();
  state.channelCreateDelayMs = 1_000;
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "No channel yet" }).click();
  const dialog = page.getByRole("dialog", { name: "New channel" });
  await dialog.getByLabel("Name").fill("Direct primitives");
  await dialog.getByRole("button", { name: "Project directory" }).click();
  const projectSearch = dialog.getByRole("textbox", { name: "Search projects" });
  await projectSearch.fill("no-project-matches-this-query");
  await expect(dialog.getByText("No matching projects")).toBeVisible();
  await projectSearch.fill("");
  await dialog.getByRole("menuitemradio").first().click();

  await dialog.getByText("Advanced settings", { exact: true }).click();
  const provider = dialog.getByRole("combobox", { name: "Ling Agent model" });
  const language = dialog.getByRole("combobox", { name: "AI response language" });
  const writeLock = dialog.getByRole("combobox", { name: "Write lock" });
  const advancedLayout = await Promise.all([
    language.boundingBox(),
    writeLock.boundingBox(),
    dialog.locator(".channel-create-advanced-body > .runtime-policy-summary").boundingBox(),
  ]);
  expect(advancedLayout.every(Boolean)).toBe(true);
  expect(Math.abs((advancedLayout[0]?.y ?? 0) - (advancedLayout[1]?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(advancedLayout[2]?.y ?? 0).toBeGreaterThan(
    Math.max((advancedLayout[0]?.y ?? 0) + (advancedLayout[0]?.height ?? 0), (advancedLayout[1]?.y ?? 0) + (advancedLayout[1]?.height ?? 0)),
  );
  expect(advancedLayout[2]?.width ?? 0).toBeGreaterThan((advancedLayout[0]?.width ?? 0) * 1.8);
  await provider.selectOption("provider_channel_create_direct");
  await language.selectOption("en-US");
  await dialog.getByRole("button", { name: "Create channel" }).click();

  await expect(dialog).toHaveAttribute("aria-busy", "true");
  for (const cancel of await dialog.getByRole("button", { name: "Cancel" }).all()) {
    await expect(cancel).toBeDisabled();
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.locator(".ling-ui-dialog-overlay").click({ position: { x: 4, y: 4 } });
  await expect(dialog).toBeVisible();

  await expect(dialog).toHaveCount(0);
  await expect.poll(() => state.channels.length).toBe(1);
  const created = state.channels.find((channel) => isRecord(channel) && channel.name === "Direct primitives");
  expect(isRecord(created) ? created.defaultProviderPresetId : undefined).toBe("provider_channel_create_direct");
  expect(isRecord(created) ? created.responseLanguage : undefined).toBe("en-US");
  expect(isRecord(created) ? created.boundPath : undefined).toBe(cwd);
  expect(runtimeErrors).toEqual([]);
});

test("Channel Create keeps failures inline and remains dismissible after the request settles", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  const state = createChannelCreateState();
  state.failNextChannelCreate = {
    error: "channel_create_failed",
    message: "Channel creation failed.",
  };
  await mockDaemon(page, state);
  await page.goto("/");

  const trigger = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "No channel yet" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "New channel" });
  await dialog.getByLabel("Name").fill("Failed direct dialog");
  await dialog.getByRole("button", { name: "Create channel" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Channel creation failed.");
  await expect(dialog).toBeVisible();
  expect(state.channels).toHaveLength(0);

  await dialog.getByRole("button", { name: "Cancel" }).last().click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

test("Channel Create keeps three-row scroll geometry in dark reduced-motion mode", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 1280, 800, true);
  const state = createChannelCreateState();
  await mockDaemon(page, state);
  await page.goto("/");

  const trigger = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "No channel yet" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "New channel" });
  await expectDirectDialogRows(dialog);
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await dialog.getByText("Advanced settings", { exact: true }).click();

  const body = dialog.locator(":scope > .ling-ui-dialog-body");
  await expect(body.locator(".ling-ui-dialog-footer")).toHaveCount(0);
  await expect.poll(async () => body.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBeGreaterThan(0);
  await body.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect.poll(async () => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expectSharedSelect(dialog.getByRole("combobox", { name: "AI response language" }), "md");
  await expect.poll(() => dialog.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  await expect.poll(() => page.locator(".ling-ui-dialog-overlay").evaluate((element) =>
    getComputedStyle(element).animationName
  )).toBe("none");

  await dialog.getByRole("button", { name: "Cancel" }).last().click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

function createChannelCreateState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.channels = [];
  state.channelBranches = [];
  state.tasks = [];
  state.runs = [];
  state.approvals = [];
  state.aiTeammates = [];
  state.providers = [createChatProvider({
    id: "provider_channel_create_direct",
    displayName: "Direct Dialog Relay",
    model: "gpt-5.5",
    lastCheck: {
      ok: true,
      code: "ready",
      message: "Provider is reachable.",
      checkedAt: "2026-07-24T04:00:00.000Z",
    },
  })];
  return state;
}

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  width: number,
  height: number,
  reducedMotion = false,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  await page.addInitScript((themeId) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, theme);
}

async function expectDirectDialogRows(dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveClass(/ling-ui-dialog-content/u);
  await expect(dialog.locator(":scope > .ling-ui-dialog-header")).toHaveCount(1);
  await expect(dialog.locator(":scope > .ling-ui-dialog-body")).toHaveCount(1);
  await expect(dialog.locator(":scope > .ling-ui-dialog-footer")).toHaveCount(1);
  const rows = await dialog.evaluate((element) => Array.from(element.children).map((child) => child.className));
  expect(rows[0]).toContain("ling-ui-dialog-header");
  expect(rows[1]).toContain("ling-ui-dialog-body");
  expect(rows[2]).toContain("ling-ui-dialog-footer");
}

async function expectSharedSelect(select: Locator, size: "md" | "sm"): Promise<void> {
  await expect(select).toHaveClass(/ling-ui-select-native/u);
  await expect(select).toHaveAttribute("data-ling-control-native", "true");
  const shell = select.locator("xpath=..");
  await expect(shell).toHaveClass(/ling-ui-select/u);
  await expect(shell).toHaveAttribute("data-size", size);
  expect(await shell.evaluate((element) => element.hasAttribute("data-select-control"))).toBe(false);

  const heightBeforeFocus = await shell.evaluate((element) => element.getBoundingClientRect().height);
  await select.focus();
  await expect(select).toBeFocused();
  const [nativeBox, shellBox] = await Promise.all([select.boundingBox(), shell.boundingBox()]);
  if (!nativeBox || !shellBox) throw new Error("Shared Select geometry is unavailable");
  expect(Math.round(heightBeforeFocus)).toBe(36);
  expect(Math.round(shellBox.height)).toBe(36);
  expect(nativeBox.y).toBeGreaterThanOrEqual(shellBox.y - 1);
  expect(nativeBox.y + nativeBox.height).toBeLessThanOrEqual(shellBox.y + shellBox.height + 1);
}

async function listFiles(directory: string, pattern: RegExp): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const resolved = `${directory}${directory.endsWith("/") ? "" : "/"}${entry.name}`;
    if (entry.isDirectory()) return listFiles(resolved, pattern);
    return pattern.test(entry.name) ? [resolved] : [];
  }));
  return files.flat();
}

function extractSelectorBranches(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((prelude) => prelude && !prelude.startsWith("@"))
    .flatMap((prelude) => prelude.split(",").map((branch) => branch.trim()))
    .filter(Boolean);
}

function selectorContainsClass(selector: string, token: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_-])\\.${escapeRegex(token)}(?![A-Za-z0-9_-])`, "u").test(selector);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
