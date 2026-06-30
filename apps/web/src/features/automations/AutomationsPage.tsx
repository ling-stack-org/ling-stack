import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Bot,
  Box,
  Brain,
  CalendarClock,
  Check,
  ChevronDown,
  ClipboardList,
  Folder,
  GitBranch,
  Info,
  Laptop,
  Layers,
  Loader2,
  MessageCircle,
  MessageSquare,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { listLingThreads } from "../../api.js";
import { useI18n } from "../../i18n.js";
import type {
  AutomationContextPreview,
  AutomationDefinition,
  AutomationDraft,
  AutomationExecutionEnvironment,
  AutomationMode,
  AutomationOutputDestination,
  AutomationOutputPolicy,
  AutomationPromptTemplate,
  AutomationReasoningEffort,
  AutomationRun,
  AutomationStatus,
  AutomationTarget,
  AutomationTrigger,
  BuiltinAutomationTemplate,
  BuiltinAutomationTemplateId,
  Channel,
  CreateAutomationRequest,
  LingThread,
  ProviderPreset,
} from "../../types.js";
import { AutomationExecutionInspector } from "./AutomationExecutionInspector.js";
import { AutomationListPane } from "./AutomationListPane.js";
import {
  activeAutomations as deriveActiveAutomations,
  failedAutomations as deriveFailedAutomations,
  latestRunByAutomationId,
  pausedAutomations as derivePausedAutomations,
  succeededAutomations as deriveSucceededAutomations,
  visibleAutomationsForTab,
  type AutomationTab,
  type AutomationTabItem,
} from "./automation-view-models.js";

const DEFAULT_WORKSPACE_ID = "workspace_default";

type CreateDialog = "" | "templates" | "manual" | "chat";
type CreateMode = Exclude<CreateDialog, "">;
type RuntimeChoice = AutomationExecutionEnvironment | "thread";
type ScheduleChoice = "daily" | "workdays" | "weekly" | "custom";

interface AutomationTemplatePreset {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly prompt: string;
  readonly schedule: ScheduleChoice;
  readonly runtime: RuntimeChoice;
}

