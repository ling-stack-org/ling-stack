import { useEffect, useRef, useState } from "react";
import { ArrowUp, File, Folder, ChevronDown, Loader2 } from "lucide-react";
import type { DesktopLocalFilePreview } from "../../../../../desktop/shared/local-file-capabilities.js";
import { useI18n } from "../../../i18n.js";
import { ImageCompareViewer } from "../../../shared/conversation/preview/ImageCompareViewer.js";
import { DockReviewCodePreview } from "./DockReviewCodePreview.js";

export function DockLocalFilePreview({ initial, onNavigate }: {
  readonly initial: DesktopLocalFilePreview;
  readonly onNavigate?: (file: DesktopLocalFilePreview) => void;
}): React.JSX.Element {
  const { t, locale } = useI18n();
  const [file, setFile] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  useEffect(() => { requestId.current += 1; setFile(initial); setBusy(false); setError(""); }, [initial]);
  useEffect(() => () => { requestId.current += 1; }, []);

  async function navigate(path: string, menu = false): Promise<void> {
    const localFiles = window.lingDesktop?.localFiles;
    if (!localFiles) return;
    const id = ++requestId.current;
    setBusy(true);
    setError("");
    try {
      const result = await (menu ? localFiles.showMenu({ path, locale }) : localFiles.inspect({ path, locale }));
      if (id === requestId.current && result) { setFile(result); onNavigate?.(result); }
    } catch (reason) {
      if (id === requestId.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally { if (id === requestId.current) setBusy(false); }
  }

  const parts = file.path.split(/[\\/]/u).filter(Boolean);
  const parentPath = file.path.replace(/[\\/]+$/u, "").replace(/[\\/][^\\/]*$/u, "") || "/";
  const parent = /^[A-Z]:$/iu.test(parentPath) ? `${parentPath}\\` : parentPath;
  const lines = (file.text ?? "").split(/\r?\n/u);
  const start = Math.max(0, Math.min(lines.length - 1, (file.line ?? 1) - 1) - 90);
  const visibleLines = lines.slice(start, start + 300);
  const codePreview = {
    title: file.name,
    pathLabel: file.path,
    language: file.language ?? "text",
    lines: visibleLines.map((text, index) => ({ kind: "context" as const, text: text || " ", lineNumber: start + index + 1 })),
    truncated: file.truncated || start > 0 || start + 300 < lines.length,
  };
  return (
    <article className="local-file-preview" data-local-file-kind={file.kind} data-local-file-viewer-path={file.path} aria-busy={busy}>
      <div className="local-file-preview-toolbar">
        <button type="button" className="local-file-parent" title={t("Open parent folder")} aria-label={t("Open parent folder")}
          disabled={file.path === "/" || /^[A-Z]:[\\/]$/iu.test(file.path)} data-local-file-path={parent} data-local-file-cwd=""
          onClick={() => void navigate(parent)}><ArrowUp size={15} /></button>
        <span className="local-file-breadcrumb" title={file.path}>{parts.slice(-3).join(" / ") || file.path}</span>
        <button type="button" className="workspace-file-open-trigger labeled" data-local-file-path={file.path} data-local-file-cwd=""
          onClick={() => void navigate(file.path, true)}><span>{t("Open with")}</span><ChevronDown size={13} /></button>
      </div>
      {error ? <div className="artifact-preview-error" role="alert" title={error}>{t("Unable to preview this file")}</div> : null}
      {busy ? <span className="local-file-loading" role="status"><Loader2 size={14} className="spin" />{t("Loading preview...")}</span> : null}
      {file.kind === "text" ? <DockReviewCodePreview item={{ id: file.path, group: "files", severity: "info", status: "passed", title: file.name, reason: "", pathLabel: file.path }} preview={codePreview} focusLine={file.line} /> : null}
      {file.kind === "image" && file.imageUrl ? <ImageCompareViewer current={{ label: file.name, imageUrl: file.imageUrl }} /> : null}
      {file.kind === "directory" ? <div className="local-file-directory" aria-label={t("Folder contents")}>
        {file.entries?.map((entry) => <button key={entry.path} type="button" data-local-file-path={entry.path} data-local-file-cwd=""
          onClick={() => void navigate(entry.path)} onContextMenu={(event) => { event.preventDefault(); void navigate(entry.path, true); }}>
          {entry.directory ? <Folder size={16} /> : <File size={16} />}<span>{entry.name}</span>
        </button>)}
        {file.entries?.length === 0 ? <div className="artifact-preview-empty">{t("This folder is empty")}</div> : null}
        {file.truncated ? <p className="local-file-preview-note">{t("Showing the first 500 entries. Open this folder in your file manager to see all items.")}</p> : null}
      </div> : null}
      {file.kind === "unsupported" ? <div className="local-file-unsupported">
        <File size={32} aria-hidden="true" />
        <strong>{t("This file type cannot be previewed")}</strong>
        <span>{t("Open this file in another application to view it.")}</span>
        <button className="workspace-file-open-trigger labeled" type="button" data-local-file-path={file.path} data-local-file-cwd="" onClick={() => void navigate(file.path, true)}>{t("Open with")}<ChevronDown size={13} /></button>
      </div> : null}
    </article>
  );
}
