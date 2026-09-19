import { useEffect, useState, type CSSProperties } from "react";
import { Code2, ShieldCheck } from "lucide-react";
import { previewArtifactContent } from "../../../api.js";
import { useI18n } from "../../../i18n.js";
import { Skeleton } from "../../../shared/ui/index.js";
import type {
  DockReviewArtifactRef,
  DockReviewItem,
} from "../../../shared/conversation/index.js";
import {
  DockReviewCodePreview,
  codePreviewFromArtifact,
  codePreviewStats,
  fileTypeLabel,
  reviewDetailPathLabel,
  reviewKindLabel,
  reviewMinimapSegments,
} from "./DockReviewCodePreview.js";

export function DockReviewItemDetail({
  item,
  cwd,
  compact = false,
}: {
  readonly item: DockReviewItem;
  readonly cwd?: string;
  readonly compact?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const isApprovalGate = item.kind === "approval_gate";
  const hasPreview = Boolean(item.codePreview);
  const canLoadArtifactPreview = Boolean(!hasPreview && item.artifactRef && cwd);
  const showChangeFallback = item.kind === "code_change" && !hasPreview && !canLoadArtifactPreview;

  return (
    <article className={`right-dock-review-detail ${compact ? "compact" : ""} ${item.kind ?? "generic"}`}>
      {item.codePreview && !compact ? <DockReviewDetailTop item={item} preview={item.codePreview} /> : null}
      {item.codePreview ? <DockReviewCodePreview item={item} preview={item.codePreview} /> : null}
      {item.artifactRef && cwd && !hasPreview ? (
        <DockReviewArtifactPreview
          artifactRef={item.artifactRef}
          cwd={cwd}
          fallbackTitle={item.title}
          fallbackReason={item.reason}
          compact={compact}
        />
      ) : null}

      {showChangeFallback ? (
        <div className="right-dock-review-fallback-card" title={item.reason}>
          <span className="right-dock-review-fallback-icon"><Code2 size={14} /></span>
          <span className="right-dock-review-fallback-copy">
            <strong>{item.title}</strong>
            {item.reason ? <small>{item.reason}</small> : null}
          </span>
          <span className="right-dock-review-fallback-action">{t("Preview unavailable")}</span>
        </div>
      ) : null}

      {!hasPreview && !showChangeFallback && !canLoadArtifactPreview ? (
        <div className="right-dock-review-plain">
          <span className="right-dock-review-kicker">
            {isApprovalGate ? <ShieldCheck size={15} /> : <Code2 size={15} />}
            {reviewKindLabel(item.kind, t)}
          </span>
          <p>{item.reason}</p>
          {item.facts && item.facts.length > 0 ? (
            <div className="right-dock-review-facts compact" aria-label={t("Review facts")}>
              {item.facts.map((fact) => (
                <span key={`${fact.label}:${fact.value}`} className={fact.tone ? `tone-${fact.tone}` : undefined}>
                  <small>{fact.label}</small>
                  <strong>{fact.value}</strong>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {isApprovalGate ? (
        <div className="right-dock-review-approval-note">
          <ShieldCheck size={15} />
          <span>
            <strong>{t("Approval gate")}</strong>
            <small>{t("Approval happens in the approval surface. Review only shows the evidence.")}</small>
          </span>
        </div>
      ) : null}
    </article>
  );
}

function DockReviewDetailTop({
  item,
  preview,
}: {
  readonly item: DockReviewItem;
  readonly preview: NonNullable<DockReviewItem["codePreview"]>;
}): React.JSX.Element {
  const stats = item.stats ?? preview.stats ?? codePreviewStats(preview.lines);
  const minimap = reviewMinimapSegments(item, preview);
  return (
    <div className="right-dock-review-detail-top">
      <div className="right-dock-review-file-strip">
        <span className="right-dock-review-file-type">{fileTypeLabel(preview)}</span>
        <span className="right-dock-review-file-path">
          <strong>{preview.title || item.title}</strong>
          <small>{reviewDetailPathLabel(item, preview) || " "}</small>
        </span>
        {stats ? (
          <span className="right-dock-diff-stat">
            <span className="add">+{stats.additions}</span>
            <span className="del">-{stats.deletions}</span>
          </span>
        ) : null}
      </div>
      <div className="right-dock-review-minimap" aria-label="File review minimap">
        {minimap.map((segment) => (
          <span
            key={segment.id}
            className={`right-dock-review-mini ${segment.tone}`}
            title={segment.label}
            style={{ "--segment-fill": `${segment.fill}%` } as CSSProperties}
          />
        ))}
      </div>
      <div className="right-dock-review-mode-row" aria-label="Review display mode">
        <span className="right-dock-review-mode active">Unified</span>
        <span className="right-dock-review-mode">Split</span>
        <span className="right-dock-review-mode">Hide whitespace</span>
        <span className="right-dock-review-mode">只看 note</span>
      </div>
    </div>
  );
}

function DockReviewArtifactPreview({
  artifactRef,
  cwd,
  fallbackTitle,
  fallbackReason,
  compact = false,
}: {
  readonly artifactRef: DockReviewArtifactRef;
  readonly cwd: string;
  readonly fallbackTitle: string;
  readonly fallbackReason: string;
  readonly compact?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<DockReviewItem["codePreview"]>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setPreview(undefined);
    void previewArtifactContent(cwd, artifactRef.id, 96_000).then((response) => {
      if (cancelled) {
        return;
      }
      if (response.text) {
        setPreview(codePreviewFromArtifact(artifactRef, response.text, response.kind, response.truncated));
        return;
      }
      setError(t("Preview unavailable"));
    }, (reason) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      if (!cancelled) {
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [artifactRef, cwd, t]);

  if (loading) {
    return (
      <div className="right-dock-review-fallback-card" data-loading="true" title={fallbackReason}>
        <span className="right-dock-review-fallback-icon"><Code2 size={14} /></span>
        <span className="right-dock-review-fallback-copy">
          <strong>{fallbackTitle}</strong>
          <Skeleton height={10} width="60%" />
        </span>
        <span className="right-dock-review-fallback-action">{t("Loading preview...")}</span>
      </div>
    );
  }

  if (preview) {
    const previewItem: DockReviewItem = {
      id: artifactRef.id,
      group: "files",
      severity: "info",
      status: "pending",
      kind: "code_change",
      title: fallbackTitle,
      reason: fallbackReason,
      pathLabel: artifactRef.path,
      stats: preview.stats,
    };
    return (
      <>
        {!compact ? <DockReviewDetailTop item={previewItem} preview={preview} /> : null}
        <DockReviewCodePreview item={previewItem} preview={preview} />
      </>
    );
  }

  return (
    <div className="right-dock-review-fallback-card" title={error || fallbackReason}>
      <span className="right-dock-review-fallback-icon"><Code2 size={14} /></span>
      <span className="right-dock-review-fallback-copy">
        <strong>{fallbackTitle}</strong>
        <small>{error || fallbackReason}</small>
      </span>
      <span className="right-dock-review-fallback-action">{t("Preview unavailable")}</span>
    </div>
  );
}
