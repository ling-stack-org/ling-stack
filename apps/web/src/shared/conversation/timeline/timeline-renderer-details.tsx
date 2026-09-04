import type { ReactNode } from "react";
import type { ConversationTimelineRowItem } from "@ling-stack/conversation-ui-core";
import { useI18n } from "../../../i18n.js";
import { MessageBodyRenderer } from "../blocks/MessageBodyRenderer.js";
import {
  ConversationTimelineFileChangeDetail,
  ConversationTimelineFileReference,
} from "./ConversationTimelineFileChangeDetail.js";
import { operationFileSourceRefForPath } from "./source-ref.js";
import type { ConversationTimelineSourceRefHandler } from "./source-ref.js";

export function CommandDetail({ item }: { readonly item: Extract<ConversationTimelineRowItem, { kind: "commandExecution" }> }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <>
      <code className="conversation-timeline-command">$ {item.command}</code>
      {item.cwd ? <small className="conversation-timeline-detail-meta">cwd: {item.cwd}</small> : null}
      {item.outputTail.length > 0 ? <pre className="conversation-timeline-output">{item.outputTail.map((chunk) => chunk.text).join("")}</pre> : null}
      {commandOutputMeta(item, t) ? <small className="conversation-timeline-detail-meta" data-conversation-command-output-stats>{commandOutputMeta(item, t)}</small> : null}
      {item.outputTruncated ? <small className="conversation-timeline-detail-meta">Output truncated; open the full log from evidence.</small> : null}
      <CommandResult item={item} />
    </>
  );
}

export function FileChangeDetail({
  item,
  onOpenSourceRef,
}: {
  readonly item: Extract<ConversationTimelineRowItem, { kind: "fileChange" }>;
  readonly cwd?: string;
  readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler;
}): React.JSX.Element {
  return <ConversationTimelineFileChangeDetail item={item} onOpenSourceRef={onOpenSourceRef} />;
}

export function ExplorationDetail({
  item,
  cwd,
  onOpenSourceRef,
}: {
  readonly item: Extract<ConversationTimelineRowItem, { kind: "exploration" }>;
  readonly cwd?: string;
  readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler;
}): React.JSX.Element {
  return (
    <>
      {item.resultSummary ? <MessageBodyRenderer className="conversation-timeline-rich-detail" text={item.resultSummary} cwd={cwd} compact /> : null}
      <div className="conversation-timeline-ref-list">
        {item.targets.map((ref) => <ConversationTimelineFileReference key={`${ref.kind}:${ref.id}`} file={{ fileRef: ref, displayName: basename(ref.path ?? ref.label ?? ref.id), change: "edited" }} onOpenSourceRef={onOpenSourceRef} item={item} />)}
      </div>
      <DetailLines item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} />
    </>
  );
}

export function PlanDetail({ item, cwd, onOpenSourceRef }: { readonly item: Extract<ConversationTimelineRowItem, { kind: "plan" }>; readonly cwd?: string; readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler }): React.JSX.Element {
  return <><ol className="conversation-timeline-plan-steps">{item.steps.map((step) => <li key={step.id} data-step-status={step.status}>{step.text}</li>)}</ol><DetailLines item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /></>;
}

export function ApprovalDetail({ item, cwd, onOpenSourceRef }: { readonly item: Extract<ConversationTimelineRowItem, { kind: "approval" }>; readonly cwd?: string; readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler }): React.JSX.Element {
  return <><DetailText text={[item.description, item.decision ? `Decision: ${item.decision}` : undefined].filter(Boolean).join("\n")} cwd={cwd} /><DetailLines item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /></>;
}

export function ToolDetail({ item, cwd, onOpenSourceRef }: { readonly item: Extract<ConversationTimelineRowItem, { kind: "mcpToolCall" | "dynamicToolCall" | "collabAgentToolCall" }>; readonly cwd?: string; readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler }): React.JSX.Element {
  return <><DetailText text={[item.inputSummary, item.resultSummary].filter(Boolean).join("\n")} cwd={cwd} /><DetailLines item={item} cwd={cwd} onOpenSourceRef={onOpenSourceRef} /><OperationSourceRefs item={item} onOpenSourceRef={onOpenSourceRef} /></>;
}

export function TextDetail({ text, cwd }: { readonly text: string | undefined; readonly cwd?: string }): React.JSX.Element {
  return <DetailText text={text} cwd={cwd} />;
}

