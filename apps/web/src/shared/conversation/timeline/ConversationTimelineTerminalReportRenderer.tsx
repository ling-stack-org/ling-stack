import { CheckCircle2, CircleAlert, FileCheck2, ShieldAlert } from "lucide-react";
import { isUserVisibleTerminalReportArtifact, visibleTerminalReportTimelineItem } from "@ling-stack/conversation-ui-core";
import type {
  ConversationOperationSourceRef,
  ConversationTimelineTerminalReportArtifact,
  ConversationTimelineTerminalReportItem,
} from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { ConversationWorkspaceRecoveryControls } from "../blocks/ConversationWorkspaceRecoveryControls.js";
import { ConversationTimelineFileReference } from "./ConversationTimelineFileChangeDetail.js";
import type { ConversationTimelineSourceRefHandler } from "./source-ref.js";
import { terminalReportDisplaySourceRefs } from "./terminal-report-display-refs.js";
import "./conversation-terminal-response.css";

export function ConversationTimelineTerminalReportRenderer({
  item: inputItem,
  depth,
  cwd,
  onOpenSourceRef,
}: {
  readonly item: ConversationTimelineTerminalReportItem;
  readonly depth: 0 | 1;
  readonly cwd?: string;
  readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler;
}): React.JSX.Element {
  const item = visibleTerminalReportTimelineItem(inputItem);
  const artifactCount = item.artifacts.filter(isUserVisibleTerminalReportArtifact).length;
  const counts = [
    item.changeCount ? `${item.changeCount} changes` : "",
    item.verificationCount ? `${item.verificationCount} checks` : "",
    item.participantCount ? `${item.participantCount} agents` : "",
    artifactCount ? `${artifactCount} artifacts` : "",
    item.riskCount ? `${item.riskCount} risks` : "",
  ].filter(Boolean).join(" · ");
  return (
    <div className="conversation-timeline-terminal-response" data-conversation-terminal-response={item.reportId} data-conversation-action-owner>
      <TimelineFactRow
        item={item}
        depth={depth}
        title={item.title}
        meta={`generation ${item.generation}${counts ? ` · ${counts}` : ""}`}
        icon={item.status === "succeeded" ? <CheckCircle2 size={14} aria-hidden="true" /> : item.status === "failed" || item.status === "blocked" ? <CircleAlert size={14} aria-hidden="true" /> : <FileCheck2 size={14} aria-hidden="true" />}
        detail={<TerminalReportDetail item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} />}
      />
    </div>
  );
}

function TerminalReportDetail({
  item,
  cwd,
  onOpenSourceRef,
}: {
  readonly item: ConversationTimelineTerminalReportItem;
  readonly cwd?: string;
  readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler;
}): React.JSX.Element {
  const visibleArtifacts = item.artifacts.filter(isUserVisibleTerminalReportArtifact);
  const visibleParticipants = item.participants.length > 1 || item.participants.some((participant) => participant.status !== "completed")
    ? item.participants
    : [];
  const recoveryTarget = item.turnId
    ? { kind: "turn" as const, id: item.turnId }
    : item.runId ? { kind: "run" as const, id: item.runId } : undefined;
  return (
    <div className="conversation-timeline-terminal-report" data-terminal-report-id={item.reportId} data-terminal-report-generation={item.generation}>
      <ReportSection title="Corrections" count={item.corrections.length}>
        {item.corrections.map((correction) => (
          <ReportEntry key={correction.id} item={item} title={correction.correctedFact} meta={correction.confidence} summary={`Previously: ${correction.originalAssumption}`} refs={correction.sourceRefs} onOpenSourceRef={onOpenSourceRef} />
        ))}
      </ReportSection>
      <ReportSection
        title="Changes"
        count={item.changes.length}
        actions={recoveryTarget ? (
          <ConversationWorkspaceRecoveryControls
            className="conversation-timeline-terminal-recovery"
            cwd={cwd}
            fileCountFallback={terminalReportFileCount(item)}
            target={recoveryTarget}
          />
        ) : undefined}
      >
        {item.changes.map((change) => (
          <ReportEntry
            key={change.id}
            item={item}
            title={change.title}
            meta={[change.kind, change.addedLines === undefined ? "" : `+${change.addedLines}`, change.deletedLines === undefined ? "" : `-${change.deletedLines}`].filter(Boolean).join(" · ")}
            summary={change.summary}
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
          <ReportEntry key={verification.id} item={item} title={verification.title} meta={formatVerificationMeta(verification)} summary={verification.summary} command={verification.command} refs={verification.sourceRefs} onOpenSourceRef={onOpenSourceRef} />
        ))}
      </ReportSection>
      <ReportSection title="Agents" count={visibleParticipants.length}>
        {visibleParticipants.map((participant) => (
          <ReportEntry key={participant.agentId} item={item} title={participant.displayName} meta={[participant.roleKey, participant.status].filter(Boolean).join(" · ")} summary={participant.contribution} refs={participant.sourceRefs} onOpenSourceRef={onOpenSourceRef} />
        ))}
      </ReportSection>
      <ReportSection title="Artifacts" count={visibleArtifacts.length}>
        {visibleArtifacts.map((artifact) => <ArtifactEntry key={artifact.id} artifact={artifact} item={item} onOpenSourceRef={onOpenSourceRef} />)}
      </ReportSection>
      <ReportSection title="Risks" count={item.risks.length}>
        {item.risks.map((risk) => (
          <ReportEntry key={risk.id} item={item} title={risk.summary} meta={[risk.severity, risk.status, risk.approvalDecision].filter(Boolean).join(" · ")} summary={risk.nextAction} refs={risk.sourceRefs} icon={<ShieldAlert size={12} aria-hidden="true" />} onOpenSourceRef={onOpenSourceRef} />
        ))}
      </ReportSection>
      <ReportSection title="Sources" count={item.references.length}>
        <ReportSourceRefs item={item} refs={item.references} onOpenSourceRef={onOpenSourceRef} />
      </ReportSection>
    </div>
  );
}

