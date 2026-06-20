import type { SQLOutputValue } from "node:sqlite";
import {
  createSkillUsageEventId,
  type CreateSkillUsageEventInput,
  type ListSkillUsageEventsOptions,
  type ListSkillUsageStatsOptions,
  type SkillUsageEvent,
  type SkillUsageEventKind,
  type SkillUsageStats,
} from "../../skill-usage-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { readNullableString, readString } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

const skillUsageEventSelectSql = `
  SELECT
    id,
    workspace_id,
    skill_id,
    candidate_id,
    run_id,
    teammate_id,
    channel_id,
    kind,
    reason,
    created_at
  FROM skill_usage_events
`;

export class SqliteSkillUsageStore {
  constructor(private readonly context: SqliteStoreContext) {}

  appendSkillUsageEvent(input: CreateSkillUsageEventInput, now: string): SkillUsageEvent {
    const event: SkillUsageEvent = {
      id: input.id ?? createSkillUsageEventId(),
      workspaceId: input.workspaceId ?? DEFAULT_WORKSPACE_ID,
      skillId: input.skillId,
      candidateId: input.candidateId,
      runId: input.runId,
      teammateId: input.teammateId,
      channelId: input.channelId,
      kind: input.kind,
      reason: input.reason,
      createdAt: now,
    };
    validateSkillUsageEvent(event);
    this.context.database
      .prepare(`
        INSERT INTO skill_usage_events (
          id,
          workspace_id,
          skill_id,
          candidate_id,
          run_id,
          teammate_id,
          channel_id,
          kind,
          reason,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.workspaceId,
        event.skillId ?? null,
        event.candidateId ?? null,
        event.runId ?? null,
        event.teammateId ?? null,
        event.channelId ?? null,
        event.kind,
        event.reason ?? null,
        event.createdAt,
      );
    return event;
  }

  listSkillUsageEvents(options: ListSkillUsageEventsOptions = {}): SkillUsageEvent[] {
    const conditions = ["workspace_id = ?"];
    const params: Array<string | number> = [options.workspaceId ?? DEFAULT_WORKSPACE_ID];
    if (options.skillId) {
      conditions.push("skill_id = ?");
      params.push(options.skillId);
    }
    if (options.candidateId) {
      conditions.push("candidate_id = ?");
      params.push(options.candidateId);
    }
    if (options.runId) {
      conditions.push("run_id = ?");
      params.push(options.runId);
    }
    if (options.kind) {
      conditions.push("kind = ?");
      params.push(options.kind);
    }
    params.push(Math.min(Math.max(options.limit ?? 100, 1), 500));
    return this.context.database
      .prepare(`${skillUsageEventSelectSql} WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapSkillUsageEvent(row as Record<string, SQLOutputValue>));
  }

  listSkillUsageStats(options: ListSkillUsageStatsOptions = {}): SkillUsageStats[] {
    const events = this.listSkillUsageEvents({
      workspaceId: options.workspaceId,
      skillId: options.skillId,
      limit: 500,
    }).filter((event) => event.skillId);
    const bySkill = new Map<string, SkillUsageEvent[]>();
    for (const event of events) {
      bySkill.set(event.skillId!, [...(bySkill.get(event.skillId!) ?? []), event]);
    }
    return [...bySkill.entries()]
      .map(([skillId, skillEvents]) => buildSkillUsageStats(skillId, skillEvents))
      .sort((left, right) => left.skillId.localeCompare(right.skillId));
  }
}

function mapSkillUsageEvent(row: Record<string, SQLOutputValue>): SkillUsageEvent {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    skillId: readNullableString(row, "skill_id"),
    candidateId: readNullableString(row, "candidate_id"),
    runId: readNullableString(row, "run_id"),
    teammateId: readNullableString(row, "teammate_id"),
    channelId: readNullableString(row, "channel_id"),
    kind: readString(row, "kind") as SkillUsageEventKind,
    reason: readNullableString(row, "reason"),
    createdAt: readString(row, "created_at"),
  };
}

function buildSkillUsageStats(skillId: string, events: readonly SkillUsageEvent[]): SkillUsageStats {
  const selectedOrStarted = events.filter((event) => event.kind === "selected" || event.kind === "started");
  const failures = events.filter((event) => event.kind === "failed");
  const corrections = events.filter((event) => event.kind === "user_corrected");
  return {
    skillId,
    useCount: countUniqueRuns(selectedOrStarted),
    successCount: events.filter((event) => event.kind === "succeeded").length,
    failureCount: failures.length,
    cancelledCount: events.filter((event) => event.kind === "cancelled").length,
    correctionCount: corrections.length,
    lastUsedAt: newestTimestamp(selectedOrStarted),
    lastFailureAt: newestTimestamp(failures),
    lastUserCorrectionAt: newestTimestamp(corrections),
  };
}

function countUniqueRuns(events: readonly SkillUsageEvent[]): number {
  const runIds = events.map((event) => event.runId).filter((runId): runId is string => Boolean(runId));
  return runIds.length > 0 ? new Set(runIds).size : events.length;
}

function newestTimestamp(events: readonly SkillUsageEvent[]): string | undefined {
  return events.map((event) => event.createdAt).sort().at(-1);
}

function validateSkillUsageEvent(event: SkillUsageEvent): void {
  if (!event.id || !event.workspaceId) {
    throw new Error("Skill usage event id and workspace id are required");
  }
  if (!event.skillId && !event.candidateId) {
    throw new Error("Skill usage event requires skillId or candidateId");
  }
  if (!skillUsageEventKinds.includes(event.kind)) {
    throw new Error("Skill usage event kind is not supported");
  }
}

const skillUsageEventKinds = ["selected", "started", "succeeded", "failed", "cancelled", "user_corrected", "draft_created", "published", "superseded"] as const;
