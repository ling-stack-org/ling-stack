import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  resourceLeaseStatusPresentation,
  runtimeSemaphoreStatusPresentation,
  workUnitStatusPresentation,
} from "../src/features/workspace/runtime-status-view-models.js";
import type { ResourceLease, WorkUnit } from "../src/types.js";
import {
  createMockRuntime,
  mockDaemon,
  type MockState,
  type MockWorkUnit,
} from "./support/mock-daemon";
import { createBaseState, cwd } from "./support/mock-state";

const panelSourcePath = fileURLToPath(new URL("../src/features/workspace/RuntimeDiagnosticsPanel.tsx", import.meta.url));
const focusedCssPath = fileURLToPath(new URL("../src/styles/channel-runtime-diagnostics.css", import.meta.url));

const workUnitMatrix = [
  ["queued", "Queued", "info"],
  ["claimed", "Claimed", "info"],
  ["running", "Running", "info"],
  ["waiting_for_approval", "Waiting for approval", "warning"],
  ["cancelling", "Cancelling", "warning"],
  ["succeeded", "Succeeded", "success"],
  ["failed", "Failed", "danger"],
  ["cancelled", "Cancelled", "neutral"],
  ["stale", "Stale", "warning"],
] as const satisfies ReadonlyArray<readonly [WorkUnit["status"], string, string]>;

const resourceMatrix = [
  ["active", "Active", "success"],
  ["released", "Completed", "neutral"],
  ["expired", "Expired", "warning"],
] as const satisfies ReadonlyArray<readonly [ResourceLease["status"], string, string]>;

test("Runtime diagnostics freezes all status semantics and public CSS ownership", () => {
  expect(workUnitMatrix.map(([status]) => workUnitStatusPresentation(status))).toEqual(
    workUnitMatrix.map(([, labelKey, tone]) => ({ labelKey, tone })),
  );
  expect(resourceMatrix.map(([status]) => resourceLeaseStatusPresentation(status))).toEqual(
    resourceMatrix.map(([, labelKey, tone]) => ({ labelKey, tone })),
  );
  expect(resourceMatrix.map(([status]) => runtimeSemaphoreStatusPresentation(status))).toEqual(
    resourceMatrix.map(([, labelKey, tone]) => ({ labelKey, tone })),
  );

  const panelSource = readFileSync(panelSourcePath, "utf8");
  const focusedCss = readFileSync(focusedCssPath, "utf8");
  expect(panelSource).not.toContain("StatusBadge");
  expect(focusedCss).not.toMatch(/\.ling-ui-/u);
  expect(focusedCss).not.toContain(".status-badge");
  expect(focusedCss).not.toMatch(/\.runtime-diagnostics-panel\s+\*/u);
  expect(focusedCss).not.toContain("!important");
});

