import { ChevronDown, FileText } from "lucide-react";
import { useI18n, type Translate } from "../../../i18n.js";
import type { TranscriptBlockBase, TranscriptDisplayLine } from "../transcript/index.js";
import { useConversationBlockView } from "../view-store/use-conversation-block-view.js";
import { MessageBodyRenderer } from "./MessageBodyRenderer.js";

export interface TranscriptBlockViewProps {
  readonly block: TranscriptBlockBase;
  readonly cwd?: string;
  readonly defaultExpanded?: boolean;
}

export function TranscriptBlockView({
  block,
  cwd,
  defaultExpanded,
}: TranscriptBlockViewProps): React.JSX.Element {
  const { t } = useI18n();
  const hasExpandedDetail = Boolean(block.expanded?.summary || block.expanded?.lines?.length);
  const previewTargets = block.previewTargets ?? [];
  const disclosure = useConversationBlockView({
    blockId: transcriptBlockViewKey(block.id),
    revisionKey: transcriptBlockRevisionKey(block),
    defaultExpanded: Boolean(defaultExpanded || shouldDefaultExpandBlock(block)),
  });
  const expanded = disclosure.expanded;
  const rootClassName = [
    "transcript-block-view",
    `kind-${block.kind}`,
    block.status ? `status-${block.status}` : "",
    expanded ? "expanded" : "",
  ].filter(Boolean).join(" ");

  return (
    <section
      className={rootClassName}
      aria-label={transcriptBlockLabel(block.kind, t)}
      data-conversation-transcript-block
    >
      <button
        className="transcript-block-view-head"
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? t("Collapse transcript block") : t("Expand transcript block")}
        disabled={!hasExpandedDetail && previewTargets.length === 0}
        onClick={disclosure.toggleExpanded}
      >
        <span className="transcript-block-view-icon" aria-hidden="true">
          <FileText size={13} />
        </span>
        <span className="transcript-block-view-copy">
          {block.display.map((line) => <TranscriptDisplayLineView key={line.id} line={line} cwd={cwd} />)}
        </span>
        {hasExpandedDetail || previewTargets.length > 0 ? (
          <span className="transcript-block-view-toggle" aria-hidden="true">
            <ChevronDown size={13} />
          </span>
        ) : null}
      </button>
      {expanded && (hasExpandedDetail || previewTargets.length > 0) ? (
        <div className="transcript-block-view-detail">
          {block.expanded?.title ? <strong>{block.expanded.title}</strong> : null}
          {block.expanded?.summary ? <MessageBodyRenderer text={block.expanded.summary} cwd={cwd} compact /> : null}
          {block.expanded?.lines?.length ? (
            <div className="transcript-block-view-lines">
              {block.expanded.lines.map((line) => <TranscriptDisplayLineView key={line.id} line={line} cwd={cwd} />)}
            </div>
          ) : null}
          {previewTargets.length > 0 ? (
            <div className="transcript-block-view-preview-list" aria-label={t("Preview targets")}>
              {previewTargets.map((target) => (
                target.href ? (
                  <a key={target.id} href={target.href} target="_blank" rel="noreferrer">
                    <span>{target.label}</span>
                    <small>{target.kind}</small>
                  </a>
                ) : (
                  <span key={target.id}>
                    <span>{target.label}</span>
                    <small>{target.kind}</small>
                  </span>
                )
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function transcriptBlockViewKey(blockId: string): string {
  return `transcript-block:${blockId}`;
}

function TranscriptDisplayLineView({
  line,
  cwd,
}: {
  readonly line: TranscriptDisplayLine;
  readonly cwd?: string;
}): React.JSX.Element {
  return (
    <span className={["transcript-block-view-line", line.tone ? `tone-${line.tone}` : ""].filter(Boolean).join(" ")}>
      {/* The collapsed header is phrasing content inside a button. Keep it
          text-only here so a block-level Markdown renderer is not nested in
          <button>/<span>; expanded details render the full Markdown body. */}
      <span className="transcript-block-view-line-text">{line.text}</span>
      {line.meta ? <small>{line.meta}</small> : null}
    </span>
  );
}

function shouldDefaultExpandBlock(block: TranscriptBlockBase): boolean {
  if (block.kind === "raw_debug_ref") {
    return false;
  }
  return block.status === "running" ||
    block.status === "waiting_for_approval" ||
    block.status === "blocked" ||
    block.status === "failed";
}

function transcriptBlockRevisionKey(block: TranscriptBlockBase): string {
  return [
    block.revision ?? "",
    block.updatedAt ?? "",
    block.status ?? "",
    block.display.length,
    block.expanded?.summary ?? "",
    block.expanded?.lines?.length ?? 0,
    block.previewTargets?.length ?? 0,
  ].join("|");
}

function transcriptBlockLabel(kind: TranscriptBlockBase["kind"], t: Translate): string {
  if (kind === "requirement_shaping") {
    return t("Requirement shaping");
  }
  if (kind === "decision_needed") {
    return t("Decision needed");
  }
  if (kind === "source_summary") {
    return t("Source summary");
  }
  if (kind === "approval") {
    return t("Approval");
  }
  if (kind === "artifact_strip") {
    return t("Artifacts");
  }
  if (kind === "agent_activity") {
    return t("Agent activity");
  }
  if (kind === "conversation_item") {
    return t("Conversation item");
  }
  if (kind === "final_result") {
    return t("Final result");
  }
  return t("Transcript block");
}
