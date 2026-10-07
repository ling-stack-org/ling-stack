import { expect, test } from "@playwright/test";
import { buildMockConversationDetail, mockDaemon } from "./support/mock-daemon";
import { createBaseState, cwd } from "./support/mock-state";
import { installNormalWorkCellFixture } from "./support/conversation-work-cell-fixture";

// Production adapters and renderer with API fixtures, not packaged/native proof.
for (const source of ["host_status", "run_narration"] as const) {
  test(`normal interruption preserves facts and only replaces ${source} when the canonical report arrives`, async ({ page }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const state = createBaseState({ approvalStatus: "expired" });
    const title = installNormalWorkCellFixture(state);
    const original = state.terminalReports[0]!;
    const runId = state.turnRunLinks[0]!.runId;
    const turnId = state.turnRunLinks[0]!.turnId;
    const thread = state.threads.find(item => item.id === original.threadId)!;
    const warning = "Tool completion was not received; process termination and actual effects remain unconfirmed.";
    const reason = "The runtime restarted without a safe checkpoint. The task was interrupted and was not retried.";
    state.runs = state.runs.map(run => run.id === runId ? { ...run, status: "failed", errorMessage: "runtime_interrupted_no_checkpoint" } : run);
    state.turns = state.turns.map(turn => turn.id === turnId ? { ...turn, status: "failed" } : turn);
    state.terminalReports = [{ ...original, outcome: { ...original.outcome, status: "failed", summary: "The task failed." },
      risks: [
        { id: `execution-unconfirmed:${runId}:tool`, summary: warning, severity: "critical", status: "unverified", sourceRefs: [{ kind: "run", id: runId, visibility: "conversation" }] },
        { id: `run-failure:${runId}`, summary: reason, severity: "critical", status: "unresolved", sourceRefs: [{ kind: "run", id: runId, visibility: "conversation" }] },
      ],
    }];
    await mockDaemon(page, state);
    await page.route(`**/conversations/${thread.id}?*`, async route => {
      const detail = buildMockConversationDetail(state, cwd, thread);
      detail.messages = (detail.messages as Array<Record<string, unknown>>).map(message => message.role === "assistant"
        ? { ...message, content: "STATUS_PLACEHOLDER_SENTINEL", contentSource: source, narrationSegments: [], errorMessage: "runtime_interrupted_no_checkpoint" }
        : message);
      detail.conversationItems = (detail.conversationItems as Array<Record<string, unknown>>).flatMap(item => item.kind !== "assistant_message" ? [item]
        : source === "host_status" ? [] : [{ ...item, payload: { ...(item.payload as object), body: "STATUS_PLACEHOLDER_SENTINEL", phase: "commentary" } }]);
      await route.fulfill({ json: detail });
    });
    await page.goto("/");
    await page.getByRole("button", { name: /Open recent conversation \d+/u }).filter({ hasText: title }).click();
    const feed = page.locator('[data-conversation-surface-timeline="normal"]');
    await expect(feed.locator("[data-conversation-terminal-response]")).toHaveCount(1);
    await expect(feed.locator(".conversation-timeline-result-summary")).toContainText(reason);
    await expect(feed.locator(".conversation-timeline-result-summary")).toContainText(warning);
    if (source === "host_status") {
      await expect(feed).not.toContainText("STATUS_PLACEHOLDER_SENTINEL");
      await expect(feed).not.toContainText("runtime_interrupted_no_checkpoint");
    } else {
      await expect(feed.locator('[data-conversation-timeline-kind="agentMessage"]')).toContainText("STATUS_PLACEHOLDER_SENTINEL");
    }
    const detail = feed.locator('[data-conversation-timeline-kind="terminalReport"] .conversation-timeline-activity-main');
    await expect(detail).toHaveAttribute("aria-expanded", "true");
    await expect(detail).toContainText("Execution details");
    await expect(feed.locator("[data-conversation-response-footer]")).toHaveCount(1);
    await detail.click();
    await expect(detail).toHaveAttribute("aria-expanded", "false");
    await expect(feed.locator(".conversation-timeline-result-summary")).toContainText(warning);
    await detail.click();
    await expect(detail).toHaveAttribute("aria-expanded", "true");
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${source}-failure-result.png`) });
  });
}
