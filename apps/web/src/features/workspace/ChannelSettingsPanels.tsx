import { useEffect, useState, type ReactNode } from "react";
import { Tabs, TabsContent } from "../../shared/ui/index.js";
import type {
  AiCouncil,
  AiCouncilHealthReport,
  ChannelCouncilPolicy,
  ChannelFormState,
  ChannelWorkspaceBinding,
  ChannelWorkspaceMode,
  EffectiveChannelCouncilProjection,
  ProviderPreset,
} from "../../types.js";
import type { LocalTeammateDraft } from "../teammates/index.js";
import { ChannelCouncilSettingsPanel } from "./ChannelCouncilSettingsPanel.js";
import { ChannelSettingsGeneralPanel, type ChannelNotificationLevel } from "./ChannelSettingsGeneralPanel.js";
import { ChannelSettingsNavigation, type ChannelSettingsSection } from "./ChannelSettingsNavigation.js";
import { ChannelSettingsWorkspacePanel } from "./ChannelSettingsWorkspacePanel.js";
import { ChannelTeammateManagerPanel } from "./ChannelTeammateManagerPanel.js";

export type { ChannelNotificationLevel } from "./ChannelSettingsGeneralPanel.js";
export { channelWorkspaceModeIcon, channelWorkspaceModeLabel, shortWorkspacePath } from "./ChannelSettingsWorkspacePanel.js";
export { ChannelTeammateManagerPanel } from "./ChannelTeammateManagerPanel.js";
export { isLingAgentTeammate } from "./ChannelCouncilSettingsPanel.js";

