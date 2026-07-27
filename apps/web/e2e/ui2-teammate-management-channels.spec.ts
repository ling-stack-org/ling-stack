import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockTeammate,
  cwd,
  isRecord,
  type MockState,
} from "./support/mock-state";

const teammateId = "teammate_channels_reviewer";
const teammateName = "Channel Systems Reviewer";
const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/ai-teammate-management-channels/",
  import.meta.url,
));

test("Join, Leave, and Set default preserve the full membership payload with row-scoped busy", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createChannelsState();
  const payloads: Record<string, unknown>[] = [];
  const joinGate = deferred<void>();
  let holdResearchJoin = true;
  await mockDaemon(page, state);
  await routeChannelMemberships(page, async (route, requestedTeammateId) => {
    if (route.request().method() !== "PUT" || requestedTeammateId !== teammateId) {
      await route.fallback();
      return;
    }
    const body = await route.request().postDataJSON() as Record<string, unknown>;
    payloads.push(body);
    if (holdResearchJoin && membershipIds(body).includes("channel_research")) {
      await joinGate.promise;
    }
    await route.fallback();
  });
  await page.goto("/");

  const channels = await openChannels(page);
  const engineering = channelRow(channels, "channel_engineering");
  const design = channelRow(channels, "channel_design");
  const research = channelRow(channels, "channel_research");
  await expect(engineering).toContainText("Default channel");
  await expect(design).toContainText("Joined channel");
  await expect(research).toContainText("Not joined");
  await expect(channels.locator('button[data-ling-icon-button-contract="legacy-react-node"]')).toHaveCount(0);
  await expect(design.getByRole("button", { name: "Set default" })).not.toHaveAttribute("data-ling-icon-button-contract");

  await design.getByRole("button", { name: "Set default" }).click();
  await expect(design).toContainText("Default channel");
  await expect(page.getByText("Design is now the default channel", { exact: true })).toBeVisible();
  await expect.poll(() => normalizePayload(payloads[0])).toEqual([
    { channelId: "channel_archived", isDefault: false },
    { channelId: "channel_design", isDefault: true },
    { channelId: "channel_engineering", isDefault: false },
  ]);

  await research.getByRole("button", { name: "Join" }).click();
  await expect(research.locator('button[aria-busy="true"]')).toHaveCount(1);
  await expect(design.getByRole("button", { name: "Leave" })).toBeEnabled();
  await expect(engineering.getByRole("button", { name: "Set default" })).toBeEnabled();
  expect(await research.getByRole("button").allTextContents()).not.toContain("Set default");
  holdResearchJoin = false;
  joinGate.resolve();
  await expect(research).toContainText("Joined channel");
  await expect(page.getByText("Joined Research", { exact: true })).toBeVisible();
  await expect.poll(() => normalizePayload(payloads[1])).toEqual([
    { channelId: "channel_archived", isDefault: false },
    { channelId: "channel_design", isDefault: true },
    { channelId: "channel_engineering", isDefault: false },
    { channelId: "channel_research", isDefault: false },
  ]);

  await research.getByRole("button", { name: "Leave" }).click();
  await expect(research).toContainText("Not joined");
  await expect(page.getByText("Left Research", { exact: true })).toBeVisible();
  await expect.poll(() => normalizePayload(payloads[2])).toEqual([
    { channelId: "channel_archived", isDefault: false },
    { channelId: "channel_design", isDefault: true },
    { channelId: "channel_engineering", isDefault: false },
  ]);
  await captureEvidence(page, "1440x960-ling-light-membership-actions.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("paused and archived reasons stay explicit in compact Chinese reduced-motion layout", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "zh-CN", reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createChannelsState("频道关系系统审阅队友（用于验证长名称和受限频道操作）");
  state.channels = state.channels.map((item) => {
    if (!isRecord(item)) return item;
    if (item.id === "channel_paused") return { ...item, name: "已暂停的跨团队发布协调频道（不能加入或设为默认）" };
    if (item.id === "channel_archived") return { ...item, name: "已归档的长期产品决策记录频道（只允许解除关系）" };
    return item;
  });
  await mockDaemon(page, state);
  await page.goto("/");

  const channels = await openChannels(page, "频道关系系统审阅队友（用于验证长名称和受限频道操作）", true);
  const paused = channelRow(channels, "channel_paused");
  const archived = channelRow(channels, "channel_archived");
  const pausedJoin = paused.getByRole("button", { name: "加入" });
  await expect(pausedJoin).toBeDisabled();
  await expect(pausedJoin).toHaveAttribute("title", "已暂停频道不能加入或设为默认。");
  await expect(paused).toContainText("已暂停频道不能加入或设为默认。");
  await expect(archived.getByRole("button", { name: "退出" })).toBeEnabled();
  await expect(archived).toContainText("已归档频道只允许解除现有关系。");

  const search = channels.getByRole("searchbox", { name: "搜索频道" });
  await search.focus();
  await expect(search).toBeFocused();
  const focusGeometry = await search.evaluate((input) => {
    const shell = input.closest(".ling-ui-input");
    const inputBox = input.getBoundingClientRect();
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
  await page.keyboard.press("Tab");
  await expect(channels.getByRole("combobox", { name: "频道状态" })).toBeFocused();
  await page.keyboard.press("Tab");
  const refreshAction = channels.getByRole("button", { name: "刷新频道" });
  await expect(refreshAction).toBeFocused();
  await expectTypedIconButton(refreshAction, "刷新频道");
  await expectIconButtonTooltip(refreshAction, "刷新频道");
  await captureEvidence(page, "1280x800-ling-dark-lifecycle-zh-CN.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("initial load failure retries and a later refresh retains authoritative rows", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createChannelsState();
  const initialGate = deferred<void>();
  const refreshGate = deferred<void>();
  let mode: "initial-failure" | "pass" | "refresh-failure" = "initial-failure";
  await mockDaemon(page, state);
  await routeChannelMemberships(page, async (route, requestedTeammateId) => {
    if (route.request().method() !== "GET" || requestedTeammateId !== teammateId) {
      await route.fallback();
      return;
    }
    if (mode === "initial-failure") {
      await initialGate.promise;
      await route.fulfill({ status: 503, json: { error: "memberships_unavailable" } });
      return;
    }
    if (mode === "refresh-failure") {
      await refreshGate.promise;
      await route.fulfill({ status: 503, json: { error: "memberships_unavailable" } });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");

  const channels = await openChannels(page);
  const refreshAction = channels.getByRole("button", { name: "Refresh channels" });
  await expect(channels.getByLabel("Loading channel memberships")).toBeVisible();
  await expect(refreshAction).toBeDisabled();
  await expectTypedIconButton(refreshAction, "Refresh channels");
  initialGate.resolve();
  await expect(channels.getByText("Channel memberships could not be loaded. Try again.", { exact: true })).toBeVisible();
  await expect(channels.locator("[data-channel-id]")).toHaveCount(0);

  mode = "pass";
  await channels.getByRole("button", { name: "Retry" }).click();
  await expect(channelRow(channels, "channel_engineering")).toContainText("Default channel");
  mode = "refresh-failure";
  await refreshAction.click();
  await expect(refreshAction).toBeDisabled();
  await expect(refreshAction).toHaveAttribute("aria-busy", "true");
  await expectTypedIconButton(refreshAction, "Refresh channels");
  refreshGate.resolve();
  await expect(channelRow(channels, "channel_engineering")).toContainText("Default channel");
  await expect(channels.getByText("Channel memberships could not be loaded. Try again.", { exact: true })).toBeVisible();
  await captureEvidence(page, "1440x960-ling-dark-retained-refresh-error.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("authoritative empty and local no-result remain different states", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1280, height: 800, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createChannelsState();
  await mockDaemon(page, state);
  await page.goto("/");

  let channels = await openChannels(page);
  await channels.getByRole("searchbox", { name: "Search channels" }).fill("not-a-real-channel");
  await expect(channels.getByText("No channels match these filters", { exact: true })).toBeVisible();
  await captureEvidence(page, "1280x800-ling-light-search-no-result.png");
  await channels.getByRole("button", { name: "Clear filters" }).click();
  await expect(channelRow(channels, "channel_engineering")).toBeVisible();

  state.channels = [];
  state.teammateChannelMemberships = [];
  await page.reload();
  channels = await openChannels(page);
  await expect(channels.getByText("No channels available", { exact: true })).toBeVisible();
  await expect(channels.getByText("No channels match these filters", { exact: true })).toHaveCount(0);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("mutation failure remains with the initiating row and success replaces it with a Toast", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createChannelsState();
  let failResearchJoin = true;
  await mockDaemon(page, state);
  await routeChannelMemberships(page, async (route, requestedTeammateId) => {
    if (route.request().method() !== "PUT" || requestedTeammateId !== teammateId) {
      await route.fallback();
      return;
    }
    const body = await route.request().postDataJSON() as Record<string, unknown>;
    if (failResearchJoin && membershipIds(body).includes("channel_research")) {
      await route.fulfill({ status: 503, json: { error: "membership_update_failed" } });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");

  const channels = await openChannels(page);
  const research = channelRow(channels, "channel_research");
  const design = channelRow(channels, "channel_design");
  await research.getByRole("button", { name: "Join" }).click();
  await expect(research.getByText("Channel relationship could not be updated. Try again.", { exact: true })).toBeVisible();
  await expect(design.getByText("Channel relationship could not be updated. Try again.", { exact: true })).toHaveCount(0);
  await expect(design.getByRole("button", { name: "Set default" })).toBeEnabled();
  await captureEvidence(page, "1280x800-ling-dark-row-mutation-failure.png");

  failResearchJoin = false;
  await research.getByRole("button", { name: "Join" }).click();
  await expect(research.getByText("Channel relationship could not be updated. Try again.", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Joined Research", { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("delayed loads and mutations cannot cross the selected teammate identity", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const oldId = "teammate_channels_old";
  const oldName = "Previous Channel Reviewer";
  const currentId = "teammate_channels_current";
  const currentName = "Current Channel Reviewer";
  const state = createChannelsState(oldName, oldId);
  state.aiTeammates = [
    createMockTeammate({ id: oldId, displayName: oldName }),
    createMockTeammate({ id: currentId, displayName: currentName }),
  ];
  state.channels = [
    channelFixture("channel_old_scope", "Previous teammate channel"),
    channelFixture("channel_current_scope", "Current teammate channel"),
    channelFixture("channel_race_target", "Race mutation target"),
  ];
  state.teammateChannelMemberships = [
    membershipFixture(oldId, "channel_old_scope", true),
    membershipFixture(currentId, "channel_current_scope", true),
  ];
  const oldLoadGate = deferred<void>();
  const oldMutationGate = deferred<void>();
  let holdOldLoad = true;
  let holdOldMutation = true;
  await mockDaemon(page, state);
  await routeChannelMemberships(page, async (route, requestedTeammateId) => {
    if (route.request().method() === "GET" && requestedTeammateId === oldId && holdOldLoad) {
      const snapshot = state.teammateChannelMemberships.filter((item) => isRecord(item) && item.teammateId === oldId);
      await oldLoadGate.promise;
      await route.fulfill({ json: { cwd, teammateId: oldId, memberships: snapshot } });
      return;
    }
    if (route.request().method() === "PUT" && requestedTeammateId === oldId && holdOldMutation) {
      await oldMutationGate.promise;
      await route.fallback();
      return;
    }
    await route.fallback();
  });
  await page.goto("/");

  const previous = await openChannels(page, oldName);
  await expect(previous.getByLabel("Loading channel memberships")).toBeVisible();
  let current = await openChannels(page, currentName);
  await expect(channelRow(current, "channel_current_scope")).toContainText("Default channel");
  await expect(channelRow(current, "channel_old_scope")).toContainText("Not joined");
  holdOldLoad = false;
  oldLoadGate.resolve();
  await expect(channelRow(current, "channel_current_scope")).toContainText("Default channel");
  await expect(channelRow(current, "channel_old_scope")).toContainText("Not joined");

  const oldChannels = await openChannels(page, oldName);
  await expect(channelRow(oldChannels, "channel_old_scope")).toContainText("Default channel");
  await channelRow(oldChannels, "channel_race_target").getByRole("button", { name: "Join" }).click();
  await expect(channelRow(oldChannels, "channel_race_target").locator('button[aria-busy="true"]')).toHaveCount(1);
  current = await openChannels(page, currentName);
  await expect(channelRow(current, "channel_race_target")).toContainText("Not joined");
  holdOldMutation = false;
  oldMutationGate.resolve();
  await expect(channelRow(current, "channel_race_target")).toContainText("Not joined");
  await expect(page.getByText("Joined Race mutation target", { exact: true })).toHaveCount(0);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("protected Ling Agent exposes exactly 100 read-only rows inside one bounded scroll owner", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createChannelsState("Ling Agent", "ling_agent");
  state.aiTeammates = [createMockTeammate({
    id: "ling_agent",
    displayName: "Ling Agent",
    kind: "system_teammate",
    protectedProfile: true,
    systemRole: "ling_agent",
  })];
  state.channels = Array.from({ length: 100 }, (_, index) => channelFixture(
    `channel_dense_${String(index).padStart(3, "0")}`,
    `Channel ${String(index).padStart(3, "0")} with a deliberately long product identity for bounded truncation`,
  ));
  state.teammateChannelMemberships = [];
  let putCount = 0;
  await mockDaemon(page, state);
  await routeChannelMemberships(page, async (route) => {
    if (route.request().method() === "PUT") putCount += 1;
    await route.fallback();
  });
  await page.goto("/");

  const channels = await openChannels(page, "Ling Agent");
  const list = channels.locator("[data-ui2-teammate-channels-list]");
  await expect(list.locator("[data-channel-id]")).toHaveCount(100);
  await expect(list.getByText("Always joined", { exact: true })).toHaveCount(100);
  await expect(list.getByRole("button", { name: /Join|Leave|Set default/u })).toHaveCount(0);
  await expect(page.getByLabel("Configuration summary").locator(".teammate-summary-row").filter({ hasText: "Channels" })).toContainText("100");
  expect(putCount).toBe(0);
  const scrollState = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowX: getComputedStyle(element).overflowX,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }));
  expect(["auto", "scroll"]).toContain(scrollState.overflowY);
  expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
  expect(scrollState.scrollWidth).toBeLessThanOrEqual(list ? await list.evaluate((element) => element.clientWidth + 1) : 1);
  await captureEvidence(page, "1440x960-ling-light-protected-100-row-scroll.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function createChannelsState(displayName: string = teammateName, id: string = teammateId): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({ id, displayName })];
  state.channels = [
    channelFixture("channel_engineering", "Engineering"),
    channelFixture("channel_design", "Design"),
    channelFixture("channel_research", "Research"),
    channelFixture("channel_paused", "Paused planning", "paused"),
    channelFixture("channel_archived", "Archived decisions", "archived"),
  ];
  state.teammateChannelMemberships = [
    membershipFixture(id, "channel_engineering", true),
    membershipFixture(id, "channel_design", false),
    membershipFixture(id, "channel_archived", false),
  ];
  return state;
}

function channelFixture(id: string, name: string, status: "active" | "paused" | "archived" = "active"): Record<string, unknown> {
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
      maxTotalRuns: 8,
      maxWallClockMinutes: 30,
      resourceScope: "channel",
    },
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

function membershipFixture(
  membershipTeammateId: string,
  channelId: string,
  isDefault: boolean,
): Record<string, unknown> {
  return {
    teammateId: membershipTeammateId,
    channelId,
    isDefault,
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
  };
}

async function routeChannelMemberships(
  page: Page,
  handler: (route: Route, teammateId: string) => Promise<void>,
): Promise<void> {
  await page.route(/\/teammates\/([^/]+)\/channels(?:\?.*)?$/u, async (route) => {
    const match = /\/teammates\/([^/]+)\/channels$/u.exec(new URL(route.request().url()).pathname);
    await handler(route, match ? decodeURIComponent(match[1]) : "");
  });
}

async function openChannels(page: Page, targetTeammateName: string = teammateName, chinese = false): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: targetTeammateName }).click();
  const header = page.locator("[data-ui2-teammate-chat-header]");
  await expect(header).toBeVisible();
  const dockLabel = chinese ? "私聊工作区面板" : "Private chat workspace dock";
  if (await page.getByLabel(dockLabel).count() === 0) {
    await header.getByRole("button", { name: chinese ? "显示详情" : "Show details" }).click();
  }
  await page.getByLabel(dockLabel).getByRole("button", { name: chinese ? "设置" : "Settings" }).click();
  const settingsSections = page.getByLabel(chinese ? "设置分组" : "Settings sections");
  const channelsNavigation = settingsSections.getByRole("button", {
    name: chinese ? /^频道(?:\s|$)/u : /^Channels(?:\s|$)/u,
  });
  await expect(channelsNavigation).toBeVisible();
  await channelsNavigation.click();
  const channels = page.locator("[data-ui2-teammate-channels]");
  await expect(channels).toBeVisible();
  return channels;
}

function channelRow(channels: Locator, channelId: string): Locator {
  return channels.locator(`[data-channel-id="${channelId}"]`);
}

function membershipIds(body: Record<string, unknown>): string[] {
  return Array.isArray(body.memberships)
    ? body.memberships.flatMap((item) => isRecord(item) && typeof item.channelId === "string" ? [item.channelId] : [])
    : [];
}

function normalizePayload(body: Record<string, unknown> | undefined): readonly {
  readonly channelId: string;
  readonly isDefault: boolean;
}[] | undefined {
  if (!body || !Array.isArray(body.memberships)) return undefined;
  return body.memberships
    .flatMap((item) => isRecord(item) && typeof item.channelId === "string"
      ? [{ channelId: item.channelId, isDefault: item.isDefault === true }]
      : [])
    .sort((left, right) => left.channelId.localeCompare(right.channelId));
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
  await page.emulateMedia({
    colorScheme: options.theme,
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  await page.addInitScript(({ locale, theme }) => {
    const themeId = `ling-${theme}`;
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
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
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
