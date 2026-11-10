import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";

async function openSkillLibrary(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Skill library/ }).click();
  await expect(page.locator(".settings-skill-library")).toBeVisible();
}

test("skill import chooses one file and imports it with one action", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await openSkillLibrary(page);

  await page.locator(".settings-skill-ownership-empty").getByRole("button", { name: "Import skill" }).click();
  const dialog = page.getByRole("dialog", { name: "Import skill" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Source", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Source path", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Draft name", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Skill content")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Check content" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Publish", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Preview optimization" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Publish to registry" })).toHaveCount(0);
  await expect(dialog.getByText("Choose one skill file. Ling will check it automatically before importing.")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Choose skill file" })).toHaveCount(0);
  await expect(dialog.locator('input[type="file"]')).toHaveCount(1);

  const content = [
    "# Productized Import",
    "id: productized-import",
    "summary: Validate a user-facing skill import flow.",
    "Check the changed surface and report concrete failures.",
  ].join("\n");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(content),
  });
  await expect(dialog.getByText("SKILL.md", { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText(content);

  const draftCountBeforeImport = state.skillImportDrafts.length;
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="skill:import"]')).toContainText("Imported 1 skills");
  expect(state.skillImportDrafts.length).toBe(draftCountBeforeImport + 1);
  await expect.poll(() => state.skillRegistryEntries.some((entry) =>
    typeof entry === "object" && entry !== null && "id" in entry && entry.id === "productized-import"
  )).toBe(true);
});

test("blocked skill import shows only actionable problems and creates no draft", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await openSkillLibrary(page);

  await page.locator(".settings-skill-ownership-empty").getByRole("button", { name: "Import skill" }).click();
  const dialog = page.getByRole("dialog", { name: "Import skill" });
  const draftCountBeforeImport = state.skillImportDrafts.length;
  const duplicateSkillId = (state.skillRegistryEntries[0] as { id: string }).id;
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "SKILL.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(`# Duplicate Skill\n\nid: ${duplicateSkillId}\nsummary: Duplicate an existing skill.`),
  });
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog).toContainText("This skill cannot be imported yet");
  await expect(dialog).toContainText("A skill with the same identity already exists.");
  await expect(dialog.locator(".settings-skill-import-preview")).toHaveCount(0);
  expect(state.skillImportDrafts.length).toBe(draftCountBeforeImport);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(state.skillImportDrafts.length).toBe(draftCountBeforeImport);
});
