import { Workflow } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { readDataField, readDataString } from "../../lib/data.js";
import { inferPermissionPreset, permissionPresetLabel, readPermissionPresetFromSnapshot, readSessionPermissionModeFromSnapshot, sessionPermissionModeLabel } from "../../lib/session-permissions.js";
import { readTaskTitle } from "../../lib/run-evidence.js";
import { MetaRow } from "../../shared/components/index.js";
import { Button, DataRow, InspectorSection, StatusIndicator } from "../../shared/ui/index.js";
import type { RunSession } from "../../types.js";
import { runDuration } from "./run-detail-view-models.js";
import { runStatusPresentation } from "./run-status-presentation.js";
import type { WorkHistoryTurnContext } from "./runs-thread-types.js";
import { SkillSourceRuntimeSection, skillSourceRuntimeSummary } from "./SkillSourceRuntimeSection.js";

export function RunOverviewSection({ run, turnContext, onSelectRun }: {
  readonly run: RunSession;
  readonly turnContext: WorkHistoryTurnContext | undefined;
  readonly onSelectRun: (runId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const permissionMode = readSessionPermissionModeFromSnapshot(run.requestSnapshot);
  const permissionPreset = readPermissionPresetFromSnapshot(run.requestSnapshot) ?? inferPermissionPreset(permissionMode);
  const skillSource = readDataField(run.requestSnapshot, "skillSourceContext");
  const skillLabel = readDataString(skillSource, "selectedSkillId") || run.selectedSkillId || "-";
  const permissionConfirmation = readDataField(run.requestSnapshot, "permissionConfirmation");
  const permissionConfirmationAt = readDataString(permissionConfirmation, "confirmedAt");
  const permissionConfirmationReason = readDataString(permissionConfirmation, "reason");
  const permissionConfirmationSummary = permissionConfirmationAt || permissionConfirmationReason
    ? t("Confirmed at {time}: {reason}", { time: permissionConfirmationAt ? formatDateTime(permissionConfirmationAt) : "-", reason: permissionConfirmationReason || "-" })
    : "";
  return (
    <InspectorSection open summary={readTaskTitle(run.taskSnapshot) || run.taskId} title={t("Summary")}>
      <div className="runs-summary-grid run-detail-summary">
        <MetaRow label={t("Provider")} value={`${run.providerName}/${run.providerModel}`} compact />
        <MetaRow label={t("Permission preset")} value={permissionPresetLabel(permissionPreset, t)} compact />
        <MetaRow label={t("Permission mode")} value={sessionPermissionModeLabel(permissionMode, t)} compact />
        {permissionConfirmationSummary ? <MetaRow label={t("Full access confirmation")} value={permissionConfirmationSummary} compact /> : null}
        <MetaRow label={t("Selected skill")} value={skillLabel} compact />
        <MetaRow label={t("Skill source")} value={skillSourceRuntimeSummary(skillSource, t)} compact />
        <MetaRow label={t("Created")} value={formatDateTime(run.createdAt)} compact />
        <MetaRow label={t("Updated")} value={formatDateTime(run.updatedAt)} compact />
        <MetaRow label={t("Ended")} value={run.endedAt ? formatDateTime(run.endedAt) : "-"} compact />
        <MetaRow label={t("Duration")} value={runDuration(run)} compact />
      </div>
      {skillSource ? <SkillSourceRuntimeSection context={skillSource} /> : null}
      {turnContext ? <section className="runs-subsection work-history-turn-context">
        <h3><Workflow size={15} />{t("Turn")} <small>{t("{count} attempts", { count: turnContext.group.attemptCount })}</small></h3>
        <div className="runs-summary-grid">
          <MetaRow label={t("Title")} value={turnContext.turn.title} compact />
          <MetaRow label={t("Status")} value={t(turnContext.turn.status)} compact />
          <MetaRow label={t("Kind")} value={turnContext.turn.kind} compact />
          <MetaRow label={t("Updated")} value={formatDateTime(turnContext.turn.updatedAt)} compact />
        </div>
        <div className="runs-section-list">
          {turnContext.group.attempts.map((attempt) => {
            const status = runStatusPresentation(attempt.run.status);
            return (
              <DataRow
                actions={<Button disabled={attempt.run.id === run.id} onClick={() => onSelectRun(attempt.run.id)} size="sm">{attempt.run.id === run.id ? t("Current run") : t("Open attempt")}</Button>}
                className="runs-detail-attempt-row"
                identity={<span><strong>{t("Attempt {number}", { number: attempt.attemptNumber })}</strong><small>{readTaskTitle(attempt.run.taskSnapshot) || attempt.run.taskId}</small></span>}
                key={attempt.run.id}
                status={<StatusIndicator label={t(status.labelKey)} tone={status.tone} />}
              />
            );
          })}
        </div>
      </section> : null}
    </InspectorSection>
  );
}
