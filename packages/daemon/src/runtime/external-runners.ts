import type { DaemonConfig, ResolvedDaemonConfig } from "../config.js";
import type { RunnerAdapter } from "../context.js";
import { createCodexAppServerAdapter } from "./adapters/codex-app-server.js";
import { createOpenClawAcpAdapter } from "./adapters/openclaw-acp.js";
import type { RunnerToolExecutionConformanceV1 } from "./runner-tool-conformance.js";
import type { RegisteredRunner } from "./runners.js";

export const CODEX_APP_SERVER_RUNNER_ID = "codex-app-server";
export const OPENCLAW_ACP_RUNNER_ID = "openclaw-acp";
export type ExternalRunnerId = typeof CODEX_APP_SERVER_RUNNER_ID | typeof OPENCLAW_ACP_RUNNER_ID;

type RunnerConfig = Pick<ResolvedDaemonConfig, "runners"> | Pick<DaemonConfig, "runners">;

export interface ExternalRunnerProfile {
  readonly id: ExternalRunnerId;
  readonly displayName: string;
  readonly featureFlag: string;
  readonly endpointKind: "baseUrl" | "endpoint";
  readonly adapterRevision: string;
  readonly supportedProviderApis: readonly string[];
  readonly supportedTools: readonly string[];
  readonly toolSideEffects: RegisteredRunner["toolSideEffects"];
  readonly toolExecutionConformance: RunnerToolExecutionConformanceV1;
  readonly capabilities: readonly string[];
  readonly resumeCapabilities: RegisteredRunner["resumeCapabilities"];
}

export const externalRunnerProfiles: readonly ExternalRunnerProfile[] = [
  {
    id: CODEX_APP_SERVER_RUNNER_ID,
    displayName: "Codex App Server",
    featureFlag: "runners.codexAppServer.enabled",
    endpointKind: "baseUrl",
    adapterRevision: "ling-codex-app-server/0.1:adapter-v1",
    supportedProviderApis: ["openai-responses", "openai-completions"],
    supportedTools: ["read", "grep", "find", "ls"],
    toolSideEffects: readOnlyExternalToolSideEffects(),
    toolExecutionConformance: readOnlyExternalToolConformance("ling-codex-app-server/0.1:adapter-v1"),
    capabilities: ["stream_text", "tool_events", "artifacts"],
    resumeCapabilities: { nativeResume: true, hostApprovalContinuation: [] },
  },
  {
    id: OPENCLAW_ACP_RUNNER_ID,
    displayName: "OpenClaw ACP",
    featureFlag: "runners.openclawAcp.enabled",
    endpointKind: "endpoint",
    adapterRevision: "ling-acp/0.1:adapter-v1",
    supportedProviderApis: ["openai-responses", "openai-completions", "anthropic-messages"],
    supportedTools: ["read", "grep", "find", "ls"],
    toolSideEffects: readOnlyExternalToolSideEffects(),
    toolExecutionConformance: readOnlyExternalToolConformance("ling-acp/0.1:adapter-v1"),
    capabilities: ["stream_text", "tool_events", "artifacts"],
    resumeCapabilities: { nativeResume: false, hostApprovalContinuation: [] },
  },
];

export function isExternalRunnerId(id: string): id is ExternalRunnerId {
  return id === CODEX_APP_SERVER_RUNNER_ID || id === OPENCLAW_ACP_RUNNER_ID;
}

export function getExternalRunnerProfile(id: string): ExternalRunnerProfile | undefined {
  return externalRunnerProfiles.find((profile) => profile.id === id);
}

