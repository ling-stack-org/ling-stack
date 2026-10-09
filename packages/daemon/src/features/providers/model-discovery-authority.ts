import type { ProviderPreset, ProviderStoreFacet } from "@ling-stack/core";
import { HttpError } from "../../errors.js";

export interface ProviderModelDiscoveryAuthority {
  readonly savedPreset?: ProviderPreset;
  readonly assertCurrent: () => void;
}

/** Discovery is read-only and must not supersede health-check publication. */
export function captureProviderModelDiscoveryAuthority(
  store: ProviderStoreFacet,
  providerPresetId: string | undefined,
): ProviderModelDiscoveryAuthority {
  if (!providerPresetId) return { assertCurrent() {} };
  const snapshot = store.getProviderConfigurationSnapshot(providerPresetId);
  if (!snapshot) {
    throw new HttpError(404, "provider_not_found", `Provider preset not found: ${providerPresetId}`);
  }
  return {
    savedPreset: snapshot.provider,
    assertCurrent() {
      const current = store.getProviderConfigurationSnapshot(providerPresetId);
      if (!current || current.configRevision !== snapshot.configRevision) {
        throw new HttpError(409, "provider_model_connection_changed",
          "The provider connection changed while fetching models. Fetch models again for the current connection.");
      }
    },
  };
}
