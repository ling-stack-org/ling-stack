import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  buildChannelTeamRiskReviewDecision,
  defaultApprovalToolDecisions,
  riskyRunTools,
  type ApprovalPayload,
  type ApprovalPolicy,
  type ApprovalRequest,
  type ApprovalRisk,
  type ApprovalToolDecision,
  type CreateApprovalRequestInput,
  type EffectiveRunPolicySnapshot,
  type RunTool,
  type SkillApprovalProfile,
} from "@ling-stack/core";
import { applyRiskReviewToApprovalInput, applyRiskReviewToPolicyDecision } from "./risk-review-approval-adapter.js";
import { evaluatePlanModeApprovalDenial } from "./plan-mode-policy.js";

export interface ApprovalActionRequest {
  readonly toolName: string;
  readonly cwd: string;
  readonly defaultApproval?: ApprovalToolDecision;
}

export interface ApprovalActionPolicyDecision {
  readonly decision: ApprovalToolDecision;
  readonly reason: string;
}

/** Pure policy only: callers own storage, native replies and actual tool execution. */
export function evaluateApprovalActionPolicy(input: {
  readonly policy: ApprovalPolicy;
  readonly request: ApprovalActionRequest;
  readonly approvalInput: CreateApprovalRequestInput;
  readonly approvalProfile?: SkillApprovalProfile;
  readonly effectivePolicySnapshot?: EffectiveRunPolicySnapshot;
}): {
  readonly approvalInput: CreateApprovalRequestInput;
  readonly policyDecision: ApprovalActionPolicyDecision;
  readonly mandatoryApproval: boolean;
  readonly commandRuleEligible: boolean;
} {
  const riskReview = buildChannelTeamRiskReviewDecision({
    actionType: input.approvalInput.actionType,
    risk: input.approvalInput.risk,
    payload: input.approvalInput.payload,
  });
  const approvalInput = applyRiskReviewToApprovalInput(input.approvalInput, riskReview);
  let policyDecision = applyRiskReviewToPolicyDecision(
    evaluateApprovalPolicy(input.policy, input.request, approvalInput.payload), riskReview,
  );
  const planModeDenial = evaluatePlanModeApprovalDenial({
    effectivePolicySnapshot: input.effectivePolicySnapshot,
    actionType: approvalInput.actionType,
    payload: approvalInput.payload,
  });
  if (planModeDenial) policyDecision = { decision: "deny", reason: planModeDenial.reason };

  const mandatoryApproval = approvalProfileRequiresApproval(input.approvalProfile, input.request.toolName, approvalInput.actionType);
  if (mandatoryApproval && policyDecision.decision === "allow") {
    policyDecision = { decision: "ask",
      reason: `Ling Stack approval profile requires approval for ${input.request.toolName} (${approvalInput.actionType}).` };
  }
  return {
    approvalInput,
    policyDecision,
    mandatoryApproval,
    commandRuleEligible: policyDecision.decision === "ask" && !mandatoryApproval
      && riskReview.status === "not_required" && approvalInput.payload.type === "bash"
      && approvalInput.risk !== "high" && approvalInput.risk !== "critical",
  };
}

export function evaluateApprovalPolicy(
  policy: ApprovalPolicy,
  request: ApprovalActionRequest,
  payload: ApprovalPayload,
): ApprovalActionPolicyDecision {
  if (payload.type === "host_capability") {
    if (request.defaultApproval === "deny") {
      return { decision: "deny", reason: `Host policy denied ${payload.capabilityId}.` };
    }
    return { decision: "ask", reason: `Separate approval is required for ${payload.capabilityId}.` };
  }
  const toolDecision = isRunTool(request.toolName)
    ? policy.toolDecisions[request.toolName] ?? defaultApprovalToolDecisions[request.toolName]
    : request.defaultApproval ?? "ask";
  if (toolDecision === "deny") {
    return { decision: "deny", reason: `Ling Stack policy denied ${request.toolName}.` };
  }
  if (payload.type === "file_write" || payload.type === "file_edit") {
    const deniedPath = getPayloadWritePaths(payload).find(path => !isPathWithinAllowedWritePaths(path, request.cwd, policy.allowedWritePaths));
    if (deniedPath) {
      return { decision: "deny", reason: `Ling Stack policy denied ${request.toolName}: ${deniedPath} is outside allowed write paths.` };
    }
  }
  if (toolDecision === "allow") {
    return { decision: "allow", reason: `Ling Stack policy allowed ${request.toolName}.` };
  }
  return { decision: "ask", reason: `Ling Stack policy requires approval for ${request.toolName}.` };
}

export function classifyApprovalRisk(request: ApprovalActionRequest, payload: ApprovalPayload): ApprovalRisk {
  if (payload.type === "bash") {
    if (payload.riskFlags.includes("git_force_push")) return "critical";
    return payload.riskFlags.length > 0 ? "high" : "medium";
  }
  if (payload.type === "file_write" || payload.type === "file_edit") {
    return getPayloadWritePaths(payload).some(path => isOutsideWorkspace(path, request.cwd)) ? "high" : "medium";
  }
  return payload.type === "tool_call" ? "low" : "medium";
}

export function isRunTool(value: unknown): value is RunTool {
  return value === "read" || value === "grep" || value === "find" || value === "ls" || value === "bash" || value === "edit" || value === "write";
}

function approvalProfileRequiresApproval(
  profile: SkillApprovalProfile | undefined,
  toolName: string,
  actionType: ApprovalRequest["actionType"],
): boolean {
  if (!profile || profile.mode === "none") return false;
  if (profile.mode === "strict" && riskyRunTools.includes(toolName as (typeof riskyRunTools)[number])) return true;
  return profile.requiredForTools?.includes(toolName as RunTool) === true || profile.requiredForActions?.includes(actionType) === true;
}

function isOutsideWorkspace(inputPath: string, cwd: string): boolean {
  if (inputPath === "<unknown>") return true;
  const absolutePath = isAbsolute(inputPath) ? inputPath : resolvePath(cwd, inputPath);
  const relativePath = relative(cwd, absolutePath);
  return relativePath.startsWith("..") || isAbsolute(relativePath);
}

function isPathWithinAllowedWritePaths(inputPath: string, cwd: string, allowedWritePaths: readonly string[]): boolean {
  if (inputPath === "<unknown>") return false;
  const absolutePath = isAbsolute(inputPath) ? inputPath : resolvePath(cwd, inputPath);
  return allowedWritePaths.some(allowedPath => {
    const scopePath = isAbsolute(allowedPath) ? allowedPath : resolvePath(cwd, allowedPath);
    const relativePath = relative(scopePath, absolutePath);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  });
}

function getPayloadWritePaths(payload: Extract<ApprovalPayload, { readonly type: "file_write" | "file_edit" }>): readonly string[] {
  return payload.touchedPaths && payload.touchedPaths.length > 0 ? payload.touchedPaths : [payload.path];
}
