import assert from "node:assert/strict";
import test from "node:test";
import { workflowGraphFingerprintV1 } from "@ling-stack/contracts";
import {
  collectActiveWorkSources,
  collectMaterializedInputSources,
  collectRecentConversationSources,
  collectTurnSource,
  collectWorkflowEvidenceSources,
  listChannelContextMessages,
} from "../dist/features/channels/context-processing/sources.js";
import {
  artifactEvidenceSensitivity,
  summarizeCommandEvidence,
  summarizeArtifactEvidence,
  workflowPacketKindForArtifact,
} from "../dist/features/channels/context-processing/evidence.js";
import { condenseChannelContextSections, condenseChannelContextSources } from "../dist/features/channels/context-processing/condenser.js";
import { buildWorkflowContextInspectSummary } from "../dist/features/channels/context-processing/inspect.js";
import {
  buildWorkflowProposalContextView,
  proposalSourceRefsFromContextView,
} from "../dist/features/channels/context-processing/proposals.js";
import { buildWorkflowStepContextView } from "../dist/features/channels/context-processing/workflow-steps.js";
import { buildPrivateChatContextView } from "../dist/features/channels/context-processing/private-chat.js";
import { memoryEligibilityForView } from "../dist/features/channels/context-processing/memory.js";
import { renderChannelContextView } from "../dist/features/channels/context-processing/render.js";
import { buildChannelContextView } from "../dist/features/channels/context-processing/views.js";
import { buildWorkflowStepContextPack } from "../dist/features/channels/context-packs.js";

const now = "2026-06-13T00:00:00.000Z";

test("context source collectors describe current turn inputs without raw binary content", () => {
  const channel = createChannel();
  const source = collectTurnSource({
    channel,
    envelope: {
      sourceMessageId: "msg_current",
      channelId: channel.id,
      authorType: "local-user",
      body: "请总结附件",
      mentions: [],
      attachments: [{
        id: "attachment_1",
        fileName: "brief.pdf",
        kind: "pdf",
        contentType: "application/pdf",
        sizeBytes: 2048,
        previewStatus: "available",
        materializationStatus: "available",
        materializationId: "mat_attachment_1",
        previewText: "bounded preview",
      }],
      linkPreviews: [{
        id: "link_1",
        url: "https://example.com/a",
        normalizedUrl: "https://example.com/a",
        title: "Example",
        status: "ready",
        materializationStatus: "metadata_only",
      }],
      fileRefs: [{
        path: "/tmp/README.md",
        rootRelation: "inside_workspace",
        kind: "file",
        materializationStatus: "available",
        materializationId: "mat_file_1",
      }],
    },
  });

  assert.equal(source.id, "turn:msg_current");
  assert.equal(source.kind, "turn");
  assert.equal(source.metadata.attachmentCount, 1);
  assert.equal(source.metadata.linkPreviewCount, 1);
  assert.equal(source.metadata.fileRefCount, 1);
  assert.equal(source.metadata.materializedInputCount, 2);
  assert.deepEqual(source.sourceRefs.map((ref) => `${ref.type}:${ref.id}`), [
    "channel:channel_1",
    "message:msg_current",
    "attachment:attachment_1",
    "link_preview:link_1",
  ]);
});

test("materialized input collector exposes bounded current-turn input sources", () => {
  const channel = createChannel();
  const sources = collectMaterializedInputSources({
    channel,
    envelope: {
      sourceMessageId: "msg_current",
      channelId: channel.id,
      authorType: "local-user",
      body: "请处理这些输入",
      mentions: [],
      attachments: [{
        id: "attachment_1",
        fileName: "brief.pdf",
        kind: "pdf",
        contentType: "application/pdf",
        sizeBytes: 4096,
        previewStatus: "available",
        materializationStatus: "available",
        materializationId: "mat_attachment_1",
        previewText: "PDF 摘要内容",
      }],
      linkPreviews: [{
        id: "link_1",
        url: "https://example.com/report",
        normalizedUrl: "https://example.com/report",
        title: "Report",
        status: "ready",
        materializationStatus: "metadata_only",
        previewText: "Report metadata",
      }],
      fileRefs: [{
        path: "README.md",
        label: "README",
        source: "composer",
        rootRelation: "inside_workspace",
        kind: "file",
        materializationStatus: "available",
        materializationId: "mat_file_1",
        previewText: "README preview",
      }],
    },
  });

  assert.deepEqual(sources.map((source) => source.id), [
    "materialized_input:attachment:attachment_1",
    "materialized_input:link_preview:link_1",
    "materialized_input:workspace_file_ref:README.md",
  ]);
  assert.equal(sources.every((source) => source.kind === "materialized_input"), true);
  assert.equal(sources[0].text, "PDF 摘要内容");
  assert.equal(sources[0].metadata.materializationStatus, "available");
  assert.equal(sources[1].metadata.hasPromptContent, false);
  assert.equal(sources[2].sourceRefs.some((ref) => ref.type === "materialization" && ref.id === "mat_file_1"), true);
});

test("recent conversation collector keeps same-channel ready messages only", () => {
  const messages = [
    createMessage({ id: "msg_old", channelId: "channel_1", body: "old" }),
    createMessage({ id: "msg_pending", channelId: "channel_1", body: "pending", status: "pending" }),
    createMessage({ id: "msg_other", channelId: "channel_other", body: "other" }),
    createMessage({ id: "msg_current", channelId: "channel_1", body: "current" }),
  ];

  const sources = collectRecentConversationSources({
    channelId: "channel_1",
    messages,
    excludeMessageId: "msg_current",
  });

  assert.deepEqual(sources.map((source) => source.id), ["recent_message:msg_old"]);
  assert.equal(sources[0].text, "old");
});

test("shared channel context message listing excludes historical queued guidance", () => {
  const rootThread = createConversationThread();
  const current = createMessage({ id: "msg_current", threadId: rootThread.id, body: "继续" });
  const store = createCanonicalConversationStore({
    threads: [rootThread],
    messages: [
      createMessage({ id: "msg_old", threadId: rootThread.id, body: "old topic" }),
      createMessage({ id: "msg_guidance", threadId: rootThread.id, body: "queued guidance" }),
      current,
    ],
    interventions: [{ idempotencyKey: "channel_message:msg_guidance:queue_followup" }],
  });

  const messages = listChannelContextMessages({
    store,
    channelId: "channel_1",
    sourceMessage: current,
  });

  assert.deepEqual(messages.map((message) => message.id), ["msg_old", "msg_current"]);
});

test("channel context message listing scopes root and branch surfaces separately", () => {
  const rootThread = createConversationThread();
  const branchThread = createConversationThread({ id: "thread_branch", surfaceKind: "branch", relationKind: "branch" });
  const rootMessage = createMessage({ id: "msg_root", threadId: rootThread.id, body: "root" });
  const rootReply = createMessage({ id: "msg_root_reply", threadId: rootThread.id, kind: "ai_reply", authorType: "ai-teammate", body: "root reply" });
  const branchMessage = createMessage({ id: "msg_branch", threadId: "thread_branch", body: "branch" });
  const latestRoot = createMessage({ id: "msg_latest_root", threadId: rootThread.id, body: "latest root" });
  const messages = [rootMessage, rootReply, branchMessage, latestRoot];
  const store = createCanonicalConversationStore({ threads: [rootThread, branchThread], messages });

  assert.deepEqual(
    listChannelContextMessages({ store, channelId: "channel_1", sourceMessage: latestRoot }).map((message) => message.id),
    ["msg_root", "msg_root_reply", "msg_latest_root"],
  );
  assert.deepEqual(
    listChannelContextMessages({ store, channelId: "channel_1", sourceMessage: branchMessage }).map((message) => message.id),
    ["msg_branch"],
  );
});

