import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import {
  captureCouncilSettingsEvidence,
  collectCouncilRuntimeErrors,
  createCouncilSettingsArchiveRouteControl,
  createCouncilSettingsArchiveState,
  expectCouncilSurfaceNoOverflow,
  mockCouncilSettingsArchiveDaemon,
  openCouncilSettings,
  prepareCouncilSettingsSurface,
  readCouncilName,
  readCouncilStatus,
} from "./support/council-settings-archive-fixture";
import { isRecord } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/council-settings-archive/",
  import.meta.url,
));

test("custom settings move from clean to dirty and Reset restores authority without PATCH", async ({ page }) => {
  await prepareCouncilSettingsSurface(page, { height: 960, locale: "en-US", theme: "light", width: 1440 });
  const runtimeErrors = collectCouncilRuntimeErrors(page);
  const state = createCouncilSettingsArchiveState();
  const control = createCouncilSettingsArchiveRouteControl();
  await mockCouncilSettingsArchiveDaemon(page, state, control);
  await page.goto("/");

  const { panel } = await openCouncilSettings(page);
  const name = panel.getByLabel("Council name");
  const description = panel.getByLabel("Council description");
  const pinned = panel.getByRole("switch", { name: "Pin council" });
  const save = panel.getByRole("button", { name: "Save council settings" });
  const reset = panel.getByRole("button", { name: "Reset" });
  await expect(name).toHaveValue("Product Review Council");
  await expect(save).toBeDisabled();
  await expect(reset).toBeDisabled();
  await expect(panel.locator(".council-settings-archive-boundaries")).not.toHaveAttribute("open", "");
  await expect(panel.getByRole("button", { name: /Delete council/i })).toHaveCount(0);

  await name.fill("Product Review Council with a long retained settings draft");
  await description.fill("Long settings content retained until the user saves or resets the draft.");
  await pinned.click();
  await expect(save).toBeEnabled();
  await expect(reset).toBeEnabled();
  await captureCouncilSettingsEvidence(page, evidenceDirectory, "1440x960-ling-light-settings-dirty.png");

  await reset.click();
  await expect(name).toHaveValue("Product Review Council");
  await expect(description).toHaveValue("A custom Council used for settings and archive verification.");
  await expect(pinned).toBeChecked();
  await expect(save).toBeDisabled();
  expect(control.patchRequests).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

test("save failure retains the Chinese draft and Retry stays single-flight through stale refresh", async ({ page }) => {
  await prepareCouncilSettingsSurface(page, { height: 800, locale: "zh-CN", reducedMotion: "reduce", theme: "dark", width: 1280 });
  const runtimeErrors = collectCouncilRuntimeErrors(page);
  const state = createCouncilSettingsArchiveState();
  const control = createCouncilSettingsArchiveRouteControl();
  control.failNextPatchMessage = "Synthetic settings save failure";
  await mockCouncilSettingsArchiveDaemon(page, state, control);
  await page.goto("/");

  const { panel } = await openCouncilSettings(page, /Product Review Council/);
  const name = panel.getByLabel("智囊团名称");
  const description = panel.getByLabel("智囊团描述");
  const save = panel.getByRole("button", { name: "保存智囊团设置" });
  const reset = panel.getByRole("button", { name: "重置" });
  const nextName = "产品审阅智囊团设置草稿，验证较长中文名称在失败后仍然保留";
  const nextDescription = "保存失败以后继续保留名称、描述与置顶选择，用户可以原地重试。";
  await name.fill(nextName);
  await description.fill(nextDescription);
  await save.click();
  await expect(panel.getByRole("alert")).toContainText("Synthetic settings save failure");
  await expect(name).toHaveValue(nextName);
  await expect(description).toHaveValue(nextDescription);
  await captureCouncilSettingsEvidence(page, evidenceDirectory, "1280x800-ling-dark-zh-save-failure.png");

  state.failNextAiCouncilList = { error: "synthetic_list_failure", message: "Synthetic retained list failure" };
  state.failNextAiCouncilHealth = { error: "synthetic_health_failure", message: "Synthetic retained health failure" };
  control.patchDelayMs = 260;
  await save.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect(save).toHaveAttribute("aria-busy", "true");
  await expect(reset).toBeDisabled();
  await expect.poll(() => control.patchRequests.length).toBe(2);
  await expect.poll(() => readCouncilName(state, "council_settings_custom")).toBe(nextName);
  await expect(page.getByLabel(/Notifications|通知/)).toContainText(/Saved|已保存/);
  await expect(panel.getByLabel("智囊团名称")).toHaveValue(nextName);
  await expect(panel.getByRole("button", { name: "保存智囊团设置" })).toBeDisabled();
  expect(state.failNextAiCouncilList).toBeUndefined();
  expect(state.failNextAiCouncilHealth).toBeUndefined();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  expect(control.patchRequests[1]).toEqual({
    councilId: "council_settings_custom",
    payload: { description: nextDescription, displayName: nextName, pinned: true },
  });
  await expectCouncilSurfaceNoOverflow(page, panel);
  expect(runtimeErrors).toEqual([]);
});

test("lifecycle failure is scoped and preserves a dirty settings draft before pause and resume", async ({ page }) => {
  await prepareCouncilSettingsSurface(page, { height: 960, locale: "en-US", theme: "light", width: 1440 });
  const runtimeErrors = collectCouncilRuntimeErrors(page);
  const state = createCouncilSettingsArchiveState();
  const control = createCouncilSettingsArchiveRouteControl();
  control.failNextPatchMessage = "Synthetic pause failure";
  await mockCouncilSettingsArchiveDaemon(page, state, control);
  await page.goto("/");

  const { panel } = await openCouncilSettings(page);
  const name = panel.getByLabel("Council name");
  await name.fill("Unsaved lifecycle-safe draft");
  await panel.getByRole("button", { name: "Pause council" }).click();
  const lifecycle = panel.locator(".council-settings-archive-lifecycle");
  await expect(lifecycle.getByRole("alert")).toContainText("Synthetic pause failure");
  await expect(name).toHaveValue("Unsaved lifecycle-safe draft");
  await expect.poll(() => readCouncilStatus(state, "council_settings_custom")).toBe("active");

  await lifecycle.getByRole("button", { name: "Pause council" }).click();
  await expect.poll(() => readCouncilStatus(state, "council_settings_custom")).toBe("paused");
  await expect(panel.getByRole("button", { name: "Resume council" })).toBeVisible();
  await expect(name).toHaveValue("Unsaved lifecycle-safe draft");
  await panel.getByRole("button", { name: "Resume council" }).click();
  await expect.poll(() => readCouncilStatus(state, "council_settings_custom")).toBe("active");
  await expect(name).toHaveValue("Unsaved lifecycle-safe draft");
  expect(control.patchRequests.map((request) => request.payload)).toEqual([
    { status: "paused" },
    { status: "paused" },
    { status: "active" },
  ]);
  expect(runtimeErrors).toEqual([]);
});

test("builtin and template Councils expose managed read-only Danger boundaries and no Delete", async ({ page }) => {
  await prepareCouncilSettingsSurface(page, { height: 960, locale: "en-US", theme: "light", width: 1440 });
  const runtimeErrors = collectCouncilRuntimeErrors(page);
  const state = createCouncilSettingsArchiveState();
  const control = createCouncilSettingsArchiveRouteControl();
  await mockCouncilSettingsArchiveDaemon(page, state, control);
  await page.goto("/");

  let { panel, surface } = await openCouncilSettings(page, /Managed Development Council/);
  await expect(panel).toHaveAttribute("data-managed", "true");
  await expect(panel.getByText("Built-in councils must be cloned before editing", { exact: true }).first()).toBeVisible();
  await expect(panel.getByLabel("Council name")).toHaveCount(0);
  await panel.getByText("More council actions").click();
  await expect(panel.getByRole("button", { name: "Clone council" })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Archive council" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /Delete/i })).toHaveCount(0);
  await captureCouncilSettingsEvidence(page, evidenceDirectory, "1440x960-ling-light-managed-boundary.png");

  await surface.locator(".council-list-health-row").filter({ hasText: "Template Advisory Council" }).click();
  await surface.getByRole("tab", { name: "Council settings" }).click();
  panel = surface.locator("[data-ui2-council-settings-archive='true']");
  await expect(panel).toHaveAttribute("data-managed", "true");
  await expect(panel.getByRole("button", { name: "Archive council" })).toHaveCount(0);
  expect(control.patchRequests).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

test("Archive confirmation uses one Portal and Esc, Close, and Cancel restore trigger focus", async ({ page }) => {
  await prepareCouncilSettingsSurface(page, { height: 960, locale: "en-US", theme: "dark", width: 1440 });
  const runtimeErrors = collectCouncilRuntimeErrors(page);
  const state = createCouncilSettingsArchiveState();
  const control = createCouncilSettingsArchiveRouteControl();
  await mockCouncilSettingsArchiveDaemon(page, state, control);
  await page.goto("/");

  const { panel } = await openCouncilSettings(page);
  const trigger = panel.getByRole("button", { name: "Archive council" });
  await trigger.click();
  let dialog = page.getByRole("dialog", { name: "Archive council" });
  await expect(dialog).toBeVisible();
  await expect(page.locator("#ling-ui-overlay-root")).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(dialog.getByRole("button", { name: /Delete/i })).toHaveCount(0);
  await captureCouncilSettingsEvidence(page, evidenceDirectory, "1440x960-ling-dark-archive-confirm.png");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  dialog = page.getByRole("dialog", { name: "Archive council" });
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  dialog = page.getByRole("dialog", { name: "Archive council" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(trigger).toBeFocused();
  expect(control.patchRequests).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

test("Archive failure retains state; busy locks dismissal; success cleans Council channel references", async ({ page }) => {
  await prepareCouncilSettingsSurface(page, { height: 800, locale: "en-US", theme: "light", width: 1280 });
  const runtimeErrors = collectCouncilRuntimeErrors(page);
  const state = createCouncilSettingsArchiveState();
  const directMemberships = structuredClone(state.teammateChannelMemberships);
  const control = createCouncilSettingsArchiveRouteControl();
  control.failNextPatchMessage = "Synthetic archive failure";
  await mockCouncilSettingsArchiveDaemon(page, state, control);
  await page.goto("/");

  const { panel, surface } = await openCouncilSettings(page);
  await panel.getByLabel("Council name").fill("Retained draft before archive");
  await panel.getByRole("button", { name: "Archive council" }).click();
  let dialog = page.getByRole("dialog", { name: "Archive council" });
  await dialog.getByRole("button", { name: "Archive council" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Synthetic archive failure");
  await expect(surface.getByLabel("Selected council")).toContainText("Product Review Council");
  await captureCouncilSettingsEvidence(page, evidenceDirectory, "1280x800-ling-light-archive-failure.png");

  control.patchDelayMs = 300;
  const confirm = dialog.getByRole("button", { name: "Archive council" });
  await confirm.evaluate((element) => {
    (element as HTMLButtonElement).click();
    (element as HTMLButtonElement).click();
  });
  await expect(confirm).toHaveAttribute("aria-busy", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect.poll(() => control.patchRequests.length).toBe(2);
  await expect.poll(() => readCouncilStatus(state, "council_settings_custom")).toBe("archived");
  await expect(dialog).toHaveCount(0);
  await expect(surface.locator(".council-list-health-row").filter({ hasText: "Product Review Council" })).toHaveCount(0);
  await expect(surface.getByLabel("Search councils")).toBeFocused();
  expect(state.channelCouncilPolicies.every((policy) => (
    !isRecord(policy) || !Array.isArray(policy.attachedCouncilIds) || !policy.attachedCouncilIds.includes("council_settings_custom")
  ))).toBe(true);
  expect(state.teammateChannelMemberships).toEqual(directMemberships);
  expect(control.patchRequests.map((request) => request.payload)).toEqual([
    { status: "archived" },
    { status: "archived" },
  ]);
  expect(runtimeErrors).toEqual([]);
});

test("100 Council rows, long Chinese text, and reduced motion stay inside 1280 boundaries", async ({ page }) => {
  await prepareCouncilSettingsSurface(page, { height: 800, locale: "zh-CN", reducedMotion: "reduce", theme: "dark", width: 1280 });
  const runtimeErrors = collectCouncilRuntimeErrors(page);
  const state = createCouncilSettingsArchiveState(100);
  const custom = state.aiCouncils.find((item) => isRecord(item) && item.id === "council_settings_custom");
  if (isRecord(custom)) {
    custom.displayName = "用于验证一百行智囊团列表、超长名称、设置表单和危险操作边界的产品审阅智囊团";
    custom.description = "这是一段较长的中文描述，用来验证 1280 像素宽度下文本不会覆盖按钮、状态或后续内容。";
  }
  const control = createCouncilSettingsArchiveRouteControl();
  await mockCouncilSettingsArchiveDaemon(page, state, control);
  await page.goto("/");

  const { panel, surface } = await openCouncilSettings(page, /用于验证一百行智囊团列表/);
  const rows = surface.locator(".council-list-health-row");
  await expect(rows).toHaveCount(100);
  const list = surface.getByLabel("智囊团结果");
  const listMetrics = await list.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    overflowY: getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
    scrollWidth: element.scrollWidth,
  }));
  expect(["auto", "scroll"]).toContain(listMetrics.overflowY);
  expect(listMetrics.scrollHeight).toBeGreaterThan(listMetrics.clientHeight);
  expect(listMetrics.scrollWidth).toBeLessThanOrEqual(listMetrics.clientWidth + 1);
  await expect(panel.locator(".council-settings-archive-boundaries")).not.toHaveAttribute("open", "");
  await expect(panel.getByRole("button", { name: /删除|Delete/ })).toHaveCount(0);
  await captureCouncilSettingsEvidence(page, evidenceDirectory, "1280x800-ling-dark-100-row-reduced-motion.png");
  await expectCouncilSurfaceNoOverflow(page, panel);
  expect(runtimeErrors).toEqual([]);
});
