import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Archive,
  Bot,
  CalendarClock,
  Check,
  ClipboardList,
  Layers,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n.js";
import { formatDateTime } from "../../lib/formatting.js";
import { MetaRow, StatusBadge } from "../../shared/components/index.js";
import type {
  AutomationContextPreview,
  AutomationDefinition,
  AutomationDraft,
  AutomationOutputDestination,
  AutomationOutputPolicy,
  AutomationPromptTemplate,
  AutomationRun,
  AutomationSchedulerState,
  AutomationStatus,
  AutomationTarget,
  AutomationTrigger,
  BuiltinAutomationTemplate,
  BuiltinAutomationTemplateId,
  Channel,
  CreateAutomationRequest,
} from "../../types.js";

const DEFAULT_WORKSPACE_ID = "workspace_default";

type CreateDialog = "" | "templates" | "manual" | "chat";

export function AutomationsPage({
  cwd,
  channels,
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
  const [detailOpen, setDetailOpen] = useState(true);
  const selectedDraftCandidate = automationDrafts.find((draft) => draft.id === selectedDraftId);
  const selectedAutomationCandidate = selectedDraftCandidate
    ? undefined
    : automations.find((automation) => automation.id === selectedAutomationId) ?? automations[0];
  const selectedDraft = detailOpen ? selectedDraftCandidate : undefined;
  const selectedAutomation = detailOpen ? selectedAutomationCandidate : undefined;
  const selectedRuns = selectedAutomation
    ? automationRuns.filter((run) => run.automationId === selectedAutomation.id)
    : [];
  const preview = selectedAutomation ? previewByAutomationId[selectedAutomation.id] : undefined;
  const draftPreview = selectedDraft ? draftPreviewById[selectedDraft.id] : undefined;
  const busyAutomation = Boolean(selectedAutomation && mutatingAutomationId === selectedAutomation.id);
  const busyDraft = Boolean(selectedDraft && mutatingDraftId === selectedDraft.id);
  const scheduler = schedulers[0];

  useEffect(() => {
    setDetailOpen(true);
  }, [selectedAutomationId, selectedDraftId]);

  async function createTemplateDraft(templateId: BuiltinAutomationTemplateId): Promise<void> {
    await onCreateFromTemplate(templateId);
    setDialog("");
  }

  async function createManualDraft(partialAutomation: Partial<CreateAutomationRequest>): Promise<void> {
    await onCreateManualDraft(partialAutomation);
    setDialog("");
  }

  async function createChatDraft(prompt: string): Promise<void> {
    await onCreateChatDraft(prompt);
    setDialog("");
  }

  function selectDraft(draftId: string): void {
    if (detailOpen && selectedDraftCandidate?.id === draftId) {
      setDetailOpen(false);
      return;
    }
    onSelectDraft(draftId);
    setDetailOpen(true);
  }

  function selectAutomation(automationId: string): void {
    if (detailOpen && !selectedDraftCandidate && selectedAutomationCandidate?.id === automationId) {
      setDetailOpen(false);
      return;
    }
    onSelectDraft("");
    onSelectAutomation(automationId);
    setDetailOpen(true);
  }

  return (
    <div className={detailOpen ? "automations-layout" : "automations-layout detail-closed"}>
      <section className="panel automations-list-panel" aria-labelledby="automations-title">
        <div className="panel-title split">
          <span>
            <Timer size={18} />
            <h2 id="automations-title">{t("Automations")}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading}>
            {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            {t("Refresh")}
          </button>
        </div>

        <div className="automation-create-actions" aria-label="Automation creation modes">
          <button className="primary-button compact-button" type="button" onClick={() => setDialog("templates")} disabled={isLoading}>
            <Layers size={15} />
            {t("Templates")}
          </button>
          <button className="secondary-button compact-button" type="button" onClick={() => setDialog("manual")} disabled={isLoading}>
            <CalendarClock size={15} />
            {t("Manual setup")}
          </button>
          <button className="secondary-button compact-button" type="button" onClick={() => setDialog("chat")} disabled={isLoading}>
            <MessageSquare size={15} />
            {t("Create through chat")}
          </button>
        </div>

        <div className="provider-onboarding-strip" aria-label="Automation workspace status">
          <MetaRow label={t("Workspace")} value={cwd || t("Missing")} compact />
          <MetaRow label={t("Channels")} value={String(channels.length)} compact />
          <MetaRow label={t("Drafts")} value={String(automationDrafts.length)} compact />
          <MetaRow label={t("Enabled")} value={String(automations.filter((automation) => automation.status === "enabled").length)} compact />
        </div>

        <div className="automation-scheduler-strip" aria-label="Automation scheduler status">
          <div className="automation-scheduler-summary">
            <strong>{t("Local scheduler")}</strong>
            <span>
              {scheduler
                ? `${scheduler.status}${scheduler.nextRunAt ? ` · ${t("Next")} ${formatDateTime(scheduler.nextRunAt)}` : ""}`
                : t("Stopped")}
            </span>
          </div>
          <div className="automation-scheduler-actions">
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={onStartScheduler}
              disabled={schedulerAction === "start" || isLoading}
            >
              {schedulerAction === "start" ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
              {t("Start")}
            </button>
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={onStopScheduler}
              disabled={!scheduler || scheduler.status !== "running" || schedulerAction === "stop"}
            >
              {schedulerAction === "stop" ? <Loader2 className="spin" size={14} /> : <Timer size={14} />}
              {t("Stop")}
            </button>
          </div>
        </div>

        {automationDrafts.length > 0 ? (
          <div className="automation-list-section">
            <h3>{t("Draft review")}</h3>
            <div className="automation-list">
              {automationDrafts.map((draft) => (
                <button
                  key={draft.id}
                  className={selectedDraft?.id === draft.id ? "automation-row selected draft" : "automation-row draft"}
                  type="button"
                  aria-expanded={selectedDraft?.id === draft.id}
                  onClick={() => selectDraft(draft.id)}
                >
                  <span className="automation-row-main">
                    <strong>{draft.title ?? t("Untitled draft")}</strong>
                    <small>{draft.source} · {draft.kind ?? t("missing kind")}</small>
                  </span>
                  <span className="automation-row-meta">
                    <StatusBadge status={draft.status} />
                    {draft.missingFields.length > 0 ? <small>{draft.missingFields.length} {t("missing")}</small> : null}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="automation-list-section">
          <h3>{t("Saved automations")}</h3>
          <div className="automation-list">
            {automations.length === 0 ? (
              <div className="empty-state compact-empty">
                {isLoading ? <Loader2 className="spin" /> : <Timer />}
                <span>{t("No automations saved for this workspace")}</span>
              </div>
            ) : (
              automations.map((automation) => {
                const latestRun = automationRuns.find((run) => run.automationId === automation.id);
                return (
                  <button
                    key={automation.id}
                    className={selectedAutomation?.id === automation.id ? "automation-row selected" : "automation-row"}
                    type="button"
                    aria-expanded={selectedAutomation?.id === automation.id}
                    onClick={() => selectAutomation(automation.id)}
                  >
                    <span className="automation-row-main">
                      <strong>{automation.title}</strong>
                      <small>{automation.kind.replace("_", " ")}</small>
                    </span>
                    <span className="automation-row-meta">
                      <StatusBadge status={automation.status} />
                      {latestRun ? <small>{latestRun.status}</small> : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </section>

      {detailOpen ? (
        <section className="panel automation-detail-panel" aria-labelledby="automation-detail-title">
          {selectedDraft ? (
            <AutomationDraftReview
              key={selectedDraft.id}
              cwd={cwd}
              channels={channels}
              draft={selectedDraft}
              preview={draftPreview}
              busy={busyDraft}
              onSave={(partial) => onUpdateDraft(selectedDraft.id, partial)}
              onPreview={async (partial) => {
                await onUpdateDraft(selectedDraft.id, partial);
                await onPreviewDraft(selectedDraft.id);
              }}
              onConfirm={async (partial) => {
                await onUpdateDraft(selectedDraft.id, partial);
                await onConfirmDraft(selectedDraft.id);
              }}
              onDiscard={() => onDiscardDraft(selectedDraft.id)}
              onClose={() => setDetailOpen(false)}
            />
          ) : selectedAutomation ? (
            <AutomationDetail
              automation={selectedAutomation}
              channels={channels}
              runs={selectedRuns}
              preview={preview}
              busy={busyAutomation}
              onPreview={onPreview}
              onRun={onRun}
              onArchive={onArchive}
              onSetStatus={onSetStatus}
              onSetSchedule={onSetSchedule}
              onOpenRun={onOpenRun}
              onOpenThread={onOpenThread}
              onClose={() => setDetailOpen(false)}
            />
          ) : (
            <div className="empty-state">
              <Timer />
              <span>{t("Create an automation draft")}</span>
            </div>
          )}
        </section>
      ) : null}

      {dialog === "templates" ? (
        <AutomationTemplateModal
          templates={templates}
          channelsReady={channels.length > 0}
          isLoading={isLoading}
          onCreate={createTemplateDraft}
          onClose={() => setDialog("")}
        />
      ) : null}
      {dialog === "manual" ? (
        <AutomationManualSetupModal
          cwd={cwd}
          channels={channels}
          onCreate={createManualDraft}
          onClose={() => setDialog("")}
        />
      ) : null}
      {dialog === "chat" ? (
        <AutomationChatCreateModal
          onCreate={createChatDraft}
          onClose={() => setDialog("")}
        />
      ) : null}
    </div>
  );
}

function AutomationDetail({
  automation,
  channels,
  runs,
  preview,
  busy,
  onPreview,
  onRun,
  onArchive,
  onSetStatus,
  onSetSchedule,
  onOpenRun,
  onOpenThread,
  onClose,
}: {
  readonly automation: AutomationDefinition;
  readonly channels: readonly Channel[];
  readonly runs: readonly AutomationRun[];
  readonly preview?: AutomationContextPreview;
  readonly busy: boolean;
  readonly onPreview: () => void;
  readonly onRun: () => void;
  readonly onArchive: () => void;
  readonly onSetStatus: (status: AutomationStatus) => void;
  readonly onSetSchedule: (trigger: AutomationTrigger) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenThread: (threadId: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const canToggleStatus = automation.status === "enabled" || automation.status === "paused" || automation.status === "disabled" || automation.status === "error";
  return (
    <>
      <div className="panel-title split">
        <span>
          <Timer size={18} />
          <h2 id="automation-detail-title">{automation.title}</h2>
        </span>
        <span className="automation-actions">
          <button className="secondary-button compact-button" type="button" onClick={() => onOpenThread(automation.threadId)}>
            {t("Thread")}
          </button>
          <button className="secondary-button compact-button" type="button" onClick={onPreview} disabled={busy}>
            {busy ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
            {t("Preview")}
          </button>
          <button className="primary-button compact-button" type="button" onClick={onRun} disabled={busy || automation.status !== "enabled"}>
            {busy ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
            {t("Run")}
          </button>
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => onSetStatus(automation.status === "enabled" ? "paused" : "enabled")}
            disabled={busy || !canToggleStatus}
          >
            {automation.status === "enabled" ? <Pause size={14} /> : <Play size={14} />}
            {automation.status === "enabled" ? t("Pause") : t("Resume")}
          </button>
          <button className="ghost-icon-button" type="button" onClick={onArchive} disabled={busy} aria-label={t("Archive")} title={t("Archive")}>
            <Archive size={15} />
          </button>
          <button className="ghost-icon-button" type="button" onClick={onClose} aria-label={t("Close details")} title={t("Close details")}>
            <X size={15} />
          </button>
        </span>
      </div>

      <div className="automation-detail-grid">
        <MetaRow label={t("Status")} value={automation.status} />
        <MetaRow label={t("Trigger")} value={triggerLabel(automation.trigger)} />
        <MetaRow label={t("Target")} value={targetLabel(automation, channels)} />
        <MetaRow label={t("Updated")} value={formatDateTime(automation.updatedAt)} />
      </div>

      <div className="automation-schedule-actions">
        <button className="secondary-button compact-button" type="button" onClick={() => onSetSchedule({ type: "manual" })} disabled={busy || automation.trigger.type === "manual"}>
          {t("Manual")}
        </button>
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={() => onSetSchedule({
            type: "schedule",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            schedule: { cadence: "daily", timeOfDay: "09:00" },
            missedRunPolicy: "skip",
          })}
          disabled={busy || (automation.trigger.type === "schedule" && automation.trigger.schedule.cadence === "daily")}
        >
          {t("Daily 09:00")}
        </button>
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={() => onSetSchedule({
            type: "schedule",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
            schedule: { cadence: "weekly", weekday: 5, timeOfDay: "17:00" },
            missedRunPolicy: "skip",
          })}
          disabled={busy || (automation.trigger.type === "schedule" && automation.trigger.schedule.cadence === "weekly")}
        >
          {t("Weekly Fri")}
        </button>
      </div>

      <ContextPreview preview={preview} emptyLabel={t("Preview has not been generated")} />

      <div className="automation-runs-table">
        <h3>{t("Recent automation runs")}</h3>
        {runs.length === 0 ? (
          <div className="empty-state compact-empty">
            <Play />
            <span>{t("No runs yet")}</span>
          </div>
        ) : (
          runs.map((run) => (
            <div className="automation-run-row" key={run.id}>
              <StatusBadge status={run.status} />
              <span>{formatDateTime(run.firedAt)}</span>
              <code>{run.runId ?? run.id}</code>
              {run.runId ? (
                <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(run.runId as string)}>
                  {t("Open run")}
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>
    </>
  );
}

function AutomationDraftReview({
  cwd,
  channels,
  draft,
  preview,
  busy,
  onSave,
  onPreview,
  onConfirm,
  onDiscard,
  onClose,
}: {
  readonly cwd: string;
  readonly channels: readonly Channel[];
  readonly draft: AutomationDraft;
  readonly preview?: AutomationContextPreview;
  readonly busy: boolean;
  readonly onSave: (partialAutomation: Partial<CreateAutomationRequest>) => Promise<void>;
  readonly onPreview: (partialAutomation: Partial<CreateAutomationRequest>) => Promise<void>;
  readonly onConfirm: (partialAutomation: Partial<CreateAutomationRequest>) => Promise<void>;
  readonly onDiscard: () => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [title, setTitle] = useState(draft.title ?? "");
  const [description, setDescription] = useState(draft.description ?? "");
  const [prompt, setPrompt] = useState(draft.promptTemplate?.promptMarkdown ?? "");
  const [channelId, setChannelId] = useState(draft.channelId ?? draft.target?.channelId ?? channels[0]?.id ?? "");
  const [scheduleMode, setScheduleMode] = useState(scheduleModeFromTrigger(draft.trigger));
  const [timeOfDay, setTimeOfDay] = useState(timeOfDayFromTrigger(draft.trigger));
  const [weekday, setWeekday] = useState(String(weekdayFromTrigger(draft.trigger)));
  const [writeArtifact, setWriteArtifact] = useState(Boolean(draft.outputPolicy?.destinations.some((destination) => destination.type === "markdown_artifact") ?? true));

  const partial = (): Partial<CreateAutomationRequest> => ({
    kind: draft.kind ?? "custom_prompt",
    title,
    description,
    channelId: channelId || undefined,
    trigger: buildTrigger(scheduleMode, timeOfDay, Number(weekday)),
    target: buildTarget(cwd, channelId),
    promptTemplate: buildPromptTemplate(prompt, draft.promptTemplate),
    outputPolicy: buildOutputPolicy(writeArtifact),
    executionPolicy: draft.executionPolicy,
  });

  return (
    <>
      <div className="panel-title split">
        <span>
          <Sparkles size={18} />
          <h2 id="automation-detail-title">{t("Draft review")}</h2>
        </span>
        <span className="automation-actions">
          <StatusBadge status={draft.status} />
          <button className="secondary-button compact-button" type="button" onClick={() => onPreview(partial())} disabled={busy}>
            {busy ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
            {t("Preview")}
          </button>
          <button className="secondary-button compact-button" type="button" onClick={() => onSave(partial())} disabled={busy}>
            <Check size={14} />
            {t("Save")}
          </button>
          <button className="primary-button compact-button" type="button" onClick={() => onConfirm(partial())} disabled={busy}>
            {busy ? <Loader2 className="spin" size={14} /> : <Check size={14} />}
            {t("Confirm")}
          </button>
          <button className="ghost-icon-button" type="button" onClick={onDiscard} disabled={busy} aria-label={t("Discard")} title={t("Discard")}>
            <Trash2 size={15} />
          </button>
          <button className="ghost-icon-button" type="button" onClick={onClose} aria-label={t("Close details")} title={t("Close details")}>
            <X size={15} />
          </button>
        </span>
      </div>

      <div className="automation-draft-banner">
        <MetaRow label={t("Source")} value={draft.source} compact />
        <MetaRow label={t("Kind")} value={draft.kind ?? t("Missing")} compact />
        <MetaRow label={t("Updated")} value={formatDateTime(draft.updatedAt)} compact />
      </div>

      {draft.missingFields.length > 0 || draft.warnings.length > 0 ? (
        <div className="automation-draft-issues">
          {draft.missingFields.map((field) => <span key={field}>{t("Missing")} {field}</span>)}
          {draft.warnings.map((warning) => <span key={`${warning.code}-${warning.field ?? ""}`}>{warning.message}</span>)}
        </div>
      ) : null}

      <div className="automation-draft-form">
        <label>
          <span>{t("Title")}</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          <span>{t("Description")}</span>
          <input value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label>
          <span>{t("Target")}</span>
          <select value={channelId} onChange={(event) => setChannelId(event.target.value)}>
            <option value="">{t("Workspace")}</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>#{channel.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("Schedule")}</span>
          <select value={scheduleMode} onChange={(event) => setScheduleMode(event.target.value as "manual" | "daily" | "weekly")}>
            <option value="manual">{t("Manual")}</option>
            <option value="daily">{t("Daily")}</option>
            <option value="weekly">{t("Weekly")}</option>
          </select>
        </label>
        {scheduleMode !== "manual" ? (
          <label>
            <span>{t("Time")}</span>
            <input type="time" value={timeOfDay} onChange={(event) => setTimeOfDay(event.target.value)} />
          </label>
        ) : null}
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
        <label className="automation-checkbox-row">
          <input type="checkbox" checked={writeArtifact} onChange={(event) => setWriteArtifact(event.target.checked)} />
          <span>{t("Write markdown artifact")}</span>
        </label>
        <label className="automation-draft-prompt">
          <span>{t("Prompt")}</span>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={9} />
        </label>
      </div>

      <ContextPreview preview={preview} emptyLabel={t("Draft preview has not been generated")} />
    </>
  );
}

function AutomationTemplateModal({
  templates,
  channelsReady,
  isLoading,
  onCreate,
  onClose,
}: {
  readonly templates: readonly BuiltinAutomationTemplate[];
  readonly channelsReady: boolean;
  readonly isLoading: boolean;
  readonly onCreate: (templateId: BuiltinAutomationTemplateId) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <AutomationModal title={t("Templates")} icon={<Layers size={18} />} onClose={onClose}>
      <div className="automation-template-grid modal-grid" aria-label="Automation templates">
        {templates.map((template) => (
          <button
            key={template.id}
            className="automation-template-card"
            type="button"
            onClick={() => onCreate(template.id)}
            disabled={isLoading || !channelsReady}
          >
            {template.kind === "weekly_review" ? <ClipboardList size={17} /> : <Sparkles size={17} />}
            <strong>{t(template.title)}</strong>
            <span>{template.description}</span>
            <small>{template.tags.join(" · ")}</small>
          </button>
        ))}
      </div>
    </AutomationModal>
  );
}

function AutomationManualSetupModal({
  cwd,
  channels,
  onCreate,
  onClose,
}: {
  readonly cwd: string;
  readonly channels: readonly Channel[];
  readonly onCreate: (partialAutomation: Partial<CreateAutomationRequest>) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [title, setTitle] = useState("Manual Automation");
  const [prompt, setPrompt] = useState("Review the supplied Ling context and write a concise automation report.");
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [scheduleMode, setScheduleMode] = useState<"manual" | "daily" | "weekly">("manual");
  const [timeOfDay, setTimeOfDay] = useState("09:00");
  const [writeArtifact, setWriteArtifact] = useState(true);

  return (
    <AutomationModal title={t("Manual setup")} icon={<CalendarClock size={18} />} onClose={onClose}>
      <form
        className="automation-modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          void onCreate({
            kind: "custom_prompt",
            title,
            channelId: channelId || undefined,
            trigger: buildTrigger(scheduleMode, timeOfDay, 5),
            target: buildTarget(cwd, channelId),
            promptTemplate: buildPromptTemplate(prompt),
            outputPolicy: buildOutputPolicy(writeArtifact),
          });
        }}
      >
        <label>
          <span>{t("Title")}</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          <span>{t("Target")}</span>
          <select value={channelId} onChange={(event) => setChannelId(event.target.value)}>
            <option value="">{t("Workspace")}</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>#{channel.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("Schedule")}</span>
          <select value={scheduleMode} onChange={(event) => setScheduleMode(event.target.value as "manual" | "daily" | "weekly")}>
            <option value="manual">{t("Manual")}</option>
            <option value="daily">{t("Daily")}</option>
            <option value="weekly">{t("Weekly")}</option>
          </select>
        </label>
        {scheduleMode !== "manual" ? (
          <label>
            <span>{t("Time")}</span>
            <input type="time" value={timeOfDay} onChange={(event) => setTimeOfDay(event.target.value)} />
          </label>
        ) : null}
        <label className="automation-checkbox-row">
          <input type="checkbox" checked={writeArtifact} onChange={(event) => setWriteArtifact(event.target.checked)} />
          <span>{t("Write markdown artifact")}</span>
        </label>
        <label>
          <span>{t("Prompt")}</span>
          <textarea value={prompt} rows={8} onChange={(event) => setPrompt(event.target.value)} />
        </label>
        <div className="automation-modal-actions">
          <button className="secondary-button compact-button" type="button" onClick={onClose}>{t("Cancel")}</button>
          <button className="primary-button compact-button" type="submit">{t("Create draft")}</button>
        </div>
      </form>
    </AutomationModal>
  );
}

function AutomationChatCreateModal({
  onCreate,
  onClose,
}: {
  readonly onCreate: (prompt: string) => Promise<void>;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [prompt, setPrompt] = useState("");
  return (
    <AutomationModal title={t("Create through chat")} icon={<Bot size={18} />} onClose={onClose}>
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

function AutomationModal({
  title,
  icon,
  children,
  onClose,
}: {
  readonly title: string;
  readonly icon: JSX.Element;
  readonly children: ReactNode;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <div className="automation-modal-backdrop" role="presentation">
      <div className="automation-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="panel-title split">
          <span>
            {icon}
            <h2>{title}</h2>
          </span>
          <button className="ghost-icon-button" type="button" onClick={onClose} aria-label="Close" title="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ContextPreview({ preview, emptyLabel }: { readonly preview?: AutomationContextPreview; readonly emptyLabel: string }): JSX.Element {
  return (
    <div className="automation-preview">
      <h3>Context preview</h3>
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

function buildTrigger(mode: "manual" | "daily" | "weekly", timeOfDay: string, weekday: number): AutomationTrigger {
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

function scheduleModeFromTrigger(trigger: AutomationTrigger | undefined): "manual" | "daily" | "weekly" {
  if (trigger?.type === "schedule" && trigger.schedule.cadence === "daily") {
    return "daily";
  }
  if (trigger?.type === "schedule" && trigger.schedule.cadence === "weekly") {
    return "weekly";
  }
  return "manual";
}

function timeOfDayFromTrigger(trigger: AutomationTrigger | undefined): string {
  if (trigger?.type === "schedule" && (trigger.schedule.cadence === "daily" || trigger.schedule.cadence === "weekly")) {
    return trigger.schedule.timeOfDay;
  }
  return "09:00";
}

function weekdayFromTrigger(trigger: AutomationTrigger | undefined): number {
  if (trigger?.type === "schedule" && trigger.schedule.cadence === "weekly") {
    return trigger.schedule.weekday;
  }
  return 5;
}

function triggerLabel(trigger: AutomationTrigger): string {
  if (trigger.type === "manual") {
    return "manual";
  }
  if (trigger.type === "schedule") {
    if (trigger.schedule.cadence === "daily") {
      return `daily ${trigger.schedule.timeOfDay}`;
    }
    if (trigger.schedule.cadence === "weekly") {
      return `weekly ${trigger.schedule.weekday} ${trigger.schedule.timeOfDay}`;
    }
    return `interval ${trigger.schedule.everyMs}ms`;
  }
  return "monitor";
}

function targetLabel(automation: AutomationDefinition, channels: readonly Channel[]): string {
  const channelId = automation.channelId ?? automation.target.channelId;
  const channel = channelId ? channels.find((item) => item.id === channelId) : undefined;
  if (channel) {
    return `#${channel.name}`;
  }
  return automation.target.scope;
}
