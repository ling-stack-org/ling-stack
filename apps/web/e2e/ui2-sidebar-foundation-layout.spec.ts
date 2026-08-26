import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockTeammate,
  cwd,
  defaultRuntimePolicy,
  type MockState,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/shell/sidebar-foundation-layout/",
  import.meta.url,
));

test("Sidebar foundation keeps one bounded expanded navigation surface", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  await mockDaemon(page, createDenseSidebarState());
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const scrollRegion = navigation.locator(".sidebar-scroll-region");
  await expect(navigation).toBeVisible();
  await expectWidth(navigation, 240);
  await expect(scrollRegion).toHaveCount(1);

  const scrollGeometry = await scrollRegion.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const parentBox = element.closest("aside")!.getBoundingClientRect();
    const styles = getComputedStyle(element);
    return {
      bottom: box.bottom,
      clientHeight: element.clientHeight,
      overflowX: styles.overflowX,
      overflowY: styles.overflowY,
      parentBottom: parentBox.bottom,
      parentTop: parentBox.top,
      scrollHeight: element.scrollHeight,
      top: box.top,
    };
  });
  expect(scrollGeometry.overflowX).toBe("hidden");
  expect(scrollGeometry.overflowY).toBe("auto");
  expect(scrollGeometry.scrollHeight).toBeGreaterThan(scrollGeometry.clientHeight);
  expect(scrollGeometry.top).toBeGreaterThanOrEqual(scrollGeometry.parentTop);
  expect(scrollGeometry.bottom).toBeLessThanOrEqual(scrollGeometry.parentBottom);

  const engineeringShell = navigation.locator(".sidebar-channel-group").filter({ hasText: "Engineering" })
    .locator(".sidebar-row-shell").first();
  await engineeringShell.scrollIntoViewIfNeeded();
  await engineeringShell.hover();
  await expect(engineeringShell.locator(".sidebar-row-status")).toBeVisible();
  await expect(engineeringShell.getByRole("button", { name: "Create branch" })).toBeVisible();
  await expectChildrenInside(engineeringShell, [
    engineeringShell.locator(".sidebar-row-main"),
    engineeringShell.locator(".sidebar-row-status"),
    engineeringShell.locator(".sidebar-row-tools"),
  ]);

  const longChannel = navigation.getByRole("button", { name: LONG_CHANNEL_NAME });
  await longChannel.scrollIntoViewIfNeeded();
  const longLabel = longChannel.locator('[data-ling-button-slot="label"]');
  const longShell = longChannel.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' sidebar-row-shell ')][1]");
  const titleViewport = longChannel.locator(".sidebar-row-title-viewport");
  const titleTrack = longChannel.locator(".sidebar-row-title-track");
  await expect(longLabel).toHaveCSS("overflow", "visible");
  await expect(longLabel).toHaveCSS("text-overflow", "clip");
  await expect(titleViewport).toHaveCSS("overflow", "hidden");
  await expect(titleViewport).toHaveCSS("white-space", "nowrap");
  await expect(longShell).toHaveAttribute("data-sidebar-row-overflow", "true");
  expect(await titleViewport.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await longShell.evaluate((element) => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/u))).toHaveLength(1);
  await longShell.hover();
  await expect.poll(() => titleTrack.evaluate((element) => getComputedStyle(element).transform))
    .not.toBe("none");
  await page.mouse.move(1000, 700);
  await expect.poll(() => titleTrack.evaluate((element) => getComputedStyle(element).transform), { timeout: 5_000 })
    .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/u);
  await expectInside(navigation, longChannel);
  await expectNoHorizontalOverflow(page.locator("html"));
  await captureEvidence(page, "1440x960-ling-light-expanded-long-row.png");

  await scrollRegion.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
  await expect(navigation.getByRole("button", { name: "Open recent conversation 1" })).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-expanded-scroll-bottom.png");
  expect(runtimeErrors).toEqual([]);
});