test("channel context message listing scopes topic replies to their source message", () => {
  const rootThread = createConversationThread();
  const topicThread = createConversationThread({
    id: "thread_topic",
    surfaceKind: "topic",
    relationKind: "topic",
    parentThreadId: rootThread.id,
    anchorItemId: "msg_root",
  });
  const branchThread = createConversationThread({ id: "thread_branch", surfaceKind: "branch", relationKind: "branch" });
  const rootMessage = createMessage({ id: "msg_root", threadId: rootThread.id, body: "root" });
  const topicReply = createMessage({ id: "msg_topic", threadId: topicThread.id, body: "topic follow-up" });
  const branchMessage = createMessage({ id: "msg_branch", threadId: "thread_branch", body: "branch" });
  const messages = [rootMessage, topicReply, branchMessage];
  const store = createCanonicalConversationStore({ threads: [rootThread, topicThread, branchThread], messages });

  assert.deepEqual(
    listChannelContextMessages({ store, channelId: "channel_1", sourceMessage: topicReply }).map((message) => message.id),
    ["msg_root", "msg_topic"],
  );
});

test("active work collector projects proposals workflows runs and approvals as metadata sources", () => {
  const channel = createChannel();
  const store = {
    getConversationItem: (id) => id === "msg_current" ? { threadId: "thread_current" } : undefined,
    getLingTurn: () => undefined,
    listChannelExecutionProposals: () => [{
      id: "proposal_1",
      workspaceId: "workspace_1",
      channelId: channel.id,
      sourceMessageId: "msg_current",
      assigneeTeammateId: "ling_agent",
      title: "Create README",
      prompt: "Create README.md",
      requiredTools: ["write"],
      status: "draft",
    }],
    listChannelWorkflows: () => [{
      id: "workflow_1",
      workspaceId: "workspace_1",
      channelId: channel.id,
      title: "Implement feature",
      objective: "Implement and verify.",
      status: "running",
      createdBy: "ling_agent",
      metadata: { sourceProposalId: "proposal_1", sourceMessageId: "msg_current" },
    }],
    listChannelWorkflowSteps: () => [{
      id: "step_1",
      workspaceId: "workspace_1",
      channelId: channel.id,
      workflowId: "workflow_1",
      title: "Run tests",
      prompt: "Run test suite",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "waiting_for_approval",
      runId: "run_1",
    }],
    listRuns: () => [{
      id: "run_1",
      status: "waiting_for_approval",
      cwd: "/tmp/project",
      taskId: "task_1",
      channelId: channel.id,
      teammateId: "ling_agent",
      workflowStepId: "step_1",
      providerName: "test",
      providerModel: "model",
      taskSnapshot: { title: "Run tests" },
      providerSnapshot: {},
      requestSnapshot: {},
      eventLogPath: "/tmp/run.log",
      createdAt: now,
      updatedAt: now,
    }],
    listApprovalRequests: (options) => options.runId === "run_1"
      ? [{
          id: "approval_1",
          runId: "run_1",
          workflowStepId: "step_1",
          actionType: "bash",
          risk: "medium",
          title: "Approve tests",
          description: "Run pnpm test",
          payload: { type: "bash", command: "pnpm test", cwd: "/tmp/project", riskFlags: [] },
          status: "pending",
          createdAt: now,
        }]
      : [],
  };

  const sources = collectActiveWorkSources({ store, channel, threadId: "thread_current" });

  assert.deepEqual(sources.map((source) => source.id), [
    "active_work:proposal:proposal_1",
    "active_work:workflow:workflow_1",
    "active_work:workflow_step:step_1",
    "active_work:run:run_1",
    "active_work:approval:approval_1",
  ]);
  assert.equal(sources[0].metadata.entityType, "proposal");
  assert.equal(sources[3].title, "Run tests");
  assert.equal(sources[4].metadata.actionType, "bash");
});

test("workflow evidence collector summarizes linked artifacts without raw artifact bodies", () => {
  const channel = createChannel();
  const workflow = createWorkflow({ id: "workflow_1", channelId: channel.id });
  const step = createWorkflowStep({
    id: "step_1",
    workflowId: workflow.id,
    runId: "run_1",
    metadata: {
      contextArtifactId: "artifact_context",
      outputArtifactId: "artifact_output",
    },
  });
  const artifacts = new Map([
    ["artifact_context", createArtifact({ id: "artifact_context", runId: "run_1", title: "Workflow step context", type: "json", path: ".ling-stack/context.json" })],
    ["artifact_output", createArtifact({ id: "artifact_output", runId: "run_1", title: "Workflow step output", type: "json", path: ".ling-stack/output.json" })],
    ["artifact_log", createArtifact({ id: "artifact_log", runId: "run_1", title: "Runner log", type: "log", path: ".ling-stack/run.log" })],
  ]);
  const sources = collectWorkflowEvidenceSources({
    store: {
      getArtifact: (id) => artifacts.get(id),
      listArtifacts: (runId) => runId === "run_1" ? [...artifacts.values()] : [],
    },
    channel,
    workflow,
    step,
  });

  assert.deepEqual(sources.map((source) => source.id), [
    "workflow_packet:artifact_context",
    "workflow_packet:artifact_output",
    "artifact:artifact_log",
  ]);
  assert.equal(sources[0].metadata.packetKind, "context");
  assert.equal(sources[1].metadata.packetKind, "output");
  assert.equal(sources[2].sensitivity, "secret_adjacent");
  assert.match(sources[2].text, /Artifact evidence/);
  assert.doesNotMatch(sources[2].text, /raw log body/);
});

test("evidence policy redacts and bounds command and artifact summaries", () => {
  const successSummary = summarizeCommandEvidence({
    command: "pnpm test",
    exitCode: 0,
    stdout: "large stdout ".repeat(200),
    changedPaths: ["packages/daemon/src/index.ts"],
    artifactRefs: [{ id: "artifact_1", label: "test log" }],
  });
  assert.match(successSummary, /command=pnpm test/);
  assert.match(successSummary, /stdout=omitted/);
  assert.doesNotMatch(successSummary, /large stdout large stdout/);

  const failedSummary = summarizeCommandEvidence({
    command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://example.test",
    exitCode: 1,
    stderr: `${"noise ".repeat(80)}sk-test-redaction-token-1234567890 failed with Bearer abcdefghijklmnop`,
    maxTailChars: 120,
  });
  assert.match(failedSummary, /stderrTail/);
  assert.match(failedSummary, /\[REDACTED\]/);
  assert.doesNotMatch(failedSummary, /sk-test-redaction-token-1234567890/);
  assert.doesNotMatch(failedSummary, /Bearer abcdefghijklmnop/);

  const step = createWorkflowStep({
    id: "step_1",
    metadata: { contextArtifactId: "artifact_context" },
  });
  const contextArtifact = createArtifact({ id: "artifact_context", type: "json", path: ".ling-stack/context.json" });
  const logArtifact = createArtifact({ id: "artifact_log", type: "log", path: ".ling-stack/run.log" });
  assert.equal(workflowPacketKindForArtifact(step, contextArtifact), "context");
  assert.equal(artifactEvidenceSensitivity(logArtifact), "secret_adjacent");
  assert.match(summarizeArtifactEvidence({ artifact: contextArtifact, packetKind: "context" }), /Workflow context packet artifact/);
});

