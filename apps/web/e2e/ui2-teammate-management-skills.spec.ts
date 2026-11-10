import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon, type MockState } from "./support/mock-daemon";
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

test("skills expose a compact binding list, immediate switches, and one row-owned detail drawer", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_ready", "Skills Systems Engineer");
  await mockDaemon(page, state, { teammateSkillUpdateDelayMs: 300 });
  await page.goto("/");

  const skills = await openSkills(page, "Skills Systems Engineer");
  await expect(skills).toHaveAttribute("data-ui2-teammate-skills", "true");
  const naturalListSize = await skills.locator(".teammate-skill-list").evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(naturalListSize.scrollHeight).toBeLessThanOrEqual(naturalListSize.clientHeight + 1);
  const listHeader = skills.locator(".teammate-skill-list-header");
  await expect(listHeader.locator("span")).toHaveText(["Skill", "Description", "Use"]);
  await expect(skills.getByRole("button", { name: "Import skill" })).toHaveCount(0);
  await expect(skills.getByText("Advanced binding", { exact: true })).toHaveCount(0);
  await expect(skills.getByRole("button", { name: "View skill details" })).toHaveCount(0);
  await expect(skills.getByText("Default skill", { exact: true })).toHaveCount(0);
  await expect(skills.getByText("Source needs attention", { exact: true })).toHaveCount(0);

  const filter = skills.getByLabel("Skill filters");
  await expect(filter.locator("option")).toHaveText(["All skills", "In use", "Not in use", "Needs attention"]);
  const search = skills.getByPlaceholder("Search skills or purposes");
  await search.fill("Engineering Plan Review");
  const planRow = skillRowById(skills, "plan-eng-review");
  await expect(planRow).toBeVisible();
  await expect(skillRowById(skills, "review")).toHaveCount(0);
  const planSwitch = planRow.getByRole("switch", { name: "Use skill for teammate: Engineering Plan Review" });
  await expect(planSwitch).not.toBeChecked();
  await planSwitch.click();
  await expect(page.getByText("Skill enabled for teammate", { exact: true })).toBeVisible();
  await expect.poll(() => state.teammateSkillBindings.some((binding) =>
    isRecord(binding) &&
    binding.teammateId === "teammate_skills_ready" &&
    binding.skillId === "plan-eng-review" &&
    binding.enabled === true
  )).toBe(true);

  await search.fill("");
  const reviewRow = skillRowById(skills, "review");
  await reviewRow.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog").filter({ hasText: "Code Review" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Use for this teammate", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Requirements and policy", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Technical information", { exact: true })).toBeVisible();
  await expect(drawer.getByText("skill_source_review_mock", { exact: true })).toBeHidden();
  await drawer.getByText("Technical information", { exact: true }).click();
  await expect(drawer.getByText("skill_source_review_mock", { exact: true })).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-binding-list-and-detail.png");
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(reviewRow).toBeFocused();
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("filters and search use product-visible skill data while technical source values stay out of the list", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "en-US", reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_filters", "Skills Filter Reviewer");
  await mockDaemon(page, state);
  await page.goto("/");

  const skills = await openSkills(page, "Skills Filter Reviewer");
  const rows = skills.locator("[data-ui2-teammate-skill-row]");
  const filter = skills.getByLabel("Skill filters");
  const search = skills.getByPlaceholder("Search skills or purposes");
  await expect(rows).toHaveCount(6);

  await filter.selectOption("using");
  await expect(rows).toHaveCount(3);
  await filter.selectOption("unused");
  await expect(rows).toHaveCount(3);
  await filter.selectOption("attention");
  await expect(rows).toHaveCount(2);
  await expect(skillRowById(skills, "restricted-deployment")).toContainText("Needs attention");
  await expect(skillRowById(skills, "missing-skill-definition")).toContainText("Needs attention");

  await filter.selectOption("all");
  await search.fill("restricted-deploy-tool");
  await expect(skills.getByText("No skills match these filters", { exact: true })).toBeVisible();
  await search.fill("sha256:restricted-warning");
  await expect(skills.getByText("No skills match these filters", { exact: true })).toBeVisible();
  await search.fill("Run commands");
  await expect(skillRowById(skills, "implement")).toBeVisible();
  await expect(rows).toHaveCount(1);

  await search.fill("");
  const restrictedRow = skillRowById(skills, "restricted-deployment");
  await restrictedRow.click();
  const drawer = page.getByRole("dialog").filter({ hasText: "Restricted Deployment Skill" });
  await expect(drawer.getByText("Source needs attention", { exact: true }).first()).toBeVisible();
  await expect(drawer.getByText("sha256:restricted-warning", { exact: true })).toBeHidden();
  await drawer.getByText("Technical information", { exact: true }).click();
  await expect(drawer.getByText("sha256:restricted-warning", { exact: true })).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-attention-detail.png");
  await page.keyboard.press("Escape");
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("binding failure preserves the switch state and user bindings are removed only from the detail drawer", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_failure", "Skill Failure Reviewer");
  state.teammateSkillBindings.push(binding("teammate_skills_failure", "workspace-custom-skill", true, "user"));
  await mockDaemon(page, state, { failTeammateSkillUpdates: true });
  await page.goto("/");

  const skills = await openSkills(page, "Skill Failure Reviewer");
  const planSwitch = skillRowById(skills, "plan-eng-review")
    .getByRole("switch", { name: "Use skill for teammate: Engineering Plan Review" });
  await planSwitch.click();
  await expect(skills.getByText("Skill changes were not saved. Try again.", { exact: true })).toBeVisible();
  await expect(planSwitch).not.toBeChecked();
  expect(state.teammateSkillBindings.some((item) =>
    isRecord(item) && item.teammateId === "teammate_skills_failure" && item.skillId === "plan-eng-review"
  )).toBe(false);
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("a user binding can be removed without exposing Registry archive controls", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "en-US" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_remove", "Skill Removal Reviewer");
  state.teammateSkillBindings.push(binding("teammate_skills_remove", "workspace-custom-skill", true, "user"));
  await mockDaemon(page, state);
  await page.goto("/");

  const skills = await openSkills(page, "Skill Removal Reviewer");
  const customRow = skillRowById(skills, "workspace-custom-skill");
  await customRow.click();
  const drawer = page.getByRole("dialog").filter({ hasText: "Workspace Custom Skill" });
  await expect(drawer.getByRole("button", { name: "Remove from teammate" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: /Archive/u })).toHaveCount(0);
  await drawer.getByRole("button", { name: "Remove from teammate" }).click();
  await expect(page.getByText("Skill removed from teammate", { exact: true })).toBeVisible();
  await expect.poll(() => state.teammateSkillBindings.some((item) =>
    isRecord(item) && item.teammateId === "teammate_skills_remove" && item.skillId === "workspace-custom-skill"
  )).toBe(false);
  await expect(skillRowById(skills, "workspace-custom-skill")).toBeVisible();
  await expectNoPageOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Chinese built-in skill names and summaries stay translated", async ({ page }) => {
  await prepareSurface(page, { theme: "light", width: 1440, height: 960, locale: "zh-CN" });
  const state = createSkillsState("teammate_translated_skills", "技能审查员");
  const expected = [
    ["browse", "浏览器检查", "执行浏览器界面检查"],
    ["checkpoint", "工作检查点", "为长时间运行或中断的会话"],
    ["context-save", "保存上下文", "记录当前 Git 状态"],
    ["diagram", "绘制图表", "依据实际实现创建"],
    ["unfreeze", "解除编辑限制", "在用户扩大工作范围后"],
  ] as const;
  const builtins = createBaseState({ approvalStatus: "expired" });
  state.skillRegistryEntries.push(...expected.map(([id]) => findSkillEntry(builtins, id)));
  await mockDaemon(page, state);
  await page.goto("/");
  const skills = await openSkills(page, "技能审查员", chineseLabels);
  for (const [id, name, summary] of expected) {
    const row = skillRowById(skills, id);
    await expect(row).toContainText(name);
    await expect(row).toContainText(summary);
  }
  await captureEvidence(page, "1440x960-built-in-skills-zh-CN.png");
});

test("long skill lists use an overlay scrollbar and protected Ling Agent has no binding page", async ({ page }) => {
  await prepareSurface(page, { theme: "dark", width: 1280, height: 800, locale: "zh-CN", reducedMotion: "reduce" });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSkillsState("teammate_skills_long", "长列表技能审查员");
  const source = findSkillEntry(state, "review");
  for (let index = 0; index < 36; index += 1) {
    state.skillRegistryEntries.push(cloneSkillEntry(source, {
      id: `long-skill-${index}`,
      name: `长列表技能 ${String(index + 1).padStart(2, "0")}`,
      summary: `用于验证内部滚动的技能说明 ${index + 1}`,
      requiredTools: [],
    }, { source: "custom", reviewStatus: "published" }));
  }
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

  const skills = await openSkills(page, "长列表技能审查员", chineseLabels);
  const scrollOwnership = await skills.evaluate((panel) => {
    const settingsContent = panel.closest<HTMLElement>(".teammate-settings-tab-content");
    const list = panel.querySelector<HTMLElement>(".teammate-skill-list");
    if (!settingsContent || !list) throw new Error("Missing teammate Skills scroll owners");
    return {
      listOverflow: list.scrollHeight > list.clientHeight + 1,
      settingsContentOverflow: settingsContent.scrollHeight > settingsContent.clientHeight + 1,
    };
  });
  expect(scrollOwnership).toEqual({
    listOverflow: true,
    settingsContentOverflow: false,
  });
  await expect.poll(async () => skills.locator(".teammate-skill-list").evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))).toMatchObject({ clientHeight: expect.any(Number), scrollHeight: expect.any(Number) });
  const overflow = await skills.locator(".teammate-skill-list").evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(overflow).toBe(true);
  await expect(skills.locator('.ling-overlay-scrollbar[data-overflow="true"]')).toBeAttached();
  await captureEvidence(page, "1280x800-ling-dark-overlay-scroll-zh-CN.png");

  const settings = await openTeammateSettings(page, "Ling Agent", chineseLabels);
  await expect(settings.getByRole("button", { name: "技能", exact: true })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "工具与权限", exact: true })).toHaveCount(0);
  await expect(page.locator("[data-ui2-teammate-skills]")).toHaveCount(0);
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
    summary: "A custom Registry skill used to verify scoped binding removal.",
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

function skillRowById(panel: Locator, skillId: string): Locator {
  return panel.locator(`[data-skill-id="${skillId}"]`);
}

const englishLabels = {
  details: "Show details",
  dock: "Private chat workspace dock",
  settings: "Settings",
  settingsSections: "Settings sections",
  skills: "Skills",
} as const;

const chineseLabels = {
  details: "显示详情",
  dock: "私聊工作区面板",
  settings: "设置",
  settingsSections: "设置分组",
  skills: "技能",
} as const;

type TeammateSkillsLabels = typeof englishLabels | typeof chineseLabels;

async function openTeammateSettings(
  page: Page,
  teammateName: string,
  labels: TeammateSkillsLabels = englishLabels,
): Promise<Locator> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: teammateName }).click();
  const chatHeader = page.locator("[data-ui2-teammate-chat-header]");
  await expect(chatHeader).toBeVisible();
  const showDetails = chatHeader.getByRole("button", { name: labels.details });
  if (await showDetails.isVisible()) await showDetails.click();
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
  await settings.getByRole("button", { name: labels.skills, exact: true }).click();
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
