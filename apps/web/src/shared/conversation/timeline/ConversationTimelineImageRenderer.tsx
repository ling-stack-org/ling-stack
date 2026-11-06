import { useEffect, useState } from "react";
import { Image as ImageIcon, Loader2 } from "lucide-react";
import type { ConversationTimelineImageViewItem } from "@ling-stack/conversation-ui-core";
import { TimelineFactRow } from "./TimelineFactRow.js";
import { TextDetail, detailExists } from "./timeline-renderer-details.js";
import { ArtifactPreviewDrawer, type ArtifactPreviewLoader } from "../preview/ArtifactPreviewDrawer.js";
import type { PreviewContentResponse } from "../../../types.js";
import { notifyConversationDeferredContentReady } from "../blocks/deferred-rendering.js";

export function ConversationTimelineImageRenderer({ item, cwd, loadPreview, depth }: { readonly item: ConversationTimelineImageViewItem; readonly cwd?: string; readonly loadPreview?: ArtifactPreviewLoader; readonly depth: 0 | 1 }): React.JSX.Element {
  const artifactId = item.artifactRef?.kind === "artifact" ? item.artifactRef.id : undefined;
  const request = loadPreview && cwd && artifactId ? { source: "artifact" as const, cwd, artifactId, maxBytes: 96_000 } : undefined;
  const [preview, setPreview] = useState<PreviewContentResponse>();
  const [previewLoading, setPreviewLoading] = useState(false);
  const [activePreview, setActivePreview] = useState(false);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);

  useEffect(() => {
    if (!request || !loadPreview) {
      setPreview(undefined);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreview(undefined);
    setPreviewLoading(true);
    setImageLoadFailed(false);
    void loadPreview(request).then((response) => {
      if (!cancelled) setPreview(response);
    }, () => {
      if (!cancelled) setPreview(undefined);
    }).finally(() => {
      if (!cancelled) setPreviewLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [item.revision, loadPreview, request?.artifactId, request?.cwd]);

  const imagePreview = !imageLoadFailed && preview?.kind === "image" && preview.imageUrl ? preview : undefined;
  const canPreview = Boolean(request && imagePreview);
  const detail = imagePreview ? (
    <button
      className="conversation-timeline-image-preview"
      type="button"
      aria-label={`${item.title}: Preview`}
      onClick={() => setActivePreview(true)}
    >
      <img
        src={imagePreview.imageUrl}
        alt={imagePreview.ref.label}
        loading="lazy"
        decoding="async"
        onLoad={(event) => notifyConversationDeferredContentReady(event.currentTarget)}
        onError={() => setImageLoadFailed(true)}
      />
    </button>
  ) : previewLoading ? (
    <span className="conversation-timeline-image-preview-loading" aria-label="Loading image preview"><Loader2 size={14} aria-hidden="true" /></span>
  ) : detailExists(item) ? <TextDetail text={item.description ?? item.alt} cwd={cwd} /> : undefined;

  return (
    <>
      <TimelineFactRow item={item} depth={depth} title={item.title} icon={<ImageIcon size={14} aria-hidden="true" />} defaultExpanded={canPreview || Boolean(request)} detail={detail} />
      {activePreview && request ? (
        <ArtifactPreviewDrawer request={request} loadPreview={loadPreview!} onClose={() => setActivePreview(false)} />
      ) : null}
    </>
  );
}
