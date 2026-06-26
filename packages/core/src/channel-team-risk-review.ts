import type { ApprovalActionType, ApprovalPayload, ApprovalRisk } from "./approval-types.js";
import type { ChannelTeamRiskReviewDecision } from "./channel-team-types.js";
import type { ExecutionScope } from "./run-types.js";

export interface BuildChannelTeamRiskReviewDecisionInput {
  readonly actionType: ApprovalActionType;
  readonly risk: ApprovalRisk;
  readonly payload?: ApprovalPayload;
  readonly scopes?: readonly ExecutionScope[];
  readonly reviewerAvailable?: boolean;
  readonly unavailableReviewerBehavior?: "ask" | "block";
}

const RISK_RANK: Record<ApprovalRisk | "none", number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function buildChannelTeamRiskReviewDecision(
  input: BuildChannelTeamRiskReviewDecisionInput,
): ChannelTeamRiskReviewDecision {
  const triggers = new Map<string, string>();
  addBaseRiskTriggers(triggers, input);
  addActionTypeTriggers(triggers, input.actionType);
  addScopeTriggers(triggers, input.scopes ?? []);
  if (input.payload) {
    addPayloadTriggers(triggers, input.payload);
  }

  if (triggers.size === 0) {
    return {
      status: "not_required",
      risk: input.risk,
      reasons: [],
      triggerCodes: [],
    };
  }

  const risk = maxRisk(input.risk, triggers.has("critical_risk") || triggers.has("git_force_push") ? "critical" : "high");
  const reviewerUnavailable = input.reviewerAvailable === false;
  const shouldBlock = reviewerUnavailable && input.unavailableReviewerBehavior === "block";
  const unavailableReason = "Risk review reviewer is unavailable; explicit approval is required before proceeding.";
  return {
    status: shouldBlock ? "blocked" : "required",
    risk,
    reasons: reviewerUnavailable ? [...triggers.values(), unavailableReason] : [...triggers.values()],
    triggerCodes: [...triggers.keys()],
  };
}

export function formatChannelTeamRiskReviewReason(decision: ChannelTeamRiskReviewDecision): string {
  if (decision.status === "not_required") {
    return "Channel Team Risk Review is not required.";
  }
  const reason = decision.reasons[0] ?? "High-risk action requires explicit review.";
  return `Channel Team Risk Review ${decision.status === "blocked" ? "blocked" : "requires approval"}: ${reason}`;
}

function addBaseRiskTriggers(
  triggers: Map<string, string>,
  input: BuildChannelTeamRiskReviewDecisionInput,
): void {
  if (input.risk === "critical") {
    triggers.set("critical_risk", "Critical-risk action requires risk review.");
  }
}

function addActionTypeTriggers(triggers: Map<string, string>, actionType: ApprovalActionType): void {
  if (actionType === "deploy") {
    triggers.set("deploy_or_production_mutation", "Deploy or production mutation requires risk review.");
  }
  if (actionType === "external_send") {
    triggers.set("external_send_or_account_mutation", "External send or account mutation requires risk review.");
  }
  if (actionType === "credential_change" || actionType === "provider_change") {
    triggers.set("credential_or_provider_change", "Credential, auth, provider secret, or provider configuration change requires risk review.");
  }
  if (actionType === "git_push") {
    triggers.set("git_push", "Git push requires risk review before changing remote history or branches.");
  }
}

function addScopeTriggers(triggers: Map<string, string>, scopes: readonly ExecutionScope[]): void {
  if (scopes.includes("deployment")) {
    triggers.set("deploy_or_production_mutation", "Deploy or production mutation requires risk review.");
  }
  if (scopes.includes("credential") || scopes.includes("provider_config")) {
    triggers.set("credential_or_provider_change", "Credential, auth, provider secret, or provider configuration change requires risk review.");
  }
}

function addPayloadTriggers(triggers: Map<string, string>, payload: ApprovalPayload): void {
  if (payload.type === "bash") {
    addBashRiskTriggers(triggers, payload.command, payload.riskFlags);
    return;
  }
  if (payload.type === "deploy") {
    triggers.set("deploy_or_production_mutation", "Deploy or production mutation requires risk review.");
    return;
  }
  if (payload.type === "external_send" || payload.type === "external_action") {
    triggers.set("external_send_or_account_mutation", "External send or account mutation requires risk review.");
    return;
  }
  if (payload.type === "provider_change") {
    triggers.set("credential_or_provider_change", "Credential, auth, provider secret, or provider configuration change requires risk review.");
    return;
  }
  if (payload.type === "runtime_permission_request") {
    addRuntimePermissionTriggers(triggers, payload);
  }
}

function addBashRiskTriggers(
  triggers: Map<string, string>,
  command: string,
  riskFlags: readonly string[],
): void {
  const flags = new Set(riskFlags);
  if (flags.has("destructive_remove")) {
    triggers.set("destructive_delete", "Destructive delete requires risk review.");
  }
  if (flags.has("git_reset_hard")) {
    triggers.set("git_reset_hard", "git reset --hard requires risk review.");
  }
  if (flags.has("git_force_push")) {
    triggers.set("git_force_push", "Force push requires risk review.");
  }
  if (flags.has("recursive_permission_change")) {
    triggers.set("recursive_permission_mutation", "Recursive permission mutation requires risk review.");
  }
  if (flags.has("disk_mutation")) {
    triggers.set("disk_mutation", "Disk mutation requires risk review.");
  }
  if (flags.has("external_mutation")) {
    triggers.set("deploy_or_production_mutation", "Deploy or production mutation requires risk review.");
  }
  if (flags.has("remote_script_execution")) {
    triggers.set("remote_script_execution", "Remote script execution requires risk review.");
  }
  if (/\bgit\s+push\b[^\n]*(?:\borigin\b\s+)?(?:main|master)\b/i.test(command)) {
    triggers.set("protected_branch_push", "Protected-looking branch push requires risk review.");
  }
  if (/\b(?:export\s+\w*(?:KEY|TOKEN|SECRET|PASSWORD)|security\s+|op\s+|pass\s+)\b/i.test(command)) {
    triggers.set("credential_or_provider_change", "Credential, auth, provider secret, or provider configuration change requires risk review.");
  }
}

function addRuntimePermissionTriggers(
  triggers: Map<string, string>,
  payload: Extract<ApprovalPayload, { readonly type: "runtime_permission_request" }>,
): void {
  const scope = payload.requestedScope;
  if (scope.kind === "write_scope" || scope.kind === "runner_capability") {
    triggers.set("runtime_permission_expansion", "Runtime permission expansion requires risk review.");
    return;
  }
  if (scope.kind === "core_tool" && scope.tools.some((tool) => tool === "bash" || tool === "edit" || tool === "write")) {
    triggers.set("runtime_permission_expansion", "Runtime permission expansion requires risk review.");
    return;
  }
  if (scope.kind === "mcp_tool" && scope.sideEffectLevel !== "read") {
    triggers.set("runtime_permission_expansion", "Runtime permission expansion requires risk review.");
  }
}

function maxRisk(left: ApprovalRisk, right: ApprovalRisk): ApprovalRisk {
  return RISK_RANK[left] >= RISK_RANK[right] ? left : right;
}
