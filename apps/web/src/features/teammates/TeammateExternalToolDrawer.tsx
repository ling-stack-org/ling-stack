import type { RefObject } from "react";
import { useI18n } from "../../i18n.js";
import {
  Badge,
  Checkbox,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerHeader,
  EmptyState,
  Input,
  Select,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { McpServer, McpTool } from "../../types.js";
import {
  externalToolDisplayName,
  externalToolDescription,
  filterExternalTools,
  type ExternalToolFilter,
  type ExternalToolServiceRow,
} from "./teammate-external-tools-view-models.js";
import { teammateMcpToolEffectPresentation } from "./teammate-mcp-status-presentation.js";
import type { TeammateExternalToolsController } from "./useTeammateExternalToolsController.js";

const filters: readonly ExternalToolFilter[] = ["all", "authorized", "high-risk"];

export function TeammateExternalToolDrawer({
  controller,
  returnFocusRef,
  row,
}: {
  readonly controller: TeammateExternalToolsController;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  readonly row: ExternalToolServiceRow | undefined;
}): React.JSX.Element {
  const { t } = useI18n();
  const visibleTools = row
    ? filterExternalTools(row.tools, row.selectedToolNames, controller.searchQuery, controller.filter)
    : [];

  return (
    <Drawer
      busy={controller.saving}
      open={Boolean(row)}
      onOpenChange={(open) => { if (!open) controller.closeServer(); }}
    >
      <DrawerContent
        className="teammate-external-tool-drawer"
        size="md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          globalThis.requestAnimationFrame(() => returnFocusRef.current?.focus());
        }}
      >
        <DrawerHeader
          closeLabel={t("Close")}
          title={row?.server.displayName ?? t("External tools")}
        />
        {row ? (
          <DrawerBody className="teammate-external-tool-drawer-body">
            <div className="teammate-external-tool-drawer-status">
              <StatusIndicator label={t(row.status.labelKey)} tone={row.status.tone} />
              <span>{row.authorizedCount > 0
                ? t("{count} allowed", { count: row.authorizedCount })
                : t("None allowed")}</span>
            </div>

            <div className="teammate-external-tool-controls">
              <Input
                aria-label={t("Search tools")}
                placeholder={t("Search tools")}
                type="search"
                value={controller.searchQuery}
                onChange={(event) => controller.setSearchQuery(event.target.value)}
              />
              <Select
                aria-label={t("Tool filter")}
                value={controller.filter}
                onChange={(event) => controller.setFilter(event.target.value as ExternalToolFilter)}
              >
                {filters.map((filter) => (
                  <option key={filter} value={filter}>{filterLabel(filter, t)}</option>
                ))}
              </Select>
            </div>

            {row.tools.length === 0 ? (
              <EmptyState compact title={t("No external capabilities available")} />
            ) : visibleTools.length === 0 ? (
              <EmptyState compact title={t("No tools match filters")} />
            ) : (
              <div className="teammate-mcp-tool-list teammate-external-tool-list" role="list">
                {visibleTools.map((tool, index) => (
                  <ExternalToolCheckbox
                    key={`${tool.serverId}:${tool.rawName}`}
                    checked={row.selectedToolNames.has(tool.rawName)}
                    disabled={controller.saving || (
                      !row.selectedToolNames.has(tool.rawName)
                      && (!row.server.enabled || tool.enabled === false)
                    )}
                    index={index}
                    tool={tool}
                    onChange={() => controller.toggleTool(row.server.id, tool.rawName)}
                  />
                ))}
              </div>
            )}
          </DrawerBody>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}

function ExternalToolCheckbox({
  checked,
  disabled,
  index,
  onChange,
  tool,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly index: number;
  readonly onChange: () => void;
  readonly tool: McpTool;
}): React.JSX.Element {
  const { t } = useI18n();
  const fallback = t("Unnamed external capability {number}", { number: index + 1 });
  const displayName = externalToolDisplayName(tool, fallback);
  const description = externalToolDescription(tool);
  const effect = teammateMcpToolEffectPresentation(tool.sideEffectLevel);
  return (
    <Checkbox
      className="teammate-mcp-tool-row teammate-external-tool-option"
      checked={checked}
      disabled={disabled}
      aria-label={displayName}
      onChange={onChange}
      label={(
        <span className="teammate-external-tool-option-content">
          <span>
            <strong>{displayName}</strong>
            {description ? <small>{description}</small> : null}
          </span>
          <Badge className="teammate-mcp-effect" tone={effect.tone} variant="outline">
            {t(effect.labelKey)}
          </Badge>
        </span>
      )}
    />
  );
}

function filterLabel(filter: ExternalToolFilter, t: (key: string) => string): string {
  if (filter === "authorized") return t("Allowed");
  if (filter === "high-risk") return t("High-risk actions");
  return t("All");
}
