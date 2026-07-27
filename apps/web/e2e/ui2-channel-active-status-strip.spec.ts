import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  channelActiveStatusPresentation,
  type ChannelActiveStatusInput,
} from "../src/features/workspace/channel-active-status-presentation";
import type { RunStatus } from "../src/types";
import { mockDaemon, type MockApproval, type MockState } from "./support/mock-daemon";
import { createBaseState, createChatProvider, isRecord } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

test("channel active status keeps the typed product label and tone matrix", async () => {
  const cases: ReadonlyArray<readonly [ChannelActiveStatusInput, string, string]> = [
    [{ kind: "run", status: "queued" }, "Queued", "info"],
    [{ kind: "run", status: "running" }, "Running", "info"],
    [{ kind: "run", status: "waiting_for_approval" }, "Waiting for approval", "warning"],
    [{ kind: "run", status: "succeeded" }, "Succeeded", "success"],
    [{ kind: "run", status: "failed" }, "Failed", "danger"],
    [{ kind: "run", status: "cancelled" }, "Cancelled", "neutral"],
    [{ kind: "pending-approval" }, "Waiting for approval", "warning"],
    [{ kind: "provider-blocked" }, "Blocked", "warning"],
  ];

  expect(cases.map(([input]) => channelActiveStatusPresentation(input))).toEqual(
    cases.map(([, labelKey, tone]) => ({ labelKey, tone })),
  );
  for (const [, label] of cases) expect(label).not.toContain("_");

  const clientSource = await readFile(new URL("../src/features/workspace/WorkspaceClientView.tsx", import.meta.url), "utf8");
  const componentSource = await readFile(new URL("../src/features/workspace/ChannelActiveStatusIndicator.tsx", import.meta.url), "utf8");
  const presentationSource = await readFile(new URL("../src/features/workspace/channel-active-status-presentation.ts", import.meta.url), "utf8");
  expect(clientSource).not.toContain("StatusBadge");
  expect(clientSource.match(/<ChannelActiveStatusIndicator/gu)).toHaveLength(3);
  expect(componentSource).toContain('import { StatusIndicator } from "../../shared/ui/index.js";');
  expect(componentSource).not.toContain("querySelector");
  expect(presentationSource).not.toContain("useI18n");
  expect(presentationSource).not.toContain("JSX");
});

test("queued active run keeps Open run behavior in light mode", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = activeRunState("queued", true);
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const strip = await expectStatusStrip(page, {
    kind: "run",
    label: "Queued",
    tone: "info",
    actionCount: 2,
  });
  await expect(strip).toContainText("Channel active status presentation remains contained across a deliberately long task title");
  await strip.getByRole("button", { name: "Open run" }).click();
  await expect(page.locator("article.task-detail")).toContainText("Channel active status presentation remains contained");
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("running active run keeps Stop behavior in dark mode", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = activeRunState("running", true);
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const strip = await expectStatusStrip(page, {
    kind: "run",
    label: "Running",
    tone: "info",
    actionCount: 2,
  });
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await strip.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => state.runs.find((run) => run.id === "run_failed")?.status).toBe("cancelled");
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("waiting active run renders a product label without snake_case", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = activeRunState("waiting_for_approval", false);
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const strip = await expectStatusStrip(page, {
    kind: "run",
    label: "Waiting for approval",
    tone: "warning",
    actionCount: 2,
  });
  await expect(strip).not.toContainText("waiting_for_approval");
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("pending approval keeps its detail action in dark mode", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = pendingApprovalState();
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const strip = await expectStatusStrip(page, {
    kind: "pending-approval",
    label: "Waiting for approval",
    tone: "warning",
    actionCount: 1,
  });
  await expect(strip).toContainText("Review the long provider change request before applying it to the current channel workspace");
  await strip.getByRole("button", { name: "Open approval" }).click();
  const detail = page.locator(".conversation-detail-overlay");
  await expect(detail).toHaveAttribute("aria-label", "Approval details");
  await expect(detail).toContainText("Review the long provider change request");
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("provider blocker keeps Settings behavior with a long description", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = providerBlockedState();
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  const strip = await expectStatusStrip(page, {
    kind: "provider-blocked",
    label: "Blocked",
    tone: "warning",
    actionCount: 1,
  });
  await expect(strip).toContainText("Long disabled provider route used to verify that the channel status description remains contained");
  await strip.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("[data-ui2-channel-settings='true']")).toBeVisible();
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function activeRunState(status: Extract<RunStatus, "queued" | "running" | "waiting_for_approval">, includeTask: boolean): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  const providerId = "provider_channel_active_status";
  state.providers = [readyProvider(providerId)];
  state.channels = state.channels.map((channel) => isRecord(channel)
    ? { ...channel, defaultProviderPresetId: providerId }
    : channel);
  state.approvals = [];
  const run = state.runs[0];
  run.status = status;
  run.errorMessage = undefined;
  run.startedAt = status === "queued" ? undefined : "2026-07-26T01:00:00.000Z";
  run.updatedAt = "2026-07-26T01:01:00.000Z";
  if (includeTask) {
    const title = "Channel active status presentation remains contained across a deliberately long task title with several descriptive words";
    run.taskSnapshot = { id: run.taskId, title };
    state.tasks = state.tasks.map((task) => isRecord(task) && task.id === run.taskId
      ? { ...task, title, status, currentRunId: run.id, updatedAt: run.updatedAt }
      : task);
  } else {
    state.tasks = [];
  }
  return state;
}

function pendingApprovalState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  const providerId = "provider_channel_pending_approval";
  state.providers = [readyProvider(providerId)];
  state.channels = state.channels.map((channel) => isRecord(channel)
    ? { ...channel, defaultProviderPresetId: providerId }
    : channel);
  const approval: MockApproval = {
    id: "approval_channel_active_status",
    channelId: "channel_engineering",
    actionType: "provider_change",
    risk: "medium",
    title: "Review the long provider change request before applying it to the current channel workspace",
    description: "Confirm the provider route selected for subsequent channel work.",
    payload: { type: "provider_change", providerPresetId: providerId },
    status: "pending",
    createdAt: "2026-07-26T01:10:00.000Z",
    expiresAt: "2099-07-26T01:15:00.000Z",
  };
  state.approvals = [approval];
  return state;
}

function providerBlockedState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  const providerId = "provider_channel_blocked";
  state.approvals = [];
  state.providers = [createChatProvider({
    id: providerId,
    displayName: "Long disabled provider route used to verify that the channel status description remains contained",
    enabled: false,
  })];
  state.channels = state.channels.map((channel) => isRecord(channel)
    ? { ...channel, defaultProviderPresetId: providerId }
    : channel);
  return state;
}

