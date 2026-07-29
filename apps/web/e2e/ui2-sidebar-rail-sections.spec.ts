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
  "../../../docs/design/ui2.0升级/evidence/shell/sidebar-rail-sections/",
  import.meta.url,
));

const sectionNames = ["Channels", "AI Teammates", "Recent conversations"] as const;

test("Sidebar dense compact rail renders three fixed launchers and keeps Settings fixed", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1440, 960);
  await mockDaemon(page, createRailState({ dense: true }));
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const scrollRegion = navigation.locator(".sidebar-scroll-region");
  await expectWidth(navigation, 240);
  await page.getByRole("button", { name: "Hide navigation" }).click();
  await expectWidth(navigation, 48);

  const launchers = navigation.locator(".sidebar-rail-launcher");
  await expect(launchers).toHaveCount(3);
  for (const name of sectionNames) {
    const launcher = navigation.getByRole("button", { name, exact: true });
    await expect(launcher).toBeVisible();
    await expect(launcher).not.toHaveAttribute("aria-expanded", /.+/u);
    await expectInside(navigation, launcher);
  }
  await expect(navigation.locator(".sidebar-row, .sidebar-row-shell")).toHaveCount(0);
  await expect(navigation.locator(".sidebar-rail-preview, .sidebar-rail-stack")).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Engineering", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Rail Designer 1", exact: true })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Open recent conversation 1" })).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Channel actions" })).toBeHidden();
  await expect(navigation.getByRole("button", { name: "AI teammate actions" })).toBeHidden();
  await expect(navigation.getByRole("button", { name: "Recent conversation actions" })).toBeHidden();

  const settings = navigation.getByRole("button", { name: "Settings" });
  await expect(settings).toBeVisible();
  await expectInside(navigation, settings);
  expect(await settings.evaluate((element) => element.closest(".sidebar-scroll-region") === null)).toBe(true);
  await expectSingleScrollOwner(navigation, scrollRegion);
  const railScrollMetrics = await scrollRegion.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(railScrollMetrics.scrollHeight).toBeLessThanOrEqual(railScrollMetrics.clientHeight + 1);
  await expectNoHorizontalOverflow(page.locator("html"));
  await captureEvidence(page, "1440x960-ling-light-compact-launchers.png");
  expect(runtimeErrors).toEqual([]);
});

test("Sidebar dark compact launchers expose one portal tooltip without object action leakage", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", 1280, 800);
  await mockDaemon(page, createRailState());
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  await page.getByRole("button", { name: "Hide navigation" }).click();
  await expectWidth(navigation, 48);

  const identities = sectionNames.map((name) => ({
    locator: navigation.getByRole("button", { name, exact: true }),
    tooltip: name,
  }));

  for (const [index, identity] of identities.entries()) {
    await identity.locator.scrollIntoViewIfNeeded();
    if (index < identities.length - 1) {
      await identity.locator.hover();
    } else {
      await identity.locator.focus();
      await expect(identity.locator).toBeFocused();
    }
    await expectPortalTooltip(page, identity.tooltip);
    await captureEvidence(page, `1280x800-ling-dark-launcher-${index + 1}-tooltip.png`);
  }

  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(navigation.getByRole("button", { name: "Channel actions" })).toBeHidden();
  await expect(navigation.getByRole("button", { name: "AI teammate actions" })).toBeHidden();
  await expect(navigation.getByRole("button", { name: "Recent conversation actions" })).toBeHidden();
  await expect(navigation.getByRole("button", { name: "Create branch" })).toBeHidden();
  await expect(navigation.getByRole("button", { name: "Archive channel" })).toBeHidden();
  await expect(navigation.getByRole("button", { name: "Archive teammate" })).toBeHidden();
  await expect(navigation.getByRole("button", { name: "Archive conversation" })).toBeHidden();
  await expectNoHorizontalOverflow(page.locator("html"));
  expect(runtimeErrors).toEqual([]);
});

