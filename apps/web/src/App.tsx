import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Database,
  Folder,
  History,
  Loader2,
  Pencil,
  Play,
  PlugZap,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  Workflow,
} from "lucide-react";
import {
  approveApproval,
  artifactContentUrl,
  buildRerunRequest,
  buildRunRequest,
  buildTaskRunRequest,
  cancelRun,
  checkProvider,
  createChannel,
  createProvider,
  createTask,
  daemonBaseUrl,
  denyApproval,
  deleteChannel,
  deleteTask,
  deleteProvider,
  getDaemonHealth,
  getApprovalPolicy,
  getRun,
  getRunEvents,
  listRunArtifacts,
  listChannels,
  listApprovals,
  listProviders,
  listProviderTemplates,
  listRuns,
  listTasks,
  updateChannel,
  updateApprovalPolicy,
  updateTask,
  updateTaskStatus,
  updateProvider,
} from "./api.js";
import { streamRun } from "./sse.js";
import type {
  ApprovalRequest,
  ApprovalActionType,
  ApprovalPolicy,
  ApprovalPolicyFormState,
  ApprovalRisk,
  ApprovalStatus,
  ApprovalToolDecision,
  Channel,
  ChannelFormState,
  ProviderCheckResult,
  ProviderFormState,
  ProviderPreset,
  ProviderTemplate,
  RunArtifact,
  RunEventEnvelope,
  RunFormState,
  RunSession,
  Task,
  TaskEditFormState,
  TaskFormState,
  TaskStatus,
  ToolName,
} from "./types.js";

