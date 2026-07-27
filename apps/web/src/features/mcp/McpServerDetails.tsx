import { Braces, Wrench } from "lucide-react";
import { useI18n } from "../../i18n.js";
import {
  Badge,
  DataRow,
  EmptyState,
  InspectorSection,
} from "../../shared/ui/index.js";
import type { McpServer, McpTool } from "../../types.js";
import { McpDetailList } from "./McpDetailList.js";
import {
  mcpServerDetailItems,
  mcpToolDetailItems,
  mcpToolEffectLabelKey,
} from "./mcp-settings-view-models.js";

export function McpServerDetails({
  server,
  tools,
}: {
  readonly server: McpServer;
  readonly tools: readonly McpTool[];
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="settings-mcp-server-details" data-mcp-server-details={server.id}>
      <section className="settings-mcp-tools-section" aria-label={t("Discovered MCP tools")}>
        <div className="settings-mcp-details-heading">
          <span>
            <Wrench aria-hidden="true" />
            <strong>{t("Tools")}</strong>
          </span>
          <small>{t("Tools: {count}", { count: tools.length })}</small>
        </div>
        {tools.length === 0 ? (
          <EmptyState
            compact
            icon={<Wrench />}
            title={t("No tools synced")}
            description={t("Run Sync tools to discover tools from this server.")}
          />
        ) : (
          <div className="settings-mcp-tool-list">
            {tools.map((tool) => (
              <McpToolRow key={`${tool.serverId}:${tool.rawName}`} tool={tool} />
            ))}
          </div>
        )}
      </section>

      <InspectorSection
        className="settings-mcp-inspector"
        title={t("Connection and runtime details")}
        summary={t("Technical details stay folded by default")}
      >
        <McpDetailList items={mcpServerDetailItems(server)} />
      </InspectorSection>
    </div>
  );
}

function McpToolRow({ tool }: { readonly tool: McpTool }): JSX.Element {
  const { t } = useI18n();
  const description = tool.description?.trim();
  return (
    <article className="mcp-tool-row settings-mcp-tool-row">
      <DataRow
        compact
        className="settings-mcp-tool-summary"
        identity={(
          <span className="settings-mcp-tool-identity">
            <span>
              <strong>{tool.displayName || tool.rawName}</strong>
              <small>{description || t("No description")}</small>
            </span>
          </span>
        )}
        status={<Badge variant="outline">{t(mcpToolEffectLabelKey(tool.sideEffectLevel))}</Badge>}
      />
      <InspectorSection
        className="settings-mcp-tool-inspector"
        title={t("Tool details")}
        summary={tool.rawName}
      >
        {description ? <p className="settings-mcp-tool-description">{description}</p> : null}
        <McpDetailList items={mcpToolDetailItems(tool)} />
        <div className="settings-mcp-schema">
          <span><Braces aria-hidden="true" />{t("Input schema")}</span>
          <pre>{formatSchema(tool.inputSchema)}</pre>
        </div>
      </InspectorSection>
    </article>
  );
}

function formatSchema(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "{}";
  } catch {
    return "{}";
  }
}
