import { randomUUID } from "node:crypto";
import type { RunArtifact } from "./run-types.js";
import type { ChannelWorkflow, ChannelWorkflowStep } from "./workspace-types.js";

export type ExternalSourceKind = "github" | "linear";

export type ExternalWorkItemKind = "github_pull_request" | "github_issue" | "linear_issue";

export interface ExternalWorkflowSourceConfig {
  readonly kind: ExternalSourceKind;
  readonly repository?: string;
  readonly projectSlug?: string;
  readonly events: readonly string[];
  readonly activeStates: readonly string[];
  readonly terminalStates: readonly string[];
  readonly secretRef?: string;
}

export interface ExternalWorkflowSchedulerConfig {
  readonly pollIntervalMs: number;
  readonly maxConcurrentWorkItems: number;
  readonly maxConcurrentByKind: Readonly<Record<string, number>>;
  readonly maxRetryBackoffMs: number;
  readonly staleRunTimeoutMs?: number;
  readonly reconcileOnStartup: boolean;
}

export type ExternalWorkspaceMode = "per_subject" | "per_attempt";

export interface ExternalWorkspaceConfig {
  readonly root?: string;
  readonly mode: ExternalWorkspaceMode;
  readonly cleanupTerminalWorkItems: boolean;
}

export interface ExternalWorkspaceHooks {
  readonly afterCreate?: string;
  readonly beforeRun?: string;
  readonly afterRun?: string;
  readonly beforeRemove?: string;
  readonly timeoutMs: number;
}

export interface ExternalWorkflowAgentConfig {
  readonly teammateId?: string;
  readonly requestedSkillId?: string;
  readonly maxTurns: number;
}

export interface ExternalWorkflowActionsConfig {
  readonly defaultExternalMutationApproval: "standard" | "strict";
}

export interface ExternalWorkflowConfig {
  readonly source: ExternalWorkflowSourceConfig;
  readonly scheduler: ExternalWorkflowSchedulerConfig;
  readonly workspace: ExternalWorkspaceConfig;
  readonly hooks: ExternalWorkspaceHooks;
  readonly agent: ExternalWorkflowAgentConfig;
  readonly actions: ExternalWorkflowActionsConfig;
}

export interface ExternalWorkflowDefinition {
  readonly config: ExternalWorkflowConfig;
  readonly promptTemplate: string;
}

export interface ExternalWorkRepositoryRef {
  readonly owner: string;
  readonly name: string;
  readonly fullName: string;
  readonly defaultBranch: string;
}

export interface ExternalWorkItemBlocker {
  readonly id?: string;
  readonly identifier?: string;
  readonly state?: string;
}

export interface ExternalWorkItem {
  readonly id: string;
  readonly sourceKind: ExternalSourceKind;
  readonly kind: ExternalWorkItemKind;
  readonly identifier: string;
  readonly title: string;
  readonly description?: string;
  readonly url?: string;
  readonly state: string;
  readonly priority?: number;
  readonly labels: readonly string[];
  readonly repository?: ExternalWorkRepositoryRef;
  readonly branchName?: string;
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly blockedBy?: readonly ExternalWorkItemBlocker[];
  readonly updatedAt?: string;
  readonly payloadRef: string;
  readonly idempotencyKey: string;
}

export interface ExternalWorkRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly sourceKind: ExternalSourceKind;
  readonly workItemKind: ExternalWorkItemKind;
  readonly externalId: string;
  readonly identifier: string;
  readonly idempotencyKey: string;
  readonly workflowId: string;
  readonly workflowStepId: string;
  readonly artifactIds: readonly string[];
  readonly item: ExternalWorkItem;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateExternalWorkWorkflowInput {
  readonly channelId: string;
  readonly externalWorkItem: ExternalWorkItem;
  readonly workflowDefinition: ExternalWorkflowDefinition;
  readonly renderedPrompt: string;
  readonly toParticipantId?: string;
  readonly toParticipantLabel?: string;
}

export interface ExternalWorkWorkflowResult {
  readonly externalWork: ExternalWorkRecord;
  readonly workflow: ChannelWorkflow;
  readonly workflowStep: ChannelWorkflowStep;
  readonly duplicate: boolean;
}

export interface ExternalWorkImportResponse {
  readonly externalWorkItem: ExternalWorkItem;
  readonly workflow: ChannelWorkflow;
  readonly workflowStep: ChannelWorkflowStep;
  readonly artifacts: readonly RunArtifact[];
  readonly duplicate: boolean;
}

export function createExternalWorkId(): string {
  return `external_work_${randomUUID()}`;
}