export function AutomationsPage({
  cwd,
  channels,
  providers,
  automations,
  automationRuns,
  automationDrafts,
  templates,
  selectedAutomationId,
  selectedDraftId,
  previewByAutomationId,
  draftPreviewById,
  isLoading,
  mutatingAutomationId,
  mutatingDraftId,
  onRefresh,
  onCreateFromTemplate,
  onCreateManualDraft,
  onCreateAutomation,
  onCreateChatDraft,
  onSelectAutomation,
  onSelectDraft,
  onUpdateDraft,
  onPreviewDraft,
  onConfirmDraft,
  onDiscardDraft,
  onPreview,
  onRun,
  onArchive,
  onSetStatus,
  onSetSchedule,
  onOpenRun,
  onOpenThread,
}: {
  readonly cwd: string;
  readonly channels: readonly Channel[];
  readonly providers: readonly ProviderPreset[];
  readonly automations: readonly AutomationDefinition[];
  readonly automationRuns: readonly AutomationRun[];
  readonly automationDrafts: readonly AutomationDraft[];
  readonly templates: readonly BuiltinAutomationTemplate[];
  readonly selectedAutomationId: string;
  readonly selectedDraftId: string;
  readonly previewByAutomationId: Readonly<Record<string, AutomationContextPreview>>;
  readonly draftPreviewById: Readonly<Record<string, AutomationContextPreview>>;
  readonly isLoading: boolean;
  readonly mutatingAutomationId: string;
  readonly mutatingDraftId: string;
  readonly onRefresh: () => void;
  readonly onCreateFromTemplate: (templateId: BuiltinAutomationTemplateId) => Promise<void>;
  readonly onCreateManualDraft: (partialAutomation: Partial<CreateAutomationRequest>) => Promise<void>;
  readonly onCreateAutomation: (automation: CreateAutomationRequest) => Promise<void>;
  readonly onCreateChatDraft: (prompt: string) => Promise<void>;
  readonly onSelectAutomation: (automationId: string) => void;
  readonly onSelectDraft: (draftId: string) => void;
  readonly onUpdateDraft: (draftId: string, partialAutomation: Partial<CreateAutomationRequest>) => Promise<void>;
  readonly onPreviewDraft: (draftId: string) => Promise<void>;
  readonly onConfirmDraft: (draftId: string) => Promise<void>;
  readonly onDiscardDraft: (draftId: string) => Promise<void>;
  readonly onPreview: () => void;
  readonly onRun: () => void;
  readonly onArchive: () => void;
  readonly onSetStatus: (status: AutomationStatus) => void;
  readonly onSetSchedule: (trigger: AutomationTrigger) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenThread: (threadId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<CreateDialog>("");
  const [automationTab, setAutomationTab] = useState<AutomationTab>("enabled");
  const [manualPreset, setManualPreset] = useState<AutomationTemplatePreset | undefined>(undefined);
  const [threads, setThreads] = useState<readonly LingThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const activeAutomations = useMemo(
    () => deriveActiveAutomations(automations),
    [automations],
  );
  const pausedAutomations = useMemo(
    () => derivePausedAutomations(automations),
    [automations],
  );
  const recentRuns = automationRuns.slice(0, 8);
  const runningRunCount = automationRuns.filter((run) => run.status === "running" || run.status === "queued" || run.status === "waiting_for_approval").length;
  const recentFailedRunCount = recentRuns.filter((run) => run.status === "failed").length;
  const readyDraftCount = automationDrafts.filter((draft) => draft.status === "ready_for_confirmation").length;
  const latestRunById = useMemo(() => latestRunByAutomationId(automationRuns), [automationRuns]);
  const failedAutomations = useMemo(
    () => deriveFailedAutomations(automations, latestRunById),
    [automations, latestRunById],
  );
  const succeededAutomations = useMemo(
    () => deriveSucceededAutomations(automations, latestRunById),
    [automations, latestRunById],
  );
  const visibleAutomations = visibleAutomationsForTab({
    tab: automationTab,
    enabled: activeAutomations,
    paused: pausedAutomations,
    failed: failedAutomations,
    succeeded: succeededAutomations,
  });
  const automationTabs: readonly AutomationTabItem[] = [
    { id: "enabled", label: t("Enabled automations"), count: activeAutomations.length },
    { id: "paused", label: t("Paused"), count: pausedAutomations.length },
    { id: "failed", label: t("Failed"), count: failedAutomations.length },
    { id: "succeeded", label: t("Succeeded"), count: succeededAutomations.length },
    { id: "history", label: t("Recent history"), count: recentRuns.length },
  ];
  const selectedAutomation = automations.find((automation) => automation.id === selectedAutomationId);
  const selectedDraft = automationDrafts.find((draft) => draft.id === selectedDraftId);
  const selectedRun = selectedAutomation ? latestRunById.get(selectedAutomation.id) : recentRuns[0];
  const threadTitleById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread.title])), [threads]);

  useEffect(() => {
    if (!cwd.trim()) {
      setThreads([]);
      return;
    }
    let cancelled = false;
    setThreadsLoading(true);
    void listLingThreads(cwd, { limit: 80 })
      .then((response) => {
        if (!cancelled) {
          setThreads(response.threads.filter((thread) => thread.status !== "archived" && !thread.archivedAt));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThreads([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setThreadsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  useEffect(() => {
    if (!dialog) {
      return undefined;
    }
    const previousBodyOverflow = document.body.style.overflow;
    const previousDocumentOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousDocumentOverflow;
    };
  }, [dialog]);

  function openCreateDialog(mode: CreateMode): void {
    setDialog(mode === "manual" ? "manual" : mode === "templates" ? "templates" : "chat");
  }

  async function createManualAutomation(automation: CreateAutomationRequest): Promise<void> {
    await onCreateAutomation(automation);
    setDialog("");
  }

  async function createChatDraft(prompt: string): Promise<void> {
    await onCreateChatDraft(prompt);
    setDialog("");
  }

  function mutateSelectedAutomation(automationId: string, action: () => void): void {
    onSelectDraft("");
    onSelectAutomation(automationId);
    window.setTimeout(action, 0);
  }

  return (
    <div className="automations-inbox-page">
      <header className="automations-inbox-header">
        <div>
          <h1>{t("Automations")}</h1>
          <p>
            {t("{count} automations · {running} running · {attention} need attention", {
              count: activeAutomations.length + pausedAutomations.length,
              running: runningRunCount,
              attention: readyDraftCount + recentFailedRunCount,
            })}
          </p>
        </div>
        <div className="automation-header-actions">
          <button className="secondary-button compact-button automation-refresh-button" type="button" onClick={onRefresh} disabled={isLoading} aria-label={t("Refresh")}>
            {isLoading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          </button>
          <div className="automation-create-actions header-actions" aria-label={t("Create automation")}>
            <button className="automation-create-trigger" type="button" onClick={() => openCreateDialog("templates")} disabled={isLoading}>
              <Layers size={15} />
              {t("Use template")}
            </button>
            <button className="secondary-button compact-button automation-create-secondary" type="button" onClick={() => openCreateDialog("manual")} disabled={isLoading}>
              <CalendarClock size={15} />
              {t("Manual create")}
            </button>
            <button className="secondary-button compact-button automation-create-secondary" type="button" onClick={() => openCreateDialog("chat")} disabled={isLoading}>
              <MessageSquare size={15} />
              {t("Create from conversation")}
            </button>
          </div>
        </div>
      </header>

      <main className="automations-inbox-main" aria-labelledby="automations-title">
        {readyDraftCount + recentFailedRunCount > 0 ? (
          <div className="automation-attention-banner">
            <Info size={17} />
            <strong>{t("{count} automation needs attention", { count: readyDraftCount + recentFailedRunCount })}</strong>
            <span>{readyDraftCount > 0 ? t("Review drafts before enabling.") : t("Check recent failed runs.")}</span>
          </div>
        ) : null}
        <AutomationListPane
          activeTab={automationTab}
          tabs={automationTabs}
          automations={visibleAutomations}
          automationRuns={automationTab === "history" ? recentRuns : automationRuns}
          allAutomations={automations}
          drafts={automationDrafts}
          selectedAutomationId={selectedAutomationId}
          selectedDraftId={selectedDraftId}
          mutatingAutomationId={mutatingAutomationId}
          mutatingDraftId={mutatingDraftId}
          isLoading={isLoading}
          threadTitleById={threadTitleById}
          onTabChange={setAutomationTab}
          onSelectAutomation={(automationId) => {
            onSelectDraft("");
            onSelectAutomation(automationId);
          }}
          onSelectDraft={onSelectDraft}
          onRun={(automationId) => mutateSelectedAutomation(automationId, onRun)}
          onOpenRun={onOpenRun}
          onToggle={(automation) => mutateSelectedAutomation(automation.id, () => onSetStatus(automation.status === "enabled" ? "paused" : "enabled"))}
          onArchive={(automationId) => mutateSelectedAutomation(automationId, onArchive)}
          onOpenThread={onOpenThread}
          onConfirmDraft={(draftId) => void onConfirmDraft(draftId)}
          onDiscardDraft={(draftId) => void onDiscardDraft(draftId)}
          t={t}
        />

        <AutomationExecutionInspector
          automation={selectedAutomation}
          draft={selectedDraft}
          latestRun={selectedRun}
          channels={channels}
          threadTitleById={threadTitleById}
          preview={selectedAutomation ? previewByAutomationId[selectedAutomation.id] : selectedDraft ? draftPreviewById[selectedDraft.id] : undefined}
          onOpenRun={onOpenRun}
          onOpenThread={onOpenThread}
        />
      </main>

      {dialog === "templates" ? (
        <AutomationTemplateModal
          templates={templates}
          onApply={(preset) => {
            setManualPreset(preset);
            setDialog("manual");
          }}
          onManual={() => setDialog("manual")}
          onClose={() => setDialog("")}
        />
      ) : null}
      {dialog === "manual" ? (
        <AutomationManualSetupModal
          cwd={cwd}
          channels={channels}
          providers={providers}
          threads={threads}
          threadsLoading={threadsLoading}
          preset={manualPreset}
          onUseTemplate={() => setDialog("templates")}
          onCreate={createManualAutomation}
          onClose={() => setDialog("")}
        />
      ) : null}
      {dialog === "chat" ? (
        <AutomationChatCreateModal
          onUseTemplate={() => setDialog("templates")}
          onCreate={createChatDraft}
          onClose={() => setDialog("")}
        />
      ) : null}
    </div>
  );
}

function AutomationTemplateModal({
  templates,
  onApply,
  onManual,
  onClose,
}: {
  readonly templates: readonly BuiltinAutomationTemplate[];
  readonly onApply: (preset: AutomationTemplatePreset) => void;
  readonly onManual: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <AutomationModal title={t("Automation templates")} icon={<Layers size={18} />} actionLabel={t("Manual setup")} onAction={onManual} onClose={onClose}>
      <div className="automation-template-grid modal-grid" aria-label={t("Automation templates")}>
        {buildTemplatePresets(templates).map((template) => (
          <button
            key={template.id}
            className="automation-template-card"
            type="button"
            onClick={() => onApply({ ...template, title: t(template.title), description: t(template.description) })}
          >
            {templateIcon(template.id)}
            <strong>{t(template.title)}</strong>
            <span>{t(template.description)}</span>
            <small>{schedulePresetLabel(template.schedule, t)} · {runtimeChoiceLabel(template.runtime, t)}</small>
          </button>
        ))}
      </div>
    </AutomationModal>
  );
}

function AutomationManualSetupModal({
  cwd,
  channels,
  providers,
  threads,
  threadsLoading,
  preset,
  onUseTemplate,
  onCreate,
  onClose,
}: {
  readonly cwd: string;
  readonly channels: readonly Channel[];
  readonly providers: readonly ProviderPreset[];
  readonly threads: readonly LingThread[];
  readonly threadsLoading: boolean;
  readonly preset?: AutomationTemplatePreset;
  readonly onUseTemplate: () => void;
  readonly onCreate: (automation: CreateAutomationRequest) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [title, setTitle] = useState(preset?.title ?? "");
  const [prompt, setPrompt] = useState(preset?.prompt ?? "");
  const [runtime, setRuntime] = useState<RuntimeChoice>(preset?.runtime ?? "worktree");
  const [targetId, setTargetId] = useState(channels[0]?.id ? `channel:${channels[0].id}` : "workspace");
  const [threadId, setThreadId] = useState(threads[0]?.id ?? "");
  const [scheduleMode, setScheduleMode] = useState<ScheduleChoice>(preset?.schedule ?? "daily");
  const [timeOfDay, setTimeOfDay] = useState("09:00");
  const [weekday, setWeekday] = useState("1");
  const [customRRule, setCustomRRule] = useState("FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0");
  const [providerPresetId, setProviderPresetId] = useState(providers.find((provider) => provider.enabled && provider.capabilities.includes("chat"))?.id ?? providers[0]?.id ?? "");
  const [reasoningEffort, setReasoningEffort] = useState<AutomationReasoningEffort>("medium");
  const [activePopover, setActivePopover] = useState<"" | "runtime" | "target" | "schedule" | "model" | "reasoning">("");

  useEffect(() => {
    if (!preset) {
      return;
    }
    setTitle(preset.title);
    setPrompt(preset.prompt);
    setRuntime(preset.runtime);
    setScheduleMode(preset.schedule);
  }, [preset]);

  useEffect(() => {
    if (!threadId && threads[0]) {
      setThreadId(threads[0].id);
    }
  }, [threadId, threads]);

  const selectedProvider = providers.find((provider) => provider.id === providerPresetId);
  const selectedChannelId = targetId.startsWith("channel:") ? targetId.slice("channel:".length) : "";
  const selectedThread = threads.find((thread) => thread.id === threadId);
  const automationMode: AutomationMode = runtime === "thread" ? "heartbeat" : "cron";
  const canCreate = Boolean(title.trim() && prompt.trim() && (automationMode === "cron" || threadId));

  return (
    <AutomationModal
      title={t("New automation")}
      subtitle={t("Define trigger conditions, choose an action, then save")}
      ariaLabel={t("Manual create")}
      icon={<CalendarClock size={18} />}
      actionLabel={t("Use template")}
      onAction={onUseTemplate}
      onClose={onClose}
    >
      <form
        className="automation-composer-form"
        onSubmit={(event) => {
          event.preventDefault();
          const trigger = buildScheduleTrigger(scheduleMode, timeOfDay, Number(weekday));
          const rrule = scheduleMode === "custom" ? customRRule.trim() : buildRRule(scheduleMode, timeOfDay, Number(weekday));
          void onCreate({
            kind: "custom_prompt",
            title: title.trim(),
            automationMode,
            channelId: automationMode === "cron" ? selectedChannelId || undefined : undefined,
            trigger,
            rrule,
            cwds: automationMode === "cron" ? [cwd] : [],
            targetThreadId: automationMode === "heartbeat" ? threadId : undefined,
            executionEnvironment: runtime === "thread" ? undefined : runtime,
            reasoningEffort,
            model: selectedProvider?.model,
            target: automationMode === "heartbeat"
              ? { scope: "thread", workspaceId: DEFAULT_WORKSPACE_ID, threadId, cwd }
              : buildTarget(cwd, selectedChannelId),
            promptTemplate: buildPromptTemplate(prompt),
            executionPolicy: {
              providerPresetId: providerPresetId || undefined,
              allowedTools: ["read", "grep", "find", "ls"],
              approvalProfile: { mode: "none" },
            },
            outputPolicy: buildOutputPolicy(true),
          });
        }}
      >
        <label className="automation-composer-field full">
          <span>{t("Automation name")}</span>
          <input
            className="automation-composer-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("Automation title placeholder")}
            aria-label={t("Automation title")}
          />
        </label>
        <section className="automation-trigger-section" aria-label={t("Trigger method")}>
          <span>{t("Trigger method")}</span>
          <div className="automation-trigger-segmented">
            <button className={scheduleMode !== "custom" ? "active" : ""} type="button" onClick={() => setScheduleMode("daily")}>{t("Schedule")}</button>
            <button type="button" disabled>{t("Event")}</button>
            <button className={scheduleMode === "custom" ? "active" : ""} type="button" onClick={() => setScheduleMode("custom")}>{t("Custom RRULE")}</button>
          </div>
        </section>
        <label className="automation-composer-field full">
          <span>{t("Execution action")}</span>
          <textarea
            className="automation-composer-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t("Automation prompt placeholder")}
            aria-label={t("Prompt")}
          />
        </label>
        <div className="automation-composer-toolbar">
          <AutomationPopoverButton
            icon={runtime === "thread" ? <MessageCircle size={15} /> : runtime === "worktree" ? <GitBranch size={15} /> : <Laptop size={15} />}
            label={runtimeChoiceLabel(runtime, t)}
            active={activePopover === "runtime"}
            onClick={() => setActivePopover(activePopover === "runtime" ? "" : "runtime")}
          >
            <div className="automation-popover-list">
              {(["local", "worktree", "thread"] as const).map((choice) => (
                <button key={choice} type="button" onClick={() => { setRuntime(choice); setActivePopover(""); }}>
                  {choice === "thread" ? <MessageCircle size={15} /> : choice === "worktree" ? <GitBranch size={15} /> : <Laptop size={15} />}
                  <span>{runtimeChoiceLabel(choice, t)}</span>
                  {runtime === choice ? <Check size={14} /> : null}
                </button>
              ))}
            </div>
          </AutomationPopoverButton>

          <AutomationPopoverButton
            icon={runtime === "thread" ? <MessageCircle size={15} /> : <Folder size={15} />}
            label={runtime === "thread" ? selectedThread?.title ?? t("Select conversation") : targetChoiceLabel(targetId, channels, t)}
            active={activePopover === "target"}
            onClick={() => setActivePopover(activePopover === "target" ? "" : "target")}
          >
            <div className="automation-popover-list wide">
              {runtime === "thread" ? (
                threadsLoading ? <span className="automation-popover-muted">{t("Loading threads...")}</span> : threads.map((thread) => (
                  <button key={thread.id} type="button" onClick={() => { setThreadId(thread.id); setActivePopover(""); }}>
                    <MessageCircle size={15} />
                    <span>{thread.title}</span>
                    {thread.id === threadId ? <Check size={14} /> : null}
                  </button>
                ))
              ) : (
                <>
                  <button type="button" onClick={() => { setTargetId("workspace"); setActivePopover(""); }}>
                    <Folder size={15} />
                    <span>{t("Current workspace")}</span>
                    {targetId === "workspace" ? <Check size={14} /> : null}
                  </button>
                  {channels.map((channel) => (
                    <button key={channel.id} type="button" onClick={() => { setTargetId(`channel:${channel.id}`); setActivePopover(""); }}>
                      <Folder size={15} />
                      <span>#{channel.name}</span>
                      {targetId === `channel:${channel.id}` ? <Check size={14} /> : null}
                    </button>
                  ))}
                </>
              )}
            </div>
          </AutomationPopoverButton>

          <AutomationPopoverButton
            icon={<CalendarClock size={15} />}
            label={scheduleSummaryLabel(scheduleMode, timeOfDay, Number(weekday), customRRule, t)}
            active={activePopover === "schedule"}
            onClick={() => setActivePopover(activePopover === "schedule" ? "" : "schedule")}
          >
            <div className="automation-popover-form">
              <label>
                <span>{t("Plan")}</span>
                <select value={scheduleMode} onChange={(event) => setScheduleMode(event.target.value as ScheduleChoice)}>
                  <option value="daily">{t("Daily")}</option>
                  <option value="workdays">{t("Workdays")}</option>
                  <option value="weekly">{t("Weekly")}</option>
                  <option value="custom">{t("Custom RRULE")}</option>
                </select>
              </label>
              {scheduleMode === "weekly" ? (
                <label>
                  <span>{t("Weekday")}</span>
                  <select value={weekday} onChange={(event) => setWeekday(event.target.value)}>
                    <option value="1">{t("Monday")}</option>
                    <option value="2">{t("Tuesday")}</option>
                    <option value="3">{t("Wednesday")}</option>
                    <option value="4">{t("Thursday")}</option>
                    <option value="5">{t("Friday")}</option>
                    <option value="6">{t("Saturday")}</option>
                    <option value="0">{t("Sunday")}</option>
                  </select>
                </label>
              ) : null}
              {scheduleMode === "custom" ? (
                <label>
                  <span>{t("RRULE")}</span>
                  <input value={customRRule} onChange={(event) => setCustomRRule(event.target.value)} />
                </label>
              ) : (
                <label>
                  <span>{t("Time")}</span>
                  <input type="time" value={timeOfDay} onChange={(event) => setTimeOfDay(event.target.value)} />
                </label>
              )}
            </div>
          </AutomationPopoverButton>

          <AutomationPopoverButton
            icon={<Box size={15} />}
            label={selectedProvider ? `${selectedProvider.displayName} · ${selectedProvider.model}` : t("Select model")}
            active={activePopover === "model"}
            onClick={() => setActivePopover(activePopover === "model" ? "" : "model")}
          >
            <div className="automation-popover-list wide">
              {providers.filter((provider) => provider.capabilities.includes("chat")).map((provider) => (
                <button key={provider.id} type="button" onClick={() => { setProviderPresetId(provider.id); setActivePopover(""); }}>
                  <Box size={15} />
                  <span>{provider.displayName} · {provider.model}</span>
                  {provider.id === providerPresetId ? <Check size={14} /> : null}
                </button>
              ))}
            </div>
          </AutomationPopoverButton>

          <AutomationPopoverButton
            icon={<Brain size={15} />}
            label={reasoningLabel(reasoningEffort, t)}
            active={activePopover === "reasoning"}
            onClick={() => setActivePopover(activePopover === "reasoning" ? "" : "reasoning")}
          >
            <div className="automation-popover-list">
              {(["low", "medium", "high", "xhigh"] as const).map((effort) => (
                <button key={effort} type="button" onClick={() => { setReasoningEffort(effort); setActivePopover(""); }}>
                  <Brain size={15} />
                  <span>{reasoningLabel(effort, t)}</span>
                  {reasoningEffort === effort ? <Check size={14} /> : null}
                </button>
              ))}
            </div>
          </AutomationPopoverButton>

          <span className="automation-risk-tooltip" tabIndex={0}>
            <Info size={15} />
            <span>{t("Automation permission risk tip")}</span>
          </span>

          <div className="automation-composer-actions">
            <button className="secondary-button compact-button" type="button" onClick={onClose}>{t("Cancel")}</button>
            <button className="primary-button compact-button" type="submit" disabled={!canCreate}>{t("Create")}</button>
          </div>
        </div>
      </form>
    </AutomationModal>
  );
}

function AutomationChatCreateModal({
  onUseTemplate,
  onCreate,
  onClose,
}: {
  readonly onUseTemplate: () => void;
  readonly onCreate: (prompt: string) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState("");
  return (
    <AutomationModal title={t("Create from conversation")} icon={<Bot size={18} />} actionLabel={t("Use template")} onAction={onUseTemplate} onClose={onClose}>
      <form
        className="automation-modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate(prompt);
        }}
      >
        <label>
          <span>{t("Request")}</span>
          <textarea
            value={prompt}
            rows={8}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t("Draft a daily brief every morning from recent runs and approvals")}
          />
        </label>
        <div className="automation-modal-actions">
          <button className="secondary-button compact-button" type="button" onClick={onClose}>{t("Cancel")}</button>
          <button className="primary-button compact-button" type="submit" disabled={!prompt.trim()}>{t("Create draft")}</button>
        </div>
      </form>
    </AutomationModal>
  );
}

function AutomationPopoverButton({
  icon,
  label,
  active,
  children,
  onClick,
}: {
  readonly icon: JSX.Element;
  readonly label: string;
  readonly active: boolean;
  readonly children: ReactNode;
  readonly onClick: () => void;
}): JSX.Element {
  return (
    <span className="automation-popover-anchor">
      <button className={active ? "automation-toolbar-pill active" : "automation-toolbar-pill"} type="button" onClick={onClick}>
        {icon}
        <span>{label}</span>
        <ChevronDown size={13} />
      </button>
      {active ? <span className="automation-popover-panel">{children}</span> : null}
    </span>
  );
}

function AutomationModal({
  title,
  subtitle,
  ariaLabel,
  icon,
  actionLabel,
  onAction,
  children,
  onClose,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly ariaLabel?: string;
  readonly icon: JSX.Element;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly children: ReactNode;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="automation-modal-backdrop" role="presentation">
      <div className="automation-modal" role="dialog" aria-modal="true" aria-label={ariaLabel ?? title}>
        <div className="panel-title split">
          <span>
            {title ? icon : null}
            {title ? (
              <span className="automation-modal-title-copy">
                <h2>{title}</h2>
                {subtitle ? <p>{subtitle}</p> : null}
              </span>
            ) : null}
          </span>
          <span className="automation-modal-header-actions">
            <Info size={15} />
            {actionLabel && onAction ? (
              <button className="secondary-button compact-button" type="button" onClick={onAction}>
                {actionLabel}
              </button>
            ) : null}
            <button className="ghost-icon-button" type="button" onClick={onClose} aria-label={t("Close")} title={t("Close")}>
              <X size={16} />
            </button>
          </span>
        </div>
        <div className="automation-modal-body">
          {children}
        </div>
      </div>
    </div>
  );
}

function runtimeChoiceLabel(runtime: RuntimeChoice, t: (value: string) => string): string {
  if (runtime === "thread") {
    return t("Conversation");
  }
  return runtime === "worktree" ? t("Worktree") : t("Local");
}

function targetChoiceLabel(targetId: string, channels: readonly Channel[], t: (value: string) => string): string {
  if (targetId === "workspace") {
    return t("Current workspace");
  }
  const channelId = targetId.startsWith("channel:") ? targetId.slice("channel:".length) : "";
  const channel = channels.find((item) => item.id === channelId);
  return channel ? `#${channel.name}` : t("Select project");
}

function reasoningLabel(reasoning: AutomationReasoningEffort, t: (value: string) => string): string {
  if (reasoning === "low") {
    return t("Low");
  }
  if (reasoning === "high") {
    return t("High");
  }
  if (reasoning === "xhigh") {
    return t("XHigh");
  }
  return t("Medium");
}

function scheduleSummaryLabel(
  schedule: ScheduleChoice,
  timeOfDay: string,
  weekday: number,
  customRRule: string,
  t: (value: string) => string,
): string {
  if (schedule === "custom") {
    return customRRule.trim() || t("Custom RRULE");
  }
  if (schedule === "workdays") {
    return `${t("Workdays")} ${timeOfDay}`;
  }
  if (schedule === "weekly") {
    return `${weekdayLabel(weekday, t)} ${timeOfDay}`;
  }
  return `${t("Daily")} ${timeOfDay}`;
}

function schedulePresetLabel(schedule: ScheduleChoice, t: (value: string) => string): string {
  if (schedule === "workdays") {
    return t("Workdays");
  }
  if (schedule === "weekly") {
    return t("Weekly");
  }
  if (schedule === "custom") {
    return t("Custom RRULE");
  }
  return t("Daily");
}

function weekdayLabel(weekday: number, t: (value: string) => string): string {
  const labels = [t("Sunday"), t("Monday"), t("Tuesday"), t("Wednesday"), t("Thursday"), t("Friday"), t("Saturday")];
  return labels[weekday] ?? t("Monday");
}

function buildScheduleTrigger(schedule: ScheduleChoice, timeOfDay: string, weekday: number): AutomationTrigger {
  if (schedule === "weekly") {
    return buildTrigger("weekly", timeOfDay, weekday);
  }
  return buildTrigger("daily", timeOfDay, weekday);
}

function buildRRule(schedule: ScheduleChoice, timeOfDay: string, weekday: number): string {
  const [hour = "09", minute = "00"] = timeOfDay.split(":");
  const normalizedHour = Number.parseInt(hour, 10);
  const normalizedMinute = Number.parseInt(minute, 10);
  if (schedule === "workdays") {
    return `FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=${normalizedHour};BYMINUTE=${normalizedMinute};BYSECOND=0`;
  }
  if (schedule === "weekly") {
    const day = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][weekday] ?? "MO";
    return `FREQ=WEEKLY;BYDAY=${day};BYHOUR=${normalizedHour};BYMINUTE=${normalizedMinute};BYSECOND=0`;
  }
  return `FREQ=DAILY;BYHOUR=${normalizedHour};BYMINUTE=${normalizedMinute};BYSECOND=0`;
}

function buildTemplatePresets(templates: readonly BuiltinAutomationTemplate[]): readonly AutomationTemplatePreset[] {
  const fromServer = templates.map((template) => ({
    id: template.id,
    title: template.title,
    description: template.description,
    prompt: template.defaultPromptTemplate.promptMarkdown,
    schedule: template.id === "weekly_review" ? "weekly" as const : "daily" as const,
    runtime: "worktree" as const,
  }));
  const extras: AutomationTemplatePreset[] = [
    {
      id: "standup_summary",
      title: "Standup / Weekly Summary",
      description: "整理最近工作、阻塞和下一步，适合团队站会或周会前自动生成。",
      prompt: "总结最近的工作进展、阻塞、风险和下一步。只引用 Ling 已有证据，缺失证据要明确说明。",
      schedule: "workdays",
      runtime: "thread",
    },
    {
      id: "mini_game",
      title: "Mini Game",
      description: "定期生成一个范围尽可能小的经典小游戏实现建议，避免超出当前仓库工具边界。",
      prompt: "为当前项目设计一个范围尽可能小的经典小游戏实现任务。不要直接修改文件，只给出可执行的最小步骤。",
      schedule: "weekly",
      runtime: "worktree",
    },
    {
      id: "skill_progression",
      title: "Skill Progression / PR Review",
      description: "根据近期 PR、评审和失败记录，建议下一步最值得补强的技能或 review 重点。",
      prompt: "根据近期 PR、评审、失败记录和运行证据，提出下一步最值得补强的技能或 review 重点。每条建议都要有具体证据。",
      schedule: "weekly",
      runtime: "worktree",
    },
  ];
  const seen = new Set<string>(fromServer.map((item) => item.id));
  return [...fromServer, ...extras.filter((item) => !seen.has(item.id))];
}

function templateIcon(templateId: string): JSX.Element {
  if (templateId.includes("release")) {
    return <ClipboardList size={18} />;
  }
  if (templateId.includes("bug")) {
    return <Sparkles size={18} />;
  }
  if (templateId.includes("mini")) {
    return <Bot size={18} />;
  }
  return <Layers size={18} />;
}

type DraftScheduleMode = "manual" | "daily" | "weekly" | "interval";

function buildTrigger(mode: DraftScheduleMode, timeOfDay: string, weekday: number, intervalMinutes = 60): AutomationTrigger {
  if (mode === "daily") {
    return {
      type: "schedule",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      schedule: { cadence: "daily", timeOfDay: timeOfDay || "09:00" },
      missedRunPolicy: "skip",
    };
  }
  if (mode === "weekly") {
    const normalizedWeekday = Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6 : 5;
    return {
      type: "schedule",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      schedule: { cadence: "weekly", weekday: normalizedWeekday, timeOfDay: timeOfDay || "17:00" },
      missedRunPolicy: "skip",
    };
  }
  if (mode === "interval") {
    const minutes = Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 60;
    return {
      type: "schedule",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      schedule: { cadence: "interval", everyMs: minutes * 60_000 },
      missedRunPolicy: "skip",
    };
  }
  return { type: "manual" };
}

function buildTarget(cwd: string, channelId: string): AutomationTarget {
  return {
    scope: channelId ? "channel" : "workspace",
    workspaceId: DEFAULT_WORKSPACE_ID,
    channelId: channelId || undefined,
    cwd,
  };
}

function buildPromptTemplate(prompt: string, existing?: AutomationPromptTemplate): AutomationPromptTemplate {
  return {
    templateVersion: existing?.templateVersion ?? 1,
    systemPurpose: existing?.systemPurpose ?? "Run a confirmed automation from supplied Ling context only.",
    promptMarkdown: prompt,
    contextSelectors: existing?.contextSelectors ?? [
      { kind: "channel_brief" },
      { kind: "recent_runs", limit: 8 },
      { kind: "pending_approvals", limit: 8 },
      { kind: "external_work", limit: 8 },
      { kind: "recent_artifacts", limit: 8 },
    ],
    maxContextItems: existing?.maxContextItems ?? 32,
  };
}

function buildOutputPolicy(writeArtifact: boolean): AutomationOutputPolicy {
  const destinations: AutomationOutputDestination[] = [{ type: "automation_thread" }];
  if (writeArtifact) {
    destinations.push({ type: "markdown_artifact" });
  }
  return { destinations, artifactFormat: "markdown" };
}
