import { useI18n } from "../../i18n.js";
import type { InlineApprovalView } from "../../lib/inline-approvals.js";
import { runtimeApprovalActionSentence } from "../../lib/runtime-approval-presentation.js";
import type { ApprovalResolution } from "./types.js";
import { useApprovalDecisionController } from "./useApprovalDecisionController.js";
import { ConversationDecisionGate } from "./ConversationDecisionGate.js";

export function RuntimeApprovalComposerGate({
  approvals,
  approvalErrors,
  resolvingApprovals,
  surface,
  onResolve,
}: {
  readonly approvals: readonly InlineApprovalView[];
  readonly approvalErrors: Readonly<Record<string, string>>;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly surface: "channel" | "normal_conversation" | "teammate_direct";
  readonly onResolve: (
    approvalId: string,
    decision: ApprovalResolution,
    reason?: string,
    proposedRuleFingerprint?: string,
  ) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const uniqueApprovals = [...new Map(approvals.map((item) => [item.approval.id, item])).values()];
  const current = uniqueApprovals[0];
  const decision = useApprovalDecisionController({
    approval: current?.approval ?? emptyApproval,
    resolvingDecision: current ? resolvingApprovals[current.approval.id] : undefined,
    errorMessage: current ? approvalErrors[current.approval.id] : undefined,
    reasonPolicy: "none",
    onResolve,
  });

  if (!current) return null;
  const approval = current.approval;
  const resolvingDecision = resolvingApprovals[approval.id];
  const actionSentence = runtimeApprovalActionSentence(approval, current.summary, t);
  const proposedCommandRule = approval.actionType === "bash" && approval.availableDecisions?.includes("approve_command_rule")
    ? approval.proposedCommandRule
    : undefined;
  const attemptedAction = decision.attemptedDecision === "deny"
    ? "deny"
    : decision.attemptedDecision === "approve_command_rule"
      ? "allow_secondary"
      : decision.attemptedDecision ? "allow" : undefined;
  const busyAction = resolvingDecision === "deny"
    ? "deny"
    : resolvingDecision === "approve_command_rule" ? "allow_secondary" : resolvingDecision ? "allow" : undefined;

  return (
    <ConversationDecisionGate
      allowLabel={t("Allow once")}
      allowMenuLabel={proposedCommandRule ? t("Allow options") : undefined}
      allowSecondaryDescription={proposedCommandRule
        ? `${t("Allow commands starting with {command} in this workspace", { command: proposedCommandRule.display })}${proposedCommandRule.cwd ? ` · ${t("Working directory")}: ${proposedCommandRule.cwd}` : ""}`
        : undefined}
      allowSecondaryLabel={proposedCommandRule ? t("Allow similar commands") : undefined}
      allowingLabel={t("Allowing")}
      allowingSecondaryLabel={proposedCommandRule ? t("Saving command rule") : undefined}
      attemptedAction={attemptedAction}
      busyAction={busyAction}
      className="runtime-approval-composer-gate"
      decisionId={approval.id}
      decisionKind="runtime_approval"
      denyLabel={t("Deny")}
      denyingLabel={t("Denying")}
      description={actionSentence}
      errorMessage={decision.mutationError}
      focusKey={approval.id}
      retryLabel={t("Retry")}
      surface={surface}
      title={t("Allow this action?")}
      onAllow={() => decision.submit("approve_once")}
      onAllowSecondary={proposedCommandRule
        ? () => decision.submit("approve_command_rule", proposedCommandRule.fingerprint)
        : undefined}
      onDeny={() => decision.submit("deny")}
    />
  );
}

const emptyApproval = {
  id: "runtime-approval-placeholder",
  actionType: "runtime_permission_request",
  title: "",
  description: "",
  risk: "low",
  status: "pending",
  payload: {},
  createdAt: "",
} as const;
