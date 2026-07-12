import { expect, test, type Page } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  createBaseState,
  createMockTeammate,
  isRecord,
  type MockState,
} from "./support/mock-state";
import { readHorizontalOverflow } from "./support/test-helpers";

async function openSkillLibrary(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("ling-stack.locale", "en-US");
  });
  await page.goto("/");
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: /Skill library/ }).click();
  await expect(page.locator(".settings-skill-library")).toBeVisible();
}

test("skill library defaults to user-owned skills and keeps built-ins read-only", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const baseSkill = state.skillRegistryEntries.find((entry) => isRecord(entry) && entry.id === "implement");
  if (!isRecord(baseSkill) || !isRecord(baseSkill.definition)) {
    throw new Error("Expected built-in implementation skill fixture");
  }

  addSkill(state, baseSkill, { id: "user-custom", name: "User Custom", source: "custom", reviewStatus: "published", updatedAt: "2026-07-10T10:00:00.000Z" });
  addSkill(state, baseSkill, { id: "user-workspace", name: "Workspace Skill", source: "workspace", reviewStatus: "published", updatedAt: "2026-07-10T09:00:00.000Z" });
  addSkill(state, baseSkill, { id: "user-directory", name: "Directory Skill", source: "skill-directory", reviewStatus: "draft", updatedAt: "2026-07-10T08:00:00.000Z" });
  addSkill(state, baseSkill, { id: "user-agents", name: "Agents Skill", source: "agents-md", reviewStatus: "published", updatedAt: "2026-07-10T07:00:00.000Z" });
  addSkill(state, baseSkill, { id: "user-gstack", name: "Synced Skill", source: "gstack", reviewStatus: "published", updatedAt: "2026-07-10T06:00:00.000Z" });
  addSkill(state, baseSkill, { id: "user-archived", name: "Archived Skill", source: "custom", reviewStatus: "archived", updatedAt: "2026-07-10T05:00:00.000Z" });
  addSkill(state, baseSkill, { id: "user-disabled", name: "Disabled Skill", source: "workspace", reviewStatus: "disabled", updatedAt: "2026-07-10T04:00:00.000Z" });

  state.aiTeammates = [createMockTeammate({ id: "teammate_skill_owner", displayName: "Skill Owner" })];
  state.teammateSkillBindings = [{
    teammateId: "teammate_skill_owner",
    skillId: "review",
    source: "user",
    enabled: true,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  }];

  await mockDaemon(page, state);
  await openSkillLibrary(page);

  const panel = page.locator(".settings-skill-library");
  const mySkillsTab = page.getByRole("tab", { name: /My skills/ });
  const builtInSkillsTab = page.getByRole("tab", { name: /Built-in skills/ });
  await expect(mySkillsTab).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("button", { name: "Import skill" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "New draft" })).toBeVisible();
  await expect(panel.getByText("Skill library refreshed", { exact: true })).toHaveCount(0);

  for (const name of ["User Custom", "Workspace Skill", "Directory Skill", "Agents Skill", "Synced Skill"]) {
    await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: name })).toBeVisible();
  }
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Archived Skill" })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Disabled Skill" })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Code Review" })).toHaveCount(0);

  await expect(panel.locator(".settings-skill-name-button strong")).toHaveText([
    "User Custom",
    "Workspace Skill",
    "Directory Skill",
    "Agents Skill",
    "Synced Skill",
  ]);
  await panel.getByLabel("Sort skills").selectOption("name");
  await expect(panel.locator(".settings-skill-name-button strong")).toHaveText([
    "Agents Skill",
    "Directory Skill",
    "Synced Skill",
    "User Custom",
    "Workspace Skill",
  ]);

  const search = panel.locator(".settings-skill-search input");
  await search.fill("gstack");
  await expect(panel.locator(".settings-skill-table tbody tr")).toHaveCount(1);
  await expect(panel.locator(".settings-skill-table tbody tr")).toContainText("Synced Skill");
  await search.fill("");

  const customRow = panel.locator(".settings-skill-table tbody tr").filter({ hasText: "User Custom" });
  await customRow.getByRole("button", { name: "Details" }).click();
  await expect(panel.locator(".settings-skill-inspector")).toContainText("User Custom");

  await builtInSkillsTab.click();
  await expect(builtInSkillsTab).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("button", { name: "Import skill" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "New draft" })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Code Review" })).toBeVisible();
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "User Custom" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
  await expect(panel.getByText("Metadata only", { exact: true })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-inspector")).toContainText("No skill selected");

  const reviewRow = panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Code Review" });
  await reviewRow.getByRole("button", { name: "Details" }).click();
  const inspector = panel.locator(".settings-skill-inspector");
  await expect(inspector).toContainText("Skill Owner");
  await expect(inspector.getByRole("button", { name: "Archive source snapshot" })).toHaveCount(0);
  await expect(inspector.getByRole("button", { name: "Rollback" })).toHaveCount(0);

  await panel.getByRole("button", { name: "Bound", exact: true }).click();
  await expect(reviewRow).toBeVisible();
  await panel.getByRole("button", { name: "Unbound", exact: true }).click();
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Code Review" })).toHaveCount(0);

  await expect(page.getByRole("tab", { name: /Review queue/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Source sync/ })).toBeVisible();
});

