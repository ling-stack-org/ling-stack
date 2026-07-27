import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { seedImportedQuietOcean } from "./support/media-jobs-fixtures";
import { createBaseState } from "./support/mock-state";
import { openChannelContextPanel } from "./support/test-helpers";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/channel-task-strip-legacy-writer/",
  import.meta.url,
));

// Reachability map: Runtime renders seven heads, Protocol renders two, and
// Routing renders one. Together these are all ten current production consumers.
test("1440x960 Ling Light keeps all Runtime task-strip heads aligned and token-owned", async ({ page }) => {
  await prepareSurface(page, { width: 1440, height: 960, theme: "light" });
  const runtime = watchRuntime(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "pending" }));
  await page.goto("/");

  const inspector = await openInspectorMode(page, "Runtime");
  const heads = inspector.locator(".task-strip-head:visible");
  await expectTaskStripHeadContract(heads, 7);
  await expectUsesSemanticToken(
    heads.first().locator("strong"),
    "color",
    "--text-strong",
  );

  await expectNoHorizontalOverflow(inspector);
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1440x960-ling-light-runtime-diagnostics.png");
  runtime.expectClean();
});

test("1280x800 Ling Dark covers Protocol, Routing, focus containment, long text, and reduced motion", async ({ page }) => {
  await prepareSurface(page, {
    width: 1280,
    height: 800,
    theme: "dark",
    reducedMotion: true,
  });
  const runtime = watchRuntime(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "pending" }));
  await page.goto("/");

  const protocol = await openInspectorMode(page, "Protocol");
  const protocolHeads = protocol.locator(".task-strip-head:visible");
  await expectTaskStripHeadContract(protocolHeads, 2);
  await expectUsesSemanticToken(
    protocolHeads.first().locator("strong"),
    "color",
    "--text-strong",
  );
  await expectUsesSemanticToken(
    protocol.locator(".protocol-row").first(),
    "border-top-color",
    "--border",
  );

  const select = protocol.getByRole("combobox", { name: "AI response language" });
  const selectShell = select.locator("xpath=ancestor::span[contains(@class, 'ling-ui-select')]");
  await expect(selectShell).toHaveAttribute("data-size", "md");
  expect(await selectShell.evaluate((element) => element.hasAttribute("data-select-control"))).toBe(false);
  await expectFocusedControlContained(select, selectShell);

  const longTextHead = protocolHeads.filter({ hasText: "Read-only protocol defaults" });
  await expect(longTextHead).toHaveCount(1);
  await stressExistingHeaderWithLongEnglish(longTextHead);
  await expectNoHorizontalOverflow(protocol);
  await expectNoDocumentOverflow(page);

  const routing = await openInspectorMode(page, "Routing");
  await expectTaskStripHeadContract(routing.locator(".task-strip-head:visible"), 1);
  await expectUsesSemanticToken(
    routing.locator(".task-strip-head strong"),
    "color",
    "--text-strong",
  );

  const dock = page.getByRole("complementary", { name: "Channel workspace dock" });
  await expect.poll(() => page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  const durations = await dock.evaluate((element) => getComputedStyle(element).transitionDuration.split(", "));
  expect(durations.every((duration) => duration === "0s")).toBe(true);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-routing-protocol.png");
  runtime.expectClean();
});

test("1440x960 imported Quiet Ocean owns Runtime text and boundaries without overflow", async ({ page }) => {
  await prepareSurface(page, { width: 1440, height: 960, theme: "light" });
  const runtime = watchRuntime(page);
  await mockDaemon(page, createBaseState({ approvalStatus: "pending" }));
  await page.goto("/");
  const themeId = await seedImportedQuietOcean(page);
  await page.reload();

  const inspector = await openInspectorMode(page, "Runtime");
  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", themeId);
  const heads = inspector.locator(".task-strip-head:visible");
  await expectTaskStripHeadContract(heads, 7);
  await expectUsesSemanticToken(
    heads.first().locator("strong"),
    "color",
    "--text-strong",
  );

  await openInspectorMode(page, "Protocol");
  const protocol = page.getByRole("region", { name: "Channel inspector" });
  await expectUsesSemanticToken(
    protocol.locator(".protocol-row").first(),
    "border-top-color",
    "--border",
  );
  await expectNoHorizontalOverflow(protocol);
  await expectNoDocumentOverflow(page);
  await captureEvidence(page, "1440x960-quiet-ocean-protocol.png");
  runtime.expectClean();
});

