import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  PanelRightClose,
  PanelRightOpen,
  Folder,
  RefreshCw,
} from "lucide-react";
import {
  GSTACK_DEFAULT_SKILL_PACK_ID,
  getBuiltinSkillPack,
} from "@ling-stack/core/builtin-skill-packs";
import {
  approveApproval,
  buildRerunRequest,
  buildRunRequest,
  buildTaskRunRequest,
  cancelRun,
  checkProvider,
  channelAttachmentContentUrl,
  createChannel,
  createChannelContextSummary,
  createChannelDecision,
  createChannelHandoff,
  createChannelLinkPreview,
  createChannelMessage,
  createChannelWorkflowFromHandoff,
  createMediaJob,
  createProvider,
  createTask,
  daemonBaseUrl,
  denyApproval,
  deleteChannelAttachment,
  deleteChannel,
  deleteTask,
  deleteProvider,
  getDaemonHealth,
  getApprovalPolicy,
  getChannelBrief,
  getRun,
  getRunEvents,
  listMediaJobArtifacts,
  listRunArtifacts,
  listResourceLeases,
  listChannelAttachments,
  listChannels,
  listChannelContextSummaries,
  listChannelDecisions,
  listChannelHandoffs,
  listChannelLinkPreviews,
  listChannelMessages,
  listChannelWorkflows,
  listChannelWorkflowSteps,
  listApprovals,
  listMediaJobs,
  listProviders,
  listProviderTemplates,
  listRuns,
  listStateTransitions,
  listTasks,
  runMediaJob,
  startChannelWorkflowStep,
  uploadChannelAttachment,
  updateChannel,
  updateApprovalPolicy,
  updateChannelBrief,
  updateChannelContextSummary,
  updateChannelDecision,
  updateChannelHandoff,
  updateChannelWorkflowStep,
  updateTask,
  updateTaskStatus,
  updateProvider,
} from "../api.js";
import { LanguageSwitcher, useI18n } from "../i18n.js";
import { streamRun } from "../sse.js";
import type {
  ApprovalRequest,
  ApprovalPolicy,
  ApprovalPolicyFormState,
  ChannelAttachment,
  ChannelBrief,
  Channel,
  ChannelContextSummary,
  ChannelDecision,
  ChannelFormState,
  ChannelHandoff,
  ChannelHandoffStatus,
  ChannelLinkPreview,
  ChannelMessage,
  ChannelWorkflow,
  ChannelWorkflowStep,
  ChannelWorkflowStepStartMode,
  MediaJob,
  MediaJobFormState,
  ProviderCheckResult,
  ProviderFormState,
  ProviderPreset,
  ProviderTemplate,
  ResourceLease,
  RunArtifact,
  RunEventEnvelope,
  RunFormState,
  RunSession,
  StateTransitionEvent,
  Task,
  TaskEditFormState,
  TaskFormState,
  TaskRunActionState,
  UpdateChannelBriefRequest,
} from "../types.js";
import {
  channelSidebarTarget,
  viewDescription,
  viewTitle,
  type SidebarTarget,
  type SelectedEntity,
  type ViewId,
} from "./view-types.js";
import { ApprovalsPage, type ApprovalResolution } from "../features/approvals/index.js";
import { PageInspector } from "../features/inspector/PageInspector.js";
import { MediaJobsPage } from "../features/media/index.js";
import { SidebarNavigation } from "../features/navigation/SidebarNavigation.js";
import { ProviderSettings, type ProviderBatchResult } from "../features/providers/index.js";
import { RunHistory } from "../features/runs/index.js";
import { SettingsPage } from "../features/settings/index.js";
import type {
  LocalTeammateCreateInput,
  LocalTeammateDraft,
} from "../features/teammates/index.js";
import { AiTeammatesPage } from "../features/teammates/index.js";
import { WorkspaceClientView } from "../features/workspace/index.js";
import {
  approvalPolicyToForm,
  buildRunApprovalSummaries,
  defaultApprovalPolicyForm,
  effectiveApprovalStatus,
  mergeApprovalsForRun,
  upsertApproval,
} from "../lib/approvals.js";
import {
  channelToForm,
  defaultChannelEditForm,
  defaultChannelForm,
} from "../lib/channels.js";
import { deriveChannelRuns } from "../lib/channel-artifacts.js";
import { readDataString } from "../lib/data.js";
import { titleFromPrompt } from "../lib/formatting.js";
import { getViteDefaultWorkspaceCwd, readInitialWorkspaceCwd, readSavedWorkspaceCwd, writeSavedWorkspaceCwd } from "../lib/local-storage.js";
import {
  inferRunStatus,
  readRunProviderPresetId,
  readRunWorkspaceCwd,
} from "../lib/run-evidence.js";
import { defaultTools } from "../lib/tools.js";
import {
  canBatchCheckProvider,
  canUseProviderForRun,
  defaultProviderForm,
  isMediaProvider,
  providerCheckGuidance,
  providerCheckStatusLabel,
  providerPreflightReady,
  providerRunBlockerLabel,
  providerRunPreflightBlocker,
  providerSecretReady,
  providerTemplateToForm,
  providerToForm,
} from "../lib/providers.js";
import { removeRecordKey } from "../lib/records.js";
import { StatusBadge } from "../shared/components/index.js";

const builtinSkillPack = getBuiltinSkillPack(GSTACK_DEFAULT_SKILL_PACK_ID);
const builtinTeammateTemplates = builtinSkillPack?.teammateTemplates ?? [];

const defaultForm: RunFormState = {
  cwd: "",
  providerPresetId: "",
  taskId: `task-${new Date().toISOString().slice(0, 10)}`,
  title: "Inspect Ling Stack workspace",
  prompt: "Inspect the current project structure, give next implementation advice, and do not modify files.",
  provider: "local-relay",
  model: "gpt-5.5",
  baseUrl: "http://127.0.0.1:8317/v1",
  apiKey: "",
  api: "openai-completions",
  tools: defaultTools,
};

const defaultTaskForm: TaskFormState = {
  title: "Inspect workspace",
  prompt: "Inspect the current project structure, give next implementation advice, and do not modify files.",
};

const defaultTaskEditForm: TaskEditFormState = {
  title: "",
  prompt: "",
  status: "todo",
};

const defaultMediaJobForm: MediaJobFormState = {
  providerPresetId: "",
  operation: "image_generate",
  prompt: "Generate a product screenshot style image for the current task.",
  inputText: "{}",
};

