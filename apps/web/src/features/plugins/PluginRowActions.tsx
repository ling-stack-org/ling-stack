import {
  ChevronRight,
  Globe2,
  Download,
  MoreHorizontal,
  Power,
  PowerOff,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Unplug,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  Button,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Tooltip,
} from "../../shared/ui/index.js";
import { Fragment } from "react";
import type { PluginBusyAction } from "../../domains/plugins/use-plugins-domain.js";
import type { PluginActionHandlers, PluginActionId, PluginActionView, PluginRowView } from "./plugin-manager-types.js";
import type { Translate } from "../../i18n.js";

export function PluginRowActions({
  row,
  handlers,
  t,
}: {
  readonly row: PluginRowView;
  readonly handlers: PluginActionHandlers;
  readonly t: Translate;
}): React.JSX.Element {
  const rowBusy = Boolean(row.busyAction);
  return (
    <div className="plugin-table-actions">
      {row.primaryAction ? (
        <Button
          className="plugin-table-primary-action"
          disabled={rowBusy && !actionIsBusy(row.primaryAction.id, row.busyAction)}
          leadingIcon={pluginActionIcon(row.primaryAction.id)}
          loading={actionIsBusy(row.primaryAction.id, row.busyAction)}
          loadingLabel={t("Loading")}
          onClick={() => runPluginAction(row.primaryAction?.id ?? "details", row.id, handlers)}
          size="sm"
          variant={row.primaryAction.tone === "danger" ? "danger" : "secondary"}
        >
          {row.primaryAction.label}
        </Button>
      ) : null}
      {row.showCheckAction ? (
        <PluginIconAction
          action={{ id: "check", label: row.checkActionLabel ?? t("Check"), tone: "secondary" }}
          busy={actionIsBusy("check", row.busyAction)}
          disabled={rowBusy}
          onClick={() => handlers.onCheck(row.id)}
        />
      ) : null}
      {row.showDisableAction ? (
        <PluginIconAction
          action={{ id: "disable", label: t("Disable"), tone: "secondary" }}
          busy={actionIsBusy("disable", row.busyAction)}
          disabled={rowBusy}
          onClick={() => handlers.onDisable(row.id)}
        />
      ) : null}
      {row.showDetailsAction ? (
        <PluginIconAction
          action={{ id: "details", label: t("Details"), tone: "secondary" }}
          busy={false}
          disabled={rowBusy}
          onClick={() => handlers.onOpenDetails(row.id)}
        />
      ) : null}
      {row.menuActions.length ? (
        <Menu>
          <Tooltip content={t("More actions for {name}", { name: row.name })}>
            <MenuTrigger asChild>
              <IconButton
                className="plugin-table-icon-action"
                disabled={rowBusy}
                icon={MoreHorizontal}
                label={t("More actions for {name}", { name: row.name })}
                size="sm"
                tooltip=""
              />
            </MenuTrigger>
          </Tooltip>
          <MenuContent align="end" className="plugin-row-menu">
            {row.menuActions.map((action, index) => (
              <Fragment key={action.id}>
                {action.id === "uninstall" && index > 0 ? <MenuSeparator /> : null}
                <MenuItem
                  tone={action.tone === "danger" ? "danger" : "default"}
                  onSelect={() => runPluginAction(action.id, row.id, handlers)}
                >
                  {pluginActionIcon(action.id)}
                  {action.label}
                </MenuItem>
              </Fragment>
            ))}
          </MenuContent>
        </Menu>
      ) : null}
    </div>
  );
}

function PluginIconAction({
  action,
  busy,
  disabled,
  onClick,
}: {
  readonly action: PluginActionView;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): React.JSX.Element {
  return (
    <IconButton
      className="plugin-table-icon-action"
      disabled={disabled}
      icon={pluginActionIconComponent(action.id)}
      label={action.label}
      loading={busy}
      onClick={onClick}
      size="sm"
    />
  );
}

export function runPluginAction(action: PluginActionId, pluginId: string, handlers: PluginActionHandlers): void {
  if (action === "connect-chrome") return handlers.onOpenChromeConnect(pluginId);
  if (action === "revoke-chrome") return handlers.onRevokeChrome(pluginId);
  if (action === "guide") return handlers.onOpenInstallGuide(pluginId);
  if (action === "details") return handlers.onOpenDetails(pluginId);
  if (action === "apply") return handlers.onApplyPreset(pluginId);
  if (action === "check") return handlers.onCheck(pluginId);
  if (action === "validate") return handlers.onValidatePackage(pluginId);
  if (action === "install") return handlers.onInstall(pluginId);
  if (action === "uninstall") return handlers.onRequestUninstall(pluginId);
  if (action === "refresh-package") return handlers.onRefreshPackage(pluginId);
  if (action === "runtime-preview") return handlers.onRuntimePreview(pluginId);
  if (action === "enable") return handlers.onEnable(pluginId);
  handlers.onDisable(pluginId);
}

export function pluginActionIcon(action: PluginActionId): React.JSX.Element {
  const ActionIcon = pluginActionIconComponent(action);
  return <ActionIcon aria-hidden="true" />;
}

function pluginActionIconComponent(action: PluginActionId): LucideIcon {
  if (action === "connect-chrome") return Globe2;
  if (action === "revoke-chrome") return Unplug;
  if (action === "apply") return Wrench;
  if (action === "guide" || action === "install") return Download;
  if (action === "check" || action === "refresh-package") return RefreshCw;
  if (action === "enable") return Power;
  if (action === "disable") return PowerOff;
  if (action === "details") return ChevronRight;
  if (action === "validate") return ShieldCheck;
  return Trash2;
}

function actionIsBusy(action: PluginActionId, busyAction: PluginBusyAction | undefined): boolean {
  if (!busyAction) return false;
  if (action === "guide") return busyAction === "connect";
  if (action === "connect-chrome") return busyAction === "pairing";
  if (action === "revoke-chrome") return busyAction === "revoke";
  return action === busyAction;
}
