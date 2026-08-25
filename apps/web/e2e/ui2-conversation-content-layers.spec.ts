import { expect, test } from "@playwright/test";
import { mockDaemon } from "./support/mock-daemon";
import { createBaseState } from "./support/mock-state";
import { openEngineeringChannel } from "./support/test-helpers";

test("mixed conversation items keep tool and approval evidence out of prose", async ({ page }) => {
  const state = createBaseState({ approvalStatus: "expired" });
  state.channelMessages.push({
    id: "mixed-source",
    workspaceId: "workspace_default",
    channelId: "channel_engineering",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    authorId: "tian",
    body: "Inspect the workspace and wait for approval.",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  });
  state.channelConversationItemExtras = [
    {
      schemaVersion: 1,
      id: "mixed-tool-call",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "thread_channel_channel_engineering",
      turnId: "turn_mixed-source",
      sequence: 2,
      kind: "tool_call",
      status: "committed",
      actorType: "ling_agent",
      actorId: "ling-agent",
      visibility: "channel",
      payload: { toolCallId: "tool-mixed", toolName: "read_file", title: "Read workspace file", inputSummary: "README.md" },
      domainRefs: [{ type: "conversation_item", id: "mixed-source" }],
      revision: 1,
      createdAt: "2026-08-10T00:00:01.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
      committedAt: "2026-08-10T00:00:01.000Z",
    },
    {
      schemaVersion: 1,
      id: "mixed-approval",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "thread_channel_channel_engineering",
      turnId: "turn_mixed-source",
      sequence: 3,
      kind: "approval_request",
      status: "pending",
      actorType: "ling_agent",
      actorId: "ling-agent",
      visibility: "channel",
      payload: { approvalRequestId: "approval-mixed", title: "Allow workspace read", summary: "Read access is required to continue." },
      domainRefs: [{ type: "conversation_item", id: "mixed-source" }],
      revision: 1,
      createdAt: "2026-08-10T00:00:02.000Z",
      updatedAt: "2026-08-10T00:00:02.000Z",
    },
    {
      schemaVersion: 1,
      id: "mixed-tool-result",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "thread_channel_channel_engineering",
      turnId: "turn_mixed-source",
      sequence: 4,
      kind: "tool_result",
      status: "committed",
      actorType: "ling_agent",
      actorId: "ling-agent",
      visibility: "channel",
      payload: { toolCallId: "tool-mixed", status: "succeeded", outputSummary: "README.md read successfully." },
      domainRefs: [{ type: "conversation_item", id: "mixed-tool-call" }],
      revision: 1,
      createdAt: "2026-08-10T00:00:03.000Z",
      updatedAt: "2026-08-10T00:00:03.000Z",
      committedAt: "2026-08-10T00:00:03.000Z",
    },
    {
      schemaVersion: 1,
      id: "mixed-approval-decision",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "thread_channel_channel_engineering",
      turnId: "turn_mixed-source",
      sequence: 5,
      kind: "approval_decision",
      status: "committed",
      actorType: "local_user",
      actorId: "tian",
      visibility: "channel",
      payload: { approvalRequestId: "approval-mixed", decision: "approved", reason: "Approved for this test turn." },
      domainRefs: [{ type: "approval", id: "approval-mixed" }],
      revision: 1,
      createdAt: "2026-08-10T00:00:04.000Z",
      updatedAt: "2026-08-10T00:00:04.000Z",
      committedAt: "2026-08-10T00:00:04.000Z",
    },
    {
      schemaVersion: 1,
      id: "mixed-handoff",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "thread_channel_channel_engineering",
      turnId: "turn_mixed-source",
      sequence: 6,
      kind: "handoff",
      status: "committed",
      actorType: "ling_agent",
      actorId: "ling-agent",
      visibility: "channel",
      payload: { handoffId: "handoff-mixed", targetTeammateId: "engineer", summary: "Engineering follow-up requested." },
      domainRefs: [{ type: "handoff", id: "handoff-mixed" }],
      revision: 1,
      createdAt: "2026-08-10T00:00:05.000Z",
      updatedAt: "2026-08-10T00:00:05.000Z",
      committedAt: "2026-08-10T00:00:05.000Z",
    },
    {
      schemaVersion: 1,
      id: "mixed-operation-state",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "thread_channel_channel_engineering",
      turnId: "turn_mixed-source",
      sequence: 7,
      kind: "operation_state",
      status: "committed",
      actorType: "ling_agent",
      actorId: "ling-agent",
      visibility: "channel",
      payload: { operationId: "operation-mixed", state: "running", title: "Workspace inspection", summary: "Inspection is still running." },
      domainRefs: [{ type: "operation", id: "operation-mixed" }],
      revision: 1,
      createdAt: "2026-08-10T00:00:06.000Z",
      updatedAt: "2026-08-10T00:00:06.000Z",
    },
    {
      schemaVersion: 1,
      id: "mixed-artifact",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "thread_channel_channel_engineering",
      turnId: "turn_mixed-source",
      sequence: 8,
      kind: "artifact_ref",
      status: "committed",
      actorType: "ling_agent",
      actorId: "ling-agent",
      visibility: "channel",
      payload: { artifactId: "artifact-mixed", title: "README.md", artifactKind: "file" },
      domainRefs: [{ type: "artifact", id: "artifact-mixed" }],
      revision: 1,
      createdAt: "2026-08-10T00:00:07.000Z",
      updatedAt: "2026-08-10T00:00:07.000Z",
      committedAt: "2026-08-10T00:00:07.000Z",
    },
    {
      schemaVersion: 1,
      id: "mixed-system-event",
      workspaceId: "workspace_default",
      channelId: "channel_engineering",
      threadId: "thread_channel_channel_engineering",
      turnId: "turn_mixed-source",
      sequence: 9,
      kind: "system_event",
      status: "committed",
      actorType: "system",
      visibility: "channel",
      payload: { eventType: "context_compacted", summary: "Context was compacted." },
      domainRefs: [{ type: "turn", id: "turn_mixed-source" }],
      revision: 1,
      createdAt: "2026-08-10T00:00:08.000Z",
      updatedAt: "2026-08-10T00:00:08.000Z",
      committedAt: "2026-08-10T00:00:08.000Z",
    },
  ];
  await mockDaemon(page, state);

  await page.goto("/");
  await openEngineeringChannel(page);

  const feed = page.getByLabel(/Channel message feed|频道消息列表/u);
  const toolItem = feed.locator('[data-conversation-item-kind="tool_call"]');
  const approvalItem = feed.locator('[data-conversation-item-kind="approval_request"]');
  await expect(toolItem).toHaveCount(1);
  await expect(approvalItem).toHaveCount(1);
  await expect(feed.locator('[data-conversation-item-kind="tool_result"]')).toHaveCount(1);
  await expect(feed.locator('[data-conversation-item-kind="approval_decision"]')).toHaveCount(1);
  await expect(feed.locator('[data-conversation-item-kind="handoff"]')).toHaveCount(1);
  await expect(feed.locator('[data-conversation-item-kind="operation_state"]')).toHaveCount(1);
  await expect(feed.locator('[data-conversation-item-kind="artifact_ref"]')).toHaveCount(1);
  await expect(feed.locator('[data-conversation-item-kind="system_event"]')).toHaveCount(1);
  await expect(toolItem).toContainText("Read workspace file");
  await expect(approvalItem).toContainText("Allow workspace read");
  await expect(feed.locator('[data-conversation-item-kind="tool_result"]')).toContainText("README.md read successfully.");
  await expect(feed.locator('[data-conversation-item-kind="handoff"]')).toContainText("Engineering follow-up requested.");
  await expect(feed.locator('[data-conversation-item-kind="artifact_ref"]')).toContainText("README.md");
  await expect(feed.locator('[data-conversation-item-kind="system_event"]')).toContainText("Context was compacted.");
  await expect(feed.locator(".conversation-turn-assistant-copy")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
