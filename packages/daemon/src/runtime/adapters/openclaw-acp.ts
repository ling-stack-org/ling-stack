import type { RunnerAdapter } from "../../context.js";
import type { RunnerToolExecutionConformanceV1 } from "../runner-tool-conformance.js";
import { AcpClient, type AcpClientOptions } from "../acp/client.js";
import { negotiateAcpCapabilities } from "../acp/capabilities.js";
import {
  coerceExternalAgentRunResult,
  runExternalAgentTask,
  type ExternalAgentRunInput,
  type ExternalAgentRunResult,
} from "../external-agent/adapter-runner.js";

export interface OpenClawAcpAdapterOptions extends AcpClientOptions {
  readonly adapterRevision?: string;
  readonly toolExecutionConformance?: RunnerToolExecutionConformanceV1;
}

export interface OpenClawAcpReadinessResult {
  readonly ok: boolean;
  readonly endpointReachable: boolean;
  readonly capabilityNegotiated: boolean;
  readonly message?: string;
}

export function createOpenClawAcpAdapter(options: OpenClawAcpAdapterOptions): RunnerAdapter {
  return {
    async runTask(runOptions) {
      return runExternalAgentTask({
        runnerId: "openclaw-acp",
        backend: "openclaw-acp",
        adapterRevision: options.adapterRevision ?? "ling-acp/0.1:adapter-unverified",
        toolExecutionConformance: options.toolExecutionConformance,
        options: runOptions,
        extraSecrets: [runOptions.provider.apiKey],
        run: (input, signal) => runOpenClawAcpTask(options, input, signal),
      });
    },
  };
}

export async function checkOpenClawAcpReadiness(options: OpenClawAcpAdapterOptions): Promise<OpenClawAcpReadinessResult> {
  try {
    const client = new AcpClient(options);
    const initialized = await client.initialize();
    const negotiated = negotiateAcpCapabilities(initialized);
    return {
      ok: negotiated.ok,
      endpointReachable: true,
      capabilityNegotiated: negotiated.ok,
      message: negotiated.ok ? undefined : buildCapabilityFailureMessage(negotiated.missingCapabilities),
    };
  } catch (error) {
    return {
      ok: false,
      endpointReachable: false,
      capabilityNegotiated: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runOpenClawAcpTask(
  options: OpenClawAcpAdapterOptions,
  input: ExternalAgentRunInput,
  signal?: AbortSignal,
): Promise<ExternalAgentRunResult> {
  const client = new AcpClient(options);
  const initialized = await client.initialize(signal);
  const negotiated = negotiateAcpCapabilities(initialized);
  if (!negotiated.ok) {
    throw new Error(buildCapabilityFailureMessage(negotiated.missingCapabilities));
  }
  return coerceExternalAgentRunResult(await client.runTask({
    runnerId: input.runnerId,
    cwd: input.cwd,
    task: input.task,
    provider: input.provider,
    tools: input.tools,
  }, signal));
}

function buildCapabilityFailureMessage(missingCapabilities: readonly string[]): string {
  return missingCapabilities.length > 0
    ? `OpenClaw ACP capability negotiation failed: missing ${missingCapabilities.join(", ")}.`
    : "OpenClaw ACP capability negotiation failed.";
}
