export type RunnerReadinessStatus = "ready" | "blocked" | "degraded" | "unknown";

export type RunnerReadinessBlockerCode =
  | "feature_flag_disabled"
  | "missing_endpoint"
  | "endpoint_unreachable"
  | "missing_capability_negotiation"
  | "tool_conformance_not_passed"
  | "tool_conformance_revision_mismatch"
  | "tool_surface_not_curated"
  | "tool_side_effect_mode_unverified"
  | "approval_bridge_not_verified"
  | "evidence_commit_not_verified"
  | "abort_propagation_not_verified"
  | "attempt_fencing_not_verified"
  | "workspace_boundary_not_verified"
  | "artifact_import_not_verified"
  | "sandbox_profile_missing"
  | "sandbox_backend_unverified"
  | "sandbox_artifact_import_unverified"
  | "sandbox_network_policy_unverified"
  | "sandbox_policy_unverified"
  | "sandbox_os_unsupported"
  | "sandbox_execution_wrapper_missing"
  | "adapter_not_implemented";

export interface RunnerReadinessBlocker {
  readonly code: RunnerReadinessBlockerCode;
  readonly message: string;
}

export interface RunnerReadinessSummary {
  readonly status: RunnerReadinessStatus;
  readonly checkedAt: string;
  readonly blockingReasons: readonly RunnerReadinessBlocker[];
}

export interface RunnerReadinessReport extends RunnerReadinessSummary {
  readonly runnerId: string;
  readonly featureFlagEnabled: boolean;
  readonly endpointReachable?: boolean;
  readonly capabilityNegotiated?: boolean;
  readonly toolExecutionConformance: RunnerToolExecutionConformanceView;
}

export type RunnerToolSideEffectClass =
  | "none"
  | "workspace_read"
  | "workspace_write"
  | "shell"
  | "network"
  | "provider_or_secret"
  | "external_delivery";

export type RunnerNativeSideEffectMode = "disabled" | "daemon_brokered" | "unverified";

export interface RunnerToolExecutionConformanceView {
  readonly status: "verified" | "blocked";
  readonly adapterRevision: string;
  readonly receiptAdapterRevision: string;
  readonly curatedTools: readonly string[];
  readonly toolSideEffects: Readonly<Record<string, RunnerToolSideEffectClass>>;
  readonly allowedSideEffects: readonly RunnerToolSideEffectClass[];
  readonly nativeSideEffectMode: RunnerNativeSideEffectMode;
  readonly toolSurfaceCurated: boolean;
  readonly approvalBridgeVerified: boolean;
  readonly sandboxBindingVerified: boolean;
  readonly evidenceCommitVerified: boolean;
  readonly abortPropagationVerified: boolean;
  readonly attemptFencingVerified: boolean;
  readonly workspaceBoundaryVerified: boolean;
  readonly artifactImportVerified: boolean;
}

export interface RunnerReadinessResponse {
  readonly cwd: string;
  readonly readiness: RunnerReadinessReport;
}