function DetailLines({ item, cwd, onOpenSourceRef }: { readonly item: ConversationTimelineRowItem; readonly cwd?: string; readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler }): React.JSX.Element | null {
  const lines = item.detailLines ?? [];
  if (lines.length === 0) return null;
  return <div className="conversation-timeline-detail-lines">{lines.map((line, index) => {
    if (line.kind === "code") return <code className="conversation-timeline-detail-code" key={`${index}:${line.text}`}>{line.text}</code>;
    if (line.kind === "file_ref") {
      const operationRef = operationFileSourceRefForPath(item.sourceRefs, line.path, item);
      return operationRef ? <ConversationTimelineFileReference key={`${index}:${line.path}`} file={{ fileRef: operationRef, displayName: basename(line.path), change: "edited" }} onOpenSourceRef={onOpenSourceRef} item={item} /> : <span className="conversation-timeline-file-ref" title={line.path} key={`${index}:${line.path}`}>{basename(line.path)}</span>;
    }
    return <MessageBodyRenderer key={`${index}:${line.text}`} className="conversation-timeline-rich-detail" text={line.text} cwd={cwd} compact />;
  })}</div>;
}

function OperationSourceRefs({ item, onOpenSourceRef }: { readonly item: ConversationTimelineRowItem; readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler }): React.JSX.Element | null {
  const refs = item.sourceRefs.filter((ref) =>
    (ref.kind === "file" || ref.kind === "path" || ref.kind === "diff" || ref.kind === "artifact") &&
    Boolean(ref.path || ref.label),
  );
  if (refs.length === 0) return null;
  return <div className="conversation-timeline-ref-list">{refs.map((ref) => (
    <ConversationTimelineFileReference
      key={`${ref.kind}:${ref.id}`}
      file={{ fileRef: ref, displayName: basename(ref.path ?? ref.label ?? ref.id), change: "edited" }}
      onOpenSourceRef={onOpenSourceRef}
      item={item}
    />
  ))}</div>;
}

function DetailText({ text, cwd }: { readonly text: string | undefined; readonly cwd?: string }): React.JSX.Element {
  return text?.trim() ? <MessageBodyRenderer className="conversation-timeline-rich-detail" text={text} cwd={cwd} compact /> : <span className="conversation-timeline-detail-empty">No additional detail.</span>;
}

function CommandResult({ item }: { readonly item: Extract<ConversationTimelineRowItem, { kind: "commandExecution" }> }): React.JSX.Element | null {
  const parts = [item.exitCode === undefined ? undefined : `exit ${item.exitCode}`, item.durationMs === undefined ? undefined : formatDuration(item.durationMs), item.signal ? `signal ${item.signal}` : undefined].filter(Boolean);
  return parts.length > 0 ? <small className="conversation-timeline-detail-meta">{parts.join(" · ")}</small> : null;
}

function commandOutputMeta(
  item: Extract<ConversationTimelineRowItem, { kind: "commandExecution" }>,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string | undefined {
  const parts = [
    item.outputLineCount === undefined ? undefined : t("{count} lines", { count: item.outputLineCount }),
    item.outputByteCount === undefined ? undefined : formatBytes(item.outputByteCount),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? `${t("Output")}: ${parts.join(" · ")}` : undefined;
}

export function detailExists(item: ConversationTimelineRowItem): boolean {
  if (item.kind === "commandExecution") return Boolean(item.command || item.outputTail.length > 0 || item.cwd || item.exitCode !== undefined || item.durationMs !== undefined);
  if (item.kind === "fileChange") return item.files.length > 0 || Boolean(item.changePreview);
  if (item.kind === "exploration") return item.targets.length > 0 || Boolean(item.description || item.resultSummary);
  if (item.kind === "plan") return item.steps.length > 0;
  if (item.kind === "imageView") return Boolean(item.description || item.artifactRef);
  if (item.kind === "reasoning" || item.kind === "contextCompaction") return Boolean(item.summary);
  if (item.kind === "mcpToolCall" || item.kind === "dynamicToolCall" || item.kind === "collabAgentToolCall") return Boolean(item.description || item.detailLines?.length || item.inputSummary || item.resultSummary);
  if (item.kind === "approval") return Boolean(item.description || item.detailLines?.length || item.decision);
  return Boolean(item.description || item.detailLines?.length);
}

export function basename(value: string): string {
  const normalized = value.replace(/\\/gu, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function formatDuration(value: number): string {
  if (value < 1000) return `${Math.max(1, Math.round(value))}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0 B";
  if (value < 1024) return `${value} B`;
  const kib = value / 1024;
  if (kib < 1024) return `${kib.toFixed(kib >= 10 ? 0 : 1)} KiB`;
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MiB`;
}
