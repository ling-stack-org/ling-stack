import type { StartupRefreshResponse, StartupStatusResponse } from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export async function getStartupStatus(cwd: string): Promise<StartupStatusResponse> {
  return daemonClient.getStartupStatus(cwd);
}

export async function refreshStartupStatus(cwd: string): Promise<StartupRefreshResponse> {
  return daemonClient.refreshStartupStatus(cwd);
}
