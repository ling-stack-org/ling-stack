import type { ApprovalRequest } from "./approval-types.js";
import type {
  AuthorityLedgerEntry,
  ChannelTeamAuthorityLedgerProjection,
  ChannelTeamEvidenceSourceRef,
} from "./channel-team-types.js";
import type { ResourceLease } from "./channel-runtime-types.js";
import type { RunSession } from "./run-types.js";
import type { ChannelMessage } from "./workspace-types.js";

export interface BuildChannelTeamAuthorityLedgerProjectionInput {
  readonly channelId: string;
  readonly now: string;
  readonly approvals?: readonly ApprovalRequest[];
  readonly runs?: readonly RunSession[];
  readonly resourceLeases?: readonly ResourceLease[];
  readonly messages?: readonly ChannelMessage[];
  readonly limit?: number;
}

export function buildChannelTeamAuthorityLedgerProjection(
  input: BuildChannelTeamAuthorityLedgerProjectionInput,
): ChannelTeamAuthorityLedgerProjection {
  const limit = clampLimit(input.limit ?? 100);
  const runsById = new Map((input.runs ?? []).map((run) => [run.id, run]));
  const entries = [
    ...buildRunEntries(input.channelId, input.runs ?? []),
    ...buildApprovalEntries(input.channelId, input.approvals ?? [], runsById),
    ...buildReplyEntries(input.channelId, input.messages ?? []),
    ...buildResourceLeaseEntries(input.channelId, input.resourceLeases ?? [], runsById),
  ]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    .slice(0, limit);

  return {
    channelId: input.channelId,
    generatedAt: input.now,
    entries,
    note: "Authority Ledger is a read-only projection of existing channel facts. It does not grant permissions, approve actions, promote memory, or change routing.",
  };
}

function buildRunEntries(channelId: string, runs: readonly RunSession[]): AuthorityLedgerEntry[] {
  return runs
    .filter((run) => run.channelId === channelId)
    .map((run) => ({
      id: `run:${run.id}`,
      channelId,
      agentId: run.teammateId,
      authority: "run",
      scope: compactScope(["run", run.taskId, run.workflowStepId]),
      status: runStatusToAuthorityStatus(run.status),
      sourceRefs: [
        { type: "run", id: run.id, label: "Run" },
        { type: "task", id: run.taskId, label: "Task" },
        ...(run.workflowStepId ? [{ type: "workflow_step", id: run.workflowStepId, label: "Workflow step" } satisfies ChannelTeamEvidenceSourceRef] : []),
      ],
      createdAt: run.createdAt,
    }));
}

function buildApprovalEntries(
  channelId: string,
  approvals: readonly ApprovalRequest[],
  runsById: ReadonlyMap<string, RunSession>,
): AuthorityLedgerEntry[] {
  return approvals
    .filter((approval) => {
      const run = approval.runId ? runsById.get(approval.runId) : undefined;
      return approval.channelId === channelId || run?.channelId === channelId;
    })
    .map((approval) => {
      const run = approval.runId ? runsById.get(approval.runId) : undefined;
      return {
        id: `approval:${approval.id}`,
        channelId,
        agentId: run?.teammateId,
        authority: "approval",
        scope: compactScope(["approval", approval.actionType, approval.risk, approval.title]),
        status: approvalStatusToAuthorityStatus(approval.status),
        sourceRefs: [
          { type: "approval", id: approval.id, label: "Approval" },
          ...(approval.runId ? [{ type: "run", id: approval.runId, label: "Approval run" } satisfies ChannelTeamEvidenceSourceRef] : []),
          ...(approval.taskId ? [{ type: "task", id: approval.taskId, label: "Approval task" } satisfies ChannelTeamEvidenceSourceRef] : []),
          ...(approval.workflowStepId ? [{ type: "workflow_step", id: approval.workflowStepId, label: "Approval workflow step" } satisfies ChannelTeamEvidenceSourceRef] : []),
        ],
        createdAt: approval.createdAt,
        expiresAt: approval.expiresAt,
      } satisfies AuthorityLedgerEntry;
    });
}

