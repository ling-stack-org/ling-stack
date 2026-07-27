import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cwd, mockDaemon, type MockState } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  isRecord,
} from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/ai-teammate-management-skills/",
  import.meta.url,
));

test("skills use a compact summary, shared rows, search filters, actions, and a folded detail drawer", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_ready", "Skills Systems Engineer");
  await mockDaemon(page, state, { teammateSkillUpdateDelayMs: 500 });
  await page.goto("/");

  const skills = await openSkills(page, "Skills Systems Engineer");
  await expect(skills).toHaveAttribute("data-ui2-teammate-skills", "true");
  await expect(skills.locator(".teammate-skill-summary-grid")).toHaveCount(0);
  await expect(skills.locator("table")).toHaveCount(0);
  await expect(skills.getByLabel("Skill execution summary")).toContainText("Executable");
  await expect(skills.locator("[data-ui2-teammate-skill-row]").first()).toHaveClass(/ling-ui-data-row/u);
  await expect(skillRow(skills, "Engineering Plan Review")).toBeVisible();
  await expect(skills.locator('button[data-ling-icon-button-contract="legacy-react-node"]')).toHaveCount(0);
  await expect(skills.getByRole("button", { name: "Import skill" })).not.toHaveAttribute("data-ling-icon-button-contract");

  const search = skills.getByPlaceholder("Search skills or tools");
  await search.fill("Engineering Plan Review");
  await expect(skillRow(skills, "Engineering Plan Review")).toBeVisible();
  await expect(skillRow(skills, "Code Review")).toHaveCount(0);
  await skills.getByLabel("Skill filters").selectOption("available");
  const planRow = skillRow(skills, "Engineering Plan Review");
  const bindAction = planRow.getByRole("button", { name: "Bind" });
  const planDetailAction = planRow.getByRole("button", { name: "View skill details" });
  await expect(bindAction).toBeEnabled();
  await expect(bindAction).not.toHaveAttribute("data-ling-icon-button-contract");
  await expectTypedIconButton(planDetailAction, "View skill details");
  await bindAction.click();
  await expect(planDetailAction).toBeDisabled();
  await expectTypedIconButton(planDetailAction, "View skill details");
  await expect(planRow).toHaveCount(0);
  await skills.getByLabel("Skill filters").selectOption("all");
  await expect(skillRowById(skills, "plan-eng-review").getByRole("button", { name: "Disable" })).toBeVisible();
  await expect(page.getByText("Skill enabled for teammate", { exact: true })).toBeVisible();
  await expect.poll(() => state.teammateSkillBindings.some((binding) =>
    isRecord(binding) && binding.teammateId === "teammate_skills_ready" && binding.skillId === "plan-eng-review" && binding.enabled === true
  )).toBe(true);

  await search.fill("Code Review");
  await skills.getByLabel("Skill filters").selectOption("all");
  const reviewRow = skillRow(skills, "Code Review");
  const detailTrigger = reviewRow.getByRole("button", { name: "View skill details" });
  await expectTypedIconButton(detailTrigger, "View skill details");
  await expectIconButtonTooltip(detailTrigger, "View skill details");
  await detailTrigger.focus();
  await expect(detailTrigger).toBeFocused();
  await expectTypedIconButton(detailTrigger, "View skill details");
  await detailTrigger.click();
  const drawer = page.getByRole("dialog", { name: "Skill detail" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Source and raw details", { exact: true })).toBeVisible();
  await expect(drawer.getByText("skill_source_review_mock", { exact: true })).toBeHidden();
  await drawer.getByText("Source and raw details", { exact: true }).click();
  await expect(drawer.getByText("skill_source_review_mock", { exact: true })).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-skill-detail.png");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(detailTrigger).toBeFocused();

  await captureEvidence(page, "1440x960-ling-light-loaded-search.png");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("blocked, missing, disabled, source warning, no-result, and long content remain truthful in compact dark layout", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "en-US", reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_states", "Skills State Reviewer");
  await mockDaemon(page, state);
  await page.goto("/");

  const skills = await openSkills(page, "Skills State Reviewer");
  await expect(skillRowById(skills, "restricted-deployment")).toContainText("Blocked");
  await expect(skillRowById(skills, "restricted-deployment")).toContainText("Source needs attention");
  await expect(skillRowById(skills, "implement")).toContainText("Disabled");
  await expect(skillRowById(skills, "missing-skill-definition")).toContainText("Skill unavailable");
  await captureEvidence(page, "1280x800-ling-dark-blocked-source-warning.png");

  await skills.getByPlaceholder("Search skills or tools").fill("no-such-skill-result");
  await expect(skills.getByText("No skills match these filters", { exact: true })).toBeVisible();
  await skills.getByRole("button", { name: "Clear filters" }).click();
  await expect(skillRow(skills, "Code Review")).toBeVisible();
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("skill import is a guarded dialog with stale-preview invalidation and real publish", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_import", "Skill Import Reviewer");
  await mockDaemon(page, state);
  await page.goto("/");

  const skills = await openSkills(page, "Skill Import Reviewer");
  await skills.getByRole("button", { name: "Import skill" }).click();
  const dialog = page.getByRole("dialog", { name: "Import skill" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Draft name").fill("Duplicate Review");
  await dialog.getByLabel("Source path").fill("skills/review/SKILL.md");
  const content = dialog.getByLabel("Skill content");
  await content.fill(["# Duplicate Review", "id: review", "summary: Duplicate review."].join("\n"));
  await dialog.getByRole("button", { name: "Preview draft" }).click();
  await expect(dialog.getByText("Import contains blocking issues", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Publish to registry" })).toBeDisabled();
  await captureEvidence(page, "1280x800-ling-dark-import-error.png");

  await content.fill([
    "# Custom QA Drill",
    "id: custom-qa-drill",
    "summary: Run a focused QA pass for private workspace changes.",
  ].join("\n"));
  await expect(dialog.getByText("Import contains blocking issues", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Publish to registry" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Preview draft" }).click();
  await expect(dialog.getByText("Custom QA Drill", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Publish to registry" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Published 1 skill", { exact: true })).toBeVisible();
  await expect(skillRow(skills, "Custom QA Drill")).toBeVisible();
  await expect.poll(() => state.skillRegistryEntries.some((entry) =>
    isRecord(entry) && entry.id === "custom-qa-drill" && entry.reviewStatus === "published"
  )).toBe(true);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("removing a teammate binding differs from confirmed Registry archive", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_archive", "Skill Archive Reviewer");
  state.teammateSkillBindings.push({
    teammateId: "teammate_skills_archive",
    skillId: "workspace-custom-skill",
    source: "user",
    enabled: true,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
  });
  await mockDaemon(page, state);
  await page.goto("/");

  const skills = await openSkills(page, "Skill Archive Reviewer");
  let customRow = skillRow(skills, "Workspace Custom Skill");
  let moreActions = customRow.getByRole("button", { name: "More actions for Workspace Custom Skill" });
  await expectTypedIconButton(moreActions, "More actions for Workspace Custom Skill");
  await expectIconButtonTooltip(moreActions, "More actions for Workspace Custom Skill");
  await moreActions.click();
  await page.getByRole("menuitem", { name: "Remove from teammate" }).click();
  await expect(page.getByText("Skill removed from teammate", { exact: true })).toBeVisible();
  await expect.poll(() => state.teammateSkillBindings.some((binding) =>
    isRecord(binding) && binding.teammateId === "teammate_skills_archive" && binding.skillId === "workspace-custom-skill"
  )).toBe(false);

  customRow = skillRow(skills, "Workspace Custom Skill");
  moreActions = customRow.getByRole("button", { name: "More actions for Workspace Custom Skill" });
  await moreActions.focus();
  await expect(moreActions).toBeFocused();
  await expectTypedIconButton(moreActions, "More actions for Workspace Custom Skill");
  await moreActions.click();
  await page.getByRole("menuitem", { name: "Archive skill" }).click();
  const confirmation = page.getByRole("dialog", { name: "Archive skill?" });
  await expect(confirmation).toBeVisible();
  await captureEvidence(page, "1440x960-ling-dark-archive-confirm.png");
  await confirmation.getByRole("button", { name: "Archive skill" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect.poll(() => state.skillRegistryEntries.some((entry) =>
    isRecord(entry) && entry.id === "workspace-custom-skill" && entry.reviewStatus === "archived"
  )).toBe(true);
  await expect(customRow).toHaveCount(0);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("binding and import failures stay scoped and keep repairable input", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_failure", "Skill Failure Reviewer");
  await mockDaemon(page, state, { failTeammateSkillUpdates: true, failSkillImportDrafts: true });
  await page.goto("/");

  const skills = await openSkills(page, "Skill Failure Reviewer");
  const planRow = skillRow(skills, "Engineering Plan Review");
  await planRow.getByRole("button", { name: "Bind" }).click();
  await expect(skills.getByText("Skill changes were not saved. Try again.", { exact: true })).toBeVisible();
  await expect(planRow.getByRole("button", { name: "Bind" })).toBeVisible();
  await expect(page.getByText("Skill enabled for teammate", { exact: true })).toHaveCount(0);

  await skills.getByRole("button", { name: "Import skill" }).click();
  const dialog = page.getByRole("dialog", { name: "Import skill" });
  const source = ["# Retryable Skill", "id: retryable-skill", "summary: Preserve this input."].join("\n");
  await dialog.getByLabel("Skill content").fill(source);
  await dialog.getByRole("button", { name: "Preview draft" }).click();
  await expect(dialog.getByText("Skill draft could not be checked. Try again.", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Skill content")).toHaveValue(source);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("SK-01 loading is visible and an empty Registry truthfully falls back to built-in skills", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_loading", "Skills Loading Reviewer");
  state.skillRegistryEntries = [];
  state.skillSourceSnapshots = [];
  state.teammateSkillBindings = [];
  await mockDaemon(page, state, { teammateSkillLoadDelayMs: 1_200 });
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Skills Loading Reviewer" }).click();
  await expect(page.getByText("Loading teammate workspace...", { exact: true }).first()).toBeVisible();
  const skills = await openSkills(page, "Skills Loading Reviewer");
  await expect(page.getByText("Loading teammate workspace...", { exact: true })).toHaveCount(0);
  await expect(skillRow(skills, "Code Review")).toBeVisible();
  await expect(skills.getByText("No skills available", { exact: true })).toHaveCount(0);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("SK-02 a Skills request failure remains the truthful workspace-level load error", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_load_error", "Skills Load Error Reviewer");
  await mockDaemon(page, state, { failTeammateSkillLoads: true });
  await page.goto("/");

  const skills = await openSkills(page, "Skills Load Error Reviewer");
  await expect(page.locator(".inline-error")).toContainText("Teammate skills could not be loaded.");
  await expect(page.getByText("Loading teammate workspace...", { exact: true })).toHaveCount(0);
  await expect(skills.getByText("No skills available", { exact: true })).toHaveCount(0);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("SK-04 all five filters expose exact, non-overlapping fixture counts", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_filters", "Skills Filter Reviewer");
  await mockDaemon(page, state);
  await page.goto("/");

  const skills = await openSkills(page, "Skills Filter Reviewer");
  const rows = skills.locator("[data-ui2-teammate-skill-row]");
  const filter = skills.getByLabel("Skill filters");
  const summary = skills.getByLabel("Skill execution summary");
  await expect(skillRowById(skills, "review")).toBeVisible();
  await expect(summary.locator("span").nth(0)).toHaveText(/4\s*Bound/u);
  await expect(summary.locator("span").nth(1)).toHaveText(/1\s*Executable/u);
  await expect(summary.locator("span").nth(2)).toHaveText(/2\s*Needs attention/u);

  await expect(rows).toHaveCount(6);
  await filter.selectOption("bound");
  await expect(rows).toHaveCount(3);
  await expect(skillRowById(skills, "implement")).toHaveCount(0);
  await filter.selectOption("executable");
  await expect(rows).toHaveCount(1);
  await expect(skillRowById(skills, "review")).toBeVisible();
  await filter.selectOption("blocked");
  await expect(rows).toHaveCount(2);
  await expect(skillRowById(skills, "restricted-deployment")).toBeVisible();
  await expect(skillRowById(skills, "missing-skill-definition")).toBeVisible();
  await filter.selectOption("available");
  await expect(rows).toHaveCount(2);
  await expect(skillRowById(skills, "plan-eng-review")).toBeVisible();
  await expect(skillRowById(skills, "workspace-custom-skill")).toBeVisible();
  await filter.selectOption("all");
  await expect(rows).toHaveCount(6);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("SK-06 technical values are searchable without leaking and rows open by Enter or Space", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_keyboard", "Skills Keyboard Reviewer");
  await mockDaemon(page, state);
  await page.goto("/");

  const skills = await openSkills(page, "Skills Keyboard Reviewer");
  const search = skills.getByPlaceholder("Search skills or tools");
  let restrictedRow = skillRowById(skills, "restricted-deployment");
  await expect(restrictedRow).not.toContainText("restricted-deploy-tool");
  await expect(restrictedRow).not.toContainText("sha256:restricted-warning");

  await search.fill("restricted-deploy-tool");
  restrictedRow = skillRowById(skills, "restricted-deployment");
  await expect(restrictedRow).toBeVisible();
  await expect(skills.locator("[data-ui2-teammate-skill-row]")).toHaveCount(1);
  await expect(restrictedRow).not.toContainText("restricted-deploy-tool");
  await search.fill("sha256:restricted-warning");
  await expect(skillRowById(skills, "restricted-deployment")).toBeVisible();
  await expect(skills.locator("[data-ui2-teammate-skill-row]")).toHaveCount(1);

  await search.fill("");
  const reviewRow = skillRowById(skills, "review");
  await reviewRow.focus();
  await page.keyboard.press("Enter");
  let drawer = page.getByRole("dialog", { name: "Skill detail" });
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(reviewRow).toBeFocused();

  await page.keyboard.press("Space");
  drawer = page.getByRole("dialog", { name: "Skill detail" });
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(reviewRow).toBeFocused();
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("SK-08 advanced binding validates empty, duplicate, known, unknown, and historical missing IDs", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_advanced", "Skills Advanced Reviewer");
  await mockDaemon(page, state);
  await page.goto("/");

  const skills = await openSkills(page, "Skills Advanced Reviewer");
  const advanced = skills.locator("details.teammate-skill-advanced-binding");
  await advanced.locator("summary").click();
  const input = advanced.getByLabel("Skill id");
  const bindButton = advanced.getByRole("button", { name: "Bind" });

  await bindButton.click();
  await expect(advanced.getByText("Enter a skill id first", { exact: true })).toBeVisible();
  await input.fill("review");
  await bindButton.click();
  await expect(advanced.getByText("Skill already exists", { exact: true })).toBeVisible();

  await input.fill(" IMPLEMENT ");
  await bindButton.click();
  await expect(input).toHaveValue("");
  await expect(skillRowById(skills, "implement").getByRole("button", { name: "Disable" })).toBeVisible();
  await expect.poll(() => state.teammateSkillBindings.some((item) =>
    isRecord(item) && item.teammateId === "teammate_skills_advanced" && item.skillId === "implement" && item.enabled === true
  )).toBe(true);

  await input.fill("not-in-the-registry");
  await bindButton.click();
  await expect(skills.getByText("Skill changes were not saved. Try again.", { exact: true })).toBeVisible();
  await expect(input).toHaveValue("not-in-the-registry");
  expect(state.teammateSkillBindings.some((item) => isRecord(item) && item.skillId === "not-in-the-registry")).toBe(false);

  let missingRow = skillRowById(skills, "missing-skill-definition");
  await missingRow.getByRole("button", { name: "Disable" }).click();
  missingRow = skillRowById(skills, "missing-skill-definition");
  await expect(missingRow).toContainText("Skill unavailable");
  await expect(missingRow.getByRole("button", { name: "Enable" })).toBeVisible();
  await expect.poll(() => state.teammateSkillBindings.some((item) =>
    isRecord(item) && item.teammateId === "teammate_skills_advanced" && item.skillId === "missing-skill-definition" && item.enabled === false
  )).toBe(true);
  await missingRow.getByRole("button", { name: "More actions for missing-skill-definition" }).click();
  await page.getByRole("menuitem", { name: "Remove from teammate" }).click();
  await expect(missingRow).toHaveCount(0);
  await expect.poll(() => state.teammateSkillBindings.some((item) =>
    isRecord(item) && item.teammateId === "teammate_skills_advanced" && item.skillId === "missing-skill-definition"
  )).toBe(false);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("SK-09 warning drafts remain publishable, busy dialogs cannot close, and publish failure preserves input", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_publish_failure", "Skills Publish Failure Reviewer");
  await mockDaemon(page, state, {
    failSkillPublishes: true,
    skillImportDraftDelayMs: 400,
    skillPublishDelayMs: 400,
  });
  await page.goto("/");

  const skills = await openSkills(page, "Skills Publish Failure Reviewer");
  await skills.getByRole("button", { name: "Import skill" }).click();
  const dialog = page.getByRole("dialog", { name: "Import skill" });
  const source = [
    "# Approval Guard Drill",
    "id: approval-guard-drill",
    "summary: Review approval-sensitive workspace changes.",
    "Require approval before external secret access.",
  ].join("\n");
  await dialog.getByLabel("Skill content").fill(source);
  await dialog.getByRole("button", { name: "Preview draft" }).click();
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();

  await expect(dialog.getByText("Draft ready", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("Permission-like instruction: Permission-like instructions were kept as prompt text only.");
  const publish = dialog.getByRole("button", { name: "Publish to registry" });
  await expect(publish).toBeEnabled();
  await publish.click();
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Skill draft could not be published. Try again.", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Skill content")).toHaveValue(source);
  expect(state.skillRegistryEntries.some((item) => isRecord(item) && item.id === "approval-guard-drill")).toBe(false);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("SK-10 archive failure is preserved and a delayed mutation cannot leak across teammate switch", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_stale_source", "Skills Stale Source Reviewer");
  state.aiTeammates.push(createMockTeammate({
    id: "teammate_skills_stale_target",
    displayName: "Skills Stale Target Reviewer",
    providerPresetId: "provider_skills_ready",
  }));
  await mockDaemon(page, state, { failSkillArchives: true, teammateSkillUpdateDelayMs: 500 });
  await page.goto("/");

  let skills = await openSkills(page, "Skills Stale Source Reviewer");
  const customRow = skillRowById(skills, "workspace-custom-skill");
  await customRow.getByRole("button", { name: "More actions for Workspace Custom Skill" }).click();
  await page.getByRole("menuitem", { name: "Archive skill" }).click();
  const confirmation = page.getByRole("dialog", { name: "Archive skill?" });
  await confirmation.getByRole("button", { name: "Archive skill" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(skills.getByText("Skill could not be archived. Try again.", { exact: true })).toBeVisible();
  await expect(customRow).toBeVisible();
  expect(state.skillRegistryEntries.some((item) =>
    isRecord(item) && item.id === "workspace-custom-skill" && item.reviewStatus === "published"
  )).toBe(true);

  const customDetail = customRow.getByRole("button", { name: "View skill details" });
  const customMoreActions = customRow.getByRole("button", { name: "More actions for Workspace Custom Skill" });
  await skillRowById(skills, "plan-eng-review").getByRole("button", { name: "Bind" }).click();
  await expect(customDetail).toBeDisabled();
  await expectTypedIconButton(customDetail, "View skill details");
  await expect(customMoreActions).toBeDisabled();
  await expectTypedIconButton(customMoreActions, "More actions for Workspace Custom Skill");
  skills = await openSkills(page, "Skills Stale Target Reviewer");
  await expect.poll(() => state.teammateSkillBindings.some((item) =>
    isRecord(item) && item.teammateId === "teammate_skills_stale_source" && item.skillId === "plan-eng-review"
  )).toBe(true);
  await expect(skillRowById(skills, "plan-eng-review").getByRole("button", { name: "Bind" })).toBeVisible();
  expect(state.teammateSkillBindings.some((item) =>
    isRecord(item) && item.teammateId === "teammate_skills_stale_target" && item.skillId === "plan-eng-review"
  )).toBe(false);
  await expect(page.getByText("Skill enabled for teammate", { exact: true })).toHaveCount(0);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("SK-11 zh-CN dark 1280 stays contained and protected Ling Agent exposes no Skills mutation surface", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "zh-CN", reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_zh", "中文技能审查员");
  state.aiTeammates.push(createMockTeammate({
    id: "ling_agent",
    kind: "system_teammate",
    systemRole: "ling_agent",
    protectedProfile: true,
    displayName: "Ling Agent",
    providerPresetId: undefined,
  }));
  await mockDaemon(page, state);
  await page.goto("/");

  const skills = await openSkills(page, "中文技能审查员", chineseLabels);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(skills.getByLabel("技能执行摘要")).toContainText("可执行");
  await expect(skills.getByPlaceholder("搜索技能或工具")).toBeVisible();
  await expect(skills.getByLabel("技能筛选")).toHaveValue("all");
  await expect(skills.getByRole("button", { name: "导入技能" })).toBeVisible();
  await expect(skills.getByText("Skill execution summary", { exact: true })).toHaveCount(0);
  await expectNoPageOverflow(page);

  const settings = await openTeammateSettings(page, "Ling Agent", chineseLabels);
  await expect(settings.getByRole("button", { name: chineseLabels.skills })).toHaveCount(0);
  await expect(page.locator("[data-ui2-teammate-skills]")).toHaveCount(0);
  const protectedResponse = await page.evaluate(async ({ workspaceCwd }) => {
    const response = await fetch(`http://127.0.0.1:17891/teammates/ling_agent/skills?cwd=${encodeURIComponent(workspaceCwd)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bindings: [{ skillId: "review", source: "template", enabled: true }] }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }, { workspaceCwd: cwd });
  expect(protectedResponse).toEqual({
    status: 400,
    body: { error: "bad_request", message: "Ling Agent skill bindings are protected." },
  });
  expect(state.teammateSkillBindings.some((item) => isRecord(item) && item.teammateId === "ling_agent")).toBe(false);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function createSkillsState(teammateId: string, displayName: string): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.providers = [createChatProvider({
    id: "provider_skills_ready",
    displayName: "Skills Relay",
    model: "gpt-5.5",
    lastCheck: { ok: true, code: "ready", message: "Ready", checkedAt: "2026-07-21T00:00:00.000Z" },
  })];
  state.aiTeammates = [createMockTeammate({ id: teammateId, displayName, providerPresetId: "provider_skills_ready" })];
  const review = findSkillEntry(state, "review");
  const plan = findSkillEntry(state, "plan-eng-review");
  const implementation = findSkillEntry(state, "implement");
  const restricted = cloneSkillEntry(review, {
    id: "restricted-deployment",
    name: "Restricted Deployment Skill With A Deliberately Long Name For Compact Layout",
    summary: "Requires a tool that this teammate does not have and carries a source warning.",
    requiredTools: ["restricted-deploy-tool"],
  }, { source: "custom", reviewStatus: "published" });
  const custom = cloneSkillEntry(review, {
    id: "workspace-custom-skill",
    name: "Workspace Custom Skill",
    summary: "A custom Registry skill used to verify scoped removal and archive confirmation.",
    requiredTools: [],
  }, { source: "custom", reviewStatus: "published" });
  state.skillRegistryEntries = [review, plan, implementation, restricted, custom];
  state.teammateSkillBindings = [
    binding(teammateId, "review", true, "template"),
    binding(teammateId, "implement", false, "template"),
    binding(teammateId, "restricted-deployment", true, "user"),
    binding(teammateId, "missing-skill-definition", true, "user"),
  ];
  const source = state.skillSourceSnapshots.find(isRecord);
  state.skillSourceSnapshots = source ? [
    source,
    {
      ...source,
      id: "skill_source_restricted_warning",
      skillId: "restricted-deployment",
      sourceChecksum: "sha256:restricted-warning",
      warnings: [{ code: "drifted_upstream", severity: "warning", message: "Upstream content changed." }],
    },
  ] : [];
  return state;
}

function binding(teammateId: string, skillId: string, enabled: boolean, source: "template" | "user"): Record<string, unknown> {
  return {
    teammateId,
    skillId,
    source,
    enabled,
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
  };
}

function findSkillEntry(state: MockState, skillId: string): Record<string, unknown> {
  const entry = state.skillRegistryEntries.find((candidate) => isRecord(candidate) && candidate.id === skillId);
  if (!isRecord(entry) || !isRecord(entry.definition)) throw new Error(`Missing mock Skill ${skillId}`);
  return entry;
}

function cloneSkillEntry(
  source: Record<string, unknown>,
  definitionPatch: Record<string, unknown>,
  entryPatch: Record<string, unknown>,
): Record<string, unknown> {
  const definition = isRecord(source.definition) ? source.definition : {};
  return {
    ...source,
    ...entryPatch,
    id: definitionPatch.id,
    packId: `pack_${String(definitionPatch.id)}`,
    definition: { ...definition, ...definitionPatch },
    updatedAt: "2026-07-21T00:00:00.000Z",
  };
}

function skillRow(panel: Locator, name: string): Locator {
  return panel.locator("[data-ui2-teammate-skill-row]").filter({ hasText: name });
}

function skillRowById(panel: Locator, skillId: string): Locator {
  return panel.locator(`[data-skill-id="${skillId}"]`);
}

const englishLabels = {
  details: "Show details",
  dock: "Private chat workspace dock",
  settings: "Settings",
  settingsSections: "Settings sections",
  skills: /^Skills\b/u,
} as const;

const chineseLabels = {
  details: "显示详情",
  dock: "私聊工作区面板",
  settings: "设置",
  settingsSections: "设置分组",
  skills: /^技能(?:\s|$)/u,
} as const;

type TeammateSkillsLabels = typeof englishLabels | typeof chineseLabels;

async function openTeammateSettings(
  page: Page,
  teammateName: string,
  labels: TeammateSkillsLabels = englishLabels,
): Promise<Locator> {
  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: teammateName }).click();
  const chatHeader = page.locator("[data-ui2-teammate-chat-header]");
  await expect(chatHeader).toBeVisible();
  if (await page.getByLabel(labels.dock).count() === 0) {
    await chatHeader.getByRole("button", { name: labels.details }).click();
  }
  await page.getByLabel(labels.dock).getByRole("button", { name: labels.settings }).click();
  const settings = page.getByLabel(labels.settingsSections);
  await expect(settings).toBeVisible();
  return settings;
}

async function openSkills(
  page: Page,
  teammateName: string,
  labels: TeammateSkillsLabels = englishLabels,
): Promise<Locator> {
  const settings = await openTeammateSettings(page, teammateName, labels);
  await settings.getByRole("button", { name: labels.skills }).click();
  const panel = page.locator("[data-ui2-teammate-skills]");
  await expect(panel).toBeVisible();
  return panel;
}

async function prepareSurface(
  page: Page,
  options: {
    readonly theme: "dark" | "light";
    readonly width: number;
    readonly height: number;
    readonly locale: "en-US" | "zh-CN";
    readonly reducedMotion?: "no-preference" | "reduce";
  },
): Promise<void> {
  await page.setViewportSize({ width: options.width, height: options.height });
  await page.emulateMedia({ colorScheme: options.theme, reducedMotion: options.reducedMotion ?? "no-preference" });
  await page.addInitScript(({ locale, theme }) => {
    const themeId = theme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { locale: options.locale, theme: options.theme });
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientHeight: document.documentElement.clientHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  expect(overflow.scrollHeight).toBeLessThanOrEqual(overflow.clientHeight + 1);
}

async function expectTypedIconButton(button: Locator, label: string): Promise<void> {
  await expect(button).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await expect(button).toHaveAttribute("data-icon-only", "true");
  await expect(button).toHaveAttribute("aria-label", label);
  await expect(button).toHaveAttribute("title", label);
  const box = await button.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(32);
}

async function expectIconButtonTooltip(button: Locator, label: string): Promise<void> {
  const page = button.page();
  await button.hover();
  await expect(page.getByRole("tooltip", { name: label, exact: true })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip", { name: label, exact: true })).toHaveCount(0);
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", path: `${evidenceDirectory}${filename}` });
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
