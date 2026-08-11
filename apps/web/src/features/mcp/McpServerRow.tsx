import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";
import { useI18n } from "../../i18n.js";
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DataRow,
  IconButton,
  InlineFeedback,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  StatusIndicator,
} from "../../shared/ui/index.js";
import type { McpServer, McpTool } from "../../types.js";
import { McpServerDetails } from "./McpServerDetails.js";
import {
  mcpServerPrimaryAction,
  mcpServerStatusPresentation,
  mcpTransportLabelKey,
  type McpServerPrimaryAction,
} from "./mcp-settings-view-models.js";

export interface McpServerRowFeedback {
  readonly message: string;
  readonly tone: "danger";
}

export function McpServerRow({
  busyAction,
  expanded,
  feedback,
  onCheck,
  onEdit,
  onExpandedChange,
  onRequestDelete,
  onSync,
  server,
  tools,
}: {
  readonly busyAction?: "check" | "delete" | "save" | "sync";
  readonly expanded: boolean;
  readonly feedback?: McpServerRowFeedback;
  readonly onCheck: (serverId: string) => void;
  readonly onEdit: (server: McpServer, trigger: HTMLButtonElement) => void;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onRequestDelete: (server: McpServer, trigger: HTMLButtonElement | null) => void;
  readonly onSync: (serverId: string) => void;
  readonly server: McpServer;
  readonly tools: readonly McpTool[];
}): React.JSX.Element {
  const { t } = useI18n();
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const deleteRequestedRef = useRef(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const status = mcpServerStatusPresentation(server);
  const primaryAction = mcpServerPrimaryAction(server);
  const busy = Boolean(busyAction);

  return (
    <Collapsible
      className="mcp-server-row settings-mcp-server-row"
      open={expanded}
      onOpenChange={onExpandedChange}
    >
      <DataRow
        className="settings-mcp-server-summary"
        identity={(
          <span className="settings-mcp-server-identity">
            <span className="settings-mcp-server-icon" aria-hidden="true"><Server /></span>
            <span>
              <strong>{server.displayName}</strong>
              <small>{t(mcpTransportLabelKey(server))}</small>
            </span>
          </span>
        )}
        summary={<span className="settings-mcp-tool-count">{t("Tools: {count}", { count: tools.length })}</span>}
        status={<StatusIndicator label={t(status.labelKey)} tone={status.tone} />}
        actions={(
          <span className="settings-mcp-server-actions">
            <CollapsibleTrigger asChild>
              <IconButton
                icon={expanded ? ChevronDown : ChevronRight}
                label={t(expanded ? "Hide details" : "Show details")}
                pressed={expanded}
              />
            </CollapsibleTrigger>
            <PrimaryServerAction
              action={primaryAction}
              busyAction={busyAction}
              disabled={busy}
              onCheck={() => onCheck(server.id)}
              onEdit={(trigger) => onEdit(server, trigger)}
              onSync={() => onSync(server.id)}
            />
            {primaryAction !== "check" ? (
              <IconButton
                disabled={busy}
                icon={CheckCircle2}
                label={t("Check connection")}
                loading={busyAction === "check"}
                loadingLabel={t("Checking connection")}
                onClick={() => onCheck(server.id)}
              />
            ) : null}
            {primaryAction !== "sync" ? (
              <IconButton
                disabled={busy}
                icon={RefreshCw}
                label={t("Sync tool list")}
                loading={busyAction === "sync"}
                loadingLabel={t("Syncing tools")}
                onClick={() => onSync(server.id)}
              />
            ) : null}
            {primaryAction !== "edit" ? (
              <IconButton
                disabled={busy}
                icon={Pencil}
                label={t("Edit")}
                onClick={(event) => onEdit(server, event.currentTarget)}
              />
            ) : null}
            <Menu open={actionsOpen} onOpenChange={setActionsOpen}>
              <MenuTrigger asChild>
                <IconButton
                  ref={moreButtonRef}
                  disabled={busy}
                  icon={MoreHorizontal}
                  label={t("More actions")}
                />
              </MenuTrigger>
              <MenuContent
                align="end"
                onCloseAutoFocus={(event) => {
                  if (!deleteRequestedRef.current) return;
                  event.preventDefault();
                  deleteRequestedRef.current = false;
                  const trigger = moreButtonRef.current;
                  globalThis.requestAnimationFrame(() => onRequestDelete(server, trigger));
                }}
              >
                <MenuItem
                  tone="danger"
                  onSelect={() => {
                    deleteRequestedRef.current = true;
                    setActionsOpen(false);
                  }}
                >
                  <Trash2 aria-hidden="true" />
                  <span>{t("Delete")}</span>
                </MenuItem>
              </MenuContent>
            </Menu>
          </span>
        )}
      />

      {feedback ? (
        <InlineFeedback className="settings-mcp-row-feedback" tone={feedback.tone}>
          {feedback.message}
        </InlineFeedback>
      ) : null}

      <CollapsibleContent>
        <McpServerDetails server={server} tools={tools} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function PrimaryServerAction({
  action,
  busyAction,
  disabled,
  onCheck,
  onEdit,
  onSync,
}: {
  readonly action: McpServerPrimaryAction;
  readonly busyAction?: "check" | "delete" | "save" | "sync";
  readonly disabled: boolean;
  readonly onCheck: () => void;
  readonly onEdit: (trigger: HTMLButtonElement) => void;
  readonly onSync: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const label = action === "check" ? t("Check connection") : action === "sync" ? t("Sync tool list") : t("Edit");
  const loading = busyAction === action || (action === "edit" && busyAction === "save");
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={disabled}
      loading={loading}
      loadingLabel={action === "check" ? t("Checking connection") : action === "sync" ? t("Syncing tools") : t("Saving changes")}
      onClick={(event) => {
        if (action === "check") onCheck();
        else if (action === "sync") onSync();
        else onEdit(event.currentTarget);
      }}
    >
      {label}
    </Button>
  );
}
