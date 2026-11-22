import { useState, type ReactNode } from "react";
import { Button } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { CodeAssessmentPage } from "./CodeAssessmentPage.js";
import { WorkspaceVerificationPanel } from "./WorkspaceVerificationPanel.js";

export function CodeAssessmentDock({ cwd, threadId, changes, onOpenRun }: { readonly cwd?: string; readonly threadId?: string; readonly changes: ReactNode; readonly onOpenRun?: (runId: string) => void }): React.JSX.Element {
  const { t } = useI18n();
  const [view, setView] = useState<"changes" | "assessment" | "verification">("changes");
  return <div className="code-assessment-dock">
    <div className="code-assessment-tabs" role="group" aria-label={t("Review tools")}>
      <Button size="sm" variant="ghost" aria-pressed={view === "changes"} onClick={() => setView("changes")}>{t("Changed files")}</Button>
      <Button size="sm" variant="ghost" aria-pressed={view === "assessment"} onClick={() => setView("assessment")}>{t("Code review")}</Button>
      {cwd ? <Button size="sm" variant="ghost" aria-pressed={view === "verification"} onClick={() => setView("verification")}>{t("Verification")}</Button> : null}
    </div>
    {view === "changes" ? changes
      : !cwd ? <p>{t("Open a project to start an assessment.")}</p>
        : view === "verification" ? <WorkspaceVerificationPanel key={JSON.stringify([cwd, threadId])} cwd={cwd} threadId={threadId} />
          : <CodeAssessmentPage key={cwd} cwd={cwd} onOpenRun={onOpenRun} compact />}
  </div>;
}
