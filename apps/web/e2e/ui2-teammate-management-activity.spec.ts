import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate, cwd, type MockState } from "./support/mock-state";

const teammateId = "teammate_activity_reviewer";
const teammateName = "Activity Systems Reviewer";
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/ai-teammate-management-activity/",
  import.meta.url,
));

test("Recent activity exposes all five product kinds and only Run rows navigate", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createActivityState();
  state.runs = [{
    ...state.runs[0],
    id: "run_activity_release",
    teammateId,
    status: "running",
    taskSnapshot: { id: "task_activity_release", title: "Release verification" },
  }];
  const items = createFiveKindItems();
  await mockDaemon(page, state);
  await routeActivity(page, () => ({ items }));
  await page.goto("/");

  const activity = await openActivity(page);
  await expect(activity.locator("[data-activity-id]")).toHaveCount(5);
  await expect(activity.locator(".teammate-activity-list")).toHaveCSS("border-top-width", "1px");
  await expect(activity.locator(".teammate-activity-kind-icon").first()).toHaveCSS("border-top-width", "0px");
  await expect(activity).toContainText("Private message");
  await expect(activity).toContainText("Prepare release checklist");
  await expect(activity).toContainText("Release verification");
  await expect(activity).toContainText("Approve production access");
  await expect(activity).toContainText("Mentioned in #release");
  await expect(activity).not.toContainText("source_activity_message");
  await expect(activity.locator('button[data-ling-icon-button-contract="legacy-react-node"]')).toHaveCount(0);
  const refreshAction = activity.getByRole("button", { name: "Refresh activity" });
  const openRunAction = activity.getByRole("button", { name: "Open run" });
  await expectTypedIconButton(refreshAction, "Refresh activity");
  await expectIconButtonTooltip(refreshAction, "Refresh activity");
  await expectTypedIconButton(openRunAction, "Open run");
  await expectIconButtonTooltip(openRunAction, "Open run");
  await openRunAction.focus();
  await expect(openRunAction).toBeFocused();
  await expectTypedIconButton(openRunAction, "Open run");
  await captureEvidence(page, "1440x960-ling-light-all-kinds.png");

  const search = activity.getByRole("searchbox", { name: "Search recent activity" });
  await search.fill("release");
  await expect(activity.locator("[data-activity-id]")).toHaveCount(3);
  await search.clear();
  await activity.getByRole("combobox", { name: "Activity type" }).selectOption("run");
  const runRow = activity.locator('[data-activity-id="run:run_activity_release"]');
  await expect(runRow).toBeVisible();
  await openRunAction.click();
  await expect(page.locator(".runs-panel")).toBeVisible();
  await expect(page.locator(".runs-panel")).toContainText("Release verification");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Recent activity localizes server hints in compact dark Chinese", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "zh-CN", reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createActivityState("活动系统审阅员");
  await mockDaemon(page, state);
  await routeActivity(page, () => ({ items: createFiveKindItems() }));
  await page.goto("/");

  const activity = await openActivity(page, "活动系统审阅员", true);
  await expect(activity).toContainText("AI 队友回复");
  await expect(activity).toContainText("在 #release 中被提及");
  await expect(activity.getByRole("combobox", { name: "活动类型" })).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-all-kinds-zh-CN.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Recent activity keeps authoritative rows when refresh fails", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createActivityState();
  let activitySurfaceOpen = false;
  let refreshShouldFail = false;
  const refreshGate = deferred<void>();
  await mockDaemon(page, state);
  await routeActivity(page, async (route) => {
    if (activitySurfaceOpen && refreshShouldFail) {
      await refreshGate.promise;
      await route.fulfill({ status: 503, json: { error: "activity_unavailable" } });
      return;
    }
    await route.fulfill({ json: { cwd, teammateId, items: createFiveKindItems().slice(0, 2) } });
  });
  await page.goto("/");

  const activity = await openActivity(page, teammateName, false, () => {
    activitySurfaceOpen = true;
  });
  await expect(activity.locator("[data-activity-id]")).toHaveCount(2);
  refreshShouldFail = true;
  const refreshAction = activity.getByRole("button", { name: "Refresh activity" });
  await refreshAction.click();
  await expect(refreshAction).toBeDisabled();
  await expect(refreshAction).toHaveAttribute("aria-busy", "true");
  await expectTypedIconButton(refreshAction, "Refresh activity");
  refreshGate.resolve();
  await expect(activity.locator("[data-activity-id]")).toHaveCount(2);
  await expect(activity.locator(".ling-ui-inline-feedback")).toContainText("Recent activity could not be loaded. Try again.");
  await captureEvidence(page, "1440x960-ling-dark-retained-error.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Recent activity separates no-result from an authoritative empty list", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1280, height: 800, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createActivityState();
  let returnEmpty = false;
  await mockDaemon(page, state);
  await routeActivity(page, () => ({ items: returnEmpty ? [] : createFiveKindItems() }));
  await page.goto("/");

  const activity = await openActivity(page);
  await activity.getByRole("searchbox", { name: "Search recent activity" }).fill("not-a-real-activity");
  await expect(activity.getByText("No activity matches these filters", { exact: true })).toBeVisible();
  await captureEvidence(page, "1280x800-ling-light-filter-no-result.png");
  const clearFilters = activity.getByRole("button", { name: "Clear filters" });
  await expect(clearFilters).not.toHaveAttribute("data-ling-icon-button-contract");
  await clearFilters.click();
  await expect(activity.locator("[data-activity-id]")).toHaveCount(5);

  returnEmpty = true;
  await activity.getByRole("button", { name: "Refresh activity" }).click();
  await expect(activity.getByText("No recent activity", { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Protected teammate keeps the exact 100-row recent boundary inside one scroll owner", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createActivityState("Ling Agent", "ling_agent");
  state.aiTeammates = [createMockTeammate({
    id: "ling_agent",
    displayName: "Ling Agent",
    kind: "system_teammate",
    systemRole: "ling_agent",
  })];
  const items = Array.from({ length: 100 }, (_, index) => activityItem({
    id: `task:activity_dense_${String(index).padStart(3, "0")}`,
    kind: "task",
    title: `Recent activity ${String(index).padStart(3, "0")} with a deliberately long identity for truncation`,
    subtitle: `A bounded activity summary for item ${index}`,
    status: index % 9 === 0 ? "blocked" : "done",
    sourceId: `activity_dense_${String(index).padStart(3, "0")}`,
    createdAt: new Date(Date.UTC(2026, 6, 21, 0, index)).toISOString(),
  }));
  let observedLimit = "";
  await mockDaemon(page, state);
  await routeActivity(page, (route) => {
    observedLimit = new URL(route.request().url()).searchParams.get("limit") ?? "";
    return { items };
  });
  await page.goto("/");

  const activity = await openActivity(page, "Ling Agent");
  const list = activity.locator("[data-ui2-teammate-activity-list]");
  await expect(list.locator("[data-activity-id]")).toHaveCount(100);
  expect(observedLimit).toBe("100");
  const scrollState = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));
  expect(["auto", "scroll"]).toContain(scrollState.overflowY);
  expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
  await captureEvidence(page, "1440x960-ling-light-protected-100-row-scroll.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("A delayed activity response cannot cross a teammate switch", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1280, height: 800, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const secondId = "teammate_activity_target";
  const secondName = "Current Activity Reviewer";
  const state = createActivityState();
  state.aiTeammates = [
    createMockTeammate({ id: teammateId, displayName: teammateName }),
    createMockTeammate({ id: secondId, displayName: secondName }),
  ];
  const oldGate = deferred<void>();
  let blockOldActivitySurface = false;
  await mockDaemon(page, state);
  await routeActivity(page, async (route, requestedTeammateId) => {
    if (requestedTeammateId === teammateId && blockOldActivitySurface) await oldGate.promise;
    const current = requestedTeammateId === secondId
      ? [activityItem({ id: "task:current_activity", kind: "task", title: "Current teammate activity", sourceId: "current_activity" })]
      : [activityItem({ id: "task:old_activity", kind: "task", title: "Old teammate activity", sourceId: "old_activity" })];
    await route.fulfill({ json: { cwd, teammateId: requestedTeammateId, items: current } });
  });
  await page.goto("/");

  const activity = await openActivity(page, teammateName, false, () => {
    blockOldActivitySurface = true;
  });
  await expect(activity.getByLabel("Loading recent activity")).toBeVisible();
  const currentActivity = await openActivity(page, secondName);
  await expect(currentActivity.getByText("Current teammate activity", { exact: true })).toBeVisible();
  oldGate.resolve();
  await expect(currentActivity.getByText("Old teammate activity", { exact: true })).toHaveCount(0);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function createActivityState(displayName: string = teammateName, id: string = teammateId): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id, displayName })];
  return state;
}

