import type { SQLOutputValue } from "node:sqlite";
import {
  createMemoryReviewActionId,
  createMemoryReviewDecisionId,
  type ApplyMemoryReviewActionInput,
  type CreateMemoryReviewDecisionInput,
  type ListMemoryObjectsOptions,
  type ListMemoryPromotionInboxOptions,
  type MemoryObject,
  type MemoryObjectUpdateInput,
  type MemoryPromotionInboxItem,
  type MemoryReviewAction,
  type MemoryReviewActionRecord,
  type MemoryReviewDecision,
  type MemoryReviewMode,
  type MemoryReviewOutcome,
  type MemoryReviewPolicy,
  type MemoryReviewPolicyUpdateInput,
  type MemoryReviewState,
  type MemorySensitivity,
  type MemorySourceRef,
} from "../../memory-types.js";
import { createDefaultMemoryReviewPolicy } from "../../memory-review-policy.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { stringifyJson } from "./helpers.js";
import {
  ensureMemorySourceRefs,
  mapMemoryReviewDecision,
  mapMemoryReviewPolicy,
  normalizeMemorySourceRefs,
} from "./memory-mappers.js";
import { memoryReviewDecisionSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteMemoryReviewStorePorts {
  readonly getMemoryObject: (id: string) => MemoryObject | undefined;
  readonly listMemoryObjects: (options?: ListMemoryObjectsOptions) => MemoryObject[];
  readonly updateMemoryObject: (id: string, input: MemoryObjectUpdateInput, now: string) => MemoryObject | undefined;
}

export class SqliteMemoryReviewStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteMemoryReviewStorePorts,
  ) {}

  getMemoryReviewPolicy(workspaceId = DEFAULT_WORKSPACE_ID): MemoryReviewPolicy {
    const row = this.context.database
      .prepare(`
        SELECT
          workspace_id,
          mode,
          auto_active_same_scope,
          auto_active_user_explicit,
          require_manual_for_workspace,
          require_manual_for_persona,
          require_manual_for_cross_scope,
          quarantine_secret_adjacent,
          updated_at
        FROM memory_review_policy
        WHERE workspace_id = ?
      `)
      .get(workspaceId);
    return row ? mapMemoryReviewPolicy(row as Record<string, SQLOutputValue>) : createDefaultMemoryReviewPolicy(workspaceId);
  }

  updateMemoryReviewPolicy(input: MemoryReviewPolicyUpdateInput, now: string): MemoryReviewPolicy {
    const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
    const existing = this.getMemoryReviewPolicy(workspaceId);
    const next: MemoryReviewPolicy = {
      workspaceId,
      mode: input.mode ?? existing.mode,
      autoActiveSameScope: input.autoActiveSameScope ?? existing.autoActiveSameScope,
      autoActiveUserExplicit: input.autoActiveUserExplicit ?? existing.autoActiveUserExplicit,
      requireManualForWorkspace: input.requireManualForWorkspace ?? existing.requireManualForWorkspace,
      requireManualForPersona: input.requireManualForPersona ?? existing.requireManualForPersona,
      requireManualForCrossScope: input.requireManualForCrossScope ?? existing.requireManualForCrossScope,
      quarantineSecretAdjacent: input.quarantineSecretAdjacent ?? existing.quarantineSecretAdjacent,
      updatedAt: now,
    };
    validateMemoryReviewPolicy(next);
    this.context.database
      .prepare(`
        INSERT INTO memory_review_policy (
          workspace_id,
          mode,
          auto_active_same_scope,
          auto_active_user_explicit,
          require_manual_for_workspace,
          require_manual_for_persona,
          require_manual_for_cross_scope,
          quarantine_secret_adjacent,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          mode = excluded.mode,
          auto_active_same_scope = excluded.auto_active_same_scope,
          auto_active_user_explicit = excluded.auto_active_user_explicit,
          require_manual_for_workspace = excluded.require_manual_for_workspace,
          require_manual_for_persona = excluded.require_manual_for_persona,
          require_manual_for_cross_scope = excluded.require_manual_for_cross_scope,
          quarantine_secret_adjacent = excluded.quarantine_secret_adjacent,
          updated_at = excluded.updated_at
      `)
      .run(
        next.workspaceId,
        next.mode,
        next.autoActiveSameScope ? 1 : 0,
        next.autoActiveUserExplicit ? 1 : 0,
        next.requireManualForWorkspace ? 1 : 0,
        next.requireManualForPersona ? 1 : 0,
        next.requireManualForCrossScope ? 1 : 0,
        next.quarantineSecretAdjacent ? 1 : 0,
        next.updatedAt,
      );
    return this.getMemoryReviewPolicy(workspaceId);
  }

  recordMemoryReviewDecision(input: CreateMemoryReviewDecisionInput, now: string): MemoryReviewDecision {
    const memory = this.ports.getMemoryObject(input.memoryId);
    if (!memory) {
      throw new Error(`Memory object not found: ${input.memoryId}`);
    }
    const decision: MemoryReviewDecision = {
      id: input.id ?? createMemoryReviewDecisionId(),
      workspaceId: input.workspaceId ?? memory.workspaceId,
      memoryId: input.memoryId,
      outcome: input.outcome,
      mode: input.mode,
      reasonCode: input.reasonCode,
      reason: input.reason,
      confidence: input.confidence,
      requiresManualReview: input.requiresManualReview,
      quarantineReason: input.quarantineReason,
      targetReviewState: input.targetReviewState,
      targetSensitivity: input.targetSensitivity,
      sourceRefs: ensureMemorySourceRefs(input.memoryId, normalizeMemorySourceRefs(input.sourceRefs ?? memory.sourceRefs)),
      decidedBy: input.decidedBy,
      createdAt: now,
    };
    validateMemoryReviewDecision(decision);
    this.context.database
      .prepare(`
        INSERT INTO memory_review_decisions (
          id,
          workspace_id,
          memory_id,
          outcome,
          mode,
          reason_code,
          reason,
          confidence,
          requires_manual_review,
          quarantine_reason,
          target_review_state,
          target_sensitivity,
          source_refs_json,
          decided_by,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        decision.id,
        decision.workspaceId,
        decision.memoryId,
        decision.outcome,
        decision.mode,
        decision.reasonCode,
        decision.reason,
        decision.confidence,
        decision.requiresManualReview ? 1 : 0,
        decision.quarantineReason ?? null,
        decision.targetReviewState,
        decision.targetSensitivity,
        stringifyJson(decision.sourceRefs),
        decision.decidedBy,
        decision.createdAt,
      );
    return decision;
  }

  getLatestMemoryReviewDecision(memoryId: string): MemoryReviewDecision | undefined {
    const row = this.context.database
      .prepare(memoryReviewDecisionSelectSql("WHERE memory_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"))
      .get(memoryId);
    return row ? mapMemoryReviewDecision(row as Record<string, SQLOutputValue>) : undefined;
  }

  listMemoryPromotionInbox(options: ListMemoryPromotionInboxOptions = {}): MemoryPromotionInboxItem[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const candidates = [
      ...this.ports.listMemoryObjects({ workspaceId: options.workspaceId, scopeType: options.scopeType, ownerId: options.ownerId, sensitivity: options.sensitivity, reviewState: "candidate", limit: 500 }),
      ...this.ports.listMemoryObjects({ workspaceId: options.workspaceId, scopeType: options.scopeType, ownerId: options.ownerId, sensitivity: options.sensitivity, reviewState: "disabled", limit: 500 }),
    ];
    const seen = new Set<string>();
    const items: MemoryPromotionInboxItem[] = [];
    for (const memory of candidates) {
      if (seen.has(memory.id)) {
        continue;
      }
      seen.add(memory.id);
      const decision = this.getLatestMemoryReviewDecision(memory.id);
      if (
        memory.reviewState === "disabled" &&
        (!decision || (decision.outcome !== "manual-review" && decision.outcome !== "quarantine"))
      ) {
        continue;
      }
      items.push({
        memory,
        decision,
        sourceSummary: summarizeMemorySourceRefs(memory.sourceRefs),
        recommendedAction: recommendMemoryReviewAction(memory, decision),
      });
      if (items.length >= limit) {
        break;
      }
    }
    return items;
  }

  applyMemoryReviewAction(input: ApplyMemoryReviewActionInput, now: string): { readonly memory: MemoryObject; readonly action: MemoryReviewActionRecord } {
    const existing = this.ports.getMemoryObject(input.memoryId);
    if (!existing) {
      throw new Error(`Memory object not found: ${input.memoryId}`);
    }
    const workspaceId = input.workspaceId ?? existing.workspaceId;
    if (workspaceId !== existing.workspaceId) {
      throw new Error("Memory review workspace does not match memory object");
    }
    const update = memoryUpdateForReviewAction(input, existing);
    const updated = this.ports.updateMemoryObject(input.memoryId, update, now);
    if (!updated) {
      throw new Error(`Failed to update memory object: ${input.memoryId}`);
    }
    const action: MemoryReviewActionRecord = {
      id: createMemoryReviewActionId(),
      workspaceId,
      memoryId: input.memoryId,
      action: input.action,
      previousReviewState: existing.reviewState,
      nextReviewState: updated.reviewState,
      sourceRefs: updated.sourceRefs,
      editedMemory: input.editedMemory,
      reason: input.reason,
      actor: input.actor,
      createdAt: now,
    };
    validateMemoryReviewActionRecord(action);
    this.context.database
      .prepare(`
        INSERT INTO memory_review_actions (
          id,
          workspace_id,
          memory_id,
          action,
          previous_review_state,
          next_review_state,
          source_refs_json,
          edited_memory_json,
          reason,
          actor,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        action.id,
        action.workspaceId,
        action.memoryId,
        action.action,
        action.previousReviewState,
        action.nextReviewState,
        stringifyJson(action.sourceRefs),
        action.editedMemory ? stringifyJson(action.editedMemory) : null,
        action.reason ?? null,
        action.actor,
        action.createdAt,
      );
    return { memory: updated, action };
  }
}

