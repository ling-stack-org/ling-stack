import { useEffect, useState } from "react";
import { previewWorkspaceFile, previewWorkspaceFileCapability } from "../../../api.js";
import { useI18n } from "../../../i18n.js";
import type { DockFileItem, DockReviewItem } from "../../../shared/conversation/index.js";
import { WorkspaceFileOpenMenu } from "../../../shared/conversation/blocks/WorkspaceFileOpenMenu.js";
import { ArtifactPreview } from "../../../shared/conversation/preview/ArtifactPreview.js";
import {
  DockReviewCodePreview,
  fileNameFromPath,
  workspaceFileCodePreview,
} from "./DockReviewCodePreview.js";
import type { WorkspaceRightDockFileTarget } from "./WorkspaceRightDock.js";
import { DockLocalFilePreview } from "./DockLocalFilePreview.js";

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
}): React.JSX.Element {
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
  onNavigateLocalFile,
}: {
  readonly cwd: string;
  readonly target: WorkspaceRightDockFileTarget;
  readonly onNavigateLocalFile?: (file: NonNullable<WorkspaceRightDockFileTarget["localFile"]>) => void;
}): React.JSX.Element {
  if (target.localFile) return <DockLocalFilePreview initial={target.localFile} onNavigate={onNavigateLocalFile} />;
  return <DockWorkspaceResourcePreview cwd={cwd} target={target} />;
}

function DockWorkspaceResourcePreview({ cwd, target }: { readonly cwd: string; readonly target: WorkspaceRightDockFileTarget }): React.JSX.Element {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewWorkspaceFile>>>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setPreview(undefined);
    const previewRequest = target.capabilityId && target.capabilityScope
      ? previewWorkspaceFileCapability({
        cwd,
        capabilityId: target.capabilityId,
        scope: target.capabilityScope,
        maxBytes: 64 * 1024,
        line: target.line,
      })
      : previewWorkspaceFile(cwd, target.path, 64 * 1024, target.line);
    void previewRequest.then((response) => {
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
  }, [cwd, target.capabilityId, target.capabilityScope, target.line, target.path]);

  if (loading) {
    return <div className="artifact-preview-loading">{t("Loading preview...")}</div>;
  }
  if (error) {
    return <div className="artifact-preview-error" role="alert">{error}</div>;
  }
  if (!preview) {
    return <div className="artifact-preview-empty">{t("Preview unavailable")}</div>;
  }
  const capabilityTarget = target.capabilityTarget ?? "open_file";
  if (capabilityTarget === "open_artifact") {
    return (
      <article
        className="right-dock-workspace-file-preview"
        data-workspace-file-path={target.path}
        data-workspace-capability-target={capabilityTarget}
        data-workspace-viewer-kind="artifact"
      >
        <ArtifactPreview preview={preview} />
      </article>
    );
  }
  if (capabilityTarget === "open_diff" && preview.kind !== "diff") {
    return <div className="artifact-preview-error" role="alert">{t("Diff preview unavailable")}</div>;
  }
  const codePreview = workspaceFileCodePreview(target, preview);
  if (!codePreview) {
    return (
      <article
        className="right-dock-workspace-file-preview"
        data-workspace-file-path={target.path}
        data-workspace-capability-target={capabilityTarget}
        data-workspace-viewer-kind="file"
      >
        <ArtifactPreview preview={preview} />
      </article>
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
    <article
      className="right-dock-workspace-file-preview"
      data-workspace-file-path={target.path}
      data-workspace-capability-target={capabilityTarget}
      data-workspace-viewer-kind={capabilityTarget === "open_diff" ? "diff" : "file"}
    >
      {capabilityTarget === "open_file" ? (
        <div className="right-dock-workspace-file-preview-actions">
          <WorkspaceFileOpenMenu cwd={cwd} path={target.path} line={target.line} compact capabilityId={target.capabilityId} scope={target.capabilityScope} />
        </div>
      ) : null}
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
