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
  buildRunRequest,
  checkProvider,
  createProvider,
  daemonBaseUrl,
  denyApproval,
  deleteProvider,
  getDaemonHealth,
  getRun,
  getRunEvents,
  listApprovals,
  listProviders,
  listRuns,
  updateProvider,
} from "./api.js";
import { streamRun } from "./sse.js";
import type {
  ApprovalRequest,
  ProviderCheckResult,
  ProviderFormState,
  ProviderPreset,
  RunEventEnvelope,
  RunFormState,
  RunSession,
  ToolName,
} from "./types.js";

const defaultTools: readonly ToolName[] = ["read", "grep", "find", "ls"];
const allTools: readonly ToolName[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];
const riskyTools: readonly ToolName[] = ["bash", "edit", "write"];
type ViewId = "workspace" | "runs" | "providers" | "approvals";

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
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerForm, setProviderForm] = useState<ProviderFormState>(defaultProviderForm);
  const [editingProviderId, setEditingProviderId] = useState("");
  const [providerCheck, setProviderCheck] = useState<ProviderCheckResult | undefined>();
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

  useEffect(() => {
    void refreshHealth();
    void refreshProviders();
  }, []);

  useEffect(() => {
    if (activeView === "runs") {
      void refreshRuns();
    }
    if (activeView === "providers") {
      void refreshProviders();
    }
    if (activeView === "approvals") {
      void refreshApprovals();
    }
  }, [activeView]);

  async function refreshHealth(): Promise<void> {
    try {
      setDaemonHealthy(await getDaemonHealth());
    } catch {
      setDaemonHealthy(false);
    }
  }

  async function startRun(): Promise<void> {
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
        buildRunRequest(form),
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
        await loadRun(streamedRunId);
        await refreshRuns();
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

  async function loadRun(runId = lookupRunId): Promise<void> {
    if (!runId.trim()) {
      setErrorMessage("请输入 runId");
      return;
    }

    try {
      setErrorMessage("");
      const [runResult, eventResult] = await Promise.all([getRun(runId.trim(), form.cwd), getRunEvents(runId.trim(), form.cwd)]);
      setRun(runResult);
      setEvents(eventResult.events);
      setActiveRunId(runResult.id);
      setLookupRunId(runResult.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshRuns(): Promise<void> {
    if (!form.cwd.trim()) {
      setErrorMessage("请输入 workspace path");
      return;
    }

    setRunsLoading(true);
    try {
      setErrorMessage("");
      const response = await listRuns(form.cwd.trim());
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

  async function refreshApprovals(): Promise<void> {
    if (!form.cwd.trim()) {
      setErrorMessage("请输入 workspace path");
      return;
    }

    setApprovalsLoading(true);
    try {
      setErrorMessage("");
      const response = await listApprovals(form.cwd.trim());
      setApprovals(response.approvals);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setApprovalsLoading(false);
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
  }

  function stopClientStream(): void {
    abortRef.current?.abort();
    setIsRunning(false);
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
          <NavItem icon={<Settings />} label="Settings" disabled />
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
          <div className="content-grid">
            <RunLauncher
              form={form}
              providers={providers}
              isRunning={isRunning}
              onChange={setForm}
              onProviderSelect={applyProviderToRun}
              onStart={startRun}
              onStop={stopClientStream}
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
            isLoading={runsLoading}
            errorMessage={errorMessage}
            onCwdChange={(cwd) => setForm({ ...form, cwd })}
            onRefresh={() => void refreshRuns()}
            onSelect={(runId) => void selectRun(runId)}
          />
        ) : (
          activeView === "providers" ? (
          <ProviderSettings
            cwd={form.cwd}
            providers={providers}
            form={providerForm}
            editingProviderId={editingProviderId}
            isLoading={providersLoading}
            errorMessage={errorMessage}
            checkResult={providerCheck}
            selectedProviderId={form.providerPresetId}
            onCwdChange={(cwd) => setForm({ ...form, cwd })}
            onFormChange={setProviderForm}
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

function RunHistory({
  cwd,
  runs,
  selectedRunId,
  isLoading,
  errorMessage,
  onCwdChange,
  onRefresh,
  onSelect,
}: {
  readonly cwd: string;
  readonly runs: readonly RunSession[];
  readonly selectedRunId: string;
  readonly isLoading: boolean;
  readonly errorMessage: string;
  readonly onCwdChange: (cwd: string) => void;
  readonly onRefresh: () => void;
  readonly onSelect: (runId: string) => void;
}): JSX.Element {
  return (
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
  );
}

function ProviderSettings({
  cwd,
  providers,
  form,
  editingProviderId,
  isLoading,
  errorMessage,
  checkResult,
  selectedProviderId,
  onCwdChange,
  onFormChange,
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
  readonly form: ProviderFormState;
  readonly editingProviderId: string;
  readonly isLoading: boolean;
  readonly errorMessage: string;
  readonly checkResult: ProviderCheckResult | undefined;
  readonly selectedProviderId: string;
  readonly onCwdChange: (cwd: string) => void;
  readonly onFormChange: (form: ProviderFormState) => void;
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
        </div>
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
          Stop stream
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

function formatEventData(data: unknown): string {
  if (typeof data === "object" && data !== null && "text" in data) {
    const value = (data as { text?: unknown }).text;
    if (typeof value === "string") {
      return value.length > 240 ? `${value.slice(0, 240)}...` : value;
    }
  }
  return JSON.stringify(data, null, 2);
}

function readTaskTitle(taskSnapshot: unknown): string {
  if (typeof taskSnapshot === "object" && taskSnapshot !== null && "title" in taskSnapshot) {
    const value = (taskSnapshot as { title?: unknown }).title;
    return typeof value === "string" ? value : "";
  }
  return "";
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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

function canUseProviderForRun(provider: ProviderPreset): boolean {
  return provider.enabled && provider.api !== "media-job" && provider.capabilities.includes("chat");
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
  return "管理本地 provider preset，用 env:NAME 引用密钥，并在 run 启动时选择预设。";
}
