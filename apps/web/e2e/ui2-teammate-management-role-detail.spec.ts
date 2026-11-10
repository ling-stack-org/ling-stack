import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
} from "./support/mock-state";

type Locale = "en-US" | "zh-CN";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/ai-teammate-management-role-detail/",
  import.meta.url,
));

const labels = {
  "en-US": {
    advanced: "Advanced details",
    allowedTools: "Allowed tools",
    close: "Close",
    productStrategist: /Product Strategist/u,
    providerCapabilities: "Provider capabilities",
    roleDetail: "Role detail",
    settings: "Settings",
    systemPrompt: "System prompt",
    teammateManagement: "Teammate Management",
    teammateTemplates: "Teammate templates",
    useRole: "Use this role",
    workflow: "Workflow",
  },
  "zh-CN": {
    advanced: "高级详情",
    allowedTools: "允许工具",
    close: "关闭",
    productStrategist: /产品策略/u,
    providerCapabilities: "模型供应商能力",
    roleDetail: "角色详情",
    settings: "设置",
    systemPrompt: "系统提示词",
    teammateManagement: "队友管理",
    teammateTemplates: "队友模板",
    useRole: "使用这个角色创建队友",
    workflow: "工作流",
  },
} as const;

test("light role detail defaults advanced content closed and restores trigger focus", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  await mockDaemon(page, createRoleDetailState());
  await page.goto("/");

  const { dialog, trigger } = await openRoleDetail(page, "en-US");
  const advanced = dialog.locator(".teammate-advanced-detail");

  await expect(dialog.getByRole("heading", { name: "Product Strategist" })).toBeVisible();
  await expect(dialog.getByText(labels["en-US"].advanced, { exact: true })).toBeVisible();
  await expect(advanced).not.toHaveAttribute("open", "");
  await expect(dialog.getByText(labels["en-US"].systemPrompt, { exact: true })).toBeHidden();
  await captureEvidence(page, "1440x960-ling-light-default-collapsed.png");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

test("dark reduced-motion role detail exposes advanced workflow with one scroll owner", async ({ page }) => {
  await prepareSurface(page, {
    theme: "dark",
    width: 1280,
    height: 800,
    locale: "en-US",
    reducedMotion: "reduce",
  });
  const runtimeErrors = collectRuntimeErrors(page);
  await mockDaemon(page, createRoleDetailState());
  await page.goto("/");

  const { dialog } = await openRoleDetail(page, "en-US");
  const advanced = dialog.locator(".teammate-advanced-detail");
  await dialog.getByText(labels["en-US"].advanced, { exact: true }).click();
  await expect(advanced).toHaveAttribute("open", "");

  await expect(dialog.getByText(labels["en-US"].providerCapabilities, { exact: true })).toBeVisible();
  await expect(dialog.getByText(labels["en-US"].allowedTools, { exact: true })).toBeVisible();
  await expect(dialog.getByText(labels["en-US"].systemPrompt, { exact: true })).toBeVisible();
  const workflow = dialog.getByRole("region", { name: labels["en-US"].workflow });
  await expect(workflow).toBeVisible();

  const workflowCards = workflow.locator(".workflow-step-card");
  expect(await workflowCards.count()).toBeGreaterThanOrEqual(4);
  const firstFourSteps = [
    "Product Discovery",
    "Product Review",
    "Design Review",
    "Engineering Review",
  ];
  for (const [index, stepName] of firstFourSteps.entries()) {
    const card = workflowCards.nth(index);
    await expect(card).toBeVisible();
    await expect(card).toContainText(String(index + 1));
    await expect(card).toContainText(stepName);
  }

  const footer = dialog.locator(".teammate-detail-sheet-actions");
  await expect(footer.getByRole("button", { name: labels["en-US"].close, exact: true })).toBeVisible();
  await expect(footer.getByRole("button", { name: labels["en-US"].useRole })).toBeVisible();

  const scrollLayout = await dialog.evaluate((element) => {
    const body = element.querySelector<HTMLElement>(".teammate-detail-sheet-body");
    const footerElement = element.querySelector<HTMLElement>(".teammate-detail-sheet-actions");
    const verticalScrollOwners = Array.from(element.querySelectorAll<HTMLElement>("*"))
      .filter((child) => ["auto", "scroll"].includes(getComputedStyle(child).overflowY))
      .map((child) => child.className);
    return {
      bodyOverflowY: body ? getComputedStyle(body).overflowY : "missing",
      dialogOverflowY: getComputedStyle(element).overflowY,
      footerInsideBody: Boolean(body && footerElement && body.contains(footerElement)),
      verticalScrollOwners,
    };
  });
  expect(scrollLayout.bodyOverflowY).toBe("auto");
  expect(scrollLayout.dialogOverflowY).toBe("hidden");
  expect(scrollLayout.footerInsideBody).toBe(false);
  expect(scrollLayout.verticalScrollOwners).toEqual([
    expect.stringContaining("teammate-detail-sheet-body"),
  ]);
  await workflow.scrollIntoViewIfNeeded();
  await captureEvidence(page, "1280x800-ling-dark-advanced-workflow.png");
  expect(runtimeErrors).toEqual([]);
});

test("zh-CN role detail keeps long content inside dialog and document geometry", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1280, height: 800, locale: "zh-CN" });
  const runtimeErrors = collectRuntimeErrors(page);
  await mockDaemon(page, createRoleDetailState());
  await page.goto("/");

  const { dialog } = await openRoleDetail(page, "zh-CN");
  await dialog.getByText(labels["zh-CN"].advanced, { exact: true }).click();
  await expect(dialog.getByText(labels["zh-CN"].providerCapabilities, { exact: true })).toBeVisible();
  await expect(dialog.getByText(labels["zh-CN"].allowedTools, { exact: true })).toBeVisible();
  await expect(dialog.getByText(labels["zh-CN"].systemPrompt, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("region", { name: labels["zh-CN"].workflow })).toBeVisible();

  const geometry = await dialog.evaluate((element) => {
    const body = element.querySelector<HTMLElement>(".teammate-detail-sheet-body");
    const footer = element.querySelector<HTMLElement>(".teammate-detail-sheet-actions");
    const selectors = [
      ".teammate-detail-sheet-body",
      ".teammate-section",
      ".teammate-use-list",
      ".teammate-role-skill-list",
      ".teammate-role-skill-row",
      ".teammate-advanced-detail",
      ".teammate-meta-grid",
      ".teammate-workflow-panel",
      ".workflow-step-lane",
      ".workflow-step-card",
      ".teammate-detail-sheet-actions",
    ];
    const dialogRect = element.getBoundingClientRect();
    const children = selectors.flatMap((selector) =>
      Array.from(element.querySelectorAll<HTMLElement>(selector)).map((child) => {
        const rect = child.getBoundingClientRect();
        return {
          selector,
          className: child.className,
          leftOutside: dialogRect.left - rect.left,
          rightOutside: rect.right - dialogRect.right,
          overflowX: child.scrollWidth - child.clientWidth,
        };
      }),
    );
    return {
      childCount: children.length,
      dialogOverflowX: element.scrollWidth - element.clientWidth,
      documentOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      footerInsideBody: Boolean(body && footer && body.contains(footer)),
      overflowingChildren: children.filter((child) =>
        child.leftOutside > 1 || child.rightOutside > 1 || child.overflowX > 1),
    };
  });

  expect(geometry.childCount).toBeGreaterThan(12);
  expect(geometry.dialogOverflowX).toBeLessThanOrEqual(1);
  expect(geometry.documentOverflowX).toBeLessThanOrEqual(1);
  expect(geometry.footerInsideBody).toBe(false);
  expect(geometry.overflowingChildren).toEqual([]);
  await dialog.getByRole("region", { name: labels["zh-CN"].workflow }).scrollIntoViewIfNeeded();
  await captureEvidence(page, "1280x800-ling-light-zh-long-content.png");
  expect(runtimeErrors).toEqual([]);
});

