import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  Check,
  FileCheck2,
  FileText,
  Loader2,
  ShieldCheck,
  SquareTerminal,
  X,
} from "lucide-react";
import { useI18n, type Translate } from "../../i18n.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import {
  conversationContextSourceSummaryLabel,
  type ConversationContextSourceRefLike,
  type ConversationContextSourceSummary,
} from "../../lib/conversation-context-sources.js";
import { formatDateTime } from "../../lib/formatting.js";
import type {
  ApprovalRequest,
  ChannelDecision,
  ChannelMessage,
} from "../../types.js";
import type { ApprovalResolution } from "../approvals/types.js";
import { conversationContextSourceGroupIcon } from "./ChannelProgressPanels.js";

export interface SelectedSourceDetailState {
  readonly summary: ConversationContextSourceSummary;
  readonly groupId?: string;
}

export type ConversationDetailOverlayState =
  | { readonly kind: "approval" }
  | { readonly kind: "sources" };

export function ConversationDetailOverlay({
  title,
  icon,
  children,
  onClose,
}: {
  readonly title: string;
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="conversation-detail-overlay" aria-label={title}>
      <header className="conversation-detail-overlay-head">
        <span>
          {icon}
          <strong>{title}</strong>
        </span>
        <button className="icon-button" type="button" onClick={onClose} aria-label={t("Close preview")} title={t("Close preview")}>
          <X size={14} />
        </button>
      </header>
      <div className="conversation-detail-overlay-body">
        {children}
      </div>
    </section>
  );
}

