export const LING_ACP_PROTOCOL_VERSION = "0.1";

export const acpCapabilityKeys = [
  "sessionLifecycle",
  "textStreaming",
  "toolCalls",
  "approvalBridge",
  "artifacts",
  "cancellation",
  "workspaceBoundary",
] as const;

export type AcpCapabilityKey = typeof acpCapabilityKeys[number];

export type AcpCapabilities = Readonly<Record<AcpCapabilityKey, boolean>>;

export interface AcpInitializeRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: "initialize";
  readonly params: {
    readonly protocolVersion: string;
    readonly client: {
      readonly name: "ling-stack";
      readonly version: string;
    };
  };
}

export interface AcpRunRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: "session/run";
  readonly params: {
    readonly runnerId: string;
    readonly cwd: string;
    readonly task: {
      readonly id: string;
      readonly title: string;
      readonly prompt: string;
    };
    readonly provider: {
      readonly provider: string;
      readonly model: string;
      readonly api?: string;
    };
    readonly tools: readonly string[];
  };
}

export interface AcpRunResult {
  readonly taskId?: string;
  readonly events?: readonly unknown[];
  readonly messages?: readonly unknown[];
}

export interface AcpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: Partial<AcpCapabilities>;
}

export interface AcpInitializeResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: AcpInitializeResult;
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

export interface AcpRunResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: AcpRunResult;
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

export function createAcpInitializeRequest(id = 1): AcpInitializeRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LING_ACP_PROTOCOL_VERSION,
      client: {
        name: "ling-stack",
        version: "0.0.0",
      },
    },
  };
}

export function createAcpRunRequest(params: AcpRunRequest["params"], id = 2): AcpRunRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "session/run",
    params,
  };
}
