import { useEffect, useMemo, useState } from "react";
import type {
  ConversationOperationSourceRef,
  ConversationTimelineFileChangeItem,
} from "@ling-stack/conversation-ui-core";
import type { PreviewContentResponse } from "../../../types.js";
import { parseUnifiedDiff, summarizeFileChanges, type ConversationFileChange } from "../../../lib/diff-summary.js";
import type { ArtifactPreviewLoader } from "../preview/ArtifactPreviewDrawer.js";
import { DiffViewer } from "../blocks/DiffViewer.js";

interface ConversationTimelineFileChangeDetailProps {
  readonly item: ConversationTimelineFileChangeItem;
  readonly cwd?: string;
  readonly loadPreview?: ArtifactPreviewLoader;
  readonly onOpenSourceRef?: (ref: ConversationOperationSourceRef) => void;
}

interface PreviewState {
  readonly status: "idle" | "loading" | "loaded" | "error";
  readonly changes: readonly ConversationFileChange[];
  readonly truncated?: boolean;
}

/**
 * Renders file evidence only after the typed item is disclosed. Full diffs remain
 * behind the trusted artifact loader and are never inferred from assistant text.
 */
export function ConversationTimelineFileChangeDetail({
  item,
  cwd,
  loadPreview,
  onOpenSourceRef,
}: ConversationTimelineFileChangeDetailProps): React.JSX.Element {
  const preview = item.changePreview;
  const [previewState, setPreviewState] = useState<PreviewState>({ status: "idle", changes: [] });

  useEffect(() => {
    if (!preview || !cwd || !loadPreview) {
      setPreviewState({ status: "idle", changes: [] });
      return;
    }
    let cancelled = false;
    setPreviewState({ status: "loading", changes: [] });
    void loadPreview({ source: "artifact", cwd, artifactId: preview.artifactId, maxBytes: 64 * 1024 }).then(
      (response) => { if (!cancelled) setPreviewState(toPreviewState(response, preview.path, preview.artifactId)); },
      () => { if (!cancelled) setPreviewState({ status: "error", changes: [] }); },
    );
    return () => { cancelled = true; };
  }, [cwd, loadPreview, preview?.artifactId, preview?.path]);

  const summary = useMemo(() => {
    if (previewState.status !== "loaded" || previewState.changes.length === 0) return undefined;
    return summarizeFileChanges(previewState.changes);
  }, [previewState]);

  return (
    <div className="conversation-timeline-file-detail">
      <div className="conversation-timeline-file-list">
        {item.files.map((file) => <ConversationTimelineFileReference key={`${file.fileRef.kind}:${file.fileRef.id}`} file={file} onOpenSourceRef={onOpenSourceRef} />)}
      </div>
      {previewState.status === "loading" ? <small className="conversation-timeline-detail-meta">Loading diff…</small> : null}
      {previewState.status === "error" ? <small className="conversation-timeline-detail-meta">Diff preview unavailable; the file reference remains available.</small> : null}
      {summary ? <small className="conversation-timeline-detail-meta">+{summary.additions} -{summary.deletions}</small> : null}
      {previewState.status === "loaded" && previewState.changes.length > 0 ? (
        <div className="conversation-timeline-change-preview">
          {previewState.changes.slice(0, 2).map((change) => (
            <section key={change.id} className="conversation-timeline-change-preview-file">
              {previewState.changes.length > 1 ? <div className="conversation-timeline-change-preview-file-head"><code>{change.path}</code><span>+{change.additions ?? 0} -{change.deletions ?? 0}</span></div> : null}
              <DiffViewer change={change} maxCollapsedLines={12} showFoldMarkers={false} />
            </section>
          ))}
          {previewState.truncated ? <small className="conversation-timeline-detail-meta">Diff preview truncated.</small> : null}
        </div>
      ) : null}
      {preview && previewState.status === "idle" ? <small className="conversation-timeline-detail-meta">Diff available from artifact {preview.artifactId}</small> : null}
    </div>
  );
}

export function ConversationTimelineFileReference({
  file,
  onOpenSourceRef,
}: {
  readonly file: {
    readonly fileRef: ConversationOperationSourceRef;
    readonly displayName: string;
    readonly change?: string;
    readonly additions?: number;
    readonly deletions?: number;
  };
  readonly onOpenSourceRef?: (ref: ConversationOperationSourceRef) => void;
}): React.JSX.Element {
  const ref = file.fileRef;
  const canOpen = Boolean(onOpenSourceRef && (ref.kind === "file" || ref.kind === "path") && ref.path && ref.hostTarget === "open_file");
  const content = (
    <>
      <span className="conversation-timeline-file-ref-icon" aria-hidden="true">▧</span>
      <span>{file.displayName}</span>
      {file.additions !== undefined || file.deletions !== undefined ? <small>+{file.additions ?? 0} -{file.deletions ?? 0}</small> : null}
    </>
  );
  return canOpen ? (
    <button className="conversation-timeline-file-ref" type="button" title={ref.path} onClick={() => onOpenSourceRef?.(ref)}>{content}</button>
  ) : (
    <span className="conversation-timeline-file-ref" title={ref.path}>{content}</span>
  );
}

function toPreviewState(response: PreviewContentResponse, fallbackPath: string | undefined, artifactId: string): PreviewState {
  if (response.kind !== "diff" || !response.text?.trim()) return { status: "error", changes: [] };
  return {
    status: "loaded",
    changes: parseUnifiedDiff(response.text, {
      idPrefix: `timeline:${artifactId}`,
      fallbackPath: fallbackPath || response.ref.displayPath || response.ref.label || "change.diff",
      status: "completed",
      artifactId,
    }),
    truncated: response.truncated,
  };
}
