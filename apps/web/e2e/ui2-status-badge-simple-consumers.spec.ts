import { expect, test, type Locator, type Page } from "@playwright/test";
import { councilStatusPresentation } from "../src/features/councils/council-status-presentation.js";
import { runStatusPresentation } from "../src/features/runs/run-status-presentation.js";
import { teammateStatusPresentation } from "../src/features/teammates/teammate-status-presentation.js";
import type { AiCouncilStatus, AiTeammateStatus, RunStatus } from "../src/types.js";
import { mockDaemon, type MockRun, type MockState } from "./support/mock-daemon";
import {
  createBaseState,
  createChatProvider,
  createMockTeammate,
  cwd,
  isRecord,
} from "./support/mock-state";
import {
  createRunsThreadsFixture,
  installRunsThreadsFixture,
  openMainRunHistory,
} from "./support/runs-threads-fixture";

test("simple status consumers keep the frozen domain label and tone matrix", () => {
  const runCases: ReadonlyArray<readonly [RunStatus, string, string]> = [
    ["queued", "Queued", "info"],
    ["running", "Running", "info"],
    ["waiting_for_approval", "Waiting for approval", "warning"],
    ["succeeded", "Succeeded", "success"],
    ["failed", "Failed", "danger"],
    ["cancelled", "Cancelled", "neutral"],
  ];
  const teammateCases: ReadonlyArray<readonly [AiTeammateStatus, string, string]> = [
    ["active", "Active", "success"],
    ["paused", "Paused", "warning"],
    ["disabled", "Disabled", "neutral"],
  ];
  const councilCases: ReadonlyArray<readonly [AiCouncilStatus, string, string]> = [
    ["active", "Active", "success"],
    ["paused", "Paused", "warning"],
    ["archived", "Archived", "neutral"],
  ];

  expect(runCases.map(([status]) => runStatusPresentation(status))).toEqual(
    runCases.map(([, labelKey, tone]) => ({ labelKey, tone })),
  );
  expect(teammateCases.map(([status]) => teammateStatusPresentation(status))).toEqual(
    teammateCases.map(([, labelKey, tone]) => ({ labelKey, tone })),
  );
  expect(councilCases.map(([status]) => councilStatusPresentation(status))).toEqual(
    councilCases.map(([, labelKey, tone]) => ({ labelKey, tone })),
  );
});

test("Run attempt rows render all six lifecycle tones with shared StatusIndicator", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createRunsThreadsFixture();
  installAllRunStatusAttempts(state);
  await installRunsThreadsFixture(page, state);
  await page.goto("/");
  await openMainRunHistory(page, "Failed provider repair run");

  const detail = page.getByLabel("Run detail");
  const rows = detail.locator(".runs-detail-attempt-row");
  await expect(rows).toHaveCount(6);
  const expected = [
    { attempt: 1, label: "Failed", tone: "danger" },
    { attempt: 2, label: "Succeeded", tone: "success" },
    { attempt: 3, label: "Queued", tone: "info" },
    { attempt: 4, label: "Running", tone: "info" },
    { attempt: 5, label: "Waiting for approval", tone: "warning" },
    { attempt: 6, label: "Cancelled", tone: "neutral" },
  ] as const;
  for (const item of expected) {
    const row = rows.filter({ hasText: `Attempt ${item.attempt}` });
    const status = row.locator(".ling-ui-status-indicator");
    await expect(status).toHaveCount(1);
    await expect(status).toHaveAttribute("data-tone", item.tone);
    await expect(status).toContainText(item.label);
    await expect(row.locator(".status-badge")).toHaveCount(0);
  }

  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Teammate chat hides active status and renders paused and disabled without header overflow", async ({ page }) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createBaseState({ approvalStatus: "expired" });
  const teammateId = "teammate_ui2_simple_status";
  const displayName = "Lifecycle Reviewer with an intentionally long private conversation header identity";
  state.providers = [createChatProvider({
    id: "provider_ui2_simple_status",
    displayName: "Local Relay",
    model: "gpt-5.5",
  })];
  state.aiTeammates = [createMockTeammate({
    id: teammateId,
    displayName,
    providerPresetId: "provider_ui2_simple_status",
    status: "active",
  })];
  await mockDaemon(page, state);
  await page.route(/\/teammates(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { cwd, teammates: state.aiTeammates } });
  });
  await page.goto("/");
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: displayName }).click();

  const header = page.locator("[data-ui2-teammate-chat-header='true']");
  await expect(header).toBeVisible();
  await expect(header.locator(".teammate-chat-lifecycle-status")).toHaveCount(0);
  await expectTeammateHeaderSlotsDoNotOverlap(header);

  await updateTeammateStatusFromProfile(page, "paused");
  let status = header.locator(".teammate-chat-lifecycle-status");
  await expect(status).toHaveAttribute("data-tone", "warning");
  await expect(status).toContainText("Paused");
  await expectTeammateHeaderSlotsDoNotOverlap(header);

  await updateTeammateStatusFromProfile(page, "disabled");
  status = header.locator(".teammate-chat-lifecycle-status");
  await expect(status).toHaveAttribute("data-tone", "neutral");
  await expect(status).toContainText("Disabled");
  await expect(header.locator(".status-badge")).toHaveCount(0);
  await expectTeammateHeaderSlotsDoNotOverlap(header);
  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

