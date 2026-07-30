import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, isRecord, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/settings/skill-library/",
  import.meta.url,
));

test("Skill Library keeps loading, no-result, shared controls, and editor geometry inside the Settings shell", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "light", "en-US", 1440, 960);
  const state = createBaseState({ approvalStatus: "pending" });
  addUserSkill(state, "ui2-long-skill", "UI2 Skill With A Deliberately Long Name That Must Truncate Without Moving Actions");
  await mockDaemon(page, state);
  const listGate = deferred();
  let holdList = true;
  await page.route("**/skills?**", async (route) => {
    if (holdList) await listGate.promise;
    await route.fallback();
  });
  await page.goto("/");
  const panel = await openSkillLibrary(page);

  await expect(panel.locator(".settings-skill-registry-loading")).toBeVisible();
  await expect(panel.locator(".settings-skill-registry-loading .ling-ui-skeleton")).toHaveCount(4);
  holdList = false;
  listGate.resolve();
  const row = panel.locator('[data-skill-id="ui2-long-skill"]');
  await expect(row).toBeVisible();
  const compactTable = panel.locator(".settings-skill-table-wrap");
  const compactGeometry = await compactTable.evaluate((container) => {
    const table = container.querySelector("table");
    const containerRect = container.getBoundingClientRect();
    const borderRight = Number.parseFloat(getComputedStyle(container).borderRightWidth);
    return {
      backgroundGap: table ? Math.abs((containerRect.right - borderRight) - table.getBoundingClientRect().right) : Number.POSITIVE_INFINITY,
      scrollbarGutter: getComputedStyle(container).scrollbarGutter,
    };
  });
  expect(compactGeometry.scrollbarGutter).toBe("auto");
  expect(compactGeometry.backgroundGap).toBeLessThanOrEqual(1);
  await expect(panel.locator(".settings-skill-overlay-scrollbar")).toHaveAttribute("data-overflow", "false");
  await expect(panel.locator(".settings-skill-search")).toHaveClass(/\bling-ui-input\b/);
  await expect(panel.locator(".settings-skill-sort")).toHaveClass(/\bling-ui-select\b/);
  await expect(panel.getByRole("button", { name: "Import skill" })).toHaveAttribute("data-variant", "secondary");
  await expect(panel.locator(".secondary-button, .primary-button, .settings-inline-tip, .settings-inline-success")).toHaveCount(0);

  const search = panel.getByRole("textbox", { name: "Search skills or tools" });
  await search.fill("not-a-real-skill");
  await expect(panel.getByText("No skills match these filters", { exact: true })).toBeVisible();
  await search.fill("");
  await expect(row).toBeVisible();
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1440x960-ling-light-my-skills.png");

  await panel.getByRole("button", { name: "Create skill" }).click();
  const editor = page.getByRole("dialog", { name: "Create skill" });
  await expect(editor.getByLabel("Skill name")).toBeFocused();
  await editor.getByLabel("Skill name").fill("UI2 focused editor");
  await editor.getByLabel("Skill description").fill("Verifies the progressive Skill editor and shared controls.");
  await editor.getByLabel("Instruction 1").fill("Keep technical settings folded until the user asks for them.");
  await expect(editor.getByText("Advanced configuration", { exact: true })).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-editor.png");
  await page.keyboard.press("Escape");
  await editor.getByRole("button", { name: "Discard changes" }).click();
  await expect(editor).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

