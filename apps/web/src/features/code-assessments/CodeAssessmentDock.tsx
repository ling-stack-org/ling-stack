import { useState, type ReactNode } from "react";
import { Button } from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import { CodeAssessmentPage } from "./CodeAssessmentPage.js";

export function CodeAssessmentDock({ cwd, changes, onOpenRun }: { readonly cwd?: string; readonly changes: ReactNode; readonly onOpenRun?: (runId: string) => void }): React.JSX.Element {
  const { t } = useI18n();
  const [view, setView] = useState<"changes" | "assessment">("changes");
  return <div className="code-assessment-dock">
    <div className="code-assessment-tabs" role="group" aria-label={t("Review tools")}>
      <Button size="sm" variant="ghost" aria-pressed={view === "changes"} onClick={() => setView("changes")}>{t("Changed files")}</Button>
      <Button size="sm" variant="ghost" aria-pressed={view === "assessment"} onClick={() => setView("assessment")}>{t("Code review")}</Button>
    </div>
    {view === "changes" ? changes : cwd ? <CodeAssessmentPage key={cwd} cwd={cwd} onOpenRun={onOpenRun} compact /> : <p>{t("Open a project to start an assessment.")}</p>}
  </div>;
}
