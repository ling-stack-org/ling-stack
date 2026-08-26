import { useEffect, useMemo, useRef, useState } from "react";
import {
  FolderTree,
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
import { WorkspaceSnapshotRestorePanel } from "./WorkspaceSnapshotRestorePanel.js";
import {
  Button,
  EmptyState,
  IconButton,
  InlineFeedback,
  Input,
  Spinner,
} from "../../../shared/ui/index.js";

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
}): React.JSX.Element {
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
          <IconButton
            icon={RefreshCw}
            label={t("Rescan changes")}
            loading={loading}
            loadingLabel={t("Rescan changes")}
            onClick={onRefresh}
            disabled={loading}
            size="sm"
          />
          <IconButton
            className={navigatorOpen ? "active" : ""}
            icon={FolderTree}
            label={t("Changed file navigator")}
            aria-expanded={navigatorOpen}
            pressed={navigatorOpen}
            onClick={() => setNavigatorOpen((current) => !current)}
            size="sm"
          />
        </span>
      </header>

      <div className="workspace-change-review-body">
        {loading && !changes ? (
          <div className="workspace-change-review-state"><Spinner label={t("Loading")} size="sm" /></div>
        ) : error ? (
          <InlineFeedback className="workspace-change-review-state error" tone="danger">{error}</InlineFeedback>
        ) : changes?.state !== "dirty" || files.length === 0 ? (
          <EmptyState
            className="workspace-change-review-state"
            compact
            title={t("No code changes")}
            description={changes?.unavailableReason ?? changes?.errorMessage}
          />
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
              <IconButton icon={X} label={t("Close")} onClick={() => setNavigatorOpen(false)} size="sm" />
            </div>
            <Input
              containerClassName="workspace-change-file-search"
              prefix={<Search size={13} />}
              aria-label={t("Filter files")}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t("Filter files")}
              size="sm"
            />
            <div className="workspace-change-file-tree">
              {directoryGroups.map((group) => (
                <section key={group.directory}>
                  <small>{group.directory}</small>
                  {group.files.map((file) => {
                    const fileIcon = terminalReportFileIcon(file.path);
                    return (
                      <Button
                        className={selectedPath === file.path ? "selected" : ""}
                        variant="ghost"
                        size="sm"
                        key={file.path}
                        title={file.path}
                        onClick={() => scrollToFile(file.path)}
                      >
                        <span className="terminal-report-file-type-icon" data-file-kind={fileIcon.kind} aria-hidden="true"><fileIcon.Icon size={12} /></span>
                        <span>{terminalReportFileName(file.path)}</span>
                        <ChangeStats additions={file.additions} deletions={file.deletions} />
                      </Button>
                    );
                  })}
                </section>
              ))}
            </div>
          </aside>
        ) : null}
      </div>
      {cwd ? <WorkspaceSnapshotRestorePanel cwd={cwd} /> : null}
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
}): React.JSX.Element {
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
        <Button
          className="workspace-change-file-toggle"
          variant="ghost"
          size="md"
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
        </Button>
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

function ChangeStats({ additions, deletions }: { readonly additions: number; readonly deletions: number }): React.JSX.Element {
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
