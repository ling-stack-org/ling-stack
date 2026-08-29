import {
  Archive,
  CheckCircle2,
  CircleAlert,
  FilePenLine,
  FileText,
  Image as ImageIcon,
  ListChecks,
  PlugZap,
  Search,
  ShieldAlert,
  Terminal,
  UsersRound,
  Wrench,
} from "lucide-react";
import type {
  ConversationOperationSourceRef,
  ConversationTimelineRowItem,
} from "@ling-stack/conversation-ui-core";
import type { ArtifactPreviewLoader } from "../preview/ArtifactPreviewDrawer.js";
import { useI18n } from "../../../i18n.js";
import { MessageBodyRenderer } from "../blocks/MessageBodyRenderer.js";
import { useConversationBlockView } from "../view-store/use-conversation-block-view.js";
import {
  ConversationTimelineFileChangeDetail,
  ConversationTimelineFileReference,
} from "./ConversationTimelineFileChangeDetail.js";

export interface ConversationTimelineActivityRendererProps {
  readonly item: ConversationTimelineRowItem;
  readonly cwd?: string;
  readonly loadPreview?: ArtifactPreviewLoader;
  readonly onOpenSourceRef?: (ref: ConversationOperationSourceRef) => void;
  readonly depth?: 0 | 1;
}

/**
 * Renders a projected activity fact. The component owns only disclosure and
 * presentation; it never fetches execution state or infers completion from prose.
 */
export function ConversationTimelineActivityRenderer({
  item,
  cwd,
  loadPreview,
  onOpenSourceRef,
  depth = 0,
}: ConversationTimelineActivityRendererProps): React.JSX.Element {
  const { t } = useI18n();
  const hasDetail = activityHasDetail(item);
  const disclosure = useConversationBlockView({
    blockId: `timeline-item:${item.id}`,
    revisionKey: String(item.revision),
    defaultExpanded: item.status === "running" || item.status === "waiting" ||
      item.status === "blocked" || item.status === "failed",
    preserveTouchedStateOnRevision: true,
  });
  const expanded = hasDetail && disclosure.expanded;
  const title = activityTitle(item);
  const status = activityStatusLabel(item.status, t);

  return (
    <div
      className={["conversation-timeline-activity", `kind-${item.kind}`, item.status ? `status-${item.status}` : "", expanded ? "expanded" : ""].filter(Boolean).join(" ")}
      data-conversation-timeline-activity
      data-conversation-timeline-kind={item.kind}
      data-conversation-timeline-id={item.id}
      data-conversation-timeline-item-id={item.id}
      data-conversation-timeline-revision={item.revision}
      data-conversation-timeline-status={item.status ?? "unknown"}
      data-conversation-timeline-depth={depth}
      data-conversation-action-id={item.actionId}
      data-conversation-run-id={item.runId}
      data-conversation-attempt-id={item.attemptId}
      data-conversation-work-unit-id={item.workUnitId}
      data-conversation-workflow-step-id={item.workflowStepId}
      data-conversation-participant-id={item.participantId}
      data-conversation-source-refs={serializeSourceRefs(item.sourceRefs)}
    >
      {hasDetail ? (
        <button
          className="conversation-timeline-activity-main"
          type="button"
          aria-expanded={expanded}
          aria-label={`${title}${status ? ` · ${status}` : ""}. ${expanded ? t("Collapse details") : t("Expand details")}`}
          onClick={disclosure.toggleExpanded}
        >
          <ActivityIcon item={item} />
          <span className="conversation-timeline-activity-copy">
            <strong>{title}</strong>
            {item.meta ? <small>{item.meta}</small> : null}
          </span>
          {status ? <span className="conversation-timeline-activity-status">{status}</span> : null}
          <span className="conversation-timeline-activity-chevron" aria-hidden="true">⌄</span>
        </button>
      ) : (
        <div className="conversation-timeline-activity-main static">
          <ActivityIcon item={item} />
          <span className="conversation-timeline-activity-copy">
            <strong>{title}</strong>
            {item.meta ? <small>{item.meta}</small> : null}
          </span>
          {status ? <span className="conversation-timeline-activity-status">{status}</span> : null}
        </div>
      )}
      {expanded ? (
        <div className="conversation-timeline-activity-detail">
          <ActivityDetail item={item} cwd={cwd} loadPreview={loadPreview} onOpenSourceRef={onOpenSourceRef} />
        </div>
      ) : null}
    </div>
  );
}

