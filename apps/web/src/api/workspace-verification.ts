import type { LingAppServerVerifyCancelParams, StartWorkspaceVerificationRequest, WorkspaceVerificationReport } from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export function getWorkspaceVerification(cwd: string, threadId?: string, operationId?: string): Promise<WorkspaceVerificationReport> {
  return daemonClient.getWorkspaceVerification(cwd, threadId, operationId);
}

export function startWorkspaceVerification(cwd: string, input: StartWorkspaceVerificationRequest): Promise<WorkspaceVerificationReport> {
  return daemonClient.startWorkspaceVerification(cwd, input);
}

export function cancelWorkspaceVerification(cwd: string, input: Omit<LingAppServerVerifyCancelParams, "cwd">) {
  return daemonClient.cancelWorkspaceVerification(cwd, input);
}
