import { useEffect, useMemo, useRef, useState } from "react";
import {
  FolderTree,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useI18n } from "../../../i18n.js";
import type { ConversationFileChange } from "../../../lib/diff-summary.js";
import type {
  WorkspaceChangeFile,
  WorkspaceChangesResponse,
} from "../../../types.js";
import type { WorkspaceChangeReview } from "@ling-stack/contracts";
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
  review,
  scoped = false,
  loading,
  error,
  requestedPath,
  onRefresh,
}: {
  readonly cwd?: string;
  readonly changes?: WorkspaceChangesResponse;
  readonly review?: WorkspaceChangeReview;
  readonly scoped?: boolean;
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
  const files = useMemo<readonly ReviewDisplayFile[]>(() => scoped ? (review?.files ?? []).map((file) => ({ ...file,
    staged: false, unstaged: false, untracked: false, truncated: false })) : changes?.files ?? [], [scoped, review, changes]);
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
  }, [files, requestedPath]);

  useEffect(() => { setFilter(""); setSelectedPath(undefined); }, [review?.scope.kind, review?.scope.id]);


  function scrollToFile(path: string): void {
    setSelectedPath(path);
    fileRefs.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="workspace-change-review-page" data-workspace-change-review-scope={scoped ? review?.scope.kind ?? "scoped" : "workspace"}
      data-workspace-change-review-id={review?.scope.id} data-workspace-change-review-revision={review?.revision}>
      <header className="workspace-change-review-toolbar">
        <span className="workspace-change-review-summary">
          <strong>{scoped ? t("This work's changes") : changes?.branchName || t("Workspace changes")}</strong>
          {scoped && review ? <small>{t("{count} changed files", { count: files.length })}
            <ChangeStats additions={review.additions} deletions={review.deletions} /></small> : changes?.state === "dirty" ? (
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
        {loading && !(scoped ? review : changes) ? (
          <div className="workspace-change-review-state"><Spinner label={t("Loading")} size="sm" /></div>
        ) : error ? (
          <InlineFeedback className="workspace-change-review-state error" tone="danger">{error}</InlineFeedback>
        ) : (!scoped && changes?.state !== "dirty") || files.length === 0 ? (
          <EmptyState
            className="workspace-change-review-state"
            compact
            title={t("No code changes")}
            description={scoped ? review?.unavailableReason : changes?.unavailableReason ?? changes?.errorMessage}
          />
        ) : (
          <div className="workspace-change-review-diffs">
            {files.map((file) => (
              <WorkspaceChangeFileSection
                key={file.path}
                cwd={cwd ?? changes?.repoRoot ?? changes?.cwd ?? ""}
                file={file}
                scoped={scoped}
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
      {cwd && !scoped ? <WorkspaceSnapshotRestorePanel cwd={cwd} /> : null}
    </div>
  );
}

function WorkspaceChangeFileSection({
  cwd,
  file,
  scoped,
  selected,
  setRef,
}: {
  readonly cwd: string;
  readonly file: ReviewDisplayFile;
  readonly scoped: boolean;
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
          leadingIcon={<span className="terminal-report-file-type-icon" data-file-kind={fileIcon.kind} aria-hidden="true"><fileIcon.Icon size={13} /></span>}
          onClick={() => setCollapsed((current) => !current)}
        >
          <span className="workspace-change-file-label">
          <span className="workspace-change-file-copy">
            <strong>{fileName}</strong>
            <small>{directoryName(file.path) || file.path}</small>
          </span>
          <span className="workspace-change-file-badges">
            {file.staged ? <small>{t("Staged")}</small> : null}
            {file.untracked ? <small>{t("Untracked")}</small> : null}
            <ChangeStats additions={file.additions} deletions={file.deletions} />
          </span>
          </span>
        </Button>
        {!scoped && file.kind !== "deleted" ? <WorkspaceFileOpenMenu cwd={cwd} path={file.path} compact /> : null}
      </header>
      {!collapsed ? (
        change ? <DiffViewer change={change} maxCollapsedLines={220} showFoldMarkers={false} /> : (
          <div className="workspace-change-file-empty">{file.unavailableReason ?? (file.truncated ? t("Preview truncated") : t("Preview unavailable"))}</div>
        )
      ) : null}
    </article>
  );
}

type ReviewDisplayFile = Omit<WorkspaceChangeFile, "additions" | "deletions"> & {
  readonly additions?: number;
  readonly deletions?: number;
  readonly unavailableReason?: string;
};

function workspaceChangeToConversationChange(file: ReviewDisplayFile): ConversationFileChange | undefined {
  if (!file.diff?.trim()) {
    return undefined;
  }
  return {
    id: `workspace:${file.path}`,
    path: file.path,
    kind: workspaceChangeKind(file),
    diff: file.diff,
    status: "completed",
    additions: file.additions,
    deletions: file.deletions,
  };
}

function workspaceChangeKind(file: ReviewDisplayFile): ConversationFileChange["kind"] {
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

function ChangeStats({ additions, deletions }: { readonly additions?: number; readonly deletions?: number }): React.JSX.Element | null {
  if (additions === undefined || deletions === undefined) return null;
  return <span className="workspace-change-stats"><span className="add">+{additions}</span><span className="delete">−{deletions}</span></span>;
}

function groupFilesByDirectory(files: readonly ReviewDisplayFile[]): readonly { readonly directory: string; readonly files: readonly ReviewDisplayFile[] }[] {
  const groups = new Map<string, ReviewDisplayFile[]>();
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
