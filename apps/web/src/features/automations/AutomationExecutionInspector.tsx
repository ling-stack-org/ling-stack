import { Timer } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { StatusBadge } from "../../shared/components/index.js";
import type {
  AutomationContextPreview,
  AutomationDefinition,
  AutomationDraft,
  AutomationRun,
  AutomationTrigger,
  Channel,
} from "../../types.js";

export function AutomationExecutionInspector({
  automation,
  draft,
  latestRun,
  channels,
  threadTitleById,
  preview,
  onOpenRun,
  onOpenThread,
}: {
  readonly automation?: AutomationDefinition;
  readonly draft?: AutomationDraft;
  readonly latestRun?: AutomationRun;
  readonly channels: readonly Channel[];
  readonly threadTitleById: ReadonlyMap<string, string>;
  readonly preview?: AutomationContextPreview;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenThread: (threadId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const title = automation?.title ?? draft?.title ?? t("Execution details");
  const status = latestRun?.status ?? automation?.status ?? draft?.status;
  const output = inspectorOutputText(latestRun, preview, t);
  const rawOutput = inspectorRawOutputText(latestRun, preview);
  const latestRunFailed = latestRun?.status === "failed";
  const sourceThreadId = automation ? sourceConversationId(automation) : draft ? draftSourceConversationId(draft) : undefined;
  const sourceThreadLabel = sourceThreadId ? threadTitleById.get(sourceThreadId) ?? t("Conversation") : "--";
  const outputThreadId = automation?.threadId ?? latestRun?.threadId;
  return (
    <aside className="automation-history-lite automation-execution-inspector" aria-label={t("Execution details")}>
      <div className="automation-inspector-header">
        <h2>{t("Execution details")}</h2>
        {status ? <StatusBadge status={status} /> : null}
      </div>

      {automation || draft || latestRun ? (
        <>
          <div className="automation-inspector-title">
            <strong>{title}</strong>
            <span>{latestRun ? formatDateTime(latestRun.firedAt) : automation ? formatDateTime(automation.updatedAt) : draft ? formatDateTime(draft.updatedAt) : ""}</span>
          </div>

          <section className="automation-inspector-section">
            <h3>{t("Trigger details")}</h3>
            <div className="automation-inspector-grid">
              <span>{t("Trigger")}<strong>{automation ? automationTriggerLabel(automation.trigger, t, automation.rrule) : draft ? automationTriggerLabel(draft.trigger, t) : latestRun ? automationRunTriggerLabel(latestRun, t) : "--"}</strong></span>
              <span>{t("Target")}<strong>{automation ? targetLabel(automation, channels, t) : draft ? draftTargetLabel(draft, t) : "--"}</strong></span>
              <span>{t("Runtime")}<strong>{automation ? automationModeLabel(automation, t) : draft ? automationDraftSourceLabel(draft.source, t) : "--"}</strong></span>
              <span>{t("Source conversation")}<strong title={sourceThreadId}>{sourceThreadLabel}</strong></span>
              <span>{t("Automation output thread")}<strong title={outputThreadId}>{outputThreadId ? t("Automation thread") : "--"}</strong></span>
            </div>
          </section>

          <section className="automation-inspector-section">
            <h3>{latestRunFailed ? t("Failure details") : t("Output result")}</h3>
            <pre>{output}</pre>
            {rawOutput ? (
              <details className="settings-compact-details automation-raw-diagnostics">
                <summary>{t("Raw diagnostics")}</summary>
                <pre>{rawOutput}</pre>
              </details>
            ) : null}
          </section>

          <div className="automation-inspector-actions">
            {latestRun?.runId ? (
              <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(latestRun.runId as string)}>
                {latestRunFailed ? t("Inspect failure") : t("Open run")}
              </button>
            ) : null}
            {automation ? (
              <button className="secondary-button compact-button" type="button" onClick={() => onOpenThread(automation.threadId)}>
                {t("Thread")}
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <div className="automation-inspector-empty">
          <Timer size={18} />
          <strong>{t("No automation selected")}</strong>
          <span>{t("Select an automation to inspect trigger and output details.")}</span>
        </div>
      )}
    </aside>
  );
}

function inspectorOutputText(
  run: AutomationRun | undefined,
  preview: AutomationContextPreview | undefined,
  t: (value: string, values?: Readonly<Record<string, string | number>>) => string,
): string {
  if (run?.errorMessage) {
    return t("Recent run did not start. Check the trigger target, then retry this automation.");
  }
  if (run?.skipReason) {
    return t("This automation was skipped. Review the trigger conditions before retrying.");
  }
  if (run?.outputArtifactIds.length) {
    return t("{count} output artifact generated", { count: run.outputArtifactIds.length });
  }
  if (preview?.contextMarkdown) {
    return preview.contextMarkdown;
  }
  if (run) {
    return t("Automation run is {status}.", { status: t(run.status) });
  }
  return t("No output has been recorded yet.");
}

function inspectorRawOutputText(
  run: AutomationRun | undefined,
  preview: AutomationContextPreview | undefined,
): string {
  if (run?.errorMessage) {
    return run.errorMessage;
  }
  if (run?.skipReason) {
    return run.skipReason;
  }
  if (preview?.contextMarkdown) {
    return preview.contextMarkdown;
  }
  return "";
}

function automationModeLabel(automation: AutomationDefinition, t: (value: string) => string): string {
  if (automation.automationMode === "heartbeat") {
    return t("Automation heartbeat");
  }
  return automation.executionEnvironment === "worktree" ? t("Worktree") : t("Local");
}

function sourceConversationId(automation: AutomationDefinition): string | undefined {
  return automation.targetThreadId ?? (automation.target.scope === "thread" ? automation.target.threadId : undefined);
}

function draftSourceConversationId(draft: AutomationDraft): string | undefined {
  return draft.target?.scope === "thread" ? draft.target.threadId : draft.proposedByThreadId;
}

function automationRunTriggerLabel(run: AutomationRun, t: (value: string) => string): string {
  if (run.triggerType === "schedule") {
    return t("Scheduled run");
  }
  if (run.triggerType === "manual") {
    return t("Manual run");
  }
  if (run.triggerType === "monitor") {
    return t("Monitor run");
  }
  return t("Automation run");
}

function automationTriggerLabel(trigger: AutomationTrigger | undefined, t: (value: string) => string, rrule?: string): string {
  const rruleLabel = rrule ? rruleScheduleLabel(rrule, t) : undefined;
  if (rruleLabel) {
    return rruleLabel;
  }
  if (!trigger) {
    return t("Missing");
  }
  if (trigger.type !== "schedule") {
    return t("Manual");
  }
  if (trigger.schedule.cadence === "daily") {
    return `${t("Daily")} ${trigger.schedule.timeOfDay}`;
  }
  if (trigger.schedule.cadence === "weekly") {
    return `${weekdayLabel(trigger.schedule.weekday, t)} ${trigger.schedule.timeOfDay}`;
  }
  return `${t("Every")} ${Math.round(trigger.schedule.everyMs / 60000)} ${t("minutes")}`;
}

function rruleScheduleLabel(rrule: string, t: (value: string) => string): string | undefined {
  const fields = new Map<string, string>();
  for (const part of rrule.split(";")) {
    const [rawKey, ...rawValue] = part.split("=");
    const key = rawKey?.trim().toUpperCase();
    const value = rawValue.join("=").trim().toUpperCase();
    if (key && value) {
      fields.set(key, value);
    }
  }
  const freq = fields.get("FREQ");
  const hour = fields.get("BYHOUR")?.split(",")[0] ?? "";
  const minute = fields.get("BYMINUTE")?.split(",")[0] ?? "";
  const time = hour && minute ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` : "";
  const byDay = fields.get("BYDAY") ?? "";
  if (freq === "WEEKLY" && byDay === "MO,TU,WE,TH,FR") {
    return `${t("Workdays")}${time ? ` ${time}` : ""}`;
  }
  if (freq === "WEEKLY" && byDay) {
    const weekday = rruleWeekdayIndex(byDay.split(",")[0] ?? "");
    return `${weekdayLabel(weekday, t)}${time ? ` ${time}` : ""}`;
  }
  if (freq === "DAILY") {
    return `${t("Daily")}${time ? ` ${time}` : ""}`;
  }
  if (freq === "MINUTELY") {
    return `${t("Every")} ${fields.get("INTERVAL") ?? "1"} ${t("minutes")}`;
  }
  return undefined;
}

function rruleWeekdayIndex(day: string): number {
  const weekdays = new Map([
    ["SU", 0],
    ["MO", 1],
    ["TU", 2],
    ["WE", 3],
    ["TH", 4],
    ["FR", 5],
    ["SA", 6],
  ]);
  return weekdays.get(day.slice(-2).toUpperCase()) ?? 1;
}

function weekdayLabel(weekday: number, t: (value: string) => string): string {
  const labels = [t("Sunday"), t("Monday"), t("Tuesday"), t("Wednesday"), t("Thursday"), t("Friday"), t("Saturday")];
  return labels[weekday] ?? t("Monday");
}

function automationDraftSourceLabel(source: AutomationDraft["source"], t: (value: string) => string): string {
  return t(`automation.source.${source}`);
}

function targetLabel(automation: AutomationDefinition, channels: readonly Channel[], t: (value: string) => string): string {
  const channelId = automation.channelId ?? automation.target.channelId;
  const channel = channelId ? channels.find((item) => item.id === channelId) : undefined;
  if (channel) {
    return `#${channel.name}`;
  }
  if (automation.target.scope === "channel") {
    return t("Channel");
  }
  if (automation.target.scope === "thread") {
    return t("Conversation");
  }
  return t("Workspace");
}

function draftTargetLabel(draft: AutomationDraft, t: (value: string) => string): string {
  if (draft.target?.scope === "channel") {
    return t("Channel");
  }
  if (draft.target?.scope === "thread") {
    return t("Conversation");
  }
  if (draft.target?.scope === "workspace") {
    return t("Workspace");
  }
  return "--";
}
