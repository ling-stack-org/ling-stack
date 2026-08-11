import { Plus, Server } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button } from "../../shared/ui/index.js";

export function McpServerToolbar({
  disabled,
  onAdd,
  readyCount,
  serverCount,
  toolCount,
}: {
  readonly disabled: boolean;
  readonly onAdd: (trigger: HTMLButtonElement) => void;
  readonly readyCount: number;
  readonly serverCount: number;
  readonly toolCount: number;
}): React.JSX.Element {
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
