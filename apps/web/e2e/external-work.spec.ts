import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import {
  addExternalActionApproval,
  addExternalWorkCiTriage,
  createBaseState,
} from "./support/mock-state";
import {
  openChannelChatTools,
} from "./support/test-helpers";

test("external action approval card requires explicit execute after approval", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const { action } = addExternalActionApproval(state);
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Inbox" }).click();
  const externalApproval = page.getByLabel("Approval requests").locator(".approval-row").filter({ hasText: "Approve GitHub comment" });
  await expect(externalApproval.getByLabel("External action audit")).toContainText("github_comment");
  await expect(externalApproval.getByLabel("External action audit")).toContainText("tianxiaochannel-oss88/ling-stack");
  await expect(externalApproval.getByLabel("External action audit")).toContainText("github_pull_request #42");
  await expect(externalApproval.getByLabel("External action audit")).toContainText("Looks good from Ling.");
  await expect(externalApproval.getByLabel("External action artifacts")).toContainText("Approval preview");
  await expect(externalApproval.getByRole("button", { name: "Execute action" })).toHaveCount(0);

  await externalApproval.getByRole("button", { name: "Approve" }).click();
  await expect(externalApproval).toContainText("approved");
  await expect.poll(() => state.externalActionExecuteCalls[action.id] ?? 0).toBe(0);
  await expect(externalApproval.getByRole("button", { name: "Execute action" })).toBeVisible();

  await externalApproval.getByRole("button", { name: "Execute action" }).click();
  await expect(externalApproval).toContainText("succeeded");
  await expect(externalApproval.getByLabel("External action artifacts")).toContainText("GitHub action execution result");
  await expect.poll(() => state.externalActionExecuteCalls[action.id] ?? 0).toBe(1);
});

test("external action approval card shows strict GitHub PR review audit", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const { action } = addExternalActionApproval(state, {
    kind: "github_pr_review",
    reviewEvent: "REQUEST_CHANGES",
  });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Inbox" }).click();
  const externalApproval = page.getByLabel("Approval requests").locator(".approval-row").filter({ hasText: "Approve GitHub PR review" });
  await expect(externalApproval.getByLabel("External action audit")).toContainText("github_pr_review");
  await expect(externalApproval.getByLabel("External action audit")).toContainText("REQUEST_CHANGES");
  await expect(externalApproval.getByLabel("External action audit")).toContainText("Please fix the failing CI before merge.");
  await expect(externalApproval.getByLabel("External action audit")).toContainText("github_pull_request #42");
  await expect(externalApproval.getByRole("button", { name: "Execute action" })).toHaveCount(0);

  await externalApproval.getByRole("button", { name: "Approve" }).click();
  await externalApproval.getByLabel("Decision reason").fill("Strict PR review approved.");
  await externalApproval.getByRole("button", { name: "Confirm approve" }).click();
  await expect(externalApproval).toContainText("approved");
  await expect.poll(() => state.externalActionExecuteCalls[action.id] ?? 0).toBe(0);
  await expect(externalApproval.getByRole("button", { name: "Execute action" })).toBeVisible();
});

test("external action approval card can cancel without executing", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const { action } = addExternalActionApproval(state);
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Inbox" }).click();
  const externalApproval = page.getByLabel("Approval requests").locator(".approval-row").filter({ hasText: "Approve GitHub comment" });
  await expect(externalApproval.getByRole("button", { name: "Execute action" })).toHaveCount(0);

  await externalApproval.getByRole("button", { name: "Cancel proposal" }).click();
  await expect(externalApproval).toContainText("cancelled");
  await expect(externalApproval).toContainText("Action cancelled");
  await expect.poll(() => state.externalActionExecuteCalls[action.id] ?? 0).toBe(0);
});

test("external action approval card shows stale target audit as read-only", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  addExternalActionApproval(state, { status: "stale_target", approvalStatus: "approved" });
  await mockDaemon(page, state);
  await page.goto("/");

  await page.getByLabel("Ling Stack navigation").getByRole("button", { name: "Inbox" }).click();
  const externalApproval = page.getByLabel("Approval requests").locator(".approval-row").filter({ hasText: "Approve GitHub comment" });
  await expect(externalApproval.getByLabel("External action audit")).toContainText("stale_target");
  await expect(externalApproval.getByLabel("External action audit")).toContainText("PR head SHA changed before execution.");
  await expect(externalApproval.getByRole("button", { name: "Execute action" })).toHaveCount(0);
  await expect(externalApproval.getByRole("button", { name: "Cancel proposal" })).toHaveCount(0);
});

test("workspace surfaces GitHub CI triage records without starting runs", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  const linkedTriage = addExternalWorkCiTriage(state);
  addExternalWorkCiTriage(state, {
    id: "ci_triage_stale",
    status: "stale",
    taskId: "task_other",
    runId: "run_other",
    checkName: "integration-tests",
    lastErrorMessage: "PR head moved before the fix task was reviewed.",
  });
  await mockDaemon(page, state);
  await page.goto("/");

  await openChannelChatTools(page);
  const workspaceTriage = page.locator(".channel-activity-tools .ci-triage-panel").first();
  await expect(workspaceTriage).toContainText("GitHub CI triage");
  await expect(workspaceTriage).toContainText("unit-tests");
  await expect(workspaceTriage).toContainText("tianxiaochannel-oss88/ling-stack");
  await expect(workspaceTriage).toContainText("PR #42");
  await expect(workspaceTriage).toContainText("corepack pnpm test");
  await expect(workspaceTriage).toContainText("apps/web/src/features/workspace/WorkspaceClientView.tsx");
  await expect(workspaceTriage).toContainText("CI failure log");
  await expect(workspaceTriage).toContainText("stale");

  await expect(page.locator(".right-panel")).toHaveCount(0);
  await expect(workspaceTriage.getByRole("button", { name: "Open run" }).first()).toBeVisible();
  await expect.poll(() => state.ciTriageRunCalls[linkedTriage.triage.id] ?? 0).toBe(0);
});