test("Council detail renders translated active and paused lifecycle states with shared StatusIndicator", async ({ page }) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createCouncilLifecycleState();
  await mockDaemon(page, state);
  await page.goto("/");

  const surface = await openCouncilWorkspace(page);
  const detailStatus = surface.locator(".council-detail-status");
  await expect(surface.getByLabel("Selected council")).toContainText("Active Council");
  await expect(detailStatus).toHaveAttribute("data-tone", "success");
  await expect(detailStatus).toContainText("Active");

  await surface.locator(".council-list-health-row").filter({ hasText: "Paused Council" }).click();
  await expect(surface.getByLabel("Selected council")).toContainText("Paused Council");
  await expect(detailStatus).toHaveAttribute("data-tone", "warning");
  await expect(detailStatus).toContainText("Paused");
  await expect(detailStatus).not.toContainText("paused");
  await expect(surface.locator(".council-detail-head .status-badge")).toHaveCount(0);

  await expectNoDocumentOverflow(page);
  expect(runtimeErrors).toEqual([]);
});

function installAllRunStatusAttempts(state: MockState): void {
  const base = state.runs.find((run) => run.id === "run_ui2_failed");
  if (!base) throw new Error("Run status fixture requires run_ui2_failed");
  const additions: ReadonlyArray<readonly [RunStatus, string]> = [
    ["queued", "Queued attempt"],
    ["running", "Running attempt"],
    ["waiting_for_approval", "Approval attempt"],
    ["cancelled", "Cancelled attempt"],
  ];
  additions.forEach(([status, title], index) => {
    const attemptNumber = index + 3;
    const id = `run_ui2_status_${status}`;
    const timestamp = `2026-07-23T01:${String(attemptNumber).padStart(2, "0")}:00.000Z`;
    const run: MockRun = {
      ...base,
      id,
      status,
      taskId: `task_${id}`,
      taskSnapshot: { id: `task_${id}`, title, prompt: `${title} prompt` },
      requestSnapshot: { cwd, task: { id: `task_${id}`, title, prompt: `${title} prompt` } },
      eventLogPath: `.ling-stack/sessions/${id}.jsonl`,
      errorMessage: undefined,
      createdAt: timestamp,
      startedAt: status === "queued" ? undefined : timestamp,
      updatedAt: timestamp,
      endedAt: status === "cancelled" ? timestamp : undefined,
    };
    state.runs.push(run);
    state.turnRunLinks.push({
      turnId: "turn_ui2_main",
      runId: id,
      attemptNumber,
      role: "retry",
      createdAt: timestamp,
    });
    state.eventsByRun[id] = [];
    state.artifactsByRun[id] = [];
  });
}

async function updateTeammateStatusFromProfile(page: Page, status: "paused" | "disabled"): Promise<void> {
  const header = page.locator("[data-ui2-teammate-chat-header='true']");
  const detailsToggle = header.getByRole("button", { name: /Show details|Hide details/ });
  if (await detailsToggle.getAttribute("aria-expanded") !== "true") await detailsToggle.click();
  const dock = page.locator(".teammate-private-right-dock");
  await dock.getByRole("button", { name: "Settings", exact: true }).click();
  const profile = page.getByLabel("Teammate profile");
  await profile.getByLabel("Status").selectOption(status);
  const save = page.getByLabel("Single agent settings").getByRole("button", { name: "Save changes" });
  await save.click();
  await expect(save).toBeDisabled();
  await page.getByLabel("Single agent settings").getByRole("button", { name: "Back to private chat" }).click();
  await expect(header).toBeVisible();
}

function createCouncilLifecycleState(): MockState {
  const state = createBaseState({ approvalStatus: "expired" });
  const baseCouncil = state.aiCouncils.find(isRecord);
  if (!baseCouncil) throw new Error("Council lifecycle fixture requires a base council");
  const base = {
    ...baseCouncil,
    source: "user",
    pinned: true,
    updatedAt: "2026-07-24T00:00:00.000Z",
  };
  state.aiCouncils = [
    { ...base, id: "council_ui2_active", displayName: "Active Council", status: "active" },
    { ...base, id: "council_ui2_paused", displayName: "Paused Council", status: "paused" },
  ];
  state.aiCouncilMembers = [];
  return state;
}

async function openCouncilWorkspace(page: Page): Promise<Locator> {
  await page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u }).getByRole("button", { name: "Settings" }).click();
  await page.getByLabel("Settings sections").getByRole("button", { name: "Council Workspace" }).click();
  const surface = page.locator("[data-settings-workspace-tool='councils']");
  await expect(surface.locator(".council-list-health-row").first()).toBeVisible();
  return surface;
}

async function expectTeammateHeaderSlotsDoNotOverlap(header: Locator): Promise<void> {
  const identity = header.locator(".teammate-workspace-identity");
  const toolbar = header.getByRole("toolbar", { name: "Private chat actions" });
  const identityBox = await identity.boundingBox();
  const toolbarBox = await toolbar.boundingBox();
  expect(identityBox).not.toBeNull();
  expect(toolbarBox).not.toBeNull();
  expect(identityBox!.x + identityBox!.width).toBeLessThanOrEqual(toolbarBox!.x - 8);
}

async function prepareSurface(page: Page, theme: "dark" | "light", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((themeId) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, theme);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}
