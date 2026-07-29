import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate, isRecord } from "./support/mock-state";
import { openChannelChatTools, openEngineeringChannel } from "./support/test-helpers";

const repositoryDirectory = fileURLToPath(new URL("../../../", import.meta.url));
const webSourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const settingsCssPath = fileURLToPath(new URL("../src/styles/settings-personalization.css", import.meta.url));
const activityCssPath = fileURLToPath(new URL("../src/styles/channel-activity-work-thread.css", import.meta.url));
const workflowCssPath = fileURLToPath(new URL("../src/styles/channel-workflow-preview.css", import.meta.url));

const deadAliases = [
  {
    containerClass: "settings-skill-governance-field",
    selector: ".settings-skill-governance-field .select-control",
  },
  {
    containerClass: "activity-view-select",
    selector: ".activity-view-select .select-control",
  },
  {
    containerClass: "workflow-preview-owner-select",
    selector: ".workflow-preview-owner-select .select-control",
  },
] as const;

const liveRuleContracts = [
  {
    path: settingsCssPath,
    rules: [
      { selector: ".settings-skill-governance-field", declarations: ["min-width: 0"] },
    ],
  },
  {
    path: activityCssPath,
    rules: [
      {
        selector: ".activity-view-select",
        declarations: [
          "display: grid",
          "grid-template-columns: auto minmax(110px, 1fr)",
          "min-width: 0",
          "width: 100%",
        ],
      },
      {
        selector: ".activity-view-select span",
        declarations: ["white-space: nowrap"],
      },
    ],
  },
  {
    path: workflowCssPath,
    rules: [
      {
        selector: ".workflow-preview-owner-select",
        declarations: ["display: grid", "min-width: 0", "gap: var(--ling-space-1)"],
      },
      {
        selector: ".workflow-preview-owner-select > span",
        declarations: ["color: var(--ling-text-muted)", "font-weight: 650"],
      },
    ],
  },
] as const;

const themeCases = [
  { theme: "light", width: 1440, height: 960 },
  { theme: "dark", width: 1280, height: 800 },
] as const;

test("T13-P.3-J removes all three dead SelectControl emitters and CSS writers", async () => {
  const productionFiles = await listFiles(webSourceDirectory, /\.(?:ts|tsx)$/u);
  const cssFiles = await listFiles(webSourceDirectory, /\.css$/u);

  for (const target of deadAliases) {
    const emitters: string[] = [];
    for (const file of productionFiles) {
      const source = await readFile(file, "utf8");
      if (sourceEmitsLegacyAlias(source, target.containerClass)) {
        emitters.push(relative(repositoryDirectory, file));
      }
    }
    expect(emitters, `${target.selector} must have no production emitter`).toEqual([]);

    const writers: string[] = [];
    for (const file of cssFiles) {
      const css = await readFile(file, "utf8");
      if (extractSelectorBranches(css).includes(target.selector)) {
        writers.push(relative(repositoryDirectory, file));
      }
    }
    expect(writers, `${target.selector} must have no CSS writer`).toEqual([]);
  }
});

test("T13-P.3-J preserves the three live container and label layout contracts", async () => {
  for (const contract of liveRuleContracts) {
    const css = await readFile(contract.path, "utf8");
    for (const rule of contract.rules) {
      const body = findRuleBody(css, rule.selector);
      expect(body, `${rule.selector} must remain in ${relative(repositoryDirectory, contract.path)}`).toBeDefined();
      const normalizedBody = normalizeCss(body ?? "");
      for (const declaration of rule.declarations) {
        expect(normalizedBody).toContain(normalizeCss(declaration));
      }
    }
  }
});

for (const themeCase of themeCases) {
  test(`${themeCase.theme} Skill Governance keeps shared Select geometry and save behavior`, async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);
    await prepareSurface(page, themeCase);
    const state = createBaseState({ approvalStatus: "expired" });
    await mockDaemon(page, state);
    await page.goto("/");

    await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Settings sections").getByRole("button", { name: /Personalization/ }).click();
    const settingsSurface = page.getByRole("region", { name: "Settings" });
    const governance = settingsSurface
      .locator(".skill-governance-settings-panel")
      .getByRole("region", { name: "Skill policy" });
    const generation = governance.getByRole("combobox", { name: "Skill candidate generation mode" });
    const field = generation.locator(
      "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' settings-skill-governance-field ')][1]",
    );
    await expectSharedSelectGeometry(page, generation, field, "md", 36);

    await generation.selectOption("approval_only");
    await expect(generation).toHaveValue("approval_only");
    await governance.getByRole("button", { name: "Save governance policy" }).click();
    await expect.poll(() => {
      const policy = state.workspaceSettings.skillGovernancePolicy;
      return isRecord(policy) ? policy.generationMode : undefined;
    }).toBe("approval_only");
    expect(runtimeErrors).toEqual([]);
  });

  test(`${themeCase.theme} Channel Activity keeps saved-view Select geometry and behavior`, async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);
    await prepareSurface(page, themeCase);
    await mockDaemon(page, createBaseState({ approvalStatus: "expired" }));
    await page.goto("/");
    await openChannelChatTools(page);

    const savedViews = page.getByRole("combobox", { name: "Saved views" });
    const container = page.locator(".activity-view-select");
    await expectSharedSelectGeometry(page, savedViews, container, "sm", 32);
    await savedViews.selectOption("builtin:needs_attention");
    await expect(savedViews).toHaveValue("builtin:needs_attention");
    await expect(page.locator(".activity-filter-toggle")).toContainText("Needs attention");
    expect(runtimeErrors).toEqual([]);
  });

  test(`${themeCase.theme} Workflow Preview keeps owner Select geometry and behavior`, async ({ page }) => {
    const runtimeErrors = collectRuntimeErrors(page);
    await prepareSurface(page, themeCase);
    const state = createWorkflowPreviewState();
    await mockDaemon(page, state);
    await page.goto("/");
    await openEngineeringChannel(page);

    await page.getByLabel("Proposed plan").getByRole("button", { name: "Convert to workflow" }).click();
    const dialog = page.getByRole("dialog", { name: "Workflow conversion preview" });
    await dialog.evaluate(async (element) => {
      await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    });
    const owner = dialog.getByRole("combobox", { name: "Owner for step 1" });
    const container = dialog.locator(".workflow-preview-owner-select").first();
    await expectSharedSelectGeometry(page, owner, container, "sm", 32);
    await owner.selectOption("teammate_select_alias_owner");
    await expect(owner).toHaveValue("teammate_select_alias_owner");
    await expect(dialog).toBeVisible();
    expect(runtimeErrors).toEqual([]);
  });
}

