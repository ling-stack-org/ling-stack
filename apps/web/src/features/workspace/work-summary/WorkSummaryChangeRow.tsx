import { ChevronRight, FileDiff } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import type { WorkSummaryWorkspace } from "./work-summary.types.js";
import { isCleanSummaryWorkspace } from "./work-summary-model.js";

export function WorkSummaryChangeRow({ workspace, onOpen }: {
  readonly workspace: WorkSummaryWorkspace;
  readonly onOpen?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const clean = isCleanSummaryWorkspace(workspace);
  const canOpen = workspace.state === "ready" && !clean && Boolean(onOpen);
  const countsKnown = workspace.state === "ready" && !workspace.partial &&
    workspace.additions !== undefined && workspace.deletions !== undefined;
  const unavailableLabel = workspace.state === "not_repository"
    ? t("Not a Git repository")
    : workspace.partial ? t("Partial statistics") : t("Unavailable");

  const content = (
    <>
      <FileDiff size={15} aria-hidden="true" />
      <span className="work-summary-change-copy">
        {clean ? t("No changes") : countsKnown ? t("Uncommitted changes") : t("Changes")}
        {!clean && !workspace.partial && workspace.changedFiles !== undefined ? (
          <small>{workspace.changedFiles === 1 ? t("1 changed file") : t("{count} changed files", { count: workspace.changedFiles })}</small>
        ) : null}
      </span>
      {clean ? null : countsKnown ? (
        <span className="work-summary-stats">
          <span className="add">+{workspace.additions}</span><span className="delete">−{workspace.deletions}</span>
        </span>
      ) : <small className="work-summary-note">{unavailableLabel}</small>}
      {canOpen ? <ChevronRight size={13} aria-hidden="true" /> : null}
    </>
  );
  return canOpen
    ? <button type="button" className="work-summary-change" onClick={onOpen}>{content}</button>
    : <div className="work-summary-change">{content}</div>;
}
