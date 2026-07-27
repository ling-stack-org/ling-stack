import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, type MockState } from "./support/mock-state";
import {
  channelEventFilterToggle,
  channelEventFilters,
  openChannelChatTools,
} from "./support/test-helpers";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/conversations/channel-saved-view-dialog/",
  import.meta.url,
));

test("Saved Views create, rename, and delete use busy-safe shared Dialogs with retained failure", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const browserDialogs = collectBrowserDialogs(page);
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);

  let holdNextPatch = true;
  let releasePatch: (() => void) | undefined;
  let failNextPatch = false;
  await page.route(/\/workspace-settings(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    const patch = await route.request().postDataJSON() as Record<string, unknown>;
    if (!("channelActivityViews" in patch)) {
      await route.fallback();
      return;
    }
    if (holdNextPatch) {
      holdNextPatch = false;
      await new Promise<void>((resolve) => {
        releasePatch = resolve;
      });
    }
    if (failNextPatch) {
      failNextPatch = false;
      await route.fulfill({
        status: 503,
        json: { error: "saved_view_update_failed", message: "Saved view storage is temporarily unavailable." },
      });
      return;
    }
    await route.fallback();
  });

  await page.goto("/");
  const filters = await openSavedViewActions(page);
  const saveTrigger = filters.getByRole("button", { name: "Save view" });

  await saveTrigger.click();
  let dialog = page.getByRole("dialog", { name: "Save view" });
  let nameInput = dialog.getByRole("textbox", { name: "Saved view name" });
  await expect(nameInput).toBeFocused();
  await expectInputGeometryStable(
    nameInput,
    dialog.locator(".ling-ui-dialog-footer").getByRole("button", { name: "Cancel" }),
  );
  await nameInput.fill("Run failures draft");
  await captureEvidence(page, "1440x960-ling-light-create-draft.png");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(saveTrigger).toBeFocused();
  await expect(filters.getByRole("option", { name: /Run failures draft/u })).toHaveCount(0);

  await saveTrigger.click();
  dialog = page.getByRole("dialog", { name: "Save view" });
  nameInput = dialog.getByRole("textbox", { name: "Saved view name" });
  await nameInput.fill("Run failures");
  await nameInput.press("Enter");
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  releasePatch?.();
  await expect(dialog).toHaveCount(0);

  let reopenedFilters = await openSavedViewActions(page);
  await expect(reopenedFilters.getByRole("option", { name: /Run failures/u })).toHaveCount(1);
  await expect(reopenedFilters.getByRole("combobox", { name: "Saved views" })).toHaveValue(/custom:/u);

  failNextPatch = true;
  const renameTrigger = reopenedFilters.getByRole("button", { name: "Rename" });
  await renameTrigger.click();
  dialog = page.getByRole("dialog", { name: "Rename saved view" });
  nameInput = dialog.getByRole("textbox", { name: "Saved view name" });
  await expect(nameInput).toHaveValue("Run failures");
  await expectInputGeometryStable(
    nameInput,
    dialog.locator(".ling-ui-dialog-footer").getByRole("button", { name: "Cancel" }),
  );
  await nameInput.fill("Run problems");
  await nameInput.press("Enter");
  const failure = dialog.getByRole("alert");
  await expect(failure).toContainText("Saved view changes could not be saved. Try again.");
  await expect(nameInput).toHaveValue("Run problems");
  await expect(page.locator('.ling-ui-toast[data-scope*="saved-view"]')).toHaveCount(0);
  await page.waitForTimeout(350);
  await expect(failure).toBeVisible();
  await expect(page.locator(".inline-error")).toHaveCount(0);
  await captureEvidence(page, "1440x960-ling-light-rename-failure.png");

  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(dialog).toHaveCount(0);
  reopenedFilters = await openSavedViewActions(page);
  await expect(reopenedFilters.getByRole("option", { name: /Run problems/u })).toHaveCount(1);
  await expect(reopenedFilters.getByRole("option", { name: /Run failures/u })).toHaveCount(0);

  const deleteTrigger = reopenedFilters.getByRole("button", { name: "Delete view" });
  await deleteTrigger.click();
  dialog = page.getByRole("dialog", { name: "Delete saved view Run problems?" });
  await expect(dialog).toContainText("Channel activity is not deleted.");
  const deleteCancel = dialog.locator(".ling-ui-dialog-footer").getByRole("button", { name: "Cancel" });
  await expect(deleteCancel).toBeFocused();
  await captureEvidence(page, "1440x960-ling-light-delete-confirm.png");
  await deleteCancel.click();
  await expect(dialog).toHaveCount(0);
  await expect(deleteTrigger).toBeFocused();

  await deleteTrigger.click();
  dialog = page.getByRole("dialog", { name: "Delete saved view Run problems?" });
  await dialog.getByRole("button", { name: "Delete view" }).click();
  await expect(dialog).toHaveCount(0);
  const savedViewSelect = page.getByRole("combobox", { name: "Saved views" }).first();
  await expect(savedViewSelect).toHaveValue("builtin:all");
  await expect(savedViewSelect).toBeFocused();
  reopenedFilters = await openSavedViewActions(page);
  await expect(reopenedFilters.getByRole("option", { name: /Run problems/u })).toHaveCount(0);

  await expectNoOverflow(page);
  expect(browserDialogs).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

