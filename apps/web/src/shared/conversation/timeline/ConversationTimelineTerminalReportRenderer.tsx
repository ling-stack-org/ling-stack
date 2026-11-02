import { CheckCircle2, CircleAlert, FileCheck2, ShieldAlert } from "lucide-react";
import { conversationTimelineRendererKey } from "@ling-stack/conversation-ui-core";
import type {
  ConversationOperationSourceRef,
  ConversationTimelineTerminalReportArtifact,
  ConversationTimelineTerminalReportItem,
} from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { MessageBodyRenderer } from "../blocks/MessageBodyRenderer.js";
import { ConversationTimelineFileReference } from "./ConversationTimelineFileChangeDetail.js";
import type { ConversationTimelineSourceRefHandler } from "./source-ref.js";
import { terminalReportDisplaySourceRefs, terminalReportSourceRefGroups } from "./terminal-report-display-refs.js";
import { terminalReportFinalPresentation, terminalReportResultMeta } from "./terminal-report-fallback-summary.js";
import "./conversation-terminal-response.css";

export function ConversationTimelineTerminalReportRenderer({
  item: inputItem,
  depth,
  hasNarration = false,
  cwd,
  onOpenSourceRef,
}: {
  readonly item: ConversationTimelineTerminalReportItem;
  readonly depth: 0 | 1;
  readonly hasNarration?: boolean;
  readonly cwd?: string;
  readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler;
}): React.JSX.Element | null {
  const presentation = terminalReportFinalPresentation(inputItem, hasNarration);
  const { item, summary, needsAttention } = presentation;
  if (!presentation.visible) return null;
  const hasDetail = presentation.corrections.length > 0 || presentation.verification.length > 0 ||
    presentation.participants.length > 0 || presentation.artifacts.length > 0 || presentation.risks.length > 0;
  return (
    <div className="conversation-timeline-terminal-response" data-conversation-terminal-response={item.reportId}
      data-conversation-timeline-kind={!presentation.showStatus ? item.kind : undefined}
      data-conversation-timeline-renderer-key={!presentation.showStatus ? conversationTimelineRendererKey(item.kind) : undefined}
      data-conversation-timeline-id={!presentation.showStatus ? item.id : undefined}
      data-conversation-timeline-item-id={!presentation.showStatus ? item.id : undefined}
      data-conversation-timeline-revision={!presentation.showStatus ? item.revision : undefined}
      data-conversation-timeline-thread-sequence={!presentation.showStatus ? item.threadSequence : undefined}
      data-conversation-timeline-part-index={!presentation.showStatus ? item.partIndex : undefined}
      data-conversation-turn-id={!presentation.showStatus ? item.turnId : undefined}
      data-conversation-run-id={!presentation.showStatus ? item.runId : undefined}
      data-conversation-attempt-id={!presentation.showStatus ? item.attemptId : undefined}
      data-conversation-participant-id={!presentation.showStatus ? item.participantId : undefined}
      data-conversation-workflow-step-id={!presentation.showStatus ? item.workflowStepId : undefined}
      data-conversation-timeline-status={!presentation.showStatus ? item.status : undefined}
      data-conversation-timeline-depth={!presentation.showStatus ? depth : undefined}>
      {summary ? (
        <MessageBodyRenderer
          className="conversation-timeline-result-summary"
          text={summary}
          cwd={cwd}
          compact={false}
        />
      ) : null}
      {presentation.showStatus ? <TimelineFactRow
        item={item}
        depth={depth}
        title={presentation.statusLabel}
        compact
        defaultExpanded
        statusLabel=""
        meta=""
        icon={needsAttention ? <CircleAlert size={14} aria-hidden="true" /> : item.status === "succeeded" ? <CheckCircle2 size={14} aria-hidden="true" /> : <FileCheck2 size={14} aria-hidden="true" />}
        detail={hasDetail ? <TerminalReportResultSupplement presentation={presentation} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /> : undefined}
      /> : null}
    </div>
  );
}

function TerminalReportResultSupplement({
  presentation,
  cwd,
  onOpenSourceRef,
}: {
  readonly presentation: ReturnType<typeof terminalReportFinalPresentation>;
  readonly cwd?: string;
  readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler;
}): React.JSX.Element {
  const { item, corrections, verification, participants, artifacts, risks } = presentation;
  return (
    <div className="conversation-timeline-terminal-report" data-terminal-report-id={item.reportId} data-terminal-report-generation={item.generation}>
      <ReportSection title="Corrections" count={corrections.length}>
        {corrections.map((correction) => (
          <ReportEntry key={correction.id} item={item} title={correction.correctedFact} meta={terminalReportResultMeta(item, [correction.confidence])} summary={`Previously: ${correction.originalAssumption}`} refs={correction.sourceRefs} cwd={cwd} onOpenSourceRef={onOpenSourceRef} />
        ))}
      </ReportSection>
      <ReportSection title="Verification" count={verification.length}>
        {verification.map((check) => (
          <ReportEntry key={check.id} item={item} title={check.title} meta={terminalReportResultMeta(item, [check.status])} summary={check.summary} refs={check.sourceRefs} cwd={cwd} onOpenSourceRef={onOpenSourceRef} />
        ))}
      </ReportSection>
      <ReportSection title="Agents" count={participants.length}>
        {participants.map((participant) => (
          <ReportEntry key={participant.agentId} item={item} title={participant.displayName} meta={terminalReportResultMeta(item, [participant.roleKey, participant.status])} summary={participant.contribution} refs={participant.sourceRefs} cwd={cwd} onOpenSourceRef={onOpenSourceRef} />
        ))}
      </ReportSection>
      <ReportSection title="Artifacts" count={artifacts.length}>
        {artifacts.map((artifact) => <ArtifactEntry key={artifact.id} artifact={artifact} item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} />)}
      </ReportSection>
      <ReportSection title="Risks" count={risks.length}>
        {risks.map((risk) => (
          <ReportEntry key={risk.id} item={item} title={risk.summary} meta={terminalReportResultMeta(item, [risk.severity, risk.status, risk.approvalDecision])} summary={risk.nextAction} refs={risk.sourceRefs} icon={<ShieldAlert size={12} aria-hidden="true" />} cwd={cwd} onOpenSourceRef={onOpenSourceRef} />
        ))}
      </ReportSection>
    </div>
  );
}

