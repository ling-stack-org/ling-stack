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
  addSkill(state, baseSkill, { id: "managed-gstack-skill", name: "Synced Skill", source: "gstack", reviewStatus: "published", updatedAt: "2026-07-10T06:00:00.000Z" });
  addSkill(state, baseSkill, { id: "gstack", name: "gstack", source: "gstack", packId: "gstack-source-sync", reviewStatus: "published", updatedAt: "2026-07-10T05:30:00.000Z" });
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
  const evolutionTab = page.getByRole("tab", { name: /AI evolution/ });
  const builtInSkillsTab = page.getByRole("tab", { name: /Built-in skills/ });
  await expect(mySkillsTab).toHaveAttribute("aria-selected", "true");
  await expect(evolutionTab).toBeVisible();
  const mySkillsToolbar = panel.locator(".settings-skill-library-toolbar--user");
  await expect(mySkillsToolbar.getByRole("button", { name: "Import skill" })).toBeVisible();
  await expect(mySkillsToolbar.getByRole("button", { name: "Create skill" })).toBeVisible();
  const toolbarLayout = await mySkillsToolbar.evaluate((toolbar) => {
    const search = toolbar.querySelector<HTMLElement>(".settings-skill-search");
    const actions = toolbar.querySelector<HTMLElement>(".settings-skill-library-toolbar-actions");
    const sortControl = actions?.querySelector<HTMLElement>(".settings-skill-sort");
    const importButton = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Import skill"));
    const createButton = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Create skill"));
    const searchRect = search?.getBoundingClientRect();
    const sortRect = sortControl?.getBoundingClientRect();
    const importRect = importButton?.getBoundingClientRect();
    const createRect = createButton?.getBoundingClientRect();
    return {
      searchWidth: searchRect?.width ?? 0,
      searchHeight: searchRect?.height ?? 0,
      searchRight: searchRect?.right ?? 0,
      importWidth: importRect?.width ?? 0,
      importHeight: importRect?.height ?? 0,
      actionsLeft: actions?.getBoundingClientRect().left ?? 0,
      importVariant: importButton?.dataset.variant ?? "",
      createWidth: createRect?.width ?? 0,
      createHeight: createRect?.height ?? 0,
      sortHeight: sortRect?.height ?? 0,
      actionCenterDelta: importRect && createRect
        ? Math.abs((importRect.top + importRect.height / 2) - (createRect.top + createRect.height / 2))
        : 99,
    };
  });
  expect(toolbarLayout.searchWidth).toBeLessThanOrEqual(420);
  expect(toolbarLayout.searchHeight).toBe(32);
  expect(toolbarLayout.importWidth).toBeGreaterThanOrEqual(88);
  expect(toolbarLayout.importHeight).toBe(32);
  expect(toolbarLayout.actionsLeft - toolbarLayout.searchRight).toBeGreaterThanOrEqual(10);
  expect(toolbarLayout.actionsLeft - toolbarLayout.searchRight).toBeLessThanOrEqual(14);
  expect(toolbarLayout.importVariant).toBe("secondary");
  expect(toolbarLayout.createWidth).toBeGreaterThanOrEqual(76);
  expect(toolbarLayout.createHeight).toBe(32);
  expect(toolbarLayout.sortHeight).toBe(32);
  expect(toolbarLayout.actionCenterDelta).toBeLessThanOrEqual(2);
  const searchInput = mySkillsToolbar.locator(".settings-skill-search input");
  const searchFocusLayout = async () => await searchInput.evaluate((input) => {
    const shell = input.closest<HTMLElement>(".settings-skill-search");
    const shellRect = shell?.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    return {
      shellHeight: shellRect?.height ?? 0,
      inputHeight: inputRect.height,
      inputInsideShell: Boolean(shellRect && inputRect.top >= shellRect.top && inputRect.bottom <= shellRect.bottom),
      shellFocused: shell?.matches(":focus-within") ?? false,
      shellBoxShadow: shell ? getComputedStyle(shell).boxShadow : "",
      inputOutline: getComputedStyle(input).outlineStyle,
      inputBoxShadow: getComputedStyle(input).boxShadow,
    };
  });
  const beforeSearchFocus = await searchFocusLayout();
  await searchInput.focus();
  const afterSearchFocus = await searchFocusLayout();
  expect(beforeSearchFocus.shellHeight).toBe(32);
  expect(beforeSearchFocus.inputHeight).toBeLessThanOrEqual(beforeSearchFocus.shellHeight);
  expect(afterSearchFocus.shellHeight).toBe(beforeSearchFocus.shellHeight);
  expect(afterSearchFocus.inputHeight).toBe(beforeSearchFocus.inputHeight);
  expect(afterSearchFocus.inputInsideShell).toBe(true);
  expect(afterSearchFocus.shellFocused).toBe(true);
  expect(afterSearchFocus.shellBoxShadow).not.toBe("none");
  expect(afterSearchFocus.inputOutline).toBe("none");
  expect(afterSearchFocus.inputBoxShadow).toBe("none");
  await mySkillsToolbar.getByRole("button", { name: "Create skill" }).click();
  const createSkillDialog = page.getByRole("dialog", { name: "Create skill" });
  await expect(createSkillDialog.getByLabel("Skill name")).toBeVisible();
  await expect(createSkillDialog.getByLabel("Skill description")).toBeVisible();
  await expect(createSkillDialog.getByLabel("Instruction 1")).toBeVisible();
  await expect(createSkillDialog.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await createSkillDialog.getByLabel("Skill name").fill("Unsaved structured skill");
  await createSkillDialog.getByLabel("Skill description").fill("Used to verify inline dirty-close handling.");
  await createSkillDialog.getByLabel("Instruction 1").fill("Keep the structured editor open until the user decides.");
  await page.keyboard.press("Escape");
  await expect(createSkillDialog.getByText("Discard unsaved changes?", { exact: true })).toBeVisible();
  await createSkillDialog.getByRole("button", { name: "Continue editing" }).click();
  await expect(createSkillDialog.getByLabel("Skill name")).toHaveValue("Unsaved structured skill");
  await createSkillDialog.getByRole("button", { name: "Close skill editor" }).click();
  await createSkillDialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(createSkillDialog).toHaveCount(0);

  await mySkillsToolbar.getByRole("button", { name: "Import skill" }).click();
  const importDialog = page.getByRole("dialog", { name: "Import skill" });
  await expect(importDialog.locator('input[type="file"]')).toHaveCount(1);
  await expect(importDialog.locator("textarea")).toHaveCount(0);
  await expect(importDialog.getByRole("button", { name: "Check content" })).toHaveCount(0);
  await importDialog.getByRole("button", { name: "Close import dialog" }).click();
  await expect.poll(() => panel.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("0px");
  await expect(panel.getByText("Skill library refreshed", { exact: true })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-library-head")).toHaveCount(0);

  for (const name of ["User Custom", "Workspace Skill", "Directory Skill", "Agents Skill"]) {
    await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: name })).toBeVisible();
  }
  const compactListGeometry = await panel.locator(".settings-skill-table-wrap").evaluate((table) => ({
    clientHeight: table.clientHeight,
    scrollHeight: table.scrollHeight,
    maxHeight: getComputedStyle(table).maxHeight,
  }));
  expect(compactListGeometry.scrollHeight).toBeLessThanOrEqual(compactListGeometry.clientHeight + 1);
  expect(compactListGeometry.maxHeight).toMatch(/px$/);
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Synced Skill" })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: /^gstack/ })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Archived Skill" })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Disabled Skill" })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Code Review" })).toHaveCount(0);
  await expect(panel.getByText("Current", { exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Published", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Draft", exact: true })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-table thead")).not.toContainText("Stage");
  await expect(panel.locator(".settings-skill-table thead")).not.toContainText("Source");
  await expect(panel.locator(".settings-skill-table thead")).toContainText("Description");
  await expect(panel.locator(".settings-skill-table thead")).toContainText("Actions");

  await expect(panel.locator(".settings-skill-name-cell strong")).toHaveText([
    "User Custom",
    "Workspace Skill",
    "Directory Skill",
    "Agents Skill",
  ]);
  await panel.getByLabel("Sort skills").selectOption("name");
  await expect(panel.locator(".settings-skill-name-cell strong")).toHaveText([
    "Agents Skill",
    "Directory Skill",
    "User Custom",
    "Workspace Skill",
  ]);

  const search = panel.locator(".settings-skill-search input");
  await search.fill("Synced Skill");
  await expect(panel.locator(".settings-skill-name-cell")).toHaveCount(0);
  await search.fill("");

  const customRow = panel.locator(".settings-skill-table tbody tr").filter({ hasText: "User Custom" });
  await expect(customRow.locator(".settings-skill-summary-cell")).toHaveText("User Custom summary");
  await expect(customRow.getByRole("button", { name: "More" })).toHaveCount(0);
  await expect(customRow.getByRole("button", { name: "Archive" })).toBeVisible();
  await expect(customRow.getByRole("button", { name: "Delete skill" })).toBeVisible();
  await customRow.click();
  const drawer = panel.locator(".settings-skill-detail-drawer");
  await expect(drawer).toContainText("User Custom");
  await expect(drawer).not.toContainText("Stage");
  await expect(drawer.getByRole("button", { name: "Edit skill" })).toBeVisible();
  await drawer.getByRole("button", { name: "Edit skill" }).click();
  const revisionDialog = page.getByRole("dialog", { name: "Edit skill" });
  await expect(revisionDialog.getByLabel("Skill name")).toHaveValue("User Custom");
  await revisionDialog.getByLabel("Skill name").fill("User Custom Updated");
  await revisionDialog.getByLabel("Skill description").fill("Updated through the structured revision editor.");
  await revisionDialog.getByLabel("Instruction 1").fill("Use the updated structured instructions.");
  await revisionDialog.getByRole("button", { name: "Save changes" }).click();
  await expect(revisionDialog).toHaveCount(0);
  await expect(drawer).toContainText("User Custom Updated");
  await expect(drawer).toContainText("Updated through the structured revision editor.");

  await drawer.getByRole("button", { name: "Edit skill" }).click();
  const authorityDialog = page.getByRole("dialog", { name: "Edit skill" });
  await authorityDialog.getByText("Advanced configuration", { exact: true }).click();
  await authorityDialog.getByLabel("Image generation").check();
  await authorityDialog.getByRole("button", { name: "Save changes" }).click();
  await expect(authorityDialog.getByText("Runtime requirements changed", { exact: true })).toBeVisible();
  await expect(authorityDialog.getByText("Added: Image generation", { exact: true })).toBeVisible();
  await expect(authorityDialog.getByRole("button", { name: "Confirm and save" })).toBeVisible();
  await authorityDialog.getByRole("button", { name: "Confirm and save" }).click();
  await expect(authorityDialog).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);

  const updatedCustomRow = panel.locator(".settings-skill-table tbody tr").filter({ hasText: "User Custom Updated" });
  await updatedCustomRow.getByRole("button", { name: "Delete skill" }).click();
  const deleteDialog = page.getByRole("dialog", { name: /Delete skill User Custom Updated\?/ });
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole("button", { name: "Delete skill", exact: true }).click();
  await expect(updatedCustomRow).toHaveCount(0);
  await expect(panel.locator(".settings-skill-detail-drawer")).toHaveCount(0);

  const workspaceRow = panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Workspace Skill" });
  await expect(workspaceRow.getByRole("button", { name: "Delete skill" })).toHaveCount(0);
  await workspaceRow.click();
  await expect(panel.locator(".settings-skill-detail-drawer").getByRole("button", { name: "Edit skill" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await workspaceRow.getByRole("button", { name: "Archive" }).click();
  await expect(workspaceRow).toHaveCount(0);

  await builtInSkillsTab.click();
  await expect(builtInSkillsTab).toHaveAttribute("aria-selected", "true");
  await expect(panel.getByRole("button", { name: "Import skill" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Create skill" })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Code Review" })).toBeVisible();
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Synced Skill" })).toBeVisible();
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: /^gstack/ })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "User Custom" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Delete skill", exact: true })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "More", exact: true })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-table thead th")).toHaveCount(4);
  await expect(panel.getByText("Metadata only", { exact: true })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-detail-drawer")).toHaveCount(0);
  await expect(panel.getByRole("tablist", { name: "Built-in skill filters" })).toHaveCount(0);
  const builtinBindingFilter = panel.getByRole("combobox", { name: "Built-in skill filters" });
  await expect(builtinBindingFilter).toHaveValue("all");
  const builtinToolbarLayout = await panel.locator(".settings-skill-library-toolbar--builtin").evaluate((toolbar) => {
    const search = toolbar.querySelector<HTMLElement>(".settings-skill-search");
    const filter = toolbar.querySelector<HTMLElement>(".settings-skill-builtin-filter");
    const searchRect = search?.getBoundingClientRect();
    const filterRect = filter?.getBoundingClientRect();
    return {
      filterWidth: filterRect?.width ?? 0,
      gap: searchRect && filterRect ? filterRect.left - searchRect.right : 0,
    };
  });
  expect(builtinToolbarLayout.filterWidth).toBeGreaterThanOrEqual(100);
  expect(builtinToolbarLayout.filterWidth).toBeLessThanOrEqual(112);
  expect(builtinToolbarLayout.gap).toBeGreaterThanOrEqual(10);
  expect(builtinToolbarLayout.gap).toBeLessThanOrEqual(14);

  const builtinSearch = panel.locator(".settings-skill-search input");
  const builtinRowCount = await panel.locator(".settings-skill-name-cell").count();
  await builtinSearch.fill("gstack");
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Code Review" })).toHaveCount(0);
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Synced Skill" })).toHaveCount(0);
  expect(await panel.locator(".settings-skill-name-cell").count()).toBeLessThan(builtinRowCount);
  await builtinSearch.fill("");

  const reviewRow = panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Code Review" });
  await reviewRow.click();
  const inspector = panel.locator(".settings-skill-detail-drawer");
  await expect(inspector).toContainText("Skill Owner");
  await expect(inspector.getByRole("button", { name: "Edit skill" })).toHaveCount(0);
  await expect(inspector.getByRole("button", { name: "Archive source snapshot" })).toHaveCount(0);
  await expect(inspector.getByRole("button", { name: "Rollback" })).toHaveCount(0);

  await builtinBindingFilter.selectOption("bound");
  await expect(reviewRow).toBeVisible();
  await builtinBindingFilter.selectOption("unbound");
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Code Review" })).toHaveCount(0);
  await panel.locator(".settings-skill-search input").fill("Code Review");
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Code Review" })).toHaveCount(0);
  await builtinBindingFilter.selectOption("all");
  await expect(panel.locator(".settings-skill-table tbody tr").filter({ hasText: "Code Review" })).toBeVisible();

  await evolutionTab.click();
  await expect(panel.getByRole("region", { name: "AI evolution" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Official skill updates/ })).toHaveCount(0);
  await expect(panel).not.toContainText("Skill health diagnostics");
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
      source: index % 2 === 0 ? "custom" : "workspace",
      reviewStatus: "published",
      updatedAt: `2026-07-10T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
    });
  }

  await mockDaemon(page, state);
  await openSkillLibrary(page);

  const geometry = await page.locator(".settings-skill-library-body").evaluate((body) => {
    const table = body.querySelector<HTMLElement>(".settings-skill-table-wrap");
    return {
      bodyHeight: Math.round(body.getBoundingClientRect().height),
      bodyMaxHeight: Number.parseFloat(getComputedStyle(body).maxHeight),
      columns: getComputedStyle(body).gridTemplateColumns,
      tableOverflowY: table ? getComputedStyle(table).overflowY : "",
      tableClientHeight: table?.clientHeight ?? 0,
      tableScrollHeight: table?.scrollHeight ?? 0,
      drawerCount: body.querySelectorAll(".settings-skill-detail-drawer").length,
    };
  });
  expect(geometry.bodyHeight).toBeGreaterThanOrEqual(500);
  expect(geometry.bodyHeight).toBeLessThanOrEqual(geometry.bodyMaxHeight + 1);
  expect(geometry.bodyMaxHeight).toBeLessThanOrEqual(640);
  expect(geometry.columns.split(" ").length).toBe(1);
  expect(geometry.tableOverflowY).toBe("auto");
  expect(geometry.tableScrollHeight).toBeGreaterThan(geometry.tableClientHeight);
  expect(geometry.drawerCount).toBe(0);
  await expect.poll(() => readHorizontalOverflow(page, ".settings-skill-library-body, .settings-skill-table-wrap, .settings-skill-detail-drawer")).toEqual([]);
});

test("skill library keeps AI evolution while diagnostics and source updates stay out", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  await mockDaemon(page, state);
  await openSkillLibrary(page);

  const panel = page.locator(".settings-skill-library");
  await expect(panel.getByRole("tab")).toHaveCount(3);
  await expect(panel.getByRole("tab", { name: /Review queue/ })).toHaveCount(0);
  await panel.getByRole("tab", { name: /AI evolution/ }).click();
  await expect(panel.getByRole("region", { name: "AI evolution" })).toBeVisible();
  await expect(panel.getByRole("tab", { name: /Official skill updates/ })).toHaveCount(0);
  await expect(panel.getByRole("region", { name: "Skill Health" })).toHaveCount(0);
  await expect(panel.getByRole("region", { name: "Official skill updates" })).toHaveCount(0);
});

test("AI evolution keeps ignored history and moves published skills into its generated view", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const sourceCandidate = state.skillCandidates.find((candidate) => isRecord(candidate));
  if (!isRecord(sourceCandidate)) {
    throw new Error("Expected AI evolution candidate fixture");
  }
  state.skillCandidates.push({
    ...sourceCandidate,
    id: "skill_candidate_ignore_fixture",
    title: "Ignore this candidate",
    status: "pending",
  });

  await mockDaemon(page, state);
  await openSkillLibrary(page);

  const panel = page.locator(".settings-skill-library");
  await panel.getByRole("tab", { name: /AI evolution/ }).click();
  const evolutionViewSelect = panel.getByRole("combobox", { name: "AI evolution views" });
  const evolutionSortSelect = panel.getByRole("combobox", { name: "Sort AI evolution" });
  await expect(evolutionViewSelect).toHaveValue("pending");
  await expect(evolutionSortSelect).toHaveValue("updated");
  await expect(panel.locator(".settings-skill-library-toolbar--evolution-queue .settings-skill-search + .settings-skill-evolution-view-select")).toHaveCount(1);
  await expect(panel.locator(".settings-skill-evolution-view-select + .settings-skill-evolution-sort-select")).toHaveCount(1);
  await expect(panel.getByText("Channel canvas protocol skill", { exact: true })).toBeVisible();
  await evolutionSortSelect.selectOption("name");
  await expect(panel.locator('[data-review-kind="skill_candidates"] .settings-skill-candidate-title strong')).toHaveText([
    "Channel canvas protocol skill",
    "Ignore this candidate",
  ]);

  const ignoredCandidate = panel.locator('[data-review-kind="skill_candidates"]').filter({ hasText: "Ignore this candidate" });
  await ignoredCandidate.getByRole("button", { name: "Ignore", exact: true }).click();
  await expect(evolutionViewSelect).toHaveValue("ignored");
  await expect(evolutionSortSelect).toHaveValue("name");
  await expect(panel.locator('[data-review-kind="skill_candidates"]').filter({ hasText: "Ignore this candidate" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Ignore", exact: true })).toHaveCount(0);

  await evolutionViewSelect.selectOption("pending");
  const candidateCard = panel.locator('[data-review-kind="skill_candidates"]').filter({ hasText: "Channel canvas protocol skill" });
  await candidateCard.getByRole("button", { name: "Adopt and edit" }).click();
  const editor = page.getByRole("dialog", { name: "Edit skill" });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel("Skill name")).toHaveValue("Channel canvas protocol skill");
  await expect(editor.getByLabel("Skill description")).not.toHaveValue("");
  await expect(editor.getByLabel("Instruction 1")).not.toHaveValue("");
  await editor.getByRole("button", { name: "Save changes" }).click();

  await expect(evolutionViewSelect).toHaveValue("generated");
  await expect(panel.locator(".settings-skill-library-toolbar--evolved .settings-skill-search + .settings-skill-evolution-view-select")).toHaveCount(1);
  const generatedSkillRow = panel.locator(".settings-skill-table--evolved tbody tr").filter({ hasText: "Channel canvas protocol skill" });
  await expect(generatedSkillRow).toBeVisible();
  await expect(panel.getByRole("button", { name: "Create registry draft" })).toHaveCount(0);
  await generatedSkillRow.click();
  const generatedSkillDrawer = panel.locator(".settings-skill-detail-drawer");
  await expect(generatedSkillDrawer).toContainText("Metadata only");
  await expect(generatedSkillDrawer.getByRole("button", { name: "Preview optimization" })).toHaveCount(0);
  await expect(generatedSkillDrawer.getByRole("button", { name: "Edit skill" })).toBeVisible();
  await generatedSkillDrawer.getByRole("button", { name: "Edit skill" }).click();
  const aiRevisionDialog = page.getByRole("dialog", { name: "Edit skill" });
  await expect(aiRevisionDialog).toContainText("AI generated");
  await aiRevisionDialog.getByLabel("Skill description").fill("Updated AI-generated skill description.");
  await aiRevisionDialog.getByRole("button", { name: "Save changes" }).click();
  await expect(aiRevisionDialog).toHaveCount(0);
  await expect(generatedSkillDrawer).toContainText("Updated AI-generated skill description.");

  await panel.getByRole("tab", { name: /My skills/ }).click();
  await expect(panel.locator(".settings-skill-table--user").getByText("Channel canvas protocol skill", { exact: true })).toHaveCount(0);
});

test("skill revision conflict keeps edits until the latest version is reloaded", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const baseSkill = state.skillRegistryEntries.find((entry) => isRecord(entry) && entry.id === "implement");
  if (!isRecord(baseSkill) || !isRecord(baseSkill.definition)) {
    throw new Error("Expected built-in implementation skill fixture");
  }
  addSkill(state, baseSkill, {
    id: "conflict-skill",
    name: "Conflict Skill",
    source: "custom",
    reviewStatus: "published",
    updatedAt: "2026-07-10T10:00:00.000Z",
  });

  await mockDaemon(page, state);
  await openSkillLibrary(page);

  const row = page.locator(".settings-skill-table tbody tr").filter({ hasText: "Conflict Skill" });
  await row.click();
  await page.locator(".settings-skill-detail-drawer").getByRole("button", { name: "Edit skill" }).click();
  const editor = page.getByRole("dialog", { name: "Edit skill" });
  await editor.getByLabel("Skill description").fill("A local edit that must survive the conflict response.");
  const skill = state.skillRegistryEntries.find((entry) => isRecord(entry) && entry.id === "conflict-skill");
  if (!isRecord(skill)) throw new Error("Expected conflict skill fixture");
  skill.updatedAt = "2026-07-16T03:00:00.000Z";

  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(editor.getByRole("button", { name: "Reload latest version" })).toBeVisible();
  await expect(editor.getByLabel("Skill description")).toHaveValue("A local edit that must survive the conflict response.");
  await editor.getByRole("button", { name: "Reload latest version" }).click();
  await expect(editor.getByLabel("Skill description")).toHaveValue("Conflict Skill summary");
});

function addSkill(
  state: MockState,
  baseSkill: Record<string, unknown>,
  input: {
    readonly id: string;
    readonly name: string;
    readonly source: "custom" | "workspace" | "skill-directory" | "agents-md" | "gstack";
    readonly packId?: string;
    readonly reviewStatus: "published" | "draft" | "disabled" | "archived";
    readonly updatedAt: string;
  },
): void {
  const definition = isRecord(baseSkill.definition) ? baseSkill.definition : {};
  state.skillRegistryEntries.unshift({
    ...baseSkill,
    id: input.id,
    packId: input.packId ?? `pack_${input.id}`,
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
