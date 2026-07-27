import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd, isRecord, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/council-channels/",
  import.meta.url,
));

test("attach, prefer, detach, and open channel preserve exact policy payloads", async ({ page }) => {
  await prepareSurface(page, { height: 960, locale: "en-US", theme: "light", width: 1440 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createChannelsState();
  const directMemberships = [...state.teammateChannelMemberships];
  const control = createPolicyRouteControl();
  await mockDaemon(page, state);
  await installPolicyRouteOverlay(page, control);
  await page.goto("/");

  let panel = await openCouncilChannels(page);
  await expect(panel.getByText("No AI councils attached", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Attach selected council" }).click();
  await expect.poll(() => control.putBodies.length).toBe(1);
  expect(control.putBodies[0]).toEqual({
    channelId: "channel_engineering",
    payload: { attachedCouncilIds: ["council_alpha"], preferredCouncilId: "council_alpha" },
  });
  await expect(councilRow(panel, "council_alpha")).toContainText("Preferred");

  const surface = page.locator("[data-settings-workspace-tool='councils']");
  await surface.locator(".council-list-health-row").filter({ hasText: "Built-in Review Council" }).click();
  panel = await openCouncilChannelsTab(surface);
  await panel.getByRole("button", { name: "Attach selected council" }).click();
  await expect.poll(() => control.putBodies.length).toBe(2);
  expect(control.putBodies[1]).toEqual({
    channelId: "channel_engineering",
    payload: {
      attachedCouncilIds: ["council_alpha", "council_builtin_review"],
      preferredCouncilId: "council_alpha",
    },
  });
  const builtIn = councilRow(panel, "council_builtin_review");
  await expect(builtIn).toContainText("Built-in");

  control.putDelayMs = 260;
  await builtIn.getByRole("button", { name: "Prefer" }).click();
  await expect(builtIn.getByRole("button", { name: "Prefer" })).toHaveAttribute("aria-busy", "true");
  await expect(councilRow(panel, "council_alpha").getByRole("button", { name: "Detach council" })).toBeEnabled();
  await expect.poll(() => control.putBodies.length).toBe(3);
  expect(control.putBodies[2]).toEqual({
    channelId: "channel_engineering",
    payload: {
      attachedCouncilIds: ["council_alpha", "council_builtin_review"],
      preferredCouncilId: "council_builtin_review",
    },
  });
  await expect(builtIn).toContainText("Preferred");
  await captureEvidence(page, "1440x960-ling-light-attached-managed-preferred.png");

  control.putDelayMs = 260;
  const detach = builtIn.getByRole("button", { name: "Detach council" });
  await expectTypedIconAction(page, detach, "Detach council");
  await detach.focus();
  await expect(detach).toBeFocused();
  await detach.click();
  await expect(detach).toHaveAttribute("aria-busy", "true");
  await expect(detach).toBeDisabled();
  await expect.poll(() => control.putBodies.length).toBe(4);
  expect(control.putBodies[3]).toEqual({
    channelId: "channel_engineering",
    payload: { attachedCouncilIds: ["council_alpha"], preferredCouncilId: "council_alpha" },
  });
  await expect(builtIn).toHaveCount(0);
  expect(state.teammateChannelMemberships).toEqual(directMemberships);

  await panel.getByRole("button", { name: "Open channel in app" }).click();
  await expect(page.getByLabel("Channel message feed")).toBeVisible();
  await expect(page.getByLabel("Settings sections")).toHaveCount(0);
  await expectNoOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("paused and archived channels expose removal-only truth in Chinese reduced motion", async ({ page }) => {
  await prepareSurface(page, { height: 800, locale: "zh-CN", reducedMotion: "reduce", theme: "dark", width: 1280 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createChannelsState();
  state.aiCouncils = [
    councilFixture("council_alpha", "主审智囊团", "user", true),
    councilFixture("council_beta", "辅助审阅智囊团（用于验证较长名称）", "user"),
    councilFixture("council_gamma", "待接入智囊团", "user"),
  ];
  state.channelCouncilPolicies = [
    policyFixture("channel_paused", ["council_alpha", "council_beta", "council_unavailable"], "council_alpha"),
    policyFixture("channel_archived", ["council_alpha", "council_beta", "council_unavailable"], "council_alpha"),
  ];
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  await surface.locator(".council-list-health-row").filter({ hasText: "待接入智囊团" }).click();
  const panel = await openCouncilChannelsTab(surface);
  const select = panel.getByRole("combobox", { name: /为智囊团选择频道|Select channel for council/ });
  await select.selectOption("channel_paused");
  await expect(panel).toContainText("已暂停频道只允许解除现有关系。");
  await expect(councilRow(panel, "council_beta").getByRole("button", { name: "设为首选" })).toBeDisabled();
  await expect(councilRow(panel, "council_alpha").getByRole("button", { name: "移除智囊团" })).toBeEnabled();
  const unavailable = councilRow(panel, "council_unavailable");
  await expect(unavailable).toContainText("不可用");
  await expect(unavailable.getByRole("button", { name: "设为首选" })).toHaveCount(0);
  await expect(unavailable.getByRole("button", { name: "移除智囊团" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "接入选中智囊团" })).toBeDisabled();

  await select.selectOption("channel_archived");
  await expect(panel).toContainText("已归档频道只允许解除现有关系。");
  await expect(panel.getByRole("button", { name: "在主应用打开频道" })).toBeDisabled();
  await expect(councilRow(panel, "council_alpha").getByRole("button", { name: "移除智囊团" })).toBeEnabled();

  await select.focus();
  const focusGeometry = await select.evaluate((nativeSelect) => {
    const shell = nativeSelect.closest(".ling-ui-select");
    const inputBox = nativeSelect.getBoundingClientRect();
    const shellBox = shell?.getBoundingClientRect();
    return shellBox ? {
      bottom: inputBox.bottom - shellBox.bottom,
      left: shellBox.left - inputBox.left,
      right: inputBox.right - shellBox.right,
      top: shellBox.top - inputBox.top,
    } : undefined;
  });
  expect(focusGeometry).toBeDefined();
  expect(Math.max(...Object.values(focusGeometry ?? {}))).toBeLessThanOrEqual(1);

  const channelTab = surface.getByRole("tab", { name: /频道接入|Channel usage/ });
  await channelTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(surface.getByRole("tab", { name: /智囊团设置|Council settings/ })).toHaveAttribute("data-state", "active");
  await page.keyboard.press("ArrowLeft");
  await expect(channelTab).toHaveAttribute("data-state", "active");
  await captureEvidence(page, "1280x800-ling-dark-archived-removal-only-zh-cn.png");
  await expectNoOverflow(page, panel);
  expect(runtimeErrors).toEqual([]);
});

test("initial failure retries and retained refresh failure keeps authoritative relationships", async ({ page }) => {
  await prepareSurface(page, { height: 960, locale: "en-US", theme: "dark", width: 1440 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createChannelsState();
  state.channelCouncilPolicies = [policyFixture("channel_engineering", ["council_alpha"], "council_alpha")];
  const control = createPolicyRouteControl();
  control.failNextGetCount = 2;
  control.failNextGetMessage = "Synthetic initial policy failure";
  await mockDaemon(page, state);
  await installPolicyRouteOverlay(page, control);
  await page.goto("/");

  const panel = await openCouncilChannels(page);
  await expect(panel.getByRole("alert")).toContainText("Synthetic initial policy failure");
  await expect(panel.locator(".council-channels-row-shell[data-council-id='council_alpha']")).toHaveCount(0);
  await panel.getByRole("button", { name: "Retry" }).click();
  await expect(councilRow(panel, "council_alpha")).toContainText("Preferred");

  control.failNextGetCount = 2;
  control.failNextGetMessage = "Synthetic retained policy failure";
  control.getDelayByChannel.set("channel_engineering", 250);
  const getCountBeforeRefresh = control.getRequests.length;
  const refresh = panel.getByRole("button", { name: "Refresh" });
  await expectTypedIconAction(page, refresh, "Refresh");
  await refresh.focus();
  await expect(refresh).toBeFocused();
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh).toBeDisabled();
  await expect.poll(() => control.getRequests.length).toBeGreaterThan(getCountBeforeRefresh);
  await expect(panel.getByText("Synthetic retained policy failure", { exact: true })).toBeVisible();
  await expect(councilRow(panel, "council_alpha")).toContainText("Preferred");
  await expect(councilRow(panel, "council_alpha").getByRole("button", { name: "Detach council" })).toBeDisabled();
  await captureEvidence(page, "1440x960-ling-dark-retained-policy-refresh-failure.png");

  control.failNextGetCount = 0;
  control.failNextGetMessage = undefined;
  await panel.getByRole("button", { name: "Retry" }).click();
  await expect(panel.getByText("Synthetic retained policy failure", { exact: true })).toHaveCount(0);
  await expect(councilRow(panel, "council_alpha").getByRole("button", { name: "Detach council" })).toBeEnabled();
  await expectNoOverflow(page, panel);
  expect(runtimeErrors).toEqual([]);
});

test("mutation failure stays with its Council row and retry uses the same authoritative payload", async ({ page }) => {
  await prepareSurface(page, { height: 800, locale: "en-US", theme: "dark", width: 1280 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createChannelsState();
  state.channelCouncilPolicies = [
    policyFixture("channel_engineering", ["council_alpha", "council_builtin_review"], "council_alpha"),
  ];
  const control = createPolicyRouteControl();
  control.failNextPutMessage = "Synthetic prefer failure";
  await mockDaemon(page, state);
  await installPolicyRouteOverlay(page, control);
  await page.goto("/");

  const panel = await openCouncilChannels(page);
  const builtIn = councilRow(panel, "council_builtin_review");
  const alpha = councilRow(panel, "council_alpha");
  await builtIn.getByRole("button", { name: "Prefer" }).click();
  await expect(builtIn.getByRole("alert")).toContainText("Synthetic prefer failure");
  await expect(alpha.getByText("Synthetic prefer failure")).toHaveCount(0);
  await expect(alpha).toContainText("Preferred");
  await captureEvidence(page, "1280x800-ling-dark-row-mutation-failure.png");

  await builtIn.getByRole("button", { name: "Prefer" }).click();
  await expect(builtIn.getByRole("alert")).toHaveCount(0);
  await expect(builtIn).toContainText("Preferred");
  expect(control.putBodies).toEqual([
    {
      channelId: "channel_engineering",
      payload: {
        attachedCouncilIds: ["council_alpha", "council_builtin_review"],
        preferredCouncilId: "council_builtin_review",
      },
    },
    {
      channelId: "channel_engineering",
      payload: {
        attachedCouncilIds: ["council_alpha", "council_builtin_review"],
        preferredCouncilId: "council_builtin_review",
      },
    },
  ]);
  await expectNoOverflow(page, panel);
  expect(runtimeErrors).toEqual([]);
});

test("delayed policy loads and mutations cannot cross channel selection identity", async ({ page }) => {
  await prepareSurface(page, { height: 960, locale: "en-US", theme: "light", width: 1440 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createChannelsState();
  state.channelCouncilPolicies = [
    policyFixture("channel_engineering", ["council_alpha"], "council_alpha"),
    policyFixture("channel_design", ["council_builtin_review"], "council_builtin_review"),
  ];
  const control = createPolicyRouteControl();
  control.getDelayByChannel.set("channel_engineering", 420);
  await mockDaemon(page, state);
  await installPolicyRouteOverlay(page, control);
  await page.goto("/");

  const panel = await openCouncilChannels(page);
  const select = panel.getByRole("combobox", { name: "Select channel for council" });
  await expect(panel.getByLabel("Loading councils")).toBeVisible();
  await select.selectOption("channel_design");
  await expect(councilRow(panel, "council_builtin_review")).toContainText("Preferred");
  await page.waitForTimeout(500);
  await expect(councilRow(panel, "council_alpha")).toHaveCount(0);
  await expect(councilRow(panel, "council_builtin_review")).toContainText("Preferred");

  control.getDelayByChannel.set("channel_engineering", 0);
  await select.selectOption("channel_engineering");
  await expect(councilRow(panel, "council_alpha")).toContainText("Preferred");
  control.putDelayMs = 360;
  await councilRow(panel, "council_alpha").getByRole("button", { name: "Detach council" }).click();
  await select.selectOption("channel_design");
  await expect(councilRow(panel, "council_builtin_review")).toContainText("Preferred");
  await page.waitForTimeout(450);
  await expect(councilRow(panel, "council_alpha")).toHaveCount(0);
  await expect(councilRow(panel, "council_builtin_review")).toContainText("Preferred");
  expect(control.putBodies.at(-1)).toEqual({
    channelId: "channel_engineering",
    payload: { attachedCouncilIds: [], preferredCouncilId: null },
  });
  await expectNoOverflow(page, panel);
  expect(runtimeErrors).toEqual([]);
});

test("no channel and no attachment remain distinct empty states", async ({ page }) => {
  await prepareSurface(page, { height: 800, locale: "en-US", theme: "light", width: 1280 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createChannelsState();
  state.channels = [];
  state.channelCouncilPolicies = [];
  await mockDaemon(page, state);
  await page.goto("/");

  const panel = await openCouncilChannels(page);
  await expect(panel.getByText("No channels available", { exact: true })).toBeVisible();
  await expect(panel.getByText("No AI councils attached", { exact: true })).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-light-no-channels.png");
  await expectNoOverflow(page, panel);
  expect(runtimeErrors).toEqual([]);
});

test("100 attached Councils keep long identities inside one bounded scroll owner", async ({ page }) => {
  await prepareSurface(page, { height: 960, locale: "en-US", reducedMotion: "reduce", theme: "light", width: 1440 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createChannelsState();
  state.aiCouncils = Array.from({ length: 100 }, (_, index) => councilFixture(
    `council_dense_${String(index).padStart(3, "0")}`,
    `Council ${String(index).padStart(3, "0")} with a deliberately long configuration identity for bounded truncation`,
    index === 0 ? "builtin" : "user",
    index === 0,
  ));
  const councilIds = state.aiCouncils.flatMap((item) => isRecord(item) && typeof item.id === "string" ? [item.id] : []);
  state.channelCouncilPolicies = [policyFixture("channel_engineering", councilIds, councilIds[0])];
  await mockDaemon(page, state);
  await page.goto("/");

  const panel = await openCouncilChannels(page);
  const list = panel.locator("[data-ui2-council-channels-list]");
  await expect(list.locator("[data-council-id]")).toHaveCount(100);
  await expect(list.getByText("Preferred", { exact: true })).toHaveCount(1);
  await expect(list.getByText("Attached councils", { exact: true })).toHaveCount(99);
  const listMetrics = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    overflowX: getComputedStyle(element).overflowX,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }));
  expect(["auto", "scroll"]).toContain(listMetrics.overflowY);
  expect(listMetrics.scrollHeight).toBeGreaterThan(listMetrics.clientHeight);
  expect(listMetrics.scrollWidth).toBeLessThanOrEqual(listMetrics.clientWidth + 1);
  await captureEvidence(page, "1440x960-ling-light-100-attached-councils.png");
  await expectNoOverflow(page, panel);
  expect(runtimeErrors).toEqual([]);
});

interface PolicyRouteControl {
  failNextGetCount: number;
  failNextGetMessage?: string;
  failNextPutMessage?: string;
  readonly getDelayByChannel: Map<string, number>;
  readonly getRequests: string[];
  putDelayMs: number;
  readonly putBodies: Array<{ readonly channelId: string; readonly payload: Record<string, unknown> }>;
}

function createPolicyRouteControl(): PolicyRouteControl {
  return {
    failNextGetCount: 0,
    getDelayByChannel: new Map(),
    getRequests: [],
    putBodies: [],
    putDelayMs: 0,
  };
}

async function installPolicyRouteOverlay(page: Page, control: PolicyRouteControl): Promise<void> {
  await page.route("http://127.0.0.1:17891/channels/*/council-policy*", async (route) => {
    const request = route.request();
    const match = /^\/channels\/([^/]+)\/council-policy$/u.exec(new URL(request.url()).pathname);
    if (!match) {
      await route.fallback();
      return;
    }
    const channelId = decodeURIComponent(match[1]);
    if (request.method() === "GET") {
      control.getRequests.push(channelId);
      const delay = control.getDelayByChannel.get(channelId) ?? 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (control.failNextGetCount > 0 && control.failNextGetMessage) {
        const message = control.failNextGetMessage;
        control.failNextGetCount -= 1;
        if (control.failNextGetCount === 0) control.failNextGetMessage = undefined;
        await route.fulfill({ status: 503, json: { error: "synthetic_policy_get_failure", message } });
        return;
      }
    }
    if (request.method() === "PUT") {
      control.putBodies.push({ channelId, payload: request.postDataJSON() as Record<string, unknown> });
      if (control.putDelayMs) await new Promise((resolve) => setTimeout(resolve, control.putDelayMs));
      if (control.failNextPutMessage) {
        const message = control.failNextPutMessage;
        control.failNextPutMessage = undefined;
        await route.fulfill({ status: 503, json: { error: "synthetic_policy_put_failure", message } });
        return;
      }
    }
    await route.fallback();
  });
}

function createChannelsState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiCouncils = [
    councilFixture("council_alpha", "Alpha Council", "user", true),
    councilFixture("council_builtin_review", "Built-in Review Council", "builtin"),
  ];
  state.aiCouncilMembers = [];
  state.channels = [
    channelFixture("channel_engineering", "Engineering"),
    channelFixture("channel_design", "Design"),
    channelFixture("channel_paused", "Paused release planning", "paused"),
    channelFixture("channel_archived", "Archived product decisions", "archived"),
  ];
  state.channelCouncilPolicies = [];
  return state;
}

function councilFixture(
  id: string,
  displayName: string,
  source: "builtin" | "template" | "user" = "user",
  pinned = false,
): Record<string, unknown> {
  return {
    id,
    workspaceId: "workspace_default",
    source,
    displayName,
    description: "Configuration relationship fixture.",
    routingPolicy: { defaultMode: "advisory", notes: [] },
    governanceProfile: {
      permissionBoundary: "restrict_only",
      approvalBoundary: "cannot_bypass",
      toolGrantBoundary: "cannot_grant",
      credentialBoundary: "cannot_grant",
      notes: [],
    },
    status: "active",
    pinned,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

function channelFixture(
  id: string,
  name: string,
  status: "active" | "archived" | "paused" = "active",
): Record<string, unknown> {
  return {
    id,
    workspaceId: "workspace_default",
    name,
    status,
    boundPath: cwd,
    autoReplyMode: "mentions_only",
    allowedTools: ["read"],
    runtimePolicy: {
      maxConcurrentRuns: 2,
      schedulingMode: "parallel",
      writeLockScope: "channel",
      allowReadOnlyParallel: true,
      queueOnConflict: true,
    },
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

function policyFixture(
  channelId: string,
  attachedCouncilIds: readonly string[],
  preferredCouncilId?: string,
): Record<string, unknown> {
  return {
    workspaceId: "workspace_default",
    channelId,
    attachedCouncilIds,
    preferredCouncilId,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

function councilRow(panel: Locator, councilId: string): Locator {
  return panel.locator(`.council-channels-row-shell[data-council-id="${councilId}"]`);
}

async function expectTypedIconAction(page: Page, action: Locator, label: string): Promise<void> {
  await expect(action).toHaveAttribute("data-icon-only", "true");
  await expect(action).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await expect(action).toHaveAttribute("aria-label", label);
  await expect(action).toHaveAttribute("title", label);
  const bounds = await action.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(32);
  await action.hover();
  await expect(page.getByRole("tooltip", { name: label })).toBeVisible();
  await page.mouse.move(0, 0);
}

async function openCouncilWorkspace(page: Page): Promise<Locator> {
  await page.getByLabel(/Ling Stack navigation|Ling Stack 导航/).getByRole("button", { name: /Settings|设置/ }).click();
  await page.getByLabel(/Settings sections|设置分组/).getByRole("button", { name: /Council Workspace|智囊团工作区/ }).click();
  const surface = page.locator("[data-settings-workspace-tool='councils']");
  await expect(surface).toBeVisible();
  await expect(surface.locator(".council-list-health-row").first()).toBeVisible();
  return surface;
}

async function openCouncilChannels(page: Page): Promise<Locator> {
  return openCouncilChannelsTab(await openCouncilWorkspace(page));
}

async function openCouncilChannelsTab(surface: Locator): Promise<Locator> {
  await surface.getByRole("tab", { name: /Channel usage|频道接入/ }).click();
  const panel = surface.locator("[data-ui2-council-channels]");
  await expect(panel).toBeVisible();
  return panel;
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
    const themeId = `ling-${theme}`;
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { locale: input.locale, theme: input.theme });
}

async function expectNoOverflow(page: Page, panel?: Locator): Promise<void> {
  const root = await page.evaluate(() => ({
    clientHeight: document.documentElement.clientHeight,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth + 1);
  expect(root.scrollHeight).toBeLessThanOrEqual(root.clientHeight + 1);
  if (!panel) return;
  const metrics = await panel.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
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
    if (message.type() === "warning") errors.push(`warning: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
