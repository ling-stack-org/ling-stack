import type { EffectiveConfigResponse } from "../types.js";
import { daemonClient } from "./client.js";

export async function getEffectiveConfig(cwd: string): Promise<EffectiveConfigResponse> {
  return daemonClient.getEffectiveConfig(cwd);
}
