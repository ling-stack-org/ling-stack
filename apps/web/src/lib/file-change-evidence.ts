import { artifactLooksLikeDiff, parseUnifiedDiff, type ConversationFileChange, type ConversationFileChangeStatus } from "./diff-summary.js";
import type { ApprovalRequest, RunArtifact, RunSession } from "../types.js";

export function deriveFileChangeArtifacts(artifacts: readonly RunArtifact[]): readonly RunArtifact[] {
  return artifacts.filter(artifactLooksLikeDiff);
}

export function fileChangeStatusFromRun(run: RunSession): ConversationFileChangeStatus {
  if (run.status === "succeeded") {
    return "completed";
  }
  if (run.status === "failed") {
    return "failed";
  }
  if (run.status === "cancelled") {
    return "declined";
  }
  return "in_progress";
}

export function fileChangeStatusFromApproval(approval: ApprovalRequest): ConversationFileChangeStatus {
  if (approval.status === "approved") {
    return "completed";
  }
  if (approval.status === "denied" || approval.status === "expired") {
    return "declined";
  }
  return "in_progress";
}

export function parseFileChangeArtifact(input: {
  readonly artifact: RunArtifact;
  readonly diff: string;
  readonly status: ConversationFileChangeStatus;
  readonly sourceRunId?: string;
  readonly approvalId?: string;
}): readonly ConversationFileChange[] {
  return parseUnifiedDiff(input.diff, {
    idPrefix: input.artifact.id,
    fallbackPath: input.artifact.title || input.artifact.path,
    status: input.status,
    sourceRunId: input.sourceRunId,
    approvalId: input.approvalId,
    artifactId: input.artifact.id,
  });
}
