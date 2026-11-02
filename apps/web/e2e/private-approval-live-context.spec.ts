import { expect, test } from "@playwright/test";
import type { TeammateDirectMessage } from "@ling-stack/contracts";
import { installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { mockDaemon, cwd } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { createApproval } from "./support/approvals-fixture";

for (const scenario of [
  { missing: "work-unit" },
  { missing: "run-and-work-unit" },
  { missing: "run-and-work-unit", invalid: "timeline-owner" },
  { missing: "run-and-work-unit", invalid: "work-unit-owner" },
] as const) {
test(`private approval with ${scenario.missing} absent and ${"invalid" in scenario ? scenario.invalid : "owned"} live context`, async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
  const state = createBaseState({ approvalStatus: "expired" });
  const owner = installTeammateWorkCellFixture(state);
  const run = state.runs[0]!;
  const messages = state.teammateDirectMessages as TeammateDirectMessage[];
  const assistant = messages.find(message => message.authorType === "ai-teammate")!;
  const user = messages.find(message => message.authorType === "local-user")!;
  Object.assign(run, { workUnitId: "private-live-unit", status: "waiting_for_approval", endedAt: undefined });
  state.workUnits = [{
    id: run.workUnitId!, workspaceId: user.workspaceId, kind: "teammate_direct_reply",
    ownerType: "teammate_direct_message", ownerId: user.id, teammateId: owner.teammateId,
    linkedRunId: run.id, linkedMessageId: assistant.id, idempotencyKey: "private-live-unit",
    status: "waiting_for_approval", priority: 0, attemptCount: 1, createdByActor: "local-user",
    request: { threadId: run.threadId, sourceMessageId: user.id }, timeoutPolicy: {},
    createdAt: run.createdAt, updatedAt: run.updatedAt,
  }];
  state.terminalReports = [];
  state.executionActions = [];
  if ("invalid" in scenario && scenario.invalid === "timeline-owner") {
    const thread = state.threads.find(thread => thread.id === run.threadId)!;
    thread.teammateId = "another-teammate";
  }
  if ("invalid" in scenario && scenario.invalid === "work-unit-owner") {
    state.workUnits[0]!.teammateId = "another-teammate";
  }
  const approval = createApproval({ id: "private-live-approval", runId: run.id, actionType: "write",
    channelId: undefined, payload: { type: "file_write", path: "proof/cents.mjs" },
    availableDecisions: ["approve_once", "deny"] });
  state.approvals = [approval];
  await mockDaemon(page, state);
  // The private endpoint retains the current Host snapshot. Only global list
  // reads are stale, as when this task starts after application bootstrap.
  await page.route(url => url.pathname === "/work-units", route => route.fulfill({ json: { cwd, workUnits: [] } }));
  if (scenario.missing === "run-and-work-unit") {
    await page.route(url => url.pathname === "/runs" && url.searchParams.has("cwd"),
      route => route.fulfill({ json: { cwd, runs: [] } }));
  }
  await page.goto("/");
  const runtimeRead = page.waitForResponse(response => new URL(response.url()).pathname === `/teammates/${owner.teammateId}/direct-runtime`);
  await page.getByRole("button", { name: owner.displayName, exact: true }).click();
  await runtimeRead;
  const gate = page.getByRole("region", { name: "Allow this action?", exact: true });
  if ("invalid" in scenario) {
    await expect(page.getByLabel("Private chat composer", { exact: true })).toBeVisible();
    await expect(page.getByText(user.body, { exact: true })).toBeVisible();
    await expect(gate).toHaveCount(0);
    expect(state.approvalDecisionRequests).toHaveLength(0);
    return;
  }
  await expect(gate).toHaveCount(1);
  await expect(gate).toHaveAttribute("data-surface", "teammate_direct");
  await expect(gate).toContainText("proof/cents.mjs");
  await expect(gate.getByRole("button", { name: "Allow once", exact: true })).toBeEnabled();
  await expect(gate.getByRole("button", { name: "Deny", exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("owned-private-pending.png") });
  await gate.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect.poll(() => approval.status).toBe("approved");
  await expect(gate).toHaveCount(0);
  expect(state.approvalDecisionRequests).toHaveLength(1);
});
}
