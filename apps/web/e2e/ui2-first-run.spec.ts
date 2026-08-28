import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createChatProvider } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/quick-theme-first-run/",
  import.meta.url,
));

test("First Run opens softly, skip survives refresh, and leaves the application usable", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [];
  await mockDaemon(page, state, { firstRunPreference: "unset" });
  await page.goto("/");

  const dialog = page.getByRole("dialog", { name: "Get started with Ling" });
  await expect(dialog).toBeVisible();
  await page.screenshot({ animations: "disabled", path: `${evidenceDirectory}1440x960-ling-light-first-run.png` });
  await expect(dialog.getByRole("button", { name: "Skip for now" }).last()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Ling Stack navigation")).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ling-first-run:v1") ?? "null")?.status)).toBe("skipped");

  await page.evaluate(() => localStorage.removeItem("ling-first-run:v1"));
  await page.reload();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Skip for now" }).last().click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Ling Stack navigation")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("dialog", { name: "Get started with Ling" })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("ling-first-run:v1") ?? "null")?.status)).toBe("skipped");
});

test("First Run remains readable in compact dark mode", async ({ page }) => {
  await useEnglishLocale(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [];
  state.workspaceSettings.theme = "dark";
  await mockDaemon(page, state, { firstRunPreference: "unset" });
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("data-ui-theme", "ling-dark");
  await expect(page.getByRole("dialog", { name: "Get started with Ling" })).toBeVisible();
  await page.screenshot({ animations: "disabled", path: `${evidenceDirectory}1280x800-ling-dark-first-run.png` });
});

test("First Run step labels keep horizontal reading order across locales", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [];
  await mockDaemon(page, state, { firstRunPreference: "unset" });
  await page.goto("/");

  for (const locale of ["zh-CN", "fr-FR"] as const) {
    await page.evaluate((nextLocale) => localStorage.setItem("ling-stack.locale", nextLocale), locale);
    await page.reload();
    await expect(page.locator(".first-run-dialog-steps")).toBeVisible();
    const geometry = await readStepGeometry(page);
    expect(geometry.labels).toHaveLength(3);
    expect(geometry.labels.every((label) => label.singleLine && label.whiteSpace === "nowrap")).toBe(true);
    expect(geometry.connectors.every((width) => width >= 24)).toBe(true);
    expect(geometry.hasHorizontalOverflow).toBe(false);
  }

  await page.setViewportSize({ width: 460, height: 800 });
  const compactGeometry = await readStepGeometry(page);
  expect(compactGeometry.layout).toBe("grid");
  expect(compactGeometry.labels.every((label) => label.singleLine)).toBe(true);
  expect(compactGeometry.hasHorizontalOverflow).toBe(false);
});

test("First Run stays silent for a ready installation and records completion", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    lastCheck: { ok: true, message: "ok", checkedAt: "2026-07-30T00:00:00.000Z" },
  })];
  await mockDaemon(page, state, { firstRunPreference: "unset" });
  await page.goto("/");

  await expect(page.getByRole("dialog", { name: "Get started with Ling" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("ling-first-run:v1") ?? "null")?.status)).toBe("completed");
});

test("First Run sends model repair to the existing Model Workbench owner", async ({ page }) => {
  await useEnglishLocale(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [];
  await mockDaemon(page, state, { firstRunPreference: "unset" });
  await page.goto("/");

  const dialog = page.getByRole("dialog", { name: "Get started with Ling" });
  await expect(dialog).toContainText("Connect a model");
  await dialog.getByRole("button", { name: "Open Model Workbench" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("Settings sections").getByRole("button", { name: /Model Workbench/ })).toHaveClass(/active/);
});

async function useEnglishLocale(page: import("@playwright/test").Page): Promise<void> {
  await useLocale(page, "en-US");
}

async function useLocale(page: import("@playwright/test").Page, locale: string): Promise<void> {
  await page.addInitScript((selectedLocale) => localStorage.setItem("ling-stack.locale", selectedLocale), locale);
}

async function readStepGeometry(page: import("@playwright/test").Page): Promise<{
  readonly connectors: readonly number[];
  readonly hasHorizontalOverflow: boolean;
  readonly labels: readonly {
    readonly singleLine: boolean;
    readonly text: string;
    readonly whiteSpace: string;
  }[];
  readonly layout: string;
}> {
  return page.evaluate(() => {
    const stepper = document.querySelector<HTMLElement>(".first-run-dialog-steps");
    if (!stepper) throw new Error("missing first run stepper");
    const items = [...stepper.querySelectorAll<HTMLElement>("li")];
    return {
      connectors: items.slice(0, -1).map((item) => Number.parseFloat(getComputedStyle(item, "::after").width)),
      hasHorizontalOverflow: stepper.scrollWidth > stepper.clientWidth,
      labels: items.map((item) => {
        const label = item.querySelector<HTMLElement>("span");
        if (!label) throw new Error("missing first run step label");
        const textRange = document.createRange();
        textRange.selectNodeContents(label);
        const style = getComputedStyle(label);
        return {
          singleLine: textRange.getClientRects().length <= 1,
          text: label.textContent ?? "",
          whiteSpace: style.whiteSpace,
        };
      }),
      layout: getComputedStyle(stepper).display,
    };
  });
}
