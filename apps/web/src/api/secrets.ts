import type { SecretPurpose, SecretStatusResponse } from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export async function getSecretStatus(ref: string, purpose?: SecretPurpose): Promise<SecretStatusResponse> {
  return daemonClient.getSecretStatus(ref, purpose);
}
