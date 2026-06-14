import { AcpClient } from "./client.js";
import { negotiateAcpCapabilities } from "./capabilities.js";

export interface AcpDoctorInput {
  readonly endpoint: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof globalThis.fetch;
}

export interface AcpDoctorResult {
  readonly ok: boolean;
  readonly endpointReachable: boolean;
  readonly capabilityNegotiated: boolean;
  readonly errorCode?: "endpoint_unreachable" | "capability_negotiation_failed";
}

export async function checkAcpDoctor(input: AcpDoctorInput): Promise<AcpDoctorResult> {
  try {
    const result = await new AcpClient(input).initialize();
    const negotiated = negotiateAcpCapabilities(result);
    return {
      ok: negotiated.ok,
      endpointReachable: true,
      capabilityNegotiated: negotiated.ok,
      errorCode: negotiated.ok ? undefined : "capability_negotiation_failed",
    };
  } catch {
    return {
      ok: false,
      endpointReachable: false,
      capabilityNegotiated: false,
      errorCode: "endpoint_unreachable",
    };
  }
}
