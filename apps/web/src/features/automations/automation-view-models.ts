import type { StatusTone } from "../../shared/ui/index.js";
import type {
  AutomationDefinition,
  AutomationDraft,
  AutomationRun,
  AutomationSchedulerState,
  AutomationTarget,
  AutomationTrigger,
  Channel,
} from "../../types.js";

export type AutomationTab = "attention" | "enabled" | "history" | "paused";
export type AutomationPrimaryState =
  | "definition-error"
  | "paused"
  | "ready"
  | "recent-failure"
  | "running"
  | "scheduled"
  | "target-unavailable";
export type AutomationPrimaryAction = "fix-target" | "inspect-failure" | "resume" | "run" | "select";

export type AutomationTranslate = (
  value: string,
  values?: Readonly<Record<string, string | number>>,
) => string;

export interface AutomationTabItem {
  readonly id: AutomationTab;
  readonly label: string;
  readonly count: number;
}

export interface AutomationDefinitionViewModel {
  readonly automation: AutomationDefinition;
  readonly latestRun?: AutomationRun;
  readonly primaryAction: AutomationPrimaryAction;
  readonly primaryActionLabel: string;
  readonly primaryState: AutomationPrimaryState;
  readonly scheduleLabel: string;
  readonly searchableText: string;
  readonly statusLabel: string;
  readonly statusTone: StatusTone;
  readonly targetLabel: string;
  readonly targetUnavailable: boolean;
}

export interface AutomationDraftViewModel {
  readonly draft: AutomationDraft;
  readonly ready: boolean;
  readonly scheduleLabel: string;
  readonly searchableText: string;
  readonly statusLabel: string;
  readonly statusTone: StatusTone;
  readonly targetLabel: string;
}

export interface AutomationRunViewModel {
  readonly run: AutomationRun;
  readonly automationTitle: string;
  readonly statusLabel: string;
  readonly statusTone: StatusTone;
  readonly triggerLabel: string;
}

export interface AutomationPageSummary {
  readonly attentionCount: number;
  readonly enabledCount: number;
  readonly pausedCount: number;
  readonly recentRunCount: number;
  readonly scheduledCount: number;
  readonly totalCount: number;
}

export interface AutomationSchedulerViewModel {
  readonly action: "start" | "stop" | "";
  readonly actionLabel: string;
  readonly hasScheduledDefinitions: boolean;
  readonly nextRunAt?: string;
  readonly statusLabel: string;
  readonly statusTone: StatusTone;
  readonly summary: string;
}

export function latestRunByAutomationId(runs: readonly AutomationRun[]): ReadonlyMap<string, AutomationRun> {
  const map = new Map<string, AutomationRun>();
  for (const run of [...runs].sort((left, right) => right.firedAt.localeCompare(left.firedAt))) {
    if (!map.has(run.automationId)) map.set(run.automationId, run);
  }
  return map;
}

export function buildAutomationDefinitionViewModel(input: {
  readonly automation: AutomationDefinition;
  readonly channels: readonly Channel[];
  readonly latestRun?: AutomationRun;
  readonly threadTitleById: ReadonlyMap<string, string>;
  readonly t: AutomationTranslate;
}): AutomationDefinitionViewModel {
  const { automation, channels, latestRun, t, threadTitleById } = input;
  const target = automationTargetView(automation.target, automation, channels, threadTitleById, t);
  const primaryState = derivePrimaryState(automation, latestRun, target.unavailable);
  const primaryAction = derivePrimaryAction(primaryState, latestRun);
  const scheduleLabel = automationScheduleLabel(automation.trigger, t, automation.rrule);
  const stateCopy = primaryStateCopy(primaryState, t);
  return {
    automation,
    latestRun,
    primaryAction,
    primaryActionLabel: primaryActionCopy(primaryAction, t),
    primaryState,
    scheduleLabel,
    searchableText: normalizeSearchText([
      automation.title,
      automation.description,
      target.label,
      scheduleLabel,
      automation.model,
    ]),
    statusLabel: stateCopy.label,
    statusTone: stateCopy.tone,
    targetLabel: target.label,
    targetUnavailable: target.unavailable,
  };
}