test("eight-view limit stays disabled and the defensive path uses a five-second warning Toast", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, reducedMotion: true });
  const runtimeErrors = collectRuntimeErrors(page);
  const browserDialogs = collectBrowserDialogs(page);
  const state = createBaseState({ approvalStatus: "expired" });
  state.workspaceSettings = {
    ...state.workspaceSettings,
    channelActivityViews: {
      channel_engineering: Array.from({ length: 7 }, (_, index) => savedViewFixture(index + 1)),
    },
  };
  await mockDaemon(page, state);
  await page.goto("/");

  const filters = await openSavedViewActions(page);
  const saveTrigger = filters.getByRole("button", { name: "Save view" });
  await expect(saveTrigger).toBeEnabled();
  await saveTrigger.click();
  const dialog = page.getByRole("dialog", { name: "Save view" });
  await dialog.getByRole("textbox", { name: "Saved view name" }).fill("Race view");

  state.workspaceSettings = {
    ...state.workspaceSettings,
    channelActivityViews: {
      channel_engineering: Array.from({ length: 8 }, (_, index) => savedViewFixture(index + 1)),
    },
  };
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(filters.locator('select[aria-label="Saved views"] option')).toHaveCount(15);
  await dialog.getByRole("textbox", { name: "Saved view name" }).press("Enter");
  await expect(dialog).toHaveCount(0);
  const warning = page.locator('.ling-ui-toast[data-scope="channel:channel_engineering:saved-view-limit"]');
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAttribute("data-tone", "warning");
  await expect(warning).toContainText("Custom saved views are limited to 8.");
  await expect.poll(() => warning.evaluate((element) => getComputedStyle(element).animationDuration)).toBe("0.001s");
  const limitedFilters = await openSavedViewActions(page);
  const limitedSaveTrigger = limitedFilters.getByRole("button", { name: "Save view" });
  await expect(limitedSaveTrigger).toBeDisabled();
  await expect(limitedSaveTrigger).toHaveAttribute("title", "Custom saved views are limited to 8.");
  await captureEvidence(page, "1280x800-ling-dark-limit-warning-toast.png");
  await page.waitForTimeout(3_200);
  await expect(warning).toBeVisible();
  await expect(warning).toHaveCount(0, { timeout: 3_000 });
  await expect(limitedFilters.getByRole("combobox", { name: "Saved views" }).getByRole("option")).toHaveCount(15);

  await expectNoOverflow(page);
  expect(browserDialogs).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

async function openSavedViewActions(page: Page): Promise<Locator> {
  await openChannelChatTools(page);
  const filters = channelEventFilters(page).first();
  const panel = filters.locator(".activity-filter-panel");
  if (!await panel.isVisible().catch(() => false)) {
    await channelEventFilterToggle(filters).click();
  }
  await expect(panel).toBeVisible();
  return filters;
}

function savedViewFixture(index: number): Record<string, unknown> {
  return {
    id: `custom:limit-${index}`,
    name: `Limit view ${index}`,
    filter: { attentionFilter: "all", categoryFilter: "all", search: `limit-${index}` },
    builtin: false,
    createdAt: `2026-07-${String(index).padStart(2, "0")}T00:00:00.000Z`,
    updatedAt: `2026-07-${String(index).padStart(2, "0")}T00:00:00.000Z`,
  };
}

