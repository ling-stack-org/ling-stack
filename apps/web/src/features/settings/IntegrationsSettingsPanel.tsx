import { useState } from "react";
import type {
  Channel,
  ExternalWorkStatusResponse,
  ManagedPluginApplyPresetResponse,
  ManagedPluginRuntimePreviewResponse,
  ManagedPluginView,
  McpServer,
  McpServerFormState,
  McpTool,
} from "../../types.js";
import type { McpBusyAction } from "../../domains/mcp/use-mcp-domain.js";
import type { PluginActionNotice, PluginBusyAction } from "../../domains/plugins/use-plugins-domain.js";
import { McpToolsPage } from "../mcp/McpToolsPage.js";
import { ExternalWorkSettingsPanel } from "./ExternalWorkSettingsPanel.js";
import { PluginManagerSettingsPanel } from "./PluginManagerSettingsPanel.js";
import { SettingsSubnav } from "./SettingsSubnav.js";

type IntegrationSubsectionId = "external-work" | "mcp" | "plugins";

export function IntegrationsSettingsPanel({
  cwd,
  selectedChannel,
  externalWorkStatus,
  externalWorkStatusLoading,
  externalWorkStatusAction,
  externalWorkSecretAction,
  externalWorkWorkflowAction,
  mcpServers,
  mcpTools,
  mcpLoading,
  mcpBusyServerId,
  mcpBusyAction,
  plugins,
  pluginsLoading,
  pluginBusyId,
  pluginBusyAction,
  latestPluginApplyResult,
  latestPluginRuntimePreview,
  latestPluginNotice,
  errorMessage,
  onRefreshExternalWork,
  onExternalWorkAction,
  onConfigureExternalWorkWorkflow,
  onConfigureExternalWorkSecret,
  onDeleteExternalWorkSecret,
  onOpenExternalWorkRecords,
  onOpenExternalWorkTriage,
  onRefreshMcp,
  onCreateMcpServer,
  onUpdateMcpServer,
  onDeleteMcpServer,
  onCheckMcpServer,
  onSyncMcpTools,
  onRefreshPlugins,
  onApplyPluginPreset,
  onCheckPlugin,
  onValidatePluginPackage,
  onInstallPlugin,
  onUninstallPlugin,
  onRefreshPluginPackage,
  onPreviewPluginRuntime,
  onEnablePlugin,
  onDisablePlugin,
}: {
  readonly cwd: string;
  readonly selectedChannel: Channel | undefined;
  readonly externalWorkStatus: ExternalWorkStatusResponse | undefined;
  readonly externalWorkStatusLoading: boolean;
  readonly externalWorkStatusAction: "poll" | "reconcile" | "start" | "stop" | undefined;
  readonly externalWorkSecretAction: "configure" | "delete" | undefined;
  readonly externalWorkWorkflowAction: "configure" | undefined;
  readonly mcpServers: readonly McpServer[];
  readonly mcpTools: readonly McpTool[];
  readonly mcpLoading: boolean;
  readonly mcpBusyServerId: string;
  readonly mcpBusyAction: McpBusyAction | undefined;
  readonly plugins: readonly ManagedPluginView[];
  readonly pluginsLoading: boolean;
  readonly pluginBusyId: string;
  readonly pluginBusyAction: PluginBusyAction | undefined;
  readonly latestPluginApplyResult?: ManagedPluginApplyPresetResponse;
  readonly latestPluginRuntimePreview?: ManagedPluginRuntimePreviewResponse;
  readonly latestPluginNotice?: PluginActionNotice;
  readonly errorMessage: string;
  readonly onRefreshExternalWork: () => void;
  readonly onExternalWorkAction: (action: "poll" | "reconcile" | "start" | "stop") => void;
  readonly onConfigureExternalWorkWorkflow: (input: {
    readonly sourceKind: "github" | "linear";
    readonly repository?: string;
    readonly projectSlug?: string;
  }) => Promise<void>;
  readonly onConfigureExternalWorkSecret: (token: string) => Promise<void>;
  readonly onDeleteExternalWorkSecret: () => Promise<void>;
  readonly onOpenExternalWorkRecords: () => void;
  readonly onOpenExternalWorkTriage: () => void;
  readonly onRefreshMcp: () => void;
  readonly onCreateMcpServer: (form: McpServerFormState) => Promise<void>;
  readonly onUpdateMcpServer: (serverId: string, form: McpServerFormState) => Promise<void>;
  readonly onDeleteMcpServer: (serverId: string) => void;
  readonly onCheckMcpServer: (serverId: string) => boolean | Promise<boolean> | void | Promise<void>;
  readonly onSyncMcpTools: (serverId: string) => boolean | Promise<boolean> | void | Promise<void>;
  readonly onRefreshPlugins: () => void;
  readonly onApplyPluginPreset: (pluginId: string) => void;
  readonly onCheckPlugin: (pluginId: string) => void;
  readonly onValidatePluginPackage: (pluginId: string) => void;
  readonly onInstallPlugin: (pluginId: string) => void;
  readonly onUninstallPlugin: (pluginId: string) => void;
  readonly onRefreshPluginPackage: (pluginId: string) => void;
  readonly onPreviewPluginRuntime: (pluginId: string) => void;
  readonly onEnablePlugin: (pluginId: string) => void;
  readonly onDisablePlugin: (pluginId: string) => void;
}): JSX.Element {
  const [activeSubsection, setActiveSubsection] = useState<IntegrationSubsectionId>("external-work");

  return (
    <div className="settings-section-stack">
      <SettingsSubnav
        label="Connection sections"
        activeId={activeSubsection}
        onChange={(id) => setActiveSubsection(id as IntegrationSubsectionId)}
        options={[
          {
            id: "external-work",
            label: "Work intake",
            description: "Connect GitHub or Linear work intake for the selected channel.",
            badge: selectedChannel?.boundPath ? "Ready" : "Needs setup",
          },
          {
            id: "mcp",
            label: "Tool servers",
            description: "Manage MCP tool servers and sync tool access for AI teammates.",
            badge: `${mcpServers.length}`,
          },
          {
            id: "plugins",
            label: "Plugin bundles",
            description: "Manage trusted local presets and bundled capability packages.",
            badge: `${plugins.length}`,
          },
        ]}
      />

      {activeSubsection === "external-work" ? (
        <ExternalWorkSettingsPanel
          selectedChannel={selectedChannel}
          externalWorkStatus={externalWorkStatus}
          externalWorkStatusLoading={externalWorkStatusLoading}
          externalWorkStatusAction={externalWorkStatusAction}
          externalWorkSecretAction={externalWorkSecretAction}
          externalWorkWorkflowAction={externalWorkWorkflowAction}
          onRefreshExternalWork={onRefreshExternalWork}
          onExternalWorkAction={onExternalWorkAction}
          onConfigureExternalWorkWorkflow={onConfigureExternalWorkWorkflow}
          onConfigureExternalWorkSecret={onConfigureExternalWorkSecret}
          onDeleteExternalWorkSecret={onDeleteExternalWorkSecret}
          onOpenExternalWorkRecords={onOpenExternalWorkRecords}
          onOpenExternalWorkTriage={onOpenExternalWorkTriage}
        />
      ) : null}

      {activeSubsection === "mcp" ? (
        <McpToolsPage
          servers={mcpServers}
          tools={mcpTools}
          isLoading={mcpLoading}
          busyServerId={mcpBusyServerId}
          busyAction={mcpBusyAction}
          errorMessage={errorMessage}
          cwd={cwd}
          onRefresh={onRefreshMcp}
          onCreate={onCreateMcpServer}
          onUpdate={onUpdateMcpServer}
          onDelete={onDeleteMcpServer}
          onCheck={onCheckMcpServer}
          onSyncTools={onSyncMcpTools}
        />
      ) : null}

      {activeSubsection === "plugins" ? (
        <PluginManagerSettingsPanel
          cwd={cwd}
          plugins={plugins}
          isLoading={pluginsLoading}
          busyPluginId={pluginBusyId}
          busyAction={pluginBusyAction}
          latestApplyResult={latestPluginApplyResult}
          latestRuntimePreview={latestPluginRuntimePreview}
          latestNotice={latestPluginNotice}
          onRefresh={onRefreshPlugins}
          onApplyPreset={onApplyPluginPreset}
          onCheck={onCheckPlugin}
          onValidatePackage={onValidatePluginPackage}
          onInstall={onInstallPlugin}
          onUninstall={onUninstallPlugin}
          onRefreshPackage={onRefreshPluginPackage}
          onRuntimePreview={onPreviewPluginRuntime}
          onEnable={onEnablePlugin}
          onDisable={onDisablePlugin}
          onOpenMcpSettings={() => {
            onRefreshMcp();
            setActiveSubsection("mcp");
          }}
        />
      ) : null}
    </div>
  );
}