function serializeSourceRefs(refs: readonly ConversationOperationSourceRef[]): string {
  return refs.map((ref) => `${ref.kind}:${ref.id}`).join(",");
}

function ActivityIcon({ item }: { readonly item: ConversationTimelineRowItem }): React.JSX.Element {
  if (item.status === "failed" || item.status === "blocked") return <CircleAlert size={14} aria-hidden="true" />;
  if (item.status === "succeeded") return <CheckCircle2 size={14} aria-hidden="true" />;
  switch (item.kind) {
    case "plan": return <ListChecks size={14} aria-hidden="true" />;
    case "commandExecution": return <Terminal size={14} aria-hidden="true" />;
    case "fileChange": return <FilePenLine size={14} aria-hidden="true" />;
    case "exploration": return <Search size={14} aria-hidden="true" />;
    case "mcpToolCall": return <PlugZap size={14} aria-hidden="true" />;
    case "dynamicToolCall": return <Wrench size={14} aria-hidden="true" />;
    case "collabAgentToolCall": return <UsersRound size={14} aria-hidden="true" />;
    case "approval": return <ShieldAlert size={14} aria-hidden="true" />;
    case "imageView": return <ImageIcon size={14} aria-hidden="true" />;
    case "contextCompaction": return <Archive size={14} aria-hidden="true" />;
    case "reasoningSummary": return <span className="conversation-timeline-activity-brain" aria-hidden="true">✦</span>;
    case "genericActivity": return <FileText size={14} aria-hidden="true" />;
  }
}

function ActivityDetail({
  item,
  cwd,
  loadPreview,
  onOpenSourceRef,
}: {
  readonly item: ConversationTimelineRowItem;
  readonly cwd?: string;
  readonly loadPreview?: ArtifactPreviewLoader;
  readonly onOpenSourceRef?: (ref: ConversationOperationSourceRef) => void;
}): React.JSX.Element {
  if (item.kind === "commandExecution") {
    return (
      <>
        <code className="conversation-timeline-command">$ {item.command}</code>
        {item.cwd ? <small className="conversation-timeline-detail-meta">cwd: {item.cwd}</small> : null}
        {item.outputTail.length > 0 ? <pre className="conversation-timeline-output">{item.outputTail.map((chunk) => chunk.text).join("")}</pre> : null}
        {item.outputTruncated ? <small className="conversation-timeline-detail-meta">Output truncated; open the full log from evidence.</small> : null}
        <CommandResult item={item} />
      </>
    );
  }
  if (item.kind === "fileChange") {
    return <><ConversationTimelineFileChangeDetail item={item} cwd={cwd} loadPreview={loadPreview} onOpenSourceRef={onOpenSourceRef} /><ActivityDetailLines item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /></>;
  }
  if (item.kind === "exploration") {
    return (
      <>
        {item.resultSummary ? <MessageBodyRenderer className="conversation-timeline-rich-detail" text={item.resultSummary} cwd={cwd} compact /> : null}
        <div className="conversation-timeline-ref-list">
          {item.targets.map((ref) => <ConversationTimelineFileReference key={`${ref.kind}:${ref.id}`} file={{ fileRef: ref, displayName: basename(ref.path ?? ref.label ?? ref.id), change: "edited" }} onOpenSourceRef={onOpenSourceRef} />)}
        </div>
        <ActivityDetailLines item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} />
      </>
    );
  }
  if (item.kind === "plan") {
    return <><ol className="conversation-timeline-plan-steps">{item.steps.map((step) => <li key={step.id} data-step-status={step.status}>{step.text}</li>)}</ol><ActivityDetailLines item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /></>;
  }
  if (item.kind === "approval") {
    return <><DetailText text={[item.description, item.decision ? `Decision: ${item.decision}` : undefined].filter(Boolean).join("\n")} cwd={cwd} /><ActivityDetailLines item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /></>;
  }
  if (item.kind === "mcpToolCall" || item.kind === "dynamicToolCall" || item.kind === "collabAgentToolCall") {
    return <><DetailText text={[item.inputSummary, item.resultSummary].filter(Boolean).join("\n")} cwd={cwd} /><ActivityDetailLines item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /></>;
  }
  if (item.kind === "imageView") return <DetailText text={item.description ?? item.alt} cwd={cwd} />;
  if (item.kind === "reasoningSummary" || item.kind === "contextCompaction") return <DetailText text={item.summary} cwd={cwd} />;
  return <><DetailText text={item.description} cwd={cwd} /><ActivityDetailLines item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /></>;
}

