import {
  LING_ACP_PROTOCOL_VERSION,
  type AcpCapabilityKey,
  type AcpInitializeResult,
} from "./protocol.js";

export const requiredAcpCapabilities: readonly AcpCapabilityKey[] = [
  "sessionLifecycle",
  "textStreaming",
  "toolCalls",
  "artifacts",
  "cancellation",
  "workspaceBoundary",
];

export interface AcpCapabilityNegotiationResult {
  readonly ok: boolean;
  readonly missingCapabilities: readonly AcpCapabilityKey[];
  readonly protocolVersionMatched: boolean;
}

export function negotiateAcpCapabilities(result: AcpInitializeResult): AcpCapabilityNegotiationResult {
  const protocolVersionMatched = result.protocolVersion === LING_ACP_PROTOCOL_VERSION;
  const missingCapabilities = requiredAcpCapabilities.filter((capability) => result.capabilities[capability] !== true);
  return {
    ok: protocolVersionMatched && missingCapabilities.length === 0,
    missingCapabilities,
    protocolVersionMatched,
  };
}