test("source Inspector keeps history folded, rolls back with scoped busy state, and fits dark reduced motion", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", "en-US", 1280, 800, "reduce");
  const state = createBaseState({ approvalStatus: "pending" });
  addUserSkill(state, "ui2-source-skill", "Source-backed UI2 skill");
  addSourceHistory(state, "ui2-source-skill");
  await mockDaemon(page, state);
  await page.goto("/");
  const panel = await openSkillLibrary(page);

  await panel.locator('[data-skill-id="ui2-source-skill"]').click();
  const inspector = panel.locator("[data-ui2-skill-inspector]");
  await expect(inspector).toBeVisible();
  const sourceSection = inspector.locator("details").filter({ hasText: "Source and raw details" }).first();
  await expect(sourceSection).not.toHaveAttribute("open", "");
  await sourceSection.getByText("Source and raw details", { exact: true }).click();
  await expect(inspector.getByText("sha256:ui2-current", { exact: true })).toBeVisible();
  await expect(inspector.getByText("View SKILL.md", { exact: true })).toBeVisible();
  await expect(inspector.getByText("# Previous UI2 Skill", { exact: true })).toBeHidden();
  const rollback = inspector.getByRole("button", { name: "Rollback" });
  await expect(rollback).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-inspector-source.png");
  await rollback.click();
  await expect(rollback).toHaveAttribute("aria-busy", "true");
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="skill:ui2-source-skill:source-rollback"]')).toContainText("Source snapshot rolled back");
  await expect(inspector.getByText("sha256:ui2-previous", { exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(panel);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("AI evolution uses shared filters and keeps a failed review action inside its queue", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", "en-US", 1280, 800);
  const state = createBaseState({ approvalStatus: "pending" });
  await mockDaemon(page, state);
  const reviewGate = deferred();
  await page.route("**/skill-candidates/*/review?**", async (route) => {
    await reviewGate.promise;
    await route.fulfill({ status: 503, json: { message: "Review could not be saved. Try again." } });
  });
  await page.goto("/");
  const panel = await openSkillLibrary(page);
  await panel.getByRole("tab", { name: /AI evolution/ }).click();
  const queue = panel.locator("[data-ui2-skill-review-queue]");
  await expect(queue).toBeVisible();
  await expect(queue.getByRole("tab")).toHaveCount(4);
  const allFilter = queue.getByRole("tab", { name: /All/ });
  await allFilter.focus();
  await page.keyboard.press("ArrowRight");
  await expect(queue.getByRole("tab", { name: /Skills to review/ })).toHaveAttribute("aria-selected", "true");

  const candidate = queue.locator('[data-review-kind="skill_candidates"]').first();
  const ignore = candidate.getByRole("button", { name: "Ignore", exact: true });
  await ignore.click();
  const busyIgnore = candidate.locator('button[data-loading="true"]');
  await expect(busyIgnore).toHaveAttribute("aria-busy", "true");
  await expect(busyIgnore).toHaveAccessibleName(/Ignore Loading/);
  await expect(candidate.getByRole("button", { name: "Adopt and edit" })).toBeDisabled();
  reviewGate.resolve();
  await expect(queue.getByText("Review could not be saved. Try again.", { exact: true })).toBeVisible();
  await expect(candidate.getByRole("button", { name: "Ignore", exact: true })).not.toHaveAttribute("aria-busy", "true");
  await expect(panel.locator("[data-ui2-skill-inspector]")).toHaveCount(0);
  await expectNoPageOverflow(page);
  await captureEvidence(page, "1280x800-ling-dark-evolution-review.png");
  expect(runtimeErrors).toEqual([]);
});

test("AI evolution keeps an empty queue compact without redundant empty-state copy", async ({ page }) => {
  await prepareSurface(page, "light", "zh-CN", 1440, 960);
  const state = createBaseState({ approvalStatus: "expired" });
  state.skillCandidates = [];
  state.procedureObservationClusters = [];
  state.channelPlaybookCandidates = [];
  await mockDaemon(page, state);
  await page.goto("/");

  const panel = await openSkillLibrary(page);
  await panel.getByRole("tab", { name: "AI 进化" }).click();
  const queue = panel.locator("[data-ui2-skill-review-queue]");
  await expect(queue).toBeVisible();
  await expect(queue).toContainText("0 个进化项目");
  await expect(queue.locator(".settings-skill-review-empty")).toHaveCount(0);
  await expect(queue).not.toContainText("暂无需要审核的进化内容");
  await expectNoPageOverflow(page);
});

test("Import and permanent delete keep failures in their Dialogs while success uses an expiring Toast", async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await prepareSurface(page, "dark", "zh-CN", 1280, 800);
  const state = createBaseState({ approvalStatus: "pending" });
  addUserSkill(state, "ui2-delete", "可删除技能");
  await mockDaemon(page, state);
  let failDelete = true;
  await page.route("**/skills/ui2-delete/hard-delete?**", async (route) => {
    if (failDelete) {
      await route.fulfill({ status: 503, json: { message: "模拟删除失败，请重试。" } });
      return;
    }
    await route.fallback();
  });
  await page.goto("/");
  const panel = await openSkillLibrary(page);

  await panel.getByRole("button", { name: "导入技能" }).click();
  let importDialog = page.getByRole("dialog", { name: "导入技能" });
  await importDialog.locator('input[type="file"]').setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Duplicate\n\nid: implement\nsummary: Duplicate an existing skill."),
  });
  await importDialog.getByRole("button", { name: "导入", exact: true }).click();
  await expect(importDialog.locator(".settings-skill-import-problems")).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-import-failure.png");
  await page.keyboard.press("Escape");
  await expect(importDialog).toHaveCount(0);

  const row = panel.locator('[data-skill-id="ui2-delete"]');
  await row.getByRole("button", { name: "删除技能" }).click();
  let deleteDialog = page.getByRole("dialog", { name: /永久删除/ });
  await deleteDialog.getByRole("button", { name: "删除技能", exact: true }).click();
  await expect(deleteDialog.getByText("模拟删除失败，请重试。", { exact: true })).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-delete-failure-zh-CN.png");
  await page.keyboard.press("Escape");
  await expect(deleteDialog).toHaveCount(0);
  await expect(row.getByRole("button", { name: "删除技能" })).toBeFocused();

  failDelete = false;
  await row.getByRole("button", { name: "删除技能" }).click();
  deleteDialog = page.getByRole("dialog", { name: /永久删除/ });
  await deleteDialog.getByRole("button", { name: "删除技能", exact: true }).click();
  await expect(deleteDialog).toHaveCount(0);
  await expect(row).toHaveCount(0);

  await panel.getByRole("button", { name: "导入技能" }).click();
  importDialog = page.getByRole("dialog", { name: "导入技能" });
  await importDialog.locator('input[type="file"]').setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Toast Skill\n\nid: ui2-toast-skill\nsummary: Verify expiring feedback."),
  });
  await importDialog.getByRole("button", { name: "导入", exact: true }).click();
  const toast = page.locator('[data-ling-overlay="toast"][data-scope="skill:import"]');
  await expect(toast).toContainText("已导入 1 个技能");
  await expect(toast).toHaveCount(0, { timeout: 5_000 });
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

