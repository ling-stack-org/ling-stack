import { Check, Loader2, MessageCircle, Pause, Play, Timer, Trash2 } from "lucide-react";
import { formatDateTime } from "../../lib/formatting.js";
import { StatusBadge } from "../../shared/components/index.js";
import type { AutomationDefinition, AutomationDraft, AutomationRun } from "../../types.js";
import type { AutomationTab, AutomationTabItem } from "./automation-view-models.js";

export function AutomationListPane({
  activeTab,
  tabs,
  automations,
  automationRuns,
  allAutomations,
  drafts,
  selectedAutomationId,
  selectedDraftId,
  mutatingAutomationId,
  mutatingDraftId,
  isLoading,
  threadTitleById,
  onTabChange,
  onSelectAutomation,
  onSelectDraft,
  onRun,
  onOpenRun,
  onToggle,
  onArchive,
  onOpenThread,
  onConfirmDraft,
  onDiscardDraft,
  t,
}: {
  readonly activeTab: AutomationTab;
  readonly tabs: readonly AutomationTabItem[];
  readonly automations: readonly AutomationDefinition[];
  readonly automationRuns: readonly AutomationRun[];
  readonly allAutomations: readonly AutomationDefinition[];
  readonly drafts: readonly AutomationDraft[];
  readonly selectedAutomationId: string;
  readonly selectedDraftId: string;
  readonly mutatingAutomationId: string;
  readonly mutatingDraftId: string;
  readonly isLoading: boolean;
  readonly threadTitleById: ReadonlyMap<string, string>;
  readonly onTabChange: (tab: AutomationTab) => void;
  readonly onSelectAutomation: (automationId: string) => void;
  readonly onSelectDraft: (draftId: string) => void;
  readonly onRun: (automationId: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onToggle: (automation: AutomationDefinition) => void;
  readonly onArchive: (automationId: string) => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly onConfirmDraft: (draftId: string) => void;
  readonly onDiscardDraft: (draftId: string) => void;
  readonly t: (value: string, values?: Readonly<Record<string, string | number>>) => string;
}): JSX.Element {
  return (
    <section className="automation-current-pane" aria-label={t("Enabled automations")}>
      <div className="automation-pane-tabs">
        <div className="automation-tab-list" role="tablist" aria-label={t("Automation status")}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={activeTab === tab.id ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => onTabChange(tab.id)}
            >
              {tab.label}
              <span>{tab.count}</span>
            </button>
          ))}
        </div>
      </div>

      {activeTab === "history" ? (
        <AutomationRunList runs={automationRuns} automations={allAutomations} onOpenRun={onOpenRun} t={t} />
      ) : (
        <AutomationDefinitionList
          emptyLabel={isLoading ? t("Loading automations...") : t("No automations yet")}
          automations={automations}
          automationRuns={automationRuns}
          selectedAutomationId={selectedAutomationId}
          mutatingAutomationId={mutatingAutomationId}
          threadTitleById={threadTitleById}
          onSelect={onSelectAutomation}
          onRun={onRun}
          onToggle={onToggle}
          onArchive={onArchive}
          onOpenThread={onOpenThread}
          t={t}
        />
      )}

      {drafts.length > 0 ? (
        <AutomationDraftList
          drafts={drafts}
          selectedDraftId={selectedDraftId}
          mutatingDraftId={mutatingDraftId}
          onSelectDraft={onSelectDraft}
          onConfirmDraft={onConfirmDraft}
          onDiscardDraft={onDiscardDraft}
          t={t}
        />
      ) : null}
    </section>
  );
}

