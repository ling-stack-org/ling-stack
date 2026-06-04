import { useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Server,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { getMcpServerSecret } from "../../api.js";
import { useI18n } from "../../i18n.js";
import type {
  McpServer,
  McpServerFormState,
  McpTool,
} from "../../types.js";

type PublicMcpServer = McpServer & {
  readonly secretConfigured?: Readonly<Record<string, boolean>>;
};

type McpBusyAction = "check" | "sync" | "delete" | "save";
type McpActionFeedback = {
  readonly tone: "succeeded" | "failed";
  readonly message: string;
};

const defaultMcpServerForm: McpServerFormState = {
  displayName: "",
  serverId: "",
  transportType: "streamable-http",
  command: "",
  argsText: "",
  cwd: "",
  url: "",
  headerName: "Authorization",
  headerValue: "",
  envName: "",
  envValue: "",
  clearSecretNames: [],
  startupTimeoutSec: "30",
  toolTimeoutSec: "60",
  enabled: true,
  required: false,
};

export function McpToolsPage({
  servers,
  tools,
  isLoading,
  busyServerId,
  busyAction,
  errorMessage,
  cwd,
  onRefresh,
  onCreate,
  onUpdate,
  onDelete,
  onCheck,
  onSyncTools,
}: {
  readonly servers: readonly McpServer[];
  readonly tools: readonly McpTool[];
  readonly isLoading: boolean;
  readonly busyServerId: string;
  readonly busyAction?: McpBusyAction;
  readonly errorMessage: string;
  readonly cwd: string;
  readonly onRefresh: () => void;
  readonly onCreate: (form: McpServerFormState) => Promise<void>;
  readonly onUpdate: (serverId: string, form: McpServerFormState) => Promise<void>;
  readonly onDelete: (serverId: string) => void;
  readonly onCheck: (serverId: string) => boolean | Promise<boolean> | void | Promise<void>;
  readonly onSyncTools: (serverId: string) => boolean | Promise<boolean> | void | Promise<void>;
}): JSX.Element {
  const { t } = useI18n();
  const [isSheetOpen, setSheetOpen] = useState(false);
  const [editingServerId, setEditingServerId] = useState("");
  const [form, setForm] = useState<McpServerFormState>(defaultMcpServerForm);
  const [sheetError, setSheetError] = useState("");
  const [showHeaderSecret, setShowHeaderSecret] = useState(false);
  const [showEnvSecret, setShowEnvSecret] = useState(false);
  const [expandedServerIds, setExpandedServerIds] = useState<ReadonlySet<string>>(() => new Set());
  const [feedbackByServerId, setFeedbackByServerId] = useState<Readonly<Record<string, McpActionFeedback>>>({});
  const toolsByServerId = useMemo(() => {
    const grouped = new Map<string, McpTool[]>();
    for (const tool of tools) {
      grouped.set(tool.serverId, [...(grouped.get(tool.serverId) ?? []), tool]);
    }
    return grouped;
  }, [tools]);
  const readyCount = servers.filter((server) => server.status.kind === "ready").length;
  const enabledCount = servers.filter((server) => server.enabled).length;

  function openCreateSheet(): void {
    setEditingServerId("");
    setForm(defaultMcpServerForm);
    setSheetError("");
    setShowHeaderSecret(false);
    setShowEnvSecret(false);
    setSheetOpen(true);
  }

  function openEditSheet(server: McpServer): void {
    setEditingServerId(server.id);
    setForm(mcpServerToForm(server));
    setSheetError("");
    setShowHeaderSecret(false);
    setShowEnvSecret(false);
    setSheetOpen(true);
    void loadSavedSecret(server);
  }

  async function loadSavedSecret(server: McpServer): Promise<void> {
    const workspaceCwd = cwd.trim();
    if (!workspaceCwd) {
      return;
    }
    const configuredSecretNames = Object.keys(server.secretConfigured ?? {});
    const secretName = server.transport.type === "stdio"
      ? (server.transport.secretEnvNames[0] ?? configuredSecretNames[0])
      : (server.transport.secretHeaderNames[0] ?? configuredSecretNames[0]);
    if (!secretName) {
      return;
    }
    try {
      const response = await getMcpServerSecret(workspaceCwd, server.id, secretName);
      if (!response.configured) {
        return;
      }
      setForm((current) => {
        if (current.serverId && current.serverId !== server.id) {
          return current;
        }
        const nextClearSecretNames = current.clearSecretNames.filter((name) => name !== secretName);
        return server.transport.type === "stdio"
          ? { ...current, envValue: response.secretValue, clearSecretNames: nextClearSecretNames }
          : { ...current, headerValue: response.secretValue, clearSecretNames: nextClearSecretNames };
      });
    } catch (error) {
      setSheetError(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveServer(): Promise<void> {
    const validationError = validateMcpForm(form, t);
    if (validationError) {
      setSheetError(validationError);
      return;
    }
    try {
      setSheetError("");
      if (editingServerId) {
        await onUpdate(editingServerId, form);
      } else {
        await onCreate(form);
      }
      setForm(defaultMcpServerForm);
      setEditingServerId("");
      setSheetOpen(false);
    } catch (error) {
      setSheetError(error instanceof Error ? error.message : String(error));
    }
  }

  function toggleServerTools(serverId: string): void {
    setExpandedServerIds((current) => {
      const next = new Set(current);
      if (next.has(serverId)) {
        next.delete(serverId);
      } else {
        next.add(serverId);
      }
      return next;
    });
  }

  async function syncServerTools(serverId: string): Promise<void> {
    setServerFeedback(serverId, undefined);
    try {
      const result = await onSyncTools(serverId);
      if (result === false) {
        setServerFeedback(serverId, { tone: "failed", message: t("Tool list sync failed") });
        return;
      }
      setExpandedServerIds((current) => new Set(current).add(serverId));
      setServerFeedback(serverId, { tone: "succeeded", message: t("Tool list synced") });
    } catch (error) {
      setServerFeedback(serverId, { tone: "failed", message: error instanceof Error ? error.message : t("Tool list sync failed") });
    }
  }

  async function checkServerConnection(serverId: string): Promise<void> {
    setServerFeedback(serverId, undefined);
    try {
      const result = await onCheck(serverId);
      setServerFeedback(serverId, result === false
        ? { tone: "failed", message: t("Connection check failed") }
        : { tone: "succeeded", message: t("Connection check succeeded") });
    } catch (error) {
      setServerFeedback(serverId, { tone: "failed", message: error instanceof Error ? error.message : t("Connection check failed") });
    }
  }

  function setServerFeedback(serverId: string, feedback: McpActionFeedback | undefined): void {
    setFeedbackByServerId((current) => {
      const next = { ...current };
      if (feedback) {
        next[serverId] = feedback;
      } else {
        delete next[serverId];
      }
      return next;
    });
  }

  function removeClearSecretName(secretName: string): readonly string[] {
    return form.clearSecretNames.filter((name) => name !== secretName);
  }

  function addClearSecretName(secretName: string): readonly string[] {
    const trimmed = secretName.trim();
    if (!trimmed || form.clearSecretNames.includes(trimmed)) {
      return form.clearSecretNames;
    }
    return [...form.clearSecretNames, trimmed];
  }

  function updateHeaderSecretValue(value: string): void {
    const secretName = form.headerName.trim();
    setForm({
      ...form,
      headerValue: value,
      clearSecretNames: secretName && value ? removeClearSecretName(secretName) : form.clearSecretNames,
    });
  }

  function clearHeaderSecretValue(): void {
    setForm({
      ...form,
      headerValue: "",
      clearSecretNames: addClearSecretName(form.headerName),
    });
  }

  function updateEnvSecretValue(value: string): void {
    const secretName = form.envName.trim();
    setForm({
      ...form,
      envValue: value,
      clearSecretNames: secretName && value ? removeClearSecretName(secretName) : form.clearSecretNames,
    });
  }

  function clearEnvSecretValue(): void {
    setForm({
      ...form,
      envValue: "",
      clearSecretNames: addClearSecretName(form.envName),
    });
  }

  return (
    <div className="mcp-page">
      <section className="mcp-toolbar" aria-label={t("MCP tool access summary")}>
        <div className="mcp-summary">
          <span className="mcp-summary-icon"><Wrench size={18} /></span>
          <div>
            <h2>{t("MCP tool servers")}</h2>
            <p>{t("统一管理 MCP 工具服务，并按 AI 队友单独授权。")}</p>
          </div>
        </div>
        <div className="mcp-toolbar-actions">
          <span className="status-badge neutral">{t("{ready}/{total} ready", { ready: readyCount, total: servers.length })}</span>
          <span className="status-badge neutral">{t("{count} enabled", { count: enabledCount })}</span>
          <button className="secondary-button" type="button" onClick={onRefresh} disabled={isLoading}>
            <RefreshCw size={15} className={isLoading ? "spin" : undefined} />
            {t("Refresh")}
          </button>
          <button className="primary-button" type="button" onClick={openCreateSheet}>
            <Plus size={15} />
            {t("Add MCP server")}
          </button>
        </div>
      </section>

      {errorMessage ? <div className="inline-error">{errorMessage}</div> : null}

      <section className="mcp-server-panel" aria-label={t("MCP servers")}>
        <div className="panel-title split">
          <span>
            <Server size={16} />
            <h2>{t("MCP servers")}</h2>
          </span>
          <small>{isLoading ? t("Loading...") : t("{count} servers", { count: servers.length })}</small>
        </div>
        {servers.length === 0 ? (
          <div className="client-empty-state mcp-empty">
            <Wrench size={20} />
            <span>{t("No MCP servers")}</span>
            <small>{t("Add a server, check it, then assign tools to AI teammates explicitly.")}</small>
          </div>
        ) : (
          <div className="mcp-server-list">
            {servers.map((server) => {
              const publicServer = server as PublicMcpServer;
              const serverTools = toolsByServerId.get(server.id) ?? [];
              const busy = busyServerId === server.id ? busyAction : undefined;
              const toolsExpanded = expandedServerIds.has(server.id);
              const feedback = feedbackByServerId[server.id];
              return (
                <article key={server.id} className="mcp-server-row">
                  <div className="mcp-server-summary-row">
                    <div className="mcp-server-main">
                      <span className="mcp-server-icon"><Server size={17} /></span>
                      <div>
                        <strong>{server.displayName}</strong>
                        <small>{transportLabel(server, t)} · {server.enabled ? t("Enabled") : t("Disabled")}</small>
                      </div>
                    </div>
                    <div className="mcp-server-meta">
                      <span className={`status-badge ${mcpStatusClass(server.status.kind)}`}>{mcpStatusLabel(server.status.kind, t)}</span>
                      {hasConfiguredSecret(publicServer) ? (
                        <span className="status-badge succeeded">{t("Secret configured")}</span>
                      ) : (
                        <span className="status-badge neutral">{t("No secret")}</span>
                      )}
                      <span>{t("{count} tools", { count: serverTools.length })}</span>
                    </div>
                    <div className="mcp-server-actions">
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        aria-expanded={toolsExpanded}
                        onClick={() => toggleServerTools(server.id)}
                        disabled={serverTools.length === 0}
                      >
                        {toolsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {toolsExpanded ? t("Hide tools") : t("Show tools")}
                      </button>
                      <button className="secondary-button compact-button" type="button" onClick={() => void checkServerConnection(server.id)} disabled={Boolean(busy)}>
                        {busy === "check" ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
                        {t("Check connection")}
                      </button>
                      <button className="secondary-button compact-button" type="button" onClick={() => void syncServerTools(server.id)} disabled={Boolean(busy)}>
                        {busy === "sync" ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}
                        {t("Sync tool list")}
                      </button>
                      <button className="secondary-button compact-button" type="button" onClick={() => openEditSheet(server)} disabled={Boolean(busy)}>
                        <Pencil size={14} />
                        {t("Edit")}
                      </button>
                      <button className="secondary-button danger compact-button" type="button" onClick={() => onDelete(server.id)} disabled={Boolean(busy)}>
                        {busy === "delete" ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
                        {t("Delete")}
                      </button>
                    </div>
                  </div>
                  {server.status.message ? <p className="mcp-server-message">{server.status.message}</p> : null}
                  {feedback ? (
                    <p className={`mcp-server-feedback ${feedback.tone}`} role="status">
                      {feedback.message}
                    </p>
                  ) : null}
                  {toolsExpanded && serverTools.length > 0 ? (
                    <div className="mcp-tool-list" aria-label={t("Discovered MCP tools")}>
                      {serverTools.map((tool) => (
                        <article key={`${tool.serverId}:${tool.rawName}`} className="mcp-tool-row">
                          <span className="mcp-tool-copy">
                            <strong>{tool.displayName || tool.rawName}</strong>
                            <small>{tool.description || tool.rawName}</small>
                            {tool.description && tool.description.length > 120 ? (
                              <details className="mcp-tool-details">
                                <summary>{t("Tool details")}</summary>
                                <p>{tool.description}</p>
                              </details>
                            ) : null}
                          </span>
                          <span className="status-badge neutral">{mcpToolEffectLabel(tool.sideEffectLevel, t)}</span>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>

      {isSheetOpen ? (
        <div className="mcp-sheet-backdrop" role="presentation">
          <section className="mcp-sheet" role="dialog" aria-modal="true" aria-label={editingServerId ? t("Edit MCP server") : t("Add MCP server")}>
            <header className="mcp-sheet-header">
              <div>
                <span className="mcp-sheet-kicker">{t("MCP server")}</span>
                <h2>{editingServerId ? t("Edit MCP server") : t("Add MCP server")}</h2>
                <p>{t("Saved local secrets stay hidden until you choose to show them.")}</p>
              </div>
              <button className="icon-button" type="button" aria-label={t("Close MCP server editor")} onClick={() => setSheetOpen(false)}>
                <X size={16} />
              </button>
            </header>
            <div className="mcp-sheet-body">
              {sheetError ? <div className="inline-error">{sheetError}</div> : null}
              <section className="mcp-form-section">
                <div className="mcp-section-title mcp-section-title-with-control">
                  <div className="mcp-section-heading">
                    <span><Server size={15} />{t("Basic information")}</span>
                    <small>{t("Name and transport for this workspace-level MCP server.")}</small>
                  </div>
                  <label className="mcp-switch-control">
                    <span className="mcp-switch-copy">
                      <strong>{t("Enable server")}</strong>
                    </span>
                    <input
                      type="checkbox"
                      role="switch"
                      aria-label={t("Enable server")}
                      checked={form.enabled}
                      onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                    />
                    <span className="mcp-switch-track" aria-hidden="true">
                      <span className="mcp-switch-thumb" />
                    </span>
                  </label>
                </div>
                <div className="mcp-form-grid">
                  <label className="field">
                    <span>{t("Server name")}</span>
                    <input value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} placeholder={t("GitHub MCP")} />
                  </label>
                  <label className="field">
                    <span>{t("Server id")}</span>
                    <input value={form.serverId} onChange={(event) => setForm({ ...form, serverId: event.target.value })} placeholder={t("github")} disabled={Boolean(editingServerId)} />
                  </label>
                  <label className="field">
                    <span>{t("Transport")}</span>
                    <select value={form.transportType} onChange={(event) => setForm({ ...form, transportType: event.target.value as McpServerFormState["transportType"] })}>
                      <option value="streamable-http">HTTP</option>
                      <option value="stdio">stdio</option>
                    </select>
                  </label>
                </div>
              </section>

              {form.transportType === "stdio" ? (
                <section className="mcp-form-section">
                  <div className="mcp-section-title">
                    <span><Wrench size={15} />stdio</span>
                    <small>{t("Run a local MCP process from this workspace.")}</small>
                  </div>
                  <div className="mcp-form-grid">
                    <label className="field">
                      <span>{t("Command")}</span>
                      <input value={form.command} onChange={(event) => setForm({ ...form, command: event.target.value })} placeholder="npx" />
                    </label>
                    <label className="field">
                      <span>{t("Arguments")}</span>
                      <input value={form.argsText} onChange={(event) => setForm({ ...form, argsText: event.target.value })} placeholder="-y @modelcontextprotocol/server-filesystem ." />
                    </label>
                    <label className="field wide">
                      <span>{t("Working directory")}</span>
                      <input value={form.cwd} onChange={(event) => setForm({ ...form, cwd: event.target.value })} placeholder={t("Optional")} />
                    </label>
                    <label className="field">
                      <span>{t("Env secret name")}</span>
                      <input value={form.envName} onChange={(event) => setForm({ ...form, envName: event.target.value })} placeholder="GITHUB_TOKEN" />
                    </label>
                    <div className="field">
                      <span>{t("Env secret value")}</span>
                      <div className="mcp-secret-input">
                        <input
                          aria-label={t("Env secret value")}
                          type={showEnvSecret ? "text" : "password"}
                          autoComplete="new-password"
                          value={form.envValue}
                          onChange={(event) => updateEnvSecretValue(event.target.value)}
                          placeholder={t("Paste secret")}
                        />
                        {form.envValue ? (
                          <span className="mcp-secret-actions">
                            <button
                              className="icon-button mcp-secret-toggle"
                              type="button"
                              aria-label={showEnvSecret ? t("Hide Env secret value") : t("Show Env secret value")}
                              onClick={() => setShowEnvSecret((current) => !current)}
                            >
                              {showEnvSecret ? <Eye size={15} /> : <EyeOff size={15} />}
                            </button>
                            <button className="icon-button mcp-secret-clear" type="button" aria-label={t("Clear input")} onClick={clearEnvSecretValue}>
                              <X size={15} />
                            </button>
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </section>
              ) : (
                <section className="mcp-form-section">
                  <div className="mcp-section-title">
                    <span><Wrench size={15} />HTTP</span>
                    <small>{t("Connect to a streamable HTTP MCP endpoint.")}</small>
                  </div>
                  <div className="mcp-form-grid">
                    <label className="field wide">
                      <span>{t("Server URL")}</span>
                      <input value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} placeholder="https://example.com/mcp" />
                    </label>
                    <label className="field">
                      <span>{t("Header secret name")}</span>
                      <input value={form.headerName} onChange={(event) => setForm({ ...form, headerName: event.target.value })} placeholder="Authorization" />
                    </label>
                    <div className="field">
                      <span>{t("Header secret value")}</span>
                      <div className="mcp-secret-input">
                        <input
                          aria-label={t("Header secret value")}
                          type={showHeaderSecret ? "text" : "password"}
                          autoComplete="new-password"
                          value={form.headerValue}
                          onChange={(event) => updateHeaderSecretValue(event.target.value)}
                          placeholder={headerSecretPlaceholder(form.headerName, t)}
                        />
                        {form.headerValue ? (
                          <span className="mcp-secret-actions">
                            <button
                              className="icon-button mcp-secret-toggle"
                              type="button"
                              aria-label={showHeaderSecret ? t("Hide Header secret value") : t("Show Header secret value")}
                              onClick={() => setShowHeaderSecret((current) => !current)}
                            >
                              {showHeaderSecret ? <Eye size={15} /> : <EyeOff size={15} />}
                            </button>
                            <button className="icon-button mcp-secret-clear" type="button" aria-label={t("Clear input")} onClick={clearHeaderSecretValue}>
                              <X size={15} />
                            </button>
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </section>
              )}

              <details className="mcp-advanced-settings">
                <summary>{t("Advanced settings")}</summary>
                <div className="mcp-form-grid">
                  <label className="field">
                    <span>{t("Startup timeout")}</span>
                    <input value={form.startupTimeoutSec} onChange={(event) => setForm({ ...form, startupTimeoutSec: event.target.value })} inputMode="numeric" />
                  </label>
                  <label className="field">
                    <span>{t("Tool timeout")}</span>
                    <input value={form.toolTimeoutSec} onChange={(event) => setForm({ ...form, toolTimeoutSec: event.target.value })} inputMode="numeric" />
                  </label>
                  <div className="mcp-advanced-option wide">
                    <span className="mcp-advanced-option-copy">
                      <strong>{t("Critical dependency")}</strong>
                      <small>{t("When enabled, assigned teammates stop running if this service is unavailable, so they do not continue without critical tools.")}</small>
                    </span>
                    <label className="mcp-switch-control mcp-switch-control-compact">
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label={t("Critical dependency")}
                        checked={form.required}
                        onChange={(event) => setForm({ ...form, required: event.target.checked })}
                      />
                      <span className="mcp-switch-track" aria-hidden="true">
                        <span className="mcp-switch-thumb" />
                      </span>
                    </label>
                  </div>
                </div>
              </details>
            </div>
            <footer className="mcp-sheet-footer">
              <button className="secondary-button" type="button" onClick={() => setSheetOpen(false)}>{t("Cancel")}</button>
              <button className="primary-button" type="button" onClick={() => void saveServer()} disabled={busyAction === "save"}>
                {busyAction === "save" ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
                {t("Save server")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function mcpServerToForm(server: McpServer): McpServerFormState {
  if (server.transport.type === "stdio") {
    const envName = server.transport.secretEnvNames[0] ?? "";
    return {
      ...defaultMcpServerForm,
      displayName: server.displayName,
      serverId: server.id,
      transportType: "stdio",
      command: server.transport.command,
      argsText: server.transport.args.join(" "),
      cwd: server.transport.cwd ?? "",
      envName,
      enabled: server.enabled,
      required: server.required,
      startupTimeoutSec: server.startupTimeoutSec ? String(server.startupTimeoutSec) : "",
      toolTimeoutSec: server.toolTimeoutSec ? String(server.toolTimeoutSec) : "",
    };
  }
  const headerName = server.transport.secretHeaderNames[0] ?? "Authorization";
  return {
    ...defaultMcpServerForm,
    displayName: server.displayName,
    serverId: server.id,
    transportType: "streamable-http",
    url: server.transport.url,
    headerName,
    enabled: server.enabled,
    required: server.required,
    startupTimeoutSec: server.startupTimeoutSec ? String(server.startupTimeoutSec) : "",
    toolTimeoutSec: server.toolTimeoutSec ? String(server.toolTimeoutSec) : "",
  };
}

function validateMcpForm(form: McpServerFormState, t: (key: string) => string): string {
  if (!form.displayName.trim()) {
    return t("Enter a server name.");
  }
  if (form.transportType === "stdio" && !form.command.trim()) {
    return t("Enter a command for stdio MCP.");
  }
  if (form.transportType === "streamable-http" && !form.url.trim()) {
    return t("Enter an HTTP MCP server URL.");
  }
  return "";
}

function transportLabel(server: McpServer, t: (key: string) => string): string {
  if (server.transport.type === "stdio") {
    return "stdio";
  }
  return t("HTTP");
}

function mcpStatusLabel(status: McpServer["status"]["kind"], t: (key: string) => string): string {
  if (status === "ready") {
    return t("Ready");
  }
  if (status === "failed") {
    return t("Failed");
  }
  if (status === "disabled") {
    return t("Disabled");
  }
  if (status === "checking") {
    return t("Checking");
  }
  return t("Unknown");
}

function mcpStatusClass(status: McpServer["status"]["kind"]): string {
  if (status === "ready") {
    return "succeeded";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "disabled") {
    return "neutral";
  }
  return "neutral";
}

function mcpToolEffectLabel(sideEffectLevel: McpTool["sideEffectLevel"], t: (key: string) => string): string {
  if (sideEffectLevel === "none") {
    return t("No side effects");
  }
  if (sideEffectLevel === "read") {
    return t("Read");
  }
  if (sideEffectLevel === "write") {
    return t("Write");
  }
  if (sideEffectLevel === "write-network") {
    return t("Write network");
  }
  if (sideEffectLevel === "external") {
    return t("External action");
  }
  if (sideEffectLevel === "credential") {
    return t("Credential");
  }
  if (sideEffectLevel === "deploy") {
    return t("Deploy");
  }
  return sideEffectLevel;
}

function headerSecretPlaceholder(headerName: string, t: (key: string) => string): string {
  return headerName.trim().toLowerCase() === "authorization" ? "Bearer ..." : t("Paste secret");
}

function hasConfiguredSecret(server: PublicMcpServer): boolean {
  return Object.values(server.secretConfigured ?? {}).some(Boolean);
}