function createFiveKindItems(): Record<string, unknown>[] {
  return [
    activityItem({ id: "direct-message:source_activity_message", kind: "direct-message", title: "AI teammate replied", subtitle: "A private update is ready.", status: "ready", sourceId: "source_activity_message", createdAt: "2026-07-21T00:05:00.000Z" }),
    activityItem({ id: "task:task_activity_release", kind: "task", title: "Prepare release checklist", subtitle: "Verify the deployment gates.", status: "review", sourceId: "task_activity_release", createdAt: "2026-07-21T00:04:00.000Z" }),
    activityItem({ id: "run:run_activity_release", kind: "run", title: "Release verification", subtitle: "gpt-5.5", status: "running", sourceId: "run_activity_release", createdAt: "2026-07-21T00:03:00.000Z" }),
    activityItem({ id: "approval:approval_activity_release", kind: "approval", title: "Approve production access", subtitle: "Run requires authorization.", status: "pending", sourceId: "approval_activity_release", createdAt: "2026-07-21T00:02:00.000Z" }),
    activityItem({ id: "channel-message:channel_activity_release", kind: "channel-message", title: "Mentioned in #release", subtitle: "Please review the launch status.", status: "ready", sourceId: "channel_activity_release", createdAt: "2026-07-21T00:01:00.000Z" }),
  ];
}