async function prepareSurface(
  page: Page,
  themeCase: (typeof themeCases)[number],
): Promise<void> {
  await page.setViewportSize({ width: themeCase.width, height: themeCase.height });
  await page.addInitScript((theme) => {
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, themeCase.theme);
}

async function expectSharedSelectGeometry(
  page: Page,
  select: Locator,
  container: Locator,
  size: "md" | "sm",
  expectedHeight: number,
): Promise<void> {
  await expect(select).toBeVisible();
  await expect(select).toHaveClass(/ling-ui-select-native/u);
  await expect(select).toHaveAttribute("data-ling-control-native", "true");
  const shell = select.locator("xpath=..");
  await expect(shell).toHaveClass(/ling-ui-select/u);
  await expect(shell).toHaveAttribute("data-size", size);
  expect(await shell.evaluate((element) => element.hasAttribute("data-select-control"))).toBe(false);

  const heightBeforeFocus = await shell.evaluate((element) => element.getBoundingClientRect().height);
  expect(Math.round(heightBeforeFocus)).toBe(expectedHeight);
  await select.focus();
  await expect(select).toBeFocused();

  const [nativeBox, shellBox, containerBox] = await Promise.all([
    select.boundingBox(),
    shell.boundingBox(),
    container.boundingBox(),
  ]);
  if (!nativeBox || !shellBox || !containerBox) {
    throw new Error("Shared Select geometry is unavailable");
  }
  expect(Math.round(await shell.evaluate((element) => element.getBoundingClientRect().height))).toBe(expectedHeight);
  const nativeTop = nativeBox.y;
  const nativeBottom = nativeBox.y + nativeBox.height;
  const shellTop = shellBox.y;
  const shellBottom = shellBox.y + shellBox.height;
  expect(nativeTop).toBeGreaterThanOrEqual(shellTop - 1);
  expect(nativeBottom).toBeLessThanOrEqual(shellBottom + 1);
  expect(shellBox.width).toBeLessThanOrEqual(containerBox.width + 1);
  expect(await container.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
}

function createWorkflowPreviewState() {
  const state = createBaseState({ approvalStatus: "expired" });
  state.runs = [];
  state.tasks = [];
  state.approvals = [];
  state.threads = [{
    id: "thread_channel_main_channel_engineering",
    workspaceId: "workspace_default",
    kind: "channel_discussion",
    channelId: "channel_engineering",
    title: "Main branch",
    objective: "Main conversation branch for Engineering.",
    status: "open",
    conversationMode: { mode: "default" },
    createdAt: "2026-07-24T03:00:00.000Z",
    updatedAt: "2026-07-24T03:00:00.000Z",
  }];
  state.aiTeammates = [createMockTeammate({
    id: "teammate_select_alias_owner",
    displayName: "Alias Owner",
  })];
  state.channelMessages = [{
    id: "message_select_alias_workflow",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    threadId: "thread_channel_main_channel_engineering",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "ling_agent",
    body: [
      '<proposed_plan title="Select alias cleanup">',
      "1. Remove the dead feature selector.",
      "2. Verify shared Select geometry.",
      "</proposed_plan>",
    ].join("\n"),
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-24T03:01:00.000Z",
    updatedAt: "2026-07-24T03:01:00.000Z",
  }];
  return state;
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

function sourceEmitsLegacyAlias(source: string, containerClass: string): boolean {
  if (!source.includes(containerClass)) return false;
  return /\bSelectControl\b/u.test(source)
    || /(?:className|containerClassName)=[{]?['"`][^'"`]*\bselect-control\b/u.test(source);
}

function extractSelectorBranches(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/([^{}]+)\{/gu)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((prelude) => prelude && !prelude.startsWith("@"))
    .flatMap((prelude) => prelude.split(",").map((branch) => branch.trim()))
    .filter(Boolean);
}

function findRuleBody(css: string, selector: string): string | undefined {
  const cleanCss = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  for (const match of cleanCss.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const branches = (match[1] ?? "").split(",").map((branch) => branch.trim());
    if (branches.includes(selector)) return match[2];
  }
  return undefined;
}

function normalizeCss(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
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
