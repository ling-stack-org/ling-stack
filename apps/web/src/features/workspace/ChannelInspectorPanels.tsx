import { useEffect, useMemo, useState } from "react";
import { LingDaemonError } from "@ling-stack/api-client";
import {
  Check,
  CircleAlert,
  FileCheck2,
  FileText,
  Info,
  Loader2,
  Play,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { useI18n, type Translate } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { correctChannelTurnContext, getChannelTurnContext } from "../../api.js";
import { InlineFeedback, Select, useLingToast } from "../../shared/ui/index.js";
import { RuntimeDiagnosticsPanel } from "./RuntimeDiagnosticsPanel.js";
import { ChannelBriefEditor, type ChannelBriefDraft } from "./ChannelBriefEditor.js";
import { ChannelProtocolResetDialog } from "./ChannelProtocolResetDialog.js";
import { useChannelProtocolResetController } from "./useChannelProtocolResetController.js";
import {
  WorkflowQueueCard,
} from "./ChannelWorkflowProposalCards.js";
import type {
  Channel,
  ChannelAttachment,
  ChannelBrief,
  ChannelCollaborationProtocolResponse,
  ChannelContextSummary,
  ChannelConversationContextInspectResponse,
  ChannelDecision,
  ChannelHandoff,
  ChannelHandoffStatus,
  ChannelIntentDecision,
  ChannelLinkPreview,
  ChannelMention,
  ChannelMessageRouteDecision,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ChannelWorkflowStepStartMode,
  RuntimeDiagnosticsResponse,
  RunArtifact,
  Task,
  UpdateChannelCollaborationProtocolRequest,
  WorkUnit,
} from "../../types.js";

function teammateLabel(
  teammateId: string | undefined,
  teammates: readonly ChannelMention[],
  fallback = "AI teammate",
): string {
  if (!teammateId) {
    return fallback;
  }
  return teammates.find((teammate) => teammate.id === teammateId)?.label ?? fallback;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))];
}

export type ChannelInspectorMode = "protocol" | "brief" | "routing" | "decisions" | "handoffs" | "runtime";

function ProtocolList<T>({
  emptyLabel,
  items,
  renderItem,
}: {
  readonly emptyLabel: string;
  readonly items: readonly T[];
  readonly renderItem: (item: T) => React.JSX.Element;
}): React.JSX.Element {
  if (items.length === 0) {
    return (
      <div className="client-empty-state compact">
        <FileText />
        <span>{emptyLabel}</span>
      </div>
    );
  }
  return <div className="protocol-list">{items.map(renderItem)}</div>;
}

