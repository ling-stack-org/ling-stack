import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { triggerFocusRevalidation } from "./support/focus-revalidation";
import {
  createBaseState,
  createMockTeammate,
  isRecord,
  type MockState,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/council-list-health/",
  import.meta.url,
));

test("Council list exposes one truthful state and restores explicit selection after filtering", async ({ page }) => {
  await prepareSurface(page, { height: 960, locale: "en-US", theme: "light", width: 1440 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCouncilListState();
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  const rows = surface.locator(".council-list-health-row");
  await expect(rows).toHaveCount(3);
  for (const row of await rows.all()) {
    await expect(row.locator(".ling-ui-status-indicator")).toHaveCount(1);
  }
  await expect(surface).not.toContainText(/running|正在运行/iu);
  await expect(councilRow(surface, "Healthy Council")).toContainText("Health clear");
  await expect(councilRow(surface, "Attention Council")).toContainText("Critical attention needed");
  await expect(councilRow(surface, "Paused Council")).toContainText("Paused");

  await councilRow(surface, "Attention Council").click();
  await expect(surface.getByLabel("Selected council")).toContainText("Attention Council");
  await surface.getByLabel("Search councils").fill("Healthy Council");
  await expect(rows).toHaveCount(1);
  await expect(surface.getByLabel("Selected council")).toContainText("Healthy Council");
  await surface.getByLabel("Search councils").fill("");
  await expect(surface.getByLabel("Selected council")).toContainText("Attention Council");

  await surface.getByLabel("Filter councils by health").selectOption("paused");
  await expect(rows).toHaveCount(1);
  await expect(councilRow(surface, "Paused Council")).toBeVisible();
  await surface.getByLabel("Filter councils by health").selectOption("all");
  await expect(surface.getByLabel("Selected council")).toContainText("Attention Council");

  const health = surface.getByLabel("Council health");
  await expect(health).toContainText("1 critical finding(s)");
  await expect(health.getByText(/cannot project any runnable specialists/iu)).toHaveCount(0);
  await health.getByText("Health findings").click();
  await expect(health).toContainText("Attention Council: Council empty");
  await captureEvidence(page, "1440x960-ling-light-healthy-attention.png");

  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Council refresh keeps rows, reports stale state, and remains single-flight", async ({ page }) => {
  await prepareSurface(page, { height: 800, locale: "en-US", theme: "dark", width: 1280 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCouncilListState();
  state.aiCouncilHealthDelayMs = 180;
  let failNextList = false;
  const councilRequests: string[] = [];
  const councilResponses: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && (url.pathname === "/ai-councils" || url.pathname === "/ai-councils/health")) {
      councilRequests.push(url.pathname);
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname === "/ai-councils" || url.pathname === "/ai-councils/health") {
      councilResponses.push(`${response.status()}:${url.pathname}`);
    }
  });
  await mockDaemon(page, state);
  await page.route("**/ai-councils?**", async (route) => {
    if (!failNextList || route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    failNextList = false;
    await new Promise((resolve) => setTimeout(resolve, 180));
    await route.fulfill({ status: 503, json: { error: "council_list_unavailable", message: "Synthetic council list failure" } });
  });
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  await expect(surface.locator(".council-list-health-row")).toHaveCount(3);
  await waitForRequestCountToSettle(page, councilRequests);
  councilRequests.length = 0;
  councilResponses.length = 0;
  failNextList = true;
  state.failNextAiCouncilHealth = { error: "council_health_unavailable", message: "Synthetic council health failure" };

  await expect(surface.getByRole("button", { name: "Refresh councils" })).toHaveCount(0);
  await triggerFocusRevalidation(page);
  await expect.poll(() => councilRequests.join(","), { timeout: 2_000 }).toBe("/ai-councils,/ai-councils/health");
  await expect.poll(() => councilResponses.sort().join(","), { timeout: 2_000 }).toBe("503:/ai-councils,503:/ai-councils/health");
  await expect(surface.getByText("Council refresh failed", { exact: true })).toBeVisible();
  await expect(surface.locator(".council-list-health-row")).toHaveCount(3);
  await expect(surface.getByText("Stale snapshot")).toBeVisible();
  const feedbackBox = await surface.locator(".council-list-health-feedback").boundingBox();
  const retainedListBox = await surface.locator(".council-list-health-scroll").boundingBox();
  const retryBox = await surface.getByRole("button", { name: "Retry" }).boundingBox();
  expect(feedbackBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(120);
  expect(retainedListBox?.height ?? 0).toBeGreaterThan(160);
  expect(retryBox?.width ?? 0).toBeGreaterThan(50);
  expect(councilRequests.filter((path) => path === "/ai-councils")).toHaveLength(1);
  expect(councilRequests.filter((path) => path === "/ai-councils/health")).toHaveLength(1);
  await captureEvidence(page, "1280x800-ling-dark-refresh-stale.png");

  await surface.getByRole("button", { name: "Retry" }).click();
  await expect(surface.getByText("Council refresh failed", { exact: true })).toHaveCount(0);
  await expect(surface.getByText("Stale snapshot")).toHaveCount(0);
  await expect(surface.locator(".council-list-health-row")).toHaveCount(3);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Truncated and outdated reports remain partial instead of claiming healthy", async ({ page }) => {
  await prepareSurface(page, { height: 960, locale: "en-US", theme: "dark", width: 1440 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCouncilListState();
  state.aiCouncilHealthFindingLimitOverride = 1;
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  await expect(councilRow(surface, "Healthy Council")).toContainText("Partial health");
  await councilRow(surface, "Healthy Council").click();
  await expect(surface.getByLabel("Council health")).toContainText("Health findings are incomplete");
  await expect(surface.getByLabel("Council health")).not.toContainText("Health clear");
  await captureEvidence(page, "1440x960-ling-dark-partial-health.png");

  state.aiCouncilHealthFindingLimitOverride = undefined;
  state.aiCouncilHealthGeneratedAt = "2026-06-01T00:00:00.000Z";
  await triggerFocusRevalidation(page);
  await expect(surface.getByLabel("Council health")).toContainText("Health report predates this council configuration");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Council no-result and empty states stay distinct and actionable", async ({ page }) => {
  await prepareSurface(page, { height: 800, locale: "en-US", reducedMotion: "reduce", theme: "dark", width: 1280 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCouncilListState();
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  await surface.getByLabel("Search councils").fill("no council can match this query");
  await expect(surface.getByText("No councils match the current filters", { exact: true })).toBeVisible();
  await expect(surface.getByText("No councils available", { exact: true })).toHaveCount(0);
  const clearFilters = surface.getByRole("button", { name: "Clear filters" });
  const clearFiltersBox = await clearFilters.boundingBox();
  expect(clearFiltersBox?.width ?? 0).toBeGreaterThan(80);
  await captureEvidence(page, "1280x800-ling-dark-no-result.png");
  await clearFilters.click();
  await expect(surface.locator(".council-list-health-row")).toHaveCount(3);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Council initial loading and loaded empty use stable shared states", async ({ page }) => {
  await prepareSurface(page, { height: 800, locale: "en-US", theme: "light", width: 1280 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCouncilListState();
  const initialGate = deferred<void>();
  await mockDaemon(page, state);
  await page.route("**/ai-councils?**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await initialGate.promise;
    await route.fulfill({ json: { cwd: "/tmp/ling-stack-e2e", councils: [] } });
  });
  await page.goto("/");

  const surface = await openCouncilWorkspaceShell(page);
  await expect(surface.getByLabel("Loading councils")).toBeVisible();
  await expect(surface.locator(".council-list-health-skeleton-row")).toHaveCount(5);
  initialGate.resolve();
  await expect(surface.getByText("No councils available", { exact: true })).toBeVisible();
  await expect(surface.getByRole("button", { name: "Create council" }).last()).toBeVisible();
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Long Chinese Council list owns its scroll boundary at 1280", async ({ page }) => {
  await prepareSurface(page, { height: 800, locale: "zh-CN", theme: "light", width: 1280 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCouncilListState(64);
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page, /Council Workspace|智囊团工作区/);
  const rows = surface.locator(".council-list-health-row");
  await expect(rows).toHaveCount(64);
  const list = surface.getByLabel(/Council results|智囊团结果/);
  const scroll = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));
  expect(["auto", "scroll"]).toContain(scroll.overflowY);
  expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
  const firstIdentity = rows.first().locator(".council-list-health-identity strong");
  expect(await firstIdentity.evaluate((element) => element.scrollWidth >= element.clientWidth)).toBe(true);
  await captureEvidence(page, "1280x800-ling-light-long-zh-cn.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function createCouncilListState(count = 3): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  const baseCouncil = state.aiCouncils.find(isRecord);
  if (!baseCouncil) throw new Error("Council fixture requires a base council");
  const now = "2026-06-20T00:00:00.000Z";
  const healthyCouncil = {
    ...baseCouncil,
    id: "council_healthy",
    displayName: "Healthy Council",
    description: "A complete readiness baseline",
    pinned: true,
    source: "user",
    status: "active",
    updatedAt: now,
  };
  const attentionCouncil = {
    ...baseCouncil,
    id: "council_attention",
    displayName: "Attention Council",
    description: "No members are configured",
    pinned: false,
    source: "user",
    status: "active",
    updatedAt: now,
  };
  const pausedCouncil = {
    ...baseCouncil,
    id: "council_paused",
    displayName: "Paused Council",
    description: "Configuration is intentionally paused",
    pinned: false,
    source: "user",
    status: "paused",
    updatedAt: now,
  };
  const additionalCouncils = Array.from({ length: Math.max(0, count - 3) }, (_, index) => ({
    ...baseCouncil,
    id: `council_long_${String(index).padStart(3, "0")}`,
    displayName: `用于验证超长名称、中文筛选和固定滚动边界的智囊团 ${String(index).padStart(3, "0")}`,
    description: `这是第 ${index + 1} 个长内容列表样本`,
    pinned: false,
    source: "user",
    status: "active",
    updatedAt: now,
  }));

  state.aiCouncils = [healthyCouncil, attentionCouncil, pausedCouncil, ...additionalCouncils];
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_healthy", displayName: "Healthy Reviewer", status: "active" }),
    createMockTeammate({ id: "teammate_paused", displayName: "Paused Reviewer", status: "active" }),
  ];
  state.aiCouncilMembers = [
    councilMember("council_healthy", "teammate_healthy"),
    councilMember("council_paused", "teammate_paused"),
  ];
  return state;
}

function councilMember(councilId: string, teammateId: string): Record<string, unknown> {
  return {
    councilId,
    teammateId,
    slotKey: "review",
    label: "Review",
    position: 0,
    enabled: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

function councilRow(surface: Locator, name: string): Locator {
  return surface.locator(".council-list-health-row").filter({ hasText: name });
}

async function openCouncilWorkspace(page: Page, label: string | RegExp = "Council Workspace"): Promise<Locator> {
  const surface = await openCouncilWorkspaceShell(page, label);
  await expect(surface.locator(".council-list-health-row").first()).toBeVisible();
  return surface;
}

async function openCouncilWorkspaceShell(page: Page, label: string | RegExp = "Council Workspace"): Promise<Locator> {
  await page.getByLabel(/Ling Stack navigation|Ling Stack 导航/).getByRole("button", { name: /Settings|设置/ }).click();
  await page.getByLabel(/Settings sections|设置分组/).getByRole("button", { name: label }).click();
  const surface = page.locator("[data-settings-workspace-tool='councils']");
  await expect(surface).toBeVisible();
  return surface;
}

async function prepareSurface(
  page: Page,
  input: {
    readonly height: number;
    readonly locale: "en-US" | "zh-CN";
    readonly reducedMotion?: "no-preference" | "reduce";
    readonly theme: "dark" | "light";
    readonly width: number;
  },
): Promise<void> {
  await page.setViewportSize({ width: input.width, height: input.height });
  await page.emulateMedia({ colorScheme: input.theme, reducedMotion: input.reducedMotion ?? "no-preference" });
  await page.addInitScript(({ locale, theme }) => {
    const themeId = theme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { locale: input.locale, theme: input.theme });
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

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitForRequestCountToSettle(page: Page, requests: readonly string[]): Promise<void> {
  let previousCount = -1;
  let stablePasses = 0;
  while (stablePasses < 3) {
    await page.waitForTimeout(200);
    if (requests.length === previousCount) stablePasses += 1;
    else stablePasses = 0;
    previousCount = requests.length;
  }
}
