import type { ChannelWorkflowStatus, ChannelWorkflowStepStatus, RunStatus } from "@ling-stack/contracts";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  channelWorkflowRunStatusPresentation,
  channelWorkflowStatusPresentation,
  channelWorkflowStepStatusPresentation,
} from "../src/features/workspace/channel-workflow-status-presentation.js";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, createMockTeammate } from "./support/mock-state";
import { openChannelContextPanel, openEngineeringChannel } from "./support/test-helpers";

const workflowCardPath = fileURLToPath(new URL("../src/features/workspace/ChannelWorkflowProposalCards.tsx", import.meta.url));
const componentPath = fileURLToPath(new URL("../src/features/workspace/ChannelWorkflowStatusIndicator.tsx", import.meta.url));
const componentsCssPath = fileURLToPath(new URL("../src/styles/components.css", import.meta.url));
const focusedCssPath = fileURLToPath(new URL("../src/styles/channel-workflow-status.css", import.meta.url));
const stylesPath = fileURLToPath(new URL("../src/styles.css", import.meta.url));

const workflowCases: readonly [ChannelWorkflowStatus, string, string][] = [
  ["draft", "Draft", "neutral"],
  ["ready", "Ready", "info"],
  ["running", "Running", "info"],
  ["waiting_for_approval", "Waiting for approval", "warning"],
  ["blocked", "Blocked", "warning"],
  ["succeeded", "Succeeded", "success"],
  ["failed", "Failed", "danger"],
  ["cancelled", "Cancelled", "neutral"],
];

const stepCases: readonly [ChannelWorkflowStepStatus, string, string][] = [
  ["queued", "Queued", "info"],
  ["claimed", "Claimed", "info"],
  ["running", "Running", "info"],
  ["waiting_for_approval", "Waiting for approval", "warning"],
  ["blocked", "Blocked", "warning"],
  ["succeeded", "Succeeded", "success"],
  ["failed", "Failed", "danger"],
  ["skipped", "Skipped", "neutral"],
  ["cancelled", "Cancelled", "neutral"],
];

const runCases: readonly [RunStatus, string, string][] = [
  ["queued", "Queued", "info"],
  ["running", "Running", "info"],
  ["waiting_for_approval", "Waiting for approval", "warning"],
  ["succeeded", "Succeeded", "success"],
  ["failed", "Failed", "danger"],
  ["cancelled", "Cancelled", "neutral"],
];

test("workflow, step, and run status presentation is exhaustive and the legacy owner is absent", async () => {
  expect(workflowCases.map(([status]) => channelWorkflowStatusPresentation(status))).toEqual(
    workflowCases.map(([id, labelKey, tone]) => ({ id, labelKey, tone })),
  );
  expect(stepCases.map(([status]) => channelWorkflowStepStatusPresentation(status))).toEqual(
    stepCases.map(([id, labelKey, tone]) => ({ id, labelKey, tone })),
  );
  expect(runCases.map(([status]) => channelWorkflowRunStatusPresentation(status))).toEqual(
    runCases.map(([id, labelKey, tone]) => ({ id, labelKey, tone })),
  );
  expect(channelWorkflowRunStatusPresentation("saved")).toEqual({ id: "saved", labelKey: "Saved", tone: "neutral" });

  const [cardSource, componentSource, componentsCss, focusedCss, styles] = await Promise.all([
    readFile(workflowCardPath, "utf8"),
    readFile(componentPath, "utf8"),
    readFile(componentsCssPath, "utf8"),
    readFile(focusedCssPath, "utf8"),
    readFile(stylesPath, "utf8"),
  ]);
  expect(cardSource).not.toContain("StatusBadge");
  expect(cardSource).not.toContain("<StatusBadge");
  expect(cardSource).not.toContain("{workflow.status} ·");
  expect(cardSource).not.toContain("ChannelExecutionProposalDecision");
  expect(cardSource).not.toContain("Task confirmation");
  expect(cardSource.trimEnd().split("\n").length).toBeLessThanOrEqual(1650);
  expect(componentSource).toContain('StatusIndicator } from "../../shared/ui/index.js"');
  expect(componentSource).not.toContain("@radix-ui");
  expect(componentsCss).not.toContain(".workflow-queue-head .status-badge");
  expect(componentsCss).not.toContain(".workflow-step-head .status-badge");
  expect(focusedCss).not.toContain(".ling-ui-");
  expect(styles).toContain('@import "./styles/channel-workflow-status.css";');
});

