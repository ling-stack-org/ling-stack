import { expect, test } from "@playwright/test";
import type { ConversationItemV1 } from "@ling-stack/contracts";
import { createBaseState, createMockTeammate } from "./support/mock-state";
import { mockDaemon } from "./support/mock-daemon";
import { openEngineeringChannel } from "./support/test-helpers";
import { timelineResponseFooter } from "./support/timeline-response-footer";

// Canonical API fixtures, not a model run or packaged-client acceptance.
for (const sample of [
  { role: "narration", delivery: "ready", body: "Run started: Engineer", closing: false },
  { role: "narration", delivery: "ready", body: "Run completed: Engineer", closing: false },
  { role: "reply_result", delivery: "pending", body: "Draft answer still streaming", closing: false },
  // A reply without an operation cell is also grouped as coordinatorStartMessages.
  // It must not lose its legitimate final actions through a group-name heuristic.
  { role: "reply_result", delivery: "ready", body: "An ordinary final answer", closing: true },
] as const) {
  test(`channel ${sample.delivery} ${sample.role}: ${sample.body}`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("ling-stack.locale", "en-US"));
    const state = createBaseState({ approvalStatus: "expired" });
    state.aiTeammates = [createMockTeammate({ id: "ling_agent", displayName: "Ling Agent" })];
    state.channelMessages = [{
      id: "closing_source", workspaceId: "workspace_default", channelId: "channel_engineering",
      kind: "message", authorType: "local-user", authorId: "local-user", intent: "discuss",
      body: "Explain the current request.", status: "ready", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [],
      createdAt: "2026-09-06T02:00:00.000Z", updatedAt: "2026-09-06T02:00:00.000Z",
    }];
    const item: ConversationItemV1 = {
      schemaVersion: 1, id: "closing_assistant", workspaceId: "workspace_default",
      channelId: "channel_engineering", threadId: "thread_channel_channel_engineering", turnId: "turn_closing_source",
      sequence: 2, kind: "assistant_message", status: sample.delivery === "pending" ? "pending" : "committed",
      actorType: "ling_agent", actorId: "ling_agent", visibility: "channel", revision: 1,
      payload: { body: sample.body, format: "markdown", presentationRole: sample.role,
        deliveryStatus: sample.delivery, streaming: sample.delivery === "pending" },
      domainRefs: [{ type: "conversation_item", id: "closing_source" }],
      createdAt: "2026-09-06T02:00:01.000Z", updatedAt: "2026-09-06T02:00:01.000Z",
    };
    state.channelConversationItemExtras = [item];
    await mockDaemon(page, state);
    await page.goto("/");
    await openEngineeringChannel(page);
    const row = page.getByLabel("Channel message feed").locator(".channel-message-row").filter({ hasText: sample.body });
    await expect(row).toHaveCount(1);
    await expect(row).toBeVisible();
    const actions = sample.closing ? await timelineResponseFooter(row) : row;
    await expect(actions.getByRole("button", { name: "Copy message", exact: true })).toHaveCount(sample.closing ? 1 : 0);
    await expect(actions.getByRole("button", { name: "Like response", exact: true })).toHaveCount(sample.closing ? 1 : 0);
    await expect(actions.getByRole("button", { name: "Dislike response", exact: true })).toHaveCount(sample.closing ? 1 : 0);
    const user = page.getByLabel("Channel message feed").locator(".channel-message-row").filter({ hasText: "Explain the current request." });
    await expect(user.getByRole("button", { name: "Copy message", exact: true })).toHaveCount(1);
  });
}
