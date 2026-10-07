import type { RunnerAdapter } from "../../context.js";
import type { RunnerToolExecutionConformanceV1 } from "../runner-tool-conformance.js";
import {
  coerceExternalAgentRunResult,
  runExternalAgentTask,
  type ExternalAgentRunInput,
  type ExternalAgentRunResult,
} from "../external-agent/adapter-runner.js";

export const LING_CODEX_APP_SERVER_PROTOCOL_VERSION = "ling-codex-app-server/0.1";

export const codexAppServerCapabilityKeys = [
  "sessionLifecycle",
  "textStreaming",
  "toolEvents",
  "approvalBridge",
  "artifacts",
  "cancellation",
  "workspaceBoundary",
  "nativeResume",
] as const;

export type CodexAppServerCapabilityKey = typeof codexAppServerCapabilityKeys[number];

export const requiredCodexAppServerCapabilityKeys: readonly CodexAppServerCapabilityKey[] = [
  "sessionLifecycle",
  "textStreaming",
  "toolEvents",
  "artifacts",
  "cancellation",
  "workspaceBoundary",
];

export type CodexAppServerCapabilities = Readonly<Record<CodexAppServerCapabilityKey, boolean>>;

export interface CodexAppServerClientOptions {
  readonly baseUrl: string;
  readonly adapterRevision?: string;
  readonly toolExecutionConformance?: RunnerToolExecutionConformanceV1;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof globalThis.fetch;
}

export interface CodexAppServerInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: Partial<CodexAppServerCapabilities>;
}

export interface CodexAppServerRunResult {
  readonly taskId?: string;
  readonly events?: readonly unknown[];
  readonly messages?: readonly unknown[];
}

export interface CodexAppServerReadinessResult {
  readonly ok: boolean;
  readonly endpointReachable: boolean;
  readonly capabilityNegotiated: boolean;
  readonly message?: string;
}

interface CodexAppServerRpcResponse<T> {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: T;
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

export function createCodexAppServerAdapter(options: CodexAppServerClientOptions): RunnerAdapter {
  return {
    async runTask(runOptions) {
      return runExternalAgentTask({
        runnerId: "codex-app-server",
        backend: "codex-app-server",
        adapterRevision: options.adapterRevision ?? `${LING_CODEX_APP_SERVER_PROTOCOL_VERSION}:adapter-unverified`,
        toolExecutionConformance: options.toolExecutionConformance,
        options: runOptions,
        extraSecrets: [runOptions.provider.apiKey],
        run: (input, signal) => runCodexAppServerTask(options, input, signal),
      });
    },
  };
}

export async function checkCodexAppServerReadiness(options: CodexAppServerClientOptions): Promise<CodexAppServerReadinessResult> {
  try {
    const client = new CodexAppServerClient(options);
    const initialized = await client.initialize();
    const negotiated = negotiateCodexAppServerCapabilities(initialized);
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

export class CodexAppServerClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: CodexAppServerClientOptions) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs ?? 1_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async initialize(signal?: AbortSignal): Promise<CodexAppServerInitializeResult> {
    const response = await this.postJson<CodexAppServerInitializeResult>({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LING_CODEX_APP_SERVER_PROTOCOL_VERSION,
        client: {
          name: "ling-stack",
          version: "0.0.0",
        },
      },
    }, signal);
    if (!response.result || typeof response.result.protocolVersion !== "string" || !isRecord(response.result.capabilities)) {
      throw new Error("Codex app-server initialize response is malformed");
    }
    return response.result;
  }

  async runTask(input: ExternalAgentRunInput, signal?: AbortSignal): Promise<CodexAppServerRunResult> {
    const response = await this.postJson<CodexAppServerRunResult>({
      jsonrpc: "2.0",
      id: 2,
      method: "session/run",
      params: input,
    }, signal);
    if (!response.result || !isRecord(response.result)) {
      throw new Error("Codex app-server run response is malformed");
    }
    return response.result;
  }

  private async postJson<T>(payload: unknown, signal?: AbortSignal): Promise<CodexAppServerRpcResponse<T>> {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Codex app-server endpoint returned ${response.status}`);
      }
      const body = await response.json() as unknown;
      if (!isRpcResponse<T>(body)) {
        throw new Error("Codex app-server response is malformed");
      }
      if (body.error) {
        throw new Error(body.error.message || "Codex app-server request failed");
      }
      return body;
    } finally {
      signal?.removeEventListener("abort", abort);
      clearTimeout(timeout);
    }
  }
}

async function runCodexAppServerTask(
  options: CodexAppServerClientOptions,
  input: ExternalAgentRunInput,
  signal?: AbortSignal,
): Promise<ExternalAgentRunResult> {
  const client = new CodexAppServerClient(options);
  const initialized = await client.initialize(signal);
  const negotiated = negotiateCodexAppServerCapabilities(initialized);
  if (!negotiated.ok) {
    throw new Error(buildCapabilityFailureMessage(negotiated.missingCapabilities));
  }
  return coerceExternalAgentRunResult(await client.runTask(input, signal));
}

function negotiateCodexAppServerCapabilities(result: CodexAppServerInitializeResult): {
  readonly ok: boolean;
  readonly missingCapabilities: readonly CodexAppServerCapabilityKey[];
} {
  const protocolMatched = result.protocolVersion === LING_CODEX_APP_SERVER_PROTOCOL_VERSION;
  const missingCapabilities = requiredCodexAppServerCapabilityKeys.filter((key) => result.capabilities[key] !== true);
  return {
    ok: protocolMatched && missingCapabilities.length === 0,
    missingCapabilities,
  };
}

function buildCapabilityFailureMessage(missingCapabilities: readonly string[]): string {
  return missingCapabilities.length > 0
    ? `Codex app-server capability negotiation failed: missing ${missingCapabilities.join(", ")}.`
    : "Codex app-server capability negotiation failed.";
}

function isRpcResponse<T>(value: unknown): value is CodexAppServerRpcResponse<T> {
  return isRecord(value) && value.jsonrpc === "2.0" && typeof value.id === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
