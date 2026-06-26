import type { SQLOutputValue } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_ID,
} from "../../workspace-types.js";
import {
  channelTeamEvidenceGrades,
  channelTeamEvidenceKinds,
  channelTeamEvidenceSourceRefTypes,
  channelTeamEvidenceStatuses,
  channelTeamEvidenceVisibilities,
  createChannelTeamEvidenceItemId,
  type ChannelTeamEvidenceItem,
  type ChannelTeamEvidenceSourceRef,
  type CreateChannelTeamEvidenceItemInput,
  type FoldedExpertsReadModel,
  type ListFoldedChannelTeamEvidenceForTurnOptions,
  type ListChannelTeamEvidenceItemsOptions,
  type UpdateChannelTeamEvidenceItemInput,
} from "../../channel-team-types.js";
import { foldChannelTeamEvidenceForTurn } from "../../channel-team-specialist-notes.js";
import { nullableUpdate, stringifyJson } from "./helpers.js";
import { mapChannelTeamEvidenceItem } from "./channel-team-evidence-mappers.js";
import { channelTeamEvidenceItemSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteChannelTeamEvidenceStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
}

export class SqliteChannelTeamEvidenceStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteChannelTeamEvidenceStorePorts,
  ) {}

  createChannelTeamEvidenceItem(input: CreateChannelTeamEvidenceItemInput, now: string): ChannelTeamEvidenceItem {
    this.ports.assertChannelExists(input.channelId);
    validateChannelTeamEvidenceInput(input);
    const item: ChannelTeamEvidenceItem = {
      id: input.id ?? createChannelTeamEvidenceItemId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      turnId: input.turnId,
      agentId: input.agentId,
      kind: input.kind,
      status: input.status ?? "completed",
      visibility: input.visibility ?? "internal",
      evidenceGrade: input.evidenceGrade,
      summary: input.summary,
      concerns: input.concerns ?? [],
      recommendations: input.recommendations ?? [],
      confidence: input.confidence,
      sourceRefs: input.sourceRefs ?? [],
      payload: input.payload ?? {},
      expiresAt: input.expiresAt ?? undefined,
      createdAt: now,
      updatedAt: now,
    };

    this.context.database
      .prepare(`
        INSERT INTO channel_team_evidence_items (
          id,
          workspace_id,
          channel_id,
          turn_id,
          agent_id,
          kind,
          status,
          visibility,
          evidence_grade,
          summary,
          concerns_json,
          recommendations_json,
          confidence,
          source_refs_json,
          payload_json,
          expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        item.id,
        item.workspaceId,
        item.channelId,
        item.turnId ?? null,
        item.agentId ?? null,
        item.kind,
        item.status,
        item.visibility,
        item.evidenceGrade ?? null,
        item.summary,
        stringifyJson(item.concerns),
        stringifyJson(item.recommendations),
        item.confidence ?? null,
        stringifyJson(item.sourceRefs),
        stringifyJson(item.payload),
        item.expiresAt ?? null,
        item.createdAt,
        item.updatedAt,
      );

    const created = this.getChannelTeamEvidenceItem(item.id);
    if (!created) {
      throw new Error(`Failed to create channel team evidence item: ${item.id}`);
    }
    return created;
  }

  getChannelTeamEvidenceItem(id: string): ChannelTeamEvidenceItem | undefined {
    const row = this.context.database.prepare(channelTeamEvidenceItemSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelTeamEvidenceItem(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelTeamEvidenceItems(options: ListChannelTeamEvidenceItemsOptions): ChannelTeamEvidenceItem[] {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.turnId) {
      clauses.push("turn_id = ?");
      params.push(options.turnId);
    }
    if (options.agentId) {
      clauses.push("agent_id = ?");
      params.push(options.agentId);
    }
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.visibility) {
      clauses.push("visibility = ?");
      params.push(options.visibility);
    }
    if (options.includeExpired !== true && options.now) {
      clauses.push("(expires_at IS NULL OR expires_at > ?)");
      params.push(options.now);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${channelTeamEvidenceItemSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapChannelTeamEvidenceItem(row as Record<string, SQLOutputValue>));
  }

  listFoldedChannelTeamEvidenceForTurn(options: ListFoldedChannelTeamEvidenceForTurnOptions): FoldedExpertsReadModel {
    const evidence = this.listChannelTeamEvidenceItems({
      channelId: options.channelId,
      turnId: options.turnId,
      now: options.now,
      includeExpired: options.includeExpired,
      limit: options.limit ?? 200,
    });
    return foldChannelTeamEvidenceForTurn({
      channelId: options.channelId,
      turnId: options.turnId,
      evidence,
      now: options.now,
      includeExpired: options.includeExpired,
    });
  }

  updateChannelTeamEvidenceItem(
    id: string,
    input: UpdateChannelTeamEvidenceItemInput,
    now: string,
  ): ChannelTeamEvidenceItem | undefined {
    const existing = this.getChannelTeamEvidenceItem(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelTeamEvidenceItem = {
      ...existing,
      status: input.status ?? existing.status,
      visibility: input.visibility ?? existing.visibility,
      evidenceGrade: nullableUpdate(input.evidenceGrade, existing.evidenceGrade),
      summary: input.summary ?? existing.summary,
      concerns: input.concerns ?? existing.concerns,
      recommendations: input.recommendations ?? existing.recommendations,
      confidence: nullableUpdate(input.confidence, existing.confidence),
      sourceRefs: input.sourceRefs ?? existing.sourceRefs,
      payload: input.payload ?? existing.payload,
      expiresAt: nullableUpdate(input.expiresAt, existing.expiresAt),
      updatedAt: now,
    };
    validateChannelTeamEvidenceInput({
      channelId: next.channelId,
      kind: next.kind,
      status: next.status,
      visibility: next.visibility,
      evidenceGrade: next.evidenceGrade,
      summary: next.summary,
      concerns: next.concerns,
      recommendations: next.recommendations,
      confidence: next.confidence,
      sourceRefs: next.sourceRefs,
      payload: next.payload,
      expiresAt: next.expiresAt,
    });

    this.context.database
      .prepare(`
        UPDATE channel_team_evidence_items
        SET
          status = ?,
          visibility = ?,
          evidence_grade = ?,
          summary = ?,
          concerns_json = ?,
          recommendations_json = ?,
          confidence = ?,
          source_refs_json = ?,
          payload_json = ?,
          expires_at = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.status,
        next.visibility,
        next.evidenceGrade ?? null,
        next.summary,
        stringifyJson(next.concerns),
        stringifyJson(next.recommendations),
        next.confidence ?? null,
        stringifyJson(next.sourceRefs),
        stringifyJson(next.payload),
        next.expiresAt ?? null,
        next.updatedAt,
        id,
      );
    return this.getChannelTeamEvidenceItem(id);
  }
}

