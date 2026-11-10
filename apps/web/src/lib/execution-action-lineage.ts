import type { ConversationOperationSourceRef } from "@ling-stack/conversation-ui-core";
import type { ExecutionAction, RunArtifact } from "../types.js";

/**
 * Builds the canonical UI-to-execution references for one action.
 *
 * Approval identity is deliberately included here even though approval-linked
 * actions are not eligible for activity batching. The reference is part of the
 * evidence lineage and must remain available for exact SQLite traceability.
 */
export function executionActionSourceRefs(
  action: ExecutionAction,
  workflowStepId: string | undefined,
  artifactsById: ReadonlyMap<string, RunArtifact> = new Map(),
): readonly ConversationOperationSourceRef[] {
  const durableRefs = Array.isArray(action.sourceRefs)
    ? action.sourceRefs
      .filter((ref): ref is NonNullable<ExecutionAction["sourceRefs"]>[number] => Boolean(
        ref && typeof ref.kind === "string" && typeof ref.id === "string" && ref.id.trim(),
      ))
      .map((ref) => ({
        kind: ref.kind,
        id: ref.id,
        ...(ref.label ? { label: ref.label } : {}),
        ...(ref.path ? { path: ref.path } : {}),
        ...(ref.hostTarget ? { hostTarget: ref.hostTarget } : {}),
        ...(ref.capabilityId ? { capabilityId: ref.capabilityId } : {}),
        ...(ref.workspaceId ? { workspaceId: ref.workspaceId } : {}),
        ...(ref.visibility ? { visibility: ref.visibility } : {}),
      }))
    : [];
  const artifactRefs = [...action.previewArtifactIds, ...action.resultArtifactIds]
    .filter((artifactId) => artifactId.trim())
    .map((artifactId): ConversationOperationSourceRef => {
      const artifact = artifactsById.get(artifactId);
      const diff = artifact?.type === "diff" || artifact?.contentType?.includes("diff") === true;
      return {
        kind: diff ? "diff" : "artifact",
        id: artifactId,
        ...(artifact?.title || artifact?.path ? { label: artifact.title ?? artifact.path } : {}),
        ...(artifact?.path ? { path: artifact.path } : {}),
        hostTarget: diff ? "open_diff" : "open_artifact",
        workspaceId: action.workspaceId,
      };
    });
  const refs: ConversationOperationSourceRef[] = [
    ...artifactRefs,
    ...durableRefs,
    { kind: "execution_action", id: action.id },
  ];
  if (action.runId) {
    refs.push({ kind: "run", id: action.runId });
  }
  if (action.workUnitId) {
    refs.push({ kind: "work_unit", id: action.workUnitId });
  }
  if (action.attemptId) {
    refs.push({ kind: "attempt", id: action.attemptId });
  }
  if (action.approvalId) {
    refs.push({ kind: "approval", id: action.approvalId });
  }
  if (action.toolCallId) {
    refs.push({ kind: "tool_call", id: action.toolCallId });
  }
  if (workflowStepId) {
    refs.push({ kind: "workflow_step", id: workflowStepId });
  }
  for (const target of action.targetRefs) {
    const id = target.path ?? target.id ?? target.label;
    if (!id || target.type === "run" || target.type === "work_unit" || target.type === "workflow_step") {
      continue;
    }
    refs.push({
      kind: target.type,
      id,
      label: target.label ?? target.path,
      ...(target.type === "file" && target.path ? { path: target.path } : {}),
      ...(target.type === "file" && target.path ? { hostTarget: "open_file" as const, workspaceId: action.workspaceId } : {}),
    });
  }
  return uniqueSourceRefs(refs);
}

function uniqueSourceRefs(refs: readonly ConversationOperationSourceRef[]): readonly ConversationOperationSourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
