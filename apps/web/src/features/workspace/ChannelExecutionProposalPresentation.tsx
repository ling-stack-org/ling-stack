import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert, Loader2, Play } from "lucide-react";
import { useI18n } from "../../i18n.js";
import type { ChannelExecutionProposal } from "../../types.js";

export function ChannelExecutionProposalSummary({
  proposal,
  assigneeAvatar,
  assigneeLabel,
  onOpen,
}: {
  readonly proposal: ChannelExecutionProposal;
  readonly assigneeAvatar: ReactNode;
  readonly assigneeLabel: string;
  readonly onOpen: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const statusIcon = proposal.status === "accepted"
    ? <CheckCircle2 aria-hidden="true" size={14} />
    : proposal.status === "blocked" || proposal.status === "run_failed"
      ? <CircleAlert aria-hidden="true" size={14} />
      : proposal.status === "draft" && isProposalShaping(proposal)
        ? <Loader2 aria-hidden="true" className="spin" size={14} />
        : <Play aria-hidden="true" size={14} />;
  return (
    <div className="channel-execution-proposal-summary-row">
      <span className="channel-execution-proposal-summary-avatar" aria-label={assigneeLabel}>
        {assigneeAvatar}
      </span>
      <div className={`channel-execution-proposal-summary ${proposal.status}`} aria-label={t("Task proposal summary")}>
        <span className="channel-execution-proposal-summary-icon">{statusIcon}</span>
        <span className="channel-execution-proposal-summary-copy">
          <strong>{proposal.title}</strong>
          <small>{assigneeLabel} · {t(executionProposalStatusLabel(proposal))}</small>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onOpen}>
          {t("View task")}
        </button>
      </div>
    </div>
  );
}

function executionProposalStatusLabel(proposal: ChannelExecutionProposal): string {
  if (proposal.status === "draft") {
    if (proposal.shaping?.status === "collecting_context" || proposal.shaping?.status === "collecting_teammate_input") {
      return "Preparing task";
    }
    if (proposal.shaping?.status === "needs_user_clarification") {
      return "Needs input";
    }
    return "Pending confirmation";
  }
  if (proposal.status === "accepted") return "Authorized";
  if (proposal.status === "blocked") return "Needs handling";
  if (proposal.status === "run_failed") return "Execution failed";
  if (proposal.status === "superseded") return "Superseded";
  return "Cancelled";
}

function isProposalShaping(proposal: ChannelExecutionProposal): boolean {
  return proposal.shaping?.status === "collecting_context" || proposal.shaping?.status === "collecting_teammate_input";
}