test("Light workflow surfaces show compact proposal decisions and contained workflow status content", async ({ page }, testInfo) => {
  await prepareSurface(page, "light", 1440, 960);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createWorkflowStatusState();
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await verifyProposalSurface(page, testInfo, "1440x960-ling-light");
  const runtimePanel = await openRuntimePanel(page);
  await verifyWorkflowQueue(runtimePanel);
  await runtimePanel.locator(".workflow-queue-card").scrollIntoViewIfNeeded();
  await expectContained(page, runtimePanel);
  expect(runtimeErrors).toEqual([]);
  await capture(page, testInfo, "1440x960-ling-light-workflow-statuses.png");
  expect(runtimeErrors).toEqual([]);
});

test("Dark workflow surfaces retain semantic tones and containment", async ({ page }, testInfo) => {
  await prepareSurface(page, "dark", 1280, 800);
  const runtimeErrors = collectRuntimeErrors(page);
  const state = createWorkflowStatusState();
  await mockDaemon(page, state);
  await page.goto("/");
  await openEngineeringChannel(page);

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await verifyProposalSurface(page, testInfo, "1280x800-ling-dark");
  const runtimePanel = await openRuntimePanel(page);
  await verifyWorkflowQueue(runtimePanel);
  const queue = runtimePanel.locator(".workflow-queue-card");
  await queue.scrollIntoViewIfNeeded();
  expect(await queue.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgb(255, 255, 255)");
  await expectContained(page, runtimePanel);
  expect(runtimeErrors).toEqual([]);
  await capture(page, testInfo, "1280x800-ling-dark-workflow-statuses.png");
  expect(runtimeErrors).toEqual([]);
});

function createWorkflowStatusState(): ReturnType<typeof createBaseState> {
  const state = createBaseState({ approvalStatus: "expired" });
  state.aiTeammates = [
    createMockTeammate({
      id: "ling_agent",
      displayName: "Ling Agent",
      templateId: "ling_agent",
      roleKey: "custom",
      systemRole: "ling_agent",
    }),
    createMockTeammate({ id: "teammate_builtin_engineer", displayName: "Engineer" }),
  ];
  const timestamp = "2026-07-26T08:00:00.000Z";
  const workflowId = "workflow_status_matrix";
  const linkedRunId = "run_workflow_status";
  const existingRun = state.runs[0];
  if (!existingRun) throw new Error("Workflow status fixture requires one base run");
  state.runs = [{ ...existingRun, id: linkedRunId, channelId: "channel_engineering", status: "failed", errorMessage: longText("Linked run failed after provider validation") }];
  state.channelWorkflows = [{
    id: workflowId,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    title: longText("Release workflow status presentation"),
    objective: longText("Keep every workflow action and status readable inside the channel inspector"),
    status: "waiting_for_approval",
    createdBy: "local-user",
    createdAt: timestamp,
    updatedAt: timestamp,
  }];
  state.channelWorkflowSteps = stepCases.map(([status, label], index) => ({
    id: `workflow_step_status_${status}`,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    workflowId,
    position: index + 1,
    title: `Status case ${label}`,
    prompt: status === "blocked" ? longText("Resolve the blocked provider and permission boundary") : `Validate ${label} presentation`,
    toParticipantId: "ling_agent",
    toParticipantLabel: "Ling Agent",
    status,
    blocker: status === "blocked" ? longText("Provider permission remains blocked") : undefined,
    createdAt: timestamp,
    updatedAt: timestamp,
  }));
  state.channelMessages = [
    channelMessage("msg_status_editable", "Prepare the editable workflow proposal."),
    channelMessage("msg_status_linked", "Show linked workflow and run status."),
  ];
  state.channelExecutionProposals = [
    {
      id: "proposal_status_editable",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_status_editable",
      proposedByTeammateId: "ling_agent",
      title: longText("Editable workflow proposal"),
      prompt: longText("Preserve proposal editing, permissions, evidence, and all existing actions"),
      assigneeTeammateId: "teammate_builtin_engineer",
      acceptanceCriteria: [longText("No workflow status or action may overflow the channel proposal surface")],
      collaborationSteps: [{ teammateId: "ling_agent", action: "reviewed", summary: longText("Reviewed workflow state semantics and evidence") }],
      requiredTools: ["read", "bash"],
      riskSummary: longText("Permission-sensitive actions still require confirmation"),
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "proposal_status_linked",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      sourceMessageId: "msg_status_linked",
      proposedByTeammateId: "ling_agent",
      title: longText("Linked status proposal"),
      prompt: longText("Expose linked workflow and run states with product labels"),
      assigneeTeammateId: "ling_agent",
      acceptanceCriteria: ["Linked states remain visible."],
      collaborationSteps: [],
      requiredTools: ["read"],
      status: "run_failed",
      linkedWorkflowId: workflowId,
      linkedRunId,
      errorMessage: longText("The linked run stopped after a provider validation error"),
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  return state;
}

function channelMessage(id: string, body: string): Record<string, unknown> {
  return {
    id,
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "ai_reply",
    intent: "discuss",
    authorType: "ai-teammate",
    authorId: "ling_agent",
    body,
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-07-26T08:00:00.000Z",
    updatedAt: "2026-07-26T08:00:00.000Z",
  };
}

async function verifyProposalSurface(page: Page, testInfo: TestInfo, evidencePrefix: string): Promise<void> {
  await expect(page.getByRole("dialog", { name: "Task confirmation" })).toHaveCount(0);
  const editableSummary = page.getByLabel("Task proposal summary").filter({ hasText: "Editable workflow proposal" });
  const editableSummaryRow = editableSummary.locator("..");
  await expect(editableSummaryRow).toHaveClass(/channel-execution-proposal-summary-row/u);
  const assigneeAvatar = editableSummaryRow.locator(".channel-execution-proposal-summary-avatar");
  await expect(assigneeAvatar).toHaveCount(1);
  await expect(assigneeAvatar).toHaveAttribute("aria-label", "Engineer");
  await expect(assigneeAvatar.locator(".teammate-avatar-image.compact")).toHaveAttribute("src", /avatars\/teammates\/engineer\.png$/u);
  await expect(editableSummary).toContainText("Engineer · Pending confirmation");
  await capture(page, testInfo, `${evidencePrefix}-task-summary.png`);
  await editableSummary.getByRole("button", { name: "View task" }).click();
  const editableGate = page.locator('[data-conversation-decision-kind="task_proposal"]');
  await expect(editableGate).toBeVisible();
  await expect(editableGate).toContainText("Allow this task?");
  await expect(editableGate).toContainText("Engineer wants to start task");
  await expect(editableGate).toContainText("Editable workflow proposal");
  await expect(editableGate).toContainText("Read files");
  await expect(editableGate).toContainText("Run commands");
  await expect(editableGate).not.toContainText("Permission-sensitive actions still require confirmation");
  await expect(editableGate.getByRole("button", { name: "Deny" })).toBeVisible();
  await expect(editableGate.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  await expect(editableGate.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
  await expect(page.locator(".conversation-composer").filter({ has: page.getByRole("textbox") })).toHaveCount(0);
  await capture(page, testInfo, `${evidencePrefix}-task-gate.png`);

  const linkedSummary = page.getByLabel("Task proposal summary").filter({ hasText: "Linked status proposal" });
  await expect(linkedSummary).toContainText("Ling Agent · Execution failed");
  await linkedSummary.getByRole("button", { name: "View task" }).click();
  const linkedGate = page.locator('[data-conversation-decision-kind="task_proposal"]');
  await expect(linkedGate).toContainText("Linked status proposal");
  await expect(linkedGate).toContainText("Ling Agent");
  await expect(linkedGate).toContainText("Read files");
  await expect(linkedGate).toContainText("The linked run stopped after a provider validation error");
  await expect(linkedGate.getByRole("button", { name: "Deny" })).toBeVisible();
  await expect(linkedGate.getByRole("button", { name: "Allow", exact: true })).toBeVisible();
  await expect(linkedGate).not.toContainText("waiting_for_approval");
  await expect(page.getByRole("dialog", { name: "Task confirmation" })).toHaveCount(0);
}

async function openRuntimePanel(page: Page): Promise<Locator> {
  await openChannelContextPanel(page);
  const dock = page.getByRole("complementary", { name: "Channel workspace dock" });
  const modes = page.getByLabel("Channel inspector modes");
  if (!await modes.isVisible().catch(() => false)) {
    await dock.getByRole("button", { name: "Activity", exact: true }).click();
  }
  await modes.getByRole("button", { name: "Runtime", exact: true }).click();
  const panel = page.getByRole("region", { name: "Channel inspector" });
  await expect(panel.getByText("Workflow queue", { exact: true })).toBeVisible();
  return panel;
}

async function verifyWorkflowQueue(panel: Locator): Promise<void> {
  const queue = panel.locator(".workflow-queue-card");
  await expect(queue).toBeVisible();
  const workflowStatus = queue.locator('[data-status-kind="workflow"]');
  await expect(workflowStatus).toContainText("Waiting for approval");
  await expect(workflowStatus).toHaveAttribute("data-tone", "warning");
  await expect(queue.locator(".workflow-queue-head small")).not.toContainText("waiting_for_approval");
  await expect(queue.locator(".workflow-queue-actions").getByRole("button", { name: "Advance" })).toBeEnabled();
  await expect(queue.locator(".workflow-queue-actions").getByRole("button", { name: "Cancel" })).toBeEnabled();

  for (const [status, label, tone] of stepCases) {
    const card = queue.locator(".workflow-step-card").filter({ hasText: `Status case ${label}` });
    const indicator = card.locator('[data-status-kind="step"]');
    await expect(indicator).toContainText(label);
    await expect(indicator).toHaveAttribute("data-status-id", status);
    await expect(indicator).toHaveAttribute("data-tone", tone);
  }
  await expect(queue).not.toContainText("waiting_for_approval");
  const queued = queue.locator(".workflow-step-card").filter({ hasText: "Status case Queued" });
  await expect(queued.getByRole("button", { name: "Start step" })).toBeEnabled();
  await expect(queued.getByRole("button", { name: "Start + run" })).toBeEnabled();
  await expect(queued.getByRole("button", { name: "Skip" })).toBeEnabled();
  const blocked = queue.locator(".workflow-step-card").filter({ hasText: "Status case Blocked" });
  await expect(blocked.getByRole("button", { name: "Retry" })).toBeEnabled();
  await expect(blocked.getByRole("button", { name: "Cancel" })).toBeEnabled();
}

async function prepareSurface(page: Page, theme: "light" | "dark", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript((themeId) => {
    const selection = { mode: "fixed", themeId: `ling-${themeId}` };
    localStorage.setItem("ling-stack.locale", "en-US");
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themePreference", themeId);
    localStorage.setItem("ling-stack.themeBootstrapPreference", themeId);
  }, theme);
}

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console:${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror:${error.message}`));
  return errors;
}

async function expectContained(page: Page, panel: Locator): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  for (const locator of [panel.locator(".workflow-queue-card"), panel.locator(".workflow-step-card"), page.locator(".channel-execution-proposal-summary"), page.locator(".conversation-decision-gate")]) {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      expect(await locator.nth(index).evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    }
  }
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const evidenceDirectory = process.env.LING_UI2_SCREENSHOT_DIR ?? join(tmpdir(), "ling-stack-ui2-t13-p3-u");
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: join(evidenceDirectory, name), fullPage: true });
  await testInfo.attach(name, { path: join(evidenceDirectory, name), contentType: "image/png" });
}

function longText(prefix: string): string {
  return `${prefix} ${"contained workflow content ".repeat(12)}${"unbroken-segment-".repeat(10)}`;
}