export function listExternalRunnerRegistrations(config: RunnerConfig = {}): RegisteredRunner[] {
  return externalRunnerProfiles.map((profile) => {
    const runnerConfig = readExternalRunnerConfig(config, profile.id);
    const enabled = externalRunnerGatesPassed(runnerConfig);
    return {
      id: profile.id,
      displayName: profile.displayName,
      status: enabled ? "enabled" as const : "disabled" as const,
      adapter: enabled ? createExternalRunnerAdapter(profile, runnerConfig.endpoint) : createDisabledExternalRunnerAdapter(profile.id),
      executionBoundary: "external",
      adapterRevision: profile.adapterRevision,
      supportedProviderApis: profile.supportedProviderApis,
      supportedTools: profile.supportedTools,
      toolSideEffects: profile.toolSideEffects,
      toolExecutionConformance: profile.toolExecutionConformance,
      capabilities: profile.capabilities,
      resumeCapabilities: profile.resumeCapabilities,
      nativeResumeConformance: {
        revision: `${profile.id}:resume-protocol-v1`,
        readinessPassed: runnerConfig.readinessPassed === true,
        conformancePassed: false,
        abortPropagationVerified: false,
        approvalBridgeVerified: false,
      },
      featureFlag: profile.featureFlag,
      disabledReason: enabled ? undefined : futureRunnerDisabledReason(profile.displayName, runnerConfig),
    };
  });
}

export function readExternalRunnerConfig(config: RunnerConfig, runnerId: ExternalRunnerId): {
  readonly enabled?: boolean;
  readonly endpoint?: string;
  readonly readinessPassed?: boolean;
} {
  if (runnerId === CODEX_APP_SERVER_RUNNER_ID) {
    const runner = config.runners?.codexAppServer;
    return {
      enabled: runner?.enabled,
      endpoint: runner?.baseUrl,
      readinessPassed: runner?.readinessPassed,
    };
  }
  const runner = config.runners?.openclawAcp;
  return {
    enabled: runner?.enabled,
    endpoint: runner?.endpoint,
    readinessPassed: runner?.readinessPassed,
  };
}

function externalRunnerGatesPassed(config: ReturnType<typeof readExternalRunnerConfig>): boolean {
  return config.enabled === true &&
    Boolean(config.endpoint) &&
    config.readinessPassed === true;
}

function futureRunnerDisabledReason(displayName: string, config: ReturnType<typeof readExternalRunnerConfig>): string {
  if (!config.enabled) {
    return "Feature flag is disabled.";
  }
  if (!config.endpoint) {
    return `${displayName} feature flag is enabled, but no endpoint is configured.`;
  }
  if (!config.readinessPassed) {
    return `${displayName} feature flag is enabled, but runner readiness has not been confirmed.`;
  }
  return `${displayName} feature flag is enabled, but runner gates did not pass.`;
}

function createExternalRunnerAdapter(profile: ExternalRunnerProfile, endpoint: string | undefined): RunnerAdapter {
  if (!endpoint) {
    return createDisabledExternalRunnerAdapter(profile.id);
  }
  if (profile.id === CODEX_APP_SERVER_RUNNER_ID) {
    return createCodexAppServerAdapter({
      baseUrl: endpoint,
      adapterRevision: profile.adapterRevision,
      toolExecutionConformance: profile.toolExecutionConformance,
    });
  }
  return createOpenClawAcpAdapter({
    endpoint,
    adapterRevision: profile.adapterRevision,
    toolExecutionConformance: profile.toolExecutionConformance,
  });
}

function readOnlyExternalToolSideEffects(): RegisteredRunner["toolSideEffects"] {
  return {
    read: "workspace_read",
    grep: "workspace_read",
    find: "workspace_read",
    ls: "workspace_read",
  };
}

function readOnlyExternalToolConformance(adapterRevision: string): RunnerToolExecutionConformanceV1 {
  return {
    adapterRevision,
    curatedTools: ["read", "grep", "find", "ls"],
    toolSideEffects: readOnlyExternalToolSideEffects(),
    allowedSideEffects: ["none", "workspace_read"],
    nativeSideEffectMode: "disabled",
    toolSurfaceCurated: true,
    approvalBridgeVerified: false,
    sandboxBindingVerified: false,
    evidenceCommitVerified: true,
    abortPropagationVerified: true,
    attemptFencingVerified: true,
    workspaceBoundaryVerified: true,
    artifactImportVerified: true,
  };
}

function createDisabledExternalRunnerAdapter(id: string): RunnerAdapter {
  return {
    async runTask() {
      throw new Error(`Runner ${id} is disabled. Enable and pass conformance before use.`);
    },
  };
}