function createRoleDetailState(): ReturnType<typeof createBaseState> {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_role_detail",
    providerId: "local-relay",
    displayName: "Local Relay",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "Ready", checkedAt: "2026-07-20T00:00:00.000Z" },
  })];
  state.aiTeammates = [createMockTeammate({
    id: "teammate_role_detail",
    templateId: "engineer",
    roleKey: "engineer",
    displayName: "Existing Engineer",
    providerPresetId: "provider_role_detail",
  })];
  return state;
}

async function openRoleDetail(
  page: Page,
  locale: Locale,
): Promise<{ readonly dialog: Locator; readonly trigger: Locator }> {
  const copy = labels[locale];
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: copy.settings }).click();
  await page.getByLabel(/Settings sections|设置分组/u)
    .getByRole("button", { name: copy.teammateManagement })
    .click();
  const surface = page.locator("[data-ui2-settings-workspace-tool][data-settings-workspace-tool='teammates']");
  await expect(surface).toBeVisible();
  const trigger = surface.getByLabel(copy.teammateTemplates)
    .getByRole("button", { name: copy.productStrategist });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: copy.roleDetail });
  await expect(dialog).toBeVisible();
  return { dialog, trigger };
}

async function prepareSurface(
  page: Page,
  options: {
    readonly theme: "dark" | "light";
    readonly width: number;
    readonly height: number;
    readonly locale: Locale;
    readonly reducedMotion?: "no-preference" | "reduce";
  },
): Promise<void> {
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.emulateMedia({
    colorScheme: options.theme,
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  await page.addInitScript(({ initialTheme, initialLocale }) => {
    const themeId = initialTheme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", initialLocale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", initialTheme);
  }, { initialTheme: options.theme, initialLocale: options.locale });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: false,
    path: `${evidenceDirectory}${filename}`,
  });
}
