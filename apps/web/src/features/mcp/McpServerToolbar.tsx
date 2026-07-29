import { Plus, RefreshCw, Server } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, IconButton } from "../../shared/ui/index.js";

export function McpServerToolbar({
  disabled,
  loading,
  onAdd,
  onRefresh,
  readyCount,
  serverCount,
  toolCount,
}: {
  readonly disabled: boolean;
  readonly loading: boolean;
  readonly onAdd: (trigger: HTMLButtonElement) => void;
  readonly onRefresh: () => void;
  readonly readyCount: number;
  readonly serverCount: number;
  readonly toolCount: number;
}): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="settings-mcp-toolbar" role="toolbar" aria-label={t("MCP server actions")}>
      <span className="settings-mcp-toolbar-summary">
        <Server aria-hidden="true" />
        <span>
          {t("Servers {serverCount} · Ready {readyCount} · Tools {toolCount}", {
            serverCount,
            readyCount,
            toolCount,
          })}
        </span>
      </span>
      <span className="settings-mcp-toolbar-actions">
        <IconButton
          icon={RefreshCw}
          label={t("Refresh MCP servers")}
          loading={loading}
          loadingLabel={t("Refreshing MCP servers")}
          onClick={onRefresh}
        />
        <Button
          disabled={disabled}
          leadingIcon={<Plus />}
          title={disabled ? t("Local workspace is not ready.") : undefined}
          onClick={(event) => onAdd(event.currentTarget)}
        >
          {t("Add MCP server")}
        </Button>
      </span>
    </div>
  );
}