function validateMemoryReviewPolicy(policy: MemoryReviewPolicy): void {
  if (!policy.workspaceId.trim()) {
    throw new Error("workspaceId must be a non-empty string");
  }
  if (!isMemoryReviewMode(policy.mode)) {
    throw new Error("memory review mode is not supported");
  }
}

function validateMemoryReviewDecision(decision: MemoryReviewDecision): void {
  if (!decision.memoryId.trim()) {
    throw new Error("memoryId must be a non-empty string");
  }
  if (!isMemoryReviewOutcome(decision.outcome)) {
    throw new Error("memory review outcome is not supported");
  }
  if (!isMemoryReviewMode(decision.mode)) {
    throw new Error("memory review mode is not supported");
  }
  if (!isMemoryReviewState(decision.targetReviewState)) {
    throw new Error("targetReviewState is not supported");
  }
  if (!isMemorySensitivity(decision.targetSensitivity)) {
    throw new Error("targetSensitivity is not supported");
  }
  if (decision.confidence !== "low" && decision.confidence !== "medium" && decision.confidence !== "high") {
    throw new Error("memory review confidence is not supported");
  }
  if (decision.decidedBy !== "policy" && decision.decidedBy !== "local-user" && decision.decidedBy !== "system") {
    throw new Error("memory review decision actor is not supported");
  }
}