function buildContextTaskPrompt(summary: ChannelContextSummary, decisions: readonly ChannelDecision[]): string {
  const activeDecisions = decisions.filter((decision) => summary.decisionIds.includes(decision.id) && decision.status === "active");
  const decisionText = activeDecisions.length > 0
    ? `\n\nActive decisions:\n${activeDecisions.map((decision) => `- ${decision.title}: ${decision.decision}`).join("\n")}`
    : "";
  const criteriaText = summary.acceptanceCriteria.length > 0
    ? `\n\nAcceptance criteria:\n${summary.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
    : "";
  const questionText = summary.openQuestions.length > 0
    ? `\n\nOpen questions:\n${summary.openQuestions.map((item) => `- ${item}`).join("\n")}`
    : "";
  return `Context summary:\n${summary.summary}${decisionText}${criteriaText}${questionText}`;
}

export function AppShell(): JSX.Element {
  const { t } = useI18n();
  const initialWorkspaceCwd = readInitialWorkspaceCwd();
  const [form, setForm] = useState<RunFormState>(() => ({
    ...defaultForm,
    cwd: initialWorkspaceCwd,
    title: t(defaultForm.title),
    prompt: t(defaultForm.prompt),
  }));
  const [activeView, setActiveView] = useState<ViewId>("workspace");
  const [activeSidebarTarget, setActiveSidebarTarget] = useState<SidebarTarget>("workspace");
  const [daemonHealthy, setDaemonHealthy] = useState<boolean | undefined>();
  const [activeRunId, setActiveRunId] = useState("");
  const [lookupRunId, setLookupRunId] = useState("");
  const [run, setRun] = useState<RunSession | undefined>();
  const [runs, setRuns] = useState<readonly RunSession[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [providers, setProviders] = useState<readonly ProviderPreset[]>([]);
  const [providerTemplates, setProviderTemplates] = useState<readonly ProviderTemplate[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [channels, setChannels] = useState<readonly Channel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [localTeammates, setLocalTeammates] = useState<readonly LocalTeammateDraft[]>([]);
  const [pinnedTemplateIds, setPinnedTemplateIds] = useState<readonly string[]>(["engineer"]);
  const [hiddenTemplateIds, setHiddenTemplateIds] = useState<readonly string[]>([]);
  const [channelForm, setChannelForm] = useState<ChannelFormState>(() => ({
    ...defaultChannelForm,
    boundPath: initialWorkspaceCwd,
  }));
  const [channelEditForm, setChannelEditForm] = useState<ChannelFormState>(defaultChannelEditForm);
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskForm, setTaskForm] = useState<TaskFormState>(() => ({
    ...defaultTaskForm,
    title: t(defaultTaskForm.title),
    prompt: t(defaultTaskForm.prompt),
  }));
  const [channelMessages, setChannelMessages] = useState<readonly ChannelMessage[]>([]);
  const [channelAttachments, setChannelAttachments] = useState<readonly ChannelAttachment[]>([]);
  const [channelLinkPreviews, setChannelLinkPreviews] = useState<readonly ChannelLinkPreview[]>([]);
  const [channelArtifactsByRun, setChannelArtifactsByRun] = useState<Record<string, readonly RunArtifact[]>>({});
  const [channelArtifactErrorsByRun, setChannelArtifactErrorsByRun] = useState<Record<string, string>>({});
  const [channelBrief, setChannelBrief] = useState<ChannelBrief | undefined>();
  const [channelDecisions, setChannelDecisions] = useState<readonly ChannelDecision[]>([]);
  const [channelHandoffs, setChannelHandoffs] = useState<readonly ChannelHandoff[]>([]);
  const [channelContextSummaries, setChannelContextSummaries] = useState<readonly ChannelContextSummary[]>([]);
  const [channelWorkflows, setChannelWorkflows] = useState<readonly ChannelWorkflow[]>([]);
  const [channelWorkflowSteps, setChannelWorkflowSteps] = useState<readonly ChannelWorkflowStep[]>([]);
  const [channelMessagesLoading, setChannelMessagesLoading] = useState(false);
  const [channelFilesLoading, setChannelFilesLoading] = useState(false);
  const [channelRunArtifactsLoading, setChannelRunArtifactsLoading] = useState(false);
  const [channelProtocolLoading, setChannelProtocolLoading] = useState(false);
  const [runningWorkflowStepId, setRunningWorkflowStepId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [taskEditForm, setTaskEditForm] = useState<TaskEditFormState>(defaultTaskEditForm);
  const [taskRunProviderId, setTaskRunProviderId] = useState("");
  const [providerForm, setProviderForm] = useState<ProviderFormState>(defaultProviderForm);
  const [editingProviderId, setEditingProviderId] = useState("");
  const [selectedProviderTemplateId, setSelectedProviderTemplateId] = useState("");
  const [providerCheck, setProviderCheck] = useState<ProviderCheckResult | undefined>();
  const [providerCheckTargetId, setProviderCheckTargetId] = useState("");
  const [checkingProviderIds, setCheckingProviderIds] = useState<readonly string[]>([]);
  const [providerBatchResult, setProviderBatchResult] = useState<ProviderBatchResult | undefined>();
  const [providerRepairRunId, setProviderRepairRunId] = useState("");
  const [mediaJobs, setMediaJobs] = useState<readonly MediaJob[]>([]);
  const [mediaJobArtifacts, setMediaJobArtifacts] = useState<Record<string, readonly RunArtifact[]>>({});
  const [mediaJobsLoading, setMediaJobsLoading] = useState(false);
  const [runningMediaJobId, setRunningMediaJobId] = useState("");
  const [mediaJobForm, setMediaJobForm] = useState<MediaJobFormState>(defaultMediaJobForm);
  const [taskRepairRunId, setTaskRepairRunId] = useState("");
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy | undefined>();
  const [approvalPolicyForm, setApprovalPolicyForm] = useState<ApprovalPolicyFormState>(defaultApprovalPolicyForm);
  const [approvalPolicyLoading, setApprovalPolicyLoading] = useState(false);
  const [approvals, setApprovals] = useState<readonly ApprovalRequest[]>([]);
  const [approvalsLoading, setApprovalsLoading] = useState(false);
  const [resolvingApprovals, setResolvingApprovals] = useState<Record<string, ApprovalResolution>>({});
  const [approvalRepairRunId, setApprovalRepairRunId] = useState("");
  const [events, setEvents] = useState<readonly RunEventEnvelope[]>([]);
  const [artifacts, setArtifacts] = useState<readonly RunArtifact[]>([]);
  const [stateTransitions, setStateTransitions] = useState<readonly StateTransitionEvent[]>([]);
  const [resourceLeases, setResourceLeases] = useState<readonly ResourceLease[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [activeTaskRunAction, setActiveTaskRunAction] = useState<TaskRunActionState | undefined>();
  const [selectedMediaJobId, setSelectedMediaJobId] = useState("");
  const [selectedApprovalId, setSelectedApprovalId] = useState("");
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const abortRef = useRef<AbortController | undefined>(undefined);
  const workspaceTimelineLoadRef = useRef("");

  function addLocalTeammate(input: LocalTeammateCreateInput): void {
    setLocalTeammates((currentTeammates) => {
      const baseName = input.displayName.trim() || "Custom teammate";
      const duplicateCount = currentTeammates.filter((teammate) => teammate.displayName === baseName).length;
      const displayName = duplicateCount > 0 ? `${baseName} ${duplicateCount + 1}` : baseName;
      return [
        ...currentTeammates,
        {
          ...input,
          displayName,
          id: `teammate-${Date.now()}`,
          pinned: false,
          hidden: false,
          createdAt: new Date().toISOString(),
        },
      ];
    });
  }

  function removeLocalTeammate(teammateId: string): void {
    setLocalTeammates((currentTeammates) => currentTeammates.filter((teammate) => teammate.id !== teammateId));
  }

  function toggleLocalTeammatePinned(teammateId: string): void {
    setLocalTeammates((currentTeammates) =>
      currentTeammates.map((teammate) => (teammate.id === teammateId ? { ...teammate, pinned: !teammate.pinned } : teammate)),
    );
  }

  function toggleLocalTeammateHidden(teammateId: string): void {
    setLocalTeammates((currentTeammates) =>
      currentTeammates.map((teammate) => (teammate.id === teammateId ? { ...teammate, hidden: !teammate.hidden } : teammate)),
    );
  }

  function toggleTemplatePinned(templateId: string): void {
    setPinnedTemplateIds((currentIds) =>
      currentIds.includes(templateId) ? currentIds.filter((id) => id !== templateId) : [...currentIds, templateId],
    );
  }

  function toggleTemplateHidden(templateId: string): void {
    setHiddenTemplateIds((currentIds) =>
      currentIds.includes(templateId) ? currentIds.filter((id) => id !== templateId) : [...currentIds, templateId],
    );
  }

  function openPlainView(view: ViewId): void {
    if (view === "approvals") {
      setApprovalRepairRunId("");
    }
    setActiveView(view);
    setActiveSidebarTarget(view);
  }

  function openTasksView(): void {
    setActiveView("workspace");
    setActiveSidebarTarget("tasks");
  }

  function selectWorkspaceChannel(channelId: string): void {
    setSelectedChannelId(channelId);
    setTaskRunProviderId("");
    setActiveView("workspace");
    setActiveSidebarTarget(channelSidebarTarget(channelId));
  }

  const resolvingApprovalsRef = useRef<Set<string>>(new Set());

  const assistantText = useMemo(
    () =>
      events
        .filter((event) => event.type === "assistant_text_delta")
        .map((event) => readDataString(event.data, "text"))
        .join(""),
    [events],
  );

  const latestStatus = run?.status ?? inferRunStatus(events, isRunning);
  const activePendingApprovals = useMemo(
    () => approvals.filter((approval) => effectiveApprovalStatus(approval) === "pending" && approval.runId === activeRunId),
    [approvals, activeRunId],
  );
  const activeRunApprovals = useMemo(
    () => buildRunApprovalSummaries(events, approvals, activeRunId),
    [approvals, activeRunId, events],
  );
  const runById = useMemo(() => {
    const items = new Map(runs.map((item) => [item.id, item]));
    if (run) {
      items.set(run.id, run);
    }
    return items;
  }, [run, runs]);
  const selectedWorkspaceTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0],
    [selectedTaskId, tasks],
  );
  const channelRunsForArtifacts = useMemo(
    () => deriveChannelRuns(selectedChannelId, tasks, runs, run),
    [run, runs, selectedChannelId, tasks],
  );
  const channelRunArtifactsKey = useMemo(
    () => channelRunsForArtifacts.map((item) => `${item.id}:${item.updatedAt}`).join("|"),
    [channelRunsForArtifacts],
  );
  const selectedEntity = useMemo<SelectedEntity>(() => {
    if (activeView === "providers") {
      return { type: "provider", id: editingProviderId || form.providerPresetId || providers[0]?.id || "" };
    }
    if (activeView === "media") {
      return { type: "mediaJob", id: selectedMediaJobId || mediaJobs[0]?.id || "" };
    }
    if (activeView === "approvals") {
      return { type: "approval", id: selectedApprovalId || approvals[0]?.id || "" };
    }
    if (activeView === "runs" && activeRunId) {
      return { type: "run", id: activeRunId };
    }
    if (activeView === "workspace" && selectedWorkspaceTask) {
      return { type: "task", id: selectedWorkspaceTask.id };
    }
    return { type: "workspace" };
  }, [
    activeRunId,
    activeView,
    approvals,
    editingProviderId,
    form.providerPresetId,
    mediaJobs,
    providers,
    selectedApprovalId,
    selectedMediaJobId,
    selectedWorkspaceTask,
  ]);
  const workspaceTimelineRunId = useMemo(() => {
    if (isRunning && activeRunId) {
      return activeRunId;
    }
    return selectedWorkspaceTask?.currentRunId || activeRunId || runs[0]?.id || "";
  }, [activeRunId, isRunning, runs, selectedWorkspaceTask]);
  const providerRepairRun = providerRepairRunId ? runById.get(providerRepairRunId) : undefined;
  const taskRepairRun = taskRepairRunId ? runById.get(taskRepairRunId) : undefined;
  const approvalRepairRun = approvalRepairRunId ? runById.get(approvalRepairRunId) : undefined;

  useEffect(() => {
    void refreshHealth();
    void refreshProviderTemplates();
    void refreshProviders();
  }, []);

  useEffect(() => {
    if (activeView === "workspace") {
      void refreshChannels();
      void refreshRuns();
      void refreshApprovals();
    }
    if (activeView === "runs") {
      void refreshRuns();
    }
    if (activeView === "providers") {
      void refreshProviderTemplates();
      void refreshProviders();
    }
    if (activeView === "media") {
      void refreshProviders();
      void refreshMediaJobs();
    }
    if (activeView === "approvals") {
      void refreshApprovals();
    }
    if (activeView === "settings") {
      void refreshApprovalPolicy();
    }
  }, [activeView]);

  useEffect(() => {
    if (selectedChannelId) {
      void refreshTasks(selectedChannelId);
      void refreshChannelMessages(selectedChannelId);
      void refreshChannelFiles(selectedChannelId);
      void refreshChannelProtocol(selectedChannelId);
    } else {
      setTasks([]);
      setChannelMessages([]);
      setChannelAttachments([]);
      setChannelLinkPreviews([]);
      setChannelArtifactsByRun({});
      setChannelArtifactErrorsByRun({});
      setChannelBrief(undefined);
      setChannelDecisions([]);
      setChannelHandoffs([]);
      setChannelContextSummaries([]);
      setChannelWorkflows([]);
      setChannelWorkflowSteps([]);
      setSelectedTaskId("");
    }
  }, [selectedChannelId]);

  useEffect(() => {
    if (activeView !== "workspace") {
      return;
    }
    void refreshChannelRunArtifacts();
  }, [activeView, channelRunArtifactsKey, form.cwd, selectedChannelId]);

  useEffect(() => {
    const cwd = form.cwd.trim();
    if (activeView !== "workspace" || isRunning || !workspaceTimelineRunId || !cwd) {
      return;
    }

    const loadKey = `${cwd}::${workspaceTimelineRunId}`;
    if (workspaceTimelineLoadRef.current === loadKey) {
      return;
    }
    if (run?.id === workspaceTimelineRunId && events.length > 0) {
      workspaceTimelineLoadRef.current = loadKey;
      return;
    }

    workspaceTimelineLoadRef.current = loadKey;
    void loadRun(workspaceTimelineRunId, cwd);
  }, [activeView, events.length, form.cwd, isRunning, run?.id, workspaceTimelineRunId]);

  useEffect(() => {
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    if (!selectedChannel) {
      setChannelEditForm(defaultChannelEditForm);
      return;
    }
    setChannelEditForm(channelToForm(selectedChannel, form.cwd));
  }, [channels, form.cwd, selectedChannelId]);

  useEffect(() => {
    const selectedTask = tasks.find((task) => task.id === selectedTaskId);
    if (!selectedTask) {
      setTaskEditForm(defaultTaskEditForm);
      return;
    }
    setTaskEditForm({
      title: selectedTask.title,
      prompt: selectedTask.prompt,
      status: selectedTask.status,
    });
  }, [selectedTaskId, tasks]);

  useEffect(() => {
    setMediaJobForm((current) => {
      if (current.providerPresetId && providers.some((provider) => provider.id === current.providerPresetId)) {
        return current;
      }
      const firstMediaProvider = providers.find(isMediaProvider);
      return firstMediaProvider ? { ...current, providerPresetId: firstMediaProvider.id } : current;
    });
  }, [providers]);

  useEffect(() => {
    if (selectedMediaJobId && mediaJobs.some((job) => job.id === selectedMediaJobId)) {
      return;
    }
    setSelectedMediaJobId(mediaJobs[0]?.id ?? "");
  }, [mediaJobs, selectedMediaJobId]);

  useEffect(() => {
    if (selectedApprovalId && approvals.some((approval) => approval.id === selectedApprovalId)) {
      return;
    }
    setSelectedApprovalId(approvals[0]?.id ?? "");
  }, [approvals, selectedApprovalId]);

  function updateWorkspaceCwd(cwd: string): void {
    const previousCwd = form.cwd;
    writeSavedWorkspaceCwd(cwd);
    setForm({ ...form, cwd });
    setChannelForm((current) => ({
      ...current,
      boundPath: current.boundPath === previousCwd || !current.boundPath ? cwd : current.boundPath,
    }));
  }

  async function refreshHealth(): Promise<void> {
    try {
      const health = await getDaemonHealth();
      setDaemonHealthy(health.ok);
      const viteDefaultWorkspaceCwd = getViteDefaultWorkspaceCwd();
      const defaultWorkspaceCwd = health.defaultWorkspaceCwd?.trim() || viteDefaultWorkspaceCwd;
      const canApplyDaemonDefault =
        !readSavedWorkspaceCwd() &&
        (!form.cwd.trim() || form.cwd.trim() === viteDefaultWorkspaceCwd);
      if (health.ok && defaultWorkspaceCwd && canApplyDaemonDefault) {
        setForm((current) =>
          current.cwd.trim() && current.cwd.trim() !== viteDefaultWorkspaceCwd
            ? current
            : { ...current, cwd: defaultWorkspaceCwd },
        );
        setChannelForm((current) =>
          current.boundPath.trim() && current.boundPath.trim() !== viteDefaultWorkspaceCwd
            ? current
            : { ...current, boundPath: defaultWorkspaceCwd },
        );
        void Promise.all([
          refreshProviders(defaultWorkspaceCwd),
          refreshChannels(defaultWorkspaceCwd),
          refreshRuns(defaultWorkspaceCwd),
          refreshApprovals(defaultWorkspaceCwd),
        ]).catch((error: unknown) => {
          setErrorMessage(error instanceof Error ? error.message : String(error));
        });
      }
    } catch {
      setDaemonHealthy(false);
    }
  }

  async function startRun(): Promise<void> {
    await runWithRequest(buildRunRequest(form), form.cwd.trim());
  }

  async function runWithRequest(
    requestBody: unknown,
    loadCwd: string,
    afterRunLoaded?: (runId: string) => Promise<void>,
  ): Promise<void> {
    await streamRunRequest(`${daemonBaseUrl}/runs`, requestBody, loadCwd, afterRunLoaded);
  }

  async function streamRunRequest(
    url: string,
    requestBody: unknown,
    loadCwd: string,
    afterRunLoaded?: (runId: string) => Promise<void>,
  ): Promise<void> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setErrorMessage("");
    setEvents([]);
    setArtifacts([]);
    setRun(undefined);
    setActiveRunId("");
    setIsRunning(true);

    try {
      let streamedRunId = "";
      await streamRun(
        url,
        requestBody,
        (message) => {
          if (message.kind === "ready") {
            streamedRunId = message.runId;
            setActiveRunId(message.runId);
            setLookupRunId(message.runId);
            return;
          }
          if (message.event.type === "approval_requested" || message.event.type === "approval_expired") {
            void refreshApprovals(loadCwd, streamedRunId || undefined);
          }
          setEvents((current) => [...current, message.event]);
        },
        controller.signal,
      );

      if (streamedRunId) {
        await loadRun(streamedRunId, loadCwd);
        await refreshRuns(loadCwd);
        await refreshApprovals(loadCwd, streamedRunId);
        await afterRunLoaded?.(streamedRunId);
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setIsRunning(false);
      await refreshHealth();
    }
  }

  async function loadRun(runId = lookupRunId, cwd = form.cwd): Promise<void> {
    if (!runId.trim()) {
      setErrorMessage("请输入 runId");
      return;
    }

    try {
      setErrorMessage("");
      const [runResult, eventResult, artifactResult] = await Promise.all([
        getRun(runId.trim(), cwd),
        getRunEvents(runId.trim(), cwd),
        listRunArtifacts(runId.trim(), cwd),
      ]);
      setRun(runResult);
      setEvents(eventResult.events);
      setArtifacts(artifactResult.artifacts);
      setActiveRunId(runResult.id);
      setLookupRunId(runResult.id);
      await refreshRuntimeState(cwd, runResult);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function refreshRuntimeState(cwd = form.cwd.trim(), sourceRun: RunSession | undefined = run): Promise<void> {
    if (!cwd) {
      setStateTransitions([]);
      setResourceLeases([]);
      return;
    }

    try {
      const transitionRequests: Promise<readonly StateTransitionEvent[]>[] = [];
      if (sourceRun?.id) {
        transitionRequests.push(
          listStateTransitions(cwd, { entityType: "run", entityId: sourceRun.id, limit: 50 }).then((response) => response.transitions),
        );
      }
      const taskTransitionId = sourceRun?.taskId || selectedTaskId;
      if (taskTransitionId) {
        transitionRequests.push(
          listStateTransitions(cwd, { entityType: "task", entityId: taskTransitionId, limit: 50 }).then((response) => response.transitions),
        );
      }
      const [leasesResponse, ...transitionResponses] = await Promise.all([
        listResourceLeases(cwd, { status: "active", limit: 50 }),
        ...transitionRequests,
      ]);
      const uniqueTransitions = new Map<string, StateTransitionEvent>();
      for (const transition of transitionResponses.flat()) {
        uniqueTransitions.set(transition.id, transition);
      }
      setResourceLeases(leasesResponse.leases);
      setStateTransitions([...uniqueTransitions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch {
      setResourceLeases([]);
      setStateTransitions([]);
    }
  }

  async function refreshRuns(cwd = form.cwd.trim()): Promise<void> {
    if (!cwd) {
      setRuns([]);
      return;
    }

    setRunsLoading(true);
    try {
      setErrorMessage("");
      const response = await listRuns(cwd);
      setRuns(response.runs);
      void refreshRuntimeState(cwd);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunsLoading(false);
    }
  }

  async function refreshProviders(cwd = form.cwd.trim()): Promise<void> {
    if (!cwd) {
      setProviders([]);
      return;
    }

    setProvidersLoading(true);
    try {
      setErrorMessage("");
      const response = await listProviders(cwd);
      setProviders(response.providers);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setProvidersLoading(false);
    }
  }

  async function refreshProviderTemplates(): Promise<void> {
    try {
      const response = await listProviderTemplates();
      setProviderTemplates(response.templates);
    } catch {
      setProviderTemplates([]);
    }
  }

  async function refreshMediaJobs(cwd = form.cwd.trim()): Promise<void> {
    if (!cwd) {
      setMediaJobs([]);
      setMediaJobArtifacts({});
      return;
    }

    setMediaJobsLoading(true);
    try {
      setErrorMessage("");
      const response = await listMediaJobs(cwd);
      setMediaJobs(response.mediaJobs);
      setMediaJobArtifacts(await loadMediaJobArtifacts(cwd, response.mediaJobs));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setMediaJobsLoading(false);
    }
  }

  async function loadMediaJobArtifacts(cwd: string, jobs: readonly MediaJob[]): Promise<Record<string, readonly RunArtifact[]>> {
    const jobsWithArtifacts = jobs.filter((job) => job.artifactIds.length > 0);
    if (jobsWithArtifacts.length === 0) {
      return {};
    }
    const entries = await Promise.all(
      jobsWithArtifacts.map(async (job) => {
        const response = await listMediaJobArtifacts(job.id, cwd);
        return [job.id, response.artifacts] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  async function saveMediaJob(): Promise<void> {
    if (!form.cwd.trim()) {
      setErrorMessage("请输入 workspace path");
      return;
    }
    if (!mediaJobForm.providerPresetId) {
      setErrorMessage("请选择 media provider preset");
      return;
    }
    if (!mediaJobForm.prompt.trim()) {
      setErrorMessage("请输入 media prompt");
      return;
    }

    setMediaJobsLoading(true);
    try {
      setErrorMessage("");
      const response = await createMediaJob(form.cwd.trim(), {
        ...mediaJobForm,
        prompt: mediaJobForm.prompt.trim(),
      });
      setSelectedMediaJobId(response.mediaJob.id);
      setMediaJobs((current) => [response.mediaJob, ...current.filter((job) => job.id !== response.mediaJob.id)]);
      setMediaJobArtifacts((current) => ({ ...current, [response.mediaJob.id]: response.artifacts ?? [] }));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setMediaJobsLoading(false);
    }
  }

  async function executeMediaJob(jobId: string): Promise<void> {
    const cwd = form.cwd.trim();
    if (!cwd) {
      setErrorMessage("请输入 workspace path");
      return;
    }

    setRunningMediaJobId(jobId);
    setSelectedMediaJobId(jobId);
    try {
      setErrorMessage("");
      const response = await runMediaJob(cwd, jobId);
      const artifactsResponse = response.mediaJob.artifactIds.length > 0
        ? await listMediaJobArtifacts(response.mediaJob.id, cwd)
        : { artifacts: response.artifacts ?? [] };
      setMediaJobs((current) => current.map((job) => (job.id === response.mediaJob.id ? response.mediaJob : job)));
      setMediaJobArtifacts((current) => ({ ...current, [response.mediaJob.id]: artifactsResponse.artifacts }));
      const mediaApproval = response.approval;
      if (mediaApproval) {
        setApprovals((current) => upsertApproval(current, mediaApproval));
        void refreshApprovals(cwd);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      void refreshMediaJobs(cwd);
    } finally {
      setRunningMediaJobId("");
    }
  }

  async function refreshChannels(cwd = form.cwd.trim()): Promise<void> {
    if (!cwd) {
      setChannels([]);
      setSelectedChannelId("");
      return;
    }

    setChannelsLoading(true);
    try {
      setErrorMessage("");
      const response = await listChannels(cwd);
      setChannels(response.channels);
      setSelectedChannelId((current) => {
        if (response.channels.some((channel) => channel.id === current)) {
          return current;
        }
        return response.channels[0]?.id ?? "";
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelsLoading(false);
    }
  }

  async function refreshTasks(channelId = selectedChannelId): Promise<void> {
    if (!form.cwd.trim() || !channelId) {
      setTasks([]);
      return;
    }

    setTasksLoading(true);
    try {
      setErrorMessage("");
      const response = await listTasks(form.cwd.trim(), channelId);
      setTasks(response.tasks);
      setSelectedTaskId((current) => {
        if (response.tasks.some((task) => task.id === current)) {
          return current;
        }
        return response.tasks[0]?.id ?? "";
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setTasksLoading(false);
    }
  }

  async function refreshChannelMessages(channelId = selectedChannelId): Promise<void> {
    if (!form.cwd.trim() || !channelId) {
      setChannelMessages([]);
      return;
    }

    setChannelMessagesLoading(true);
    try {
      setErrorMessage("");
      const response = await listChannelMessages(form.cwd.trim(), channelId);
      setChannelMessages(response.messages);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelMessagesLoading(false);
    }
  }

  async function refreshChannelFiles(channelId = selectedChannelId): Promise<void> {
    if (!form.cwd.trim() || !channelId) {
      setChannelAttachments([]);
      setChannelLinkPreviews([]);
      return;
    }

    setChannelFilesLoading(true);
    try {
      setErrorMessage("");
      const [attachmentsResponse, linksResponse] = await Promise.all([
        listChannelAttachments(form.cwd.trim(), channelId),
        listChannelLinkPreviews(form.cwd.trim(), channelId),
      ]);
      setChannelAttachments(attachmentsResponse.attachments);
      setChannelLinkPreviews(linksResponse.linkPreviews);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelFilesLoading(false);
    }
  }

  async function refreshChannelRunArtifacts(
    cwd = form.cwd.trim(),
    channelRuns = channelRunsForArtifacts,
  ): Promise<void> {
    if (!cwd || !selectedChannelId || channelRuns.length === 0) {
      setChannelArtifactsByRun({});
      setChannelArtifactErrorsByRun({});
      setChannelRunArtifactsLoading(false);
      return;
    }

    setChannelRunArtifactsLoading(true);
    const results = await Promise.all(
      channelRuns.map(async (sourceRun) => {
        try {
          const response = await listRunArtifacts(sourceRun.id, cwd);
          return { runId: sourceRun.id, artifacts: response.artifacts } as const;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { runId: sourceRun.id, error: message } as const;
        }
      }),
    );

    const nextArtifacts: Record<string, readonly RunArtifact[]> = {};
    const nextErrors: Record<string, string> = {};
    for (const result of results) {
      if ("artifacts" in result) {
        nextArtifacts[result.runId] = result.artifacts ?? [];
      } else {
        nextErrors[result.runId] = result.error;
      }
    }
    setChannelArtifactsByRun(nextArtifacts);
    setChannelArtifactErrorsByRun(nextErrors);
    setChannelRunArtifactsLoading(false);
  }

  async function refreshChannelProtocol(channelId = selectedChannelId): Promise<void> {
    if (!form.cwd.trim() || !channelId) {
      setChannelBrief(undefined);
      setChannelDecisions([]);
      setChannelHandoffs([]);
      setChannelContextSummaries([]);
      setChannelWorkflows([]);
      setChannelWorkflowSteps([]);
      return;
    }

    setChannelProtocolLoading(true);
    try {
      setErrorMessage("");
      const [briefResponse, decisionsResponse, handoffsResponse, summariesResponse, workflowsResponse] = await Promise.all([
        getChannelBrief(form.cwd.trim(), channelId),
        listChannelDecisions(form.cwd.trim(), channelId),
        listChannelHandoffs(form.cwd.trim(), channelId),
        listChannelContextSummaries(form.cwd.trim(), channelId),
        listChannelWorkflows(form.cwd.trim(), channelId),
      ]);
      const workflowSteps = await loadWorkflowSteps(form.cwd.trim(), workflowsResponse.workflows);
      setChannelBrief(briefResponse.brief);
      setChannelDecisions(decisionsResponse.decisions);
      setChannelHandoffs(handoffsResponse.handoffs);
      setChannelContextSummaries(summariesResponse.contextSummaries);
      setChannelWorkflows(workflowsResponse.workflows);
      setChannelWorkflowSteps(workflowSteps);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChannelProtocolLoading(false);
    }
  }

  async function loadWorkflowSteps(cwd: string, workflows: readonly ChannelWorkflow[]): Promise<readonly ChannelWorkflowStep[]> {
    if (workflows.length === 0) {
      return [];
    }
    const stepResponses = await Promise.all(workflows.map((workflow) => listChannelWorkflowSteps(cwd, workflow.id)));
    return stepResponses.flatMap((response) => response.workflowSteps);
  }

  async function saveChannel(): Promise<void> {
    if (!form.cwd.trim()) {
      setErrorMessage("请输入 workspace path");
      return;
    }
    if (!channelForm.name.trim()) {
      setErrorMessage("请输入 channel name");
      return;
    }

    try {
      setErrorMessage("");
      const response = await createChannel(form.cwd.trim(), channelForm);
      setSelectedChannelId(response.channel.id);
      setActiveSidebarTarget(channelSidebarTarget(response.channel.id));
      setChannelForm((current) => ({
        ...current,
        name: "",
        defaultProviderPresetId: (current.defaultProviderPresetId || response.channel.defaultProviderPresetId) ?? "",
      }));
      await refreshChannels();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function saveDefaultChannel(): Promise<void> {
    if (!form.cwd.trim()) {
      setErrorMessage("请输入 workspace path");
      return;
    }

    const readyProvider = providers.find(providerPreflightReady);
    try {
      setErrorMessage("");
      const response = await createChannel(form.cwd.trim(), {
        name: channelForm.name.trim() || "Engineering",
        status: channelForm.status,
        boundPath: channelForm.boundPath.trim() || form.cwd.trim(),
        defaultProviderPresetId: readyProvider?.id ?? channelForm.defaultProviderPresetId,
        defaultTeammateId: channelForm.defaultTeammateId || "engineer",
        allowedTools: channelForm.allowedTools.length > 0 ? channelForm.allowedTools : defaultTools,
        runtimePolicy: channelForm.runtimePolicy,
      });
      setSelectedChannelId(response.channel.id);
      setActiveSidebarTarget(channelSidebarTarget(response.channel.id));
      setTaskRunProviderId("");
      if (readyProvider) {
        applyProviderToRun(readyProvider);
      }
      setChannelForm((current) => ({
        ...current,
        name: "",
        boundPath: current.boundPath || form.cwd.trim(),
        defaultProviderPresetId: readyProvider?.id ?? current.defaultProviderPresetId,
        defaultTeammateId: current.defaultTeammateId || "engineer",
      }));
      await refreshChannels();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function saveChannelEdit(channelId: string): Promise<void> {
    if (!form.cwd.trim()) {
      setErrorMessage("请输入 workspace path");
      return;
    }
    if (!channelEditForm.name.trim()) {
      setErrorMessage("请输入 channel name");
      return;
    }
    if (channelEditForm.allowedTools.length === 0) {
      setErrorMessage("请至少选择一个 allowed tool");
      return;
    }

    try {
      setErrorMessage("");
      const response = await updateChannel(form.cwd.trim(), channelId, channelEditForm);
      setSelectedChannelId(response.channel.id);
      setTaskRunProviderId("");
      setChannelEditForm(channelToForm(response.channel, form.cwd));
      await refreshChannels();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function removeChannel(channelId: string): Promise<void> {
    try {
      setErrorMessage("");
      await deleteChannel(form.cwd.trim(), channelId);
      if (selectedChannelId === channelId) {
        setSelectedChannelId("");
      }
      if (activeSidebarTarget === channelSidebarTarget(channelId)) {
        setActiveSidebarTarget("workspace");
      }
      await refreshChannels();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveTask(): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }
    if (!taskForm.prompt.trim()) {
      setErrorMessage("请输入 task prompt");
      return;
    }

    try {
      setErrorMessage("");
      const response = await createTask(form.cwd.trim(), selectedChannelId, {
        title: taskForm.title.trim() || titleFromPrompt(taskForm.prompt),
        prompt: taskForm.prompt,
        assigneeTeammateId: taskForm.assigneeTeammateId || channels.find((channel) => channel.id === selectedChannelId)?.defaultTeammateId,
      });
      setSelectedTaskId(response.task.id);
      setTaskForm(defaultTaskForm);
      await refreshTasks(selectedChannelId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendChannelMessage(input: {
    readonly body: string;
    readonly mentions: readonly { readonly id: string; readonly label: string; readonly kind: "ai-teammate" | "local-user" | "channel" }[];
    readonly attachmentIds: readonly string[];
    readonly linkPreviewIds: readonly string[];
    readonly requestAiReply: boolean;
  }): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    const firstAiMention = input.mentions.find((mention) => mention.kind === "ai-teammate");
    try {
      setErrorMessage("");
      const response = await createChannelMessage(form.cwd.trim(), selectedChannelId, {
        body: input.body,
        mentions: input.mentions,
        attachmentIds: input.attachmentIds,
        linkPreviewIds: input.linkPreviewIds,
        requestAiReply: input.requestAiReply,
        providerPresetId: taskRunProviderId || selectedChannel?.defaultProviderPresetId || form.providerPresetId || undefined,
        teammateId: firstAiMention?.id || selectedChannel?.defaultTeammateId,
      });
      setChannelMessages((current) => [
        ...current,
        response.message,
        ...(response.aiReply ? [response.aiReply] : []),
      ]);
      await refreshChannelFiles(selectedChannelId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function uploadChannelFiles(files: readonly File[]): Promise<readonly ChannelAttachment[]> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return [];
    }
    if (files.length === 0) {
      return [];
    }

    setChannelFilesLoading(true);
    try {
      setErrorMessage("");
      const responses = await Promise.all(files.map((file) => uploadChannelAttachment(form.cwd.trim(), selectedChannelId, file)));
      const uploaded = responses.map((response) => response.attachment);
      setChannelAttachments((current) => [...uploaded, ...current]);
      return uploaded;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setChannelFilesLoading(false);
    }
  }

  async function addChannelLinkPreview(url: string): Promise<ChannelLinkPreview | undefined> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return undefined;
    }
    try {
      setErrorMessage("");
      const response = await createChannelLinkPreview(form.cwd.trim(), selectedChannelId, { url });
      setChannelLinkPreviews((current) => [
        response.linkPreview,
        ...current.filter((preview) => preview.id !== response.linkPreview.id),
      ]);
      return response.linkPreview;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function removeChannelAttachment(attachmentId: string): Promise<void> {
    try {
      setErrorMessage("");
      await deleteChannelAttachment(form.cwd.trim(), attachmentId);
      setChannelAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function createTaskFromChannelMessage(message: ChannelMessage): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    const firstAiMention = message.mentions.find((mention) => mention.kind === "ai-teammate");
    try {
      setErrorMessage("");
      const response = await createTask(form.cwd.trim(), selectedChannelId, {
        title: titleFromPrompt(message.body),
        prompt: message.body,
        assigneeTeammateId: firstAiMention?.id || selectedChannel?.defaultTeammateId,
      });
      setSelectedTaskId(response.task.id);
      await createChannelMessage(form.cwd.trim(), selectedChannelId, {
        body: `Created task: ${response.task.title}`,
        kind: "task_link",
        intent: "task",
        authorType: "system",
        linkedTaskId: response.task.id,
      });
      await Promise.all([refreshTasks(selectedChannelId), refreshChannelMessages(selectedChannelId)]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function saveChannelBrief(input: UpdateChannelBriefRequest): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }
    try {
      setErrorMessage("");
      const response = await updateChannelBrief(form.cwd.trim(), selectedChannelId, input);
      setChannelBrief(response.brief);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function recordDecisionFromMessage(message: ChannelMessage): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }
    try {
      setErrorMessage("");
      const response = await createChannelDecision(form.cwd.trim(), selectedChannelId, {
        sourceMessageId: message.id,
        title: titleFromPrompt(message.body),
        decision: message.body,
        rationale: "Recorded from channel discussion.",
        alternatives: [],
        createdBy: "local-user",
      });
      setChannelDecisions((current) => [response.decision, ...current]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function supersedeChannelDecision(decision: ChannelDecision): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }
    try {
      setErrorMessage("");
      await createChannelDecision(form.cwd.trim(), selectedChannelId, {
        title: `${decision.title} update`,
        decision: decision.decision,
        rationale: "Supersedes the previous active decision.",
        alternatives: decision.alternatives,
        supersedesDecisionId: decision.id,
        createdBy: "local-user",
      });
      await refreshChannelProtocol(selectedChannelId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function rejectChannelDecision(decision: ChannelDecision): Promise<void> {
    try {
      setErrorMessage("");
      const response = await updateChannelDecision(form.cwd.trim(), decision.id, { status: "rejected" });
      setChannelDecisions((current) => current.map((item) => item.id === response.decision.id ? response.decision : item));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function createHandoffFromMessage(message: ChannelMessage): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    const teammateId = selectedChannel?.defaultTeammateId ?? "engineer";
    try {
      setErrorMessage("");
      const response = await createChannelHandoff(form.cwd.trim(), selectedChannelId, {
        sourceMessageId: message.id,
        fromParticipantId: "local-user",
        fromParticipantLabel: "Tian",
        toParticipantId: teammateId,
        toParticipantLabel: teammateId,
        reason: titleFromPrompt(message.body),
        requiredInput: message.body,
        expectedOutput: "Reply with the next concrete step.",
        createdBy: "local-user",
      });
      setChannelHandoffs((current) => [response.handoff, ...current]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function createHandoffFromTask(task: Task): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    const teammateId = task.assigneeTeammateId ?? selectedChannel?.defaultTeammateId ?? "engineer";
    try {
      setErrorMessage("");
      const response = await createChannelHandoff(form.cwd.trim(), selectedChannelId, {
        sourceTaskId: task.id,
        fromParticipantId: "local-user",
        fromParticipantLabel: "Tian",
        toParticipantId: teammateId,
        toParticipantLabel: teammateId,
        reason: task.title,
        requiredInput: task.prompt,
        expectedOutput: "Complete or report blocker for this task.",
        createdBy: "local-user",
      });
      setChannelHandoffs((current) => [response.handoff, ...current]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function updateHandoffStatusValue(handoff: ChannelHandoff, status: ChannelHandoffStatus): Promise<void> {
    try {
      setErrorMessage("");
      const response = await updateChannelHandoff(form.cwd.trim(), handoff.id, { status });
      setChannelHandoffs((current) => current.map((item) => item.id === response.handoff.id ? response.handoff : item));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function startWorkflowFromHandoff(handoff: ChannelHandoff): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }

    try {
      setErrorMessage("");
      const response = await createChannelWorkflowFromHandoff(form.cwd.trim(), handoff.id, {
        title: `${handoff.reason || "Handoff"} workflow`,
        objective: handoff.expectedOutput || handoff.requiredInput || handoff.reason,
        createdBy: "local-user",
      });
      setChannelWorkflows((current) => [response.workflow, ...current.filter((item) => item.id !== response.workflow.id)]);
      const createdStep = response.workflowStep;
      if (createdStep) {
        setChannelWorkflowSteps((current) => [createdStep, ...current.filter((item) => item.id !== createdStep.id)]);
      }
      await refreshChannelProtocol(selectedChannelId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function startWorkflowStepAction(step: ChannelWorkflowStep, mode: ChannelWorkflowStepStartMode): Promise<void> {
    const workspaceCwd = form.cwd.trim();
    if (!workspaceCwd) {
      setErrorMessage("请输入 workspace path");
      return;
    }
    const workflow = channelWorkflows.find((item) => item.id === step.workflowId);
    const channel = workflow ? channels.find((item) => item.id === workflow.channelId) : channels.find((item) => item.id === step.channelId);
    const providerPresetId = taskRunProviderId || channel?.defaultProviderPresetId || form.providerPresetId || providers.find(providerPreflightReady)?.id;
    const request = {
      mode,
      providerPresetId,
      assigneeTeammateId: step.toParticipantId,
    };

    setRunningWorkflowStepId(step.id);
    try {
      setErrorMessage("");
      if (mode === "create_task") {
        const response = await startChannelWorkflowStep(workspaceCwd, step.id, request);
        if (response.workflow) {
          setChannelWorkflows((current) => current.map((item) => item.id === response.workflow?.id ? response.workflow : item));
        }
        setChannelWorkflowSteps((current) => current.map((item) => item.id === response.workflowStep.id ? response.workflowStep : item));
        const createdTask = response.task;
        if (createdTask) {
          setSelectedTaskId(createdTask.id);
          setTasks((current) => [createdTask, ...current.filter((item) => item.id !== createdTask.id)]);
        }
        if (response.blocker) {
          setErrorMessage(response.blocker);
        }
        await Promise.all([refreshTasks(step.channelId), refreshChannelProtocol(step.channelId), refreshRuntimeState(workspaceCwd)]);
        return;
      }

      const url = `${daemonBaseUrl}/workflow-steps/${encodeURIComponent(step.id)}/start?cwd=${encodeURIComponent(workspaceCwd)}`;
      await streamRunRequest(url, request, workspaceCwd, async () => {
        await Promise.all([
          refreshTasks(step.channelId),
          refreshChannelProtocol(step.channelId),
        ]);
      });
      await Promise.all([refreshTasks(step.channelId), refreshChannelProtocol(step.channelId), refreshRuntimeState(workspaceCwd)]);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunningWorkflowStepId((current) => current === step.id ? "" : current);
    }
  }

  async function updateWorkflowStepStatus(step: ChannelWorkflowStep, status: "skipped" | "cancelled"): Promise<void> {
    try {
      setErrorMessage("");
      const response = await updateChannelWorkflowStep(form.cwd.trim(), step.id, { status });
      setChannelWorkflowSteps((current) => current.map((item) => item.id === response.workflowStep.id ? response.workflowStep : item));
      if (response.workflow) {
        setChannelWorkflows((current) => current.map((item) => item.id === response.workflow?.id ? response.workflow : item));
      }
      await refreshChannelProtocol(step.channelId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function createTaskWithContextFromMessage(message: ChannelMessage): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    const activeDecisionIds = channelDecisions.filter((decision) => decision.status === "active").map((decision) => decision.id);
    try {
      setErrorMessage("");
      const summaryResponse = await createChannelContextSummary(form.cwd.trim(), selectedChannelId, {
        targetType: "thread",
        targetId: message.threadId ?? message.id,
        sourceMessageIds: [message.id],
        decisionIds: activeDecisionIds,
        summary: message.body,
        acceptanceCriteria: [],
        openQuestions: [],
        authorType: "local-user",
        authorId: "local-user",
      });
      setChannelContextSummaries((current) => [summaryResponse.contextSummary, ...current]);
      const taskResponse = await createTask(form.cwd.trim(), selectedChannelId, {
        title: titleFromPrompt(message.body),
        prompt: buildContextTaskPrompt(summaryResponse.contextSummary, channelDecisions),
        assigneeTeammateId: selectedChannel?.defaultTeammateId,
      });
      setSelectedTaskId(taskResponse.task.id);
      await refreshTasks(selectedChannelId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function createTaskFromContextSummary(summary: ChannelContextSummary): Promise<void> {
    if (!selectedChannelId) {
      setErrorMessage("请先选择 channel");
      return;
    }
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    try {
      setErrorMessage("");
      const response = await createTask(form.cwd.trim(), selectedChannelId, {
        title: titleFromPrompt(summary.summary),
        prompt: buildContextTaskPrompt(summary, channelDecisions),
        assigneeTeammateId: selectedChannel?.defaultTeammateId,
      });
      setSelectedTaskId(response.task.id);
      await refreshTasks(selectedChannelId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function removeTask(taskId: string): Promise<void> {
    try {
      setErrorMessage("");
      await deleteTask(form.cwd.trim(), taskId);
      if (selectedTaskId === taskId) {
        setSelectedTaskId("");
      }
      await refreshTasks();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function moveTaskToReview(taskId: string): Promise<void> {
    try {
      setErrorMessage("");
      await updateTaskStatus(form.cwd.trim(), taskId, "review");
      await refreshTasks();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveTaskEdit(taskId: string): Promise<Task | undefined> {
    if (!taskEditForm.title.trim()) {
      setErrorMessage("请输入 task title");
      return undefined;
    }
    if (!taskEditForm.prompt.trim()) {
      setErrorMessage("请输入 task prompt");
      return undefined;
    }

    try {
      setErrorMessage("");
      const response = await updateTask(form.cwd.trim(), taskId, {
        ...taskEditForm,
        title: taskEditForm.title.trim(),
        prompt: taskEditForm.prompt.trim(),
      });
      await refreshTasks();
      return response.task;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  function resolveTaskRunProviderPresetId(channel: Channel | undefined): string {
    return taskRunProviderId || channel?.defaultProviderPresetId || form.providerPresetId || providers.find(providerPreflightReady)?.id || "";
  }

  async function runPersistedTask(
    task: Task,
    options: { readonly skipPreflight?: boolean; readonly action?: TaskRunActionState["action"] } = {},
  ): Promise<boolean> {
    const action = options.action ?? "run";
    setActiveTaskRunAction({ taskId: task.id, action });
    try {
      const channel = channels.find((item) => item.id === task.channelId);
      if (!channel) {
        setErrorMessage("找不到 task 所属 channel");
        return false;
      }
      if (channel.status !== "active") {
        setErrorMessage(`Channel is ${channel.status}; resume it before starting a new run.`);
        return false;
      }
      const providerPresetId = resolveTaskRunProviderPresetId(channel);
      if (!providerPresetId) {
        setErrorMessage("请先选择 provider preset");
        return false;
      }
      const provider = providers.find((item) => item.id === providerPresetId);
      if (!provider || !canUseProviderForRun(provider)) {
        setErrorMessage(provider ? `Provider preset is not runnable: ${providerRunBlockerLabel(provider)}` : "找不到 provider preset");
        return false;
      }
      if (!options.skipPreflight) {
        const blocker = providerRunPreflightBlocker(provider);
        if (blocker) {
          setErrorMessage(blocker);
          return false;
        }
      }

      const runCwd = form.cwd.trim();
      await runWithRequest(buildTaskRunRequest(runCwd, task, channel, providerPresetId), runCwd, async () => {
        await refreshTasks(task.channelId);
      });
      return true;
    } finally {
      setActiveTaskRunAction((current) =>
        current?.taskId === task.id && current.action === action ? undefined : current,
      );
    }
  }

  async function checkThenRunPersistedTask(task: Task): Promise<boolean> {
    setActiveTaskRunAction({ taskId: task.id, action: "check" });
    const channel = channels.find((item) => item.id === task.channelId);
    const providerPresetId = resolveTaskRunProviderPresetId(channel);
    const provider = providerPresetId ? providers.find((item) => item.id === providerPresetId) : undefined;
    if (!provider) {
      setErrorMessage(providerPresetId ? "找不到 provider preset" : "请先选择 provider preset");
      setActiveTaskRunAction(undefined);
      return false;
    }
    if (!(await checkProviderForRun(provider))) {
      setActiveTaskRunAction(undefined);
      return false;
    }
    return await runPersistedTask(task, { skipPreflight: true, action: "check" });
  }

  async function runUpdatedTaskFromRepair(task: Task): Promise<void> {
    const updatedTask = await saveTaskEdit(task.id);
    if (!updatedTask) {
      return;
    }
    if (await runPersistedTask(updatedTask)) {
      setTaskRepairRunId("");
    }
  }

  async function checkThenRunUpdatedTaskFromRepair(task: Task): Promise<void> {
    const updatedTask = await saveTaskEdit(task.id);
    if (!updatedTask) {
      return;
    }
    if (await checkThenRunPersistedTask(updatedTask)) {
      setTaskRepairRunId("");
    }
  }

  async function checkProviderForRun(provider: ProviderPreset): Promise<boolean> {
    if (!canBatchCheckProvider(provider)) {
      setErrorMessage(`Provider preset is not runnable: ${providerRunBlockerLabel(provider)}`);
      return false;
    }

    try {
      setErrorMessage("");
      setProviderBatchResult(undefined);
      setCheckingProviderIds([provider.id]);
      setProviderCheckTargetId(provider.id);
      const result = await checkProvider(form.cwd.trim(), provider.id);
      setProviderCheck(result);
      await refreshProviders();
      if (!result.ok) {
        setErrorMessage(`${provider.displayName}: provider check failed (${providerCheckStatusLabel(result)}). ${providerCheckGuidance(result, provider)}`);
        return false;
      }
      return true;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setCheckingProviderIds([]);
    }
  }

  async function rerunRun(sourceRun: RunSession): Promise<void> {
    try {
      const workspaceCwd = readRunWorkspaceCwd(sourceRun, form.cwd.trim());
      await runWithRequest(buildRerunRequest(sourceRun), workspaceCwd);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshApprovals(cwd = form.cwd.trim(), runId?: string): Promise<void> {
    if (!cwd.trim()) {
      setApprovals([]);
      return;
    }

    setApprovalsLoading(true);
    try {
      setErrorMessage("");
      const response = await listApprovals(cwd.trim(), { runId });
      setApprovals((current) => (runId ? mergeApprovalsForRun(current, response.approvals, runId) : response.approvals));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setApprovalsLoading(false);
    }
  }

  async function refreshApprovalPolicy(): Promise<void> {
    if (!form.cwd.trim()) {
      setApprovalPolicy(undefined);
      return;
    }

    setApprovalPolicyLoading(true);
    try {
      setErrorMessage("");
      const response = await getApprovalPolicy(form.cwd.trim());
      setApprovalPolicy(response.policy);
      setApprovalPolicyForm(approvalPolicyToForm(response.policy));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setApprovalPolicyLoading(false);
    }
  }

  async function saveApprovalPolicy(): Promise<void> {
    if (!form.cwd.trim()) {
      setErrorMessage("请输入 workspace path");
      return;
    }

    setApprovalPolicyLoading(true);
    try {
      setErrorMessage("");
      const response = await updateApprovalPolicy(form.cwd.trim(), approvalPolicyForm);
      setApprovalPolicy(response.policy);
      setApprovalPolicyForm(approvalPolicyToForm(response.policy));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setApprovalPolicyLoading(false);
    }
  }

  async function resolveApproval(approvalId: string, decision: ApprovalResolution, reason?: string): Promise<void> {
    if (resolvingApprovalsRef.current.has(approvalId)) {
      return;
    }

    resolvingApprovalsRef.current.add(approvalId);
    setResolvingApprovals((current) => ({ ...current, [approvalId]: decision }));
    try {
      setErrorMessage("");
      const approvalBeforeResolution =
        approvals.find((approval) => approval.id === approvalId) ?? activeRunApprovals.find((approval) => approval.id === approvalId);
      const response =
        decision === "approve"
          ? await approveApproval(form.cwd.trim(), approvalId, reason)
          : await denyApproval(form.cwd.trim(), approvalId, reason);
      setSelectedApprovalId(response.approval.id);
      setApprovals((current) => upsertApproval(current, response.approval));

      const resolvedRunId = response.approval.runId || approvalBeforeResolution?.runId;
      const resolvedMediaJobId = response.approval.mediaJobId || approvalBeforeResolution?.mediaJobId;
      const workspaceCwd = form.cwd.trim();
      await refreshApprovals(workspaceCwd, resolvedRunId);
      if (resolvedRunId && (resolvedRunId === activeRunId || resolvedRunId === lookupRunId || resolvedRunId === approvalRepairRunId)) {
        await Promise.all([loadRun(resolvedRunId, workspaceCwd), refreshRuns(workspaceCwd)]);
        window.setTimeout(() => {
          void loadRun(resolvedRunId, workspaceCwd);
          void refreshRuns(workspaceCwd);
          void refreshApprovals(workspaceCwd, resolvedRunId);
        }, 750);
      }
      if (resolvedMediaJobId) {
        await refreshMediaJobs(workspaceCwd);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      resolvingApprovalsRef.current.delete(approvalId);
      setResolvingApprovals((current) => removeRecordKey(current, approvalId));
    }
  }

  async function saveProvider(nextProviderForm = providerForm): Promise<ProviderPreset | undefined> {
    if (!form.cwd.trim()) {
      setErrorMessage("请输入 workspace path");
      return undefined;
    }

    try {
      setErrorMessage("");
      setProviderCheck(undefined);
      setProviderCheckTargetId("");
      setProviderBatchResult(undefined);
      const response = editingProviderId
        ? await updateProvider(form.cwd.trim(), editingProviderId, nextProviderForm)
        : await createProvider(form.cwd.trim(), nextProviderForm);
      setEditingProviderId(response.provider.id);
      setProviderForm({
        ...providerToForm(response.provider),
        apiKey: nextProviderForm.clearApiKey ? "" : nextProviderForm.apiKey,
      });
      await refreshProviders();
      applyProviderToRun(response.provider);
      return response.provider;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  async function saveAndCheckProvider(): Promise<void> {
    const savedProvider = await saveProvider({ ...providerForm, enabled: true });
    if (!savedProvider) {
      return;
    }

    try {
      setErrorMessage("");
      setProviderBatchResult(undefined);
      setCheckingProviderIds([savedProvider.id]);
      setProviderCheckTargetId(savedProvider.id);
      const result = await checkProvider(form.cwd.trim(), savedProvider.id);
      setProviderCheck(result);
      await refreshProviders();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckingProviderIds([]);
    }
  }

  async function clearProviderKey(): Promise<void> {
    if (!editingProviderId) {
      setProviderForm((current) => ({ ...current, apiKey: "", apiKeyRef: "", clearApiKey: false }));
      return;
    }
    await saveProvider({ ...providerForm, apiKey: "", apiKeyRef: "", clearApiKey: true });
  }

  async function removeProvider(providerId: string): Promise<void> {
    try {
      setErrorMessage("");
      setProviderCheck(undefined);
      setProviderCheckTargetId("");
      setProviderBatchResult(undefined);
      await deleteProvider(form.cwd.trim(), providerId);
      if (editingProviderId === providerId) {
        setEditingProviderId("");
        setProviderForm(defaultProviderForm);
      }
      if (form.providerPresetId === providerId) {
        setForm((current) => ({ ...current, providerPresetId: "" }));
      }
      await refreshProviders();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function runProviderCheck(providerId: string): Promise<void> {
    try {
      setErrorMessage("");
      setProviderBatchResult(undefined);
      setCheckingProviderIds([providerId]);
      setProviderCheckTargetId(providerId);
      const provider = providers.find((item) => item.id === providerId);
      if (provider && !provider.enabled && provider.api !== "media-job" && provider.capabilities.includes("chat") && providerSecretReady(provider)) {
        await updateProvider(form.cwd.trim(), providerId, { ...providerToForm(provider), enabled: true });
        if (editingProviderId === providerId) {
          setProviderForm((current) => ({ ...current, enabled: true }));
        }
      }
      const result = await checkProvider(form.cwd.trim(), providerId);
      setProviderCheck(result);
      await refreshProviders();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckingProviderIds([]);
    }
  }

  async function runProviderBatchCheck(): Promise<void> {
    const candidates = providers.filter(canBatchCheckProvider);
    if (candidates.length === 0) {
      setErrorMessage("No enabled chat providers to check.");
      return;
    }

    try {
      setErrorMessage("");
      setProviderCheck(undefined);
      setProviderCheckTargetId("");
      setProviderBatchResult(undefined);
      setCheckingProviderIds(candidates.map((provider) => provider.id));

      let readyCount = 0;
      let failedCount = 0;
      for (const provider of candidates) {
        const result = await checkProvider(form.cwd.trim(), provider.id);
        if (result.ok) {
          readyCount += 1;
        } else {
          failedCount += 1;
        }
      }

      await refreshProviders();
      setProviderBatchResult({
        message: `Checked ${candidates.length} chat providers: ${readyCount} ready, ${failedCount} failed.`,
        failedCount,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCheckingProviderIds([]);
    }
  }

  function editProvider(provider: ProviderPreset): void {
    setEditingProviderId(provider.id);
    setSelectedProviderTemplateId("");
    setProviderCheck(undefined);
    setProviderCheckTargetId("");
    setProviderBatchResult(undefined);
    setProviderForm(providerToForm(provider));
  }

  function applyProviderToRun(provider: ProviderPreset): void {
    setForm((current) => ({
      ...current,
      providerPresetId: provider.id,
      provider: provider.providerId,
      model: provider.model,
      baseUrl: provider.baseUrl ?? "",
      api: provider.api,
    }));
  }

  async function selectRun(runId: string): Promise<void> {
    await loadRun(runId);
    void refreshApprovals(form.cwd.trim(), runId);
  }

  async function openRunFromWorkspace(runId: string): Promise<void> {
    await selectRun(runId);
    openPlainView("runs");
  }

  function openApprovalsFromWorkspace(runId?: string): void {
    const targetRunId = runId || activeRunId || "";
    setApprovalRepairRunId(targetRunId);
    if (targetRunId) {
      void loadRun(targetRunId, form.cwd.trim());
    }
    void refreshApprovals(form.cwd.trim(), targetRunId || undefined);
    setActiveView("approvals");
    setActiveSidebarTarget("approvals");
  }

  function openProvidersFromRun(runToRepair?: RunSession): void {
    const providerPresetId = runToRepair ? readRunProviderPresetId(runToRepair) : "";
    const provider = providerPresetId ? providers.find((item) => item.id === providerPresetId) : undefined;
    if (runToRepair) {
      setProviderRepairRunId(runToRepair.id);
    }
    if (provider) {
      editProvider(provider);
    }
    openPlainView("providers");
  }

  async function openTaskFromRun(runToRepair: RunSession): Promise<void> {
    if (!runToRepair.channelId || !runToRepair.taskId) {
      setErrorMessage("This run is not linked to an editable channel task.");
      return;
    }

    setErrorMessage("");
    setTaskRepairRunId(runToRepair.id);
    setSelectedChannelId(runToRepair.channelId);
    setSelectedTaskId(runToRepair.taskId);
    setTaskRunProviderId("");
    setActiveView("workspace");
    setActiveSidebarTarget(channelSidebarTarget(runToRepair.channelId));
    await refreshTasks(runToRepair.channelId);
    setSelectedTaskId(runToRepair.taskId);
  }

  async function cancelActiveRun(): Promise<void> {
    abortRef.current?.abort();
    if (!activeRunId) {
      setIsRunning(false);
      return;
    }

    try {
      setErrorMessage("");
      const response = await cancelRun(form.cwd.trim(), activeRunId);
      if (response.run) {
        setRun(response.run);
      }
      const eventResult = await getRunEvents(activeRunId, form.cwd.trim());
      setEvents(eventResult.events);
      await refreshRuns();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRunning(false);
      await refreshHealth();
    }
  }

  return (
    <main className={inspectorCollapsed ? "app-shell inspector-collapsed" : "app-shell"}>
      <TopBar daemonHealthy={daemonHealthy} provider={`${form.provider}/${form.model}`} onRefresh={refreshHealth} />
      <SidebarNavigation
        activeSidebarTarget={activeSidebarTarget}
        channels={channels}
        approvals={approvals}
        onOpenView={openPlainView}
        onOpenTasks={openTasksView}
        onSelectChannel={selectWorkspaceChannel}
      />
      <section className={activeView === "workspace" ? "workspace workspace-client-surface" : "workspace"}>
        {activeView === "workspace" ? (
          <WorkspaceClientView
            cwd={form.cwd}
            daemonHealthy={daemonHealthy}
            providerLabel={`${form.provider}/${form.model}`}
            channels={channels}
            selectedChannelId={selectedChannelId}
            channelForm={channelForm}
            tasks={tasks}
            taskForm={taskForm}
            channelMessages={channelMessages}
            channelAttachments={channelAttachments}
            channelLinkPreviews={channelLinkPreviews}
            channelArtifactsByRun={channelArtifactsByRun}
            channelArtifactErrorsByRun={channelArtifactErrorsByRun}
            channelBrief={channelBrief}
            channelDecisions={channelDecisions}
            channelHandoffs={channelHandoffs}
            channelContextSummaries={channelContextSummaries}
            channelWorkflows={channelWorkflows}
            channelWorkflowSteps={channelWorkflowSteps}
            selectedTaskId={selectedTaskId}
            providers={providers}
            teammateTemplates={builtinTeammateTemplates}
            localTeammates={localTeammates}
            taskRunProviderId={taskRunProviderId}
            fallbackProviderId={form.providerPresetId}
            channelsLoading={channelsLoading}
            tasksLoading={tasksLoading}
            channelMessagesLoading={channelMessagesLoading}
            channelFilesLoading={channelFilesLoading}
            channelRunArtifactsLoading={channelRunArtifactsLoading}
            channelProtocolLoading={channelProtocolLoading}
            providersLoading={providersLoading}
            approvals={approvals}
            resourceLeases={resourceLeases}
            runs={runs}
            runById={runById}
            activeRunId={activeRunId}
            latestStatus={latestStatus}
            isRunning={isRunning}
            activeTaskRunAction={activeTaskRunAction}
            runningWorkflowStepId={runningWorkflowStepId}
            errorMessage={errorMessage}
            onCwdChange={updateWorkspaceCwd}
            onChannelFormChange={setChannelForm}
            onTaskFormChange={setTaskForm}
            onProviderSelect={(providerId) => {
              setTaskRunProviderId(providerId);
              const provider = providers.find((item) => item.id === providerId);
              if (provider) {
                applyProviderToRun(provider);
              }
            }}
            onSelectChannel={selectWorkspaceChannel}
            onRefreshChannels={() => void refreshChannels()}
            onCreateDefaultChannel={() => void saveDefaultChannel()}
            onCreateChannel={() => void saveChannel()}
            onCreateTask={() => void saveTask()}
            onSendMessage={sendChannelMessage}
            onUploadAttachments={(files) => uploadChannelFiles(files)}
            onCreateLinkPreview={(url) => addChannelLinkPreview(url)}
            onDeleteAttachment={(attachmentId) => void removeChannelAttachment(attachmentId)}
            onCreateTaskFromMessage={createTaskFromChannelMessage}
            onSaveBrief={(input) => void saveChannelBrief(input)}
            onRecordDecisionFromMessage={(message) => void recordDecisionFromMessage(message)}
            onSupersedeDecision={(decision) => void supersedeChannelDecision(decision)}
            onRejectDecision={(decision) => void rejectChannelDecision(decision)}
            onCreateHandoffFromMessage={(message) => void createHandoffFromMessage(message)}
            onCreateHandoffFromTask={(task) => void createHandoffFromTask(task)}
            onUpdateHandoffStatus={(handoff, status) => void updateHandoffStatusValue(handoff, status)}
            onStartWorkflowFromHandoff={(handoff) => void startWorkflowFromHandoff(handoff)}
            onStartWorkflowStep={(step, mode) => void startWorkflowStepAction(step, mode)}
            onUpdateWorkflowStepStatus={(step, status) => void updateWorkflowStepStatus(step, status)}
            onCreateTaskWithContextFromMessage={(message) => void createTaskWithContextFromMessage(message)}
            onCreateTaskFromContextSummary={(summary) => void createTaskFromContextSummary(summary)}
            onRefreshChannelProtocol={() => void refreshChannelProtocol()}
            onRefreshChannelFiles={() => void Promise.all([refreshChannelFiles(), refreshChannelRunArtifacts()])}
            attachmentContentUrl={(attachment) => channelAttachmentContentUrl(attachment, form.cwd.trim())}
            onRefreshTasks={() => void refreshTasks()}
            onSelectTask={setSelectedTaskId}
            onCheckThenRunTask={(task) => void checkThenRunPersistedTask(task)}
            onRunTask={(task) => void runPersistedTask(task)}
            onOpenRun={(runId) => void openRunFromWorkspace(runId)}
            onOpenApprovals={(runId) => openApprovalsFromWorkspace(runId)}
            onOpenProviders={(sourceRun) => sourceRun ? openProvidersFromRun(sourceRun) : openPlainView("providers")}
          />
        ) : (
          <>
            <div className="workspace-head">
              <div>
                <h1>{t(viewTitle(activeView))}</h1>
                <p>{t(viewDescription(activeView))}</p>
              </div>
              {activeView === "teammates" ? (
                <span className="status-badge succeeded">{GSTACK_DEFAULT_SKILL_PACK_ID}</span>
              ) : (
                <StatusBadge status={latestStatus} />
              )}
            </div>
            {activeView === "teammates" ? (
              <AiTeammatesPage
                skillPack={builtinSkillPack}
                providers={providers}
                channels={channels}
                localTeammates={localTeammates}
                onCreateTeammate={addLocalTeammate}
                onRemoveTeammate={removeLocalTeammate}
                onToggleTeammatePinned={toggleLocalTeammatePinned}
                onToggleTeammateHidden={toggleLocalTeammateHidden}
                onOpenProviders={() => openPlainView("providers")}
              />
            ) : activeView === "runs" ? (
              <RunHistory
                cwd={form.cwd}
                runs={runs}
                selectedRunId={activeRunId}
                selectedRun={run}
                events={events}
                artifacts={artifacts}
                resourceLeases={resourceLeases}
                stateTransitions={stateTransitions}
                assistantText={assistantText}
                approvals={activeRunApprovals}
                approvalsLoading={approvalsLoading}
                resolvingApprovals={resolvingApprovals}
                isLoading={runsLoading}
                isRunning={isRunning}
                errorMessage={errorMessage}
                onCwdChange={(cwd) => {
                  updateWorkspaceCwd(cwd);
                  setRun(undefined);
                  setEvents([]);
                  setArtifacts([]);
                  setActiveRunId("");
                  setLookupRunId("");
                }}
                onRefresh={() => void refreshRuns()}
                onRefreshSelected={() => void loadRun(activeRunId || lookupRunId)}
                onRefreshApprovals={() => void refreshApprovals(form.cwd.trim(), activeRunId || undefined)}
                onRerun={(sourceRun) => void rerunRun(sourceRun)}
                onResolveApproval={(approvalId, decision, reason) => void resolveApproval(approvalId, decision, reason)}
                onOpenProviders={(sourceRun) => openProvidersFromRun(sourceRun)}
                onOpenApprovals={(runId) => openApprovalsFromWorkspace(runId)}
                onEditTask={(sourceRun) => void openTaskFromRun(sourceRun)}
                onSelect={(runId) => void selectRun(runId)}
              />
            ) : activeView === "providers" ? (
              <ProviderSettings
                cwd={form.cwd}
                providers={providers}
                templates={providerTemplates}
                form={providerForm}
                editingProviderId={editingProviderId}
                isLoading={providersLoading}
                checkingProviderIds={checkingProviderIds}
                errorMessage={errorMessage}
                checkResult={providerCheck}
                checkedProviderId={providerCheckTargetId}
                batchResult={providerBatchResult}
                selectedProviderId={form.providerPresetId}
                selectedTemplateId={selectedProviderTemplateId}
                repairRun={providerRepairRun}
                isRunning={isRunning}
                onCwdChange={updateWorkspaceCwd}
                onFormChange={setProviderForm}
                onTemplateSelect={(template) => {
                  setProviderRepairRunId("");
                  setEditingProviderId("");
                  setSelectedProviderTemplateId(template.templateId);
                  setProviderCheck(undefined);
                  setProviderCheckTargetId("");
                  setProviderForm(providerTemplateToForm(template));
                }}
                onNew={() => {
                  setProviderRepairRunId("");
                  setEditingProviderId("");
                  setSelectedProviderTemplateId("");
                  setProviderCheck(undefined);
                  setProviderCheckTargetId("");
                  setProviderForm(defaultProviderForm);
                }}
                onSave={() => void saveProvider()}
                onSaveAndCheck={() => void saveAndCheckProvider()}
                onClearKey={() => void clearProviderKey()}
                onRefresh={() => void refreshProviders()}
                onEdit={editProvider}
                onDelete={(providerId) => void removeProvider(providerId)}
                onCheck={(providerId) => void runProviderCheck(providerId)}
                onCheckBatch={() => void runProviderBatchCheck()}
                onUse={applyProviderToRun}
                onRerun={(sourceRun) => void rerunRun(sourceRun)}
                onOpenRun={(runId) => void openRunFromWorkspace(runId)}
                onClearRepair={() => setProviderRepairRunId("")}
              />
            ) : activeView === "media" ? (
              <MediaJobsPage
                cwd={form.cwd}
                providers={providers}
                jobs={mediaJobs}
                artifactsByJob={mediaJobArtifacts}
                form={mediaJobForm}
                selectedJobId={selectedMediaJobId}
                isLoading={mediaJobsLoading}
                runningJobId={runningMediaJobId}
                errorMessage={errorMessage}
                onCwdChange={updateWorkspaceCwd}
                onFormChange={setMediaJobForm}
                onRefresh={() => void refreshMediaJobs()}
                onCreate={() => void saveMediaJob()}
                onSelectJob={setSelectedMediaJobId}
                onRun={(jobId) => void executeMediaJob(jobId)}
                onOpenProviders={() => openPlainView("providers")}
              />
            ) : activeView === "settings" ? (
              <SettingsPage
                cwd={form.cwd}
                policy={approvalPolicy}
                form={approvalPolicyForm}
                isLoading={approvalPolicyLoading}
                errorMessage={errorMessage}
                onCwdChange={updateWorkspaceCwd}
                onFormChange={setApprovalPolicyForm}
                onRefresh={() => void refreshApprovalPolicy()}
                onSave={() => void saveApprovalPolicy()}
              />
            ) : (
              <ApprovalsPage
                cwd={form.cwd}
                approvals={approvals}
                repairRunId={approvalRepairRunId}
                repairRun={approvalRepairRun}
                selectedApprovalId={selectedApprovalId}
                isLoading={approvalsLoading}
                resolvingApprovals={resolvingApprovals}
                errorMessage={errorMessage}
                onCwdChange={(cwd) => {
                  setApprovalRepairRunId("");
                  updateWorkspaceCwd(cwd);
                }}
                onRefresh={() => void refreshApprovals()}
                onSelectApproval={setSelectedApprovalId}
                onRefreshRepair={(runId) => {
                  void refreshApprovals(form.cwd.trim(), runId);
                  void loadRun(runId, form.cwd.trim());
                }}
                onResolve={(approvalId, decision, reason) => void resolveApproval(approvalId, decision, reason)}
                onOpenRun={(runId) => void openRunFromWorkspace(runId)}
                onClearRepair={() => setApprovalRepairRunId("")}
              />
            )}
          </>
        )}
      </section>
      <aside className={inspectorCollapsed ? "right-panel collapsed" : "right-panel"} aria-label={t("Inspector")}>
        <button
          className="inspector-toggle"
          type="button"
          onClick={() => setInspectorCollapsed((current) => !current)}
          aria-label={inspectorCollapsed ? t("Show inspector") : t("Hide inspector")}
        >
          {inspectorCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
        </button>
        {!inspectorCollapsed ? (
          <PageInspector
            activeView={activeView}
            selectedEntity={selectedEntity}
            selectedTask={selectedWorkspaceTask}
            selectedRun={run}
            activeRunId={activeRunId}
            lookupRunId={lookupRunId}
            events={events}
            assistantText={assistantText}
            errorMessage={errorMessage}
            isRunning={isRunning}
            pendingApprovals={activePendingApprovals}
            approvalsLoading={approvalsLoading}
            resolvingApprovals={resolvingApprovals}
            providers={providers}
            selectedProviderId={form.providerPresetId}
            editingProviderId={editingProviderId}
            providerCheck={providerCheck}
            checkedProviderId={providerCheckTargetId}
            mediaJobs={mediaJobs}
            selectedMediaJobId={selectedMediaJobId}
            mediaJobArtifacts={mediaJobArtifacts}
            approvals={approvals}
            selectedApprovalId={selectedApprovalId}
            approvalPolicy={approvalPolicy}
            approvalPolicyForm={approvalPolicyForm}
            cwd={form.cwd}
            onLookupRunIdChange={setLookupRunId}
            onLoadRun={() => void loadRun()}
            onRefreshApprovals={() => void refreshApprovals(form.cwd.trim(), activeRunId || undefined)}
            onResolveApproval={(approvalId, decision, reason) => void resolveApproval(approvalId, decision, reason)}
          />
        ) : null}
      </aside>
    </main>
  );
}

function TopBar({
  daemonHealthy,
  provider,
  onRefresh,
}: {
  readonly daemonHealthy: boolean | undefined;
  readonly provider: string;
  readonly onRefresh: () => void;
}): JSX.Element {
  const { t } = useI18n();

  return (
    <header className="top-bar">
      <div className="top-path">
        <Folder size={16} />
        <span>{daemonBaseUrl}</span>
      </div>
      <div className="top-status">
        <span className={daemonHealthy ? "health ok" : "health down"}>
          <Activity size={15} />
          {daemonHealthy === undefined ? t("Checking daemon") : daemonHealthy ? t("Daemon ready") : t("Daemon offline")}
        </span>
        <span className="provider-pill">
          <Bot size={15} />
          {provider}
        </span>
        <LanguageSwitcher />
        <button className="icon-button" type="button" onClick={onRefresh} aria-label={t("Refresh daemon health")}>
          <RefreshCw size={16} />
        </button>
      </div>
    </header>
  );
}