export function buildAutomationDraftViewModel(input: {
  readonly draft: AutomationDraft;
  readonly channels: readonly Channel[];
  readonly threadTitleById: ReadonlyMap<string, string>;
  readonly t: AutomationTranslate;
}): AutomationDraftViewModel {
  const { channels, draft, t, threadTitleById } = input;
  const target = draft.target
    ? automationTargetView(draft.target, undefined, channels, threadTitleById, t)
    : { label: t("Missing"), unavailable: true };
  const ready = draft.status === "ready_for_confirmation";
  const invalid = draft.status === "needs_user_input" || draft.missingFields.length > 0;
  const statusLabel = ready ? t("Draft ready") : invalid ? t("Setup needs attention") : t("Manual draft");
  const scheduleLabel = automationScheduleLabel(draft.trigger, t);
  return {
    draft,
    ready,
    scheduleLabel,
    searchableText: normalizeSearchText([draft.title, draft.description, target.label, scheduleLabel]),
    statusLabel,
    statusTone: ready ? "success" : invalid ? "warning" : "neutral",
    targetLabel: target.label,
  };
}

export function buildAutomationRunViewModel(input: {
  readonly run: AutomationRun;
  readonly automationById: ReadonlyMap<string, AutomationDefinition>;
  readonly t: AutomationTranslate;
}): AutomationRunViewModel {
  const { automationById, run, t } = input;
  return {
    run,
    automationTitle: automationById.get(run.automationId)?.title ?? run.automationId,
    statusLabel: t(run.status),
    statusTone: runTone(run.status),
    triggerLabel: automationRunTriggerLabel(run, t),
  };
}

export function buildAutomationTabs(input: {
  readonly definitions: readonly AutomationDefinitionViewModel[];
  readonly drafts: readonly AutomationDraftViewModel[];
  readonly recentRuns: readonly AutomationRun[];
  readonly t: AutomationTranslate;
}): readonly AutomationTabItem[] {
  const attentionDefinitions = input.definitions.filter(isAttentionDefinition);
  const attentionDrafts = input.drafts.filter((draft) => draft.draft.status !== "confirmed" && draft.draft.status !== "discarded");
  return [
    { id: "enabled", label: input.t("Enabled automations"), count: input.definitions.filter((item) => item.automation.status === "enabled").length },
    { id: "paused", label: input.t("Paused"), count: input.definitions.filter((item) => item.automation.status === "paused" || item.automation.status === "disabled").length },
    { id: "attention", label: input.t("Needs attention"), count: attentionDefinitions.length + attentionDrafts.length },
    { id: "history", label: input.t("Recent history"), count: input.recentRuns.length },
  ];
}

export function definitionsForTab(
  definitions: readonly AutomationDefinitionViewModel[],
  tab: AutomationTab,
): readonly AutomationDefinitionViewModel[] {
  if (tab === "paused") return definitions.filter((item) => item.automation.status === "paused" || item.automation.status === "disabled");
  if (tab === "attention") return definitions.filter(isAttentionDefinition);
  if (tab === "history") return [];
  return definitions.filter((item) => item.automation.status === "enabled");
}

export function matchesAutomationSearch(searchableText: string, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return !normalizedQuery || searchableText.includes(normalizedQuery);
}

export function summarizeAutomationsPage(input: {
  readonly definitions: readonly AutomationDefinitionViewModel[];
  readonly drafts: readonly AutomationDraftViewModel[];
  readonly recentRuns: readonly AutomationRun[];
}): AutomationPageSummary {
  const active = input.definitions.filter((item) => item.automation.status !== "archived");
  return {
    attentionCount: active.filter(isAttentionDefinition).length + input.drafts.filter((draft) => draft.draft.status !== "confirmed" && draft.draft.status !== "discarded").length,
    enabledCount: active.filter((item) => item.automation.status === "enabled").length,
    pausedCount: active.filter((item) => item.automation.status === "paused" || item.automation.status === "disabled").length,
    recentRunCount: input.recentRuns.length,
    scheduledCount: active.filter((item) => item.automation.status === "enabled" && isScheduledTrigger(item.automation.trigger, item.automation.rrule)).length,
    totalCount: active.length,
  };
}

