import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { triggerFocusRevalidation } from "./support/focus-revalidation";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/ai-teammate-management-list/",
  import.meta.url,
));

test("teammate management searches and filters one-status rows", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createManagementState();
  await mockDaemon(page, state);
  await page.goto("/");

  const panel = await openTeammateManagement(page);
  const list = panel.getByLabel("Teammate list");
  await expect(list.locator(".teammate-draft-row")).toHaveCount(4);
  await expect(panel.getByLabel("Search teammates")).toBeVisible();
  await expect(panel.getByLabel("Filter teammates")).toHaveValue("all");

  const readyRow = teammateRow(list, "Ling Architect");
  await expect(readyRow.locator(".teammate-row-status")).toHaveCount(1);
  await expect(readyRow.locator(".teammate-row-status.ready")).toContainText("Ready teammate");
  await expect(readyRow.locator(".teammate-model-pill")).toHaveText("gpt-5.5");
  await expect(readyRow).not.toContainText("gpt-5.5 · gpt-5.5");
  await expect(readyRow).toContainText("Engineering");
  const readyRowColumns = await readyRow.evaluate((element) => {
    const summary = element.querySelector<HTMLElement>(".teammate-management-row-summary")?.getBoundingClientRect();
    const updated = element.querySelector<HTMLElement>(".teammate-updated-time")?.getBoundingClientRect();
    const status = element.querySelector<HTMLElement>(".teammate-row-status")?.getBoundingClientRect();
    const actions = element.querySelector<HTMLElement>(".teammate-row-actions")?.getBoundingClientRect();
    return {
      summaryBeforeStatus: Boolean(summary && status && summary.right <= status.left + 1),
      statusBeforeActions: Boolean(status && actions && status.right <= actions.left + 1),
      updatedStatusCenterDelta: updated && status
        ? Math.abs(updated.top + updated.height / 2 - (status.top + status.height / 2))
        : Number.POSITIVE_INFINITY,
      updatedActionsCenterDelta: updated && actions
        ? Math.abs(updated.top + updated.height / 2 - (actions.top + actions.height / 2))
        : Number.POSITIVE_INFINITY,
    };
  });
  expect(readyRowColumns.summaryBeforeStatus).toBe(true);
  expect(readyRowColumns.statusBeforeActions).toBe(true);
  expect(readyRowColumns.updatedStatusCenterDelta).toBeLessThanOrEqual(1);
  expect(readyRowColumns.updatedActionsCenterDelta).toBeLessThanOrEqual(1);

  await panel.getByLabel("Search teammates").fill("gpt-5.5");
  await expect(list.locator(".teammate-draft-row")).toHaveCount(3);
  await panel.getByLabel("Search teammates").fill("Ling Architect");
  await expect(list.locator(".teammate-draft-row")).toHaveCount(1);
  await captureEvidence(page, "1440x960-ling-light-loaded-search.png");

  await panel.getByLabel("Search teammates").fill("");
  await panel.getByLabel("Filter teammates").selectOption("needs-model");
  await expect(list.locator(".teammate-draft-row")).toHaveCount(1);
  await expect(teammateRow(list, "Research Partner").locator(".teammate-row-status.warning"))
    .toContainText("Needs model");
  await panel.getByLabel("Filter teammates").selectOption("hidden");
  await expect(list.locator(".teammate-draft-row")).toHaveCount(1);
  await expect(teammateRow(list, "Hidden Designer")).toHaveAttribute("data-hidden", "true");

  await panel.getByLabel("Filter teammates").selectOption("all");
  await readyRow.getByRole("button", { name: "Teammate actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Edit teammate" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Unpin" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Hide" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
  await expect(readyRow.getByRole("button", { name: "Teammate actions" })).toBeFocused();

  await readyRow.getByRole("button", { name: "Teammate actions" }).click();
  await page.getByRole("menuitem", { name: "Edit teammate" }).click();
  const settings = page.getByLabel("Single agent settings");
  await expect(settings.getByRole("heading", { name: "Teammate settings" })).toBeVisible();
  await expect(page.getByLabel("Teammate profile").getByLabel("Teammate name")).toHaveValue("Ling Architect");

  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("teammate management preserves rows during refresh failure", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createManagementState();
  await mockDaemon(page, state);

  const initialGate = deferred();
  let listMode: "fail" | "hold" | "ok" = "hold";
  await page.route("**/teammates?**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    if (listMode === "hold") await initialGate.promise;
    if (listMode === "fail") {
      await route.fulfill({ status: 503, json: { message: "Synthetic teammate list failure" } });
      return;
    }
    await route.fallback();
  });

  await page.goto("/");
  const panel = await openTeammateManagement(page);
  await expect(panel.getByLabel("Loading AI teammates")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Refresh teammates" })).toHaveCount(0);

  listMode = "ok";
  initialGate.resolve();
  const list = panel.getByLabel("Teammate list");
  await expect(list.locator(".teammate-draft-row")).toHaveCount(4);

  listMode = "fail";
  await triggerFocusRevalidation(page);
  await expect(panel).toContainText("Teammates could not be refreshed. The last loaded list is still shown.");
  await expect(list.locator(".teammate-draft-row")).toHaveCount(4);
  await expect(panel.getByRole("button", { name: "Retry" })).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-refresh-failure.png");

  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("teammate management distinguishes no results from an empty workspace", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800, "reduce");
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createManagementState();
  await mockDaemon(page, state);
  await page.goto("/");

  const panel = await openTeammateManagement(page);
  await panel.getByLabel("Search teammates").fill("no teammate can match this query");
  await expect(panel.getByText("No teammates match the current filters", { exact: true })).toBeVisible();
  await expect(panel.getByText("No workspace teammates", { exact: true })).toHaveCount(0);
  await panel.getByRole("button", { name: "Clear filters" }).click();
  await expect(panel.getByLabel("Teammate list").locator(".teammate-draft-row")).toHaveCount(4);

  await panel.getByLabel("Filter teammates").selectOption("hidden");
  await expect(panel.getByLabel("Teammate list").locator(".teammate-draft-row")).toHaveCount(1);
  await captureEvidence(page, "1280x800-ling-dark-hidden-filter.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("teammate management empty state keeps creation reachable", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [readyProvider()];
  state.aiTeammates = [];
  await mockDaemon(page, state);
  await page.goto("/");

  const panel = await openTeammateManagement(page);
  const teammatePanel = panel.getByLabel("Workspace teammates");
  await expect(teammatePanel.getByText("No workspace teammates", { exact: true })).toBeVisible();
  await expect(teammatePanel.getByRole("button", { name: "New AI teammate" })).toBeVisible();
  await expect(teammatePanel.getByText("No teammates match the current filters", { exact: true })).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-dark-empty.png");

  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function createManagementState(): ReturnType<typeof createBaseState> {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [readyProvider()];
  state.aiTeammates = [
    createMockTeammate({
      id: "teammate_architect",
      templateId: "architect",
      roleKey: "architect",
      displayName: "Ling Architect",
      description: "Owns architecture decisions.",
      providerPresetId: "provider_ready",
      pinned: true,
    }),
    createMockTeammate({
      id: "teammate_hidden_designer",
      templateId: "designer",
      roleKey: "designer",
      displayName: "Hidden Designer",
      description: "Maintains design systems.",
      providerPresetId: "provider_ready",
      hidden: true,
    }),
    createMockTeammate({
      id: "teammate_research",
      templateId: undefined,
      roleKey: "custom",
      displayName: "Research Partner",
      description: "Investigates product questions.",
      providerPresetId: undefined,
    }),
    createMockTeammate({
      id: "teammate_long",
      templateId: "engineer",
      roleKey: "engineer",
      displayName: "A deliberately long teammate name that must stay inside the row",
      description: "Long content fixture.",
      providerPresetId: "provider_ready",
    }),
    createMockTeammate({
      id: "teammate_disabled",
      displayName: "Archived Teammate",
      providerPresetId: "provider_ready",
      status: "disabled",
      hidden: true,
    }),
  ];
  state.teammateChannelMemberships = [
    membership("teammate_architect", "channel_engineering", true),
    membership("teammate_hidden_designer", "channel_engineering", false),
  ];
  return state;
}

function readyProvider(): Record<string, unknown> {
  return createChatProvider({
    id: "provider_ready",
    displayName: "gpt-5.5 · gpt-5.5",
    model: "gpt-5.5",
    lastCheck: { ok: true, message: "Ready", checkedAt: "2026-07-20T00:00:00.000Z" },
  });
}

function membership(teammateId: string, channelId: string, isDefault: boolean): Record<string, unknown> {
  return {
    teammateId,
    channelId,
    isDefault,
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function teammateRow(list: Locator, name: string): Locator {
  return list.locator(".teammate-draft-row").filter({ hasText: name });
}

async function openTeammateManagement(page: Page): Promise<Locator> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Teammate Management" }).click();
  const surface = page.locator("[data-ui2-settings-workspace-tool][data-settings-workspace-tool='teammates']");
  await expect(surface).toBeVisible();
  await expect(page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })).toHaveCount(0);
  return surface;
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

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
