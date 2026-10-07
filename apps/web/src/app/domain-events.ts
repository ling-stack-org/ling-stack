import type { SidebarTarget, ViewId } from "./view-types.js";

export type DomainEvent =
  | { readonly type: "workspace.cwdChanged"; readonly cwd: string }
  | { readonly type: "view.openRequested"; readonly view: ViewId; readonly target?: SidebarTarget }
  | { readonly type: "run.started"; readonly runId: string; readonly channelId?: string; readonly taskId?: string }
  | { readonly type: "run.completed"; readonly runId: string; readonly channelId?: string; readonly taskId?: string }
  | { readonly type: "run.cancelled"; readonly runId: string; readonly channelId?: string; readonly taskId?: string }
  | { readonly type: "run.selected"; readonly runId: string }
  | { readonly type: "approval.resolved"; readonly approvalId: string; readonly runId?: string; readonly mediaJobId?: string; readonly externalWorkActionId?: string; readonly reconciliationPending?: boolean }
  | { readonly type: "approval.policyUpdated" }
  | { readonly type: "provider.repairRequested"; readonly providerPresetId?: string; readonly sourceRunId?: string }
  | { readonly type: "task.repairRequested"; readonly taskId: string; readonly sourceRunId?: string }
  | { readonly type: "workflow.created"; readonly workflowId: string; readonly channelId: string }
  | { readonly type: "workflow.advanced"; readonly workflowId: string; readonly channelId: string; readonly runId?: string }
  | { readonly type: "workflow.cancelled"; readonly workflowId: string; readonly channelId: string; readonly runIds: readonly string[] }
  | { readonly type: "workflowStep.retried"; readonly workflowId: string; readonly workflowStepId: string; readonly channelId: string; readonly runId?: string }
  | { readonly type: "workflowStep.updated"; readonly workflowId: string; readonly workflowStepId: string; readonly channelId: string }
  | { readonly type: "channel.messageSent"; readonly channelId: string }
  | { readonly type: "channel.filesChanged"; readonly channelId: string }
  | { readonly type: "teammate.updated"; readonly teammateId: string }
  | { readonly type: "mediaJob.started"; readonly mediaJobId: string }
  | { readonly type: "mediaJob.completed"; readonly mediaJobId: string }
  | { readonly type: "mcp.changed"; readonly serverId?: string }
  | { readonly type: "externalWork.changed"; readonly channelId?: string };

export type EmitDomainEvent = (event: DomainEvent) => void;
