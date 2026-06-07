import type { ApprovalPolicyFormState, UpdateApprovalPolicyRequest } from "../types.js";
import { splitLines } from "./shared.js";

export function approvalPolicyFormToPayload(form: ApprovalPolicyFormState): UpdateApprovalPolicyRequest {
  return {
    toolDecisions: form.toolDecisions,
    allowedWritePaths: splitLines(form.allowedWritePathsText),
  };
}