export function ChannelSourceDetailPanel({
  detail,
  messages,
  decisions,
}: {
  readonly detail?: SelectedSourceDetailState;
  readonly messages: readonly ChannelMessage[];
  readonly decisions: readonly ChannelDecision[];
}): JSX.Element {
  const { t } = useI18n();
  if (!detail) {
    return (
      <section className="context-source-detail-panel" aria-label={t("Context sources")}>
        <div className="context-source-detail-empty">
          <FileCheck2 size={15} />
          <span>{t("Context source details are not available.")}</span>
        </div>
      </section>
    );
  }
  const selectedGroups = detail.groupId
    ? detail.summary.groups.filter((group) => group.id === detail.groupId)
    : detail.summary.groups;
  const groups = selectedGroups.length > 0 ? selectedGroups : detail.summary.groups;

  return (
    <section className="context-source-detail-panel" aria-label={t("Context sources")}>
      <div className="context-source-detail-head">
        <span>
          <FileCheck2 size={15} />
          <strong>{t("Sources used")}</strong>
        </span>
        <small>{conversationContextSourceSummaryLabel(detail.summary, t)}</small>
      </div>
      {groups.length > 0 ? (
        <div className="context-source-detail-groups">
          {groups.map((group) => (
            <section key={group.id} className="context-source-detail-group" aria-label={group.label}>
              <div className="context-source-detail-group-head">
                <span className="attention-row-icon neutral">{conversationContextSourceGroupIcon(group.type)}</span>
                <span>
                  <strong>{group.label}</strong>
                  <small>{group.count === 1 ? t("1 item") : t("{count} items", { count: group.count })}</small>
                </span>
              </div>
              <ul className="context-source-ref-list">
                {group.refs.map((ref, index) => {
                  const display = contextSourceRefDisplay(ref, messages, decisions, t);
                  return (
                    <li key={`${ref.type}:${ref.id}:${index}`}>
                      <span>{display.primary}</span>
                      <small>{display.secondary}</small>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <div className="context-source-detail-empty">
          <FileText size={15} />
          <span>{detail.summary.unavailableReason ?? t("No user-facing sources were recorded.")}</span>
        </div>
      )}
      {detail.summary.droppedCount > 0 || detail.summary.compactionCount > 0 ? (
        <div className="context-source-detail-foot">
          {detail.summary.droppedCount > 0 ? <span>{t("{count} items omitted from model context", { count: detail.summary.droppedCount })}</span> : null}
          {detail.summary.compactionCount > 0 ? <span>{t("{count} compacted context summaries", { count: detail.summary.compactionCount })}</span> : null}
        </div>
      ) : null}
    </section>
  );
}

function contextSourceRefDisplay(
  ref: ConversationContextSourceRefLike,
  messages: readonly ChannelMessage[],
  decisions: readonly ChannelDecision[],
  t: Translate,
): { readonly primary: string; readonly secondary: string } {
  const type = ref.type.trim().toLowerCase();
  if (type === "message" || type === "channel_message" || type === "private_message") {
    const message = messages.find((item) => item.id === ref.id);
    return {
      primary: t("Message {id}", { id: ref.id }),
      secondary: message ? `${contextSourceMessageAuthorLabel(message.authorType, t)} · ${formatDateTime(message.createdAt)}` : t("Source ref"),
    };
  }
  if (type === "decision" || type === "channel_decision") {
    const decision = decisions.find((item) => item.id === ref.id);
    return {
      primary: decision?.title ?? t("Decision {id}", { id: ref.id }),
      secondary: decision ? `${contextSourceDecisionStatusLabel(decision.status, t)} · ${ref.id}` : t("Source ref"),
    };
  }
  const label = ref.label?.trim();
  return {
    primary: label || ref.id,
    secondary: `${t("source {sourceKind}", { sourceKind: ref.type })} · ${ref.id}`,
  };
}

function contextSourceMessageAuthorLabel(authorType: ChannelMessage["authorType"], t: Translate): string {
  if (authorType === "local-user") {
    return t("Local user");
  }
  if (authorType === "ai-teammate") {
    return t("AI teammate");
  }
  if (authorType === "system") {
    return t("System");
  }
  return authorType;
}

function contextSourceDecisionStatusLabel(status: ChannelDecision["status"], t: Translate): string {
  const normalized = String(status);
  if (normalized === "accepted" || normalized === "active") {
    return t("Accepted");
  }
  if (normalized === "rejected") {
    return t("Rejected");
  }
  if (normalized === "superseded") {
    return t("Superseded");
  }
  return normalized;
}

export function ChannelApprovalDetailPanel({
  approval,
  resolvingDecision,
  onResolve,
  onOpenTask,
  onOpenRun,
}: {
  readonly approval: ApprovalRequest | undefined;
  readonly resolvingDecision: ApprovalResolution | undefined;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [decisionReason, setDecisionReason] = useState("");
  const [confirmDecision, setConfirmDecision] = useState<ApprovalResolution | undefined>();

  useEffect(() => {
    setDecisionReason("");
    setConfirmDecision(undefined);
  }, [approval?.id]);

  if (!approval) {
    return (
      <section className="channel-approval-detail-panel empty" aria-label={t("Approval details")}>
        <div className="client-empty-state">
          <ShieldCheck />
          <span>{t("No pending approval")}</span>
        </div>
      </section>
    );
  }

  const currentApproval = approval;
  const effectiveStatus = effectiveApprovalStatus(currentApproval);
  const isResolving = Boolean(resolvingDecision);
  const requiresReason = currentApproval.risk === "high" || currentApproval.risk === "critical";
  const trimmedReason = decisionReason.trim();

  function submitDecision(decision: ApprovalResolution): void {
    if (isResolving || effectiveStatus !== "pending") {
      return;
    }
    if (decision === "approve" && requiresReason && (confirmDecision !== "approve" || !trimmedReason)) {
      setConfirmDecision("approve");
      return;
    }
    setConfirmDecision(undefined);
    onResolve(currentApproval.id, decision, trimmedReason || undefined);
  }

  return (
    <section className="channel-approval-detail-panel" aria-label={t("Approval details")}>
      <div className="channel-approval-hero">
        <span>
          <ShieldCheck size={17} />
          <strong>{t("Approval request")}</strong>
        </span>
        <h3>{currentApproval.title}</h3>
        <p>{currentApproval.description}</p>
        <div className="channel-approval-badges">
          <span className={`approval-state ${effectiveStatus}`}>{effectiveStatus}</span>
          <span className={`approval-risk ${currentApproval.risk}`}>{currentApproval.risk}</span>
          <span>{currentApproval.actionType}</span>
        </div>
      </div>

      <div className="channel-approval-links">
        {currentApproval.taskId ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onOpenTask(currentApproval.taskId ?? "")}>
            <SquareTerminal size={14} />
            {t("Open linked task")}
          </button>
        ) : null}
        {currentApproval.runId ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(currentApproval.runId ?? "")}>
            <Activity size={14} />
            {t("Open linked run")}
          </button>
        ) : null}
      </div>

      {currentApproval.decisionReason ? (
        <div className="channel-approval-note">
          <strong>{t("Decision reason")}</strong>
          <p>{currentApproval.decisionReason}</p>
        </div>
      ) : null}

      {effectiveStatus === "pending" ? (
        <div className="channel-approval-decision-panel">
          <label className="approval-reason-field">
            <span>{t("Decision reason")}</span>
            <textarea
              value={decisionReason}
              rows={3}
              placeholder={requiresReason ? t("Required before approving high-risk requests") : t("Optional note for the audit log")}
              disabled={isResolving}
              onChange={(event) => setDecisionReason(event.target.value)}
            />
          </label>
          {confirmDecision === "approve" && requiresReason && !trimmedReason ? (
            <p className="approval-reason-error">{t("High-risk approvals need a decision reason.")}</p>
          ) : null}
          <div className="channel-approval-actions">
            <button className="primary-button compact-button" type="button" onClick={() => submitDecision("approve")} disabled={isResolving}>
              {resolvingDecision === "approve" ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
              {resolvingDecision === "approve" ? t("Approving") : confirmDecision === "approve" ? t("Confirm approve") : t("Approve")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={() => submitDecision("deny")} disabled={isResolving}>
              {resolvingDecision === "deny" ? <Loader2 className="spin" size={14} /> : <X size={14} />}
              {resolvingDecision === "deny" ? t("Denying") : t("Deny")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
