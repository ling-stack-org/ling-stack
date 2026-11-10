import type { ApprovalPolicyFormState } from "../types.js";
import type { UpdateApprovalPolicyRequest } from "@ling-stack/contracts";
import { splitLines } from "./shared.js";

export function approvalPolicyFormToPayload(form: ApprovalPolicyFormState): UpdateApprovalPolicyRequest {
  return {
    toolDecisions: form.toolDecisions,
    allowedWritePaths: splitLines(form.allowedWritePathsText),
  };
}
