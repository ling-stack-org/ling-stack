import { useState } from "react";
import type { ChannelSidePanelView } from "./workspace-client-view.types.js";

/** Local panel state and shared transitions; domain refreshes and dock requests stay with their controllers. */
export function useChannelPanelNavigation(initialTaskSelected: boolean) {
  const [createTaskOpen, setCreateTaskOpen] = useState(false);
  const [sidePanelView, setSidePanelView] = useState<ChannelSidePanelView>(() => initialTaskSelected ? "task" : "context");
  const [sidePanelOpen, setSidePanelOpen] = useState(initialTaskSelected);
  const [channelSettingsPageOpen, setChannelSettingsPageOpen] = useState(false);
  const [channelEnvironmentPageOpen, setChannelEnvironmentPageOpen] = useState(false);
  const [channelMoreOpen, setChannelMoreOpen] = useState(false);
  const [progressPopoverOpen, setProgressPopoverOpen] = useState(false);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [teammateManagerOpen, setTeammateManagerOpen] = useState(false);

  function closeAuxiliaryPanels(): void {
    setChannelMoreOpen(false);
    setWorkspaceSettingsOpen(false);
    setTeammateManagerOpen(false);
  }
  function openUtilityPage(page: "settings" | "environment"): void {
    setChannelSettingsPageOpen(page === "settings");
    setChannelEnvironmentPageOpen(page === "environment");
    setSidePanelOpen(false);
    setCreateTaskOpen(false);
    setProgressPopoverOpen(false);
    closeAuxiliaryPanels();
  }
  function prepareDock(view: ChannelSidePanelView): void {
    setSidePanelView(view);
    setSidePanelOpen(true);
    setChannelSettingsPageOpen(false);
    setChannelEnvironmentPageOpen(false);
    closeAuxiliaryPanels();
  }
  return { createTaskOpen, setCreateTaskOpen, sidePanelView, setSidePanelView, sidePanelOpen, setSidePanelOpen,
    channelSettingsPageOpen, setChannelSettingsPageOpen, channelEnvironmentPageOpen, setChannelEnvironmentPageOpen,
    channelMoreOpen, setChannelMoreOpen, progressPopoverOpen, setProgressPopoverOpen,
    workspaceSettingsOpen, setWorkspaceSettingsOpen, teammateManagerOpen, setTeammateManagerOpen,
    openUtilityPage, prepareDock };
}