function validateChannelTeamEvidenceInput(input: CreateChannelTeamEvidenceItemInput): void {
  if (!channelTeamEvidenceKinds.includes(input.kind)) {
    throw new Error("channel team evidence kind is not supported");
  }
  if (input.status !== undefined && !channelTeamEvidenceStatuses.includes(input.status)) {
    throw new Error("channel team evidence status is not supported");
  }
  if (input.visibility !== undefined && !channelTeamEvidenceVisibilities.includes(input.visibility)) {
    throw new Error("channel team evidence visibility is not supported");
  }
  if (input.evidenceGrade !== undefined && !channelTeamEvidenceGrades.includes(input.evidenceGrade)) {
    throw new Error("channel team evidence grade is not supported");
  }
  if (input.summary.trim().length === 0) {
    throw new Error("channel team evidence summary is required");
  }
  validateStringList(input.concerns ?? [], "channel team evidence concerns");
  validateStringList(input.recommendations ?? [], "channel team evidence recommendations");
  validateConfidence(input.confidence);
  validateSourceRefs(input.sourceRefs ?? []);
  validatePayload(input.payload ?? {});
}

function validateStringList(value: readonly string[], label: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
}

function validateConfidence(value: number | undefined): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("channel team evidence confidence must be between 0 and 1");
  }
}

function validateSourceRefs(value: readonly ChannelTeamEvidenceSourceRef[]): void {
  if (!Array.isArray(value)) {
    throw new Error("channel team evidence sourceRefs must be an array");
  }
  for (const sourceRef of value) {
    if (!channelTeamEvidenceSourceRefTypes.includes(sourceRef.type)) {
      throw new Error("channel team evidence source ref type is not supported");
    }
    if (typeof sourceRef.id !== "string" || sourceRef.id.trim().length === 0) {
      throw new Error("channel team evidence source ref id is required");
    }
  }
}

function validatePayload(value: Record<string, unknown>): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("channel team evidence payload must be an object");
  }
}
