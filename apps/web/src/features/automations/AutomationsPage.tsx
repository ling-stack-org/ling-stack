import type {
  AutomationContextPreview,
  AutomationDefinition,
  AutomationDraft,
  AutomationRun,
  AutomationSchedulerState,
  AutomationStatus,
  AutomationTarget,
  AutomationTrigger,
  BuiltinAutomationTemplate,
  Channel,
  CreateAutomationRequest,
  ProviderPreset,
} from "../../types.js";
import type {
  AutomationCreateKind,
  AutomationDraftMutationKind,
  AutomationMutationKind,
} from "../../domains/automations/use-automations-domain.js";
import { useI18n } from "../../i18n.js";
import { InlineFeedback, useLingToast } from "../../shared/ui/index.js";
import { AutomationArchiveDialog } from "./AutomationArchiveDialog.js";
import { AutomationCreateDialog } from "./AutomationCreateDialog.js";
import { AutomationDiscardDraftDialog } from "./AutomationDiscardDraftDialog.js";
import { AutomationExecutionInspector } from "./AutomationExecutionInspector.js";
import { AutomationListPane } from "./AutomationListPane.js";
import { AutomationScheduleDialog } from "./AutomationScheduleDialog.js";
import { AutomationSchedulerSummary } from "./AutomationSchedulerSummary.js";
import { AutomationWorkbenchHeader } from "./AutomationWorkbenchHeader.js";
import { useAutomationsPageController } from "./useAutomationsPageController.js";

export interface AutomationsPageProps {
  readonly cwd: string;
  readonly channels: readonly Channel[];
  readonly providers: readonly ProviderPreset[];
  readonly automations: readonly AutomationDefinition[];
  readonly automationRuns: readonly AutomationRun[];
  readonly automationDrafts: readonly AutomationDraft[];
  readonly templates: readonly BuiltinAutomationTemplate[];
  readonly schedulers: readonly AutomationSchedulerState[];
  readonly selectedAutomationId: string;
  readonly selectedDraftId: string;
  readonly previewByAutomationId: Readonly<Record<string, AutomationContextPreview>>;
  readonly draftPreviewById: Readonly<Record<string, AutomationContextPreview>>;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly createAction: AutomationCreateKind;
  readonly schedulerAction: "start" | "stop" | "";
  readonly automationActionById: Readonly<Record<string, AutomationMutationKind | undefined>>;
  readonly draftActionById: Readonly<Record<string, AutomationDraftMutationKind | undefined>>;
  readonly refreshError: string;
  readonly createError: string;
  readonly schedulerError: string;
  readonly automationErrorById: Readonly<Record<string, string | undefined>>;
  readonly draftErrorById: Readonly<Record<string, string | undefined>>;
  readonly onRefresh: () => Promise<boolean>;
  readonly onCreateAutomation: (automation: CreateAutomationRequest) => Promise<AutomationDefinition | undefined>;
  readonly onCreateChatDraft: (prompt: string) => Promise<AutomationDraft | undefined>;
  readonly onSelectAutomation: (automationId: string) => void;
  readonly onSelectDraft: (draftId: string) => void;
  readonly onUpdateDraft: (draftId: string, partialAutomation: Partial<CreateAutomationRequest>) => Promise<AutomationDraft | undefined>;
  readonly onPreviewDraft: (draftId: string) => Promise<AutomationContextPreview | undefined>;
  readonly onConfirmDraft: (draftId: string) => Promise<AutomationDefinition | undefined>;
  readonly onDiscardDraft: (draftId: string) => Promise<boolean>;
  readonly onPreview: (automationId: string) => Promise<AutomationContextPreview | undefined>;
  readonly onRun: (automationId: string) => Promise<AutomationRun | undefined>;
  readonly onArchive: (automationId: string) => Promise<boolean>;
  readonly onSetStatus: (automationId: string, status: AutomationStatus) => Promise<AutomationDefinition | undefined>;
  readonly onSetSchedule: (automationId: string, trigger: AutomationTrigger, rrule?: string) => Promise<AutomationDefinition | undefined>;
  readonly onSetTarget: (automationId: string, target: AutomationTarget) => Promise<AutomationDefinition | undefined>;
  readonly onStartScheduler: () => Promise<boolean>;
  readonly onStopScheduler: () => Promise<boolean>;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenThread: (threadId: string) => void;
}

