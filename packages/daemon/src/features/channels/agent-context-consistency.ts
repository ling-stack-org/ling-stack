import { createHash } from "node:crypto";
import {
  isConversationContextProjectionMetadata,
  type ConversationContextProjectionMetadata,
} from "@ling-stack/contracts";
import type {
  RunStore,
  WorkflowAgentContextStamp,
  WorkflowFanInContextReview,
  WorkflowPacketSourceRef,
} from "@ling-stack/core";
import { buildConversationContextProjection } from "./context-processing/conversation-context-projector.js";

export function createWorkflowAgentContextStamp(input: {
  readonly store: RunStore;
  readonly sourceItemId: string;
  readonly contextProjection: ConversationContextProjectionMetadata;
  readonly consumerTeammateId?: string;
  readonly roleEvidenceRefs?: readonly WorkflowPacketSourceRef[];
}): WorkflowAgentContextStamp {
  const roleEvidenceRefs = uniqueWorkflowSourceRefs(input.roleEvidenceRefs ?? []);
  return {
    schemaVersion: 1,
    sourceItemId: input.sourceItemId,
    consumerTeammateId: input.consumerTeammateId,
    contextProjection: input.contextProjection,
    roleEvidenceRefs,
    roleEvidenceFingerprint: fingerprintRoleEvidence({
      store: input.store,
      consumerTeammateId: input.consumerTeammateId,
      roleEvidenceRefs,
    }),
  };
}

export function isWorkflowAgentContextStamp(value: unknown): value is WorkflowAgentContextStamp {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(record, [
      "schemaVersion",
      "sourceItemId",
      "consumerTeammateId",
      "contextProjection",
      "roleEvidenceRefs",
      "roleEvidenceFingerprint",
    ])
    ||
    record.schemaVersion !== 1
    || typeof record.sourceItemId !== "string"
    || record.sourceItemId.trim().length === 0
    || (record.consumerTeammateId !== undefined
      && (typeof record.consumerTeammateId !== "string" || record.consumerTeammateId.trim().length === 0))
    || !isConversationContextProjectionMetadata(record.contextProjection)
    || !Array.isArray(record.roleEvidenceRefs)
    || typeof record.roleEvidenceFingerprint !== "string"
    || record.roleEvidenceFingerprint.trim().length === 0
  ) {
    return false;
  }
  return record.roleEvidenceRefs.every((ref) => {
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) return false;
    const sourceRef = ref as Record<string, unknown>;
    return hasOnlyKeys(sourceRef, ["type", "id", "label"])
      && isWorkflowPacketSourceRefType(sourceRef.type)
      && typeof sourceRef.id === "string"
      && sourceRef.id.trim().length > 0
      && (sourceRef.label === undefined || typeof sourceRef.label === "string");
  });
}

function isWorkflowPacketSourceRefType(value: unknown): value is WorkflowPacketSourceRef["type"] {
  return value === "channel_message"
    || value === "channel_brief"
    || value === "channel_decision"
    || value === "context_summary"
    || value === "task"
    || value === "run"
    || value === "workflow"
    || value === "workflow_step"
    || value === "workflow_handoff_intent"
    || value === "workflow_selector_decision"
    || value === "artifact"
    || value === "approval"
    || value === "memory";
}

function hasOnlyKeys(record: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(record).every((key) => allowed.has(key));
}