export function buildSchedulerViewModel(input: {
  readonly scheduler?: AutomationSchedulerState;
  readonly scheduledCount: number;
  readonly t: AutomationTranslate;
}): AutomationSchedulerViewModel {
  const { scheduler, scheduledCount, t } = input;
  const hasScheduledDefinitions = scheduledCount > 0;
  if (scheduler?.status === "error") {
    return {
      action: hasScheduledDefinitions ? "start" : "",
      actionLabel: t("Start scheduler"),
      hasScheduledDefinitions,
      nextRunAt: scheduler.nextRunAt,
      statusLabel: t("Scheduler needs attention"),
      statusTone: "danger",
      summary: t("Scheduler needs attention: {message}", { message: scheduler.lastErrorMessage || t("Unknown error") }),
    };
  }
  if (scheduler?.status === "running") {
    return {
      action: hasScheduledDefinitions ? "stop" : "",
      actionLabel: t("Stop scheduler"),
      hasScheduledDefinitions,
      nextRunAt: scheduler.nextRunAt,
      statusLabel: t("Scheduler started"),
      statusTone: "success",
      summary: hasScheduledDefinitions
        ? t("Watching {count} scheduled automations.", { count: scheduledCount })
        : t("No enabled scheduled automations yet."),
    };
  }
  return {
    action: hasScheduledDefinitions ? "start" : "",
    actionLabel: t("Start scheduler"),
    hasScheduledDefinitions,
    nextRunAt: scheduler?.nextRunAt,
    statusLabel: t("Scheduler stopped"),
    statusTone: hasScheduledDefinitions ? "warning" : "neutral",
    summary: hasScheduledDefinitions
      ? t("{count} scheduled automations are ready. Start scheduler to run them automatically.", { count: scheduledCount })
      : t("No enabled scheduled automations yet. Create or edit one with a schedule."),
  };
}

export function automationScheduleLabel(trigger: AutomationTrigger | undefined, t: AutomationTranslate, rrule?: string): string {
  const parsedRrule = rrule ? rruleScheduleLabel(rrule, t) : undefined;
  if (parsedRrule) return parsedRrule;
  if (!trigger) return t("Missing");
  if (trigger.type === "manual") return t("Manual");
  if (trigger.type === "monitor") return t("Monitor run");
  if (trigger.schedule.cadence === "daily") return `${t("Daily")} ${trigger.schedule.timeOfDay}`;
  if (trigger.schedule.cadence === "weekly") return `${weekdayLabel(trigger.schedule.weekday, t)} ${trigger.schedule.timeOfDay}`;
  return `${t("Every")} ${Math.max(1, Math.round(trigger.schedule.everyMs / 60_000))} ${t("minutes")}`;
}

export function automationTargetLabel(input: {
  readonly automation?: AutomationDefinition;
  readonly channels: readonly Channel[];
  readonly target?: AutomationTarget;
  readonly threadTitleById: ReadonlyMap<string, string>;
  readonly t: AutomationTranslate;
}): string {
  return input.target
    ? automationTargetView(input.target, input.automation, input.channels, input.threadTitleById, input.t).label
    : input.t("Missing");
}

function derivePrimaryState(automation: AutomationDefinition, latestRun: AutomationRun | undefined, targetUnavailable: boolean): AutomationPrimaryState {
  if (targetUnavailable) return "target-unavailable";
  if (latestRun?.status === "failed") return "recent-failure";
  if (automation.status === "error" || automation.lastErrorMessage) return "definition-error";
  if (automation.status === "paused" || automation.status === "disabled") return "paused";
  if (latestRun && isRunInProgress(latestRun)) return "running";
  if (isScheduledTrigger(automation.trigger, automation.rrule)) return "scheduled";
  return "ready";
}

function derivePrimaryAction(state: AutomationPrimaryState, latestRun?: AutomationRun): AutomationPrimaryAction {
  if (state === "target-unavailable") return "fix-target";
  if (state === "recent-failure" && latestRun?.runId) return "inspect-failure";
  if (state === "paused") return "resume";
  if (state === "running") return "select";
  if (state === "definition-error") return "select";
  return "run";
}

function primaryStateCopy(state: AutomationPrimaryState, t: AutomationTranslate): { readonly label: string; readonly tone: StatusTone } {
  if (state === "target-unavailable") return { label: t("Unavailable"), tone: "warning" };
  if (state === "recent-failure") return { label: t("Recent run failed"), tone: "danger" };
  if (state === "definition-error") return { label: t("Setup needs attention"), tone: "danger" };
  if (state === "paused") return { label: t("Paused"), tone: "neutral" };
  if (state === "running") return { label: t("Running"), tone: "info" };
  if (state === "scheduled") return { label: t("Schedule"), tone: "success" };
  return { label: t("Ready"), tone: "success" };
}