function ActivityDetailLines({
  item,
  cwd,
  onOpenSourceRef,
}: {
  readonly item: ConversationTimelineRowItem;
  readonly cwd?: string;
  readonly onOpenSourceRef?: (ref: ConversationOperationSourceRef) => void;
}): React.JSX.Element | null {
  const lines = item.detailLines ?? [];
  if (lines.length === 0) return null;
  return (
    <div className="conversation-timeline-detail-lines">
      {lines.map((line, index) => {
        if (line.kind === "code") return <code className="conversation-timeline-detail-code" key={`${index}:${line.text}`}>{line.text}</code>;
        if (line.kind === "file_ref") {
          const trustedRef = item.sourceRefs.find((ref) => (ref.kind === "file" || ref.kind === "path") && ref.path === line.path);
          return trustedRef ? <ConversationTimelineFileReference key={`${index}:${line.path}`} file={{ fileRef: trustedRef, displayName: basename(line.path), change: "edited" }} onOpenSourceRef={onOpenSourceRef} /> : <span className="conversation-timeline-file-ref" title={line.path} key={`${index}:${line.path}`}>{basename(line.path)}</span>;
        }
        return <MessageBodyRenderer key={`${index}:${line.text}`} className="conversation-timeline-rich-detail" text={line.text} cwd={cwd} compact />;
      })}
    </div>
  );
}

function CommandResult({ item }: { readonly item: Extract<ConversationTimelineRowItem, { kind: "commandExecution" }> }): React.JSX.Element | null {
  const parts = [item.exitCode === undefined ? undefined : `exit ${item.exitCode}`, item.durationMs === undefined ? undefined : formatDuration(item.durationMs), item.signal ? `signal ${item.signal}` : undefined].filter(Boolean);
  return parts.length > 0 ? <small className="conversation-timeline-detail-meta">{parts.join(" · ")}</small> : null;
}

function DetailText({ text, cwd }: { readonly text: string | undefined; readonly cwd?: string }): React.JSX.Element {
  return text?.trim() ? <MessageBodyRenderer className="conversation-timeline-rich-detail" text={text} cwd={cwd} compact /> : <span className="conversation-timeline-detail-empty">No additional detail.</span>;
}

function activityHasDetail(item: ConversationTimelineRowItem): boolean {
  if (item.kind === "commandExecution") return Boolean(item.command || item.outputTail.length > 0 || item.cwd || item.exitCode !== undefined || item.durationMs !== undefined);
  if (item.kind === "fileChange") return item.files.length > 0 || Boolean(item.changePreview);
  if (item.kind === "exploration") return item.targets.length > 0 || Boolean(item.description || item.resultSummary);
  if (item.kind === "plan") return item.steps.length > 0;
  if (item.kind === "imageView") return Boolean(item.description || item.artifactRef);
  if (item.kind === "reasoningSummary" || item.kind === "contextCompaction") return Boolean(item.summary);
  if (item.kind === "mcpToolCall" || item.kind === "dynamicToolCall" || item.kind === "collabAgentToolCall") return Boolean(item.description || item.detailLines?.length || item.inputSummary || item.resultSummary);
  if (item.kind === "approval") return Boolean(item.description || item.detailLines?.length || item.decision);
  return Boolean(item.description || item.detailLines?.length);
}

function activityTitle(item: ConversationTimelineRowItem): string {
  if (item.kind === "commandExecution") return item.command.trim() ? truncateInline(item.command) : item.title;
  return item.title;
}

function activityStatusLabel(status: ConversationTimelineRowItem["status"], t: (key: string, vars?: Record<string, string | number>) => string): string | undefined {
  if (!status) return undefined;
  const labels: Record<NonNullable<ConversationTimelineRowItem["status"]>, string> = {
    pending: t("Pending"), running: t("Running"), waiting: t("Waiting"), blocked: t("Blocked"), failed: t("Failed"), cancelled: t("Cancelled"), succeeded: t("Done"),
  };
  return labels[status];
}

function basename(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function truncateInline(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized;
}

function formatDuration(value: number): string {
  if (value < 1000) return `${Math.max(1, Math.round(value))}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}
