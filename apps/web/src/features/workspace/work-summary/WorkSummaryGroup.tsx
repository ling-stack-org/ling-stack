import { ChevronDown, Folder, GitBranch, MessageSquare } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../shared/ui/index.js";
import type { WorkSummaryGroupModel, WorkSummarySession } from "./work-summary.types.js";
import { isCleanSummaryWorkspace, summaryFolderLabel } from "./work-summary-model.js";
import { WorkSummaryChangeRow } from "./WorkSummaryChangeRow.js";
import { WorkSummaryCommitRow } from "./WorkSummaryCommitRow.js";

export function WorkSummaryGroup({ group, defaultOpen, onOpenSession, onOpenChanges }: {
  readonly group: WorkSummaryGroupModel;
  readonly defaultOpen: boolean;
  readonly onOpenSession: (session: WorkSummarySession) => void;
  readonly onOpenChanges?: (cwd: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { sessions, workspace } = group;
  const sessionCount = sessions.length === 1 ? t("1 session") : t("{count} sessions", { count: sessions.length });
  const label = workspace?.branch || (workspace ? summaryFolderLabel(workspace.cwd) : sessions[0]?.title || t("Workspace unavailable"));
  const WorkspaceIcon = workspace?.branch ? GitBranch : Folder;

  return (
    <Collapsible className="work-summary-group" defaultOpen={defaultOpen}>
      <CollapsibleTrigger asChild>
        <button className="work-summary-group-trigger" type="button" title={workspace?.cwd}>
          <WorkspaceIcon size={15} aria-hidden="true" />
          <strong>{label}</strong>
          <small>{sessionCount}{workspace && isCleanSummaryWorkspace(workspace) ? ` · ${t("No changes")}` : ""}</small>
          <ChevronDown size={13} className="work-summary-group-caret" aria-hidden="true" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="work-summary-group-content">
        {sessions.map((session) => (
          <button key={session.id} type="button" className="work-summary-session" onClick={() => onOpenSession(session)}>
            <MessageSquare size={15} aria-hidden="true" />
            <strong title={session.title}>{session.title || t("Untitled conversation")}</strong>
            <span className={`work-summary-status status-${session.status}`}>{t(sessionStatusLabel(session.status))}</span>
          </button>
        ))}
        {workspace ? (
          <>
            {isCleanSummaryWorkspace(workspace) ? null : (
              <WorkSummaryChangeRow workspace={workspace} onOpen={onOpenChanges ? () => onOpenChanges(workspace.cwd) : undefined} />
            )}
            {workspace.binaryFiles ? <small className="work-summary-note">{t("{count} binary files", { count: workspace.binaryFiles })}</small> : null}
            {workspace.error && workspace.state === "ready" ? <small role="status" className="work-summary-note">{t("Workspace read failed; last available snapshot shown")}</small> : null}
            {workspace.commits.map((commit) => <WorkSummaryCommitRow key={commit.sha} commit={commit} />)}
          </>
        ) : <small className="work-summary-note">{t("Workspace unavailable")}</small>}
      </CollapsibleContent>
    </Collapsible>
  );
}

function sessionStatusLabel(status: WorkSummarySession["status"]): string {
  switch (status) {
    case "running": return "Running";
    case "waiting_for_approval": return "Waiting for approval";
    case "waiting_for_input": return "Waiting for input";
    case "blocked": return "Blocked";
    case "failed": return "Failed";
    case "succeeded": return "Completed";
    case "cancelled": return "Cancelled";
    case "archived": return "Archived";
    default: return "Ready";
  }
}
