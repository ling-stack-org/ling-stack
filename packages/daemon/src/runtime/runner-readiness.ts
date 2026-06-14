import type { ResolvedDaemonConfig } from "../config.js";
import { checkCodexAppServerReadiness } from "./adapters/codex-app-server.js";
import { checkOpenClawAcpReadiness } from "./adapters/openclaw-acp.js";
import {
  CODEX_APP_SERVER_RUNNER_ID,
  getExternalRunnerProfile,
  isExternalRunnerId,
  OPENCLAW_ACP_RUNNER_ID,
  readExternalRunnerConfig,
} from "./external-runners.js";
import type { RegisteredRunner, RunnerRegistry } from "./runners.js";

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

export interface RunnerReadinessOptions {
  readonly now?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof globalThis.fetch;
}

export function listRunnerReadinessSummaries(
  runnerRegistry: RunnerRegistry,
  config: ResolvedDaemonConfig,
  now = new Date().toISOString(),
): Map<string, RunnerReadinessSummary> {
  return new Map(runnerRegistry.list().map((runner) => [runner.id, summarizeRunnerReadiness(buildStaticRunnerReadinessReport(runner, config, now))]));
}

export function summarizeRunnerReadiness(report: RunnerReadinessReport): RunnerReadinessSummary {
  return {
    status: report.status,
    checkedAt: report.checkedAt,
    blockingReasons: report.blockingReasons,
  };
}

export async function buildRunnerReadinessReport(
  runner: RegisteredRunner,
  config: ResolvedDaemonConfig,
  options: RunnerReadinessOptions = {},
): Promise<RunnerReadinessReport> {
  const now = options.now ?? new Date().toISOString();
  const report = buildStaticRunnerReadinessReport(runner, config, now);
  if (
    isExternalRunnerId(runner.id) &&
    report.featureFlagEnabled &&
    readExternalRunnerConfig(config, runner.id).endpoint
  ) {
    const runnerConfig = readExternalRunnerConfig(config, runner.id);
    const doctor = await checkExternalRunnerReadiness(runner.id, {
      endpoint: runnerConfig.endpoint ?? "",
      timeoutMs: options.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    const blockers = report.blockingReasons.filter((blocker) => blocker.code !== "endpoint_unreachable" && blocker.code !== "missing_capability_negotiation");
    if (!doctor.ok) {
      blockers.push({ code: "endpoint_unreachable", message: "ACP endpoint readiness probe failed." });
    }
    if (!doctor.capabilityNegotiated) {
      blockers.push({ code: "missing_capability_negotiation", message: "External runner capability negotiation did not confirm required Ling capabilities." });
    }
    return finishReport({
      ...report,
      endpointReachable: doctor.endpointReachable,
      capabilityNegotiated: doctor.capabilityNegotiated,
      blockingReasons: blockers,
    });
  }
  return report;
}

export function buildStaticRunnerReadinessReport(
  runner: RegisteredRunner,
  config: ResolvedDaemonConfig,
  checkedAt: string,
): RunnerReadinessReport {
  if (!isExternalRunnerId(runner.id)) {
    return {
      runnerId: runner.id,
      status: runner.status === "enabled" ? "ready" : "blocked",
      checkedAt,
      featureFlagEnabled: runner.status === "enabled",
      conformancePassed: runner.status === "enabled",
      approvalBridgeVerified: runner.status === "enabled",
      workspaceBoundaryVerified: runner.status === "enabled",
      artifactImportVerified: runner.status === "enabled",
      blockingReasons: runner.status === "enabled" ? [] : [{ code: "adapter_not_implemented", message: runner.disabledReason ?? "Runner is disabled." }],
    };
  }

  const profile = getExternalRunnerProfile(runner.id);
  const runnerConfig = readExternalRunnerConfig(config, runner.id);
  const blockers: RunnerReadinessBlocker[] = [];
  const featureFlagEnabled = runnerConfig.enabled === true;
  const endpointConfigured = Boolean(runnerConfig.endpoint);
  const readinessPassed = runnerConfig.readinessPassed === true;
  const conformancePassed = runnerConfig.conformancePassed === true;
  const sharedGatesVerified = conformancePassed;

  if (!featureFlagEnabled) {
    blockers.push({ code: "feature_flag_disabled", message: "Feature flag is disabled." });
  }
  if (!endpointConfigured) {
    blockers.push({
      code: "missing_endpoint",
      message: profile?.endpointKind === "baseUrl" ? "Runner base URL is not configured." : "Runner endpoint is not configured.",
    });
  }
  if (endpointConfigured && !readinessPassed) {
    blockers.push({ code: "endpoint_unreachable", message: "Runner readiness has not been confirmed." });
    blockers.push({ code: "missing_capability_negotiation", message: "Runner capability negotiation has not been confirmed." });
  }
  if (!conformancePassed) {
    blockers.push({ code: "conformance_not_passed", message: "Runner conformance has not passed." });
  }
  if (!sharedGatesVerified) {
    blockers.push({ code: "tool_surface_not_curated", message: "External runner tool surface has not been verified by conformance." });
    blockers.push({ code: "approval_bridge_not_verified", message: "External runner approval bridge has not been verified by conformance." });
    blockers.push({ code: "workspace_boundary_not_verified", message: "External runner workspace boundary has not been verified by conformance." });
    blockers.push({ code: "artifact_import_not_verified", message: "External runner artifact import has not been verified by conformance." });
  }

  return finishReport({
    runnerId: runner.id,
    status: "blocked",
    checkedAt,
    featureFlagEnabled,
    conformancePassed,
    endpointReachable: endpointConfigured ? readinessPassed : false,
    capabilityNegotiated: endpointConfigured ? readinessPassed : false,
    approvalBridgeVerified: sharedGatesVerified,
    workspaceBoundaryVerified: sharedGatesVerified,
    artifactImportVerified: sharedGatesVerified,
    blockingReasons: blockers,
  });
}

async function checkExternalRunnerReadiness(
  runnerId: typeof CODEX_APP_SERVER_RUNNER_ID | typeof OPENCLAW_ACP_RUNNER_ID,
  input: {
    readonly endpoint: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: typeof globalThis.fetch;
  },
): Promise<{
  readonly ok: boolean;
  readonly endpointReachable: boolean;
  readonly capabilityNegotiated: boolean;
}> {
  if (runnerId === CODEX_APP_SERVER_RUNNER_ID) {
    return checkCodexAppServerReadiness({
      baseUrl: input.endpoint,
      timeoutMs: input.timeoutMs,
      fetchImpl: input.fetchImpl,
    });
  }
  return checkOpenClawAcpReadiness({
    endpoint: input.endpoint,
    timeoutMs: input.timeoutMs,
    fetchImpl: input.fetchImpl,
  });
}

function finishReport(report: RunnerReadinessReport): RunnerReadinessReport {
  const uniqueBlockers = dedupeBlockers(report.blockingReasons);
  return {
    ...report,
    status: uniqueBlockers.length === 0 ? "ready" : "blocked",
    blockingReasons: uniqueBlockers,
  };
}

function dedupeBlockers(blockers: readonly RunnerReadinessBlocker[]): readonly RunnerReadinessBlocker[] {
  const seen = new Set<string>();
  const result: RunnerReadinessBlocker[] = [];
  for (const blocker of blockers) {
    if (seen.has(blocker.code)) {
      continue;
    }
    seen.add(blocker.code);
    result.push(blocker);
  }
  return result;
}