function activityItem(input: {
  readonly id: string;
  readonly kind: "direct-message" | "task" | "run" | "approval" | "channel-message";
  readonly title: string;
  readonly subtitle?: string;
  readonly status?: string;
  readonly sourceId: string;
  readonly createdAt?: string;
}): Record<string, unknown> {
  return {
    ...input,
    createdAt: input.createdAt ?? "2026-07-21T00:00:00.000Z",
  };
}

async function routeActivity(
  page: Page,
  handler: ((route: Route, teammateId: string) => Promise<void>) | ((route: Route, teammateId: string) => { readonly items: readonly Record<string, unknown>[] }),
): Promise<void> {
  await page.route(/\/teammates\/([^/]+)\/activity(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const match = /\/teammates\/([^/]+)\/activity$/u.exec(new URL(route.request().url()).pathname);
    const requestedTeammateId = match ? decodeURIComponent(match[1]) : "";
    const result = await handler(route, requestedTeammateId);
    if (result) await route.fulfill({ json: { cwd, teammateId: requestedTeammateId, items: result.items } });
  });
}

async function openActivity(
  page: Page,
  targetTeammateName: string = teammateName,
  chinese = false,
  beforeActivityOpen?: () => void,
): Promise<Locator> {
  const navigation = page.getByLabel("Ling Stack navigation");
  await navigation.getByRole("button", { name: targetTeammateName }).click();
  const header = page.locator("[data-ui2-teammate-chat-header]");
  await expect(header).toBeVisible();
  const dockLabel = chinese ? "私聊工作区面板" : "Private chat workspace dock";
  if (await page.getByLabel(dockLabel).count() === 0) {
    await header.getByRole("button", { name: chinese ? "显示详情" : "Show details" }).click();
  }
  await page.getByLabel(dockLabel).getByRole("button", { name: chinese ? "设置" : "Settings" }).click();
  const settings = page.getByLabel(chinese ? "设置分组" : "Settings sections");
  const activityNavigation = settings.getByRole("button", { name: chinese ? /^动态(?:\s|$)/u : /^Activity(?:\s|$)/u });
  await expect(activityNavigation).toBeVisible();
  beforeActivityOpen?.();
  await activityNavigation.click();
  const activity = page.locator("[data-ui2-teammate-activity]");
  await expect(activity).toBeVisible();
  return activity;
}

async function prepareSurface(
  page: Page,
  options: {
    readonly theme: "dark" | "light";
    readonly width: number;
    readonly height: number;
    readonly locale: "en-US" | "zh-CN";
    readonly reducedMotion?: "no-preference" | "reduce";
  },
): Promise<void> {
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.emulateMedia({ colorScheme: options.theme, reducedMotion: options.reducedMotion ?? "no-preference" });
  await page.addInitScript(({ locale, theme }) => {
    const themeId = `ling-${theme}`;
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { locale: options.locale, theme: options.theme });
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

async function expectTypedIconButton(button: Locator, label: string): Promise<void> {
  await expect(button).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await expect(button).toHaveAttribute("data-icon-only", "true");
  await expect(button).toHaveAttribute("aria-label", label);
  await expect(button).toHaveAttribute("title", label);
  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
}

async function expectIconButtonTooltip(button: Locator, label: string): Promise<void> {
  const page = button.page();
  await button.hover();
  await expect(page.getByRole("tooltip", { name: label, exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip", { name: label, exact: true })).toHaveCount(0);
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value?: T | PromiseLike<T>) => void;
} {
  let resolve: (value?: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