function buildReplyEntries(channelId: string, messages: readonly ChannelMessage[]): AuthorityLedgerEntry[] {
  return messages
    .filter((message) => message.channelId === channelId && message.kind === "ai_reply" && message.authorType === "ai-teammate")
    .map((message) => ({
      id: `reply:${message.id}`,
      channelId,
      turnId: message.threadId ?? message.id,
      agentId: message.authorId,
      authority: "reply",
      scope: compactScope(["reply", message.intent, message.threadId ?? "channel"]),
      status: messageStatusToAuthorityStatus(message.status),
      sourceRefs: [
        { type: "message", id: message.id, label: "AI reply" },
        ...(message.threadId ? [{ type: "message", id: message.threadId, label: "Reply source" } satisfies ChannelTeamEvidenceSourceRef] : []),
      ],
      createdAt: message.createdAt,
    }));
}

function buildResourceLeaseEntries(
  channelId: string,
  leases: readonly ResourceLease[],
  runsById: ReadonlyMap<string, RunSession>,
): AuthorityLedgerEntry[] {
  return leases
    .filter((lease) => leaseBelongsToChannel(lease, channelId, runsById))
    .map((lease) => {
      const ownerRun = lease.ownerType === "run" ? runsById.get(lease.ownerId) : undefined;
      return {
        id: `lease:${lease.id}`,
        channelId,
        agentId: ownerRun?.teammateId,
        authority: "read",
        scope: compactScope(["read", lease.resourceType, lease.resourceKey]),
        status: leaseStatusToAuthorityStatus(lease.status),
        sourceRefs: [
          { type: "external", id: `resource_lease:${lease.id}`, label: "Resource lease" },
          ...(ownerRun ? [{ type: "run", id: ownerRun.id, label: "Lease owner run" } satisfies ChannelTeamEvidenceSourceRef] : []),
        ],
        createdAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
      } satisfies AuthorityLedgerEntry;
    });
}

function leaseBelongsToChannel(
  lease: ResourceLease,
  channelId: string,
  runsById: ReadonlyMap<string, RunSession>,
): boolean {
  if (lease.resourceType === "channel" && lease.resourceKey === channelId) {
    return true;
  }
  if (lease.ownerType === "run") {
    return runsById.get(lease.ownerId)?.channelId === channelId;
  }
  return false;
}

function approvalStatusToAuthorityStatus(status: ApprovalRequest["status"]): AuthorityLedgerEntry["status"] {
  switch (status) {
    case "pending":
      return "requested";
    case "approved":
      return "granted";
    case "denied":
      return "denied";
    case "expired":
      return "expired";
    case "cancelled":
      return "revoked";
  }
}

function runStatusToAuthorityStatus(status: RunSession["status"]): AuthorityLedgerEntry["status"] {
  switch (status) {
    case "queued":
      return "requested";
    case "cancelled":
      return "revoked";
    case "running":
    case "waiting_for_approval":
    case "succeeded":
    case "failed":
      return "granted";
  }
}

function messageStatusToAuthorityStatus(status: ChannelMessage["status"]): AuthorityLedgerEntry["status"] {
  switch (status) {
    case "pending":
      return "requested";
    case "ready":
      return "granted";
    case "blocked":
      return "denied";
    case "failed":
      return "revoked";
  }
}

function leaseStatusToAuthorityStatus(status: ResourceLease["status"]): AuthorityLedgerEntry["status"] {
  switch (status) {
    case "active":
      return "granted";
    case "expired":
      return "expired";
    case "released":
      return "revoked";
  }
}

function compactScope(parts: readonly (string | undefined)[]): string {
  return parts
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => part.replace(/\s+/gu, " ").trim())
    .join(":");
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 100;
  }
  return Math.min(Math.max(Math.trunc(value), 1), 500);
}