function readyProvider(id: string): Record<string, unknown> {
  return createChatProvider({
    id,
    lastCheck: {
      ok: true,
      code: "ready",
      message: "Provider is reachable.",
      checkedAt: "2026-07-26T01:00:00.000Z",
    },
  });
}

async function expectStatusStrip(
  page: Page,
  expected: {
    readonly kind: "run" | "pending-approval" | "provider-blocked";
    readonly label: string;
    readonly tone: string;
    readonly actionCount: number;
  },
): Promise<Locator> {
  const strip = page.locator(".channel-active-status-strip");
  await expect(strip).toBeVisible();
  const indicator = strip.locator(".channel-active-status-indicator");
  await expect(indicator).toHaveCount(1);
  await expect(indicator).toHaveAttribute("data-channel-active-status", expected.kind);
  await expect(indicator).toHaveAttribute("data-tone", expected.tone);
  await expect(indicator).toHaveText(expected.label);
  await expect(indicator).not.toContainText("_");
  await expect(strip.locator(".status-badge")).toHaveCount(0);

  const actions = strip.getByRole("button");
  await expect(actions).toHaveCount(expected.actionCount);
  for (let index = 0; index < expected.actionCount; index += 1) {
    await expectMinimumHitArea(actions.nth(index), 32);
  }
  await expectContained(strip, page.getByLabel("Channel composer"));
  return strip;
}

async function prepareSurface(page: Page, theme: "light" | "dark", width: number, height: number): Promise<void> {
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

async function expectMinimumHitArea(locator: Locator, size: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(size);
  expect(box!.height).toBeGreaterThanOrEqual(size);
}

async function expectContained(child: Locator, owner: Locator): Promise<void> {
  const childBox = await child.boundingBox();
  const ownerBox = await owner.boundingBox();
  expect(childBox).not.toBeNull();
  expect(ownerBox).not.toBeNull();
  expect(childBox!.x).toBeGreaterThanOrEqual(ownerBox!.x - 1);
  expect(childBox!.y).toBeGreaterThanOrEqual(ownerBox!.y - 1);
  expect(childBox!.x + childBox!.width).toBeLessThanOrEqual(ownerBox!.x + ownerBox!.width + 1);
  expect(childBox!.y + childBox!.height).toBeLessThanOrEqual(ownerBox!.y + ownerBox!.height + 1);
  expect(await child.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(`console:${message.text()}`);
    }
  });
  return errors;
}
