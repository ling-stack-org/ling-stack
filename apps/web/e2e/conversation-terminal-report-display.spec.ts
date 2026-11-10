import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd } from "./support/mock-state";
import { attachCommittedChannelReportItem, completedTerminalReport, installChannelWorkCellFixture, installNormalWorkCellFixture, installTeammateWorkCellFixture } from "./support/conversation-work-cell-fixture";
import { openEngineeringChannel } from "./support/test-helpers";

// API fixtures exercise production adapters/renderers; they are not native QA.
// The 2026-10-27 execution-detail ownership contract replaces the old full-report ending.
test.beforeEach(async ({ page }) => {
  // The channel read boundary rejects an empty cwd; own the synthetic workspace
  // instead of depending on the developer's VITE default or persisted browser state.
  await page.addInitScript((workspaceCwd) => localStorage.setItem("ling-stack.workspaceCwd", workspaceCwd), cwd);
});
for (const surface of ["normal", "private", "channel"] as const) {
  for (const status of ["succeeded", "failed", "blocked", "cancelled", "partially_succeeded"] as const) {
    test(`${surface} ${status} separates final narration from report evidence`, async ({ page }, testInfo) => {
      await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const state = createBaseState({ approvalStatus: "expired" });
      const title = surface === "normal" ? installNormalWorkCellFixture(state) : undefined;
      const teammate = surface === "private" ? installTeammateWorkCellFixture(state) : undefined;
      if (surface === "channel") {
        const { threadId, runId } = installChannelWorkCellFixture(state, "report-display");
        const originalTurnId = state.turnRunLinks.find((link) => link.runId === runId)!.turnId;
        const sourceMessage = state.channelMessages.find((message) => message.linkedRunId === runId)!;
        // The mock channel API derives canonical user-item turns from message ids.
        // Keep the WorkCell, Run and published report on that exact same turn;
        // production deliberately rejects a different turn in the same thread.
        const turnId = `turn_${sourceMessage.id}`;
        // Run/Turn do not have a partially_succeeded state. This fixture retains
        // successful command evidence, while the failed Run/Turn reports partial work.
        const runStatus = status === "blocked" || status === "partially_succeeded" ? "failed" : status;
        const turnStatus = status === "partially_succeeded" ? "failed" : status;
        state.runs = state.runs.map((run) => run.id === runId ? { ...run, turnId, status: runStatus } : run);
        state.turns = state.turns.map((turn) => turn.id === originalTurnId ? { ...turn, id: turnId, status: turnStatus } : turn);
        state.turnRunLinks = state.turnRunLinks.map((link) => link.runId === runId ? { ...link, turnId } : link);
        state.threads = state.threads.map((thread) => thread.id === threadId ? { ...thread, status: turnStatus } : thread);
        state.terminalReports = [{ ...completedTerminalReport({ id: "report-channel-display", threadId, turnId, runId, title: "Completed" }), channelId: "channel_engineering" }];
      }
      const original = state.terminalReports[0]!;
      const turnId = original.turnId ?? state.turnRunLinks.find((link) => link.runId === original.source.id)!.turnId;
      if (teammate) {
        const message = state.teammateDirectMessages.find((item) => item.authorType === "ai-teammate")!;
        const turnId = state.turnRunLinks.find((link) => link.runId === message.linkedRunId)!.turnId;
        state.conversationItems!.push({
          schemaVersion: 1, id: message.id, workspaceId: "workspace_default", threadId: original.threadId!, turnId,
          sequence: 3, revision: 1, kind: "assistant_message", status: "committed", actorType: "ai_teammate",
          actorId: teammate.teammateId, visibility: "agent_private", visibilityOwnerId: teammate.teammateId,
          payload: { body: message.body, format: "markdown", phase: "final", deliveryStatus: "ready", presentationRole: "reply_result" },
          domainRefs: [{ type: "message", id: message.id }, { type: "run", id: message.linkedRunId! }, { type: "turn", id: turnId }],
          createdAt: message.createdAt, updatedAt: message.updatedAt, committedAt: message.updatedAt,
        });
      }
      state.terminalReports = [{ ...original,
        outcome: { ...original.outcome, status, summary: "REPORT_SECOND_SUMMARY_SENTINEL" },
        verification: [{ id: "check-display", title: "Verified command", status: "passed", command: "node --test", durationMs: 12345, sourceRefs: [] }],
      }];
      state.conversationItems = state.conversationItems?.map((item) => item.id === original.resultItemId
        ? { ...item, payload: { ...item.payload, outcomeStatus: status } } : item);
      if (surface === "channel") {
        attachCommittedChannelReportItem(state, state.terminalReports[0]!);
        state.channelConversationItemExtras!.push({
          schemaVersion: 1, id: "reply-channel-display", workspaceId: "workspace_default", channelId: "channel_engineering",
          threadId: original.threadId, turnId, sequence: 3, revision: 1, kind: "assistant_message", status: "committed",
          actorType: "ling_agent", actorId: "ling_agent", visibility: "channel",
          payload: { body: "Focused channel WorkCell completed.", format: "markdown", phase: "final", deliveryStatus: "ready" },
          domainRefs: [{ type: "run", id: state.turnRunLinks.find((link) => link.turnId === turnId)!.runId }],
          createdAt: original.committedAt, updatedAt: original.committedAt, committedAt: original.committedAt,
        });
      }
      await mockDaemon(page, state);
      await page.goto("/");
      if (title) await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
      if (teammate) await page.getByRole("button", { name: teammate.displayName, exact: true }).click();
      if (surface === "channel") await openEngineeringChannel(page);
      const narration = page.locator('[data-conversation-timeline-kind="agentMessage"]').filter({ hasText: /Focused (normal|teammate|channel) WorkCell completed/u });
      await expect(narration).toBeVisible();
      const responseId = JSON.stringify(["root", ["turn", turnId]]);
      await expect(narration.locator('xpath=ancestor::*[@data-conversation-focus-block][1]')).toHaveAttribute("data-conversation-response-id", responseId);
      const rows = page.locator(`.conversation-timeline-focus-block[data-conversation-response-id=${JSON.stringify(responseId)}]`);
      await expect(rows.locator("[data-conversation-response-footer]")).toHaveCount(1);
      if (status === "succeeded") {
        await expect(rows.locator("[data-conversation-terminal-response]")).toHaveCount(0);
        await expect(rows.filter({ hasText: "REPORT_SECOND_SUMMARY_SENTINEL" })).toHaveCount(0);
        await expect(rows.filter({ hasText: "Verified command" })).toHaveCount(0);
      } else {
        const detail = rows.locator('[data-conversation-timeline-kind="terminalReport"]');
        await expect(detail).toBeVisible();
        await expect(detail).toHaveAttribute("data-conversation-timeline-status", status);
        await expect(detail.locator(".conversation-timeline-activity-detail")).toHaveCount(0);
        await expect(detail).not.toContainText("REPORT_SECOND_SUMMARY_SENTINEL");
        await expect(detail).not.toContainText("Execution details");
        await expect(detail).not.toContainText("Verified command");
        await expect(detail).not.toContainText("node --test");
        await expect(detail).not.toContainText("12.3s");
      }
      await expect(rows.filter({ hasText: "generation 1" })).toHaveCount(0);
      const process = rows.locator('[data-conversation-process-header][aria-expanded="false"]');
      for (const header of await process.all()) await header.click();
      const batch = rows.locator('[data-conversation-timeline-kind="commandBatch"]');
      await expect(batch).toHaveCount(1);
      await batch.locator(".conversation-command-batch-header").click();
      const command = rows.locator('[data-conversation-timeline-kind="commandExecution"]').first();
      await command.locator(".conversation-timeline-activity-main").click();
      await expect(command.locator(".conversation-timeline-output")).toContainText("passed.");
      await expect(rows.locator("[data-conversation-response-footer]")).toHaveCount(1);
      expect(errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${surface}-${status}-report-display.png`) });
    });
  }
}

for (const attention of ["skipped-check", "pending-risk"] as const) {
  test(`successful normal run retains ${attention} beside final narration`, async ({ page }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
    const state = createBaseState({ approvalStatus: "expired" });
    const title = installNormalWorkCellFixture(state);
    state.terminalReports = state.terminalReports.map((report) => ({ ...report,
      verification: attention === "skipped-check"
        ? [{ id: "check-skipped", title: "Manual smoke not run", status: "skipped", sourceRefs: [] }]
        : [],
      risks: attention === "pending-risk"
        ? [{ id: "risk-pending", summary: "Approval still needed", severity: "warning", status: "unresolved", approvalDecision: "pending", sourceRefs: [] }]
        : [],
    }));
    await mockDaemon(page, state);
    await page.goto("/");
    await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
    await expect(page.locator('[data-conversation-timeline-kind="agentMessage"]').filter({ hasText: "Focused normal WorkCell completed." })).toBeVisible();
    const report = page.locator('[data-conversation-terminal-response]').first();
    await expect(report).toBeVisible();
    await expect(report.locator('.conversation-timeline-activity-main')).toHaveAttribute("aria-expanded", "true");
    await expect(report).toContainText("Open Issues");
    await expect(report).toContainText(attention === "skipped-check" ? "Manual smoke not run" : "Approval still needed");
    await expect(report.locator('[data-conversation-timeline-status]')).toHaveAttribute("data-conversation-timeline-status", "succeeded");
    await page.screenshot({ path: testInfo.outputPath(`${attention}-retained.png`) });
  });
}