test("context condenser preserves current turn and condenses long evidence text", () => {
  const currentTurn = createSource({
    id: "turn:msg_current",
    kind: "turn",
    freshness: "current_turn",
    text: "current turn ".repeat(120),
  });
  const evidence = createSource({
    id: "evidence:run_log",
    kind: "evidence",
    freshness: "durable",
    title: "Run log",
    text: `stdout ${"noise ".repeat(120)}sk-test-redaction-token-1234567890 ${"tail ".repeat(120)}`,
    sourceRefs: [{ type: "artifact", id: "artifact_log", label: "Run log" }],
  });

  const result = condenseChannelContextSources({
    sources: [currentTurn, evidence],
    maxSourceTextChars: 600,
  });

  assert.equal(result.sources[0].text, currentTurn.text);
  assert.equal(result.sources[1].metadata.condensed, true);
  assert.match(result.sources[1].text, /Context source condensed for prompt budget/);
  assert.match(result.sources[1].text, /sourceRefs=artifact:artifact_log/);
  assert.doesNotMatch(result.sources[1].text, /sk-test-redaction-token-1234567890/);
  assert.equal(result.dropped.length, 0);
  assert.equal(result.condensedSourceIds[0], "evidence:run_log");
  assert.match(result.compactionIds[0], /^context_condenser_text_/);
});

test("context condenser drops low priority old sources before protected sources", () => {
  const sources = [
    createSource({ id: "turn:msg_current", kind: "turn", freshness: "current_turn" }),
    createSource({ id: "active_work:approval:approval_1", kind: "active_work", freshness: "current_turn" }),
    createSource({ id: "evidence:old", kind: "evidence", freshness: "archival" }),
    createSource({ id: "recent_message:old", kind: "recent_message", freshness: "recent" }),
  ];

  const result = condenseChannelContextSources({ sources, maxSources: 3 });

  assert.deepEqual(result.sources.map((source) => source.id), [
    "turn:msg_current",
    "active_work:approval:approval_1",
    "recent_message:old",
  ]);
  assert.deepEqual(result.dropped, [{ sourceId: "evidence:old", reason: "budget" }]);
  assert.match(result.compactionIds[0], /^context_condenser_drop_/);
});

test("context view opt-in condenser records metadata without changing prompt sections", () => {
  const view = buildChannelContextView({
    kind: "ling_agent_channel_view",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    now,
    sourceRefs: [],
    sections: [{
      id: "prompt",
      role: "user",
      priority: "must_keep",
      title: "Prompt",
      text: "Visible prompt text",
      sourceRefIds: [],
      visibility: "prompt",
      quotePolicy: "public_ok",
    }],
    sources: [
      createSource({
        id: "recent_message:long",
        kind: "recent_message",
        freshness: "recent",
        text: "long context ".repeat(120),
        sourceRefs: [{ type: "message", id: "msg_long" }],
      }),
      createSource({ id: "evidence:old", kind: "evidence", freshness: "archival" }),
    ],
    condenser: { enabled: true, maxSourceTextChars: 600, maxSources: 1 },
  });

  assert.equal(renderChannelContextView(view), "Visible prompt text");
  assert.deepEqual(view.sources.map((source) => source.id), ["recent_message:long"]);
  assert.equal(view.sources[0].metadata.condensed, true);
  assert.deepEqual(view.sourceRefs.map((ref) => `${ref.type}:${ref.id}`), ["message:msg_long"]);
  assert.deepEqual(view.dropped, [{ sourceId: "evidence:old", reason: "budget" }]);
  assert.equal(view.metadata.condenser.enabled, true);
  assert.equal(view.metadata.condenser.condensedSourceCount, 1);
  assert.equal(view.metadata.condenser.droppedSourceCount, 1);
  assert.equal(view.metadata.sourceCount, 1);
});

test("context section lifecycle keeps rebuild, summarizes summarize, and discards discard", () => {
  const result = condenseChannelContextSections({
    sections: [
      {
        id: "base_instructions",
        role: "instruction",
        priority: "must_keep",
        compactionSurvival: "rebuild",
        title: "Base instructions",
        text: "base ".repeat(800),
        sourceRefIds: [],
        visibility: "prompt",
        quotePolicy: "public_ok",
      },
      {
        id: "user_history",
        role: "user",
        priority: "medium",
        compactionSurvival: "summarize",
        title: "User history",
        text: "history ".repeat(800),
        sourceRefIds: [],
        visibility: "prompt",
        quotePolicy: "public_ok",
      },
      {
        id: "transient_developer",
        role: "instruction",
        priority: "low",
        compactionSurvival: "discard",
        title: "Transient developer message",
        text: "discard me",
        sourceRefIds: [],
        visibility: "prompt",
        quotePolicy: "public_ok",
      },
    ],
    maxSectionTextChars: 600,
  });

  assert.deepEqual(result.sections.map((section) => section.id), ["base_instructions", "user_history"]);
  assert.equal(result.sections[0].text.startsWith("base "), true);
  assert.equal(result.sections[1].metadata.condensed, true);
  assert.deepEqual(result.discardedSectionIds, ["transient_developer"]);
  assert.deepEqual(result.condensedSectionIds, ["user_history"]);
  assert.equal(result.compactionIds.length, 2);
});

test("context views create independent snapshot identities and stamp projection lineage", () => {
  const projection = {
    projectionVersion: "projection_1",
    sourceStateFingerprint: "state_1",
    threadId: "thread_1",
    turnId: "turn_1",
    segmentId: "segment_1",
    throughItemSequence: 4,
    summaryIds: [],
    sourceRefs: [],
    policyVersion: "policy_1",
    visibilityFingerprint: "visibility_1",
  };
  const input = {
    kind: "ling_agent_channel_view",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    now,
    sourceRefs: [],
    contextProjection: projection,
    sections: [],
  };
  const first = buildChannelContextView(input);
  const second = buildChannelContextView(input);
  assert.notEqual(first.id, second.id);
  assert.equal(first.metadata.createdAt, now);
  assert.equal(first.contextProjection.contextViewId, first.id);
  assert.equal(first.contextProjection.contextViewCreatedAt, now);
  assert.equal(second.contextProjection.contextViewId, second.id);
});