async function prepareSurface(page: Page, input: {
  readonly theme: "light" | "dark";
  readonly width: number;
  readonly height: number;
  readonly reducedMotion?: boolean;
}): Promise<void> {
  await page.setViewportSize({ width: input.width, height: input.height });
  await page.emulateMedia({ colorScheme: input.theme, reducedMotion: input.reducedMotion ? "reduce" : "no-preference" });
  await page.addInitScript((theme) => {
    const selection = { mode: "fixed", themeId: `ling-${theme}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", theme);
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, input.theme);
}

function collectBrowserDialogs(page: Page): string[] {
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  return dialogs;
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

async function expectNoOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  const dialogs = page.locator('[data-ui2-channel-saved-view-dialog]');
  for (let index = 0; index < await dialogs.count(); index += 1) {
    expect(await dialogs.nth(index).evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
}

interface InputGeometrySnapshot {
  readonly shell: InputGeometryTarget;
  readonly native: InputGeometryTarget;
}

interface InputGeometryTarget {
  readonly rect: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
    readonly width: number;
    readonly height: number;
  };
  readonly boxSizing: string;
  readonly borderTopWidth: string;
  readonly borderBottomWidth: string;
  readonly outlineStyle: string;
  readonly outlineWidth: string;
  readonly outlineOffset: string;
  readonly boxShadow: string;
  readonly lineHeight: string;
}

async function expectInputGeometryStable(
  input: Locator,
  blurTarget: Locator,
): Promise<{ readonly unfocused: InputGeometrySnapshot; readonly focused: InputGeometrySnapshot }> {
  await input.evaluate(async (native) => {
    const dialog = native.closest<HTMLElement>(".ling-ui-dialog-content");
    await Promise.all((dialog?.getAnimations() ?? []).map(async (animation) => {
      await animation.finished.catch(() => undefined);
    }));
  });
  await blurTarget.focus();
  await expect(blurTarget).toBeFocused();
  const unfocused = await measureInputGeometry(input);

  await input.focus();
  await expect(input).toBeFocused();
  const focused = await measureInputGeometry(input);

  for (const snapshot of [unfocused, focused]) {
    expect(snapshot.shell.boxSizing).toBe("border-box");
    expect(snapshot.native.boxSizing).toBe("border-box");
    expect(snapshot.native.rect.top).toBeGreaterThanOrEqual(snapshot.shell.rect.top);
    expect(snapshot.native.rect.bottom).toBeLessThanOrEqual(snapshot.shell.rect.bottom);
    expect(snapshot.native.borderTopWidth).toBe("0px");
    expect(snapshot.native.borderBottomWidth).toBe("0px");
    expect(snapshot.native.outlineStyle).toBe("none");
    expect(snapshot.native.outlineWidth).toBe("0px");
    expect(snapshot.native.boxShadow).toBe("none");
    expect(Number.parseFloat(snapshot.native.lineHeight)).toBeLessThanOrEqual(snapshot.shell.rect.height - 8);
  }
  expect(focused.shell.rect.height).toBeCloseTo(unfocused.shell.rect.height, 5);
  expect(focused.native.rect.height).toBeCloseTo(unfocused.native.rect.height, 5);
  expect(focused.shell.rect.top).toBeCloseTo(unfocused.shell.rect.top, 5);
  expect(focused.shell.rect.bottom).toBeCloseTo(unfocused.shell.rect.bottom, 5);
  expect(focused.native.rect.top).toBeCloseTo(unfocused.native.rect.top, 5);
  expect(focused.native.rect.bottom).toBeCloseTo(unfocused.native.rect.bottom, 5);
  expect(focused.shell.boxShadow).toContain("inset");

  return { unfocused, focused };
}

async function measureInputGeometry(input: Locator): Promise<InputGeometrySnapshot> {
  return input.evaluate((native) => {
    const shell = native.closest<HTMLElement>(".ling-ui-input");
    if (!shell) throw new Error("Saved View Input is missing its .ling-ui-input shell.");

    const measure = (element: HTMLElement): InputGeometryTarget => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        rect: {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
          width: rect.width,
          height: rect.height,
        },
        boxSizing: style.boxSizing,
        borderTopWidth: style.borderTopWidth,
        borderBottomWidth: style.borderBottomWidth,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineOffset: style.outlineOffset,
        boxShadow: style.boxShadow,
        lineHeight: style.lineHeight,
      };
    };

    return { shell: measure(shell), native: measure(native) };
  });
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", fullPage: true, path: `${evidenceDirectory}${filename}` });
}
