import { FileDiff } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import type { WorkSummaryWorkspace } from "./work-summary.types.js";

export function WorkSummaryChangeRow({ workspace, onOpen }: { readonly workspace: WorkSummaryWorkspace; readonly onOpen: () => void }): React.JSX.Element {
  const { t } = useI18n();
  return <button type="button" className="work-summary-change" onClick={onOpen} disabled={workspace.state !== "ready"}>
    <FileDiff size={15} aria-hidden="true" /><span>{t("Changes")}{workspace.changedFiles !== undefined ? ` · ${workspace.changedFiles}` : ""}</span>
    {workspace.additions !== undefined && workspace.deletions !== undefined ? <span className="work-summary-stats"><span className="add">+{workspace.additions}</span><span className="delete">−{workspace.deletions}</span></span>
      : <small>{t(workspace.state === "not_repository" ? "Not a Git repository" : workspace.partial ? "Partial statistics" : "Unavailable")}</small>}
  </button>;
}