test("Ling Light renders every reachable runtime status and preserves cancel, retry, and reconcile", async ({ page }, testInfo) => {
  await prepareSurface(page, { height: 960, locale: "en-US", theme: "light", width: 1440 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createRuntimeStatusState();
  state.workUnitActionDelayMs = 450;
  await installRuntimeFixture(page, state);
  await page.goto("/");

  const panel = await openRuntimeDiagnostics(page);
  for (const [status, label, tone] of workUnitMatrix.filter(([status]) => status !== "cancelled")) {
    const row = workUnitRow(panel, workUnitId(status));
    await expectRuntimeStatus(row, label, tone);
  }
  await expectResourceStates(panel, "lease", resourceMatrix);
  await expectResourceStates(panel, "semaphore", resourceMatrix);
  await expectSupervisorMetaRowsContained(panel);
  await expect(panel.locator(".runtime-diagnostics-status")).toHaveCount(14);
  await expect(panel.locator(".status-badge")).toHaveCount(0);
  await captureRuntimeEvidence(page, testInfo.outputPath("1440x960-ling-light-runtime-diagnostics.png"));

  const actionButtons = panel.locator(".runtime-diagnostics-actions button");
  const actionBoxes = await actionButtons.evaluateAll((buttons) => buttons.map((button) => {
    const box = button.getBoundingClientRect();
    return { height: box.height, width: box.width };
  }));
  expect(actionBoxes.length).toBeGreaterThan(0);
  expect(actionBoxes.every(({ height, width }) => height >= 32 && width >= 32)).toBe(true);

  const staleRow = workUnitRow(panel, workUnitId("stale"));
  const staleActions = staleRow.locator(".runtime-diagnostics-actions button");
  await staleRow.getByRole("button", { name: "Reconcile" }).click();
  await expect(staleRow).toHaveAttribute("aria-busy", "true");
  for (let index = 0; index < await staleActions.count(); index += 1) {
    await expect(staleActions.nth(index)).toBeDisabled();
  }
  await expect(staleRow).not.toHaveAttribute("aria-busy", "true");

  const failedRow = workUnitRow(panel, workUnitId("failed"));
  await failedRow.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => state.workUnits.find((unit) => unit.id === workUnitId("failed"))?.status).toBe("queued");
  await expect(failedRow).not.toHaveAttribute("aria-busy", "true");

  const queuedRow = workUnitRow(panel, workUnitId("queued"));
  await queuedRow.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(() => state.workUnits.find((unit) => unit.id === workUnitId("queued"))?.status).toBe("cancelled");

  const longRow = workUnitRow(panel, workUnitId("stale"));
  await expectNoHorizontalOverflow(longRow);
  await expectNoHorizontalOverflow(panel);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Ling Dark renders productized Chinese status labels with long content contained", async ({ page }, testInfo) => {
  await prepareSurface(page, { height: 800, locale: "zh-CN", reducedMotion: true, theme: "dark", width: 1280 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createRuntimeStatusState();
  await installRuntimeFixture(page, state);
  await page.goto("/");

  const panel = await openRuntimeDiagnostics(page, "运行态");
  const expectedChinese = [
    ["queued", "已排队", "info"],
    ["claimed", "已认领", "info"],
    ["running", "运行中", "info"],
    ["waiting_for_approval", "等待审批", "warning"],
    ["cancelling", "正在取消", "warning"],
    ["succeeded", "成功", "success"],
    ["failed", "失败", "danger"],
    ["stale", "已过期", "warning"],
  ] as const;
  for (const [status, label, tone] of expectedChinese) {
    await expectRuntimeStatus(workUnitRow(panel, workUnitId(status)), label, tone);
  }

  await expectRuntimeStatus(resourceRow(panel, "lease", "active"), "进行中", "success");
  await expectRuntimeStatus(resourceRow(panel, "lease", "released"), "已完成", "neutral");
  await expectRuntimeStatus(resourceRow(panel, "lease", "expired"), "已过期", "warning");
  await expectRuntimeStatus(resourceRow(panel, "semaphore", "active"), "进行中", "success");
  await expectRuntimeStatus(resourceRow(panel, "semaphore", "released"), "已完成", "neutral");
  await expectRuntimeStatus(resourceRow(panel, "semaphore", "expired"), "已过期", "warning");
  await expectSupervisorMetaRowsContained(panel);
  await captureRuntimeEvidence(page, testInfo.outputPath("1280x800-ling-dark-runtime-diagnostics.png"));
  const statusTexts = await panel.locator(".runtime-diagnostics-status").allTextContents();
  expect(statusTexts.every((text) => !/queued|claimed|waiting_for_approval|released/iu.test(text))).toBe(true);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectNoHorizontalOverflow(panel);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Runtime diagnostics keeps unavailable and empty states explicit", async ({ page }) => {
  await prepareSurface(page, { height: 800, locale: "en-US", theme: "light", width: 1280 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.workUnits = [];
  state.resourceLeases = [];
  state.runtimeSemaphoreSlots = [];
  await mockDaemon(page, state);
  await page.route(/\/runtime\/supervisor(?:\?.*)?$/u, async (route) => {
    await route.fulfill({ status: 503, json: { error: "runtime_unavailable" } });
  });
  await page.goto("/");

  const panel = await openRuntimeDiagnostics(page);
  await expect(panel.getByText("Runtime diagnostics are unavailable.")).toBeVisible();
  await expect(panel.getByText("No work units recorded")).toBeVisible();
  await expect(panel.getByText("No held leases")).toBeVisible();
  await expect(panel.getByText("No semaphore slots")).toBeVisible();
  await expect(panel.locator(".runtime-diagnostics-status")).toHaveCount(0);
  await expectNoHorizontalOverflow(panel);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function createRuntimeStatusState(): MockState {
  const state = createBaseState({ approvalStatus: "pending" });
  state.workUnits = workUnitMatrix
    .filter(([status]) => status !== "cancelled")
    .map(([status], index) => createRuntimeWorkUnit(status, index));
  state.resourceLeases = resourceMatrix.map(([status], index) => ({
    id: `lease_${status}`,
    workspaceId: "workspace_default",
    resourceType: status === "active" ? "bound_path" : "external_workspace",
    resourceKey: `${cwd}/${"long-runtime-resource-segment/".repeat(index + 3)}${status}`,
    ownerType: "work_unit_attempt",
    ownerId: `lease_owner_${status}`,
    workUnitId: `lease_work_unit_${status}`,
    attemptId: `lease_attempt_${status}`,
    status,
    acquiredAt: "2026-07-24T00:00:00.000Z",
    lastRenewedAt: "2026-07-24T00:01:00.000Z",
    expiresAt: "2026-07-24T01:00:00.000Z",
  }));
  state.runtimeSemaphoreSlots = resourceMatrix.map(([status], index) => ({
    id: `semaphore_${status}`,
    workspaceId: "workspace_default",
    resourceType: status === "active" ? "provider" : "media_provider",
    resourceKey: `${"long-semaphore-key-".repeat(index + 4)}${status}`,
    ownerType: "work_unit_attempt",
    ownerId: `semaphore_owner_${status}`,
    workUnitId: `semaphore_work_unit_${status}`,
    attemptId: `semaphore_attempt_${status}`,
    status,
    acquiredAt: "2026-07-24T00:00:00.000Z",
    lastRenewedAt: "2026-07-24T00:01:00.000Z",
    expiresAt: "2026-07-24T01:00:00.000Z",
  }));
  return state;
}

function createRuntimeWorkUnit(status: WorkUnit["status"], index: number): MockWorkUnit {
  const id = workUnitId(status);
  return {
    id,
    workspaceId: "workspace_default",
    kind: index % 2 === 0 ? "task_run" : "channel_ai_reply",
    ownerType: "channel",
    ownerId: `${"long-runtime-owner-".repeat(5)}${status}`,
    channelId: "channel_engineering",
    providerPresetId: "provider_local",
    runnerId: "pi-coding-agent",
    idempotencyKey: `runtime-status-${status}`,
    status,
    priority: 0,
    attemptCount: 1,
    activeAttemptId: `attempt_${status}`,
    createdByActor: "system",
    request: { body: `Runtime ${status}` },
    timeoutPolicy: {
      cancelGraceMs: 15_000,
      hardTimeoutMs: 3_600_000,
      heartbeatIntervalMs: 10_000,
      heartbeatTimeoutMs: 45_000,
      idleTimeoutMs: 600_000,
    },
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: `2026-07-24T00:${String(10 + index).padStart(2, "0")}:00.000Z`,
    lastEventAt: "2026-07-24T00:10:00.000Z",
    lastHeartbeatAt: "2026-07-24T00:10:00.000Z",
    ...(status === "running" ? { errorCode: "runtime_stuck" } : {}),
    ...(status === "failed" || status === "stale"
      ? { errorMessage: `Runtime failure ${"without-break-boundary-".repeat(18)}${status}` }
      : {}),
  };
}

function workUnitId(status: WorkUnit["status"]): string {
  return status === "stale"
    ? `work_unit_${"stale-long-identifier-".repeat(12)}stale`
    : `work_unit_${status}`;
}

async function installRuntimeFixture(page: Page, state: MockState): Promise<void> {
  await mockDaemon(page, state);
  await page.route(/\/runtime\/supervisor(?:\?.*)?$/u, async (route) => {
    const workUnits = state.workUnits as WorkUnit[];
    await route.fulfill({
      json: {
        cwd,
        runtime: createMockRuntime(),
        active: workUnits.filter((unit) => ["claimed", "running", "waiting_for_approval", "cancelling"].includes(unit.status)),
        stuck: workUnits.filter((unit) => unit.errorCode === "runtime_stuck"),
        queued: workUnits.filter((unit) => unit.status === "queued"),
        stale: workUnits.filter((unit) => unit.status === "stale"),
        leases: state.resourceLeases,
        semaphoreSlots: state.runtimeSemaphoreSlots,
      },
    });
  });
}

async function openRuntimeDiagnostics(page: Page, modeName = "Runtime"): Promise<Locator> {
  await openChannelContextPanelLocalized(page);
  const modes = page.getByLabel(/Channel inspector modes|频道检查器模式/u);
  if (!await modes.isVisible().catch(() => false)) {
    await page.getByLabel(/Channel workspace dock|频道工作区面板/u).getByRole("button", { name: /Activity|动态/u }).click();
  }
  await modes.getByRole("button", { name: modeName, exact: true }).click();
  const panel = page.getByLabel(/Runtime diagnostics|运行诊断/u);
  await expect(panel).toBeVisible();
  return panel;
}

async function openChannelContextPanelLocalized(page: Page): Promise<void> {
  const channelFeed = page.getByLabel(/Channel message feed|频道消息列表/u);
  if (!await channelFeed.isVisible().catch(() => false)) {
    await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u })
      .getByRole("button", { name: "Engineering", exact: true })
      .click();
    await expect(channelFeed).toBeVisible();
  }

  const panel = page.locator(".channel-side-panel");
  if (await panel.isVisible().catch(() => false)) return;

  const moreViews = page.getByRole("button", { name: /More channel views|更多频道视图/u });
  if (await moreViews.isVisible().catch(() => false)) {
    await moreViews.click();
    const context = page.getByRole("menuitem", { name: /Context|上下文/u });
    if (await context.isVisible().catch(() => false)) {
      await context.click();
      await expect(panel).toBeVisible();
      return;
    }
  }

  const showDetails = page.getByRole("button", { name: /Show details|显示详情/u });
  if (await showDetails.isVisible().catch(() => false)) {
    await showDetails.click();
    await expect(panel).toBeVisible();
    return;
  }

  const openContext = page.getByRole("button", { name: /Open context|打开上下文/u }).first();
  await expect(openContext).toBeVisible();
  await openContext.click();
  await expect(panel).toBeVisible();
}

function workUnitRow(panel: Locator, id: string): Locator {
  return panel.locator(".runtime-work-unit-row").filter({ hasText: id });
}

function resourceRow(panel: Locator, kind: "lease" | "semaphore", status: ResourceLease["status"]): Locator {
  return panel.locator(".runtime-resource-row").filter({ hasText: `${kind}_work_unit_${status}` });
}

async function expectResourceStates(
  panel: Locator,
  kind: "lease" | "semaphore",
  matrix: ReadonlyArray<readonly [ResourceLease["status"], string, string]>,
): Promise<void> {
  for (const [status, label, tone] of matrix) {
    await expectRuntimeStatus(resourceRow(panel, kind, status), label, tone);
  }
}

async function expectRuntimeStatus(scope: Locator, label: string, tone: string): Promise<void> {
  const status = scope.locator(".runtime-diagnostics-status");
  await expect(status).toHaveCount(1);
  await expect(status).toHaveAttribute("data-tone", tone);
  await expect(status).toHaveText(label);
  await expect(status).not.toContainText(/_/u);
}

async function expectSupervisorMetaRowsContained(panel: Locator): Promise<void> {
  const rows = panel.locator(".runtime-supervisor-meta > .meta-row:visible");
  await expect(rows).toHaveCount(4);
  const geometry = await rows.evaluateAll((elements) => elements.map((element) => {
    const label = element.querySelector(":scope > span");
    const value = element.querySelector(":scope > strong");
    if (!(label instanceof HTMLElement) || !(value instanceof HTMLElement)) return undefined;
    const rowBox = element.getBoundingClientRect();
    const labelBox = label.getBoundingClientRect();
    const valueBox = value.getBoundingClientRect();
    return {
      contained:
        labelBox.left >= rowBox.left
        && labelBox.right <= rowBox.right + 1
        && valueBox.left >= rowBox.left
        && valueBox.right <= rowBox.right + 1,
      gap: valueBox.top - labelBox.bottom,
      overflow: element.scrollWidth - element.clientWidth,
    };
  }));
  expect(geometry.every((row) => row !== undefined && row.contained && row.gap >= 2 && row.overflow <= 1)).toBe(true);
}

async function captureRuntimeEvidence(page: Page, path: string): Promise<void> {
  if (process.env.LING_CAPTURE_RUNTIME_DIAGNOSTICS !== "1") return;
  await page.screenshot({ animations: "disabled", path });
}

async function prepareSurface(
  page: Page,
  options: {
    readonly height: number;
    readonly locale: "en-US" | "zh-CN";
    readonly reducedMotion?: boolean;
    readonly theme: "dark" | "light";
    readonly width: number;
  },
): Promise<void> {
  await page.setViewportSize({ height: options.height, width: options.width });
  await page.emulateMedia({
    colorScheme: options.theme,
    reducedMotion: options.reducedMotion ? "reduce" : "no-preference",
  });
  await page.addInitScript(({ locale, theme }) => {
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { locale: options.locale, theme: options.theme });
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const overflow = await locator.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
