import type {
  ApprovalStoreFacet,
  Channel,
  ChannelMessage,
  ChannelStoreFacet,
  ChannelWorkflow,
  ChannelWorkflowStep,
  RunArtifact,
  RunExecutionStoreFacet,
} from "@ling-stack/core";
import type { LingAgentTurnEnvelope, LingTurnMaterializationStatus } from "../ling-agent-turn-envelope.js";
import {
  artifactEvidenceSensitivity,
  evidenceKindForArtifact,
  summarizeArtifactEvidence,
  workflowPacketKindForArtifact,
} from "./evidence.js";
import type { ChannelContextSource, ChannelContextSourceRef } from "./types.js";

type ChannelContextConversationStore = ChannelStoreFacet & RunExecutionStoreFacet;
type ChannelContextActiveWorkStore = ChannelStoreFacet & RunExecutionStoreFacet & ApprovalStoreFacet;
type WorkflowEvidenceStore = RunExecutionStoreFacet;

export function collectTurnSource(input: {
  readonly workspaceId?: string;
  readonly channel: Channel;
  readonly envelope: LingAgentTurnEnvelope;
}): ChannelContextSource {
  const sourceRefs: ChannelContextSourceRef[] = [
    { type: "channel", id: input.channel.id, label: input.channel.name },
    { type: "message", id: input.envelope.sourceMessageId, label: "Current turn" },
    ...input.envelope.attachments.map((attachment) => ({
      type: "attachment",
      id: attachment.id,
      label: attachment.fileName,
    })),
    ...input.envelope.linkPreviews.map((preview) => ({
      type: "link_preview",
      id: preview.id,
      label: preview.title ?? preview.normalizedUrl,
    })),
  ];
  return {
    id: `turn:${input.envelope.sourceMessageId}`,
    kind: "turn",
    workspaceId: input.workspaceId ?? input.channel.workspaceId,
    channelId: input.channel.id,
    sourceRefs,
    title: "Current turn",
    text: input.envelope.body,
    metadata: {
      attachmentCount: input.envelope.attachments.length,
      linkPreviewCount: input.envelope.linkPreviews.length,
      fileRefCount: input.envelope.fileRefs.length,
      materializedInputCount: countMaterializedTurnInputs(input.envelope),
      hasGuidancePayload: Boolean(input.envelope.guidancePayload),
      activeRunId: input.envelope.activeRunId,
    },
    sensitivity: "normal",
    freshness: "current_turn",
  };
}

