import { useState } from "react";
import { useI18n } from "../../../i18n.js";
import type {
  ConversationOperationSourceRef,
  ConversationTimelineRowItem,
  ConversationTimelineFileChangeItem,
} from "@ling-stack/conversation-ui-core";
import { hasExecutableFileLineage } from "./source-ref.js";
import type { ConversationTimelineSourceRefHandler } from "./source-ref.js";

interface ConversationTimelineFileChangeDetailProps {
  readonly item: ConversationTimelineFileChangeItem;
  readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler;
}

/**
 * Renders file evidence only after the typed item is disclosed. Full diffs remain
 * behind the Host capability viewer and are never fetched from a bare artifact id.
 */
export function ConversationTimelineFileChangeDetail({
  item,
  onOpenSourceRef,
}: ConversationTimelineFileChangeDetailProps): React.JSX.Element {
  const { t } = useI18n();
  const previewRef = item.changePreview
    ? item.sourceRefs.find((ref) => ref.id === item.changePreview?.artifactId && (ref.kind === "artifact" || ref.kind === "diff"))
    : undefined;

  return (
    <div className="conversation-timeline-file-detail">
      <div className="conversation-timeline-file-list">
        {item.files.map((file) => <ConversationTimelineFileReference key={`${file.fileRef.kind}:${file.fileRef.id}`} file={item.files.length === 1 ? { ...file, displayName: t("Open path") } : file} onOpenSourceRef={onOpenSourceRef} item={item} />)}
        {previewRef ? (
          <ConversationTimelineFileReference
            file={{
              fileRef: previewRef,
              displayName: t("Show diff details"),
              change: "edited",
            }}
            onOpenSourceRef={onOpenSourceRef}
            item={item}
          />
        ) : null}
      </div>
      {item.changePreview && !previewRef ? <small className="conversation-timeline-detail-meta">Diff evidence is unavailable because its durable artifact ref is missing.</small> : null}
    </div>
  );
}

export function ConversationTimelineFileReference({
  file,
  onOpenSourceRef,
  item,
}: {
  readonly file: {
    readonly fileRef: ConversationOperationSourceRef;
    readonly displayName: string;
    readonly change?: string;
    readonly additions?: number;
    readonly deletions?: number;
  };
  readonly onOpenSourceRef?: ConversationTimelineSourceRefHandler;
  readonly item?: ConversationTimelineRowItem;
}): React.JSX.Element {
  const ref = file.fileRef;
  const canOpen = Boolean(onOpenSourceRef && hasExecutableFileLineage(item) && ref.id.trim() && isOpenableResourceRef(ref));
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState("");
  const content = (
    <>
      <span className="conversation-timeline-file-ref-icon" aria-hidden="true">{sourceRefIcon(ref)}</span>
      <span>{file.displayName}</span>
      {file.additions !== undefined || file.deletions !== undefined ? <small>+{file.additions ?? 0} -{file.deletions ?? 0}</small> : null}
    </>
  );
  return canOpen ? (
    <span className="conversation-timeline-file-ref-wrap">
      <button className="conversation-timeline-file-ref" type="button" title={ref.path} disabled={opening} onClick={() => {
        if (!hasExecutableFileLineage(item)) return;
        setOpening(true);
        setOpenError("");
        void Promise.resolve(onOpenSourceRef?.(ref, item)).catch((reason: unknown) => {
          setOpenError(reason instanceof Error ? reason.message : String(reason));
        }).finally(() => setOpening(false));
      }}>{opening ? "…" : content}</button>
      {openError ? <small className="conversation-timeline-detail-meta" role="alert">{openError}</small> : null}
    </span>
  ) : (
    <span className="conversation-timeline-file-ref" title={ref.path ?? ref.label ?? ref.id}>{content}</span>
  );
}

function isOpenableResourceRef(ref: ConversationOperationSourceRef): boolean {
  return ref.kind === "file" || ref.kind === "path" || ref.kind === "diff" || ref.kind === "artifact";
}

function sourceRefIcon(ref: ConversationOperationSourceRef): string {
  if (ref.hostTarget === "open_artifact" || ref.kind === "artifact") return "◫";
  if (ref.hostTarget === "open_diff" || ref.kind === "diff") return "±";
  return "▧";
}