export function ChannelInspector({
  cwd,
  mode,
  onModeChange,
  channel,
  protocol,
  protocolError,
  teammates,
  autoRouteEnabled,
  brief,
  briefDraft,
  onBriefDraftChange,
  onSaveBrief,
  onSaveProtocol,
  onRevertProtocol,
  routeDecisions,
  intentDecisions,
  decisions,
  handoffs,
  contextSummaries,
  workflows,
  workflowSteps,
  workflowErrors,
  artifactsByRun,
  runtimeDiagnostics,
  workUnits,
  attachments,
  linkPreviews,
  runningWorkflowStepId,
  orchestratingWorkflowId,
  loading,
  runtimeLoading,
  runtimeActionWorkUnitId,
  selectedTask,
  onSupersedeDecision,
  onRejectDecision,
  onUpdateHandoffStatus,
  onStartWorkflowFromHandoff,
  onStartTemplateWorkflow,
  onOrchestrateWorkflow,
  onCancelWorkflow,
  onStartWorkflowStep,
  onRetryWorkflowStep,
  onUpdateWorkflowStepStatus,
  onCreateTaskFromContextSummary,
  onRefreshRuntime,
  onCancelWorkUnit,
  onRetryWorkUnit,
  onReconcileWorkUnit,
}: {
  readonly cwd: string;
  readonly mode: ChannelInspectorMode;
  readonly onModeChange: (mode: ChannelInspectorMode) => void;
  readonly channel: Channel | undefined;
  readonly protocol: ChannelCollaborationProtocolResponse | undefined;
  readonly protocolError?: string;
  readonly teammates: readonly ChannelMention[];
  readonly autoRouteEnabled: boolean;
  readonly brief: ChannelBrief | undefined;
  readonly briefDraft: ChannelBriefDraft;
  readonly onBriefDraftChange: (draft: ChannelBriefDraft) => void;
  readonly onSaveBrief: () => void;
  readonly onSaveProtocol: (input: UpdateChannelCollaborationProtocolRequest) => Promise<ChannelCollaborationProtocolResponse | undefined>;
  readonly onRevertProtocol: () => Promise<ChannelCollaborationProtocolResponse | undefined>;
  readonly routeDecisions: readonly ChannelMessageRouteDecision[];
  readonly intentDecisions: readonly ChannelIntentDecision[];
  readonly decisions: readonly ChannelDecision[];
  readonly handoffs: readonly ChannelHandoff[];
  readonly contextSummaries: readonly ChannelContextSummary[];
  readonly workflows: readonly ChannelWorkflow[];
  readonly workflowSteps: readonly ChannelWorkflowStep[];
  readonly workflowErrors: Readonly<Record<string, string>>;
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly runtimeDiagnostics: RuntimeDiagnosticsResponse | undefined;
  readonly workUnits: readonly WorkUnit[];
  readonly attachments: readonly ChannelAttachment[];
  readonly linkPreviews: readonly ChannelLinkPreview[];
  readonly runningWorkflowStepId: string;
  readonly orchestratingWorkflowId: string;
  readonly loading: boolean;
  readonly runtimeLoading: boolean;
  readonly runtimeActionWorkUnitId: string;
  readonly selectedTask: Task | undefined;
  readonly onSupersedeDecision: (decision: ChannelDecision) => void;
  readonly onRejectDecision: (decision: ChannelDecision) => void;
  readonly onUpdateHandoffStatus: (handoff: ChannelHandoff, status: ChannelHandoffStatus) => void;
  readonly onStartWorkflowFromHandoff: (handoff: ChannelHandoff) => void;
  readonly onStartTemplateWorkflow: () => void;
  readonly onOrchestrateWorkflow: (workflow: ChannelWorkflow) => void;
  readonly onCancelWorkflow: (workflow: ChannelWorkflow) => void;
  readonly onStartWorkflowStep: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => void;
  readonly onRetryWorkflowStep: (step: ChannelWorkflowStep) => void;
  readonly onUpdateWorkflowStepStatus: (step: ChannelWorkflowStep, status: "skipped" | "cancelled") => void;
  readonly onCreateTaskFromContextSummary: (summary: ChannelContextSummary) => void;
  readonly onRefreshRuntime: () => void;
  readonly onCancelWorkUnit: (workUnitId: string) => void;
  readonly onRetryWorkUnit: (workUnitId: string) => void;
  readonly onReconcileWorkUnit: (workUnitId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const activeDecisions = decisions.filter((decision) => decision.status === "active");
  const taskSummaries = selectedTask ? contextSummaries.filter((summary) => summary.targetType === "task" && summary.targetId === selectedTask.id) : [];
  const activeWorkflows = workflows.filter((workflow) => workflow.status !== "succeeded" && workflow.status !== "cancelled" && workflow.status !== "failed");
  const [openRoutingDecisionId, setOpenRoutingDecisionId] = useState("");
  const recentRoutingEvidence = useMemo(
    () => buildRecentRoutingEvidence(routeDecisions, intentDecisions),
    [intentDecisions, routeDecisions],
  );
  return (
    <section className="channel-inspector" aria-label={t("Channel inspector")}>
      <div className="channel-inspector-tabs" role="tablist" aria-label={t("Channel inspector modes")}>
        {(["protocol", "brief", "routing", "decisions", "handoffs", "runtime"] as const).map((item) => (
          <button key={item} type="button" className={mode === item ? "active" : ""} onClick={() => onModeChange(item)}>
            {item === "protocol" ? t("Protocol") : item === "brief" ? t("Brief") : item === "routing" ? t("Routing") : item === "decisions" ? t("Decisions") : item === "handoffs" ? t("Handoffs") : t("Runtime")}
          </button>
        ))}
      </div>
      {(mode === "runtime" ? runtimeLoading : loading) ? (
        <div className="client-empty-state compact">
          <Loader2 className="spin" />
          <span>{mode === "runtime" ? t("Loading runtime...") : t("Loading protocol...")}</span>
        </div>
      ) : null}
      {mode === "protocol" ? (
        <ChannelProtocolEditor
          channel={channel}
          protocol={protocol}
          autoRouteEnabled={autoRouteEnabled}
          loadError={protocolError}
          onSave={onSaveProtocol}
          onRevert={onRevertProtocol}
        />
      ) : null}
      {mode === "brief" ? (
        <ChannelBriefEditor
          draft={briefDraft}
          onDraftChange={onBriefDraftChange}
          onSave={onSaveBrief}
        />
      ) : null}
      {mode === "routing" ? (
        <RoutingEvidenceIndex
          cwd={cwd}
          channelId={channel?.id ?? ""}
          items={recentRoutingEvidence}
          teammates={teammates}
          openDecisionId={openRoutingDecisionId}
          onToggle={setOpenRoutingDecisionId}
        />
      ) : null}
      {mode === "decisions" ? (
        <ProtocolList
          emptyLabel={t("No decisions recorded")}
          items={decisions}
          renderItem={(decision) => (
            <div className="protocol-row" key={decision.id}>
              <span>
                <strong>{decision.title}</strong>
                <small>{decision.status} · {decision.decision}</small>
              </span>
              <div className="activity-action-row">
                <button className="secondary-button compact-button" type="button" onClick={() => onSupersedeDecision(decision)}>{t("Supersede")}</button>
                <button className="secondary-button compact-button" type="button" onClick={() => onRejectDecision(decision)}>{t("Reject")}</button>
              </div>
            </div>
          )}
        />
      ) : null}
      {mode === "handoffs" ? (
        <ProtocolList
          emptyLabel={t("No handoffs")}
          items={handoffs}
          renderItem={(handoff) => (
            <div className="protocol-row" key={handoff.id}>
              <span>
                <strong>{handoff.fromParticipantLabel} {"->"} {handoff.toParticipantLabel}</strong>
                <small>{handoff.status} · {handoff.reason}</small>
              </span>
              <div className="activity-action-row">
                <button
                  className="secondary-button compact-button"
                  type="button"
                  onClick={() => onStartWorkflowFromHandoff(handoff)}
                  disabled={workflows.some((workflow) => workflow.sourceHandoffId === handoff.id)}
                >
                  {workflows.some((workflow) => workflow.sourceHandoffId === handoff.id) ? t("Workflow started") : t("Start workflow")}
                </button>
                <button className="secondary-button compact-button" type="button" onClick={() => onUpdateHandoffStatus(handoff, "accepted")}>{t("Accept")}</button>
                <button className="secondary-button compact-button" type="button" onClick={() => onUpdateHandoffStatus(handoff, "completed")}>{t("Complete")}</button>
              </div>
            </div>
          )}
        />
      ) : null}
      {mode === "runtime" ? (
        <div className="runtime-protocol">
          <RuntimeDiagnosticsPanel
            diagnostics={runtimeDiagnostics}
            workUnits={workUnits}
            loading={runtimeLoading}
            actionWorkUnitId={runtimeActionWorkUnitId}
            onRefresh={onRefreshRuntime}
            onCancelWorkUnit={onCancelWorkUnit}
            onRetryWorkUnit={onRetryWorkUnit}
            onReconcileWorkUnit={onReconcileWorkUnit}
          />
          <div className="task-strip-head">
            <span><Workflow size={15} /><strong>{t("Workflow queue")}</strong></span>
            <span className="button-row compact">
              <small>{activeWorkflows.length}</small>
              <button className="secondary-button compact-button" type="button" onClick={onStartTemplateWorkflow} disabled={Boolean(orchestratingWorkflowId)}>
                {orchestratingWorkflowId === "new:autoplan-lite" ? <Loader2 className="spin" size={13} /> : <Play size={13} />}
                {t("Start autoplan")}
              </button>
            </span>
          </div>
          <ProtocolList
            emptyLabel={t("No active workflows")}
            items={activeWorkflows}
            renderItem={(workflow) => (
              <WorkflowQueueCard
                key={workflow.id}
                cwd={cwd}
                workflow={workflow}
                steps={workflowSteps.filter((step) => step.workflowId === workflow.id)}
                artifactsByRun={artifactsByRun}
                brief={brief}
                decisions={activeDecisions}
                handoff={handoffs.find((handoff) => handoff.id === workflow.sourceHandoffId)}
                contextSummaries={contextSummaries}
                attachments={attachments}
                linkPreviews={linkPreviews}
                runningWorkflowStepId={runningWorkflowStepId}
                orchestrating={orchestratingWorkflowId === workflow.id}
                operationErrors={workflowErrors}
                onOrchestrateWorkflow={onOrchestrateWorkflow}
                onCancelWorkflow={onCancelWorkflow}
                onStartWorkflowStep={onStartWorkflowStep}
                onRetryWorkflowStep={onRetryWorkflowStep}
                onUpdateWorkflowStepStatus={onUpdateWorkflowStepStatus}
              />
            )}
          />
          <div className="task-strip-head">
            <span><FileCheck2 size={15} /><strong>{t("Active decisions")}</strong></span>
            <small>{activeDecisions.length}</small>
          </div>
          <ProtocolList
            emptyLabel={t("No active decisions")}
            items={activeDecisions}
            renderItem={(decision) => (
              <div className="protocol-row compact" key={decision.id}>
                <strong>{decision.title}</strong>
                <small>{decision.decision}</small>
              </div>
            )}
          />
          <div className="task-strip-head">
            <span><FileText size={15} /><strong>{t("Task context")}</strong></span>
            <small>{taskSummaries.length}</small>
          </div>
          <ProtocolList
            emptyLabel={t("No context summary for this task")}
            items={taskSummaries}
            renderItem={(summary) => (
              <div className="protocol-row compact" key={summary.id}>
                <strong>{summary.targetId}</strong>
                <small>{summary.summary}</small>
                <button className="secondary-button compact-button" type="button" onClick={() => onCreateTaskFromContextSummary(summary)}>{t("Create task")}</button>
              </div>
            )}
          />
        </div>
      ) : null}
    </section>
  );
}

type RoutingEvidenceItem =
  | {
      readonly kind: "route";
      readonly id: string;
      readonly createdAt: string;
      readonly decision: ChannelMessageRouteDecision;
    }
  | {
      readonly kind: "intent";
      readonly id: string;
      readonly createdAt: string;
      readonly decision: ChannelIntentDecision;
    };

function RoutingEvidenceIndex({
  cwd,
  channelId,
  items,
  teammates,
  openDecisionId,
  onToggle,
}: {
  readonly cwd: string;
  readonly channelId: string;
  readonly items: readonly RoutingEvidenceItem[];
  readonly teammates: readonly ChannelMention[];
  readonly openDecisionId: string;
  readonly onToggle: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="routing-evidence-index">
      <div className="task-strip-head">
        <span><Info size={15} /><strong>{t("Routing evidence")}</strong></span>
        <small>{t("{count} decisions", { count: items.length })}</small>
      </div>
      <ProtocolList
        emptyLabel={t("No routing evidence recorded")}
        items={items}
        renderItem={(item) => {
          const open = openDecisionId === item.id;
          const label = item.kind === "route"
            ? channelRouteDecisionSummaryLabel(item.decision, t)
            : channelIntentDecisionSummaryLabel(item.decision, t);
          return (
            <div className="protocol-row routing-evidence-row" key={item.id}>
              <span>
                <strong>{label}</strong>
                <small>{item.kind === "route" ? t("Reply route") : t("Intent selector")} · {formatDateTime(item.createdAt)}</small>
              </span>
              <button
                className="secondary-button compact-button"
                type="button"
                aria-expanded={open}
                onClick={() => onToggle(open ? "" : item.id)}
              >
                {open ? t("Hide details") : t("Inspect")}
              </button>
              {open ? (
                <div className="routing-evidence-detail">
                  {item.kind === "route" ? (
                    <ChannelRouteInspectContent decision={item.decision} teammates={teammates} t={t} />
                  ) : (
                    <ChannelIntentInspectContent
                      cwd={cwd}
                      channelId={channelId}
                      decision={item.decision}
                      teammates={teammates}
                      t={t}
                    />
                  )}
                </div>
              ) : null}
            </div>
          );
        }}
      />
    </div>
  );
}

function buildRecentRoutingEvidence(
  routeDecisions: readonly ChannelMessageRouteDecision[],
  intentDecisions: readonly ChannelIntentDecision[],
): readonly RoutingEvidenceItem[] {
  return [
    ...routeDecisions.map((decision) => ({
      kind: "route" as const,
      id: `route:${decision.id}`,
      createdAt: decision.createdAt,
      decision,
    })),
    ...intentDecisions.map((decision) => ({
      kind: "intent" as const,
      id: `intent:${decision.id}`,
      createdAt: decision.createdAt,
      decision,
    })),
  ]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 20);
}

interface ChannelProtocolDraft {
  readonly responseLanguage: NonNullable<Channel["responseLanguage"]>;
  readonly autoReplyMode: Channel["autoReplyMode"];
}

function ChannelProtocolEditor({
  channel,
  protocol,
  autoRouteEnabled,
  loadError,
  onSave,
  onRevert,
}: {
  readonly channel: Channel | undefined;
  readonly protocol: ChannelCollaborationProtocolResponse | undefined;
  readonly autoRouteEnabled: boolean;
  readonly loadError?: string;
  readonly onSave: (input: UpdateChannelCollaborationProtocolRequest) => Promise<ChannelCollaborationProtocolResponse | undefined>;
  readonly onRevert: () => Promise<ChannelCollaborationProtocolResponse | undefined>;
}): React.JSX.Element {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const [draft, setDraft] = useState<ChannelProtocolDraft>(() => protocolDraftFromState(channel, protocol));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const baseDraft = useMemo(() => protocolDraftFromState(channel, protocol), [channel, protocol]);
  const protocolReset = useChannelProtocolResetController({
    channelId: channel?.id,
    onReset: onRevert,
  });
  const changed =
    draft.responseLanguage !== baseDraft.responseLanguage ||
    draft.autoReplyMode !== baseDraft.autoReplyMode;

  useEffect(() => {
    setDraft(baseDraft);
    setError("");
  }, [baseDraft]);

  async function save(): Promise<void> {
    const patch: {
      responseLanguage?: UpdateChannelCollaborationProtocolRequest["responseLanguage"];
      autoReplyMode?: UpdateChannelCollaborationProtocolRequest["autoReplyMode"];
    } = {};
    if (draft.responseLanguage !== baseDraft.responseLanguage) {
      patch.responseLanguage = draft.responseLanguage;
    }
    if (draft.autoReplyMode !== baseDraft.autoReplyMode) {
      patch.autoReplyMode = draft.autoReplyMode;
    }
    if (Object.keys(patch).length === 0) {
      if (channel) {
        showToast({
          message: t("No protocol changes"),
          scope: `channel:${channel.id}:protocol`,
          tone: "info",
        });
      }
      return;
    }
    setSaving(true);
    setError("");
    try {
      await onSave(patch);
      if (channel) {
        showToast({
          message: t("Protocol updated"),
          scope: `channel:${channel.id}:protocol`,
          tone: "success",
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="channel-protocol-editor">
      <div className="task-strip-head">
        <span><ShieldCheck size={15} /><strong>{t("Channel protocol")}</strong></span>
        <small>{protocol ? t("Updated {time}", { time: formatDateTime(protocol.protocol.updatedAt) }) : t("Not loaded")}</small>
      </div>
      {loadError ? (
        <InlineFeedback className="compact" tone="danger" role="alert">
          <CircleAlert size={14} />
          {loadError}
        </InlineFeedback>
      ) : null}
      {protocol ? (
        <div className="protocol-list">
          <div className="protocol-row compact">
            <span>
              <strong>{t("Effective response language")}</strong>
              <small>{responseLanguageLabel(protocol.protocol.responseLanguage, t)} · {protocolSourceLabel(protocol.sources.responseLanguage.source, t)}</small>
            </span>
          </div>
          <label className="field wide">
            <span>{t("AI response language")}</span>
            <Select
              size="md"
              value={draft.responseLanguage}
              onChange={(event) => setDraft({ ...draft, responseLanguage: event.target.value as ChannelProtocolDraft["responseLanguage"] })}
              disabled={!channel || saving}
            >
              <option value="workspace">{t("Workspace default")}</option>
              <option value="follow_user">{t("Follow user")}</option>
              <option value="zh-CN">{t("Chinese")}</option>
              <option value="en-US">{t("English")}</option>
            </Select>
          </label>
          <div className="task-strip-head">
            <span><Info size={15} /><strong>{t("Read-only protocol defaults")}</strong></span>
          </div>
          <ProtocolList
            emptyLabel={t("No read-only protocol fields")}
            items={[
              { id: "defaultWorkflowPreference", label: t("Workflow preference"), value: protocol.protocol.defaultWorkflowPreference, source: protocol.sources.defaultWorkflowPreference.source },
              { id: "visibleMultiReplyMaxParticipants", label: t("Visible multi-reply cap"), value: String(protocol.protocol.visibleMultiReplyMaxParticipants), source: protocol.sources.visibleMultiReplyMaxParticipants.source },
              { id: "privacyRules", label: t("Privacy rules"), value: protocol.protocol.privacyRules.length > 0 ? protocol.protocol.privacyRules.join("; ") : t("Default only"), source: protocol.sources.privacyRules.source },
              { id: "reviewRules", label: t("Review rules"), value: protocol.protocol.reviewRules.length > 0 ? protocol.protocol.reviewRules.join("; ") : t("Default only"), source: protocol.sources.reviewRules.source },
            ]}
            renderItem={(item) => (
              <div className="protocol-row compact" key={item.id}>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.value} · {protocolSourceLabel(item.source, t)} · {t("Not editable yet")}</small>
                </span>
              </div>
            )}
          />
          {changed ? (
            <div className="provider-run-notice neutral">
              <Info size={16} />
              <span>{t("Review protocol changes before saving.")}</span>
            </div>
          ) : null}
          {error ? (
            <InlineFeedback className="compact" tone="danger" role="alert">
              <CircleAlert size={14} />
              {error}
            </InlineFeedback>
          ) : null}
          <div className="activity-action-row">
            <button className="primary-button compact-button" type="button" onClick={() => void save()} disabled={!channel || saving || !changed}>
              {saving ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
              {t("Save protocol")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={() => setDraft(baseDraft)} disabled={saving || !changed}>{t("Cancel")}</button>
            <button
              ref={protocolReset.triggerRef}
              className="secondary-button compact-button danger"
              type="button"
              onClick={protocolReset.openDialog}
              disabled={!channel || saving || protocolReset.busy}
            >
              {t("Reset")}
            </button>
          </div>
        </div>
      ) : (
        <div className="client-empty-state compact">
          <Loader2 className="spin" />
          <span>{t("Loading protocol...")}</span>
        </div>
      )}
      <ChannelProtocolResetDialog
        busy={protocolReset.busy}
        error={protocolReset.error}
        open={protocolReset.open}
        returnFocusRef={protocolReset.triggerRef}
        onConfirm={() => void protocolReset.confirm()}
        onOpenChange={protocolReset.onOpenChange}
      />
    </div>
  );
}

function protocolDraftFromState(
  channel: Channel | undefined,
  protocol: ChannelCollaborationProtocolResponse | undefined,
): ChannelProtocolDraft {
  return {
    responseLanguage: protocol?.sources.responseLanguage.channelValue ?? channel?.responseLanguage ?? "workspace",
    autoReplyMode: channel?.autoReplyMode ?? protocol?.protocol.autoReplyMode ?? "mentions_only",
  };
}

function protocolSourceLabel(source: ChannelCollaborationProtocolResponse["sources"]["responseLanguage"]["source"], t: Translate): string {
  if (source === "channel_setting") {
    return t("Channel setting");
  }
  if (source === "workspace_setting") {
    return t("Workspace setting");
  }
  if (source === "current_message") {
    return t("Current message");
  }
  if (source === "teammate_instruction") {
    return t("Teammate instruction");
  }
  return t("Default");
}

function responseLanguageLabel(value: NonNullable<Channel["responseLanguage"]>, t: Translate): string {
  if (value === "workspace") {
    return t("Workspace default");
  }
  if (value === "follow_user") {
    return t("Follow user");
  }
  if (value === "zh-CN") {
    return t("Chinese");
  }
  if (value === "en-US") {
    return t("English");
  }
  return t("Follow user");
}

function ChannelRouteInspectContent({
  decision,
  teammates,
  t,
}: {
  readonly decision: ChannelMessageRouteDecision;
  readonly teammates: readonly ChannelMention[];
  readonly t: Translate;
}): React.JSX.Element {
  const contextPack = decision.contextPack;
  return (
    <>
      <p>{channelRouteDecisionUserReason(decision, t)}</p>
      <dl className="channel-route-inspect-grid">
        <div>
          <dt>{t("Outcome")}</dt>
          <dd>{channelRouteDecisionOutcomeLabel(decision, t)}</dd>
        </div>
        <div>
          <dt>{t("Route mode")}</dt>
          <dd>{channelRouteDecisionModeLabel(decision, t) || decision.mode}</dd>
        </div>
        <div>
          <dt>{t("Selected teammate")}</dt>
          <dd>{formatSelectedTeammate(decision.selectedTeammateId, teammates, t)}</dd>
        </div>
        <div>
          <dt>{t("Provider preset")}</dt>
          <dd>{decision.selectedProviderPresetId || contextPack?.providerPresetId || t("Not recorded")}</dd>
        </div>
        <div>
          <dt>{t("Model")}</dt>
          <dd>{contextPack?.modelId || t("Not recorded")}</dd>
        </div>
        <div>
          <dt>{t("Created by")}</dt>
          <dd>{channelRouteDecisionCreatedByLabel(decision, t)}</dd>
        </div>
        <div>
          <dt>{t("Source message")}</dt>
          <dd>{decision.sourceMessageId}</dd>
        </div>
        <div>
          <dt>{t("Reply message")}</dt>
          <dd>{decision.replyMessageId || t("None")}</dd>
        </div>
        {decision.errorMessage ? (
          <div>
            <dt>{t("Error")}</dt>
            <dd>{decision.errorMessage}</dd>
          </div>
        ) : null}
      </dl>
      {decision.alternativesConsidered.length > 0 ? (
        <div className="channel-route-inspect-section">
          <span>{t("Alternatives considered")}</span>
          <ul>
            {decision.alternativesConsidered.map((alternative, index) => (
              <li key={`${alternative.teammateId ?? alternative.label}:${index}`}>
                <strong>
                  {alternative.teammateId
                    ? `${teammateLabel(alternative.teammateId, teammates, t("Deleted teammate"))} (${alternative.teammateId})`
                    : alternative.label}
                </strong>
                <small>{alternative.reason}</small>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {contextPack ? (
        <div className="channel-route-inspect-section">
          <span>{t("Context source metadata")}</span>
          <dl className="channel-route-inspect-grid">
            <div>
              <dt>{t("Sources")}</dt>
              <dd>{formatRouteSourceRefCounts(contextPack.sourceRefCounts) || t("None")}</dd>
            </div>
            <div>
              <dt>{t("Compactions")}</dt>
              <dd>{contextPack.compactionIds.length > 0 ? t("{count} compacted context summaries", { count: contextPack.compactionIds.length }) : t("None")}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <p>{t("No inspectable context source metadata was recorded for this route decision.")}</p>
      )}
    </>
  );
}

function ChannelIntentInspectContent({
  cwd,
  channelId,
  decision,
  teammates,
  t,
}: {
  readonly cwd: string;
  readonly channelId: string;
  readonly decision: ChannelIntentDecision;
  readonly teammates: readonly ChannelMention[];
  readonly t: Translate;
}): React.JSX.Element {
  return (
    <>
      <p>{channelIntentDecisionUserReason(decision, t)}</p>
      <dl className="channel-route-inspect-grid">
        <div>
          <dt>{t("Outcome")}</dt>
          <dd>{channelIntentDecisionOutcomeLabel(decision, t)}</dd>
        </div>
        <div>
          <dt>{t("Intent action")}</dt>
          <dd>{channelIntentDecisionActionLabel(decision.action, t)}</dd>
        </div>
        <div>
          <dt>{t("Selected teammate")}</dt>
          <dd>{formatIntentDecisionTeammates(decision, teammates, t)}</dd>
        </div>
        <div>
          <dt>{t("Created by")}</dt>
          <dd>{channelIntentDecisionCreatedByLabel(decision, t)}</dd>
        </div>
        <div>
          <dt>{t("Source item")}</dt>
          <dd>{decision.sourceItemId}</dd>
        </div>
        <div>
          <dt>{t("Source turn")}</dt>
          <dd>{decision.sourceTurnId}</dd>
        </div>
        <div>
          <dt>{t("Context segment")}</dt>
          <dd>{decision.contextSegmentId}</dd>
        </div>
        <div>
          <dt>{t("Projection version")}</dt>
          <dd>{decision.contextProjectionVersion}</dd>
        </div>
        <div>
          <dt>{t("Result items")}</dt>
          <dd>{formatOptionalIdList(decision.resultItemIds, t)}</dd>
        </div>
        {decision.clarification ? (
          <>
            <div>
              <dt>{t("Missing fields")}</dt>
              <dd>{formatOptionalIdList(decision.clarification.missingFields, t)}</dd>
            </div>
            <div>
              <dt>{t("Clarification question")}</dt>
              <dd>{decision.clarification.question}</dd>
            </div>
          </>
        ) : null}
        {decision.execution ? (
          <div>
            <dt>{t("Operations")}</dt>
            <dd>{decision.execution.operations.map((operation) => [
              `${operation.id}: ${operation.kind}`,
              `${t("Target kind")}: ${operation.targetKind}`,
              operation.required ? t("Required") : t("Optional"),
              `${t("Dependencies")}: ${formatOptionalIdList(operation.dependsOn, t)}`,
            ].join(" · ")).join("; ")}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("Proposal")}</dt>
          <dd>{decision.proposalId || t("None")}</dd>
        </div>
        <div>
          <dt>{t("Workflow")}</dt>
          <dd>{decision.workflowId || t("None")}</dd>
        </div>
        {decision.errorCode ? (
          <div>
            <dt>{t("Error")}</dt>
            <dd>{decision.errorCode}</dd>
          </div>
        ) : null}
      </dl>
      <ChannelContextInspectDetails cwd={cwd} channelId={channelId} decision={decision} t={t} />
    </>
  );
}

function ChannelContextInspectDetails({
  cwd,
  channelId,
  decision,
  t,
}: {
  readonly cwd: string;
  readonly channelId: string;
  readonly decision: ChannelIntentDecision;
  readonly t: Translate;
}): React.JSX.Element {
  const [inspect, setInspect] = useState<ChannelConversationContextInspectResponse>();
  const [selectedSegmentId, setSelectedSegmentId] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    setInspect(undefined);
    setSelectedSegmentId("");
    setError("");
    if (!cwd || !channelId || !decision.sourceTurnId) return () => { current = false; };
    setLoading(true);
    void getChannelTurnContext(cwd, channelId, decision.sourceTurnId)
      .then((response) => {
        if (!current) return;
        setInspect(response);
        setSelectedSegmentId(response.assignment.segmentId);
      })
      .catch((caught) => {
        if (current) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => { current = false; };
  }, [channelId, cwd, decision.sourceTurnId]);

  async function saveCorrection(): Promise<void> {
    if (!inspect || !selectedSegmentId || selectedSegmentId === inspect.assignment.segmentId || saving) return;
    setSaving(true);
    setError("");
    try {
      await correctChannelTurnContext(cwd, channelId, decision.sourceTurnId, {
        segmentId: selectedSegmentId,
        expectedAssignmentRevision: inspect.assignment.revision,
      });
      const refreshed = await getChannelTurnContext(cwd, channelId, decision.sourceTurnId);
      setInspect(refreshed);
      setSelectedSegmentId(refreshed.assignment.segmentId);
    } catch (caught) {
      if (caught instanceof LingDaemonError && caught.code === "context_assignment_revision_conflict") {
        try {
          const refreshed = await getChannelTurnContext(cwd, channelId, decision.sourceTurnId);
          setInspect(refreshed);
          setSelectedSegmentId(refreshed.assignment.segmentId);
          setError(t("Context changed while you were editing. Review the latest segment and try again."));
        } catch (refreshError) {
          setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
        }
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p><Loader2 className="spin" size={14} /> {t("Loading context inspect...")}</p>;
  }
  if (!inspect) {
    return error
      ? <InlineFeedback className="compact" tone="danger" role="alert">{error}</InlineFeedback>
      : <p>{t("Context inspect metadata is unavailable.")}</p>;
  }
  const coverage = inspect.summaries.length > 0
    ? inspect.summaries.map((summary) => `${summary.coveredFromSequence}-${summary.coveredThroughSequence}`).join(", ")
    : t("None");
  return (
    <div className="channel-route-inspect-section">
      <span>{t("Context inspect summary")}</span>
      <dl className="channel-route-inspect-grid">
        <div><dt>{t("Thread")}</dt><dd>{inspect.thread.id}</dd></div>
        <div><dt>{t("Turn")}</dt><dd>{inspect.turn.id}</dd></div>
        <div><dt>{t("Context segment")}</dt><dd>{inspect.assignment.segmentId}</dd></div>
        <div><dt>{t("Projection version")}</dt><dd>{inspect.projection.projectionVersion}</dd></div>
        <div><dt>{t("Item watermark")}</dt><dd>{inspect.projection.throughItemSequence}</dd></div>
        <div><dt>{t("Summary coverage")}</dt><dd>{coverage}</dd></div>
        <div><dt>{t("Source refs")}</dt><dd>{inspect.sourceRefs.length}</dd></div>
        <div><dt>{t("Dropped items")}</dt><dd>{inspect.droppedItemCount}</dd></div>
        <div><dt>{t("Redacted items")}</dt><dd>{inspect.redactedItemCount}</dd></div>
      </dl>
      {inspect.sourceRefs.length > 0 ? (
        <ul>
          {inspect.sourceRefs.slice(0, 20).map((ref) => (
            <li key={`${ref.type}:${ref.id}`}><code>{ref.type}:{ref.id}</code></li>
          ))}
        </ul>
      ) : null}
      <label className="field wide">
        <span>{t("Correct context segment")}</span>
        <Select
          size="md"
          value={selectedSegmentId}
          onChange={(event) => setSelectedSegmentId(event.target.value)}
          disabled={saving}
        >
          {inspect.segments.map((segment) => (
            <option key={segment.id} value={segment.id}>{segment.label || segment.id}</option>
          ))}
        </Select>
      </label>
      {error ? <InlineFeedback className="compact" tone="danger" role="alert">{error}</InlineFeedback> : null}
      <button
        className="secondary-button compact-button"
        type="button"
        disabled={saving || !selectedSegmentId || selectedSegmentId === inspect.assignment.segmentId}
        onClick={() => void saveCorrection()}
      >
        {saving ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
        {t("Apply context correction")}
      </button>
      <small>{t("Context diagnostics never include raw prompts, hidden reasoning, private memory bodies, or secret values.")}</small>
    </div>
  );
}

function channelRouteDecisionSummaryLabel(decision: ChannelMessageRouteDecision, t: Translate): string {
  if (decision.status === "failed") {
    return t("Auto reply failed");
  }
  if (decision.status === "accepted") {
    return channelRouteDecisionModeLabel(decision, t) || t("Reply created");
  }
  return t("Not auto-replied");
}

function channelRouteDecisionModeLabel(decision: ChannelMessageRouteDecision, t: Translate): string {
  if (decision.mode === "default_teammate") {
    return t("Default teammate");
  }
  if (decision.mode === "auto_route") {
    return t("Auto routed");
  }
  return "";
}

function channelRouteDecisionInspectTitle(decision: ChannelMessageRouteDecision, t: Translate): string {
  if (decision.status === "failed") {
    return t("Auto reply failed");
  }
  if (decision.status === "suppressed") {
    return t("Not auto-replied");
  }
  if (decision.mode === "default_teammate") {
    return t("The channel default teammate answered this message.");
  }
  if (decision.mode === "auto_route") {
    return t("Ling selected this teammate for the reply.");
  }
  return t("Reply created");
}

function channelRouteDecisionOutcomeLabel(decision: ChannelMessageRouteDecision, t: Translate): string {
  if (decision.status === "accepted") {
    return t("Reply created");
  }
  if (decision.status === "failed") {
    return t("Failed closed");
  }
  return t("Suppressed");
}

function channelRouteDecisionCreatedByLabel(decision: ChannelMessageRouteDecision, t: Translate): string {
  switch (decision.createdBy) {
    case "explicit_mention":
      return t("Explicit mention");
    case "deterministic":
      return t("Deterministic rule");
    case "model":
      return t("Model selector");
  }
}

function formatRouteSourceRefCounts(counts: Readonly<Record<string, number>> | undefined): string {
  if (!counts) {
    return "";
  }
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${type}: ${count}`)
    .join(", ");
}

function channelIntentDecisionSummaryLabel(decision: ChannelIntentDecision, t: Translate): string {
  if (decision.status === "failed") {
    return t("Intent failed");
  }
  return channelIntentDecisionActionLabel(decision.action, t);
}

function channelIntentDecisionInspectTitle(decision: ChannelIntentDecision, t: Translate): string {
  if (decision.status === "failed") {
    return t("Intent failed");
  }
  return t("Why Ling handled this message this way");
}

function channelIntentDecisionOutcomeLabel(decision: ChannelIntentDecision, t: Translate): string {
  if (decision.status === "accepted") {
    return t("Accepted");
  }
  if (decision.status === "failed") {
    return t("Failed closed");
  }
  return t("Suppressed");
}

function channelIntentDecisionActionLabel(action: ChannelIntentDecision["action"], t: Translate): string {
  switch (action) {
    case "no_reply":
      return t("No reply");
    case "reply":
      return t("Reply");
    case "visible_multi_reply":
      return t("Visible multi-reply");
    case "clarify":
      return t("Clarify");
    case "workflow_proposal":
      return t("Workflow proposal");
    case "execute":
      return t("Execute");
  }
}

function channelIntentDecisionCreatedByLabel(decision: ChannelIntentDecision, t: Translate): string {
  return decision.createdBy === "model_policy" ? t("Model selector") : t("Deterministic rule");
}

function channelIntentDecisionUserReason(decision: ChannelIntentDecision, t: Translate): string {
  if (decision.errorCode) {
    return t("Ling could not safely handle this channel intent.");
  }
  return decision.reason || channelIntentDecisionActionLabel(decision.action, t);
}

function formatSelectedTeammate(teammateId: string | undefined, teammates: readonly ChannelMention[], t: Translate): string {
  if (!teammateId) {
    return t("None");
  }
  return `${teammateLabel(teammateId, teammates, t("Deleted teammate"))} (${teammateId})`;
}

function formatIntentDecisionTeammates(
  decision: ChannelIntentDecision,
  teammates: readonly ChannelMention[],
  t: Translate,
): string {
  const ids = decision.selectedTeammateIds;
  if (ids.length === 0) {
    return t("None");
  }
  return ids.map((id) => `${teammateLabel(id, teammates, t("Deleted teammate"))} (${id})`).join(", ");
}

function formatOptionalIdList(ids: readonly string[], t: Translate): string {
  return ids.length > 0 ? ids.join(", ") : t("None");
}

function channelRouteDecisionUserReason(decision: ChannelMessageRouteDecision, t: Translate): string {
  const errorText = decision.errorMessage?.trim();
  if (decision.status === "accepted") {
    return decision.reason || channelRouteDecisionInspectTitle(decision, t);
  }
  if (decision.status === "failed") {
    if (errorText?.includes("strict JSON object") || errorText?.includes("JSON object") || errorText?.includes("schema")) {
      return t("The route selector returned invalid output, so Ling did not create an automatic reply.");
    }
    if (errorText?.includes("unknown teammate")) {
      return t("The route selector chose a teammate that is not available in this channel.");
    }
    if (errorText?.includes("No runnable provider")) {
      return t("No runnable provider is available for the selected teammate.");
    }
    return t("Ling could not safely create an automatic reply.");
  }

  switch (decision.reason) {
    case "Message is not reply-worthy.":
      return t("This message looks like a note or acknowledgement, not a request for an AI reply.");
    case "Repeated short greeting was suppressed.":
      return t("A similar short greeting was already answered recently.");
    case "Message is empty.":
      return t("The message has no content for an AI teammate to answer.");
    case "Topic replies are outside the first auto-reply scope.":
      return t("Automatic replies currently run for root channel messages and channel branches, not topic replies.");
    case "Thread replies are outside the first auto-reply scope.":
      return t("Automatic replies currently run for root channel messages and channel branches.");
    case "Channel is not active.":
      return t("This channel is not active, so Ling did not create an automatic reply.");
    case "No active teammate candidate has a runnable provider.":
    case "Channel default teammate is missing, inactive, or not runnable.":
      return t("No runnable teammate is available to answer this message.");
    case "Channel auto_route feature flag is disabled.":
      return t("Automatic routing is not enabled for this workspace.");
    case "Route model confidence was below threshold.":
      return t("Ling was not confident enough to choose one teammate automatically.");
    case "An AI reply already exists for this source message.":
      return t("This message already has an AI reply.");
    default:
      return t("Ling decided not to create an automatic reply for this message.");
  }
}
