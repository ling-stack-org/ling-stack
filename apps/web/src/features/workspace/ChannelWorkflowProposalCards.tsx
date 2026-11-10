import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FileText,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Workflow,
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
import { approvalProfileText } from "../teammates/helpers.js";
import type {
  ChannelAttachment,
  ChannelBrief,
  ChannelContextSummary,
  ChannelDecision,
  ChannelHandoff,
  ChannelLinkPreview,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ChannelWorkflowStepContextPacket,
  ChannelWorkflowStepStartMode,
  EffectiveConversationModelSourceV1,
  RunArtifact,
  RunSession,
  WorkflowContextInspectSummary,
  WorkflowEvidenceDiagnostic,
} from "../../types.js";
import { ChannelWorkflowStatusIndicator, ChannelWorkflowStatusLabel } from "./ChannelWorkflowStatusIndicator.js";

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter(Boolean))];
}

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
  operationErrors,
  onStartWorkflowStep,
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
  readonly operationErrors: Readonly<Record<string, string>>;
  readonly onStartWorkflowStep: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => void;
  readonly onUpdateWorkflowStepStatus: (step: ChannelWorkflowStep, status: "skipped" | "cancelled") => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const orderedSteps = [...steps].sort((left, right) => left.position - right.position);
  const workflowContextSummaries = contextSummaries.filter((summary) => orderedSteps.some((step) => step.contextSummaryId === summary.id));
  return (
    <div className="protocol-row workflow-queue-card">
      <div className="workflow-queue-head">
        <span>
          <strong>{workflow.title}</strong>
          <small><ChannelWorkflowStatusLabel status={workflow.status} /> · {workflow.objective}</small>
        </span>
        <ChannelWorkflowStatusIndicator kind="workflow" status={workflow.status} />
      </div>
      {operationErrors[workflow.id] ? (
        <div className="provider-run-notice compact" role="alert">
          <CircleAlert size={14} />
          <span>{operationErrors[workflow.id]}</span>
        </div>
      ) : null}
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
              operationError={operationErrors[step.id]}
              contextSummary={contextSummaries.find((summary) => summary.id === step.contextSummaryId)}
              artifactsByRun={artifactsByRun}
              onStartWorkflowStep={onStartWorkflowStep}
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
  operationError,
  contextSummary,
  artifactsByRun,
  onStartWorkflowStep,
  onUpdateWorkflowStepStatus,
}: {
  readonly cwd: string;
  readonly step: ChannelWorkflowStep;
  readonly running: boolean;
  readonly operationError?: string;
  readonly contextSummary: ChannelContextSummary | undefined;
  readonly artifactsByRun: Readonly<Record<string, readonly RunArtifact[]>>;
  readonly onStartWorkflowStep: (step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode) => void;
  readonly onUpdateWorkflowStepStatus: (step: ChannelWorkflowStep, status: "skipped" | "cancelled") => void;
}): React.JSX.Element {
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
        <ChannelWorkflowStatusIndicator kind="step" status={step.status} />
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
      {operationError && operationError !== step.blocker ? (
        <div className="provider-run-notice compact" role="alert">
          <CircleAlert size={14} />
          <span>{operationError}</span>
        </div>
      ) : null}
      {metadata ? (
        <div className="context-packet muted">
          {metadata.templateStepId ? <span>{t("Template")}: {metadata.templateStepId}</span> : null}
          {metadata.skillId ? <span>{t("Skill")}: {metadata.skillId}</span> : null}
          {metadata.requestedRunnerId ? <span>{t("Runner")}: {metadata.requestedRunnerId}</span> : null}
          {metadata.providerPresetId ? <span>{t("Provider")}: {metadata.providerPresetId}</span> : null}
          {metadata.providerBinding ? (
            <span>{t("Model owner")}: {t(workflowProviderBindingSourceLabel(metadata.providerBinding.source))}</span>
          ) : null}
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
}): React.JSX.Element {
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
}): React.JSX.Element | null {
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
}): React.JSX.Element {
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
}): React.JSX.Element {
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
}): React.JSX.Element {
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
}): React.JSX.Element {
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
}): React.JSX.Element {
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
}): React.JSX.Element {
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
}): React.JSX.Element {
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
}): React.JSX.Element {
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
}): React.JSX.Element {
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

export function workflowStepCanRetry(status: ChannelWorkflowStep["status"]): boolean {
  return status === "blocked";
}

function workflowProviderBindingSourceLabel(
  source: EffectiveConversationModelSourceV1,
): string {
  if (source === "channel_ling_agent_model") return "Ling Agent model";
  if (source === "teammate_fixed") return "Fixed model";
  return "Workspace default";
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
