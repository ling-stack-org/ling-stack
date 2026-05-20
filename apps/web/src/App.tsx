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
  Play,
  PlugZap,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Workflow,
} from "lucide-react";
import { buildRunRequest, daemonBaseUrl, getDaemonHealth, getRun, getRunEvents, listRuns } from "./api.js";
import { streamRun } from "./sse.js";
import type { RunEventEnvelope, RunFormState, RunSession, ToolName } from "./types.js";

const defaultTools: readonly ToolName[] = ["read", "grep", "find", "ls"];
const allTools: readonly ToolName[] = ["read", "grep", "find", "ls", "bash", "edit", "write"];
type ViewId = "workspace" | "runs";

const defaultForm: RunFormState = {
  cwd: "/Users/tianxiao/ling-stack",
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

export function App(): JSX.Element {
  const [form, setForm] = useState<RunFormState>(defaultForm);
  const [activeView, setActiveView] = useState<ViewId>("workspace");
  const [daemonHealthy, setDaemonHealthy] = useState<boolean | undefined>();
  const [activeRunId, setActiveRunId] = useState("");
  const [lookupRunId, setLookupRunId] = useState("");
  const [run, setRun] = useState<RunSession | undefined>();
  const [runs, setRuns] = useState<readonly RunSession[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
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

  useEffect(() => {
    void refreshHealth();
  }, []);

  useEffect(() => {
    if (activeView === "runs") {
      void refreshRuns();
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
          <NavItem icon={<PlugZap />} label="Providers" disabled />
          <NavItem icon={<ShieldCheck />} label="Approvals" disabled />
          <NavItem icon={<Settings />} label="Settings" disabled />
        </nav>
      </aside>
      <section className="workspace">
        <div className="workspace-head">
          <div>
            <h1>{activeView === "workspace" ? "Run workspace" : "Run history"}</h1>
            <p>
              {activeView === "workspace"
                ? "发起本地任务，观察 pi-coding-agent 事件流，并读取持久化 run 历史。"
                : "查看当前 workspace 的持久化 run，点击任意记录读取事件和上下文。"}
            </p>
          </div>
          <StatusBadge status={latestStatus} />
        </div>

        {activeView === "workspace" ? (
          <div className="content-grid">
            <RunLauncher form={form} isRunning={isRunning} onChange={setForm} onStart={startRun} onStop={stopClientStream} />
            <RunTimeline events={events} assistantText={assistantText} errorMessage={errorMessage} isRunning={isRunning} />
          </div>
        ) : (
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

function RunLauncher({
  form,
  isRunning,
  onChange,
  onStart,
  onStop,
}: {
  readonly form: RunFormState;
  readonly isRunning: boolean;
  readonly onChange: (form: RunFormState) => void;
  readonly onStart: () => void;
  readonly onStop: () => void;
}): JSX.Element {
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

      <div className="field-row">
        <label className="field">
          <span>Provider</span>
          <input value={form.provider} onChange={(event) => onChange({ ...form, provider: event.target.value })} />
        </label>
        <label className="field">
          <span>Model</span>
          <input value={form.model} onChange={(event) => onChange({ ...form, model: event.target.value })} />
        </label>
      </div>

      <label className="field wide">
        <span>Base URL</span>
        <input value={form.baseUrl} onChange={(event) => onChange({ ...form, baseUrl: event.target.value })} />
      </label>

      <div className="field-row">
        <label className="field">
          <span>API protocol</span>
          <select value={form.api} onChange={(event) => onChange({ ...form, api: event.target.value })}>
            <option value="openai-completions">OpenAI completions</option>
            <option value="openai-responses">OpenAI responses</option>
            <option value="anthropic-messages">Anthropic messages</option>
            <option value="google-generative-ai">Google generative AI</option>
          </select>
        </label>
        <label className="field">
          <span>Temporary API key</span>
          <input
            type="password"
            value={form.apiKey}
            placeholder="optional"
            onChange={(event) => onChange({ ...form, apiKey: event.target.value })}
          />
        </label>
      </div>

      <div className="tool-grid" aria-label="Allowed tools">
        {allTools.map((tool) => (
          <label key={tool} className={form.tools.includes(tool) ? "tool-toggle selected" : "tool-toggle"}>
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
        ))}
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
}: {
  readonly events: readonly RunEventEnvelope[];
  readonly assistantText: string;
  readonly errorMessage: string;
  readonly isRunning: boolean;
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
