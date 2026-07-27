import { useI18n } from "../../i18n.js";
import { InlineFeedback } from "../../shared/ui/index.js";
import { SettingsDiagnosticsErrorFeedback } from "./SettingsDiagnosticsErrorFeedback.js";
import type { StartupIssueViewModel } from "./startup-readiness-view-models.js";

export function StartupIssueList({
  errorMessage,
  hasSnapshot,
  issues,
}: {
  readonly errorMessage: string;
  readonly hasSnapshot: boolean;
  readonly issues: readonly StartupIssueViewModel[];
}): JSX.Element | null {
  const { t } = useI18n();
  const visibleIssues = issues.slice(0, 4);

  if (!errorMessage && visibleIssues.length === 0) return null;

  return (
    <div className="settings-startup-issues" aria-label={t("Startup issues")}>
      {errorMessage ? (
        <SettingsDiagnosticsErrorFeedback
          className="settings-startup-refresh-feedback"
          message={errorMessage}
          title={hasSnapshot ? t("Startup status may be out of date") : t("Startup status is unavailable")}
          tone={hasSnapshot ? "warning" : "danger"}
        />
      ) : null}
      {visibleIssues.map((issue) => (
        <InlineFeedback key={issue.key} title={issue.message} tone={issue.tone}>
          {issue.nextAction ? t("Next step: {action}", { action: issue.nextAction }) : undefined}
        </InlineFeedback>
      ))}
      {issues.length > visibleIssues.length ? (
        <span className="settings-startup-more-issues">
          {t("{count} more issues are available in technical details.", { count: issues.length - visibleIssues.length })}
        </span>
      ) : null}
    </div>
  );
}