async function prepareSurface(
  page: Page,
  theme: "dark" | "light",
  locale: "en-US" | "zh-CN",
  width: number,
  height: number,
  reducedMotion: "no-preference" | "reduce" = "no-preference",
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion });
  await page.addInitScript(({ initialLocale, initialTheme }) => {
    const themeId = initialTheme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", initialLocale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", initialTheme);
  }, { initialLocale: locale, initialTheme: theme });
}

async function openSkillLibrary(page: Page): Promise<Locator> {
  await page.getByLabel(/Ling Stack navigation/).getByRole("button", { name: /Settings|设置/ }).click();
  await page.getByLabel(/Settings sections|设置分组/).getByRole("button", { name: /Skill library|技能库/ }).click();
  const panel = page.locator("[data-ui2-skill-library]");
  await expect(panel).toBeVisible();
  return panel;
}

function addUserSkill(state: MockState, id: string, name: string): void {
  const base = state.skillRegistryEntries.find((entry) => isRecord(entry) && entry.id === "implement");
  if (!isRecord(base) || !isRecord(base.definition)) throw new Error("Expected implementation skill fixture");
  state.skillRegistryEntries.unshift({
    ...base,
    id,
    packId: `pack_${id}`,
    source: "custom",
    reviewStatus: "published",
    definition: { ...base.definition, id, name, summary: `${name} summary` },
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  });
}

function addSourceHistory(state: MockState, skillId: string): void {
  const base = state.skillSourceSnapshots.find((snapshot) => isRecord(snapshot));
  if (!isRecord(base)) throw new Error("Expected source snapshot fixture");
  state.skillSourceSnapshots.unshift(
    {
      ...base,
      id: "ui2-source-current",
      skillId,
      sourceChecksum: "sha256:ui2-current",
      rawSkillMarkdown: "# Current UI2 Skill",
      reviewStatus: "published",
      updatedAt: "2026-07-20T00:00:00.000Z",
    },
    {
      ...base,
      id: "ui2-source-previous",
      skillId,
      sourceChecksum: "sha256:ui2-previous",
      rawSkillMarkdown: "# Previous UI2 Skill",
      reviewStatus: "archived",
      updatedAt: "2026-07-19T00:00:00.000Z",
    },
  );
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const metrics = await locator.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.locator(".settings-layout").screenshot({ animations: "disabled", path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
