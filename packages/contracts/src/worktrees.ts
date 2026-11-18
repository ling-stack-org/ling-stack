export interface WorktreePolicy {
  readonly rootDir?: string;
  readonly fetchBeforeCreate: boolean;
  readonly autoCleanup?: boolean;
  readonly retainCount?: number;
  readonly confirmBeforeDelete?: boolean;
  readonly protectedOwners?: readonly { readonly ownerKind: ManagedWorktreeOwnerKind; readonly ownerId: string }[];
  readonly environment?: WorktreeEnvironment;
}

export interface WorktreeEnvironment {
  readonly enabled: boolean;
  readonly setupScript: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly timeoutSeconds: number;
}

export interface WorktreeInitialization {
  readonly status: "pending" | "running" | "succeeded" | "failed";
  readonly output?: string;
  readonly completedAt?: string;
  readonly errorMessage?: string;
}

export interface WorktreeRecoverySnapshot {
  readonly id: string;
  readonly ownerKind: ManagedWorktreeOwnerKind;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly originalPath: string;
  readonly snapshotPath: string;
  readonly branchName: string;
  readonly createdAt: string;
  readonly state: "prepared" | "archived" | "restoring" | "restored" | "blocked";
  readonly errorMessage?: string;
}

export type ManagedWorktreeOwnerKind = "channel" | "teammate";

export interface ManagedWorktreeEntry {
  readonly ownerKind: ManagedWorktreeOwnerKind;
  readonly ownerId: string;
  readonly ownerName: string;
  readonly path: string;
  readonly branchName?: string;
  readonly status: "ready" | "missing" | "blocked" | "not_created";
  readonly isDirty: boolean;
  readonly inUse: boolean;
  readonly pinned?: boolean;
  readonly kept?: boolean;
  readonly lastUsedAt?: string;
  readonly initialization?: WorktreeInitialization;
  readonly errorMessage?: string;
}

export interface ManagedWorktreeListResponse {
  readonly cwd: string;
  readonly policy: WorktreePolicy;
  readonly defaultRootDir: string;
  readonly effectiveRootDir: string;
  readonly entries: readonly ManagedWorktreeEntry[];
  readonly limitReached: boolean;
  readonly snapshots?: readonly WorktreeRecoverySnapshot[];
  readonly cleanup?: { readonly checkedAt: string; readonly removed: number; readonly errorMessage?: string };
}

export interface ManagedWorktreeActionRequest {
  readonly ownerKind: ManagedWorktreeOwnerKind;
  readonly ownerId: string;
  readonly action: "open" | "cleanup" | "restore" | "initialize" | "pin" | "unpin";
  readonly snapshotId?: string;
  readonly confirmed?: boolean;
}

/** Approval preview for Desktop Main. Environment values stay in the daemon. */
export interface WorktreeInitializationChallenge {
  readonly challengeId: string;
  readonly expiresAt: string;
  readonly path: string;
  readonly ownerName: string;
  readonly environment: (Omit<WorktreeEnvironment, "variables"> & { readonly variableNames: readonly string[] }) | undefined;
}