test("workflow context inspect summary exposes metadata without raw prompt text", () => {
  const missing = buildWorkflowContextInspectSummary({
    step: createWorkflowStep({ metadata: {} }),
  });
  assert.equal(missing.availability, "missing_context_artifact");
  assert.equal(missing.safety.rawPromptTextIncluded, false);

  const inspect = buildWorkflowContextInspectSummary({
    step: createWorkflowStep({ id: "step_1", metadata: { contextArtifactId: "artifact_context" } }),
    contextPacket: {
      schemaVersion: 1,
      workflowId: "workflow_1",
      workflowStepId: "step_1",
      objective: "Inspect context.",
      stepTitle: "Implementation",
      stepPrompt: "RAW PROMPT TEXT SHOULD NOT LEAK",
      dependencies: [],
      priorOutputArtifactIds: [],
      contextPack: {
        kind: "workflow_step",
        providerPresetId: "provider_1",
        modelId: "model_1",
        budget: {
          mode: "model_known",
          contextWindowTokens: 4096,
          reservedOutputTokens: 512,
          reservedRuntimeOverheadTokens: 512,
          inputBudgetTokens: 3072,
          tokenizer: "openai-compatible",
        },
        estimatedInputTokens: 1200,
        overBudget: false,
        droppedSectionIds: ["workflow_dependency_1"],
        compactionIds: ["workflow_packet_summary_1"],
        sections: [{
          id: "workflow_current_step",
          role: "user",
          priority: "must_keep",
          estimatedTokens: 120,
          sourceRefIds: ["step_1"],
          metadata: { graphNodeId: "impl" },
        }],
        sourceRefs: [{ type: "workflow_step", id: "step_1", label: "Implementation" }],
      },
      generatedAt: now,
    },
  });

  assert.equal(inspect.availability, "available");
  assert.equal(inspect.contextArtifactId, "artifact_context");
  assert.equal(inspect.budget.inputBudgetTokens, 3072);
  assert.deepEqual(inspect.sections.map((section) => section.id), ["workflow_current_step"]);
  assert.deepEqual(inspect.sections[0].metadataKeys, ["graphNodeId"]);
  assert.deepEqual(inspect.droppedSectionIds, ["workflow_dependency_1"]);
  assert.deepEqual(inspect.compactionIds, ["workflow_packet_summary_1"]);
  assert.equal(inspect.sourceRefCount, 1);
  assert.doesNotMatch(JSON.stringify(inspect), /RAW PROMPT TEXT SHOULD NOT LEAK/);
  assert.equal(inspect.safety.rawLogsIncluded, false);
});

test("workflow proposal context view maps supported source refs for shaping evidence", () => {
  const channel = createChannel();
  const rootThread = createConversationThread();
  const sourceMessage = createMessage({ id: "msg_current", threadId: rootThread.id, body: "继续处理上面的 workflow" });
  const conversationStore = createCanonicalConversationStore({
    threads: [rootThread],
    messages: [
      createMessage({ id: "msg_previous", threadId: rootThread.id, body: "先实现这个功能" }),
      sourceMessage,
    ],
  });
  const store = {
    ...conversationStore,
    getChannelAttachment: () => undefined,
    getChannelLinkPreview: () => undefined,
    listChannelInputMaterializations: () => [],
    listChannelExecutionProposals: () => [],
    listChannelWorkflows: () => [{
      id: "workflow_1",
      workspaceId: "workspace_1",
      channelId: channel.id,
      title: "Implement feature",
      objective: "Implement and verify.",
      status: "running",
      createdBy: "ling_agent",
      metadata: { sourceMessageId: "msg_previous" },
    }],
    listChannelWorkflowSteps: () => [{
      id: "step_1",
      workspaceId: "workspace_1",
      channelId: channel.id,
      workflowId: "workflow_1",
      title: "Run tests",
      prompt: "Run test suite",
      toParticipantId: "ling_agent",
      toParticipantLabel: "Ling Agent",
      status: "running",
      runId: "run_1",
    }],
    listRuns: () => [{
      id: "run_1",
      status: "running",
      cwd: "/tmp/project",
      taskId: "task_1",
      channelId: channel.id,
      teammateId: "ling_agent",
      workflowStepId: "step_1",
      providerName: "test",
      providerModel: "model",
      taskSnapshot: { title: "Run tests" },
      providerSnapshot: {},
      requestSnapshot: {},
      eventLogPath: "/tmp/run.log",
      createdAt: now,
      updatedAt: now,
    }],
    listApprovalRequests: () => [{
      id: "approval_1",
      runId: "run_1",
      workflowStepId: "step_1",
      actionType: "bash",
      risk: "medium",
      title: "Approve tests",
      description: "Run pnpm test",
      payload: { type: "bash", command: "pnpm test", cwd: "/tmp/project", riskFlags: [] },
      status: "pending",
      createdAt: now,
    }],
  };

  const view = buildWorkflowProposalContextView({ store, channel, sourceMessage });
  const sourceRefs = proposalSourceRefsFromContextView(view);

  assert.equal(view.kind, "workflow_proposal_view");
  assert.equal(view.sections.some((section) => section.id === "proposal_active_work" && section.visibility === "inspect_only"), true);
  assert.deepEqual(sourceRefs.map((ref) => `${ref.type}:${ref.id}`), [
    "message:msg_current",
    "message:msg_previous",
    "workflow:workflow_1",
    "workflow_step:step_1",
    "run:run_1",
  ]);
});

test("workflow step context view preserves dependency decision handoff and approval evidence", () => {
  const channel = createChannel({ boundPath: "/tmp/project", autoReplyMode: "mentions_only" });
  const workflow = createWorkflow({
    id: "workflow_1",
    channelId: channel.id,
    title: "Ship feature",
    objective: "Implement, verify, and report the feature.",
  });
  const dependency = createWorkflowStep({
    id: "step_dependency",
    workflowId: workflow.id,
    title: "Design",
    status: "succeeded",
    runId: "run_dependency",
    resultSummary: "Design says keep the implementation narrow.",
    metadata: {
      outputArtifactId: "artifact_primary",
      outputArtifactIds: ["artifact_extra"],
    },
  });
  const step = createWorkflowStep({
    id: "step_current",
    workflowId: workflow.id,
    title: "Implementation",
    prompt: "Implement the accepted design.",
    contextSummaryId: "summary_1",
    metadata: {
      templateStepId: "implementation",
      graphNodeId: "impl",
      skillId: "gstack-qa",
      dependsOnStepIds: [dependency.id],
      selectorDecisionIds: ["decision_1"],
      handoffIntentIds: ["handoff_1"],
      approvalGate: { mode: "standard", risk: "medium" },
      gates: [{
        stage: "post",
        title: "Review output",
        reason: "Validate the terminal summary before continuing.",
        approvalProfile: { mode: "strict", risk: "high" },
        requiredForStatuses: ["succeeded"],
      }],
    },
  });
  const store = createWorkflowStepStore();
  const view = buildWorkflowStepContextView({
    store,
    channel,
    workflow,
    step,
    prompt: step.prompt,
    workflowSteps: [dependency, step],
    protocolSection: createProtocolSection(channel),
    budget: { mode: "model_unknown", inputBudgetTokens: 4096 },
  });

  assert.equal(view.kind, "workflow_step_view");
  assert.deepEqual(view.sections.map((section) => section.id), [
    "workflow_runtime_boundary",
    "workflow_objective",
    "workflow_current_step",
    "workflow_approval_gates",
    "workflow_dependency_1",
    "workflow_selector_decisions",
    "workflow_handoff_intents",
    "workflow_context_summary",
    "channel_collaboration_protocol",
  ]);
  assert.match(renderChannelContextView(view), /Approval gates:\n- pre-run: mode=standard; risk=medium/);
  assert.match(renderChannelContextView(view), /- post: Review output \(mode=strict; risk=high\)/);
  assert.match(renderChannelContextView(view), /Dependency output:\n- Design \(succeeded\)/);
  assert.match(renderChannelContextView(view), /Workflow selector decisions:\n- workflow_step: Implementation is next/);
  assert.match(renderChannelContextView(view), /Workflow handoff intents:\n- Ling Agent -> Engineer: Specialist implementation/);
  assert.deepEqual(view.sourceRefs.map((ref) => `${ref.type}:${ref.id}`), [
    "channel:channel_1",
    "workflow:workflow_1",
    "workflow_step:step_current",
    "context_summary:summary_1",
    "workflow_step:step_dependency",
    "artifact:artifact_primary",
    "artifact:artifact_extra",
    "run:run_dependency",
    "artifact:artifact_run",
    "workflow_selector_decision:decision_1",
    "workflow_handoff_intent:handoff_1",
  ]);
});