export function collectMaterializedInputSources(input: {
  readonly workspaceId?: string;
  readonly channel: Channel;
  readonly envelope: LingAgentTurnEnvelope;
}): readonly ChannelContextSource[] {
  const workspaceId = input.workspaceId ?? input.channel.workspaceId;
  const sources: ChannelContextSource[] = [];
  for (const attachment of input.envelope.attachments) {
    sources.push({
      id: `materialized_input:attachment:${attachment.id}`,
      kind: "materialized_input",
      workspaceId,
      channelId: input.channel.id,
      sourceRefs: [
        { type: "message", id: input.envelope.sourceMessageId, label: "Current turn" },
        { type: "attachment", id: attachment.id, label: attachment.fileName },
        ...(attachment.materializationId ? [{ type: "materialization", id: attachment.materializationId, label: attachment.fileName }] : []),
      ],
      title: attachment.fileName,
      text: boundedPromptPreview(attachment.previewText),
      metadata: {
        sourceKind: "attachment",
        fileName: attachment.fileName,
        attachmentKind: attachment.kind,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        previewStatus: attachment.previewStatus,
        materializationStatus: attachment.materializationStatus,
        materializationId: attachment.materializationId,
        hasPromptContent: hasPromptContent(attachment.materializationStatus, attachment.previewText),
        reason: attachment.reason,
      },
      sensitivity: "normal",
      freshness: "current_turn",
    });
  }
  for (const preview of input.envelope.linkPreviews) {
    sources.push({
      id: `materialized_input:link_preview:${preview.id}`,
      kind: "materialized_input",
      workspaceId,
      channelId: input.channel.id,
      sourceRefs: [
        { type: "message", id: input.envelope.sourceMessageId, label: "Current turn" },
        { type: "link_preview", id: preview.id, label: preview.title ?? preview.normalizedUrl },
        ...(preview.materializationId ? [{ type: "materialization", id: preview.materializationId, label: preview.title ?? preview.normalizedUrl }] : []),
      ],
      title: preview.title ?? preview.normalizedUrl,
      text: boundedPromptPreview(preview.previewText),
      metadata: {
        sourceKind: "link_preview",
        url: preview.url,
        normalizedUrl: preview.normalizedUrl,
        siteName: preview.siteName,
        status: preview.status,
        materializationStatus: preview.materializationStatus,
        materializationId: preview.materializationId,
        hasPromptContent: hasPromptContent(preview.materializationStatus, preview.previewText),
        reason: preview.reason,
      },
      sensitivity: "normal",
      freshness: "current_turn",
    });
  }
  for (const fileRef of input.envelope.fileRefs) {
    sources.push({
      id: `materialized_input:workspace_file_ref:${fileRef.path}`,
      kind: "materialized_input",
      workspaceId,
      channelId: input.channel.id,
      sourceRefs: [
        { type: "message", id: input.envelope.sourceMessageId, label: "Current turn" },
        { type: "workspace_file_ref", id: fileRef.path, label: fileRef.label ?? fileRef.path },
        ...(fileRef.materializationId ? [{ type: "materialization", id: fileRef.materializationId, label: fileRef.label ?? fileRef.path }] : []),
      ],
      title: fileRef.label ?? fileRef.path,
      text: boundedPromptPreview(fileRef.previewText),
      metadata: {
        sourceKind: "workspace_file_ref",
        path: fileRef.path,
        label: fileRef.label,
        refKind: fileRef.kind,
        rootRelation: fileRef.rootRelation,
        source: fileRef.source,
        line: fileRef.line,
        materializationStatus: fileRef.materializationStatus,
        materializationId: fileRef.materializationId,
        hasPromptContent: hasPromptContent(fileRef.materializationStatus, fileRef.previewText),
        reason: fileRef.blockedReason,
      },
      sensitivity: fileRef.rootRelation === "outside_workspace" ? "secret_adjacent" : "normal",
      freshness: "current_turn",
    });
  }
  return uniqueSources(sources);
}

export function collectChannelStateSource(input: {
  readonly channel: Channel;
  readonly title?: string;
  readonly text?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}): ChannelContextSource {
  return {
    id: `channel:${input.channel.id}`,
    kind: "channel_state",
    workspaceId: input.channel.workspaceId,
    channelId: input.channel.id,
    sourceRefs: [{ type: "channel", id: input.channel.id, label: input.channel.name }],
    title: input.title ?? input.channel.name,
    text: input.text,
    metadata: {
      name: input.channel.name,
      boundPath: input.channel.boundPath,
      status: input.channel.status,
      ...input.metadata,
    },
    sensitivity: "normal",
    freshness: "durable",
  };
}

export function collectRecentConversationSources(input: {
  readonly workspaceId?: string;
  readonly channelId: string;
  readonly messages: readonly ChannelMessage[];
  readonly excludeMessageId?: string;
  readonly limit?: number;
}): readonly ChannelContextSource[] {
  return input.messages
    .filter((message) => message.channelId === input.channelId)
    .filter((message) => message.id !== input.excludeMessageId)
    .filter((message) => message.status !== "pending")
    .slice(-(input.limit ?? 8))
    .map((message): ChannelContextSource => ({
      id: `recent_message:${message.id}`,
      kind: "recent_message",
      workspaceId: input.workspaceId ?? message.workspaceId,
      channelId: message.channelId,
      teammateId: message.authorType === "ai-teammate" ? message.authorId : undefined,
      sourceRefs: [{ type: "message", id: message.id, label: "Recent context message" }],
      title: `Recent ${message.authorType} message`,
      text: message.body,
      metadata: {
        authorType: message.authorType,
        authorId: message.authorId,
        status: message.status,
        createdAt: message.createdAt,
      },
      sensitivity: "normal",
      freshness: "recent",
    }));
}

export function listChannelContextMessages(input: {
  readonly store: ChannelContextConversationStore;
  readonly channelId: string;
  readonly sourceMessage: ChannelMessage;
  readonly limit?: number;
}): readonly ChannelMessage[] {
  const historicalGuidanceMessageIds = new Set(
    input.store
      .listRunInterventions({ limit: 500 })
      .map((intervention) => parseChannelMessageGuidanceIdempotencyKey(intervention.idempotencyKey))
      .filter((messageId): messageId is string => Boolean(messageId)),
  );
  return input.store
    .listChannelMessages({ channelId: input.channelId, limit: input.limit ?? 8 })
    .filter((message) => message.id === input.sourceMessage.id || !historicalGuidanceMessageIds.has(message.id));
}

