import type { SQLOutputValue } from "node:sqlite";
import {
  createMemoryObjectId,
  type CreateMemoryObjectInput,
  type ListMemoryObjectsOptions,
  type ListMemorySelfImprovingMetadataOptions,
  type MemoryObject,
  type MemoryObjectUpdateInput,
  type MemoryReviewState,
  type MemoryScopeType,
  type MemorySelfImprovingKind,
  type MemorySelfImprovingMetadata,
  type MemorySensitivity,
  type UpsertMemorySelfImprovingMetadataInput,
} from "../../memory-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { nullableUpdate, stringifyJson } from "./helpers.js";
import {
  ensureMemorySourceRefs,
  mapMemoryObject,
  mapMemorySelfImprovingMetadata,
  normalizeMemorySourceRefs,
} from "./memory-mappers.js";
import { memoryObjectSelectSql, memorySelfImprovingMetadataSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteMemoryObjectStore {
  constructor(private readonly context: SqliteStoreContext) {}

  createMemoryObject(input: CreateMemoryObjectInput, now: string): MemoryObject {
    const id = input.id ?? createMemoryObjectId();
    const memory: MemoryObject = {
      id,
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      scopeType: input.scopeType,
      ownerId: input.ownerId,
      title: input.title,
      body: input.body,
      tags: normalizeStringList(input.tags ?? []),
      sourceRefs: ensureMemorySourceRefs(id, normalizeMemorySourceRefs(input.sourceRefs ?? [])),
      reviewState: input.reviewState ?? "active",
      enabled: input.enabled ?? true,
      sensitivity: input.sensitivity ?? "normal",
      verifyBeforeUse: input.verifyBeforeUse ?? false,
      retrievalProviderId: input.retrievalProviderId,
      retrievalHandle: input.retrievalHandle,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    validateMemoryObject(memory);

    this.context.database
      .prepare(`
        INSERT INTO memory_objects (
          id,
          workspace_id,
          scope_type,
          owner_id,
          title,
          body,
          tags_json,
          source_refs_json,
          review_state,
          enabled,
          sensitivity,
          verify_before_use,
          retrieval_provider_id,
          retrieval_handle,
          created_by,
          created_at,
          updated_at,
          last_used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        memory.id,
        memory.workspaceId,
        memory.scopeType,
        memory.ownerId,
        memory.title,
        memory.body,
        stringifyJson(memory.tags),
        stringifyJson(memory.sourceRefs),
        memory.reviewState,
        memory.enabled ? 1 : 0,
        memory.sensitivity,
        memory.verifyBeforeUse ? 1 : 0,
        memory.retrievalProviderId ?? null,
        memory.retrievalHandle ?? null,
        memory.createdBy ?? null,
        memory.createdAt,
        memory.updatedAt,
        memory.lastUsedAt ?? null,
      );

    const created = this.getMemoryObject(memory.id);
    if (!created) {
      throw new Error(`Failed to create memory object: ${memory.id}`);
    }
    return created;
  }

  getMemoryObject(id: string): MemoryObject | undefined {
    const row = this.context.database.prepare(memoryObjectSelectSql("WHERE id = ?")).get(id);
    return row ? mapMemoryObject(row as Record<string, SQLOutputValue>) : undefined;
  }

  listMemoryObjects(options: ListMemoryObjectsOptions = {}): MemoryObject[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    clauses.push("workspace_id = ?");
    params.push(options.workspaceId ?? DEFAULT_WORKSPACE_ID);
    if (options.scopeType) {
      clauses.push("scope_type = ?");
      params.push(options.scopeType);
    }
    if (options.ownerId) {
      clauses.push("owner_id = ?");
      params.push(options.ownerId);
    }
    if (options.reviewState) {
      clauses.push("review_state = ?");
      params.push(options.reviewState);
    }
    if (options.enabled !== undefined) {
      clauses.push("enabled = ?");
      params.push(options.enabled ? 1 : 0);
    }
    if (options.sensitivity) {
      clauses.push("sensitivity = ?");
      params.push(options.sensitivity);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    const memories = this.context.database
      .prepare(`${memoryObjectSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapMemoryObject(row as Record<string, SQLOutputValue>));
    if (!options.tag) {
      return memories;
    }
    const tag = options.tag.toLowerCase();
    return memories.filter((memory) => memory.tags.some((item) => item.toLowerCase() === tag));
  }

  updateMemoryObject(id: string, input: MemoryObjectUpdateInput, now: string): MemoryObject | undefined {
    const existing = this.getMemoryObject(id);
    if (!existing) {
      return undefined;
    }
    const next: MemoryObject = {
      ...existing,
      scopeType: input.scopeType ?? existing.scopeType,
      ownerId: input.ownerId ?? existing.ownerId,
      title: input.title ?? existing.title,
      body: input.body ?? existing.body,
      tags: input.tags ? normalizeStringList(input.tags) : existing.tags,
      sourceRefs: input.sourceRefs ? ensureMemorySourceRefs(existing.id, normalizeMemorySourceRefs(input.sourceRefs)) : existing.sourceRefs,
      reviewState: input.reviewState ?? existing.reviewState,
      enabled: input.enabled ?? existing.enabled,
      sensitivity: input.sensitivity ?? existing.sensitivity,
      verifyBeforeUse: input.verifyBeforeUse ?? existing.verifyBeforeUse,
      retrievalProviderId: nullableUpdate(input.retrievalProviderId, existing.retrievalProviderId),
      retrievalHandle: nullableUpdate(input.retrievalHandle, existing.retrievalHandle),
      createdBy: nullableUpdate(input.createdBy, existing.createdBy),
      lastUsedAt: nullableUpdate(input.lastUsedAt, existing.lastUsedAt),
      updatedAt: now,
    };
    validateMemoryObject(next);

    this.context.database
      .prepare(`
        UPDATE memory_objects
        SET
          scope_type = ?,
          owner_id = ?,
          title = ?,
          body = ?,
          tags_json = ?,
          source_refs_json = ?,
          review_state = ?,
          enabled = ?,
          sensitivity = ?,
          verify_before_use = ?,
          retrieval_provider_id = ?,
          retrieval_handle = ?,
          created_by = ?,
          updated_at = ?,
          last_used_at = ?
        WHERE id = ?
      `)
      .run(
        next.scopeType,
        next.ownerId,
        next.title,
        next.body,
        stringifyJson(next.tags),
        stringifyJson(next.sourceRefs),
        next.reviewState,
        next.enabled ? 1 : 0,
        next.sensitivity,
        next.verifyBeforeUse ? 1 : 0,
        next.retrievalProviderId ?? null,
        next.retrievalHandle ?? null,
        next.createdBy ?? null,
        next.updatedAt,
        next.lastUsedAt ?? null,
        id,
      );

    return this.getMemoryObject(id);
  }

  getMemorySelfImprovingMetadata(memoryId: string): MemorySelfImprovingMetadata | undefined {
    const row = this.context.database.prepare(memorySelfImprovingMetadataSelectSql("WHERE memory_id = ?")).get(memoryId);
    return row ? mapMemorySelfImprovingMetadata(row as Record<string, SQLOutputValue>) : undefined;
  }

  upsertMemorySelfImprovingMetadata(input: UpsertMemorySelfImprovingMetadataInput): MemorySelfImprovingMetadata {
    if (!this.getMemoryObject(input.memoryId)) {
      throw new Error(`Memory object not found: ${input.memoryId}`);
    }
    if (input.useWhen?.some((item) => !item.trim()) || input.doNotUseWhen?.some((item) => !item.trim())) {
      throw new Error("useWhen and doNotUseWhen entries must be non-empty strings");
    }
    const metadata: MemorySelfImprovingMetadata = {
      memoryId: input.memoryId,
      kind: input.kind,
      trigger: input.trigger,
      lesson: input.lesson,
      useWhen: normalizeStringList(input.useWhen ?? []),
      doNotUseWhen: normalizeStringList(input.doNotUseWhen ?? []),
      validUntil: nullableUpdate(input.validUntil, undefined),
      lastSeenAt: nullableUpdate(input.lastSeenAt, undefined),
      evidenceCount: input.evidenceCount ?? 0,
      supersededBy: nullableUpdate(input.supersededBy, undefined),
      lastUsedAt: nullableUpdate(input.lastUsedAt, undefined),
      useCount: input.useCount ?? 0,
    };
    validateMemorySelfImprovingMetadata(metadata);
    this.context.database
      .prepare(`
        INSERT INTO memory_self_improving_metadata (
          memory_id,
          kind,
          trigger,
          lesson,
          use_when_json,
          do_not_use_when_json,
          valid_until,
          last_seen_at,
          evidence_count,
          superseded_by,
          last_used_at,
          use_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET
          kind = excluded.kind,
          trigger = excluded.trigger,
          lesson = excluded.lesson,
          use_when_json = excluded.use_when_json,
          do_not_use_when_json = excluded.do_not_use_when_json,
          valid_until = excluded.valid_until,
          last_seen_at = excluded.last_seen_at,
          evidence_count = excluded.evidence_count,
          superseded_by = excluded.superseded_by,
          last_used_at = excluded.last_used_at,
          use_count = excluded.use_count
      `)
      .run(
        metadata.memoryId,
        metadata.kind,
        metadata.trigger,
        metadata.lesson,
        stringifyJson(metadata.useWhen),
        stringifyJson(metadata.doNotUseWhen),
        metadata.validUntil ?? null,
        metadata.lastSeenAt ?? null,
        metadata.evidenceCount,
        metadata.supersededBy ?? null,
        metadata.lastUsedAt ?? null,
        metadata.useCount,
      );
    const stored = this.getMemorySelfImprovingMetadata(input.memoryId);
    if (!stored) {
      throw new Error(`Failed to upsert memory self-improving metadata: ${input.memoryId}`);
    }
    return stored;
  }

  listMemorySelfImprovingMetadata(options: ListMemorySelfImprovingMetadataOptions = {}): MemorySelfImprovingMetadata[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.workspaceId) {
      clauses.push("memory_id IN (SELECT id FROM memory_objects WHERE workspace_id = ?)");
      params.push(options.workspaceId);
    }
    if (options.memoryId) {
      clauses.push("memory_id = ?");
      params.push(options.memoryId);
    }
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000);
    params.push(limit);
    return this.context.database
      .prepare(`${memorySelfImprovingMetadataSelectSql(whereClause)} ORDER BY memory_id ASC LIMIT ?`)
      .all(...params)
      .map((row) => mapMemorySelfImprovingMetadata(row as Record<string, SQLOutputValue>));
  }
}

function validateMemoryObject(memory: MemoryObject): void {
  if (!isMemoryScopeType(memory.scopeType)) {
    throw new Error("scopeType is not supported");
  }
  if (!memory.ownerId.trim()) {
    throw new Error("ownerId must be a non-empty string");
  }
  if (!memory.title.trim()) {
    throw new Error("title must be a non-empty string");
  }
  if (!memory.body.trim()) {
    throw new Error("body must be a non-empty string");
  }
  if (!isMemoryReviewState(memory.reviewState)) {
    throw new Error("reviewState is not supported");
  }
  if (!isMemorySensitivity(memory.sensitivity)) {
    throw new Error("sensitivity is not supported");
  }
}

function validateMemorySelfImprovingMetadata(metadata: MemorySelfImprovingMetadata): void {
  if (!metadata.memoryId.trim()) {
    throw new Error("memoryId must be a non-empty string");
  }
  if (!isMemorySelfImprovingKind(metadata.kind)) {
    throw new Error("memory self-improving metadata kind is not supported");
  }
  if (!isMemorySelfImprovingTrigger(metadata.trigger)) {
    throw new Error("memory self-improving metadata trigger is not supported");
  }
  if (!metadata.lesson.trim()) {
    throw new Error("lesson must be a non-empty string");
  }
  if (metadata.evidenceCount < 0 || metadata.useCount < 0) {
    throw new Error("memory self-improving metadata counters must be non-negative");
  }
  if (metadata.supersededBy === metadata.memoryId) {
    throw new Error("supersededBy must not equal memoryId");
  }
}

function isMemoryScopeType(value: unknown): value is MemoryScopeType {
  return value === "workspace" || value === "channel" || value === "teammate" || value === "task" || value === "run";
}

function isMemorySelfImprovingKind(value: unknown): value is MemorySelfImprovingKind {
  return (
    value === "correction" ||
    value === "reflection" ||
    value === "workflow_lesson" ||
    value === "tool_routing_lesson" ||
    value === "runtime_recovery_lesson"
  );
}

function isMemorySelfImprovingTrigger(value: unknown): value is MemorySelfImprovingMetadata["trigger"] {
  return value === "manual_review" || value === "promotion" || value === "run_review" || value === "health_review" || value === "import";
}

function isMemoryReviewState(value: unknown): value is MemoryReviewState {
  return value === "candidate" || value === "active" || value === "disabled" || value === "archived" || value === "rejected";
}

function isMemorySensitivity(value: unknown): value is MemorySensitivity {
  return value === "normal" || value === "private" || value === "secret-adjacent";
}

function normalizeStringList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const item = value.trim();
    if (!item || seen.has(item.toLowerCase())) {
      continue;
    }
    seen.add(item.toLowerCase());
    normalized.push(item);
  }
  return normalized;
}
