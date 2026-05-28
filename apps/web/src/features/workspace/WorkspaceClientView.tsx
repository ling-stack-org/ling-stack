import { useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Command,
  Database,
  FileText,
  Hash,
  History,
  Image as ImageIcon,
  Link2,
  Loader2,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Send,
  SlidersHorizontal,
  SquareTerminal,
  Trash2,
  Workflow,
} from "lucide-react";
import type { AiTeammateTemplate } from "@ling-stack/core";
import { useI18n } from "../../i18n.js";
import { effectiveApprovalStatus } from "../../lib/approvals.js";
import { effectiveChannelRuntimePolicy } from "../../lib/channels.js";
import { formatDateTime } from "../../lib/formatting.js";
import { buildRunRepairHint, displayLinkedRunStatus } from "../../lib/run-evidence.js";
import { defaultTools, riskyTools } from "../../lib/tools.js";
import {
  canUseProviderForRun,
  isMediaProvider,
  providerPreflightReady,
  providerRunPreflightBlocker,
} from "../../lib/providers.js";
import { AvatarInitial, RunRepairHintBanner, StatusBadge } from "../../shared/components/index.js";
import type {
  ApprovalRequest,
  Channel,
  ChannelAttachment,
  ChannelFormState,
  ChannelLinkPreview,
  ChannelMention,
  ChannelMessage,
  ProviderPreset,
  ResourceLease,
  RunSession,
  Task,
  TaskFormState,
  TaskRunActionState,
} from "../../types.js";
import type { LocalTeammateDraft } from "../teammates/index.js";
import { ChannelRuntimePolicyFields, ProviderPresetOptions } from "./WorkspaceControls.js";

type TaskFilter = "all" | "queued" | "running" | "review" | "done";

const taskFilters: readonly TaskFilter[] = ["all", "queued", "running", "review", "done"];

