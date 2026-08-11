import { useMemo, useRef } from "react";
import { Wrench } from "lucide-react";
import { useI18n } from "../../i18n.js";
import { Button, DataRow, InlineFeedback, StatusIndicator } from "../../shared/ui/index.js";
import type { McpServer, McpTool } from "../../types.js";
import { TeammateExternalToolDrawer } from "./TeammateExternalToolDrawer.js";
import { buildExternalToolServiceRows } from "./teammate-external-tools-view-models.js";
import type { TeammateExternalToolsController } from "./useTeammateExternalToolsController.js";

export function TeammateExternalToolsSection({
  controller,
  servers,
  toolsByServerId,
}: {
  readonly controller: TeammateExternalToolsController;
  readonly servers: readonly McpServer[];
  readonly toolsByServerId: ReadonlyMap<string, readonly McpTool[]>;
}): React.JSX.Element {
  const { t } = useI18n();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const rows = useMemo(() => buildExternalToolServiceRows({
    servers,
    toolsByServerId,
    bindingByServerId: controller.bindingByServerId,
  }), [controller.bindingByServerId, servers, toolsByServerId]);
  const selectedRow = rows.find((row) => row.server.id === controller.selectedServerId);

  return (
    <section className="teammate-mcp-panel teammate-external-tools-panel" aria-label={t("External tools")}>
      <div className="teammate-external-tools-heading">
        <Wrench aria-hidden="true" />
        <h2>{t("External tools")}</h2>
      </div>
      {controller.error ? (
        <InlineFeedback className="teammate-mcp-save-error" tone="danger">{controller.error}</InlineFeedback>
      ) : null}
      <div className="teammate-mcp-server-list teammate-external-tools-list" role="list">
        {rows.map((row) => (
          <DataRow
            compact
            className="teammate-mcp-server-row teammate-external-tool-row"
            key={row.server.id}
            role="listitem"
            identity={<strong title={row.server.displayName}>{row.server.displayName}</strong>}
            summary={<span>{row.authorizedCount > 0
              ? t("{count} allowed", { count: row.authorizedCount })
              : t("None allowed")}</span>}
            status={(
              <StatusIndicator
                className="teammate-mcp-server-status"
                label={t(row.status.labelKey)}
                tone={row.status.tone}
              />
            )}
            actions={(
              <Button
                ref={(node) => {
                  if (controller.selectedServerId === row.server.id && node) returnFocusRef.current = node;
                }}
                size="sm"
                variant="secondary"
                aria-label={t("Manage {name}", { name: row.server.displayName })}
                onClick={(event) => {
                  returnFocusRef.current = event.currentTarget;
                  controller.openServer(row.server.id);
                }}
              >
                {t("Manage")}
              </Button>
            )}
          />
        ))}
      </div>
      <TeammateExternalToolDrawer controller={controller} returnFocusRef={returnFocusRef} row={selectedRow} />
    </section>
  );
}
