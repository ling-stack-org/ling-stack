import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Info, Layers, Loader2, MessageSquare, RefreshCw } from "lucide-react";
import { listLingThreads } from "../../api.js";
import { useI18n } from "../../i18n.js";
import { PageActionHeader } from "../../shared/components/index.js";
import type {
  AutomationContextPreview,
  AutomationDefinition,
  AutomationDraft,
  AutomationRun,
  AutomationSchedulerState,
  AutomationStatus,
  AutomationTrigger,
  BuiltinAutomationTemplate,
  BuiltinAutomationTemplateId,
  Channel,
  CreateAutomationRequest,
  LingThread,
  ProviderPreset,
} from "../../types.js";
import {
  AutomationChatCreateModal,
  AutomationManualSetupModal,
  AutomationTemplateModal,
  type AutomationTemplatePreset,
} from "./AutomationCreateDialogs.js";
import { AutomationExecutionInspector } from "./AutomationExecutionInspector.js";
import { AutomationListPane } from "./AutomationListPane.js";
import { AutomationSchedulerStrip } from "./AutomationSchedulerStrip.js";
import {
  activeAutomations as deriveActiveAutomations,
  buildAutomationTabs,
  failedAutomations as deriveFailedAutomations,
  latestRunByAutomationId,
  pausedAutomations as derivePausedAutomations,
  succeededAutomations as deriveSucceededAutomations,
  summarizeAutomationsPage,
  visibleAutomationsForTab,
  type AutomationTab,
} from "./automation-view-models.js";

type CreateDialog = "" | "templates" | "manual" | "chat";
type CreateMode = Exclude<CreateDialog, "">;

export function AutomationsPage({
  cwd,
  channels,
  providers,
  automations,
  automationRuns,
  automationDrafts,
  templates,
  schedulers,
  schedulerAction,
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
  onStartScheduler,
  onStopScheduler,
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
  readonly schedulers: readonly AutomationSchedulerState[];
  readonly schedulerAction: "start" | "stop" | "";
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
  readonly onStartScheduler: () => void;
  readonly onStopScheduler: () => void;
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
  void onCreateFromTemplate;
  void onCreateManualDraft;
  void onUpdateDraft;
  void onPreviewDraft;
  void onPreview;
  void onSetSchedule;

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
  const selectedAutomation = automations.find((automation) => automation.id === selectedAutomationId);
  const selectedDraft = automationDrafts.find((draft) => draft.id === selectedDraftId);
  const selectedRun = selectedAutomation ? latestRunById.get(selectedAutomation.id) : recentRuns[0];
  const scheduler = schedulers[0];
  const automationSummary = useMemo(
    () => summarizeAutomationsPage({ automations, automationRuns, automationDrafts, scheduler }),
    [automations, automationRuns, automationDrafts, scheduler],
  );
  const automationTabs = useMemo(
    () => buildAutomationTabs({
      enabled: activeAutomations,
      paused: pausedAutomations,
      needsAttention: failedAutomations,
      succeeded: succeededAutomations,
      recentRuns,
      t,
    }),
    [activeAutomations, pausedAutomations, failedAutomations, succeededAutomations, recentRuns, t],
  );
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
      <PageActionHeader
        className="automations-inbox-header"
        title={<span id="automations-title">{t("Automations")}</span>}
        description={t("{count} automations · {enabled} enabled · {running} running runs · {attention} need attention", {
          count: automationSummary.totalDefinitions,
          enabled: automationSummary.enabledDefinitions,
          running: automationSummary.runningRunCount,
          attention: automationSummary.attentionCount,
        })}
        secondaryActions={(
          <button className="secondary-button compact-button automation-refresh-button" type="button" onClick={onRefresh} disabled={isLoading} aria-label={t("Refresh")}>
            {isLoading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          </button>
        )}
        primaryAction={(
          <div className="automation-header-actions automation-create-actions header-actions" aria-label={t("Create automation")}>
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
        )}
      />
      <AutomationSchedulerStrip
        scheduler={scheduler}
        schedulerAction={schedulerAction}
        onStart={onStartScheduler}
        onStop={onStopScheduler}
      />

      <main className="automations-inbox-main" aria-labelledby="automations-title">
        {automationSummary.attentionCount > 0 ? (
          <div className="automation-attention-banner">
            <Info size={17} />
            <strong>{t("{count} automation items need attention", { count: automationSummary.attentionCount })}</strong>
            <span>{automationSummary.readyDraftCount > 0 ? t("Review drafts before enabling.") : t("Check recent failed runs or automation errors.")}</span>
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