export function reviewWorkflowAgentContextStamp(input: {
  readonly store: RunStore;
  readonly dependencyWorkflowStepId: string;
  readonly consumed: WorkflowAgentContextStamp;
}): {
  readonly review: WorkflowFanInContextReview;
  readonly current?: WorkflowAgentContextStamp;
} {
  try {
    const projection = buildConversationContextProjection({
      store: input.store,
      sourceItemId: input.consumed.sourceItemId,
      view: "workflow_step",
    });
    const current = createWorkflowAgentContextStamp({
      store: input.store,
      sourceItemId: input.consumed.sourceItemId,
      contextProjection: projection.metadata,
      consumerTeammateId: input.consumed.consumerTeammateId,
      roleEvidenceRefs: input.consumed.roleEvidenceRefs,
    });
    const consumedProjection = input.consumed.contextProjection;
    const currentProjection = current.contextProjection;
    if (
      consumedProjection.projectionVersion === currentProjection.projectionVersion
      && consumedProjection.sourceStateFingerprint === currentProjection.sourceStateFingerprint
      && sameProjectionIdentity(consumedProjection, currentProjection)
      && sameSourceRefs(consumedProjection.sourceRefs, currentProjection.sourceRefs)
      && input.consumed.roleEvidenceFingerprint === current.roleEvidenceFingerprint
    ) {
      return {
        current,
        review: {
          dependencyWorkflowStepId: input.dependencyWorkflowStepId,
          status: "accepted_current",
          consumedProjectionVersion: consumedProjection.projectionVersion,
          currentProjectionVersion: currentProjection.projectionVersion,
          reason: "The dependency consumed the current shared projection and role evidence.",
        },
      };
    }
    if (
      input.consumed.roleEvidenceFingerprint === current.roleEvidenceFingerprint
      && consumedProjection.sourceStateFingerprint === currentProjection.sourceStateFingerprint
      && sameProjectionIdentity(consumedProjection, currentProjection)
      && sameSourceRefs(consumedProjection.sourceRefs, currentProjection.sourceRefs)
    ) {
      return {
        current,
        review: {
          dependencyWorkflowStepId: input.dependencyWorkflowStepId,
          status: "rebased_metadata",
          consumedProjectionVersion: consumedProjection.projectionVersion,
          currentProjectionVersion: currentProjection.projectionVersion,
          reason: "Only projection metadata changed; all consumed facts and role evidence remain current.",
        },
      };
    }
    return {
      current,
      review: {
        dependencyWorkflowStepId: input.dependencyWorkflowStepId,
        status: "rejected_stale",
        consumedProjectionVersion: consumedProjection.projectionVersion,
        currentProjectionVersion: currentProjection.projectionVersion,
        reason: "The dependency consumed facts, visibility, or role evidence that no longer match the current projection.",
      },
    };
  } catch (error) {
    return {
      review: {
        dependencyWorkflowStepId: input.dependencyWorkflowStepId,
        status: "rejected_stale",
        consumedProjectionVersion: input.consumed.contextProjection.projectionVersion,
        reason: `The current projection could not be reconstructed safely: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

export function privateRoleEvidenceValues(input: {
  readonly store: RunStore;
  readonly stamp: WorkflowAgentContextStamp;
}): readonly string[] {
  const values: string[] = [];
  for (const ref of input.stamp.roleEvidenceRefs) {
    if (ref.type !== "memory") continue;
    const memory = input.store.getMemoryObject(ref.id);
    if (!memory || memory.sensitivity !== "private") continue;
    values.push(memory.title, memory.body);
  }
  return uniqueStrings(values.map(normalizeLeakText).filter((value) => value.length >= 12));
}

export function textContainsPrivateRoleEvidence(text: string | undefined, privateValues: readonly string[]): boolean {
  if (!text?.trim() || privateValues.length === 0) return false;
  const normalized = normalizeLeakText(text);
  return privateValues.some((value) => normalized.includes(value));
}

function fingerprintRoleEvidence(input: {
  readonly store: RunStore;
  readonly consumerTeammateId?: string;
  readonly roleEvidenceRefs: readonly WorkflowPacketSourceRef[];
}): string {
  const states = input.roleEvidenceRefs.map((ref) => {
    if (ref.type !== "memory") return [ref.type, ref.id];
    const memory = input.store.getMemoryObject(ref.id);
    if (!memory) return [ref.type, ref.id, "missing"];
    if (
      memory.sensitivity === "private"
      && (memory.scopeType !== "teammate" || memory.ownerId !== input.consumerTeammateId)
    ) {
      throw new Error(`Role evidence memory is private to another teammate: ${memory.id}`);
    }
    if (memory.sensitivity === "secret-adjacent") {
      throw new Error(`Role evidence memory is secret-adjacent: ${memory.id}`);
    }
    return [
      ref.type,
      ref.id,
      memory.scopeType,
      memory.ownerId,
      memory.sensitivity,
      memory.reviewState,
      memory.enabled,
      memory.title,
      memory.body,
      memory.tags,
      memory.sourceRefs,
      memory.verifyBeforeUse,
      memory.updatedAt,
    ];
  });
  return `role_${createHash("sha256").update(JSON.stringify(states)).digest("hex")}`;
}

function sameProjectionIdentity(
  left: WorkflowAgentContextStamp["contextProjection"],
  right: WorkflowAgentContextStamp["contextProjection"],
): boolean {
  return left.threadId === right.threadId
    && left.turnId === right.turnId
    && left.segmentId === right.segmentId
    && left.throughItemSequence === right.throughItemSequence
    && left.policyVersion === right.policyVersion
    && left.visibilityFingerprint === right.visibilityFingerprint
    && sameStrings(left.summaryIds, right.summaryIds);
}

function sameSourceRefs(
  left: WorkflowAgentContextStamp["contextProjection"]["sourceRefs"],
  right: WorkflowAgentContextStamp["contextProjection"]["sourceRefs"],
): boolean {
  return sameStrings(
    left.map((ref) => `${ref.type}:${ref.id}`).sort(),
    right.map((ref) => `${ref.type}:${ref.id}`).sort(),
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueWorkflowSourceRefs(refs: readonly WorkflowPacketSourceRef[]): readonly WorkflowPacketSourceRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeLeakText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