test("workflow step context pack delegates through workflow step context view without losing legacy refs", () => {
  const channel = createChannel({ boundPath: "/tmp/project", autoReplyMode: "mentions_only" });
  const workflow = createWorkflow({ id: "workflow_1", channelId: channel.id });
  const dependency = createWorkflowStep({
    id: "step_dependency",
    workflowId: workflow.id,
    title: "Research",
    status: "succeeded",
    runId: "run_dependency",
    metadata: { outputArtifactId: "artifact_primary" },
  });
  const step = createWorkflowStep({
    id: "step_current",
    workflowId: workflow.id,
    title: "Implementation",
    prompt: "Use the compacted dependency summary.",
    metadata: {
      dependsOnStepIds: [dependency.id],
      selectorDecisionIds: ["decision_1"],
      handoffIntentIds: ["handoff_1"],
    },
  });
  const pack = buildWorkflowStepContextPack({
    store: createWorkflowStepStore(),
    channel,
    workflow,
    step,
    prompt: step.prompt,
    workflowSteps: [dependency, step],
    compactedDependencySummary: {
      id: "workflow_packet_summary_1",
      text: "Compacted workflow dependency summary:\nCompaction id: workflow_packet_summary_1",
      sourceRefs: [
        { type: "workflow_packet_summary", id: "workflow_packet_summary_1", label: "Compacted dependency context" },
        { type: "artifact", id: "artifact_primary", label: "Primary artifact" },
      ],
      sourceRefIds: ["workflow_packet_summary_1", "artifact_primary"],
    },
  });

  assert.equal(pack.kind, "workflow_step");
  assert.equal(pack.sections.some((section) => section.id === "workflow_dependency_summary"), true);
  assert.equal(pack.sections.some((section) => section.id === "workflow_dependency_1"), false);
  assert.deepEqual(pack.compactionIds, ["workflow_packet_summary_1"]);
  assert.equal(pack.sourceRefs.some((ref) => ref.type === "workflow_packet_summary" && ref.id === "workflow_packet_summary_1"), true);
  assert.equal(pack.sourceRefs.some((ref) => ref.type === "artifact" && ref.id === "artifact_primary"), true);
  assert.equal(pack.sourceRefs.some((ref) => ref.type === "workflow_selector_decision" && ref.id === "decision_1"), true);
  assert.equal(pack.sourceRefs.some((ref) => ref.type === "workflow_handoff_intent" && ref.id === "handoff_1"), true);
});

test("workflow step context names the managed worktree as the authoritative execution cwd", () => {
  const channel = createChannel({
    boundPath: "/tmp/project",
    workspaceBinding: {
      mode: "managed_worktree",
      status: "ready",
      executionPath: "/tmp/project/.ling-stack/worktrees/channels/channel_1",
      worktreePath: "/tmp/project/.ling-stack/worktrees/channels/channel_1",
      updatedAt: now,
    },
  });
  const view = buildWorkflowStepContextView({
    store: createWorkflowStepStore(),
    channel,
    workflow: createWorkflow(),
    step: createWorkflowStep(),
    prompt: "Create proof.txt in the current workspace.",
    workflowSteps: [createWorkflowStep()],
    protocolSection: createProtocolSection(channel),
    budget: { mode: "model_unknown", inputBudgetTokens: 4096 },
  });

  const objective = view.sections.find((section) => section.id === "workflow_objective");
  assert.ok(objective);
  assert.match(objective.text, /Execution cwd \(authoritative\): \/tmp\/project\/\.ling-stack\/worktrees\/channels\/channel_1/u);
  assert.match(objective.text, /All relative file paths resolve from the execution cwd/u);
  assert.match(objective.text, /Do not write to the bound parent workspace/u);
});

test("workflow step projection retains a confirmed objective once without changing frozen step evidence", () => {
  const input = createGraphStepContextInput();
  const before = JSON.stringify({ workflow: input.workflow, step: input.step });
  const view = buildWorkflowStepContextView(input);
  const rendered = renderChannelContextView(view);

  assert.equal(rendered.split(input.workflow.objective).length - 1, 1);
  assert.match(rendered, /Current graph node: Independent QA/u);
  assert.match(rendered, /Assigned teammate: QA/u);
  assert.match(rendered, /Only create audit\.md; never overwrite an existing file/u);
  assert.match(rendered, /exact command: node --test constraints-check\.test\.js/u);
  assert.match(rendered, /workingDirectory.*qinglan-ledger/u);
  assert.match(rendered, /sourceRefs.*item_confirmed/u);
  assert.match(rendered, /Acceptance criteria:\n- Independently verify all seven tests/u);
  assert.match(rendered, /Do not start or approve later workflow nodes/u);
  assert.deepEqual(view.sections.find(section => section.id === "workflow_current_step").sourceRefIds, [input.step.id]);
  assert.equal(view.sources.some(source => source.kind === "workflow_step" && source.text.includes(input.step.prompt)), true);
  assert.equal(JSON.stringify({ workflow: input.workflow, step: input.step }), before);
  assert.equal(renderChannelContextView(buildWorkflowStepContextView(input)), rendered);
});

test("workflow step projection fits duplicated context under the unchanged provider budget", () => {
  const input = createGraphStepContextInput({
    objective: "全部需求和权限边界必须完整保留。".repeat(240),
    instruction: "Keep this complete operation constraint, including all source references. ".repeat(120),
  });
  const pack = buildWorkflowStepContextPack(input);
  assert.equal(pack.budget.inputBudgetTokens, 6656);
  assert.equal(pack.overBudget, false);
  const rendered = pack.sections.map(section => section.text).join("\n\n");
  assert.equal(rendered.split(input.workflow.objective).length - 1, 1);
  assert.ok(rendered.includes(input.instruction));

  const tooLarge = createGraphStepContextInput({ instruction: "nonduplicated mandatory constraint ".repeat(1_000) });
  const blocked = buildWorkflowStepContextPack(tooLarge);
  assert.equal(blocked.budget.inputBudgetTokens, 6656);
  assert.equal(blocked.overBudget, true);
  assert.ok(blocked.sections.find(section => section.id === "workflow_current_step").text.includes(tooLarge.instruction));
});

test("workflow step projection preserves overrides, unknown wrappers and unmatched graph evidence", () => {
  for (const mutate of [
    input => { input.prompt += "\nAdditional explicit caller instruction."; },
    input => { input.workflow.metadata.workflowGraphFingerprint = "wgfv1:changed"; },
    input => { input.step.metadata.graphNodeId = "not-this-node"; },
    input => { input.step.metadata.graphId = "not-this-graph"; },
    input => { input.workflow.metadata.workflowGraph.nodes[0].prompt += "\nChanged node-local constraint."; },
    input => { input.workflow.metadata.workflowGraph.nodes[0].name = "Changed node name"; },
    input => { input.workflow.metadata.workflowGraph.nodes[0].skillId = "changed_skill"; },
    input => { input.step.prompt += "\nChanged stored step instruction."; input.prompt = input.step.prompt; },
    input => { input.workflow.metadata = undefined; },
    input => { input.prompt = "Manual step that merely mentions Overall scope: without a Host wrapper."; },
  ]) {
    const input = createGraphStepContextInput();
    mutate(input);
    const view = buildWorkflowStepContextView(input);
    assert.ok(view.sections.find(section => section.id === "workflow_current_step").text.includes(input.prompt));
  }
});

