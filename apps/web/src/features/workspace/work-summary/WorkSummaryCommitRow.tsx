import { GitCommitHorizontal } from "lucide-react";
import { useI18n } from "../../../i18n.js";
import type { WorkSummaryCommit } from "./work-summary.types.js";

export function WorkSummaryCommitRow({ commit }: { readonly commit: WorkSummaryCommit }): React.JSX.Element {
  const { t } = useI18n();
  return <div className="work-summary-commit" title={`${commit.sha}\n${commit.committedAt}`}>
    <GitCommitHorizontal size={15} aria-hidden="true" /><span>{commit.subject}</span><code>{commit.sha.slice(0, 7)}</code><small>{t("Local")}</small>
  </div>;
}