function primaryActionCopy(action: AutomationPrimaryAction, t: AutomationTranslate): string {
  if (action === "fix-target") return t("Target");
  if (action === "inspect-failure") return t("Inspect failure");
  if (action === "resume") return t("Resume");
  if (action === "run") return t("Run now");
  return t("Execution details");
}

function automationTargetView(
  target: AutomationTarget,
  automation: AutomationDefinition | undefined,
  channels: readonly Channel[],
  threadTitleById: ReadonlyMap<string, string>,
  t: AutomationTranslate,
): { readonly label: string; readonly unavailable: boolean } {
  if (target.scope === "channel") {
    const channelId = target.channelId ?? automation?.channelId;
    const channel = channelId ? channels.find((item) => item.id === channelId) : undefined;
    return channel && channel.status !== "archived"
      ? { label: `#${channel.name}`, unavailable: false }
      : { label: t("Unavailable"), unavailable: true };
  }
  if (target.scope === "thread") {
    const threadId = target.threadId ?? automation?.targetThreadId;
    if (!threadId) return { label: t("Unavailable"), unavailable: true };
    return { label: threadTitleById.get(threadId) ?? t("Conversation"), unavailable: false };
  }
  if (target.scope === "workspace") return { label: t("Current workspace"), unavailable: false };
  return { label: t("Target"), unavailable: false };
}

function isAttentionDefinition(item: AutomationDefinitionViewModel): boolean {
  return item.primaryState === "target-unavailable" || item.primaryState === "recent-failure" || item.primaryState === "definition-error";
}

function isScheduledTrigger(trigger: AutomationTrigger, rrule?: string): boolean {
  return trigger.type === "schedule" || Boolean(rrule);
}

function isRunInProgress(run: AutomationRun): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting_for_approval";
}

function runTone(status: AutomationRun["status"]): StatusTone {
  if (status === "failed") return "danger";
  if (status === "succeeded") return "success";
  if (status === "queued" || status === "running" || status === "waiting_for_approval") return "info";
  if (status === "skipped") return "warning";
  return "neutral";
}

function automationRunTriggerLabel(run: AutomationRun, t: AutomationTranslate): string {
  if (run.triggerType === "schedule") return t("Scheduled run");
  if (run.triggerType === "manual") return t("Manual run");
  if (run.triggerType === "monitor") return t("Monitor run");
  return t("Automation run");
}

function rruleScheduleLabel(rrule: string, t: AutomationTranslate): string | undefined {
  const fields = new Map<string, string>();
  for (const part of rrule.split(";")) {
    const [key, ...value] = part.split("=");
    if (key && value.length) fields.set(key.trim().toUpperCase(), value.join("=").trim().toUpperCase());
  }
  const frequency = fields.get("FREQ");
  const interval = fields.get("INTERVAL") ?? "1";
  const hour = fields.get("BYHOUR")?.split(",")[0];
  const minute = fields.get("BYMINUTE")?.split(",")[0];
  const time = hour && minute ? `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}` : "";
  const day = fields.get("BYDAY") ?? "";
  if (frequency === "WEEKLY" && day === "MO,TU,WE,TH,FR") return `${t("Workdays")}${time ? ` ${time}` : ""}`;
  if (frequency === "WEEKLY" && day) return `${weekdayLabel(rruleWeekdayIndex(day), t)}${time ? ` ${time}` : ""}`;
  if (frequency === "DAILY") return `${t("Daily")}${time ? ` ${time}` : ""}`;
  if (frequency === "MINUTELY") return `${t("Every")} ${interval} ${t("minutes")}`;
  return undefined;
}

function rruleWeekdayIndex(day: string): number {
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"].indexOf(day.split(",")[0]?.slice(-2).toUpperCase() ?? "MO");
}

function weekdayLabel(weekday: number, t: AutomationTranslate): string {
  return [t("Sunday"), t("Monday"), t("Tuesday"), t("Wednesday"), t("Thursday"), t("Friday"), t("Saturday")][weekday] ?? t("Monday");
}

function normalizeSearchText(values: readonly (string | undefined)[]): string {
  return values.filter(Boolean).join(" ").toLocaleLowerCase();
}