test("workflow step projection removes only the graph wrapper for non-proposal graph nodes", () => {
  const input = createGraphStepContextInput({ proposal: false });
  const view = buildWorkflowStepContextView(input);
  const rendered = renderChannelContextView(view);
  assert.equal(rendered.split(input.workflow.objective).length - 1, 1);
  assert.ok(rendered.includes(input.instruction));
});

test("workflow step projection does not strip objective-like text from a custom node instruction", () => {
  const objective = "Do not change permissions.";
  const instruction = `Quoted custom instruction:\nOverall scope:\n${objective}\n\nKeep this quote exactly.`;
  const input = createGraphStepContextInput({ objective, instruction, proposal: false });
  const view = buildWorkflowStepContextView(input);
  assert.ok(view.sections.find(section => section.id === "workflow_current_step").text.includes(instruction));
});

function createGraphStepContextInput(options = {}) {
  const objective = options.objective ?? "Complete the independently verified audit without changing the original eight files.";
  const instruction = options.instruction ?? [
    "Only create audit.md; never overwrite an existing file.",
    "exact command: node --test constraints-check.test.js",
    'binding: {"workingDirectory":"qinglan-ledger","sourceRefs":[{"id":"item_confirmed"}]}',
    "Acceptance criteria:\n- Independently verify all seven tests",
  ].join("\n");
  const proposal = options.proposal !== false;
  const title = "Verified audit";
  const node = {
    id: "qa_node", kind: "step", name: "Independent QA", teammateId: "teammate_qa",
    prompt: proposal
      ? `Confirmed proposal:\n${title}\n\nOverall scope:\n${objective}\n\nAssigned teammate: QA\n\n${instruction}`
      : instruction,
  };
  const graph = {
    schemaVersion: 1, id: proposal ? "proposal_proposal_1" : "custom_graph", name: title,
    entryNodeId: node.id, nodes: [node], edges: [],
    termination: { success: "all_required_succeeded", onFailedRequiredNode: "block_for_user", onApprovalDenied: "block_for_user" },
  };
  const workflow = createWorkflow({ title, objective, metadata: {
    workflowGraph: graph, workflowGraphId: graph.id, workflowGraphFingerprint: workflowGraphFingerprintV1(graph),
    ...(proposal ? { sourceProposalId: "proposal_1" } : {}),
  } });
  const step = createWorkflowStep({
    status: "blocked", title: node.name, toParticipantId: node.teammateId,
    prompt: [
      `Workflow objective:\n${objective}`, `Current graph node: ${node.name}`, node.prompt,
      "Complete this graph node only. Do not start or approve later workflow nodes.",
      "Return a concise terminal summary and any artifacts or follow-up decisions needed by later nodes.",
    ].join("\n\n"),
    metadata: { graphId: graph.id, graphNodeId: node.id },
  });
  const channel = createChannel();
  return {
    store: createWorkflowStepStore(), channel, workflow, step, prompt: step.prompt, instruction,
    workflowSteps: [step], protocolSection: createProtocolSection(channel),
  };
}

test("selector context view filters private memory and raw evidence sources", () => {
  const view = buildChannelContextView({
    kind: "selector_view",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    now,
    sourceRefs: [],
    sections: [{
      id: "selector_source_message",
      role: "user",
      priority: "must_keep",
      title: "Latest turn",
      text: "Latest turn",
      sourceRefIds: ["msg_current"],
      visibility: "prompt",
      quotePolicy: "public_ok",
    }],
    sources: [
      createSource({ id: "turn:msg_current", kind: "turn" }),
      createSource({ id: "memory:private", kind: "memory", sensitivity: "private" }),
      createSource({ id: "artifact:raw", kind: "artifact" }),
      createSource({ id: "evidence:raw", kind: "evidence" }),
    ],
  });

  assert.deepEqual(view.sources.map((source) => source.id), ["turn:msg_current"]);
  assert.deepEqual(view.dropped, [
    { sourceId: "memory:private", reason: "sensitivity" },
    { sourceId: "artifact:raw", reason: "scope" },
    { sourceId: "evidence:raw", reason: "raw_evidence" },
  ]);
});

test("memory eligibility keeps channel memory but excludes private and secret memory from public channel views", () => {
  const channelMemory = createSource({ id: "memory:channel", kind: "memory" });
  const influenceOnlyMemory = createSource({
    id: "memory:influence",
    kind: "memory",
    metadata: { publicQuoteEligible: false },
  });
  const privateMemory = createSource({
    id: "memory:private",
    kind: "memory",
    sensitivity: "private",
    teammateId: "teammate_a",
  });
  const secretMemory = createSource({
    id: "memory:secret",
    kind: "memory",
    sensitivity: "secret_adjacent",
  });

  const view = buildChannelContextView({
    kind: "ling_agent_channel_view",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    now,
    sourceRefs: [],
    sections: [],
    sources: [channelMemory, influenceOnlyMemory, privateMemory, secretMemory],
  });

  assert.deepEqual(view.sources.map((source) => source.id), ["memory:channel", "memory:influence"]);
  assert.deepEqual(view.dropped, [
    { sourceId: "memory:private", reason: "sensitivity" },
    { sourceId: "memory:secret", reason: "sensitivity" },
  ]);
  assert.deepEqual(memoryEligibilityForView(channelMemory, "ling_agent_channel_view"), {
    mode: "public_quote",
    quotePolicy: "public_ok",
    policyVersion: "memory_use_isolation_v2",
  });
  assert.deepEqual(memoryEligibilityForView(influenceOnlyMemory, "ling_agent_channel_view"), {
    mode: "influence_only",
    quotePolicy: "influence_only",
    policyVersion: "memory_use_isolation_v2",
  });
});

test("memory eligibility allows private memory only for the matching teammate consumer", () => {
  const privateMemory = createSource({
    id: "memory:private",
    kind: "memory",
    sensitivity: "private",
    teammateId: "teammate_a",
  });

  const matchingPrivateView = buildChannelContextView({
    kind: "private_chat_view",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    consumerTeammateId: "teammate_a",
    now,
    sourceRefs: [],
    sections: [],
    sources: [privateMemory],
  });
  const wrongSpecialistView = buildChannelContextView({
    kind: "specialist_task_view",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    consumerTeammateId: "teammate_b",
    now,
    sourceRefs: [],
    sections: [],
    sources: [privateMemory],
  });

  assert.deepEqual(matchingPrivateView.sources.map((source) => source.id), ["memory:private"]);
  assert.deepEqual(matchingPrivateView.dropped, []);
  assert.deepEqual(wrongSpecialistView.sources, []);
  assert.deepEqual(wrongSpecialistView.dropped, [
    { sourceId: "memory:private", reason: "sensitivity" },
  ]);
  assert.deepEqual(memoryEligibilityForView(privateMemory, "workflow_step_view", "teammate_a"), {
    mode: "influence_only",
    quotePolicy: "influence_only",
    policyVersion: "memory_use_isolation_v2",
  });
});

