import assert from "node:assert/strict";
import test from "node:test";
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
import { condenseChannelContextSources } from "../dist/features/channels/context-processing/condenser.js";
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
  const current = createMessage({ id: "msg_current", body: "继续" });
  const store = {
    listRunInterventions: () => [{ idempotencyKey: "channel_message:msg_guidance:queue_followup" }],
    listChannelMessages: () => [
      createMessage({ id: "msg_old", body: "old topic" }),
      createMessage({ id: "msg_guidance", body: "queued guidance" }),
      current,
    ],
  };

  const messages = listChannelContextMessages({
    store,
    channelId: "channel_1",
    sourceMessage: current,
  });

  assert.deepEqual(messages.map((message) => message.id), ["msg_old", "msg_current"]);
});

test("active work collector projects proposals workflows runs and approvals as metadata sources", () => {
  const channel = createChannel();
  const store = {
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

  const sources = collectActiveWorkSources({ store, channel });

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
    stderr: `${"noise ".repeat(80)}sk-live_secret_token_1234567890 failed with Bearer abcdefghijklmnop`,
    maxTailChars: 120,
  });
  assert.match(failedSummary, /stderrTail/);
  assert.match(failedSummary, /\[REDACTED\]/);
  assert.doesNotMatch(failedSummary, /sk-live_secret_token_1234567890/);
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
    text: `stdout ${"noise ".repeat(120)}sk-live_secret_token_1234567890 ${"tail ".repeat(120)}`,
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
  assert.doesNotMatch(result.sources[1].text, /sk-live_secret_token_1234567890/);
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
  const sourceMessage = createMessage({ id: "msg_current", body: "继续处理上面的 workflow" });
  const store = {
    listRunInterventions: () => [],
    listChannelMessages: () => [
      createMessage({ id: "msg_previous", body: "先实现这个功能" }),
      sourceMessage,
    ],
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
    policyVersion: "memory_use_isolation_v1",
  });
  assert.deepEqual(memoryEligibilityForView(influenceOnlyMemory, "ling_agent_channel_view"), {
    mode: "influence_only",
    quotePolicy: "influence_only",
    policyVersion: "memory_use_isolation_v1",
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
    policyVersion: "memory_use_isolation_v1",
  });
});

test("private chat context view keeps private thread sources and explicit task/run refs", () => {
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
    "private_ref:task:task_1",
    "private_ref:run:run_1",
    "memory:private",
  ]);
  assert.deepEqual(view.dropped, [{ sourceId: "recent_message:channel", reason: "scope" }]);
  assert.ok(view.sourceRefs.some((ref) => ref.type === "task" && ref.id === "task_1"));
  assert.ok(view.sourceRefs.some((ref) => ref.type === "run" && ref.id === "run_1"));
  assert.ok(view.sourceRefs.some((ref) => ref.type === "workflow" && ref.id === "workflow_1"));
  assert.ok(view.sourceRefs.some((ref) => ref.type === "workflow_step" && ref.id === "step_1"));
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
    policyVersion: "memory_use_isolation_v1",
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
