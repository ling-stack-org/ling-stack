import { useEffect, useState } from "react";
import { previewWorkspaceFile } from "../../../api.js";
import { useI18n } from "../../../i18n.js";
import type { DockFileItem, DockReviewItem } from "../../../shared/conversation/index.js";
import { WorkspaceFileOpenMenu } from "../../../shared/conversation/blocks/WorkspaceFileOpenMenu.js";
import {
  DockReviewCodePreview,
  fileNameFromPath,
  workspaceFileCodePreview,
} from "./DockReviewCodePreview.js";
import type { WorkspaceRightDockFileTarget } from "./WorkspaceRightDock.js";

export function DockFileItemDetail({
  item,
  labels,
}: {
  readonly item: DockFileItem;
  readonly labels: {
    readonly type: string;
    readonly path: string;
    readonly status: string;
  };
}): JSX.Element {
  return (
    <dl className="right-dock-detail-list">
      <div>
        <dt>{labels.type}</dt>
        <dd>{item.kind}</dd>
      </div>
      {item.pathLabel ? (
        <div>
          <dt>{labels.path}</dt>
          <dd>{item.pathLabel}</dd>
        </div>
      ) : null}
      {item.status ? (
        <div>
          <dt>{labels.status}</dt>
          <dd>{item.status}</dd>
        </div>
      ) : null}
    </dl>
  );
}

export function DockWorkspaceFilePreview({
  cwd,
  target,
}: {
  readonly cwd: string;
  readonly target: WorkspaceRightDockFileTarget;
}): JSX.Element {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewWorkspaceFile>>>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setPreview(undefined);
    void previewWorkspaceFile(cwd, target.path, 64 * 1024, target.line).then((response) => {
      if (!cancelled) {
        setPreview(response);
      }
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
  }, [cwd, target.line, target.path]);

  if (loading) {
    return <div className="artifact-preview-loading">{t("Loading preview...")}</div>;
  }
  if (error) {
    return <div className="artifact-preview-error" role="alert">{error}</div>;
  }
  if (!preview) {
    return <div className="artifact-preview-empty">{t("Preview unavailable")}</div>;
  }
  const codePreview = workspaceFileCodePreview(target, preview);
  if (!codePreview) {
    return (
      <div className="artifact-preview-empty">
        <strong>{target.label || fileNameFromPath(target.path) || target.path}</strong>
        <span>{t("Preview unavailable")}</span>
      </div>
    );
  }
  const item: DockReviewItem = {
    id: `workspace-file:${target.path}:${target.line ?? ""}`,
    group: "files",
    severity: "info",
    status: "passed",
    title: codePreview.title,
    reason: t("Read-only workspace file preview"),
    pathLabel: codePreview.pathLabel,
  };
  return (
    <article className="right-dock-workspace-file-preview" data-workspace-file-path={target.path}>
      <div className="right-dock-workspace-file-preview-actions">
        <WorkspaceFileOpenMenu cwd={cwd} path={target.path} line={target.line} compact />
      </div>
      <DockReviewCodePreview item={item} preview={codePreview} focusLine={target.line} />
    </article>
  );
}

export function workspaceFileDetailSourceId(nonce: number): string {
  return `workspace-file-request:${nonce}`;
}

export function workspaceFileTargetSubtitle(target: WorkspaceRightDockFileTarget): string {
  return target.line === undefined ? target.path : `${target.path}:${target.line}`;
}
