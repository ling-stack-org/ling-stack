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
  Pause,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { listLingThreads } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { StatusBadge } from "../../shared/components/index.js";
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
  AutomationSchedulerState,
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

const DEFAULT_WORKSPACE_ID = "workspace_default";

type CreateDialog = "" | "templates" | "manual" | "chat";
type CreateMode = "chat" | "manual" | "templates";
type RuntimeChoice = AutomationExecutionEnvironment | "thread";
type ScheduleChoice = "daily" | "workdays" | "weekly" | "custom";
type AutomationTab = "running" | "paused" | "failed" | "succeeded" | "history";

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
  schedulers,
  schedulerAction,
  onRefresh,
  onStartScheduler,
  onStopScheduler,
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
  readonly schedulers: readonly AutomationSchedulerState[];
  readonly schedulerAction: "start" | "stop" | "";
  readonly onRefresh: () => void;
  readonly onStartScheduler: () => void;
  readonly onStopScheduler: () => void;
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
  const [createMode, setCreateMode] = useState<CreateMode>("chat");
  const [automationTab, setAutomationTab] = useState<AutomationTab>("running");
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [manualPreset, setManualPreset] = useState<AutomationTemplatePreset | undefined>(undefined);
  const [threads, setThreads] = useState<readonly LingThread[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const activeAutomations = useMemo(
    () => automations.filter((automation) => automation.status !== "paused" && automation.status !== "archived"),
    [automations],
  );
  const pausedAutomations = useMemo(
    () => automations.filter((automation) => automation.status === "paused"),
    [automations],
  );
  const recentRuns = automationRuns.slice(0, 8);
  const runningRunCount = automationRuns.filter((run) => run.status === "running" || run.status === "queued" || run.status === "waiting_for_approval").length;
  const recentFailedRunCount = recentRuns.filter((run) => run.status === "failed").length;
  const readyDraftCount = automationDrafts.filter((draft) => draft.status === "ready_for_confirmation").length;
  const scheduler = schedulers[0];
  const latestRunByAutomationId = useMemo(() => {
    const map = new Map<string, AutomationRun>();
    for (const run of automationRuns) {
      if (!map.has(run.automationId)) {
        map.set(run.automationId, run);
      }
    }
    return map;
  }, [automationRuns]);
  const failedAutomations = useMemo(
    () => automations.filter((automation) => automation.status === "error" || latestRunByAutomationId.get(automation.id)?.status === "failed"),
    [automations, latestRunByAutomationId],
  );
  const succeededAutomations = useMemo(
    () => automations.filter((automation) => latestRunByAutomationId.get(automation.id)?.status === "succeeded"),
    [automations, latestRunByAutomationId],
  );
  const visibleAutomations = automationTab === "paused"
    ? pausedAutomations
    : automationTab === "failed"
      ? failedAutomations
      : automationTab === "succeeded"
        ? succeededAutomations
        : activeAutomations;
  const selectedAutomation = automations.find((automation) => automation.id === selectedAutomationId);
  const selectedDraft = automationDrafts.find((draft) => draft.id === selectedDraftId);
  const selectedRun = selectedAutomation ? latestRunByAutomationId.get(selectedAutomation.id) : recentRuns[0];

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
    setCreateMode(mode);
    setCreateMenuOpen(false);
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
            {" · "}
            {scheduler?.nextRunAt ? `${t("Next")} ${formatDateTime(scheduler.nextRunAt)}` : t("Daemon will restore scheduled automations automatically")}
          </p>
        </div>
        <div className="automation-header-actions">
          <button className="secondary-button compact-button automation-refresh-button" type="button" onClick={onRefresh} disabled={isLoading} aria-label={t("Refresh")}>
            {isLoading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          </button>
          <div className="automation-create-dropdown">
            <button className="automation-create-trigger" type="button" onClick={() => openCreateDialog(createMode)} disabled={isLoading}>
              <Plus size={15} />
              {createMode === "chat" ? t("Create through chat") : createMode === "templates" ? t("Use template") : t("Manual create")}
            </button>
            <button
              className="automation-create-caret"
              type="button"
              aria-label={t("Choose creation mode")}
              onClick={() => setCreateMenuOpen((open) => !open)}
              disabled={isLoading}
            >
              <ChevronDown size={15} />
            </button>
            {createMenuOpen ? (
              <div className="automation-create-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => openCreateDialog("chat")}>
                  <MessageSquare size={15} />
                  {t("Create through chat")}
                  {createMode === "chat" ? <Check size={14} /> : null}
                </button>
                <button type="button" role="menuitem" onClick={() => openCreateDialog("manual")}>
                  <CalendarClock size={15} />
                  {t("Manual create")}
                  {createMode === "manual" ? <Check size={14} /> : null}
                </button>
                <button type="button" role="menuitem" onClick={() => openCreateDialog("templates")}>
                  <Layers size={15} />
                  {t("Use template")}
                  {createMode === "templates" ? <Check size={14} /> : null}
                </button>
              </div>
            ) : null}
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
        <section className="automation-current-pane" aria-label={t("Running")}>
          <div className="automation-pane-tabs">
            <div className="automation-tab-list" role="tablist" aria-label={t("Automation status")}>
              {([
                ["running", t("Running"), activeAutomations.length],
                ["paused", t("Paused"), pausedAutomations.length],
                ["failed", t("Failed"), failedAutomations.length],
                ["succeeded", t("Succeeded"), succeededAutomations.length],
                ["history", t("Recent history"), recentRuns.length],
              ] as const).map(([tab, label, count]) => (
                <button
                  key={tab}
                  className={automationTab === tab ? "active" : ""}
                  type="button"
                  role="tab"
                  aria-selected={automationTab === tab}
                  onClick={() => setAutomationTab(tab)}
                >
                  {label}
                  <span>{count}</span>
                </button>
              ))}
            </div>
          </div>

          {automationTab === "history" ? (
            <AutomationRunList
              runs={recentRuns}
              automations={automations}
              onOpenRun={onOpenRun}
              t={t}
            />
          ) : (
            <AutomationInboxSection
              emptyLabel={isLoading ? t("Loading automations...") : t("No automations yet")}
              automations={visibleAutomations}
              automationRuns={automationRuns}
              selectedAutomationId={selectedAutomationId}
              mutatingAutomationId={mutatingAutomationId}
              onSelect={(automationId) => {
                onSelectDraft("");
                onSelectAutomation(automationId);
              }}
              onRun={(automationId) => mutateSelectedAutomation(automationId, onRun)}
              onToggle={(automation) => mutateSelectedAutomation(automation.id, () => onSetStatus(automation.status === "enabled" ? "paused" : "enabled"))}
              onArchive={(automationId) => mutateSelectedAutomation(automationId, onArchive)}
              onOpenThread={onOpenThread}
              t={t}
            />
          )}

          {automationDrafts.length > 0 ? (
            <section className="automation-draft-lite-list automation-secondary-section" aria-label={t("Draft review")}>
              <h2>{t("Draft review")}</h2>
              {automationDrafts.map((draft) => {
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
                          void onConfirmDraft(draft.id);
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
                          void onDiscardDraft(draft.id);
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
          ) : null}
        </section>

        <AutomationExecutionInspector
          automation={selectedAutomation}
          draft={selectedDraft}
          latestRun={selectedRun}
          channels={channels}
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

function AutomationInboxSection({
  automations,
  automationRuns,
  selectedAutomationId,
  mutatingAutomationId,
  emptyLabel,
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
  readonly onSelect: (automationId: string) => void;
  readonly onRun: (automationId: string) => void;
  readonly onToggle: (automation: AutomationDefinition) => void;
  readonly onArchive: (automationId: string) => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly t: (value: string) => string;
}): JSX.Element {
  if (automations.length === 0) {
    return (
      <div className="automation-inbox-empty">
        <Timer size={18} />
        <span>{emptyLabel}</span>
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
              <small>{automationModeLabel(automation, t)} · {automationTargetSummary(automation, t)} · {automationScheduleLabel(automation, t)}</small>
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
  readonly t: (value: string) => string;
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

function AutomationExecutionInspector({
  automation,
  draft,
  latestRun,
  channels,
  preview,
  onOpenRun,
  onOpenThread,
}: {
  readonly automation?: AutomationDefinition;
  readonly draft?: AutomationDraft;
  readonly latestRun?: AutomationRun;
  readonly channels: readonly Channel[];
  readonly preview?: AutomationContextPreview;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenThread: (threadId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  const title = automation?.title ?? draft?.title ?? t("Execution details");
  const status = latestRun?.status ?? automation?.status ?? draft?.status;
  const output = inspectorOutputText(latestRun, preview, t);
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
              <span>{t("Target")}<strong>{automation ? targetLabel(automation, channels) : draft?.target?.scope ?? "--"}</strong></span>
              <span>{t("Runtime")}<strong>{automation ? automationModeLabel(automation, t) : draft ? automationDraftSourceLabel(draft.source, t) : "--"}</strong></span>
              <span>{t("Thread")}<strong>{automation?.threadId ?? draft?.target?.threadId ?? latestRun?.threadId ?? "--"}</strong></span>
            </div>
          </section>

          <section className="automation-inspector-section">
            <h3>{t("Output result")}</h3>
            <pre>{output}</pre>
          </section>

          <div className="automation-inspector-actions">
            {latestRun?.runId ? (
              <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(latestRun.runId as string)}>
                {t("Open run")}
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
    return run.errorMessage;
  }
  if (run?.skipReason) {
    return run.skipReason;
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
    <AutomationModal title={t("Create through chat")} icon={<Bot size={18} />} actionLabel={t("Use template")} onAction={onUseTemplate} onClose={onClose}>
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

function ContextPreview({ preview, emptyLabel }: { readonly preview?: AutomationContextPreview; readonly emptyLabel: string }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="automation-preview">
      <h3>{t("Context preview")}</h3>
      {preview ? (
        <pre>{preview.contextMarkdown}</pre>
      ) : (
        <div className="empty-state compact-empty">
          <RefreshCw />
          <span>{emptyLabel}</span>
        </div>
      )}
    </div>
  );
}

function automationModeLabel(automation: AutomationDefinition, t: (value: string) => string): string {
  if (automation.automationMode === "heartbeat") {
    return t("Automation heartbeat");
  }
  return automation.executionEnvironment === "worktree" ? t("Worktree") : t("Local");
}

function automationTargetSummary(automation: AutomationDefinition, t: (value: string) => string): string {
  if (automation.automationMode === "heartbeat") {
    return automation.targetThreadId ? `${t("Conversation")} · ${automation.targetThreadId}` : t("Conversation");
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

function automationDraftSourceLabel(source: AutomationDraft["source"], t: (value: string) => string): string {
  return t(`automation.source.${source}`);
}

function automationKindLabel(kind: AutomationDefinition["kind"], t: (value: string) => string): string {
  return t(`automation.kind.${kind}`);
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

function targetLabel(automation: AutomationDefinition, channels: readonly Channel[]): string {
  const channelId = automation.channelId ?? automation.target.channelId;
  const channel = channelId ? channels.find((item) => item.id === channelId) : undefined;
  if (channel) {
    return `#${channel.name}`;
  }
  return automation.target.scope;
}
