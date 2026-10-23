import { MessageSquare } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import type { WorkSummaryGroupModel, WorkSummarySession, WorkSummaryWorkspace } from "./work-summary.types.js";
import { WorkSummaryChangeRow } from "./WorkSummaryChangeRow.js";
import { WorkSummaryCommitRow } from "./WorkSummaryCommitRow.js";

export function WorkSummaryGroup({ group, onOpenSession, onOpenChanges }: { readonly group: WorkSummaryGroupModel; readonly onOpenSession: (session: WorkSummarySession) => void; readonly onOpenChanges: (workspace: WorkSummaryWorkspace) => void }): React.JSX.Element {
  const { t } = useI18n();
  return <section className="work-summary-group">
    {group.sessions.map((session) => <button key={session.id} type="button" className="work-summary-session" onClick={() => onOpenSession(session)}>
      <MessageSquare size={15} aria-hidden="true" /><strong>{session.title || t("Untitled conversation")}</strong><span className={`work-summary-status status-${session.status}`}>{t(sessionStatusLabel(session.status))}</span>
    </button>)}
    {group.workspace ? <div className="work-summary-workspace">
      <div className="work-summary-path" title={group.workspace.cwd}><span>{group.workspace.branch || t("Workspace")}</span><small>{group.workspace.cwd}</small></div>
      {group.sessions.length > 1 ? <small className="work-summary-note">{t("Shared by {count} sessions; counted once", { count: group.sessions.length })}</small> : null}
      <WorkSummaryChangeRow workspace={group.workspace} onOpen={() => onOpenChanges(group.workspace!)} />
      {group.workspace.binaryFiles ? <small className="work-summary-note">{t("{count} binary files", { count: group.workspace.binaryFiles })}</small> : null}
      {group.workspace.error ? <small role="status" className="work-summary-note">{t("Workspace read failed; last available snapshot shown")}</small> : null}
      {group.workspace.commits.map((commit) => <WorkSummaryCommitRow key={commit.sha} commit={commit} />)}
    </div> : <small className="work-summary-note">{t("Workspace unavailable")}</small>}
  </section>;
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
    default: return "Ready";
  }
}
