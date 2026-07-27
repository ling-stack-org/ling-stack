import { ExternalLink, MoreHorizontal, Plug } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  InlineFeedback,
  InspectorSection,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  StatusIndicator,
} from "../../shared/ui/index.js";
import { useI18n } from "../../i18n.js";
import type { ManagedPluginView } from "../../types.js";
import type { PluginBusyAction } from "../../domains/plugins/use-plugins-domain.js";
import { buildPluginDetailView } from "./plugin-manager-detail-view-model.js";
import type { PluginManagerCopy } from "./plugin-manager-copy.js";
import type { PluginActionFailure, PluginActionHandlers, PluginRowView } from "./plugin-manager-types.js";
import { pluginActionIcon, runPluginAction } from "./PluginRowActions.js";
import { PluginRuntimePreviewSection } from "./PluginRuntimePreviewSection.js";
import { PluginTechnicalDetails } from "./PluginTechnicalDetails.js";

export function PluginDetailDrawer({
  plugin,
  row,
  copy,
  busyPluginId,
  busyAction,
  actionFailure,
  handlers,
  onOpenMcpSettings,
  onClose,
}: {
  readonly plugin?: ManagedPluginView;
  readonly row?: PluginRowView;
  readonly copy: PluginManagerCopy;
  readonly busyPluginId: string;
  readonly busyAction: PluginBusyAction | undefined;
  readonly actionFailure?: PluginActionFailure;
  readonly handlers: PluginActionHandlers;
  readonly onOpenMcpSettings: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const open = Boolean(plugin && row);
  const busy = Boolean(plugin && busyPluginId === plugin.id && busyAction);

  useEffect(() => {
    if (!open) setRuntimeOpen(false);
  }, [open]);

  const view = plugin && row ? buildPluginDetailView(plugin, row, copy, t) : undefined;
  return (
    <Drawer busy={busy} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }} open={open}>
      <DrawerContent
        ref={drawerRef}
        className="plugin-detail-panel"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          drawerRef.current?.focus();
        }}
        size="lg"
      >
        {plugin && row && view ? (
          <>
            <DrawerHeader
              closeLabel={t("Close")}
              description={view.sourceVersion}
              title={(
                <span className="plugin-detail-title">
                  <Plug aria-hidden="true" />
                  <span>{plugin.displayName}</span>
                  <StatusIndicator label={row.primaryState.label} tone={row.primaryState.tone} />
                </span>
              )}
            />
            <DrawerBody className="plugin-detail-body">
              {actionFailure ? (
                <InlineFeedback
                  className="plugin-detail-action-failure"
                  data-plugin-action-failure={actionFailure.action}
                  title={actionFailure.message}
                  tone="danger"
                >
                  <Button
                    loading={busy}
                    loadingLabel={t("Loading")}
                    onClick={() => runPluginAction(actionFailure.action, plugin.id, handlers)}
                    size="sm"
                  >
                    {t("Retry")}
                  </Button>
                </InlineFeedback>
              ) : null}
              {view.failureReason ? (
                <InlineFeedback className="plugin-detail-failure" title={t("Failure reason")} tone="danger">
                  <span>{view.failureReason}</span>
                  {view.repairHint ? <span className="plugin-detail-repair-hint">{view.repairHint}</span> : null}
                </InlineFeedback>
              ) : null}
              {view.description ? <p className="plugin-detail-description">{view.description}</p> : null}
              <dl className="plugin-detail-fields plugin-detail-overview">
                {view.overviewFields.map((field) => (
                  <div key={field.label}>
                    <dt>{field.label}</dt>
                    <dd>{field.value}</dd>
                  </div>
                ))}
              </dl>
              <InspectorSection summary={view.capabilitySummary} title={t("Capabilities")}>
                {view.capabilities.length ? (
                  <div className="plugin-capability-list">
                    {view.capabilities.map((capability) => (
                      <div className="plugin-capability-row" key={capability.id}>
                        <span>
                          <strong>{capability.label}</strong>
                          <small>{capability.kind}</small>
                        </span>
                        <StatusIndicator
                          compact
                          label={capability.enabled ? t("Enabled status") : t("Disabled")}
                          tone={capability.enabled ? "success" : "neutral"}
                        />
                      </div>
                    ))}
                  </div>
                ) : <span className="plugin-detail-empty">{t("No linked resources")}</span>}
              </InspectorSection>
              <PluginRuntimePreviewSection
                busy={busyAction === "runtime-preview" && busyPluginId === plugin.id}
                canEnable={plugin.actions.canEnable}
                canPreview={plugin.actions.canRuntimePreview}
                onEnable={() => handlers.onEnable(plugin.id)}
                onOpenChange={setRuntimeOpen}
                onPreview={() => {
                  setRuntimeOpen(true);
                  handlers.onRuntimePreview(plugin.id);
                }}
                open={runtimeOpen}
                runtime={view.runtime}
                t={t}
              />
              <InspectorSection summary={t("Trust")} title={copy.trustAndPermissions}>
                <p className="plugin-trust-summary">{view.trustSummary}</p>
                {view.trustFields.length ? (
                  <dl className="plugin-detail-fields">
                    {view.trustFields.map((field, index) => (
                      <div key={`${field.label}-${index}`}>
                        <dt>{field.label}</dt>
                        <dd>{field.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </InspectorSection>
              <PluginTechnicalDetails fields={view.technicalFields} t={t} />
              {view.hasLinkedMcp ? (
                <Button
                  className="plugin-detail-mcp-link"
                  leadingIcon={<ExternalLink aria-hidden="true" />}
                  onClick={() => {
                    onClose();
                    onOpenMcpSettings();
                  }}
                  size="sm"
                >
                  {t("Open MCP connection")}
                </Button>
              ) : null}
            </DrawerBody>
            {(row.primaryAction && !["details", "guide"].includes(row.primaryAction.id)) || row.menuActions.length ? (
              <DrawerFooter className="plugin-detail-footer">
                {row.primaryAction && !["details", "guide"].includes(row.primaryAction.id) ? (
                  <Button
                    leadingIcon={pluginActionIcon(row.primaryAction.id)}
                    loading={Boolean(busyAction && busyPluginId === plugin.id)}
                    loadingLabel={t("Loading")}
                    onClick={() => runPluginAction(row.primaryAction?.id ?? "details", plugin.id, handlers)}
                    size="sm"
                  >
                    {row.primaryAction.label}
                  </Button>
                ) : null}
                {row.menuActions.length ? (
                  <Menu>
                    <MenuTrigger asChild>
                      <Button leadingIcon={<MoreHorizontal aria-hidden="true" />} size="sm">{t("More actions")}</Button>
                    </MenuTrigger>
                    <MenuContent align="end">
                      {row.menuActions.map((action, index) => (
                        <Fragment key={action.id}>
                          {action.id === "uninstall" && index > 0 ? <MenuSeparator /> : null}
                          <MenuItem
                            tone={action.tone === "danger" ? "danger" : "default"}
                            onSelect={() => runPluginAction(action.id, plugin.id, handlers)}
                          >
                            {pluginActionIcon(action.id)}
                            {action.label}
                          </MenuItem>
                        </Fragment>
                      ))}
                    </MenuContent>
                  </Menu>
                ) : null}
              </DrawerFooter>
            ) : null}
          </>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}
