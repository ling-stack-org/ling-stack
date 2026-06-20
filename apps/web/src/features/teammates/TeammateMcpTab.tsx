import { ChevronDown, ChevronRight, Loader2, Save, Search, Wrench } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { StatusBadge } from "../../shared/components/index.js";
import type { McpServer, McpTool, TeammateMcpBinding } from "../../types.js";

export type McpToolFilter = "all" | "authorized" | "read" | "write-or-external";

export function TeammateMcpTab({
  mcpServers,
  mcpToolsByServerId,
  mcpBindingByServerId,
  expandedMcpServerIds,
  mcpToolSearchByServerId,
  mcpToolFilterByServerId,
  savingMcp,
  mcpMessage,
  onSave,
  onSetServerSelectedTools,
  onToggleServerExpanded,
  onUpdateToolSearch,
  onUpdateToolFilter,
  onToggleTool,
}: {
  readonly mcpServers: readonly McpServer[];
  readonly mcpToolsByServerId: ReadonlyMap<string, readonly McpTool[]>;
  readonly mcpBindingByServerId: ReadonlyMap<string, TeammateMcpBinding>;
  readonly expandedMcpServerIds: ReadonlySet<string>;
  readonly mcpToolSearchByServerId: Readonly<Record<string, string>>;
  readonly mcpToolFilterByServerId: Readonly<Record<string, McpToolFilter>>;
  readonly savingMcp: boolean;
  readonly mcpMessage: string;
  readonly onSave: () => void | Promise<void>;
  readonly onSetServerSelectedTools: (serverId: string, toolNames: readonly string[]) => void;
  readonly onToggleServerExpanded: (serverId: string) => void;
  readonly onUpdateToolSearch: (serverId: string, value: string) => void;
  readonly onUpdateToolFilter: (serverId: string, filter: McpToolFilter) => void;
  readonly onToggleTool: (serverId: string, toolName: string) => void;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="teammate-mcp-panel" aria-label={t("MCP tool authorization")}>
      <div className="teammate-mcp-toolbar">
        <div className="panel-title">
          <span>
            <Wrench size={16} />
            <h2>{t("MCP tool authorization")}</h2>
          </span>
        </div>
        <span className="teammate-mcp-save-status">{savingMcp ? t("Saving...") : mcpMessage || t("Explicit assignment only")}</span>
        <button className="secondary-button compact-button" type="button" onClick={() => void onSave()} disabled={savingMcp || mcpServers.length === 0}>
          {savingMcp ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
          {t("Update MCP authorization")}
        </button>
      </div>
      <p className="teammate-mcp-note">{t("Only authorize MCP tools this teammate actually needs.")}</p>
      {mcpServers.length === 0 ? (
        <div className="client-empty-state teammate-empty">
          <Wrench size={18} />
          <span>{t("No MCP servers configured")}</span>
        </div>
      ) : (
        <div className="teammate-mcp-server-list">
          {mcpServers.map((server) => {
            const serverTools = mcpToolsByServerId.get(server.id) ?? [];
            const binding = mcpBindingByServerId.get(server.id);
            const selectedTools = new Set(binding?.mode === "all_current_tools"
              ? serverTools.map((tool) => tool.rawName)
              : binding?.selectedToolNames ?? []);
            const expanded = expandedMcpServerIds.has(server.id);
            const searchQuery = mcpToolSearchByServerId[server.id] ?? "";
            const toolFilter = mcpToolFilterByServerId[server.id] ?? "all";
            const filteredTools = filterMcpTools(serverTools, selectedTools, searchQuery, toolFilter);
            const allToolNames = serverTools.map((tool) => tool.rawName);
            return (
              <article key={server.id} className={expanded ? "teammate-mcp-server-row expanded" : "teammate-mcp-server-row"}>
                <header className="teammate-mcp-server-header">
                  <span className="teammate-mcp-server-title">
                    <Wrench size={15} />
                    <span>
                      <strong>{server.displayName}</strong>
                      <small>{server.enabled ? t("Enabled") : t("Disabled")} · {server.status.kind === "ready" ? t("Ready") : t("Not ready")}</small>
                    </span>
                  </span>
                  <span className="teammate-mcp-server-summary">
                    <StatusBadge status={server.status.kind} />
                    <span className="status-badge neutral">{t("{count} tools", { count: serverTools.length })}</span>
                    <span className="status-badge neutral">{t("{count} authorized", { count: selectedTools.size })}</span>
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      onClick={() => onSetServerSelectedTools(server.id, allToolNames)}
                      disabled={savingMcp || !server.enabled || allToolNames.length === 0 || selectedTools.size === allToolNames.length}
                    >
                      {t("Select all current MCP")}
                    </button>
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      onClick={() => onSetServerSelectedTools(server.id, [])}
                      disabled={savingMcp || selectedTools.size === 0}
                    >
                      {t("Clear authorization")}
                    </button>
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => onToggleServerExpanded(server.id)}
                      disabled={serverTools.length === 0}
                    >
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      {expanded ? t("Hide tools") : t("Show tools")}
                    </button>
                  </span>
                </header>
                {serverTools.length === 0 ? (
                  <small className="teammate-mcp-inline-hint">{t("No tools discovered yet. Sync tools from MCP settings first.")}</small>
                ) : null}
                {expanded && serverTools.length > 0 ? (
                  <div className="teammate-mcp-tool-tree">
                    <div className="teammate-mcp-tool-controls">
                      <label className="field teammate-mcp-search">
                        <span>{t("Search tools")}</span>
                        <span className="teammate-mcp-search-input">
                          <Search size={14} />
                          <input
                            aria-label={t("Search tools")}
                            value={searchQuery}
                            onChange={(event) => onUpdateToolSearch(server.id, event.target.value)}
                            placeholder={t("Search tools")}
                          />
                        </span>
                      </label>
                      <div className="teammate-mcp-filter-tabs" role="group" aria-label={t("MCP tool filters")}>
                        {(["all", "authorized", "read", "write-or-external"] as const).map((filter) => (
                          <button
                            key={filter}
                            type="button"
                            className={toolFilter === filter ? "active" : ""}
                            onClick={() => onUpdateToolFilter(server.id, filter)}
                          >
                            {mcpToolFilterLabel(filter, t)}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="teammate-mcp-tool-list">
                      {filteredTools.length === 0 ? (
                        <div className="client-empty-state teammate-empty compact">
                          <span>{t("No tools match filters")}</span>
                        </div>
                      ) : null}
                      {filteredTools.map((tool) => {
                        const toolLabel = tool.displayName || tool.rawName;
                        return (
                          <label
                            key={`${tool.serverId}:${tool.rawName}`}
                            className={selectedTools.has(tool.rawName) ? "teammate-mcp-tool-row selected" : "teammate-mcp-tool-row"}
                          >
                            <span className="teammate-mcp-tool-check">
                              <input
                                type="checkbox"
                                aria-label={toolLabel}
                                checked={selectedTools.has(tool.rawName)}
                                onChange={() => onToggleTool(server.id, tool.rawName)}
                                disabled={savingMcp || !server.enabled}
                              />
                              <span className="teammate-mcp-tool-check-visual" aria-hidden="true" />
                            </span>
                            <span className="teammate-mcp-tool-name">
                              <strong>{toolLabel}</strong>
                            </span>
                            <span className="status-badge neutral teammate-mcp-effect">{mcpToolEffectLabel(tool.sideEffectLevel, t)}</span>
                            <small className="teammate-mcp-tool-description">{tool.description || tool.rawName}</small>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function filterMcpTools(
  tools: readonly McpTool[],
  selectedTools: ReadonlySet<string>,
  searchQuery: string,
  filter: McpToolFilter,
): readonly McpTool[] {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  return tools.filter((tool) => {
    if (filter === "authorized" && !selectedTools.has(tool.rawName)) {
      return false;
    }
    if (filter === "read" && tool.sideEffectLevel !== "read" && tool.sideEffectLevel !== "none") {
      return false;
    }
    if (filter === "write-or-external" && !isWriteOrExternalMcpTool(tool.sideEffectLevel)) {
      return false;
    }
    if (!normalizedQuery) {
      return true;
    }
    return [tool.rawName, tool.displayName, tool.description ?? "", tool.callableName].join(" ").toLowerCase().includes(normalizedQuery);
  });
}

function isWriteOrExternalMcpTool(sideEffectLevel: McpTool["sideEffectLevel"]): boolean {
  return sideEffectLevel === "write" ||
    sideEffectLevel === "write-network" ||
    sideEffectLevel === "external" ||
    sideEffectLevel === "credential" ||
    sideEffectLevel === "deploy";
}

function mcpToolFilterLabel(filter: McpToolFilter, t: (key: string) => string): string {
  if (filter === "authorized") {
    return t("Authorized");
  }
  if (filter === "read") {
    return t("Read tools");
  }
  if (filter === "write-or-external") {
    return t("Write or external actions");
  }
  return t("All");
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
