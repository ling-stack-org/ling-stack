export type RunnerReadinessStatus = "ready" | "blocked" | "degraded" | "unknown";

export type RunnerReadinessBlockerCode =
  | "feature_flag_disabled"
  | "missing_endpoint"
  | "endpoint_unreachable"
  | "missing_capability_negotiation"
  | "conformance_not_passed"
  | "tool_surface_not_curated"
  | "approval_bridge_not_verified"
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
  readonly conformancePassed: boolean;
  readonly endpointReachable?: boolean;
  readonly capabilityNegotiated?: boolean;
  readonly approvalBridgeVerified?: boolean;
  readonly workspaceBoundaryVerified?: boolean;
  readonly artifactImportVerified?: boolean;
}

export interface RunnerReadinessResponse {
  readonly cwd: string;
  readonly readiness: RunnerReadinessReport;
}
