import { providerCompactModelLabel } from "../../lib/providers.js";
import type { ProviderPreset } from "../../types.js";

export function channelLingAgentModelLabel(
  providerPresetId: string,
  providers: readonly ProviderPreset[],
): string {
  const provider = providers.find((item) => item.id === providerPresetId);
  return provider ? providerCompactModelLabel(provider) : "";
}
