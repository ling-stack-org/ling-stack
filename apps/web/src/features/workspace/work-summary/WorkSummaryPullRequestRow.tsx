import { GitPullRequest, Unlink } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import { IconButton } from "../../../shared/ui/index.js";
import type { WorkSummaryPullRequest } from "./work-summary.types.js";

export function WorkSummaryPullRequestRow({ pull, busy, onDetach }: { readonly pull: WorkSummaryPullRequest; readonly busy: boolean; readonly onDetach: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const stateLabel = { draft: "Draft", open: "Open", merged: "Merged", closed: "Closed", unknown: "Unknown" }[pull.state];
  const ciLabel = { success: "CI passed", failure: "CI failed", pending: "CI pending", unknown: "CI unknown" }[pull.ci];
  return <div className="work-summary-pr">
    <GitPullRequest size={15} aria-hidden="true" /><a href={pull.url} target="_blank" rel="noopener noreferrer"><strong>{pull.title || `${pull.repository} #${pull.number}`}</strong><small>{pull.repository} #{pull.number} · {t(stateLabel)} · {t(ciLabel)}</small>
      {pull.connection !== "connected" ? <small>{t(pull.connection === "unconnected" ? "GitHub not connected (GITHUB_TOKEN or GH_TOKEN)" : "GitHub unavailable; retry later")}</small> : null}</a>
    <IconButton icon={Unlink} label={t("Unlink pull request")} size="sm" disabled={busy} onClick={onDetach} />
  </div>;
}