function ReportSection({ title, count, children, actions }: { readonly title: string; readonly count: number; readonly children: React.ReactNode; readonly actions?: React.ReactNode }): React.JSX.Element | null {
  if (count === 0) return null;
  return (
    <section className="conversation-timeline-terminal-section" data-terminal-report-section={title.toLowerCase()}>
      <div className="conversation-timeline-terminal-section-head">
        <h4>{title}<span>{count}</span></h4>
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
  onOpenSourceRef,
}: {
  readonly title: string;
  readonly meta?: string;
  readonly summary?: string;
  readonly command?: string;
  readonly refs: readonly ConversationOperationSourceRef[];
  readonly icon?: React.ReactNode;
  readonly item: ConversationTimelineTerminalReportItem;
  readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler;
}): React.JSX.Element {
  return (
    <article className="conversation-timeline-terminal-entry">
      <div className="conversation-timeline-terminal-entry-head">{icon}<strong>{title}</strong>{meta ? <small>{meta}</small> : null}</div>
      {summary ? <p>{summary}</p> : null}
      {command ? <code className="conversation-timeline-detail-code">$ {command}</code> : null}
      <ReportSourceRefs item={item} refs={refs} onOpenSourceRef={onOpenSourceRef} />
    </article>
  );
}

function ArtifactEntry({ artifact, item, onOpenSourceRef }: { readonly artifact: ConversationTimelineTerminalReportArtifact; readonly item: ConversationTimelineTerminalReportItem; readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler }): React.JSX.Element {
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
      onOpenSourceRef={onOpenSourceRef}
    />
  );
}

function ReportSourceRefs({ item, refs, onOpenSourceRef }: { readonly item: ConversationTimelineTerminalReportItem; readonly refs: readonly ConversationOperationSourceRef[]; readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler }): React.JSX.Element | null {
  const visible = uniqueSourceRefs(refs).filter((ref) => Boolean(ref.path || ref.label));
  if (visible.length === 0) return null;
  return <div className="conversation-timeline-ref-list">{visible.map((ref) => (
    <ConversationTimelineFileReference
      key={`${ref.kind}:${ref.id}:${ref.path ?? ""}`}
      file={{ fileRef: ref, displayName: basename(ref.path ?? ref.label ?? ref.id), change: "edited" }}
      item={item}
      onOpenSourceRef={onOpenSourceRef}
    />
  ))}</div>;
}

function terminalReportFileCount(item: ConversationTimelineTerminalReportItem): number {
  const paths = new Set([
    ...item.changes.flatMap((change) => change.paths),
    ...item.artifacts.flatMap((artifact) => artifact.path ? [artifact.path] : []),
  ]);
  return paths.size || item.changeCount;
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
