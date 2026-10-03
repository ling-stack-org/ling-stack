import { CheckCircle2, CircleAlert, FileCheck2, ShieldAlert } from "lucide-react";
import { isUserVisibleTerminalReportArtifact, visibleTerminalReportTimelineItem } from "@ling-stack/conversation-ui-core";
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
import { terminalReportDisplayPolicy } from "./terminal-report-display-policy.js";
import { terminalReportFallbackSummary } from "./terminal-report-fallback-summary.js";
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
  const { t } = useI18n();
  const item = visibleTerminalReportTimelineItem(inputItem);
  const policy = terminalReportDisplayPolicy(item, hasNarration);
  if (!policy.visible) return null;
  const fallbackSummary = hasNarration ? "" : terminalReportFallbackSummary(item);
  const artifactCount = item.artifacts.filter(isUserVisibleTerminalReportArtifact).length;
  const visibleParticipantCount = item.participants.length > 1 || item.participants.some((participant) => participant.status !== "completed")
    ? item.participants.length
    : 0;
  const hasDetail = item.corrections.length > 0 || item.changes.length > 0 || item.verification.length > 0 ||
    visibleParticipantCount > 0 || artifactCount > 0 || item.risks.length > 0 ||
    item.references.some((ref) => Boolean(ref.path || ref.label));
  const compactStatusOnly = !hasDetail && !item.summary.trim();
  return (
    <div className="conversation-timeline-terminal-response" data-conversation-terminal-response={item.reportId}>
      {fallbackSummary ? (
        <MessageBodyRenderer
          className="conversation-timeline-result-summary"
          text={fallbackSummary}
          cwd={cwd}
          compact={false}
        />
      ) : null}
      <TimelineFactRow
        item={item}
        depth={depth}
        title={t("Execution details")}
        compact={compactStatusOnly}
        defaultExpanded={policy.needsAttention}
        statusLabel={policy.needsAttention && item.status === "succeeded" ? t("Needs attention") : undefined}
        meta=""
        icon={policy.needsAttention ? <CircleAlert size={14} aria-hidden="true" /> : item.status === "succeeded" ? <CheckCircle2 size={14} aria-hidden="true" /> : <FileCheck2 size={14} aria-hidden="true" />}
        detail={hasDetail || hasNarration && Boolean(item.summary) ? <TerminalReportDetail item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} showSummary={hasNarration} /> : undefined}
      />
    </div>
  );
}

function TerminalReportDetail({
  item,
  cwd,
  onOpenSourceRef,
  showSummary = false,
}: {
  readonly item: ConversationTimelineTerminalReportItem;
  readonly cwd?: string;
  readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler;
  readonly showSummary?: boolean;
}): React.JSX.Element {
  const visibleArtifacts = item.artifacts.filter(isUserVisibleTerminalReportArtifact);
  const visibleParticipants = item.participants.length > 1 || item.participants.some((participant) => participant.status !== "completed")
    ? item.participants
    : [];
  const sourceGroups = terminalReportSourceRefGroups(item.references);
  const visibleSourceCount = sourceGroups.resources.length + sourceGroups.lineage.length;
  return (
    <div className="conversation-timeline-terminal-report" data-terminal-report-id={item.reportId} data-terminal-report-generation={item.generation}>
      {showSummary && item.summary ? <MessageBodyRenderer text={item.summary} cwd={cwd} compact={false} /> : null}
      <ReportSection title="Corrections" count={item.corrections.length}>
        {item.corrections.map((correction) => (
          <ReportEntry key={correction.id} item={item} title={correction.correctedFact} meta={correction.confidence} summary={`Previously: ${correction.originalAssumption}`} refs={correction.sourceRefs} cwd={cwd} onOpenSourceRef={onOpenSourceRef} />
        ))}
      </ReportSection>
      <ReportSection
        title="Changes"
        count={item.changes.length}
      >
        {item.changes.map((change) => (
          <ReportEntry
            key={change.id}
            item={item}
            title={change.title}
            meta={[change.kind, change.addedLines === undefined ? "" : `+${change.addedLines}`, change.deletedLines === undefined ? "" : `-${change.deletedLines}`].filter(Boolean).join(" · ")}
            summary={change.summary}
            cwd={cwd}
            refs={terminalReportDisplaySourceRefs(
              change.sourceRefs,
              change.paths.map((path) => ({ kind: "file", id: `report-path:${change.id}:${path}`, path, label: path })),
              item.artifacts.map((artifact) => ({
                kind: artifact.kind === "diff" ? "diff" : artifact.kind === "file" ? "file" : "artifact",
                id: artifact.id,
                path: artifact.path,
                label: artifact.title,
              })),
            )}
            onOpenSourceRef={onOpenSourceRef}
          />
        ))}
      </ReportSection>
      <ReportSection title="Verification" count={item.verification.length}>
        {item.verification.map((verification) => (
          <ReportEntry key={verification.id} item={item} title={verification.title} meta={formatVerificationMeta(verification)} summary={verification.summary} command={verification.command} refs={verification.sourceRefs} cwd={cwd} onOpenSourceRef={onOpenSourceRef} />
        ))}
      </ReportSection>
      <ReportSection title="Agents" count={visibleParticipants.length}>
        {visibleParticipants.map((participant) => (
          <ReportEntry key={participant.agentId} item={item} title={participant.displayName} meta={[participant.roleKey, participant.status].filter(Boolean).join(" · ")} summary={participant.contribution} refs={participant.sourceRefs} cwd={cwd} onOpenSourceRef={onOpenSourceRef} />
        ))}
      </ReportSection>
      <ReportSection title="Artifacts" count={visibleArtifacts.length}>
        {visibleArtifacts.map((artifact) => <ArtifactEntry key={artifact.id} artifact={artifact} item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} />)}
      </ReportSection>
      <ReportSection title="Risks" count={item.risks.length}>
        {item.risks.map((risk) => (
          <ReportEntry key={risk.id} item={item} title={risk.summary} meta={[risk.severity, risk.status, risk.approvalDecision].filter(Boolean).join(" · ")} summary={risk.nextAction} refs={risk.sourceRefs} icon={<ShieldAlert size={12} aria-hidden="true" />} cwd={cwd} onOpenSourceRef={onOpenSourceRef} />
        ))}
      </ReportSection>
      <ReportSection title="Sources" count={visibleSourceCount}>
        <ReportSourceRefs item={item} refs={item.references} onOpenSourceRef={onOpenSourceRef} />
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
  command,
  refs,
  icon,
  item,
  cwd,
  onOpenSourceRef,
}: {
  readonly title: string;
  readonly meta?: string;
  readonly summary?: string;
  readonly command?: string;
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
      {command ? <code className="conversation-timeline-detail-code">$ {command}</code> : null}
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

function formatVerificationMeta(verification: ConversationTimelineTerminalReportItem["verification"][number]): string {
  const duration = verification.durationMs === undefined
    ? ""
    : verification.durationMs < 1_000 ? `${verification.durationMs}ms` : `${(verification.durationMs / 1_000).toFixed(1)}s`;
  return [verification.status, duration].filter(Boolean).join(" · ");
}
