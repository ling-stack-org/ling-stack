export interface OfficialSkillSourceSubscription {
  readonly workspaceId: string;
  readonly sourceId: "official-gstack";
  readonly originUrl: string;
  readonly ref: string;
  readonly revision?: string;
  readonly version?: string;
  readonly lastSyncedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertOfficialSkillSourceSubscriptionInput {
  readonly sourceId: "official-gstack";
  readonly originUrl: string;
  readonly ref: string;
  readonly revision?: string;
  readonly version?: string;
  readonly lastSyncedAt?: string;
}