function ReportSection({ title, count, children, actions }: { readonly title: string; readonly count: number; readonly children: React.ReactNode; readonly actions?: React.ReactNode }): React.JSX.Element | null {
  const { t } = useI18n();
  if (count === 0) return null;
  const label = title === "Verification" ? t("Checks") : title === "Agents" ? t("Participants") :
    title === "Artifacts" ? t("Artifacts") : title === "Risks" ? t("Risks") : title === "Sources" ? t("Sources") : title;
  return (
    <section className="conversation-timeline-terminal-section" data-terminal-report-section={title.toLowerCase()}>
      <div className="conversation-timeline-terminal-section-head">
        <h4>{label}<span>{count}</span></h4>
        {actions}
      </div>
      <div className="conversation-timeline-terminal-section-list">{children}</div>
    </section>
  );
}

function ReportEntry({
  title,
  meta,
  summary,
  refs,
  icon,
  item,
  cwd,
  onOpenSourceRef,
}: {
  readonly title: string;
  readonly meta?: string;
  readonly summary?: string;
  readonly refs: readonly ConversationOperationSourceRef[];
  readonly icon?: React.ReactNode;
  readonly item: ConversationTimelineTerminalReportItem;
  readonly cwd?: string;
  readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler;
}): React.JSX.Element {
  return (
    <article className="conversation-timeline-terminal-entry">
      <div className="conversation-timeline-terminal-entry-head">{icon}<strong>{title}</strong>{meta ? <small>{meta}</small> : null}</div>
      {summary ? <MessageBodyRenderer className="conversation-timeline-terminal-entry-summary" text={summary} cwd={cwd} compact /> : null}
      <ReportSourceRefs item={item} refs={refs} onOpenSourceRef={onOpenSourceRef} />
    </article>
  );
}

function ArtifactEntry({ artifact, item, cwd, onOpenSourceRef }: { readonly artifact: ConversationTimelineTerminalReportArtifact; readonly item: ConversationTimelineTerminalReportItem; readonly cwd?: string; readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler }): React.JSX.Element {
  const refs = terminalReportDisplaySourceRefs(artifact.sourceRefs, artifact.path ? [{
      kind: artifact.kind === "diff" ? "diff" : artifact.kind === "file" ? "file" : "artifact",
      id: artifact.id,
      path: artifact.path,
      label: artifact.title,
    }] : []);
  return (
    <ReportEntry
      title={artifact.title}
      meta={[artifact.kind, artifact.addedLines === undefined ? "" : `+${artifact.addedLines}`, artifact.deletedLines === undefined ? "" : `-${artifact.deletedLines}`].filter(Boolean).join(" · ")}
      summary={artifact.summary}
      refs={refs}
      item={item}
      cwd={cwd}
      onOpenSourceRef={onOpenSourceRef}
    />
  );
}

function ReportSourceRefs({ item, refs, onOpenSourceRef }: { readonly item: ConversationTimelineTerminalReportItem; readonly refs: readonly ConversationOperationSourceRef[]; readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler }): React.JSX.Element | null {
  const { t } = useI18n();
  const { resources, lineage } = terminalReportSourceRefGroups(refs);
  if (resources.length === 0 && lineage.length === 0) return null;
  return <>
    {resources.length > 0 ? <div className="conversation-timeline-ref-list">{resources.map((ref) => (
      <ConversationTimelineFileReference
        key={JSON.stringify([ref.kind, ref.id, ref.path ?? ""])}
        file={{ fileRef: ref, displayName: basename(ref.path ?? ref.label ?? ref.id), change: "edited" }}
        item={item}
        onOpenSourceRef={onOpenSourceRef}
      />
    ))}</div> : null}
    {lineage.length > 0 ? <details className="conversation-timeline-terminal-entry-sources">
      <summary>{t("Sources")} · {lineage.length}</summary>
      <div className="conversation-timeline-ref-list">{lineage.map((ref) => (
        <span className="conversation-timeline-terminal-lineage-ref" key={JSON.stringify([ref.kind, ref.id, ref.path ?? ""])} title={ref.path ?? ref.label ?? ref.id}>
          {ref.label ?? ref.path ?? ref.id}
        </span>
      ))}</div>
    </details> : null}
  </>;
}

function basename(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}