export function WorkspaceClientView({
  cwd,
  daemonHealthy,
  providerLabel,
  channels,
  selectedChannelId,
  channelForm,
  tasks,
  taskForm,
  channelMessages,
  channelAttachments,
  channelLinkPreviews,
  selectedTaskId,
  providers,
  teammateTemplates,
  localTeammates,
  taskRunProviderId,
  fallbackProviderId,
  channelsLoading,
  tasksLoading,
  channelMessagesLoading,
  channelFilesLoading,
  providersLoading,
  approvals,
  resourceLeases,
  runs,
  runById,
  activeRunId,
  latestStatus,
  isRunning,
  activeTaskRunAction,
  errorMessage,
  onCwdChange,
  onChannelFormChange,
  onTaskFormChange,
  onProviderSelect,
  onSelectChannel,
  onRefreshChannels,
  onCreateDefaultChannel,
  onCreateChannel,
  onCreateTask,
  onSendMessage,
  onUploadAttachments,
  onCreateLinkPreview,
  onDeleteAttachment,
  onCreateTaskFromMessage,
  attachmentContentUrl,
  onRefreshTasks,
  onSelectTask,
  onCheckThenRunTask,
  onRunTask,
  onOpenRun,
  onOpenApprovals,
  onOpenProviders,
}: {
  readonly cwd: string;
  readonly daemonHealthy: boolean | undefined;
  readonly providerLabel: string;
  readonly channels: readonly Channel[];
  readonly selectedChannelId: string;
  readonly channelForm: ChannelFormState;
  readonly tasks: readonly Task[];
  readonly taskForm: TaskFormState;
  readonly channelMessages: readonly ChannelMessage[];
  readonly channelAttachments: readonly ChannelAttachment[];
  readonly channelLinkPreviews: readonly ChannelLinkPreview[];
  readonly selectedTaskId: string;
  readonly providers: readonly ProviderPreset[];
  readonly teammateTemplates: readonly AiTeammateTemplate[];
  readonly localTeammates: readonly LocalTeammateDraft[];
  readonly taskRunProviderId: string;
  readonly fallbackProviderId: string;
  readonly channelsLoading: boolean;
  readonly tasksLoading: boolean;
  readonly channelMessagesLoading: boolean;
  readonly channelFilesLoading: boolean;
  readonly providersLoading: boolean;
  readonly approvals: readonly ApprovalRequest[];
  readonly resourceLeases: readonly ResourceLease[];
  readonly runs: readonly RunSession[];
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly isRunning: boolean;
  readonly activeTaskRunAction: TaskRunActionState | undefined;
  readonly errorMessage: string;
  readonly onCwdChange: (cwd: string) => void;
  readonly onChannelFormChange: (form: ChannelFormState) => void;
  readonly onTaskFormChange: (form: TaskFormState) => void;
  readonly onProviderSelect: (providerId: string) => void;
  readonly onSelectChannel: (channelId: string) => void;
  readonly onRefreshChannels: () => void;
  readonly onCreateDefaultChannel: () => void;
  readonly onCreateChannel: () => void;
  readonly onCreateTask: () => void;
  readonly onSendMessage: (input: {
    readonly body: string;
    readonly mentions: readonly ChannelMention[];
    readonly attachmentIds: readonly string[];
    readonly linkPreviewIds: readonly string[];
    readonly requestAiReply: boolean;
  }) => void;
  readonly onUploadAttachments: (files: readonly File[]) => Promise<readonly ChannelAttachment[]>;
  readonly onCreateLinkPreview: (url: string) => Promise<ChannelLinkPreview | undefined>;
  readonly onDeleteAttachment: (attachmentId: string) => void;
  readonly onCreateTaskFromMessage: (message: ChannelMessage) => void;
  readonly attachmentContentUrl: (attachment: ChannelAttachment) => string;
  readonly onRefreshTasks: () => void;
  readonly onSelectTask: (taskId: string) => void;
  readonly onCheckThenRunTask: (task: Task) => void;
  readonly onRunTask: (task: Task) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
}): JSX.Element {
  const { t } = useI18n();
  const [taskFilter, setTaskFilter] = useState<TaskFilter>("all");
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];
  const [activeTab, setActiveTab] = useState<"activity" | "tasks" | "files">("activity");
  const [composerMode, setComposerMode] = useState<"discuss" | "task">("discuss");
  const [messageDraft, setMessageDraft] = useState("");
  const [askAi, setAskAi] = useState(true);
  const [pendingAttachments, setPendingAttachments] = useState<readonly ChannelAttachment[]>([]);
  const [pendingLinkPreviews, setPendingLinkPreviews] = useState<readonly ChannelLinkPreview[]>([]);
  const [linkDraft, setLinkDraft] = useState("");
  const [messageMentions, setMessageMentions] = useState<readonly ChannelMention[]>([]);
  const [composerBusy, setComposerBusy] = useState(false);
  const pendingApprovalCount = approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending").length;
  const readyProvider = providers.find(providerPreflightReady);
  const taskReadyProviders = providers.filter(providerPreflightReady);
  const setupChatProviders = providers.filter((provider) => !isMediaProvider(provider) && !providerPreflightReady(provider));
  const mediaProviders = providers.filter(isMediaProvider);
  const effectiveProviderId = (taskRunProviderId || selectedChannel?.defaultProviderPresetId || fallbackProviderId || readyProvider?.id) ?? "";
  const effectiveProvider = providers.find((provider) => provider.id === effectiveProviderId);
  const providerBlocker = providerRunPreflightBlocker(effectiveProvider);
  const activeLeaseCount = resourceLeases.filter((lease) => lease.status === "active").length;
  const taskActionPending = activeTaskRunAction !== undefined;
  const selectedChannelRuntimePolicy = effectiveChannelRuntimePolicy(selectedChannel);
  const channelStatusText = selectedChannel
    ? `${selectedChannel.status} · ${selectedChannelRuntimePolicy.executionMode} · ${selectedChannelRuntimePolicy.writeLockScope} lock`
    : t("No channel yet");
  const latestRun = activeRunId ? runById.get(activeRunId) : runs[0];
  const filteredTasks = useMemo(
    () =>
      tasks.filter((task) => {
        const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
        const linkedRunStatus = task.currentRunId ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus) : "";
        return taskMatchesFilter(taskFilter, task, linkedRunStatus);
      }),
    [activeRunId, latestStatus, runById, taskFilter, tasks],
  );
  const filterCounts = useMemo(
    () =>
      Object.fromEntries(
        taskFilters.map((filter) => [
          filter,
          tasks.filter((task) => {
            const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
            const linkedRunStatus = task.currentRunId ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus) : "";
            return taskMatchesFilter(filter, task, linkedRunStatus);
          }).length,
        ]),
      ) as Record<TaskFilter, number>,
    [activeRunId, latestStatus, runById, tasks],
  );

  function selectTask(taskId: string): void {
    setCreateTaskOpen(false);
    onSelectTask(taskId);
  }

  function createTask(): void {
    onCreateTask();
    setCreateTaskOpen(false);
  }

  const teammateOptions = useMemo(
    () => [
      ...teammateTemplates.map((template) => ({ id: template.id, label: template.name, kind: "ai-teammate" as const })),
      ...localTeammates.map((teammate) => ({ id: teammate.id, label: teammate.displayName, kind: "ai-teammate" as const })),
    ],
    [localTeammates, teammateTemplates],
  );
  const defaultTeammate = selectedChannel?.defaultTeammateId
    ? teammateOptions.find((teammate) => teammate.id === selectedChannel.defaultTeammateId)
    : undefined;

  function addMention(option: ChannelMention): void {
    setMessageMentions((current) => current.some((mention) => mention.id === option.id) ? current : [...current, option]);
    setMessageDraft((current) => `${current}${current.endsWith(" ") || current.length === 0 ? "" : " "}@${option.label} `);
    if (composerMode === "task") {
      onTaskFormChange({ ...taskForm, assigneeTeammateId: option.id });
    }
  }

  async function attachFiles(files: FileList | readonly File[]): Promise<void> {
    const selectedFiles = Array.from(files).slice(0, 10);
    if (selectedFiles.length === 0) {
      return;
    }
    setComposerBusy(true);
    try {
      const uploaded = await onUploadAttachments(selectedFiles);
      setPendingAttachments((current) => [...current, ...uploaded]);
      if (uploaded.length > 0) {
        setActiveTab("files");
      }
    } finally {
      setComposerBusy(false);
    }
  }

  async function addLinkPreview(rawUrl = linkDraft): Promise<void> {
    const url = rawUrl.trim();
    if (!url) {
      return;
    }
    setComposerBusy(true);
    try {
      const preview = await onCreateLinkPreview(url);
      if (preview) {
        setPendingLinkPreviews((current) => current.some((item) => item.id === preview.id) ? current : [...current, preview]);
        setLinkDraft("");
        setActiveTab("files");
      }
    } finally {
      setComposerBusy(false);
    }
  }

  async function sendMessage(): Promise<void> {
    const body = messageDraft.trim();
    const pastedUrls = extractUrls(body);
    const newPreviews: ChannelLinkPreview[] = [];
    setComposerBusy(true);
    try {
      for (const url of pastedUrls) {
        if (!pendingLinkPreviews.some((preview) => preview.normalizedUrl === url || preview.url === url)) {
          const preview = await onCreateLinkPreview(url);
          if (preview) {
            newPreviews.push(preview);
          }
        }
      }
      const linkPreviews = [...pendingLinkPreviews, ...newPreviews];
      await onSendMessage({
        body,
        mentions: messageMentions,
        attachmentIds: pendingAttachments.map((attachment) => attachment.id),
        linkPreviewIds: linkPreviews.map((preview) => preview.id),
        requestAiReply: askAi || messageMentions.some((mention) => mention.kind === "ai-teammate"),
      });
      setMessageDraft("");
      setMessageMentions([]);
      setPendingAttachments([]);
      setPendingLinkPreviews([]);
      setActiveTab("activity");
    } finally {
      setComposerBusy(false);
    }
  }

  return (
    <div className="client-window task-workbench-window" aria-label={t("Workspace")}>
      <header className="channel-header task-workbench-header">
        <div>
          <div className="channel-title-line">
            <Hash size={21} />
            <h1>{selectedChannel?.name ?? "Engineering"}</h1>
          </div>
          <p>{channelStatusText}{selectedChannel?.boundPath ? ` · ${selectedChannel.boundPath}` : ""}</p>
        </div>
        <div className="channel-header-actions">
          <span className={daemonHealthy ? "glass-chip ok" : "glass-chip attention"}>
            <Activity size={14} />
            {daemonHealthy === undefined ? t("Checking daemon") : daemonHealthy ? t("Daemon ready") : t("Daemon offline")}
          </span>
          <span className={providerBlocker ? "glass-chip attention" : "glass-chip ok"}>
            <Command size={14} />
            {effectiveProvider?.displayName ?? providerLabel}
          </span>
          <span className={selectedChannel?.defaultTeammateId ? "glass-chip ok" : "glass-chip attention"}>
            <MessageSquare size={14} />
            {defaultTeammate?.label ?? selectedChannel?.defaultTeammateId ?? t("No default teammate")}
          </span>
          {selectedChannel ? (
            <span className={selectedChannel.status === "active" ? "glass-chip ok" : "glass-chip attention"}>
              <Workflow size={14} />
              {selectedChannel.status}
            </span>
          ) : null}
          {activeLeaseCount > 0 ? (
            <span className="glass-chip attention">
              <Clock3 size={14} />
              {t("{count} active leases", { count: activeLeaseCount })}
            </span>
          ) : null}
        </div>
      </header>

      <section className="task-workbench-toolbar" aria-label={t("Workspace task toolbar")}>
        <label className="field toolbar-path-field">
          <span>{t("Workspace path")}</span>
          <input value={cwd} onChange={(event) => onCwdChange(event.target.value)} />
        </label>
        <label className="field toolbar-channel-field">
          <span>{t("Channel")}</span>
          <select value={selectedChannelId} onChange={(event) => onSelectChannel(event.target.value)} disabled={channelsLoading || channels.length === 0}>
            {channels.length === 0 ? <option value="">{t("No channel yet")}</option> : null}
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.name} / {channel.status}
              </option>
            ))}
          </select>
        </label>
        <label className="field run-provider-field">
          <span>{t("Run provider")}</span>
          <select value={effectiveProviderId} onChange={(event) => onProviderSelect(event.target.value)} disabled={providersLoading || providers.length === 0}>
            <option value="">{t("Select provider preset")}</option>
            <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
          </select>
        </label>
        <button className="primary-button task-toolbar-create" type="button" onClick={() => setCreateTaskOpen(true)} disabled={!selectedChannelId}>
          <Plus size={15} />
          {t("New task")}
        </button>
      </section>

      {errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      <div className="task-workbench-main">
        <section className="panel task-list-panel" aria-label={t("Channel activity")}>
          <div className="panel-title split">
            <span>
              {activeTab === "activity" ? <MessageSquare size={16} /> : activeTab === "files" ? <FileText size={16} /> : <SquareTerminal size={16} />}
              <h2>{activeTab === "activity" ? t("Activity") : activeTab === "files" ? t("Files") : t("Tasks")}</h2>
            </span>
            <button
              className="icon-button"
              type="button"
              onClick={activeTab === "tasks" ? onRefreshTasks : onRefreshChannels}
              disabled={!selectedChannelId || (activeTab === "tasks" ? tasksLoading : channelsLoading)}
              aria-label={t("Refresh")}
            >
              {(activeTab === "tasks" ? tasksLoading : channelsLoading) ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            </button>
          </div>

          <div className="channel-tabs" role="tablist" aria-label={t("Channel tabs")}>
            {(["activity", "tasks", "files"] as const).map((tab) => (
              <button key={tab} type="button" className={activeTab === tab ? "channel-tab active" : "channel-tab"} onClick={() => setActiveTab(tab)}>
                {tab === "activity" ? <MessageSquare size={14} /> : tab === "tasks" ? <SquareTerminal size={14} /> : <FileText size={14} />}
                {tab === "activity" ? t("Activity") : tab === "tasks" ? t("Tasks") : t("Files")}
              </button>
            ))}
          </div>

          {activeTab === "activity" ? (
            <div className="message-feed">
              {channelMessagesLoading ? (
                <div className="client-empty-state">
                  <Loader2 className="spin" />
                  <span>{t("Loading messages...")}</span>
                </div>
              ) : channelMessages.length === 0 ? (
                <MessageBubble
                  avatar={<AvatarInitial label="L" tone="orange" />}
                  author="Ling Stack"
                  time={t("Now")}
                  body={selectedChannel ? t("Default workspace is ready. This channel is bound to {path}.", { path: selectedChannel.boundPath ?? cwd }) : t("Create a default channel to start the workspace loop.")}
                />
              ) : (
                channelMessages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    avatar={<AvatarInitial label={message.authorType === "ai-teammate" ? "A" : message.authorType === "system" ? "S" : "T"} tone={message.authorType === "ai-teammate" ? "teal" : message.authorType === "system" ? "violet" : undefined} />}
                    author={messageAuthorLabel(message, teammateOptions)}
                    tag={message.kind === "ai_reply" ? "AI" : message.kind === "task_link" ? "Task" : undefined}
                    time={formatDateTime(message.createdAt)}
                    body={message.body}
                    action={
                      message.kind === "message" ? (
                        <button className="secondary-button compact-button" type="button" onClick={() => onCreateTaskFromMessage(message)}>
                          <Plus size={14} />
                          {t("Create task")}
                        </button>
                      ) : message.linkedTaskId ? (
                        <code>{message.linkedTaskId}</code>
                      ) : undefined
                    }
                  />
                ))
              )}
              {latestRun ? (
                <MessageBubble
                  avatar={<AvatarInitial label="H" tone="violet" />}
                  author="Hopper"
                  tag="AI"
                  time={formatDateTime(latestRun.updatedAt)}
                  body={t("Latest run {runId} is {status}.", { runId: latestRun.id, status: latestRun.status })}
                  action={
                    <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(latestRun.id)}>
                      <History size={14} />
                      {t("Open run")}
                    </button>
                  }
                />
              ) : null}
            </div>
          ) : null}

          {activeTab === "files" ? (
            <ChannelFiles
              attachments={channelAttachments}
              linkPreviews={channelLinkPreviews}
              loading={channelFilesLoading}
              attachmentContentUrl={attachmentContentUrl}
              onDeleteAttachment={onDeleteAttachment}
            />
          ) : null}

          {activeTab === "tasks" ? (
            <>
              <div className="task-filter-tabs" aria-label={t("Task filters")}>
                {taskFilters.map((filter) => (
                  <button key={filter} className={taskFilter === filter ? "active" : ""} type="button" onClick={() => setTaskFilter(filter)}>
                    {t(taskFilterLabel(filter))}
                    <small>{filterCounts[filter]}</small>
                  </button>
                ))}
              </div>
              <div className="workbench-task-list">
                {filteredTasks.length === 0 ? (
                  <div className="client-empty-state">
                    {tasksLoading ? <Loader2 className="spin" /> : <SquareTerminal />}
                    <span>{tasksLoading ? t("Loading tasks...") : t("No tasks match this filter")}</span>
                  </div>
                ) : (
                  filteredTasks.map((task) => {
                    const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
                    const linkedRunStatus = task.currentRunId ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus) : "";
                    return (
                      <button
                        key={task.id}
                        type="button"
                        className={task.id === selectedTask?.id && !createTaskOpen ? "client-task-card selected" : "client-task-card"}
                        onClick={() => selectTask(task.id)}
                      >
                        <span className="client-task-main">
                          <span>
                            <strong>{task.title}</strong>
                            <small>{task.prompt}</small>
                          </span>
                          <span className={`task-status ${task.status}`}>{task.status}</span>
                        </span>
                        <span className="task-card-meta">
                          {task.currentRunId ? <StatusBadge status={linkedRunStatus} /> : <span className="status-badge queued">{t("Not run")}</span>}
                          <small>{task.currentRunId ?? formatDateTime(task.updatedAt)}</small>
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </>
          ) : null}

          <section className="composer-panel channel-composer" aria-label={t("Channel composer")}>
            <div className="composer-head">
              <span>
                <MessageSquare size={16} />
                {composerMode === "discuss" ? t("Discuss") : t("New task")}
              </span>
              <div className="segmented-control" aria-label={t("Composer mode")}>
                <button type="button" className={composerMode === "discuss" ? "active" : ""} onClick={() => setComposerMode("discuss")}>
                  {t("Discuss")}
                </button>
                <button type="button" className={composerMode === "task" ? "active" : ""} onClick={() => setComposerMode("task")}>
                  {t("Task")}
                </button>
              </div>
            </div>
            <div className="mention-row" aria-label={t("AI mentions")}>
              {teammateOptions.slice(0, 8).map((option) => (
                <button key={option.id} type="button" className="mention-chip" onClick={() => addMention(option)}>
                  @{option.label}
                </button>
              ))}
            </div>
            {composerMode === "task" ? (
              <input
                className="composer-title"
                value={taskForm.title}
                onChange={(event) => onTaskFormChange({ ...taskForm, title: event.target.value })}
                placeholder={t("Title")}
              />
            ) : null}
            <textarea
              value={composerMode === "discuss" ? messageDraft : taskForm.prompt}
              rows={3}
              onChange={(event) => {
                if (composerMode === "discuss") {
                  setMessageDraft(event.target.value);
                } else {
                  onTaskFormChange({ ...taskForm, prompt: event.target.value });
                }
              }}
              placeholder={composerMode === "discuss" ? t("Message this channel or @ an AI teammate") : t("Prompt")}
            />
            {composerMode === "discuss" ? (
              <div className="composer-assets">
                <label className="secondary-button compact-button">
                  <FileText size={14} />
                  {t("Attach files")}
                  <input
                    type="file"
                    multiple
                    hidden
                    accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.log"
                    onChange={(event) => {
                      if (event.target.files) {
                        void attachFiles(event.target.files);
                      }
                      event.target.value = "";
                    }}
                  />
                </label>
                <label className="link-preview-input">
                  <Link2 size={14} />
                  <input value={linkDraft} onChange={(event) => setLinkDraft(event.target.value)} placeholder={t("Paste URL")} />
                </label>
                <button className="secondary-button compact-button" type="button" onClick={() => void addLinkPreview()} disabled={!linkDraft.trim() || composerBusy}>
                  <Plus size={14} />
                  {t("Preview link")}
                </button>
                <label className="ask-ai-toggle">
                  <input type="checkbox" checked={askAi} onChange={(event) => setAskAi(event.target.checked)} />
                  <span>{t("Ask AI")}</span>
                </label>
              </div>
            ) : null}
            {composerMode === "discuss" && (pendingAttachments.length > 0 || pendingLinkPreviews.length > 0 || messageMentions.length > 0) ? (
              <div className="pending-assets">
                {messageMentions.map((mention) => <span key={mention.id}>@{mention.label}</span>)}
                {pendingAttachments.map((attachment) => <span key={attachment.id}>{attachment.fileName}</span>)}
                {pendingLinkPreviews.map((preview) => <span key={preview.id}>{preview.title ?? preview.normalizedUrl}</span>)}
              </div>
            ) : null}
            {mediaProviders.length > 0 ? (
              <div className="provider-run-notice neutral client-provider-notice">
                <Database size={16} />
                <span>{t("Media providers stay in Media Jobs and cannot run coding tasks.")}</span>
              </div>
            ) : null}
            <div className="composer-footer">
              <div className="tool-token-list" aria-label={t("Tool calls")}>
                {(selectedChannel?.allowedTools ?? defaultTools).map((tool) => (
                  <span key={tool} className={riskyTools.includes(tool) ? "tool-token risky" : "tool-token"}>{tool}</span>
                ))}
              </div>
              {composerMode === "discuss" ? (
                <button className="primary-button" type="button" onClick={() => void sendMessage()} disabled={!selectedChannelId || composerBusy || (!messageDraft.trim() && pendingAttachments.length === 0 && pendingLinkPreviews.length === 0)}>
                  {composerBusy ? <Loader2 className="spin" size={15} /> : <Send size={15} />}
                  {t("Send")}
                </button>
              ) : (
                <button className="primary-button" type="button" onClick={createTask} disabled={!selectedChannelId || !taskForm.prompt.trim()}>
                  <Send size={15} />
                  {t("Create task")}
                </button>
              )}
            </div>
          </section>
        </section>

        <section className="panel task-detail-panel" aria-label={createTaskOpen ? t("New task") : t("Task detail")}>
          {createTaskOpen ? (
            <NewTaskPanel
              taskForm={taskForm}
              selectedChannel={selectedChannel}
              effectiveProviderId={effectiveProviderId}
              taskReadyProviders={taskReadyProviders}
              setupChatProviders={setupChatProviders}
              mediaProviders={mediaProviders}
              providersLoading={providersLoading}
              onProviderSelect={onProviderSelect}
              onTaskFormChange={onTaskFormChange}
              onCreateTask={createTask}
              onCancel={() => setCreateTaskOpen(false)}
            />
          ) : selectedTask ? (
            <TaskDetailPanel
              task={selectedTask}
              channels={channels}
              runById={runById}
              activeRunId={activeRunId}
              latestStatus={latestStatus}
              pendingApprovalCount={pendingApprovalCount}
              effectiveProvider={effectiveProvider}
              providerBlocker={providerBlocker}
              isRunning={isRunning}
              activeTaskRunAction={activeTaskRunAction}
              taskActionPending={taskActionPending}
              activeLeaseCount={activeLeaseCount}
              onCheckThenRunTask={onCheckThenRunTask}
              onRunTask={onRunTask}
              onOpenRun={onOpenRun}
              onOpenApprovals={onOpenApprovals}
              onOpenProviders={onOpenProviders}
            />
          ) : (
            <div className="client-empty-state">
              <SquareTerminal />
              <span>{t("Select a task or create a new one")}</span>
            </div>
          )}
        </section>
      </div>
      <details className="config-disclosure channel-options">
        <summary>
          <SlidersHorizontal size={14} />
          {t("Channel options")}
        </summary>
        <div className="channel-options-grid">
          <label className="field wide">
            <span>{t("Name")}</span>
            <input value={channelForm.name} onChange={(event) => onChannelFormChange({ ...channelForm, name: event.target.value })} />
          </label>
          <label className="field wide">
            <span>{t("Execution path")}</span>
            <input value={channelForm.boundPath} onChange={(event) => onChannelFormChange({ ...channelForm, boundPath: event.target.value })} />
          </label>
          <label className="field wide">
            <span>{t("Default AI teammate")}</span>
            <select value={channelForm.defaultTeammateId} onChange={(event) => onChannelFormChange({ ...channelForm, defaultTeammateId: event.target.value })}>
              <option value="">{t("No default teammate")}</option>
              {teammateOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <ChannelRuntimePolicyFields form={channelForm} onChange={onChannelFormChange} />
          <div className="channel-option-actions">
            {channels.length === 0 ? (
              <button className="secondary-button compact-button" type="button" onClick={onCreateDefaultChannel} disabled={channelsLoading || !readyProvider}>
                <Plus size={14} />
                {t("Create default")}
              </button>
            ) : null}
            <button className="secondary-button compact-button" type="button" onClick={onRefreshChannels} disabled={channelsLoading}>
              {channelsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
              {t("Refresh channels")}
            </button>
            <button className="primary-button compact-button" type="button" onClick={onCreateChannel}>
              <Plus size={14} />
              {t("Create channel")}
            </button>
          </div>
        </div>
      </details>
    </div>
  );
}

function NewTaskPanel({
  taskForm,
  selectedChannel,
  effectiveProviderId,
  taskReadyProviders,
  setupChatProviders,
  mediaProviders,
  providersLoading,
  onProviderSelect,
  onTaskFormChange,
  onCreateTask,
  onCancel,
}: {
  readonly taskForm: TaskFormState;
  readonly selectedChannel: Channel | undefined;
  readonly effectiveProviderId: string;
  readonly taskReadyProviders: readonly ProviderPreset[];
  readonly setupChatProviders: readonly ProviderPreset[];
  readonly mediaProviders: readonly ProviderPreset[];
  readonly providersLoading: boolean;
  readonly onProviderSelect: (providerId: string) => void;
  readonly onTaskFormChange: (form: TaskFormState) => void;
  readonly onCreateTask: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="task-create-panel">
      <div className="panel-title split">
        <span>
          <Plus size={17} />
          <h2>{t("New task")}</h2>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onCancel}>
          {t("Cancel")}
        </button>
      </div>
      <label className="field wide">
        <span>{t("Run provider")}</span>
        <select value={effectiveProviderId} onChange={(event) => onProviderSelect(event.target.value)} disabled={providersLoading}>
          <option value="">{t("Select provider preset")}</option>
          <ProviderPresetOptions runnableProviders={taskReadyProviders} blockedProviders={setupChatProviders} />
        </select>
      </label>
      <label className="field wide">
        <span>{t("Title")}</span>
        <input value={taskForm.title} onChange={(event) => onTaskFormChange({ ...taskForm, title: event.target.value })} />
      </label>
      <label className="field wide">
        <span>{t("Prompt")}</span>
        <textarea value={taskForm.prompt} rows={7} onChange={(event) => onTaskFormChange({ ...taskForm, prompt: event.target.value })} />
      </label>
      {mediaProviders.length > 0 ? (
        <div className="provider-run-notice neutral client-provider-notice">
          <Database size={16} />
          <span>{t("Media providers stay in Media Jobs and cannot run coding tasks.")}</span>
        </div>
      ) : null}
      <div className="composer-footer">
        <div className="tool-token-list" aria-label={t("Tool calls")}>
          {(selectedChannel?.allowedTools ?? defaultTools).map((tool) => (
            <span key={tool} className={riskyTools.includes(tool) ? "tool-token risky" : "tool-token"}>{tool}</span>
          ))}
        </div>
        <button className="primary-button" type="button" onClick={onCreateTask} disabled={!selectedChannel || !taskForm.prompt.trim()}>
          <Send size={15} />
          {t("Create task")}
        </button>
      </div>
    </div>
  );
}

function TaskDetailPanel({
  task,
  channels,
  runById,
  activeRunId,
  latestStatus,
  pendingApprovalCount,
  effectiveProvider,
  providerBlocker,
  isRunning,
  activeTaskRunAction,
  taskActionPending,
  activeLeaseCount,
  onCheckThenRunTask,
  onRunTask,
  onOpenRun,
  onOpenApprovals,
  onOpenProviders,
}: {
  readonly task: Task;
  readonly channels: readonly Channel[];
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly pendingApprovalCount: number;
  readonly effectiveProvider: ProviderPreset | undefined;
  readonly providerBlocker: string | undefined;
  readonly isRunning: boolean;
  readonly activeTaskRunAction: TaskRunActionState | undefined;
  readonly taskActionPending: boolean;
  readonly activeLeaseCount: number;
  readonly onCheckThenRunTask: (task: Task) => void;
  readonly onRunTask: (task: Task) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
}): JSX.Element {
  const { t } = useI18n();
  const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
  const linkedRunStatus = task.currentRunId ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus) : "";
  const linkedRunSucceeded = linkedRunStatus === "succeeded";
  const repairHint = buildRunRepairHint(linkedRun, pendingApprovalCount, linkedRunStatus);
  const taskChannel = channels.find((channel) => channel.id === task.channelId);
  const taskChannelPaused = taskChannel?.status !== undefined && taskChannel.status !== "active";
  const blockedByLease = activeLeaseCount > 0 && (!linkedRun || linkedRun.status !== "running");
  const checkRunLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "check";
  const runLoading = activeTaskRunAction?.taskId === task.id && activeTaskRunAction.action === "run";
  const taskActionsDisabled = isRunning || taskActionPending;

  return (
    <article className="client-task-card task-detail selected" aria-label={t("Task detail")}>
      <div className="task-detail-head">
        <span className="client-task-kicker">{t("Task detail")}</span>
        <span className={`task-status ${task.status}`}>{task.status}</span>
      </div>
      <div className="task-detail-copy">
        <h2>{task.title}</h2>
        <p>{task.prompt}</p>
      </div>
      <div className="task-detail-meta">
        <span>
          <Hash size={13} />
          {taskChannel?.name ?? task.channelId}
        </span>
        <span>
          <Command size={13} />
          {effectiveProvider?.displayName ?? t("No model selected")}
        </span>
        <span>
          <Clock3 size={13} />
          {formatDateTime(task.updatedAt)}
        </span>
      </div>
      {task.currentRunId ? (
        <div className={linkedRunSucceeded ? "task-run-link compact succeeded" : "task-run-link compact"}>
          <StatusBadge status={linkedRunStatus} />
          <span className="task-run-summary">
            {linkedRunSucceeded ? <strong>{t("Task complete")}</strong> : null}
            <code>{task.currentRunId}</code>
          </span>
          <button className={linkedRunSucceeded ? "primary-button compact-button" : "secondary-button compact-button"} type="button" onClick={() => onOpenRun(task.currentRunId ?? "")}>
            {linkedRunSucceeded ? <CheckCircle2 size={14} /> : <History size={14} />}
            {linkedRunSucceeded ? t("View result") : t("Open run")}
          </button>
        </div>
      ) : null}
      {task.currentRunId && repairHint ? (
        <RunRepairHintBanner
          hint={repairHint}
          runId={task.currentRunId}
          compact
          onOpenProviders={() => onOpenProviders(linkedRun)}
          onOpenApprovals={onOpenApprovals}
          onOpenRun={onOpenRun}
        />
      ) : null}
      {providerBlocker ? (
        <div className="provider-run-notice">
          <CircleAlert size={16} />
          <span>{providerBlocker}</span>
        </div>
      ) : null}
      {taskChannelPaused || blockedByLease ? (
        <div className="task-run-link compact">
          <StatusBadge status={taskChannelPaused ? (taskChannel?.status ?? "blocked") : "blocked"} />
          <span>{taskChannelPaused ? t("Channel is not active") : t("Active resource lock")}</span>
        </div>
      ) : null}
      <div className="task-actions">
        <button className="secondary-button compact-button" type="button" onClick={() => onCheckThenRunTask(task)} disabled={taskActionsDisabled || !effectiveProvider || !canUseProviderForRun(effectiveProvider)}>
          {checkRunLoading ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
          {t("Check run")}
        </button>
        <button className="primary-button compact-button" type="button" onClick={() => onRunTask(task)} disabled={taskActionsDisabled || Boolean(providerBlocker) || taskChannelPaused}>
          {runLoading ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
          {t("Run")}
        </button>
      </div>
    </article>
  );
}

function MessageBubble({
  avatar,
  author,
  tag,
  time,
  body,
  action,
}: {
  readonly avatar: JSX.Element;
  readonly author: string;
  readonly tag?: string;
  readonly time: string;
  readonly body: string;
  readonly action?: JSX.Element;
}): JSX.Element {
  return (
    <article className="message-bubble">
      {avatar}
      <div className="message-content">
        <div className="message-meta">
          <strong>{author}</strong>
          {tag ? <small>{tag}</small> : null}
          <time>{time}</time>
        </div>
        <p>{body}</p>
        {action ? <div className="message-action">{action}</div> : null}
      </div>
    </article>
  );
}

function taskFilterLabel(filter: TaskFilter): string {
  if (filter === "queued") {
    return "Queued";
  }
  if (filter === "running") {
    return "Running";
  }
  if (filter === "review") {
    return "Needs review";
  }
  if (filter === "done") {
    return "Done";
  }
  return "All";
}

function taskMatchesFilter(filter: TaskFilter, task: Task, linkedRunStatus: string): boolean {
  if (filter === "queued") {
    return task.status === "todo";
  }
  if (filter === "running") {
    return task.status === "running" || task.status === "claimed" || linkedRunStatus === "running" || linkedRunStatus === "queued";
  }
  if (filter === "review") {
    return task.status === "failed" || task.status === "blocked" || task.status === "review" || linkedRunStatus === "failed" || linkedRunStatus === "waiting_for_approval";
  }
  if (filter === "done") {
    return task.status === "done" || linkedRunStatus === "succeeded";
  }
  return true;
}

function ChannelFiles({
  attachments,
  linkPreviews,
  loading,
  attachmentContentUrl,
  onDeleteAttachment,
}: {
  readonly attachments: readonly ChannelAttachment[];
  readonly linkPreviews: readonly ChannelLinkPreview[];
  readonly loading: boolean;
  readonly attachmentContentUrl: (attachment: ChannelAttachment) => string;
  readonly onDeleteAttachment: (attachmentId: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  if (loading) {
    return (
      <div className="client-empty-state channel-files">
        <Loader2 className="spin" />
        <span>{t("Loading files...")}</span>
      </div>
    );
  }

  return (
    <section className="channel-files" aria-label={t("Files")}>
      <div className="file-section">
        <div className="task-strip-head">
          <span>
            <FileText size={16} />
            <strong>{t("Attachments")}</strong>
          </span>
        </div>
        {attachments.length === 0 ? (
          <div className="client-empty-state">
            <FileText />
            <span>{t("No attachments in this channel")}</span>
          </div>
        ) : (
          <div className="file-grid">
            {attachments.map((attachment) => (
              <article key={attachment.id} className="file-card">
                <span className="file-icon">{attachment.kind === "image" ? <ImageIcon size={18} /> : <FileText size={18} />}</span>
                <span>
                  <strong>{attachment.fileName}</strong>
                  <small>{attachment.kind} · {formatBytes(attachment.sizeBytes)}</small>
                </span>
                <a className="secondary-button compact-button" href={attachmentContentUrl(attachment)} target="_blank" rel="noreferrer">{t("Open")}</a>
                <button className="icon-button" type="button" onClick={() => onDeleteAttachment(attachment.id)} aria-label={t("Delete attachment")}>
                  <Trash2 size={14} />
                </button>
              </article>
            ))}
          </div>
        )}
      </div>

      <div className="file-section">
        <div className="task-strip-head">
          <span>
            <Link2 size={16} />
            <strong>{t("Links")}</strong>
          </span>
        </div>
        {linkPreviews.length === 0 ? (
          <div className="client-empty-state">
            <Link2 />
            <span>{t("No shared links in this channel")}</span>
          </div>
        ) : (
          <div className="file-grid">
            {linkPreviews.map((preview) => (
              <a key={preview.id} className={`link-card ${preview.status}`} href={preview.normalizedUrl} target="_blank" rel="noreferrer">
                <span>
                  <strong>{preview.title ?? preview.normalizedUrl}</strong>
                  <small>{preview.status === "ready" ? preview.description ?? preview.siteName ?? preview.normalizedUrl : preview.errorMessage}</small>
                </span>
                <span className={`task-status ${preview.status === "ready" ? "done" : "blocked"}`}>{preview.status}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function messageAuthorLabel(message: ChannelMessage, teammates: readonly ChannelMention[]): string {
  if (message.authorType === "system") {
    return "Ling Stack";
  }
  if (message.authorType === "ai-teammate") {
    return teammates.find((teammate) => teammate.id === message.authorId)?.label ?? message.authorId ?? "AI teammate";
  }
  return message.authorId ?? "Tian";
}

function extractUrls(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s)]+/g) ?? [];
  return [...new Set(matches.map((item) => item.replace(/[.,;!?]+$/, "")))];
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