export function listPriorChannelContextMessages(input: {
  readonly store: ChannelContextConversationStore;
  readonly channelId: string;
  readonly sourceMessage: ChannelMessage;
  readonly limit?: number;
}): readonly ChannelMessage[] {
  const recentMessages = listChannelContextMessages(input);
  const sourceIndex = recentMessages.findIndex((message) => message.id === input.sourceMessage.id);
  if (sourceIndex >= 0) {
    return recentMessages.slice(0, sourceIndex);
  }
  return recentMessages.filter((message) => message.id !== input.sourceMessage.id);
}

export function collectPriorConversationSources(input: {
  readonly store: ChannelContextConversationStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly limit?: number;
}): readonly ChannelContextSource[] {
  return collectRecentConversationSources({
    channelId: input.channel.id,
    messages: listPriorChannelContextMessages({
      store: input.store,
      channelId: input.channel.id,
      sourceMessage: input.sourceMessage,
      limit: input.limit,
    }),
    excludeMessageId: input.sourceMessage.id,
    limit: input.limit,
  });
}

export function collectSelectorConversationSources(input: {
  readonly store: ChannelContextConversationStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly limit?: number;
}): readonly ChannelContextSource[] {
  return collectRecentConversationSources({
    channelId: input.channel.id,
    messages: listChannelContextMessages({
      store: input.store,
      channelId: input.channel.id,
      sourceMessage: input.sourceMessage,
      limit: input.limit,
    }).filter((message) => message.id !== input.sourceMessage.id),
    excludeMessageId: input.sourceMessage.id,
    limit: input.limit,
  });
}