test("Sidebar branch draft and section menu stay contained in dark reduced-motion mode", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 1280, 800);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockDaemon(page, createDenseSidebarState());
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const longTeammate = navigation.getByRole("button", { name: "A teammate identity that is intentionally longer than the available Sidebar row" });
  await longTeammate.scrollIntoViewIfNeeded();
  const longTeammateShell = longTeammate.locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' sidebar-row-shell ')][1]");
  await expect(longTeammateShell).toHaveAttribute("data-sidebar-row-overflow", "true");
  await longTeammateShell.hover();
  await expect(longTeammate.locator(".sidebar-row-title-track")).toHaveCSS("transform", "none");
  const engineeringGroup = navigation.locator(".sidebar-channel-group").filter({ hasText: "Engineering" });
  await engineeringGroup.locator(".sidebar-row-shell").hover();
  await engineeringGroup.getByRole("button", { name: "Create branch" }).click();

  const form = engineeringGroup.locator("form.sidebar-branch-create-form");
  const input = form.getByLabel("Branch name");
  const submit = form.getByRole("button", { name: "Create branch" });
  await expect(form).toBeVisible();
  await expect(input).toBeFocused();
  const heightBeforeFocus = await input.evaluate((element) => element.getBoundingClientRect().height);
  await input.fill("A focused branch draft");
  await input.focus();
  const focusGeometry = await input.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const formBox = element.closest("form")!.getBoundingClientRect();
    return {
      bottom: box.bottom,
      formBottom: formBox.bottom,
      formTop: formBox.top,
      height: box.height,
      top: box.top,
    };
  });
  expect(focusGeometry.height).toBe(heightBeforeFocus);
  expect(focusGeometry.top).toBeGreaterThanOrEqual(focusGeometry.formTop);
  expect(focusGeometry.bottom).toBeLessThanOrEqual(focusGeometry.formBottom);
  await expectInside(navigation, form);
  await expectInside(navigation, input);
  await expectInside(navigation, submit);
  await expectReducedMotion(navigation);
  await captureEvidence(page, "1280x800-ling-dark-branch-draft-focus.png");

  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-dark-branch-draft-closed.png");

  const channelActions = navigation.getByRole("button", { name: "Channel actions" });
  await channelActions.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "New channel" })).toBeVisible();
  await expectInsideViewport(menu, page);
  await captureEvidence(page, "1280x800-ling-dark-channel-section-menu.png");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(channelActions).toBeFocused();
  await expectNoHorizontalOverflow(page.locator("html"));
  expect(runtimeErrors).toEqual([]);
});

test("Sidebar compact rail returns to the expanded 240px foundation", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1280, 800);
  await mockDaemon(page, createDenseSidebarState());
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await expectWidth(navigation, 240);
  await page.getByRole("button", { name: "Hide navigation" }).click();
  await expectWidth(navigation, 48);
  await expect(page.locator("main.app-shell")).toHaveClass(/channel-sidebar-collapsed/);
  await expect(navigation.getByRole("button", { name: "Channel actions" })).toBeHidden();
  await expectNoHorizontalOverflow(page.locator("html"));
  await captureEvidence(page, "1280x800-ling-light-compact-rail.png");

  await page.getByRole("button", { name: "Show navigation" }).click();
  await expectWidth(navigation, 240);
  await expect(page.locator("main.app-shell")).not.toHaveClass(/channel-sidebar-collapsed/);
  await expect(navigation.getByRole("button", { name: "Channel actions" })).toBeVisible();
  await expectNoHorizontalOverflow(page.locator("html"));
  await captureEvidence(page, "1280x800-ling-light-reexpanded.png");
  expect(runtimeErrors).toEqual([]);
});

test("Sidebar foundation preserves shell geometry across the 900 and 901px boundary", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 901, 800);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockDaemon(page, createBoundaryState());
  await page.goto("/");

  const shell = page.locator("main.app-shell");
  const navigation = page.getByLabel("Ling Stack navigation");
  await expectBoundaryGeometry(page, shell, navigation, 901, 240);
  await captureEvidence(page, "901x800-ling-dark-expanded-boundary.png");

  await page.setViewportSize({ width: 900, height: 800 });
  await expectBoundaryGeometry(page, shell, navigation, 900, 48);
  await expect(page.getByRole("button", { name: "Show navigation" })).toBeVisible();
  await captureEvidence(page, "900x800-ling-dark-compact-boundary.png");

  await page.setViewportSize({ width: 901, height: 800 });
  await expectBoundaryGeometry(page, shell, navigation, 901, 48);
  await page.getByRole("button", { name: "Show navigation" }).click();
  await expectBoundaryGeometry(page, shell, navigation, 901, 240);
  await captureEvidence(page, "901x800-ling-dark-reexpanded-boundary.png");
  await expectReducedMotion(navigation);
  await expectNoHorizontalOverflow(page.locator("html"));
  expect(runtimeErrors).toEqual([]);
});

const LONG_CHANNEL_NAME = "Architecture coordination channel with a deliberately long identity that must fade smoothly";

