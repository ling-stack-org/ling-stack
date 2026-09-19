import type {
  ApprovalListResponse,
  ApprovalMutationResponse,
  ApprovalPolicyFormState,
  ApprovalPolicyResponse,
} from "../types.js";
import { approvalPolicyFormToPayload } from "./approval-payloads.js";
import { daemonClient } from "./client.js";

export async function listApprovals(
  cwd: string,
  options: { readonly status?: string; readonly runId?: string; readonly mediaJobId?: string } = {},
): Promise<ApprovalListResponse> {
  return daemonClient.listApprovals(cwd, options);
}

export async function getApprovalPolicy(cwd: string): Promise<ApprovalPolicyResponse> {
  return daemonClient.getApprovalPolicy(cwd);
}

export async function updateApprovalPolicy(cwd: string, form: ApprovalPolicyFormState): Promise<ApprovalPolicyResponse> {
  return daemonClient.updateApprovalPolicy(cwd, approvalPolicyFormToPayload(form));
}

export async function approveApproval(cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse> {
  return resolveApproval(cwd, approvalId, "approve", reason);
}

export async function denyApproval(cwd: string, approvalId: string, reason?: string): Promise<ApprovalMutationResponse> {
  return resolveApproval(cwd, approvalId, "deny", reason);
}

async function resolveApproval(
  cwd: string,
  approvalId: string,
  action: "approve" | "deny",
  reason?: string,
): Promise<ApprovalMutationResponse> {
  return action === "approve"
    ? daemonClient.approveApproval(cwd, approvalId, reason)
    : daemonClient.denyApproval(cwd, approvalId, reason);
}