test("private chat context view keeps private thread sources without importing linked channel task or workflow facts", () => {
  const teammate = createTeammate();
  const thread = createDirectThread({ teammateId: teammate.id });
  const priorMessage = createDirectMessage({
    id: "direct_prior",
    teammateId: teammate.id,
    threadId: thread.id,
    authorType: "local-user",
    body: "Earlier private context only.",
  });
  const sourceMessage = createDirectMessage({
    id: "direct_latest",
    teammateId: teammate.id,
    threadId: thread.id,
    authorType: "local-user",
    body: "Please continue from the linked run.",
    linkedTaskId: "task_1",
    linkedRunId: "run_1",
  });
  const privateMemory = createSource({
    id: "memory:private",
    kind: "memory",
    sensitivity: "private",
    teammateId: teammate.id,
  });
  const channelRecent = createSource({
    id: "recent_message:channel",
    kind: "recent_message",
    channelId: "channel_1",
    text: "This public channel text must not enter private chat.",
  });
  const view = buildPrivateChatContextView({
    store: createPrivateChatStore(),
    teammate,
    thread,
    messages: [priorMessage, sourceMessage],
    sourceMessage,
    memorySources: [privateMemory, channelRecent],
    now,
  });

  assert.equal(view.kind, "private_chat_view");
  assert.equal(view.consumerTeammateId, teammate.id);
  assert.match(renderChannelContextView(view), /Teammate: Designer/);
  assert.match(renderChannelContextView(view), /Earlier private context only/);
  assert.match(renderChannelContextView(view), /Please continue from the linked run/);
  assert.doesNotMatch(renderChannelContextView(view), /This public channel text must not enter private chat/);
  assert.deepEqual(view.sources.map((source) => source.id), [
    "teammate_profile:teammate_designer",
    "private_message:direct_prior",
    "private_message:direct_latest",
    "memory:private",
  ]);
  assert.deepEqual(view.dropped, [{ sourceId: "recent_message:channel", reason: "scope" }]);
  assert.ok(!view.sourceRefs.some((ref) => ["task", "run", "workflow", "workflow_step", "channel"].includes(ref.type)));
});

test("memory eligibility keeps raw memory out of selector and proposal views", () => {
  const memory = createSource({ id: "memory:channel", kind: "memory" });

  const selectorView = buildChannelContextView({
    kind: "selector_view",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    now,
    sourceRefs: [],
    sections: [],
    sources: [memory],
  });
  const proposalView = buildChannelContextView({
    kind: "workflow_proposal_view",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    now,
    sourceRefs: [],
    sections: [],
    sources: [memory],
  });

  assert.deepEqual(selectorView.sources, []);
  assert.deepEqual(proposalView.sources, []);
  assert.deepEqual(selectorView.dropped, [{ sourceId: "memory:channel", reason: "scope" }]);
  assert.deepEqual(proposalView.dropped, [{ sourceId: "memory:channel", reason: "scope" }]);
});

test("memory eligibility keeps memory inspect-only for evidence inspect views", () => {
  const privateMemory = createSource({
    id: "memory:private",
    kind: "memory",
    sensitivity: "private",
    teammateId: "teammate_a",
  });
  const secretMemory = createSource({
    id: "memory:secret",
    kind: "memory",
    sensitivity: "secret_adjacent",
  });

  const view = buildChannelContextView({
    kind: "evidence_inspect_view",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    now,
    sourceRefs: [],
    sections: [],
    sources: [privateMemory, secretMemory],
  });

  assert.deepEqual(view.sources.map((source) => source.id), ["memory:private", "memory:secret"]);
  assert.deepEqual(view.dropped, []);
  assert.deepEqual(memoryEligibilityForView(secretMemory, "evidence_inspect_view"), {
    mode: "inspect_only",
    quotePolicy: "inspect_only",
    policyVersion: "memory_use_isolation_v2",
  });
});

test("context view renderer hides inspect-only sections by default", () => {
  const view = buildChannelContextView({
    kind: "ling_agent_channel_view",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    now,
    sourceRefs: [],
    sections: [
      {
        id: "prompt",
        role: "user",
        priority: "must_keep",
        title: "Prompt",
        text: "Visible prompt text",
        sourceRefIds: [],
        visibility: "prompt",
        quotePolicy: "public_ok",
      },
      {
        id: "inspect",
        role: "evidence",
        priority: "low",
        title: "Inspect",
        text: "Hidden diagnostic text",
        sourceRefIds: [],
        visibility: "inspect_only",
        quotePolicy: "inspect_only",
      },
    ],
  });

  assert.equal(renderChannelContextView(view), "Visible prompt text");
});

