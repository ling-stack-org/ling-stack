import type { StartupRefreshResponse, StartupStatusResponse } from "../types.js";
import { daemonClient } from "./client.js";

export async function getStartupStatus(cwd: string): Promise<StartupStatusResponse> {
  return daemonClient.getStartupStatus(cwd);
}

export async function refreshStartupStatus(cwd: string): Promise<StartupRefreshResponse> {
  return daemonClient.refreshStartupStatus(cwd);
}
