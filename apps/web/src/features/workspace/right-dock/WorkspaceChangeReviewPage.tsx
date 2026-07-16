import { useEffect, useMemo, useRef, useState } from "react";
import {
  FolderTree,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { parseUnifiedDiff, type ConversationFileChange } from "../../../lib/diff-summary.js";
import type {
  WorkspaceChangeFile,
  WorkspaceChangesResponse,
} from "../../../types.js";
import { DiffViewer } from "../../../shared/conversation/blocks/DiffViewer.js";
import {
  terminalReportFileIcon,
  terminalReportFileName,
} from "../../../shared/conversation/blocks/TerminalReportBlock.js";
import { WorkspaceFileOpenMenu } from "../../../shared/conversation/blocks/WorkspaceFileOpenMenu.js";

export function WorkspaceChangeReviewPage({
  cwd,
  changes,
  loading,
  error,
  requestedPath,
  onRefresh,
}: {
  readonly cwd?: string;
  readonly changes?: WorkspaceChangesResponse;
  readonly loading: boolean;
  readonly error?: string;
  readonly requestedPath?: string;
  readonly onRefresh: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>();
  const fileRefs = useRef(new Map<string, HTMLElement>());
  const files = changes?.files ?? [];
  const filteredFiles = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query ? files.filter((file) => file.path.toLowerCase().includes(query)) : files;
  }, [files, filter]);
  const directoryGroups = useMemo(() => groupFilesByDirectory(filteredFiles), [filteredFiles]);

  useEffect(() => {
    if (!requestedPath || files.length === 0) {
      return;
    }
    const frameId = globalThis.requestAnimationFrame(() => scrollToFile(requestedPath));
    return () => globalThis.cancelAnimationFrame(frameId);
  }, [files.length, requestedPath]);

  function scrollToFile(path: string): void {
    setSelectedPath(path);
    fileRefs.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="workspace-change-review-page">
      <header className="workspace-change-review-toolbar">
        <span className="workspace-change-review-summary">
          <strong>{changes?.branchName || t("Workspace changes")}</strong>
          {changes?.state === "dirty" ? (
            <small>
              {changes.truncated
                ? t("Showing {visible} of {total} changed files", { visible: files.length, total: changes.totalFileCount })
                : t("{count} changed files", { count: changes.totalFileCount })}
              <span className="add">+{changes.additions}</span>
              <span className="delete">-{changes.deletions}</span>
            </small>
          ) : null}
        </span>
        <span className="workspace-change-review-tools">
          <button type="button" title={t("Refresh")} aria-label={t("Refresh")} onClick={onRefresh} disabled={loading}>
            <RefreshCw className={loading ? "spin" : ""} size={14} />
          </button>
          <button
            type="button"
            className={navigatorOpen ? "active" : ""}
            title={t("Changed file navigator")}
            aria-label={t("Changed file navigator")}
            aria-expanded={navigatorOpen}
            onClick={() => setNavigatorOpen((current) => !current)}
          >
            <FolderTree size={15} />
          </button>
        </span>
      </header>

      <div className="workspace-change-review-body">
        {loading && !changes ? (
          <div className="workspace-change-review-state"><Loader2 className="spin" size={16} /><span>{t("Loading")}</span></div>
        ) : error ? (
          <div className="workspace-change-review-state error"><span>{error}</span></div>
        ) : changes?.state !== "dirty" || files.length === 0 ? (
          <div className="workspace-change-review-state">
            <strong>{t("No code changes")}</strong>
            {changes?.unavailableReason || changes?.errorMessage ? <small>{changes.unavailableReason ?? changes.errorMessage}</small> : null}
          </div>
        ) : (
          <div className="workspace-change-review-diffs">
            {files.map((file) => (
              <WorkspaceChangeFileSection
                key={file.path}
                cwd={changes.repoRoot ?? cwd ?? changes.cwd}
                file={file}
                selected={selectedPath === file.path}
                setRef={(element) => {
                  if (element) {
                    fileRefs.current.set(file.path, element);
                  } else {
                    fileRefs.current.delete(file.path);
                  }
                }}
              />
            ))}
          </div>
        )}

        {navigatorOpen && files.length > 0 ? (
          <aside className="workspace-change-file-navigator" aria-label={t("Changed file navigator")}>
            <div className="workspace-change-file-navigator-head">
              <strong>{t("Changed files")}</strong>
              <button type="button" aria-label={t("Close")} title={t("Close")} onClick={() => setNavigatorOpen(false)}><X size={14} /></button>
            </div>
            <label className="workspace-change-file-search">
              <Search size={13} />
              <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={t("Filter files")} />
            </label>
            <div className="workspace-change-file-tree">
              {directoryGroups.map((group) => (
                <section key={group.directory}>
                  <small>{group.directory}</small>
                  {group.files.map((file) => {
                    const fileIcon = terminalReportFileIcon(file.path);
                    return (
                      <button
                        type="button"
                        className={selectedPath === file.path ? "selected" : ""}
                        key={file.path}
                        title={file.path}
                        onClick={() => scrollToFile(file.path)}
                      >
                        <span className="terminal-report-file-type-icon" data-file-kind={fileIcon.kind} aria-hidden="true"><fileIcon.Icon size={12} /></span>
                        <span>{terminalReportFileName(file.path)}</span>
                        <ChangeStats additions={file.additions} deletions={file.deletions} />
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function WorkspaceChangeFileSection({
  cwd,
  file,
  selected,
  setRef,
}: {
  readonly cwd: string;
  readonly file: WorkspaceChangeFile;
  readonly selected: boolean;
  readonly setRef: (element: HTMLElement | null) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const fileIcon = terminalReportFileIcon(file.path);
  const fileName = terminalReportFileName(file.path);
  const change = workspaceChangeToConversationChange(file);

  useEffect(() => {
    if (selected) {
      setCollapsed(false);
    }
  }, [selected]);

  return (
    <article
      ref={setRef}
      className={[
        "workspace-change-file-section",
        selected ? "selected" : "",
        collapsed ? "collapsed" : "",
      ].filter(Boolean).join(" ")}
      data-workspace-change-path={file.path}
    >
      <header>
        <button
          className="workspace-change-file-toggle"
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? t("Expand code preview") : t("Collapse code preview")}: ${fileName}`}
          onClick={() => setCollapsed((current) => !current)}
        >
          <span className="terminal-report-file-type-icon" data-file-kind={fileIcon.kind} aria-hidden="true"><fileIcon.Icon size={13} /></span>
          <span className="workspace-change-file-copy">
            <strong>{fileName}</strong>
            <small>{directoryName(file.path) || file.path}</small>
          </span>
          <span className="workspace-change-file-badges">
            {file.staged ? <small>{t("Staged")}</small> : null}
            {file.untracked ? <small>{t("Untracked")}</small> : null}
            <ChangeStats additions={file.additions} deletions={file.deletions} />
          </span>
        </button>
        {file.kind !== "deleted" ? <WorkspaceFileOpenMenu cwd={cwd} path={file.path} compact /> : null}
      </header>
      {!collapsed ? (
        change ? <DiffViewer change={change} maxCollapsedLines={220} showFoldMarkers={false} /> : (
          <div className="workspace-change-file-empty">{file.truncated ? t("Preview truncated") : t("Preview unavailable")}</div>
        )
      ) : null}
    </article>
  );
}

function workspaceChangeToConversationChange(file: WorkspaceChangeFile): ConversationFileChange | undefined {
  if (!file.diff?.trim()) {
    return undefined;
  }
  return parseUnifiedDiff(file.diff, {
    idPrefix: `workspace:${file.path}`,
    fallbackPath: file.path,
    status: "completed",
  }).find((change) => change.path === file.path) ?? {
    id: `workspace:${file.path}`,
    path: file.path,
    kind: workspaceChangeKind(file),
    diff: file.diff,
    status: "completed",
    additions: file.additions,
    deletions: file.deletions,
  };
}

function workspaceChangeKind(file: WorkspaceChangeFile): ConversationFileChange["kind"] {
  if (file.kind === "added" || file.untracked) {
    return "add";
  }
  if (file.kind === "deleted") {
    return "delete";
  }
  if (file.kind === "renamed") {
    return "rename";
  }
  return "update";
}

function ChangeStats({ additions, deletions }: { readonly additions: number; readonly deletions: number }): JSX.Element {
  return <span className="workspace-change-stats"><span className="add">+{additions}</span><span className="delete">-{deletions}</span></span>;
}

function groupFilesByDirectory(files: readonly WorkspaceChangeFile[]): readonly { readonly directory: string; readonly files: readonly WorkspaceChangeFile[] }[] {
  const groups = new Map<string, WorkspaceChangeFile[]>();
  for (const file of files) {
    const directory = directoryName(file.path) || ".";
    groups.set(directory, [...(groups.get(directory) ?? []), file]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([directory, entries]) => ({ directory, files: entries }));
}

function directoryName(path: string): string {
  const normalized = path.replace(/\\/gu, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}