async function prepareSurface(
  page: Page,
  options: {
    readonly width: number;
    readonly height: number;
    readonly theme: "light" | "dark";
    readonly reducedMotion?: boolean;
  },
): Promise<void> {
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.emulateMedia({ reducedMotion: options.reducedMotion ? "reduce" : "no-preference" });
  await page.addInitScript((theme) => {
    if (sessionStorage.getItem("ling-stack.e2eThemeSelection")) return;
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, options.theme);
}

async function openInspectorMode(
  page: Page,
  mode: "Protocol" | "Routing" | "Runtime",
): Promise<Locator> {
  await openChannelContextPanel(page);
  const dock = page.getByRole("complementary", { name: "Channel workspace dock" });
  const modes = page.getByLabel("Channel inspector modes");
  if (!await modes.isVisible().catch(() => false)) {
    await dock.getByRole("button", { name: "Activity" }).click();
  }
  await modes.getByRole("button", { name: mode, exact: true }).click();
  const inspector = page.getByRole("region", { name: "Channel inspector" });
  await expect(inspector).toBeVisible();
  await expect(modes.getByRole("button", { name: mode, exact: true })).toHaveClass(/active/u);
  return inspector;
}

async function expectTaskStripHeadContract(heads: Locator, expectedCount: number): Promise<void> {
  await expect(heads).toHaveCount(expectedCount);
  const metrics = await heads.evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return {
      alignItems: style.alignItems,
      clientWidth: element.clientWidth,
      display: style.display,
      gap: style.gap,
      justifyContent: style.justifyContent,
      scrollWidth: element.scrollWidth,
    };
  }));
  expect(metrics.every((item) => item.display === "flex")).toBe(true);
  expect(metrics.every((item) => item.alignItems === "center")).toBe(true);
  expect(metrics.every((item) => item.justifyContent === "space-between")).toBe(true);
  expect(new Set(metrics.map((item) => item.gap))).toEqual(new Set(["10px"]));
  expect(metrics.every((item) => item.scrollWidth <= item.clientWidth + 1)).toBe(true);
}

async function expectUsesSemanticToken(
  locator: Locator,
  property: "border-top-color" | "color",
  token: "--border" | "--text-strong",
): Promise<void> {
  await expect(locator).toBeVisible();
  const result = await locator.evaluate((element, input) => {
    const probe = document.createElement("span");
    probe.style.setProperty(input.property, `var(${input.token})`);
    document.body.append(probe);
    const actual = getComputedStyle(element).getPropertyValue(input.property);
    const expected = getComputedStyle(probe).getPropertyValue(input.property);
    probe.remove();
    return { actual, expected };
  }, { property, token });
  expect(result.actual).toBe(result.expected);
}

async function expectFocusedControlContained(control: Locator, shell: Locator): Promise<void> {
  await expect(control).toHaveAttribute("data-ling-control-native", "true");
  const heightBeforeFocus = await shell.evaluate((element) => element.getBoundingClientRect().height);
  await control.focus();
  await expect(control).toBeFocused();
  const geometry = await control.evaluate((element) => {
    const container = element.closest(".ling-ui-select");
    if (!container) throw new Error("Shared Select shell is missing");
    const controlBox = element.getBoundingClientRect();
    const shellBox = container.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      borderTopWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
      controlBottom: controlBox.bottom,
      controlTop: controlBox.top,
      shellBottom: shellBox.bottom,
      shellTop: shellBox.top,
    };
  });
  expect(await shell.evaluate((element) => element.getBoundingClientRect().height)).toBe(heightBeforeFocus);
  expect(geometry.borderTopWidth).toBe("0px");
  expect(geometry.boxShadow).toBe("none");
  expect(geometry.controlTop).toBeGreaterThanOrEqual(geometry.shellTop);
  expect(geometry.controlBottom).toBeLessThanOrEqual(geometry.shellBottom);
}

async function stressExistingHeaderWithLongEnglish(head: Locator): Promise<void> {
  const strong = head.locator("strong");
  const original = await strong.textContent();
  await strong.evaluate((element) => {
    element.textContent = "Read-only protocol defaults with an intentionally long English heading for containment verification";
  });
  await expectNoHorizontalOverflow(head);
  const geometry = await strong.evaluate((element) => {
    const header = element.closest(".task-strip-head");
    if (!header) throw new Error("Production task-strip head is missing");
    const headerBox = header.getBoundingClientRect();
    const textBox = element.getBoundingClientRect();
    return {
      headerLeft: headerBox.left,
      headerRight: headerBox.right,
      textLeft: textBox.left,
      textRight: textBox.right,
    };
  });
  expect(geometry.textLeft).toBeGreaterThanOrEqual(geometry.headerLeft - 1);
  expect(geometry.textRight).toBeLessThanOrEqual(geometry.headerRight + 1);
  await strong.evaluate((element, text) => {
    element.textContent = text;
  }, original ?? "Read-only protocol defaults");
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const geometry = await locator.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ))).toBeLessThanOrEqual(1);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: `${evidenceDirectory}${filename}`,
  });
}

function watchRuntime(page: Page): {
  readonly expectClean: () => void;
} {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    expectClean: () => {
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    },
  };
}
