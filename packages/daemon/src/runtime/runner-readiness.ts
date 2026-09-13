import type {
  RunnerReadinessBlocker,
  RunnerReadinessBlockerCode,
  RunnerReadinessReport,
  RunnerReadinessSummary,
  RunnerToolExecutionConformanceView,
} from "@ling-stack/contracts";
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
import {
  resolveRunnerToolExecutionGate,
  type RegisteredRunner,
  type RunnerRegistry,
  type RunnerToolExecutionGateBlocker,
} from "./runners.js";

export type {
  RunnerReadinessBlocker,
  RunnerReadinessBlockerCode,
  RunnerReadinessReport,
  RunnerReadinessStatus,
  RunnerReadinessSummary,
} from "@ling-stack/contracts";

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
      toolExecutionConformance: buildToolExecutionConformanceView(runner, runner.status === "enabled"),
      blockingReasons: runner.status === "enabled" ? [] : [{ code: "adapter_not_implemented", message: runner.disabledReason ?? "Runner is disabled." }],
    };
  }

  const profile = getExternalRunnerProfile(runner.id);
  const runnerConfig = readExternalRunnerConfig(config, runner.id);
  const blockers: RunnerReadinessBlocker[] = [];
  const featureFlagEnabled = runnerConfig.enabled === true;
  const endpointConfigured = Boolean(runnerConfig.endpoint);
  const readinessPassed = runnerConfig.readinessPassed === true;
  const toolGate = resolveRunnerToolExecutionGate(runner, runner.supportedTools ?? []);
  const toolConformanceBlockers = toolGate.blockers.filter((blocker) => blocker !== "runner_disabled");

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
  if (toolConformanceBlockers.length > 0) {
    blockers.push({ code: "tool_conformance_not_passed", message: "Runner tool execution conformance has not passed." });
  }
  blockers.push(...toolConformanceBlockers.map(readinessBlockerFromToolGate));
  if (!runner.toolExecutionConformance.artifactImportVerified) {
    blockers.push({ code: "artifact_import_not_verified", message: "External runner artifact import is not verified." });
  }

  return finishReport({
    runnerId: runner.id,
    status: "blocked",
    checkedAt,
    featureFlagEnabled,
    endpointReachable: endpointConfigured ? readinessPassed : false,
    capabilityNegotiated: endpointConfigured ? readinessPassed : false,
    toolExecutionConformance: buildToolExecutionConformanceView(runner, toolConformanceBlockers.length === 0),
    blockingReasons: blockers,
  });
}

function buildToolExecutionConformanceView(
  runner: RegisteredRunner,
  verified: boolean,
): RunnerToolExecutionConformanceView {
  if (runner.executionBoundary === "embedded") {
    return {
      status: verified ? "verified" : "blocked",
      adapterRevision: runner.adapterRevision,
      receiptAdapterRevision: runner.adapterRevision,
      curatedTools: runner.supportedTools ?? [],
      toolSideEffects: runner.toolSideEffects,
      allowedSideEffects: [...new Set(Object.values(runner.toolSideEffects))],
      nativeSideEffectMode: "daemon_brokered",
      toolSurfaceCurated: true,
      approvalBridgeVerified: true,
      sandboxBindingVerified: true,
      evidenceCommitVerified: true,
      abortPropagationVerified: true,
      attemptFencingVerified: true,
      workspaceBoundaryVerified: true,
      artifactImportVerified: true,
    };
  }
  const receipt = runner.toolExecutionConformance;
  return {
    status: verified ? "verified" : "blocked",
    adapterRevision: runner.adapterRevision,
    receiptAdapterRevision: receipt.adapterRevision,
    curatedTools: receipt.curatedTools,
    toolSideEffects: receipt.toolSideEffects,
    allowedSideEffects: receipt.allowedSideEffects,
    nativeSideEffectMode: receipt.nativeSideEffectMode,
    toolSurfaceCurated: receipt.toolSurfaceCurated,
    approvalBridgeVerified: receipt.approvalBridgeVerified,
    sandboxBindingVerified: receipt.sandboxBindingVerified,
    evidenceCommitVerified: receipt.evidenceCommitVerified,
    abortPropagationVerified: receipt.abortPropagationVerified,
    attemptFencingVerified: receipt.attemptFencingVerified,
    workspaceBoundaryVerified: receipt.workspaceBoundaryVerified,
    artifactImportVerified: receipt.artifactImportVerified,
  };
}

function readinessBlockerFromToolGate(blocker: RunnerToolExecutionGateBlocker): RunnerReadinessBlocker {
  const code = toolGateBlockerCode(blocker);
  return { code, message: toolGateBlockerMessage(blocker) };
}

function toolGateBlockerCode(blocker: RunnerToolExecutionGateBlocker): RunnerReadinessBlockerCode {
  switch (blocker) {
    case "tool_conformance_revision_mismatch": return "tool_conformance_revision_mismatch";
    case "tool_surface_not_curated":
    case "tool_not_curated":
    case "tool_side_effect_unclassified":
    case "tool_side_effect_mismatch":
    case "tool_side_effect_not_allowed": return "tool_surface_not_curated";
    case "tool_side_effect_mode_unverified":
    case "native_side_effects_disabled": return "tool_side_effect_mode_unverified";
    case "approval_bridge_not_verified": return "approval_bridge_not_verified";
    case "sandbox_binding_not_verified": return "sandbox_backend_unverified";
    case "evidence_commit_not_verified": return "evidence_commit_not_verified";
    case "abort_propagation_not_verified": return "abort_propagation_not_verified";
    case "attempt_fencing_not_verified": return "attempt_fencing_not_verified";
    case "workspace_boundary_not_verified": return "workspace_boundary_not_verified";
    case "runner_disabled": return "tool_conformance_not_passed";
  }
}

function toolGateBlockerMessage(blocker: RunnerToolExecutionGateBlocker): string {
  switch (blocker) {
    case "tool_conformance_revision_mismatch": return "Tool conformance receipt does not match the active adapter revision.";
    case "tool_surface_not_curated": return "External runner tool surface is not curated.";
    case "tool_not_curated": return "A registered external tool is absent from the conformance receipt.";
    case "tool_side_effect_unclassified": return "An external tool has no side-effect classification.";
    case "tool_side_effect_mismatch": return "The runner and receipt disagree about a tool side-effect class.";
    case "tool_side_effect_not_allowed": return "An external tool side-effect class is outside the verified receipt.";
    case "tool_side_effect_mode_unverified": return "External runner native side-effect mode is unverified.";
    case "native_side_effects_disabled": return "External runner native side effects are disabled for the registered tool surface.";
    case "approval_bridge_not_verified": return "External runner approval bridge is not verified.";
    case "sandbox_binding_not_verified": return "External runner sandbox binding is not verified.";
    case "evidence_commit_not_verified": return "External runner tool evidence commit is not verified.";
    case "abort_propagation_not_verified": return "External runner abort propagation is not verified.";
    case "attempt_fencing_not_verified": return "External runner Attempt fencing is not verified.";
    case "workspace_boundary_not_verified": return "External runner workspace boundary is not verified.";
    case "runner_disabled": return "Runner is disabled.";
  }
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