export function collectActiveWorkSources(input: {
  readonly store: ChannelContextActiveWorkStore;
  readonly channel: Channel;
  readonly limit?: number;
}): readonly ChannelContextSource[] {
  const limit = input.limit ?? 8;
  const proposals = input.store
    .listChannelExecutionProposals({ channelId: input.channel.id, limit: 50 })
    .filter((proposal) => proposal.status === "draft" || proposal.status === "blocked")
    .slice(-limit);
  const workflows = input.store
    .listChannelWorkflows({ channelId: input.channel.id, limit: 50 })
    .filter((workflow) => ["draft", "ready", "running", "waiting_for_approval", "blocked", "failed"].includes(workflow.status))
    .slice(0, limit);
  const workflowSteps = workflows.flatMap((workflow) =>
    input.store
      .listChannelWorkflowSteps({ workflowId: workflow.id, limit: 100 })
      .filter((step) => ["queued", "claimed", "waiting_for_approval", "running", "blocked", "failed"].includes(step.status))
      .slice(0, 8),
  );
  const runs = input.store
    .listRuns({ limit: 200 })
    .filter((run) => run.channelId === input.channel.id)
    .filter((run) => ["queued", "running", "waiting_for_approval", "failed"].includes(run.status))
    .slice(0, limit);
  const approvals = [
    ...runs.flatMap((run) => input.store.listApprovalRequests({ runId: run.id, status: "pending", limit: 20 })),
    ...workflowSteps.flatMap((step) => input.store.listApprovalRequests({ workflowStepId: step.id, status: "pending", limit: 20 })),
  ].slice(0, limit);

  const sources: ChannelContextSource[] = [];
  for (const proposal of proposals) {
    sources.push({
      id: `active_work:proposal:${proposal.id}`,
      kind: "active_work",
      workspaceId: proposal.workspaceId,
      channelId: input.channel.id,
      teammateId: proposal.assigneeTeammateId,
      sourceRefs: [
        { type: "channel", id: input.channel.id, label: input.channel.name },
        { type: "proposal", id: proposal.id, label: proposal.title },
        { type: "message", id: proposal.sourceMessageId, label: "Proposal source message" },
      ],
      title: proposal.title,
      text: proposal.prompt,
      metadata: {
        entityType: "proposal",
        status: proposal.status,
        requiredTools: proposal.requiredTools,
        linkedWorkflowId: proposal.linkedWorkflowId,
      },
      sensitivity: "normal",
      freshness: proposal.status === "draft" ? "current_turn" : "recent",
    });
  }
  for (const workflow of workflows) {
    sources.push({
      id: `active_work:workflow:${workflow.id}`,
      kind: "active_work",
      workspaceId: workflow.workspaceId,
      channelId: input.channel.id,
      sourceRefs: [
        { type: "channel", id: input.channel.id, label: input.channel.name },
        { type: "workflow", id: workflow.id, label: workflow.title },
      ],
      title: workflow.title,
      text: workflow.objective,
      metadata: {
        entityType: "workflow",
        status: workflow.status,
        sourceProposalId: workflow.metadata?.sourceProposalId,
        sourceMessageId: workflow.metadata?.sourceMessageId,
      },
      sensitivity: "normal",
      freshness: "recent",
    });
  }
  for (const step of workflowSteps) {
    sources.push({
      id: `active_work:workflow_step:${step.id}`,
      kind: "active_work",
      workspaceId: step.workspaceId,
      channelId: input.channel.id,
      teammateId: step.toParticipantId,
      sourceRefs: [
        { type: "workflow_step", id: step.id, label: step.title },
        ...(step.runId ? [{ type: "run", id: step.runId, label: "Workflow step run" }] : []),
      ],
      title: step.title,
      text: step.resultSummary ?? step.blocker ?? step.prompt,
      metadata: {
        entityType: "workflow_step",
        workflowId: step.workflowId,
        status: step.status,
        runId: step.runId,
        blocker: step.blocker,
      },
      sensitivity: "normal",
      freshness: "recent",
    });
  }
  for (const run of runs) {
    const title = runTitle(run.taskSnapshot) ?? run.taskId;
    sources.push({
      id: `active_work:run:${run.id}`,
      kind: "active_work",
      workspaceId: input.channel.workspaceId,
      channelId: input.channel.id,
      teammateId: run.teammateId,
      sourceRefs: [{ type: "run", id: run.id, label: title }],
      title,
      text: run.errorMessage,
      metadata: {
        entityType: "run",
        status: run.status,
        workflowStepId: run.workflowStepId,
        selectedSkillId: run.selectedSkillId,
      },
      sensitivity: "normal",
      freshness: "recent",
    });
  }
  for (const approval of approvals) {
    sources.push({
      id: `active_work:approval:${approval.id}`,
      kind: "active_work",
      workspaceId: input.channel.workspaceId,
      channelId: input.channel.id,
      sourceRefs: [
        { type: "approval", id: approval.id, label: approval.title },
        ...(approval.runId ? [{ type: "run", id: approval.runId, label: "Approval run" }] : []),
        ...(approval.workflowStepId ? [{ type: "workflow_step", id: approval.workflowStepId, label: "Approval workflow step" }] : []),
      ],
      title: approval.title,
      text: approval.description,
      metadata: {
        entityType: "approval",
        status: approval.status,
        actionType: approval.actionType,
        risk: approval.risk,
        runId: approval.runId,
        workflowStepId: approval.workflowStepId,
      },
      sensitivity: "normal",
      freshness: "current_turn",
    });
  }
  return sources;
}