function validateMemoryReviewActionRecord(action: MemoryReviewActionRecord): void {
  if (!isMemoryReviewAction(action.action)) {
    throw new Error("memory review action is not supported");
  }
  if (!isMemoryReviewState(action.previousReviewState) || !isMemoryReviewState(action.nextReviewState)) {
    throw new Error("memory review action state is not supported");
  }
  if (action.actor !== "local-user" && action.actor !== "system") {
    throw new Error("memory review action actor is not supported");
  }
}

function isMemoryReviewMode(value: unknown): value is MemoryReviewMode {
  return value === "conservative" || value === "balanced" || value === "fast";
}

function isMemoryReviewOutcome(value: unknown): value is MemoryReviewOutcome {
  return value === "auto-active" || value === "auto-candidate" || value === "manual-review" || value === "quarantine";
}

function isMemoryReviewAction(value: unknown): value is MemoryReviewAction {
  return value === "approve" || value === "edit_and_approve" || value === "keep_candidate" || value === "reject" || value === "archive" || value === "quarantine";
}

function isMemoryReviewState(value: unknown): value is MemoryReviewState {
  return value === "candidate" || value === "active" || value === "disabled" || value === "archived" || value === "rejected";
}

function isMemorySensitivity(value: unknown): value is MemorySensitivity {
  return value === "normal" || value === "private" || value === "secret-adjacent";
}

function memoryUpdateForReviewAction(input: ApplyMemoryReviewActionInput, existing: MemoryObject): MemoryObjectUpdateInput {
  switch (input.action) {
    case "approve":
      return { reviewState: "active", enabled: true };
    case "edit_and_approve":
      return {
        ...(input.editedMemory ?? {}),
        reviewState: "active",
        enabled: true,
      };
    case "keep_candidate":
      return { reviewState: "candidate", enabled: true };
    case "reject":
      return { reviewState: "rejected", enabled: false };
    case "archive":
      return { reviewState: "archived", enabled: false };
    case "quarantine":
      return {
        reviewState: "disabled",
        enabled: false,
        sensitivity: input.editedMemory?.sensitivity ?? (existing.sensitivity === "secret-adjacent" ? "secret-adjacent" : existing.sensitivity),
      };
  }
}

function summarizeMemorySourceRefs(sourceRefs: readonly MemorySourceRef[]): string {
  if (sourceRefs.length === 0) {
    return "manual";
  }
  return sourceRefs.slice(0, 3).map((ref) => `${ref.type}:${ref.label ?? ref.id}`).join(", ");
}

function recommendMemoryReviewAction(memory: MemoryObject, decision: MemoryReviewDecision | undefined): MemoryReviewAction {
  if (decision?.outcome === "quarantine" || memory.sensitivity === "secret-adjacent") {
    return "quarantine";
  }
  if (decision?.outcome === "manual-review") {
    return "approve";
  }
  return memory.reviewState === "disabled" ? "archive" : "approve";
}