test("skill library keeps a large user list inside its own scroll region", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const state = createBaseState({ approvalStatus: "expired" });
  const baseSkill = state.skillRegistryEntries.find((entry) => isRecord(entry) && entry.id === "implement");
  if (!isRecord(baseSkill) || !isRecord(baseSkill.definition)) {
    throw new Error("Expected built-in implementation skill fixture");
  }
  for (let index = 0; index < 55; index += 1) {
    addSkill(state, baseSkill, {
      id: `user-scroll-${index}`,
      name: `User Scroll Skill ${String(index + 1).padStart(2, "0")}`,
      source: index % 2 === 0 ? "custom" : "gstack",
      reviewStatus: "published",
      updatedAt: `2026-07-10T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
    });
  }

  await mockDaemon(page, state);
  await openSkillLibrary(page);

  const geometry = await page.locator(".settings-skill-library-body").evaluate((body) => {
    const table = body.querySelector<HTMLElement>(".settings-skill-table-wrap");
    const inspector = body.querySelector<HTMLElement>(".settings-skill-inspector");
    return {
      bodyHeight: Math.round(body.getBoundingClientRect().height),
      columns: getComputedStyle(body).gridTemplateColumns,
      tableOverflowY: table ? getComputedStyle(table).overflowY : "",
      tableClientHeight: table?.clientHeight ?? 0,
      tableScrollHeight: table?.scrollHeight ?? 0,
      inspectorHeight: inspector?.clientHeight ?? 0,
    };
  });
  expect(geometry.bodyHeight).toBeGreaterThanOrEqual(400);
  expect(geometry.bodyHeight).toBeLessThanOrEqual(520);
  expect(geometry.columns.split(" ").length).toBeGreaterThanOrEqual(2);
  expect(geometry.tableOverflowY).toBe("auto");
  expect(geometry.tableScrollHeight).toBeGreaterThan(geometry.tableClientHeight);
  expect(geometry.inspectorHeight).toBeGreaterThanOrEqual(geometry.bodyHeight - 2);
  await expect.poll(() => readHorizontalOverflow(page, ".settings-skill-library-body, .settings-skill-table-wrap, .settings-skill-inspector")).toEqual([]);
});

function addSkill(
  state: MockState,
  baseSkill: Record<string, unknown>,
  input: {
    readonly id: string;
    readonly name: string;
    readonly source: "custom" | "workspace" | "skill-directory" | "agents-md" | "gstack";
    readonly reviewStatus: "published" | "draft" | "disabled" | "archived";
    readonly updatedAt: string;
  },
): void {
  const definition = isRecord(baseSkill.definition) ? baseSkill.definition : {};
  state.skillRegistryEntries.unshift({
    ...baseSkill,
    id: input.id,
    packId: `pack_${input.id}`,
    source: input.source,
    reviewStatus: input.reviewStatus,
    definition: {
      ...definition,
      id: input.id,
      name: input.name,
      summary: `${input.name} summary`,
    },
    visibility: {
      workspaceVisible: true,
      promotableToWorkspace: true,
    },
    createdAt: input.updatedAt,
    updatedAt: input.updatedAt,
  });
}