function createDenseSidebarState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.channels = [
    ...state.channels,
    channel("channel_long", LONG_CHANNEL_NAME),
    ...Array.from({ length: 12 }, (_, index) => channel(`channel_dense_${index + 1}`, `Delivery channel ${index + 1}`)),
  ];
  state.aiTeammates = Array.from({ length: 10 }, (_, index) => createMockTeammate({
    id: `teammate_sidebar_foundation_${index + 1}`,
    displayName: index === 0
      ? "A teammate identity that is intentionally longer than the available Sidebar row"
      : `Specialist ${index + 1}`,
  }));
  state.threads = Array.from({ length: 8 }, (_, index) => conversationThread(index));
  return state;
}

function createBoundaryState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [createMockTeammate({
    id: "teammate_sidebar_boundary",
    displayName: "Boundary specialist",
  })];
  state.threads = [conversationThread(0)];
  return state;
}

function channel(id: string, name: string): Record<string, unknown> {
  return {
    id,
    workspaceId: "workspace_default",
    name,
    status: "active",
    boundPath: cwd,
    autoReplyMode: "mentions_only",
    allowedTools: ["read"],
    runtimePolicy: defaultRuntimePolicy,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  };
}

function conversationThread(index: number): Record<string, unknown> {
  const suffix = index + 1;
  const timestamp = `2026-07-24T00:${String(index).padStart(2, "0")}:00.000Z`;
  return {
    id: `thread_sidebar_foundation_${suffix}`,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: suffix === 1
      ? "A deliberately long recent conversation title that must remain bounded inside the Sidebar"
      : `Recent conversation ${suffix}`,
    objective: `Sidebar foundation conversation ${suffix}`,
    status: "open",
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: { lastActivityAt: timestamp, schemaVersion: 1 },
  };
}

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((resolvedTheme) => {
    const selection = { mode: "fixed", themeId: `ling-${resolvedTheme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", resolvedTheme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", resolvedTheme);
  }, theme);
}

async function expectWidth(locator: Locator, width: number): Promise<void> {
  await expect.poll(async () => Math.round((await locator.boundingBox())?.width ?? 0)).toBe(width);
}

async function expectChildrenInside(parent: Locator, children: readonly Locator[]): Promise<void> {
  for (const child of children) {
    await expectInside(parent, child);
  }
}

async function expectInside(parent: Locator, child: Locator): Promise<void> {
  const [parentBox, childBox] = await Promise.all([parent.boundingBox(), child.boundingBox()]);
  expect(parentBox).not.toBeNull();
  expect(childBox).not.toBeNull();
  expect(childBox!.x).toBeGreaterThanOrEqual(parentBox!.x - 1);
  expect(childBox!.y).toBeGreaterThanOrEqual(parentBox!.y - 1);
  expect(childBox!.x + childBox!.width).toBeLessThanOrEqual(parentBox!.x + parentBox!.width + 1);
  expect(childBox!.y + childBox!.height).toBeLessThanOrEqual(parentBox!.y + parentBox!.height + 1);
}

async function expectInsideViewport(locator: Locator, page: Page): Promise<void> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
}

async function expectBoundaryGeometry(
  page: Page,
  shell: Locator,
  navigation: Locator,
  viewportWidth: number,
  sidebarWidth: number,
): Promise<void> {
  await expectWidth(navigation, sidebarWidth);
  await expect.poll(async () => shell.evaluate((element) => {
    const [firstColumn] = getComputedStyle(element).gridTemplateColumns.split(" ");
    return Math.round(Number.parseFloat(firstColumn));
  })).toBe(sidebarWidth);
  const geometry = await shell.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { boxLeft: box.left, boxRight: box.right };
  });
  expect(Math.round(geometry.boxLeft)).toBe(0);
  expect(Math.round(geometry.boxRight)).toBe(viewportWidth);
  await expectNoHorizontalOverflow(page.locator("html"));
}

async function expectReducedMotion(navigation: Locator): Promise<void> {
  const motion = await navigation.evaluate((element) => {
    const parseCssTimeMs = (value: string): number => {
      const normalized = value.trim();
      if (normalized.endsWith("ms")) return Number.parseFloat(normalized);
      if (normalized.endsWith("s")) return Number.parseFloat(normalized) * 1_000;
      return Number.parseFloat(normalized) || 0;
    };
    const styles = getComputedStyle(element);
    return {
      animationName: styles.animationName,
      transitionDurations: styles.transitionDuration.split(",").map(parseCssTimeMs),
    };
  });
  expect(motion.animationName).toBe("none");
  expect(Math.max(...motion.transitionDurations)).toBeLessThanOrEqual(1);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const metrics = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
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
