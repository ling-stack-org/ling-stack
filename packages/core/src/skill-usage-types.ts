import { randomUUID } from "node:crypto";

export type SkillUsageEventKind =
  | "selected"
  | "started"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "user_corrected"
  | "draft_created"
  | "published"
  | "superseded";

export interface SkillUsageEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly skillId?: string;
  readonly candidateId?: string;
  readonly runId?: string;
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly kind: SkillUsageEventKind;
  readonly reason?: string;
  readonly createdAt: string;
}

export interface CreateSkillUsageEventInput {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly skillId?: string;
  readonly candidateId?: string;
  readonly runId?: string;
  readonly teammateId?: string;
  readonly channelId?: string;
  readonly kind: SkillUsageEventKind;
  readonly reason?: string;
}

export interface ListSkillUsageEventsOptions {
  readonly workspaceId?: string;
  readonly skillId?: string;
  readonly candidateId?: string;
  readonly runId?: string;
  readonly kind?: SkillUsageEventKind;
  readonly limit?: number;
}

export interface SkillUsageStats {
  readonly skillId: string;
  readonly useCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly cancelledCount: number;
  readonly correctionCount: number;
  readonly lastUsedAt?: string;
  readonly lastFailureAt?: string;
  readonly lastUserCorrectionAt?: string;
}

export interface ListSkillUsageStatsOptions {
  readonly workspaceId?: string;
  readonly skillId?: string;
}

export function createSkillUsageEventId(): string {
  return `skill_usage_${randomUUID()}`;
}
