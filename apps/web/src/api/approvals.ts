import type {
  ApprovalDetailResponse,
  ApprovalCommandRuleListResponse,
  ApprovalCommandRuleMutationResponse,
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

export async function getApproval(cwd: string, approvalId: string): Promise<ApprovalDetailResponse> {
  return daemonClient.getApproval(cwd, approvalId);
}

export async function updateApprovalPolicy(cwd: string, form: ApprovalPolicyFormState): Promise<ApprovalPolicyResponse> {
  return daemonClient.updateApprovalPolicy(cwd, approvalPolicyFormToPayload(form));
}

export async function listApprovalCommandRules(cwd: string): Promise<ApprovalCommandRuleListResponse> {
  return daemonClient.listApprovalCommandRules(cwd);
}

export async function revokeApprovalCommandRule(cwd: string, ruleId: string): Promise<ApprovalCommandRuleMutationResponse> {
  return daemonClient.revokeApprovalCommandRule(cwd, ruleId);
}

export async function approveApproval(
  cwd: string,
  approvalId: string,
  input: {
    readonly reason?: string;
    readonly decisionKind?: "approve_once" | "approve_command_rule";
    readonly proposedRuleFingerprint?: string;
  } = {},
): Promise<ApprovalMutationResponse> {
  return daemonClient.approveApproval(cwd, approvalId, input);
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
    ? daemonClient.approveApproval(cwd, approvalId, { reason, decisionKind: "approve_once" })
    : daemonClient.denyApproval(cwd, approvalId, reason);
}
