import type { ProviderPreset, ProviderPresetUpdateInput } from "@ling-stack/core";

export type ProviderReferenceGuardAction = "disable" | "remove_chat" | "remove_secret";

export function providerReferenceGuardAction(
  existing: ProviderPreset,
  update: ProviderPresetUpdateInput,
): ProviderReferenceGuardAction | undefined {
  const nextEnabled = update.enabled ?? existing.enabled;
  if (existing.enabled && !nextEnabled) {
    return "disable";
  }

  const nextApi = update.api ?? existing.api;
  const nextCapabilities = update.capabilities ?? existing.capabilities;
  const currentlySupportsChat = existing.api !== "media-job" && existing.capabilities.includes("chat");
  const nextSupportsChat = nextApi !== "media-job" && nextCapabilities.includes("chat");
  if (currentlySupportsChat && !nextSupportsChat) {
    return "remove_chat";
  }

  if (existing.apiKeyRef && update.apiKeyRef === null) {
    return "remove_secret";
  }
  return undefined;
}
