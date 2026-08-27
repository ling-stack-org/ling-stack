import { useEffect, useState } from "react";
import { useI18n, type Translate } from "../../i18n.js";
import type { ChannelExecutionProposal } from "../../types.js";
import { ConversationDecisionGate, type ConversationDecisionAction } from "../approvals/ConversationDecisionGate.js";

export function ChannelExecutionProposalComposerGate({
  assigneeLabel,
  errorMessage,
  proposal,
  onAllow,
  onDeny,
}: {
  readonly assigneeLabel: string;
  readonly errorMessage?: string;
  readonly proposal: ChannelExecutionProposal;
  readonly onAllow: (proposal: ChannelExecutionProposal) => Promise<void>;
  readonly onDeny: (proposal: ChannelExecutionProposal) => Promise<void>;
}): React.JSX.Element {
  const { locale, t } = useI18n();
  const [busyAction, setBusyAction] = useState<ConversationDecisionAction>();
  const [attemptedAction, setAttemptedAction] = useState<ConversationDecisionAction>();
  const [localError, setLocalError] = useState("");
  const permissionLabels = proposalPermissionLabels(proposal.requiredTools, t);
  const permissionText = new Intl.ListFormat(locale, { style: "short", type: "conjunction" }).format(permissionLabels);
  const description = t("{agent} wants to start task \"{task}\" and needs {permissions}.", {
    agent: assigneeLabel,
    task: proposal.title,
    permissions: permissionText,
  });
  const visibleError = localError || errorMessage || proposal.blocker?.message || proposal.errorMessage;

  useEffect(() => {
    setBusyAction(undefined);
    setAttemptedAction(undefined);
    setLocalError("");
  }, [proposal.id, proposal.status, proposal.updatedAt]);

  async function decide(action: ConversationDecisionAction): Promise<void> {
    if (busyAction) return;
    setBusyAction(action);
    setAttemptedAction(action);
    setLocalError("");
    try {
      if (action === "allow") {
        await onAllow(proposal);
      } else {
        await onDeny(proposal);
      }
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyAction(undefined);
    }
  }

  return (
    <ConversationDecisionGate
      allowLabel={t("Allow")}
      allowingLabel={t("Allowing")}
      attemptedAction={attemptedAction}
      busyAction={busyAction}
      className="channel-execution-proposal-composer-gate"
      decisionId={proposal.id}
      decisionKind="task_proposal"
      denyLabel={t("Deny")}
      denyingLabel={t("Denying")}
      description={description}
      errorMessage={visibleError}
      focusKey={`${proposal.id}:${proposal.updatedAt}`}
      retryLabel={t("Retry")}
      surface="channel"
      title={t("Allow this task?")}
      onAllow={() => void decide("allow")}
      onDeny={() => void decide("deny")}
    />
  );
}

function proposalPermissionLabels(
  tools: ChannelExecutionProposal["requiredTools"],
  t: Translate,
): readonly string[] {
  const labels = tools.map((tool) => {
    if (tool === "read" || tool === "ls") return t("Read files");
    if (tool === "grep" || tool === "find") return t("Search files");
    if (tool === "edit" || tool === "write") return t("Modify files");
    return t("Run commands");
  });
  return [...new Set(labels.length > 0 ? labels : [t("Workspace access")])];
}
