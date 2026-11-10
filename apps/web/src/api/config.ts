import type { EffectiveConfigResponse } from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export async function getEffectiveConfig(cwd: string): Promise<EffectiveConfigResponse> {
  return daemonClient.getEffectiveConfig(cwd);
}