export function ChannelSettingsPanels({
  cwd,
  selectedChannelId,
  channelNotificationLevel,
  onUpdateChannelNotificationLevel,
  channelTeammateMembershipsLoading,
  channelTeammates,
  localTeammates,
  availableChannelTeammates,
  pendingChannelTeammateId,
  channelTeammateSavingId,
  onPendingChannelTeammateIdChange,
  onAddSelectedChannelTeammate,
  onRemoveChannelTeammate,
  onOpenTeammates,
  aiCouncils,
  aiCouncilsLoading,
  aiCouncilHealthReport,
  channelCouncilPolicy,
  channelEffectiveCouncil,
  channelCouncilLoading,
  channelCouncilSaving,
  attachedAiCouncils,
  availableAiCouncils,
  projectedCouncilSpecialists,
  pendingChannelCouncilId,
  onPendingChannelCouncilIdChange,
  onAddSelectedChannelCouncil,
  onRemoveChannelCouncil,
  onSetPreferredChannelCouncil,
  onRefreshAiCouncils,
  onRefreshChannelCouncil,
  channelTeamMetricsPanel,
  channelEditForm,
  onChannelEditFormChange,
  onSaveChannelName,
  onChangeChannelWorkspacePath,
  providersLoading,
  providers,
  taskReadyProviders,
  setupChatProviders,
  selectedChannelWorkspace,
  selectedChannelExecutionPath,
  channelWorkspaceBusyAction,
  channelWorkspaceExternalPath,
  channelWorkspaceError,
  onChannelWorkspaceExternalPathChange,
  onCreateManagedChannelWorktree,
  onRefreshChannelWorkspace,
  onOpenChannelWorkspacePath,
  onHandoffChannelWorkspace,
}: {
  readonly cwd: string;
  readonly selectedChannelId: string;
  readonly channelNotificationLevel: ChannelNotificationLevel;
  readonly onUpdateChannelNotificationLevel: (level: ChannelNotificationLevel) => void;
  readonly channelTeammateMembershipsLoading: boolean;
  readonly channelTeammates: readonly { readonly teammate: LocalTeammateDraft }[];
  readonly localTeammates: readonly LocalTeammateDraft[];
  readonly availableChannelTeammates: readonly LocalTeammateDraft[];
  readonly pendingChannelTeammateId: string;
  readonly channelTeammateSavingId: string;
  readonly onPendingChannelTeammateIdChange: (value: string) => void;
  readonly onAddSelectedChannelTeammate: () => void;
  readonly onRemoveChannelTeammate: (teammateId: string) => void | Promise<void>;
  readonly onOpenTeammates: () => void;
  readonly aiCouncils: readonly AiCouncil[];
  readonly aiCouncilsLoading: boolean;
  readonly aiCouncilHealthReport: AiCouncilHealthReport | undefined;
  readonly channelCouncilPolicy: ChannelCouncilPolicy | undefined;
  readonly channelEffectiveCouncil: EffectiveChannelCouncilProjection | undefined;
  readonly channelCouncilLoading: boolean;
  readonly channelCouncilSaving: boolean;
  readonly attachedAiCouncils: readonly AiCouncil[];
  readonly availableAiCouncils: readonly AiCouncil[];
  readonly projectedCouncilSpecialists: readonly EffectiveChannelCouncilProjection["specialists"][number][];
  readonly pendingChannelCouncilId: string;
  readonly onPendingChannelCouncilIdChange: (value: string) => void;
  readonly onAddSelectedChannelCouncil: () => void;
  readonly onRemoveChannelCouncil: (councilId: string) => void;
  readonly onSetPreferredChannelCouncil: (councilId: string) => void;
  readonly onRefreshAiCouncils: () => void;
  readonly onRefreshChannelCouncil: () => void;
  readonly channelTeamMetricsPanel: ReactNode;
  readonly channelEditForm: ChannelFormState;
  readonly onChannelEditFormChange: (form: ChannelFormState) => void;
  readonly onSaveChannelName: (name: string) => Promise<void>;
  readonly onChangeChannelWorkspacePath: (path: string) => Promise<void>;
  readonly providersLoading: boolean;
  readonly providers: readonly ProviderPreset[];
  readonly taskReadyProviders: readonly ProviderPreset[];
  readonly setupChatProviders: readonly ProviderPreset[];
  readonly selectedChannelWorkspace: ChannelWorkspaceBinding | undefined;
  readonly selectedChannelExecutionPath: string;
  readonly channelWorkspaceBusyAction: string;
  readonly channelWorkspaceExternalPath: string;
  readonly channelWorkspaceError: string;
  readonly onChannelWorkspaceExternalPathChange: (value: string) => void;
  readonly onCreateManagedChannelWorktree: () => void;
  readonly onRefreshChannelWorkspace: () => void;
  readonly onOpenChannelWorkspacePath: () => void;
  readonly onHandoffChannelWorkspace: (mode: ChannelWorkspaceMode) => void;
}): JSX.Element {
  const [activeSection, setActiveSection] = useState<ChannelSettingsSection>("general");

  useEffect(() => {
    setActiveSection("general");
  }, [selectedChannelId]);

  return (
    <Tabs
      className="channel-settings-stack"
      value={activeSection}
      onValueChange={(value) => setActiveSection(value as ChannelSettingsSection)}
      orientation="horizontal"
    >
      <ChannelSettingsNavigation />
      <div className="channel-settings-tab-content">
        <TabsContent
          id="channel-settings-panel-general"
          className="channel-settings-tab-panel channel-settings-general-panel"
          aria-labelledby="channel-settings-tab-general"
          data-channel-settings-section="general"
          value="general"
        >
          <ChannelSettingsGeneralPanel
            selectedChannelId={selectedChannelId}
            channelNotificationLevel={channelNotificationLevel}
            onUpdateChannelNotificationLevel={onUpdateChannelNotificationLevel}
            channelEditForm={channelEditForm}
            onChannelEditFormChange={onChannelEditFormChange}
            onSaveChannelName={onSaveChannelName}
            providersLoading={providersLoading}
            providers={providers}
            taskReadyProviders={taskReadyProviders}
            setupChatProviders={setupChatProviders}
          />
        </TabsContent>

        <TabsContent
          id="channel-settings-panel-workspace"
          className="channel-settings-tab-panel channel-settings-workspace-panel"
          aria-labelledby="channel-settings-tab-workspace"
          data-channel-settings-section="workspace"
          value="workspace"
        >
          <ChannelSettingsWorkspacePanel
            cwd={cwd}
            selectedChannelId={selectedChannelId}
            channelEditForm={channelEditForm}
            onChannelEditFormChange={onChannelEditFormChange}
            onChangeChannelWorkspacePath={onChangeChannelWorkspacePath}
            selectedChannelWorkspace={selectedChannelWorkspace}
            selectedChannelExecutionPath={selectedChannelExecutionPath}
            channelWorkspaceBusyAction={channelWorkspaceBusyAction}
            channelWorkspaceExternalPath={channelWorkspaceExternalPath}
            channelWorkspaceError={channelWorkspaceError}
            onChannelWorkspaceExternalPathChange={onChannelWorkspaceExternalPathChange}
            onCreateManagedChannelWorktree={onCreateManagedChannelWorktree}
            onRefreshChannelWorkspace={onRefreshChannelWorkspace}
            onOpenChannelWorkspacePath={onOpenChannelWorkspacePath}
            onHandoffChannelWorkspace={onHandoffChannelWorkspace}
          />
        </TabsContent>

        <TabsContent
          id="channel-settings-panel-members"
          className="channel-settings-tab-panel channel-settings-members-panel"
          aria-labelledby="channel-settings-tab-members"
          data-channel-settings-section="members"
          value="members"
        >
          <ChannelTeammateManagerPanel
            cwd={cwd}
            selectedChannelId={selectedChannelId}
            channelTeammateMembershipsLoading={channelTeammateMembershipsLoading}
            channelTeammates={channelTeammates}
            localTeammates={localTeammates}
            availableChannelTeammates={availableChannelTeammates}
            pendingChannelTeammateId={pendingChannelTeammateId}
            channelTeammateSavingId={channelTeammateSavingId}
            onPendingChannelTeammateIdChange={onPendingChannelTeammateIdChange}
            onAddSelectedChannelTeammate={onAddSelectedChannelTeammate}
            onRemoveChannelTeammate={onRemoveChannelTeammate}
            onOpenTeammates={onOpenTeammates}
          />
        </TabsContent>

        <TabsContent
          id="channel-settings-panel-councils"
          className="channel-settings-tab-panel channel-settings-councils-panel"
          aria-labelledby="channel-settings-tab-councils"
          data-channel-settings-section="councils"
          value="councils"
        >
          <ChannelCouncilSettingsPanel
            cwd={cwd}
            selectedChannelId={selectedChannelId}
            aiCouncils={aiCouncils}
            aiCouncilsLoading={aiCouncilsLoading}
            aiCouncilHealthReport={aiCouncilHealthReport}
            channelCouncilPolicy={channelCouncilPolicy}
            channelEffectiveCouncil={channelEffectiveCouncil}
            channelCouncilLoading={channelCouncilLoading}
            channelCouncilSaving={channelCouncilSaving}
            attachedAiCouncils={attachedAiCouncils}
            availableAiCouncils={availableAiCouncils}
            projectedCouncilSpecialists={projectedCouncilSpecialists}
            pendingChannelCouncilId={pendingChannelCouncilId}
            onPendingChannelCouncilIdChange={onPendingChannelCouncilIdChange}
            onAddSelectedChannelCouncil={onAddSelectedChannelCouncil}
            onRemoveChannelCouncil={onRemoveChannelCouncil}
            onSetPreferredChannelCouncil={onSetPreferredChannelCouncil}
            onRefreshAiCouncils={onRefreshAiCouncils}
            onRefreshChannelCouncil={onRefreshChannelCouncil}
          />
        </TabsContent>

        <TabsContent
          id="channel-settings-panel-health"
          className="channel-settings-tab-panel channel-settings-health-panel"
          aria-labelledby="channel-settings-tab-health"
          data-channel-settings-section="health"
          value="health"
        >
          {channelTeamMetricsPanel}
        </TabsContent>
      </div>
    </Tabs>
  );
}