function AutomationDefinitionList({
  automations,
  automationRuns,
  selectedAutomationId,
  mutatingAutomationId,
  emptyLabel,
  threadTitleById,
  onSelect,
  onRun,
  onToggle,
  onArchive,
  onOpenThread,
  t,
}: {
  readonly automations: readonly AutomationDefinition[];
  readonly automationRuns: readonly AutomationRun[];
  readonly selectedAutomationId: string;
  readonly mutatingAutomationId: string;
  readonly emptyLabel: string;
  readonly threadTitleById: ReadonlyMap<string, string>;
  readonly onSelect: (automationId: string) => void;
  readonly onRun: (automationId: string) => void;
  readonly onToggle: (automation: AutomationDefinition) => void;
  readonly onArchive: (automationId: string) => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly t: (value: string, values?: Readonly<Record<string, string | number>>) => string;
}): JSX.Element {
  if (automations.length === 0) {
    return (
      <div className="automation-inbox-empty">
        <Timer size={18} />
        <span className="automation-empty-copy">
          <strong>{emptyLabel}</strong>
          <small>{t("Start by choosing a template or creating one manually.")}</small>
        </span>
      </div>
    );
  }
  return (
    <div className="automation-inbox-list">
      {automations.map((automation) => {
        const latestRun = automationRuns.find((run) => run.automationId === automation.id);
        const busy = mutatingAutomationId === automation.id;
        const primaryActionLabel = automation.status === "paused" ? t("Resume") : t("Run now");
        const primaryActionDisabled = busy || (automation.status !== "enabled" && automation.status !== "paused");
        return (
          <div
            key={automation.id}
            className={automation.id === selectedAutomationId ? "automation-inbox-row selected" : "automation-inbox-row"}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(automation.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(automation.id);
              }
            }}
          >
            <span className="automation-row-dot" />
            <span className="automation-inbox-row-main">
              <strong>{automation.title}</strong>
              <small>{automationModeLabel(automation, t)} · {automationTargetSummary(automation, threadTitleById, t)} · {automationScheduleLabel(automation, t)}</small>
            </span>
            <span className="automation-row-actions">
              {latestRun ? <StatusBadge status={latestRun.status} /> : <StatusBadge status={automation.status} />}
              <button
                className="automation-row-primary-action"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  if (automation.status === "paused") {
                    onToggle(automation);
                    return;
                  }
                  onRun(automation.id);
                }}
                disabled={primaryActionDisabled}
                aria-label={primaryActionLabel}
                title={primaryActionLabel}
              >
                {busy ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                {primaryActionLabel}
              </button>
              {automation.status === "enabled" ? (
                <button
                  className="ghost-icon-button"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggle(automation);
                  }}
                  disabled={busy}
                  aria-label={t("Pause")}
                  title={t("Pause")}
                >
                  <Pause size={14} />
                </button>
              ) : null}
              <button
                className="ghost-icon-button"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenThread(automation.threadId);
                }}
                aria-label={t("Thread")}
                title={t("Thread")}
              >
                <MessageCircle size={14} />
              </button>
              <button
                className="ghost-icon-button danger"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onArchive(automation.id);
                }}
                disabled={busy}
                aria-label={t("Delete")}
                title={t("Delete")}
              >
                <Trash2 size={14} />
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function AutomationRunList({
  runs,
  automations,
  onOpenRun,
  t,
}: {
  readonly runs: readonly AutomationRun[];
  readonly automations: readonly AutomationDefinition[];
  readonly onOpenRun: (runId: string) => void;
  readonly t: (value: string, values?: Readonly<Record<string, string | number>>) => string;
}): JSX.Element {
  if (runs.length === 0) {
    return (
      <div className="automation-inbox-empty compact">
        <Play size={16} />
        <span>{t("No runs yet")}</span>
      </div>
    );
  }
  return (
    <div className="automation-inbox-list">
      {runs.map((run) => (
        <button
          key={run.id}
          className="automation-inbox-row history"
          type="button"
          onClick={() => run.runId ? onOpenRun(run.runId) : undefined}
        >
          <span className={`status-dot ${run.status}`} />
          <span className="automation-inbox-row-main">
            <strong>{automations.find((automation) => automation.id === run.automationId)?.title ?? run.automationId}</strong>
            <small>{automationRunTriggerLabel(run, t)} · {formatDateTime(run.firedAt)} · {t(run.status)}</small>
          </span>
          <span className="automation-row-schedule">{run.runId ? t("Open run") : t(run.status)}</span>
        </button>
      ))}
    </div>
  );
}

function AutomationDraftList({
  drafts,
  selectedDraftId,
  mutatingDraftId,
  onSelectDraft,
  onConfirmDraft,
  onDiscardDraft,
  t,
}: {
  readonly drafts: readonly AutomationDraft[];
  readonly selectedDraftId: string;
  readonly mutatingDraftId: string;
  readonly onSelectDraft: (draftId: string) => void;
  readonly onConfirmDraft: (draftId: string) => void;
  readonly onDiscardDraft: (draftId: string) => void;
  readonly t: (value: string, values?: Readonly<Record<string, string | number>>) => string;
}): JSX.Element {
  return (
    <section className="automation-draft-lite-list automation-secondary-section" aria-label={t("Draft review")}>
      <h2>{t("Draft review")}</h2>
      {drafts.map((draft) => {
        const busy = mutatingDraftId === draft.id;
        const ready = draft.status === "ready_for_confirmation";
        return (
          <div
            key={draft.id}
            className={draft.id === selectedDraftId ? "automation-inbox-row selected draft" : "automation-inbox-row draft"}
            role="button"
            tabIndex={0}
            onClick={() => onSelectDraft(draft.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectDraft(draft.id);
              }
            }}
          >
            <span className="automation-row-dot" />
            <span className="automation-inbox-row-main">
              <strong>{draft.title ?? t("Untitled draft")}</strong>
              <small>
                {automationDraftSourceLabel(draft.source, t)} · {draft.kind ? automationKindLabel(draft.kind, t) : t("Missing")} · {automationTriggerLabel(draft.trigger, t)}
              </small>
            </span>
            <span className="automation-row-actions">
              <StatusBadge status={draft.status} />
              <button
                className="ghost-icon-button"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onConfirmDraft(draft.id);
                }}
                disabled={busy || !ready}
                aria-label={t("Confirm automation")}
                title={t("Confirm automation")}
              >
                {busy ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
              </button>
              <button
                className="ghost-icon-button danger"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onDiscardDraft(draft.id);
                }}
                disabled={busy}
                aria-label={t("Discard draft")}
                title={t("Discard draft")}
              >
                <Trash2 size={14} />
              </button>
            </span>
          </div>
        );
      })}
    </section>
  );
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

function automationTargetSummary(
  automation: AutomationDefinition,
  threadTitleById: ReadonlyMap<string, string>,
  t: (value: string) => string,
): string {
  const threadId = sourceConversationId(automation);
  if (threadId) {
    return `${t("Source conversation")} · ${threadTitleById.get(threadId) ?? threadId}`;
  }
  if (automation.automationMode === "heartbeat") {
    return t("Conversation");
  }
  if (automation.target.channelId) {
    return `#${automation.target.channelId}`;
  }
  return t("Workspace");
}

function automationScheduleLabel(automation: AutomationDefinition, t: (value: string) => string): string {
  return automationTriggerLabel(automation.trigger, t, automation.rrule);
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

function automationTriggerLabel(
  trigger: AutomationDefinition["trigger"] | AutomationDraft["trigger"] | undefined,
  t: (value: string) => string,
  rrule?: string,
): string {
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

function automationKindLabel(kind: AutomationDefinition["kind"], t: (value: string) => string): string {
  return t(`automation.kind.${kind}`);
}
