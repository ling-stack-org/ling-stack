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
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy | undefined>();
  const [approvalPolicyForm, setApprovalPolicyForm] = useState<ApprovalPolicyFormState>(defaultApprovalPolicyForm);
  const [approvalPolicyLoading, setApprovalPolicyLoading] = useState(false);
  const [approvals, setApprovals] = useState<readonly ApprovalRequest[]>([]);
  const [approvalsLoading, setApprovalsLoading] = useState(false);
  const [events, setEvents] = useState<readonly RunEventEnvelope[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const abortRef = useRef<AbortController | undefined>(undefined);

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

  useEffect(() => {
    void refreshHealth();
    void refreshProviderTemplates();
    void refreshProviders();
  }, []);

  useEffect(() => {
    if (activeView === "workspace") {
      void refreshChannels();
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
            void refreshApprovals();
          }
          setEvents((current) => [...current, message.event]);
        },
        controller.signal,
      );

      if (streamedRunId) {
        await loadRun(streamedRunId, loadCwd);
        await refreshRuns(loadCwd);
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
      const [runResult, eventResult] = await Promise.all([getRun(runId.trim(), cwd), getRunEvents(runId.trim(), cwd)]);
      setRun(runResult);
      setEvents(eventResult.events);
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

  async function saveTaskEdit(taskId: string): Promise<void> {
    if (!taskEditForm.title.trim()) {
      setErrorMessage("请输入 task title");
      return;
    }
    if (!taskEditForm.prompt.trim()) {
      setErrorMessage("请输入 task prompt");
      return;
    }

    try {
      setErrorMessage("");
      await updateTask(form.cwd.trim(), taskId, {
        ...taskEditForm,
        title: taskEditForm.title.trim(),
        prompt: taskEditForm.prompt.trim(),
      });
      await refreshTasks();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function runPersistedTask(task: Task): Promise<void> {
    const channel = channels.find((item) => item.id === task.channelId);
    if (!channel) {
      setErrorMessage("找不到 task 所属 channel");
      return;
    }
    const providerPresetId = taskRunProviderId || channel.defaultProviderPresetId || form.providerPresetId;
    if (!providerPresetId) {
      setErrorMessage("请先选择 provider preset");
      return;
    }

    const runCwd = form.cwd.trim();
    await runWithRequest(buildTaskRunRequest(runCwd, task, channel, providerPresetId), runCwd, async () => {
      await refreshTasks(task.channelId);
    });
  }

  async function rerunRun(sourceRun: RunSession): Promise<void> {
    try {
      const workspaceCwd = readRunWorkspaceCwd(sourceRun, form.cwd.trim());
      await runWithRequest(buildRerunRequest(sourceRun), workspaceCwd);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshApprovals(cwd = form.cwd.trim()): Promise<void> {
    if (!cwd.trim()) {
      setErrorMessage("请输入 workspace path");
      return;
    }

    setApprovalsLoading(true);
    try {
      setErrorMessage("");
      const response = await listApprovals(cwd.trim());
      setApprovals(response.approvals);
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

  async function resolveApproval(approvalId: string, decision: "approve" | "deny"): Promise<void> {
    try {
      setErrorMessage("");
      if (decision === "approve") {
        await approveApproval(form.cwd.trim(), approvalId);
      } else {
        await denyApproval(form.cwd.trim(), approvalId);
      }
      await refreshApprovals();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
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
      setProviderCheck(await checkProvider(form.cwd.trim(), providerId));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function editProvider(provider: ProviderPreset): void {
    setEditingProviderId(provider.id);
    setProviderCheck(undefined);
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
    void refreshApprovals();
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
          <NavItem icon={<ShieldCheck />} label="Approvals" active={activeView === "approvals"} onClick={() => setActiveView("approvals")} />
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
              onReviewTask={(taskId) => void moveTaskToReview(taskId)}
              onDeleteTask={(taskId) => void removeTask(taskId)}
            />
            <RunTimeline
              events={events}
              assistantText={assistantText}
              errorMessage={errorMessage}
              isRunning={isRunning}
              pendingApprovals={activePendingApprovals}
              approvalsLoading={approvalsLoading}
              onRefreshApprovals={() => void refreshApprovals()}
              onResolveApproval={(approvalId, decision) => void resolveApproval(approvalId, decision)}
            />
          </div>
        ) : activeView === "runs" ? (
          <RunHistory
            cwd={form.cwd}
            runs={runs}
            selectedRunId={activeRunId}
            selectedRun={run}
            events={events}
            assistantText={assistantText}
            approvals={activeRunApprovals}
            approvalsLoading={approvalsLoading}
            isLoading={runsLoading}
            isRunning={isRunning}
            errorMessage={errorMessage}
            onCwdChange={(cwd) => {
              setForm({ ...form, cwd });
              setRun(undefined);
              setEvents([]);
              setActiveRunId("");
              setLookupRunId("");
            }}
            onRefresh={() => void refreshRuns()}
            onRefreshSelected={() => void loadRun(activeRunId || lookupRunId)}
            onRefreshApprovals={() => void refreshApprovals()}
            onRerun={(sourceRun) => void rerunRun(sourceRun)}
            onResolveApproval={(approvalId, decision) => void resolveApproval(approvalId, decision)}
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
            errorMessage={errorMessage}
            checkResult={providerCheck}
            selectedProviderId={form.providerPresetId}
            onCwdChange={(cwd) => setForm({ ...form, cwd })}
            onFormChange={setProviderForm}
            onTemplateSelect={(template) => {
              setEditingProviderId("");
              setProviderCheck(undefined);
              setProviderForm(providerTemplateToForm(template));
            }}
            onNew={() => {
              setEditingProviderId("");
              setProviderCheck(undefined);
              setProviderForm(defaultProviderForm);
            }}
            onSave={() => void saveProvider()}
            onRefresh={() => void refreshProviders()}
            onEdit={editProvider}
            onDelete={(providerId) => void removeProvider(providerId)}
            onCheck={(providerId) => void runProviderCheck(providerId)}
            onUse={applyProviderToRun}
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
                isLoading={approvalsLoading}
                errorMessage={errorMessage}
                onCwdChange={(cwd) => setForm({ ...form, cwd })}
                onRefresh={() => void refreshApprovals()}
                onResolve={(approvalId, decision) => void resolveApproval(approvalId, decision)}
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
  onReviewTask,
  onDeleteTask,
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
  readonly onReviewTask: (taskId: string) => void;
  readonly onDeleteTask: (taskId: string) => void;
}): JSX.Element {
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const effectiveProviderId = (taskRunProviderId || selectedChannel?.defaultProviderPresetId || fallbackProviderId) ?? "";

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
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id} disabled={!canUseProviderForRun(provider)}>
                    {provider.displayName} / {provider.model}
                  </option>
                ))}
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
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id} disabled={!canUseProviderForRun(provider)}>
                  {provider.displayName} / {provider.model}
                </option>
              ))}
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
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id} disabled={!canUseProviderForRun(provider)}>
                {provider.displayName} / {provider.model}
              </option>
            ))}
          </select>
        </label>

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
            <div className="task-actions">
              <button className="primary-button" type="button" onClick={() => onSaveTaskEdit(selectedTask.id)}>
                <Save size={16} />
                Save task
              </button>
              <button className="secondary-button compact-button" type="button" onClick={() => onRunTask(selectedTask)} disabled={isRunning || !effectiveProviderId}>
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
            tasks.map((task) => (
              <article key={task.id} className={task.id === selectedTaskId ? "task-row selected" : "task-row"}>
                <div className="task-row-head">
                  <strong>{task.title}</strong>
                  <span className={`task-status ${task.status}`}>{task.status}</span>
                </div>
                <p>{task.prompt}</p>
                <div className="provider-meta-line mono">
                  <span>{task.id}</span>
                  {task.currentRunId ? <span>{task.currentRunId}</span> : null}
                  <time>{formatDateTime(task.updatedAt)}</time>
                </div>
                <div className="task-actions">
                  <button className="secondary-button compact-button" type="button" onClick={() => onSelectTask(task.id)}>
                    <Pencil size={14} />
                    Edit
                  </button>
                  <button className="secondary-button compact-button" type="button" onClick={() => onRunTask(task)} disabled={isRunning || !effectiveProviderId}>
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
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function RunHistory({
  cwd,
  runs,
  selectedRunId,
  selectedRun,
  events,
  assistantText,
  approvals,
  approvalsLoading,
  isLoading,
  isRunning,
  errorMessage,
  onCwdChange,
  onRefresh,
  onRefreshSelected,
  onRefreshApprovals,
  onRerun,
  onResolveApproval,
  onSelect,
}: {
  readonly cwd: string;
  readonly runs: readonly RunSession[];
  readonly selectedRunId: string;
  readonly selectedRun: RunSession | undefined;
  readonly events: readonly RunEventEnvelope[];
  readonly assistantText: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly isLoading: boolean;
  readonly isRunning: boolean;
  readonly errorMessage: string;
  readonly onCwdChange: (cwd: string) => void;
  readonly onRefresh: () => void;
  readonly onRefreshSelected: () => void;
  readonly onRefreshApprovals: () => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onResolveApproval: (approvalId: string, decision: "approve" | "deny") => void;
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
        assistantText={assistantText}
        approvals={approvals}
        approvalsLoading={approvalsLoading}
        isRunning={isRunning}
        onRefresh={onRefreshSelected}
        onRefreshApprovals={onRefreshApprovals}
        onRerun={onRerun}
        onResolveApproval={onResolveApproval}
      />
    </div>
  );
}

function RunDetailPanel({
  run,
  events,
  assistantText,
  approvals,
  approvalsLoading,
  isRunning,
  onRefresh,
  onRefreshApprovals,
  onRerun,
  onResolveApproval,
}: {
  readonly run: RunSession | undefined;
  readonly events: readonly RunEventEnvelope[];
  readonly assistantText: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly isRunning: boolean;
  readonly onRefresh: () => void;
  readonly onRefreshApprovals: () => void;
  readonly onRerun: (run: RunSession) => void;
  readonly onResolveApproval: (approvalId: string, decision: "approve" | "deny") => void;
}): JSX.Element {
  const toolEvents = events.filter((event) => event.type.startsWith("tool_"));
  const terminalEvent = [...events].reverse().find((event) => ["result", "run_error", "run_cancelled", "run_end"].includes(event.type));
  const workspaceCwd = run ? readDataString(run.requestSnapshot, "workspaceCwd") || run.cwd : "-";
  const providerPresetId = run ? readRunProviderPresetId(run) : "";
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");

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
            Rerun
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

          {run.errorMessage ? (
            <div className="inline-error">
              <CircleAlert size={17} />
              {run.errorMessage}
            </div>
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
                  <ApprovalCard key={approval.id} approval={approval} compact onResolve={onResolveApproval} />
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
                  <article className="tool-event-row" key={event.id}>
                    <span>#{event.seq}</span>
                    <strong>{readDataString(event.data, "toolName") || event.type.replace("tool_", "")}</strong>
                    <code>{event.type}</code>
                    <small>{readDataBoolean(event.data, "isError") ? "error" : formatDateTime(event.ts)}</small>
                  </article>
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

          <div className="run-detail-section">
            <div className="panel-title tight">
              <Database size={16} />
              <h3>Snapshots</h3>
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

function ProviderSettings({
  cwd,
  providers,
  templates,
  form,
  editingProviderId,
  isLoading,
  errorMessage,
  checkResult,
  selectedProviderId,
  onCwdChange,
  onFormChange,
  onTemplateSelect,
  onNew,
  onSave,
  onRefresh,
  onEdit,
  onDelete,
  onCheck,
  onUse,
}: {
  readonly cwd: string;
  readonly providers: readonly ProviderPreset[];
  readonly templates: readonly ProviderTemplate[];
  readonly form: ProviderFormState;
  readonly editingProviderId: string;
  readonly isLoading: boolean;
  readonly errorMessage: string;
  readonly checkResult: ProviderCheckResult | undefined;
  readonly selectedProviderId: string;
  readonly onCwdChange: (cwd: string) => void;
  readonly onFormChange: (form: ProviderFormState) => void;
  readonly onTemplateSelect: (template: ProviderTemplate) => void;
  readonly onNew: () => void;
  readonly onSave: () => void;
  readonly onRefresh: () => void;
  readonly onEdit: (provider: ProviderPreset) => void;
  readonly onDelete: (providerId: string) => void;
  readonly onCheck: (providerId: string) => void;
  readonly onUse: (provider: ProviderPreset) => void;
}): JSX.Element {
  return (
    <div className="provider-layout">
      <section className="panel provider-list-panel" aria-labelledby="provider-list-title">
        <div className="panel-title split">
          <span>
            <PlugZap size={18} />
            <h2 id="provider-list-title">Provider presets</h2>
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

        <div className="provider-list">
          {providers.length === 0 ? (
            <div className="empty-state compact-empty">
              {isLoading ? <Loader2 className="spin" /> : <PlugZap />}
              <span>{isLoading ? "Loading providers..." : "No provider presets yet"}</span>
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
                  </div>
                  <div className="provider-meta-line">
                    <span>{provider.kind}</span>
                    <span>{provider.providerId}</span>
                    <span>{provider.model}</span>
                    <span>{provider.api}</span>
                  </div>
                  <div className="provider-meta-line mono">
                    <span>{provider.baseUrl ?? "default endpoint"}</span>
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
                    disabled={!canUseProviderForRun(provider)}
                    onClick={() => onUse(provider)}
                  >
                    <Play size={14} />
                    Use
                  </button>
                  <button className="secondary-button compact-button" type="button" onClick={() => onEdit(provider)}>
                    <Pencil size={14} />
                    Edit
                  </button>
                  <button className="secondary-button compact-button" type="button" onClick={() => onCheck(provider.id)}>
                    <CheckCircle2 size={14} />
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

        <label className="field wide provider-template-select">
          <span>Template</span>
          <select
            value=""
            onChange={(event) => {
              const template = templates.find((item) => item.templateId === event.target.value);
              if (template) {
                onTemplateSelect(template);
              }
            }}
          >
            <option value="">Start from template</option>
            {templates.map((template) => (
              <option key={template.templateId} value={template.templateId}>
                {template.displayName} / {template.model}
              </option>
            ))}
          </select>
          {templates.length === 0 ? <small>No templates available.</small> : null}
        </label>

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
            <span className="check-result-status">{providerCheckStatusLabel(checkResult)}</span>
            <span>{checkResult.message}</span>
          </div>
        ) : null}

        <div className="action-row">
          <button className="primary-button" type="button" onClick={onSave}>
            <Save size={16} />
            {editingProviderId ? "Save changes" : "Create preset"}
          </button>
        </div>
      </section>
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
  isLoading,
  errorMessage,
  onCwdChange,
  onRefresh,
  onResolve,
}: {
  readonly cwd: string;
  readonly approvals: readonly ApprovalRequest[];
  readonly isLoading: boolean;
  readonly errorMessage: string;
  readonly onCwdChange: (cwd: string) => void;
  readonly onRefresh: () => void;
  readonly onResolve: (approvalId: string, decision: "approve" | "deny") => void;
}): JSX.Element {
  return (
    <section className="panel approvals-panel" aria-labelledby="approvals-title">
      <div className="panel-title split">
        <span>
          <ShieldCheck size={18} />
          <h2 id="approvals-title">Approval requests</h2>
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

      <div className="approval-list">
        {approvals.length === 0 ? (
          <div className="empty-state compact-empty">
            {isLoading ? <Loader2 className="spin" /> : <ShieldCheck />}
            <span>{isLoading ? "Loading approvals..." : "No approval requests for this workspace"}</span>
          </div>
        ) : (
          approvals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onResolve={onResolve} />)
        )}
      </div>
    </section>
  );
}

function ApprovalCard({
  approval,
  compact = false,
  onResolve,
}: {
  readonly approval: ApprovalRequest;
  readonly compact?: boolean;
  readonly onResolve: (approvalId: string, decision: "approve" | "deny") => void;
}): JSX.Element {
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
        <div className="approval-actions">
          <button className="secondary-button compact-button" type="button" onClick={() => onResolve(approval.id, "approve")}>
            <CheckCircle2 size={14} />
            Approve
          </button>
          <button className="secondary-button compact-button danger" type="button" onClick={() => onResolve(approval.id, "deny")}>
            <CircleAlert size={14} />
            Deny
          </button>
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
  onRefreshApprovals,
  onResolveApproval,
}: {
  readonly events: readonly RunEventEnvelope[];
  readonly assistantText: string;
  readonly errorMessage: string;
  readonly isRunning: boolean;
  readonly pendingApprovals: readonly ApprovalRequest[];
  readonly approvalsLoading: boolean;
  readonly onRefreshApprovals: () => void;
  readonly onResolveApproval: (approvalId: string, decision: "approve" | "deny") => void;
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
              <ApprovalCard key={approval.id} approval={approval} compact onResolve={onResolveApproval} />
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
  return (
    <article className={`event-row ${event.type}`}>
      <div className="event-seq">#{event.seq}</div>
      <div className="event-body">
        <div className="event-head">
          <span>{event.type}</span>
          <time>{new Date(event.ts).toLocaleTimeString()}</time>
        </div>
        <pre>{formatEventData(event.data)}</pre>
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

function readDataField(data: unknown, key: string): unknown {
  if (typeof data === "object" && data !== null && key in data) {
    return (data as Record<string, unknown>)[key];
  }
  return undefined;
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
  return provider.enabled && provider.api !== "media-job" && provider.capabilities.includes("chat");
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
