import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FileText,
  History,
  ListChecks,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { artifactContentUrl, getChannelWorkflowEvidence } from "../../api.js";
import { useI18n, type Translate } from "../../i18n.js";
import {
  buildConversationContextSourceSummaryFromInspect,
  buildConversationContextSourceSummaryFromPacket,
  conversationContextSourceSummaryLabel,
  type ConversationContextSourceSummary,
} from "../../lib/conversation-context-sources.js";
import { truncatePreview } from "../../lib/data.js";
import { displayLinkedRunStatus } from "../../lib/run-evidence.js";
import { StatusBadge } from "../../shared/components/index.js";
import { approvalProfileText } from "../teammates/helpers.js";
import type {
  ChannelAttachment,
  ChannelBrief,
  ChannelContextSummary,
  ChannelDecision,
  ChannelExecutionProposal,
  ChannelHandoff,
  ChannelLinkPreview,
  ChannelMention,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ChannelWorkflowStepContextPacket,
  ChannelWorkflowStepStartMode,
  RunArtifact,
  RunSession,
  UpdateChannelExecutionProposalRequest,
  WorkflowContextInspectSummary,
  WorkflowEvidenceDiagnostic,
} from "../../types.js";

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))];
}

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

type ChannelProposalStepDraft = {
  readonly teammateId: string;
  readonly action: ChannelExecutionProposal["collaborationSteps"][number]["action"];
  readonly summary: string;
  readonly sources?: ChannelExecutionProposal["collaborationSteps"][number]["sources"];
};
type ChannelProposalEditDraft = {
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId: string;
  readonly acceptanceCriteriaText: string;
  readonly shapingSummaryText: string;
  readonly shapingOpenQuestionsText: string;
  readonly shapingClarificationsText: string;
  readonly collaborationSteps: readonly ChannelProposalStepDraft[];
};
type RequirementShapingRow = {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly tone?: "neutral" | "attention" | "success";
};
const proposalStepActions: readonly ChannelProposalStepDraft["action"][] = ["coordinated", "consulted", "reviewed", "flagged_risk"];

export function WorkflowQueueCard({
  cwd,
  workflow,
  steps,
  artifactsByRun,
  brief,
  decisions,
  handoff,
  contextSummaries,
  attachments,
  linkPreviews,
  runningWorkflowStepId,
  orchestrating,
  onOrchestrateWorkflow,
  onCancelWorkflow,
  onStartWorkflowStep,
  onRetryWorkflowStep,
  onUpdateWorkflowStepStatus,
}: {
  readonly cwd: string;
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly brief: ChannelBrief | undefined;
  readonly decisions: readonly ChannelDecision[];
  readonly handoff: ChannelHandoff | undefined;
  readonly contextSummaries: readonly ChannelContextSummary[];
  readonly attachments: readonly ChannelAttachment[];
  readonly linkPreviews: readonly ChannelLinkPreview[];
  readonly runningWorkflowStepId: string;
  readonly orchestrating: boolean;
  readonly onOrchestrateWorkflow: (workflow: ChannelWorkflow) => void;
  readonly onCancelWorkflow: (workflow: ChannelWorkflow) => void;
  readonly onStartWorkflowStep: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => void;
  readonly onRetryWorkflowStep: (step: ChannelWorkflowStep) => void;
  readonly onUpdateWorkflowStepStatus: (step: ChannelWorkflowStep, status: "skipped" | "cancelled") => void;
}): JSX.Element {
  const { t } = useI18n();
  const orderedSteps = [...steps].sort((left, right) => left.position - right.position);
  const workflowContextSummaries = contextSummaries.filter((summary) => orderedSteps.some((step) => step.contextSummaryId === summary.id));
  const canAdvance = workflowCanAdvance(workflow.status);
  return (
    <div className="protocol-row workflow-queue-card">
      <div className="workflow-queue-head">
        <span>
          <strong>{workflow.title}</strong>
          <small>{workflow.status} · {workflow.objective}</small>
        </span>
        <span className="workflow-queue-actions">
          <StatusBadge status={workflow.status} />
          <button className="secondary-button compact-button" type="button" onClick={() => onOrchestrateWorkflow(workflow)} disabled={!canAdvance || orchestrating}>
            {orchestrating ? <Loader2 className="spin" size={13} /> : <Play size={13} />}
            {t("Advance")}
          </button>
          <button className="secondary-button compact-button" type="button" onClick={() => onCancelWorkflow(workflow)} disabled={!workflowCanCancel(workflow.status) || orchestrating}>
            <Square size={13} />
            {t("Cancel")}
          </button>
        </span>
      </div>
      <div className="context-packet">
        {brief?.objective ? <span>{t("Brief")}: {brief.objective}</span> : null}
        {handoff ? <span>{t("Source handoff")}: {handoff.fromParticipantLabel} {"->"} {handoff.toParticipantLabel}</span> : null}
        <span>{t("Active decisions")}: {decisions.length}</span>
        <span>{t("Context summaries")}: {workflowContextSummaries.length}</span>
        <span>{t("Attachments")}: {attachments.length}</span>
        <span>{t("Links")}: {linkPreviews.length}</span>
      </div>
      <div className="workflow-step-list">
        {orderedSteps.length === 0 ? (
          <div className="client-empty-state compact">
            <Workflow />
            <span>{t("No workflow steps")}</span>
          </div>
        ) : (
          orderedSteps.map((step) => (
            <WorkflowStepCard
              key={step.id}
              cwd={cwd}
              step={step}
              running={runningWorkflowStepId === step.id}
              contextSummary={contextSummaries.find((summary) => summary.id === step.contextSummaryId)}
              artifactsByRun={artifactsByRun}
              onStartWorkflowStep={onStartWorkflowStep}
              onRetryWorkflowStep={onRetryWorkflowStep}
              onUpdateWorkflowStepStatus={onUpdateWorkflowStepStatus}
            />
          ))
        )}
      </div>
    </div>
  );
}

