export type RetentionEntityType = "ai-teammate" | "conversation-thread";

export interface RetentionTombstone {
  readonly id: string;
  readonly workspaceId: string;
  readonly entityType: RetentionEntityType;
  readonly entityId: string;
  readonly reason?: string;
  readonly deletedCounts: Readonly<Record<string, number>>;
  readonly createdAt: string;
}
