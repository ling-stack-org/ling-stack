import type { Channel, ChannelUpdateInput, RunStore, SecretResolver } from "@ling-stack/core";
import { assertRunnableConversationProvider } from "../providers/conversation-model-validation.js";

export function validateChannelModelUpdate(input: {
  readonly store: RunStore;
  readonly cwd: string;
  readonly channel: Channel;
  readonly update: ChannelUpdateInput;
  readonly secretResolver: SecretResolver;
}): void {
  const nextStatus = input.update.status ?? input.channel.status;
  const modelChanged = input.update.defaultProviderPresetId !== undefined;
  const activating = input.channel.status !== "active" && nextStatus === "active";
  if (!modelChanged && !activating) {
    return;
  }

  const providerPresetId = input.update.defaultProviderPresetId === null
    ? undefined
    : input.update.defaultProviderPresetId ?? input.channel.defaultProviderPresetId;
  if (nextStatus === "archived" && !providerPresetId) {
    return;
  }

  assertRunnableConversationProvider({
    store: input.store,
    cwd: input.cwd,
    providerPresetId,
    secretResolver: input.secretResolver,
    ownerLabel: "Channel Ling Agent",
  });
}
