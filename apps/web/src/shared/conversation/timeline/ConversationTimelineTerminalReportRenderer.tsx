import { CheckCircle2, CircleAlert, FileCheck2, ShieldAlert } from "lucide-react";
import type {
  ConversationOperationSourceRef,
  ConversationTimelineTerminalReportArtifact,
  ConversationTimelineTerminalReportItem,
} from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { MessageBodyRenderer } from "../blocks/MessageBodyRenderer.js";
import { ConversationTimelineFileReference } from "./ConversationTimelineFileChangeDetail.js";

export function ConversationTimelineTerminalReportRenderer({
  item,
  depth,
  cwd,
}: {
  readonly item: ConversationTimelineTerminalReportItem;
  readonly depth: 0 | 1;
  readonly cwd?: string;
}): React.JSX.Element {
  const counts = [
    item.changeCount ? `${item.changeCount} changes` : "",
    item.verificationCount ? `${item.verificationCount} checks` : "",
    item.participantCount ? `${item.participantCount} agents` : "",
    item.artifactCount ? `${item.artifactCount} artifacts` : "",
    item.riskCount ? `${item.riskCount} risks` : "",
  ].filter(Boolean).join(" · ");
  return (
    <TimelineFactRow
      item={item}
      depth={depth}
      title={item.title}
      meta={`generation ${item.generation}${counts ? ` · ${counts}` : ""}`}
      icon={item.status === "succeeded" ? <CheckCircle2 size={14} aria-hidden="true" /> : item.status === "failed" || item.status === "blocked" ? <CircleAlert size={14} aria-hidden="true" /> : <FileCheck2 size={14} aria-hidden="true" />}
      detail={<TerminalReportDetail item={item} cwd={cwd} />}
    />
  );
}

function TerminalReportDetail({ item, cwd }: { readonly item: ConversationTimelineTerminalReportItem; readonly cwd?: string }): React.JSX.Element {
  const visibleParticipants = item.participants.length > 1 || item.participants.some((participant) => participant.status !== "completed")
    ? item.participants
    : [];
  return (
    <div className="conversation-timeline-terminal-report" data-terminal-report-id={item.reportId} data-terminal-report-generation={item.generation}>
      <MessageBodyRenderer className="conversation-timeline-rich-detail" text={item.summary} cwd={cwd} compact />
      <ReportSection title="Corrections" count={item.corrections.length}>
        {item.corrections.map((correction) => (
          <ReportEntry key={correction.id} title={correction.correctedFact} meta={correction.confidence} summary={`Previously: ${correction.originalAssumption}`} refs={correction.sourceRefs} />
        ))}
      </ReportSection>
      <ReportSection title="Changes" count={item.changes.length}>
        {item.changes.map((change) => (
          <ReportEntry
            key={change.id}
            title={change.title}
            meta={[change.kind, change.addedLines === undefined ? "" : `+${change.addedLines}`, change.deletedLines === undefined ? "" : `-${change.deletedLines}`].filter(Boolean).join(" · ")}
            summary={change.summary}
            refs={[
              ...change.paths.map((path) => ({ kind: "file", id: `report-path:${change.id}:${path}`, path, label: path })),
              ...change.sourceRefs,
            ]}
          />
        ))}
      </ReportSection>
      <ReportSection title="Verification" count={item.verification.length}>
        {item.verification.map((verification) => (
          <ReportEntry key={verification.id} title={verification.title} meta={formatVerificationMeta(verification)} summary={verification.summary} command={verification.command} refs={verification.sourceRefs} />
        ))}
      </ReportSection>
      <ReportSection title="Agents" count={visibleParticipants.length}>
        {visibleParticipants.map((participant) => (
          <ReportEntry key={participant.agentId} title={participant.displayName} meta={[participant.roleKey, participant.status].filter(Boolean).join(" · ")} summary={participant.contribution} refs={participant.sourceRefs} />
        ))}
      </ReportSection>
      <ReportSection title="Artifacts" count={item.artifacts.length}>
        {item.artifacts.map((artifact) => <ArtifactEntry key={artifact.id} artifact={artifact} />)}
      </ReportSection>
      <ReportSection title="Risks" count={item.risks.length}>
        {item.risks.map((risk) => (
          <ReportEntry key={risk.id} title={risk.summary} meta={[risk.severity, risk.status, risk.approvalDecision].filter(Boolean).join(" · ")} summary={risk.nextAction} refs={risk.sourceRefs} icon={<ShieldAlert size={12} aria-hidden="true" />} />
        ))}
      </ReportSection>
      <ReportSection title="Sources" count={item.references.length}>
        <ReportSourceRefs refs={item.references} />
      </ReportSection>
    </div>
  );
}

function ReportSection({ title, count, children }: { readonly title: string; readonly count: number; readonly children: React.ReactNode }): React.JSX.Element | null {
  if (count === 0) return null;
  return (
    <section className="conversation-timeline-terminal-section" data-terminal-report-section={title.toLowerCase()}>
      <h4>{title}<span>{count}</span></h4>
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
}: {
  readonly title: string;
  readonly meta?: string;
  readonly summary?: string;
  readonly command?: string;
  readonly refs: readonly ConversationOperationSourceRef[];
  readonly icon?: React.ReactNode;
}): React.JSX.Element {
  return (
    <article className="conversation-timeline-terminal-entry">
      <div className="conversation-timeline-terminal-entry-head">{icon}<strong>{title}</strong>{meta ? <small>{meta}</small> : null}</div>
      {summary ? <p>{summary}</p> : null}
      {command ? <code className="conversation-timeline-detail-code">$ {command}</code> : null}
      <ReportSourceRefs refs={refs} />
    </article>
  );
}

function ArtifactEntry({ artifact }: { readonly artifact: ConversationTimelineTerminalReportArtifact }): React.JSX.Element {
  const refs: ConversationOperationSourceRef[] = [
    ...(artifact.path ? [{
      kind: artifact.kind === "diff" ? "diff" : artifact.kind === "file" ? "file" : "artifact",
      id: artifact.id,
      path: artifact.path,
      label: artifact.title,
    }] : []),
    ...artifact.sourceRefs,
  ];
  return (
    <ReportEntry
      title={artifact.title}
      meta={[artifact.kind, artifact.addedLines === undefined ? "" : `+${artifact.addedLines}`, artifact.deletedLines === undefined ? "" : `-${artifact.deletedLines}`].filter(Boolean).join(" · ")}
      summary={artifact.summary}
      refs={refs}
    />
  );
}

function ReportSourceRefs({ refs }: { readonly refs: readonly ConversationOperationSourceRef[] }): React.JSX.Element | null {
  const visible = uniqueSourceRefs(refs).filter((ref) => Boolean(ref.path || ref.label));
  if (visible.length === 0) return null;
  return <div className="conversation-timeline-ref-list">{visible.map((ref) => (
    <ConversationTimelineFileReference
      key={`${ref.kind}:${ref.id}:${ref.path ?? ""}`}
      file={{ fileRef: ref, displayName: basename(ref.path ?? ref.label ?? ref.id), change: "edited" }}
    />
  ))}</div>;
}

function uniqueSourceRefs(refs: readonly ConversationOperationSourceRef[]): readonly ConversationOperationSourceRef[] {
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.id}:${ref.path ?? ""}`, ref])).values()];
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