function WorkflowStepCard({
  cwd,
  step,
  running,
  contextSummary,
  artifactsByRun,
  onStartWorkflowStep,
  onRetryWorkflowStep,
  onUpdateWorkflowStepStatus,
}: {
  readonly cwd: string;
  readonly step: ChannelWorkflowStep;
  readonly running: boolean;
  readonly contextSummary: ChannelContextSummary | undefined;
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly onStartWorkflowStep: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => void;
  readonly onRetryWorkflowStep: (step: ChannelWorkflowStep) => void;
  readonly onUpdateWorkflowStepStatus: (step: ChannelWorkflowStep, status: "skipped" | "cancelled") => void;
}): JSX.Element {
  const { t } = useI18n();
  const terminal = isWorkflowStepTerminal(step.status);
  const canStart = step.status === "queued" || step.status === "blocked";
  const canSkip = step.status === "queued";
  const metadata = step.metadata;
  const runArtifacts = step.runId ? artifactsByRun[step.runId] ?? [] : [];
  const runArtifactsById = new Map(runArtifacts.map((artifact) => [artifact.id, artifact] as const));
  const additionalOutputArtifactIds = uniqueStrings((metadata?.outputArtifactIds ?? []).filter((artifactId) => artifactId !== metadata?.outputArtifactId));
  const packetArtifactIds = uniqueStrings([
    metadata?.contextArtifactId,
    metadata?.outputArtifactId,
    ...additionalOutputArtifactIds,
  ].filter((artifactId): artifactId is string => Boolean(artifactId)));
  const workflowSourceLabel = metadata ? workflowStepSourceLabel(metadata, t) : "";
  const gates = metadata?.gates ?? [];
  return (
    <article className="workflow-step-card compact">
      <div className="workflow-step-head">
        <span>
          <strong>{step.position}. {step.title}</strong>
          <small>{step.toParticipantLabel} · {step.prompt}</small>
        </span>
        <StatusBadge status={step.status} />
      </div>
      {contextSummary ? (
        <div className="context-packet muted">
          <span>{t("Context summary")}: {contextSummary.summary}</span>
        </div>
      ) : null}
      {step.blocker ? (
        <div className="provider-run-notice compact">
          <CircleAlert size={14} />
          <span>{step.blocker}</span>
        </div>
      ) : null}
      {metadata ? (
        <div className="context-packet muted">
          {metadata.templateStepId ? <span>{t("Template")}: {metadata.templateStepId}</span> : null}
          {metadata.skillId ? <span>{t("Skill")}: {metadata.skillId}</span> : null}
          {metadata.requestedRunnerId ? <span>{t("Runner")}: {metadata.requestedRunnerId}</span> : null}
          {metadata.providerPresetId ? <span>{t("Provider")}: {metadata.providerPresetId}</span> : null}
          {workflowSourceLabel ? <span>{t("Source")}: {workflowSourceLabel}</span> : null}
          {metadata.dependsOnStepIds?.length ? <span>{t("Depends")}: {metadata.dependsOnStepIds.length}</span> : null}
          {metadata.preStepApprovalId ? <span>{t("Pre-step approval")}: {metadata.preStepApprovalId}</span> : null}
        </div>
      ) : null}
      {packetArtifactIds.length > 0 || runArtifacts.length > 0 ? (
        <div className="context-packet muted" aria-label={t("Packet artifacts")}>
          {metadata?.contextArtifactId ? (
            <WorkflowArtifactChip
              label={t("Context source artifact")}
              artifactId={metadata.contextArtifactId}
              artifact={runArtifactsById.get(metadata.contextArtifactId)}
              cwd={cwd}
            />
          ) : null}
          {metadata?.outputArtifactId ? (
            <WorkflowArtifactChip
              label={t("Output packet")}
              artifactId={metadata.outputArtifactId}
              artifact={runArtifactsById.get(metadata.outputArtifactId)}
              cwd={cwd}
            />
          ) : null}
          {additionalOutputArtifactIds.map((artifactId) => (
            <WorkflowArtifactChip
              key={artifactId}
              label={t("Artifact")}
              artifactId={artifactId}
              artifact={runArtifactsById.get(artifactId)}
              cwd={cwd}
            />
          ))}
          {runArtifacts.length > packetArtifactIds.length ? <span>{t("{count} artifacts", { count: runArtifacts.length })}</span> : null}
        </div>
      ) : null}
      {metadata?.contextArtifactId ? (
        <WorkflowStepContextEvidencePanel cwd={cwd} step={step} />
      ) : null}
      {metadata?.policy ? (
        <div className="context-packet muted" aria-label={t("Workflow policy")}>
          <span>{t("Workflow policy")}</span>
          <span>{t("Run failed")}: {workflowStepFailurePolicyLabel(metadata.policy.onRunFailed, t)}</span>
          <span>{t("Run cancelled")}: {workflowStepFailurePolicyLabel(metadata.policy.onRunCancelled, t)}</span>
          <span>{t("Approval denied")}: {workflowStepFailurePolicyLabel(metadata.policy.onApprovalDenied, t)}</span>
          <span>{metadata.policy.retryable ? t("Retryable") : t("Not retryable")}</span>
          {metadata.policy.maxRetries !== undefined ? <span>{t("Max retries")}: {metadata.policy.maxRetries}</span> : null}
        </div>
      ) : null}
      {gates.length > 0 || metadata?.activeGateStage || metadata?.postStepApprovalId ? (
        <div className="context-packet muted" aria-label={t("Workflow gates")}>
          {gates.map((gate) => (
            <span key={`${gate.stage}:${gate.title}`}>
              {workflowGateStageLabel(gate.stage, t)}: {gate.title} · {approvalProfileText(gate.approvalProfile, t)}
            </span>
          ))}
          {metadata?.activeGateStage ? <span>{t("Active gate")}: {workflowGateStageLabel(metadata.activeGateStage, t)}</span> : null}
          {metadata?.postStepApprovalId ? <span>{t("Post-step approval")}: {metadata.postStepApprovalId}</span> : null}
        </div>
      ) : null}
      {step.taskId || step.runId || step.resultSummary ? (
        <div className="context-packet muted">
          {step.taskId ? <span>{t("Task linked")}</span> : null}
          {step.runId ? <span>{t("Run linked")}</span> : null}
          {step.resultSummary ? <span>{step.resultSummary}</span> : null}
        </div>
      ) : null}
      <div className="activity-action-row">
        <button className="secondary-button compact-button" type="button" onClick={() => onStartWorkflowStep(step, "create_task")} disabled={!canStart || running}>
          {running ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}
          {t("Start step")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onStartWorkflowStep(step, "create_and_run_task")} disabled={!canStart || running}>
          {running ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
          {t("Start + run")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onRetryWorkflowStep(step)} disabled={step.status !== "blocked" || running}>
          {running ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          {t("Retry")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onUpdateWorkflowStepStatus(step, "skipped")} disabled={!canSkip || running}>
          {t("Skip")}
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onUpdateWorkflowStepStatus(step, "cancelled")} disabled={terminal || running}>
          {t("Cancel")}
        </button>
      </div>
    </article>
  );
}

function WorkflowArtifactChip({
  label,
  artifactId,
  artifact,
  cwd,
}: {
  readonly label: string;
  readonly artifactId: string;
  readonly artifact: RunArtifact | undefined;
  readonly cwd: string;
}): JSX.Element {
  const { t } = useI18n();
  const chipTitle = artifact?.title || artifact?.path || artifactId;
  const text = `${label}: ${truncatePreview(chipTitle, 42)}`;
  if (!artifact) {
    return <code title={artifactId}>{text}</code>;
  }
  return (
    <a className="workflow-artifact-chip" href={artifactContentUrl(artifact.id, cwd)} target="_blank" rel="noreferrer" title={`${t("Open artifact")}: ${chipTitle}`}>
      {text}
    </a>
  );
}

type WorkflowStepContextEvidenceState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | {
    readonly status: "loaded";
    readonly inspect?: WorkflowContextInspectSummary;
    readonly packet?: ChannelWorkflowStepContextPacket;
    readonly diagnostics: readonly WorkflowEvidenceDiagnostic[];
  }
  | { readonly status: "error"; readonly errorMessage: string };

type WorkflowContextPackSnapshot = NonNullable<ChannelWorkflowStepContextPacket["contextPack"]>;
type WorkflowContextPackSectionSnapshot = WorkflowContextPackSnapshot["sections"][number];

function WorkflowStepContextEvidencePanel({
  cwd,
  step,
}: {
  readonly cwd: string;
  readonly step: ChannelWorkflowStep;
}): JSX.Element | null {
  const { t } = useI18n();
  const contextArtifactId = step.metadata?.contextArtifactId;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<WorkflowStepContextEvidenceState>({ status: "idle" });

  if (!contextArtifactId) {
    return null;
  }

  function toggleOpen(): void {
    const nextOpen = !open;
    setOpen(nextOpen);
    if (nextOpen && (state.status === "idle" || state.status === "error")) {
      void loadContextEvidence();
    }
  }

  async function loadContextEvidence(): Promise<void> {
    setState({ status: "loading" });
    try {
      const evidence = await getChannelWorkflowEvidence(cwd.trim(), step.workflowId);
      const evidenceStep = evidence.steps.find((item) => item.step.id === step.id);
      setState({
        status: "loaded",
        inspect: evidenceStep?.contextInspect,
        packet: evidenceStep?.contextPacket,
        diagnostics: evidenceStep?.diagnostics ?? [],
      });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setState({ status: "error", errorMessage: message || t("Context evidence failed to load.") });
    }
  }

  return (
    <section className="workflow-context-evidence-panel" aria-label={t("Context sources")}>
      <button className="secondary-button compact-button" type="button" onClick={toggleOpen} aria-expanded={open}>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        <FileText size={13} />
        {t("Context sources")}
      </button>
      {open ? (
        <WorkflowStepContextEvidenceBody
          artifactId={contextArtifactId}
          state={state}
          onRetry={loadContextEvidence}
        />
      ) : null}
    </section>
  );
}

function WorkflowStepContextEvidenceBody({
  artifactId,
  state,
  onRetry,
}: {
  readonly artifactId: string;
  readonly state: WorkflowStepContextEvidenceState;
  readonly onRetry: () => Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  if (state.status === "idle" || state.status === "loading") {
    return (
      <div className="workflow-context-evidence-body">
        <div className="workflow-context-evidence-state">
          <Loader2 className="spin" size={13} />
          <span>{t("Loading context evidence...")}</span>
        </div>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="workflow-context-evidence-body">
        <div className="workflow-context-evidence-state failed">
          <CircleAlert size={13} />
          <span>{t("Artifact load failed")}: {artifactId}</span>
          <small>{state.errorMessage}</small>
          <button className="secondary-button compact-button" type="button" onClick={() => void onRetry()}>
            <RefreshCw size={13} />
            {t("Retry details")}
          </button>
        </div>
      </div>
    );
  }
  if (!state.packet) {
    if (state.inspect) {
      return <WorkflowContextInspectEvidence inspect={state.inspect} artifactId={artifactId} />;
    }
    const diagnostic = state.diagnostics.find((item) => item.kind === "bad_packet" || item.kind === "missing_context_packet");
    return (
      <div className="workflow-context-evidence-body">
        <div className="workflow-context-evidence-state">
          <FileText size={13} />
          <span>{diagnostic?.message ?? t("No persisted context snapshot for this step.")}</span>
          <small>{artifactId}</small>
        </div>
      </div>
    );
  }
  if (state.inspect) {
    return <WorkflowContextInspectEvidence inspect={state.inspect} artifactId={artifactId} fallbackPacket={state.packet} />;
  }
  if (!state.packet.contextPack) {
    return (
      <div className="workflow-context-evidence-body">
        <div className="workflow-context-evidence-state">
          <FileText size={13} />
          <span>{t("Context source details are not available.")}</span>
          <small>{artifactId}</small>
        </div>
      </div>
    );
  }
  return <WorkflowContextPackEvidence packet={state.packet} artifactId={artifactId} />;
}

function WorkflowContextInspectEvidence({
  inspect,
  artifactId,
  fallbackPacket,
}: {
  readonly inspect: WorkflowContextInspectSummary;
  readonly artifactId: string;
  readonly fallbackPacket?: ChannelWorkflowStepContextPacket;
}): JSX.Element {
  const { t } = useI18n();
  if (inspect.availability !== "available") {
    if (fallbackPacket?.contextPack) {
      return <WorkflowContextPackEvidence packet={fallbackPacket} artifactId={artifactId} />;
    }
    return (
      <div className="workflow-context-evidence-body">
        <div className="workflow-context-evidence-state">
          <FileText size={13} />
          <span>{workflowContextInspectAvailabilityLabel(inspect.availability, t)}</span>
          <small>{inspect.contextArtifactId ?? artifactId}</small>
        </div>
      </div>
    );
  }
  const summary = buildConversationContextSourceSummaryFromInspect(inspect, t);

  return (
    <div className="workflow-context-evidence-body">
      <WorkflowContextSourceSummaryView summary={summary} />
      <WorkflowContextDeveloperDiagnostics>
        <WorkflowContextInspectBudgetDiagnostics inspect={inspect} t={t} />
      </WorkflowContextDeveloperDiagnostics>
    </div>
  );
}

function WorkflowContextPackEvidence({
  packet,
  artifactId,
}: {
  readonly packet: ChannelWorkflowStepContextPacket;
  readonly artifactId: string;
}): JSX.Element {
  const { t } = useI18n();
  const pack = packet.contextPack;
  if (!pack) {
    return (
      <div className="workflow-context-evidence-body">
        <div className="workflow-context-evidence-state">
          <FileText size={13} />
          <span>{t("Context source details are not available.")}</span>
          <small>{artifactId}</small>
        </div>
      </div>
    );
  }
  const summary = buildConversationContextSourceSummaryFromPacket(packet, t);
  return (
    <div className="workflow-context-evidence-body">
      <WorkflowContextSourceSummaryView summary={summary} />
      <WorkflowContextDeveloperDiagnostics>
        <WorkflowContextBudgetDiagnostics pack={pack} t={t} />
      </WorkflowContextDeveloperDiagnostics>
    </div>
  );
}

function WorkflowContextSourceSummaryView({
  summary,
}: {
  readonly summary: ConversationContextSourceSummary;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="workflow-context-source-summary" aria-label={t("Context source summary")}>
      <div className="workflow-context-source-head">
        <strong>{t("Sources used")}</strong>
        <small>{conversationContextSourceSummaryLabel(summary, t)}</small>
      </div>
      {summary.groups.length > 0 ? (
        <ul className="workflow-context-source-list">
          {summary.groups.map((group) => (
            <li key={group.id}>
              <span>{group.label}</span>
              <small>
                {group.count === 1 ? t("1 item") : t("{count} items", { count: group.count })}
                {group.examples.length > 0 ? ` · ${group.examples.join(", ")}` : ""}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <small className="workflow-context-source-empty">{summary.unavailableReason ?? t("No user-facing sources were recorded.")}</small>
      )}
      {summary.droppedCount > 0 || summary.compactionCount > 0 ? (
        <div className="workflow-context-source-foot">
          {summary.droppedCount > 0 ? <span>{t("{count} items omitted from model context", { count: summary.droppedCount })}</span> : null}
          {summary.compactionCount > 0 ? <span>{t("{count} compacted context summaries", { count: summary.compactionCount })}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowContextDeveloperDiagnostics({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <details className="workflow-context-developer-diagnostics">
      <summary>
        <span>{t("Developer diagnostics")}</span>
      </summary>
      {children}
    </details>
  );
}

function WorkflowContextBudgetDiagnostics({
  pack,
  t,
}: {
  readonly pack: WorkflowContextPackSnapshot;
  readonly t: Translate;
}): JSX.Element {
  const sectionEstimateCount = pack.sections.filter((section) => typeof section.estimatedTokens === "number").length;
  return (
    <details className="workflow-context-budget-diagnostics">
      <summary>
        <span>{t("Budget diagnostics")}</span>
        <small>{t("Developer diagnostics")}</small>
      </summary>
      <WorkflowContextEvidenceSection
        title={t("Token budget")}
        summary={workflowContextBudgetUsageLabel(pack, t)}
      >
        <dl className="workflow-context-diagnostics-grid">
          <div>
            <dt>{t("Budget mode")}</dt>
            <dd>{pack.budget.mode || t("Not recorded")}</dd>
          </div>
          <div>
            <dt>{t("Capability source")}</dt>
            <dd>{pack.budget.capabilitySource || t("Not recorded")}</dd>
          </div>
          <div>
            <dt>{t("Capability confidence")}</dt>
            <dd>{pack.budget.capabilityConfidence || t("Not recorded")}</dd>
          </div>
          <div>
            <dt>{t("Tokenizer")}</dt>
            <dd>{pack.budget.tokenizer || t("Not recorded")}</dd>
          </div>
          <div>
            <dt>{t("Context window")}</dt>
            <dd>{formatWorkflowTokenCount(pack.budget.contextWindowTokens, t)}</dd>
          </div>
          <div>
            <dt>{t("Reserved output")}</dt>
            <dd>{formatWorkflowTokenCount(pack.budget.reservedOutputTokens, t)}</dd>
          </div>
          <div>
            <dt>{t("Runtime overhead")}</dt>
            <dd>{formatWorkflowTokenCount(pack.budget.reservedRuntimeOverheadTokens, t)}</dd>
          </div>
          <div>
            <dt>{t("Input budget")}</dt>
            <dd>{formatWorkflowTokenCount(pack.budget.inputBudgetTokens, t)}</dd>
          </div>
          <div>
            <dt>{t("Estimated input")}</dt>
            <dd>{formatWorkflowTokenCount(pack.estimatedInputTokens, t)}</dd>
          </div>
          <div>
            <dt>{t("Over budget")}</dt>
            <dd>{pack.overBudget ? t("Yes") : t("No")}</dd>
          </div>
        </dl>
      </WorkflowContextEvidenceSection>

      <WorkflowContextEvidenceSection
        title={t("Section token estimates")}
        summary={t("{count} sections", { count: sectionEstimateCount })}
      >
        {pack.sections.length > 0 ? (
          <ul>
            {pack.sections.map((section) => (
              <li key={section.id}>
                <strong>{section.id}</strong>
                <small>{workflowContextSectionDiagnosticMeta(section, t)}</small>
              </li>
            ))}
          </ul>
        ) : <small>{t("No kept sections recorded.")}</small>}
      </WorkflowContextEvidenceSection>

      <WorkflowContextEvidenceSection
        title={t("Dropped section ids")}
        summary={t("{count} sections", { count: pack.droppedSectionIds.length })}
      >
        {pack.droppedSectionIds.length > 0 ? (
          <div className="workflow-context-chip-list">
            {pack.droppedSectionIds.map((sectionId) => <code key={sectionId}>{sectionId}</code>)}
          </div>
        ) : <small>{t("No sections dropped.")}</small>}
      </WorkflowContextEvidenceSection>

      <WorkflowContextEvidenceSection
        title={t("Compaction ids")}
        summary={t("{count} compactions", { count: pack.compactionIds.length })}
      >
        {pack.compactionIds.length > 0 ? (
          <div className="workflow-context-chip-list">
            {pack.compactionIds.map((compactionId) => <code key={compactionId}>{compactionId}</code>)}
          </div>
        ) : <small>{t("No compactions recorded.")}</small>}
      </WorkflowContextEvidenceSection>
    </details>
  );
}

function WorkflowContextInspectBudgetDiagnostics({
  inspect,
  t,
}: {
  readonly inspect: WorkflowContextInspectSummary;
  readonly t: Translate;
}): JSX.Element {
  const sectionEstimateCount = inspect.sections.filter((section) => typeof section.estimatedTokens === "number").length;
  return (
    <details className="workflow-context-budget-diagnostics">
      <summary>
        <span>{t("Budget diagnostics")}</span>
        <small>{t("Developer diagnostics")}</small>
      </summary>
      <WorkflowContextEvidenceSection
        title={t("Token budget")}
        summary={inspect.budget ? workflowContextInspectBudgetUsageLabel(inspect, t) : t("Not recorded")}
      >
        {inspect.budget ? (
          <dl className="workflow-context-diagnostics-grid">
            <div>
              <dt>{t("Budget mode")}</dt>
              <dd>{inspect.budget.mode || t("Not recorded")}</dd>
            </div>
            <div>
              <dt>{t("Capability source")}</dt>
              <dd>{inspect.budget.capabilitySource || t("Not recorded")}</dd>
            </div>
            <div>
              <dt>{t("Capability confidence")}</dt>
              <dd>{inspect.budget.capabilityConfidence || t("Not recorded")}</dd>
            </div>
            <div>
              <dt>{t("Tokenizer")}</dt>
              <dd>{inspect.budget.tokenizer || t("Not recorded")}</dd>
            </div>
            <div>
              <dt>{t("Input budget")}</dt>
              <dd>{formatWorkflowTokenCount(inspect.budget.inputBudgetTokens, t)}</dd>
            </div>
            <div>
              <dt>{t("Estimated input")}</dt>
              <dd>{formatWorkflowTokenCount(inspect.budget.estimatedInputTokens, t)}</dd>
            </div>
            <div>
              <dt>{t("Over budget")}</dt>
              <dd>{inspect.budget.overBudget ? t("Yes") : t("No")}</dd>
            </div>
          </dl>
        ) : <small>{t("Not recorded")}</small>}
      </WorkflowContextEvidenceSection>

      <WorkflowContextEvidenceSection
        title={t("Section token estimates")}
        summary={t("{count} sections", { count: sectionEstimateCount })}
      >
        {inspect.sections.length > 0 ? (
          <ul>
            {inspect.sections.map((section) => (
              <li key={section.id}>
                <strong>{section.id}</strong>
                <small>{workflowContextInspectSectionDiagnosticMeta(section, t)}</small>
              </li>
            ))}
          </ul>
        ) : <small>{t("No kept sections recorded.")}</small>}
      </WorkflowContextEvidenceSection>

      <WorkflowContextEvidenceSection
        title={t("Dropped section ids")}
        summary={t("{count} sections", { count: inspect.droppedSectionCount })}
      >
        {inspect.droppedSectionIds.length > 0 ? (
          <div className="workflow-context-chip-list">
            {inspect.droppedSectionIds.map((sectionId) => <code key={sectionId}>{sectionId}</code>)}
          </div>
        ) : <small>{t("No sections dropped.")}</small>}
      </WorkflowContextEvidenceSection>

      <WorkflowContextEvidenceSection
        title={t("Compaction ids")}
        summary={t("{count} compactions", { count: inspect.compactionCount })}
      >
        {inspect.compactionIds.length > 0 ? (
          <div className="workflow-context-chip-list">
            {inspect.compactionIds.map((compactionId) => <code key={compactionId}>{compactionId}</code>)}
          </div>
        ) : <small>{t("No compactions recorded.")}</small>}
      </WorkflowContextEvidenceSection>
    </details>
  );
}

function WorkflowContextEvidenceSection({
  title,
  summary,
  children,
}: {
  readonly title: string;
  readonly summary: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="workflow-context-evidence-section">
      <header>
        <strong>{title}</strong>
        <small>{summary}</small>
      </header>
      {children}
    </section>
  );
}

function workflowContextSectionDiagnosticMeta(section: WorkflowContextPackSectionSnapshot, t: Translate): string {
  return [
    section.role,
    section.priority,
    formatWorkflowTokenCount(section.estimatedTokens, t),
    t("{count} refs", { count: section.sourceRefIds?.length ?? 0 }),
  ].join(" · ");
}

function workflowContextInspectSectionDiagnosticMeta(section: WorkflowContextInspectSummary["sections"][number], t: Translate): string {
  return [
    section.role,
    section.priority,
    formatWorkflowTokenCount(section.estimatedTokens, t),
    t("{count} refs", { count: section.sourceRefIds.length }),
  ].join(" · ");
}

function workflowContextBudgetUsageLabel(pack: WorkflowContextPackSnapshot, t: Translate): string {
  const estimated = pack.estimatedInputTokens;
  const budget = pack.budget.inputBudgetTokens;
  if (!Number.isFinite(estimated) || !Number.isFinite(budget) || budget <= 0) {
    return t("Not recorded");
  }
  return `${formatWorkflowTokenCount(estimated, t)} / ${formatWorkflowTokenCount(budget, t)} (${Math.round((estimated / budget) * 100)}%)`;
}

function workflowContextInspectBudgetUsageLabel(inspect: WorkflowContextInspectSummary, t: Translate): string {
  const estimated = inspect.budget?.estimatedInputTokens;
  const budget = inspect.budget?.inputBudgetTokens;
  if (typeof estimated !== "number" || typeof budget !== "number" || !Number.isFinite(estimated) || !Number.isFinite(budget) || budget <= 0) {
    return t("Not recorded");
  }
  return `${formatWorkflowTokenCount(estimated, t)} / ${formatWorkflowTokenCount(budget, t)} (${Math.round((estimated / budget) * 100)}%)`;
}

function formatWorkflowTokenCount(value: number | undefined, t: Translate): string {
  return typeof value === "number" && Number.isFinite(value) ? t("{count} tokens", { count: value }) : t("Not recorded");
}

function workflowContextInspectAvailabilityLabel(
  availability: WorkflowContextInspectSummary["availability"],
  t: Translate,
): string {
  if (availability === "missing_context_artifact") {
    return t("No persisted context snapshot for this step.");
  }
  if (availability === "unreadable_context_packet") {
    return t("Context source details could not be read.");
  }
  if (availability === "missing_context_pack") {
    return t("Context source details are not available.");
  }
  return t("Context source details are available.");
}

function workflowStepFailurePolicyLabel(policy: string, t: Translate): string {
  if (policy === "block_for_user") {
    return t("Block for user");
  }
  if (policy === "fail_workflow") {
    return t("Fail workflow");
  }
  if (policy === "cancel_workflow") {
    return t("Cancel workflow");
  }
  if (policy === "skip_if_optional") {
    return t("Skip if optional");
  }
  return policy;
}

function workflowGateStageLabel(stage: "pre" | "post", t: Translate): string {
  return stage === "pre" ? t("Pre-step gate") : t("Post-step gate");
}

export function WorkflowFinalSummary({
  workflow,
  steps,
  artifactsByRun,
}: {
  readonly workflow: ChannelWorkflow;
  readonly steps: readonly ChannelWorkflowStep[];
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
}): JSX.Element {
  const { t } = useI18n();
  const orderedSteps = [...steps].sort((left, right) => left.position - right.position);
  const completedSteps = orderedSteps.filter((step) => step.status === "succeeded" || step.status === "skipped");
  const runIds = uniqueStrings(orderedSteps.map((step) => step.runId).filter((id): id is string => Boolean(id)));
  const artifacts = runIds.flatMap((runId) => artifactsByRun[runId] ?? []);
  const changedFiles = uniqueStrings(artifacts.map((artifact) => artifact.path).filter(Boolean));
  const summaries = orderedSteps
    .filter((step) => step.resultSummary)
    .map((step) => `${step.title}: ${step.resultSummary}`);

  return (
    <div className="workflow-final-summary" aria-label={t("Workflow summary")}>
      <strong>{t("Workflow summary")}</strong>
      <div className="context-packet muted">
        <span>{workflow.title}</span>
        <span>{t("{count} steps", { count: completedSteps.length })}</span>
        <span>{t("{count} runs", { count: runIds.length })}</span>
        <span>{t("{count} artifacts", { count: artifacts.length })}</span>
      </div>
      {summaries.length > 0 ? (
        <div className="context-packet muted">
          {summaries.slice(0, 4).map((summary) => <span key={summary}>{summary}</span>)}
        </div>
      ) : null}
      {changedFiles.length > 0 ? (
        <div className="context-packet muted">
          <span>{t("Changed files")}: {changedFiles.slice(0, 4).join(", ")}{changedFiles.length > 4 ? ` +${changedFiles.length - 4}` : ""}</span>
        </div>
      ) : null}
    </div>
  );
}

function isWorkflowStepTerminal(status: ChannelWorkflowStep["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "skipped" || status === "cancelled";
}

export function workflowCanAdvance(status: ChannelWorkflow["status"]): boolean {
  return status === "ready" || status === "running" || status === "waiting_for_approval" || status === "blocked";
}

export function workflowCanCancel(status: ChannelWorkflow["status"]): boolean {
  return status === "draft" || status === "ready" || status === "running" || status === "waiting_for_approval" || status === "blocked";
}

export function ChannelExecutionProposalCard({
  proposal,
  assigneeLabel,
  teammates,
  linkedRun,
  linkedWorkflow,
  activeRunId,
  latestStatus,
  onConfirm,
  onCancel,
  onUpdate,
  onOpenRun,
}: {
  readonly proposal: ChannelExecutionProposal;
  readonly assigneeLabel: string;
  readonly teammates: readonly ChannelMention[];
  readonly linkedRun: RunSession | undefined;
  readonly linkedWorkflow: ChannelWorkflow | undefined;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onUpdate: (
    proposal: ChannelExecutionProposal,
    input: UpdateChannelExecutionProposalRequest,
  ) => Promise<ChannelExecutionProposal | undefined>;
  readonly onOpenRun: (runId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [draft, setDraft] = useState<ChannelProposalEditDraft>(() => proposalToEditDraft(proposal));
  const canStart = proposal.status === "draft" || proposal.status === "blocked" || proposal.status === "run_failed";
  const canEdit = canStart && !proposal.linkedWorkflowId;
  const linkedRunStatus = proposal.linkedRunId
    ? displayLinkedRunStatus(proposal.linkedRunId, linkedRun, activeRunId, latestStatus)
    : "";
  const linkedWorkflowStatus = proposal.linkedWorkflowId
    ? (linkedWorkflow?.status ?? "workflow")
    : "";
  const collaborationSummary = proposalCollaborationSummary(proposal, teammates, t);
  const permissionSummary = buildProposalPermissionSummary({ proposal, assigneeLabel, t });
  const shapingRows = buildRequirementShapingRows({ proposal, assigneeLabel, t });
  const isRequirementShaping = proposal.status === "draft" && !editing;
  const statusIcon = proposal.status === "accepted"
    ? <CheckCircle2 size={14} />
    : proposal.status === "blocked" || proposal.status === "run_failed"
      ? <CircleAlert size={14} />
      : <Play size={14} />;
  const draftValid = proposalDraftIsValid(draft);

  useEffect(() => {
    if (!editing) {
      setDraft(proposalToEditDraft(proposal));
      setEditError("");
    }
  }, [editing, proposal]);

  async function saveEdit(): Promise<void> {
    if (!draftValid || saving) {
      return;
    }
    setSaving(true);
    setEditError("");
    try {
      const updated = await onUpdate(proposal, proposalDraftToUpdateInput(proposal, draft));
      if (updated) {
        setEditing(false);
      }
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function updateStep(index: number, patch: Partial<ChannelProposalStepDraft>): void {
    setDraft((current) => ({
      ...current,
      collaborationSteps: current.collaborationSteps.map((step, stepIndex) =>
        stepIndex === index
          ? {
              ...step,
              ...patch,
              ...(patch.teammateId && patch.teammateId !== step.teammateId ? { sources: undefined } : {}),
            }
          : step
      ),
    }));
  }

  function removeStep(index: number): void {
    setDraft((current) => ({
      ...current,
      collaborationSteps: current.collaborationSteps.filter((_, stepIndex) => stepIndex !== index),
    }));
  }

  function addStep(): void {
    setDraft((current) => ({
      ...current,
      collaborationSteps: [
        ...current.collaborationSteps,
        {
          teammateId: current.assigneeTeammateId || teammates[0]?.id || proposal.assigneeTeammateId,
          action: "coordinated",
          summary: "",
        },
      ],
    }));
  }

  return (
    <div className={`channel-execution-proposal ${proposal.status} ${isRequirementShaping ? "requirement-shaping-card" : ""}`} aria-label={t("Task confirmation")}>
      <div className="channel-proposal-head">
        <span>
          {statusIcon}
          <strong>{proposal.title}</strong>
        </span>
        <small>{t(executionProposalStatusLabel(proposal.status))}</small>
      </div>
      {editing ? (
        <div className="channel-proposal-edit-form">
          <label>
            <span>{t("Title")}</span>
            <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.currentTarget.value })} />
          </label>
          <label>
            <span>{t("Scope")}</span>
            <textarea rows={4} value={draft.prompt} onChange={(event) => setDraft({ ...draft, prompt: event.currentTarget.value })} />
          </label>
          <label>
            <span>{t("Assignee")}</span>
            <select value={draft.assigneeTeammateId} onChange={(event) => setDraft({ ...draft, assigneeTeammateId: event.currentTarget.value })}>
              {teammates.map((teammate) => (
                <option key={teammate.id} value={teammate.id}>{teammate.label}</option>
              ))}
              {teammates.some((teammate) => teammate.id === draft.assigneeTeammateId) ? null : (
                <option value={draft.assigneeTeammateId}>{teammateLabel(draft.assigneeTeammateId, teammates, t("Deleted teammate"))}</option>
              )}
            </select>
          </label>
          <label>
            <span>{t("Acceptance criteria")}</span>
            <textarea rows={3} value={draft.acceptanceCriteriaText} onChange={(event) => setDraft({ ...draft, acceptanceCriteriaText: event.currentTarget.value })} />
          </label>
          <label>
            <span>{t("Requirement summary")}</span>
            <textarea rows={3} value={draft.shapingSummaryText} onChange={(event) => setDraft({ ...draft, shapingSummaryText: event.currentTarget.value })} />
          </label>
          <label>
            <span>{t("Open questions")}</span>
            <textarea rows={3} value={draft.shapingOpenQuestionsText} onChange={(event) => setDraft({ ...draft, shapingOpenQuestionsText: event.currentTarget.value })} />
          </label>
          <label>
            <span>{t("User clarifications")}</span>
            <textarea rows={3} value={draft.shapingClarificationsText} onChange={(event) => setDraft({ ...draft, shapingClarificationsText: event.currentTarget.value })} />
          </label>
          <div className="channel-proposal-edit-steps">
            <div className="channel-proposal-edit-steps-head">
              <strong>{t("Steps")}</strong>
              <button className="secondary-button compact-button" type="button" onClick={addStep}>
                <Plus size={14} />
                {t("Add step")}
              </button>
            </div>
            {draft.collaborationSteps.map((step, index) => (
              <div className="channel-proposal-edit-step" key={`${index}-${step.teammateId}-${step.action}`}>
                <select value={step.teammateId} onChange={(event) => updateStep(index, { teammateId: event.currentTarget.value })}>
                  {teammates.map((teammate) => (
                    <option key={teammate.id} value={teammate.id}>{teammate.label}</option>
                  ))}
                  {teammates.some((teammate) => teammate.id === step.teammateId) ? null : (
                    <option value={step.teammateId}>{teammateLabel(step.teammateId, teammates, t("Deleted teammate"))}</option>
                  )}
                </select>
                <select value={step.action} onChange={(event) => updateStep(index, { action: event.currentTarget.value as ChannelProposalStepDraft["action"] })}>
                  {proposalStepActions.map((action) => (
                    <option key={action} value={action}>{t(proposalStepActionLabel(action))}</option>
                  ))}
                </select>
                <textarea rows={2} value={step.summary} onChange={(event) => updateStep(index, { summary: event.currentTarget.value })} />
                <button className="secondary-button danger compact-button" type="button" onClick={() => removeStep(index)} disabled={draft.collaborationSteps.length <= 1}>
                  <Trash2 size={14} />
                  {t("Remove")}
                </button>
              </div>
            ))}
          </div>
          {editError ? (
            <div className="channel-proposal-error">
              <CircleAlert size={14} />
              <span>{editError}</span>
            </div>
          ) : null}
        </div>
      ) : isRequirementShaping ? (
        <RequirementShapingSummary
          rows={shapingRows}
          shaping={proposal.shaping}
          collaborationSteps={proposal.collaborationSteps}
          teammates={teammates}
        />
      ) : (
        <p>{proposal.prompt}</p>
      )}
      <div className="channel-proposal-meta">
        <span>{t("Assignee")}: <strong>{assigneeLabel}</strong></span>
        {proposal.requiredTools.length > 0 ? <span>{t("Required tools")}: {proposal.requiredTools.join(", ")}</span> : null}
        {linkedWorkflowStatus ? <StatusBadge status={linkedWorkflowStatus} /> : null}
        {linkedRunStatus ? <StatusBadge status={linkedRunStatus} /> : null}
      </div>
      {!editing && canStart ? (
        <section className="channel-proposal-permission" aria-label={t("Task permission confirmation")}>
          <div className="channel-proposal-permission-head">
            <ShieldCheck size={14} />
            <strong>{t("Task permission confirmation")}</strong>
          </div>
          <p>{permissionSummary.sentence}</p>
          <div className="channel-proposal-permission-grid">
            <span>
              <small>{t("Required tool")}</small>
              <strong>{permissionSummary.toolLabel}</strong>
            </span>
            <span>
              <small>{t("Target")}</small>
              <strong>{permissionSummary.targetLabel}</strong>
            </span>
            <span>
              <small>{t("Executor")}</small>
              <strong>{permissionSummary.executorLabel}</strong>
            </span>
          </div>
          <small>{t("Starting this task does not approve future runtime actions. Ling may still ask before file changes, commands, MCP tools, or external actions.")}</small>
        </section>
      ) : null}
      {proposal.acceptanceCriteria.length > 0 ? (
        <div className="channel-proposal-criteria">
          <strong>{t("Acceptance criteria")}</strong>
          <ul>
            {proposal.acceptanceCriteria.slice(0, 4).map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {proposal.riskSummary ? (
        <div className="channel-proposal-risk">
          <CircleAlert size={14} />
          <span>{proposal.riskSummary}</span>
        </div>
      ) : null}
      {proposal.errorMessage ? (
        <div className="channel-proposal-error">
          <CircleAlert size={14} />
          <span>{proposal.errorMessage}</span>
        </div>
      ) : null}
      {proposal.collaborationSteps.length > 0 ? (
        <details className="channel-proposal-collaboration">
          <summary>
            <span className="channel-proposal-collaboration-summary">
              <History size={14} />
              <strong>{t("Collaboration {count} records", { count: proposal.collaborationSteps.length })}</strong>
              {collaborationSummary ? (
                <>
                  <span aria-hidden="true">·</span>
                  <small>{collaborationSummary}</small>
                </>
              ) : null}
            </span>
          </summary>
          <ol>
            {proposal.collaborationSteps.map((step, index) => {
              const sourceLabel = proposalStepSourceLabel(step, t);
              return (
                <li key={`${step.teammateId}-${step.action}-${index}`}>
                  <strong>{teammateLabel(step.teammateId, teammates, t("Deleted teammate"))}</strong>
                  <span className="channel-proposal-step-meta">
                    <small>{t(proposalStepActionLabel(step.action))}</small>
                    {sourceLabel ? (
                      <small className="channel-proposal-step-source">{sourceLabel}</small>
                    ) : null}
                  </span>
                  <span className="channel-proposal-step-summary">{step.summary}</span>
                </li>
              );
            })}
          </ol>
        </details>
      ) : null}
      <div className="channel-proposal-actions">
        {editing ? (
          <>
            <button className="primary-button compact-button" type="button" onClick={() => void saveEdit()} disabled={saving || !draftValid}>
              {saving ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
              {t("Save")}
            </button>
            <button className="secondary-button compact-button" type="button" onClick={() => setEditing(false)} disabled={saving}>
              <X size={14} />
              {t("Cancel")}
            </button>
          </>
        ) : canStart ? (
          <button className="primary-button compact-button" type="button" onClick={onConfirm}>
            <Play size={14} />
            {t("Authorize and start task")}
          </button>
        ) : null}
        {!editing && canEdit ? (
          <button className="secondary-button compact-button" type="button" onClick={() => setEditing(true)}>
            <SlidersHorizontal size={14} />
            {t("Edit")}
          </button>
        ) : null}
        {proposal.linkedRunId ? (
          <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(proposal.linkedRunId ?? "")}>
            <SquareTerminal size={14} />
            {t("Open run")}
          </button>
        ) : null}
        {proposal.status === "draft" ? (
          <button className="secondary-button compact-button" type="button" onClick={onCancel}>
            <X size={14} />
            {t("Cancel proposal")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RequirementShapingSummary({
  rows,
  shaping,
  collaborationSteps,
  teammates,
}: {
  readonly rows: readonly RequirementShapingRow[];
  readonly shaping: ChannelExecutionProposal["shaping"];
  readonly collaborationSteps: ChannelExecutionProposal["collaborationSteps"];
  readonly teammates: readonly ChannelMention[];
}): JSX.Element {
  const { t } = useI18n();
  const visibleSteps = collaborationSteps.slice(0, 4);
  const openQuestions = shaping?.openQuestions.slice(0, 4) ?? [];
  const clarifications = shaping?.clarifications.slice(0, 4) ?? [];
  return (
    <section className="requirement-shaping-summary" aria-label={t("Requirement shaping")}>
      <header>
        <span>
          <ListChecks size={15} />
          <strong>{t("Ling is shaping the task")}</strong>
        </span>
        <small>{t(requirementShapingStatusLabel(shaping?.status ?? "ready_for_confirmation"))}</small>
      </header>
      <div className="requirement-shaping-grid">
        {rows.map((row) => (
          <span key={row.id} className={row.tone ?? "neutral"}>
            <small>{row.label}</small>
            <strong>{row.value}</strong>
          </span>
        ))}
      </div>
      {openQuestions.length > 0 || clarifications.length > 0 ? (
        <div className="requirement-shaping-notes">
          {openQuestions.length > 0 ? (
            <section aria-label={t("Open questions")}>
              <small>{t("Open questions")}</small>
              <ul>
                {openQuestions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {clarifications.length > 0 ? (
            <section aria-label={t("User clarifications")}>
              <small>{t("User clarifications")}</small>
              <ul>
                {clarifications.map((clarification) => (
                  <li key={clarification.id}>{clarification.body}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
      {visibleSteps.length > 0 ? (
        <div className="requirement-shaping-participants" aria-label={t("Shaping participants")}>
          {visibleSteps.map((step, index) => (
            <span key={`${step.teammateId}-${step.action}-${index}`}>
              <small>{teammateLabel(step.teammateId, teammates, t("Deleted teammate"))} · {t(proposalStepActionLabel(step.action))}</small>
              <strong>{step.summary}</strong>
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function proposalToEditDraft(proposal: ChannelExecutionProposal): ChannelProposalEditDraft {
  const collaborationSteps = proposal.collaborationSteps.length > 0
    ? proposal.collaborationSteps
    : [{ teammateId: proposal.assigneeTeammateId, action: "coordinated", summary: "Complete the confirmed execution proposal." } satisfies ChannelProposalStepDraft];
  return {
    title: proposal.title,
    prompt: proposal.prompt,
    assigneeTeammateId: proposal.assigneeTeammateId,
    acceptanceCriteriaText: proposal.acceptanceCriteria.join("\n"),
    shapingSummaryText: proposal.shaping?.summary ?? "",
    shapingOpenQuestionsText: proposal.shaping?.openQuestions.join("\n") ?? "",
    shapingClarificationsText: proposal.shaping?.clarifications.map((clarification) => clarification.body).join("\n") ?? "",
    collaborationSteps,
  };
}

function proposalDraftIsValid(draft: ChannelProposalEditDraft): boolean {
  return draft.title.trim().length > 0 &&
    draft.prompt.trim().length > 0 &&
    draft.assigneeTeammateId.trim().length > 0 &&
    parseProposalLines(draft.acceptanceCriteriaText).length > 0 &&
    draft.collaborationSteps.length > 0 &&
    draft.collaborationSteps.every((step) => step.teammateId.trim().length > 0 && step.summary.trim().length > 0);
}

function proposalDraftToUpdateInput(proposal: ChannelExecutionProposal, draft: ChannelProposalEditDraft): UpdateChannelExecutionProposalRequest {
  return {
    title: draft.title.trim(),
    prompt: draft.prompt.trim(),
    assigneeTeammateId: draft.assigneeTeammateId.trim(),
    acceptanceCriteria: parseProposalLines(draft.acceptanceCriteriaText),
    collaborationSteps: draft.collaborationSteps.map((step) => ({
      teammateId: step.teammateId.trim(),
      action: step.action,
      summary: step.summary.trim(),
      ...(step.sources && step.sources.length > 0 ? { sources: step.sources } : {}),
    })),
    shaping: proposalShapingFromEditDraft(proposal, draft),
  };
}

function buildRequirementShapingRows(input: {
  readonly proposal: ChannelExecutionProposal;
  readonly assigneeLabel: string;
  readonly t: Translate;
}): readonly RequirementShapingRow[] {
  const participantCount = Math.max(1, input.proposal.collaborationSteps.length);
  const firstCriterion = input.proposal.acceptanceCriteria[0];
  const openQuestionCount = input.proposal.shaping?.openQuestions.length ?? 0;
  const clarificationCount = input.proposal.shaping?.clarifications.length ?? 0;
  const shapingSummary = input.proposal.shaping?.summary;
  return [
    {
      id: "goal",
      label: input.t("Goal"),
      value: truncatePreview(shapingSummary || input.proposal.prompt, 180),
    },
    {
      id: "acceptance",
      label: input.t("Acceptance"),
      value: firstCriterion
        ? truncatePreview(firstCriterion, 150)
        : input.t("Acceptance checks will be clarified before execution."),
      tone: firstCriterion ? "success" : "attention",
    },
    {
      id: "participants",
      label: input.t("Participants"),
      value: input.t("{count} teammate(s), led by {teammate}", {
        count: participantCount,
        teammate: input.assigneeLabel,
      }),
    },
    {
      id: "risk",
      label: input.t("Boundary"),
      value: input.proposal.riskSummary
        ? truncatePreview(input.proposal.riskSummary, 150)
        : input.t("No additional boundary surfaced yet."),
      tone: input.proposal.riskSummary ? "attention" : "neutral",
    },
    {
      id: "questions",
      label: input.t("Open questions"),
      value: openQuestionCount > 0
        ? input.t("{count} open question(s)", { count: openQuestionCount })
        : clarificationCount > 0
          ? input.t("{count} clarification(s) recorded", { count: clarificationCount })
          : input.t("No open questions recorded."),
      tone: openQuestionCount > 0 ? "attention" : clarificationCount > 0 ? "success" : "neutral",
    },
    {
      id: "next",
      label: input.t("Next action"),
      value: input.t("Authorize when the scope looks right, or edit the card first."),
    },
  ];
}

function proposalShapingFromEditDraft(
  proposal: ChannelExecutionProposal,
  draft: ChannelProposalEditDraft,
): NonNullable<UpdateChannelExecutionProposalRequest["shaping"]> {
  const openQuestions = parseProposalLines(draft.shapingOpenQuestionsText);
  const clarificationBodies = parseProposalLines(draft.shapingClarificationsText);
  const existingClarifications = proposal.shaping?.clarifications ?? [];
  const now = new Date().toISOString();
  return {
    status: openQuestions.length > 0 ? "needs_user_clarification" : "ready_for_confirmation",
    summary: draft.shapingSummaryText.trim() || draft.title.trim(),
    openQuestions,
    clarifications: clarificationBodies.map((body, index) => {
      const existing = existingClarifications[index];
      if (existing?.body === body) {
        return existing;
      }
      return {
        id: `clarification_${proposal.id}_${index + 1}`,
        authorType: "local-user",
        body,
        sourceMessageId: proposal.sourceMessageId,
        createdAt: now,
      };
    }),
    sourceRefs: proposal.shaping?.sourceRefs.length
      ? proposal.shaping.sourceRefs
      : [{ type: "message", id: proposal.sourceMessageId }],
    updatedAt: now,
  };
}

function parseProposalLines(value: string): readonly string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

interface ProposalPermissionSummary {
  readonly sentence: string;
  readonly toolLabel: string;
  readonly targetLabel: string;
  readonly executorLabel: string;
}

function buildProposalPermissionSummary(input: {
  readonly proposal: ChannelExecutionProposal;
  readonly assigneeLabel: string;
  readonly t: Translate;
}): ProposalPermissionSummary {
  const { proposal, t } = input;
  const primaryTool = proposalPermissionPrimaryTool(proposal.requiredTools);
  const targetLabel = extractProposalPermissionTarget(proposal, primaryTool) ?? t("declared task scope");
  const toolLabel = proposal.requiredTools.length > 0 ? proposal.requiredTools.join(", ") : t("workspace tools");
  const sentence = proposalPermissionSentence({
    tool: primaryTool,
    targetLabel,
    t,
  });
  return {
    sentence,
    toolLabel,
    targetLabel,
    executorLabel: input.assigneeLabel,
  };
}

function proposalPermissionPrimaryTool(
  tools: readonly ChannelExecutionProposal["requiredTools"][number][],
): ChannelExecutionProposal["requiredTools"][number] | undefined {
  if (tools.includes("write")) {
    return "write";
  }
  if (tools.includes("edit")) {
    return "edit";
  }
  if (tools.includes("bash")) {
    return "bash";
  }
  return tools[0];
}

function proposalPermissionSentence(input: {
  readonly tool?: ChannelExecutionProposal["requiredTools"][number];
  readonly targetLabel: string;
  readonly t: Translate;
}): string {
  if (input.tool === "write") {
    return input.t("Need write permission to create {target} for this task.", { target: input.targetLabel });
  }
  if (input.tool === "edit") {
    return input.t("Need edit permission to update {target} for this task.", { target: input.targetLabel });
  }
  if (input.tool === "bash") {
    return input.t("Need bash permission to run {target} for this task.", { target: input.targetLabel });
  }
  if (input.tool) {
    return input.t("Need {tool} permission for {target} in this task.", { tool: input.tool, target: input.targetLabel });
  }
  return input.t("Confirm this bounded task scope before Ling starts.");
}

function extractProposalPermissionTarget(
  proposal: ChannelExecutionProposal,
  primaryTool?: ChannelExecutionProposal["requiredTools"][number],
): string | undefined {
  const sources = [proposal.riskSummary, proposal.prompt, proposal.title].filter((value): value is string => Boolean(value?.trim()));
  if (primaryTool === "bash") {
    const command = sources.map(extractProposalCommandTarget).find((value): value is string => Boolean(value));
    if (command) {
      return command;
    }
  }
  const path = sources.map(extractProposalPathTarget).find((value): value is string => Boolean(value));
  if (path) {
    return path;
  }
  return primaryTool === "bash" ? trimPermissionTarget(proposal.title.replace(/^run\s+/iu, "")) : undefined;
}

function extractProposalCommandTarget(value: string): string | undefined {
  const explicitCommand = /Command requested by user:\s*([^\n]+)/iu.exec(value)?.[1];
  if (explicitCommand) {
    return trimPermissionTarget(explicitCommand);
  }
  const riskCommand = /(?:run|运行)\s+(.+?)(?:[；;\n]|$)/iu.exec(value)?.[1];
  if (riskCommand) {
    return trimPermissionTarget(riskCommand);
  }
  return undefined;
}

function extractProposalPathTarget(value: string): string | undefined {
  const matches = value.match(/(?:\/[^\s`"'，。；;:)]+|(?:\.{1,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\.[A-Za-z0-9]{1,8})/gu) ?? [];
  return matches
    .map(trimPermissionTarget)
    .find((candidate) => Boolean(candidate && !candidate.startsWith("http://") && !candidate.startsWith("https://")));
}

function trimPermissionTarget(value: string): string | undefined {
  const trimmed = value.trim().replace(/^[`"']+/u, "").replace(/[`"',，。；;:)]+$/u, "").replace(/\.$/u, "");
  return trimmed ? truncatePreview(trimmed, 180) : undefined;
}

function executionProposalStatusLabel(status: ChannelExecutionProposal["status"]): string {
  if (status === "draft") {
    return "Ready for confirmation";
  }
  if (status === "accepted") {
    return "Accepted";
  }
  if (status === "blocked") {
    return "Proposal blocked";
  }
  if (status === "run_failed") {
    return "Run failed";
  }
  if (status === "superseded") {
    return "Superseded";
  }
  return "Cancelled";
}

function requirementShapingStatusLabel(status: NonNullable<ChannelExecutionProposal["shaping"]>["status"]): string {
  if (status === "collecting_context") {
    return "Collecting context";
  }
  if (status === "collecting_teammate_input") {
    return "Collecting teammate input";
  }
  if (status === "needs_user_clarification") {
    return "Needs user clarification";
  }
  if (status === "converted_to_task") {
    return "Converted to task";
  }
  if (status === "dismissed") {
    return "Dismissed";
  }
  return "Ready for confirmation";
}

function proposalStepActionLabel(action: ChannelExecutionProposal["collaborationSteps"][number]["action"]): string {
  if (action === "coordinated") {
    return "Coordinated";
  }
  if (action === "consulted") {
    return "Consulted";
  }
  if (action === "reviewed") {
    return "Reviewed";
  }
  return "Flagged risk";
}

function proposalStepSourceLabel(
  step: ChannelExecutionProposal["collaborationSteps"][number],
  t: Translate,
): string {
  const councilSource = step.sources?.find((source) => source.kind === "council");
  if (councilSource) {
    return t("From {source}", { source: councilSource.councilDisplayName ?? t("AI council") });
  }
  const directSource = step.sources?.find((source) => source.kind === "direct");
  if (directSource?.isDefault) {
    return t("Default channel teammate");
  }
  return directSource ? t("Direct channel teammate") : "";
}

function workflowStepSourceLabel(
  metadata: NonNullable<ChannelWorkflowStep["metadata"]>,
  t: Translate,
): string {
  const councilSource = metadata.proposalStepSources?.find((source) => source.kind === "council");
  if (councilSource) {
    return t("From {source}", { source: councilSource.councilDisplayName ?? t("AI council") });
  }
  const directSource = metadata.proposalStepSources?.find((source) => source.kind === "direct");
  if (directSource?.isDefault) {
    return t("Default channel teammate");
  }
  return directSource ? t("Direct channel teammate") : "";
}

function proposalCollaborationSummary(
  proposal: ChannelExecutionProposal,
  teammates: readonly ChannelMention[],
  t: Translate,
): string {
  return proposal.collaborationSteps
    .slice(0, 2)
    .map((step) => {
      const teammate = teammateLabel(step.teammateId, teammates, t("Deleted teammate"));
      const summary = step.summary.trim() || t(proposalStepActionLabel(step.action));
      return `${teammate} ${summary}`;
    })
    .join(" · ");
}
