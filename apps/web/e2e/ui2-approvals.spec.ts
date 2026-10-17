import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { addExternalActionApproval, mockDaemon } from "./support/mock-daemon";
import { triggerFocusRevalidation } from "./support/focus-revalidation";
import {
  createApproval,
  createApprovalsFaultFixture,
  createHundredApprovals,
  createLongExpiredApproval,
  createPermissionApproval,
  installApprovalsFaults,
} from "./support/approvals-fixture";
import { createBaseState, createChatProvider, type MockState } from "./support/mock-state";
import { openPendingInbox } from "./support/pending-primary-navigation";

const evidenceDirectory = process.env.LING_P2_APPROVAL_EVIDENCE_DIR ?? fileURLToPath(new URL(
  "../../../docs/design/ui2.0升级/evidence/features/approvals/",
  import.meta.url,
));

test("APPROVAL-LIST handles 100 rows, keyboard, search, retained refresh failure, and response races", async ({ page }) => {
  test.setTimeout(60_000);
  await prepareSurface(page, "en-US", "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "pending" });
  state.approvals = createHundredApprovals();
  const faults = createApprovalsFaultFixture();
  await mockDaemon(page, state);
  await installApprovalsFaults(page, state, faults);
  const runtime = watchRuntime(page);
  const surface = await openInbox(page);
  const list = surface.locator(".approvals-ui2-list");
  await expect(list.getByRole("option")).toHaveCount(100);
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  const row = list.getByRole("option", { name: "Approval 050" });
  await row.focus();
  await row.press("Enter");
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(surface.locator("[data-approval-detail-id='approval_050']")).toBeVisible();

  const search = surface.getByRole("textbox", { name: "Search" });
  await search.fill("Approval 100");
  await expect(list.getByRole("option", { name: "Approval 100" })).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await search.fill("no matching approval fixture");
  await expect(surface.getByText("No activity matches these filters").first()).toBeVisible();
  await surface.getByLabel("Filters").getByRole("button", { name: "Clear filters" }).click();

  faults.failNextList = true;
  await refreshInbox(surface);
  await expect(surface.getByText("Synthetic approval refresh failure")).toBeVisible();
  await expect(surface.getByText("Synthetic approval refresh failure")).toHaveCount(1);
  await expect(surface.getByRole("region", { name: "Decision", exact: true }).getByRole("alert")).toHaveCount(0);
  await expect(list.getByRole("option")).toHaveCount(100);
  await refreshInbox(surface);
  await expect(surface.getByText("Synthetic approval refresh failure")).toHaveCount(0);

  faults.wrongCwdNextList = true;
  await refreshInbox(surface);
  await expect(surface.getByText("Stale workspace approval")).toHaveCount(0);
  faults.listDelayMs = 180;
  await refreshInbox(surface, false);
  const raceRow = list.getByRole("option", { name: "Approval 070" });
  await raceRow.click();
  await expect(raceRow).toHaveAttribute("aria-selected", "true");
  await expect(surface.getByRole("button", { name: /Refresh|刷新/ })).toHaveCount(0);
  await expect(raceRow).toHaveAttribute("aria-selected", "true");

  await assertNoHorizontalOverflow(page, surface);
  await captureEvidence(page, "1440x960-ling-light-actionable-list-detail.png");
  await runtime.assertClean([503]);
});

test("History empty state is truthful in Dark Chinese and remains keyboard-safe", async ({ page }) => {
  await prepareSurface(page, "zh-CN", "dark", 1280, 800);
  const state = createBaseState({ approvalStatus: "expired" });
  state.approvals = [];
  await mockDaemon(page, state);
  const runtime = watchRuntime(page);
  const surface = await openInbox(page);
  await surface.getByText("历史", { exact: true }).click();
  await expect(surface.getByText("收件箱已清空")).toBeVisible();
  await assertNoHorizontalOverflow(page, surface);
  await captureEvidence(page, "1280x800-ling-dark-empty-history.png");
  await runtime.assertClean();
});

test("Queue category matrix never fabricates decisions and high-risk Dialog blocks duplicate activation", async ({ page }) => {
  test.setTimeout(60_000);
  await prepareSurface(page, "en-US", "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "pending" });
  state.approvals = [
    createApproval({ id: "approval_offline", channelId: "channel_offline", risk: "high", title: "Approve offline credential change" }),
    createApproval({ id: "approval_route", title: "Route unowned work", actionType: "credential_change" }),
    createApproval({ id: "approval_repair", runId: state.runs[0]?.id, title: "Repair expired run approval", status: "expired", expiresAt: "2000-01-01T00:00:00.000Z" }),
  ];
  const external = addExternalActionApproval(state, { actionId: "external_execute", approvalId: "approval_execute", status: "approved", approvalStatus: "approved" });
  const faults = createApprovalsFaultFixture();
  faults.decisionDelayMs = 300;
  await mockDaemon(page, state);
  await installApprovalsFaults(page, state, faults);
  const runtime = watchRuntime(page);
  const surface = await openInbox(page);

  await selectApproval(surface, "Route unowned work");
  await expect(selectedDetail(surface).getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(selectedDetail(surface).getByRole("button", { name: "Deny" })).toHaveCount(0);
  await expect(selectedDetail(surface).getByRole("button", { name: "Open Work Board" })).toBeVisible();

  await selectApproval(surface, "Repair expired run approval");
  await expect(selectedDetail(surface).getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(selectedDetail(surface).getByRole("button", { name: "Open run" })).toBeVisible();

  await selectApproval(surface, external.approval.title);
  await expect(selectedDetail(surface).getByRole("button", { name: "Execute action" })).toBeVisible();
  await expect(selectedDetail(surface).getByRole("button", { name: "Approve" })).toHaveCount(0);

  await selectApproval(surface, "Approve offline credential change");
  const detail = selectedDetail(surface);
  const approveTrigger = detail.getByRole("button", { name: "Approve" });
  await approveTrigger.click();
  let dialog = page.getByRole("dialog", { name: /Decision: Approve offline credential change/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(dialog.getByText("High-risk approvals need a decision reason.")).toBeVisible();
  await dialog.getByLabel("Decision reason").fill("Reviewed external consequence");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(approveTrigger).toBeFocused();

  await approveTrigger.click();
  dialog = page.getByRole("dialog", { name: /Decision: Approve offline credential change/ });
  await dialog.getByLabel("Decision reason").fill("Reviewed external consequence");
  await dialog.getByRole("button", { name: "Approve" }).dblclick();
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await expect(detail.locator(".approval-decision-panel button").filter({ hasText: "Deny" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-high-risk-confirm.png");
  await expect(dialog).toHaveCount(0);
  expect(faults.decisionCalls.get("approval_offline")).toBe(1);
  await runtime.assertClean();
});

test("Decision failure retains its draft, selection changes reset state, and expiry refreshes authority", async ({ page }) => {
  test.setTimeout(60_000);
  await prepareSurface(page, "en-US", "dark", 1280, 800);
  const state = createBaseState({ approvalStatus: "pending" });
  state.approvals = [
    createApproval({ id: "approval_high_a", channelId: "channel_offline", risk: "high", title: "High risk request A" }),
    createApproval({ id: "approval_high_b", channelId: "channel_offline", risk: "critical", title: "High risk request B" }),
    createApproval({ id: "approval_denied", channelId: "channel_offline", title: "Denied request", status: "denied", resolvedAt: "2026-07-22T01:10:00.000Z" }),
    createApproval({ id: "approval_cancelled", channelId: "channel_offline", title: "Cancelled request", status: "cancelled", resolvedAt: "2026-07-22T01:11:00.000Z" }),
  ];
  const faults = createApprovalsFaultFixture();
  await mockDaemon(page, state);
  await installApprovalsFaults(page, state, faults);
  const runtime = watchRuntime(page);
  const surface = await openInbox(page);

  await selectApproval(surface, "High risk request A");
  await selectedDetail(surface).getByLabel("Decision reason").fill("Draft for A");
  await selectApproval(surface, "High risk request B");
  await expect(selectedDetail(surface).getByLabel("Decision reason")).toHaveValue("");
  await selectedDetail(surface).getByRole("button", { name: "Approve" }).click();
  let dialog = page.getByRole("dialog", { name: /Decision: High risk request B/ });
  await dialog.getByLabel("Decision reason").fill("Keep this reason after failure");
  faults.failNextDecisionId = "approval_high_b";
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(dialog.getByText("Synthetic approval decision failure")).toBeVisible();
  await expect(surface.locator(".approvals-ui2-page-feedback")).toHaveCount(0);
  await expect(dialog.getByLabel("Decision reason")).toHaveValue("Keep this reason after failure");
  await expect(dialog.getByRole("button", { name: "Retry" })).toBeVisible();
  await captureEvidence(page, "1280x800-ling-dark-decision-failure.png");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await selectApproval(surface, "High risk request A");
  await expect(selectedDetail(surface).getByText("Synthetic approval decision failure")).toHaveCount(0);
  await selectApproval(surface, "High risk request B");
  await expect(selectedDetail(surface).getByText("Synthetic approval decision failure")).toBeVisible();
  await selectedDetail(surface).getByRole("button", { name: "Retry" }).click();
  dialog = page.getByRole("dialog", { name: /Decision: High risk request B/ });
  await dialog.getByLabel("Decision reason").fill("Retry only the failed B request");
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog).toHaveCount(0);

  await selectApproval(surface, "High risk request A");
  await expect(selectedDetail(surface).getByLabel("Decision reason")).toHaveValue("");
  await selectedDetail(surface).getByRole("button", { name: "Approve" }).click();
  dialog = page.getByRole("dialog", { name: /Decision: High risk request A/ });
  await dialog.getByLabel("Decision reason").fill("Authority may expire this request");
  faults.expireOnNextDecisionId = "approval_high_a";
  await dialog.getByRole("button", { name: "Approve" }).click();
  await expect(dialog).toHaveCount(0);
  await surface.getByText("History", { exact: true }).click();
  await expect(surface.getByRole("option", { name: "Denied request" })).toBeVisible();
  await expect(surface.getByRole("option", { name: "Cancelled request" })).toBeVisible();
  await selectApproval(surface, "High risk request A");
  await expect(selectedDetail(surface)).toContainText("expired");
  await expect(selectedDetail(surface).getByRole("button", { name: "Approve" })).toHaveCount(0);
  await runtime.assertClean([409, 503]);
});

test("Permission delta remains durable after approval and shows add, remove, and unchanged scopes", async ({ page }) => {
  await prepareSurface(page, "zh-CN", "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "pending" });
  state.approvals = [createPermissionApproval()];
  await mockDaemon(page, state);
  const runtime = watchRuntime(page);
  const surface = await openInbox(page);
  let detail = selectedDetail(surface);
  await expect(detail.getByText("tool edit")).toBeVisible();
  await expect(detail.getByText("tool read")).toBeVisible();
  await expect(detail.getByText("tool bash")).toBeVisible();
  await detail.getByRole("button", { name: "批准" }).click();
  const dialog = page.getByRole("dialog", { name: /决策: Expand runtime write scope/ });
  await dialog.getByLabel("决策理由").fill("已核对权限后果");
  await dialog.getByRole("button", { name: "批准" }).click();
  await expect(dialog).toHaveCount(0);
  await surface.getByText("历史", { exact: true }).click();
  await selectApproval(surface, "Expand runtime write scope");
  detail = selectedDetail(surface);
  await expect(detail.getByText("结果")).toBeVisible();
  await expect(detail.getByText("tool edit")).toBeVisible();
  await expect(detail.getByText("tool read")).toBeVisible();
  await expect(detail.getByText("tool bash")).toBeVisible();
  await captureEvidence(page, "1440x960-ling-light-permission-delta.png");
  await runtime.assertClean();
});

test("External execute, cancel, detail, busy, and failures remain independent from approval decisions", async ({ page }) => {
  test.setTimeout(60_000);
  await prepareSurface(page, "zh-CN", "dark", 1280, 800);
  const state = createBaseState({ approvalStatus: "expired" });
  state.externalWorkActions = [];
  state.artifactsByExternalAction = {};
  const execute = addExternalActionApproval(state, { actionId: "action_execute", approvalId: "approval_external_execute", status: "approved", approvalStatus: "approved" });
  const cancel = addExternalActionApproval(state, { actionId: "action_cancel", approvalId: "approval_external_cancel", status: "approved", approvalStatus: "approved", kind: "github_pr_review" });
  const pending = addExternalActionApproval(state, { actionId: "action_pending", approvalId: "approval_external_pending", status: "waiting_for_approval", approvalStatus: "pending" });
  pending.approval.title = "Approve pending GitHub comment";
  const faults = createApprovalsFaultFixture();
  faults.externalDetailFailureIds.add(execute.action.id);
  await mockDaemon(page, state);
  await installApprovalsFaults(page, state, faults);
  const runtime = watchRuntime(page);
  const surface = await openInbox(page);

  await selectApproval(surface, pending.approval.title);
  await selectedDetail(surface).getByRole("button", { name: "批准" }).click();
  await expect.poll(() => pending.approval.status).toBe("approved");
  await expect(selectedDetail(surface).getByRole("button", { name: "执行动作" })).toBeVisible();

  await selectApproval(surface, execute.approval.title);
  await expect(selectedDetail(surface).getByText("Synthetic external detail failure")).toBeVisible();
  faults.externalDetailFailureIds.delete(execute.action.id);
  await selectedDetail(surface).getByRole("button", { name: "重试" }).click();
  await expect(selectedDetail(surface).getByText("Synthetic external detail failure")).toHaveCount(0);
  faults.failNextExternalExecuteId = execute.action.id;
  await selectedDetail(surface).getByRole("button", { name: "执行动作" }).click();
  await expect(selectedDetail(surface).getByText("Synthetic external execute failure")).toBeVisible();
  await expect(selectedDetail(surface).getByRole("button", { name: "批准" })).toHaveCount(0);
  await captureEvidence(page, "1280x800-ling-dark-external-action-failure.png");
  await selectedDetail(surface).getByRole("button", { name: "重试" }).click();
  await expect.poll(() => execute.action.status).toBe("succeeded");

  await selectApproval(surface, cancel.approval.title);
  faults.failNextExternalCancelId = cancel.action.id;
  await selectedDetail(surface).getByRole("button", { name: "取消提案" }).click();
  await expect(selectedDetail(surface).getByText("Synthetic external cancel failure")).toBeVisible();
  await selectedDetail(surface).getByRole("button", { name: "重试" }).click();
  await expect.poll(() => cancel.action.status).toBe("cancelled");
  expect(execute.approval.status).toBe("approved");
  expect(cancel.approval.status).toBe("approved");
  await surface.getByText("历史", { exact: true }).click();
  await selectApproval(surface, execute.approval.title);
  await expect(selectedDetail(surface)).toContainText(/succeeded|成功/);
  await selectApproval(surface, cancel.approval.title);
  await expect(selectedDetail(surface)).toContainText(/cancelled|已取消/);
  await runtime.assertClean([503]);
});

test("A pending external approval becomes executable without executing implicitly", async ({ page }) => {
  await prepareSurface(page, "en-US", "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "expired" });
  const pending = addExternalActionApproval(state);
  await mockDaemon(page, state);
  const runtime = watchRuntime(page);
  const surface = await openInbox(page);
  await selectApproval(surface, pending.approval.title);
  await selectedDetail(surface).getByRole("button", { name: "Approve" }).click();
  await expect.poll(() => pending.approval.status).toBe("approved");
  await expect(selectedDetail(surface)).toContainText("approved");
  await expect(selectedDetail(surface).getByRole("button", { name: "Execute action" })).toBeVisible();
  expect(state.externalActionExecuteCalls[pending.action.id] ?? 0).toBe(0);
  await runtime.assertClean();
});

test("a committed approval with deferred reconciliation warns without claiming the decision failed", async ({ page }) => {
  await prepareSurface(page, "en-US", "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "expired" });
  const pending = addExternalActionApproval(state, {
    actionId: "action_deferred",
    approvalId: "approval_deferred",
    status: "waiting_for_approval",
    approvalStatus: "pending",
  });
  const approval = pending.approval;
  approval.title = "Deferred command";
  await mockDaemon(page, state);
  await page.route(/\/approvals\/approval_deferred\/approve(?:\?.*)?$/u, async (route) => {
    approval.status = "approved";
    approval.resolvedAt = "2026-07-22T01:30:00.000Z";
    approval.resolvedBy = "local-user";
    await route.fulfill({ json: {
      approval,
      postCommit: { status: "deferred", code: "approval_postcommit_reconciliation_required" },
    } });
  });
  const surface = await openInbox(page);
  await selectApproval(surface, approval.title);
  await selectedDetail(surface).getByRole("button", { name: "Approve" }).click();
  await expect.poll(() => approval.status).toBe("approved");
  await expect(page.locator('[data-ling-overlay="toast"][data-scope="approval:approval_deferred:postcommit"]'))
    .toContainText("Approval was recorded, but execution recovery is pending");
  await expect(selectedDetail(surface)).not.toContainText("Approval failed");
});

test("Runtime approval belongs to its channel composer and leaves other conversations usable", async ({ page }) => {
  await prepareSurface(page, "en-US", "light", 1440, 960);
  const state = createBaseState({ approvalStatus: "pending" });
  state.providers = [createChatProvider({
    lastCheck: {
      ok: true,
      code: "ready",
      message: "Provider is reachable.",
      checkedAt: "2026-05-22T00:00:00.000Z",
    },
  })];
  state.channels.push({
    ...state.channels[0],
    id: "channel_general",
    name: "General",
    defaultTeammateId: undefined,
  });
  const runId = state.runs[0]?.id;
  const critical = createPermissionApproval({ id: "inline_critical", runId, channelId: undefined, risk: "critical", title: "Critical runtime permission" });
  const medium = createApproval({ id: "inline_medium", runId, actionType: "bash", risk: "medium", title: "Medium shell approval", payload: { type: "bash", command: "pnpm test" } });
  const low = createApproval({ id: "inline_low", runId, actionType: "edit", risk: "low", title: "Low file approval", payload: { type: "file_edit", path: "README.md" } });
  state.approvals = [medium, critical, low, critical];
  await mockDaemon(page, state);
  let failMediumDeny = true;
  await page.route(/\/approvals\/inline_medium\/deny(?:\?.*)?$/u, async (route) => {
    if (failMediumDeny) {
      failMediumDeny = false;
      await route.fulfill({ status: 503, json: { error: "mock_approval_failed", message: "Synthetic approval decision failure" } });
      return;
    }
    await route.fallback();
  });
  const runtime = watchRuntime(page);
  await page.goto("/");
  const navigation = page.getByRole("complementary", { name: /Sidebar display|侧栏显示/u });
  const engineeringButton = navigation.getByRole("button", { name: "Engineering" }).first();
  const engineeringRow = navigation.locator(".sidebar-row-shell").filter({ hasText: "Engineering" }).first();
  await expect(engineeringRow).toHaveAttribute("data-sidebar-row-status", "waiting");
  await expect(engineeringRow).toContainText("3 pending approvals");

  await navigation.getByRole("button", { name: "General" }).click();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(page.getByRole("region", { name: "Allow this action?" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Allow this action?" })).toHaveCount(0);

  await engineeringButton.click();
  const gate = page.getByRole("region", { name: "Allow this action?" });
  await expect(gate).toBeVisible();
  await expect(page.getByLabel("Channel composer")).toHaveCount(0);
  await expect(gate).toContainText("Grant runtime permission: core_tool: Release repair needs one additional editor tool.");
  await expect(gate).not.toContainText("Critical runtime permission");
  await expect(gate).not.toContainText("pending approvals");
  await expect(gate).not.toContainText("Medium shell approval");
  await expect(gate.getByLabel("Decision reason")).toHaveCount(0);
  await expect(gate.locator("details")).toHaveCount(0);
  await expect(gate).not.toContainText(/critical|risk|Run ID|workspace/iu);
  await expect(page.locator(".approval-inline-strip")).toHaveCount(0);
  await captureEvidence(page, "1440x960-ling-light-runtime-approval-composer-gate.png");

  await navigation.getByRole("button", { name: "General" }).click();
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await engineeringButton.click();
  await gate.getByRole("button", { name: "Allow once" }).click();
  await expect.poll(() => state.approvals.find((item) => item.id === "inline_critical")?.status).toBe("approved");
  await expect(gate).toContainText("Run command: pnpm test");
  await expect(gate).not.toContainText("Medium shell approval");
  await gate.getByRole("button", { name: "Deny" }).click();
  await expect(gate).toContainText("Synthetic approval decision failure");
  await expect(gate.getByRole("button", { name: "Retry" })).toBeVisible();
  await gate.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => state.approvals.find((item) => item.id === "inline_medium")?.status).toBe("denied");
  await expect(gate).toContainText("Modify file: README.md");
  await expect(gate).not.toContainText("Low file approval");
  await gate.getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => state.approvals.find((item) => item.id === "inline_low")?.status).toBe("denied");
  await expect(gate).toHaveCount(0);
  await expect(page.getByLabel("Channel composer")).toBeVisible();
  await expect(engineeringRow).not.toHaveAttribute("data-sidebar-row-status", "waiting");
  await runtime.assertClean([503]);
});

test("Expired long payload stays folded and contained at 1280 Dark Chinese", async ({ page }) => {
  await prepareSurface(page, "zh-CN", "dark", 1280, 800);
  const state = createBaseState({ approvalStatus: "expired" });
  state.approvals = [createLongExpiredApproval()];
  await mockDaemon(page, state);
  const runtime = watchRuntime(page);
  const surface = await openInbox(page);
  const detail = selectedDetail(surface);
  await expect(detail).toContainText("expired");
  const technical = detail.locator("details", { hasText: "技术详情" });
  await expect(technical).not.toHaveAttribute("open", "");
  await assertNoHorizontalOverflow(page, surface);
  await captureEvidence(page, "1280x800-ling-dark-expired-long-payload.png");
  await technical.locator("summary").click();
  await expect(technical).toHaveAttribute("open", "");
  await assertNoHorizontalOverflow(page, surface);
  await runtime.assertClean();
});

async function prepareSurface(page: Page, locale: "en-US" | "zh-CN", theme: "light" | "dark", width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript(({ selectedLocale, selectedTheme }) => {
    const themeId = selectedTheme === "dark" ? "ling-dark" : "ling-light";
    const selection = { mode: "fixed", themeId };
    localStorage.setItem("ling-stack.locale", selectedLocale);
    localStorage.setItem("ling-stack.themeSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapSelection", JSON.stringify(selection));
    localStorage.setItem("ling-stack.themeBootstrapPreference", selectedTheme);
  }, { selectedLocale: locale, selectedTheme: theme });
}

async function openInbox(page: Page): Promise<Locator> {
  await page.goto("/");
  const surface = await openPendingInbox(page);
  await expect(surface).toBeVisible();
  await expect(surface.getByRole("heading", { name: /Inbox|收件箱/ })).toBeVisible();
  return surface;
}

async function refreshInbox(surface: Locator, waitForCompletion = true): Promise<void> {
  const response = waitForCompletion
    ? surface.page().waitForResponse((candidate) => candidate.request().method() === "GET" && new URL(candidate.url()).pathname === "/approvals")
    : undefined;
  await triggerFocusRevalidation(surface.page());
  if (response) {
    await response;
  }
}

async function selectApproval(surface: Locator, title: string): Promise<void> {
  const row = surface.getByRole("option", { name: title });
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");
}

function selectedDetail(surface: Locator): Locator {
  return surface.locator(".approvals-ui2-detail");
}

function watchRuntime(page: Page): { readonly assertClean: (allowedStatuses?: readonly number[]) => Promise<void> } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    async assertClean(allowedStatuses = []): Promise<void> {
      const unexpected = consoleErrors.filter((message) => !allowedStatuses.some((status) => message.includes(`status of ${status}`)));
      expect(pageErrors, "page errors").toEqual([]);
      expect(unexpected, "unexpected console errors").toEqual([]);
    },
  };
}

async function assertNoHorizontalOverflow(page: Page, surface: Locator): Promise<void> {
  const documentOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(documentOverflow).toBeLessThanOrEqual(1);
  for (const selector of [".approvals-ui2-layout", ".approvals-ui2-list", ".approvals-ui2-detail"]) {
    const region = surface.locator(selector);
    if (await region.count()) expect(await region.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  if (process.env.LING_CAPTURE_UI2_EVIDENCE !== "1") return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ animations: "disabled", path: `${evidenceDirectory}${filename}` });
}
