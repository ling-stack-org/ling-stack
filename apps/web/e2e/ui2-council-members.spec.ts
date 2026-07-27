import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate, isRecord, type MockState } from "./support/mock-state";

const evidenceDirectory = fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/council-members/",
  import.meta.url,
));

test("custom members show truthful readiness and add one candidate with a single normalized PUT", async ({ page }) => {
  await prepareSurface(page, { locale: "en-US", theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createMembersState();
  const control = createMemberRouteControl();
  const directMemberships = state.teammateChannelMemberships.length;
  await mockDaemon(page, state);
  await installMemberRouteOverlay(page, control);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  const panel = await openMembersPanel(surface);
  await expect(panel.locator(".council-members-row")).toHaveCount(2);
  await expect(panel.getByText("Ready", { exact: true })).toHaveCount(2);
  await captureEvidence(page, "1440x960-ling-light-custom-ready-mixed.png");

  const select = panel.getByLabel("Add teammate to council");
  const options = await select.locator("option").allTextContents();
  expect(options).toContain("Ling QA");
  expect(options).toContain("Paused Candidate (Paused)");
  expect(options).not.toContain("Hidden Candidate");
  expect(options).not.toContain("Disabled Candidate");
  expect(options).not.toContain("Ling Agent");

  await select.selectOption("teammate_qa");
  control.putDelayMs = 250;
  await panel.getByRole("button", { name: "Add member" }).dblclick();
  await expect.poll(() => control.putBodies.length).toBe(1);
  expect(control.putBodies[0]).toEqual({
    members: [
      { teammateId: "teammate_engineer", slotKey: "engineer", label: "Implementation", position: 0, enabled: true },
      { teammateId: "teammate_designer", slotKey: "designer", label: "Product design", position: 1, enabled: true },
      { teammateId: "teammate_qa", slotKey: "qa", position: 2, enabled: true },
    ],
  });
  await expect(panel.locator(".council-members-row")).toHaveCount(3);
  await expect(select).toBeFocused();
  await expect(panel.getByText("Health pending", { exact: true })).toHaveCount(3);
  expect(state.teammateChannelMemberships).toHaveLength(directMemberships);

  state.aiCouncilHealthGeneratedAt = "2026-06-20T00:06:00.000Z";
  const readinessRepair = panel.getByRole("button", { name: /Retry|Refresh/ }).last();
  await readinessRepair.click();
  await expect(panel.getByText("Ready", { exact: true })).toHaveCount(3);
  await expectNoOverflow(page, panel);
  expect(runtimeErrors).toEqual([]);
});

test("managed council is read-only and reaches the existing Clone flow", async ({ page }) => {
  await prepareSurface(page, { locale: "en-US", theme: "dark", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createManagedMembersState();
  const control = createMemberRouteControl();
  await mockDaemon(page, state);
  await installMemberRouteOverlay(page, control);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  const panel = await openMembersPanel(surface);
  await expect(panel.locator(".council-members-row")).toHaveCount(3);
  await expect(panel.getByLabel("Add teammate to council")).toHaveCount(0);
  await expect(panel.getByRole("switch")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Remove council member" })).toHaveCount(0);
  await expect(panel).toContainText("Built-in councils must be cloned before editing");
  await captureEvidence(page, "1440x960-ling-dark-managed-read-only.png");

  await panel.getByRole("button", { name: "Clone to customize" }).click();
  const dialog = page.getByRole("dialog", { name: "Review council clone" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  expect(control.putBodies).toHaveLength(0);
  expect(runtimeErrors).toEqual([]);
});

test("toggle and reorder serialize mutations while preserving labels and continuous positions", async ({ page }) => {
  await prepareSurface(page, { locale: "en-US", theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createMembersState({ includeThirdMember: true });
  const control = createMemberRouteControl();
  control.putDelayMs = 300;
  await mockDaemon(page, state);
  await installMemberRouteOverlay(page, control);
  await page.goto("/");

  const panel = await openMembersPanel(await openCouncilWorkspace(page));
  const designer = memberRow(panel, "Ling Designer");
  await designer.getByRole("switch").click();
  await expect(panel.getByRole("switch").first()).toBeDisabled();
  await expect.poll(() => control.putBodies.length).toBe(1);
  expect(readMembersBody(control.putBodies[0]).find((member) => member.teammateId === "teammate_designer")).toMatchObject({
    label: "Product design",
    enabled: false,
    position: 1,
  });
  await expect(designer.getByText("Disabled", { exact: true })).toBeVisible();

  const qa = memberRow(panel, "Ling QA");
  const firstMoveUp = memberRow(panel, "Ling Engineer").getByRole("button", { name: "Move council member up" });
  await expectTypedIconAction(page, firstMoveUp, "Move council member up", false);
  await expect(firstMoveUp).toBeDisabled();
  const moveUp = qa.getByRole("button", { name: "Move council member up" });
  await expectTypedIconAction(page, moveUp, "Move council member up");
  await moveUp.focus();
  await expect(moveUp).toBeFocused();
  await moveUp.dblclick();
  await expect(moveUp).toHaveAttribute("aria-busy", "true");
  await expect(moveUp).toBeDisabled();
  await expect.poll(() => control.putBodies.length).toBe(2);
  expect(readMembersBody(control.putBodies[1]).map((member) => [member.teammateId, member.position])).toEqual([
    ["teammate_engineer", 0],
    ["teammate_qa", 1],
    ["teammate_designer", 2],
  ]);
  await expect(panel).not.toContainText(/execution order|priority|success rate|last run/i);
  expect(runtimeErrors).toEqual([]);
});

test("remove confirmation restores focus, locks every close path, and keeps direct memberships", async ({ page }) => {
  await prepareSurface(page, { locale: "en-US", theme: "dark", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createMembersState({ secondMemberEnabled: false });
  const directMemberships = [...state.teammateChannelMemberships];
  const control = createMemberRouteControl();
  await mockDaemon(page, state);
  await installMemberRouteOverlay(page, control);
  await page.goto("/");

  const panel = await openMembersPanel(await openCouncilWorkspace(page));
  const engineer = memberRow(panel, "Ling Engineer");
  const removeTrigger = engineer.getByRole("button", { name: "Remove council member" });
  await expectTypedIconAction(page, removeTrigger, "Remove council member");
  await removeTrigger.click();
  let dialog = page.getByRole("dialog", { name: "Remove council member" });
  await expect(dialog).toContainText("This council will have no enabled members.");
  await expect(dialog).toContainText("direct channel memberships stay unchanged");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(removeTrigger).toBeFocused();
  expect(control.putBodies).toHaveLength(0);

  await removeTrigger.click();
  dialog = page.getByRole("dialog", { name: "Remove council member" });
  await captureEvidence(page, "1440x960-ling-dark-remove-confirm.png");
  control.putDelayMs = 350;
  await dialog.getByRole("button", { name: "Remove" }).dblclick();
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => control.putBodies.length).toBe(1);
  await expect(memberRow(panel, "Ling Engineer")).toHaveCount(0);
  expect(state.teammateChannelMemberships).toEqual(directMemberships);
  expect(runtimeErrors).toEqual([]);
});

test("load, retained refresh, and save failures remain repairable without optimistic rows", async ({ page }) => {
  await prepareSurface(page, { locale: "en-US", theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createMembersState({ singleMember: true });
  const control = createMemberRouteControl();
  control.failNextGet = "Synthetic initial members failure";
  control.failNextGetCount = 2;
  await mockDaemon(page, state);
  await installMemberRouteOverlay(page, control);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  const panel = surface.locator(".council-members-panel");
  await expect(panel.getByRole("alert")).toContainText("Synthetic initial members failure");
  await expect(panel.locator(".council-members-row")).toHaveCount(0);
  await panel.getByRole("button", { name: "Retry" }).click();
  await expect(memberRow(panel, "Ling Engineer")).toBeVisible();

  control.failNextGet = "Synthetic retained refresh failure";
  control.failNextGetCount = 1;
  control.getDelayByCouncil.set("council_custom_alpha", 250);
  const refresh = panel.locator(".council-members-summary").getByRole("button", { name: "Refresh" });
  await expectTypedIconAction(page, refresh, "Refresh");
  await refresh.focus();
  await expect(refresh).toBeFocused();
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh).toBeDisabled();
  await expect(panel).toContainText("Stale snapshot");
  await expect(memberRow(panel, "Ling Engineer")).toBeVisible();
  await expect(panel.getByLabel("Add teammate to council")).toBeDisabled();
  await panel.getByRole("button", { name: "Retry" }).click();
  await expect(panel).not.toContainText("Stale snapshot");

  const select = panel.getByLabel("Add teammate to council");
  await select.selectOption("teammate_qa");
  control.failNextPut = "Synthetic member save failure";
  await panel.getByRole("button", { name: "Add member" }).click();
  await expect(panel.getByRole("alert")).toContainText("Synthetic member save failure");
  await expect(select).toHaveValue("teammate_qa");
  await expect(panel.locator(".council-members-row")).toHaveCount(1);
  await panel.getByRole("button", { name: "Add member" }).click();
  await expect(panel.locator(".council-members-row")).toHaveCount(2);
  expect(control.putBodies).toHaveLength(2);
  expect(runtimeErrors).toEqual([]);
});

test("preflight drift adopts the latest snapshot and requires an explicit repeat before PUT", async ({ page }) => {
  await prepareSurface(page, { locale: "en-US", theme: "dark", width: 1280, height: 800 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createMembersState();
  const control = createMemberRouteControl();
  await mockDaemon(page, state);
  await installMemberRouteOverlay(page, control);
  await page.goto("/");

  const panel = await openMembersPanel(await openCouncilWorkspace(page));
  state.aiCouncilMembers.push(memberFixture("teammate_qa", 2, { label: "Verification", slotKey: "qa" }));
  await memberRow(panel, "Ling Engineer").getByRole("button", { name: "Move council member down" }).click();
  await expect(panel.getByRole("status").filter({ hasText: "Review" })).toContainText("Review the latest list and repeat your action");
  await expect(memberRow(panel, "Ling QA")).toBeVisible();
  expect(control.putBodies).toHaveLength(0);
  await captureEvidence(page, "1280x800-ling-dark-save-conflict-stale.png");

  state.aiCouncilMembers = state.aiCouncilMembers.map((member) => isRecord(member) && member.councilId === "council_custom_alpha"
    ? { ...member, position: Number(member.position) + 10 }
    : member);
  await memberRow(panel, "Ling Engineer").getByRole("button", { name: "Move council member down" }).click();
  expect(control.putBodies).toHaveLength(0);
  await memberRow(panel, "Ling Engineer").getByRole("button", { name: "Move council member down" }).click();
  await expect.poll(() => control.putBodies.length).toBe(1);
  expect(readMembersBody(control.putBodies[0]).map((member) => member.position)).toEqual([0, 1, 2]);
  await expectNoOverflow(page, panel);
  expect(runtimeErrors).toEqual([]);
});

test("partial health keeps returned blockers but never upgrades uncovered members to Ready", async ({ page }) => {
  await prepareSurface(page, { locale: "en-US", theme: "dark", width: 1280, height: 800 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createPartialHealthState();
  const control = createMemberRouteControl();
  await mockDaemon(page, state);
  await installMemberRouteOverlay(page, control);
  await page.goto("/");

  const panel = await openMembersPanel(await openCouncilWorkspace(page));
  await expect(memberRow(panel, "Hidden Member")).toContainText("Teammate hidden");
  await expect(memberRow(panel, "Ling Engineer")).toContainText("Health pending");
  await expect(panel.getByText("Ready", { exact: true })).toHaveCount(0);
  await expect(panel).toContainText("Health information is incomplete.");
  await captureEvidence(page, "1280x800-ling-dark-readiness-partial.png");
  await expectNoOverflow(page, panel);
  expect(runtimeErrors).toEqual([]);
});

test("empty Chinese state owns internal bounds when every candidate is excluded", async ({ page }) => {
  await prepareSurface(page, { locale: "zh-CN", theme: "light", width: 1280, height: 800 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createEmptyMembersState();
  const control = createMemberRouteControl();
  await mockDaemon(page, state);
  await installMemberRouteOverlay(page, control);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page, /智囊团工作区|Council Workspace/);
  const panel = await openMembersPanel(surface);
  await expect(panel).toContainText("暂无智囊团成员");
  await expect(panel).toContainText("没有可添加的队友");
  await expect(panel.getByLabel(/添加队友到智囊团|Add teammate to council/)).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-light-empty-no-candidates-zh-cn.png");
  await expectNoOverflow(page, panel);
  expect(runtimeErrors).toEqual([]);
});

test("a delayed old Council GET never leaks rows after selection changes", async ({ page }) => {
  await prepareSurface(page, { locale: "en-US", theme: "light", width: 1440, height: 960 });
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createSelectionRaceState();
  const control = createMemberRouteControl();
  control.getDelayByCouncil.set("council_custom_alpha", 450);
  await mockDaemon(page, state);
  await installMemberRouteOverlay(page, control);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  const panel = surface.locator(".council-members-panel");
  await expect(panel.locator(".council-members-skeleton-row")).toHaveCount(4);
  await surface.locator(".council-list-health-row").filter({ hasText: "Beta Council" }).click();
  await expect(memberRow(panel, "Beta Specialist")).toBeVisible();
  await page.waitForTimeout(550);
  await expect(memberRow(panel, "Alpha Specialist")).toHaveCount(0);
  await expect(memberRow(panel, "Beta Specialist")).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

interface MemberRouteControl {
  failNextGet?: string;
  failNextGetCount: number;
  failNextPut?: string;
  readonly getDelayByCouncil: Map<string, number>;
  getCount: number;
  putDelayMs: number;
  readonly putBodies: Record<string, unknown>[];
}

function createMemberRouteControl(): MemberRouteControl {
  return { failNextGetCount: 0, getCount: 0, getDelayByCouncil: new Map(), putBodies: [], putDelayMs: 0 };
}

async function installMemberRouteOverlay(page: Page, control: MemberRouteControl): Promise<void> {
  await page.route("http://127.0.0.1:17891/ai-councils/*/members*", async (route) => {
    const request = route.request();
    const match = /^\/ai-councils\/([^/]+)\/members$/u.exec(new URL(request.url()).pathname);
    if (!match) {
      await route.fallback();
      return;
    }
    const councilId = decodeURIComponent(match[1]);
    if (request.method() === "GET") {
      control.getCount += 1;
      const delay = control.getDelayByCouncil.get(councilId) ?? 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (control.failNextGet && control.failNextGetCount > 0) {
        const message = control.failNextGet;
        control.failNextGetCount -= 1;
        if (control.failNextGetCount === 0) control.failNextGet = undefined;
        await route.fulfill({ status: 503, json: { error: "synthetic_members_get_failure", message } });
        return;
      }
    }
    if (request.method() === "PUT") {
      control.putBodies.push(request.postDataJSON() as Record<string, unknown>);
      if (control.putDelayMs) await new Promise((resolve) => setTimeout(resolve, control.putDelayMs));
      if (control.failNextPut) {
        const message = control.failNextPut;
        control.failNextPut = undefined;
        await route.fulfill({ status: 503, json: { error: "synthetic_members_put_failure", message } });
        return;
      }
    }
    await route.fallback();
  });
}

function createMembersState(options: {
  readonly includeThirdMember?: boolean;
  readonly secondMemberEnabled?: boolean;
  readonly singleMember?: boolean;
} = {}): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = standardTeammates();
  state.aiCouncils = [customCouncil("council_custom_alpha", "Alpha Council")];
  state.aiCouncilMembers = [
    memberFixture("teammate_engineer", 0, { label: "Implementation", slotKey: "engineer" }),
    ...(options.singleMember ? [] : [memberFixture("teammate_designer", 1, {
      enabled: options.secondMemberEnabled ?? true,
      label: "Product design",
      slotKey: "designer",
    })]),
    ...(options.includeThirdMember ? [memberFixture("teammate_qa", 2, { label: "Verification", slotKey: "qa" })] : []),
  ];
  state.aiCouncilHealthGeneratedAt = "2026-06-20T00:05:00.000Z";
  state.teammateChannelMemberships = [{
    teammateId: "teammate_engineer",
    channelId: "channel_engineering",
    isDefault: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  }];
  return state;
}

function createManagedMembersState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_builtin_engineer", displayName: "Ling Engineer", roleKey: "engineer" }),
    createMockTeammate({ id: "teammate_builtin_designer", displayName: "Ling Designer", roleKey: "designer" }),
    createMockTeammate({ id: "teammate_builtin_qa", displayName: "Ling QA", roleKey: "qa" }),
  ];
  state.aiCouncilHealthGeneratedAt = "2026-06-20T00:05:00.000Z";
  return state;
}

function createPartialHealthState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_hidden_member", displayName: "Hidden Member", hidden: true }),
    createMockTeammate({ id: "teammate_engineer", displayName: "Ling Engineer", roleKey: "engineer" }),
  ];
  state.aiCouncils = [customCouncil("council_custom_partial", "Partial Council")];
  state.aiCouncilMembers = [
    memberFixture("teammate_hidden_member", 0, { councilId: "council_custom_partial" }),
    memberFixture("teammate_engineer", 1, { councilId: "council_custom_partial", slotKey: "engineer" }),
    memberFixture("teammate_missing", 2, { councilId: "council_custom_partial", label: "Missing Member" }),
  ];
  state.aiCouncilHealthFindingLimitOverride = 1;
  state.aiCouncilHealthGeneratedAt = "2026-06-20T00:05:00.000Z";
  return state;
}

function createEmptyMembersState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_hidden", displayName: "Hidden Candidate", hidden: true }),
    createMockTeammate({ id: "teammate_disabled", displayName: "Disabled Candidate", status: "disabled" }),
    createMockTeammate({ id: "ling_agent", displayName: "Ling Agent", kind: "system_teammate", systemRole: "ling_agent" }),
  ];
  state.aiCouncils = [customCouncil("council_custom_empty", "空白智囊团")];
  state.aiCouncilMembers = [];
  state.aiCouncilHealthGeneratedAt = "2026-06-20T00:05:00.000Z";
  return state;
}

function createSelectionRaceState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({ id: "teammate_alpha", displayName: "Alpha Specialist" }),
    createMockTeammate({ id: "teammate_beta", displayName: "Beta Specialist" }),
  ];
  state.aiCouncils = [
    customCouncil("council_custom_alpha", "Alpha Council"),
    customCouncil("council_custom_beta", "Beta Council", false),
  ];
  state.aiCouncilMembers = [
    memberFixture("teammate_alpha", 0, { councilId: "council_custom_alpha" }),
    memberFixture("teammate_beta", 0, { councilId: "council_custom_beta" }),
  ];
  state.aiCouncilHealthGeneratedAt = "2026-06-20T00:05:00.000Z";
  return state;
}

function standardTeammates(): unknown[] {
  return [
    createMockTeammate({ id: "teammate_engineer", displayName: "Ling Engineer", roleKey: "engineer" }),
    createMockTeammate({ id: "teammate_designer", displayName: "Ling Designer", roleKey: "designer" }),
    createMockTeammate({ id: "teammate_qa", displayName: "Ling QA", roleKey: "qa" }),
    createMockTeammate({ id: "teammate_paused", displayName: "Paused Candidate", status: "paused" }),
    createMockTeammate({ id: "teammate_hidden", displayName: "Hidden Candidate", hidden: true }),
    createMockTeammate({ id: "teammate_disabled", displayName: "Disabled Candidate", status: "disabled" }),
    createMockTeammate({ id: "ling_agent", displayName: "Ling Agent", kind: "system_teammate", systemRole: "ling_agent" }),
  ];
}

function customCouncil(id: string, displayName: string, pinned = true): Record<string, unknown> {
  return {
    id,
    workspaceId: "workspace_default",
    source: "user",
    displayName,
    description: "Configuration-only review group.",
    routingPolicy: { defaultMode: "parallel_review", notes: [] },
    governanceProfile: {
      permissionBoundary: "restrict_only",
      approvalBoundary: "cannot_bypass",
      toolGrantBoundary: "cannot_grant",
      credentialBoundary: "cannot_grant",
      notes: [],
    },
    status: "active",
    pinned,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

function memberFixture(
  teammateId: string,
  position: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    councilId: "council_custom_alpha",
    teammateId,
    position,
    enabled: true,
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}

function readMembersBody(body: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(body.members) ? body.members.filter(isRecord) : [];
}

function memberRow(panel: Locator, displayName: string): Locator {
  return panel.locator(".council-members-row").filter({ hasText: displayName });
}

async function expectTypedIconAction(
  page: Page,
  action: Locator,
  label: string,
  tooltip = true,
): Promise<void> {
  await expect(action).toHaveAttribute("data-icon-only", "true");
  await expect(action).toHaveAttribute("data-ling-icon-button-contract", "typed-lucide");
  await expect(action).toHaveAttribute("aria-label", label);
  await expect(action).toHaveAttribute("title", label);
  const bounds = await action.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(32);
  expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(32);
  if (!tooltip) return;
  await action.hover();
  await expect(page.getByRole("tooltip", { name: label })).toBeVisible();
  await page.mouse.move(0, 0);
}

async function openCouncilWorkspace(page: Page, label: string | RegExp = "Council Workspace"): Promise<Locator> {
  await page.getByLabel(/Ling Stack navigation|Ling Stack 导航/).getByRole("button", { name: /Settings|设置/ }).click();
  await page.getByLabel(/Settings sections|设置分组/).getByRole("button", { name: label }).click();
  const surface = page.locator("[data-settings-workspace-tool='councils']");
  await expect(surface).toBeVisible();
  await expect(surface.locator(".council-list-health-row").first()).toBeVisible();
  return surface;
}

async function openMembersPanel(surface: Locator): Promise<Locator> {
  await surface.getByRole("tab", { name: /Council members|智囊团成员/ }).click();
  const panel = surface.locator(".council-members-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".council-members-skeleton-row")).toHaveCount(0);
  return panel;
}

async function prepareSurface(
  page: Page,
  input: {
    readonly height: number;
    readonly locale: "en-US" | "zh-CN";
    readonly theme: "dark" | "light";
    readonly width: number;
  },
): Promise<void> {
  await page.setViewportSize({ width: input.width, height: input.height });
  await page.emulateMedia({ colorScheme: input.theme, reducedMotion: "reduce" });
  await page.addInitScript(({ locale, theme }) => {
    const themeId = theme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", locale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", theme);
  }, { locale: input.locale, theme: input.theme });
}

async function expectNoOverflow(page: Page, panel: Locator): Promise<void> {
  const pageMetrics = await page.evaluate(() => ({
    clientHeight: document.documentElement.clientHeight,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(pageMetrics.scrollWidth).toBeLessThanOrEqual(pageMetrics.clientWidth + 1);
  expect(pageMetrics.scrollHeight).toBeLessThanOrEqual(pageMetrics.clientHeight + 1);
  const panelMetrics = await panel.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(panelMetrics.scrollWidth).toBeLessThanOrEqual(panelMetrics.clientWidth + 1);
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
    if (message.type() === "warning") errors.push(`warning: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
