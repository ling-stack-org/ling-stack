import { useMemo } from "react";
import { ChevronDown, FilePenLine } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import type { ConversationTimelineResponse } from "./timeline-response-presentation.js";
import { projectTimelineResponseFiles, projectTimelineResponseReview, timelineResponseRecoveryTarget } from "./timeline-response-files.js";
import type { WorkspaceRightDockReviewTarget } from "../../../features/workspace/right-dock/WorkspaceRightDock.js";
import { terminalReportFileIcon, terminalReportFileName } from "../blocks/TerminalReportBlock.js";
import { useWorkspaceRecovery } from "../blocks/workspace-recovery-resource.js";
import { ConversationWorkspaceRecoveryControls } from "../blocks/ConversationWorkspaceRecoveryControls.js";
import { useConversationBlockView } from "../view-store/use-conversation-block-view.js";

export function ConversationTimelineResponseFiles({ response, depth, cwd, onOpenReview }: {
  readonly response: ConversationTimelineResponse;
  readonly depth: 0 | 1;
  readonly cwd?: string;
  readonly onOpenReview?: (target: WorkspaceRightDockReviewTarget) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const evidenceFiles = useMemo(() => projectTimelineResponseFiles(response), [response]);
  const target = timelineResponseRecoveryTarget(response, depth);
  const revisionKey = JSON.stringify(response.items.map((item) => [item.id, item.revision]));
  const resource = useWorkspaceRecovery(cwd?.trim(), response.settled && evidenceFiles.length ? target : undefined, revisionKey);
  const review = useMemo(() => projectTimelineResponseReview(response, resource.recovery?.review), [response, resource.recovery?.review]);
  const files = review?.files ?? evidenceFiles;
  const { expanded, setExpanded } = useConversationBlockView({
    blockId: `response-files:${response.id}`, revisionKey, defaultExpanded: false,
    preserveTouchedStateOnRevision: true,
  });
  if (!response.settled || files.length === 0) return null;
  const canOpen = Boolean(cwd && target && review && onOpenReview);
  const openReview = (path?: string): void => {
    if (cwd && target && review) onOpenReview?.({ cwd, scope: target, review, path });
  };
  const shownFiles = expanded ? files : files.slice(0, 3);
  return <section className="conversation-response-files" data-conversation-response-files data-conversation-response-id={response.id}
    data-change-review-scope={target?.kind} data-change-review-revision={review?.revision}>
    <header className="conversation-response-files-header">
      <FilePenLine size={18} aria-hidden="true" />
      <div className="conversation-response-files-heading">
        <strong>{t(files.length === 1 ? "Edited 1 file" : "Edited {count} files", { count: files.length })}</strong>
        {review?.additions !== undefined && review.deletions !== undefined ? <span className="conversation-response-file-stats"><span className="add">+{review.additions}</span> <span className="delete">−{review.deletions}</span></span> : null}
      </div>
      {target ? <ConversationWorkspaceRecoveryControls cwd={cwd} target={target} fileCountFallback={files.length} resource={resource} /> : null}
      <button type="button" className="conversation-response-files-view" disabled={!canOpen}
        onClick={() => openReview()}>{t("View changes")}</button>
    </header>
    <div className="conversation-response-files-list" data-expanded={expanded}>
      {shownFiles.map((file) => {
        const icon = terminalReportFileIcon(file.path);
        const netFile = review?.files.find((entry) => entry.path === file.path);
        const basename = terminalReportFileName(file.path);
        const duplicateName = files.some((entry) => entry.path !== file.path && terminalReportFileName(entry.path) === basename);
        return <div className="conversation-response-file" key={file.path}>
          <button type="button" className="conversation-response-file-link conversation-timeline-file-ref" title={file.path} disabled={!canOpen}
            onClick={() => openReview(file.path)}>
            <span className="terminal-report-file-type-icon" data-file-kind={icon.kind} aria-hidden="true"><icon.Icon size={14} /></span>
            <span>{basename}</span>{duplicateName ? <small>{file.path.replace(/\\/gu, "/").split("/").slice(0, -1).join("/") || "."}</small> : null}
          </button>
          {netFile?.state === "exact" && netFile.additions !== undefined && netFile.deletions !== undefined ? <span className="conversation-response-file-stats"><span className="add">+{netFile.additions}</span> <span className="delete">−{netFile.deletions}</span></span> : null}
        </div>;
      })}
    </div>
    {resource.status === "unavailable" || resource.status === "loaded" && review?.state !== "exact" ? <div className="conversation-response-files-notice" title={review?.unavailableReason}>{t("Historical diff unavailable")}</div> : null}
    {files.length > 3 ? <button type="button" className="conversation-response-files-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {t(expanded ? "Collapse" : "Files")} {!expanded ? `+${files.length - 3}` : null} <ChevronDown size={14} aria-hidden="true" />
    </button> : null}
  </section>;
}