test("Sidebar launcher opens its section and preserves other expanded-state disclosures", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", 1280, 800);
  await mockDaemon(page, createRailState());
  await page.goto("/");

  const navigation = page.getByLabel("Ling Stack navigation");
  const channels = navigation.getByRole("button", { name: "Channels" });
  const teammates = navigation.getByRole("button", { name: "AI Teammates" });
  await channels.click();
  await expect(channels).toHaveAttribute("aria-expanded", "false");
  await teammates.click();
  await expect(teammates).toHaveAttribute("aria-expanded", "false");

  await page.getByRole("button", { name: "Hide navigation" }).click();
  await expectWidth(navigation, 48);
  await expect(navigation.locator(".sidebar-rail-launcher")).toHaveCount(3);
  await expect(navigation.locator(".sidebar-section-list")).toHaveCount(0);
  await navigation.getByRole("button", { name: "Channels", exact: true }).click();
  await expectWidth(navigation, 240);
  await expect(navigation.getByRole("button", { name: "Channels" })).toHaveAttribute("aria-expanded", "true");
  await expect(navigation.getByRole("button", { name: "AI Teammates" })).toHaveAttribute("aria-expanded", "false");
  await expect(navigation.getByRole("button", { name: "Recent conversations" })).toHaveAttribute("aria-expanded", "true");
  await expect(navigation.getByRole("button", { name: "Rail Designer 1", exact: true })).toBeHidden();
  await expect(navigation.getByRole("button", { name: "Open recent conversation 1" })).toBeVisible();
  await expect(navigation.getByRole("button", { name: "Engineering", exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page.locator("html"));
  await captureEvidence(page, "1280x800-ling-light-launcher-opens-channels.png");
  expect(runtimeErrors).toEqual([]);
});

test("Sidebar keeps 900 and 901px rail geometry stable during a reduced-motion rapid round trip", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await prepareSurface(page, "dark", 900, 800);
  await mockDaemon(page, createRailState());
  await page.goto("/");

  const shell = page.locator(".app-shell");
  const navigation = page.getByLabel("Ling Stack navigation");
  await expectShellGeometry(page, shell, navigation, 900, 48);
  await expectReducedMotion(navigation);
  await expectReducedMotion(navigation.locator(".sidebar-rail-launcher").first());
  await captureEvidence(page, "900x800-ling-dark-compact-launcher-boundary.png");

  await page.setViewportSize({ width: 901, height: 800 });
  await page.getByRole("button", { name: "Show navigation" }).click();
  await expectShellGeometry(page, shell, navigation, 901, 240);
  await captureEvidence(page, "901x800-ling-dark-expanded-after-launcher-round-trip.png");

  await page.getByRole("button", { name: "Hide navigation" }).click();
  await page.getByRole("button", { name: "Show navigation" }).click();
  await page.getByRole("button", { name: "Hide navigation" }).click();
  await page.getByRole("button", { name: "Show navigation" }).click();
  await expectShellGeometry(page, shell, navigation, 901, 240);
  await expectReducedMotion(navigation);
  await expectNoHorizontalOverflow(page.locator("html"));
  expect(runtimeErrors).toEqual([]);
});

function createRailState(options: { readonly dense?: boolean } = {}): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  const channelCount = options.dense ? 9 : 3;
  const teammateCount = options.dense ? 8 : 3;
  const conversationCount = options.dense ? 7 : 3;
  state.channels = [
    ...state.channels,
    ...Array.from({ length: channelCount - 1 }, (_, index) => channel(
      `channel_rail_${index + 2}`,
      `Rail channel ${index + 2}`,
    )),
  ];
  state.aiTeammates = Array.from({ length: teammateCount }, (_, index) => createMockTeammate({
    id: `teammate_rail_${index + 1}`,
    displayName: `Rail Designer ${index + 1}`,
  }));
  state.threads = Array.from({ length: conversationCount }, (_, index) => conversationThread(index));
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
    id: `thread_rail_${suffix}`,
    workspaceId: "workspace_default",
    kind: "conversation",
    title: `Rail conversation ${suffix}`,
    objective: `Verify compact rail conversation ${suffix}`,
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

async function expectPortalTooltip(page: Page, text: string): Promise<void> {
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toHaveCount(1);
  await expect(tooltip).toHaveText(text);
  expect(await tooltip.evaluate((element) => element.closest("aside") === null)).toBe(true);
}

async function expectWidth(locator: Locator, width: number): Promise<void> {
  await expect.poll(async () => Math.round((await locator.boundingBox())?.width ?? 0)).toBe(width);
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

async function expectSingleScrollOwner(navigation: Locator, expectedOwner: Locator): Promise<void> {
  const ownerClasses = await navigation.evaluate((element) => [element, ...element.querySelectorAll<HTMLElement>("*")]
    .filter((candidate) => {
      const overflowY = getComputedStyle(candidate).overflowY;
      return overflowY === "auto" || overflowY === "scroll";
    })
    .map((candidate) => candidate.className));
  expect(ownerClasses).toEqual(["sidebar-scroll-region"]);
  await expect(expectedOwner).toHaveCSS("overflow-y", "auto");
  await expectInside(navigation, expectedOwner);
}

async function expectShellGeometry(
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
  const shellBox = await shell.boundingBox();
  expect(shellBox).not.toBeNull();
  expect(Math.round(shellBox!.x)).toBe(0);
  expect(Math.round(shellBox!.width)).toBe(viewportWidth);
  await expectNoHorizontalOverflow(page.locator("html"));
}

async function expectReducedMotion(locator: Locator): Promise<void> {
  const maximumDuration = await locator.evaluate((element) => {
    const parseCssTime = (value: string): number => {
      const normalized = value.trim();
      if (normalized.endsWith("ms")) return Number.parseFloat(normalized);
      if (normalized.endsWith("s")) return Number.parseFloat(normalized) * 1_000;
      return Number.parseFloat(normalized) || 0;
    };
    const styles = getComputedStyle(element);
    const durations = [styles.animationDuration, styles.transitionDuration]
      .flatMap((value) => value.split(","))
      .map(parseCssTime);
    return Math.max(0, ...durations);
  });
  expect(maximumDuration).toBeLessThanOrEqual(1);
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
