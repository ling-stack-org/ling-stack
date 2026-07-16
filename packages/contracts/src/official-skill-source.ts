export type OfficialSkillSourceStatus = "ready" | "synced";

export interface OfficialSkillSourceState {
  readonly sourceId: "official-gstack";
  readonly originUrl: string;
  readonly ref: string;
  readonly revision?: string;
  readonly version?: string;
  readonly lastSyncedAt?: string;
}

export interface OfficialSkillSourceStatusResponse {
  readonly cwd: string;
  readonly status: OfficialSkillSourceStatus;
  readonly source: OfficialSkillSourceState;
}
