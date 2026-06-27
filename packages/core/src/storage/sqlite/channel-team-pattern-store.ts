import type { SQLOutputValue } from "node:sqlite";
import {
  DEFAULT_WORKSPACE_ID,
} from "../../workspace-types.js";
import {
  channelTeamPatternCreatedByValues,
  channelTeamPatternStatuses,
  channelTeamEvidenceSourceRefTypes,
  channelTeamShadowArtifactGuardrails,
  channelTeamProvisionalRuleEffects,
  createChannelTeamPatternId,
  type ChannelTeamPattern,
  type ChannelTeamEvidenceSourceRef,
  type ChannelTeamEvidenceSourceRefType,
  type CreateChannelTeamPatternInput,
  type ListActiveChannelTeamProvisionalRulesOptions,
  type ListChannelTeamPatternsOptions,
  type UpdateChannelTeamPatternInput,
} from "../../channel-team-types.js";
import {
  nullableUpdate,
  stringifyJson,
} from "./helpers.js";
import { mapChannelTeamPattern } from "./channel-team-pattern-mappers.js";
import { channelTeamPatternSelectSql } from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";

export interface SqliteChannelTeamPatternStorePorts {
  readonly assertChannelExists: (channelId: string) => void;
}

export class SqliteChannelTeamPatternStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteChannelTeamPatternStorePorts,
  ) {}

  createChannelTeamPattern(input: CreateChannelTeamPatternInput, now: string): ChannelTeamPattern {
    this.ports.assertChannelExists(input.channelId);
    const pattern: ChannelTeamPattern = {
      id: input.id ?? createChannelTeamPatternId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId: input.channelId,
      pattern: input.pattern,
      summary: input.summary,
      evidenceCount: input.evidenceCount ?? 0,
      adoptedCount: input.adoptedCount ?? 0,
      failureCount: input.failureCount ?? 0,
      sourceRefs: input.sourceRefs ?? [],
      status: input.status ?? "candidate",
      createdBy: input.createdBy ?? "system",
      guardrails: channelTeamShadowArtifactGuardrails,
      provisionalEffect: input.provisionalEffect,
      provisionalRationale: input.provisionalRationale,
      verifyBeforeUse: input.verifyBeforeUse ?? (input.sourceRefs ?? []).length === 0,
      supersededByPatternId: input.supersededByPatternId,
      lastSeenAt: input.lastSeenAt ?? now,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    validateCreatedChannelTeamPatternStatus(pattern.status);
    validateChannelTeamPattern(pattern);
    this.context.database
      .prepare(`
        INSERT INTO channel_team_patterns (
          id,
          workspace_id,
          channel_id,
          pattern,
          summary,
          evidence_count,
          adopted_count,
          failure_count,
          source_refs_json,
          status,
          created_by,
          provisional_effect,
          provisional_rationale,
          verify_before_use,
          superseded_by_pattern_id,
          last_seen_at,
          expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        pattern.id,
        pattern.workspaceId,
        pattern.channelId,
        pattern.pattern,
        pattern.summary,
        pattern.evidenceCount,
        pattern.adoptedCount,
        pattern.failureCount,
        stringifyJson(pattern.sourceRefs),
        pattern.status,
        pattern.createdBy,
        pattern.provisionalEffect ?? null,
        pattern.provisionalRationale ?? null,
        pattern.verifyBeforeUse ? 1 : 0,
        pattern.supersededByPatternId ?? null,
        pattern.lastSeenAt,
        pattern.expiresAt ?? null,
        pattern.createdAt,
        pattern.updatedAt,
      );
    const created = this.getChannelTeamPattern(pattern.id);
    if (!created) {
      throw new Error(`Failed to create channel team pattern: ${pattern.id}`);
    }
    return created;
  }

  getChannelTeamPattern(id: string): ChannelTeamPattern | undefined {
    const row = this.context.database.prepare(channelTeamPatternSelectSql("WHERE id = ?")).get(id);
    return row ? mapChannelTeamPattern(row as Record<string, SQLOutputValue>) : undefined;
  }

  listChannelTeamPatterns(options: ListChannelTeamPatternsOptions): ChannelTeamPattern[] {
    const { clauses, params } = this.buildPatternListQuery(options);
    params.push(clampLimit(options.limit));
    return this.context.database
      .prepare(`${channelTeamPatternSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapChannelTeamPattern(row as Record<string, SQLOutputValue>));
  }

  listActiveChannelTeamProvisionalRules(options: ListActiveChannelTeamProvisionalRulesOptions): ChannelTeamPattern[] {
    return this.listChannelTeamPatterns({
      channelId: options.channelId,
      status: "provisional",
      now: options.now,
      limit: options.limit,
    }).filter((pattern) => pattern.provisionalEffect !== undefined);
  }

  updateChannelTeamPattern(
    id: string,
    input: UpdateChannelTeamPatternInput,
    now: string,
  ): ChannelTeamPattern | undefined {
    const existing = this.getChannelTeamPattern(id);
    if (!existing) {
      return undefined;
    }
    const next: ChannelTeamPattern = {
      ...existing,
      status: input.status ?? existing.status,
      summary: input.summary ?? existing.summary,
      evidenceCount: input.evidenceCount ?? existing.evidenceCount,
      adoptedCount: input.adoptedCount ?? existing.adoptedCount,
      failureCount: input.failureCount ?? existing.failureCount,
      sourceRefs: input.sourceRefs ?? existing.sourceRefs,
      provisionalEffect: nullableUpdate(input.provisionalEffect, existing.provisionalEffect),
      provisionalRationale: nullableUpdate(input.provisionalRationale, existing.provisionalRationale),
      verifyBeforeUse: input.verifyBeforeUse ?? existing.verifyBeforeUse,
      supersededByPatternId: nullableUpdate(input.supersededByPatternId, existing.supersededByPatternId),
      lastSeenAt: input.lastSeenAt ?? existing.lastSeenAt,
      expiresAt: nullableUpdate(input.expiresAt, existing.expiresAt),
      updatedAt: now,
    };
    validateChannelTeamPattern(next);
    this.context.database
      .prepare(`
        UPDATE channel_team_patterns
        SET
          summary = ?,
          evidence_count = ?,
          adopted_count = ?,
          failure_count = ?,
          source_refs_json = ?,
          status = ?,
          provisional_effect = ?,
          provisional_rationale = ?,
          verify_before_use = ?,
          superseded_by_pattern_id = ?,
          last_seen_at = ?,
          expires_at = ?,
          updated_at = ?
        WHERE id = ?
      `)
      .run(
        next.summary,
        next.evidenceCount,
        next.adoptedCount,
        next.failureCount,
        stringifyJson(next.sourceRefs),
        next.status,
        next.provisionalEffect ?? null,
        next.provisionalRationale ?? null,
        next.verifyBeforeUse ? 1 : 0,
        next.supersededByPatternId ?? null,
        next.lastSeenAt,
        next.expiresAt ?? null,
        next.updatedAt,
        id,
      );
    return this.getChannelTeamPattern(id);
  }

  expireChannelTeamPatterns(now: string): number {
    const result = this.context.database
      .prepare(`
        UPDATE channel_team_patterns
        SET status = 'expired', updated_at = ?
        WHERE workspace_id = ?
          AND status IN ('candidate', 'provisional')
          AND expires_at IS NOT NULL
          AND expires_at <= ?
      `)
      .run(now, DEFAULT_WORKSPACE_ID, now);
    return Number(result.changes);
  }

  private buildPatternListQuery(options: ListChannelTeamPatternsOptions): {
    readonly clauses: string[];
    readonly params: (string | number)[];
  } {
    const clauses = ["workspace_id = ?", "channel_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.channelId];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.includeExpired !== true && options.now && options.status !== "expired") {
      clauses.push("(expires_at IS NULL OR expires_at > ?)");
      params.push(options.now);
    }
    return { clauses, params };
  }
}

function validateChannelTeamPattern(pattern: ChannelTeamPattern): void {
  validateNonEmptyString(pattern.channelId, "channel team pattern channel id");
  validateNonEmptyString(pattern.pattern, "channel team pattern");
  validateNonEmptyString(pattern.summary, "channel team pattern summary");
  validateNonNegativeInteger(pattern.evidenceCount, "channel team pattern evidence count");
  validateNonNegativeInteger(pattern.adoptedCount, "channel team pattern adopted count");
  validateNonNegativeInteger(pattern.failureCount, "channel team pattern failure count");
  if (!channelTeamPatternStatuses.includes(pattern.status)) {
    throw new Error("channel team pattern status is not supported");
  }
  if (!channelTeamPatternCreatedByValues.includes(pattern.createdBy)) {
    throw new Error("channel team pattern creator is not supported");
  }
  if (pattern.provisionalEffect !== undefined && !channelTeamProvisionalRuleEffects.includes(pattern.provisionalEffect)) {
    throw new Error("channel team provisional rule effect is not supported");
  }
  if (pattern.status === "provisional") {
    if (!pattern.provisionalEffect) {
      throw new Error("channel team provisional rule effect is required");
    }
    validateNonEmptyString(pattern.provisionalRationale ?? "", "channel team provisional rule rationale");
    validateNonEmptyString(pattern.expiresAt ?? "", "channel team provisional rule expiry");
  } else if (
    (pattern.status === "candidate" || pattern.status === "rejected") &&
    (pattern.provisionalEffect || pattern.provisionalRationale)
  ) {
    throw new Error("channel team provisional rule fields require provisional status");
  }
  validateChannelTeamSourceRefs(pattern.sourceRefs);
}

function validateCreatedChannelTeamPatternStatus(status: ChannelTeamPattern["status"]): void {
  if (status !== "candidate" && status !== "provisional") {
    throw new Error("channel team pattern create only supports candidate or provisional status");
  }
}

function validateNonEmptyString(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`${label} must not be empty`);
  }
}

function validateNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function validateChannelTeamSourceRefs(sourceRefs: readonly ChannelTeamEvidenceSourceRef[]): void {
  for (const sourceRef of sourceRefs) {
    if (!isChannelTeamEvidenceSourceRefTypeValue(sourceRef.type)) {
      throw new Error("channel team pattern source ref type is not supported");
    }
    validateNonEmptyString(sourceRef.id, "channel team pattern source ref id");
  }
}

function isChannelTeamEvidenceSourceRefTypeValue(value: unknown): value is ChannelTeamEvidenceSourceRefType {
  return typeof value === "string" && channelTeamEvidenceSourceRefTypes.includes(value as ChannelTeamEvidenceSourceRefType);
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 50, 1), 200);
}
