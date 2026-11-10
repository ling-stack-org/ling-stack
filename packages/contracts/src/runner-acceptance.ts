export interface RunnerAcceptanceIdentity {
  readonly runnerId: string;
  readonly runtimeVersion: string;
  readonly sdkVersion: string;
  readonly adapterVersion: string;
  readonly executableDigest: string;
  readonly platform: string;
  readonly architecture: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly configurationFingerprint: string;
  readonly workspaceId: string;
  readonly policyFingerprint: string;
  readonly workflowSurface: "normal_conversation" | "channel" | "private_chat" | "task" | "workflow" | "automation" | "external_work";
}

export const RUNNER_RELEASE_CHECKS = ["protocol", "permissions", "workspace", "artifacts", "cancellation", "recovery", "real_runtime", "packaged"] as const;
export type RunnerAcceptanceCheck = typeof RUNNER_RELEASE_CHECKS[number];

export type RunnerReleaseIdentity = Omit<RunnerAcceptanceIdentity,
  "profileId" | "profileRevision" | "configurationFingerprint" | "workspaceId">;

export const RUNNER_HOST_CHECKS = ["installation", "authentication", "connection", "workspace_binding"] as const;
export type RunnerHostCheck = typeof RUNNER_HOST_CHECKS[number];

export interface RunnerReleaseEvidence {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly identity: RunnerReleaseIdentity;
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
  readonly checks: Readonly<Record<RunnerAcceptanceCheck, "passed" | "failed" | "not_run">>;
}

/** Verifier-owned record, never a browser-supplied configuration or probe result. */
export interface RunnerAcceptanceEvidence {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly identity: RunnerAcceptanceIdentity;
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
  readonly releaseEvidenceId: string;
  readonly release: RunnerReleaseEvidence;
  readonly checks: Readonly<Record<RunnerHostCheck, "passed" | "failed" | "not_run">>;
}

export type RunnerAcceptanceDecision =
  | { readonly status: "accepted" }
  | {
      readonly status: "blocked";
      readonly reason:
        | "verification_missing"
        | "verification_invalid"
        | "verification_mismatch"
        | "verification_expired"
        | "verification_revoked"
        | "verification_incomplete";
    };