function createChannel(overrides = {}) {
  return {
    id: "channel_1",
    workspaceId: "workspace_1",
    name: "General",
    status: "active",
    autoReplyMode: "manual",
    allowedTools: [],
    runtimePolicy: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createMessage(overrides = {}) {
  return {
    id: "msg_1",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    kind: "message",
    intent: "discuss",
    authorType: "local-user",
    body: "",
    mentions: [],
    attachmentIds: [],
    linkPreviewIds: [],
    fileRefs: [],
    status: "ready",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createConversationThread(overrides = {}) {
  return {
    id: "thread_root",
    workspaceId: "workspace_1",
    kind: "channel_discussion",
    channelId: "channel_1",
    title: "Conversation",
    objective: "Test conversation",
    status: "open",
    conversationMode: { mode: "normal", source: "default" },
    createdAt: now,
    updatedAt: now,
    surfaceKind: "channel_root",
    relationKind: "root",
    nextItemSequence: 1,
    ...overrides,
  };
}

function createCanonicalConversationStore({ threads, messages, interventions = [] }) {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const nextSequenceByThread = new Map();
  const items = messages.map((message) => {
    assert.ok(message.threadId, `Canonical test message requires threadId: ${message.id}`);
    const sequence = (nextSequenceByThread.get(message.threadId) ?? 0) + 1;
    nextSequenceByThread.set(message.threadId, sequence);
    const assistant = message.kind === "ai_reply";
    const status = message.status === "pending" ? "pending" : message.status === "failed" ? "failed" : "committed";
    return {
      schemaVersion: 1,
      id: message.id,
      workspaceId: message.workspaceId,
      channelId: message.channelId,
      threadId: message.threadId,
      turnId: `turn_${message.id}`,
      sequence,
      kind: assistant ? "assistant_message" : "user_message",
      status,
      actorType: message.authorType === "local-user" ? "local_user" : "teammate",
      ...(message.authorId ? { actorId: message.authorId } : {}),
      visibility: "channel",
      payload: assistant ? {
        body: message.body,
        format: "markdown",
        streaming: status === "pending",
        deliveryStatus: message.status,
        ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      } : {
        body: message.body,
        format: "markdown",
        mentions: message.mentions.map((mention) => ({
          id: mention.id,
          label: mention.label,
          kind: mention.kind === "ai-teammate" ? "ai_teammate" : mention.kind === "local-user" ? "local_user" : "channel",
        })),
        attachmentIds: message.attachmentIds,
        linkPreviewIds: message.linkPreviewIds,
        fileRefs: message.fileRefs,
      },
      domainRefs: [],
      revision: 1,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      ...(status === "committed" ? { committedAt: message.updatedAt } : {}),
    };
  });
  const itemById = new Map(items.map((item) => [item.id, item]));
  const turnById = new Map(items.map((item) => [item.turnId, {
    id: item.turnId,
    threadId: item.threadId,
    status: "completed",
  }]));
  const segmentByThreadId = new Map(threads.map((thread) => [thread.id, {
    id: `segment_${thread.id}`,
    threadId: thread.id,
    state: "active",
    createdFromTurnId: items.find((item) => item.threadId === thread.id)?.turnId ?? `turn_${thread.id}`,
    lastActiveTurnId: [...items].reverse().find((item) => item.threadId === thread.id)?.turnId ?? `turn_${thread.id}`,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  }]));
  const assignmentByTurnId = new Map(items.map((item) => [item.turnId, {
    id: `assignment_${item.turnId}`,
    turnId: item.turnId,
    segmentId: segmentByThreadId.get(item.threadId).id,
    status: "committed",
    decisionSource: "structural",
    confidence: 1,
    evidenceRefs: [{ type: "conversation_item", id: item.id }],
    policyVersion: "test-policy",
    revision: 1,
    createdAt: now,
  }]));
  return {
    listRunInterventions: () => interventions,
    listLingThreads: ({ channelId }) => threads.filter((thread) => thread.channelId === channelId),
    getLingThread: (threadId) => threadById.get(threadId),
    getConversationItem: (itemId) => itemById.get(itemId),
    getEffectiveConversationItem: (itemId) => itemById.get(itemId),
    getLingTurn: (turnId) => turnById.get(turnId),
    getEffectiveTurnContextAssignment: (turnId) => assignmentByTurnId.get(turnId),
    getContextSegment: (segmentId) => [...segmentByThreadId.values()].find((segment) => segment.id === segmentId),
    listConversationContextSummaries: () => [],
    getMemoryObject: () => undefined,
    listConversationItemsForTurn: ({ turnId }) => items.filter((item) => item.turnId === turnId && item.status === "committed"),
    listConversationItemsForSegment: (options) => items
      .filter((item) => item.threadId === options.threadId)
      .filter((item) => assignmentByTurnId.get(item.turnId)?.segmentId === options.segmentId)
      .filter((item) => item.sequence <= options.throughSequence)
      .filter((item) => item.sequence > (options.afterSequence ?? 0))
      .filter((item) => item.status === "committed")
      .slice(0, options.limit ?? 500),
    listConversationItemsByChannelPage: (options) => {
      const filtered = items
        .filter((item) => item.channelId === options.channelId)
        .filter((item) => !options.threadId || item.threadId === options.threadId)
        .filter((item) => !(options.excludeThreadIds ?? []).includes(item.threadId))
        .filter((item) => !options.kinds || options.kinds.includes(item.kind));
      const limit = options.limit ?? 200;
      return { items: filtered.slice(-limit), hasMore: filtered.length > limit };
    },
  };
}

function createSource(overrides = {}) {
  return {
    id: "source_1",
    kind: "turn",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    sourceRefs: [],
    title: "Source",
    text: "Source text",
    metadata: {},
    sensitivity: "normal",
    freshness: "recent",
    ...overrides,
  };
}

function createWorkflow(overrides = {}) {
  return {
    id: "workflow_1",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    title: "Workflow",
    objective: "Complete the workflow.",
    status: "running",
    createdBy: "ling_agent",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createWorkflowStep(overrides = {}) {
  return {
    id: "step_1",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    workflowId: "workflow_1",
    position: 1,
    title: "Step",
    prompt: "Do the step.",
    toParticipantId: "ling_agent",
    toParticipantLabel: "Ling Agent",
    status: "queued",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createTeammate(overrides = {}) {
  return {
    id: "teammate_designer",
    workspaceId: "workspace_1",
    roleKey: "designer",
    displayName: "Designer",
    description: "Designs product flows.",
    appendSystemPrompt: [],
    allowedTools: [],
    approvalProfile: "standard",
    status: "active",
    pinned: false,
    hidden: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createDirectThread(overrides = {}) {
  return {
    id: "direct_thread_1",
    workspaceId: "workspace_1",
    teammateId: "teammate_designer",
    title: "Private chat with Designer",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createDirectMessage(overrides = {}) {
  return {
    id: "direct_message_1",
    workspaceId: "workspace_1",
    threadId: "direct_thread_1",
    teammateId: "teammate_designer",
    authorType: "local-user",
    authorId: "local-user",
    body: "",
    attachmentIds: [],
    status: "ready",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createPrivateChatStore() {
  const task = {
    id: "task_1",
    workspaceId: "workspace_1",
    channelId: "channel_1",
    title: "Linked task",
    prompt: "Explicit linked task prompt.",
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
  const run = {
    id: "run_1",
    status: "succeeded",
    cwd: "/tmp/ling-stack",
    taskId: task.id,
    channelId: task.channelId,
    workflowStepId: "step_1",
    providerName: "Test",
    providerModel: "test-model",
    taskSnapshot: { title: "Linked run" },
    providerSnapshot: {},
    requestSnapshot: {},
    eventLogPath: "/tmp/events.jsonl",
    createdAt: now,
    updatedAt: now,
  };
  const workflow = createWorkflow({ id: "workflow_1", channelId: task.channelId });
  const step = createWorkflowStep({ id: "step_1", workflowId: workflow.id, channelId: task.channelId });
  return {
    getTask: (id) => id === task.id ? task : undefined,
    getRun: (id) => id === run.id ? run : undefined,
    getChannelWorkflowStep: (id) => id === step.id ? step : undefined,
    getChannelWorkflow: (id) => id === workflow.id ? workflow : undefined,
  };
}

function createArtifact(overrides = {}) {
  return {
    id: "artifact_1",
    runId: "run_1",
    type: "json",
    path: ".ling-stack/artifact.json",
    title: "Artifact",
    contentType: "application/json",
    sizeBytes: 512,
    createdAt: now,
    ...overrides,
  };
}

function createProtocolSection(channel) {
  return {
    id: "channel_collaboration_protocol",
    role: "instruction",
    priority: "high",
    title: "channel_collaboration_protocol",
    text: `Channel collaboration protocol:\n- Response language: follow_user (source=default)\n- Auto reply mode: ${channel.autoReplyMode} (source=default)`,
    sourceRefIds: [channel.id],
    visibility: "prompt",
    quotePolicy: "public_ok",
    metadata: {
      autoReplyMode: channel.autoReplyMode,
      autoReplyModeSource: "default",
    },
  };
}

function createWorkflowStepStore() {
  const artifacts = new Map([
    ["artifact_primary", { id: "artifact_primary", title: "Primary artifact", path: "/tmp/project/design.md" }],
    ["artifact_extra", { id: "artifact_extra", title: "Extra artifact", path: "/tmp/project/extra.md" }],
    ["artifact_run", { id: "artifact_run", title: "Run artifact", path: "/tmp/project/run.log" }],
  ]);
  return {
    paths: { cwd: "/tmp/project" },
    getProviderPreset: () => undefined,
    getWorkspaceSettings: () => ({}),
    getChannelCollaborationProtocolOverride: () => undefined,
    getChannelContextSummary: (id) => id === "summary_1"
      ? {
          id,
          summary: "The channel agreed to keep the implementation narrow.",
          acceptanceCriteria: ["tests pass"],
          openQuestions: ["none"],
        }
      : undefined,
    getArtifact: (id) => artifacts.get(id),
    listArtifacts: (runId) => runId === "run_dependency" ? [artifacts.get("artifact_run")] : [],
    getWorkflowSelectorDecision: (id) => id === "decision_1"
      ? {
          id,
          targetKind: "workflow_step",
          reason: "Implementation is next",
          status: "accepted",
          createdBy: "ling_agent",
        }
      : undefined,
    getWorkflowHandoffIntent: (id) => id === "handoff_1"
      ? {
          id,
          fromParticipantLabel: "Ling Agent",
          toParticipantId: "engineer_1",
          toParticipantLabel: "Engineer",
          reason: "Specialist implementation",
          status: "accepted",
        }
      : undefined,
  };
}
