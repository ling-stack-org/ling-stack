import type { Dispatch, SetStateAction } from "react";
import { channelToForm } from "../lib/channels.js";
import type {
  Channel,
  ChannelFormState,
  RunFormState,
} from "../types.js";

export interface ProviderUsageController {
  readonly clearProviderUsage: (providerId: string) => Promise<void>;
}

export function useProviderUsageController(input: {
  readonly form: RunFormState;
  readonly taskRunProviderId: string;
  readonly channels: readonly Channel[];
  readonly setForm: Dispatch<SetStateAction<RunFormState>>;
  readonly setTaskRunProviderId: Dispatch<SetStateAction<string>>;
  readonly setChannels: Dispatch<SetStateAction<readonly Channel[]>>;
  readonly setChannelEditForm: Dispatch<SetStateAction<ChannelFormState>>;
  readonly updateChannel: (cwd: string, channelId: string, channel: ChannelFormState) => Promise<unknown>;
  readonly refreshChannels: (cwd?: string) => Promise<void>;
  readonly getWorkspaceDefaultProviderPresetId: () => string;
  readonly clearWorkspaceDefaultProvider: () => Promise<void>;
}): ProviderUsageController {
  async function clearProviderUsage(providerId: string): Promise<void> {
    const workspaceCwd = input.form.cwd.trim();
    if (input.taskRunProviderId === providerId) {
      input.setTaskRunProviderId("");
    }
    if (input.form.providerPresetId === providerId) {
      input.setForm((current) => ({ ...current, providerPresetId: "" }));
    }
    if (input.getWorkspaceDefaultProviderPresetId() === providerId) {
      await input.clearWorkspaceDefaultProvider();
    }

    const channelsUsingProvider = input.channels.filter((channel) => channel.defaultProviderPresetId === providerId);
    if (!workspaceCwd || channelsUsingProvider.length === 0) {
      return;
    }

    input.setChannels((current) =>
      current.map((channel) =>
        channel.defaultProviderPresetId === providerId ? { ...channel, defaultProviderPresetId: undefined } : channel,
      ),
    );
    input.setChannelEditForm((current) =>
      current.defaultProviderPresetId === providerId ? { ...current, defaultProviderPresetId: "" } : current,
    );
    await Promise.all(
      channelsUsingProvider.map((channel) =>
        input.updateChannel(workspaceCwd, channel.id, {
          ...channelToForm(channel, workspaceCwd),
          defaultProviderPresetId: "",
        }),
      ),
    );
    await input.refreshChannels(workspaceCwd);
  }

  return { clearProviderUsage };
}