const defaultTools: readonly ToolName[] = ["read", "grep", "find", "ls"];
const allTools: readonly ToolName[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const riskyTools: readonly ToolName[] = ["bash", "edit", "write"];
const taskStatuses: readonly TaskStatus[] = ["todo", "claimed", "running", "blocked", "review", "done", "failed", "cancelled"];
type ViewId = "workspace" | "runs" | "providers" | "approvals" | "settings";
type ApprovalResolution = "approve" | "deny";
interface ProviderTemplateGroup {
  readonly label: string;
  readonly templates: readonly ProviderTemplate[];
}
interface ProviderBatchResult {
  readonly message: string;
  readonly failedCount: number;
}
interface ProviderRepairItem {
  readonly provider: ProviderPreset;
  readonly title: string;
  readonly detail: string;
  readonly status: "attention" | "warning";
  readonly action: "check" | "edit";
  readonly actionLabel: string;
}
type RunRepairTarget = "providers" | "approvals" | "run";
interface RunRepairHint {
  readonly target: RunRepairTarget;
  readonly title: string;
  readonly detail: string;
  readonly actionLabel: string;
}
interface RuntimeFailureSummary {
  readonly eventLabel: string;
  readonly toolName: string;
  readonly issueText: string;
  readonly command: string;
  readonly cwd: string;
  readonly targetPath: string;
  readonly exitCode: string;
  readonly suggestion: string;
}
interface WorkspaceReadinessItem {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly status: "ready" | "attention" | "loading" | "info";
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly disabled?: boolean;
}
interface FirstRunStep {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
  readonly status: "ready" | "attention" | "pending";
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly secondaryActionLabel?: string;
  readonly onSecondaryAction?: () => void;
  readonly disabled?: boolean;
}

const defaultForm: RunFormState = {
  cwd: "/Users/tianxiao/ling-stack",
  providerPresetId: "",
  taskId: `task-${new Date().toISOString().slice(0, 10)}`,
  title: "Inspect Ling Stack workspace",
  prompt: "查看当前项目结构，给出下一步实现建议。不要修改文件。",
  provider: "local-relay",
  model: "gpt-5.5",
  baseUrl: "http://127.0.0.1:8317/v1",
  apiKey: "",
  api: "openai-completions",
  tools: defaultTools,
};

const defaultProviderForm: ProviderFormState = {
  kind: "openai-compatible",
  displayName: "Local Relay",
  providerId: "local-relay",
  model: "gpt-5.5",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:8317/v1",
  apiKeyRef: "env:LOCAL_RELAY_API_KEY",
  capabilitiesText: "chat,tool_call,reasoning",
  inputText: "text",
  enabled: true,
  authHeader: true,
  reasoning: true,
  contextWindow: "128000",
  maxTokens: "16384",
};

const defaultChannelForm: ChannelFormState = {
  name: "Engineering",
  boundPath: "/Users/tianxiao/ling-stack",
  defaultProviderPresetId: "",
  allowedTools: defaultTools,
};

const defaultChannelEditForm: ChannelFormState = {
  name: "",
  boundPath: "",
  defaultProviderPresetId: "",
  allowedTools: defaultTools,
};

const defaultTaskForm: TaskFormState = {
  title: "Inspect workspace",
  prompt: "查看当前项目结构，给出下一步实现建议。不要修改文件。",
};

const defaultTaskEditForm: TaskEditFormState = {
  title: "",
  prompt: "",
  status: "todo",
};

const defaultApprovalPolicyForm: ApprovalPolicyFormState = {
  toolDecisions: {
    read: "allow",
    grep: "allow",
    find: "allow",
    ls: "allow",
    bash: "ask",
    edit: "ask",
    write: "ask",
  },
  allowedWritePathsText: ".",
};

export function App(): JSX.Element {
  const [form, setForm] = useState<RunFormState>(defaultForm);
  const [activeView, setActiveView] = useState<ViewId>("workspace");
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
  const [channelForm, setChannelForm] = useState<ChannelFormState>(defaultChannelForm);
  const [channelEditForm, setChannelEditForm] = useState<ChannelFormState>(defaultChannelEditForm);
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskForm, setTaskForm] = useState<TaskFormState>(defaultTaskForm);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [taskEditForm, setTaskEditForm] = useState<TaskEditFormState>(defaultTaskEditForm);
  const [taskRunProviderId, setTaskRunProviderId] = useState("");
  const [providerForm, setProviderForm] = useState<ProviderFormState>(defaultProviderForm);
  const [editingProviderId, setEditingProviderId] = useState("");
  const [providerCheck, setProviderCheck] = useState<ProviderCheckResult | undefined>();
  const [providerCheckTargetId, setProviderCheckTargetId] = useState("");
  const [checkingProviderIds, setCheckingProviderIds] = useState<readonly string[]>([]);
  const [providerBatchResult, setProviderBatchResult] = useState<ProviderBatchResult | undefined>();
  const [providerRepairRunId, setProviderRepairRunId] = useState("");
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
  const [isRunning, setIsRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const abortRef = useRef<AbortController | undefined>(undefined);
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
    () => approvals.filter((approval) => approval.status === "pending" && approval.runId === activeRunId),
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
  const succeededRunCount = useMemo(() => [...runById.values()].filter((item) => item.status === "succeeded").length, [runById]);
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
    }
    if (activeView === "runs") {
      void refreshRuns();
    }
    if (activeView === "providers") {
      void refreshProviderTemplates();
      void refreshProviders();
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
    } else {
      setTasks([]);
      setSelectedTaskId("");
    }
  }, [selectedChannelId]);

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

  async function refreshHealth(): Promise<void> {
    try {
      setDaemonHealthy(await getDaemonHealth());
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
        `${daemonBaseUrl}/runs`,
        requestBody,
        (message) => {
          if (message.kind === "ready") {
            streamedRunId = message.runId;
            setActiveRunId(message.runId);
            setLookupRunId(message.runId);
            return;
          }
          if (message.event.type === "approval_requested") {
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
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshRuns(cwd = form.cwd.trim()): Promise<void> {
    if (!cwd) {
      setErrorMessage("请输入 workspace path");
      return;
    }

    setRunsLoading(true);
    try {
      setErrorMessage("");
      const response = await listRuns(cwd);
      setRuns(response.runs);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunsLoading(false);
    }
  }

  async function refreshProviders(): Promise<void> {
    if (!form.cwd.trim()) {
      setErrorMessage("请输入 workspace path");
      return;
    }

    setProvidersLoading(true);
    try {
      setErrorMessage("");
      const response = await listProviders(form.cwd.trim());
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

  async function refreshChannels(): Promise<void> {
    if (!form.cwd.trim()) {
      setErrorMessage("请输入 workspace path");
      return;
    }

    setChannelsLoading(true);
    try {
      setErrorMessage("");
      const response = await listChannels(form.cwd.trim());
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
      setChannelForm((current) => ({
        ...current,
        name: "",
        defaultProviderPresetId: (current.defaultProviderPresetId || response.channel.defaultProviderPresetId) ?? "",
      }));
      await refreshChannels();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
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
        boundPath: channelForm.boundPath.trim() || form.cwd.trim(),
        defaultProviderPresetId: readyProvider?.id ?? channelForm.defaultProviderPresetId,
        allowedTools: channelForm.allowedTools.length > 0 ? channelForm.allowedTools : defaultTools,
      });
      setSelectedChannelId(response.channel.id);
      setTaskRunProviderId("");
      if (readyProvider) {
        applyProviderToRun(readyProvider);
      }
      setChannelForm((current) => ({
        ...current,
        name: "",
        boundPath: current.boundPath || form.cwd.trim(),
        defaultProviderPresetId: readyProvider?.id ?? current.defaultProviderPresetId,
      }));
      await refreshChannels();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function setChannelDefaultProvider(channelId: string, providerId: string): Promise<void> {
    const channel = channels.find((item) => item.id === channelId);
    if (!channel) {
      setErrorMessage("找不到 channel");
      return;
    }
    const provider = providers.find((item) => item.id === providerId);
    if (!provider || !providerPreflightReady(provider)) {
      setErrorMessage("请先选择 preflight-ready provider");
      return;
    }

    try {
      setErrorMessage("");
      const response = await updateChannel(form.cwd.trim(), channelId, {
        ...channelToForm(channel, form.cwd),
        defaultProviderPresetId: provider.id,
      });
      setSelectedChannelId(response.channel.id);
      setTaskRunProviderId("");
      setChannelEditForm(channelToForm(response.channel, form.cwd));
      applyProviderToRun(provider);
      await refreshChannels();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
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
    }
  }

  async function removeChannel(channelId: string): Promise<void> {
    try {
      setErrorMessage("");
      await deleteChannel(form.cwd.trim(), channelId);
      if (selectedChannelId === channelId) {
        setSelectedChannelId("");
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
      });
      setSelectedTaskId(response.task.id);
      setTaskForm(defaultTaskForm);
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

  async function runPersistedTask(task: Task, options: { readonly skipPreflight?: boolean } = {}): Promise<boolean> {
    const channel = channels.find((item) => item.id === task.channelId);
    if (!channel) {
      setErrorMessage("找不到 task 所属 channel");
      return false;
    }
    const providerPresetId = taskRunProviderId || channel.defaultProviderPresetId || form.providerPresetId;
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
  }

  async function checkThenRunPersistedTask(task: Task): Promise<boolean> {
    const channel = channels.find((item) => item.id === task.channelId);
    const providerPresetId = taskRunProviderId || channel?.defaultProviderPresetId || form.providerPresetId;
    const provider = providerPresetId ? providers.find((item) => item.id === providerPresetId) : undefined;
    if (!provider) {
      setErrorMessage(providerPresetId ? "找不到 provider preset" : "请先选择 provider preset");
      return false;
    }
    if (await checkProviderForRun(provider)) {
      return await runPersistedTask(task, { skipPreflight: true });
    }
    return false;
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
      setErrorMessage("请输入 workspace path");
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
      setErrorMessage("请输入 workspace path");
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
      setApprovals((current) => upsertApproval(current, response.approval));

      const resolvedRunId = response.approval.runId || approvalBeforeResolution?.runId;
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
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      resolvingApprovalsRef.current.delete(approvalId);
      setResolvingApprovals((current) => removeRecordKey(current, approvalId));
    }
  }

  async function saveProvider(): Promise<void> {
    if (!form.cwd.trim()) {
      setErrorMessage("请输入 workspace path");
      return;
    }

    try {
      setErrorMessage("");
      setProviderCheck(undefined);
      setProviderCheckTargetId("");
      setProviderBatchResult(undefined);
      const response = editingProviderId
        ? await updateProvider(form.cwd.trim(), editingProviderId, providerForm)
        : await createProvider(form.cwd.trim(), providerForm);
      setEditingProviderId(response.provider.id);
      await refreshProviders();
      applyProviderToRun(response.provider);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
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
    setActiveView("runs");
  }

  function openApprovalsFromWorkspace(runId?: string): void {
    const targetRunId = runId || activeRunId || "";
    setApprovalRepairRunId(targetRunId);
    if (targetRunId) {
      void loadRun(targetRunId, form.cwd.trim());
    }
    void refreshApprovals(form.cwd.trim(), targetRunId || undefined);
    setActiveView("approvals");
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
    setActiveView("providers");
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
    <main className="app-shell">
      <TopBar daemonHealthy={daemonHealthy} provider={`${form.provider}/${form.model}`} onRefresh={refreshHealth} />
      <aside className="left-nav" aria-label="Ling Stack navigation">
        <div className="brand">
          <div className="brand-mark">L</div>
          <div>
            <strong>Ling Stack</strong>
            <span>AI teammate workspace</span>
          </div>
        </div>
        <nav>
          <NavItem icon={<Workflow />} label="Workspace" active={activeView === "workspace"} onClick={() => setActiveView("workspace")} />
          <NavItem icon={<History />} label="Runs" active={activeView === "runs"} onClick={() => setActiveView("runs")} />
          <NavItem icon={<PlugZap />} label="Providers" active={activeView === "providers"} onClick={() => setActiveView("providers")} />
          <NavItem
            icon={<ShieldCheck />}
            label="Approvals"
            active={activeView === "approvals"}
            onClick={() => {
              setApprovalRepairRunId("");
              setActiveView("approvals");
            }}
          />
          <NavItem icon={<Settings />} label="Settings" active={activeView === "settings"} onClick={() => setActiveView("settings")} />
        </nav>
      </aside>
      <section className="workspace">
        <div className="workspace-head">
          <div>
            <h1>{viewTitle(activeView)}</h1>
            <p>{viewDescription(activeView)}</p>
          </div>
          <StatusBadge status={latestStatus} />
        </div>

        {activeView === "workspace" ? (
          <>
            <WorkspaceReadiness
              daemonHealthy={daemonHealthy}
              providers={providers}
              channels={channels}
              tasks={tasks}
              providersLoading={providersLoading}
              channelsLoading={channelsLoading}
              tasksLoading={tasksLoading}
              runsLoading={runsLoading}
              succeededRunCount={succeededRunCount}
              onRefreshDaemon={() => void refreshHealth()}
              onOpenProviders={() => setActiveView("providers")}
              onOpenRuns={() => setActiveView("runs")}
              onCreateChannel={() => void saveDefaultChannel()}
              onCreateTask={() => void saveTask()}
            />
            <FirstRunFlow
              providers={providers}
              channels={channels}
              selectedChannelId={selectedChannelId}
              tasks={tasks}
              selectedTaskId={selectedTaskId}
              taskRunProviderId={taskRunProviderId}
              fallbackProviderId={form.providerPresetId}
              providersLoading={providersLoading}
              channelsLoading={channelsLoading}
              tasksLoading={tasksLoading}
              isRunning={isRunning}
              activeRunId={activeRunId}
              latestStatus={latestStatus}
              currentRun={run}
              runById={runById}
              pendingApprovalCount={activePendingApprovals.length}
              onOpenProviders={(sourceRun) => sourceRun ? openProvidersFromRun(sourceRun) : setActiveView("providers")}
              onOpenApprovals={(runId) => openApprovalsFromWorkspace(runId)}
              onOpenRun={(runId) => void openRunFromWorkspace(runId)}
              onCreateDefaultChannel={() => void saveDefaultChannel()}
              onSetChannelProvider={(channelId, providerId) => void setChannelDefaultProvider(channelId, providerId)}
              onCreateTask={() => void saveTask()}
              onCheckThenRunTask={(task) => void checkThenRunPersistedTask(task)}
              onRunTask={(task) => void runPersistedTask(task)}
            />
            <div className="workspace-task-grid">
              <ChannelTaskWorkspace
                cwd={form.cwd}
                channels={channels}
                selectedChannelId={selectedChannelId}
                channelForm={channelForm}
                channelEditForm={channelEditForm}
                tasks={tasks}
                taskForm={taskForm}
                selectedTaskId={selectedTaskId}
                taskEditForm={taskEditForm}
                providers={providers}
                taskRunProviderId={taskRunProviderId}
                fallbackProviderId={form.providerPresetId}
                channelsLoading={channelsLoading}
                tasksLoading={tasksLoading}
                isRunning={isRunning}
                activeRunId={activeRunId}
                latestStatus={latestStatus}
                runById={runById}
                repairRun={taskRepairRun}
                errorMessage={errorMessage}
                onCwdChange={(cwd) => {
                  setForm({ ...form, cwd });
                  setChannelForm((current) => ({
                    ...current,
                    boundPath: current.boundPath === form.cwd || !current.boundPath ? cwd : current.boundPath,
                  }));
                }}
                onChannelFormChange={setChannelForm}
                onChannelEditFormChange={setChannelEditForm}
                onTaskFormChange={setTaskForm}
                onTaskEditFormChange={setTaskEditForm}
                onProviderSelect={(providerId) => {
                  setTaskRunProviderId(providerId);
                  const provider = providers.find((item) => item.id === providerId);
                  if (provider) {
                    applyProviderToRun(provider);
                  }
                }}
                onSelectChannel={(channelId) => {
                  setSelectedChannelId(channelId);
                  setTaskRunProviderId("");
                }}
                onCreateChannel={() => void saveChannel()}
                onSaveChannelEdit={(channelId) => void saveChannelEdit(channelId)}
                onDeleteChannel={(channelId) => void removeChannel(channelId)}
                onRefreshChannels={() => void refreshChannels()}
                onCreateTask={() => void saveTask()}
                onRefreshTasks={() => void refreshTasks()}
                onSelectTask={setSelectedTaskId}
                onSaveTaskEdit={(taskId) => void saveTaskEdit(taskId)}
                onRunTask={(task) => void runPersistedTask(task)}
                onCheckThenRunTask={(task) => void checkThenRunPersistedTask(task)}
                onRunUpdatedTask={(task) => void runUpdatedTaskFromRepair(task)}
                onCheckThenRunUpdatedTask={(task) => void checkThenRunUpdatedTaskFromRepair(task)}
                onReviewTask={(taskId) => void moveTaskToReview(taskId)}
                onDeleteTask={(taskId) => void removeTask(taskId)}
                onOpenRun={(runId) => void openRunFromWorkspace(runId)}
                onOpenApprovals={(runId) => openApprovalsFromWorkspace(runId)}
                onOpenProviders={(sourceRun) => sourceRun ? openProvidersFromRun(sourceRun) : setActiveView("providers")}
                onClearRepair={() => setTaskRepairRunId("")}
              />
              <RunTimeline
                events={events}
                assistantText={assistantText}
                errorMessage={errorMessage}
                isRunning={isRunning}
                pendingApprovals={activePendingApprovals}
                approvalsLoading={approvalsLoading}
                resolvingApprovals={resolvingApprovals}
                onRefreshApprovals={() => void refreshApprovals(form.cwd.trim(), activeRunId || undefined)}
                onResolveApproval={(approvalId, decision, reason) => void resolveApproval(approvalId, decision, reason)}
              />
            </div>
          </>
        ) : activeView === "runs" ? (
          <RunHistory
            cwd={form.cwd}
            runs={runs}
            selectedRunId={activeRunId}
            selectedRun={run}
            events={events}
            artifacts={artifacts}
            assistantText={assistantText}
            approvals={activeRunApprovals}
            approvalsLoading={approvalsLoading}
            resolvingApprovals={resolvingApprovals}
            isLoading={runsLoading}
            isRunning={isRunning}
            errorMessage={errorMessage}
            onCwdChange={(cwd) => {
              setForm({ ...form, cwd });
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
        ) : (
          activeView === "providers" ? (
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
            repairRun={providerRepairRun}
            isRunning={isRunning}
            onCwdChange={(cwd) => setForm({ ...form, cwd })}
            onFormChange={setProviderForm}
            onTemplateSelect={(template) => {
              setProviderRepairRunId("");
              setEditingProviderId("");
              setProviderCheck(undefined);
              setProviderCheckTargetId("");
              setProviderForm(providerTemplateToForm(template));
            }}
            onNew={() => {
              setProviderRepairRunId("");
              setEditingProviderId("");
              setProviderCheck(undefined);
              setProviderCheckTargetId("");
              setProviderForm(defaultProviderForm);
            }}
            onSave={() => void saveProvider()}
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
          ) : (
            activeView === "settings" ? (
              <SettingsPage
                cwd={form.cwd}
                policy={approvalPolicy}
                form={approvalPolicyForm}
                isLoading={approvalPolicyLoading}
                errorMessage={errorMessage}
                onCwdChange={(cwd) => setForm({ ...form, cwd })}
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
                isLoading={approvalsLoading}
                resolvingApprovals={resolvingApprovals}
                errorMessage={errorMessage}
                onCwdChange={(cwd) => {
                  setApprovalRepairRunId("");
                  setForm({ ...form, cwd });
                }}
                onRefresh={() => void refreshApprovals()}
                onRefreshRepair={(runId) => {
                  void refreshApprovals(form.cwd.trim(), runId);
                  void loadRun(runId, form.cwd.trim());
                }}
                onResolve={(approvalId, decision, reason) => void resolveApproval(approvalId, decision, reason)}
                onOpenRun={(runId) => void openRunFromWorkspace(runId)}
                onClearRepair={() => setApprovalRepairRunId("")}
              />
            )
          )
        )}
      </section>
      <aside className="right-panel">
        <RunInspector
          activeRunId={activeRunId}
          lookupRunId={lookupRunId}
          run={run}
          events={events}
          onLookupRunIdChange={setLookupRunId}
          onLoadRun={() => void loadRun()}
        />
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
  return (
    <header className="top-bar">
      <div className="top-path">
        <Folder size={16} />
        <span>{daemonBaseUrl}</span>
      </div>
      <div className="top-status">
        <span className={daemonHealthy ? "health ok" : "health down"}>
          <Activity size={15} />
          {daemonHealthy === undefined ? "Checking daemon" : daemonHealthy ? "Daemon ready" : "Daemon offline"}
        </span>
        <span className="provider-pill">
          <Bot size={15} />
          {provider}
        </span>
        <button className="icon-button" type="button" onClick={onRefresh} aria-label="Refresh daemon health">
          <RefreshCw size={16} />
        </button>
      </div>
    </header>
  );
}

function NavItem({
  icon,
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  readonly icon: JSX.Element;
  readonly label: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}): JSX.Element {
  return (
    <button className={active ? "nav-item active" : "nav-item"} type="button" disabled={disabled} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function ProviderPresetOptions({
  runnableProviders,
  blockedProviders,
}: {
  readonly runnableProviders: readonly ProviderPreset[];
  readonly blockedProviders: readonly ProviderPreset[];
}): JSX.Element {
  return (
    <>
      {runnableProviders.length > 0 ? (
        <optgroup label="Runnable chat presets">
          {runnableProviders.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.displayName} / {provider.model}
            </option>
          ))}
        </optgroup>
      ) : null}
      {blockedProviders.length > 0 ? (
        <optgroup label="Needs setup">
          {blockedProviders.map((provider) => (
            <option key={provider.id} value={provider.id} disabled>
              {provider.displayName} / {provider.model} - {providerRunBlockerLabel(provider)}
            </option>
          ))}
        </optgroup>
      ) : null}
    </>
  );
}

function WorkspaceReadiness({
  daemonHealthy,
  providers,
  channels,
  tasks,
  providersLoading,
  channelsLoading,
  tasksLoading,
  runsLoading,
  succeededRunCount,
  onRefreshDaemon,
  onOpenProviders,
  onOpenRuns,
  onCreateChannel,
  onCreateTask,
}: {
  readonly daemonHealthy: boolean | undefined;
  readonly providers: readonly ProviderPreset[];
  readonly channels: readonly Channel[];
  readonly tasks: readonly Task[];
  readonly providersLoading: boolean;
  readonly channelsLoading: boolean;
  readonly tasksLoading: boolean;
  readonly runsLoading: boolean;
  readonly succeededRunCount: number;
  readonly onRefreshDaemon: () => void;
  readonly onOpenProviders: () => void;
  readonly onOpenRuns: () => void;
  readonly onCreateChannel: () => void;
  readonly onCreateTask: () => void;
}): JSX.Element {
  const runnableProviderCount = providers.filter(canUseProviderForRun).length;
  const readyProviderCount = providers.filter((provider) => providerRunPreflightBlocker(provider) === undefined).length;
  const providerItem = buildProviderReadinessItem(providers.length, runnableProviderCount, readyProviderCount, providersLoading, onOpenProviders);
  const channelItem = buildChannelReadinessItem(channels.length, channelsLoading, onCreateChannel);
  const taskItem = buildTaskReadinessItem(tasks.length, tasksLoading, channels.length > 0, onCreateTask);
  const runLoopItem = buildRunLoopReadinessItem(succeededRunCount, runsLoading, onOpenRuns);
  const items: readonly WorkspaceReadinessItem[] = [
    buildDaemonReadinessItem(daemonHealthy, onRefreshDaemon),
    providerItem,
    channelItem,
    taskItem,
    runLoopItem,
  ];
  const blockingItems = items.filter((item) => item.id !== "tasks" && item.id !== "run-loop" && item.status !== "ready");
  const ready = blockingItems.length === 0;

  return (
    <section className="workspace-readiness panel" aria-labelledby="workspace-readiness-title">
      <div className="panel-title split readiness-title">
        <span>
          <ShieldCheck size={18} />
          <h2 id="workspace-readiness-title">Workspace readiness</h2>
        </span>
        <span className={ready ? "readiness-summary ok" : "readiness-summary attention"}>
          {ready ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
          {ready ? "Ready" : `${blockingItems.length} blocked`}
        </span>
      </div>
      <div className="readiness-grid">
        {items.map((item) => (
          <div key={item.id} className={`readiness-item ${item.status}`}>
            <span className="readiness-icon">{readinessIcon(item.status)}</span>
            <span className="readiness-copy">
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </span>
            {item.actionLabel && item.onAction ? (
              <button className="secondary-button compact-button" type="button" onClick={item.onAction} disabled={item.disabled}>
                {item.status === "loading" ? <Loader2 className="spin" size={14} /> : readinessActionIcon(item)}
                {item.actionLabel}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

function FirstRunFlow({
  providers,
  channels,
  selectedChannelId,
  tasks,
  selectedTaskId,
  taskRunProviderId,
  fallbackProviderId,
  providersLoading,
  channelsLoading,
  tasksLoading,
  isRunning,
  activeRunId,
  latestStatus,
  currentRun,
  runById,
  pendingApprovalCount,
  onOpenProviders,
  onOpenApprovals,
  onOpenRun,
  onCreateDefaultChannel,
  onSetChannelProvider,
  onCreateTask,
  onCheckThenRunTask,
  onRunTask,
}: {
  readonly providers: readonly ProviderPreset[];
  readonly channels: readonly Channel[];
  readonly selectedChannelId: string;
  readonly tasks: readonly Task[];
  readonly selectedTaskId: string;
  readonly taskRunProviderId: string;
  readonly fallbackProviderId: string;
  readonly providersLoading: boolean;
  readonly channelsLoading: boolean;
  readonly tasksLoading: boolean;
  readonly isRunning: boolean;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly currentRun: RunSession | undefined;
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly pendingApprovalCount: number;
  readonly onOpenProviders: (run?: RunSession) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onCreateDefaultChannel: () => void;
  readonly onSetChannelProvider: (channelId: string, providerId: string) => void;
  readonly onCreateTask: () => void;
  readonly onCheckThenRunTask: (task: Task) => void;
  readonly onRunTask: (task: Task) => void;
}): JSX.Element | null {
  const readyProvider = providers.find(providerPreflightReady);
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? tasks[0];
  const channelDefaultProvider = selectedChannel?.defaultProviderPresetId
    ? providers.find((provider) => provider.id === selectedChannel.defaultProviderPresetId)
    : undefined;
  const channelHasReadyDefault = Boolean(channelDefaultProvider && providerPreflightReady(channelDefaultProvider));
  const effectiveProviderId = taskRunProviderId || selectedChannel?.defaultProviderPresetId || fallbackProviderId || readyProvider?.id || "";
  const effectiveProvider = providers.find((provider) => provider.id === effectiveProviderId);
  const runReady = Boolean(selectedTask && effectiveProvider && providerRunPreflightBlocker(effectiveProvider) === undefined);
  const firstRunComplete = Boolean(readyProvider && selectedChannel && channelHasReadyDefault && selectedTask && runReady);
  const activeRun = activeRunId ? (currentRun?.id === activeRunId ? currentRun : runById.get(activeRunId)) : undefined;
  const selectedTaskRunId = selectedTask?.currentRunId ?? "";
  const selectedTaskRun = selectedTaskRunId ? runById.get(selectedTaskRunId) : undefined;
  const selectedTaskRunStatus = selectedTaskRunId ? displayLinkedRunStatus(selectedTaskRunId, selectedTaskRun, activeRunId, latestStatus) : "";

  if (activeRunId && isRunning) {
    return (
      <section className="first-run-flow panel active" aria-labelledby="first-run-flow-title">
        <div className="first-run-copy">
          <span>
            <Loader2 className="spin" size={17} />
            <strong id="first-run-flow-title">Run in progress</strong>
          </span>
          <small>
            {activeRun ? readTaskTitle(activeRun.taskSnapshot) || activeRun.taskId : "Active task"} is {latestStatus}. {activeRunId}
          </small>
        </div>
        <div className="first-run-actions">
          <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(activeRunId)}>
            <History size={14} />
            Open run
          </button>
        </div>
      </section>
    );
  }

  if (selectedTask && selectedTaskRunId) {
    const repairHint = buildRunRepairHint(selectedTaskRun, pendingApprovalCount, selectedTaskRunStatus);
    const needsRepair = selectedTaskRunStatus === "failed" || selectedTaskRunStatus === "waiting_for_approval";
    const runStatusClass = selectedTaskRunStatus === "succeeded" ? "ready" : needsRepair ? "attention" : "active";
    const title = selectedTaskRunStatus === "succeeded"
      ? "Run loop complete"
      : needsRepair
        ? "Run needs attention"
        : "Current run linked";
    const detail = repairHint
      ? `${selectedTask.title} latest run is ${selectedTaskRunStatus}. ${repairHint.detail}`
      : `${selectedTask.title} latest run is ${selectedTaskRunStatus}.${selectedTaskRun?.errorMessage ? ` ${selectedTaskRun.errorMessage}` : ""}`;
    const primaryAction = repairHint?.target ?? "run";

    return (
      <section className={`first-run-flow panel ${runStatusClass}`} aria-labelledby="first-run-flow-title">
        <div className="first-run-copy">
          <span>
            {selectedTaskRunStatus === "succeeded" ? <CheckCircle2 size={17} /> : needsRepair ? <CircleAlert size={17} /> : <History size={17} />}
            <strong id="first-run-flow-title">{title}</strong>
          </span>
          <small>{detail}</small>
        </div>
        <div className="first-run-actions">
          {primaryAction === "providers" ? (
            <button className="secondary-button compact-button" type="button" onClick={() => onOpenProviders(selectedTaskRun)}>
              <PlugZap size={14} />
              {repairHint?.actionLabel ?? "Providers"}
            </button>
          ) : null}
          {primaryAction === "approvals" ? (
            <button className="secondary-button compact-button" type="button" onClick={() => onOpenApprovals(selectedTaskRunId)}>
              <ShieldCheck size={14} />
              {repairHint?.actionLabel ?? "Approvals"}
            </button>
          ) : null}
          <button className={primaryAction === "run" ? "primary-button compact-button" : "secondary-button compact-button"} type="button" onClick={() => onOpenRun(selectedTaskRunId)}>
            <History size={14} />
            {primaryAction === "run" ? (repairHint?.actionLabel ?? "Open run") : "Open run"}
          </button>
          {selectedTaskRunStatus === "succeeded" ? (
            <button className="primary-button compact-button" type="button" onClick={() => onRunTask(selectedTask)} disabled={isRunning || !runReady}>
              <Play size={14} />
              Run again
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  if (firstRunComplete && selectedTask && effectiveProvider) {
    return (
      <section className="first-run-flow panel ready" aria-labelledby="first-run-flow-title">
        <div className="first-run-copy">
          <span>
            <CheckCircle2 size={17} />
            <strong id="first-run-flow-title">First run ready</strong>
          </span>
          <small>
            {selectedTask.title} can run with {effectiveProvider.displayName}.
          </small>
        </div>
        <div className="first-run-actions">
          <button className="secondary-button compact-button" type="button" onClick={() => onCheckThenRunTask(selectedTask)} disabled={isRunning}>
            {isRunning ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
            Check run
          </button>
          <button className="primary-button compact-button" type="button" onClick={() => onRunTask(selectedTask)} disabled={isRunning}>
            {isRunning ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
            Run
          </button>
        </div>
      </section>
    );
  }

  const steps: readonly FirstRunStep[] = [
    buildFirstRunProviderStep(readyProvider, providersLoading, () => onOpenProviders()),
    buildFirstRunChannelStep(Boolean(selectedChannel), Boolean(readyProvider), channelsLoading, onCreateDefaultChannel),
    buildFirstRunChannelProviderStep(selectedChannel, readyProvider, channelHasReadyDefault, onSetChannelProvider),
    buildFirstRunTaskStep(Boolean(selectedChannel), tasks.length, tasksLoading, onCreateTask),
    buildFirstRunRunStep(selectedTask, effectiveProvider, runReady, isRunning, onCheckThenRunTask, onRunTask),
  ];

  return (
    <section className="first-run-flow panel" aria-labelledby="first-run-flow-title">
      <div className="panel-title split first-run-title">
        <span>
          <Play size={18} />
          <h2 id="first-run-flow-title">First run</h2>
        </span>
        <span className="event-count">setup loop</span>
      </div>
      <div className="first-run-steps">
        {steps.map((step) => (
          <article key={step.id} className={`first-run-step ${step.status}`}>
            {firstRunStepIcon(step.status)}
            <span className="first-run-step-copy">
              <strong>{step.label}</strong>
              <small>{step.detail}</small>
            </span>
            <span className="first-run-step-actions">
              {step.actionLabel && step.onAction ? (
                <button className="secondary-button compact-button" type="button" onClick={step.onAction} disabled={step.disabled}>
                  {step.status === "pending" ? <Loader2 className="spin" size={14} /> : firstRunActionIcon(step.actionLabel)}
                  {step.actionLabel}
                </button>
              ) : null}
              {step.secondaryActionLabel && step.onSecondaryAction ? (
                <button className="primary-button compact-button" type="button" onClick={step.onSecondaryAction} disabled={step.disabled}>
                  {isRunning ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                  {step.secondaryActionLabel}
                </button>
              ) : null}
            </span>
          </article>
        ))}
      </div>
    </section>
  );
}

function buildFirstRunProviderStep(
  readyProvider: ProviderPreset | undefined,
  loading: boolean,
  onOpenProviders: () => void,
): FirstRunStep {
  if (loading) {
    return {
      id: "provider",
      label: "Provider",
      detail: "Loading provider presets",
      status: "pending",
      actionLabel: "Providers",
      onAction: onOpenProviders,
      disabled: true,
    };
  }
  if (!readyProvider) {
    return {
      id: "provider",
      label: "Provider",
      detail: "Create or repair a preflight-ready chat provider first.",
      status: "attention",
      actionLabel: "Providers",
      onAction: onOpenProviders,
    };
  }
  return {
    id: "provider",
    label: "Provider",
    detail: `${readyProvider.displayName} is preflight-ready.`,
    status: "ready",
  };
}

function buildFirstRunChannelStep(
  hasChannel: boolean,
  hasReadyProvider: boolean,
  loading: boolean,
  onCreateDefaultChannel: () => void,
): FirstRunStep {
  if (loading) {
    return {
      id: "channel",
      label: "Channel",
      detail: "Loading channels",
      status: "pending",
      disabled: true,
    };
  }
  if (!hasChannel) {
    return {
      id: "channel",
      label: "Channel",
      detail: hasReadyProvider ? "Create an Engineering channel with the ready provider as default." : "Create a channel after provider setup.",
      status: "attention",
      actionLabel: "Create default",
      onAction: onCreateDefaultChannel,
      disabled: !hasReadyProvider,
    };
  }
  return {
    id: "channel",
    label: "Channel",
    detail: "A channel is selected.",
    status: "ready",
  };
}

function buildFirstRunChannelProviderStep(
  channel: Channel | undefined,
  readyProvider: ProviderPreset | undefined,
  channelHasReadyDefault: boolean,
  onSetChannelProvider: (channelId: string, providerId: string) => void,
): FirstRunStep {
  if (!channel) {
    return {
      id: "channel-provider",
      label: "Channel provider",
      detail: "Create or select a channel first.",
      status: "pending",
    };
  }
  if (channelHasReadyDefault) {
    return {
      id: "channel-provider",
      label: "Channel provider",
      detail: "Selected channel has a preflight-ready default provider.",
      status: "ready",
    };
  }
  return {
    id: "channel-provider",
    label: "Channel provider",
    detail: readyProvider ? `Set ${readyProvider.displayName} as the channel default.` : "Repair a provider before setting the channel default.",
    status: "attention",
    actionLabel: "Set provider",
    onAction: readyProvider ? () => onSetChannelProvider(channel.id, readyProvider.id) : undefined,
    disabled: !readyProvider,
  };
}

function buildFirstRunTaskStep(
  hasChannel: boolean,
  taskCount: number,
  loading: boolean,
  onCreateTask: () => void,
): FirstRunStep {
  if (loading) {
    return {
      id: "task",
      label: "Task",
      detail: "Loading selected channel tasks",
      status: "pending",
    };
  }
  if (taskCount === 0) {
    return {
      id: "task",
      label: "Task",
      detail: hasChannel ? "Create the first task from the default prompt." : "Create a channel first.",
      status: "attention",
      actionLabel: "Create first task",
      onAction: hasChannel ? onCreateTask : undefined,
      disabled: !hasChannel,
    };
  }
  return {
    id: "task",
    label: "Task",
    detail: `${taskCount} task${taskCount === 1 ? "" : "s"} available.`,
    status: "ready",
  };
}

function buildFirstRunRunStep(
  task: Task | undefined,
  provider: ProviderPreset | undefined,
  runReady: boolean,
  isRunning: boolean,
  onCheckThenRunTask: (task: Task) => void,
  onRunTask: (task: Task) => void,
): FirstRunStep {
  if (!task) {
    return {
      id: "run",
      label: "Run",
      detail: "Create a task first.",
      status: "pending",
    };
  }
  if (!provider) {
    return {
      id: "run",
      label: "Run",
      detail: "Select or set a provider before running.",
      status: "attention",
    };
  }
  if (!runReady) {
    return {
      id: "run",
      label: "Run",
      detail: providerRunPreflightBlocker(provider) ?? "Provider is not ready.",
      status: "attention",
      actionLabel: "Check run",
      onAction: () => onCheckThenRunTask(task),
      disabled: isRunning || !canUseProviderForRun(provider),
    };
  }
  return {
    id: "run",
    label: "Run",
    detail: "Task and provider are ready.",
    status: "ready",
    actionLabel: "Check run",
    onAction: () => onCheckThenRunTask(task),
    secondaryActionLabel: "Run",
    onSecondaryAction: () => onRunTask(task),
    disabled: isRunning,
  };
}

function firstRunStepIcon(status: FirstRunStep["status"]): JSX.Element {
  if (status === "ready") {
    return <CheckCircle2 size={17} />;
  }
  if (status === "pending") {
    return <Clock3 size={17} />;
  }
  return <CircleAlert size={17} />;
}

function firstRunActionIcon(label: string): JSX.Element {
  const normalized = label.toLowerCase();
  if (normalized.includes("provider")) {
    return <PlugZap size={14} />;
  }
  if (normalized.includes("create")) {
    return <Plus size={14} />;
  }
  if (normalized.includes("check")) {
    return <CheckCircle2 size={14} />;
  }
  return <Save size={14} />;
}

function buildDaemonReadinessItem(daemonHealthy: boolean | undefined, onRefreshDaemon: () => void): WorkspaceReadinessItem {
  if (daemonHealthy === undefined) {
    return {
      id: "daemon",
      label: "Daemon",
      detail: "Checking local daemon",
      status: "loading",
      actionLabel: "Retry",
      onAction: onRefreshDaemon,
    };
  }
  if (!daemonHealthy) {
    return {
      id: "daemon",
      label: "Daemon",
      detail: "Daemon is offline",
      status: "attention",
      actionLabel: "Retry",
      onAction: onRefreshDaemon,
    };
  }
  return {
    id: "daemon",
    label: "Daemon",
    detail: "Local daemon is reachable",
    status: "ready",
  };
}

function buildProviderReadinessItem(
  total: number,
  runnable: number,
  ready: number,
  loading: boolean,
  onOpenProviders: () => void,
): WorkspaceReadinessItem {
  if (loading) {
    return {
      id: "providers",
      label: "Provider",
      detail: "Loading provider presets",
      status: "loading",
      actionLabel: "Providers",
      onAction: onOpenProviders,
      disabled: true,
    };
  }
  if (total === 0) {
    return {
      id: "providers",
      label: "Provider",
      detail: "No provider presets",
      status: "attention",
      actionLabel: "Providers",
      onAction: onOpenProviders,
    };
  }
  if (runnable === 0) {
    return {
      id: "providers",
      label: "Provider",
      detail: `${total} configured, none runnable`,
      status: "attention",
      actionLabel: "Providers",
      onAction: onOpenProviders,
    };
  }
  if (ready === 0) {
    return {
      id: "providers",
      label: "Provider",
      detail: `${runnable} runnable, check required`,
      status: "attention",
      actionLabel: "Providers",
      onAction: onOpenProviders,
    };
  }
  return {
    id: "providers",
    label: "Provider",
    detail: `${ready}/${total} preflight ready`,
    status: "ready",
    actionLabel: "Providers",
    onAction: onOpenProviders,
  };
}

function buildChannelReadinessItem(total: number, loading: boolean, onCreateChannel: () => void): WorkspaceReadinessItem {
  if (loading) {
    return {
      id: "channels",
      label: "Channel",
      detail: "Loading channels",
      status: "loading",
      actionLabel: "Create",
      onAction: onCreateChannel,
      disabled: true,
    };
  }
  if (total === 0) {
    return {
      id: "channels",
      label: "Channel",
      detail: "No channel yet",
      status: "attention",
      actionLabel: "Create",
      onAction: onCreateChannel,
    };
  }
  return {
    id: "channels",
    label: "Channel",
    detail: `${total} channel${total === 1 ? "" : "s"} available`,
    status: "ready",
  };
}

function buildTaskReadinessItem(total: number, loading: boolean, hasChannel: boolean, onCreateTask: () => void): WorkspaceReadinessItem {
  if (loading) {
    return {
      id: "tasks",
      label: "Tasks",
      detail: "Loading selected channel tasks",
      status: "loading",
    };
  }
  if (total === 0) {
    return {
      id: "tasks",
      label: "Tasks",
      detail: hasChannel ? "No task in selected channel" : "Create a channel first",
      status: hasChannel ? "info" : "attention",
      actionLabel: hasChannel ? "Create" : undefined,
      onAction: hasChannel ? onCreateTask : undefined,
    };
  }
  return {
    id: "tasks",
    label: "Tasks",
    detail: `${total} task${total === 1 ? "" : "s"} in selected channel`,
    status: "ready",
  };
}

function buildRunLoopReadinessItem(succeededRunCount: number, loading: boolean, onOpenRuns: () => void): WorkspaceReadinessItem {
  if (loading) {
    return {
      id: "run-loop",
      label: "Run loop",
      detail: "Loading run history",
      status: "loading",
      actionLabel: "Runs",
      onAction: onOpenRuns,
      disabled: true,
    };
  }
  if (succeededRunCount === 0) {
    return {
      id: "run-loop",
      label: "Run loop",
      detail: "No successful run yet",
      status: "info",
      actionLabel: "Runs",
      onAction: onOpenRuns,
    };
  }
  return {
    id: "run-loop",
    label: "Run loop",
    detail: `${succeededRunCount} successful run${succeededRunCount === 1 ? "" : "s"}`,
    status: "ready",
    actionLabel: "Runs",
    onAction: onOpenRuns,
  };
}

function readinessIcon(status: WorkspaceReadinessItem["status"]): JSX.Element {
  if (status === "ready") {
    return <CheckCircle2 size={17} />;
  }
  if (status === "loading") {
    return <Loader2 className="spin" size={17} />;
  }
  if (status === "info") {
    return <Clock3 size={17} />;
  }
  return <CircleAlert size={17} />;
}

function readinessActionIcon(item: WorkspaceReadinessItem): JSX.Element {
  if (item.actionLabel === "Providers") {
    return <PlugZap size={14} />;
  }
  if (item.actionLabel === "Runs") {
    return <History size={14} />;
  }
  if (item.actionLabel === "Create") {
    return <Plus size={14} />;
  }
  return <RefreshCw size={14} />;
}

function ChannelTaskWorkspace({
  cwd,
  channels,
  selectedChannelId,
  channelForm,
  channelEditForm,
  tasks,
  taskForm,
  selectedTaskId,
  taskEditForm,
  providers,
  taskRunProviderId,
  fallbackProviderId,
  channelsLoading,
  tasksLoading,
  isRunning,
  activeRunId,
  latestStatus,
  runById,
  repairRun,
  errorMessage,
  onCwdChange,
  onChannelFormChange,
  onChannelEditFormChange,
  onTaskFormChange,
  onTaskEditFormChange,
  onProviderSelect,
  onSelectChannel,
  onCreateChannel,
  onSaveChannelEdit,
  onDeleteChannel,
  onRefreshChannels,
  onCreateTask,
  onRefreshTasks,
  onSelectTask,
  onSaveTaskEdit,
  onRunTask,
  onCheckThenRunTask,
  onRunUpdatedTask,
  onCheckThenRunUpdatedTask,
  onReviewTask,
  onDeleteTask,
  onOpenRun,
  onOpenApprovals,
  onOpenProviders,
  onClearRepair,
}: {
  readonly cwd: string;
  readonly channels: readonly Channel[];
  readonly selectedChannelId: string;
  readonly channelForm: ChannelFormState;
  readonly channelEditForm: ChannelFormState;
  readonly tasks: readonly Task[];
  readonly taskForm: TaskFormState;
  readonly selectedTaskId: string;
  readonly taskEditForm: TaskEditFormState;
  readonly providers: readonly ProviderPreset[];
  readonly taskRunProviderId: string;
  readonly fallbackProviderId: string;
  readonly channelsLoading: boolean;
  readonly tasksLoading: boolean;
  readonly isRunning: boolean;
  readonly activeRunId: string;
  readonly latestStatus: string;
  readonly runById: ReadonlyMap<string, RunSession>;
  readonly repairRun: RunSession | undefined;
  readonly errorMessage: string;
  readonly onCwdChange: (cwd: string) => void;
  readonly onChannelFormChange: (form: ChannelFormState) => void;
  readonly onChannelEditFormChange: (form: ChannelFormState) => void;
  readonly onTaskFormChange: (form: TaskFormState) => void;
  readonly onTaskEditFormChange: (form: TaskEditFormState) => void;
  readonly onProviderSelect: (providerId: string) => void;
  readonly onSelectChannel: (channelId: string) => void;
  readonly onCreateChannel: () => void;
  readonly onSaveChannelEdit: (channelId: string) => void;
  readonly onDeleteChannel: (channelId: string) => void;
  readonly onRefreshChannels: () => void;
  readonly onCreateTask: () => void;
  readonly onRefreshTasks: () => void;
  readonly onSelectTask: (taskId: string) => void;
  readonly onSaveTaskEdit: (taskId: string) => void;
  readonly onRunTask: (task: Task) => void;
  readonly onCheckThenRunTask: (task: Task) => void;
  readonly onRunUpdatedTask: (task: Task) => void;
  readonly onCheckThenRunUpdatedTask: (task: Task) => void;
  readonly onReviewTask: (taskId: string) => void;
  readonly onDeleteTask: (taskId: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
  readonly onClearRepair: () => void;
}): JSX.Element {
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const selectedTaskRun = selectedTask?.currentRunId ? runById.get(selectedTask.currentRunId) : undefined;
  const selectedTaskRunStatus = selectedTask?.currentRunId
    ? displayLinkedRunStatus(selectedTask.currentRunId, selectedTaskRun, activeRunId, latestStatus)
    : "";
  const selectedTaskRepairHint = buildRunRepairHint(selectedTaskRun, 0, selectedTaskRunStatus);
  const effectiveProviderId = (taskRunProviderId || selectedChannel?.defaultProviderPresetId || fallbackProviderId) ?? "";
  const runnableProviders = providers.filter(canUseProviderForRun);
  const blockedProviders = providers.filter((provider) => !canUseProviderForRun(provider));
  const effectiveProvider = providers.find((provider) => provider.id === effectiveProviderId);
  const canRunWithEffectiveProvider = Boolean(effectiveProvider && canUseProviderForRun(effectiveProvider));
  const effectiveProviderPreflightBlocker = providerRunPreflightBlocker(effectiveProvider);
  const canPreflightRunWithEffectiveProvider = Boolean(effectiveProvider && canRunWithEffectiveProvider && effectiveProviderPreflightBlocker === undefined);
  const selectedTaskRepairRun = selectedTask && repairRun?.taskId === selectedTask.id && repairRun.channelId === selectedTask.channelId
    ? repairRun
    : undefined;

  return (
    <div className="task-workspace">
      <section className="panel channel-panel" aria-labelledby="channels-title">
        <div className="panel-title split">
          <span>
            <Workflow size={18} />
            <h2 id="channels-title">Channels</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onRefreshChannels} disabled={channelsLoading}>
            {channelsLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            Refresh
          </button>
        </div>

        <label className="field wide">
          <span>Workspace path</span>
          <input value={cwd} onChange={(event) => onCwdChange(event.target.value)} />
        </label>

        {errorMessage ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {errorMessage}
          </div>
        ) : null}

        <div className="channel-list">
          {channels.length === 0 ? (
            <div className="empty-state compact-empty">
              {channelsLoading ? <Loader2 className="spin" /> : <Workflow />}
              <span>{channelsLoading ? "Loading channels..." : "No channels yet"}</span>
            </div>
          ) : (
            channels.map((channel) => (
              <button
                key={channel.id}
                className={channel.id === selectedChannelId ? "channel-row selected" : "channel-row"}
                type="button"
                onClick={() => onSelectChannel(channel.id)}
              >
                <span className="channel-row-main">
                  <strong>{channel.name}</strong>
                  <small>Execution: {channel.boundPath ?? cwd}</small>
                </span>
                <span className="channel-tools">{channel.allowedTools.join(", ")}</span>
              </button>
            ))
          )}
        </div>

        {selectedChannel ? (
          <div className="channel-detail" aria-label="Channel detail">
            <div className="panel-title tight split">
              <span>
                <Pencil size={16} />
                <h3>Channel detail</h3>
              </span>
              <span className="event-count">{selectedChannel.allowedTools.length} tools</span>
            </div>
            <div className="channel-detail-meta">
              <MetaRow label="Channel id" value={selectedChannel.id} compact />
              <MetaRow label="Workspace path" value={cwd} compact />
              <MetaRow label="Execution path" value={selectedChannel.boundPath ?? cwd} compact />
            </div>
            <label className="field wide">
              <span>Name</span>
              <input value={channelEditForm.name} onChange={(event) => onChannelEditFormChange({ ...channelEditForm, name: event.target.value })} />
            </label>
            <label className="field wide">
              <span>Execution path</span>
              <input
                value={channelEditForm.boundPath}
                onChange={(event) => onChannelEditFormChange({ ...channelEditForm, boundPath: event.target.value })}
              />
            </label>
            <label className="field wide">
              <span>Default provider</span>
              <select
                value={channelEditForm.defaultProviderPresetId}
                onChange={(event) => onChannelEditFormChange({ ...channelEditForm, defaultProviderPresetId: event.target.value })}
              >
                <option value="">None</option>
                <ProviderPresetOptions runnableProviders={runnableProviders} blockedProviders={blockedProviders} />
              </select>
            </label>
            <div className="tool-grid compact-tools" aria-label="Channel detail allowed tools">
              {allTools.map((tool) => (
                <label
                  key={tool}
                  className={`${channelEditForm.allowedTools.includes(tool) ? "tool-toggle selected" : "tool-toggle"}${riskyTools.includes(tool) ? " requires-approval" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={channelEditForm.allowedTools.includes(tool)}
                    onChange={(event) => {
                      const allowedTools = event.target.checked
                        ? [...channelEditForm.allowedTools, tool]
                        : channelEditForm.allowedTools.filter((item) => item !== tool);
                      onChannelEditFormChange({ ...channelEditForm, allowedTools });
                    }}
                  />
                  <span>{tool}</span>
                </label>
              ))}
            </div>
            <button className="primary-button full" type="button" onClick={() => onSaveChannelEdit(selectedChannel.id)}>
              <Save size={16} />
              Save channel
            </button>
          </div>
        ) : null}

        <div className="channel-create">
          <div className="panel-title tight">
            <Plus size={16} />
            <h3>New channel</h3>
          </div>
          <label className="field wide">
            <span>Name</span>
            <input value={channelForm.name} onChange={(event) => onChannelFormChange({ ...channelForm, name: event.target.value })} />
          </label>
          <label className="field wide">
            <span>Execution path</span>
            <input value={channelForm.boundPath} onChange={(event) => onChannelFormChange({ ...channelForm, boundPath: event.target.value })} />
          </label>
          <label className="field wide">
            <span>Default provider</span>
            <select
              value={channelForm.defaultProviderPresetId}
              onChange={(event) => onChannelFormChange({ ...channelForm, defaultProviderPresetId: event.target.value })}
            >
              <option value="">None</option>
              <ProviderPresetOptions runnableProviders={runnableProviders} blockedProviders={blockedProviders} />
            </select>
          </label>
          <div className="tool-grid compact-tools" aria-label="Channel allowed tools">
            {allTools.map((tool) => (
              <label
                key={tool}
                className={`${channelForm.allowedTools.includes(tool) ? "tool-toggle selected" : "tool-toggle"}${riskyTools.includes(tool) ? " requires-approval" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={channelForm.allowedTools.includes(tool)}
                  onChange={(event) => {
                    const allowedTools = event.target.checked
                      ? [...channelForm.allowedTools, tool]
                      : channelForm.allowedTools.filter((item) => item !== tool);
                    onChannelFormChange({ ...channelForm, allowedTools });
                  }}
                />
                <span>{tool}</span>
              </label>
            ))}
          </div>
          <button className="primary-button full" type="button" onClick={onCreateChannel}>
            <Plus size={16} />
            Create channel
          </button>
        </div>
      </section>

      <section className="panel task-panel" aria-labelledby="tasks-title">
        <div className="panel-title split">
          <span>
            <SquareTerminal size={18} />
            <h2 id="tasks-title">Tasks</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onRefreshTasks} disabled={!selectedChannelId || tasksLoading}>
            {tasksLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            Refresh
          </button>
        </div>

        <div className="selected-channel-strip">
          <div>
            <span>Channel</span>
            <strong>{selectedChannel?.name ?? "None selected"}</strong>
          </div>
          {selectedChannel ? (
            <button className="secondary-button compact-button danger" type="button" onClick={() => onDeleteChannel(selectedChannel.id)}>
              <Trash2 size={14} />
              Delete
            </button>
          ) : null}
        </div>

        <label className="field wide">
          <span>Run provider</span>
          <select value={effectiveProviderId} onChange={(event) => onProviderSelect(event.target.value)} disabled={providers.length === 0}>
            <option value="">Select provider preset</option>
            <ProviderPresetOptions runnableProviders={runnableProviders} blockedProviders={blockedProviders} />
          </select>
        </label>
        {providers.length === 0 || runnableProviders.length === 0 || !effectiveProvider || effectiveProviderPreflightBlocker ? (
          <div className={canPreflightRunWithEffectiveProvider ? "provider-run-notice ok" : "provider-run-notice"}>
            {canPreflightRunWithEffectiveProvider ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
            <span>
              {providers.length === 0
                ? "No saved provider presets. Create one from GPT, Claude, relay, or domestic templates."
                : runnableProviders.length === 0
                  ? "No runnable provider presets. Enable a chat provider and configure its env key."
                  : effectiveProvider
                    ? (effectiveProviderPreflightBlocker ?? `${effectiveProvider.displayName}: ${providerRunBlockerLabel(effectiveProvider)}.`)
                    : "Select a provider preset before running tasks."}
            </span>
            <button className="secondary-button compact-button" type="button" onClick={() => onOpenProviders()}>
              Providers
            </button>
          </div>
        ) : null}

        <div className="task-create">
          <label className="field wide">
            <span>Title</span>
            <input value={taskForm.title} onChange={(event) => onTaskFormChange({ ...taskForm, title: event.target.value })} />
          </label>
          <label className="field wide">
            <span>Prompt</span>
            <textarea value={taskForm.prompt} rows={5} onChange={(event) => onTaskFormChange({ ...taskForm, prompt: event.target.value })} />
          </label>
          <button className="primary-button" type="button" onClick={onCreateTask} disabled={!selectedChannelId}>
            <Plus size={16} />
            Create task
          </button>
        </div>

        {selectedTask ? (
          <div className="task-detail" aria-label="Task detail">
            <div className="panel-title tight split">
              <span>
                <Pencil size={16} />
                <h3>Task detail</h3>
              </span>
              <span className={`task-status ${selectedTask.status}`}>{selectedTask.status}</span>
            </div>
            <div className="task-detail-meta">
              <MetaRow label="Task id" value={selectedTask.id} compact />
              <MetaRow label="Channel" value={selectedTask.channelId} compact />
              <MetaRow label="Current run" value={selectedTask.currentRunId ?? "-"} compact />
            </div>
            {selectedTask.currentRunId ? (
              <div className="task-run-link">
                <StatusBadge status={selectedTaskRunStatus} />
                <code>{selectedTask.currentRunId}</code>
                <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(selectedTask.currentRunId ?? "")}>
                  <History size={14} />
                  Open run
                </button>
              </div>
            ) : null}
            {selectedTask.currentRunId && selectedTaskRepairHint ? (
              <RunRepairHintBanner
                hint={selectedTaskRepairHint}
                runId={selectedTask.currentRunId}
                compact
                onOpenProviders={() => onOpenProviders(selectedTaskRun)}
                onOpenApprovals={onOpenApprovals}
                onOpenRun={onOpenRun}
              />
            ) : null}
            {selectedTaskRepairRun ? (
              <TaskRepairHandoffPanel
                task={selectedTask}
                run={selectedTaskRepairRun}
                isRunning={isRunning}
                canRun={canPreflightRunWithEffectiveProvider}
                canCheckRun={canRunWithEffectiveProvider}
                onRunUpdatedTask={onRunUpdatedTask}
                onCheckThenRunUpdatedTask={onCheckThenRunUpdatedTask}
                onOpenRun={onOpenRun}
                onClear={onClearRepair}
              />
            ) : null}
            <label className="field wide">
              <span>Title</span>
              <input value={taskEditForm.title} onChange={(event) => onTaskEditFormChange({ ...taskEditForm, title: event.target.value })} />
            </label>
            <label className="field wide">
              <span>Status</span>
              <select value={taskEditForm.status} onChange={(event) => onTaskEditFormChange({ ...taskEditForm, status: event.target.value as TaskStatus })}>
                {taskStatuses.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <label className="field wide">
              <span>Prompt</span>
              <textarea value={taskEditForm.prompt} rows={7} onChange={(event) => onTaskEditFormChange({ ...taskEditForm, prompt: event.target.value })} />
            </label>
            <TaskProviderReadiness provider={effectiveProvider} onOpenProviders={() => onOpenProviders()} />
            <div className="task-actions">
              <button className="primary-button" type="button" onClick={() => onSaveTaskEdit(selectedTask.id)}>
                <Save size={16} />
                Save task
              </button>
              <button className="secondary-button compact-button" type="button" onClick={() => onCheckThenRunTask(selectedTask)} disabled={isRunning || !canRunWithEffectiveProvider}>
                {isRunning ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                Check run
              </button>
              <button className="secondary-button compact-button" type="button" onClick={() => onRunTask(selectedTask)} disabled={isRunning || !canPreflightRunWithEffectiveProvider}>
                {isRunning ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                Run
              </button>
            </div>
          </div>
        ) : null}

        <div className="task-list">
          {tasks.length === 0 ? (
            <div className="empty-state compact-empty">
              {tasksLoading ? <Loader2 className="spin" /> : <Clock3 />}
              <span>{tasksLoading ? "Loading tasks..." : "No tasks in this channel"}</span>
            </div>
          ) : (
            tasks.map((task) => {
              const linkedRun = task.currentRunId ? runById.get(task.currentRunId) : undefined;
              const linkedRunStatus = task.currentRunId
                ? displayLinkedRunStatus(task.currentRunId, linkedRun, activeRunId, latestStatus)
                : "";
              const repairHint = buildRunRepairHint(linkedRun, 0, linkedRunStatus);
              return (
                <article key={task.id} className={task.id === selectedTaskId ? "task-row selected" : "task-row"}>
                  <div className="task-row-head">
                    <strong>{task.title}</strong>
                    <span className={`task-status ${task.status}`}>{task.status}</span>
                  </div>
                  <p>{task.prompt}</p>
                  <div className="provider-meta-line mono">
                    <span>{task.id}</span>
                    <time>{formatDateTime(task.updatedAt)}</time>
                  </div>
                  {task.currentRunId ? (
                    <div className="task-run-link compact">
                      <StatusBadge status={linkedRunStatus} />
                      <code>{task.currentRunId}</code>
                      <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(task.currentRunId ?? "")}>
                        <History size={14} />
                        Open run
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
                  <div className="task-actions">
                    <button className="secondary-button compact-button" type="button" onClick={() => onSelectTask(task.id)}>
                      <Pencil size={14} />
                      Edit
                    </button>
                    <button className="secondary-button compact-button" type="button" onClick={() => onCheckThenRunTask(task)} disabled={isRunning || !canRunWithEffectiveProvider}>
                      {isRunning ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                      Check run
                    </button>
                    <button className="secondary-button compact-button" type="button" onClick={() => onRunTask(task)} disabled={isRunning || !canPreflightRunWithEffectiveProvider}>
                      {isRunning ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                      Run
                    </button>
                    <button className="secondary-button compact-button" type="button" onClick={() => onReviewTask(task.id)} disabled={task.status === "review"}>
                      <CheckCircle2 size={14} />
                      Review
                    </button>
                    <button className="secondary-button compact-button danger" type="button" onClick={() => onDeleteTask(task.id)}>
                      <Trash2 size={14} />
                      Delete
                    </button>
                  </div>
                </article>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}

function TaskRepairHandoffPanel({
  task,
  run,
  isRunning,
  canRun,
  canCheckRun,
  onRunUpdatedTask,
  onCheckThenRunUpdatedTask,
  onOpenRun,
  onClear,
}: {
  readonly task: Task;
  readonly run: RunSession;
  readonly isRunning: boolean;
  readonly canRun: boolean;
  readonly canCheckRun: boolean;
  readonly onRunUpdatedTask: (task: Task) => void;
  readonly onCheckThenRunUpdatedTask: (task: Task) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onClear: () => void;
}): JSX.Element {
  const snapshotTitle = readTaskTitle(run.taskSnapshot) || run.taskId;
  const failedReason = run.errorMessage || "This run failed before completing.";

  return (
    <div className="task-repair-handoff" aria-label="Task repair handoff">
      <div className="task-repair-handoff-head">
        <span>
          <SquareTerminal size={16} />
          <strong>Run updated task</strong>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="task-repair-handoff-copy">
        <span>
          Editing <code>{task.id}</code> to repair failed run <code>{run.id}</code>.
        </span>
        <small>Failed snapshot: {snapshotTitle}. {failedReason}</small>
        <small>Rerun snapshot replays the old request. Save + run updated task uses the current task editor values.</small>
      </div>
      <div className="task-repair-handoff-actions">
        <button className="primary-button compact-button" type="button" onClick={() => onRunUpdatedTask(task)} disabled={isRunning || !canRun}>
          {isRunning ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
          Save + run updated task
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onCheckThenRunUpdatedTask(task)} disabled={isRunning || !canCheckRun}>
          {isRunning ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
          Save + check run
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(run.id)}>
          <History size={14} />
          Open failed run
        </button>
      </div>
    </div>
  );
}

function TaskProviderReadiness({
  provider,
  onOpenProviders,
}: {
  readonly provider: ProviderPreset | undefined;
  readonly onOpenProviders: () => void;
}): JSX.Element {
  const blocker = providerRunPreflightBlocker(provider);
  const ready = Boolean(provider && !blocker);
  const lastCheck = provider?.lastCheck;
  const checkedAt = lastCheck ? formatDateTime(lastCheck.checkedAt) : "not checked";

  return (
    <div className={ready ? "task-provider-readiness ok" : "task-provider-readiness"}>
      {ready ? <CheckCircle2 size={17} /> : <CircleAlert size={17} />}
      <div className="task-provider-readiness-copy">
        <div className="task-provider-readiness-head">
          <strong>{ready ? "Provider ready" : "Provider needs attention"}</strong>
          <span className={provider ? providerLastCheckClass(provider) : "provider-state check-unknown"}>
            {provider ? providerLastCheckLabel(provider) : "no provider"}
          </span>
        </div>
        <p>{taskProviderReadinessMessage(provider, blocker)}</p>
        <div className="task-provider-readiness-meta">
          <MetaRow label="Provider" value={provider ? provider.displayName : "-"} compact />
          <MetaRow label="Model" value={provider ? provider.model : "-"} compact />
          <MetaRow label="Checked" value={checkedAt} compact />
        </div>
        {lastCheck && !lastCheck.ok ? <small>{lastCheck.message}</small> : null}
        <small>{taskProviderReadinessGuidance(provider)}</small>
      </div>
      <button className="secondary-button compact-button" type="button" onClick={onOpenProviders}>
        Providers
      </button>
    </div>
  );
}

function RunHistory({
  cwd,
  runs,
  selectedRunId,
  selectedRun,
  events,
  artifacts,
  assistantText,
  approvals,
  approvalsLoading,
  resolvingApprovals,
  isLoading,
  isRunning,
  errorMessage,
  onCwdChange,
  onRefresh,
  onRefreshSelected,
  onRefreshApprovals,
  onRerun,
  onResolveApproval,
  onOpenProviders,
  onOpenApprovals,
  onEditTask,
  onSelect,
}: {
  readonly cwd: string;
  readonly runs: readonly RunSession[];
  readonly selectedRunId: string;
  readonly selectedRun: RunSession | undefined;
  readonly events: readonly RunEventEnvelope[];
  readonly artifacts: readonly RunArtifact[];
  readonly assistantText: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly isLoading: boolean;
  readonly isRunning: boolean;
  readonly errorMessage: string;
  readonly onCwdChange: (cwd: string) => void;
  readonly onRefresh: () => void;
  readonly onRefreshSelected: () => void;
  readonly onRefreshApprovals: () => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onEditTask: (run: RunSession) => void;
  readonly onSelect: (runId: string) => void;
}): JSX.Element {
  return (
    <div className="run-history-layout">
      <section className="panel runs-panel" aria-labelledby="run-history-title">
        <div className="panel-title split">
          <span>
            <History size={18} />
            <h2 id="run-history-title">Recent runs</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading}>
            {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
            Refresh
          </button>
        </div>

        <label className="field wide runs-cwd">
          <span>Workspace path</span>
          <input value={cwd} onChange={(event) => onCwdChange(event.target.value)} />
        </label>

        {errorMessage ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {errorMessage}
          </div>
        ) : null}

        <div className="runs-list">
          {runs.length === 0 ? (
            <div className="empty-state compact-empty">
              {isLoading ? <Loader2 className="spin" /> : <Clock3 />}
              <span>{isLoading ? "Loading runs..." : "No persisted runs for this workspace"}</span>
            </div>
          ) : (
            runs.map((item) => (
              <button
                key={item.id}
                className={item.id === selectedRunId ? "run-list-row selected" : "run-list-row"}
                type="button"
                onClick={() => onSelect(item.id)}
              >
                <span className={`status-dot ${item.status}`} />
                <span className="run-list-main">
                  <strong>{readTaskTitle(item.taskSnapshot) || item.taskId}</strong>
                  <small>{item.id}</small>
                </span>
                <span className="run-list-meta">
                  <StatusBadge status={item.status} />
                  <time>{formatDateTime(item.createdAt)}</time>
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      <RunDetailPanel
        run={selectedRun}
        events={events}
        artifacts={artifacts}
        assistantText={assistantText}
        approvals={approvals}
        approvalsLoading={approvalsLoading}
        resolvingApprovals={resolvingApprovals}
        isRunning={isRunning}
        onRefresh={onRefreshSelected}
        onRefreshApprovals={onRefreshApprovals}
        onRerun={onRerun}
        onResolveApproval={onResolveApproval}
        onOpenProviders={onOpenProviders}
        onOpenApprovals={onOpenApprovals}
        onEditTask={onEditTask}
      />
    </div>
  );
}

function RunDetailPanel({
  run,
  events,
  artifacts,
  assistantText,
  approvals,
  approvalsLoading,
  resolvingApprovals,
  isRunning,
  onRefresh,
  onRefreshApprovals,
  onRerun,
  onResolveApproval,
  onOpenProviders,
  onOpenApprovals,
  onEditTask,
}: {
  readonly run: RunSession | undefined;
  readonly events: readonly RunEventEnvelope[];
  readonly artifacts: readonly RunArtifact[];
  readonly assistantText: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly isRunning: boolean;
  readonly onRefresh: () => void;
  readonly onRefreshApprovals: () => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenProviders: (run?: RunSession) => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onEditTask: (run: RunSession) => void;
}): JSX.Element {
  const toolEvents = events.filter((event) => event.type.startsWith("tool_"));
  const terminalEvent = [...events].reverse().find((event) => ["result", "run_error", "run_cancelled", "run_end"].includes(event.type));
  const workspaceCwd = run ? readDataString(run.requestSnapshot, "workspaceCwd") || run.cwd : "-";
  const providerPresetId = run ? readRunProviderPresetId(run) : "";
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const repairHint = run ? buildRunRepairHint(run, pendingApprovals.length, run.status, readRunEventIssueText(terminalEvent)) : undefined;
  const runtimeRepairRun = run && run.status === "failed" && repairHint?.target === "run" ? run : undefined;

  return (
    <section className="panel run-detail-panel" aria-labelledby="run-detail-title">
      <div className="panel-title split">
        <span>
          <Activity size={18} />
          <h2 id="run-detail-title">Run detail</h2>
        </span>
        <span className="run-detail-actions">
          <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={!run || isRunning}>
            <RefreshCw size={15} />
            Reload
          </button>
          <button className="primary-button compact-button" type="button" onClick={() => run && onRerun(run)} disabled={!run || isRunning || !providerPresetId}>
            {isRunning ? <Loader2 className="spin" size={15} /> : <RotateCcw size={15} />}
            Rerun snapshot
          </button>
        </span>
      </div>

      {!run ? (
        <div className="empty-state">
          <Search />
          <span>Select a run to inspect execution details</span>
        </div>
      ) : (
        <div className="run-detail-content">
          <div className="run-detail-summary">
            <MetaRow label="Status" value={run.status} compact />
            <MetaRow label="Workspace cwd" value={workspaceCwd} compact />
            <MetaRow label="Execution cwd" value={run.cwd} compact />
            <MetaRow label="Provider" value={`${run.providerName}/${run.providerModel}`} compact />
            <MetaRow label="Provider preset" value={providerPresetId || "-"} compact />
            <MetaRow label="Task" value={run.taskId} compact />
            <MetaRow label="Channel" value={run.channelId ?? "-"} compact />
            <MetaRow label="Created" value={formatDateTime(run.createdAt)} compact />
            <MetaRow label="Ended" value={run.endedAt ? formatDateTime(run.endedAt) : "-"} compact />
          </div>

          {repairHint ? (
            <RunRepairHintBanner
              hint={repairHint}
              runId={run.id}
              onOpenProviders={() => onOpenProviders(run)}
              onOpenApprovals={onOpenApprovals}
              onReload={onRefresh}
            />
          ) : null}

          {run.errorMessage ? (
            <div className="inline-error">
              <CircleAlert size={17} />
              {run.errorMessage}
            </div>
          ) : null}

          {runtimeRepairRun ? (
            <RuntimeRunRepairPanel
              run={runtimeRepairRun}
              events={events}
              workspaceCwd={workspaceCwd}
              isRunning={isRunning}
              onEditTask={onEditTask}
              onRerun={onRerun}
              onReload={onRefresh}
            />
          ) : null}

          <div className="run-detail-section approval-state-section">
            <div className="panel-title tight split">
              <span>
                <ShieldCheck size={16} />
                <h3>Approval state</h3>
              </span>
              <span className="approval-section-actions">
                <span className="event-count">{approvals.length} approval events</span>
                <button className="secondary-button compact-button" type="button" onClick={onRefreshApprovals} disabled={approvalsLoading}>
                  {approvalsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                  Refresh
                </button>
              </span>
            </div>
            {pendingApprovals.length > 0 ? (
              <div className="approval-waiting-banner" role="status">
                <Clock3 size={16} />
                <span>
                  Waiting for {pendingApprovals.length} approval{pendingApprovals.length > 1 ? "s" : ""}:{" "}
                  {pendingApprovals.map((approval) => approval.actionType).join(", ")}
                </span>
              </div>
            ) : null}
            {approvals.length === 0 ? (
              <p className="muted">No approval gates recorded for this run.</p>
            ) : (
              <div className="run-approval-list">
                {approvals.map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    compact
                    resolvingDecision={resolvingApprovals[approval.id]}
                    onResolve={onResolveApproval}
                  />
                ))}
              </div>
            )}
          </div>

          {assistantText ? (
            <div className="assistant-output">
              <span>Assistant output</span>
              <p>{assistantText}</p>
            </div>
          ) : null}

          <div className="run-detail-section">
            <div className="panel-title tight">
              <Bot size={16} />
              <h3>Task snapshot</h3>
            </div>
            <strong>{readTaskTitle(run.taskSnapshot) || run.taskId}</strong>
            <p>{readTaskPrompt(run.taskSnapshot) || "No prompt snapshot."}</p>
          </div>

          <div className="run-detail-section">
            <div className="panel-title tight split">
              <span>
                <SquareTerminal size={16} />
                <h3>Tool activity</h3>
              </span>
              <span className="event-count">{toolEvents.length} tool events</span>
            </div>
            {toolEvents.length === 0 ? (
              <p className="muted">No tool activity recorded.</p>
            ) : (
              <div className="tool-event-list">
                {toolEvents.map((event) => (
                  <ToolEventDetails key={event.id} event={event} events={events} />
                ))}
              </div>
            )}
          </div>

          <div className="run-detail-section">
            <div className="panel-title tight split">
              <span>
                <Database size={16} />
                <h3>Event timeline</h3>
              </span>
              <span className="event-count">{events.length} events</span>
            </div>
            {events.length === 0 ? (
              <p className="muted">No events loaded.</p>
            ) : (
              <div className="event-list run-detail-events">
                {events.map((event) => <EventRow key={event.id} event={event} />)}
              </div>
            )}
          </div>

          <RunEvidencePanel
            run={run}
            terminalEvent={terminalEvent}
            toolEvents={toolEvents}
            assistantText={assistantText}
            approvals={approvals}
            artifacts={artifacts}
          />

          <div className="run-detail-section">
            <div className="panel-title tight">
              <Database size={16} />
              <h3>Debug snapshots</h3>
            </div>
            <details className="json-details">
              <summary>Request snapshot</summary>
              <pre>{formatEventData(run.requestSnapshot)}</pre>
            </details>
            <details className="json-details">
              <summary>Provider snapshot</summary>
              <pre>{formatEventData(run.providerSnapshot)}</pre>
            </details>
            {terminalEvent ? (
              <details className="json-details">
                <summary>Terminal event</summary>
                <pre>{formatEventData(terminalEvent.data)}</pre>
              </details>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

function RunEvidencePanel({
  run,
  terminalEvent,
  toolEvents,
  assistantText,
  approvals,
  artifacts,
}: {
  readonly run: RunSession;
  readonly terminalEvent: RunEventEnvelope | undefined;
  readonly toolEvents: readonly RunEventEnvelope[];
  readonly assistantText: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly artifacts: readonly RunArtifact[];
}): JSX.Element {
  const taskLabel = readTaskTitle(run.taskSnapshot) || run.taskId;
  const providerLabel = `${run.providerName}/${run.providerModel}`;
  const terminalLabel = terminalEvent ? `#${terminalEvent.seq} ${terminalEvent.type}` : "-";
  const evidenceMessage = readRunEvidenceMessage(run, terminalEvent);
  const assistantPreview = buildAssistantOutputPreview(assistantText);
  const toolSummary = summarizeToolEvents(toolEvents);
  const artifactCwd = readRunWorkspaceCwd(run, run.cwd);

  return (
    <div className="run-detail-section run-evidence">
      <div className="panel-title tight split">
        <span>
          <CheckCircle2 size={16} />
          <h3>Evidence</h3>
        </span>
        <span className="event-count">audit preview</span>
      </div>

      <div className="run-evidence-block">
        <strong>Run summary preview</strong>
        <div className="run-evidence-grid">
          <MetaRow label="Status" value={run.status} compact />
          <MetaRow label="Task" value={taskLabel} compact />
          <MetaRow label="Provider" value={providerLabel} compact />
          <MetaRow label="Terminal event" value={terminalLabel} compact />
          <MetaRow label="Tool events" value={String(toolSummary.total)} compact />
          <MetaRow label="Errored tools" value={String(toolSummary.errorCount)} compact />
          <MetaRow label="Approvals" value={String(approvals.length)} compact />
        </div>
        <p className={`run-evidence-copy${run.status === "failed" ? " error" : ""}`}>{evidenceMessage}</p>
        <p className="run-evidence-copy">
          <strong>Assistant output</strong>
          {assistantPreview}
        </p>
      </div>

      <div className="run-evidence-block">
        <strong>Session files</strong>
        <div className="session-file-list">
          <span>Event log</span>
          <code>{run.eventLogPath}</code>
          <span>Summary</span>
          <code>{run.summaryPath ?? "-"}</code>
        </div>
      </div>

      <div className="run-evidence-block">
        <strong>Artifacts</strong>
        {artifacts.length === 0 ? (
          <div className="artifact-empty-state">
            <span>No artifacts recorded for this run</span>
            <small>Artifacts will appear here once the daemon records files under .ling-stack/artifacts.</small>
          </div>
        ) : (
          <div className="artifact-list">
            {artifacts.map((artifact) => (
              <a className="artifact-row" href={artifactContentUrl(artifact.id, artifactCwd)} key={artifact.id} target="_blank" rel="noreferrer">
                <span className="artifact-type">{artifact.type}</span>
                <span className="artifact-main">
                  <strong>{artifact.title || artifact.path}</strong>
                  <code>{artifact.path}</code>
                </span>
                <small>{formatArtifactSize(artifact.sizeBytes)}</small>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RuntimeRunRepairPanel({
  run,
  events,
  workspaceCwd,
  isRunning,
  onEditTask,
  onRerun,
  onReload,
}: {
  readonly run: RunSession;
  readonly events: readonly RunEventEnvelope[];
  readonly workspaceCwd: string;
  readonly isRunning: boolean;
  readonly onEditTask: (run: RunSession) => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onReload: () => void;
}): JSX.Element {
  const summary = buildRuntimeFailureSummary(run, events, workspaceCwd);
  const canEditTask = Boolean(run.channelId && run.taskId);
  const canRerun = Boolean(readRunProviderPresetId(run));

  return (
    <div className="runtime-run-repair" aria-label="Runtime run repair">
      <div className="runtime-run-repair-head">
        <span>
          <SquareTerminal size={16} />
          <strong>Repair runtime/tool failure</strong>
        </span>
        <StatusBadge status={run.status} />
      </div>
      <div className="runtime-run-repair-copy">
        <span>
          Run <code>{run.id}</code> failed at <code>{summary.eventLabel}</code>.
        </span>
        <small>{summary.issueText}</small>
        <small>{summary.suggestion}</small>
      </div>
      <div className="runtime-run-repair-meta">
        <MetaRow label="Tool" value={summary.toolName || "-"} compact />
        <MetaRow label="Event" value={summary.eventLabel} compact />
        <MetaRow label="Cwd" value={summary.cwd || "-"} compact />
        <MetaRow label="Exit code" value={summary.exitCode || "-"} compact />
        {summary.command ? <MetaRow label="Command" value={summary.command} compact /> : null}
        {summary.targetPath ? <MetaRow label="Target path" value={summary.targetPath} compact /> : null}
      </div>
      <div className="runtime-run-repair-actions">
        <button className="secondary-button compact-button" type="button" onClick={() => onEditTask(run)} disabled={!canEditTask}>
          <Pencil size={14} />
          Edit task
        </button>
        <button className="primary-button compact-button" type="button" onClick={() => onRerun(run)} disabled={isRunning || !canRerun}>
          {isRunning ? <Loader2 className="spin" size={14} /> : <RotateCcw size={14} />}
          Rerun snapshot
        </button>
        <button className="secondary-button compact-button" type="button" onClick={onReload} disabled={isRunning}>
          <RefreshCw size={14} />
          Reload
        </button>
      </div>
    </div>
  );
}

function ToolEventDetails({
  event,
  events,
}: {
  readonly event: RunEventEnvelope;
  readonly events: readonly RunEventEnvelope[];
}): JSX.Element {
  const isError = readDataBoolean(event.data, "isError");
  const toolName = readDataString(event.data, "toolName") || event.type.replace("tool_", "");
  const relatedToolStart = event.type === "tool_start" ? undefined : findRelatedToolStart(events, event);
  const toolCallId = readDeepDataScalarString(event.data, ["toolCallId"]) || readDeepDataScalarString(relatedToolStart?.data, ["toolCallId"]);
  const command = readDeepDataScalarString(event.data, ["command", "cmd", "script"]) || readDeepDataScalarString(relatedToolStart?.data, ["command", "cmd", "script"]);
  const cwd = readDeepDataScalarString(event.data, ["cwd", "workdir", "workingDirectory"]) || readDeepDataScalarString(relatedToolStart?.data, ["cwd", "workdir", "workingDirectory"]);
  const targetPath = readDeepDataScalarString(event.data, ["path", "filePath", "targetPath", "target"])
    || readDeepDataScalarString(relatedToolStart?.data, ["path", "filePath", "targetPath", "target"]);
  const outputPreview = readDeepDataPreview(event.data, ["message", "error", "detail", "reason", "result", "partialResult", "output", "stdout", "stderr"]);
  const summaryPreview = outputPreview || command || formatEventPreview(event.data);

  return (
    <details className={`tool-event-row${isError ? " error" : ""}`} open={isError}>
      <summary className="tool-event-summary">
        <span>#{event.seq}</span>
        <strong>{toolName}</strong>
        <code>{event.type}</code>
        <small>{isError ? "error" : formatDateTime(event.ts)}</small>
      </summary>
      <div className="tool-event-details">
        {summaryPreview ? <p className="tool-event-preview">{summaryPreview}</p> : null}
        <div className="tool-event-meta">
          <MetaRow label="Tool call" value={toolCallId || "-"} compact />
          <MetaRow label="Command" value={command || "-"} compact />
          <MetaRow label="Cwd" value={cwd || "-"} compact />
          <MetaRow label="Target path" value={targetPath || "-"} compact />
        </div>
        <details className="json-details compact-json">
          <summary>Raw tool payload</summary>
          <pre>{formatEventData(event.data)}</pre>
        </details>
      </div>
    </details>
  );
}

function ProviderSettings({
  cwd,
  providers,
  templates,
  form,
  editingProviderId,
  isLoading,
  checkingProviderIds,
  errorMessage,
  checkResult,
  checkedProviderId,
  batchResult,
  selectedProviderId,
  repairRun,
  isRunning,
  onCwdChange,
  onFormChange,
  onTemplateSelect,
  onNew,
  onSave,
  onRefresh,
  onEdit,
  onDelete,
  onCheck,
  onCheckBatch,
  onUse,
  onRerun,
  onOpenRun,
  onClearRepair,
}: {
  readonly cwd: string;
  readonly providers: readonly ProviderPreset[];
  readonly templates: readonly ProviderTemplate[];
  readonly form: ProviderFormState;
  readonly editingProviderId: string;
  readonly isLoading: boolean;
  readonly checkingProviderIds: readonly string[];
  readonly errorMessage: string;
  readonly checkResult: ProviderCheckResult | undefined;
  readonly checkedProviderId: string;
  readonly batchResult: ProviderBatchResult | undefined;
  readonly selectedProviderId: string;
  readonly repairRun: RunSession | undefined;
  readonly isRunning: boolean;
  readonly onCwdChange: (cwd: string) => void;
  readonly onFormChange: (form: ProviderFormState) => void;
  readonly onTemplateSelect: (template: ProviderTemplate) => void;
  readonly onNew: () => void;
  readonly onSave: () => void;
  readonly onRefresh: () => void;
  readonly onEdit: (provider: ProviderPreset) => void;
  readonly onDelete: (providerId: string) => void;
  readonly onCheck: (providerId: string) => void;
  readonly onCheckBatch: () => void;
  readonly onUse: (provider: ProviderPreset) => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onClearRepair: () => void;
}): JSX.Element {
  const compatibleProviderCount = providers.filter(canUseProviderForRun).length;
  const preflightReadyProviderCount = providers.filter(providerPreflightReady).length;
  const batchCheckProviderCount = providers.filter(canBatchCheckProvider).length;
  const missingSecretCount = providers.filter((provider) => providerNeedsSecret(provider) && !provider.apiKeyConfigured).length;
  const chatTemplateCount = templates.filter((template) => template.capabilities.includes("chat")).length;
  const mediaTemplateCount = templates.length - chatTemplateCount;
  const templateGroups = groupProviderTemplates(templates);
  const repairItems = buildProviderRepairItems(providers);
  const nextActionProvider =
    providers.find(
      (provider) =>
        provider.enabled &&
        provider.api !== "media-job" &&
        provider.capabilities.includes("chat") &&
        providerNeedsSecret(provider) &&
        !provider.apiKeyConfigured,
    ) ??
    providers.find(canUseProviderForRun) ??
    providers.find((provider) => providerNeedsSecret(provider) && !provider.apiKeyConfigured);
  const checkedProvider = checkedProviderId ? providers.find((provider) => provider.id === checkedProviderId) : undefined;
  const isCheckingProviders = checkingProviderIds.length > 0;
  const repairProviderId = repairRun ? readRunProviderPresetId(repairRun) : "";
  const repairProvider = repairProviderId ? providers.find((provider) => provider.id === repairProviderId) : undefined;

  return (
    <div className="provider-layout">
      <section className="panel provider-list-panel" aria-labelledby="provider-list-title">
        <div className="panel-title split">
          <span>
            <PlugZap size={18} />
            <h2 id="provider-list-title">Provider presets</h2>
          </span>
          <div className="provider-title-actions">
            <button className="secondary-button compact-button" type="button" onClick={onCheckBatch} disabled={isCheckingProviders || batchCheckProviderCount === 0}>
              {isCheckingProviders ? <Loader2 className="spin" size={15} /> : <CheckCircle2 size={15} />}
              Check all
            </button>
            <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading || isCheckingProviders}>
              {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
              Refresh
            </button>
          </div>
        </div>

        <label className="field wide runs-cwd">
          <span>Workspace path</span>
          <input value={cwd} onChange={(event) => onCwdChange(event.target.value)} />
        </label>

        {errorMessage ? (
          <div className="inline-error">
            <CircleAlert size={17} />
            {errorMessage}
          </div>
        ) : null}

        <div className="provider-onboarding-strip" aria-label="Provider onboarding status">
          <MetaRow label="Compatible chat" value={String(compatibleProviderCount)} compact />
          <MetaRow label="Preflight ready" value={String(preflightReadyProviderCount)} compact />
          <MetaRow label="Missing env" value={String(missingSecretCount)} compact />
          <MetaRow label="Templates" value={`${chatTemplateCount} chat / ${mediaTemplateCount} media`} compact />
        </div>

        <ProviderNextAction providers={providers} nextActionProvider={nextActionProvider} isLoading={isLoading} />
        {repairRun ? (
          <ProviderRunRepairPanel
            run={repairRun}
            provider={repairProvider}
            isChecking={repairProvider ? checkingProviderIds.includes(repairProvider.id) : false}
            isRunning={isRunning}
            onEdit={onEdit}
            onCheck={onCheck}
            onRerun={onRerun}
            onOpenRun={onOpenRun}
            onClear={onClearRepair}
          />
        ) : null}
        {providers.length > 0 ? (
          <ProviderRepairQueue
            items={repairItems}
            checkingProviderIds={checkingProviderIds}
            onEdit={onEdit}
            onCheck={onCheck}
          />
        ) : null}
        {batchResult ? (
          <div className={batchResult.failedCount === 0 ? "provider-batch-result ok" : "provider-batch-result bad"}>
            {batchResult.failedCount === 0 ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
            <span>{batchResult.message}</span>
          </div>
        ) : null}

        <div className="provider-list">
          {providers.length === 0 ? (
            <div className="empty-state compact-empty">
              {isLoading ? <Loader2 className="spin" /> : <PlugZap />}
              <span>{isLoading ? "Loading providers..." : "Create a preset from GPT, Claude, relay, or domestic provider templates"}</span>
            </div>
          ) : (
            providers.map((provider) => (
              <article key={provider.id} className={provider.id === selectedProviderId ? "provider-row selected" : "provider-row"}>
                <div className="provider-row-main">
                  <div className="provider-row-head">
                    <strong>{provider.displayName}</strong>
                    <span className={provider.enabled ? "provider-state enabled" : "provider-state disabled"}>
                      {provider.enabled ? "enabled" : "disabled"}
                    </span>
                    <span className={provider.apiKeyConfigured ? "provider-state key-ok" : "provider-state key-missing"}>
                      {provider.apiKeyRef ? (provider.apiKeyConfigured ? "key ready" : "key missing") : "no key ref"}
                    </span>
                    <span className={providerPreflightReady(provider) ? "provider-state run-ready" : "provider-state run-blocked"}>
                      {providerPreflightReady(provider) ? "preflight ready" : canUseProviderForRun(provider) ? "needs check" : providerRunBlockerLabel(provider)}
                    </span>
                    <span className={providerLastCheckClass(provider)} title={providerLastCheckTitle(provider)}>
                      {providerLastCheckLabel(provider)}
                    </span>
                  </div>
                  <div className="provider-meta-line">
                    <span>{provider.kind}</span>
                    <span>{provider.providerId}</span>
                    <span>{provider.model}</span>
                    <span>{provider.api}</span>
                    <span>{provider.lastCheck ? `last check ${formatDateTime(provider.lastCheck.checkedAt)}` : "not checked"}</span>
                  </div>
                  <div className="provider-meta-line mono">
                    <span>{provider.baseUrl ?? "default endpoint"}</span>
                    {provider.apiKeyRef ? <span>{provider.apiKeyRef}</span> : null}
                  </div>
                  <div className="capability-list">
                    {provider.capabilities.map((capability) => (
                      <span key={capability}>{capability}</span>
                    ))}
                  </div>
                </div>
                <div className="provider-actions">
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    disabled={!providerPreflightReady(provider)}
                    onClick={() => onUse(provider)}
                  >
                    <Play size={14} />
                    Use
                  </button>
                  <button className="secondary-button compact-button" type="button" onClick={() => onEdit(provider)}>
                    <Pencil size={14} />
                    Edit
                  </button>
                  <button className="secondary-button compact-button" type="button" disabled={isCheckingProviders} onClick={() => onCheck(provider.id)}>
                    {checkingProviderIds.includes(provider.id) ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                    Check
                  </button>
                  <button className="secondary-button compact-button danger" type="button" onClick={() => onDelete(provider.id)}>
                    <Trash2 size={14} />
                    Delete
                  </button>
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      <section className="panel provider-form-panel" aria-labelledby="provider-form-title">
        <div className="panel-title split">
          <span>
            <Settings size={18} />
            <h2 id="provider-form-title">{editingProviderId ? "Edit preset" : "New preset"}</h2>
          </span>
          <button className="secondary-button compact-button" type="button" onClick={onNew}>
            <Plus size={14} />
            New
          </button>
        </div>

        <div className="provider-template-board" aria-label="Provider templates">
          {templateGroups.length === 0 ? (
            <div className="empty-state compact-empty">
              <PlugZap />
              <span>No templates available.</span>
            </div>
          ) : (
            templateGroups.map((group) => (
              <div key={group.label} className="provider-template-group">
                <div className="provider-template-group-head">
                  <span>{group.label}</span>
                  <small>{group.templates.length}</small>
                </div>
                <div className="provider-template-grid">
                  {group.templates.map((template) => (
                    <button
                      key={template.templateId}
                      className="provider-template-card"
                      type="button"
                      onClick={() => onTemplateSelect(template)}
                    >
                      <span className="provider-template-kind">{providerTemplateKindLabel(template)}</span>
                      <strong>{template.displayName}</strong>
                      <span className="provider-template-model">{template.model}</span>
                      <small>{template.description}</small>
                      {template.apiKeyRef ? <code>{template.apiKeyRef}</code> : null}
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="field-row">
          <label className="field">
            <span>Kind</span>
            <select value={form.kind} onChange={(event) => onFormChange({ ...form, kind: event.target.value as ProviderFormState["kind"] })}>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="openai-compatible">OpenAI compatible</option>
              <option value="doubao">Doubao</option>
              <option value="deepseek">DeepSeek</option>
              <option value="minimax">MiniMax</option>
              <option value="glm">GLM</option>
              <option value="jimeng">Jimeng</option>
              <option value="seedream">Seedream</option>
              <option value="seedance">Seedance</option>
            </select>
          </label>
          <label className="field">
            <span>Display name</span>
            <input value={form.displayName} onChange={(event) => onFormChange({ ...form, displayName: event.target.value })} />
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>Provider id</span>
            <input value={form.providerId} onChange={(event) => onFormChange({ ...form, providerId: event.target.value })} />
          </label>
          <label className="field">
            <span>Model</span>
            <input value={form.model} onChange={(event) => onFormChange({ ...form, model: event.target.value })} />
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            <span>API protocol</span>
            <select value={form.api} onChange={(event) => onFormChange({ ...form, api: event.target.value as ProviderFormState["api"] })}>
              <option value="openai-completions">OpenAI completions</option>
              <option value="openai-responses">OpenAI responses</option>
              <option value="anthropic-messages">Anthropic messages</option>
              <option value="google-generative-ai">Google generative AI</option>
              <option value="mistral-conversations">Mistral conversations</option>
              <option value="media-job">Media job</option>
            </select>
          </label>
          <label className="field">
            <span>Base URL</span>
            <input value={form.baseUrl} onChange={(event) => onFormChange({ ...form, baseUrl: event.target.value })} />
          </label>
        </div>

        <label className="field wide">
          <span>API key ref</span>
          <input value={form.apiKeyRef} placeholder="env:LOCAL_RELAY_API_KEY" onChange={(event) => onFormChange({ ...form, apiKeyRef: event.target.value })} />
        </label>
        <ProviderEnvHint apiKeyRef={form.apiKeyRef} />

        <div className="field-row provider-number-row">
          <label className="field">
            <span>Input</span>
            <input value={form.inputText} onChange={(event) => onFormChange({ ...form, inputText: event.target.value })} />
          </label>
          <label className="field">
            <span>Context</span>
            <input value={form.contextWindow} inputMode="numeric" onChange={(event) => onFormChange({ ...form, contextWindow: event.target.value })} />
          </label>
          <label className="field">
            <span>Max tokens</span>
            <input value={form.maxTokens} inputMode="numeric" onChange={(event) => onFormChange({ ...form, maxTokens: event.target.value })} />
          </label>
        </div>

        <label className="field wide">
          <span>Capabilities</span>
          <input value={form.capabilitiesText} onChange={(event) => onFormChange({ ...form, capabilitiesText: event.target.value })} />
        </label>

        <div className="provider-toggle-row">
          <label className="settings-toggle">
            <input type="checkbox" checked={form.enabled} onChange={(event) => onFormChange({ ...form, enabled: event.target.checked })} />
            <span>Enabled</span>
          </label>
          <label className="settings-toggle">
            <input type="checkbox" checked={form.authHeader} onChange={(event) => onFormChange({ ...form, authHeader: event.target.checked })} />
            <span>Auth header</span>
          </label>
          <label className="settings-toggle">
            <input type="checkbox" checked={form.reasoning} onChange={(event) => onFormChange({ ...form, reasoning: event.target.checked })} />
            <span>Reasoning</span>
          </label>
        </div>

        {checkResult ? (
          <div className={checkResult.ok ? "check-result ok" : "check-result bad"}>
            {checkResult.ok ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
            <div className="check-result-copy">
              <span className="check-result-status">{providerCheckStatusLabel(checkResult)}</span>
              <strong>{checkedProvider ? checkedProvider.displayName : "Provider check"}</strong>
              <span>{checkResult.message}</span>
              <small>{providerCheckGuidance(checkResult, checkedProvider ?? (editingProviderId ? providers.find((provider) => provider.id === editingProviderId) : undefined))}</small>
            </div>
          </div>
        ) : null}

        <div className="action-row">
          <button className="primary-button" type="button" onClick={onSave}>
            <Save size={16} />
            {editingProviderId ? "Save changes" : "Create preset"}
          </button>
          <button className="secondary-button" type="button" disabled={!editingProviderId || isCheckingProviders} onClick={() => onCheck(editingProviderId)}>
            {checkingProviderIds.includes(editingProviderId) ? <Loader2 className="spin" size={16} /> : <CheckCircle2 size={16} />}
            Check preset
          </button>
        </div>
        <div className="provider-form-hint">
          {editingProviderId ? "Run Check after saving to validate env, base URL, and model access." : "Create the preset first, then run Check before using it in Workspace."}
        </div>
      </section>
    </div>
  );
}

function ProviderNextAction({
  providers,
  nextActionProvider,
  isLoading,
}: {
  readonly providers: readonly ProviderPreset[];
  readonly nextActionProvider: ProviderPreset | undefined;
  readonly isLoading: boolean;
}): JSX.Element | null {
  if (isLoading) {
    return null;
  }

  if (providers.length === 0) {
    return (
      <div className="provider-next-action">
        <CircleAlert size={16} />
        <span>Next: choose a template, save the preset, then run Check before using it.</span>
      </div>
    );
  }

  const readyProvider = providers.find(providerPreflightReady);
  if (readyProvider) {
    return (
      <div className="provider-next-action ok">
        <CheckCircle2 size={16} />
        <span>
          Ready: {readyProvider.displayName} passed preflight and can run tasks. Re-check after env, base URL, or model changes.
        </span>
      </div>
    );
  }

  if (nextActionProvider && providerNeedsSecret(nextActionProvider) && !nextActionProvider.apiKeyConfigured) {
    const envName = nextActionProvider.apiKeyRef ? envNameFromRef(nextActionProvider.apiKeyRef) : "API_KEY";
    return (
      <div className="provider-next-action">
        <CircleAlert size={16} />
        <span>
          Next: set <code>{envName}</code> for {nextActionProvider.displayName}, restart the daemon, then run Check.
        </span>
      </div>
    );
  }

  if (nextActionProvider && canUseProviderForRun(nextActionProvider)) {
    if (!nextActionProvider.lastCheck) {
      return (
        <div className="provider-next-action">
          <CircleAlert size={16} />
          <span>Next: run Check for {nextActionProvider.displayName} before using it in Workspace.</span>
        </div>
      );
    }
    if (!nextActionProvider.lastCheck.ok) {
      return (
        <div className="provider-next-action">
          <CircleAlert size={16} />
          <span>
            Next: repair {nextActionProvider.displayName} check failure ({providerCheckStatusLabel(nextActionProvider.lastCheck)}), then run Check again.
          </span>
        </div>
      );
    }
  }

  return (
    <div className="provider-next-action">
      <CircleAlert size={16} />
      <span>Next: enable a chat provider with a supported API protocol, then run Check.</span>
    </div>
  );
}

function ProviderRunRepairPanel({
  run,
  provider,
  isChecking,
  isRunning,
  onEdit,
  onCheck,
  onRerun,
  onOpenRun,
  onClear,
}: {
  readonly run: RunSession;
  readonly provider: ProviderPreset | undefined;
  readonly isChecking: boolean;
  readonly isRunning: boolean;
  readonly onEdit: (provider: ProviderPreset) => void;
  readonly onCheck: (providerId: string) => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onClear: () => void;
}): JSX.Element {
  const providerReady = provider ? providerPreflightReady(provider) : false;
  const providerCheckText = provider
    ? provider.lastCheck
      ? `${providerCheckStatusLabel(provider.lastCheck)}: ${provider.lastCheck.message}`
      : "Provider has not been checked yet."
    : "The provider preset used by this run is missing.";

  return (
    <div className="provider-run-repair" aria-label="Provider run repair">
      <div className="provider-run-repair-head">
        <span>
          <CircleAlert size={16} />
          <strong>Repair failed run provider</strong>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="provider-run-repair-copy">
        <span>
          Run <code>{run.id}</code> failed with <strong>{provider?.displayName ?? (readRunProviderPresetId(run) || "missing provider")}</strong>.
        </span>
        {run.errorMessage ? <small>{run.errorMessage}</small> : null}
        <small>{providerCheckText}</small>
      </div>
      <div className="provider-run-repair-steps">
        <span className={provider ? "provider-state check-ok" : "provider-state check-bad"}>{provider ? "provider found" : "provider missing"}</span>
        <span className={providerReady ? "provider-state run-ready" : "provider-state run-blocked"}>
          {providerReady ? "preflight ready" : provider ? providerRunPreflightBlocker(provider) : "cannot rerun"}
        </span>
      </div>
      <div className="provider-run-repair-actions">
        <button className="secondary-button compact-button" type="button" onClick={() => provider && onEdit(provider)} disabled={!provider}>
          <Pencil size={14} />
          Edit provider
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => provider && onCheck(provider.id)} disabled={!provider || isChecking || isRunning}>
          {isChecking ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
          Check provider
        </button>
        <button className="primary-button compact-button" type="button" onClick={() => onRerun(run)} disabled={!providerReady || isChecking || isRunning}>
          {isRunning ? <Loader2 className="spin" size={14} /> : <RotateCcw size={14} />}
          Rerun
        </button>
        <button className="secondary-button compact-button" type="button" onClick={() => onOpenRun(run.id)}>
          <History size={14} />
          Back to run
        </button>
      </div>
    </div>
  );
}

function ProviderRepairQueue({
  items,
  checkingProviderIds,
  onEdit,
  onCheck,
}: {
  readonly items: readonly ProviderRepairItem[];
  readonly checkingProviderIds: readonly string[];
  readonly onEdit: (provider: ProviderPreset) => void;
  readonly onCheck: (providerId: string) => void;
}): JSX.Element | null {
  if (items.length === 0) {
    return (
      <div className="provider-repair-queue ok">
        <CheckCircle2 size={16} />
        <span>All saved chat providers are either preflight-ready or intentionally out of the run path.</span>
      </div>
    );
  }

  return (
    <div className="provider-repair-queue" aria-label="Provider repair queue">
      <div className="provider-repair-head">
        <span>Repair queue</span>
        <small>{items.length}</small>
      </div>
      {items.map((item) => (
        <article key={item.provider.id} className={`provider-repair-item ${item.status}`}>
          {item.status === "warning" ? <Clock3 size={16} /> : <CircleAlert size={16} />}
          <span className="provider-repair-copy">
            <strong>{item.title}</strong>
            <small>{item.detail}</small>
          </span>
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => {
              if (item.action === "check") {
                onCheck(item.provider.id);
                return;
              }
              onEdit(item.provider);
            }}
            disabled={checkingProviderIds.includes(item.provider.id)}
          >
            {checkingProviderIds.includes(item.provider.id) ? (
              <Loader2 className="spin" size={14} />
            ) : item.action === "check" ? (
              <CheckCircle2 size={14} />
            ) : (
              <Pencil size={14} />
            )}
            {item.actionLabel}
          </button>
        </article>
      ))}
    </div>
  );
}

function buildProviderRepairItems(providers: readonly ProviderPreset[]): readonly ProviderRepairItem[] {
  return providers
    .map(buildProviderRepairItem)
    .filter((item): item is ProviderRepairItem => item !== undefined)
    .slice(0, 4);
}

function buildProviderRepairItem(provider: ProviderPreset): ProviderRepairItem | undefined {
  if (providerPreflightReady(provider)) {
    return undefined;
  }

  if (providerNeedsSecret(provider) && !provider.apiKeyConfigured) {
    const envName = provider.apiKeyRef ? envNameFromRef(provider.apiKeyRef) : "API_KEY";
    return {
      provider,
      title: `${provider.displayName}: set env`,
      detail: `export ${envName}=... then restart the daemon and run Check.`,
      status: "attention",
      action: "edit",
      actionLabel: "Edit",
    };
  }

  if (!provider.enabled || provider.api === "media-job" || !provider.capabilities.includes("chat")) {
    return {
      provider,
      title: `${provider.displayName}: not chat-compatible`,
      detail: provider.api === "media-job" ? "Media providers are not runnable for coding tasks yet." : `Current blocker: ${providerRunBlockerLabel(provider)}.`,
      status: "attention",
      action: "edit",
      actionLabel: "Edit",
    };
  }

  if (!provider.lastCheck) {
    return {
      provider,
      title: `${provider.displayName}: needs check`,
      detail: "Validate env, base URL, protocol, and model before using it in Workspace.",
      status: "warning",
      action: "check",
      actionLabel: "Check",
    };
  }

  return {
    provider,
    title: `${provider.displayName}: ${providerCheckStatusLabel(provider.lastCheck)}`,
    detail: `${provider.lastCheck.message} ${providerCheckGuidance(provider.lastCheck, provider)}`,
    status: "attention",
    action: "check",
    actionLabel: "Retry",
  };
}

function ProviderEnvHint({ apiKeyRef }: { readonly apiKeyRef: string }): JSX.Element {
  const trimmedRef = apiKeyRef.trim();
  if (!trimmedRef) {
    return (
      <div className="provider-env-hint">
        <SquareTerminal size={15} />
        <span>Use an env ref like <code>env:DEEPSEEK_API_KEY</code> to keep API keys out of Ling Stack data.</span>
      </div>
    );
  }

  if (!trimmedRef.startsWith("env:")) {
    return (
      <div className="provider-env-hint">
        <SquareTerminal size={15} />
        <span>Make sure the daemon can resolve this secret ref before running Check.</span>
      </div>
    );
  }

  const envName = envNameFromRef(trimmedRef);
  return (
    <div className="provider-env-hint">
      <SquareTerminal size={15} />
      <span>
        Shell: <code>export {envName}=...</code>. Restart or reload the daemon after setting env.
      </span>
    </div>
  );
}

function SettingsPage({
  cwd,
  policy,
  form,
  isLoading,
  errorMessage,
  onCwdChange,
  onFormChange,
  onRefresh,
  onSave,
}: {
  readonly cwd: string;
  readonly policy: ApprovalPolicy | undefined;
  readonly form: ApprovalPolicyFormState;
  readonly isLoading: boolean;
  readonly errorMessage: string;
  readonly onCwdChange: (cwd: string) => void;
  readonly onFormChange: (form: ApprovalPolicyFormState) => void;
  readonly onRefresh: () => void;
  readonly onSave: () => void;
}): JSX.Element {
  return (
    <section className="panel settings-panel" aria-labelledby="settings-title">
      <div className="panel-title split">
        <span>
          <Settings size={18} />
          <h2 id="settings-title">Approval policy</h2>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          Refresh
        </button>
      </div>

      <label className="field wide runs-cwd">
        <span>Workspace path</span>
        <input value={cwd} onChange={(event) => onCwdChange(event.target.value)} />
      </label>

      {errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      <div className="policy-meta">
        <MetaRow label="Workspace" value={policy?.workspaceId ?? "-"} compact />
        <MetaRow label="Updated" value={policy ? formatDateTime(policy.updatedAt) : "-"} compact />
      </div>

      <div className="policy-tool-grid" aria-label="Tool approval decisions">
        {allTools.map((tool) => (
          <label key={tool} className={`policy-tool-row${riskyTools.includes(tool) ? " risky" : ""}`}>
            <span>{tool}</span>
            <select
              value={form.toolDecisions[tool]}
              onChange={(event) =>
                onFormChange({
                  ...form,
                  toolDecisions: {
                    ...form.toolDecisions,
                    [tool]: event.target.value as ApprovalToolDecision,
                  },
                })
              }
            >
              <option value="allow">Allow</option>
              <option value="ask">Ask</option>
              <option value="deny">Deny</option>
            </select>
          </label>
        ))}
      </div>

      <label className="field wide">
        <span>Allowed write paths</span>
        <textarea
          value={form.allowedWritePathsText}
          onChange={(event) => onFormChange({ ...form, allowedWritePathsText: event.target.value })}
        />
      </label>

      <div className="action-row">
        <button className="primary-button" type="button" onClick={onSave} disabled={isLoading}>
          {isLoading ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
          Save policy
        </button>
      </div>
    </section>
  );
}

function ApprovalsPage({
  cwd,
  approvals,
  repairRunId,
  repairRun,
  isLoading,
  resolvingApprovals,
  errorMessage,
  onCwdChange,
  onRefresh,
  onRefreshRepair,
  onResolve,
  onOpenRun,
  onClearRepair,
}: {
  readonly cwd: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly repairRunId: string;
  readonly repairRun: RunSession | undefined;
  readonly isLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly errorMessage: string;
  readonly onCwdChange: (cwd: string) => void;
  readonly onRefresh: () => void;
  readonly onRefreshRepair: (runId: string) => void;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
  readonly onOpenRun: (runId: string) => void;
  readonly onClearRepair: () => void;
}): JSX.Element {
  const focusedApprovals = repairRunId ? approvals.filter((approval) => approval.runId === repairRunId) : approvals;
  const listEmptyCopy = repairRunId ? "No approval records for this run" : "No approval requests for this workspace";

  return (
    <section className="panel approvals-panel" aria-labelledby="approvals-title">
      <div className="panel-title split">
        <span>
          <ShieldCheck size={18} />
          <h2 id="approvals-title">Approval requests</h2>
        </span>
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={repairRunId ? () => onRefreshRepair(repairRunId) : onRefresh}
          disabled={isLoading}
        >
          {isLoading ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
          Refresh
        </button>
      </div>

      <label className="field wide runs-cwd">
        <span>Workspace path</span>
        <input value={cwd} onChange={(event) => onCwdChange(event.target.value)} />
      </label>

      {errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      {repairRunId ? (
        <ApprovalRunRepairPanel
          runId={repairRunId}
          run={repairRun}
          approvals={focusedApprovals}
          isLoading={isLoading}
          onRefresh={() => onRefreshRepair(repairRunId)}
          onOpenRun={() => onOpenRun(repairRunId)}
          onClear={onClearRepair}
        />
      ) : null}

      <div className="approval-list">
        {focusedApprovals.length === 0 ? (
          <div className="empty-state compact-empty">
            {isLoading ? <Loader2 className="spin" /> : <ShieldCheck />}
            <span>{isLoading ? "Loading approvals..." : listEmptyCopy}</span>
          </div>
        ) : (
          focusedApprovals.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              resolvingDecision={resolvingApprovals[approval.id]}
              onResolve={onResolve}
            />
          ))
        )}
      </div>
    </section>
  );
}

function ApprovalRunRepairPanel({
  runId,
  run,
  approvals,
  isLoading,
  onRefresh,
  onOpenRun,
  onClear,
}: {
  readonly runId: string;
  readonly run: RunSession | undefined;
  readonly approvals: readonly ApprovalRequest[];
  readonly isLoading: boolean;
  readonly onRefresh: () => void;
  readonly onOpenRun: () => void;
  readonly onClear: () => void;
}): JSX.Element {
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const resolvedApprovals = approvals.filter((approval) => approval.status !== "pending");
  const highestRisk = highestApprovalRisk(approvals);
  const actionTypes = [...new Set(approvals.map((approval) => approval.actionType))];
  const taskLabel = run ? readTaskTitle(run.taskSnapshot) || run.taskId : approvals[0]?.taskId ?? "-";

  return (
    <div className="approval-run-repair" aria-label="Approval run repair">
      <div className="approval-run-repair-head">
        <span>
          <ShieldCheck size={16} />
          <strong>Resolve run approvals</strong>
        </span>
        <button className="secondary-button compact-button" type="button" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="approval-run-repair-copy">
        <span>
          Run <code>{runId}</code> is focused for approval repair.
        </span>
        <small>Task: {taskLabel}</small>
      </div>
      <div className="approval-run-repair-meta">
        <span className="approval-state pending">{pendingApprovals.length} pending</span>
        <span className="approval-state approved">{resolvedApprovals.length} resolved</span>
        <span className={`approval-risk ${highestRisk}`}>{highestRisk}</span>
        {actionTypes.length > 0 ? <span className="approval-state">{actionTypes.join(", ")}</span> : null}
      </div>
      <div className="approval-run-repair-actions">
        <button className="secondary-button compact-button" type="button" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
          Reload
        </button>
        <button className="primary-button compact-button" type="button" onClick={onOpenRun}>
          <History size={14} />
          Back to run
        </button>
      </div>
    </div>
  );
}

function ApprovalCard({
  approval,
  compact = false,
  resolvingDecision,
  onResolve,
}: {
  readonly approval: ApprovalRequest;
  readonly compact?: boolean;
  readonly resolvingDecision?: ApprovalResolution;
  readonly onResolve: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
}): JSX.Element {
  const [decisionReason, setDecisionReason] = useState("");
  const [confirmDecision, setConfirmDecision] = useState<ApprovalResolution | undefined>();
  const [reasonError, setReasonError] = useState("");
  const isResolving = Boolean(resolvingDecision);
  const requiresSecondConfirmation = approval.risk === "high" || approval.risk === "critical";
  const trimmedReason = decisionReason.trim();

  function submitDecision(decision: ApprovalResolution): void {
    if (isResolving) {
      return;
    }

    if (decision === "approve" && requiresSecondConfirmation) {
      if (confirmDecision !== "approve") {
        setConfirmDecision("approve");
        setReasonError(trimmedReason ? "" : "High-risk approvals need a decision reason.");
        return;
      }
      if (!trimmedReason) {
        setReasonError("High-risk approvals need a decision reason.");
        return;
      }
    }

    setConfirmDecision(undefined);
    setReasonError("");
    onResolve(approval.id, decision, trimmedReason || undefined);
  }

  return (
    <article className={`approval-row ${approval.risk}${compact ? " compact" : ""}`}>
      <div className="approval-main">
        <div className="approval-head">
          <strong>{approval.title}</strong>
          <span className={`approval-state ${approval.status}`}>{approval.status}</span>
          <span className={`approval-risk ${approval.risk}`}>{approval.risk}</span>
        </div>
        <p>{approval.description}</p>
        <div className="provider-meta-line">
          <span>{approval.actionType}</span>
          <span>{approval.taskId}</span>
          <span>{approval.runId}</span>
          <time>{formatDateTime(approval.createdAt)}</time>
          {approval.resolvedAt ? <time>resolved {formatDateTime(approval.resolvedAt)}</time> : null}
        </div>
        {approval.decisionReason ? <p className="approval-decision-reason">{approval.decisionReason}</p> : null}
        <pre>{formatEventData(approval.payload)}</pre>
      </div>
      {approval.status === "pending" ? (
        <div className="approval-decision-panel">
          <label className="approval-reason-field">
            <span>Decision reason</span>
            <textarea
              value={decisionReason}
              rows={compact ? 2 : 3}
              placeholder={requiresSecondConfirmation ? "Required before approving high-risk requests" : "Optional note for the audit log"}
              disabled={isResolving}
              onChange={(event) => {
                setDecisionReason(event.target.value);
                if (event.target.value.trim()) {
                  setReasonError("");
                }
              }}
            />
          </label>
          {reasonError ? <p className="approval-reason-error">{reasonError}</p> : null}
          {confirmDecision === "approve" ? (
            <div className="approval-confirm-panel" role="alert">
              <CircleAlert size={15} />
              <span>High-risk approval. Review the payload and reason, then confirm.</span>
              <button className="secondary-button compact-button" type="button" onClick={() => setConfirmDecision(undefined)} disabled={isResolving}>
                Cancel
              </button>
            </div>
          ) : null}
          <div className="approval-actions">
            <button
              className={confirmDecision === "approve" ? "secondary-button compact-button danger" : "secondary-button compact-button"}
              type="button"
              onClick={() => submitDecision("approve")}
              disabled={isResolving}
            >
              {resolvingDecision === "approve" ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
              {resolvingDecision === "approve" ? "Approving" : confirmDecision === "approve" ? "Confirm approve" : "Approve"}
            </button>
            <button
              className="secondary-button compact-button danger"
              type="button"
              onClick={() => submitDecision("deny")}
              disabled={isResolving}
            >
              {resolvingDecision === "deny" ? <Loader2 className="spin" size={14} /> : <CircleAlert size={14} />}
              {resolvingDecision === "deny" ? "Denying" : "Deny"}
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function RunLauncher({
  form,
  providers,
  isRunning,
  onChange,
  onProviderSelect,
  onStart,
  onStop,
}: {
  readonly form: RunFormState;
  readonly providers: readonly ProviderPreset[];
  readonly isRunning: boolean;
  readonly onChange: (form: RunFormState) => void;
  readonly onProviderSelect: (provider: ProviderPreset) => void;
  readonly onStart: () => void;
  readonly onStop: () => void;
}): JSX.Element {
  const usingPreset = Boolean(form.providerPresetId);
  return (
    <section className="panel launcher" aria-labelledby="run-launcher-title">
      <div className="panel-title">
        <SquareTerminal size={18} />
        <h2 id="run-launcher-title">Start run</h2>
      </div>

      <label className="field wide">
        <span>Workspace path</span>
        <input value={form.cwd} onChange={(event) => onChange({ ...form, cwd: event.target.value })} />
      </label>

      <div className="field-row">
        <label className="field">
          <span>Task id</span>
          <input value={form.taskId} onChange={(event) => onChange({ ...form, taskId: event.target.value })} />
        </label>
        <label className="field">
          <span>Title</span>
          <input value={form.title} onChange={(event) => onChange({ ...form, title: event.target.value })} />
        </label>
      </div>

      <label className="field wide">
        <span>Prompt</span>
        <textarea value={form.prompt} rows={6} onChange={(event) => onChange({ ...form, prompt: event.target.value })} />
      </label>

      <label className="field wide">
        <span>Provider preset</span>
        <select
          value={form.providerPresetId}
          onChange={(event) => {
            const provider = providers.find((item) => item.id === event.target.value);
            if (!provider) {
              onChange({ ...form, providerPresetId: "" });
              return;
            }
            onProviderSelect(provider);
          }}
        >
          <option value="">Manual inline provider</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id} disabled={!canUseProviderForRun(provider)}>
              {provider.displayName} / {provider.model}
            </option>
          ))}
        </select>
      </label>

      <div className="field-row">
        <label className="field">
          <span>Provider</span>
          <input
            value={form.provider}
            disabled={usingPreset}
            onChange={(event) => onChange({ ...form, provider: event.target.value })}
          />
        </label>
        <label className="field">
          <span>Model</span>
          <input
            value={form.model}
            disabled={usingPreset}
            onChange={(event) => onChange({ ...form, model: event.target.value })}
          />
        </label>
      </div>

      <label className="field wide">
        <span>Base URL</span>
        <input
          value={form.baseUrl}
          disabled={usingPreset}
          onChange={(event) => onChange({ ...form, baseUrl: event.target.value })}
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>API protocol</span>
          <select value={form.api} disabled={usingPreset} onChange={(event) => onChange({ ...form, api: event.target.value })}>
            <option value="openai-completions">OpenAI completions</option>
            <option value="openai-responses">OpenAI responses</option>
            <option value="anthropic-messages">Anthropic messages</option>
            <option value="google-generative-ai">Google generative AI</option>
            <option value="mistral-conversations">Mistral conversations</option>
          </select>
        </label>
        <label className="field">
          <span>Temporary API key</span>
          <input
            type="password"
            value={form.apiKey}
            disabled={usingPreset}
            placeholder="optional"
            onChange={(event) => onChange({ ...form, apiKey: event.target.value })}
          />
        </label>
      </div>

      <div className="tool-grid" aria-label="Allowed tools">
        {allTools.map((tool) => {
          const requiresApproval = riskyTools.includes(tool);
          return (
          <label
            key={tool}
            className={`${form.tools.includes(tool) ? "tool-toggle selected" : "tool-toggle"}${requiresApproval ? " requires-approval" : ""}`}
          >
            <input
              type="checkbox"
              checked={form.tools.includes(tool)}
              onChange={(event) => {
                const tools = event.target.checked ? [...form.tools, tool] : form.tools.filter((item) => item !== tool);
                onChange({ ...form, tools });
              }}
            />
            <span>{tool}</span>
          </label>
          );
        })}
      </div>

      <div className="action-row">
        <button className="primary-button" type="button" onClick={() => void onStart()} disabled={isRunning}>
          {isRunning ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
          Start
        </button>
        <button className="secondary-button" type="button" onClick={onStop} disabled={!isRunning}>
          Cancel run
        </button>
      </div>
    </section>
  );
}

function RunTimeline({
  events,
  assistantText,
  errorMessage,
  isRunning,
  pendingApprovals,
  approvalsLoading,
  resolvingApprovals,
  onRefreshApprovals,
  onResolveApproval,
}: {
  readonly events: readonly RunEventEnvelope[];
  readonly assistantText: string;
  readonly errorMessage: string;
  readonly isRunning: boolean;
  readonly pendingApprovals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly resolvingApprovals: Readonly<Record<string, ApprovalResolution>>;
  readonly onRefreshApprovals: () => void;
  readonly onResolveApproval: (approvalId: string, decision: ApprovalResolution, reason?: string) => void;
}): JSX.Element {
  return (
    <section className="panel timeline" aria-labelledby="run-timeline-title">
      <div className="panel-title split">
        <span>
          <Database size={18} />
          <h2 id="run-timeline-title">Event stream</h2>
        </span>
        <span className="event-count">{events.length} events</span>
      </div>

      {errorMessage ? (
        <div className="inline-error">
          <CircleAlert size={17} />
          {errorMessage}
        </div>
      ) : null}

      {assistantText ? (
        <div className="assistant-output">
          <span>Assistant</span>
          <p>{assistantText}</p>
        </div>
      ) : null}

      {pendingApprovals.length > 0 ? (
        <div className="inline-approval-panel" aria-live="polite">
          <div className="inline-approval-head">
            <span>
              <ShieldCheck size={16} />
              Pending approval
            </span>
            <button className="secondary-button compact-button" type="button" onClick={onRefreshApprovals} disabled={approvalsLoading}>
              {approvalsLoading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
              Refresh
            </button>
          </div>
          <div className="inline-approval-list">
            {pendingApprovals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                compact
                resolvingDecision={resolvingApprovals[approval.id]}
                onResolve={onResolveApproval}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="event-list">
        {events.length === 0 ? (
          <div className="empty-state">
            {isRunning ? <Loader2 className="spin" /> : <Clock3 />}
            <span>{isRunning ? "Waiting for runner events..." : "No run loaded yet"}</span>
          </div>
        ) : (
          events.map((event) => <EventRow key={event.id} event={event} />)
        )}
      </div>
    </section>
  );
}

function EventRow({ event }: { readonly event: RunEventEnvelope }): JSX.Element {
  const preview = formatEventPreview(event.data);
  const payloadOpen = event.type === "run_error" || event.type === "result" || (event.type === "tool_end" && readDataBoolean(event.data, "isError"));

  return (
    <article className={`event-row ${event.type}`}>
      <div className="event-seq">#{event.seq}</div>
      <div className="event-body">
        <div className="event-head">
          <span>{event.type}</span>
          <time>{new Date(event.ts).toLocaleTimeString()}</time>
        </div>
        <details className="event-payload" open={payloadOpen}>
          <summary>
            <span>{preview || "Payload"}</span>
          </summary>
          <pre>{formatEventData(event.data)}</pre>
        </details>
      </div>
    </article>
  );
}

function RunInspector({
  activeRunId,
  lookupRunId,
  run,
  events,
  onLookupRunIdChange,
  onLoadRun,
}: {
  readonly activeRunId: string;
  readonly lookupRunId: string;
  readonly run: RunSession | undefined;
  readonly events: readonly RunEventEnvelope[];
  readonly onLookupRunIdChange: (runId: string) => void;
  readonly onLoadRun: () => void;
}): JSX.Element {
  const toolEvents = events.filter((event) => event.type.startsWith("tool_"));
  return (
    <section className="inspector" aria-label="Run inspector">
      <div className="panel-title">
        <Search size={18} />
        <h2>Run context</h2>
      </div>
      <label className="field wide">
        <span>Run id</span>
        <input value={lookupRunId || activeRunId} onChange={(event) => onLookupRunIdChange(event.target.value)} />
      </label>
      <button className="secondary-button full" type="button" onClick={onLoadRun}>
        Load persisted run
      </button>

      <div className="meta-list">
        <MetaRow label="Status" value={run?.status ?? "not loaded"} />
        <MetaRow label="Task" value={run?.taskId ?? "-"} />
        <MetaRow label="Provider" value={run ? `${run.providerName}/${run.providerModel}` : "-"} />
        <MetaRow label="Event log" value={run?.eventLogPath ?? "-"} compact />
        <MetaRow label="Summary" value={run?.summaryPath ?? "-"} compact />
      </div>

      <div className="inspector-block">
        <h3>Tool calls</h3>
        {toolEvents.length === 0 ? (
          <p className="muted">No tool activity yet.</p>
        ) : (
          toolEvents.map((event) => (
            <div className="tool-row" key={event.id}>
              <span>{event.type.replace("tool_", "")}</span>
              <code>{readDataString(event.data, "toolName") || "tool"}</code>
            </div>
          ))
        )}
      </div>

      <div className="inspector-block">
        <h3>Persistence</h3>
        <div className="persistence-line">
          <CheckCircle2 size={16} />
          SQLite index
        </div>
        <div className="persistence-line">
          <CheckCircle2 size={16} />
          JSONL audit log
        </div>
      </div>
    </section>
  );
}

function MetaRow({
  label,
  value,
  compact = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly compact?: boolean;
}): JSX.Element {
  return (
    <div className={compact ? "meta-row compact" : "meta-row"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusBadge({ status }: { readonly status: string }): JSX.Element {
  return <span className={`status-badge ${status}`}>{status}</span>;
}

function RunRepairHintBanner({
  hint,
  runId,
  compact = false,
  onOpenProviders,
  onOpenApprovals,
  onOpenRun,
  onReload,
}: {
  readonly hint: RunRepairHint;
  readonly runId: string;
  readonly compact?: boolean;
  readonly onOpenProviders: () => void;
  readonly onOpenApprovals: (runId?: string) => void;
  readonly onOpenRun?: (runId: string) => void;
  readonly onReload?: () => void;
}): JSX.Element {
  const canOpenRun = hint.target === "run" && Boolean(onOpenRun);
  const canReload = hint.target === "run" && !onOpenRun && Boolean(onReload);
  const actionLabel = canReload ? "Reload" : hint.actionLabel;
  const onAction = hint.target === "providers"
    ? onOpenProviders
    : hint.target === "approvals"
      ? () => onOpenApprovals(runId)
      : canOpenRun
        ? () => onOpenRun?.(runId)
        : canReload
          ? onReload
          : undefined;

  return (
    <div className={`run-repair-hint ${hint.target}${compact ? " compact" : ""}`}>
      <span className="run-repair-icon">{runRepairIcon(hint.target)}</span>
      <span className="run-repair-copy">
        <strong>{hint.title}</strong>
        <small>{hint.detail}</small>
      </span>
      {onAction ? (
        <button className="secondary-button compact-button" type="button" onClick={onAction}>
          {runRepairIcon(hint.target)}
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function runRepairIcon(target: RunRepairTarget): JSX.Element {
  if (target === "providers") {
    return <PlugZap size={14} />;
  }
  if (target === "approvals") {
    return <ShieldCheck size={14} />;
  }
  return <History size={14} />;
}

function displayLinkedRunStatus(
  runId: string,
  linkedRun: RunSession | undefined,
  activeRunId: string,
  latestStatus: string,
): string {
  if (runId === activeRunId && latestStatus !== "idle") {
    return latestStatus;
  }
  return linkedRun?.status ?? "saved";
}

function buildRunRepairHint(
  run: RunSession | undefined,
  pendingApprovalCount: number,
  status: string,
  extraMessage = "",
): RunRepairHint | undefined {
  const effectiveStatus = status || run?.status || "";
  if (pendingApprovalCount > 0 || effectiveStatus === "waiting_for_approval" || run?.status === "waiting_for_approval") {
    return {
      target: "approvals",
      title: "Approval required",
      detail: pendingApprovalCount > 0
        ? `${pendingApprovalCount} approval${pendingApprovalCount === 1 ? "" : "s"} pending before this run can continue.`
        : "This run is waiting for an approval decision.",
      actionLabel: "Approvals",
    };
  }

  if (effectiveStatus !== "failed" && run?.status !== "failed") {
    return undefined;
  }

  const message = [run?.errorMessage, extraMessage].filter(Boolean).join(" ");
  if (isProviderRepairMessage(message)) {
    return {
      target: "providers",
      title: "Provider repair needed",
      detail: "The failure looks related to provider auth, preflight, endpoint, or model configuration.",
      actionLabel: "Providers",
    };
  }

  return {
    target: "run",
    title: "Inspect run failure",
    detail: "The failure looks like a runtime or tool issue. Inspect events, fix the workspace or task, then rerun.",
    actionLabel: "Open run",
  };
}

function isProviderRepairMessage(message: string): boolean {
  return /provider|preflight|api[-_ ]?key|apikey|auth|secret|credential|model|base[-_ ]?url|endpoint|token/i.test(message);
}

function buildRuntimeFailureSummary(
  run: RunSession,
  events: readonly RunEventEnvelope[],
  workspaceCwd: string,
): RuntimeFailureSummary {
  const failureEvent = findRuntimeFailureEvent(events);
  const relatedToolStart = findRelatedToolStart(events, failureEvent);
  const dataSources = [failureEvent?.data, relatedToolStart?.data, run.requestSnapshot].filter((item): item is unknown => item !== undefined);
  const toolName = readFirstDataString(dataSources, ["toolName", "tool", "name", "actionType"])
    || (failureEvent?.type.startsWith("tool_") ? failureEvent.type.replace("tool_", "") : "runtime");
  const issueText = (failureEvent ? readRunEventIssueText(failureEvent) : "") || run.errorMessage || "No failure message was recorded for this run.";
  const command = readFirstDataString(dataSources, ["command", "cmd", "script", "input"]);
  const cwd = readFirstDataString(dataSources, ["cwd", "workdir", "workingDirectory"]) || run.cwd || workspaceCwd;
  const targetPath = readFirstDataString(dataSources, ["path", "filePath", "targetPath", "target"]);
  const exitCode = readFirstDataScalarString(dataSources, ["exitCode", "exit_code", "statusCode"]);

  return {
    eventLabel: failureEvent ? `#${failureEvent.seq} ${failureEvent.type}` : "run status",
    toolName,
    issueText,
    command,
    cwd,
    targetPath,
    exitCode,
    suggestion: buildRuntimeRepairSuggestion(toolName, command, targetPath),
  };
}

function findRuntimeFailureEvent(events: readonly RunEventEnvelope[]): RunEventEnvelope | undefined {
  const reversed = [...events].reverse();
  return reversed.find((event) => event.type === "tool_end" && readDataBoolean(event.data, "isError"))
    ?? reversed.find((event) => event.type === "run_error")
    ?? reversed.find((event) => ["run_cancelled", "run_end"].includes(event.type));
}

function findRelatedToolStart(
  events: readonly RunEventEnvelope[],
  failureEvent: RunEventEnvelope | undefined,
): RunEventEnvelope | undefined {
  if (!failureEvent || !failureEvent.type.startsWith("tool_")) {
    return undefined;
  }

  const failureIndex = events.findIndex((event) => event.id === failureEvent.id);
  const candidates = [...(failureIndex >= 0 ? events.slice(0, failureIndex) : events)].reverse();
  const toolCallId = readDataString(failureEvent.data, "toolCallId");
  const toolName = readDataString(failureEvent.data, "toolName");

  return candidates.find((event) => {
    if (event.type !== "tool_start") {
      return false;
    }
    if (toolCallId) {
      return readDataString(event.data, "toolCallId") === toolCallId;
    }
    if (toolName) {
      return readDataString(event.data, "toolName") === toolName;
    }
    return true;
  });
}

function readFirstDataString(dataSources: readonly unknown[], keys: readonly string[]): string {
  for (const data of dataSources) {
    for (const key of keys) {
      const value = readDataString(data, key);
      if (value) {
        return value;
      }
    }
  }
  return "";
}

function readFirstDataScalarString(dataSources: readonly unknown[], keys: readonly string[]): string {
  for (const data of dataSources) {
    for (const key of keys) {
      const value = readDataField(data, key);
      if (typeof value === "string" && value) {
        return value;
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
    }
  }
  return "";
}

function buildRuntimeRepairSuggestion(toolName: string, command: string, targetPath: string): string {
  const normalizedTool = toolName.toLowerCase();
  if (normalizedTool.includes("bash") || command) {
    return "Check the command, cwd, dependency state, or task prompt. Edit the task if the instruction is wrong, then rerun.";
  }
  if (["edit", "write"].some((tool) => normalizedTool.includes(tool)) || targetPath) {
    return "Check the target path and intended file change. Edit the task or workspace files, then rerun.";
  }
  return "Inspect the failed event, fix the task or workspace state, then rerun from the same persisted snapshot.";
}

function readDeepDataScalarString(data: unknown, keys: readonly string[]): string {
  for (const source of readDataContainers(data)) {
    for (const key of keys) {
      const value = readDataField(source, key);
      if (typeof value === "string" && value) {
        return value;
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
    }
  }
  return "";
}

function readDeepDataPreview(data: unknown, keys: readonly string[]): string {
  for (const source of readDataContainers(data)) {
    for (const key of keys) {
      const value = readDataField(source, key);
      const preview = formatUnknownPreview(value, 220);
      if (preview) {
        return preview;
      }
    }
  }
  return "";
}

function readDataContainers(data: unknown): readonly unknown[] {
  return [
    data,
    readDataField(data, "args"),
    readDataField(data, "input"),
    readDataField(data, "payload"),
    readDataField(data, "result"),
    readDataField(data, "partialResult"),
  ].filter((value) => value !== undefined && value !== null);
}

function readRunEventIssueText(event: RunEventEnvelope | undefined): string {
  if (!event) {
    return "";
  }
  return readDataString(event.data, "message")
    || readDataString(event.data, "error")
    || readDataString(event.data, "detail")
    || readDataString(event.data, "reason");
}

function readRunEvidenceMessage(run: RunSession, terminalEvent: RunEventEnvelope | undefined): string {
  const runError = run.errorMessage?.trim();
  if (runError) {
    return runError;
  }

  const terminalIssue = readRunEventIssueText(terminalEvent).trim();
  if (terminalIssue) {
    return terminalIssue;
  }

  const terminalPreview = terminalEvent ? formatEventPreview(terminalEvent.data) : "";
  if (terminalPreview) {
    return terminalPreview;
  }

  if (run.status === "succeeded") {
    return "Run completed without a result payload.";
  }
  if (run.status === "failed") {
    return "Run failed without a captured error message.";
  }
  if (run.status === "cancelled") {
    return "Run was cancelled.";
  }
  if (run.status === "waiting_for_approval") {
    return "Run is waiting for approval.";
  }
  if (run.status === "running") {
    return "Run is still running.";
  }
  return "Run is queued.";
}

function buildAssistantOutputPreview(assistantText: string): string {
  return formatUnknownPreview(assistantText, 260) || "No assistant output captured.";
}

function summarizeToolEvents(toolEvents: readonly RunEventEnvelope[]): { readonly total: number; readonly errorCount: number } {
  let errorCount = 0;
  for (const event of toolEvents) {
    if (readDataBoolean(event.data, "isError") || Boolean(readDataString(event.data, "error"))) {
      errorCount += 1;
    }
  }
  return {
    total: toolEvents.length,
    errorCount,
  };
}

function formatArtifactSize(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) {
    return "-";
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function highestApprovalRisk(approvals: readonly ApprovalRequest[]): ApprovalRisk {
  const order: readonly ApprovalRisk[] = ["low", "medium", "high", "critical"];
  return approvals.reduce<ApprovalRisk>((highest, approval) => {
    return order.indexOf(approval.risk) > order.indexOf(highest) ? approval.risk : highest;
  }, "low");
}

function inferRunStatus(events: readonly RunEventEnvelope[], isRunning: boolean): string {
  const terminal = [...events].reverse().find((event) => ["result", "run_error", "run_cancelled"].includes(event.type));
  if (terminal?.type === "run_error") {
    return "failed";
  }
  if (terminal?.type === "run_cancelled") {
    return "cancelled";
  }
  if (terminal?.type === "result") {
    return "succeeded";
  }
  return isRunning ? "running" : "idle";
}

function readDataString(data: unknown, key: string): string {
  if (typeof data === "object" && data !== null && key in data) {
    const value = (data as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  }
  return "";
}

function readDataBoolean(data: unknown, key: string): boolean {
  if (typeof data === "object" && data !== null && key in data) {
    return (data as Record<string, unknown>)[key] === true;
  }
  return false;
}

function readRunProviderPresetId(run: RunSession): string {
  return run.providerPresetId ?? readDataString(run.requestSnapshot, "providerPresetId");
}

function readRunWorkspaceCwd(run: RunSession, fallbackCwd: string): string {
  return readDataString(run.requestSnapshot, "workspaceCwd") || fallbackCwd || run.cwd;
}

function buildRunApprovalSummaries(
  events: readonly RunEventEnvelope[],
  approvals: readonly ApprovalRequest[],
  runId: string,
): readonly ApprovalRequest[] {
  const summaries = new Map<string, ApprovalRequest>();
  for (const approval of approvals) {
    if (approval.runId === runId) {
      summaries.set(approval.id, approval);
    }
  }

  for (const event of events) {
    if (event.type === "approval_requested") {
      const approvalId = readDataString(event.data, "approvalId");
      if (!approvalId || summaries.has(approvalId)) {
        continue;
      }
      summaries.set(approvalId, {
        id: approvalId,
        runId: event.runId,
        taskId: readDataString(event.data, "taskId") || event.runId,
        toolCallId: readDataString(event.data, "toolCallId") || undefined,
        actionType: readApprovalActionType(event.data),
        risk: readApprovalRisk(event.data),
        title: readDataString(event.data, "title") || "Approval requested",
        description: readDataString(event.data, "description") || "The run requested approval.",
        payload: readDataField(event.data, "payload"),
        status: "pending",
        createdAt: event.ts,
        expiresAt: readDataString(event.data, "expiresAt") || undefined,
      });
      continue;
    }

    if (event.type === "approval_approved" || event.type === "approval_denied") {
      const approvalId = readDataString(event.data, "approvalId");
      if (!approvalId) {
        continue;
      }
      const existing = summaries.get(approvalId);
      const status = readApprovalStatus(event.data, event.type === "approval_approved" ? "approved" : "denied");
      summaries.set(approvalId, {
        id: approvalId,
        runId: event.runId,
        taskId: existing?.taskId ?? event.runId,
        toolCallId: existing?.toolCallId,
        actionType: existing?.actionType ?? "bash",
        risk: existing?.risk ?? "medium",
        title: existing?.title ?? (status === "approved" ? "Approval approved" : "Approval denied"),
        description: existing?.description ?? "Approval decision recorded.",
        payload: existing?.payload ?? {},
        status,
        createdAt: existing?.createdAt ?? event.ts,
        expiresAt: existing?.expiresAt,
        resolvedAt: event.ts,
        resolvedBy: "local-user",
        decisionReason: readDataString(event.data, "decisionReason") || existing?.decisionReason,
      });
    }
  }

  return [...summaries.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function mergeApprovalsForRun(
  current: readonly ApprovalRequest[],
  nextRunApprovals: readonly ApprovalRequest[],
  runId: string,
): readonly ApprovalRequest[] {
  const otherApprovals = current.filter((approval) => approval.runId !== runId);
  return [...nextRunApprovals, ...otherApprovals];
}

function upsertApproval(current: readonly ApprovalRequest[], next: ApprovalRequest): readonly ApprovalRequest[] {
  const existingIndex = current.findIndex((approval) => approval.id === next.id);
  if (existingIndex === -1) {
    return [next, ...current];
  }
  return current.map((approval, index) => (index === existingIndex ? next : approval));
}

function removeRecordKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [currentKey, value] of Object.entries(record)) {
    if (currentKey !== key) {
      next[currentKey] = value;
    }
  }
  return next;
}

function readDataField(data: unknown, key: string): unknown {
  if (typeof data === "object" && data !== null && key in data) {
    return (data as Record<string, unknown>)[key];
  }
  return undefined;
}

function formatEventPreview(data: unknown): string {
  const preview = readDeepDataPreview(data, ["message", "error", "detail", "reason", "command", "text", "result", "partialResult"]);
  if (preview) {
    return preview;
  }
  return formatUnknownPreview(data, 160);
}

function formatUnknownPreview(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return truncatePreview(value, maxLength);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return truncatePreview(JSON.stringify(value), maxLength);
  } catch {
    return truncatePreview(String(value), maxLength);
  }
}

function truncatePreview(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function formatEventData(data: unknown): string {
  if (typeof data === "object" && data !== null && "text" in data) {
    const value = (data as { text?: unknown }).text;
    if (typeof value === "string") {
      return value.length > 240 ? `${value.slice(0, 240)}...` : value;
    }
  }
  return JSON.stringify(data, null, 2);
}

function readApprovalActionType(data: unknown): ApprovalActionType {
  const value = readDataString(data, "actionType");
  if (["write", "edit", "bash", "git_commit", "git_push", "external_send", "deploy", "media_cost", "credential_change", "provider_change"].includes(value)) {
    return value as ApprovalActionType;
  }
  return "bash";
}

function readApprovalRisk(data: unknown): ApprovalRisk {
  const value = readDataString(data, "risk");
  if (["low", "medium", "high", "critical"].includes(value)) {
    return value as ApprovalRisk;
  }
  return "medium";
}

function readApprovalStatus(data: unknown, fallback: ApprovalStatus): ApprovalStatus {
  const value = readDataString(data, "status");
  if (["pending", "approved", "denied", "expired", "cancelled"].includes(value)) {
    return value as ApprovalStatus;
  }
  return fallback;
}

function readTaskTitle(taskSnapshot: unknown): string {
  if (typeof taskSnapshot === "object" && taskSnapshot !== null && "title" in taskSnapshot) {
    const value = (taskSnapshot as { title?: unknown }).title;
    return typeof value === "string" ? value : "";
  }
  return "";
}

function readTaskPrompt(taskSnapshot: unknown): string {
  if (typeof taskSnapshot === "object" && taskSnapshot !== null && "prompt" in taskSnapshot) {
    const value = (taskSnapshot as { prompt?: unknown }).prompt;
    return typeof value === "string" ? value : "";
  }
  return "";
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/)[0] ?? "";
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}...` : firstLine || "Untitled task";
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function channelToForm(channel: Channel, fallbackCwd: string): ChannelFormState {
  return {
    name: channel.name,
    boundPath: channel.boundPath ?? fallbackCwd,
    defaultProviderPresetId: channel.defaultProviderPresetId ?? "",
    allowedTools: channel.allowedTools.length > 0 ? channel.allowedTools : defaultTools,
  };
}

function providerToForm(provider: ProviderPreset): ProviderFormState {
  return {
    kind: provider.kind,
    displayName: provider.displayName,
    providerId: provider.providerId,
    model: provider.model,
    api: provider.api,
    baseUrl: provider.baseUrl ?? "",
    apiKeyRef: provider.apiKeyRef ?? "",
    capabilitiesText: provider.capabilities.join(", "),
    inputText: provider.input.join(", "),
    enabled: provider.enabled,
    authHeader: provider.authHeader ?? true,
    reasoning: provider.reasoning ?? false,
    contextWindow: provider.contextWindow ? String(provider.contextWindow) : "",
    maxTokens: provider.maxTokens ? String(provider.maxTokens) : "",
  };
}

function providerTemplateToForm(template: ProviderTemplate): ProviderFormState {
  return {
    kind: template.kind,
    displayName: template.displayName,
    providerId: template.providerId,
    model: template.model,
    api: template.api,
    baseUrl: template.baseUrl ?? "",
    apiKeyRef: template.apiKeyRef ?? "",
    capabilitiesText: template.capabilities.join(", "),
    inputText: (template.input ?? ["text"]).join(", "),
    enabled: template.enabled ?? false,
    authHeader: template.authHeader ?? true,
    reasoning: template.reasoning ?? false,
    contextWindow: template.contextWindow ? String(template.contextWindow) : "",
    maxTokens: template.maxTokens ? String(template.maxTokens) : "",
  };
}

function approvalPolicyToForm(policy: ApprovalPolicy): ApprovalPolicyFormState {
  return {
    toolDecisions: {
      read: policy.toolDecisions.read ?? "allow",
      grep: policy.toolDecisions.grep ?? "allow",
      find: policy.toolDecisions.find ?? "allow",
      ls: policy.toolDecisions.ls ?? "allow",
      bash: policy.toolDecisions.bash ?? "ask",
      edit: policy.toolDecisions.edit ?? "ask",
      write: policy.toolDecisions.write ?? "ask",
    },
    allowedWritePathsText: policy.allowedWritePaths.join("\n"),
  };
}

function canUseProviderForRun(provider: ProviderPreset): boolean {
  return provider.enabled && provider.api !== "media-job" && provider.capabilities.includes("chat") && providerSecretReady(provider);
}

function canBatchCheckProvider(provider: ProviderPreset): boolean {
  return provider.enabled && provider.api !== "media-job" && provider.capabilities.includes("chat");
}

function providerSecretReady(provider: ProviderPreset): boolean {
  return !providerNeedsSecret(provider) || provider.apiKeyConfigured;
}

function providerNeedsSecret(provider: Pick<ProviderPreset, "api" | "authHeader" | "apiKeyRef">): boolean {
  return provider.api === "anthropic-messages" || provider.authHeader !== false || Boolean(provider.apiKeyRef);
}

function providerRunBlockerLabel(provider: ProviderPreset): string {
  if (!provider.enabled) {
    return "disabled";
  }
  if (provider.api === "media-job") {
    return "media only";
  }
  if (!provider.capabilities.includes("chat")) {
    return "no chat";
  }
  if (!providerSecretReady(provider)) {
    return provider.apiKeyRef ? `missing ${envNameFromRef(provider.apiKeyRef)}` : "missing env key";
  }
  return "not runnable";
}

function providerRunPreflightBlocker(provider: ProviderPreset | undefined): string | undefined {
  if (!provider) {
    return "找不到 provider preset";
  }
  if (!canUseProviderForRun(provider)) {
    return `${provider.displayName}: ${providerRunBlockerLabel(provider)}.`;
  }
  if (!provider.lastCheck) {
    return `${provider.displayName}: provider has not been checked. Use Check run before starting.`;
  }
  if (!provider.lastCheck.ok) {
    return `${provider.displayName}: provider check failed (${providerCheckStatusLabel(provider.lastCheck)}). ${providerCheckGuidance(provider.lastCheck, provider)}`;
  }
  return undefined;
}

function providerPreflightReady(provider: ProviderPreset): boolean {
  return providerRunPreflightBlocker(provider) === undefined;
}

function taskProviderReadinessMessage(provider: ProviderPreset | undefined, blocker: string | undefined): string {
  if (!provider) {
    return "No provider preset is selected for this task run.";
  }
  if (!blocker) {
    return `${provider.displayName} passed the last provider check and can run this task.`;
  }
  return blocker;
}

function taskProviderReadinessGuidance(provider: ProviderPreset | undefined): string {
  if (!provider) {
    return "Select a provider preset or set one as the channel default.";
  }
  if (!canUseProviderForRun(provider)) {
    return providerNeedsSecret(provider) && !provider.apiKeyConfigured
      ? `Set ${provider.apiKeyRef ? envNameFromRef(provider.apiKeyRef) : "the API key env"}, restart daemon, then run Check.`
      : "Open Providers to enable a chat-capable preset before running.";
  }
  if (!provider.lastCheck) {
    return "Use Check run to validate env, base URL, and model access before starting.";
  }
  if (!provider.lastCheck.ok) {
    return providerCheckGuidance(provider.lastCheck, provider);
  }
  return "Run is available until provider settings or env change.";
}

function providerLastCheckLabel(provider: ProviderPreset): string {
  if (!provider.lastCheck) {
    return "unchecked";
  }
  return provider.lastCheck.ok ? "check ready" : providerCheckStatusLabel(provider.lastCheck);
}

function providerLastCheckClass(provider: ProviderPreset): string {
  if (!provider.lastCheck) {
    return "provider-state check-unknown";
  }
  return provider.lastCheck.ok ? "provider-state check-ok" : "provider-state check-bad";
}

function providerLastCheckTitle(provider: ProviderPreset): string {
  if (!provider.lastCheck) {
    return "Provider has not been checked yet.";
  }
  return `${provider.lastCheck.message} (${provider.lastCheck.checkedAt})`;
}

function envNameFromRef(ref: string): string {
  return ref.startsWith("env:") ? ref.slice("env:".length) : ref;
}

function providerTemplateKindLabel(template: ProviderTemplate): string {
  if (template.api === "media-job") {
    return "media";
  }
  if (template.kind === "openai" || template.kind === "anthropic") {
    return "global";
  }
  if (template.kind === "openai-compatible") {
    return "relay";
  }
  return "domestic";
}

function groupProviderTemplates(templates: readonly ProviderTemplate[]): readonly ProviderTemplateGroup[] {
  const groups: ProviderTemplateGroup[] = [
    { label: "GPT / Claude", templates: templates.filter((template) => providerTemplateKindLabel(template) === "global") },
    { label: "Relays", templates: templates.filter((template) => providerTemplateKindLabel(template) === "relay") },
    { label: "Domestic AI", templates: templates.filter((template) => providerTemplateKindLabel(template) === "domestic") },
    { label: "Media", templates: templates.filter((template) => providerTemplateKindLabel(template) === "media") },
  ];
  return groups.filter((group) => group.templates.length > 0);
}

function providerCheckStatusLabel(result: ProviderCheckResult): string {
  if (result.ok) {
    return "ready";
  }
  if (result.code === "secret_missing") {
    return "missing env";
  }
  if (result.code === "network_failed") {
    return "network failed";
  }
  if (result.code === "auth_failed") {
    return "auth failed";
  }
  if (result.code === "model_unsupported") {
    return "model unsupported";
  }
  if (result.code === "provider_disabled") {
    return "disabled";
  }
  return result.code ?? "failed";
}

function providerCheckGuidance(result: ProviderCheckResult, provider: ProviderPreset | undefined): string {
  if (result.ok) {
    return "Ready for run. You can select this preset from Workspace or a channel.";
  }

  const secretRef = provider?.apiKeyRef ?? extractEnvRef(result.message);
  const envName = secretRef ? envNameFromRef(secretRef) : "the provider API key env";

  if (result.code === "secret_missing") {
    return `Set ${envName}, restart or reload the daemon process, then run Check again.`;
  }
  if (result.code === "auth_failed") {
    return "Verify the key, account access, balance, and model permission for this provider.";
  }
  if (result.code === "network_failed") {
    return "Check proxy, base URL, local relay status, and outbound network access from the daemon.";
  }
  if (result.code === "model_unsupported") {
    return "Check the model name, API protocol, and base URL path for this provider.";
  }
  if (result.code === "provider_disabled") {
    return "Enable the preset before using it for runs.";
  }
  if (result.code === "unsupported_capability") {
    return "This preset needs chat capability before it can run coding tasks.";
  }
  if (result.code === "rate_limited") {
    return "The endpoint is reachable. Wait or switch credentials, then run Check again.";
  }
  return "Inspect the provider response, then verify base URL, API protocol, and model configuration.";
}

function extractEnvRef(text: string): string | undefined {
  return text.match(/env:[A-Za-z_][A-Za-z0-9_]*/)?.[0];
}

function viewTitle(view: ViewId): string {
  if (view === "workspace") {
    return "Run workspace";
  }
  if (view === "runs") {
    return "Run history";
  }
  if (view === "approvals") {
    return "Approvals";
  }
  if (view === "settings") {
    return "Settings";
  }
  return "Provider presets";
}

function viewDescription(view: ViewId): string {
  if (view === "workspace") {
    return "发起本地任务，观察 pi-coding-agent 事件流，并读取持久化 run 历史。";
  }
  if (view === "runs") {
    return "查看当前 workspace 的持久化 run，点击任意记录读取事件和上下文。";
  }
  if (view === "approvals") {
    return "查看和处理需要人工决策的高风险动作；bash、edit、write 会在执行前等待审批。";
  }
  if (view === "settings") {
    return "配置 workspace 级 approval policy，控制工具自动允许、询问或拒绝，以及写入路径边界。";
  }
  return "管理本地 provider preset，用 env:NAME 引用密钥，并在 run 启动时选择预设。";
}
