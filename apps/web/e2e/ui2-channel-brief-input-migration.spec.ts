import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createEmptyMockBrief, mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { openChannelContextPanel, openEngineeringChannel } from "./support/test-helpers";

const repositoryDirectory = fileURLToPath(new URL("../../../", import.meta.url));
const screenshotDirectory = `${repositoryDirectory}docs/design/ui2.0升级/evidence/features/raw-text-controls/second-wave`;

const fieldContracts = [
  { label: "Objective", rows: "2", key: "objective" },
  { label: "Scope", rows: "2", key: "scope" },
  { label: "Acceptance criteria", rows: "3", key: "acceptanceCriteria" },
  { label: "Open questions", rows: "2", key: "openQuestions" },
  { label: "Risks", rows: "2", key: "risks" },
] as const;

test("T12.1c-F Channel Brief has one shared-control owner and no raw textarea emitter", async () => {
  const [inspectorSource, editorSource, legacyCss, focusedCss, dockManifest] = await Promise.all([
    readRepositoryFile("apps/web/src/features/workspace/ChannelInspectorPanels.tsx"),
    readRepositoryFile("apps/web/src/features/workspace/ChannelBriefEditor.tsx"),
    readRepositoryFile("apps/web/src/styles/components.css"),
    readRepositoryFile("apps/web/src/styles/channel-right-dock/brief-editor.css"),
    readRepositoryFile("apps/web/src/styles/channel-right-dock.css"),
  ]);

  expect(inspectorSource).toContain('from "./ChannelBriefEditor.js";');
  expect(inspectorSource).toContain("<ChannelBriefEditor");
  expect(countMatches(inspectorSource, /<textarea\b/gu)).toBe(0);
  expect(countMatches(editorSource, /<textarea\b/gu)).toBe(0);
  expect(countMatches(editorSource, /<Textarea\b/gu)).toBe(5);
  expect(editorSource).toContain('from "../../shared/ui/index.js"');
  expect(editorSource).not.toMatch(/from\s+["'][^"']*(?:api|types|domains|core)[^"']*["']/u);
  expect(legacyCss).not.toMatch(/\.brief-editor(?:\s|,|\{)/u);
  expect(focusedCss).not.toMatch(/\.ling-ui-/u);
  expect(dockManifest).toContain('@import "./channel-right-dock/brief-editor.css";');
});

test("T12.1c-F Light 1440 edits and saves all five Brief values with stable focus geometry", async ({ page }) => {
  await prepareSurface(page, { height: 960, theme: "light", width: 1440 });
  const runtime = watchRuntime(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelBriefs.channel_engineering = {
    ...createEmptyMockBrief("channel_engineering"),
    objective: "Initial objective",
    scope: "Initial scope",
    acceptanceCriteria: ["Initial acceptance one", "Initial acceptance two"],
    openQuestions: ["Initial question"],
    risks: ["Initial risk"],
  };
  await mockDaemon(page, state);

  await page.goto("/");
  const surface = await openBriefInspector(page);
  const controls = briefControls(surface.editor);
  await expect(controls).toHaveCount(5);
  await expectBriefValues(surface.editor, {
    objective: "Initial objective",
    scope: "Initial scope",
    acceptanceCriteria: "Initial acceptance one\nInitial acceptance two",
    openQuestions: "Initial question",
    risks: "Initial risk",
  });
  await expectRowsAndSharedOwnership(surface.editor);

  for (const field of fieldContracts) {
    await expectStableTextareaFocus(surface.editor.getByRole("textbox", { name: field.label, exact: true }));
  }

  const nextValues = {
    objective: "Ship the focused Channel Brief editor",
    scope: "Channel Activity dock only",
    acceptanceCriteria: "First criterion\nSecond criterion",
    openQuestions: "Who owns release?\nWhen is rollout?",
    risks: "Focus geometry regression\nLong content overflow",
  };
  await fillBrief(surface.editor, nextValues);

  const requestPromise = page.waitForRequest((request) => (
    request.method() === "PATCH"
      && new URL(request.url()).pathname === "/channels/channel_engineering/brief"
  ));
  await surface.editor.getByRole("button", { name: "Save brief", exact: true }).click();
  const request = await requestPromise;
  expect(request.postDataJSON()).toMatchObject({
    objective: nextValues.objective,
    scope: nextValues.scope,
    acceptanceCriteria: ["First criterion", "Second criterion"],
    openQuestions: ["Who owns release?", "When is rollout?"],
    risks: ["Focus geometry regression", "Long content overflow"],
    updatedBy: "local-user",
  });
  await expect.poll(() => state.channelBriefs.channel_engineering).toMatchObject({
    objective: nextValues.objective,
    scope: nextValues.scope,
    acceptanceCriteria: ["First criterion", "Second criterion"],
    openQuestions: ["Who owns release?", "When is rollout?"],
    risks: ["Focus geometry regression", "Long content overflow"],
  });
  await expectBriefValues(surface.editor, nextValues);
  await expectNoOverflow(page, [surface.dock, surface.inspector, surface.editor]);
  await captureScreenshot(page, "1440x960-ling-light-channel-brief.png");
  runtime.expectClean();
});

test("T12.1c-F Dark 1280 reduced motion contains long Brief text and shared focus chrome", async ({ page }) => {
  await prepareSurface(page, {
    height: 800,
    reducedMotion: true,
    theme: "dark",
    width: 1280,
  });
  const runtime = watchRuntime(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));

  await page.goto("/");
  const surface = await openBriefInspector(page);
  const longToken = "long-unbroken-channel-brief-value-".repeat(18);
  await fillBrief(surface.editor, {
    objective: `${longToken}objective`,
    scope: `${longToken}scope`,
    acceptanceCriteria: `${longToken}acceptance\n${longToken}second-line`,
    openQuestions: `${longToken}question`,
    risks: `${longToken}risk`,
  });

  await expectRowsAndSharedOwnership(surface.editor);
  for (const field of fieldContracts) {
    const control = surface.editor.getByRole("textbox", { name: field.label, exact: true });
    await expectStableTextareaFocus(control);
    const geometry = await control.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  const durations = await briefControls(surface.editor).evaluateAll((elements) => (
    elements.flatMap((element) => getComputedStyle(element).transitionDuration.split(", "))
  ));
  expect(durations.every((duration) => duration === "0s")).toBe(true);
  await expectNoOverflow(page, [surface.dock, surface.inspector, surface.editor]);
  await captureScreenshot(page, "1280x800-ling-dark-channel-brief-reduced-motion.png");
  runtime.expectClean();
});

async function openBriefInspector(page: Page): Promise<{
  readonly dock: Locator;
  readonly editor: Locator;
  readonly inspector: Locator;
}> {
  await openEngineeringChannel(page);
  await openChannelContextPanel(page);
  const dock = page.getByRole("complementary", { name: "Channel workspace dock" });
  await expect(dock).toBeVisible();
  const modes = page.getByLabel("Channel inspector modes");
  if (!await modes.isVisible().catch(() => false)) {
    await dock.getByRole("button", { name: "Activity", exact: true }).click();
  }
  await expect(modes).toBeVisible();
  await modes.getByRole("button", { name: "Brief", exact: true }).click();
  const inspector = page.getByRole("region", { name: "Channel inspector" });
  const editor = inspector.getByRole("group", { name: "Brief" });
  await expect(editor).toBeVisible();
  return { dock, editor, inspector };
}

function briefControls(editor: Locator): Locator {
  return editor.getByRole("textbox");
}

async function expectRowsAndSharedOwnership(editor: Locator): Promise<void> {
  for (const field of fieldContracts) {
    const control = editor.getByRole("textbox", { name: field.label, exact: true });
    await expect(control).toHaveAttribute("rows", field.rows);
    await expect(control).toHaveAttribute("data-ling-control-native", "true");
  }
  const save = editor.getByRole("button", { name: "Save brief", exact: true });
  await expect(save).toHaveAttribute("data-variant", "primary");
  await expect(save).toHaveAttribute("data-size", "sm");
}

async function expectStableTextareaFocus(control: Locator): Promise<void> {
  const before = await readFocusGeometry(control);
  await control.focus();
  await expect(control).toBeFocused();
  const after = await readFocusGeometry(control);

  expect(after.boxSizing).toBe("border-box");
  expect(after.outlineWidth).toBe("0px");
  expect(after.boxShadow).toContain("inset");
  expect(Math.abs(after.controlHeight - before.controlHeight)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(after.controlWidth - before.controlWidth)).toBeLessThanOrEqual(0.5);
  expect(after.controlTop).toBeGreaterThanOrEqual(after.fieldTop - 1);
  expect(after.controlBottom).toBeLessThanOrEqual(after.fieldBottom + 1);
  expect(after.controlLeft).toBeGreaterThanOrEqual(after.fieldLeft - 1);
  expect(after.controlRight).toBeLessThanOrEqual(after.fieldRight + 1);
}

async function readFocusGeometry(control: Locator): Promise<{
  readonly boxShadow: string;
  readonly boxSizing: string;
  readonly controlBottom: number;
  readonly controlHeight: number;
  readonly controlLeft: number;
  readonly controlRight: number;
  readonly controlTop: number;
  readonly controlWidth: number;
  readonly fieldBottom: number;
  readonly fieldLeft: number;
  readonly fieldRight: number;
  readonly fieldTop: number;
  readonly outlineWidth: string;
}> {
  return await control.evaluate((element) => {
    const field = element.parentElement;
    if (!field) throw new Error("Channel Brief textarea is missing its Field owner");
    const controlBox = element.getBoundingClientRect();
    const fieldBox = field.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      boxShadow: style.boxShadow,
      boxSizing: style.boxSizing,
      controlBottom: controlBox.bottom,
      controlHeight: controlBox.height,
      controlLeft: controlBox.left,
      controlRight: controlBox.right,
      controlTop: controlBox.top,
      controlWidth: controlBox.width,
      fieldBottom: fieldBox.bottom,
      fieldLeft: fieldBox.left,
      fieldRight: fieldBox.right,
      fieldTop: fieldBox.top,
      outlineWidth: style.outlineWidth,
    };
  });
}

async function fillBrief(
  editor: Locator,
  values: Record<(typeof fieldContracts)[number]["key"], string>,
): Promise<void> {
  for (const field of fieldContracts) {
    await editor.getByRole("textbox", { name: field.label, exact: true }).fill(values[field.key]);
  }
}

async function expectBriefValues(
  editor: Locator,
  values: Record<(typeof fieldContracts)[number]["key"], string>,
): Promise<void> {
  for (const field of fieldContracts) {
    await expect(editor.getByRole("textbox", { name: field.label, exact: true })).toHaveValue(values[field.key]);
  }
}

async function expectNoOverflow(page: Page, regions: readonly Locator[]): Promise<void> {
  for (const region of regions) {
    const metrics = await region.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  }
  const documentMetrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(documentMetrics.scrollWidth).toBeLessThanOrEqual(documentMetrics.clientWidth + 1);
}

async function prepareSurface(
  page: Page,
  options: {
    readonly height: number;
    readonly reducedMotion?: boolean;
    readonly theme: "light" | "dark";
    readonly width: number;
  },
): Promise<void> {
  await page.setViewportSize({ height: options.height, width: options.width });
  await page.emulateMedia({ reducedMotion: options.reducedMotion ? "reduce" : "no-preference" });
  await page.addInitScript((theme) => {
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, options.theme);
}

function watchRuntime(page: Page): {
  readonly expectClean: () => void;
} {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    expectClean: () => {
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    },
  };
}

async function readRepositoryFile(path: string): Promise<string> {
  return await readFile(`${repositoryDirectory}${path}`, "utf8");
}

async function captureScreenshot(page: Page, fileName: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(screenshotDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", caret: "hide", path: `${screenshotDirectory}/${fileName}` });
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}
