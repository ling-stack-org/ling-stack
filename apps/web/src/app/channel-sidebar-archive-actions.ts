import { createChannelBranch, deleteChannel, patchChannel, updateChannelBranch } from "../api.js";
import type { Channel, ChannelBranch } from "../types.js";
import { channelSidebarTarget, type SidebarTarget, type ViewId } from "./view-types.js";

type StateSetter<T> = (value: T | ((current: T) => T)) => void;

interface ChannelSidebarArchiveInput {
  readonly cwd: string;
  readonly channels: readonly Channel[];
  readonly selectedChannelId: string;
  readonly setActiveView: StateSetter<ViewId>;
  readonly setActiveSidebarTarget: StateSetter<SidebarTarget>;
  readonly setSelectedChannelId: StateSetter<string>;
  readonly setSelectedChannelBranchId: StateSetter<string>;
  readonly setChannels: StateSetter<readonly Channel[]>;
  readonly setChannelBranches: StateSetter<readonly ChannelBranch[]>;
  readonly setErrorMessage: (message: string) => void;
  readonly refreshChannels: (cwd?: string) => Promise<void>;
}

export async function archiveSidebarChannelWithState(
  input: ChannelSidebarArchiveInput & {
    readonly channelId: string;
    readonly activeSidebarTarget: SidebarTarget;
  },
): Promise<void> {
  const channel = input.channels.find((item) => item.id === input.channelId);
  if (!input.cwd || !channel) {
    return;
  }
  try {
    input.setErrorMessage("");
    await patchChannel(input.cwd, input.channelId, { status: "archived" });
    input.setChannels((current) => current.filter((item) => item.id !== input.channelId));
    input.setChannelBranches((current) => current.filter((branch) => branch.channelId !== input.channelId));
    if (input.selectedChannelId === input.channelId) {
      input.setSelectedChannelId("");
      input.setSelectedChannelBranchId("");
      input.setActiveSidebarTarget("workspace");
    }
    if (input.activeSidebarTarget === channelSidebarTarget(input.channelId)) {
      input.setActiveSidebarTarget("workspace");
    }
    await input.refreshChannels(input.cwd);
  } catch (error) {
    input.setErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

export async function createSidebarChannelBranchWithState(input: {
  readonly cwd: string;
  readonly channelId: string;
  readonly name: string;
  readonly setActiveView: StateSetter<ViewId>;
  readonly setActiveSidebarTarget: StateSetter<SidebarTarget>;
  readonly setSelectedChannelId: StateSetter<string>;
  readonly setSelectedChannelBranchId: StateSetter<string>;
  readonly setChannelBranches: StateSetter<readonly ChannelBranch[]>;
  readonly setErrorMessage: (message: string) => void;
  readonly refreshChannels: (cwd?: string) => Promise<void>;
}): Promise<void> {
  if (!input.cwd) {
    input.setErrorMessage("本地工作区未就绪");
    return;
  }
  try {
    input.setErrorMessage("");
    const response = await createChannelBranch(input.cwd, input.channelId, { name: input.name, status: "active" });
    input.setChannelBranches((current) => [
      response.branch,
      ...current.filter((branch) => branch.id !== response.branch.id),
    ]);
    input.setSelectedChannelId(input.channelId);
    input.setSelectedChannelBranchId(response.branch.id);
    input.setActiveView("workspace");
    input.setActiveSidebarTarget(channelSidebarTarget(input.channelId));
    await input.refreshChannels(input.cwd);
  } catch (error) {
    input.setErrorMessage(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function archiveAllSidebarChannelsWithState(
  input: ChannelSidebarArchiveInput & {
    readonly confirmMessage: string;
    readonly confirm: (message: string) => boolean;
  },
): Promise<void> {
  const activeChannels = input.channels.filter((channel) => channel.status !== "archived");
  if (!input.cwd || activeChannels.length === 0 || !input.confirm(input.confirmMessage)) {
    return;
  }
  const archivedChannelIds = new Set(activeChannels.map((channel) => channel.id));
  try {
    input.setErrorMessage("");
    await Promise.all(activeChannels.map((channel) => patchChannel(input.cwd, channel.id, { status: "archived" })));
    input.setChannels((current) => current.filter((channel) => !archivedChannelIds.has(channel.id)));
    input.setChannelBranches((current) => current.filter((branch) => !archivedChannelIds.has(branch.channelId)));
    if (input.selectedChannelId && archivedChannelIds.has(input.selectedChannelId)) {
      input.setSelectedChannelId("");
      input.setSelectedChannelBranchId("");
      input.setActiveView("workspace");
      input.setActiveSidebarTarget("workspace");
    }
    await input.refreshChannels(input.cwd);
  } catch (error) {
    input.setErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

export async function archiveSidebarChannelBranchWithState(input: {
  readonly cwd: string;
  readonly channelId: string;
  readonly branchId: string;
  readonly setChannelBranches: StateSetter<readonly ChannelBranch[]>;
  readonly setErrorMessage: (message: string) => void;
  readonly refreshChannels: (cwd?: string) => Promise<void>;
}): Promise<void> {
  if (!input.cwd) {
    return;
  }
  try {
    input.setErrorMessage("");
    await updateChannelBranch(input.cwd, input.channelId, input.branchId, { status: "archived" });
    input.setChannelBranches((current) => current.filter((branch) => branch.id !== input.branchId));
    await input.refreshChannels(input.cwd);
  } catch (error) {
    input.setErrorMessage(error instanceof Error ? error.message : String(error));
  }
}

export async function removeSidebarChannelWithState(input: {
  readonly cwd: string;
  readonly channelId: string;
  readonly selectedChannelId: string;
  readonly activeSidebarTarget: SidebarTarget;
  readonly setActiveSidebarTarget: StateSetter<SidebarTarget>;
  readonly setSelectedChannelId: StateSetter<string>;
  readonly setErrorMessage: (message: string) => void;
  readonly refreshChannels: (cwd?: string) => Promise<void>;
}): Promise<void> {
  try {
    input.setErrorMessage("");
    await deleteChannel(input.cwd, input.channelId);
    if (input.selectedChannelId === input.channelId) {
      input.setSelectedChannelId("");
    }
    if (input.activeSidebarTarget === channelSidebarTarget(input.channelId)) {
      input.setActiveSidebarTarget("workspace");
    }
    await input.refreshChannels();
  } catch (error) {
    input.setErrorMessage(error instanceof Error ? error.message : String(error));
  }
}
