export type ControlPlaneDomain =
  | "runs"
  | "work_units"
  | "memory"
  | "skills"
  | "teammates"
  | "approvals"
  | "providers"
  | "mcp"
  | "runners"
  | "artifacts";

export interface ControlPlaneEvent {
  readonly seq: number;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly ts: string;
  readonly domain: ControlPlaneDomain;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface ControlPlaneDomainSnapshot {
  readonly ok: boolean;
  readonly revision: number;
  readonly data?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export interface ControlPlaneSnapshotResponse {
  readonly cwd: string;
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly latestEventSeq: number;
  readonly domains: Readonly<Record<string, ControlPlaneDomainSnapshot>>;
}

export interface ControlPlaneEventsRequest {
  readonly afterSeq?: number;
  readonly limit?: number;
  readonly domains?: readonly ControlPlaneDomain[];
}

export interface ControlPlaneEventsResponse {
  readonly cwd: string;
  readonly workspaceId: string;
  readonly afterSeq: number;
  readonly limit: number;
  readonly events: readonly ControlPlaneEvent[];
}

export interface ControlPlaneLink {
  readonly href: string;
  readonly label: string;
}

export interface CountSummary {
  readonly total: number;
  readonly active?: number;
  readonly pending?: number;
  readonly failed?: number;
  readonly blocked?: number;
}

export interface RunsDomainSnapshot {
  readonly activeRuns: readonly RunSummary[];
  readonly recentRuns: readonly RunSummary[];
  readonly stuck: {
    readonly count: number;
    readonly workUnitIds: readonly string[];
  };
  readonly links: {
    readonly recentRuns: ControlPlaneLink;
    readonly stuckWork: ControlPlaneLink;
  };
}

export interface RunSummary {
  readonly id: string;
  readonly status: string;
  readonly taskId?: string;
  readonly channelId?: string;
  readonly teammateId?: string;
  readonly requestedSkillId?: string;
  readonly providerPresetId?: string;
  readonly workUnitId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string;
  readonly latestEventSeq?: number;
  readonly errorCode?: string;
}

export interface WorkUnitsDomainSnapshot {
  readonly counts: CountSummary;
  readonly active: readonly WorkUnitSummary[];
  readonly queued: readonly WorkUnitSummary[];
  readonly stale: readonly WorkUnitSummary[];
}

export interface WorkUnitSummary {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly runId?: string;
  readonly channelId?: string;
  readonly leaseId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastHeartbeatAt?: string;
  readonly blockedReason?: string;
}

export interface SkillsDomainSnapshot {
  readonly registryGeneration: number;
  readonly counts: {
    readonly total: number;
    readonly builtin: number;
    readonly published: number;
    readonly draft: number;
    readonly archived: number;
  };
  readonly skills: readonly SkillRegistrySummary[];
}

export interface SkillRegistrySummary {
  readonly id: string;
  readonly packId: string;
  readonly source: string;
  readonly name: string;
  readonly description: string;
  readonly reviewStatus: string;
  readonly workspaceVisible: boolean;
  readonly updatedAt: string;
}

export interface TeammatesDomainSnapshot {
  readonly counts: CountSummary;
  readonly teammates: readonly TeammateSummary[];
}

export interface TeammateSummary {
  readonly id: string;
  readonly displayName: string;
  readonly source: "builtin" | "user";
  readonly status: string;
  readonly defaultProviderPresetId?: string;
  readonly effectiveSkillCount: number;
  readonly blockedSkillCount: number;
  readonly memoryScopeCount: number;
  readonly mcpServerCount: number;
  readonly updatedAt: string;
}

export interface ApprovalsDomainSnapshot {
  readonly policy: {
    readonly mode: string;
    readonly toolDecisionCounts: Record<string, number>;
    readonly allowedWritePathCount: number;
  };
  readonly pending: readonly ApprovalSummary[];
  readonly counts: {
    readonly pending: number;
    readonly highRisk: number;
    readonly expired: number;
  };
}

export interface ApprovalSummary {
  readonly id: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly actionType: string;
  readonly risk: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly previewArtifactId?: string;
}

export interface ProvidersDomainSnapshot {
  readonly counts: {
    readonly total: number;
    readonly enabled: number;
    readonly runnable: number;
    readonly preflightReady: number;
    readonly missingSecrets: number;
  };
  readonly providers: readonly ProviderSummary[];
}

export interface ProviderSummary {
  readonly id: string;
  readonly displayName: string;
  readonly kind: string;
  readonly api: string;
  readonly enabled: boolean;
  readonly capabilities: readonly string[];
  readonly input: readonly string[];
  readonly runnable: boolean;
  readonly blocker?: string;
  readonly secretStatus: "configured" | "missing" | "unavailable" | "not_required";
  readonly secretRefKind?: "env" | "keychain";
  readonly lastCheck?: {
    readonly ok: boolean;
    readonly code: string;
    readonly checkedAt: string;
  };
}

export interface McpDomainSnapshot {
  readonly counts: {
    readonly total: number;
    readonly enabled: number;
    readonly failed: number;
    readonly missingSecrets: number;
    readonly syncedTools: number;
  };
  readonly servers: readonly McpServerSummary[];
}

export interface McpServerSummary {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly status?: string;
  readonly toolCount: number;
  readonly missingSecretCount: number;
  readonly legacySecretMigrationRequired: boolean;
  readonly updatedAt: string;
}

export interface RunnersDomainSnapshot {
  readonly defaultRunnerId: string;
  readonly allowedRunnerIds: readonly string[];
  readonly runners: readonly RunnerSummary[];
}

export interface RunnerSummary {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly experimental: boolean;
  readonly capabilities: readonly string[];
  readonly blocker?: string;
  readonly readiness?: import("./runner-readiness.js").RunnerReadinessSummary;
}
