import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRemoteConversationRunRequest,
  resolveRemoteReplyProviderPresetId,
} from "../dist/features/remote-access/default-reply-dispatcher.js";
import { resolveTeammateDirectExecutionContext } from "../dist/features/teammates/direct-execution-context.js";

const now = "2026-07-31T00:00:00.000Z";

test("normal Mobile replies are rebuilt with a zero-tool read-only authority", () => {
  const request = buildRemoteConversationRunRequest({
    workspaceCwd: "/workspace",
    providerPresetId: "provider_pc_selected",
    intent: {
      id: "remote_dispatch_1",
      commandId: "command_1",
      workspaceId: "default",
      conversationKind: "conversation",
      conversationId: "thread_1",
      messageId: "turn_1",
      authority: {
        sourceSurface: "mobile",
        authorityCeiling: "conversation_comment",
        allowAiReply: true,
        allowToolCalls: false,
        allowWorkflowAutoStart: false,
        allowExecutionProposal: false,
      },
      status: "pending",
      attemptCount: 0,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    },
    thread: {
      id: "thread_1",
      workspaceId: "default",
      kind: "conversation",
      title: "Conversation",
      objective: "Discuss",
      status: "open",
      conversationMode: { mode: "default", updatedAt: now },
      createdAt: now,
      updatedAt: now,
    },
    turn: {
      id: "turn_1",
      workspaceId: "default",
      threadId: "thread_1",
      kind: "manual_followup",
      status: "open",
      title: "Mobile message",
      userInstruction: "Reply to this",
      createdByActor: "local-user",
      createdAt: now,
      updatedAt: now,
    },
  });

  assert.deepEqual(request.tools, []);
  assert.equal(request.permissionPreset, "read_only");
  assert.equal(request.workspaceAccessMode, "read_only");
  assert.equal(request.cwd, "/workspace");
  assert.equal(request.providerPresetId, "provider_pc_selected");
  assert.equal(request.idempotencyKey, "remote_dispatch_1");
  assert.match(request.systemPrompt, /Do not use tools/u);
});

test("teammate direct execution honors server-owned Mobile tool and idempotency overrides", () => {
  const lingThread = {
    id: "ling_direct_1",
    workspaceId: "default",
    kind: "teammate_direct",
    teammateId: "teammate_1",
    title: "Direct",
    objective: "Direct",
    status: "open",
    conversationMode: { mode: "default", updatedAt: now },
    createdAt: now,
    updatedAt: now,
  };
  const teammate = {
    id: "teammate_1",
    workspaceId: "default",
    displayName: "Teammate",
    status: "active",
    allowedTools: ["bash", "write"],
    appendSystemPrompt: [],
    approvalProfile: { defaultRisk: "high", rules: [] },
    createdAt: now,
    updatedAt: now,
  };
  const directThread = {
    id: "direct_1",
    workspaceId: "default",
    teammateId: teammate.id,
    title: "Direct",
    createdAt: now,
    updatedAt: now,
  };
  const sourceMessage = {
    id: "message_1",
    workspaceId: "default",
    threadId: directThread.id,
    teammateId: teammate.id,
    authorType: "local-user",
    body: "Reply",
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
  const replyMessage = { ...sourceMessage, id: "reply_1", authorType: "ai-teammate", status: "pending" };
  const execution = resolveTeammateDirectExecutionContext({
    store: {
      paths: { cwd: "/workspace" },
      findLingThreadByOwner: () => lingThread,
      listConversationMessageRevisions: () => [],
      getConversationItemByIdempotencyKey: () => undefined,
      appendTeammateDirectUserTurnWithInputSnapshot: (input) => {
        assert.equal(input.threadId, lingThread.id);
        assert.equal(input.teammateId, teammate.id);
        assert.equal(input.payload.body, sourceMessage.body);
        assert.deepEqual(input.executionInput, { prompt: "Reply", systemPrompt: "Remote reply" });
        return { turnId: "turn_private_mobile", item: { id: input.itemId },
          inputSnapshot: { id: "private-mobile-snapshot", fingerprint: "private-mobile-fingerprint", payload: input.executionInput } };
      },
    },
    teammate,
    directThread,
    sourceMessage,
    replyMessage,
    providerPresetId: "provider_pc_selected",
    workspace: {
      thread: directThread,
      binding: { mode: "local", status: "ready", executionPath: "/workspace", updatedAt: now },
      snapshot: { mode: "local", status: "ready", workspaceCwd: "/workspace", executionCwd: "/workspace" },
      executionCwd: "/workspace",
    },
    prompt: "Reply",
    systemPrompt: "Remote reply",
    permissionPreset: "read_only",
    workspaceAccessMode: "read_only",
    toolsOverride: [],
    idempotencyKeyOverride: "remote_dispatch_2",
  });

  assert.deepEqual(execution.runRequest.tools, []);
  assert.equal(execution.runRequest.permissionPreset, "read_only");
  assert.equal(execution.runRequest.workspaceAccessMode, "read_only");
  assert.equal(execution.runRequest.idempotencyKey, "remote_dispatch_2");
});

test("Mobile replies inherit the workspace model for built-in teammates", () => {
  const teammate = {
    id: "teammate_builtin_designer",
    modelBindingMode: "workspace_default",
  };
  assert.equal(resolveRemoteReplyProviderPresetId({
    teammate,
    surface: "private",
    workspaceDefaultProviderPresetId: "provider_workspace_default",
  }), "provider_workspace_default");
  assert.equal(resolveRemoteReplyProviderPresetId({
    teammate,
    surface: "channel",
    workspaceDefaultProviderPresetId: "provider_workspace_default",
    channelDefaultProviderPresetId: "provider_channel_default",
  }), "provider_workspace_default");
});