export function AutomationsPage(props: AutomationsPageProps): JSX.Element {
  const { t } = useI18n();
  const { showToast } = useLingToast();
  const controller = useAutomationsPageController({
    automations: props.automations,
    automationDrafts: props.automationDrafts,
    automationRuns: props.automationRuns,
    channels: props.channels,
    cwd: props.cwd,
    schedulers: props.schedulers,
    selectedAutomationId: props.selectedAutomationId,
    selectedDraftId: props.selectedDraftId,
    templates: props.templates,
    t,
  });
  const selectedAutomationViewModel = controller.definitionViewModels.find((item) => item.automation.id === props.selectedAutomationId);
  const selectedDraftViewModel = controller.draftViewModels.find((item) => item.draft.id === props.selectedDraftId);
  const selectedAutomationAction = selectedAutomationViewModel ? props.automationActionById[selectedAutomationViewModel.automation.id] : undefined;
  const selectedAutomationError = selectedAutomationViewModel ? props.automationErrorById[selectedAutomationViewModel.automation.id] ?? "" : "";

  async function runAutomation(automationId: string): Promise<void> {
    if (await props.onRun(automationId)) showToast({ message: t("Automation run"), scope: `automation:run:${automationId}`, tone: "success" });
  }

  async function setStatus(automationId: string, status: AutomationStatus): Promise<void> {
    if (await props.onSetStatus(automationId, status)) showToast({ message: t(status === "enabled" ? "Resume" : "Pause"), scope: `automation:status:${automationId}`, tone: "success" });
  }

  async function archiveSelected(): Promise<void> {
    const automation = controller.archiveAutomation;
    if (!automation) return;
    if (await props.onArchive(automation.id)) {
      controller.closeArchive();
      showToast({ message: t("Archived"), scope: `automation:archive:${automation.id}`, tone: "success" });
    }
  }

  async function discardSelectedDraft(): Promise<void> {
    const draft = controller.discardDraft;
    if (!draft) return;
    if (await props.onDiscardDraft(draft.id)) {
      controller.closeDiscard();
      showToast({ message: t("Discard"), scope: `automation:draft:discard:${draft.id}`, tone: "success" });
    }
  }

  async function saveSchedule(trigger: AutomationTrigger, rrule?: string): Promise<void> {
    const automation = controller.scheduleAutomation;
    if (!automation) return;
    if (await props.onSetSchedule(automation.id, trigger, rrule)) {
      controller.closeSchedule();
      showToast({ message: t("Saved"), scope: `automation:schedule:${automation.id}`, tone: "success" });
    }
  }

  async function runScheduler(action: "start" | "stop"): Promise<void> {
    const succeeded = action === "start" ? await props.onStartScheduler() : await props.onStopScheduler();
    if (succeeded) showToast({ message: t(action === "start" ? "Scheduler started" : "Scheduler stopped"), scope: "automation:scheduler", tone: "success" });
  }

  return (
    <div className="automations-inbox-page automation-ui2-page" data-automation-ui2-page>
      <AutomationWorkbenchHeader
        disabled={!props.cwd.trim()}
        refreshing={props.isRefreshing}
        summary={controller.summary}
        t={t}
        onCreate={() => controller.openCreate("template")}
        onRefresh={() => void props.onRefresh()}
      />
      <AutomationSchedulerSummary
        busy={Boolean(props.schedulerAction)}
        error={props.schedulerError}
        scheduler={controller.schedulerViewModel}
        t={t}
        onStart={() => void runScheduler("start")}
        onStop={() => void runScheduler("stop")}
      />
      {props.refreshError ? (
        <InlineFeedback className="automation-ui2-stale" title={t("Refresh")} tone="warning">{props.refreshError}</InlineFeedback>
      ) : null}
      <main className="automation-ui2-main" aria-labelledby="automations-title">
        <AutomationListPane
          activeTab={controller.activeTab}
          automationActionById={props.automationActionById}
          automationErrorById={props.automationErrorById}
          definitions={controller.visibleDefinitions}
          draftActionById={props.draftActionById}
          draftErrorById={props.draftErrorById}
          drafts={controller.visibleDrafts}
          loading={props.isLoading}
          runs={controller.visibleRuns}
          search={controller.search}
          selectedAutomationId={props.selectedAutomationId}
          selectedDraftId={props.selectedDraftId}
          tabs={controller.tabs}
          t={t}
          onArchive={controller.openArchive}
          onConfirmDraft={(draftId) => void props.onConfirmDraft(draftId).then((automation) => {
            if (automation) showToast({ message: t("Confirm automation"), scope: `automation:draft:confirm:${draftId}`, tone: "success" });
          })}
          onDiscardDraft={controller.openDiscard}
          onOpenRun={props.onOpenRun}
          onOpenSchedule={controller.openSchedule}
          onOpenThread={props.onOpenThread}
          onRun={(automationId) => void runAutomation(automationId)}
          onSearchChange={controller.setSearch}
          onSelectAutomation={(automationId) => {
            props.onSelectDraft("");
            props.onSelectAutomation(automationId);
          }}
          onSelectDraft={(draftId) => {
            props.onSelectAutomation("");
            props.onSelectDraft(draftId);
          }}
          onStatusChange={(automationId, status) => void setStatus(automationId, status)}
          onTabChange={controller.setActiveTab}
        />
        <AutomationExecutionInspector
          action={selectedAutomationAction}
          automationViewModel={selectedAutomationViewModel}
          channels={props.channels}
          cwd={props.cwd}
          draftViewModel={selectedDraftViewModel}
          error={selectedAutomationError}
          latestRun={controller.selectedLatestRun}
          preview={selectedAutomationViewModel
            ? props.previewByAutomationId[selectedAutomationViewModel.automation.id]
            : selectedDraftViewModel
              ? props.draftPreviewById[selectedDraftViewModel.draft.id]
              : undefined}
          t={t}
          threads={controller.threads}
          onOpenRun={props.onOpenRun}
          onOpenThread={props.onOpenThread}
          onPreview={(automationId) => void props.onPreview(automationId)}
          onRepairTarget={(automationId, target) => void props.onSetTarget(automationId, target).then((automation) => {
            if (automation) showToast({ message: t("Saved"), scope: `automation:target:${automationId}`, tone: "success" });
          })}
          onRun={(automationId) => void runAutomation(automationId)}
        />
      </main>

      <AutomationCreateDialog
        channels={props.channels}
        createAction={props.createAction}
        createError={props.createError || controller.threadLoadError}
        cwd={props.cwd}
        draftActionById={props.draftActionById}
        draftErrorById={props.draftErrorById}
        draftPreviewById={props.draftPreviewById}
        drafts={props.automationDrafts}
        mode={controller.createMode}
        open={controller.createOpen}
        providers={props.providers}
        t={t}
        templates={props.templates}
        threadTitleById={controller.threadTitleById}
        threads={controller.threads}
        threadsLoading={controller.threadsLoading}
        onConfirmDraft={async (draftId) => {
          const automation = await props.onConfirmDraft(draftId);
          if (automation) showToast({ message: t("Confirm automation"), scope: `automation:create:${automation.id}`, tone: "success" });
          return automation;
        }}
        onCreateAutomation={async (request) => {
          const automation = await props.onCreateAutomation(request);
          if (automation) showToast({ message: t("Create automation"), scope: `automation:create:${automation.id}`, tone: "success" });
          return automation;
        }}
        onCreateChatDraft={props.onCreateChatDraft}
        onModeChange={controller.setCreateMode}
        onOpenChange={(open) => { if (!open) controller.closeCreate(); }}
        onPreviewDraft={props.onPreviewDraft}
        onUpdateDraft={props.onUpdateDraft}
      />
      <AutomationArchiveDialog
        automation={controller.archiveAutomation}
        busy={Boolean(controller.archiveAutomation && props.automationActionById[controller.archiveAutomation.id] === "archive")}
        error={controller.archiveAutomation ? props.automationErrorById[controller.archiveAutomation.id] ?? "" : ""}
        t={t}
        onConfirm={() => void archiveSelected()}
        onOpenChange={(open) => { if (!open) controller.closeArchive(); }}
      />
      <AutomationDiscardDraftDialog
        busy={Boolean(controller.discardDraft && props.draftActionById[controller.discardDraft.id] === "discard")}
        draft={controller.discardDraft}
        error={controller.discardDraft ? props.draftErrorById[controller.discardDraft.id] ?? "" : ""}
        t={t}
        onConfirm={() => void discardSelectedDraft()}
        onOpenChange={(open) => { if (!open) controller.closeDiscard(); }}
      />
      <AutomationScheduleDialog
        automation={controller.scheduleAutomation}
        busy={Boolean(controller.scheduleAutomation && props.automationActionById[controller.scheduleAutomation.id] === "schedule")}
        error={controller.scheduleAutomation ? props.automationErrorById[controller.scheduleAutomation.id] ?? "" : ""}
        t={t}
        onOpenChange={(open) => { if (!open) controller.closeSchedule(); }}
        onSave={(trigger, rrule) => void saveSchedule(trigger, rrule)}
      />
    </div>
  );
}
