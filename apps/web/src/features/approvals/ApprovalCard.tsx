import type { ExternalActionBusyState } from "../../domains/approvals/approval-domain-types.js";
import type { ApprovalRequest, ExternalWorkActionView } from "../../types.js";
import { ApprovalDecisionPanel } from "./ApprovalDecisionPanel.js";
import { ApprovalExternalActionSection } from "./ApprovalExternalActionSection.js";
import { ApprovalPermissionDelta } from "./ApprovalPermissionDelta.js";
import { ApprovalSummary } from "./ApprovalSummary.js";
import { ApprovalTechnicalDetails } from "./ApprovalTechnicalDetails.js";
import type { ApprovalResolution } from "./types.js";

export type { ExternalActionBusyState } from "../../domains/approvals/approval-domain-types.js";

export function ApprovalCard({
  approval,
  compact = false,
  selected = false,
  decisionEnabled = true,
  externalAction,
  externalActionBusy,
  cwd,
  errorMessage,
  resolvingDecision,
  onSelect,
  onResolve,
  onExecuteExternalAction,
  onCancelExternalAction,
  onRefreshExternalAction,
}: {
  readonly approval: ApprovalRequest;
  readonly compact?: boolean;
  readonly selected?: boolean;
  readonly decisionEnabled?: boolean;
  readonly externalAction?: ExternalWorkActionView;
  readonly externalActionBusy?: ExternalActionBusyState;
  readonly cwd?: string;
  readonly errorMessage?: string;
  readonly resolvingDecision?: ApprovalResolution;
  readonly onSelect?: (approvalId: string) => void;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onExecuteExternalAction?: (actionId: string) => void;
  readonly onCancelExternalAction?: (actionId: string) => void;
  readonly onRefreshExternalAction?: () => void;
}): JSX.Element {
  return (
    <article
      className={`approval-row approval-card${compact ? " compact" : ""}${selected ? " selected" : ""}`}
      data-approval-id={approval.id}
      data-approval-risk={approval.risk}
      tabIndex={-1}
      onClick={() => onSelect?.(approval.id)}
    >
      <div className="approval-card-content">
        <ApprovalSummary approval={approval} />
        <ApprovalPermissionDelta approval={approval} compact={compact} />
        <ApprovalExternalActionSection
          actionView={externalAction}
          approval={approval}
          compact={compact}
          cwd={cwd}
          operation={externalActionBusy}
          onCancel={onCancelExternalAction}
          onExecute={onExecuteExternalAction}
          onRefresh={onRefreshExternalAction}
        />
        <ApprovalTechnicalDetails approval={approval} />
      </div>
      <ApprovalDecisionPanel
        approval={approval}
        compact={compact}
        enabled={decisionEnabled}
        errorMessage={errorMessage}
        resolvingDecision={resolvingDecision}
        onResolve={onResolve}
      />
    </article>
  );
}