export function collectWorkflowEvidenceSources(input: {
  readonly store: WorkflowEvidenceStore;
  readonly channel: Channel;
  readonly workflow?: ChannelWorkflow;
  readonly step?: ChannelWorkflowStep;
  readonly artifacts?: readonly RunArtifact[];
  readonly artifactIds?: readonly string[];
  readonly limit?: number;
}): readonly ChannelContextSource[] {
  const artifactIds = [
    ...(input.artifactIds ?? []),
    ...(input.step?.metadata?.contextArtifactId ? [input.step.metadata.contextArtifactId] : []),
    ...(input.step?.metadata?.outputArtifactId ? [input.step.metadata.outputArtifactId] : []),
    ...(input.step?.metadata?.outputArtifactIds ?? []),
    ...(input.step?.runId ? input.store.listArtifacts(input.step.runId).map((artifact) => artifact.id) : []),
    ...(input.artifacts ?? []).map((artifact) => artifact.id),
  ];
  const artifactMap = new Map<string, RunArtifact>();
  for (const artifact of input.artifacts ?? []) {
    artifactMap.set(artifact.id, artifact);
  }
  for (const artifactId of artifactIds) {
    const artifact = artifactMap.get(artifactId) ?? input.store.getArtifact(artifactId);
    if (artifact) {
      artifactMap.set(artifact.id, artifact);
    }
  }
  return [...artifactMap.values()]
    .slice(0, input.limit ?? 12)
    .map((artifact): ChannelContextSource => {
      const packetKind = workflowPacketKindForArtifact(input.step, artifact);
      const kind = evidenceKindForArtifact(packetKind);
      return {
        id: `${kind}:${artifact.id}`,
        kind,
        workspaceId: input.channel.workspaceId,
        channelId: input.channel.id,
        teammateId: input.step?.toParticipantId,
        sourceRefs: [
          { type: "artifact", id: artifact.id, label: artifact.title ?? artifact.path },
          ...(artifact.runId ? [{ type: "run", id: artifact.runId, label: "Artifact run" }] : []),
          ...(input.workflow ? [{ type: "workflow", id: input.workflow.id, label: input.workflow.title }] : []),
          ...(input.step ? [{ type: "workflow_step", id: input.step.id, label: input.step.title }] : []),
        ],
        title: artifact.title ?? artifact.path,
        text: summarizeArtifactEvidence({ artifact, packetKind }),
        metadata: {
          artifactId: artifact.id,
          artifactType: artifact.type,
          packetKind,
          path: artifact.path,
          contentType: artifact.contentType,
          sizeBytes: artifact.sizeBytes,
          runId: artifact.runId,
          mediaJobId: artifact.mediaJobId,
          externalWorkId: artifact.externalWorkId,
          createdAt: artifact.createdAt,
        },
        sensitivity: artifactEvidenceSensitivity(artifact),
        freshness: "durable",
      };
    });
}

export function collectWorkflowStepSource(input: {
  readonly channel: Channel;
  readonly workflow: ChannelWorkflow;
  readonly step: ChannelWorkflowStep;
}): ChannelContextSource {
  return {
    id: `workflow_step:${input.step.id}`,
    kind: "workflow_step",
    workspaceId: input.workflow.workspaceId,
    channelId: input.channel.id,
    teammateId: input.step.toParticipantId,
    sourceRefs: [
      { type: "channel", id: input.channel.id, label: input.channel.name },
      { type: "workflow", id: input.workflow.id, label: input.workflow.title },
      { type: "workflow_step", id: input.step.id, label: input.step.title },
    ],
    title: input.step.title,
    text: input.step.prompt,
    metadata: {
      workflowId: input.workflow.id,
      workflowStatus: input.workflow.status,
      stepStatus: input.step.status,
      runId: input.step.runId,
      contextSummaryId: input.step.contextSummaryId,
      dependsOnStepIds: input.step.metadata?.dependsOnStepIds ?? [],
    },
    sensitivity: "normal",
    freshness: "durable",
  };
}

function countMaterializedTurnInputs(envelope: LingAgentTurnEnvelope): number {
  return [
    ...envelope.attachments.map((attachment) => attachment.materializationStatus),
    ...envelope.linkPreviews.map((preview) => preview.materializationStatus),
    ...envelope.fileRefs.map((fileRef) => fileRef.materializationStatus),
  ].filter((status) => status === "available").length;
}

function hasPromptContent(status: LingTurnMaterializationStatus, text: string | undefined): boolean {
  return status === "available" && Boolean(text?.trim());
}

function boundedPromptPreview(text: string | undefined, maxLength = 1_200): string | undefined {
  const normalized = text?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 44))}\n[truncated materialized input preview]`;
}

function uniqueSources(sources: readonly ChannelContextSource[]): readonly ChannelContextSource[] {
  const seen = new Set<string>();
  const unique: ChannelContextSource[] = [];
  for (const source of sources) {
    if (seen.has(source.id)) {
      continue;
    }
    seen.add(source.id);
    unique.push(source);
  }
  return unique;
}

function runTitle(taskSnapshot: unknown): string | undefined {
  if (!taskSnapshot || typeof taskSnapshot !== "object") {
    return undefined;
  }
  const title = (taskSnapshot as { readonly title?: unknown }).title;
  return typeof title === "string" && title.trim().length > 0 ? title : undefined;
}

function parseChannelMessageGuidanceIdempotencyKey(idempotencyKey: string): string | undefined {
  const prefix = "channel_message:";
  const suffix = ":queue_followup";
  if (!idempotencyKey.startsWith(prefix) || !idempotencyKey.endsWith(suffix)) {
    return undefined;
  }
  return idempotencyKey.slice(prefix.length, -suffix.length) || undefined;
}
